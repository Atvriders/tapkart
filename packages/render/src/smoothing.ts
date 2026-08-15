// Error smoothing for the corrections a guest's ClientLoop applies to the local
// kart (R41, R47, R48). Pure: no clock, no DOM, no allocation, no randomness.
//
// The netcode corrects the local kart about three times a second under changing
// input -- which is all real driving -- because the authority applies the newest
// intent it has RECEIVED at its own tick rather than buffering by stamped tick
// (spec §5). The controller ruled that Tapkart keeps immediate application, so
// that a touchscreen racer pays no input latency, and absorbs the corrections
// here instead. Without this module the trade is just "the kart jumps three
// times a second".
//
// The offset produced here is render-only. ViewBuilder adds it to KartView
// position and heading (§5.11 step 11a) and to nothing else: it is never written
// into a SimState, never applied to a remote seat -- those are interpolated and
// have no corrections to hide -- and never applied on host or solo, which never
// reconcile.
import { clamp, wrapAngle } from '@tapkart/sim'
import type { Vec3 } from '@tapkart/sim'

/**
 * The retained visual error for ONE seat: metres for position, radians for
 * heading. `current`/`currentHeading` are what the view adds to the drawn pose;
 * `origin`/`originHeading` are the offset at the instant of the most recent
 * correction, which is what the ease decays from.
 *
 * Both channels are smoothed, on ONE window and ONE curve -- two smoothing rates
 * on one object is how a kart ends up visually cornering out of phase with
 * itself.
 */
export interface VisualOffset {
  origin: Vec3
  originHeading: number       // radians
  ticksSince: number          // ticks since the most recent correction
  current: Vec3               // the eased offset to ADD to the drawn position
  currentHeading: number      // radians, ADDED to the drawn heading
}

/** Allocated ONCE per session, by createViewBuilder (§5.11). */
export function createVisualOffset(): VisualOffset {
  return {
    origin: { x: 0, y: 0, z: 0 },
    originHeading: 0,
    ticksSince: 0,
    current: { x: 0, y: 0, z: 0 },
    currentHeading: 0,
  }
}

/**
 * 0.2 s at 60 Hz. Long enough to hide 5 cm completely, short enough that a wrong
 * prediction is not still on screen when the next one lands (~3/s).
 */
export const ERROR_SMOOTH_WINDOW_TICKS = 12

/**
 * Beyond this the offset is ZEROED rather than eased: a hard resync
 * (ClientLoop.hardResync) can move a kart tens of metres, and sliding it there
 * smoothly is worse than a cut.
 */
export const ERROR_SMOOTH_MAX_POSITION_M = 2.5

/**
 * The yaw analogue of the position cut, and it is derived rather than picked.
 * Easing an offset of `x` radians over the window has a peak apparent yaw rate
 * at t = 0 of `3x / (ERROR_SMOOTH_WINDOW_TICKS * TICK_DT)` = `15x` rad/s (the
 * derivative of the cubic). The player reads any yaw the car produces on its own
 * as steering, so the smoothing must stay under the car's own maximum steering
 * rate, `TUNING.steerRateBase = 2.6` rad/s: 15 x 0.15 = 2.25 rad/s, comfortably
 * under, and 0.15 rad is 8.6 degrees -- larger than any correction that is not a
 * resync. Past it, cut.
 *
 * packages/render/test/smoothing.test.ts asserts the 2.25 < 2.6 bound against
 * the shipped constants rather than trusting this comment.
 */
export const ERROR_SMOOTH_MAX_HEADING_RAD = 0.15

/**
 * The fraction of the offset still applied `t01` of the way through the window:
 * `(1 - clamp(t01, 0, 1)) ** 3` -- ease-out cubic, zero slope at the end, so the
 * kart settles rather than arriving.
 */
export function easeRemaining(t01: number): number {
  const remaining = 1 - clamp(t01, 0, 1)
  return remaining * remaining * remaining
}

/**
 * (previous offset, correction delta, ticks elapsed) -> new offset. `out` MAY
 * alias `prev`, and in the shipped call it always does.
 *
 * `correctionHeading` is passed through UNCHANGED from `correctionDeltaOf` via
 * `RaceSession.correctionDelta` (§5.10): `null` means no reconciliation happened
 * this tick, and `0` means one happened and moved the heading by exactly zero.
 * Those are different, and the difference is carried from its source rather than
 * reconstructed here -- which is why there is no separate `corrected` flag.
 * `correctionPos` is ignored when `correctionHeading` is null.
 *
 * Deterministic and frame-rate independent: `ticksElapsed` is SIM TICKS, never
 * frames. Called once per tick per smoothed seat, from ViewBuilder (§5.11).
 */
export function advanceVisualOffset(
  prev: VisualOffset,
  correctionPos: Vec3,
  correctionHeading: number | null,
  ticksElapsed: number,
  out: VisualOffset,
): void {
  // Read every field of `prev` before writing anything: `out` may alias `prev`.
  const prevX = prev.current.x
  const prevY = prev.current.y
  const prevZ = prev.current.z
  const prevHeading = prev.currentHeading

  let originX: number
  let originY: number
  let originZ: number
  let originHeading: number
  let ticksSince: number

  if (correctionHeading !== null) {
    // A reconciliation landed this tick. The error the player can still see is
    // whatever had not eased away yet, plus the discontinuity just applied.
    originX = prevX + correctionPos.x
    originY = prevY + correctionPos.y
    originZ = prevZ + correctionPos.z
    originHeading = wrapAngle(prevHeading + correctionHeading)
    ticksSince = 0
  } else {
    originX = prev.origin.x
    originY = prev.origin.y
    originZ = prev.origin.z
    originHeading = prev.originHeading
    ticksSince = prev.ticksSince + ticksElapsed
  }

  // Either guard cuts BOTH channels: easing half a resync is worse than cutting
  // all of it.
  if (
    Math.hypot(originX, originY, originZ) > ERROR_SMOOTH_MAX_POSITION_M
    || Math.abs(originHeading) > ERROR_SMOOTH_MAX_HEADING_RAD
  ) {
    out.origin.x = 0
    out.origin.y = 0
    out.origin.z = 0
    out.originHeading = 0
    out.ticksSince = 0
    out.current.x = 0
    out.current.y = 0
    out.current.z = 0
    out.currentHeading = 0
    return
  }

  // ONE eased fraction from ONE ticksSince, so the two channels can never fall
  // out of phase.
  const f = easeRemaining(ticksSince / ERROR_SMOOTH_WINDOW_TICKS)

  out.origin.x = originX
  out.origin.y = originY
  out.origin.z = originZ
  out.originHeading = originHeading
  out.ticksSince = ticksSince
  out.current.x = originX * f
  out.current.y = originY * f
  out.current.z = originZ * f
  out.currentHeading = originHeading * f
}
