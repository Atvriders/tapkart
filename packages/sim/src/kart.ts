import type { CharacterStats, Intent, KartState, SimContext, SimState, Tuning } from './types'
import { TICK_DT } from './types'
import { clamp, wrapAngle } from './mathutil'
import { surgeActiveOn } from './entity'
import { motionLocked, steeringLocked, surfaceSpeedFactor } from './recovery'
import { lateralGripFor } from './drift'

/**
 * The Surge item's field-wide slow, as a multiplier on the target speed.
 *
 * The rule is the contract's, and surgeActiveOn (Task 12, entity.ts) owns it: a
 * live surge slows every kart placed AHEAD of the kart that cast it, and never
 * the caster itself. Placement is read live from computePlacement, so a kart that
 * drops behind the caster stops being slowed on the next tick.
 *
 * This replaced Task 6's staged rule, "any live surge this kart does not own",
 * which slowed the whole field except the caster.
 */
function surgeFactorFor(state: SimState, k: KartState, t: Tuning): number {
  return surgeActiveOn(state, k.playerId) ? t.surgeSpeedMul : 1
}

/**
 * The one place every speed modifier is composed. The multiplication order is
 * part of the locked contract: float multiplication is not associative, and the
 * checkpoint-replay equivalence test asserts bit-identity.
 *
 *   maxSpeed * character.speed * accel * surface * surge * boost
 */
export function targetSpeedFor(
  ctx: SimContext,
  state: SimState,
  k: KartState,
  accel: number,
): number {
  const t = ctx.tuning
  const ch = ctx.characters[k.characterIdx] as CharacterStats

  const surfaceFactor = surfaceSpeedFactor(k, t)
  const surgeFactor = surgeFactorFor(state, k, t)
  // Task 8 is what makes boostTicks nonzero; the factor itself is complete.
  const boostFactor = k.boostTicks > 0 ? t.boostSpeedMul : 1

  return t.maxSpeed * ch.speed * accel * surfaceFactor * surgeFactor * boostFactor
}

/**
 * One tick of ground handling for one kart: steering yaw, then longitudinal
 * accel/brake toward targetSpeedFor, then lateral grip, then horizontal position
 * integration.
 *
 * Never touches position.y or velocity.y — Task 7's integrateVertical owns those.
 * While airborne the whole traction block is skipped: Task 7's applyAirYaw owns
 * airborne steering, so the two can never double-apply yaw.
 */
export function stepKart(
  ctx: SimContext,
  state: SimState,
  prevKart: KartState,
  k: KartState,
  raw: Intent,
): void {
  const t = ctx.tuning
  const ch = ctx.characters[k.characterIdx] as CharacterStats

  // Canonical order slot 2 already ran this tick. A respawning kart's position and
  // velocity belong to updateRecovery's interpolation, so stepKart does nothing at
  // all for it — not the traction block, and not the position integration below.
  if (motionLocked(k)) return

  if (!k.airborne) {
    // --- Steering -----------------------------------------------------------
    // Authority is measured from the speed at the TOP of the tick, so stages
    // that ran before stepKart cannot change this tick's yaw response.
    const pvx = prevKart.velocity.x
    const pvz = prevKart.velocity.z
    const entrySpeed = Math.sqrt(pvx * pvx + pvz * pvz)
    const sn = clamp(entrySpeed / t.maxSpeed, 0, 1)
    // 0 at rest (no pivoting in place), peak at sn = 1/(2*falloff), reduced at top speed
    const authority = sn * (1 - t.steerSpeedFalloff * sn)
    // A spinning or respawning kart has no steering authority at all (Task 9).
    const steer = steeringLocked(k) ? 0 : raw.steer
    const yawRate = t.steerRateBase * steer * ch.handling * authority
    k.angularVelocity = yawRate
    k.heading = wrapAngle(k.heading + yawRate * TICK_DT)

    // --- Longitudinal -------------------------------------------------------
    // forward = (cos h, 0, sin h); right = (-t.z, 0, t.x) = (-sin h, 0, cos h)
    const fx = Math.cos(k.heading)
    const fz = Math.sin(k.heading)
    const rx = -fz
    const rz = fx
    const vf = k.velocity.x * fx + k.velocity.z * fz
    const vr = k.velocity.x * rx + k.velocity.z * rz

    // Braking wins over the throttle. Off the brake, the same rate applies in
    // both directions, so releasing the throttle coasts down at accelRate.
    const target = raw.brake ? 0 : targetSpeedFor(ctx, state, k, raw.accel)
    const rate = raw.brake ? t.brakeRate : t.accelRate * ch.accel
    const maxDelta = rate * TICK_DT
    const newVf = vf + clamp(target - vf, -maxDelta, maxDelta)

    // --- Lateral grip -------------------------------------------------------
    // lateralGripFor (Task 8) is the single definition of this coefficient:
    // gripDrift while drifting, gripDirt on dirt, gripTarmac on everything else
    // ('boost' and 'offtrack' included — offtrack is penalised through
    // surfaceSpeedFactor, not through grip). updateDrift runs at slot 3, before
    // stepKart, so k.drift.active already holds this tick's value.
    const newVr = vr * (1 - clamp(lateralGripFor(ctx, k) * TICK_DT, 0, 1))

    k.velocity.x = newVf * fx + newVr * rx
    k.velocity.z = newVf * fz + newVr * rz
  }

  // --- Horizontal position integration (y is Task 7's) ----------------------
  k.position.x += k.velocity.x * TICK_DT
  k.position.z += k.velocity.z * TICK_DT
}
