import { describe, expect, it } from 'vitest'

import type { AuthEvent, SimContext, SimState } from '@tapkart/sim'
import {
  MAX_KARTS,
  allocStateLike,
  cloneState,
  createState,
  itemBoxWorldPos,
  makeIntentBuffer,
  promotionCursor,
  statesEqual,
  step,
} from '@tapkart/sim'
import type { ChannelName } from '@tapkart/protocol'
import { INPUT_REDUNDANCY } from '@tapkart/protocol'
import {
  PROTOCOL_VERSION,
  WIRE_TAG,
  decodeEvents,
  decodeHeader,
  encodeCheckpoint,
  encodeEvents,
  encodeHeader,
  encodeInput,
  encodeSnapshot,
} from '@tapkart/protocol'
import type { Transport } from '../src/transport'
import { AuthorityLoop } from '../src/authority'
import { applyEvent } from '../src/apply'
import {
  AUTHORITY_CHANGE_BYTES,
  HOST_TIMEOUT_MS,
  SHADOW_HISTORY_TICKS,
  SNAPSHOT_PERIOD_TICKS,
  ShadowLoop,
  decodeAuthorityChange,
  encodeAuthorityChange,
  promotionTickOf,
} from '../src/shadow'
import { MAX_CATCHUP_TICKS, TICK_MS, advanceAccumulator, makeTickAccumulator } from '../src/clock'
import { droppedDatagramsOf } from '../src/receive'
import { makeLossyPair, makeNetContext } from './fixtures/net-fixtures'


/**
 * ShadowLoop.tick takes the scheduler's wall clock as of Task 15c item C, so
 * every call site here drives one through a driver that advances it by exactly
 * one 60Hz tick per call - which is what a healthy scheduler does, and therefore
 * preserves the meaning every test in this file had when tick() took no
 * argument.
 *
 * `stall(ms)` is the case the tick counter could not see: wall time passing with
 * NO tick running.
 */
function driverFor(shadow: ShadowLoop, startMs = 0): {
  tick(n?: number): void
  stall(deltaMs: number): void
  nowMs(): number
} {
  let ms = startMs
  return {
    tick(n = 1): void {
      for (let i = 0; i < n; i++) {
        shadow.tick(ms)
        ms += TICK_MS
      }
    },
    stall(deltaMs: number): void {
      ms += deltaMs
    },
    nowMs(): number {
      return ms
    },
  }
}

/**
 * The 1.5s timeout expressed in ticks, for the tests below that count them.
 * DERIVED from the milliseconds the loop actually uses (Task 15c item C), never
 * the other way round: the two agree only while the scheduler is healthy, and a
 * test that hardcoded 90 would go on passing after the loop stopped promoting at
 * 1.5s of wall time.
 */
const HOST_TIMEOUT_TICKS = Math.ceil(HOST_TIMEOUT_MS / TICK_MS)

describe('shadow constants', () => {
  it('pins the promotion timeout to 1.5s of WALL TIME, not to a tick count', () => {
    expect(HOST_TIMEOUT_MS).toBe(1500) // spec §5: 1.5s with no snapshot (30 missed at 20Hz)
    // At a healthy 60Hz that is the 90 ticks this file used to count.
    expect(HOST_TIMEOUT_TICKS).toBe(90)
  })

  it('pins the snapshot broadcast period to 20Hz', () => {
    expect(SNAPSHOT_PERIOD_TICKS).toBe(3) // 60 / 20
  })

  it('sizes the history ring at 2x the 200ms worst-case one-way transit', () => {
    expect(SHADOW_HISTORY_TICKS).toBe(24) // 400ms @ 60Hz, vs. 150ms latency + 50ms jitter = 200ms = 12 ticks
  })
})

describe('authorityChange codec', () => {
  it('round-trips tick and eventSeq through exactly 10 bytes', () => {
    const buf = new Uint8Array(AUTHORITY_CHANGE_BYTES)
    const n = encodeAuthorityChange(buf, 123456, 789)
    expect(n).toBe(10)
    const decoded = decodeAuthorityChange(buf)
    expect(decoded).toEqual({ tick: 123456, eventSeq: 789 })
  })

  it("prefixes the contract's shared header, so a receiver can dispatch on it", () => {
    const buf = new Uint8Array(AUTHORITY_CHANGE_BYTES)
    encodeAuthorityChange(buf, 7, 8)
    // Not "buf[0] === some number this file made up": the byte must be the
    // one every other loop dispatches on. decodeHeader throws on an unknown
    // tag, so a hand-rolled prefix fails here rather than three tasks later.
    expect(buf[0]).toBe(WIRE_TAG.authorityChange)
    expect(decodeHeader(buf)).toEqual({ kind: 'authorityChange', protocolVersion: PROTOCOL_VERSION })
    // 2-byte header + two u32s. The payload starts where the header ends.
    expect(AUTHORITY_CHANGE_BYTES).toBe(2 + 4 + 4)
  })

  it('writes both u32s little-endian, in the declared field order', () => {
    // A round-trip through this file's own encoder and decoder cannot see a
    // byte-order bug at all: a big-endian writer paired with a big-endian
    // reader round-trips perfectly. So the bytes themselves are pinned, and
    // both values are chosen so neither is a byte-palindrome and the two
    // cannot be confused for each other -- 123456 = 0x0001E240 and
    // 789 = 0x00000315. A swapped field order, or a big-endian write, or a
    // payload that starts at the wrong offset, each fails here by name.
    const buf = new Uint8Array(AUTHORITY_CHANGE_BYTES)
    encodeAuthorityChange(buf, 123456, 789)
    expect(Array.from(buf.subarray(2))).toEqual([0x40, 0xe2, 0x01, 0x00, 0x15, 0x03, 0x00, 0x00])
  })

  it('decodes a view that does not start at byte 0 of its ArrayBuffer', () => {
    // Datagrams reach a decoder as subarrays (every receive path in this
    // package hands `data.subarray(HEADER_BYTES)` onward, and a transport may
    // hand up a view into a larger pool). `new DataView(buf.buffer)` without
    // buf.byteOffset reads the wrong 8 bytes and is the classic form of this
    // bug; it survives every test whose buffer happens to start at offset 0.
    const backing = new Uint8Array(64).fill(0xaa)
    const view = backing.subarray(7, 7 + AUTHORITY_CHANGE_BYTES)
    encodeAuthorityChange(view, 4242, 99)
    expect(view.byteOffset).toBe(7)
    expect(decodeAuthorityChange(view)).toEqual({ tick: 4242, eventSeq: 99 })
    // ...and it wrote only inside its own window.
    expect(backing[6]).toBe(0xaa)
    expect(backing[7 + AUTHORITY_CHANGE_BYTES]).toBe(0xaa)
  })

  it('round-trips the largest tick and eventSeq a u32 can hold', () => {
    const buf = new Uint8Array(AUTHORITY_CHANGE_BYTES)
    encodeAuthorityChange(buf, 0xffffffff, 0xfffffffe)
    expect(decodeAuthorityChange(buf)).toEqual({ tick: 0xffffffff, eventSeq: 0xfffffffe })
  })

  it('refuses a destination buffer shorter than AUTHORITY_CHANGE_BYTES', () => {
    expect(() => encodeAuthorityChange(new Uint8Array(9), 0, 0)).toThrow(
      'encodeAuthorityChange: out is 9 bytes, need 10',
    )
  })
})

/**
 * Worst-case snapshot is 744 B — contract §4, recomputed from bits rather
 * than copied from a rounded figure: 8 karts x 178 + 32 entities x 135 + 202
 * header = 5946 bits. (The header is 202 and not the 200 this comment used to
 * cite because Task 15c item A put a 2-bit `phase` in it.) 1024 covers that plus
 * the 2-byte header with room to spare, and matters because BitWriter overflows
 * SILENTLY (a typed-array write past the end is a no-op), so an undersized
 * buffer truncates rather than throws.
 */
const SNAP_BUF_BYTES = 1024

/** encodeCheckpoint writes a few KB for this SimState shape; 8192 leaves
 * headroom. DataView.setFloat64 past the end throws RangeError, so this one
 * fails loudly rather than silently. */
const CHECKPOINT_BUF_BYTES = 8192

const CHARS = [0, 1, 2, 3, 4, 5, 6, 7]

/** A Transport that delivers nothing and records nothing: no host, no clients. */
function deafTransport(): Transport {
  return { send() {}, broadcast() {}, onMessage() {}, onPeerLost() {}, peers: () => [], close() {} }
}

interface Capture {
  transport: Transport
  broadcasts: { channel: ChannelName; data: Uint8Array }[]
  /** Feeds one datagram into whatever ShadowLoop registered, as the transport would. */
  deliver(peerId: string, channel: ChannelName, data: Uint8Array): void
}

/**
 * A Transport that records every broadcast and lets the test play the part of
 * the network. `channel` is typed as ChannelName, not string: Transport's
 * callback is contextually typed and under strictFunctionTypes a holder
 * declared with `channel: string` is not assignable (TS2322).
 */
function captureTransport(): Capture {
  const broadcasts: { channel: ChannelName; data: Uint8Array }[] = []
  let cb: (peerId: string, channel: ChannelName, data: Uint8Array) => void = () => {}
  return {
    broadcasts,
    deliver: (peerId, channel, data) => cb(peerId, channel, data),
    transport: {
      send() {},
      broadcast: (channel, data) => {
        broadcasts.push({ channel, data })
      },
      onMessage: (fn) => {
        cb = fn
      },
      onPeerLost() {},
      peers: () => [],
      close() {},
    },
  }
}

/** Every message a test injects goes through here, so the header lives in one
 * place and a test can never accidentally hand-assemble a prefix the loops
 * under test do not agree with. */
function framed(
  kind: 'input' | 'snapshot' | 'events' | 'checkpoint',
  size: number,
  writePayload: (payload: Uint8Array) => number,
): Uint8Array {
  const buf = new Uint8Array(size)
  const h = encodeHeader(buf, kind)
  const n = writePayload(buf.subarray(h))
  return buf.subarray(0, h + n)
}

/**
 * Puts a live entity in the pool by writing the slot directly, rather than through
 * spawnEntity(), for two reasons: spawnEntity emits an 'entitySpawn' (gated on
 * ctx.isLeader, so a leader-seeded state and a follower-seeded state would end up
 * with DIFFERENT nextEventSeq), and it picks the entityId itself.
 * A 'slick' sits still and only its ttl moves (entity.ts's stepEntity default
 * branch), and at (500, 0, 500) it is hundreds of metres outside the oval track's
 * own bounds (x in [-320, 320], z in [-120, 120]), so its 2.1 m strike radius can
 * never fire. With a ttl far longer than the run it therefore has exactly one legal
 * way to leave the pool: not at all.
 */
function seedSlick(state: SimState, entityId: number, ttl: number): void {
  const e = state.entities[state.entityCount]
  e.entityId = entityId
  e.kind = 'slick'
  e.ownerId = 0
  e.position.x = 500
  e.position.y = 0
  e.position.z = 500
  e.velocity.x = 0
  e.velocity.y = 0
  e.velocity.z = 0
  e.heading = 0
  e.targetId = -1
  e.ttl = ttl
  state.entityCount += 1
  state.nextEntityId = Math.max(state.nextEntityId, entityId + 1)
}

describe('ShadowLoop: follower mode', () => {
  it('advances state.tick by exactly one per tick() call, starting from tick 0', () => {
    const ctx = makeNetContext(false)
    const state = createState(ctx, 0xabc, CHARS)
    const shadow = new ShadowLoop(ctx, state, deafTransport())
    const drive = driverFor(shadow)
    expect(state.tick).toBe(0)
    for (let i = 1; i <= 30; i++) {
      drive.tick()
      expect(state.tick).toBe(i)
    }
  })

  it('never rolls items and never emits while ctx.isLeader is false, across 900 ticks', () => {
    // 900 ticks, not 300, and with a leader control loop running the identical
    // 900 ticks alongside. On this fixture a LEADER's first item roll does not
    // land until tick 837 and its first emit until tick 227, so a 300-tick
    // version of this test asserts `rngCursor === 0` against a window in which
    // a correct leader also reports 0 — it would pass with every isLeader gate
    // in the sim deleted. The control loop is what makes both halves of the
    // assertion mean something, and it fails loudly if a future change to the
    // fixture or the tuning moves those first events past tick 900.
    //
    // Both figures are PINNED below rather than merely stated. A comment that
    // asserts a measurement with nothing checking it is how this project ended
    // up with three separate comments claiming a protection that did not exist;
    // 227 and 837 are the two numbers this test's whole shape is justified by,
    // so they are assertions. (227 is this fixture's, seed 0xabc from a standing
    // countdown start. The 58 that promotion.test.ts cites is a different
    // fixture with a different seed and a racing start - the two are not in
    // conflict and neither is wrong.)
    //
    // The host must also stay ALIVE for the whole window, which is why the
    // control loop's snapshots are fed in at 20Hz rather than the loop being
    // run against a transport that delivers nothing: with no snapshots this
    // loop promotes itself at tick 90 by design, becomes the leader, and then
    // legitimately rolls and emits. A 300-tick deaf-transport version of this
    // test fails at tick 90 for exactly that reason.
    const followerCtx = makeNetContext(false)
    const state = createState(followerCtx, 0xabc, CHARS)
    const cap = captureTransport()
    const shadow = new ShadowLoop(followerCtx, state, cap.transport)
    const drive = driverFor(shadow)

    const leaderCtx = makeNetContext(true)
    let a = createState(leaderCtx, 0xabc, CHARS)
    let b = allocStateLike(leaderCtx, a)
    const leaderInputs = makeIntentBuffer()
    const leaderEvents: AuthEvent[] = []
    const noInputYet = new Array(MAX_KARTS).fill(-1)
    let leaderEmitted = 0

    let firstEmitTick = -1
    let firstRollTick = -1

    const TICKS = 900
    for (let i = 0; i < TICKS; i++) {
      leaderEvents.length = 0
      step(leaderCtx, a, b, leaderInputs, leaderEvents)
      const t = a
      a = b
      b = t
      leaderEmitted += leaderEvents.length
      if (leaderEvents.length > 0 && firstEmitTick < 0) firstEmitTick = a.tick
      if (a.rngCursor > 0 && firstRollTick < 0) firstRollTick = a.tick
      // 20Hz, the host's real cadence. Events are deliberately NOT forwarded:
      // this loop's nextEventSeq must stay at 0 because it emitted nothing and
      // applied nothing, and a snapshot carries no events.
      if (a.tick % SNAPSHOT_PERIOD_TICKS === 0) {
        cap.deliver('host', 'unreliable', framed('snapshot', SNAP_BUF_BYTES, (p) => encodeSnapshot(p, a, noInputYet)))
      }

      drive.tick()
      expect(state.rngCursor, `rngCursor moved on tick ${i}`).toBe(0)
      expect(state.nextEventSeq, `nextEventSeq moved on tick ${i}`).toBe(0)
    }
    // Still a follower: the host never stopped talking.
    expect(followerCtx.isLeader).toBe(false)
    expect(cap.broadcasts, 'a follower broadcast something').toHaveLength(0)

    // The control: over the very same window, on the very same seed, a leader
    // both emitted and rolled. Without these two lines the assertions above
    // are satisfied by a simulation in which nothing happens at all.
    expect(leaderEmitted, 'control leader emitted nothing: the test above proves nothing').toBeGreaterThan(0)
    expect(a.rngCursor, 'control leader never rolled an item: the rngCursor assertion above is vacuous').toBeGreaterThan(0)
    expect(a.nextEventSeq).toBe(leaderEmitted)
    // The two numbers this test's 900-tick window is justified by. If a tuning
    // change moves either one, update the comment above with the new figure -
    // and re-check that 900 is still long enough for both.
    expect(firstEmitTick, "the comment above says a leader's first emit lands on tick 227").toBe(227)
    expect(firstRollTick, "the comment above says a leader's first item roll lands on tick 837").toBe(837)
    expect(firstRollTick, 'a 300-tick window would no longer be vacuous; the comment above is stale').toBeGreaterThan(300)
  })

  it('applies an incoming event exactly once, even if the same bytes are delivered twice', () => {
    const ctx = makeNetContext(false)
    const state = createState(ctx, 0xabc, CHARS)
    const cap = captureTransport()
    const shadow = new ShadowLoop(ctx, state, cap.transport)
    const drive = driverFor(shadow)

    const ev: AuthEvent = { eventSeq: 0, tick: 0, kind: 'itemGrant', playerId: 3, entityId: -1, item: 'boost', data: 0 }
    const msg = framed('events', 256, (payload) => encodeEvents(payload, [ev]))

    cap.deliver('host', 'reliable', msg)
    cap.deliver('host', 'reliable', msg) // redelivered — reliable channels can still repeat a send
    drive.tick()

    expect(state.karts[3].item).toBe('boost')
    expect(state.nextEventSeq).toBe(1) // applied once, not twice
    // ev.data is the boxIdx, so applying the grant also armed that box — the
    // half a bare `k.item = ev.item` would miss (Task 13). The value read here
    // is one less than the tuning constant because events are applied at the
    // TOP of tick(), and the step() that follows in the same call runs
    // updateItemBoxes, which decrements every armed box exactly once. An
    // unarmed box reads 0 here, so this still fails if the grant was ignored.
    expect(state.itemBoxes[0].respawnTicks).toBe(ctx.tuning.itemBoxRespawnTicks - 1)
  })

  it('takes a client input datagram off the wire and drives that seat with it', () => {
    const ctx = makeNetContext(false)
    const state = createState(ctx, 0xabc, [0, 0, 0, 0, 0, 0, 0, 0])
    state.phase = 'racing'
    state.karts[2].isBot = false
    state.karts[2].connected = true
    const cap = captureTransport()
    const shadow = new ShadowLoop(ctx, state, cap.transport)
    const drive = driverFor(shadow)

    const startX = state.karts[2].position.x
    const startZ = state.karts[2].position.z
    const intents = Array.from({ length: 8 }, (_, i) => ({
      tick: i * 2, steer: 0.2, accel: 1, brake: false, drift: false, useItem: false,
    }))
    cap.deliver('client-2', 'unreliable', framed('input', 256, (p) => encodeInput(p, 2, intents)))

    // 30 ticks on one held datagram: spec §5's "repeating the last known intent
    // across gaps", and the reason this loop must survive many consecutive
    // tick() calls with no new input rather than only the first one.
    drive.tick(30)

    const moved = Math.hypot(state.karts[2].position.x - startX, state.karts[2].position.z - startZ)
    expect(moved).toBeGreaterThan(1)
    // Seat 2 only. Nothing else was told to accelerate, and a decodeInput
    // handed a too-short intents array would have thrown before any of this.
    expect(state.karts[2].item).toBe('none')
  })

  it('keeps holding the newest intent, and ignores a datagram older than the one it holds', () => {
    // The held-input path is stateful across ticks and across datagrams, which
    // is exactly the shape of bug Plan 1 shipped once already (correct on the
    // first call, wrong from the second). Three phases, 90 ticks total.
    const ctx = makeNetContext(false)
    const state = createState(ctx, 0xabc, [0, 0, 0, 0, 0, 0, 0, 0])
    state.phase = 'racing'
    state.karts[2].isBot = false
    state.karts[2].connected = true
    const cap = captureTransport()
    const shadow = new ShadowLoop(ctx, state, cap.transport)
    const drive = driverFor(shadow)

    const window = (baseTick: number, accel: number) =>
      Array.from({ length: 8 }, (_, i) => ({
        tick: baseTick + i * 2, steer: 0, accel, brake: false, drift: false, useItem: false,
      }))

    // Phase 1: accelerate for 30 ticks.
    cap.deliver('c2', 'unreliable', framed('input', 256, (p) => encodeInput(p, 2, window(0, 1))))
    drive.tick(30)
    const speedAfterAccel = Math.hypot(state.karts[2].velocity.x, state.karts[2].velocity.z)
    expect(speedAfterAccel).toBeGreaterThan(5)

    // Phase 2: a NEWER datagram says coast. 30 more ticks must slow the kart.
    cap.deliver('c2', 'unreliable', framed('input', 256, (p) => encodeInput(p, 2, window(60, 0))))
    drive.tick(30)
    const speedAfterCoast = Math.hypot(state.karts[2].velocity.x, state.karts[2].velocity.z)
    expect(speedAfterCoast).toBeLessThan(speedAfterAccel)

    // Phase 3: a STALE datagram (older ticks, accel 1) arrives late and must be
    // ignored — reordered unreliable delivery is the normal case, not an edge
    // one. A loop that overwrote its hold with whatever arrived last would
    // start accelerating again here.
    cap.deliver('c2', 'unreliable', framed('input', 256, (p) => encodeInput(p, 2, window(2, 1))))
    drive.tick(30)
    const speedAfterStale = Math.hypot(state.karts[2].velocity.x, state.karts[2].velocity.z)
    expect(speedAfterStale).toBeLessThan(speedAfterCoast)
  })
})

describe('ShadowLoop: snapshot correction', () => {
  it('leaves a moving race bit-identical when the snapshot matches within tolerance', () => {
    // The brief's version of this test compared one kart's x before and after
    // against the 0.05m epsilon, on a state whose karts were standing still on
    // the grid — an assertion a spurious correction also passes, because
    // snapping a stationary kart to its own quantized position moves it by
    // ~0.016m. So: the race is RACING (karts under bot control, moving), and
    // the comparison is against a CONTROL ShadowLoop that receives no snapshot
    // at all, through statesEqual — bit-exact, every field, every kart, every
    // entity. Quantization noise is bounded by contract §4 to be strictly under
    // every epsilon, so a correct loop must not fire; a loop that fires anyway
    // replaces exact doubles with dequantized ones and the two timelines
    // separate on the very next tick and never rejoin.
    const ctx = makeNetContext(false)
    const state = createState(ctx, 0x111, CHARS)
    state.phase = 'racing'
    const cap = captureTransport()
    const shadow = new ShadowLoop(ctx, state, cap.transport)
    const drive = driverFor(shadow)

    const controlCtx = makeNetContext(false)
    const controlState = createState(controlCtx, 0x111, CHARS)
    controlState.phase = 'racing'
    const control = new ShadowLoop(controlCtx, controlState, deafTransport())
    const driveControl = driverFor(control)

    for (let i = 0; i < 30; i++) {
      drive.tick()
      driveControl.tick()
    }
    expect(statesEqual(state, controlState), 'the two loops diverged before any snapshot').toBe(true)
    const speed = Math.hypot(state.karts[0].velocity.x, state.karts[0].velocity.z)
    expect(speed, 'the race is not actually in motion; this test would prove nothing').toBeGreaterThan(5)

    // Perfect truth, quantized and dequantized: within every epsilon.
    cap.deliver('host', 'unreliable',
      framed('snapshot', SNAP_BUF_BYTES, (p) => encodeSnapshot(p, state, new Array(MAX_KARTS).fill(-1))))

    for (let i = 0; i < 20; i++) {
      drive.tick()
      driveControl.tick()
      expect(statesEqual(state, controlState), `a correction fired: states differ ${i + 1} ticks later`).toBe(true)
    }
  })

  it('snaps every kart and every live entity onto the snapshot when a field exceeds its epsilon', () => {
    const ctx = makeNetContext(false)
    const state = createState(ctx, 0x222, CHARS)
    const cap = captureTransport()
    const shadow = new ShadowLoop(ctx, state, cap.transport)
    const drive = driverFor(shadow)
    drive.tick(5) // buffers ticks 1..5 in the ring

    const SPOOF_TTL = 400
    const spoofed = createState(ctx, 0x222, CHARS)
    spoofed.tick = 3 // a tick still inside the 24-deep ring
    spoofed.karts[0].position.x += 5 // 5m: nowhere near the 0.05m epsilon
    seedSlick(spoofed, 777, SPOOF_TTL) // and an entity this loop has never seen
    const before = state.karts[0].position.x
    expect(state.entityCount).toBe(0)

    cap.deliver('host', 'unreliable',
      framed('snapshot', SNAP_BUF_BYTES, (p) => encodeSnapshot(p, spoofed, new Array(MAX_KARTS).fill(-1))))
    drive.tick() // reconciles at the top of this call, then steps tick 5 -> 6

    // After reconcile-and-replay the live kart 0 must have moved onto the
    // corrected value: not bit-identical (three more ticks of motion ran after
    // the correction), but the 5m jump must be visible, not silently absorbed.
    expect(Math.abs(state.karts[0].position.x - spoofed.karts[0].position.x)).toBeLessThan(0.5)
    // And it really moved: without this, "less than 0.5 from the spoofed value"
    // could in principle be satisfied by a state that never changed at all.
    expect(Math.abs(state.karts[0].position.x - before)).toBeGreaterThan(1)

    // The entity half of "every kart AND every live entity". Its ttl pins the
    // replay length exactly: the correction lands at tick 3 and three more
    // steps run (4, 5, and this call's 5 -> 6), each decrementing ttl by one.
    expect(state.entityCount).toBe(1)
    expect(state.entities[0].entityId).toBe(777)
    expect(state.entities[0].ttl).toBe(SPOOF_TTL - 3)
    expect(state.tick).toBe(6)
  })

  it('ignores a snapshot older than the newest one it has already reconciled', () => {
    // Unreliable delivery reorders under jitter (LoopbackTransport draws a
    // per-datagram jitter offset, so two snapshots 50ms apart can swap), and a
    // stale snapshot re-applied after a newer one throws the newer correction
    // away: reconcile rewinds to the older tick and replays forward from it,
    // and the replay carries no knowledge of the correction it just discarded.
    const ctx = makeNetContext(false)
    const state = createState(ctx, 0x223, CHARS)
    const cap = captureTransport()
    const shadow = new ShadowLoop(ctx, state, cap.transport)
    const drive = driverFor(shadow)
    drive.tick(20)
    const grid = state.karts[0].position.x

    const newer = createState(ctx, 0x223, CHARS)
    newer.tick = 18
    newer.karts[0].position.x = grid + 5
    cap.deliver('host', 'unreliable',
      framed('snapshot', SNAP_BUF_BYTES, (p) => encodeSnapshot(p, newer, new Array(MAX_KARTS).fill(-1))))
    drive.tick()
    expect(state.karts[0].position.x - grid).toBeGreaterThan(4.5) // the newer truth landed

    // Now the same host's OLDER snapshot turns up late, disagreeing by 5m the
    // other way. It is in the ring, it is divergent, and a loop without an
    // ordering guard would rewind to it and lose everything above.
    const older = createState(ctx, 0x223, CHARS)
    older.tick = 15
    older.karts[0].position.x = grid - 5
    cap.deliver('host', 'unreliable',
      framed('snapshot', SNAP_BUF_BYTES, (p) => encodeSnapshot(p, older, new Array(MAX_KARTS).fill(-1))))
    drive.tick()

    expect(state.karts[0].position.x - grid, 'a stale snapshot overwrote a newer correction').toBeGreaterThan(4.5)
    expect(state.tick).toBe(22)
  })

  it('reconciles against the snapshot it accepted, not one it rejected in the same window', () => {
    // The test above delivers its two snapshots in SEPARATE inter-tick windows,
    // so the ordering guard is exercised only across a tick() boundary - and a
    // guard whose test cannot detect the guard failing is not a test. Here both
    // arrive between the same two tick() calls, which is the ordinary case at a
    // 3-tick broadcast cadence with 50ms of jitter.
    //
    // The failure it catches: onMessage decodes into a scratch buffer FIRST and
    // tests `tick > lastSnapshotTick` second, while `pendingSnapshot` is a
    // reference to that same scratch. The guard then rejects the stale frame
    // correctly and reconciles against it anyway, because rejecting it means
    // "do not re-point pendingSnapshot" and pendingSnapshot was already pointing
    // at the object the stale decode just overwrote.
    const ctx = makeNetContext(false)
    const state = createState(ctx, 0x224, CHARS)
    const cap = captureTransport()
    const shadow = new ShadowLoop(ctx, state, cap.transport)
    const drive = driverFor(shadow)
    drive.tick(20)
    const grid = state.karts[0].position.x

    // Establish a reconciled floor at tick 18, so the stale frame below is
    // genuinely rejectable rather than merely older than an unset cursor.
    const floor = createState(ctx, 0x224, CHARS)
    floor.tick = 18
    floor.karts[0].position.x = grid + 1
    cap.deliver('host', 'unreliable',
      framed('snapshot', SNAP_BUF_BYTES, (p) => encodeSnapshot(p, floor, new Array(MAX_KARTS).fill(-1))))
    drive.tick()
    expect(state.karts[0].position.x - grid).toBeGreaterThan(0.5)

    const newer = createState(ctx, 0x224, CHARS)
    newer.tick = 20
    newer.karts[0].position.x = grid + 5
    const stale = createState(ctx, 0x224, CHARS)
    stale.tick = 15
    stale.karts[0].position.x = grid - 5

    // Both between the same two ticks, newest first - the order jitter produces
    // when a 50ms-older datagram draws a larger delay than its successor.
    cap.deliver('host', 'unreliable',
      framed('snapshot', SNAP_BUF_BYTES, (p) => encodeSnapshot(p, newer, new Array(MAX_KARTS).fill(-1))))
    cap.deliver('host', 'unreliable',
      framed('snapshot', SNAP_BUF_BYTES, (p) => encodeSnapshot(p, stale, new Array(MAX_KARTS).fill(-1))))
    drive.tick()

    expect(
      state.karts[0].position.x - grid,
      'the loop steered by the snapshot its own guard rejected',
    ).toBeGreaterThan(4.5)
  })

  it('a full-precision checkpoint replaces the whole state and outranks a pending snapshot', () => {
    const ctx = makeNetContext(false)
    const state = createState(ctx, 0x333, CHARS)
    const cap = captureTransport()
    const shadow = new ShadowLoop(ctx, state, cap.transport)
    const drive = driverFor(shadow)
    drive.tick(5)
    expect(state.tick).toBe(5)

    // What a host sends a shadow that has been partitioned away for a while:
    // a state far outside anything the 24-tick history ring could match.
    const resync = createState(ctx, 0x333, CHARS)
    resync.tick = 500
    resync.karts[0].position.x += 40
    resync.karts[4].lap.lap = 2
    cap.deliver('host', 'reliable',
      framed('checkpoint', CHECKPOINT_BUF_BYTES, (p) => encodeCheckpoint(p, resync)))

    drive.tick()

    // Applied at the top of the next tick(), then one step ran: tick 501, and
    // the kart is where the checkpoint said (plus one tick of motion).
    // Ignoring the message entirely leaves tick at 6 and the kart on the grid.
    expect(state.tick).toBe(501)
    expect(Math.abs(state.karts[0].position.x - resync.karts[0].position.x)).toBeLessThan(0.5)
    expect(state.karts[4].lap.lap).toBe(2)
  })

  it('keeps following correctly for 200 ticks after a checkpoint resync', () => {
    // A checkpoint invalidates the whole history ring. If it left one stale
    // entry behind, the next snapshot whose tick collided with that slot would
    // reconcile against a state from the pre-resync timeline. 200 ticks with a
    // live host is enough for the ring to be refilled eight times over.
    const ctx = makeNetContext(false)
    const state = createState(ctx, 0x334, CHARS)
    const cap = captureTransport()
    const shadow = new ShadowLoop(ctx, state, cap.transport)
    const drive = driverFor(shadow)
    drive.tick(5)

    const hostCtx = makeNetContext(false) // a reference timeline, not an emitter
    let a = createState(hostCtx, 0x334, CHARS)
    let b = allocStateLike(hostCtx, a)
    a.tick = 500
    a.phase = 'racing'
    for (const k of a.karts) k.lap.lap = 1
    const hostInputs = makeIntentBuffer()
    const noInputYet = new Array(MAX_KARTS).fill(-1)

    cap.deliver('host', 'reliable', framed('checkpoint', CHECKPOINT_BUF_BYTES, (p) => encodeCheckpoint(p, a)))

    // A snapshot for tick T reaches the shadow at tick T + 9 (150ms @ 60Hz),
    // so every correction addresses a tick the ring has already buffered and
    // the rewind-and-replay path is what runs, 200 ticks in a row. Delivering
    // with no delay at all would instead hand the shadow snapshots from its own
    // FUTURE and exercise only the hard-snap branch.
    const LATENCY_TICKS = 9
    const wire: { at: number; data: Uint8Array }[] = []
    let replays = 0

    for (let i = 0; i < 200; i++) {
      const nowT = 500 + i
      for (let w = wire.length - 1; w >= 0; w--) {
        if (wire[w].at > nowT) continue
        cap.deliver('host', 'unreliable', wire[w].data)
        wire.splice(w, 1)
        replays++
      }
      step(hostCtx, a, b, hostInputs, [])
      const t = a
      a = b
      b = t
      if (a.tick % SNAPSHOT_PERIOD_TICKS === 0) {
        wire.push({
          at: a.tick + LATENCY_TICKS,
          data: framed('snapshot', SNAP_BUF_BYTES, (p) => encodeSnapshot(p, a, noInputYet)),
        })
      }
      drive.tick()
      expect(state.tick, `tick drifted ${i} ticks after resync`).toBe(a.tick)
    }
    expect(replays, 'no snapshot was ever delivered; the loop above proves nothing').toBeGreaterThan(50)
    // Same inputs, same seed, corrected by the same snapshots: the follower
    // tracks the reference exactly, not just approximately.
    expect(state.karts[0].position.x).toBeCloseTo(a.karts[0].position.x, 6)
    expect(state.karts.map((k) => k.lap.lap)).toEqual(a.karts.map((k) => k.lap.lap))
    expect(ctx.isLeader, 'promoted despite a live host').toBe(false)
  })
})

describe('ShadowLoop: two snapshots in one window (Task 15c, review finding 2)', () => {
  it('keeps the NEWER of two frames that both outrank the last reconciled one', () => {
    // Review finding 2. onDatagram accepts a decoded snapshot only if it is
    // newer than what has been reconciled AND newer than what is already queued.
    // The second clause had no test: deleting it left all 216 net+protocol tests
    // passing, because the one test that looked like it covered this
    // deliberately raised `lastSnapshotTick` first, so the stale frame was
    // rejected by the OLD guard and the new clause never ran.
    //
    // Here BOTH frames outrank `lastSnapshotTick` (which is still -1: this loop
    // has reconciled nothing), so only the pending-tick comparison can tell them
    // apart.
    const ctx = makeNetContext(false)
    const state = createState(ctx, 0x2f1, CHARS)
    const cap = captureTransport()
    const shadow = new ShadowLoop(ctx, state, cap.transport)
    const drive = driverFor(shadow)
    drive.tick(5)

    const newer = createState(ctx, 0x2f1, CHARS)
    newer.tick = 20
    const older = createState(ctx, 0x2f1, CHARS)
    older.tick = 15

    // Newest first, then the reordered older one - the ordinary jitter case at a
    // 3-tick broadcast cadence, and both land between two ticks.
    cap.deliver('host', 'unreliable',
      framed('snapshot', SNAP_BUF_BYTES, (p) => encodeSnapshot(p, newer, new Array(MAX_KARTS).fill(-1))))
    cap.deliver('host', 'unreliable',
      framed('snapshot', SNAP_BUF_BYTES, (p) => encodeSnapshot(p, older, new Array(MAX_KARTS).fill(-1))))
    drive.tick()

    // Both frames are outside this loop's 24-tick history at tick 5, so whichever
    // one is reconciled hard-snaps the clock to its own tick and the result is
    // unambiguous: 21 if the newer frame won, 16 if the older one replaced it.
    expect(state.tick, 'an older frame replaced a newer one that was already queued').toBe(21)
    expect(droppedDatagramsOf(shadow), 'the older frame was well-formed; it must be rejected, not dropped').toBe(0)
  })
})

describe('ShadowLoop: the race phase comes off the wire (Task 15c item A)', () => {
  it('adopts a phase the host announces even when every kart and entity already agrees', () => {
    // The follower half of item A, and the case that needs the divergence check
    // to know about `phase` at all: a snapshot whose karts and entities agree to
    // the last bit still returns early from reconcile() unless something says
    // the phase differs - and `phase` is the one snapshot field that can differ
    // on its own. It matters more than any kart field does: resolveInputs
    // freezes ALL EIGHT KARTS while the phase is 'countdown', so a shadow stuck
    // on the wrong one is running a different race.
    const ctx = makeNetContext(false)
    const state = createState(ctx, 0x1a1, CHARS)
    const cap = captureTransport()
    const shadow = new ShadowLoop(ctx, state, cap.transport)
    const drive = driverFor(shadow)
    drive.tick(10)
    expect(state.phase).toBe('countdown')

    // Encoded from the shadow's OWN published state, so the only thing the wire
    // disagrees about is the phase. 'finished' is also a phase this loop could
    // never have reached by itself - advancePhase gets there through finishers
    // or the grace timer, and neither has happened - so adopting it cannot be
    // local inference.
    const announced = allocStateLike(makeNetContext(true), state)
    cloneState(state, announced)
    announced.phase = 'finished'
    cap.deliver('host', 'unreliable',
      framed('snapshot', SNAP_BUF_BYTES, (p) => encodeSnapshot(p, announced, new Array(MAX_KARTS).fill(-1))))

    const tickBefore = state.tick
    drive.tick()
    expect(state.phase, 'the shadow ignored the host and kept its own phase').toBe('finished')
    // No rewind: adopting a phase is a correction, not a resync.
    expect(state.tick).toBe(tickBefore + 1)
  })

  it('follows a host through the countdown and into the race', () => {
    // The ordinary path, end to end against a REAL AuthorityLoop that runs its
    // own countdown - no hand-built snapshot anywhere in it.
    const hostCtx = makeNetContext(true)
    const shadowCtx = makeNetContext(false)
    const hostState = createState(hostCtx, 0x1a2, CHARS)
    const shadowState = createState(shadowCtx, 0x1a2, CHARS)
    const pair = makeLossyPair({ latencyMs: 20, jitterMs: 0, lossRate: 0, seed: 9 })
    const host = new AuthorityLoop(hostCtx, hostState, pair.a)
    const shadow = new ShadowLoop(shadowCtx, shadowState, pair.b)
    const drive = driverFor(shadow)

    let nowMs = 0
    const advance = (n: number): void => {
      for (let i = 0; i < n; i++) {
        pair.pump(nowMs)
        host.tick()
        drive.tick()
        nowMs += TICK_MS
      }
    }

    advance(120)
    expect(hostState.phase).toBe('countdown')
    expect(shadowState.phase).toBe('countdown')
    advance(120)
    expect(hostState.phase).toBe('racing')
    expect(shadowState.phase, 'the shadow was left behind in the countdown').toBe('racing')
    expect(shadowState.tick).toBe(hostState.tick)
  })
})

describe('ShadowLoop: host loss is measured in WALL MILLISECONDS (Task 15c item C)', () => {
  it('promotes at 1.5s even when the tick source stalls and the scheduler clamps its catch-up', () => {
    // THE test this item exists for. Spec §5 declares host loss after 1.5s with
    // no snapshot; this loop used to count its own ticks, and a tick counter
    // stalls in exactly the conditions that cause host loss. A backgrounded tab
    // or a descheduled server process runs ZERO ticks for seconds, and the
    // scheduler that wakes up afterwards runs at most MAX_CATCHUP_TICKS
    // (clock.ts) rather than the sixty a second of wall time is worth - so the
    // detector under-counted precisely when the room was in trouble, and
    // promoted late or never.
    const ctx = makeNetContext(false)
    const state = createState(ctx, 0x15c, CHARS)
    const cap = captureTransport()
    const shadow = new ShadowLoop(ctx, state, cap.transport)

    // A live host first, so the timer is measured from a real snapshot rather
    // than from construction.
    cap.deliver('host', 'unreliable',
      framed('snapshot', SNAP_BUF_BYTES, (p) => encodeSnapshot(p, state, new Array(MAX_KARTS).fill(-1))))
    shadow.tick(0)
    expect(ctx.isLeader).toBe(false)

    // The room stalls for a second and a half. When the scheduler wakes, it asks
    // advanceAccumulator - the real one, not a stand-in - how many ticks that
    // gap is worth, and gets MAX_CATCHUP_TICKS back, because running sixty would
    // be the spiral of death.
    const acc = makeTickAccumulator()
    const wokeAtMs = 1500
    const ticksToRun = advanceAccumulator(acc, wokeAtMs)
    expect(ticksToRun).toBe(MAX_CATCHUP_TICKS)
    let promotedAtTick = -1
    for (let i = 0; i < ticksToRun; i++) {
      shadow.tick(wokeAtMs)
      if (promotedAtTick < 0 && ctx.isLeader) promotedAtTick = state.tick
    }

    expect(ctx.isLeader, 'the shadow never promoted: it was counting ticks, and the ticks stopped').toBe(true)
    // And the count that proves the point: SIX ticks have ever run. Under the
    // old rule this loop needed ninety of them before it would look up.
    expect(state.tick).toBe(1 + MAX_CATCHUP_TICKS)
    expect(state.tick).toBeLessThan(HOST_TIMEOUT_TICKS)

    const changes = cap.broadcasts.filter(
      (b) => b.channel === 'reliable' && decodeHeader(b.data).kind === 'authorityChange',
    )
    expect(changes, 'exactly one authorityChange, at the moment of promotion').toHaveLength(1)
    // Announced at the tick promotion happened on - the FIRST of the catch-up
    // burst, not the last - which is also the tick the room must rebuild its
    // authority from.
    expect(promotedAtTick).toBe(2)
    expect(decodeAuthorityChange(changes[0].data).tick).toBe(promotedAtTick)
  })

  it('does not promote on wall time alone while the host is still broadcasting', () => {
    // The control. The clock moving is not the signal - SILENCE is - so a room
    // whose scheduler is late but whose host is alive must not change authority.
    const ctx = makeNetContext(false)
    const state = createState(ctx, 0x15d, CHARS)
    const cap = captureTransport()
    const shadow = new ShadowLoop(ctx, state, cap.transport)
    const snapshotState = createState(makeNetContext(true), 0x15d, CHARS)

    let nowMs = 0
    for (let wake = 0; wake < 10; wake++) {
      // A snapshot arrives, then the scheduler wakes a full 1.4s later and runs
      // its clamped burst. Ten times over: fourteen seconds of wall time, and no
      // promotion at any point.
      snapshotState.tick = state.tick
      cap.deliver('host', 'unreliable',
        framed('snapshot', SNAP_BUF_BYTES, (p) => encodeSnapshot(p, snapshotState, new Array(MAX_KARTS).fill(-1))))
      nowMs += HOST_TIMEOUT_MS - 100
      for (let i = 0; i < MAX_CATCHUP_TICKS; i++) shadow.tick(nowMs)
      expect(ctx.isLeader, `promoted at wake ${wake} with a live host`).toBe(false)
    }
    expect(nowMs).toBeGreaterThan(HOST_TIMEOUT_MS * 9)

    // ... and the moment the host stops, one late wake-up is enough.
    nowMs += HOST_TIMEOUT_MS
    shadow.tick(nowMs)
    expect(ctx.isLeader).toBe(true)
  })

  it('starts the timer at the first tick, not at construction, and never before', () => {
    // The loop is built with no clock at all, so "how long has the host been
    // silent" is undefined until a scheduler says what time it is. A first tick
    // at a large nowMs - a room created long before it starts running, which is
    // every room that waits in a lobby - must not promote on the spot.
    const ctx = makeNetContext(false)
    const state = createState(ctx, 0x15e, CHARS)
    const shadow = new ShadowLoop(ctx, state, deafTransport())
    shadow.tick(9_000_000)
    expect(ctx.isLeader, 'promoted on its very first tick because the clock was large').toBe(false)
    shadow.tick(9_000_000 + HOST_TIMEOUT_MS - 1)
    expect(ctx.isLeader).toBe(false)
    shadow.tick(9_000_000 + HOST_TIMEOUT_MS)
    expect(ctx.isLeader).toBe(true)
  })
})

describe('ShadowLoop: promotion', () => {
  it('auto-promotes at exactly HOST_TIMEOUT_MS of silence with no snapshot ever received', () => {
    const ctx = makeNetContext(false)
    const state = createState(ctx, 0x333, CHARS)
    const cap = captureTransport()
    const shadow = new ShadowLoop(ctx, state, cap.transport)
    const drive = driverFor(shadow)
    expect(ctx.isLeader).toBe(false)

    // Three host events land first, so nextEventSeq is 3 and not 0 when the
    // authorityChange goes out. Comparing a zero to a zero would pass against
    // a promote() that hardcoded the field, or read the wrong counter.
    // Events do NOT reset the promotion timer: spec §5 declares host loss on
    // 1.5s with no SNAPSHOT, and this is the case that proves it.
    const evs: AuthEvent[] = [0, 1, 2].map((seq) => ({
      eventSeq: seq, tick: 1, kind: 'lapCross' as const, playerId: seq, entityId: -1, item: 'none' as const, data: 1,
    }))
    cap.deliver('host', 'reliable', framed('events', 256, (p) => encodeEvents(p, evs)))

    // The timer starts at the FIRST tick (the loop is constructed without a
    // clock), so 90 ticks span 89 * TICK_MS = 1483ms of wall time - just inside
    // the timeout.
    drive.tick(HOST_TIMEOUT_TICKS)
    expect(drive.nowMs() - TICK_MS).toBeLessThan(HOST_TIMEOUT_MS)
    expect(state.nextEventSeq).toBe(3)
    expect(ctx.isLeader).toBe(false)

    drive.tick() // the 91st: 90 * TICK_MS = 1500ms exactly
    expect(ctx.isLeader).toBe(true)

    const changes = cap.broadcasts.filter(
      (b) => b.channel === 'reliable' && decodeHeader(b.data).kind === 'authorityChange',
    )
    expect(changes).toHaveLength(1)
    const decoded = decodeAuthorityChange(changes[0].data)
    expect(decoded.tick).toBe(HOST_TIMEOUT_TICKS + 1)
    expect(decoded.eventSeq).toBe(3)
    expect(decoded.eventSeq).toBe(state.nextEventSeq)
  })

  it('re-seeds rngCursor through promotionCursor and never rewinds tick, lap, or a live entity', () => {
    const ctx = makeNetContext(false)
    const state = createState(ctx, 0x444, CHARS)
    // Both watched quantities are given a NONZERO starting value before the loop
    // is constructed (ShadowLoop's allocStateLike copies the caller's state into
    // `live`), because "lap >= 0" and "an empty entity set lost nothing" are true
    // of every implementation, correct or broken. A lap seeded at 1 can regress;
    // a seeded entity can vanish. That is the whole point of this test.
    for (const k of state.karts) k.lap.lap = 1
    const WATCHED_ID = 4242
    const SEEDED_TTL = 5000 // outlives the entire run: it can never expire legally
    seedSlick(state, WATCHED_ID, SEEDED_TTL)

    const shadow = new ShadowLoop(ctx, state, deafTransport())

    const drive = driverFor(shadow)
    drive.tick(40)

    const tickBefore = state.tick
    const lapsBefore = state.karts.map((k) => k.lap.lap)
    const liveBefore = state.entities.slice(0, state.entityCount).map((e) => e.entityId)
    expect(liveBefore).toContain(WATCHED_ID)
    expect(lapsBefore.every((l) => l >= 1)).toBe(true)
    const findWatched = (): { entityId: number; ttl: number } | undefined =>
      state.entities.slice(0, state.entityCount).find((e) => e.entityId === WATCHED_ID)
    let lastTtl = findWatched()!.ttl
    expect(lastTtl).toBe(SEEDED_TTL - 40) // ttl decrements by exactly 1 per tick

    shadow.promote(state.tick)
    // promote() republishes, so the caller's state carries the re-seeded cursor
    // immediately rather than one tick later. Ruling P2-R14: the cursor is
    // promotionCursor(raceSeed, promotionTick), not the promotion tick itself.
    expect(state.rngCursor).toBe(promotionCursor(state.raceSeed, tickBefore))
    expect(state.rngCursor).not.toBe(tickBefore)
    expect(ctx.isLeader).toBe(true)
    expect(state.tick).toBe(tickBefore)

    for (let i = 1; i <= 40; i++) {
      drive.tick()
      // Forward by exactly one, every tick: "never rewinds" is a statement about
      // promotion, and a rewind is precisely a repeated or lowered tick number.
      expect(state.tick).toBe(tickBefore + i)
      for (let k = 0; k < MAX_KARTS; k++) {
        expect(state.karts[k].lap.lap, `lap regressed for kart ${k}`).toBeGreaterThanOrEqual(lapsBefore[k])
      }
      // The seeded entity is still live, and its ttl walked down by exactly one.
      // A promotion that rebuilt state from an older buffer shows up here as
      // either a missing id or a ttl that jumped back up.
      const watched = findWatched()
      expect(watched, `entity ${WATCHED_ID} vanished ${i} ticks after promotion, with ttl ${lastTtl} last seen`).toBeDefined()
      expect(watched!.ttl).toBe(lastTtl - 1)
      lastTtl = watched!.ttl
    }
  })

  it('broadcasts a snapshot every 3rd tick once promoted, for 60 ticks', () => {
    const ctx = makeNetContext(false)
    const state = createState(ctx, 0x555, CHARS)
    const snapshots: number[] = []
    const cap = captureTransport()
    const shadow = new ShadowLoop(ctx, state, cap.transport)
    const drive = driverFor(shadow)
    shadow.promote(0)
    for (let i = 1; i <= 60; i++) {
      drive.tick()
      const n = cap.broadcasts.filter(
        (b) => b.channel === 'unreliable' && decodeHeader(b.data).kind === 'snapshot',
      ).length
      if (n > snapshots.length) snapshots.push(i)
    }
    // Ticks 3, 6, 9 ... 60 — twenty of them, and the tick numbers themselves are
    // pinned, so a loop that broadcast on the wrong phase of the cadence (or
    // every tick, or once and then never again) fails on the list, not a count.
    expect(snapshots).toEqual([3, 6, 9, 12, 15, 18, 21, 24, 27, 30, 33, 36, 39, 42, 45, 48, 51, 54, 57, 60])
    expect(ctx.isLeader).toBe(true)
  })

  it('calling promote() twice is a no-op the second time', () => {
    const ctx = makeNetContext(false)
    const state = createState(ctx, 0x666, CHARS)
    const cap = captureTransport()
    const shadow = new ShadowLoop(ctx, state, cap.transport)
    shadow.promote(5)
    const cursorAfterFirst = state.rngCursor
    shadow.promote(9)
    expect(cap.broadcasts.filter((b) => b.channel === 'reliable')).toHaveLength(1)
    // ...and the second call did not re-seed from its own tick either.
    expect(state.rngCursor).toBe(cursorAfterFirst)
    expect(cursorAfterFirst).toBe(promotionCursor(state.raceSeed, 5))
  })

  it('does not auto-promote a second time after an explicit promote()', () => {
    // ticksSinceSnapshot keeps climbing after an explicit promotion, and a
    // missing `if (this.promoted) return` guard would fire a second
    // authorityChange 90 ticks later — with a fresh re-seed that discards
    // everything the promoted authority had rolled since.
    const ctx = makeNetContext(false)
    const state = createState(ctx, 0x668, CHARS)
    const cap = captureTransport()
    const shadow = new ShadowLoop(ctx, state, cap.transport)
    const drive = driverFor(shadow)
    shadow.promote(0)
    drive.tick(200)
    const changes = cap.broadcasts.filter(
      (b) => b.channel === 'reliable' && decodeHeader(b.data).kind === 'authorityChange',
    )
    expect(changes).toHaveLength(1)
  })

  it('promote() mutates the exact ctx object passed to the constructor, not a private copy', () => {
    // AuthorityLoop and ClientLoop each defensively copy their ctx
    // (`{ ...ctx, isLeader: ... }`) because their own leader/follower role is
    // fixed for their whole lifetime. ShadowLoop cannot do that: its role
    // genuinely changes at promotion, and contract §5 gives it no state()-like
    // accessor — the caller's own ctx object mutating in place is the only
    // channel this loop has for making that change observable. A well-meaning
    // "fix" that made ShadowLoop copy ctx like its two peers would silently
    // sever that channel, and this test names that regression directly.
    const ctx = makeNetContext(false)
    const state = createState(ctx, 0x777, CHARS)
    const shadow = new ShadowLoop(ctx, state, deafTransport())
    expect(ctx.isLeader).toBe(false)

    shadow.promote(0)

    // Same variable, same object reference: a defensively-copied ctx would
    // leave this caller-held binding at its original value forever.
    expect(ctx.isLeader).toBe(true)
  })
})

describe('ShadowLoop: the follower -> emitter transition', () => {
  /** Parks kart 0 on top of item box 0, which is the one thing that makes a
   * leader roll and emit on the very next tick. Identical setup on both sides
   * of the pair below, so the ONLY difference is who holds authority. */
  function parkOnItemBox(ctx: ReturnType<typeof makeNetContext>, state: SimState): void {
    const p = { x: 0, y: 0, z: 0 }
    itemBoxWorldPos(ctx, 0, p)
    state.karts[0].position.x = p.x
    state.karts[0].position.y = p.y
    state.karts[0].position.z = p.z
  }

  it('an unpromoted shadow standing on an item box rolls nothing, emits nothing, broadcasts nothing', () => {
    const ctx = makeNetContext(false)
    const state = createState(ctx, 0x888, CHARS)
    parkOnItemBox(ctx, state)
    const cap = captureTransport()
    const shadow = new ShadowLoop(ctx, state, cap.transport)
    const drive = driverFor(shadow)

    drive.tick()

    // The pickup itself is not leader-only — the box timer starts on every peer
    // (items.ts), and it is set inside updateItemBoxes AFTER that function's own
    // decrement pass, so it reads the full tuning value on this tick. What a
    // follower must not do is roll, grant, or announce.
    expect(state.itemBoxes[0].respawnTicks).toBe(ctx.tuning.itemBoxRespawnTicks)
    expect(state.karts[0].item).toBe('none')
    expect(state.rngCursor).toBe(0)
    expect(state.nextEventSeq).toBe(0)
    expect(cap.broadcasts).toHaveLength(0)
  })

  it('the same shadow, promoted, rolls and emits on the very next tick', () => {
    const ctx = makeNetContext(false)
    const state = createState(ctx, 0x888, CHARS)
    parkOnItemBox(ctx, state)
    // Box 0 starts on a 5-tick timer so the five FOLLOWER ticks below tick it
    // down to zero without collecting it, and the pickup lands on the first
    // tick after promotion. (Re-arming it by writing to `state` between ticks
    // would do nothing: `state` is a published copy, not a window into the
    // loop — see the test below.)
    state.itemBoxes[0].respawnTicks = 5
    const cap = captureTransport()
    const shadow = new ShadowLoop(ctx, state, cap.transport)
    const drive = driverFor(shadow)

    // Three host events first, so the promoted loop's first emission has to
    // continue from 3 rather than restart at 0 (spec §5: "continues eventSeq
    // from the highest it observed").
    const evs: AuthEvent[] = [0, 1, 2].map((seq) => ({
      eventSeq: seq, tick: 0, kind: 'lapCross' as const, playerId: seq + 1, entityId: -1, item: 'none' as const, data: 1,
    }))
    cap.deliver('host', 'reliable', framed('events', 256, (p) => encodeEvents(p, evs)))
    drive.tick(5) // applies them; still a follower, so still no roll
    expect(state.nextEventSeq).toBe(3)
    expect(state.rngCursor).toBe(0)
    expect(state.karts[0].item).toBe('none')
    expect(state.itemBoxes[0].respawnTicks).toBe(0)

    shadow.promote(state.tick)
    const seededCursor = promotionCursor(state.raceSeed, state.tick)
    expect(state.rngCursor).toBe(seededCursor)

    cap.broadcasts.length = 0
    drive.tick()

    // Rolled: exactly one draw was consumed.
    expect(state.rngCursor).toBe(seededCursor + 1)
    expect(state.karts[0].item).not.toBe('none')
    // Emitted, and numbered from where the host left off — not from 0.
    expect(state.nextEventSeq).toBe(4)
    const eventMsgs = cap.broadcasts.filter(
      (b) => b.channel === 'reliable' && decodeHeader(b.data).kind === 'events',
    )
    expect(eventMsgs).toHaveLength(1)
    const out: AuthEvent[] = []
    decodeEvents(eventMsgs[0].data.subarray(2), out)
    expect(out).toHaveLength(1)
    expect(out[0].kind).toBe('itemGrant')
    expect(out[0].eventSeq).toBe(3)
    expect(out[0].playerId).toBe(0)
  })

  it('publishes a COPY: writing to the published state does not reach the loop', () => {
    // Contract §5 gives ShadowLoop no state() accessor, so the constructor's
    // SimState is the only view a caller has — and it is a value copy written
    // once per tick(), not a live handle. A caller that "corrected" the loop by
    // assigning into it would see its edit silently reverted on the next tick,
    // which is a far worse failure than a compile error. This test pins the
    // direction of that flow so nobody builds on the other one.
    const ctx = makeNetContext(false)
    const state = createState(ctx, 0x88a, CHARS)
    const shadow = new ShadowLoop(ctx, state, deafTransport())
    const drive = driverFor(shadow)
    drive.tick()

    state.karts[0].position.x += 1000
    state.karts[0].lap.lap = 7
    const tamperedX = state.karts[0].position.x

    drive.tick()

    expect(state.karts[0].lap.lap).toBe(0)
    expect(state.karts[0].position.x).toBeLessThan(tamperedX - 900)
  })

  it('a promoted shadow ignores late host events instead of applying them', () => {
    // The dead host's reliable channel can still deliver after promotion. Those
    // events describe a timeline this loop is no longer following, and applying
    // one would drag nextEventSeq out from under the sequence this loop is now
    // assigning.
    const ctx = makeNetContext(false)
    const state = createState(ctx, 0x889, CHARS)
    const cap = captureTransport()
    const shadow = new ShadowLoop(ctx, state, cap.transport)
    const drive = driverFor(shadow)
    shadow.promote(0)
    expect(state.nextEventSeq).toBe(0)

    const late: AuthEvent[] = [{
      eventSeq: 50, tick: 0, kind: 'itemGrant', playerId: 3, entityId: -1, item: 'boost', data: 0,
    }]
    cap.deliver('host', 'reliable', framed('events', 256, (p) => encodeEvents(p, late)))
    drive.tick(5)

    expect(state.karts[3].item).toBe('none')
    expect(state.nextEventSeq).toBe(0)
  })
})

/**
 * Spec §8's four promotion clauses, evaluated on one consecutive pair of
 * published states. Returns the violations by name; an empty array is the pass.
 *
 * Deliberately NOT statesEqual (ruling P2-R15): promotion re-seeds rngCursor
 * through promotionCursor, so the promoted shadow's whole-state equality with
 * the host is falsified BY DESIGN — spec §5 calls the resulting divergence in
 * post-promotion item rolls "accepted". These are the clauses the spec actually
 * names, asserted individually.
 */
function promotionViolations(prev: SimState, next: SimState, watchedId: number): string[] {
  const v: string[] = []
  if (next.tick !== prev.tick + 1) v.push(`tick went ${prev.tick} -> ${next.tick}, expected +1`)
  for (let i = 0; i < MAX_KARTS; i++) {
    if (next.karts[i].lap.lap < prev.karts[i].lap.lap) {
      v.push(`lap regressed for kart ${i}: ${prev.karts[i].lap.lap} -> ${next.karts[i].lap.lap}`)
    }
  }
  const find = (s: SimState) => s.entities.slice(0, s.entityCount).find((e) => e.entityId === watchedId)
  const before = find(prev)
  const after = find(next)
  if (before !== undefined && after === undefined) v.push(`entity ${watchedId} disappeared`)
  if (before !== undefined && after !== undefined && after.ttl !== before.ttl - 1) {
    v.push(`entity ${watchedId} ttl went ${before.ttl} -> ${after.ttl}, expected -1`)
  }
  return v
}

describe('ShadowLoop: spec §8 promotion, against a real AuthorityLoop host', () => {
  const SEED = 0x51ade
  const WATCHED_ID = 4242
  const WATCHED_TTL = 20000
  const DEATH_TICK = 900
  const AFTER_TICKS = 120
  const HUMANS = [0, 1]
  const DT = 1000 / 60

  interface Run {
    hostFinal: SimState
    published: SimState[]
    promotedAtIndex: number
    authorityChange: { tick: number; eventSeq: number }
    shadowSeqAtDeathDrain: number
    hostSeqAtDeath: number
    eventLedgerApplied: number[]
    shadowEmittedSeqs: number[]
    hostCtx: SimContext
    shadowCtx: SimContext
  }

  /** One full host-lives / host-dies / shadow-promotes run, recorded tick by tick. */
  function runPromotion(): Run {
    const hostCtx = makeNetContext(true)
    const shadowCtx = makeNetContext(false)
    const hostState = createState(hostCtx, SEED, CHARS)
    const shadowState = createState(shadowCtx, SEED, CHARS)
    // The same live entity on both sides before either loop is built, so it is
    // real to the host (and rides its snapshots) rather than a shadow-only prop.
    seedSlick(hostState, WATCHED_ID, WATCHED_TTL)
    seedSlick(shadowState, WATCHED_ID, WATCHED_TTL)
    // Two human seats. Without them both loops run the identical deterministic
    // bot sim from the identical seed and agree to 0.01m whether or not a single
    // snapshot is ever delivered — which would leave clause 1's bound with
    // nothing to measure. Real input, sent to the two loops over two
    // independently lossy paths, is what makes the correction path load-bearing.
    for (const p of HUMANS) {
      for (const st of [hostState, shadowState]) {
        st.karts[p].isBot = false
        st.karts[p].connected = true
      }
    }

    const pair = makeLossyPair() // 150ms latency, 50ms jitter, 5% loss, seeded
    const host = new AuthorityLoop(hostCtx, hostState, pair.a)
    const shadow = new ShadowLoop(shadowCtx, shadowState, pair.b)
    const drive = driverFor(shadow)

    // Spec §5: "Every client sends its input to both the host and the server
    // shadow." makeLoopbackPair is a pair, so the test plays both clients: a
    // broadcast on side b reaches the host, one on side a reaches the shadow,
    // and each draws its own loss and jitter.
    const windows = HUMANS.map(() =>
      Array.from({ length: INPUT_REDUNDANCY }, () => ({
        tick: 0, steer: 0, accel: 0, brake: false, drift: false, useItem: false,
      })),
    )
    const sendInput = (tick: number): void => {
      if (tick % 2 !== 0) return // 30Hz
      for (let h = 0; h < HUMANS.length; h++) {
        const w = windows[h]
        w.shift()
        w.push({
          tick,
          steer: Math.sin((tick + HUMANS[h] * 37) / 23) * 0.6,
          accel: 1,
          brake: false,
          drift: tick % 150 < 50,
          useItem: tick % 90 === 0,
        })
        const buf = new Uint8Array(256)
        const hd = encodeHeader(buf, 'input')
        const n = encodeInput(buf.subarray(hd), HUMANS[h], w)
        pair.b.broadcast('unreliable', buf.slice(0, hd + n)) // -> host
        pair.a.broadcast('unreliable', buf.slice(0, hd + n)) // -> shadow
      }
    }

    // Every events datagram that actually crossed the wire, in delivery order:
    // host -> shadow on side b, and (after promotion) shadow -> host on side a.
    const eventsSeen: AuthEvent[] = []
    const sniff = (data: Uint8Array): void => {
      if (decodeHeader(data).kind !== 'events') return
      const out: AuthEvent[] = []
      decodeEvents(data.subarray(2), out)
      for (const e of out) eventsSeen.push(e)
    }
    pair.b.onMessage((_p, ch, data) => {
      if (ch === 'reliable') sniff(data)
    })
    const shadowEmitted: AuthEvent[] = []
    pair.a.onMessage((_p, ch, data) => {
      if (ch !== 'reliable') return
      if (decodeHeader(data).kind === 'events') {
        const out: AuthEvent[] = []
        decodeEvents(data.subarray(2), out)
        for (const e of out) shadowEmitted.push(e)
      }
      sniff(data)
    })
    let authorityChange: { tick: number; eventSeq: number } | null = null
    pair.a.onMessage((_p, ch, data) => {
      if (ch === 'reliable' && decodeHeader(data).kind === 'authorityChange') {
        authorityChange = decodeAuthorityChange(data)
      }
    })

    const published: SimState[] = []
    let now = 0
    const record = (): void => {
      published.push(allocStateLike(shadowCtx, shadowState))
    }

    for (let t = 1; t <= DEATH_TICK; t++) {
      pair.pump(now)
      sendInput(t)
      host.tick()
      drive.tick()
      now += DT
      if (t > DEATH_TICK - 30) record() // the 30 ticks before the host dies
    }

    const hostFinal = allocStateLike(hostCtx, host.state())
    const hostSeqAtDeath = host.state().nextEventSeq

    // The host is gone. Nothing more is sent from side a, but whatever it put on
    // the wire in its last 150ms is still in flight and still gets delivered —
    // which is exactly the "events still in flight when it died" case.
    let shadowSeqAtDeathDrain = -1
    let promotedAtIndex = -1
    for (let t = 1; t <= HOST_TIMEOUT_TICKS + AFTER_TICKS; t++) {
      pair.pump(now)
      sendInput(DEATH_TICK + t) // the clients have no idea the host is gone
      drive.tick()
      now += DT
      record()
      if (t === 20) shadowSeqAtDeathDrain = shadowState.nextEventSeq
      if (promotedAtIndex < 0 && shadowCtx.isLeader) promotedAtIndex = published.length - 1
    }

    // The ledger: a peer applying every events datagram that crossed the wire,
    // in the order it crossed, through the same applyEvent every client uses.
    const ledgerCtx = makeNetContext(false)
    const ledgerState = createState(ledgerCtx, SEED, CHARS)
    const applied: number[] = []
    for (const ev of eventsSeen) {
      if (applyEvent(ledgerCtx, ledgerState, ev)) applied.push(ev.eventSeq)
    }

    expect(authorityChange, 'no authorityChange was ever broadcast').not.toBeNull()
    return {
      hostFinal,
      published,
      promotedAtIndex,
      authorityChange: authorityChange!,
      shadowSeqAtDeathDrain,
      hostSeqAtDeath,
      eventLedgerApplied: applied,
      shadowEmittedSeqs: shadowEmitted.map((e) => e.eventSeq),
      hostCtx,
      shadowCtx,
    }
  }

  it('kills the host mid-race and satisfies every clause of the spec §8 promotion test', () => {
    const r = runPromotion()

    // --- the race really was in motion when the host died -------------------
    const atDeath = r.published[29]
    expect(atDeath.tick).toBe(DEATH_TICK)
    expect(atDeath.phase).toBe('racing')
    const speeds = atDeath.karts.map((k) => Math.hypot(k.velocity.x, k.velocity.z))
    expect(Math.min(...speeds), 'a kart was stationary at the moment of death').toBeGreaterThan(5)
    expect(atDeath.karts.every((k) => k.lap.lap >= 1)).toBe(true)
    expect(atDeath.entityCount, 'no live entity at the moment of death').toBeGreaterThanOrEqual(1)
    expect(r.hostSeqAtDeath, 'no events had flowed by the moment of death').toBeGreaterThan(5)
    expect(r.promotedAtIndex).toBeGreaterThan(0)

    // --- clause 1: matches the host's last state within bounds --------------
    for (let i = 0; i < MAX_KARTS; i++) {
      const h = r.hostFinal.karts[i]
      const s = atDeath.karts[i]
      const d = Math.hypot(h.position.x - s.position.x, h.position.y - s.position.y, h.position.z - s.position.z)
      // Measured: 0.005-0.022m across the eight karts. The 1m bound is not a
      // rounded-up version of that — a shadow that never reconciles scores
      // 14.3m on this same run, which is what gives the bound something to
      // measure, and is why the two human seats above are here.
      expect(d, `kart ${i} was ${d.toFixed(3)}m from the host's last state`).toBeLessThan(1)
      expect(s.lap.lap, `kart ${i} lap`).toBe(h.lap.lap)
    }
    expect(atDeath.entityCount).toBe(r.hostFinal.entityCount)

    // --- clauses 2 and 3: no lap regresses, no entity disappears ------------
    for (let i = 1; i < r.published.length; i++) {
      const v = promotionViolations(r.published[i - 1], r.published[i], WATCHED_ID)
      expect(v, `tick ${r.published[i].tick} (index ${i}, promotion at ${r.promotedAtIndex})`).toEqual([])
    }
    const last = r.published[r.published.length - 1]
    expect(last.entities.slice(0, last.entityCount).map((e) => e.entityId)).toContain(WATCHED_ID)

    // --- clause 4: no event is applied twice --------------------------------
    // The follower's counter is bit-identical to the dead host's once the last
    // in-flight datagram has drained: every event applied exactly once, none
    // skipped, none doubled. Anything else and these two numbers differ.
    expect(r.shadowSeqAtDeathDrain).toBe(r.hostSeqAtDeath)
    // ...and the promoted authority numbers its own events from there, so no
    // sequence it assigns can collide with one the host already assigned.
    expect(r.authorityChange.eventSeq).toBe(r.hostSeqAtDeath)
    // The 1.5s timer runs from the last snapshot RECEIVED, not from the tick the
    // host stopped sending: its final ~200ms of broadcasts were still in flight
    // and still arrived. So the promotion tick is DEATH_TICK + 90 plus that tail,
    // bounded by the worst-case one-way transit (150ms latency + 50ms jitter =
    // 12 ticks) plus one snapshot period (3 ticks).
    const promotionDelay = r.authorityChange.tick - DEATH_TICK
    expect(promotionDelay).toBeGreaterThanOrEqual(HOST_TIMEOUT_TICKS)
    expect(promotionDelay).toBeLessThanOrEqual(HOST_TIMEOUT_TICKS + 15)
    for (const seq of r.shadowEmittedSeqs) expect(seq).toBeGreaterThanOrEqual(r.authorityChange.eventSeq)
    // A peer that applied every datagram that crossed the wire applied each
    // eventSeq at most once, across the handover.
    const seen = new Set(r.eventLedgerApplied)
    expect(r.eventLedgerApplied.length, 'an eventSeq was applied twice').toBe(seen.size)
    expect(r.eventLedgerApplied.length).toBeGreaterThan(5)
    for (let i = 1; i < r.eventLedgerApplied.length; i++) {
      expect(r.eventLedgerApplied[i]).toBeGreaterThan(r.eventLedgerApplied[i - 1])
    }
  })

  it('the promotion assertions fail against a frozen shadow and a from-scratch shadow', () => {
    // The clause checker above is only worth anything if it can fail. A shadow
    // that did nothing at all still trivially satisfies "no lap regresses" and
    // "no entity disappears" when those are read off a state that never moved,
    // and a shadow that rebuilt from createState() satisfies them if nothing
    // nonzero was ever seeded. Both impostors are run through the SAME checker
    // the real test uses, so relaxing the checker breaks this test too.
    const ctx = makeNetContext(false)
    const live = createState(ctx, SEED, CHARS)
    live.tick = 900
    for (const k of live.karts) k.lap.lap = 2
    seedSlick(live, WATCHED_ID, WATCHED_TTL)

    // Impostor 1: frozen. Its published state at tick N+1 is its state at tick N.
    const frozen = allocStateLike(ctx, live)
    const frozenViolations = promotionViolations(live, frozen, WATCHED_ID)
    expect(frozenViolations).toContain('tick went 900 -> 900, expected +1')
    expect(frozenViolations).toContain(`entity ${WATCHED_ID} ttl went ${WATCHED_TTL} -> ${WATCHED_TTL}, expected -1`)

    // Impostor 2: restarted from scratch at promotion.
    const scratch = createState(ctx, SEED, CHARS)
    const scratchViolations = promotionViolations(live, scratch, WATCHED_ID)
    expect(scratchViolations).toContain('tick went 900 -> 0, expected +1')
    expect(scratchViolations).toContain('lap regressed for kart 0: 2 -> 0')
    expect(scratchViolations).toContain(`entity ${WATCHED_ID} disappeared`)

    // And the real thing, one honest tick, passes the same checker.
    const shadow = new ShadowLoop(ctx, live, deafTransport())
    const drive = driverFor(shadow)
    const before = allocStateLike(ctx, live)
    drive.tick()
    expect(promotionViolations(before, live, WATCHED_ID)).toEqual([])
  })
})

describe('no event is applied twice across the handover', () => {
  /** spinOut is the one event kind whose re-application is VISIBLE: applyEvent
   * writes `k.spinOutTicks = ev.data`, and updateRecovery decrements it every
   * tick, so a second application resets a counter that should only ever fall.
   * lapCross, itemGrant and respawn are all idempotent and would hide the bug. */
  const spinOut = (eventSeq: number, playerId: number): AuthEvent => ({
    eventSeq, tick: 0, kind: 'spinOut', playerId, entityId: -1, item: 'none', data: 60,
  })

  it('a redelivered event does not restart the counter it set', () => {
    const ctx = makeNetContext(false)
    const state = createState(ctx, 0x991, CHARS)
    const cap = captureTransport()
    const shadow = new ShadowLoop(ctx, state, cap.transport)
    const drive = driverFor(shadow)

    const msg = framed('events', 256, (p) => encodeEvents(p, [spinOut(0, 2)]))
    cap.deliver('host', 'reliable', msg)
    drive.tick()
    expect(state.karts[2].spinOutTicks).toBe(59) // set to 60, then one tick of decay

    drive.tick(10)
    const beforeRedelivery = state.karts[2].spinOutTicks
    expect(beforeRedelivery).toBe(49)

    // The same bytes again, ten ticks later: a reliable channel can repeat a
    // send, and a promoted peer re-broadcasts what it saw.
    cap.deliver('host', 'reliable', msg)
    drive.tick()
    expect(state.karts[2].spinOutTicks, 'the event was applied a second time').toBe(beforeRedelivery - 1)
    expect(state.nextEventSeq).toBe(1)
  })

  it('a late host event that collides with a promoted shadow\'s sequence is dropped, in either order', () => {
    // The one case the end-to-end run above cannot produce: everything the host
    // sent had drained before promotion there. Here the host's event with
    // eventSeq 12 was still in flight when it died, and the promoted shadow —
    // continuing from the highest sequence it OBSERVED (spec §5) — assigns 12 to
    // an event of its own. A peer may see them in either order.
    const hostEvent = spinOut(12, 5)
    const shadowEvent = spinOut(12, 2)

    for (const [first, second, expectedKart, ignoredKart] of [
      [shadowEvent, hostEvent, 2, 5],
      [hostEvent, shadowEvent, 5, 2],
    ] as const) {
      const ctx = makeNetContext(false)
      const state = createState(ctx, 0x992, CHARS)
      state.nextEventSeq = 12

      expect(applyEvent(ctx, state, first)).toBe(true)
      expect(state.karts[expectedKart].spinOutTicks).toBe(60)
      expect(state.nextEventSeq).toBe(13)

      // The collision resolves as a DROP, never as a double application: the
      // monotone rule in applyEvent is what makes migration safe. The cost is
      // that one of the two events is lost, which is a stated consequence of
      // "continues eventSeq from the highest it observed" — not a doubled
      // effect, which is what spec §8's clause forbids.
      expect(applyEvent(ctx, state, second)).toBe(false)
      expect(state.karts[ignoredKart].spinOutTicks).toBe(0)
      expect(state.nextEventSeq).toBe(13)
    }
  })

  it('a promoted shadow never assigns a sequence below the highest it applied', () => {
    const ctx = makeNetContext(false)
    const state = createState(ctx, 0x993, CHARS)
    const p = { x: 0, y: 0, z: 0 }
    itemBoxWorldPos(ctx, 0, p)
    state.karts[0].position.x = p.x
    state.karts[0].position.y = p.y
    state.karts[0].position.z = p.z
    state.itemBoxes[0].respawnTicks = 3
    const cap = captureTransport()
    const shadow = new ShadowLoop(ctx, state, cap.transport)
    const drive = driverFor(shadow)

    cap.deliver('host', 'reliable', framed('events', 512, (p2) => encodeEvents(p2, [
      spinOut(40, 1), spinOut(41, 2), spinOut(42, 3),
    ])))
    drive.tick(3)
    expect(state.nextEventSeq).toBe(43)

    shadow.promote(state.tick)
    cap.broadcasts.length = 0
    drive.tick(60)

    const emitted: AuthEvent[] = []
    for (const b of cap.broadcasts) {
      if (b.channel !== 'reliable' || decodeHeader(b.data).kind !== 'events') continue
      const out: AuthEvent[] = []
      decodeEvents(b.data.subarray(2), out)
      emitted.push(...out)
    }
    expect(emitted.length, 'the promoted shadow emitted nothing; this proves nothing').toBeGreaterThan(0)
    let prev = 42
    for (const e of emitted) {
      expect(e.eventSeq, 'a promoted sequence collided with or preceded an applied one').toBeGreaterThan(prev)
      prev = e.eventSeq
    }
  })
})

describe('ShadowLoop: promote() between two ticks', () => {
  it('folds in events already received, so the announced eventSeq is exact', () => {
    // An explicit promote() (the room owner detected host loss some other way)
    // can land between an onMessage and the tick that would have applied it.
    // Dropping those events would both lose the host's last word and understate
    // the authorityChange, leaving the promoted authority free to reissue a
    // sequence a client had already applied.
    const ctx = makeNetContext(false)
    const state = createState(ctx, 0x994, CHARS)
    const cap = captureTransport()
    const shadow = new ShadowLoop(ctx, state, cap.transport)
    const drive = driverFor(shadow)
    drive.tick()
    expect(state.nextEventSeq).toBe(0)

    cap.deliver('host', 'reliable', framed('events', 512, (p) => encodeEvents(p, [
      { eventSeq: 0, tick: 1, kind: 'spinOut', playerId: 1, entityId: -1, item: 'none', data: 60 },
      { eventSeq: 1, tick: 1, kind: 'lapCross', playerId: 2, entityId: -1, item: 'none', data: 1 },
    ])))
    // No tick() in between: promote() sees them still queued.
    shadow.promote(state.tick)

    expect(state.nextEventSeq).toBe(2)
    expect(state.karts[1].spinOutTicks).toBe(60)
    expect(state.karts[2].lap.lap).toBe(1)
    const changes = cap.broadcasts.filter(
      (b) => b.channel === 'reliable' && decodeHeader(b.data).kind === 'authorityChange',
    )
    expect(changes).toHaveLength(1)
    expect(decodeAuthorityChange(changes[0].data).eventSeq).toBe(2)

    // ...and they are not applied a second time by the next tick().
    drive.tick()
    expect(state.nextEventSeq).toBe(2)
    expect(state.karts[1].spinOutTicks).toBe(59)
  })
})

describe('ShadowLoop: every kind is gated on its channel', () => {
  /**
   * This was the ONE loop that took `_channel` and threw it away, and it is the
   * one loop that accepts a `checkpoint` - the single message in this system
   * that replaces the entire state.
   *
   * AuthorityLoop already refuses an `authorityChange` off the unreliable path,
   * with an explicit rationale: "standing down is irreversible, so the one
   * message that triggers it is not accepted off the lossy path where anything
   * at all can arrive." A checkpoint outranks that - it does not change who the
   * authority is, it changes what the world IS - and it had no channel check
   * anywhere. Measured before the fix: a `snapshot` delivered on 'reliable' was
   * accepted and hard-snapped a shadow from tick 1 to 501.
   *
   * Each case below is a pair: the same bytes on the wrong channel and on the
   * right one. Without the second half these would pass against a loop that had
   * simply stopped handling the message.
   */
  const CHECKPOINT_TICK = 700
  const SNAPSHOT_TICK = 500

  function shadowUnderTest(seed: number): { state: SimState; cap: Capture; drive: ReturnType<typeof driverFor> } {
    const ctx = makeNetContext(false)
    const state = createState(ctx, seed, CHARS)
    state.phase = 'racing'
    state.karts[2].isBot = false
    state.karts[2].connected = true
    const cap = captureTransport()
    const shadow = new ShadowLoop(ctx, state, cap.transport)
    return { state, cap, drive: driverFor(shadow) }
  }

  function hostSnapshot(seed: number): Uint8Array {
    const s = createState(makeNetContext(true), seed, CHARS)
    s.phase = 'racing'
    s.tick = SNAPSHOT_TICK
    return framed('snapshot', SNAP_BUF_BYTES, (p) => encodeSnapshot(p, s, new Array(MAX_KARTS).fill(-1)))
  }

  it('ignores a snapshot on the reliable channel and accepts the same bytes on the unreliable one', () => {
    const wrong = shadowUnderTest(0xd01)
    wrong.drive.tick()
    wrong.cap.deliver('host', 'reliable', hostSnapshot(0xd01))
    wrong.drive.tick()
    expect(wrong.state.tick, 'a snapshot on the reliable channel hard-snapped the shadow').toBe(2)

    const right = shadowUnderTest(0xd01)
    right.drive.tick()
    right.cap.deliver('host', 'unreliable', hostSnapshot(0xd01))
    right.drive.tick()
    expect(right.state.tick, 'the control case never landed, so the assertion above proves nothing')
      .toBe(SNAPSHOT_TICK + 1)
  })

  it('ignores a checkpoint on the unreliable channel and accepts the same bytes on the reliable one', () => {
    const cp = (seed: number): Uint8Array => {
      const s = createState(makeNetContext(false), seed, CHARS)
      s.tick = CHECKPOINT_TICK
      s.rngCursor = 4242
      return framed('checkpoint', CHECKPOINT_BUF_BYTES, (p) => encodeCheckpoint(p, s))
    }

    const wrong = shadowUnderTest(0xd02)
    wrong.drive.tick()
    wrong.cap.deliver('host', 'unreliable', cp(0xd02))
    wrong.drive.tick()
    expect(wrong.state.tick, 'a checkpoint off the lossy channel replaced the whole state').toBe(2)
    expect(wrong.state.rngCursor).toBe(0)

    const right = shadowUnderTest(0xd02)
    right.drive.tick()
    right.cap.deliver('host', 'reliable', cp(0xd02))
    right.drive.tick()
    expect(right.state.tick, 'the control case never landed').toBe(CHECKPOINT_TICK + 1)
    expect(right.state.rngCursor).toBe(4242)
  })

  it('ignores events on the unreliable channel and accepts the same bytes on the reliable one', () => {
    const evs: AuthEvent[] = [
      { eventSeq: 0, tick: 1, kind: 'spinOut', playerId: 3, entityId: -1, item: 'none', data: 60 },
    ]
    const frame = (): Uint8Array => framed('events', 512, (p) => encodeEvents(p, evs))

    const wrong = shadowUnderTest(0xd03)
    wrong.cap.deliver('host', 'unreliable', frame())
    wrong.drive.tick()
    expect(wrong.state.karts[3].spinOutTicks, 'an events datagram off the unreliable channel was applied').toBe(0)
    expect(wrong.state.nextEventSeq).toBe(0)

    const right = shadowUnderTest(0xd03)
    right.cap.deliver('host', 'reliable', frame())
    right.drive.tick()
    expect(right.state.karts[3].spinOutTicks, 'the control case never landed').toBe(59)
  })

  it('ignores input on the reliable channel and accepts the same bytes on the unreliable one', () => {
    const window = Array.from({ length: INPUT_REDUNDANCY }, (_, i) => ({
      tick: i * 2, steer: 0, accel: 1, brake: false, drift: false, useItem: false,
    }))
    const frame = (): Uint8Array => framed('input', 256, (p) => encodeInput(p, 2, window))

    const wrong = shadowUnderTest(0xd04)
    wrong.cap.deliver('c2', 'reliable', frame())
    wrong.drive.tick(30)
    expect(
      Math.hypot(wrong.state.karts[2].velocity.x, wrong.state.karts[2].velocity.z),
      'input on the reliable channel drove the kart',
    ).toBeLessThan(0.001)

    const right = shadowUnderTest(0xd04)
    right.cap.deliver('c2', 'unreliable', frame())
    right.drive.tick(30)
    expect(
      Math.hypot(right.state.karts[2].velocity.x, right.state.karts[2].velocity.z),
      'the control case never landed',
    ).toBeGreaterThan(5)
  })
})

describe('ShadowLoop: promotionTickOf (Plan 4 needs the tick, not just the fact)', () => {
  /**
   * Plan 4's hub relays the `authorityChange` and every peer recomputes
   * `promotionCursor(raceSeed, promotionTick)` from it - that recomputability is
   * what makes the PRNG re-seed safe (ruling P2-R14). None of it works if the
   * tick lives only in a private field.
   *
   * Read ACROSS THE TRANSITION rather than once afterwards: a single read after
   * promotion cannot tell a real value from a coincidence, and a value that
   * drifted on later ticks would still satisfy it.
   */
  it('is -1 while following, exactly the promotion tick after, and never moves again', () => {
    const ctx = makeNetContext(false)
    const state = createState(ctx, 0xd10, CHARS)
    const cap = captureTransport()
    const shadow = new ShadowLoop(ctx, state, cap.transport)
    const drive = driverFor(shadow)

    // Following: no host has been heard from, but the timeout has not elapsed.
    for (let t = 0; t < HOST_TIMEOUT_TICKS; t++) {
      drive.tick()
      expect(promotionTickOf(shadow), `promotionTickOf moved at follower tick ${state.tick}`).toBe(-1)
    }

    // The tick the timeout fires on.
    drive.tick()
    const at = promotionTickOf(shadow)
    expect(at, 'promotionTickOf is still -1 after the loop promoted itself').not.toBe(-1)
    // tick() calls promote(this.live.tick) after stepping, so the promotion tick
    // is this loop's own tick at that moment - stated as the arithmetic rather
    // than as a magic number.
    expect(at).toBe(HOST_TIMEOUT_TICKS + 1)

    // ...and it is exactly what went out on the wire. This is the property Plan 4
    // depends on: a peer recomputing the cursor from the message must land on the
    // number this loop used.
    const changes = cap.broadcasts.filter(
      (b) => b.channel === 'reliable' && decodeHeader(b.data).kind === 'authorityChange',
    )
    expect(changes).toHaveLength(1)
    expect(decodeAuthorityChange(changes[0].data).tick, 'the published tick and the broadcast one disagree').toBe(at)
    expect(state.rngCursor, 'the re-seed used a different tick from the one it published')
      .toBe(promotionCursor(state.raceSeed, at))

    // Unchanged forever after.
    for (let t = 0; t < 120; t++) {
      drive.tick()
      expect(promotionTickOf(shadow), `promotionTickOf drifted at tick ${state.tick}`).toBe(at)
    }
  })

  it('reports an explicit promote()\'s own argument, not the loop\'s tick', () => {
    // promote(tick) takes the tick as an argument precisely so a room that
    // detected host loss some other way can name the instant. Whatever it names
    // is what every peer will recompute the cursor from, so that is what this
    // publishes.
    const ctx = makeNetContext(false)
    const state = createState(ctx, 0xd11, CHARS)
    const cap = captureTransport()
    const shadow = new ShadowLoop(ctx, state, cap.transport)
    const drive = driverFor(shadow)
    drive.tick(10)
    expect(promotionTickOf(shadow)).toBe(-1)

    shadow.promote(7)
    expect(promotionTickOf(shadow)).toBe(7)
    expect(decodeAuthorityChange(cap.broadcasts[0].data).tick).toBe(7)

    // A second promote() is a no-op, so it cannot rewrite the published tick.
    shadow.promote(99)
    expect(promotionTickOf(shadow), 'a second promote() overwrote the published tick').toBe(7)
  })

  it('stays -1 for a loop that was the leader from construction', () => {
    // "Was promoted at tick T" and "has been the leader all along" are different
    // facts. A loop born leader never ran promote(), so its rngCursor came from
    // createState and there is no promotion cursor for any peer to recompute.
    const ctx = makeNetContext(true)
    const state = createState(ctx, 0xd12, CHARS)
    const shadow = new ShadowLoop(ctx, state, captureTransport().transport)
    driverFor(shadow).tick(5)
    expect(promotionTickOf(shadow)).toBe(-1)
  })
})
