import { TICK_HZ } from '@tapkart/sim'

/**
 * Milliseconds per sim tick at the fixed 60Hz rate (TICK_HZ, @tapkart/sim).
 *
 * EXPORTED, and defined exactly once, because it is half of two separate
 * contracts. It is RemoteInterpolator's: every `nowMs` handed to
 * sampleKart/sampleEntity has to be on the same timebase as the `recvAtMs`
 * ClientLoop stamps its keyframes with, and a renderer in a later package that
 * redefines this number itself and gets it wrong pins every remote kart at the
 * extrapolation cap forever - visible on screen, invisible to every test in this
 * package (ruling P2-R43). And it is `advanceAccumulator`'s below.
 *
 * It lives in this file rather than in client.ts (where it was first defined)
 * because a clock constant belongs beside the clock, and because the accumulator
 * below is imported by packages that have no reason to load a prediction loop.
 * client.ts imports it from here; the package barrel still exports it, so
 * nothing downstream changes.
 */
export const TICK_MS = 1000 / TICK_HZ

/**
 * The most ticks any single `advanceAccumulator` call will emit.
 *
 * 5 ticks is 83ms of simulation per call - about five times an ordinary 60Hz
 * frame's worth, so a normal hitch is absorbed completely, and small enough that
 * the catch-up itself cannot cost more than the frame it is catching up to. That
 * bound is the point: without it a long stall asks for 60+ ticks, which takes
 * longer than a frame to run, which produces a longer stall, which asks for more
 * ticks. The spiral is a named risk (spec §11: a host phone that cannot sustain
 * the authority loop plus a 3D render).
 *
 * ONE home, in @tapkart/net, because Plan 3's game clock and Plan 4's server
 * ticker are the same function with the same constant and `server` may not
 * import `game`. Both import `net`. Two definitions of a catch-up constant do
 * not stay equal, and when they diverge the host and the server run the same
 * race at two different speeds under load.
 */
export const MAX_CATCHUP_TICKS = 5

/**
 * Unspent wall time, in milliseconds, carried from one `advanceAccumulator` call
 * to the next. Caller-owned and mutated in place: a scheduler holds exactly one
 * of these for the lifetime of its loop, so nothing allocates per frame.
 */
export interface TickAccumulator {
  residualMs: number
}

export function makeTickAccumulator(): TickAccumulator {
  return { residualMs: 0 }
}

/**
 * Converts `elapsedMs` of wall time into a whole number of 60Hz sim ticks to
 * run, carrying the sub-tick remainder in `acc` so no time is lost between
 * calls. Returns the tick count; the caller runs that many `tick()`s.
 *
 * Two rules, and the second one breaks the first on purpose:
 *
 *   1. TIME IS CONSERVED. `ticks * TICK_MS + acc.residualMs` equals the total
 *      elapsed handed in, exactly, across any number of calls. This is the
 *      property worth testing - a tick COUNT looks right under several wrong
 *      implementations, and the identity does not. (Note the float reality it
 *      has to hold under: `60 * TICK_MS` is 1000.0000000000001, so 100 frames of
 *      10ms yield 59 ticks and a residual, never 60.)
 *
 *   2. Except across a clamp. When the backlog exceeds MAX_CATCHUP_TICKS the
 *      excess is DISCARDED - `residualMs` goes to 0, not to
 *      `backlog - MAX_CATCHUP_TICKS * TICK_MS`. Banking it would make the next
 *      call emit another full burst and the one after that too: the stall would
 *      echo for as many frames as it took, instead of ending. Those discarded
 *      milliseconds are wall time this simulation will never run, which is
 *      precisely why a host-loss detector must count wall time and not ticks
 *      (ShadowLoop, item C): the tick source under-counts exactly when the room
 *      is in trouble.
 *
 * A zero or negative `elapsedMs` is treated as zero. A backwards clock is a real
 * event (an NTP step, a scheduler handing back a stale timestamp), and
 * subtracting it would un-bank time the sim already owns and stall the loop for
 * the length of the jump.
 */
export function advanceAccumulator(acc: TickAccumulator, elapsedMs: number): number {
  if (elapsedMs > 0) acc.residualMs += elapsedMs

  const ticks = Math.floor(acc.residualMs / TICK_MS)
  if (ticks <= 0) return 0

  if (ticks > MAX_CATCHUP_TICKS) {
    acc.residualMs = 0
    return MAX_CATCHUP_TICKS
  }

  acc.residualMs -= ticks * TICK_MS
  return ticks
}
