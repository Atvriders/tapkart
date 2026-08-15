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
    // Each width also gets one non-palindromic value (1, whose bit-reversal is
    // 2**(bits-1) for bits >= 2 - never 1 itself) everywhere no other test in this
    // file already exercises that width with an asymmetric value: width 3 is
    // covered by the byte-boundary test below, width 8 by the mixed-widths test's
    // value 200. A value-bit-order regression consistent between writeBits and
    // readBits still round-trips regardless (encode/decode cancel out), so this
    // guards a one-sided regression (only the writer or only the reader reversed),
    // not the fully self-consistent case - see the byte-level tests for that.
    const cases: Array<[bits: number, value: number]> = [
      [1, 0], [1, 1],
      [3, 0], [3, 7],
      [7, 0], [7, 127], [7, 1],
      [8, 0], [8, 255],
      [12, 0], [12, 4095], [12, 1],
      [16, 0], [16, 65535], [16, 1],
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
    // 0b110 (not 0b101) deliberately: 0b101 is a bit-palindrome, so a bug that
    // reverses the order value-bits are extracted in (MSB-first instead of
    // LSB-first) would write the identical bytes and this test would not catch
    // it. 0b110 reversed is 0b011 (a different value), so it does.
    bw.writeBits(0b110, 3) // bits 6-7 of byte 0, then bit 0 of byte 1
    // value 0b110, LSB-first: bit0=0, bit1=1, bit2=1
    // byte0 bit6=0, byte0 bit7=1 -> byte0 = 0b10111111 = 191
    // byte1 bit0=1 -> byte1 = 0b00000001 = 1
    expect(buf[0]).toBe(0b10111111)
    expect(buf[1]).toBe(0b00000001)
    const br = new BitReader(buf)
    expect(br.readBits(6)).toBe(0b111111)
    expect(br.readBits(3)).toBe(0b110)
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

describe('BitReader — a read past the end of the buffer', () => {
  it('throws instead of returning zeros, so a truncated datagram cannot decode', () => {
    // WHY THIS IS A SECURITY BOUNDARY, NOT TIDINESS: `buf[i]` past the end of a
    // Uint8Array is `undefined`, and `undefined >> n` is 0. Without this check a
    // truncated frame does not fail - it decodes into a perfectly well-formed
    // ALL-ZEROS world, and the receiving loop snaps its whole race onto it.
    const buf = new Uint8Array(2)
    const bw = new BitWriter(buf)
    bw.writeBits(0xffff, 16)

    const br = new BitReader(buf)
    expect(br.readBits(16)).toBe(0xffff) // every bit that was written reads back
    expect(() => br.readBits(1)).toThrow(RangeError)

    // And a read that STRADDLES the end is rejected too, not truncated to the
    // bits that happen to exist: a straddling read is the common shape (a
    // 16-bit entityId two bytes from the end), and returning its low bits is
    // exactly the silent corruption above.
    const br2 = new BitReader(buf)
    br2.readBits(12)
    expect(() => br2.readBits(8)).toThrow(RangeError)

    // readFloatQ goes through readBits, so it inherits this.
    const br3 = new BitReader(buf)
    br3.readBits(10)
    expect(() => br3.readFloatQ(-1, 1, 12)).toThrow(RangeError)
  })

  it('still reads every bit a BitWriter says it wrote, right up to the last one', () => {
    // The other half: byteLength() rounds a partial trailing byte UP, so a
    // buffer sized from a writer must always satisfy its reader. A bounds check
    // that were off by one bit would break every codec in this package, so this
    // walks widths that leave a partial final byte.
    for (let bits = 1; bits <= 32; bits++) {
      const buf = new Uint8Array(8)
      const bw = new BitWriter(buf)
      bw.writeBits(1, bits)
      const sized = buf.subarray(0, bw.byteLength())
      const br = new BitReader(sized)
      expect(br.readBits(bits)).toBe(1)
    }
  })
})

describe('@tapkart/protocol barrel', () => {
  it('re-exports BitWriter and BitReader', async () => {
    const pkg = await import('@tapkart/protocol')
    expect(typeof pkg.BitWriter).toBe('function')
    expect(typeof pkg.BitReader).toBe('function')
  })
})
