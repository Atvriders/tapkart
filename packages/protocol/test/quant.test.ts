import { describe, expect, it } from 'vitest'
import { EPS, Q, quantStep, WORLD_HALF } from '../src/quant'

describe('WORLD_HALF', () => {
  it('is 1024', () => {
    expect(WORLD_HALF).toBe(1024)
  })
})

describe('quantStep', () => {
  it('matches (max - min) / (2^bits - 1) for every continuous field range', () => {
    expect(quantStep(-1024, 1024, 16)).toBe(2048 / 65535)
    expect(quantStep(-64, 64, 12)).toBe(128 / 4095)
    expect(quantStep(-Math.PI, Math.PI, 12)).toBe((2 * Math.PI) / 4095)
    expect(quantStep(-16, 16, 10)).toBe(32 / 1023)
    expect(quantStep(0, 255, 8)).toBe(255 / 255)
    expect(quantStep(0, 1, 10)).toBe(1 / 1023)
  })

  it('divides by 2^bits - 1, not 2^bits, at 10 bits', () => {
    // An earlier draft of contract §4's prose table rounded two 10-bit rows as if
    // the denominator were 2^bits (1024): angularVelocity would round to 0.03125
    // and t (lap progress) to 0.0009766. The formula's denominator is 2^bits - 1
    // (1023) - these differ at the 4th decimal, and the current contract's own
    // Step column already reflects the corrected value (0.0312805 / 0.0009775).
    const angularVelocityStep = quantStep(-16, 16, 10)
    expect(angularVelocityStep).toBeCloseTo(0.0312805, 6)
    expect(angularVelocityStep).not.toBeCloseTo(0.03125, 6)
    const tStep = quantStep(0, 1, 10)
    expect(tStep).toBeCloseTo(0.0009775, 6)
    expect(tStep).not.toBeCloseTo(0.0009766, 6)
  })

  it('is exactly 1 for every field whose range spans exactly 2^bits - 1 integers', () => {
    expect(quantStep(0, 255, 8)).toBe(1)
    expect(quantStep(0, 127, 7)).toBe(1)
    expect(quantStep(0, 63, 6)).toBe(1)
    expect(quantStep(0, 15, 4)).toBe(1)
    expect(quantStep(0, 7, 3)).toBe(1)
    expect(quantStep(0, 3, 2)).toBe(1)
    expect(quantStep(0, 1, 1)).toBe(1)
  })
})

const CONTINUOUS_FIELDS = ['angularVelocity', 'driftCharge', 'heading', 'position', 't', 'velocity'] as const

describe('Q', () => {
  it('has exactly the six continuous fields contract §3/§4 name, keyed t not lapT', () => {
    expect(Object.keys(Q).sort()).toEqual([...CONTINUOUS_FIELDS].sort())
  })

  it('matches contract §4 range and bits for every field', () => {
    expect(Q.position).toEqual({ min: -WORLD_HALF, max: WORLD_HALF, bits: 16 })
    expect(Q.velocity).toEqual({ min: -64, max: 64, bits: 12 })
    expect(Q.heading).toEqual({ min: -Math.PI, max: Math.PI, bits: 12 })
    expect(Q.angularVelocity).toEqual({ min: -16, max: 16, bits: 10 })
    expect(Q.driftCharge).toEqual({ min: 0, max: 255, bits: 8 })
    expect(Q.t).toEqual({ min: 0, max: 1, bits: 10 })
  })

  it('sums to 124 bits across the six continuous fields, position/velocity counted 3x each', () => {
    // 3*16 (position.x,y,z) + 3*12 (velocity.x,y,z) + 12 (heading) + 10 (angularVelocity)
    // + 8 (driftCharge) + 10 (t) = 48 + 36 + 12 + 10 + 8 + 10 = 124.
    // The full 178-bit-per-kart total (contract §4) also needs the fourteen exact
    // fields' widths, which are Task 6's local constants, not Q -- Task 6 asserts
    // the full 178-bit total once those constants exist alongside these six.
    const singleWidth = (['heading', 'angularVelocity', 'driftCharge', 't'] as const)
      .reduce((sum, f) => sum + Q[f].bits, 0)
    const total = singleWidth + 3 * Q.position.bits + 3 * Q.velocity.bits
    expect(total).toBe(124)
  })

  it('is deeply frozen: the table and every field object inside it', () => {
    expect(Object.isFrozen(Q)).toBe(true)
    expect(Object.isFrozen(Q.position)).toBe(true)
    expect(Object.isFrozen(Q.t)).toBe(true)
  })
})

describe('EPS', () => {
  it('has exactly the same six keys as Q', () => {
    expect(Object.keys(EPS).sort()).toEqual(Object.keys(Q).sort())
  })

  it('matches contract §4 epsilon for every field', () => {
    expect(EPS.position).toBe(0.05)
    expect(EPS.velocity).toBe(0.05)
    expect(EPS.heading).toBe(0.0025)
    expect(EPS.angularVelocity).toBe(0.05)
    expect(EPS.driftCharge).toBe(1.5)
    expect(EPS.t).toBe(0.002)
  })

  it('is frozen', () => {
    expect(Object.isFrozen(EPS)).toBe(true)
  })

  it('exceeds quantStep for every field - the buzz-prevention invariant', () => {
    // contract §0/§4: an epsilon at or below its field's step means quantisation
    // noise alone triggers a correction every snapshot. This is a basic sanity
    // check at the point of authorship; Task 7 asserts the same inequality
    // mechanically for every field as its own dedicated test.
    for (const f of CONTINUOUS_FIELDS) {
      const step = quantStep(Q[f].min, Q[f].max, Q[f].bits)
      expect(EPS[f]).toBeGreaterThan(step)
    }
  })
})

describe('@tapkart/protocol barrel', () => {
  it('re-exports Q, EPS, quantStep and WORLD_HALF', async () => {
    const pkg = await import('@tapkart/protocol')
    expect(pkg.WORLD_HALF).toBe(1024)
    expect(typeof pkg.quantStep).toBe('function')
    expect(pkg.Q.position.bits).toBe(16)
    expect(pkg.EPS.position).toBe(0.05)
  })
})
