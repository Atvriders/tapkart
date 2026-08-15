import type { AuthEvent, SimContext, SimState } from '@tapkart/sim'
import { applyItemGrant, kartById } from '@tapkart/sim'

/**
 * The follower's half of the emit-gating rule (locked contract §1b, §5).
 *
 * A leader's `emit()` (packages/sim/src/state.ts) stamps every AuthEvent with
 * the state's own `nextEventSeq` and then advances it. A follower never calls
 * `emit()` (every one of its 11 call sites is gated on `ctx.isLeader`), so a
 * follower's `nextEventSeq` is advanced *only* by applying events received off
 * the wire — this function is the entire mechanism by which that happens.
 *
 * Returns `false`, and changes nothing, when `ev.eventSeq` is at or below the
 * highest already applied: a duplicate delivery (the reliable channel is
 * ordered but a caller might still redeliver a batch it already processed) or
 * a stale/out-of-order arrival is a safe no-op, which is exactly what makes
 * authority migration safe (spec §5) — a promoted shadow's re-broadcast events
 * are never double-counted by a peer that already saw them once.
 *
 * Per-kind mutation is documented in full in this task's brief; the short
 * version: `itemGrant` (leader-only PRNG roll), `hit`/`spinOut` (caused by an
 * entity the receiver never simulated) and `finish` (WireSnapshot carries no
 * placement data at all) carry information a receiver cannot derive any other
 * way and must be applied. `respawn` and `lapCross` are self-derivable by a
 * peer correctly predicting its own kart, but are applied anyway — cheap,
 * idempotent, and consistent with what the next WireSnapshot would show.
 * `entitySpawn`/`entityDespawn` carry no position (AuthEvent has no Vec3 field
 * at all) and mutate nothing; entity truth is exclusively WireSnapshot's job.
 */
export function applyEvent(ctx: SimContext, state: SimState, ev: AuthEvent): boolean {
  if (ev.eventSeq < state.nextEventSeq) return false
  state.nextEventSeq = ev.eventSeq + 1

  switch (ev.kind) {
    case 'itemGrant': {
      // Both halves of a pickup: the kart's item AND the box's respawn timer
      // (ev.data is the boxIdx). packages/sim/src/items.ts owns this operation
      // and is written for exactly this receiving path - see the brief.
      applyItemGrant(ctx, state, ev)
      return true
    }
    case 'hit': {
      if (ev.data === 1) {
        const k = kartById(state, ev.playerId)
        if (k !== null) k.shielded = false
      }
      return true
    }
    case 'spinOut': {
      const k = kartById(state, ev.playerId)
      if (k !== null) {
        k.spinOutTicks = ev.data
        k.drift.active = false
        k.drift.dir = 0
        k.drift.charge = 0
        k.boostTicks = 0
      }
      return true
    }
    case 'respawn': {
      const k = kartById(state, ev.playerId)
      if (k !== null) k.respawnTicks = ev.data
      return true
    }
    case 'lapCross': {
      const k = kartById(state, ev.playerId)
      if (k !== null) {
        k.lap.lap = ev.data
        k.lap.checkpointIdx = 0
      }
      return true
    }
    case 'finish': {
      if (ev.playerId === -1) {
        state.phase = 'finished'
        return true
      }
      const slot = ev.data - 1
      if (slot >= 0 && slot < state.finishedOrder.length) {
        state.finishedOrder[slot] = ev.playerId
      }
      if (state.finishTick < 0) state.finishTick = ev.tick
      return true
    }
    case 'entitySpawn':
    case 'entityDespawn':
      return true
  }
}
