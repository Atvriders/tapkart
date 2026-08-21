// TYPE-ONLY import of TiltCalibration, deliberately: tilt.ts imports this module's
// VALUES (the button rects, BRAKE_HOLD_TICKS), and a value import back would make a
// runtime ESM cycle whose symptom is a temporal-dead-zone ReferenceError at import
// time. `import type` is erased under verbatimModuleSyntax, so this edge is free.
// The cost is one duplicated zero literal below, and controls-tilt.test.ts asserts
// it equals IDENTITY_TILT_CALIBRATION.
import type { TiltCalibration } from './tilt'
import type { Intent } from '@tapkart/sim'
import type { Insets, Viewport } from './types'

export interface ControlConfig {
  deadZone: number // 0..1 of the full-lock distance, below which steer is 0
  steerGain: number // multiplies the normalised steer axis before clamping
  steerSmoothingPerTick: number // 0..1 lerp toward the raw axis, once per sample()
  tiltNeutralDegrees: number
  tiltRangeDegrees: number // degrees from neutral to full lock
  tiltCalibration: TiltCalibration
  invertTilt: boolean
  keyBindings: Record<string, 'left' | 'right' | 'accel' | 'brake' | 'drift' | 'item'>
}

export const DEFAULT_CONTROL_CONFIG: Readonly<ControlConfig> = {
  deadZone: 0.06,
  steerGain: 1,
  steerSmoothingPerTick: 0.35,
  tiltNeutralDegrees: 0,
  tiltRangeDegrees: 25,
  tiltCalibration: { betaZero: 0, gammaZero: 0 }, // === IDENTITY_TILT_CALIBRATION
  invertTilt: false,
  keyBindings: {
    ArrowLeft: 'left',
    KeyA: 'left',
    ArrowRight: 'right',
    KeyD: 'right',
    ArrowUp: 'accel',
    KeyW: 'accel',
    ArrowDown: 'brake',
    KeyS: 'brake',
    ShiftLeft: 'drift',
    Space: 'drift',
    KeyE: 'item',
    ControlLeft: 'item',
  },
}

// Q24's ORIGINAL layout, in CSS px. These are no longer read by the adapters --
// `controlMetrics` derives every dimension from the measured viewport instead --
// but they remain the reference the derivation reproduces exactly at 800 x 400,
// which is what lets the pre-existing adapter tests keep their literal touch
// coordinates. Treat them as the calibration point, not as live layout.
export const TOUCH_BUTTON_SIZE_PX = 88
export const TOUCH_BUTTON_MARGIN_PX = 16
export const TOUCH_BUTTON_GAP_PX = 16

/** Full lock at 28 % of the steering surface, measured from the touch-down origin. */
export const THUMBZONE_FULL_LOCK_FRACTION = 0.28

/** Q21's brake: ticks the drift button must be held before it also brakes. */
export const BRAKE_HOLD_TICKS = 18 // 0.3 s at 60 Hz

export interface Rect { x: number; y: number; w: number; h: number } // CSS px, y down

export type LayoutOrientation = 'landscape' | 'portrait'

/**
 * Every dimension the touch layout needs, derived from one viewport measurement.
 *
 * This exists because the layout used to be five fixed pixel constants, which
 * has no meaning on the screens this game is expected to run on: 88 px is a
 * third of a folded cover screen's height and a thumbprint on a tablet, and a
 * corner-pinned cluster on a 1366 px-wide slate is nowhere near a thumb.
 */
export interface ControlMetrics {
  orientation: LayoutOrientation
  buttonPx: number
  gapPx: number
  /** Inset from the safe edge, BEFORE the safe-area inset is added. */
  insetPx: number
  /** x of the cluster's right edge, safe-area applied. */
  rightEdgePx: number
  /** y of the cluster's bottom edge, safe-area applied. */
  bottomEdgePx: number
  /** Height of the steering surface. */
  steerBandPx: number
  /** x of the steering surface's right edge. Derived ONCE, here. */
  steerRightPx: number
  /** Thumb travel from touch-down to full lock. */
  fullLockPx: number
  /** False when the viewport is too small to lay out at all. */
  fits: boolean
}

/** Allocates one ControlMetrics. Call once; `controlMetrics` rewrites it in place. */
export function createControlMetrics(): ControlMetrics {
  return {
    orientation: 'landscape',
    buttonPx: 0,
    gapPx: 0,
    insetPx: 0,
    rightEdgePx: 0,
    bottomEdgePx: 0,
    steerBandPx: 0,
    steerRightPx: 0,
    fullLockPx: 0,
    fits: false,
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

/**
 * SOLE WRITER of `out`; writes every field. Allocation-free, safe per frame.
 *
 * Two structural choices are load-bearing rather than cosmetic:
 *
 * `clusterLeft` reserves TWO button columns unconditionally, even for the schemes
 * that only draw one. That makes the steering surface scheme-independent, so
 * switching from thumb-zones to virtual-stick mid-race cannot move the steering
 * boundary out from under a thumb already resting on it.
 *
 * `steerRight` is `min(half the width, clusterLeft - gap)` rather than plain half.
 * Half alone overlaps the pedal cluster on anything narrower than about 416 px --
 * and because `virtualStick` tests its pedal rects BEFORE the steering rect, the
 * overlap silently swallows steering instead of producing a visible conflict.
 */
export function controlMetrics(v: Viewport, insets: Insets, out: ControlMetrics): void {
  const shortEdge = Math.min(v.width, v.height)
  out.orientation = v.height > v.width ? 'portrait' : 'landscape'
  out.buttonPx = clamp(Math.round(shortEdge * 0.22), 64, 128)
  out.gapPx = Math.max(8, Math.round(out.buttonPx / 5.5))
  out.insetPx = Math.max(out.gapPx, Math.min(56, Math.round(shortEdge * 0.04)))
  out.rightEdgePx = v.width - insets.right - out.insetPx
  out.bottomEdgePx = v.height - insets.bottom - out.insetPx

  const clusterLeft = out.rightEdgePx - 2 * out.buttonPx - out.gapPx
  out.steerRightPx = Math.min(Math.round(v.width * 0.5), clusterLeft - out.gapPx)
  const stackPx = 2 * out.buttonPx + out.gapPx + 2 * out.insetPx

  out.steerBandPx =
    out.orientation === 'landscape'
      ? v.height - insets.top - insets.bottom
      : Math.max(stackPx, Math.round(v.height * 0.3))

  out.fullLockPx = Math.round(clamp((out.steerRightPx - insets.left) * THUMBZONE_FULL_LOCK_FRACTION, 88, 168))
  out.fits = v.height - insets.top - insets.bottom >= stackPx && out.steerRightPx - insets.left >= out.buttonPx
}

/** The touch-down steering surface for the two schemes that steer with a thumb.
 * The race overlay uses this same helper for its guidance, so the visible
 * boundary and the adapter boundary cannot drift.
 *
 * In portrait it is a band across the BOTTOM rather than the whole left side:
 * a full-height left half on a 390 x 844 phone puts steering under the player's
 * palm and 500 px above the thumb that has to reach it. */
export function steeringZoneRect(v: Viewport, m: ControlMetrics, insets: Insets, out: Rect): void {
  out.x = insets.left
  out.y = m.orientation === 'landscape' ? insets.top : v.height - insets.bottom - m.steerBandPx
  out.w = m.steerRightPx - insets.left
  out.h = m.steerBandPx
}

/** Bottom-right of the safe area, inset by the derived margin. */
export function driftButtonRect(v: Viewport, m: ControlMetrics, out: Rect): void {
  void v
  out.x = m.rightEdgePx - m.buttonPx
  out.y = m.bottomEdgePx - m.buttonPx
  out.w = m.buttonPx
  out.h = m.buttonPx
}

/** Directly above the drift button, one derived gap of dead space between. */
export function itemButtonRect(v: Viewport, m: ControlMetrics, out: Rect): void {
  driftButtonRect(v, m, out)
  out.y -= m.gapPx + m.buttonPx
}

/** Virtual-stick gas pedal: one shared-control column to the left of drift. */
export function gasButtonRect(v: Viewport, m: ControlMetrics, out: Rect): void {
  driftButtonRect(v, m, out)
  out.x -= m.gapPx + m.buttonPx
}

/** Virtual-stick brake pedal: one shared-control column to the left of item. */
export function brakeButtonRect(v: Viewport, m: ControlMetrics, out: Rect): void {
  itemButtonRect(v, m, out)
  out.x -= m.gapPx + m.buttonPx
}

/**
 * Coasting: no steering, no throttle, nothing held. SOLE WRITER of `out`; writes
 * every field including `out.tick`, exactly as a ControlAdapter's sample() does.
 *
 * Used when the viewport is too small to lay controls out. The simulation still
 * ticks -- lockstep with the other peers depends on it -- but it ticks on an
 * intent no stale latch can contribute to.
 */
export function neutralIntent(tick: number, out: Intent): void {
  out.tick = tick
  out.steer = 0
  out.accel = 0
  out.brake = false
  out.drift = false
  out.useItem = false
}

/** Half-open on the far edges: x in [r.x, r.x + r.w), y in [r.y, r.y + r.h). */
export function rectContains(r: Rect, x: number, y: number): boolean {
  return x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h
}
