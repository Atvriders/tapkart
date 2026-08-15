import type { AuthEvent, KartState, SimContext, SimState, Tuning, Vec3 } from './types'
import { TICK_DT } from './types'
import { lerp, wrapAngle } from './mathutil'
import { emit } from './state'

/**
 * Yaw rate, rad/s, forced on a kart while `spinOutTicks > 0`.
 * 4*PI rad/s is exactly two visible full turns per second of spin-out.
 */
export const SPIN_YAW_RATE = 4 * Math.PI

/** Per-tick multiplicative retention of horizontal speed while spinning out. */
export const SPIN_SPEED_DECAY = 0.94

/** Scratch respawn target. Module scope so the hot path never allocates. */
const TARGET: Vec3 = { x: 0, y: 0, z: 0 }

/**
 * True while the kart has no steering authority: the whole spin-out, and the
 * whole respawn interpolation. Task 6's `stepKart` reads the steer axis as 0
 * when this is true.
 */
export function steeringLocked(k: KartState): boolean {
  return k.spinOutTicks > 0 || k.respawnTicks > 0
}

/**
 * True while position and velocity are owned by `updateRecovery` and must not
 * be integrated by anything else this tick. A spinning kart still slides, so
 * only the respawn interpolation locks motion.
 */
export function motionLocked(k: KartState): boolean {
  return k.respawnTicks > 0
}

/**
 * The off-track term of the `targetSpeedFor` product (Task 6 owns the product).
 */
export function surfaceSpeedFactor(k: KartState, t: Tuning): number {
  return k.surface === 'offtrack' ? t.offtrackSpeedMul : 1
}

/**
 * The only sanctioned way to put a kart into a spin-out. Tasks 12 and 13 call
 * this; nothing else writes `k.spinOutTicks`.
 *
 * Refused outright while the kart is invulnerable or respawning, and it never
 * shortens a spin already running. The `'spinOut'` event is emitted only when
 * the timer actually changes AND the caller is the leader (Plan 2 Task 2), so
 * counting events on a leader counts real spin-outs; a follower spins the kart
 * out identically and announces nothing.
 */
export function startSpinOut(
  ctx: SimContext,
  state: SimState,
  k: KartState,
  ticks: number,
  events: AuthEvent[],
): void {
  if (ticks <= 0) return
  if (k.invulnTicks > 0 || k.respawnTicks > 0) return
  if (ticks <= k.spinOutTicks) return

  k.spinOutTicks = ticks
  k.drift.active = false
  k.drift.dir = 0
  k.drift.charge = 0
  k.boostTicks = 0
  if (ctx.isLeader) emit(state, events, 'spinOut', k.playerId, -1, 'none', ticks)
}

/**
 * Slot 2 of the canonical per-kart order inside `step()`.
 *
 * - A kart already respawning is interpolated one tick toward its checkpoint and
 *   nothing else happens to it.
 * - Otherwise invulnerability decays, then a live spin-out is advanced, then the
 *   kart is tested against the track bounds.
 */
export function updateRecovery(
  ctx: SimContext,
  state: SimState,
  k: KartState,
  events: AuthEvent[],
): void {
  const t = ctx.tuning

  if (k.respawnTicks > 0) {
    stepRespawn(ctx, k)
    if (k.respawnTicks === 0) k.invulnTicks = t.invulnTicks
    return
  }

  if (k.invulnTicks > 0) k.invulnTicks -= 1

  if (k.spinOutTicks > 0) {
    // Steering is already locked by `steeringLocked`; here we force the yaw so the
    // spin is visible, and bleed off horizontal speed. Vertical velocity belongs
    // to gravity and is left alone.
    k.angularVelocity = SPIN_YAW_RATE
    k.heading = wrapAngle(k.heading + SPIN_YAW_RATE * TICK_DT)
    k.velocity.x *= SPIN_SPEED_DECAY
    k.velocity.z *= SPIN_SPEED_DECAY
    k.drift.active = false
    k.drift.dir = 0
    k.drift.charge = 0
    k.boostTicks = 0
    k.spinOutTicks -= 1
  }

  const proj = ctx.query.project(k.position)
  if (!ctx.query.isInBounds(proj.s, proj.lateral)) {
    beginRespawn(ctx, state, k, events)
  }
}

/**
 * Writes the last-crossed checkpoint's world position into TARGET and returns the
 * heading of the centreline there. `checkpointIdx` is wrapped, so -1 means "the
 * final checkpoint of the previous lap".
 */
function checkpointTarget(ctx: SimContext, k: KartState): number {
  const cps = ctx.track.checkpointS
  const n = cps.length
  let s = 0
  if (n > 0) {
    const idx = ((k.lap.checkpointIdx % n) + n) % n
    s = cps[idx]
  }
  const cp = ctx.query.sampleAt(s)
  TARGET.x = cp.position.x
  TARGET.y = ctx.query.groundHeight(s, 0)
  TARGET.z = cp.position.z
  const tan = ctx.query.tangentAt(s)
  return Math.atan2(tan.z, tan.x)
}

function snapToCheckpoint(ctx: SimContext, k: KartState): void {
  const h = checkpointTarget(ctx, k)
  k.position.x = TARGET.x
  k.position.y = TARGET.y
  k.position.z = TARGET.z
  k.heading = wrapAngle(h)
}

function beginRespawn(
  ctx: SimContext,
  state: SimState,
  k: KartState,
  events: AuthEvent[],
): void {
  const t = ctx.tuning
  k.spinOutTicks = 0
  k.boostTicks = 0
  k.invulnTicks = 0
  k.drift.active = false
  k.drift.dir = 0
  k.drift.charge = 0
  k.velocity.x = 0
  k.velocity.y = 0
  k.velocity.z = 0
  k.angularVelocity = 0
  k.airborne = false
  k.respawnTicks = t.respawnTicks > 0 ? t.respawnTicks : 0
  // A non-leader never emits (contract §0); the respawn still happened.
  if (ctx.isLeader) emit(state, events, 'respawn', k.playerId, -1, 'none', k.respawnTicks)
  if (k.respawnTicks === 0) {
    snapToCheckpoint(ctx, k)
    k.invulnTicks = t.invulnTicks
  }
}

/**
 * One tick of the respawn interpolation.
 *
 * The kart's departure point is never stored, because `KartState` has no field
 * for it. Instead each tick moves a fraction `1 / remaining` of the way to the
 * target, which is exactly a linear schedule: after n of R ticks the kart sits at
 * `p0 + (n / R) * (target - p0)`. The final tick assigns the target directly so
 * arrival is bit-exact rather than one rounding short.
 *
 * `position.y` IS DEAD HERE, INTENTIONALLY. This function is slot 2 and
 * `integrateVertical` is slot 6; it is the one stage exempted from the motion-lock
 * rule (see step.ts), and its grounded branch — which a respawning kart always
 * takes, because `airborne` is cleared above every tick — reassigns `position.y`
 * from the analytic ground height under the kart's current x/z. So the y written
 * below never survives to the end of the tick and no reader ever sees it. The
 * override is deliberate: it walks the kart home along the surface rather than
 * along a straight line between two ground heights. The lerp is left whole rather
 * than punched full of holes, because two interpolated components and a comment
 * read better than two interpolated components and an unexplained gap.
 */
function stepRespawn(ctx: SimContext, k: KartState): void {
  k.velocity.x = 0
  k.velocity.y = 0
  k.velocity.z = 0
  k.angularVelocity = 0
  k.airborne = false
  k.boostTicks = 0
  k.drift.active = false
  k.drift.dir = 0
  k.drift.charge = 0

  if (k.respawnTicks <= 1) {
    snapToCheckpoint(ctx, k)
    k.respawnTicks = 0
    return
  }

  const h = checkpointTarget(ctx, k)
  const f = 1 / k.respawnTicks
  k.position.x = lerp(k.position.x, TARGET.x, f)
  // Overwritten by integrateVertical at slot 6, every tick, without exception —
  // see the note above. Kept for symmetry with x and z, not for its value.
  k.position.y = lerp(k.position.y, TARGET.y, f)
  k.position.z = lerp(k.position.z, TARGET.z, f)
  k.heading = wrapAngle(k.heading + wrapAngle(h - k.heading) * f)
  k.respawnTicks -= 1
}
