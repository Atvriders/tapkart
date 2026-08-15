// PURE (contract §0a): no DOM, no GPU, no clock, no `three` import — not even a
// type-only one (§8.2). These are the view structs `game` fills and `render` reads,
// and they are the entire game -> render handoff (§4.2). `render` never holds a
// SimState and imports nothing that can write one.
import type { EntityKind, ItemKind, RacePhase, Surface, Vec3 } from '@tapkart/sim'
import { MAX_ENTITIES, MAX_KARTS, v3 } from '@tapkart/sim'

/** The session's role, named once, in the lowest package that needs it. `game`
 *  imports this type rather than declaring a second union. There is no `SessionRole`. */
export type ViewRole = 'host' | 'guest' | 'solo'

/** Where a seat's transform came from. §7.1 is the full rule and
 *  `viewSourceViolations` is its executable form. */
export type ViewSource = 'authoritative' | 'predicted' | 'interpolated' | 'absent'

export interface KartView {
  playerId: number
  characterIdx: number // from the session, never from the wire
  source: ViewSource
  position: Vec3 // metres, world
  heading: number // radians, wrapped to (-pi, pi]
  velocity: Vec3 // m/s
  angularVelocity: number // rad/s
  speed: number // m/s, PLAN VIEW: hypot(velocity.x, velocity.z)
  s: number // arc-normalised [0, 1), NEVER metres
  bankAngle: number // radians, track banking under the kart
  driftActive: boolean
  driftDir: -1 | 0 | 1
  driftCharge: number // ticks
  driftTier: number // sim's encoding: -1 none, 0..2 index into driftBoosts
  airborne: boolean
  surface: Surface
  spinOutTicks: number
  invulnTicks: number
  boostTicks: number
  respawnTicks: number
  shielded: boolean
  item: ItemKind
  lap: number // 0-based, exactly KartState.lap.lap
  checkpointIdx: number
  t: number
  place: number // 0-based; 0 = leader
  isBot: boolean
  connected: boolean
}

export interface EntityView {
  entityId: number // -1 in an unused slot
  kind: EntityKind
  ownerId: number
  source: ViewSource
  position: Vec3
  velocity: Vec3
  heading: number
  ttl: number // ticks
}

/** No `source` field, deliberately: item boxes have no authoritative wire form at
 *  all, so there is nothing for §7.1 to police. Availability is `respawnTicks === 0`
 *  and is never stored twice. */
export interface ItemBoxView {
  boxIdx: number
  position: Vec3 // from itemBoxWorldPos, verbatim
  respawnTicks: number
}

export interface RaceView {
  tick: number
  alpha: number // sub-tick fraction, [0, 1)
  phase: RacePhase
  localPlayerId: number // -1 for a spectator or a replay; never -1 for a guest
  raceStartTick: number
  karts: KartView[] // always length MAX_KARTS, indexed BY SEAT: karts[i].playerId === i
  entities: EntityView[] // always length MAX_ENTITIES, live packed at front
  entityCount: number
  itemBoxes: ItemBoxView[] // length = ctx.track.itemBoxes.length
  itemBoxRespawnTicks: number // ctx.tuning.itemBoxRespawnTicks
  finishedOrder: number[] // length MAX_KARTS, -1 in unfilled slots
  finishTick: number // -1 until the first kart finishes
  countdownTicksLeft: number // 0 once racing
}

/**
 * Allocates one fully-populated RaceView with every array at its fixed length and
 * every Vec3 distinct. Called once per session, never per frame.
 *
 * Defaults are deliberately *unfilled* rather than plausible: every source is
 * 'absent', every place is 0 and every driftTier is -1, so a ViewBuilder that forgets
 * to write a seat produces a view that `viewSourceViolations` rejects instead of one
 * that merely looks slightly wrong.
 */
export function createRaceView(itemBoxCount: number): RaceView {
  const karts: KartView[] = []
  for (let i = 0; i < MAX_KARTS; i++) {
    karts.push({
      playerId: i,
      characterIdx: 0,
      source: 'absent',
      position: v3(0, 0, 0),
      heading: 0,
      velocity: v3(0, 0, 0),
      angularVelocity: 0,
      speed: 0,
      s: 0,
      bankAngle: 0,
      driftActive: false,
      driftDir: 0,
      driftCharge: 0,
      driftTier: -1,
      airborne: false,
      surface: 'tarmac',
      spinOutTicks: 0,
      invulnTicks: 0,
      boostTicks: 0,
      respawnTicks: 0,
      shielded: false,
      item: 'none',
      lap: 0,
      checkpointIdx: 0,
      t: 0,
      place: 0,
      isBot: false,
      connected: false,
    })
  }
  const entities: EntityView[] = []
  for (let j = 0; j < MAX_ENTITIES; j++) {
    entities.push({
      entityId: -1,
      // `kind` is meaningless in an unused slot: `entityId === -1` is the liveness flag.
      kind: 'seeker',
      ownerId: -1,
      source: 'absent',
      position: v3(0, 0, 0),
      velocity: v3(0, 0, 0),
      heading: 0,
      ttl: 0,
    })
  }
  const itemBoxes: ItemBoxView[] = []
  for (let b = 0; b < itemBoxCount; b++) {
    itemBoxes.push({ boxIdx: b, position: v3(0, 0, 0), respawnTicks: 0 })
  }
  const finishedOrder: number[] = []
  for (let i = 0; i < MAX_KARTS; i++) finishedOrder.push(-1)
  return {
    tick: 0,
    alpha: 0,
    phase: 'countdown',
    localPlayerId: -1,
    raceStartTick: 0,
    karts,
    entities,
    entityCount: 0,
    itemBoxes,
    itemBoxRespawnTicks: 0,
    finishedOrder,
    finishTick: -1,
    countdownTicksLeft: 0,
  }
}

/** `'a' or 'b'` — the exact `expected` rendering §7.1 specifies. */
function expectedList(sources: readonly ViewSource[]): string {
  return sources.map((s) => `'${s}'`).join(' or ')
}

/**
 * [] when the view obeys §7.1; otherwise one string per violating seat or slot, in the
 * exact format §7.1 specifies. Exported (not test-only) because the CI honesty test and
 * the dev-build assertion (Q32) must run the same code rather than two readings of one
 * table. Allocates; never called in the frame path of a production build.
 */
export function viewSourceViolations(view: RaceView, role: ViewRole): string[] {
  const out: string[] = []

  // 1. Local seat identity. No per-seat check is meaningful without a local seat.
  if (role === 'guest' && !(view.localPlayerId >= 0 && view.localPlayerId < MAX_KARTS)) {
    out.push(`localPlayerId ${view.localPlayerId} is illegal for role 'guest'`)
    return out
  }

  // 2. Karts, ascending seat index. A host's AuthorityLoop.state() IS the authority, so
  //    drawing every seat from it is legal; what is forbidden is a guest drawing another
  //    player's seat from its own prediction, which is the sim's bot AI driving that seat.
  for (let i = 0; i < MAX_KARTS; i++) {
    let allowed: ViewSource[]
    if (role === 'guest') {
      allowed = i === view.localPlayerId ? ['predicted'] : ['interpolated', 'absent']
    } else {
      allowed = ['authoritative']
    }
    const actual = view.karts[i].source
    if (!allowed.includes(actual)) {
      out.push(
        `kart[${i}]: source '${actual}' is illegal for role '${role}' ` +
          `(expected ${expectedList(allowed)})`,
      )
    }
  }

  // 3. Entities, ascending slot. Live slots are packed at the front.
  for (let j = 0; j < MAX_ENTITIES; j++) {
    const e = view.entities[j]
    const live = j < view.entityCount
    let allowed: ViewSource[]
    if (!live) allowed = ['absent']
    else allowed = role === 'guest' ? ['interpolated'] : ['authoritative']
    if (!allowed.includes(e.source)) {
      out.push(
        `entity[${j}] (id ${e.entityId}): source '${e.source}' is illegal for role '${role}' ` +
          `(expected ${expectedList(allowed)})`,
      )
    }
    if ((live && e.entityId < 0) || (!live && e.entityId >= 0)) {
      out.push(
        `entity[${j}]: entityId ${e.entityId} is illegal at slot ${j} ` +
          `with entityCount ${view.entityCount}`,
      )
    }
  }

  return out
}
