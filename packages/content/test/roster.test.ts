import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import type { CharacterDescriptor, KartDescriptor, PaletteRGB } from '../src/descriptors'
import { parseCharacterDescriptor, parseKartDescriptor } from '../src/descriptors'
import type { TrackTheme } from '../src/theme'
import { parseTrackTheme } from '../src/theme'

/** Q34's test-only reach: the roster is judged as it ships, off disk. */
const CONTENT = fileURLToPath(new URL('../../../content/', import.meta.url))

function readJson(rel: string): unknown {
  return JSON.parse(readFileSync(CONTENT + rel, 'utf8')) as unknown
}

function stems(dir: string): string[] {
  return readdirSync(CONTENT + dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -5))
    .sort()
}

/** CHARACTERS[i].weight, contract §3a.2 — the balance this content must look like. */
const WEIGHTS = [1.0, 1.2, 0.85, 1.1, 0.9, 1.3, 0.8, 1.0]
const LETTERS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
const TRACK_IDS = [
  'caldera',
  'dust-canyon',
  'glacier-pass',
  'harbor-run',
  'neon-district',
  'redwood-rise',
]

function silhouetteFor(weight: number): 'compact' | 'tall' | 'wide' {
  if (weight >= 1.1) return 'wide'
  if (weight <= 0.9) return 'compact'
  return 'tall'
}

/**
 * Distance between two linear colours in a perceptual-ish space (component-wise sqrt).
 * Linear values crush dark colours together — two very different asphalt greys are
 * 0.02 apart in linear light — so a plain linear distance would call any two dark
 * palettes identical and any two bright ones different. The sqrt is a stand-in for the
 * display transfer function, which is what the player's eye actually sees.
 */
function visualDistance(a: PaletteRGB, b: PaletteRGB): number {
  const d0 = Math.sqrt(a[0]) - Math.sqrt(b[0])
  const d1 = Math.sqrt(a[1]) - Math.sqrt(b[1])
  const d2 = Math.sqrt(a[2]) - Math.sqrt(b[2])
  return Math.hypot(d0, d1, d2)
}

/** The same thresholds `gate-descriptors.mjs` applies before a record is accepted. */
const MIN_MARKER_PAIR = 0.25
const MIN_MARKER_SURFACE = 0.2
const MIN_ROAD_GROUND = 0.1
const MIN_KART_SEPARATION = 0.15
const MIN_THEME_SEPARATION = 0.1

function slugOf(name: string): string {
  return name
    .toLowerCase()
    .replace(/['’.]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

const characters: CharacterDescriptor[] = []
const karts: KartDescriptor[] = []
const themes: TrackTheme[] = []
for (let i = 0; i < 8; i++) {
  characters.push(parseCharacterDescriptor(readJson(`characters/character-${i}.json`)))
  karts.push(parseKartDescriptor(readJson(`karts/kart-${i}.json`)))
}
for (const id of TRACK_IDS) {
  themes.push(parseTrackTheme(readJson(`themes/${id}.json`)))
}

describe('shipped roster files', () => {
  it('ships exactly 8 characters, 8 karts and 6 themes, and no stray file', () => {
    // Catches a `.ds` sidecar, a `character-8.json`, or a half-moved regeneration
    // landing in shipped content.
    expect(stems('characters')).toEqual([
      'character-0',
      'character-1',
      'character-2',
      'character-3',
      'character-4',
      'character-5',
      'character-6',
      'character-7',
    ])
    expect(stems('karts')).toEqual([
      'kart-0',
      'kart-1',
      'kart-2',
      'kart-3',
      'kart-4',
      'kart-5',
      'kart-6',
      'kart-7',
    ])
    expect(stems('themes')).toEqual([...TRACK_IDS].sort())
  })

  it('parses every record through the real parser', () => {
    // The module-scope loads above already threw if not; these pin the counts so a
    // silently-empty loop cannot pass.
    expect(characters).toHaveLength(8)
    expect(karts).toHaveLength(8)
    expect(themes).toHaveLength(6)
  })
})

describe('roster ordering', () => {
  it('gives slot i the letter i, so id-ascending order IS slot order', () => {
    // The bug: contract §3a.6 orders the bundle by id ascending while the STATS are per
    // index. If the two orders disagree, the heavyweight is drawn with the
    // featherweight's body and races with the featherweight's handling, and nothing in
    // the type system notices.
    for (let i = 0; i < 8; i++) {
      expect(characters[i].id.startsWith(LETTERS[i])).toBe(true)
      expect(karts[i].id.startsWith(LETTERS[i])).toBe(true)
    }
    const characterIds = characters.map((c) => c.id)
    const kartIds = karts.map((k) => k.id)
    expect(characterIds).toEqual([...characterIds].sort())
    expect(kartIds).toEqual([...kartIds].sort())
  })

  it('has unique ids and names, which no per-record parser can check', () => {
    const characterIds = characters.map((c) => c.id)
    const kartIds = karts.map((k) => k.id)
    expect(new Set(characterIds).size).toBe(8)
    expect(new Set(kartIds).size).toBe(8)
    expect(new Set(characters.map((c) => c.name)).size).toBe(8)
    expect(new Set(karts.map((k) => k.name)).size).toBe(8)
  })

  it('derives every id from its own displayed name', () => {
    for (const record of [...characters, ...karts]) {
      expect(slugOf(record.name)).toBe(record.id)
      expect(record.name.length).toBeGreaterThanOrEqual(3)
      expect(record.name.length).toBeLessThanOrEqual(18)
      expect(record.name[0]).toBe(record.name[0].toUpperCase())
    }
  })
})

describe('appearance agrees with the handling each slot is fixed to', () => {
  it('gives each character the silhouette its weight implies', () => {
    // Q2 hands the model the stats as INPUT so the field is readable: a player must be
    // able to see that the heavy kart is heavy. A silhouette chosen freely makes the
    // eight racers a lucky dip.
    for (let i = 0; i < 8; i++) {
      expect(characters[i].silhouette).toBe(silhouetteFor(WEIGHTS[i]))
    }
  })

  it('backs the silhouette up with the proportions', () => {
    for (let i = 0; i < 8; i++) {
      const c = characters[i]
      if (c.silhouette === 'wide') expect(c.bodyRadius).toBeGreaterThanOrEqual(0.38)
      if (c.silhouette === 'tall') expect(c.bodyHeight).toBeGreaterThanOrEqual(1.0)
      if (c.silhouette === 'compact') expect(c.bodyHeight).toBeLessThanOrEqual(0.95)
    }
  })

  it('sizes each kart to its paired racer', () => {
    for (let i = 0; i < 8; i++) {
      const k = karts[i]
      if (WEIGHTS[i] >= 1.1) {
        expect(k.chassisWidth).toBeGreaterThanOrEqual(1.35)
        expect(k.chassisLength).toBeGreaterThanOrEqual(2.1)
      }
      if (WEIGHTS[i] <= 0.9) {
        expect(k.chassisWidth).toBeLessThanOrEqual(1.15)
        expect(k.chassisLength).toBeLessThanOrEqual(1.9)
      }
    }
  })

  it('makes the eight kart bodies tellable apart', () => {
    // Eight karts in one pack on a phone screen. If two share a body colour the player
    // cannot find themselves, which is a gameplay failure, not a taste one.
    for (let i = 0; i < 8; i++) {
      for (let j = i + 1; j < 8; j++) {
        const d = visualDistance(karts[i].palette.body, karts[j].palette.body)
        expect(d, `karts ${i} and ${j} share a body colour`).toBeGreaterThanOrEqual(
          MIN_KART_SEPARATION,
        )
      }
    }
  })
})

describe('themes', () => {
  it('themes exactly the six shipped tracks, each by its own id', () => {
    expect(themes.map((t) => t.trackId)).toEqual(TRACK_IDS)
  })

  it('keeps Q20 edge markers legible — the speed and corner cue', () => {
    // Q20: markers are gameplay. Two markers a player cannot tell apart give no cadence,
    // and markers that vanish into the road or the ground give nothing at all.
    for (const theme of themes) {
      const [a, b] = theme.edgeMarkers.colors
      expect(visualDistance(a, b), `${theme.trackId}: marker colours are too alike`).toBeGreaterThanOrEqual(
        MIN_MARKER_PAIR,
      )
      for (const c of [a, b]) {
        expect(visualDistance(c, theme.road), `${theme.trackId}: marker vs road`).toBeGreaterThanOrEqual(
          MIN_MARKER_SURFACE,
        )
        expect(visualDistance(c, theme.ground), `${theme.trackId}: marker vs ground`).toBeGreaterThanOrEqual(
          MIN_MARKER_SURFACE,
        )
      }
      expect(theme.edgeMarkers.spacing).toBeGreaterThanOrEqual(4)
      expect(theme.edgeMarkers.spacing).toBeLessThanOrEqual(40)
    }
  })

  it('keeps the road distinguishable from what is beside it', () => {
    for (const theme of themes) {
      expect(
        visualDistance(theme.road, theme.ground),
        `${theme.trackId}: road and ground are the same colour`,
      ).toBeGreaterThanOrEqual(MIN_ROAD_GROUND)
    }
  })

  it('gives the six tracks six different looks', () => {
    // The failure mode of a batch that ignored its per-record briefs is six palettes
    // that are the same palette. Compared over road + ground + sky.top together.
    for (let i = 0; i < themes.length; i++) {
      for (let j = i + 1; j < themes.length; j++) {
        const d = Math.hypot(
          visualDistance(themes[i].road, themes[j].road),
          visualDistance(themes[i].ground, themes[j].ground),
          visualDistance(themes[i].sky.top, themes[j].sky.top),
        )
        expect(
          d,
          `${themes[i].trackId} and ${themes[j].trackId} look the same`,
        ).toBeGreaterThanOrEqual(MIN_THEME_SEPARATION)
      }
    }
  })
})
