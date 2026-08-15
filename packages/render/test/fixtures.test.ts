import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { validateTrack } from '@tapkart/sim'

import { viewSourceViolations } from '../src/types'
import {
  SHIPPED_TRACK_IDS,
  loadShippedTrack,
  makeCharacterDescriptorFixture,
  makeKartDescriptorFixture,
  makeKartView,
  makeRaceView,
  makeRenderContext,
  makeThemeFixture,
} from './fixtures/render-fixtures'

// derived here independently of the fixture, so the two cannot drift together
const TRACKS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'content', 'tracks')

describe('render fixtures', () => {
  // Q34: the six shipped tracks are REQUIRED coverage, and every mesh test is an
  // `it.each(SHIPPED_TRACK_IDS)`. If this list were empty — or derived from a
  // directory read that silently found nothing — those suites would run zero cases
  // and report green. This is the assertion that stops that.
  it('SHIPPED_TRACK_IDS is exactly the six files in content/tracks, ascending', () => {
    const onDisk = readdirSync(TRACKS_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -'.json'.length))
      .sort()
    expect(SHIPPED_TRACK_IDS.length).toBe(6)
    expect([...SHIPPED_TRACK_IDS]).toEqual(onDisk)
    expect([...SHIPPED_TRACK_IDS]).toEqual([
      'caldera',
      'dust-canyon',
      'glacier-pass',
      'harbor-run',
      'neon-district',
      'redwood-rise',
    ])
  })

  // `const ids: readonly string[] = SHIPPED_TRACK_IDS` would assert nothing: a widened
  // `string[]` assigns to it happily. A WRITE is the only thing the compiler must reject,
  // so if the declared type ever widens, this directive becomes unused and `tsc` fails
  // the package with TS2578 rather than the suite quietly staying green. `mutate` is
  // never invoked — `readonly` is erased at runtime, so calling it would really mutate
  // the shared array and poison every other test in the file.
  it('declares SHIPPED_TRACK_IDS readonly, so no test can reorder it under another', () => {
    const mutate = (): void => {
      // @ts-expect-error readonly string[]: element assignment must not type-check
      SHIPPED_TRACK_IDS[0] = 'mutated'
    }
    expect(typeof mutate).toBe('function')
    expect(SHIPPED_TRACK_IDS[0]).toBe('caldera')
  })

  it.each([...SHIPPED_TRACK_IDS])('loadShippedTrack(%s) returns a valid, non-trivial Track', (id) => {
    const track = loadShippedTrack(id)
    expect(track.id).toBe(id)
    expect(validateTrack(track)).toEqual([])
    expect(track.controlPoints.length).toBeGreaterThanOrEqual(46)
    expect(track.startPositions.length).toBe(8)
    expect(track.checkpointS.length).toBeGreaterThanOrEqual(10)
  })

  it('loadShippedTrack throws on an unknown id rather than returning a husk', () => {
    expect(() => loadShippedTrack('no-such-track')).toThrow()
  })

  it('makeRenderContext gives a usable SimContext', () => {
    const ctx = makeRenderContext()
    expect(ctx.track.controlPoints.length).toBeGreaterThan(8)
    expect(ctx.characters.length).toBe(8)
    expect(ctx.query.totalLength()).toBeGreaterThan(100)
  })

  it('makeKartView applies overrides and still allocates fresh vectors', () => {
    const a = makeKartView({ playerId: 4, heading: 1.25 })
    const b = makeKartView()
    expect(a.playerId).toBe(4)
    expect(a.heading).toBe(1.25)
    a.position.x = 12
    expect(b.position.x).toBe(0)
  })

  it('makeRaceView is a filled, legal host view', () => {
    const v = makeRaceView()
    expect(v.karts.length).toBe(8)
    expect(v.karts.every((k) => k.source === 'authoritative')).toBe(true)
    expect(v.phase).toBe('racing')
    // the word "legal" in this test's name is otherwise unchecked: the assertion above
    // covers the eight kart sources and says nothing about the 32 entity slots or
    // entityCount, which is exactly where a later task filling this fixture with live
    // entities would break it. Run the rule instead of restating a corner of it.
    expect(viewSourceViolations(v, 'host')).toEqual([])
    const w = makeRaceView({ phase: 'finished', tick: 99 })
    expect(w.phase).toBe('finished')
    expect(w.tick).toBe(99)
  })

  it('descriptor and theme fixtures sit inside their declared ranges', () => {
    const c = makeCharacterDescriptorFixture()
    expect(c.bodyHeight).toBeGreaterThanOrEqual(0.4)
    expect(c.bodyHeight).toBeLessThanOrEqual(1.4)
    expect(c.bodyRadius).toBeGreaterThanOrEqual(0.15)
    expect(c.bodyRadius).toBeLessThanOrEqual(0.5)
    expect(c.headRadius).toBeGreaterThanOrEqual(0.1)
    expect(c.headRadius).toBeLessThanOrEqual(0.4)
    const k = makeKartDescriptorFixture()
    expect(k.chassisLength).toBeGreaterThanOrEqual(1.4)
    expect(k.chassisLength).toBeLessThanOrEqual(2.6)
    expect(k.chassisWidth).toBeGreaterThanOrEqual(0.9)
    expect(k.chassisWidth).toBeLessThanOrEqual(1.6)
    expect(k.wheelRadius).toBeGreaterThanOrEqual(0.2)
    expect(k.wheelRadius).toBeLessThanOrEqual(0.45)
    const t = makeThemeFixture()
    const d = t.sunDirection
    expect(Math.abs(Math.hypot(d.x, d.y, d.z) - 1)).toBeLessThan(1e-6)
    expect(t.fog.near).toBeLessThan(t.fog.far)
    expect(t.edgeMarkers.spacing).toBeGreaterThanOrEqual(4)
    expect(t.edgeMarkers.spacing).toBeLessThanOrEqual(40)
    // the three road colours must differ, or the mesh tint test proves nothing
    expect(t.road).not.toEqual(t.roadDirt)
    expect(t.road).not.toEqual(t.shoulder)
    expect(t.roadDirt).not.toEqual(t.shoulder)
  })
})
