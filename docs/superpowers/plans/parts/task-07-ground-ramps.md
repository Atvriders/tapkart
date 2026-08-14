### Task 7: Ground, Air Yaw, Ramps and Boost Pads (`packages/sim/src/ground.ts`)

**Files:**
- Create: `packages/sim/src/ground.ts`
- Create: `packages/sim/test/ground.test.ts`
- Modify: `packages/sim/src/step.ts` — the per-kart loop body, immediately after the existing `stepKart(...)` call (canonical order slots 5, 6, the new surface slot 6b, 7 and the new boost-pad slot 7b)
- Test: `packages/sim/test/ground.test.ts`

**Interfaces:**

- Consumes (all already exist before this task):
  - From `./types` [Task 2]: `TICK_DT` (= `1/60`), and the types `KartState`, `SimContext`, `Surface`, `Vec3`, `TrackProjection`.
  - From `./mathutil` [Task 2]: `clamp(v: number, lo: number, hi: number): number`, `wrapAngle(a: number): number` (returns `(-PI, PI]`).
  - From `ctx.query` [Task 4, `TrackQuery`]: `project(p: Vec3): TrackProjection` (returns `{ s, lateral, distance }`), `sampleAt(s: number): TrackPoint`, `tangentAt(s: number): Vec3`, `groundHeight(s: number, lateral: number): number`, `surfaceAt(s: number, lateral: number): Surface`, `totalLength(): number`.
  - From `ctx.track` [Task 2 type, Task 3 fixtures]: `ramps: { sStart: number; sEnd: number; launch: number }[]` — `sStart` and `sEnd` are arc-normalised `s`, not metres.
  - From `ctx.tuning` [Task 2 type, Task 3 values]: `gravity` (30), `airYaw` (0.6), `steerRateBase` (2.6).
  - From `./fixtures/track-fixtures` [Task 3, `makeContext` from Task 4]: `makeStraightTrack(overrides?: Partial<Track>): Track`, `makeOvalTrack(overrides?: Partial<Track>): Track`, `makeContext(track: Track, isLeader?: boolean): SimContext`.
  - From `./state` [Task 5]: `createState(ctx: SimContext, seed: number, characterIdx: number[]): SimState` — used only by the `step()` wiring test.
  - From `./step` [Task 5, extended by Task 6]: `step(ctx, prev, next, inputs, events): void` — used only by the `step()` wiring test.
  - **One convention owned by Task 6 that this task depends on:** `stepKart` leaves `k.angularVelocity` holding the yaw rate it used on this tick, and has already advanced `k.heading` by `k.angularVelocity * TICK_DT`. `applyAirYaw` runs immediately after `stepKart` (slot 5) and rewrites both fields, so it must *undo* exactly that integration before putting the air-yaw share back. It never double-applies yaw.

- Produces:
  - `export function applyAirYaw(ctx: SimContext, k: KartState, steer: number): void` — contract signature, canonical slot 5.
  - `export function integrateVertical(ctx: SimContext, k: KartState): void` — contract signature, canonical slot 6.
  - `export function applyRamps(ctx: SimContext, k: KartState, s: number): void` — contract signature, canonical slot 7.
  - `export function applyBoostPad(ctx: SimContext, k: KartState, s: number, lateral: number): void` — **not in the locked contract**; defined by this task because `Track.boostPads` and `TrackQuery.surfaceAt` returning `'boost'` are otherwise inert. Runs at slot 7b, directly after `applyRamps`.
  - `export const RAMP_MIN_SPEED = 6` — **not in the locked contract**; the `Tuning` struct has no ramp speed threshold, so this task defines one and owns it.
  - `export const BOOST_PAD_TICKS = 36` — **not in the locked contract**; defined by this task. Even, for the same 30Hz-input reason `driftTiers` and `driftBoosts` are even.
  - One statement inside `step()`'s per-kart loop, at the new **slot 6b**:
    `k.surface = ctx.query.surfaceAt(groundS, groundLateral)`. **This task is the only writer of `k.surface` inside a tick** — `createState` seeds the field once at race start and nothing else ever recomputes it. Tasks 8, 9 and 6 all read it (`lateralGripFor`, `surfaceSpeedFactor`, the lateral damping), so without this line the dirt sector of `makeOvalTrack` drives as tarmac and no kart is ever `'offtrack'`.

**Design notes the implementation depends on (read before writing code):**

1. `applyAirYaw` is a no-op on the ground. Airborne, the kart keeps only `tuning.airYaw` (0.6) of a flat `tuning.steerRateBase` yaw rate — the speed falloff (`steerSpeedFalloff`) is deliberately *not* applied in the air, because the falloff models tyre grip and the tyres are not touching anything.
2. `integrateVertical` is the only place `position.y` and `velocity.y` are written. Grounded karts are snapped to `groundHeight` every tick, so a grounded kart can never accumulate a gap; the airborne flag is therefore only ever *entered* by `applyRamps` (and, in later tasks, by item effects that set `k.airborne` directly), and only ever *left* here.
3. The landing test is `position.y <= ground && velocity.y <= 0`. The `velocity.y <= 0` half is load-bearing: on the tick after a ramp launch the kart is at exactly ground height with a large positive `velocity.y`, and without that guard it would land instantly and the launch would be invisible.
4. `ctx.query.project()`, `sampleAt()` and `tangentAt()` each return a shared scratch object (Task 4 owns that decision, and `step()` must not allocate in the hot path). Copy `.s` and `.lateral` into locals immediately; never retain the returned object across another query call.
5. **Every `s` in this task is the contract's arc-normalised `[0, 1)` value, never metres.** `applyRamps` compares its `s` argument against `ramp.sStart`/`ramp.sEnd` directly, and `applyBoostPad` hands its `s` straight to `ctx.query.surfaceAt`, which wraps with `s - Math.floor(s)`. A test that passes `25` is therefore testing `s = 0.0`, not "25 m along". Metres are reached only by multiplying by `ctx.query.totalLength()`, which is **1828.3236243** for `makeStraightTrack` and **1427.7555092** for `makeOvalTrack`; every ramp span and pad offset below is written as a fraction of a lap with the metre figure in the comment.
6. `k.surface` is assigned at slot 6b from the *same* projection `applyRamps` and `applyBoostPad` use, so the surface a kart is damped by, penalised by and boosted by all describe the same square metre of track. It is written after `integrateVertical` so that a kart which landed this tick is classified where it landed.

---

- [ ] **Step 1: Write the failing test for `applyAirYaw`**

Create `packages/sim/test/ground.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import type { KartState } from '../src/types'
import {
  applyAirYaw,
  integrateVertical,
  applyRamps,
  applyBoostPad,
  RAMP_MIN_SPEED,
  BOOST_PAD_TICKS,
} from '../src/ground'
import { makeStraightTrack, makeContext } from './fixtures/track-fixtures'

/**
 * A complete KartState literal. Built locally rather than via createState() so the
 * numbers below depend on nothing but the fields set here. `lap` is never read by
 * this task; the real race-start value is
 * `{ lap: 0, checkpointIdx: track.checkpointS.length - 1, t: 0 }` (contract §0).
 */
function makeKart(overrides: Partial<KartState> = {}): KartState {
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
    lap: { lap: 0, checkpointIdx: 0, t: 0 },
    ...overrides,
  }
}

describe('ground fixture assumptions', () => {
  it('uses the base tuning values every number below is derived from', () => {
    const ctx = makeContext(makeStraightTrack())
    expect(ctx.tuning.gravity).toBe(30)
    expect(ctx.tuning.airYaw).toBe(0.6)
    expect(ctx.tuning.steerRateBase).toBe(2.6)
    // The straight fixture is a flat run along +X with no banking, so ground height
    // is 0 everywhere. s is arc-normalised [0, 1): 0.2 is a fifth of a lap.
    expect(ctx.query.groundHeight(0.2, 0)).toBe(0)
    // Every ramp span and pad offset below is a fraction of THIS length, in metres.
    expect(ctx.query.totalLength()).toBeCloseTo(1828.3236243, 6)
  })
})

describe('applyAirYaw', () => {
  it('does nothing at all while the kart is on the ground', () => {
    const ctx = makeContext(makeStraightTrack())
    const k = makeKart({ airborne: false, heading: 0.5, angularVelocity: 2 })

    applyAirYaw(ctx, k, 1)

    expect(k.heading).toBe(0.5)
    expect(k.angularVelocity).toBe(2)
  })

  it('cuts airborne yaw to steerRateBase * airYaw and rewinds stepKart yaw', () => {
    const ctx = makeContext(makeStraightTrack())
    const k = makeKart({ airborne: true, heading: 0.5, angularVelocity: 2 })

    applyAirYaw(ctx, k, 1)

    // airOmega = clamp(1) * steerRateBase(2.6) * airYaw(0.6) = 1.56
    expect(k.angularVelocity).toBeCloseTo(1.56, 10)
    // heading = 0.5 + (1.56 - 2) / 60 = 0.5 - 0.007333333333333333
    expect(k.heading).toBeCloseTo(0.4926666666666667, 10)
  })

  it('kills all yaw in the air when the stick is centred', () => {
    const ctx = makeContext(makeStraightTrack())
    const k = makeKart({ airborne: true, heading: 1, angularVelocity: 2 })

    applyAirYaw(ctx, k, 0)

    expect(k.angularVelocity).toBe(0)
    // heading = 1 + (0 - 2) / 60 = 1 - 0.03333333333333333
    expect(k.heading).toBeCloseTo(0.9666666666666667, 10)
  })

  it('clamps steer to -1..1 before scaling', () => {
    const ctx = makeContext(makeStraightTrack())
    const k = makeKart({ airborne: true, heading: 0, angularVelocity: 0 })

    applyAirYaw(ctx, k, -3)

    // clamp(-3) = -1 -> airOmega = -1 * 2.6 * 0.6 = -1.56
    expect(k.angularVelocity).toBeCloseTo(-1.56, 10)
    // heading = 0 + (-1.56 - 0) / 60 = -0.026
    expect(k.heading).toBeCloseTo(-0.026, 10)
  })

  it('wraps the resulting heading into (-PI, PI]', () => {
    const ctx = makeContext(makeStraightTrack())
    const k = makeKart({ airborne: true, heading: Math.PI - 0.001, angularVelocity: 0 })

    applyAirYaw(ctx, k, 1)

    // raw = (PI - 0.001) + 1.56 / 60 = 3.140592653589793 + 0.026 = 3.166592653589793
    // wrapped = 3.166592653589793 - 2*PI = -3.116592653589793
    expect(k.heading).toBeCloseTo(-3.116592653589793, 10)
    expect(k.heading).toBeGreaterThan(-Math.PI)
    expect(k.heading).toBeLessThanOrEqual(Math.PI)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/sim/test/ground.test.ts -t "applyAirYaw"`

Expected: FAIL with `Failed to resolve import "../src/ground"` (the module does not exist yet).

- [ ] **Step 3: Write `applyAirYaw`**

Create `packages/sim/src/ground.ts`:

```ts
import type { KartState, SimContext } from './types'
import { TICK_DT } from './types'
import { clamp, wrapAngle } from './mathutil'

/**
 * Minimum horizontal speed (world units/second) a kart needs before a ramp will
 * launch it. Not part of the locked Tuning struct; owned by this module.
 */
export const RAMP_MIN_SPEED = 6

/**
 * Boost ticks granted for touching a 'boost' surface. Even, for the same reason
 * every driftTiers/driftBoosts entry is: input arrives at 30Hz against a 60Hz
 * sim, so odd tick counts land inside windows no input can observe.
 */
export const BOOST_PAD_TICKS = 36

/**
 * Canonical order slot 5 — runs immediately after stepKart.
 *
 * stepKart has already set k.angularVelocity to the yaw rate it used and advanced
 * k.heading by that rate * TICK_DT. In the air the kart keeps only tuning.airYaw
 * of a flat steerRateBase turn (no speed falloff — the tyres are not on anything),
 * so this rewinds the ground yaw stepKart integrated and applies the air yaw in
 * its place. It is a no-op on the ground.
 */
export function applyAirYaw(ctx: SimContext, k: KartState, steer: number): void {
  if (!k.airborne) return
  const t = ctx.tuning
  const groundOmega = k.angularVelocity
  const airOmega = clamp(steer, -1, 1) * t.steerRateBase * t.airYaw
  k.heading = wrapAngle(k.heading + (airOmega - groundOmega) * TICK_DT)
  k.angularVelocity = airOmega
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/sim/test/ground.test.ts -t "applyAirYaw"`

Expected: PASS — 5 tests in the `applyAirYaw` block, plus the fixture-assumption test.

---

- [ ] **Step 5: Write the failing test for `integrateVertical`**

Append to `packages/sim/test/ground.test.ts`:

```ts
describe('integrateVertical', () => {
  it('applies gravity for one tick while airborne', () => {
    const ctx = makeContext(makeStraightTrack())
    const k = makeKart({
      airborne: true,
      position: { x: 10, y: 2, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
    })

    integrateVertical(ctx, k)

    // vy = 0 - gravity(30) / 60 = -0.5
    expect(k.velocity.y).toBeCloseTo(-0.5, 12)
    // y = 2 + (-0.5) / 60 = 2 - 0.008333333333333333
    expect(k.position.y).toBeCloseTo(1.9916666666666667, 12)
    expect(k.airborne).toBe(true)
  })

  it('accelerates downward over successive ticks', () => {
    const ctx = makeContext(makeStraightTrack())
    const k = makeKart({
      airborne: true,
      position: { x: 10, y: 2, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
    })

    integrateVertical(ctx, k)
    integrateVertical(ctx, k)

    // vy after two ticks = -1.0
    expect(k.velocity.y).toBeCloseTo(-1, 12)
    // y = 1.9916666666666667 + (-1) / 60 = 1.975
    expect(k.position.y).toBeCloseTo(1.975, 12)
    expect(k.airborne).toBe(true)
  })

  it('snaps to ground height and clears the airborne flag on landing', () => {
    const ctx = makeContext(makeStraightTrack())
    const k = makeKart({
      airborne: true,
      position: { x: 10, y: 0.004, z: 0 },
      velocity: { x: 0, y: -0.5, z: 0 },
    })

    integrateVertical(ctx, k)

    // vy = -0.5 - 0.5 = -1.0; y = 0.004 - 1/60 = -0.012666... which is <= ground(0)
    expect(k.position.y).toBe(0)
    expect(k.velocity.y).toBe(0)
    expect(k.airborne).toBe(false)
  })

  it('does not re-land a kart that is at ground height moving upward', () => {
    const ctx = makeContext(makeStraightTrack())
    const k = makeKart({
      airborne: true,
      position: { x: 10, y: 0, z: 0 },
      velocity: { x: 0, y: 9, z: 0 },
    })

    integrateVertical(ctx, k)

    // vy = 9 - 0.5 = 8.5; y = 0 + 8.5 / 60 = 0.14166666666666666
    expect(k.velocity.y).toBeCloseTo(8.5, 12)
    expect(k.position.y).toBeCloseTo(0.14166666666666666, 12)
    expect(k.airborne).toBe(true)
  })

  it('snaps a grounded kart to the surface and never applies gravity to it', () => {
    const ctx = makeContext(makeStraightTrack())
    const k = makeKart({
      airborne: false,
      position: { x: 10, y: 3, z: 0 },
      velocity: { x: 20, y: 0, z: 0 },
    })

    integrateVertical(ctx, k)

    expect(k.position.y).toBe(0)
    expect(k.velocity.y).toBe(0)   // not -0.5: gravity is airborne-only
    expect(k.airborne).toBe(false)
    expect(k.velocity.x).toBe(20)  // horizontal velocity is untouched
  })
})
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `npx vitest run packages/sim/test/ground.test.ts -t "integrateVertical"`

Expected: FAIL with `TypeError: integrateVertical is not a function` (imported but not yet exported by `src/ground.ts`).

- [ ] **Step 7: Write `integrateVertical`**

Append to `packages/sim/src/ground.ts`:

```ts
/**
 * Canonical order slot 6 — the only writer of position.y / velocity.y.
 *
 * Grounded: snapped to the analytic spline height every tick, so a grounded kart
 * can never drift off the surface. Airborne: integrate gravity, then land when the
 * kart has fallen to or below the surface *while descending*. The descending half
 * of that test is load-bearing — on the tick after a ramp launch the kart sits at
 * exactly ground height with a large positive velocity.y.
 *
 * ctx.query.project() may hand back a shared scratch object, so s and lateral are
 * read out immediately and the projection is never retained.
 */
export function integrateVertical(ctx: SimContext, k: KartState): void {
  const proj = ctx.query.project(k.position)
  const ground = ctx.query.groundHeight(proj.s, proj.lateral)

  if (!k.airborne) {
    k.position.y = ground
    k.velocity.y = 0
    return
  }

  k.velocity.y -= ctx.tuning.gravity * TICK_DT
  k.position.y += k.velocity.y * TICK_DT

  if (k.position.y <= ground && k.velocity.y <= 0) {
    k.position.y = ground
    k.velocity.y = 0
    k.airborne = false
  }
}
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `npx vitest run packages/sim/test/ground.test.ts -t "integrateVertical"`

Expected: PASS — 5 tests.

---

- [ ] **Step 9: Write the failing test for `applyRamps`**

Append to `packages/sim/test/ground.test.ts`:

```ts
/**
 * Ramp spans below are arc-normalised s, per the contract: s is always [0, 1).
 * makeStraightTrack's totalLength() is 1828.3236243 m, so the ramp used through
 * this block, { sStart: 0.2, sEnd: 0.3 }, covers
 *   0.2 * 1828.3236243 = 365.6647249 m  ..  0.3 * 1828.3236243 = 548.4970873 m
 * i.e. a 0.1-lap = 182.8323624 m stretch of the return leg.
 */
describe('applyRamps', () => {
  it('exposes an even, documented speed threshold', () => {
    expect(RAMP_MIN_SPEED).toBe(6)
  })

  it('launches a fast grounded kart inside the ramp s-range', () => {
    const ctx = makeContext(makeStraightTrack({ ramps: [{ sStart: 0.2, sEnd: 0.3, launch: 9 }] }))
    const k = makeKart({ airborne: false, velocity: { x: 12, y: 0, z: 0 } })

    // 0.25 * 1828.3236243 = 457.0809061 m, the middle of the ramp
    applyRamps(ctx, k, 0.25)

    expect(k.velocity.y).toBe(9)      // taken straight from ramp.launch
    expect(k.airborne).toBe(true)
    expect(k.velocity.x).toBe(12)     // horizontal velocity is preserved
  })

  it('treats both ends of the s-range as inside', () => {
    const ctx = makeContext(makeStraightTrack({ ramps: [{ sStart: 0.2, sEnd: 0.3, launch: 9 }] }))

    const atStart = makeKart({ velocity: { x: 12, y: 0, z: 0 } })
    applyRamps(ctx, atStart, 0.2)
    expect(atStart.velocity.y).toBe(9)

    const atEnd = makeKart({ velocity: { x: 12, y: 0, z: 0 } })
    applyRamps(ctx, atEnd, 0.3)
    expect(atEnd.velocity.y).toBe(9)
  })

  it('does not launch outside the s-range', () => {
    const ctx = makeContext(makeStraightTrack({ ramps: [{ sStart: 0.2, sEnd: 0.3, launch: 9 }] }))

    // 0.199 * 1828.3236243 = 363.8364012 m, i.e. 1.83 m short of the ramp
    const before = makeKart({ velocity: { x: 12, y: 0, z: 0 } })
    applyRamps(ctx, before, 0.199)
    expect(before.velocity.y).toBe(0)
    expect(before.airborne).toBe(false)

    // 0.301 * 1828.3236243 = 550.3254109 m, i.e. 1.83 m past its end
    const after = makeKart({ velocity: { x: 12, y: 0, z: 0 } })
    applyRamps(ctx, after, 0.301)
    expect(after.velocity.y).toBe(0)
    expect(after.airborne).toBe(false)
  })

  it('does not launch below RAMP_MIN_SPEED and does launch exactly at it', () => {
    const ctx = makeContext(makeStraightTrack({ ramps: [{ sStart: 0.2, sEnd: 0.3, launch: 9 }] }))

    const slow = makeKart({ velocity: { x: 5.9, y: 0, z: 0 } })
    applyRamps(ctx, slow, 0.25)
    expect(slow.velocity.y).toBe(0)
    expect(slow.airborne).toBe(false)

    const exact = makeKart({ velocity: { x: 6, y: 0, z: 0 } })  // speed = sqrt(36) = 6
    applyRamps(ctx, exact, 0.25)
    expect(exact.velocity.y).toBe(9)
    expect(exact.airborne).toBe(true)
  })

  it('measures speed on the xz plane only', () => {
    const ctx = makeContext(makeStraightTrack({ ramps: [{ sStart: 0.2, sEnd: 0.3, launch: 9 }] }))

    const diagonal = makeKart({ velocity: { x: 3, y: 0, z: 4 } })  // sqrt(9+16) = 5 < 6
    applyRamps(ctx, diagonal, 0.25)
    expect(diagonal.velocity.y).toBe(0)

    const faster = makeKart({ velocity: { x: 6, y: 0, z: 8 } })    // sqrt(36+64) = 10 >= 6
    applyRamps(ctx, faster, 0.25)
    expect(faster.velocity.y).toBe(9)
  })

  it('never re-launches a kart that is already airborne', () => {
    const ctx = makeContext(makeStraightTrack({ ramps: [{ sStart: 0.2, sEnd: 0.3, launch: 9 }] }))
    const k = makeKart({ airborne: true, velocity: { x: 20, y: -2, z: 0 } })

    applyRamps(ctx, k, 0.25)

    expect(k.velocity.y).toBe(-2)
    expect(k.airborne).toBe(true)
  })

  it('handles a ramp whose range wraps through s = 0', () => {
    // sStart 0.3 > sEnd 0.05, so the range is [0.3, 1) plus [0, 0.05]: from
    // 548.4970873 m round through the start line to 91.4161812 m.
    const ctx = makeContext(makeStraightTrack({ ramps: [{ sStart: 0.3, sEnd: 0.05, launch: 7 }] }))

    // 0.02 * 1828.3236243 = 36.5664725 m, inside the [0, 0.05] half
    const justAfterZero = makeKart({ velocity: { x: 12, y: 0, z: 0 } })
    applyRamps(ctx, justAfterZero, 0.02)
    expect(justAfterZero.velocity.y).toBe(7)

    // 0.35 * 1828.3236243 = 639.9132685 m, inside the [0.3, 1) half
    const justBeforeZero = makeKart({ velocity: { x: 12, y: 0, z: 0 } })
    applyRamps(ctx, justBeforeZero, 0.35)
    expect(justBeforeZero.velocity.y).toBe(7)

    // 0.17 * 1828.3236243 = 310.8150161 m, in the gap between the two halves
    const middle = makeKart({ velocity: { x: 12, y: 0, z: 0 } })
    applyRamps(ctx, middle, 0.17)
    expect(middle.velocity.y).toBe(0)
    expect(middle.airborne).toBe(false)
  })

  it('launches from the first matching ramp when ranges overlap', () => {
    const ctx = makeContext(
      makeStraightTrack({
        ramps: [
          { sStart: 0.2, sEnd: 0.3, launch: 9 },
          { sStart: 0.25, sEnd: 0.4, launch: 4 },
        ],
      }),
    )
    const k = makeKart({ velocity: { x: 12, y: 0, z: 0 } })

    // 0.27 * 1828.3236243 = 493.6473786 m, inside both ramps
    applyRamps(ctx, k, 0.27)

    expect(k.velocity.y).toBe(9)
  })
})
```

- [ ] **Step 10: Run the test to verify it fails**

Run: `npx vitest run packages/sim/test/ground.test.ts -t "applyRamps"`

Expected: FAIL with `TypeError: applyRamps is not a function`.

- [ ] **Step 11: Write `applyRamps`**

Append to `packages/sim/src/ground.ts`:

```ts
/**
 * Canonical order slot 7 — runs after the vertical integration, so a kart that
 * landed this tick can be launched again by the ramp it landed on.
 *
 * `s` is the kart's current arc-normalised position along the centreline, [0, 1)
 * per the contract — never metres. The caller supplies it rather than this function
 * re-projecting, because step() already has it. `ramp.sStart` and `ramp.sEnd` are in
 * the same units, so the comparison is direct; a ramp whose sStart is greater than
 * its sEnd wraps through the start/finish line.
 */
export function applyRamps(ctx: SimContext, k: KartState, s: number): void {
  if (k.airborne) return

  const vx = k.velocity.x
  const vz = k.velocity.z
  const speed = Math.sqrt(vx * vx + vz * vz)
  if (speed < RAMP_MIN_SPEED) return

  const ramps = ctx.track.ramps
  for (let i = 0; i < ramps.length; i++) {
    const r = ramps[i]
    const inside =
      r.sStart <= r.sEnd
        ? s >= r.sStart && s <= r.sEnd
        : s >= r.sStart || s <= r.sEnd
    if (!inside) continue
    k.velocity.y = r.launch
    k.airborne = true
    return
  }
}
```

- [ ] **Step 12: Run the test to verify it passes**

Run: `npx vitest run packages/sim/test/ground.test.ts -t "applyRamps"`

Expected: PASS — 9 tests.

---

- [ ] **Step 13: Write the failing test for `applyBoostPad`**

Append to `packages/sim/test/ground.test.ts`:

```ts
/**
 * The pad used through this block is { s: 0.1, lateral: 0, halfWidth: 2 } on
 * makeStraightTrack, whose totalLength() is 1828.3236243 m. So:
 *   - the pad sits 0.1 * 1828.3236243 = 182.8323624 m along the lap;
 *   - buildTrackQuery gives every pad BOOST_PAD_HALF_LENGTH = 4 m of longitudinal
 *     reach [Task 4], which is 4 / 1828.3236243 = 0.0021878 of s;
 *   - it is 2 m wide either side of the centreline (halfWidth), against the
 *     fixture's uniform 20 m track width, so lateral 3 is on tarmac, not on the pad.
 * s is arc-normalised [0, 1) per the contract: surfaceAt wraps with
 * `s - Math.floor(s)`, so a raw `30` would silently mean s = 0.0.
 */
describe('applyBoostPad', () => {
  it('grants an even number of boost ticks', () => {
    // Input is 30Hz against a 60Hz sim, so every tick budget the player can
    // perceive the start and end of is defined in multiples of 2 ticks.
    expect(BOOST_PAD_TICKS).toBe(36)
    expect(BOOST_PAD_TICKS % 2).toBe(0)
  })

  it('grants boost ticks when the surface under the kart is boost', () => {
    const ctx = makeContext(makeStraightTrack({ boostPads: [{ s: 0.1, lateral: 0, halfWidth: 2 }] }))
    expect(ctx.query.surfaceAt(0.1, 0)).toBe('boost')

    const k = makeKart({ airborne: false, boostTicks: 0 })
    applyBoostPad(ctx, k, 0.1, 0)

    expect(k.boostTicks).toBe(36)
  })

  it('grants nothing off the side of the pad', () => {
    const ctx = makeContext(makeStraightTrack({ boostPads: [{ s: 0.1, lateral: 0, halfWidth: 2 }] }))
    // |3 - 0| = 3 > halfWidth 2, and 3 is still inside the 20 m track, so: tarmac
    expect(ctx.query.surfaceAt(0.1, 3)).toBe('tarmac')

    const k = makeKart({ boostTicks: 0 })
    applyBoostPad(ctx, k, 0.1, 3)

    expect(k.boostTicks).toBe(0)
  })

  it('grants nothing further along the track than the pad', () => {
    const ctx = makeContext(makeStraightTrack({ boostPads: [{ s: 0.1, lateral: 0, halfWidth: 2 }] }))

    // 0.103 - 0.1 = 0.003 of a lap = 5.4849709 m, past the pad's 4 m reach
    expect(ctx.query.surfaceAt(0.103, 0)).toBe('tarmac')
    const justPast = makeKart({ boostTicks: 0 })
    applyBoostPad(ctx, justPast, 0.103, 0)
    expect(justPast.boostTicks).toBe(0)

    // 0.3 - 0.1 = 0.2 of a lap = 365.6647249 m, a fifth of the track away
    const farPast = makeKart({ boostTicks: 0 })
    applyBoostPad(ctx, farPast, 0.3, 0)
    expect(farPast.boostTicks).toBe(0)
  })

  it('grants nothing while the kart is flying over the pad', () => {
    const ctx = makeContext(makeStraightTrack({ boostPads: [{ s: 0.1, lateral: 0, halfWidth: 2 }] }))
    const k = makeKart({ airborne: true, boostTicks: 0 })

    applyBoostPad(ctx, k, 0.1, 0)

    expect(k.boostTicks).toBe(0)
  })

  it('extends a shorter boost but never shortens a longer one', () => {
    const ctx = makeContext(makeStraightTrack({ boostPads: [{ s: 0.1, lateral: 0, halfWidth: 2 }] }))

    const shorter = makeKart({ boostTicks: 20 })
    applyBoostPad(ctx, shorter, 0.1, 0)
    expect(shorter.boostTicks).toBe(36)

    const longer = makeKart({ boostTicks: 50 })   // e.g. a tier-3 drift boost of 66, part spent
    applyBoostPad(ctx, longer, 0.1, 0)
    expect(longer.boostTicks).toBe(50)
  })
})
```

- [ ] **Step 14: Run the test to verify it fails**

Run: `npx vitest run packages/sim/test/ground.test.ts -t "applyBoostPad"`

Expected: FAIL with `TypeError: applyBoostPad is not a function`.

- [ ] **Step 15: Write `applyBoostPad`**

Append to `packages/sim/src/ground.ts`:

```ts
/**
 * Canonical order slot 7b — directly after applyRamps, before decayBoost.
 *
 * This is what makes Track.boostPads and a 'boost' result from surfaceAt do
 * anything: it tops the kart's boost timer up to BOOST_PAD_TICKS. `s` is
 * arc-normalised [0, 1) per the contract and is handed straight to the query.
 *
 * It re-reads the surface from the query rather than from k.surface, so the pad
 * grant cannot depend on the order of the two: slot 6b writes k.surface from the
 * same s and lateral, one line earlier in step().
 *
 * Airborne karts are skipped — flying over a pad is not driving over it. The top-up
 * never shortens a longer boost already running (a tier-3 drift boost is 66 ticks;
 * clipping it to 36 on a pad would be a downgrade).
 */
export function applyBoostPad(ctx: SimContext, k: KartState, s: number, lateral: number): void {
  if (k.airborne) return
  if (ctx.query.surfaceAt(s, lateral) !== 'boost') return
  if (k.boostTicks < BOOST_PAD_TICKS) k.boostTicks = BOOST_PAD_TICKS
}
```

- [ ] **Step 16: Run the whole ground suite**

Run: `npx vitest run packages/sim/test/ground.test.ts`

Expected: PASS — 26 tests across the five describe blocks.

---

- [ ] **Step 17: Write the failing test for the surface slot in `step()`**

`k.surface` is written once by `createState` and, without this task, never again: the
dirt sector of `makeOvalTrack` would drive as tarmac forever and no kart would ever be
`'offtrack'`. Slot 6b fixes that, and it lives in `step()` because that is where the
projection already exists.

First replace the import block at the top of `packages/sim/test/ground.test.ts`.
Before:

```ts
import { describe, it, expect } from 'vitest'
import type { KartState } from '../src/types'
import {
  applyAirYaw,
  integrateVertical,
  applyRamps,
  applyBoostPad,
  RAMP_MIN_SPEED,
  BOOST_PAD_TICKS,
} from '../src/ground'
import { makeStraightTrack, makeContext } from './fixtures/track-fixtures'
```

After:

```ts
import { describe, it, expect } from 'vitest'
import type { KartState } from '../src/types'
import {
  applyAirYaw,
  integrateVertical,
  applyRamps,
  applyBoostPad,
  RAMP_MIN_SPEED,
  BOOST_PAD_TICKS,
} from '../src/ground'
import { createState } from '../src/state'
import { step } from '../src/step'
import { makeOvalTrack, makeStraightTrack, makeContext } from './fixtures/track-fixtures'
```

Then append to `packages/sim/test/ground.test.ts`:

```ts
describe('step — the surface under each kart', () => {
  it('recomputes k.surface from the query for every kart, every tick', () => {
    // makeOvalTrack: control points 12 and 13 are dirt, so s in [0.640104, 0.780208)
    // is dirt; the bottom straight is 24 m wide (edge at |lateral| = 12) and the
    // banked right turn is 20 m wide, all tarmac. totalLength() = 1427.7555092.
    const ctx = makeContext(makeOvalTrack())
    const prev = createState(ctx, 1, [0, 0, 0, 0, 0, 0, 0, 0])
    const next = createState(ctx, 1, [0, 0, 0, 0, 0, 0, 0, 0])

    // sampleAt and tangentAt hand back shared scratch, so each field is copied out
    // before the next query call.
    const banked = ctx.query.sampleAt(0.35).position   // inside the right turn
    const bankedX = banked.x
    const bankedZ = banked.z

    const dirt = ctx.query.sampleAt(0.7).position      // inside the dirt sector
    const dirtX = dirt.x
    const dirtZ = dirt.z

    const edge = ctx.query.sampleAt(0.02).position     // on the 24 m bottom straight
    const edgeX = edge.x
    const edgeZ = edge.z
    const tan = ctx.query.tangentAt(0.02)
    const rx = -tan.z                                  // right = (-t.z, 0, t.x)
    const rz = tan.x

    // step() copies prev into next before anything else, so the setup goes on prev.
    // Kart 0: centreline of the banked turn -> tarmac, overwriting a stale 'dirt'.
    prev.karts[0].position.x = bankedX
    prev.karts[0].position.y = 0
    prev.karts[0].position.z = bankedZ
    prev.karts[0].surface = 'dirt'

    // Kart 1: centreline of the dirt sector -> dirt.
    prev.karts[1].position.x = dirtX
    prev.karts[1].position.y = 0
    prev.karts[1].position.z = dirtZ
    prev.karts[1].surface = 'tarmac'

    // Kart 2: 20 m right of the centreline of a 24 m wide straight, so 8 m past the
    // edge -> offtrack. (isInBounds still allows it: the run-off reaches 24 m.)
    prev.karts[2].position.x = edgeX + rx * 20
    prev.karts[2].position.y = 0
    prev.karts[2].position.z = edgeZ + rz * 20
    prev.karts[2].surface = 'tarmac'

    // Empty inputs: every seat gets the neutral intent step()'s loop substitutes, so
    // no kart moves and the only thing under test is the surface classification.
    step(ctx, prev, next, [], [])

    expect(next.karts[0].surface).toBe('tarmac')
    expect(next.karts[1].surface).toBe('dirt')
    expect(next.karts[2].surface).toBe('offtrack')

    // prev is never written
    expect(prev.karts[0].surface).toBe('dirt')
    expect(prev.karts[1].surface).toBe('tarmac')
    expect(prev.karts[2].surface).toBe('tarmac')
  })

  it('marks a kart standing on a boost pad and pays it the pad boost', () => {
    // makeOvalTrack's pad is { s: 0.1, lateral: 0, halfWidth: 4 }, and buildTrackQuery
    // gives every pad BOOST_PAD_HALF_LENGTH = 4 m of reach = 4 / 1427.7555092 =
    // 0.0028016 of s, so the centreline point at s = 0.1 is inside it.
    const ctx = makeContext(makeOvalTrack())
    const prev = createState(ctx, 2, [0, 0, 0, 0, 0, 0, 0, 0])
    const next = createState(ctx, 2, [0, 0, 0, 0, 0, 0, 0, 0])

    const pad = ctx.query.sampleAt(0.1).position
    prev.karts[0].position.x = pad.x
    prev.karts[0].position.y = 0
    prev.karts[0].position.z = pad.z
    prev.karts[0].surface = 'tarmac'
    prev.karts[0].boostTicks = 0

    step(ctx, prev, next, [], [])

    expect(next.karts[0].surface).toBe('boost')
    // applyBoostPad granted BOOST_PAD_TICKS on this same tick. Task 8 later wires
    // decayBoost in as the last call of the loop, which spends one tick of it, so
    // this asserts the grant happened rather than an exact remaining count.
    expect(next.karts[0].boostTicks).toBeGreaterThanOrEqual(BOOST_PAD_TICKS - 1)
  })
})
```

- [ ] **Step 18: Run the test to verify it fails**

Run: `npx vitest run packages/sim/test/ground.test.ts -t "the surface under each kart"`

Expected: FAIL with `expected 'dirt' to be 'tarmac'` on the first test — `step()` still
ends its per-kart loop at `stepKart`, so nothing recomputes `k.surface` and kart 0 keeps
the stale value the setup put on it.

- [ ] **Step 19: Wire slots 5, 6, 6b, 7 and 7b into `step()`**

Modify `packages/sim/src/step.ts`.

Add this import alongside the other `./` imports at the top of the file:

```ts
import { applyAirYaw, integrateVertical, applyRamps, applyBoostPad } from './ground'
```

Then extend the per-kart loop body. Task 6 wrote that body as exactly these four lines,
and they are the anchor. Before:

```ts
    const k = next.karts[i]
    const prevKart = prev.karts[i]
    const raw = resolvedInputs[i]
    stepKart(ctx, next, prevKart, k, raw)
```

After:

```ts
    const k = next.karts[i]
    const prevKart = prev.karts[i]
    const raw = resolvedInputs[i]
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
```

Do not add a second `stepKart` call and do not reorder anything else in the loop. The
three locals above `stepKart` are unchanged by this edit; they are quoted only so the
insertion point is unambiguous.

- [ ] **Step 20: Run the test to verify it passes**

Run: `npx vitest run packages/sim/test/ground.test.ts`

Expected: PASS — 28 tests across the six describe blocks.

- [ ] **Step 21: Verify nothing regressed**

Run: `npx vitest run packages/sim`

Expected: PASS — the whole `packages/sim` suite, including every test written by Tasks
2–6, still passes. The first 26 ground tests call the four functions directly, so they
are unaffected by the wiring; this step is checking that inserting the calls did not
break `step()`'s existing behaviour.

Then run: `npx tsc --noEmit -p packages/sim`

Expected: PASS with no output (no unused-local or type errors from the new import).

- [ ] **Step 22: Commit**

```bash
git add packages/sim/src/ground.ts packages/sim/src/step.ts packages/sim/test/ground.test.ts
git commit -m "feat(sim): air yaw, vertical integration, ramp launches, boost pads and the surface slot

applyAirYaw cuts steering authority to tuning.airYaw while airborne by rewinding
the yaw stepKart integrated this tick. integrateVertical is the only writer of
position.y/velocity.y: gravity while airborne, snap to query.groundHeight on
landing, and it owns the airborne flag's falling edge. applyRamps launches a
grounded kart above RAMP_MIN_SPEED whose s falls inside a ramp range (wrapping
ranges included), imparting ramp.launch as +y velocity. applyBoostPad tops the
boost timer up to BOOST_PAD_TICKS on a 'boost' surface, which is what finally
makes Track.boostPads do something.

step() also gains slot 6b, k.surface = query.surfaceAt(...) from the same
projection: createState seeded that field once and nothing recomputed it, so the
dirt sector drove as tarmac and no kart was ever offtrack.

Every s here is the contract's arc-normalised [0, 1), never metres: ramp spans and
pad offsets are fractions of query.totalLength()."
```
