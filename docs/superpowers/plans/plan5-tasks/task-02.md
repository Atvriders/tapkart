### Task 2: `packages/invite/src/uri.ts` — the NDEF URI record and the NDEF file

**Files:**
- Create: `packages/invite/src/uri.ts`
- Modify: `packages/invite/src/index.ts` — append one re-export line
- Test: `packages/invite/test/uri.test.ts`

**Interfaces:**

- **Consumes** — `packages/invite/src/hex.ts` (Task 1), for error-message formatting and for the tests' one spelling of hex:

  ```ts
  export function bytesToHex(b: Uint8Array): string
  export function hexToBytes(s: string): Uint8Array
  ```

  `packages/invite/src/index.ts` as it stands after Task 1, whole file:

  ```ts
  // The barrel. Contract §4.8: it re-exports all nine modules of this package,
  // because all nine are pure and headless-safe — this package has no adapter half
  // to keep out of the barrel. It grows ONE LINE PER MODULE as the modules land,
  // so that `tsc` never points at a file that does not exist yet.
  export * from './hex'
  ```

- **Produces** — contract §4.2, exactly six exports:

  ```ts
  export const NDEF_URI_PREFIXES: readonly string[]
  export const MAX_INVITE_URI_BYTES = 250
  export function encodeUriRecord(uri: string): Uint8Array
  export function decodeUriRecord(rec: Uint8Array): string
  export function buildNdefFile(uri: string | null): Uint8Array
  export function parseNdefFile(file: Uint8Array): string | null
  ```

**This module is mirrored in Kotlin (`nfc/NdefUri.kt`, contract §7.3) and both
implementations are driven from one shared fixture, so every byte and every
decision below is normative rather than incidental.** Three of them are decisions
a second implementer could otherwise make differently:

1. **Prefix selection is longest-match.** `NDEF_URI_PREFIXES` is scanned from
   index 1 upward and the **strictly longest** matching abbreviation wins, so
   `urn:epc:id:x` abbreviates with `0x1E` and not with `0x13` (`urn:`). Ties are
   impossible because the table holds no two equal strings. Index `0x00` (no
   abbreviation) is the fallback when nothing matches.
2. **UTF-8 is hand-written here, not `TextEncoder`.** §4.3 rejects the ambient
   global `URL` because *"its presence depends on the lib/@types configuration of
   whoever imports this package"* — and `TextEncoder` is the same ambient global
   in a different hat. `packages/invite/tsconfig.json` has no `DOM` lib, and the
   Android build reaches this package too. Forty lines of explicit encoding have
   neither failure mode and make the Kotlin mirror an exact transliteration.
3. **An unpaired surrogate throws.** Java's `String.getBytes(UTF_8)` substitutes
   `?` for one; a hand-written encoder that emits `ED A0 80` would be silently
   byte-divergent from the Kotlin mirror at exactly the input nobody tests. It
   cannot arise through the product path — Task 3 validates the origin and the
   room code before either reaches here — so throwing costs nothing and closes
   the divergence.

**Where the two length caps meet, stated so nobody folds them into one.**
`encodeUriRecord` throws on *the encoded payload exceeding 255 bytes*, which is
the wall the record format actually imposes: a short record's payload-length
field is one byte. `MAX_INVITE_URI_BYTES = 250` is the **budget** the invite
builder spends inside that wall, and it is proven to be a safe budget by test
(`MAX_INVITE_URI_BYTES + 1 <= 255`, and a URI of exactly 250 bytes encodes).
Making 250 the throw would put a second, tighter wall in the encoder that the
contract's sentence does not describe; leaving 250 unasserted would make it
decoration. It is asserted, and it is not the throw.

- [ ] **Step 1: Write the failing test**

Create `packages/invite/test/uri.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/invite/test/uri.test.ts`

Expected: **FAIL at collect time**:

```
Error: Failed to resolve import "../src/uri" from "packages/invite/test/uri.test.ts". Does the file exist?
```

- [ ] **Step 3: Write the implementation**

Create `packages/invite/src/uri.ts`:

```ts
// PURE. Mirrored in Kotlin (nfc/NdefUri.kt, contract §7.3) and driven from the
// same fixture, so every byte here is normative. No DOM, no clock, no I/O, and
// no ambient global — not even TextEncoder.
import { bytesToHex } from './hex'

/** NFC Forum URI Record Type Definition, abbreviation table, index 0x00..0x23.
 *  Index 0x04 is 'https://' and is the only one this game ever emits. */
export const NDEF_URI_PREFIXES: readonly string[] = [
  '', // 0x00 — no abbreviation
  'http://www.', // 0x01
  'https://www.', // 0x02
  'http://', // 0x03
  'https://', // 0x04
  'tel:', // 0x05
  'mailto:', // 0x06
  'ftp://anonymous:anonymous@', // 0x07
  'ftp://ftp.', // 0x08
  'ftps://', // 0x09
  'sftp://', // 0x0A
  'smb://', // 0x0B
  'nfs://', // 0x0C
  'ftp://', // 0x0D
  'dav://', // 0x0E
  'news:', // 0x0F
  'telnet://', // 0x10
  'imap:', // 0x11
  'rtsp://', // 0x12
  'urn:', // 0x13
  'pop:', // 0x14
  'sip:', // 0x15
  'sips:', // 0x16
  'tftp:', // 0x17
  'btspp://', // 0x18
  'btl2cap://', // 0x19
  'btgoep://', // 0x1A
  'tcpobex://', // 0x1B
  'irdaobex://', // 0x1C
  'file://', // 0x1D
  'urn:epc:id:', // 0x1E
  'urn:epc:tag:', // 0x1F
  'urn:epc:pat:', // 0x20
  'urn:epc:raw:', // 0x21
  'urn:epc:', // 0x22
  'urn:nfc:', // 0x23
]

/** A short NDEF record's payload length field is one byte. 250 leaves margin
 *  under 255 for the 'https://' abbreviation and the room code.
 *
 *  This is the invite builder's BUDGET, not the encoder's wall: the wall is 255
 *  and it lives in encodeUriRecord, because that is what the record format
 *  imposes. Task 3 spends this budget and a test proves it fits. */
export const MAX_INVITE_URI_BYTES = 250

/** MB=1 ME=1 CF=0 SR=1 IL=0 TNF=001 — a single short well-known record. */
const URI_RECORD_HEADER = 0xd1
/** Type 'U'. */
const URI_RECORD_TYPE = 0x55
/** The largest value a short record's one-byte payload length field can hold. */
const MAX_SHORT_PAYLOAD = 255

function hex2(b: number): string {
  return bytesToHex(Uint8Array.from([b]))
}

/** UTF-8, hand-written. `TextEncoder` is an ambient global whose presence
 *  depends on the lib/@types configuration of whoever imports this package, and
 *  this package must typecheck with no DOM lib and be reachable from the Android
 *  build. Throws on an unpaired surrogate: Java substitutes '?' for one, so
 *  emitting ED A0 80 here would be a silent byte divergence from the Kotlin
 *  mirror at exactly the input nobody tests. */
function utf8Encode(s: string): Uint8Array {
  // `s` is the record payload — the URI with its abbreviated prefix already
  // removed — so the index in the error message is an index into that.
  const out: number[] = []
  for (let i = 0; i < s.length; i++) {
    let cp = s.charCodeAt(i)
    if (cp >= 0xd800 && cp <= 0xdbff) {
      const lo = i + 1 < s.length ? s.charCodeAt(i + 1) : 0
      if (lo < 0xdc00 || lo > 0xdfff) {
        throw new Error(`encodeUriRecord: unpaired surrogate at index ${i} of the record payload`)
      }
      cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00)
      i++
    } else if (cp >= 0xdc00 && cp <= 0xdfff) {
      throw new Error(`encodeUriRecord: unpaired surrogate at index ${i}`)
    }
    if (cp < 0x80) {
      out.push(cp)
    } else if (cp < 0x800) {
      out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f))
    } else if (cp < 0x10000) {
      out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f))
    } else {
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      )
    }
  }
  return Uint8Array.from(out)
}

/** UTF-8, strict. Bytes reaching here came off a radio, so overlong forms,
 *  surrogate code points and truncated sequences are errors rather than
 *  replacement characters — `readInvite` turns the throw into `null`. */
function utf8Decode(b: Uint8Array): string {
  let out = ''
  let i = 0
  while (i < b.length) {
    const lead = b[i]
    let cp: number
    let need: number
    let min: number
    if (lead < 0x80) {
      cp = lead
      need = 0
      min = 0x00
    } else if ((lead & 0xe0) === 0xc0) {
      cp = lead & 0x1f
      need = 1
      min = 0x80
    } else if ((lead & 0xf0) === 0xe0) {
      cp = lead & 0x0f
      need = 2
      min = 0x800
    } else if ((lead & 0xf8) === 0xf0) {
      cp = lead & 0x07
      need = 3
      min = 0x10000
    } else {
      throw new Error(`utf8Decode: invalid lead byte 0x${hex2(lead)} at index ${i}`)
    }
    if (i + need >= b.length) {
      throw new Error(`utf8Decode: truncated sequence at index ${i}`)
    }
    for (let k = 1; k <= need; k++) {
      const cont = b[i + k]
      if ((cont & 0xc0) !== 0x80) {
        throw new Error(`utf8Decode: invalid continuation byte 0x${hex2(cont)} at index ${i + k}`)
      }
      cp = (cp << 6) | (cont & 0x3f)
    }
    if (cp < min) throw new Error(`utf8Decode: overlong encoding at index ${i}`)
    if (cp > 0x10ffff) throw new Error(`utf8Decode: code point out of range at index ${i}`)
    if (cp >= 0xd800 && cp <= 0xdfff) {
      throw new Error(`utf8Decode: surrogate code point at index ${i}`)
    }
    if (cp >= 0x10000) {
      const v = cp - 0x10000
      out += String.fromCharCode(0xd800 + (v >> 10), 0xdc00 + (v & 0x3ff))
    } else {
      out += String.fromCharCode(cp)
    }
    i += need + 1
  }
  return out
}

/** Single well-known URI record: MB=1 ME=1 CF=0 SR=1 IL=0 TNF=001 -> 0xD1,
 *  type 'U' (0x55), payload = [prefixCode, ...rest]. Throws if the encoded
 *  payload would exceed 255 bytes. Emits NO Android Application Record (§7.5).
 *
 *  Prefix selection is LONGEST MATCH over indices 1..0x23, so 'urn:epc:id:x'
 *  abbreviates with 0x1E and not with 0x13. The table holds no two equal
 *  strings, so the longest match is unique and both languages pick it. */
export function encodeUriRecord(uri: string): Uint8Array {
  let prefixCode = 0
  let prefixLength = 0
  for (let i = 1; i < NDEF_URI_PREFIXES.length; i++) {
    const candidate = NDEF_URI_PREFIXES[i]
    if (candidate.length > prefixLength && uri.startsWith(candidate)) {
      prefixCode = i
      prefixLength = candidate.length
    }
  }
  const rest = utf8Encode(uri.slice(prefixLength))
  const payloadLength = 1 + rest.length
  if (payloadLength > MAX_SHORT_PAYLOAD) {
    throw new Error(
      `encodeUriRecord: payload is ${payloadLength} bytes, over the ${MAX_SHORT_PAYLOAD}-byte short-record limit`,
    )
  }
  const out = new Uint8Array(4 + payloadLength)
  out[0] = URI_RECORD_HEADER
  out[1] = 0x01
  out[2] = payloadLength
  out[3] = URI_RECORD_TYPE
  out[4] = prefixCode
  out.set(rest, 5)
  return out
}

/** Inverse. Throws on a record that is not a single well-known 'U' record.
 *  The header byte is compared for EQUALITY with 0xD1 rather than masked: a
 *  chunked, multi-record or long-form record is not something this tag emits or
 *  this reader accepts, and a mask would quietly accept all three. */
export function decodeUriRecord(rec: Uint8Array): string {
  if (rec.length < 4) {
    throw new Error(`decodeUriRecord: record is ${rec.length} bytes, shorter than the 4-byte header`)
  }
  if (rec[0] !== URI_RECORD_HEADER) {
    throw new Error(
      `decodeUriRecord: header is 0x${hex2(rec[0])}, not 0xD1 (single short well-known record)`,
    )
  }
  if (rec[1] !== 0x01) {
    throw new Error(`decodeUriRecord: type length is ${rec[1]}, not 1`)
  }
  if (rec[3] !== URI_RECORD_TYPE) {
    throw new Error(`decodeUriRecord: type byte is 0x${hex2(rec[3])}, not 0x55 ('U')`)
  }
  const payloadLength = rec[2]
  if (rec.length !== 4 + payloadLength) {
    throw new Error(
      `decodeUriRecord: declared payload length ${payloadLength} does not match the ${rec.length - 4} bytes present`,
    )
  }
  if (payloadLength < 1) {
    throw new Error('decodeUriRecord: payload is empty; a URI record carries at least a prefix code')
  }
  const prefixCode = rec[4]
  if (prefixCode >= NDEF_URI_PREFIXES.length) {
    throw new Error(
      `decodeUriRecord: prefix code 0x${hex2(prefixCode)} is outside the abbreviation table (0x00..0x23)`,
    )
  }
  return NDEF_URI_PREFIXES[prefixCode] + utf8Decode(rec.subarray(5))
}

/** NLEN (u16 big-endian) followed by the message. `null` yields exactly
 *  `[0x00, 0x00]` — a valid, empty, readable tag (§5.6). */
export function buildNdefFile(uri: string | null): Uint8Array {
  if (uri === null) return Uint8Array.from([0x00, 0x00])
  const rec = encodeUriRecord(uri)
  const out = new Uint8Array(2 + rec.length)
  out[0] = (rec.length >> 8) & 0xff
  out[1] = rec.length & 0xff
  out.set(rec, 2)
  return out
}

/** Inverse. Returns null for NLEN === 0. Throws if NLEN exceeds the buffer. */
export function parseNdefFile(file: Uint8Array): string | null {
  if (file.length < 2) {
    throw new Error(`parseNdefFile: file is ${file.length} bytes, shorter than the 2-byte NLEN`)
  }
  const nlen = (file[0] << 8) | file[1]
  if (nlen === 0) return null
  if (2 + nlen > file.length) {
    throw new Error(
      `parseNdefFile: NLEN ${nlen} exceeds the ${file.length - 2} message bytes present`,
    )
  }
  return decodeUriRecord(file.subarray(2, 2 + nlen))
}
```

Append to `packages/invite/src/index.ts`, below the `./hex` line:

```ts
export * from './uri'
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run packages/invite/test/uri.test.ts
npm run typecheck -w @tapkart/invite
npx vitest run
```

Expected: **36 passed** in `uri.test.ts` (3 table + 12 encode + 2 budget +
11 decode + 8 file), no typecheck output, and no new failures anywhere.

If the golden record assertion fails by two hex characters at offset 4, the
prefix code is wrong; if it fails at offset 2, the payload length was counted in
characters rather than bytes. Neither is fixed by editing `GOLDEN_RECORD_HEX` —
those bytes are contract §5.7 and the Kotlin mirror replays them.

- [ ] **Step 5: Commit**

```bash
git add packages/invite/src/uri.ts packages/invite/src/index.ts packages/invite/test/uri.test.ts && git commit -m "feat(invite): NDEF URI record and NDEF file codec"
```
