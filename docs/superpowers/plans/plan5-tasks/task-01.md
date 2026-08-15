### Task 1: `packages/invite` scaffold and `src/hex.ts`

**Files:**
- Create: `packages/invite/package.json`
- Create: `packages/invite/tsconfig.json`
- Create: `packages/invite/src/hex.ts`
- Create: `packages/invite/src/index.ts` — one re-export line today; every later `packages/invite` task appends its own
- Test: `packages/invite/test/hex.test.ts`
- Modify: `package-lock.json` — the `npm install` side effect of Step 4, declared because several tasks in this plan rewrite it and an undeclared root file in a diff reads as an accident

**This task edits no root file except `package-lock.json`.** The root `package.json` already carries `"workspaces": ["packages/*", "apps/*"]` and the root `vitest.config.ts` already carries `include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts']` — both are Plan 3's edits (R36, R37), already made, and a second identical edit here stages nothing.

**Interfaces:**

- **Consumes** — `@tapkart/protocol`, and this package's *only* dependency (contract §4.0). Quoted from `packages/protocol/src/room.ts` as shipped by Plan 2 Task 15c and extended by Plan 4; do not retype it, and never re-spell any of it inside `packages/invite`:

  ```ts
  /** Crockford's base32 alphabet: 32 symbols, digits first, with I, L, O and U
   *  removed. The ORDER is the 5-bit index and is therefore part of the wire
   *  format. */
  export const ROOM_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
  /** FIVE characters, not four (F-P4-34). */
  export const ROOM_CODE_LENGTH = 5
  /** The lobby URL path prefix, exported ONCE (C-1). Compiled into the Android
   *  APK's `autoVerify` intent-filter `pathPrefix`. FROZEN AT THE FIRST SIGNED
   *  RELEASE. */
  export const LOBBY_PATH_PREFIX = '/r/'
  /** Trim and uppercase. Total — never throws, never rejects. */
  export function normalizeRoomCode(input: string): string
  /** True only for a code already in canonical form. Lowercase is INVALID here. */
  export function isValidRoomCode(code: string): boolean
  /** Normalizes, validates, concatenates. Throws on a code that is not one. */
  export function lobbyPathFor(code: string): string
  ```

  All six are reached through the package barrel, `import { … } from '@tapkart/protocol'`. Task 1 itself consumes only the first three, and only to prove the dependency resolves.

- **Produces** — `packages/invite/src/hex.ts`, contract §4.1, exactly two exports:

  ```ts
  export function bytesToHex(b: Uint8Array): string
  export function hexToBytes(s: string): Uint8Array
  ```

**Why this package is not zero-dependency, and why that is the point.** The draft called `packages/invite` "zero dependencies". C-7 makes that false and correct to change: `ROOM_CODE_ALPHABET`, `ROOM_CODE_LENGTH`, `isValidRoomCode` and `LOBBY_PATH_PREFIX` live in `@tapkart/protocol`, and **a third implementation of room-code validation inside `invite` is exactly the drift C-7 was decided to stop.** `protocol` is itself DOM-free and dependency-free, so `invite` stays pure, headless and safe for `server`, `game` and the Android build to reach.

**The one spelling of hex.** Contract §0: uppercase, unseparated — `00A4040007D276000085010100`. One spelling means a string compare is a byte compare, which is what lets §5.7's fixture be a TSV rather than a parser. `bytesToHex` emits only that spelling; `hexToBytes` accepts lowercase and embedded spaces because a human transcribing a published table types both, and it is used by fixtures and by nothing shipped.

**No test in this task reads a repo file.** Contract §1: *"Exactly two tests in this repository read the repository's own files: `no-secrets.test.ts` and `deploy-env.test.ts`. Both are named here so a third does not appear by accident."* So the scaffold is not proven by parsing `package.json` — it is proven by *importing* `@tapkart/protocol` from inside `packages/invite/test/` and by `tsc --noEmit`. A resolution failure is a `Failed to resolve import` at collect time, which is louder than any string compare against a manifest.

- [ ] **Step 1: Write the failing test**

Create `packages/invite/test/hex.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { LOBBY_PATH_PREFIX, ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from '@tapkart/protocol'
import { bytesToHex, hexToBytes } from '../src/hex'

describe('the one dependency (contract §4.0)', () => {
  /** Not a value assertion — Plan 4 owns those. This asserts that the bare
   *  specifier RESOLVES from inside packages/invite, which is the whole of what
   *  §4.0 claims and the only part this package can break. A repo-file read
   *  would be a third repo-reading test, which §1 forbids by name. */
  it('resolves @tapkart/protocol from inside packages/invite', () => {
    expect(typeof LOBBY_PATH_PREFIX).toBe('string')
    expect(LOBBY_PATH_PREFIX.length).toBeGreaterThan(0)
    expect(typeof ROOM_CODE_ALPHABET).toBe('string')
    expect(ROOM_CODE_ALPHABET.length).toBe(32)
    expect(ROOM_CODE_LENGTH).toBeGreaterThan(0)
  })
})

describe('bytesToHex', () => {
  it('emits uppercase, unseparated, zero-padded pairs', () => {
    expect(bytesToHex(Uint8Array.from([0x00, 0x0f, 0xa5, 0xff]))).toBe('000FA5FF')
  })

  it('emits the empty string for an empty array', () => {
    expect(bytesToHex(new Uint8Array(0))).toBe('')
  })

  /** Independent evidence, not a round trip: the expected string is built by a
   *  DIFFERENT method (Number#toString(16)) than the implementation's nibble
   *  table, for all 256 byte values. A byte that came out lowercase, unpadded,
   *  or nibble-swapped fails here. */
  it('agrees with Number#toString(16) for every one of the 256 byte values', () => {
    for (let v = 0; v <= 0xff; v++) {
      const expected = v.toString(16).toUpperCase().padStart(2, '0')
      expect(bytesToHex(Uint8Array.from([v]))).toBe(expected)
    }
  })

  it('never emits a separator, a lowercase digit, or an 0x prefix', () => {
    const all = new Uint8Array(256)
    for (let v = 0; v <= 0xff; v++) all[v] = v
    const hex = bytesToHex(all)
    expect(hex.length).toBe(512)
    expect(hex).toMatch(/^[0-9A-F]+$/)
  })
})

describe('hexToBytes', () => {
  it('reads the 15 CC bytes of contract §5.3 exactly', () => {
    // Copied verbatim from contract §5.3's "Full hex:" line. Not recomputed.
    const cc = hexToBytes('000F2000F600FF0406E104040000FF')
    expect(cc.length).toBe(15)
    expect(cc[0]).toBe(0x00)
    expect(cc[1]).toBe(0x0f)
    expect(cc[2]).toBe(0x20)
    expect(cc[14]).toBe(0xff)
  })

  it('accepts lowercase and embedded spaces', () => {
    const aid = hexToBytes('d2 76 00 00 85 01 01')
    expect(Array.from(aid)).toEqual([0xd2, 0x76, 0x00, 0x00, 0x85, 0x01, 0x01])
  })

  it('accepts mixed case', () => {
    expect(Array.from(hexToBytes('aAbB'))).toEqual([0xaa, 0xbb])
  })

  it('returns an empty array for an empty string and for spaces only', () => {
    expect(hexToBytes('').length).toBe(0)
    expect(hexToBytes('   ').length).toBe(0)
  })

  it('throws on an odd number of hex digits, counting after spaces are dropped', () => {
    expect(() => hexToBytes('9000A')).toThrow(
      "hexToBytes: '9000A' has an odd number of hex digits (5)",
    )
  })

  it('throws naming the offending character and its index', () => {
    expect(() => hexToBytes('90Z0')).toThrow("hexToBytes: 'Z' at index 2 is not a hex digit")
  })

  it('rejects a tab, which is the fixture column separator and never a hex digit', () => {
    expect(() => hexToBytes('90\t00')).toThrow('is not a hex digit')
  })

  /** This round trip is a consistency check, NOT the evidence. The evidence is
   *  the exact-literal assertions above: a round trip proves the two functions
   *  agree with each other, which they would also do if both were wrong. */
  it('round-trips every byte value, as a consistency check only', () => {
    const all = new Uint8Array(256)
    for (let v = 0; v <= 0xff; v++) all[v] = v
    expect(Array.from(hexToBytes(bytesToHex(all)))).toEqual(Array.from(all))
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/invite/test/hex.test.ts`

Expected: **FAIL at collect time**, because neither the package nor the module exists:

```
Error: Failed to resolve import "../src/hex" from "packages/invite/test/hex.test.ts". Does the file exist?
```

- [ ] **Step 3: Write the implementation**

Create `packages/invite/package.json` — contract §4.0 verbatim:

```json
{
  "name": "@tapkart/invite",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "dependencies": {
    "@tapkart/protocol": "*"
  },
  "scripts": {
    "typecheck": "tsc --noEmit -p tsconfig.json"
  }
}
```

Create `packages/invite/tsconfig.json` — **no `DOM` lib**, exactly like `sim`/`protocol`/`net`/`content`:

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

Create `packages/invite/src/hex.ts`:

```ts
// PURE. No DOM, no clock, no I/O, no ambient global.

/** The one spelling of hex in this repository (contract §0): uppercase,
 *  unseparated, two characters per byte. One spelling means a string compare is
 *  a byte compare, which is what lets §5.7's golden exchange be a TSV. */
const HEX_DIGITS = '0123456789ABCDEF'

/** Uppercase, unseparated. */
export function bytesToHex(b: Uint8Array): string {
  let out = ''
  for (let i = 0; i < b.length; i++) {
    const byte = b[i]
    out += HEX_DIGITS[(byte >> 4) & 0x0f]
    out += HEX_DIGITS[byte & 0x0f]
  }
  return out
}

/** `index` is the position in the space-stripped string, which is the position
 *  the caller can act on: it is where the byte actually sits. */
function nibbleAt(compact: string, index: number): number {
  const code = compact.charCodeAt(index)
  if (code >= 0x30 && code <= 0x39) return code - 0x30 // '0'-'9'
  if (code >= 0x41 && code <= 0x46) return code - 0x41 + 10 // 'A'-'F'
  if (code >= 0x61 && code <= 0x66) return code - 0x61 + 10 // 'a'-'f'
  throw new Error(`hexToBytes: '${compact[index]}' at index ${index} is not a hex digit`)
}

/** Accepts uppercase, lowercase and embedded spaces; throws on odd length or a
 *  non-hex character. Used by fixtures and by nothing shipped.
 *
 *  ONLY the space (0x20) is stripped. A tab is rejected on purpose: it is the
 *  column separator in the §5.8 fixtures, so a hex field that swallowed one
 *  would be a fixture with a missing column reading as a valid byte string. */
export function hexToBytes(s: string): Uint8Array {
  let compact = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === ' ') continue
    compact += c
  }
  if (compact.length % 2 !== 0) {
    throw new Error(`hexToBytes: '${s}' has an odd number of hex digits (${compact.length})`)
  }
  const out = new Uint8Array(compact.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = (nibbleAt(compact, i * 2) << 4) | nibbleAt(compact, i * 2 + 1)
  }
  return out
}
```

Create `packages/invite/src/index.ts`:

```ts
// The barrel. Contract §4.8: it re-exports all nine modules of this package,
// because all nine are pure and headless-safe — this package has no adapter half
// to keep out of the barrel. It grows ONE LINE PER MODULE as the modules land,
// so that `tsc` never points at a file that does not exist yet.
export * from './hex'
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npm install
npx vitest run packages/invite/test/hex.test.ts
npm run typecheck -w @tapkart/invite
npx vitest run
```

`npm install` is required before the test can pass: it is what symlinks
`node_modules/@tapkart/invite` and resolves this package's `@tapkart/protocol`
dependency. It rewrites `package-lock.json`, which is why that file is declared
above.

Expected: **13 passed** in `hex.test.ts` (1 dependency + 4 `bytesToHex` +
8 `hexToBytes`), no typecheck output, and no new failures anywhere in the full
run.

If the first test fails with `Failed to resolve import "@tapkart/protocol"`,
`npm install` did not run or `packages/protocol` is not on disk — Plan 2 lands it
and Plan 4 extends it. Fix that, never by adding a relative path into another
package.

- [ ] **Step 5: Commit**

```bash
git add packages/invite/package.json packages/invite/tsconfig.json packages/invite/src/hex.ts packages/invite/src/index.ts packages/invite/test/hex.test.ts package-lock.json && git commit -m "feat(invite): package scaffold and the one spelling of hex"
```
