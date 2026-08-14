import { describe, expect, it } from 'vitest'
import { MIN_CHECKPOINTS, validateTrack } from '../src/track'
import { makeCircleTrack, makeOvalTrack, makeStraightTrack } from './fixtures/track-fixtures'

describe('validateTrack: control points and checkpoints', () => {
  it('accepts all three fixture tracks', () => {
    expect(validateTrack(makeStraightTrack())).toEqual([])
    expect(validateTrack(makeCircleTrack())).toEqual([])
    expect(validateTrack(makeOvalTrack())).toEqual([])
  })

  it('rejects fewer than 8 control points', () => {
    const base = makeStraightTrack()
    const tr = makeStraightTrack({ controlPoints: base.controlPoints.slice(0, 5) })
    expect(validateTrack(tr)).toEqual(['controlPoints: need at least 8, got 5'])
  })

  it('rejects a non-finite control point position', () => {
    const base = makeStraightTrack()
    const tr = makeStraightTrack({
      controlPoints: base.controlPoints.map((p, i) =>
        i === 4 ? { ...p, position: { x: NaN, y: 0, z: 0 } } : p,
      ),
    })
    expect(validateTrack(tr)).toEqual(['controlPoints[4].position: must be finite'])
  })

  it('rejects two coincident consecutive control points', () => {
    // control point 2 is already (300, 0, 0); moving 3 on top of it makes the pair (2, 3)
    // coincident, which would give the spline a zero-length segment
    const base = makeStraightTrack()
    const tr = makeStraightTrack({
      controlPoints: base.controlPoints.map((p, i) =>
        i === 3 ? { ...p, position: { x: 300, y: 0, z: 0 } } : p,
      ),
    })
    expect(validateTrack(tr)).toEqual(['controlPoints[2]: coincident with controlPoints[3]'])
  })

  it('treats the closing pair (last, first) as consecutive', () => {
    // last control point is (-140, 0, 60); moving it onto control point 0 at (0, 0, 0)
    // closes the loop with a zero-length segment
    const base = makeStraightTrack()
    const tr = makeStraightTrack({
      controlPoints: base.controlPoints.map((p, i) =>
        i === 11 ? { ...p, position: { x: 0, y: 0, z: 0 } } : p,
      ),
    })
    expect(validateTrack(tr)).toEqual(['controlPoints[11]: coincident with controlPoints[0]'])
  })

  it('rejects a non-positive width', () => {
    const base = makeStraightTrack()
    const tr = makeStraightTrack({
      controlPoints: base.controlPoints.map((p, i) => (i === 2 ? { ...p, width: 0 } : p)),
    })
    expect(validateTrack(tr)).toEqual([
      'controlPoints[2].width: must be positive and finite, got 0',
    ])
  })

  it('rejects an empty checkpoint ring', () => {
    expect(validateTrack(makeStraightTrack({ checkpointS: [] }))).toEqual([
      'checkpointS: need at least 2, got 0',
    ])
  })

  it('rejects a one-checkpoint ring, on which no lap can ever be credited', () => {
    // updateLaps (laps.ts) is `if (n < 2) return`. Lap credit is "entered the segment
    // after the one you hold", and with a single checkpoint the segment after the one
    // held is the one held, so the ring below is a track where every kart drives
    // forever at lap 0. The validator used to accept it: `checkpointS` was only
    // required to be non-empty, which one entry satisfies.
    expect(validateTrack(makeStraightTrack({ checkpointS: [0] }))).toEqual([
      'checkpointS: need at least 2, got 1',
    ])
    // ...and the same for a lone checkpoint that is not the start/finish line.
    expect(validateTrack(makeStraightTrack({ checkpointS: [0.5] }))).toEqual([
      'checkpointS: need at least 2, got 1',
    ])
  })

  it('accepts the smallest legal ring, which is two checkpoints', () => {
    expect(validateTrack(makeStraightTrack({ checkpointS: [0, 0.5] }))).toEqual([])
    expect(MIN_CHECKPOINTS).toBe(2)
  })

  it('rejects a non-ascending checkpoint ring', () => {
    expect(validateTrack(makeStraightTrack({ checkpointS: [0, 0.5, 0.5, 0.75] }))).toEqual([
      'checkpointS[2]: must be strictly ascending, got 0.5 after 0.5',
    ])
  })

  it('rejects a checkpoint outside 0..1', () => {
    expect(validateTrack(makeStraightTrack({ checkpointS: [0, 0.5, 1.4] }))).toEqual([
      'checkpointS[2]: must be within 0..1, got 1.4',
    ])
  })
})

describe('validateTrack: start grid', () => {
  it('rejects a grid that is not exactly MAX_KARTS entries', () => {
    const base = makeStraightTrack()
    const tr = makeStraightTrack({ startPositions: base.startPositions.slice(0, 7) })
    expect(validateTrack(tr)).toEqual(['startPositions: need exactly 8, got 7'])
  })

  it('rejects a start position outside 0..1', () => {
    const base = makeStraightTrack()
    const tr = makeStraightTrack({
      startPositions: base.startPositions.map((p, i) => (i === 3 ? { s: 1.2, lateral: 5 } : p)),
    })
    expect(validateTrack(tr)).toEqual(['startPositions[3].s: must be within 0..1, got 1.2'])
  })

  it('rejects a start position wider than the half-width', () => {
    // straight fixture is 20 m wide everywhere, so the half-width is exactly 10
    const base = makeStraightTrack()
    const tr = makeStraightTrack({
      startPositions: base.startPositions.map((p, i) => (i === 3 ? { s: p.s, lateral: 11 } : p)),
    })
    expect(validateTrack(tr)).toEqual([
      'startPositions[3].lateral: |11| exceeds half-width 10.000',
    ])
  })

  it('rejects two start positions closer than 2 * kart radius', () => {
    // slots 0 and 1 share s = 0.99, so their separation is purely lateral.
    // moving slot 1 from +5 to -3.5 leaves |-3.5 - -5| = 1.5, below 2 * 0.9 = 1.8
    const base = makeStraightTrack()
    const tr = makeStraightTrack({
      startPositions: base.startPositions.map((p, i) =>
        i === 1 ? { s: 0.99, lateral: -3.5 } : p,
      ),
    })
    expect(validateTrack(tr)).toEqual([
      'startPositions[0] and startPositions[1]: separation 1.500 is below 1.800',
    ])
  })

  it('measures separation along the track as well as across it', () => {
    // straight fixture control polygon is 1813.437 m round. Slots 0 and 1 are put on the
    // same lateral, ds apart: 0.0005 * 1813.437 = 0.907 m < 1.8, so this must be rejected,
    // and the reported separation is hypot(0.907, 0) = 0.907
    const base = makeStraightTrack()
    const tr = makeStraightTrack({
      startPositions: base.startPositions.map((p, i) =>
        i === 0 ? { s: 0.0095, lateral: 5 } : i === 1 ? { s: 0.01, lateral: 5 } : p,
      ),
    })
    expect(validateTrack(tr)).toEqual([
      'startPositions[0] and startPositions[1]: separation 0.907 is below 1.800',
    ])
  })

  it('keeps the oval start grid valid at 12 m minimum separation', () => {
    // oval slots pair up at the same s with lateral -6 and +6, so the tightest pair is 12 m
    expect(validateTrack(makeOvalTrack())).toEqual([])
  })
})

describe('validateTrack: props and bounds', () => {
  it('rejects an item box outside 0..1', () => {
    expect(validateTrack(makeStraightTrack({ itemBoxes: [{ s: 1.5, lateral: 0 }] }))).toEqual([
      'itemBoxes[0].s: must be within 0..1, got 1.5',
    ])
  })

  it('rejects an item box outside the half-width', () => {
    // straight fixture half-width is 10 everywhere
    expect(validateTrack(makeStraightTrack({ itemBoxes: [{ s: 0.3, lateral: 12 }] }))).toEqual([
      'itemBoxes[0].lateral: |12| exceeds half-width 10.000',
    ])
  })

  it('rejects a boost pad outside 0..1', () => {
    const tr = makeStraightTrack({ boostPads: [{ s: -0.1, lateral: 0, halfWidth: 3 }] })
    expect(validateTrack(tr)).toEqual(['boostPads[0].s: must be within 0..1, got -0.1'])
  })

  it('rejects a boost pad outside the half-width', () => {
    const tr = makeStraightTrack({ boostPads: [{ s: 0.6, lateral: -10.5, halfWidth: 3 }] })
    expect(validateTrack(tr)).toEqual([
      'boostPads[0].lateral: |-10.5| exceeds half-width 10.000',
    ])
  })

  it('rejects a ramp whose sStart is not before its sEnd', () => {
    const tr = makeStraightTrack({ ramps: [{ sStart: 0.5, sEnd: 0.4, launch: 6 }] })
    expect(validateTrack(tr)).toEqual(['ramps[0]: sStart 0.5 must be less than sEnd 0.4'])
  })

  it('rejects a ramp endpoint outside 0..1', () => {
    const tr = makeStraightTrack({ ramps: [{ sStart: -0.2, sEnd: 0.4, launch: 6 }] })
    expect(validateTrack(tr)).toEqual(['ramps[0].sStart: must be within 0..1, got -0.2'])
  })

  it('rejects bounds that do not enclose every control point', () => {
    // control point 11 sits at x = -140; a min.x of 0 leaves it outside
    const tr = makeStraightTrack({
      bounds: { min: { x: 0, y: -20, z: -40 }, max: { x: 800, y: 40, z: 160 } },
    })
    expect(validateTrack(tr)).toEqual(['bounds: does not enclose controlPoints[11]'])
  })

  it('accepts bounds that touch a control point exactly', () => {
    // control points span x in [-140, 740], z in [0, 120], y = 0
    const tr = makeStraightTrack({
      bounds: { min: { x: -140, y: 0, z: 0 }, max: { x: 740, y: 0, z: 120 } },
    })
    expect(validateTrack(tr)).toEqual([])
  })

  it('reports every independent failure at once', () => {
    const tr = makeStraightTrack({
      checkpointS: [],
      ramps: [{ sStart: 0.5, sEnd: 0.4, launch: 6 }],
      itemBoxes: [{ s: 1.5, lateral: 0 }],
    })
    expect(validateTrack(tr)).toEqual([
      'checkpointS: need at least 2, got 0',
      'itemBoxes[0].s: must be within 0..1, got 1.5',
      'ramps[0]: sStart 0.5 must be less than sEnd 0.4',
    ])
  })
})
