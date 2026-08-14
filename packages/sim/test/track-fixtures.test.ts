import { describe, expect, it } from 'vitest'
import {
  makeCharacters,
  makeCircleTrack,
  makeOvalTrack,
  makeStraightTrack,
  makeTuning,
} from './fixtures/track-fixtures'

describe('track fixtures', () => {
  it('makeTuning returns the locked base tuning values', () => {
    const t = makeTuning()
    expect(t.maxSpeed).toBe(40)
    expect(t.accelRate).toBe(24)
    expect(t.brakeRate).toBe(48)
    expect(t.steerRateBase).toBe(2.6)
    expect(t.steerSpeedFalloff).toBe(0.55)
    expect(t.gripTarmac).toBe(14)
    expect(t.gripDirt).toBe(5)
    expect(t.gripDrift).toBe(3)
    expect(t.gravity).toBe(30)
    expect(t.airYaw).toBe(0.6)
    expect(t.offtrackSpeedMul).toBe(0.55)
    expect(t.respawnTicks).toBe(72)
    expect(t.invulnTicks).toBe(90)
    expect(t.spinOutTicks).toBe(60)
    expect(t.driftMinSpeed).toBe(8)
    expect(t.driftTiers).toEqual([40, 90, 150])
    expect(t.driftBoosts).toEqual([24, 42, 66])
    expect(t.boostSpeedMul).toBe(1.35)
    expect(t.surgeSpeedMul).toBe(0.7)
    expect(t.kartRadius).toBe(0.9)
    expect(t.kartRestitution).toBe(0.4)
    expect(t.itemBoxRespawnTicks).toBe(180)
    expect(t.seekerSpeed).toBe(55)
    expect(t.boltSpeed).toBe(65)
    expect(t.entityTtl).toBe(600)
  })

  it('makeTuning applies overrides and leaves every other field alone', () => {
    const t = makeTuning({ maxSpeed: 10, gripTarmac: 1 })
    expect(t.maxSpeed).toBe(10)
    expect(t.gripTarmac).toBe(1)
    // untouched neighbours keep the base values
    expect(t.accelRate).toBe(24)
    expect(t.gripDirt).toBe(5)
    expect(t.entityTtl).toBe(600)
    // the base object is not mutated by an override call
    expect(makeTuning().maxSpeed).toBe(40)
  })

  it('makeCharacters returns exactly 8 rows matching the locked stat table', () => {
    const c = makeCharacters()
    expect(c).toHaveLength(8)
    expect(c.map((x) => x.speed)).toEqual([1.0, 1.1, 0.92, 1.05, 0.95, 1.15, 0.88, 1.0])
    expect(c.map((x) => x.accel)).toEqual([1.0, 0.85, 1.15, 0.9, 1.1, 0.8, 1.2, 1.0])
    expect(c.map((x) => x.handling)).toEqual([1.0, 0.9, 1.1, 0.95, 1.05, 0.85, 1.15, 1.0])
    expect(c.map((x) => x.weight)).toEqual([1.0, 1.2, 0.85, 1.1, 0.9, 1.3, 0.8, 1.0])
    expect(c.map((x) => x.id)).toEqual(['c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7'])
    expect(c[5].name).toBe('Racer 5')
  })

  it('makeStraightTrack has 12 control points with a +X front straight', () => {
    const tr = makeStraightTrack()
    expect(tr.id).toBe('straight')
    expect(tr.controlPoints).toHaveLength(12)
    // control points 0..4 are collinear along +X at z = 0, spaced 150 apart
    for (let i = 0; i <= 4; i++) {
      expect(tr.controlPoints[i].position.x).toBe(i * 150)
      expect(tr.controlPoints[i].position.y).toBe(0)
      expect(tr.controlPoints[i].position.z).toBe(0)
    }
    // the return leg sits at z = 120
    expect(tr.controlPoints[8].position).toEqual({ x: 600, y: 0, z: 120 })
    expect(tr.controlPoints[10].position).toEqual({ x: 0, y: 0, z: 120 })
    expect(tr.controlPoints[11].position).toEqual({ x: -140, y: 0, z: 60 })
    // uniform 20 m width, no banking, all tarmac
    expect(tr.controlPoints.every((p) => p.width === 20)).toBe(true)
    expect(tr.controlPoints.every((p) => p.banking === 0)).toBe(true)
    expect(tr.controlPoints.every((p) => p.surface === 'tarmac')).toBe(true)
    expect(tr.checkpointS).toEqual([0, 0.25, 0.5, 0.75])
    expect(tr.startPositions).toHaveLength(8)
    // The grid sits behind the s = 0 line, in the last checkpoint segment
    // [0.75, 1) -- see makeStraightTrack's doc comment for why.
    expect(tr.startPositions[0]).toEqual({ s: 0.99, lateral: -5 })
    expect(tr.startPositions[7]).toEqual({ s: 0.945, lateral: 5 })
    expect(tr.ramps).toEqual([{ sStart: 0.4, sEnd: 0.44, launch: 6 }])
    expect(tr.boostPads).toEqual([{ s: 0.6, lateral: 0, halfWidth: 3 }])
    expect(tr.bounds.min).toEqual({ x: -200, y: -20, z: -40 })
    expect(tr.bounds.max).toEqual({ x: 800, y: 40, z: 160 })
  })

  it('makeStraightTrack applies overrides', () => {
    const tr = makeStraightTrack({ checkpointS: [0.1, 0.4, 0.7], id: 'custom' })
    expect(tr.id).toBe('custom')
    expect(tr.checkpointS).toEqual([0.1, 0.4, 0.7])
    expect(tr.controlPoints).toHaveLength(12) // untouched
  })

  it('makeCircleTrack has 16 control points on a radius-100 circle', () => {
    const tr = makeCircleTrack()
    expect(tr.controlPoints).toHaveLength(16)
    // point i sits at angle i*2pi/16; point 0 is exactly (100, 0, 0)
    expect(tr.controlPoints[0].position.x).toBe(100)
    expect(tr.controlPoints[0].position.z).toBe(0)
    // point 4 is a quarter turn round: (100*cos(pi/2), 0, 100*sin(pi/2)) = (~0, 0, 100)
    expect(tr.controlPoints[4].position.x).toBeCloseTo(0, 9)
    expect(tr.controlPoints[4].position.z).toBeCloseTo(100, 9)
    for (const p of tr.controlPoints) {
      expect(Math.hypot(p.position.x, p.position.z)).toBeCloseTo(100, 9)
      expect(p.position.y).toBe(0)
      expect(p.width).toBe(20)
    }
    expect(tr.ramps).toEqual([])
    expect(tr.startPositions).toHaveLength(8)
  })

  it('makeOvalTrack has 20 control points, banked turns and a dirt sector', () => {
    const tr = makeOvalTrack()
    expect(tr.controlPoints).toHaveLength(20)
    // 0..4: bottom straight, z = -100, x from -200 to 200 in steps of 100
    expect(tr.controlPoints[0].position).toEqual({ x: -200, y: 0, z: -100 })
    expect(tr.controlPoints[4].position).toEqual({ x: 200, y: 0, z: -100 })
    // 5..9: right turn, radius 100 about (200, 0, 0); index 7 is theta = 0
    expect(tr.controlPoints[7].position.x).toBeCloseTo(300, 9)
    expect(tr.controlPoints[7].position.z).toBeCloseTo(0, 9)
    // 10..14: top straight, z = +100
    expect(tr.controlPoints[10].position).toEqual({ x: 200, y: 0, z: 100 })
    expect(tr.controlPoints[14].position).toEqual({ x: -200, y: 0, z: 100 })
    // 15..19: left turn, radius 100 about (-200, 0, 0); index 17 is theta = 180
    expect(tr.controlPoints[17].position.x).toBeCloseTo(-300, 9)
    expect(tr.controlPoints[17].position.z).toBeCloseTo(0, 9)
    // straights are 24 m wide and flat, turns are 20 m wide and banked 0.2 rad
    expect(tr.controlPoints[2].width).toBe(24)
    expect(tr.controlPoints[2].banking).toBe(0)
    expect(tr.controlPoints[7].width).toBe(20)
    expect(tr.controlPoints[7].banking).toBe(0.2)
    expect(tr.controlPoints[17].banking).toBe(0.2)
    // exactly two dirt control points, 12 and 13, so segments 12 and 13 are dirt
    expect(tr.controlPoints.map((p) => p.surface).filter((s) => s === 'dirt')).toHaveLength(2)
    expect(tr.controlPoints[12].surface).toBe('dirt')
    expect(tr.controlPoints[13].surface).toBe('dirt')
    expect(tr.controlPoints[11].surface).toBe('tarmac')
    expect(tr.controlPoints[14].surface).toBe('tarmac')
    expect(tr.checkpointS).toEqual([0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875])
    expect(tr.itemBoxes).toHaveLength(6)
    expect(tr.boostPads).toEqual([{ s: 0.1, lateral: 0, halfWidth: 4 }])
    expect(tr.ramps).toEqual([{ sStart: 0.55, sEnd: 0.58, launch: 7 }])
  })
})
