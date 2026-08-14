import { describe, expect, it } from 'vitest'
import type { TrackProjection } from '../src/types'
import { v3 } from '../src/vec3'
import {
  arcAt,
  bankingAtSeg,
  buildArcTable,
  buildTrackQuery,
  catmullRom,
  locateS,
  projectPoint,
  SAMPLES_PER_SEGMENT,
  splinePointAt,
  splineTangentAt,
  surfaceOfSeg,
  widthAtSeg,
} from '../src/track'
import {
  makeCircleTrack,
  makeContext,
  makeOvalTrack,
  makeStraightTrack,
} from './fixtures/track-fixtures'

describe('spline core', () => {
  it('catmullRom interpolates p1..p2 and hits both ends exactly', () => {
    // p0=0 p1=0 p2=1 p3=1: u=0 -> p1, u=1 -> p2, u=0.5 -> the symmetric midpoint
    expect(catmullRom(0, 0, 1, 1, 0)).toBe(0)
    expect(catmullRom(0, 0, 1, 1, 1)).toBe(1)
    expect(catmullRom(0, 0, 1, 1, 0.5)).toBe(0.5)
  })

  it('splinePointAt returns the control point itself at integer t', () => {
    const tr = makeStraightTrack()
    const out = v3(0, 0, 0)
    splinePointAt(tr, 0, out)
    expect(out).toEqual({ x: 0, y: 0, z: 0 })
    splinePointAt(tr, 2, out)
    expect(out).toEqual({ x: 300, y: 0, z: 0 })
    splinePointAt(tr, 8, out)
    expect(out).toEqual({ x: 600, y: 0, z: 120 })
  })

  it('splinePointAt is exactly linear across evenly spaced collinear control points', () => {
    // segment 2 spans control points 2 (x=300) and 3 (x=450) and its window is
    // control points 1,2,3,4 = x 150,300,450,600 at z=0, all collinear and evenly
    // spaced, so the Catmull-Rom cubic degenerates to the straight midpoint 375
    const tr = makeStraightTrack()
    const out = v3(0, 0, 0)
    splinePointAt(tr, 2.5, out)
    expect(out).toEqual({ x: 375, y: 0, z: 0 })
  })

  it('splinePointAt wraps t around the closed loop', () => {
    // t = -0.5 is the same place as t = 11.5 on a 12-control-point loop
    const tr = makeStraightTrack()
    const a = v3(0, 0, 0)
    const b = v3(0, 0, 0)
    splinePointAt(tr, 11.5, a)
    splinePointAt(tr, -0.5, b)
    expect(a).toEqual({ x: -88.125, y: 0, z: 26.25 })
    expect(b).toEqual(a)
  })

  it('splineTangentAt returns a unit tangent, +X on the straight', () => {
    const tr = makeStraightTrack()
    const out = v3(0, 0, 0)
    splineTangentAt(tr, 2, out)
    expect(out).toEqual({ x: 1, y: 0, z: 0 })
    splineTangentAt(tr, 6, out)
    expect(Math.hypot(out.x, out.y, out.z)).toBeCloseTo(1, 12)
  })

  it('widthAtSeg and bankingAtSeg interpolate linearly between control points', () => {
    // oval control point 4 is 24 m wide and flat, control point 5 is 20 m wide banked 0.2
    const tr = makeOvalTrack()
    expect(widthAtSeg(tr, 4)).toBe(24)
    expect(widthAtSeg(tr, 4.5)).toBe(22) // (24 + 20) / 2
    expect(widthAtSeg(tr, 5)).toBe(20)
    expect(bankingAtSeg(tr, 4.5)).toBe(0.1) // (0 + 0.2) / 2
    // control points 6 and 7 are both banked 0.2, so the whole segment is 0.2
    expect(bankingAtSeg(tr, 6.25)).toBe(0.2)
  })

  it('surfaceOfSeg takes the surface of the segment start control point', () => {
    // oval control points 12 and 13 are dirt, so segments 12 and 13 are dirt
    const tr = makeOvalTrack()
    expect(surfaceOfSeg(tr, 11.9)).toBe('tarmac')
    expect(surfaceOfSeg(tr, 12.5)).toBe('dirt')
    expect(surfaceOfSeg(tr, 13.5)).toBe('dirt')
    expect(surfaceOfSeg(tr, 14)).toBe('tarmac')
  })
})

describe('arc-length table', () => {
  it('samples every segment and accumulates a monotonic length', () => {
    const tr = makeCircleTrack()
    const table = buildArcTable(tr)
    expect(table.segments).toBe(16)
    expect(table.samplesPerSegment).toBe(SAMPLES_PER_SEGMENT)
    expect(table.cum.length).toBe(16 * 64 + 1) // 1025
    expect(table.pts.length).toBe(1025 * 3)
    expect(table.cum[0]).toBe(0)
    for (let i = 1; i < table.cum.length; i++) {
      expect(table.cum[i]).toBeGreaterThan(table.cum[i - 1])
    }
    expect(table.total).toBe(table.cum[table.cum.length - 1])
  })

  it('measures a radius-100 circle as just under 2*pi*100', () => {
    // chord sums always undershoot the true arc; with 64 samples per segment the
    // shortfall is 0.183 m on 628.319 m, i.e. 0.029%
    const table = buildArcTable(makeCircleTrack())
    const circumference = 2 * Math.PI * 100 // 628.3185307179587
    expect(table.total).toBeLessThan(circumference)
    expect(circumference - table.total).toBeLessThan(0.5)
    expect(table.total).toBeCloseTo(628.135, 2) // pinned to SAMPLES_PER_SEGMENT = 64
  })

  it('locateS maps arc-normalised s onto the segment parameter', () => {
    const table = buildArcTable(makeCircleTrack())
    expect(locateS(table, 0)).toBe(0)
    expect(locateS(table, 1)).toBe(0) // s wraps
    // the circle fixture is uniform, so a quarter of the arc is 4 of the 16 segments
    expect(locateS(table, 0.25)).toBeCloseTo(4, 9)
    expect(locateS(table, 0.5)).toBeCloseTo(8, 9)
  })

  it('normalises s by arc length, not by control point index', () => {
    // straight fixture: 12 segments, but their lengths run from 50 m (the end cap)
    // to 300 m (the return leg). Parameter-normalised, s = 0.5 would be segment 6
    // (control point 6 at x = 740). Arc-normalised it is t = 7.997, i.e. control
    // point 8 at x = 600, because control point 8 sits at s = 0.500288.
    const table = buildArcTable(makeStraightTrack())
    expect(table.segments).toBe(12)
    expect(table.cum.length).toBe(12 * 64 + 1) // 769
    expect(locateS(table, 0.5)).toBeCloseTo(7.9973389, 6)
    expect(locateS(table, 0.5)).toBeGreaterThan(7)
    // and the reverse: control point 6 is at s = 0.414, not s = 6/12 = 0.5
    expect(arcAt(table, 6) / table.total).toBeCloseTo(0.4141583, 6)
  })

  it('arcAt converts a segment parameter back to metres and wraps', () => {
    const table = buildArcTable(makeStraightTrack())
    expect(table.total).toBeCloseTo(1828.3236243, 6)
    expect(arcAt(table, 0)).toBe(0)
    expect(arcAt(table, 11.999)).toBeCloseTo(1828.1734072, 5)
    expect(arcAt(table, 12)).toBe(0) // one full lap wraps back to the start line
  })

  it('locateS and arcAt round-trip', () => {
    const table = buildArcTable(makeStraightTrack())
    for (const s of [0.05, 0.2, 0.37, 0.5, 0.61, 0.83, 0.99]) {
      expect(arcAt(table, locateS(table, s)) / table.total).toBeCloseTo(s, 9)
    }
  })
})

function emptyProjection(): TrackProjection {
  return { s: 0, lateral: 0, distance: 0 }
}

describe('projectPoint', () => {
  it('puts a point on the centreline at zero lateral and zero distance', () => {
    // (300, 0, 0) is control point 2 of the straight fixture, which sits at s = 0.164306
    const tr = makeStraightTrack()
    const table = buildArcTable(tr)
    const out = emptyProjection()
    projectPoint(tr, table, v3(300, 0, 0), out)
    expect(out.s).toBeCloseTo(0.1643056, 6)
    expect(Math.abs(out.lateral)).toBeLessThan(1e-6)
    expect(out.distance).toBeLessThan(1e-6)
  })

  it('signs lateral positive toward +z when travelling +X', () => {
    // right = (-t.z, 0, t.x) and t = (1, 0, 0) on the straight, so right = (0, 0, 1)
    const tr = makeStraightTrack()
    const table = buildArcTable(tr)
    const out = emptyProjection()
    projectPoint(tr, table, v3(300, 0, 5), out)
    expect(out.lateral).toBeCloseTo(5, 9)
    expect(out.distance).toBeCloseTo(5, 9)
    expect(out.s).toBeCloseTo(0.1643056, 6)
    projectPoint(tr, table, v3(300, 0, -5), out)
    expect(out.lateral).toBeCloseTo(-5, 9)
    expect(out.distance).toBeCloseTo(5, 9)
  })

  it('ignores height: a kart in the air projects like a kart on the ground', () => {
    const tr = makeStraightTrack()
    const table = buildArcTable(tr)
    const ground = emptyProjection()
    const air = emptyProjection()
    projectPoint(tr, table, v3(300, 0, 5), ground)
    projectPoint(tr, table, v3(300, 7, 5), air)
    expect(air.s).toBe(ground.s)
    expect(air.lateral).toBe(ground.lateral)
    expect(air.distance).toBe(ground.distance)
  })

  it('projects onto a curved centreline with the inside of the circle positive', () => {
    // travel is counter-clockwise in the x-z plane, so at (100, 0, 0) the tangent is
    // (0, 0, 1) and right = (-1, 0, 0), which points at the centre. A point 50 m
    // outside the circle is therefore lateral -50; one 10 m inside is lateral +10.
    const tr = makeCircleTrack()
    const table = buildArcTable(tr)
    const out = emptyProjection()
    projectPoint(tr, table, v3(150, 0, 0), out)
    expect(out.lateral).toBeCloseTo(-50, 6)
    expect(out.distance).toBeCloseTo(50, 6)
    // this point sits exactly on the start line, so s may converge to either side of the
    // seam - 1e-9 or 1 - 1e-9 are the same place on a closed loop
    expect(Math.min(out.s, 1 - out.s)).toBeLessThan(1e-6)
    projectPoint(tr, table, v3(90, 0, 0), out)
    expect(out.lateral).toBeCloseTo(10, 6)
    expect(out.distance).toBeCloseTo(10, 6)
    projectPoint(tr, table, v3(0, 0, -150), out)
    expect(out.s).toBeCloseTo(0.75, 6)
    expect(out.lateral).toBeCloseTo(-50, 6)
  })

  it('projects onto the oval bottom straight with the expected s', () => {
    // the oval bottom straight runs +X at z = -100; control point 2 is (0, 0, -100)
    // at s = 0.140104. A point 6 m toward +z is 6 m to the right of travel.
    const tr = makeOvalTrack()
    const table = buildArcTable(tr)
    const out = emptyProjection()
    projectPoint(tr, table, v3(0, 0, -94), out)
    expect(out.s).toBeCloseTo(0.1401039, 6)
    expect(out.lateral).toBeCloseTo(6, 9)
    expect(out.distance).toBeCloseTo(6, 9)
    projectPoint(tr, table, v3(0, 0, -106), out)
    expect(out.s).toBeCloseTo(0.1401039, 6)
    expect(out.lateral).toBeCloseTo(-6, 9)
    expect(out.distance).toBeCloseTo(6, 9)
  })
})

describe('buildTrackQuery', () => {
  it('reports the arc length of each fixture', () => {
    expect(buildTrackQuery(makeStraightTrack()).totalLength()).toBeCloseTo(1828.3236243, 6)
    expect(buildTrackQuery(makeCircleTrack()).totalLength()).toBeCloseTo(628.1351367, 6)
    expect(buildTrackQuery(makeOvalTrack()).totalLength()).toBeCloseTo(1427.7555092, 6)
  })

  it('reads s as arc-normalised, so s = 30 is the start line and not 30 metres along', () => {
    const q = buildTrackQuery(makeStraightTrack())
    // wrap01(30) = 30 - Math.floor(30) = 0, so s = 30 IS s = 0, silently. This is the
    // single most error-prone thing in the package (contract section 0), so it is pinned.
    expect(q.sampleAt(30).position).toEqual({ x: 0, y: 0, z: 0 })
    expect(q.sampleAt(0).position).toEqual({ x: 0, y: 0, z: 0 })
    // 30 metres along is a completely different place: 30 / 1828.3236243268896 =
    // 0.016408473642648858 of the lap. The centreline there is (29.7252259, 0, -3.8633698)
    // rather than (30, 0, 0), because segment 0's Catmull-Rom window includes control
    // point 11 at (-140, 0, 60), which bows the curve toward -z as it leaves the origin.
    const sFor30m = 30 / q.totalLength()
    expect(sFor30m).toBeCloseTo(0.0164085, 7)
    const p = q.sampleAt(sFor30m)
    expect(p.position.x).toBeCloseTo(29.7252259, 6)
    expect(p.position.y).toBe(0)
    expect(p.position.z).toBeCloseTo(-3.8633698, 6)
  })

  it('resolves s by arc length, not by control point index', () => {
    // the straight fixture's segments are 50 m to 300 m long. Control point 6 is
    // (740, 0, 60) and sits at index 6 of 12, so a parameter-normalised s = 0.5 would
    // land there. By arc length s = 0.5 is next to control point 8, (600, 0, 120),
    // which sits at s = 0.500288.
    const q = buildTrackQuery(makeStraightTrack())
    const p = q.sampleAt(0.5)
    expect(p.position.x).toBeCloseTo(600.5310186, 4)
    expect(p.position.y).toBe(0)
    expect(p.position.z).toBeCloseTo(119.9598713, 4)
    expect(Math.abs(p.position.x - 740)).toBeGreaterThan(100)
  })

  it('advances s at a constant rate along the track', () => {
    // this is the property arc-normalisation exists for: 0.01 of s is 0.01 of the lap
    // everywhere, whether the control points there are 150 m apart or 300 m apart
    const q = buildTrackQuery(makeStraightTrack())
    const total = q.totalLength() // 1828.3236, so 0.01 of s is 18.2832 m
    const a = q.sampleAt(0.1)
    const ax = a.position.x
    const az = a.position.z
    const b = q.sampleAt(0.11)
    const bx = b.position.x
    const bz = b.position.z
    const c = q.sampleAt(0.6)
    const cx = c.position.x
    const cz = c.position.z
    const d = q.sampleAt(0.61)
    const dx = d.position.x
    const dz = d.position.z
    const near = Math.hypot(bx - ax, bz - az) // 18.283236
    const far = Math.hypot(dx - cx, dz - cz) // 18.284069
    expect(near).toBeCloseTo(0.01 * total, 1)
    expect(far).toBeCloseTo(0.01 * total, 1)
    expect(Math.abs(far - near)).toBeLessThan(0.01)
  })

  it('returns shared scratch objects that the caller must copy', () => {
    const q = buildTrackQuery(makeStraightTrack())
    expect(q.sampleAt(0)).toBe(q.sampleAt(0.5))
    expect(q.tangentAt(0)).toBe(q.tangentAt(0.5))
    expect(q.project(v3(0, 0, 0))).toBe(q.project(v3(300, 0, 0)))
    // the second call overwrites the first result in place
    const first = q.sampleAt(0)
    expect(first.position.x).toBe(0)
    q.sampleAt(0.5)
    expect(first.position.x).toBeCloseTo(600.5310186, 4)
    // but two queries never share scratch
    const other = buildTrackQuery(makeCircleTrack())
    expect(q.sampleAt(0)).not.toBe(other.sampleAt(0))
  })

  it('samples the circle fixture on its radius', () => {
    const q = buildTrackQuery(makeCircleTrack())
    expect(q.sampleAt(0).position).toEqual({ x: 100, y: 0, z: 0 })
    const t = q.tangentAt(0)
    expect(t.x).toBeCloseTo(0, 12)
    expect(t.y).toBe(0)
    expect(t.z).toBeCloseTo(1, 12)
    // Catmull-Rom through 16 circle points bows very slightly inside the true circle:
    // the midpoint of a segment sits at radius 99.944974 instead of 100
    const mid = q.sampleAt(0.03125)
    expect(Math.hypot(mid.position.x, mid.position.z)).toBeCloseTo(99.944974, 5)
    const quarter = q.sampleAt(0.25)
    expect(quarter.position.x).toBeCloseTo(0, 9)
    expect(quarter.position.z).toBeCloseTo(100, 9)
  })

  it('samples width, banking and surface from the oval', () => {
    // s = 0.35 is inside the right turn, between control points 5 (s = 0.3168) and
    // 9 (s = 0.4634), which are all 20 m wide and banked 0.2 rad
    const q = buildTrackQuery(makeOvalTrack())
    const p = q.sampleAt(0.35)
    expect(p.position.x).toBeCloseTo(284.006904, 4)
    expect(p.position.z).toBeCloseTo(-54.209059, 4)
    expect(p.width).toBe(20)
    expect(p.banking).toBe(0.2)
    expect(p.surface).toBe('tarmac')
    // s = 0 is the start of the 24 m wide flat bottom straight
    const start = q.sampleAt(0)
    expect(start.position).toEqual({ x: -200, y: 0, z: -100 })
    expect(start.width).toBe(24)
    expect(start.banking).toBe(0)
  })

  it('groundHeight adds the spline height and the banking cross-fall', () => {
    // banked 0.2 rad, so the cross-fall is lateral * tan(0.2) = lateral * 0.2027100355
    // and 6 m to the right of the centreline is 6 * 0.2027100355 = 1.2162602131 higher
    const oval = buildTrackQuery(makeOvalTrack())
    expect(oval.groundHeight(0.35, 0)).toBe(0)
    expect(oval.groundHeight(0.35, 6)).toBeCloseTo(1.2162602131, 9)
    expect(oval.groundHeight(0.35, -6)).toBeCloseTo(-1.2162602131, 9)
    // the straight fixture has no banking at all, so lateral changes nothing
    const flat = buildTrackQuery(makeStraightTrack())
    expect(flat.groundHeight(0.2, 8)).toBe(0)
    // raise control point 2 to y = 10 and the height at that point follows the spline
    const base = makeStraightTrack()
    const hilly = buildTrackQuery(
      makeStraightTrack({
        controlPoints: base.controlPoints.map((p, i) => ({
          ...p,
          position: v3(p.position.x, i === 2 ? 10 : 0, p.position.z),
        })),
      }),
    )
    const sAtHill = hilly.project(v3(300, 0, 0)).s // control point 2 is (300, *, 0)
    expect(sAtHill).toBeCloseTo(0.1644481, 6)
    expect(hilly.groundHeight(sAtHill, 0)).toBeCloseTo(10, 6)
  })

  it('surfaceAt gives offtrack first, then boost pads, then the segment surface', () => {
    const q = buildTrackQuery(makeOvalTrack())
    // right turn: 20 m wide, so the edge is at |lateral| = 10
    expect(q.surfaceAt(0.35, 0)).toBe('tarmac')
    expect(q.surfaceAt(0.35, 9.9)).toBe('tarmac')
    expect(q.surfaceAt(0.35, 10.1)).toBe('offtrack')
    // boost pad at s = 0.1, lateral 0, halfWidth 4. Its longitudinal half-extent is
    // BOOST_PAD_HALF_LENGTH / totalLength = 4 / 1427.7555 = 0.0028016 of s
    expect(q.surfaceAt(0.1, 0)).toBe('boost')
    expect(q.surfaceAt(0.1, 3)).toBe('boost')
    expect(q.surfaceAt(0.1, 5)).toBe('tarmac') // outside the pad laterally
    expect(q.surfaceAt(0.105, 0)).toBe('tarmac') // 0.005 * 1427.76 = 7.1 m past the pad
    expect(q.surfaceAt(0.1, 13)).toBe('offtrack') // offtrack beats the pad (24 m wide here)
    // control points 12 and 13 are dirt, so s in [0.640104, 0.780208) is dirt
    expect(q.surfaceAt(0.63, 0)).toBe('tarmac')
    expect(q.surfaceAt(0.65, 0)).toBe('dirt')
    expect(q.surfaceAt(0.77, 0)).toBe('dirt')
    expect(q.surfaceAt(0.79, 0)).toBe('tarmac')
  })

  it('isInBounds allows one half-width of run-off past each edge', () => {
    const q = buildTrackQuery(makeOvalTrack())
    // bottom straight is 24 m wide: edge at 12, out of bounds past 24
    expect(q.isInBounds(0.02, 0)).toBe(true)
    expect(q.isInBounds(0.02, 24)).toBe(true)
    expect(q.isInBounds(0.02, -24)).toBe(true)
    expect(q.isInBounds(0.02, 24.001)).toBe(false)
    // right turn is 20 m wide: out of bounds past 20
    expect(q.isInBounds(0.35, 20)).toBe(true)
    expect(q.isInBounds(0.35, 20.001)).toBe(false)
  })

  it('checkpointIndexAt returns the last checkpoint passed, and wraps', () => {
    // oval ring is [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875]
    const oval = buildTrackQuery(makeOvalTrack())
    expect(oval.checkpointIndexAt(0)).toBe(0)
    expect(oval.checkpointIndexAt(0.124)).toBe(0)
    expect(oval.checkpointIndexAt(0.125)).toBe(1)
    expect(oval.checkpointIndexAt(0.9)).toBe(7)
    expect(oval.checkpointIndexAt(0.999)).toBe(7)
    expect(oval.checkpointIndexAt(1.125)).toBe(1) // s wraps
    expect(oval.checkpointIndexAt(-0.001)).toBe(7) // and wraps backwards
    // a ring that does not start at 0: anything before the first checkpoint belongs to
    // the last one, because the kart crossed it on the previous lap
    const shifted = buildTrackQuery(makeStraightTrack({ checkpointS: [0.1, 0.4, 0.7] }))
    expect(shifted.checkpointIndexAt(0.05)).toBe(2)
    expect(shifted.checkpointIndexAt(0.1)).toBe(0)
    expect(shifted.checkpointIndexAt(0.39)).toBe(0)
    expect(shifted.checkpointIndexAt(0.4)).toBe(1)
    expect(shifted.checkpointIndexAt(0.95)).toBe(2)
  })

  it('project matches projectPoint on the same track', () => {
    const tr = makeStraightTrack()
    const table = buildArcTable(tr)
    const q = buildTrackQuery(tr)
    const direct: TrackProjection = { s: 0, lateral: 0, distance: 0 }
    projectPoint(tr, table, v3(300, 0, 5), direct)
    const viaQuery = q.project(v3(300, 0, 5))
    expect(viaQuery.s).toBe(direct.s)
    expect(viaQuery.lateral).toBe(direct.lateral)
    expect(viaQuery.distance).toBe(direct.distance)
    expect(direct.lateral).toBeCloseTo(5, 9)
  })
})

describe('makeContext', () => {
  it('builds a leader context by default', () => {
    const track = makeStraightTrack()
    const ctx = makeContext(track)
    expect(ctx.track).toBe(track)
    expect(ctx.isLeader).toBe(true)
    expect(ctx.tuning.maxSpeed).toBe(40)
    expect(ctx.tuning.kartRadius).toBe(0.9)
    expect(ctx.characters).toHaveLength(8)
    expect(ctx.characters[5].speed).toBe(1.15)
    expect(ctx.query.totalLength()).toBeCloseTo(1828.3236243, 6)
  })

  it('builds a follower context when isLeader is false', () => {
    const ctx = makeContext(makeOvalTrack(), false)
    expect(ctx.isLeader).toBe(false)
    expect(ctx.query.totalLength()).toBeCloseTo(1427.7555092, 6)
    expect(ctx.query.sampleAt(0).position).toEqual({ x: -200, y: 0, z: -100 })
  })

  it('gives every context its own query and its own scratch', () => {
    const a = makeContext(makeStraightTrack())
    const b = makeContext(makeStraightTrack())
    expect(a.query).not.toBe(b.query)
    expect(a.query.sampleAt(0)).not.toBe(b.query.sampleAt(0))
  })
})
