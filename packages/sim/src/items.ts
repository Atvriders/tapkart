import type { AuthEvent, ItemKind, KartState, SimContext, SimState, Vec3 } from './types'
import { MAX_KARTS } from './types'
import { clamp } from './mathutil'
import { rngAt } from './rng'
import { v3, v3len } from './vec3'
import { emit } from './state'
import { computePlacement } from './placement'
import { kartById, spawnEntity } from './entity'

/** Item columns, in the fixed order every row of ITEM_WEIGHTS uses. */
export const ITEM_ROLL_ORDER: readonly ItemKind[] = [
  'boost', 'seeker', 'bolt', 'slick', 'bubble', 'surge', 'blink', 'charge',
]

/** Every row of ITEM_WEIGHTS sums to exactly this. */
export const ITEM_WEIGHT_TOTAL = 100

/**
 * Row = the picker's 0-based placement (0 = 1st). Column = ITEM_ROLL_ORDER.
 *
 * The front of the field draws defensive items it can sit on (slick, bubble);
 * the back draws catch-up items (boost, bolt, surge). surge is unreachable in
 * 1st and heaviest in 8th. charge is flat at 8 everywhere so every placement
 * keeps one close-quarters answer. Every row sums to ITEM_WEIGHT_TOTAL.
 */
export const ITEM_WEIGHTS: readonly (readonly number[])[] = [
  //         boost seeker bolt slick bubble surge blink charge
  /* 1st */ [   10,    10,   6,   30,    24,    0,   12,     8],
  /* 2nd */ [   14,    16,   8,   24,    20,    2,    8,     8],
  /* 3rd */ [   16,    20,  10,   18,    16,    4,    8,     8],
  /* 4th */ [   18,    22,  12,   14,    12,    6,    8,     8],
  /* 5th */ [   20,    22,  14,   10,    10,   10,    6,     8],
  /* 6th */ [   22,    20,  16,    6,     8,   14,    6,     8],
  /* 7th */ [   24,    16,  18,    4,     6,   18,    6,     8],
  /* 8th */ [   26,    12,  20,    2,     4,   22,    6,     8],
]

/**
 * Pure roll -> item mapping. `r` is expected in [0, 1); anything at or above 1
 * falls through to the last column, which is non-zero in every row.
 */
export function itemForRoll(placeIdx: number, r: number): ItemKind {
  const row = ITEM_WEIGHTS[clamp(Math.floor(placeIdx), 0, MAX_KARTS - 1)]
  const target = r * ITEM_WEIGHT_TOTAL
  let acc = 0
  for (let i = 0; i < row.length; i++) {
    acc += row[i]
    if (target < acc) return ITEM_ROLL_ORDER[i]
  }
  return ITEM_ROLL_ORDER[ITEM_ROLL_ORDER.length - 1]
}

// Placement scratch. computePlacement fills both arrays; they are module-level
// because item logic runs every tick and step() must not allocate.
const placeIndexScratch = new Int32Array(MAX_KARTS)
const placeOrderScratch = new Int32Array(MAX_KARTS)

/** 0-based placement of one kart: 0 is the race leader. */
export function placeIndexOf(state: SimState, playerId: number): number {
  computePlacement(state, placeIndexScratch, placeOrderScratch)
  if (playerId < 0 || playerId >= MAX_KARTS) return MAX_KARTS - 1
  return placeIndexScratch[playerId]
}

/**
 * The single point where the race PRNG is consumed. Only a leader authority
 * rolls: a follower returns 'none' and leaves state.rngCursor exactly as it
 * found it, and takes its item from an incoming 'itemGrant' AuthEvent via
 * applyItemGrant instead.
 */
export function rollItem(ctx: SimContext, state: SimState, placeIdx: number): ItemKind {
  if (!ctx.isLeader) return 'none'
  const r = rngAt(state.raceSeed, state.rngCursor)
  state.rngCursor = state.rngCursor + 1
  return itemForRoll(placeIdx, r)
}

/** Plan-view pickup radius of an item box, in metres. */
export const ITEM_BOX_RADIUS = 1.6

// Hot-path scratch. Never returned, never retained across calls.
const boxPosScratch: Vec3 = v3(0, 0, 0)
const rightScratch: Vec3 = v3(0, 0, 0)

/**
 * World position of track item box `boxIdx`, written into `out`.
 * right = (-t.z, 0, t.x) normalized, and positive lateral is right of travel.
 */
export function itemBoxWorldPos(ctx: SimContext, boxIdx: number, out: Vec3): void {
  const box = ctx.track.itemBoxes[boxIdx]
  const tp = ctx.query.sampleAt(box.s)
  // Read the sample immediately: TrackQuery may hand back a shared scratch.
  const px = tp.position.x
  const py = tp.position.y
  const pz = tp.position.z
  const t = ctx.query.tangentAt(box.s)
  rightScratch.x = -t.z
  rightScratch.y = 0
  rightScratch.z = t.x
  const len = v3len(rightScratch) || 1
  out.x = px + (rightScratch.x / len) * box.lateral
  out.y = py
  out.z = pz + (rightScratch.z / len) * box.lateral
}

/**
 * Ticks every box timer and detects pickups. Pickup is plan-view (x/z only) so
 * a kart hopping or ramp-launched over a box still collects it, and so pickup
 * never depends on ground height.
 *
 * On a leader this rolls the item and emits 'itemGrant'. On a follower it does
 * everything except the roll: the box timer still starts, the cursor is never
 * touched, and the item arrives later through applyItemGrant.
 */
export function updateItemBoxes(ctx: SimContext, state: SimState, events: AuthEvent[]): void {
  const reach = ITEM_BOX_RADIUS + ctx.tuning.kartRadius
  const reachSq = reach * reach
  for (let b = 0; b < state.itemBoxes.length; b++) {
    const box = state.itemBoxes[b]
    if (box.respawnTicks > 0) {
      box.respawnTicks--
      continue
    }
    itemBoxWorldPos(ctx, box.boxIdx, boxPosScratch)
    for (let i = 0; i < state.karts.length; i++) {
      const k = state.karts[i]
      if (k.respawnTicks > 0) continue
      if (k.item !== 'none') continue
      const dx = k.position.x - boxPosScratch.x
      const dz = k.position.z - boxPosScratch.z
      if (dx * dx + dz * dz > reachSq) continue
      box.respawnTicks = ctx.tuning.itemBoxRespawnTicks
      if (ctx.isLeader) {
        const item = rollItem(ctx, state, placeIndexOf(state, k.playerId))
        k.item = item
        emit(state, events, 'itemGrant', k.playerId, -1, item, box.boxIdx)
      }
      break // one box yields one item per tick
    }
  }
}

/**
 * Follower path for an authoritative item grant. `ev.data` carries the boxIdx,
 * so a follower that missed the local pickup (fresh join, post-resync) still
 * puts the box on its respawn timer.
 */
export function applyItemGrant(ctx: SimContext, state: SimState, ev: AuthEvent): void {
  if (ev.kind !== 'itemGrant') return
  const k = kartById(state, ev.playerId)
  if (k === null) return
  k.item = ev.item
  const idx = ev.data
  if (idx >= 0 && idx < state.itemBoxes.length) {
    const box = state.itemBoxes[idx]
    if (box.respawnTicks <= 0) box.respawnTicks = ctx.tuning.itemBoxRespawnTicks
  }
}

/** Speed burst from the boost item, in ticks (1.5 s at 60 Hz). */
export const ITEM_BOOST_TICKS = 90
/** Speed burst from blink, in ticks (0.75 s). */
export const BLINK_BOOST_TICKS = 45
/** Invulnerability from blink, in ticks (1.5 s). */
export const BLINK_INVULN_TICKS = 90
/** Lifetime of a surge field, in ticks (5 s). */
export const SURGE_TTL_TICKS = 300
/** Lifetime of a charge blast, in ticks (1/3 s). */
export const CHARGE_TTL_TICKS = 20
/** Muzzle offset ahead of the kart for fired projectiles, in metres. */
export const ITEM_FIRE_OFFSET = 2
/** Drop offset behind the kart for dropped hazards, in metres. */
export const ITEM_DROP_OFFSET = 2

const spawnPosScratch: Vec3 = v3(0, 0, 0)

/** playerId one place ahead of `playerId`, or -1 if it is already leading. */
export function seekerTargetFor(state: SimState, playerId: number): number {
  computePlacement(state, placeIndexScratch, placeOrderScratch)
  if (playerId < 0 || playerId >= MAX_KARTS) return -1
  const place = placeIndexScratch[playerId]
  return place <= 0 ? -1 : placeOrderScratch[place - 1]
}

/**
 * spawnEntity takes no velocity, so set it here from the firing heading. The
 * entity is found by scanning the live prefix backwards: it was just appended,
 * so this exits on the first comparison in practice.
 */
function setEntityVelocity(state: SimState, entityId: number, vx: number, vz: number): void {
  if (entityId === -1) return
  for (let i = state.entityCount - 1; i >= 0; i--) {
    const e = state.entities[i]
    if (e.entityId === entityId) {
      e.velocity.x = vx
      e.velocity.y = 0
      e.velocity.z = vz
      return
    }
  }
}

/**
 * Consumes the kart's held item and applies its effect. Covers all eight kinds.
 * Emits nothing itself: spawnEntity owns the 'entitySpawn' event.
 *
 * Not gated on ctx.isLeader — every authority and every follower runs the same
 * entity simulation. Only the *roll* is leader-only.
 *
 * Called from canonical slot 2.5, i.e. after updateRecovery and before stepKart.
 * The guard below only works from there: it has to see *this* tick's recovery
 * state, and `boostTicks` written from an earlier slot than 2 would be zeroed by
 * `beginRespawn` on the tick a kart leaves the track — item spent, effect gone.
 */
export function useItem(ctx: SimContext, state: SimState, k: KartState, events: AuthEvent[]): void {
  const item = k.item
  if (item === 'none') return
  // A spun-out or respawning kart holds on to its item rather than wasting it.
  // This is `steeringLocked`, which is strictly stronger than `motionLocked`, so
  // it also discharges slot 2.5's obligation under the motion-lock rule (step.ts).
  if (k.spinOutTicks > 0 || k.respawnTicks > 0) return

  k.item = 'none'
  const t = ctx.tuning
  const fx = Math.cos(k.heading)
  const fz = Math.sin(k.heading)

  if (item === 'boost') {
    if (k.boostTicks < ITEM_BOOST_TICKS) k.boostTicks = ITEM_BOOST_TICKS
    return
  }

  if (item === 'blink') {
    if (k.boostTicks < BLINK_BOOST_TICKS) k.boostTicks = BLINK_BOOST_TICKS
    if (k.invulnTicks < BLINK_INVULN_TICKS) k.invulnTicks = BLINK_INVULN_TICKS
    return
  }

  if (item === 'seeker') {
    spawnPosScratch.x = k.position.x + fx * ITEM_FIRE_OFFSET
    spawnPosScratch.y = k.position.y
    spawnPosScratch.z = k.position.z + fz * ITEM_FIRE_OFFSET
    const id = spawnEntity(state, 'seeker', k.playerId, spawnPosScratch, k.heading,
      seekerTargetFor(state, k.playerId), t.entityTtl, events)
    setEntityVelocity(state, id, fx * t.seekerSpeed, fz * t.seekerSpeed)
    return
  }

  if (item === 'bolt') {
    spawnPosScratch.x = k.position.x + fx * ITEM_FIRE_OFFSET
    spawnPosScratch.y = k.position.y
    spawnPosScratch.z = k.position.z + fz * ITEM_FIRE_OFFSET
    const id = spawnEntity(state, 'bolt', k.playerId, spawnPosScratch, k.heading,
      -1, t.entityTtl, events)
    setEntityVelocity(state, id, fx * t.boltSpeed, fz * t.boltSpeed)
    return
  }

  if (item === 'slick') {
    spawnPosScratch.x = k.position.x - fx * ITEM_DROP_OFFSET
    spawnPosScratch.y = k.position.y
    spawnPosScratch.z = k.position.z - fz * ITEM_DROP_OFFSET
    const id = spawnEntity(state, 'slick', k.playerId, spawnPosScratch, k.heading,
      -1, t.entityTtl, events)
    setEntityVelocity(state, id, 0, 0)
    return
  }

  if (item === 'bubble') {
    spawnPosScratch.x = k.position.x
    spawnPosScratch.y = k.position.y
    spawnPosScratch.z = k.position.z
    const id = spawnEntity(state, 'bubble', k.playerId, spawnPosScratch, k.heading,
      k.playerId, t.entityTtl, events)
    setEntityVelocity(state, id, 0, 0)
    if (id !== -1) k.shielded = true
    return
  }

  if (item === 'surge') {
    spawnPosScratch.x = k.position.x
    spawnPosScratch.y = k.position.y
    spawnPosScratch.z = k.position.z
    const id = spawnEntity(state, 'surge', k.playerId, spawnPosScratch, k.heading,
      -1, SURGE_TTL_TICKS, events)
    setEntityVelocity(state, id, 0, 0)
    return
  }

  if (item === 'charge') {
    spawnPosScratch.x = k.position.x
    spawnPosScratch.y = k.position.y
    spawnPosScratch.z = k.position.z
    const id = spawnEntity(state, 'charge', k.playerId, spawnPosScratch, k.heading,
      -1, CHARGE_TTL_TICKS, events)
    setEntityVelocity(state, id, 0, 0)
  }
}
