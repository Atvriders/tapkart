import { describe, expect, it } from 'vitest'
import { BitReader, BitWriter } from '../src/bits'
import {
  CODE_CHAR_BITS,
  LOBBY_PATH_PREFIX,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_BITS,
  ROOM_CODE_LENGTH,
  ROOM_CODE_SPACE,
  SESSION_TOKEN_BITS,
  SESSION_TOKEN_LENGTH,
  decodeCodeChars,
  encodeCodeChars,
  isValidRoomCode,
  isValidSessionToken,
  lobbyPathFor,
  normalizeRoomCode,
} from '../src/room'

/** Encodes `code` into a fresh buffer and returns exactly the bytes written. */
function encodeToBytes(code: string, length: number, bufBytes = 16): Uint8Array {
  const buf = new Uint8Array(bufBytes)
  const w = new BitWriter(buf)
  encodeCodeChars(w, code, length)
  return buf.slice(0, w.byteLength())
}

describe('the 5-bit scheme, and the one property it all rests on', () => {
  it('has exactly 32 symbols, none repeated, and 2**CODE_CHAR_BITS of them', () => {
    // The one-line test that protects the whole scheme. Thirty-one symbols and
    // `decodeCodeChars` starts producing `undefined` for code 31; thirty-three
    // and `encodeCodeChars` starts writing an index that does not fit in five
    // bits, which BitWriter neither clamps nor reports.
    expect(ROOM_CODE_ALPHABET).toHaveLength(32)
    expect(new Set(ROOM_CODE_ALPHABET).size).toBe(32)
    expect(2 ** CODE_CHAR_BITS).toBe(ROOM_CODE_ALPHABET.length)
  })

  it('is Crockford: keeps 0 and 1, drops I, L, O and U', () => {
    // Three drafts proposed three alphabets and the shipped one is none of
    // them, so this pins the string itself rather than a property of it. The
    // ORDER is the 5-bit wire index: a reordering is a different protocol.
    expect(ROOM_CODE_ALPHABET).toBe('0123456789ABCDEFGHJKMNPQRSTVWXYZ')
    for (const dropped of ['I', 'L', 'O', 'U']) {
      expect(ROOM_CODE_ALPHABET.includes(dropped), `${dropped} is in the alphabet`).toBe(false)
    }
    for (const kept of ['0', '1']) {
      expect(ROOM_CODE_ALPHABET.includes(kept), `${kept} is missing from the alphabet`).toBe(true)
    }
    // The exclusions are not cosmetic: a room code is read off one phone screen
    // across a room and typed into another, and I/1, L/1 and O/0 are the three
    // misreads that actually happen.
  })

  it('derives every width and space from the alphabet rather than restating them', () => {
    expect(CODE_CHAR_BITS).toBe(5)
    expect(ROOM_CODE_BITS).toBe(25)
    expect(ROOM_CODE_BITS).toBe(ROOM_CODE_LENGTH * CODE_CHAR_BITS)
    expect(ROOM_CODE_SPACE).toBe(33_554_432)
    expect(ROOM_CODE_SPACE).toBe(ROOM_CODE_ALPHABET.length ** ROOM_CODE_LENGTH)
    expect(SESSION_TOKEN_LENGTH).toBe(12)
    expect(SESSION_TOKEN_BITS).toBe(60)
    expect(SESSION_TOKEN_BITS).toBe(SESSION_TOKEN_LENGTH * CODE_CHAR_BITS)
    // 2^60, exactly - a power of two is exact as a double, and so is 32^12.
    expect(2 ** SESSION_TOKEN_BITS).toBe(ROOM_CODE_ALPHABET.length ** SESSION_TOKEN_LENGTH)
  })

  it('walks the WHOLE five-bit code space: 32 codes, 32 distinct characters, no hole', () => {
    // The measurement that makes "no guard needed" a fact rather than a hope.
    // Every other fixed-width enum on this wire has unused codes that decode to
    // `undefined` and must be rejected; this field's value count exactly fills
    // it, so a guard here would be dead code no datagram could reach. If a
    // 31-symbol alphabet is ever committed, THIS loop is what fails.
    const seen = new Set<string>()
    for (let code = 0; code < 2 ** CODE_CHAR_BITS; code++) {
      const buf = new Uint8Array(1)
      const w = new BitWriter(buf)
      w.writeBits(code, CODE_CHAR_BITS)
      const ch = decodeCodeChars(new BitReader(buf), 1)
      expect(ch, `code ${code} decoded to nothing`).toHaveLength(1)
      expect(ch, `code ${code} decoded outside the alphabet`).toBe(ROOM_CODE_ALPHABET[code])
      seen.add(ch)
    }
    expect(seen.size).toBe(32)
  })
})
describe('encodeCodeChars / decodeCodeChars', () => {
  it('lays a five-character code out at exact bit positions', () => {
    // THE ANCHOR. A round-trip proves encode and decode agree with EACH OTHER,
    // not that either matches the spec, so one case is pinned to literal bytes.
    //
    // '0ABCD' -> indices 0, 10, 11, 12, 13, five bits each, LSB-first:
    //   bits  0-4  = 0                       bits  5-9  = 10 = 0b01010
    //   bits 10-14 = 11 = 0b01011            bits 15-19 = 12 = 0b01100
    //   bits 20-24 = 13 = 0b01101
    //   byte0 = 0x40  byte1 = 0x2D  byte2 = 0xD6  byte3 = 0x00   (25 bits -> 4 B)
    expect(Array.from(encodeToBytes('0ABCD', ROOM_CODE_LENGTH)))
      .toEqual([0x40, 0x2d, 0xd6, 0x00])
  })

  it('writes exactly 25 bits for a room code, not 32 - the tail byte proves it', () => {
    // All-ones input, so every bit the encoder is entitled to write is set and
    // every bit past the field is not. A field one bit too wide changes byte 3
    // from 0x01 to 0x03 and NOTHING ELSE, which is invisible to a byte-count
    // assertion and to a round-trip.
    const bytes = encodeToBytes('ZZZZZ', ROOM_CODE_LENGTH)
    expect(bytes).toHaveLength(Math.ceil(ROOM_CODE_BITS / 8))
    expect(Array.from(bytes)).toEqual([0xff, 0xff, 0xff, 0x01])
  })

  it('writes exactly 60 bits for a session token, not 64 - the tail byte proves it', () => {
    const bytes = encodeToBytes('ZZZZZZZZZZZZ', SESSION_TOKEN_LENGTH)
    expect(bytes).toHaveLength(Math.ceil(SESSION_TOKEN_BITS / 8))
    expect(Array.from(bytes)).toEqual([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x0f])
  })

  it('writes all-zero bits for the all-zero code and token', () => {
    expect(Array.from(encodeToBytes('00000', ROOM_CODE_LENGTH))).toEqual([0, 0, 0, 0])
    expect(Array.from(encodeToBytes('000000000000', SESSION_TOKEN_LENGTH)))
      .toEqual([0, 0, 0, 0, 0, 0, 0, 0])
  })

  it('round-trips a code with every alphabet symbol in every position', () => {
    // 32 x 5 = 160 codes, which is the whole per-position code space rather
    // than a handful of pretty examples.
    for (let pos = 0; pos < ROOM_CODE_LENGTH; pos++) {
      for (const ch of ROOM_CODE_ALPHABET) {
        const chars = new Array<string>(ROOM_CODE_LENGTH).fill('0')
        chars[pos] = ch
        const code = chars.join('')
        const bytes = encodeToBytes(code, ROOM_CODE_LENGTH)
        expect(decodeCodeChars(new BitReader(bytes), ROOM_CODE_LENGTH), `${code}`).toBe(code)
      }
    }
  })

  it('round-trips a twelve-character token through sixty bits', () => {
    for (const token of ['000000000000', 'ZZZZZZZZZZZZ', '0123456789AB', 'ZYXWVTSRQPNM']) {
      const bytes = encodeToBytes(token, SESSION_TOKEN_LENGTH)
      expect(decodeCodeChars(new BitReader(bytes), SESSION_TOKEN_LENGTH), token).toBe(token)
    }
  })

  it('produces a code that isValidRoomCode always accepts', () => {
    // Task 5's decoders read a room code straight off the wire and route on it.
    // Every 25-bit pattern must therefore decode to something canonical - which
    // it does, because 32 symbols fill five bits with nothing left over.
    for (const bytes of [
      new Uint8Array([0x00, 0x00, 0x00, 0x00]),
      new Uint8Array([0xff, 0xff, 0xff, 0x01]),
      new Uint8Array([0x40, 0x2d, 0xd6, 0x00]),
      new Uint8Array([0xa5, 0x5a, 0xa5, 0x01]),
    ]) {
      const code = decodeCodeChars(new BitReader(bytes), ROOM_CODE_LENGTH)
      expect(isValidRoomCode(code), `${Array.from(bytes)} decoded to '${code}'`).toBe(true)
      expect(normalizeRoomCode(code), 'a decoded code is already canonical').toBe(code)
    }
  })

  it('throws on an encode it cannot represent, rather than writing something else', () => {
    const w = () => new BitWriter(new Uint8Array(16))
    // Wrong length: a four-character code is the PREVIOUS protocol version's,
    // and writing it into a 25-bit field would leave five bits of the next
    // field's value where the fifth character belongs.
    expect(() => encodeCodeChars(w(), 'ABCD', ROOM_CODE_LENGTH)).toThrow(RangeError)
    expect(() => encodeCodeChars(w(), 'ABCDEF', ROOM_CODE_LENGTH)).toThrow(RangeError)
    // Lowercase: this is why every caller goes through normalizeRoomCode first.
    expect(() => encodeCodeChars(w(), 'abcde', ROOM_CODE_LENGTH)).toThrow(RangeError)
    // A symbol the alphabet deliberately excludes.
    for (const bad of ['IBCDE', 'LBCDE', 'OBCDE', 'UBCDE', '-BCDE', ' BCDE']) {
      expect(() => encodeCodeChars(w(), bad, ROOM_CODE_LENGTH), bad).toThrow(RangeError)
    }
  })

  it('throws from BitReader when the buffer cannot hold the bits asked for', () => {
    // Untrusted input: a datagram clipped mid-code. BitReader's RangeError is
    // what @tapkart/net's guard turns into a counted, dropped datagram.
    expect(() => decodeCodeChars(new BitReader(new Uint8Array(3)), ROOM_CODE_LENGTH))
      .toThrow(RangeError)
    expect(() => decodeCodeChars(new BitReader(new Uint8Array(7)), SESSION_TOKEN_LENGTH))
      .toThrow(RangeError)
    expect(() => decodeCodeChars(new BitReader(new Uint8Array(0)), 1)).toThrow(RangeError)
  })
})

describe('isValidSessionToken', () => {
  it('accepts exactly twelve canonical alphabet characters', () => {
    expect(isValidSessionToken('000000000000')).toBe(true)
    expect(isValidSessionToken('ZZZZZZZZZZZZ')).toBe(true)
    expect(isValidSessionToken('0123456789AB')).toBe(true)
  })

  it('rejects every near miss, and never throws on any of them', () => {
    const bad: unknown[] = [
      '',                 // no token at all - the "never been welcomed" value
      '00000000000',      // 11
      '0000000000000',    // 13
      '00000',            // a room code, not a token
      'zzzzzzzzzzzz',     // lowercase: the token is compared byte for byte
      'IIIIIIIIIIII',     // excluded symbols
      'LLLLLLLLLLLL',
      'OOOOOOOOOOOO',
      'UUUUUUUUUUUU',
      '00000000000-',
      '0000 0000000',
      null,
      undefined,
      12,
      {},
      ['0'],
    ]
    for (const value of bad) {
      expect(
        () => isValidSessionToken(value as string),
        `isValidSessionToken threw on ${String(value)}`,
      ).not.toThrow()
      expect(isValidSessionToken(value as string), `accepted ${String(value)}`).toBe(false)
    }
  })

  it('is a different shape from a room code, which is what stops the two being confused', () => {
    // F-P4-15. A token is a RECONNECT credential and a room code is a public
    // address that gets read aloud; a token that could pass as a code is a
    // token somebody types into a join box.
    expect(SESSION_TOKEN_LENGTH).not.toBe(ROOM_CODE_LENGTH)
    expect(isValidRoomCode('000000000000')).toBe(false)
    expect(isValidSessionToken('00000')).toBe(false)
  })
})

describe('LOBBY_PATH_PREFIX, frozen at the first signed release', () => {
  it('is /r/, and lobbyPathFor is built from it so the two cannot disagree', () => {
    // C-1. This string is compiled into the APK's `autoVerify` intent-filter
    // pathPrefix, matched case-sensitively and prefix-exactly. A mismatch
    // between the server's routing and the APK is a SILENT App Links failure:
    // the tap opens a browser instead of the app, and on Android 12+ a failed
    // verification shows no chooser and logs nothing the developer will see.
    expect(LOBBY_PATH_PREFIX).toBe('/r/')
    expect(lobbyPathFor('0ABCD')).toBe('/r/0ABCD')
    expect(lobbyPathFor('ZZZZZ')).toBe(`${LOBBY_PATH_PREFIX}ZZZZZ`)
    // A path, never an absolute URL: the server answers with paths and the
    // client builds the origin (C-3). No host may appear anywhere in src.
    expect(lobbyPathFor('0ABCD')).not.toMatch(/:\/\//)
  })

  it('rejects a four-character code - the length this protocol used to have', () => {
    // F-P4-34 took the code from four characters to five, which is the whole
    // reason PROTOCOL_VERSION moved to 2. A path built from a stale-length code
    // is a link that silently goes nowhere, and this is the last point at which
    // that is still visible.
    expect(() => lobbyPathFor('ABCD')).toThrow()
    expect(isValidRoomCode('ABCD')).toBe(false)
  })

  it('normalizes before it validates, and substitutes nothing', () => {
    expect(lobbyPathFor('  0abcd  ')).toBe('/r/0ABCD')
    // No confusable folding: O does not become 0 and I does not become 1. A
    // second silent transformation of user input can only send a player to a
    // DIFFERENT REAL ROOM, which is worse than an "invalid code" message.
    expect(() => lobbyPathFor('OABCD')).toThrow()
    expect(() => lobbyPathFor('IABCD')).toThrow()
  })
})
