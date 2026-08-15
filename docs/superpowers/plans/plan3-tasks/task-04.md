### Task 4: `packages/content/src/theme.ts` — track themes and edge-marker parameters

Contract §3a.4. This task ships the **schema, the parser and the neutral fallback theme**
— and nothing else. The six shipped theme records (`content/themes/*.json`) are generated
by **Task 6** and parsed by **Task 5**'s `bundle.ts`; this module owns no track data.

**Why edge markers exist at all (ruling Q20).** They are not decoration. v1's visual budget
is a ribbon over a themed ground plane, and a bare ribbon on a flat plane gives the player
**no speed cue and no corner read** — that is a gameplay defect, not an aesthetic one.
Posts marching past at a known spacing are what make speed legible, and their curve ahead
is what makes the next corner legible. Q20's resolution is that `render` generates the
posts procedurally from the spline it already has (§4.3's `buildEdgeMarkers`), and their
*parameters* — spacing, height, outboard offset, and the two alternating colours — live on
the theme, so they are **content that a per-track record tunes**, not constants baked into
code. Everything this task does to `EdgeMarkerParams` follows from that: the ranges are
gameplay ranges (a 60 m spacing reads as no markers at all; a 0.1 m post is invisible), and
the parser enforces them so a bad record fails at startup instead of shipping an illegible
track.

**Files:**
- Create: `packages/content/src/theme.ts`
- Test: `packages/content/test/theme.test.ts`

**Interfaces:**

- Consumes (from `@tapkart/sim`, contract §2.1 — type-only, so `verbatimModuleSyntax`
  erases the import and nothing in `sim` is loaded at runtime):
  - `type Vec3 = { x: number; y: number; z: number }`
- Consumes (from **Task 3**, `packages/content/src/descriptors.ts`, contract §3a.3 —
  type-only):
  - `type PaletteRGB = readonly [number, number, number]` — linear, each component `0..1`
- Produces (`packages/content/src/theme.ts`) — exactly four exports, which is what
  contract §11's census allocates to `content/theme`:
  - `interface EdgeMarkerParams { spacing: number; height: number; offset: number; colors: readonly [PaletteRGB, PaletteRGB] }`
  - `interface TrackTheme { trackId: string; road: PaletteRGB; roadDirt: PaletteRGB; shoulder: PaletteRGB; wall: PaletteRGB; ground: PaletteRGB; sky: { top: PaletteRGB; bottom: PaletteRGB }; fog: { color: PaletteRGB; near: number; far: number }; sunDirection: Vec3; ambient: number; edgeMarkers: EdgeMarkerParams }`
  - `const DEFAULT_TRACK_THEME: Readonly<TrackTheme>`
  - `function parseTrackTheme(json: unknown): TrackTheme`

**Ordering.** Task 3 lands `descriptors.ts` first: the `PaletteRGB` import above is
type-only, so vitest would run without it, but `npx tsc --noEmit -p packages/content` would
not. Task 6 consumes `parseTrackTheme` from *this* file to gate its generated records, and
Task 5's `bundle.ts` consumes it to parse them at load; neither exists yet, and this task
does not wait on either.

**Do not add a shared `parseutil.ts`.** `descriptors.ts` (Task 3), this file, and
`tracks.ts` (Task 5) each carry their own module-private `isRecord` / `show` / range
helpers. Contract §11 fixes the content package at five modules and the header's locked
contract says a thing two tasks both need is *an amendment, not a local definition*. Three
copies of a six-line type guard is the cheaper mistake.

**Ranges are the contract's, transcribed.** `spacing` 4–40 m, `height` 0.3–2.0 m, `offset`
0–3 m, `ambient` 0..1, every palette component 0..1, `fog.near < fog.far`, and
`sunDirection` a unit vector to `1e-6`. Do not widen one because a generated record missed
it — Task 6 regenerates the record.

---

- [ ] **Step 1: Write the failing test**

Create `packages/content/test/theme.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { DEFAULT_TRACK_THEME, parseTrackTheme } from '../src/theme'

/**
 * A raw record as it arrives from JSON: every leaf is `unknown`, because that is
 * exactly what `parseTrackTheme` is handed and exactly what the rejection cases
 * below need to be able to replace with the wrong shape.
 */
interface RawTheme {
  trackId?: unknown
  road?: unknown
  roadDirt?: unknown
  shoulder?: unknown
  wall?: unknown
  ground?: unknown
  sky?: unknown
  fog?: unknown
  sunDirection?: unknown
  ambient?: unknown
  edgeMarkers?: unknown
}

/** A valid record, plus per-case overrides. Fresh object every call. */
function rawTheme(over: RawTheme = {}): RawTheme {
  return {
    trackId: 'caldera',
    road: [0.16, 0.15, 0.15],
    roadDirt: [0.32, 0.2, 0.13],
    shoulder: [0.22, 0.14, 0.11],
    wall: [0.28, 0.24, 0.23],
    ground: [0.19, 0.11, 0.09],
    sky: { top: [0.14, 0.09, 0.12], bottom: [0.62, 0.28, 0.14] },
    fog: { color: [0.42, 0.22, 0.16], near: 90, far: 620 },
    sunDirection: { x: 0.36, y: 0.8, z: 0.48 },
    ambient: 0.38,
    edgeMarkers: {
      spacing: 14,
      height: 0.9,
      offset: 0.7,
      colors: [
        [0.9, 0.88, 0.84],
        [0.72, 0.14, 0.1],
      ],
    },
    ...over,
  }
}

/** Euclidean distance in linear RGB — used only to state Q20's legibility claim. */
function colorDistance(a: readonly number[], b: readonly number[]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
}

describe('parseTrackTheme', () => {
  it('accepts a valid record and returns every field verbatim', () => {
    const theme = parseTrackTheme(rawTheme())

    expect(theme.trackId).toBe('caldera')
    expect(theme.road).toEqual([0.16, 0.15, 0.15])
    expect(theme.roadDirt).toEqual([0.32, 0.2, 0.13])
    expect(theme.shoulder).toEqual([0.22, 0.14, 0.11])
    expect(theme.wall).toEqual([0.28, 0.24, 0.23])
    expect(theme.ground).toEqual([0.19, 0.11, 0.09])
    expect(theme.sky.top).toEqual([0.14, 0.09, 0.12])
    expect(theme.sky.bottom).toEqual([0.62, 0.28, 0.14])
    expect(theme.fog.color).toEqual([0.42, 0.22, 0.16])
    expect(theme.fog.near).toBe(90)
    expect(theme.fog.far).toBe(620)
    expect(theme.sunDirection).toEqual({ x: 0.36, y: 0.8, z: 0.48 })
    expect(theme.ambient).toBe(0.38)
    expect(theme.edgeMarkers.spacing).toBe(14)
    expect(theme.edgeMarkers.height).toBe(0.9)
    expect(theme.edgeMarkers.offset).toBe(0.7)
    expect(theme.edgeMarkers.colors).toEqual([
      [0.9, 0.88, 0.84],
      [0.72, 0.14, 0.1],
    ])
  })

  it('accepts the boundary values of every range', () => {
    const theme = parseTrackTheme(
      rawTheme({
        road: [0, 0, 0],
        wall: [1, 1, 1],
        ambient: 0,
        fog: { color: [0, 0, 0], near: 0, far: 1e-9 },
        edgeMarkers: {
          spacing: 4,
          height: 0.3,
          offset: 0,
          colors: [
            [0, 0, 0],
            [1, 1, 1],
          ],
        },
      }),
    )
    expect(theme.edgeMarkers.spacing).toBe(4)
    expect(theme.edgeMarkers.height).toBe(0.3)
    expect(theme.edgeMarkers.offset).toBe(0)
    expect(theme.ambient).toBe(0)

    const upper = parseTrackTheme(
      rawTheme({
        ambient: 1,
        edgeMarkers: {
          spacing: 40,
          height: 2,
          offset: 3,
          colors: [
            [1, 1, 1],
            [0, 0, 0],
          ],
        },
      }),
    )
    expect(upper.edgeMarkers.spacing).toBe(40)
    expect(upper.edgeMarkers.height).toBe(2)
    expect(upper.edgeMarkers.offset).toBe(3)
    expect(upper.ambient).toBe(1)
  })

  it('returns a copy, so a later mutation of the JSON cannot reach shipped content', () => {
    const raw = rawTheme()
    const theme = parseTrackTheme(raw)

    expect(theme).not.toBe(raw)
    ;(raw.road as number[])[0] = 0.99
    ;(raw.sky as { top: number[] }).top[0] = 0.99
    ;(raw.edgeMarkers as { spacing: number }).spacing = 99
    ;(raw.sunDirection as { x: number }).x = 99

    expect(theme.road[0]).toBe(0.16)
    expect(theme.sky.top[0]).toBe(0.14)
    expect(theme.edgeMarkers.spacing).toBe(14)
    expect(theme.sunDirection.x).toBe(0.36)
  })

  it('accepts a unit sunDirection that is not axis-aligned, and one within tolerance', () => {
    expect(parseTrackTheme(rawTheme({ sunDirection: { x: 0.6, y: 0.64, z: 0.48 } })).sunDirection).toEqual({
      x: 0.6,
      y: 0.64,
      z: 0.48,
    })
    // |v| = 1 + 5e-7, inside the 1e-6 tolerance.
    const near = parseTrackTheme(rawTheme({ sunDirection: { x: 0, y: 1.0000005, z: 0 } }))
    expect(near.sunDirection.y).toBe(1.0000005)
  })
})

describe('DEFAULT_TRACK_THEME', () => {
  it('satisfies its own schema', () => {
    // Q20: the fallback has to be legible, not merely present. If the default ever
    // violates the schema it claims to exemplify, every unthemed track renders from a
    // record the parser would reject.
    const reparsed = parseTrackTheme(structuredClone(DEFAULT_TRACK_THEME))
    expect(reparsed).toEqual(DEFAULT_TRACK_THEME)
  })

  it('has edge markers that read as alternating and stand off the road', () => {
    const m = DEFAULT_TRACK_THEME.edgeMarkers
    expect(colorDistance(m.colors[0], m.colors[1])).toBeGreaterThanOrEqual(0.25)
    expect(colorDistance(m.colors[0], DEFAULT_TRACK_THEME.road)).toBeGreaterThanOrEqual(0.15)
    expect(colorDistance(m.colors[1], DEFAULT_TRACK_THEME.road)).toBeGreaterThanOrEqual(0.15)
  })

  it('is a neutral grey theme, not a copy of some track', () => {
    expect(DEFAULT_TRACK_THEME.trackId).toBe('default')
  })
})

/**
 * One case per field the parser must check. The bug this table exists to catch is a
 * parser that simply casts its argument — or that validates eight fields and forgets
 * the ninth: such a parser accepts every case below without throwing, and every case
 * below fails. `toThrow(string)` is a substring match on the message, so each case
 * also pins that the message NAMES the offending field, which is what makes a
 * startup failure on a shipped record actionable.
 */
const REJECTIONS: ReadonlyArray<{ what: string; over: RawTheme; expected: string }> = [
  { what: 'trackId missing', over: { trackId: undefined }, expected: 'trackId: must be a non-empty string, got undefined' },
  { what: 'trackId empty', over: { trackId: '' }, expected: 'trackId: must be a non-empty string, got ""' },
  { what: 'road not an array', over: { road: { r: 1 } }, expected: 'road: must be an array of 3 numbers, got an object' },
  { what: 'road too short', over: { road: [0.1, 0.2] }, expected: 'road: must be an array of 3 numbers, got an array of 2' },
  { what: 'road component above 1', over: { road: [0.1, 1.4, 0.2] }, expected: 'road[1]: must be within 0..1, got 1.4' },
  { what: 'roadDirt missing', over: { roadDirt: undefined }, expected: 'roadDirt: must be an array of 3 numbers, got undefined' },
  { what: 'shoulder component negative', over: { shoulder: [0.1, 0.2, -0.2] }, expected: 'shoulder[2]: must be within 0..1, got -0.2' },
  { what: 'wall missing', over: { wall: undefined }, expected: 'wall: must be an array of 3 numbers, got undefined' },
  { what: 'ground component not a number', over: { ground: [null, 0.2, 0.2] }, expected: 'ground[0]: must be a finite number, got null' },
  { what: 'sky missing', over: { sky: undefined }, expected: 'sky: must be an object with top and bottom, got undefined' },
  { what: 'sky.top invalid', over: { sky: { top: [1.5, 0, 0], bottom: [0.5, 0.5, 0.5] } }, expected: 'sky.top[0]: must be within 0..1, got 1.5' },
  { what: 'sky.bottom missing', over: { sky: { top: [0.1, 0.1, 0.1] } }, expected: 'sky.bottom: must be an array of 3 numbers, got undefined' },
  { what: 'fog missing', over: { fog: undefined }, expected: 'fog: must be an object with color, near and far, got undefined' },
  { what: 'fog.color invalid', over: { fog: { color: [0.1, 0.1], near: 10, far: 20 } }, expected: 'fog.color: must be an array of 3 numbers, got an array of 2' },
  { what: 'fog.near not a number', over: { fog: { color: [0.1, 0.1, 0.1], near: '120', far: 300 } }, expected: 'fog.near: must be a finite number, got "120"' },
  { what: 'fog.near negative', over: { fog: { color: [0.1, 0.1, 0.1], near: -5, far: 300 } }, expected: 'fog.near: must be at least 0, got -5' },
  { what: 'fog.near not less than far', over: { fog: { color: [0.1, 0.1, 0.1], near: 900, far: 120 } }, expected: 'fog: near 900 must be less than far 120' },
  { what: 'sunDirection missing', over: { sunDirection: undefined }, expected: 'sunDirection: must be an object with x, y and z, got undefined' },
  { what: 'sunDirection.y missing', over: { sunDirection: { x: 0, z: 0 } }, expected: 'sunDirection.y: must be a finite number, got undefined' },
  { what: 'sunDirection not unit', over: { sunDirection: { x: 0, y: 1.2, z: 0 } }, expected: 'sunDirection: must be a unit vector' },
  { what: 'sunDirection zero', over: { sunDirection: { x: 0, y: 0, z: 0 } }, expected: 'sunDirection: must be a unit vector' },
  { what: 'ambient above 1', over: { ambient: 1.4 }, expected: 'ambient: must be within 0..1, got 1.4' },
  { what: 'edgeMarkers missing', over: { edgeMarkers: undefined }, expected: 'edgeMarkers: must be an object, got undefined' },
  {
    what: 'edgeMarkers.spacing too wide',
    over: { edgeMarkers: { spacing: 60, height: 0.9, offset: 0.7, colors: [[1, 1, 1], [0, 0, 0]] } },
    expected: 'edgeMarkers.spacing: must be within 4..40, got 60',
  },
  {
    what: 'edgeMarkers.height too short',
    over: { edgeMarkers: { spacing: 14, height: 0.1, offset: 0.7, colors: [[1, 1, 1], [0, 0, 0]] } },
    expected: 'edgeMarkers.height: must be within 0.3..2, got 0.1',
  },
  {
    what: 'edgeMarkers.offset too far outboard',
    over: { edgeMarkers: { spacing: 14, height: 0.9, offset: 5, colors: [[1, 1, 1], [0, 0, 0]] } },
    expected: 'edgeMarkers.offset: must be within 0..3, got 5',
  },
  {
    what: 'edgeMarkers.colors has one entry',
    over: { edgeMarkers: { spacing: 14, height: 0.9, offset: 0.7, colors: [[1, 1, 1]] } },
    expected: 'edgeMarkers.colors: must be an array of 2 palettes, got an array of 1',
  },
  {
    what: 'edgeMarkers.colors[1] out of range',
    over: { edgeMarkers: { spacing: 14, height: 0.9, offset: 0.7, colors: [[1, 1, 1], [1.5, 0, 0]] } },
    expected: 'edgeMarkers.colors[1][0]: must be within 0..1, got 1.5',
  },
]

describe('parseTrackTheme rejections', () => {
  it('covers every field in the schema', () => {
    // A truncated table is the silent way this suite stops testing what it claims to.
    expect(REJECTIONS).toHaveLength(28)
  })

  for (const c of REJECTIONS) {
    it(`rejects ${c.what}`, () => {
      expect(() => parseTrackTheme(rawTheme(c.over))).toThrow(c.expected)
    })
  }

  it('rejects unknown keys, at the top level and inside nested objects', () => {
    // Task 3's descriptor parsers reject unknown keys and this parser matches them: a
    // theme that silently ignores `glow` lets a generated record claim a field the
    // renderer will never read, and the author has no way to find out.
    const top = { ...rawTheme(), glow: 3 }
    expect(() => parseTrackTheme(top)).toThrow("theme: unknown key 'glow'")

    const markers = rawTheme({
      edgeMarkers: {
        spacing: 14,
        height: 0.9,
        offset: 0.7,
        colors: [
          [1, 1, 1],
          [0, 0, 0],
        ],
        blink: true,
      },
    })
    expect(() => parseTrackTheme(markers)).toThrow("edgeMarkers: unknown key 'blink'")

    const sun = rawTheme({ sunDirection: { x: 0.36, y: 0.8, z: 0.48, w: 1 } })
    expect(() => parseTrackTheme(sun)).toThrow("sunDirection: unknown key 'w'")

    const sky = rawTheme({ sky: { top: [0.1, 0.1, 0.1], bottom: [0.2, 0.2, 0.2], haze: 1 } })
    expect(() => parseTrackTheme(sky)).toThrow("sky: unknown key 'haze'")

    const fog = rawTheme({ fog: { color: [0.1, 0.1, 0.1], near: 10, far: 20, density: 0.5 } })
    expect(() => parseTrackTheme(fog)).toThrow("fog: unknown key 'density'")
  })

  it('rejects a non-object outright', () => {
    expect(() => parseTrackTheme(null)).toThrow('parseTrackTheme: must be an object, got null')
    expect(() => parseTrackTheme([])).toThrow('parseTrackTheme: must be an object, got an array of 0')
    expect(() => parseTrackTheme(7)).toThrow('parseTrackTheme: must be an object, got 7')
  })

  it('lists every violation in one message, not just the first', () => {
    // A parser that throws on the first bad field makes fixing a generated record an
    // N-round trip. Task 6 gates 22 records against this parser; one message per
    // record is the difference between one regeneration and six.
    let message = ''
    try {
      parseTrackTheme(rawTheme({ ambient: 4, trackId: undefined }))
    } catch (e) {
      message = (e as Error).message
    }
    expect(message).toContain('trackId')
    expect(message).toContain('ambient')
    expect(message).toContain('; ')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/content/test/theme.test.ts`

Expected: FAIL — the whole file fails to collect, with
`Error: Cannot find module '../src/theme' imported from '<repo>/packages/content/test/theme.test.ts'`
and `Caused by: Error: Failed to load url ../src/theme (resolved id: ../src/theme) ... Does the file exist?`

- [ ] **Step 3: Write the implementation**

Create `packages/content/src/theme.ts`:

```ts
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
```

Three implementation notes, each of which a test above would catch if ignored:

1. **Every value is copied out.** The returned theme shares no object with `json`. The
   shipped records arrive as *imported JSON modules* (§3a.1) — one process-wide object per
   file — so a parser that returned its argument would let any consumer's mutation reach
   every later `loadContentBundle()` caller.
2. **Errors accumulate, then throw once.** 22 generated records go through this parser in
   Task 6's gate; one message per record is what makes a regeneration one round trip.
3. **`unitVec` bails to `{0,1,0}` after a component error** so a missing `y` does not also
   produce a bogus "not a unit vector" line naming a field the author did not write.
4. **Unknown keys are rejected, here and in every nested object**, matching Task 3's
   `parseCharacterDescriptor` / `parseKartDescriptor`. All three parsers run over
   generated records in Task 6's gate, and a parser that silently drops a key lets a
   generated theme claim a field nothing reads. What this parser deliberately does **not**
   check is uniqueness or cross-record agreement — `trackId` collisions and roster order
   are Task 5's and Task 6's, because a per-record parser cannot see the other 21 records.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/content/test/theme.test.ts`

Expected: PASS — 39 passed (4 `parseTrackTheme` + 3 `DEFAULT_TRACK_THEME` + 32 rejection
tests: the coverage guard, the 28 table cases, the unknown-key case, the non-object case
and the multiple-violation case).

Then typecheck the package:

Run: `npx tsc --noEmit -p packages/content`

Expected: no output, exit 0. If it reports `Cannot find module './descriptors'`, Task 3 has
not landed yet — that is an ordering failure, not a defect in this file.

- [ ] **Step 5: Commit**

```bash
git add packages/content/src/theme.ts packages/content/test/theme.test.ts
git commit -m "feat(content): track theme schema, parser and the neutral fallback theme"
```
