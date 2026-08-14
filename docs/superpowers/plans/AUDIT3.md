# AUDIT 3 — Applicability replay of the Plan 1 edit chain

Method: the whole task sequence 01→18 was replayed in filename order, maintaining the
running content of every repeatedly-edited file. For each "Modify" edit the quoted BEFORE
text was checked character-for-character against the running content at that point (four
anchors were machine-diffed against the text of the task that produced them), and the
post-edit file was checked against `strict` + `noUnusedLocals` + `noUnusedParameters` +
`verbatimModuleSyntax` + `isolatedModules` as `tsconfig.base.json` (Task 1, Step 4) sets them.

Machine-verified byte-identity of the four highest-risk anchors:

| Anchor | Producer | Consumer | Result |
|---|---|---|---|
| whole of `step.ts` | Task 5 Step 15 | Task 6 Step 15 "Before" | identical |
| `surgeFactorFor` + doc comment | Task 6 Step 3 | Task 12 Step 19b "Before" | identical |
| `gripFor` + doc comment | Task 6 Step 11 | Task 8 Step 19 Edit 3 "Before" | identical |
| lateral-grip block (6 lines) | Task 6 Step 11 "After" | Task 8 Step 19 Edit 2 "Before" | identical |

---

## Replay of step.ts

`packages/sim/src/step.ts` is created by Task 5 and then edited 22 times across 9 tasks.

| Task | Edit | Anchor (BEFORE) | Exists? | Notes |
|---|---|---|---|---|
| 5 | create (Step 15) | — | n/a | 15-line file: 2 imports, doc block, `step()` with `void ctx` / `void inputs` / `void events`, `cloneState`, `next.tick = prev.tick + 1`. The three `void` statements are what keep `noUnusedParameters` quiet at this point. |
| 6 | whole-file replace (Step 15) | complete Task 5 file | **yes** | Diffed: Task 6's "Before" is byte-identical to what Task 5 Step 15 writes. "After" is stated as complete, nothing elided. Introduces `NEUTRAL_INTENT`, `resolvedInputs`, the fill loop and the kart loop with the three load-bearing locals. |
| 7 | E1 import | *(no literal anchor)* — "Add this import alongside the other `./` imports at the top" | **yes (anchor-free)** | Adds `import { applyAirYaw, integrateVertical, applyRamps, applyBoostPad } from './ground'`. Placement free; all four names are used in E2, so no unused import. |
| 7 | E2 loop body | `    const k = next.karts[i]` … `    stepKart(ctx, next, prevKart, k, raw)` (4 lines) | **yes** | Exactly the 4 lines Task 6 wrote. Adds slots 5, 6, 6b, 7, 7b. New locals `groundProj`, `groundS`, `groundLateral` are all read. |
| 8 | E1 import | *(no literal anchor)* — "alongside the other `./` imports" | **yes (anchor-free)** | `import { updateDrift, decayBoost } from './drift'`; both used in E2. |
| 8 | E2 loop body | the 12-line body exactly as Task 7 left it | **yes** | `updateDrift(ctx, k, raw)` before `stepKart`, `decayBoost(k)` last. |
| 9 | E1 import | `import { stepKart } from './kart'` | **yes** | unique line; `updateRecovery` inserted after it. |
| 9 | E2 slot 2 | `    updateDrift(ctx, k, raw)` / `    stepKart(ctx, next, prevKart, k, raw)` | **yes** | Exists as a contiguous pair only after Task 8 — ordering dependency is satisfied. |
| 9 | E3 delete `void` | `  void events // used from Task 9 onward, when updateRecovery joins the kart loop` + blank + `  cloneState(prev, next)` | **yes** | Verbatim from Task 6's after-file. Removal is *required*: `events` becomes a genuine read at E2, and leaving `void events` is harmless but the plan removes it. Deleting it before E2 would break `noUnusedParameters`; the plan orders E2 before E3 in the same step, so the file is only typechecked (Step 25) after both. |
| 10 | E1 import | `import { stepKart } from './kart'` | **yes** | still unique (Task 9 inserted *below* it). |
| 10 | E2 post-loop | `    decayBoost(k)` / `  }` / `}` | **yes** | `decayBoost(k)` is still the final statement of the loop body and the file's only call to it. |
| 11 | E1 import | `import { stepKart } from './kart'` | **yes** | unique. |
| 11 | E2 slot 9 | `    decayBoost(k)` (single line) | **yes** | still unique; `updateLaps(ctx, next, k, events)` appended after it, still inside the loop. |
| 12 | E1 import | `import { resolveKartCollisions } from './collision'` | **yes** | Task 10 wrote it; unique. |
| 12 | E2 post-loop | `  resolveKartCollisions(ctx, next)` | **yes** | unique (one call). |
| 13 | E1 import | `import { stepKart } from './kart'` | **yes** | unique. |
| 13 | E2 useItem | the 3 locals `const k` / `const prevKart` / `const raw` | **yes** | Still contiguous after Task 9 inserted *below* `const raw`. Insert lands between `const raw` and Task 9's slot-2 comment. |
| 13 | E3 post-loop | `  resolveKartCollisions(ctx, next)` / `  updateEntities(ctx, next, events)` | **yes** | exact pair produced by Task 12. |
| 15 | E1 import | *(no literal anchor)* — "at the end of the existing import block" | **yes (anchor-free)** | `import { makeIntentBuffer, resolveInputs, updatePhase } from './phase'`; all three used by E2/E4/E5. |
| 15 | E2 buffer swap | `NEUTRAL_INTENT` decl + `resolvedInputs` `Array.from(...)` decl, adjacent, in that order | **yes** | Byte-identical to Task 6's after-file (nothing between them). Applied as a *replacement*, so no `TS2451` redeclaration; the plan calls that failure mode out explicitly. |
| 15 | E3 doc line | ` *   1. resolveInputs      [Task 15] <- this task's fill loop stands in for it` + next line | **yes** | Verbatim from Task 6's after-file, including column alignment. |
| 15 | E4 fill loop → `resolveInputs` | `  next.tick = prev.tick + 1` … through `    const raw = resolvedInputs[i]` | **yes** | Contiguous and verbatim: Task 9's E3 removed the `void events` line *above* `cloneState`, and Task 13's `useItem` line sits *below* `const raw`, so neither disturbs this span. |
| 15 | E5 updatePhase | `  updateItemBoxes(ctx, next, events)` + `}` | **yes** | `updateItemBoxes` is the final statement after Task 13; unique. |

Post-edit typecheck at every step: no symbol is left declared-but-unused, no symbol is
redeclared, no reference survives a deletion.

- `NEUTRAL_INTENT` (Task 6) — its only reader is the fill loop deleted in Task 15 E4;
  Task 15 E2 deletes the declaration in the same step. No `TS6133`.
- `Intent` stays imported (used by `inputs: Intent[]` and `const resolvedInputs: Intent[]`).
- `MAX_KARTS` stays imported (per-kart loop).
- `events` stops needing the `void` stand-in exactly when Task 9 E2 gives it a real reader.
- `ctx` / `inputs` stop needing theirs at Task 6, which is where the `void ctx` / `void inputs`
  lines disappear (whole-file replace).

### Final assembled `packages/sim/src/step.ts`

Import order below is one legal resolution — Tasks 7, 8 and 15 give no literal insertion
anchor, and Tasks 9–13 all insert immediately below `import { stepKart } from './kart'` or
`'./collision'`. The set of imports is fully determined; only their relative order is free,
and order is semantically irrelevant here (no side-effecting module, no cycle).

```typescript
import type { AuthEvent, Intent, SimContext, SimState } from './types'
import { MAX_KARTS } from './types'
import { cloneState } from './state'
import { stepKart } from './kart'
import { updateItemBoxes, useItem } from './items'
import { updateLaps } from './laps'
import { resolveKartCollisions } from './collision'
import { updateEntities } from './entity'
import { updateRecovery } from './recovery'
import { applyAirYaw, integrateVertical, applyRamps, applyBoostPad } from './ground'
import { updateDrift, decayBoost } from './drift'
import { makeIntentBuffer, resolveInputs, updatePhase } from './phase'

/**
 * The resolved intents the whole tick reads. Exactly `MAX_KARTS` distinct Intent
 * objects, allocated once at module load and rewritten in place every tick,
 * because step() must never allocate in the hot path. Indexed by kart slot.
 *
 * `makeIntentBuffer()` [Task 15] produces exactly the shape Task 6's `Array.from`
 * literal produced, so every reader of this buffer is unaffected by the swap.
 */
const resolvedInputs: Intent[] = makeIntentBuffer()

/**
 * Advance the simulation by exactly one 60Hz tick.
 *
 * The tick starts by copying `prev` into `next`; every stage after that writes
 * only into `next`, which is what makes "never mutates prev" true globally.
 * `step` never reads the wall clock and never calls Math.random().
 *
 * `inputs` is indexed by kart slot (`inputs[i]` belongs to `next.karts[i]`, whose
 * `playerId` is `i`). The canonical per-kart stage order, filled in by later
 * tasks, is:
 *   1. resolveInputs      [Task 15] <- implemented
 *   2. updateRecovery     [Task 9]
 *   3. updateDrift        [Task 8]
 *   4. stepKart           [Task 6]  <- implemented
 *   5. applyAirYaw        [Task 7]
 *   6. integrateVertical  [Task 7]
 *   7. applyRamps         [Task 7]
 *   8. decayBoost         [Task 8]
 *   9. updateLaps         [Task 11]
 * then, once per tick after the kart loop:
 *   resolveKartCollisions [Task 10] -> updateEntities [Task 12]
 *   -> updateItemBoxes    [Task 13] -> updatePhase    [Task 15]
 */
export function step(
  ctx: SimContext,
  prev: SimState,
  next: SimState,
  inputs: Intent[],
  events: AuthEvent[],
): void {
  cloneState(prev, next)
  next.tick = prev.tick + 1

  // Canonical per-kart order, position 1: phase gating, bot fill, 30Hz hold and
  // sanitisation, all four at once — this call is what Task 6's stand-in fill loop
  // was standing in for, and it occupies exactly that loop's position. Every stage
  // below this line reads `resolvedInputs`, never the raw `inputs`.
  resolveInputs(ctx, next, inputs, resolvedInputs)

  for (let i = 0; i < MAX_KARTS; i++) {
    const k = next.karts[i]
    const prevKart = prev.karts[i]
    const raw = resolvedInputs[i]
    if (raw.useItem) useItem(ctx, next, k, events)
    // Canonical order slot 2. Recovery runs before drift and before the integrator
    // because it owns this kart's controls for the rest of the tick: stepKart reads
    // steeringLocked / motionLocked, and updateDrift forfeits a charge on a kart
    // that recovery has just put into a spin-out or a respawn.
    updateRecovery(ctx, next, k, events)
    updateDrift(ctx, k, raw)
    stepKart(ctx, next, prevKart, k, raw)
    applyAirYaw(ctx, k, raw.steer)
    integrateVertical(ctx, k)
    // project() returns shared scratch, so both fields are copied out at once and
    // the projection itself is never retained across the calls below.
    const groundProj = ctx.query.project(k.position)
    const groundS = groundProj.s
    const groundLateral = groundProj.lateral
    // Slot 6b: the only recomputation of k.surface in the whole tick. Tasks 6, 8 and
    // 9 read this field (lateral grip, lateralGripFor, surfaceSpeedFactor); without
    // this line it keeps whatever createState put there at the start line forever.
    k.surface = ctx.query.surfaceAt(groundS, groundLateral)
    applyRamps(ctx, k, groundS)
    applyBoostPad(ctx, k, groundS, groundLateral)
    decayBoost(k)
    updateLaps(ctx, next, k, events)
  }

  // Once per tick, after every kart has moved: contact resolution reads the final
  // positions of all eight karts, so it cannot run inside the loop. Contract order
  // from here on is resolveKartCollisions -> updateEntities [Task 12] ->
  // updateItemBoxes [Task 13] -> updatePhase [Task 15].
  resolveKartCollisions(ctx, next)
  updateEntities(ctx, next, events)
  updateItemBoxes(ctx, next, events)
  updatePhase(ctx, next, events)
}
```

### Does the per-tick order match the contract's canonical order?

**Yes.** Contract §2's nine per-kart slots appear in exactly the stated relative order, and
the four once-per-tick calls appear in exactly the stated order:

| Contract slot | Assembled position | Match |
|---|---|---|
| 1 `resolveInputs` | before the loop, after `next.tick` is set | yes |
| 2 `updateRecovery` | loop stmt 3 | yes |
| 3 `updateDrift` | loop stmt 4 | yes |
| 4 `stepKart` | loop stmt 5 | yes |
| 5 `applyAirYaw` | loop stmt 6 | yes |
| 6 `integrateVertical` | loop stmt 7 | yes |
| 7 `applyRamps` | loop stmt 11 | yes |
| 8 `decayBoost` | loop stmt 13 | yes |
| 9 `updateLaps` | loop stmt 14 | yes |
| `resolveKartCollisions` → `updateEntities` → `updateItemBoxes` → `updatePhase` | post-loop, in that order | yes |

Three statements not named in the contract's canonical list are interleaved, each one
declared and justified by the task that adds it:

1. `if (raw.useItem) useItem(...)` — Task 13, ahead of slot 2. The contract lists `useItem`
   in `items.ts` but never places it in the canonical order, so this is an addition rather
   than a reordering. Task 13 documents the reason (a boost fired this tick must be live
   before `stepKart`, and reading `spinOutTicks`/`respawnTicks` *before* `updateRecovery`
   decrements them makes the "keep the item, don't waste it" refusal deterministic).
2. `k.surface = ctx.query.surfaceAt(...)` — Task 7's "slot 6b", between 6 and 7.
3. `applyBoostPad(...)` — Task 7's "slot 7b", between 7 and 8.

None of them moves a contract-named stage relative to another.

---

## Replay of kart.ts

`packages/sim/src/kart.ts` is created by Task 6 (in three sub-steps) and then edited 9 times
across Tasks 8, 9 and 12.

| Task | Edit | Anchor (BEFORE) | Exists? | Notes |
|---|---|---|---|---|
| 6 | Step 3 create | — | n/a | `import type { CharacterStats, KartState, SimContext, SimState, Tuning } from './types'`, local `surgeFactorFor`, exported `targetSpeedFor` with the staged line `  const surfaceFactor = 1`. |
| 6 | Step 7 widen imports | `import type { CharacterStats, KartState, SimContext, SimState, Tuning } from './types'` | **yes** | becomes the 3-line block adding `Intent`, `TICK_DT`, `clamp`/`wrapAngle`. |
| 6 | Step 7 append `stepKart` | — (append) | n/a | steering + horizontal integration only. |
| 6 | Step 11 insert `gripFor` | positional ("between `targetSpeedFor` and `stepKart`") | **yes (positional)** | unambiguous — those are the only two functions it can sit between. |
| 6 | Step 11 replace `stepKart` `!airborne` block | the 14-line `if (!k.airborne) { … }` from Step 7 | **yes** | verbatim. Adds longitudinal + lateral grip + the two `k.velocity` writes. |
| 8 | E1 import | the 3 import lines exactly as Step 7 left them | **yes** | adds `import { lateralGripFor } from './drift'`. |
| 8 | E2 lateral-grip block | 6 lines ending `    const grip = gripFor(k, t)` / `    const newVr = vr * (1 - clamp(grip * TICK_DT, 0, 1))` | **yes (machine-diffed identical)** | replaced by `    const newVr = vr * (1 - clamp(lateralGripFor(ctx, k) * TICK_DT, 0, 1))`. |
| 8 | E3 delete `gripFor` | whole doc comment + `function gripFor(k: KartState, t: Tuning): number { … }` | **yes (machine-diffed identical)** | Must be applied together with E2: after E2 the only call site is gone, so a surviving `gripFor` is `TS6133`. The plan states this and Step 22 is the gate. Its "After" is prose in a fence — `(nothing — the whole block above is removed…)` — which is unambiguous but is the one non-code "After" in the plan. |
| 9 | E1 import | `import { clamp, wrapAngle } from './mathutil'` | **yes** | unique line; adds `import { motionLocked, steeringLocked, surfaceSpeedFactor } from './recovery'`. |
| 9 | E2 surface factor | 3 comment lines + `  const surfaceFactor = 1` | **yes** | verbatim from Task 6 Step 3; replaced by `  const surfaceFactor = surfaceSpeedFactor(k, t)`. The comment lines are part of the anchor and are removed with it, so no stale instruction survives. |
| 9 | E3 motion lock | `  const t = ctx.tuning` / `  const ch = …` / blank / `  if (!k.airborne) {` | **yes** | The `const t`/`const ch` pair also opens `targetSpeedFor`, but only `stepKart` is followed by a blank line and `if (!k.airborne) {`, so the 4-line anchor is unique — as the plan itself argues. |
| 9 | E4 steering lock | `    const authority = sn * (1 - t.steerSpeedFalloff * sn)` / `    const yawRate = t.steerRateBase * raw.steer * ch.handling * authority` | **yes** | verbatim; introduces `const steer` and rewrites `yawRate` to use it. `raw` keeps readers (`raw.brake`, `raw.accel`), so no unused parameter. |
| 12 | E1 import | `import { clamp, wrapAngle } from './mathutil'` | **yes** | Still a single unique line: Tasks 8 and 9 both inserted *beneath* it, never changed it. Adds `import { surgeActiveOn } from './entity'`. |
| 12 | E2 replace `surgeFactorFor` | whole doc comment + 8-line body from Task 6 Step 3 | **yes (machine-diffed identical)** | The signature `(state: SimState, k: KartState, t: Tuning)` is preserved, so the `targetSpeedFor` call site is untouched and the `Tuning`/`SimState` type imports keep their reader. |

### Final assembled `targetSpeedFor`

```typescript
/**
 * The one place every speed modifier is composed. The multiplication order is
 * part of the locked contract: float multiplication is not associative, and the
 * checkpoint-replay equivalence test asserts bit-identity.
 *
 *   maxSpeed * character.speed * accel * surface * surge * boost
 */
export function targetSpeedFor(
  ctx: SimContext,
  state: SimState,
  k: KartState,
  accel: number,
): number {
  const t = ctx.tuning
  const ch = ctx.characters[k.characterIdx] as CharacterStats

  const surfaceFactor = surfaceSpeedFactor(k, t)
  const surgeFactor = surgeFactorFor(state, k, t)
  // Task 8 is what makes boostTicks nonzero; the factor itself is complete.
  const boostFactor = k.boostTicks > 0 ? t.boostSpeedMul : 1

  return t.maxSpeed * ch.speed * accel * surfaceFactor * surgeFactor * boostFactor
}
```

This is exactly the contract's product, in the contract's order:

```
targetSpeed = tuning.maxSpeed
            * characters[k.characterIdx].speed
            * accel
            * surfaceSpeedFactor(k, tuning)                                  [Task 9]
            * (surgeActiveOn(state, k.playerId) ? tuning.surgeSpeedMul : 1)  [Task 12]
            * (k.boostTicks > 0 ? tuning.boostSpeedMul : 1)                  [Task 8]
```

`surgeFactorFor` is a one-line wrapper around `surgeActiveOn(state, k.playerId)` after
Task 12, so the middle term is the contract's term, not a second derivation of it.

### Final assembled `stepKart`

```typescript
export function stepKart(
  ctx: SimContext,
  state: SimState,
  prevKart: KartState,
  k: KartState,
  raw: Intent,
): void {
  const t = ctx.tuning
  const ch = ctx.characters[k.characterIdx] as CharacterStats

  // Canonical order slot 2 already ran this tick. A respawning kart's position and
  // velocity belong to updateRecovery's interpolation, so stepKart does nothing at
  // all for it — not the traction block, and not the position integration below.
  if (motionLocked(k)) return

  if (!k.airborne) {
    // --- Steering -----------------------------------------------------------
    // Authority is measured from the speed at the TOP of the tick, so stages
    // that ran before stepKart cannot change this tick's yaw response.
    const pvx = prevKart.velocity.x
    const pvz = prevKart.velocity.z
    const entrySpeed = Math.sqrt(pvx * pvx + pvz * pvz)
    const sn = clamp(entrySpeed / t.maxSpeed, 0, 1)
    // 0 at rest (no pivoting in place), peak at sn = 1/(2*falloff), reduced at top speed
    const authority = sn * (1 - t.steerSpeedFalloff * sn)
    // A spinning or respawning kart has no steering authority at all (Task 9).
    const steer = steeringLocked(k) ? 0 : raw.steer
    const yawRate = t.steerRateBase * steer * ch.handling * authority
    k.angularVelocity = yawRate
    k.heading = wrapAngle(k.heading + yawRate * TICK_DT)

    // --- Longitudinal -------------------------------------------------------
    // forward = (cos h, 0, sin h); right = (-t.z, 0, t.x) = (-sin h, 0, cos h)
    const fx = Math.cos(k.heading)
    const fz = Math.sin(k.heading)
    const rx = -fz
    const rz = fx
    const vf = k.velocity.x * fx + k.velocity.z * fz
    const vr = k.velocity.x * rx + k.velocity.z * rz

    // Braking wins over the throttle. Off the brake, the same rate applies in
    // both directions, so releasing the throttle coasts down at accelRate.
    const target = raw.brake ? 0 : targetSpeedFor(ctx, state, k, raw.accel)
    const rate = raw.brake ? t.brakeRate : t.accelRate * ch.accel
    const maxDelta = rate * TICK_DT
    const newVf = vf + clamp(target - vf, -maxDelta, maxDelta)

    // --- Lateral grip -------------------------------------------------------
    // lateralGripFor (Task 8) is the single definition of this coefficient:
    // gripDrift while drifting, gripDirt on dirt, gripTarmac on everything else
    // ('boost' and 'offtrack' included — offtrack is penalised through
    // surfaceSpeedFactor, not through grip). updateDrift runs at slot 3, before
    // stepKart, so k.drift.active already holds this tick's value.
    const newVr = vr * (1 - clamp(lateralGripFor(ctx, k) * TICK_DT, 0, 1))

    k.velocity.x = newVf * fx + newVr * rx
    k.velocity.z = newVf * fz + newVr * rz
  }

  // --- Horizontal position integration (y is Task 7's) ----------------------
  k.position.x += k.velocity.x * TICK_DT
  k.position.z += k.velocity.z * TICK_DT
}
```

Final import block of `kart.ts` (order free within the block, contents fixed):

```typescript
import type { CharacterStats, Intent, KartState, SimContext, SimState, Tuning } from './types'
import { TICK_DT } from './types'
import { clamp, wrapAngle } from './mathutil'
import { surgeActiveOn } from './entity'
import { motionLocked, steeringLocked, surfaceSpeedFactor } from './recovery'
import { lateralGripFor } from './drift'
```

### `gripFor` / `surgeFactorFor` / `surfaceFactor` staging — all three resolve cleanly

| Staged symbol | Introduced | Resolved by | Left behind? |
|---|---|---|---|
| `gripFor(k, t)` (local) | Task 6 Step 11 | Task 8 Step 19 Edits 2+3 — call site rewritten to `lateralGripFor(ctx, k)`, then the function *and* its doc comment deleted | **nothing.** One definition of the coefficient survives, in `drift.ts`. |
| `surgeFactorFor(state, k, t)` (local) | Task 6 Step 3 | Task 12 Step 19b — body replaced by `surgeActiveOn(state, k.playerId) ? t.surgeSpeedMul : 1`, signature and call site unchanged | **nothing.** Wrapper kept deliberately; it is the reason `targetSpeedFor` never needed a `void state`. |
| `const surfaceFactor = 1` (literal) | Task 6 Step 3 | Task 9 Step 20 Edit 2 — the literal *and* the 3-line instruction comment become `surfaceSpeedFactor(k, t)` | **nothing.** No stale "Task 9 replaces this line" comment survives. |

Unused-symbol audit of the final `kart.ts`:

- `CharacterStats` — used twice (`as CharacterStats`).
- `Intent` — `raw: Intent`.
- `KartState` — `surgeFactorFor`, `stepKart` params.
- `SimContext`, `SimState` — params.
- `Tuning` — survives Task 8 Edit 3 **only because** `surgeFactorFor(state, k, t: Tuning)` still annotates with it, and survives Task 12 because Task 12 keeps that signature. This is the single tightest link in the chain and it holds.
- `TICK_DT` — 4 uses; `clamp` — 3 uses; `wrapAngle` — 1 use.
- `surgeActiveOn`, `motionLocked`, `steeringLocked`, `surfaceSpeedFactor`, `lateralGripFor` — 1 use each.
- Every parameter of `stepKart` is read: `ctx`, `state` (via `targetSpeedFor`), `prevKart` (entry speed), `k`, `raw` (`raw.brake`, `raw.accel`, and `raw.steer` through `steer`).
- No import cycle: `kart → {entity, recovery, drift}`; `entity → {types, mathutil, state, recovery, placement}`; `drift → {types}`; `recovery → {types, mathutil, state}`. Nothing reaches back to `kart` or to `step`.

---

## Other repeatedly-edited files

### `packages/sim/src/index.ts`

| Task | Edit | Anchor | Exists? | Notes |
|---|---|---|---|---|
| 1 | create | — | n/a | 3 comment lines + `export {}`. |
| 2 | Step 16 whole-file replace | the 3 comment lines + `export {}`, quoted in full | **yes** | Becomes 4 `export *` lines (`types`, `vec3`, `mathutil`, `rng`). Task 2's Files header says "3 lines -> 4 lines"; the file is actually 4 lines → 4 lines. Cosmetic mis-count only; the quoted BEFORE is complete and correct. |
| 18 | Step 3 whole-file replace | ```export * from './types'``` … ```export * from './rng'``` (4 lines) | **yes** | Verbatim what Task 2 leaves. Becomes a header comment + 19 `export *` lines. |

The 19-module list in Task 18 matches the set of `src/*.ts` files the plan actually creates,
exactly and with no extras — `types, vec3, mathutil, rng` (T2), `track` (T3/T4), `state`,
`step` (T5), `kart` (T6), `ground` (T7), `drift` (T8), `recovery` (T9), `collision` (T10),
`laps`, `placement` (T11), `entity` (T12), `items` (T13), `bot` (T14), `phase` (T15),
`replay` (T16). Task 18's test asserts that set against `readdirSync(src)`, and it passes.

`export *` ambiguity check (the test also asserts this at runtime): the union of exported
names across all 19 modules was enumerated and contains no duplicate. The near-misses are
`BOOST_PAD_HALF_LENGTH` (`track`) vs `BOOST_PAD_TICKS` (`ground`), and
`surfaceSpeedFactor` (`recovery`) vs `lateralGripFor` (`drift`) — distinct names in both
cases. Fixture helpers (`makeTuning`, `makeContext`, `makeOvalTrack`) live under `test/`
and so cannot leak into the barrel, which the test also asserts.

### `packages/sim/test/fixtures/track-fixtures.ts`

| Task | Edit | Anchor | Exists? | Notes |
|---|---|---|---|---|
| 3 | Step 3 create | — | n/a | `import type { CharacterStats, Surface, Track, TrackPoint, Tuning } from '../../src/types'` + `import { v3 } from '../../src/vec3'`, then `cp`, `makeTuning`, `makeCharacters`, `makeStraightTrack`, `makeCircleTrack`, `makeOvalTrack`. Deliberately does **not** import `../../src/track`, because `buildTrackQuery` does not exist yet and an ESM link failure would take all of Task 3's tests down. |
| 4 | Step 19 import block | the exact 2 import lines above | **yes** | Widened to a multi-line `import type { CharacterStats, SimContext, Surface, Track, TrackPoint, Tuning }` plus `import { buildTrackQuery } from '../../src/track'`. |
| 4 | Step 19 append `makeContext` | — (append after `makeOvalTrack`) | n/a | `export function makeContext(track: Track, isLeader = true): SimContext` — matches contract §3's signature including the `isLeader` default. |

No later task modifies this file. Typecheck after Task 4: every type import has a reader
(`SimContext` ← `makeContext`'s return type, `TrackPoint` ← `cp`, `Surface` ← `cp` and
`makeOvalTrack`'s `const surface: Surface`, `CharacterStats` ← `makeCharacters`,
`Tuning` ← `makeTuning`, `Track` ← the three track builders), and `buildTrackQuery` and
`v3` are both used. Task 3's own two functions `makeTuning` and `makeCharacters` gain a
second reader in `makeContext`, which is legal and intended.

Ordering dependency holds: Task 4 Step 19 is the first edit that adds the `../../src/track`
import, and by then Task 4 Step 15 has already exported `buildTrackQuery` from `track.ts`.

### `packages/sim/test/helpers/flat-context.ts` (fourth repeatedly-edited file, included for completeness)

| Task | Edit | Anchor | Exists? | Notes |
|---|---|---|---|---|
| 5 | Step 1 create | — | n/a | `makeFlatQuery`, `makeFlatTrack`, `makeTestContext`, `EIGHT_STARTS`. Unused params are written `_s` / `_lateral`, i.e. the file already respects `noUnusedParameters`. |
| 6 | Step 1 widen type import | the 9-line `import type { CharacterStats, SimContext, Surface, Track, TrackPoint, TrackProjection, TrackQuery, Vec3 } from '../../src/types'` block | **yes** | verbatim from Task 5; gains `Intent` and `KartState`. |
| 6 | Step 1 append helpers | — (append) | n/a | `makeKart` (with `lap.checkpointIdx: 3`, matching `createState` on the 4-checkpoint flat track) and `makeIntent`. Both new type imports get a reader in the same edit. |

---

## Blocking defects remaining

None.

Every "Modify" edit in Tasks 2–18 quotes a BEFORE that exists verbatim in the running
content at the moment it is applied, every anchor is unique at that moment, and every
post-edit file satisfies `strict` + `noUnusedLocals` + `noUnusedParameters`.

---

## Placeholders remaining

None.

No `TODO`, `FIXME`, `TBD`, `XXX`, `<insert …>` or elided-code marker (`// ...rest`, `…`)
appears in any code fence across the contract or Tasks 01–18. The three staged values that
*read* like placeholders are all closed by a named edit with literal before/after text, and
each one's instruction comment is deleted along with it:

- `const surfaceFactor = 1` — closed by Task 9 Step 20 Edit 2.
- `function gripFor(k, t)` — closed by Task 8 Step 19 Edits 2 and 3.
- `surgeFactorFor`'s "any live surge this kart does not own" body — closed by Task 12 Step 19b.

The only non-code "After" block in the plan is Task 8 Step 19 Edit 3's
`(nothing — the whole block above is removed. targetSpeedFor's closing brace and stepKart's
doc comment become adjacent, separated by one blank line.)` — prose, but a complete and
unambiguous deletion instruction, not a placeholder.

---

## Non-blocking observations (not defects in the edit chain)

1. **Three edits have no literal anchor** — Task 7 and Task 8 each say "Add this import
   alongside the other `./` imports at the top of the file", and Task 15 Edit 1 says "at the
   end of the existing import block". They are unambiguous (import order is semantically
   free here and no cycle exists), but they are the only edits in the plan where an engineer
   chooses the insertion point.
2. **Transient typecheck gap inside Task 6.** Between Step 7 and Step 11, `stepKart`'s
   `state` parameter has no reader, so the file would fail `noUnusedParameters` if `tsc` ran
   there. It does not: Step 8 runs vitest only, and Step 11 adds
   `targetSpeedFor(ctx, state, k, raw.accel)` before Step 17's `tsc --noEmit`. Same shape
   inside Task 9, where Edit 3 of Step 24 (`void events` deletion) is only safe because
   Edit 2 lands in the same step.
3. **`applyAirYaw` reads `raw.steer`, not the locked steer.** `stepKart` zeroes the steer
   axis via `steeringLocked`, but `step()` passes `raw.steer` straight to `applyAirYaw`. An
   *airborne* spun-out kart therefore keeps full air-steering authority and, because
   `applyAirYaw` rewinds `k.angularVelocity` (which `updateRecovery` has just set to
   `SPIN_YAW_RATE`), also loses the forced spin yaw for that tick. Grounded spin-outs are
   unaffected, and Task 9's own tests cover only the grounded case. Behavioural, not
   structural.
4. **`integrateVertical` still runs on a motion-locked kart.** `stepKart` returns early
   under `motionLocked`, but `applyAirYaw` (no-op, `airborne` is false) and
   `integrateVertical` still execute, and the latter overwrites the respawn interpolation's
   `position.y` with `groundHeight(proj.s, proj.lateral)` at the kart's interpolated XZ.
   Invisible on the flat test query (`groundHeight` is 0 along the interpolation path in
   Task 9's tests) and arguably the desired result on real terrain, but it does mean
   `TARGET.y` is not what lands on the kart mid-respawn.
5. **`useItem` is not in the contract's canonical order list.** Task 13 inserts it ahead of
   slot 2 and documents why. Since §2's list never mentions `useItem`, this is an addition
   rather than a contradiction — but the contract's canonical-order block is now an
   incomplete description of the loop, and a future reader diffing the two will notice.
6. **Task 2's Files line says `index.ts` goes "3 lines -> 4 lines"** where the Task 1 file is
   4 lines (3 comment + `export {}`). The quoted BEFORE in Step 16 is complete and correct;
   only the parenthetical count is off by one.
