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
