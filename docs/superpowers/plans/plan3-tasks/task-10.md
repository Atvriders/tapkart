### Task 10: `src/camera.ts` — pure, tick-driven, no wall clock

The chase camera. Pure, deterministic, and smoothed **per sim tick, never per frame** —
a frame-rate-dependent lerp makes the camera behave differently on a 60 Hz phone and a
144 Hz desktop and cannot be asserted in CI at all. `updateCamera` advances by exactly
`ticks` ticks, which is what makes §8.1's *"N calls with 1 tick equal 1 call with N
ticks"* assertion true, and `ticks = 0` is a no-op.

The one arithmetic decision that everything else follows from: the per-tick factor is
**pooled**, `1 - (1 - k) ** ticks`, not multiplied, `k * ticks`. With the default
`positionLerpPerTick` of 0.18 and 8 ticks those are 0.796 and 1.44 — the multiplied form
overshoots the target and the camera oscillates behind the kart at any frame rate that
drops below 60 Hz. The equality test below is what catches it, and it only catches it if
the camera starts from a pose it is *not* already at (see the snap rule).

`updateCamera` is the **sole writer** of every `CameraState` field (contract §7.2).

**Files:**
- Create: `packages/render/src/camera.ts`
- Modify: `packages/render/src/index.ts:11-12` (append one `export *` line after `export * from './descriptors'`)
- Test: `packages/render/test/camera.test.ts`

**Interfaces:**

- Consumes, from `@tapkart/sim`:
  ```ts
  export type Vec3 = { x: number; y: number; z: number }
  export function clamp(v: number, lo: number, hi: number): number
  export function wrapAngle(a: number): number        // wraps to (-pi, pi]
  export const ITEM_BOOST_TICKS = 90
  ```
- Consumes, from `packages/render/src/types` (Task 7) — the fields this module reads
  from the view it is handed:
  ```ts
  export interface KartView {
    playerId: number; characterIdx: number; source: ViewSource
    position: Vec3          // metres, world
    heading: number         // radians, wrapped to (-pi, pi]
    velocity: Vec3; angularVelocity: number; speed: number; s: number; bankAngle: number
    driftActive: boolean; driftDir: -1 | 0 | 1; driftCharge: number; driftTier: number
    airborne: boolean; surface: Surface
    spinOutTicks: number; invulnTicks: number
    boostTicks: number      // read for the FOV kick
    respawnTicks: number; shielded: boolean; item: ItemKind
    lap: number; checkpointIdx: number; t: number; place: number
    isBot: boolean; connected: boolean
  }
  ```
- Consumes, from `packages/render/test/fixtures/render-fixtures` (Task 7, test-only):
  ```ts
  export function makeKartView(overrides?: Partial<KartView>): KartView
  ```
- Produces — the 6 exports of `render/camera` (contract §11's census):
  ```ts
  export type CameraMode = 'chase' | 'countdown' | 'results' | 'free'
  export interface CameraParams {
    distance: number; height: number; lookAhead: number
    positionLerpPerTick: number; headingLerpPerTick: number
    fovDegrees: number; fovBoostDegrees: number; near: number; far: number
  }
  export const DEFAULT_CAMERA_PARAMS: Readonly<CameraParams>
  export interface CameraState {
    position: Vec3; lookAt: Vec3; up: Vec3; fovDegrees: number; mode: CameraMode
  }
  export function createCameraState(): CameraState
  export function updateCamera(cam: CameraState, target: KartView, params: CameraParams,
                               mode: CameraMode, ticks: number): void
  ```

**The behaviour this task pins**, beyond the contract's own text:

- **Chase pose.** `forward = (cos h, 0, sin h)` (contract §0). The camera wants
  `target.position - forward * distance + (0, height, 0)` and a look target of
  `target.position + forward * lookAhead` at the kart's own `y`.
- **The look direction is angle-lerped on the shortest arc** around the kart, recovered
  from the current `lookAt` with `atan2`. A componentwise lerp of the look *point* swings
  the camera the long way round whenever the kart's heading crosses ±π.
- **Both lerps are computed against a target held fixed for the whole call**, which is
  what makes the N-vs-1 equality exact rather than approximate.
- **Snap rule.** A camera whose `position` equals its `lookAt` exactly — which is what
  `createCameraState()` returns — is uninitialised and snaps to the desired pose instead
  of swooping in from the world origin across the first second of the race. `'countdown'`
  snaps for the same reason: the pre-race camera should be locked, not settling.
- **`'results'`** uses the same pose with `lookAhead = 0`, so the camera settles on the
  kart itself. **`'free'`** updates `mode` and `fovDegrees` and leaves the pose alone.
- **FOV is set, not smoothed:** `params.fovDegrees + params.fovBoostDegrees *
  clamp(target.boostTicks / ITEM_BOOST_TICKS, 0, 1)`, so the boost kick is instant.

---

- [ ] **Step 1: Write the failing test**

Create `packages/render/test/camera.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { ITEM_BOOST_TICKS } from '@tapkart/sim'

import type { CameraState } from '../src/camera'
import { DEFAULT_CAMERA_PARAMS, createCameraState, updateCamera } from '../src/camera'
import { makeKartView } from './fixtures/render-fixtures'

const P = DEFAULT_CAMERA_PARAMS

function clone(cam: CameraState): CameraState {
  return {
    position: { ...cam.position },
    lookAt: { ...cam.lookAt },
    up: { ...cam.up },
    fovDegrees: cam.fovDegrees,
    mode: cam.mode,
  }
}

/**
 * A camera that is already following a kart. Every smoothing test must start from one:
 * a freshly created camera SNAPS, and a snap makes "N ticks equals one call of N" true
 * for any factor at all — including the broken `k * ticks` this suite exists to reject.
 */
function seeded(): CameraState {
  const cam = createCameraState()
  updateCamera(cam, makeKartView({ position: { x: 10, y: 1, z: 4 }, heading: 0.3 }), P, 'chase', 1)
  return cam
}

/** The yaw the camera is looking along, recovered around the kart it is following. */
function lookYaw(cam: CameraState, at: { x: number; z: number }): number {
  return Math.atan2(cam.lookAt.z - at.z, cam.lookAt.x - at.x)
}

describe('DEFAULT_CAMERA_PARAMS', () => {
  it('is exactly the nine numbers the contract states', () => {
    expect(DEFAULT_CAMERA_PARAMS).toEqual({
      distance: 7,
      height: 3,
      lookAhead: 8,
      positionLerpPerTick: 0.18,
      headingLerpPerTick: 0.22,
      fovDegrees: 62,
      fovBoostDegrees: 8,
      near: 0.3,
      far: 900,
    })
  })
})

describe('createCameraState', () => {
  it('starts at the origin with a +y up vector, in chase mode', () => {
    const cam = createCameraState()
    expect(cam.position).toEqual({ x: 0, y: 0, z: 0 })
    expect(cam.lookAt).toEqual({ x: 0, y: 0, z: 0 })
    expect(cam.up).toEqual({ x: 0, y: 1, z: 0 })
    expect(cam.fovDegrees).toBe(P.fovDegrees)
    expect(cam.mode).toBe('chase')
  })

  // The bug: one shared Vec3 across position/lookAt/up, or two cameras sharing one
  // object. Both produce a camera that cannot be positioned at all, and a shape-only
  // assertion passes.
  it('gives position, lookAt and up their own objects, per camera', () => {
    const a = createCameraState()
    const b = createCameraState()
    a.position.x = 5
    expect(a.lookAt.x).toBe(0)
    expect(a.up.x).toBe(0)
    expect(b.position.x).toBe(0)
  })
})

describe('updateCamera', () => {
  it('ticks = 0 changes nothing at all, including mode and fov', () => {
    const cam = seeded()
    const before = clone(cam)
    updateCamera(cam, makeKartView({ position: { x: 99, y: 9, z: 99 }, boostTicks: 90 }), P, 'results', 0)
    expect(cam).toEqual(before)
    updateCamera(cam, makeKartView(), P, 'chase', -3)
    expect(cam).toEqual(before)
  })

  /**
   * The exact chase pose, with no smoothing in the way (a fresh camera snaps). The bug
   * this catches is a sign error on `distance`, which puts the camera in FRONT of the
   * kart looking back — the game is then unplayable and every convergence and equality
   * test in this file still passes.
   */
  it('a fresh camera snaps to the exact chase pose', () => {
    const cam = createCameraState()
    const target = makeKartView({ position: { x: 10, y: 1, z: 4 }, heading: 0 })
    updateCamera(cam, target, P, 'chase', 1)
    expect(cam.position.x).toBeCloseTo(10 - P.distance, 9)
    expect(cam.position.y).toBeCloseTo(1 + P.height, 9)
    expect(cam.position.z).toBeCloseTo(4, 9)
    expect(cam.lookAt.x).toBeCloseTo(10 + P.lookAhead, 9)
    expect(cam.lookAt.y).toBeCloseTo(1, 9)
    expect(cam.lookAt.z).toBeCloseTo(4, 9)
    // the camera is behind the kart, and the kart is between the camera and the target
    expect(cam.position.x).toBeLessThan(target.position.x)
    expect(cam.lookAt.x).toBeGreaterThan(target.position.x)
  })

  /**
   * §8.1: N calls with 1 tick equal 1 call with N ticks, to 1e-9. This is the assertion
   * that rejects `k * ticks` pooling — and the second half of the test proves it can:
   * the naive factor 0.18 * 8 = 1.44 lands the camera 20+ metres past where the pooled
   * factor 1 - 0.82^8 = 0.7956 does.
   */
  it('N calls of 1 tick equal 1 call of N ticks, from an already-following camera', () => {
    const stepwise = seeded()
    const once = clone(stepwise)
    const target = makeKartView({ position: { x: 40, y: 2, z: 30 }, heading: -1.2 })

    for (let i = 0; i < 8; i++) updateCamera(stepwise, target, P, 'chase', 1)
    updateCamera(once, target, P, 'chase', 8)

    for (const axis of ['x', 'y', 'z'] as const) {
      expect(Math.abs(stepwise.position[axis] - once.position[axis])).toBeLessThan(1e-9)
      expect(Math.abs(stepwise.lookAt[axis] - once.lookAt[axis])).toBeLessThan(1e-9)
    }

    const start = seeded()
    const desiredX = target.position.x - Math.cos(target.heading) * P.distance
    const naiveX = start.position.x + (desiredX - start.position.x) * (P.positionLerpPerTick * 8)
    expect(Math.abs(naiveX - once.position.x)).toBeGreaterThan(1)
  })

  it('converges monotonically toward the desired pose and stays there', () => {
    const cam = seeded()
    const target = makeKartView({ position: { x: 60, y: 5, z: -20 }, heading: 2 })
    const desired = {
      x: target.position.x - Math.cos(target.heading) * P.distance,
      y: target.position.y + P.height,
      z: target.position.z - Math.sin(target.heading) * P.distance,
    }
    let previous = Infinity
    for (let i = 0; i < 40; i++) {
      updateCamera(cam, target, P, 'chase', 1)
      const d = Math.hypot(
        cam.position.x - desired.x,
        cam.position.y - desired.y,
        cam.position.z - desired.z,
      )
      expect(d).toBeLessThan(previous)
      previous = d
    }
    expect(previous).toBeLessThan(0.1)
  })

  it('is deterministic: identical inputs give identical output', () => {
    const a = seeded()
    const b = seeded()
    const target = makeKartView({ position: { x: 12, y: 0.5, z: -7 }, heading: 1.9, boostTicks: 30 })
    for (let i = 0; i < 5; i++) {
      updateCamera(a, target, P, 'chase', 3)
      updateCamera(b, target, P, 'chase', 3)
    }
    expect(a).toEqual(b)
  })

  /**
   * The shortest-arc rule. A componentwise lerp of the look POINT (or an unwrapped angle
   * lerp) swings the camera the long way round every time the kart's heading crosses
   * +/-pi: from -3.0 rad toward +3.0 rad the naive result is -1.68 rad — a 1.3 rad whip
   * in one tick, in the wrong direction.
   */
  it('turns the short way when the target heading crosses +/-pi', () => {
    const at = { x: 0, y: 0, z: 0 }
    const cam = createCameraState()
    updateCamera(cam, makeKartView({ position: at, heading: -3 }), P, 'chase', 1) // snap
    expect(lookYaw(cam, at)).toBeCloseTo(-3, 9)

    updateCamera(cam, makeKartView({ position: at, heading: 3 }), P, 'chase', 1)
    const expected = -3 + (6 - 2 * Math.PI) * P.headingLerpPerTick // = -3.0623...
    expect(lookYaw(cam, at)).toBeCloseTo(expected, 9)
    expect(lookYaw(cam, at)).toBeLessThan(-3) // short way: away from zero, not toward it
  })

  it('sets fov from boostTicks instantly, clamped', () => {
    const cases: readonly [string, number, number][] = [
      ['no boost', 0, P.fovDegrees],
      ['half boost', ITEM_BOOST_TICKS / 2, P.fovDegrees + P.fovBoostDegrees / 2],
      ['full boost', ITEM_BOOST_TICKS, P.fovDegrees + P.fovBoostDegrees],
      ['stacked boost, clamped', ITEM_BOOST_TICKS * 3, P.fovDegrees + P.fovBoostDegrees],
    ]
    for (const [, boostTicks, want] of cases) {
      const cam = seeded()
      updateCamera(cam, makeKartView({ boostTicks }), P, 'chase', 1)
      expect(cam.fovDegrees).toBeCloseTo(want, 9)
    }
  })

  it('rewrites up every update, so an adapter never has to invent one', () => {
    const cam = seeded()
    cam.up.x = 7
    cam.up.y = -2
    cam.up.z = 3
    updateCamera(cam, makeKartView(), P, 'chase', 1)
    expect(cam.up).toEqual({ x: 0, y: 1, z: 0 })
  })

  it('copies the mode it was given', () => {
    const cam = seeded()
    updateCamera(cam, makeKartView(), P, 'results', 1)
    expect(cam.mode).toBe('results')
    updateCamera(cam, makeKartView(), P, 'free', 1)
    expect(cam.mode).toBe('free')
  })

  it("'countdown' snaps rather than settling", () => {
    const cam = seeded()
    const target = makeKartView({ position: { x: -30, y: 3, z: 18 }, heading: 0.7 })
    updateCamera(cam, target, P, 'countdown', 1)
    expect(cam.position.x).toBeCloseTo(target.position.x - Math.cos(0.7) * P.distance, 9)
    expect(cam.position.z).toBeCloseTo(target.position.z - Math.sin(0.7) * P.distance, 9)
    expect(cam.position.y).toBeCloseTo(target.position.y + P.height, 9)
  })

  it("'results' looks at the kart itself", () => {
    const cam = seeded()
    const target = makeKartView({ position: { x: 5, y: 2, z: -9 }, heading: 1.1 })
    updateCamera(cam, target, P, 'results', 1)
    expect(cam.lookAt.x).toBeCloseTo(target.position.x, 9)
    expect(cam.lookAt.y).toBeCloseTo(target.position.y, 9)
    expect(cam.lookAt.z).toBeCloseTo(target.position.z, 9)
  })

  it("'free' updates mode and fov but leaves the pose to whoever owns it", () => {
    const cam = seeded()
    const pose = { position: { ...cam.position }, lookAt: { ...cam.lookAt } }
    updateCamera(cam, makeKartView({ position: { x: 500, y: 50, z: 500 }, boostTicks: 90 }), P, 'free', 4)
    expect(cam.position).toEqual(pose.position)
    expect(cam.lookAt).toEqual(pose.lookAt)
    expect(cam.mode).toBe('free')
    expect(cam.fovDegrees).toBeCloseTo(P.fovDegrees + P.fovBoostDegrees, 9)
  })

  it('never reads a clock: the same call at any wall time gives the same pose', () => {
    // Structural, not temporal: updateCamera takes ticks and nothing else time-shaped.
    // A camera that reached for Date.now() would drift between these two runs.
    const a = seeded()
    const b = seeded()
    const target = makeKartView({ position: { x: 3, y: 0, z: 3 }, heading: 0.4 })
    updateCamera(a, target, P, 'chase', 6)
    const spin = Date.now() + 2
    while (Date.now() < spin) {
      /* burn a couple of milliseconds */
    }
    updateCamera(b, target, P, 'chase', 6)
    expect(a).toEqual(b)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/render/test/camera.test.ts`

Expected: FAIL to collect, with
`Error: Cannot find module '../src/camera' imported from '<repo>/packages/render/test/camera.test.ts'`
(caused by `Failed to load url ../src/camera ... Does the file exist?`).

- [ ] **Step 3: Write the implementation**

Create `packages/render/src/camera.ts`:

```ts
// PURE (contract §0a): no DOM, no GPU, no clock, no `three` import. Smoothing is per SIM
// TICK, never per frame — a frame-rate-dependent lerp behaves differently on a 60 Hz
// phone and a 144 Hz desktop and cannot be asserted in CI at all.
import type { Vec3 } from '@tapkart/sim'
import { ITEM_BOOST_TICKS, clamp, wrapAngle } from '@tapkart/sim'
import type { KartView } from './types'

export type CameraMode = 'chase' | 'countdown' | 'results' | 'free'

export interface CameraParams {
  distance: number // metres behind the kart
  height: number // metres above the kart
  lookAhead: number // metres ahead of the kart for the look target
  positionLerpPerTick: number // 0..1, applied once per sim tick
  headingLerpPerTick: number // 0..1, applied once per sim tick, shortest arc
  fovDegrees: number
  fovBoostDegrees: number // ADDITIONAL degrees at full boost, blended by boostTicks
  near: number // metres
  far: number // metres
}

export const DEFAULT_CAMERA_PARAMS: Readonly<CameraParams> = {
  distance: 7,
  height: 3,
  lookAhead: 8,
  positionLerpPerTick: 0.18,
  headingLerpPerTick: 0.22,
  fovDegrees: 62,
  fovBoostDegrees: 8,
  near: 0.3,
  far: 900,
}

export interface CameraState {
  position: Vec3
  lookAt: Vec3
  up: Vec3 // (0, 1, 0) in every v1 mode; a field, not a constant, so the adapter never
  // invents one
  fovDegrees: number
  mode: CameraMode
}

/** A camera that has not followed anything yet: `position` equals `lookAt`, which is the
 *  marker `updateCamera` reads to snap on its first update instead of swooping in from
 *  the world origin across the first second of the race. */
export function createCameraState(): CameraState {
  return {
    position: { x: 0, y: 0, z: 0 },
    lookAt: { x: 0, y: 0, z: 0 },
    up: { x: 0, y: 1, z: 0 },
    fovDegrees: DEFAULT_CAMERA_PARAMS.fovDegrees,
    mode: 'chase',
  }
}

/**
 * Advances `cam` by exactly `ticks` sim ticks toward the pose implied by `target`.
 * `ticks` may be 0 (a render frame with no sim tick), in which case nothing changes.
 * Deterministic: same (cam, target, params, mode, ticks) in, same cam out. SOLE WRITER of
 * every CameraState field (§7.2).
 */
export function updateCamera(
  cam: CameraState,
  target: KartView,
  params: CameraParams,
  mode: CameraMode,
  ticks: number,
): void {
  if (ticks <= 0) return

  cam.mode = mode
  cam.up.x = 0
  cam.up.y = 1
  cam.up.z = 0
  // set directly rather than smoothed, so the boost kick is instant
  cam.fovDegrees =
    params.fovDegrees + params.fovBoostDegrees * clamp(target.boostTicks / ITEM_BOOST_TICKS, 0, 1)

  // 'free' is driven by something other than the target, so the pose is left alone.
  if (mode === 'free') return

  // forward = (cos h, 0, sin h), contract §0
  const forwardX = Math.cos(target.heading)
  const forwardZ = Math.sin(target.heading)
  const lookAhead = mode === 'results' ? 0 : params.lookAhead

  // The desired pose is computed ONCE, from `target`, and held fixed for the whole call.
  // That is what makes "N calls of 1 tick" and "1 call of N ticks" agree exactly.
  const desiredX = target.position.x - forwardX * params.distance
  const desiredY = target.position.y + params.height
  const desiredZ = target.position.z - forwardZ * params.distance

  const uninitialised =
    cam.position.x === cam.lookAt.x &&
    cam.position.y === cam.lookAt.y &&
    cam.position.z === cam.lookAt.z
  const snap = uninitialised || mode === 'countdown'

  // Pooled, not multiplied: with k = 0.18 and 8 ticks, 1 - 0.82**8 = 0.796 converges,
  // while k * ticks = 1.44 overshoots the target and oscillates.
  const kPosition = snap ? 1 : 1 - (1 - params.positionLerpPerTick) ** ticks
  const kHeading = snap ? 1 : 1 - (1 - params.headingLerpPerTick) ** ticks

  cam.position.x += (desiredX - cam.position.x) * kPosition
  cam.position.y += (desiredY - cam.position.y) * kPosition
  cam.position.z += (desiredZ - cam.position.z) * kPosition

  // The look direction is angle-lerped around the kart on the SHORTEST ARC. Lerping the
  // look point componentwise swings the camera the long way round whenever the kart's
  // heading crosses +/-pi. When the current look point sits on the kart (lookAhead 0, or a
  // camera that has just left 'results'), there is no direction to recover and the yaw
  // starts from the kart's own heading.
  const dx = cam.lookAt.x - target.position.x
  const dz = cam.lookAt.z - target.position.z
  const current = Math.hypot(dx, dz) < 1e-9 ? target.heading : Math.atan2(dz, dx)
  const yaw = wrapAngle(current + wrapAngle(target.heading - current) * kHeading)

  cam.lookAt.x = target.position.x + Math.cos(yaw) * lookAhead
  cam.lookAt.y = target.position.y
  cam.lookAt.z = target.position.z + Math.sin(yaw) * lookAhead
}
```

Then modify `packages/render/src/index.ts` — append one line after
`export * from './descriptors'`:

```ts
export * from './types'
export * from './mesh'
export * from './descriptors'
export * from './camera'
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/render/test/camera.test.ts`
Expected: PASS — 16 tests.

Then:

```bash
npm run typecheck --workspace @tapkart/render
npx vitest run
```

- [ ] **Step 5: Commit**

```bash
git add packages/render/src/camera.ts packages/render/src/index.ts \
        packages/render/test/camera.test.ts && \
git commit -m "feat(render): pure tick-driven chase camera

- updateCamera advances by exactly N ticks with a pooled 1 - (1 - k)**ticks factor, so
  N calls of 1 tick equal 1 call of N to 1e-9 and frame rate cannot change the feel
- ticks = 0 is a total no-op; no clock is read anywhere
- look direction is angle-lerped on the shortest arc, so a heading crossing +/-pi does
  not swing the camera the long way round
- fov is set, not smoothed, from clamp(boostTicks / ITEM_BOOST_TICKS)"
```
