### Task 3: `packages/protocol/src/strings.ts` — length-prefixed UTF-8, PURE

**Files:**
- Create: `packages/protocol/src/strings.ts`
- Modify: `packages/protocol/src/index.ts` — one `export *` line
- Modify: `packages/protocol/test/barrel.test.ts` — the surface pin gains one module
- Test: `packages/protocol/test/strings.test.ts`

Three of the six lobby messages carry a player name and a track id, and they are the only strings anywhere on this wire. This module owns how they get there: a length prefix in bits, then that many UTF-8 bytes, LSB-first like everything else. It is **pure** — no clock, no socket, no allocation the caller did not ask for beyond the byte array a string decode inherently needs.

It is also the sole owner of the truncation rule, and that ownership is what keeps every `*_MAX_BYTES` in §3.3 honest. `BitWriter` **silently truncates past the end of its buffer** — a typed-array write past the end is a no-op, it neither throws nor grows. So a `lobby` message with eight sixteen-byte names must encode to 177 B and no more, and the only thing that guarantees it is that every encoder pushes its strings through `utf8Truncate` with the right cap before writing. A guessed buffer size that is too small does not error; it produces a *valid-looking* shorter message whose last slots are garbage.

**Interfaces:**

- **Consumes** — `packages/protocol/src/bits.ts`, shipped, quoted from source:

  ```ts
  export class BitWriter {
    constructor(buf: Uint8Array)
    reset(): void
    /** Writes the low `bits` bits of `value`, LSB-first. Does NOT clamp or mask:
     *  `value` must already be a non-negative integer in [0, 2**bits - 1].
     *  Silently no-ops past the end of the buffer. */
    writeBits(value: number, bits: number): void
    writeFloatQ(value: number, min: number, max: number, bits: number): void
    /** Bytes touched so far, rounding a partial trailing byte UP. */
    byteLength(): number
  }

  export class BitReader {
    constructor(buf: Uint8Array)
    reset(): void
    /** Reads `bits` bits LSB-first. THROWS RangeError rather than reading past
     *  the end of the buffer - a truncated datagram must not decode into a
     *  well-formed all-zeros world. @tapkart/net's datagram guard turns that
     *  throw into a counted, dropped datagram. */
    readBits(bits: number): number
    readFloatQ(min: number, max: number, bits: number): number
  }
  ```

  `TextEncoder` and `TextDecoder` are ES2022 globals in Node ≥ 20 and every target browser, so this module adds no dependency and needs no DOM lib — which matters, because `packages/server` imports `protocol` and ruling R35 keeps DOM out of its whole import closure.

  `packages/protocol/src/index.ts` today, the eight lines this task inserts into:

  ```ts
  export * from './types'
  export * from './room'
  export * from './bits'
  export * from './quant'
  export * from './snapshot'
  export * from './checkpoint'
  export * from './events'
  export * from './input'
  ```

- **Produces** — contract §3.1, exactly seven exports and not an eighth (§11's census fixes `protocol/strings` at 7):

  ```ts
  export const NAME_MAX_BYTES = 16
  export const TRACK_ID_MAX_BYTES = 24
  export const NAME_LEN_BITS = 5        // 0..16 fits; 0..31 representable
  export const TRACK_ID_LEN_BITS = 5    // 0..24 fits; 0..31 representable
  export function utf8Truncate(s: string, maxBytes: number): Uint8Array
  export function writeString(w: BitWriter, bytes: Uint8Array, lenBits: number): void
  export function readString(r: BitReader, lenBits: number): string
  ```

  **`writeString` takes bytes, not a string.** That is the seam that makes truncation the caller's explicit act: every encoder in Task 5 writes `writeString(w, utf8Truncate(msg.name, NAME_MAX_BYTES), NAME_LEN_BITS)`, so no encoder in this system can emit a body larger than its `*_MAX_BYTES`, whatever a hostile peer sent it earlier.

  **`writeString` throws; `readString` never does, except through `BitReader`.** The asymmetry is deliberate and it is contract §0's rule: an over-long `bytes` is data *this* process produced, which is a bug and not an attack, so it throws loudly. Invalid UTF-8 arrived off a public socket, so it decodes to U+FFFD rather than throwing — a hostile peer must not be able to throw inside a decode. A read past the end of the buffer still throws, from `BitReader`, and `net`'s guard catches it and counts a drop.

  **Names: 16 UTF-8 bytes, no filter, no uniqueness, and empty is legal** (P4 Q18). The UI shows "Player *n*" for an empty name. This is a friends-only room reached by a code; a moderation system for it is scope Plan 1 of 5 did not buy.

---

- [ ] **Step 1: Write the failing test**

Create `packages/protocol/test/strings.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { BitReader, BitWriter } from '../src/bits'
import {
  NAME_LEN_BITS,
  NAME_MAX_BYTES,
  TRACK_ID_LEN_BITS,
  TRACK_ID_MAX_BYTES,
  readString,
  utf8Truncate,
  writeString,
} from '../src/strings'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

/** UTF-8 byte length of `s`, computed independently of the module under test. */
const byteLen = (s: string): number => ENC.encode(s).length

/**
 * Inputs at all four UTF-8 widths, so "never splits a multi-byte sequence" is a
 * measurement over the whole encoding and not a claim about ASCII.
 *   'a'      1 byte
 *   'é'      2 bytes  (U+00E9)
 *   '€'      3 bytes  (U+20AC)
 *   '😀'     4 bytes  (U+1F600, a surrogate pair in JS)
 */
const SAMPLES: [string, string][] = [
  ['ascii', 'abcdefghijklmnopqrstuvwxyz'],
  ['latin1', 'ééééééééééééééééééééé'],
  ['bmp', '€€€€€€€€€€€€€€€€'],
  ['astral', '😀😀😀😀😀😀😀😀'],
  ['mixed', 'a😀é€b😀é€cd😀'],
  ['empty', ''],
]

describe('protocol/strings constants', () => {
  it('fixes the four widths at their contract values', () => {
    expect(NAME_MAX_BYTES).toBe(16)
    expect(TRACK_ID_MAX_BYTES).toBe(24)
    expect(NAME_LEN_BITS).toBe(5)
    expect(TRACK_ID_LEN_BITS).toBe(5)
  })

  it('gives each length field enough bits to express its own maximum', () => {
    // "0..16 fits; 0..31 representable". The relation is the point: a length
    // field one bit too narrow silently encodes a 16-byte name as a 0-byte one,
    // and the message stays perfectly well-formed.
    expect(NAME_MAX_BYTES).toBeLessThanOrEqual(2 ** NAME_LEN_BITS - 1)
    expect(TRACK_ID_MAX_BYTES).toBeLessThanOrEqual(2 ** TRACK_ID_LEN_BITS - 1)
    // ...and not two bits too wide either, which would inflate every
    // *_MAX_BYTES derivation in §3.5 by a byte nobody could account for.
    expect(NAME_MAX_BYTES).toBeGreaterThan(2 ** (NAME_LEN_BITS - 1) - 1)
    expect(TRACK_ID_MAX_BYTES).toBeGreaterThan(2 ** (TRACK_ID_LEN_BITS - 1) - 1)
  })
})

describe('utf8Truncate', () => {
  it('never splits a multi-byte sequence, at every boundary from 0 to 40 bytes', () => {
    // §8.1's row for this module, walked exhaustively rather than spot-checked.
    // Four properties per (sample, maxBytes) pair, and the LAST one is what
    // makes the test able to fail: without maximality, a function that always
    // returned an empty array satisfies the first three.
    for (const [label, s] of SAMPLES) {
      for (let maxBytes = 0; maxBytes <= 40; maxBytes++) {
        const out = utf8Truncate(s, maxBytes)
        const decoded = DEC.decode(out)

        expect(out.length, `${label}@${maxBytes}: over the cap`).toBeLessThanOrEqual(maxBytes)
        expect(decoded, `${label}@${maxBytes}: split a sequence into U+FFFD`).not.toContain('�')
        expect(s.startsWith(decoded), `${label}@${maxBytes}: not a prefix of the input`).toBe(true)
        // Maximality: one more code point would not have fit. `[...s]` iterates
        // by code point, so this is correct across surrogate pairs.
        const cps = [...s]
        const kept = [...decoded].length
        if (kept < cps.length) {
          const oneMore = cps.slice(0, kept + 1).join('')
          expect(byteLen(oneMore), `${label}@${maxBytes}: truncated more than it had to`)
            .toBeGreaterThan(maxBytes)
        }
      }
    }
  })

  it('returns the whole string unchanged when it already fits', () => {
    for (const [label, s] of SAMPLES) {
      const out = utf8Truncate(s, 1024)
      expect(Array.from(out), `${label}: altered a string that fit`).toEqual(Array.from(ENC.encode(s)))
    }
  })

  it('is idempotent: truncating an already-truncated value changes nothing', () => {
    // The property Task 5 leans on. A server decodes a name off the wire, stores
    // it, and re-encodes it into every later `lobby` message; if truncation were
    // not idempotent, a name would erode by a byte per broadcast.
    for (const [label, s] of SAMPLES) {
      for (const cap of [0, 1, 3, 4, 7, 16, 24]) {
        const once = utf8Truncate(s, cap)
        const twice = utf8Truncate(DEC.decode(once), cap)
        expect(Array.from(twice), `${label}@${cap}: not idempotent`).toEqual(Array.from(once))
      }
    }
  })

  it('drops an astral character whole rather than emitting one of its four bytes', () => {
    // The narrowest failure this rule exists to prevent, pinned by exact bytes.
    // '😀' is F0 9F 98 80; caps 1, 2 and 3 must all yield nothing at all.
    expect(Array.from(utf8Truncate('😀', 4))).toEqual([0xf0, 0x9f, 0x98, 0x80])
    for (const cap of [0, 1, 2, 3]) {
      expect(Array.from(utf8Truncate('😀', cap)), `cap ${cap} emitted a partial sequence`).toEqual([])
    }
    // ...and it keeps what precedes it. 'ab😀' at cap 5 is 'ab' and nothing more.
    expect(Array.from(utf8Truncate('ab😀', 5))).toEqual([0x61, 0x62])
    expect(Array.from(utf8Truncate('ab😀', 6))).toEqual([0x61, 0x62, 0xf0, 0x9f, 0x98, 0x80])
  })

  it('treats a zero or negative cap as empty rather than as a wrap', () => {
    expect(Array.from(utf8Truncate('abc', 0))).toEqual([])
    expect(Array.from(utf8Truncate('abc', -1))).toEqual([])
  })
})

describe('writeString / readString', () => {
  it('lays out length-then-bytes at exact bit positions', () => {
    // THE ANCHOR. A round-trip test proves encode and decode agree with each
    // OTHER, not that either matches the spec, so one case is pinned to the
    // literal bytes the §0 layout rule produces.
    //
    // 'AB' at lenBits 5, LSB-first, into a fresh buffer:
    //   bits 0-4   length 2      -> 0,1,0,0,0
    //   bits 5-12  'A' = 0x41    -> 1,0,0,0,0,0,1,0
    //   bits 13-20 'B' = 0x42    -> 0,1,0,0,0,0,1,0
    //   byte0 = 0b00100010 = 0x22   byte1 = 0b01001000 = 0x48   byte2 = 0x08
    //   21 bits -> byteLength 3
    const buf = new Uint8Array(3)
    const w = new BitWriter(buf)
    writeString(w, ENC.encode('AB'), 5)
    expect(w.byteLength()).toBe(3)
    expect(Array.from(buf)).toEqual([0x22, 0x48, 0x08])

    // ...and the reader walks back over exactly those bits.
    const r = new BitReader(buf)
    expect(readString(r, 5)).toBe('AB')
  })

  it('writes a 5-bit zero length and nothing else for an empty string', () => {
    const buf = new Uint8Array(4).fill(0xff)
    const w = new BitWriter(buf)
    writeString(w, ENC.encode(''), NAME_LEN_BITS)
    expect(w.byteLength()).toBe(1)
    // The five length bits are cleared; the three bits above them are untouched,
    // which is BitWriter's documented behaviour and why callers pass a fresh
    // buffer or accept the tail.
    expect(buf[0] & 0b0001_1111).toBe(0)
    expect(buf[1]).toBe(0xff)
  })

  it('round-trips every sample at both cap/width pairs', () => {
    const cases: [number, number][] = [
      [NAME_LEN_BITS, NAME_MAX_BYTES],
      [TRACK_ID_LEN_BITS, TRACK_ID_MAX_BYTES],
    ]
    for (const [lenBits, maxBytes] of cases) {
      for (const [label, s] of SAMPLES) {
        const bytes = utf8Truncate(s, maxBytes)
        const buf = new Uint8Array(64)
        const w = new BitWriter(buf)
        writeString(w, bytes, lenBits)
        const r = new BitReader(buf.subarray(0, w.byteLength()))
        expect(readString(r, lenBits), `${label}@${lenBits}`).toBe(DEC.decode(bytes))
      }
    }
  })

  it('costs exactly lenBits + 8 x length bits, measured across the whole length range', () => {
    // Sizes every *_MAX_BYTES in §3.5. Asserted for every length 0..31 rather
    // than at the two ends, because an off-by-one in the prefix width shows up
    // at one length in eight and would be invisible in a two-point check.
    for (let n = 0; n <= 31; n++) {
      const buf = new Uint8Array(64)
      const w = new BitWriter(buf)
      writeString(w, new Uint8Array(n), 5)
      expect(w.byteLength(), `length ${n}`).toBe(Math.ceil((5 + 8 * n) / 8))
    }
  })

  it('throws on an encode the length field cannot express, and accepts the maximum', () => {
    // ENCODE-side, on data this process produced: a bug, not an attack.
    const w = new BitWriter(new Uint8Array(64))
    expect(() => writeString(w, new Uint8Array(31), 5)).not.toThrow()
    const w2 = new BitWriter(new Uint8Array(64))
    expect(() => writeString(w2, new Uint8Array(32), 5)).toThrow(RangeError)
    const w3 = new BitWriter(new Uint8Array(64))
    expect(() => writeString(w3, new Uint8Array(255), 5)).toThrow(RangeError)
  })

  it('decodes invalid UTF-8 to U+FFFD instead of throwing', () => {
    // §8.1's row, and the reason it exists: these bytes came off a public
    // socket. A decoder that threw here would let any peer kill a room by
    // sending one malformed name - a throw the datagram guard would count and
    // drop, taking the whole legitimate `lobby` broadcast with it.
    const buf = new Uint8Array(8)
    const w = new BitWriter(buf)
    writeString(w, new Uint8Array([0xff, 0xfe]), 5)
    const r = new BitReader(buf.subarray(0, w.byteLength()))
    let out = ''
    expect(() => { out = readString(r, 5) }).not.toThrow()
    // Two standalone invalid lead bytes, so two replacement characters.
    expect(out).toBe('��')
  })

  it('decodes a truncated multi-byte sequence to a single U+FFFD, not to a throw', () => {
    // The first two bytes of '€' (E2 82 AC) - what a hostile or clipped sender
    // produces most easily.
    const buf = new Uint8Array(8)
    const w = new BitWriter(buf)
    writeString(w, new Uint8Array([0xe2, 0x82]), 5)
    const r = new BitReader(buf.subarray(0, w.byteLength()))
    expect(readString(r, 5)).toBe('�')
  })

  it('throws from BitReader when the declared length runs past the buffer', () => {
    // The other half of untrusted input: a length prefix that claims more bytes
    // than arrived. BitReader is the guard, and its RangeError is what
    // @tapkart/net's createDatagramGuard turns into a counted drop.
    const buf = new Uint8Array(2)
    const w = new BitWriter(buf)
    // Claim 31 bytes, supply 2 bytes' worth of buffer.
    w.writeBits(31, 5)
    const r = new BitReader(buf)
    expect(() => readString(r, 5)).toThrow(RangeError)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/protocol/test/strings.test.ts`

Expected: **FAIL**, the file does not collect:

```
Error: Failed to load url ../src/strings (resolved id: .../packages/protocol/src/strings) in .../packages/protocol/test/strings.test.ts. Does the file exist?
```

- [ ] **Step 3: Write the implementation**

Create `packages/protocol/src/strings.ts`:

```ts
/**
 * Length-prefixed UTF-8 on the wire. PURE: no clock, no socket, no allocation
 * the caller did not ask for.
 *
 * Three of the six lobby messages carry a player name and a track id, and they
 * are the only strings anywhere in this format. Everything else is a quantised
 * number or an enum index, so this file is small on purpose - a string on a
 * bit-packed wire is a length and some bytes, and any more machinery than that
 * would be a second format nobody asked for.
 */

import type { BitReader, BitWriter } from './bits'

const ENCODER = new TextEncoder()
/**
 * NON-FATAL, deliberately. `new TextDecoder()` replaces invalid input with
 * U+FFFD; `new TextDecoder('utf-8', { fatal: true })` throws. These bytes come
 * off a public socket, and a decoder that threw would let any peer kill a room
 * by sending one malformed name.
 */
const DECODER = new TextDecoder()

/** Bytes, not characters. A name is 16 UTF-8 bytes; a track id is 24. */
export const NAME_MAX_BYTES = 16
export const TRACK_ID_MAX_BYTES = 24

/**
 * The width of the length prefix, in bits. Five expresses 0..31, which covers
 * both caps with room to spare - and the slack is deliberate rather than
 * wasteful: a four-bit field would cap a name at 15 bytes, which is the kind of
 * limit that gets discovered by a player whose name is one byte too long.
 *
 * The *_MAX_BYTES caps, not these widths, are what size every message in §3.5,
 * because every encoder pushes its strings through `utf8Truncate` first.
 */
export const NAME_LEN_BITS = 5        // 0..16 fits; 0..31 representable
export const TRACK_ID_LEN_BITS = 5    // 0..24 fits; 0..31 representable

/**
 * UTF-8 encodes `s` and truncates to at most `maxBytes` WITHOUT splitting a
 * multi-byte sequence. Sole owner of the truncation rule.
 *
 * Splitting one would put a lone continuation byte on the wire, which decodes
 * to U+FFFD on every peer - a name that renders as a replacement glyph for the
 * whole race, produced by our own encoder rather than by a hostile sender.
 *
 * This function is also what keeps every *_MAX_BYTES in §3.5 true. BitWriter
 * SILENTLY no-ops past the end of its buffer, so a `lobby` message whose names
 * overran would encode into a valid-looking shorter one with garbage in its
 * last slots and no error at any layer. Every encoder in lobby.ts truncates
 * here first, so no encoder in this system can produce a body larger than its
 * constant - whatever a peer sent us earlier.
 */
export function utf8Truncate(s: string, maxBytes: number): Uint8Array {
  if (maxBytes <= 0) return new Uint8Array(0)
  const full = ENCODER.encode(s)
  if (full.length <= maxBytes) return full

  // Walk back off any continuation byte (0b10xxxxxx). `end` then points at a
  // lead byte or an ASCII byte, so slicing there lands on a sequence boundary.
  let end = maxBytes
  while (end > 0 && (full[end] & 0xc0) === 0x80) end--
  return full.slice(0, end)
}

/**
 * Writes `lenBits` of length then that many bytes, LSB-first like everything
 * else on this wire.
 *
 * Takes BYTES, not a string, which is the seam that makes truncation the
 * caller's explicit act rather than a hidden policy in here. Throws if
 * `bytes.length` exceeds what `lenBits` can express - an ENCODE-side throw, on
 * data this process produced, which is a bug and not an attack. Silently
 * writing a wrapped length instead would put a message on the wire that every
 * peer decodes into a different, shorter string.
 */
export function writeString(w: BitWriter, bytes: Uint8Array, lenBits: number): void {
  const max = 2 ** lenBits - 1
  if (bytes.length > max) {
    throw new RangeError(
      `writeString: ${bytes.length} bytes exceeds the ${max} a ${lenBits}-bit length can express`,
    )
  }
  w.writeBits(bytes.length, lenBits)
  for (let i = 0; i < bytes.length; i++) w.writeBits(bytes[i], 8)
}

/**
 * Reads what `writeString` wrote.
 *
 * Invalid UTF-8 decodes with U+FFFD rather than throwing: a hostile peer must
 * not be able to throw inside a decode. A read past the end of the buffer still
 * throws, from BitReader, and @tapkart/net's datagram guard catches it and
 * counts a drop - which is how every undecodable datagram in this system is
 * already treated.
 *
 * Deliberately applies no cap of its own. A length this build's encoder could
 * never produce still decodes, into a longer string than any *_MAX_BYTES
 * allows; that string then passes through `utf8Truncate` at the next encode, so
 * it can never inflate a message. Rejecting it here instead would mean a peer
 * one version ahead, with a wider name field, could not join at all.
 */
export function readString(r: BitReader, lenBits: number): string {
  const len = r.readBits(lenBits)
  const bytes = new Uint8Array(len)
  for (let i = 0; i < len; i++) bytes[i] = r.readBits(8)
  return DECODER.decode(bytes)
}
```

Add one line to `packages/protocol/src/index.ts`, immediately after `export * from './bits'`, so the barrel reads dependency-first:

```ts
export * from './types'
export * from './room'
export * from './bits'
export * from './strings'
export * from './quant'
export * from './snapshot'
export * from './checkpoint'
export * from './events'
export * from './input'
```

- [ ] **Step 4: Widen the barrel pin**

`packages/protocol/test/barrel.test.ts` asserts the package's public surface as an **exact set in both directions** and separately asserts that every module in `src/` has a line in the barrel. A new module fails both until it is listed. Four edits:

1. Add a namespace import beside the others:

   ```ts
   import * as stringsNs from '../src/strings'
   ```

2. Add one entry to `SURFACE`, after the `bits` entry, in the file's per-module comment style:

   ```ts
     // [Plan 4] length-prefixed UTF-8: the only strings on this wire, and the
     // sole owner of the truncation rule every *_MAX_BYTES depends on.
     strings: [
       'NAME_LEN_BITS',
       'NAME_MAX_BYTES',
       'TRACK_ID_LEN_BITS',
       'TRACK_ID_MAX_BYTES',
       'readString',
       'utf8Truncate',
       'writeString',
     ],
   ```

3. Add `'strings'` to `BARREL_MODULES`, in the order `src/index.ts` now lists them:

   ```ts
   const BARREL_MODULES = ['types', 'room', 'bits', 'strings', 'quant', 'snapshot', 'checkpoint', 'events', 'input']
   ```

4. Add one entry to `NAMESPACES`, in the same position:

   ```ts
     ['strings', stringsNs],
   ```

`ProtocolTypeSurface` and `TYPE_SURFACE` are **unchanged**: `strings.ts` exports seven runtime names and no types.

- [ ] **Step 5: Run the tests to verify they pass**

```bash
npx vitest run packages/protocol/test/strings.test.ts packages/protocol/test/barrel.test.ts
npm run typecheck -w @tapkart/protocol
npx vitest run
```

Expected: **15 passed** in `strings.test.ts` (2 + 5 + 8 across its three describe blocks), the barrel file green, no typecheck output, and no new failures anywhere in the full run — this task adds a module and changes no existing behaviour.

If `barrel.test.ts` fails with `a module was added to src/ without a line in the barrel`, Step 4 edit 3 was missed. If it fails with an `expected [...] to deeply equal [...]` diff naming one of the seven, an eighth export crept into `strings.ts` — §11's census fixes the count at seven, so remove it rather than widening the list.

- [ ] **Step 6: Commit**

```bash
git add packages/protocol/src/strings.ts packages/protocol/src/index.ts packages/protocol/test/strings.test.ts packages/protocol/test/barrel.test.ts && git commit -m "feat(protocol): length-prefixed UTF-8 strings and the truncation rule"
```
