// The only wall clock in the repository, and the only TICK_MS import in the
// repository.
//
// TICK_MS is @tapkart/net's (Q6) and is never redefined. `render` cannot import
// it -- render does not depend on net, and that omission is load-bearing (§1) --
// so the tick/millisecond bridge lives on the only side that can hold it (§4.1).
// render names milliseconds-per-tick nowhere at all; its one tick-to-seconds
// conversion uses TICK_DT from @tapkart/sim, a different constant with a
// different name.
//
// The whole accumulator is net's too (amendment 4): packages/server runs the same
// fixed-step pump, and net may not import game, so the function moved -- and the
// TYPE moved with it, because leaving the type here would have left net importing
// it from game, which is the one arrow §1 forbids. Only the type is named here,
// by accumulatorAlpha; makeTickAccumulator, advanceAccumulator and
// MAX_CATCHUP_TICKS are imported straight from @tapkart/net by their callers.
import { TICK_MS } from '@tapkart/net'
import type { TickAccumulator } from '@tapkart/net'

export interface FrameClock {
  nowMs(): number
}

/**
 * performance.now() when available, Date.now() otherwise. The ONE impure binding
 * in `render` and `game` combined -- everything else takes a FrameClock, which
 * is what makes the camera, the accumulator and the view builder assertable
 * under environment: 'node' with no fake timers (Q30).
 */
export const realFrameClock: FrameClock = {
  nowMs(): number {
    return typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now()
  },
}

/** Deterministic clock for tests: starts at `startMs` (default 0), moves only on
 *  advance(). Its time is per-instance, never module scope. */
export function makeFixedClock(startMs = 0): FrameClock & { advance(ms: number): void } {
  let nowMs = startMs
  return {
    nowMs(): number {
      return nowMs
    },
    advance(ms: number): void {
      nowMs += ms
    },
  }
}

/** Sub-tick fraction in [0, 1) for the frame that follows the ticks just run.
 *  §6.2: it is used for exactly three things -- camera sub-tick blending, Q9's
 *  lerp of state-sourced seats and entities, and renderNowMs. */
export function accumulatorAlpha(acc: TickAccumulator): number {
  return acc.residualMs / TICK_MS
}

/**
 * The tick-derived instant a frame represents: (tick + alpha) * TICK_MS.
 *
 * This is the ONLY value that may ever be passed as `nowMs` to
 * RemoteInterpolator.sampleKart / sampleEntity, because ClientLoop stamps every
 * keyframe `recvAtMs: tick * TICK_MS` -- so the interpolator's notion of "now" is
 * SIM time, not performance.now(). Pass a wall clock instead and the target
 * instant is thousands of milliseconds past the newest keyframe on the very first
 * frame: every remote kart takes the extrapolation branch, clamps at
 * REMOTE_EXTRAPOLATE_CAP_MS and slides along its last velocity forever. Nothing
 * throws and nothing logs.
 *
 * §6.3 removes the caller's opportunity rather than documenting the rule:
 * `nowMs` is not a parameter of anything in game's public surface, and
 * ViewBuilder.build(alpha, out) computes this internally.
 */
export function renderNowMs(tick: number, alpha: number): number {
  return (tick + alpha) * TICK_MS
}
