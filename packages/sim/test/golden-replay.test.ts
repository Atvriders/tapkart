import { beforeAll, describe, expect, it } from 'vitest'

import type { SimContext } from '../src/types'
import { COUNTDOWN_TICKS, MAX_ENTITIES, MAX_KARTS, RACE_LAPS } from '../src/types'
import { makeContext, makeOvalTrack, makeTuning } from './fixtures/track-fixtures'
import type { GoldenExpectation, GoldenFixture } from './fixtures/golden-format'
import {
  GOLDEN_CHARACTER_IDX,
  GOLDEN_FORMAT_VERSION,
  GOLDEN_REGEN_COMMAND,
  GOLDEN_SEED,
  GOLDEN_TOL,
  INTENT_BYTES_PER_KART,
  INTENT_SCALE,
  MAX_GOLDEN_TICKS,
  decodeB64Lines,
  loadGoldenFixture,
  readGoldenFixtureText,
} from './fixtures/golden-format'
import {
  checkDrivability,
  diffAgainstGolden,
  diffEventSummary,
  formatDiffs,
  replayGoldenFixture,
  summarizeEvents,
} from './fixtures/golden-harness'
import type { GoldenRun } from './fixtures/golden-harness'

function clone(e: GoldenExpectation): GoldenExpectation {
  return JSON.parse(JSON.stringify(e)) as GoldenExpectation
}

let ctx: SimContext
let fixture: GoldenFixture
let run: GoldenRun

beforeAll(() => {
  ctx = makeContext(makeOvalTrack())
  fixture = loadGoldenFixture()
  run = replayGoldenFixture(ctx, fixture)
}, 180_000)

describe('golden fixture: 3-lap 8-bot race on makeOvalTrack', () => {
  it('is the race it claims to be', () => {
    expect(fixture.formatVersion).toBe(GOLDEN_FORMAT_VERSION)
    expect(fixture.generatedBy).toBe(GOLDEN_REGEN_COMMAND)
    expect(fixture.trackId).toBe(ctx.track.id)
    expect(fixture.raceSeed).toBe(GOLDEN_SEED)
    expect(fixture.raceSeed).toBe(20260813)
    expect(fixture.characterIdx).toEqual(GOLDEN_CHARACTER_IDX)
    expect(fixture.intentScale).toBe(INTENT_SCALE)
    expect(fixture.expected.raceSeed).toBe(GOLDEN_SEED)

    // The stream must cover every tick for every kart: tickCount * 8 karts * 5 bytes.
    const bytes = decodeB64Lines(fixture.intentsB64)
    expect(bytes.length).toBe(fixture.tickCount * MAX_KARTS * INTENT_BYTES_PER_KART)
  })

  it('lasts at least as long as physics allows for three laps', () => {
    // Absolute speed ceiling from the contract's targetSpeed product:
    //   maxSpeed 40 * fastest character speed 1.15 (character 5) * accel 1
    //   * surfaceSpeedFactor <= 1 * surge 0.7-or-1 * boostSpeedMul 1.35  =  62.1 m/s
    const ceilingSpeed = 40 * 1.15 * 1.35 // 62.1
    expect(ceilingSpeed).toBeCloseTo(62.1, 10)
    // Karts are frozen for the 180-tick countdown, then must cover 3 * trackLength metres.
    const lapMetres = ctx.query.totalLength()
    const floorTicks = COUNTDOWN_TICKS + Math.floor(((RACE_LAPS * lapMetres) / ceilingSpeed) * 60)
    expect(fixture.tickCount).toBeGreaterThan(floorTicks)
    expect(fixture.tickCount).toBeLessThanOrEqual(MAX_GOLDEN_TICKS)
    expect(run.ticks).toBe(fixture.tickCount)
  })

  it('carries no timestamp, hostname or absolute path', () => {
    const raw = readGoldenFixtureText()
    expect(Object.keys(fixture).sort()).toEqual([
      'characterIdx',
      'events',
      'expected',
      'formatVersion',
      'generatedBy',
      'intentScale',
      'intentsB64',
      'raceSeed',
      'tickCount',
      'trackId',
    ])
    expect(raw).not.toMatch(/\/home\//)
    expect(raw).not.toMatch(/\/Users\//)
    expect(raw).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/)
  })
})

describe('bot-drivability criterion', () => {
  it('finishes all three laps on all eight karts with zero respawns', () => {
    // Both halves of the spec §8 criterion are asserted here, and neither one alone is it:
    //   (a) all 8 karts complete RACE_LAPS laps, and
    //   (b) zero 'respawn' events across the entire run.
    const d = checkDrivability(run.end, run.events)

    // (b) "zero respawns" - the AuthEvent kind exists exactly so this is checkable.
    expect(d.respawnCount).toBe(0)
    expect(run.events.filter((e) => e.kind === 'respawn')).toHaveLength(0)
    expect(fixture.events.countsByKind.respawn).toBe(0)

    // (a) all eight finish the full race distance
    expect(d.finishedPlayerIds).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    expect(d.lapsByPlayer).toHaveLength(MAX_KARTS)
    for (let i = 0; i < MAX_KARTS; i++) {
      expect(d.lapsByPlayer[i]).toBeGreaterThanOrEqual(RACE_LAPS) // RACE_LAPS is 3
    }
    expect(d.allFinished).toBe(true)
    expect(d.ok).toBe(true)

    // finishedOrder is fixed length MAX_KARTS; every slot is filled, none left at -1
    expect(run.end.finishedOrder).toHaveLength(MAX_KARTS)
    expect(run.end.finishedOrder.filter((p) => p === -1)).toHaveLength(0)
    expect([...run.end.finishedOrder].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    expect(fixture.events.finishes).toHaveLength(MAX_KARTS)
    // 8 per-kart finish events from updateLaps [Task 11] + the 1 race-level event
    // updatePhase [Task 15] emits with playerId -1 = 9.
    expect(fixture.events.countsByKind.finish).toBe(MAX_KARTS + 1)

    // The first finish cannot happen during the 180-tick countdown, and the run keeps
    // recording for 60 ticks after the last kart finishes.
    expect(run.end.finishTick).toBeGreaterThan(COUNTDOWN_TICKS)
    expect(run.end.finishTick).toBeLessThan(run.end.tick)
  })
})

describe('replaying the recorded stream', () => {
  it('reproduces the stored state field by field', () => {
    const diffs = diffAgainstGolden(fixture.expected, run.end)
    // formatDiffs names every field, both values, the delta and the tolerance - which is
    // exactly what a digest mismatch cannot do.
    expect(formatDiffs(diffs)).toBe('')
    expect(diffs).toHaveLength(0)
    expect(run.end.karts).toHaveLength(MAX_KARTS)
    expect(run.end.entities).toHaveLength(MAX_ENTITIES)
    expect(fixture.expected.karts).toHaveLength(MAX_KARTS)
    expect(fixture.expected.entities).toHaveLength(fixture.expected.entityCount)
  })

  it('reproduces the stored event stream', () => {
    expect(formatDiffs(diffEventSummary(fixture.events, summarizeEvents(run.events)))).toBe('')
    expect(run.events).toHaveLength(fixture.events.total)
    for (let i = 1; i < run.events.length; i++) {
      expect(run.events[i].eventSeq).toBeGreaterThan(run.events[i - 1].eventSeq)
      expect(run.events[i].tick).toBeGreaterThanOrEqual(run.events[i - 1].tick)
    }
  })

  it('is deterministic across two runs in the same process', () => {
    const again = replayGoldenFixture(ctx, fixture)
    expect(formatDiffs(diffAgainstGolden(fixture.expected, again.end))).toBe('')
    expect(again.events).toHaveLength(run.events.length)
  })
})

describe('the fixture detects change', () => {
  it('catches a corrupted stored value and names the field', () => {
    // Below tolerance: 1e-9 m against a 1e-6 m band -> not a difference.
    const under = clone(fixture.expected)
    under.karts[3].position[0] += 1e-9
    expect(diffAgainstGolden(under, run.end)).toHaveLength(0)

    // Above tolerance: half a metre is 500000x the band -> exactly one named difference.
    const over = clone(fixture.expected)
    over.karts[3].position[0] += 0.5
    const posDiffs = diffAgainstGolden(over, run.end)
    expect(posDiffs).toHaveLength(1)
    expect(posDiffs[0].path).toBe('karts[3].position.x')
    expect(posDiffs[0].tolerance).toBe(GOLDEN_TOL.position)
    expect(posDiffs[0].delta).toBeLessThan(-0.4999999)
    expect(posDiffs[0].delta).toBeGreaterThan(-0.5000001)

    // An integer field has no band at all: one off is one difference.
    const lapCorrupt = clone(fixture.expected)
    lapCorrupt.karts[6].lap.lap += 1
    const lapDiffs = diffAgainstGolden(lapCorrupt, run.end)
    expect(lapDiffs).toHaveLength(1)
    expect(lapDiffs[0].path).toBe('karts[6].lap.lap')
    expect(lapDiffs[0].tolerance).toBe(0)
    expect(lapDiffs[0].delta).toBe(-1)

    // And a corrupted event count is caught by the event comparison, not the state one.
    const eventsCorrupt = JSON.parse(JSON.stringify(fixture.events)) as typeof fixture.events
    eventsCorrupt.countsByKind.finish -= 1
    const evDiffs = diffEventSummary(eventsCorrupt, summarizeEvents(run.events))
    expect(evDiffs.map((d) => d.path)).toContain('events.countsByKind.finish')
  })

  it('catches a one-part-in-240000 physics change on every kart', () => {
    // accelRate 24 -> 24.0001. One tick of that difference is
    //   0.0001 m/s^2 * TICK_DT (1/60 s) = 1.67e-6 m/s, already above the 1e-6 velocity band,
    // and it compounds over the whole race. Same recorded inputs, different physics.
    const bent = { ...ctx, tuning: makeTuning({ accelRate: 24.0001 }) }
    const bentRun = replayGoldenFixture(bent, fixture)
    const diffs = diffAgainstGolden(fixture.expected, bentRun.end)

    expect(diffs.length).toBeGreaterThanOrEqual(MAX_KARTS)
    const paths = diffs.map((d) => d.path)
    for (let i = 0; i < MAX_KARTS; i++) {
      const moved =
        paths.includes(`karts[${i}].position.x`) || paths.includes(`karts[${i}].position.z`)
      expect(moved).toBe(true)
    }
  })
})
