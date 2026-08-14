import { describe, expect, it } from 'vitest'
import type {
  AuthEvent, EntityState, KartState, SimContext, SimState, TrackPoint,
  TrackProjection, TrackQuery, Tuning, Vec3,
} from '../src/types'
import { MAX_ENTITIES, MAX_KARTS } from '../src/types'
import { makeCharacters, makeStraightTrack, makeTuning } from './fixtures/track-fixtures'
import {
  motionLocked, SPIN_SPEED_DECAY, SPIN_YAW_RATE, startSpinOut, steeringLocked,
  surfaceSpeedFactor, updateRecovery,
} from '../src/recovery'

// A hand-built TrackQuery so every number in this file is exact and owned by the
// test. The centreline is a straight line along +X at y = 0, z = 0, and one lap is
// TRACK_LENGTH metres long.
//
// Contract §0: `s` is ALWAYS arc-normalised to [0, 1) — never metres. Metres are
// reached only by multiplying an s-delta by totalLength(). So sampleAt converts
// s -> metres with `s * TRACK_LENGTH` and project() converts back. TRACK_LENGTH is
// 400 and every checkpoint sits on a quarter, so every s in this file (0, 0.25,
// 0.5, 0.75) converts to a metre value that is exact in binary floating point.
//
// Contract §0 also fixes right = (-t.z, 0, t.x). With tangent (1, 0, 0) that is
// (0, 0, 1), so positive `lateral` is toward +z: project() returns `p.z` unnegated.
const TRACK_LENGTH = 400

function wrap01(v: number): number {
  const f = v - Math.floor(v)
  return f < 0 ? f + 1 : f
}

function stubQuery(): TrackQuery {
  return {
    sampleAt(s: number): TrackPoint {
      return {
        position: { x: s * TRACK_LENGTH, y: 0, z: 0 },
        width: 10,
        banking: 0,
        surface: 'tarmac',
      }
    },
    tangentAt(): Vec3 {
      return { x: 1, y: 0, z: 0 }
    },
    project(p: Vec3): TrackProjection {
      return { s: wrap01(p.x / TRACK_LENGTH), lateral: p.z, distance: Math.abs(p.z) }
    },
    groundHeight(): number {
      return 0
    },
    surfaceAt(_s: number, lateral: number) {
      return Math.abs(lateral) <= 5 ? 'tarmac' : 'offtrack'
    },
    isInBounds(_s: number, lateral: number): boolean {
      return Math.abs(lateral) <= 5
    },
    checkpointIndexAt(s: number): number {
      return s < 0.25 ? 0 : s < 0.5 ? 1 : s < 0.75 ? 2 : 3
    },
    totalLength(): number {
      return TRACK_LENGTH
    },
  }
}

function makeCtx(overrides?: Partial<Tuning>): SimContext {
  return {
    // Four checkpoints, arc-normalised: 0 m, 100 m, 200 m, 300 m along the stub.
    track: makeStraightTrack({ checkpointS: [0, 0.25, 0.5, 0.75] }),
    query: stubQuery(),
    tuning: makeTuning(overrides),
    characters: makeCharacters(),
    isLeader: true,
  }
}

// A deliberately local kart builder: this file's karts are addressed by playerId
// and every field is written explicitly, so it does not import Task 6's shared
// `makeKart(over?)`. `checkpointIdx` starts at 3 because that is what createState
// produces — contract §0 fixes the initial lap as
// `{ lap: 0, checkpointIdx: track.checkpointS.length - 1, t: 0 }`, and this file's
// track has four checkpoints. Tests that care set it explicitly anyway.
function makeKart(playerId: number): KartState {
  return {
    playerId,
    characterIdx: 0,
    isBot: false,
    connected: true,
    position: { x: 0, y: 0, z: 0 },
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
    lap: { lap: 0, checkpointIdx: 3, t: 0 },
  }
}

function makeSimState(): SimState {
  const karts: KartState[] = []
  for (let i = 0; i < MAX_KARTS; i++) karts.push(makeKart(i))
  const entities: EntityState[] = []
  for (let i = 0; i < MAX_ENTITIES; i++) {
    entities.push({
      entityId: -1,
      kind: 'seeker',
      ownerId: -1,
      position: { x: 0, y: 0, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
      heading: 0,
      targetId: -1,
      ttl: 0,
    })
  }
  return {
    tick: 0,
    phase: 'racing',
    raceSeed: 1,
    rngCursor: 0,
    nextEventSeq: 0,
    finishTick: -1,
    karts,
    entities,
    entityCount: 0,
    nextEntityId: 1,
    itemBoxes: [],
    // Contract §0: finishedOrder is fixed length MAX_KARTS, unused slots hold -1.
    finishedOrder: new Array<number>(MAX_KARTS).fill(-1),
  }
}

describe('recovery predicates', () => {
  it('locks steering while spinning out or respawning, and only then', () => {
    const k = makeKart(0)
    expect(steeringLocked(k)).toBe(false)

    k.spinOutTicks = 1
    expect(steeringLocked(k)).toBe(true)

    k.spinOutTicks = 0
    k.respawnTicks = 1
    expect(steeringLocked(k)).toBe(true)

    k.spinOutTicks = 12
    expect(steeringLocked(k)).toBe(true)

    k.spinOutTicks = 0
    k.respawnTicks = 0
    expect(steeringLocked(k)).toBe(false)
  })

  it('locks motion only while respawning', () => {
    const k = makeKart(0)
    expect(motionLocked(k)).toBe(false)

    // A spinning kart still slides; only a respawning kart is teleport-driven.
    k.spinOutTicks = 60
    expect(motionLocked(k)).toBe(false)

    k.respawnTicks = 1
    expect(motionLocked(k)).toBe(true)
  })

  it('applies the off-track speed multiplier and nothing else', () => {
    const t = makeTuning()
    // Contract fixture: offtrackSpeedMul = 0.55
    expect(t.offtrackSpeedMul).toBe(0.55)

    const k = makeKart(0)

    k.surface = 'tarmac'
    expect(surfaceSpeedFactor(k, t)).toBe(1)

    k.surface = 'dirt'
    expect(surfaceSpeedFactor(k, t)).toBe(1)

    k.surface = 'boost'
    expect(surfaceSpeedFactor(k, t)).toBe(1)

    k.surface = 'offtrack'
    expect(surfaceSpeedFactor(k, t)).toBe(0.55)
  })

  it('honours an overridden off-track multiplier', () => {
    const t = makeTuning({ offtrackSpeedMul: 0.25 })
    const k = makeKart(0)
    k.surface = 'offtrack'
    expect(surfaceSpeedFactor(k, t)).toBe(0.25)
  })

  it('builds a context whose tuning matches the locked fixture values', () => {
    const ctx = makeCtx()
    expect(ctx.tuning.respawnTicks).toBe(72)
    expect(ctx.tuning.invulnTicks).toBe(90)
    expect(ctx.tuning.spinOutTicks).toBe(60)
    expect(makeSimState().karts.length).toBe(MAX_KARTS)
  })
})

describe('respawn', () => {
  // Track fixture: checkpointS = [0, 0.25, 0.5, 0.75], arc-normalised. The stub
  // centreline is (s * 400, 0, 0) with tangent (1, 0, 0), so checkpoint 1 sits at
  // (100, 0, 0) facing heading 0, and checkpoint 3 sits at (300, 0, 0).
  function outOfBoundsKart(state: SimState): KartState {
    const k = state.karts[0]
    k.position.x = 10
    k.position.y = 0
    k.position.z = 50 // lateral = +z = 50, |lateral| > 5 -> out of bounds
    k.velocity.x = 12
    k.velocity.y = 0
    k.velocity.z = 3
    k.heading = 1
    k.angularVelocity = 0.4
    k.drift.active = true
    k.drift.dir = 1
    k.drift.charge = 55
    k.boostTicks = 9
    k.airborne = true
    k.lap.checkpointIdx = 1
    return k
  }

  it('starts a respawn on the tick the kart leaves the bounds', () => {
    const ctx = makeCtx()
    const state = makeSimState()
    const k = outOfBoundsKart(state)
    const events: AuthEvent[] = []

    updateRecovery(ctx, state, k, events)

    // Detection tick arms the timer; it does not move the kart yet.
    expect(k.respawnTicks).toBe(72) // tuning.respawnTicks
    expect(k.position.x).toBe(10)
    expect(k.position.z).toBe(50)
    // and it freezes the kart
    expect(k.velocity.x).toBe(0)
    expect(k.velocity.y).toBe(0)
    expect(k.velocity.z).toBe(0)
    expect(k.angularVelocity).toBe(0)
    expect(k.airborne).toBe(false)
    expect(k.drift.active).toBe(false)
    expect(k.drift.dir).toBe(0)
    expect(k.drift.charge).toBe(0)
    expect(k.boostTicks).toBe(0)
    expect(k.invulnTicks).toBe(0) // invulnerability is granted on arrival, not on departure

    expect(events.length).toBe(1)
    expect(events[0].kind).toBe('respawn')
    expect(events[0].playerId).toBe(0)
    expect(events[0].entityId).toBe(-1)
    expect(events[0].item).toBe('none')
    expect(events[0].data).toBe(72)
    expect(events[0].eventSeq).toBe(0)
    expect(state.nextEventSeq).toBe(1)
  })

  it('interpolates linearly toward the last checkpoint', () => {
    const ctx = makeCtx()
    const state = makeSimState()
    const k = outOfBoundsKart(state)
    const events: AuthEvent[] = []

    // Call 1 arms the timer at 72. Calls 2..37 are 36 interpolation ticks.
    for (let i = 0; i < 37; i++) updateRecovery(ctx, state, k, events)

    expect(k.respawnTicks).toBe(36) // 72 - 36

    // Each tick moves 1/remaining of the way, so after n of R ticks the remaining
    // fraction is (R - n)/R: after 36 of 72 the kart is exactly half way.
    // Target is checkpoint 1: s = 0.25 -> x = 0.25 * 400 = 100.
    //   x: 10 + 0.5 * (100 - 10) = 55
    //   z: 50 + 0.5 * (0   - 50) = 25
    //   heading: 1 + 0.5 * (0 - 1) = 0.5
    // Not bit-exact because each tick rounds a separate 1/R multiply.
    expect(k.position.x).toBeCloseTo(55, 9)
    expect(k.position.y).toBeCloseTo(0, 12)
    expect(k.position.z).toBeCloseTo(25, 9)
    expect(k.heading).toBeCloseTo(0.5, 9)

    expect(steeringLocked(k)).toBe(true)
    expect(motionLocked(k)).toBe(true)
    expect(events.length).toBe(1) // still only the one respawn event
  })

  it('lands exactly on the checkpoint and grants invulnerability', () => {
    const ctx = makeCtx()
    const state = makeSimState()
    const k = outOfBoundsKart(state)
    const events: AuthEvent[] = []

    // 1 detection tick + 72 interpolation ticks = 73 calls.
    for (let i = 0; i < 73; i++) updateRecovery(ctx, state, k, events)

    expect(k.respawnTicks).toBe(0)
    // checkpointS[1] = 0.25 -> 0.25 * 400 = 100, snapped exactly on the last tick
    expect(k.position.x).toBe(100)
    expect(k.position.y).toBe(0)
    expect(k.position.z).toBe(0)
    expect(k.heading).toBe(0) // atan2(0, 1) == 0
    expect(k.invulnTicks).toBe(90) // tuning.invulnTicks
    expect(steeringLocked(k)).toBe(false)
    expect(motionLocked(k)).toBe(false)
    expect(events.length).toBe(1)
  })

  it('ticks invulnerability down once the kart is back in bounds', () => {
    const ctx = makeCtx()
    const state = makeSimState()
    const k = outOfBoundsKart(state)
    const events: AuthEvent[] = []

    // 73 calls to complete the respawn, then 7 more free-running ticks.
    for (let i = 0; i < 80; i++) updateRecovery(ctx, state, k, events)

    expect(k.invulnTicks).toBe(83) // 90 granted on call 73, minus 7 decrements
    expect(k.respawnTicks).toBe(0)
    // (100, 0, 0) projects to lateral 0, which is in bounds: no second respawn
    expect(events.length).toBe(1)
  })

  it('uses the previous checkpoint when checkpointIdx is -1', () => {
    const ctx = makeCtx()
    const state = makeSimState()
    const k = outOfBoundsKart(state)
    k.lap.checkpointIdx = -1 // wraps to index 3 of [0, 0.25, 0.5, 0.75]
    const events: AuthEvent[] = []

    for (let i = 0; i < 73; i++) updateRecovery(ctx, state, k, events)

    expect(k.position.x).toBe(300) // 0.75 * 400
    expect(k.position.z).toBe(0)
  })

  it('teleports immediately when respawnTicks is tuned to 0', () => {
    const ctx = makeCtx({ respawnTicks: 0 })
    const state = makeSimState()
    const k = outOfBoundsKart(state)
    const events: AuthEvent[] = []

    updateRecovery(ctx, state, k, events)

    expect(k.respawnTicks).toBe(0)
    expect(k.position.x).toBe(100) // 0.25 * 400
    expect(k.position.z).toBe(0)
    expect(k.invulnTicks).toBe(90)
    expect(events.length).toBe(1)
    expect(events[0].data).toBe(0)

    updateRecovery(ctx, state, k, events)
    expect(events.length).toBe(1) // in bounds now, no repeat
    expect(k.invulnTicks).toBe(89)
  })

  it('does not respawn a kart that is inside the bounds', () => {
    const ctx = makeCtx()
    const state = makeSimState()
    const k = state.karts[0]
    k.position.x = 10
    k.position.z = 2 // lateral = +2, inside |lateral| <= 5
    k.velocity.x = 12
    const events: AuthEvent[] = []

    for (let i = 0; i < 10; i++) updateRecovery(ctx, state, k, events)

    expect(k.respawnTicks).toBe(0)
    expect(k.position.x).toBe(10)
    expect(k.velocity.x).toBe(12)
    expect(events.length).toBe(0)
  })
})

describe('spin-out', () => {
  function spinningKart(state: SimState): KartState {
    const k = state.karts[0]
    k.position.x = 10
    k.position.y = 0
    k.position.z = 0 // lateral 0: firmly in bounds
    k.velocity.x = 20
    k.velocity.y = -5 // vertical component, must not be damped
    k.velocity.z = 0
    k.heading = 0
    k.drift.active = true
    k.drift.dir = -1
    k.drift.charge = 88
    k.boostTicks = 14
    k.spinOutTicks = 60 // tuning.spinOutTicks
    return k
  }

  it('exposes the spin constants the tuning table is written against', () => {
    // 4*PI rad/s over 60 ticks == 4*PI rad == exactly two full turns.
    expect(SPIN_YAW_RATE).toBeCloseTo(12.566370614359172, 12)
    expect(SPIN_SPEED_DECAY).toBe(0.94)
  })

  it('forces a visible yaw spin and decays horizontal speed each tick', () => {
    const ctx = makeCtx()
    const state = makeSimState()
    const k = spinningKart(state)
    const events: AuthEvent[] = []

    updateRecovery(ctx, state, k, events)

    expect(k.spinOutTicks).toBe(59)
    expect(k.angularVelocity).toBeCloseTo(12.566370614359172, 12) // 4*PI
    // heading advances SPIN_YAW_RATE * TICK_DT = 4*PI/60 = PI/15
    expect(k.heading).toBeCloseTo(0.20943951023931953, 12)
    // horizontal speed: 20 * 0.94 = 18.8
    expect(k.velocity.x).toBeCloseTo(18.8, 12)
    expect(k.velocity.z).toBeCloseTo(0, 12)
    // vertical speed is gravity's business, untouched
    expect(k.velocity.y).toBe(-5)
    // a spun kart cannot hold a drift charge or a boost
    expect(k.drift.active).toBe(false)
    expect(k.drift.dir).toBe(0)
    expect(k.drift.charge).toBe(0)
    expect(k.boostTicks).toBe(0)

    expect(steeringLocked(k)).toBe(true)
    expect(motionLocked(k)).toBe(false)
    expect(events.length).toBe(0)
  })

  it('runs down to zero over exactly tuning.spinOutTicks ticks', () => {
    const ctx = makeCtx()
    const state = makeSimState()
    const k = spinningKart(state)
    const events: AuthEvent[] = []

    for (let i = 0; i < 59; i++) updateRecovery(ctx, state, k, events)
    expect(k.spinOutTicks).toBe(1)
    expect(steeringLocked(k)).toBe(true)

    updateRecovery(ctx, state, k, events)
    expect(k.spinOutTicks).toBe(0)
    expect(steeringLocked(k)).toBe(false)

    // 20 * 0.94^60 = 0.48831... : the kart is very nearly stopped
    expect(k.velocity.x).toBeCloseTo(20 * Math.pow(0.94, 60), 12)
    expect(k.velocity.x).toBeGreaterThan(0.48)
    expect(k.velocity.x).toBeLessThan(0.49)

    // 60 ticks * 4*PI/60 = 4*PI == 0 mod 2*PI, and wrapAngle keeps it there
    expect(k.heading).toBeCloseTo(0, 9)
  })

  it('stops spinning the tick the kart finishes its spin-out', () => {
    const ctx = makeCtx()
    const state = makeSimState()
    const k = spinningKart(state)
    const events: AuthEvent[] = []

    for (let i = 0; i < 60; i++) updateRecovery(ctx, state, k, events)
    const restingX = k.velocity.x
    const restingHeading = k.heading

    updateRecovery(ctx, state, k, events)

    expect(k.velocity.x).toBe(restingX) // no further decay
    expect(k.heading).toBe(restingHeading) // no further yaw
    expect(k.angularVelocity).toBe(SPIN_YAW_RATE) // left as the spin set it
  })

  it('lets a respawn cancel and replace an in-flight spin-out', () => {
    const ctx = makeCtx()
    const state = makeSimState()
    const k = spinningKart(state)
    k.position.z = 50 // lateral = +50, out of bounds
    k.spinOutTicks = 30
    const events: AuthEvent[] = []

    updateRecovery(ctx, state, k, events)

    expect(k.spinOutTicks).toBe(0)
    expect(k.respawnTicks).toBe(72)
    expect(k.angularVelocity).toBe(0)
    expect(k.velocity.x).toBe(0)
    expect(k.velocity.y).toBe(0)
    expect(events.length).toBe(1)
    expect(events[0].kind).toBe('respawn')
  })

  it('does not spin a kart while it is respawning', () => {
    const ctx = makeCtx()
    const state = makeSimState()
    const k = state.karts[0]
    k.position.x = 10
    k.position.z = 0
    k.respawnTicks = 5
    k.spinOutTicks = 30
    k.lap.checkpointIdx = 1
    const events: AuthEvent[] = []

    updateRecovery(ctx, state, k, events)

    expect(k.respawnTicks).toBe(4)
    expect(k.spinOutTicks).toBe(30) // frozen, not advanced
    expect(k.angularVelocity).toBe(0)
  })
})

describe('startSpinOut', () => {
  it('arms the timer and emits one spinOut event', () => {
    const state = makeSimState()
    const k = state.karts[3]
    k.drift.active = true
    k.drift.dir = 1
    k.drift.charge = 120
    k.boostTicks = 30
    const events: AuthEvent[] = []

    startSpinOut(state, k, 60, events)

    expect(k.spinOutTicks).toBe(60)
    expect(k.drift.active).toBe(false)
    expect(k.drift.dir).toBe(0)
    expect(k.drift.charge).toBe(0)
    expect(k.boostTicks).toBe(0)

    expect(events.length).toBe(1)
    expect(events[0].kind).toBe('spinOut')
    expect(events[0].playerId).toBe(3)
    expect(events[0].entityId).toBe(-1)
    expect(events[0].item).toBe('none')
    expect(events[0].data).toBe(60)
    expect(state.nextEventSeq).toBe(1)
  })

  it('is refused while the kart is invulnerable', () => {
    const state = makeSimState()
    const k = state.karts[0]
    k.invulnTicks = 5
    const events: AuthEvent[] = []

    startSpinOut(state, k, 60, events)

    expect(k.spinOutTicks).toBe(0)
    expect(events.length).toBe(0)
    expect(state.nextEventSeq).toBe(0)
  })

  it('is refused while the kart is respawning', () => {
    const state = makeSimState()
    const k = state.karts[0]
    k.respawnTicks = 10
    const events: AuthEvent[] = []

    startSpinOut(state, k, 60, events)

    expect(k.spinOutTicks).toBe(0)
    expect(k.respawnTicks).toBe(10)
    expect(events.length).toBe(0)
  })

  it('never shortens a spin-out already in progress', () => {
    const state = makeSimState()
    const k = state.karts[0]
    const events: AuthEvent[] = []

    startSpinOut(state, k, 40, events)
    expect(k.spinOutTicks).toBe(40)
    expect(events.length).toBe(1)

    startSpinOut(state, k, 20, events) // shorter: ignored, no second event
    expect(k.spinOutTicks).toBe(40)
    expect(events.length).toBe(1)

    startSpinOut(state, k, 60, events) // longer: extends, and does emit
    expect(k.spinOutTicks).toBe(60)
    expect(events.length).toBe(2)
    expect(events[1].data).toBe(60)
  })

  it('ignores a non-positive duration', () => {
    const state = makeSimState()
    const k = state.karts[0]
    const events: AuthEvent[] = []

    startSpinOut(state, k, 0, events)

    expect(k.spinOutTicks).toBe(0)
    expect(events.length).toBe(0)
  })

  it('runs a full spin-out through updateRecovery with exactly one event', () => {
    const ctx = makeCtx()
    const state = makeSimState()
    const k = state.karts[0]
    k.position.x = 10
    k.position.z = 0
    k.velocity.x = 20
    const events: AuthEvent[] = []

    startSpinOut(state, k, ctx.tuning.spinOutTicks, events)
    expect(k.spinOutTicks).toBe(60)

    for (let i = 0; i < 60; i++) updateRecovery(ctx, state, k, events)

    expect(k.spinOutTicks).toBe(0)
    expect(steeringLocked(k)).toBe(false)
    expect(events.length).toBe(1)
    expect(events[0].kind).toBe('spinOut')
    // 20 * 0.94^60
    expect(k.velocity.x).toBeCloseTo(20 * Math.pow(0.94, 60), 12)
  })
})
