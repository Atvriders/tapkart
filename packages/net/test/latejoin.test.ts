// Spec §5's `AuthorityCheckpoint`: "a full-precision serialization of SimState - every kart field,
// every entity, item-box timers, PRNG cursor, race phase, tick, and eventSeq - sent on the reliable
// channel. Used for late join, for a client whose reconciliation has diverged past recovery, and for
// shadow resync after a network partition."
//
// Three claims, in the order they build on each other:
//
//   1. The serialization really is full-precision: decode(encode(s)) equals `s` by the sim's own
//      `statesEqual` (Object.is on every field), for a state produced by 400 ticks of real racing
//      rather than a hand-populated one.
//   2. It is what a LATE JOINER cannot do without. A joiner that only listens to the snapshot stream
//      is positionally correct within a dozen ticks - `WireSnapshot` carries every kart and entity,
//      and ShadowLoop hard-snaps onto a snapshot it cannot rewind to - and is still missing exactly
//      the fields no snapshot carries: the PRNG cursor and the item-box timers. Spec §5's "a passive
//      server cannot reconstruct a valid state at all (no PRNG cursor, no entity state, no input
//      buffers, no event sequence)" is measured here rather than quoted, by running two joiners side
//      by side and sending only one of them a checkpoint.
//   3. A state restored from a checkpoint keeps running bit-identically, which is Plan 1's
//      checkpoint-replay equivalence (spec §8) carried across the wire format a real joiner receives.
import { describe, expect, it } from 'vitest'

import type { SimContext, SimState } from '@tapkart/sim'
import {
  MAX_KARTS,
  createState,
  makeIntentBuffer,
  statesEqual,
  step,
} from '@tapkart/sim'
import { decodeCheckpoint, encodeCheckpoint, encodeHeader } from '@tapkart/protocol'

import { AuthorityLoop } from '../src/authority'
import { ShadowLoop } from '../src/shadow'
import { TICK_MS } from '../src/clock'
import { droppedDatagramsOf } from '../src/receive'
import { makeLossyPair, makeNetContext } from './fixtures/net-fixtures'
import { scriptedIntent } from './fixtures/scripted-input'

const SEED = 0x20260814
const CHARS8 = [0, 0, 0, 0, 0, 0, 0, 0]

/**
 * Task 8 measures `encodeCheckpoint` at 5384 bytes for this SimState shape. `DataView.setFloat64`
 * past the end of the view throws RangeError, so an undersized buffer here fails loudly - unlike a
 * snapshot, where `BitWriter` overflows silently.
 */
const CHECKPOINT_BUF_BYTES = 8192

function makeRaceState(ctx: SimContext): SimState {
  const s = createState(ctx, SEED, CHARS8)
  // Racing from tick 0: this file is about the checkpoint, and a countdown would spend its first
  // 180 ticks with every kart frozen.
  s.phase = 'racing'
  return s
}

describe('AuthorityCheckpoint is full precision (spec §5)', () => {
  it('round-trips a raced-in SimState exactly, not merely closely', () => {
    const ctx = makeNetContext(true)
    let cur = makeRaceState(ctx)
    let scratch = makeRaceState(ctx)
    const inputs = makeIntentBuffer()
    for (let t = 0; t < 400; t++) {
      inputs[0] = scriptedIntent(t, 0)
      step(ctx, cur, scratch, inputs, [])
      const tmp = cur
      cur = scratch
      scratch = tmp
    }
    // A state worth round-tripping: 400 ticks of racing have moved the karts, spun the PRNG and put
    // item boxes on timers, so this is not an all-zero struct agreeing with itself.
    expect(cur.tick).toBe(400)
    expect(Math.hypot(cur.karts[0].velocity.x, cur.karts[0].velocity.z)).toBeGreaterThan(5)

    const buf = new Uint8Array(CHECKPOINT_BUF_BYTES)
    const n = encodeCheckpoint(buf, cur)
    expect(n).toBeGreaterThan(0)

    const decoded = createState(ctx, SEED, CHARS8) // preallocates the right shape
    decodeCheckpoint(buf.subarray(0, n), decoded)
    expect(
      statesEqual(cur, decoded),
      'a full-precision checkpoint must round-trip exactly, per spec §5',
    ).toBe(true)

    // ...and the comparator can tell: one millimetre is a difference, because statesEqual is
    // Object.is on every field and not an epsilon.
    decoded.karts[2].position.x += 0.001
    expect(statesEqual(cur, decoded)).toBe(false)
  })

  it('a state restored from the wire keeps running bit-identically for 800 more ticks', () => {
    const ctx = makeNetContext(true)
    let source = makeRaceState(ctx)
    let sourceScratch = makeRaceState(ctx)
    const inputs = makeIntentBuffer()
    const drive = (state: SimState, scratch: SimState, t: number): [SimState, SimState] => {
      inputs[0] = scriptedIntent(t, 0)
      step(ctx, state, scratch, inputs, [])
      return [scratch, state]
    }
    for (let t = 0; t < 400; t++) {
      ;[source, sourceScratch] = drive(source, sourceScratch, t)
    }

    const buf = new Uint8Array(CHECKPOINT_BUF_BYTES)
    const n = encodeCheckpoint(buf, source)
    let joiner = createState(ctx, SEED, CHARS8)
    decodeCheckpoint(buf.subarray(0, n), joiner)
    let joinerScratch = createState(ctx, SEED, CHARS8)
    expect(statesEqual(source, joiner)).toBe(true)

    for (let t = 400; t < 1200; t++) {
      ;[source, sourceScratch] = drive(source, sourceScratch, t)
      ;[joiner, joinerScratch] = drive(joiner, joinerScratch, t)
      expect(
        statesEqual(source, joiner),
        `the source and the checkpoint-restored joiner diverged at tick ${t}`,
      ).toBe(true)
    }
    expect(source.tick).toBe(1200)
  }, 60_000)
})

describe('late join over the wire, mid-race (spec §5, §8)', () => {
  it('the snapshot stream places a late joiner; only the checkpoint restores what snapshots cannot carry', () => {
    const hostCtx = makeNetContext(true)
    const hostState = makeRaceState(hostCtx)
    // Two independent links, so the two joiners get independent loss draws and neither can be said
    // to have won by sharing the other's luck.
    const withCheckpointLink = makeLossyPair({ seed: 0x1a7e01 })
    const withoutCheckpointLink = makeLossyPair({ seed: 0x1a7e02 })
    // One AuthorityLoop, one transport: it broadcasts to both links through a fan-out written here
    // rather than through the mesh fixture, because this topology is one host and two joiners.
    const host = new AuthorityLoop(hostCtx, hostState, {
      send(channel, peerId, data) {
        withCheckpointLink.a.send(channel, peerId, data)
        withoutCheckpointLink.a.send(channel, peerId, data)
      },
      broadcast(channel, data) {
        withCheckpointLink.a.broadcast(channel, data)
        withoutCheckpointLink.a.broadcast(channel, data)
      },
      onMessage(cb) {
        withCheckpointLink.a.onMessage(cb)
        withoutCheckpointLink.a.onMessage(cb)
      },
      onPeerLost(cb) {
        withCheckpointLink.a.onPeerLost(cb)
        withoutCheckpointLink.a.onPeerLost(cb)
      },
      peers: () => ['joinerA', 'joinerB'],
      close() {
        withCheckpointLink.a.close()
        withoutCheckpointLink.a.close()
      },
    })

    // --- the race runs with nobody listening, until there is something to restore ---
    // The join instant is DERIVED, not guessed: it is the first tick at which both of the fields no
    // WireSnapshot carries are nonzero on the authority - the PRNG cursor (spec §5's own example of
    // why a passive server cannot reconstruct state) and an item-box respawn timer. Without both,
    // the comparison this test turns on would be "0 equals 0" and could not fail. An earlier
    // hardcoded 1200 landed in a window where every box timer had already expired.
    let nowMs = 0
    const startX = hostState.karts[0].position.x
    const startZ = hostState.karts[0].position.z
    // Where every kart was on every authoritative tick. A late joiner settles ONE ONE-WAY TRIP
    // behind the host's tick number (it hard-snaps onto a snapshot that was already ~12 ticks old
    // when it arrived, and thereafter reconciles in-window from that baseline), so comparing its
    // world against the host's CURRENT world would be measuring that lag - about 6 m at racing
    // speed - and calling it error. The comparison that means "the joiner has the right world" is
    // against the host's world AT THE JOINER'S OWN TICK.
    const hostTrace = new Map<number, { x: number; z: number }[]>()
    const recordHost = (): void => {
      hostTrace.set(hostState.tick, hostState.karts.map((k) => ({ x: k.position.x, z: k.position.z })))
    }
    const MAX_PRE_JOIN_TICKS = 3000
    let joinTick = -1
    for (let t = 0; t < MAX_PRE_JOIN_TICKS; t++) {
      host.tick()
      recordHost()
      withCheckpointLink.pump(nowMs)
      withoutCheckpointLink.pump(nowMs)
      nowMs += TICK_MS
      if (hostState.rngCursor > 0 && hostState.itemBoxes.some((b) => b.respawnTicks > 0)) {
        joinTick = hostState.tick
        break
      }
    }
    expect(joinTick, 'the host never rolled an item, so there is nothing to restore').toBeGreaterThan(300)
    const RACE_BEFORE_JOIN = joinTick
    expect(hostState.rngCursor).toBeGreaterThan(0)
    expect(hostState.itemBoxes.some((b) => b.respawnTicks > 0)).toBe(true)
    // ...and the race is genuinely under way, so "the joiner caught up" means something.
    expect(
      Math.hypot(hostState.karts[0].position.x - startX, hostState.karts[0].position.z - startZ),
      'the host kart never left the grid',
    ).toBeGreaterThan(50)

    // --- two joiners attach, mid-race ---------------------------------------
    const joinerACtx = makeNetContext(false)
    const joinerBCtx = makeNetContext(false)
    const joinerAState = createState(joinerACtx, SEED, CHARS8) // gets a checkpoint
    const joinerBState = createState(joinerBCtx, SEED, CHARS8) // gets only snapshots
    const joinerA = new ShadowLoop(joinerACtx, joinerAState, withCheckpointLink.b)
    const joinerB = new ShadowLoop(joinerBCtx, joinerBState, withoutCheckpointLink.b)
    expect(joinerAState.tick).toBe(0)
    expect(joinerAState.rngCursor).toBe(0)

    const runBoth = (ticks: number): void => {
      for (let t = 0; t < ticks; t++) {
        host.tick()
        recordHost()
        joinerA.tick(nowMs)
        joinerB.tick(nowMs)
        withCheckpointLink.pump(nowMs)
        withoutCheckpointLink.pump(nowMs)
        nowMs += TICK_MS
      }
    }

    /** The joiner's karts against the authority's, at the joiner's own tick. */
    const gapAgainstHostAtSameTick = (s: SimState): number => {
      const authoritative = hostTrace.get(s.tick)
      if (authoritative === undefined) {
        throw new Error(`latejoin: no authoritative record for tick ${s.tick} (host is at ${hostState.tick})`)
      }
      let worst = 0
      for (let k = 0; k < MAX_KARTS; k++) {
        worst = Math.max(worst, Math.hypot(s.karts[k].position.x - authoritative[k].x, s.karts[k].position.z - authoritative[k].z))
      }
      return worst
    }

    // 60 ticks of listening to the snapshot stream alone. Both joiners hard-snap onto the first
    // snapshot they cannot rewind to, so both are now standing in the right place at the right tick.
    runBoth(60)
    for (const [name, s] of [['A', joinerAState], ['B', joinerBState]] as const) {
      expect(s.tick, `joiner ${name} never adopted the host's tick`).toBeGreaterThan(RACE_BEFORE_JOIN)
      // It is behind by one one-way trip and no more - measured 12 ticks, which is 150ms of latency
      // plus up to 50ms of jitter at 60Hz. A joiner that fell further behind every tick, or that
      // ran AHEAD of the authority, fails here.
      const lag = hostState.tick - s.tick
      expect(lag, `joiner ${name} is ${lag} ticks off the host`).toBeGreaterThanOrEqual(0)
      expect(lag, `joiner ${name} is ${lag} ticks behind the host`).toBeLessThanOrEqual(15)
      const d = gapAgainstHostAtSameTick(s)
      expect(d, `joiner ${name} is ${d.toFixed(3)}m from the world the host had at tick ${s.tick}`).toBeLessThan(1)
    }
    // ...and both are still missing what no WireSnapshot carries. This is the gap AuthorityCheckpoint
    // exists to close, measured before it is closed.
    expect(joinerAState.rngCursor).toBe(0)
    expect(joinerBState.rngCursor).toBe(0)
    expect(joinerAState.rngCursor).not.toBe(hostState.rngCursor)
    expect(joinerAState.itemBoxes.map((b) => b.respawnTicks)).not.toEqual(
      hostState.itemBoxes.map((b) => b.respawnTicks),
    )

    // --- joiner A is sent one AuthorityCheckpoint ---------------------------
    // On the reliable channel, framed with the contract's shared header, exactly as a server would
    // send it. Nothing in `net` originates a checkpoint today (no loop broadcasts one - that is
    // Plan 4's lobby/join flow), so the test plays that part; everything downstream of the wire is
    // the real ShadowLoop path.
    const buf = new Uint8Array(CHECKPOINT_BUF_BYTES)
    const h = encodeHeader(buf, 'checkpoint')
    const n = encodeCheckpoint(buf.subarray(h), hostState)
    const hostAtCheckpoint = { rngCursor: hostState.rngCursor, tick: hostState.tick, nextEventSeq: hostState.nextEventSeq, boxes: hostState.itemBoxes.map((b) => b.respawnTicks) }
    withCheckpointLink.a.broadcast('reliable', buf.slice(0, h + n))

    // Long enough for the reliable channel's 150ms to elapse and the loop to apply it at the top of
    // its next tick.
    runBoth(15)

    // Joiner A now holds the fields the snapshot stream never carried. The comparison is against the
    // host AT THE CHECKPOINT INSTANT, not against the host now: a follower never advances rngCursor
    // (it never rolls an item), so the host has moved on and A is correctly frozen where the
    // checkpoint left it.
    expect(joinerAState.rngCursor, 'the checkpoint did not restore the PRNG cursor').toBe(hostAtCheckpoint.rngCursor)
    // Exact, not >=: the checkpoint carries `nextEventSeq` and no event was emitted in the 15 ticks
    // between the checkpoint being taken and this line (the host emits about once every 45 ticks on
    // this fixture). If a future change puts one there, the honest repair is >= the checkpoint's
    // value, not deleting the assertion - a follower's counter can only be advanced by applyEvent.
    expect(joinerAState.nextEventSeq).toBe(hostAtCheckpoint.nextEventSeq)
    // The item-box timers, which have ticked down by exactly the number of ticks since the
    // checkpoint was taken on both sides.
    const elapsed = joinerAState.tick - hostAtCheckpoint.tick
    expect(elapsed).toBeGreaterThan(0)
    expect(joinerAState.itemBoxes.map((b) => b.respawnTicks)).toEqual(
      hostAtCheckpoint.boxes.map((v) => Math.max(0, v - elapsed)),
    )
    // Joiner B, which got no checkpoint, is still exactly as wrong as it was - it is not the passage
    // of time that fixes this.
    expect(joinerBState.rngCursor, 'joiner B repaired itself without a checkpoint').toBe(0)

    // --- and A keeps following the host for another 10s ---------------------
    const lapMax = joinerAState.karts.map((k) => k.lap.lap)
    for (let t = 0; t < 600; t++) {
      runBoth(1)
      for (let k = 0; k < MAX_KARTS; k++) {
        expect(joinerAState.karts[k].lap.lap, `joiner A's lap regressed for kart ${k}`).toBeGreaterThanOrEqual(lapMax[k])
        lapMax[k] = joinerAState.karts[k].lap.lap
      }
    }
    const finalLag = hostState.tick - joinerAState.tick
    expect(finalLag, `joiner A ended ${finalLag} ticks off the host`).toBeGreaterThanOrEqual(0)
    expect(finalLag).toBeLessThanOrEqual(15)
    const finalGap = gapAgainstHostAtSameTick(joinerAState)
    expect(
      finalGap,
      `joiner A's world was ${finalGap.toFixed(3)}m from the host's at tick ${joinerAState.tick}, ten seconds after the resync`,
    ).toBeLessThan(1)
    // Laps are compared against the host's world at the joiner's own tick too - a kart that crossed
    // the line in the twelve ticks the joiner has not reached yet is not a disagreement. The host's
    // lap counters only ever go up, so "not ahead, and no more than one behind" is the honest form.
    for (let k = 0; k < MAX_KARTS; k++) {
      const lapDelta = hostState.karts[k].lap.lap - joinerAState.karts[k].lap.lap
      expect(lapDelta, `joiner A's kart ${k} lap is ${lapDelta} off the host`).toBeGreaterThanOrEqual(0)
      expect(lapDelta).toBeLessThanOrEqual(1)
    }
    // The whole exchange was decodable: a nonzero count here means a checkpoint or a snapshot was
    // mangled and the joiner recovered by luck.
    expect(droppedDatagramsOf(joinerA)).toBe(0)
    expect(droppedDatagramsOf(joinerB)).toBe(0)
    expect(droppedDatagramsOf(host)).toBe(0)
  }, 60_000)
})
