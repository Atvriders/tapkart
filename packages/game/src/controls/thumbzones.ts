import type { Intent } from '@tapkart/sim'
import { DRIFT_STEER_MIN, clamp, lerp } from '@tapkart/sim'
import type { ControlAdapter, ControlInputs } from './types'
import type { ControlConfig, ControlMetrics, Rect } from './config'
import { BRAKE_HOLD_TICKS, controlMetrics, createControlMetrics, driftButtonRect, itemButtonRect, rectContains, steeringZoneRect } from './config'

/**
 * Auto-accelerate + thumb zones (spec §6, the default scheme).
 *
 * Steering is RELATIVE to the touch-down origin (Q24): full lock at
 * THUMBZONE_FULL_LOCK_FRACTION of the half-width away from where the thumb landed.
 * Absolute steering would jerk the kart to full lock the instant a thumb landed
 * anywhere but the exact screen centre.
 *
 * The right half holds two 88 px buttons with 16 px of dead space between them. A
 * touch landing in that gap belongs to NEITHER button, and a touch that starts on a
 * control keeps that control for its whole life, even if it slides out.
 *
 * `accel` is always 1, including under motion lock (Q21): `sim` ignores input while
 * `motionLocked`, so the adapter has no reason to lie about what the player is
 * doing, and the HUD reads `motionLocked` rather than `accel`.
 */
export function makeThumbZonesAdapter(cfg: ControlConfig): ControlAdapter {
  // Scratch, allocated once. Nothing below allocates per tick.
  const driftRect: Rect = { x: 0, y: 0, w: 0, h: 0 }
  const itemRect: Rect = { x: 0, y: 0, w: 0, h: 0 }
  const steeringRect: Rect = { x: 0, y: 0, w: 0, h: 0 }
  const metrics: ControlMetrics = createControlMetrics()

  let steerId = -1
  let driftId = -1
  let itemId = -1
  let originX = 0
  let currentX = 0
  let driftHeldTicks = 0
  let steer = 0

  function steerAxis(m: ControlMetrics): number {
    if (steerId === -1) return 0
    const lockPx = m.fullLockPx
    if (!(lockPx > 0)) return 0 // pre-measure frame: no viewport, no steering, no NaN
    return clamp((currentX - originX) / lockPx, -1, 1)
  }

  return {
    scheme: 'thumbZones',

    sample(raw: ControlInputs, tick: number, out: Intent): void {
      controlMetrics(raw.viewport, raw.insets, metrics)
      driftButtonRect(raw.viewport, metrics, driftRect)
      itemButtonRect(raw.viewport, metrics, itemRect)
      steeringZoneRect(raw.viewport, metrics, raw.insets, steeringRect)

      let itemPulse = false

      for (let i = 0; i < raw.pointerCount; i++) {
        const p = raw.pointers[i]
        if (p.phase === 'down') {
          if (rectContains(driftRect, p.x, p.y)) {
            if (driftId === -1) driftId = p.id
          } else if (rectContains(itemRect, p.x, p.y)) {
            if (itemId === -1) {
              itemId = p.id
              itemPulse = true // Q25: one-tick pulse on the press edge
            }
          } else if (steerId === -1 && rectContains(steeringRect, p.x, p.y)) {
            steerId = p.id
            originX = p.x
            currentX = p.x
          }
          // Anything else - the inter-button gap, the right half outside a button -
          // belongs to nothing. Dead space is the correct answer (Q24).
        } else if (p.phase === 'move') {
          // A move never re-routes a touch: only the steering thumb reads position.
          if (p.id === steerId) currentX = p.x
        } else {
          if (p.id === steerId) steerId = -1
          if (p.id === driftId) driftId = -1
          if (p.id === itemId) itemId = -1
        }
      }

      let axis = steerAxis(metrics)
      if (Math.abs(axis) < cfg.deadZone) axis = 0
      const target = clamp(axis * cfg.steerGain, -1, 1)
      steer = clamp(lerp(steer, target, cfg.steerSmoothingPerTick), -1, 1)

      const drift = driftId !== -1
      driftHeldTicks = drift ? driftHeldTicks + 1 : 0

      out.tick = tick
      out.steer = steer
      out.accel = 1
      // Q21: a long press brakes only when the thumb is straight. `updateDrift`
      // engages a drift at |steer| >= DRIFT_STEER_MIN, so the same constant - sim's
      // own, imported - is what separates "held while turning" from "held straight".
      out.brake = driftHeldTicks >= BRAKE_HOLD_TICKS && Math.abs(steer) < DRIFT_STEER_MIN
      out.drift = drift
      out.useItem = itemPulse
    },

    reset(): void {
      steerId = -1
      driftId = -1
      itemId = -1
      originX = 0
      currentX = 0
      driftHeldTicks = 0
      steer = 0
    },
  }
}
