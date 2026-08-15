import { describe, it, expect } from 'vitest'
import type { Intent } from '@tapkart/sim'
import { DRIFT_STEER_MIN } from '@tapkart/sim'
import type { ControlConfig } from '../src/controls/config'
import { BRAKE_HOLD_TICKS, DEFAULT_CONTROL_CONFIG } from '../src/controls/config'
import type { ControlInputs, PointerPhase } from '../src/controls/types'
import { IDENTITY_TILT_CALIBRATION, calibrateTilt, makeTiltAdapter } from '../src/controls/tilt'
import { makeControlInputsFixture } from './fixtures/game-fixtures'

function poisonedIntent(): Intent {
  return { tick: -999, steer: 999, accel: -999, brake: true, drift: true, useItem: true }
}

function point(raw: ControlInputs, id: number, x: number, y: number, phase: PointerPhase): void {
  const p = raw.pointers[raw.pointerCount]
  p.id = id
  p.x = x
  p.y = y
  p.phase = phase
  raw.pointerCount++
}

function step(a: ReturnType<typeof makeTiltAdapter>, raw: ControlInputs, tick: number, out: Intent): void {
  a.sample(raw, tick, out)
  raw.pointerCount = 0
}

function withCfg(overrides: Partial<ControlConfig>): ControlConfig {
  return { ...DEFAULT_CONTROL_CONFIG, ...overrides }
}

/** Settles the smoother: 24 ticks of the same tilt reaches the target to 1e-4. */
function settle(a: ReturnType<typeof makeTiltAdapter>, raw: ControlInputs, out: Intent): void {
  for (let t = 0; t < 24; t++) step(a, raw, t, out)
}

describe('tilt calibration', () => {
  it('IDENTITY_TILT_CALIBRATION is zero on both axes and equals the shipped default config', () => {
    // CATCHES the one hazard of config.ts holding its own copy of this literal
    // (it must, to avoid a runtime import cycle): the two drifting apart.
    expect(IDENTITY_TILT_CALIBRATION).toEqual({ betaZero: 0, gammaZero: 0 })
    expect(DEFAULT_CONTROL_CONFIG.tiltCalibration).toEqual(IDENTITY_TILT_CALIBRATION)
  })

  it('calibrateTilt records the held sample as the new zero', () => {
    // CATCHES swapping beta and gamma, which points steering at the pitch axis and
    // makes the game unplayable in exactly the way nobody debugs quickly.
    expect(calibrateTilt({ alpha: 33, beta: 12, gamma: -7 })).toEqual({ betaZero: 12, gammaZero: -7 })
  })
})

describe('tilt steering', () => {
  it('maps gamma to a full-lock axis over tiltRangeDegrees', () => {
    // CATCHES a wrong range constant or a degrees/radians mix-up: at gamma = 25
    // with tiltRangeDegrees 25 the axis is exactly 1, and the smoother converges
    // to it. First tick is the exact lerp value, 0.35.
    const a = makeTiltAdapter(DEFAULT_CONTROL_CONFIG)
    const raw = makeControlInputsFixture({ tilt: { alpha: 0, beta: 0, gamma: 25 } })
    const out = poisonedIntent()
    step(a, raw, 0, out)
    expect(out.steer).toBeCloseTo(0.35, 9)
    settle(a, raw, out)
    expect(out.steer).toBeGreaterThan(0.999)
  })

  it('is proportional in between and clamps beyond full lock', () => {
    const half = makeTiltAdapter(DEFAULT_CONTROL_CONFIG)
    const rawHalf = makeControlInputsFixture({ tilt: { alpha: 0, beta: 0, gamma: -12.5 } })
    const outHalf = poisonedIntent()
    settle(half, rawHalf, outHalf)
    expect(outHalf.steer).toBeCloseTo(-0.5, 3)

    const past = makeTiltAdapter(DEFAULT_CONTROL_CONFIG)
    const rawPast = makeControlInputsFixture({ tilt: { alpha: 0, beta: 0, gamma: 400 } })
    const outPast = poisonedIntent()
    settle(past, rawPast, outPast)
    expect(outPast.steer).toBeLessThanOrEqual(1)
    expect(outPast.steer).toBeGreaterThan(0.999)
  })

  it('measures gamma from the calibration zero, not from zero degrees', () => {
    // CATCHES ignoring the calibration. A player who calibrated at gamma = -8 is
    // holding the phone level; without the offset the kart steers permanently left
    // and the calibration flow is decoration.
    const cfg = withCfg({ tiltCalibration: calibrateTilt({ alpha: 0, beta: 10, gamma: -8 }) })
    const a = makeTiltAdapter(cfg)
    const raw = makeControlInputsFixture({ tilt: { alpha: 0, beta: 10, gamma: -8 } })
    const out = poisonedIntent()
    settle(a, raw, out)
    expect(out.steer).toBe(0)

    const b = makeTiltAdapter(cfg)
    const rawB = makeControlInputsFixture({ tilt: { alpha: 0, beta: 10, gamma: 17 } })
    const outB = poisonedIntent()
    settle(b, rawB, outB)
    expect(outB.steer).toBeGreaterThan(0.999)
  })

  it('inverts the axis when invertTilt is set', () => {
    // CATCHES an inversion applied to the wrong side of the clamp or dropped
    // entirely - and it uses a NON-symmetric value so a sign bug cannot pass.
    const a = makeTiltAdapter(withCfg({ invertTilt: true }))
    const raw = makeControlInputsFixture({ tilt: { alpha: 0, beta: 0, gamma: 12.5 } })
    const out = poisonedIntent()
    settle(a, raw, out)
    expect(out.steer).toBeCloseTo(-0.5, 3)
  })

  it('applies the dead zone around the calibrated neutral', () => {
    // 1 degree / 25 = 0.04 (dead); 2 degrees / 25 = 0.08 (live, 0.35 of it = 0.028).
    const dead = makeTiltAdapter(DEFAULT_CONTROL_CONFIG)
    const rawDead = makeControlInputsFixture({ tilt: { alpha: 0, beta: 0, gamma: 1 } })
    const outDead = poisonedIntent()
    settle(dead, rawDead, outDead)
    expect(outDead.steer).toBe(0)

    const live = makeTiltAdapter(DEFAULT_CONTROL_CONFIG)
    const rawLive = makeControlInputsFixture({ tilt: { alpha: 0, beta: 0, gamma: 2 } })
    const outLive = poisonedIntent()
    step(live, rawLive, 0, outLive)
    expect(outLive.steer).toBeCloseTo(0.028, 9)
  })

  it('steers straight when tilt is unavailable, and writes every field of out', () => {
    // CATCHES a null dereference on the permission-denied path (Q22 leaves
    // `tilt: null` for a whole session) and a partial write of `out`.
    const a = makeTiltAdapter(DEFAULT_CONTROL_CONFIG)
    const raw = makeControlInputsFixture({ tilt: null })
    const out = poisonedIntent()
    step(a, raw, 7, out)
    expect(out).toEqual({ tick: 7, steer: 0, accel: 1, brake: false, drift: false, useItem: false })
  })

  it('decays to centre when tilt data stops arriving', () => {
    const a = makeTiltAdapter(DEFAULT_CONTROL_CONFIG)
    const raw = makeControlInputsFixture({ tilt: { alpha: 0, beta: 0, gamma: 25 } })
    const out = poisonedIntent()
    settle(a, raw, out)
    raw.tilt = null
    for (let t = 24; t < 60; t++) step(a, raw, t, out)
    expect(out.steer).toBeCloseTo(0, 6)
  })

  it('does not steer from touches: the left half is not a thumb zone here', () => {
    // CATCHES copy-paste of thumbZones' steering into the tilt adapter, which
    // would give the player two steering inputs fighting each other.
    const a = makeTiltAdapter(DEFAULT_CONTROL_CONFIG)
    const raw = makeControlInputsFixture({ tilt: null })
    const out = poisonedIntent()
    point(raw, 1, 100, 200, 'down')
    step(a, raw, 0, out)
    point(raw, 1, 380, 200, 'move')
    for (let t = 1; t <= 20; t++) step(a, raw, t, out)
    expect(out.steer).toBe(0)
  })
})

describe('tilt buttons (shared layout with thumbZones)', () => {
  it('uses the same drift and item rects and the same dead gap', () => {
    const a = makeTiltAdapter(DEFAULT_CONTROL_CONFIG)
    const raw = makeControlInputsFixture({ tilt: null })
    const out = poisonedIntent()
    point(raw, 2, 740, 340, 'down')
    step(a, raw, 0, out)
    expect(out.drift).toBe(true)
    point(raw, 2, 740, 340, 'up')
    point(raw, 3, 740, 240, 'down')
    step(a, raw, 1, out)
    expect(out.drift).toBe(false)
    expect(out.useItem).toBe(true)
    step(a, raw, 2, out)
    expect(out.useItem).toBe(false)

    point(raw, 3, 740, 240, 'up')
    point(raw, 4, 740, 288, 'down')
    step(a, raw, 3, out)
    expect(out.drift).toBe(false)
    expect(out.useItem).toBe(false)
  })

  it('brakes on a long drift press only while the phone is held level (Q21)', () => {
    // Same qualifier as thumbZones, driven by the gyro instead of a thumb: held
    // level the hold brakes, tilted to full lock it does not.
    const level = makeTiltAdapter(DEFAULT_CONTROL_CONFIG)
    const rawLevel = makeControlInputsFixture({ tilt: { alpha: 0, beta: 0, gamma: 0 } })
    const outLevel = poisonedIntent()
    point(rawLevel, 5, 740, 340, 'down')
    for (let t = 0; t < BRAKE_HOLD_TICKS - 1; t++) {
      step(level, rawLevel, t, outLevel)
      expect(outLevel.brake).toBe(false)
    }
    step(level, rawLevel, BRAKE_HOLD_TICKS - 1, outLevel)
    expect(outLevel.brake).toBe(true)
    expect(outLevel.drift).toBe(true)

    const turning = makeTiltAdapter(DEFAULT_CONTROL_CONFIG)
    const rawTurning = makeControlInputsFixture({ tilt: { alpha: 0, beta: 0, gamma: 25 } })
    const outTurning = poisonedIntent()
    point(rawTurning, 6, 740, 340, 'down')
    for (let t = 0; t < 40; t++) {
      step(turning, rawTurning, t, outTurning)
      expect(outTurning.brake).toBe(false)
    }
    expect(outTurning.steer).toBeGreaterThan(DRIFT_STEER_MIN)
    expect(outTurning.drift).toBe(true)
  })
})

describe('tilt reset and identity', () => {
  it('reports its scheme and drops every latch on reset', () => {
    const a = makeTiltAdapter(DEFAULT_CONTROL_CONFIG)
    expect(a.scheme).toBe('tilt')
    const raw = makeControlInputsFixture({ tilt: { alpha: 0, beta: 0, gamma: 25 } })
    const out = poisonedIntent()
    point(raw, 7, 740, 340, 'down')
    point(raw, 8, 740, 240, 'down')
    for (let t = 0; t < 24; t++) step(a, raw, t, out)
    expect(out.steer).toBeGreaterThan(0.99)
    expect(out.drift).toBe(true)

    a.reset()
    raw.tilt = null
    step(a, raw, 24, out)
    expect(out).toEqual({ tick: 24, steer: 0, accel: 1, brake: false, drift: false, useItem: false })
    point(raw, 9, 740, 240, 'down')
    step(a, raw, 25, out)
    expect(out.useItem).toBe(true)
  })
})
