### Task 21: `packages/server/src/static.ts` — routing, and the one route that must never redirect

Three constants, one union, three pure functions. The union is the interesting
part: **`Route` has no redirect member, and that is the mechanism rather than an
omission** (C-2).

Spec §2 and §9 both require `/.well-known/assetlinks.json` to be served over
HTTPS with `Content-Type: application/json` and **no redirects**. On Android 12+
a failed App Links verification is *silent* — no chooser, no error, no log the
owner will ever see. The link simply opens in a browser instead of the app, which
is the entire product failing at the one moment it is supposed to feel like
magic: a stranger taps a phone and the game opens.

A routing table that cannot express a redirect cannot acquire one by accident
later. That is why this task asserts the property three ways — behaviourally,
type-exhaustively, and by grepping `packages/server/src` for the machinery a
redirect would need — and why the assertion is worth all three: **a silent
redirect here has no symptom anywhere in this system.** Nothing fails, nothing
logs, and the only evidence is that taps stop opening the app.

**Plan 5 generates the file; Plan 4 serves it** (C-2). The keystore does not
exist yet, so `${staticRoot}/.well-known/assetlinks.json` is absent today and
this server answers **404** — which is right: a placeholder file fails
verification silently, and a 404 at least fails visibly to anyone who looks.

**Execution order.** Depends only on `@tapkart/protocol` (for `LOBBY_PATH_PREFIX`)
and on nothing else in `server`. Land it any time after the scaffold; Task 22's
barrel and Task 23's HTTP adapter both need it.

**Files:**
- Create: `packages/server/src/static.ts`
- Test: `packages/server/test/static.test.ts`

**Interfaces:**

- Consumes — `@tapkart/protocol` [§3.2, shipped in Task 15c item E]:
  ```ts
  /** C-1. Compiled into the APK's autoVerify `pathPrefix`, matched
   *  case-sensitively and prefix-exactly, FROZEN AT THE FIRST SIGNED RELEASE. */
  export const LOBBY_PATH_PREFIX = '/r/'
  ```
  `lobbyPathFor` is **not** used here and must not be re-implemented here: the
  same prefix is compiled into an APK's intent filter and cannot have two homes.

- Produces — `src/static.ts`, the eight §5.10 pins:
  ```ts
  export const WS_PATH = '/ws'
  export const HEALTH_PATH = '/healthz'
  export const WELL_KNOWN_PREFIX = '/.well-known/'
  export const ASSETLINKS_PATH = '/.well-known/assetlinks.json'

  export type Route =
    | { kind: 'file'; relPath: string; contentType: string }
    | { kind: 'spa' }                                          // serve index.html, 200
    | { kind: 'wellKnown'; relPath: string; contentType: string }
    | { kind: 'health' }
    | { kind: 'websocket' }
    | { kind: 'methodNotAllowed' }
    | { kind: 'notFound' }

  /** Total, pure, and the whole routing policy. */
  export function resolveRoute(method: string, pathname: string): Route
  /** Joins and normalises, returning null on any traversal outside `root`. */
  export function safeJoin(root: string, relPath: string): string | null
  export function contentTypeOf(relPath: string): string
  ```

**Three decisions this task makes:**

1. **`safeJoin` percent-decodes exactly once, then judges.** Without decoding,
   `%2e%2e%2f` is a literal filename and harmless — but a legitimate asset with a
   space in its name would never be found. With decoding, `..%2f` and `%2e%2e/`
   both become traversal and are rejected by the same rule that rejects `../`.
   Decoding twice would reintroduce the hole, so it decodes once and never
   re-examines the output as an escape sequence. A malformed escape is `null`,
   not a throw: `decodeURIComponent` throws on `%zz` and this function is reached
   from a public URL.
2. **`safeJoin` does its own path arithmetic and imports no `node:path`.** This
   module is PURE and §5.14 confines `node:path` to `src/runtime/`. The joining
   rule is four lines and a POSIX separator, which is what the container serves
   from.
3. **`resolveRoute` returns `notFound` for a pathname that is not a path at all**
   — one that does not begin with `/`, or contains a NUL or a backslash. Those
   never reach the filesystem, so the one function standing between a public URL
   and `readFileBytes` never sees them.

---

- [ ] **Step 1: Write the failing test**

Create `packages/server/test/static.test.ts`:

```ts
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { LOBBY_PATH_PREFIX } from '@tapkart/protocol'
import type { Route } from '../src/static'
import {
  ASSETLINKS_PATH, HEALTH_PATH, WELL_KNOWN_PREFIX, WS_PATH,
  contentTypeOf, resolveRoute, safeJoin,
} from '../src/static'

/** Exhaustive over `Route`. If an eighth member is ever added -- a redirect, say
 *  -- this stops compiling, which is the point of a union with no redirect in it. */
function kindOf(route: Route): string {
  switch (route.kind) {
    case 'file': return 'file'
    case 'spa': return 'spa'
    case 'wellKnown': return 'wellKnown'
    case 'health': return 'health'
    case 'websocket': return 'websocket'
    case 'methodNotAllowed': return 'methodNotAllowed'
    case 'notFound': return 'notFound'
    default: {
      const unreachable: never = route
      return unreachable
    }
  }
}

const CORPUS: readonly string[] = [
  '/', '/index.html', '/assets/app-8f2a.js', '/assets/app.css', '/favicon.ico',
  '/r/ABCDE', '/r/ABCDE/', '/r/', '/lobby', '/settings/audio',
  HEALTH_PATH, WS_PATH, ASSETLINKS_PATH, ASSETLINKS_PATH + '/',
  WELL_KNOWN_PREFIX, '/.well-known/foo/bar', '/.well-known/foo/',
  '/nope.png', '/a/b', '', 'no-leading-slash', '/nul\u0000here', '/back\\slash',
  '/..%2fetc%2fpasswd', '/%2e%2e/etc/passwd',
]

describe('resolveRoute — the whole routing policy', () => {
  it('produces only the seven known kinds, for every method and path in the corpus', () => {
    const seen = new Set<string>()
    for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'get']) {
      for (const path of CORPUS) seen.add(kindOf(resolveRoute(method, path)))
    }
    // The floor: the corpus really did exercise the table.
    expect(seen.size).toBeGreaterThan(4)
    for (const kind of seen) {
      expect(['file', 'spa', 'wellKnown', 'health', 'websocket', 'methodNotAllowed', 'notFound'])
        .toContain(kind)
    }
  })

  it('routes the fixed paths', () => {
    expect(resolveRoute('GET', WS_PATH)).toEqual({ kind: 'websocket' })
    expect(resolveRoute('GET', HEALTH_PATH)).toEqual({ kind: 'health' })
    expect(resolveRoute('HEAD', HEALTH_PATH)).toEqual({ kind: 'health' })
  })

  it('routes an invite path and every unknown extensionless path to the SPA', () => {
    expect(resolveRoute('GET', LOBBY_PATH_PREFIX + 'ABCDE')).toEqual({ kind: 'spa' })
    expect(resolveRoute('GET', '/')).toEqual({ kind: 'spa' })
    expect(resolveRoute('GET', '/settings/audio')).toEqual({ kind: 'spa' })
  })

  it('routes a path with an extension to a file, with its content type', () => {
    expect(resolveRoute('GET', '/assets/app-8f2a.js')).toEqual({
      kind: 'file', relPath: 'assets/app-8f2a.js', contentType: 'text/javascript; charset=utf-8',
    })
    expect(resolveRoute('GET', '/index.html')).toEqual({
      kind: 'file', relPath: 'index.html', contentType: 'text/html; charset=utf-8',
    })
  })

  it('refuses a non-GET method before anything else, including on the well-known path', () => {
    expect(resolveRoute('POST', ASSETLINKS_PATH)).toEqual({ kind: 'methodNotAllowed' })
    expect(resolveRoute('DELETE', '/index.html')).toEqual({ kind: 'methodNotAllowed' })
  })

  it('refuses a pathname that is not a path', () => {
    expect(resolveRoute('GET', '')).toEqual({ kind: 'notFound' })
    expect(resolveRoute('GET', 'no-leading-slash')).toEqual({ kind: 'notFound' })
    expect(resolveRoute('GET', '/nul\u0000here')).toEqual({ kind: 'notFound' })
    expect(resolveRoute('GET', '/back\\slash')).toEqual({ kind: 'notFound' })
  })
})

describe('/.well-known — spec §2\'s silent failure, closed three ways', () => {
  it('serves assetlinks.json as wellKnown with application/json', () => {
    expect(resolveRoute('GET', ASSETLINKS_PATH)).toEqual({
      kind: 'wellKnown', relPath: '.well-known/assetlinks.json', contentType: 'application/json',
    })
    expect(contentTypeOf('assetlinks.json')).toBe('application/json')
  })

  it('applies NO trailing-slash normalisation under the prefix', () => {
    // A normaliser here is a redirect wearing a different hat: Android follows
    // nothing, and a 301 to the same path without the slash is a verification
    // failure that reports itself nowhere.
    const withSlash = resolveRoute('GET', ASSETLINKS_PATH + '/')
    expect(withSlash).toEqual({
      kind: 'wellKnown', relPath: '.well-known/assetlinks.json/', contentType: 'application/json',
    })
    expect(resolveRoute('GET', '/.well-known/foo/')).toEqual({
      kind: 'wellKnown', relPath: '.well-known/foo/', contentType: 'application/octet-stream',
    })
  })

  it('resolves ANY path under the prefix, before the SPA catch-all can swallow it', () => {
    for (const path of [WELL_KNOWN_PREFIX, '/.well-known/foo', '/.well-known/foo/bar', '/.well-known/a.b.c']) {
      expect(resolveRoute('GET', path).kind).toBe('wellKnown')
    }
    // The floor: an extensionless path OUTSIDE the prefix really does hit the
    // SPA rule, so "wellKnown" above is precedence and not an accident.
    expect(resolveRoute('GET', '/well-known/foo').kind).toBe('spa')
  })

  it('produces no redirect for any input, because Route cannot express one', () => {
    // Behavioural half of the same statement: over the whole corpus and every
    // method, nothing carries a status or a target.
    for (const method of ['GET', 'HEAD', 'POST']) {
      for (const path of CORPUS) {
        const route = resolveRoute(method, path)
        expect(Object.keys(route)).not.toContain('status')
        expect(Object.keys(route)).not.toContain('location')
        expect(Object.keys(route)).not.toContain('redirect')
      }
    }
  })

  it('has no redirect machinery anywhere in packages/server/src', () => {
    // The third way, and the one that also covers runtime/http.ts once Task 23
    // writes it: a trailing-slash redirect or an HSTS upgrade added there would
    // touch this path without touching this module.
    const src = join(import.meta.dirname, '..', 'src')
    const files: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (entry.name.endsWith('.ts')) files.push(full)
      }
    }
    walk(src)
    expect(files.length).toBeGreaterThan(0)          // the floor

    const hits: string[] = []
    for (const file of files) {
      const text = readFileSync(file, 'utf8')
      if (/['"]Location['"]/i.test(text)) hits.push(file + ': sets a Location header')
      if (/\b30[12378]\b/.test(text)) hits.push(file + ': names a 3xx status code')
    }
    expect(hits).toEqual([])
  })
})

describe('contentTypeOf', () => {
  it('maps the extensions this app actually ships', () => {
    expect(contentTypeOf('index.html')).toBe('text/html; charset=utf-8')
    expect(contentTypeOf('assets/app.js')).toBe('text/javascript; charset=utf-8')
    expect(contentTypeOf('assets/app.mjs')).toBe('text/javascript; charset=utf-8')
    expect(contentTypeOf('assets/app.css')).toBe('text/css; charset=utf-8')
    expect(contentTypeOf('.well-known/assetlinks.json')).toBe('application/json')
    expect(contentTypeOf('app.webmanifest')).toBe('application/manifest+json')
    expect(contentTypeOf('icon.svg')).toBe('image/svg+xml')
    expect(contentTypeOf('icon.png')).toBe('image/png')
    expect(contentTypeOf('font.woff2')).toBe('font/woff2')
    expect(contentTypeOf('engine.mp3')).toBe('audio/mpeg')
  })

  it('is case-insensitive on the extension and octet-stream on anything else', () => {
    expect(contentTypeOf('ICON.PNG')).toBe('image/png')
    expect(contentTypeOf('LICENSE')).toBe('application/octet-stream')
    expect(contentTypeOf('archive.tar.zzz')).toBe('application/octet-stream')
    expect(contentTypeOf('trailing.')).toBe('application/octet-stream')
    expect(contentTypeOf('dir.with.dots/file')).toBe('application/octet-stream')
  })
})

describe('safeJoin — the one function between a public URL and the filesystem', () => {
  const ROOT = 'apps/web/dist'

  it('joins an ordinary relative path', () => {
    expect(safeJoin(ROOT, 'index.html')).toBe('apps/web/dist/index.html')
    expect(safeJoin(ROOT, 'assets/app-8f2a.js')).toBe('apps/web/dist/assets/app-8f2a.js')
    expect(safeJoin(ROOT + '/', 'index.html')).toBe('apps/web/dist/index.html')
    expect(safeJoin(ROOT, '.well-known/assetlinks.json')).toBe('apps/web/dist/.well-known/assetlinks.json')
  })

  it('decodes percent-escapes exactly once', () => {
    expect(safeJoin(ROOT, 'my%20file.txt')).toBe('apps/web/dist/my file.txt')
    // %252e%252e is "%2e%2e" once decoded -- a filename, not a traversal, and it
    // must not be decoded a second time into one.
    expect(safeJoin(ROOT, 'a%252e%252eb.txt')).toBe('apps/web/dist/a%2e%2eb.txt')
  })

  it('returns null for every known-hostile path', () => {
    const hostile = [
      '../secrets.env',
      'assets/../../secrets.env',
      '..%2fsecrets.env',
      '%2e%2e/secrets.env',
      '%2E%2E%2Fsecrets.env',
      '/etc/passwd',
      'C:\\windows\\win.ini',
      'assets\\..\\..\\secrets.env',
      'nul\u0000.html',
      'a%zz.html',            // a malformed escape must not throw
      '',
      '.',
      './',
      '..',
    ]
    for (const path of hostile) {
      expect(safeJoin(ROOT, path), path).toBeNull()
    }
    // The floor: the same root DOES join a benign path, so "null" above is a
    // rule and not a function that always refuses.
    expect(safeJoin(ROOT, 'index.html')).not.toBeNull()
  })

  it('keeps a trailing slash out of the joined path and never escapes the root', () => {
    expect(safeJoin(ROOT, '.well-known/foo/')).toBe('apps/web/dist/.well-known/foo')
    for (const path of ['a/./b.txt', 'a//b.txt']) {
      const joined = safeJoin(ROOT, path)
      expect(joined).not.toBeNull()
      expect(joined!.startsWith(ROOT + '/')).toBe(true)
      expect(joined).not.toContain('..')
    }
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/server/test/static.test.ts`

Expected: FAIL at collection with
`Failed to resolve import "../src/static" from "packages/server/test/static.test.ts". Does the file exist?`

- [ ] **Step 3: Write `packages/server/src/static.ts`**

```ts
// PURE. Total over any method and any pathname, and it imports no `node:path`:
// §5.14 confines that to src/runtime/, and the joining rule is four lines over a
// POSIX separator, which is what the container serves from.
import { LOBBY_PATH_PREFIX } from '@tapkart/protocol'

export const WS_PATH = '/ws'
export const HEALTH_PATH = '/healthz'
export const WELL_KNOWN_PREFIX = '/.well-known/'
export const ASSETLINKS_PATH = '/.well-known/assetlinks.json'

/**
 * The whole routing table.
 *
 * There is NO redirect member, and that is the mechanism rather than an
 * omission (C-2). Spec §2 and §9 both require /.well-known/assetlinks.json to be
 * served with no redirects, and on Android 12+ a failed App Links verification
 * is silent: no chooser, no error, no log -- the link just opens in a browser.
 * A table that cannot express a redirect cannot acquire one by accident later.
 */
export type Route =
  | { kind: 'file'; relPath: string; contentType: string }
  | { kind: 'spa' }                                          // serve index.html, 200
  | { kind: 'wellKnown'; relPath: string; contentType: string }
  | { kind: 'health' }
  | { kind: 'websocket' }
  | { kind: 'methodNotAllowed' }
  | { kind: 'notFound' }

export function resolveRoute(method: string, pathname: string): Route {
  const verb = method.toUpperCase()
  if (verb !== 'GET' && verb !== 'HEAD') return { kind: 'methodNotAllowed' }

  // Not a path at all. These never reach the filesystem.
  if (!pathname.startsWith('/')) return { kind: 'notFound' }
  if (pathname.includes('\u0000') || pathname.includes('\\')) return { kind: 'notFound' }

  if (pathname === WS_PATH) return { kind: 'websocket' }
  if (pathname === HEALTH_PATH) return { kind: 'health' }

  // Checked BEFORE the SPA catch-all, so no future "serve everything as the
  // SPA" rule can swallow it, and with NO trailing-slash normalisation: a
  // normaliser here is a redirect wearing a different hat.
  if (pathname.startsWith(WELL_KNOWN_PREFIX)) {
    const relPath = pathname.slice(1)
    return { kind: 'wellKnown', relPath, contentType: contentTypeOf(relPath) }
  }

  // `/r/ABCDE` is the invite path (C-1), and it is the SPA: the room code is the
  // client's to read. LOBBY_PATH_PREFIX is imported, never re-declared -- the
  // same string is compiled into an APK's autoVerify pathPrefix.
  if (pathname === '/' || pathname.startsWith(LOBBY_PATH_PREFIX)) return { kind: 'spa' }

  const relPath = pathname.slice(1)
  const lastSlash = relPath.lastIndexOf('/')
  const lastSegment = relPath.slice(lastSlash + 1)
  if (lastSegment.includes('.')) {
    return { kind: 'file', relPath, contentType: contentTypeOf(relPath) }
  }
  // Everything else is a client-side route.
  return { kind: 'spa' }
}

const CONTENT_TYPES = new Map<string, string>([
  ['html', 'text/html; charset=utf-8'],
  ['js', 'text/javascript; charset=utf-8'],
  ['mjs', 'text/javascript; charset=utf-8'],
  ['css', 'text/css; charset=utf-8'],
  ['json', 'application/json'],
  ['map', 'application/json'],
  ['webmanifest', 'application/manifest+json'],
  ['wasm', 'application/wasm'],
  ['svg', 'image/svg+xml'],
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['gif', 'image/gif'],
  ['webp', 'image/webp'],
  ['ico', 'image/x-icon'],
  ['woff', 'font/woff'],
  ['woff2', 'font/woff2'],
  ['ttf', 'font/ttf'],
  ['mp3', 'audio/mpeg'],
  ['ogg', 'audio/ogg'],
  ['wav', 'audio/wav'],
  ['txt', 'text/plain; charset=utf-8'],
  ['glb', 'model/gltf-binary'],
  ['gltf', 'model/gltf+json'],
])

export function contentTypeOf(relPath: string): string {
  const dot = relPath.lastIndexOf('.')
  const slash = relPath.lastIndexOf('/')
  if (dot < 0 || dot < slash || dot === relPath.length - 1) return 'application/octet-stream'
  const found = CONTENT_TYPES.get(relPath.slice(dot + 1).toLowerCase())
  return found === undefined ? 'application/octet-stream' : found
}

/**
 * Joins and normalises, returning null on any traversal outside `root` -- '..',
 * absolute paths, encoded separators, NUL, backslashes. The one function
 * standing between a public URL and the filesystem.
 *
 * It decodes percent-escapes EXACTLY ONCE. Without decoding, a legitimate asset
 * with a space in its name would never be found; decoding twice would let
 * `%252e%252e` become a traversal on the second pass.
 */
export function safeJoin(root: string, relPath: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(relPath)
  } catch {
    return null            // a malformed escape reaches us from a public URL
  }

  if (decoded.length === 0) return null
  if (decoded.includes('\u0000')) return null
  if (decoded.includes('\\')) return null
  if (decoded.startsWith('/')) return null
  if (/^[A-Za-z]:/.test(decoded)) return null       // a Windows drive is absolute too

  const parts: string[] = []
  for (const segment of decoded.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') return null
    parts.push(segment)
  }
  if (parts.length === 0) return null

  const base = root.endsWith('/') ? root.slice(0, -1) : root
  return base + '/' + parts.join('/')
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/server/test/static.test.ts`
Expected: 14 passing.

Run: `npx tsc --noEmit -p packages/server/tsconfig.json`
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/static.ts packages/server/test/static.test.ts
git commit -m "feat(server): routing, and the well-known path that must never redirect

Route has no redirect member. Spec §2 and §9 require
/.well-known/assetlinks.json served with no redirects, and on Android 12+ a
failed App Links verification is SILENT -- no chooser, no error, no log. The
tap opens a browser instead of the app and nothing in this system reports
it, so the property is asserted three ways: behaviourally over a corpus of
25 paths and 7 methods, type-exhaustively through a never-check that stops
compiling if an eighth Route member appears, and by grepping every file in
packages/server/src for a Location header or a 3xx status -- which also
covers the HTTP adapter, where a trailing-slash or HSTS redirect would be
added without touching this module.

/.well-known/* resolves before the SPA catch-all and keeps its trailing
slash: a normaliser there is a redirect wearing a different hat. Plan 5
generates the file; an absent one is a 404 by design, because a placeholder
fails verification silently and a 404 fails visibly.

safeJoin percent-decodes exactly once and rejects '..', absolute paths,
encoded separators, NUL and backslashes, unit-tested against fourteen
known-hostile inputs. It imports no node:path: this module is pure."
```
