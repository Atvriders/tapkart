### Task 6: `packages/invite/src/reader.ts` and `src/host.ts` — the guest-side half, and the seam

**Files:**
- Create: `packages/invite/src/reader.ts`
- Create: `packages/invite/src/host.ts`
- Modify: `packages/invite/src/index.ts` — append two re-export lines
- Test: `packages/invite/test/reader.test.ts`
- Test: `packages/invite/test/host.test.ts`

**Interfaces:**

- **Consumes** — `packages/invite/src/t4t.ts` (Task 4), `src/uri.ts` (Task 2) and
  `src/hex.ts` (Task 1):

  ```ts
  export const NDEF_AID: Uint8Array          // D2 76 00 00 85 01 01
  export const CC_FILE_ID = 0xe103
  export const NDEF_FILE_ID = 0xe104
  export const MLE = 0x00f6
  export const SW: { readonly ok: 0x9000; /* …eight more, §4.4 */ }
  export interface TagState { selected: SelectedFile; ndefFile: Uint8Array }
  export function createTagState(): TagState
  export function setNdefUri(state: TagState, uri: string | null): void
  export function resetTag(state: TagState): void
  export function processApdu(state: TagState, apdu: Uint8Array): Uint8Array
  /** Inverse of encodeUriRecord. Throws on a record that is not a single
   *  well-known 'U' record. */
  export function decodeUriRecord(rec: Uint8Array): string
  export function bytesToHex(b: Uint8Array): string
  export function hexToBytes(s: string): Uint8Array
  ```

- **Produces** — contract §4.5, exactly seven exports from `src/reader.ts`:

  ```ts
  export function buildSelectAidApdu(): Uint8Array
  export function buildSelectFileApdu(fileId: number): Uint8Array
  export function buildReadBinaryApdu(offset: number, length: number): Uint8Array
  export function isStatusOk(resp: Uint8Array): boolean
  export function responseBody(resp: Uint8Array): Uint8Array
  export type Transceive = (command: Uint8Array) => Promise<Uint8Array>
  export function readInvite(t: Transceive): Promise<string | null>
  ```

  and contract §4.6, exactly four exports from `src/host.ts`:

  ```ts
  export interface NfcSupport { hardware: boolean; hce: boolean; adapterEnabled: boolean }
  export type InviteSource = 'tag' | 'appLink'
  export interface NfcHost {
    supported(): Promise<NfcSupport>
    advertise(uri: string): Promise<void>
    stop(): Promise<void>
    onInvite(cb: (uri: string, source: InviteSource) => void): () => void
    pendingInvite(): Promise<string | null>
  }
  export const nullNfcHost: NfcHost
  ```

**`readInvite` reads MLe out of the CC it just read, not out of the `MLE`
constant.** Contract §4.5 states the reason and it is the reason this module
exists at all: *a reader that trusts its own compiled-in value would work
perfectly against our own tag and fail against any other Type 4 tag, and the
whole point of implementing the reader is that it drives the same exchange a
foreign reader would.*

**That requirement is undetectable against our own tag**, because our tag
advertises exactly `MLE`: a reader that ignored the CC entirely would pass a
loopback test in every particular. So this task's suite includes a **second,
foreign tag** — a stub whose CC advertises `MLe = 16` and whose NDEF file lives
at `E105` — and asserts the exact commands the reader emits against it. Without
that stub the requirement would be a comment. **A test that cannot detect what it
exists to detect is this project's signature defect**, and a byte-protocol
round trip is its most flattering disguise.

**The same argument decides where the NDEF file id comes from.** `readInvite`
takes it from the CC's NDEF File Control TLV (tag `0x04`, length `0x06`), not
from the `NDEF_FILE_ID` constant. `E104` is a convention; the TLV is the
authority, and the foreign stub is what proves the difference.

**`readInvite` never throws on a protocol error and propagates only errors
thrown by `t` itself.** Every `await t(...)` is outside the one `try`, which
wraps only the decode — so a link failure surfaces to the caller (the Android
adapter has a real error to show) while a hostile or garbled tag yields `null`
(there is nothing to show, and a crash would be worse than a shrug).

**`onInvite`, not `onTagRead`.** The draft's `onTagRead` is replaced, because
F-P5-16's ruling is that *"both filters deliver the same URI to the same
handler… It is one path with two entry points"* — two callbacks would be two
paths, which is the objection the ruling overruled, reintroduced by the back
door. `InviteSource` exists **for the log line, not for a branch.**

**`pendingInvite` is required, not convenience.** A cold-start App Link is
delivered before any JS has run, so `onInvite` cannot have been registered yet
and the invite is silently lost without it. That is a tap that does nothing —
the exact failure mode this plan is written to prevent — and §14.1 item 8 is the
only place it can be checked.

**`nullNfcHost` is what browsers, desktop and `startShell` without `opts.nfc`
get.** `packages/game` holds an `NfcHost` and must never construct one; this
package declares the interface and never holds an implementation.

- [ ] **Step 1: Write the failing test**

Create `packages/invite/test/reader.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { bytesToHex, hexToBytes } from '../src/hex'
import {
  CC_FILE_ID,
  MLE,
  NDEF_FILE_ID,
  type TagState,
  createTagState,
  processApdu,
  resetTag,
  setNdefUri,
} from '../src/t4t'
import {
  type Transceive,
  buildReadBinaryApdu,
  buildSelectAidApdu,
  buildSelectFileApdu,
  isStatusOk,
  readInvite,
  responseBody,
} from '../src/reader'

/** Contract §5.7, copied verbatim. */
const GOLDEN_URI = 'https://tapkart.example/r/ABCDE'
const GOLDEN_FILE_HEX = '001CD1011855047461706B6172742E6578616D706C652F722F4142434445'
const OUR_CC_HEX = '000F2000F600FF0406E104040000FF'

/** The seven commands of contract §5.7's table, in order. */
const GOLDEN_COMMANDS = [
  '00A4040007D276000085010100',
  '00A4000C02E103',
  '00B0000002',
  '00B000020D',
  '00A4000C02E104',
  '00B0000002',
  '00B000021C',
]

/** The reader and the tag, proven against each other with no radio
 *  (§12.2 assertion 4). Synchronous: no timers, no clock. */
function loopback(state: TagState): { t: Transceive; commands: string[] } {
  const commands: string[] = []
  const t: Transceive = (command) => {
    commands.push(bytesToHex(command))
    return Promise.resolve(processApdu(state, command))
  }
  return { t, commands }
}

/** A SECOND, FOREIGN Type 4 tag, driven by its own CC exactly as a real one is:
 *  it reads its MLe out of CC bytes 3-4 and its NDEF file id out of the NDEF
 *  File Control TLV at bytes 9-10. Our own tag advertises exactly MLE and
 *  exactly NDEF_FILE_ID, so a reader that ignored the CC entirely would pass
 *  every loopback assertion in this file. This is the tag that notices. */
function stubTag(ccHex: string, ndefFileHex: string): { t: Transceive; commands: string[] } {
  const cc = hexToBytes(ccHex)
  const ndef = hexToBytes(ndefFileHex)
  const mle = (cc[3] << 8) | cc[4]
  const selectNdefHex = bytesToHex(Uint8Array.from([0x00, 0xa4, 0x00, 0x0c, 0x02, cc[9], cc[10]]))
  const commands: string[] = []
  let selected: 'none' | 'cc' | 'ndef' = 'none'
  const reply = (hex: string): Promise<Uint8Array> => Promise.resolve(hexToBytes(hex))
  const t: Transceive = (command) => {
    const hex = bytesToHex(command)
    commands.push(hex)
    if (hex === '00A4040007D276000085010100') return reply('9000')
    if (hex === '00A4000C02E103') {
      selected = 'cc'
      return reply('9000')
    }
    if (hex === selectNdefHex) {
      selected = 'ndef'
      return reply('9000')
    }
    if (hex.startsWith('00B0') && command.length === 5 && selected !== 'none') {
      const file = selected === 'cc' ? cc : ndef
      const offset = (command[2] << 8) | command[3]
      if (offset >= file.length) return reply('6B00')
      const want = command[4] === 0x00 ? 256 : command[4]
      const n = Math.min(want, mle, file.length - offset)
      return reply(`${bytesToHex(file.subarray(offset, offset + n))}9000`)
    }
    return reply('6A82')
  }
  return { t, commands }
}

describe('the command builders (§4.5)', () => {
  it('builds exactly step 1 of the golden exchange', () => {
    expect(bytesToHex(buildSelectAidApdu())).toBe('00A4040007D276000085010100')
  })

  it('builds exactly steps 2 and 5 of the golden exchange', () => {
    expect(bytesToHex(buildSelectFileApdu(CC_FILE_ID))).toBe('00A4000C02E103')
    expect(bytesToHex(buildSelectFileApdu(NDEF_FILE_ID))).toBe('00A4000C02E104')
  })

  it('throws on a file id outside a big-endian u16', () => {
    expect(() => buildSelectFileApdu(0x10000)).toThrow(
      'buildSelectFileApdu: file id 65536 is outside 0x0000..0xFFFF',
    )
    expect(() => buildSelectFileApdu(-1)).toThrow('is outside 0x0000..0xFFFF')
    expect(() => buildSelectFileApdu(1.5)).toThrow('is outside 0x0000..0xFFFF')
  })

  it('builds exactly steps 3, 4, 6 and 7 of the golden exchange', () => {
    expect(bytesToHex(buildReadBinaryApdu(0, 2))).toBe('00B0000002')
    expect(bytesToHex(buildReadBinaryApdu(2, 13))).toBe('00B000020D')
    expect(bytesToHex(buildReadBinaryApdu(2, 28))).toBe('00B000021C')
    expect(bytesToHex(buildReadBinaryApdu(0xffff, 2))).toBe('00B0FFFF02')
  })

  it('throws outside the offset and length ranges', () => {
    expect(() => buildReadBinaryApdu(0x10000, 2)).toThrow(
      'buildReadBinaryApdu: offset 65536 is outside 0..65535',
    )
    expect(() => buildReadBinaryApdu(-1, 2)).toThrow('offset -1 is outside 0..65535')
    expect(() => buildReadBinaryApdu(0, 0)).toThrow('buildReadBinaryApdu: length 0 is outside 1..246')
    expect(() => buildReadBinaryApdu(0, MLE + 1)).toThrow('length 247 is outside 1..246')
  })
})

describe('isStatusOk and responseBody', () => {
  it('is true only for a response ending in 9000', () => {
    expect(isStatusOk(hexToBytes('9000'))).toBe(true)
    expect(isStatusOk(hexToBytes('000F9000'))).toBe(true)
    expect(isStatusOk(hexToBytes('6A82'))).toBe(false)
    expect(isStatusOk(hexToBytes('6986'))).toBe(false)
    expect(isStatusOk(hexToBytes('90'))).toBe(false)
    expect(isStatusOk(new Uint8Array(0))).toBe(false)
    expect(isStatusOk(hexToBytes('90009000'))).toBe(true) // the LAST two bytes
  })

  it('strips exactly the two status bytes', () => {
    expect(bytesToHex(responseBody(hexToBytes('000F9000')))).toBe('000F')
    expect(bytesToHex(responseBody(hexToBytes('9000')))).toBe('')
    expect(bytesToHex(responseBody(hexToBytes('90')))).toBe('')
    expect(bytesToHex(responseBody(new Uint8Array(0)))).toBe('')
  })
})

describe('readInvite against our own tag', () => {
  it('reads the golden URI, issuing exactly the seven commands of §5.7', async () => {
    const state = createTagState()
    setNdefUri(state, GOLDEN_URI)
    const { t, commands } = loopback(state)

    expect(await readInvite(t)).toBe(GOLDEN_URI)
    expect(commands).toEqual(GOLDEN_COMMANDS)
  })

  it('returns null against a host that is not advertising, and stops at NLEN', async () => {
    const state = createTagState() // ndefFile is 0000
    const { t, commands } = loopback(state)

    expect(await readInvite(t)).toBeNull()
    expect(commands).toEqual(GOLDEN_COMMANDS.slice(0, 6))
  })

  it('starts a fresh conversation after resetTag, as a second tap would', async () => {
    const state = createTagState()
    setNdefUri(state, GOLDEN_URI)
    expect(await readInvite(loopback(state).t)).toBe(GOLDEN_URI)
    resetTag(state)
    const second = loopback(state)
    expect(await readInvite(second.t)).toBe(GOLDEN_URI)
    expect(second.commands).toEqual(GOLDEN_COMMANDS)
  })
})

describe('readInvite against a foreign tag — the assertion our own tag cannot make', () => {
  /** CC: 00 0F | 20 | 00 10 (MLe = 16) | 00 FF | 04 06 | E1 05 | 04 00 | 00 | FF */
  const FOREIGN_CC_HEX = '000F20001000FF0406E105040000FF'

  it('chunks at the CC-advertised MLe and selects the CC-advertised file id', async () => {
    const { t, commands } = stubTag(FOREIGN_CC_HEX, GOLDEN_FILE_HEX)

    expect(await readInvite(t)).toBe(GOLDEN_URI)
    expect(commands).toEqual([
      '00A4040007D276000085010100',
      '00A4000C02E103',
      '00B0000002',
      '00B000020D',
      '00A4000C02E105', // the TLV's file id, not the NDEF_FILE_ID constant
      '00B0000002',
      '00B0000210', // 16 bytes: the CC's MLe, not the MLE constant's 246
      '00B000120C', // and the remaining 12
    ])
  })

  it('would have read the whole 28-byte message in one go had it trusted MLE', async () => {
    const { t, commands } = stubTag(FOREIGN_CC_HEX, GOLDEN_FILE_HEX)
    expect(await readInvite(t)).toBe(GOLDEN_URI)
    // Guard on the guard, stated as a negative: '00B000021C' is the command a
    // reader with a compiled-in MLe emits, and it must never appear here.
    expect(commands).not.toContain('00B000021C')
    expect(commands).toContain('00B0000210')
  })

  it('returns null — never throws — on a tag serving a malformed NDEF record', async () => {
    const { t } = stubTag(OUR_CC_HEX, '0004DEADBEEF')
    expect(await readInvite(t)).toBeNull()
  })

  it('returns null when SELECT app is refused, after exactly one command', async () => {
    const commands: string[] = []
    const t: Transceive = (command) => {
      commands.push(bytesToHex(command))
      return Promise.resolve(hexToBytes('6A82'))
    }
    expect(await readInvite(t)).toBeNull()
    expect(commands).toEqual(['00A4040007D276000085010100'])
  })

  it('propagates an error thrown by the transceiver itself', async () => {
    const t: Transceive = () => Promise.reject(new Error('ISO-DEP link lost'))
    await expect(readInvite(t)).rejects.toThrow('ISO-DEP link lost')
  })
})
```

Create `packages/invite/test/host.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { type InviteSource, type NfcHost, nullNfcHost } from '../src/host'

const URI = 'https://tapkart.example/r/ABCDE'

describe('nullNfcHost — what browsers, desktop and startShell without opts.nfc get', () => {
  it('reports no hardware, no HCE and no adapter', async () => {
    expect(await nullNfcHost.supported()).toEqual({
      hardware: false,
      hce: false,
      adapterEnabled: false,
    })
  })

  it('resolves advertise and stop, and both are idempotent', async () => {
    await expect(nullNfcHost.advertise(URI)).resolves.toBeUndefined()
    await expect(nullNfcHost.advertise(URI)).resolves.toBeUndefined()
    await expect(nullNfcHost.stop()).resolves.toBeUndefined()
    await expect(nullNfcHost.stop()).resolves.toBeUndefined()
  })

  it('never calls back, and its unsubscribe is safe to call twice', () => {
    let calls = 0
    const off = nullNfcHost.onInvite(() => {
      calls += 1
    })
    expect(typeof off).toBe('function')
    off()
    off()
    expect(calls).toBe(0)
  })

  it('resolves pendingInvite to null', async () => {
    expect(await nullNfcHost.pendingInvite()).toBeNull()
  })
})

describe('NfcHost — the seam', () => {
  /** A recording implementation, which is what `apps/web` supplies on Android.
   *  Writing one here proves the interface is implementable with the exact
   *  signatures the adapter and `packages/game` both compile against. */
  function recordingHost(): { host: NfcHost; emit: (uri: string, source: InviteSource) => void; advertised: string[] } {
    const listeners: Array<(uri: string, source: InviteSource) => void> = []
    const advertised: string[] = []
    const host: NfcHost = {
      supported: () => Promise.resolve({ hardware: true, hce: true, adapterEnabled: true }),
      advertise: (uri: string) => {
        advertised.push(uri)
        return Promise.resolve()
      },
      stop: () => Promise.resolve(),
      onInvite(cb) {
        listeners.push(cb)
        return () => {
          const at = listeners.indexOf(cb)
          if (at >= 0) listeners.splice(at, 1)
        }
      },
      pendingInvite: () => Promise.resolve(URI),
    }
    const emit = (uri: string, source: InviteSource): void => {
      for (const cb of [...listeners]) cb(uri, source)
    }
    return { host, emit, advertised }
  }

  /** F-P5-16: both filters deliver the same URI to the same handler. It is one
   *  path with two entry points, and `source` exists for the log line. */
  it('delivers both entry points to ONE callback', () => {
    const seen: Array<[string, InviteSource]> = []
    const { host, emit } = recordingHost()
    host.onInvite((uri, source) => {
      seen.push([uri, source])
    })
    emit(URI, 'tag')
    emit(URI, 'appLink')
    expect(seen).toEqual([
      [URI, 'tag'],
      [URI, 'appLink'],
    ])
  })

  it('stops delivering after unsubscribe, and carries a pending cold-start invite', async () => {
    const seen: string[] = []
    const { host, emit, advertised } = recordingHost()
    const off = host.onInvite((uri) => {
      seen.push(uri)
    })
    emit(URI, 'tag')
    off()
    emit(URI, 'appLink')
    expect(seen).toEqual([URI])

    await host.advertise(URI)
    expect(advertised).toEqual([URI])
    expect(await host.pendingInvite()).toBe(URI)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/invite/test/reader.test.ts packages/invite/test/host.test.ts`

Expected: **FAIL at collect time**, both files:

```
Error: Failed to resolve import "../src/reader" from "packages/invite/test/reader.test.ts". Does the file exist?
Error: Failed to resolve import "../src/host" from "packages/invite/test/host.test.ts". Does the file exist?
```

- [ ] **Step 3: Write the implementation**

Create `packages/invite/src/reader.ts`:

```ts
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
```

Create `packages/invite/src/host.ts`:

```ts
// PURE — interfaces only, plus one inert implementation. `packages/invite`
// declares this seam and never holds a real implementation of it.

export interface NfcSupport {
  /** Device has NFC hardware. */
  hardware: boolean
  /** Device supports Host Card Emulation. */
  hce: boolean
  /** NFC is switched on right now. */
  adapterEnabled: boolean
}

/** Where an invite URI reached this device. F-P5-16 puts two entry points on one
 *  path; this is the only thing that distinguishes them, and it exists for the
 *  log line, not for a branch. */
export type InviteSource = 'tag' | 'appLink'

/** The seam. `apps/web` supplies a Capacitor-backed implementation on Android
 *  and `nullNfcHost` everywhere else. `packages/game` holds one and must never
 *  construct one. */
export interface NfcHost {
  supported(): Promise<NfcSupport>
  /** Idempotent. Starts emulating a tag serving `uri` and keeps the screen on. */
  advertise(uri: string): Promise<void>
  /** Idempotent. Serves the empty NDEF file and releases the screen lock. */
  stop(): Promise<void>
  /** Both entry points, one callback (F-P5-16). Returns an unsubscribe function. */
  onInvite(cb: (uri: string, source: InviteSource) => void): () => void
  /** The URI the launch intent carried, consumed once and then null.
   *
   *  Required, not convenience: a cold-start App Link is delivered before any JS
   *  has run, so `onInvite` cannot have been registered yet and the invite is
   *  silently lost without this. That is a tap that does nothing — the exact
   *  failure mode this plan is written to prevent. */
  pendingInvite(): Promise<string | null>
}

const NO_OP_UNSUBSCRIBE = (): void => {}

/** Every method resolves; `supported()` reports all false; `onInvite` returns a
 *  no-op unsubscribe; `pendingInvite()` resolves null. Browsers and desktop get
 *  this, and so does `startShell` when `opts.nfc` is absent. */
export const nullNfcHost: NfcHost = {
  supported(): Promise<NfcSupport> {
    return Promise.resolve({ hardware: false, hce: false, adapterEnabled: false })
  },
  advertise(): Promise<void> {
    return Promise.resolve()
  },
  stop(): Promise<void> {
    return Promise.resolve()
  },
  onInvite(): () => void {
    return NO_OP_UNSUBSCRIBE
  },
  pendingInvite(): Promise<string | null> {
    return Promise.resolve(null)
  },
}
```

Append to `packages/invite/src/index.ts`, below the `./t4t` line:

```ts
export * from './reader'
export * from './host'
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run packages/invite/test/reader.test.ts packages/invite/test/host.test.ts
npm run typecheck -w @tapkart/invite
npx vitest run
```

Expected: **14 passed** in `reader.test.ts` (5 builders + 2 status + 3 own tag +
4 foreign tag) and **6 passed** in `host.test.ts` (4 + 2), no typecheck output,
and no new failures anywhere.

If the foreign-tag test fails with `'00B000021C'` where `'00B0000210'` was
expected, `readInvite` is using the `MLE` constant instead of the CC it just
read — and note that **every other test in this file still passes**, which is
exactly why the foreign stub is here.

- [ ] **Step 5: Commit**

```bash
git add packages/invite/src/reader.ts packages/invite/src/host.ts packages/invite/src/index.ts packages/invite/test/reader.test.ts packages/invite/test/host.test.ts && git commit -m "feat(invite): the guest-side reader and the NfcHost seam"
```
