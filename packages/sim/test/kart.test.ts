import { describe, expect, it } from 'vitest'
import { EIGHT_STARTS, makeIntent, makeKart, makeTestContext } from './helpers/flat-context'
import { createState } from '../src/state'
import { stepKart, targetSpeedFor } from '../src/kart'

const ctx = makeTestContext(EIGHT_STARTS)
const state = createState(ctx, 1, [0, 0, 0, 0, 0, 0, 0, 0])

describe('targetSpeedFor', () => {
  it('multiplies maxSpeed by the character speed stat and the accel input', () => {
    // maxSpeed 40 * speed 1.00 * accel 1 * 1 * 1 * 1 = 40
    expect(targetSpeedFor(ctx, state, makeKart({ characterIdx: 0 }), 1)).toBe(40)
    // 40 * 1.10 * 1 = 44
    expect(targetSpeedFor(ctx, state, makeKart({ characterIdx: 1 }), 1)).toBeCloseTo(44, 12)
    // 40 * 0.88 * 1 = 35.2   (character 6 is the slow/high-accel one)
    expect(targetSpeedFor(ctx, state, makeKart({ characterIdx: 6 }), 1)).toBeCloseTo(35.2, 12)
    // 40 * 1.15 * 0.5 = 23
    expect(targetSpeedFor(ctx, state, makeKart({ characterIdx: 5 }), 0.5)).toBeCloseTo(23, 12)
    // 40 * 1.00 * 0.25 = 10
    expect(targetSpeedFor(ctx, state, makeKart({ characterIdx: 0 }), 0.25)).toBe(10)
    // accel 0 -> target 0, the kart coasts down
    expect(targetSpeedFor(ctx, state, makeKart({ characterIdx: 3 }), 0)).toBe(0)
  })

  it('applies boostSpeedMul while boostTicks > 0 and not otherwise', () => {
    // 40 * 1.00 * 1 * 1 * 1 * 1.35 = 54
    expect(targetSpeedFor(ctx, state, makeKart({ characterIdx: 0, boostTicks: 5 }), 1))
      .toBeCloseTo(54, 12)
    // one tick of boost left still counts
    expect(targetSpeedFor(ctx, state, makeKart({ characterIdx: 0, boostTicks: 1 }), 1))
      .toBeCloseTo(54, 12)
    // boostTicks 0 -> factor 1
    expect(targetSpeedFor(ctx, state, makeKart({ characterIdx: 0, boostTicks: 0 }), 1))
      .toBe(40)
    // and it composes with the character stat: 40 * 1.10 * 1 * 1.35 = 59.4
    // (the exact double is 59.400000000000006, hence toBeCloseTo)
    expect(targetSpeedFor(ctx, state, makeKart({ characterIdx: 1, boostTicks: 3 }), 1))
      .toBeCloseTo(59.4, 12)
  })

  it('leaves the surge factor at 1 while no surge entity is live', () => {
    // createState leaves entityCount 0 and every slot dead, so surgeFactorFor
    // finds no 'surge' entity and returns 1: 40 * 1.00 * 1 * 1 * 1 * 1 = 40.
    // This stays true after Task 12 replaces the body with surgeActiveOn(),
    // which also returns false when the pool holds no surge entity.
    expect(state.entityCount).toBe(0)
    expect(targetSpeedFor(ctx, state, makeKart({ characterIdx: 0 }), 1)).toBe(40)
    expect(targetSpeedFor(ctx, state, makeKart({ characterIdx: 0, playerId: 5 }), 1)).toBe(40)
  })
})

describe('stepKart — steering', () => {
  it('yaws at steerRateBase * steer * handling * the speed-authority curve', () => {
    // At 20 m/s: sn = 20 / 40 = 0.5
    //            authority = 0.5 * (1 - 0.55 * 0.5) = 0.5 * 0.725 = 0.3625
    // character 0 handling 1.00: yaw = 2.6 * 1 * 1.00 * 0.3625 = 0.9425 rad/s
    // heading = 0 + 0.9425 / 60 = 0.015708333333333335
    const k = makeKart({ characterIdx: 0, velocity: { x: 20, y: 0, z: 0 } })
    const prevKart = makeKart({ characterIdx: 0, velocity: { x: 20, y: 0, z: 0 } })
    stepKart(ctx, state, prevKart, k, makeIntent({ steer: 1 }))
    expect(k.angularVelocity).toBeCloseTo(0.9425, 12)
    expect(k.heading).toBeCloseTo(0.015708333333333335, 12)

    // character 2 handling 1.10: yaw = 2.6 * 1 * 1.10 * 0.3625 = 1.03675 rad/s
    // heading = 1.03675 / 60 = 0.01727916666666667
    const k2 = makeKart({ characterIdx: 2, velocity: { x: 20, y: 0, z: 0 } })
    const prev2 = makeKart({ characterIdx: 2, velocity: { x: 20, y: 0, z: 0 } })
    stepKart(ctx, state, prev2, k2, makeIntent({ steer: 1 }))
    expect(k2.angularVelocity).toBeCloseTo(1.03675, 12)
    expect(k2.heading).toBeCloseTo(0.01727916666666667, 12)

    // steer is signed: -1 mirrors exactly
    const k3 = makeKart({ characterIdx: 0, velocity: { x: 20, y: 0, z: 0 } })
    const prev3 = makeKart({ characterIdx: 0, velocity: { x: 20, y: 0, z: 0 } })
    stepKart(ctx, state, prev3, k3, makeIntent({ steer: -1 }))
    expect(k3.angularVelocity).toBeCloseTo(-0.9425, 12)
    expect(k3.heading).toBeCloseTo(-0.015708333333333335, 12)
  })

  it('has zero steering authority at rest, so the kart cannot pivot in place', () => {
    // sn = 0 -> authority = 0 * (1 - 0) = 0 -> yaw = 0 regardless of steer
    const k = makeKart({ characterIdx: 0 })
    const prevKart = makeKart({ characterIdx: 0 })
    stepKart(ctx, state, prevKart, k, makeIntent({ steer: 1 }))
    expect(k.angularVelocity).toBe(0)
    expect(k.heading).toBe(0)
  })

  it('reduces steering authority at top speed by steerSpeedFalloff', () => {
    // At 40 m/s: sn = 1, authority = 1 * (1 - 0.55) = 0.45
    // yaw = 2.6 * 1 * 1.00 * 0.45 = 1.17 rad/s, heading = 1.17 / 60 = 0.0195
    const k = makeKart({ characterIdx: 0, velocity: { x: 40, y: 0, z: 0 } })
    const prevKart = makeKart({ characterIdx: 0, velocity: { x: 40, y: 0, z: 0 } })
    stepKart(ctx, state, prevKart, k, makeIntent({ steer: 1 }))
    expect(k.angularVelocity).toBeCloseTo(1.17, 12)
    expect(k.heading).toBeCloseTo(0.0195, 12)

    // above maxSpeed the curve clamps: sn is clamped to 1, so still 1.17
    const kFast = makeKart({ characterIdx: 0, velocity: { x: 80, y: 0, z: 0 } })
    const prevFast = makeKart({ characterIdx: 0, velocity: { x: 80, y: 0, z: 0 } })
    stepKart(ctx, state, prevFast, kFast, makeIntent({ steer: 1 }))
    expect(kFast.angularVelocity).toBeCloseTo(1.17, 12)
  })

  it('measures steering authority from prevKart, not from the live kart', () => {
    // The live kart is stationary but prevKart entered the tick at 20 m/s, so the
    // authority is the 20 m/s one: 2.6 * 1 * 1.00 * 0.3625 = 0.9425
    const k = makeKart({ characterIdx: 0, velocity: { x: 0, y: 0, z: 0 } })
    const prevKart = makeKart({ characterIdx: 0, velocity: { x: 20, y: 0, z: 0 } })
    stepKart(ctx, state, prevKart, k, makeIntent({ steer: 1 }))
    expect(k.angularVelocity).toBeCloseTo(0.9425, 12)
  })

  it('integrates horizontal position from the current velocity', () => {
    // No steer, no throttle, no brake: velocity is unchanged laterally-free here
    // because it is purely forward. position.x += 10 / 60 = 0.16666666666666666
    // minus one tick of coast-down, which the longitudinal test pins separately;
    // this test only fixes that position moves along +X by velocity * TICK_DT.
    const k = makeKart({ characterIdx: 0, velocity: { x: 10, y: 0, z: 0 } })
    const prevKart = makeKart({ characterIdx: 0, velocity: { x: 10, y: 0, z: 0 } })
    stepKart(ctx, state, prevKart, k, makeIntent({ accel: 0.25 }))
    // target = 40 * 1.00 * 0.25 = 10, vf = 10, so delta = 0 and speed holds at 10
    expect(k.velocity.x).toBeCloseTo(10, 12)
    expect(k.position.x).toBeCloseTo(0.16666666666666666, 12)
    expect(k.position.z).toBe(0)
  })
})

describe('stepKart — longitudinal', () => {
  it('accelerates toward targetSpeedFor at accelRate * the character accel stat', () => {
    // character 0: rate = 24 * 1.00 = 24, maxDelta = 24 / 60 = 0.4
    // from rest with accel 1: target 40, delta = clamp(40, -0.4, 0.4) = 0.4
    // position.x = 0 + 0.4 / 60 = 0.006666666666666667
    const k = makeKart({ characterIdx: 0 })
    stepKart(ctx, state, makeKart({ characterIdx: 0 }), k, makeIntent({ accel: 1 }))
    expect(k.velocity.x).toBeCloseTo(0.4, 12)
    expect(k.velocity.z).toBeCloseTo(0, 12)
    expect(k.position.x).toBeCloseTo(0.006666666666666667, 12)

    // character 6: accel stat 1.20 -> rate = 24 * 1.20 = 28.8, maxDelta = 0.48
    // position.x = 0.48 / 60 = 0.008
    const k6 = makeKart({ characterIdx: 6 })
    stepKart(ctx, state, makeKart({ characterIdx: 6 }), k6, makeIntent({ accel: 1 }))
    expect(k6.velocity.x).toBeCloseTo(0.48, 12)
    expect(k6.position.x).toBeCloseTo(0.008, 12)
  })

  it('never overshoots the target speed', () => {
    // 40 - 39.75 = 0.25, which is inside maxDelta 0.4, so it lands exactly on 40
    const k = makeKart({ characterIdx: 0, velocity: { x: 39.75, y: 0, z: 0 } })
    const prevKart = makeKart({ characterIdx: 0, velocity: { x: 39.75, y: 0, z: 0 } })
    stepKart(ctx, state, prevKart, k, makeIntent({ accel: 1 }))
    expect(k.velocity.x).toBe(40)
    expect(k.position.x).toBeCloseTo(0.6666666666666666, 12) // 40 / 60

    // already at target: delta = 0
    const kAt = makeKart({ characterIdx: 0, velocity: { x: 40, y: 0, z: 0 } })
    const prevAt = makeKart({ characterIdx: 0, velocity: { x: 40, y: 0, z: 0 } })
    stepKart(ctx, state, prevAt, kAt, makeIntent({ accel: 1 }))
    expect(kAt.velocity.x).toBe(40)
  })

  it('brakes toward zero at brakeRate, ignoring the throttle', () => {
    // maxDelta = 48 / 60 = 0.8, so 20 -> 19.2
    const k = makeKart({ characterIdx: 0, velocity: { x: 20, y: 0, z: 0 } })
    const prevKart = makeKart({ characterIdx: 0, velocity: { x: 20, y: 0, z: 0 } })
    stepKart(ctx, state, prevKart, k, makeIntent({ accel: 1, brake: true }))
    expect(k.velocity.x).toBeCloseTo(19.2, 12)
  })

  it('coasts down at accelRate when the throttle is released', () => {
    // accel 0 -> target 0, rate = 24 * 1.00, maxDelta = 0.4, so 20 -> 19.6
    const k = makeKart({ characterIdx: 0, velocity: { x: 20, y: 0, z: 0 } })
    const prevKart = makeKart({ characterIdx: 0, velocity: { x: 20, y: 0, z: 0 } })
    stepKart(ctx, state, prevKart, k, makeIntent({ accel: 0 }))
    expect(k.velocity.x).toBeCloseTo(19.6, 12)
  })

  it('never touches the vertical axis', () => {
    const k = makeKart({ characterIdx: 0, velocity: { x: 20, y: -5, z: 0 }, position: { x: 0, y: 7, z: 0 } })
    const prevKart = makeKart({ characterIdx: 0, velocity: { x: 20, y: -5, z: 0 } })
    stepKart(ctx, state, prevKart, k, makeIntent({ accel: 1 }))
    expect(k.velocity.y).toBe(-5)
    expect(k.position.y).toBe(7)
  })
})

// These tests call stepKart directly with a hand-built kart, never through
// step(), because Task 7 recomputes k.surface from the query every tick and would
// otherwise decide the surface for them.
describe('stepKart — lateral grip', () => {
  it('damps sideways velocity by gripTarmac', () => {
    // heading 0 -> forward (1,0,0), right = (-sin h, 0, cos h) = (0,0,1)
    // vf = 0, vr = 10. accel 0 -> target 0 and vf is already 0, so delta = 0.
    // damp = clamp(14 / 60, 0, 1) = 0.23333333333333334
    // vr' = 10 * (1 - 0.23333333333333334) = 7.666666666666666
    // position.z = 0 + 7.666666666666666 / 60 = 0.12777777777777777
    const k = makeKart({ characterIdx: 0, velocity: { x: 0, y: 0, z: 10 }, surface: 'tarmac' })
    const prevKart = makeKart({ characterIdx: 0, velocity: { x: 0, y: 0, z: 10 } })
    stepKart(ctx, state, prevKart, k, makeIntent())
    expect(k.velocity.z).toBeCloseTo(7.666666666666666, 12)
    expect(k.velocity.x).toBeCloseTo(0, 12)
    expect(k.position.z).toBeCloseTo(0.12777777777777777, 12)
  })

  it('damps less on dirt, and least while drifting', () => {
    // dirt: damp = 5 / 60 = 0.08333333333333333 -> 10 * 0.9166666666666667 = 9.166666666666666
    const kDirt = makeKart({ characterIdx: 0, velocity: { x: 0, y: 0, z: 10 }, surface: 'dirt' })
    stepKart(ctx, state, makeKart({ velocity: { x: 0, y: 0, z: 10 } }), kDirt, makeIntent())
    expect(kDirt.velocity.z).toBeCloseTo(9.166666666666666, 12)

    // offtrack grips like TARMAC, not like dirt: gripFor returns gripDirt only for
    // 'dirt'. Off-track is punished with speed (offtrackSpeedMul, Task 9), not with
    // a slide, and Task 8's lateralGripFor makes the same choice — it asserts 14
    // for 'offtrack'. So: damp = 14 / 60 -> 10 * 0.7666666666666666 = 7.666666666666666
    const kOff = makeKart({ characterIdx: 0, velocity: { x: 0, y: 0, z: 10 }, surface: 'offtrack' })
    stepKart(ctx, state, makeKart({ velocity: { x: 0, y: 0, z: 10 } }), kOff, makeIntent())
    expect(kOff.velocity.z).toBeCloseTo(7.666666666666666, 12)

    // boost pads are tarmac-grippy: 7.666666666666666
    const kBoost = makeKart({ characterIdx: 0, velocity: { x: 0, y: 0, z: 10 }, surface: 'boost' })
    stepKart(ctx, state, makeKart({ velocity: { x: 0, y: 0, z: 10 } }), kBoost, makeIntent())
    expect(kBoost.velocity.z).toBeCloseTo(7.666666666666666, 12)

    // drifting overrides the surface: damp = 3 / 60 = 0.05 -> 10 * 0.95 = 9.5
    const kDrift = makeKart({
      characterIdx: 0,
      velocity: { x: 0, y: 0, z: 10 },
      surface: 'tarmac',
      drift: { active: true, dir: 1, charge: 0 },
    })
    stepKart(ctx, state, makeKart({ velocity: { x: 0, y: 0, z: 10 } }), kDrift, makeIntent())
    expect(kDrift.velocity.z).toBeCloseTo(9.5, 12)
  })
})

describe('stepKart — airborne', () => {
  it('leaves orientation and velocity alone but still integrates horizontally', () => {
    // Airborne: no traction, so no yaw, no throttle and no lateral damping.
    // position.x = 1 + 10 / 60 = 1.1666666666666667
    // position.z = 3 +  4 / 60 = 3.066666666666667
    const k = makeKart({
      characterIdx: 0,
      airborne: true,
      heading: 0.3,
      position: { x: 1, y: 2, z: 3 },
      velocity: { x: 10, y: 0, z: 4 },
    })
    const prevKart = makeKart({
      characterIdx: 0,
      airborne: true,
      heading: 0.3,
      velocity: { x: 10, y: 0, z: 4 },
    })
    stepKart(ctx, state, prevKart, k, makeIntent({ steer: 1, accel: 1 }))

    expect(k.velocity.x).toBe(10)
    expect(k.velocity.z).toBe(4)
    expect(k.heading).toBe(0.3)
    expect(k.angularVelocity).toBe(0)
    expect(k.position.x).toBeCloseTo(1.1666666666666667, 12)
    expect(k.position.z).toBeCloseTo(3.066666666666667, 12)
    expect(k.position.y).toBe(2)
  })
})

describe('stepKart — recovery locks and the off-track speed factor', () => {
  it('takes the steering axis away while spinning out, but still integrates motion', () => {
    // steeringLocked(k) is true, so stepKart reads the steer axis as 0 and the yaw
    // term vanishes even at full stick. Everything else still runs: a spinning kart
    // slides, it is not frozen.
    //   longitudinal: accel 0 -> target 0, rate = 24 * 1.00, maxDelta = 24/60 = 0.4,
    //                 so 20 -> 19.6
    //   lateral:      velocity is exactly along heading 0, so vr = 0 and grip is a
    //                 no-op whatever coefficient it picks
    //   position:     0 + 19.6 / 60 = 0.3266666666666667
    const k = makeKart({ characterIdx: 0, velocity: { x: 20, y: 0, z: 0 }, spinOutTicks: 12 })
    const prevKart = makeKart({ characterIdx: 0, velocity: { x: 20, y: 0, z: 0 } })
    stepKart(ctx, state, prevKart, k, makeIntent({ steer: 1 }))

    expect(k.angularVelocity).toBe(0)
    expect(k.heading).toBe(0)
    expect(k.velocity.x).toBeCloseTo(19.6, 12)
    expect(k.position.x).toBeCloseTo(0.3266666666666667, 12)
    expect(k.spinOutTicks).toBe(12) // stepKart never touches the timer

    // The identical kart with no spin-out steers normally, which is what makes the
    // assertions above about the lock and not about the speed-authority curve:
    // sn = 20/40 = 0.5, authority = 0.5 * (1 - 0.55 * 0.5) = 0.3625,
    // yaw = 2.6 * 1 * 1.00 * 0.3625 = 0.9425
    const free = makeKart({ characterIdx: 0, velocity: { x: 20, y: 0, z: 0 } })
    stepKart(ctx, state, makeKart({ velocity: { x: 20, y: 0, z: 0 } }), free, makeIntent({ steer: 1 }))
    expect(free.angularVelocity).toBeCloseTo(0.9425, 12)
  })

  it('does nothing at all while the kart is respawning', () => {
    // motionLocked(k) is true: updateRecovery owns this kart's position, velocity
    // and heading for the whole respawn interpolation, so stepKart must return
    // before the traction block AND before the horizontal position integration.
    // Full stick and full throttle, to prove it is the lock and not the input.
    // prevKart enters at 20 m/s, so without the lock the yaw term would be
    // sn = 0.5, authority = 0.3625, yawRate = 2.6 * 1 * 1.00 * 0.3625 = 0.9425.
    const k = makeKart({
      characterIdx: 0,
      position: { x: 5, y: 1, z: 2 },
      velocity: { x: 20, y: 0, z: 3 },
      heading: 0,
      angularVelocity: 0.5,
      respawnTicks: 7,
    })
    const prevKart = makeKart({ characterIdx: 0, velocity: { x: 20, y: 0, z: 0 } })
    stepKart(ctx, state, prevKart, k, makeIntent({ steer: 1, accel: 1 }))

    expect(k.heading).toBe(0)
    expect(k.angularVelocity).toBe(0.5)
    expect(k.position.x).toBe(5)
    expect(k.position.y).toBe(1)
    expect(k.position.z).toBe(2)
    expect(k.velocity.x).toBe(20)
    expect(k.velocity.z).toBe(3)
    expect(k.respawnTicks).toBe(7)
  })

  it('multiplies the target speed by offtrackSpeedMul, and only off-track', () => {
    // 40 * 1.00 * 1 * 0.55 * 1 * 1 = 22
    expect(targetSpeedFor(ctx, state, makeKart({ characterIdx: 0, surface: 'offtrack' }), 1))
      .toBeCloseTo(22, 12)

    // every other surface contributes exactly 1
    expect(targetSpeedFor(ctx, state, makeKart({ characterIdx: 0, surface: 'tarmac' }), 1)).toBe(40)
    expect(targetSpeedFor(ctx, state, makeKart({ characterIdx: 0, surface: 'dirt' }), 1)).toBe(40)
    expect(targetSpeedFor(ctx, state, makeKart({ characterIdx: 0, surface: 'boost' }), 1)).toBe(40)

    // and it composes with the other factors in the contract's order:
    // 40 * 1.10 * 0.5 * 0.55 * 1 * 1.35 = 16.335
    expect(
      targetSpeedFor(
        ctx,
        state,
        makeKart({ characterIdx: 1, surface: 'offtrack', boostTicks: 4 }),
        0.5,
      ),
    ).toBeCloseTo(16.335, 12)
  })

  it('drives the longitudinal term from the off-track target speed', () => {
    // Off-track target = 40 * 1.00 * 1 * 0.55 = 22. The kart is above it at 30 m/s,
    // so it sheds a full maxDelta: 30 - 24/60 = 29.6.
    const kOff = makeKart({ characterIdx: 0, velocity: { x: 30, y: 0, z: 0 }, surface: 'offtrack' })
    stepKart(
      ctx, state,
      makeKart({ characterIdx: 0, velocity: { x: 30, y: 0, z: 0 } }),
      kOff,
      makeIntent({ accel: 1 }),
    )
    expect(kOff.velocity.x).toBeCloseTo(29.6, 12)

    // The identical kart on tarmac targets 40 and gains instead: 30 + 0.4 = 30.4.
    const kOn = makeKart({ characterIdx: 0, velocity: { x: 30, y: 0, z: 0 }, surface: 'tarmac' })
    stepKart(
      ctx, state,
      makeKart({ characterIdx: 0, velocity: { x: 30, y: 0, z: 0 } }),
      kOn,
      makeIntent({ accel: 1 }),
    )
    expect(kOn.velocity.x).toBeCloseTo(30.4, 12)
  })
})
