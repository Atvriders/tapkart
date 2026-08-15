// PURE (contract §0a). Track loading: synchronous and total (§3a.5, Q12).
//
// §3a.1: six explicit static JSON imports — no bundler glob, no fetch, no Vite-only
// feature, and no `import` + `.meta` anywhere in this file (bundle.test.ts asserts the
// source text), because `packages/server` (Plan 4) imports this package under plain
// Node. Adding a seventh track means one import line here and nothing else; the test
// that compares TRACK_MANIFEST against the real directory catches a forgotten one.
import { buildTrackQuery, validateTrack } from '@tapkart/sim'
import type { Surface, Track, TrackPoint, TrackQuery, Vec3 } from '@tapkart/sim'

import { loadContentBundle } from './bundle'
import { DEFAULT_TRACK_THEME } from './theme'
import type { TrackTheme } from './theme'

import calderaJson from '../../../content/tracks/caldera.json' with { type: 'json' }
import dustCanyonJson from '../../../content/tracks/dust-canyon.json' with { type: 'json' }
import glacierPassJson from '../../../content/tracks/glacier-pass.json' with { type: 'json' }
import harborRunJson from '../../../content/tracks/harbor-run.json' with { type: 'json' }
import neonDistrictJson from '../../../content/tracks/neon-district.json' with { type: 'json' }
import redwoodRiseJson from '../../../content/tracks/redwood-rise.json' with { type: 'json' }

export interface TrackManifestEntry {
  id: string
  name: string
}

export interface LoadedTrack {
  track: Track
  query: TrackQuery
  theme: TrackTheme
}

/** The static view of an imported track module is deliberately narrow: `id` and `name`
 *  are all the manifest needs, and every other key reaches `parseTrack`, which takes
 *  `unknown` and validates. Nothing here trusts the JSON's inferred type. */
interface TrackJsonModule {
  id: string
  name: string
}

/** The six shipped tracks (spec §1) in MENU ORDER, which is `id` ascending. */
const TRACK_JSON: readonly TrackJsonModule[] = [
  calderaJson,
  dustCanyonJson,
  glacierPassJson,
  harborRunJson,
  neonDistrictJson,
  redwoodRiseJson,
]

/** The six shipped tracks (spec §1) in MENU ORDER, which is `id` ascending:
 *  caldera, dust-canyon, glacier-pass, harbor-run, neon-district, redwood-rise.
 *  Derived from the imported modules' own `id` and `name`, never hand-written, so
 *  it cannot drift from what actually shipped. */
export const TRACK_MANIFEST: readonly TrackManifestEntry[] = TRACK_JSON.map((m) => ({
  id: m.id,
  name: m.name,
}))

const SURFACES: readonly Surface[] = ['tarmac', 'dirt', 'boost', 'offtrack']

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Renders a rejected value for the error message. Never throws, never recurses. */
function show(v: unknown): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return `an array of ${v.length}`
  const t = typeof v
  if (t === 'number' || t === 'boolean') return String(v)
  if (t === 'string') return JSON.stringify(v)
  if (t === 'object') return 'an object'
  return t
}

function strField(o: Record<string, unknown>, key: string, path: string, errs: string[]): string {
  const v = o[key]
  if (typeof v !== 'string' || v.length === 0) {
    errs.push(`${path}: must be a non-empty string, got ${show(v)}`)
    return ''
  }
  return v
}

/** Finite check only. Every RANGE is `validateTrack`'s, and there is no second copy. */
function numField(o: Record<string, unknown>, key: string, path: string, errs: string[]): number {
  const v = o[key]
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    errs.push(`${path}: must be a finite number, got ${show(v)}`)
    return 0
  }
  return v
}

function vec3Field(v: unknown, path: string, errs: string[]): Vec3 {
  if (!isRecord(v)) {
    errs.push(`${path}: must be an object with x, y and z, got ${show(v)}`)
    return { x: 0, y: 0, z: 0 }
  }
  return {
    x: numField(v, 'x', `${path}.x`, errs),
    y: numField(v, 'y', `${path}.y`, errs),
    z: numField(v, 'z', `${path}.z`, errs),
  }
}

function surfaceField(v: unknown, path: string, errs: string[]): Surface {
  if (typeof v === 'string') {
    for (const s of SURFACES) {
      if (s === v) return s
    }
  }
  errs.push(`${path}: must be one of ${SURFACES.join(', ')}, got ${show(v)}`)
  return 'tarmac'
}

function arrayField(v: unknown, path: string, errs: string[]): unknown[] {
  if (!Array.isArray(v)) {
    errs.push(`${path}: must be an array, got ${show(v)}`)
    return []
  }
  return v
}

function recordAt(v: unknown, path: string, errs: string[]): Record<string, unknown> | null {
  if (!isRecord(v)) {
    errs.push(`${path}: must be an object, got ${show(v)}`)
    return null
  }
  return v
}

function controlPoints(v: unknown, errs: string[]): TrackPoint[] {
  const raw = arrayField(v, 'controlPoints', errs)
  const out: TrackPoint[] = []
  for (let i = 0; i < raw.length; i++) {
    const cp = recordAt(raw[i], `controlPoints[${i}]`, errs)
    if (cp === null) continue
    out.push({
      position: vec3Field(cp['position'], `controlPoints[${i}].position`, errs),
      width: numField(cp, 'width', `controlPoints[${i}].width`, errs),
      banking: numField(cp, 'banking', `controlPoints[${i}].banking`, errs),
      surface: surfaceField(cp['surface'], `controlPoints[${i}].surface`, errs),
    })
  }
  return out
}

function numberArray(v: unknown, path: string, errs: string[]): number[] {
  if (!Array.isArray(v)) {
    errs.push(`${path}: must be an array of numbers, got ${show(v)}`)
    return []
  }
  const out: number[] = []
  for (let i = 0; i < v.length; i++) {
    const n: unknown = v[i]
    if (typeof n !== 'number' || !Number.isFinite(n)) {
      errs.push(`${path}[${i}]: must be a finite number, got ${show(n)}`)
      continue
    }
    out.push(n)
  }
  return out
}

function sLateralArray(v: unknown, path: string, errs: string[]): { s: number; lateral: number }[] {
  const raw = arrayField(v, path, errs)
  const out: { s: number; lateral: number }[] = []
  for (let i = 0; i < raw.length; i++) {
    const o = recordAt(raw[i], `${path}[${i}]`, errs)
    if (o === null) continue
    out.push({
      s: numField(o, 's', `${path}[${i}].s`, errs),
      lateral: numField(o, 'lateral', `${path}[${i}].lateral`, errs),
    })
  }
  return out
}

function rampArray(v: unknown, errs: string[]): { sStart: number; sEnd: number; launch: number }[] {
  const raw = arrayField(v, 'ramps', errs)
  const out: { sStart: number; sEnd: number; launch: number }[] = []
  for (let i = 0; i < raw.length; i++) {
    const o = recordAt(raw[i], `ramps[${i}]`, errs)
    if (o === null) continue
    out.push({
      sStart: numField(o, 'sStart', `ramps[${i}].sStart`, errs),
      sEnd: numField(o, 'sEnd', `ramps[${i}].sEnd`, errs),
      launch: numField(o, 'launch', `ramps[${i}].launch`, errs),
    })
  }
  return out
}

function padArray(v: unknown, errs: string[]): { s: number; lateral: number; halfWidth: number }[] {
  const raw = arrayField(v, 'boostPads', errs)
  const out: { s: number; lateral: number; halfWidth: number }[] = []
  for (let i = 0; i < raw.length; i++) {
    const o = recordAt(raw[i], `boostPads[${i}]`, errs)
    if (o === null) continue
    out.push({
      s: numField(o, 's', `boostPads[${i}].s`, errs),
      lateral: numField(o, 'lateral', `boostPads[${i}].lateral`, errs),
      halfWidth: numField(o, 'halfWidth', `boostPads[${i}].halfWidth`, errs),
    })
  }
  return out
}

function boundsField(v: unknown, errs: string[]): { min: Vec3; max: Vec3 } {
  if (!isRecord(v)) {
    errs.push(`bounds: must be an object with min and max, got ${show(v)}`)
    return { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } }
  }
  return {
    min: vec3Field(v['min'], 'bounds.min', errs),
    max: vec3Field(v['max'], 'bounds.max', errs),
  }
}

/** Shape-checks, then runs validateTrack. Throws with every validator message
 *  joined by '; ', never returns a half-valid Track. */
export function parseTrack(json: unknown): Track {
  if (!isRecord(json)) {
    throw new Error(`parseTrack: must be an object, got ${show(json)}`)
  }

  const errs: string[] = []
  const track: Track = {
    id: strField(json, 'id', 'id', errs),
    name: strField(json, 'name', 'name', errs),
    controlPoints: controlPoints(json['controlPoints'], errs),
    checkpointS: numberArray(json['checkpointS'], 'checkpointS', errs),
    itemBoxes: sLateralArray(json['itemBoxes'], 'itemBoxes', errs),
    ramps: rampArray(json['ramps'], errs),
    boostPads: padArray(json['boostPads'], errs),
    startPositions: sLateralArray(json['startPositions'], 'startPositions', errs),
    bounds: boundsField(json['bounds'], errs),
  }

  if (errs.length > 0) {
    throw new Error(`parseTrack: ${errs.join('; ')}`)
  }

  // Every range and every rule is sim's, called here rather than restated.
  const invalid = validateTrack(track)
  if (invalid.length > 0) {
    throw new Error(`parseTrack: ${track.id}: ${invalid.join('; ')}`)
  }

  return track
}

/** Immutable shipped content keyed by id — not per-race state. */
const CACHE = new Map<string, LoadedTrack>()

/** TOTAL over TRACK_MANIFEST ids. Builds the TrackQuery (arc table) and resolves
 *  the theme (DEFAULT_TRACK_THEME when unthemed). Throws only on an unknown id,
 *  which is a programming error, not a runtime condition. Memoises, so the arc
 *  table is built once per track per process. */
export function loadTrack(id: string): LoadedTrack {
  const hit = CACHE.get(id)
  if (hit !== undefined) return hit

  let index = -1
  for (let i = 0; i < TRACK_JSON.length; i++) {
    if (TRACK_JSON[i].id === id) {
      index = i
      break
    }
  }
  if (index < 0) {
    const known = TRACK_MANIFEST.map((e) => e.id).join(', ')
    throw new Error(`loadTrack: unknown track id '${id}'; the shipped tracks are ${known}`)
  }

  const track = parseTrack(TRACK_JSON[index])
  const themes = loadContentBundle().themes
  // Keyed by the id the TRACK FILE declares (`track.id`, re-derived by parseTrack from
  // the same JSON that `index` was matched on), never by the filename the import line
  // happens to name: bundle.ts pins theme keys to each theme's own parsed `trackId`,
  // and the two sides therefore agree on one string with no filename in the middle.
  const theme = Object.prototype.hasOwnProperty.call(themes, track.id)
    ? themes[track.id]
    : DEFAULT_TRACK_THEME
  const loaded: LoadedTrack = { track, query: buildTrackQuery(track), theme }
  CACHE.set(id, loaded)
  return loaded
}
