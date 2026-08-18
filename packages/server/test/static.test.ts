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

  it('preserves a terminal slash and never escapes the root', () => {
    expect(safeJoin(ROOT, '.well-known/foo/')).toBe('apps/web/dist/.well-known/foo/')
    const route = resolveRoute('GET', ASSETLINKS_PATH + '/')
    expect(route.kind).toBe('wellKnown')
    if (route.kind === 'wellKnown') {
      expect(safeJoin(ROOT, route.relPath))
        .toBe('apps/web/dist/.well-known/assetlinks.json/')
    }
    for (const path of ['a/./b.txt', 'a//b.txt']) {
      const joined = safeJoin(ROOT, path)
      expect(joined).not.toBeNull()
      expect(joined!.startsWith(ROOT + '/')).toBe(true)
      expect(joined).not.toContain('..')
    }
  })
})
