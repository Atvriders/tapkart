### Task 4: Bit-level wire codec — `BitWriter` and `BitReader`

This is Plan 2's Task 4, contract §3: `packages/protocol/src/bits.ts`. It is the lowest
layer of `packages/protocol` — zero imports, pure arithmetic on a caller-owned
`Uint8Array` — and every later protocol task (quant.ts's round-trip tests, snapshot.ts,
checkpoint.ts, events.ts, input.ts) builds directly on it. Task 3 (contract §3) has
already run and created `packages/protocol/package.json`, `packages/protocol/tsconfig.json`
(both mirroring `packages/sim`'s: `"exports": {".":"./src/index.ts"}`,
`tsconfig` extending `../../tsconfig.base.json` with `include: ["src/**/*.ts",
"test/**/*.ts"]`) and `packages/protocol/src/types.ts`. This task does not touch any
of those and does not need anything from `types.ts` — `bits.ts` never imports.

**Read contract §0 before writing anything:** byte order is little-endian everywhere
(not relevant inside a single field here, but binding for how multi-byte fields are
laid out across the buffer — LSB-first bit packing is the mechanism, see decision 1
below), bit packing is **LSB-first within each byte**, fields are written in table
order (enforced by the *caller*, not by this file — `bits.ts` has no concept of a
"table", it just packs whatever `writeBits`/`writeFloatQ` calls it receives, in the
order it receives them), and **codecs never allocate**: `BitWriter`/`BitReader` each
take a caller-owned `Uint8Array` in their constructor and never create a new
`Uint8Array` or `ArrayBuffer` themselves.

**Four decisions this task makes, all load-bearing for Tasks 5, 6, 8, 9, 10:**

1. **LSB-first, verified by construction, not by convention.** The first bit ever
   written lands at bit 0 (the `1`s place) of byte 0. The 9th bit written lands at
   bit 0 of byte 1. `writeBits` computes each bit as `Math.floor(value / 2**i) % 2`
   for `i` from `0` to `bits-1` and writes it to bit `(bitPos) % 8` of byte
   `Math.floor(bitPos / 8)`, incrementing `bitPos` after every single bit. This is
   the only implementation of "LSB-first" in this file; there is no separate
   byte-orientation step.
2. **No bit width is special-cased, including 32.** `writeBits`/`readBits` must
   correctly round-trip a full 32-bit value, because the wire header carries `tick`
   and `eventSeq` as `u32` (contract §4). Two specific traps, both real bugs a
   plausible-looking implementation falls into:
   - **Building a single mask `(1 << bits) - 1` for `bits = 32` is wrong.** JS's `<<`
     operator takes its shift amount modulo 32, so `1 << 32 === 1 << 0 === 1`, and
     `(1 << 32) - 1 === 0` — a silent, non-throwing bug that would make every
     32-bit field encode as zero. This file never builds that mask. `writeBits`
     extracts one bit at a time with `Math.floor(value / 2**i) % 2`, where `i` only
     ever reaches `bits - 1` (31 at most for a 32-bit field) — the shift-by-32 case
     never arises because there is no single 32-wide shift anywhere.
   - **Accumulating a read with `result |= bit << i` is wrong at `i = 31`.** `|=`
     coerces to a signed 32-bit integer, so setting bit 31 produces a *negative* JS
     number for any decoded value at or above `2**31` — exactly the range a
     long-running server's monotonic `eventSeq` will eventually reach. `readBits`
     accumulates with `result += bit * mult; mult *= 2` instead: plain
     floating-point arithmetic, no sign bit, correct up to `2**53`.
3. **`writeFloatQ` clamps, it does not wrap.** `clamp(value, min, max)` then
   quantise: `q = Math.round(((clamped - min) / (max - min)) * (2**bits - 1))`,
   written via `writeBits(q, bits)`. A value outside `[min, max]` — a kart
   momentarily beyond `WORLD_HALF` during a physics glitch, say — must land exactly
   on the endpoint it overshot, never fold into the opposite side of the range the
   way a modulo-based implementation would.
4. **`reset()` rewinds the cursor; it does not clear the buffer.** Both classes hold
   only a `buf` reference and a `bitPos` cursor. `reset()` sets `bitPos = 0` so the
   same writer/reader and the same caller-owned buffer can be reused across many
   encode/decode calls without allocating — this is what "codecs never allocate"
   means in practice, one `BitWriter`/`BitReader` pair reused every tick rather than
   constructed fresh. Stale bytes from a previous, longer encode are never read: a
   decoder that stops after the same number of fields the matching encoder wrote
   never reaches them.

**Files:**
- Create: `packages/protocol/src/bits.ts`
- Test: `packages/protocol/test/bits.test.ts`

**Interfaces:**
- Consumes: nothing. This file has zero imports.
- Produces (`packages/protocol/src/bits.ts`), exactly contract §3:
  ```ts
  export class BitWriter {
    constructor(buf: Uint8Array)
    reset(): void
    writeBits(value: number, bits: number): void
    writeFloatQ(value: number, min: number, max: number, bits: number): void
    byteLength(): number
  }
  export class BitReader {
    constructor(buf: Uint8Array)
    reset(): void
    readBits(bits: number): number
    readFloatQ(min: number, max: number, bits: number): number
  }
  ```

**On the expected RED failures below:** this repo runs Vitest over Vite's esbuild SSR
transform, not native Node ESM, so a missing named export does **not** throw a
link-time `SyntaxError: does not provide an export named 'X'`. Instead the import
succeeds with `X` bound to `undefined`, and the failure surfaces at the point `X` is
*used* — `TypeError: (0 , X) is not a function` for a bare function call,
`TypeError: X is not a constructor` for `new X()`, `TypeError: obj.method is not a
function` for a missing method on an object that does exist. When the whole *file*
`src/bits.ts` does not exist yet, the failure is a suite-load error instead:
`Error: Cannot find module '../src/bits' imported from '<abs path to the test
file>'`, and Vitest reports it under "Failed Suites" with zero tests collected. All
of this was verified empirically against this exact repo and Vitest version before
writing the steps below — do not substitute the more commonly-assumed `SyntaxError`
wording from other codebases or older Vitest versions.

---

- [ ] **Step 1: Write the failing tests for `writeBits`/`readBits`**

Create `packages/protocol/test/bits.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { BitReader, BitWriter } from '../src/bits'

describe('BitWriter/BitReader: writeBits/readBits', () => {
  it('packs LSB-first: the first bit written lands at bit 0 of byte 0', () => {
    const buf = new Uint8Array(1)
    const bw = new BitWriter(buf)
    bw.writeBits(1, 1) // bit 0
    bw.writeBits(0, 3) // bits 1-3
    bw.writeBits(1, 1) // bit 4
    // MSB-first packing would put the first bit at bit 7 (byte 0b10001000 = 136);
    // LSB-first puts it at bit 0, so the byte is 0b00010001 = 17
    expect(buf[0]).toBe(0b00010001)
  })

  it('round-trips a single field at several bit widths, at each endpoint', () => {
    const cases: Array<[bits: number, value: number]> = [
      [1, 0], [1, 1],
      [3, 0], [3, 7],
      [7, 0], [7, 127],
      [8, 0], [8, 255],
      [12, 0], [12, 4095],
      [16, 0], [16, 65535],
    ]
    for (const [bits, value] of cases) {
      const buf = new Uint8Array(4)
      const bw = new BitWriter(buf)
      bw.writeBits(value, bits)
      const br = new BitReader(buf)
      expect(br.readBits(bits)).toBe(value)
    }
  })

  it('packs a field starting at bit 6 across the byte boundary', () => {
    const buf = new Uint8Array(2)
    const bw = new BitWriter(buf)
    bw.writeBits(0b111111, 6) // fills bits 0-5 of byte 0
    bw.writeBits(0b101, 3) // bits 6-7 of byte 0, then bit 0 of byte 1
    // value 0b101, LSB-first: bit0=1, bit1=0, bit2=1
    // byte0 bit6=1, byte0 bit7=0 -> byte0 = 0b01111111 = 127
    // byte1 bit0=1 -> byte1 = 0b00000001 = 1
    expect(buf[0]).toBe(0b01111111)
    expect(buf[1]).toBe(0b00000001)
    const br = new BitReader(buf)
    expect(br.readBits(6)).toBe(0b111111)
    expect(br.readBits(3)).toBe(0b101)
  })

  it('round-trips sequential fields of mixed widths in call order', () => {
    const buf = new Uint8Array(4)
    const bw = new BitWriter(buf)
    bw.writeBits(5, 3)
    bw.writeBits(200, 8)
    bw.writeBits(1, 1)
    bw.writeBits(4095, 12)
    const br = new BitReader(buf)
    expect(br.readBits(3)).toBe(5)
    expect(br.readBits(8)).toBe(200)
    expect(br.readBits(1)).toBe(1)
    expect(br.readBits(12)).toBe(4095)
  })

  it('round-trips a 32-bit value at or above 2^31 without going negative', () => {
    // tick and eventSeq are u32 counters a long-running server will eventually push
    // past 2^31; `result |= bit << 31` would set JS's sign bit here and return a
    // negative number instead of this value
    const buf = new Uint8Array(4)
    const bw = new BitWriter(buf)
    const value = 3_000_000_000 // > 2^31 (2147483648), < 2^32 (4294967296)
    bw.writeBits(value, 32)
    const br = new BitReader(buf)
    expect(br.readBits(32)).toBe(value)
  })

  it('byteLength reports bytes touched, rounding a partial byte up', () => {
    const buf = new Uint8Array(4)
    const bw = new BitWriter(buf)
    expect(bw.byteLength()).toBe(0)
    bw.writeBits(1, 1)
    expect(bw.byteLength()).toBe(1)
    bw.writeBits(1, 8) // 9 bits total now
    expect(bw.byteLength()).toBe(2)
  })

  it('reset rewinds the cursor so the same writer and buffer can be reused', () => {
    const buf = new Uint8Array(1)
    const bw = new BitWriter(buf)
    bw.writeBits(0b1111, 4)
    bw.reset()
    bw.writeBits(0b0101, 4) // overwrites the low nibble written above
    const br = new BitReader(buf)
    expect(br.readBits(4)).toBe(0b0101)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/protocol/test/bits.test.ts`

Expected: FAIL — the suite fails to load, under "Failed Suites":
`Error: Cannot find module '../src/bits' imported from
'/home/kasm-user/tapkart/packages/protocol/test/bits.test.ts'`. Zero tests collected
(`src/bits.ts` does not exist yet).

- [ ] **Step 3: Write the minimal `BitWriter`/`BitReader` — `writeBits`/`readBits` only**

Create `packages/protocol/src/bits.ts`:

```ts
/**
 * Bit-packs into a caller-owned Uint8Array. Never allocates a buffer itself: the
 * Uint8Array is supplied by the constructor and reused across many encode calls via
 * reset(). Bit order is LSB-first within each byte (contract §0): the first bit
 * written is byte 0's 1s place; the 9th bit written is byte 1's 1s place.
 *
 * writeBits/writeFloatQ enforce no field order of their own - a caller (snapshot.ts,
 * checkpoint.ts, events.ts, input.ts) is what makes "fields written in table order"
 * true, by calling these methods in that order.
 */
export class BitWriter {
  private buf: Uint8Array
  private bitPos: number

  constructor(buf: Uint8Array) {
    this.buf = buf
    this.bitPos = 0
  }

  /** Rewinds the write cursor to the start of the same buffer. Allocates nothing. */
  reset(): void {
    this.bitPos = 0
  }

  /**
   * Writes the low `bits` bits of `value`, LSB-first. `value` must already be a
   * non-negative integer in [0, 2**bits - 1] - writeBits does not clamp or mask;
   * that is writeFloatQ's job for continuous fields. Every exact/enum field this
   * codebase writes directly (an enum index, a tick count, a 0/1 flag) is already
   * in range by construction.
   *
   * Extracts one bit at a time by division, not by building a single mask: a mask
   * of `(1 << bits) - 1` is wrong at bits = 32 (see this task's decision 2).
   */
  writeBits(value: number, bits: number): void {
    for (let i = 0; i < bits; i++) {
      const bit = Math.floor(value / 2 ** i) % 2
      const byteIdx = this.bitPos >> 3
      const bitIdx = this.bitPos & 7
      if (bit) this.buf[byteIdx] |= 1 << bitIdx
      else this.buf[byteIdx] &= ~(1 << bitIdx)
      this.bitPos++
    }
  }

  /** Bytes touched so far, rounding a partial trailing byte up. */
  byteLength(): number {
    return Math.ceil(this.bitPos / 8)
  }
}

export class BitReader {
  private buf: Uint8Array
  private bitPos: number

  constructor(buf: Uint8Array) {
    this.buf = buf
    this.bitPos = 0
  }

  /** Rewinds the read cursor to the start of the same buffer. Allocates nothing. */
  reset(): void {
    this.bitPos = 0
  }

  /**
   * Reads `bits` bits LSB-first and returns them as a non-negative integer.
   * Accumulates by addition (`result += bit * mult; mult *= 2`), not by
   * `result |= bit << i`: the OR form sets JS's Int32 sign bit on the last
   * iteration of a 32-bit read and returns a negative number for any value at or
   * above 2**31 (see this task's decision 2). Addition has no sign bit to corrupt
   * and stays exact up to 2**53.
   */
  readBits(bits: number): number {
    let result = 0
    let mult = 1
    for (let i = 0; i < bits; i++) {
      const byteIdx = this.bitPos >> 3
      const bitIdx = this.bitPos & 7
      const bit = (this.buf[byteIdx] >> bitIdx) & 1
      result += bit * mult
      mult *= 2
      this.bitPos++
    }
    return result
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/protocol/test/bits.test.ts`

Expected: PASS — 7 passed. (`writeFloatQ`/`readFloatQ` are not called by any test yet.)

---

- [ ] **Step 5: Write the failing tests for `writeFloatQ`/`readFloatQ`**

Append to `packages/protocol/test/bits.test.ts`, after the closing `})` of
`describe('BitWriter/BitReader: writeBits/readBits', ...)`:

```ts
describe('BitWriter/BitReader: writeFloatQ/readFloatQ', () => {
  it('round-trips a mid-range value within one quantisation step', () => {
    const buf = new Uint8Array(4)
    const bw = new BitWriter(buf)
    bw.writeFloatQ(12.5, -1024, 1024, 16)
    const br = new BitReader(buf)
    const step = 2048 / 65535
    expect(Math.abs(br.readFloatQ(-1024, 1024, 16) - 12.5)).toBeLessThan(step)
  })

  it('round-trips both range endpoints exactly', () => {
    const buf = new Uint8Array(4)
    const bw = new BitWriter(buf)
    bw.writeFloatQ(-1024, -1024, 1024, 16)
    bw.writeFloatQ(1024, -1024, 1024, 16)
    const br = new BitReader(buf)
    expect(br.readFloatQ(-1024, 1024, 16)).toBe(-1024)
    expect(br.readFloatQ(-1024, 1024, 16)).toBe(1024)
  })

  it('clamps a value above max instead of wrapping', () => {
    const buf = new Uint8Array(4)
    const bw = new BitWriter(buf)
    bw.writeFloatQ(5000, -1024, 1024, 16)
    const br = new BitReader(buf)
    // a wrap (e.g. modulo back into range) would land far from 1024; clamping
    // lands exactly on the endpoint the value overshot
    expect(br.readFloatQ(-1024, 1024, 16)).toBe(1024)
  })

  it('clamps a value below min instead of wrapping', () => {
    const buf = new Uint8Array(4)
    const bw = new BitWriter(buf)
    bw.writeFloatQ(-5000, -1024, 1024, 16)
    const br = new BitReader(buf)
    expect(br.readFloatQ(-1024, 1024, 16)).toBe(-1024)
  })

  it('interleaves with writeBits without losing alignment', () => {
    const buf = new Uint8Array(8)
    const bw = new BitWriter(buf)
    bw.writeBits(5, 3)
    bw.writeFloatQ(0.5, 0, 1, 10)
    bw.writeBits(2, 2)
    const br = new BitReader(buf)
    expect(br.readBits(3)).toBe(5)
    const step10 = 1 / 1023
    expect(Math.abs(br.readFloatQ(0, 1, 10) - 0.5)).toBeLessThan(step10)
    expect(br.readBits(2)).toBe(2)
  })

  it('a narrow 2-bit field over [0,1] quantises to the nearest of 3 levels', () => {
    const buf = new Uint8Array(1)
    const bw = new BitWriter(buf)
    bw.writeFloatQ(0.5, 0, 1, 2) // 0.5 / (1/3) = 1.5 -> Math.round -> level 2 -> 2/3
    const br = new BitReader(buf)
    expect(br.readFloatQ(0, 1, 2)).toBeCloseTo(2 / 3, 12)
  })
})
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `npx vitest run packages/protocol/test/bits.test.ts -t "writeFloatQ/readFloatQ"`

Expected: FAIL — `TypeError: bw.writeFloatQ is not a function`. (`BitWriter` exists
from Step 3 but has no `writeFloatQ` method yet; this is a missing-method error on an
object that exists, not a missing-module or missing-export error.)

- [ ] **Step 7: Write `writeFloatQ`/`readFloatQ`**

In `packages/protocol/src/bits.ts`, add this method to `BitWriter`, after
`writeBits` and before `byteLength`:

```ts
  /**
   * Clamps `value` to [min, max], then writes a `bits`-wide uniform quantisation
   * of it. Never wraps: a value past either end of the range is written as that
   * endpoint, not folded back into range.
   */
  writeFloatQ(value: number, min: number, max: number, bits: number): void {
    const clamped = value < min ? min : value > max ? max : value
    const span = max - min
    const levels = 2 ** bits - 1
    const q = span > 0 ? Math.round(((clamped - min) / span) * levels) : 0
    this.writeBits(q, bits)
  }
```

And add this method to `BitReader`, after `readBits`:

```ts
  /** Reverses writeFloatQ: reads `bits` bits and maps them back into [min, max]. */
  readFloatQ(min: number, max: number, bits: number): number {
    const q = this.readBits(bits)
    const levels = 2 ** bits - 1
    return levels > 0 ? min + (q / levels) * (max - min) : min
  }
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `npx vitest run packages/protocol/test/bits.test.ts`

Expected: PASS — 13 passed (7 from `writeBits`/`readBits` plus 6 from
`writeFloatQ`/`readFloatQ`).

---

- [ ] **Step 9: Typecheck and run the whole protocol suite**

Run: `npx tsc --noEmit -p packages/protocol && npx vitest run packages/protocol`

Expected: PASS — no TypeScript errors; `bits.test.ts` 13 passed, plus whatever Task 3
already shipped for `types.ts` (this task does not add or remove any of those).

- [ ] **Step 10: Commit**

```bash
git add packages/protocol/src/bits.ts packages/protocol/test/bits.test.ts
git commit -m "feat(protocol): LSB-first bit-packed wire codec primitives (BitWriter/BitReader)"
```
