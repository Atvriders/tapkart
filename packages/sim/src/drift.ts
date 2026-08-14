import type { Intent, KartState, SimContext } from './types'
import { motionLocked, steeringLocked } from './recovery'

/**
 * Minimum |steer| that will latch a drift. Not part of the locked Tuning struct;
 * owned by this module.
 */
export const DRIFT_STEER_MIN = 0.35

/**
 * Which mini-turbo tier a charge has reached: -1 for none, otherwise an index
 * straight into tuning.driftBoosts.
 *
 * charge is a tick count, so the thresholds are tick counts too. Every threshold is
 * even because input is 30Hz against a 60Hz sim: a held drift always spans an even
 * number of ticks, so an odd threshold would sit inside a window no input can land
 * in and would be indistinguishable from the even number below it.
 */
export function driftTierFor(charge: number, tiers: [number, number, number]): number {
  if (charge >= tiers[2]) return 2
  if (charge >= tiers[1]) return 1
  if (charge >= tiers[0]) return 0
  return -1
}

/**
 * The lateral damping coefficient for this kart on this tick — the single
 * definition of it in the sim. Drifting deliberately retains lateral velocity
 * (gripDrift 3 against gripTarmac 14), which is what makes a drift a drift rather
 * than a tighter turn. Surfaces with no grip entry of their own ('boost',
 * 'offtrack') damp like tarmac; 'offtrack' is penalised through
 * surfaceSpeedFactor instead, not through grip.
 */
export function lateralGripFor(ctx: SimContext, k: KartState): number {
  const t = ctx.tuning
  if (k.drift.active) return t.gripDrift
  if (k.surface === 'dirt') return t.gripDirt
  return t.gripTarmac
}

/**
 * Canonical order slot 3 — runs before stepKart, so the drift flag set here is
 * what stepKart's lateral damping sees on the same tick.
 *
 * Latch: drift held, |steer| at or beyond DRIFT_STEER_MIN, xz speed strictly above
 * tuning.driftMinSpeed. dir is the sign of the steer that latched it and never
 * changes afterwards, so a player may straighten or counter-steer mid-drift.
 *
 * Charge: +1 tick per held tick including the latching tick, capped at the top
 * tier (the wire format gives drift charge 8 bits).
 *
 * Release: the tier reached grants tuning.driftBoosts[tier] boost ticks, applied as
 * a maximum so a longer boost already running is never truncated.
 *
 * Cancelled with no payout by: speed falling to or below driftMinSpeed while held,
 * a spin-out, or a respawn. Being airborne does not cancel a drift.
 */
export function updateDrift(ctx: SimContext, k: KartState, raw: Intent): void {
  const t = ctx.tuning
  const d = k.drift

  // `steeringLocked` is recovery.ts's definition of exactly the predicate this
  // branch used to re-inline (`spinOutTicks > 0 || respawnTicks > 0`). Importing it
  // is behaviour-identical and leaves one place to change it.
  //
  // This is the one stage that does not return empty-handed under the motion lock
  // (see step.ts): it re-asserts a cleared drift, which is byte-for-byte what
  // updateRecovery already wrote this tick, so recovery stays the sole determiner
  // of `drift`. The branch is wider than the lock because it also has to cover a
  // spin-out, which is steeringLocked but not motionLocked.
  if (steeringLocked(k)) {
    d.active = false
    d.dir = 0
    d.charge = 0
    return
  }

  const vx = k.velocity.x
  const vz = k.velocity.z
  const speed = Math.sqrt(vx * vx + vz * vz)

  if (!raw.drift) {
    if (d.active) {
      const tier = driftTierFor(d.charge, t.driftTiers)
      if (tier >= 0) {
        const ticks = t.driftBoosts[tier]
        if (k.boostTicks < ticks) k.boostTicks = ticks
      }
    }
    d.active = false
    d.dir = 0
    d.charge = 0
    return
  }

  if (!d.active) {
    if (speed <= t.driftMinSpeed) return
    if (Math.abs(raw.steer) < DRIFT_STEER_MIN) return
    d.active = true
    d.dir = raw.steer > 0 ? 1 : -1
    d.charge = 0
  } else if (speed <= t.driftMinSpeed) {
    d.active = false
    d.dir = 0
    d.charge = 0
    return
  }

  const cap = t.driftTiers[2]
  const next = d.charge + 1
  d.charge = next < cap ? next : cap
}

/**
 * Canonical order slot 8 — the last thing to touch the kart before updateLaps.
 *
 * Spends one tick of any running boost, whatever granted it (drift release, boost
 * pad, boost item). It owns boostTicks and nothing else: spinOutTicks, invulnTicks
 * and respawnTicks belong to updateRecovery.
 *
 * ...and so does boostTicks itself while `motionLocked(k)` — the motion-lock rule
 * in step.ts. A respawning kart's boost timer is not spent by the respawn, it is
 * held at zero by it, and a stage at a later slot than 2 does not get to decrement
 * a counter recovery is holding.
 */
export function decayBoost(k: KartState): void {
  if (motionLocked(k)) return
  if (k.boostTicks > 0) k.boostTicks -= 1
}
