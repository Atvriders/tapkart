// TYPE-ONLY import of TiltCalibration, deliberately: tilt.ts imports this module's
// VALUES (the button rects, BRAKE_HOLD_TICKS), and a value import back would make a
// runtime ESM cycle whose symptom is a temporal-dead-zone ReferenceError at import
// time. `import type` is erased under verbatimModuleSyntax, so this edge is free.
// The cost is one duplicated zero literal below, and controls-tilt.test.ts asserts
// it equals IDENTITY_TILT_CALIBRATION.
import type { TiltCalibration } from './tilt'
import type { Viewport } from './types'

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

// Q24's layout, in CSS px, shared by thumbZones and tilt so their buttons cannot
// disagree by a pixel. virtualStick reuses both rects and places its gas and brake
// buttons one column to the left of them, from these same constants.
export const TOUCH_BUTTON_SIZE_PX = 88
export const TOUCH_BUTTON_MARGIN_PX = 16
export const TOUCH_BUTTON_GAP_PX = 16

/** Full lock at 28 % of the half-width, measured from the touch-down origin. */
export const THUMBZONE_FULL_LOCK_FRACTION = 0.28

/** Q21's brake: ticks the drift button must be held before it also brakes. */
export const BRAKE_HOLD_TICKS = 18 // 0.3 s at 60 Hz

export interface Rect { x: number; y: number; w: number; h: number } // CSS px, y down

/** Bottom-right, TOUCH_BUTTON_MARGIN_PX from both edges. */
export function driftButtonRect(v: Viewport, out: Rect): void {
  out.x = v.width - TOUCH_BUTTON_MARGIN_PX - TOUCH_BUTTON_SIZE_PX
  out.y = v.height - TOUCH_BUTTON_MARGIN_PX - TOUCH_BUTTON_SIZE_PX
  out.w = TOUCH_BUTTON_SIZE_PX
  out.h = TOUCH_BUTTON_SIZE_PX
}

/** Directly above the drift button, TOUCH_BUTTON_GAP_PX of dead space between. */
export function itemButtonRect(v: Viewport, out: Rect): void {
  driftButtonRect(v, out)
  out.y -= TOUCH_BUTTON_GAP_PX + TOUCH_BUTTON_SIZE_PX
}

/** Half-open on the far edges: x in [r.x, r.x + r.w), y in [r.y, r.y + r.h). */
export function rectContains(r: Rect, x: number, y: number): boolean {
  return x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h
}
