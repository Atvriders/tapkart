import { describe, expect, it } from 'vitest'
import type { AuthEvent, Intent, SimContext, SimState } from '../src/types'
import { MAX_KARTS } from '../src/types'
import { EIGHT_STARTS, makeIntent, makeTestContext } from './helpers/flat-context'
import {
  makeCircleTrack, makeContext, makeOvalTrack, makeStraightTrack,
} from './fixtures/track-fixtures'
import { createState, statesEqual } from '../src/state'
import { step } from '../src/step'

describe('step', () => {
  // Every kart here stays at rest with no intents, so the only observable effect
  // of a tick is the tick counter. That stays true once Task 6 wires stepKart in:
  // at zero speed with a neutral intent, stepKart's yaw, longitudinal and lateral
  // terms are all exactly zero.
  //
  // updateLaps [Task 11] is the one exception: it recomputes k.lap.t from the
  // kart's actual position every tick, whether or not the kart moved, because a
  // kart sitting anywhere except exactly on a checkpoint is genuinely partway
  // through its held segment from the moment it exists. createState leaves
  // lap.t at the placeholder 0 -- accurate only for a kart standing exactly on
  // checkpointS[checkpointIdx] -- so a hand-built `prev` at some arbitrary tick
  // (7, here) is only internally consistent if lap.t already reflects where the
  // grid actually sits, the way a real run's prev always would once updateLaps
  // has run at least once. Each seat's t is
  //   (s - checkpointS[3]) / (checkpointS[0] + 1 - checkpointS[3]) = (s - 0.75) / 0.25
  // where s = seat.x / 1000 (EIGHT_STARTS' grid, lateral offsets do not move s on
  // this flat track). With prev.karts[i].lap.t already at that fixed point,
  // stepping with no motion reproduces the identical value, so the "changes
  // nothing else" claim holds exactly as it did before Task 11.
  it('advances the tick by exactly one and changes nothing else', () => {
    const ctx = makeTestContext(EIGHT_STARTS)
    const prev = createState(ctx, 7, [0, 1, 2, 3, 4, 5, 6, 7])
    const next = createState(ctx, 7, [0, 1, 2, 3, 4, 5, 6, 7])

    // EIGHT_STARTS x, in seat order: 996, 992, 988, 984, 980, 976, 972, 968.
    const gridT = [
      0.984, 0.968, 0.952, 0.9359999999999999,
      0.9199999999999999, 0.9039999999999999, 0.8879999999999999, 0.8719999999999999,
    ]
    for (let i = 0; i < MAX_KARTS; i++) prev.karts[i].lap.t = gridT[i]

    prev.tick = 7
    prev.nextEventSeq = 9
    prev.rngCursor = 4
    prev.karts[1].item = 'seeker'
    prev.karts[1].lap.lap = 2
    prev.finishedOrder[0] = 5
    prev.itemBoxes[0].respawnTicks = 30

    const events: AuthEvent[] = []
    step(ctx, prev, next, [], events)

    expect(next.tick).toBe(8)
    expect(prev.tick).toBe(7) // prev is never written
    expect(next.nextEventSeq).toBe(9) // updateLaps credits nothing: no crossing occurred
    expect(next.rngCursor).toBe(4)
    expect(next.karts[1].item).toBe('seeker')
    expect(next.karts[1].lap.lap).toBe(2)
    expect(next.karts[1].lap.checkpointIdx).toBe(3) // still behind the line, uncredited
    expect(next.karts[1].lap.t).toBe(gridT[1]) // recomputed, but to the same fixed point
    expect(next.finishedOrder[0]).toBe(5)
    // Task 13 wires updateItemBoxes into step(): a live respawn timer ticks down
    // unconditionally every call, whether or not any kart is near the box (no
    // kart here is within reach of box 0, on this track or any other seat).
    expect(next.itemBoxes[0].respawnTicks).toBe(29)

    next.tick = prev.tick
    // Neutralize the same, deliberate itemBoxRespawnTicks countdown before the
    // bit-exact compare, exactly as the line above does for tick itself.
    next.itemBoxes[0].respawnTicks = prev.itemBoxes[0].respawnTicks
    expect(statesEqual(prev, next)).toBe(true)
  })

  it('writes only into next, never aliasing or reallocating', () => {
    const ctx = makeTestContext(EIGHT_STARTS)
    const prev = createState(ctx, 7, [0, 1, 2, 3, 4, 5, 6, 7])
    const next = createState(ctx, 7, [0, 1, 2, 3, 4, 5, 6, 7])

    const kartsRef = next.karts
    const posRef = next.karts[2].position
    step(ctx, prev, next, [], [])

    expect(next.karts).toBe(kartsRef)
    expect(next.karts[2].position).toBe(posRef)
    expect(next.karts[2].position).not.toBe(prev.karts[2].position)

    next.karts[2].position.x = 123
    expect(prev.karts[2].position.x).toBe(988) // seat 2 starts at s = 0.988 -> x = 988 m
  })

  it('counts ticks correctly when the caller double-buffers', () => {
    const ctx = makeTestContext(EIGHT_STARTS)
    let cur: SimState = createState(ctx, 7, [0, 1, 2, 3, 4, 5, 6, 7])
    let nxt: SimState = createState(ctx, 7, [0, 1, 2, 3, 4, 5, 6, 7])
    const events: AuthEvent[] = []

    for (let i = 0; i < 10; i++) {
      step(ctx, cur, nxt, [], events)
      const tmp = cur
      cur = nxt
      nxt = tmp
    }

    expect(cur.tick).toBe(10)
    expect(cur.karts[3].position.x).toBe(984) // seat 3 never moved: s = 0.984 -> x = 984 m
    expect(cur.karts[3].position.z).toBe(-3)
    // Every seat's grid s (0.996..0.968) sits in the same last checkpoint segment
    // [0.75, 1) that createState's initial checkpointIdx (3) already represents, so
    // updateLaps sees idx === cur on every tick and never credits a crossing -- this
    // is the regression the fixture fix (coordinator ruling, fix round 1) exists for.
    expect(events).toHaveLength(0)
  })
})

describe('step — per-kart loop', () => {
  // Every test here sets prev.phase = 'racing'. It changes nothing today — this
  // task's step() has no phase gating — but Task 15's resolveInputs freezes every
  // intent to zero while the phase is 'countdown', which is what createState
  // starts in. Setting it now means these expectations survive Task 15 untouched.
  it('runs stepKart for every seat, indexing inputs by playerId', () => {
    const ctx = makeTestContext(EIGHT_STARTS)
    const prev = createState(ctx, 7, [0, 0, 0, 0, 0, 0, 0, 0])
    const next = createState(ctx, 7, [0, 0, 0, 0, 0, 0, 0, 0])
    prev.phase = 'racing'
    // createState defaults every kart to isBot: true, connected: false. Task 15's
    // resolveInputs now honours that flag and drives such a seat from botIntent
    // instead of the raw input below -- every seat must declare itself human here
    // or the "no intent supplied -> stays parked" and "supplied intent drives the
    // kart" expectations below would instead be measuring bot behaviour.
    for (let i = 0; i < MAX_KARTS; i++) {
      prev.karts[i].isBot = false
      prev.karts[i].connected = true
    }

    const inputs: Intent[] = []
    inputs[0] = makeIntent({ accel: 1 })

    step(ctx, prev, next, inputs, [])

    // Seat 0, character 0: rate = accelRate 24 * accel stat 1.00 = 24,
    // maxDelta = 24 / 60 = 0.4, from rest -> velocity.x = 0.4
    // Its grid slot is s = 0.996 (4 m before the line) -> world x = 996, so
    // position.x = 996 + 0.4 / 60 = 996.0066666666667
    expect(next.karts[0].velocity.x).toBeCloseTo(0.4, 12)
    expect(next.karts[0].position.x).toBeCloseTo(996.0066666666667, 9)

    // Seat 1 got no intent -> NEUTRAL_INTENT -> still parked at its grid slot,
    // s = 0.992 of a 1000 m lap = world x = 992. Seat 7: s = 0.968 -> x = 968.
    expect(next.karts[1].velocity.x).toBe(0)
    expect(next.karts[1].position.x).toBe(992)
    expect(next.karts[7].velocity.x).toBe(0)
    expect(next.karts[7].position.x).toBe(968)

    // prev is never written
    expect(prev.karts[0].velocity.x).toBe(0)
    expect(prev.karts[0].position.x).toBe(996)
    expect(next.tick).toBe(1)
  })

  it('applies steering through the loop for a moving kart', () => {
    const ctx = makeTestContext(EIGHT_STARTS)
    const prev = createState(ctx, 7, [0, 0, 0, 0, 0, 0, 0, 0])
    const next = createState(ctx, 7, [0, 0, 0, 0, 0, 0, 0, 0])
    prev.phase = 'racing'
    // See the note in the previous test: without this, seat 0 defaults to
    // isBot: true and resolveInputs [Task 15] drives it from botIntent, not the
    // raw steer: 1 below.
    prev.karts[0].isBot = false
    prev.karts[0].connected = true
    prev.karts[0].velocity.x = 20

    const inputs: Intent[] = []
    inputs[0] = makeIntent({ steer: 1 })

    step(ctx, prev, next, inputs, [])

    // sn = 20 / 40 = 0.5, authority = 0.5 * (1 - 0.55 * 0.5) = 0.3625
    // yaw = 2.6 * 1 * 1.00 * 0.3625 = 0.9425, heading = 0.9425 / 60
    expect(next.karts[0].angularVelocity).toBeCloseTo(0.9425, 12)
    expect(next.karts[0].heading).toBeCloseTo(0.015708333333333335, 12)
    expect(prev.karts[0].heading).toBe(0)
    expect(prev.karts[0].angularVelocity).toBe(0)
  })

  it('is deterministic: the same inputs from the same state give bit-equal output', () => {
    const ctx = makeTestContext(EIGHT_STARTS)
    const prev = createState(ctx, 7, [0, 1, 2, 3, 4, 5, 6, 7])
    const a = createState(ctx, 7, [0, 1, 2, 3, 4, 5, 6, 7])
    const b = createState(ctx, 7, [0, 1, 2, 3, 4, 5, 6, 7])
    prev.phase = 'racing'

    const inputs: Intent[] = []
    for (let i = 0; i < 8; i++) {
      inputs[i] = makeIntent({ steer: i % 2 === 0 ? 0.5 : -0.5, accel: 1 })
    }

    step(ctx, prev, a, inputs, [])
    step(ctx, prev, b, inputs, [])
    expect(statesEqual(a, b)).toBe(true)
    expect(statesEqual(prev, a)).toBe(false)
  })
})

describe('step — recovery at slot 2', () => {
  it('spends a spin-out tick, and the integrator sees the steering lock', () => {
    const ctx = makeTestContext(EIGHT_STARTS)
    const prev = createState(ctx, 7, [0, 0, 0, 0, 0, 0, 0, 0])
    const next = createState(ctx, 7, [0, 0, 0, 0, 0, 0, 0, 0])
    prev.karts[0].spinOutTicks = 60
    prev.karts[0].velocity.x = 20 // enough speed that steering would bite

    const inputs: Intent[] = []
    inputs[0] = makeIntent({ steer: 1 })

    step(ctx, prev, next, inputs, [])

    // updateRecovery spent one tick of the spin and forced the yaw:
    //   heading = 0 + SPIN_YAW_RATE * TICK_DT = 4*PI / 60 = PI/15 = 0.20943951023931953
    expect(next.karts[0].spinOutTicks).toBe(59)
    expect(next.karts[0].heading).toBeCloseTo(0.20943951023931953, 12)
    // and stepKart, running after it, read steeringLocked and added no yaw of its
    // own — without the lock this would be 2.6 * 1 * 1.00 * 0.3625 = 0.9425
    expect(next.karts[0].angularVelocity).toBe(0)

    // prev is never written
    expect(prev.karts[0].spinOutTicks).toBe(60)
    expect(prev.karts[0].heading).toBe(0)
  })

  it('respawns a kart that is out of bounds at the top of the tick', () => {
    const ctx = makeTestContext(EIGHT_STARTS)
    const prev = createState(ctx, 7, [0, 0, 0, 0, 0, 0, 0, 0])
    const next = createState(ctx, 7, [0, 0, 0, 0, 0, 0, 0, 0])
    // makeFlatQuery projects lateral = position.z and bounds it at |lateral| <= 10
    prev.karts[0].position.z = 50
    prev.karts[0].velocity.x = 20
    const events: AuthEvent[] = []

    step(ctx, prev, next, [], events)

    expect(next.karts[0].respawnTicks).toBe(72) // tuning.respawnTicks
    expect(next.karts[0].velocity.x).toBe(0)    // beginRespawn freezes the kart
    expect(next.karts[0].position.z).toBe(50)   // the detection tick does not move it
    // and stepKart honoured motionLocked, so nothing integrated on top of it.
    // Seat 0's grid slot is s = 0.996 -> world x = 996.
    expect(next.karts[0].position.x).toBe(996)

    // Filtered by kind: later tasks add lap and item events to this same tick, and
    // this test is about the respawn only.
    const respawns = events.filter((e) => e.kind === 'respawn')
    expect(respawns.length).toBe(1)
    expect(respawns[0].playerId).toBe(0)
    expect(respawns[0].entityId).toBe(-1)
    expect(respawns[0].data).toBe(72)

    expect(prev.karts[0].respawnTicks).toBe(0) // prev is never written
  })
})

describe('step — useItem at slot 2.5, after updateRecovery', () => {
  // useItem was called at the top of the kart loop body, ahead of updateRecovery.
  // Its own guard ("a spun-out or respawning kart holds on to its item rather than
  // wasting it") could therefore only ever see LAST tick's recovery state, so on the
  // tick a kart went out of bounds the guard saw a healthy kart, spent the item and
  // set boostTicks — and beginRespawn zeroed boostTicks a few lines later. The item
  // was consumed and its effect erased, which is the exact outcome the guard exists
  // to prevent. Moving the call to slot 2.5 hands the guard this tick's state.
  function outOfBoundsWithBoost(): {
    ctx: SimContext
    prev: SimState
    next: SimState
    inputs: Intent[]
  } {
    const ctx = makeTestContext(EIGHT_STARTS)
    const prev = createState(ctx, 7, [0, 0, 0, 0, 0, 0, 0, 0])
    const next = createState(ctx, 7, [0, 0, 0, 0, 0, 0, 0, 0])
    prev.phase = 'racing'
    prev.tick = 300
    // Driven by the supplied Intent, not by botIntent (resolveInputs keys on this).
    prev.karts[0].isBot = false
    prev.karts[0].connected = true
    prev.karts[0].item = 'boost'
    prev.karts[0].boostTicks = 0
    const inputs: Intent[] = []
    inputs[0] = makeIntent({ tick: 300, useItem: true })
    return { ctx, prev, next, inputs }
  }

  it('keeps the item when the kart goes out of bounds on the same tick', () => {
    const { ctx, prev, next, inputs } = outOfBoundsWithBoost()
    // makeFlatQuery bounds at |lateral| <= 10 and projects lateral = position.z
    prev.karts[0].position.z = 50

    step(ctx, prev, next, inputs, [])

    expect(next.karts[0].respawnTicks).toBe(72) // tuning.respawnTicks: recovery fired
    expect(next.karts[0].item).toBe('boost')    // ...so the item was never spent
    expect(next.karts[0].boostTicks).toBe(0)
  })

  it('still fires the item on the same tick when the kart is in bounds', () => {
    // The other half of the move: slot 2.5 is still ahead of slot 4, so a boost
    // fired this tick is live when stepKart reads boostTicks through targetSpeedFor,
    // exactly as it was from the old position at the top of the loop body.
    const { ctx, prev, next, inputs } = outOfBoundsWithBoost()
    prev.karts[0].position.z = 0 // in bounds

    step(ctx, prev, next, inputs, [])

    expect(next.karts[0].respawnTicks).toBe(0)
    expect(next.karts[0].item).toBe('none')
    // ITEM_BOOST_TICKS 90 granted at slot 2.5, one spent by decayBoost at slot 8.
    expect(next.karts[0].boostTicks).toBe(89)
  })

  it('has the fired boost live in stepKart, which runs at slot 4', () => {
    // The justification for the ORIGINAL placement was that a boost fired this tick
    // must be live before stepKart reads boostTicks through targetSpeedFor. Slot 2.5
    // is still ahead of slot 4, so it still is — proven here rather than asserted.
    //
    // Both karts are character 0 (speed 1.0, accel 1.0), on tarmac, heading 0, at
    // rest laterally, with accel = 1 and steer = 0. Entering the tick at exactly
    // maxSpeed pins the difference on the boost alone:
    //
    //   maxDelta      = accelRate 24 * ch.accel 1.0 * TICK_DT 1/60 = 0.4 m/s
    //   target (no boost) = maxSpeed 40 * 1.0 * accel 1 * 1 * 1 * 1        = 40
    //   target (boosted)  = maxSpeed 40 * 1.0 * accel 1 * 1 * 1 * 1.35     = 54
    //   vf = 40, so unboosted delta = 0 and boosted delta clamps to +maxDelta
    //   => velocity.x is exactly 40 unboosted and exactly 40.4 boosted.
    //
    // steer 0 keeps heading at 0, so forward is +X and velocity.x IS vf. The
    // lateral term is zero on both sides. integrateVertical only touches y.
    const withItem = outOfBoundsWithBoost()
    withItem.prev.karts[0].position.z = 0
    withItem.prev.karts[0].velocity.x = 40
    withItem.inputs[0] = makeIntent({ tick: 300, accel: 1, useItem: true })
    step(withItem.ctx, withItem.prev, withItem.next, withItem.inputs, [])

    const without = outOfBoundsWithBoost()
    without.prev.karts[0].position.z = 0
    without.prev.karts[0].velocity.x = 40
    without.prev.karts[0].item = 'none'
    without.inputs[0] = makeIntent({ tick: 300, accel: 1, useItem: true })
    step(without.ctx, without.prev, without.next, without.inputs, [])

    expect(withItem.next.karts[0].boostTicks).toBe(89)
    expect(without.next.karts[0].boostTicks).toBe(0)
    expect(without.next.karts[0].velocity.x).toBeCloseTo(40, 12)
    expect(withItem.next.karts[0].velocity.x).toBeCloseTo(40.4, 12)
    expect(withItem.next.karts[0].velocity.x).toBeGreaterThan(
      without.next.karts[0].velocity.x,
    )
  })
})

describe('step — applyAirYaw honours steeringLocked (fix round 1)', () => {
  it('does not let raw steer override the forced spin yaw of an airborne, spun-out kart', () => {
    // Premise-2 finding: applyAirYaw (Task 7) unconditionally assigns
    // k.angularVelocity from the raw steer whenever k.airborne is true, with no
    // awareness of steeringLocked. Without a guard at the call site, an airborne
    // kart mid spin-out would have updateRecovery's forced yaw (slot 2) clobbered
    // by a player-steered air yaw (slot 5), even though stepKart (slot 4) correctly
    // declined to touch it.
    const ctx = makeTestContext(EIGHT_STARTS)
    const prev = createState(ctx, 7, [0, 0, 0, 0, 0, 0, 0, 0])
    const next = createState(ctx, 7, [0, 0, 0, 0, 0, 0, 0, 0])
    prev.karts[0].airborne = true
    prev.karts[0].position.y = 5
    prev.karts[0].velocity.y = 10 // stays well clear of the ground for this tick
    prev.karts[0].spinOutTicks = 60

    const inputs: Intent[] = []
    inputs[0] = makeIntent({ steer: 1 }) // full stick: would drive air yaw if not locked

    step(ctx, prev, next, inputs, [])

    // Still airborne when applyAirYaw's call site is reached this tick, so the only
    // thing that can have stopped it from running is the steeringLocked guard.
    expect(next.karts[0].airborne).toBe(true)
    expect(next.karts[0].spinOutTicks).toBe(59)

    // updateRecovery (slot 2) forces the spin yaw unconditionally:
    //   angularVelocity = SPIN_YAW_RATE = 4*PI = 12.566370614359172
    //   heading = 0 + SPIN_YAW_RATE * TICK_DT = 4*PI/60 = PI/15 = 0.20943951023931953
    // stepKart (slot 4) leaves both alone while airborne. If applyAirYaw (slot 5)
    // had run unguarded, angularVelocity would instead be
    // clamp(1,-1,1) * steerRateBase(2.6) * airYaw(0.6) = 1.56.
    expect(next.karts[0].angularVelocity).toBeCloseTo(12.566370614359172, 12)
    expect(next.karts[0].heading).toBeCloseTo(0.20943951023931953, 12)
  })

  it('still applies ordinary air steering for an airborne kart that is not locked', () => {
    // Confirms the guard is a lock check, not a blanket "never steer in the air"
    // regression: an airborne kart with no spin-out and no respawn steers exactly
    // as before.
    const ctx = makeTestContext(EIGHT_STARTS)
    const prev = createState(ctx, 7, [0, 0, 0, 0, 0, 0, 0, 0])
    const next = createState(ctx, 7, [0, 0, 0, 0, 0, 0, 0, 0])
    // Task 15's resolveInputs freezes every intent to zero while phase is
    // 'countdown' (createState's default) and drives isBot: true seats (also
    // createState's default) from botIntent -- neither of which this test wants,
    // since it is asserting the raw steer: 1 below reaches applyAirYaw unchanged.
    prev.phase = 'racing'
    prev.karts[0].isBot = false
    prev.karts[0].connected = true
    prev.karts[0].airborne = true
    prev.karts[0].position.y = 5
    prev.karts[0].velocity.y = 10

    const inputs: Intent[] = []
    inputs[0] = makeIntent({ steer: 1 })

    step(ctx, prev, next, inputs, [])

    // airOmega = clamp(1, -1, 1) * steerRateBase(2.6) * airYaw(0.6) = 1.56
    // heading = 0 + 1.56 * TICK_DT = 1.56 / 60 = 0.026
    expect(next.karts[0].angularVelocity).toBeCloseTo(1.56, 12)
    expect(next.karts[0].heading).toBeCloseTo(0.026, 12)
  })
})

describe('step — kart collisions after the per-kart loop', () => {
  /**
   * Two karts abreast at the same `s`, one metre apart across the track, with the
   * other six parked far away so they cannot join in. Same `s` matters: the flat
   * query's groundHeight depends only on `s`, so both karts sit at the same height
   * and neither is airborne, and the contact normal is exactly (0, 0, 1).
   * Contact distance is 2 * tuning.kartRadius = 1.8, so 1.0 apart is overlapping.
   */
  function abreastPair(state: SimState): void {
    state.karts[0].position.x = 0
    state.karts[0].position.y = 0
    state.karts[0].position.z = 0
    state.karts[1].position.x = 0
    state.karts[1].position.y = 0
    state.karts[1].position.z = 1
    for (let i = 2; i < state.karts.length; i++) {
      state.karts[i].position.x = 1000 + i * 100
      state.karts[i].position.y = 0
      state.karts[i].position.z = 0
    }
  }

  it('pushes two overlapping karts apart to exactly 2 * kartRadius', () => {
    const ctx = makeTestContext(EIGHT_STARTS)
    const prev = createState(ctx, 7, [0, 0, 0, 0, 0, 0, 0, 0])
    const next = createState(ctx, 7, [0, 0, 0, 0, 0, 0, 0, 0])
    abreastPair(prev)

    step(ctx, prev, next, [], [])

    // Both karts are at rest with no intent, so every per-kart stage is a no-op and
    // resolveKartCollisions is the only thing that can move them. Equal weights
    // (both character 0, weight 1.00), so each yields half of the overlap
    // 1.8 - 1.0 = 0.8 along the +z normal:
    //   kart 0: 0 - 0.4 = -0.4 ; kart 1: 1 + 0.4 = 1.4
    expect(next.karts[0].position.z).toBeCloseTo(-0.4, 12)
    expect(next.karts[1].position.z).toBeCloseTo(1.4, 12)
    expect(next.karts[0].position.x).toBeCloseTo(0, 12)
    expect(next.karts[1].position.x).toBeCloseTo(0, 12)
    // neither kart was closing on the other, so no impulse was applied
    expect(next.karts[0].velocity.z).toBe(0)
    expect(next.karts[1].velocity.z).toBe(0)
    // prev is never written
    expect(prev.karts[0].position.z).toBe(0)
    expect(prev.karts[1].position.z).toBe(1)
  })

  it('applies the impulse to the velocities the per-kart loop just wrote', () => {
    const ctx = makeTestContext(EIGHT_STARTS)
    const prev = createState(ctx, 7, [0, 0, 0, 0, 0, 0, 0, 0])
    const next = createState(ctx, 7, [0, 0, 0, 0, 0, 0, 0, 0])
    abreastPair(prev)
    prev.karts[0].velocity.z = 10  // closing on kart 1
    prev.karts[1].velocity.z = -10 // closing on kart 0

    step(ctx, prev, next, [], [])

    // Stage 4 (stepKart) runs first and damps the lateral component: heading is 0,
    // so right = (0, 0, 1) and the whole velocity is lateral, vf = 0.
    //   damp  = clamp(gripTarmac * TICK_DT, 0, 1) = 14 / 60 = 0.23333333333333334
    //   v0.z  =  10 * (1 - 0.23333333333333334) =  7.666666666666666
    //   v1.z  = -10 * (1 - 0.23333333333333334) = -7.666666666666666
    // then it integrates position with the post-damp velocity:
    //   z0 = 0 + 7.666666666666666 / 60 = 0.12777777777777777
    //   z1 = 1 - 7.666666666666666 / 60 = 0.8722222222222222
    // Then resolveKartCollisions, normal (0, 0, 1), gap 0.7444444444444445:
    //   overlap = 1.8 - 0.7444444444444445 = 1.0555555555555554, split 50/50
    //   z0 = 0.12777777777777777 - 0.5277777777777777 = -0.4
    //   z1 = 0.8722222222222222  + 0.5277777777777777 =  1.4
    //   (equivalently: the pair's centroid stays at 0.5 and the gap becomes 1.8)
    //   vn = -7.666666666666666 - 7.666666666666666 = -15.333333333333332
    //   j  = -(1 + 0.4) * (-15.333333333333332) / (1/1 + 1/1) = 10.733333333333333
    //   v0.z =  7.666666666666666 - 10.733333333333333 = -3.066666666666667
    //   v1.z = -7.666666666666666 + 10.733333333333333 =  3.066666666666667
    expect(next.karts[0].position.z).toBeCloseTo(-0.4, 9)
    expect(next.karts[1].position.z).toBeCloseTo(1.4, 9)
    expect(next.karts[1].position.z - next.karts[0].position.z).toBeCloseTo(1.8, 9)
    expect(next.karts[0].velocity.z).toBeCloseTo(-3.066666666666667, 9)
    expect(next.karts[1].velocity.z).toBeCloseTo(3.066666666666667, 9)
    // separating speed is restitution * closing speed: 0.4 * 15.333333333333332
    expect(next.karts[1].velocity.z - next.karts[0].velocity.z)
      .toBeCloseTo(6.133333333333333, 9)
  })

  it('pushes a grounded kart off its ground height for one tick, then integrateVertical re-snaps it', () => {
    // ground.ts documents integrateVertical as "the only writer of position.y /
    // velocity.y within the per-kart loop" -- resolveKartCollisions writes them
    // too, once per tick, after that loop, because a kart-vs-kart contact is a
    // real 3D sphere collision and neither reads nor writes k.airborne. This test
    // drives that fact through step() across two ticks: tick 1 shows the
    // collision's vertical push landing on kart 0 even though kart 0.airborne
    // stays false throughout; tick 2 shows that push discarded the moment
    // integrateVertical runs again, because a grounded kart's y is always
    // recomputed from the analytic ground height at its current x/z, never kept
    // from whatever wrote it last.
    const ctx = makeTestContext(EIGHT_STARTS)
    const prev = createState(ctx, 7, [0, 0, 0, 0, 0, 0, 0, 0])
    const mid = createState(ctx, 7, [0, 0, 0, 0, 0, 0, 0, 0])

    // kart 0: grounded, at rest, at the origin (groundHeight(s=0) = 0).
    prev.karts[0].position.x = 0
    prev.karts[0].position.y = 0
    prev.karts[0].position.z = 0
    // kart 1: airborne, parked 1 m directly above kart 0, at rest. Same x as
    // kart 0, so its `s` -- and the ground height under it -- is also 0.
    prev.karts[1].position.x = 0
    prev.karts[1].position.y = 1
    prev.karts[1].position.z = 0
    prev.karts[1].airborne = true
    for (let i = 2; i < prev.karts.length; i++) {
      prev.karts[i].position.x = 1000 + i * 100
      prev.karts[i].position.y = 0
      prev.karts[i].position.z = 0
    }

    step(ctx, prev, mid, [], [])

    // Tick 1: stepKart is a no-op for both (zero velocity, neutral intent, and it
    // never touches y regardless). integrateVertical drops kart 1 one tick under
    // gravity: v.y = 0 - 30/60 = -0.5, y = 1 + (-0.5)/60 = 119/120, still above
    // ground(0), so it stays airborne. Kart 0's integrateVertical leaves it at
    // (0, 0, 0) exactly -- it is already at its ground height. Then
    // resolveKartCollisions sees a genuine 3D contact along +y (dy = 119/120,
    // inside the 1.8 contact distance) and, per this task's "collides in three
    // dimensions" behaviour, applies separation and impulse on the y axis to
    // BOTH karts -- including kart 0, whose airborne flag is still false:
    //   overlap = 1.8 - 119/120 = 97/120, split 0.5/0.5 (equal weight 1.00 both)
    //   kart0.y = 0 - 97/240 = -0.40416666666666667
    //   kart1.y = 119/120 + 97/240 = 1.3958333333333333  (gap is exactly 1.8)
    //   vn = -0.5 - 0 = -0.5 ; j = -(1.4) * (-0.5) / 2 = 0.35
    //   kart0.vy = 0 - 0.35 = -0.35 ; kart1.vy = -0.5 + 0.35 = -0.15
    expect(mid.karts[0].airborne).toBe(false)
    expect(mid.karts[0].position.x).toBeCloseTo(0, 12)
    expect(mid.karts[0].position.z).toBeCloseTo(0, 12)
    expect(mid.karts[0].position.y).toBeCloseTo(-0.40416666666666667, 9)
    expect(mid.karts[0].velocity.y).toBeCloseTo(-0.35, 9)
    expect(mid.karts[1].position.y).toBeCloseTo(1.3958333333333333, 9)
    expect(mid.karts[1].velocity.y).toBeCloseTo(-0.15, 9)

    // Relocate kart 1 far away -- as if it drove off after landing -- so tick 2
    // has no further contact to resolve. This isolates integrateVertical as the
    // only thing that can explain what happens to kart 0's y next: nothing else
    // in step() writes position.y or velocity.y, and no collision fires this tick.
    mid.karts[1].position.x = 1100
    mid.karts[1].position.y = 0
    mid.karts[1].position.z = 0
    mid.karts[1].velocity.y = 0
    mid.karts[1].airborne = false

    const next = createState(ctx, 7, [0, 0, 0, 0, 0, 0, 0, 0])
    step(ctx, mid, next, [], [])

    // Tick 2: kart 0's airborne flag is still false (collision never touches it),
    // so integrateVertical takes its unconditional grounded branch and overwrites
    // whatever tick 1 left there, computed fresh from kart 0's current x (still 0)
    // -- not from kart 0's own prior y or vy. This is the whole claim: a
    // collision's vertical write to a grounded kart survives only until the next
    // tick's integrateVertical call.
    expect(next.karts[0].position.y).toBe(0)
    expect(next.karts[0].velocity.y).toBe(0)
    expect(next.karts[0].position.x).toBe(0)
    expect(next.karts[0].position.z).toBe(0)
  })
})

/**
 * Regression coverage for the grid-placement defect fix round 1 caught: a start
 * grid placed PAST the s = 0 line (inside checkpoint segment 0) rather than
 * BEHIND it (in the last segment) made `updateLaps` [Task 11] read the very
 * first tick's static position as a legitimate "crossed checkpoint 0" transition
 * from `checkpointIdx = checkpointS.length - 1`, crediting a lap nobody drove --
 * before the countdown even finished, since nothing in `step()` gates on race
 * phase yet. `makeCircleTrack`'s grid already sat behind the line and never
 * tripped this; `makeStraightTrack`, `makeOvalTrack` and `EIGHT_STARTS` did,
 * silently, in every test that happened not to check lap fields or event counts.
 *
 * This suite pins the invariant directly so a future grid change that
 * reintroduces the defect fails here, at the source, rather than three tasks
 * later in an unrelated test's event-count assertion.
 */
describe('createState / step grid invariant (regression)', () => {
  function assertBehindTheLine(ctx: SimContext, state: SimState): void {
    const lastIdx = ctx.track.checkpointS.length - 1
    for (let i = 0; i < MAX_KARTS; i++) {
      expect(state.karts[i].lap.lap).toBe(0)
      expect(state.karts[i].lap.checkpointIdx).toBe(lastIdx)
      // The check above alone is vacuous as a regression guard: createState sets
      // checkpointIdx to checkpointS.length - 1 unconditionally, from the track's
      // checkpoint count alone, regardless of where the grid physically sits --
      // it would pass identically on the pre-fix grids that started this whole
      // fix round. The real invariant the defect violated is that the kart's
      // ACTUAL position projects into that same last segment, which is exactly
      // what updateLaps itself checks (checkpointIndexAt(project(position).s)),
      // so asserting it here through the same query is what would have failed
      // on `makeStraightTrack`/`makeOvalTrack`/`EIGHT_STARTS` before the fix
      // (their old grids projected to checkpointIndexAt 0, not lastIdx).
      const s = ctx.query.project(state.karts[i].position).s
      expect(ctx.query.checkpointIndexAt(s)).toBe(lastIdx)
    }
  }

  function assertNoLapCreditedOverNeutralTicks(ctx: SimContext, ticks: number): void {
    let cur = createState(ctx, 1, [0, 0, 0, 0, 0, 0, 0, 0])
    let nxt = createState(ctx, 1, [0, 0, 0, 0, 0, 0, 0, 0])
    cur.phase = 'racing' // step() has no phase gating yet, but set it anyway: this
    // invariant must hold whether or not a future task adds one.
    assertBehindTheLine(ctx, cur)

    const events: AuthEvent[] = []
    for (let i = 0; i < ticks; i++) {
      step(ctx, cur, nxt, [], events)
      const tmp = cur
      cur = nxt
      nxt = tmp
    }

    for (let i = 0; i < MAX_KARTS; i++) {
      expect(cur.karts[i].lap.lap).toBe(0)
      expect(cur.karts[i].lap.checkpointIdx).toBe(ctx.track.checkpointS.length - 1)
    }
    expect(events.filter((e) => e.kind === 'lapCross' || e.kind === 'finish')).toHaveLength(0)
  }

  it('createState starts every kart behind the line, on every fixture', () => {
    assertBehindTheLine(makeTestContext(EIGHT_STARTS), createState(makeTestContext(EIGHT_STARTS), 1, []))
    assertBehindTheLine(makeContext(makeStraightTrack()), createState(makeContext(makeStraightTrack()), 1, []))
    assertBehindTheLine(makeContext(makeOvalTrack()), createState(makeContext(makeOvalTrack()), 1, []))
    assertBehindTheLine(makeContext(makeCircleTrack()), createState(makeContext(makeCircleTrack()), 1, []))
  })

  it('stepping from the grid with neutral input never credits a lap: flat/EIGHT_STARTS', () => {
    assertNoLapCreditedOverNeutralTicks(makeTestContext(EIGHT_STARTS), 5)
  })

  it('stepping from the grid with neutral input never credits a lap: straight', () => {
    assertNoLapCreditedOverNeutralTicks(makeContext(makeStraightTrack()), 5)
  })

  it('stepping from the grid with neutral input never credits a lap: oval', () => {
    assertNoLapCreditedOverNeutralTicks(makeContext(makeOvalTrack()), 5)
  })

  it('stepping from the grid with neutral input never credits a lap: circle', () => {
    assertNoLapCreditedOverNeutralTicks(makeContext(makeCircleTrack()), 5)
  })
})
