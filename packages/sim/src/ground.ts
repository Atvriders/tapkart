import type { KartState, SimContext } from './types'
import { TICK_DT } from './types'
import { clamp, wrapAngle } from './mathutil'
import { motionLocked } from './recovery'

/**
 * Minimum horizontal speed (world units/second) a kart needs before a ramp will
 * launch it. Not part of the locked Tuning struct; owned by this module.
 */
export const RAMP_MIN_SPEED = 6

/**
 * Boost ticks granted for touching a 'boost' surface. Even, for the same reason
 * every driftTiers/driftBoosts entry is: input arrives at 30Hz against a 60Hz
 * sim, so odd tick counts land inside windows no input can observe.
 */
export const BOOST_PAD_TICKS = 36

/**
 * Canonical order slot 5 — runs immediately after stepKart.
 *
 * stepKart's entire steering/longitudinal block is gated on `!k.airborne`, so on
 * every tick this function actually does work, stepKart touched neither
 * k.heading nor k.angularVelocity this tick. There is nothing to rewind. In the
 * air the kart keeps only tuning.airYaw of a flat steerRateBase turn (no speed
 * falloff — the tyres are not on anything), integrated fresh onto whatever
 * heading the kart already carried. It is a no-op on the ground.
 */
export function applyAirYaw(ctx: SimContext, k: KartState, steer: number): void {
  if (!k.airborne) return
  const t = ctx.tuning
  const airOmega = clamp(steer, -1, 1) * t.steerRateBase * t.airYaw
  k.angularVelocity = airOmega
  k.heading = wrapAngle(k.heading + airOmega * TICK_DT)
}

/**
 * Canonical order slot 6 — the only writer of position.y / velocity.y **within the
 * per-kart loop**. Task 10's `resolveKartCollisions` (in collision.ts) writes them
 * too, once per tick, after the whole loop has finished: a kart-vs-kart contact is
 * a 3D sphere collision, so a normal with a vertical component pushes both
 * position.y and velocity.y, on grounded karts as much as airborne ones — nothing
 * about the collision reads or writes `k.airborne`.
 *
 * That collision write is transient for a grounded kart, though: on the very next
 * tick this function runs again before any collision does, and its grounded branch
 * unconditionally re-snaps position.y to the analytic ground height (and zeroes
 * velocity.y) from the kart's *current* x/z alone — never from whatever value was
 * sitting there a moment ago. So a collision can shove a grounded kart's y away
 * from the surface for exactly one tick's rendered state; the tick after that, this
 * function throws the perturbation away regardless of who wrote it or why. The one
 * case where a collision's vertical write actually persists and compounds is an
 * airborne kart, whose branch below integrates velocity.y forward every tick
 * instead of overwriting it.
 *
 * Grounded: snapped to the analytic spline height every tick, so a grounded kart
 * can never drift off the surface. Airborne: integrate gravity, then land when the
 * kart has fallen to or below the surface *while descending*. The descending half
 * of that test is load-bearing — on the tick after a ramp launch the kart sits at
 * exactly ground height with a large positive velocity.y.
 *
 * THE ONE EXEMPTION FROM THE MOTION-LOCK RULE (see step.ts).
 *
 * This function has no `motionLocked` guard, on purpose. `stepRespawn` (recovery.ts)
 * lerps all three position components toward the checkpoint; a respawning kart is
 * never airborne (stepRespawn clears the flag every tick), so the grounded branch
 * below always runs and unconditionally reassigns `position.y` from the analytic
 * ground height under the kart's *current* x/z. The y term of stepRespawn's lerp is
 * therefore overwritten before anything can observe it — it is dead code, and it is
 * documented as such at that site too.
 *
 * It stays overwritten because the behaviour is the one we want: the kart is walked
 * home *along the surface* rather than arcing through the air on a straight line
 * between two ground heights, which is what honouring the lerp would produce over a
 * banked or hilly stretch. Deleting stepRespawn's y lerp would also be safe today,
 * but keeping the interpolation whole in one place is cheaper to read than a lerp
 * with a hole in it, so the dead assignment is kept and labelled rather than removed.
 *
 * ctx.query.project() may hand back a shared scratch object, so s and lateral are
 * read out immediately and the projection is never retained.
 */
export function integrateVertical(ctx: SimContext, k: KartState): void {
  const proj = ctx.query.project(k.position)
  const ground = ctx.query.groundHeight(proj.s, proj.lateral)

  if (!k.airborne) {
    k.position.y = ground
    k.velocity.y = 0
    return
  }

  k.velocity.y -= ctx.tuning.gravity * TICK_DT
  k.position.y += k.velocity.y * TICK_DT

  if (k.position.y <= ground && k.velocity.y <= 0) {
    k.position.y = ground
    k.velocity.y = 0
    k.airborne = false
  }
}

/**
 * Canonical order slot 7 — runs after the vertical integration, so a kart that
 * landed this tick can be launched again by the ramp it landed on.
 *
 * `s` is the kart's current arc-normalised position along the centreline, [0, 1)
 * per the contract — never metres. The caller supplies it rather than this function
 * re-projecting, because step() already has it. `ramp.sStart` and `ramp.sEnd` are in
 * the same units, so the comparison is direct; a ramp whose sStart is greater than
 * its sEnd wraps through the start/finish line.
 *
 * The motion-lock guard (see step.ts) writes down a correctness this function had
 * only by accident: a respawning kart is left at zero velocity by `stepRespawn`, so
 * the RAMP_MIN_SPEED test below already rejected it — but that is a fact owned by
 * recovery.ts, and a launch here would write `velocity.y` and `airborne`, both of
 * which belong to updateRecovery while the kart is locked.
 */
export function applyRamps(ctx: SimContext, k: KartState, s: number): void {
  if (motionLocked(k)) return
  if (k.airborne) return

  const vx = k.velocity.x
  const vz = k.velocity.z
  const speed = Math.sqrt(vx * vx + vz * vz)
  if (speed < RAMP_MIN_SPEED) return

  const ramps = ctx.track.ramps
  for (let i = 0; i < ramps.length; i++) {
    const r = ramps[i]
    const inside =
      r.sStart <= r.sEnd
        ? s >= r.sStart && s <= r.sEnd
        : s >= r.sStart || s <= r.sEnd
    if (!inside) continue
    k.velocity.y = r.launch
    k.airborne = true
    return
  }
}

/**
 * Canonical order slot 7b — directly after applyRamps, before decayBoost.
 *
 * This is what makes Track.boostPads and a 'boost' result from surfaceAt do
 * anything: it tops the kart's boost timer up to BOOST_PAD_TICKS. `s` is
 * arc-normalised [0, 1) per the contract and is handed straight to the query.
 *
 * It re-reads the surface from the query rather than from k.surface, so the pad
 * grant cannot depend on the order of the two: slot 6b writes k.surface from the
 * same s and lateral, one line earlier in step().
 *
 * Airborne karts are skipped — flying over a pad is not driving over it. Karts under
 * the motion lock (see step.ts) are skipped too: `boostTicks` belongs to
 * updateRecovery for the whole respawn, and being dragged across a pad by a
 * respawn interpolation is not driving over it either.
 *
 * The top-up never shortens a longer boost already running (a tier-3 drift boost is
 * 66 ticks; clipping it to 36 on a pad would be a downgrade).
 */
export function applyBoostPad(ctx: SimContext, k: KartState, s: number, lateral: number): void {
  if (motionLocked(k)) return
  if (k.airborne) return
  if (ctx.query.surfaceAt(s, lateral) !== 'boost') return
  if (k.boostTicks < BOOST_PAD_TICKS) k.boostTicks = BOOST_PAD_TICKS
}
