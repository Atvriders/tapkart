import { describe, it, expect } from 'vitest'
import type { Intent, KartState, Surface } from '../src/types'
import { TICK_DT } from '../src/types'
import {
  updateDrift,
  decayBoost,
  driftTierFor,
  lateralGripFor,
  DRIFT_STEER_MIN,
} from '../src/drift'
import { createState } from '../src/state'
import { stepKart } from '../src/kart'
import { makeTuning, makeStraightTrack, makeContext } from './fixtures/track-fixtures'

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

function makeIntent(overrides: Partial<Intent> = {}): Intent {
  return { tick: 0, steer: 0, accel: 1, brake: false, drift: false, useItem: false, ...overrides }
}

describe('drift fixture assumptions', () => {
  it('uses the base tuning values every number below is derived from', () => {
    const t = makeTuning()
    expect(t.driftMinSpeed).toBe(8)
    expect(t.driftTiers).toEqual([40, 90, 150])
    expect(t.driftBoosts).toEqual([24, 42, 66])
    expect(t.gripDrift).toBe(3)
    expect(t.gripDirt).toBe(5)
    expect(t.gripTarmac).toBe(14)
  })
})

describe('drift tier quantization', () => {
  it('defines every tier threshold and every boost length in whole 2-tick pairs', () => {
    const t = makeTuning()
    for (const threshold of t.driftTiers) {
      expect(threshold % 2).toBe(0)
    }
    for (const boost of t.driftBoosts) {
      expect(boost % 2).toBe(0)
    }
    // Spelled out so a tuning change that breaks the rule fails with a readable diff:
    expect(t.driftTiers).toEqual([40, 90, 150])   // 0.667s / 1.5s / 2.5s of held drift
    expect(t.driftBoosts).toEqual([24, 42, 66])   // 0.4s / 0.7s / 1.1s of boost
  })
})

describe('driftTierFor', () => {
  it('maps charge to the tier index that indexes driftBoosts', () => {
    const tiers: [number, number, number] = [40, 90, 150]
    expect(driftTierFor(0, tiers)).toBe(-1)
    expect(driftTierFor(39, tiers)).toBe(-1)
    expect(driftTierFor(40, tiers)).toBe(0)
    expect(driftTierFor(89, tiers)).toBe(0)
    expect(driftTierFor(90, tiers)).toBe(1)
    expect(driftTierFor(149, tiers)).toBe(1)
    expect(driftTierFor(150, tiers)).toBe(2)
  })

  it('saturates at the top tier', () => {
    const tiers: [number, number, number] = [40, 90, 150]
    expect(driftTierFor(1000, tiers)).toBe(2)
  })
})

describe('updateDrift — latching', () => {
  it('latches right and starts the charge on the same tick', () => {
    const ctx = makeContext(makeStraightTrack())
    const k = makeKart({ velocity: { x: 12, y: 0, z: 0 } })   // xz speed 12 > driftMinSpeed 8

    updateDrift(ctx, k, makeIntent({ drift: true, steer: 1 }))

    expect(k.drift.active).toBe(true)
    expect(k.drift.dir).toBe(1)
    expect(k.drift.charge).toBe(1)   // the latching tick itself counts
  })

  it('latches left on negative steer', () => {
    const ctx = makeContext(makeStraightTrack())
    const k = makeKart({ velocity: { x: 12, y: 0, z: 0 } })

    updateDrift(ctx, k, makeIntent({ drift: true, steer: -0.9 }))

    expect(k.drift.active).toBe(true)
    expect(k.drift.dir).toBe(-1)
    expect(k.drift.charge).toBe(1)
  })

  it('will not latch below the steer threshold and will at it', () => {
    expect(DRIFT_STEER_MIN).toBe(0.35)
    const ctx = makeContext(makeStraightTrack())

    const tooStraight = makeKart({ velocity: { x: 12, y: 0, z: 0 } })
    updateDrift(ctx, tooStraight, makeIntent({ drift: true, steer: 0.34 }))
    expect(tooStraight.drift.active).toBe(false)
    expect(tooStraight.drift.dir).toBe(0)
    expect(tooStraight.drift.charge).toBe(0)

    const atThreshold = makeKart({ velocity: { x: 12, y: 0, z: 0 } })
    updateDrift(ctx, atThreshold, makeIntent({ drift: true, steer: 0.35 }))
    expect(atThreshold.drift.active).toBe(true)
    expect(atThreshold.drift.charge).toBe(1)
  })

  it('will not latch at or below driftMinSpeed and will above it', () => {
    const ctx = makeContext(makeStraightTrack())

    const exactlyMin = makeKart({ velocity: { x: 8, y: 0, z: 0 } })   // speed 8 === driftMinSpeed
    updateDrift(ctx, exactlyMin, makeIntent({ drift: true, steer: 1 }))
    expect(exactlyMin.drift.active).toBe(false)
    expect(exactlyMin.drift.charge).toBe(0)

    const aboveMin = makeKart({ velocity: { x: 8.5, y: 0, z: 0 } })
    updateDrift(ctx, aboveMin, makeIntent({ drift: true, steer: 1 }))
    expect(aboveMin.drift.active).toBe(true)
    expect(aboveMin.drift.charge).toBe(1)
  })

  it('measures drift speed on the xz plane only', () => {
    const ctx = makeContext(makeStraightTrack())

    const diagonal = makeKart({ velocity: { x: 6, y: 99, z: 8 } })    // sqrt(36+64) = 10 > 8
    updateDrift(ctx, diagonal, makeIntent({ drift: true, steer: 1 }))
    expect(diagonal.drift.active).toBe(true)

    const fallingOnly = makeKart({ velocity: { x: 0, y: 99, z: 0 } }) // xz speed 0
    updateDrift(ctx, fallingOnly, makeIntent({ drift: true, steer: 1 }))
    expect(fallingOnly.drift.active).toBe(false)
  })

  it('does nothing when the drift button is not held and none is active', () => {
    const ctx = makeContext(makeStraightTrack())
    const k = makeKart({ velocity: { x: 30, y: 0, z: 0 }, boostTicks: 0 })

    updateDrift(ctx, k, makeIntent({ drift: false, steer: 1 }))

    expect(k.drift.active).toBe(false)
    expect(k.drift.dir).toBe(0)
    expect(k.drift.charge).toBe(0)
    expect(k.boostTicks).toBe(0)
  })
})

describe('updateDrift — charging', () => {
  it('accrues exactly one charge per held tick', () => {
    const ctx = makeContext(makeStraightTrack())
    const k = makeKart({ velocity: { x: 20, y: 0, z: 0 } })
    const held = makeIntent({ drift: true, steer: 1 })

    for (let i = 0; i < 40; i++) updateDrift(ctx, k, held)

    expect(k.drift.charge).toBe(40)   // 40 calls, +1 each, latch tick included
    expect(k.drift.active).toBe(true)
    expect(k.drift.dir).toBe(1)
  })

  it('keeps the latched direction when the player counter-steers', () => {
    const ctx = makeContext(makeStraightTrack())
    const k = makeKart({ velocity: { x: 20, y: 0, z: 0 } })

    updateDrift(ctx, k, makeIntent({ drift: true, steer: 1 }))
    for (let i = 0; i < 5; i++) updateDrift(ctx, k, makeIntent({ drift: true, steer: -1 }))

    expect(k.drift.dir).toBe(1)       // latched right on tick 1 and stayed right
    expect(k.drift.charge).toBe(6)    // 1 + 5
    expect(k.drift.active).toBe(true)
  })

  it('keeps charging with the stick centred once latched', () => {
    const ctx = makeContext(makeStraightTrack())
    const k = makeKart({ velocity: { x: 20, y: 0, z: 0 } })

    updateDrift(ctx, k, makeIntent({ drift: true, steer: 1 }))
    for (let i = 0; i < 9; i++) updateDrift(ctx, k, makeIntent({ drift: true, steer: 0 }))

    expect(k.drift.charge).toBe(10)
    expect(k.drift.active).toBe(true)
  })

  it('caps charge at the top tier so the 8-bit wire field cannot overflow', () => {
    const ctx = makeContext(makeStraightTrack())
    const k = makeKart({ velocity: { x: 20, y: 0, z: 0 } })
    const held = makeIntent({ drift: true, steer: 1 })

    for (let i = 0; i < 200; i++) updateDrift(ctx, k, held)

    expect(k.drift.charge).toBe(150)  // driftTiers[2]
  })

  it('keeps the drift alive while the kart is airborne', () => {
    const ctx = makeContext(makeStraightTrack())
    const k = makeKart({ velocity: { x: 20, y: 0, z: 0 }, airborne: true })
    const held = makeIntent({ drift: true, steer: 1 })

    for (let i = 0; i < 10; i++) updateDrift(ctx, k, held)

    expect(k.drift.active).toBe(true)
    expect(k.drift.charge).toBe(10)
  })

  it('cancels with no boost when speed falls to driftMinSpeed while still held', () => {
    const ctx = makeContext(makeStraightTrack())
    const k = makeKart({ velocity: { x: 20, y: 0, z: 0 } })
    const held = makeIntent({ drift: true, steer: 1 })

    for (let i = 0; i < 50; i++) updateDrift(ctx, k, held)
    expect(k.drift.charge).toBe(50)   // past driftTiers[0] = 40, so a tier was reached

    k.velocity.x = 8                  // dropped to driftMinSpeed
    updateDrift(ctx, k, held)

    expect(k.drift.active).toBe(false)
    expect(k.drift.dir).toBe(0)
    expect(k.drift.charge).toBe(0)
    expect(k.boostTicks).toBe(0)      // charge is forfeited, not paid out
  })

  it('cancels with no boost during a spin-out or a respawn', () => {
    const ctx = makeContext(makeStraightTrack())
    const held = makeIntent({ drift: true, steer: 1 })

    const spun = makeKart({
      velocity: { x: 20, y: 0, z: 0 },
      drift: { active: true, dir: 1, charge: 100 },
      spinOutTicks: 30,
    })
    updateDrift(ctx, spun, held)
    expect(spun.drift.active).toBe(false)
    expect(spun.drift.charge).toBe(0)
    expect(spun.boostTicks).toBe(0)

    const respawning = makeKart({
      velocity: { x: 20, y: 0, z: 0 },
      drift: { active: true, dir: -1, charge: 100 },
      respawnTicks: 40,
    })
    updateDrift(ctx, respawning, held)
    expect(respawning.drift.active).toBe(false)
    expect(respawning.drift.charge).toBe(0)
    expect(respawning.boostTicks).toBe(0)
  })
})

describe('updateDrift — release', () => {
  it('pays nothing for a charge below the first tier', () => {
    const ctx = makeContext(makeStraightTrack())
    const k = makeKart({
      velocity: { x: 20, y: 0, z: 0 },
      drift: { active: true, dir: 1, charge: 39 },   // driftTiers[0] is 40
    })

    updateDrift(ctx, k, makeIntent({ drift: false, steer: 1 }))

    expect(k.boostTicks).toBe(0)
    expect(k.drift.active).toBe(false)
    expect(k.drift.dir).toBe(0)
    expect(k.drift.charge).toBe(0)
  })

  it('pays each tier the matching driftBoosts entry', () => {
    const ctx = makeContext(makeStraightTrack())
    const release = makeIntent({ drift: false, steer: 1 })
    const cases: Array<[number, number]> = [
      [40, 24],   // driftTiers[0] -> driftBoosts[0]
      [89, 24],
      [90, 42],   // driftTiers[1] -> driftBoosts[1]
      [149, 42],
      [150, 66],  // driftTiers[2] -> driftBoosts[2]
    ]

    for (const [charge, expected] of cases) {
      const k = makeKart({
        velocity: { x: 20, y: 0, z: 0 },
        drift: { active: true, dir: 1, charge },
      })
      updateDrift(ctx, k, release)
      expect(k.boostTicks).toBe(expected)
      expect(k.drift.active).toBe(false)
      expect(k.drift.charge).toBe(0)
    }
  })

  it('charges for 90 ticks and releases a second-tier boost end to end', () => {
    const ctx = makeContext(makeStraightTrack())
    const k = makeKart({ velocity: { x: 20, y: 0, z: 0 } })
    const held = makeIntent({ drift: true, steer: 1 })

    for (let i = 0; i < 90; i++) updateDrift(ctx, k, held)
    expect(k.drift.charge).toBe(90)

    updateDrift(ctx, k, makeIntent({ drift: false, steer: 1 }))

    // charge 90 >= driftTiers[1] (90) and < driftTiers[2] (150) -> driftBoosts[1] = 42
    expect(k.boostTicks).toBe(42)
    expect(k.drift.active).toBe(false)
  })

  it('extends a shorter running boost but never truncates a longer one', () => {
    const ctx = makeContext(makeStraightTrack())
    const release = makeIntent({ drift: false, steer: 1 })

    const longerAlreadyRunning = makeKart({
      velocity: { x: 20, y: 0, z: 0 },
      drift: { active: true, dir: 1, charge: 40 },   // would grant 24
      boostTicks: 50,                                // e.g. part of a tier-3 boost
    })
    updateDrift(ctx, longerAlreadyRunning, release)
    expect(longerAlreadyRunning.boostTicks).toBe(50)

    const shorterAlreadyRunning = makeKart({
      velocity: { x: 20, y: 0, z: 0 },
      drift: { active: true, dir: 1, charge: 150 },  // grants 66
      boostTicks: 10,
    })
    updateDrift(ctx, shorterAlreadyRunning, release)
    expect(shorterAlreadyRunning.boostTicks).toBe(66)
  })

  it('pays nothing when the button is released with no drift active', () => {
    const ctx = makeContext(makeStraightTrack())
    const k = makeKart({
      velocity: { x: 20, y: 0, z: 0 },
      drift: { active: false, dir: 0, charge: 140 },  // stale charge, no active drift
    })

    updateDrift(ctx, k, makeIntent({ drift: false, steer: 1 }))

    expect(k.boostTicks).toBe(0)
    expect(k.drift.charge).toBe(0)
  })
})

describe('decayBoost', () => {
  it('spends one boost tick per call', () => {
    const k = makeKart({ boostTicks: 5 })
    decayBoost(k)
    expect(k.boostTicks).toBe(4)
  })

  it('stops at zero and never goes negative', () => {
    const k = makeKart({ boostTicks: 1 })
    decayBoost(k)
    expect(k.boostTicks).toBe(0)
    decayBoost(k)
    expect(k.boostTicks).toBe(0)
    decayBoost(k)
    expect(k.boostTicks).toBe(0)
  })

  it('spends a first-tier boost in exactly 24 ticks', () => {
    const k = makeKart({ boostTicks: 24 })   // driftBoosts[0]

    for (let i = 0; i < 23; i++) decayBoost(k)
    expect(k.boostTicks).toBe(1)

    decayBoost(k)
    expect(k.boostTicks).toBe(0)
  })

  it('touches nothing but boostTicks', () => {
    // respawnTicks is 0 here, unlike the other timers: a non-zero one would make
    // the kart motionLocked and decayBoost would return before touching anything,
    // which would make this test vacuous. The lock itself is covered below.
    // spinOutTicks stays non-zero on purpose — see the next case.
    const k = makeKart({
      boostTicks: 5,
      spinOutTicks: 7,
      invulnTicks: 9,
      respawnTicks: 0,
      drift: { active: true, dir: 1, charge: 30 },
    })

    decayBoost(k)

    expect(k.boostTicks).toBe(4)
    expect(k.spinOutTicks).toBe(7)   // updateRecovery owns these, not this function
    expect(k.invulnTicks).toBe(9)
    expect(k.respawnTicks).toBe(0)
    expect(k.drift.charge).toBe(30)
  })

  it('keeps spending during a spin-out, which is steeringLocked but not motionLocked', () => {
    // motionLocked is respawnTicks > 0 alone (recovery.ts). A spinning kart still
    // slides, so nothing about it is handed to updateRecovery except its steering,
    // and its boost timer keeps running down.
    const k = makeKart({ boostTicks: 5, spinOutTicks: 7 })
    decayBoost(k)
    expect(k.boostTicks).toBe(4)
  })

  it('spends nothing while the kart is motion-locked', () => {
    // The motion-lock rule (step.ts): while motionLocked(k), updateRecovery is the
    // sole writer of boostTicks, and decayBoost is at slot 8 — a later slot than 2.
    // stepRespawn holds boostTicks at 0 for the whole respawn, so in step() this
    // guard is belt-and-braces; stated here so decayBoost is correct on its own.
    const k = makeKart({ boostTicks: 5, respawnTicks: 11 })

    decayBoost(k)
    decayBoost(k)
    decayBoost(k)

    expect(k.boostTicks).toBe(5)
    expect(k.respawnTicks).toBe(11)
  })

  it('leaves 23 ticks on the tick a first-tier boost is released', () => {
    // Canonical per-kart order: updateDrift is slot 3, decayBoost is slot 8, so the
    // tick a boost is granted also spends one tick of it.
    const ctx = makeContext(makeStraightTrack())
    const k = makeKart({
      velocity: { x: 20, y: 0, z: 0 },
      drift: { active: true, dir: 1, charge: 40 },
    })

    updateDrift(ctx, k, makeIntent({ drift: false, steer: 1 }))
    decayBoost(k)

    expect(k.boostTicks).toBe(23)   // 24 granted, 1 spent on the release tick
  })
})

describe('lateralGripFor', () => {
  it('returns gripDrift while drifting and the surface grip otherwise', () => {
    const ctx = makeContext(makeStraightTrack())

    expect(lateralGripFor(ctx, makeKart({ surface: 'tarmac' }))).toBe(14)
    expect(lateralGripFor(ctx, makeKart({ surface: 'dirt' }))).toBe(5)
    expect(lateralGripFor(ctx, makeKart({ surface: 'boost' }))).toBe(14)
    expect(lateralGripFor(ctx, makeKart({ surface: 'offtrack' }))).toBe(14)
  })

  it('lets the drift flag override every surface', () => {
    const ctx = makeContext(makeStraightTrack())
    const drifting = { active: true, dir: 1 as const, charge: 30 }

    expect(lateralGripFor(ctx, makeKart({ surface: 'tarmac', drift: drifting }))).toBe(3)
    expect(lateralGripFor(ctx, makeKart({ surface: 'dirt', drift: drifting }))).toBe(3)
  })

  it('makes a drifting kart hold more lateral velocity through stepKart', () => {
    // Every number here, recomputed from the base tuning:
    //   heading 0 -> forward = (1, 0, 0), right = (0, 0, 1), so velocity.z IS vr.
    //   vf = 20, vr = 6, character 0 (speed 1.00, accel 1.00), boostTicks 0.
    //   target  = maxSpeed 40 * 1.00 * accel 1 * 1 * 1 * 1 = 40
    //   maxDelta = accelRate 24 * 1.00 / 60 = 0.4, so newVf = 20 + 0.4 = 20.4 for both
    //   gripping: gripTarmac 14 -> 6 * (1 - 14/60) = 6 * 0.7666666666666666 = 4.6
    //   drifting: gripDrift  3 -> 6 * (1 -  3/60) = 6 * 0.95                = 5.7
    const ctx = makeContext(makeStraightTrack())
    const state = createState(ctx, 1, [0, 0, 0, 0, 0, 0, 0, 0])
    const raw = makeIntent({ accel: 1, steer: 0 })

    const gripping = state.karts[0]
    gripping.position.x = 20
    gripping.position.y = 0
    gripping.position.z = 0
    gripping.velocity.x = 20
    gripping.velocity.y = 0
    gripping.velocity.z = 6
    gripping.heading = 0
    gripping.surface = 'tarmac'
    gripping.drift.active = false
    gripping.drift.dir = 0
    gripping.drift.charge = 0
    gripping.boostTicks = 0
    const grippingPrev = makeKart({
      position: { x: 20, y: 0, z: 0 },
      velocity: { x: 20, y: 0, z: 6 },
    })
    stepKart(ctx, state, grippingPrev, gripping, raw)

    const drifting = state.karts[1]
    drifting.position.x = 20
    drifting.position.y = 0
    drifting.position.z = 0
    drifting.velocity.x = 20
    drifting.velocity.y = 0
    drifting.velocity.z = 6
    drifting.heading = 0
    drifting.surface = 'tarmac'
    drifting.drift.active = true
    drifting.drift.dir = 1
    drifting.drift.charge = 20
    drifting.boostTicks = 0
    const driftingPrev = makeKart({
      playerId: 1,
      position: { x: 20, y: 0, z: 0 },
      velocity: { x: 20, y: 0, z: 6 },
      drift: { active: true, dir: 1, charge: 19 },
    })
    stepKart(ctx, state, driftingPrev, drifting, raw)

    // gripTarmac 14 damps the 6 u/s slide hard; gripDrift 3 barely touches it.
    expect(gripping.velocity.z).toBeCloseTo(4.6, 12)
    expect(drifting.velocity.z).toBeCloseTo(5.7, 12)
    expect(Math.abs(drifting.velocity.z)).toBeGreaterThan(Math.abs(gripping.velocity.z))
    // the longitudinal half is identical for both, so only grip is under test here
    expect(gripping.velocity.x).toBeCloseTo(20.4, 12)
    expect(drifting.velocity.x).toBeCloseTo(20.4, 12)
  })

  it('damps lateral velocity by exactly lateralGripFor on every surface', () => {
    // This is the test that keeps stepKart and lateralGripFor from drifting apart:
    // the expectation is computed FROM lateralGripFor, not from a literal, so a
    // second private copy of the grip rule inside kart.ts cannot stay hidden.
    // Concretely: tarmac / boost / offtrack -> gripTarmac 14 -> 6 * (1 - 14/60) = 4.6
    //             dirt                      -> gripDirt    5 -> 6 * (1 -  5/60) = 5.5
    const ctx = makeContext(makeStraightTrack())
    const state = createState(ctx, 3, [0, 0, 0, 0, 0, 0, 0, 0])
    const raw = makeIntent({ accel: 1, steer: 0 })
    const surfaces: Surface[] = ['tarmac', 'dirt', 'boost', 'offtrack']

    for (const surface of surfaces) {
      const k = state.karts[0]
      k.position.x = 20
      k.position.y = 0
      k.position.z = 0
      k.velocity.x = 20
      k.velocity.y = 0
      k.velocity.z = 6
      k.heading = 0          // forward = (1, 0, 0), right = (0, 0, 1)
      k.angularVelocity = 0
      k.surface = surface
      k.drift.active = false
      k.drift.dir = 0
      k.drift.charge = 0
      k.boostTicks = 0

      // read before stepKart runs, so the coefficient is the one the tick will use
      const expected = 6 * (1 - lateralGripFor(ctx, k) * TICK_DT)

      const prevKart = makeKart({ velocity: { x: 20, y: 0, z: 6 } })
      stepKart(ctx, state, prevKart, k, raw)

      expect(k.velocity.z).toBeCloseTo(expected, 12)
    }
  })
})
