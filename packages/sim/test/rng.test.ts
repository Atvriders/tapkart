import { describe, expect, it } from 'vitest'
import { RNG_GOLDEN, RNG_MIX1, RNG_MIX2, promotionCursor, rngAt } from '../src/rng'

const TWO32 = 4294967296

describe('splitmix32 constants', () => {
  it('freezes the three magic numbers', () => {
    expect(RNG_GOLDEN).toBe(0x9e3779b9)
    expect(RNG_GOLDEN).toBe(2654435769)
    expect(RNG_MIX1).toBe(0x21f0aaad)
    expect(RNG_MIX1).toBe(569420461)
    expect(RNG_MIX2).toBe(0x735a2d97)
    expect(RNG_MIX2).toBe(1935289751)
  })
})

describe('rngAt golden values', () => {
  it('matches the recorded uint32 outputs divided by 2^32', () => {
    expect(rngAt(0, 0)).toBe(1684164658 / TWO32)
    expect(rngAt(0, 1)).toBe(3653269916 / TWO32)
    expect(rngAt(0, 2)).toBe(2939563536 / TWO32)
    expect(rngAt(0, 3)).toBe(2141751570 / TWO32)
    expect(rngAt(1, 0)).toBe(1580013426 / TWO32)
    expect(rngAt(12345, 0)).toBe(3283241497 / TWO32)
    expect(rngAt(12345, 1)).toBe(613117429 / TWO32)
    expect(rngAt(12345, 7)).toBe(3763538745 / TWO32)
    expect(rngAt(0xdeadbeef, 0)).toBe(46217145 / TWO32)
  })

  it('matches the recorded decimals to 15 places', () => {
    // 1684164658 / 4294967296 = 0.3921251413412392
    expect(rngAt(0, 0)).toBeCloseTo(0.3921251413412392, 15)
    // 3283241497 / 4294967296 = 0.7644392310176045
    expect(rngAt(12345, 0)).toBeCloseTo(0.7644392310176045, 15)
    // 3763538745 / 4294967296 = 0.8762671484146267
    expect(rngAt(12345, 7)).toBeCloseTo(0.8762671484146267, 15)
  })

  it('reproduces the classic stateful splitmix32 sequence', () => {
    // rngAt(seed, cursor) must equal the cursor-th output of a stateful
    // splitmix32 seeded with `seed`, which is why the implementation mixes
    // (seed + (cursor + 1) * GOLDEN) rather than (seed + cursor * GOLDEN).
    const seed = 12345
    let a = seed | 0
    const next = (): number => {
      a = (a + 0x9e3779b9) | 0
      let t = a ^ (a >>> 16)
      t = Math.imul(t, 0x21f0aaad)
      t = t ^ (t >>> 15)
      t = Math.imul(t, 0x735a2d97)
      t = t ^ (t >>> 15)
      return (t >>> 0) / TWO32
    }
    for (let cursor = 0; cursor < 8; cursor++) {
      expect(rngAt(seed, cursor)).toBe(next())
    }
  })
})

describe('rngAt purity', () => {
  it('holds no internal state: repeated calls return the same value', () => {
    const first = rngAt(777, 3)
    rngAt(999, 0)
    rngAt(777, 4)
    rngAt(0, 0)
    expect(rngAt(777, 3)).toBe(first)
    expect(rngAt(777, 3)).toBe(first)
  })

  it('is order independent: descending cursors match ascending cursors', () => {
    const ascending: number[] = []
    for (let c = 0; c < 32; c++) ascending.push(rngAt(4242, c))
    const descending: number[] = new Array<number>(32)
    for (let c = 31; c >= 0; c--) descending[c] = rngAt(4242, c)
    expect(descending).toEqual(ascending)
  })

  it('separates seeds', () => {
    expect(rngAt(1, 0)).not.toBe(rngAt(2, 0))
    expect(rngAt(1, 0)).not.toBe(rngAt(1, 1))
  })
})

describe('rngAt distribution', () => {
  it('stays inside [0, 1) over 100000 draws', () => {
    let min = 1
    let max = 0
    for (let c = 0; c < 100000; c++) {
      const v = rngAt(1337, c)
      if (v < min) min = v
      if (v > max) max = v
    }
    expect(min).toBeGreaterThanOrEqual(0)
    expect(max).toBeLessThan(1)
    // Observed over seed 1337: min 0.0000132790, max 0.9999998878.
    expect(min).toBeLessThan(0.0001)
    expect(max).toBeGreaterThan(0.9999)
  })

  it('has a mean near 0.5 and fills all ten deciles', () => {
    const buckets = new Array<number>(10).fill(0)
    let sum = 0
    for (let c = 0; c < 100000; c++) {
      const v = rngAt(1337, c)
      sum += v
      buckets[Math.floor(v * 10)]++
    }
    // Observed mean over seed 1337, 100000 draws: 0.4981690483844257.
    expect(sum / 100000).toBeGreaterThan(0.49)
    expect(sum / 100000).toBeLessThan(0.51)
    // Observed decile counts: 9988 10229 9863 10044 10046 10091 10113 9984
    // 9913 9729 — all inside 9500..10500, expected 10000.
    for (const b of buckets) {
      expect(b).toBeGreaterThan(9500)
      expect(b).toBeLessThan(10500)
    }
  })
})

describe('promotionCursor (ruling P2-R14)', () => {
  it('is a pure function of (raceSeed, promotionTick)', () => {
    expect(promotionCursor(0xabc, 900)).toBe(promotionCursor(0xabc, 900))
    expect(promotionCursor(0xabc, 900)).not.toBe(promotionCursor(0xabd, 900))
    expect(promotionCursor(0xabc, 900)).not.toBe(promotionCursor(0xabc, 901))
  })

  it('returns a uint32, never a negative int32 and never a fraction', () => {
    for (let t = 0; t < 2000; t++) {
      const c = promotionCursor(0x5eed, t)
      expect(Number.isInteger(c), `tick ${t} produced ${c}`).toBe(true)
      expect(c).toBeGreaterThanOrEqual(0)
      expect(c).toBeLessThanOrEqual(0xffffffff)
    }
  })

  it('lands far above the small cursor range a live host actually consumes', () => {
    // The point of the ruling: `rngCursor = promotionTick` is deterministic but
    // sits inside the few-thousand-wide band a host has been drawing from, so a
    // promoted shadow would replay draws the host already consumed. Over 2000
    // plausible promotion ticks, at most a handful may fall below 1e6 by
    // chance; a version that just returned the tick would score 2000.
    let low = 0
    for (let t = 0; t < 2000; t++) {
      if (promotionCursor(0x5eed, t) < 1e6) low++
    }
    expect(low).toBeLessThan(5)
  })

  it('is rngAt\'s own avalanche, one step short of the divide', () => {
    // Same mixing function, so the two cannot drift apart under maintenance.
    for (const [seed, tick] of [[0, 0], [1, 1], [0xabc, 900], [-7, 12345]] as const) {
      expect(promotionCursor(seed, tick) / 4294967296).toBe(rngAt(seed, tick))
    }
  })
})
