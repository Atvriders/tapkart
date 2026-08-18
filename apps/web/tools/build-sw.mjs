// Builds the classic, root-scoped worker after Vite emits the app manifest and
// enforces the installable/offline artifact gates over the real dist tree.

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build as viteBuild } from 'vite'
import { buildPrecacheList, precacheVersion } from './precache.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const DIST = join(ROOT, 'dist')
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

const missing = precache.filter((path) => !existsSync(join(DIST, path)))
if (missing.length > 0) {
  throw new Error(
    'build-sw: these precache entries do not exist in dist/:\n' +
      missing.map((path) => `  ${path}`).join('\n') +
      '\nCache.addAll() rejects on the first missing entry and discards the entire precache, so the ' +
      'installed app would have no offline story at all — silently. Offline solo is a requirement ' +
      '(F-P5-26), so this is a build failure.',
  )
}

// Keep digests private: the worker fetches the unchanged path list. The digest
// seeds only the cache name so bytes at stable URLs (index, manifest, icons)
// cannot remain under an old cache version.
const versionSeeds = precache.map((path) => {
  const digest = createHash('sha256').update(readFileSync(join(DIST, path))).digest('hex')
  return `${path}\0${digest}`
})
const version = precacheVersion(versionSeeds)

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

const swPath = join(DIST, 'sw.js')
if (!existsSync(swPath)) {
  throw new Error(
    'build-sw: dist/sw.js was not emitted. A worker registered at /sw.js scopes the whole origin; ' +
      'a hashed name in a subdirectory does not.',
  )
}

const webManifest = JSON.parse(readFileSync(join(DIST, 'manifest.webmanifest'), 'utf8'))
for (const field of ['name', 'start_url', 'scope', 'display', 'orientation', 'icons']) {
  if (webManifest[field] === undefined) {
    throw new Error(`build-sw: manifest.webmanifest has no '${field}'`)
  }
}
if (webManifest.orientation !== 'landscape') {
  throw new Error(
    `build-sw: manifest orientation is '${webManifest.orientation}', not 'landscape'. Plan 3's ` +
      'orientation contract makes this a consequence of the game being landscape only.',
  )
}
if (!Array.isArray(webManifest.icons) || webManifest.icons.length === 0) {
  throw new Error('build-sw: manifest.webmanifest declares no icons')
}

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
    throw new Error(
      `build-sw: ${icon.src} is ${width}x${height}, but the manifest declares ${icon.sizes}`,
    )
  }
}

const bytes = statSync(swPath).size
console.log(
  `build-sw: dist/sw.js (${bytes} bytes), cache tapkart-${version}, ${precache.length} precached entries`,
)
