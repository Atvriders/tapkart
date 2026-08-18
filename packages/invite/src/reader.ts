// PURE. The guest-side half: the same exchange, driven. No radio, no clock —
// the transport arrives as a function.
import { CC_FILE_ID, MLE, NDEF_AID, SW } from './t4t'
import { decodeUriRecord } from './uri'

export function buildSelectAidApdu(): Uint8Array {
  // 00 A4 04 00 07 <AID> 00 — the 13-byte spelling, which is what §5.7 pins.
  const out = new Uint8Array(6 + NDEF_AID.length)
  out[0] = 0x00
  out[1] = 0xa4
  out[2] = 0x04
  out[3] = 0x00
  out[4] = NDEF_AID.length
  out.set(NDEF_AID, 5)
  out[5 + NDEF_AID.length] = 0x00 // Le
  return out
}

export function buildSelectFileApdu(fileId: number): Uint8Array {
  if (!Number.isInteger(fileId) || fileId < 0 || fileId > 0xffff) {
    throw new Error(`buildSelectFileApdu: file id ${fileId} is outside 0x0000..0xFFFF`)
  }
  // P1 = 00 (by file identifier), P2 = 0C (first or only occurrence, no FCI).
  return Uint8Array.from([0x00, 0xa4, 0x00, 0x0c, 0x02, (fileId >> 8) & 0xff, fileId & 0xff])
}

/** `offset` 0..0xFFFF big-endian into P1P2; `length` 1..MLE. */
export function buildReadBinaryApdu(offset: number, length: number): Uint8Array {
  if (!Number.isInteger(offset) || offset < 0 || offset > 0xffff) {
    throw new Error(`buildReadBinaryApdu: offset ${offset} is outside 0..65535`)
  }
  if (!Number.isInteger(length) || length < 1 || length > MLE) {
    throw new Error(`buildReadBinaryApdu: length ${length} is outside 1..${MLE}`)
  }
  return Uint8Array.from([0x00, 0xb0, (offset >> 8) & 0xff, offset & 0xff, length])
}

export function isStatusOk(resp: Uint8Array): boolean {
  if (resp.length < 2) return false
  return ((resp[resp.length - 2] << 8) | resp[resp.length - 1]) === SW.ok
}

/** The response minus its two status bytes. Empty array if there are none. */
export function responseBody(resp: Uint8Array): Uint8Array {
  if (resp.length < 2) return new Uint8Array(0)
  return resp.slice(0, resp.length - 2)
}

/** One ISO-DEP round trip. Implemented by IsoDep on Android, by a loopback over
 *  `processApdu` in tests. */
export type Transceive = (command: Uint8Array) => Promise<Uint8Array>

/** A Type 4 Capability Container: CCLEN, mapping version, MLe, MLc, then TLVs. */
const CC_MIN_LENGTH = 15
const CC_MLE_OFFSET = 3
const CC_TLV_START = 7
const NDEF_TLV_TAG = 0x04
const NDEF_TLV_LENGTH = 0x06

/** The NDEF File Control TLV names the file that holds the message. E1 04 is a
 *  convention; this TLV is the authority, which is what lets this reader drive a
 *  tag it did not write. */
function ndefFileIdFrom(cc: Uint8Array): number | null {
  let i = CC_TLV_START
  while (i + 1 < cc.length) {
    const tag = cc[i]
    const length = cc[i + 1]
    if (i + 2 + length > cc.length) return null
    if (tag === NDEF_TLV_TAG && length === NDEF_TLV_LENGTH) {
      return (cc[i + 2] << 8) | cc[i + 3]
    }
    i += 2 + length
  }
  return null
}

/** SELECT app -> SELECT CC -> read CC -> SELECT NDEF -> read NLEN -> read body,
 *  chunked at the CC's advertised MLe. Returns the URI, or null if any step
 *  returns a non-9000 status or the message is empty. Never throws on a
 *  protocol error; propagates only errors thrown by `t` itself.
 *
 *  MLe comes out of the CC THIS READER JUST READ, never out of the MLE
 *  constant: a reader that trusts its own compiled-in value works perfectly
 *  against our own tag and fails against any other Type 4 tag, and driving the
 *  same exchange a foreign reader would is the whole point of writing it. */
export async function readInvite(t: Transceive): Promise<string | null> {
  const selectApp = await t(buildSelectAidApdu())
  if (!isStatusOk(selectApp)) return null

  const selectCc = await t(buildSelectFileApdu(CC_FILE_ID))
  if (!isStatusOk(selectCc)) return null

  // The two-step CC read a real Android reader performs: CCLEN first.
  const ccLenResp = await t(buildReadBinaryApdu(0, 2))
  if (!isStatusOk(ccLenResp)) return null
  const ccLen = responseBody(ccLenResp)
  if (ccLen.length < 2) return null
  const ccLength = (ccLen[0] << 8) | ccLen[1]
  if (ccLength < CC_MIN_LENGTH) return null

  const ccRestResp = await t(buildReadBinaryApdu(2, Math.min(ccLength - 2, MLE)))
  if (!isStatusOk(ccRestResp)) return null
  const ccRest = responseBody(ccRestResp)
  if (ccRest.length < CC_MIN_LENGTH - 2) return null
  const cc = new Uint8Array(2 + ccRest.length)
  cc.set(ccLen.subarray(0, 2), 0)
  cc.set(ccRest, 2)

  const advertisedMle = (cc[CC_MLE_OFFSET] << 8) | cc[CC_MLE_OFFSET + 1]
  if (advertisedMle < 1) return null
  // Clamped at MLE only because buildReadBinaryApdu will not build a longer
  // read: a tag advertising more simply gets read in our chunks.
  const chunkSize = Math.min(advertisedMle, MLE)

  const ndefFileId = ndefFileIdFrom(cc)
  if (ndefFileId === null) return null

  const selectNdef = await t(buildSelectFileApdu(ndefFileId))
  if (!isStatusOk(selectNdef)) return null

  const nlenResp = await t(buildReadBinaryApdu(0, 2))
  if (!isStatusOk(nlenResp)) return null
  const nlenBody = responseBody(nlenResp)
  if (nlenBody.length < 2) return null
  const nlen = (nlenBody[0] << 8) | nlenBody[1]
  if (nlen === 0) return null // a well-formed empty tag: the host is not advertising
  if (2 + nlen > 0xffff) return null // an offset this reader could not address

  const message = new Uint8Array(nlen)
  let got = 0
  while (got < nlen) {
    const chunkResp = await t(buildReadBinaryApdu(2 + got, Math.min(chunkSize, nlen - got)))
    if (!isStatusOk(chunkResp)) return null
    const chunk = responseBody(chunkResp)
    // No progress, or more than was asked for: stop rather than loop forever or
    // write past the end.
    if (chunk.length === 0 || chunk.length > nlen - got) return null
    message.set(chunk, got)
    got += chunk.length
  }

  try {
    return decodeUriRecord(message)
  } catch {
    return null // a garbled or hostile tag is a shrug, not a crash
  }
}
