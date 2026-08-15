// Spec §8, the `net` row: "LoopbackTransport at 150ms latency, 50ms jitter, 5% loss; assert client
// converges and stays within epsilon, and that steady-state quantization noise triggers ZERO
// corrections."
//
// Two tests, because that row is two claims measured two different ways, and conflating them is how
// the number gets tuned instead of derived:
//
//   1. END TO END, against a real AuthorityLoop with a real ShadowLoop alongside. The client
//      converges and stays there, and corrects a handful of times across 3240 ticks. NOT zero, and
//      the reason is measured rather than asserted around: a correction rebases a diverged field
//      onto a QUANTISED wire value, so it leaves a velocity residual of up to half a step
//      (0.0156 m/s) that is far below EPS.velocity, invisible to every later comparison, and
//      integrates into position error that crosses EPS.position after 3-6 seconds. Task 15 measured
//      0-2 corrections per 600-tick window across 20 transport seeds and never zero; the startup
//      transient guarantees at least one. An end-to-end literal zero is unreachable - and it is also
//      exactly what a client that received nothing, or never compared anything, reports. Hence the
//      floors on every zero-adjacent number here.
//
//   2. AGAINST A MIRRORED AUTHORITY, where quantisation is the only difference between the two sims.
//      That is the assertion spec §8 actually asks for, and there it is exactly zero. Setting
//      EPS.position below its own quantisation step turns that zero into 296 (Task 15, measured),
//      which is the "unexplained visual buzz" the invariant exists to prevent.
import { describe, expect, it } from 'vitest'

import type { Intent, SimState } from '@tapkart/sim'
import { MAX_KARTS, allocStateLike, cloneState, createState } from '@tapkart/sim'
import { EPS, decodeHeader, encodeHeader, encodeSnapshot } from '@tapkart/protocol'

import { AuthorityLoop } from '../src/authority'
import { ClientLoop } from '../src/client'
import { ShadowLoop } from '../src/shadow'
import { TICK_MS } from '../src/clock'
import { droppedDatagramsOf } from '../src/receive'
import { makeLossyPair, makeNetContext } from './fixtures/net-fixtures'
import { makeThreeWayMesh } from './fixtures/mesh'
import { spyTransport } from './fixtures/spy-transport'

const SEED = 0x20260814

/**
 * All-zero, matching ClientLoop's own bootstrap: it builds its state with `characterIdx` all zero
 * because no lobby handshake exists in this plan. A host built with [0..7] runs seats 1-7 on
 * different CharacterStats, their bot trajectories diverge from the guest's copy of them, and a bot
 * eventually collides with kart 0 - a real physics difference this test would then blame on
 * quantisation.
 */
const CHARS8 = [0, 0, 0, 0, 0, 0, 0, 0]
const OWN = 0

/** 6s. Task 15 measured 180 as flaky for this invariant and settled on 360. */
const WARMUP_TICKS = 360
/** 60s in total. */
const RUN_TICKS = 3600

/**
 * Held steady for the whole run. The authority applies whatever intent it currently HOLDS, which
 * under latency is the value the client sent ~one one-way trip ago; with a constant intent that is
 * the same number the client is predicting on now, so the comparison is isolated to quantisation
 * noise instead of measuring input lag. A varying steer measures 29-39 corrections per 600 ticks and
 * none of them are noise.
 */
const STEADY: Intent = { tick: 0, steer: 0.3, accel: 1, brake: false, drift: false, useItem: false }

/** Every peer starts from the identical world: same seed, same characters, already racing. */
function makeRaceState(ctx: ReturnType<typeof makeNetContext>): SimState {
  const s = createState(ctx, SEED, CHARS8)
  // 'racing' from tick 0, so this run never crosses the start line. Two reasons: a countdown freezes
  // every kart for 180 ticks while the guest (which bootstraps its own phase) would be driving, and
  // the phase-adoption path across the start line has an open defect against Task 15c whose fix
  // would move any number measured across it. The steady-state window this test measures is 3000
  // ticks past any of that.
  s.phase = 'racing'
  // createState defaults every kart to `isBot: true, connected: false`, and resolveInputs routes any
  // !connected kart through bot AI - so without these the authority would ignore the guest entirely
  // and correct it on every single snapshot.
  s.karts[OWN].isBot = false
  s.karts[OWN].connected = true
  // An itemGrant travels the reliable channel independently of the unreliable snapshot stream and
  // can arrive on either side of a snapshot that already reflects it. That is a timing difference,
  // not noise, and this test is about noise.
  for (const box of s.itemBoxes) box.respawnTicks = 1_000_000
  return s
}

describe('convergence at 150ms/50ms/5%, host + guest + shadow (spec §8)', () => {
  it(
    'the guest stays on the authority\'s kart, and the whole stack corrects a handful of times in 3240 ticks',
    () => {
      const hostCtx = makeNetContext(true)
      const clientCtx = makeNetContext(false)
      const shadowCtx = makeNetContext(false)
      const hostState = makeRaceState(hostCtx)
      const shadowState = makeRaceState(shadowCtx)

      // Three real links, one per pair of participants, each with its own loss draw: the guest sends
      // its input to BOTH the host and the shadow (spec §5), and the shadow follows the host's
      // snapshot and event streams at the same time.
      const mesh = makeThreeWayMesh()
      let clientSnapshots = 0
      let shadowSnapshots = 0
      const clientTransport = spyTransport(mesh.client, (_peerId, channel, data) => {
        // decodeHeader, not data[0]: the first payload byte of a bit-packed snapshot is the low byte
        // of state.tick and matches any given constant about once every 256 snapshots.
        if (channel === 'unreliable' && decodeHeader(data).kind === 'snapshot') clientSnapshots++
      })
      const shadowTransport = spyTransport(mesh.shadow, (_peerId, channel, data) => {
        if (channel === 'unreliable' && decodeHeader(data).kind === 'snapshot') shadowSnapshots++
      })

      const host = new AuthorityLoop(hostCtx, hostState, mesh.host)
      const client = new ClientLoop(clientCtx, OWN, clientTransport)
      const shadow = new ShadowLoop(shadowCtx, shadowState, shadowTransport)

      let settleCorrections = -1
      let settleSnapshots = 0
      let nowMs = 0
      let pathLength = 0
      let maxClientGap = 0
      let maxShadowGap = 0
      let previous = { ...client.state().karts[OWN].position }

      for (let t = 0; t < RUN_TICKS; t++) {
        host.tick()
        client.tick(STEADY)
        shadow.tick(nowMs)
        mesh.pump(nowMs)
        nowMs += TICK_MS

        const own = client.state().karts[OWN].position
        pathLength += Math.hypot(own.x - previous.x, own.z - previous.z)
        previous = { ...own }

        if (t === WARMUP_TICKS - 1) {
          settleCorrections = client.corrections()
          settleSnapshots = clientSnapshots
        }
        if (t < WARMUP_TICKS) continue

        // The widest same-tick gap in the measured window, for the guest's own kart and for every
        // kart on the shadow. Not the gap at one arbitrary final instant: that instant can land
        // immediately after a correction, where the gap is zero by construction.
        const auth = hostState.karts[OWN].position
        maxClientGap = Math.max(maxClientGap, Math.hypot(own.x - auth.x, own.z - auth.z))
        for (let k = 0; k < MAX_KARTS; k++) {
          const h = hostState.karts[k]
          const s = shadowState.karts[k]
          maxShadowGap = Math.max(maxShadowGap, Math.hypot(h.position.x - s.position.x, h.position.z - s.position.z))
        }
      }

      // --- the run really happened -----------------------------------------
      // Every zero-adjacent number below is a number a dead transport also produces, so each one is
      // paired with a floor here.
      expect(hostState.tick).toBe(RUN_TICKS)
      expect(client.state().tick).toBe(RUN_TICKS)
      expect(shadowState.tick).toBe(RUN_TICKS)
      // 3240 steady ticks at one broadcast in three is 1080, thinned by 5% loss to ~1026. Measured:
      // 1021 to the guest. 700 is far below any plausible run and far above the silence of a
      // transport that delivered nothing.
      const steadySnapshots = clientSnapshots - settleSnapshots
      expect(
        steadySnapshots,
        `only ${steadySnapshots} snapshots reached the guest in the steady window; a count near zero means the transport delivered nothing and every assertion below is vacuous, not a pass`,
      ).toBeGreaterThanOrEqual(700)
      expect(shadowSnapshots, 'the shadow never heard from the host').toBeGreaterThanOrEqual(700)
      // The guest drove a real distance - measured as PATH LENGTH, not displacement from the grid: a
      // kart that laps the oval returns to where it started, and a displacement floor would then be
      // measuring the shape of the track.
      expect(pathLength, 'the guest never moved, so "converged" is meaningless').toBeGreaterThan(500)
      expect(hostState.karts[OWN].lap.lap, 'the guest never completed a lap').toBeGreaterThanOrEqual(1)
      // Both ends are this build, so nothing undecodable can arrive; a nonzero count here means a
      // frame was mangled in transit and every count below is under-reported.
      expect(droppedDatagramsOf(host)).toBe(0)
      expect(droppedDatagramsOf(client)).toBe(0)
      expect(droppedDatagramsOf(shadow)).toBe(0)

      // --- corrections -------------------------------------------------------
      const steadyCorrections = client.corrections() - settleCorrections
      // Measured on this fixture: 14 across the 3240-tick window, i.e. one sub-decimetre rebase
      // every ~4 seconds. 30 leaves headroom without admitting the regressions that matter:
      // predicting on the raw analog intent instead of its wire form measures ~185 per 600 ticks
      // (Task 15), and anchoring reconciliation at lastProcessedInputTick instead of snap.tick
      // measures ~192 per 600. Both would be four figures here.
      expect(steadyCorrections).toBeLessThanOrEqual(30)
      // The same claim as a rate, which is what "buzzing" means: a correction on ~1.4% of the
      // snapshots that arrived, not on most of them.
      expect(steadyCorrections).toBeLessThanOrEqual(Math.floor(steadySnapshots * 0.05))

      // --- converged, in metres ---------------------------------------------
      // The guest's own kart against the authority's, at the same tick, across the whole window.
      // Measured 1.78 m at the worst instant, sustained for the ~14 ticks between a discrete
      // divergence and the snapshot that repairs it. A client whose reconciler never fires measures
      // 9.14 m here and 3.47 m at the end (verified by mutation), so this bound and the end-state one
      // below both discriminate.
      expect(maxClientGap, 'the guest drifted off the authority\'s world').toBeLessThan(3)
      // ...and the FLOOR that makes the bound a measurement: the two sims genuinely disagree by more
      // than an epsilon at some point in the window. Without this, a test that accidentally compared
      // a state with itself would score a perfect 0 and read as a pass.
      expect(
        maxClientGap,
        'the guest and the authority never disagreed at all - this test is comparing something with itself',
      ).toBeGreaterThan(EPS.position)

      const mine = client.state().karts[OWN]
      const theirs = hostState.karts[OWN]
      expect(Math.abs(mine.position.x - theirs.position.x)).toBeLessThan(0.5)
      expect(Math.abs(mine.position.z - theirs.position.z)).toBeLessThan(0.5)
      expect(Math.abs(mine.velocity.x - theirs.velocity.x)).toBeLessThan(1)
      expect(Math.abs(mine.velocity.z - theirs.velocity.z)).toBeLessThan(1)

      // --- and the server's own copy of the world ----------------------------
      // Spec §5's follower mode, measured over a full minute rather than at one instant: the shadow
      // gets the guest's input over its OWN lossy link, so its copy of kart 0 is genuinely its own
      // work and not a mirror of the host's. Measured 1.65 m at the worst instant.
      expect(maxShadowGap, 'the shadow stopped tracking the host').toBeLessThan(3)
      expect(
        maxShadowGap,
        'the shadow never disagreed with the host at all - it is not simulating independently',
      ).toBeGreaterThan(EPS.position)
      for (let k = 0; k < MAX_KARTS; k++) {
        expect(shadowState.karts[k].lap.lap, `shadow kart ${k} lap`).toBe(hostState.karts[k].lap.lap)
      }
      expect(shadowState.phase).toBe(hostState.phase)
    },
    60_000,
  )
})

/**
 * Spec §8's invariant, isolated: a converged client, fed authoritative wire data that differs from
 * its own prediction by NOTHING BUT the quantisation of `encodeSnapshot`, must take zero corrections.
 *
 * The "authority" is a mirror of the client's own state, re-encoded and sent back through the real
 * lossy transport at the real 20Hz cadence. Against a live AuthorityLoop the two sims also disagree
 * for reasons that have nothing to do with quantisation - the test above measures that composite;
 * this one measures the epsilon table alone.
 *
 * `positionOffsetM` perturbs the mirrored kart before encoding, which is how the control case below
 * proves the harness can tell divergence from noise at all.
 */
function runMirroredAuthority(opts: { ticks: number; positionOffsetM: number }): {
  corrections: number
  snapshotsDelivered: number
  pathLength: number
  topSpeed: number
} {
  const ctx = makeNetContext(false)
  const pair = makeLossyPair() // 150ms latency, 50ms jitter, 5% loss, seed 0xC0FFEE
  let snapshotsDelivered = 0
  const transport = spyTransport(pair.a, (_peerId, channel, data) => {
    if (channel === 'unreliable' && decodeHeader(data).kind === 'snapshot') snapshotsDelivered++
  })
  const client = new ClientLoop(ctx, OWN, transport)

  const mirror = allocStateLike(makeNetContext(true), client.state())
  const buf = new Uint8Array(1024)
  const lastProcessed: number[] = new Array(MAX_KARTS).fill(-1)

  let pathLength = 0
  let topSpeed = 0
  let previous = { ...client.state().karts[OWN].position }
  let nowMs = 0
  for (let t = 0; t < opts.ticks; t++) {
    client.tick(STEADY)
    const k = client.state().karts[OWN]
    topSpeed = Math.max(topSpeed, Math.hypot(k.velocity.x, k.velocity.z))
    pathLength += Math.hypot(k.position.x - previous.x, k.position.z - previous.z)
    previous = { ...k.position }
    if (client.state().tick % 3 === 0) {
      cloneState(client.state(), mirror)
      mirror.karts[OWN].position.x += opts.positionOffsetM
      // Deliberately stale by roughly one one-way trip, exactly as a real authority's per-player
      // input cursor lags its own snapshot tick. Reconciliation anchors on snap.tick and must ignore
      // this.
      lastProcessed[OWN] = Math.max(-1, mirror.tick - 12)
      const h = encodeHeader(buf, 'snapshot')
      const n = encodeSnapshot(buf.subarray(h), mirror, lastProcessed)
      pair.b.broadcast('unreliable', buf.slice(0, h + n))
    }
    pair.pump(nowMs)
    nowMs += TICK_MS
  }

  return { corrections: client.corrections(), snapshotsDelivered, pathLength, topSpeed }
}

describe('steady-state quantisation noise triggers zero corrections (spec §8)', () => {
  it('is exactly zero over 1800 ticks against a mirrored authority', () => {
    const r = runMirroredAuthority({ ticks: 1800, positionOffsetM: 0 })

    expect(r.corrections).toBe(0)

    // The controls without which that zero proves nothing. A client that received nothing, or one
    // whose kart never moved, reports the same zero.
    // 1800 ticks at one broadcast in three is 600, thinned by 5% loss to ~570.
    expect(
      r.snapshotsDelivered,
      `only ${r.snapshotsDelivered} snapshots reached the client; a count near zero means the transport delivered nothing and the zero above is vacuous, not a pass`,
    ).toBeGreaterThanOrEqual(400)
    expect(r.pathLength, 'the kart never moved, so no quantised field was exercised').toBeGreaterThan(300)
    expect(r.topSpeed).toBeGreaterThan(20)
  }, 60_000)

  it('control: the same harness with a beyond-epsilon offset corrects on a large share of snapshots', () => {
    // The positive control for the zero above. Same client, same transport, same seed, same intent -
    // one field pushed three epsilons past its dead band. If THIS did not fire, the zero above would
    // be measuring a comparison that never runs, which is the failure this file exists to rule out.
    //
    // It is also the concrete form of the epsilon-below-its-step defect: EPS.position is 0.05 against
    // a 0.03125 step, and writeFloatQ rounds to nearest, so the worst round-trip error is half a step
    // (0.0156). Tightening EPS.position to 0.01 turns the zero above into 296 corrections (Task 15,
    // measured) - the same behaviour this control produces deliberately.
    //
    // Not EVERY snapshot: a correction shifts the whole replayed trajectory by the offset, so roughly
    // every other snapshot then lands back inside the dead band.
    const r = runMirroredAuthority({ ticks: 600, positionOffsetM: EPS.position * 3 })
    expect(r.snapshotsDelivered).toBeGreaterThanOrEqual(140)
    expect(r.corrections).toBeGreaterThanOrEqual(40)
    expect(r.corrections).toBeGreaterThanOrEqual(Math.floor(r.snapshotsDelivered * 0.25))
  }, 60_000)
})
