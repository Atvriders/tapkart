// packages/invite/src/qr.ts                                             PURE
//
// A QR Code encoder: byte mode, ECC level M, versions 1..10. Contract §4.8,
// ruling F-P5-2. No dependency, because this is a frozen ISO specification and a
// dependency here would buy nothing and cost supply-chain surface in a repo
// whose entire runtime dependency list is `three` and `ws`.
//
// Every table this file needs is computed and published-checked in qr-tables.ts.
// Every symbol it produces is checked against vectors/qr-symbol.txt, which is
// NOT generated from this file.

import { alignmentCentres, blockLayoutM, byteCapacityM, formatInfoBits, rsGeneratorPoly } from './qr-tables'

/** Row-major, `size * size` bytes, 1 = dark. Quiet zone NOT included; the
 *  drawer adds QR_QUIET_ZONE modules of margin. */
export interface QrMatrix {
  size: number
  modules: Uint8Array
}

export const QR_QUIET_ZONE = 4
export const QR_ECC_LEVEL = 'M'
/** Versions above this are unreachable: §5.9's arithmetic proves the longest
 *  invite URI this game can build fits inside byteCapacityM(QR_MAX_VERSION). */
export const QR_MAX_VERSION = 10

/** Mode indicator for byte mode. The only mode this encoder emits. */
const MODE_BYTE = 0b0100
/** The two padding codewords the standard alternates once the data runs out. */
const PAD_A = 0xec
const PAD_B = 0x11

/** GF(256) multiplication, shift-and-xor against the QR primitive polynomial
 *  x^8 + x^4 + x^3 + x^2 + 1. Written out rather than imported because
 *  qr-tables.ts keeps its log tables private (§16 fixes that module at six
 *  exports) — and because two multipliers written differently cannot share a
 *  typo. */
function gfMul(a: number, b: number): number {
  let result = 0
  let x = a
  let y = b
  while (y > 0) {
    if (y & 1) result ^= x
    y >>= 1
    x <<= 1
    if (x & 0x100) x ^= 0x11d
  }
  return result
}

function chooseVersion(byteLength: number): number {
  for (let v = 1; v <= QR_MAX_VERSION; v++) {
    if (byteCapacityM(v) >= byteLength) return v
  }
  throw new RangeError(
    `text of ${byteLength} bytes exceeds QR version ${QR_MAX_VERSION} at ECC level ${QR_ECC_LEVEL}`,
  )
}

/** Mode indicator, character count, the bytes, a terminator, then the two
 *  alternating pad codewords up to the version's data capacity. */
function buildDataCodewords(data: Uint8Array, version: number): Uint8Array {
  const layout = blockLayoutM(version)
  const dataCodewords =
    layout.group1Blocks * layout.group1DataCodewords +
    layout.group2Blocks * layout.group2DataCodewords
  const cciBits = version <= 9 ? 8 : 16
  const out = new Uint8Array(dataCodewords)
  let bitPos = 0

  const push = (value: number, bits: number): void => {
    for (let i = bits - 1; i >= 0; i--) {
      if ((value >>> i) & 1) out[bitPos >> 3] |= 0x80 >>> (bitPos & 7)
      bitPos++
    }
  }

  push(MODE_BYTE, 4)
  push(data.length, cciBits)
  for (const b of data) push(b, 8)

  const capacityBits = dataCodewords * 8
  push(0, Math.min(4, capacityBits - bitPos))
  if (bitPos & 7) push(0, 8 - (bitPos & 7))
  let pad = PAD_A
  while (bitPos < capacityBits) {
    push(pad, 8)
    pad = pad === PAD_A ? PAD_B : PAD_A
  }
  return out
}

/** The Reed-Solomon check codewords for one block: the remainder of the block
 *  divided by the generator polynomial, over GF(256). */
function rsRemainder(block: Uint8Array, ecCodewords: number): Uint8Array {
  const generator = rsGeneratorPoly(ecCodewords)
  const remainder = new Uint8Array(ecCodewords)
  for (const b of block) {
    const factor = b ^ remainder[0]
    remainder.copyWithin(0, 1)
    remainder[ecCodewords - 1] = 0
    for (let i = 0; i < ecCodewords; i++) {
      remainder[i] ^= gfMul(generator[i + 1], factor)
    }
  }
  return remainder
}

/** Split into blocks, compute each block's check codewords, then interleave:
 *  the first codeword of every block, the second of every block, and so on,
 *  data first and error correction after. */
function interleave(dataCodewords: Uint8Array, version: number): Uint8Array {
  const layout = blockLayoutM(version)
  const blocks: Uint8Array[] = []
  const ecBlocks: Uint8Array[] = []
  let pos = 0

  const take = (count: number, size: number): void => {
    for (let i = 0; i < count; i++) {
      const block = dataCodewords.slice(pos, pos + size)
      pos += size
      blocks.push(block)
      ecBlocks.push(rsRemainder(block, layout.ecCodewordsPerBlock))
    }
  }
  take(layout.group1Blocks, layout.group1DataCodewords)
  take(layout.group2Blocks, layout.group2DataCodewords)

  const out = new Uint8Array(layout.totalCodewords)
  let o = 0
  const longest = Math.max(layout.group1DataCodewords, layout.group2DataCodewords)
  for (let i = 0; i < longest; i++) {
    for (const block of blocks) if (i < block.length) out[o++] = block[i]
  }
  for (let i = 0; i < layout.ecCodewordsPerBlock; i++) {
    for (const block of ecBlocks) out[o++] = block[i]
  }
  return out
}

const newMatrix = (size: number): QrMatrix => ({ size, modules: new Uint8Array(size * size) })
const at = (m: QrMatrix, x: number, y: number): number => m.modules[y * m.size + x]
const set = (m: QrMatrix, x: number, y: number, dark: boolean): void => {
  m.modules[y * m.size + x] = dark ? 1 : 0
}

/** Finders and their separators, the two timing patterns, the alignment
 *  patterns, the version information (from version 7) and the always-dark
 *  module. `reserved` marks every module the data placement must skip, which
 *  includes the format-information areas drawn later. */
function drawFunctionPatterns(m: QrMatrix, version: number, reserved: Uint8Array): void {
  const size = m.size

  const finder = (cx: number, cy: number): void => {
    for (let dy = -1; dy <= 7; dy++) {
      for (let dx = -1; dx <= 7; dx++) {
        const x = cx + dx
        const y = cy + dy
        if (x < 0 || x >= size || y < 0 || y >= size) continue
        const ring = Math.max(Math.abs(dx - 3), Math.abs(dy - 3))
        set(m, x, y, ring !== 2 && ring <= 3)
        reserved[y * size + x] = 1
      }
    }
  }
  finder(0, 0)
  finder(size - 7, 0)
  finder(0, size - 7)

  for (let i = 8; i < size - 8; i++) {
    set(m, i, 6, i % 2 === 0)
    reserved[6 * size + i] = 1
    set(m, 6, i, i % 2 === 0)
    reserved[i * size + 6] = 1
  }

  const centres = alignmentCentres(version)
  for (const cy of centres) {
    for (const cx of centres) {
      // The three centres that coincide with a finder carry no pattern.
      if ((cx === 6 && cy === 6) || (cx === 6 && cy === size - 7) || (cx === size - 7 && cy === 6)) {
        continue
      }
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const ring = Math.max(Math.abs(dx), Math.abs(dy))
          set(m, cx + dx, cy + dy, ring !== 1)
          reserved[(cy + dy) * size + cx + dx] = 1
        }
      }
    }
  }

  // Format information areas: reserved now, written once per mask later.
  for (let i = 0; i < 9; i++) {
    reserved[8 * size + i] = 1
    reserved[i * size + 8] = 1
  }
  for (let i = 0; i < 8; i++) {
    reserved[8 * size + (size - 1 - i)] = 1
    reserved[(size - 1 - i) * size + 8] = 1
  }
  set(m, 8, size - 8, true)
  reserved[(size - 8) * size + 8] = 1

  if (version >= 7) {
    // 18 bits: six version bits and a BCH(18,6) remainder, in two 3x6 blocks.
    let remainder = version << 12
    for (let i = 17; i >= 12; i--) {
      if (remainder & (1 << i)) remainder ^= 0x1f25 << (i - 12)
    }
    const bits = (version << 12) | remainder
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >> i) & 1) === 1
      const a = size - 11 + (i % 3)
      const b = Math.floor(i / 3)
      set(m, a, b, dark)
      reserved[b * size + a] = 1
      set(m, b, a, dark)
      reserved[a * size + b] = 1
    }
  }
}

/** The zigzag: two-module columns from the right edge leftwards, skipping the
 *  vertical timing column, alternating upward and downward. */
function placeData(m: QrMatrix, codewords: Uint8Array, reserved: Uint8Array): void {
  const size = m.size
  const totalBits = codewords.length * 8
  let bit = 0
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j
        const upward = ((right + 1) & 2) === 0
        const y = upward ? size - 1 - vert : vert
        if (reserved[y * size + x]) continue
        if (bit < totalBits) {
          set(m, x, y, ((codewords[bit >> 3] >>> (7 - (bit & 7))) & 1) === 1)
        }
        bit++
      }
    }
  }
}

/** The eight published data mask patterns, as (x, y) predicates. */
const MASK_FNS: readonly ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
]

function applyMask(m: QrMatrix, mask: number, reserved: Uint8Array): void {
  const fn = MASK_FNS[mask]
  for (let y = 0; y < m.size; y++) {
    for (let x = 0; x < m.size; x++) {
      if (reserved[y * m.size + x]) continue
      if (fn(x, y)) m.modules[y * m.size + x] ^= 1
    }
  }
}

/** Both copies of the 15 format bits, in their published positions. */
function drawFormatInfo(m: QrMatrix, mask: number): void {
  const size = m.size
  const bits = formatInfoBits(mask)
  for (let i = 0; i <= 5; i++) set(m, 8, i, ((bits >> i) & 1) === 1)
  set(m, 8, 7, ((bits >> 6) & 1) === 1)
  set(m, 8, 8, ((bits >> 7) & 1) === 1)
  set(m, 7, 8, ((bits >> 8) & 1) === 1)
  for (let i = 9; i <= 14; i++) set(m, 14 - i, 8, ((bits >> i) & 1) === 1)
  for (let i = 0; i <= 7; i++) set(m, size - 1 - i, 8, ((bits >> i) & 1) === 1)
  for (let i = 8; i <= 14; i++) set(m, 8, size - 15 + i, ((bits >> i) & 1) === 1)
}

/** The four published penalty rules. Lower is better. */
function penalty(m: QrMatrix): number {
  const size = m.size
  let score = 0

  // Rule 1: runs of five or more same-coloured modules in a row or column.
  for (let i = 0; i < size; i++) {
    let rowColour = -1
    let rowRun = 0
    let colColour = -1
    let colRun = 0
    for (let j = 0; j < size; j++) {
      const rowValue = at(m, j, i)
      if (rowValue === rowColour) rowRun++
      else {
        rowColour = rowValue
        rowRun = 1
      }
      if (rowRun === 5) score += 3
      else if (rowRun > 5) score += 1

      const colValue = at(m, i, j)
      if (colValue === colColour) colRun++
      else {
        colColour = colValue
        colRun = 1
      }
      if (colRun === 5) score += 3
      else if (colRun > 5) score += 1
    }
  }

  // Rule 2: every 2x2 block of one colour.
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const v = at(m, x, y)
      if (v === at(m, x + 1, y) && v === at(m, x, y + 1) && v === at(m, x + 1, y + 1)) score += 3
    }
  }

  // Rule 3: the 1:1:3:1:1 finder-like pattern with four light modules on one
  // side, in either orientation, in any row or column.
  const A = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0]
  const B = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1]
  const matches = (read: (k: number) => number, start: number, pattern: number[]): boolean => {
    for (let k = 0; k < 11; k++) if (read(start + k) !== pattern[k]) return false
    return true
  }
  for (let i = 0; i < size; i++) {
    const row = (k: number): number => at(m, k, i)
    const col = (k: number): number => at(m, i, k)
    for (let j = 0; j + 11 <= size; j++) {
      if (matches(row, j, A)) score += 40
      if (matches(row, j, B)) score += 40
      if (matches(col, j, A)) score += 40
      if (matches(col, j, B)) score += 40
    }
  }

  // Rule 4: how far the proportion of dark modules is from 50%, in steps of 5.
  // The published rule takes the previous and next multiple of five and keeps
  // the SMALLER deviation; in integer arithmetic that is exactly this, with no
  // floating point to go wrong on a boundary.
  let dark = 0
  for (const v of m.modules) dark += v
  const total = size * size
  score += 10 * Math.floor((10 * Math.abs(2 * dark - total)) / total)

  return score
}

/** Byte mode, ECC level M, smallest version that fits, mask chosen by the
 *  published penalty rules. Throws above QR_MAX_VERSION. */
export function buildQrMatrix(text: string): QrMatrix {
  const data = new TextEncoder().encode(text)
  const version = chooseVersion(data.length)
  const codewords = interleave(buildDataCodewords(data, version), version)
  const size = 4 * version + 17

  let best = newMatrix(size)
  let bestScore = Number.POSITIVE_INFINITY
  for (let mask = 0; mask < 8; mask++) {
    const candidate = newMatrix(size)
    const reserved = new Uint8Array(size * size)
    drawFunctionPatterns(candidate, version, reserved)
    placeData(candidate, codewords, reserved)
    applyMask(candidate, mask, reserved)
    drawFormatInfo(candidate, mask)
    const score = penalty(candidate)
    // Strictly less, so a tie keeps the lower mask number.
    if (score < bestScore) {
      best = candidate
      bestScore = score
    }
  }
  return best
}

/** `false` outside the matrix: the drawer loops over the quiet zone, and the
 *  quiet zone is light. */
export function qrModuleAt(m: QrMatrix, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= m.size || y >= m.size) return false
  return m.modules[y * m.size + x] === 1
}
