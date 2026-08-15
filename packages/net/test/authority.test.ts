import { describe, expect, it } from 'vitest'
import type { AuthEvent, Intent } from '@tapkart/sim'
import { COUNTDOWN_TICKS, MAX_ENTITIES, MAX_KARTS, createState, itemBoxWorldPos } from '@tapkart/sim'
import type { Transport } from '../src/transport'
import type { ChannelName, WireEntity, WireKart, WireSnapshot } from '@tapkart/protocol'
import { decodeEvents, decodeHeader, decodeSnapshot, encodeHeader, encodeInput } from '@tapkart/protocol'
import { AuthorityLoop, isDemoted } from '../src/authority'
import { AUTHORITY_CHANGE_BYTES, encodeAuthorityChange } from '../src/shadow'
import { makeLossyPair, makeNetContext } from './fixtures/net-fixtures'

const CHARS = [0, 0, 0, 0, 0, 0, 0, 0]

/** encodeHeader writes tag + protocolVersion; locked contract §3 fixes it at 2. */
const HEADER_BYTES = 2

/** Sends one input datagram the way a real ClientLoop does: shared header, then
 * the payload. Every test below goes through this rather than hand-assembling
 * bytes, so a header change breaks one place, not six. */
function sendInput(t: Transport, playerId: number, intents: Intent[]): void {
  const buf = new Uint8Array(256)
  const h = encodeHeader(buf, 'input')
  const n = encodeInput(buf.subarray(h), playerId, intents)
  t.broadcast('unreliable', buf.slice(0, h + n))
}

/** decodeSnapshot writes into an already-shaped destination, same convention
 * as cloneState — these three build one. */
function makeWireKart(): WireKart {
  return {
    playerId: 0, position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 },
    heading: 0, angularVelocity: 0, driftCharge: 0, driftActive: false, driftDir: 0,
    airborne: false, surface: 'tarmac', spinOutTicks: 0, invulnTicks: 0, item: 'none',
    lap: 0, checkpointIdx: 0, t: 0, isBot: false, connected: false,
    boostTicks: 0, respawnTicks: 0, shielded: false,
  }
}

function makeWireEntity(): WireEntity {
  return {
    entityId: -1, kind: 'seeker', ownerId: -1,
    position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, heading: 0, ttl: 0,
  }
}

function makeWireSnapshot(): WireSnapshot {
  const karts: WireKart[] = []
  for (let i = 0; i < MAX_KARTS; i++) karts.push(makeWireKart())
  const entities: WireEntity[] = []
  for (let i = 0; i < MAX_ENTITIES; i++) entities.push(makeWireEntity())
  return {
    tick: 0, eventSeq: 0, phase: 'countdown',
    lastProcessedInputTick: new Array(MAX_KARTS).fill(-1),
    karts, entities, entityCount: 0,
  }
}

describe('AuthorityLoop — bare ticking', () => {
  it('mutates the exact state object the constructor received, tick by tick', () => {
    const ctx = makeNetContext(true)
    const state = createState(ctx, 0, CHARS)
    state.karts[0].isBot = false
    state.karts[0].connected = true
    const pair = makeLossyPair({ latencyMs: 1, jitterMs: 0, lossRate: 0, seed: 1 })
    const authority = new AuthorityLoop(ctx, state, pair.a)

    expect(state.tick).toBe(0)
    authority.tick()
    expect(state.tick).toBe(1)
    authority.tick()
    expect(state.tick).toBe(2)
  })

  it('state() returns the same live SimState the constructor was handed, on every tick', () => {
    const ctx = makeNetContext(true)
    const state = createState(ctx, 0, CHARS)
    state.phase = 'racing'
    state.karts[0].isBot = false
    state.karts[0].connected = true
    const pair = makeLossyPair({ latencyMs: 1, jitterMs: 0, lossRate: 0, seed: 1 })
    const authority = new AuthorityLoop(ctx, state, pair.a)

    // Identity, not a copy: contract §5 calls state() a "read-only view".
    expect(authority.state()).toBe(state)
    // And it stays current across many ticks — the accessor must not hand back
    // a stale snapshot taken at construction (the failure mode a getter that
    // captured `{...state}` would have).
    for (let i = 1; i <= 30; i++) {
      authority.tick()
      expect(authority.state().tick).toBe(i)
    }
    expect(authority.state().karts[0].position.x).toBe(state.karts[0].position.x)
  })

  it('transitions countdown to racing on the tick that reaches COUNTDOWN_TICKS, not after it', () => {
    const ctx = makeNetContext(true)
    const state = createState(ctx, 0, CHARS)
    state.karts[0].isBot = false
    state.karts[0].connected = true
    const pair = makeLossyPair({ latencyMs: 1, jitterMs: 0, lossRate: 0, seed: 1 })
    const authority = new AuthorityLoop(ctx, state, pair.a)

    expect(state.phase).toBe('countdown')
    for (let i = 0; i < COUNTDOWN_TICKS - 1; i++) authority.tick()
    expect(state.tick).toBe(COUNTDOWN_TICKS - 1)
    expect(state.phase).toBe('countdown')

    authority.tick()
    expect(state.tick).toBe(COUNTDOWN_TICKS)
    expect(state.phase).toBe('racing')   // flips within the same step that produces tick 180
  })
})

describe('AuthorityLoop — the 30Hz-into-60Hz input hold', () => {
  it('holds the newest known intent, applies it across the pair, repeats it over a gap, and advances lastProcessedInputTick as later datagrams arrive', () => {
    const ctx = makeNetContext(true)
    const state = createState(ctx, 0, CHARS)
    state.phase = 'racing'
    state.karts[3].isBot = false
    state.karts[3].connected = true
    const pair = makeLossyPair({ latencyMs: 1, jitterMs: 0, lossRate: 0, seed: 1 })
    const authority = new AuthorityLoop(ctx, state, pair.a)

    let latest: WireSnapshot | null = null
    let taggedSnapshots = 0
    pair.b.onMessage((_peerId, channel, data) => {
      if (channel !== 'unreliable') return
      // Dispatch on the shared header, never on a bare first byte: this side of
      // the pair carries snapshots now and would carry other kinds in the
      // deployed topology. decodeHeader throws on an unknown tag, so a loop
      // that forgot to write the header fails here loudly rather than decoding
      // a snapshot's tick field as if it were a message kind.
      if (decodeHeader(data).kind !== 'snapshot') return
      taggedSnapshots++
      const snap = makeWireSnapshot()
      decodeSnapshot(data.subarray(HEADER_BYTES), snap)
      if (latest === null || snap.tick > latest.tick) latest = snap
    })

    let nowMs = 0
    const frame = (): void => {
      authority.tick()
      pair.pump(nowMs)
      nowMs += 1000 / 60
    }

    const mkIntents = (startTick: number): Intent[] =>
      Array.from({ length: 8 }, (_, i) => ({
        tick: startTick + i * 2, steer: 0.5, accel: 1, brake: false, drift: false, useItem: false,
      }))

    sendInput(pair.b, 3, mkIntents(0))   // ticks 0,2,...,14
    for (let i = 0; i < 20; i++) frame()

    expect(latest).not.toBeNull()
    expect(taggedSnapshots).toBeGreaterThan(0)   // the snapshots really carried the shared header
    expect(latest!.lastProcessedInputTick[3]).toBe(14)
    const xAfterFirst = state.karts[3].position.x
    expect(xAfterFirst).not.toBe(0)   // the held intent was actually applied to physics

    sendInput(pair.b, 3, mkIntents(16))  // ticks 16,18,...,30
    for (let i = 0; i < 20; i++) frame()

    expect(latest!.lastProcessedInputTick[3]).toBe(30)
    expect(state.karts[3].position.x).toBeGreaterThan(xAfterFirst)   // kept moving, still forward
  })

  it('ignores an unreliable datagram that is not an input message', () => {
    const ctx = makeNetContext(true)
    const state = createState(ctx, 0, CHARS)
    state.phase = 'racing'
    state.karts[3].isBot = false
    state.karts[3].connected = true
    const pair = makeLossyPair({ latencyMs: 1, jitterMs: 0, lossRate: 0, seed: 1 })
    const authority = new AuthorityLoop(ctx, state, pair.a)

    // A second authority's snapshot on the same channel — exactly what a
    // promoted ShadowLoop broadcasts at a host that has not noticed yet. The
    // host must skip it, not decode it as input. Without header dispatch this
    // reaches decodeInput, which either throws or writes garbage into
    // heldIntent[?] and starts driving somebody's kart.
    const startX = state.karts[3].position.x
    const startZ = state.karts[3].position.z
    const buf = new Uint8Array(1024)
    const h = encodeHeader(buf, 'snapshot')
    pair.b.broadcast('unreliable', buf.slice(0, h + 32))

    let nowMs = 0
    for (let i = 0; i < 10; i++) {
      authority.tick()
      pair.pump(nowMs)
      nowMs += 1000 / 60
    }
    // Kart 3 is connected and not a bot, so with no accepted input it holds a
    // neutral intent (accel 0) and does not move. Any byte of that snapshot
    // mistaken for an intent shows up here as motion.
    expect(state.tick).toBe(10)
    expect(authority.state().karts[3].position.x).toBe(startX)
    expect(authority.state().karts[3].position.z).toBe(startZ)
  })
})

describe('AuthorityLoop — event broadcast', () => {
  it('broadcasts an event on the reliable channel the tick it occurs', () => {
    const ctx = makeNetContext(true)
    const state = createState(ctx, 0, CHARS)
    state.phase = 'racing'   // skip the countdown so the pickup happens tick 1
    state.karts[0].isBot = false
    state.karts[0].connected = true

    // Park kart 0 exactly on item box 0. Verified deterministic against real
    // packages/sim (see this brief's verification note): with raceSeed 0,
    // characterIdx all 0, this produces an itemGrant of item 'bolt' on tick 1.
    const box = { x: 0, y: 0, z: 0 }
    itemBoxWorldPos(ctx, 0, box)
    state.karts[0].position.x = box.x
    state.karts[0].position.z = box.z
    const proj = ctx.query.project(box)
    state.karts[0].position.y = ctx.query.groundHeight(proj.s, proj.lateral)

    const pair = makeLossyPair({ latencyMs: 1, jitterMs: 0, lossRate: 0, seed: 1 })
    const authority = new AuthorityLoop(ctx, state, pair.a)

    const received: AuthEvent[] = []
    pair.b.onMessage((_peerId: string, channel: ChannelName, data: Uint8Array) => {
      if (channel !== 'reliable') return
      expect(decodeHeader(data).kind).toBe('events')
      const out: AuthEvent[] = []
      decodeEvents(data.subarray(HEADER_BYTES), out)
      received.push(...out)
    })

    let nowMs = 0
    for (let i = 0; i < 5; i++) {
      authority.tick()
      pair.pump(nowMs)
      nowMs += 1000 / 60
    }

    const grant = received.find((e) => e.kind === 'itemGrant' && e.playerId === 0)
    expect(grant).toBeDefined()
    expect(grant!.item).toBe('bolt')
    expect(grant!.tick).toBe(1)
    expect(grant!.data).toBe(0)   // box index 0
    expect(state.karts[0].item).toBe('bolt')
  })
})

/**
 * A hand-rolled, minimal Transport for exactly one behaviour: simulating a
 * peer's loss deterministically. LoopbackTransport (Task 12) has no
 * documented way to simulate a disconnect on demand — makeLoopbackPair's
 * contract is only `{ a, b, pump }` — so this task does not guess at one.
 * Everything this test needs is already in the locked Transport interface.
 */
class FakeTransport implements Transport {
  private messageCb: ((peerId: string, channel: ChannelName, data: Uint8Array) => void) | null = null
  private peerLostCb: ((peerId: string) => void) | null = null

  send(): void {}
  broadcast(): void {}
  onMessage(cb: (peerId: string, channel: ChannelName, data: Uint8Array) => void): void {
    this.messageCb = cb
  }
  onPeerLost(cb: (peerId: string) => void): void {
    this.peerLostCb = cb
  }
  peers(): string[] {
    return []
  }
  close(): void {}

  // Test-only, not part of Transport.
  deliver(peerId: string, channel: ChannelName, data: Uint8Array): void {
    this.messageCb?.(peerId, channel, data)
  }
  dropPeer(peerId: string): void {
    this.peerLostCb?.(peerId)
  }
}

describe('AuthorityLoop — bot takeover on peer loss', () => {
  it('a peer lost after sending input has its kart marked disconnected and driven by bot AI', () => {
    const ctx = makeNetContext(true)
    const state = createState(ctx, 0, CHARS)
    state.phase = 'racing'
    state.karts[5].isBot = false
    state.karts[5].connected = true
    const t = new FakeTransport()
    const authority = new AuthorityLoop(ctx, state, t)

    const intents: Intent[] = Array.from({ length: 8 }, (_, i) => ({
      tick: i * 2, steer: 0.3, accel: 1, brake: false, drift: false, useItem: false,
    }))
    // Same shared header as sendInput(), delivered straight into the callback.
    const buf = new Uint8Array(256)
    const h = encodeHeader(buf, 'input')
    const n = encodeInput(buf.subarray(h), 5, intents)
    t.deliver('remote-peer-42', 'unreliable', buf.slice(0, h + n))

    expect(state.karts[5].connected).toBe(true)
    t.dropPeer('remote-peer-42')
    expect(state.karts[5].connected).toBe(false)

    const xBefore = state.karts[5].position.x
    for (let i = 0; i < 120; i++) authority.tick()
    expect(state.karts[5].position.x).not.toBe(xBefore)   // bot AI drove it: no input was ever sent again
  })

  it('dropping a peer that never sent input is a safe no-op', () => {
    const ctx = makeNetContext(true)
    const state = createState(ctx, 0, CHARS)
    const t = new FakeTransport()
    new AuthorityLoop(ctx, state, t)

    const before = JSON.stringify(state.karts)
    expect(() => t.dropPeer('never-seen')).not.toThrow()
    expect(JSON.stringify(state.karts)).toBe(before)
  })
})

/**
 * A recording Transport that decodes and records the `tick` field of every
 * snapshot broadcast on the unreliable channel, in call order. Distinct from
 * FakeTransport above (which only needs onMessage/onPeerLost delivery, never
 * broadcast): this one exists to make the exact set of ticks that triggered a
 * broadcast observable, with no pump()/latency indirection in the way.
 */
class RecordingTransport implements Transport {
  readonly snapshotTicks: number[] = []

  send(): void {}
  broadcast(channel: ChannelName, data: Uint8Array): void {
    if (channel !== 'unreliable') return
    if (decodeHeader(data).kind !== 'snapshot') return
    const snap = makeWireSnapshot()
    decodeSnapshot(data.subarray(HEADER_BYTES), snap)
    this.snapshotTicks.push(snap.tick)
  }
  onMessage(): void {}
  onPeerLost(): void {}
  peers(): string[] {
    return []
  }
  close(): void {}
}

describe('AuthorityLoop — 20Hz snapshot cadence', () => {
  it('broadcasts a snapshot on exactly one tick in three, never on the other two, across many periods', () => {
    // A test that only asserted "at least one snapshot arrived" (as the 30Hz
    // hold test above does, incidentally, via taggedSnapshots > 0) would also
    // pass if AuthorityLoop broadcast on EVERY tick -- that failure mode
    // would not be caught. This test instead records the tick of every single
    // broadcast and compares the full sequence, so "every tick" (31 entries),
    // "every other tick" (16 entries), and "every third tick starting at a
    // wrong phase" all fail this exact-sequence assertion, and only the true
    // 60/20 = 3 cadence starting at tick 3 (the tick counter is 0 before the
    // first tick() call, and the modulo check runs AFTER the tick that
    // produced tick 0 -- i.e. never -- so the first broadcast tick is 3, not
    // 0) produces it.
    const ctx = makeNetContext(true)
    const state = createState(ctx, 0, CHARS)
    state.phase = 'racing'
    state.karts[0].isBot = false
    state.karts[0].connected = true
    const t = new RecordingTransport()
    const authority = new AuthorityLoop(ctx, state, t)

    const TICKS = 31   // > 10 full periods of 3, ending one tick past a broadcast tick (30)
    for (let i = 0; i < TICKS; i++) authority.tick()

    const expected: number[] = []
    for (let tk = 3; tk <= TICKS; tk += 3) expected.push(tk)
    expect(t.snapshotTicks).toEqual(expected)
    expect(t.snapshotTicks.length).toBe(10)   // floor(31 / 3)
    // Confirms the loop is still ticking every 60Hz frame regardless of the
    // 20Hz broadcast gate -- the two cadences are independent.
    expect(state.tick).toBe(TICKS)
  })
})

describe('AuthorityLoop — demotion on a foreign authorityChange (Task 15c item B)', () => {
  /** A transport that records what the loop puts on the wire and can hand it
   * anything a peer might send. */
  function captureTransport(): {
    transport: Transport
    broadcasts: { channel: ChannelName; data: Uint8Array }[]
    deliver(peerId: string, channel: ChannelName, data: Uint8Array): void
  } {
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

  /** The bytes of one input datagram, to be DELIVERED to the loop. The
   * `sendInput` helper at the top of this file broadcasts through the transport,
   * which a capture transport correctly records as traffic the loop emitted -
   * exactly what these tests are counting, so a peer's input has to arrive the
   * way a peer's input actually arrives. */
  function inputDatagram(playerId: number, intents: Intent[]): Uint8Array {
    const buf = new Uint8Array(256)
    const h = encodeHeader(buf, 'input')
    const n = encodeInput(buf.subarray(h), playerId, intents)
    return buf.slice(0, h + n)
  }

  const countKind = (
    broadcasts: { channel: ChannelName; data: Uint8Array }[],
    kind: 'snapshot' | 'events',
  ): number => broadcasts.filter((b) => decodeHeader(b.data).kind === kind).length

  it('stops broadcasting snapshots and events, and keeps stepping its own view', () => {
    // THE case with no path before this task. ShadowLoop.promote() flips
    // isLeader and starts broadcasting, but AuthorityLoop handled only 'input':
    // a host merely unreachable for 1.5s - a backgrounded tab, a tunnel hiccup -
    // came back and resumed broadcasting authoritative snapshots and events on
    // the same channels as the promoted shadow, with its OWN nextEventSeq. Every
    // client still holding that channel then reconciled alternately against two
    // divergent authorities.
    //
    // Ruled: authority never returns to the original host. Exactly one authority
    // at every instant, so no rewind rule is ever needed.
    const ctx = makeNetContext(true)
    const state = createState(ctx, 0x8b, CHARS)
    state.phase = 'racing'
    state.karts[0].isBot = false
    state.karts[0].connected = true
    const cap = captureTransport()
    const authority = new AuthorityLoop(ctx, state, cap.transport)
    expect(isDemoted(authority)).toBe(false)

    // Real input, so this host is genuinely running a race, and enough ticks
    // that snapshots and at least one event are demonstrably flowing.
    cap.deliver('c0', 'unreliable', inputDatagram(0, Array.from({ length: 8 }, (_, i) => ({
      tick: i, steer: 0.2, accel: 1, brake: false, drift: false, useItem: false,
    }))))
    for (let i = 0; i < 90; i++) authority.tick()
    const snapshotsBefore = countKind(cap.broadcasts, 'snapshot')
    const eventsBefore = countKind(cap.broadcasts, 'events')
    expect(snapshotsBefore, 'no snapshots before demotion: the assertion below would be vacuous').toBeGreaterThan(20)
    expect(eventsBefore, 'no events before demotion: the assertion below would be vacuous').toBeGreaterThan(0)
    const tickBefore = state.tick

    // The shadow decided this host was gone and took over.
    const change = new Uint8Array(AUTHORITY_CHANGE_BYTES)
    encodeAuthorityChange(change, tickBefore, state.nextEventSeq)
    cap.deliver('shadow', 'reliable', change)

    expect(isDemoted(authority), 'the host did not stand down').toBe(true)

    // Long enough to cross many snapshot periods and to reach ticks that were
    // producing events a moment ago.
    for (let i = 0; i < 120; i++) authority.tick()

    expect(countKind(cap.broadcasts, 'snapshot'), 'a demoted host is still broadcasting snapshots').toBe(snapshotsBefore)
    expect(countKind(cap.broadcasts, 'events'), 'a demoted host is still broadcasting events').toBe(eventsBefore)
    expect(cap.broadcasts.length, 'a demoted host put SOMETHING on the wire').toBe(snapshotsBefore + eventsBefore)

    // It keeps stepping, so its own view stays live for the render loop and for
    // the ClientLoop a later plan swaps in.
    expect(state.tick).toBe(tickBefore + 120)
    expect(Math.hypot(state.karts[0].velocity.x, state.karts[0].velocity.z)).toBeGreaterThan(1)
  })

  it('stops EMITTING, not just broadcasting: nextEventSeq freezes at demotion', () => {
    // Suppressing the broadcast while still emitting would leave this loop
    // spending sequence numbers the promoted shadow is also spending, and the
    // duplicates would surface the moment anything replayed this host's view.
    const ctx = makeNetContext(true)
    const state = createState(ctx, 0x8c, CHARS)
    state.phase = 'racing'
    for (let i = 0; i < MAX_KARTS; i++) {
      state.karts[i].isBot = true
      state.karts[i].connected = false
    }
    const cap = captureTransport()
    const authority = new AuthorityLoop(ctx, state, cap.transport)
    for (let i = 0; i < 90; i++) authority.tick()
    const seqBefore = state.nextEventSeq
    expect(seqBefore, 'no events had been emitted, so a frozen counter proves nothing').toBeGreaterThan(0)

    const change = new Uint8Array(AUTHORITY_CHANGE_BYTES)
    encodeAuthorityChange(change, state.tick, seqBefore)
    cap.deliver('shadow', 'reliable', change)
    for (let i = 0; i < 240; i++) authority.tick()

    expect(state.nextEventSeq, 'a demoted authority is still issuing event sequence numbers').toBe(seqBefore)
    // The control that makes that freeze meaningful: a SECOND, undemoted
    // authority on the identical seed and inputs keeps emitting across the same
    // span, so the frozen counter is demotion and not a race that simply ran out
    // of events.
    const controlCtx = makeNetContext(true)
    const controlState = createState(controlCtx, 0x8c, CHARS)
    controlState.phase = 'racing'
    for (let i = 0; i < MAX_KARTS; i++) {
      controlState.karts[i].isBot = true
      controlState.karts[i].connected = false
    }
    const controlCap = captureTransport()
    const control = new AuthorityLoop(controlCtx, controlState, controlCap.transport)
    for (let i = 0; i < 330; i++) control.tick()
    expect(controlState.nextEventSeq).toBeGreaterThan(seqBefore)
  })

  it('is one-way and needs no sender identity: an AuthorityLoop never sends one itself', () => {
    // Every authorityChange an AuthorityLoop can receive is by construction
    // foreign - this class has no code path that broadcasts one, and a transport
    // does not loop a broadcast back to its sender. So "did I send this?" needs
    // no answer, and none is stored.
    const ctx = makeNetContext(true)
    const state = createState(ctx, 0x8d, CHARS)
    state.phase = 'racing'
    const cap = captureTransport()
    const authority = new AuthorityLoop(ctx, state, cap.transport)
    for (let i = 0; i < 30; i++) authority.tick()
    expect(cap.broadcasts.every((b) => decodeHeader(b.data).kind !== 'authorityChange')).toBe(true)

    const change = new Uint8Array(AUTHORITY_CHANGE_BYTES)
    encodeAuthorityChange(change, 10, 1)
    cap.deliver('shadow', 'reliable', change)
    expect(isDemoted(authority)).toBe(true)
    const after = cap.broadcasts.length

    // A second announcement (a re-broadcast on the reliable channel, or a third
    // party's) changes nothing, and above all does not un-demote.
    cap.deliver('shadow', 'reliable', change)
    for (let i = 0; i < 30; i++) authority.tick()
    expect(isDemoted(authority)).toBe(true)
    expect(cap.broadcasts.length).toBe(after)

    // Input still arrives from clients that have not switched over yet, and must
    // not resurrect the broadcast path.
    cap.deliver('c3', 'unreliable', inputDatagram(3, Array.from({ length: 8 }, (_, i) => ({
      tick: i, steer: 0, accel: 1, brake: false, drift: false, useItem: false,
    }))))
    for (let i = 0; i < 30; i++) authority.tick()
    expect(cap.broadcasts.length, 'client input restarted a demoted host').toBe(after)
  })

  it('ignores an authorityChange on the unreliable channel', () => {
    // Authority migration rides the reliable channel (spec §5). A datagram
    // claiming it on the unreliable one is not the message this loop stands down
    // for - and standing down is irreversible.
    const ctx = makeNetContext(true)
    const state = createState(ctx, 0x8e, CHARS)
    state.phase = 'racing'
    const cap = captureTransport()
    const authority = new AuthorityLoop(ctx, state, cap.transport)
    const change = new Uint8Array(AUTHORITY_CHANGE_BYTES)
    encodeAuthorityChange(change, 1, 1)
    cap.deliver('someone', 'unreliable', change)
    for (let i = 0; i < 30; i++) authority.tick()
    expect(isDemoted(authority)).toBe(false)
    expect(countKind(cap.broadcasts, 'snapshot')).toBeGreaterThan(0)
  })
})
