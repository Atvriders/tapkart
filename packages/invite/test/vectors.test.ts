import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { bytesToHex, hexToBytes } from '../src/hex'
import { buildNdefFile, parseNdefFile } from '../src/uri'
import { SW, type TagState, createTagState, processApdu, resetTag, setNdefUri } from '../src/t4t'

const VECTORS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'vectors')

interface VectorLine {
  line: number
  fields: string[]
}

function readVectorLines(file: string, columns: number): VectorLine[] {
  const text = readFileSync(join(VECTORS_DIR, file), 'utf8')
  const out: VectorLine[] = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].replace(/\r$/, '')
    if (raw === '' || raw.startsWith('#')) continue
    const fields = raw.split('\t')
    if (fields.length !== columns) {
      throw new Error(
        `${file}:${i + 1}: expected ${columns} tab-separated columns, found ${fields.length}. ` +
          'Tabs were probably expanded to spaces.',
      )
    }
    out.push({ line: i + 1, fields })
  }
  return out
}

const SELECTED: readonly string[] = ['none', 'app', 'cc', 'ndef']
const STATUS_WORDS = Object.values(SW).map((sw) =>
  bytesToHex(Uint8Array.from([(sw >> 8) & 0xff, sw & 0xff])),
)

describe('t4t-exchange.tsv — the golden exchange, replayed (§12.2 assertion 1)', () => {
  const rows = readVectorLines('t4t-exchange.tsv', 6)

  it('yields rows at all, and never fewer than the exchange the contract pins', () => {
    expect(rows.length).toBeGreaterThanOrEqual(39)
  })

  it('is written in the one spelling of hex, so a string compare is a byte compare', () => {
    for (const { line, fields } of rows) {
      expect(`${line}:${fields[3]}`).toMatch(/^\d+:[0-9A-F]*$/)
      expect(`${line}:${fields[4]}`).toMatch(/^\d+:[0-9A-F]+$/)
      expect(fields[4].length % 2).toBe(0)
      expect(fields[2] === '0' || fields[2] === '1').toBe(true)
      expect(SELECTED).toContain(fields[5])
    }
  })

  it('ends every response with a status word from the §5.5 table', () => {
    for (const { line, fields } of rows) {
      expect(`${line}:${STATUS_WORDS.includes(fields[4].slice(-4))}`).toBe(`${line}:true`)
    }
  })

  it('exercises every one of the nine status words at least once', () => {
    const seen = [...new Set(rows.map(({ fields }) => fields[4].slice(-4)))]
    for (const sw of STATUS_WORDS) {
      expect(seen).toContain(sw)
    }
  })

  it('still contains the cases a naive implementation gets wrong', () => {
    const names = [...new Set(rows.map(({ fields }) => fields[0]))]
    for (const required of [
      'readCcLen',
      'readCcBody',
      'readCcOneShot',
      'selectAppTwelveByte',
      'emptyReadNlen',
      'readOverRunTruncated',
      'readPastEnd',
      'readBinaryAfterReset',
      'replayReadNdefMessage',
    ]) {
      expect(names).toContain(required)
    }
  })

  it('drives processApdu through every line, in file order, against one TagState', () => {
    const state: TagState = createTagState()
    for (const { line, fields } of rows) {
      const [name, ndefUri, resetBefore, commandHex, responseHex, selectedAfter] = fields
      const where = `${name} (t4t-exchange.tsv:${line})`

      if (ndefUri === '-') setNdefUri(state, null)
      else if (ndefUri !== '.') setNdefUri(state, ndefUri)
      if (resetBefore === '1') resetTag(state)

      const actual = bytesToHex(processApdu(state, hexToBytes(commandHex)))
      expect(`${where} -> ${actual}`).toBe(`${where} -> ${responseHex}`)
      expect(`${where} SW ${actual.slice(-4)}`).toBe(`${where} SW ${responseHex.slice(-4)}`)
      expect(`${where} selected ${state.selected}`).toBe(`${where} selected ${selectedAfter}`)
    }
  })
})

describe('ndef-uri.tsv — the NDEF file, both ways (§12.2 assertion 2)', () => {
  const rows = readVectorLines('ndef-uri.tsv', 2)

  it('yields rows at all', () => {
    expect(rows.length).toBeGreaterThanOrEqual(3)
  })

  it('carries the empty-file line §5.8 requires', () => {
    const empty = rows.filter(({ fields }) => fields[0] === '-')
    expect(empty.length).toBe(1)
    expect(empty[0].fields[1]).toBe('0000')
  })

  it('builds the exact file bytes for every line', () => {
    for (const { line, fields } of rows) {
      const [uri, fileHex] = fields
      const where = `ndef-uri.tsv:${line}`
      const built = buildNdefFile(uri === '-' ? null : uri)
      expect(`${where} ${bytesToHex(built)}`).toBe(`${where} ${fileHex}`)
    }
  })

  it('parses every line back to the URI it came from', () => {
    for (const { line, fields } of rows) {
      const [uri, fileHex] = fields
      const where = `ndef-uri.tsv:${line}`
      const parsed = parseNdefFile(hexToBytes(fileHex))
      expect(`${where} ${String(parsed)}`).toBe(`${where} ${uri === '-' ? 'null' : uri}`)
    }
  })

  it('agrees with t4t-exchange.tsv on the golden file', () => {
    const golden = rows.find(({ fields }) => fields[0] === 'https://tapkart.example/r/ABCDE')
    expect(golden).toBeDefined()
    expect(golden?.fields[1]).toBe(
      '001CD1011855047461706B6172742E6578616D706C652F722F4142434445',
    )
  })
})
