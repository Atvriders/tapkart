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
