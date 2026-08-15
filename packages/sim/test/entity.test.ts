import { describe, it, expect } from 'vitest'
import type {
  AuthEvent, EntityState, Intent, KartState, SimContext, SimState, Track, TrackQuery,
} from '../src/types'
import { MAX_ENTITIES, MAX_KARTS } from '../src/types'
import { makeCharacters, makeTuning } from './fixtures/track-fixtures'
import {
  despawnEntityAt, kartById, spawnEntity, surgeActiveOn, updateEntities,
} from '../src/entity'
import { targetSpeedFor } from '../src/kart'
import { step } from '../src/step'
import { statesEqual } from '../src/state'

// A stub track: a 400 m loop, 20 m wide. The contract fixes `s` as
// arc-normalised [0, 1) everywhere in this package -- never metres -- so
// project() divides x by the lap length and wraps, checkpointS holds
// 0 / 0.25 / 0.5 / 0.75, and sampleAt() multiplies back out to place the
// centreline point. project() follows the locked convention
// right = (-t.z, 0, t.x); for the +X tangent (1,0,0) that is (0,0,1), so
// lateral is +z and the edges are z = +-10.
const TRACK_LEN = 400
const TRACK_WIDTH = 20

const wrap01 = (v: number): number => ((v % 1) + 1) % 1

function stubContext(isLeader = true): SimContext {
  const track: Track = {
    id: 'stub-loop',
    name: 'Stub Loop',
    controlPoints: [],
    checkpointS: [0, 0.25, 0.5, 0.75],
    itemBoxes: [],
    ramps: [],
    boostPads: [],
    startPositions: [],
    bounds: { min: { x: -1000, y: -10, z: -1000 }, max: { x: 2000, y: 10, z: 1000 } },
  }
  const query: TrackQuery = {
    sampleAt: (s) => ({
      position: { x: wrap01(s) * TRACK_LEN, y: 0, z: 0 },
      width: TRACK_WIDTH,
      banking: 0,
      surface: 'tarmac',
    }),
    tangentAt: () => ({ x: 1, y: 0, z: 0 }),
    project: (p) => ({ s: wrap01(p.x / TRACK_LEN), lateral: p.z, distance: Math.abs(p.z) }),
    groundHeight: () => 0,
    surfaceAt: () => 'tarmac',
    isInBounds: (_s, lateral) => Math.abs(lateral) <= TRACK_WIDTH * 0.5,
    checkpointIndexAt: (s) => Math.min(3, Math.floor(wrap01(s) * 4)),
    totalLength: () => TRACK_LEN,
  }
  return { track, query, tuning: makeTuning(), characters: makeCharacters(), isLeader }
}

// Blank karts are parked far down the track (x = 1000 + 10 * playerId) so that
// entity motion tests never trip a collision. Collision tests place karts
// explicitly.
function blankKart(playerId: number): KartState {
  return {
    playerId,
    characterIdx: 0,
    isBot: false,
    connected: true,
    position: { x: 1000 + 10 * playerId, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    heading: 0,
    angularVelocity: 0,
    drift: { active: false, dir: 0, charge: 0 },
    item: 'none',
    airborne: false,
    surface: 'tarmac',
    spinOutTicks: 0,
    invulnTicks: 0,
    boostTicks: 0,
    respawnTicks: 0,
    shielded: false,
    lap: { lap: 0, checkpointIdx: 0, t: 0 },
  }
}

function blankEntity(): EntityState {
  return {
    entityId: -1,
    kind: 'seeker',
    ownerId: -1,
    position: { x: 0, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    heading: 0,
    targetId: -1,
    ttl: 0,
  }
}

/** The empty finishedOrder: fixed length MAX_KARTS, every slot the -1 sentinel. */
function emptyFinishedOrder(): number[] {
  const order: number[] = []
  for (let i = 0; i < MAX_KARTS; i++) order.push(-1)
  return order
}

function blankState(): SimState {
  const karts: KartState[] = []
  for (let i = 0; i < MAX_KARTS; i++) karts.push(blankKart(i))
  const entities: EntityState[] = []
  for (let i = 0; i < MAX_ENTITIES; i++) entities.push(blankEntity())
  return {
    tick: 100,
    phase: 'racing',
    raceSeed: 999,
    rngCursor: 0,
    nextEventSeq: 0,
    finishTick: -1,
    karts,
    entities,
    entityCount: 0,
    nextEntityId: 1,
    itemBoxes: [],
    finishedOrder: emptyFinishedOrder(),
    heldBotIntent: Array.from({ length: MAX_KARTS }, () => (
      { tick: 0, steer: 0, accel: 0, brake: false, drift: false, useItem: false }
    )),
    heldBotTick: new Array<number>(MAX_KARTS).fill(-1),
  }
}

describe('spawnEntity', () => {
  it('appends at the front of the pool, copies the position, wraps the heading and emits entitySpawn', () => {
    const ctx = stubContext()
    const state = blankState()
    const events: AuthEvent[] = []
    const p = { x: 1, y: 0.5, z: 2 }

    // 7 rad wraps into (-PI, PI] as 7 - 2 * PI = 0.7168146928204138
    const id = spawnEntity(ctx, state, 'slick', 4, p, 7, -1, 600, events)

    expect(id).toBe(1)
    expect(state.nextEntityId).toBe(2)
    expect(state.entityCount).toBe(1)
    const e = state.entities[0]
    expect(e.entityId).toBe(1)
    expect(e.kind).toBe('slick')
    expect(e.ownerId).toBe(4)
    expect(e.position.x).toBe(1)
    expect(e.position.y).toBe(0.5)
    expect(e.position.z).toBe(2)
    expect(e.velocity.x).toBe(0)
    expect(e.velocity.y).toBe(0)
    expect(e.velocity.z).toBe(0)
    expect(e.heading).toBeCloseTo(0.7168146928204138, 12)
    expect(e.targetId).toBe(-1)
    expect(e.ttl).toBe(600)

    // the caller's Vec3 must not be aliased into the pool
    p.x = 99
    expect(state.entities[0].position.x).toBe(1)

    expect(events.length).toBe(1)
    expect(events[0].kind).toBe('entitySpawn')
    expect(events[0].playerId).toBe(4)
    expect(events[0].entityId).toBe(1)
    expect(events[0].item).toBe('slick')
    expect(events[0].data).toBe(600) // ttl
    expect(events[0].eventSeq).toBe(0)
    expect(events[0].tick).toBe(100)
  })

  it('drops the spawn and emits nothing when the pool is full', () => {
    const ctx = stubContext()
    const state = blankState()
    const events: AuthEvent[] = []
    for (let i = 0; i < MAX_ENTITIES; i++) {
      const id = spawnEntity(ctx, state, 'bolt', 0, { x: i, y: 0, z: 0 }, 0, -1, 600, events)
      expect(id).toBe(i + 1) // ids run 1..32
    }
    expect(state.entityCount).toBe(MAX_ENTITIES) // 32
    expect(state.nextEntityId).toBe(33)
    expect(events.length).toBe(32)

    const overflow = spawnEntity(ctx, state, 'bolt', 1, { x: 0, y: 0, z: 0 }, 0, -1, 600, events)

    expect(overflow).toBe(-1)
    expect(state.entityCount).toBe(32)
    expect(state.nextEntityId).toBe(33) // not advanced by a dropped spawn
    expect(events.length).toBe(32) // nothing emitted
  })

  it('spawns identically on a follower, but announces nothing', () => {
    const leaderCtx = stubContext()
    const followerCtx = stubContext(false)
    const leaderState = blankState()
    const followerState = blankState()
    const leaderEvents: AuthEvent[] = []
    const followerEvents: AuthEvent[] = []
    const p = { x: 1, y: 0.5, z: 2 }

    const leaderId = spawnEntity(leaderCtx, leaderState, 'slick', 4, p, 7, -1, 600, leaderEvents)
    const followerId = spawnEntity(followerCtx, followerState, 'slick', 4, p, 7, -1, 600, followerEvents)

    expect(followerId).toBe(leaderId)
    expect(followerState.entities[0].position.x).toBe(leaderState.entities[0].position.x)
    expect(followerState.entities[0].heading).toBe(leaderState.entities[0].heading)
    expect(followerState.entityCount).toBe(leaderState.entityCount)
    expect(leaderEvents.length).toBe(1)
    expect(leaderEvents[0].kind).toBe('entitySpawn')
    expect(followerEvents.length).toBe(0)
  })
})

describe('despawnEntityAt', () => {
  it('swap-removes and clears the vacated slot to the canonical dead form', () => {
    const ctx = stubContext()
    const state = blankState()
    const events: AuthEvent[] = []
    spawnEntity(ctx, state, 'slick', 0, { x: 1, y: 0, z: 0 }, 0, -1, 600, events) // id 1, idx 0
    spawnEntity(ctx, state, 'bolt', 1, { x: 2, y: 0, z: 0 }, 0, -1, 600, events) // id 2, idx 1
    spawnEntity(ctx, state, 'seeker', 2, { x: 3, y: 0, z: 0 }, 0.25, 5, 600, events) // id 3, idx 2
    events.length = 0

    despawnEntityAt(ctx, state, 0, events)

    expect(state.entityCount).toBe(2)
    expect(state.entities[0].entityId).toBe(3) // last live entity moved into slot 0
    expect(state.entities[0].kind).toBe('seeker')
    expect(state.entities[0].ownerId).toBe(2)
    expect(state.entities[0].targetId).toBe(5)
    expect(state.entities[1].entityId).toBe(2)
    const dead = state.entities[2]
    expect(dead.entityId).toBe(-1)
    expect(dead.kind).toBe('seeker')
    expect(dead.ownerId).toBe(-1)
    expect(dead.targetId).toBe(-1)
    expect(dead.heading).toBe(0)
    expect(dead.ttl).toBe(0)
    expect(dead.position.x).toBe(0)
    expect(dead.position.y).toBe(0)
    expect(dead.position.z).toBe(0)
    expect(dead.velocity.x).toBe(0)
    expect(dead.velocity.z).toBe(0)

    expect(events.length).toBe(1)
    expect(events[0].kind).toBe('entityDespawn')
    expect(events[0].playerId).toBe(0) // owner of the removed slick
    expect(events[0].entityId).toBe(1)
    expect(events[0].item).toBe('slick')
    expect(events[0].data).toBe(0)
  })

  it('ignores an index outside the live range', () => {
    const ctx = stubContext()
    const state = blankState()
    const events: AuthEvent[] = []
    spawnEntity(ctx, state, 'slick', 0, { x: 1, y: 0, z: 0 }, 0, -1, 600, events)
    events.length = 0

    despawnEntityAt(ctx, state, 1, events)
    despawnEntityAt(ctx, state, -1, events)
    despawnEntityAt(ctx, state, MAX_ENTITIES, events)

    expect(state.entityCount).toBe(1)
    expect(state.entities[0].entityId).toBe(1)
    expect(events.length).toBe(0)
  })

  it('despawns identically on a follower, but announces nothing', () => {
    const leaderCtx = stubContext()
    const followerCtx = stubContext(false)
    const leaderState = blankState()
    const followerState = blankState()
    spawnEntity(leaderCtx, leaderState, 'slick', 0, { x: 1, y: 0, z: 0 }, 0, -1, 600, [])
    spawnEntity(followerCtx, followerState, 'slick', 0, { x: 1, y: 0, z: 0 }, 0, -1, 600, [])
    const leaderEvents: AuthEvent[] = []
    const followerEvents: AuthEvent[] = []

    despawnEntityAt(leaderCtx, leaderState, 0, leaderEvents)
    despawnEntityAt(followerCtx, followerState, 0, followerEvents)

    expect(followerState.entityCount).toBe(leaderState.entityCount)
    expect(followerState.entities[0].entityId).toBe(leaderState.entities[0].entityId)
    expect(leaderEvents.length).toBe(1)
    expect(leaderEvents[0].kind).toBe('entityDespawn')
    expect(followerEvents.length).toBe(0)
  })
})

describe('kartById', () => {
  it('finds a kart by playerId and returns null for anything else', () => {
    const state = blankState()
    const k = kartById(state, 3)
    expect(k).not.toBeNull()
    expect(k?.playerId).toBe(3)
    expect(k?.position.x).toBe(1030) // 1000 + 10 * 3
    expect(kartById(state, 8)).toBeNull()
    expect(kartById(state, -1)).toBeNull()
  })
})

describe('updateEntities ttl', () => {
  it('decrements ttl every tick and despawns at zero', () => {
    const ctx = stubContext()
    const state = blankState()
    const events: AuthEvent[] = []
    const id = spawnEntity(ctx, state, 'slick', 0, { x: 5, y: 0, z: 1 }, 0, -1, 2, events)
    expect(id).toBe(1)
    events.length = 0

    updateEntities(ctx, state, events)

    expect(state.entityCount).toBe(1)
    expect(state.entities[0].ttl).toBe(1) // 2 - 1
    expect(events.length).toBe(0)

    updateEntities(ctx, state, events)

    expect(state.entityCount).toBe(0)
    expect(state.entities[0].entityId).toBe(-1)
    expect(events.length).toBe(1)
    expect(events[0].kind).toBe('entityDespawn')
    expect(events[0].entityId).toBe(1)
    expect(events[0].item).toBe('slick')
  })

  it('expires several entities in one tick without skipping a live slot', () => {
    const ctx = stubContext()
    const state = blankState()
    const events: AuthEvent[] = []
    spawnEntity(ctx, state, 'slick', 0, { x: 1, y: 0, z: 0 }, 0, -1, 1, events) // id 1, expires
    spawnEntity(ctx, state, 'slick', 1, { x: 2, y: 0, z: 0 }, 0, -1, 5, events) // id 2, lives
    spawnEntity(ctx, state, 'slick', 2, { x: 3, y: 0, z: 0 }, 0, -1, 1, events) // id 3, expires
    spawnEntity(ctx, state, 'slick', 3, { x: 4, y: 0, z: 0 }, 0, -1, 5, events) // id 4, lives
    events.length = 0

    updateEntities(ctx, state, events)

    // backwards walk: idx3 ttl 5->4, idx2 expires (id4 swaps down into slot 2),
    // idx1 ttl 5->4, idx0 expires (id4 swaps down into slot 0)
    expect(state.entityCount).toBe(2)
    expect(state.entities[0].entityId).toBe(4)
    expect(state.entities[1].entityId).toBe(2)
    expect(state.entities[0].ttl).toBe(4) // 5 - 1
    expect(state.entities[1].ttl).toBe(4) // 5 - 1
    expect(state.entities[2].entityId).toBe(-1)
    expect(state.entities[3].entityId).toBe(-1)
    expect(events.length).toBe(2)
    expect(events[0].entityId).toBe(3) // the higher index expires first
    expect(events[1].entityId).toBe(1)
  })
})

describe('updateEntities motion', () => {
  it('turns a seeker toward its target at the capped turn rate and flies at seekerSpeed', () => {
    const ctx = stubContext()
    const state = blankState()
    const events: AuthEvent[] = []
    state.karts[3].position.x = 10
    state.karts[3].position.y = 0
    state.karts[3].position.z = 10
    spawnEntity(ctx, state, 'seeker', 0, { x: 0, y: 0.5, z: 0 }, 0, 3, 600, events)
    events.length = 0

    updateEntities(ctx, state, events)

    const e = state.entities[0]
    // desired heading = atan2(10 - 0, 10 - 0) = PI/4 = 0.7853981633974483,
    // capped at SEEKER_TURN_RATE * TICK_DT = 4 / 60 = 0.06666666666666667
    expect(e.heading).toBeCloseTo(0.06666666666666667, 12)
    // velocity = seekerSpeed 55 * (cos h, 0, sin h)
    expect(e.velocity.x).toBeCloseTo(54.87782303856173, 9)
    expect(e.velocity.y).toBe(0)
    expect(e.velocity.z).toBeCloseTo(3.6639512207866147, 9)
    // position += velocity * TICK_DT
    expect(e.position.x).toBeCloseTo(0.9146303839760288, 9)
    expect(e.position.z).toBeCloseTo(0.06106585367977691, 9)
    expect(e.position.y).toBe(0.5) // entities are planar: y never integrates
    expect(e.ttl).toBe(599)
    expect(events.length).toBe(0)
  })

  it('flies a seeker straight when it has no target', () => {
    const ctx = stubContext()
    const state = blankState()
    const events: AuthEvent[] = []
    // heading 0: cos = 1 and sin = 0 exactly, so it runs straight down +X
    spawnEntity(ctx, state, 'seeker', 0, { x: 500, y: 0, z: 0 }, 0, -1, 600, events)
    events.length = 0

    updateEntities(ctx, state, events)

    const e = state.entities[0]
    expect(e.heading).toBe(0) // no target, so no homing turn at all
    expect(e.velocity.x).toBe(55) // seekerSpeed
    expect(e.velocity.z).toBe(0)
    // 500 + 55 / 60 = 500.9166666666667
    expect(e.position.x).toBeCloseTo(500.9166666666667, 9)
    expect(e.position.z).toBe(0)
  })

  it('bounces a bolt off the track edge and places it back inside', () => {
    const ctx = stubContext()
    const state = blankState()
    const events: AuthEvent[] = []
    // half width = 10; the bolt is at z = 9.9 heading PI/4 (out toward +z)
    spawnEntity(ctx, state, 'bolt', 0, { x: 0, y: 0.5, z: 9.9 }, Math.PI / 4, -1, 600, events)
    events.length = 0

    updateEntities(ctx, state, events)

    const e = state.entities[0]
    // step: velocity = 65 * (cos, sin)(PI/4) = (45.96194077712559, 0, 45.961940777125584)
    // z = 9.9 + 45.961940777125584 / 60 = 10.666032346285427 -> outside +-10
    // reflect about the tangent (1,0,0): heading PI/4 -> -PI/4
    expect(e.heading).toBeCloseTo(-0.7853981633974483, 12)
    // x is unaffected by the lateral push-back (right = (0,0,1))
    expect(e.position.x).toBeCloseTo(0.7660323462854265, 9)
    // pushed back to half - BOLT_EDGE_INSET = 10 - 0.05
    expect(e.position.z).toBeCloseTo(9.95, 9)
    // velocity is recomputed from the post-bounce heading
    expect(e.velocity.x).toBeCloseTo(45.96194077712559, 9)
    expect(e.velocity.z).toBeCloseTo(-45.961940777125584, 9)
    expect(state.entityCount).toBe(1) // a bounce never despawns
  })

  it('leaves a slick exactly where it was dropped', () => {
    const ctx = stubContext()
    const state = blankState()
    const events: AuthEvent[] = []
    spawnEntity(ctx, state, 'slick', 2, { x: 3, y: 0, z: -4 }, 1.25, -1, 600, events)
    events.length = 0

    updateEntities(ctx, state, events)
    updateEntities(ctx, state, events)

    const e = state.entities[0]
    expect(e.position.x).toBe(3)
    expect(e.position.y).toBe(0)
    expect(e.position.z).toBe(-4)
    expect(e.velocity.x).toBe(0)
    expect(e.velocity.z).toBe(0)
    expect(e.heading).toBe(1.25)
    expect(e.ttl).toBe(598) // 600 - 2
  })

  it('orbits a bubble around its owner', () => {
    const ctx = stubContext()
    const state = blankState()
    const events: AuthEvent[] = []
    const owner = state.karts[1]
    owner.position.x = 5
    owner.position.y = 0
    owner.position.z = -3
    owner.shielded = true // the bubble is the view of this flag
    spawnEntity(ctx, state, 'bubble', 1, { x: 0, y: 0, z: 0 }, 0, -1, 600, events)
    events.length = 0

    updateEntities(ctx, state, events)

    const e = state.entities[0]
    // heading += BUBBLE_ORBIT_RATE * TICK_DT = 6 / 60 = 0.1
    expect(e.heading).toBeCloseTo(0.1, 12)
    // position = owner + 2 * (cos 0.1, 0, sin 0.1) = (5 + 1.9900083305560514, 0, -3 + 0.1996668332936563)
    expect(e.position.x).toBeCloseTo(6.990008330556051, 9)
    expect(e.position.y).toBe(0)
    expect(e.position.z).toBeCloseTo(-2.8003331667063436, 9)
    // tangential velocity = rate * radius = 12
    expect(e.velocity.x).toBeCloseTo(-1.1980009997619379, 9)
    expect(e.velocity.z).toBeCloseTo(11.940049983336309, 9)
    expect(state.entityCount).toBe(1)
  })

  it('holds surge and charge fields still and only counts them down', () => {
    const ctx = stubContext()
    const state = blankState()
    const events: AuthEvent[] = []
    spawnEntity(ctx, state, 'surge', 2, { x: 7, y: 0, z: 8 }, 0.5, -1, 300, events)
    spawnEntity(ctx, state, 'charge', 3, { x: -5, y: 0, z: 6 }, -0.5, -1, 30, events)
    events.length = 0

    updateEntities(ctx, state, events)

    const surge = state.entities[0]
    const charge = state.entities[1]
    expect(surge.position.x).toBe(7)
    expect(surge.position.z).toBe(8)
    expect(surge.velocity.x).toBe(0)
    expect(surge.velocity.z).toBe(0)
    expect(surge.ttl).toBe(299)
    expect(charge.position.x).toBe(-5)
    expect(charge.position.z).toBe(6)
    expect(charge.velocity.x).toBe(0)
    expect(charge.ttl).toBe(29)
    expect(state.entityCount).toBe(2)
  })
})

describe('updateEntities collision', () => {
  it('spins out the kart it strikes and emits hit then spinOut', () => {
    const ctx = stubContext()
    const state = blankState()
    const events: AuthEvent[] = []
    const victim = state.karts[1]
    victim.position.x = 0
    victim.position.y = 0
    victim.position.z = 0
    // slick reach = 1.2 + kartRadius 0.9 = 2.1, and it sits 1.5 away
    spawnEntity(ctx, state, 'slick', 0, { x: 1.5, y: 0, z: 0 }, 0, -1, 600, events)
    events.length = 0
    state.nextEventSeq = 0 // drop the spawn event and number the hit from 0

    updateEntities(ctx, state, events)

    expect(victim.spinOutTicks).toBe(60) // tuning.spinOutTicks, armed by startSpinOut
    expect(victim.invulnTicks).toBe(0) // Task 9 owns invulnerability, not this
    expect(events.length).toBe(2)
    expect(events[0].kind).toBe('hit')
    expect(events[0].playerId).toBe(1)
    expect(events[0].entityId).toBe(1)
    expect(events[0].item).toBe('slick')
    expect(events[0].data).toBe(0) // 0 = took the hit, 1 = a shield ate it
    expect(events[0].eventSeq).toBe(0)
    // the spinOut event is emitted by startSpinOut, not by this module
    expect(events[1].kind).toBe('spinOut')
    expect(events[1].playerId).toBe(1)
    expect(events[1].item).toBe('none')
    expect(events[1].data).toBe(60)
    expect(events[1].eventSeq).toBe(1)
    // a slick is persistent: it survives the karts it spins out
    expect(state.entityCount).toBe(1)
    expect(state.entities[0].ttl).toBe(599)
  })

  it('consumes a seeker on impact', () => {
    const ctx = stubContext()
    const state = blankState()
    const events: AuthEvent[] = []
    const victim = state.karts[1]
    victim.position.x = 0
    victim.position.y = 0
    victim.position.z = 0
    // heading 0, no target: it steps to x = -2 + 55/60 = -1.0833333333333335,
    // inside the seeker reach of 1.6 + 0.9 = 2.5
    spawnEntity(ctx, state, 'seeker', 0, { x: -2, y: 0, z: 0 }, 0, -1, 600, events)
    events.length = 0

    updateEntities(ctx, state, events)

    expect(victim.spinOutTicks).toBe(60)
    expect(state.entityCount).toBe(0)
    expect(state.entities[0].entityId).toBe(-1)
    expect(events.length).toBe(3)
    expect(events[0].kind).toBe('hit')
    expect(events[1].kind).toBe('spinOut')
    expect(events[2].kind).toBe('entityDespawn')
    expect(events[2].playerId).toBe(0) // the owner, on a despawn
    expect(events[2].entityId).toBe(1)
    expect(events[2].item).toBe('seeker')
  })

  it('misses a kart outside the hit radius', () => {
    const ctx = stubContext()
    const state = blankState()
    const events: AuthEvent[] = []
    const near = state.karts[1]
    near.position.x = 0
    near.position.y = 0
    near.position.z = 0
    // 2.5 apart, and the slick only reaches 1.2 + 0.9 = 2.1
    spawnEntity(ctx, state, 'slick', 0, { x: 2.5, y: 0, z: 0 }, 0, -1, 600, events)
    events.length = 0

    updateEntities(ctx, state, events)

    expect(near.spinOutTicks).toBe(0)
    expect(events.length).toBe(0)
    expect(state.entityCount).toBe(1)
  })

  it('never strikes its own owner', () => {
    const ctx = stubContext()
    const state = blankState()
    const events: AuthEvent[] = []
    const owner = state.karts[1]
    owner.position.x = 0
    owner.position.y = 0
    owner.position.z = 0
    spawnEntity(ctx, state, 'slick', 1, { x: 1.5, y: 0, z: 0 }, 0, -1, 600, events)
    events.length = 0

    updateEntities(ctx, state, events)

    expect(owner.spinOutTicks).toBe(0)
    expect(events.length).toBe(0)
  })

  it('passes through karts that are spinning, invulnerable or respawning', () => {
    const ctx = stubContext()
    const state = blankState()
    const events: AuthEvent[] = []
    const invuln = state.karts[1]
    invuln.position.x = 0
    invuln.position.y = 0
    invuln.position.z = 0
    invuln.invulnTicks = 5
    const spinning = state.karts[2]
    spinning.position.x = 0
    spinning.position.y = 0
    spinning.position.z = 1
    spinning.spinOutTicks = 3
    const respawning = state.karts[3]
    respawning.position.x = 0
    respawning.position.y = 0
    respawning.position.z = -1
    respawning.respawnTicks = 7
    spawnEntity(ctx, state, 'slick', 0, { x: 1.5, y: 0, z: 0 }, 0, -1, 600, events)
    events.length = 0

    updateEntities(ctx, state, events)

    expect(invuln.spinOutTicks).toBe(0)
    expect(spinning.spinOutTicks).toBe(3) // untouched, not refreshed
    expect(respawning.spinOutTicks).toBe(0)
    // the guard skips these karts before the hit event, so not even a 'hit'
    // is emitted -- startSpinOut alone would still have let the hit through
    expect(events.length).toBe(0)
  })

  it('lets a shielded kart eat the hit and takes its bubble with it', () => {
    const ctx = stubContext()
    const state = blankState()
    const events: AuthEvent[] = []
    const victim = state.karts[1]
    victim.position.x = 0
    victim.position.y = 0
    victim.position.z = 0
    victim.shielded = true
    spawnEntity(ctx, state, 'slick', 0, { x: 1.5, y: 0, z: 0 }, 0, -1, 600, events) // id 1
    spawnEntity(ctx, state, 'bubble', 1, { x: 0, y: 0, z: 0 }, 0, -1, 600, events) // id 2
    events.length = 0

    updateEntities(ctx, state, events)

    expect(victim.shielded).toBe(false)
    expect(victim.spinOutTicks).toBe(0) // the shield ate it
    expect(events.length).toBe(2)
    expect(events[0].kind).toBe('hit')
    expect(events[0].playerId).toBe(1)
    expect(events[0].item).toBe('slick')
    expect(events[0].data).toBe(1) // 1 = absorbed
    expect(events[1].kind).toBe('entityDespawn')
    expect(events[1].entityId).toBe(2)
    expect(events[1].item).toBe('bubble')
    expect(events.some((ev) => ev.kind === 'spinOut')).toBe(false)
    expect(state.entityCount).toBe(1)
    expect(state.entities[0].entityId).toBe(1) // the slick outlives the shield
  })

  it('despawns a bubble whose owner is not shielded', () => {
    const ctx = stubContext()
    const state = blankState()
    const events: AuthEvent[] = []
    state.karts[4].shielded = false
    spawnEntity(ctx, state, 'bubble', 4, { x: 0, y: 0, z: 0 }, 0, -1, 600, events)
    events.length = 0

    updateEntities(ctx, state, events)

    expect(state.entityCount).toBe(0)
    expect(events.length).toBe(1)
    expect(events[0].kind).toBe('entityDespawn')
    expect(events[0].item).toBe('bubble')
  })

  it('clears the owner shield when a bubble expires on ttl', () => {
    // The bug this pins: updateEntities runs strikes -> bubble-consistency -> ttl,
    // and only the consistency pass knew about `shielded` — in the "no bubble
    // without a shield" direction. So the ttl pass retired the bubble at entityTtl
    // (600 ticks, 10 s) and left `shielded` true with no bubble anywhere, and the
    // kart went on to absorb one hit for the rest of the race with nothing visible
    // to absorb it.
    const ctx = stubContext()
    const state = blankState()
    const events: AuthEvent[] = []
    const owner = state.karts[4]
    owner.shielded = true
    spawnEntity(ctx, state, 'bubble', 4, { x: 0, y: 0, z: 0 }, 0, -1, 3, events)
    events.length = 0

    updateEntities(ctx, state, events) // ttl 3 -> 2
    expect(state.entityCount).toBe(1)
    expect(owner.shielded).toBe(true)

    updateEntities(ctx, state, events) // ttl 2 -> 1
    expect(state.entityCount).toBe(1)
    expect(owner.shielded).toBe(true)

    updateEntities(ctx, state, events) // ttl 1 -> 0, despawn
    expect(state.entityCount).toBe(0)
    expect(owner.shielded).toBe(false)

    // and the shield does not come back on later ticks
    updateEntities(ctx, state, events)
    expect(owner.shielded).toBe(false)
    expect(state.entityCount).toBe(0)
  })

  it('leaves no kart shielded once its bubble is gone, however it went', () => {
    // The invariant stated at the top of the bubble-consistency pass, both ways
    // round: no bubble without a shield, and no shield without a bubble. Driven
    // here to the ttl horizon with nothing else happening.
    const ctx = stubContext()
    const state = blankState()
    const events: AuthEvent[] = []
    const owner = state.karts[5]
    owner.shielded = true
    spawnEntity(ctx, state, 'bubble', 5, { x: 0, y: 0, z: 0 }, 0, -1, ctx.tuning.entityTtl, events)

    for (let i = 0; i < ctx.tuning.entityTtl + 5; i++) updateEntities(ctx, state, events)

    expect(state.entityCount).toBe(0)
    expect(state.entities.filter((e) => e.entityId !== -1)).toEqual([])
    expect(owner.shielded).toBe(false)
  })

  it('is idempotent on the hit path, which already cleared the flag', () => {
    // despawnEntityAt now writes shielded = false; the strike pass wrote it a few
    // lines earlier. Both orders end in the same place, and the absorbed-hit
    // accounting is unchanged: one 'hit' with data 1, no 'spinOut'.
    const ctx = stubContext()
    const state = blankState()
    const events: AuthEvent[] = []
    const victim = state.karts[1]
    victim.position.x = 0
    victim.position.y = 0
    victim.position.z = 0
    victim.shielded = true
    spawnEntity(ctx, state, 'slick', 0, { x: 1.5, y: 0, z: 0 }, 0, -1, 600, events)
    spawnEntity(ctx, state, 'bubble', 1, { x: 0, y: 0, z: 0 }, 0, -1, 600, events)
    events.length = 0

    updateEntities(ctx, state, events)

    expect(victim.shielded).toBe(false)
    expect(victim.spinOutTicks).toBe(0)
    expect(events.filter((e) => e.kind === 'hit').length).toBe(1)
    expect(events.filter((e) => e.kind === 'hit')[0].data).toBe(1)
    expect(events.filter((e) => e.kind === 'entityDespawn').length).toBe(1)
    expect(events.some((e) => e.kind === 'spinOut')).toBe(false)

    // The next hit lands for real, because the shield is genuinely gone.
    spawnEntity(ctx, state, 'slick', 0, { x: 1.5, y: 0, z: 0 }, 0, -1, 600, events)
    events.length = 0
    updateEntities(ctx, state, events)
    expect(victim.spinOutTicks).toBe(ctx.tuning.spinOutTicks)
  })

  it('takes the shield down when a bubble is despawned directly', () => {
    // Covering the call rather than the caller: every despawn path runs through
    // despawnEntityAt, which is why the clear lives there.
    const ctx = stubContext()
    const state = blankState()
    const events: AuthEvent[] = []
    state.karts[2].shielded = true
    spawnEntity(ctx, state, 'bubble', 2, { x: 0, y: 0, z: 0 }, 0, -1, 600, events)

    despawnEntityAt(ctx, state, 0, events)

    expect(state.karts[2].shielded).toBe(false)
    expect(state.entityCount).toBe(0)
  })

  it('does not touch shields when a non-bubble entity despawns', () => {
    const ctx = stubContext()
    const state = blankState()
    const events: AuthEvent[] = []
    state.karts[2].shielded = true
    spawnEntity(ctx, state, 'seeker', 2, { x: 0, y: 0, z: 0 }, 0, -1, 600, events)

    despawnEntityAt(ctx, state, 0, events)

    expect(state.karts[2].shielded).toBe(true)
  })
})

describe('surgeActiveOn', () => {
  // Placement from (lap, checkpointIdx, t) descending, playerId breaking ties:
  // p2 (2,5,0.5) then p5 (1,3,0.2) then everyone still on (0,0,0) in playerId
  // order, so the order is [2, 5, 0, 1, 3, 4, 6, 7] and the places are
  // p2->0 p5->1 p0->2 p1->3 p3->4 p4->5 p6->6 p7->7.
  function progressState(): SimState {
    const state = blankState()
    state.karts[2].lap.lap = 2
    state.karts[2].lap.checkpointIdx = 5
    state.karts[2].lap.t = 0.5
    state.karts[5].lap.lap = 1
    state.karts[5].lap.checkpointIdx = 3
    state.karts[5].lap.t = 0.2
    return state
  }

  it('is false for everyone when no surge is live', () => {
    const state = progressState()
    for (let pid = 0; pid < MAX_KARTS; pid++) {
      expect(surgeActiveOn(state, pid)).toBe(false)
    }
  })

  it('slows only the karts placed ahead of the surge owner', () => {
    const ctx = stubContext()
    const state = progressState()
    const events: AuthEvent[] = []
    spawnEntity(ctx, state, 'surge', 5, { x: 0, y: 0, z: 0 }, 0, -1, 300, events)

    expect(surgeActiveOn(state, 2)).toBe(true) // place 0, ahead of p5's place 1
    expect(surgeActiveOn(state, 5)).toBe(false) // the owner is never slowed
    expect(surgeActiveOn(state, 0)).toBe(false) // place 2, behind p5
    expect(surgeActiveOn(state, 7)).toBe(false) // place 7, behind p5
  })

  it('ignores non-surge entities and out-of-range player ids', () => {
    const ctx = stubContext()
    const state = progressState()
    const events: AuthEvent[] = []
    spawnEntity(ctx, state, 'slick', 5, { x: 0, y: 0, z: 0 }, 0, -1, 600, events)
    expect(surgeActiveOn(state, 2)).toBe(false)

    spawnEntity(ctx, state, 'surge', 5, { x: 0, y: 0, z: 0 }, 0, -1, 300, events)
    expect(surgeActiveOn(state, 2)).toBe(true)
    expect(surgeActiveOn(state, -1)).toBe(false)
    expect(surgeActiveOn(state, MAX_KARTS)).toBe(false) // 8
  })

  it('lets one surge owner be caught by another surge', () => {
    const ctx = stubContext()
    const state = progressState()
    const events: AuthEvent[] = []
    spawnEntity(ctx, state, 'surge', 5, { x: 0, y: 0, z: 0 }, 0, -1, 300, events) // owner place 1
    spawnEntity(ctx, state, 'surge', 0, { x: 0, y: 0, z: 0 }, 0, -1, 300, events) // owner place 2

    expect(surgeActiveOn(state, 2)).toBe(true) // place 0: ahead of both
    expect(surgeActiveOn(state, 5)).toBe(true) // place 1: ahead of p0's surge
    expect(surgeActiveOn(state, 0)).toBe(false) // place 2: behind p5, owns the other
    expect(surgeActiveOn(state, 1)).toBe(false) // place 3: behind both
  })
})

describe('kart.ts wiring', () => {
  it('multiplies targetSpeedFor by tuning.surgeSpeedMul for a kart a surge is on', () => {
    const ctx = stubContext()
    const state = blankState()
    const events: AuthEvent[] = []
    // p2 leads on lap 2, p5 is second on lap 1, everyone else is level on
    // (0, 0, 0) and sorts by playerId: places are p2->0, p5->1, p0->2, ...
    state.karts[2].lap.lap = 2
    state.karts[5].lap.lap = 1
    const leader = state.karts[2] // characterIdx 0 -> speed 1.00, tarmac, no boost

    // no surge live yet:
    // maxSpeed 40 * speed 1.00 * accel 1 * surface 1 * surge 1 * boost 1 = 40
    expect(targetSpeedFor(ctx, state, leader, 1)).toBe(40)

    spawnEntity(ctx, state, 'surge', 5, { x: 0, y: 0, z: 0 }, 0, -1, 300, events)

    // p2 is placed ahead of the caster p5, so the surge is on it:
    // 40 * 1.00 * 1 * 1 * 0.7 * 1, evaluated left to right, is exactly 28 in
    // float64 (the exact product sits half an ulp below 28 and ties to even).
    expect(targetSpeedFor(ctx, state, leader, 1)).toBe(28)
    // the caster is never slowed by its own field
    expect(targetSpeedFor(ctx, state, state.karts[5], 1)).toBe(40)
  })

  it('leaves a kart placed behind the surge caster at full speed', () => {
    const ctx = stubContext()
    const state = blankState()
    const events: AuthEvent[] = []
    // Same field as above: p2 (lap 2) -> place 0, p5 (lap 1) -> place 1, and
    // everyone else is level on (0, 0, 0) and sorts by playerId, so p0 -> place 2.
    state.karts[2].lap.lap = 2
    state.karts[5].lap.lap = 1
    const behind = state.karts[0] // place 2: one place BEHIND the caster p5
    // characterIdx 0 -> speed 1.00, surface tarmac -> 1, boostTicks 0 -> 1

    expect(targetSpeedFor(ctx, state, behind, 1)).toBe(40)

    spawnEntity(ctx, state, 'surge', 5, { x: 0, y: 0, z: 0 }, 0, -1, 300, events)

    // A surge slows only the karts placed AHEAD of its caster, so p0's factor
    // stays 1 and its target speed does not move:
    //   40 * 1.00 * 1 (accel) * 1 (surface) * 1 (surge) * 1 (boost) = 40
    // Under the staged rule Task 6 wrote -- "any live surge this kart does not
    // own" -- p0 would take the field too:
    //   40 * 1.00 * 1 * 1 * 0.7 * 1 = 28
    // so this one expectation is the whole difference between the two rules.
    // The test above cannot see it: p2 is ahead of p5, where both say 28.
    expect(targetSpeedFor(ctx, state, behind, 1)).toBe(40)
    expect(surgeActiveOn(state, 0)).toBe(false)
  })
})

describe('step() wiring', () => {
  it('runs updateEntities once per tick, after the kart loop', () => {
    const ctx = stubContext()
    const prev = blankState()
    const next = blankState()
    prev.tick = 700
    prev.phase = 'racing'

    // The victim sits at the origin; every other kart stays parked at
    // x = 1000 + 10 * playerId, so nothing else is in reach and no kart-vs-kart
    // contact fires either.
    const victim = prev.karts[1]
    victim.position.x = 0
    victim.position.y = 0
    victim.position.z = 0
    // slick reach = 1.2 + kartRadius 0.9 = 2.1, and it sits 1.5 m away
    const spawnEvents: AuthEvent[] = []
    spawnEntity(ctx, prev, 'slick', 0, { x: 1.5, y: 0, z: 0 }, 0, -1, 600, spawnEvents)
    prev.nextEventSeq = 0 // renumber from 0: the spawn event is not under test

    const inputs: Intent[] = []
    for (let i = 0; i < MAX_KARTS; i++) {
      inputs.push({
        tick: 700, steer: 0, accel: 0, brake: false, drift: false, useItem: false,
      })
    }
    const events: AuthEvent[] = []

    step(ctx, prev, next, inputs, events)

    expect(next.tick).toBe(701)
    // every kart is at rest with accel 0, so nobody moves and the slick is
    // still 1.5 m from the victim when updateEntities runs
    expect(next.karts[1].spinOutTicks).toBe(60) // tuning.spinOutTicks
    expect(next.entities[0].ttl).toBe(599) // 600 - 1: the ttl pass ran too
    expect(events.length).toBe(2)
    expect(events[0].kind).toBe('hit')
    expect(events[0].playerId).toBe(1)
    expect(events[0].eventSeq).toBe(0)
    // updateEntities runs against `next`, whose tick is already prev.tick + 1
    expect(events[0].tick).toBe(701)
    expect(events[1].kind).toBe('spinOut')
    expect(events[1].playerId).toBe(1)

    // step never mutates prev
    expect(prev.karts[1].spinOutTicks).toBe(0)
    expect(prev.entities[0].ttl).toBe(600)
    expect(prev.tick).toBe(700)
  })
})

describe('updateEntities hit events on a follower', () => {
  it('resolves both hit branches identically, but announces nothing', () => {
    const leaderCtx = stubContext()
    const followerCtx = stubContext(false)
    const leaderState = blankState()
    const followerState = blankState()

    // unshielded kart 2 and shielded kart 3, both parked far from everyone
    // else, each sitting on its own long-lived slick (ttl 600, so this tick's
    // ttl pass does not also despawn it -- entityDespawn's gating is proven
    // separately, above).
    for (const state of [leaderState, followerState]) {
      state.karts[2].position.x = 200
      state.karts[2].position.z = 0
      state.karts[3].position.x = 250
      state.karts[3].position.z = 0
      state.karts[3].shielded = true
    }
    spawnEntity(leaderCtx, leaderState, 'slick', 7, { x: 200, y: 0, z: 0 }, 0, -1, 600, [])
    spawnEntity(leaderCtx, leaderState, 'slick', 7, { x: 250, y: 0, z: 0 }, 0, -1, 600, [])
    spawnEntity(followerCtx, followerState, 'slick', 7, { x: 200, y: 0, z: 0 }, 0, -1, 600, [])
    spawnEntity(followerCtx, followerState, 'slick', 7, { x: 250, y: 0, z: 0 }, 0, -1, 600, [])
    const leaderEvents: AuthEvent[] = []
    const followerEvents: AuthEvent[] = []

    updateEntities(leaderCtx, leaderState, leaderEvents)
    updateEntities(followerCtx, followerState, followerEvents)

    expect(followerState.karts[2].spinOutTicks).toBe(leaderState.karts[2].spinOutTicks)
    expect(followerState.karts[2].spinOutTicks).toBe(60)
    expect(followerState.karts[3].shielded).toBe(leaderState.karts[3].shielded)
    expect(followerState.karts[3].shielded).toBe(false)

    const leaderHits = leaderEvents.filter((e) => e.kind === 'hit')
    expect(leaderHits.length).toBe(2)
    expect(leaderHits.map((e) => e.data).sort()).toEqual([0, 1])
    expect(followerEvents.filter((e) => e.kind === 'hit').length).toBe(0)
  })
})

describe('Task 2: follower parity across a full tick (the eight gated sites)', () => {
  // stubContext's Track has itemBoxes: [], so updateItemBoxes never runs its
  // leader-only roll this tick -- the one already-correctly-gated site is
  // deliberately kept out of this test so it isolates exactly the eight sites
  // this task gates. An item grant is a genuinely different case -- a
  // follower cannot reproduce it locally at all, so the leader and follower
  // SimStates diverge in more than nextEventSeq and the events array when one
  // occurs. That case is covered on its own terms by the companion test
  // below ('Task 2: follower parity for an item grant'), not here.
  function parityPrevState(): SimState {
    const state = blankState()
    state.phase = 'racing'
    state.tick = 100

    // kart 0: out of bounds -> updateRecovery's beginRespawn -> 'respawn'
    state.karts[0].position.x = 10
    state.karts[0].position.z = 50 // |lateral| = 50 > isInBounds's 10

    // kart 1: one tick from completing lap 3 -> updateLaps' 'lapCross' + 'finish'
    state.karts[1].position.x = 4 // s = 0.01, inside checkpoint 0's [0, 0.25)
    state.karts[1].position.z = 0
    state.karts[1].lap = { lap: 2, checkpointIdx: 3, t: 0.99 }

    // kart 2: unshielded, sits on a low-ttl slick -> 'hit' (data 0), 'spinOut',
    // and that same slick's ttl expiry -> 'entityDespawn'
    state.karts[2].position.x = 200
    state.karts[2].position.z = 0

    // kart 3: shielded, sits on a long-ttl slick -> 'hit' (data 1)
    state.karts[3].position.x = 250
    state.karts[3].position.z = 0
    state.karts[3].shielded = true

    // kart 4: holds a seeker and fires it -> useItem's spawnEntity -> 'entitySpawn'
    state.karts[4].position.x = 300
    state.karts[4].position.z = 0
    state.karts[4].item = 'seeker'

    // Two pre-placed entities, written directly rather than through
    // spawnEntity (one of the things under test), so their ids are exact.
    state.entityCount = 2
    state.nextEntityId = 3
    const e0 = state.entities[0] // kart 2's slick: ttl 1, expires this tick
    e0.entityId = 1
    e0.kind = 'slick'
    e0.ownerId = 7
    e0.position.x = 200
    e0.position.y = 0
    e0.position.z = 0
    e0.ttl = 1
    const e1 = state.entities[1] // kart 3's slick: ttl 600, survives this tick
    e1.entityId = 2
    e1.kind = 'slick'
    e1.ownerId = 7
    e1.position.x = 250
    e1.position.y = 0
    e1.position.z = 0
    e1.ttl = 600

    return state
  }

  function parityInputs(): Intent[] {
    const inputs: Intent[] = []
    for (let i = 0; i < MAX_KARTS; i++) {
      inputs.push({ tick: 0, steer: 0, accel: 0, brake: false, drift: false, useItem: i === 4 })
    }
    return inputs
  }

  it('mutates state identically to a leader for the eight gated sites, and only their announcements differ', () => {
    const leaderCtx = stubContext(true)
    const followerCtx = stubContext(false)
    const prevLeader = parityPrevState()
    const prevFollower = parityPrevState()
    const nextLeader = parityPrevState() // shape-compatible scratch for step()'s cloneState
    const nextFollower = parityPrevState()
    const inputs = parityInputs()
    const leaderEvents: AuthEvent[] = []
    const followerEvents: AuthEvent[] = []

    step(leaderCtx, prevLeader, nextLeader, inputs, leaderEvents)
    step(followerCtx, prevFollower, nextFollower, inputs, followerEvents)

    // All eight of Task 2's gated sites fired on the leader, none on the follower.
    expect(leaderEvents.length).toBe(8)
    expect(followerEvents.length).toBe(0)
    expect(leaderEvents.map((e) => e.kind).sort()).toEqual(
      ['entityDespawn', 'entitySpawn', 'finish', 'hit', 'hit', 'lapCross', 'respawn', 'spinOut'].sort(),
    )
    expect(nextLeader.nextEventSeq).toBe(8)
    expect(nextFollower.nextEventSeq).toBe(0)

    // Every other field of SimState is identical -- true here because this
    // scenario has no item box (see the top-of-describe comment), so
    // nextEventSeq is the only field this equalises before borrowing
    // statesEqual (state.ts; exhaustive and Object.is-strict). This is NOT a
    // general claim that nextEventSeq/events are the only two things that can
    // ever differ between a leader and a follower -- an item grant breaks
    // that, which is exactly what the companion test below demonstrates.
    const savedFollowerSeq = nextFollower.nextEventSeq
    nextFollower.nextEventSeq = nextLeader.nextEventSeq
    expect(statesEqual(nextLeader, nextFollower)).toBe(true)
    nextFollower.nextEventSeq = savedFollowerSeq

    // Name the mechanisms statesEqual just proved identical, so a regression
    // here says which one moved, not just "false".
    expect(nextFollower.karts[0].respawnTicks).toBe(72) // kart 0 respawned
    expect(nextFollower.karts[1].lap.lap).toBe(3) // kart 1 finished lap 3
    expect(nextFollower.finishedOrder[0]).toBe(1)
    expect(nextFollower.karts[2].spinOutTicks).toBe(60) // kart 2 spun out
    expect(nextFollower.entityCount).toBe(2) // slick 1 despawned, seeker spawned
    expect(nextFollower.karts[3].shielded).toBe(false) // kart 3's shield absorbed a hit
    expect(nextFollower.karts[4].item).toBe('none') // kart 4 spent its seeker
  })
})

describe('Task 2: follower parity for an item grant', () => {
  // Unlike the eight sites above, a follower cannot reproduce an item grant
  // locally at all: rollItem (items.ts) returns 'none' on a follower and
  // never advances state.rngCursor, because the race RNG stream is
  // authority-only -- a follower's item instead arrives later, from the wire,
  // via applyItemGrant (Task 13). So on a tick a kart reaches a box, a leader
  // and a follower's SimState genuinely diverge in two fields beyond
  // nextEventSeq: karts[i].item and rngCursor. This test proves that
  // divergence is real, and that it is exactly those two fields plus
  // nextEventSeq -- nothing else.
  const BOX_S = 0.5 // this stub's 400 m loop: x = wrap01(0.5) * 400 = 200, z = lateral
  const BOX_LATERAL = 0

  function stubContextWithBox(isLeader: boolean): SimContext {
    const ctx = stubContext(isLeader)
    return { ...ctx, track: { ...ctx.track, itemBoxes: [{ s: BOX_S, lateral: BOX_LATERAL }] } }
  }

  function parityItemPrevState(): SimState {
    const state = blankState()
    state.phase = 'racing'
    state.tick = 100
    state.itemBoxes = [{ boxIdx: 0, respawnTicks: 0 }]
    // kart 0 sits exactly on the box; every other kart stays at blankKart's
    // default parking spot (x = 1000 + 10 * playerId), far from the box and
    // from each other, so nothing but the grant fires this tick.
    state.karts[0].position.x = 200
    state.karts[0].position.z = 0
    return state
  }

  function zeroInputs(): Intent[] {
    const inputs: Intent[] = []
    for (let i = 0; i < MAX_KARTS; i++) {
      inputs.push({ tick: 0, steer: 0, accel: 0, brake: false, drift: false, useItem: false })
    }
    return inputs
  }

  it('grants an item on the leader only, diverging exactly karts[0].item and rngCursor', () => {
    const leaderCtx = stubContextWithBox(true)
    const followerCtx = stubContextWithBox(false)
    const prevLeader = parityItemPrevState()
    const prevFollower = parityItemPrevState()
    const nextLeader = parityItemPrevState() // shape-compatible scratch for step()'s cloneState
    const nextFollower = parityItemPrevState()
    const inputs = zeroInputs()
    const leaderEvents: AuthEvent[] = []
    const followerEvents: AuthEvent[] = []

    step(leaderCtx, prevLeader, nextLeader, inputs, leaderEvents)
    step(followerCtx, prevFollower, nextFollower, inputs, followerEvents)

    // The leader emitted exactly one itemGrant; the follower emitted nothing.
    expect(leaderEvents.length).toBe(1)
    expect(leaderEvents[0].kind).toBe('itemGrant')
    expect(leaderEvents[0].playerId).toBe(0)
    expect(followerEvents.length).toBe(0)
    expect(nextLeader.nextEventSeq).toBe(1)
    expect(nextFollower.nextEventSeq).toBe(0)

    // The two fields that must diverge, asserted in both directions: the
    // follower's stay at their pre-grant values, and the leader's move.
    expect(nextFollower.karts[0].item).toBe('none')
    expect(nextLeader.karts[0].item).not.toBe('none')
    expect(nextFollower.rngCursor).toBe(0)
    expect(nextLeader.rngCursor).toBe(1)

    // Everything else matches. Equalise exactly those three fields
    // (nextEventSeq, karts[0].item, rngCursor) -- no more -- and borrow
    // statesEqual (state.ts; exhaustive, Object.is-strict) to prove the rest
    // is identical. If any other field had also diverged (a fourth exception
    // this test doesn't know about, or a narrower one than claimed), this
    // would be false; if karts[0].item or rngCursor had matched without the
    // explicit equalisation above (the follower wrongly rolling too), the two
    // asserts just above would already have failed first.
    const savedSeq = nextFollower.nextEventSeq
    const savedItem = nextFollower.karts[0].item
    const savedCursor = nextFollower.rngCursor
    nextFollower.nextEventSeq = nextLeader.nextEventSeq
    nextFollower.karts[0].item = nextLeader.karts[0].item
    nextFollower.rngCursor = nextLeader.rngCursor
    expect(statesEqual(nextLeader, nextFollower)).toBe(true)
    nextFollower.nextEventSeq = savedSeq
    nextFollower.karts[0].item = savedItem
    nextFollower.rngCursor = savedCursor

    // The box's own respawn timer is not part of the exception: updateItemBoxes
    // starts it before the ctx.isLeader-gated roll, so it is set identically on
    // both leader and follower -- already covered by statesEqual above, named
    // explicitly here for the same reason the sibling test above names its
    // mechanisms.
    expect(nextFollower.itemBoxes[0].respawnTicks).toBe(nextLeader.itemBoxes[0].respawnTicks)
    expect(nextFollower.itemBoxes[0].respawnTicks).toBeGreaterThan(0)
  })
})
