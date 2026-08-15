import type { ControlAdapter, ControlScheme } from './types'
import type { ControlConfig } from './config'
import { makeThumbZonesAdapter } from './thumbzones'
import { makeTiltAdapter } from './tilt'
import { makeVirtualStickAdapter } from './stick'
import { makeKeyboardAdapter } from './keyboard'
import { makeCompositeAdapter } from './composite'

/**
 * THE public entry point. Builds the scheme's touch adapter, a keyboard adapter,
 * and returns the composite of the two - always, on every platform. Spec §6 says
 * keyboard is *always* available on desktop, and "always" is not "instead of"; on a
 * phone no key is ever down, so the merge is a no-op.
 */
export function makeControlAdapter(scheme: ControlScheme, cfg: ControlConfig): ControlAdapter {
  return makeCompositeAdapter(makeTouchAdapter(scheme, cfg), makeKeyboardAdapter(cfg))
}

/** Exhaustive over ControlScheme: a fourth scheme added to the union without a
 *  case here is a compile error ("not all code paths return a value"), which is
 *  the whole reason this is a switch with returns rather than a default branch. */
function makeTouchAdapter(scheme: ControlScheme, cfg: ControlConfig): ControlAdapter {
  switch (scheme) {
    case 'thumbZones': return makeThumbZonesAdapter(cfg)
    case 'tilt': return makeTiltAdapter(cfg)
    case 'virtualStick': return makeVirtualStickAdapter(cfg)
  }
}
