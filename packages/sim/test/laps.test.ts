import { describe, it, expect } from 'vitest'
import type {
  AuthEvent, EntityState, Intent, KartState, SimContext, SimState, Track, TrackQuery,
} from '../src/types'
import { MAX_ENTITIES, MAX_KARTS, RACE_LAPS } from '../src/types'
import { makeCharacters, makeTuning } from './fixtures/track-fixtures'
import { updateLaps } from '../src/laps'
import { step } from '../src/step'
import { updateRecovery } from '../src/recovery'

// A stub track: a 400 m loop whose arc-normalised parameter is simply the
// kart's x divided by the lap length, wrapped into [0, 1). The contract fixes
// `s` as arc-normalised everywhere in this package -- never metres -- so
// checkpointS holds 0 / 0.25 / 0.5 / 0.75 and every segment is a quarter lap
// (100 m of the 400 m loop). Checkpoint 0 is the start/finish line.
//
// project() follows the locked convention right = (-t.z, 0, t.x); for the +X
// tangent (1,0,0) that is (0,0,1), so lateral is +z.
//
// Every kart x below is a multiple of 12.5 m, which is exactly 1/32 of a lap,
// so every s is a dyadic rational and every t assertion in this file is exact
// in binary floating point rather than approximate.
const TRACK_LEN = 400

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
    bounds: { min: { x: -1000, y: -10, z: -1000 }, max: { x: 1000, y: 10, z: 1000 } },
  }
  const query: TrackQuery = {
    sampleAt: (s) => ({
      position: { x: wrap01(s) * TRACK_LEN, y: 0, z: 0 },
      width: 20,
      banking: 0,
      surface: 'tarmac',
    }),
    tangentAt: () => ({ x: 1, y: 0, z: 0 }),
    project: (p) => ({ s: wrap01(p.x / TRACK_LEN), lateral: p.z, distance: Math.abs(p.z) }),
    groundHeight: () => 0,
    surfaceAt: () => 'tarmac',
    isInBounds: (_s, lateral) => Math.abs(lateral) <= 10,
    checkpointIndexAt: (s) => Math.min(3, Math.floor(wrap01(s) * 4)),
    totalLength: () => TRACK_LEN,
  }
  return { track, query, tuning: makeTuning(), characters: makeCharacters(), isLeader }
}

// checkpointIdx 3 is what createState [Task 5] gives every kart on a
// 4-checkpoint track: karts start behind the s = 0 line holding the last
// checkpoint, so the first crossing of the line is worth a lap.
function blankKart(playerId: number): KartState {
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
    tick: 500,
    phase: 'racing',
    raceSeed: 12345,
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

describe('updateLaps', () => {
  it('advances the checkpoint index when the next checkpoint is crossed in order', () => {
    const ctx = stubContext()
    const state = blankState()
    const k = state.karts[0]
    const events: AuthEvent[] = []
    k.lap.lap = 0
    k.lap.checkpointIdx = 0
    k.lap.t = 0.5
    k.position.x = 137.5 // s = 137.5 / 400 = 0.34375 -> segment 1, which starts at s = 0.25

    updateLaps(ctx, state, k, events)

    expect(k.lap.checkpointIdx).toBe(1)
    // t = (0.34375 - 0.25) / (0.5 - 0.25) = 0.09375 / 0.25 = 0.375
    expect(k.lap.t).toBe(0.375)
    expect(k.lap.lap).toBe(0)
    expect(events.length).toBe(0)
  })

  it('increments the lap when the finish line is crossed with every checkpoint hit', () => {
    const ctx = stubContext()
    const state = blankState()
    const k = state.karts[4]
    const events: AuthEvent[] = []
    k.lap.lap = 0
    k.lap.checkpointIdx = 3
    k.lap.t = 0.9
    k.position.x = 412.5 // 412.5 / 400 = 1.03125 -> wraps to s = 0.03125 -> segment 0

    updateLaps(ctx, state, k, events)

    expect(k.lap.checkpointIdx).toBe(0)
    expect(k.lap.lap).toBe(1)
    // t = (0.03125 - 0) / (0.25 - 0) = 0.125
    expect(k.lap.t).toBe(0.125)
    expect(events.length).toBe(1)
    expect(events[0].kind).toBe('lapCross')
    expect(events[0].playerId).toBe(4)
    expect(events[0].entityId).toBe(-1)
    expect(events[0].item).toBe('none')
    expect(events[0].data).toBe(1) // the new lap number
    expect(events[0].eventSeq).toBe(0)
    expect(events[0].tick).toBe(500)
    expect(state.nextEventSeq).toBe(1)
    // no finisher yet, so every fixed slot still holds the -1 sentinel
    expect(state.finishedOrder).toEqual([-1, -1, -1, -1, -1, -1, -1, -1])
    expect(state.finishTick).toBe(-1)
  })

  it('does not advance when a checkpoint is crossed backwards', () => {
    const ctx = stubContext()
    const state = blankState()
    const k = state.karts[1]
    const events: AuthEvent[] = []
    k.lap.lap = 1
    k.lap.checkpointIdx = 2
    k.lap.t = 0.05
    k.position.x = 187.5 // s = 0.46875 -> segment 1, i.e. BEHIND checkpoint 2

    updateLaps(ctx, state, k, events)

    expect(k.lap.checkpointIdx).toBe(2) // unchanged: 1 is neither 2 nor 3
    expect(k.lap.lap).toBe(1)
    expect(k.lap.t).toBe(0.05) // frozen while off-segment
    expect(events.length).toBe(0)

    // driving forward again into its own segment resumes t updates only
    k.position.x = 250 // s = 0.625 -> segment 2
    updateLaps(ctx, state, k, events)
    expect(k.lap.checkpointIdx).toBe(2)
    expect(k.lap.lap).toBe(1)
    // t = (0.625 - 0.5) / (0.75 - 0.5) = 0.125 / 0.25 = 0.5
    expect(k.lap.t).toBe(0.5)
    expect(events.length).toBe(0)
  })

  it('does not advance when a checkpoint is skipped', () => {
    const ctx = stubContext()
    const state = blankState()
    const k = state.karts[2]
    const events: AuthEvent[] = []
    k.lap.lap = 0
    k.lap.checkpointIdx = 0
    k.lap.t = 0.9
    k.position.x = 250 // s = 0.625 -> segment 2, skipping checkpoint 1

    updateLaps(ctx, state, k, events)

    expect(k.lap.checkpointIdx).toBe(0)
    expect(k.lap.t).toBe(0.9)
    expect(k.lap.lap).toBe(0)
    expect(events.length).toBe(0)
  })

  it('does not decrement the lap when the finish line is crossed backwards', () => {
    const ctx = stubContext()
    const state = blankState()
    const k = state.karts[3]
    const events: AuthEvent[] = []
    k.lap.lap = 2
    k.lap.checkpointIdx = 0
    k.lap.t = 0.02
    k.position.x = 375 // s = 0.9375 -> segment 3, i.e. back across the line

    updateLaps(ctx, state, k, events)

    expect(k.lap.lap).toBe(2)
    expect(k.lap.checkpointIdx).toBe(0)
    expect(k.lap.t).toBe(0.02)
    expect(events.length).toBe(0)

    // driving forward again lands back in segment 0, which the kart already
    // holds, so it only resumes t: no second lap for the same crossing
    k.position.x = 25 // s = 0.0625 -> segment 0
    updateLaps(ctx, state, k, events)
    expect(k.lap.lap).toBe(2)
    expect(k.lap.checkpointIdx).toBe(0)
    // t = (0.0625 - 0) / (0.25 - 0) = 0.25
    expect(k.lap.t).toBe(0.25)
    expect(events.length).toBe(0)
  })

  it('records the finish once at RACE_LAPS and never again', () => {
    const ctx = stubContext()
    const state = blankState()
    state.tick = 1234
    const k = state.karts[6]
    const events: AuthEvent[] = []
    k.lap.lap = RACE_LAPS - 1 // 2
    k.lap.checkpointIdx = 3
    k.lap.t = 0.8
    k.position.x = 412.5 // s = 0.03125 -> segment 0

    updateLaps(ctx, state, k, events)

    expect(k.lap.lap).toBe(3)
    // written into slot 0; the other seven slots keep the -1 sentinel
    expect(state.finishedOrder).toEqual([6, -1, -1, -1, -1, -1, -1, -1])
    expect(state.finishTick).toBe(1234)
    expect(events.length).toBe(2)
    expect(events[0].kind).toBe('lapCross')
    expect(events[0].data).toBe(3)
    expect(events[0].eventSeq).toBe(0)
    expect(events[1].kind).toBe('finish')
    expect(events[1].playerId).toBe(6)
    expect(events[1].entityId).toBe(-1)
    expect(events[1].item).toBe('none')
    expect(events[1].data).toBe(1) // 1-based finishing place: slot 0 + 1
    expect(events[1].eventSeq).toBe(1)
    expect(events[1].tick).toBe(1234)

    // a fourth line crossing still counts the lap but must not re-finish
    state.tick = 1600
    k.lap.checkpointIdx = 3
    k.position.x = 812.5 // 812.5 / 400 = 2.03125 -> wraps to s = 0.03125 -> segment 0
    updateLaps(ctx, state, k, events)

    expect(k.lap.lap).toBe(4)
    expect(state.finishedOrder).toEqual([6, -1, -1, -1, -1, -1, -1, -1])
    expect(state.finishTick).toBe(1234)
    expect(events.length).toBe(3)
    expect(events[2].kind).toBe('lapCross')
    expect(events[2].data).toBe(4)
  })

  it('sets finishTick from the first finisher only and keeps finishedOrder in crossing order', () => {
    const ctx = stubContext()
    const state = blankState()
    const events: AuthEvent[] = []

    const a = state.karts[5]
    a.lap.lap = 2
    a.lap.checkpointIdx = 3
    a.position.x = 412.5 // s = 0.03125 -> segment 0
    state.tick = 900
    updateLaps(ctx, state, a, events)

    const b = state.karts[2]
    b.lap.lap = 2
    b.lap.checkpointIdx = 3
    b.position.x = 425 // 425 / 400 = 1.0625 -> wraps to s = 0.0625 -> segment 0
    state.tick = 950
    updateLaps(ctx, state, b, events)

    // slots fill front to back; the six unused slots keep the -1 sentinel
    expect(state.finishedOrder).toEqual([5, 2, -1, -1, -1, -1, -1, -1])
    expect(state.finishTick).toBe(900)
    // 2 events per finisher: lapCross then finish
    expect(events.length).toBe(4)
    expect(events[1].kind).toBe('finish')
    expect(events[1].playerId).toBe(5)
    expect(events[1].data).toBe(1)
    expect(events[3].kind).toBe('finish')
    expect(events[3].playerId).toBe(2)
    expect(events[3].data).toBe(2) // second place: slot 1 + 1
    expect(events[3].tick).toBe(950)
  })

  it('does not credit a checkpoint crossed only by the respawn interpolation, and resumes normal crediting once respawnTicks reaches 0', () => {
    // updateRecovery [Task 9] lerps a respawning kart through world space toward
    // its HELD checkpoint every tick, and updateLaps reads that interpolated
    // position in the same tick (step()'s slot 2 then slot 9). If the kart's
    // checkpointIdx lags its true position by two or more segments -- reachable
    // through a designed shortcut that skips a checkpoint while staying in
    // bounds, then later goes out of bounds -- the multi-tick lerp back to the
    // held checkpoint can sweep straight through an intervening segment's s
    // range and be misread as a genuine forward crossing.
    //
    // This kart holds checkpointIdx 3 (last legitimately crossed) but sits, off
    // track, at raw x = 550 -- past the s = 1/0 seam, so project() reads it as
    // s = 0.375, segment 1: two segments ahead of what it holds (skipped
    // checkpoint 0, the finish line, and checkpoint 1). Respawn targets
    // checkpoint 3 (x = 300), and the straight lerp from x = 550 down to x = 300
    // necessarily crosses x = 400 -- s = 0 -- along the way: exactly the
    // finish line, exactly the scenario that would otherwise mint a lapCross
    // nobody drove. Verified via a hand trace (and cross-checked in Node) that
    // tick 2 of the interpolation (respawnTicks 8 -> 7, the second updateRecovery
    // call after detection) lands at x = 487.5, s = 0.21875, checkpointIndexAt
    // 0 == next -- the exact tick this test's RED run (guard absent) credits a
    // lap and fires 'lapCross' on.
    const ctx = stubContext()
    ctx.tuning = makeTuning({ respawnTicks: 8 })
    const state = blankState()
    const k = state.karts[0]
    const events: AuthEvent[] = []
    k.lap.lap = 0
    k.lap.checkpointIdx = 3
    k.lap.t = 0.5 // sentinel: must stay untouched, not just "uncredited"
    k.position.x = 550 // s = wrap01(550/400) = 0.375 -> segment 1
    k.position.z = 50 // |lateral| > 10 -> out of bounds

    const lapEvents = (): AuthEvent[] =>
      events.filter((e) => e.kind === 'lapCross' || e.kind === 'finish')

    // Detection tick: updateRecovery arms the respawn; updateLaps must already
    // be a no-op even here, since respawnTicks is nonzero by the time it runs.
    updateRecovery(ctx, state, k, events)
    updateLaps(ctx, state, k, events)
    expect(k.respawnTicks).toBe(8)
    expect(k.lap.checkpointIdx).toBe(3)
    expect(k.lap.t).toBe(0.5)
    expect(lapEvents()).toHaveLength(0)

    // 7 interpolation ticks, respawnTicks 8 -> 1. x runs 550, 518.75, 487.5 (the
    // finish-line-crossing tick), 456.25, 425, 393.75, 362.5, 331.25 -- through
    // segment 1, twice through segment 0 (including the seam), then segment 3 --
    // and none of it may touch checkpointIdx, t or lap.
    for (let i = 0; i < 7; i++) {
      updateRecovery(ctx, state, k, events)
      updateLaps(ctx, state, k, events)
    }
    expect(k.respawnTicks).toBe(1)
    expect(k.lap.checkpointIdx).toBe(3)
    expect(k.lap.lap).toBe(0)
    expect(k.lap.t).toBe(0.5)
    expect(lapEvents()).toHaveLength(0)

    // Final tick: stepRespawn snaps exactly onto checkpoint 3 (x = 300, s = 0.75)
    // and zeroes respawnTicks BEFORE updateLaps runs this same tick, so the kart
    // is no longer motion-locked when updateLaps sees it -- but it is sitting
    // exactly on checkpointS[3], so idx === cur and nothing is credited; t
    // resets to 0, matching "exactly what it was when it went out of bounds".
    updateRecovery(ctx, state, k, events)
    updateLaps(ctx, state, k, events)
    expect(k.respawnTicks).toBe(0)
    expect(k.position.x).toBe(300)
    expect(k.lap.checkpointIdx).toBe(3)
    expect(k.lap.lap).toBe(0)
    expect(k.lap.t).toBe(0)
    expect(lapEvents()).toHaveLength(0)

    // Normal crediting resumes: driving forward across the line for real, now
    // that the kart is no longer motion-locked, is a genuine crossing and must
    // be credited exactly as if it had never respawned.
    k.position.x = 425 // s = 0.0625 -> segment 0
    k.position.z = 0
    updateLaps(ctx, state, k, events)
    expect(k.lap.checkpointIdx).toBe(0)
    expect(k.lap.lap).toBe(1)
    const laps = lapEvents()
    expect(laps).toHaveLength(1)
    expect(laps[0].kind).toBe('lapCross')
    expect(laps[0].data).toBe(1)
  })
})

describe('step() wiring', () => {
  it('runs updateLaps for every kart as the last per-kart stage', () => {
    const ctx = stubContext()
    const prev = blankState()
    const next = blankState()
    prev.tick = 700
    prev.phase = 'racing'

    // Kart 0 sits just past the start/finish line still holding the last
    // checkpoint, so updateLaps owes it a lap: x = 412.5 -> s = 0.03125,
    // which is checkpoint segment 0.
    prev.karts[0].position.x = 412.5
    prev.karts[0].lap.lap = 0
    prev.karts[0].lap.checkpointIdx = 3
    // Everyone else is spaced 20 m apart (far past kartRadius 0.9, so
    // resolveKartCollisions never fires) and holds checkpoint 1. They sit in
    // segments 0 and 1, neither of which is checkpoint 2, so none of them is
    // credited anything and none of them emits.
    for (let i = 1; i < MAX_KARTS; i++) {
      prev.karts[i].position.x = 412.5 + 20 * i
      prev.karts[i].lap.checkpointIdx = 1
    }

    const inputs: Intent[] = []
    for (let i = 0; i < MAX_KARTS; i++) {
      inputs.push({
        tick: 700, steer: 0, accel: 0, brake: false, drift: false, useItem: false,
      })
    }
    const events: AuthEvent[] = []

    step(ctx, prev, next, inputs, events)

    expect(next.tick).toBe(701)
    expect(next.karts[0].lap.checkpointIdx).toBe(0)
    expect(next.karts[0].lap.lap).toBe(1)
    // Every kart is at rest with accel 0, so stepKart moves nobody and the
    // lap arithmetic is the same as the direct call above:
    // t = (0.03125 - 0) / (0.25 - 0) = 0.125
    expect(next.karts[0].lap.t).toBe(0.125)

    expect(events.length).toBe(1)
    expect(events[0].kind).toBe('lapCross')
    expect(events[0].playerId).toBe(0)
    expect(events[0].data).toBe(1)
    // updateLaps runs against `next`, whose tick is already prev.tick + 1
    expect(events[0].tick).toBe(701)

    // step never mutates prev
    expect(prev.karts[0].lap.lap).toBe(0)
    expect(prev.karts[0].lap.checkpointIdx).toBe(3)
    expect(prev.tick).toBe(700)
  })
})

describe('updateLaps on a follower', () => {
  it('crosses the line and finishes exactly as a leader does, but announces nothing', () => {
    const leaderCtx = stubContext(true)
    const followerCtx = stubContext(false)
    const leaderState = blankState()
    const followerState = blankState()
    const leaderKart = leaderState.karts[1]
    const followerKart = followerState.karts[1]
    // s = 4 / 400 = 0.01, inside checkpoint 0's [0, 0.25) range; checkpointIdx 3
    // (the last of four) plus lap 2 means this crossing completes lap 3.
    leaderKart.position.x = 4
    leaderKart.lap = { lap: 2, checkpointIdx: 3, t: 0.99 }
    followerKart.position.x = 4
    followerKart.lap = { lap: 2, checkpointIdx: 3, t: 0.99 }
    const leaderEvents: AuthEvent[] = []
    const followerEvents: AuthEvent[] = []

    updateLaps(leaderCtx, leaderState, leaderKart, leaderEvents)
    updateLaps(followerCtx, followerState, followerKart, followerEvents)

    // Simulation identical: both complete lap 3 and both finish.
    expect(followerKart.lap.lap).toBe(leaderKart.lap.lap)
    expect(followerKart.lap.lap).toBe(3)
    expect(followerKart.lap.checkpointIdx).toBe(leaderKart.lap.checkpointIdx)
    expect(followerState.finishedOrder[0]).toBe(leaderState.finishedOrder[0])
    expect(followerState.finishedOrder[0]).toBe(1)
    expect(followerState.finishTick).toBe(leaderState.finishTick)

    // Announcement suppressed on the follower only.
    expect(leaderEvents.length).toBe(2)
    expect(leaderEvents[0].kind).toBe('lapCross')
    expect(leaderEvents[1].kind).toBe('finish')
    expect(followerEvents.length).toBe(0)
    expect(leaderState.nextEventSeq).toBe(2)
    expect(followerState.nextEventSeq).toBe(0)
  })
})
