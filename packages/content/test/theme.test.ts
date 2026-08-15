import { readFileSync } from 'node:fs'
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

  it('hands back readonly palettes, so a consumer cannot repaint shipped content', () => {
    const theme = parseTrackTheme(rawTheme())
    // `const road: PaletteRGB = theme.road` would NOT assert this: that annotation
    // compiles just as happily against a mutable [number, number, number]. Only an
    // attempted write separates the two — if PaletteRGB or `colors` ever loses
    // `readonly`, tsc fails here with TS2578 "Unused '@ts-expect-error' directive".
    // Every target below belongs to the freshly parsed object, so no shipped record
    // is reachable from these writes at runtime.
    // @ts-expect-error TrackTheme.road is a readonly PaletteRGB triple
    theme.road[0] = 0.5
    // @ts-expect-error EdgeMarkerParams.colors is a readonly pair
    theme.edgeMarkers.colors[0] = [0, 0, 0]

    expect(DEFAULT_TRACK_THEME.road[0]).toBe(0.18)
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

  it('is declared Readonly, so the fallback cannot be repainted in place', () => {
    // A clone, because the write below is real at runtime: nothing here may reach the
    // one shared fallback every unthemed track renders from. The type is `typeof
    // DEFAULT_TRACK_THEME` rather than a written-out `Readonly<TrackTheme>`, so
    // widening the declaration to a mutable TrackTheme makes the directive unused and
    // fails tsc with TS2578 instead of quietly re-asserting an annotation of our own.
    const probe = structuredClone(DEFAULT_TRACK_THEME)
    // @ts-expect-error DEFAULT_TRACK_THEME is Readonly<TrackTheme>: ambient is not assignable
    probe.ambient = 0.9

    expect(DEFAULT_TRACK_THEME.ambient).toBe(0.35)
  })
})

/**
 * One case per field the parser must check. The bug this table exists to catch is a
 * parser that simply casts its argument — or that validates eight fields and forgets
 * the ninth: such a parser accepts every case below without throwing, and every case
 * below fails. `toThrow(string)` is a substring match on the message, so each case
 * also pins that the message NAMES the offending field AND states the rule and its
 * bounds, which is what makes a startup failure on a shipped record actionable — and
 * what a parser that rejects everything by reciting one generic complaint cannot fake.
 */
const REJECTIONS: ReadonlyArray<{ what: string; over: RawTheme; expected: string }> = [
  { what: 'trackId missing', over: { trackId: undefined }, expected: 'trackId: must be a non-empty string, got undefined' },
  { what: 'trackId empty', over: { trackId: '' }, expected: 'trackId: must be a non-empty string, got ""' },
  { what: 'road not an array', over: { road: { r: 1 } }, expected: 'road: must be an array of 3 numbers, got an object' },
  { what: 'road too short', over: { road: [0.1, 0.2] }, expected: 'road: must be an array of 3 numbers, got an array of 2' },
  { what: 'road component above 1', over: { road: [0.1, 1.4, 0.2] }, expected: 'road[1]: must be within 0..1, got 1.4' },
  { what: 'road component NaN', over: { road: [Number.NaN, 0.2, 0.2] }, expected: 'road[0]: must be a finite number, got NaN' },
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
  { what: 'fog.far infinite', over: { fog: { color: [0.1, 0.1, 0.1], near: 10, far: Number.POSITIVE_INFINITY } }, expected: 'fog.far: must be a finite number, got Infinity' },
  { what: 'fog.near not less than far', over: { fog: { color: [0.1, 0.1, 0.1], near: 900, far: 120 } }, expected: 'fog: near 900 must be less than far 120' },
  { what: 'sunDirection missing', over: { sunDirection: undefined }, expected: 'sunDirection: must be an object with x, y and z, got undefined' },
  { what: 'sunDirection.y missing', over: { sunDirection: { x: 0, z: 0 } }, expected: 'sunDirection.y: must be a finite number, got undefined' },
  { what: 'sunDirection not unit', over: { sunDirection: { x: 0, y: 1.2, z: 0 } }, expected: 'sunDirection: must be a unit vector, |v| = 1.2' },
  { what: 'sunDirection zero', over: { sunDirection: { x: 0, y: 0, z: 0 } }, expected: 'sunDirection: must be a unit vector, |v| = 0' },
  { what: 'ambient above 1', over: { ambient: 1.4 }, expected: 'ambient: must be within 0..1, got 1.4' },
  { what: 'ambient infinite', over: { ambient: Number.POSITIVE_INFINITY }, expected: 'ambient: must be a finite number, got Infinity' },
  { what: 'edgeMarkers missing', over: { edgeMarkers: undefined }, expected: 'edgeMarkers: must be an object, got undefined' },
  {
    what: 'edgeMarkers.spacing too wide',
    over: { edgeMarkers: { spacing: 60, height: 0.9, offset: 0.7, colors: [[1, 1, 1], [0, 0, 0]] } },
    expected: 'edgeMarkers.spacing: must be within 4..40, got 60',
  },
  {
    what: 'edgeMarkers.spacing NaN',
    over: { edgeMarkers: { spacing: Number.NaN, height: 0.9, offset: 0.7, colors: [[1, 1, 1], [0, 0, 0]] } },
    expected: 'edgeMarkers.spacing: must be a finite number, got NaN',
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

/** Non-objects as [label, value] rows. Spreading bare values through `it.each` is
 *  how `[]` silently becomes zero arguments and re-tests `undefined`. */
const NON_OBJECTS: ReadonlyArray<readonly [string, unknown]> = [
  ['null', null],
  ['undefined', undefined],
  ['an empty array', []],
  ['a number', 7],
  ['a string', 'caldera'],
  ['a boolean', true],
]

/** The eleven fields of the schema, as the parser's own allow-list spells them. */
const TOP_LEVEL_KEYS = [
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
] as const

describe('parseTrackTheme rejections', () => {
  it('covers every field in the schema', () => {
    // A truncated table is the silent way this suite stops testing what it claims to.
    expect(REJECTIONS).toHaveLength(32)
  })

  for (const c of REJECTIONS) {
    it(`rejects ${c.what}`, () => {
      const parse = (): unknown => parseTrackTheme(rawTheme(c.over))
      expect(parse).toThrow(c.expected)
      // The aggregate prefix, so a case cannot pass on a stray throw from elsewhere.
      expect(parse).toThrow(/^parseTrackTheme: /)
      // Every override above replaces a key the schema already declares, so none of
      // them introduces an unknown one. Without this line, a parser whose allow-list
      // is missing a legitimate field would satisfy the assertions above while
      // rejecting valid content for a reason that has nothing to do with the case.
      expect(parse).not.toThrow(/unknown key/)

      // The decisive check that the named rule FIRED rather than merely being recited.
      // A parser that answers every rejection by reciting the whole schema — every
      // field, every bound, interpolating each field's current value — satisfies a
      // `toThrow(rule text)` table completely, however precisely the rule text is
      // quoted. What it cannot do is stay SILENT about the ten fields this record did
      // not break. Word boundaries, so `road` does not match inside `roadDirt`.
      let message = ''
      try {
        parse()
      } catch (e) {
        message = (e as Error).message
      }
      for (const key of TOP_LEVEL_KEYS) {
        if (key in c.over) continue
        expect(message).not.toMatch(new RegExp(`\\b${key}\\b`))
      }
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

  it.each(NON_OBJECTS)('rejects %s, naming the value it was handed', (label, value) => {
    // The label is what the row is for: `[]` spread as a bare `it.each` row arrives as
    // zero arguments and re-tests `undefined`, which is how a table like this stops
    // covering the array case without anyone noticing.
    expect(label.length).toBeGreaterThan(0)
    expect(() => parseTrackTheme(value)).toThrow(/^parseTrackTheme: must be an object, got /)
  })

  it('lists every violation in one message, not just the first', () => {
    // A parser that throws on the first bad field makes fixing a generated record an
    // N-round trip. Task 5 gates 22 records against this parser; one message per
    // record is the difference between one regeneration and six.
    let message = ''
    try {
      parseTrackTheme(rawTheme({ ambient: 4, trackId: undefined }))
    } catch (e) {
      message = (e as Error).message
    }
    // Both rules in full: a message that merely mentions both field names would also
    // be produced by a parser that names every field it looked at, violation or not.
    expect(message).toContain('trackId: must be a non-empty string, got undefined')
    expect(message).toContain('ambient: must be within 0..1, got 4')
    expect(message).toContain('; ')
    expect(message.startsWith('parseTrackTheme: ')).toBe(true)
  })
})

// Contract §0a: this module is PURE, `packages/server` (Plan 4) imports it under plain
// Node, and Task 5 esbuild-bundles `parseTrackTheme` into its generation gate. Both of
// its imports are type-only, so `verbatimModuleSyntax` erases them and neither `sim`
// nor `descriptors` is loaded at runtime. Nothing else in the suite would notice a
// value import appearing.
describe('src/theme.ts pulls in nothing at runtime', () => {
  const source = readFileSync(new URL('../src/theme.ts', import.meta.url), 'utf8')

  it('imports only types, and re-exports nothing', () => {
    const imports = source.match(/^import\b[^\n]*$/gm) ?? []
    expect(imports).toHaveLength(2)
    for (const line of imports) {
      expect(line).toMatch(/^import type\b/)
    }
    expect(source).toContain("import type { Vec3 } from '@tapkart/sim'")
    expect(source).toContain("import type { PaletteRGB } from './descriptors'")

    // A scan for `import` alone has a hole: `export { x } from './y'` is a real runtime
    // dependency that type erasure does NOT remove, and it slips past an import-only
    // check entirely. A dependency check with a hole in it is worse than none, because
    // it reads as coverage.
    expect(source).not.toMatch(/^export\b[^\n]*\bfrom\b/m)
    expect(source).not.toMatch(/\bimport\s*\(/)
    expect(source).not.toMatch(/\brequire\s*\(/)
  })
})
