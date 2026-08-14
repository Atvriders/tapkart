import { describe, expect, it } from 'vitest'
import { clamp, lerp, wrapAngle } from '../src/mathutil'

describe('clamp', () => {
  it('clamps above hi', () => {
    expect(clamp(5, 0, 1)).toBe(1)
    expect(clamp(1.0001, -1, 1)).toBe(1)
  })

  it('clamps below lo', () => {
    expect(clamp(-3, -1, 1)).toBe(-1)
    expect(clamp(-0.0001, 0, 1)).toBe(0)
  })

  it('passes interior values through unchanged', () => {
    expect(clamp(0.25, 0, 1)).toBe(0.25)
    expect(clamp(0, -1, 1)).toBe(0)
  })

  it('returns the bound itself at the bound', () => {
    expect(clamp(1, 0, 1)).toBe(1)
    expect(clamp(0, 0, 1)).toBe(0)
  })

  it('propagates NaN rather than silently choosing a bound', () => {
    // NaN < lo and NaN > hi are both false, so NaN falls through.
    expect(Number.isNaN(clamp(NaN, 0, 1))).toBe(true)
  })
})

describe('lerp', () => {
  it('interpolates', () => {
    expect(lerp(0, 10, 0.25)).toBe(2.5)  // 0 + (10-0)*0.25
    expect(lerp(-1, 1, 0.5)).toBe(0)     // -1 + 2*0.5
  })

  it('is exact at both endpoints', () => {
    // a + (b-a)*t: at t=0 this is a exactly, at t=1 it is 2 + 6*1 = 8 exactly.
    expect(lerp(2, 8, 0)).toBe(2)
    expect(lerp(2, 8, 1)).toBe(8)
  })

  it('extrapolates outside 0..1', () => {
    expect(lerp(0, 10, 1.5)).toBe(15)
    expect(lerp(0, 10, -0.5)).toBe(-5)
  })
})

describe('wrapAngle', () => {
  it('leaves angles already inside (-PI, PI] alone', () => {
    expect(wrapAngle(0)).toBe(0)
    expect(wrapAngle(0.5)).toBe(0.5)
    expect(wrapAngle(Math.PI / 2)).toBe(Math.PI / 2)
    expect(wrapAngle(-Math.PI / 2)).toBe(-Math.PI / 2)
  })

  it('is half-open at the top: PI stays PI, -PI becomes PI', () => {
    // This is the whole point of the (-PI, PI] convention. A kart facing -x
    // has heading atan2(0, -1) === Math.PI and must not flip sign every tick.
    expect(wrapAngle(Math.PI)).toBe(Math.PI)
    // -Math.PI + 2*Math.PI is exactly Math.PI in float64.
    expect(wrapAngle(-Math.PI)).toBe(Math.PI)
  })

  it('wraps a heading just past PI to just past -PI', () => {
    // 3*PI/2 = 4.71238898038469; minus 2*PI = -1.5707963267948966 = -PI/2.
    expect(wrapAngle(3 * Math.PI / 2)).toBe(-Math.PI / 2)
    // -3*PI/2 = -4.71238898038469; plus 2*PI = 1.5707963267948966 = PI/2.
    expect(wrapAngle(-3 * Math.PI / 2)).toBe(Math.PI / 2)
  })

  it('wraps multiple turns', () => {
    expect(wrapAngle(2 * Math.PI)).toBe(0)
    // (3*Math.PI) % (2*Math.PI) is exactly Math.PI, which is in range.
    expect(wrapAngle(3 * Math.PI)).toBe(Math.PI)
    expect(wrapAngle(-3 * Math.PI)).toBe(Math.PI)
    // 5 % 2PI = 5, which is > PI, so 5 - 2PI = -1.2831853071795862.
    expect(wrapAngle(5)).toBe(5 - 2 * Math.PI)
    // 7 % 2PI = 0.7168146928204138, already in range.
    expect(wrapAngle(7)).toBe(7 - 2 * Math.PI)
  })

  it('never returns -0, because statesEqual compares with Object.is', () => {
    // (-2*Math.PI) % (2*Math.PI) is -0, and Object.is(-0, 0) is false, so a
    // stray -0 heading would read as a state divergence. The +0 at the end of
    // wrapAngle normalizes it.
    expect(Object.is(wrapAngle(-2 * Math.PI), 0)).toBe(true)
    expect(Object.is(wrapAngle(0), 0)).toBe(true)
    expect(Object.is(wrapAngle(-0), 0)).toBe(true)
  })

  it('lands in (-PI, PI] for 200001 sampled angles', () => {
    let violations = 0
    for (let i = -100000; i <= 100000; i++) {
      const w = wrapAngle(i * 0.137)
      if (!(w > -Math.PI && w <= Math.PI)) violations++
    }
    expect(violations).toBe(0)
  })

  it('is idempotent', () => {
    for (const a of [0, 5, 7, 100, -100, 1000, Math.PI, -Math.PI]) {
      expect(wrapAngle(wrapAngle(a))).toBe(wrapAngle(a))
    }
  })
})
