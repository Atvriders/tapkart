### Task 4: `packages/invite/src/t4t.ts` — the Type 4 tag, as a pure function over byte arrays

**Files:**
- Create: `packages/invite/src/t4t.ts`
- Modify: `packages/invite/src/index.ts` — append one re-export line
- Test: `packages/invite/test/t4t.test.ts`

**Interfaces:**

- **Consumes** — `packages/invite/src/uri.ts` (Task 2) and `src/hex.ts` (Task 1):

  ```ts
  /** NLEN (u16 big-endian) followed by the message. `null` yields exactly
   *  `[0x00, 0x00]` — a valid, empty, readable tag (§5.6). */
  export function buildNdefFile(uri: string | null): Uint8Array
  export function bytesToHex(b: Uint8Array): string
  export function hexToBytes(s: string): Uint8Array
  ```

- **Produces** — contract §4.4, exactly fourteen exports:

  ```ts
  export const NDEF_AID: Uint8Array
  export const CC_FILE_ID = 0xe103
  export const NDEF_FILE_ID = 0xe104
  export const MLE = 0x00f6
  export const MLC = 0x00ff
  export const MAX_NDEF_FILE_SIZE = 0x0400
  export const CC_FILE: Uint8Array
  export const SW: {
    readonly ok: 0x9000
    readonly wrongLength: 0x6700
    readonly conditionsNotSatisfied: 0x6985
    readonly commandNotAllowed: 0x6986
    readonly wrongParameters: 0x6b00
    readonly fileNotFound: 0x6a82
    readonly incorrectP1P2: 0x6a86
    readonly insNotSupported: 0x6d00
    readonly claNotSupported: 0x6e00
  }
  export type SelectedFile = 'none' | 'app' | 'cc' | 'ndef'
  export interface TagState {
    selected: SelectedFile
    ndefFile: Uint8Array
  }
  export function createTagState(): TagState
  export function setNdefUri(state: TagState, uri: string | null): void
  export function resetTag(state: TagState): void
  export function processApdu(state: TagState, apdu: Uint8Array): Uint8Array
  ```

**Why this module gets more rigour than anything else in Plan 5.** Contract §5.1:
*this is the one part of NFC that CI can genuinely test.* Two physical phones
cannot meet in a GitHub Actions runner, but the bytes they would exchange are a
pure function over byte arrays — implemented twice, once here and once in Kotlin
(`T4tTag.process`, §7.3), and driven from one shared fixture (Task 5).
**Everything below is normative. A task that "simplifies" a status word or a CC
byte breaks the fixture, in both languages, loudly.**

**The command set is four commands and nothing else** (§5.2):

| # | Name | C-APDU (hex) | Precondition | Response |
|---|---|---|---|---|
| 1 | SELECT NDEF application, by DF name | `00 A4 04 00 07 D2 76 00 00 85 01 01` optionally followed by `00` (Le) | none | `90 00`; `selected := 'app'` |
| 2 | SELECT CC file, by file ID | `00 A4 00 0C 02 E1 03` | `selected !== 'none'` | `90 00`; `selected := 'cc'` |
| 3 | SELECT NDEF file, by file ID | `00 A4 00 0C 02 E1 04` | `selected !== 'none'` | `90 00`; `selected := 'ndef'` |
| 4 | READ BINARY | `00 B0 <offHi> <offLo> <Le>` | `selected` is `'cc'` or `'ndef'` | `<data> 90 00` |

Both spellings of command 1 are accepted, because readers in the wild send both.
The response carries **no FCI template**; `90 00` alone is what Android's reader
expects and what the fixture pins. `P2 = 0x0C` means "first or only occurrence,
return no FCI" and `P1 = 0x00` means "select by file identifier" — not free
choices, but what the NFC Forum Type 4 Tag operation specifies and what an
Android reader sends.

**P1P2 on READ BINARY is a plain 16-bit big-endian offset.** ISO 7816-4's
alternative reading — P1 bit 8 set meaning "short EF identifier in P1, offset in
P2" — is **not supported and needs no special case**: any P1 with bit 8 set
yields an offset ≥ 32768, which is past the end of a file capped at
`MAX_NDEF_FILE_SIZE`, so the existing `offset >= fileLength → 6B 00` rule already
covers it. One rule, no branch.

**`CC_FILE`, byte by byte** (§5.3):

```
00 0F   CCLEN = 15, the length of this file
20      Mapping version 2.0
00 F6   MLe = 246   — max R-APDU data field (MLE)
00 FF   MLc = 255   — max C-APDU data field (MLC)
04      NDEF File Control TLV, tag
06      NDEF File Control TLV, length
E1 04   NDEF file identifier            (NDEF_FILE_ID)
04 00   maximum NDEF file size = 1024   (MAX_NDEF_FILE_SIZE)
00      read access: granted
FF      write access: denied
```

Full hex: `000F2000F600FF0406E104040000FF` — 15 bytes. Write access is **denied**,
permanently and by design: a writable emulated tag is a way for a stranger's
phone to change what the host is advertising. `MLC = 255` is enforced vacuously
and that is stated rather than hidden — a short APDU's `Lc` is one byte and
therefore never exceeds 255, and extended-length APDUs are rejected outright.
The constant exists because the reader is told it in the CC, not because a check
depends on it, and the test asserts exactly that: `CC_FILE`'s MLc field equals
`MLC`.

**The ordered algorithm** (§5.4). The order matters, because two implementations
that check the same conditions in different orders return different status words
for an APDU that violates two of them at once — and the fixture would then fail
with no bug present:

```
processApdu(state, apdu):
  1. if apdu.length < 4                          -> SW.wrongLength        67 00
  2. if apdu[0] !== 0x00                         -> SW.claNotSupported    6E 00
  3. if apdu[1] !== 0xA4 && apdu[1] !== 0xB0     -> SW.insNotSupported    6D 00
  4. parse the length triple:
       len === 4                    -> case 1: no data, no Le
       len === 5                    -> case 2: Le = apdu[4], 0x00 means 256
       apdu[4] === 0x00 && len > 5  -> SW.wrongLength 67 00   (extended length)
       len === 5 + apdu[4]          -> case 3: Lc = apdu[4], data follows
       len === 6 + apdu[4]          -> case 4: Lc = apdu[4], data, then Le
       otherwise                    -> SW.wrongLength 67 00
  5. if INS === 0xA4: SELECT
       P1P2 === 0x0400 -> select by name: requires case 3 or 4 and Lc data
                          equal to NDEF_AID, else SW.fileNotFound 6A 82.
                          On success: selected := 'app'.
       P1P2 === 0x000C -> select by id: requires selected !== 'none'
                          (else SW.conditionsNotSatisfied 69 85), case 3 or 4,
                          Lc === 2, and the file id CC_FILE_ID or NDEF_FILE_ID
                          (else SW.fileNotFound 6A 82).
                          On success: selected := 'cc' | 'ndef'.
       otherwise       -> SW.incorrectP1P2 6A 86
       Response is SW.ok alone. No FCI.
  6. if INS === 0xB0: READ BINARY
       requires case 2 (a bare Le). Any other case -> SW.wrongLength 67 00.
       if selected is 'none' or 'app'  -> SW.commandNotAllowed 69 86
       file := selected === 'cc' ? CC_FILE : state.ndefFile
       offset := (apdu[2] << 8) | apdu[3]
       if offset >= file.length        -> SW.wrongParameters 6B 00
       want := apdu[4] === 0x00 ? 256 : apdu[4]
       n := min(want, MLE, file.length - offset)
       response := file[offset .. offset+n) followed by SW.ok
```

Steps 1–3 come before the case parse deliberately: an APDU with a bad CLA and a
bad length is reported as a bad CLA, in both languages, forever.

**Over-reading is truncated, not rejected.** `min(Le, MLE, fileLength - offset)`
bytes come back with `90 00`. Android's Type 4 reader never over-reads — it reads
NLEN first and chunks at MLe — so the lenient branch is never taken by the reader
we care about; being lenient means an unusual reader gets a usable answer instead
of a dead tag, and `6C XX` would be correctness theatre for readers we do not
target. **`offset >= fileLength` is not truncation, it is `6B 00`**: there is no
legitimate reason to start a read past the end of a file whose length the reader
was just told.

**The advertising and non-advertising states, and `resetTag`** (§5.6).
`TagState.ndefFile` is **always a valid file**: `00 00` when the host is not
advertising, NLEN-prefixed message bytes when it is. **Selects always succeed
regardless.** A reader that taps a non-advertising host gets a well-formed
*empty* tag and does nothing — which is exactly right, and strictly better than a
`6A 82` that some readers surface to the user as a broken tag.

`selected` resets to `'none'` on `resetTag`, which the Android service calls from
`onDeactivated`. **This is the single most likely Kotlin-side bug in the plan:**
an HCE service instance is reused across taps, so a state machine that does not
reset starts the second tap mid-conversation, and the second guest of the evening
gets nothing while the first got everything. *"The first tap of the day works
perfectly"* is exactly the profile of a bug that ships, so it is a sole-writer
rule (§13), a test here, and a fixture case in Task 5.

**`resetTag` does not touch `ndefFile`, and that is deliberate.** §13 makes
`setNdefUri` the *sole writer* of `ndefFile`; losing the link is not the same
event as the host pausing. F-P5-45 — *clear the NFC advert on pause* — is the
**app's** decision, expressed by calling `stop()` → `setNdefUri(state, null)`,
not something a link-layer reset does behind its back. Spec §2 already says a
sleeping screen stops HCE anyway, so leaving the advert set would buy only the
narrow backgrounded-but-awake window in exchange for a failure that is
*mysterious rather than predictable*: a tap that fails the same way every time is
debuggable and explainable to a guest; one that works only while the screen
happens to be on is neither.

- [ ] **Step 1: Write the failing test**

Create `packages/invite/test/t4t.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { bytesToHex, hexToBytes } from '../src/hex'
import {
  CC_FILE,
  CC_FILE_ID,
  MAX_NDEF_FILE_SIZE,
  MLC,
  MLE,
  NDEF_AID,
  NDEF_FILE_ID,
  SW,
  type TagState,
  createTagState,
  processApdu,
  resetTag,
  setNdefUri,
} from '../src/t4t'

/** Contract §5.7, copied verbatim — never recomputed from a description. */
const GOLDEN_URI = 'https://tapkart.example/r/ABCDE'
const GOLDEN_FILE_HEX = '001CD1011855047461706B6172742E6578616D706C652F722F4142434445'
const GOLDEN_RECORD_HEX = 'D1011855047461706B6172742E6578616D706C652F722F4142434445'
const CC_HEX = '000F2000F600FF0406E104040000FF'

/** One exchange, in the repository's one spelling of hex. */
function exchange(state: TagState, commandHex: string): string {
  return bytesToHex(processApdu(state, hexToBytes(commandHex)))
}

/** The two status bytes alone. Asserted separately from the full response on
 *  every row, because a response that "returned something" is what a tag no
 *  phone can read also does. */
function statusOf(responseHex: string): string {
  return responseHex.slice(-4)
}

function advertising(): TagState {
  const state = createTagState()
  setNdefUri(state, GOLDEN_URI)
  return state
}

/** SELECT app, then SELECT the NDEF file. Used where a test's subject is what
 *  happens next. */
function selectNdef(state: TagState): void {
  expect(exchange(state, '00A4040007D276000085010100')).toBe('9000')
  expect(exchange(state, '00A4000C02E104')).toBe('9000')
}

describe('the frozen constants (§5.3, §4.4)', () => {
  it('is the 15-byte Capability Container of §5.3, byte for byte', () => {
    expect(bytesToHex(CC_FILE)).toBe(CC_HEX)
    expect(CC_FILE.length).toBe(15)
  })

  /** Each constant is published to the reader INSIDE the CC. If a constant and
   *  its CC field disagree, the tag tells the reader one thing and enforces
   *  another — which is exactly the class of bug no round trip can see. */
  it('publishes every constant in the CC field that carries it', () => {
    expect((CC_FILE[0] << 8) | CC_FILE[1]).toBe(CC_FILE.length) // CCLEN
    expect(CC_FILE[2]).toBe(0x20) // mapping version 2.0
    expect((CC_FILE[3] << 8) | CC_FILE[4]).toBe(MLE)
    expect((CC_FILE[5] << 8) | CC_FILE[6]).toBe(MLC)
    expect(CC_FILE[7]).toBe(0x04) // NDEF File Control TLV, tag
    expect(CC_FILE[8]).toBe(0x06) // NDEF File Control TLV, length
    expect((CC_FILE[9] << 8) | CC_FILE[10]).toBe(NDEF_FILE_ID)
    expect((CC_FILE[11] << 8) | CC_FILE[12]).toBe(MAX_NDEF_FILE_SIZE)
    expect(CC_FILE[13]).toBe(0x00) // read access: granted
    expect(CC_FILE[14]).toBe(0xff) // write access: DENIED, permanently
  })

  it('is the NFC Forum registered NDEF Type 4 application AID', () => {
    expect(bytesToHex(NDEF_AID)).toBe('D2760000850101')
    expect(NDEF_AID.length).toBe(7)
  })

  it('pins the file identifiers and the sizes', () => {
    expect(CC_FILE_ID).toBe(0xe103)
    expect(NDEF_FILE_ID).toBe(0xe104)
    expect(MLE).toBe(0x00f6)
    expect(MLC).toBe(0x00ff)
    expect(MAX_NDEF_FILE_SIZE).toBe(0x0400)
  })

  it('holds exactly the nine status words this tag can return, each two bytes', () => {
    expect(Object.keys(SW).length).toBe(9)
    expect(SW.ok).toBe(0x9000)
    expect(SW.wrongLength).toBe(0x6700)
    expect(SW.conditionsNotSatisfied).toBe(0x6985)
    expect(SW.commandNotAllowed).toBe(0x6986)
    expect(SW.wrongParameters).toBe(0x6b00)
    expect(SW.fileNotFound).toBe(0x6a82)
    expect(SW.incorrectP1P2).toBe(0x6a86)
    expect(SW.insNotSupported).toBe(0x6d00)
    expect(SW.claNotSupported).toBe(0x6e00)
    for (const sw of Object.values(SW)) {
      expect(sw).toBeGreaterThanOrEqual(0x0000)
      expect(sw).toBeLessThanOrEqual(0xffff)
    }
  })

  /** The largest file this tag can ever hold is 2 (NLEN) + 4 (record header) +
   *  255 (max short payload) = 261 bytes, so the size published in the CC can
   *  never be exceeded by anything setNdefUri accepts. */
  it('publishes a maximum NDEF file size the tag cannot exceed', () => {
    expect(2 + 4 + 255).toBeLessThanOrEqual(MAX_NDEF_FILE_SIZE)
  })
})

describe('createTagState, setNdefUri, resetTag', () => {
  it('starts with nothing selected and a valid empty file', () => {
    const state = createTagState()
    expect(state.selected).toBe('none')
    expect(bytesToHex(state.ndefFile)).toBe('0000')
  })

  it('writes the golden 30-byte file and leaves `selected` alone', () => {
    const state = createTagState()
    selectNdef(state)
    expect(state.selected).toBe('ndef')
    setNdefUri(state, GOLDEN_URI)
    expect(bytesToHex(state.ndefFile)).toBe(GOLDEN_FILE_HEX)
    expect(state.selected).toBe('ndef')
  })

  it('restores the empty file for null', () => {
    const state = advertising()
    setNdefUri(state, null)
    expect(bytesToHex(state.ndefFile)).toBe('0000')
  })

  it('throws exactly where buildNdefFile throws, at the call site not on the radio', () => {
    const state = createTagState()
    expect(() => setNdefUri(state, `https://${'a'.repeat(255)}`)).toThrow(
      'encodeUriRecord: payload is 256 bytes, over the 255-byte short-record limit',
    )
    expect(bytesToHex(state.ndefFile)).toBe('0000') // and leaves the tag untouched
  })

  /** §13: setNdefUri is the SOLE writer of ndefFile. Losing the ISO-DEP link is
   *  not the host pausing — F-P5-45's "clear the advert on pause" is the app
   *  calling stop(), not something a link-layer reset does behind its back. */
  it('resets `selected` and does NOT clear the advert', () => {
    const state = advertising()
    selectNdef(state)
    resetTag(state)
    expect(state.selected).toBe('none')
    expect(bytesToHex(state.ndefFile)).toBe(GOLDEN_FILE_HEX)
  })
})

describe('the happy path (§5.7), step by step', () => {
  it('replays the golden exchange', () => {
    const state = advertising()

    expect(exchange(state, '00A4040007D276000085010100')).toBe('9000')
    expect(state.selected).toBe('app')

    expect(exchange(state, '00A4000C02E103')).toBe('9000')
    expect(state.selected).toBe('cc')

    expect(exchange(state, '00B0000002')).toBe('000F9000')
    expect(state.selected).toBe('cc')

    expect(exchange(state, '00B000020D')).toBe('2000F600FF0406E104040000FF9000')
    expect(state.selected).toBe('cc')

    expect(exchange(state, '00A4000C02E104')).toBe('9000')
    expect(state.selected).toBe('ndef')

    expect(exchange(state, '00B0000002')).toBe('001C9000')
    expect(state.selected).toBe('ndef')

    expect(exchange(state, '00B000021C')).toBe(`${GOLDEN_RECORD_HEX}9000`)
    expect(state.selected).toBe('ndef')
  })

  it('accepts the 12-byte SELECT app as well as the 13-byte one', () => {
    const state = advertising()
    expect(exchange(state, '00A4040007D2760000850101')).toBe('9000')
    expect(state.selected).toBe('app')
  })

  it('answers a one-shot 15-byte CC read', () => {
    const state = advertising()
    expect(exchange(state, '00A4040007D276000085010100')).toBe('9000')
    expect(exchange(state, '00A4000C02E103')).toBe('9000')
    expect(exchange(state, '00B000000F')).toBe(`${CC_HEX}9000`)
  })

  it('reads Le = 0x00 as 256, not as zero bytes', () => {
    const state = advertising()
    expect(exchange(state, '00A4040007D276000085010100')).toBe('9000')
    expect(exchange(state, '00A4000C02E103')).toBe('9000')
    expect(exchange(state, '00B0000000')).toBe(`${CC_HEX}9000`)
  })

  it('returns a fresh array, so a caller cannot corrupt CC_FILE', () => {
    const state = advertising()
    expect(exchange(state, '00A4040007D276000085010100')).toBe('9000')
    expect(exchange(state, '00A4000C02E103')).toBe('9000')
    const resp = processApdu(state, hexToBytes('00B000000F'))
    resp[0] = 0xff
    expect(bytesToHex(CC_FILE)).toBe(CC_HEX)
  })
})

describe('the non-advertising state (§5.6)', () => {
  it('serves a well-formed EMPTY file rather than refusing SELECT', () => {
    const state = createTagState()
    setNdefUri(state, null)
    expect(exchange(state, '00A4040007D276000085010100')).toBe('9000')
    expect(exchange(state, '00A4000C02E104')).toBe('9000')
    expect(state.selected).toBe('ndef')
    expect(exchange(state, '00B0000002')).toBe('00009000')
    expect(statusOf(exchange(state, '00B0000002'))).toBe('9000')
  })

  it('still answers the CC read while not advertising', () => {
    const state = createTagState()
    expect(exchange(state, '00A4040007D276000085010100')).toBe('9000')
    expect(exchange(state, '00A4000C02E103')).toBe('9000')
    expect(exchange(state, '00B000000F')).toBe(`${CC_HEX}9000`)
  })

  it('refuses to read past the two-byte empty file', () => {
    const state = createTagState()
    expect(exchange(state, '00A4040007D276000085010100')).toBe('9000')
    expect(exchange(state, '00A4000C02E104')).toBe('9000')
    expect(exchange(state, '00B0000202')).toBe('6B00')
  })
})

describe('the error table (§5.5), every row', () => {
  it('APDU shorter than 4 bytes -> 6700', () => {
    const state = advertising()
    expect(exchange(state, '00A4')).toBe('6700')
    expect(exchange(state, '')).toBe('6700')
    expect(exchange(state, '00A404')).toBe('6700')
  })

  it('CLA !== 0x00 -> 6E00, even when the length is also wrong', () => {
    const state = advertising()
    expect(exchange(state, '80B0000002')).toBe('6E00')
    expect(exchange(state, '80B0000003FF')).toBe('6E00') // bad CLA reported first
  })

  it('INS not A4 or B0 -> 6D00', () => {
    const state = advertising()
    expect(exchange(state, '00C0000000')).toBe('6D00')
    expect(exchange(state, '00D6000002FFFF')).toBe('6D00') // UPDATE BINARY: never
  })

  it('an extended-length APDU -> 6700', () => {
    const state = advertising()
    expect(exchange(state, '00A40400000007D2760000850101')).toBe('6700')
  })

  it('a length triple that parses as no ISO 7816 case -> 6700', () => {
    const state = advertising()
    expect(exchange(state, '00A4040003D276')).toBe('6700')
  })

  it('READ BINARY that is not case 2 -> 6700', () => {
    const state = advertising()
    selectNdef(state)
    expect(exchange(state, '00B00000')).toBe('6700') // case 1
    expect(exchange(state, '00B0000001FF')).toBe('6700') // case 3: Lc = 1, one data byte
    expect(exchange(state, '00B000000102FF')).toBe('6700') // case 4: Lc = 1, then Le
  })

  it("SELECT with P1P2 neither 0400 nor 000C -> 6A86", () => {
    const state = advertising()
    expect(exchange(state, '00A4040107D2760000850101')).toBe('6A86')
    expect(exchange(state, '00A4000002E103')).toBe('6A86')
  })

  it('SELECT by name with an AID that is not NDEF_AID -> 6A82', () => {
    const state = advertising()
    expect(exchange(state, '00A4040007A0000002471001')).toBe('6A82')
    expect(state.selected).toBe('none')
  })

  it('SELECT by name with no data at all -> 6A82', () => {
    const state = advertising()
    expect(exchange(state, '00A4040000')).toBe('6A82') // case 2, no AID
  })

  it('SELECT by ID with a file ID other than E103/E104 -> 6A82', () => {
    const state = advertising()
    expect(exchange(state, '00A4040007D276000085010100')).toBe('9000')
    expect(exchange(state, '00A4000C02E105')).toBe('6A82')
    expect(state.selected).toBe('app') // and the previous selection stands
  })

  it('SELECT by ID with an Lc that is not 2 -> 6A82', () => {
    const state = advertising()
    expect(exchange(state, '00A4040007D276000085010100')).toBe('9000')
    expect(exchange(state, '00A4000C03E10300')).toBe('6A82')
  })

  it("SELECT by ID while selected === 'none' -> 6985", () => {
    const state = advertising()
    resetTag(state)
    expect(exchange(state, '00A4000C02E103')).toBe('6985')
    expect(exchange(state, '00A4000C02E104')).toBe('6985')
    expect(state.selected).toBe('none')
  })

  it("READ BINARY while selected is 'none' or 'app' -> 6986", () => {
    const state = advertising()
    resetTag(state)
    expect(exchange(state, '00B0000002')).toBe('6986')
    expect(exchange(state, '00A4040007D276000085010100')).toBe('9000')
    expect(exchange(state, '00B0000002')).toBe('6986')
  })

  it('READ BINARY with offset >= fileLength -> 6B00, never a truncation', () => {
    const state = advertising()
    selectNdef(state)
    expect(exchange(state, '00B0FFFF02')).toBe('6B00')
    expect(exchange(state, '00B0001E02')).toBe('6B00') // offset 30 == file length
  })

  /** §5.2: P1 bit 8 set is ISO 7816-4's "short EF identifier" reading, which we
   *  do not support and do not special-case — it lands past the end of any file
   *  and the 6B00 rule already covers it. One rule, no branch. */
  it('treats a P1 with bit 8 set as a plain offset past the end -> 6B00', () => {
    const state = advertising()
    selectNdef(state)
    expect(exchange(state, '00B0800002')).toBe('6B00')
  })

  it('reports a status word from the table for every malformed input, and never throws', () => {
    const state = advertising()
    const known = new Set(Object.values(SW).map((sw) => bytesToHex(Uint8Array.from([sw >> 8, sw & 0xff]))))
    const malformed = ['', '00', '0000', '00A4', '00B0', '00A40400', '00A4040001', '00B0000005FF', 'FFFFFFFF', '00A4FFFF02E103']
    for (const hex of malformed) {
      const resp = exchange(state, hex)
      expect(known.has(statusOf(resp))).toBe(true)
    }
  })
})

describe('truncation (§5.5), the case a naive implementation gets wrong', () => {
  it('truncates an over-read to the end of the file and answers 9000', () => {
    const state = advertising()
    selectNdef(state)
    // offset 0x001C = 28 is inside the 30-byte file and Le = 64, so the tag
    // returns the FINAL TWO BYTES — 44 45, the 'DE' of ABCDE — rather than 6C02.
    expect(exchange(state, '00B0001C40')).toBe('44459000')
    expect(statusOf(exchange(state, '00B0001C40'))).toBe('9000')
  })

  it('clamps at MLE when the file is longer than one response', () => {
    const state = createTagState()
    // 250 bytes: 8 + 226 + 16. The record is 247 bytes and the file is 249.
    setNdefUri(state, `https://${'a'.repeat(226)}.example/r/ABCDE`)
    expect(state.ndefFile.length).toBe(249)
    selectNdef(state)

    const resp = processApdu(state, hexToBytes('00B0000000')) // Le = 0x00 -> 256
    expect(resp.length).toBe(MLE + 2)
    expect(bytesToHex(resp.subarray(MLE))).toBe('9000')
    expect(bytesToHex(resp.subarray(0, MLE))).toBe(bytesToHex(state.ndefFile.subarray(0, MLE)))

    // Le = 255 clamps to MLE as well: min(255, 246, 249) = 246.
    expect(processApdu(state, hexToBytes('00B00000FF')).length).toBe(MLE + 2)
  })

  it('clamps at what remains of the file when that is the smallest of the three', () => {
    const state = createTagState()
    setNdefUri(state, `https://${'a'.repeat(226)}.example/r/ABCDE`)
    selectNdef(state)
    // offset 244 of a 249-byte file, Le = 246: five bytes remain.
    const resp = processApdu(state, hexToBytes('00B000F4F6'))
    expect(resp.length).toBe(7)
    expect(bytesToHex(resp.subarray(5))).toBe('9000')
    expect(bytesToHex(resp.subarray(0, 5))).toBe(bytesToHex(state.ndefFile.subarray(244, 249)))
  })
})

describe('the second tap of the evening (§5.6)', () => {
  /** An HCE service instance is reused across taps. A state machine that does
   *  not reset starts the second tap mid-conversation, and the second guest gets
   *  nothing while the first got everything — "the first tap of the day works
   *  perfectly" is exactly the profile of a bug that ships. */
  it('starts the next conversation from none, and the whole exchange replays', () => {
    const state = advertising()

    // A complete first tap.
    expect(exchange(state, '00A4040007D276000085010100')).toBe('9000')
    expect(exchange(state, '00A4000C02E104')).toBe('9000')
    expect(exchange(state, '00B0000002')).toBe('001C9000')
    expect(exchange(state, '00B000021C')).toBe(`${GOLDEN_RECORD_HEX}9000`)

    // The link drops.
    resetTag(state)
    expect(state.selected).toBe('none')

    // The reader that arrives next starts at the beginning, and the command that
    // worked a moment ago is refused because nothing is selected.
    expect(exchange(state, '00B0000002')).toBe('6986')

    // ...and the full exchange then works exactly as it did the first time.
    expect(exchange(state, '00A4040007D276000085010100')).toBe('9000')
    expect(exchange(state, '00A4000C02E103')).toBe('9000')
    expect(exchange(state, '00B0000002')).toBe('000F9000')
    expect(exchange(state, '00B000020D')).toBe('2000F600FF0406E104040000FF9000')
    expect(exchange(state, '00A4000C02E104')).toBe('9000')
    expect(exchange(state, '00B0000002')).toBe('001C9000')
    expect(exchange(state, '00B000021C')).toBe(`${GOLDEN_RECORD_HEX}9000`)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/invite/test/t4t.test.ts`

Expected: **FAIL at collect time**:

```
Error: Failed to resolve import "../src/t4t" from "packages/invite/test/t4t.test.ts". Does the file exist?
```

- [ ] **Step 3: Write the implementation**

Create `packages/invite/src/t4t.ts`:

```ts
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
```

Append to `packages/invite/src/index.ts`, below the `./invite` line:

```ts
export * from './t4t'
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run packages/invite/test/t4t.test.ts
npm run typecheck -w @tapkart/invite
npx vitest run
```

Expected: **39 passed** in `t4t.test.ts` (6 constants + 5 state + 5 happy path +
3 non-advertising + 16 error table + 3 truncation + 1 second tap), no typecheck
output, and no new failures anywhere.

Two failures worth naming, because both are the bug this module exists to
prevent:

- If `00B0001C40` answers `6C02`, the truncation rule was "fixed". It is not a
  bug: §5.5 rules over-reading **truncated**, and a `6C XX` here is correctness
  theatre for readers we do not target.
- If the second-tap test fails at `expect(exchange(state, '00B0000002')).toBe('6986')`,
  `resetTag` is not clearing `selected` — which on a phone means the first guest
  of the evening gets a working tap and every guest after them gets nothing.

- [ ] **Step 5: Commit**

```bash
git add packages/invite/src/t4t.ts packages/invite/src/index.ts packages/invite/test/t4t.test.ts && git commit -m "feat(invite): the Type 4 tag state machine and the APDU exchange"
```
