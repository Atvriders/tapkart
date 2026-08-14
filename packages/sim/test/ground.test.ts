import { describe, it, expect } from 'vitest'
import type { KartState } from '../src/types'
import {
  applyAirYaw,
  integrateVertical,
  applyRamps,
  applyBoostPad,
  RAMP_MIN_SPEED,
  BOOST_PAD_TICKS,
} from '../src/ground'
import { createState } from '../src/state'
import { step } from '../src/step'
import { makeOvalTrack, makeStraightTrack, makeContext } from './fixtures/track-fixtures'

/**
 * A complete KartState literal. Built locally rather than via createState() so the
 * numbers below depend on nothing but the fields set here. `lap` is never read by
 * this task; the real race-start value is
 * `{ lap: 0, checkpointIdx: track.checkpointS.length - 1, t: 0 }` (contract §0).
 */
function makeKart(overrides: Partial<KartState> = {}): KartState {
  return {
    playerId: 0,
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
    lap: { lap: 0, checkpointIdx: 0, t: 0 },
    ...overrides,
  }
}

describe('ground fixture assumptions', () => {
  it('uses the base tuning values every number below is derived from', () => {
    const ctx = makeContext(makeStraightTrack())
    expect(ctx.tuning.gravity).toBe(30)
    expect(ctx.tuning.airYaw).toBe(0.6)
    expect(ctx.tuning.steerRateBase).toBe(2.6)
    // The straight fixture is a flat run along +X with no banking, so ground height
    // is 0 everywhere. s is arc-normalised [0, 1): 0.2 is a fifth of a lap.
    expect(ctx.query.groundHeight(0.2, 0)).toBe(0)
    // Every ramp span and pad offset below is a fraction of THIS length, in metres.
    expect(ctx.query.totalLength()).toBeCloseTo(1828.3236243, 6)
  })
})

describe('applyAirYaw', () => {
  it('does nothing at all while the kart is on the ground', () => {
    const ctx = makeContext(makeStraightTrack())
    const k = makeKart({ airborne: false, heading: 0.5, angularVelocity: 2 })

    applyAirYaw(ctx, k, 1)

    expect(k.heading).toBe(0.5)
    expect(k.angularVelocity).toBe(2)
  })

  it('cuts airborne yaw to steerRateBase * airYaw, discarding the incoming angular velocity', () => {
    const ctx = makeContext(makeStraightTrack())
    const k = makeKart({ airborne: true, heading: 0.5, angularVelocity: 2 })

    applyAirYaw(ctx, k, 1)

    // airOmega = clamp(1) * steerRateBase(2.6) * airYaw(0.6) = 1.56
    expect(k.angularVelocity).toBeCloseTo(1.56, 10)
    // heading = 0.5 + 1.56 / 60 = 0.526. stepKart never touches heading/angularVelocity
    // while airborne (its whole block is gated on !k.airborne), so there is nothing to
    // rewind: the incoming angularVelocity of 2 is simply overwritten, not subtracted.
    expect(k.heading).toBeCloseTo(0.526, 10)
  })

  it('kills all yaw in the air when the stick is centred', () => {
    const ctx = makeContext(makeStraightTrack())
    const k = makeKart({ airborne: true, heading: 1, angularVelocity: 2 })

    applyAirYaw(ctx, k, 0)

    expect(k.angularVelocity).toBe(0)
    // heading = 1 + 0 / 60 = 1, unchanged. Same reasoning: the incoming
    // angularVelocity of 2 is discarded outright, never rewound into heading.
    expect(k.heading).toBe(1)
  })

  it('keeps advancing the heading on every consecutive airborne tick, not just the first', () => {
    const ctx = makeContext(makeStraightTrack())
    const k = makeKart({ airborne: true, heading: 0, angularVelocity: 0 })

    // airOmega = clamp(1) * steerRateBase(2.6) * airYaw(0.6) = 1.56, constant every tick
    // since steer and tuning never change here.
    applyAirYaw(ctx, k, 1)
    applyAirYaw(ctx, k, 1)
    applyAirYaw(ctx, k, 1)

    // Each call must contribute its own airOmega * TICK_DT; a call that reads back its
    // own previous k.angularVelocity as something to undo would telescope this to a
    // single tick's worth of turn and then go flat, which is exactly the regression
    // this test guards against.
    expect(k.angularVelocity).toBeCloseTo(1.56, 10)
    expect(k.heading).toBeCloseTo(3 * (1.56 / 60), 10)
  })

  it('clamps steer to -1..1 before scaling', () => {
    const ctx = makeContext(makeStraightTrack())
    const k = makeKart({ airborne: true, heading: 0, angularVelocity: 0 })

    applyAirYaw(ctx, k, -3)

    // clamp(-3) = -1 -> airOmega = -1 * 2.6 * 0.6 = -1.56
    expect(k.angularVelocity).toBeCloseTo(-1.56, 10)
    // heading = 0 + (-1.56 - 0) / 60 = -0.026
    expect(k.heading).toBeCloseTo(-0.026, 10)
  })

  it('wraps the resulting heading into (-PI, PI]', () => {
    const ctx = makeContext(makeStraightTrack())
    const k = makeKart({ airborne: true, heading: Math.PI - 0.001, angularVelocity: 0 })

    applyAirYaw(ctx, k, 1)

    // raw = (PI - 0.001) + 1.56 / 60 = 3.140592653589793 + 0.026 = 3.166592653589793
    // wrapped = 3.166592653589793 - 2*PI = -3.116592653589793
    expect(k.heading).toBeCloseTo(-3.116592653589793, 10)
    expect(k.heading).toBeGreaterThan(-Math.PI)
    expect(k.heading).toBeLessThanOrEqual(Math.PI)
  })
})

describe('integrateVertical', () => {
  it('applies gravity for one tick while airborne', () => {
    const ctx = makeContext(makeStraightTrack())
    const k = makeKart({
      airborne: true,
      position: { x: 10, y: 2, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
    })

    integrateVertical(ctx, k)

    // vy = 0 - gravity(30) / 60 = -0.5
    expect(k.velocity.y).toBeCloseTo(-0.5, 12)
    // y = 2 + (-0.5) / 60 = 2 - 0.008333333333333333
    expect(k.position.y).toBeCloseTo(1.9916666666666667, 12)
    expect(k.airborne).toBe(true)
  })

  it('accelerates downward over successive ticks', () => {
    const ctx = makeContext(makeStraightTrack())
    const k = makeKart({
      airborne: true,
      position: { x: 10, y: 2, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
    })

    integrateVertical(ctx, k)
    integrateVertical(ctx, k)

    // vy after two ticks = -1.0
    expect(k.velocity.y).toBeCloseTo(-1, 12)
    // y = 1.9916666666666667 + (-1) / 60 = 1.975
    expect(k.position.y).toBeCloseTo(1.975, 12)
    expect(k.airborne).toBe(true)
  })

  it('snaps to ground height and clears the airborne flag on landing', () => {
    const ctx = makeContext(makeStraightTrack())
    const k = makeKart({
      airborne: true,
      position: { x: 10, y: 0.004, z: 0 },
      velocity: { x: 0, y: -0.5, z: 0 },
    })

    integrateVertical(ctx, k)

    // vy = -0.5 - 0.5 = -1.0; y = 0.004 - 1/60 = -0.012666... which is <= ground(0)
    expect(k.position.y).toBe(0)
    expect(k.velocity.y).toBe(0)
    expect(k.airborne).toBe(false)
  })

  it('does not re-land a kart that is at ground height moving upward', () => {
    const ctx = makeContext(makeStraightTrack())
    const k = makeKart({
      airborne: true,
      position: { x: 10, y: 0, z: 0 },
      velocity: { x: 0, y: 9, z: 0 },
    })

    integrateVertical(ctx, k)

    // vy = 9 - 0.5 = 8.5; y = 0 + 8.5 / 60 = 0.14166666666666666
    expect(k.velocity.y).toBeCloseTo(8.5, 12)
    expect(k.position.y).toBeCloseTo(0.14166666666666666, 12)
    expect(k.airborne).toBe(true)
  })

  it('snaps a grounded kart to the surface and never applies gravity to it', () => {
    const ctx = makeContext(makeStraightTrack())
    const k = makeKart({
      airborne: false,
      position: { x: 10, y: 3, z: 0 },
      velocity: { x: 20, y: 0, z: 0 },
    })

    integrateVertical(ctx, k)

    expect(k.position.y).toBe(0)
    expect(k.velocity.y).toBe(0)   // not -0.5: gravity is airborne-only
    expect(k.airborne).toBe(false)
    expect(k.velocity.x).toBe(20)  // horizontal velocity is untouched
  })
})

/**
 * Ramp spans below are arc-normalised s, per the contract: s is always [0, 1).
 * makeStraightTrack's totalLength() is 1828.3236243 m, so the ramp used through
 * this block, { sStart: 0.2, sEnd: 0.3 }, covers
 *   0.2 * 1828.3236243 = 365.6647249 m  ..  0.3 * 1828.3236243 = 548.4970873 m
 * i.e. a 0.1-lap = 182.8323624 m stretch of the return leg.
 */
describe('applyRamps', () => {
  it('exposes an even, documented speed threshold', () => {
    expect(RAMP_MIN_SPEED).toBe(6)
  })

  it('launches a fast grounded kart inside the ramp s-range', () => {
    const ctx = makeContext(makeStraightTrack({ ramps: [{ sStart: 0.2, sEnd: 0.3, launch: 9 }] }))
    const k = makeKart({ airborne: false, velocity: { x: 12, y: 0, z: 0 } })

    // 0.25 * 1828.3236243 = 457.0809061 m, the middle of the ramp
    applyRamps(ctx, k, 0.25)

    expect(k.velocity.y).toBe(9)      // taken straight from ramp.launch
    expect(k.airborne).toBe(true)
    expect(k.velocity.x).toBe(12)     // horizontal velocity is preserved
  })

  it('treats both ends of the s-range as inside', () => {
    const ctx = makeContext(makeStraightTrack({ ramps: [{ sStart: 0.2, sEnd: 0.3, launch: 9 }] }))

    const atStart = makeKart({ velocity: { x: 12, y: 0, z: 0 } })
    applyRamps(ctx, atStart, 0.2)
    expect(atStart.velocity.y).toBe(9)

    const atEnd = makeKart({ velocity: { x: 12, y: 0, z: 0 } })
    applyRamps(ctx, atEnd, 0.3)
    expect(atEnd.velocity.y).toBe(9)
  })

  it('does not launch outside the s-range', () => {
    const ctx = makeContext(makeStraightTrack({ ramps: [{ sStart: 0.2, sEnd: 0.3, launch: 9 }] }))

    // 0.199 * 1828.3236243 = 363.8364012 m, i.e. 1.83 m short of the ramp
    const before = makeKart({ velocity: { x: 12, y: 0, z: 0 } })
    applyRamps(ctx, before, 0.199)
    expect(before.velocity.y).toBe(0)
    expect(before.airborne).toBe(false)

    // 0.301 * 1828.3236243 = 550.3254109 m, i.e. 1.83 m past its end
    const after = makeKart({ velocity: { x: 12, y: 0, z: 0 } })
    applyRamps(ctx, after, 0.301)
    expect(after.velocity.y).toBe(0)
    expect(after.airborne).toBe(false)
  })

  it('does not launch below RAMP_MIN_SPEED and does launch exactly at it', () => {
    const ctx = makeContext(makeStraightTrack({ ramps: [{ sStart: 0.2, sEnd: 0.3, launch: 9 }] }))

    const slow = makeKart({ velocity: { x: 5.9, y: 0, z: 0 } })
    applyRamps(ctx, slow, 0.25)
    expect(slow.velocity.y).toBe(0)
    expect(slow.airborne).toBe(false)

    const exact = makeKart({ velocity: { x: 6, y: 0, z: 0 } })  // speed = sqrt(36) = 6
    applyRamps(ctx, exact, 0.25)
    expect(exact.velocity.y).toBe(9)
    expect(exact.airborne).toBe(true)
  })

  it('measures speed on the xz plane only', () => {
    const ctx = makeContext(makeStraightTrack({ ramps: [{ sStart: 0.2, sEnd: 0.3, launch: 9 }] }))

    const diagonal = makeKart({ velocity: { x: 3, y: 0, z: 4 } })  // sqrt(9+16) = 5 < 6
    applyRamps(ctx, diagonal, 0.25)
    expect(diagonal.velocity.y).toBe(0)

    const faster = makeKart({ velocity: { x: 6, y: 0, z: 8 } })    // sqrt(36+64) = 10 >= 6
    applyRamps(ctx, faster, 0.25)
    expect(faster.velocity.y).toBe(9)
  })

  it('never re-launches a kart that is already airborne', () => {
    const ctx = makeContext(makeStraightTrack({ ramps: [{ sStart: 0.2, sEnd: 0.3, launch: 9 }] }))
    const k = makeKart({ airborne: true, velocity: { x: 20, y: -2, z: 0 } })

    applyRamps(ctx, k, 0.25)

    expect(k.velocity.y).toBe(-2)
    expect(k.airborne).toBe(true)
  })

  it('handles a ramp whose range wraps through s = 0', () => {
    // sStart 0.3 > sEnd 0.05, so the range is [0.3, 1) plus [0, 0.05]: from
    // 548.4970873 m round through the start line to 91.4161812 m.
    const ctx = makeContext(makeStraightTrack({ ramps: [{ sStart: 0.3, sEnd: 0.05, launch: 7 }] }))

    // 0.02 * 1828.3236243 = 36.5664725 m, inside the [0, 0.05] half
    const justAfterZero = makeKart({ velocity: { x: 12, y: 0, z: 0 } })
    applyRamps(ctx, justAfterZero, 0.02)
    expect(justAfterZero.velocity.y).toBe(7)

    // 0.35 * 1828.3236243 = 639.9132685 m, inside the [0.3, 1) half
    const justBeforeZero = makeKart({ velocity: { x: 12, y: 0, z: 0 } })
    applyRamps(ctx, justBeforeZero, 0.35)
    expect(justBeforeZero.velocity.y).toBe(7)

    // 0.17 * 1828.3236243 = 310.8150161 m, in the gap between the two halves
    const middle = makeKart({ velocity: { x: 12, y: 0, z: 0 } })
    applyRamps(ctx, middle, 0.17)
    expect(middle.velocity.y).toBe(0)
    expect(middle.airborne).toBe(false)
  })

  it('never launches a motion-locked kart, whatever its velocity says', () => {
    // The motion-lock rule (step.ts): while motionLocked(k) — respawnTicks > 0 —
    // updateRecovery owns velocity and airborne, and applyRamps is at slot 7.
    //
    // In step() this is unobservable, because stepRespawn zeroes velocity at slot 2
    // and the RAMP_MIN_SPEED test then rejects the kart anyway. That is exactly why
    // the guard is here: the rejection was a fact about recovery.ts, not about this
    // function, so a direct call with a stale velocity used to launch a respawning
    // kart into the air.
    const ctx = makeContext(makeStraightTrack({ ramps: [{ sStart: 0.2, sEnd: 0.3, launch: 9 }] }))
    const k = makeKart({ airborne: false, velocity: { x: 12, y: 0, z: 0 }, respawnTicks: 40 })

    applyRamps(ctx, k, 0.25)

    expect(k.velocity.y).toBe(0)
    expect(k.airborne).toBe(false)
  })

  it('launches from the first matching ramp when ranges overlap', () => {
    const ctx = makeContext(
      makeStraightTrack({
        ramps: [
          { sStart: 0.2, sEnd: 0.3, launch: 9 },
          { sStart: 0.25, sEnd: 0.4, launch: 4 },
        ],
      }),
    )
    const k = makeKart({ velocity: { x: 12, y: 0, z: 0 } })

    // 0.27 * 1828.3236243 = 493.6473786 m, inside both ramps
    applyRamps(ctx, k, 0.27)

    expect(k.velocity.y).toBe(9)
  })
})

/**
 * The pad used through this block is { s: 0.1, lateral: 0, halfWidth: 2 } on
 * makeStraightTrack, whose totalLength() is 1828.3236243 m. So:
 *   - the pad sits 0.1 * 1828.3236243 = 182.8323624 m along the lap;
 *   - buildTrackQuery gives every pad BOOST_PAD_HALF_LENGTH = 4 m of longitudinal
 *     reach [Task 4], which is 4 / 1828.3236243 = 0.0021878 of s;
 *   - it is 2 m wide either side of the centreline (halfWidth), against the
 *     fixture's uniform 20 m track width, so lateral 3 is on tarmac, not on the pad.
 * s is arc-normalised [0, 1) per the contract: surfaceAt wraps with
 * `s - Math.floor(s)`, so a raw `30` would silently mean s = 0.0.
 */
describe('applyBoostPad', () => {
  it('grants an even number of boost ticks', () => {
    // Input is 30Hz against a 60Hz sim, so every tick budget the player can
    // perceive the start and end of is defined in multiples of 2 ticks.
    expect(BOOST_PAD_TICKS).toBe(36)
    expect(BOOST_PAD_TICKS % 2).toBe(0)
  })

  it('grants boost ticks when the surface under the kart is boost', () => {
    const ctx = makeContext(makeStraightTrack({ boostPads: [{ s: 0.1, lateral: 0, halfWidth: 2 }] }))
    expect(ctx.query.surfaceAt(0.1, 0)).toBe('boost')

    const k = makeKart({ airborne: false, boostTicks: 0 })
    applyBoostPad(ctx, k, 0.1, 0)

    expect(k.boostTicks).toBe(36)
  })

  it('grants nothing off the side of the pad', () => {
    const ctx = makeContext(makeStraightTrack({ boostPads: [{ s: 0.1, lateral: 0, halfWidth: 2 }] }))
    // |3 - 0| = 3 > halfWidth 2, and 3 is still inside the 20 m track, so: tarmac
    expect(ctx.query.surfaceAt(0.1, 3)).toBe('tarmac')

    const k = makeKart({ boostTicks: 0 })
    applyBoostPad(ctx, k, 0.1, 3)

    expect(k.boostTicks).toBe(0)
  })

  it('grants nothing further along the track than the pad', () => {
    const ctx = makeContext(makeStraightTrack({ boostPads: [{ s: 0.1, lateral: 0, halfWidth: 2 }] }))

    // 0.103 - 0.1 = 0.003 of a lap = 5.4849709 m, past the pad's 4 m reach
    expect(ctx.query.surfaceAt(0.103, 0)).toBe('tarmac')
    const justPast = makeKart({ boostTicks: 0 })
    applyBoostPad(ctx, justPast, 0.103, 0)
    expect(justPast.boostTicks).toBe(0)

    // 0.3 - 0.1 = 0.2 of a lap = 365.6647249 m, a fifth of the track away
    const farPast = makeKart({ boostTicks: 0 })
    applyBoostPad(ctx, farPast, 0.3, 0)
    expect(farPast.boostTicks).toBe(0)
  })

  it('grants nothing while the kart is flying over the pad', () => {
    const ctx = makeContext(makeStraightTrack({ boostPads: [{ s: 0.1, lateral: 0, halfWidth: 2 }] }))
    const k = makeKart({ airborne: true, boostTicks: 0 })

    applyBoostPad(ctx, k, 0.1, 0)

    expect(k.boostTicks).toBe(0)
  })

  it('grants nothing to a motion-locked kart dragged across the pad', () => {
    // The motion-lock rule (step.ts): while motionLocked(k) — respawnTicks > 0 —
    // updateRecovery owns boostTicks, and applyBoostPad is at slot 7b. A respawn
    // interpolation can walk a kart straight over a pad; being carried across one
    // is not driving over it, and the grant used to land anyway.
    const ctx = makeContext(makeStraightTrack({ boostPads: [{ s: 0.1, lateral: 0, halfWidth: 2 }] }))
    expect(ctx.query.surfaceAt(0.1, 0)).toBe('boost')

    const k = makeKart({ airborne: false, boostTicks: 0, respawnTicks: 40 })
    applyBoostPad(ctx, k, 0.1, 0)

    expect(k.boostTicks).toBe(0)
  })

  it('extends a shorter boost but never shortens a longer one', () => {
    const ctx = makeContext(makeStraightTrack({ boostPads: [{ s: 0.1, lateral: 0, halfWidth: 2 }] }))

    const shorter = makeKart({ boostTicks: 20 })
    applyBoostPad(ctx, shorter, 0.1, 0)
    expect(shorter.boostTicks).toBe(36)

    const longer = makeKart({ boostTicks: 50 })   // e.g. a tier-3 drift boost of 66, part spent
    applyBoostPad(ctx, longer, 0.1, 0)
    expect(longer.boostTicks).toBe(50)
  })
})

describe('step — the surface under each kart', () => {
  it('recomputes k.surface from the query for every kart, every tick', () => {
    // makeOvalTrack: control points 12 and 13 are dirt, so s in [0.640104, 0.780208)
    // is dirt; the bottom straight is 24 m wide (edge at |lateral| = 12) and the
    // banked right turn is 20 m wide, all tarmac. totalLength() = 1427.7555092.
    const ctx = makeContext(makeOvalTrack())
    const prev = createState(ctx, 1, [0, 0, 0, 0, 0, 0, 0, 0])
    const next = createState(ctx, 1, [0, 0, 0, 0, 0, 0, 0, 0])

    // sampleAt and tangentAt hand back shared scratch, so each field is copied out
    // before the next query call.
    const banked = ctx.query.sampleAt(0.35).position   // inside the right turn
    const bankedX = banked.x
    const bankedZ = banked.z

    const dirt = ctx.query.sampleAt(0.7).position      // inside the dirt sector
    const dirtX = dirt.x
    const dirtZ = dirt.z

    const edge = ctx.query.sampleAt(0.02).position     // on the 24 m bottom straight
    const edgeX = edge.x
    const edgeZ = edge.z
    const tan = ctx.query.tangentAt(0.02)
    const rx = -tan.z                                  // right = (-t.z, 0, t.x)
    const rz = tan.x

    // step() copies prev into next before anything else, so the setup goes on prev.
    // Kart 0: centreline of the banked turn -> tarmac, overwriting a stale 'dirt'.
    prev.karts[0].position.x = bankedX
    prev.karts[0].position.y = 0
    prev.karts[0].position.z = bankedZ
    prev.karts[0].surface = 'dirt'

    // Kart 1: centreline of the dirt sector -> dirt.
    prev.karts[1].position.x = dirtX
    prev.karts[1].position.y = 0
    prev.karts[1].position.z = dirtZ
    prev.karts[1].surface = 'tarmac'

    // Kart 2: 20 m right of the centreline of a 24 m wide straight, so 8 m past the
    // edge -> offtrack. (isInBounds still allows it: the run-off reaches 24 m.)
    prev.karts[2].position.x = edgeX + rx * 20
    prev.karts[2].position.y = 0
    prev.karts[2].position.z = edgeZ + rz * 20
    prev.karts[2].surface = 'tarmac'

    // Empty inputs: every seat gets the neutral intent step()'s loop substitutes, so
    // no kart moves and the only thing under test is the surface classification.
    step(ctx, prev, next, [], [])

    expect(next.karts[0].surface).toBe('tarmac')
    expect(next.karts[1].surface).toBe('dirt')
    expect(next.karts[2].surface).toBe('offtrack')

    // prev is never written
    expect(prev.karts[0].surface).toBe('dirt')
    expect(prev.karts[1].surface).toBe('tarmac')
    expect(prev.karts[2].surface).toBe('tarmac')
  })

  it('marks a kart standing on a boost pad and pays it the pad boost', () => {
    // makeOvalTrack's pad is { s: 0.1, lateral: 0, halfWidth: 4 }, and buildTrackQuery
    // gives every pad BOOST_PAD_HALF_LENGTH = 4 m of reach = 4 / 1427.7555092 =
    // 0.0028016 of s, so the centreline point at s = 0.1 is inside it.
    const ctx = makeContext(makeOvalTrack())
    const prev = createState(ctx, 2, [0, 0, 0, 0, 0, 0, 0, 0])
    const next = createState(ctx, 2, [0, 0, 0, 0, 0, 0, 0, 0])

    const pad = ctx.query.sampleAt(0.1).position
    prev.karts[0].position.x = pad.x
    prev.karts[0].position.y = 0
    prev.karts[0].position.z = pad.z
    prev.karts[0].surface = 'tarmac'
    prev.karts[0].boostTicks = 0

    step(ctx, prev, next, [], [])

    expect(next.karts[0].surface).toBe('boost')
    // applyBoostPad granted BOOST_PAD_TICKS on this same tick. Task 8 later wires
    // decayBoost in as the last call of the loop, which spends one tick of it, so
    // this asserts the grant happened rather than an exact remaining count.
    expect(next.karts[0].boostTicks).toBeGreaterThanOrEqual(BOOST_PAD_TICKS - 1)
  })
})
