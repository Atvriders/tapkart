### Task 3: `packages/invite/src/invite.ts`, and `chooseOrigin` — the one branch that decides what every invite URI says

**Files:**
- Create: `packages/invite/src/invite.ts`
- Create: `apps/web/src/pwa/origin.ts`
- Modify: `packages/invite/src/index.ts` — append one re-export line
- Test: `packages/invite/test/invite.test.ts`
- Test: `apps/web/test/origin.test.ts`

**Two files, because the contract puts them in two packages and the census
counts them separately.** `invite/invite` has **5** exports and `web/pwa/origin`
has **2** (contract §16). `chooseOrigin` is *not* an `invite` export: it takes
`isNative` as an argument, and a codec package that knows what a WebView is has
gone wrong. But the two are one decision — what origin an invite URI is built
from — so they land together, and neither is written twice.

**This task does not edit `apps/web/tsconfig.json`.** Its `include` is
`["src/**/*.ts", "vite.config.ts"]`, so `src/pwa/origin.ts` is typechecked by
`tsc -p apps/web/tsconfig.json` as created. Contract §15.2's edit list for that
file is complete and names only the `tools/**/*.ts` include and the `src/sw.ts`
exclude, both of which belong to the service-worker task. `apps/web/test/` is
collected by the root `vitest.config.ts` (`apps/*/test/**/*.test.ts`, Plan 3
R37), which is what runs the test.

**Interfaces:**

- **Consumes** — `@tapkart/protocol`, quoted from `packages/protocol/src/room.ts`
  as shipped. `packages/invite` spells out none of these; it imports all three
  (contract §13's sole-writer row):

  ```ts
  export const LOBBY_PATH_PREFIX = '/r/'
  /** Trim and uppercase. Total — never throws, never rejects. */
  export function normalizeRoomCode(input: string): string
  /** True only for a code already in canonical form. Lowercase is INVALID here. */
  export function isValidRoomCode(code: string): boolean
  export const ROOM_CODE_LENGTH = 5
  ```

- **Consumes** — `packages/invite/src/uri.ts` (Task 2) and `src/hex.ts` (Task 1),
  in the tests only:

  ```ts
  export const MAX_INVITE_URI_BYTES = 250
  export function encodeUriRecord(uri: string): Uint8Array
  ```

- **Produces** — contract §4.3, exactly five exports from `src/invite.ts`:

  ```ts
  export const MAX_INVITE_ORIGIN_BYTES = 200
  export interface InviteUri { origin: string; roomCode: string }
  export function buildInviteUri(origin: string, roomCode: string): string
  export function parseInviteUri(uri: string): InviteUri | null
  export function originHost(origin: string): string | null
  ```

  and contract §10.3, exactly two exports from `apps/web/src/pwa/origin.ts`:

  ```ts
  export function stripTrailingSlash(origin: string): string
  export function chooseOrigin(isNative: boolean, buildOrigin: string, locationOrigin: string): string
  ```

**C-3, and why the throw is the important half.** The rule is: *invite URIs, QR
payloads, anything the running web app builds → `location.origin`, at runtime*,
so a self-hoster on any domain works with **no rebuild**; *the Android intent
filter and the APK's own web bundle → `TAPKART_ORIGIN`, at build time*, because
an intent filter is compiled into the APK and can never be runtime-configurable.

The two meet inside the APK. F-P5-10 bundles the web build into it, and there
`location.origin` is the WebView's local scheme — **not** the deployed origin.
Applying C-3's first bullet literally there emits `https://localhost/r/ABCDE`
into the NDEF record: an invite no guest can open, produced **on the only device
that has HCE at all**, with nothing anywhere reporting a problem. That is the
silent failure C-3 exists to prevent, occurring inside C-3.

So `chooseOrigin` **throws** when `isNative` and the build origin is empty.
Failing at module load, in a build CI runs, is the only loud moment available.

**Why this is a pure function and not an `if` inside `env.ts`.** Contract §0a:
an adapter contains no decisions, *because a conditional in an adapter is a
decision CI cannot see.* This is the sharpest branch in the plan, so it lives in
a pure module with a unit test per case and no browser anywhere near it.

**`parseInviteUri` is hand-parsed, and does not use `URL`.** `URL` is an ambient
global whose presence depends on the lib/@types configuration of whoever imports
this package, and its normalisation silently accepts the query strings this
function must reject (P5 Q14: the invite URI carries the room code and nothing
else). Twenty lines of explicit parsing has neither failure mode.

**Three decisions the contract leaves to the implementer, taken here so the
Kotlin `InviteIntent` mirror and §12.2's manifest assertion agree with this:**

1. **What counts as an origin** is `https://` + host + optional port and nothing
   else: `/^https:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?$/`. The contract enumerates
   throws for a trailing slash and a non-https scheme but not for
   `https://tapkart.example/foo`, which is not an origin either, and both
   `buildInviteUri` and `originHost` need one definition of the word. Being ASCII
   by construction is also what makes `origin.length` a **byte** count, which is
   what `MAX_INVITE_ORIGIN_BYTES` is measured in.
2. **`parseInviteUri` upper-cases the code before validating it.** Its inputs
   come off a radio and off the address bar, and a user who types
   `.../r/abcde` has typed a valid code: the alphabet is uppercase-only, so
   nothing is ambiguous and nothing is substituted. Rejecting it would be a tap
   that does nothing for a reason no guest could see.
3. **`originHost` strips the port and does not change case.** It feeds
   `android:host` in the intent filter (§12.2 assertion 21), where the port is a
   separate attribute; case is left alone because Android's verifier folds it
   and a transform here would make the assertion compare two strings that differ
   for a reason nobody can see.

- [ ] **Step 1: Write the failing test**

Create `packages/invite/test/invite.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { LOBBY_PATH_PREFIX, ROOM_CODE_LENGTH } from '@tapkart/protocol'
import {
  MAX_INVITE_ORIGIN_BYTES,
  buildInviteUri,
  originHost,
  parseInviteUri,
} from '../src/invite'
import { MAX_INVITE_URI_BYTES, encodeUriRecord } from '../src/uri'

/** Contract §1: the only origin, host and room code that may appear in a repo
 *  file. `tapkart.example` is RFC 2606; `ABCDE` is five characters (F-P4-34). */
const ORIGIN = 'https://tapkart.example'
const CODE = 'ABCDE'

describe('buildInviteUri', () => {
  it('builds the golden invite URI of contract §5.7', () => {
    expect(buildInviteUri(ORIGIN, CODE)).toBe('https://tapkart.example/r/ABCDE')
  })

  /** §12.2 assertion 6: the expected string is CONSTRUCTED from the imported
   *  constants, so the day Plan 4 changes the prefix or the code length this
   *  test says so instead of a phone opening a browser. */
  it('builds its path from LOBBY_PATH_PREFIX rather than a literal', () => {
    expect(buildInviteUri(ORIGIN, CODE)).toBe(`${ORIGIN}${LOBBY_PATH_PREFIX}${CODE}`)
    expect(CODE.length).toBe(ROOM_CODE_LENGTH)
  })

  it('upper-cases the room code', () => {
    expect(buildInviteUri(ORIGIN, 'abcde')).toBe(`${ORIGIN}${LOBBY_PATH_PREFIX}ABCDE`)
  })

  it('trims the room code, because normalizeRoomCode does', () => {
    expect(buildInviteUri(ORIGIN, ' abcde ')).toBe(`${ORIGIN}${LOBBY_PATH_PREFIX}ABCDE`)
  })

  it('accepts a second origin and a port', () => {
    expect(buildInviteUri('https://kart.example.com', CODE)).toBe(
      `https://kart.example.com${LOBBY_PATH_PREFIX}ABCDE`,
    )
    expect(buildInviteUri('https://kart.example.com:8443', CODE)).toBe(
      `https://kart.example.com:8443${LOBBY_PATH_PREFIX}ABCDE`,
    )
  })

  it('throws on a trailing slash', () => {
    expect(() => buildInviteUri('https://tapkart.example/', CODE)).toThrow(
      "buildInviteUri: origin 'https://tapkart.example/' has a trailing slash",
    )
  })

  it('throws on a non-https scheme', () => {
    expect(() => buildInviteUri('http://tapkart.example', CODE)).toThrow(
      "buildInviteUri: origin 'http://tapkart.example' is not https",
    )
  })

  it('throws on an origin that carries a path', () => {
    expect(() => buildInviteUri('https://tapkart.example/lobby', CODE)).toThrow(
      "buildInviteUri: origin 'https://tapkart.example/lobby' is not a bare https origin",
    )
  })

  it('accepts an origin of exactly MAX_INVITE_ORIGIN_BYTES bytes', () => {
    const origin = `https://${'a'.repeat(184)}.example`
    expect(origin.length).toBe(MAX_INVITE_ORIGIN_BYTES)
    expect(buildInviteUri(origin, CODE)).toBe(`${origin}${LOBBY_PATH_PREFIX}${CODE}`)
  })

  it('throws one byte over MAX_INVITE_ORIGIN_BYTES', () => {
    const origin = `https://${'a'.repeat(185)}.example`
    expect(origin.length).toBe(MAX_INVITE_ORIGIN_BYTES + 1)
    expect(() => buildInviteUri(origin, CODE)).toThrow(
      'buildInviteUri: origin is 201 bytes, over MAX_INVITE_ORIGIN_BYTES (200)',
    )
  })

  it('throws on every shape of bad room code', () => {
    // Four characters, six characters, and 'I' — which Crockford's base32 drops.
    for (const bad of ['ABCD', 'ABCDEF', 'ABCDI', '', 'AB CD']) {
      expect(() => buildInviteUri(ORIGIN, bad)).toThrow('is not a valid room code')
    }
  })
})

describe('parseInviteUri', () => {
  it('inverts buildInviteUri', () => {
    expect(parseInviteUri(buildInviteUri(ORIGIN, CODE))).toEqual({
      origin: ORIGIN,
      roomCode: CODE,
    })
  })

  it('returns the canonical room code for a lower-cased URI', () => {
    expect(parseInviteUri('https://tapkart.example/r/abcde')).toEqual({
      origin: ORIGIN,
      roomCode: 'ABCDE',
    })
  })

  it('keeps the port in the origin it returns', () => {
    expect(parseInviteUri('https://kart.example.com:8443/r/ABCDE')).toEqual({
      origin: 'https://kart.example.com:8443',
      roomCode: CODE,
    })
  })

  it('returns null — never throws — for every rejection', () => {
    const rejected = [
      '',
      'not a uri',
      'http://tapkart.example/r/ABCDE', // scheme
      'https://tapkart.example', // no path
      'https://tapkart.example/', // no prefix
      'https://tapkart.example/x/ABCDE', // wrong prefix
      'https://tapkart.example/r/', // no code
      'https://tapkart.example/r/ABCD', // four characters
      'https://tapkart.example/r/ABCDEF', // six characters
      'https://tapkart.example/r/ABCDE/', // trailing slash
      'https://tapkart.example/r/ABCDE/extra', // deeper path
      'https://tapkart.example/r/ABCDI', // 'I' is not in the alphabet
      'https:///r/ABCDE', // no host
    ]
    for (const uri of rejected) {
      expect(parseInviteUri(uri)).toBeNull()
    }
  })

  /** P5 Q14: the invite URI carries the room code and NOTHING else. This is the
   *  case `URL` would have normalised away, which is why this function is
   *  hand-parsed. */
  it('rejects any query string or fragment', () => {
    expect(parseInviteUri('https://tapkart.example/r/ABCDE?x=1')).toBeNull()
    expect(parseInviteUri('https://tapkart.example/r/ABCDE#f')).toBeNull()
    expect(parseInviteUri('https://tapkart.example/r/ABCDE?')).toBeNull()
    expect(parseInviteUri('https://tapkart.example/r/ABCDE#')).toBeNull()
    expect(parseInviteUri('https://tapkart.example/?a=b/r/ABCDE')).toBeNull()
  })
})

describe('originHost', () => {
  it('drops the scheme', () => {
    expect(originHost(ORIGIN)).toBe('tapkart.example')
  })

  it('drops the port, because android:host is a separate attribute', () => {
    expect(originHost('https://kart.example.com:8443')).toBe('kart.example.com')
  })

  it('returns null for anything that is not an https origin', () => {
    expect(originHost('http://tapkart.example')).toBeNull()
    expect(originHost('tapkart.example')).toBeNull()
    expect(originHost('https://tapkart.example/')).toBeNull()
    expect(originHost('https://tapkart.example/r/ABCDE')).toBeNull()
    expect(originHost('')).toBeNull()
  })
})

describe('the origin budget fits inside the record, and is proven to', () => {
  /** Contract §4.3: the cap exists so buildInviteUri can NEVER produce an
   *  un-encodable record. Every term is imported, so a change in Plan 4 or in
   *  Task 2 fails here rather than on a radio. */
  it('leaves the longest possible invite URI inside MAX_INVITE_URI_BYTES', () => {
    expect(MAX_INVITE_ORIGIN_BYTES + LOBBY_PATH_PREFIX.length + ROOM_CODE_LENGTH).toBeLessThanOrEqual(
      MAX_INVITE_URI_BYTES,
    )
  })

  it('encodes the longest invite URI this game can build', () => {
    const origin = `https://${'a'.repeat(184)}.example`
    const uri = buildInviteUri(origin, CODE)
    expect(uri.length).toBe(MAX_INVITE_ORIGIN_BYTES + LOBBY_PATH_PREFIX.length + ROOM_CODE_LENGTH)
    const rec = encodeUriRecord(uri)
    expect(rec[2]).toBe(uri.length - 'https://'.length + 1)
  })
})
```

Create `apps/web/test/origin.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { chooseOrigin, stripTrailingSlash } from '../src/pwa/origin'

describe('stripTrailingSlash', () => {
  it('removes one trailing slash', () => {
    expect(stripTrailingSlash('https://tapkart.example/')).toBe('https://tapkart.example')
  })

  it('leaves an origin without one alone', () => {
    expect(stripTrailingSlash('https://tapkart.example')).toBe('https://tapkart.example')
  })

  it("leaves '' as ''", () => {
    expect(stripTrailingSlash('')).toBe('')
  })

  it('does not trim whitespace — that is chooseOrigin\'s job, not this one\'s', () => {
    expect(stripTrailingSlash('  https://tapkart.example  ')).toBe('  https://tapkart.example  ')
  })
})

describe('chooseOrigin — C-3, as a function (contract §10.3)', () => {
  it('takes location.origin in a browser, so a self-hoster rebuilds nothing', () => {
    expect(chooseOrigin(false, 'https://tapkart.example', 'https://kart.example.com')).toBe(
      'https://kart.example.com',
    )
  })

  it('ignores an absent build origin in a browser', () => {
    expect(chooseOrigin(false, '', 'https://kart.example.com')).toBe('https://kart.example.com')
  })

  /** Inside the Capacitor WebView `location.origin` is the WebView's local
   *  scheme. Taking it here would put an invite URI nobody can open into the
   *  NDEF record, on the only device that has HCE. */
  it('takes the baked build origin in the native WebView', () => {
    expect(chooseOrigin(true, 'https://tapkart.example', 'https://localhost')).toBe(
      'https://tapkart.example',
    )
  })

  it('throws when native and the build origin is empty', () => {
    expect(() => chooseOrigin(true, '', 'https://localhost')).toThrow(
      'chooseOrigin: native build has no TAPKART_ORIGIN',
    )
  })

  it('throws when native and the build origin is whitespace, which is what an empty .env line leaves', () => {
    expect(() => chooseOrigin(true, '   ', 'https://localhost')).toThrow(
      'chooseOrigin: native build has no TAPKART_ORIGIN',
    )
  })

  it('throws when native and the build origin is a bare slash', () => {
    expect(() => chooseOrigin(true, '/', 'https://localhost')).toThrow(
      'chooseOrigin: native build has no TAPKART_ORIGIN',
    )
  })

  it('strips a trailing slash on both paths', () => {
    expect(chooseOrigin(false, '', 'https://kart.example.com/')).toBe('https://kart.example.com')
    expect(chooseOrigin(true, 'https://tapkart.example/', 'https://localhost')).toBe(
      'https://tapkart.example',
    )
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/invite/test/invite.test.ts apps/web/test/origin.test.ts`

Expected: **FAIL at collect time**, both files, because neither module exists:

```
Error: Failed to resolve import "../src/invite" from "packages/invite/test/invite.test.ts". Does the file exist?
Error: Failed to resolve import "../src/pwa/origin" from "apps/web/test/origin.test.ts". Does the file exist?
```

- [ ] **Step 3: Write the implementation**

Create `packages/invite/src/invite.ts`:

```ts
// PURE. No DOM, no clock, no I/O, and no `URL` — see parseInviteUri.
import { LOBBY_PATH_PREFIX, isValidRoomCode, normalizeRoomCode } from '@tapkart/protocol'

/** Origin cap, so `buildInviteUri` can never produce an un-encodable record and
 *  can never exceed the QR version cap. §5.9 does that arithmetic as a test. */
export const MAX_INVITE_ORIGIN_BYTES = 200

export interface InviteUri {
  origin: string
  roomCode: string
}

const HTTPS_SCHEME = 'https://'

/** Scheme, host and an optional port — and nothing else. ASCII by construction,
 *  which is what makes `origin.length` a BYTE count and MAX_INVITE_ORIGIN_BYTES
 *  measurable without an encoder. */
const ORIGIN_PATTERN = /^https:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?$/

/** `buildInviteUri('https://tapkart.example', 'ABCDE')`
 *   -> 'https://tapkart.example/r/ABCDE'.
 *  Uses LOBBY_PATH_PREFIX from @tapkart/protocol — never a literal.
 *  Throws on a trailing slash in `origin`, on a non-https scheme, on an origin
 *  longer than MAX_INVITE_ORIGIN_BYTES, or on a room code that
 *  `isValidRoomCode` would reject. The room code is upper-cased first.
 *
 *  The checks are ordered, and the order is part of the behaviour: an origin
 *  that violates two of them reports the first, in this implementation and in
 *  any other, forever. */
export function buildInviteUri(origin: string, roomCode: string): string {
  if (origin.endsWith('/')) {
    throw new Error(`buildInviteUri: origin '${origin}' has a trailing slash`)
  }
  if (!origin.startsWith(HTTPS_SCHEME)) {
    throw new Error(`buildInviteUri: origin '${origin}' is not https`)
  }
  if (!ORIGIN_PATTERN.test(origin)) {
    throw new Error(
      `buildInviteUri: origin '${origin}' is not a bare https origin (scheme, host and optional port only)`,
    )
  }
  if (origin.length > MAX_INVITE_ORIGIN_BYTES) {
    throw new Error(
      `buildInviteUri: origin is ${origin.length} bytes, over MAX_INVITE_ORIGIN_BYTES (${MAX_INVITE_ORIGIN_BYTES})`,
    )
  }
  const code = normalizeRoomCode(roomCode)
  if (!isValidRoomCode(code)) {
    throw new Error(`buildInviteUri: '${roomCode}' is not a valid room code`)
  }
  return origin + LOBBY_PATH_PREFIX + code
}

/** Total: returns null rather than throwing, because its inputs come off a
 *  radio and off the address bar. Rejects any scheme but https, any path not
 *  starting with LOBBY_PATH_PREFIX, any malformed room code, and ANY query
 *  string or fragment (P5 Q14: the invite URI carries the room code and nothing
 *  else).
 *
 *  HAND-PARSED. It does not use `URL`: `URL` is an ambient global whose presence
 *  depends on the lib/@types configuration of whoever imports this package, and
 *  its normalisation silently accepts the query strings this function must
 *  reject. Twenty lines of explicit parsing has neither failure mode.
 *
 *  The code is upper-cased before validation: the alphabet is uppercase-only, so
 *  a typed lower-case URI is unambiguous and rejecting it would be a tap that
 *  does nothing for a reason no guest could see. Nothing else is substituted. */
export function parseInviteUri(uri: string): InviteUri | null {
  if (typeof uri !== 'string') return null
  if (uri.includes('?') || uri.includes('#')) return null
  if (!uri.startsWith(HTTPS_SCHEME)) return null
  const pathStart = uri.indexOf('/', HTTPS_SCHEME.length)
  if (pathStart < 0) return null
  const origin = uri.slice(0, pathStart)
  const path = uri.slice(pathStart)
  if (!ORIGIN_PATTERN.test(origin)) return null
  if (origin.length > MAX_INVITE_ORIGIN_BYTES) return null
  if (!path.startsWith(LOBBY_PATH_PREFIX)) return null
  const code = normalizeRoomCode(path.slice(LOBBY_PATH_PREFIX.length))
  if (!isValidRoomCode(code)) return null
  return { origin, roomCode: code }
}

/** 'https://tapkart.example' -> 'tapkart.example'. null on anything that is not
 *  an https origin. Used by §12.2's manifest assertion (value 1 == value 2) and
 *  by nothing shipped.
 *
 *  The port is dropped because `android:host` is a separate attribute from
 *  `android:port`; the case is left exactly as given, because the verifier folds
 *  it and a transform here would make assertion 21 compare two strings that
 *  differ for a reason nobody can see. */
export function originHost(origin: string): string | null {
  if (!ORIGIN_PATTERN.test(origin)) return null
  const hostAndPort = origin.slice(HTTPS_SCHEME.length)
  const colon = hostAndPort.indexOf(':')
  return colon < 0 ? hostAndPort : hostAndPort.slice(0, colon)
}
```

Append to `packages/invite/src/index.ts`, below the `./uri` line:

```ts
export * from './invite'
```

Create `apps/web/src/pwa/origin.ts`:

```ts
// PURE. Contract §10.3, and it is where C-3 lives. No DOM: `location` and the
// native flag arrive as arguments, which is what lets both halves be unit-tested
// with no browser.

/** Trailing slash removed; '' stays ''. Whitespace is NOT touched — trimming is
 *  chooseOrigin's, because only chooseOrigin knows that an all-whitespace build
 *  origin means "unset". */
export function stripTrailingSlash(origin: string): string {
  return origin.endsWith('/') ? origin.slice(0, -1) : origin
}

/** C-3, as a function.
 *
 *  - Not native  -> `locationOrigin`. The running web app builds its own invite
 *    URIs from where it is actually served, so a self-hoster on any domain works
 *    with NO REBUILD and the origin is correct by construction.
 *  - Native      -> `buildOrigin`. Inside the Capacitor WebView `location.origin`
 *    is the WebView's local scheme, NOT the deployed origin, so using it there
 *    would emit an invite URI no guest can open — the silent failure C-3 exists
 *    to prevent. Per F-P5-11 the APK is a domain-specific build anyway, and its
 *    baked origin is the SAME variable that produced its intent filter, which is
 *    exactly what keeps §3's values 1 and 2 agreeing.
 *
 *  THROWS when `isNative` and `buildOrigin` is empty. An APK built with no
 *  TAPKART_ORIGIN would otherwise advertise an invite that resolves nowhere, and
 *  it would do it silently on the one device that has HCE. Failing at module
 *  load, in a build CI runs, is the only loud moment available. */
export function chooseOrigin(
  isNative: boolean,
  buildOrigin: string,
  locationOrigin: string,
): string {
  if (!isNative) return stripTrailingSlash(locationOrigin.trim())
  const baked = stripTrailingSlash(buildOrigin.trim())
  if (baked === '') {
    throw new Error(
      'chooseOrigin: native build has no TAPKART_ORIGIN. An APK built without it would ' +
        'advertise an invite URI that resolves nowhere, on the only device that has HCE.',
    )
  }
  return baked
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run packages/invite/test/invite.test.ts apps/web/test/origin.test.ts
npm run typecheck -w @tapkart/invite
npx tsc --noEmit -p apps/web/tsconfig.json
npx vitest run
```

Expected: **21 passed** in `invite.test.ts` (11 `buildInviteUri` +
5 `parseInviteUri` + 3 `originHost` + 2 budget) and **11 passed** in
`origin.test.ts` (4 + 7), no typecheck output from either command, and no new
failures anywhere.

If `apps/web/test/origin.test.ts` is collected by nothing, the root
`vitest.config.ts` is missing `'apps/*/test/**/*.test.ts'` — that is Plan 3's
edit (R37) and the fix belongs there, not in a per-file override, which contract
§0 forbids outright.

- [ ] **Step 5: Commit**

```bash
git add packages/invite/src/invite.ts packages/invite/src/index.ts packages/invite/test/invite.test.ts apps/web/src/pwa/origin.ts apps/web/test/origin.test.ts && git commit -m "feat(invite): invite URI build/parse and C-3's chooseOrigin"
```
