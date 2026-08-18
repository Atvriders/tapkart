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
