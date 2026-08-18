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
