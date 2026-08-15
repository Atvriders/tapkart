import type {
  AuthEvent,
  AuthEventKind,
  EntityState,
  Intent,
  ItemBoxState,
  ItemKind,
  KartState,
  SimContext,
  SimState,
} from './types'
import { MAX_ENTITIES, MAX_KARTS } from './types'
import { clamp, wrapAngle } from './mathutil'
import { v3 } from './vec3'

/**
 * Build a fresh race state with every array preallocated to its fixed length.
 *
 * `characterIdx[i]` selects the character for seat `i`; entries that are missing,
 * non-finite, or out of range are truncated and clamped into
 * `[0, ctx.characters.length - 1]`.
 *
 * Karts are placed from `ctx.track.startPositions` using the locked conventions:
 *   right   = (-t.z, 0, t.x), normalized
 *   heading = wrapAngle(atan2(t.z, t.x))
 *   y       = ctx.query.groundHeight(s, lateral)
 * Every `s` here is arc-normalized to [0, 1), never metres.
 * If the track declares fewer start positions than MAX_KARTS, the last one is
 * reused for the remaining seats; if it declares none, seats sit at s = 0.
 */
export function createState(ctx: SimContext, seed: number, characterIdx: number[]): SimState {
  const charCount = ctx.characters.length
  const spCount = ctx.track.startPositions.length

  // A kart on the grid is behind checkpoint 0, i.e. already credited with the
  // last checkpoint of the notional previous lap, so Task 11's
  // `next = cur + 1 >= n ? 0 : cur + 1` targets checkpoint 0 first. A track with
  // no checkpoints has no last index; -1 is written explicitly for that case.
  const cpCount = ctx.track.checkpointS.length
  const initialCheckpointIdx = cpCount > 0 ? cpCount - 1 : -1

  const karts: KartState[] = []
  for (let i = 0; i < MAX_KARTS; i++) {
    const rawIdx = Number(characterIdx[i])
    const ci = Number.isFinite(rawIdx) ? clamp(Math.trunc(rawIdx), 0, charCount - 1) : 0

    const sp = spCount > 0 ? ctx.track.startPositions[Math.min(i, spCount - 1)] : undefined
    const s = sp ? sp.s : 0
    const lateral = sp ? sp.lateral : 0

    const pt = ctx.query.sampleAt(s)
    const tan = ctx.query.tangentAt(s)
    // right = (-t.z, 0, t.x), normalized. Locked convention: +lateral is right.
    const rx = -tan.z
    const rz = tan.x
    const rlen = Math.sqrt(rx * rx + rz * rz)
    const inv = rlen > 0 ? 1 / rlen : 0

    karts.push({
      playerId: i,
      characterIdx: ci,
      isBot: true,
      connected: false,
      position: v3(
        pt.position.x + rx * inv * lateral,
        ctx.query.groundHeight(s, lateral),
        pt.position.z + rz * inv * lateral,
      ),
      velocity: v3(0, 0, 0),
      heading: wrapAngle(Math.atan2(tan.z, tan.x)),
      angularVelocity: 0,
      drift: { active: false, dir: 0, charge: 0 },
      item: 'none',
      airborne: false,
      surface: ctx.query.surfaceAt(s, lateral),
      spinOutTicks: 0,
      invulnTicks: 0,
      boostTicks: 0,
      respawnTicks: 0,
      shielded: false,
      lap: { lap: 0, checkpointIdx: initialCheckpointIdx, t: 0 },
    })
  }

  const entities: EntityState[] = []
  for (let i = 0; i < MAX_ENTITIES; i++) {
    entities.push({
      entityId: -1, // dead-slot sentinel
      kind: 'seeker', // meaningless while entityId === -1, but still copied/compared
      ownerId: -1,
      position: v3(0, 0, 0),
      velocity: v3(0, 0, 0),
      heading: 0,
      targetId: -1,
      ttl: 0,
    })
  }

  const itemBoxes: ItemBoxState[] = []
  for (let i = 0; i < ctx.track.itemBoxes.length; i++) {
    itemBoxes.push({ boxIdx: i, respawnTicks: 0 })
  }

  // Fixed length MAX_KARTS, every slot -1. Tasks 11 and 15 write a finisher into
  // the first slot holding -1; nothing ever pushes, pops or resizes this array,
  // because cloneState below rejects a dst whose lengths differ from src's.
  const finishedOrder: number[] = []
  for (let i = 0; i < MAX_KARTS; i++) {
    finishedOrder.push(-1)
  }

  // Plan 2 Task 1: the 30Hz bot-input hold, formerly module scope in phase.ts,
  // now lives here so two SimStates in one process never share it.
  // heldBotTick[i] === -1 means "no held intent"; otherwise it records the EVEN
  // tick the held intent belongs to, exactly as phase.ts's resolveInputs uses it.
  const heldBotIntent: Intent[] = []
  const heldBotTick: number[] = []
  for (let i = 0; i < MAX_KARTS; i++) {
    heldBotIntent.push({ tick: 0, steer: 0, accel: 0, brake: false, drift: false, useItem: false })
    heldBotTick.push(-1)
  }

  return {
    tick: 0,
    phase: 'countdown',
    raceSeed: seed,
    rngCursor: 0,
    nextEventSeq: 0,
    finishTick: -1,
    karts,
    entities,
    entityCount: 0,
    nextEntityId: 1,
    itemBoxes,
    finishedOrder,
    heldBotIntent,
    heldBotTick,
  }
}

/**
 * Deep-copy `src` into the already-allocated `dst`. Allocates nothing: every
 * object in `dst` is written field by field and reused.
 *
 * All six arrays must already match in length — `karts` (MAX_KARTS),
 * `entities` (MAX_ENTITIES), `itemBoxes` (the track's item-box count),
 * `finishedOrder`, `heldBotIntent` and `heldBotTick` (all MAX_KARTS) — which is
 * checked once up front and throws otherwise. That check is what forbids
 * `finishedOrder.push(...)` anywhere in the sim: a 9th entry would make every
 * subsequent clone throw.
 */
export function cloneState(src: SimState, dst: SimState): void {
  if (
    dst.karts.length !== src.karts.length ||
    dst.entities.length !== src.entities.length ||
    dst.itemBoxes.length !== src.itemBoxes.length ||
    dst.finishedOrder.length !== src.finishedOrder.length ||
    dst.heldBotIntent.length !== src.heldBotIntent.length ||
    dst.heldBotTick.length !== src.heldBotTick.length
  ) {
    throw new Error('cloneState: dst was not preallocated with the same shape as src')
  }

  dst.tick = src.tick
  dst.phase = src.phase
  dst.raceSeed = src.raceSeed
  dst.rngCursor = src.rngCursor
  dst.nextEventSeq = src.nextEventSeq
  dst.finishTick = src.finishTick
  dst.entityCount = src.entityCount
  dst.nextEntityId = src.nextEntityId

  for (let i = 0; i < src.karts.length; i++) {
    const a = src.karts[i]
    const b = dst.karts[i]
    b.playerId = a.playerId
    b.characterIdx = a.characterIdx
    b.isBot = a.isBot
    b.connected = a.connected
    b.position.x = a.position.x
    b.position.y = a.position.y
    b.position.z = a.position.z
    b.velocity.x = a.velocity.x
    b.velocity.y = a.velocity.y
    b.velocity.z = a.velocity.z
    b.heading = a.heading
    b.angularVelocity = a.angularVelocity
    b.drift.active = a.drift.active
    b.drift.dir = a.drift.dir
    b.drift.charge = a.drift.charge
    b.item = a.item
    b.airborne = a.airborne
    b.surface = a.surface
    b.spinOutTicks = a.spinOutTicks
    b.invulnTicks = a.invulnTicks
    b.boostTicks = a.boostTicks
    b.respawnTicks = a.respawnTicks
    b.shielded = a.shielded
    b.lap.lap = a.lap.lap
    b.lap.checkpointIdx = a.lap.checkpointIdx
    b.lap.t = a.lap.t
  }

  for (let i = 0; i < src.entities.length; i++) {
    const a = src.entities[i]
    const b = dst.entities[i]
    b.entityId = a.entityId
    b.kind = a.kind
    b.ownerId = a.ownerId
    b.position.x = a.position.x
    b.position.y = a.position.y
    b.position.z = a.position.z
    b.velocity.x = a.velocity.x
    b.velocity.y = a.velocity.y
    b.velocity.z = a.velocity.z
    b.heading = a.heading
    b.targetId = a.targetId
    b.ttl = a.ttl
  }

  for (let i = 0; i < src.itemBoxes.length; i++) {
    dst.itemBoxes[i].boxIdx = src.itemBoxes[i].boxIdx
    dst.itemBoxes[i].respawnTicks = src.itemBoxes[i].respawnTicks
  }

  for (let i = 0; i < src.finishedOrder.length; i++) {
    dst.finishedOrder[i] = src.finishedOrder[i]
  }

  for (let i = 0; i < src.heldBotIntent.length; i++) {
    const a = src.heldBotIntent[i]
    const b = dst.heldBotIntent[i]
    b.tick = a.tick
    b.steer = a.steer
    b.accel = a.accel
    b.brake = a.brake
    b.drift = a.drift
    b.useItem = a.useItem
    dst.heldBotTick[i] = src.heldBotTick[i]
  }
}

/**
 * Bit-exact structural equality. Every scalar is compared with `Object.is`, so
 * -0 !== 0 and NaN === NaN. Dead entity slots are compared too: despawn leaves
 * deterministic residue, and the checkpoint-replay equivalence test depends on
 * that residue matching.
 */
export function statesEqual(a: SimState, b: SimState): boolean {
  if (
    !Object.is(a.tick, b.tick) ||
    !Object.is(a.phase, b.phase) ||
    !Object.is(a.raceSeed, b.raceSeed) ||
    !Object.is(a.rngCursor, b.rngCursor) ||
    !Object.is(a.nextEventSeq, b.nextEventSeq) ||
    !Object.is(a.finishTick, b.finishTick) ||
    !Object.is(a.entityCount, b.entityCount) ||
    !Object.is(a.nextEntityId, b.nextEntityId)
  ) {
    return false
  }
  if (
    a.karts.length !== b.karts.length ||
    a.entities.length !== b.entities.length ||
    a.itemBoxes.length !== b.itemBoxes.length ||
    a.finishedOrder.length !== b.finishedOrder.length ||
    a.heldBotIntent.length !== b.heldBotIntent.length ||
    a.heldBotTick.length !== b.heldBotTick.length
  ) {
    return false
  }

  for (let i = 0; i < a.karts.length; i++) {
    const x = a.karts[i]
    const y = b.karts[i]
    if (
      !Object.is(x.playerId, y.playerId) ||
      !Object.is(x.characterIdx, y.characterIdx) ||
      !Object.is(x.isBot, y.isBot) ||
      !Object.is(x.connected, y.connected) ||
      !Object.is(x.position.x, y.position.x) ||
      !Object.is(x.position.y, y.position.y) ||
      !Object.is(x.position.z, y.position.z) ||
      !Object.is(x.velocity.x, y.velocity.x) ||
      !Object.is(x.velocity.y, y.velocity.y) ||
      !Object.is(x.velocity.z, y.velocity.z) ||
      !Object.is(x.heading, y.heading) ||
      !Object.is(x.angularVelocity, y.angularVelocity) ||
      !Object.is(x.drift.active, y.drift.active) ||
      !Object.is(x.drift.dir, y.drift.dir) ||
      !Object.is(x.drift.charge, y.drift.charge) ||
      !Object.is(x.item, y.item) ||
      !Object.is(x.airborne, y.airborne) ||
      !Object.is(x.surface, y.surface) ||
      !Object.is(x.spinOutTicks, y.spinOutTicks) ||
      !Object.is(x.invulnTicks, y.invulnTicks) ||
      !Object.is(x.boostTicks, y.boostTicks) ||
      !Object.is(x.respawnTicks, y.respawnTicks) ||
      !Object.is(x.shielded, y.shielded) ||
      !Object.is(x.lap.lap, y.lap.lap) ||
      !Object.is(x.lap.checkpointIdx, y.lap.checkpointIdx) ||
      !Object.is(x.lap.t, y.lap.t)
    ) {
      return false
    }
  }

  for (let i = 0; i < a.entities.length; i++) {
    const x = a.entities[i]
    const y = b.entities[i]
    if (
      !Object.is(x.entityId, y.entityId) ||
      !Object.is(x.kind, y.kind) ||
      !Object.is(x.ownerId, y.ownerId) ||
      !Object.is(x.position.x, y.position.x) ||
      !Object.is(x.position.y, y.position.y) ||
      !Object.is(x.position.z, y.position.z) ||
      !Object.is(x.velocity.x, y.velocity.x) ||
      !Object.is(x.velocity.y, y.velocity.y) ||
      !Object.is(x.velocity.z, y.velocity.z) ||
      !Object.is(x.heading, y.heading) ||
      !Object.is(x.targetId, y.targetId) ||
      !Object.is(x.ttl, y.ttl)
    ) {
      return false
    }
  }

  for (let i = 0; i < a.itemBoxes.length; i++) {
    if (
      !Object.is(a.itemBoxes[i].boxIdx, b.itemBoxes[i].boxIdx) ||
      !Object.is(a.itemBoxes[i].respawnTicks, b.itemBoxes[i].respawnTicks)
    ) {
      return false
    }
  }

  for (let i = 0; i < a.finishedOrder.length; i++) {
    if (!Object.is(a.finishedOrder[i], b.finishedOrder[i])) {
      return false
    }
  }

  for (let i = 0; i < a.heldBotIntent.length; i++) {
    const x = a.heldBotIntent[i]
    const y = b.heldBotIntent[i]
    if (
      !Object.is(x.tick, y.tick) ||
      !Object.is(x.steer, y.steer) ||
      !Object.is(x.accel, y.accel) ||
      !Object.is(x.brake, y.brake) ||
      !Object.is(x.drift, y.drift) ||
      !Object.is(x.useItem, y.useItem) ||
      !Object.is(a.heldBotTick[i], b.heldBotTick[i])
    ) {
      return false
    }
  }

  return true
}

/**
 * Append an authoritative event, stamping it with the state's monotonic
 * `nextEventSeq` and the state's current `tick`. This is the only allocation in
 * the sim, and it is per-event rather than per-tick.
 *
 * `entityId` is -1 when not applicable, `item` is 'none' when not applicable and
 * `data` is 0 when unused.
 */
export function emit(
  state: SimState,
  out: AuthEvent[],
  kind: AuthEventKind,
  playerId: number,
  entityId: number,
  item: ItemKind,
  data: number,
): void {
  out.push({
    eventSeq: state.nextEventSeq++,
    tick: state.tick,
    kind,
    playerId,
    entityId,
    item,
    data,
  })
}
