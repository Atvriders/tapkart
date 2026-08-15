import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import * as content from '../src/index'
import {
  CHARACTERS,
  DEFAULT_TRACK_THEME,
  TRACK_MANIFEST,
  TUNING,
  loadContentBundle,
  loadTrack,
  parseCharacterDescriptor,
  parseKartDescriptor,
  parseTrack,
  parseTrackTheme,
} from '../src/index'

import * as bundleNs from '../src/bundle'
import * as descriptorsNs from '../src/descriptors'
import * as themeNs from '../src/theme'
import * as tracksNs from '../src/tracks'
import * as tuningNs from '../src/tuning'

import { loadTrack as loadTrackDirect } from '../src/tracks'

const SRC = fileURLToPath(new URL('../src/', import.meta.url))

/** The five modules the barrel must re-export, in contract §3a.7's order. */
const BARREL_MODULES = ['tuning', 'descriptors', 'theme', 'tracks', 'bundle']

const NAMESPACES: [string, object][] = [
  ['tuning', tuningNs],
  ['descriptors', descriptorsNs],
  ['theme', themeNs],
  ['tracks', tracksNs],
  ['bundle', bundleNs],
]

describe('@tapkart/content barrel', () => {
  it('carries every runtime export through', () => {
    const values: [string, unknown][] = [
      ['tuning.TUNING', TUNING],
      ['tuning.CHARACTERS', CHARACTERS],
      ['descriptors.parseCharacterDescriptor', parseCharacterDescriptor],
      ['descriptors.parseKartDescriptor', parseKartDescriptor],
      ['theme.DEFAULT_TRACK_THEME', DEFAULT_TRACK_THEME],
      ['theme.parseTrackTheme', parseTrackTheme],
      ['tracks.TRACK_MANIFEST', TRACK_MANIFEST],
      ['tracks.parseTrack', parseTrack],
      ['tracks.loadTrack', loadTrack],
      ['bundle.loadContentBundle', loadContentBundle],
    ]
    // 10 runtime values; the other 8 of contract §11's 18 content symbols are types,
    // which erase.
    expect(values).toHaveLength(10)
    for (const [name, value] of values) {
      expect(value, `${name} did not come through the barrel`).toBeDefined()
    }
  })

  it('exports those ten and nothing else, which IS contract §11\'s runtime census', () => {
    // The list above proves each named symbol arrives; it cannot notice a new one. This
    // is the other direction, and it is also what stops the loops below from passing on
    // a namespace that has quietly emptied: a module whose exports vanish makes every
    // `for (const key of Object.keys(ns))` vacuous, and this fails instead.
    expect(Object.keys(content).sort()).toEqual([
      'CHARACTERS',
      'DEFAULT_TRACK_THEME',
      'TRACK_MANIFEST',
      'TUNING',
      'loadContentBundle',
      'loadTrack',
      'parseCharacterDescriptor',
      'parseKartDescriptor',
      'parseTrack',
      'parseTrackTheme',
    ])
  })

  it('re-exports each module\'s own binding, not a copy', () => {
    expect(loadTrack).toBe(loadTrackDirect)
  })

  it('lists every module in src/ exactly once', () => {
    const onDisk = readdirSync(SRC)
      .filter((f) => f.endsWith('.ts') && f !== 'index.ts')
      .map((f) => f.slice(0, -3))
      .sort()
    expect(onDisk).toEqual([...BARREL_MODULES].sort())

    const barrel = readFileSync(join(SRC, 'index.ts'), 'utf8')
    for (const name of BARREL_MODULES) {
      const line = `export * from './${name}'`
      expect(barrel, `barrel is missing ${line}`).toContain(line)
      expect(barrel.split(line).length - 1, `${line} appears more than once`).toBe(1)
    }
  })

  it('has no ambiguous re-export', () => {
    // An ambiguous name is silently dropped from an ESM namespace and becomes a
    // SyntaxError at the import site, so it must not exist in the first place. Three
    // modules here define a private `isRecord` and a private `show`; if one of them is
    // ever exported by accident, this is what says so.
    const owners = new Map<string, string[]>()
    for (const [mod, ns] of NAMESPACES) {
      for (const key of Object.keys(ns)) {
        const list = owners.get(key) ?? []
        list.push(mod)
        owners.set(key, list)
      }
    }
    const clashes = Array.from(owners.entries()).filter(([, mods]) => mods.length > 1)
    expect(clashes).toEqual([])

    for (const [mod, ns] of NAMESPACES) {
      for (const key of Object.keys(ns)) {
        expect(
          Object.prototype.hasOwnProperty.call(content, key),
          `${mod}.${key} is not forwarded by the barrel`,
        ).toBe(true)
      }
    }
  })

  it('keeps the parse helpers private', () => {
    for (const helper of ['isRecord', 'show', 'numField', 'palette', 'surfaceField']) {
      expect(Object.prototype.hasOwnProperty.call(content, helper)).toBe(false)
    }
  })
})
