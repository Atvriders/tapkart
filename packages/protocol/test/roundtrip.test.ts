import { describe, expect, it } from 'vitest'
import { BitReader, BitWriter } from '../src/bits'
import { EPS, Q, quantStep } from '../src/quant'
import type { EpsilonTable, QuantTable } from '../src/quant'

/**
 * The six continuous ("band"-compared) fields from the locked contract §4.
 * Keyed to match WireKart's flat field names (§3) — in particular `t`, not
 * `lap.t`, because WireKart declares `t: number` as a sibling of `lap` and
 * `checkpointIdx`, not nested. This shape is contract §3, not a choice this
 * file makes: if `Q`/`EPS` use different keys, that is a defect in
 * quant.ts's Task 5, not a cue to edit this list to match it. See this
 * file's task brief for the full reasoning.
 */
const CONTINUOUS_FIELDS: (keyof QuantTable & keyof EpsilonTable)[] = [
  'position',
  'velocity',
  'heading',
  'angularVelocity',
  'driftCharge',
  't',
]

describe('epsilon strictly exceeds step, for every continuous field', () => {
  // Claim (b): epsilon > step, asserted against Q and EPS themselves — never
  // against a decimal copied out of the contract's prose table. `step` is
  // recomputed here via the real `quantStep`, from Q's own min/max/bits, so
  // this catches a wrong step in Q just as readily as a wrong epsilon in EPS.
  for (const field of CONTINUOUS_FIELDS) {
    it(`EPS.${field} > quantStep(Q.${field})`, () => {
      const { min, max, bits } = Q[field]
      const step = quantStep(min, max, bits)
      expect(EPS[field]).toBeGreaterThan(step)
    })
  }
})

/**
 * The mechanical check under test, factored out so it can be run against
 * both the real tables and a deliberately mistuned copy. This is the same
 * technique the first describe block above uses inline (`EPS[field] >
 * quantStep(...)`); pulling it into a function is what lets "that invariant
 * actually has teeth" below prove the check rejects a bad tuning, rather
 * than merely restating `!(x > x)` against numbers nobody read from EPS/Q.
 */
function epsilonExceedsStep(
  field: keyof QuantTable & keyof EpsilonTable,
  eps: EpsilonTable,
  q: QuantTable,
): boolean {
  const { min, max, bits } = q[field]
  return eps[field] > quantStep(min, max, bits)
}

describe('that invariant actually has teeth', () => {
  // Sanity: the extracted check agrees with the real EPS/Q for every field,
  // before trusting it to catch a bad tuning below.
  it('the real EPS/Q tables pass the mechanical check for every field', () => {
    for (const field of CONTINUOUS_FIELDS) {
      expect(epsilonExceedsStep(field, EPS, Q)).toBe(true)
    }
  })

  // The actual control. Builds a copy of EPS with exactly one field's
  // epsilon set equal to its own step -- the forbidden tuning contract §0
  // names by name ("Do not tune an epsilon downward to make a test pass;
  // that test is the one protecting the player from a buzzing kart") -- and
  // asserts the mechanical check rejects it. This reads the real Q (for
  // min/max/bits) and only perturbs EPS, so unlike a version that just
  // restates `!(x > x)` against invented numbers, it genuinely fails if
  // epsilonExceedsStep is ever loosened from `>` to `>=`.
  it('an epsilon tuned exactly equal to its step fails the mechanical check, field by field', () => {
    for (const field of CONTINUOUS_FIELDS) {
      const step = quantStep(Q[field].min, Q[field].max, Q[field].bits)
      const badEps: EpsilonTable = { ...EPS, [field]: step }
      expect(epsilonExceedsStep(field, badEps, Q)).toBe(false)
    }
  })

  // The mirror image, against the same perturbed table rather than invented
  // numbers: a `>=` comparison (the wrong tool) would wrongly accept the
  // exact forbidden tuning `>` correctly rejects above.
  it('demonstrates why the check must use > and not >=, against the same perturbed table', () => {
    for (const field of CONTINUOUS_FIELDS) {
      const step = quantStep(Q[field].min, Q[field].max, Q[field].bits)
      const badEps: EpsilonTable = { ...EPS, [field]: step }
      const recomputedStep = quantStep(Q[field].min, Q[field].max, Q[field].bits)
      expect(badEps[field] >= recomputedStep).toBe(true) // the wrong tool wrongly passes this
      expect(badEps[field] > recomputedStep).toBe(false) // the real check correctly rejects it
    }
  })
})

describe('round trip stays within one quantization step', () => {
  // Claim (a): decode(encode(x)) differs from x by less than that field's
  // step. min/max/bits always come from Q, never from a literal, so this
  // exercises whatever quantization Task 5 actually shipped.
  for (const field of CONTINUOUS_FIELDS) {
    it(`${field}: min, max, midpoint, and an off-center sample`, () => {
      const { min, max, bits } = Q[field]
      const step = quantStep(min, max, bits)
      const samples = [min, max, (min + max) / 2, min + (max - min) * 0.137]
      for (const value of samples) {
        const buf = new Uint8Array(8)
        const w = new BitWriter(buf)
        w.writeFloatQ(value, min, max, bits)
        const r = new BitReader(buf)
        const decoded = r.readFloatQ(min, max, bits)
        // The true bound for a linear quantizer is step/2; asserting the
        // full step leaves comfortable headroom against float rounding right
        // at a bucket boundary, while still matching spec §8's wording
        // ("differs from x by less than each field's stated quantization
        // step") via a strict less-than.
        expect(Math.abs(decoded - value)).toBeLessThan(step)
      }
    })
  }
})

describe('continuous fields survive at each range endpoint', () => {
  for (const field of CONTINUOUS_FIELDS) {
    it(`${field} at Q.${field}.min and Q.${field}.max`, () => {
      const { min, max, bits } = Q[field]
      const step = quantStep(min, max, bits)
      for (const value of [min, max]) {
        const buf = new Uint8Array(8)
        const w = new BitWriter(buf)
        w.writeFloatQ(value, min, max, bits)
        const decoded = new BitReader(buf).readFloatQ(min, max, bits)
        expect(Math.abs(decoded - value)).toBeLessThan(step)
      }
    })
  }
})

/**
 * Representative exact (Object.is-compared) integer field widths, taken
 * directly from contract §4's Bits column. These do not go through
 * writeFloatQ/readFloatQ or through Q/EPS at all — they are raw bitfields,
 * exact by construction, and this section proves BitWriter/BitReader hold
 * that promise at the specific widths the wire format actually uses.
 */
const EXACT_FIELDS: { name: string; bits: number }[] = [
  { name: 'spinOutTicks', bits: 8 },
  { name: 'invulnTicks', bits: 8 },
  { name: 'boostTicks', bits: 7 },
  { name: 'respawnTicks', bits: 7 },
  { name: 'lap', bits: 3 },
  { name: 'checkpointIdx', bits: 6 },
  { name: 'item', bits: 4 },
  { name: 'surface', bits: 2 },
  { name: 'playerId', bits: 3 },
]

describe('integer fields round-trip exactly, via Object.is', () => {
  for (const { name, bits } of EXACT_FIELDS) {
    it(`${name} (${bits} bits): 0, its max, and a mid value`, () => {
      const max = 2 ** bits - 1
      const mid = Math.floor(max / 3)
      for (const value of [0, max, mid]) {
        const buf = new Uint8Array(8)
        const w = new BitWriter(buf)
        w.writeBits(value, bits)
        const decoded = new BitReader(buf).readBits(bits)
        expect(Object.is(decoded, value)).toBe(true)
      }
    })
  }

  it('normalises -0 to +0', () => {
    const buf = new Uint8Array(8)
    const w = new BitWriter(buf)
    w.writeBits(-0, 8)
    const decoded = new BitReader(buf).readBits(8)
    expect(Object.is(decoded, -0)).toBe(false)
    expect(Object.is(decoded, 0)).toBe(true)
  })
})
