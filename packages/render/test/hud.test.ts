import { describe, expect, it } from 'vitest'
import {
  COUNTDOWN_TICKS,
  MAX_KARTS,
  RACE_LAPS,
  TICK_DT,
  createState,
  motionLocked as simMotionLocked,
} from '@tapkart/sim'
import type { RaceView } from '../src/types'
import { createRaceView } from '../src/types'
import type { CountdownLabel, HudModel } from '../src/hud'
import {
  GO_LABEL_TICKS,
  buildHudModel,
  countdownLabelFor,
  createHudModel,
  formatRaceClock,
} from '../src/hud'
// The barrel, to prove §4.11's new `export * from './hud'` line is actually there.
import * as barrel from '../src/index'
import type {
  CountdownLabel as BarrelCountdownLabel,
  HudModel as BarrelHudModel,
  HudStanding as BarrelHudStanding,
} from '../src/index'
import { makeRenderContext } from './fixtures/render-fixtures'

/** A racing view with eight seats, place === seat, local seat 0. */
function raceView(): RaceView {
  const view = createRaceView(2)
  view.tick = 0
  view.phase = 'racing'
  view.localPlayerId = 0
  view.raceStartTick = 0
  view.countdownTicksLeft = 0
  view.entityCount = 0
  for (let i = 0; i < MAX_KARTS; i++) {
    const k = view.karts[i]
    k.playerId = i
    k.characterIdx = i
    k.source = 'authoritative'
    k.place = i
    k.lap = 0
    k.speed = 0
    k.item = 'none'
    k.driftTier = -1
    k.respawnTicks = 0
    k.spinOutTicks = 0
    k.isBot = i !== 0
    k.connected = true
  }
  return view
}

/** seat -> place, a full permutation with no fixed point at index 0 and no run
 *  of consecutive seats: seat order, reverse order and "leader is seat 0" all
 *  give a different answer from the right one. Place order is seats
 *  [1, 4, 3, 6, 7, 0, 5, 2]. */
const SHUFFLED_PLACES = [5, 0, 7, 2, 1, 6, 3, 4]
const SHUFFLED_ORDER = [1, 4, 3, 6, 7, 0, 5, 2]

function shufflePlaces(view: RaceView): void {
  for (let i = 0; i < MAX_KARTS; i++) view.karts[i].place = SHUFFLED_PLACES[i]
}

/**
 * Writes into EVERY HudModel field a value that differs from the one the
 * no-seat assertions expect.
 *
 * Without this, most of those assertions run against a value `createHudModel`
 * already produces — `visible === false`, `place === 1`, `item === 'none'`,
 * `driftTier === -1`, `fieldSize === MAX_KARTS` — so a `buildHudModel` that
 * wrote nothing at all would pass them. `buildHudModel` is the SOLE WRITER of
 * every field (§7.2); poisoning first is what turns that claim into a test.
 */
function poison(out: HudModel): void {
  out.visible = true
  out.place = 6
  out.fieldSize = 0
  out.lap = 3
  out.totalLaps = 0
  out.speedKph = 108
  out.item = 'bolt'
  out.itemReady = true
  out.driftTier = 2
  out.countdownLabel = 'GO'
  out.raceClock = '9:59.999'
  out.respawning = true
  out.spunOut = true
  out.motionLocked = true
}

describe('formatRaceClock', () => {
  it('matches the contract’s two worked examples', () => {
    expect(formatRaceClock(0)).toBe('0:00.000')
    expect(formatRaceClock(3661)).toBe('1:01.017')
  })

  // Catches the two formatting bugs that survive a single-example test: an
  // unpadded seconds field ("1:1.017") and a millisecond field padded to two
  // digits or truncated ("0:00.17").
  it('pads seconds to two digits and milliseconds to three', () => {
    expect(formatRaceClock(60)).toBe('0:01.000')
    expect(formatRaceClock(3600)).toBe('1:00.000')
    expect(formatRaceClock(1)).toBe('0:00.017')
    expect(formatRaceClock(6)).toBe('0:00.100')
    expect(formatRaceClock(3599)).toBe('0:59.983')
  })

  it('is monotonic in ticks and never negative', () => {
    let prev = ''
    for (let t = 0; t < 4000; t += 7) {
      const s = formatRaceClock(t)
      expect(s > prev || t === 0).toBe(true)
      prev = s
    }
    expect(formatRaceClock(-100)).toBe('0:00.000')
  })

  it('derives milliseconds from TICK_DT, not from a hard-coded 16', () => {
    // 100 ticks is 1.6667 s, not 1.600 s. A 16 ms tick would print '0:01.600'.
    expect(formatRaceClock(100)).toBe('0:01.667')
    expect(Math.round(100 * TICK_DT * 1000)).toBe(1667)
  })
})

describe('countdownLabelFor', () => {
  // Walks 3,2,1,GO across COUNTDOWN_TICKS in equal thirds (§8.1). The boundary
  // ticks are asserted individually because an off-by-one here shows "1" for 61
  // ticks and "2" for 59 - which nobody notices by eye and every player feels.
  it('walks 3,2,1 across the countdown in equal thirds', () => {
    const third = COUNTDOWN_TICKS / 3
    expect(countdownLabelFor('countdown', COUNTDOWN_TICKS, 0)).toBe('3')
    expect(countdownLabelFor('countdown', 2 * third + 1, 0)).toBe('3')
    expect(countdownLabelFor('countdown', 2 * third, 0)).toBe('2')
    expect(countdownLabelFor('countdown', third + 1, 0)).toBe('2')
    expect(countdownLabelFor('countdown', third, 0)).toBe('1')
    expect(countdownLabelFor('countdown', 1, 0)).toBe('1')
    expect(countdownLabelFor('countdown', 0, 0)).toBe('GO')
  })

  it('each digit holds for exactly one third of the countdown', () => {
    const seen = new Map<CountdownLabel, number>()
    for (let tick = 0; tick <= COUNTDOWN_TICKS; tick++) {
      const left = Math.max(0, COUNTDOWN_TICKS - tick)
      const label = countdownLabelFor('countdown', left, 0)
      seen.set(label, (seen.get(label) ?? 0) + 1)
    }
    expect(seen.get('3')).toBe(COUNTDOWN_TICKS / 3)
    expect(seen.get('2')).toBe(COUNTDOWN_TICKS / 3)
    expect(seen.get('1')).toBe(COUNTDOWN_TICKS / 3)
    expect(seen.get('GO')).toBe(1)
    expect(seen.get('')).toBeUndefined()
  })

  it('holds GO for GO_LABEL_TICKS into the race, then clears', () => {
    expect(countdownLabelFor('racing', 0, 0)).toBe('GO')
    expect(countdownLabelFor('racing', 0, GO_LABEL_TICKS - 1)).toBe('GO')
    expect(countdownLabelFor('racing', 0, GO_LABEL_TICKS)).toBe('')
    expect(countdownLabelFor('racing', 0, 100000)).toBe('')
    expect(countdownLabelFor('finished', 0, 0)).toBe('')
  })

  it('is total for out-of-range input', () => {
    const labels: CountdownLabel[] = ['', '3', '2', '1', 'GO']
    expect(countdownLabelFor('countdown', COUNTDOWN_TICKS * 10, 0)).toBe('3')
    expect(countdownLabelFor('countdown', -5, 0)).toBe('GO')
    expect(countdownLabelFor('countdown', 90.5, 0)).toBe('2') // fractional, mid-band
    // Totality, not the clamp: with these branch bounds the clamp cannot change
    // an answer (see the report), so what is asserted here is that every input a
    // caller can produce - including NaN and the infinities - still returns a
    // member of the union rather than `undefined` or a throw.
    for (const left of [
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.NaN,
      -1e9,
      1e9,
    ]) {
      expect(labels).toContain(countdownLabelFor('countdown', left, 0))
      expect(labels).toContain(countdownLabelFor('racing', 0, left))
    }
  })
})

describe('buildHudModel', () => {
  it('reports place and lap 1-based, and speed in whole kph', () => {
    const view = raceView()
    view.karts[0].place = 2
    view.karts[0].lap = 1
    view.karts[0].speed = 12.5
    const out = createHudModel()
    poison(out) // `visible`, `fieldSize` and `totalLaps` all match the factory default
    buildHudModel(view, RACE_LAPS, out)
    expect(out.visible).toBe(true)
    expect(out.place).toBe(3)
    expect(out.lap).toBe(2)
    expect(out.totalLaps).toBe(RACE_LAPS)
    expect(out.fieldSize).toBe(MAX_KARTS)
    expect(out.speedKph).toBe(45)
  })

  // Every other test in this file sits in seat 0, where `karts[localPlayerId]`
  // and `karts[0]` are the same object - so none of them can tell a builder that
  // reads the LOCAL seat from one that reads the first seat, which is right on
  // the host and wrong for all seven other players. Seat 5 is given a value that
  // differs from seat 0's in every field the local branch writes.
  it('reads the local seat, not seat 0', () => {
    const view = raceView()
    view.localPlayerId = 5
    view.karts[0].place = 0
    view.karts[0].lap = 0
    view.karts[0].speed = 40
    view.karts[0].item = 'bolt'
    view.karts[0].driftTier = 0
    view.karts[0].respawnTicks = 30
    view.karts[0].spinOutTicks = 0
    view.karts[5].place = 6
    view.karts[5].lap = 2
    view.karts[5].speed = 10
    view.karts[5].item = 'slick'
    view.karts[5].driftTier = 2
    view.karts[5].respawnTicks = 0
    view.karts[5].spinOutTicks = 12
    const out = createHudModel()
    buildHudModel(view, RACE_LAPS, out)

    expect(out.visible).toBe(true)
    expect(out.place).toBe(7) // seat 0 would say 1
    expect(out.lap).toBe(3) // seat 0 would say 1
    expect(out.speedKph).toBe(36) // seat 0 would say 144
    expect(out.item).toBe('slick') // seat 0 would say 'bolt'
    expect(out.itemReady).toBe(true) // seat 0 is motion-locked, so it would say false
    expect(out.driftTier).toBe(2) // seat 0 would say 0
    expect(out.respawning).toBe(false) // seat 0 would say true
    expect(out.spunOut).toBe(true) // seat 0 would say false
    expect(out.motionLocked).toBe(false) // seat 0 would say true
  })

  it('passes `totalLaps` through rather than hard-coding RACE_LAPS', () => {
    // The signature takes totalLaps for a reason; a body that reached for the
    // constant instead would be invisible while RACE_LAPS is the only caller.
    const view = raceView()
    view.karts[0].lap = 4
    const out = createHudModel()
    buildHudModel(view, 5, out)
    expect(out.totalLaps).toBe(5)
    expect(out.lap).toBe(5)
    expect(out.standings[0].lap).toBe(5) // seat 0 leads; its row clamps to 5 too

    view.karts[0].lap = 9
    buildHudModel(view, 5, out)
    expect(out.lap).toBe(5) // clamped to the ARGUMENT, not to RACE_LAPS
  })

  // Q18. Both ends of the clamp: "LAP 0/3" on the grid and "LAP 4/3" after the
  // final crossing are the two ways the raw value is wrong. Ordered so that no
  // expectation is the value already sitting in the field: `createHudModel`
  // starts `lap` at 1, which is exactly what the grid case asserts.
  it('never shows lap 0 and never shows lap 4 of 3', () => {
    const view = raceView()
    const out = createHudModel()

    view.karts[0].lap = 1
    buildHudModel(view, RACE_LAPS, out)
    expect(out.lap).toBe(2)

    view.karts[0].lap = 0 // on the grid: raw 0 would render "LAP 0/3"
    buildHudModel(view, RACE_LAPS, out)
    expect(out.lap).toBe(1)

    view.karts[0].lap = 2
    buildHudModel(view, RACE_LAPS, out)
    expect(out.lap).toBe(3)

    view.karts[0].lap = RACE_LAPS // the final crossing: raw 3 + 1 would be "LAP 4/3"
    buildHudModel(view, RACE_LAPS, out)
    expect(out.lap).toBe(RACE_LAPS)

    view.karts[0].lap = 99
    buildHudModel(view, RACE_LAPS, out)
    expect(out.lap).toBe(RACE_LAPS)
  })

  it('rounds speedKph rather than truncating', () => {
    const view = raceView()
    const out = createHudModel()
    // Each expectation differs from the one before it, so a field written once
    // and then left alone fails as loudly as a truncating one.
    view.karts[0].speed = 9.99
    buildHudModel(view, RACE_LAPS, out)
    expect(out.speedKph).toBe(36) // 35.964 rounds up; truncation gives 35

    view.karts[0].speed = 5
    buildHudModel(view, RACE_LAPS, out)
    expect(out.speedKph).toBe(18) // exact

    view.karts[0].speed = 5.14
    buildHudModel(view, RACE_LAPS, out)
    expect(out.speedKph).toBe(19) // 18.504 rounds up; truncation gives 18, the value above

    view.karts[0].speed = 10
    buildHudModel(view, RACE_LAPS, out)
    expect(out.speedKph).toBe(36)
  })

  it('gates itemReady on holding an item AND not being motion-locked (Q21)', () => {
    const view = raceView()
    const out = createHudModel()

    view.karts[0].item = 'boost'
    buildHudModel(view, RACE_LAPS, out)
    expect(out.item).toBe('boost')
    expect(out.itemReady).toBe(true)

    // Item spent: the flag must CLEAR, not merely have started false.
    view.karts[0].item = 'none'
    buildHudModel(view, RACE_LAPS, out)
    expect(out.item).toBe('none')
    expect(out.itemReady).toBe(false)

    // Holding an item while respawning: still not ready.
    view.karts[0].item = 'bolt'
    view.karts[0].respawnTicks = 40
    buildHudModel(view, RACE_LAPS, out)
    expect(out.item).toBe('bolt')
    expect(out.itemReady).toBe(false)
    expect(out.respawning).toBe(true)
    expect(out.motionLocked).toBe(true)

    // ...and ready again the tick the respawn ends.
    view.karts[0].respawnTicks = 0
    buildHudModel(view, RACE_LAPS, out)
    expect(out.itemReady).toBe(true)
    expect(out.respawning).toBe(false)
  })

  // §8.1: motionLocked agrees with sim's motionLocked on the local kart. The
  // HUD's throttle indicator reads this, not `accel` - the adapters keep
  // reporting the player's real input (Q21), so `accel` says nothing about
  // whether the kart can move.
  it('agrees with sim’s motionLocked, and is independent of spinOut', () => {
    const ctx = makeRenderContext()
    const state = createState(ctx, 3, Array.from({ length: MAX_KARTS }, () => 0))
    const view = raceView()
    const out = createHudModel()

    // 0 first and 72 last, so the spin-out case below is asserting a change from
    // `true` rather than agreeing with a field nobody wrote.
    for (const respawnTicks of [0, 1, 40, 72]) {
      state.karts[0].respawnTicks = respawnTicks
      view.karts[0].respawnTicks = respawnTicks
      buildHudModel(view, RACE_LAPS, out)
      expect(out.motionLocked).toBe(simMotionLocked(state.karts[0]))
      expect(out.motionLocked).toBe(respawnTicks > 0)
      expect(out.motionLocked).toBe(out.respawning)
    }

    // A spun-out kart is steering-locked, not motion-locked: it is still
    // sliding, and the HUD must not tell the player the throttle is dead.
    view.karts[0].respawnTicks = 0
    view.karts[0].spinOutTicks = 30
    buildHudModel(view, RACE_LAPS, out)
    expect(out.spunOut).toBe(true)
    expect(out.motionLocked).toBe(false)

    // ...and spunOut clears with the timer.
    view.karts[0].spinOutTicks = 0
    buildHudModel(view, RACE_LAPS, out)
    expect(out.spunOut).toBe(false)
  })

  it('copies driftTier in sim’s encoding, where 0 is a real tier', () => {
    const view = raceView()
    const out = createHudModel()
    // -1 is `createHudModel`'s default, so it is checked third - after a 2 has
    // been written - rather than against an untouched field.
    for (const tier of [2, 0, -1, 1]) {
      view.karts[0].driftTier = tier
      buildHudModel(view, RACE_LAPS, out)
      expect(out.driftTier).toBe(tier)
    }
  })

  it('drives raceClock and countdownLabel off raceStartTick', () => {
    const view = raceView()
    const out = createHudModel()

    // Racing first, so the countdown frame below has a non-default clock to clear.
    view.phase = 'racing'
    view.raceStartTick = COUNTDOWN_TICKS
    view.tick = COUNTDOWN_TICKS + 60
    view.countdownTicksLeft = 0
    buildHudModel(view, RACE_LAPS, out)
    expect(out.raceClock).toBe('0:01.000')
    expect(out.countdownLabel).toBe('')

    // Mid-countdown, 60 ticks from the lights: the clock does NOT run yet, even
    // though `view.tick` is 120. Reading `tick` instead of `tick - raceStartTick`
    // would print '0:02.000' here.
    view.phase = 'countdown'
    view.tick = 120
    view.countdownTicksLeft = COUNTDOWN_TICKS - 120
    buildHudModel(view, RACE_LAPS, out)
    expect(out.raceClock).toBe('0:00.000')
    expect(out.countdownLabel).toBe('1')

    // Half a second into the race: GO is still up.
    view.phase = 'racing'
    view.tick = COUNTDOWN_TICKS + 30
    view.countdownTicksLeft = 0
    buildHudModel(view, RACE_LAPS, out)
    expect(out.raceClock).toBe('0:00.500')
    expect(out.countdownLabel).toBe('GO')

    // A minute in.
    view.tick = COUNTDOWN_TICKS + 3661
    buildHudModel(view, RACE_LAPS, out)
    expect(out.raceClock).toBe('1:01.017')
    expect(out.countdownLabel).toBe('')
  })
})

describe('buildHudModel - standings', () => {
  // The signature defect this test exists for: `view.karts` is indexed BY SEAT,
  // so a builder that emits standings in seat order looks perfectly correct
  // whenever place happens to equal seat - which is true on the grid, and true
  // in every fixture that does not deliberately shuffle. So this shuffles.
  it('sorts by place ascending, not by seat', () => {
    const view = raceView()
    shufflePlaces(view)
    for (let i = 0; i < MAX_KARTS; i++) view.karts[i].lap = i % RACE_LAPS
    const out = createHudModel()
    buildHudModel(view, RACE_LAPS, out)

    expect(out.standings).toHaveLength(MAX_KARTS)
    for (let n = 0; n < MAX_KARTS; n++) {
      expect(out.standings[n].place).toBe(n + 1)
    }
    // seat order would put playerId 0 first; place order puts playerId 1 first
    expect(out.standings.map((r) => r.playerId)).toEqual(SHUFFLED_ORDER)
    expect(out.standings[0].playerId).not.toBe(0)
  })

  it('carries each seat’s own lap, isBot and connected into its row', () => {
    const view = raceView()
    shufflePlaces(view) // the rows move during the sort; their contents must ride along
    // seat -> KartView.lap. A row's lap is clamped exactly like the local one, so
    // the field carries a kart on its final lap (RACE_LAPS, which would read 4)
    // and one past any sane value (99), as well as the ordinary cases.
    const rawLaps = [0, 0, 1, 2, 0, 99, RACE_LAPS, 0]
    for (let i = 0; i < MAX_KARTS; i++) view.karts[i].lap = rawLaps[i]
    view.karts[3].isBot = false // raceView bots everyone but seat 0
    view.karts[3].connected = false
    const out = createHudModel()
    buildHudModel(view, RACE_LAPS, out)

    const row3 = out.standings.find((r) => r.playerId === 3)
    expect(row3).toBeDefined()
    expect(row3?.place).toBe(3) // seat 3 holds place 2, 1-based 3
    expect(row3?.lap).toBe(3) // 1-based
    expect(row3?.isBot).toBe(false) // createHudModel's default is `true`
    expect(row3?.connected).toBe(false)

    // Seat 5 covers the other pole of each flag: `connected: true` is what
    // `createHudModel` does NOT default to.
    const row5 = out.standings.find((r) => r.playerId === 5)
    expect(row5).toBeDefined()
    expect(row5?.place).toBe(7)
    expect(row5?.lap).toBe(RACE_LAPS) // 99 + 1, clamped
    expect(row5?.isBot).toBe(true)
    expect(row5?.connected).toBe(true)

    // Seat 6 is on its final lap: an unclamped row would read 4 of 3 here.
    expect(out.standings.find((r) => r.playerId === 6)?.lap).toBe(RACE_LAPS)
    expect(out.standings.find((r) => r.playerId === 2)?.lap).toBe(2)

    // Laps across the whole field, in place order. The array's first (1), last
    // (2), maximum (3) and sum (15) are four different numbers, it differs from
    // its own reverse, and it differs from the same laps in seat order
    // ([1, 1, 2, 3, 1, 3, 3, 1]) - so it cannot pass unsorted either.
    expect(out.standings.map((r) => r.lap)).toEqual([1, 1, 3, 3, 1, 1, 3, 2])
  })

  it('reuses the standings array and its rows instead of allocating per frame', () => {
    const view = raceView()
    const out = createHudModel()
    const arr = out.standings
    const rows = new Set(out.standings)
    expect(rows.size).toBe(MAX_KARTS)

    shufflePlaces(view)
    buildHudModel(view, RACE_LAPS, out)
    buildHudModel(view, RACE_LAPS, out)

    expect(out.standings).toBe(arr)
    expect(out.standings).toHaveLength(MAX_KARTS)
    // Identity of every row, not just of the array: `standings[i] = { ...row }`
    // keeps the array and still allocates eight objects a frame.
    for (const row of out.standings) expect(rows.has(row)).toBe(true)
    expect(new Set(out.standings).size).toBe(MAX_KARTS)
  })

  // Catches a stale row surviving a re-sort: build twice with different orders
  // and the second result must not carry any of the first's ordering. Neither
  // order is seat order, so neither can be satisfied by not sorting at all.
  it('re-sorts cleanly when places change between frames', () => {
    const view = raceView()
    const out = createHudModel()
    shufflePlaces(view)
    buildHudModel(view, RACE_LAPS, out)
    expect(out.standings.map((r) => r.playerId)).toEqual(SHUFFLED_ORDER)

    for (let i = 0; i < MAX_KARTS; i++) view.karts[i].place = MAX_KARTS - 1 - i
    buildHudModel(view, RACE_LAPS, out)
    expect(out.standings.map((r) => r.playerId)).toEqual([7, 6, 5, 4, 3, 2, 1, 0])
    expect(out.standings.map((r) => r.place)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
  })

  // The sort is documented as stable. Tied places are what an unfilled view has
  // (createRaceView leaves every place 0), and the field should then read in
  // seat order rather than in whatever order the last frame left behind.
  it('keeps seat order for tied places', () => {
    const view = raceView()
    const out = createHudModel()
    shufflePlaces(view)
    buildHudModel(view, RACE_LAPS, out)
    expect(out.standings.map((r) => r.playerId)).toEqual(SHUFFLED_ORDER)

    for (let i = 0; i < MAX_KARTS; i++) view.karts[i].place = 0
    buildHudModel(view, RACE_LAPS, out)
    expect(out.standings.map((r) => r.playerId)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    expect(out.standings.map((r) => r.place)).toEqual([1, 1, 1, 1, 1, 1, 1, 1])
  })
})

describe('buildHudModel - no local seat', () => {
  it('hides the HUD but still fills the shared fields', () => {
    const view = raceView()
    view.localPlayerId = -1
    view.tick = 120
    view.raceStartTick = 0
    shufflePlaces(view)
    const out = createHudModel()
    poison(out)
    buildHudModel(view, RACE_LAPS, out)

    expect(out.visible).toBe(false)
    expect(out.place).toBe(1)
    expect(out.lap).toBe(1)
    expect(out.speedKph).toBe(0)
    expect(out.item).toBe('none')
    expect(out.itemReady).toBe(false)
    expect(out.driftTier).toBe(-1)
    expect(out.respawning).toBe(false)
    expect(out.spunOut).toBe(false)
    expect(out.motionLocked).toBe(false)
    // A spectator still sees the field and the clock.
    expect(out.fieldSize).toBe(MAX_KARTS)
    expect(out.totalLaps).toBe(RACE_LAPS)
    expect(out.raceClock).toBe('0:02.000')
    expect(out.countdownLabel).toBe('')
    expect(out.standings).toHaveLength(MAX_KARTS)
    expect(out.standings.map((r) => r.playerId)).toEqual(SHUFFLED_ORDER)
  })

  it('clears the local fields again after a seat goes away', () => {
    const view = raceView()
    view.karts[0].place = 5
    view.karts[0].lap = 1
    view.karts[0].speed = 30
    view.karts[0].item = 'bolt'
    view.karts[0].driftTier = 2
    view.karts[0].respawnTicks = 40
    view.karts[0].spinOutTicks = 30
    const out = createHudModel()
    buildHudModel(view, RACE_LAPS, out)
    expect(out.visible).toBe(true)
    expect(out.place).toBe(6)
    expect(out.lap).toBe(2)
    expect(out.speedKph).toBe(108)
    expect(out.item).toBe('bolt')
    expect(out.driftTier).toBe(2)
    expect(out.respawning).toBe(true)
    expect(out.spunOut).toBe(true)
    expect(out.motionLocked).toBe(true)

    // Every one of these differs from the value the frame above left behind, so
    // none of them can pass on a field the neutral branch forgot to write.
    view.localPlayerId = -1
    buildHudModel(view, RACE_LAPS, out)
    expect(out.visible).toBe(false)
    expect(out.place).toBe(1)
    expect(out.lap).toBe(1)
    expect(out.speedKph).toBe(0)
    expect(out.item).toBe('none')
    expect(out.driftTier).toBe(-1)
    expect(out.respawning).toBe(false)
    expect(out.spunOut).toBe(false)
    expect(out.motionLocked).toBe(false)
  })

  it('treats an out-of-range local seat as no seat at all', () => {
    const view = raceView()
    view.karts[0].speed = 30
    const out = createHudModel()
    buildHudModel(view, RACE_LAPS, out)
    expect(out.speedKph).toBe(108)

    // MAX_KARTS is one past the last seat: `view.karts[8]` is undefined, and
    // reading `.speed` off it throws rather than merely looking wrong.
    view.localPlayerId = MAX_KARTS
    expect(() => buildHudModel(view, RACE_LAPS, out)).not.toThrow()
    expect(out.visible).toBe(false)
    expect(out.speedKph).toBe(0)
  })
})

describe('the lap text Plan 4 asserts on', () => {
  // §11's hook table: the `lap-counter` element's text is matched against
  // /[1-3]\s*\/\s*3/. `startShell` owns the element, the testid and the "LAP "
  // prefix; `hud.ts` owns the two numbers inside it. This pins hud's half - for
  // EVERY raw lap a view can carry, the pair renders inside the regex - which is
  // the same clamp Q18 asks for, stated in the form the E2E will read it.
  it('composes a lap text matching /[1-3]\\s*\\/\\s*3/ for every raw lap value', () => {
    expect(RACE_LAPS).toBe(3) // the regex hard-codes the 3
    const view = raceView()
    const out = createHudModel()
    for (const raw of [-1, 0, 1, 2, 3, 4, 99]) {
      view.karts[0].lap = raw
      buildHudModel(view, RACE_LAPS, out)
      expect(`LAP ${out.lap}/${out.totalLaps}`).toMatch(/[1-3]\s*\/\s*3/)
    }
    // The two texts the raw value would have produced, and which the regex
    // rejects - so the test above is not merely matching anything.
    expect('LAP 0/3').not.toMatch(/[1-3]\s*\/\s*3/)
    expect('LAP 4/3').not.toMatch(/[1-3]\s*\/\s*3/)
  })
})

describe('createHudModel', () => {
  it('allocates MAX_KARTS distinct standing rows', () => {
    const a = createHudModel()
    expect(a.standings).toHaveLength(MAX_KARTS)
    expect(a.standings[0]).not.toBe(a.standings[1])
    const b = createHudModel()
    expect(b.standings).not.toBe(a.standings)
    a.standings[0].playerId = 99
    expect(b.standings[0].playerId).not.toBe(99)
  })

  it('starts hidden, with no item and no drift tier', () => {
    const m = createHudModel()
    expect(m.visible).toBe(false)
    expect(m.item).toBe('none')
    expect(m.driftTier).toBe(-1)
    expect(m.countdownLabel).toBe('')
    expect(m.raceClock).toBe('0:00.000')
  })
})

/**
 * ADDED. §4.11's barrel line is part of this task's diff and nothing else in the
 * package covers it: every other import here reaches `src/hud` by relative path,
 * so a missing `export * from './hud'` leaves `@tapkart/render` without a HUD at
 * all and leaves this whole file green. Identity, not presence: a second copy of
 * the model under the same name would pass `toBeDefined()`.
 */
describe('the @tapkart/render barrel re-exports hud (§4.11)', () => {
  it('carries all five of the module’s runtime exports, by identity', () => {
    expect(barrel.GO_LABEL_TICKS).toBe(GO_LABEL_TICKS)
    expect(barrel.createHudModel).toBe(createHudModel)
    expect(barrel.buildHudModel).toBe(buildHudModel)
    expect(barrel.formatRaceClock).toBe(formatRaceClock)
    expect(barrel.countdownLabelFor).toBe(countdownLabelFor)
  })

  it('carries the three type exports too', () => {
    // Compile-time: this object does not typecheck unless CountdownLabel,
    // HudModel and HudStanding all reach the barrel. `npm run typecheck` is the
    // assertion; the runtime check below only keeps the binding alive.
    const throughBarrel: {
      label: BarrelCountdownLabel
      model: BarrelHudModel
      row: BarrelHudStanding
    } = {
      label: 'GO',
      model: createHudModel(),
      row: { playerId: 2, place: 3, lap: 1, isBot: false, connected: true },
    }
    expect(throughBarrel.label).toBe('GO')
    expect(throughBarrel.model.standings).toHaveLength(MAX_KARTS)
    expect(throughBarrel.row.place).toBe(3)
  })
})
