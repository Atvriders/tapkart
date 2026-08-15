import { describe, expect, it } from 'vitest'

import { TICK_DT, wrapAngle } from '@tapkart/sim'
import type { Vec3 } from '@tapkart/sim'
import { TUNING } from '@tapkart/content'

import {
  ERROR_SMOOTH_MAX_HEADING_RAD,
  ERROR_SMOOTH_MAX_POSITION_M,
  ERROR_SMOOTH_WINDOW_TICKS,
  advanceVisualOffset,
  createVisualOffset,
  easeRemaining,
} from '../src/smoothing'
import type { VisualOffset } from '../src/smoothing'
// The barrel, to prove §4.11's new `export * from './smoothing'` line is actually there.
import * as barrel from '../src/index'
import type { VisualOffset as BarrelVisualOffset } from '../src/index'

const ZERO: Vec3 = { x: 0, y: 0, z: 0 }

function v(x: number, y: number, z: number): Vec3 {
  return { x, y, z }
}

/** One correction of (pos, heading) arriving on this tick. */
function correct(o: VisualOffset, pos: Vec3, heading: number): void {
  advanceVisualOffset(o, pos, heading, 1, o)
}

/** `ticks` sim ticks with no reconciliation. */
function idle(o: VisualOffset, ticks: number): void {
  advanceVisualOffset(o, ZERO, null, ticks, o)
}

function snapshot(o: VisualOffset): VisualOffset {
  return {
    origin: { x: o.origin.x, y: o.origin.y, z: o.origin.z },
    originHeading: o.originHeading,
    ticksSince: o.ticksSince,
    current: { x: o.current.x, y: o.current.y, z: o.current.z },
    currentHeading: o.currentHeading,
  }
}

function isAllZero(o: VisualOffset): boolean {
  return o.origin.x === 0 && o.origin.y === 0 && o.origin.z === 0
    && o.originHeading === 0 && o.ticksSince === 0
    && o.current.x === 0 && o.current.y === 0 && o.current.z === 0
    && o.currentHeading === 0
}

describe('createVisualOffset', () => {
  it('starts at zero with distinct Vec3s', () => {
    const o = createVisualOffset()
    expect(isAllZero(o)).toBe(true)
    // Two fields sharing one Vec3 would make `current` track `origin` forever.
    expect(o.origin).not.toBe(o.current)
    const a = createVisualOffset()
    const b = createVisualOffset()
    expect(a.origin).not.toBe(b.origin)
  })
})

describe('easeRemaining', () => {
  it('is 1 at the start of the window and exactly 0 at its end', () => {
    expect(easeRemaining(0)).toBe(1)
    expect(easeRemaining(1)).toBe(0)
  })

  it('is the ease-out cubic, not a linear or quadratic falloff', () => {
    expect(easeRemaining(0.5)).toBe(0.125)          // linear: 0.5, quadratic: 0.25
    expect(easeRemaining(0.25)).toBe(0.421875)      // (1 - 0.25) ** 3
    expect(easeRemaining(0.75)).toBe(0.015625)
  })

  it('clamps outside [0, 1] instead of growing or going negative', () => {
    expect(easeRemaining(-5)).toBe(1)
    expect(easeRemaining(-0.0001)).toBe(1)
    expect(easeRemaining(3)).toBe(0)
    expect(easeRemaining(1e9)).toBe(0)
  })

  it('settles rather than arriving: its slope at the end of the window is zero', () => {
    const h = 1e-4
    const slope = (easeRemaining(1) - easeRemaining(1 - h)) / h
    expect(Math.abs(slope)).toBeLessThan(1e-6)      // cubic: ~1e-8, quadratic: ~1e-4
  })
})

describe('advanceVisualOffset — the correction tick', () => {
  it('applies the whole correction on the tick it arrives, in both channels', () => {
    const o = createVisualOffset()
    correct(o, v(0.05, 0, -0.02), 0.05)

    expect(o.ticksSince).toBe(0)
    expect(o.origin).toEqual({ x: 0.05, y: 0, z: -0.02 })
    expect(o.originHeading).toBe(0.05)
    // f = easeRemaining(0) = 1, so the drawn pose is exactly where it was before
    // the reconciliation moved it: the correction is invisible on its own tick.
    expect(o.current).toEqual({ x: 0.05, y: 0, z: -0.02 })
    expect(o.currentHeading).toBe(0.05)
  })

  it('adds a new correction to the error still on screen, not to the original one', () => {
    const o = createVisualOffset()
    correct(o, v(0.05, 0, 0), 0.05)
    idle(o, 6)
    expect(o.current.x).toBeCloseTo(0.00625, 12)    // 0.05 * easeRemaining(0.5)
    expect(o.currentHeading).toBeCloseTo(0.00625, 12)

    correct(o, v(0.02, 0, 0), 0.02)
    expect(o.origin.x).toBeCloseTo(0.02625, 12)     // prev.current + delta
    expect(o.originHeading).toBeCloseTo(0.02625, 12)
    expect(o.ticksSince).toBe(0)
  })

  it('wraps the re-seeded heading origin to the shortest arc', () => {
    const o = createVisualOffset()
    o.currentHeading = 6.2                          // synthetic prior, to reach the wrap
    correct(o, ZERO, 0.05)
    expect(o.originHeading).toBeCloseTo(wrapAngle(6.25), 12)
    expect(o.originHeading).toBeCloseTo(-0.0331853071795862, 12)
    expect(isAllZero(o)).toBe(false)
  })
})

describe('advanceVisualOffset — the ease', () => {
  it('reaches exactly zero after ERROR_SMOOTH_WINDOW_TICKS and stays there', () => {
    const o = createVisualOffset()
    correct(o, v(0.05, 0, 0.05), 0.05)
    idle(o, ERROR_SMOOTH_WINDOW_TICKS)

    expect(o.current.x).toBe(0)
    expect(o.current.z).toBe(0)
    expect(o.currentHeading).toBe(0)

    idle(o, 5)
    expect(o.current.x).toBe(0)
    expect(o.currentHeading).toBe(0)
  })

  it('decreases monotonically in both channels across the window', () => {
    const o = createVisualOffset()
    correct(o, v(0.05, 0, 0), 0.05)
    let lastPos = Math.abs(o.current.x)
    let lastHeading = Math.abs(o.currentHeading)
    for (let i = 0; i < ERROR_SMOOTH_WINDOW_TICKS; i++) {
      idle(o, 1)
      expect(Math.abs(o.current.x)).toBeLessThan(lastPos)
      expect(Math.abs(o.currentHeading)).toBeLessThan(lastHeading)
      lastPos = Math.abs(o.current.x)
      lastHeading = Math.abs(o.currentHeading)
    }
    expect(lastPos).toBe(0)
    expect(lastHeading).toBe(0)
  })

  it('drives both channels with ONE eased fraction, tick by tick', () => {
    const o = createVisualOffset()
    correct(o, v(0.4, 0, -0.3), 0.06)
    for (let i = 0; i < ERROR_SMOOTH_WINDOW_TICKS; i++) {
      idle(o, 1)
      const f = easeRemaining(o.ticksSince / ERROR_SMOOTH_WINDOW_TICKS)
      expect(o.current.x).toBe(o.origin.x * f)
      expect(o.current.z).toBe(o.origin.z * f)
      expect(o.currentHeading).toBe(o.originHeading * f)
    }
  })

  it('is frame-rate independent: N calls of one tick equal one call of N ticks', () => {
    const a = createVisualOffset()
    const b = createVisualOffset()
    correct(a, v(0.4, 0, -0.2), 0.06)
    correct(b, v(0.4, 0, -0.2), 0.06)
    for (let i = 0; i < 5; i++) idle(a, 1)
    idle(b, 5)
    expect(a).toEqual(b)
    expect(a.ticksSince).toBe(5)
  })

  it('changes nothing when ticksElapsed is 0', () => {
    const o = createVisualOffset()
    correct(o, v(0.05, 0, 0), 0.05)
    idle(o, 3)
    const before = snapshot(o)
    idle(o, 0)
    expect(o).toEqual(before)
  })

  it('writes a correct result when `out` aliases `prev`', () => {
    // ViewBuilder calls this as advanceVisualOffset(offset, ..., offset) on its
    // one pre-allocated offset, so aliasing is the shipped call shape.
    const steps: { pos: Vec3; heading: number | null; ticks: number }[] = [
      { pos: v(0.05, 0, 0), heading: 0.05, ticks: 1 },
      { pos: ZERO, heading: null, ticks: 4 },
      { pos: v(0.02, 0, -0.01), heading: 0.01, ticks: 1 },
      { pos: ZERO, heading: null, ticks: 2 },
    ]

    const aliased = createVisualOffset()
    for (const s of steps) advanceVisualOffset(aliased, s.pos, s.heading, s.ticks, aliased)

    // The same sequence with a fresh `out` every call, so no step can hide an
    // aliasing bug behind an identically-broken reference.
    let readFrom = createVisualOffset()
    for (const s of steps) {
      const writeTo = createVisualOffset()
      advanceVisualOffset(readFrom, s.pos, s.heading, s.ticks, writeTo)
      readFrom = writeTo
    }

    expect(aliased).toEqual(readFrom)
    expect(aliased.current.x).toBeGreaterThan(0)     // and the sequence is not all-zero
  })
})

describe('advanceVisualOffset — null is not zero', () => {
  it('restarts the window on a heading delta of exactly 0', () => {
    const o = createVisualOffset()
    correct(o, v(0.3, 0, 0), 0.04)
    idle(o, 6)
    const carried = { x: o.current.x, h: o.currentHeading }
    expect(o.ticksSince).toBe(6)

    advanceVisualOffset(o, ZERO, 0, 1, o)
    expect(o.ticksSince).toBe(0)
    expect(o.origin.x).toBeCloseTo(carried.x, 12)
    expect(o.originHeading).toBeCloseTo(carried.h, 12)
    expect(o.current.x).toBeCloseTo(carried.x, 12)     // f = 1 again
  })

  it('keeps decaying on null', () => {
    const o = createVisualOffset()
    correct(o, v(0.3, 0, 0), 0.04)
    idle(o, 6)
    const before = o.current.x

    advanceVisualOffset(o, ZERO, null, 1, o)
    expect(o.ticksSince).toBe(7)
    expect(o.current.x).toBeLessThan(before)
  })

  it('ignores correctionPos entirely when correctionHeading is null', () => {
    const o = createVisualOffset()
    correct(o, v(0.05, 0, 0), 0.05)
    const after = snapshot(o)

    // A caller whose outPos scratch still holds the previous delta must not be
    // able to inject it: `null` means nothing happened, whatever outPos says.
    advanceVisualOffset(o, v(99, 99, 99), null, 0, o)
    expect(o).toEqual(after)
  })
})

describe('advanceVisualOffset — the guards', () => {
  it('cuts BOTH channels when the position delta exceeds the position guard', () => {
    const o = createVisualOffset()
    correct(o, v(30, 0, 0), 0.01)
    expect(isAllZero(o)).toBe(true)
  })

  it('cuts BOTH channels when the heading delta exceeds the heading guard', () => {
    const o = createVisualOffset()
    correct(o, v(0.05, 0, 0), 0.5)
    expect(isAllZero(o)).toBe(true)
  })

  it('measures |origin| in three dimensions, not one axis', () => {
    const o = createVisualOffset()
    correct(o, v(2, 0, 2), 0.01)                  // hypot = 2.83 > 2.5
    expect(isAllZero(o)).toBe(true)
  })

  it('includes the vertical axis in |origin|, not only the plan view', () => {
    // The case above cannot separate a 3D hypot from a plan-view hypot(x, z):
    // its y is 0, so both spellings measure 2.83 m and cut. This one can. A
    // resync that drops a kart out of the air moves mostly y — correctionDeltaOf
    // reports `own.position.y - preY` like any other axis — and a plan-view
    // guard measures that correction as 0 m and slides the kart down instead of
    // cutting.
    const o = createVisualOffset()
    correct(o, v(0, 2.6, 0), 0.01)                // 3D: 2.6 > 2.5. Plan view: 0.
    expect(isAllZero(o)).toBe(true)
  })

  it('eases a correction that only just fits, rather than cutting it', () => {
    const o = createVisualOffset()
    correct(o, v(2.4, 0, 0), 0.14)
    expect(isAllZero(o)).toBe(false)
    expect(o.current.x).toBe(2.4)
    expect(o.currentHeading).toBe(0.14)
  })

  it('admits an origin exactly ON each bound, and cuts just past it', () => {
    // 2.4 m / 0.14 rad above is inside both bounds under `>` and under `>=`
    // alike, so it does not pin the comparison — only a value exactly on the
    // bound does. Both bounds are read from the shipped constants: raising one
    // moves this test with it rather than leaving a stale literal behind.
    const onBound = createVisualOffset()
    correct(onBound, v(ERROR_SMOOTH_MAX_POSITION_M, 0, 0), ERROR_SMOOTH_MAX_HEADING_RAD)
    expect(onBound.current.x).toBe(ERROR_SMOOTH_MAX_POSITION_M)
    expect(onBound.currentHeading).toBe(ERROR_SMOOTH_MAX_HEADING_RAD)

    const pastPosition = createVisualOffset()
    correct(pastPosition, v(ERROR_SMOOTH_MAX_POSITION_M + 1e-6, 0, 0), 0)
    expect(isAllZero(pastPosition)).toBe(true)

    const pastHeading = createVisualOffset()
    correct(pastHeading, ZERO, ERROR_SMOOTH_MAX_HEADING_RAD + 1e-9)
    expect(isAllZero(pastHeading)).toBe(true)
  })

  it('cuts an accumulated origin, not only a single large delta', () => {
    const o = createVisualOffset()
    correct(o, v(2.4, 0, 0), 0.1)
    correct(o, v(0.3, 0, 0), 0)                   // 2.7 m of retained error
    expect(isAllZero(o)).toBe(true)
  })
})

/**
 * §4.11's barrel line is part of this task's diff and nothing else in the package
 * covers it: every other import in this file reaches `src/smoothing` by relative
 * path, so a missing `export * from './smoothing'` leaves `@tapkart/render`
 * without any error smoothing at all — the thing R41's ruling depends on — and
 * leaves this whole file green. Identity, not presence: a second copy of the
 * rules under the same name would pass `toBeDefined()`.
 */
describe('the @tapkart/render barrel re-exports smoothing (§4.11)', () => {
  it('carries all five of the module’s runtime exports, by identity', () => {
    expect(barrel.createVisualOffset).toBe(createVisualOffset)
    expect(barrel.easeRemaining).toBe(easeRemaining)
    expect(barrel.advanceVisualOffset).toBe(advanceVisualOffset)
    expect(barrel.ERROR_SMOOTH_WINDOW_TICKS).toBe(ERROR_SMOOTH_WINDOW_TICKS)
    expect(barrel.ERROR_SMOOTH_MAX_POSITION_M).toBe(ERROR_SMOOTH_MAX_POSITION_M)
    expect(barrel.ERROR_SMOOTH_MAX_HEADING_RAD).toBe(ERROR_SMOOTH_MAX_HEADING_RAD)
  })

  it('carries the VisualOffset type too — §4.9a counts seven exports', () => {
    // Compile-time: this binding does not typecheck unless VisualOffset reaches
    // the barrel. `npm run typecheck` is the assertion; the runtime check below
    // only keeps it alive.
    const throughBarrel: BarrelVisualOffset = barrel.createVisualOffset()
    expect(throughBarrel.ticksSince).toBe(0)
  })
})

describe('the shipped constants', () => {
  it('smooths over 0.2 s at 60 Hz', () => {
    expect(ERROR_SMOOTH_WINDOW_TICKS).toBe(12)
    expect(ERROR_SMOOTH_WINDOW_TICKS * TICK_DT).toBeCloseTo(0.2, 12)
  })

  it('cuts rather than slides a hard resync', () => {
    expect(ERROR_SMOOTH_MAX_POSITION_M).toBe(2.5)
  })

  it('can never out-yaw the car\'s own steering', () => {
    expect(ERROR_SMOOTH_MAX_HEADING_RAD).toBe(0.15)

    // §4.9a's derivation, asserted against the shipped constants rather than
    // trusted from the comment: the peak apparent yaw rate at t = 0 is the
    // derivative of the ease cubic, 3x / (window seconds).
    const peakYawRate =
      (3 * ERROR_SMOOTH_MAX_HEADING_RAD) / (ERROR_SMOOTH_WINDOW_TICKS * TICK_DT)
    expect(peakYawRate).toBeCloseTo(2.25, 9)
    expect(peakYawRate).toBeLessThan(TUNING.steerRateBase)
    expect(TUNING.steerRateBase).toBe(2.6)
  })

  it('produces a measured yaw rate under steerRateBase at the guard bound', () => {
    // The discrete counterpart of the derivation above: run the largest offset
    // the guards admit through the real function and measure the fastest
    // per-tick heading change it actually draws.
    const o = createVisualOffset()
    correct(o, ZERO, ERROR_SMOOTH_MAX_HEADING_RAD)
    let previous = o.currentHeading
    let peak = 0
    for (let i = 0; i < ERROR_SMOOTH_WINDOW_TICKS; i++) {
      idle(o, 1)
      peak = Math.max(peak, Math.abs(o.currentHeading - previous) / TICK_DT)
      previous = o.currentHeading
    }
    expect(peak).toBeCloseTo(2.0677083333, 6)
    expect(peak).toBeLessThan(TUNING.steerRateBase)
  })
})
