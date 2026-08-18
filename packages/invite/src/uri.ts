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
      throw new Error(`encodeUriRecord: unpaired surrogate at index ${i} of the record payload`)
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
