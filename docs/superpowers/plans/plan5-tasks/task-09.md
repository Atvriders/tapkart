### Task 9: `packages/invite/src/qr.ts` — the byte-mode ECC-M encoder, PURE

**Files:**
- Create: `packages/invite/src/qr.ts`
- Create: `packages/invite/vectors/qr-symbol.txt`
- Modify: `packages/invite/src/index.ts` — one `export *` line
- Test: `packages/invite/test/qr.test.ts`

The whole encoder, in one task, because it is one pipeline: bytes → bit stream → data codewords → Reed–Solomon over GF(256) → interleaved codewords → module placement → mask selection → format information. There is no seam in the middle where half of it could be tested, because §16's census fixes this module at **six exports** and none of them is an intermediate. A task that stopped at "codewords" would have to export them to test them, and that is a contract amendment for the sake of a task boundary.

Why we write it rather than install it, in F-P5-2's own words:

> Byte mode, ECC-M, Reed–Solomon over GF(256), masking, format info. Several hundred lines — and every one of them pure, fully testable, and implementing an **ISO spec that has not changed since 2006 and will not.** A dependency here buys nothing and costs supply-chain surface in a repo whose entire runtime dependency list is `three` and `ws`.

**The trap this task exists to avoid, stated before the code.** F-P5-2 again:

> **Test against published reference vectors**, never against the encoder's own output. A QR encoder that round-trips with itself and produces a code no phone can read is exactly this project's signature defect in a new costume.

That failure is worse here than anywhere else in the plan, because **the only person who can detect it is a human holding a phone.** A self-consistent encoder produces a beautiful square, a green suite, and a QR nobody can scan — and spec §2 makes QR one of the three ways *"nobody is ever blocked from joining"*, so the fallback for the fallback would be quietly broken. §14 lists *"That the QR scans"* as owner-verified for the camera, the screen and the light; everything up to the modules is CI's job and this task does it against published data:

| Layer | What is published | Where it is checked |
|---|---|---|
| Format information, generator polynomials, alignment centres, block layout, capacities | ISO/IEC 18004 tables | Task 8, `vectors/qr-reference.tsv` |
| The version-1 function patterns and both copies of the ECC-M mask-2 format information | ISO/IEC 18004 Annex I's worked symbol | this task, `qr-symbol.txt` symbol `annexI` |
| The 16 data codewords of a byte-mode ECC-M version-1 symbol | the ZX81 worked example | this task, cited in `qr-symbol.txt`'s header for symbol `pagedout` |
| The complete module grid of three byte-mode ECC-M symbols, at versions 1, 3 and 10 | two independent implementations, one independent decoder | this task, `qr-symbol.txt` symbols `pagedout`, `invite` and `longest` |

Version 10 is in that list on purpose. Versions 1 and 3 exercise neither of the two things that only exist higher up — the **version-information blocks** from version 7, and the **16-bit character count indicator** at version 10 — and a symbol set that stops at version 3 would let a transposed version-information block through CI and out to a phone. It is also the only one of the three with two block groups.

**Interfaces:**

- **Consumes** — `packages/invite/src/qr-tables.ts` (Task 8), quoted:

  ```ts
  export function formatInfoBits(mask: number): number
  export function rsGeneratorPoly(ecCodewords: number): Uint8Array
  export function alignmentCentres(version: number): readonly number[]
  export interface QrBlockLayout {
    totalCodewords: number
    ecCodewordsPerBlock: number
    group1Blocks: number
    group1DataCodewords: number
    group2Blocks: number
    group2DataCodewords: number
  }
  export function blockLayoutM(version: number): QrBlockLayout
  export function byteCapacityM(version: number): number
  ```

  **`gfMul` is not among them.** Task 8's module keeps its GF(256) multiplication private because §16 fixes it at six exports, so this module carries its own — six lines of shift-and-xor rather than a copy of Task 8's log tables. Two multipliers written differently cannot share a typo, and both are anchored to published vectors.

  `TextEncoder` is an ES2022 global in Node ≥ 20 and every target browser, so this module needs no DOM lib and adds no dependency — which matters, because `packages/invite` is imported by `packages/server` through `@tapkart/invite` and ruling R35 keeps DOM out of that import closure.

  The test additionally reads **Task 8's vector file**, `packages/invite/vectors/qr-reference.tsv`, for its `BYTE_CAPACITY_M` rows — §5.9 layer 3 is explicit that *"The test reads the capacity from the transcribed table; it does not trust any capacity written in prose here"*, and that rules out calling `byteCapacityM` for the same purpose. It also consumes, for the same arithmetic:

  ```ts
  // @tapkart/protocol — Plan 4 owns these (C-1, C-7, F-P4-34)
  export const LOBBY_PATH_PREFIX = '/r/'
  export const ROOM_CODE_LENGTH = 5

  // packages/invite/src/invite.ts — §4.3
  /** Origin cap, so `buildInviteUri` can never produce an un-encodable record and
   *  can never exceed the QR version cap. §5.9 does that arithmetic as a test. */
  export const MAX_INVITE_ORIGIN_BYTES = 200
  ```

- **Produces** — contract §4.8, exactly six exports and not a seventh (§16's census fixes `invite/qr` at 6):

  ```ts
  /** Row-major, `size * size` bytes, 1 = dark. Quiet zone NOT included; the
   *  drawer adds QR_QUIET_ZONE modules of margin. */
  export interface QrMatrix { size: number; modules: Uint8Array }
  export const QR_QUIET_ZONE = 4
  export const QR_ECC_LEVEL = 'M'
  /** Versions above this are unreachable: §5.9's arithmetic proves the longest
   *  invite URI this game can build fits inside byteCapacityM(QR_MAX_VERSION). */
  export const QR_MAX_VERSION = 10

  /** Byte mode, ECC level M, smallest version that fits, mask chosen by the
   *  published penalty rules. Throws above QR_MAX_VERSION. */
  export function buildQrMatrix(text: string): QrMatrix
  export function qrModuleAt(m: QrMatrix, x: number, y: number): boolean
  ```

  Six: `QrMatrix`, `QR_QUIET_ZONE`, `QR_ECC_LEVEL`, `QR_MAX_VERSION`, `buildQrMatrix`, `qrModuleAt`. **`QrMatrix` has exactly two fields** — no `version`, no `mask`. The mask is a local of the selection loop; adding it to the returned object would be adding a field to a contract type.

**Two behaviours this task decides, because the contract does not and a reviewer would otherwise guess:**

1. **`qrModuleAt` returns `false` outside the matrix rather than throwing.** The drawer adds `QR_QUIET_ZONE` modules of margin, so it loops over a region larger than the symbol; the quiet zone is light, which is exactly `false`. Throwing would force every caller to write the bounds check the accessor exists to own.
2. **Penalty rule 4 uses the published "previous and next multiple of five" rule, exactly**, and a penalty tie keeps the **lower** mask number. ISO/IEC 18004's rule 4: take the percentage of dark modules, take the previous and next multiples of five, subtract 50 from each, take the absolute values, divide by five, take **the smaller**, multiply by 10. In integer arithmetic that is `10 * floor(10 * |2*dark − total| / total)`, which is exact at the boundaries where floating point is not. This is spelled out because a well-known third-party implementation (`node-qrcode` 1.5.4) uses `|ceil(pct/5) − 10|` instead, which over-penalises any symbol just **above** 50 % dark and picks a different mask for some inputs, and a reviewer comparing against that library would "fix" this in the wrong direction.

   **Be clear about what is and is not at stake in that paragraph.** The chosen mask is recorded in the symbol's own format information, so *every* mask produces a decodable symbol: rule 4 and the tie-break decide **which valid symbol is emitted, never whether it is valid.** No reference vector can pin them — pinning them would mean transcribing this encoder's own preference, which is the tautology F-P5-2 forbids. So they are written to the standard, and the vectors below happen to be inputs where the two formulations agree. If a future change makes a vector fail *only* by selecting a different mask, that is the one failure worth re-reading this note before "fixing".

---

- [ ] **Step 1: Write the failing test**

Create `packages/invite/vectors/qr-symbol.txt` first — it is the test's input, not its output:

```
# qr-symbol.txt — version 1
#
# Reference symbols for packages/invite/src/qr.ts. Contract §5.9 layer 2.
#
# F-P5-2: "Test against published reference vectors, never against the encoder's
# own output." NEVER regenerate this file with buildQrMatrix: the moment you do,
# every test below becomes a tautology and the one defect that matters — a
# beautiful square no camera can read — becomes invisible to CI.
#
# Format, line-oriented like the other vector files (§5.8):
#   SYMBOL <name> <version> <mask> <compare> <text>
#   <4*version+17 lines of grid, '#' dark and '.' light>
#   END
# compare = full     : buildQrMatrix(text) must equal the grid module for module
# compare = function : text is '-'; the grid's function-pattern and format
#                      modules must equal those of every 'full' symbol with the
#                      same version and mask (and there must be at least one)
#
# --- Provenance, per symbol -------------------------------------------------
#
# annexI  ISO/IEC 18004 Annex I, "Symbol encoding example": the version 1-M
#         symbol encoding 01234567, mask 2. Its mode is NUMERIC, so this
#         byte-mode encoder cannot reproduce its data region — but the finder
#         patterns, separators, timing patterns, dark module and BOTH copies of
#         the format information depend only on (version, ECC level, mask), and
#         those are what this symbol pins. Grid transcribed from the ASCII
#         matrix in kennytm/qrcode-rust's `test_annex_i_qr`
#         (github.com/kennytm/qrcode-rust, src/lib.rs) — an independent
#         implementation's transcription of that figure. Both copies of its
#         format information read 101111001111100, which is the string
#         ISO/IEC 18004 prints for ECC level M, mask 2, and which
#         formatInfoBits(2) computes.
#
# pagedout  Byte mode, ECC-M, version 1. Its sixteen DATA CODEWORDS are
#         published in A. Leiradella, "QR Codes on the ZX81" (2020-08-02),
#         leiradel.github.io/2020/08/02/QR-Codes-on-the-ZX81.html, as
#         40 95 06 22 76 56 44 F7 57 42 10 EC 11 EC 11 EC — and the same
#         article publishes the ten-EC generator polynomial that
#         vectors/qr-reference.tsv also carries. The article fixes mask 0 for
#         the ZX81's sake; this symbol carries mask 2, the mask the published
#         penalty rules select, so the grid below is NOT copied from that
#         article's figures. It was produced by node-qrcode 1.5.4
#         (github.com/soldair/node-qrcode), an independent implementation, as
#         QRCode.create([{data:'PagedOut!',mode:'byte'}],{errorCorrectionLevel:'M'})
#         and decoded back to "PagedOut!" by jsQR 1.4.0, a port of ZXing's
#         decoder. Neither library is a dependency of this repository; both were
#         run once, during authoring, to produce and check this file.
#
# invite  The exact string the lobby displays for the placeholder deployment
#         (§1): https://tapkart.example/r/ABCDE — byte mode, ECC-M, version 3,
#         and the published penalty rules select mask 6. Same provenance as
#         pagedout: the grid was produced by node-qrcode 1.5.4 and decoded back
#         to the same string by jsQR 1.4.0. It is here because a symbol at a
#         second version, with a second character-count width and a real
#         payload, is the one the product actually shows.
#
# longest The LONGEST invite URI this game can build: an origin of exactly
#         MAX_INVITE_ORIGIN_BYTES bytes, LOBBY_PATH_PREFIX and a five-character
#         room code — 208 bytes, which lands on version 10, the cap. It is here
#         because versions 1 and 3 exercise neither of the two things that only
#         appear higher up: the VERSION INFORMATION blocks (version 7 and above)
#         and the 16-bit character count indicator (version 10). Version 10 is
#         also the only one of these four with two block groups. Same
#         provenance: node-qrcode 1.5.4 produced the grid and jsQR 1.4.0 read it
#         back.
#
SYMBOL annexI 1 2 function -
#######..#.##.#######
#.....#..####.#.....#
#.###.#.#.....#.###.#
#.###.#.##....#.###.#
#.###.#.#.###.#.###.#
#.....#.#...#.#.....#
#######.#.#.#.#######
........#..##........
#.#####..#..#.#####..
...#.#.##.#.#..#.##..
..#...##.#.#.#..#####
....#....#.....####..
...######..#.#..#....
........#.#####..##..
#######..##.#.##.....
#.....#.#.#####...#.#
#.###.#.#...#..#.##..
#.###.#.##..#..#.....
#.###.#.#.##.#..#.#..
#.....#........##.##.
#######.####.#..#.#..
END
SYMBOL pagedout 1 2 full PagedOut!
#######..##...#######
#.....#...#...#.....#
#.###.#.#.#.#.#.###.#
#.###.#.#####.#.###.#
#.###.#.##..#.#.###.#
#.....#.#..#..#.....#
#######.#.#.#.#######
........#.#..........
#.#####....#..#####..
..#....#.#####..#.#.#
.######.#.#.#....###.
...###.######....##..
#..####.#...#.#......
........#.#.#...####.
#######..#.#.#...#.#.
#.....#.###.....####.
#.###.#.#.##....#...#
#.###.#.#.######.##..
#.###.#.#...#.#..##..
#.....#..#.#####.##..
#######.#...#......#.
END
SYMBOL invite 3 6 full https://tapkart.example/r/ABCDE
#######.#..#.###.##...#######
#.....#.#....###...##.#.....#
#.###.#.#.#####....##.#.###.#
#.###.#..##...##.####.#.###.#
#.###.#.##...#.#..##..#.###.#
#.....#..#.#.##.......#.....#
#######.#.#.#.#.#.#.#.#######
.........####.#....##........
#..######...######.###..#.###
..###.........#....#...##.##.
#...###.#..#..#...#..#....#..
#.#....#.#..#.##.##.####.#..#
.#.##.##.###.##...#.#.##....#
###.##.##.#......##..########
.#.##.##.##...##.#.####.#.#.#
..####.#.....##.#...#...#.#.#
..#.####..#....#.#..#....#...
#.###..#.##.#....#####..#.##.
##.#..##.#.####.#####.#.##..#
####...#####.#.##..##...###..
#####.##.#.#.#..#...########.
........##...#..#.###...##...
#######.####.#.##.###.#.##...
#.....#.#..#.#...####...#..#.
#.###.#.#..#.#.###.#######...
#.###.#.#.....#.#.#.#......#.
#.###.#..#..#######..#.##.###
#.....#..#.#.##......#..###.#
#######.#.#.#.##.#.####.##...
END
SYMBOL longest 10 1 full https://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/r/ABCDE
#######.#...#.##.#..##..#.#.#.#.#.#.#.#.#.#.####..#######
#.....#..###..#..#.....#..#...#...#...#...#..#.#..#.....#
#.###.#.#.##.###.#.#..######.###.###.###.###.###..#.###.#
#.###.#.....#.##.#...#..##.#.#...#.#.#.#.#.#.#.#..#.###.#
#.###.#..#....##..#.##..########..#.#.#.#.#.#..#..#.###.#
#.....#.######...#..#..#.##...#...#...#...#...#...#.....#
#######.#.#.#.#.#.#.#.#.#.#.#.#.#.#.#.#.#.#.#.#.#.#######
.........#..###.###.##...##...#.#...#...#...#............
#.#...##.###.####..#####.######.#.#.#.#.#.#.#.##...#..#.#
.#..#..##.#.#...#.##.#.#...#.#.#.#.#.#.#.#.#.#.#.#.#....#
..##..#.#...##....##....#.####.###.###.###.###..##.##.#.#
#####..###..####.##.#.#..#......#...#...#...#.......##.#.
#####.#.####.##.#..##..###..#.#.#.#.#.#.#.#.#.##..#.##.##
##...#.##.#.#..##.##...###.###.#.#.#.#.#.#.#.#.#.#.#....#
..#####.##..#.##..##.###.#####.###.###.###.###..##.##.#.#
######.###..###.###.##.###..#...#...#...#...#.......##...
##.#..#.#.##..###..#####.##.#.#.#.#.#.#.#.#.#.##....##.##
##.###.##.#.#####.#.#.##...#.#.#.#.#.#.#.#.#.#.#...#....#
...##.#.##..#.#..###.##.#.####.###.###.###.###..#..##.#.#
##..##..###.###...###.#..#..###.#...#...#...#......###.#.
##.#.##.##.##.###.##...#.#..#...#.#.#.#.#.#.#.##..#.##.##
##.#.#..#.#.#####..#####...#.#.#.#.#.#.#.#.#.#.#.#....#.#
#..#.##.#.#...#..#.#.##.#.########.###.###.###...#.####.#
.#..##.########..####.#..#..#..##...#...#...#..##...##.#.
#..#.###.#....####.....#.#..#.#.#.#.#.#.#.#.#.##..#.#..##
...#.#.#####.####.######...#.#.###.#.#.#.#.#.#.#.#.#....#
##.######.####.....####.#######..#.###.###.###..#####.#.#
#...#...####..#..###..#..##...#.#...#...#...#...#...##.#.
#.###.#.##.#..#.#.#....#.##.#.#.#.#.#.#.#.#.#.###.#.##.##
###.#...###..##..#.#####.##...##.#.#.#.#.#.#.#..#...#...#
.########.#....#...###..#.########.###.###.###.######.#.#
.#.##....#######.###..........#.#...#...#...#..##.#..#.#.
#.....##.#.#......#..##.####.##.#.#.#.#.#.#.#.##.###.#.##
##..#..#.##......#.####...##.#.#.#.#.#.#.#.#.#...#.#...#.
.####.#.#....###...###..#...#.####.###.###.###.##.#.#.#..
.##.#......##.#..###..#.......#.#...#...#...#..##.#..#...
#.######.###.#..#.##.#.#.#.####.#.#.#.#.#.#.#.##.###.#.##
####...#.#....##.#...###..##.#.#.#.#.#.#.#.#.#...#.#....#
.##..##.#....##.#.#.....####..####.###.###.###.##.#.#.#.#
.#..#.....###.###.#.###.......#.#...#...#...#..##.#..#.#.
#.##..##.#...#..#..#.###.###.##.#.#.#.#.#.#.#.##.#.#.#.##
#####..#.#.##.##.......#..##.#.#.#.#.#.#.#.#.#....##.#..#
###.###.##...##.#.###...#...#.####.###.###.###.####.###.#
#...#.......#.###..####.......#.#...#...#...#..#..#..#.#.
..#####.##.###..#..#####.###.####.#.#.#.#.#.#.##.##....##
..##.#.#.#....##..##...#..##.#.#.#.#.#.#.#.#.#.###.#....#
#.#..###.#.####.#.#.#...#...#.####.###.###.###..#.###.#.#
#####..##.....###..#.##.........#...#...#...#..##.##.#.#.
......####....#.#..#####.######.#.#.#.#.#.#.#.########.##
........##...#.##.##...#..#...##.#.#.#.#.#.#.#.##...#...#
#######.##..###...#.###.#.#.#.####.###.###.###.##.#.#.#.#
#.....#....##..##..#.#....#...#.#...#...#...#...#...##.#.
#.###.#..#....#....######.#####.#.#.#.#.#.#.#.########.##
#.###.#..#...##.#.##..###.#.#..#.#.#.#.#.#.#.#..#...#....
#.###.#.#.#.#..#..#.#..#.##.#.####.###.###.###..#.#.#.###
#.....#...####.#...#.#####.#.#..#...#...#...#..#.#.#.#...
#######.#.#..###....####..####..#.#.#.#.#.#.#.####.###..#
END
```

Then create `packages/invite/test/qr.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/invite/test/qr.test.ts`

Expected: FAIL — the module does not exist yet, so Vite cannot resolve the import and no test runs:

```
Error: Failed to resolve import "../src/qr" from "packages/invite/test/qr.test.ts". Does the file exist?
```

- [ ] **Step 3: Write the implementation**

Create `packages/invite/src/qr.ts`:

```ts
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
```

Then add one line to `packages/invite/src/index.ts`, keeping §4.8's order (`hex`, `uri`, `invite`, `t4t`, `reader`, `host`, `applinks`, `qr`, `qr-tables`):

```ts
export * from './qr'
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/invite/test/qr.test.ts`
Expected: all tests pass, including `reproduces pagedout module for module`, `reproduces invite module for module` and `matches annexI's function patterns and format information`.

Run: `npm run typecheck --workspace @tapkart/invite`
Expected: no output, exit 0.

Run: `npm test`
Expected: pass.

**If `reproduces … module for module` fails, do not touch the vector file.** It is published data; the encoder is what is wrong. The three most likely causes, in order: the version-information block at versions ≥ 7 (its two copies are 3 columns × 6 rows and 6 columns × 3 rows — transposing them corrupts the finder separators and every data module after them); the format-information bit positions; and penalty rule 4, which must use the published previous/next-multiple-of-five rule and not `ceil`.

- [ ] **Step 5: Commit**

```bash
git add packages/invite/src/qr.ts packages/invite/src/index.ts packages/invite/vectors/qr-symbol.txt packages/invite/test/qr.test.ts && git commit -m "feat(invite): hand-written byte-mode ECC-M QR encoder (F-P5-2)"
```
