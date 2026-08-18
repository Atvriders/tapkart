import { describe, expect, it } from 'vitest'
import { LOBBY_PATH_PREFIX, ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from '@tapkart/protocol'
import { bytesToHex, hexToBytes } from '../src/hex'

describe('the one dependency (contract §4.0)', () => {
  /** Not a value assertion — Plan 4 owns those. This asserts that the bare
   *  specifier RESOLVES from inside packages/invite, which is the whole of what
   *  §4.0 claims and the only part this package can break. A repo-file read
   *  would be a third repo-reading test, which §1 forbids by name. */
  it('resolves @tapkart/protocol from inside packages/invite', () => {
    expect(typeof LOBBY_PATH_PREFIX).toBe('string')
    expect(LOBBY_PATH_PREFIX.length).toBeGreaterThan(0)
    expect(typeof ROOM_CODE_ALPHABET).toBe('string')
    expect(ROOM_CODE_ALPHABET.length).toBe(32)
    expect(ROOM_CODE_LENGTH).toBeGreaterThan(0)
  })
})

describe('bytesToHex', () => {
  it('emits uppercase, unseparated, zero-padded pairs', () => {
    expect(bytesToHex(Uint8Array.from([0x00, 0x0f, 0xa5, 0xff]))).toBe('000FA5FF')
  })

  it('emits the empty string for an empty array', () => {
    expect(bytesToHex(new Uint8Array(0))).toBe('')
  })

  /** Independent evidence, not a round trip: the expected string is built by a
   *  DIFFERENT method (Number#toString(16)) than the implementation's nibble
   *  table, for all 256 byte values. A byte that came out lowercase, unpadded,
   *  or nibble-swapped fails here. */
  it('agrees with Number#toString(16) for every one of the 256 byte values', () => {
    for (let v = 0; v <= 0xff; v++) {
      const expected = v.toString(16).toUpperCase().padStart(2, '0')
      expect(bytesToHex(Uint8Array.from([v]))).toBe(expected)
    }
  })

  it('never emits a separator, a lowercase digit, or an 0x prefix', () => {
    const all = new Uint8Array(256)
    for (let v = 0; v <= 0xff; v++) all[v] = v
    const hex = bytesToHex(all)
    expect(hex.length).toBe(512)
    expect(hex).toMatch(/^[0-9A-F]+$/)
  })
})

describe('hexToBytes', () => {
  it('reads the 15 CC bytes of contract §5.3 exactly', () => {
    // Copied verbatim from contract §5.3's "Full hex:" line. Not recomputed.
    const cc = hexToBytes('000F2000F600FF0406E104040000FF')
    expect(cc.length).toBe(15)
    expect(cc[0]).toBe(0x00)
    expect(cc[1]).toBe(0x0f)
    expect(cc[2]).toBe(0x20)
    expect(cc[14]).toBe(0xff)
  })

  it('accepts lowercase and embedded spaces', () => {
    const aid = hexToBytes('d2 76 00 00 85 01 01')
    expect(Array.from(aid)).toEqual([0xd2, 0x76, 0x00, 0x00, 0x85, 0x01, 0x01])
  })

  it('accepts mixed case', () => {
    expect(Array.from(hexToBytes('aAbB'))).toEqual([0xaa, 0xbb])
  })

  it('returns an empty array for an empty string and for spaces only', () => {
    expect(hexToBytes('').length).toBe(0)
    expect(hexToBytes('   ').length).toBe(0)
  })

  it('throws on an odd number of hex digits, counting after spaces are dropped', () => {
    expect(() => hexToBytes('9000A')).toThrow(
      "hexToBytes: '9000A' has an odd number of hex digits (5)",
    )
  })

  it('throws naming the offending character and its index', () => {
    expect(() => hexToBytes('90Z0')).toThrow("hexToBytes: 'Z' at index 2 is not a hex digit")
  })

  it('rejects a tab, which is the fixture column separator and never a hex digit', () => {
    expect(() => hexToBytes('90\t00')).toThrow('is not a hex digit')
  })

  /** This round trip is a consistency check, NOT the evidence. The evidence is
   *  the exact-literal assertions above: a round trip proves the two functions
   *  agree with each other, which they would also do if both were wrong. */
  it('round-trips every byte value, as a consistency check only', () => {
    const all = new Uint8Array(256)
    for (let v = 0; v <= 0xff; v++) all[v] = v
    expect(Array.from(hexToBytes(bytesToHex(all)))).toEqual(Array.from(all))
  })
})
