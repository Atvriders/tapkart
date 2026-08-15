import { describe, expect, it } from 'vitest'
import type { AuthEvent, EntityKind, Intent, ItemKind, Vec3 } from '@tapkart/sim'
import { COUNTDOWN_TICKS, MAX_ENTITIES, MAX_KARTS, allocStateLike, cloneState, createState as createSimState, makeIntentBuffer as makeSimIntentBuffer, step as simStep, wrapAngle } from '@tapkart/sim'
import type { InputDatagram, WireEntity, WireKart } from '@tapkart/protocol'
import { EPS, decodeHeader, decodeInput, encodeEvents, encodeHeader, encodeSnapshot, quantStep } from '@tapkart/protocol'
import type { Transport } from '../src/transport'
import { AuthorityLoop } from '../src/authority'
import type { RemoteEntitySample, RemoteSample } from '../src/client'
import { REMOTE_EXTRAPOLATE_CAP_MS, REMOTE_INTERP_DELAY_MS, RemoteInterpolator, ClientLoop, correctionDeltaOf, makeRemoteEntitySample, makeRemoteSample, remoteInterpolatorOf } from '../src/client'
import { TICK_MS } from '../src/index'
import { makeLossyPair, makeNetContext } from './fixtures/net-fixtures'

const OWN = 4

/**
 * `sampleKart` / `sampleEntity` in their pre-out-parameter shape, for the
 * interpolation-maths tests below.
 *
 * The real signatures take a caller-owned `out` and return a boolean (a renderer
 * calls them every frame, for every seat and every entity - see RemoteSample).
 * Allocating one per call is exactly what a test may do and a renderer may not,
 * and every call still goes through the real signature, so a change to the
 * interpolation still fails here. The out-parameter CONTRACT itself - "false
 * leaves `out` untouched", "two calls fill one buffer" - is pinned separately,
 * in its own describe block below, rather than being smuggled into these.
 */
function kartSample(ri: RemoteInterpolator, playerId: number, nowMs: number): RemoteSample | null {
  const out = makeRemoteSample()
  return ri.sampleKart(playerId, nowMs, out) ? out : null
}

function entitySample(ri: RemoteInterpolator, entityId: number, nowMs: number): RemoteEntitySample | null {
  const out = makeRemoteEntitySample()
  return ri.sampleEntity(entityId, nowMs, out) ? out : null
}

/** encodeHeader writes tag + protocolVersion; locked contract §3 fixes it at 2. */
const HEADER_BYTES = 2

/** encodeInput quantises steer over [-1, 1] at 8 bits (Task 10), so a value
 * that round-trips is only ever accurate to one step. Asserting a decoded
 * steer to five decimal places would fail on a correct encoder: 0.02 lands on
 * bucket 130 and comes back 0.0196078…, an error of 3.9e-4 against a 5e-6
 * tolerance. Compare against the step instead of a hand-picked digit count. */
const STEER_STEP = quantStep(-1, 1, 8)

function mkIntent(steer: number): Intent {
  return { tick: 0, steer, accel: 1, brake: false, drift: false, useItem: false }
}

function makeInputDatagramTarget(): InputDatagram {
  const intents = []
  for (let i = 0; i < 8; i++) intents.push({ tick: 0, steer: 0, accel: 0, brake: false, drift: false, useItem: false })
  return { playerId: -1, intents }
}

const CHARS8 = [0, 0, 0, 0, 0, 0, 0, 0]

/**
 * Counts the snapshots that actually reached this side of the pair.
 *
 * Registering a second listener alongside ClientLoop's own is legal and does
 * not displace it: makeLoopbackPair (Task 12) keeps an array of callbacks per
 * side and invokes every one of them (`messageCbs.push(cb)` in its `onMessage`,
 * `for (const cb of cbs)` in its `pump`). Verified by reading Task 12's
 * implementation, not assumed - a transport that kept only the last callback
 * would silently unregister the code under test and every assertion after this
 * point would be meaningless.
 *
 * This exists because "zero corrections" is also what a client that received
 * NOTHING reports. Every zero-delta assertion below is paired with a floor on
 * this counter.
 */
function countSnapshots(t: Transport): () => number {
  let n = 0
  t.onMessage((_peerId, channel, data) => {
    if (channel === 'unreliable' && decodeHeader(data).kind === 'snapshot') n++
  })
  return () => n
}

describe('ClientLoop — local prediction', () => {
  it('steps its own kart forward every tick() call, driven by localIntent', () => {
    const ctx = makeNetContext(false)
    const pair = makeLossyPair({ latencyMs: 1, jitterMs: 0, lossRate: 0, seed: 1 })
    const client = new ClientLoop(ctx, OWN, pair.a)

    expect(client.state().tick).toBe(0)
    // A guest that has heard from no authority is in a COUNTDOWN as of Task 15c
    // item A (it used to force 'racing' at construction because the wire could
    // not carry the phase), and phase.ts's resolveInputs freezes every kart
    // while the phase is 'countdown'. This loop therefore ticks through the
    // countdown first and measures movement after it - which is also the honest
    // shape of the claim: a client steps every tick, and drives once the race
    // has started.
    for (let t = 1; t <= COUNTDOWN_TICKS; t++) {
      client.tick(mkIntent(0.2))
      expect(client.state().tick).toBe(t)
    }
    expect(client.state().phase).toBe('racing')
    const startX = client.state().karts[OWN].position.x
    const startZ = client.state().karts[OWN].position.z

    for (let t = COUNTDOWN_TICKS + 1; t <= COUNTDOWN_TICKS + 60; t++) {
      client.tick(mkIntent(0.2))
      // The tick counter advances by exactly one per call - a loop that
      // double-stepped, or stopped stepping after the first call (the Plan 1
      // bug shape: a function that breaks on its second consecutive call),
      // fails on the very next iteration rather than at the end.
      expect(client.state().tick).toBe(t)
    }

    // 60 ticks (1s) of accel 1 actually moved the kart: a tick() that never
    // called step(), or called it with a neutral intent instead of
    // localIntent, leaves the kart on the grid and fails here.
    const k = client.state().karts[OWN]
    const moved = Math.hypot(k.position.x - startX, k.position.z - startZ)
    expect(moved).toBeGreaterThan(1)
    expect(Math.hypot(k.velocity.x, k.velocity.z)).toBeGreaterThan(0)
    // Nothing was ever received, so nothing could legitimately have corrected.
    expect(client.corrections()).toBe(0)
  })

  it('state() is the live predicted state, not a snapshot taken at construction', () => {
    const ctx = makeNetContext(false)
    const pair = makeLossyPair({ latencyMs: 1, jitterMs: 0, lossRate: 0, seed: 1 })
    const client = new ClientLoop(ctx, OWN, pair.a)

    const first = client.state()
    client.tick(mkIntent(0))
    client.tick(mkIntent(0))
    expect(client.state()).toBe(first)   // same object, identity not copy
    expect(first.tick).toBe(2)           // and it was advanced in place
    // Only this client's own seat is human; the other seven stay bot-driven,
    // which is what makes step() legal without a partial-seat entry point.
    expect(first.karts[OWN].isBot).toBe(false)
    expect(first.karts[OWN].connected).toBe(true)
  })
})

describe('ClientLoop — 30Hz input send with INPUT_REDUNDANCY', () => {
  it('sends a datagram every 2 ticks (60Hz sim / 30Hz send), carrying the last 8 intents newest-last', () => {
    const ctx = makeNetContext(false)
    const pair = makeLossyPair({ latencyMs: 1, jitterMs: 0, lossRate: 0, seed: 1 })
    const client = new ClientLoop(ctx, OWN, pair.a)

    const received: InputDatagram[] = []
    pair.b.onMessage((_peerId, channel, data) => {
      if (channel !== 'unreliable') return
      // Dispatch on the shared header, exactly as AuthorityLoop does: this
      // asserts, per message, that ClientLoop really tagged what it sent.
      expect(decodeHeader(data).kind).toBe('input')
      const dg = makeInputDatagramTarget()
      decodeInput(data.subarray(HEADER_BYTES), dg)
      received.push(dg)
    })

    let nowMs = 0
    for (let t = 1; t <= 20; t++) {
      client.tick(mkIntent(t * 0.01))
      pair.pump(nowMs)
      nowMs += 1000 / 60
    }

    // 20 client ticks at a 2-tick send interval -> sends on ticks 2,4,...,20: 10 datagrams.
    expect(received.length).toBe(10)
    expect(received[0].playerId).toBe(OWN)
    expect(received[0].intents.length).toBe(8)
    // newest-last: the datagram sent at tick 2 has its last slot's steer
    // matching the intent passed at tick 2 (t*0.01 = 0.02), to within one
    // quantisation step - encodeInput is lossy on steer by design.
    expect(Math.abs(received[0].intents[7].steer - 0.02)).toBeLessThan(STEER_STEP)
    // the LAST datagram sent (at tick 20) has newest slot steer 0.20.
    expect(Math.abs(received[9].intents[7].steer - 0.2)).toBeLessThan(STEER_STEP)
    // and the window really slid: the two datagrams differ, so this is not
    // eight copies of one value passing both checks by accident.
    expect(received[9].intents[7].steer).toBeGreaterThan(received[0].intents[7].steer)
  })
})

describe('ClientLoop — reconciliation', () => {
  it('converges to zero corrections against a real AuthorityLoop, steer held steady', () => {
    const ctxA = makeNetContext(true)
    const state = createSimState(ctxA, 0, CHARS8)
    state.phase = 'racing'
    state.karts[OWN].isBot = false
    state.karts[OWN].connected = true

    const pair = makeLossyPair({ latencyMs: 20, jitterMs: 5, lossRate: 0, seed: 3 })
    const authority = new AuthorityLoop(ctxA, state, pair.a)
    const ctxC = makeNetContext(false)
    const snapshotsSeen = countSnapshots(pair.b)
    const client = new ClientLoop(ctxC, OWN, pair.b)

    let nowMs = 0
    for (let t = 0; t < 120; t++) {
      authority.tick()
      client.tick(mkIntent(0.15))
      pair.pump(nowMs)
      nowMs += 1000 / 60
    }
    const baseline = client.corrections()
    const snapshotsAtBaseline = snapshotsSeen()
    for (let t = 0; t < 120; t++) {
      authority.tick()
      client.tick(mkIntent(0.15))
      pair.pump(nowMs)
      nowMs += 1000 / 60
    }

    expect(client.corrections() - baseline).toBe(0)
    // Control: the measured window must contain real traffic. 120 ticks at one
    // snapshot every 3 ticks is 40 broadcasts with lossRate 0; a floor of 30
    // absorbs the latency shift at the window edges without absorbing silence.
    expect(
      snapshotsSeen() - snapshotsAtBaseline,
      'no snapshots arrived in the measured window, so the zero above is vacuous',
    ).toBeGreaterThanOrEqual(30)
    // Control: converged means converged. The client's own kart really is
    // where the authority says it is, rather than merely "took no
    // corrections" - which a client that never compared anything also reports.
    //
    // The tolerance here is deliberately NOT EPS. Both loops are at the same
    // tick number, but not at the same instant of information: the client's
    // current tick is the authority's state at snap.tick replayed forward a
    // few ticks. The epsilon-tight claim is about the comparison AT snap.tick,
    // and the zero-corrections delta above is what asserts it. This assertion
    // answers a different question - "is the client tracking the right kart in
    // the right race at all" - where the failure mode is metres, not
    // centimetres. Widening it does not weaken the epsilon invariant, and
    // tightening it to EPS would make a correct implementation flaky.
    const CONVERGED_BAND_M = 0.5
    const CONVERGED_BAND_MS = 1.0
    const mine = client.state().karts[OWN]
    const theirs = authority.state().karts[OWN]
    expect(Math.abs(mine.position.x - theirs.position.x)).toBeLessThan(CONVERGED_BAND_M)
    expect(Math.abs(mine.position.z - theirs.position.z)).toBeLessThan(CONVERGED_BAND_M)
    expect(Math.abs(mine.velocity.x - theirs.velocity.x)).toBeLessThan(CONVERGED_BAND_MS)
    expect(Math.abs(mine.velocity.z - theirs.velocity.z)).toBeLessThan(CONVERGED_BAND_MS)
    // Deliberately no equality assertion on lap/checkpointIdx: two karts half a
    // metre apart can legitimately sit on opposite sides of a checkpoint line at
    // one arbitrary instant, and a test that flakes on a correct implementation
    // teaches the next reader to widen it.
  })

  it('a snapshot whose tick the ring cannot find (idx < 0) triggers a hard resync instead of throwing', () => {
    const ctx = makeNetContext(false)
    const pair = makeLossyPair({ latencyMs: 1, jitterMs: 0, lossRate: 0, seed: 1 })
    const client = new ClientLoop(ctx, OWN, pair.a)
    client.tick(mkIntent(0)) // ring now holds only tick 1

    // A real SimState far ahead of anything the ring could hold, stepped
    // directly through @tapkart/sim (not through AuthorityLoop - only a
    // valid SimState's shape matters here, not a realistic trajectory to it).
    const farCtx = makeNetContext(true)
    let a = createSimState(farCtx, 0, CHARS8)
    a.karts[OWN].isBot = false
    a.karts[OWN].connected = true
    let b = createSimState(farCtx, 0, CHARS8)
    const inputs = makeSimIntentBuffer()
    for (let t = 0; t < 500; t++) {
      for (let i = 0; i < 8; i++) inputs[i].tick = a.tick + 1
      const events: AuthEvent[] = []
      simStep(farCtx, a, b, inputs, events)
      const tmp = a
      a = b
      b = tmp
    }
    expect(a.tick).toBe(500)

    // Worst-case snapshot is 744 B (contract §4: 8x178 + 32x135 + 202 bits =
    // 5946 bits - the header is 202 and not the 200 this comment used to cite
    // because Task 15c item A put a 2-bit `phase` in it); 1024 plus the 2-byte
    // header is comfortable headroom, and was never derived from the figure.
    const buf = new Uint8Array(1024)
    const h = encodeHeader(buf, 'snapshot')
    const n = encodeSnapshot(buf.subarray(h), a, new Array(8).fill(-1))
    pair.b.broadcast('unreliable', buf.slice(0, h + n))
    // pump() only DELIVERS a message once nowMs has advanced past the
    // moment it was scheduled - the same schedule-then-deliver split a real
    // transport needs, so one call right after broadcast() never delivers
    // anything (deliverAt is computed as >= that same nowMs). Several frames
    // of pumping guarantee delivery well before the loop ends.
    let nowMs = 0
    for (let i = 0; i < 10; i++) {
      pair.pump(nowMs)
      nowMs += 1000 / 60
    }

    expect(() => client.tick(mkIntent(0))).not.toThrow()
    expect(client.corrections()).toBeGreaterThan(0)
    // And the resync actually landed. tick() steps first (tick 1 -> 2) and
    // reconciles at the end of the same call, so hardResync's
    // `predicted.tick = snap.tick` leaves the clock at exactly 500. Without
    // hardResync the client would still be at tick 2 on the grid, having
    // ignored a snapshot it could not place in its ring.
    expect(client.state().tick).toBe(500)
    // The kart carries the dequantised authoritative position, which is within
    // one quantisation step of the source - and contract §4 guarantees every
    // epsilon exceeds its own step, so EPS.position is the correct bound here
    // rather than a hand-picked number.
    expect(
      Math.abs(client.state().karts[OWN].position.x - a.karts[OWN].position.x),
    ).toBeLessThanOrEqual(EPS.position)
  })
})

describe('ClientLoop — events applied immediately, not deferred', () => {
  it('an itemGrant received over the reliable channel updates the local kart before the next tick() returns', () => {
    const ctx = makeNetContext(false)
    const pair = makeLossyPair({ latencyMs: 1, jitterMs: 0, lossRate: 0, seed: 1 })
    const client = new ClientLoop(ctx, OWN, pair.a)

    for (let t = 0; t < 5; t++) client.tick(mkIntent(0))

    expect(client.state().karts[OWN].item).toBe('none')
    expect(client.state().nextEventSeq).toBe(0)

    const events: AuthEvent[] = [
      { eventSeq: 0, tick: 5, kind: 'itemGrant', playerId: OWN, entityId: -1, item: 'seeker', data: 0 },
    ]
    const buf = new Uint8Array(4096)
    const h = encodeHeader(buf, 'events')
    const n = encodeEvents(buf.subarray(h), events)
    pair.b.broadcast('reliable', buf.slice(0, h + n))
    let nowMs = 0
    for (let i = 0; i < 10; i++) {
      pair.pump(nowMs)
      nowMs += 1000 / 60
    }

    // applyEvent runs synchronously inside the onMessage callback fired by
    // pump() above, so by the time pump() returns the item is already there -
    // before any further tick() call. That is the whole claim in this test's
    // title, and state() (locked contract §5) is what makes it observable:
    // an earlier draft of this test could only assert `not.toThrow()`, which a
    // ClientLoop that dropped every reliable datagram on the floor also passes.
    expect(client.state().karts[OWN].item).toBe('seeker')
    expect(client.state().nextEventSeq).toBe(1)
    // A follower's nextEventSeq advances ONLY by applying received events
    // (contract §1b/§0), so this pair of assertions also proves the client
    // never emitted one of its own during those five ticks.

    // Still there after the next tick(): applying an event outside step() is
    // only durable because step()'s cloneState(prev, next) carries it forward.
    client.tick(mkIntent(0))
    expect(client.state().karts[OWN].item).toBe('seeker')
  })
})

function mkRemoteKart(x: number, vx: number, lap = 0): WireKart {
  return {
    playerId: 1, position: { x, y: 0, z: 0 }, velocity: { x: vx, y: 0, z: 0 },
    heading: 0, angularVelocity: 0, driftCharge: 0, driftActive: false, driftDir: 0,
    airborne: false, surface: 'tarmac', spinOutTicks: 0, invulnTicks: 0, item: 'none',
    lap, checkpointIdx: 0, t: 0, isBot: false, connected: true,
    boostTicks: 0, respawnTicks: 0, shielded: false,
  }
}

function mkRemoteEntity(entityId: number, x: number, vx: number, kind: EntityKind = 'seeker'): WireEntity {
  return {
    entityId, kind, ownerId: 0,
    position: { x, y: 0, z: 0 }, velocity: { x: vx, y: 0, z: 0 }, heading: 0, ttl: 300,
  }
}

/** Every keyframe carries entities as well as karts (ruling P2-R8). A kart-only
 * keyframe is not a thing a snapshot can produce: WireSnapshot always carries
 * both, and ClientLoop now forwards both. */
function kf(recvAtMs: number, karts: WireKart[], entities: WireEntity[] = []): {
  recvAtMs: number; karts: WireKart[]; entities: WireEntity[]; entityCount: number
} {
  return { recvAtMs, karts, entities, entityCount: entities.length }
}

describe('RemoteInterpolator', () => {
  it('returns null before anything has been pushed', () => {
    const ri = new RemoteInterpolator()
    expect(kartSample(ri, 1, 1000)).toBeNull()
  })

  it('interpolates linearly between two bracketing keyframes at the render-delay target', () => {
    const ri = new RemoteInterpolator()
    ri.push(kf(1000, [mkRemoteKart(0, 0), mkRemoteKart(0, 0), mkRemoteKart(0, 5)]))
    ri.push(kf(1050, [mkRemoteKart(0, 0), mkRemoteKart(0, 0), mkRemoteKart(0.25, 5)]))
    // nowMs=1125 -> targetMs = 1125 - REMOTE_INTERP_DELAY_MS(100) = 1025,
    // the midpoint of [1000, 1050].
    const s = kartSample(ri, 2, 1125)
    expect(s).not.toBeNull()
    expect(s!.position.x).toBeCloseTo(0.125, 5)
  })

  it('extrapolates briefly from the newest keyframe when the buffer starves, hard-capped at 200ms', () => {
    const ri = new RemoteInterpolator()
    ri.push(kf(1000, [mkRemoteKart(0, 0), mkRemoteKart(0, 0), mkRemoteKart(10, 4)]))
    const nowMs = 1000 + REMOTE_INTERP_DELAY_MS + 5000 // target is 5s past the only keyframe
    const s = kartSample(ri, 2, nowMs)
    expect(s).not.toBeNull()
    const expected = 10 + 4 * (REMOTE_EXTRAPOLATE_CAP_MS / 1000)
    expect(s!.position.x).toBeCloseTo(expected, 5) // capped at 200ms of velocity, not 5s
  })

  it('respects REMOTE_BUFFER_CAPACITY (8), evicting the oldest keyframe first', () => {
    const ri = new RemoteInterpolator()
    for (let i = 0; i < 20; i++) {
      ri.push(kf(i * 50, [mkRemoteKart(0, 0), mkRemoteKart(0, 0), mkRemoteKart(i, 0)]))
    }
    // Capacity 8 means only i=12..19 (recvAtMs 600..950) survive. Sampling
    // before everything retained clamps to the oldest surviving keyframe.
    const s = kartSample(ri, 2, 0)
    expect(s).not.toBeNull()
    expect(s!.position.x).toBe(12)
  })
})

describe('RemoteInterpolator — the authoritative record behind a sample (ruling P2-R9)', () => {
  it('carries the newest wire record for the seat alongside the interpolated position', () => {
    const ri = new RemoteInterpolator()
    // Three keyframes with a DIFFERENT lap counter in each, so "newest" is
    // distinguishable from "the older half of the bracket" and from "whichever
    // one happened to be first".
    ri.push(kf(1000, [mkRemoteKart(0, 0), mkRemoteKart(0, 0), mkRemoteKart(0, 5, 0)]))
    ri.push(kf(1050, [mkRemoteKart(0, 0), mkRemoteKart(0, 0), mkRemoteKart(0.25, 5, 1)]))
    ri.push(kf(1100, [mkRemoteKart(0, 0), mkRemoteKart(0, 0), mkRemoteKart(0.5, 5, 2)]))

    // targetMs = 1025: interpolating inside [1000, 1050], two keyframes behind
    // the newest one.
    const s = kartSample(ri, 2, 1125)
    expect(s).not.toBeNull()
    // Position still comes from the interpolation, unchanged.
    expect(s!.position.x).toBeCloseTo(0.125, 5)
    // The discrete fields do not: without this a guest's HUD would read lap
    // counters, standings and item icons off its own bot AI (spec §5 forbids
    // predicting a remote seat at all), which is what `kart` exists to replace.
    expect(s!.kart.lap).toBe(2)
    expect(s!.kart.connected).toBe(true)
  })
})

describe('RemoteInterpolator — entities (rulings P2-R8, P2-R43)', () => {
  it('keys sampleEntity on entityId, never on array index, across a swap-remove', () => {
    const ri = new RemoteInterpolator()
    // karts: [] on purpose - this is an entity-only fixture, and sampleEntity
    // never reads the kart array.
    //
    // Two live entities, then entity 1 despawns. packages/sim/src/entity.ts's
    // despawnEntityAt is a SWAP-REMOVE: the last live entity is moved down into
    // the freed slot to keep the live ones packed at the front, exactly as
    // WireSnapshot carries them. So slot 0 holds entity 1 in the older keyframe
    // and entity 2 in the newer one.
    ri.push(kf(1000, [], [mkRemoteEntity(1, 0, 0), mkRemoteEntity(2, 100, 0)]))
    ri.push(kf(1050, [], [mkRemoteEntity(2, 100, 0)]))

    const s = entitySample(ri, 2, 1125) // targetMs 1025, the midpoint of the bracket
    expect(s).not.toBeNull()
    // Entity 2 never moved, so it is still at x = 100. An index-keyed sampler
    // interpolates slot 0 against slot 0 - entity 1's x = 0 against entity 2's
    // x = 100 - and reports 50: entity 2 teleporting halfway into the entity
    // that just died. That is the failure this test exists for, and it is
    // invisible to any fixture with only one live entity.
    expect(s!.position.x).toBeCloseTo(100, 5)
    expect(s!.entity.entityId).toBe(2)
    expect(s!.entity.kind).toBe('seeker')
  })

  it('interpolates an entity that moved, between the two keyframes that hold it', () => {
    const ri = new RemoteInterpolator()
    ri.push(kf(1000, [], [mkRemoteEntity(3, 0, 20), mkRemoteEntity(4, 500, 0)]))
    ri.push(kf(1050, [], [mkRemoteEntity(3, 1, 20), mkRemoteEntity(4, 500, 0)]))
    const s = entitySample(ri, 3, 1125)
    expect(s).not.toBeNull()
    expect(s!.position.x).toBeCloseTo(0.5, 5)
  })

  it('returns null for an entity absent from the newest keyframe: it despawned', () => {
    const ri = new RemoteInterpolator()
    ri.push(kf(1000, [], [mkRemoteEntity(1, 0, 0), mkRemoteEntity(2, 100, 0)]))
    ri.push(kf(1050, [], [mkRemoteEntity(2, 100, 0)]))
    expect(entitySample(ri, 1, 1125)).toBeNull()
    // And an id that was never on the wire at all is the same answer.
    expect(entitySample(ri, 99, 1125)).toBeNull()
    // -1 is entity.ts's dead-slot sentinel and must never match a slot.
    expect(entitySample(ri, -1, 1125)).toBeNull()
  })

  it('extrapolates from the newest keyframe alone for an entity that only just spawned', () => {
    const ri = new RemoteInterpolator()
    ri.push(kf(1000, [], [mkRemoteEntity(1, 0, 0)]))
    ri.push(kf(1050, [], [mkRemoteEntity(1, 0, 0), mkRemoteEntity(9, 10, 20)]))
    // targetMs 1025 is BEFORE the only keyframe holding entity 9, so the
    // extrapolation term clamps to zero and the entity pops in at the position
    // it spawned at rather than being dragged backwards along its velocity.
    const s = entitySample(ri, 9, 1125)
    expect(s).not.toBeNull()
    expect(s!.position.x).toBeCloseTo(10, 5)
  })

  it('caps entity extrapolation at REMOTE_EXTRAPOLATE_CAP_MS, exactly as sampleKart does', () => {
    const ri = new RemoteInterpolator()
    ri.push(kf(1000, [], [mkRemoteEntity(5, 10, 4)]))
    const nowMs = 1000 + REMOTE_INTERP_DELAY_MS + 5000
    const s = entitySample(ri, 5, nowMs)
    expect(s).not.toBeNull()
    expect(s!.position.x).toBeCloseTo(10 + 4 * (REMOTE_EXTRAPOLATE_CAP_MS / 1000), 5)
  })

  it('enumerates live entity ids into a caller-owned Int32Array', () => {
    const ri = new RemoteInterpolator()
    const out = new Int32Array(MAX_ENTITIES)

    // Nothing received yet: nothing live.
    expect(ri.liveEntityIds(out)).toBe(0)

    ri.push(kf(1000, [], [mkRemoteEntity(4, 0, 0), mkRemoteEntity(7, 10, 0), mkRemoteEntity(9, 20, 0)]))
    const n = ri.liveEntityIds(out)
    expect(n).toBe(3)
    expect(Array.from(out.subarray(0, n))).toEqual([4, 7, 9])
    // The round trip is the whole point: entity ids come from a monotonic
    // counter and cannot be probed, so every id this returns must be one
    // sampleEntity answers.
    for (let i = 0; i < n; i++) expect(entitySample(ri, out[i], 1100)).not.toBeNull()

    // Entity 7 despawns (swap-remove moves 9 into its slot).
    ri.push(kf(1050, [], [mkRemoteEntity(4, 0, 0), mkRemoteEntity(9, 20, 0)]))
    const n2 = ri.liveEntityIds(out)
    expect(n2).toBe(2)
    expect(Array.from(out.subarray(0, n2))).toEqual([4, 9])
    expect(entitySample(ri, 7, 1150)).toBeNull()
  })
})

describe('ClientLoop — entities reach the renderer through the wire, not the local sim', () => {
  it('feeds decoded snapshot entities into its RemoteInterpolator, ~100ms in the past', () => {
    const ctx = makeNetContext(false)
    const pair = makeLossyPair({ latencyMs: 1, jitterMs: 0, lossRate: 0, seed: 11 })
    const client = new ClientLoop(ctx, OWN, pair.a)

    // The authoritative stream is driven by hand rather than by a live sim: what
    // is under test is the CLIENT's handling of wire entities, so the entity's
    // trajectory is a controlled straight line instead of whatever a seeker's
    // homing, striking and ttl logic would produce over 180 ticks.
    const wire = createSimState(makeNetContext(true), 0, CHARS8)
    wire.phase = 'racing'
    wire.entityCount = 1
    const ENTITY_ID = 7
    const e = wire.entities[0]
    e.entityId = ENTITY_ID
    e.kind = 'slick'
    e.ownerId = 3
    e.position.x = 0
    e.position.y = 0
    e.position.z = 0
    e.velocity.x = 20 // m/s along +x: 60 m over the 180 ticks below
    e.velocity.z = 0

    const buf = new Uint8Array(1024)
    const lastProcessed = new Array(MAX_KARTS).fill(-1)
    const history: number[] = [0]

    let nowMs = 0
    for (let t = 1; t <= 180; t++) {
      wire.tick = t
      e.position.x += e.velocity.x / 60
      history[t] = e.position.x
      if (t % 3 === 0) {
        const h = encodeHeader(buf, 'snapshot')
        const n = encodeSnapshot(buf.subarray(h), wire, lastProcessed)
        pair.b.broadcast('unreliable', buf.slice(0, h + n))
      }
      client.tick(mkIntent(0))
      pair.pump(nowMs)
      nowMs += TICK_MS
    }

    const ri = remoteInterpolatorOf(client)
    // Discoverable without being told the id - a renderer has no other way in.
    const ids = new Int32Array(MAX_ENTITIES)
    expect(ri.liveEntityIds(ids)).toBe(1)
    expect(ids[0]).toBe(ENTITY_ID)

    const nowTick = client.state().tick
    const s = entitySample(ri, ENTITY_ID, nowTick * TICK_MS)
    expect(s).not.toBeNull()
    expect(s!.entity.kind).toBe('slick')
    expect(s!.entity.ownerId).toBe(3)

    // WHICH instant is it showing? Closest match across the whole recorded
    // history, the same instrument the remote-kart test uses: 100ms of render
    // delay is 6 ticks at 60Hz. The entity covers 0.33 m per tick, far more than
    // the 0.03125 m position quantisation step, so the match is unambiguous.
    let bestTick = -1
    let bestDist = Infinity
    for (let t = 1; t < history.length; t++) {
      const d = Math.abs(s!.position.x - history[t])
      if (d < bestDist) {
        bestDist = d
        bestTick = t
      }
    }
    expect(nowTick - bestTick).toBeGreaterThanOrEqual(4)
    expect(nowTick - bestTick).toBeLessThanOrEqual(8)
    expect(bestDist).toBeLessThan(0.2)
  })
})

/**
 * Two ClientLoops with identical contexts, identical playerIds and identical
 * intents are the same deterministic simulation, so the one that is never sent a
 * snapshot IS the other one's pre-correction trajectory. That is what makes the
 * size of a correction externally measurable at all: tick() steps and reconciles
 * inside a single call, so no caller can observe the intermediate state directly.
 */
function makeTwinClients(): {
  a: ClientLoop
  b: ClientLoop
  pairA: ReturnType<typeof makeLossyPair>
  tickBoth(intent: Intent): void
  pumpA(): void
} {
  const pairA = makeLossyPair({ latencyMs: 1, jitterMs: 0, lossRate: 0, seed: 5 })
  const pairB = makeLossyPair({ latencyMs: 1, jitterMs: 0, lossRate: 0, seed: 5 })
  const a = new ClientLoop(makeNetContext(false), OWN, pairA.a)
  const b = new ClientLoop(makeNetContext(false), OWN, pairB.a)
  let nowMs = 0
  return {
    a,
    b,
    pairA,
    tickBoth(intent: Intent): void {
      a.tick(intent)
      b.tick(intent)
      pairA.pump(nowMs)
      pairB.pump(nowMs)
      nowMs += TICK_MS
    },
    pumpA(): void {
      // Delivers into A only, without advancing either loop: a snapshot has to
      // land BETWEEN two ticks for the next tick() to reconcile against it.
      for (let i = 0; i < 4; i++) {
        pairA.pump(nowMs)
        nowMs += TICK_MS
      }
    },
  }
}

describe('ClientLoop — correctionDeltaOf (rulings P2-R47, P2-R48)', () => {
  it('reports the position and heading discontinuity the last reconciliation applied', () => {
    const twins = makeTwinClients()
    const intent = mkIntent(0.25)
    const out: Vec3 = { x: 0, y: 0, z: 0 }

    for (let t = 0; t < 30; t++) twins.tickBoth(intent)
    // Nothing has corrected yet, so there is no discontinuity to report. null,
    // not a boolean: "no correction" and "a correction of exactly zero" have to
    // stay distinguishable.
    expect(correctionDeltaOf(twins.a, out)).toBeNull()

    // An authoritative state at a tick the ring still holds, reached with NO
    // input at all - metres from where these two clients drove.
    const anchorTick = twins.a.state().tick - 10
    const wireCtx = makeNetContext(true)
    let s1 = createSimState(wireCtx, 0, CHARS8)
    s1.phase = 'racing'
    let s2 = createSimState(wireCtx, 0, CHARS8)
    const inputs = makeSimIntentBuffer()
    for (let t = 0; t < anchorTick; t++) {
      for (let i = 0; i < MAX_KARTS; i++) inputs[i].tick = s1.tick + 1
      const scratch: AuthEvent[] = []
      simStep(wireCtx, s1, s2, inputs, scratch)
      const tmp = s1
      s1 = s2
      s2 = tmp
    }
    const buf = new Uint8Array(1024)
    const h = encodeHeader(buf, 'snapshot')
    const n = encodeSnapshot(buf.subarray(h), s1, new Array(MAX_KARTS).fill(-1))
    twins.pairA.b.broadcast('unreliable', buf.slice(0, h + n))
    twins.pumpA()

    // One more tick each: A steps exactly as B does, then reconciles.
    twins.tickBoth(intent)
    expect(twins.a.corrections()).toBe(1)
    expect(twins.b.corrections()).toBe(0)

    const dHeading = correctionDeltaOf(twins.a, out)
    expect(dHeading).not.toBeNull()

    const ka = twins.a.state().karts[OWN]
    const kb = twins.b.state().karts[OWN]
    expect(out.x).toBeCloseTo(ka.position.x - kb.position.x, 9)
    expect(out.y).toBeCloseTo(ka.position.y - kb.position.y, 9)
    expect(out.z).toBeCloseTo(ka.position.z - kb.position.z, 9)
    expect(dHeading!).toBeCloseTo(wrapAngle(ka.heading - kb.heading), 9)
    // Control: the jump this measured was real. A correction whose delta is
    // 0.0000 on every seed measures nothing at all.
    expect(Math.hypot(out.x, out.z)).toBeGreaterThan(EPS.position)

    // Cleared by the next tick: this reports the LAST tick()'s discontinuity,
    // not the last one that ever happened. A sticky record would make a renderer
    // re-smooth the same jump on every frame for the rest of the race.
    twins.tickBoth(intent)
    expect(correctionDeltaOf(twins.a, out)).toBeNull()
  })

  it('wraps the heading delta to the shortest arc, never reporting more than PI', () => {
    const twins = makeTwinClients()
    const intent = mkIntent(1)
    const out: Vec3 = { x: 0, y: 0, z: 0 }

    for (let t = 0; t < 30; t++) twins.tickBoth(intent)

    // B is stepped one tick ahead so its state IS A's next pre-correction state,
    // which is what lets the wire heading be positioned relative to it.
    twins.b.tick(intent)
    const kb = twins.b.state().karts[OWN]
    const preHeading = kb.heading
    expect(Math.abs(preHeading)).toBeGreaterThan(0.1) // not a degenerate zero

    // A state far past anything the 128-entry ring holds, so this takes the
    // hardResync path where the wire kart is written verbatim and the delta is
    // exactly (wire - predicted): no replay in between to blur it.
    const farCtx = makeNetContext(true)
    let f1 = createSimState(farCtx, 0, CHARS8)
    f1.phase = 'racing'
    let f2 = createSimState(farCtx, 0, CHARS8)
    const inputs = makeSimIntentBuffer()
    for (let t = 0; t < 400; t++) {
      for (let i = 0; i < MAX_KARTS; i++) inputs[i].tick = f1.tick + 1
      const scratch: AuthEvent[] = []
      simStep(farCtx, f1, f2, inputs, scratch)
      const tmp = f1
      f1 = f2
      f2 = tmp
    }
    // Just inside the far side of the circle from wherever the client is
    // pointing: both headings are in [-PI, PI], so the raw difference is past PI
    // and only wrapping brings it back into the shortest arc.
    f1.karts[OWN].heading = preHeading >= 0 ? -Math.PI + 0.05 : Math.PI - 0.05

    const buf = new Uint8Array(1024)
    const h = encodeHeader(buf, 'snapshot')
    const n = encodeSnapshot(buf.subarray(h), f1, new Array(MAX_KARTS).fill(-1))
    twins.pairA.b.broadcast('unreliable', buf.slice(0, h + n))
    twins.pumpA()
    twins.a.tick(intent)

    const dHeading = correctionDeltaOf(twins.a, out)
    expect(dHeading).not.toBeNull()
    const postHeading = twins.a.state().karts[OWN].heading
    // This really is a wrap case: the naive subtraction is outside [-PI, PI].
    expect(Math.abs(postHeading - preHeading)).toBeGreaterThan(Math.PI)
    expect(Math.abs(dHeading!)).toBeLessThanOrEqual(Math.PI)
    expect(dHeading!).toBeCloseTo(wrapAngle(postHeading - preHeading), 9)
  })
})

describe('ClientLoop — an event and the tick it took effect on', () => {
  it('replays an item spent one tick after the grant, instead of handing it back', () => {
    const ctx = makeNetContext(false)
    const pair = makeLossyPair({ latencyMs: 1, jitterMs: 0, lossRate: 0, seed: 1 })
    const client = new ClientLoop(ctx, OWN, pair.a)

    let nowMs = 0
    const advance = (n: number, intent: Intent = mkIntent(0.1)): void => {
      for (let i = 0; i < n; i++) {
        client.tick(intent)
        pair.pump(nowMs)
        nowMs += TICK_MS
      }
    }

    // COUNTDOWN_TICKS of it is the countdown a guest now starts in (Task 15c
    // item A): resolveInputs freezes every kart - and therefore every `useItem`
    // - while the phase is 'countdown', so the item this test is about could
    // never be spent from inside one. The remaining 30 are the pre-anchor ticks
    // this test always had.
    advance(COUNTDOWN_TICKS + 30)
    expect(client.state().phase).toBe('racing')
    const anchorTick = client.state().tick

    advance(10)
    const events: AuthEvent[] = [
      { eventSeq: 0, tick: client.state().tick, kind: 'itemGrant', playerId: OWN, entityId: -1, item: 'bolt', data: 0 },
    ]
    const evBuf = new Uint8Array(4096)
    const eh = encodeHeader(evBuf, 'events')
    const en = encodeEvents(evBuf.subarray(eh), events)
    pair.b.broadcast('reliable', evBuf.slice(0, eh + en))
    advance(1) // the grant lands mid-call, applied while predicted.tick is this tick
    expect(client.state().karts[OWN].item).toBe('bolt')
    const grantTick = client.state().tick

    // THE TRIGGER: the item is spent on the very next tick. Live, the grant was
    // applied BEFORE this step() ran, so this step() consumed it.
    advance(1, { tick: 0, steer: 0.1, accel: 1, brake: false, drift: false, useItem: true })
    expect(client.state().tick).toBe(grantTick + 1)
    expect(client.state().karts[OWN].item).toBe('none')

    advance(20)

    // Force a correction anchored well before the grant, so the replay spans
    // both the grant and the tick that spent it.
    const wireCtx = makeNetContext(true)
    let a = createSimState(wireCtx, 0, CHARS8)
    a.phase = 'racing'
    let b = createSimState(wireCtx, 0, CHARS8)
    const inputs = makeSimIntentBuffer()
    for (let t = 0; t < anchorTick; t++) {
      for (let i = 0; i < MAX_KARTS; i++) inputs[i].tick = a.tick + 1
      const scratch: AuthEvent[] = []
      simStep(wireCtx, a, b, inputs, scratch)
      const tmp = a
      a = b
      b = tmp
    }
    expect(a.tick).toBe(anchorTick)
    const snapBuf = new Uint8Array(1024)
    const sh = encodeHeader(snapBuf, 'snapshot')
    const sn = encodeSnapshot(snapBuf.subarray(sh), a, new Array(MAX_KARTS).fill(-1))
    pair.b.broadcast('unreliable', snapBuf.slice(0, sh + sn))
    advance(3)

    expect(client.corrections()).toBe(1)
    // The replay must land the grant on the tick it took effect live - the tick
    // BEFORE the step that consumed it. Banked on ring entry T+1 and re-applied
    // after that entry's step(), the grant arrives one tick too late: the step
    // that should have spent it finds an empty hand, and the grant then lands on
    // top, leaving this client holding an item it already fired.
    expect(client.state().karts[OWN].item).toBe('none')
    // Applied exactly once across the whole replay, not twice and not zero times.
    expect(client.state().nextEventSeq).toBe(1)
  })
})

describe('@tapkart/net — TICK_MS is exported, not privately redefined downstream', () => {
  it('is the 60Hz sim period, reachable through the package barrel', () => {
    // A later package that redefines this itself and gets it wrong pins every
    // remote kart at the extrapolation cap forever, with nothing in CI to see.
    expect(TICK_MS).toBe(1000 / 60)
  })
})

describe('ClientLoop — RemoteInterpolator wiring', () => {
  it('feeds the live snapshot stream into its RemoteInterpolator, rendering remote karts ~100ms in the past', () => {
    const ctxA = makeNetContext(true)
    const state = createSimState(ctxA, 0, CHARS8)
    state.phase = 'racing'
    state.karts[OWN].isBot = false
    state.karts[OWN].connected = true

    const pair = makeLossyPair({ latencyMs: 1, jitterMs: 0, lossRate: 0, seed: 7 })
    const authority = new AuthorityLoop(ctxA, state, pair.a)
    const ctxC = makeNetContext(false)
    const client = new ClientLoop(ctxC, OWN, pair.b)

    // A remote seat's kart: bot-driven on the authority, real physics in
    // ClientLoop's own predicted SimState but never trusted or rendered from
    // there (see this brief's design section). Its only path into anything
    // this test can observe is the wire, through the wiring this step adds.
    const REMOTE_SEAT = (OWN + 1) % MAX_KARTS

    // The authority's own truth for that kart, tick by tick, so this test can
    // ask WHICH instant the interpolator is showing - not merely "is it
    // non-null". A wiring that pushed one keyframe and then stopped, or that
    // rendered the PRESENT instead of the past, both pass a non-null check.
    const history: { x: number; z: number }[] = [{ x: 0, z: 0 }]

    let nowMs = 0
    for (let t = 0; t < 180; t++) {
      authority.tick()
      client.tick(mkIntent(0))
      pair.pump(nowMs)
      nowMs += 1000 / 60
      const k = authority.state().karts[REMOTE_SEAT].position
      history[authority.state().tick] = { x: k.x, z: k.z }
    }

    const nowTick = client.state().tick
    const sample = kartSample(remoteInterpolatorOf(client), REMOTE_SEAT, nowTick * (1000 / 60))
    expect(sample).not.toBeNull()
    // Real data, not a degenerate {0,0,0}: every shipped track's grid start is
    // off-origin, so a wired-through remote kart is nowhere near the origin.
    expect(Math.abs(sample!.position.x) + Math.abs(sample!.position.z)).toBeGreaterThan(1)

    // The kart really moved over the render delay, so "the past" and "the
    // present" are distinguishable at all - without this the delay assertion
    // below would pass on a stationary kart no matter what it sampled.
    const sixTicksOfTravel = Math.hypot(
      history[nowTick].x - history[nowTick - 6].x,
      history[nowTick].z - history[nowTick - 6].z,
    )
    expect(sixTicksOfTravel).toBeGreaterThan(0.5)

    // Which authoritative instant is the interpolator actually showing? The
    // closest match across the whole recorded history, not a tolerance around
    // a guessed answer: REMOTE_INTERP_DELAY_MS is 100ms = 6 ticks at 60Hz, so
    // a correctly delayed sample matches tick nowTick-6. Rendering the present
    // (delay dropped) lands on nowTick; rendering a stale single keyframe
    // lands far in the past. Both fail this band.
    let bestTick = -1
    let bestDist = Infinity
    for (let t = 1; t < history.length; t++) {
      const d = Math.hypot(sample!.position.x - history[t].x, sample!.position.z - history[t].z)
      if (d < bestDist) {
        bestDist = d
        bestTick = t
      }
    }
    expect(nowTick - bestTick).toBeGreaterThanOrEqual(4)
    expect(nowTick - bestTick).toBeLessThanOrEqual(8)
    // And it matches that instant closely - linear interpolation between two
    // keyframes 3 ticks apart, so the chord error is centimetres, not metres.
    expect(bestDist).toBeLessThan(0.2)
  })
})

/**
 * Spec §8's invariant, isolated: a converged client, fed authoritative wire
 * data that differs from its own prediction by NOTHING BUT the quantisation
 * of `encodeSnapshot`, must take zero corrections.
 *
 * The "authority" here is a mirror of the client's own state, re-encoded and
 * sent back through the real lossy transport at the real 20Hz snapshot
 * cadence. That is deliberate, and it is what makes the measurement clean:
 * against a live AuthorityLoop the two sims also disagree for reasons that
 * have nothing to do with quantisation (the authority applies an input at its
 * OWN current tick, so every input transient is a genuine physics
 * disagreement; respawn and itemGrant events arrive on a different channel
 * than the snapshot that already reflects them). Mixing those in makes a
 * zero-corrections count impossible to attribute. The end-to-end test below
 * measures that composite; this one measures the epsilon table alone, at
 * exactly spec §8's network conditions.
 *
 * `positionOffsetM` perturbs the mirrored kart's x before encoding, which is
 * how the two control cases below prove this harness can tell divergence from
 * noise at all.
 */
function runMirroredAuthority(opts: { ticks: number; positionOffsetM: number }): {
  corrections: number
  snapshotsDelivered: number
  metresTravelled: number
  topSpeed: number
} {
  const ctx = makeNetContext(false)
  const pair = makeLossyPair({}) // contract default: 150ms latency, 50ms jitter, 5% loss, seed 0xC0FFEE
  const snapshotsSeen = countSnapshots(pair.a)
  const client = new ClientLoop(ctx, OWN, pair.a)

  const mirror = allocStateLike(makeNetContext(true), client.state())
  const buf = new Uint8Array(1024)
  const lastProcessed: number[] = new Array(MAX_KARTS).fill(-1)
  const intent = mkIntent(0.3)

  const start = { ...client.state().karts[OWN].position }
  let topSpeed = 0
  let nowMs = 0
  for (let t = 0; t < opts.ticks; t++) {
    client.tick(intent)
    const k = client.state().karts[OWN]
    topSpeed = Math.max(topSpeed, Math.hypot(k.velocity.x, k.velocity.z))
    // 60Hz sim / 20Hz snapshot, the same cadence AuthorityLoop broadcasts at.
    if (client.state().tick % 3 === 0) {
      cloneState(client.state(), mirror)
      mirror.karts[OWN].position.x += opts.positionOffsetM
      // Deliberately stale, by roughly one one-way trip - exactly as a real
      // authority's per-player input cursor lags its own snapshot tick under
      // latency. Reconciliation must anchor on snap.tick and ignore this: a
      // loop anchored on lastProcessedInputTick would compare its state from
      // 12 ticks ago against data describing NOW and correct on every single
      // snapshot.
      lastProcessed[OWN] = Math.max(-1, mirror.tick - 12)
      const h = encodeHeader(buf, 'snapshot')
      const n = encodeSnapshot(buf.subarray(h), mirror, lastProcessed)
      pair.b.broadcast('unreliable', buf.slice(0, h + n))
    }
    pair.pump(nowMs)
    nowMs += 1000 / 60
  }

  const end = client.state().karts[OWN].position
  return {
    corrections: client.corrections(),
    snapshotsDelivered: snapshotsSeen(),
    metresTravelled: Math.hypot(end.x - start.x, end.z - start.z),
    topSpeed,
  }
}

describe('ClientLoop — the zero-corrections invariant (spec section 8)', () => {
  it('takes zero corrections from quantisation noise alone, over 960 ticks at 150ms/50ms/5%', () => {
    const r = runMirroredAuthority({ ticks: 960, positionOffsetM: 0 })

    expect(r.corrections).toBe(0)

    // The three controls without which that zero proves nothing.
    //
    // 1. Snapshots really arrived. 960 ticks at one broadcast every 3 ticks is
    //    320, thinned by the default 5% loss to ~304 expected; a floor of 220
    //    is far below any plausible run and far above the silence a broken
    //    transport produces - and a client that received nothing also reports
    //    zero corrections.
    expect(
      r.snapshotsDelivered,
      `only ${r.snapshotsDelivered} snapshots reached the client; a count near zero means the transport delivered nothing and the zero-corrections assertion is vacuous, not a pass`,
    ).toBeGreaterThanOrEqual(220)
    // 2. The kart was moving the whole time, so every quantised field was
    //    genuinely exercised across its range rather than sitting on one code.
    expect(r.metresTravelled).toBeGreaterThan(50)
    expect(r.topSpeed).toBeGreaterThan(20)
    // 3. See the two control cases below: the same harness with a
    //    beyond-epsilon perturbation corrects on essentially every snapshot,
    //    which is what proves this zero is a measurement and not a no-op.
  }, 30000)

  it('control: a deviation of half an epsilon still triggers nothing', () => {
    // EPS.position (0.05) minus the worst quantisation error the encoder can
    // add (half of the 0.03125 position step) leaves room for a deliberate
    // 0.025 deviation. Zero corrections here is the dead band working: the
    // epsilon table's whole purpose (contract §0/§4) is that sub-epsilon
    // disagreement never moves the kart.
    const r = runMirroredAuthority({ ticks: 600, positionOffsetM: EPS.position * 0.5 })
    expect(r.corrections).toBe(0)
    expect(r.snapshotsDelivered).toBeGreaterThanOrEqual(140)
  }, 30000)

  it('control: a deviation of three epsilons corrects continually instead of never', () => {
    // The positive control for the two zeros above. Same harness, same
    // transport, same seed - one field pushed past its epsilon. If THIS did
    // not fire, the zeros above would be measuring a comparison that never
    // runs, which is precisely the failure mode this file exists to rule out.
    //
    // It also settles the tightening question concretely. EPS.position is 0.05
    // against a 0.03125 position step, and writeFloatQ rounds to nearest, so
    // the worst round-trip error is half a step, 0.0156. Tightening
    // EPS.position below that turns the first test's ordinary noise into this
    // behaviour: measured directly, EPS.position = 0.01 takes 296 corrections
    // over the 960 ticks where 0.05 takes none, and EPS.position = 0.02 breaks
    // the half-epsilon control and both end-to-end tests. That is what
    // contract §0's "no epsilon may be tuned down" is protecting.
    //
    // Not EVERY snapshot: a correction shifts the client's whole replayed
    // trajectory by the offset, so roughly every other snapshot then lands
    // back inside the dead band. A floor of a quarter of the delivered
    // snapshots is far above the zero the two tests above assert and far
    // below the ~48% measured, so it detects the harness going inert without
    // pinning the exact ratio.
    const r = runMirroredAuthority({ ticks: 600, positionOffsetM: EPS.position * 3 })
    expect(r.snapshotsDelivered).toBeGreaterThanOrEqual(140)
    expect(r.corrections).toBeGreaterThanOrEqual(40)
    expect(r.corrections).toBeGreaterThanOrEqual(Math.floor(r.snapshotsDelivered * 0.25))
  }, 30000)
})

describe('ClientLoop — end-to-end against a real AuthorityLoop at the default lossy profile', () => {
  it('stays converged, correcting at most a few times in 600 ticks and never buzzing', () => {
    const ctxA = makeNetContext(true)
    const state = createSimState(ctxA, 0, CHARS8)
    state.phase = 'racing'
    // Only OWN is human/connected; the other seven stay bot-driven
    // (createState's own default), matching ClientLoop's internal bootstrap
    // exactly - both sims then run the SAME deterministic bot AI, in the same
    // process, off the same seed, so the other seven seats stay in lockstep
    // and cannot be a source of divergence for OWN's own kart.
    state.karts[OWN].isBot = false
    state.karts[OWN].connected = true
    // Neutralize item boxes on the authority: an itemGrant travels the
    // reliable channel independently of the unreliable snapshot stream, and
    // the snapshot for tick T already reflects a grant whose event the client
    // cannot have applied at tick T - a real, timing-driven (not
    // quantisation) divergence this test must not conflate with a buzzing
    // kart.
    for (const box of state.itemBoxes) box.respawnTicks = 1_000_000

    const pair = makeLossyPair({}) // contract default: 150ms latency, 50ms jitter, 5% loss, seed 0xC0FFEE
    const authority = new AuthorityLoop(ctxA, state, pair.a)
    const ctxC = makeNetContext(false)
    const snapshotsSeen = countSnapshots(pair.b)
    const client = new ClientLoop(ctxC, OWN, pair.b)

    // A HELD-STEADY intent, not a continuously varying one: this authority
    // applies whatever intent it currently holds at its OWN tick, so under a
    // changing signal the client predicts an input the authority simulates
    // ticks later - a lag artifact, not noise. Only a steady input makes
    // "held stale" and "fresh" the same VALUE.
    //
    // steer 0.1 / accel 0.4 is chosen so the kart laps without ever leaving
    // the track bounds: a respawn is an authoritative event on the reliable
    // channel, arriving after the snapshot that already shows it, and it
    // corrects for the same timing reason an itemGrant would. The assertion
    // below that no respawn happened is what keeps that true if the sim's
    // tuning ever changes underneath this test.
    const intent: Intent = { tick: 0, steer: 0.1, accel: 0.4, brake: false, drift: false, useItem: false }

    const WARMUP_TICKS = 360
    const STEADY_TICKS = 600

    let nowMs = 0
    for (let t = 0; t < WARMUP_TICKS; t++) {
      authority.tick()
      client.tick(intent)
      pair.pump(nowMs)
      nowMs += 1000 / 60
    }
    const baseline = client.corrections()
    const snapshotsAtBaseline = snapshotsSeen()

    let respawned = false
    let minSpeed = Infinity
    for (let t = 0; t < STEADY_TICKS; t++) {
      authority.tick()
      client.tick(intent)
      pair.pump(nowMs)
      nowMs += 1000 / 60
      const k = authority.state().karts[OWN]
      if (k.respawnTicks > 0 || k.spinOutTicks > 0) respawned = true
      minSpeed = Math.min(minSpeed, Math.hypot(k.velocity.x, k.velocity.z))
    }

    // NOT zero, and deliberately so - see this task's report. Quantisation
    // noise alone never triggers a correction (the mirrored-authority test
    // above proves exactly that, at these same network settings, over 960
    // ticks). What survives here is a second-order effect the epsilon table
    // cannot remove: every correction resets a diverged field to a QUANTISED
    // value, so it leaves a velocity residual of up to half a step
    // (0.0156 m/s) that is far below EPS.velocity and therefore invisible to
    // every later comparison - and that residual integrates into position
    // error, crossing EPS.position (0.05 m) after 3-6 seconds. Measured
    // across 20 transport seeds: 0-2 corrections per 600-tick window, i.e.
    // about one sub-decimetre correction every six seconds, which is not the
    // buzzing this epsilon table exists to prevent. A bound of 3 leaves one
    // correction of headroom while still catching the regression that matters
    // - predicting on the raw analog intent instead of its wire form, which
    // measured ~185 corrections in this same window.
    const steadyCorrections = client.corrections() - baseline
    expect(steadyCorrections).toBeLessThanOrEqual(3)

    // Controls, without which the bound above proves nothing.
    const steadySnapshots = snapshotsSeen() - snapshotsAtBaseline
    expect(
      steadySnapshots,
      `only ${steadySnapshots} snapshots reached the client in the steady window; a count near zero means the transport delivered nothing and the bound above is vacuous, not a pass`,
    ).toBeGreaterThanOrEqual(140)
    // The kart was racing, not parked or stuck against a wall - a frozen kart
    // trivially agrees with an authority that froze it too.
    expect(minSpeed).toBeGreaterThan(5)
    // And no authoritative event landed in the window, so what is being
    // measured really is steady-state reconciliation.
    expect(respawned).toBe(false)

    // Converged means converged: the client's own kart really is where the
    // authority says it is, rather than merely "took few corrections" - which
    // a client that never compared anything also reports. The tolerance is
    // deliberately NOT EPS: both loops are at the same tick number but not at
    // the same instant of information, and the epsilon-tight claim is about
    // the comparison AT snap.tick, which the mirrored-authority test asserts.
    const CONVERGED_BAND_M = 0.5
    const CONVERGED_BAND_MS = 1.0
    const mine = client.state().karts[OWN]
    const theirs = authority.state().karts[OWN]
    expect(Math.abs(mine.position.x - theirs.position.x)).toBeLessThan(CONVERGED_BAND_M)
    expect(Math.abs(mine.position.z - theirs.position.z)).toBeLessThan(CONVERGED_BAND_M)
    expect(Math.abs(mine.velocity.x - theirs.velocity.x)).toBeLessThan(CONVERGED_BAND_MS)
    expect(Math.abs(mine.velocity.z - theirs.velocity.z)).toBeLessThan(CONVERGED_BAND_MS)
  }, 30000)
})

describe('ClientLoop — a correction replays applied events, not just inputs', () => {
  it('keeps an item granted after the anchor tick when reconciliation rewinds past it', () => {
    const ctx = makeNetContext(false)
    const pair = makeLossyPair({ latencyMs: 1, jitterMs: 0, lossRate: 0, seed: 1 })
    const client = new ClientLoop(ctx, OWN, pair.a)

    let nowMs = 0
    const advance = (n: number): void => {
      for (let i = 0; i < n; i++) {
        client.tick(mkIntent(0.1))
        pair.pump(nowMs)
        nowMs += 1000 / 60
      }
    }

    // 30 ticks of driving first, so the ring holds real history either side of
    // the anchor: this behaviour only exists across ticks, and a rewind that
    // spans a single entry would never exercise the replay loop at all.
    advance(30)
    const anchorTick = client.state().tick

    // A grant lands 10 ticks after the anchor, applied on receipt, outside
    // step() - the whole reason ring entries carry appliedEvents.
    advance(10)
    const events: AuthEvent[] = [
      { eventSeq: 0, tick: client.state().tick, kind: 'itemGrant', playerId: OWN, entityId: -1, item: 'bolt', data: 0 },
    ]
    const evBuf = new Uint8Array(4096)
    const eh = encodeHeader(evBuf, 'events')
    const en = encodeEvents(evBuf.subarray(eh), events)
    pair.b.broadcast('reliable', evBuf.slice(0, eh + en))
    advance(1)
    expect(client.state().karts[OWN].item).toBe('bolt')
    expect(client.state().nextEventSeq).toBe(1)

    // 20 more ticks, so the grant sits well inside the replayed span rather
    // than on its last entry.
    advance(20)
    const tickBeforeCorrection = client.state().tick

    // Now force a correction anchored BEFORE the grant. The wire state is a
    // real SimState stepped to exactly `anchorTick` with no input at all, so
    // its kart is still near the grid, metres from where this client drove -
    // a divergence far past EPS.position, and one whose kart carries item
    // 'none'. Reconciliation must rewind to anchorTick, take that kart, and
    // replay forward: inputs AND the recorded grant.
    const wireCtx = makeNetContext(true)
    let a = createSimState(wireCtx, 0, CHARS8)
    a.phase = 'racing'
    let b = createSimState(wireCtx, 0, CHARS8)
    const inputs = makeSimIntentBuffer()
    for (let t = 0; t < anchorTick; t++) {
      for (let i = 0; i < MAX_KARTS; i++) inputs[i].tick = a.tick + 1
      const scratch: AuthEvent[] = []
      simStep(wireCtx, a, b, inputs, scratch)
      const tmp = a
      a = b
      b = tmp
    }
    expect(a.tick).toBe(anchorTick)
    expect(a.karts[OWN].item).toBe('none')

    const snapBuf = new Uint8Array(1024)
    const sh = encodeHeader(snapBuf, 'snapshot')
    const sn = encodeSnapshot(snapBuf.subarray(sh), a, new Array(MAX_KARTS).fill(-1))
    pair.b.broadcast('unreliable', snapBuf.slice(0, sh + sn))
    advance(3)

    expect(client.corrections()).toBe(1)
    // The rewind really went back past the grant and replayed forward to the
    // present: the tick counter never went backwards...
    expect(client.state().tick).toBe(tickBeforeCorrection + 3)
    // ...and the granted item survived it. Without appliedEvents on the ring
    // this reads 'none': the item was applied outside step(), so a replay that
    // only re-runs step() from a checkpoint taken before the grant silently
    // loses it.
    expect(client.state().karts[OWN].item).toBe('bolt')
    // The event's seq survived the rewind too - the resync base is a clone of
    // the pre-grant checkpoint, whose nextEventSeq was 0, so re-applying
    // eventSeq 0 during the replay is not gated out.
    expect(client.state().nextEventSeq).toBe(1)
  })
})

describe('ClientLoop — the race phase comes off the wire (Task 15c item A)', () => {
  it('sits out the host countdown instead of driving away through it', () => {
    // THE defect this item fixes. WireSnapshot carried no phase, so ClientLoop
    // forced `predicted.phase = 'racing'` at construction - which meant every
    // guest in every race started driving the instant it connected while the
    // host was still counting down, and every snapshot in that window was a
    // guaranteed correction. A core gameplay defect, not a lobby concern.
    const ctxA = makeNetContext(true)
    const host = createSimState(ctxA, 0, CHARS8)
    // NOT forced to 'racing': createState starts a race in 'countdown', which is
    // what a real race does and what this test is about.
    expect(host.phase).toBe('countdown')
    host.karts[OWN].isBot = false
    host.karts[OWN].connected = true

    const pair = makeLossyPair({ latencyMs: 20, jitterMs: 0, lossRate: 0, seed: 11 })
    const authority = new AuthorityLoop(ctxA, host, pair.a)
    const client = new ClientLoop(makeNetContext(false), OWN, pair.b)
    const startPos = { ...client.state().karts[OWN].position }

    let nowMs = 0
    const advance = (n: number): void => {
      for (let i = 0; i < n; i++) {
        authority.tick()
        client.tick(mkIntent(0))
        pair.pump(nowMs)
        nowMs += TICK_MS
      }
    }

    // Well inside COUNTDOWN_TICKS (180), and long past the first snapshot.
    advance(120)
    expect(client.state().phase, 'the guest never learned the race had not started').toBe('countdown')
    const heldPos = client.state().karts[OWN].position
    expect(Math.hypot(heldPos.x - startPos.x, heldPos.z - startPos.z), 'the guest drove off during the countdown').toBe(0)
    // Control: the host is not moving either, so "did not move" is agreement
    // and not a frozen client.
    const hostKart = authority.state().karts[OWN]
    expect(Math.hypot(hostKart.position.x - startPos.x, hostKart.position.z - startPos.z)).toBe(0)
    // Control: it really is ticking. A loop that stopped stepping would also
    // fail to move.
    expect(client.state().tick).toBe(120)

    // Past the countdown: both sides race, and the guest drives.
    advance(120)
    expect(authority.state().phase).toBe('racing')
    expect(client.state().phase).toBe('racing')
    const movedPos = client.state().karts[OWN].position
    expect(Math.hypot(movedPos.x - startPos.x, movedPos.z - startPos.z)).toBeGreaterThan(1)
  })

  it('adopts a phase its own simulation could never have inferred', () => {
    // The isolating half. 'countdown' -> 'racing' happens locally too (phase.ts
    // flips it at tick >= COUNTDOWN_TICKS), so that transition alone cannot
    // prove the wire is the source. 'finished' cannot be inferred: a follower
    // never emits, never records a finisher, and advancePhase only reaches
    // 'finished' through finishers or the grace timer. If the client ends up
    // there, it read it off a snapshot.
    const ctx = makeNetContext(false)
    const pair = makeLossyPair({ latencyMs: 1, jitterMs: 0, lossRate: 0, seed: 5 })
    const client = new ClientLoop(ctx, OWN, pair.a)

    const mirror = allocStateLike(makeNetContext(true), client.state())
    const buf = new Uint8Array(1024)
    const lastProcessed: number[] = new Array(MAX_KARTS).fill(-1)
    let nowMs = 0
    const sendMirror = (phase: 'countdown' | 'racing' | 'finished'): void => {
      cloneState(client.state(), mirror)
      mirror.phase = phase
      const h = encodeHeader(buf, 'snapshot')
      const n = encodeSnapshot(buf.subarray(h), mirror, lastProcessed)
      pair.b.broadcast('unreliable', buf.slice(0, h + n))
    }

    // Racing early, on the authority's say-so alone: the client's own tick
    // counter is nowhere near COUNTDOWN_TICKS, so nothing local could have
    // produced this.
    for (let t = 0; t < 20; t++) {
      client.tick(mkIntent(0))
      if (t % 3 === 0) sendMirror('racing')
      pair.pump(nowMs)
      nowMs += TICK_MS
    }
    expect(client.state().tick).toBeLessThan(180)
    expect(client.state().phase, 'the authority said racing at tick < COUNTDOWN_TICKS').toBe('racing')
    const racingPos = { ...client.state().karts[OWN].position }
    expect(Math.hypot(racingPos.x, racingPos.z)).toBeGreaterThan(0)

    // And 'finished', which no local rule can reach.
    for (let t = 0; t < 20; t++) {
      client.tick(mkIntent(0))
      if (t % 3 === 0) sendMirror('finished')
      pair.pump(nowMs)
      nowMs += TICK_MS
    }
    expect(client.state().phase).toBe('finished')
  })
})

describe('ClientLoop — the phase never regresses across the start line (Task 15c item A, fix round)', () => {
  it('refuses a stale countdown from a snapshot in flight, at the plan default 150ms', () => {
    // THE DEFECT. `tick()` adopted `snap.phase` unconditionally, and at 150ms a
    // snapshot in flight is ~9 ticks old - so for the first ~9 ticks after the
    // lights went out, every snapshot the guest accepted said 'countdown'.
    // `resolveInputs` runs FIRST in step() and `updatePhase` runs LAST, so that
    // stale phase discarded the whole of the next tick's input before local
    // inference flipped it back. Measured as shipped, at these exact settings:
    // racing,countdown,racing,racing,countdown,racing,racing,countdown,racing -
    // three flickers, and the guest sat still for three ticks while the host
    // accelerated. That is the mirror image of the defect `WireSnapshot.phase`
    // was added to remove, and no test exercised the transition at a realistic
    // latency, which is why it shipped.
    const ctxA = makeNetContext(true)
    const host = createSimState(ctxA, 0, CHARS8)
    // A REAL race start: the host runs its own countdown from tick 0.
    expect(host.phase).toBe('countdown')
    host.karts[OWN].isBot = false
    host.karts[OWN].connected = true
    // Neutralised, for the same reason the end-to-end test neutralises them: an
    // itemGrant is an authoritative event on the reliable channel and corrects
    // for timing reasons that have nothing to do with the phase.
    for (const box of host.itemBoxes) box.respawnTicks = 1_000_000

    const pair = makeLossyPair({ latencyMs: 150, jitterMs: 0, lossRate: 0, seed: 31 })
    const authority = new AuthorityLoop(ctxA, host, pair.a)
    const client = new ClientLoop(makeNetContext(false), OWN, pair.b)
    const snapshotsSeen = countSnapshots(pair.b)

    const phases: string[] = []
    const speeds: number[] = []
    let nowMs = 0
    for (let t = 1; t <= COUNTDOWN_TICKS + 60; t++) {
      authority.tick()
      client.tick(mkIntent(0)) // steer 0, accel 1: flat out from the lights
      pair.pump(nowMs)
      nowMs += TICK_MS
      phases.push(client.state().phase)
      const k = client.state().karts[OWN]
      speeds.push(Math.hypot(k.velocity.x, k.velocity.z))
    }

    // 1. The phase never went backwards. Not "ends up right" - a flicker ends up
    //    right too, one tick later, having already thrown a tick of input away.
    const flickers: number[] = []
    for (let i = 1; i < phases.length; i++) {
      if (phases[i] === 'countdown' && phases[i - 1] !== 'countdown') flickers.push(i + 1)
    }
    expect(flickers, `the guest fell back into 'countdown' on tick(s) ${flickers.join(', ')}`).toEqual([])

    // 2. The consequence, measured on the kart rather than on the field: from
    //    the first tick it is racing, the guest accelerates on EVERY tick. A
    //    discarded input shows up here as a tick where a flat-out kart got
    //    slower, which is what drag does to a frozen one.
    const firstRacing = phases.indexOf('racing')
    expect(firstRacing).toBeGreaterThan(0)
    const stalled: number[] = []
    for (let i = firstRacing + 1; i < speeds.length; i++) {
      if (speeds[i] <= speeds[i - 1]) stalled.push(i + 1)
    }
    expect(stalled, `the guest lost speed on tick(s) ${stalled.join(', ')} - its input was discarded`).toEqual([])

    // 3. Controls, without which the two zeros above prove nothing.
    //    Snapshots really arrived, in the window that matters: 240 ticks at one
    //    broadcast in three is 80, and the 150ms of latency swallows the last
    //    few, so a floor of 60 is far below any plausible run and far above the
    //    silence a broken transport produces.
    expect(
      snapshotsSeen(),
      'no snapshots reached the guest, so the phase it holds is its own inference and this test measures nothing',
    ).toBeGreaterThanOrEqual(60)
    //    The countdown really was observed, so the boundary was really crossed
    //    inside this run rather than skipped.
    expect(phases[0]).toBe('countdown')
    expect(phases[phases.length - 1]).toBe('racing')
    expect(authority.state().phase).toBe('racing')
    //    ...and both sides sat still for it and then drove.
    expect(speeds[COUNTDOWN_TICKS - 2]).toBe(0)
    expect(speeds[speeds.length - 1]).toBeGreaterThan(10)
    // 4. And the guest is still on the authority's world at the end: a loop that
    //    "fixed" the flicker by ignoring the wire would pass 1-3 and fail here.
    const mine = client.state().karts[OWN]
    const theirs = authority.state().karts[OWN]
    expect(Math.hypot(mine.position.x - theirs.position.x, mine.position.z - theirs.position.z)).toBeLessThan(0.5)
  })
})

describe('ClientLoop — the two phase writes on the correction paths (Task 15c item B)', () => {
  it('replays a correction on the AUTHORITY\'s phase, not on the stale one its own checkpoint holds', () => {
    // reconcile()'s `this.resyncBase.phase = snap.phase`. Deleting that line left
    // all 143 tests in this package green, and it is load-bearing: the ring banks
    // its entry BEFORE the phase is adopted, so a replay from a stale 'countdown'
    // runs every replayed input through resolveInputs' freeze and discards it -
    // silently, with no counter anywhere moving.
    const ctx = makeNetContext(false)
    const pair = makeLossyPair({ latencyMs: 1, jitterMs: 0, lossRate: 0, seed: 13 })
    const client = new ClientLoop(ctx, OWN, pair.a)
    const drive = mkIntent(0) // steer 0, accel 1

    // 30 ticks inside this guest's own bootstrap countdown: resolveInputs freezes
    // every one of them, so the kart has not moved and every ring checkpoint in
    // the span carries phase 'countdown'. The ring banks the RAW intent rather
    // than the frozen one, which is what gives the replay below something to do.
    let nowMs = 0
    for (let t = 0; t < 30; t++) {
      client.tick(drive)
      pair.pump(nowMs)
      nowMs += TICK_MS
    }
    expect(client.state().phase).toBe('countdown')
    expect(client.state().tick).toBeLessThan(COUNTDOWN_TICKS)
    const gridX = client.state().karts[OWN].position.x
    expect(Math.hypot(client.state().karts[OWN].velocity.x, client.state().karts[OWN].velocity.z)).toBe(0)

    // The authority has been racing all along - a guest that connected 20 ticks
    // into a race that had already started. Its snapshot for tick 10 disagrees
    // about this kart by a metre (which is what forces the reconciliation) and
    // says 'racing' (which is what the replay has to run on).
    const mirror = allocStateLike(makeNetContext(true), client.state())
    cloneState(client.state(), mirror)
    mirror.tick = 10
    mirror.phase = 'racing'
    mirror.karts[OWN].position.x = gridX + 1
    const buf = new Uint8Array(1024)
    const h = encodeHeader(buf, 'snapshot')
    const n = encodeSnapshot(buf.subarray(h), mirror, new Array(MAX_KARTS).fill(-1))
    pair.b.broadcast('unreliable', buf.slice(0, h + n))
    for (let i = 0; i < 4; i++) {
      pair.pump(nowMs)
      nowMs += TICK_MS
    }

    client.tick(drive) // steps to 31, then reconciles: anchor 10, replay 11..31
    expect(client.corrections()).toBe(1)

    // 21 replayed ticks of accel 1. On the authority's 'racing' they are applied
    // and the kart is moving. On the checkpoint's stale 'countdown' every one of
    // them is frozen, and the kart sits on the wire position at a dead stop.
    const k = client.state().karts[OWN]
    expect(
      Math.hypot(k.velocity.x, k.velocity.z),
      'the replayed inputs were discarded by a stale countdown',
    ).toBeGreaterThan(2)
    expect(k.position.x - (gridX + 1)).toBeGreaterThan(0.5)
  })

  it('takes the authority\'s phase down with the tick counter on a hard resync', () => {
    // hardResync()'s `this.predicted.phase = snap.phase`. Deleting that line also
    // left all 143 tests green, because tick()'s own adoption used to overwrite
    // the same field with the same value one line later. It no longer does: that
    // adoption refuses a REGRESSION, and a hard resync is the one path that is
    // entitled to one - it abandons this loop's timeline wholesale and rebases on
    // the authority's, tick counter and all.
    const ctx = makeNetContext(false)
    const pair = makeLossyPair({ latencyMs: 1, jitterMs: 0, lossRate: 0, seed: 17 })
    const client = new ClientLoop(ctx, OWN, pair.a)
    const drive = mkIntent(0)

    // Far enough that its own inference has crossed the start line, and that the
    // 128-entry ring no longer reaches back to tick 50.
    let nowMs = 0
    for (let t = 0; t < 300; t++) {
      client.tick(drive)
      pair.pump(nowMs)
      nowMs += TICK_MS
    }
    expect(client.state().phase).toBe('racing')
    expect(client.state().tick).toBe(300)
    expect(Math.hypot(client.state().karts[OWN].velocity.x, client.state().karts[OWN].velocity.z)).toBeGreaterThan(10)

    // The first word this guest ever hears from an authority: the race is at tick
    // 50 and has not started. Older than the ring reaches (301 - 128), so this is
    // the hardResync path.
    const mirror = allocStateLike(makeNetContext(true), client.state())
    cloneState(client.state(), mirror)
    mirror.tick = 50
    mirror.phase = 'countdown'
    mirror.karts[OWN].velocity.x = 0
    mirror.karts[OWN].velocity.y = 0
    mirror.karts[OWN].velocity.z = 0
    const buf = new Uint8Array(1024)
    const h = encodeHeader(buf, 'snapshot')
    const n = encodeSnapshot(buf.subarray(h), mirror, new Array(MAX_KARTS).fill(-1))
    pair.b.broadcast('unreliable', buf.slice(0, h + n))
    for (let i = 0; i < 4; i++) {
      pair.pump(nowMs)
      nowMs += TICK_MS
    }

    client.tick(drive)
    expect(client.corrections()).toBe(1)
    expect(client.state().tick).toBe(50)
    expect(client.state().phase).toBe('countdown')

    // The consequence, on the kart: a guest that kept its own 'racing' would
    // drive away through the whole of the host's remaining countdown - the
    // original defect, reintroduced through the one path entitled to regress.
    for (let t = 0; t < 20; t++) {
      client.tick(drive)
      pair.pump(nowMs)
      nowMs += TICK_MS
    }
    const k = client.state().karts[OWN]
    expect(
      Math.hypot(k.velocity.x, k.velocity.z),
      'the guest drove off during a countdown it had just been told about',
    ).toBeLessThan(0.1)
  })
})

/**
 * A kart's held item, read through a call rather than off the property.
 *
 * `k.item = 'bolt'` narrows the property to the literal type `'bolt'` for the
 * rest of the enclosing scope, and every later `=== 'none'` then fails to compile
 * under `strict` as a comparison with no overlap - on the exact reads the item
 * tests below exist to make. A call's return type cannot be narrowed by an
 * earlier assignment, so this widens it back to `ItemKind` without a cast.
 */
function heldItem(k: { item: ItemKind }): ItemKind {
  return k.item
}

/**
 * One race in which a single-tick `useItem` pulse is raised on exactly one tick,
 * and nothing else ever raises it. Returns the tick the AUTHORITY spent the item
 * on, or -1 if it never did.
 *
 * `pulseTick` is a tick number in this loop's own 1-based counting, which is also
 * `ClientLoop.state().tick` after that call - so `pulseTick` odd is precisely a
 * tick the 30Hz send cadence drops.
 *
 * `regrantAt` hands the kart a SECOND item mid-race with no further input, which
 * is how "the latch cleared after sending" is observable: a latch that stuck
 * would fire that one too, the instant it was granted.
 */
function runPulseRace(pulseTick: number, regrantAt = -1): { firedAt: number; secondFiredAt: number } {
  const ctxA = makeNetContext(true)
  const host = createSimState(ctxA, 0, CHARS8)
  host.phase = 'racing'
  host.karts[OWN].isBot = false
  host.karts[OWN].connected = true
  // No item boxes: the only items in this race are the ones this function grants,
  // so "the item is gone" can only mean it was used.
  for (const box of host.itemBoxes) box.respawnTicks = 1_000_000
  host.karts[OWN].item = 'bolt'

  const pair = makeLossyPair({ latencyMs: 1, jitterMs: 0, lossRate: 0, seed: 23 })
  const authority = new AuthorityLoop(ctxA, host, pair.a)
  const client = new ClientLoop(makeNetContext(false), OWN, pair.b)

  let firedAt = -1
  let secondFiredAt = -1
  let nowMs = 0
  for (let t = 1; t <= 60; t++) {
    client.tick({ tick: 0, steer: 0, accel: 1, brake: false, drift: false, useItem: t === pulseTick })
    authority.tick()
    pair.pump(nowMs)
    nowMs += TICK_MS
    if (firedAt < 0 && heldItem(host.karts[OWN]) === 'none') firedAt = t
    if (t === regrantAt) host.karts[OWN].item = 'bolt'
    if (regrantAt > 0 && t > regrantAt && secondFiredAt < 0 && heldItem(host.karts[OWN]) === 'none') secondFiredAt = t
  }
  return { firedAt, secondFiredAt }
}

describe('ClientLoop — every 60Hz intent reaches the wire, whichever half of the pair it lands on (Task 15c item D)', () => {
  it('puts a useItem pulse raised on an ODD tick on the wire, instead of dropping it', () => {
    // Only every OTHER 60Hz intent used to reach the wire: the send path fires on
    // `predicted.tick % 2 === 0` and simply discarded the intent it was handed on
    // the other tick. Task 17 found this because a single-tick golden
    // perturbation changed nothing anywhere - a one-tick input spike was
    // invisible to the authority.
    //
    // It is a defect and not a curiosity because Plan 3 ruled that `useItem` is a
    // ONE-TICK PULSE emitted on press, precisely so a held button cannot auto-fire
    // the next item the instant it is granted. Half of all item uses were
    // therefore silently dropped, with no way for the player to tell which half.
    //
    // The ruling: the send path OR-s the boolean fields across the ticks it drops.
    // `brake`, `drift` and `useItem` are latched - set by EITHER tick of the pair
    // - and cleared once sent. `steer` and `accel` are continuous and keep taking
    // the newest value.
    const odd = runPulseRace(9)
    expect(odd.firedAt, 'the pulse raised on an odd tick never reached the authority').toBeGreaterThan(0)

    // Control: the same pulse on an EVEN tick. It always worked, and a test that
    // only checked this one passes without the fix - which is exactly how this
    // shipped.
    const even = runPulseRace(10)
    expect(even.firedAt).toBeGreaterThan(0)
    // Both land within a couple of ticks of each other, so the odd one is really
    // being carried and not merely arriving eventually by some other route.
    expect(Math.abs(odd.firedAt - even.firedAt)).toBeLessThanOrEqual(3)
  })

  it('clears the latch once it has sent, so one press fires one item and not every item after it', () => {
    // The other half of the ruling. A latch that accumulated and never cleared
    // would leave `useItem` true on the wire for the rest of the race, and the
    // very next item granted would be spent on the tick it arrived - which is the
    // auto-fire Plan 3's one-tick pulse exists to prevent.
    const r = runPulseRace(9, 30)
    expect(r.firedAt).toBeGreaterThan(0)
    expect(r.firedAt).toBeLessThan(30)
    expect(
      r.secondFiredAt,
      `the second item was fired on tick ${r.secondFiredAt} with no second press`,
    ).toBe(-1)
  })
})

describe('RemoteInterpolator — the out-parameter contract (per-frame API)', () => {
  /**
   * `sampleKart` and `sampleEntity` are the API Plan 3's renderer is built on,
   * and they used to return a fresh object with a fresh nested `position` on
   * every call. At 60fps over 7 remote karts plus up to 32 entities that is
   * ~4,700 objects/s - half the 9,400/s that was ruled a contract violation
   * rather than a preference when ClientLoop's prediction ring was pooled.
   *
   * The inconsistency was inside one class: `liveEntityIds(out: Int32Array)`
   * already took a caller-owned buffer, with the docstring "for the same reason
   * every other buffer in this package is: a renderer calls this every frame",
   * added in the same task.
   */
  it('fills the caller\'s buffer in place, without replacing its nested objects', () => {
    const ri = new RemoteInterpolator()
    ri.push(kf(1000, [mkRemoteKart(0, 0), mkRemoteKart(0, 0), mkRemoteKart(0, 5)]))
    ri.push(kf(1050, [mkRemoteKart(0, 0), mkRemoteKart(0, 0), mkRemoteKart(0.25, 5)]))

    const out = makeRemoteSample()
    const position = out.position // the object a per-call allocation would replace

    expect(ri.sampleKart(2, 1125, out)).toBe(true)
    expect(out.position).toBe(position)
    expect(out.position.x).toBeCloseTo(0.125, 5)

    // A second call writes the same buffer rather than handing back a new one.
    expect(ri.sampleKart(2, 1150, out)).toBe(true)
    expect(out.position, 'a second sample allocated a fresh position object').toBe(position)
    expect(out.position.x).toBeCloseTo(0.25, 5)
  })

  it('leaves `out` genuinely untouched when it returns false', () => {
    // "false means no sample" is only useful if the buffer is safe to keep: a
    // renderer holds one per seat across frames, and a partially-written one is
    // a kart drawn at half of last frame's position and half of nothing.
    const ri = new RemoteInterpolator()
    const out = makeRemoteSample()

    // Nothing pushed yet.
    out.position.x = 42
    out.position.y = 43
    out.position.z = 44
    out.heading = 1.5
    const kartBefore = out.kart
    expect(ri.sampleKart(1, 1000, out)).toBe(false)
    expect([out.position.x, out.position.y, out.position.z]).toEqual([42, 43, 44])
    expect(out.heading).toBe(1.5)
    expect(out.kart).toBe(kartBefore)
  })

  it('leaves an entity sample untouched when the entity has despawned', () => {
    const ri = new RemoteInterpolator()
    ri.push(kf(1000, [], [mkRemoteEntity(1, 10, 0), mkRemoteEntity(2, 100, 0)]))
    ri.push(kf(1050, [], [mkRemoteEntity(1, 10, 0), mkRemoteEntity(2, 100, 0)]))

    const out = makeRemoteEntitySample()
    expect(ri.sampleEntity(1, 1125, out)).toBe(true)
    expect(out.position.x).toBeCloseTo(10, 5)
    expect(out.entity.entityId).toBe(1)
    const positionObj = out.position

    // Entity 1 despawns; swap-remove leaves entity 2 alone in the front slot.
    ri.push(kf(1100, [], [mkRemoteEntity(2, 100, 0)]))

    expect(ri.sampleEntity(1, 1175, out)).toBe(false)
    // Still exactly the last real sample - NOT entity 2's, and not zeroed.
    expect(out.position).toBe(positionObj)
    expect(out.position.x, 'a false return half-wrote the caller\'s buffer').toBeCloseTo(10, 5)
    expect(out.entity.entityId).toBe(1)
  })

  it('the factories hand back independent buffers', () => {
    // A renderer keeps one per seat; two seats sharing a buffer would render the
    // same kart twice, and it would look like an interpolation bug.
    const a = makeRemoteSample()
    const b = makeRemoteSample()
    expect(a).not.toBe(b)
    expect(a.position).not.toBe(b.position)
    const c = makeRemoteEntitySample()
    const d = makeRemoteEntitySample()
    expect(c.position).not.toBe(d.position)
    expect(c.entity.entityId, 'a fresh entity sample must start on the dead-slot sentinel').toBe(-1)
  })
})
