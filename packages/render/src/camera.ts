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
