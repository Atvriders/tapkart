import type { Intent } from '@tapkart/sim'
import type { ControlAdapter, ControlInputs } from './types'

/**
 * Q23's merge rule, in one place so no scheme invents its own:
 *
 *   steer   - the input of greater absolute magnitude wins; ties go to `keyboard`
 *   accel   - maximum
 *   brake   - logical OR
 *   drift   - logical OR
 *   useItem - logical OR
 *   tick    - the keyboard's, which is the same tick the composite passed to both
 *
 * NOT symmetric: on an equal-magnitude steer tie, `keyboard` wins. SOLE WRITER of
 * `out`, and it writes every field.
 */
export function mergeIntents(touch: Intent, keyboard: Intent, out: Intent): void {
  out.tick = keyboard.tick
  out.steer = Math.abs(keyboard.steer) >= Math.abs(touch.steer) ? keyboard.steer : touch.steer
  out.accel = touch.accel > keyboard.accel ? touch.accel : keyboard.accel
  out.brake = touch.brake || keyboard.brake
  out.drift = touch.drift || keyboard.drift
  out.useItem = touch.useItem || keyboard.useItem
}

/**
 * `primary`'s scheme, `primary`'s and `secondary`'s own scratch Intents, and
 * mergeIntents.
 *
 * The sole-writer rule for Intent (§7.2) is preserved BY CONSTRUCTION: the two
 * scratch Intents below are allocated once, here, and are the only Intents the
 * sub-adapters ever see. Only this adapter writes the one `game` submits.
 */
export function makeCompositeAdapter(primary: ControlAdapter,
                                     secondary: ControlAdapter): ControlAdapter {
  const primaryScratch: Intent = { tick: 0, steer: 0, accel: 0, brake: false, drift: false, useItem: false }
  const secondaryScratch: Intent = { tick: 0, steer: 0, accel: 0, brake: false, drift: false, useItem: false }

  return {
    scheme: primary.scheme,

    sample(raw: ControlInputs, tick: number, out: Intent): void {
      primary.sample(raw, tick, primaryScratch)
      secondary.sample(raw, tick, secondaryScratch)
      mergeIntents(primaryScratch, secondaryScratch, out)
      out.tick = tick
    },

    reset(): void {
      primary.reset()
      secondary.reset()
    },
  }
}
