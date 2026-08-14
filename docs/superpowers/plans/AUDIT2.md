# Plan 1 Re-Audit — sim package (post fix-pass)

Scope: `2026-08-13-tapkart-plan1-contract.md` (authoritative), `specs/2026-08-13-tapkart-design.md`,
`plans/parts/task-01..task-18`, against `plans/AUDIT.md`.

---

## 1. REGRESSIONS FIXED

### From AUDIT §2 (TYPE CONSISTENCY)

| # | Finding | Status | Evidence |
|---|---|---|---|
| C1 | T6/T8 `offtrack` grip defined twice with different values | **FIXED** | T6:774 `function gripFor(k, t)` returns `t.gripTarmac` for offtrack; T6:698 test now expects `7.666666666666666`; T8:706 asserts `lateralGripFor(ctx, makeKart({ surface: 'offtrack' })) === 14`. Same value both sides. |
| C2 | T5 vs T11 initial `lap.checkpointIdx` (phantom lap on tick 1) | **FIXED** | T5:452 `const initialCheckpointIdx = cpCount > 0 ? cpCount - 1 : -1`; T5:374 `expect(st.karts[0].lap.checkpointIdx).toBe(3)`. |
| C3 | `finishedOrder` fixed-length vs growable | **FIXED** | T11:416 `nextFinishSlot()` + `state.finishedOrder[slot] = k.playerId`; T15:750-759 first-`-1`-slot scan; tests use padded `[6,-1,-1,-1,-1,-1,-1,-1]` (T11:302) and `order(...)` helper (T15:461). No `push` anywhere. |
| C4 | `finish` event `data` means two things | **FIXED** | T11:467 `emit(..., 'finish', ..., slot + 1)`; T15:764 `emit(..., 'finish', pid, -1, 'none', finishers)` after `finishers++`; T15:601 expects `[2,3,4,5,6,7,8,8]`. |
| C5 | T12 writes `spinOutTicks` directly | **FIXED** | T12:1093 `startSpinOut(state, k, ctx.tuning.spinOutTicks, events)`; T12:997 adds `import { startSpinOut } from './recovery'`. |
| C6 | `laps.segmentT` mixes normalised `s` with metres | **FIXED** | T11:392 `const end = idx + 1 < n ? cps[idx + 1] : cps[0] + 1`; T11:396 `if (ds < 0) ds += 1`. No `totalLength()` call. |
| C7 | `s` treated as metres in T5/T7/T9/T11/T12/T13/T14 | **FIXED** | Contract §0 row "Track parameter `s` — always arc-normalized `[0,1)`"; T5:177 `s: wrap01(p.x / FLAT_TOTAL_LENGTH)`, `EIGHT_STARTS` now `0…0.028`; T7:381 `ramps: [{ sStart: 0.2, sEnd: 0.3, … }]`; T9:140 `s: wrap01(p.x / TRACK_LENGTH)`; T11:87 / T12:87 same; T13:459 `{ s: 0.1 }`/`{ s: 0.11 }`; T14:364 `wrap01(sNow + metres / total)` and T14:648 `const arc = ds * total`. |
| C8 | T9 stub inverts the `lateral` sign | **FIXED** | T9:140 `project(p) => ({ s: …, lateral: p.z, distance: Math.abs(p.z) })`; contract §3 now reads "positive `lateral` is toward `+z`" with the retraction note. |
| C9 | `step()` edit anchors do not exist (T6 vs T7/T8/T13/T15) | **PARTIAL** | T6:1094-1097 now writes `const k` / `const prevKart` / `const raw = resolvedInputs[i]`; T7:826, T8:903, T13:1419 all anchor on that exact text. **T15 does not** — see NEW-1 and NEW-2. |
| C10 | Contract §2/§3 task numbers swapped | **PARTIAL** | Contract §2 now `validateTrack … [Task 3]` / `buildTrackQuery … [Task 4]`, §3 header `[Task 3]` with `makeContext … [Task 4]`; T3/T4/T5/T7/T9/T16/T17 all cite correctly. **T13:19 and T14:17 still say `track-fixtures.ts [Task 4]` for `makeStraightTrack`, and T14:16 still says `` `ctx.query` [Task 3] ``.** |
| C11 | T14 vs T15 `botIntent` return contract | **FIXED** | T15:19 "It returns a **pooled** `Intent`, one object per `playerId`"; T15:375 "including `botIntent`: it returns a POOLED per-playerId Intent … copied out here by copyIntent". |
| C12 | Six private `makeKart` helpers with a different default | **PARTIAL** | T6:64 documents `checkpointIdx: 3`; T7:63, T8:60, T9:173, T10:74, T11:19 each state their local helper is deliberate and why. **T12:96-98's `blankKart` still uses `checkpointIdx: 0` with no such note** (its comment only explains the parked position). |

### From AUDIT §3 (PLACEHOLDERS)

| # | Finding | Status | Evidence |
|---|---|---|---|
| P1 | T6 two factors are literal `1`s that nothing replaces | **FIXED** | T9 **Files** now lists `packages/sim/src/kart.ts` (T9:6) and Step 20 Edit 2 replaces `const surfaceFactor = 1`; T12 **Files** lists it (T12:5) and Step 19 replaces the surge factor. The surge factor is no longer a literal at all (T6:410 `const surgeFactor = surgeFactorFor(state, k, t)`). |
| P2 | T6 `void state // read from Task 12 onward` | **FIXED** (in T6) | T6:136 "This is also why `targetSpeedFor` has no `void state` line". The line is gone from T6's code. See NEW-4: T12 still tries to delete it. |
| P3 | T7 Step 17 / T8 Step 19 "if the locals are spelled differently" hedge | **FIXED** | Both replaced by literal before/after blocks (T7:824-852, T8:900-944). The hedging paragraph no longer appears in either file. |
| P4 | T8 Step 18 conditional implementation change | **FIXED** | Now a numbered step — T8:827 "**Step 19: Make `stepKart` read `lateralGripFor`, deleting the second definition**" — with `packages/sim/src/kart.ts` in T8's Files (T8:6). |
| P5 | T17 hollow `KartState` code block | **FIXED** | T17:34-53 transcribes all 18 fields, commented "all 18 fields, transcribed from types.ts". |
| P6 | T2 invalid TypeScript in the Produces block | **FIXED** | T2:46-56 is now a prose list ("Type alias `Vec3` — …", "Union types `Surface` (…)", "Interfaces `Intent`, `DriftState`, …"). |

### From AUDIT §4 (SPEC COVERAGE)

| # | Finding | Status | Evidence |
|---|---|---|---|
| S1 | `step()` never calls `updateRecovery` / `updateLaps` / `resolveKartCollisions` / `updateEntities` | **FIXED** | Four new wiring steps, each with its own failing test first: T9 Steps 22-24, T10 Steps 14-16, T11 Steps 9-11, T12 Steps 21-23. Call sites quoted in §2 below. |
| S2 | `k.surface` written once and never recomputed | **FIXED** | T7 Step 19 adds slot 6b `k.surface = ctx.query.surfaceAt(groundS, groundLateral)` with the test at T7:718 ("recomputes k.surface from the query for every kart, every tick"). |
| S3 | Off-track speed penalty never applied | **FIXED** | T9 Step 20 Edit 2 → `const surfaceFactor = surfaceSpeedFactor(k, t)`; test T9:1431 expects `targetSpeedFor(..., surface:'offtrack', 1) ≈ 22`. |
| S4 | Surge item has no effect | **FIXED** (intent) | T12 Step 19 wires `surgeActiveOn` into `targetSpeedFor` with the failing test at T12:1305 (`expect(targetSpeedFor(ctx, state, leader, 1)).toBe(28)`). Two of its three edit anchors are stale — NEW-4, NEW-5. |
| S5 | Spin-out / respawn do not disable control | **FIXED** | T9 Step 20 Edit 3 `if (motionLocked(k)) return`, Edit 4 `const steer = steeringLocked(k) ? 0 : raw.steer`; tests at T9:1375 and T9:1403. |
| S6 | `lateralGripFor` has no consumer | **FIXED** | T8 Step 19 makes `stepKart` call it; T8:806 computes its expectation *from* `lateralGripFor` so a second private copy cannot hide. |
| S7 | `index.ts` never extended past Task 2 | **FIXED** | New **Task 18** re-exports all 19 modules (T18:517-535) with `barrel.test.ts` asserting one named export per module, no ambiguous star-export, and resolution through the bare `@tapkart/sim` specifier. |

**Totals: fixed 22, not-fixed 0, partial 3.**

---

## 2. THE TICK IS WIRED

Reconstructed by applying every `step.ts` edit in task order (T5 creates → T6 replaces whole file →
T7 → T8 → T9 → T10 → T11 → T12 → T13 → T15).

### Assembled `step()` after all 18 tasks

```
cloneState(prev, next)                                      [T5]
next.tick = prev.tick + 1                                   [T5]
resolveInputs(ctx, next, inputs, resolvedInputs)            [T15]  slot 1
for (let i = 0; i < MAX_KARTS; i++) {
  const k = next.karts[i]                                   [T6]
  const prevKart = prev.karts[i]                            [T6]
  const raw = resolvedInputs[i]                             [T6]
  if (raw.useItem) useItem(ctx, next, k, events)            [T13]  (addition, documented)
  updateRecovery(ctx, next, k, events)                      [T9]   slot 2
  updateDrift(ctx, k, raw)                                  [T8]   slot 3
  stepKart(ctx, next, prevKart, k, raw)                     [T6]   slot 4
  applyAirYaw(ctx, k, raw.steer)                            [T7]   slot 5
  integrateVertical(ctx, k)                                 [T7]   slot 6
  const groundProj = ctx.query.project(k.position)          [T7]
  const groundS = groundProj.s
  const groundLateral = groundProj.lateral
  k.surface = ctx.query.surfaceAt(groundS, groundLateral)   [T7]   slot 6b (addition)
  applyRamps(ctx, k, groundS)                               [T7]   slot 7
  applyBoostPad(ctx, k, groundS, groundLateral)             [T7]   slot 7b (addition)
  decayBoost(k)                                             [T8]   slot 8
  updateLaps(ctx, next, k, events)                          [T11]  slot 9
}
resolveKartCollisions(ctx, next)                            [T10]
updateEntities(ctx, next, events)                           [T12]
updateItemBoxes(ctx, next, events)                          [T13]
updatePhase(ctx, next, events)                              [T15]
```

**Matches the contract's canonical order** (contract §2 "Canonical per-kart order inside `step()`",
slots 1-9, then `resolveKartCollisions → updateEntities → updateItemBoxes → updatePhase`), with
three documented additions the contract does not name: `useItem` at the top of the loop body
(T13:1433 justifies reading the recovery timers *before* `updateRecovery` decrements them), and
Task 7's slots 6b and 7b.

### The four previously-dead calls — quoted call sites

- **`updateRecovery`** — T9 Step 24 Edit 2, `packages/sim/src/step.ts`:
  ```typescript
      updateRecovery(ctx, next, k, events)
      updateDrift(ctx, k, raw)
      stepKart(ctx, next, prevKart, k, raw)
  ```
  Import: T9 Step 24 Edit 1 `import { updateRecovery } from './recovery'`. Failing test first:
  T9 Step 22 `describe('step — recovery at slot 2')`.

- **`resolveKartCollisions`** — T10 Step 16 Edit 2:
  ```typescript
      decayBoost(k)
    }

    // Once per tick, after every kart has moved: contact resolution reads the final
    // positions of all eight karts, so it cannot run inside the loop. …
    resolveKartCollisions(ctx, next)
  }
  ```
  Import: `import { resolveKartCollisions } from './collision'`. Failing test first: T10 Step 14
  `describe('step — kart collisions after the per-kart loop')`.

- **`updateLaps`** — T11 Step 11b:
  ```typescript
      decayBoost(k)
      updateLaps(ctx, next, k, events)
  ```
  Import: T11 Step 11a `import { updateLaps } from './laps'`. Failing test first: T11 Step 9c
  `describe('step() wiring')` in `laps.test.ts`.

- **`updateEntities`** — T12 Step 23b:
  ```typescript
    resolveKartCollisions(ctx, next)
    updateEntities(ctx, next, events)
  ```
  Import: T12 Step 23a `import { updateEntities } from './entity'`. Failing test first: T12 Step 21c
  `describe('step() wiring')` in `entity.test.ts`.

### Anchor verification, edit by edit

Every insertion above anchors on text an earlier task writes verbatim — T7:826, T8:903, T9:1683,
T10:1094, T11:889, T12:1514, T13:1419/1447 all quote before-text that exists. **Two exceptions,
both in Task 15** (see NEW-1, NEW-2). Two further cosmetic mismatches in Task 9 (NEW-6, NEW-7).

**Verdict: tick-wired = yes** — with the caveat that Task 15's `resolveInputs` insertion, as
literally written, cannot be applied and, if applied naively, would be overwritten by Task 6's
leftover fill loop (NEW-2). All other 20 call sites are unambiguous.

---

## 3. NEW PROBLEMS

**NEW-1 (blocking) — Task 15 Edit 2 redeclares `resolvedInputs`.**
T6:1033 already declares it at module scope:
```typescript
const resolvedInputs: Intent[] = Array.from({ length: MAX_KARTS }, () => ({ … }))
```
T15:901 says *"Edit 2 — **add** the module-scope resolved-input buffer"*:
```typescript
const resolvedInputs: Intent[] = makeIntentBuffer()
```
Two declarations of the same `const` in one module → `TS2451: Cannot redeclare block-scoped
variable 'resolvedInputs'`. T6:1027 anticipated a *replacement* ("Task 15 replaces … this
initializer with `makeIntentBuffer()`"); T15 says add. **Fix:** reword Edit 2 as a replacement of
the T6 initializer line.

**NEW-2 (blocking) — Task 15 Edit 3's anchor does not exist, and the dead fill loop survives.**
T15:916 quotes:
```typescript
  next.tick = prev.tick + 1

  for (let i = 0; i < MAX_KARTS; i++) {
    const k = next.karts[i]
    const raw = inputs[i]
```
The real text after T6-T13 has (a) T6's pre-Task-15 fill loop between those two statements,
(b) `const prevKart = prev.karts[i]` in the quoted block, and (c) `const raw = resolvedInputs[i]`,
not `inputs[i]`. Applied as written, `resolveInputs(...)` lands *before* T6's fill loop, which then
overwrites `resolvedInputs` with the raw client intents — destroying the countdown freeze, bot fill
and clamping that T15's own Step 9 test asserts. T15 also never deletes `NEUTRAL_INTENT`; deleting
the fill loop without it leaves `noUnusedLocals: true` failing with `TS6133`. **Fix:** rewrite
Edit 3 as "delete the fill loop and `NEUTRAL_INTENT`, insert `resolveInputs(...)` in its place,
leave the kart loop's three locals untouched."

**NEW-3 (blocking) — Task 8 Step 19 Edit 2 quotes text Task 6 no longer writes, and never deletes
`gripFor`.** T8:855-863 "Before":
```typescript
    const grip = k.drift.active
      ? t.gripDrift
      : k.surface === 'dirt' || k.surface === 'offtrack'
        ? t.gripDirt
        : t.gripTarmac
```
T6:837 actually writes `const grip = gripFor(k, t)` plus a module-level `function gripFor(…)`
(T6:774). T6:145-147 instructs Task 8 to make **three** edits including "delete the whole local
`gripFor` function"; T8's Step 19 makes two and states "Nothing else in `stepKart` changes".
Result: `gripFor` loses its only caller and `tsc --noEmit` (T8 Step 22) fails with
`TS6133: 'gripFor' is declared but its value is never read`.

**NEW-4 (blocking) — Task 12 Step 19b deletes a line Task 6 does not write.** T12:1359 "Before":
```typescript
  void state // read from Task 12 onward, by the surge factor
```
T6:136 explicitly states `targetSpeedFor` has no such line. The edit is unapplicable.

**NEW-5 (blocking) — Task 12 Step 19c's anchor does not exist, and the surge rule silently stays
weaker than the contract's.** T12:1373 "Before":
```typescript
  // Task 12 replaces this literal with:
  //   surgeActiveOn(state, k.playerId) ? t.surgeSpeedMul : 1
  const surgeFactor = 1
```
T6:410 writes `const surgeFactor = surgeFactorFor(state, k, t)` with a local `surgeFactorFor`
(T6:380) whose rule is *"any live surge this kart does not own"*, not the contract's *"a surge owned
by a kart ahead"*. T6:117-131 tells Task 12 to replace `surgeFactorFor`'s **body**; T12 tries to
replace a call site that no longer exists. Consequences if followed literally: the T6 rule ships,
and the `import { surgeActiveOn } from './entity'` added by 19a is unused →
`TS6133`. This is silent, not loud: T12's own Step 17 test (owner p5 in place 1, victim p2 in
place 0) passes under **both** rules, so the divergence would not be caught.

**NEW-6 (minor) — Task 9 Step 20 Edit 2 comment mismatch.** T9:1522 quotes a one-line comment
`// Task 9 replaces this literal with: surfaceSpeedFactor(k, t)`; T6:406-408 writes a three-line
comment. The `const surfaceFactor = 1` line is unique in the file, so the edit is recoverable.

**NEW-7 (minor) — Task 9 Step 24 Edit 3 comment mismatch.** T9:1703 quotes
`void events // used from Task 9 onward`; T6:1072 writes
`void events // used from Task 9 onward, when updateRecovery joins the kart loop`.

**NEW-8 (minor) — residual task-number citations contradicting the corrected contract.**
T13:19 and T14:17 cite `track-fixtures.ts [Task 4]` for `makeStraightTrack`/`makeCircleTrack`
(Task 3 produces those; only `makeContext` is Task 4). T14:16 cites `` `ctx.query` [Task 3] ``
(`buildTrackQuery` is Task 4). This is AUDIT C10's tail.

**NEW-9 (minor) — kart-test count arithmetic disagrees across tasks.** T6 Step 12 claims
"16 tests (3 `targetSpeedFor`, 5 steering, 5 longitudinal, 2 lateral grip, 1 airborne)" = 16;
T8 Step 20 says "Task 6's 15 kart tests" and T9 Step 21 says "19 tests: the four written in
Step 18, plus the 15 Task 6 left" (should be 20).

No new type mismatches were found in the module signatures themselves: every function's declared
signature matches the contract's §2 module map, `s` is normalised everywhere, `finishedOrder` is
fixed-length in all six writers/readers, and the barrel's no-ambiguous-export scan (T18:424) has no
actual clash across the 19 modules' exported names.

---

## 4. REMAINING PLACEHOLDERS

**PH-1 — Task 6 Step 3, `packages/sim/src/kart.ts`:** a literal `1` still stands in for the
off-track factor across Tasks 6-8:
```typescript
  // Task 9 replaces this exact line with `const surfaceFactor = surfaceSpeedFactor(k, t)`
  // and adds `import { surfaceSpeedFactor } from './recovery'` at the top of this
  // file. Until then there is no off-track penalty.
  const surfaceFactor = 1
```
Unlike the previous audit, the replacement is now genuinely scheduled and executed (Task 9 Files +
Step 20 Edit 2 + failing test), so this is a staged hand-off rather than an unkept promise. It is
the only surviving *literal* stand-in for a contract factor.

**PH-2 — Task 6 Step 15, `packages/sim/src/step.ts`:** the whole pre-Task-15 input path is an
explicit stand-in, and because of NEW-2 nothing removes it:
```typescript
 *   1. resolveInputs      [Task 15] <- this task's fill loop stands in for it
```
```typescript
  // Canonical position 1, in its pre-Task-15 form: copy each supplied intent into
  // the resolved buffer, substituting NEUTRAL_INTENT for a seat the caller left
  // out. No phase gating, no bot fill, no 30Hz hold and no sanitisation yet — all
  // four arrive with Task 15, which replaces this whole loop with one call.
```
together with `const NEUTRAL_INTENT: Intent = { … }` (T6:1012).

**PH-3 — Task 6 Step 3, `surgeFactorFor`:** real code, but deliberately a weaker rule than the
contract's, with its replacement scheduled by a non-matching anchor (NEW-5):
```typescript
 * Task 12 replaces this entire body with the placement-aware rule it owns:
 *
 *   return surgeActiveOn(state, k.playerId) ? t.surgeSpeedMul : 1
 *
 * which narrows "any live surge this kart does not own" to "a live surge owned by
 * a kart ahead of this one".
```

No other placeholder, hollow interface, `TODO`, elided code block, or "if the existing line spells
its locals differently" hedge survives anywhere in tasks 01-18.
