import type { Intent } from '@tapkart/sim'
import { clamp, lerp } from '@tapkart/sim'
import type { ControlAdapter, ControlInputs, Viewport } from './types'
import type { ControlConfig, Rect } from './config'
import {
  THUMBZONE_FULL_LOCK_FRACTION,
  brakeButtonRect,
  driftButtonRect,
  gasButtonRect,
  itemButtonRect,
  rectContains,
  steeringZoneRect,
} from './config'

/**
 * Virtual stick + pedals (spec §6: "most control, most screen occlusion").
 *
 * The stick is the left half, relative to touch-down, normalised exactly as
 * thumbZones is. The right half is a 2x2 pedal cluster - gas and drift on the
 * bottom row, brake and item above them - with dead space on both axes.
 *
 * This scheme has an explicit brake pedal, so Q21's drift long-press does NOT
 * apply: a long drift hold here is a drift and nothing else.
 */
export function makeVirtualStickAdapter(cfg: ControlConfig): ControlAdapter {
  const driftRect: Rect = { x: 0, y: 0, w: 0, h: 0 }
  const itemRect: Rect = { x: 0, y: 0, w: 0, h: 0 }
  const gasRect: Rect = { x: 0, y: 0, w: 0, h: 0 }
  const brakeRect: Rect = { x: 0, y: 0, w: 0, h: 0 }
  const steeringRect: Rect = { x: 0, y: 0, w: 0, h: 0 }

  let stickId = -1
  let gasId = -1
  let brakeId = -1
  let driftId = -1
  let itemId = -1
  let originX = 0
  let currentX = 0
  let steer = 0

  function steerAxis(v: Viewport): number {
    if (stickId === -1) return 0
    const lockPx = v.width * 0.5 * THUMBZONE_FULL_LOCK_FRACTION
    if (!(lockPx > 0)) return 0
    return clamp((currentX - originX) / lockPx, -1, 1)
  }

  return {
    scheme: 'virtualStick',

    sample(raw: ControlInputs, tick: number, out: Intent): void {
      driftButtonRect(raw.viewport, driftRect)
      itemButtonRect(raw.viewport, itemRect)
      gasButtonRect(raw.viewport, gasRect)
      brakeButtonRect(raw.viewport, brakeRect)
      steeringZoneRect(raw.viewport, steeringRect)

      let itemPulse = false

      for (let i = 0; i < raw.pointerCount; i++) {
        const p = raw.pointers[i]
        if (p.phase === 'down') {
          if (rectContains(driftRect, p.x, p.y)) {
            if (driftId === -1) driftId = p.id
          } else if (rectContains(itemRect, p.x, p.y)) {
            if (itemId === -1) {
              itemId = p.id
              itemPulse = true
            }
          } else if (rectContains(gasRect, p.x, p.y)) {
            if (gasId === -1) gasId = p.id
          } else if (rectContains(brakeRect, p.x, p.y)) {
            if (brakeId === -1) brakeId = p.id
          } else if (stickId === -1 && rectContains(steeringRect, p.x, p.y)) {
            stickId = p.id
            originX = p.x
            currentX = p.x
          }
        } else if (p.phase === 'move') {
          if (p.id === stickId) currentX = p.x
        } else {
          if (p.id === stickId) stickId = -1
          if (p.id === gasId) gasId = -1
          if (p.id === brakeId) brakeId = -1
          if (p.id === driftId) driftId = -1
          if (p.id === itemId) itemId = -1
        }
      }

      let axis = steerAxis(raw.viewport)
      if (Math.abs(axis) < cfg.deadZone) axis = 0
      const target = clamp(axis * cfg.steerGain, -1, 1)
      steer = clamp(lerp(steer, target, cfg.steerSmoothingPerTick), -1, 1)

      out.tick = tick
      out.steer = steer
      out.accel = gasId !== -1 ? 1 : 0
      out.brake = brakeId !== -1
      out.drift = driftId !== -1
      out.useItem = itemPulse
    },

    reset(): void {
      stickId = -1
      gasId = -1
      brakeId = -1
      driftId = -1
      itemId = -1
      originX = 0
      currentX = 0
      steer = 0
    },
  }
}
