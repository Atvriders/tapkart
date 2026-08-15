// Spec §8's golden-replay instrument, pointed at the whole netcode stack instead of at `step()`
// alone: a recorded input stream, replayed through a real AuthorityLoop, a real ClientLoop and a
// real ShadowLoop over three lossy links, compared to a stored expectation FIELD BY FIELD.
//
// "Golden-replay compares fields, not hashes. Hashing float state produces a test that fails
// informatively never and mysteriously often." - spec §8. Every assertion below that touches state
// goes through Plan 1's `diffAgainstGolden`, which reports the path, both values, the delta and the
// tolerance for each differing field.
//
// Regeneration lives in golden-net-regen.test.ts, so a missing or unloadable fixture cannot take
// the regenerator down with it.
//
// WHAT THIS FIXTURE IS, AND WHAT IT IS NOT. The golden is a CHANGE DETECTOR, not a correctness
// oracle. Every number in golden-net-run.json is whatever this stack produced on the day it was
// recorded; nothing here asserts that any of them is RIGHT. Its whole value is that it fails when
// whole-stack behaviour moves - which is exactly the class of change no per-file test sees - and
// its whole danger is being regenerated to make a red suite green, which converts a detected
// regression into a recorded one.
//
// The correctness oracle is convergence.test.ts. That file asserts properties that are true or
// false independently of any recording: a converged client corrects zero times (spec §8), a
// follower's counters advance only by the rules contract §1b gives them, a lap never regresses.
// When the two disagree, convergence.test.ts is the one that is making a claim.
//
// So: a failure here means STOP AND READ THE DIFF. Regenerate only once you can name the change
// that moved it and say why the new numbers are the ones you want.
import { beforeAll, describe, expect, it } from 'vitest'

import { COUNTDOWN_TICKS, MAX_ENTITIES, MAX_KARTS } from '@tapkart/sim'

import type { GoldenNetFixture, GoldenNetRun } from './fixtures/golden-net'
import {
  GOLDEN_NET_CHARACTER_IDX,
  GOLDEN_NET_FORMAT_VERSION,
  GOLDEN_NET_PLAYER_ID,
  GOLDEN_NET_PROFILE,
  GOLDEN_NET_REGEN_COMMAND,
  GOLDEN_NET_SEED,
  GOLDEN_NET_TICKS,
  goldenNetTransportBlock,
  loadGoldenNetFixture,
  packSeatIntents,
  readGoldenNetFixtureText,
  replayGoldenNet,
  runGoldenNet,
  unpackSeatIntents,
} from './fixtures/golden-net'
import { makeNetContext } from './fixtures/net-fixtures'
import {
  INTENT_BYTES_PER_KART,
  INTENT_SCALE,
  decodeB64Lines,
} from '../../sim/test/fixtures/golden-format'
import type { GoldenExpectation } from '../../sim/test/fixtures/golden-format'
import { diffAgainstGolden, formatDiffs } from '../../sim/test/fixtures/golden-harness'

let fixture: GoldenNetFixture
let run: GoldenNetRun

beforeAll(() => {
  fixture = loadGoldenNetFixture()
  run = replayGoldenNet(fixture)
}, 120_000)

function clone(e: GoldenExpectation): GoldenExpectation {
  return JSON.parse(JSON.stringify(e)) as GoldenExpectation
}

describe('golden net run: metadata', () => {
  it('is the run it claims to be', () => {
    const ctx = makeNetContext(true)
    expect(fixture.formatVersion).toBe(GOLDEN_NET_FORMAT_VERSION)
    expect(fixture.generatedBy).toBe(GOLDEN_NET_REGEN_COMMAND)
    expect(fixture.trackId).toBe(ctx.track.id)
    expect(fixture.raceSeed).toBe(GOLDEN_NET_SEED)
    expect(fixture.characterIdx).toEqual(GOLDEN_NET_CHARACTER_IDX)
    expect(fixture.drivenPlayerId).toBe(GOLDEN_NET_PLAYER_ID)
    expect(fixture.tickCount).toBe(GOLDEN_NET_TICKS)
    expect(fixture.intentScale).toBe(INTENT_SCALE)

    // The network the run was recorded over, pinned by value: these are spec §8's conditions, and a
    // fixture recorded over a different profile is a different experiment.
    expect(fixture.transport).toEqual(goldenNetTransportBlock())
    expect(GOLDEN_NET_PROFILE.latencyMs).toBe(150)
    expect(GOLDEN_NET_PROFILE.jitterMs).toBe(50)
    expect(GOLDEN_NET_PROFILE.lossRate).toBe(0.05)
    // Three DIFFERENT link seeds. One shared seed would make host->client and host->shadow lose the
    // same datagrams on the same ticks, and the run would never exercise one peer missing what
    // another received.
    const seeds = [
      fixture.transport.hostClientSeed,
      fixture.transport.hostShadowSeed,
      fixture.transport.clientShadowSeed,
    ]
    expect(new Set(seeds).size).toBe(3)

    // The stream covers every tick of the run: one 5-byte record per tick for the one human seat.
    const bytes = decodeB64Lines(fixture.intentsB64)
    expect(bytes.length).toBe(fixture.tickCount * INTENT_BYTES_PER_KART)
  })

  it('carries no timestamp, hostname or absolute path', () => {
    const raw = readGoldenNetFixtureText()
    expect(Object.keys(fixture).sort()).toEqual([
      'characterIdx',
      'client',
      'counters',
      'drivenPlayerId',
      'formatVersion',
      'generatedBy',
      'host',
      'intentScale',
      'intentsB64',
      'raceSeed',
      'shadow',
      'tickCount',
      'trackId',
      'transport',
    ])
    expect(raw).not.toMatch(/\/home\//)
    expect(raw).not.toMatch(/\/Users\//)
    expect(raw).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/)
  })

  it('round-trips its own intent stream', () => {
    // The stored stream and the stream the replay actually played are the same bytes. Without this,
    // a packing bug could quietly play something other than what is stored and every comparison
    // below would still agree - because both halves would share the bug.
    const stored = decodeB64Lines(fixture.intentsB64)
    expect(Array.from(packSeatIntents(run.intents))).toEqual(Array.from(stored))
    const unpacked = unpackSeatIntents(stored, fixture.tickCount)
    expect(unpacked).toHaveLength(GOLDEN_NET_TICKS)
    // ...and it is a stream a human could have produced: not eight zeroed rows repeated.
    const distinctSteer = new Set(unpacked.map((i) => i.steer))
    expect(distinctSteer.size).toBeGreaterThan(20)
    expect(unpacked.some((i) => i.accel > 0.5)).toBe(true)
  })
})

describe('golden net run: the stored world, field by field', () => {
  it("reproduces the authority's SimState exactly", () => {
    const diffs = diffAgainstGolden(fixture.host, run.host)
    expect(formatDiffs(diffs)).toBe('')
    expect(diffs).toHaveLength(0)
    expect(run.host.tick).toBe(GOLDEN_NET_TICKS)
    expect(run.host.karts).toHaveLength(MAX_KARTS)
    expect(run.host.entities).toHaveLength(MAX_ENTITIES)
  })

  it("reproduces the guest's predicted SimState exactly", () => {
    const diffs = diffAgainstGolden(fixture.client, run.client)
    expect(formatDiffs(diffs)).toBe('')
    expect(run.client.tick).toBe(GOLDEN_NET_TICKS)
  })

  it("reproduces the server shadow's published SimState exactly", () => {
    const diffs = diffAgainstGolden(fixture.shadow, run.shadow)
    expect(formatDiffs(diffs)).toBe('')
    expect(run.shadow.tick).toBe(GOLDEN_NET_TICKS)
  })

  it('reproduces the stored counters', () => {
    // Not decoration: `corrections` is the reconciler's own tally, the snapshot and event counts are
    // what actually crossed each link under 5% loss, and `dropped` is the guard's. A netcode change
    // that leaves every kart within a micrometre can still move these.
    expect(run.counters).toEqual(fixture.counters)
  })

  it('is deterministic across two runs in the same process', () => {
    const again = replayGoldenNet(fixture)
    expect(formatDiffs(diffAgainstGolden(fixture.host, again.host))).toBe('')
    expect(formatDiffs(diffAgainstGolden(fixture.client, again.client))).toBe('')
    expect(formatDiffs(diffAgainstGolden(fixture.shadow, again.shadow))).toBe('')
    expect(again.counters).toEqual(fixture.counters)
  }, 120_000)
})

describe('golden net run: the race the fixture claims really happened', () => {
  // Everything here is asserted against the RUN, never against the fixture, so it still holds if the
  // fixture were regenerated from broken code. A golden file records what the code does; these
  // record what the code must do.
  it('ran a real race: laps, items, events, and no dropped datagram', () => {
    // The whole run is inside 'racing' by construction (see makeRaceState) and never crosses the
    // start line, so no stored number here depends on the phase-adoption defect open against
    // Task 15c. The guest still had to LEARN the phase off the wire: it bootstraps in 'countdown'
    // and its own inference would not have reached 'racing' until tick COUNTDOWN_TICKS.
    expect(run.host.phase).toBe('racing')
    expect(run.client.phase).toBe('racing')
    expect(GOLDEN_NET_TICKS).toBeGreaterThan(COUNTDOWN_TICKS)
    // Every kart got round the oval at least once, so this is a race and not eight karts idling on
    // the grid for 20 seconds.
    for (let i = 0; i < MAX_KARTS; i++) {
      expect(run.host.karts[i].lap.lap, `kart ${i} never completed a lap`).toBeGreaterThanOrEqual(1)
    }
    // The authority rolled items and announced them: `nextEventSeq` advances only through emit().
    expect(run.counters.hostEventSeq).toBeGreaterThan(5)
    expect(run.counters.eventDatagramsToClient).toBeGreaterThan(0)
    expect(run.counters.eventDatagramsToShadow).toBeGreaterThan(0)
    // Snapshots really crossed both links. 1200 ticks at one broadcast in three is 400, thinned by
    // 5% loss to ~380; 300 is far below any plausible run and far above a silent transport.
    expect(run.counters.snapshotsToClient).toBeGreaterThanOrEqual(300)
    expect(run.counters.snapshotsToShadow).toBeGreaterThanOrEqual(300)
    // Both ends are this build, so nothing undecodable can arrive.
    expect(run.counters.droppedHost).toBe(0)
    expect(run.counters.droppedClient).toBe(0)
    expect(run.counters.droppedShadow).toBe(0)
  })

  it('left the guest and the shadow on the authority\'s world, not on worlds of their own', () => {
    const own = GOLDEN_NET_PLAYER_ID
    const h = run.host.karts[own]
    const c = run.client.karts[own]
    // The guest's own kart, against the authority's, at the same tick. A metre-scale band, not EPS:
    // the two loops are at the same tick number but not the same instant of information (the epsilon
    // claim belongs to the comparison at snap.tick, which convergence.test.ts measures).
    expect(Math.hypot(c.position.x - h.position.x, c.position.z - h.position.z)).toBeLessThan(3)
    expect(c.lap.lap).toBe(h.lap.lap)
    // ...and the shadow's whole world against the authority's.
    for (let i = 0; i < MAX_KARTS; i++) {
      const s = run.shadow.karts[i]
      const a = run.host.karts[i]
      expect(
        Math.hypot(s.position.x - a.position.x, s.position.z - a.position.z),
        `shadow kart ${i} is not on the authority's world`,
      ).toBeLessThan(3)
      expect(s.lap.lap, `shadow kart ${i} lap`).toBe(a.lap.lap)
    }
    expect(run.shadow.phase).toBe(run.host.phase)
  })
})

describe('golden net run: the comparison can fail', () => {
  it('names the field when a stored value is corrupted', () => {
    // Below tolerance: 1e-9 m against a 1e-6 m band is not a difference.
    const under = clone(fixture.host)
    under.karts[3].position[0] += 1e-9
    expect(diffAgainstGolden(under, run.host)).toHaveLength(0)

    // Above it: exactly one named difference, with the delta.
    const over = clone(fixture.host)
    over.karts[3].position[0] += 0.5
    const posDiffs = diffAgainstGolden(over, run.host)
    expect(posDiffs).toHaveLength(1)
    expect(posDiffs[0].path).toBe('karts[3].position.x')
    expect(posDiffs[0].delta).toBeCloseTo(-0.5, 6)

    // An integer field has no band at all.
    const lap = clone(fixture.client)
    lap.karts[GOLDEN_NET_PLAYER_ID].lap.lap += 1
    const lapDiffs = diffAgainstGolden(lap, run.client)
    expect(lapDiffs).toHaveLength(1)
    expect(lapDiffs[0].path).toBe(`karts[${GOLDEN_NET_PLAYER_ID}].lap.lap`)
    expect(lapDiffs[0].tolerance).toBe(0)
  })

  it('catches a one-part-in-a-hundred change to one input frame, on every peer', () => {
    // The STACK's sensitivity, not the comparator's. One 30Hz input frame - both ticks of one pair,
    // 600 and 601 of 1200 - steered 0.01 further, which is a little over one code of encodeInput's
    // 8-bit steer grid (2/255 = 0.0078). To move the numbers below, that change has to survive the
    // quantiser, cross a 5%-lossy link inside the redundant window, be held by the authority across
    // both ticks of the pair, reach the shadow over a DIFFERENT lossy link, and come back to the
    // guest through a snapshot. If any part of that stops happening this test goes green while the
    // golden comparison above also stays green - which is exactly the pair of passes that would hide
    // a stack that had quietly stopped carrying input at all.
    //
    // A FRAME and not a single tick, because a single tick provably cannot matter: the guest sends
    // on `predicted.tick % 2 === 0`, so only every other one of its 60Hz intents is ever put on the
    // wire, and bending the other one changes nothing anywhere - measured, and true even for
    // steer=-1 with accel=0. That is spec §5's 30Hz input rate working as designed, but it does mean
    // a one-tick input spike is invisible to the authority. Bending both ticks of the pair makes
    // this test independent of WHICH half of each pair the sender happens to sample.
    const bent = run.intents.map((i) => ({ ...i }))
    bent[600].steer = Math.min(1, bent[600].steer + 0.01)
    bent[601].steer = Math.min(1, bent[601].steer + 0.01)
    const bentRun = runGoldenNet(bent, GOLDEN_NET_TICKS)

    const own = GOLDEN_NET_PLAYER_ID
    for (const [who, exp, act] of [
      ['host', fixture.host, bentRun.host],
      ['client', fixture.client, bentRun.client],
      ['shadow', fixture.shadow, bentRun.shadow],
    ] as const) {
      const paths = diffAgainstGolden(exp, act).map((d) => d.path)
      expect(paths, `${who} did not notice the bent input frame`).toContain(`karts[${own}].position.x`)
    }
    // ...and it is a real displacement, not a last-bit wobble: ~0.12 m by the end of the run on the
    // authority, which is 100000x the 1e-6 comparison band.
    expect(
      Math.abs(bentRun.host.karts[own].position.x - run.host.karts[own].position.x),
    ).toBeGreaterThan(0.01)
  }, 120_000)
})
