// PURE (contract §0a). Per-track palettes (§3a.4, Q3) and Q20's edge-marker
// parameters: the schema, the parser, and the neutral fallback theme.
//
// No DOM, no `three`, no clock, no bundler feature. `packages/server` (Plan 4)
// imports this package under plain Node, which is why nothing here may depend on
// Vite and why the only `@tapkart/sim` import is a type.
//
// This module owns no track data. The six shipped theme records live in
// `content/themes/*.json` and are parsed by `src/bundle.ts` through the parser
// below, so a malformed shipped theme throws at startup rather than rendering.
import type { Vec3 } from '@tapkart/sim'

import type { PaletteRGB } from './descriptors'

/** Q20: the edge markers are gameplay, not decoration — they are the speed and
 *  corner cue a bare ribbon on a flat plane does not give. Parameters live on
 *  the theme so they are content, not code. */
export interface EdgeMarkerParams {
  spacing: number // metres along the centreline between posts, 4 – 40
  height: number // metres, 0.3 – 2.0
  offset: number // metres outboard of width/2, 0 – 3
  colors: readonly [PaletteRGB, PaletteRGB] // alternating, colorIdx 0 and 1
}

export interface TrackTheme {
  trackId: string // equals the Track.id it themes
  road: PaletteRGB
  roadDirt: PaletteRGB
  shoulder: PaletteRGB
  wall: PaletteRGB
  ground: PaletteRGB
  sky: { top: PaletteRGB; bottom: PaletteRGB }
  fog: { color: PaletteRGB; near: number; far: number } // metres; near < far
  sunDirection: Vec3 // normalised; parse throws if |v| is not 1 ± 1e-6
  ambient: number // 0..1
  edgeMarkers: EdgeMarkerParams
}

/** How far |sunDirection| may sit from 1. Six-decimal content survives this by
 *  nine orders of magnitude; a hand-written direction that was never normalised
 *  does not. */
const SUN_TOLERANCE = 1e-6

/** A neutral grey theme with legible edge markers: what a track with no theme
 *  file falls back to.
 *
 *  `sunDirection` is (0.36, 0.80, 0.48) — exactly unit, because 36² + 80² + 48²
 *  = 100². Every direction in this package is chosen that way, so no rounding
 *  ever pushes one outside SUN_TOLERANCE. The markers are white/red at 12 m: the
 *  spacing a driver reads as speed at 40 m/s, and the one colour pair that stays
 *  legible against grey road and grey ground. */
export const DEFAULT_TRACK_THEME: Readonly<TrackTheme> = {
  trackId: 'default',
  road: [0.18, 0.18, 0.19],
  roadDirt: [0.26, 0.22, 0.17],
  shoulder: [0.12, 0.13, 0.12],
  wall: [0.3, 0.3, 0.32],
  ground: [0.14, 0.16, 0.14],
  sky: { top: [0.1, 0.14, 0.22], bottom: [0.55, 0.6, 0.66] },
  fog: { color: [0.55, 0.58, 0.62], near: 120, far: 900 },
  sunDirection: { x: 0.36, y: 0.8, z: 0.48 },
  ambient: 0.35,
  edgeMarkers: {
    spacing: 12,
    height: 0.9,
    offset: 0.6,
    colors: [
      [0.85, 0.85, 0.86],
      [0.75, 0.12, 0.12],
    ],
  },
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Rejects unknown keys, at the top level and inside every nested object — the same
 *  rule `parseCharacterDescriptor` and `parseKartDescriptor` apply (Task 3). A theme
 *  is generated content; a key the parser silently ignores is a field the author
 *  believed was doing something. */
function checkKeys(
  o: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  errs: string[],
): void {
  for (const key of Object.keys(o)) {
    if (!allowed.includes(key)) {
      errs.push(`${path}: unknown key '${key}'`)
    }
  }
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

function numField(
  o: Record<string, unknown>,
  key: string,
  path: string,
  lo: number,
  hi: number,
  errs: string[],
): number {
  const v = o[key]
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    errs.push(`${path}: must be a finite number, got ${show(v)}`)
    return 0
  }
  if (v < lo || v > hi) {
    const range = Number.isFinite(hi) ? `within ${lo}..${hi}` : `at least ${lo}`
    errs.push(`${path}: must be ${range}, got ${v}`)
    return 0
  }
  return v
}

function palette(v: unknown, path: string, errs: string[]): PaletteRGB {
  if (!Array.isArray(v) || v.length !== 3) {
    errs.push(`${path}: must be an array of 3 numbers, got ${show(v)}`)
    return [0, 0, 0]
  }
  const out: [number, number, number] = [0, 0, 0]
  for (let i = 0; i < 3; i++) {
    const c: unknown = v[i]
    if (typeof c !== 'number' || !Number.isFinite(c)) {
      errs.push(`${path}[${i}]: must be a finite number, got ${show(c)}`)
      continue
    }
    if (c < 0 || c > 1) {
      errs.push(`${path}[${i}]: must be within 0..1, got ${c}`)
      continue
    }
    out[i] = c
  }
  return out
}

function unitVec(v: unknown, path: string, errs: string[]): Vec3 {
  if (!isRecord(v)) {
    errs.push(`${path}: must be an object with x, y and z, got ${show(v)}`)
    return { x: 0, y: 1, z: 0 }
  }
  checkKeys(v, ['x', 'y', 'z'], path, errs)
  const before = errs.length
  // No per-component range: |v| = 1 already bounds every component to [-1, 1], and a
  // component range of exactly ±1 would reject the legal (0, 1.0000005, 0) that sits
  // inside SUN_TOLERANCE.
  const lo = Number.NEGATIVE_INFINITY
  const hi = Number.POSITIVE_INFINITY
  const x = numField(v, 'x', `${path}.x`, lo, hi, errs)
  const y = numField(v, 'y', `${path}.y`, lo, hi, errs)
  const z = numField(v, 'z', `${path}.z`, lo, hi, errs)
  if (errs.length !== before) return { x: 0, y: 1, z: 0 }
  const len = Math.hypot(x, y, z)
  if (Math.abs(len - 1) > SUN_TOLERANCE) {
    errs.push(`${path}: must be a unit vector, |v| = ${len}`)
    return { x: 0, y: 1, z: 0 }
  }
  return { x, y, z }
}

/** Throws with a field-listing message on any shape violation. */
export function parseTrackTheme(json: unknown): TrackTheme {
  if (!isRecord(json)) {
    throw new Error(`parseTrackTheme: must be an object, got ${show(json)}`)
  }

  const errs: string[] = []
  checkKeys(
    json,
    [
      'trackId',
      'road',
      'roadDirt',
      'shoulder',
      'wall',
      'ground',
      'sky',
      'fog',
      'sunDirection',
      'ambient',
      'edgeMarkers',
    ],
    'theme',
    errs,
  )

  let trackId = ''
  const rawId: unknown = json['trackId']
  if (typeof rawId !== 'string' || rawId.length === 0) {
    errs.push(`trackId: must be a non-empty string, got ${show(rawId)}`)
  } else {
    trackId = rawId
  }

  const road = palette(json['road'], 'road', errs)
  const roadDirt = palette(json['roadDirt'], 'roadDirt', errs)
  const shoulder = palette(json['shoulder'], 'shoulder', errs)
  const wall = palette(json['wall'], 'wall', errs)
  const ground = palette(json['ground'], 'ground', errs)

  let skyTop: PaletteRGB = [0, 0, 0]
  let skyBottom: PaletteRGB = [0, 0, 0]
  const rawSky: unknown = json['sky']
  if (!isRecord(rawSky)) {
    errs.push(`sky: must be an object with top and bottom, got ${show(rawSky)}`)
  } else {
    checkKeys(rawSky, ['top', 'bottom'], 'sky', errs)
    skyTop = palette(rawSky['top'], 'sky.top', errs)
    skyBottom = palette(rawSky['bottom'], 'sky.bottom', errs)
  }

  let fogColor: PaletteRGB = [0, 0, 0]
  let fogNear = 0
  let fogFar = 1
  const rawFog: unknown = json['fog']
  if (!isRecord(rawFog)) {
    errs.push(`fog: must be an object with color, near and far, got ${show(rawFog)}`)
  } else {
    checkKeys(rawFog, ['color', 'near', 'far'], 'fog', errs)
    fogColor = palette(rawFog['color'], 'fog.color', errs)
    const before = errs.length
    fogNear = numField(rawFog, 'near', 'fog.near', 0, Number.POSITIVE_INFINITY, errs)
    fogFar = numField(rawFog, 'far', 'fog.far', 0, Number.POSITIVE_INFINITY, errs)
    if (errs.length === before && !(fogNear < fogFar)) {
      errs.push(`fog: near ${fogNear} must be less than far ${fogFar}`)
    }
  }

  const sunDirection = unitVec(json['sunDirection'], 'sunDirection', errs)
  const ambient = numField(json, 'ambient', 'ambient', 0, 1, errs)

  let spacing = 0
  let height = 0
  let offset = 0
  let markerA: PaletteRGB = [0, 0, 0]
  let markerB: PaletteRGB = [0, 0, 0]
  const rawMarkers: unknown = json['edgeMarkers']
  if (!isRecord(rawMarkers)) {
    errs.push(`edgeMarkers: must be an object, got ${show(rawMarkers)}`)
  } else {
    checkKeys(rawMarkers, ['spacing', 'height', 'offset', 'colors'], 'edgeMarkers', errs)
    spacing = numField(rawMarkers, 'spacing', 'edgeMarkers.spacing', 4, 40, errs)
    height = numField(rawMarkers, 'height', 'edgeMarkers.height', 0.3, 2, errs)
    offset = numField(rawMarkers, 'offset', 'edgeMarkers.offset', 0, 3, errs)
    const rawColors: unknown = rawMarkers['colors']
    if (!Array.isArray(rawColors) || rawColors.length !== 2) {
      errs.push(`edgeMarkers.colors: must be an array of 2 palettes, got ${show(rawColors)}`)
    } else {
      markerA = palette(rawColors[0], 'edgeMarkers.colors[0]', errs)
      markerB = palette(rawColors[1], 'edgeMarkers.colors[1]', errs)
    }
  }

  if (errs.length > 0) {
    throw new Error(`parseTrackTheme: ${errs.join('; ')}`)
  }

  return {
    trackId,
    road,
    roadDirt,
    shoulder,
    wall,
    ground,
    sky: { top: skyTop, bottom: skyBottom },
    fog: { color: fogColor, near: fogNear, far: fogFar },
    sunDirection: { x: sunDirection.x, y: sunDirection.y, z: sunDirection.z },
    ambient,
    edgeMarkers: { spacing, height, offset, colors: [markerA, markerB] },
  }
}
