// TEST-ONLY (contract §9.1). `src` never imports this file and never reads the
// filesystem: Q12 gives `src` its tracks through @tapkart/content's static imports.
// Tests read the REAL shipped tracks off disk (Q34), which is what makes every mesh
// assertion evidence about shipped content rather than about a synthetic oval.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { SimContext, Track } from '@tapkart/sim'
import { validateTrack } from '@tapkart/sim'
import type { CharacterDescriptor, KartDescriptor, TrackTheme } from '@tapkart/content'

// §2.6: sim's fixtures live outside @tapkart/sim's `exports` map, so tests reach them
// by relative path and `src` never does.
import { makeContext, makeOvalTrack } from '../../../sim/test/fixtures/track-fixtures'
import type { KartView, RaceView } from '../../src/types'
import { createRaceView } from '../../src/types'

/** <repo>/content/tracks, four levels up from packages/render/test/fixtures. */
const TRACKS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'content',
  'tracks',
)

/**
 * The six shipped tracks (spec §1) in `id`-ascending order. Hand-written on purpose:
 * every mesh suite is an `it.each(SHIPPED_TRACK_IDS)`, and a list derived from a
 * directory read would silently become empty — turning a whole suite green by running
 * nothing. `fixtures.test.ts` asserts this equals the directory contents instead.
 */
export const SHIPPED_TRACK_IDS: readonly string[] = [
  'caldera',
  'dust-canyon',
  'glacier-pass',
  'harbor-run',
  'neon-district',
  'redwood-rise',
]

/** Loads a real shipped track off disk with node:fs. Test-only; src never does.
 *  Throws on an unreadable file or a failing `validateTrack`, so no test ever
 *  measures a mesh built from a half-valid track. */
export function loadShippedTrack(id: string): Track {
  const raw = readFileSync(join(TRACKS_DIR, `${id}.json`), 'utf8')
  const track = JSON.parse(raw) as Track
  const errs = validateTrack(track)
  if (errs.length > 0) throw new Error(`${id}.json is not a valid Track: ${errs.join('; ')}`)
  return track
}

/** A SimContext over sim's oval fixture: base tuning, the eight fixture characters,
 *  and a freshly built TrackQuery.
 *
 *  This deliberately uses sim's `makeContext`, NOT @tapkart/content's shipped constants:
 *  `CHARACTERS` is `readonly CharacterStats[]` and does not assign to
 *  `SimContext.characters: CharacterStats[]` under `strict` — a composition root has to
 *  write `CHARACTERS.slice()`, and a test fixture has no reason to pay that. `TUNING:
 *  Readonly<Tuning>` assigns fine; the array is the case that bites. */
export function makeRenderContext(): SimContext {
  return makeContext(makeOvalTrack())
}

export function makeKartView(overrides?: Partial<KartView>): KartView {
  const base: KartView = {
    playerId: 0,
    characterIdx: 0,
    source: 'authoritative',
    position: { x: 0, y: 0, z: 0 },
    heading: 0,
    velocity: { x: 0, y: 0, z: 0 },
    angularVelocity: 0,
    speed: 0,
    s: 0,
    bankAngle: 0,
    driftActive: false,
    driftDir: 0,
    driftCharge: 0,
    driftTier: -1,
    airborne: false,
    surface: 'tarmac',
    spinOutTicks: 0,
    invulnTicks: 0,
    boostTicks: 0,
    respawnTicks: 0,
    shielded: false,
    item: 'none',
    lap: 0,
    checkpointIdx: 0,
    t: 0,
    place: 0,
    isBot: false,
    connected: true,
  }
  return { ...base, ...overrides }
}

/** A filled, legal HOST view: eight authoritative seats, racing, six item boxes
 *  (sim's oval fixture has six). */
export function makeRaceView(overrides?: Partial<RaceView>): RaceView {
  const view = createRaceView(6)
  view.phase = 'racing'
  view.localPlayerId = 0
  for (let i = 0; i < view.karts.length; i++) {
    view.karts[i].source = 'authoritative'
    view.karts[i].characterIdx = i
    view.karts[i].place = i
    view.karts[i].connected = true
  }
  view.itemBoxRespawnTicks = 180
  return Object.assign(view, overrides)
}

/** A theme whose road, roadDirt and shoulder colours are all different, so a mesh
 *  tint assertion can tell them apart. `sunDirection` is exactly unit length. */
export function makeThemeFixture(): TrackTheme {
  return {
    trackId: 'oval',
    road: [0.18, 0.18, 0.2],
    roadDirt: [0.35, 0.26, 0.18],
    shoulder: [0.24, 0.34, 0.16],
    wall: [0.4, 0.4, 0.45],
    ground: [0.2, 0.3, 0.15],
    sky: { top: [0.2, 0.4, 0.8], bottom: [0.7, 0.8, 0.9] },
    fog: { color: [0.7, 0.75, 0.8], near: 60, far: 600 },
    sunDirection: { x: 0.6, y: 0.8, z: 0 }, // |v| === 1 exactly
    ambient: 0.35,
    edgeMarkers: {
      spacing: 12,
      height: 1,
      offset: 1.5,
      colors: [
        [0.95, 0.95, 0.95],
        [0.85, 0.1, 0.1],
      ],
    },
  }
}

export function makeCharacterDescriptorFixture(): CharacterDescriptor {
  return {
    id: 'test-racer',
    name: 'Test Racer',
    bodyHeight: 1,
    bodyRadius: 0.3,
    headRadius: 0.22,
    palette: {
      primary: [0.9, 0.2, 0.2],
      secondary: [0.95, 0.8, 0.6],
      accent: [0.1, 0.1, 0.15],
    },
    silhouette: 'compact',
  }
}

export function makeKartDescriptorFixture(): KartDescriptor {
  return {
    id: 'test-kart',
    name: 'Test Kart',
    chassisLength: 1.8,
    chassisWidth: 1.2,
    chassisHeight: 0.5,
    wheelRadius: 0.3,
    wheelWidth: 0.2,
    palette: {
      body: [0.2, 0.4, 0.9],
      trim: [0.95, 0.95, 0.2],
      wheel: [0.08, 0.08, 0.09],
    },
  }
}
