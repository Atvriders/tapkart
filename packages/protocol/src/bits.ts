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
   *
   * THROWS rather than reading past the end of the buffer. This is a security
   * boundary, not a tidiness check: without it, `this.buf[byteIdx]` past the end
   * is `undefined`, `undefined >> n` is 0, and a TRUNCATED datagram therefore
   * decodes - silently, with no error anywhere - into a perfectly well-formed
   * all-zeros world. A half-received snapshot then reads as every kart at
   * quantisation code 0, which dequantises to x = -1024, and the receiving loop
   * snaps its whole race onto it one tick later. Over a real transport those
   * bytes come off a public socket. Failing loudly here turns that silent
   * corruption into the one thing a receive path can actually handle: an
   * exception, caught by the datagram guard in @tapkart/net, and a dropped
   * datagram.
   *
   * Safe for every encoder in this repository: BitWriter.byteLength() rounds a
   * partial trailing byte UP, so a buffer sized from a writer always holds every
   * bit its reader will ask for, and no codec here over-reads deliberately.
   */
  readBits(bits: number): number {
    if (this.bitPos + bits > this.buf.length * 8) {
      throw new RangeError(
        `BitReader: read of ${bits} bits at bit ${this.bitPos} runs past the end of a ${this.buf.length}-byte buffer`,
      )
    }
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

  /** Reverses writeFloatQ: reads `bits` bits and maps them back into [min, max]. */
  readFloatQ(min: number, max: number, bits: number): number {
    const q = this.readBits(bits)
    const levels = 2 ** bits - 1
    return levels > 0 ? min + (q / levels) * (max - min) : min
  }
}
