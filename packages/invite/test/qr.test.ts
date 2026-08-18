import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { LOBBY_PATH_PREFIX, ROOM_CODE_LENGTH } from '@tapkart/protocol'
import { describe, expect, it } from 'vitest'
import { MAX_INVITE_ORIGIN_BYTES } from '../src/invite'
import {
  QR_ECC_LEVEL,
  QR_MAX_VERSION,
  QR_QUIET_ZONE,
  buildQrMatrix,
  qrModuleAt,
} from '../src/qr'

const SYMBOLS_FILE = fileURLToPath(new URL('../vectors/qr-symbol.txt', import.meta.url))
const TABLES_FILE = fileURLToPath(new URL('../vectors/qr-reference.tsv', import.meta.url))

interface RefSymbol {
  name: string
  version: number
  mask: number
  compare: 'full' | 'function'
  text: string
  grid: string[]
}

function readSymbols(): RefSymbol[] {
  const out: RefSymbol[] = []
  const lines = readFileSync(SYMBOLS_FILE, 'utf8').split('\n')
  let i = 0
  while (i < lines.length) {
    const line = lines[i].replace(/\r$/, '')
    i++
    if (line.length === 0 || line.startsWith('#')) continue
    if (!line.startsWith('SYMBOL ')) throw new Error(`qr-symbol.txt: unexpected line: ${line}`)
    const [, name, version, mask, compare, ...rest] = line.split(' ')
    if (compare !== 'full' && compare !== 'function') {
      throw new Error(`qr-symbol.txt: ${name}: unknown compare mode ${compare}`)
    }
    const size = 4 * Number(version) + 17
    const grid: string[] = []
    for (let row = 0; row < size; row++) {
      grid.push(lines[i].replace(/\r$/, ''))
      i++
    }
    if (lines[i].replace(/\r$/, '') !== 'END') {
      throw new Error(`qr-symbol.txt: ${name}: expected END after ${size} rows, got ${lines[i]}`)
    }
    i++
    out.push({
      name,
      version: Number(version),
      mask: Number(mask),
      compare,
      text: rest.join(' '),
      grid,
    })
  }
  return out
}

const SYMBOLS = readSymbols()

/** The published byte-mode ECC-M capacities, read from the transcribed table —
 *  §5.9 layer 3: "The test reads the capacity from the transcribed table; it
 *  does not trust any capacity written in prose." */
function publishedByteCapacity(version: number): number {
  for (const raw of readFileSync(TABLES_FILE, 'utf8').split('\n')) {
    const parts = raw.replace(/\r$/, '').split('\t')
    if (parts[0] === 'BYTE_CAPACITY_M' && Number(parts[1]) === version) return Number(parts[2])
  }
  throw new Error(`qr-reference.tsv: no BYTE_CAPACITY_M row for version ${version}`)
}

const gridOf = (m: { size: number; modules: Uint8Array }): string[] => {
  const rows: string[] = []
  for (let y = 0; y < m.size; y++) {
    let row = ''
    for (let x = 0; x < m.size; x++) row += m.modules[y * m.size + x] === 1 ? '#' : '.'
    rows.push(row)
  }
  return rows
}

/** True for a module the data placement never touches: the three finder
 *  corners with their separators and format areas, and the two timing lines. */
const isFunctionModule = (size: number, x: number, y: number): boolean =>
  (x < 9 && y < 9) || (x >= size - 8 && y < 9) || (x < 9 && y >= size - 8) || x === 6 || y === 6

describe('qr-symbol.txt', () => {
  it('yields symbols at all — an empty vector file must fail, not pass', () => {
    expect(SYMBOLS.length).toBeGreaterThan(0)
    expect(SYMBOLS.some((s) => s.compare === 'full')).toBe(true)
    expect(SYMBOLS.some((s) => s.compare === 'function')).toBe(true)
  })

  it('is well formed: square grids of the declared size, only # and .', () => {
    for (const s of SYMBOLS) {
      const size = 4 * s.version + 17
      expect(s.grid, s.name).toHaveLength(size)
      for (const row of s.grid) {
        expect(row, s.name).toHaveLength(size)
        expect(/^[#.]+$/.test(row), `${s.name}: ${row}`).toBe(true)
      }
    }
  })
})

describe('buildQrMatrix against published symbols', () => {
  for (const s of SYMBOLS.filter((x) => x.compare === 'full')) {
    it(`reproduces ${s.name} module for module`, () => {
      const m = buildQrMatrix(s.text)
      expect(m.size).toBe(4 * s.version + 17)
      expect(m.modules).toHaveLength(m.size * m.size)
      expect(gridOf(m)).toEqual(s.grid)
    })
  }

  for (const s of SYMBOLS.filter((x) => x.compare === 'function')) {
    it(`matches ${s.name}'s function patterns and format information`, () => {
      const partners = SYMBOLS.filter(
        (x) => x.compare === 'full' && x.version === s.version && x.mask === s.mask,
      )
      // Without a partner this test would silently prove nothing.
      expect(partners.length, `${s.name}: no 'full' symbol at version ${s.version} mask ${s.mask}`)
        .toBeGreaterThan(0)
      for (const partner of partners) {
        const grid = gridOf(buildQrMatrix(partner.text))
        const size = 4 * s.version + 17
        const mismatches: string[] = []
        for (let y = 0; y < size; y++) {
          for (let x = 0; x < size; x++) {
            if (!isFunctionModule(size, x, y)) continue
            if (grid[y][x] !== s.grid[y][x]) mismatches.push(`(${x},${y})`)
          }
        }
        expect(mismatches, `${partner.name} vs ${s.name}`).toEqual([])
      }
    })
  }
})

describe('buildQrMatrix structure', () => {
  const sample = 'https://tapkart.example/r/ABCDE'

  it('is a square of 4 * version + 17 modules', () => {
    for (let v = 1; v <= QR_MAX_VERSION; v++) {
      const m = buildQrMatrix('A'.repeat(publishedByteCapacity(v)))
      expect(m.size).toBe(4 * v + 17)
      expect(m.modules).toHaveLength(m.size * m.size)
    }
  })

  it('carries a finder pattern at three corners and not the fourth', () => {
    const m = buildQrMatrix(sample)
    const finderAt = (ox: number, oy: number): boolean => {
      for (let dy = 0; dy < 7; dy++) {
        for (let dx = 0; dx < 7; dx++) {
          const ring = Math.max(Math.abs(dx - 3), Math.abs(dy - 3))
          const expected = ring !== 2 && ring <= 3
          if (qrModuleAt(m, ox + dx, oy + dy) !== expected) return false
        }
      }
      return true
    }
    expect(finderAt(0, 0)).toBe(true)
    expect(finderAt(m.size - 7, 0)).toBe(true)
    expect(finderAt(0, m.size - 7)).toBe(true)
    expect(finderAt(m.size - 7, m.size - 7)).toBe(false)
  })

  it('carries alternating timing patterns on row 6 and column 6', () => {
    const m = buildQrMatrix(sample)
    for (let i = 8; i < m.size - 8; i++) {
      expect(qrModuleAt(m, i, 6), `row 6 at ${i}`).toBe(i % 2 === 0)
      expect(qrModuleAt(m, 6, i), `column 6 at ${i}`).toBe(i % 2 === 0)
    }
  })

  it('carries the always-dark module below the top-left format block', () => {
    const m = buildQrMatrix(sample)
    expect(qrModuleAt(m, 8, m.size - 8)).toBe(true)
  })

  it('leaves the separator ring around each finder light', () => {
    const m = buildQrMatrix(sample)
    for (let i = 0; i < 8; i++) {
      expect(qrModuleAt(m, i, 7), `top-left separator row at ${i}`).toBe(false)
      expect(qrModuleAt(m, 7, i), `top-left separator column at ${i}`).toBe(false)
    }
  })
})

describe('version selection', () => {
  it('picks the smallest version whose published capacity fits', () => {
    for (let v = 1; v <= QR_MAX_VERSION; v++) {
      const exact = buildQrMatrix('A'.repeat(publishedByteCapacity(v)))
      expect(exact.size, `version ${v} at capacity`).toBe(4 * v + 17)
      if (v < QR_MAX_VERSION) {
        const overflow = buildQrMatrix('A'.repeat(publishedByteCapacity(v) + 1))
        expect(overflow.size, `version ${v} at capacity + 1`).toBeGreaterThan(4 * v + 17)
      }
    }
  })

  it('measures the text in UTF-8 BYTES, not characters', () => {
    // 'é' is two bytes. 106 of them is 212 bytes and fits version 10; 107 is
    // 214 bytes and does not. A character-counting encoder passes the first and
    // silently truncates or throws on the second at the wrong boundary.
    expect(buildQrMatrix('é'.repeat(106)).size).toBe(4 * QR_MAX_VERSION + 17)
    expect(() => buildQrMatrix('é'.repeat(107))).toThrow()
  })

  it('throws above QR_MAX_VERSION rather than emitting an unreadable symbol', () => {
    const tooLong = 'A'.repeat(publishedByteCapacity(QR_MAX_VERSION) + 1)
    expect(() => buildQrMatrix(tooLong)).toThrow(RangeError)
  })

  it('encodes an empty string without throwing', () => {
    const m = buildQrMatrix('')
    expect(m.size).toBe(21)
  })
})

describe('qrModuleAt', () => {
  const m = buildQrMatrix('PagedOut!')

  it('reads row-major out of `modules`', () => {
    for (let y = 0; y < m.size; y++) {
      for (let x = 0; x < m.size; x++) {
        expect(qrModuleAt(m, x, y)).toBe(m.modules[y * m.size + x] === 1)
      }
    }
  })

  it('reports light outside the symbol, because that is the quiet zone', () => {
    expect(qrModuleAt(m, -1, 0)).toBe(false)
    expect(qrModuleAt(m, 0, -1)).toBe(false)
    expect(qrModuleAt(m, m.size, 0)).toBe(false)
    expect(qrModuleAt(m, 0, m.size)).toBe(false)
    expect(qrModuleAt(m, -QR_QUIET_ZONE, -QR_QUIET_ZONE)).toBe(false)
  })
})

describe('constants', () => {
  it('emits ECC level M and nothing else', () => {
    expect(QR_ECC_LEVEL).toBe('M')
  })

  it('carries the standard four-module quiet zone', () => {
    expect(QR_QUIET_ZONE).toBe(4)
  })

  it('caps at version 10', () => {
    expect(QR_MAX_VERSION).toBe(10)
  })
})

describe('§5.9 layer 3 — the longest invite URI this game can build fits', () => {
  it('stays inside the published capacity of QR_MAX_VERSION', () => {
    // Every term is imported: two from @tapkart/protocol, one from invite, one
    // read from the transcribed published table. The day Plan 4 lengthens a room
    // code or renames the prefix, this says so — instead of a phone failing to
    // scan a code nobody tested at full length.
    const longest = MAX_INVITE_ORIGIN_BYTES + LOBBY_PATH_PREFIX.length + ROOM_CODE_LENGTH
    expect(longest).toBeLessThanOrEqual(publishedByteCapacity(QR_MAX_VERSION))
  })

  it('actually encodes a URI of that length', () => {
    // The arithmetic above is necessary but not sufficient: prove the encoder
    // really produces a symbol for the worst case rather than throwing.
    const origin = `https://${'a'.repeat(MAX_INVITE_ORIGIN_BYTES - 'https://'.length)}`
    const longest = `${origin}${LOBBY_PATH_PREFIX}${'A'.repeat(ROOM_CODE_LENGTH)}`
    expect(longest.length).toBe(MAX_INVITE_ORIGIN_BYTES + LOBBY_PATH_PREFIX.length + ROOM_CODE_LENGTH)
    const m = buildQrMatrix(longest)
    expect(m.size).toBeLessThanOrEqual(4 * QR_MAX_VERSION + 17)
  })
})
