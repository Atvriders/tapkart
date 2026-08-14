# Plan 1 Audit — sim package

Scope: `2026-08-13-tapkart-plan1-contract.md` (authoritative), `specs/2026-08-13-tapkart-design.md`,
`plans/parts/task-01..task-17`.

---

## 1. COMPLETENESS

- None found. All 17 files exist (`task-01-scaffold` … `task-17-golden`), none is empty, numbering has
  no gaps, and every file ends at its own **Commit** step with a closed code fence. Every task has
  `Files` / `Interfaces` / numbered steps with a failing test before each implementation.

---

## 2. TYPE CONSISTENCY

Heading convention `forward = (cos h, 0, sin h)` and `h = atan2(dir.z, dir.x)` are used consistently in
Tasks 5, 6, 12, 13, 14, 17. No task adds a field to `SimState` or `SimContext` (Task 15's 30 Hz bot
hold is correctly module-level, not a new field). The findings below are the mismatches.

- **T6 vs T8 — `offtrack` lateral grip is defined twice, with different values.**
  T6 `stepKart` uses `k.surface === 'dirt' || k.surface === 'offtrack' ? t.gripDirt : t.gripTarmac`
  and its test asserts `offtrack` damps to `9.166666666666666`. T8 `lateralGripFor` returns
  `gripTarmac` for `offtrack` and its test asserts `14`, and T8 Step 18 orders `stepKart` to *call*
  `lateralGripFor`. Both cannot hold.
  **Correction:** delete the inline grip expression in T6 Step 11 and make `stepKart` call
  `lateralGripFor(ctx, k)` (`import { lateralGripFor } from './drift'`); change T6's test
  "damps less on dirt and off-track" so `surface: 'offtrack'` expects `7.666666666666666`
  (gripTarmac), and rename the test to "damps less on dirt".

- **T5 vs T11 — initial `lap.checkpointIdx` disagrees; as written every kart gains a phantom lap on
  tick 1.**
  T5 sets `lap: { lap: 0, checkpointIdx: -1, t: 0 }`. T11's Interfaces claims
  `checkpointIdx: track.checkpointS.length - 1` and `updateLaps` computes `next = cur + 1`, so with
  `cur = -1` a kart sitting in segment 0 at the start line satisfies `idx === next`, increments
  `lap` and emits `lapCross` on the first tick.
  **Correction:** in T5 Step 3 set `lap: { lap: 0, checkpointIdx: ctx.track.checkpointS.length - 1, t: 0 }`
  (guard `length > 0`), and change T5's assertion `expect(st.karts[0].lap.checkpointIdx).toBe(-1)` to
  `toBe(3)` for the 4-checkpoint flat track. T9's `checkpointTarget` already wraps correctly either way.

- **T5 vs T11/T15/T17 — `finishedOrder` is fixed-length in T5 and a growable list everywhere else.**
  T5: "`finishedOrder` is a **fixed-length** `number[]` of length `MAX_KARTS`, unused slots hold `-1`",
  and `cloneState` throws `'cloneState: dst was not preallocated with the same shape as src'` when the
  lengths differ. T11 does `state.finishedOrder.push(k.playerId)` and T15 does `.indexOf(pid)` /
  `.push(pid)`, which grows it past 8 → the next `cloneState` (and therefore `recordRun`/`replayRun`
  in T16 and the whole T17 golden run) throws.
  **Correction:** in T11 `updateLaps` and T15 `updatePhase`, write into the first slot holding `-1`
  and derive the finisher count as the number of entries `!== -1`; replace `hasFinished` /
  `indexOf(pid) >= 0` with a scan over the 8 fixed slots. Update T11's
  `expect(state.finishedOrder).toEqual([6])` and T15's `toEqual([2,0,1,3,4,5,6,7])` to the padded form.

- **T11 vs T15 — the `finish` event's `data` field means two different things.**
  T11 emits `data = state.finishedOrder.length` after the push ("1-based finishing place", test expects
  1 then 2). T15 emits `data = state.finishedOrder.length - 1` for DNF karts (test expects 1 for the
  kart that actually finished 2nd).
  **Correction:** T15 must emit `state.finishedOrder.length` (1-based) for the per-kart DNF events;
  update its test expectation `events.map(e => e.data)` from `[1,2,3,4,5,6,7,8]` to `[2,3,4,5,6,7,8,8]`
  (the last entry is the race-level event, which stays `finishedOrder.length`).

- **T12 vs T9 — `updateEntities` writes `spinOutTicks` directly, which T9 forbids.**
  T9: "`startSpinOut` … the single entry point Tasks 12 and 13 call … Nothing else may write
  `k.spinOutTicks`", and it enforces the invuln/respawn refusal and the never-shorten rule. T12 Step 11b
  does `k.spinOutTicks = ctx.tuning.spinOutTicks; emit(state, events, 'spinOut', …)` inline.
  **Correction:** in T12 Step 11b replace those two lines with
  `startSpinOut(state, k, ctx.tuning.spinOutTicks, events)` and add
  `import { startSpinOut } from './recovery'`. (T12's invuln/respawn skip guard then becomes redundant
  but harmless; its test asserts only `playerId`, `item`, `data`, which `startSpinOut` matches.)

- **T11 — `laps.segmentT` mixes normalised `s` with metres.**
  T4 fixes `TrackQuery.project().s` as arc-**normalised** `[0,1)` and `checkpointS` as `0..1`, while
  `totalLength()` returns metres. `segmentT` uses `end = cps[0] + total` for the wrapping segment and
  `if (ds < 0) ds += total`, so on any real track the last segment's `t` is ~0 forever.
  **Correction:** in T11 Step 3 use `const end = idx + 1 < n ? cps[idx + 1] : cps[0] + 1` and
  `if (ds < 0) ds += 1`; drop the `ctx.query.totalLength()` call from `segmentT`.

- **T5/T7/T9/T11/T12/T13/T14 — test helpers and several production paths treat `s` as metres; T4
  defines it as `[0,1)`.** This makes concrete assertions fail:
  - T7 `applyBoostPad` test "grants nothing further along the track than the pad" calls
    `applyBoostPad(ctx, k, 30, 0)` with a pad at `s: 10` on a real `makeStraightTrack` query;
    `surfaceAt` does `wrap01(30) = 0`, `ds = |0 - 10| = 10 > 0.5` → `ds = 1 - 10 = -9 ≤ padHalfS` →
    returns `'boost'` and the kart gets 36 ticks. Expected 0.
  - T13 `itemBoxWorldPos` test expects `d.x - a.x ≈ 20` for boxes at `s: 20` and `s: 40`; both
    `wrap01` to `0`, so the difference is `0`.
  - T14 `botCurvature` "is ~1/R on the radius-100 circle": `botLookaheadS` adds
    `BOT_LOOKAHEAD_BASE (6 m) + speed * 0.35` to a normalised `s` and wraps mod `totalLength()`, giving
    `s = 21.4` → `wrap01 → 0.4` of the lap → curvature ≈ `0.117`, not `0.008…0.012`.
  **Correction:** state once, in the contract, that `s` is arc-normalised `[0,1)` and metres are reached
  only through `totalLength()`. Then: T14 `botLookaheadS` must be
  `sNow + (BOT_LOOKAHEAD_BASE + speed * BOT_LOOKAHEAD_PER_SPEED) / total`, wrapped with `wrap01`, and
  `botCurvature`'s `arc` must be `(sLook - sNow wrapped) * total`; T7 and T13 test overrides must use
  `s` in `0..1` (`ramps: [{ sStart: 0.2, sEnd: 0.3, … }]`, `boostPads: [{ s: 0.1, … }]`,
  `itemBoxes: [{ s: 0.02 }, { s: 0.04 }]`) with the expectations recomputed against
  `totalLength() = 1828.3236243`; T5's `makeFlatQuery`, T9's `stubQuery`, T11's and T12's `stubContext`
  must return normalised `s` (e.g. `project: p => ({ s: wrap01(p.x / 1000), … })`,
  `checkpointS: [0, 0.25, 0.5, 0.75]`) or be explicitly documented as metres-model stubs *and* never
  used to justify production behaviour.

- **T9 — the test stub inverts the lateral sign the contract fixes.**
  `project: (p) => ({ s: p.x, lateral: -p.z, … })` with the comment "`lateral` increases toward `-z`,
  matching the contract's note on makeStraightTrack". Contract §0 fixes `right = (-t.z, 0, t.x)`, so for
  `t = (1,0,0)` positive lateral is **+z**; T3 and T4 already record that contract §3's prose is wrong.
  **Correction:** T9 `stubQuery.project` → `({ s: p.x, lateral: p.z, distance: Math.abs(p.z) })` and
  delete the comment; the out-of-bounds fixtures (`position.z = 50`) still work unchanged. Also fix
  contract §3: "`lateral` increases toward `+z`".

- **T6 vs T7/T8/T13/T15 — the `step()` edit anchors do not exist.**
  T6 Step 15 writes the loop body as
  `const supplied = inputs[i]; const raw = supplied === undefined ? NEUTRAL_INTENT : supplied;
  stepKart(ctx, next, prev.karts[i], next.karts[i], raw)` — there is no `k` and no `prevKart` local.
  T7 Step 17, T8 Step 19 and T15 Edit 3 all edit against `stepKart(ctx, next, prevKart, k, raw)` /
  `const k = next.karts[i]`, and T13 Step 19 edits against `updateRecovery(ctx, next, k, events)` and
  `updateEntities(ctx, next, events)` lines that no task ever writes.
  **Correction:** rewrite T6 Step 15's loop body as
  `const k = next.karts[i]; const prevKart = prev.karts[i]; const raw = resolvedInputs[i]` (T15 later
  replaces the `inputs[i]`/`NEUTRAL_INTENT` fallback), and add the missing `updateRecovery` /
  `updateEntities` / `resolveKartCollisions` / `updateLaps` insertions as explicit steps (see
  COVERAGE finding 1) before T13 and T15 edit around them.

- **Contract §2/§3 vs T3/T4 — the task numbers on `track.ts` and the fixtures are swapped.**
  Contract §2 labels `packages/sim/src/track.ts` (`buildTrackQuery`, `validateTrack`) `[Task 3]` and §3
  labels `track-fixtures.ts` `[Task 4]`. The plan puts `makeTuning`/`makeCharacters`/`make*Track` +
  `validateTrack` in Task 3 and `buildTrackQuery` + `makeContext` in Task 4. Tasks 5, 6, 8, 9, 11, 12,
  13, 14, 15, 16 then all cite "`track-fixtures.ts` [Task 4]", and Tasks 7, 9, 14, 17 cite
  "`ctx.query` [Task 3]".
  **Correction:** update contract §2 to `[Task 4]` for `buildTrackQuery` (keeping `validateTrack` at
  Task 3) and §3 to `[Task 3]` for the fixtures, then fix the ten downstream citations.

- **T14 vs T15 — `botIntent`'s return contract is described two ways.**
  T14 rule 2: "`botIntent` returns a **pooled** object, one per `playerId`" (its test asserts
  `botIntent(ctx, state, 2) === a`). T15 `resolveInputs` doc says "Nothing allocates except `botIntent`,
  whose contract return type is a fresh Intent."
  **Correction:** change the T15 comment to "…except nothing: `botIntent` returns a pooled per-playerId
  Intent, whose fields are copied here." The code (`copyIntent`) is already right.

- **T7/T8/T9/T10/T11/T12 — six private `makeKart` helpers duplicate T6's exported one, with a different
  default.** T6 Step 1 adds `makeKart(over?)`/`makeIntent(over?)` to
  `test/helpers/flat-context.ts` with `lap.checkpointIdx: -1`; T7, T8, T9, T10, T11 and T12 each declare
  a local `makeKart`/`blankKart` with `lap: { lap: 0, checkpointIdx: 0, t: 0 }`.
  **Correction:** either import the shared helper in those six tasks, or state in each that the local
  helper is deliberate and align its `checkpointIdx` default with whatever T5 ends up producing (see the
  `checkpointIdx` finding above), so a later reader cannot mistake `0` for the real initial value.

---

## 3. PLACEHOLDERS

- **T6, Step 3 — two factors of the contract's `targetSpeed` product are literal `1`s with a written
  promise instead of code:**
  `// Task 9 replaces this literal with: surfaceSpeedFactor(k, t)` / `const surfaceFactor = 1` and
  `// Task 12 replaces this literal with: surgeActiveOn(state, k.playerId) ? t.surgeSpeedMul : 1` /
  `const surgeFactor = 1`. Neither Task 9 nor Task 12 lists `packages/sim/src/kart.ts` in its Files, so
  the replacement never happens (see COVERAGE 3 and 4).
- **T6, Step 3 — `void state // read from Task 12 onward, by the surge factor`** inside
  `targetSpeedFor`. Nothing removes it; it must be deleted by the same edit that wires `surgeActiveOn`.
- **T7, Step 17 and T8, Step 19 — under-specified edit instead of an exact edit:**
  "If the existing `stepKart` line spells its locals differently — `intent` instead of `raw`, `state`
  instead of `next`, `kart` instead of `k` — keep the names that are already there and pass the same
  three locals." Replace with the literal before/after text, which is knowable from T6.
- **T8, Step 18 — an implementation change described conditionally rather than scheduled:**
  "If only the third fails, `stepKart` is damping lateral velocity with a fixed coefficient … that
  expression must be `lateralGripFor(ctx, k)`, imported with `import { lateralGripFor } from './drift'`."
  This is the fix for CONSISTENCY finding 1 and must become a numbered step that edits `kart.ts`, with
  `packages/sim/src/kart.ts` added to T8's Files.
- **T17, Interfaces — a code block that describes rather than implements:**
  `export interface KartState { /* playerId, characterIdx, isBot, connected, position, velocity, heading,
  angularVelocity, drift, item, airborne, surface, spinOutTicks, invulnTicks, boostTicks, respawnTicks,
  shielded, lap */ }`. Harmless in a Consumes block, but transcribe the real 18 fields or cite
  `types.ts` instead of pasting a hollow interface.
- **T2, Interfaces — the same, in the Produces block:**
  `export type Surface, ItemKind, EntityKind, RacePhase, AuthEventKind` and
  `export interface Intent, DriftState, LapProgress, KartState, EntityState, ItemBoxState, SimState,
  AuthEvent, TrackPoint, Track, CharacterStats, Tuning, SimContext, TrackProjection, TrackQuery` — not
  valid TypeScript. Step 3 transcribes the real file, so this is only shorthand; make it a prose list.

---

## 4. SPEC COVERAGE (Plan 1 scope, design §4 and §8)

- **`step()` never calls `updateRecovery`, `updateLaps`, `resolveKartCollisions` or `updateEntities`.**
  Tasks 9, 10, 11 and 12 do not list `packages/sim/src/step.ts` in their Files and add no wiring step;
  Task 13 and Task 15 only edit *around* lines that were never written. As the plan stands, the assembled
  tick is: `resolveInputs → useItem → updateDrift → stepKart → applyAirYaw → integrateVertical →
  applyRamps → applyBoostPad → decayBoost → updateItemBoxes → updatePhase`. Spec §4 "out-of-bounds
  triggers a 1.2 s respawn", "kart-vs-kart is sphere collision", "a checkpoint ring must be crossed in
  order", and the entire world-entity/item-projectile layer are therefore dead in the live sim, and
  T17's golden run cannot produce a single `lapCross`, `finish` or `hit` event, so the §8
  bot-drivability criterion can never pass.
  **Correction:** add explicit `step.ts` wiring steps in the canonical order — `updateRecovery(ctx, next,
  k, events)` at slot 2 (Task 9), `updateLaps(ctx, next, k, events)` as the last per-kart call (Task 11),
  and `resolveKartCollisions(ctx, next)` then `updateEntities(ctx, next, events)` after the kart loop and
  before `updateItemBoxes` (Tasks 10 and 12), each with its own failing step-level test.

- **`k.surface` is written once in `createState` and never recomputed.** No task assigns `k.surface`
  inside the tick (`grep` finds writes only in T5's `createState` and in test setup). Spec §4 "Lateral
  velocity damped hard on tarmac, loosely on dirt" and "Off-track applies a speed multiplier" are
  therefore unreachable: the dirt sector of `makeOvalTrack` behaves as tarmac and no kart is ever
  `'offtrack'`.
  **Correction:** give Task 7 a fourth slot (it already computes `groundProj`):
  `k.surface = ctx.query.surfaceAt(groundProj.s, groundProj.lateral)` before `applyBoostPad`, with a test.

- **The off-track speed penalty is never applied.** `surfaceSpeedFactor` (Task 9) exists and is tested in
  isolation, but `targetSpeedFor` still multiplies by the literal `1` (PLACEHOLDER 1). Spec §4
  "Off-track applies a speed multiplier".
  **Correction:** Task 9 must add `packages/sim/src/kart.ts` to its Files and replace
  `const surfaceFactor = 1` with `surfaceSpeedFactor(k, t)`.

- **The Surge item has no effect.** `surgeActiveOn` (Task 12) is fully implemented and tested, but nothing
  consumes it; `targetSpeedFor`'s surge factor is still `1`. Spec §4 item table, "Surge — timed
  field-wide slow on everyone ahead".
  **Correction:** Task 12 must add `packages/sim/src/kart.ts` to its Files, replace
  `const surgeFactor = 1` with `surgeActiveOn(state, k.playerId) ? t.surgeSpeedMul : 1`, delete
  `void state`, and add `import { surgeActiveOn } from './entity'`.

- **Spin-out and respawn do not disable control.** Task 9 states "Task 6's `stepKart` treats the steer
  axis as `0` when `steeringLocked` returns true" and "`stepKart` skips its longitudinal/lateral
  integration when `motionLocked` returns true", but `stepKart` never imports or calls either, and Task 9
  does not edit `kart.ts`. A spinning kart keeps full steering and throttle, and a respawning kart's
  interpolation is overwritten by the integrator on the same tick.
  **Correction:** add a Task 9 step editing `stepKart`: `const steer = steeringLocked(k) ? 0 : raw.steer`
  and an early return past the traction/integration block when `motionLocked(k)`.

- **`lateralGripFor` has no consumer.** Task 8 declares "`stepKart` (Task 6) is the consumer" but only
  mentions the call in a conditional troubleshooting note (PLACEHOLDER 4). Same fix as CONSISTENCY
  finding 1.

- **`packages/sim/src/index.ts` is never extended past Task 2.** The workspace exports `"." :
  "./src/index.ts"` and Task 2 leaves the barrel exporting only `types`, `vec3`, `mathutil`, `rng`. No
  task adds `state`, `step`, `track`, `kart`, `ground`, `drift`, `recovery`, `collision`, `laps`,
  `placement`, `entity`, `items`, `bot`, `phase`, `replay`, so Plan 2's `net`/`server`/`game` packages
  cannot import the simulation through `@tapkart/sim`.
  **Correction:** add a barrel step (Task 16 or a short Task 18) re-exporting every `src` module, with a
  test that imports each named export through `../src/index`.
