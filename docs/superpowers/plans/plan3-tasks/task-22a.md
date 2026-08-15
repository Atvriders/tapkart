### Task 19a: `packages/game/src/results.ts` — result rows and DNF

Split out of the shell task and placed **immediately after the screen-state-machine
task**, for one reason: `app.ts` and `results.ts` import each other, type-only, in both
directions. `app.ts` has `import type { ResultRow } from './results'` because
`AppState.results` is `ResultRow[]`; `results.ts` has `import type { LobbySlot } from
'./app'` because a result row takes its displayed name from the lobby slot. Neither
symbol can move to break the cycle without breaking contract §11's per-module census
(`game/app` = 7, `game/results` = 3).

That means placing this task *before* the app task does not clear the error — it
**inverts** it, shipping `TS2307: Cannot find module './app'` in place of `TS2307:
Cannot find module './results'`. Placed here, the app task keeps exactly one transient
`tsc` error (which its own Step 4 documents and forbids stubbing) and this task clears
it in the very next step, instead of leaving it open across three more tasks where an
implementer running `tsc` would have to remember it was expected.

Vitest is green either way, because `import type` is erased. That is what makes this the
kind of error a plan carries to the end without noticing.

**Files:**
- Create: `packages/game/src/results.ts`
- Test: `packages/game/test/results.test.ts`

Do **not** touch `packages/game/src/index.ts` (the shell task owns the barrel, contract
§5.15) and do **not** touch `packages/game/src/app.ts` — the previous task created it and
it already imports `ResultRow` from this module.

**Interfaces:**

- Consumes, from `@tapkart/sim` (§2.1, §2.2):
  ```ts
  export const RACE_LAPS = 3
  export const FINISH_GRACE_TICKS = 1800      // 30 s at 60 Hz, packages/sim/src/phase.ts:14
  export const MAX_KARTS = 8                  // the test only
  ```
- Consumes, from `@tapkart/render` (§4.2) — reachable by bare specifier only after the
  render barrel task has landed:
  ```ts
  export interface KartView { /* §4.2 */ characterIdx: number; lap: number; playerId: number }
  export interface RaceView { tick: number; alpha: number; phase: RacePhase; localPlayerId: number
    raceStartTick: number; karts: KartView[]; entities: EntityView[]; entityCount: number
    itemBoxes: ItemBoxView[]; itemBoxRespawnTicks: number; finishedOrder: number[]
    finishTick: number; countdownTicksLeft: number }
  export function createRaceView(itemBoxCount: number): RaceView     // value, test only
  ```
- Consumes, from `@tapkart/content` (§3a.6):
  ```ts
  export interface ContentBundle { characters: readonly CharacterDescriptor[]
                                   karts: readonly KartDescriptor[]
                                   themes: Readonly<Record<string, TrackTheme>> }
  export function loadContentBundle(): ContentBundle               // memoised
  ```
- Consumes, from `./app` (the previous task), **type-only**:
  ```ts
  export interface LobbySlot { playerId: number; name: string; characterIdx: number
                               isBot: boolean; connected: boolean; ready: boolean }
  ```

- Produces:
  ```ts
  // packages/game/src/results.ts — the three symbols §11 allocates to game/results
  export interface ResultRow { place: number; playerId: number; name: string; dnf: boolean }
  export function isDnf(view: RaceView, kart: KartView): boolean
  export function buildResultRows(view: RaceView, slots: readonly LobbySlot[]): ResultRow[]
  ```
  The shell task consumes `buildResultRows` from here and re-exports `./results` from the
  barrel; its `barrel.test.ts` namespace-imports this module and asserts
  `buildResultRows` reaches `@tapkart/game`. `isDnf` is used through `buildResultRows`
  and is exported because §11 says three.

**What this task decides, and why**

- **Q16: positions only.** Client-recorded times are non-authoritative and differ per
  peer, so a results screen with times would show eight players eight different sets of
  numbers for the same race. `ResultRow` carries no time and `game` records none.
- **Q17: DNF is derived in `game`, from facts it already has.** A kart is DNF **iff** the
  race ended by grace-timer expiry *and* that kart's lap progress is short of
  `RACE_LAPS`. No sim change, no wire change. Showing a timed-out player "4th" with no
  qualifier is a lie the results screen tells, and `isDnf` is the one line that stops
  telling it.

---

- [ ] **Step 1: Write the failing test**

Create `packages/game/test/results.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { FINISH_GRACE_TICKS, MAX_KARTS, RACE_LAPS } from '@tapkart/sim'
import type { RaceView } from '@tapkart/render'
import { createRaceView } from '@tapkart/render'
import { loadContentBundle } from '@tapkart/content'
import type { LobbySlot } from '../src/app'
import { buildResultRows, isDnf } from '../src/results'

/** A finished race, with `laps` per seat and `order` as the finishing order. */
function makeFinishedView(opts: {
  laps: readonly number[]
  order: readonly number[]
  finishTick: number
  tick: number
  phase?: 'racing' | 'finished'
}): RaceView {
  const view = createRaceView(0)
  view.phase = opts.phase ?? 'finished'
  view.tick = opts.tick
  view.finishTick = opts.finishTick
  for (let i = 0; i < MAX_KARTS; i++) {
    view.karts[i].playerId = i
    view.karts[i].characterIdx = i
    view.karts[i].lap = opts.laps[i]
    view.finishedOrder[i] = i < opts.order.length ? opts.order[i] : -1
  }
  return view
}

// `string | undefined` in the value type is required, not cosmetic: with
// noUncheckedIndexedAccess off, a bare Record<number, string> index is typed
// `string`, and `names[i] === undefined` is then a TS2367 "no overlap" error.
function slots(names: Readonly<Record<number, string | undefined>>): LobbySlot[] {
  const out: LobbySlot[] = []
  for (let i = 0; i < MAX_KARTS; i++) {
    out.push({
      playerId: i,
      name: names[i] ?? '',
      characterIdx: i,
      isBot: names[i] === undefined,
      connected: true,
      ready: true,
    })
  }
  return out
}

describe('isDnf (Q17)', () => {
  it('marks a kart short of RACE_LAPS iff the race ended by grace expiry', () => {
    const laps = [3, 3, 1, 3, 3, 3, 3, 3]
    const short = 2

    // Rows are [label, value] pairs on purpose: `it.each` spreads any row that
    // is itself an array, so a bare table silently re-tests the previous case.
    const cases: Array<[string, RaceView, boolean]> = [
      [
        'still racing',
        makeFinishedView({ laps, order: [0], finishTick: 100, tick: 100 + FINISH_GRACE_TICKS, phase: 'racing' }),
        false,
      ],
      [
        'finished but nobody has crossed (finishTick -1)',
        makeFinishedView({ laps, order: [], finishTick: -1, tick: 9_000 }),
        false,
      ],
      [
        'one tick before the grace timer expires',
        makeFinishedView({ laps, order: [0], finishTick: 100, tick: 100 + FINISH_GRACE_TICKS - 1 }),
        false,
      ],
      [
        'exactly at grace expiry',
        makeFinishedView({ laps, order: [0], finishTick: 100, tick: 100 + FINISH_GRACE_TICKS }),
        true,
      ],
      [
        'long after grace expiry',
        makeFinishedView({ laps, order: [0], finishTick: 100, tick: 100 + FINISH_GRACE_TICKS + 5_000 }),
        true,
      ],
    ]
    for (const [label, view, expected] of cases) {
      expect(`${label}: ${isDnf(view, view.karts[short])}`).toBe(`${label}: ${expected}`)
      // The kart that DID finish is never DNF, whatever the timer says.
      expect(isDnf(view, view.karts[0])).toBe(false)
    }
  })

  it('marks nobody in an all-finished race, at any tick after the finish', () => {
    const view = makeFinishedView({
      laps: [3, 3, 3, 3, 3, 3, 3, 3],
      order: [3, 1, 0, 2, 5, 4, 7, 6],
      finishTick: 500,
      tick: 500 + FINISH_GRACE_TICKS + 100_000,
    })
    for (let i = 0; i < MAX_KARTS; i++) expect(isDnf(view, view.karts[i])).toBe(false)
    expect(RACE_LAPS).toBe(3)
  })
})

describe('buildResultRows (Q16)', () => {
  it('walks finishedOrder in slot order and numbers places from 1', () => {
    const view = makeFinishedView({
      laps: [3, 3, 3, 3, 3, 3, 3, 3],
      order: [5, 2, 0, 7, 1, 3, 6, 4],
      finishTick: 500,
      tick: 600,
    })
    const rows = buildResultRows(view, slots({ 2: 'Ada' }))
    expect(rows.map((r) => r.playerId)).toEqual([5, 2, 0, 7, 1, 3, 6, 4])
    expect(rows.map((r) => r.place)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(rows.every((r) => r.dnf === false)).toBe(true)
  })

  it('emits one row per FILLED slot and skips the -1 padding', () => {
    const view = makeFinishedView({
      laps: [3, 1, 3, 0, 0, 0, 0, 0],
      order: [0, 2],
      finishTick: 500,
      tick: 600,
    })
    const rows = buildResultRows(view, slots({}))
    expect(rows.length).toBe(2)
    expect(rows.map((r) => r.playerId)).toEqual([0, 2])
  })

  it('takes the name from the lobby slot and falls back to the descriptor', () => {
    const view = makeFinishedView({
      laps: [3, 3, 3, 3, 3, 3, 3, 3],
      order: [0, 4],
      finishTick: 500,
      tick: 600,
    })
    const rows = buildResultRows(view, slots({ 0: 'Ada' }))
    expect(rows[0].name).toBe('Ada')
    // Seat 4 has no lobby name; characterIdx 4 supplies the DISPLAYED name.
    // CharacterStats.name ('Racer 4') is never shown — the descriptor's is.
    const descriptors = loadContentBundle().characters
    expect(rows[1].name).toBe(descriptors[4].name)
    expect(rows[1].name).not.toBe('')
  })

  it('marks the graced-out short karts DNF and nobody else', () => {
    // 5 finished; 3 were still driving when the 30 s timer expired and were
    // appended in placement order by updatePhase.
    const view = makeFinishedView({
      laps: [3, 3, 3, 3, 3, 2, 1, 0],
      order: [0, 1, 2, 3, 4, 5, 6, 7],
      finishTick: 500,
      tick: 500 + FINISH_GRACE_TICKS,
    })
    const rows = buildResultRows(view, slots({}))
    expect(rows.filter((r) => r.dnf).map((r) => r.playerId)).toEqual([5, 6, 7])
    expect(rows.filter((r) => !r.dnf).map((r) => r.playerId)).toEqual([0, 1, 2, 3, 4])
    // Places stay contiguous: a DNF still has a position.
    expect(rows.map((r) => r.place)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/game/test/results.test.ts`

Expected: FAIL at collection with
`Error: Failed to load url ../src/results (resolved id: .../packages/game/src/results) ... Does the file exist?`

`../src/app` resolves — the previous task created it — so this is the **only**
unresolved import, and that is the point of running it here rather than earlier.

- [ ] **Step 3: Write `packages/game/src/results.ts`**

```ts
// PURE — Q16 and Q17. No clock, no DOM, no randomness.
import { FINISH_GRACE_TICKS, RACE_LAPS } from '@tapkart/sim'
import type { KartView, RaceView } from '@tapkart/render'
import { loadContentBundle } from '@tapkart/content'
import type { LobbySlot } from './app'

export interface ResultRow {
  place: number // 1-based
  playerId: number
  name: string // from the lobby slot; falls back to the descriptor name
  dnf: boolean
}

/**
 * Q17, literally: a kart is DNF iff the race ended by GRACE-TIMER EXPIRY and
 * that kart's lap progress is short of RACE_LAPS.
 *
 * Both facts are already available to `game`, so there is no sim change and no
 * wire change. Showing a timed-out player "4th" with no qualifier is a lie the
 * results screen tells, and this is the one line that stops telling it.
 */
export function isDnf(view: RaceView, kart: KartView): boolean {
  const gracedOut =
    view.phase === 'finished' &&
    view.finishTick >= 0 &&
    view.tick - view.finishTick >= FINISH_GRACE_TICKS
  return gracedOut && kart.lap < RACE_LAPS
}

/**
 * Walks `view.finishedOrder` in slot order — which IS the finishing order,
 * including the grace-expiry entries `updatePhase` appends in placement order —
 * and emits one row per filled slot.
 *
 * Positions only (Q16): no times, no best lap, because client-recorded times are
 * non-authoritative and differ per peer, so the same race would show eight
 * players eight different sets of numbers.
 */
export function buildResultRows(view: RaceView, slots: readonly LobbySlot[]): ResultRow[] {
  const rows: ResultRow[] = []
  // Memoised, so this parses nothing after the first call anywhere in the
  // process. CharacterStats.name is 'Racer 4' and is never displayed; the
  // DISPLAYED name is the descriptor's (§3a.2), joined by index and never by id.
  const descriptors = loadContentBundle().characters

  for (let i = 0; i < view.finishedOrder.length; i++) {
    const playerId = view.finishedOrder[i]
    if (playerId < 0 || playerId >= view.karts.length) continue // -1 padding
    const kart = view.karts[playerId]

    let name = ''
    for (let s = 0; s < slots.length; s++) {
      if (slots[s].playerId === playerId) {
        name = slots[s].name
        break
      }
    }
    if (name === '') {
      const idx = kart.characterIdx
      name = idx >= 0 && idx < descriptors.length ? descriptors[idx].name : `Player ${playerId + 1}`
    }

    rows.push({ place: rows.length + 1, playerId, name, dnf: isDnf(view, kart) })
  }
  return rows
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/game/test/results.test.ts`
Expected: **6 passing**.

If `loadContentBundle()` throws, the Q2/Q3 content task has not landed yet; the fix is
there, not here — do not stub it.

Then the typecheck, which is the whole reason this task sits where it does:

```bash
npx tsc --noEmit -p packages/game/tsconfig.json
```

Expected: **no output.** The previous task shipped with exactly one `TS2307: Cannot find
module './results'` from `app.ts`, documented there and deliberately not stubbed; this
file clears it. If `tsc` still reports it, the file was written somewhere other than
`packages/game/src/results.ts`. If it now reports `TS2307: Cannot find module './app'`
instead, this task ran **before** the app task rather than after it, which is the exact
inversion the ordering above exists to avoid.

**What each test catches, and whether it would actually fail under that bug:**

| Test | Bug | Fails? |
|---|---|---|
| `isDnf` table | using `>` instead of `>=` at the grace boundary, forgetting the `finishTick >= 0` guard, or marking DNF in a race that is merely `'finished'` early | yes — the boundary is asserted at grace−1, grace and grace+5000, and the finisher is asserted false in every case. The rows are `[label, value]` triples on purpose: `it.each` **spreads** a row that is itself an array, so a bare table silently re-tests the previous case, and an array-rejection bug has already passed under that shape in this project |
| all-finished marks nobody | keying DNF off "the grace timer expired" alone | yes |
| finishedOrder walk | sorting by `place`, or by playerId, instead of walking the finishing order | yes — the order given is deliberately not sorted |
| skips the −1 padding | `indexOf`/`filter`-based scanning that treats padding as a finisher | yes — 8 rows instead of 2 |
| name fallback | falling back to `CharacterStats.name` ('Racer 4') instead of the descriptor's displayed name | yes — the test compares against the real shipped descriptor |
| DNF marking | marking finishers DNF, or dropping DNF rows from the list | yes — places would not be contiguous |

- [ ] **Step 5: Commit**

```bash
git add packages/game/src/results.ts packages/game/test/results.test.ts && \
git commit -m "feat(game): result rows and DNF, positions only (Q16, Q17)"
```
