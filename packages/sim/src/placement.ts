import type { KartState, SimState } from './types'
import { MAX_KARTS } from './types'

// Module-level scratch: placement runs every tick, so it must not allocate.
// playerId is a 3-bit wire field, so it always indexes safely into these.
const finishRank = new Int32Array(MAX_KARTS)
const slotOrder = new Int32Array(MAX_KARTS)

/**
 * `state.finishedOrder` is fixed length MAX_KARTS with -1 in every slot that has
 * no finisher yet, so the `pid >= 0` guard is what skips the empty slots.
 */
function fillFinishRank(state: SimState): void {
  for (let i = 0; i < MAX_KARTS; i++) finishRank[i] = -1
  const order = state.finishedOrder
  for (let i = 0; i < order.length; i++) {
    const pid = order[i]
    if (pid >= 0 && pid < MAX_KARTS) finishRank[pid] = i
  }
}

/**
 * Negative when `a` is ahead of `b`. Reads `finishRank`, so `fillFinishRank`
 * must run first. A finisher always outranks a non-finisher; among finishers
 * the crossing order wins; otherwise (lap, checkpointIdx, t) descending, with
 * playerId ascending as the tie-break that makes the order total.
 */
function comparePlacement(a: KartState, b: KartState): number {
  const ra = finishRank[a.playerId]
  const rb = finishRank[b.playerId]
  if (ra >= 0 || rb >= 0) {
    if (ra >= 0 && rb >= 0) return ra - rb
    return ra >= 0 ? -1 : 1
  }
  if (a.lap.lap !== b.lap.lap) return b.lap.lap - a.lap.lap
  if (a.lap.checkpointIdx !== b.lap.checkpointIdx) {
    return b.lap.checkpointIdx - a.lap.checkpointIdx
  }
  if (a.lap.t !== b.lap.t) return a.lap.t < b.lap.t ? 1 : -1
  return a.playerId - b.playerId
}

/**
 * Zero-alloc placement. `outOrder[place] = playerId` (leader at place 0),
 * `outIndexOf[playerId] = place`. Both arrays must be length MAX_KARTS.
 * Insertion sort over 8 karts: no allocation, no comparator closure.
 */
export function computePlacement(
  state: SimState,
  outIndexOf: Int32Array,
  outOrder: Int32Array,
): void {
  fillFinishRank(state)
  const karts = state.karts
  for (let i = 0; i < MAX_KARTS; i++) {
    let j = i - 1
    while (j >= 0 && comparePlacement(karts[slotOrder[j]], karts[i]) > 0) {
      slotOrder[j + 1] = slotOrder[j]
      j--
    }
    slotOrder[j + 1] = i
  }
  for (let place = 0; place < MAX_KARTS; place++) {
    const pid = karts[slotOrder[place]].playerId
    outOrder[place] = pid
    outIndexOf[pid] = place
  }
}

/**
 * Allocating convenience form of the same ordering, leader first. Not for the
 * hot path — use computePlacement there.
 */
export function placementOrder(state: SimState): number[] {
  fillFinishRank(state)
  const karts = state.karts
  const slots: number[] = []
  for (let i = 0; i < MAX_KARTS; i++) slots.push(i)
  slots.sort((a, b) => comparePlacement(karts[a], karts[b]))
  const out: number[] = []
  for (let i = 0; i < slots.length; i++) out.push(karts[slots[i]].playerId)
  return out
}
