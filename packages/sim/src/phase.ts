import type { AuthEvent, Intent, SimContext, SimState } from './types'
import { COUNTDOWN_TICKS, MAX_KARTS } from './types'
import { clamp } from './mathutil'
import { emit } from './state'
import { botIntent } from './bot'
import { placementOrder } from './placement'

/**
 * Ticks after `state.finishTick` at which the race force-ends and every kart
 * still driving is recorded as a DNF, in placement order. 1800 ticks = 30 s at
 * 60 Hz. Not part of the locked contract; the contract names the timer but not
 * its length, so it is defined here and this module owns it.
 */
export const FINISH_GRACE_TICKS = 1800

/**
 * A reusable, caller-owned intent buffer of exactly MAX_KARTS slots. Allocate
 * one per loop, never per tick: `step()` must not allocate in the hot path.
 */
export function makeIntentBuffer(): Intent[] {
  const out: Intent[] = []
  for (let i = 0; i < MAX_KARTS; i++) {
    out.push({ tick: 0, steer: 0, accel: 0, brake: false, drift: false, useItem: false })
  }
  return out
}

/**
 * The 30 Hz bot hold. Bots produce an Intent on even ticks only and the odd tick
 * of the pair reuses it, matching the 30 Hz human input rate exactly so bots and
 * humans quantise drift timing identically.
 *
 * This is the only simulation state that lives outside SimState, because
 * SimState is locked and has no field for it. `holdTick[i]` records the EVEN
 * tick the held intent belongs to; an odd tick may reuse the hold only when
 * `holdTick[i] === tick - 1`.
 */
const holdIntent: Intent[] = makeIntentBuffer()
const holdTick: Int32Array = new Int32Array(MAX_KARTS).fill(-1)

/** Clears the 30 Hz bot hold. Call this when starting or restarting a run. */
export function resetBotHold(): void {
  for (let i = 0; i < MAX_KARTS; i++) {
    holdTick[i] = -1
    const h = holdIntent[i]
    h.tick = 0
    h.steer = 0
    h.accel = 0
    h.brake = false
    h.drift = false
    h.useItem = false
  }
}

function freeze(o: Intent, tick: number): void {
  o.tick = tick
  o.steer = 0
  o.accel = 0
  o.brake = false
  o.drift = false
  o.useItem = false
}

function copyIntent(src: Intent, dst: Intent, tick: number): void {
  dst.tick = tick
  dst.steer = src.steer
  dst.accel = src.accel
  dst.brake = src.brake
  dst.drift = src.drift
  dst.useItem = src.useItem
}

/**
 * Position 1 of the canonical per-kart order. Turns the raw per-slot intents
 * that arrived off the wire into the intents the rest of the tick actually
 * consumes.
 *
 *   - countdown  -> every slot is frozen to all-zero
 *   - bot slot, or a human whose `connected` is false -> botIntent, held at 30 Hz
 *   - connected human -> clamped, sanitised, restamped with `state.tick`
 *
 * `inputs` and `out` are indexed by kart slot: `inputs[i]` belongs to
 * `state.karts[i]`. Neither `inputs` nor `state` is mutated. Nothing allocates,
 * including `botIntent`: it returns a POOLED per-playerId Intent, the same
 * object on every call for that playerId, whose fields are copied out here by
 * copyIntent. The reference is never retained.
 */
export function resolveInputs(
  ctx: SimContext,
  state: SimState,
  inputs: Intent[],
  out: Intent[],
): void {
  const tick = state.tick
  const frozen = state.phase === 'countdown'

  for (let i = 0; i < MAX_KARTS; i++) {
    const o = out[i]

    if (frozen) {
      freeze(o, tick)
      continue
    }

    const k = state.karts[i]

    if (k.isBot || !k.connected) {
      if (tick % 2 === 0) {
        // even tick: recompute and own the pair (tick, tick + 1)
        copyIntent(botIntent(ctx, state, k.playerId), holdIntent[i], tick)
        holdTick[i] = tick
      } else if (holdTick[i] !== tick - 1) {
        // odd tick with no matching hold (cold start, or a slot that only just
        // became bot-driven): compute now and back-date the hold so the pair is
        // consistent from here on.
        copyIntent(botIntent(ctx, state, k.playerId), holdIntent[i], tick)
        holdTick[i] = tick - 1
      }
      copyIntent(holdIntent[i], o, tick)
      continue
    }

    const src = inputs[i]
    if (src === undefined || src === null) {
      freeze(o, tick)
      continue
    }

    o.tick = tick
    o.steer = Number.isFinite(src.steer) ? clamp(src.steer, -1, 1) : 0
    o.accel = Number.isFinite(src.accel) ? clamp(src.accel, 0, 1) : 0
    o.brake = src.brake === true
    o.drift = src.drift === true
    o.useItem = src.useItem === true
  }
}

/**
 * Last call of the tick, after the kart loop and after
 * resolveKartCollisions -> updateEntities -> updateItemBoxes.
 *
 * countdown -> racing:  on the first tick at or past COUNTDOWN_TICKS. Because
 *   this runs at the END of the tick, the tick that ends the countdown still ran
 *   with frozen input, and COUNTDOWN_TICKS + 1 is the first live tick.
 *
 * racing -> finished:  when every kart is in finishedOrder, or when
 *   FINISH_GRACE_TICKS have elapsed since finishTick. On a timeout the karts
 *   still driving are written into the free finishedOrder slots in placement
 *   order, so the results screen has a complete ranking and no kart is missing.
 *
 * finishedOrder is FIXED LENGTH MAX_KARTS with -1 in every unused slot (locked
 * contract §0). It is never pushed and never indexOf'd: growing it past 8 makes
 * the next cloneState throw, which would take recordRun/replayRun [Task 16] and
 * the golden run [Task 17] down with it. Every count below is a scan of the 8
 * slots for entries !== -1.
 *
 * The transition itself is deterministic and happens on every peer. Only
 * `ctx.isLeader` emits, because eventSeq is assigned by the current authority
 * and a client that emitted here would silently desync `state.nextEventSeq`.
 */
export function updatePhase(ctx: SimContext, state: SimState, events: AuthEvent[]): void {
  if (state.phase === 'countdown') {
    if (state.tick >= COUNTDOWN_TICKS) state.phase = 'racing'
    return
  }
  if (state.phase !== 'racing') return

  let finishers = 0
  for (let i = 0; i < MAX_KARTS; i++) {
    if (state.finishedOrder[i] !== -1) finishers++
  }

  // Defensive: updateLaps [Task 11] normally stamps finishTick on the tick it
  // records the first finisher. If it did, this guard is already false.
  if (state.finishTick < 0 && finishers > 0) {
    state.finishTick = state.tick
  }

  const allDone = finishers >= MAX_KARTS
  const graceUp =
    state.finishTick >= 0 && state.tick - state.finishTick >= FINISH_GRACE_TICKS
  if (!allDone && !graceUp) return

  if (!allDone) {
    const order = placementOrder(state)
    for (let n = 0; n < order.length; n++) {
      const pid = order[n]

      // Already recorded? Scan the 8 fixed slots. A playerId is never -1, so a
      // hit here is always a real finisher and never the padding.
      let seen = false
      for (let i = 0; i < MAX_KARTS; i++) {
        if (state.finishedOrder[i] === pid) {
          seen = true
          break
        }
      }
      if (seen) continue

      // Write into the first slot still holding -1. placementOrder returns all
      // MAX_KARTS playerIds and each is written at most once, so a free slot
      // always exists here. The guard exists so a malformed array stops the loop
      // instead of assigning to index -1, which would hang a stray '-1' property
      // off the array and desync cloneState/statesEqual.
      let slot = -1
      for (let i = 0; i < MAX_KARTS; i++) {
        if (state.finishedOrder[i] === -1) {
          slot = i
          break
        }
      }
      if (slot < 0) break

      state.finishedOrder[slot] = pid
      finishers++
      if (ctx.isLeader) {
        // 1-based finishing place, the same meaning updateLaps [Task 11] gives
        // `data`: the number of filled slots after this kart was recorded.
        emit(state, events, 'finish', pid, -1, 'none', finishers)
      }
    }
  }

  state.phase = 'finished'
  if (ctx.isLeader) {
    emit(state, events, 'finish', -1, -1, 'none', finishers)
  }
}
