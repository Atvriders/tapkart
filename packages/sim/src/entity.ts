import type {
  AuthEvent, EntityKind, EntityState, KartState, SimContext, SimState, Vec3,
} from './types'
import { MAX_ENTITIES, MAX_KARTS, TICK_DT } from './types'
import { clamp, wrapAngle } from './mathutil'
import { emit } from './state'
import { startSpinOut } from './recovery'
import { computePlacement } from './placement'

const SEEKER_TURN_RATE = 4.0 // rad/s of homing authority
const BOLT_EDGE_INSET = 0.05 // m inside the edge a bolt is placed after a bounce
const BUBBLE_ORBIT_RADIUS = 2.0 // m
const BUBBLE_ORBIT_RATE = 6.0 // rad/s

// Placement scratch for surgeActiveOn. Module-level so the per-tick, per-kart
// call allocates nothing.
const placeIndexOf = new Int32Array(MAX_KARTS)
const placeOrder = new Int32Array(MAX_KARTS)

/**
 * The canonical dead form of a pool slot. entityId === -1 is the contract's
 * sentinel; the rest is cleared so a slot's contents never depend on which
 * entity last occupied it.
 */
function clearSlot(e: EntityState): void {
  e.entityId = -1
  e.kind = 'seeker'
  e.ownerId = -1
  e.position.x = 0
  e.position.y = 0
  e.position.z = 0
  e.velocity.x = 0
  e.velocity.y = 0
  e.velocity.z = 0
  e.heading = 0
  e.targetId = -1
  e.ttl = 0
}

/**
 * Take the next free slot at the front of the pool. Returns the new entityId,
 * or -1 when the pool is full: the contract drops the spawn and never evicts.
 * `position` is copied by value; `velocity` is derived by updateEntities.
 */
export function spawnEntity(
  ctx: SimContext,
  state: SimState,
  kind: EntityKind,
  ownerId: number,
  position: Vec3,
  heading: number,
  targetId: number,
  ttl: number,
  events: AuthEvent[],
): number {
  if (state.entityCount >= MAX_ENTITIES) return -1

  const idx = state.entityCount
  const e = state.entities[idx]
  const entityId = state.nextEntityId
  state.nextEntityId = entityId + 1
  state.entityCount = idx + 1

  e.entityId = entityId
  e.kind = kind
  e.ownerId = ownerId
  e.position.x = position.x
  e.position.y = position.y
  e.position.z = position.z
  e.velocity.x = 0
  e.velocity.y = 0
  e.velocity.z = 0
  e.heading = wrapAngle(heading)
  e.targetId = targetId
  e.ttl = ttl

  if (ctx.isLeader) emit(state, events, 'entitySpawn', ownerId, entityId, kind, ttl)
  return entityId
}

/**
 * Remove the entity at packed index `idx` (not an entityId) by swap-remove.
 *
 * A despawning bubble takes its owner's shield with it. `k.shielded` is the truth
 * and the bubble is its view, so the two have to end together — and the *only* place
 * that is true for every despawn path is here. `updateEntities` runs
 * strikes -> bubble-consistency -> ttl, and the consistency pass enforces one
 * direction only ("no bubble without a shield"); when the ttl pass then retired a
 * bubble at `entityTtl`, nothing cleared the flag and the kart stayed invisibly
 * shielded for the rest of the race, absorbing one hit out of thin air with no
 * bubble on screen. Clearing it here covers ttl, hit-absorption and anything added
 * later, and it is idempotent: the strike path has already written `false`.
 */
export function despawnEntityAt(ctx: SimContext, state: SimState, idx: number, events: AuthEvent[]): void {
  if (idx < 0 || idx >= state.entityCount) return

  const e = state.entities[idx]
  if (ctx.isLeader) emit(state, events, 'entityDespawn', e.ownerId, e.entityId, e.kind, 0)
  if (e.kind === 'bubble') {
    const owner = kartById(state, e.ownerId)
    if (owner !== null) owner.shielded = false
  }

  const last = state.entityCount - 1
  if (idx !== last) {
    const tmp = state.entities[idx]
    state.entities[idx] = state.entities[last]
    state.entities[last] = tmp
  }
  state.entityCount = last
  clearSlot(state.entities[last])
}

export function kartById(state: SimState, playerId: number): KartState | null {
  const karts = state.karts
  for (let i = 0; i < karts.length; i++) {
    if (karts[i].playerId === playerId) return karts[i]
  }
  return null
}

/**
 * Strike radius per kind, in metres, added to tuning.kartRadius at the test.
 * A bubble is a shield, and a surge is a slow field: neither strikes a kart.
 */
function hitRadiusFor(kind: EntityKind): number {
  switch (kind) {
    case 'seeker':
      return 1.6
    case 'bolt':
      return 1.4
    case 'slick':
      return 1.2
    case 'charge':
      return 6.0
    default:
      return 0
  }
}

/** One tick of per-kind motion. Never spawns or despawns. */
function stepEntity(ctx: SimContext, state: SimState, e: EntityState): void {
  switch (e.kind) {
    case 'seeker': {
      const target = e.targetId >= 0 ? kartById(state, e.targetId) : null
      if (target !== null) {
        const dx = target.position.x - e.position.x
        const dz = target.position.z - e.position.z
        if (dx !== 0 || dz !== 0) {
          const maxTurn = SEEKER_TURN_RATE * TICK_DT
          const diff = wrapAngle(Math.atan2(dz, dx) - e.heading)
          e.heading = wrapAngle(e.heading + clamp(diff, -maxTurn, maxTurn))
        }
      }
      const sp = ctx.tuning.seekerSpeed
      e.velocity.x = Math.cos(e.heading) * sp
      e.velocity.y = 0
      e.velocity.z = Math.sin(e.heading) * sp
      e.position.x += e.velocity.x * TICK_DT
      e.position.z += e.velocity.z * TICK_DT
      return
    }
    case 'bolt': {
      const sp = ctx.tuning.boltSpeed
      e.velocity.x = Math.cos(e.heading) * sp
      e.velocity.y = 0
      e.velocity.z = Math.sin(e.heading) * sp
      e.position.x += e.velocity.x * TICK_DT
      e.position.z += e.velocity.z * TICK_DT

      const proj = ctx.query.project(e.position)
      const half = ctx.query.sampleAt(proj.s).width * 0.5
      if (proj.lateral <= half && proj.lateral >= -half) return

      const tan = ctx.query.tangentAt(proj.s)
      const tl = Math.sqrt(tan.x * tan.x + tan.z * tan.z)
      if (tl < 1e-9) return
      const tx = tan.x / tl
      const tz = tan.z / tl
      // right = (-t.z, 0, t.x), normalized: positive lateral is right of travel
      const rx = -tz
      const rz = tx
      // reflect the heading direction about the tangent axis: 2(d.t)t - d
      const dx = Math.cos(e.heading)
      const dz = Math.sin(e.heading)
      const dot = dx * tx + dz * tz
      e.heading = wrapAngle(Math.atan2(2 * dot * tz - dz, 2 * dot * tx - dx))
      // and place it back just inside the edge it crossed
      const edge = half - BOLT_EDGE_INSET
      const shift = (proj.lateral > 0 ? edge : -edge) - proj.lateral
      e.position.x += rx * shift
      e.position.z += rz * shift
      e.velocity.x = Math.cos(e.heading) * sp
      e.velocity.z = Math.sin(e.heading) * sp
      return
    }
    case 'bubble': {
      e.heading = wrapAngle(e.heading + BUBBLE_ORBIT_RATE * TICK_DT)
      const tangential = BUBBLE_ORBIT_RATE * BUBBLE_ORBIT_RADIUS
      e.velocity.x = -Math.sin(e.heading) * tangential
      e.velocity.y = 0
      e.velocity.z = Math.cos(e.heading) * tangential
      const owner = kartById(state, e.ownerId)
      if (owner !== null) {
        e.position.x = owner.position.x + Math.cos(e.heading) * BUBBLE_ORBIT_RADIUS
        e.position.y = owner.position.y
        e.position.z = owner.position.z + Math.sin(e.heading) * BUBBLE_ORBIT_RADIUS
      }
      return
    }
    default: {
      // slick is a dropped hazard; surge and charge are timed fields. All
      // three sit still and only their ttl moves.
      e.velocity.x = 0
      e.velocity.y = 0
      e.velocity.z = 0
      return
    }
  }
}

/**
 * One call per tick, after the per-kart loop and resolveKartCollisions.
 * Motion, then strikes, then shield bookkeeping, then ttl. Every pass that can
 * despawn walks the live range backwards, so a swap-remove can never skip or
 * re-process a slot: the entity moved down into `i` always comes from an index
 * that was already visited.
 */
export function updateEntities(
  ctx: SimContext,
  state: SimState,
  events: AuthEvent[],
): void {
  for (let i = 0; i < state.entityCount; i++) {
    stepEntity(ctx, state, state.entities[i])
  }

  const karts = state.karts
  for (let i = state.entityCount - 1; i >= 0; i--) {
    const e = state.entities[i]
    const radius = hitRadiusFor(e.kind)
    if (radius <= 0) continue
    const reach = radius + ctx.tuning.kartRadius
    const reach2 = reach * reach
    for (let ki = 0; ki < karts.length; ki++) {
      const k = karts[ki]
      if (k.playerId === e.ownerId) continue
      // startSpinOut refuses these karts anyway; skipping them here is what
      // also suppresses the 'hit' event, so an untouchable kart is silent.
      if (k.spinOutTicks > 0 || k.invulnTicks > 0 || k.respawnTicks > 0) continue
      const dx = e.position.x - k.position.x
      const dy = e.position.y - k.position.y
      const dz = e.position.z - k.position.z
      if (dx * dx + dy * dy + dz * dz > reach2) continue
      if (k.shielded) {
        k.shielded = false
        if (ctx.isLeader) emit(state, events, 'hit', k.playerId, e.entityId, e.kind, 1)
      } else {
        if (ctx.isLeader) emit(state, events, 'hit', k.playerId, e.entityId, e.kind, 0)
        // startSpinOut is the contract's sole writer of spinOutTicks and it
        // emits the 'spinOut' event itself.
        startSpinOut(ctx, state, k, ctx.tuning.spinOutTicks, events)
      }
      if (e.kind === 'seeker' || e.kind === 'bolt') {
        // `e` is cleared by the swap-remove, so nothing may read it after this
        despawnEntityAt(ctx, state, i, events)
        break
      }
    }
  }

  // k.shielded is the truth; a bubble is its view. One outlives the other for
  // no ticks at all.
  //
  // This pass enforces one direction of that — no bubble without a shield. The
  // other direction (no shield without a bubble) is enforced in despawnEntityAt,
  // which is the only place that catches the ttl pass below as well as this one.
  // Enforcing it here instead would have left the ttl pass, three lines down, free
  // to retire a bubble and strand the flag.
  for (let i = state.entityCount - 1; i >= 0; i--) {
    const e = state.entities[i]
    if (e.kind !== 'bubble') continue
    const owner = kartById(state, e.ownerId)
    if (owner === null || !owner.shielded) despawnEntityAt(ctx, state, i, events)
  }

  for (let i = state.entityCount - 1; i >= 0; i--) {
    const e = state.entities[i]
    e.ttl -= 1
    if (e.ttl <= 0) despawnEntityAt(ctx, state, i, events)
  }
}

/**
 * True when some live surge field, cast by a kart placed behind `playerId`,
 * is slowing it. Placement is read live, so a kart that drops behind the
 * caster stops being slowed. Task 6's targetSpeedFor multiplies by
 * tuning.surgeSpeedMul when this is true.
 */
export function surgeActiveOn(state: SimState, playerId: number): boolean {
  if (playerId < 0 || playerId >= MAX_KARTS) return false

  let anySurge = false
  for (let i = 0; i < state.entityCount; i++) {
    if (state.entities[i].kind === 'surge') {
      anySurge = true
      break
    }
  }
  if (!anySurge) return false // the common case: no sort at all

  computePlacement(state, placeIndexOf, placeOrder)
  const mine = placeIndexOf[playerId]
  for (let i = 0; i < state.entityCount; i++) {
    const e = state.entities[i]
    if (e.kind !== 'surge') continue
    if (e.ownerId === playerId) continue
    if (e.ownerId < 0 || e.ownerId >= MAX_KARTS) continue
    if (mine < placeIndexOf[e.ownerId]) return true // lower place is further ahead
  }
  return false
}
