import { describe, expect, it } from 'vitest'

import type { AuthEvent, Intent } from '../src/types'
import { COUNTDOWN_TICKS, MAX_ENTITIES, MAX_KARTS, RACE_LAPS } from '../src/types'
import { makeContext, makeOvalTrack } from './fixtures/track-fixtures'
import type { GoldenExpectation } from './fixtures/golden-format'
import { GOLDEN_CHARACTER_IDX, GOLDEN_SEED, GOLDEN_TOL } from './fixtures/golden-format'
import {
  checkDrivability,
  describeDrivabilityFailure,
  diffAgainstGolden,
  diffEventSummary,
  formatDiffs,
  makeGoldenState,
  runGoldenTicks,
  summarizeEvents,
  toExpectation,
} from './fixtures/golden-harness'

function clone(e: GoldenExpectation): GoldenExpectation {
  return JSON.parse(JSON.stringify(e)) as GoldenExpectation
}

function ev(kind: AuthEvent['kind'], playerId: number, tick: number, seq: number): AuthEvent {
  return { eventSeq: seq, tick, kind, playerId, entityId: -1, item: 'none', data: 0 }
}

const ctx = makeContext(makeOvalTrack())

describe('makeGoldenState', () => {
  it('hands every one of the eight karts to the recorded stream', () => {
    const s = makeGoldenState(ctx, GOLDEN_SEED, GOLDEN_CHARACTER_IDX)
    expect(s.karts).toHaveLength(MAX_KARTS)
    expect(s.entities).toHaveLength(MAX_ENTITIES)
    expect(s.tick).toBe(0)
    expect(s.raceSeed).toBe(GOLDEN_SEED)
    for (let i = 0; i < MAX_KARTS; i++) {
      // Not bots at replay time: the stream drives them, so resolveInputs never bot-fills
      // and the golden is a physics test rather than a bot-AI test.
      expect(s.karts[i].isBot).toBe(false)
      expect(s.karts[i].connected).toBe(true)
      expect(s.karts[i].characterIdx).toBe(i)
    }
    for (let i = 0; i < MAX_ENTITIES; i++) {
      expect(s.entities[i].entityId).toBe(-1)
    }
  })
})

describe('toExpectation / diffAgainstGolden', () => {
  it('reports zero differences against the state it was built from', () => {
    const s = makeGoldenState(ctx, GOLDEN_SEED, GOLDEN_CHARACTER_IDX)
    const exp = toExpectation(s)
    expect(exp.karts).toHaveLength(MAX_KARTS)
    expect(exp.entityCount).toBe(0)
    expect(exp.entities).toHaveLength(0)
    expect(formatDiffs(diffAgainstGolden(exp, s))).toBe('')
    expect(diffAgainstGolden(exp, s)).toHaveLength(0)
  })

  it('ignores a continuous change below tolerance and reports one above it', () => {
    const s = makeGoldenState(ctx, GOLDEN_SEED, GOLDEN_CHARACTER_IDX)
    const base = toExpectation(s)

    // 1e-9 m is 1000x under the 1e-6 m position tolerance -> not a difference
    const under = clone(base)
    under.karts[2].position[0] += 1e-9
    expect(diffAgainstGolden(under, s)).toHaveLength(0)

    // 1e-5 m is 10x over it -> exactly one difference, and it names the field
    const over = clone(base)
    over.karts[2].position[0] += 1e-5
    const diffs = diffAgainstGolden(over, s)
    expect(diffs).toHaveLength(1)
    expect(diffs[0].path).toBe('karts[2].position.x')
    expect(diffs[0].tolerance).toBe(GOLDEN_TOL.position)
    expect(diffs[0].delta).toBeCloseTo(-1e-5, 12)
  })

  it('reports an integer field with zero tolerance and an exact delta', () => {
    const s = makeGoldenState(ctx, GOLDEN_SEED, GOLDEN_CHARACTER_IDX)
    const exp = toExpectation(s)
    exp.karts[5].lap.checkpointIdx += 1
    const diffs = diffAgainstGolden(exp, s)
    expect(diffs).toHaveLength(1)
    expect(diffs[0].path).toBe('karts[5].lap.checkpointIdx')
    expect(diffs[0].tolerance).toBe(0)
    expect(diffs[0].delta).toBe(-1)
  })

  it('reports an enum field by name with no delta', () => {
    const s = makeGoldenState(ctx, GOLDEN_SEED, GOLDEN_CHARACTER_IDX)
    const exp = toExpectation(s)
    exp.karts[1].item = exp.karts[1].item === 'none' ? 'boost' : 'none'
    const diffs = diffAgainstGolden(exp, s)
    expect(diffs).toHaveLength(1)
    expect(diffs[0].path).toBe('karts[1].item')
    expect(diffs[0].tolerance).toBe(0)
    expect(Number.isNaN(diffs[0].delta)).toBe(true)
  })

  it('compares headings as angles but still enforces the wrap invariant', () => {
    const s = makeGoldenState(ctx, GOLDEN_SEED, GOLDEN_CHARACTER_IDX)
    const exp = toExpectation(s)
    // h + 2*PI is the same angle, so the angular delta is ~0 (under the 1e-7 tolerance),
    // but every stored heading must live in (-PI, PI] and h + 2*PI never does.
    s.karts[0].heading = exp.karts[0].heading + 2 * Math.PI
    const diffs = diffAgainstGolden(exp, s)
    expect(diffs).toHaveLength(1)
    expect(diffs[0].path).toBe('karts[0].heading[wrapped]')
    expect(diffs[0].expected).toBe('(-PI, PI]')
    expect(diffs[0].tolerance).toBe(0)
  })

  it('refuses to store a non-finite number rather than writing JSON null', () => {
    const s = makeGoldenState(ctx, GOLDEN_SEED, GOLDEN_CHARACTER_IDX)
    s.karts[3].velocity.z = Number.POSITIVE_INFINITY
    expect(() => toExpectation(s)).toThrow(
      'golden: karts[3].velocity.z is not finite (Infinity); refusing to store it',
    )
  })
})

describe('formatDiffs', () => {
  it('is empty for no differences and names field, values, delta and tolerance otherwise', () => {
    expect(formatDiffs([])).toBe('')
    const text = formatDiffs([
      { path: 'karts[2].position.x', expected: 1.5, actual: 2, delta: 0.5, tolerance: 1e-6 },
    ])
    expect(text).toContain('1 field(s) differ from the golden fixture')
    expect(text).toContain('karts[2].position.x')
    expect(text).toContain('delta 5.000e-1')
    expect(text).toContain('tolerance 1e-6')
  })
})

describe('summarizeEvents / diffEventSummary', () => {
  it('counts every kind and records the finish order', () => {
    const events: AuthEvent[] = [
      ev('lapCross', 4, 300, 0),
      ev('respawn', 2, 310, 1),
      ev('finish', 4, 900, 2),
      ev('finish', 2, 950, 3),
      ev('finish', -1, 950, 4), // updatePhase's race-level event [Task 15]
    ]
    const s = summarizeEvents(events)
    expect(s.total).toBe(5)
    expect(s.countsByKind.lapCross).toBe(1)
    expect(s.countsByKind.respawn).toBe(1)
    expect(s.countsByKind.finish).toBe(3)   // counts include the race-level one
    expect(s.countsByKind.hit).toBe(0)
    // ...but the finishing order is per-kart, so the playerId -1 event is not in it
    expect(s.finishes).toEqual([
      { playerId: 4, tick: 900 },
      { playerId: 2, tick: 950 },
    ])
    expect(diffEventSummary(s, summarizeEvents(events))).toHaveLength(0)
  })

  it('names the kind whose count moved', () => {
    const a = summarizeEvents([ev('hit', 1, 10, 0)])
    const b = summarizeEvents([ev('hit', 1, 10, 0), ev('hit', 2, 11, 1)])
    const diffs = diffEventSummary(a, b)
    // Both summaries have zero finishes, so only the total and the hit count move.
    expect(diffs.map((d) => d.path)).toEqual(['events.total', 'events.countsByKind.hit'])
    expect(diffs[1].expected).toBe(1)
    expect(diffs[1].actual).toBe(2)
    expect(diffs[1].delta).toBe(1)
  })
})

describe('checkDrivability', () => {
  it('counts respawns and collects the distinct finishers', () => {
    const s = makeGoldenState(ctx, GOLDEN_SEED, GOLDEN_CHARACTER_IDX)
    const report = checkDrivability(s, [
      ev('respawn', 0, 100, 0),
      ev('respawn', 0, 200, 1),
      ev('finish', 3, 900, 2),
      ev('finish', 1, 910, 3),
      ev('finish', -1, 910, 4), // the race-level event is not a finisher
    ])
    expect(report.respawnCount).toBe(2)
    expect(report.finishedPlayerIds).toEqual([1, 3])   // no -1
    expect(report.lapsByPlayer).toHaveLength(MAX_KARTS)
    expect(report.allFinished).toBe(false) // 2 of 8 finished, and no kart has 3 laps
    expect(report.ok).toBe(false)
  })

  it('describes the failure with the karts that fell short', () => {
    const s = makeGoldenState(ctx, GOLDEN_SEED, GOLDEN_CHARACTER_IDX)
    const text = describeDrivabilityFailure(checkDrivability(s, [ev('finish', 0, 900, 0)]))
    expect(text).toContain('respawn events: 0 (must be 0)')
    expect(text).toContain(`karts that did not finish ${RACE_LAPS} laps`)
    expect(text).toContain('player 7 (lap')
  })
})

describe('runGoldenTicks', () => {
  it('advances exactly the requested number of ticks and clears the countdown', () => {
    const ticks = COUNTDOWN_TICKS + 60 // 180 + 60 = 240
    const intents: Intent[][] = []
    for (let t = 0; t < ticks; t++) {
      const row: Intent[] = []
      for (let i = 0; i < MAX_KARTS; i++) {
        row.push({ tick: t, steer: 0, accel: 0, brake: false, drift: false, useItem: false })
      }
      intents.push(row)
    }

    const run = runGoldenTicks(ctx, GOLDEN_SEED, GOLDEN_CHARACTER_IDX, intents, ticks)
    expect(run.ticks).toBe(240)
    expect(run.end.tick).toBe(240)
    expect(run.end.phase).toBe('racing') // COUNTDOWN_TICKS is 180, so 240 is past it
    expect(run.end.karts).toHaveLength(MAX_KARTS)
    expect(run.end.entities).toHaveLength(MAX_ENTITIES)
    // Nobody moves on accel 0, so nobody can leave the track
    expect(run.events.filter((e) => e.kind === 'respawn')).toHaveLength(0)
    // finishedOrder is fixed length MAX_KARTS with -1 in every unfilled slot, so
    // "nobody finished" is eight -1s, not an empty array.
    expect(run.end.finishedOrder).toEqual([-1, -1, -1, -1, -1, -1, -1, -1])
    expect(run.end.finishedOrder).toHaveLength(MAX_KARTS)
  })
})
