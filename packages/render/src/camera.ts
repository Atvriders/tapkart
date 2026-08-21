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

// ---------------------------------------------------------------------------------
// Projection policy (D2). `PerspectiveCamera.fov` is VERTICAL, so holding it fixed is
// Hor+: the horizontal field of view runs free with the viewport's aspect. Across the
// shapes this game actually ships on that is a 3.7x spread — 31 degrees of horizontal
// on a portrait phone against 114 on a folded cover screen — and since `bolt` reflects
// off track edges and `seeker` homes, how much road is off-axis is competitive
// information, not taste.
//
// The band is SOFT, and that is not a stylistic preference. The boost kick is
// `fovBoostDegrees` ADDED to the base and arrives here already summed, so a hard
// ceiling would map the base and the boosted value onto the same number on any wide
// screen — deleting the kick outright while every existing camera test stayed green,
// because they all assert `cam.fovDegrees` upstream of this function. A strictly
// increasing map cannot do that: distinct inputs stay distinct, forever.
// ---------------------------------------------------------------------------------

const DEG_TO_RAD = Math.PI / 180
const RAD_TO_DEG = 180 / Math.PI

/**
 * The knees and asymptotes of the two soft bands, in degrees. POLICY, not physics
 * (D2 §13): 16:9 and 16:10 sit inside the horizontal band on purpose, so the reference
 * phone and the 1280x720 e2e viewport are left bit-for-bit alone, and every other shape
 * is eased toward them. `*Floor`/`*Ceil` are asymptotes the band approaches and never
 * reaches, `*LowKnee`/`*HighKnee` are where it stops being the identity.
 */
export const PROJECTION_BAND = Object.freeze({
  hLowKnee: 86,
  hFloor: 70,
  hHighKnee: 94,
  hCeil: 106,
  vLowKnee: 52,
  vFloor: 40,
  vHighKnee: 72,
  vCeil: 86,
})

/**
 * `x` unchanged on `[lowKnee, highKnee]`; outside it, an exponential ease that
 * approaches `ceil` (or `floor`) without ever arriving. C1 at both knees — the
 * exponential's derivative there is exactly 1, which is the identity's — and STRICTLY
 * increasing on the whole real line, so no two inputs can collide on one output.
 *
 * Exported because that last property is the entire point of the design and has to be
 * assertable on the primitive itself: the composite below is bounded through two of
 * these plus a pair of tangent round trips, which hides which half is doing the work.
 */
export function softBand(
  x: number,
  lowKnee: number,
  floor: number,
  highKnee: number,
  ceil: number,
): number {
  if (x > highKnee) {
    const span = ceil - highKnee
    return highKnee + span * (1 - Math.exp(-(x - highKnee) / span))
  }
  if (x < lowKnee) {
    const span = lowKnee - floor
    return lowKnee - span * (1 - Math.exp(-(lowKnee - x) / span))
  }
  return x
}

/**
 * The vertical fov to hand the projection, given the authored vertical fov (base plus
 * boost, already summed by `updateCamera`) and the viewport aspect.
 *
 * Vertical in, vertical out: the chase camera is pitched down only atan(3/15) = 11.3
 * degrees, so vertical fov is mostly sky headroom, while browser fullscreen (which
 * changes viewport HEIGHT, not width) would make a fixed-horizontal regime jump the
 * visible road ahead on every toggle.
 *
 * Strictly monotone in `verticalFovDegrees` at fixed `aspect`, and the horizontal it
 * implies is strictly monotone in `aspect` at fixed `verticalFovDegrees`. Both are
 * load-bearing: the first keeps the boost kick, the second keeps "a wider screen shows
 * more" true.
 */
export function projectionFovDegrees(verticalFovDegrees: number, aspect: number): number {
  const naturalH =
    2 * Math.atan(aspect * Math.tan(verticalFovDegrees * DEG_TO_RAD * 0.5)) * RAD_TO_DEG
  const bandedH = softBand(
    naturalH,
    PROJECTION_BAND.hLowKnee,
    PROJECTION_BAND.hFloor,
    PROJECTION_BAND.hHighKnee,
    PROJECTION_BAND.hCeil,
  )
  // The tangent round trip is not exact in binary floating point, so an unconditional
  // `naturalH -> bandedH -> vertical` would return 61.99999999999999 for a shape the
  // band did not touch at all. Inside the band the answer IS the input, so say so.
  const impliedV =
    bandedH === naturalH
      ? verticalFovDegrees
      : 2 * Math.atan(Math.tan(bandedH * DEG_TO_RAD * 0.5) / aspect) * RAD_TO_DEG
  return softBand(
    impliedV,
    PROJECTION_BAND.vLowKnee,
    PROJECTION_BAND.vFloor,
    PROJECTION_BAND.vHighKnee,
    PROJECTION_BAND.vCeil,
  )
}
