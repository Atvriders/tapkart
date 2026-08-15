import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'

import { parseTrackTheme } from '../src/theme'
import { loadContentBundle } from '../src/bundle'

const SRC = fileURLToPath(new URL('../src/', import.meta.url))
const THEMES_DIR = fileURLToPath(new URL('../../../content/themes/', import.meta.url))

function countJsonImports(file: string): number {
  const text = readFileSync(SRC + file, 'utf8')
  return text.split("with { type: 'json' }").length - 1
}

function themeFilesOnDisk(): string[] {
  return readdirSync(THEMES_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
}

function readThemeFile(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(THEMES_DIR, file), 'utf8')) as Record<string, unknown>
}

describe('loadContentBundle', () => {
  it('loads 8 characters, 8 karts and 6 themes', () => {
    const bundle = loadContentBundle()
    expect(bundle.characters).toHaveLength(8)
    expect(bundle.karts).toHaveLength(8)
    expect(Object.keys(bundle.themes)).toHaveLength(6)
  })

  it('memoises, so the 22 records are parsed once per process', () => {
    // Not a micro-optimisation: every screen calls this, and a non-memoised version
    // re-parses 22 records per call while handing out a different object identity each
    // time, which quietly breaks any `===` a caller does on a descriptor.
    expect(loadContentBundle()).toBe(loadContentBundle())
    expect(loadContentBundle().characters).toBe(loadContentBundle().characters)
  })

  it('orders characters and karts by id ascending, which IS the index order', () => {
    // Contract §3a.6: the arrays are ordered by `id` ascending, and index — not id — is
    // the join to CharacterStats (§3a.3). If a record lands in the wrong slot, the array
    // stops being sorted, and this is the assertion that says so. Without it, character
    // 5 races with character 2's handling and nothing in the suite notices.
    const bundle = loadContentBundle()
    const characterIds = bundle.characters.map((c) => c.id)
    const kartIds = bundle.karts.map((k) => k.id)

    expect(characterIds).toEqual([...characterIds].sort())
    expect(kartIds).toEqual([...kartIds].sort())
    expect(new Set(characterIds).size).toBe(8)
    expect(new Set(kartIds).size).toBe(8)
    for (const id of [...characterIds, ...kartIds]) {
      expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
    }
  })

  it('keys themes by their own trackId', () => {
    const bundle = loadContentBundle()
    for (const [key, theme] of Object.entries(bundle.themes)) {
      expect(theme.trackId).toBe(key)
    }
  })

  it('maps each theme file to the id the FILE DECLARES, not to the filename it happens to have', () => {
    // The assertion above is tautological on its own — `themes[theme.trackId] = theme`
    // makes key === trackId whatever the loader keyed on — so it cannot distinguish a
    // parsed-id lookup from a filename lookup. This one asserts the MAPPING: for every
    // file on disk, the bundle entry reachable under the trackId that file declares must
    // hold that file's contents. A loader keyed by filename stem satisfies this only
    // while every stem happens to equal its own trackId, which is exactly the coincidence
    // the guard below (and the shipped-content assertion here) exists to police.
    const files = themeFilesOnDisk()
    // An empty readdir would make every loop in this test vacuous and still green.
    expect(files).toHaveLength(6)

    const bundle = loadContentBundle()
    const declared: string[] = []
    for (const file of files) {
      const raw = readThemeFile(file)
      const trackId = raw['trackId']
      expect(typeof trackId, `${file} declares no trackId`).toBe('string')
      declared.push(trackId as string)

      const keyed = bundle.themes[trackId as string]
      expect(keyed, `no bundle entry under ${file}'s own trackId '${String(trackId)}'`).toBeDefined()
      expect(keyed).toEqual(parseTrackTheme(raw))

      // Shipped-content invariant, asserted rather than assumed: rename a theme file
      // without editing its trackId (or vice versa) and this fails here, at build time,
      // instead of surfacing as glacier-pass rendering caldera's palette.
      expect(file.slice(0, -5), `content/themes/${file} is not named after its trackId`).toBe(
        trackId,
      )
    }
    expect(Object.keys(bundle.themes).sort()).toEqual([...declared].sort())
  })

  it('refuses to load a theme whose parsed trackId disagrees with its filename', async () => {
    // The discriminating case for the two tests above: the shipped six agree, so the
    // disagreement has to be manufactured. Mock the parser so caldera.json parses as
    // trackId 'volcano' and the file's name and its declared id genuinely differ.
    //
    // A loader without this guard is silent here: keyed by trackId it produces a bundle
    // with no 'caldera' entry at all (loadTrack falls back to the grey theme), and keyed
    // by filename it produces a 'caldera' entry holding a theme that says it is
    // 'volcano'. Both ship. This one throws and names the file.
    vi.resetModules()
    vi.doMock('../src/theme', async () => {
      const actual = await vi.importActual<typeof import('../src/theme')>('../src/theme')
      return {
        ...actual,
        parseTrackTheme: (json: unknown) => {
          const theme = actual.parseTrackTheme(json)
          return theme.trackId === 'caldera' ? { ...theme, trackId: 'volcano' } : theme
        },
      }
    })
    try {
      const mocked = await import('../src/bundle')
      let thrown: Error | null = null
      try {
        mocked.loadContentBundle()
      } catch (e) {
        thrown = e as Error
      }
      expect(thrown, 'a misfiled theme loaded silently').not.toBeNull()
      const message = thrown?.message ?? ''
      expect(message).toContain('content/themes/caldera.json')
      expect(message).toContain('volcano')
    } finally {
      vi.doUnmock('../src/theme')
      vi.resetModules()
    }
  })

  it('returns descriptors with exactly the schema keys and nothing else', () => {
    // Proves the records came out of the parsers rather than being cast through: a cast
    // would carry any stray key in the JSON file straight into the game.
    const bundle = loadContentBundle()
    expect(Object.keys(bundle.characters[0]).sort()).toEqual([
      'bodyHeight',
      'bodyRadius',
      'headRadius',
      'id',
      'name',
      'palette',
      'silhouette',
    ])
    expect(Object.keys(bundle.karts[0]).sort()).toEqual([
      'chassisHeight',
      'chassisLength',
      'chassisWidth',
      'id',
      'name',
      'palette',
      'wheelRadius',
      'wheelWidth',
    ])
  })

  it('reaches its JSON by static import — 22 here, 6 in tracks.ts, 28 in total', () => {
    // Contract §3a.1. `import.meta.glob` is a Vite transform and `packages/server`
    // (Plan 4) imports this package under plain Node, where it is not a function and
    // fails at runtime rather than at build. This test is what stops a later "tidy-up"
    // from collapsing 28 import lines back into one glob.
    expect(countJsonImports('bundle.ts')).toBe(22)
    expect(countJsonImports('tracks.ts')).toBe(6)
    expect(readFileSync(SRC + 'bundle.ts', 'utf8')).not.toContain('import.meta')
    expect(readFileSync(SRC + 'tracks.ts', 'utf8')).not.toContain('import.meta')
  })
})
