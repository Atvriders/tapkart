import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseCharacterDescriptor, parseKartDescriptor } from '../src/descriptors'
import type { CharacterDescriptor, KartDescriptor, PaletteRGB } from '../src/descriptors'
import { makeCharacterDescriptorJson, makeKartDescriptorJson } from './fixtures/descriptor-fixtures'

// [key, min, max]: the ranges the schema declares, hoisted so the "accepts at the
// bound" and "rejects outside the bound" tests can never drift apart.
const CHARACTER_RANGE_CASES: ReadonlyArray<readonly [string, number, number]> = [
  ['bodyHeight', 0.4, 1.4],
  ['bodyRadius', 0.15, 0.5],
  ['headRadius', 0.1, 0.4],
]

const KART_RANGE_CASES: ReadonlyArray<readonly [string, number, number]> = [
  ['chassisLength', 1.4, 2.6],
  ['chassisWidth', 0.9, 1.6],
  ['chassisHeight', 0.3, 0.8],
  ['wheelRadius', 0.2, 0.45],
  ['wheelWidth', 0.1, 0.35],
]

// A rejection test that asserts only "it threw" cannot tell which rule fired, and
// every issue lands in one collected message, so a parser that rejects everything
// for the wrong reason would satisfy a bare `.toThrow()` everywhere. Each rejection
// below therefore asserts the text of the specific rule it is about.
const rangeIssue = (key: string, min: number, max: number): string =>
  `${key} must be a finite number in [${min}, ${max}]`

// Two `[label, value]` columns rather than a bare list of values: `it.each` spreads
// any row that IS an array, so `it.each([null, undefined, 42, [], true])` would hand
// the `[]` row to the callback as zero arguments and silently re-test `undefined`,
// leaving "an array is not a JSON object" unasserted.
const NON_OBJECTS: ReadonlyArray<readonly [string, unknown]> = [
  ['null', null],
  ['undefined', undefined],
  ['a number', 42],
  ['a string', 'ash-vega'],
  ['an array', []],
  ['a boolean', true],
]

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
    expect(parsed).not.toBe(json)

    const palette = json['palette'] as Record<string, number[]>
    // Every slot is mutated IN PLACE, not just the first: a parser that copies two
    // of the three arrays and aliases the third is exactly the copy-paste slip an
    // unrolled reader invites, and checking only `primary` cannot see it.
    palette['primary'][0] = 0.01
    palette['secondary'][1] = 0.02
    palette['accent'][2] = 0.03
    // Replacing a whole slot additionally catches a parser that copied each array
    // but handed back the input's palette OBJECT.
    palette['secondary'] = [0.99, 0.99, 0.99]
    ;(json as Record<string, unknown>)['name'] = 'Overwritten'

    expect(parsed.palette.primary).toEqual([0.85, 0.16, 0.24])
    expect(parsed.palette.secondary).toEqual([0.1, 0.11, 0.16])
    expect(parsed.palette.accent).toEqual([1, 0.78, 0.2])
    expect(parsed.name).toBe('Ash Vega')
  })

  it.each(CHARACTER_RANGE_CASES)('accepts %s at both inclusive bounds', (key, min, max) => {
    expect(() => parseCharacterDescriptor(makeCharacterDescriptorJson({ [key]: min }))).not.toThrow()
    expect(() => parseCharacterDescriptor(makeCharacterDescriptorJson({ [key]: max }))).not.toThrow()
  })

  it.each(CHARACTER_RANGE_CASES)('rejects %s just outside both bounds', (key, min, max) => {
    // The rule text, not merely the key: the key alone also appears in a message
    // that lists the whole schema, so a parser that rejects for an unrelated reason
    // would pass `.toThrow(new RegExp(key))`. Naming the bounds pins the declared
    // range too, so a parser that guards the wrong interval cannot hide here.
    expect(() => parseCharacterDescriptor(makeCharacterDescriptorJson({ [key]: min - 1e-6 })))
      .toThrow(rangeIssue(key, min, max))
    expect(() => parseCharacterDescriptor(makeCharacterDescriptorJson({ [key]: max + 1e-6 })))
      .toThrow(rangeIssue(key, min, max))
  })

  it('accepts every silhouette the schema lists', () => {
    for (const silhouette of ['compact', 'tall', 'wide']) {
      const parsed = parseCharacterDescriptor(makeCharacterDescriptorJson({ silhouette }))
      expect(parsed.silhouette).toBe(silhouette)
    }
  })
})

describe('parseCharacterDescriptor rejects one mutated field at a time, naming it', () => {
  // [field, override, the rule that must fire]. The third column is what stops a
  // parser from passing this table by rejecting every record for the wrong reason.
  const cases: ReadonlyArray<readonly [string, Record<string, unknown>, string]> = [
    ['id', { id: 'Ash-Vega' }, 'id must be a lowercase hyphenated string'],
    ['id', { id: 'ash_vega' }, 'id must be a lowercase hyphenated string'],
    ['id', { id: '-ash' }, 'id must be a lowercase hyphenated string'],
    ['id', { id: 42 }, 'id must be a lowercase hyphenated string'],
    ['name', { name: '' }, 'name must be a non-empty string'],
    ['name', { name: '   ' }, 'name must be a non-empty string'],
    ['name', { name: 7 }, 'name must be a non-empty string'],
    ['bodyHeight', { bodyHeight: 2.2 }, rangeIssue('bodyHeight', 0.4, 1.4)],
    ['bodyHeight', { bodyHeight: Number.NaN }, rangeIssue('bodyHeight', 0.4, 1.4)],
    ['bodyHeight', { bodyHeight: '0.95' }, rangeIssue('bodyHeight', 0.4, 1.4)],
    ['bodyRadius', { bodyRadius: 0.01 }, rangeIssue('bodyRadius', 0.15, 0.5)],
    ['headRadius', { headRadius: Number.POSITIVE_INFINITY }, rangeIssue('headRadius', 0.1, 0.4)],
    ['silhouette', { silhouette: 'round' }, 'silhouette must be one of compact, tall, wide'],
    ['palette', { palette: null }, 'palette must be an object with keys primary, secondary, accent'],
    ['palette', { palette: [0.5, 0.5, 0.5] }, 'palette must be an object with keys primary, secondary, accent'],
  ]

  it.each(cases)('names %s given %j', (field, override, issue) => {
    const parse = (): CharacterDescriptor =>
      parseCharacterDescriptor(makeCharacterDescriptorJson(override))
    expect(parse).toThrow(new RegExp(`parseCharacterDescriptor: .*${field}`))
    expect(parse).toThrow(issue)
    // Every one of these records overwrites an existing key, so none introduces an
    // unknown one. A parser whose allow-list is missing a legitimate field would
    // still satisfy the two assertions above while rejecting valid content.
    expect(parse).not.toThrow(/is not a field of this schema/)
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

  // Unknown keys are rejected INSIDE palette as well, and nothing else in this file
  // reaches that check: delete the nested call and every other test still passes.
  it('rejects an unknown key inside palette rather than ignoring it', () => {
    const json = makeCharacterDescriptorJson()
    const palette = json['palette'] as Record<string, unknown>
    palette['tertiary'] = [0.1, 0.2, 0.3]
    expect(() => parseCharacterDescriptor(json))
      .toThrow(/palette\.tertiary is not a field of this schema/)
  })

  it('lists every broken field in one message', () => {
    let message = ''
    try {
      parseCharacterDescriptor(makeCharacterDescriptorJson({ id: 'Ash', bodyHeight: 9, silhouette: 'round' }))
    } catch (err) {
      message = (err as Error).message
    }
    expect(message).toContain('id must be a lowercase hyphenated string')
    expect(message).toContain(rangeIssue('bodyHeight', 0.4, 1.4))
    expect(message).toContain('silhouette must be one of compact, tall, wide')
    // The three fields that are FINE must not be named. Without this, a parser that
    // answers any violation by reciting the whole schema passes the three assertions
    // above, and "all issues, collected" would mean nothing.
    expect(message).not.toContain('name must be')
    expect(message).not.toContain('bodyRadius')
    expect(message).not.toContain('headRadius')
    expect(message).not.toContain('palette')
    // `parseX: a; b; c` -- exactly the three issues, neither first-failure nor padded.
    expect(message.split('; ')).toHaveLength(3)
  })

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

  it('copies rather than aliasing the input', () => {
    const json = makeKartDescriptorJson()
    const parsed = parseKartDescriptor(json)
    const palette = json['palette'] as Record<string, number[]>
    palette['body'][0] = 0.01
    palette['trim'][1] = 0.02
    palette['wheel'][2] = 0.03
    palette['trim'] = [0.99, 0.99, 0.99]
    expect(parsed.palette.body).toEqual([0.9, 0.35, 0.1])
    expect(parsed.palette.trim).toEqual([0.15, 0.15, 0.18])
    expect(parsed.palette.wheel).toEqual([0.05, 0.05, 0.06])
  })

  it.each(KART_RANGE_CASES)(
    'accepts %s at both inclusive bounds and rejects just outside them',
    (key, min, max) => {
      expect(() => parseKartDescriptor(makeKartDescriptorJson({ [key]: min }))).not.toThrow()
      expect(() => parseKartDescriptor(makeKartDescriptorJson({ [key]: max }))).not.toThrow()
      expect(() => parseKartDescriptor(makeKartDescriptorJson({ [key]: min - 1e-6 })))
        .toThrow(rangeIssue(key, min, max))
      expect(() => parseKartDescriptor(makeKartDescriptorJson({ [key]: max + 1e-6 })))
        .toThrow(rangeIssue(key, min, max))
    },
  )

  it.each(['body', 'trim', 'wheel'])('names palette.%s when a component is out of 0..1', (slot) => {
    const json = makeKartDescriptorJson()
    const palette = json['palette'] as Record<string, unknown>
    palette[slot] = [0.5, 0.5, -0.001]
    expect(() => parseKartDescriptor(json)).toThrow(new RegExp(`palette\\.${slot}\\[2\\]`))
  })

  it('rejects a character record, which has neither the kart fields nor only kart fields', () => {
    let message = ''
    try {
      parseKartDescriptor(makeCharacterDescriptorJson())
    } catch (err) {
      message = (err as Error).message
    }
    // Named rules, not just "it threw": this record is wrong in three distinct ways
    // and each one has to be reported, at the top level and inside palette alike.
    expect(message).toMatch(/^parseKartDescriptor: /)
    expect(message).toContain('bodyHeight is not a field of this schema')
    expect(message).toContain('silhouette is not a field of this schema')
    expect(message).toContain('palette.primary is not a field of this schema')
    expect(message).toContain(rangeIssue('chassisLength', 1.4, 2.6))
    expect(message).toContain('palette.body must be an array of exactly 3 numbers')
  })

  // The kart parser rejects non-objects at its own call site, with its own hard-coded
  // name in the message; the character table above cannot see a copy-paste there.
  it.each(NON_OBJECTS)('rejects %s, which is not a JSON object', (_label, value) => {
    expect(() => parseKartDescriptor(value)).toThrow(/parseKartDescriptor: expected a JSON object/)
  })

  it('hands back a PaletteRGB that is a readonly triple', () => {
    const parsed = parseKartDescriptor(makeKartDescriptorJson())
    const body: PaletteRGB = parsed.palette.body
    expect(body).toHaveLength(3)

    // The assignment above is NOT the readonly assertion -- it succeeds just as
    // happily if PaletteRGB is widened to a mutable [number, number, number]. Only
    // an attempted write can tell the two apart: if PaletteRGB ever loses `readonly`,
    // tsc fails here with TS2578 "Unused '@ts-expect-error' directive".
    // @ts-expect-error PaletteRGB is readonly: its components cannot be assigned
    parsed.palette.body[0] = 0.5
  })
})

// "Consumes: nothing" is a contract line with real consequences: this module has to
// stay DOM-free, and the delegated batch's gate is built by esbuild-bundling these
// two functions. Nothing else in the suite would notice an import appearing.
describe('the schema depends on nothing', () => {
  const source = readFileSync(new URL('../src/descriptors.ts', import.meta.url), 'utf8')

  it('imports no other module, from sim or anywhere else', () => {
    expect(source).not.toMatch(/^import\b/m)
    expect(source).not.toMatch(/\bimport\s*\(/)
    expect(source).not.toMatch(/\brequire\s*\(/)
  })
})
