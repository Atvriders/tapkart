import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  alignmentCentres,
  blockLayoutM,
  byteCapacityM,
  formatInfoBits,
  rsGeneratorPoly,
} from '../src/qr-tables'

/**
 * §5.9: the published values live in a vector file, not in this test, so the
 * test and the module cannot share an author's typo. `node:fs` in a test is the
 * same test-only disk reach Plan 2 §6 and Plan 3 ruling Q34 already permit.
 */
const VECTORS = fileURLToPath(new URL('../vectors/qr-reference.tsv', import.meta.url))

interface Row {
  kind: string
  key: string
  value: string
  source: string
}

function readRows(): Row[] {
  const text = readFileSync(VECTORS, 'utf8')
  const rows: Row[] = []
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (line.length === 0 || line.startsWith('#')) continue
    const parts = line.split('\t')
    if (parts.length !== 4) throw new Error(`qr-reference.tsv: expected 4 columns, got ${parts.length}: ${line}`)
    rows.push({ kind: parts[0], key: parts[1], value: parts[2], source: parts[3] })
  }
  return rows
}

const ROWS = readRows()
const of = (kind: string): Row[] => ROWS.filter((r) => r.kind === kind)

/** GF(256) antilog, x^8 + x^4 + x^3 + x^2 + 1 — used ONLY to turn the published
 *  alpha exponents into elements, so the two published transcriptions of each
 *  generator polynomial can be checked against each other. */
const ANTILOG: number[] = (() => {
  const exp: number[] = []
  let x = 1
  for (let i = 0; i < 255; i++) {
    exp.push(x)
    x <<= 1
    if (x & 0x100) x ^= 0x11d
  }
  return exp
})()

const hexToBytes = (s: string): number[] => {
  const out: number[] = []
  for (let i = 0; i < s.length; i += 2) out.push(parseInt(s.slice(i, i + 2), 16))
  return out
}

describe('qr-reference.tsv', () => {
  it('yields rows at all — an empty vector file must fail, not pass', () => {
    // A vector runner that iterates zero rows and reports success is this
    // project's signature defect (§5.8). Guard every kind, not just the total.
    expect(ROWS.length).toBeGreaterThan(0)
    expect(of('FORMAT_INFO_M')).toHaveLength(8)
    expect(of('RS_GENERATOR_EXP').length).toBeGreaterThan(0)
    expect(of('RS_GENERATOR_HEX').length).toBe(of('RS_GENERATOR_EXP').length)
    expect(of('ALIGNMENT')).toHaveLength(10)
    expect(of('BLOCK_LAYOUT_M')).toHaveLength(10)
    expect(of('BYTE_CAPACITY_M')).toHaveLength(10)
  })

  it('cites a published source on every line', () => {
    for (const row of ROWS) {
      expect(row.source.length, `${row.kind} ${row.key} has no SOURCE`).toBeGreaterThan(10)
    }
  })

  it('contains no kind this test does not check', () => {
    const known = new Set([
      'FORMAT_INFO_M',
      'RS_GENERATOR_EXP',
      'RS_GENERATOR_HEX',
      'ALIGNMENT',
      'BLOCK_LAYOUT_M',
      'BYTE_CAPACITY_M',
    ])
    for (const row of ROWS) expect(known.has(row.kind), `unchecked kind ${row.kind}`).toBe(true)
  })
})

describe('formatInfoBits — BCH(15,5) computed, published table transcribed', () => {
  for (const row of of('FORMAT_INFO_M')) {
    it(`mask ${row.key} equals the published 15 bits`, () => {
      expect(row.value).toHaveLength(15)
      const computed = formatInfoBits(Number(row.key)).toString(2).padStart(15, '0')
      expect(computed).toBe(row.value)
    })
  }

  it('covers masks 0..7 and nothing else', () => {
    expect(of('FORMAT_INFO_M').map((r) => Number(r.key)).sort((a, b) => a - b)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7,
    ])
  })

  it('never exceeds 15 bits', () => {
    for (let mask = 0; mask < 8; mask++) expect(formatInfoBits(mask)).toBeLessThan(1 << 15)
  })

  it('throws outside 0..7', () => {
    expect(() => formatInfoBits(-1)).toThrow()
    expect(() => formatInfoBits(8)).toThrow()
    expect(() => formatInfoBits(1.5)).toThrow()
  })
})

describe('rsGeneratorPoly — multiplied out over GF(256), published table transcribed', () => {
  const exps = new Map(of('RS_GENERATOR_EXP').map((r) => [Number(r.key), r.value]))
  const hexes = new Map(of('RS_GENERATOR_HEX').map((r) => [Number(r.key), r.value]))

  for (const [n, hex] of hexes) {
    it(`degree ${n} equals the published polynomial`, () => {
      expect([...rsGeneratorPoly(n)]).toEqual(hexToBytes(hex))
    })

    it(`degree ${n}: the two published transcriptions agree with each other`, () => {
      // A typo in the element-form row cannot hide behind a typo in the
      // exponent-form row: they come from different publications.
      const fromExponents = (exps.get(n) ?? '').split(',').map((e) => ANTILOG[Number(e)])
      expect(fromExponents).toEqual(hexToBytes(hex))
    })

    it(`degree ${n} has ${n + 1} coefficients, leading 1`, () => {
      const poly = rsGeneratorPoly(n)
      expect(poly).toHaveLength(n + 1)
      expect(poly[0]).toBe(1)
    })
  }

  it('carries a polynomial for every EC count versions 1..10 at ECC-M use', () => {
    const needed = new Set<number>()
    for (let v = 1; v <= 10; v++) needed.add(blockLayoutM(v).ecCodewordsPerBlock)
    expect([...needed].sort((a, b) => a - b)).toEqual([...hexes.keys()].sort((a, b) => a - b))
  })
})

describe('alignmentCentres — spacing rule computed, published table transcribed', () => {
  for (const row of of('ALIGNMENT')) {
    it(`version ${row.key} equals the published centres`, () => {
      const expected = row.value === '-' ? [] : row.value.split(',').map(Number)
      expect([...alignmentCentres(Number(row.key))]).toEqual(expected)
    })
  }

  it('always starts at 6 and ends 7 modules in from the far edge, when there are any', () => {
    for (let v = 2; v <= 10; v++) {
      const centres = alignmentCentres(v)
      const size = 4 * v + 17
      expect(centres[0]).toBe(6)
      expect(centres[centres.length - 1]).toBe(size - 7)
    }
  })
})

describe('blockLayoutM — totals computed from geometry, structure transcribed', () => {
  for (const row of of('BLOCK_LAYOUT_M')) {
    it(`version ${row.key} equals the published row`, () => {
      const [total, ec, g1b, g1d, g2b, g2d] = row.value.split(',').map(Number)
      const layout = blockLayoutM(Number(row.key))
      expect(layout.totalCodewords).toBe(total)
      expect(layout.ecCodewordsPerBlock).toBe(ec)
      expect(layout.group1Blocks).toBe(g1b)
      expect(layout.group1DataCodewords).toBe(g1d)
      expect(layout.group2Blocks).toBe(g2b)
      expect(layout.group2DataCodewords).toBe(g2d)
    })
  }

  it('the geometry-derived total equals the sum of the transcribed blocks', () => {
    // This is what keeps the transcription honest: totalCodewords is counted out
    // of the symbol's own module geometry and shares nothing with Table 9's five
    // numbers, so a typo in any of them breaks this identity.
    for (let v = 1; v <= 10; v++) {
      const l = blockLayoutM(v)
      const sum =
        l.group1Blocks * (l.group1DataCodewords + l.ecCodewordsPerBlock) +
        l.group2Blocks * (l.group2DataCodewords + l.ecCodewordsPerBlock)
      expect(sum, `version ${v}`).toBe(l.totalCodewords)
    }
  })

  it('group 2, where it exists, holds exactly one more data codeword than group 1', () => {
    for (let v = 1; v <= 10; v++) {
      const l = blockLayoutM(v)
      if (l.group2Blocks > 0) expect(l.group2DataCodewords).toBe(l.group1DataCodewords + 1)
    }
  })

  it('throws outside versions 1..10', () => {
    expect(() => blockLayoutM(0)).toThrow()
    expect(() => blockLayoutM(11)).toThrow()
  })
})

describe('byteCapacityM — computed from the layout, published table transcribed', () => {
  for (const row of of('BYTE_CAPACITY_M')) {
    it(`version ${row.key} equals the published capacity`, () => {
      expect(byteCapacityM(Number(row.key))).toBe(Number(row.value))
    })
  }

  it('increases with version', () => {
    for (let v = 2; v <= 10; v++) expect(byteCapacityM(v)).toBeGreaterThan(byteCapacityM(v - 1))
  })

  it('leaves room for the mode nibble and the character count indicator', () => {
    // Independent of the transcribed capacity: whatever the table says, the
    // declared capacity must fit inside the data codewords with 4 + CCI bits of
    // header. CCI is 8 bits for versions 1..9 and 16 for version 10.
    for (let v = 1; v <= 10; v++) {
      const l = blockLayoutM(v)
      const dataBits =
        (l.group1Blocks * l.group1DataCodewords + l.group2Blocks * l.group2DataCodewords) * 8
      const cci = v <= 9 ? 8 : 16
      expect(byteCapacityM(v) * 8 + 4 + cci).toBeLessThanOrEqual(dataBits)
      expect((byteCapacityM(v) + 1) * 8 + 4 + cci).toBeGreaterThan(dataBits)
    }
  })
})
