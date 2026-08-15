import { CHARACTERS, TRACK_MANIFEST } from '@tapkart/content'
import type { ControlScheme } from './controls/types'
import type { TiltCalibration } from './controls/tilt'
import { IDENTITY_TILT_CALIBRATION } from './controls/tilt'

export interface Settings {
  scheme: ControlScheme
  tiltCalibration: TiltCalibration
  invertTilt: boolean
  audioEnabled: boolean
  audioVolume: number // 0..1
  characterIdx: number // 0..7
  lastTrackId: string // a TRACK_MANIFEST id
  playerName: string // 1..12 chars after trimming; '' means "unset"
}

export const DEFAULT_SETTINGS: Readonly<Settings> = {
  scheme: 'thumbZones',
  tiltCalibration: { ...IDENTITY_TILT_CALIBRATION },
  invertTilt: false,
  audioEnabled: true,
  audioVolume: 0.7,
  characterIdx: 0,
  // Derived from the shipped manifest, never a literal: TRACK_MANIFEST is built
  // from the track files' own ids, so this default cannot point at a track that
  // does not ship.
  lastTrackId: TRACK_MANIFEST[0].id,
  playerName: '',
}

export const SETTINGS_STORAGE_KEY = 'tapkart.settings.v1'

/** Injected so tests never touch browser storage - and so this module stays inside
 *  the headless half of §8.2's seam. The browser-backed store is built by the
 *  shell, which is the file allowed to name browser APIs. (This comment names none
 *  of them on purpose: dom-seam.test.ts reads this file as text.) */
export interface KeyValueStore {
  get(key: string): string | null
  set(key: string, value: string): void
}

export function memoryStore(): KeyValueStore {
  const map = new Map<string, string>()
  return {
    get(key: string): string | null {
      const v = map.get(key)
      return v === undefined ? null : v
    },
    set(key: string, value: string): void {
      map.set(key, value)
    },
  }
}

const PLAYER_NAME_MAX = 12

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

function freshDefaults(): Settings {
  // A new object every call, with a new tiltCalibration: the settings screen
  // writes into whatever loadSettings returns, and DEFAULT_SETTINGS must survive
  // that untouched for the life of the process.
  return { ...DEFAULT_SETTINGS, tiltCalibration: { ...DEFAULT_SETTINGS.tiltCalibration } }
}

/**
 * NEVER throws. Malformed JSON, a missing key, a wrong type or an out-of-range
 * value falls back PER FIELD to DEFAULT_SETTINGS - not per object, so one bad
 * field does not discard the other seven. That difference is the whole point: a
 * field this build does not understand should cost the player that setting, not
 * their character, their track and their name.
 */
export function loadSettings(store: KeyValueStore): Settings {
  const out = freshDefaults()

  const raw = store.get(SETTINGS_STORAGE_KEY)
  if (raw === null) return out

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return out
  }
  if (!isPlainObject(parsed)) return out

  const scheme = parsed.scheme
  if (scheme === 'thumbZones' || scheme === 'tilt' || scheme === 'virtualStick') {
    out.scheme = scheme
  }

  const cal = parsed.tiltCalibration
  if (isPlainObject(cal) && isFiniteNumber(cal.betaZero) && isFiniteNumber(cal.gammaZero)) {
    out.tiltCalibration = { betaZero: cal.betaZero, gammaZero: cal.gammaZero }
  }

  if (typeof parsed.invertTilt === 'boolean') out.invertTilt = parsed.invertTilt
  if (typeof parsed.audioEnabled === 'boolean') out.audioEnabled = parsed.audioEnabled

  const vol = parsed.audioVolume
  if (isFiniteNumber(vol) && vol >= 0 && vol <= 1) out.audioVolume = vol

  const idx = parsed.characterIdx
  if (isFiniteNumber(idx) && Number.isInteger(idx) && idx >= 0 && idx < CHARACTERS.length) {
    out.characterIdx = idx
  }

  const trackId = parsed.lastTrackId
  if (typeof trackId === 'string' && TRACK_MANIFEST.some((t) => t.id === trackId)) {
    out.lastTrackId = trackId
  }

  const name = parsed.playerName
  if (typeof name === 'string') {
    const trimmed = name.trim()
    if (trimmed.length >= 1 && trimmed.length <= PLAYER_NAME_MAX) out.playerName = trimmed
  }

  return out
}

/**
 * SOLE WRITER of the persisted settings (§7.2). Writes a fresh, field-complete
 * object rather than `s` itself, so an extra property riding on the caller's
 * object never reaches storage.
 */
export function saveSettings(store: KeyValueStore, s: Settings): void {
  const payload: Settings = {
    scheme: s.scheme,
    tiltCalibration: { betaZero: s.tiltCalibration.betaZero, gammaZero: s.tiltCalibration.gammaZero },
    invertTilt: s.invertTilt,
    audioEnabled: s.audioEnabled,
    audioVolume: s.audioVolume,
    characterIdx: s.characterIdx,
    lastTrackId: s.lastTrackId,
    playerName: s.playerName,
  }
  store.set(SETTINGS_STORAGE_KEY, JSON.stringify(payload))
}
