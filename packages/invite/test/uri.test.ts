import { describe, expect, it } from 'vitest'
import { bytesToHex, hexToBytes } from '../src/hex'
import {
  MAX_INVITE_URI_BYTES,
  NDEF_URI_PREFIXES,
  buildNdefFile,
  decodeUriRecord,
  encodeUriRecord,
  parseNdefFile,
} from '../src/uri'

/** Contract §5.7, copied verbatim. The 30-byte NDEF file for
 *  `https://tapkart.example/r/ABCDE`. NOT recomputed from a description. */
const GOLDEN_URI = 'https://tapkart.example/r/ABCDE'
const GOLDEN_FILE_HEX = '001CD1011855047461706B6172742E6578616D706C652F722F4142434445'
/** The same bytes minus the two NLEN bytes: the record itself. */
const GOLDEN_RECORD_HEX = 'D1011855047461706B6172742E6578616D706C652F722F4142434445'

describe('NDEF_URI_PREFIXES — the NFC Forum URI RTD abbreviation table', () => {
  it('holds indices 0x00..0x23, which is 36 entries', () => {
    expect(NDEF_URI_PREFIXES.length).toBe(0x24)
  })

  it('pins the entries this game and its tests depend on', () => {
    expect(NDEF_URI_PREFIXES[0x00]).toBe('')
    expect(NDEF_URI_PREFIXES[0x01]).toBe('http://www.')
    expect(NDEF_URI_PREFIXES[0x02]).toBe('https://www.')
    expect(NDEF_URI_PREFIXES[0x03]).toBe('http://')
    expect(NDEF_URI_PREFIXES[0x04]).toBe('https://')
    expect(NDEF_URI_PREFIXES[0x05]).toBe('tel:')
    expect(NDEF_URI_PREFIXES[0x06]).toBe('mailto:')
    expect(NDEF_URI_PREFIXES[0x13]).toBe('urn:')
    expect(NDEF_URI_PREFIXES[0x1e]).toBe('urn:epc:id:')
    expect(NDEF_URI_PREFIXES[0x23]).toBe('urn:nfc:')
  })

  it('contains no duplicate abbreviation, so longest-match is unambiguous', () => {
    const seen = new Set(NDEF_URI_PREFIXES.slice(1))
    expect(seen.size).toBe(NDEF_URI_PREFIXES.length - 1)
  })
})

describe('encodeUriRecord', () => {
  it('produces the golden record of contract §5.7, byte for byte', () => {
    expect(bytesToHex(encodeUriRecord(GOLDEN_URI))).toBe(GOLDEN_RECORD_HEX)
  })

  it('spells out the golden record header, field by field', () => {
    const rec = encodeUriRecord(GOLDEN_URI)
    expect(rec.length).toBe(28)
    expect(rec[0]).toBe(0xd1) // MB=1 ME=1 CF=0 SR=1 IL=0 TNF=001
    expect(rec[1]).toBe(0x01) // type length
    expect(rec[2]).toBe(0x18) // payload length = 24 = 1 prefix byte + 23 URI bytes
    expect(rec[3]).toBe(0x55) // type 'U'
    expect(rec[4]).toBe(0x04) // prefix code: 'https://'
    expect(bytesToHex(rec.subarray(5))).toBe('7461706B6172742E6578616D706C652F722F4142434445')
  })

  it('emits NO Android Application Record — ME=1 says this record is the last (§7.5)', () => {
    const rec = encodeUriRecord(GOLDEN_URI)
    expect(rec[0] & 0x40).toBe(0x40) // ME
    expect(rec.length).toBe(4 + rec[2]) // and nothing follows the payload
  })

  it('abbreviates with the LONGEST matching prefix, not the first', () => {
    const rec = encodeUriRecord('urn:epc:id:sgtin:0000')
    expect(rec[4]).toBe(0x1e) // 'urn:epc:id:', not 0x13 'urn:'
    expect(bytesToHex(rec.subarray(5))).toBe('736774696E3A30303030') // 'sgtin:0000'
  })

  it('abbreviates https://www. with 0x02 rather than 0x04', () => {
    expect(encodeUriRecord('https://www.tapkart.example/r/ABCDE')[4]).toBe(0x02)
  })

  it('falls back to prefix code 0x00 and the whole string when nothing matches', () => {
    const rec = encodeUriRecord('zz:payload')
    expect(rec[4]).toBe(0x00)
    expect(bytesToHex(rec.subarray(5))).toBe('7A7A3A7061796C6F6164')
  })

  it('encodes a two-byte UTF-8 character as UTF-8, not as one byte per char', () => {
    const rec = encodeUriRecord('mailto:é@tapkart.example')
    expect(rec[4]).toBe(0x06) // 'mailto:'
    expect(rec[2]).toBe(0x13) // payload = 1 + 18 bytes
    expect(bytesToHex(rec)).toBe('D101135506C3A9407461706B6172742E6578616D706C65')
  })

  it('encodes a surrogate pair as one four-byte sequence', () => {
    const rec = encodeUriRecord('https://tapkart.example/r/\u{1F600}')
    expect(rec[2]).toBe(0x17) // payload = 1 + 22 bytes
    expect(bytesToHex(rec.subarray(rec.length - 4))).toBe('F09F9880')
  })

  /** The index is into the record payload — the URI with its abbreviated prefix
   *  already removed — because that is the string the encoder is walking.
   *  'tapkart.example' (15) + '/r/' (3) puts the lone high surrogate at 18. */
  it('throws on an unpaired surrogate rather than diverging from Kotlin', () => {
    expect(() => encodeUriRecord('https://tapkart.example/r/\ud800')).toThrow(
      'encodeUriRecord: unpaired surrogate at index 18 of the record payload',
    )
  })

  it('throws on a lone low surrogate too', () => {
    expect(() => encodeUriRecord('https://tapkart.example/r/\udc00')).toThrow(
      'encodeUriRecord: unpaired surrogate at index 18 of the record payload',
    )
  })

  it('accepts a payload of exactly 255 bytes', () => {
    const rec = encodeUriRecord(`https://${'a'.repeat(254)}`)
    expect(rec[2]).toBe(255)
    expect(rec.length).toBe(259)
  })

  it('throws when the encoded payload would exceed 255 bytes', () => {
    expect(() => encodeUriRecord(`https://${'a'.repeat(255)}`)).toThrow(
      'encodeUriRecord: payload is 256 bytes, over the 255-byte short-record limit',
    )
  })
})

describe('MAX_INVITE_URI_BYTES is a budget inside the 255-byte wall, and is proven so', () => {
  it('leaves room for the prefix byte', () => {
    expect(MAX_INVITE_URI_BYTES).toBe(250)
    expect(MAX_INVITE_URI_BYTES + 1).toBeLessThanOrEqual(255)
  })

  it('encodes a URI of exactly MAX_INVITE_URI_BYTES bytes', () => {
    const uri = `https://${'a'.repeat(226)}.example/r/ABCDE`
    expect(uri.length).toBe(MAX_INVITE_URI_BYTES)
    const rec = encodeUriRecord(uri)
    expect(rec[2]).toBe(243) // 1 prefix byte + 242 bytes after 'https://'
  })
})

describe('decodeUriRecord', () => {
  it('inverts the golden record', () => {
    expect(decodeUriRecord(hexToBytes(GOLDEN_RECORD_HEX))).toBe(GOLDEN_URI)
  })

  it('restores the abbreviated prefix from the table', () => {
    // D1 01 06 55 | 03 'test.'  -> prefix 0x03 is 'http://'
    expect(decodeUriRecord(hexToBytes('D101065503746573742E'))).toBe('http://test.')
  })

  it('rejects a record whose header is not 0xD1', () => {
    expect(() => decodeUriRecord(hexToBytes('91011855047461'))).toThrow(
      'decodeUriRecord: header is 0x91, not 0xD1 (single short well-known record)',
    )
  })

  it('rejects a type length other than 1', () => {
    expect(() => decodeUriRecord(hexToBytes('D102185504'))).toThrow(
      'decodeUriRecord: type length is 2, not 1',
    )
  })

  it("rejects a type byte other than 'U'", () => {
    // Length-consistent on purpose, so this proves the type check and not the
    // length check: D1 01 02 54 | 04 'A'.
    expect(() => decodeUriRecord(hexToBytes('D10102540441'))).toThrow(
      "decodeUriRecord: type byte is 0x54, not 0x55 ('U')",
    )
  })

  it('rejects a declared payload length that does not match the bytes present', () => {
    expect(() => decodeUriRecord(hexToBytes('D1011855047461'))).toThrow(
      'decodeUriRecord: declared payload length 24 does not match the 3 bytes present',
    )
  })

  it('rejects an empty payload', () => {
    // D1 01 00 55 — well formed, declared length 0, and therefore no prefix code.
    expect(() => decodeUriRecord(hexToBytes('D1010055'))).toThrow(
      'decodeUriRecord: payload is empty; a URI record carries at least a prefix code',
    )
  })

  it('rejects a prefix code outside the abbreviation table', () => {
    expect(() => decodeUriRecord(hexToBytes('D10102552461'))).toThrow(
      'decodeUriRecord: prefix code 0x24 is outside the abbreviation table (0x00..0x23)',
    )
  })

  it('rejects a record shorter than its four-byte header', () => {
    expect(() => decodeUriRecord(hexToBytes('D10118'))).toThrow(
      'decodeUriRecord: record is 3 bytes, shorter than the 4-byte header',
    )
  })

  it('rejects malformed UTF-8 rather than emitting replacement characters', () => {
    // D1 01 02 55 | 04 C3 — a two-byte lead with no continuation byte. The index
    // is into the bytes AFTER the prefix code, where C3 sits at 0.
    expect(() => decodeUriRecord(hexToBytes('D101025504C3'))).toThrow(
      'utf8Decode: truncated sequence at index 0',
    )
  })

  it('rejects an overlong encoding', () => {
    // D1 01 03 55 | 04 C0 80 — C0 80 is an overlong encoding of U+0000.
    expect(() => decodeUriRecord(hexToBytes('D101035504C080'))).toThrow(
      'utf8Decode: overlong encoding at index 0',
    )
  })
})

describe('buildNdefFile / parseNdefFile', () => {
  it('produces the 30-byte golden file of contract §5.7, byte for byte', () => {
    const file = buildNdefFile(GOLDEN_URI)
    expect(bytesToHex(file)).toBe(GOLDEN_FILE_HEX)
    expect(file.length).toBe(30)
  })

  it('writes NLEN as a big-endian u16', () => {
    const file = buildNdefFile(GOLDEN_URI)
    expect(file[0]).toBe(0x00)
    expect(file[1]).toBe(0x1c) // 28 = the record length
    expect((file[0] << 8) | file[1]).toBe(file.length - 2)
  })

  it('yields exactly [0x00, 0x00] for null — a valid, empty, readable tag', () => {
    const file = buildNdefFile(null)
    expect(bytesToHex(file)).toBe('0000')
    expect(file.length).toBe(2)
  })

  it('parses the golden file back to the golden URI', () => {
    expect(parseNdefFile(hexToBytes(GOLDEN_FILE_HEX))).toBe(GOLDEN_URI)
  })

  it('returns null for NLEN === 0', () => {
    expect(parseNdefFile(hexToBytes('0000'))).toBeNull()
  })

  it('throws when NLEN exceeds the buffer', () => {
    expect(() => parseNdefFile(hexToBytes('001CD1011855'))).toThrow(
      'parseNdefFile: NLEN 28 exceeds the 4 message bytes present',
    )
  })

  it('throws on a file shorter than its two-byte NLEN', () => {
    expect(() => parseNdefFile(hexToBytes('00'))).toThrow(
      'parseNdefFile: file is 1 bytes, shorter than the 2-byte NLEN',
    )
  })

  /** Consistency only. The evidence is GOLDEN_FILE_HEX above: a round trip
   *  proves the two functions agree with each other, not that either matches the
   *  NFC Forum URI RTD. */
  it('round-trips a second origin, as a consistency check only', () => {
    const uri = 'https://kart.example.com/r/ABCDE'
    expect(parseNdefFile(buildNdefFile(uri))).toBe(uri)
  })
})
