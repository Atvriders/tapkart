import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { buildTrackQuery } from '@tapkart/sim'
import type { Track, TrackQuery } from '@tapkart/sim'

/**
 * A track whose centreline turns tighter than its own half-width FOLDS: the inner
 * edge of the drivable surface crosses itself, so two `s` values map to one world
 * point and `query.project()` becomes ambiguous there.
 *
 * That is not cosmetic. `project()` feeds lap counting, checkpoint order and
 * respawn — a kart on the inner third of such a corner is placed metres away from
 * where it is.
 *
 * `validateTrack` does not gate this: it checks the checkpoint ring, the spline's
 * closure and the bounds, none of which notice a radius smaller than a width. The
 * shipped `glacier-pass` carried an 8.4 m hairpin under a 21 m road for the whole
 * of Plan 3 — 2.4 m of drivable surface folded, `project()` off by up to 6.22 m of
 * arc — and every test in the repository stayed green. This is the test that would
 * have caught it.
 *
 * Q34: read the real shipped files off disk, so this is evidence about content
 * rather than about a fixture.
 */
const TRACKS_DIR = fileURLToPath(new URL('../../../content/tracks/', import.meta.url))
const POOL_DIR = fileURLToPath(new URL('../../../content/tracks-pool/', import.meta.url))

/** Metres between the three samples used to estimate curvature. */
const SAMPLE_SPACING_M = 0.5
const SAMPLES = 6000

interface Worst {
  minRadius: number
  halfWidth: number
  margin: number
  s: number
}

const wrap = (x: number): number => ((x % 1) + 1) % 1

/**
 * `sampleAt` returns a POOLED object — the same reference on every call, per this
 * package's no-allocation-in-hot-paths discipline. Copying out is not defensive
 * style, it is required: reading three samples without it yields three views of
 * the last one, every curvature comes out as zero, and the whole check silently
 * measures nothing.
 */
function snap(q: TrackQuery, s: number): { x: number; z: number; w: number } {
  const a = q.sampleAt(wrap(s))
  return { x: a.position.x, z: a.position.z, w: a.width }
}

/** The tightest (radius − half-width) margin anywhere on the centreline. */
export function worstFoldMargin(track: Track): Worst {
  const q = buildTrackQuery(track)
  const ds = SAMPLE_SPACING_M / q.totalLength()
  let worst: Worst | null = null

  for (let i = 0; i < SAMPLES; i++) {
    const s = i / SAMPLES
    const p0 = snap(q, s - ds)
    const p1 = snap(q, s)
    const p2 = snap(q, s + ds)
    const ax = p1.x - p0.x
    const az = p1.z - p0.z
    const bx = p2.x - p1.x
    const bz = p2.z - p1.z
    const la = Math.hypot(ax, az)
    const lb = Math.hypot(bx, bz)
    if (la < 1e-9 || lb < 1e-9) continue
    const dTheta = Math.asin(Math.min(1, Math.abs(ax * bz - az * bx) / (la * lb)))
    if (dTheta < 1e-9) continue

    const minRadius = (la + lb) / 2 / dTheta
    const halfWidth = p1.w / 2
    const margin = minRadius - halfWidth
    if (worst === null || margin < worst.margin) worst = { minRadius, halfWidth, margin, s }
  }

  if (worst === null) throw new Error('worstFoldMargin: no curvature sample was taken')
  return worst
}

function trackFilesIn(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
}

function load(dir: string, file: string): Track {
  return JSON.parse(readFileSync(dir + file, 'utf8')) as Track
}

describe('no shipped track folds its own drivable surface', () => {
  const shipped = trackFilesIn(TRACKS_DIR)

  // A readdir that comes back empty makes every it.each below vacuously green.
  it('reads all six shipped tracks off disk', () => {
    expect(shipped).toHaveLength(6)
  })

  it.each(shipped.map((f) => [f.slice(0, -5), f] as const))(
    '%s turns wider than its own half-width everywhere',
    (_id, file) => {
      const worst = worstFoldMargin(load(TRACKS_DIR, file))
      expect(worst.margin).toBeGreaterThan(0)
    },
  )

  const pool = trackFilesIn(POOL_DIR)

  it('reads all twelve reserve tracks off disk', () => {
    expect(pool).toHaveLength(12)
  })

  // The reserve pool is gated too: a track promoted out of it later must already
  // be sound, rather than inheriting the defect glacier-pass shipped with.
  it.each(pool.map((f) => [f.slice(0, -5), f] as const))(
    'reserve %s turns wider than its own half-width everywhere',
    (_id, file) => {
      const worst = worstFoldMargin(load(POOL_DIR, file))
      expect(worst.margin).toBeGreaterThan(0)
    },
  )
})

describe('the fold check discriminates', () => {
  /**
   * The positive control, and the reason this file is not decoration.
   *
   * This is `glacier-pass` as it actually shipped — the three hairpin control
   * points still 21 m wide. If the check cannot fail against the geometry that
   * provably folded, it cannot catch the next one either. Every other value in
   * the track is the live file's, so this stays honest if the track is edited.
   */
  function asShipped(): Track {
    const track = load(TRACKS_DIR, 'glacier-pass.json')
    for (const i of [44, 45, 46]) track.controlPoints[i].width = 21
    return track
  }

  it('fails against the hairpin as it originally shipped', () => {
    const worst = worstFoldMargin(asShipped())
    expect(worst.margin).toBeLessThan(0)
    // Pin the geometry too, so a future edit that moves the hairpin makes this
    // control stop describing the defect rather than silently still passing.
    expect(worst.minRadius).toBeLessThan(9)
    expect(worst.halfWidth).toBeCloseTo(10.5, 6)
  })

  it('passes against the same hairpin once narrowed', () => {
    const worst = worstFoldMargin(load(TRACKS_DIR, 'glacier-pass.json'))
    expect(worst.margin).toBeGreaterThan(0)
    expect(worst.minRadius).toBeCloseTo(worstFoldMargin(asShipped()).minRadius, 6)
  })
})
