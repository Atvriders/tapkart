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
