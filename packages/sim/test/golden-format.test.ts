import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import type { Intent } from '../src/types'
import { MAX_KARTS } from '../src/types'
import type { GoldenFixture } from './fixtures/golden-format'
import {
  B64_LINE_LENGTH,
  GOLDEN_CHARACTER_IDX,
  GOLDEN_FORMAT_VERSION,
  GOLDEN_PATH,
  GOLDEN_REGEN_COMMAND,
  GOLDEN_SEED,
  GOLDEN_TOL,
  INTENT_BYTES_PER_KART,
  INTENT_SCALE,
  MAX_GOLDEN_TICKS,
  assertRegenerationAllowed,
  decodeB64Lines,
  encodeB64Lines,
  loadGoldenFixture,
  normZero,
  packIntents,
  quantizeIntent,
  saveGoldenFixture,
  unpackIntents,
} from './fixtures/golden-format'

function intent(tick: number, steer: number, accel: number, flags: number): Intent {
  return {
    tick,
    steer,
    accel,
    brake: (flags & 1) !== 0,
    drift: (flags & 2) !== 0,
    useItem: (flags & 4) !== 0,
  }
}

describe('golden fixture constants', () => {
  it('pins the values the fixture and the tests are written against', () => {
    expect(GOLDEN_FORMAT_VERSION).toBe(1)
    expect(GOLDEN_SEED).toBe(20260813)
    expect(GOLDEN_CHARACTER_IDX).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    expect(GOLDEN_CHARACTER_IDX).toHaveLength(MAX_KARTS)
    expect(INTENT_SCALE).toBe(10000)
    expect(INTENT_BYTES_PER_KART).toBe(5) // int16 steer + int16 accel + uint8 flags
    expect(B64_LINE_LENGTH).toBe(120)
    expect(MAX_GOLDEN_TICKS).toBe(18000) // 5 minutes at 60Hz; a runaway guard, not a target
    expect(GOLDEN_PATH.endsWith('golden-oval-3lap-8bot.json')).toBe(true)
    expect(GOLDEN_REGEN_COMMAND).toBe(
      'UPDATE_GOLDEN=1 npx vitest run packages/sim/test/golden-regen.test.ts',
    )
  })

  it('states a tolerance for every continuous field and nothing else', () => {
    expect(GOLDEN_TOL.position).toBe(1e-6)
    expect(GOLDEN_TOL.velocity).toBe(1e-6)
    expect(GOLDEN_TOL.heading).toBe(1e-7)
    expect(GOLDEN_TOL.angularVelocity).toBe(1e-7)
    expect(GOLDEN_TOL.driftCharge).toBe(1e-6)
    expect(GOLDEN_TOL.lapT).toBe(1e-9)
    expect(Object.keys(GOLDEN_TOL).sort()).toEqual([
      'angularVelocity',
      'driftCharge',
      'heading',
      'lapT',
      'position',
      'velocity',
    ])
  })
})

describe('normZero', () => {
  it('maps -0 to +0 and leaves everything else alone', () => {
    expect(Object.is(normZero(-0), 0)).toBe(true)
    expect(Object.is(normZero(0), 0)).toBe(true)
    expect(normZero(-1.5)).toBe(-1.5)
    expect(Number.isNaN(normZero(Number.NaN))).toBe(true)
  })
})

describe('quantizeIntent', () => {
  it('rounds steer and accel to 1/10000 and stamps the tick', () => {
    // 0.123456789 * 10000 = 1234.56789 -> round -> 1235 -> /10000 = 0.1235
    const q = quantizeIntent(intent(0, 0.123456789, 0.5, 0), 7)
    expect(q.tick).toBe(7)
    expect(q.steer).toBe(0.1235)
    expect(q.accel).toBe(0.5)
    expect(q.brake).toBe(false)
    expect(q.drift).toBe(false)
    expect(q.useItem).toBe(false)
  })

  it('clamps steer to -1..1 and accel to 0..1', () => {
    expect(quantizeIntent(intent(0, -1.7, 2.3, 0), 1).steer).toBe(-1)
    expect(quantizeIntent(intent(0, 1.7, 2.3, 0), 1).steer).toBe(1)
    expect(quantizeIntent(intent(0, 0, 2.3, 0), 1).accel).toBe(1)
    expect(quantizeIntent(intent(0, 0, -0.4, 0), 1).accel).toBe(0)
  })

  it('never produces -0, because JSON cannot represent it', () => {
    // -0.00004 * 10000 = -0.4 ; Math.round(-0.4) is -0 in JS
    const q = quantizeIntent(intent(0, -0.00004, 0, 0), 2)
    expect(Object.is(q.steer, 0)).toBe(true)
  })

  it('carries the three booleans through unchanged', () => {
    const q = quantizeIntent(intent(0, 0, 1, 7), 3)
    expect(q.brake).toBe(true)
    expect(q.drift).toBe(true)
    expect(q.useItem).toBe(true)
  })

  it('refuses a non-finite intent instead of silently storing 0', () => {
    expect(() => quantizeIntent(intent(0, Number.NaN, 1, 0), 3)).toThrow(
      'golden: non-finite intent at tick 3: steer=NaN accel=1',
    )
  })
})

describe('intent packing', () => {
  it('round-trips a two-tick stream byte-for-byte', () => {
    const rows: Intent[][] = []
    for (let t = 0; t < 2; t++) {
      const row: Intent[] = []
      for (let i = 0; i < MAX_KARTS; i++) {
        // steer (i-4)/8 spans -0.5..0.375, accel i/8 spans 0..0.875 - all exact at 1/10000
        row.push(quantizeIntent(intent(t, (i - 4) / 8, i / 8, i % 8), t))
      }
      rows.push(row)
    }

    const bytes = packIntents(rows)
    expect(bytes.length).toBe(2 * MAX_KARTS * INTENT_BYTES_PER_KART) // 2 * 8 * 5 = 80

    const back = unpackIntents(bytes, 2)
    expect(back).toEqual(rows)
    expect(back[1][7].steer).toBe(0.375)
    expect(back[1][7].accel).toBe(0.875)
    expect(back[1][7].brake).toBe(true)
    expect(back[1][7].drift).toBe(true)
    expect(back[1][7].useItem).toBe(true)
  })

  it('refuses a stream whose length does not match the tick count', () => {
    const bytes = new Uint8Array(3 * MAX_KARTS * INTENT_BYTES_PER_KART)
    expect(() => unpackIntents(bytes, 2)).toThrow(
      'golden: intent stream is 120 bytes, expected 80 for 2 ticks',
    )
  })
})

describe('base64 chunking', () => {
  it('emits one short line for a three-byte payload', () => {
    const lines = encodeB64Lines(new Uint8Array([0, 1, 2]))
    expect(lines).toEqual(['AAEC'])
    expect(Array.from(decodeB64Lines(lines))).toEqual([0, 1, 2])
  })

  it('splits into 120-character lines so the fixture stays diffable', () => {
    const bytes = new Uint8Array(200)
    for (let i = 0; i < 200; i++) bytes[i] = (i * 7) & 0xff
    // 200 bytes -> ceil(200/3) = 67 base64 quads -> 268 chars -> 120 + 120 + 28
    const lines = encodeB64Lines(bytes)
    expect(lines.map((l) => l.length)).toEqual([120, 120, 28])
    expect(Array.from(decodeB64Lines(lines))).toEqual(Array.from(bytes))
  })
})

describe('assertRegenerationAllowed', () => {
  it('refuses when CI is set, and says exactly why', () => {
    expect(() => assertRegenerationAllowed({ CI: 'true' })).toThrow(
      'golden: refusing to regenerate because CI=true. A regenerated golden fixture is a claim ' +
        'that a physics change was intentional; it must be produced on a developer machine and ' +
        'reviewed in the diff. Unset CI to proceed.',
    )
  })

  it('refuses on the other CI markers too', () => {
    expect(() => assertRegenerationAllowed({ GITHUB_ACTIONS: 'true' })).toThrow(
      /refusing to regenerate because GITHUB_ACTIONS=true/,
    )
    expect(() => assertRegenerationAllowed({ CONTINUOUS_INTEGRATION: '1' })).toThrow(
      /refusing to regenerate because CONTINUOUS_INTEGRATION=1/,
    )
  })

  it('allows a developer machine, including the explicitly-negative forms', () => {
    expect(() => assertRegenerationAllowed({})).not.toThrow()
    expect(() => assertRegenerationAllowed({ CI: '' })).not.toThrow()
    expect(() => assertRegenerationAllowed({ CI: '0' })).not.toThrow()
    expect(() => assertRegenerationAllowed({ CI: 'false' })).not.toThrow()
    expect(() => assertRegenerationAllowed({ CI: 'FALSE' })).not.toThrow()
    expect(() => assertRegenerationAllowed({ CI: undefined })).not.toThrow()
  })
})

describe('fixture io', () => {
  it('rejects a fixture written by a different format version', () => {
    const p = join(tmpdir(), 'tapkart-golden-version.json')
    saveGoldenFixture({ formatVersion: 999 } as unknown as GoldenFixture, p)
    expect(() => loadGoldenFixture(p)).toThrow('golden: fixture formatVersion 999, this build expects 1')
  })
})
