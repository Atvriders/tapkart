import { describe, expect, it } from 'vitest'
import { LOBBY_PATH_PREFIX, ROOM_CODE_LENGTH } from '@tapkart/protocol'
import {
  MAX_INVITE_ORIGIN_BYTES,
  buildInviteUri,
  originHost,
  parseInviteUri,
} from '../src/invite'
import { MAX_INVITE_URI_BYTES, encodeUriRecord } from '../src/uri'

/** Contract §1: the only origin, host and room code that may appear in a repo
 *  file. `tapkart.example` is RFC 2606; `ABCDE` is five characters (F-P4-34). */
const ORIGIN = 'https://tapkart.example'
const CODE = 'ABCDE'

describe('buildInviteUri', () => {
  it('builds the golden invite URI of contract §5.7', () => {
    expect(buildInviteUri(ORIGIN, CODE)).toBe('https://tapkart.example/r/ABCDE')
  })

  /** §12.2 assertion 6: the expected string is CONSTRUCTED from the imported
   *  constants, so the day Plan 4 changes the prefix or the code length this
   *  test says so instead of a phone opening a browser. */
  it('builds its path from LOBBY_PATH_PREFIX rather than a literal', () => {
    expect(buildInviteUri(ORIGIN, CODE)).toBe(`${ORIGIN}${LOBBY_PATH_PREFIX}${CODE}`)
    expect(CODE.length).toBe(ROOM_CODE_LENGTH)
  })

  it('upper-cases the room code', () => {
    expect(buildInviteUri(ORIGIN, 'abcde')).toBe(`${ORIGIN}${LOBBY_PATH_PREFIX}ABCDE`)
  })

  it('trims the room code, because normalizeRoomCode does', () => {
    expect(buildInviteUri(ORIGIN, ' abcde ')).toBe(`${ORIGIN}${LOBBY_PATH_PREFIX}ABCDE`)
  })

  it('accepts a second origin and a port', () => {
    expect(buildInviteUri('https://kart.example.com', CODE)).toBe(
      `https://kart.example.com${LOBBY_PATH_PREFIX}ABCDE`,
    )
    expect(buildInviteUri('https://kart.example.com:8443', CODE)).toBe(
      `https://kart.example.com:8443${LOBBY_PATH_PREFIX}ABCDE`,
    )
  })

  it('throws on a trailing slash', () => {
    expect(() => buildInviteUri('https://tapkart.example/', CODE)).toThrow(
      "buildInviteUri: origin 'https://tapkart.example/' has a trailing slash",
    )
  })

  it('throws on a non-https scheme', () => {
    expect(() => buildInviteUri('http://tapkart.example', CODE)).toThrow(
      "buildInviteUri: origin 'http://tapkart.example' is not https",
    )
  })

  it('throws on an origin that carries a path', () => {
    expect(() => buildInviteUri('https://tapkart.example/lobby', CODE)).toThrow(
      "buildInviteUri: origin 'https://tapkart.example/lobby' is not a bare https origin",
    )
  })

  it('accepts an origin of exactly MAX_INVITE_ORIGIN_BYTES bytes', () => {
    const origin = `https://${'a'.repeat(184)}.example`
    expect(origin.length).toBe(MAX_INVITE_ORIGIN_BYTES)
    expect(buildInviteUri(origin, CODE)).toBe(`${origin}${LOBBY_PATH_PREFIX}${CODE}`)
  })

  it('throws one byte over MAX_INVITE_ORIGIN_BYTES', () => {
    const origin = `https://${'a'.repeat(185)}.example`
    expect(origin.length).toBe(MAX_INVITE_ORIGIN_BYTES + 1)
    expect(() => buildInviteUri(origin, CODE)).toThrow(
      'buildInviteUri: origin is 201 bytes, over MAX_INVITE_ORIGIN_BYTES (200)',
    )
  })

  it('throws on every shape of bad room code', () => {
    // Four characters, six characters, and 'I' — which Crockford's base32 drops.
    for (const bad of ['ABCD', 'ABCDEF', 'ABCDI', '', 'AB CD']) {
      expect(() => buildInviteUri(ORIGIN, bad)).toThrow('is not a valid room code')
    }
  })
})

describe('parseInviteUri', () => {
  it('inverts buildInviteUri', () => {
    expect(parseInviteUri(buildInviteUri(ORIGIN, CODE))).toEqual({
      origin: ORIGIN,
      roomCode: CODE,
    })
  })

  it('returns the canonical room code for a lower-cased URI', () => {
    expect(parseInviteUri('https://tapkart.example/r/abcde')).toEqual({
      origin: ORIGIN,
      roomCode: 'ABCDE',
    })
  })

  it('keeps the port in the origin it returns', () => {
    expect(parseInviteUri('https://kart.example.com:8443/r/ABCDE')).toEqual({
      origin: 'https://kart.example.com:8443',
      roomCode: CODE,
    })
  })

  it('returns null — never throws — for every rejection', () => {
    const rejected = [
      '',
      'not a uri',
      'http://tapkart.example/r/ABCDE', // scheme
      'https://tapkart.example', // no path
      'https://tapkart.example/', // no prefix
      'https://tapkart.example/x/ABCDE', // wrong prefix
      'https://tapkart.example/r/', // no code
      'https://tapkart.example/r/ABCD', // four characters
      'https://tapkart.example/r/ABCDEF', // six characters
      'https://tapkart.example/r/ABCDE/', // trailing slash
      'https://tapkart.example/r/ABCDE/extra', // deeper path
      'https://tapkart.example/r/ABCDI', // 'I' is not in the alphabet
      'https:///r/ABCDE', // no host
    ]
    for (const uri of rejected) {
      expect(parseInviteUri(uri)).toBeNull()
    }
  })

  /** P5 Q14: the invite URI carries the room code and NOTHING else. This is the
   *  case `URL` would have normalised away, which is why this function is
   *  hand-parsed. */
  it('rejects any query string or fragment', () => {
    expect(parseInviteUri('https://tapkart.example/r/ABCDE?x=1')).toBeNull()
    expect(parseInviteUri('https://tapkart.example/r/ABCDE#f')).toBeNull()
    expect(parseInviteUri('https://tapkart.example/r/ABCDE?')).toBeNull()
    expect(parseInviteUri('https://tapkart.example/r/ABCDE#')).toBeNull()
    expect(parseInviteUri('https://tapkart.example/?a=b/r/ABCDE')).toBeNull()
  })
})

describe('originHost', () => {
  it('drops the scheme', () => {
    expect(originHost(ORIGIN)).toBe('tapkart.example')
  })

  it('drops the port, because android:host is a separate attribute', () => {
    expect(originHost('https://kart.example.com:8443')).toBe('kart.example.com')
  })

  it('returns null for anything that is not an https origin', () => {
    expect(originHost('http://tapkart.example')).toBeNull()
    expect(originHost('tapkart.example')).toBeNull()
    expect(originHost('https://tapkart.example/')).toBeNull()
    expect(originHost('https://tapkart.example/r/ABCDE')).toBeNull()
    expect(originHost('')).toBeNull()
  })
})

describe('the origin budget fits inside the record, and is proven to', () => {
  /** Contract §4.3: the cap exists so buildInviteUri can NEVER produce an
   *  un-encodable record. Every term is imported, so a change in Plan 4 or in
   *  Task 2 fails here rather than on a radio. */
  it('leaves the longest possible invite URI inside MAX_INVITE_URI_BYTES', () => {
    expect(MAX_INVITE_ORIGIN_BYTES + LOBBY_PATH_PREFIX.length + ROOM_CODE_LENGTH).toBeLessThanOrEqual(
      MAX_INVITE_URI_BYTES,
    )
  })

  it('encodes the longest invite URI this game can build', () => {
    const origin = `https://${'a'.repeat(184)}.example`
    const uri = buildInviteUri(origin, CODE)
    expect(uri.length).toBe(MAX_INVITE_ORIGIN_BYTES + LOBBY_PATH_PREFIX.length + ROOM_CODE_LENGTH)
    const rec = encodeUriRecord(uri)
    expect(rec[2]).toBe(uri.length - 'https://'.length + 1)
  })
})
