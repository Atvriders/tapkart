import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { ITEM_BOOST_TICKS, wrapAngle } from '@tapkart/sim'

import type { CameraState } from '../src/camera'
import {
  DEFAULT_CAMERA_PARAMS,
  PROJECTION_BAND,
  createCameraState,
  projectionFovDegrees,
  softBand,
  updateCamera,
} from '../src/camera'
// The barrel, to prove §4.11's new `export * from './camera'` line is actually there.
import * as barrel from '../src/index'
import type {
  CameraMode as BarrelCameraMode,
  CameraParams as BarrelCameraParams,
  CameraState as BarrelCameraState,
} from '../src/index'
import { makeKartView } from './fixtures/render-fixtures'

const P = DEFAULT_CAMERA_PARAMS

const AXES = ['x', 'y', 'z'] as const

const CAMERA_SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'camera.ts')

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

/** The camera's desired chase position for a kart — the pose it settles on when the
 *  kart stops moving. Stated as §4.6 states it; the smoothing is what is under test. */
function desiredPosition(at: { x: number; y: number; z: number }, heading: number) {
  return {
    x: at.x - Math.cos(heading) * P.distance,
    y: at.y + P.height,
    z: at.z - Math.sin(heading) * P.distance,
  }
}

function distanceTo(cam: CameraState, to: { x: number; y: number; z: number }): number {
  return Math.hypot(cam.position.x - to.x, cam.position.y - to.y, cam.position.z - to.z)
}

/**
 * The steady-state lag of a per-tick lerp chasing a target that moves `perTick` per tick.
 * Derived from the recurrence, NOT read off the implementation: with
 * `e_n = desired_n - cam_n`, one tick gives `e_n = (1 - k) * (e_{n-1} + perTick)`, whose
 * fixed point is `perTick * (1 - k) / k`. It is the number that separates a smoothed
 * camera from a camera that snaps to the ideal pose every tick (lag exactly 0) and from
 * one welded to the kart (no offset at all).
 */
function settledLag(perTick: number, k: number): number {
  return (perTick * (1 - k)) / k
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
  //
  // STRENGTHENED: writing to `a.position` and reading `a.lookAt`/`a.up` cannot see the
  // aliasing that does NOT involve `position` — `lookAt === up` leaves both reads at 0
  // and the value check green. Object identity is the whole claim, so assert identity.
  it('gives position, lookAt and up their own objects, per camera', () => {
    const a = createCameraState()
    const b = createCameraState()
    a.position.x = 5
    expect(a.lookAt.x).toBe(0)
    expect(a.up.x).toBe(0)
    expect(b.position.x).toBe(0)

    expect(a.position).not.toBe(a.lookAt)
    expect(a.position).not.toBe(a.up)
    expect(a.lookAt).not.toBe(a.up)
    for (const field of ['position', 'lookAt', 'up'] as const) {
      expect(a[field]).not.toBe(b[field])
    }
  })
})

describe('updateCamera', () => {
  it('ticks = 0 changes nothing at all, including mode and fov', () => {
    const cam = seeded()
    const before = clone(cam)
    updateCamera(
      cam,
      makeKartView({ position: { x: 99, y: 9, z: 99 }, boostTicks: 90 }),
      P,
      'results',
      0,
    )
    expect(cam).toEqual(before)
    updateCamera(cam, makeKartView(), P, 'chase', -3)
    expect(cam).toEqual(before)
  })

  /**
   * The exact chase pose, with no smoothing in the way (a fresh camera snaps). The bug
   * this catches is a sign error on `distance`, which puts the camera in FRONT of the
   * kart looking back — the game is then unplayable and every convergence and equality
   * test in this file still passes.
   *
   * STRENGTHENED to an `it.each` over three headings. The brief's single case used
   * `heading: 0`, where `sin h` is 0 and BOTH z terms vanish: a camera that dropped the
   * `sin` term, applied `distance` to the wrong axis or lifted the look point off the
   * ground plane passed it (Task 8's lesson — a partial 3-D check reading as a whole
   * one). Only `0.9` and `-2.4` have both `cos h` and `sin h` non-zero and of
   * independent sign.
   */
  it.each([0, 0.9, -2.4])('a fresh camera snaps to the exact chase pose (heading %s)', (h) => {
    const cam = createCameraState()
    const target = makeKartView({ position: { x: 10, y: 1, z: 4 }, heading: h })
    updateCamera(cam, target, P, 'chase', 1)
    expect(cam.position.x).toBeCloseTo(10 - Math.cos(h) * P.distance, 9)
    expect(cam.position.y).toBeCloseTo(1 + P.height, 9)
    expect(cam.position.z).toBeCloseTo(4 - Math.sin(h) * P.distance, 9)
    expect(cam.lookAt.x).toBeCloseTo(10 + Math.cos(h) * P.lookAhead, 9)
    expect(cam.lookAt.y).toBeCloseTo(1, 9)
    expect(cam.lookAt.z).toBeCloseTo(4 + Math.sin(h) * P.lookAhead, 9)

    // the camera is behind the kart and the look point ahead of it, along the kart's own
    // forward axis — the sign check, stated in a form that does not depend on h
    const fx = Math.cos(h)
    const fz = Math.sin(h)
    expect(fx * (cam.position.x - 10) + fz * (cam.position.z - 4)).toBeCloseTo(-P.distance, 9)
    expect(fx * (cam.lookAt.x - 10) + fz * (cam.lookAt.z - 4)).toBeCloseTo(P.lookAhead, 9)
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

    for (const axis of AXES) {
      expect(Math.abs(stepwise.position[axis] - once.position[axis])).toBeLessThan(1e-9)
      expect(Math.abs(stepwise.lookAt[axis] - once.lookAt[axis])).toBeLessThan(1e-9)
    }

    const start = seeded()
    const desiredX = target.position.x - Math.cos(target.heading) * P.distance
    const naiveX = start.position.x + (desiredX - start.position.x) * (P.positionLerpPerTick * 8)
    expect(Math.abs(naiveX - once.position.x)).toBeGreaterThan(1)

    // ADDED: the equality above is only evidence if the eight ticks actually moved the
    // camera a long way. A no-op updateCamera satisfies "N equals 1" perfectly.
    expect(distanceTo(once, start.position)).toBeGreaterThan(20)
  })

  /**
   * ADDED — the behavioural witness for the pooled factor. The equality test above is an
   * ALGEBRAIC one, and it is the only thing in the brief that sees `k * ticks`; this is
   * what that bug looks like as motion. At 8 ticks the multiplied factor is 1.44, so the
   * camera flies PAST the pose and comes back at it from the other side every call, for
   * ever. Note that the distance still falls monotonically under that bug (|1 - 1.44| =
   * 0.44 per call), so only the per-axis SIGN and the exact ratio can see it.
   */
  it('a batch of 8 ticks converges by exactly (1 - k)**8 per call, without overshooting', () => {
    const cam = seeded()
    const target = makeKartView({ position: { x: -18, y: 4, z: 26 }, heading: -0.6 })
    const desired = desiredPosition(target.position, target.heading)
    const approachSign = {
      x: Math.sign(desired.x - cam.position.x),
      y: Math.sign(desired.y - cam.position.y),
      z: Math.sign(desired.z - cam.position.z),
    }
    let previous = distanceTo(cam, desired)
    for (let call = 0; call < 6; call++) {
      updateCamera(cam, target, P, 'chase', 8)
      const d = distanceTo(cam, desired)
      expect(d / previous).toBeCloseTo((1 - P.positionLerpPerTick) ** 8, 9)
      for (const axis of AXES) {
        expect(Math.sign(desired[axis] - cam.position[axis])).toBe(approachSign[axis])
      }
      previous = d
    }
  })

  /**
   * STRENGTHENED. The brief asserted only that the distance to the desired pose shrinks
   * every tick — which an OVERSHOOTING camera also satisfies: a factor of 1.5 flips the
   * error's sign every tick and halves its magnitude, so the distance falls monotonically
   * while the camera oscillates through the kart. Three claims about the shape of the
   * curve, not just its endpoint:
   *   1. the distance falls by exactly one factor of (1 - k) per tick — the exponential a
   *      per-tick lerp toward a FIXED target produces (and, at i = 0, proof that the first
   *      tick smooths rather than snapping);
   *   2. the signed error on each axis keeps its sign for all 40 ticks — the camera
   *      approaches from one side and never crosses the target;
   *   3. and it ends up there.
   */
  it('converges geometrically toward the desired pose, never overshooting it', () => {
    const cam = seeded()
    const target = makeKartView({ position: { x: 60, y: 5, z: -20 }, heading: 2 })
    const desired = desiredPosition(target.position, target.heading)
    const approachSign = {
      x: Math.sign(desired.x - cam.position.x),
      y: Math.sign(desired.y - cam.position.y),
      z: Math.sign(desired.z - cam.position.z),
    }
    for (const axis of AXES) expect(approachSign[axis]).not.toBe(0) // all three really move

    const first = distanceTo(cam, desired)
    let previous = first
    for (let i = 0; i < 40; i++) {
      updateCamera(cam, target, P, 'chase', 1)
      const d = distanceTo(cam, desired)
      expect(d / previous).toBeCloseTo(1 - P.positionLerpPerTick, 9)
      expect(d).toBeLessThan(previous)
      for (const axis of AXES) {
        expect(Math.sign(desired[axis] - cam.position[axis])).toBe(approachSign[axis])
      }
      previous = d
    }
    expect(previous).toBeLessThan(first * 1e-3)
    expect(previous).toBeLessThan(0.1)
  })

  it('is deterministic: identical inputs give identical output', () => {
    const a = seeded()
    const b = seeded()
    const target = makeKartView({
      position: { x: 12, y: 0.5, z: -7 },
      heading: 1.9,
      boostTicks: 30,
    })
    for (let i = 0; i < 5; i++) {
      updateCamera(a, target, P, 'chase', 3)
      updateCamera(b, target, P, 'chase', 3)
    }
    expect(a).toEqual(b)
    // ADDED: two cameras that were never touched are also identical. The determinism
    // claim is only worth making about a camera that moved.
    expect(a).not.toEqual(seeded())
    expect(distanceTo(a, seeded().position)).toBeGreaterThan(1)
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
    for (const [name, boostTicks, want] of cases) {
      const cam = seeded()
      // one tick, from a camera already at `fovDegrees`: a SMOOTHED fov reaches only
      // 63.44 of the 70 degrees that full boost demands, so this sees the difference
      expect(cam.fovDegrees).toBe(P.fovDegrees)
      updateCamera(cam, makeKartView({ boostTicks }), P, 'chase', 1)
      expect(cam.fovDegrees, name).toBeCloseTo(want, 9)
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
    const desired = desiredPosition(target.position, target.heading)
    // the pose it would smooth to in one tick, if 'countdown' were an ordinary chase —
    // 40+ metres from where it must actually land, so the two cannot be confused
    expect(distanceTo(cam, desired)).toBeGreaterThan(40)
    updateCamera(cam, target, P, 'countdown', 1)
    expect(cam.position.x).toBeCloseTo(desired.x, 9)
    expect(cam.position.z).toBeCloseTo(desired.z, 9)
    expect(cam.position.y).toBeCloseTo(desired.y, 9)
    // and it stays snapped on later ticks, from an already-following camera
    const moved = makeKartView({ position: { x: 4, y: 0, z: -11 }, heading: -2.2 })
    updateCamera(cam, moved, P, 'countdown', 1)
    const desired2 = desiredPosition(moved.position, moved.heading)
    for (const axis of AXES) expect(cam.position[axis]).toBeCloseTo(desired2[axis], 9)
  })

  it("'results' looks at the kart itself", () => {
    const cam = seeded()
    const target = makeKartView({ position: { x: 5, y: 2, z: -9 }, heading: 1.1 })
    updateCamera(cam, target, P, 'results', 1)
    expect(cam.lookAt.x).toBeCloseTo(target.position.x, 9)
    expect(cam.lookAt.y).toBeCloseTo(target.position.y, 9)
    expect(cam.lookAt.z).toBeCloseTo(target.position.z, 9)
  })

  /**
   * ADDED. `lookAhead = 0` is the ONLY thing 'results' changes: the brief asserted the
   * look point and nothing else, so a 'results' branch that also snapped its position —
   * or that stopped moving it at all — left every assertion in this file green. One tick
   * must leave exactly one factor of (1 - k) of the distance outstanding.
   */
  it("'results' smooths its position exactly as 'chase' does — it does not snap", () => {
    const cam = seeded()
    const target = makeKartView({ position: { x: 5, y: 2, z: -9 }, heading: 1.1 })
    const desired = desiredPosition(target.position, target.heading)
    const before = distanceTo(cam, desired)
    expect(before).toBeGreaterThan(5)
    updateCamera(cam, target, P, 'results', 1)
    expect(distanceTo(cam, desired) / before).toBeCloseTo(1 - P.positionLerpPerTick, 9)
  })

  /**
   * ADDED. The degenerate look point, which only 'results' produces and which nothing in
   * the brief exercised: after a 'results' update `lookAt` sits EXACTLY on the kart, so
   * there is no direction left to recover with atan2. `Math.atan2(0, 0)` is 0, so a
   * camera without the guard treats the kart as if it were looking along +x and whips
   * 0.22 of the way there — a visible snap to the wrong bearing on the first tick after
   * a results screen. Starting from the kart's own heading is the only continuous choice.
   */
  it('recovers from a look point sitting on the kart, without whipping toward +x', () => {
    const cam = seeded()
    const target = makeKartView({ position: { x: 5, y: 2, z: -9 }, heading: 2.5 })
    updateCamera(cam, target, P, 'results', 1)
    expect(cam.lookAt).toEqual({ x: 5, y: 2, z: -9 }) // precondition: exactly degenerate

    updateCamera(cam, target, P, 'chase', 1)
    expect(lookYaw(cam, target.position)).toBeCloseTo(target.heading, 9)
    // what the unguarded atan2(0, 0) would have produced, for contrast
    expect(lookYaw(cam, target.position)).not.toBeCloseTo(target.heading * P.headingLerpPerTick, 3)
  })

  it("'free' updates mode and fov but leaves the pose to whoever owns it", () => {
    const cam = seeded()
    const pose = { position: { ...cam.position }, lookAt: { ...cam.lookAt } }
    updateCamera(
      cam,
      makeKartView({ position: { x: 500, y: 50, z: 500 }, boostTicks: 90 }),
      P,
      'free',
      4,
    )
    expect(cam.position).toEqual(pose.position)
    expect(cam.lookAt).toEqual(pose.lookAt)
    expect(cam.mode).toBe('free')
    expect(cam.fovDegrees).toBeCloseTo(P.fovDegrees + P.fovBoostDegrees, 9)
  })

  /**
   * ADDED — the chase camera under REAL MOTION, which is the only condition that can tell
   * a chase camera from a camera bolted to the kart's transform. A stationary kart proves
   * nothing: every assertion above it is equally true of a camera that snaps.
   *
   * Asserts, every tick of 200: the offset (behind, and above by `height`), the lag (the
   * gap EXCEEDS `distance`, because the camera is chasing a point that keeps moving), and
   * that the two are never the same point. The settled lag is `V*(1-k)/k` = 1.822 m —
   * a camera that snapped every tick would sit at exactly 7.000, and a welded one at 0.
   */
  it('trails a kart driving in a straight line, by a real and bounded lag', () => {
    const V = 0.4 // metres per tick ~ 24 m/s at 60 Hz
    const kart = makeKartView({ position: { x: 0, y: 0.5, z: 3 }, heading: 0 })
    const cam = createCameraState()
    updateCamera(cam, kart, P, 'chase', 1) // snap: the run starts from the ideal pose
    expect(kart.position.x - cam.position.x).toBeCloseTo(P.distance, 9) // no lag yet

    const gaps: number[] = []
    for (let i = 0; i < 200; i++) {
      kart.position.x += V
      updateCamera(cam, kart, P, 'chase', 1)
      const gap = kart.position.x - cam.position.x
      // behind the kart, and further behind than a camera with no lag would be
      expect(gap).toBeGreaterThan(P.distance)
      // never welded: the camera and the kart are never the same point, in 3-D
      expect(distanceTo(cam, kart.position)).toBeGreaterThan(P.distance)
      // the off-axis channels do not drift while the on-axis one lags
      expect(cam.position.y).toBeCloseTo(kart.position.y + P.height, 9)
      expect(cam.position.z).toBeCloseTo(kart.position.z, 9)
      // the lag builds monotonically toward its fixed point. Strict growth is asserted
      // only over the first 100 ticks: by tick 100 the gap is 3.6e-9 short of the fixed
      // point and each further increment is smaller than that, until around tick 165 the
      // increments fall under one ulp of 8.8 and the sequence stops changing. Demanding
      // strict growth at tick 199 is a demand for float noise, not for behaviour.
      if (i > 0 && i < 100) expect(gap).toBeGreaterThan(gaps[i - 1])
      if (i > 0) expect(gap).toBeGreaterThanOrEqual(gaps[i - 1] - 1e-12)
      gaps.push(gap)
    }

    const settled = P.distance + settledLag(V, P.positionLerpPerTick)
    expect(settled).toBeCloseTo(8.822222222, 9)
    expect(gaps[gaps.length - 1]).toBeCloseTo(settled, 9)
    // it settles, it does not run away (the 1e-9 covers 1.4e-14 of accumulated rounding
    // above the exact fixed point, and nothing larger)
    expect(Math.max(...gaps)).toBeLessThan(settled + 1e-9)
    // and the camera really did travel the length of the run with the kart
    expect(cam.position.x).toBeCloseTo(200 * V - settled, 6)
  })

  /**
   * ADDED — the heading channel's version of the lag above, isolated. The kart spins on
   * the spot (sim's own spin-out does exactly this), so the look point's anchor never
   * moves and the recurrence is exactly the one `settledLag` solves: the look direction
   * settles `W*(1-k)/k` = 0.0709 rad BEHIND the heading, and it is measured here to 7e-17.
   * A camera that snapped its look direction reads exactly 0; one that led the kart reads
   * a negative number; one that lerped the look POINT componentwise does not survive the
   * +/-pi wrap this run drives through.
   */
  it('lags a heading that turns at a constant rate by exactly W*(1-k)/k', () => {
    const W = 0.02 // radians per tick
    const kart = makeKartView({ position: { x: 12, y: 1, z: -5 }, heading: 0 })
    const cam = createCameraState()
    updateCamera(cam, kart, P, 'chase', 1) // snap

    let wraps = 0
    let previousHeading = kart.heading
    const lags: number[] = []
    for (let i = 1; i <= 300; i++) {
      kart.heading = wrapAngle(i * W)
      if (Math.abs(kart.heading - previousHeading) > Math.PI) wraps++
      previousHeading = kart.heading
      updateCamera(cam, kart, P, 'chase', 1)
      lags.push(wrapAngle(kart.heading - lookYaw(cam, kart.position)))
    }
    expect(wraps).toBe(1) // the run really did cross +/-pi

    expect(lags[lags.length - 1]).toBeCloseTo(settledLag(W, P.headingLerpPerTick), 9)
    expect(lags[lags.length - 1]).toBeCloseTo(0.070909090909, 9)
    // steady, not still drifting: the last 50 ticks hold it to a fifth of a nanoradian
    for (let i = lags.length - 50; i < lags.length; i++) {
      expect(Math.abs(lags[i] - lags[i - 1])).toBeLessThan(1e-12)
    }
    // and it approached that lag from zero rather than starting there
    expect(lags[0]).toBeLessThan(lags[lags.length - 1] / 2)
    expect(lags[0]).toBeGreaterThan(0)
  })

  /**
   * ADDED — real motion on a CURVE, which is where a chase camera is actually judged, and
   * which sweeps the kart's heading through the +/-pi wrap twice as an ordinary
   * consequence of driving rather than as a hand-placed edge case.
   */
  it('stays behind a kart driving a circle, through the +/-pi heading wrap', () => {
    const R = 30 // metres
    const W = 0.02 // radians per tick -> 0.6 m/tick ~ 36 m/s at 60 Hz
    const kart = makeKartView()
    const cam = createCameraState()
    const place = (theta: number): void => {
      kart.position.x = R * Math.cos(theta)
      kart.position.z = R * Math.sin(theta)
      kart.heading = wrapAngle(theta + Math.PI / 2)
    }
    place(0)
    updateCamera(cam, kart, P, 'chase', 1) // snap onto the kart at the start of the lap

    let wraps = 0
    let previousHeading = kart.heading
    let lagAt200 = NaN
    for (let i = 1; i <= 400; i++) {
      place(i * W)
      if (Math.abs(kart.heading - previousHeading) > Math.PI) wraps++
      previousHeading = kart.heading
      updateCamera(cam, kart, P, 'chase', 1)

      const fx = Math.cos(kart.heading)
      const fz = Math.sin(kart.heading)
      const bx = cam.position.x - kart.position.x
      const bz = cam.position.z - kart.position.z
      // behind the kart's own forward axis on every one of the 400 ticks
      expect(fx * bx + fz * bz).toBeLessThan(0)
      const trail = Math.hypot(bx, bz)
      expect(trail).toBeGreaterThan(1) // never welded to the kart
      expect(trail).toBeLessThan(2 * P.distance) // and never thrown off it

      // the look point leads the kart by exactly `lookAhead`, on the kart's own y
      const lx = cam.lookAt.x - kart.position.x
      const lz = cam.lookAt.z - kart.position.z
      expect(Math.hypot(lx, lz)).toBeCloseTo(P.lookAhead, 9)
      expect(fx * lx + fz * lz).toBeGreaterThan(0)
      expect(cam.lookAt.y).toBeCloseTo(kart.position.y, 9)

      if (i === 200) lagAt200 = wrapAngle(kart.heading - lookYaw(cam, kart.position))
    }
    expect(wraps).toBe(2) // the lap really did cross +/-pi, twice

    /*
     * The look direction settles BEHIND the heading here too — by MORE than the spinning
     * kart above, and this is the one number in the file I do not derive in closed form.
     * `settledLag` does not apply: the anchor moves. The previous look point was placed
     * 8 m ahead of where the kart WAS, and `atan2` recovers its bearing from where the
     * kart now IS, so the kart's own travel rotates the recovered bearing further back
     * before the lerp even runs — positive feedback on the lag, proportional to it.
     * Linearising that extra term gives (1-k)W / (1 - (1-k)(1 + v/lookAhead)) = 0.0966;
     * the run measures 0.10343 (the linearisation drops the chord-vs-tangent and
     * sin(a) ~ a errors). So the assertions are the two claims I can defend — the effect's
     * SIGN (more lag than the stationary-anchor case, never less) and its boundedness —
     * plus the claim that it is a steady state at all. A snapped look direction reads 0
     * and fails the lower bound; a leading camera reads negative and fails it too.
     */
    const spinLag = settledLag(W, P.headingLerpPerTick)
    const lag = wrapAngle(kart.heading - lookYaw(cam, kart.position))
    expect(lag).toBeGreaterThan(spinLag)
    expect(lag).toBeLessThan(2 * spinLag)
    // settled: 200 ticks earlier it already held this value
    expect(lag).toBeCloseTo(lagAt200, 9)
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

/**
 * ADDED. The test above can only see a clock on the path it happens to execute; a
 * `Date.now()` behind `if (ticks > 100)`, or a `performance.now()` in a branch no fixture
 * reaches, is invisible to it and to every other test in this file. §0a's purity rules
 * are claims about the MODULE, so they are checked against the module's source. Comments
 * are stripped first — the file's own header says the words "clock" and "DOM".
 */
describe('src/camera.ts is pure (§0a, §8.2)', () => {
  const source = readFileSync(CAMERA_SRC, 'utf8')
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

  it('read the real module (guard: an empty read would pass every scan below)', () => {
    expect(code).toMatch(/export function updateCamera\(/)
    expect(code).toMatch(/export function createCameraState\(/)
  })

  it.each([
    ['Date', /\bDate\b/],
    ['performance', /\bperformance\b/],
    ['Math.random', /Math\s*\.\s*random/],
    ['setTimeout', /\bsetTimeout\b/],
    ['setInterval', /\bsetInterval\b/],
    ['requestAnimationFrame', /\brequestAnimationFrame\b/],
    ['document', /\bdocument\b/],
    ['window', /\bwindow\b/],
    ['globalThis', /\bglobalThis\b/],
    ['process', /\bprocess\b/],
  ])('names no %s anywhere in its code', (_name, pattern) => {
    expect(code).not.toMatch(pattern)
  })

  it('imports only @tapkart/sim and ./types — no `three`, at any depth (§8.2)', () => {
    const specifiers = [...code.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1])
    expect(specifiers.length).toBeGreaterThan(0)
    expect([...new Set(specifiers)].sort()).toEqual(['./types', '@tapkart/sim'])
  })
})

/**
 * ADDED. §4.11's barrel line is part of this task's diff and nothing else in the package
 * covers it: every other import here reaches `src/camera` by relative path, so a missing
 * `export * from './camera'` leaves `@tapkart/render` without a camera at all and leaves
 * this whole file green. Identity, not presence: a second copy of the smoothing rules
 * under the same name would pass `toBeDefined()`.
 */
describe('the @tapkart/render barrel re-exports camera (§4.11)', () => {
  it('carries all three of the module’s runtime exports, by identity', () => {
    expect(barrel.DEFAULT_CAMERA_PARAMS).toBe(DEFAULT_CAMERA_PARAMS)
    expect(barrel.createCameraState).toBe(createCameraState)
    expect(barrel.updateCamera).toBe(updateCamera)
  })

  it('carries the three type exports too — §11 counts six for render/camera', () => {
    // Compile-time: this object does not typecheck unless CameraMode, CameraParams and
    // CameraState all reach the barrel. `npm run typecheck` is the assertion; the runtime
    // check below only keeps the binding alive.
    const throughBarrel: {
      mode: BarrelCameraMode
      params: BarrelCameraParams
      state: BarrelCameraState
    } = { mode: 'countdown', params: { ...DEFAULT_CAMERA_PARAMS }, state: createCameraState() }
    expect(throughBarrel.mode).toBe('countdown')
    expect(throughBarrel.state.mode).toBe('chase')
    expect(throughBarrel.params.distance).toBe(7)
  })
})

/**
 * D2's aspect band. Every number below is HAND-WRITTEN, never recomputed from
 * `PROJECTION_BAND` or from the implementation's own composition — a test that rebuilt
 * the formula would agree with any formula, including a hard clamp.
 *
 * `horizontalFov` is the perspective relation itself, not a copy of anything in src:
 * three.js builds its frustum as `height = 2*near*tan(fov/2)`, `width = aspect*height`,
 * so the horizontal half-angle is `atan(aspect * tan(vFov/2))`. That is the definition
 * of what `PerspectiveCamera.fov` being VERTICAL means, and it is the quantity D2 is
 * actually banding.
 */
function horizontalFov(verticalFovDegrees: number, aspect: number): number {
  const halfV = ((verticalFovDegrees / 2) * Math.PI) / 180
  return (2 * Math.atan(aspect * Math.tan(halfV)) * 180) / Math.PI
}

/** Every shape D2 tabulates, with the vertical fov the function must return and the
 *  horizontal that implies. The design's own table rounds to one decimal and, on three
 *  rows, rounds an intermediate rather than the composite (it prints 73.6 for the
 *  square, which is the horizontal BEFORE the vertical band trims it to 73.485, and
 *  46.0 / 79.4 where the exact composites are 46.097 / 79.339). These are the exact
 *  composites; the divergence is at most 0.12 degrees and is reported, not smuggled. */
const D2_TABLE: readonly [name: string, aspect: number, vOut: number, hOut: number][] = [
  ['portrait phone', 0.462, 85.2863, 46.0969],
  ['square', 1.0, 73.4852, 73.4852],
  ['unfolded foldable', 1.2, 66.6049, 76.4993],
  ['4:3 tablet', 1.333, 63.7751, 79.339],
  ['16:10 tablet', 1.6, 62, 87.7438],
  ['16:9 phone', 1.778, 62, 93.7843],
  ['20:9 phone', 2.167, 58.6389, 101.182],
  ['folded cover', 2.56, 52.8999, 103.7228],
]

describe('softBand (D2)', () => {
  const { hLowKnee, hFloor, hHighKnee, hCeil } = PROJECTION_BAND
  const band = (x: number): number => softBand(x, hLowKnee, hFloor, hHighKnee, hCeil)

  it('is the identity between the knees, inclusive, and bit-for-bit so', () => {
    for (const x of [86, 87.3, 90, 93.784316, 94]) expect(band(x)).toBe(x)
  })

  it('eases onto the ceiling above the high knee, and the floor below the low one', () => {
    // 94 + 12*(1 - e^-1) and 86 - 16*(1 - e^-1): one span past the knee is one
    // e-folding, which is the whole shape of the map in one number each way.
    expect(band(hHighKnee + (hCeil - hHighKnee))).toBeCloseTo(101.585447, 5)
    expect(band(hLowKnee - (hLowKnee - hFloor))).toBeCloseTo(75.886071, 5)
  })

  it('never reaches either asymptote, and never leaves the band, over 1..400 degrees', () => {
    // Strictly inside, not merely inside: a clamp would sit exactly ON the bound, and
    // `toBeLessThanOrEqual` would wave it through.
    for (let x = 1; x <= 400; x += 0.25) {
      expect(band(x), `x=${x}`).toBeGreaterThan(hFloor)
      expect(band(x), `x=${x}`).toBeLessThan(hCeil)
    }
  })

  it('is strictly increasing across the knees and far into both tails', () => {
    let previous = Number.NEGATIVE_INFINITY
    for (let x = 1; x <= 400; x += 0.05) {
      const y = band(x)
      expect(y, `not increasing at x=${x}`).toBeGreaterThan(previous)
      previous = y
    }
  })

  it('is C1 at both knees — slope 1 on either side, so there is no visible crease', () => {
    const e = 1e-4
    expect((band(hHighKnee + e) - band(hHighKnee - e)) / (2 * e)).toBeCloseTo(1, 4)
    expect((band(hLowKnee + e) - band(hLowKnee - e)) / (2 * e)).toBeCloseTo(1, 4)
  })
})

describe('projectionFovDegrees (D2)', () => {
  it.each(D2_TABLE)('gives %s (aspect %f) the tabulated fov', (_name, aspect, vOut, hOut) => {
    const solved = projectionFovDegrees(P.fovDegrees, aspect)
    expect(solved).toBeCloseTo(vOut, 3)
    expect(horizontalFov(solved, aspect)).toBeCloseTo(hOut, 3)
  })

  it('leaves 16:9 and 16:10 bit-for-bit untouched, including the e2e viewport', () => {
    // Not `toBeCloseTo`: D2 pins the reference phone and the 1280x720 Playwright
    // viewport as EXACTLY unchanged, which is what makes every existing golden frame
    // and every existing camera assertion still mean what it meant. A tan/atan round
    // trip that returned 61.99999999999999 would satisfy a tolerance and break that
    // promise.
    expect(projectionFovDegrees(62, 1.778)).toBe(62)
    expect(projectionFovDegrees(62, 1.6)).toBe(62)
    expect(projectionFovDegrees(62, 1280 / 720)).toBe(62)
    expect(projectionFovDegrees(62, 800 / 400)).not.toBe(62) // the 2.0 fixture IS banded
  })

  it('still widens for the boost kick on every shape — the anti-clamp assertion', () => {
    // THE test that a hard ceiling fails. `fovDegrees + fovBoostDegrees` arrives here
    // already summed (updateCamera writes one number), so a clamp maps 62 and 70 onto
    // the same output on any wide screen and deletes the kick with camera.test's own
    // boost assertions still green, because those run upstream of this function.
    for (const [name, aspect] of D2_TABLE) {
      const base = projectionFovDegrees(P.fovDegrees, aspect)
      const boosted = projectionFovDegrees(P.fovDegrees + P.fovBoostDegrees, aspect)
      expect(boosted, `${name} lost the boost kick`).toBeGreaterThan(base)
    }
  })

  it('is strictly monotone in the authored fov, at every shape', () => {
    for (const [name, aspect] of D2_TABLE) {
      let previous = Number.NEGATIVE_INFINITY
      for (let fov = 40; fov <= 110; fov += 0.05) {
        const solved = projectionFovDegrees(fov, aspect)
        expect(solved, `${name} not increasing at fov=${fov}`).toBeGreaterThan(previous)
        previous = solved
      }
    }
  })

  it('always gives a wider screen a wider horizontal fov, across the whole range', () => {
    // The property D2 exists to guarantee, checked continuously rather than at the
    // eight tabulated points: between them a band could invert (a clamp plus a
    // rescale does exactly that) and every row above would still pass.
    let previous = Number.NEGATIVE_INFINITY
    for (let aspect = 0.3; aspect <= 3.5; aspect += 0.0025) {
      const h = horizontalFov(projectionFovDegrees(P.fovDegrees, aspect), aspect)
      expect(h, `horizontal fov fell at aspect=${aspect}`).toBeGreaterThan(previous)
      previous = h
    }
    // ...and it really did move: an implementation that returned a constant would pass
    // nothing above, but say so anyway.
    expect(previous).toBeGreaterThan(horizontalFov(projectionFovDegrees(P.fovDegrees, 0.3), 0.3))
  })

  it('keeps the returned vertical fov strictly inside the vertical band, 0.3 to 3.5', () => {
    // Sky headroom. The chase axis is pitched down only atan(3/15) = 11.31 degrees, so
    // half the vertical fov minus that is what is visible above the horizon; the floor
    // is what stops an ultra-wide screen from staring at tarmac.
    //
    // NOTE: D2's test sketch asks instead for the IMPLIED HORIZONTAL to stay inside
    // [hFloor, hCeil] over this range, and that claim is false for the composite —
    // by construction, since the same table demands 46 degrees of horizontal in
    // portrait, which is 24 below hFloor, and aspect 3.5 lands on 110.6, above hCeil.
    // It is the horizontal BAND that is bounded (asserted directly above); what the
    // composite bounds is the vertical it returns.
    for (let aspect = 0.3; aspect <= 3.5; aspect += 0.001) {
      const solved = projectionFovDegrees(P.fovDegrees, aspect)
      expect(solved, `aspect=${aspect}`).toBeGreaterThan(PROJECTION_BAND.vFloor)
      expect(solved, `aspect=${aspect}`).toBeLessThan(PROJECTION_BAND.vCeil)
    }
  })

  it('narrows the spread it exists to narrow', () => {
    // The claim in prose: 1.59x of landscape horizontal spread becomes 1.36x. Asserted
    // as an inequality on the ratio so it fails if the band is ever widened into
    // irrelevance or removed.
    const widest = horizontalFov(projectionFovDegrees(P.fovDegrees, 2.56), 2.56)
    const narrowest = horizontalFov(projectionFovDegrees(P.fovDegrees, 1.2), 1.2)
    expect(horizontalFov(P.fovDegrees, 2.56) / horizontalFov(P.fovDegrees, 1.2)).toBeCloseTo(
      1.59,
      2,
    )
    expect(widest / narrowest).toBeCloseTo(1.356, 2)
  })

  it('reaches the barrel, by identity', () => {
    expect(barrel.projectionFovDegrees).toBe(projectionFovDegrees)
    expect(barrel.softBand).toBe(softBand)
    expect(barrel.PROJECTION_BAND).toBe(PROJECTION_BAND)
  })

  it('freezes the policy constants at D2’s eight values', () => {
    expect(PROJECTION_BAND).toEqual({
      hLowKnee: 86,
      hFloor: 70,
      hHighKnee: 94,
      hCeil: 106,
      vLowKnee: 52,
      vFloor: 40,
      vHighKnee: 72,
      vCeil: 86,
    })
    expect(Object.isFrozen(PROJECTION_BAND)).toBe(true)
  })
})
