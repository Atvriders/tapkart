import type { AuthEvent, Intent, SimContext, SimState } from './types'
import { MAX_KARTS } from './types'
import { cloneState } from './state'
import { stepKart } from './kart'
import { updateItemBoxes, useItem } from './items'
import { updateLaps } from './laps'
import { resolveKartCollisions } from './collision'
import { updateEntities } from './entity'
import { steeringLocked, updateRecovery } from './recovery'
import { applyAirYaw, integrateVertical, applyRamps, applyBoostPad } from './ground'
import { updateDrift, decayBoost } from './drift'
import { makeIntentBuffer, resolveInputs, updatePhase } from './phase'

/**
 * The resolved intents the whole tick reads. Exactly `MAX_KARTS` distinct Intent
 * objects, allocated once at module load and rewritten in place every tick,
 * because step() must never allocate in the hot path. Indexed by kart slot.
 *
 * `makeIntentBuffer()` [Task 15] produces exactly the shape Task 6's `Array.from`
 * literal produced, so every reader of this buffer is unaffected by the swap.
 */
const resolvedInputs: Intent[] = makeIntentBuffer()

/**
 * Advance the simulation by exactly one 60Hz tick.
 *
 * The tick starts by copying `prev` into `next`; every stage after that writes
 * only into `next`, which is what makes "never mutates prev" true globally.
 * `step` never reads the wall clock and never calls Math.random().
 *
 * `inputs` is indexed by kart slot (`inputs[i]` belongs to `next.karts[i]`, whose
 * `playerId` is `i`). The canonical per-kart stage order, as the loop below
 * actually runs it, is:
 *   1.  resolveInputs      [Task 15]  once, before the loop
 *   2.  updateRecovery     [Task 9]
 *   2.5 useItem            [Task 13]  after recovery, before stepKart
 *   3.  updateDrift        [Task 8]
 *   4.  stepKart           [Task 6]
 *   5.  applyAirYaw        [Task 7]   guarded by !steeringLocked at this call site
 *   6.  integrateVertical  [Task 7]
 *   6b. k.surface          [Task 7]   the tick's only recomputation of the surface
 *   7.  applyRamps         [Task 7]
 *   7b. applyBoostPad      [Task 7]
 *   8.  decayBoost         [Task 8]
 *   9.  updateLaps         [Task 11]
 * then, once per tick after the kart loop:
 *   resolveKartCollisions [Task 10] -> updateEntities [Task 12]
 *   -> updateItemBoxes    [Task 13] -> updatePhase    [Task 15]
 *
 * The contract's §2 block lists nine slots; the loop runs eleven. `useItem`,
 * the `k.surface` recomputation and `applyBoostPad` were all added by the tasks
 * that introduced them, under the contract's own "the task that introduces a
 * function ALSO adds its call site in step.ts" rule, and none of them was ever
 * written back into §2. This docstring, not §2, is the accurate map of the tick.
 *
 * ---------------------------------------------------------------------------
 * THE MOTION-LOCK RULE
 *
 * While `motionLocked(k)`, `updateRecovery` is the sole writer of `position`,
 * `velocity`, `heading`, `angularVelocity`, `airborne`, `boostTicks`, `drift`
 * and `lap`. Any stage at a later slot must early-return. Stages that only read
 * are unaffected.
 *
 * Three stages were caught ignoring the slot-2 comment one at a time during the
 * plan, and two more in a single reading pass at review, which is why the rule is
 * stated once here rather than re-argued per stage. Who enforces it:
 *
 *   2.5 useItem            its own "don't waste the item" guard is
 *                          `spinOutTicks > 0 || respawnTicks > 0` — strictly
 *                          stronger than motionLocked, so it satisfies the rule
 *   3.  updateDrift        see the note below
 *   4.  stepKart           `if (motionLocked(k)) return`
 *   5.  applyAirYaw        guarded at this call site by `!steeringLocked(k)`
 *   6.  integrateVertical  EXEMPT — see below
 *   7.  applyRamps         `if (motionLocked(k)) return`
 *   7b. applyBoostPad      `if (motionLocked(k)) return`
 *   8.  decayBoost         `if (motionLocked(k)) return`
 *   9.  updateLaps         `if (motionLocked(k)) return`
 *   post-loop resolveKartCollisions   `collidable()` is `!motionLocked(k)`
 *
 * EXEMPTION — `integrateVertical` (slot 6) deliberately overwrites `position.y`
 * on a respawning kart. `stepRespawn` interpolates all three components toward
 * the checkpoint, but slot 6 then re-snaps y to the analytic ground height under
 * the kart's current x/z, so the y term of that lerp never survives the tick and
 * is dead code. The behaviour it produces is the one we want — the kart slides
 * home along the surface instead of arcing through the air over it — so the
 * override stands and the rule bends around it, rather than the reverse. Both
 * sites say so; see `stepRespawn` in recovery.ts and `integrateVertical` in
 * ground.ts.
 *
 * NOTE — `updateDrift` (slot 3) does not early-return empty-handed: on a locked
 * kart it re-asserts `drift` cleared, which is byte-for-byte what `updateRecovery`
 * already wrote this tick. Recovery therefore remains the sole *determiner* of
 * `drift`; the branch is there because it also has to cover a spin-out, which is
 * `steeringLocked` but not `motionLocked`.
 * ---------------------------------------------------------------------------
 */
export function step(
  ctx: SimContext,
  prev: SimState,
  next: SimState,
  inputs: Intent[],
  events: AuthEvent[],
): void {
  cloneState(prev, next)
  next.tick = prev.tick + 1

  // Canonical per-kart order, position 1: phase gating, bot fill, 30Hz hold and
  // sanitisation, all four at once — this call is what Task 6's stand-in fill loop
  // was standing in for, and it occupies exactly that loop's position. Every stage
  // below this line reads `resolvedInputs`, never the raw `inputs`.
  resolveInputs(ctx, next, inputs, resolvedInputs)

  for (let i = 0; i < MAX_KARTS; i++) {
    const k = next.karts[i]
    const prevKart = prev.karts[i]
    const raw = resolvedInputs[i]
    // Canonical order slot 2. Recovery runs before drift and before the integrator
    // because it owns this kart's controls for the rest of the tick: stepKart reads
    // steeringLocked / motionLocked, and updateDrift forfeits a charge on a kart
    // that recovery has just put into a spin-out or a respawn. See the motion-lock
    // rule above for the full list of who must yield to it.
    updateRecovery(ctx, next, k, events)
    // Slot 2.5 — after recovery, before stepKart. Both halves of that matter.
    //
    // After recovery: useItem's own guard exists so a spun-out or respawning kart
    // keeps its item rather than wasting it, and the guard can only see this tick's
    // recovery state if recovery has already run. Called at the top of the loop it
    // saw last tick's state, so on the tick a kart went out of bounds it spent the
    // item and set boostTicks, and beginRespawn zeroed boostTicks two lines later:
    // the item was consumed and its effect erased, which is precisely what the
    // guard is for.
    //
    // Before stepKart: a boost fired this tick must be live when stepKart reads
    // `k.boostTicks > 0` through targetSpeedFor. Slot 2.5 is still ahead of slot 4,
    // so it is, unchanged from the original position.
    if (raw.useItem) useItem(ctx, next, k, events)
    updateDrift(ctx, k, raw)
    stepKart(ctx, next, prevKart, k, raw)
    // Recovery owns this kart's controls for the whole tick (see the slot-2 comment
    // above), including in the air: a spinning or respawning kart keeps none of its
    // steering authority. applyAirYaw (Task 7) has no awareness of steeringLocked --
    // it unconditionally assigns angularVelocity from the raw steer whenever the
    // kart is airborne -- so the lock is enforced here, at the call site, rather than
    // inside ground.ts. Guarding the call (not passing steer = 0) is deliberate:
    // passing 0 would still run applyAirYaw's k.angularVelocity = 0 and kill the
    // forced spin yaw updateRecovery just set; skipping the call preserves it.
    if (!steeringLocked(k)) applyAirYaw(ctx, k, raw.steer)
    integrateVertical(ctx, k)
    // project() returns shared scratch, so both fields are copied out at once and
    // the projection itself is never retained across the calls below.
    const groundProj = ctx.query.project(k.position)
    const groundS = groundProj.s
    const groundLateral = groundProj.lateral
    // Slot 6b: the only recomputation of k.surface in the whole tick. Tasks 6, 8 and
    // 9 read this field (lateral grip, lateralGripFor, surfaceSpeedFactor); without
    // this line it keeps whatever createState put there at the start line forever.
    k.surface = ctx.query.surfaceAt(groundS, groundLateral)
    applyRamps(ctx, k, groundS)
    applyBoostPad(ctx, k, groundS, groundLateral)
    decayBoost(k)
    updateLaps(ctx, next, k, events)
  }

  // Once per tick, after every kart has moved: contact resolution reads the final
  // positions of all eight karts, so it cannot run inside the loop. Contract order
  // from here on is resolveKartCollisions -> updateEntities [Task 12] ->
  // updateItemBoxes [Task 13] -> updatePhase [Task 15].
  resolveKartCollisions(ctx, next)
  updateEntities(ctx, next, events)
  updateItemBoxes(ctx, next, events)
  updatePhase(ctx, next, events)
}
