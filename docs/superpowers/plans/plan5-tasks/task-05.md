### Task 5: The golden APDU fixture — the exchange both languages replay

**Files:**
- Create: `packages/invite/vectors/t4t-exchange.tsv`
- Create: `packages/invite/vectors/ndef-uri.tsv`
- Test: `packages/invite/test/vectors.test.ts`

**Interfaces:**

- **Consumes** — `packages/invite/src/t4t.ts` (Task 4), `src/uri.ts` (Task 2) and
  `src/hex.ts` (Task 1):

  ```ts
  export type SelectedFile = 'none' | 'app' | 'cc' | 'ndef'
  export interface TagState { selected: SelectedFile; ndefFile: Uint8Array }
  export function createTagState(): TagState
  export function setNdefUri(state: TagState, uri: string | null): void
  export function resetTag(state: TagState): void
  export function processApdu(state: TagState, apdu: Uint8Array): Uint8Array
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
  export function buildNdefFile(uri: string | null): Uint8Array
  export function parseNdefFile(file: Uint8Array): string | null
  export function bytesToHex(b: Uint8Array): string
  export function hexToBytes(s: string): Uint8Array
  ```

- **Produces** — two fixture files and one runner. No exported symbols. The
  fixtures are **the contract between two languages**, not test data owned by
  this suite: contract §5.8 gives the same two files to the Android module via
  `sourceSets["test"].resources.srcDir("$rootDir/../../packages/invite/vectors")`,
  and §12.2 assertions 16 and 17 replay them through `T4tTag.process` and
  `NdefUri` on the JVM.

**Why a fixture at all, and why this one is the whole point of §5.** Two physical
phones cannot meet in a GitHub Actions runner, so **CI cannot prove the tap
works**. What it can prove is that the bytes are right — and that the two
implementations agree, byte for byte, on every command in the table including the
error cases, by driving both from one file. *This contract does not claim CI
proves the NFC tap works. It claims CI proves the bytes are right. Those are
different sentences and the difference is the whole point of §5.*

**The format is line-oriented, not JSON, and the reason binds Kotlin** (§5.8).
`org.json` is stubbed in Android JVM unit tests —
`testOptions.unitTests.returnDefaultValues` either throws or silently returns
zeros — so a JSON fixture forces a JSON dependency onto the Android test
classpath **to read a file that has no nesting in it**. Ten lines of
`split('\t')` on each side has no such failure mode. The columns are:

```
# t4t-exchange.tsv — version 1
# NAME <TAB> NDEF_URI <TAB> RESET_BEFORE <TAB> COMMAND_HEX <TAB> RESPONSE_HEX <TAB> SELECTED_AFTER
```

- **`NAME`** — names the case, so a failure says *which* one.
- **`NDEF_URI`** — `.` leaves the tag as it is; `-` calls
  `setNdefUri(state, null)`; anything else calls `setNdefUri(state, thatUri)`.
  *The draft's format had no such column and therefore could not express the
  non-advertising cases §5.6 promises.*
- **`RESET_BEFORE`** — `1` calls `resetTag(state)` before the command, `0` does
  not. **A `1` is what starts a new conversation.**
- **`COMMAND_HEX` / `RESPONSE_HEX`** — uppercase, unseparated. `RESPONSE_HEX` is
  the **whole R-APDU**: response body then the two status bytes, concatenated,
  because that is exactly what `processApdu` returns and a string compare on one
  spelling of hex is a byte compare.
- **`SELECTED_AFTER`** — `none` | `app` | `cc` | `ndef`, compared after every
  line.

Lines are applied **in file order against one `TagState`**, which is what lets
the file express a conversation rather than a set of independent cases. `#`
starts a comment; blank lines are skipped.

**Both suites must fail when the fixture file is missing or empty.** *A vector
runner that iterates zero rows and reports success is this project's signature
defect, and it is the specific way this particular test would rot.* So the runner
asserts a row-count floor, asserts that a named set of the hardest cases is
present, and asserts that **every one of the nine status words appears somewhere
in the file** — that last one is what detects a fixture that quietly lost its
error rows, which no amount of replaying the rows that remain ever could.

**The golden exchange** (§5.7). For `TAPKART_ORIGIN = https://tapkart.example`
and room code `ABCDE` (five characters, F-P4-34), the invite URI is
`https://tapkart.example/r/ABCDE` — 31 characters. The NDEF record abbreviates
`https://` to prefix code `0x04`, leaving the 23 ASCII bytes of
`tapkart.example/r/ABCDE`:

```
D1        MB=1 ME=1 CF=0 SR=1 IL=0 TNF=001  (single short well-known record)
01        type length = 1
18        payload length = 24  (1 prefix byte + 23 URI bytes)
55        type 'U'
04        prefix code: 'https://'
7461706B6172742E6578616D706C652F722F4142434445   'tapkart.example/r/ABCDE'
```

Record length = 28, so `NLEN = 00 1C` and the NDEF file is **30 bytes**:

```
001CD1011855047461706B6172742E6578616D706C652F722F4142434445
```

**These bytes are copied from the contract. They are not recomputed here and
must not be recomputed by the implementer** — the Kotlin mirror replays the same
string, and two independent recomputations that disagree by one byte is precisely
the failure the shared fixture exists to make impossible.

| Step | → Command | ← Response | `selected` after |
|---|---|---|---|
| 1 | `00A4040007D276000085010100` | `9000` | `app` |
| 2 | `00A4000C02E103` | `9000` | `cc` |
| 3 | `00B0000002` | `000F` `9000` | `cc` |
| 4 | `00B000020D` | `2000F600FF0406E104040000FF` `9000` | `cc` |
| 5 | `00A4000C02E104` | `9000` | `ndef` |
| 6 | `00B0000002` | `001C` `9000` | `ndef` |
| 7 | `00B000021C` | `D1011855047461706B6172742E6578616D706C652F722F4142434445` `9000` | `ndef` |

Steps 3 and 4 are the **two-step CC read a real Android reader performs**: it
reads CCLEN first and only then the rest of the file. An implementation that
answers only a one-shot 15-byte read passes a naive test and fails a phone, so
both spellings are in the file.

Row `readOverRunTruncated` is the **truncation** case, and it is written out so
nobody "fixes" it: offset `0x001C` = 28 is inside the 30-byte file and `Le` = 64,
so the tag returns the **final two bytes** — `44 45`, the `DE` of `ABCDE` — and
`90 00`, rather than `6C 02`.

**The second `.tsv`'s second row is the only line in either file whose bytes the
contract does not state**, so its derivation is written out here for checking
rather than trusting: `https://kart.example.com/r/ABCDE` (contract §1's second
example origin) abbreviates to prefix `0x04` plus the **24** ASCII bytes of
`kart.example.com/r/ABCDE` = `6B6172742E6578616D706C652E636F6D2F722F4142434445`;
payload = 1 + 24 = 25 = `0x19`; record = 4 + 25 = **29** bytes; `NLEN = 001D`;
file = 31 bytes.

**TABS, not spaces.** Every separator in both files is a single tab character.
An editor that expands them produces a file whose lines have one column, which
Step 4's `awk` check catches immediately and by name.

- [ ] **Step 1: Write the failing test**

Create `packages/invite/test/vectors.test.ts`:

```ts
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { bytesToHex, hexToBytes } from '../src/hex'
import { buildNdefFile, parseNdefFile } from '../src/uri'
import { SW, type TagState, createTagState, processApdu, resetTag, setNdefUri } from '../src/t4t'

/** Contract §5.8 permits exactly this test-only disk reach, the same one Plan 2
 *  §6 and Plan 3 ruling Q34 already permit for vector files. It is NOT one of
 *  §1's two repo-reading tests: it opens two named fixtures, not the repository. */
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

  /** A vector runner that iterates zero rows and reports success is this
   *  project's signature defect, and it is the specific way THIS test would rot.
   *  readFileSync throws when the file is missing; this catches it being empty. */
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
      // The line number rides in the compared value so a failure names the row.
      expect(`${line}:${STATUS_WORDS.includes(fields[4].slice(-4))}`).toBe(`${line}:true`)
    }
  })

  /** Coverage over the FIXTURE, not over the implementation. Replaying the rows
   *  that remain can never notice that the error rows were deleted. */
  it('exercises every one of the nine status words at least once', () => {
    const seen = [...new Set(rows.map(({ fields }) => fields[4].slice(-4)))]
    for (const sw of STATUS_WORDS) {
      expect(seen).toContain(sw)
    }
  })

  it('still contains the cases a naive implementation gets wrong', () => {
    const names = [...new Set(rows.map(({ fields }) => fields[0]))]
    for (const required of [
      'readCcLen', // the two-step CC read, step one
      'readCcBody', // and step two
      'readCcOneShot', // the one-shot 15-byte read
      'selectAppTwelveByte', // both spellings of SELECT app
      'emptyReadNlen', // the non-advertising tag serves 0000
      'readOverRunTruncated', // truncation, not 6C02
      'readPastEnd', // offset past the end is 6B00, not truncation
      'readBinaryAfterReset', // the second tap of the evening
      'replayReadNdefMessage', // ...and the whole exchange again after it
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
      // The status word again, on its own, because a response that "returned
      // something" is also what a tag no phone can read returns.
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/invite/test/vectors.test.ts`

Expected: **FAIL at collect time**, because the fixture directory does not exist —
the `readVectorLines` calls run while the `describe` bodies are being collected:

```
Error: ENOENT: no such file or directory, open '.../packages/invite/vectors/t4t-exchange.tsv'
```

- [ ] **Step 3: Write the implementation**

Create `packages/invite/vectors/t4t-exchange.tsv`. **Every separator is one tab
character.** The bytes are contract §5.7's, copied, not recomputed:

```
# t4t-exchange.tsv — version 1
# NAME <TAB> NDEF_URI <TAB> RESET_BEFORE <TAB> COMMAND_HEX <TAB> RESPONSE_HEX <TAB> SELECTED_AFTER
# NDEF_URI: '.' leaves the tag as it is, '-' is setNdefUri(null), anything else is setNdefUri(uri).
# Applied IN FILE ORDER against one TagState. RESET_BEFORE=1 starts a new conversation.
#
# --- the golden exchange (§5.7), including the two-step CC read a real Android reader performs
selectApp	https://tapkart.example/r/ABCDE	1	00A4040007D276000085010100	9000	app
selectCc	.	0	00A4000C02E103	9000	cc
readCcLen	.	0	00B0000002	000F9000	cc
readCcBody	.	0	00B000020D	2000F600FF0406E104040000FF9000	cc
selectNdefFile	.	0	00A4000C02E104	9000	ndef
readNlen	.	0	00B0000002	001C9000	ndef
readNdefMessage	.	0	00B000021C	D1011855047461706B6172742E6578616D706C652F722F41424344459000	ndef
#
# --- the one-shot 15-byte CC read, and the 12-byte spelling of SELECT app
selectCcAgain	.	0	00A4000C02E103	9000	cc
readCcOneShot	.	0	00B000000F	000F2000F600FF0406E104040000FF9000	cc
selectAppTwelveByte	.	1	00A4040007D2760000850101	9000	app
#
# --- the non-advertising host (§5.6): a well-formed EMPTY tag, never a refusal
emptySelectApp	-	1	00A4040007D276000085010100	9000	app
emptySelectNdefFile	.	0	00A4000C02E104	9000	ndef
emptyReadNlen	.	0	00B0000002	00009000	ndef
readNlenEmpty	-	1	00B0000002	6986	none
#
# --- the error table (§5.5), every row
wrongAid	https://tapkart.example/r/ABCDE	1	00A4040007A0000002471001	6A82	none
selectByNameWrongP1P2	.	1	00A4040107D2760000850101	6A86	none
selectAppForUnknownFile	.	1	00A4040007D276000085010100	9000	app
unknownFileId	.	0	00A4000C02E105	6A82	app
selectCcAfterReset	.	1	00A4000C02E103	6985	none
readBinaryAfterReset	.	1	00B0000002	6986	none
selectAppBeforeRead	.	1	00A4040007D276000085010100	9000	app
readBinaryWhileApp	.	0	00B0000002	6986	app
badCla	.	0	80B0000002	6E00	app
badIns	.	0	00C0000000	6D00	app
shortApdu	.	0	00A4	6700	app
extendedLength	.	0	00A40400000007D2760000850101	6700	app
#
# --- the 30-byte file: case 1 READ BINARY, offset past the end, and truncation
selectAppForFileCases	.	1	00A4040007D276000085010100	9000	app
selectNdefForFileCases	.	0	00A4000C02E104	9000	ndef
readBinaryCase1	.	0	00B00000	6700	ndef
readPastEnd	.	0	00B0FFFF02	6B00	ndef
readOverRunTruncated	.	0	00B0001C40	44459000	ndef
#
# --- the second tap of the evening: resetTag, then the whole exchange again
replayReadBeforeSelect	.	1	00B0000002	6986	none
replaySelectApp	.	1	00A4040007D276000085010100	9000	app
replaySelectCc	.	0	00A4000C02E103	9000	cc
replayReadCcLen	.	0	00B0000002	000F9000	cc
replayReadCcBody	.	0	00B000020D	2000F600FF0406E104040000FF9000	cc
replaySelectNdefFile	.	0	00A4000C02E104	9000	ndef
replayReadNlen	.	0	00B0000002	001C9000	ndef
replayReadNdefMessage	.	0	00B000021C	D1011855047461706B6172742E6578616D706C652F722F41424344459000	ndef
```

Create `packages/invite/vectors/ndef-uri.tsv`. **Tabs again**, two columns:

```
# ndef-uri.tsv — version 1
# URI <TAB> NDEF_FILE_HEX
# '-' in the URI column is the empty file: a non-advertising host serves 00 00.
https://tapkart.example/r/ABCDE	001CD1011855047461706B6172742E6578616D706C652F722F4142434445
https://kart.example.com/r/ABCDE	001DD1011955046B6172742E6578616D706C652E636F6D2F722F4142434445
-	0000
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
awk -F'\t' '!/^#/ && NF > 0 && NF != 6 { print FILENAME":"NR": "NF" columns, expected 6"; bad=1 } END { exit bad ? 1 : 0 }' packages/invite/vectors/t4t-exchange.tsv
awk -F'\t' '!/^#/ && NF > 0 && NF != 2 { print FILENAME":"NR": "NF" columns, expected 2"; bad=1 } END { exit bad ? 1 : 0 }' packages/invite/vectors/ndef-uri.tsv
npx vitest run packages/invite/test/vectors.test.ts
npx vitest run
```

Expected: **no output and exit 0** from both `awk` commands — that is the tabs
surviving. Then **11 passed** in `vectors.test.ts` (6 exchange + 5 NDEF file),
and no new failures anywhere.

If `awk` prints `1 columns, expected 6`, an editor expanded the tabs; re-create
the file rather than adjusting the parser, because the Kotlin side splits on
`\t` too and a space-separated file breaks there **without** breaking here.

If the replay fails on `readOverRunTruncated`, read the §5.5 note before touching
either side: over-reading is truncated on purpose, and `6C02` is not the fix.

- [ ] **Step 5: Commit**

```bash
git add packages/invite/vectors/t4t-exchange.tsv packages/invite/vectors/ndef-uri.tsv packages/invite/test/vectors.test.ts && git commit -m "test(invite): the golden APDU exchange both languages replay"
```
