import { describe, expect, it } from 'vitest'
import { FINISH_GRACE_TICKS, MAX_KARTS, RACE_LAPS } from '@tapkart/sim'
import type { RaceView } from '@tapkart/render'
import { createRaceView } from '@tapkart/render'
import { loadContentBundle } from '@tapkart/content'
import type { LobbySlot } from '../src/app'
import { buildResultRows, isDnf } from '../src/results'

function view(laps: readonly number[], order: readonly number[], finishTick: number, tick: number): RaceView {
  const out = createRaceView(0)
  out.phase = 'finished'
  out.finishTick = finishTick
  out.tick = tick
  for (let i = 0; i < MAX_KARTS; i++) {
    out.karts[i].playerId = i
    out.karts[i].characterIdx = i
    out.karts[i].lap = laps[i]
    out.finishedOrder[i] = order[i] ?? -1
  }
  return out
}

function slots(names: Readonly<Record<number, string | undefined>>): LobbySlot[] {
  return Array.from({ length: MAX_KARTS }, (_, i) => ({
    playerId: i,
    name: names[i] ?? '',
    characterIdx: i,
    isBot: names[i] === undefined,
    connected: true,
    ready: true,
  }))
}

describe('results', () => {
  it('marks only unfinished karts at or after grace expiry as DNF', () => {
    const laps = [3, 3, 1, 3, 3, 3, 3, 3]
    const before = view(laps, [0], 100, 100 + FINISH_GRACE_TICKS - 1)
    expect(isDnf(before, before.karts[2])).toBe(false)
    const at = view(laps, [0], 100, 100 + FINISH_GRACE_TICKS)
    expect(isDnf(at, at.karts[2])).toBe(true)
    expect(isDnf(at, at.karts[0])).toBe(false)
    at.finishTick = -1
    expect(isDnf(at, at.karts[2])).toBe(false)
    expect(RACE_LAPS).toBe(3)
  })

  it('walks finishing order, skips padding, and assigns contiguous places', () => {
    const v = view([3, 3, 3, 3, 3, 3, 3, 3], [5, 2, 0], 500, 600)
    const rows = buildResultRows(v, slots({ 2: 'Ada' }))
    expect(rows.map((row) => row.playerId)).toEqual([5, 2, 0])
    expect(rows.map((row) => row.place)).toEqual([1, 2, 3])
  })

  it('uses lobby names and falls back to displayed character descriptor names', () => {
    const v = view([3, 3, 3, 3, 3, 3, 3, 3], [0, 4], 500, 600)
    const rows = buildResultRows(v, slots({ 0: 'Ada' }))
    expect(rows[0].name).toBe('Ada')
    expect(rows[1].name).toBe(loadContentBundle().characters[4].name)
  })

  it('keeps grace-expiry rows and marks their DNF status', () => {
    const v = view([3, 3, 3, 3, 3, 2, 1, 0], [0, 1, 2, 3, 4, 5, 6, 7], 500, 500 + FINISH_GRACE_TICKS)
    const rows = buildResultRows(v, slots({}))
    expect(rows.filter((row) => row.dnf).map((row) => row.playerId)).toEqual([5, 6, 7])
    expect(rows.map((row) => row.place)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
  })
})
