import { describe, it, expect } from 'vitest'
import { CHARACTERS, TRACK_MANIFEST } from '@tapkart/content'
import { IDENTITY_TILT_CALIBRATION } from '../src/controls/tilt'
import type { Settings } from '../src/settings'
import {
  DEFAULT_SETTINGS,
  PLAYER_NAME_MAX,
  SETTINGS_STORAGE_KEY,
  loadSettings,
  memoryStore,
  normalizePlayerName,
  saveSettings,
} from '../src/settings'
import { makeSettingsFixture } from './fixtures/game-fixtures'

// Compile-time exhaustive: adding a field to Settings without adding it here is a
// type error, so the per-field fallback test can never silently skip a new field.
const KEY_TABLE: Record<keyof Settings, true> = {
  scheme: true,
  tiltCalibration: true,
  invertTilt: true,
  audioEnabled: true,
  audioVolume: true,
  characterIdx: true,
  lastTrackId: true,
  playerName: true,
}
const KEYS = Object.keys(KEY_TABLE) as (keyof Settings)[]

/** Every field DIFFERENT from DEFAULT_SETTINGS. That is what makes the per-field
 *  fallback test able to tell "one field reset" from "the whole object reset". */
const CUSTOM: Settings = {
  scheme: 'tilt',
  tiltCalibration: { betaZero: 3, gammaZero: -4 },
  invertTilt: true,
  audioEnabled: false,
  audioVolume: 0.25,
  characterIdx: 5,
  lastTrackId: TRACK_MANIFEST[1].id,
  playerName: 'Rae',
}

describe('normalizePlayerName', () => {
  it('trims names, permits unset, and enforces character and UTF-8 wire caps', () => {
    expect(PLAYER_NAME_MAX).toBe(12)
    expect(normalizePlayerName('  Rae Vance  ')).toBe('Rae Vance')
    expect(normalizePlayerName('   ')).toBe('')
    expect(normalizePlayerName('abcdefghijkl')).toBe('abcdefghijkl')
    expect(normalizePlayerName('abcdefghijklm')).toBeNull()
    expect(normalizePlayerName('🏁🏁🏁🏁')).toBe('🏁🏁🏁🏁')
    expect(normalizePlayerName('🏁🏁🏁🏁🏁')).toBeNull()
  })
})

function storeWith(json: string): ReturnType<typeof memoryStore> {
  const store = memoryStore()
  store.set(SETTINGS_STORAGE_KEY, json)
  return store
}

describe('DEFAULT_SETTINGS', () => {
  it('is the contract §5.7 table, field by field', () => {
    expect(DEFAULT_SETTINGS.scheme).toBe('thumbZones')
    expect(DEFAULT_SETTINGS.tiltCalibration).toEqual(IDENTITY_TILT_CALIBRATION)
    expect(DEFAULT_SETTINGS.invertTilt).toBe(false)
    expect(DEFAULT_SETTINGS.audioEnabled).toBe(true)
    expect(DEFAULT_SETTINGS.audioVolume).toBe(0.7)
    expect(DEFAULT_SETTINGS.characterIdx).toBe(0)
    expect(DEFAULT_SETTINGS.playerName).toBe('')
    expect(SETTINGS_STORAGE_KEY).toBe('tapkart.settings.v1')
  })

  it('defaults lastTrackId to the first shipped track, not a hard-coded id', () => {
    // CATCHES a literal track id copied into settings.ts. The manifest is derived
    // from the shipped files; a renamed track would leave the default pointing at
    // a track loadTrack throws on, on first launch, for every new player.
    expect(DEFAULT_SETTINGS.lastTrackId).toBe(TRACK_MANIFEST[0].id)
    expect(TRACK_MANIFEST.some((t) => t.id === DEFAULT_SETTINGS.lastTrackId)).toBe(true)
  })
})

describe('memoryStore', () => {
  it('returns null for an unset key and round-trips what it is given', () => {
    const store = memoryStore()
    expect(store.get('nope')).toBeNull()
    store.set('k', 'v')
    expect(store.get('k')).toBe('v')
    store.set('k', 'w')
    expect(store.get('k')).toBe('w')
  })

  it('gives each store its own keyspace', () => {
    // CATCHES a module-level Map shared by every store, which makes one test's
    // settings leak into the next and is invisible until tests run in a new order.
    const a = memoryStore()
    const b = memoryStore()
    a.set('k', 'a')
    expect(b.get('k')).toBeNull()
  })
})

describe('loadSettings - whole-blob failures', () => {
  it('returns the defaults and never throws', () => {
    // [label, stored] tuples, NOT a bare list: it.each and any array-spreading
    // helper would swallow a row that is itself an array.
    const rows: [string, string][] = [
      ['not JSON at all', '{'],
      ['a JSON number', '42'],
      ['JSON null', 'null'],
      ['a JSON array', '[]'],
      ['a JSON string', '"thumbZones"'],
      ['an empty string', ''],
      ['a truncated object', '{"scheme":'],
    ]
    for (const [label, stored] of rows) {
      const got = loadSettings(storeWith(stored))
      expect(got, label).toEqual(DEFAULT_SETTINGS)
    }
  })

  it('returns the defaults when nothing has ever been saved', () => {
    expect(loadSettings(memoryStore())).toEqual(DEFAULT_SETTINGS)
  })

  it('returns a fresh object each time, sharing nothing with DEFAULT_SETTINGS', () => {
    // CATCHES `return DEFAULT_SETTINGS` and a shallow copy that keeps the shared
    // tiltCalibration object. The settings screen writes into what it is handed;
    // either bug rewrites the module constant for the life of the process, and
    // "reset to defaults" then restores the corrupted values.
    const first = loadSettings(memoryStore())
    first.audioVolume = 0.1
    first.tiltCalibration.betaZero = 99
    const second = loadSettings(memoryStore())
    expect(second.audioVolume).toBe(0.7)
    expect(second.tiltCalibration).toEqual({ betaZero: 0, gammaZero: 0 })
    expect(DEFAULT_SETTINGS.audioVolume).toBe(0.7)
    expect(DEFAULT_SETTINGS.tiltCalibration).toEqual({ betaZero: 0, gammaZero: 0 })
    expect(first.tiltCalibration).not.toBe(second.tiltCalibration)
  })
})

describe('loadSettings - PER-FIELD fallback', () => {
  it('falls back only the broken field and keeps the other seven', () => {
    // THE FLAGSHIP TEST for §5.7. Every field of CUSTOM differs from the default,
    // so a per-OBJECT fallback - the natural implementation, and the one that
    // silently wipes a player's whole configuration because one field is stale
    // after an upgrade - fails on the very first row.
    const rows: [string, keyof Settings, unknown][] = [
      ['scheme is not a known scheme', 'scheme', 'gamepad'],
      ['scheme is a number', 'scheme', 3],
      ['tiltCalibration is null', 'tiltCalibration', null],
      ['tiltCalibration is a number', 'tiltCalibration', 7],
      ['tiltCalibration has a NaN axis', 'tiltCalibration', { betaZero: Number.NaN, gammaZero: 0 }],
      ['tiltCalibration is missing an axis', 'tiltCalibration', { betaZero: 1 }],
      ['invertTilt is a string', 'invertTilt', 'yes'],
      ['audioEnabled is a number', 'audioEnabled', 1],
      ['audioVolume is above 1', 'audioVolume', 1.5],
      ['audioVolume is negative', 'audioVolume', -0.2],
      ['audioVolume is a string', 'audioVolume', 'loud'],
      ['characterIdx is fractional', 'characterIdx', 1.5],
      ['characterIdx is past the roster', 'characterIdx', CHARACTERS.length],
      ['characterIdx is negative', 'characterIdx', -1],
      ['lastTrackId is not a shipped track', 'lastTrackId', 'atlantis'],
      ['lastTrackId is a number', 'lastTrackId', 3],
      ['playerName is 13 characters', 'playerName', 'abcdefghijklm'],
      ['playerName is blank after trimming', 'playerName', '   '],
      ['playerName is a number', 'playerName', 12],
    ]

    for (const [label, key, bad] of rows) {
      const stored: Record<string, unknown> = { ...CUSTOM }
      stored[key] = bad
      const got = loadSettings(storeWith(JSON.stringify(stored)))
      expect(got[key], `${label}: broken field must fall back`).toEqual(DEFAULT_SETTINGS[key])
      for (const other of KEYS) {
        if (other === key) continue
        expect(got[other], `${label}: ${other} must survive`).toEqual(CUSTOM[other])
      }
    }
  })

  it('accepts every legal value it is handed, unchanged', () => {
    // CATCHES an over-strict validator - the failure mode the test above cannot
    // see, because a loader that rejected EVERYTHING would pass it. Round-tripping
    // CUSTOM proves the accept path for all eight fields at once.
    const store = memoryStore()
    saveSettings(store, CUSTOM)
    expect(loadSettings(store)).toEqual(CUSTOM)
  })

  it('accepts the boundary values on both ends', () => {
    const edge: Settings = makeSettingsFixture({
      audioVolume: 0,
      characterIdx: CHARACTERS.length - 1,
      lastTrackId: TRACK_MANIFEST[TRACK_MANIFEST.length - 1].id,
      playerName: 'abcdefghijkl', // exactly 12
    })
    const store = memoryStore()
    saveSettings(store, edge)
    expect(loadSettings(store)).toEqual(edge)

    const full = makeSettingsFixture({ audioVolume: 1 })
    saveSettings(store, full)
    expect(loadSettings(store).audioVolume).toBe(1)
  })

  it('trims a padded player name rather than rejecting it', () => {
    const store = storeWith(JSON.stringify({ ...CUSTOM, playerName: '  Rae Vance ' }))
    expect(loadSettings(store).playerName).toBe('Rae Vance')
  })

  it('ignores unknown stored fields', () => {
    // CATCHES a loader that copies the parsed object wholesale; a v2 field left by
    // a newer build would then reappear in a v1 Settings and travel into save().
    const store = storeWith(JSON.stringify({ ...CUSTOM, hyperdrive: true }))
    const got = loadSettings(store)
    expect(Object.keys(got).sort()).toEqual([...KEYS].sort())
  })
})

describe('saveSettings', () => {
  it('writes JSON under SETTINGS_STORAGE_KEY and under no other key', () => {
    const store = memoryStore()
    saveSettings(store, CUSTOM)
    const raw = store.get(SETTINGS_STORAGE_KEY)
    expect(raw).not.toBeNull()
    expect(JSON.parse(raw as string)).toEqual(CUSTOM)
    expect(store.get('tapkart.settings')).toBeNull()
  })

  it('serialises every field, so nothing is silently dropped', () => {
    // CATCHES a hand-written serialiser that forgets a field: the round-trip test
    // above would still pass if the missing field happened to equal its default.
    const store = memoryStore()
    saveSettings(store, CUSTOM)
    const parsed = JSON.parse(store.get(SETTINGS_STORAGE_KEY) as string) as Record<string, unknown>
    expect(Object.keys(parsed).sort()).toEqual([...KEYS].sort())
  })

  it('does not alias the settings it was handed', () => {
    const store = memoryStore()
    const s = makeSettingsFixture({ playerName: 'Rae' })
    saveSettings(store, s)
    s.playerName = 'Someone Else'
    expect(loadSettings(store).playerName).toBe('Rae')
  })
})
