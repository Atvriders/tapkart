import type { AuthEvent, KartState, SimContext, SimState } from './types'
import { RACE_LAPS } from './types'
import { clamp } from './mathutil'
import { emit } from './state'
import { motionLocked } from './recovery'

/**
 * Fraction [0,1] of the way from checkpoint `idx` to the next checkpoint, for a
 * kart at arc-normalised `s`. Every `s` in this package is in [0, 1) and never
 * metres, so the segment that wraps past the start/finish line ends at
 * `checkpointS[0] + 1` -- one whole lap on -- and a negative delta is corrected
 * by adding a whole lap, not a track length. The lap length never appears here:
 * `t` is a ratio of two s-deltas, so it cancels out.
 */
function segmentT(ctx: SimContext, idx: number, s: number): number {
  const cps = ctx.track.checkpointS
  const n = cps.length
  const start = cps[idx]
  const end = idx + 1 < n ? cps[idx + 1] : cps[0] + 1
  const span = end - start
  if (span <= 0) return 0
  let ds = s - start
  if (ds < 0) ds += 1
  return clamp(ds / span, 0, 1)
}

/** True when `playerId` already holds one of the fixed finish slots. */
function hasFinished(state: SimState, playerId: number): boolean {
  const order = state.finishedOrder
  for (let i = 0; i < order.length; i++) {
    if (order[i] === playerId) return true
  }
  return false
}

/**
 * The lowest slot still holding the -1 sentinel, or -1 when all MAX_KARTS slots
 * are taken. `finishedOrder` is fixed length and is never pushed to: growing it
 * changes the state's shape, and cloneState throws the moment `prev` and `next`
 * disagree. Because slots fill front to back, this index is also the count of
 * entries that are already !== -1, i.e. the 0-based finishing place.
 */
function nextFinishSlot(state: SimState): number {
  const order = state.finishedOrder
  for (let i = 0; i < order.length; i++) {
    if (order[i] === -1) return i
  }
  return -1
}

/**
 * Checkpoint ring validation. Checkpoint 0 is the start/finish line.
 * A kart is credited only for entering the segment immediately after the one
 * it currently holds; driving backwards over a checkpoint, or skipping one,
 * changes nothing. Crossing into segment 0 from segment N-1 completes a lap.
 *
 * A respawning kart is excluded outright: `updateRecovery` [Task 9] owns its
 * position for the whole interpolation back to the checkpoint it already
 * holds, per the slot-2 comment in `step()`, and that world-space lerp can
 * sweep straight through an intervening checkpoint's `s` range when
 * `checkpointIdx` lags the kart's true position by two or more segments (a
 * skipped checkpoint that later goes out of bounds). Reading that transient
 * position here would misread the teleport as a driven crossing. Nothing is
 * lost by waiting: once the interpolation completes the kart is sitting
 * exactly on the checkpoint it holds, so its lap progress is exactly what it
 * was the tick it left the track.
 */
export function updateLaps(
  ctx: SimContext,
  state: SimState,
  k: KartState,
  events: AuthEvent[],
): void {
  if (motionLocked(k)) return

  const n = ctx.track.checkpointS.length
  if (n < 2) return

  const s = ctx.query.project(k.position).s
  const idx = ctx.query.checkpointIndexAt(s)
  const cur = k.lap.checkpointIdx
  const next = cur + 1 >= n ? 0 : cur + 1

  if (idx === cur) {
    k.lap.t = segmentT(ctx, cur, s)
    return
  }
  // Backwards over a checkpoint, or a skipped checkpoint: no credit, and t
  // stays frozen at whatever it was when the kart left its own segment.
  if (idx !== next) return

  k.lap.checkpointIdx = idx
  k.lap.t = segmentT(ctx, idx, s)
  if (idx !== 0) return // an ordinary checkpoint, not the finish line

  k.lap.lap += 1
  // A non-leader never emits (contract §0); the crossing still happened.
  if (ctx.isLeader) emit(state, events, 'lapCross', k.playerId, -1, 'none', k.lap.lap)

  if (k.lap.lap < RACE_LAPS) return
  if (hasFinished(state, k.playerId)) return
  const slot = nextFinishSlot(state)
  if (slot < 0) return // every seat has already finished
  state.finishedOrder[slot] = k.playerId
  if (state.finishTick < 0) state.finishTick = state.tick
  // The contract fixes the finish event's data as the 1-based finishing place,
  // and slot is the 0-based one.
  if (ctx.isLeader) emit(state, events, 'finish', k.playerId, -1, 'none', slot + 1)
}
