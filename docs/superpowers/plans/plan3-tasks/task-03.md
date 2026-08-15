### Task 3: `packages/content/src/descriptors.ts` — the character and kart schema and parsers

**Files:**
- Create: `packages/content/src/descriptors.ts`
- Create: `packages/content/test/fixtures/descriptor-fixtures.ts`
- Test: `packages/content/test/descriptors.test.ts`

**Interfaces:**

- **Consumes**: nothing. This module imports no other module, from `sim` or anywhere else — `PaletteRGB` is defined *here*, and `packages/content/src/theme.ts` (§3a.4, a later task) will import it from this file. It needs Task 1's `packages/content/package.json` and `packages/content/tsconfig.json` to exist, and nothing else.

- **Produces** — contract §3a.3, exactly five exports (`content/descriptors`, symbol census §11), signatures verbatim:

  ```ts
  export type PaletteRGB = readonly [number, number, number]   // linear, 0..1

  export interface CharacterDescriptor {
    id: string                   // lowercase, hyphenated, unique across the eight
    name: string                 // the DISPLAYED name
    bodyHeight: number           // metres, 0.4 – 1.4
    bodyRadius: number           // metres, 0.15 – 0.5
    headRadius: number           // metres, 0.1 – 0.4
    palette: { primary: PaletteRGB; secondary: PaletteRGB; accent: PaletteRGB }
    silhouette: 'compact' | 'tall' | 'wide'
  }

  export interface KartDescriptor {
    id: string
    name: string
    chassisLength: number        // metres, 1.4 – 2.6
    chassisWidth: number         // metres, 0.9 – 1.6
    chassisHeight: number        // metres, 0.3 – 0.8
    wheelRadius: number          // metres, 0.2 – 0.45
    wheelWidth: number           // metres, 0.1 – 0.35
    palette: { body: PaletteRGB; trim: PaletteRGB; wheel: PaletteRGB }
  }

  /** Throws with a field-listing message on any shape violation, including a
   *  numeric field outside the range in the comments above and a palette component
   *  outside 0..1. Never returns a partially-populated descriptor. */
  export function parseCharacterDescriptor(json: unknown): CharacterDescriptor
  export function parseKartDescriptor(json: unknown): KartDescriptor
  ```

  Plus two **test-only** fixtures this task adds, used by later content tests and by the delegation task's gate. They are not in contract §9.1's fixture list — §9.1's `makeCharacterDescriptorFixture(): CharacterDescriptor` and `makeKartDescriptorFixture(): KartDescriptor` belong to `packages/render/test/fixtures/render-fixtures.ts` and return *parsed* descriptors. These return **unparsed JSON**, which is what a parser test needs, and are named differently so the two never get confused:

  ```ts
  // packages/content/test/fixtures/descriptor-fixtures.ts
  export function makeCharacterDescriptorJson(overrides?: Record<string, unknown>): Record<string, unknown>
  export function makeKartDescriptorJson(overrides?: Record<string, unknown>): Record<string, unknown>
  ```

**Scope: schema and parsers only.** The sixteen shipped descriptor records are Q2's DeepSeek delegation and are a *later* task, which is the whole reason this schema is locked first — the batch is authored against it, and its gate is built by esbuild-bundling these two real functions rather than re-implementing them, because a gate that re-implements validation tests the gate. So this task ships the parsers plus the fixtures that later task will validate against, and no records.

Two facts about these types that the later tasks depend on and that this one must not blur: **`CharacterDescriptor` is not `CharacterStats`** — stats are handling (Task 2), descriptors are appearance, and they are joined **only by array index** (`KartState.characterIdx`), never by `id`, because the two `id` spaces are unrelated. And **`KART_DESCRIPTORS[i]` is the kart of `CHARACTER_DESCRIPTORS[i]`**: v1 has no separate kart selection.

---

- [ ] **Step 1: Write the failing test**

Create `packages/content/test/fixtures/descriptor-fixtures.ts`:

```ts
/**
 * Valid descriptor JSON in exactly the shape the sixteen shipped files will use.
 * TEST-ONLY: `packages/content/src` never imports this, exactly as §2.6 requires
 * of sim's fixtures.
 *
 * The return type is `Record<string, unknown>` on purpose: a mutation test has to
 * be able to write a wrong-typed value into any field, which a `CharacterDescriptor`
 * return type would forbid at compile time. Every call returns a fresh object,
 * including fresh palette arrays, so one case's mutation cannot leak into the next.
 */
export function makeCharacterDescriptorJson(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 'ash-vega',
    name: 'Ash Vega',
    bodyHeight: 0.95,
    bodyRadius: 0.28,
    headRadius: 0.22,
    palette: {
      primary: [0.85, 0.16, 0.24],
      secondary: [0.1, 0.11, 0.16],
      accent: [1, 0.78, 0.2],
    },
    silhouette: 'compact',
    ...overrides,
  }
}

export function makeKartDescriptorJson(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 'ember-dart',
    name: 'Ember Dart',
    chassisLength: 2,
    chassisWidth: 1.2,
    chassisHeight: 0.55,
    wheelRadius: 0.32,
    wheelWidth: 0.18,
    palette: {
      body: [0.9, 0.35, 0.1],
      trim: [0.15, 0.15, 0.18],
      wheel: [0.05, 0.05, 0.06],
    },
    ...overrides,
  }
}
```

Create `packages/content/test/descriptors.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { parseCharacterDescriptor, parseKartDescriptor } from '../src/descriptors'
import type { CharacterDescriptor, KartDescriptor, PaletteRGB } from '../src/descriptors'
import { makeCharacterDescriptorJson, makeKartDescriptorJson } from './fixtures/descriptor-fixtures'

describe('parseCharacterDescriptor accepts a valid record', () => {
  it('returns every field verbatim', () => {
    const parsed: CharacterDescriptor = parseCharacterDescriptor(makeCharacterDescriptorJson())
    expect(parsed).toEqual({
      id: 'ash-vega',
      name: 'Ash Vega',
      bodyHeight: 0.95,
      bodyRadius: 0.28,
      headRadius: 0.22,
      palette: {
        primary: [0.85, 0.16, 0.24],
        secondary: [0.1, 0.11, 0.16],
        accent: [1, 0.78, 0.2],
      },
      silhouette: 'compact',
    })
  })

  it('copies rather than aliasing the input, so mutating the JSON cannot reach the descriptor', () => {
    const json = makeCharacterDescriptorJson()
    const parsed = parseCharacterDescriptor(json)
    const palette = json['palette'] as Record<string, number[]>
    palette['primary'][0] = 0.01
    ;(json as Record<string, unknown>)['name'] = 'Overwritten'
    expect(parsed.palette.primary[0]).toBe(0.85)
    expect(parsed.name).toBe('Ash Vega')
  })

  it.each([
    ['bodyHeight', 0.4, 1.4],
    ['bodyRadius', 0.15, 0.5],
    ['headRadius', 0.1, 0.4],
  ])('accepts %s at both inclusive bounds', (key, min, max) => {
    expect(() => parseCharacterDescriptor(makeCharacterDescriptorJson({ [key]: min }))).not.toThrow()
    expect(() => parseCharacterDescriptor(makeCharacterDescriptorJson({ [key]: max }))).not.toThrow()
  })

  it.each([
    ['bodyHeight', 0.4, 1.4],
    ['bodyRadius', 0.15, 0.5],
    ['headRadius', 0.1, 0.4],
  ])('rejects %s just outside both bounds', (key, min, max) => {
    expect(() => parseCharacterDescriptor(makeCharacterDescriptorJson({ [key]: min - 1e-6 })))
      .toThrow(new RegExp(key))
    expect(() => parseCharacterDescriptor(makeCharacterDescriptorJson({ [key]: max + 1e-6 })))
      .toThrow(new RegExp(key))
  })

  it('accepts every silhouette the schema lists', () => {
    for (const silhouette of ['compact', 'tall', 'wide']) {
      const parsed = parseCharacterDescriptor(makeCharacterDescriptorJson({ silhouette }))
      expect(parsed.silhouette).toBe(silhouette)
    }
  })
})

describe('parseCharacterDescriptor rejects one mutated field at a time, naming it', () => {
  const cases: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ['id', { id: 'Ash-Vega' }],
    ['id', { id: 'ash_vega' }],
    ['id', { id: '-ash' }],
    ['id', { id: 42 }],
    ['name', { name: '' }],
    ['name', { name: 7 }],
    ['bodyHeight', { bodyHeight: 2.2 }],
    ['bodyHeight', { bodyHeight: Number.NaN }],
    ['bodyHeight', { bodyHeight: '0.95' }],
    ['bodyRadius', { bodyRadius: 0.01 }],
    ['headRadius', { headRadius: Number.POSITIVE_INFINITY }],
    ['silhouette', { silhouette: 'round' }],
    ['palette', { palette: null }],
    ['palette', { palette: [0.5, 0.5, 0.5] }],
  ]

  it.each(cases)('names %s', (field, override) => {
    expect(() => parseCharacterDescriptor(makeCharacterDescriptorJson(override)))
      .toThrow(new RegExp(`parseCharacterDescriptor: .*${field}`))
  })

  it.each(['primary', 'secondary', 'accent'])('names palette.%s when it is out of 0..1', (slot) => {
    const json = makeCharacterDescriptorJson()
    const palette = json['palette'] as Record<string, unknown>
    palette[slot] = [0.5, 1.5, 0.5]
    expect(() => parseCharacterDescriptor(json)).toThrow(new RegExp(`palette\\.${slot}\\[1\\]`))
  })

  it.each(['primary', 'secondary', 'accent'])('names palette.%s when it is the wrong length', (slot) => {
    const json = makeCharacterDescriptorJson()
    const palette = json['palette'] as Record<string, unknown>
    palette[slot] = [0.5, 0.5]
    expect(() => parseCharacterDescriptor(json)).toThrow(new RegExp(`palette\\.${slot} must be an array of exactly 3`))
  })

  it('rejects an unknown field rather than ignoring it', () => {
    expect(() => parseCharacterDescriptor(makeCharacterDescriptorJson({ bodyheight: 0.95 })))
      .toThrow(/bodyheight is not a field of this schema/)
  })

  it('lists every broken field in one message', () => {
    let message = ''
    try {
      parseCharacterDescriptor(makeCharacterDescriptorJson({ id: 'Ash', bodyHeight: 9, silhouette: 'round' }))
    } catch (err) {
      message = (err as Error).message
    }
    expect(message).toContain('id')
    expect(message).toContain('bodyHeight')
    expect(message).toContain('silhouette')
  })

  const NON_OBJECTS: ReadonlyArray<readonly [string, unknown]> = [
    ['null', null],
    ['undefined', undefined],
    ['a number', 42],
    ['a string', 'ash-vega'],
    ['an array', []],
    ['a boolean', true],
  ]

  it.each(NON_OBJECTS)('rejects %s, which is not a JSON object', (_label, value) => {
    expect(() => parseCharacterDescriptor(value)).toThrow(/parseCharacterDescriptor: expected a JSON object/)
  })
})

describe('parseKartDescriptor accepts a valid record', () => {
  it('returns every field verbatim', () => {
    const parsed: KartDescriptor = parseKartDescriptor(makeKartDescriptorJson())
    expect(parsed).toEqual({
      id: 'ember-dart',
      name: 'Ember Dart',
      chassisLength: 2,
      chassisWidth: 1.2,
      chassisHeight: 0.55,
      wheelRadius: 0.32,
      wheelWidth: 0.18,
      palette: {
        body: [0.9, 0.35, 0.1],
        trim: [0.15, 0.15, 0.18],
        wheel: [0.05, 0.05, 0.06],
      },
    })
  })

  it.each([
    ['chassisLength', 1.4, 2.6],
    ['chassisWidth', 0.9, 1.6],
    ['chassisHeight', 0.3, 0.8],
    ['wheelRadius', 0.2, 0.45],
    ['wheelWidth', 0.1, 0.35],
  ])('accepts %s at both inclusive bounds and rejects just outside them', (key, min, max) => {
    expect(() => parseKartDescriptor(makeKartDescriptorJson({ [key]: min }))).not.toThrow()
    expect(() => parseKartDescriptor(makeKartDescriptorJson({ [key]: max }))).not.toThrow()
    expect(() => parseKartDescriptor(makeKartDescriptorJson({ [key]: min - 1e-6 }))).toThrow(new RegExp(key))
    expect(() => parseKartDescriptor(makeKartDescriptorJson({ [key]: max + 1e-6 }))).toThrow(new RegExp(key))
  })

  it.each(['body', 'trim', 'wheel'])('names palette.%s when a component is out of 0..1', (slot) => {
    const json = makeKartDescriptorJson()
    const palette = json['palette'] as Record<string, unknown>
    palette[slot] = [0.5, 0.5, -0.001]
    expect(() => parseKartDescriptor(json)).toThrow(new RegExp(`palette\\.${slot}\\[2\\]`))
  })

  it('rejects a character record, which has neither the kart fields nor only kart fields', () => {
    expect(() => parseKartDescriptor(makeCharacterDescriptorJson())).toThrow(/parseKartDescriptor: /)
  })

  it('accepts a PaletteRGB as a readonly triple', () => {
    const parsed = parseKartDescriptor(makeKartDescriptorJson())
    const body: PaletteRGB = parsed.palette.body
    expect(body).toHaveLength(3)
  })
})
```

Four choices in that file are deliberate, and three of them are the difference between a test with teeth and one without:

- **Both bounds are asserted at the boundary *and* one part in a million outside it.** A parser written with `<` where it needs `<=` passes every "rejects 2.2" test ever written and rejects a legal `bodyHeight: 1.4` the day the delegated batch produces one. `min` / `max` accepted plus `min - 1e-6` / `max + 1e-6` rejected pins the comparison operator itself.
- **`NON_OBJECTS` is a table of `[label, value]` rows, not a bare list of values.** `it.each([null, undefined, 42, [], true])` spreads any row that *is* an array, so the `[]` case would arrive as zero arguments — the callback would receive `undefined` and silently re-test the `undefined` case, leaving "an array is not a JSON object" unasserted. The two-column form makes the array a value rather than a row. (`_label` is unused on purpose; `noUnusedParameters` exempts a leading underscore.)
- **The aliasing test mutates the input *after* parsing.** A parser that returns its input, or that stores the input's palette arrays by reference, is a parser through which a caller can later corrupt shipped content — and every field-equality assertion above still passes under that bug.
- **The unknown-field test asserts rejection, not tolerance.** `bodyheight` is the exact typo a generated record makes; if unknown keys were ignored it would parse "successfully" with `bodyHeight` reported missing and nothing pointing at the cause.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/content/test/descriptors.test.ts`

Expected: FAIL, no tests collected —

```
Error: Cannot find module '../src/descriptors' imported from '<repo>/packages/content/test/descriptors.test.ts'
Caused by: Error: Failed to load url ../src/descriptors (resolved id: ../src/descriptors) in <repo>/packages/content/test/descriptors.test.ts. Does the file exist?
```

and the summary `Test Files  1 failed (1)` / `Tests  no tests`.

Run: `npx tsc --noEmit -p packages/content`
Expected: FAIL — two `error TS2307: Cannot find module '../src/descriptors' or its corresponding type declarations.`, one at line 2 (the value import of the two parsers) and one at line 3 (the type-only import of the three types). `tsc` resolves both; vitest sees only the first, because a type-only import is erased before module resolution is attempted.

- [ ] **Step 3: Write the implementation**

Create `packages/content/src/descriptors.ts`:

```ts
// PURE. Schema and parsers only: no DOM, no clock, no three, no bundler feature.
// The sixteen shipped descriptor records are authored in a later task; this
// module is what will accept or reject them.

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
```

Five properties of that implementation are requirements, not style:

- **Every issue is collected, and the throw happens once at the end** — that is what "a field-listing message" means, and it is what makes the delegated batch's gate useful: a bad record reports all of its problems in one pass instead of one per re-run.
- **Nothing is constructed until `issues.length === 0`**, so a partially-populated descriptor cannot escape. The `return 0` / `return [0, 0, 0]` placeholders inside the readers exist only to keep the collection going; they are unreachable in any returned value.
- **Every returned palette is a fresh `[number, number, number]`**, never the input's array, so shipped content cannot be mutated through the object a parse handed back.
- **`Number.isFinite` is explicit.** A `NaN` would fail the range comparison anyway (every comparison with `NaN` is false), but relying on that is an accident waiting for a refactor to reorder the check.
- **Unknown keys are rejected**, at the top level and inside `palette`, with the offending key named.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/content/test/descriptors.test.ts`
Expected: `Tests  48 passed (48)`.

Run: `npx tsc --noEmit -p packages/content`
Expected: exit 0, no output.

Then confirm the suite fails under the three bugs it exists to catch, restoring the file after each:

```bash
cp packages/content/src/descriptors.ts /tmp/descriptors.bak.ts

# 1. exclusive bounds instead of inclusive -> expect 8 failed | 40 passed
sed -i 's/raw < range.min || raw > range.max/raw <= range.min || raw >= range.max/' packages/content/src/descriptors.ts
npx vitest run packages/content/test/descriptors.test.ts
cp /tmp/descriptors.bak.ts packages/content/src/descriptors.ts

# 2. unknown keys ignored -> expect 1 failed | 47 passed
sed -i 's/if (!allowedKeys.includes(key)) issues.push/if (false \&\& !allowedKeys.includes(key)) issues.push/' packages/content/src/descriptors.ts
npx vitest run packages/content/test/descriptors.test.ts
cp /tmp/descriptors.bak.ts packages/content/src/descriptors.ts

# 3. palette components unrange-checked -> expect 6 failed | 42 passed
sed -i 's/ || c < 0 || c > 1//' packages/content/src/descriptors.ts
npx vitest run packages/content/test/descriptors.test.ts
cp /tmp/descriptors.bak.ts packages/content/src/descriptors.ts

npx vitest run packages/content/test/descriptors.test.ts   # expect: Tests 48 passed (48)
rm /tmp/descriptors.bak.ts
```

If any mutated run comes back green, that assertion is not reaching the parser and the task is not done.

- [ ] **Step 5: Commit**

```bash
git add packages/content/src/descriptors.ts packages/content/test/descriptors.test.ts packages/content/test/fixtures/descriptor-fixtures.ts && git commit -m "feat(content): character and kart descriptor schema and parsers"
```
