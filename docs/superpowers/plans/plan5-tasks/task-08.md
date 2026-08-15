### Task 8: `packages/invite/src/qr-tables.ts` and the published reference vectors — PURE

**Files:**
- Create: `packages/invite/src/qr-tables.ts`
- Create: `packages/invite/vectors/qr-reference.tsv`
- Modify: `packages/invite/src/index.ts` — one `export *` line
- Test: `packages/invite/test/qr-tables.test.ts`

Ruling **F-P5-2** hand-writes the QR encoder — *"byte mode, ECC-M, Reed–Solomon over GF(256), masking, format info. Several hundred lines — and every one of them pure, fully testable, and implementing an **ISO spec that has not changed since 2006 and will not.** A dependency here buys nothing and costs supply-chain surface in a repo whose entire runtime dependency list is `three` and `ws`."*

This task builds the half of it that is **published constants**, and it exists as its own task for one reason: the constants are the only part an encoder can get wrong in a way that still produces a beautiful, plausible, unscannable square. §4.8 states the discipline:

> Every one of these is **COMPUTED** from the algorithm, never transcribed — §5.9 asserts each against a transcription of the published table, which is what makes the test evidence rather than a mirror.

And §5.9 states what "published" has to mean here:

> The contract fixes the **format and the required contents**, not the numbers — the numbers are transcribed by the implementing task from the published tables, and **no number in this contract may be used as their source.** … The test asserts the computed value equals the transcribed published value. **That is the independence the ruling demands: a transcription is evidence about a computation; a computation compared to itself is not.**

So: `formatInfoBits` computes BCH(15,5) and XORs the published mask; `rsGeneratorPoly` multiplies out (x − α⁰)(x − α¹)… over GF(256); `alignmentCentres` applies the published spacing rule; `blockLayoutM.totalCodewords` counts modules out of the symbol's own geometry. The TSV holds the published values these must equal.

**The one thing that genuinely cannot be computed, said out loud.** The per-version block structure at ECC-M — how many EC codewords per block, and how the data codewords split into one or two groups — is *table data* in ISO/IEC 18004 Table 9. There is no formula. It is therefore transcribed **into the module**, which would leave the TSV comparing one transcription against another by the same hand — a test that cannot detect what it exists to detect. The identity that closes that hole:

```
totalCodewords(version) == group1Blocks * (group1DataCodewords + ecCodewordsPerBlock)
                         + group2Blocks * (group2DataCodewords + ecCodewordsPerBlock)
```

`totalCodewords` is **computed from the symbol geometry** — module count minus function patterns, format and version information, divided by eight — so it shares nothing with the transcribed row. A typo in any of the five transcribed numbers breaks the identity. The test asserts it for all ten versions, and that is what makes the table honest.

**Interfaces:**

- **Consumes:** nothing. No import of `@tapkart/protocol`, no sibling module. The tables are a function of the QR standard and of nothing in this repository.

- **Produces** — contract §4.8, exactly six exports and not a seventh (§16's census fixes `invite/qr-tables` at 6):

  ```ts
  /** BCH(15,5) format information for ECC level M and the given mask (0..7),
   *  XORed with the published mask pattern. 15 bits, in the low bits. */
  export function formatInfoBits(mask: number): number

  /** The Reed-Solomon generator polynomial of the given degree over GF(256),
   *  coefficients high-order first, each an element (not a log). */
  export function rsGeneratorPoly(ecCodewords: number): Uint8Array

  /** Alignment-pattern centre coordinates for the version. Empty for version 1. */
  export function alignmentCentres(version: number): readonly number[]

  export interface QrBlockLayout {
    totalCodewords: number
    ecCodewordsPerBlock: number
    group1Blocks: number
    group1DataCodewords: number
    group2Blocks: number
    group2DataCodewords: number
  }
  /** ECC level M only — the only level this game emits. */
  export function blockLayoutM(version: number): QrBlockLayout

  /** Byte-mode data capacity in bytes at ECC-M for the version. */
  export function byteCapacityM(version: number): number
  ```

  Six: `formatInfoBits`, `rsGeneratorPoly`, `alignmentCentres`, `QrBlockLayout`, `blockLayoutM`, `byteCapacityM`.

  **`gfMul` is deliberately not exported.** Task 9 needs GF(256) multiplication and gets it from six lines of shift-and-xor of its own, because the census fixes this module at six exports and because two *differently written* multipliers cannot share a typo. Both are anchored to published vectors.

**Vectors, and the rule that keeps them evidence:** `packages/invite/vectors/qr-reference.tsv` is written **from the published tables**, never from this module's output. If a row disagrees with the code, the code is what changes until someone shows the published table says otherwise. Regenerating this file from `qr-tables.ts` would convert the whole test into a tautology, which is the exact failure F-P5-2 names.

---

- [ ] **Step 1: Write the failing test**

Create `packages/invite/vectors/qr-reference.tsv` first — it is the test's input, not its output:

```tsv
# qr-reference.tsv — version 1
# Published QR Code (ISO/IEC 18004) table values, transcribed by hand.
#
# F-P5-2 and contract §5.9: packages/invite/src/qr-tables.ts COMPUTES every one
# of these. This file is the independent published value it is compared against.
# NEVER regenerate this file from the encoder's own output — a computation
# compared to itself is not evidence.
#
# KIND <TAB> KEY <TAB> VALUE <TAB> SOURCE
#
# FORMAT_INFO_M      key = mask 0..7,     value = 15 bits, most significant first
# RS_GENERATOR_EXP   key = EC codewords,  value = alpha exponents, high-order first
# RS_GENERATOR_HEX   key = EC codewords,  value = the same polynomial as field elements
# ALIGNMENT          key = version,       value = centre coordinates, or '-' for none
# BLOCK_LAYOUT_M     key = version,       value = total,ecPerBlock,g1Blocks,g1Data,g2Blocks,g2Data
# BYTE_CAPACITY_M    key = version,       value = capacity in bytes, byte mode
FORMAT_INFO_M	0	101010000010010	ISO/IEC 18004 format information table, ECC level M; the same 15 bits are printed as a bit array in A. Leiradella, "QR Codes on the ZX81" (2020-08-02), leiradel.github.io/2020/08/02/QR-Codes-on-the-ZX81.html
FORMAT_INFO_M	1	101000100100101	ISO/IEC 18004 format information table, ECC level M; reproduced at thonky.com/qr-code-tutorial/format-version-tables
FORMAT_INFO_M	2	101111001111100	ISO/IEC 18004 Annex I worked example prints this string for its version 1-M mask-2 symbol; also in the format information table
FORMAT_INFO_M	3	101101101001011	ISO/IEC 18004 format information table, ECC level M; reproduced at thonky.com/qr-code-tutorial/format-version-tables
FORMAT_INFO_M	4	100010111111001	ISO/IEC 18004 format information table, ECC level M; reproduced at thonky.com/qr-code-tutorial/format-version-tables
FORMAT_INFO_M	5	100000011001110	ISO/IEC 18004 format information table, ECC level M; reproduced at thonky.com/qr-code-tutorial/format-version-tables
FORMAT_INFO_M	6	100111110010111	ISO/IEC 18004 format information table, ECC level M; reproduced at thonky.com/qr-code-tutorial/format-version-tables
FORMAT_INFO_M	7	100101010100000	ISO/IEC 18004 format information table, ECC level M; reproduced at thonky.com/qr-code-tutorial/format-version-tables
RS_GENERATOR_EXP	10	0,251,67,46,61,118,70,64,94,32,45	ISO/IEC 18004 Annex A generator polynomials; reproduced at thonky.com/qr-code-tutorial/generator-polynomial-tool
RS_GENERATOR_HEX	10	01D8C29F6FC75E5F719DC1	Published in decimal as [1,216,194,159,111,199,94,95,113,157,193] in A. Leiradella, "QR Codes on the ZX81" (2020-08-02) — an independent transcription in element form
RS_GENERATOR_EXP	16	0,120,104,107,109,102,161,76,3,91,191,147,169,182,194,225,120	ISO/IEC 18004 Annex A generator polynomials; reproduced at thonky.com/qr-code-tutorial/generator-polynomial-tool
RS_GENERATOR_HEX	16	013B0D68BD44D11E08A34129E56232243B	The RS_GENERATOR_EXP row for 16, converted through the GF(256) antilog of ISO/IEC 18004 Annex A
RS_GENERATOR_EXP	18	0,215,234,158,94,184,97,118,170,79,187,152,148,252,179,5,98,96,153	ISO/IEC 18004 Annex A generator polynomials; reproduced at thonky.com/qr-code-tutorial/generator-polynomial-tool
RS_GENERATOR_HEX	18	01EFFBB77195AFC7D7F0DC4952AD4B2043D992	The RS_GENERATOR_EXP row for 18, converted through the GF(256) antilog of ISO/IEC 18004 Annex A
RS_GENERATOR_EXP	22	0,210,171,247,242,93,230,14,109,221,53,200,74,8,172,98,80,219,134,160,105,165,231	ISO/IEC 18004 Annex A generator polynomials; reproduced at thonky.com/qr-code-tutorial/generator-polynomial-tool
RS_GENERATOR_HEX	22	0159B383B0B6F413BD45281C891D7B43FD56DAE61A91F5	The RS_GENERATOR_EXP row for 22, converted through the GF(256) antilog of ISO/IEC 18004 Annex A
RS_GENERATOR_EXP	24	0,229,121,135,48,211,117,251,126,159,180,169,152,192,226,228,218,111,0,117,232,87,96,227,21	ISO/IEC 18004 Annex A generator polynomials; reproduced at thonky.com/qr-code-tutorial/generator-polynomial-tool
RS_GENERATOR_HEX	24	017A76A946B2EDD8667396E54982483D2BCE01EDF77FD99075	The RS_GENERATOR_EXP row for 24, converted through the GF(256) antilog of ISO/IEC 18004 Annex A
RS_GENERATOR_EXP	26	0,173,125,158,2,103,182,118,17,145,201,111,28,165,53,161,21,245,142,13,102,48,227,153,145,218,70	ISO/IEC 18004 Annex A generator polynomials; reproduced at thonky.com/qr-code-tutorial/generator-polynomial-tool
RS_GENERATOR_HEX	26	01F633B7048862C7984D38CE189128D175E92A87444690924D2B5E	The RS_GENERATOR_EXP row for 26, converted through the GF(256) antilog of ISO/IEC 18004 Annex A
ALIGNMENT	1	-	ISO/IEC 18004 Annex E alignment pattern centres: version 1 has none
ALIGNMENT	2	6,18	ISO/IEC 18004 Annex E, alignment pattern centre coordinates
ALIGNMENT	3	6,22	ISO/IEC 18004 Annex E, alignment pattern centre coordinates
ALIGNMENT	4	6,26	ISO/IEC 18004 Annex E, alignment pattern centre coordinates
ALIGNMENT	5	6,30	ISO/IEC 18004 Annex E, alignment pattern centre coordinates
ALIGNMENT	6	6,34	ISO/IEC 18004 Annex E, alignment pattern centre coordinates
ALIGNMENT	7	6,22,38	ISO/IEC 18004 Annex E, alignment pattern centre coordinates
ALIGNMENT	8	6,24,42	ISO/IEC 18004 Annex E, alignment pattern centre coordinates
ALIGNMENT	9	6,26,46	ISO/IEC 18004 Annex E, alignment pattern centre coordinates
ALIGNMENT	10	6,28,50	ISO/IEC 18004 Annex E, alignment pattern centre coordinates
BLOCK_LAYOUT_M	1	26,10,1,16,0,0	ISO/IEC 18004 error correction characteristics table, version 1-M; reproduced at thonky.com/qr-code-tutorial/error-correction-table
BLOCK_LAYOUT_M	2	44,16,1,28,0,0	ISO/IEC 18004 error correction characteristics table, version 2-M; reproduced at thonky.com/qr-code-tutorial/error-correction-table
BLOCK_LAYOUT_M	3	70,26,1,44,0,0	ISO/IEC 18004 error correction characteristics table, version 3-M; reproduced at thonky.com/qr-code-tutorial/error-correction-table
BLOCK_LAYOUT_M	4	100,18,2,32,0,0	ISO/IEC 18004 error correction characteristics table, version 4-M; reproduced at thonky.com/qr-code-tutorial/error-correction-table
BLOCK_LAYOUT_M	5	134,24,2,43,0,0	ISO/IEC 18004 error correction characteristics table, version 5-M; reproduced at thonky.com/qr-code-tutorial/error-correction-table
BLOCK_LAYOUT_M	6	172,16,4,27,0,0	ISO/IEC 18004 error correction characteristics table, version 6-M; reproduced at thonky.com/qr-code-tutorial/error-correction-table
BLOCK_LAYOUT_M	7	196,18,4,31,0,0	ISO/IEC 18004 error correction characteristics table, version 7-M; reproduced at thonky.com/qr-code-tutorial/error-correction-table
BLOCK_LAYOUT_M	8	242,22,2,38,2,39	ISO/IEC 18004 error correction characteristics table, version 8-M; reproduced at thonky.com/qr-code-tutorial/error-correction-table
BLOCK_LAYOUT_M	9	292,22,3,36,2,37	ISO/IEC 18004 error correction characteristics table, version 9-M; reproduced at thonky.com/qr-code-tutorial/error-correction-table
BLOCK_LAYOUT_M	10	346,26,4,43,1,44	ISO/IEC 18004 error correction characteristics table, version 10-M; reproduced at thonky.com/qr-code-tutorial/error-correction-table
BYTE_CAPACITY_M	1	14	ISO/IEC 18004 character capacity table, byte mode, ECC level M; reproduced at thonky.com/qr-code-tutorial/character-capacities
BYTE_CAPACITY_M	2	26	ISO/IEC 18004 character capacity table, byte mode, ECC level M; reproduced at thonky.com/qr-code-tutorial/character-capacities
BYTE_CAPACITY_M	3	42	ISO/IEC 18004 character capacity table, byte mode, ECC level M; reproduced at thonky.com/qr-code-tutorial/character-capacities
BYTE_CAPACITY_M	4	62	ISO/IEC 18004 character capacity table, byte mode, ECC level M; reproduced at thonky.com/qr-code-tutorial/character-capacities
BYTE_CAPACITY_M	5	84	ISO/IEC 18004 character capacity table, byte mode, ECC level M; reproduced at thonky.com/qr-code-tutorial/character-capacities
BYTE_CAPACITY_M	6	106	ISO/IEC 18004 character capacity table, byte mode, ECC level M; reproduced at thonky.com/qr-code-tutorial/character-capacities
BYTE_CAPACITY_M	7	122	ISO/IEC 18004 character capacity table, byte mode, ECC level M; reproduced at thonky.com/qr-code-tutorial/character-capacities
BYTE_CAPACITY_M	8	152	ISO/IEC 18004 character capacity table, byte mode, ECC level M; reproduced at thonky.com/qr-code-tutorial/character-capacities
BYTE_CAPACITY_M	9	180	ISO/IEC 18004 character capacity table, byte mode, ECC level M; reproduced at thonky.com/qr-code-tutorial/character-capacities
BYTE_CAPACITY_M	10	213	ISO/IEC 18004 character capacity table, byte mode, ECC level M; reproduced at thonky.com/qr-code-tutorial/character-capacities
```

Then create `packages/invite/test/qr-tables.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/invite/test/qr-tables.test.ts`

Expected: FAIL — the module does not exist yet, so Vite cannot resolve the import and no test runs:

```
Error: Failed to resolve import "../src/qr-tables" from "packages/invite/test/qr-tables.test.ts". Does the file exist?
```

- [ ] **Step 3: Write the implementation**

Create `packages/invite/src/qr-tables.ts`:

```ts
// packages/invite/src/qr-tables.ts                                      PURE
//
// The published constants the QR encoder must agree with. Contract §4.8.
//
// Every value here is COMPUTED — BCH for the format information, polynomial
// multiplication over GF(256) for the generator polynomials, the published
// spacing rule for the alignment centres, module counting for the codeword
// totals — and asserted against a transcription of the published tables in
// packages/invite/vectors/qr-reference.tsv (§5.9). The one exception is the
// per-version block structure at ECC-M, which is table data in the standard with
// no formula behind it; the totalCodewords identity in the test is what keeps
// that transcription honest.

/** GF(256) with the QR Code primitive polynomial x^8 + x^4 + x^3 + x^2 + 1. */
const GF_EXP = new Uint8Array(512)
const GF_LOG = new Uint8Array(256)
{
  let x = 1
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x
    GF_LOG[x] = i
    x <<= 1
    if (x & 0x100) x ^= 0x11d
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255]
}

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0
  return GF_EXP[GF_LOG[a] + GF_LOG[b]]
}

/** BCH(15,5) generator, and the published XOR mask applied to every format
 *  string so that an all-zero one is not a valid code word. */
const FORMAT_GENERATOR = 0b10100110111
const FORMAT_XOR_MASK = 0b101010000010010
/** ECC level M is 00 in the two-bit level indicator. This encoder emits no other. */
const ECC_M_INDICATOR = 0b00

export function formatInfoBits(mask: number): number {
  if (!Number.isInteger(mask) || mask < 0 || mask > 7) {
    throw new RangeError(`mask out of range: ${mask}`)
  }
  const data = (ECC_M_INDICATOR << 3) | mask
  let rem = data << 10
  for (let i = 14; i >= 10; i--) {
    if (rem & (1 << i)) rem ^= FORMAT_GENERATOR << (i - 10)
  }
  return ((data << 10) | rem) ^ FORMAT_XOR_MASK
}

export function rsGeneratorPoly(ecCodewords: number): Uint8Array {
  if (!Number.isInteger(ecCodewords) || ecCodewords < 1 || ecCodewords > 30) {
    throw new RangeError(`ecCodewords out of range: ${ecCodewords}`)
  }
  // (x - a^0)(x - a^1)...(x - a^(n-1)), multiplied out. Subtraction is XOR here.
  let poly = new Uint8Array([1])
  for (let i = 0; i < ecCodewords; i++) {
    const next = new Uint8Array(poly.length + 1)
    const root = GF_EXP[i]
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j]
      next[j + 1] ^= gfMul(poly[j], root)
    }
    poly = next
  }
  return poly
}

export function alignmentCentres(version: number): readonly number[] {
  if (!Number.isInteger(version) || version < 1 || version > 40) {
    throw new RangeError(`version out of range: ${version}`)
  }
  if (version === 1) return []
  const count = Math.floor(version / 7) + 2
  const first = 6
  const last = 4 * version + 10
  if (count === 2) return [first, last]
  const step = Math.ceil((last - first) / (count - 1) / 2) * 2
  const out: number[] = [first]
  for (let i = count - 2; i >= 0; i--) out.push(last - i * step)
  return out
}

export interface QrBlockLayout {
  totalCodewords: number
  ecCodewordsPerBlock: number
  group1Blocks: number
  group1DataCodewords: number
  group2Blocks: number
  group2DataCodewords: number
}

/** ISO/IEC 18004's error correction characteristics for ECC level M, versions
 *  1..10, indexed by version - 1:
 *  [ecCodewordsPerBlock, group1Blocks, group1Data, group2Blocks, group2Data].
 *  Table data with no formula behind it — the only transcription in this file,
 *  and the test's totalCodewords identity is what proves it. */
const BLOCK_STRUCTURE_M: readonly (readonly [number, number, number, number, number])[] = [
  [10, 1, 16, 0, 0],
  [16, 1, 28, 0, 0],
  [26, 1, 44, 0, 0],
  [18, 2, 32, 0, 0],
  [24, 2, 43, 0, 0],
  [16, 4, 27, 0, 0],
  [18, 4, 31, 0, 0],
  [22, 2, 38, 2, 39],
  [22, 3, 36, 2, 37],
  [26, 4, 43, 1, 44],
]

/** Counted out of the symbol's own geometry: every module, minus the function
 *  patterns, the format information and (from version 7) the version
 *  information, divided by eight. Shares nothing with BLOCK_STRUCTURE_M. */
function totalCodewords(version: number): number {
  const size = 4 * version + 17
  // Three 8x8 finder-plus-separator corners.
  let functionModules = 3 * 64
  // Two timing patterns, between the separators.
  functionModules += 2 * (size - 16)
  // Format information: 15 modules twice, plus the always-dark module.
  functionModules += 31
  if (version >= 7) functionModules += 36
  const centres = alignmentCentres(version)
  if (centres.length > 0) {
    const k = centres.length
    // The three centres that fall on a finder carry no alignment pattern.
    const patterns = k * k - 3
    // Those on row 6 or column 6 overlap a timing pattern in five modules.
    const onTimingAxis = 2 * (k - 2)
    functionModules += 25 * patterns - 5 * onTimingAxis
  }
  return Math.floor((size * size - functionModules) / 8)
}

export function blockLayoutM(version: number): QrBlockLayout {
  if (!Number.isInteger(version) || version < 1 || version > BLOCK_STRUCTURE_M.length) {
    throw new RangeError(`version out of range for ECC-M layout: ${version}`)
  }
  const row = BLOCK_STRUCTURE_M[version - 1]
  return {
    totalCodewords: totalCodewords(version),
    ecCodewordsPerBlock: row[0],
    group1Blocks: row[1],
    group1DataCodewords: row[2],
    group2Blocks: row[3],
    group2DataCodewords: row[4],
  }
}

export function byteCapacityM(version: number): number {
  const layout = blockLayoutM(version)
  const dataCodewords =
    layout.group1Blocks * layout.group1DataCodewords +
    layout.group2Blocks * layout.group2DataCodewords
  // 4 bits of mode indicator, then the character count indicator: 8 bits for
  // versions 1..9 in byte mode, 16 from version 10.
  const cci = version <= 9 ? 8 : 16
  return Math.floor((dataCodewords * 8 - 4 - cci) / 8)
}
```

Then add one line to `packages/invite/src/index.ts`, keeping §4.8's order (`hex`, `uri`, `invite`, `t4t`, `reader`, `host`, `applinks`, `qr`, `qr-tables`):

```ts
export * from './qr-tables'
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/invite/test/qr-tables.test.ts`
Expected: all tests pass.

Run: `npm run typecheck --workspace @tapkart/invite`
Expected: no output, exit 0.

Run: `npm test`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add packages/invite/src/qr-tables.ts packages/invite/src/index.ts packages/invite/vectors/qr-reference.tsv packages/invite/test/qr-tables.test.ts && git commit -m "feat(invite): QR tables computed and checked against published vectors (F-P5-2)"
```
