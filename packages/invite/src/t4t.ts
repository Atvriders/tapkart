// PURE. Mirrored in Kotlin (nfc/T4tTag.kt, contract §7.3) and driven from the
// same fixture, so the ORDER of the checks below is as normative as the bytes.
// ISO 7816 is big-endian throughout: offsets, file IDs and NLEN. That is the
// opposite of Plan 2's wire rule, and the opposition is load-bearing —
// `protocol` is little-endian because we chose it, `invite` is big-endian
// because ISO 7816-4 and the NFC Forum Type 4 Tag operation say so.
import { buildNdefFile } from './uri'

/** NDEF Type 4 Tag application, NFC Forum registered: D2 76 00 00 85 01 01. */
export const NDEF_AID: Uint8Array = Uint8Array.from([0xd2, 0x76, 0x00, 0x00, 0x85, 0x01, 0x01])
export const CC_FILE_ID = 0xe103
export const NDEF_FILE_ID = 0xe104

/** Max R-APDU data field we will ever return, and max C-APDU data field we
 *  accept. Published to the reader inside CC_FILE and enforced by processApdu. */
export const MLE = 0x00f6
export const MLC = 0x00ff
/** Max NDEF file size published in the CC. Includes the 2-byte NLEN. */
export const MAX_NDEF_FILE_SIZE = 0x0400

/** The 15-byte Capability Container, frozen (§5.3).
 *
 *  00 0F  CCLEN = 15        20  mapping version 2.0
 *  00 F6  MLe = 246         00 FF  MLc = 255
 *  04     NDEF File Control TLV tag     06  its length
 *  E1 04  NDEF file identifier          04 00  max NDEF file size = 1024
 *  00     read access: granted          FF  write access: DENIED
 *
 *  Write access is denied permanently and by design: a writable emulated tag is
 *  a way for a stranger's phone to change what the host is advertising. */
export const CC_FILE: Uint8Array = Uint8Array.from([
  0x00, 0x0f, 0x20, 0x00, 0xf6, 0x00, 0xff, 0x04, 0x06, 0xe1, 0x04, 0x04, 0x00, 0x00, 0xff,
])

/** Every status word this tag can return. Two bytes each, big-endian. */
export const SW = {
  ok: 0x9000,
  wrongLength: 0x6700,
  conditionsNotSatisfied: 0x6985,
  commandNotAllowed: 0x6986,
  wrongParameters: 0x6b00,
  fileNotFound: 0x6a82,
  incorrectP1P2: 0x6a86,
  insNotSupported: 0x6d00,
  claNotSupported: 0x6e00,
} as const

export type SelectedFile = 'none' | 'app' | 'cc' | 'ndef'

export interface TagState {
  selected: SelectedFile
  /** NLEN + message; [0x00,0x00] when not advertising. */
  ndefFile: Uint8Array
}

export function createTagState(): TagState {
  return { selected: 'none', ndefFile: buildNdefFile(null) }
}

/** Sole writer of `ndefFile`. `null` -> the empty file. Throws exactly where
 *  `buildNdefFile` throws, so an over-long URI fails at the call site rather
 *  than on the radio. Does NOT change `selected`. */
export function setNdefUri(state: TagState, uri: string | null): void {
  state.ndefFile = buildNdefFile(uri)
}

/** ISO-DEP link lost. Sole writer of `selected` besides processApdu.
 *  MUST be called from HostApduService.onDeactivated — see §5.6.
 *
 *  It does NOT clear `ndefFile`: losing the link is not the host pausing.
 *  F-P5-45's "clear the advert on pause" is the app calling stop(), which is
 *  setNdefUri(state, null), and §13 keeps that the sole writer. */
export function resetTag(state: TagState): void {
  state.selected = 'none'
}

const INS_SELECT = 0xa4
const INS_READ_BINARY = 0xb0
const P1P2_SELECT_BY_NAME = 0x0400
const P1P2_SELECT_BY_ID = 0x000c
const EMPTY = new Uint8Array(0)

function statusOnly(sw: number): Uint8Array {
  return Uint8Array.from([(sw >> 8) & 0xff, sw & 0xff])
}

function withStatus(data: Uint8Array, sw: number): Uint8Array {
  const out = new Uint8Array(data.length + 2)
  out.set(data, 0)
  out[data.length] = (sw >> 8) & 0xff
  out[data.length + 1] = sw & 0xff
  return out
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

/** The whole tag, as a pure function. Returns a fresh Uint8Array containing
 *  the response data followed by the two status-word bytes. NEVER THROWS:
 *  every malformed input maps to a status word in the §5.5 table.
 *
 *  The order of the checks is contract §5.4 and is not an implementation
 *  detail: two implementations that check the same conditions in different
 *  orders return different status words for an APDU that violates two of them
 *  at once, and the shared fixture would then fail with no bug present. */
export function processApdu(state: TagState, apdu: Uint8Array): Uint8Array {
  // 1-3. Header, before the length triple, so a bad CLA with a bad length is
  // reported as a bad CLA in both languages, forever.
  if (apdu.length < 4) return statusOnly(SW.wrongLength)
  if (apdu[0] !== 0x00) return statusOnly(SW.claNotSupported)
  const ins = apdu[1]
  if (ins !== INS_SELECT && ins !== INS_READ_BINARY) return statusOnly(SW.insNotSupported)

  // 4. The ISO 7816 length triple.
  let apduCase: 1 | 2 | 3 | 4
  let data: Uint8Array = EMPTY
  if (apdu.length === 4) {
    apduCase = 1
  } else if (apdu.length === 5) {
    apduCase = 2
  } else if (apdu[4] === 0x00) {
    return statusOnly(SW.wrongLength) // extended length: rejected outright
  } else if (apdu.length === 5 + apdu[4]) {
    apduCase = 3
    data = apdu.subarray(5, 5 + apdu[4])
  } else if (apdu.length === 6 + apdu[4]) {
    apduCase = 4
    data = apdu.subarray(5, 5 + apdu[4])
  } else {
    return statusOnly(SW.wrongLength)
  }
  const hasData = apduCase === 3 || apduCase === 4

  // 5. SELECT.
  if (ins === INS_SELECT) {
    const p1p2 = (apdu[2] << 8) | apdu[3]
    if (p1p2 === P1P2_SELECT_BY_NAME) {
      if (!hasData || !sameBytes(data, NDEF_AID)) return statusOnly(SW.fileNotFound)
      state.selected = 'app'
      return statusOnly(SW.ok) // no FCI template: 90 00 alone
    }
    if (p1p2 === P1P2_SELECT_BY_ID) {
      if (state.selected === 'none') return statusOnly(SW.conditionsNotSatisfied)
      if (!hasData || data.length !== 2) return statusOnly(SW.fileNotFound)
      const fileId = (data[0] << 8) | data[1]
      if (fileId === CC_FILE_ID) {
        state.selected = 'cc'
        return statusOnly(SW.ok)
      }
      if (fileId === NDEF_FILE_ID) {
        state.selected = 'ndef'
        return statusOnly(SW.ok)
      }
      return statusOnly(SW.fileNotFound)
    }
    return statusOnly(SW.incorrectP1P2)
  }

  // 6. READ BINARY.
  if (apduCase !== 2) return statusOnly(SW.wrongLength)
  if (state.selected === 'none' || state.selected === 'app') {
    return statusOnly(SW.commandNotAllowed)
  }
  const file = state.selected === 'cc' ? CC_FILE : state.ndefFile
  const offset = (apdu[2] << 8) | apdu[3]
  if (offset >= file.length) return statusOnly(SW.wrongParameters)
  const want = apdu[4] === 0x00 ? 256 : apdu[4]
  const n = Math.min(want, MLE, file.length - offset)
  return withStatus(file.subarray(offset, offset + n), SW.ok)
}
