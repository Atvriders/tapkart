import { describe, expect, it } from 'vitest'
import {
  LOBBY_PATH_PREFIX,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  isValidRoomCode,
  lobbyPathFor,
  normalizeRoomCode,
} from '../src/room'

describe('room codes live in @tapkart/protocol (Task 15c item E)', () => {
  it('fixes a 32-symbol alphabet with no repeated symbol', () => {
    expect(ROOM_CODE_ALPHABET).toHaveLength(32)
    expect(new Set(ROOM_CODE_ALPHABET).size).toBe(32)
    // Uppercase and digits only: the code is typed on a phone keyboard and read
    // off a screen across a room.
    expect(ROOM_CODE_ALPHABET).toBe(ROOM_CODE_ALPHABET.toUpperCase())
    expect(/^[0-9A-Z]+$/.test(ROOM_CODE_ALPHABET)).toBe(true)
  })

  it('excludes the four glyph pairs a reader confuses, so no code can contain them', () => {
    // I/1, L/1, O/0 and U/V are the Crockford exclusions. This is not cosmetic:
    // the code is read aloud and typed by someone across a room, and a
    // one-glyph misread sends them to a room that exists.
    for (const c of ['I', 'L', 'O', 'U']) {
      expect(ROOM_CODE_ALPHABET.includes(c), `${c} is confusable and must not be in the alphabet`).toBe(false)
      expect(isValidRoomCode(c.repeat(ROOM_CODE_LENGTH))).toBe(false)
    }
  })

  it('is FIVE characters, not four: 32^5 keyspace', () => {
    // The ruling. 32^4 is 1,048,576 -- small enough to sweep from one host in
    // the ten minutes a room lives, and this project has already been bitten by
    // a Cloudflare Tunnel collapsing every request onto one TCP peer, which
    // defeats IP-keyed rate limiting outright. 32^5 is 32x the space for one
    // more typed character.
    expect(ROOM_CODE_LENGTH).toBe(5)
    expect(ROOM_CODE_ALPHABET.length ** ROOM_CODE_LENGTH).toBe(33_554_432)
    expect(isValidRoomCode('ABCDE')).toBe(true)
    // Four characters was the old size and must now be rejected, not merely
    // "not preferred" -- a server that still mints four would otherwise mint
    // codes its own validator accepts.
    expect(isValidRoomCode('ABCD')).toBe(false)
    expect(isValidRoomCode('ABCDEF')).toBe(false)
  })

  it('normalizes case and surrounding whitespace, and nothing else', () => {
    expect(normalizeRoomCode('abcde')).toBe('ABCDE')
    expect(normalizeRoomCode('  aBcDe \n')).toBe('ABCDE')
    // Not a validator: normalize is total, and hands back whatever it was given
    // in canonical form so a caller can validate ONE representation.
    expect(normalizeRoomCode('abc')).toBe('ABC')
    expect(normalizeRoomCode('')).toBe('')
    // No inner-space or punctuation stripping is claimed, so none is asserted;
    // a code with a space inside it is simply invalid.
    expect(isValidRoomCode(normalizeRoomCode('ab cd'))).toBe(false)
  })

  it('validates the normalized form only, so lowercase input is invalid until normalized', () => {
    // The URL path is matched case-SENSITIVELY by the APK's App Links
    // pathPrefix, so 'abcde' and 'ABCDE' are not interchangeable on the wire.
    // The validator therefore rejects the un-normalized form rather than
    // quietly accepting both, which is what forces callers through
    // normalizeRoomCode before they route on a code.
    expect(isValidRoomCode('abcde')).toBe(false)
    expect(isValidRoomCode(normalizeRoomCode('abcde'))).toBe(true)
  })

  it('rejects non-string and structurally wrong input without throwing', () => {
    // [label, value] rows, never a bare array of values: it.each SPREADS an
    // array row, so a row of `[]` would arrive as zero arguments and silently
    // re-test `undefined` while claiming to test an empty array.
    const rows: Array<[string, unknown]> = [
      ['null', null],
      ['undefined', undefined],
      ['a number', 42],
      ['an empty array', []],
      ['a boolean', true],
      ['an object', { code: 'ABCDE' }],
      ['a 5-element array of characters', ['A', 'B', 'C', 'D', 'E']],
    ]
    for (const [label, value] of rows) {
      expect(isValidRoomCode(value as string), `${label} must be rejected`).toBe(false)
    }
  })

  it('exports the lobby path prefix as ONE constant, frozen at the first signed release', () => {
    // Compiled into the APK's autoVerify intent-filter pathPrefix. A server
    // that routes /room/ while the APK verifies /r/ is a SILENT App Links
    // failure: the tap opens a browser, nothing logs an error anywhere. Two
    // constants that agree today is exactly the arrangement that breaks.
    expect(LOBBY_PATH_PREFIX).toBe('/r/')
    expect(LOBBY_PATH_PREFIX.startsWith('/')).toBe(true)
    expect(LOBBY_PATH_PREFIX.endsWith('/')).toBe(true)
    expect(lobbyPathFor('ABCDE')).toBe('/r/ABCDE')
    // Built FROM the constant, so a change to the prefix cannot leave the path
    // builder behind.
    expect(lobbyPathFor('ABCDE').startsWith(LOBBY_PATH_PREFIX)).toBe(true)
    // Normalizes on the way in: a typed lowercase code must not produce a path
    // the pathPrefix match then misses.
    expect(lobbyPathFor('abcde')).toBe('/r/ABCDE')
    expect(() => lobbyPathFor('ABCD')).toThrow(/room code/)
  })
})

describe('@tapkart/protocol barrel: room codes', () => {
  it('re-exports every room-code symbol, since game, server and invite all reach them through the barrel', async () => {
    const pkg = await import('@tapkart/protocol')
    expect(pkg.ROOM_CODE_ALPHABET).toBe(ROOM_CODE_ALPHABET)
    expect(pkg.ROOM_CODE_LENGTH).toBe(ROOM_CODE_LENGTH)
    expect(pkg.LOBBY_PATH_PREFIX).toBe(LOBBY_PATH_PREFIX)
    expect(typeof pkg.normalizeRoomCode).toBe('function')
    expect(typeof pkg.isValidRoomCode).toBe('function')
    expect(typeof pkg.lobbyPathFor).toBe('function')
  })
})
