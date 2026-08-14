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

function stubContext(): SimContext {
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
  return { track, query, tuning: makeTuning(), characters: makeCharacters(), isLeader: true }
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
  }
}

describe('spawnEntity', () => {
  it('appends at the front of the pool, copies the position, wraps the heading and emits entitySpawn', () => {
    const state = blankState()
    const events: AuthEvent[] = []
    const p = { x: 1, y: 0.5, z: 2 }

    // 7 rad wraps into (-PI, PI] as 7 - 2 * PI = 0.7168146928204138
    const id = spawnEntity(state, 'slick', 4, p, 7, -1, 600, events)

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
    const state = blankState()
    const events: AuthEvent[] = []
    for (let i = 0; i < MAX_ENTITIES; i++) {
      const id = spawnEntity(state, 'bolt', 0, { x: i, y: 0, z: 0 }, 0, -1, 600, events)
      expect(id).toBe(i + 1) // ids run 1..32
    }
    expect(state.entityCount).toBe(MAX_ENTITIES) // 32
    expect(state.nextEntityId).toBe(33)
    expect(events.length).toBe(32)

    const overflow = spawnEntity(state, 'bolt', 1, { x: 0, y: 0, z: 0 }, 0, -1, 600, events)

    expect(overflow).toBe(-1)
    expect(state.entityCount).toBe(32)
    expect(state.nextEntityId).toBe(33) // not advanced by a dropped spawn
    expect(events.length).toBe(32) // nothing emitted
  })
})

describe('despawnEntityAt', () => {
  it('swap-removes and clears the vacated slot to the canonical dead form', () => {
    const state = blankState()
    const events: AuthEvent[] = []
    spawnEntity(state, 'slick', 0, { x: 1, y: 0, z: 0 }, 0, -1, 600, events) // id 1, idx 0
    spawnEntity(state, 'bolt', 1, { x: 2, y: 0, z: 0 }, 0, -1, 600, events) // id 2, idx 1
    spawnEntity(state, 'seeker', 2, { x: 3, y: 0, z: 0 }, 0.25, 5, 600, events) // id 3, idx 2
    events.length = 0

    despawnEntityAt(state, 0, events)

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
    const state = blankState()
    const events: AuthEvent[] = []
    spawnEntity(state, 'slick', 0, { x: 1, y: 0, z: 0 }, 0, -1, 600, events)
    events.length = 0

    despawnEntityAt(state, 1, events)
    despawnEntityAt(state, -1, events)
    despawnEntityAt(state, MAX_ENTITIES, events)

    expect(state.entityCount).toBe(1)
    expect(state.entities[0].entityId).toBe(1)
    expect(events.length).toBe(0)
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
    const id = spawnEntity(state, 'slick', 0, { x: 5, y: 0, z: 1 }, 0, -1, 2, events)
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
    spawnEntity(state, 'slick', 0, { x: 1, y: 0, z: 0 }, 0, -1, 1, events) // id 1, expires
    spawnEntity(state, 'slick', 1, { x: 2, y: 0, z: 0 }, 0, -1, 5, events) // id 2, lives
    spawnEntity(state, 'slick', 2, { x: 3, y: 0, z: 0 }, 0, -1, 1, events) // id 3, expires
    spawnEntity(state, 'slick', 3, { x: 4, y: 0, z: 0 }, 0, -1, 5, events) // id 4, lives
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
    spawnEntity(state, 'seeker', 0, { x: 0, y: 0.5, z: 0 }, 0, 3, 600, events)
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
    spawnEntity(state, 'seeker', 0, { x: 500, y: 0, z: 0 }, 0, -1, 600, events)
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
    spawnEntity(state, 'bolt', 0, { x: 0, y: 0.5, z: 9.9 }, Math.PI / 4, -1, 600, events)
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
    spawnEntity(state, 'slick', 2, { x: 3, y: 0, z: -4 }, 1.25, -1, 600, events)
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
    spawnEntity(state, 'bubble', 1, { x: 0, y: 0, z: 0 }, 0, -1, 600, events)
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
    spawnEntity(state, 'surge', 2, { x: 7, y: 0, z: 8 }, 0.5, -1, 300, events)
    spawnEntity(state, 'charge', 3, { x: -5, y: 0, z: 6 }, -0.5, -1, 30, events)
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
    spawnEntity(state, 'slick', 0, { x: 1.5, y: 0, z: 0 }, 0, -1, 600, events)
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
    spawnEntity(state, 'seeker', 0, { x: -2, y: 0, z: 0 }, 0, -1, 600, events)
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
    spawnEntity(state, 'slick', 0, { x: 2.5, y: 0, z: 0 }, 0, -1, 600, events)
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
    spawnEntity(state, 'slick', 1, { x: 1.5, y: 0, z: 0 }, 0, -1, 600, events)
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
    spawnEntity(state, 'slick', 0, { x: 1.5, y: 0, z: 0 }, 0, -1, 600, events)
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
    spawnEntity(state, 'slick', 0, { x: 1.5, y: 0, z: 0 }, 0, -1, 600, events) // id 1
    spawnEntity(state, 'bubble', 1, { x: 0, y: 0, z: 0 }, 0, -1, 600, events) // id 2
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
    spawnEntity(state, 'bubble', 4, { x: 0, y: 0, z: 0 }, 0, -1, 600, events)
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
    spawnEntity(state, 'bubble', 4, { x: 0, y: 0, z: 0 }, 0, -1, 3, events)
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
    spawnEntity(state, 'bubble', 5, { x: 0, y: 0, z: 0 }, 0, -1, ctx.tuning.entityTtl, events)

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
    spawnEntity(state, 'slick', 0, { x: 1.5, y: 0, z: 0 }, 0, -1, 600, events)
    spawnEntity(state, 'bubble', 1, { x: 0, y: 0, z: 0 }, 0, -1, 600, events)
    events.length = 0

    updateEntities(ctx, state, events)

    expect(victim.shielded).toBe(false)
    expect(victim.spinOutTicks).toBe(0)
    expect(events.filter((e) => e.kind === 'hit').length).toBe(1)
    expect(events.filter((e) => e.kind === 'hit')[0].data).toBe(1)
    expect(events.filter((e) => e.kind === 'entityDespawn').length).toBe(1)
    expect(events.some((e) => e.kind === 'spinOut')).toBe(false)

    // The next hit lands for real, because the shield is genuinely gone.
    spawnEntity(state, 'slick', 0, { x: 1.5, y: 0, z: 0 }, 0, -1, 600, events)
    events.length = 0
    updateEntities(ctx, state, events)
    expect(victim.spinOutTicks).toBe(ctx.tuning.spinOutTicks)
  })

  it('takes the shield down when a bubble is despawned directly', () => {
    // Covering the call rather than the caller: every despawn path runs through
    // despawnEntityAt, which is why the clear lives there.
    const state = blankState()
    const events: AuthEvent[] = []
    state.karts[2].shielded = true
    spawnEntity(state, 'bubble', 2, { x: 0, y: 0, z: 0 }, 0, -1, 600, events)

    despawnEntityAt(state, 0, events)

    expect(state.karts[2].shielded).toBe(false)
    expect(state.entityCount).toBe(0)
  })

  it('does not touch shields when a non-bubble entity despawns', () => {
    const state = blankState()
    const events: AuthEvent[] = []
    state.karts[2].shielded = true
    spawnEntity(state, 'seeker', 2, { x: 0, y: 0, z: 0 }, 0, -1, 600, events)

    despawnEntityAt(state, 0, events)

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
    const state = progressState()
    const events: AuthEvent[] = []
    spawnEntity(state, 'surge', 5, { x: 0, y: 0, z: 0 }, 0, -1, 300, events)

    expect(surgeActiveOn(state, 2)).toBe(true) // place 0, ahead of p5's place 1
    expect(surgeActiveOn(state, 5)).toBe(false) // the owner is never slowed
    expect(surgeActiveOn(state, 0)).toBe(false) // place 2, behind p5
    expect(surgeActiveOn(state, 7)).toBe(false) // place 7, behind p5
  })

  it('ignores non-surge entities and out-of-range player ids', () => {
    const state = progressState()
    const events: AuthEvent[] = []
    spawnEntity(state, 'slick', 5, { x: 0, y: 0, z: 0 }, 0, -1, 600, events)
    expect(surgeActiveOn(state, 2)).toBe(false)

    spawnEntity(state, 'surge', 5, { x: 0, y: 0, z: 0 }, 0, -1, 300, events)
    expect(surgeActiveOn(state, 2)).toBe(true)
    expect(surgeActiveOn(state, -1)).toBe(false)
    expect(surgeActiveOn(state, MAX_KARTS)).toBe(false) // 8
  })

  it('lets one surge owner be caught by another surge', () => {
    const state = progressState()
    const events: AuthEvent[] = []
    spawnEntity(state, 'surge', 5, { x: 0, y: 0, z: 0 }, 0, -1, 300, events) // owner place 1
    spawnEntity(state, 'surge', 0, { x: 0, y: 0, z: 0 }, 0, -1, 300, events) // owner place 2

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

    spawnEntity(state, 'surge', 5, { x: 0, y: 0, z: 0 }, 0, -1, 300, events)

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

    spawnEntity(state, 'surge', 5, { x: 0, y: 0, z: 0 }, 0, -1, 300, events)

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
    spawnEntity(prev, 'slick', 0, { x: 1.5, y: 0, z: 0 }, 0, -1, 600, spawnEvents)
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
