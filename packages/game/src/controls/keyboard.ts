import type { Intent } from '@tapkart/sim'
import { clamp, lerp } from '@tapkart/sim'
import type { ControlAdapter, ControlInputs } from './types'
import type { ControlConfig } from './config'

/**
 * Keyboard, merged into every scheme by makeCompositeAdapter (Q23). Spec §6 says
 * keyboard is *always* available on desktop, and "always" is not "instead of".
 *
 * `scheme` is 'thumbZones' because this adapter is never the one the player
 * selected: the composite reports its PRIMARY's scheme, and this adapter is always
 * the secondary. On a phone no key is ever down and every field below is inert.
 *
 * The binding table is inverted ONCE, at construction, into six code lists - the
 * per-tick path must not call Object.keys (§7.3: no allocation per tick).
 */
export function makeKeyboardAdapter(cfg: ControlConfig): ControlAdapter {
  const left: string[] = []
  const right: string[] = []
  const accel: string[] = []
  const brake: string[] = []
  const drift: string[] = []
  const item: string[] = []

  for (const code of Object.keys(cfg.keyBindings)) {
    switch (cfg.keyBindings[code]) {
      case 'left': left.push(code); break
      case 'right': right.push(code); break
      case 'accel': accel.push(code); break
      case 'brake': brake.push(code); break
      case 'drift': drift.push(code); break
      case 'item': item.push(code); break
    }
  }

  function anyDown(raw: ControlInputs, codes: string[]): boolean {
    for (let i = 0; i < codes.length; i++) {
      if (raw.keys[codes[i]] === true) return true
    }
    return false
  }

  let steer = 0
  let itemHeld = false

  return {
    scheme: 'thumbZones',

    sample(raw: ControlInputs, tick: number, out: Intent): void {
      const leftDown = anyDown(raw, left)
      const rightDown = anyDown(raw, right)
      const itemDown = anyDown(raw, item)

      let axis = (rightDown ? 1 : 0) - (leftDown ? 1 : 0)
      if (Math.abs(axis) < cfg.deadZone) axis = 0
      const target = clamp(axis * cfg.steerGain, -1, 1)
      steer = clamp(lerp(steer, target, cfg.steerSmoothingPerTick), -1, 1)

      out.tick = tick
      out.steer = steer
      out.accel = anyDown(raw, accel) ? 1 : 0
      out.brake = anyDown(raw, brake)
      out.drift = anyDown(raw, drift)
      out.useItem = itemDown && !itemHeld // Q25: the press edge, not the level
      itemHeld = itemDown
    },

    reset(): void {
      steer = 0
      itemHeld = false
    },
  }
}
