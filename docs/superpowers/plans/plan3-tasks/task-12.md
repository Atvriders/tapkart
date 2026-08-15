### Task 12: `packages/render/src/hud.ts` — the pure HUD model

Contract §4.8. Rulings Q16 (positions only, no times), Q17 (DNF is derived in
`game`, not here), Q18 (`clamp(lap + 1, 1, RACE_LAPS)`, shown as "LAP n/3"),
Q21 (the throttle indicator reads `motionLocked`, never `accel`).

`hud.ts` produces **numbers and strings**, never DOM. `startShell` (§5.13) calls
`buildHudModel` once per frame and writes the result into the DOM; every branch
the DOM layer would want is a field on `HudModel`, because a conditional in an
adapter is a decision CI cannot see (§0a).

**Files:**
- Create: `packages/render/src/hud.ts`
- Test: `packages/render/test/hud.test.ts`

**Interfaces:**

- Consumes, from `@tapkart/sim` (contract §2.1, §2.2 — quoted verbatim):
  ```ts
  export type ItemKind = 'none' | 'boost' | 'seeker' | 'bolt' | 'slick'
    | 'bubble' | 'surge' | 'blink' | 'charge'
  export type RacePhase = 'countdown' | 'racing' | 'finished'
  export const TICK_DT = 1 / 60
  export const MAX_KARTS = 8
  export const RACE_LAPS = 3
  export const COUNTDOWN_TICKS = 180
  export function clamp(v: number, lo: number, hi: number): number
  // used by this task's test only:
  export function createState(ctx: SimContext, seed: number, characterIdx: number[]): SimState
  export function motionLocked(k: KartState): boolean      // === (k.respawnTicks > 0)
  ```
- Consumes, from `packages/render/src/types.ts` (contract §4.2, an earlier task) —
  the fields this module reads: `RaceView.{tick, phase, localPlayerId,
  raceStartTick, karts, countdownTicksLeft}` and `KartView.{playerId, speed,
  driftTier, item, lap, place, respawnTicks, spinOutTicks, isBot, connected}`,
  plus:
  ```ts
  export function createRaceView(itemBoxCount: number): RaceView
  ```
- Consumes, from `packages/render/test/fixtures/render-fixtures.ts` (§9.1):
  ```ts
  export function makeRenderContext(): SimContext
  ```
- Produces — imported by `src/audio.ts` (Task 13, for `countdownLabelFor`), by
  `src/index.ts`, and by `startShell`:
  ```ts
  export type CountdownLabel = '' | '3' | '2' | '1' | 'GO'
  export interface HudStanding { playerId: number; place: number; lap: number
    isBot: boolean; connected: boolean }
  export interface HudModel { visible: boolean; place: number; fieldSize: number
    lap: number; totalLaps: number; speedKph: number; item: ItemKind
    itemReady: boolean; driftTier: number; countdownLabel: CountdownLabel
    raceClock: string; respawning: boolean; spunOut: boolean; motionLocked: boolean
    standings: HudStanding[] }
  export function createHudModel(): HudModel
  export function buildHudModel(view: RaceView, totalLaps: number, out: HudModel): void
  export function formatRaceClock(ticks: number): string
  export function countdownLabelFor(phase: RacePhase, countdownTicksLeft: number,
                                    ticksSinceStart: number): CountdownLabel
  export const GO_LABEL_TICKS = 45
  ```
  `buildHudModel` is the **sole writer** of every `HudModel` field (§7.2).
  Callers pass `RACE_LAPS` as `totalLaps`.

**Field-by-field, from contract §4.8:**

| Field | Value |
|---|---|
| `visible` | `view.localPlayerId >= 0` |
| `place` | 1-BASED: local seat's `place + 1` |
| `fieldSize` | `MAX_KARTS` |
| `lap` | 1-BASED: `clamp(k.lap + 1, 1, totalLaps)` |
| `totalLaps` | the argument |
| `speedKph` | `Math.round(k.speed * 3.6)` |
| `item` | `k.item` |
| `itemReady` | `k.item !== 'none' && !motionLocked` |
| `driftTier` | `k.driftTier`, sim's encoding (`-1` none, `0..2` an index) |
| `countdownLabel` | `countdownLabelFor(view.phase, view.countdownTicksLeft, ticksSinceStart)` |
| `raceClock` | `formatRaceClock(max(0, view.tick - view.raceStartTick))` |
| `respawning` | `k.respawnTicks > 0` |
| `spunOut` | `k.spinOutTicks > 0` |
| `motionLocked` | `=== respawning` — the throttle indicator reads THIS, not `accel` (Q21) |
| `standings` | length `MAX_KARTS`, sorted by `place` ascending |

**Four decisions a reader must not re-litigate**

1. **Q18 — the lap number is `clamp(lap + 1, 1, totalLaps)`.** `KartState.lap.lap`
   starts at 0 and `updateLaps` credits lap 1 on the first crossing, so the raw
   value reads **"LAP 0/3" on the grid**, which is wrong in every racing game
   ever shipped, and "LAP 4/3" on the finish line, which is worse.
2. **Q16 — no times, anywhere but the live clock.** `raceClock` is a live HUD
   element. Client-recorded times are non-authoritative and differ per peer, so a
   results screen built from them shows eight players eight different sets of
   numbers for the same race. §5.12's results carry **positions and DNF, and
   nothing else**.
3. **Q17 — DNF is not this module's.** `isDnf` and `buildResultRows` live in
   `packages/game/src/results.ts`, because DNF is derived from
   `phase === 'finished'`, `finishTick`, `tick` and `FINISH_GRACE_TICKS` — facts
   `game` already has, needing no `sim` change and no wire change. `HudModel` has
   no `dnf` field and this task adds none.
4. **`standings` is sorted by `place`, and the sort is real.** `view.karts` is
   indexed **by seat** (`karts[3].playerId === 3`), which is *not* standings
   order. The sort is an 8-element insertion sort over the array's own object
   references, so it allocates nothing per frame.

**Two things the contract leaves open, decided here** (both flagged rather than
buried):

- **"`''` before the race" has no reachable view state.** §5.11 step 12 sets
  `countdownTicksLeft = phase === 'countdown' ? max(0, COUNTDOWN_TICKS - tick) : 0`
  and the phase is `'countdown'` from tick 0, so there is no pre-countdown
  moment for a view to describe. `''` is therefore returned in the two states
  that do exist: `'finished'`, and `'racing'` once the GO window has passed.
  `countdownTicksLeft` is clamped into `[0, COUNTDOWN_TICKS]` so the function
  stays total for a caller that passes something else.
- **With no local seat** (`localPlayerId < 0`: a spectator or a replay) the
  per-seat fields are written to their neutral values — `place` and `lap` to `1`
  (both are 1-based for display, so `0` would render "0th" and "LAP 0/3"),
  `driftTier` to `-1` (sim's "no tier"), `item` to `'none'`, the rest to
  `0`/`false`. `standings`, `raceClock`, `countdownLabel`, `totalLaps` and
  `fieldSize` are still filled: none of them needs a local seat, and a spectator
  watching the standings is the reason `visible` is a field rather than a caller
  deleting the HUD.

---

- [ ] **Step 1: Write the failing test**

Create `packages/render/test/hud.test.ts`:

```ts
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
import type { CountdownLabel } from '../src/hud'
import {
  GO_LABEL_TICKS,
  buildHudModel,
  countdownLabelFor,
  createHudModel,
  formatRaceClock,
} from '../src/hud'
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
    expect(countdownLabelFor('countdown', COUNTDOWN_TICKS * 10, 0)).toBe('3')
    expect(countdownLabelFor('countdown', -5, 0)).toBe('GO')
  })
})

describe('buildHudModel', () => {
  it('reports place and lap 1-based, and speed in whole kph', () => {
    const view = raceView()
    view.karts[0].place = 2
    view.karts[0].lap = 1
    view.karts[0].speed = 12.5
    const out = createHudModel()
    buildHudModel(view, RACE_LAPS, out)
    expect(out.visible).toBe(true)
    expect(out.place).toBe(3)
    expect(out.lap).toBe(2)
    expect(out.totalLaps).toBe(RACE_LAPS)
    expect(out.fieldSize).toBe(MAX_KARTS)
    expect(out.speedKph).toBe(45)
  })

  // Q18. Both ends of the clamp: "LAP 0/3" on the grid and "LAP 4/3" after the
  // final crossing are the two ways the raw value is wrong.
  it('never shows lap 0 and never shows lap 4 of 3', () => {
    const view = raceView()
    const out = createHudModel()

    view.karts[0].lap = 0
    buildHudModel(view, RACE_LAPS, out)
    expect(out.lap).toBe(1)

    view.karts[0].lap = 2
    buildHudModel(view, RACE_LAPS, out)
    expect(out.lap).toBe(3)

    view.karts[0].lap = RACE_LAPS
    buildHudModel(view, RACE_LAPS, out)
    expect(out.lap).toBe(RACE_LAPS)

    view.karts[0].lap = 99
    buildHudModel(view, RACE_LAPS, out)
    expect(out.lap).toBe(RACE_LAPS)
  })

  it('rounds speedKph rather than truncating', () => {
    const view = raceView()
    const out = createHudModel()
    view.karts[0].speed = 10
    buildHudModel(view, RACE_LAPS, out)
    expect(out.speedKph).toBe(36)
    view.karts[0].speed = 9.99
    buildHudModel(view, RACE_LAPS, out)
    expect(out.speedKph).toBe(36) // 35.964 rounds up; truncation gives 35
  })

  it('gates itemReady on holding an item AND not being motion-locked (Q21)', () => {
    const view = raceView()
    const out = createHudModel()

    buildHudModel(view, RACE_LAPS, out)
    expect(out.itemReady).toBe(false) // item 'none'

    view.karts[0].item = 'boost'
    buildHudModel(view, RACE_LAPS, out)
    expect(out.item).toBe('boost')
    expect(out.itemReady).toBe(true)

    view.karts[0].respawnTicks = 40
    buildHudModel(view, RACE_LAPS, out)
    expect(out.itemReady).toBe(false)
    expect(out.respawning).toBe(true)
    expect(out.motionLocked).toBe(true)
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

    for (const respawnTicks of [0, 1, 40, 72]) {
      state.karts[0].respawnTicks = respawnTicks
      view.karts[0].respawnTicks = respawnTicks
      buildHudModel(view, RACE_LAPS, out)
      expect(out.motionLocked).toBe(simMotionLocked(state.karts[0]))
      expect(out.motionLocked).toBe(out.respawning)
    }

    // A spun-out kart is steering-locked, not motion-locked: it is still
    // sliding, and the HUD must not tell the player the throttle is dead.
    view.karts[0].respawnTicks = 0
    view.karts[0].spinOutTicks = 30
    buildHudModel(view, RACE_LAPS, out)
    expect(out.spunOut).toBe(true)
    expect(out.motionLocked).toBe(false)
  })

  it('copies driftTier in sim’s encoding, where 0 is a real tier', () => {
    const view = raceView()
    const out = createHudModel()
    for (const tier of [-1, 0, 1, 2]) {
      view.karts[0].driftTier = tier
      buildHudModel(view, RACE_LAPS, out)
      expect(out.driftTier).toBe(tier)
    }
  })

  it('drives raceClock and countdownLabel off raceStartTick', () => {
    const view = raceView()
    const out = createHudModel()

    view.phase = 'countdown'
    view.tick = 0
    view.raceStartTick = COUNTDOWN_TICKS
    view.countdownTicksLeft = COUNTDOWN_TICKS
    buildHudModel(view, RACE_LAPS, out)
    expect(out.countdownLabel).toBe('3')
    expect(out.raceClock).toBe('0:00.000') // the clock does not run yet

    view.phase = 'racing'
    view.tick = COUNTDOWN_TICKS + 60
    view.countdownTicksLeft = 0
    buildHudModel(view, RACE_LAPS, out)
    expect(out.countdownLabel).toBe('')
    expect(out.raceClock).toBe('0:01.000')
  })
})

describe('buildHudModel - standings', () => {
  // The signature defect this test exists for: `view.karts` is indexed BY SEAT,
  // so a builder that emits standings in seat order looks perfectly correct
  // whenever place happens to equal seat - which is true on the grid, and true
  // in every fixture that does not deliberately shuffle. So this shuffles.
  it('sorts by place ascending, not by seat', () => {
    const view = raceView()
    const placeOf = [5, 0, 7, 2, 1, 6, 3, 4] // seat -> place
    for (let i = 0; i < MAX_KARTS; i++) {
      view.karts[i].place = placeOf[i]
      view.karts[i].lap = i % RACE_LAPS
    }
    const out = createHudModel()
    buildHudModel(view, RACE_LAPS, out)

    expect(out.standings).toHaveLength(MAX_KARTS)
    for (let n = 0; n < MAX_KARTS; n++) {
      expect(out.standings[n].place).toBe(n + 1)
    }
    // seat order would put playerId 0 first; place order puts playerId 1 first
    expect(out.standings.map((r) => r.playerId)).toEqual([1, 4, 3, 6, 7, 0, 5, 2])
    expect(out.standings[0].playerId).not.toBe(0)
  })

  it('carries each seat’s own lap, isBot and connected into its row', () => {
    const view = raceView()
    view.karts[3].lap = 2
    view.karts[3].isBot = false
    view.karts[3].connected = false
    const out = createHudModel()
    buildHudModel(view, RACE_LAPS, out)
    const row = out.standings.find((r) => r.playerId === 3)
    expect(row).toBeDefined()
    expect(row?.lap).toBe(3) // 1-based, clamped
    expect(row?.isBot).toBe(false)
    expect(row?.connected).toBe(false)
  })

  it('reuses the standings array instead of allocating one per frame', () => {
    const view = raceView()
    const out = createHudModel()
    const arr = out.standings
    buildHudModel(view, RACE_LAPS, out)
    buildHudModel(view, RACE_LAPS, out)
    expect(out.standings).toBe(arr)
    expect(out.standings).toHaveLength(MAX_KARTS)
  })

  // Catches a stale row surviving a re-sort: build twice with different orders
  // and the second result must not carry any of the first's ordering.
  it('re-sorts cleanly when places change between frames', () => {
    const view = raceView()
    const out = createHudModel()
    buildHudModel(view, RACE_LAPS, out)
    expect(out.standings.map((r) => r.playerId)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])

    for (let i = 0; i < MAX_KARTS; i++) view.karts[i].place = MAX_KARTS - 1 - i
    buildHudModel(view, RACE_LAPS, out)
    expect(out.standings.map((r) => r.playerId)).toEqual([7, 6, 5, 4, 3, 2, 1, 0])
    expect(out.standings.map((r) => r.place)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
  })
})

describe('buildHudModel - no local seat', () => {
  it('hides the HUD but still fills the shared fields', () => {
    const view = raceView()
    view.localPlayerId = -1
    view.tick = 120
    view.raceStartTick = 0
    const out = createHudModel()
    buildHudModel(view, RACE_LAPS, out)

    expect(out.visible).toBe(false)
    expect(out.place).toBe(1)
    expect(out.lap).toBe(1)
    expect(out.speedKph).toBe(0)
    expect(out.item).toBe('none')
    expect(out.itemReady).toBe(false)
    expect(out.driftTier).toBe(-1)
    expect(out.respawning).toBe(false)
    expect(out.motionLocked).toBe(false)
    // A spectator still sees the field and the clock.
    expect(out.fieldSize).toBe(MAX_KARTS)
    expect(out.totalLaps).toBe(RACE_LAPS)
    expect(out.raceClock).toBe('0:02.000')
    expect(out.standings).toHaveLength(MAX_KARTS)
    expect(out.standings[0].playerId).toBe(0)
  })

  it('clears the local fields again after a seat goes away', () => {
    const view = raceView()
    view.karts[0].speed = 30
    view.karts[0].item = 'bolt'
    const out = createHudModel()
    buildHudModel(view, RACE_LAPS, out)
    expect(out.speedKph).toBe(108)

    view.localPlayerId = -1
    buildHudModel(view, RACE_LAPS, out)
    expect(out.speedKph).toBe(0)
    expect(out.item).toBe('none')
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/render/test/hud.test.ts`

Expected: FAIL — the module under test does not exist yet:

```
Error: Failed to load url ../src/hud (resolved id: /home/kasm-user/tapkart/packages/render/src/hud) in /home/kasm-user/tapkart/packages/render/test/hud.test.ts. Does the file exist?
```

- [ ] **Step 3: Write the implementation**

Create `packages/render/src/hud.ts`:

```ts
// PURE (contract §0a): numbers and strings only. No DOM, no clock, no `three`.
// startShell writes these values into the DOM and makes no decision of its own.
import type { ItemKind, RacePhase } from '@tapkart/sim'
import { COUNTDOWN_TICKS, MAX_KARTS, RACE_LAPS, TICK_DT, clamp } from '@tapkart/sim'
import type { RaceView } from './types'

export type CountdownLabel = '' | '3' | '2' | '1' | 'GO'

export interface HudStanding {
  playerId: number
  place: number // 1-based
  lap: number // 1-based, clamped
  isBot: boolean
  connected: boolean
}

export interface HudModel {
  visible: boolean
  place: number // 1-BASED for display
  fieldSize: number // MAX_KARTS in v1
  lap: number // 1-BASED for display: clamp(lap + 1, 1, totalLaps)
  totalLaps: number
  speedKph: number // KartView.speed * 3.6, rounded to an integer
  item: ItemKind
  itemReady: boolean // item !== 'none' && !motionLocked
  driftTier: number // sim's encoding, copied from KartView.driftTier
  countdownLabel: CountdownLabel
  raceClock: string // formatRaceClock(max(0, tick - raceStartTick))
  respawning: boolean // respawnTicks > 0
  spunOut: boolean // spinOutTicks > 0
  /** === respawning. The HUD's throttle indicator reads THIS, not accel (Q21):
   *  adapters keep reporting the player's real input under motion lock, so
   *  `accel` says nothing about whether the kart can move. */
  motionLocked: boolean
  standings: HudStanding[] // length MAX_KARTS, sorted by place ascending
}

/** Ticks the 'GO' label stays up after `racing` begins. */
export const GO_LABEL_TICKS = 45

export function createHudModel(): HudModel {
  const standings: HudStanding[] = []
  for (let i = 0; i < MAX_KARTS; i++) {
    standings.push({ playerId: i, place: i + 1, lap: 1, isBot: true, connected: false })
  }
  return {
    visible: false,
    place: 1,
    fieldSize: MAX_KARTS,
    lap: 1,
    totalLaps: RACE_LAPS,
    speedKph: 0,
    item: 'none',
    itemReady: false,
    driftTier: -1,
    countdownLabel: '',
    raceClock: formatRaceClock(0),
    respawning: false,
    spunOut: false,
    motionLocked: false,
    standings,
  }
}

/**
 * Ticks -> "m:ss.mmm" - minutes unpadded, seconds two digits, milliseconds
 * three. formatRaceClock(0) === '0:00.000', formatRaceClock(3661) === '1:01.017'.
 * ms = Math.round(ticks * TICK_DT * 1000). Pure: no Date, no Intl.
 */
export function formatRaceClock(ticks: number): string {
  const t = Number.isFinite(ticks) && ticks > 0 ? ticks : 0
  const ms = Math.round(t * TICK_DT * 1000)
  const minutes = Math.floor(ms / 60000)
  const seconds = Math.floor((ms % 60000) / 1000)
  const millis = ms % 1000
  return `${minutes}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`
}

/**
 * '3' | '2' | '1' across COUNTDOWN_TICKS in equal thirds, 'GO' from the tick the
 * countdown expires until GO_LABEL_TICKS into the race, then ''.
 *
 * A total function of (phase, two numbers), so it is testable directly and the
 * caller cannot produce a state it has no answer for: `countdownTicksLeft` is
 * clamped into [0, COUNTDOWN_TICKS].
 */
export function countdownLabelFor(
  phase: RacePhase,
  countdownTicksLeft: number,
  ticksSinceStart: number,
): CountdownLabel {
  if (phase === 'countdown') {
    const left = clamp(countdownTicksLeft, 0, COUNTDOWN_TICKS)
    if (left > (COUNTDOWN_TICKS * 2) / 3) return '3'
    if (left > COUNTDOWN_TICKS / 3) return '2'
    if (left > 0) return '1'
    // The countdown's final tick: the lights go green here, and the label runs
    // straight on into the racing branch below with no blank frame between.
    return 'GO'
  }
  if (phase === 'racing') return ticksSinceStart < GO_LABEL_TICKS ? 'GO' : ''
  return ''
}

/**
 * SOLE WRITER of every HudModel field. `visible` is false when
 * `view.localPlayerId < 0`; everything else is read off the local seat, except
 * the fields a spectator still needs - standings, clock, countdown, field size.
 */
export function buildHudModel(view: RaceView, totalLaps: number, out: HudModel): void {
  const pid = view.localPlayerId
  const hasSeat = pid >= 0 && pid < MAX_KARTS
  const ticksSinceStart = Math.max(0, view.tick - view.raceStartTick)

  out.visible = hasSeat
  out.fieldSize = MAX_KARTS
  out.totalLaps = totalLaps
  out.countdownLabel = countdownLabelFor(view.phase, view.countdownTicksLeft, ticksSinceStart)
  out.raceClock = formatRaceClock(ticksSinceStart)

  if (hasSeat) {
    const k = view.karts[pid]
    const locked = k.respawnTicks > 0
    out.place = k.place + 1
    out.lap = clamp(k.lap + 1, 1, totalLaps)
    out.speedKph = Math.round(k.speed * 3.6)
    out.item = k.item
    out.itemReady = k.item !== 'none' && !locked
    out.driftTier = k.driftTier
    out.respawning = locked
    out.spunOut = k.spinOutTicks > 0
    out.motionLocked = locked
  } else {
    // Neutral display values: place and lap are 1-based, so 0 would render
    // "0th" and "LAP 0/3"; driftTier is sim's "no tier".
    out.place = 1
    out.lap = 1
    out.speedKph = 0
    out.item = 'none'
    out.itemReady = false
    out.driftTier = -1
    out.respawning = false
    out.spunOut = false
    out.motionLocked = false
  }

  // Standings: fill by seat, then sort by place. `view.karts` is indexed BY
  // SEAT and is not in standings order.
  for (let i = 0; i < MAX_KARTS; i++) {
    const k = view.karts[i]
    const row = out.standings[i]
    row.playerId = k.playerId
    row.place = k.place + 1
    row.lap = clamp(k.lap + 1, 1, totalLaps)
    row.isBot = k.isBot
    row.connected = k.connected
  }
  // Insertion sort over the array's own references: 8 elements, no allocation,
  // stable, so equal places keep seat order.
  for (let i = 1; i < MAX_KARTS; i++) {
    const row = out.standings[i]
    let j = i - 1
    while (j >= 0 && out.standings[j].place > row.place) {
      out.standings[j + 1] = out.standings[j]
      j--
    }
    out.standings[j + 1] = row
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/render/test/hud.test.ts`
Expected: PASS, 23 tests.

Run: `npm run typecheck --workspace @tapkart/render`
Expected: exit 0, no output.

- [ ] **Step 5: Commit**

```bash
git add packages/render/src/hud.ts packages/render/test/hud.test.ts && git commit -m "feat(render): the pure HUD model

Lap is clamp(lap + 1, 1, totalLaps) so the grid never reads LAP 0/3 (Q18), the
throttle indicator reads motionLocked rather than accel (Q21), standings are
sorted out of seat order into place order by an allocation-free insertion sort,
and raceClock is the only time the HUD reports - results carry positions and DNF
only (Q16, Q17)."
```
