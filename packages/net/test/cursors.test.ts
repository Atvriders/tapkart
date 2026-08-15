import { describe, expect, it } from 'vitest'
import type { AuthEvent, Intent, SimState } from '@tapkart/sim'
import { MAX_KARTS, createState } from '@tapkart/sim'
import type { ChannelName } from '@tapkart/protocol'
import {
  INPUT_REDUNDANCY,
  encodeEvents,
  encodeHeader,
  encodeInput,
  encodeSnapshot,
} from '@tapkart/protocol'
import type { Transport } from '../src/transport'
import { AuthorityLoop } from '../src/authority'
import { ClientLoop, makeRemoteSample, remoteInterpolatorOf } from '../src/client'
import { HOST_TIMEOUT_MS, ShadowLoop, decodeAuthorityChange } from '../src/shadow'
import { TICK_MS } from '../src/clock'
import {
  MAX_CURSOR_ADVANCE_EVENTS,
  MAX_CURSOR_ADVANCE_TICKS,
  MAX_WIRE_TICK,
  droppedDatagramsOf,
} from '../src/receive'
import { makeNetContext } from './fixtures/net-fixtures'

/**
 * THE WIRE CURSOR.
 *
 * Every loop in this package holds monotonic cursors taken straight off the
 * wire - the highest snapshot tick it has seen, the newest input tick per seat,
 * the highest event sequence number it has applied - and each one exists to
 * REJECT STALE TRAFFIC. That makes each of them a one-way ratchet, and a
 * ratchet driven from a public socket is a ratchet a sender can jam.
 *
 * This is the same defect class as the enum holes that packages/protocol/test/
 * enum-codes.test.ts audits, seen from the one angle a per-field enum audit
 * cannot: the poisoned value here is a perfectly well-formed u32, so no decoder
 * can object to it. And the failure is strictly worse. An enum hole was
 * per-datagram and self-healing - one bad frame, one bad field, gone by the next
 * snapshot. A poisoned cursor is PERMANENT, and there is no repair path anywhere
 * in this design: nothing lowers a cursor, so every legitimate datagram for the
 * rest of the race sorts below it and is discarded, silently, with no counter
 * moving anywhere.
 *
 * Each test below therefore asserts three things and not one:
 *   1. the poisoned datagram is DROPPED AND COUNTED,
 *   2. no byte of loop state moved, and
 *   3. A VALID DATAGRAM DELIVERED IMMEDIATELY AFTERWARDS IS STILL PROCESSED.
 * The third clause is the one that catches a guard which drops the bad frame and
 * then wedges the loop by some other route - which is the failure being fixed,
 * reintroduced by its own fix.
 */

const CHARS = [0, 1, 2, 3, 4, 5, 6, 7]
const CHARS8 = [0, 0, 0, 0, 0, 0, 0, 0]
const SNAP_BUF_BYTES = 1024

/** The largest u32. This is the value that wedges a 32-bit wire cursor, and it
 * is what every "poisoned" datagram below carries. */
const U32_MAX = 4294967295

interface Capture {
  transport: Transport
  broadcasts: { channel: ChannelName; data: Uint8Array }[]
  deliver(peerId: string, channel: ChannelName, data: Uint8Array): void
}

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

function framed(
  kind: 'input' | 'snapshot' | 'events',
  size: number,
  writePayload: (payload: Uint8Array) => number,
): Uint8Array {
  const buf = new Uint8Array(size)
  const h = encodeHeader(buf, kind)
  const n = writePayload(buf.subarray(h))
  return buf.subarray(0, h + n)
}

function driverFor(shadow: ShadowLoop, startMs = 0): { tick(n?: number): void } {
  let ms = startMs
  return {
    tick(n = 1): void {
      for (let i = 0; i < n; i++) {
        shadow.tick(ms)
        ms += TICK_MS
      }
    },
  }
}

function racingState(seed: number, humanSeat: number, characterIdx: number[] = CHARS): SimState {
  const state = createState(makeNetContext(false), seed, characterIdx)
  state.phase = 'racing'
  state.karts[humanSeat].isBot = false
  state.karts[humanSeat].connected = true
  return state
}

/** A host-side SimState at `tick`, for building snapshot frames by hand. */
function hostStateAt(tick: number, eventSeq = 0): SimState {
  const s = createState(makeNetContext(true), 0x5c5, CHARS8)
  s.phase = 'racing'
  s.tick = tick
  s.nextEventSeq = eventSeq
  return s
}

const NO_INPUT_YET = new Array(MAX_KARTS).fill(-1) as number[]

function snapshotFrame(state: SimState): Uint8Array {
  return framed('snapshot', SNAP_BUF_BYTES, (p) => encodeSnapshot(p, state, NO_INPUT_YET))
}

/** An 8-entry input window whose NEWEST intent is at `newestTick`, 2 ticks
 * apart, exactly as ClientLoop's own send window is built. */
function inputWindow(newestTick: number, accel: number, brake = false): Intent[] {
  const out: Intent[] = []
  for (let i = 0; i < INPUT_REDUNDANCY; i++) {
    out.push({
      tick: newestTick - (INPUT_REDUNDANCY - 1 - i) * 2,
      steer: 0,
      accel,
      brake,
      drift: false,
      useItem: false,
    })
  }
  return out
}

function inputFrame(playerId: number, intents: Intent[]): Uint8Array {
  return framed('input', 256, (p) => encodeInput(p, playerId, intents))
}

function eventFrame(events: AuthEvent[]): Uint8Array {
  return framed('events', 512, (p) => encodeEvents(p, events))
}

// ---------------------------------------------------------------------------
// The bounds themselves
// ---------------------------------------------------------------------------

describe('the cursor bounds are derived from the protocol, not chosen', () => {
  it('bounds a tick jump at the host-loss budget plus the two flights it spans', () => {
    // 1.5s of silence is the point at which this system stops believing in a
    // peer at all (spec §5, and HOST_TIMEOUT_MS is that number), which at 60Hz
    // is 90 ticks. One worst-case one-way transit (150ms latency + 50ms jitter =
    // 200ms = 12 ticks, the figure SHADOW_HISTORY_TICKS is also derived from) is
    // allowed for EACH of the two flights a jump spans: the datagram that set
    // the receiver's cursor, and the datagram now being judged.
    const silenceTicks = Math.ceil(HOST_TIMEOUT_MS / TICK_MS)
    expect(silenceTicks).toBe(90)
    expect(MAX_CURSOR_ADVANCE_TICKS).toBe(silenceTicks + 2 * 12)
    expect(MAX_CURSOR_ADVANCE_TICKS).toBe(114)
    // Which is, at the two rates the protocol actually runs at: 38 consecutive
    // lost snapshots, or 57 consecutive lost input datagrams.
    expect(Math.floor(MAX_CURSOR_ADVANCE_TICKS / 3)).toBe(38)
    expect(Math.floor(MAX_CURSOR_ADVANCE_TICKS / 2)).toBe(57)
  })

  it('caps a wire tick at the largest one the format can describe', () => {
    // WireSnapshot carries lastProcessedInputTick per seat in 16 bits, biased by
    // +1, so 65534 is the largest real input tick this protocol can express - a
    // snapshot claiming a tick past that describes a race its own header cannot.
    expect(MAX_WIRE_TICK).toBe(2 ** 16 - 2)
    expect(MAX_WIRE_TICK).toBeLessThan(U32_MAX)
  })

  it('bounds an eventSeq jump at the tick budget times a per-tick event ceiling', () => {
    // One event of each of the 8 AuthEventKinds for each of the 8 kart seats and
    // 32 entity slots. Generous by construction, and five orders of magnitude
    // below the value that wedges the counter.
    expect(MAX_CURSOR_ADVANCE_EVENTS).toBe(MAX_CURSOR_ADVANCE_TICKS * (8 + 32) * 8)
    expect(MAX_CURSOR_ADVANCE_EVENTS).toBeLessThan(U32_MAX / 1000)
  })
})

// ---------------------------------------------------------------------------
// ClientLoop
// ---------------------------------------------------------------------------

describe('ClientLoop — a poisoned event sequence number', () => {
  const OWN = 4

  const lapCross = (eventSeq: number, lap: number): AuthEvent => ({
    eventSeq, tick: 1, kind: 'lapCross', playerId: OWN, entityId: -1, item: 'none', data: lap,
  })

  it('drops it, counts it, moves nothing, and still applies the next real event', () => {
    const cap = captureTransport()
    const client = new ClientLoop(makeNetContext(false), OWN, cap.transport)

    // The control: this loop really does apply events off the wire, so every
    // assertion below is about a mechanism that works.
    expect(client.state().karts[OWN].lap.lap).toBe(0)
    expect(client.state().nextEventSeq).toBe(0)

    cap.deliver('host', 'reliable', eventFrame([lapCross(U32_MAX, 3)]))

    // 1. Dropped and counted.
    expect(droppedDatagramsOf(client), 'the poisoned eventSeq was not counted as a drop').toBe(1)
    // 2. Nothing moved - not the counter it would have ratcheted, not the lap
    //    the event claimed. Before the guard this read 4294967296.
    expect(client.state().nextEventSeq, 'the poisoned eventSeq reached the counter').toBe(0)
    expect(client.state().karts[OWN].lap.lap).toBe(0)

    // 3. And the very next legitimate event is still processed. THIS is the
    //    clause the defect fails: with nextEventSeq pinned at 4294967296,
    //    applyEvent's `ev.eventSeq < state.nextEventSeq` discarded this and
    //    every later event for the rest of the race, leaving lap at 0 forever.
    cap.deliver('host', 'reliable', eventFrame([lapCross(0, 1)]))
    expect(client.state().karts[OWN].lap.lap, 'a legitimate event after the poisoned one was swallowed').toBe(1)
    expect(client.state().nextEventSeq).toBe(1)
    expect(droppedDatagramsOf(client), 'the good datagram was miscounted').toBe(1)
  })

  it('rejects the whole batch rather than applying the events ahead of the bad one', () => {
    const cap = captureTransport()
    const client = new ClientLoop(makeNetContext(false), OWN, cap.transport)

    // Two perfectly good events, then a poisoned one, in a single datagram.
    cap.deliver('host', 'reliable', eventFrame([lapCross(0, 1), lapCross(1, 2), lapCross(U32_MAX, 3)]))

    expect(droppedDatagramsOf(client)).toBe(1)
    expect(client.state().karts[OWN].lap.lap, 'the good half of a rejected batch was applied').toBe(0)
    expect(client.state().nextEventSeq).toBe(0)
  })
})

describe('ClientLoop — a poisoned snapshot tick', () => {
  const OWN = 4
  const REMOTE = 1
  const mkIntent = (): Intent => ({ tick: 0, steer: 0, accel: 1, brake: false, drift: false, useItem: false })

  it('drops it, counts it, and still reconciles against the next real snapshot', () => {
    const cap = captureTransport()
    const client = new ClientLoop(makeNetContext(false), OWN, cap.transport)
    client.tick(mkIntent())

    const sample = makeRemoteSample()
    const ri = remoteInterpolatorOf(client)
    expect(ri.sampleKart(REMOTE, 0, sample), 'a keyframe existed before any snapshot arrived').toBe(false)

    cap.deliver('host', 'unreliable', snapshotFrame(hostStateAt(U32_MAX)))

    // 1 and 2: counted, and not one keyframe pushed - the interpolator is the
    // only source a renderer has for remote karts, so a snapshot that reached it
    // reached the screen.
    expect(droppedDatagramsOf(client), 'the poisoned snapshot tick was not counted as a drop').toBe(1)
    expect(ri.sampleKart(REMOTE, 0, sample), 'a rejected snapshot was buffered for the renderer').toBe(false)

    // 3. A real snapshot right afterwards still lands, corrects, and feeds the
    //    renderer. Before the guard, highestSeenSnapshotTick sat at 4294967295
    //    and 60 consecutive legitimate snapshots produced 0 corrections and 0
    //    keyframes: a guest frozen with a dead render feed.
    const host = hostStateAt(40)
    host.karts[OWN].position.x += 25 // far past EPS.position: a guaranteed correction
    cap.deliver('host', 'unreliable', snapshotFrame(host))
    client.tick(mkIntent())

    expect(client.corrections(), 'the client never reconciled against the snapshot after the poisoned one').toBeGreaterThan(0)
    expect(client.state().tick, 'hardResync never adopted the authority tick').toBe(40)
    expect(ri.sampleKart(REMOTE, client.state().tick * TICK_MS, sample)).toBe(true)
    expect(droppedDatagramsOf(client)).toBe(1)
  })

  it('accepts a jump of exactly MAX_CURSOR_ADVANCE_TICKS and refuses one tick more', () => {
    // The bound itself, at its own boundary, through the real loop. Without this
    // the two tests above would pass against any bound at all, including one so
    // tight it refuses the promotion handover.
    const at = (jump: number): ClientLoop => {
      const cap = captureTransport()
      const c = new ClientLoop(makeNetContext(false), OWN, cap.transport)
      c.tick(mkIntent())
      // Seed the cursor at tick 10, so the second frame is a measured jump from
      // a real anchor rather than from the -1 "nothing adopted yet" sentinel.
      cap.deliver('host', 'unreliable', snapshotFrame(hostStateAt(10)))
      c.tick(mkIntent())
      expect(droppedDatagramsOf(c), 'the seeding snapshot was rejected').toBe(0)
      cap.deliver('host', 'unreliable', snapshotFrame(hostStateAt(10 + jump)))
      return c
    }
    expect(droppedDatagramsOf(at(MAX_CURSOR_ADVANCE_TICKS))).toBe(0)
    expect(droppedDatagramsOf(at(MAX_CURSOR_ADVANCE_TICKS + 1))).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// AuthorityLoop
// ---------------------------------------------------------------------------

describe('AuthorityLoop — a poisoned input tick', () => {
  const SEAT = 2

  it('drops it, counts it, and still holds the next real input for that seat', () => {
    const ctx = makeNetContext(true)
    const state = racingState(0xc1, SEAT)
    const cap = captureTransport()
    const authority = new AuthorityLoop(ctx, state, cap.transport)

    // The control: real input, really driving.
    cap.deliver('c2', 'unreliable', inputFrame(SEAT, inputWindow(0, 1)))
    for (let i = 0; i < 30; i++) authority.tick()
    const drivingSpeed = Math.hypot(state.karts[SEAT].velocity.x, state.karts[SEAT].velocity.z)
    expect(drivingSpeed, 'the seat never got moving, so the assertions below prove nothing').toBeGreaterThan(5)

    // The poison: full throttle at a tick 4 billion in the future.
    cap.deliver('c2', 'unreliable', inputFrame(SEAT, inputWindow(U32_MAX, 1)))
    expect(droppedDatagramsOf(authority), 'the poisoned input tick was not counted as a drop').toBe(1)

    // 3. The seat's own next datagram still reaches it - full brake, an intent
    //    no bot produces. Before the guard, heldIntentTick[SEAT] was pinned at
    //    4294967295 and this datagram (and every later one from this player) was
    //    discarded by `it.tick > this.heldIntentTick[playerId]`, leaving the seat
    //    driving the poisoned intent for the rest of the race.
    cap.deliver('c2', 'unreliable', inputFrame(SEAT, inputWindow(state.tick, 0, true)))
    for (let i = 0; i < 60; i++) authority.tick()
    const brakedSpeed = Math.hypot(state.karts[SEAT].velocity.x, state.karts[SEAT].velocity.z)
    expect(brakedSpeed, 'the input after the poisoned one was swallowed; the seat is still at throttle').toBeLessThan(1)
    expect(droppedDatagramsOf(authority)).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// ShadowLoop
// ---------------------------------------------------------------------------

describe('ShadowLoop — poisoned host cursors', () => {
  it('drops a poisoned snapshot tick, counts it, and still follows the next real one', () => {
    const ctx = makeNetContext(false)
    const state = createState(ctx, 0x5d1, CHARS)
    const cap = captureTransport()
    const shadow = new ShadowLoop(ctx, state, cap.transport)
    const drive = driverFor(shadow)

    // Seeded first: lastSnapshotTick has to be a real cursor for the relative
    // bound to be what is under test here (the unseeded window is its own test).
    // tick() reconciles at the TOP and steps afterwards, so a snapshot for tick
    // T leaves this loop on T + 1. Every figure below is that, not an off-by-one.
    cap.deliver('host', 'unreliable', snapshotFrame(hostStateAt(30)))
    drive.tick()
    expect(state.tick, 'the seeding snapshot never landed').toBe(31)

    cap.deliver('host', 'unreliable', snapshotFrame(hostStateAt(U32_MAX)))
    drive.tick()
    expect(droppedDatagramsOf(shadow), 'the poisoned snapshot tick was not counted as a drop').toBe(1)
    expect(state.tick, 'a snapshot 4 billion ticks in the future moved the shadow').toBe(32)

    cap.deliver('host', 'unreliable', snapshotFrame(hostStateAt(60)))
    drive.tick()
    expect(state.tick, 'the snapshot after the poisoned one was swallowed').toBe(61)
    expect(droppedDatagramsOf(shadow)).toBe(1)
  })

  it('drops a poisoned eventSeq in a snapshot header without raising its floor', () => {
    // eventSeqFloor is what a promoted shadow continues its own numbering from
    // (spec §5). Poisoned, the promoted authority announces a sequence number no
    // client can ever exceed, and every event it emits afterwards is ignored by
    // the whole room - the exact failure the floor was added to fix, inverted.
    const ctx = makeNetContext(false)
    const state = createState(ctx, 0x5d2, CHARS)
    const cap = captureTransport()
    const shadow = new ShadowLoop(ctx, state, cap.transport)
    const drive = driverFor(shadow)

    cap.deliver('host', 'unreliable', snapshotFrame(hostStateAt(5, U32_MAX)))
    drive.tick()
    expect(droppedDatagramsOf(shadow), 'the poisoned eventSeq was not counted as a drop').toBe(1)
    // The whole datagram was refused, so its tick did not land either.
    expect(state.tick, 'a datagram rejected for its eventSeq still moved the tick').toBe(1)

    // A real host counter afterwards still raises the floor.
    cap.deliver('host', 'unreliable', snapshotFrame(hostStateAt(5, 100)))
    drive.tick()
    shadow.promote(state.tick)
    const announcement = cap.broadcasts.find((b) => b.channel === 'reliable')
    expect(announcement, 'the shadow never announced its promotion').toBeDefined()
    const announced = decodeAuthorityChange(announcement!.data).eventSeq
    expect(announced, 'the floor never took the real host counter').toBeGreaterThanOrEqual(100)
    expect(announced, 'the poisoned counter reached the announcement').toBeLessThan(U32_MAX)
  })

  it('drops a poisoned event batch and still applies the next real one', () => {
    const ctx = makeNetContext(false)
    const state = createState(ctx, 0x5d3, CHARS)
    const cap = captureTransport()
    const shadow = new ShadowLoop(ctx, state, cap.transport)
    const drive = driverFor(shadow)

    const spinOut = (eventSeq: number): AuthEvent => ({
      eventSeq, tick: 0, kind: 'spinOut', playerId: 2, entityId: -1, item: 'none', data: 60,
    })

    cap.deliver('host', 'reliable', eventFrame([spinOut(U32_MAX)]))
    drive.tick()
    expect(droppedDatagramsOf(shadow)).toBe(1)
    expect(state.nextEventSeq, 'the poisoned eventSeq reached the counter').toBe(0)
    expect(state.karts[2].spinOutTicks).toBe(0)

    cap.deliver('host', 'reliable', eventFrame([spinOut(0)]))
    drive.tick()
    expect(state.karts[2].spinOutTicks, 'the event after the poisoned one was swallowed').toBe(59)
  })

  it('drops a poisoned input tick and still holds the next real input', () => {
    const ctx = makeNetContext(false)
    const state = racingState(0x5d4, 2)
    const cap = captureTransport()
    const shadow = new ShadowLoop(ctx, state, cap.transport)
    const drive = driverFor(shadow)

    cap.deliver('c2', 'unreliable', inputFrame(2, inputWindow(0, 1)))
    drive.tick(30)
    expect(Math.hypot(state.karts[2].velocity.x, state.karts[2].velocity.z)).toBeGreaterThan(5)

    cap.deliver('c2', 'unreliable', inputFrame(2, inputWindow(U32_MAX, 1)))
    expect(droppedDatagramsOf(shadow)).toBe(1)

    // 30 ticks, not 60: this loop hears no snapshots at all, so it promotes
    // itself at the 90-tick host-loss timeout and starts rolling items. The
    // measurement stops short of that on purpose - what is under test is whether
    // the seat's input still reaches the sim, not what a promoted leader does.
    cap.deliver('c2', 'unreliable', inputFrame(2, inputWindow(state.tick, 0, true)))
    drive.tick(30)
    expect(
      Math.hypot(state.karts[2].velocity.x, state.karts[2].velocity.z),
      'the input after the poisoned one was swallowed',
    ).toBeLessThan(1)
  })

  it('refuses a poisoned FIRST snapshot without refusing a real late join', () => {
    // The one window the relative bound cannot cover: a loop that has adopted
    // nothing has no cursor to measure against, and ShadowLoop's late join is a
    // designed path through exactly that window (latejoin.test.ts). The absolute
    // bound is what stands there - a first snapshot claiming a tick this format
    // cannot even express is refused, and a first snapshot 400 ticks into a real
    // race is not.
    const poisonedFirst = (): { shadow: ShadowLoop; state: SimState; cap: Capture } => {
      const ctx = makeNetContext(false)
      const state = createState(ctx, 0x5d5, CHARS)
      const cap = captureTransport()
      return { shadow: new ShadowLoop(ctx, state, cap.transport), state, cap }
    }

    const a = poisonedFirst()
    const driveA = driverFor(a.shadow)
    a.cap.deliver('host', 'unreliable', snapshotFrame(hostStateAt(U32_MAX)))
    driveA.tick()
    expect(droppedDatagramsOf(a.shadow), 'a poisoned first snapshot was accepted').toBe(1)
    expect(a.state.tick).toBe(1)
    // ...and the joiner is not wedged: the next real snapshot still seats it.
    // 401, not 400: tick() reconciles at the top and steps afterwards.
    a.cap.deliver('host', 'unreliable', snapshotFrame(hostStateAt(400)))
    driveA.tick()
    expect(a.state.tick, 'a fresh joiner was wedged by one poisoned first datagram').toBe(401)

    const b = poisonedFirst()
    const driveB = driverFor(b.shadow)
    b.cap.deliver('host', 'unreliable', snapshotFrame(hostStateAt(400)))
    driveB.tick()
    expect(droppedDatagramsOf(b.shadow), 'a legitimate late join was refused').toBe(0)
    expect(b.state.tick).toBe(401)
  })
})
