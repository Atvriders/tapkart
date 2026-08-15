### Task 16: the service worker, the two-program tsconfig split, the build tooling, and the web manifest

> **Execution corrections (2026-08-15):** preserve Plan 3's Vite ambient types
> while adding tooling types: the app program uses
> `"types": ["vite/client", "node"]`; only the worker program uses `"types": []`.
> Add `predev: node tools/png.mjs` so the linked icon exists on a clean dev
> checkout. The current inline-CSS bundle yields a derived baseline of six
> precache entries, not a normative seven. Finally, seed the built worker's
> cache version with private per-file content digests as well as paths; hashing
> names alone leaves changed `index.html`, manifest, or icon bytes under an old
> cache name. Keep `buildPrecacheList`/`precacheVersion` at two public exports and
> keep the actual fetch list unchanged.

**Files:**
- Create: `apps/web/src/sw.ts` — ADAPTER, contract §8.4
- Create: `apps/web/tsconfig.sw.json` — the **only** program that sees `WebWorker`
- Create: `apps/web/public/manifest.webmanifest` — contract §8.2, verbatim
- Create: `apps/web/tools/precache.mjs` — contract §8.7
- Create: `apps/web/tools/png.mjs` — contract §8.7
- Create: `apps/web/tools/build-sw.mjs` — contract §8.7, and the home of §12.2 assertions 26 and 27
- Test: `apps/web/test/precache.test.ts`
- Test: `apps/web/test/png.test.ts`
- Modify: `apps/web/tsconfig.json` — `include` gains `tools/**/*.ts`; `exclude` gains `src/sw.ts` (§8.4)
- Modify: `apps/web/package.json` — `build` chains the icons and the worker; `typecheck` runs both tsconfigs
- Modify: `apps/web/vite.config.ts` — `build.manifest = true`
- Modify: `apps/web/index.html` — the manifest link, icon link, and the `theme-color` meta

**Ordering:** after **Task 15**, which writes `src/pwa/policy.ts` — the one module compiled in both programs, and the module `sw.ts` imports.

**Interfaces:**

- **Consumes** — Task 15's `policy.ts`, quoted, and nothing else from this repository:

  ```ts
  export interface SwRequestInfo { method: string; url: string; sameOrigin: boolean; isNavigate: boolean }
  export type SwRouteAction = 'passthrough' | 'cacheFirst' | 'networkFirst' | 'networkOnly' | 'shellFallback'
  export interface SwRoute { action: SwRouteAction; cacheKey: string }
  export interface SwConfig {
    cacheName: string
    precache: readonly string[]
    shellPath: string
    neverCachePrefixes: readonly string[]
  }
  export const NEVER_CACHE_PREFIXES: readonly string[]
  export const DEFAULT_SW_CONFIG: Readonly<SwConfig>
  export function routeRequest(info: SwRequestInfo, cfg: SwConfig): SwRoute
  ```

- **Produces** — contract §8.7, exactly two exports each:

  ```js
  // apps/web/tools/precache.mjs
  export function buildPrecacheList(viteManifest, extras)  // -> sorted absolute paths
  export function precacheVersion(list)                    // -> short stable hash of the list

  // apps/web/tools/png.mjs
  export function encodePng(width, height, rgba)           // -> Uint8Array, zlib via node:zlib
  export function drawIconRgba(size, palette)              // -> Uint8Array, deterministic
  ```

  and `apps/web/src/sw.ts`, which exports **nothing** — §16's census records it as `0 (a worker entry exports nothing)`.

**GAP-5, and why this task carries a tsconfig.** §8.4, in full, because the resolution is not obvious and the error it prevents points at the wrong file:

> Plan 3 §10.1 gives `apps/web` `"lib": ["ES2022", "DOM", "DOM.Iterable"]` with `"include": ["src/**/*.ts", "vite.config.ts"]`. TypeScript's `dom` and `webworker` libs **cannot coexist in one compilation** — `self`, `fetch`, `AbortController`, `EventTarget` and dozens more are declared in both — so the draft's single `/// <reference lib="webworker" />` inside that program is a duplicate-identifier error, not an idiom, and `npm run typecheck` fails the moment `sw.ts` lands.

Three parts of the fix are not decoration:

- **`"types": []`** on the worker program. Without it `@types/node` — a root devDependency, in scope everywhere because no program restricts `types` — contributes its own `fetch`, `Blob`, `Event`, `EventTarget` and `MessageEvent` globals, whose DOM-deferral trick keys off DOM markers the WebWorker lib does not provide.
- **`"exclude": ["src/sw.ts"]`** on the app program. `include: src/**/*.ts` would otherwise pull the worker back into the DOM program and reintroduce exactly the error the split exists to prevent.
- **`tools/**/*.ts`** added to the app program, so `write-assetlinks.ts` is typechecked at all. Under Plan 3's `include` it was in no program — *"the one TypeScript file that runs in production containers was the one file `tsc` never saw."* That file is written by the deploy task; the `include` is widened here, with the rest of §8.4.

**There is NO `/// <reference lib="webworker" />` anywhere in this repository**, and `const sw = self as unknown as ServiceWorkerGlobalScope` is a **pinned idiom** — §8.4 pins it so two tasks do not invent two ways to type `self`.

**F-P5-26, and what "gates the build" is made of.** *"Offline solo is a requirement… the game is fully playable solo against bots with zero server involvement… Gated ⇒ the service worker's precache list is load-bearing and a broken offline path fails CI instead of shipping silently."*

Gating has two halves, and this task builds the first:

1. **Build time, here.** `build-sw.mjs` fails the build if any precache entry does not exist in `dist/`, if `dist/sw.js` is not at the root of `dist/` unhashed, or if the web manifest is not installable-shaped with every declared icon present at its declared size. That is §12.2 assertions 26 and 27, executed by the build rather than by a separate script — because *"a `Cache.addAll()` with one missing entry rejects, and a rejected `addAll` discards the whole precache: the install fails, and the app has no offline story at all, with nothing in the console but one line nobody reads."*
2. **Run time, Task 20.** The Playwright spec that goes offline and starts a solo race (§12.3 assertion 33).

Neither substitutes for the other: the build check proves the list is *fetchable*, and only the browser proves the app *runs* from it.

**What CI cannot prove here** (§14): that the install prompt appears — *"Chrome's engagement heuristics"* — and how the icon looks on a home screen. Assertion 26 proves the manifest is installable-**shaped**, which is a different sentence. `docs/owner-verification.md` item 13 is the airplane-mode check on a real phone.

**Browser-smoke correction (verified 2026-08-15).** Plan 3's otherwise-clean
Chrome run requests `/favicon.ico` and logs a 404. The icon generated by this
task is also the favicon: add the explicit `rel="icon"` link in Step 3h. This
keeps the browser console gate strict without adding a fourth image or an
unversioned root file.

---

- [ ] **Step 1: Write the failing test**

Create `apps/web/test/precache.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { buildPrecacheList, precacheVersion } from '../tools/precache.mjs'

/** The shape Vite writes to dist/.vite/manifest.json with build.manifest = true:
 *  one record per input, keyed by source path. Trimmed to the fields the tool
 *  reads, and otherwise real. */
const VITE_MANIFEST = {
  'index.html': {
    file: 'assets/index-1a2b3c4d.js',
    src: 'index.html',
    isEntry: true,
    css: ['assets/index-9f8e7d6c.css'],
    assets: ['assets/kart-5e4d3c2b.png'],
  },
  '_shared-aabbccdd.js': {
    file: 'assets/shared-aabbccdd.js',
    css: [],
  },
}

const EXTRAS = ['/index.html', '/manifest.webmanifest', '/icons/icon-192.png']

describe('buildPrecacheList', () => {
  it('takes every file, css and asset out of the manifest, as absolute paths', () => {
    const list = buildPrecacheList(VITE_MANIFEST, [])
    expect(list).toEqual([
      '/assets/index-1a2b3c4d.js',
      '/assets/index-9f8e7d6c.css',
      '/assets/kart-5e4d3c2b.png',
      '/assets/shared-aabbccdd.js',
    ])
  })

  it('merges the extras and sorts the whole thing', () => {
    expect(buildPrecacheList(VITE_MANIFEST, EXTRAS)).toEqual([
      '/assets/index-1a2b3c4d.js',
      '/assets/index-9f8e7d6c.css',
      '/assets/kart-5e4d3c2b.png',
      '/assets/shared-aabbccdd.js',
      '/icons/icon-192.png',
      '/index.html',
      '/manifest.webmanifest',
    ])
  })

  it('de-duplicates, because a shared chunk appears under several entries', () => {
    const dup = {
      a: { file: 'assets/shared.js', css: ['assets/one.css'] },
      b: { file: 'assets/shared.js', css: ['assets/one.css'] },
    }
    expect(buildPrecacheList(dup, ['/assets/shared.js'])).toEqual(['/assets/one.css', '/assets/shared.js'])
  })

  it('is sorted, so the version hash does not move when Vite reorders its manifest', () => {
    const reversed = Object.fromEntries(Object.entries(VITE_MANIFEST).reverse())
    expect(buildPrecacheList(reversed, EXTRAS)).toEqual(buildPrecacheList(VITE_MANIFEST, EXTRAS))
  })

  it('accepts an extra that is already absolute and does not double the slash', () => {
    expect(buildPrecacheList({}, ['/index.html'])).toEqual(['/index.html'])
  })

  it('returns an empty list for an empty manifest and no extras', () => {
    expect(buildPrecacheList({}, [])).toEqual([])
  })

  it('throws on a manifest record with no file, rather than precaching undefined', () => {
    expect(() => buildPrecacheList({ bad: { css: [] } }, [])).toThrow(
      "buildPrecacheList: manifest entry 'bad' has no 'file'",
    )
  })
})

describe('precacheVersion', () => {
  it('is stable for the same list', () => {
    const list = buildPrecacheList(VITE_MANIFEST, EXTRAS)
    expect(precacheVersion(list)).toBe(precacheVersion([...list]))
  })

  it('changes when any entry changes — a content hash moving must move the cache name', () => {
    const list = buildPrecacheList(VITE_MANIFEST, EXTRAS)
    const moved = list.map((p) => (p.includes('index-1a2b3c4d') ? '/assets/index-deadbeef.js' : p))
    expect(precacheVersion(moved)).not.toBe(precacheVersion(list))
  })

  it('changes when an entry is added', () => {
    expect(precacheVersion(['/a.js'])).not.toBe(precacheVersion(['/a.js', '/b.js']))
  })

  it('is short, lowercase hex, and safe inside a Cache name', () => {
    expect(precacheVersion(['/a.js'])).toMatch(/^[0-9a-f]{8}$/)
  })

  it('distinguishes lists that differ only in order of two entries with the same characters', () => {
    expect(precacheVersion(['/ab.js', '/c.js'])).not.toBe(precacheVersion(['/a.js', '/bc.js']))
  })
})
```

Create `apps/web/test/png.test.ts`:

```ts
import { inflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { drawIconRgba, encodePng } from '../tools/png.mjs'

const PALETTE = { background: [0x0b, 0x0d, 0x10], foreground: [0x6c, 0xe6, 0xff], inset: 0 }

/** The PNG signature, from the spec. Byte for byte, not recomputed. */
const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/** An independent CRC-32, written from the polynomial rather than reusing the
 *  encoder's table — a checksum verified with its own implementation verifies
 *  nothing. */
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const b of bytes) {
    crc ^= b
    for (let i = 0; i < 8; i++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function readU32(b: Uint8Array, at: number): number {
  return ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0
}

interface Chunk {
  type: string
  data: Uint8Array
  crc: number
  crcOverTypeAndData: number
}

function chunks(png: Uint8Array): Chunk[] {
  const out: Chunk[] = []
  let at = 8
  while (at < png.length) {
    const length = readU32(png, at)
    const type = String.fromCharCode(png[at + 4], png[at + 5], png[at + 6], png[at + 7])
    const data = png.subarray(at + 8, at + 8 + length)
    const crc = readU32(png, at + 8 + length)
    out.push({ type, data, crc, crcOverTypeAndData: crc32(png.subarray(at + 4, at + 8 + length)) })
    at += 12 + length
  }
  return out
}

describe('encodePng', () => {
  it('starts with the PNG signature', () => {
    const png = encodePng(2, 2, new Uint8Array(2 * 2 * 4))
    expect([...png.subarray(0, 8)]).toEqual(SIGNATURE)
  })

  it('emits IHDR, IDAT and IEND, in that order and nothing else', () => {
    const png = encodePng(4, 4, new Uint8Array(4 * 4 * 4))
    expect(chunks(png).map((c) => c.type)).toEqual(['IHDR', 'IDAT', 'IEND'])
  })

  it('writes an IHDR that says 8-bit RGBA, uncompressed-filter, non-interlaced', () => {
    const png = encodePng(192, 96, new Uint8Array(192 * 96 * 4))
    const ihdr = chunks(png)[0]
    expect(readU32(ihdr.data, 0)).toBe(192)
    expect(readU32(ihdr.data, 4)).toBe(96)
    expect(ihdr.data[8]).toBe(8) // bit depth
    expect(ihdr.data[9]).toBe(6) // colour type: truecolour with alpha
    expect(ihdr.data[10]).toBe(0) // compression: deflate
    expect(ihdr.data[11]).toBe(0) // filter method
    expect(ihdr.data[12]).toBe(0) // no interlace
  })

  it('gets every chunk CRC right, checked against an independent CRC-32', () => {
    const png = encodePng(8, 8, drawIconRgba(8, PALETTE))
    for (const c of chunks(png)) {
      expect(c.crc).toBe(c.crcOverTypeAndData)
    }
  })

  it('round-trips the pixels: inflating IDAT gives filter-0 scanlines of the input', () => {
    const rgba = new Uint8Array(2 * 2 * 4)
    for (let i = 0; i < rgba.length; i++) rgba[i] = (i * 7) & 0xff
    const png = encodePng(2, 2, rgba)
    const idat = chunks(png).find((c) => c.type === 'IDAT')!
    const raw = inflateSync(Buffer.from(idat.data))
    // Each scanline is 1 filter byte + width*4 pixel bytes.
    expect(raw.length).toBe(2 * (1 + 2 * 4))
    expect(raw[0]).toBe(0)
    expect([...raw.subarray(1, 9)]).toEqual([...rgba.subarray(0, 8)])
    expect(raw[9]).toBe(0)
    expect([...raw.subarray(10, 18)]).toEqual([...rgba.subarray(8, 16)])
  })

  it('throws when the pixel buffer is not width*height*4', () => {
    expect(() => encodePng(2, 2, new Uint8Array(15))).toThrow('encodePng: expected 16 bytes, got 15')
  })
})

describe('drawIconRgba', () => {
  it('returns exactly size*size*4 bytes', () => {
    for (const size of [192, 512]) {
      expect(drawIconRgba(size, PALETTE).length).toBe(size * size * 4)
    }
  })

  it('is deterministic — the same arguments give byte-identical output', () => {
    expect([...drawIconRgba(64, PALETTE)]).toEqual([...drawIconRgba(64, PALETTE)])
  })

  it('is fully opaque everywhere, because a home-screen icon with holes looks broken', () => {
    const rgba = drawIconRgba(32, PALETTE)
    for (let i = 3; i < rgba.length; i += 4) {
      expect(rgba[i]).toBe(255)
    }
  })

  it('paints the corner with the background colour', () => {
    const rgba = drawIconRgba(64, PALETTE)
    expect([rgba[0], rgba[1], rgba[2]]).toEqual(PALETTE.background)
  })

  it('paints something in the foreground colour — an icon of one flat colour is a bug', () => {
    const rgba = drawIconRgba(128, PALETTE)
    let foreground = 0
    for (let i = 0; i < rgba.length; i += 4) {
      if (rgba[i] === PALETTE.foreground[0] && rgba[i + 1] === PALETTE.foreground[1]) foreground++
    }
    expect(foreground).toBeGreaterThan(128) // more than a rounding artefact
  })

  it('keeps the maskable inset clear, so Android\'s circular crop takes nothing off the mark', () => {
    const size = 128
    const inset = 0.1
    const rgba = drawIconRgba(size, { ...PALETTE, inset })
    const margin = Math.floor(size * inset)
    const isBackground = (x: number, y: number) => {
      const i = (y * size + x) * 4
      return rgba[i] === PALETTE.background[0] && rgba[i + 1] === PALETTE.background[1]
    }
    for (let x = 0; x < size; x++) {
      for (let y = 0; y < margin; y++) {
        expect(isBackground(x, y)).toBe(true)
        expect(isBackground(x, size - 1 - y)).toBe(true)
        expect(isBackground(y, x)).toBe(true)
        expect(isBackground(size - 1 - y, x)).toBe(true)
      }
    }
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run apps/web/test/precache.test.ts apps/web/test/png.test.ts`

Expected: **FAIL at collect time**, twice:

```
Error: Failed to resolve import "../tools/precache.mjs" from "apps/web/test/precache.test.ts". Does the file exist?
Error: Failed to resolve import "../tools/png.mjs" from "apps/web/test/png.test.ts". Does the file exist?
```

- [ ] **Step 3: Write the implementation**

**3a.** Create `apps/web/tools/precache.mjs`:

```js
// Build tooling. `.mjs`, not `.ts`, so vitest imports it with no loader and
// `tsc` ignores it: build tooling is not shipped code (§8.7).

/** Every file the built app needs, as sorted absolute paths.
 *
 *  The six bundled tracks need no entry: Plan 3 §3a.1 imports them statically,
 *  so they are inside the JS bundle already, and adding them separately would
 *  precache a copy nothing fetches. */
export function buildPrecacheList(viteManifest, extras) {
  const paths = new Set()
  const add = (p) => {
    if (typeof p !== 'string' || p.length === 0) return
    paths.add(p.startsWith('/') ? p : `/${p}`)
  }

  for (const [key, record] of Object.entries(viteManifest)) {
    if (typeof record.file !== 'string' || record.file.length === 0) {
      throw new Error(`buildPrecacheList: manifest entry '${key}' has no 'file'`)
    }
    add(record.file)
    for (const css of record.css ?? []) add(css)
    for (const asset of record.assets ?? []) add(asset)
  }
  for (const extra of extras) add(extra)

  return [...paths].sort()
}

/** A short, stable hash of the list. FNV-1a over the joined paths, so the cache
 *  name moves whenever any content hash in the list moves — which is what makes
 *  `activate`'s "delete every tapkart- cache that is not mine" collect the old
 *  one instead of serving it forever.
 *
 *  The separator is what stops ['/ab.js','/c.js'] and ['/a.js','/bc.js'] hashing
 *  alike; the list is already sorted, so the hash does not move when Vite
 *  reorders its manifest. */
export function precacheVersion(list) {
  let hash = 0x811c9dc5
  const joined = list.join('\n')
  for (let i = 0; i < joined.length; i++) {
    hash ^= joined.charCodeAt(i) & 0xff
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}
```

**3b.** Create `apps/web/tools/png.mjs`:

```js
// Build tooling (§8.7). Exports two pure functions, and writes the three icons
// when it is run directly — P5 Q27 puts the icons in `public/icons/`, generated
// at build time and gitignored, so no binary lands in git and the generator is a
// pure function CI can assert.

import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(bytes) {
  let crc = 0xffffffff
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function u32(value) {
  return Uint8Array.from([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff])
}

function chunk(type, data) {
  const typeBytes = Uint8Array.from([...type].map((c) => c.charCodeAt(0)))
  const body = new Uint8Array(typeBytes.length + data.length)
  body.set(typeBytes, 0)
  body.set(data, typeBytes.length)
  const out = new Uint8Array(4 + body.length + 4)
  out.set(u32(data.length), 0)
  out.set(body, 4)
  out.set(u32(crc32(body)), 4 + body.length)
  return out
}

function concat(parts) {
  let total = 0
  for (const p of parts) total += p.length
  const out = new Uint8Array(total)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

/** 8-bit RGBA, no interlace, every scanline filter 0. */
export function encodePng(width, height, rgba) {
  const expected = width * height * 4
  if (rgba.length !== expected) {
    throw new Error(`encodePng: expected ${expected} bytes, got ${rgba.length}`)
  }

  const raw = new Uint8Array(height * (1 + width * 4))
  for (let y = 0; y < height; y++) {
    const to = y * (1 + width * 4)
    raw[to] = 0 // filter: none
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), to + 1)
  }

  const ihdr = new Uint8Array(13)
  ihdr.set(u32(width), 0)
  ihdr.set(u32(height), 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type: truecolour with alpha
  ihdr[10] = 0 // compression: deflate
  ihdr[11] = 0 // filter method
  ihdr[12] = 0 // interlace: none

  return concat([
    Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', new Uint8Array(deflateSync(Buffer.from(raw), { level: 9 }))),
    chunk('IEND', new Uint8Array(0)),
  ])
}

/** The mark: a filled disc — the point a phone is tapped against — with two
 *  arcs rising off it. Deterministic arithmetic, no randomness and no clock, so
 *  two builds produce byte-identical icons and the precache hash does not move
 *  for no reason.
 *
 *  `palette.inset` is the fraction of the size kept clear at every edge. It is 0
 *  for the `any` icons and 0.1 for the maskable one, whose outer tenth Android
 *  may crop away. */
export function drawIconRgba(size, palette) {
  const { background, foreground, inset } = palette
  const rgba = new Uint8Array(size * size * 4)

  const put = (x, y, colour) => {
    const i = (y * size + x) * 4
    rgba[i] = colour[0]
    rgba[i + 1] = colour[1]
    rgba[i + 2] = colour[2]
    rgba[i + 3] = 255
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) put(x, y, background)
  }

  const safe = size * (1 - 2 * inset)
  const cx = (size - 1) / 2
  const cy = (size - 1) / 2
  const discR = safe * 0.16
  const arcs = [
    { r: safe * 0.28, w: safe * 0.055 },
    { r: safe * 0.42, w: safe * 0.055 },
  ]

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - cx
      const dy = y - cy
      const d = Math.sqrt(dx * dx + dy * dy)
      if (d <= discR) {
        put(x, y, foreground)
        continue
      }
      // Arcs open to the left, so the mark reads as a signal leaving the point.
      if (dx <= 0) continue
      for (const arc of arcs) {
        if (Math.abs(d - arc.r) <= arc.w / 2 && Math.abs(dy) <= dx * 1.2) {
          put(x, y, foreground)
          break
        }
      }
    }
  }

  return rgba
}

/** §8.2's three icons, at the three sizes the manifest declares. NOT exported —
 *  §16's census fixes this module at two exports, and the writer below is the
 *  only caller. §8.1's file map lists exactly three build tools, so the writer
 *  lives beside the encoder rather than becoming a fourth file. */
const ICONS = [
  { file: 'icon-192.png', size: 192, inset: 0 },
  { file: 'icon-512.png', size: 512, inset: 0 },
  { file: 'icon-maskable-512.png', size: 512, inset: 0.1 },
]

const PALETTE = { background: [0x0b, 0x0d, 0x10], foreground: [0x6c, 0xe6, 0xff] }

function writeIcons(outDir) {
  mkdirSync(outDir, { recursive: true })
  for (const icon of ICONS) {
    const rgba = drawIconRgba(icon.size, { ...PALETTE, inset: icon.inset })
    writeFileSync(`${outDir}/${icon.file}`, encodePng(icon.size, icon.size, rgba))
    console.log(`wrote ${outDir}/${icon.file} (${icon.size}x${icon.size})`)
  }
}

// Run directly: `node apps/web/tools/png.mjs`.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  writeIcons(fileURLToPath(new URL('../public/icons', import.meta.url)))
}
```

**3c.** Create `apps/web/public/manifest.webmanifest` — contract §8.2, verbatim:

```json
{
  "id": "/",
  "name": "Tapkart",
  "short_name": "Tapkart",
  "start_url": "/",
  "scope": "/",
  "display": "fullscreen",
  "display_override": ["fullscreen", "standalone"],
  "orientation": "landscape",
  "background_color": "#0B0D10",
  "theme_color": "#0B0D10",
  "categories": ["games"],
  "icons": [
    { "src": "/icons/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any" },
    { "src": "/icons/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any" },
    { "src": "/icons/icon-maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
  ]
}
```

`"orientation": "landscape"` is **not an independent decision** — Plan 3 §0's orientation row says so in those words, and the shell already shows a rotate-your-device overlay. `scope: "/"` covers `/r/ABCDE`, so a guest who installs after arriving by tap keeps the invite inside the app's scope; `start_url` is `/` because a saved invite code is stale the moment the room expires.

**3d.** Create `apps/web/tsconfig.sw.json` — contract §8.4, verbatim:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "lib": ["ES2022", "WebWorker"], "types": [] },
  "include": ["src/sw.ts", "src/pwa/policy.ts"]
}
```

and edit `apps/web/tsconfig.json` to §8.4's shape:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "types": ["vite/client", "node"]
  },
  "include": ["src/**/*.ts", "tools/**/*.ts", "vite.config.ts"],
  "exclude": ["src/sw.ts"]
}
```

**3e.** Create `apps/web/src/sw.ts`:

```ts
// ADAPTER. Contract §8.4. Compiled ONLY by tsconfig.sw.json, whose lib is
// ["ES2022", "WebWorker"] with "types": [] — `dom` and `webworker` cannot
// coexist in one TypeScript program.
//
// The pinned idiom, so two tasks do not invent two ways to type `self`. There is
// NO `/// <reference lib="webworker" />` anywhere in this repository.
const sw = self as unknown as ServiceWorkerGlobalScope

import { DEFAULT_SW_CONFIG, routeRequest, type SwConfig } from './pwa/policy'

/** Injected by tools/build-sw.mjs through Vite's `define` (§8.7). */
declare const __PRECACHE__: string[]
declare const __SW_VERSION__: string

const CONFIG: SwConfig = {
  ...DEFAULT_SW_CONFIG,
  cacheName: `tapkart-${__SW_VERSION__}`,
  precache: __PRECACHE__,
}

sw.addEventListener('install', (event) => {
  // NO skipWaiting (P5 Q25): the worker never activates over a running race.
  event.waitUntil(
    caches.open(CONFIG.cacheName).then((cache) => cache.addAll([...CONFIG.precache])),
  )
})

sw.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names
            .filter((name) => name.startsWith('tapkart-') && name !== CONFIG.cacheName)
            .map((name) => caches.delete(name)),
        ),
      )
      .then(() => sw.clients.claim()),
  )
})

async function fromCacheFirst(request: Request, cacheKey: string): Promise<Response> {
  const cache = await caches.open(cacheKey)
  const hit = await cache.match(request)
  if (hit !== undefined) return hit
  const fresh = await fetch(request)
  if (fresh.ok) await cache.put(request, fresh.clone())
  return fresh
}

async function fromNetworkFirst(request: Request, cacheKey: string): Promise<Response> {
  const cache = await caches.open(cacheKey)
  try {
    const fresh = await fetch(request)
    if (fresh.ok) await cache.put(request, fresh.clone())
    return fresh
  } catch (err) {
    const hit = await cache.match(request)
    if (hit !== undefined) return hit
    throw err
  }
}

async function fromShell(request: Request, cacheKey: string): Promise<Response> {
  try {
    return await fetch(request)
  } catch (err) {
    const cache = await caches.open(cacheKey)
    const shell = await cache.match(CONFIG.shellPath)
    if (shell !== undefined) return shell
    throw err
  }
}

sw.addEventListener('fetch', (event) => {
  const request = event.request
  const route = routeRequest(
    {
      method: request.method,
      url: request.url,
      sameOrigin: new URL(request.url).origin === sw.location.origin,
      isNavigate: request.mode === 'navigate',
    },
    CONFIG,
  )

  // No other branching lives in this file: every decision was made by
  // routeRequest, and this switch executes the one it returned (§0a).
  switch (route.action) {
    case 'passthrough':
      return
    case 'networkOnly':
      event.respondWith(fetch(request))
      return
    case 'cacheFirst':
      event.respondWith(fromCacheFirst(request, route.cacheKey))
      return
    case 'networkFirst':
      event.respondWith(fromNetworkFirst(request, route.cacheKey))
      return
    case 'shellFallback':
      event.respondWith(fromShell(request, route.cacheKey))
      return
  }
})

sw.addEventListener('message', (event) => {
  const data: unknown = event.data
  if (typeof data === 'object' && data !== null && (data as { type?: unknown }).type === 'SKIP_WAITING') {
    void sw.skipWaiting()
  }
})
```

**3f.** Create `apps/web/tools/build-sw.mjs`:

```js
// Runs after the main Vite build (§8.7): reads dist/.vite/manifest.json,
// computes the precache list and version, builds src/sw.ts into dist/sw.js
// unhashed at the scope root — a service worker's scope is its own path — and
// then asserts §12.2's 26 and 27 over what it produced.
//
// F-P5-26 makes offline a REQUIREMENT that gates the build, so these assertions
// live in the build rather than beside it: a Cache.addAll() with one missing
// entry rejects, and a rejected addAll discards the WHOLE precache. The install
// fails, the app has no offline story at all, and nothing says so.

import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build as viteBuild } from 'vite'
import { buildPrecacheList, precacheVersion } from './precache.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const DIST = join(ROOT, 'dist')

/** Everything the built app needs that is not in Vite's manifest. `/index.html`
 *  is the shell; the manifest and the icons are what make the app installable
 *  offline. '/' is deliberately absent: a navigation to it takes the
 *  shellFallback route, which serves `/index.html`, so precaching both would
 *  store the same bytes twice under two keys. */
const EXTRAS = [
  '/index.html',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
]

const manifestPath = join(DIST, '.vite', 'manifest.json')
if (!existsSync(manifestPath)) {
  throw new Error(
    `build-sw: ${manifestPath} does not exist. apps/web/vite.config.ts needs build.manifest = true, ` +
      'and `vite build` must run before this script.',
  )
}

const viteManifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const precache = buildPrecacheList(viteManifest, EXTRAS)
const version = precacheVersion(precache)

// F-P5-26's build-time half: every entry must exist, or install() rejects and
// there is no offline app.
const missing = precache.filter((p) => !existsSync(join(DIST, p)))
if (missing.length > 0) {
  throw new Error(
    'build-sw: these precache entries do not exist in dist/:\n' +
      missing.map((m) => `  ${m}`).join('\n') +
      '\nCache.addAll() rejects on the first missing entry and discards the entire precache, so the ' +
      'installed app would have no offline story at all — silently. Offline solo is a requirement ' +
      '(F-P5-26), so this is a build failure.',
  )
}

await viteBuild({
  configFile: false,
  root: ROOT,
  logLevel: 'warn',
  define: {
    __PRECACHE__: JSON.stringify(precache),
    __SW_VERSION__: JSON.stringify(version),
  },
  build: {
    emptyOutDir: false,
    manifest: false,
    copyPublicDir: false,
    outDir: 'dist',
    rollupOptions: {
      input: join(ROOT, 'src', 'sw.ts'),
      output: { entryFileNames: 'sw.js', format: 'iife', inlineDynamicImports: true },
    },
  },
})

/* ------------------------------ §12.2 assertion 27: dist/sw.js, unhashed ---- */

const swPath = join(DIST, 'sw.js')
if (!existsSync(swPath)) {
  throw new Error('build-sw: dist/sw.js was not emitted. A worker registered at /sw.js scopes the whole origin; a hashed name in a subdirectory does not.')
}

/* ---------- §12.2 assertion 26: the manifest, and every icon it declares ---- */

const webManifest = JSON.parse(readFileSync(join(DIST, 'manifest.webmanifest'), 'utf8'))
for (const field of ['name', 'start_url', 'scope', 'display', 'orientation', 'icons']) {
  if (webManifest[field] === undefined) {
    throw new Error(`build-sw: manifest.webmanifest has no '${field}'`)
  }
}
if (webManifest.orientation !== 'landscape') {
  throw new Error(
    `build-sw: manifest orientation is '${webManifest.orientation}', not 'landscape'. Plan 3 §0's ` +
      "orientation row makes this a consequence of the game being landscape only, not a choice.",
  )
}
if (!Array.isArray(webManifest.icons) || webManifest.icons.length === 0) {
  throw new Error('build-sw: manifest.webmanifest declares no icons')
}

/** Width and height straight out of the PNG's IHDR — the only place a PNG says
 *  how big it is. A manifest that declares 512x512 beside a 192-pixel file
 *  installs with a blurry icon and no error anywhere. */
function pngSize(path) {
  const bytes = readFileSync(path)
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  for (let i = 0; i < signature.length; i++) {
    if (bytes[i] !== signature[i]) throw new Error(`build-sw: ${path} is not a PNG`)
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

for (const icon of webManifest.icons) {
  const path = join(DIST, icon.src)
  if (!existsSync(path)) {
    throw new Error(`build-sw: manifest icon ${icon.src} does not exist in dist/`)
  }
  const { width, height } = pngSize(path)
  if (`${width}x${height}` !== icon.sizes) {
    throw new Error(`build-sw: ${icon.src} is ${width}x${height}, but the manifest declares ${icon.sizes}`)
  }
}

const bytes = statSync(swPath).size
console.log(`build-sw: dist/sw.js (${bytes} bytes), cache tapkart-${version}, ${precache.length} precached entries`)
```

**3g.** Edit `apps/web/vite.config.ts` — add `build.manifest`, keeping Plan 3's `server.fs.allow`:

```ts
  build: {
    // tools/build-sw.mjs reads dist/.vite/manifest.json to compute the precache
    // list. Without this the file does not exist and the build fails loudly.
    manifest: true,
  },
```

**3h.** Edit `apps/web/index.html` — inside `<head>`:

```html
    <link rel="manifest" href="/manifest.webmanifest" />
    <link rel="icon" href="/icons/icon-192.png" type="image/png" />
    <meta name="theme-color" content="#0B0D10" />
```

**3i.** Edit `apps/web/package.json` — the `build` and `typecheck` scripts:

```json
  "scripts": {
    "predev": "node tools/png.mjs",
    "dev": "vite",
    "build": "node tools/png.mjs && vite build && node tools/build-sw.mjs",
    "typecheck": "tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.sw.json"
  }
```

The icons are generated **before** `vite build`, because Vite copies `public/` into `dist/` as part of that build and an icon written afterwards would never reach `dist/`.

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run apps/web/test/precache.test.ts apps/web/test/png.test.ts
npm run typecheck -w @tapkart/web
npm run build -w @tapkart/web
npx vitest run
```

Expected: **12 passed** in `precache.test.ts` (7 + 5), **12 passed** in `png.test.ts` (6 + 6); **no typecheck output from either program**; a build ending in a line like `build-sw: dist/sw.js (… bytes), cache tapkart-…, 7 precached entries`; and the full suite green.

**The typecheck is the assertion that matters most in this task**, because §8.4 exists to stop `npm run typecheck` failing the moment `sw.ts` lands. Prove the split is doing the work rather than being decorative:

Run: `npx tsc --noEmit -p apps/web/tsconfig.json --listFiles | grep -c 'src/sw.ts'`
Expected: `0` — the app program does not see the worker.

Run: `npx tsc --noEmit -p apps/web/tsconfig.sw.json --listFiles | grep -c 'lib.dom.d.ts'`
Expected: `0` — the worker program does not see the DOM. If either prints a non-zero count, the `exclude`/`types` pair is wrong and the duplicate-identifier error is one edit away.

Then prove the offline gate is real, since a gate nobody has watched fail is a gate nobody knows works:

Run: `rm dist/icons/icon-512.png` (from `apps/web/`) then `node tools/build-sw.mjs`
Expected: the build **fails** with `these precache entries do not exist in dist/: /icons/icon-512.png`, and the paragraph about `addAll` rejecting. Re-run `npm run build -w @tapkart/web` to restore it.

Then confirm the build output is what a service worker needs:

Run: `ls apps/web/dist/sw.js && head -c 80 apps/web/dist/sw.js`
Expected: the file exists at the root of `dist/`, and its first bytes are an IIFE — no `import` and no `export`, so it registers as a classic worker and needs no `{ type: 'module' }` at the call site.

Run: `git status --porcelain apps/web/dist apps/web/public/icons`
Expected: **no output** — §1's `.gitignore` covers both, and neither a build output nor a generated PNG is ever committed.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/sw.ts apps/web/tsconfig.sw.json apps/web/tsconfig.json apps/web/public/manifest.webmanifest apps/web/tools apps/web/test/precache.test.ts apps/web/test/png.test.ts apps/web/package.json apps/web/vite.config.ts apps/web/index.html && git commit -m "feat(web): service worker, the two-program tsconfig split, icons, and the offline build gate (§8.4, §8.7, F-P5-26)"
```
