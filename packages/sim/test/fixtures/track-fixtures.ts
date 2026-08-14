import type {
  CharacterStats,
  SimContext,
  Surface,
  Track,
  TrackPoint,
  Tuning,
} from '../../src/types'
import { buildTrackQuery } from '../../src/track'
import { v3 } from '../../src/vec3'

function cp(
  x: number,
  y: number,
  z: number,
  width: number,
  banking: number,
  surface: Surface,
): TrackPoint {
  return { position: v3(x, y, z), width, banking, surface }
}

/** Base tuning table. Every numeric expectation in the sim tests derives from these. */
export function makeTuning(overrides?: Partial<Tuning>): Tuning {
  return {
    maxSpeed: 40,
    accelRate: 24,
    brakeRate: 48,
    steerRateBase: 2.6,
    steerSpeedFalloff: 0.55,
    gripTarmac: 14,
    gripDirt: 5,
    gripDrift: 3,
    gravity: 30,
    airYaw: 0.6,
    offtrackSpeedMul: 0.55,
    respawnTicks: 72,
    invulnTicks: 90,
    spinOutTicks: 60,
    driftMinSpeed: 8,
    driftTiers: [40, 90, 150],
    driftBoosts: [24, 42, 66],
    boostSpeedMul: 1.35,
    surgeSpeedMul: 0.7,
    kartRadius: 0.9,
    kartRestitution: 0.4,
    itemBoxRespawnTicks: 180,
    seekerSpeed: 55,
    boltSpeed: 65,
    entityTtl: 600,
    ...overrides,
  }
}

/** Exactly 8 characters, stats transcribed from the locked contract. */
export function makeCharacters(): CharacterStats[] {
  const speed = [1.0, 1.1, 0.92, 1.05, 0.95, 1.15, 0.88, 1.0]
  const accel = [1.0, 0.85, 1.15, 0.9, 1.1, 0.8, 1.2, 1.0]
  const handling = [1.0, 0.9, 1.1, 0.95, 1.05, 0.85, 1.15, 1.0]
  const weight = [1.0, 1.2, 0.85, 1.1, 0.9, 1.3, 0.8, 1.0]
  const out: CharacterStats[] = []
  for (let i = 0; i < 8; i++) {
    out.push({
      id: `c${i}`,
      name: `Racer ${i}`,
      speed: speed[i],
      accel: accel[i],
      handling: handling[i],
      weight: weight[i],
    })
  }
  return out
}

/**
 * A closed loop whose front straight runs along +X at z = 0.
 * Control points 0..4 are collinear, so the spline is exactly straight for the whole
 * span between control point 1 (x = 150) and control point 3 (x = 450): both of the
 * segments in that span use only z = 0 control points.
 * A kart at heading 0 drives down that straight, and positive lateral is toward +z
 * because right = (-t.z, 0, t.x) = (0, 0, 1) when t = (1, 0, 0).
 *
 * `startPositions` sits BEHIND the s = 0 start/finish line, in the last checkpoint
 * segment `[0.75, 1)` -- not past it. `createState` [Task 5] starts every kart's
 * `lap.checkpointIdx` at `checkpointS.length - 1` (the last checkpoint), on the
 * premise that the grid sits in that same last segment, so the first crossing of
 * s = 0 is what earns lap 1; a grid placed past the line (inside segment 0, as an
 * earlier revision of this fixture had it) makes `updateLaps` [Task 11] credit a
 * lap nobody drove, on the very first tick. Each row's original `s` -- read as a
 * distance *past* the line -- is mirrored into the same distance *before* it
 * (`s -> 1 - s`), which preserves the row spacing, the lateral pattern and pole
 * position (the row closest to the line stays closest, just approached from
 * behind): 0.01 -> 0.99, 0.025 -> 0.975, 0.04 -> 0.96, 0.055 -> 0.945.
 */
export function makeStraightTrack(overrides?: Partial<Track>): Track {
  const xz: [number, number][] = [
    [0, 0],
    [150, 0],
    [300, 0],
    [450, 0],
    [600, 0],
    [700, 30],
    [740, 60],
    [700, 90],
    [600, 120],
    [300, 120],
    [0, 120],
    [-140, 60],
  ]
  return {
    id: 'straight',
    name: 'Straight',
    controlPoints: xz.map(([x, z]) => cp(x, 0, z, 20, 0, 'tarmac')),
    checkpointS: [0, 0.25, 0.5, 0.75],
    itemBoxes: [
      { s: 0.3, lateral: -6 },
      { s: 0.3, lateral: 0 },
      { s: 0.3, lateral: 6 },
    ],
    ramps: [{ sStart: 0.4, sEnd: 0.44, launch: 6 }],
    boostPads: [{ s: 0.6, lateral: 0, halfWidth: 3 }],
    startPositions: [
      { s: 0.99, lateral: -5 },
      { s: 0.99, lateral: 5 },
      { s: 0.975, lateral: -5 },
      { s: 0.975, lateral: 5 },
      { s: 0.96, lateral: -5 },
      { s: 0.96, lateral: 5 },
      { s: 0.945, lateral: -5 },
      { s: 0.945, lateral: 5 },
    ],
    bounds: { min: v3(-200, -20, -40), max: v3(800, 40, 160) },
    ...overrides,
  }
}

/** 16 control points evenly spaced on a radius-100 circle centred on the origin. */
export function makeCircleTrack(overrides?: Partial<Track>): Track {
  const points: TrackPoint[] = []
  for (let i = 0; i < 16; i++) {
    const a = (i * 2 * Math.PI) / 16
    points.push(cp(100 * Math.cos(a), 0, 100 * Math.sin(a), 20, 0, 'tarmac'))
  }
  return {
    id: 'circle',
    name: 'Circle',
    controlPoints: points,
    checkpointS: [0, 0.25, 0.5, 0.75],
    itemBoxes: [
      { s: 0.5, lateral: -6 },
      { s: 0.5, lateral: 0 },
      { s: 0.5, lateral: 6 },
    ],
    ramps: [],
    boostPads: [{ s: 0.25, lateral: 0, halfWidth: 3 }],
    startPositions: [
      { s: 0.9, lateral: -5 },
      { s: 0.9, lateral: 5 },
      { s: 0.92, lateral: -5 },
      { s: 0.92, lateral: 5 },
      { s: 0.94, lateral: -5 },
      { s: 0.94, lateral: 5 },
      { s: 0.96, lateral: -5 },
      { s: 0.96, lateral: 5 },
    ],
    bounds: { min: v3(-120, -20, -120), max: v3(120, 20, 120) },
    ...overrides,
  }
}

/**
 * The golden fixture track: a 400 m x 200 m stadium oval.
 *   0..4   bottom straight, z = -100, 24 m wide, flat, tarmac
 *   5..9   right turn, radius 100 about (200, 0, 0), 20 m wide, banked 0.2 rad
 *   10..14 top straight, z = +100, 24 m wide, flat; 12 and 13 are dirt
 *   15..19 left turn, radius 100 about (-200, 0, 0), 20 m wide, banked 0.2 rad
 *
 * `startPositions` sits BEHIND the s = 0 start/finish line, in the last checkpoint
 * segment `[0.875, 1)` -- not past it, for the same reason `makeStraightTrack`'s
 * grid does (see its doc comment): `createState` credits every kart with the last
 * checkpoint at race start, so a grid placed past the line makes `updateLaps`
 * credit an undriven lap on the first tick. Mirrored the same way,
 * `s -> 1 - s`: 0.005 -> 0.995, 0.02 -> 0.98, 0.035 -> 0.965, 0.05 -> 0.95.
 */
export function makeOvalTrack(overrides?: Partial<Track>): Track {
  const points: TrackPoint[] = []
  for (let i = 0; i < 5; i++) points.push(cp(-200 + i * 100, 0, -100, 24, 0, 'tarmac'))
  for (let i = 1; i <= 5; i++) {
    const a = ((-90 + i * 30) * Math.PI) / 180
    points.push(cp(200 + 100 * Math.cos(a), 0, 100 * Math.sin(a), 20, 0.2, 'tarmac'))
  }
  for (let i = 0; i < 5; i++) {
    const surface: Surface = i === 2 || i === 3 ? 'dirt' : 'tarmac'
    points.push(cp(200 - i * 100, 0, 100, 24, 0, surface))
  }
  for (let i = 1; i <= 5; i++) {
    const a = ((90 + i * 30) * Math.PI) / 180
    points.push(cp(-200 + 100 * Math.cos(a), 0, 100 * Math.sin(a), 20, 0.2, 'tarmac'))
  }
  return {
    id: 'oval',
    name: 'Oval',
    controlPoints: points,
    checkpointS: [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875],
    itemBoxes: [
      { s: 0.3, lateral: -6 },
      { s: 0.3, lateral: 0 },
      { s: 0.3, lateral: 6 },
      { s: 0.8, lateral: -6 },
      { s: 0.8, lateral: 0 },
      { s: 0.8, lateral: 6 },
    ],
    ramps: [{ sStart: 0.55, sEnd: 0.58, launch: 7 }],
    boostPads: [{ s: 0.1, lateral: 0, halfWidth: 4 }],
    startPositions: [
      { s: 0.995, lateral: -6 },
      { s: 0.995, lateral: 6 },
      { s: 0.98, lateral: -6 },
      { s: 0.98, lateral: 6 },
      { s: 0.965, lateral: -6 },
      { s: 0.965, lateral: 6 },
      { s: 0.95, lateral: -6 },
      { s: 0.95, lateral: 6 },
    ],
    bounds: { min: v3(-320, -20, -120), max: v3(320, 20, 120) },
    ...overrides,
  }
}

/**
 * A SimContext over a fixture track: base tuning, the 8 fixture characters, and a freshly
 * built TrackQuery. `isLeader` defaults to true because most tests want the authority that
 * rolls items and advances the RNG cursor.
 */
export function makeContext(track: Track, isLeader = true): SimContext {
  return {
    track,
    query: buildTrackQuery(track),
    tuning: makeTuning(),
    characters: makeCharacters(),
    isLeader,
  }
}
