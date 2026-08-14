### Task 6: Kart handling — `targetSpeedFor` and `stepKart`, wired into `step()`

This task implements the arcade handling model: steering yaw, longitudinal
acceleration toward a target speed, lateral grip, and horizontal position
integration. It also wires the per-kart loop into `step()`.

**Files:**
- Create: `packages/sim/src/kart.ts`
- Test: `packages/sim/test/kart.test.ts`
- Modify: `packages/sim/test/helpers/flat-context.ts` (append two helpers; exact code in Step 1)
- Modify: `packages/sim/src/step.ts` (whole file; Step 15 shows the complete
  before text and the complete final text — nothing is elided)
- Modify: `packages/sim/test/step.test.ts` (append one describe block; exact code in Step 13)

**Interfaces:**

- Consumes (all already exist):
  - `packages/sim/src/types.ts` [Task 2] — types `Vec3`, `Surface`, `Intent`,
    `KartState`, `SimState`, `SimContext`, `Tuning`, `CharacterStats`, `AuthEvent`;
    value constants `TICK_DT = 1/60`, `MAX_KARTS = 8`.
  - `packages/sim/src/mathutil.ts` [Task 2] —
    `clamp(v: number, lo: number, hi: number): number`,
    `wrapAngle(a: number): number` (wraps to `(-π, π]`)
  - `packages/sim/src/state.ts` [Task 5] —
    `createState(ctx: SimContext, seed: number, characterIdx: number[]): SimState`,
    `cloneState(src: SimState, dst: SimState): void`,
    `statesEqual(a: SimState, b: SimState): boolean`
  - `packages/sim/src/step.ts` [Task 5] —
    `step(ctx: SimContext, prev: SimState, next: SimState, inputs: Intent[], events: AuthEvent[]): void`
  - `packages/sim/test/fixtures/track-fixtures.ts` [Task 3] —
    `makeTuning(overrides?: Partial<Tuning>): Tuning`, `makeCharacters(): CharacterStats[]`
  - `packages/sim/test/helpers/flat-context.ts` [Task 5] —
    `makeTestContext(startPositions: { s: number; lateral: number }[]): SimContext`,
    `EIGHT_STARTS: { s: number; lateral: number }[]`. Its `s` values are
    **arc-normalized** (`0.004` is 4 m along the 1000 m flat track), so seat 1
    stands at world `x = 4`.

- Produces (later tasks rely on these verbatim):
  - `targetSpeedFor(ctx: SimContext, state: SimState, k: KartState, accel: number): number`
  - `stepKart(ctx: SimContext, state: SimState, prevKart: KartState, k: KartState, raw: Intent): void`
  - `step()` now runs a per-kart loop over `MAX_KARTS`. **Its exact locals are an
    interface**, because Tasks 7, 8, 13 and 15 all insert calls next to them:

    ```ts
    for (let i = 0; i < MAX_KARTS; i++) {
      const k = next.karts[i]
      const prevKart = prev.karts[i]
      const raw = resolvedInputs[i]
      stepKart(ctx, next, prevKart, k, raw)
    }
    ```

    Never rename `k`, `prevKart` or `raw`, and never add a second `stepKart` call.
  - `step()` also gains two module-scope values: `NEUTRAL_INTENT` (the frozen
    fallback for a seat the caller supplied nothing for) and
    `resolvedInputs: Intent[]`, a preallocated buffer of `MAX_KARTS` distinct
    `Intent` objects that the kart loop reads. Task 15 replaces the loop that
    fills `resolvedInputs` with its `resolveInputs(ctx, next, inputs, resolvedInputs)`
    call; the buffer and the `const raw = resolvedInputs[i]` anchor already exist
    from this task onward, so no later task has to invent them.
  - `packages/sim/test/helpers/flat-context.ts` gains
    `makeKart(over?: Partial<KartState>): KartState` and
    `makeIntent(over?: Partial<Intent>): Intent`. `makeKart` defaults
    `lap` to `{ lap: 0, checkpointIdx: 3, t: 0 }` — **3, not 0 and not -1** —
    because that is what Task 5's `createState` writes on the flat test track
    (`checkpointS.length - 1` with 4 checkpoints), so a kart from this helper is
    indistinguishable from a freshly created one. Tasks 7–12 that declare their
    own local kart builders must use the same default or say in their own text
    why they deliberately differ.

- **Fixture values this task's arithmetic depends on** (locked in the contract):
  `maxSpeed 40`, `accelRate 24`, `brakeRate 48`, `steerRateBase 2.6`,
  `steerSpeedFalloff 0.55`, `gripTarmac 14`, `gripDirt 5`, `gripDrift 3`,
  `boostSpeedMul 1.35`, `surgeSpeedMul 0.7`, `offtrackSpeedMul 0.55`,
  `TICK_DT = 1/60`.
  Character stats, index 0–7:
  `speed [1.00, 1.10, 0.92, 1.05, 0.95, 1.15, 0.88, 1.00]`,
  `accel [1.00, 0.85, 1.15, 0.90, 1.10, 0.80, 1.20, 1.00]`,
  `handling [1.00, 0.90, 1.10, 0.95, 1.05, 0.85, 1.15, 1.00]`,
  `weight [1.00, 1.20, 0.85, 1.10, 0.90, 1.30, 0.80, 1.00]`.

- **The speed-modifier product**, transcribed from the contract and owned here.
  The multiplication order is part of the contract and must not be reordered —
  float multiplication is not associative and the checkpoint-replay equivalence
  test asserts bit-identity:

  ```
  targetSpeed = tuning.maxSpeed
              * characters[k.characterIdx].speed
              * accel
              * surfaceSpeedFactor(k, tuning)                                [Task 9]
              * (surgeActiveOn(state, k.playerId) ? tuning.surgeSpeedMul : 1) [Task 12]
              * (k.boostTicks > 0 ? tuning.boostSpeedMul : 1)                [Task 8 sets boostTicks]
  ```

- **Three factors are owned by later tasks. Each hand-off is a named edit with
  literal before/after text, so no later task has to guess.** `recovery.ts`,
  `entity.ts` and `drift.ts` do not exist yet, so this task ships working code for
  each factor and names the exact replacement:

  1. **Off-track speed penalty — Task 9.** `targetSpeedFor` contains the literal
     line `const surfaceFactor = 1`. Task 9 must add `packages/sim/src/kart.ts`
     to its **Files**, add the import line
     `import { surfaceSpeedFactor } from './recovery'` to `kart.ts`, and replace
     exactly that one line with:

     ```ts
     const surfaceFactor = surfaceSpeedFactor(k, t)
     ```

     Until then the factor is `1`, i.e. no off-track penalty. `surfaceSpeedFactor`
     is not re-derived here: there must be exactly one definition of it and it
     lives in `recovery.ts`.

  2. **Surge field-wide slow — Task 12.** `kart.ts` defines a **local,
     non-exported** `surgeFactorFor(state: SimState, k: KartState, t: Tuning): number`
     and `targetSpeedFor` calls it as `const surgeFactor = surgeFactorFor(state, k, t)`.
     Its body here is complete and honest: it returns `t.surgeSpeedMul` when a
     live surge entity exists that this kart does not own, and `1` otherwise —
     which is `1` for the whole of Tasks 6–11, because nothing spawns an entity
     until Task 12 and `state.entityCount` is `0`. Task 12 must add
     `packages/sim/src/kart.ts` to its **Files**, add
     `import { surgeActiveOn } from './entity'` to `kart.ts`, and replace the
     whole function body with:

     ```ts
     function surgeFactorFor(state: SimState, k: KartState, t: Tuning): number {
       return surgeActiveOn(state, k.playerId) ? t.surgeSpeedMul : 1
     }
     ```

     That refines "any live surge this kart does not own" to Task 12's real rule,
     "a live surge owned by a kart *ahead* of this one", which needs
     `computePlacement` and therefore cannot exist before Task 12. The call site
     in `targetSpeedFor` does not change.
     This is also why `targetSpeedFor` has no `void state` line: `state` is a real
     argument with a real reader from this task onward.

  3. **Lateral grip — Task 8.** `kart.ts` defines a **local, non-exported**
     `gripFor(k: KartState, t: Tuning): number` — `gripDrift` while drifting,
     `gripDirt` on `'dirt'`, `gripTarmac` on everything else including
     `'offtrack'` — and `stepKart` calls it as `const grip = gripFor(k, t)`.
     Task 8 owns the single definition, `lateralGripFor(ctx, k)` in `drift.ts`,
     which returns exactly the same value for all four surfaces. Task 8 must add
     `packages/sim/src/kart.ts` to its **Files** and make three edits to it:
     add `import { lateralGripFor } from './drift'`, delete the whole local
     `gripFor` function, and change the one call site. Before:

     ```ts
     const grip = gripFor(k, t)
     ```

     After:

     ```ts
     const grip = lateralGripFor(ctx, k)
     ```

     No expectation in `kart.test.ts` changes, because the two functions agree on
     every surface — that agreement is the point, and Task 8's own test asserts
     `lateralGripFor(ctx, makeKart({ surface: 'offtrack' })) === 14`.
     **`offtrack` therefore grips like tarmac, not like dirt.** Off-track is
     punished with speed (factor 1 above, `offtrackSpeedMul` from Task 9), not
     with a slide.

  The boost factor needs no missing function — `boostTicks` is a `KartState`
  field that already exists — so it is implemented in full now; Task 8 is only
  what makes it nonzero. Likewise `gripFor` already selects `gripDrift` when
  `k.drift.active`, because the canonical order runs `updateDrift` **before**
  `stepKart` and `updateDrift`'s signature gives it no place to apply grip
  itself. Task 8 sets the flag; the consumer is already here.

- **Explicitly not implemented here** (and where they land):
  - Gravity, vertical integration, ground snap, the airborne flag, ramps →
    Task 7. `stepKart` never reads or writes `position.y` or `velocity.y`.
  - Airborne steering authority → Task 7's `applyAirYaw`. `stepKart` therefore
    skips its whole traction block when `k.airborne` is true, and only integrates
    horizontal position, so the two never double-apply yaw.
  - **`k.surface` is read here and never written here.** Task 7 recomputes it once
    per tick from `ctx.query.surfaceAt(...)` after the kart has moved, so a kart's
    surface changes underneath it during a full `step()`. Every grip test in this
    task therefore calls `stepKart` **directly** with a hand-built kart, and no
    test in this task may assume that a surface set before a `step()` survives
    that `step()`.
  - Kart-vs-kart impulses → Task 10, once per tick after the kart loop.
  - Phase gating, bot fill, input sanitisation and the 30Hz input hold → Task 15's
    `resolveInputs`. Until then `step()` fills its own `resolvedInputs` buffer by
    copying `inputs[i]` field by field, substituting `NEUTRAL_INTENT` for a seat
    the caller supplied nothing for, so karts do move during `'countdown'`. The
    step tests in this task set `prev.phase = 'racing'` anyway, so their
    expectations survive Task 15 unchanged.

- **Handling model decisions this task makes** (nothing in the contract pins
  them, so they are stated once here and are what later tasks tune against):
  - Steering authority curve: with `sn = clamp(speed / maxSpeed, 0, 1)`,
    `authority = sn * (1 - steerSpeedFalloff * sn)`. It is exactly `0` at rest —
    which is what stops the kart pivoting in place — rises to a peak of
    `0.4545…` at `sn = 1/(2 * 0.55) = 0.909`, and falls back to `0.45` at top
    speed. One parameter, no table.
  - `speed` for that curve is measured from **`prevKart.velocity`**, the speed at
    the top of the tick. That is the only use of `prevKart`, and it is deliberate:
    stages that run before `stepKart` within a tick cannot change this tick's yaw
    response, so yaw does not depend on stage ordering.
  - Braking wins over throttle: when `raw.brake` is true the target is `0` and
    the rate is `brakeRate`, regardless of `raw.accel`.
  - When not braking, the same rate — `accelRate * character.accel` — applies in
    both directions, so releasing the throttle coasts down at the acceleration
    rate rather than the brake rate.
  - Grip selection, in `gripFor(k, t)`: `gripDrift` while `drift.active`;
    `gripDirt` on `'dirt'`; `gripTarmac` on `'tarmac'`, `'boost'` **and
    `'offtrack'`**. Lateral damping is `vr * (1 - clamp(grip * TICK_DT, 0, 1))`.
    The `'offtrack'` case matches Task 8's `lateralGripFor` exactly, which is what
    lets Task 8 swap one for the other without touching a single expectation.
  - Horizontal position integrates the post-update velocity, and it runs whether
    or not the kart is airborne.

---

- [ ] **Step 1: Extend the shared test helper**

Append to `packages/sim/test/helpers/flat-context.ts`:

```typescript
/**
 * A single kart at the origin, at rest, on tarmac, facing +X (heading 0).
 *
 * `lap.checkpointIdx` defaults to **3**, not 0 and not -1: that is exactly what
 * createState writes on the flat test track, whose `checkpointS` has 4 entries
 * and whose initial index is therefore `checkpointS.length - 1 = 3`. A kart built
 * here is indistinguishable from a freshly created one, so a lap test can use
 * either without changing its expectations.
 */
export function makeKart(over: Partial<KartState> = {}): KartState {
  return {
    playerId: 0,
    characterIdx: 0,
    isBot: false,
    connected: true,
    position: { x: 0, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    heading: 0,
    angularVelocity: 0,
    drift: { active: false, dir: 0, charge: 0 },
    item: 'none',
    airborne: false,
    surface: 'tarmac',
    spinOutTicks: 0,
    invulnTicks: 0,
    boostTicks: 0,
    respawnTicks: 0,
    shielded: false,
    lap: { lap: 0, checkpointIdx: 3, t: 0 },
    ...over,
  }
}

/** A neutral intent: no steer, no throttle, no brake, no drift, no item. */
export function makeIntent(over: Partial<Intent> = {}): Intent {
  return { tick: 0, steer: 0, accel: 0, brake: false, drift: false, useItem: false, ...over }
}
```

and extend that file's type import from:

```typescript
import type {
  CharacterStats,
  SimContext,
  Surface,
  Track,
  TrackPoint,
  TrackProjection,
  TrackQuery,
  Vec3,
} from '../../src/types'
```

to:

```typescript
import type {
  CharacterStats,
  Intent,
  KartState,
  SimContext,
  Surface,
  Track,
  TrackPoint,
  TrackProjection,
  TrackQuery,
  Vec3,
} from '../../src/types'
```

Then create `packages/sim/test/kart.test.ts` with the `targetSpeedFor` suite:

```typescript
import { describe, expect, it } from 'vitest'
import { EIGHT_STARTS, makeKart, makeTestContext } from './helpers/flat-context'
import { createState } from '../src/state'
import { targetSpeedFor } from '../src/kart'

const ctx = makeTestContext(EIGHT_STARTS)
const state = createState(ctx, 1, [0, 0, 0, 0, 0, 0, 0, 0])

describe('targetSpeedFor', () => {
  it('multiplies maxSpeed by the character speed stat and the accel input', () => {
    // maxSpeed 40 * speed 1.00 * accel 1 * 1 * 1 * 1 = 40
    expect(targetSpeedFor(ctx, state, makeKart({ characterIdx: 0 }), 1)).toBe(40)
    // 40 * 1.10 * 1 = 44
    expect(targetSpeedFor(ctx, state, makeKart({ characterIdx: 1 }), 1)).toBeCloseTo(44, 12)
    // 40 * 0.88 * 1 = 35.2   (character 6 is the slow/high-accel one)
    expect(targetSpeedFor(ctx, state, makeKart({ characterIdx: 6 }), 1)).toBeCloseTo(35.2, 12)
    // 40 * 1.15 * 0.5 = 23
    expect(targetSpeedFor(ctx, state, makeKart({ characterIdx: 5 }), 0.5)).toBeCloseTo(23, 12)
    // 40 * 1.00 * 0.25 = 10
    expect(targetSpeedFor(ctx, state, makeKart({ characterIdx: 0 }), 0.25)).toBe(10)
    // accel 0 -> target 0, the kart coasts down
    expect(targetSpeedFor(ctx, state, makeKart({ characterIdx: 3 }), 0)).toBe(0)
  })

  it('applies boostSpeedMul while boostTicks > 0 and not otherwise', () => {
    // 40 * 1.00 * 1 * 1 * 1 * 1.35 = 54
    expect(targetSpeedFor(ctx, state, makeKart({ characterIdx: 0, boostTicks: 5 }), 1))
      .toBeCloseTo(54, 12)
    // one tick of boost left still counts
    expect(targetSpeedFor(ctx, state, makeKart({ characterIdx: 0, boostTicks: 1 }), 1))
      .toBeCloseTo(54, 12)
    // boostTicks 0 -> factor 1
    expect(targetSpeedFor(ctx, state, makeKart({ characterIdx: 0, boostTicks: 0 }), 1))
      .toBe(40)
    // and it composes with the character stat: 40 * 1.10 * 1 * 1.35 = 59.4
    // (the exact double is 59.400000000000006, hence toBeCloseTo)
    expect(targetSpeedFor(ctx, state, makeKart({ characterIdx: 1, boostTicks: 3 }), 1))
      .toBeCloseTo(59.4, 12)
  })

  it('leaves the surge factor at 1 while no surge entity is live', () => {
    // createState leaves entityCount 0 and every slot dead, so surgeFactorFor
    // finds no 'surge' entity and returns 1: 40 * 1.00 * 1 * 1 * 1 * 1 = 40.
    // This stays true after Task 12 replaces the body with surgeActiveOn(),
    // which also returns false when the pool holds no surge entity.
    expect(state.entityCount).toBe(0)
    expect(targetSpeedFor(ctx, state, makeKart({ characterIdx: 0 }), 1)).toBe(40)
    expect(targetSpeedFor(ctx, state, makeKart({ characterIdx: 0, playerId: 5 }), 1)).toBe(40)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/sim/test/kart.test.ts -t "multiplies maxSpeed by the character speed stat"`

Expected: FAIL with `Failed to resolve import "../src/kart"` (the module does not
exist yet).

- [ ] **Step 3: Write `targetSpeedFor`**

Create `packages/sim/src/kart.ts`:

```typescript
import type { CharacterStats, KartState, SimContext, SimState, Tuning } from './types'

/**
 * The Surge item's field-wide slow, as a multiplier on the target speed.
 *
 * A surge is a live world entity, and no entity can exist before Task 12 creates
 * `entity.ts` — `state.entityCount` is 0 for the whole of Tasks 6-11 — so this
 * returns 1 today. It is still real code rather than a literal, because `state`
 * is a parameter of `targetSpeedFor` and something has to read it.
 *
 * Task 12 replaces this entire body with the placement-aware rule it owns:
 *
 *   return surgeActiveOn(state, k.playerId) ? t.surgeSpeedMul : 1
 *
 * which narrows "any live surge this kart does not own" to "a live surge owned by
 * a kart ahead of this one". That needs computePlacement, which does not exist
 * yet. The call site in targetSpeedFor does not change.
 */
function surgeFactorFor(state: SimState, k: KartState, t: Tuning): number {
  for (let i = 0; i < state.entityCount; i++) {
    const e = state.entities[i]
    if (e.kind !== 'surge') continue
    if (e.ownerId === k.playerId) continue
    return t.surgeSpeedMul
  }
  return 1
}

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

  // Task 9 replaces this exact line with `const surfaceFactor = surfaceSpeedFactor(k, t)`
  // and adds `import { surfaceSpeedFactor } from './recovery'` at the top of this
  // file. Until then there is no off-track penalty.
  const surfaceFactor = 1
  const surgeFactor = surgeFactorFor(state, k, t)
  // Task 8 is what makes boostTicks nonzero; the factor itself is complete.
  const boostFactor = k.boostTicks > 0 ? t.boostSpeedMul : 1

  return t.maxSpeed * ch.speed * accel * surfaceFactor * surgeFactor * boostFactor
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/sim/test/kart.test.ts`

Expected: PASS — 3 tests.

- [ ] **Step 5: Write the failing test for `stepKart` steering**

Change the last import line of `packages/sim/test/kart.test.ts` from:

```typescript
import { targetSpeedFor } from '../src/kart'
```

to:

```typescript
import { stepKart, targetSpeedFor } from '../src/kart'
```

and change:

```typescript
import { EIGHT_STARTS, makeKart, makeTestContext } from './helpers/flat-context'
```

to:

```typescript
import { EIGHT_STARTS, makeIntent, makeKart, makeTestContext } from './helpers/flat-context'
```

Then append to `packages/sim/test/kart.test.ts`:

```typescript
describe('stepKart — steering', () => {
  it('yaws at steerRateBase * steer * handling * the speed-authority curve', () => {
    // At 20 m/s: sn = 20 / 40 = 0.5
    //            authority = 0.5 * (1 - 0.55 * 0.5) = 0.5 * 0.725 = 0.3625
    // character 0 handling 1.00: yaw = 2.6 * 1 * 1.00 * 0.3625 = 0.9425 rad/s
    // heading = 0 + 0.9425 / 60 = 0.015708333333333335
    const k = makeKart({ characterIdx: 0, velocity: { x: 20, y: 0, z: 0 } })
    const prevKart = makeKart({ characterIdx: 0, velocity: { x: 20, y: 0, z: 0 } })
    stepKart(ctx, state, prevKart, k, makeIntent({ steer: 1 }))
    expect(k.angularVelocity).toBeCloseTo(0.9425, 12)
    expect(k.heading).toBeCloseTo(0.015708333333333335, 12)

    // character 2 handling 1.10: yaw = 2.6 * 1 * 1.10 * 0.3625 = 1.03675 rad/s
    // heading = 1.03675 / 60 = 0.01727916666666667
    const k2 = makeKart({ characterIdx: 2, velocity: { x: 20, y: 0, z: 0 } })
    const prev2 = makeKart({ characterIdx: 2, velocity: { x: 20, y: 0, z: 0 } })
    stepKart(ctx, state, prev2, k2, makeIntent({ steer: 1 }))
    expect(k2.angularVelocity).toBeCloseTo(1.03675, 12)
    expect(k2.heading).toBeCloseTo(0.01727916666666667, 12)

    // steer is signed: -1 mirrors exactly
    const k3 = makeKart({ characterIdx: 0, velocity: { x: 20, y: 0, z: 0 } })
    const prev3 = makeKart({ characterIdx: 0, velocity: { x: 20, y: 0, z: 0 } })
    stepKart(ctx, state, prev3, k3, makeIntent({ steer: -1 }))
    expect(k3.angularVelocity).toBeCloseTo(-0.9425, 12)
    expect(k3.heading).toBeCloseTo(-0.015708333333333335, 12)
  })

  it('has zero steering authority at rest, so the kart cannot pivot in place', () => {
    // sn = 0 -> authority = 0 * (1 - 0) = 0 -> yaw = 0 regardless of steer
    const k = makeKart({ characterIdx: 0 })
    const prevKart = makeKart({ characterIdx: 0 })
    stepKart(ctx, state, prevKart, k, makeIntent({ steer: 1 }))
    expect(k.angularVelocity).toBe(0)
    expect(k.heading).toBe(0)
  })

  it('reduces steering authority at top speed by steerSpeedFalloff', () => {
    // At 40 m/s: sn = 1, authority = 1 * (1 - 0.55) = 0.45
    // yaw = 2.6 * 1 * 1.00 * 0.45 = 1.17 rad/s, heading = 1.17 / 60 = 0.0195
    const k = makeKart({ characterIdx: 0, velocity: { x: 40, y: 0, z: 0 } })
    const prevKart = makeKart({ characterIdx: 0, velocity: { x: 40, y: 0, z: 0 } })
    stepKart(ctx, state, prevKart, k, makeIntent({ steer: 1 }))
    expect(k.angularVelocity).toBeCloseTo(1.17, 12)
    expect(k.heading).toBeCloseTo(0.0195, 12)

    // above maxSpeed the curve clamps: sn is clamped to 1, so still 1.17
    const kFast = makeKart({ characterIdx: 0, velocity: { x: 80, y: 0, z: 0 } })
    const prevFast = makeKart({ characterIdx: 0, velocity: { x: 80, y: 0, z: 0 } })
    stepKart(ctx, state, prevFast, kFast, makeIntent({ steer: 1 }))
    expect(kFast.angularVelocity).toBeCloseTo(1.17, 12)
  })

  it('measures steering authority from prevKart, not from the live kart', () => {
    // The live kart is stationary but prevKart entered the tick at 20 m/s, so the
    // authority is the 20 m/s one: 2.6 * 1 * 1.00 * 0.3625 = 0.9425
    const k = makeKart({ characterIdx: 0, velocity: { x: 0, y: 0, z: 0 } })
    const prevKart = makeKart({ characterIdx: 0, velocity: { x: 20, y: 0, z: 0 } })
    stepKart(ctx, state, prevKart, k, makeIntent({ steer: 1 }))
    expect(k.angularVelocity).toBeCloseTo(0.9425, 12)
  })

  it('integrates horizontal position from the current velocity', () => {
    // No steer, no throttle, no brake: velocity is unchanged laterally-free here
    // because it is purely forward. position.x += 10 / 60 = 0.16666666666666666
    // minus one tick of coast-down, which the longitudinal test pins separately;
    // this test only fixes that position moves along +X by velocity * TICK_DT.
    const k = makeKart({ characterIdx: 0, velocity: { x: 10, y: 0, z: 0 } })
    const prevKart = makeKart({ characterIdx: 0, velocity: { x: 10, y: 0, z: 0 } })
    stepKart(ctx, state, prevKart, k, makeIntent({ accel: 0.25 }))
    // target = 40 * 1.00 * 0.25 = 10, vf = 10, so delta = 0 and speed holds at 10
    expect(k.velocity.x).toBeCloseTo(10, 12)
    expect(k.position.x).toBeCloseTo(0.16666666666666666, 12)
    expect(k.position.z).toBe(0)
  })
})
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `npx vitest run packages/sim/test/kart.test.ts -t "yaws at steerRateBase"`

Expected: FAIL with `The requested module '../src/kart' does not provide an export named 'stepKart'`.

- [ ] **Step 7: Write `stepKart`'s steering and position integration**

Extend the imports at the top of `packages/sim/src/kart.ts` from:

```typescript
import type { CharacterStats, KartState, SimContext, SimState, Tuning } from './types'
```

to:

```typescript
import type { CharacterStats, Intent, KartState, SimContext, SimState, Tuning } from './types'
import { TICK_DT } from './types'
import { clamp, wrapAngle } from './mathutil'
```

Then append to `packages/sim/src/kart.ts`:

```typescript
/**
 * One tick of ground handling for one kart: steering yaw, then longitudinal
 * accel/brake toward targetSpeedFor, then lateral grip, then horizontal position
 * integration.
 *
 * Never touches position.y or velocity.y — Task 7's integrateVertical owns those.
 * While airborne the whole traction block is skipped: Task 7's applyAirYaw owns
 * airborne steering, so the two can never double-apply yaw.
 */
export function stepKart(
  ctx: SimContext,
  state: SimState,
  prevKart: KartState,
  k: KartState,
  raw: Intent,
): void {
  const t = ctx.tuning
  const ch = ctx.characters[k.characterIdx] as CharacterStats

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
    const yawRate = t.steerRateBase * raw.steer * ch.handling * authority
    k.angularVelocity = yawRate
    k.heading = wrapAngle(k.heading + yawRate * TICK_DT)
  }

  // --- Horizontal position integration (y is Task 7's) ----------------------
  k.position.x += k.velocity.x * TICK_DT
  k.position.z += k.velocity.z * TICK_DT
}
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `npx vitest run packages/sim/test/kart.test.ts`

Expected: PASS — 8 tests (3 `targetSpeedFor`, 5 steering). The steering suite
passes because with `accel: 0.25` at 10 m/s the not-yet-written longitudinal term
would be a no-op anyway.

- [ ] **Step 9: Write the failing test for longitudinal, lateral grip and airborne**

Append to `packages/sim/test/kart.test.ts`:

```typescript
describe('stepKart — longitudinal', () => {
  it('accelerates toward targetSpeedFor at accelRate * the character accel stat', () => {
    // character 0: rate = 24 * 1.00 = 24, maxDelta = 24 / 60 = 0.4
    // from rest with accel 1: target 40, delta = clamp(40, -0.4, 0.4) = 0.4
    // position.x = 0 + 0.4 / 60 = 0.006666666666666667
    const k = makeKart({ characterIdx: 0 })
    stepKart(ctx, state, makeKart({ characterIdx: 0 }), k, makeIntent({ accel: 1 }))
    expect(k.velocity.x).toBeCloseTo(0.4, 12)
    expect(k.velocity.z).toBeCloseTo(0, 12)
    expect(k.position.x).toBeCloseTo(0.006666666666666667, 12)

    // character 6: accel stat 1.20 -> rate = 24 * 1.20 = 28.8, maxDelta = 0.48
    // position.x = 0.48 / 60 = 0.008
    const k6 = makeKart({ characterIdx: 6 })
    stepKart(ctx, state, makeKart({ characterIdx: 6 }), k6, makeIntent({ accel: 1 }))
    expect(k6.velocity.x).toBeCloseTo(0.48, 12)
    expect(k6.position.x).toBeCloseTo(0.008, 12)
  })

  it('never overshoots the target speed', () => {
    // 40 - 39.75 = 0.25, which is inside maxDelta 0.4, so it lands exactly on 40
    const k = makeKart({ characterIdx: 0, velocity: { x: 39.75, y: 0, z: 0 } })
    const prevKart = makeKart({ characterIdx: 0, velocity: { x: 39.75, y: 0, z: 0 } })
    stepKart(ctx, state, prevKart, k, makeIntent({ accel: 1 }))
    expect(k.velocity.x).toBe(40)
    expect(k.position.x).toBeCloseTo(0.6666666666666666, 12) // 40 / 60

    // already at target: delta = 0
    const kAt = makeKart({ characterIdx: 0, velocity: { x: 40, y: 0, z: 0 } })
    const prevAt = makeKart({ characterIdx: 0, velocity: { x: 40, y: 0, z: 0 } })
    stepKart(ctx, state, prevAt, kAt, makeIntent({ accel: 1 }))
    expect(kAt.velocity.x).toBe(40)
  })

  it('brakes toward zero at brakeRate, ignoring the throttle', () => {
    // maxDelta = 48 / 60 = 0.8, so 20 -> 19.2
    const k = makeKart({ characterIdx: 0, velocity: { x: 20, y: 0, z: 0 } })
    const prevKart = makeKart({ characterIdx: 0, velocity: { x: 20, y: 0, z: 0 } })
    stepKart(ctx, state, prevKart, k, makeIntent({ accel: 1, brake: true }))
    expect(k.velocity.x).toBeCloseTo(19.2, 12)
  })

  it('coasts down at accelRate when the throttle is released', () => {
    // accel 0 -> target 0, rate = 24 * 1.00, maxDelta = 0.4, so 20 -> 19.6
    const k = makeKart({ characterIdx: 0, velocity: { x: 20, y: 0, z: 0 } })
    const prevKart = makeKart({ characterIdx: 0, velocity: { x: 20, y: 0, z: 0 } })
    stepKart(ctx, state, prevKart, k, makeIntent({ accel: 0 }))
    expect(k.velocity.x).toBeCloseTo(19.6, 12)
  })

  it('never touches the vertical axis', () => {
    const k = makeKart({ characterIdx: 0, velocity: { x: 20, y: -5, z: 0 }, position: { x: 0, y: 7, z: 0 } })
    const prevKart = makeKart({ characterIdx: 0, velocity: { x: 20, y: -5, z: 0 } })
    stepKart(ctx, state, prevKart, k, makeIntent({ accel: 1 }))
    expect(k.velocity.y).toBe(-5)
    expect(k.position.y).toBe(7)
  })
})

// These tests call stepKart directly with a hand-built kart, never through
// step(), because Task 7 recomputes k.surface from the query every tick and would
// otherwise decide the surface for them.
describe('stepKart — lateral grip', () => {
  it('damps sideways velocity by gripTarmac', () => {
    // heading 0 -> forward (1,0,0), right = (-sin h, 0, cos h) = (0,0,1)
    // vf = 0, vr = 10. accel 0 -> target 0 and vf is already 0, so delta = 0.
    // damp = clamp(14 / 60, 0, 1) = 0.23333333333333334
    // vr' = 10 * (1 - 0.23333333333333334) = 7.666666666666666
    // position.z = 0 + 7.666666666666666 / 60 = 0.12777777777777777
    const k = makeKart({ characterIdx: 0, velocity: { x: 0, y: 0, z: 10 }, surface: 'tarmac' })
    const prevKart = makeKart({ characterIdx: 0, velocity: { x: 0, y: 0, z: 10 } })
    stepKart(ctx, state, prevKart, k, makeIntent())
    expect(k.velocity.z).toBeCloseTo(7.666666666666666, 12)
    expect(k.velocity.x).toBeCloseTo(0, 12)
    expect(k.position.z).toBeCloseTo(0.12777777777777777, 12)
  })

  it('damps less on dirt, and least while drifting', () => {
    // dirt: damp = 5 / 60 = 0.08333333333333333 -> 10 * 0.9166666666666667 = 9.166666666666666
    const kDirt = makeKart({ characterIdx: 0, velocity: { x: 0, y: 0, z: 10 }, surface: 'dirt' })
    stepKart(ctx, state, makeKart({ velocity: { x: 0, y: 0, z: 10 } }), kDirt, makeIntent())
    expect(kDirt.velocity.z).toBeCloseTo(9.166666666666666, 12)

    // offtrack grips like TARMAC, not like dirt: gripFor returns gripDirt only for
    // 'dirt'. Off-track is punished with speed (offtrackSpeedMul, Task 9), not with
    // a slide, and Task 8's lateralGripFor makes the same choice — it asserts 14
    // for 'offtrack'. So: damp = 14 / 60 -> 10 * 0.7666666666666666 = 7.666666666666666
    const kOff = makeKart({ characterIdx: 0, velocity: { x: 0, y: 0, z: 10 }, surface: 'offtrack' })
    stepKart(ctx, state, makeKart({ velocity: { x: 0, y: 0, z: 10 } }), kOff, makeIntent())
    expect(kOff.velocity.z).toBeCloseTo(7.666666666666666, 12)

    // boost pads are tarmac-grippy: 7.666666666666666
    const kBoost = makeKart({ characterIdx: 0, velocity: { x: 0, y: 0, z: 10 }, surface: 'boost' })
    stepKart(ctx, state, makeKart({ velocity: { x: 0, y: 0, z: 10 } }), kBoost, makeIntent())
    expect(kBoost.velocity.z).toBeCloseTo(7.666666666666666, 12)

    // drifting overrides the surface: damp = 3 / 60 = 0.05 -> 10 * 0.95 = 9.5
    const kDrift = makeKart({
      characterIdx: 0,
      velocity: { x: 0, y: 0, z: 10 },
      surface: 'tarmac',
      drift: { active: true, dir: 1, charge: 0 },
    })
    stepKart(ctx, state, makeKart({ velocity: { x: 0, y: 0, z: 10 } }), kDrift, makeIntent())
    expect(kDrift.velocity.z).toBeCloseTo(9.5, 12)
  })
})

describe('stepKart — airborne', () => {
  it('leaves orientation and velocity alone but still integrates horizontally', () => {
    // Airborne: no traction, so no yaw, no throttle and no lateral damping.
    // position.x = 1 + 10 / 60 = 1.1666666666666667
    // position.z = 3 +  4 / 60 = 3.066666666666667
    const k = makeKart({
      characterIdx: 0,
      airborne: true,
      heading: 0.3,
      position: { x: 1, y: 2, z: 3 },
      velocity: { x: 10, y: 0, z: 4 },
    })
    const prevKart = makeKart({
      characterIdx: 0,
      airborne: true,
      heading: 0.3,
      velocity: { x: 10, y: 0, z: 4 },
    })
    stepKart(ctx, state, prevKart, k, makeIntent({ steer: 1, accel: 1 }))

    expect(k.velocity.x).toBe(10)
    expect(k.velocity.z).toBe(4)
    expect(k.heading).toBe(0.3)
    expect(k.angularVelocity).toBe(0)
    expect(k.position.x).toBeCloseTo(1.1666666666666667, 12)
    expect(k.position.z).toBeCloseTo(3.066666666666667, 12)
    expect(k.position.y).toBe(2)
  })
})
```

- [ ] **Step 10: Run the test to verify it fails**

Run: `npx vitest run packages/sim/test/kart.test.ts -t "accelerates toward targetSpeedFor"`

Expected: FAIL with `expected 0 to be close to 0.4` — `stepKart` currently only
steers and integrates position, so `velocity.x` is still `0`.

- [ ] **Step 11: Write the full `stepKart`**

First insert this local helper into `packages/sim/src/kart.ts`, between
`targetSpeedFor` and `stepKart`:

```typescript
/**
 * The lateral damping coefficient, in 1/s: how hard the sideways component of the
 * velocity is bled off this tick.
 *
 * `'offtrack'` grips like tarmac on purpose. Leaving the track is punished with
 * speed (`offtrackSpeedMul`, Task 9), not with a slide; making it slippery as
 * well would make a bad line unrecoverable.
 *
 * Task 8 owns the single definition of this rule, `lateralGripFor(ctx, k)` in
 * `drift.ts`, and it returns the same value for all four surfaces. Task 8 deletes
 * this function, adds `import { lateralGripFor } from './drift'` to this file and
 * changes the one call site below to `const grip = lateralGripFor(ctx, k)`.
 */
function gripFor(k: KartState, t: Tuning): number {
  if (k.drift.active) return t.gripDrift
  if (k.surface === 'dirt') return t.gripDirt
  return t.gripTarmac
}
```

Then replace the whole `stepKart` function in `packages/sim/src/kart.ts`. Before:

```typescript
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
    const yawRate = t.steerRateBase * raw.steer * ch.handling * authority
    k.angularVelocity = yawRate
    k.heading = wrapAngle(k.heading + yawRate * TICK_DT)
  }
```

After:

```typescript
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
    const yawRate = t.steerRateBase * raw.steer * ch.handling * authority
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
    // Task 8 sets drift.active; the consumer lives here because updateDrift runs
    // before stepKart in the canonical order and has nowhere to apply grip.
    // Task 8 changes this one line to: const grip = lateralGripFor(ctx, k)
    const grip = gripFor(k, t)
    const newVr = vr * (1 - clamp(grip * TICK_DT, 0, 1))

    k.velocity.x = newVf * fx + newVr * rx
    k.velocity.z = newVf * fz + newVr * rz
  }
```

- [ ] **Step 12: Run the test to verify it passes**

Run: `npx vitest run packages/sim/test/kart.test.ts`

Expected: PASS — 16 tests, one per `it(...)` across the five describe blocks this
task wrote: 3 `targetSpeedFor` + 5 steering + 5 longitudinal + 2 lateral grip +
1 airborne = 16.

**16 is the number later tasks count from.** Tasks 7 and 8 add no test to
`kart.test.ts` (Task 8 only re-runs it alongside `drift.test.ts`), and Task 9
appends 4 more, so `kart.test.ts` holds 20 tests after Task 9.

- [ ] **Step 13: Write the failing test for the `step()` per-kart loop**

Change the import lines at the top of `packages/sim/test/step.test.ts` from:

```typescript
import type { AuthEvent, SimState } from '../src/types'
import { EIGHT_STARTS, makeTestContext } from './helpers/flat-context'
```

to:

```typescript
import type { AuthEvent, Intent, SimState } from '../src/types'
import { EIGHT_STARTS, makeIntent, makeTestContext } from './helpers/flat-context'
```

Then append to `packages/sim/test/step.test.ts`:

```typescript
describe('step — per-kart loop', () => {
  // Every test here sets prev.phase = 'racing'. It changes nothing today — this
  // task's step() has no phase gating — but Task 15's resolveInputs freezes every
  // intent to zero while the phase is 'countdown', which is what createState
  // starts in. Setting it now means these expectations survive Task 15 untouched.
  it('runs stepKart for every seat, indexing inputs by playerId', () => {
    const ctx = makeTestContext(EIGHT_STARTS)
    const prev = createState(ctx, 7, [0, 0, 0, 0, 0, 0, 0, 0])
    const next = createState(ctx, 7, [0, 0, 0, 0, 0, 0, 0, 0])
    prev.phase = 'racing'

    const inputs: Intent[] = []
    inputs[0] = makeIntent({ accel: 1 })

    step(ctx, prev, next, inputs, [])

    // Seat 0, character 0: rate = accelRate 24 * accel stat 1.00 = 24,
    // maxDelta = 24 / 60 = 0.4, from rest -> velocity.x = 0.4
    // Its grid slot is s = 0 -> world x = 0, so
    // position.x = 0 + 0.4 / 60 = 0.006666666666666667
    expect(next.karts[0].velocity.x).toBeCloseTo(0.4, 12)
    expect(next.karts[0].position.x).toBeCloseTo(0.006666666666666667, 12)

    // Seat 1 got no intent -> NEUTRAL_INTENT -> still parked at its grid slot,
    // s = 0.004 of a 1000 m lap = world x = 4. Seat 7: s = 0.028 -> x = 28.
    expect(next.karts[1].velocity.x).toBe(0)
    expect(next.karts[1].position.x).toBe(4)
    expect(next.karts[7].velocity.x).toBe(0)
    expect(next.karts[7].position.x).toBe(28)

    // prev is never written
    expect(prev.karts[0].velocity.x).toBe(0)
    expect(prev.karts[0].position.x).toBe(0)
    expect(next.tick).toBe(1)
  })

  it('applies steering through the loop for a moving kart', () => {
    const ctx = makeTestContext(EIGHT_STARTS)
    const prev = createState(ctx, 7, [0, 0, 0, 0, 0, 0, 0, 0])
    const next = createState(ctx, 7, [0, 0, 0, 0, 0, 0, 0, 0])
    prev.phase = 'racing'
    prev.karts[0].velocity.x = 20

    const inputs: Intent[] = []
    inputs[0] = makeIntent({ steer: 1 })

    step(ctx, prev, next, inputs, [])

    // sn = 20 / 40 = 0.5, authority = 0.5 * (1 - 0.55 * 0.5) = 0.3625
    // yaw = 2.6 * 1 * 1.00 * 0.3625 = 0.9425, heading = 0.9425 / 60
    expect(next.karts[0].angularVelocity).toBeCloseTo(0.9425, 12)
    expect(next.karts[0].heading).toBeCloseTo(0.015708333333333335, 12)
    expect(prev.karts[0].heading).toBe(0)
    expect(prev.karts[0].angularVelocity).toBe(0)
  })

  it('is deterministic: the same inputs from the same state give bit-equal output', () => {
    const ctx = makeTestContext(EIGHT_STARTS)
    const prev = createState(ctx, 7, [0, 1, 2, 3, 4, 5, 6, 7])
    const a = createState(ctx, 7, [0, 1, 2, 3, 4, 5, 6, 7])
    const b = createState(ctx, 7, [0, 1, 2, 3, 4, 5, 6, 7])
    prev.phase = 'racing'

    const inputs: Intent[] = []
    for (let i = 0; i < 8; i++) {
      inputs[i] = makeIntent({ steer: i % 2 === 0 ? 0.5 : -0.5, accel: 1 })
    }

    step(ctx, prev, a, inputs, [])
    step(ctx, prev, b, inputs, [])
    expect(statesEqual(a, b)).toBe(true)
    expect(statesEqual(prev, a)).toBe(false)
  })
})
```

- [ ] **Step 14: Run the test to verify it fails**

Run: `npx vitest run packages/sim/test/step.test.ts -t "runs stepKart for every seat"`

Expected: FAIL with `expected 0 to be close to 0.4` — `step()` still only clones
and advances the tick.

- [ ] **Step 15: Wire `stepKart` into `step()`**

Replace `packages/sim/src/step.ts` in full. Before:

```typescript
import type { AuthEvent, Intent, SimContext, SimState } from './types'
import { cloneState } from './state'

/**
 * Advance the simulation by exactly one 60Hz tick.
 *
 * The tick starts by copying `prev` into `next`; every stage after that writes
 * only into `next`, which is what makes "never mutates prev" true globally.
 * `step` never reads the wall clock and never calls Math.random().
 *
 * The canonical per-kart stage order, filled in by later tasks, is:
 *   1. resolveInputs      [Task 15]
 *   2. updateRecovery     [Task 9]
 *   3. updateDrift        [Task 8]
 *   4. stepKart           [Task 6]
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
  void ctx // used from Task 6 onward
  void inputs // used from Task 6 onward
  void events // used from Task 9 onward

  cloneState(prev, next)
  next.tick = prev.tick + 1
}
```

After — this is the complete file, nothing is elided:

```typescript
import type { AuthEvent, Intent, SimContext, SimState } from './types'
import { MAX_KARTS } from './types'
import { cloneState } from './state'
import { stepKart } from './kart'

/**
 * The intent used for a seat the caller supplied nothing for. Module-level so the
 * hot path allocates nothing; never mutated, and never handed to a kart directly —
 * it is copied into `resolvedInputs` like any other source intent.
 */
const NEUTRAL_INTENT: Intent = {
  tick: 0,
  steer: 0,
  accel: 0,
  brake: false,
  drift: false,
  useItem: false,
}

/**
 * The resolved intents the whole tick reads. `MAX_KARTS` distinct Intent objects,
 * allocated once at module load and rewritten in place every tick, because step()
 * must never allocate in the hot path. Indexed by kart slot.
 *
 * Task 15 replaces the fill loop below with
 * `resolveInputs(ctx, next, inputs, resolvedInputs)` and this initializer with
 * `makeIntentBuffer()`, which produces exactly this shape. The buffer, and the
 * `const raw = resolvedInputs[i]` line in the kart loop, exist from this task
 * onward so that Tasks 7, 8, 13 and 15 all edit against locals that are already
 * there.
 */
const resolvedInputs: Intent[] = Array.from({ length: MAX_KARTS }, () => ({
  tick: 0,
  steer: 0,
  accel: 0,
  brake: false,
  drift: false,
  useItem: false,
}))

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
 *   1. resolveInputs      [Task 15] <- this task's fill loop stands in for it
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
  void events // used from Task 9 onward, when updateRecovery joins the kart loop

  cloneState(prev, next)
  next.tick = prev.tick + 1

  // Canonical position 1, in its pre-Task-15 form: copy each supplied intent into
  // the resolved buffer, substituting NEUTRAL_INTENT for a seat the caller left
  // out. No phase gating, no bot fill, no 30Hz hold and no sanitisation yet — all
  // four arrive with Task 15, which replaces this whole loop with one call.
  for (let i = 0; i < MAX_KARTS; i++) {
    const supplied = inputs[i]
    const src = supplied === undefined ? NEUTRAL_INTENT : supplied
    const dst = resolvedInputs[i]
    dst.tick = src.tick
    dst.steer = src.steer
    dst.accel = src.accel
    dst.brake = src.brake
    dst.drift = src.drift
    dst.useItem = src.useItem
  }

  for (let i = 0; i < MAX_KARTS; i++) {
    const k = next.karts[i]
    const prevKart = prev.karts[i]
    const raw = resolvedInputs[i]
    stepKart(ctx, next, prevKart, k, raw)
  }
}
```

These three locals — `k`, `prevKart`, `raw` — are load-bearing. Tasks 7, 8, 13 and
15 insert their calls into this loop by anchoring on
`stepKart(ctx, next, prevKart, k, raw)`, so do not rename them, do not inline
them, and do not fold the two loops into one.

- [ ] **Step 16: Run the test to verify it passes**

Run: `npx vitest run packages/sim/test/step.test.ts`

Expected: PASS — 6 tests. The three tests written in Task 5 still pass unchanged:
they hold every kart at rest with no intents, so every seat resolves to
`NEUTRAL_INTENT`, and at zero speed with a neutral intent every term in `stepKart`
is exactly zero.

- [ ] **Step 17: Run the whole sim suite and the typecheck**

Run: `npx vitest run packages/sim && npx tsc --noEmit -p packages/sim`

Expected: PASS — every `packages/sim` test green (16 new kart tests and 3 new step
tests from this task, plus everything from Tasks 2–5), and `tsc` reports no errors.

- [ ] **Step 18: Commit**

```bash
git add packages/sim/src/kart.ts packages/sim/src/step.ts \
        packages/sim/test/kart.test.ts packages/sim/test/step.test.ts \
        packages/sim/test/helpers/flat-context.ts
git commit -m "feat(sim): kart steering, longitudinal and lateral grip wired into step()"
```
