// PURE. Schema and parsers only: no DOM, no clock, no three, no bundler feature.
// The sixteen shipped descriptor records are authored in a later task; this
// module is what will accept or reject them.
//
// Scope note: `id` UNIQUENESS across the eight is deliberately NOT checked here.
// A parser sees one record at a time and cannot know what the other seven chose,
// so a uniqueness check written in this file could only ever be a no-op. It
// belongs to the bundle/delegation gate, which is the one place that holds all
// eight at once. Do not "fix" it here.

/** Linear, 0..1 per component. Never a CSS string, never 0..255, never hex. */
export type PaletteRGB = readonly [number, number, number]

export interface CharacterDescriptor {
  id: string
  name: string
  bodyHeight: number
  bodyRadius: number
  headRadius: number
  palette: { primary: PaletteRGB; secondary: PaletteRGB; accent: PaletteRGB }
  silhouette: 'compact' | 'tall' | 'wide'
}

export interface KartDescriptor {
  id: string
  name: string
  chassisLength: number
  chassisWidth: number
  chassisHeight: number
  wheelRadius: number
  wheelWidth: number
  palette: { body: PaletteRGB; trim: PaletteRGB; wheel: PaletteRGB }
}

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const SILHOUETTES = ['compact', 'tall', 'wide'] as const

interface NumericRange {
  key: string
  min: number
  max: number
}

const CHARACTER_RANGES: readonly NumericRange[] = [
  { key: 'bodyHeight', min: 0.4, max: 1.4 },
  { key: 'bodyRadius', min: 0.15, max: 0.5 },
  { key: 'headRadius', min: 0.1, max: 0.4 },
]

const KART_RANGES: readonly NumericRange[] = [
  { key: 'chassisLength', min: 1.4, max: 2.6 },
  { key: 'chassisWidth', min: 0.9, max: 1.6 },
  { key: 'chassisHeight', min: 0.3, max: 0.8 },
  { key: 'wheelRadius', min: 0.2, max: 0.45 },
  { key: 'wheelWidth', min: 0.1, max: 0.35 },
]

const CHARACTER_PALETTE_KEYS = ['primary', 'secondary', 'accent'] as const
const KART_PALETTE_KEYS = ['body', 'trim', 'wheel'] as const

function describeValue(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (Array.isArray(value)) return `an array of length ${value.length}`
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return typeof value
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function readId(rec: Record<string, unknown>, issues: string[]): string {
  const raw = rec['id']
  if (typeof raw !== 'string' || !ID_PATTERN.test(raw)) {
    issues.push(
      `id must be a lowercase hyphenated string matching ${ID_PATTERN.source}, got ${describeValue(raw)}`,
    )
    return ''
  }
  return raw
}

function readName(rec: Record<string, unknown>, issues: string[]): string {
  const raw = rec['name']
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    issues.push(`name must be a non-empty string, got ${describeValue(raw)}`)
    return ''
  }
  return raw
}

function readNumber(
  rec: Record<string, unknown>,
  range: NumericRange,
  issues: string[],
): number {
  const raw = rec[range.key]
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < range.min || raw > range.max) {
    issues.push(
      `${range.key} must be a finite number in [${range.min}, ${range.max}], got ${describeValue(raw)}`,
    )
    return 0
  }
  return raw
}

/**
 * The raw value of a numeric field when it IS a number, ignoring its range.
 *
 * Cross-field rules use this rather than `readNumber`'s return, and they gain and lose
 * by it deliberately. A field that is out of range is still a real number, so the pair
 * rule below can be shown to fire — gated on the ranges, `wheelWidth < chassisWidth / 2`
 * would be unreachable code, because wheelWidth maxes at 0.35 and half the narrowest
 * legal chassis is 0.45. A field that is a string or NaN has no value to compare, and
 * comparing `readNumber`'s 0 stand-in would report a second failure about a number the
 * record never contained.
 */
function rawNumber(rec: Record<string, unknown>, key: string): number | null {
  const raw = rec[key]
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null
}

function readPalette(
  paletteRec: Record<string, unknown> | null,
  key: string,
  issues: string[],
): PaletteRGB {
  if (paletteRec === null) return [0, 0, 0]
  const raw = paletteRec[key]
  if (!Array.isArray(raw) || raw.length !== 3) {
    issues.push(`palette.${key} must be an array of exactly 3 numbers, got ${describeValue(raw)}`)
    return [0, 0, 0]
  }
  const out: [number, number, number] = [0, 0, 0]
  let ok = true
  for (let i = 0; i < 3; i++) {
    const c: unknown = raw[i]
    if (typeof c !== 'number' || !Number.isFinite(c) || c < 0 || c > 1) {
      issues.push(
        `palette.${key}[${i}] must be a finite number in [0, 1] (linear), got ${describeValue(c)}`,
      )
      ok = false
      continue
    }
    out[i] = c
  }
  return ok ? out : [0, 0, 0]
}

function reportUnknownKeys(
  rec: Record<string, unknown>,
  allowedKeys: readonly string[],
  prefix: string,
  issues: string[],
): void {
  for (const key of Object.keys(rec)) {
    if (!allowedKeys.includes(key)) issues.push(`${prefix}${key} is not a field of this schema`)
  }
}

function readPaletteRecord(
  rec: Record<string, unknown>,
  allowedKeys: readonly string[],
  issues: string[],
): Record<string, unknown> | null {
  const paletteRec = asRecord(rec['palette'])
  if (paletteRec === null) {
    issues.push(
      `palette must be an object with keys ${allowedKeys.join(', ')}, got ${describeValue(rec['palette'])}`,
    )
    return null
  }
  reportUnknownKeys(paletteRec, allowedKeys, 'palette.', issues)
  return paletteRec
}

function fail(fn: string, issues: readonly string[]): never {
  throw new Error(`${fn}: ${issues.join('; ')}`)
}

const CHARACTER_KEYS: readonly string[] = [
  'id', 'name', 'bodyHeight', 'bodyRadius', 'headRadius', 'palette', 'silhouette',
]

const KART_KEYS: readonly string[] = [
  'id', 'name', 'chassisLength', 'chassisWidth', 'chassisHeight', 'wheelRadius',
  'wheelWidth', 'palette',
]

/**
 * Throws with a field-listing message on any shape violation, including a
 * numeric field outside its declared range and a palette component outside
 * 0..1. Never returns a partially-populated descriptor.
 */
export function parseCharacterDescriptor(json: unknown): CharacterDescriptor {
  const rec = asRecord(json)
  if (rec === null) fail('parseCharacterDescriptor', [`expected a JSON object, got ${describeValue(json)}`])

  const issues: string[] = []
  reportUnknownKeys(rec, CHARACTER_KEYS, '', issues)

  const id = readId(rec, issues)
  const name = readName(rec, issues)
  const bodyHeight = readNumber(rec, CHARACTER_RANGES[0], issues)
  const bodyRadius = readNumber(rec, CHARACTER_RANGES[1], issues)
  const headRadius = readNumber(rec, CHARACTER_RANGES[2], issues)

  const paletteRec = readPaletteRecord(rec, CHARACTER_PALETTE_KEYS, issues)
  const primary = readPalette(paletteRec, 'primary', issues)
  const secondary = readPalette(paletteRec, 'secondary', issues)
  const accent = readPalette(paletteRec, 'accent', issues)

  const rawSilhouette = rec['silhouette']
  let silhouette: CharacterDescriptor['silhouette'] = 'compact'
  if (
    typeof rawSilhouette !== 'string' ||
    !(SILHOUETTES as readonly string[]).includes(rawSilhouette)
  ) {
    issues.push(
      `silhouette must be one of ${SILHOUETTES.join(', ')}, got ${describeValue(rawSilhouette)}`,
    )
  } else {
    silhouette = rawSilhouette as CharacterDescriptor['silhouette']
  }

  if (issues.length > 0) fail('parseCharacterDescriptor', issues)

  return {
    id, name, bodyHeight, bodyRadius, headRadius,
    palette: { primary, secondary, accent },
    silhouette,
  }
}

/** Same rules as parseCharacterDescriptor, over the kart schema. */
export function parseKartDescriptor(json: unknown): KartDescriptor {
  const rec = asRecord(json)
  if (rec === null) fail('parseKartDescriptor', [`expected a JSON object, got ${describeValue(json)}`])

  const issues: string[] = []
  reportUnknownKeys(rec, KART_KEYS, '', issues)

  const id = readId(rec, issues)
  const name = readName(rec, issues)
  const chassisLength = readNumber(rec, KART_RANGES[0], issues)
  const chassisWidth = readNumber(rec, KART_RANGES[1], issues)
  const chassisHeight = readNumber(rec, KART_RANGES[2], issues)
  const wheelRadius = readNumber(rec, KART_RANGES[3], issues)
  const wheelWidth = readNumber(rec, KART_RANGES[4], issues)

  // Cross-field geometry. Every field above can sit inside its own range while the
  // combination is not a kart: nothing in a per-field range stops a 0.90 m wheel being
  // bolted to a 1.40 m chassis, and the renderer is then handed overlapping solids. This
  // is the descriptor-shaped version of the defect `glacier-pass` shipped with — an
  // 8.4 m hairpin under a 21 m road, every field legal, the drivable surface folded —
  // which `validateTrack` missed for exactly this reason: nothing compared two fields.
  //
  // Both rules hold for all eight shipped karts with margin (the tightest is 0.27 m).
  const chassisLengthRaw = rawNumber(rec, 'chassisLength')
  const chassisWidthRaw = rawNumber(rec, 'chassisWidth')
  const wheelRadiusRaw = rawNumber(rec, 'wheelRadius')
  const wheelWidthRaw = rawNumber(rec, 'wheelWidth')

  if (wheelWidthRaw !== null && chassisWidthRaw !== null && !(wheelWidthRaw < chassisWidthRaw / 2)) {
    issues.push(
      `wheelWidth ${wheelWidthRaw} must be less than half of chassisWidth ${chassisWidthRaw} ` +
        `(${chassisWidthRaw / 2}), because a left and a right wheel both sit inside that width`,
    )
  }
  if (
    wheelRadiusRaw !== null &&
    chassisLengthRaw !== null &&
    !(2 * wheelRadiusRaw <= chassisLengthRaw / 2)
  ) {
    issues.push(
      `wheelRadius ${wheelRadiusRaw} means a ${2 * wheelRadiusRaw} wheel diameter, which must be ` +
        `at most half of chassisLength ${chassisLengthRaw} (${chassisLengthRaw / 2})`,
    )
  }

  const paletteRec = readPaletteRecord(rec, KART_PALETTE_KEYS, issues)
  const body = readPalette(paletteRec, 'body', issues)
  const trim = readPalette(paletteRec, 'trim', issues)
  const wheel = readPalette(paletteRec, 'wheel', issues)

  if (issues.length > 0) fail('parseKartDescriptor', issues)

  return {
    id, name, chassisLength, chassisWidth, chassisHeight, wheelRadius, wheelWidth,
    palette: { body, trim, wheel },
  }
}
