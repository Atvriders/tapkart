import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { allocStateLike, buildTrackQuery, createState, makeIntentBuffer, step } from '@tapkart/sim'
import type { AuthEvent, CharacterStats, SimContext, Tuning } from '@tapkart/sim'
import { CHARACTERS, TUNING } from '../src/tuning'
import { makeCharacters, makeOvalTrack, makeTuning } from '../../sim/test/fixtures/track-fixtures'

const SCALAR_TUNING_KEYS = [
  'maxSpeed', 'accelRate', 'brakeRate', 'steerRateBase', 'steerSpeedFalloff',
  'gripTarmac', 'gripDirt', 'gripDrift', 'gravity', 'airYaw', 'offtrackSpeedMul',
  'respawnTicks', 'invulnTicks', 'spinOutTicks', 'driftMinSpeed', 'boostSpeedMul',
  'surgeSpeedMul', 'kartRadius', 'kartRestitution', 'itemBoxRespawnTicks',
  'seekerSpeed', 'boltSpeed', 'entityTtl',
] as const satisfies readonly (keyof Tuning)[]

// Typed `keyof Tuning`, not `string`: a misspelt tuple name here would otherwise
// make the key-set test demand a field neither object has, and "both sides fail
// identically" is the failure mode this whole file exists to rule out.
const ALL_TUNING_KEYS: readonly (keyof Tuning)[] = [
  ...SCALAR_TUNING_KEYS,
  'driftTiers',
  'driftBoosts',
]

const CHARACTER_FIELDS = ['id', 'name', 'speed', 'accel', 'handling', 'weight'] as const satisfies
  readonly (keyof CharacterStats)[]

describe('TUNING equals makeTuning() field by field', () => {
  const fixture = makeTuning()

  // Both objects are compared against the hard-coded list, never against each
  // other's keys. Iterating the keys of TUNING could not see a field the fixture
  // has and the shipped table lacks; iterating the fixture's could not see the
  // reverse. The list sees both, and sees a field missing from both as well.
  it('declares exactly the 25 fields of Tuning, no more and no fewer', () => {
    expect(ALL_TUNING_KEYS).toHaveLength(25)
    expect(Object.keys(TUNING).sort()).toEqual([...ALL_TUNING_KEYS].sort())
    expect(Object.keys(fixture).sort()).toEqual([...ALL_TUNING_KEYS].sort())
  })

  it.each(SCALAR_TUNING_KEYS)('%s', (key) => {
    expect(TUNING[key]).toBe(fixture[key])
  })

  it('driftTiers', () => {
    expect(TUNING.driftTiers).toHaveLength(3)
    expect(fixture.driftTiers).toHaveLength(3)
    for (let i = 0; i < 3; i++) expect(TUNING.driftTiers[i]).toBe(fixture.driftTiers[i])
  })

  it('driftBoosts', () => {
    expect(TUNING.driftBoosts).toHaveLength(3)
    expect(fixture.driftBoosts).toHaveLength(3)
    for (let i = 0; i < 3; i++) expect(TUNING.driftBoosts[i]).toBe(fixture.driftBoosts[i])
  })
})

describe('CHARACTERS equals makeCharacters() field by field', () => {
  const fixture = makeCharacters()

  it('ships exactly 8 characters', () => {
    expect(CHARACTERS).toHaveLength(8)
    expect(fixture).toHaveLength(8)
  })

  for (let i = 0; i < 8; i++) {
    it(`CHARACTERS[${i}] has exactly the 6 CharacterStats fields`, () => {
      // Both rows against the fixed list, for the same reason the tuning key-set
      // test checks both: checking only the shipped row would miss a field the
      // fixture row has and the shipped row does not.
      expect(Object.keys(CHARACTERS[i]).sort()).toEqual([...CHARACTER_FIELDS].sort())
      expect(Object.keys(fixture[i]).sort()).toEqual([...CHARACTER_FIELDS].sort())
    })
    it.each(CHARACTER_FIELDS)(`CHARACTERS[${i}].%s`, (field) => {
      expect(CHARACTERS[i][field]).toBe(fixture[i][field])
    })
  }
})

describe('the shipped table is a literal, not the fixture wearing a hat', () => {
  const source = readFileSync(new URL('../src/tuning.ts', import.meta.url), 'utf8')

  it('never imports the sim test fixtures', () => {
    expect(source).not.toContain('track-fixtures')
    expect(source).not.toContain('/test/')
    // A static `import` is not the only way to reach a value at module scope, and
    // the two checks above only cover the fixture path spelled literally.
    expect(source).not.toMatch(/\bimport\s*\(/)
    expect(source).not.toMatch(/\brequire\s*\(/)
  })

  it('has exactly one import, and it is type-only', () => {
    const imports = source.match(/^import .*$/gm) ?? []
    expect(imports).toEqual(["import type { CharacterStats, Tuning } from '@tapkart/sim'"])
  })
})

describe('the shipped content drives the real simulation', () => {
  it('composes into a SimContext that createState and step accept', () => {
    const track = makeOvalTrack()
    const ctx: SimContext = {
      track,
      query: buildTrackQuery(track),
      tuning: TUNING,
      characters: CHARACTERS.slice(),
      isLeader: true,
    }
    const prev = createState(ctx, 0xc0ffee, [0, 1, 2, 3, 4, 5, 6, 7])
    expect(prev.karts.map((k) => k.characterIdx)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])

    const next = allocStateLike(ctx, prev)
    const events: AuthEvent[] = []
    step(ctx, prev, next, makeIntentBuffer(), events)
    expect(next.tick).toBe(1)
  })

  // The composition above uses `.slice()`; on its own that proves only that a copy
  // works, not that a copy is REQUIRED. If CHARACTERS were ever widened to a
  // mutable CharacterStats[], every other test in this file would still pass and
  // later tasks -- including Plan 4's server -- would alias shipped data into a
  // mutable SimContext field. This test is what makes the seam fail loudly.
  it('assigns TUNING directly but forces CHARACTERS to be copied', () => {
    // No directive on this line, and that IS the assertion: TypeScript ignores
    // readonly PROPERTY modifiers in assignability, so Readonly<Tuning> satisfies
    // Tuning with no ceremony. The asymmetry with the array below is the trap.
    const tuning: SimContext['tuning'] = TUNING
    expect(tuning).toBe(TUNING)

    // A readonly ARRAY is a different rule and must NOT assign. If it ever does,
    // tsc fails here with TS2578 "Unused '@ts-expect-error' directive".
    // @ts-expect-error readonly CharacterStats[] is not assignable to CharacterStats[]
    const aliased: SimContext['characters'] = CHARACTERS
    expect(aliased).toBe(CHARACTERS)

    const copied: SimContext['characters'] = CHARACTERS.slice()
    expect(copied).not.toBe(CHARACTERS)
    expect(copied).toEqual([...CHARACTERS])
  })
})
