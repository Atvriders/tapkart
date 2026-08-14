import type {
  CharacterStats,
  Intent,
  KartState,
  SimContext,
  Surface,
  Track,
  TrackPoint,
  TrackProjection,
  TrackQuery,
  Vec3,
} from '../../src/types'
import { makeCharacters, makeTuning } from '../fixtures/track-fixtures'

/** The flat track's arc length in metres. `s` is arc length / this. */
const FLAT_TOTAL_LENGTH = 1000

/**
 * Fractional part of `s`, in `[0, 1)` — the track is a closed loop.
 *
 * Declared locally because `track.ts`'s own `wrap01` (Task 4) is private to that
 * module, and this helper must not depend on anything Task 4 does not export.
 */
function wrap01(s: number): number {
  const w = s - Math.floor(s)
  return w >= 1 ? 0 : w
}

/**
 * An analytic TrackQuery for a dead-straight 1000 m track running along +X.
 *
 * `s` is arc-NORMALIZED to [0, 1), exactly as the locked contract requires:
 * s = 0.25 is 250 m along, not 0.25 m. Metres are reached only by multiplying an
 * s-delta by totalLength().
 *
 *   sampleAt(s)          -> centerline point (s * 1000, 0, 0)
 *   tangentAt(s)         -> (1, 0, 0), so right = (-t.z, 0, t.x) = (0, 0, 1)
 *   project(p)           -> s = wrap01(p.x / 1000), lateral = p.z
 *   groundHeight(s, lat) -> 0.5 * (s * 1000), i.e. half the arc distance in
 *                           metres (deliberately NOT constant, so a test can
 *                           prove the query was actually consulted)
 *   surfaceAt(s, lat)    -> 'dirt' when lateral > 2, otherwise 'tarmac'
 *   checkpointIndexAt(s) -> floor(s * 4) clamped to 0..3, matching the four
 *                           checkpoints at s = 0, 0.25, 0.5, 0.75
 */
export function makeFlatQuery(): TrackQuery {
  return {
    sampleAt(s: number): TrackPoint {
      return {
        position: { x: s * FLAT_TOTAL_LENGTH, y: 0, z: 0 },
        width: 20,
        banking: 0,
        surface: 'tarmac',
      }
    },
    tangentAt(_s: number): Vec3 {
      return { x: 1, y: 0, z: 0 }
    },
    project(p: Vec3): TrackProjection {
      return {
        s: wrap01(p.x / FLAT_TOTAL_LENGTH),
        lateral: p.z,
        distance: Math.abs(p.y),
      }
    },
    groundHeight(s: number, _lateral: number): number {
      return 0.5 * (s * FLAT_TOTAL_LENGTH)
    },
    surfaceAt(_s: number, lateral: number): Surface {
      return lateral > 2 ? 'dirt' : 'tarmac'
    },
    isInBounds(_s: number, lateral: number): boolean {
      return Math.abs(lateral) <= 10
    },
    checkpointIndexAt(s: number): number {
      return Math.max(0, Math.min(3, Math.floor(wrap01(s) * 4)))
    },
    totalLength(): number {
      return FLAT_TOTAL_LENGTH
    },
  }
}

/**
 * A straight 1000 m track along +X with exactly 3 item boxes and 4 checkpoints.
 * Every `s` here is arc-normalized: the checkpoints sit at 0 m, 250 m, 500 m and
 * 750 m, the item boxes at 100 m, 300 m and 600 m.
 */
export function makeFlatTrack(startPositions: { s: number; lateral: number }[]): Track {
  return {
    id: 'flat',
    name: 'Flat Test Straight',
    controlPoints: [
      { position: { x: 0, y: 0, z: 0 }, width: 20, banking: 0, surface: 'tarmac' },
      { position: { x: 500, y: 0, z: 0 }, width: 20, banking: 0, surface: 'tarmac' },
      { position: { x: 1000, y: 0, z: 0 }, width: 20, banking: 0, surface: 'tarmac' },
    ],
    checkpointS: [0, 0.25, 0.5, 0.75],
    itemBoxes: [
      { s: 0.1, lateral: 0 },
      { s: 0.3, lateral: 2 },
      { s: 0.6, lateral: -2 },
    ],
    ramps: [],
    boostPads: [],
    startPositions,
    bounds: { min: { x: -50, y: -10, z: -50 }, max: { x: 1050, y: 10, z: 50 } },
  }
}

export function makeTestContext(startPositions: { s: number; lateral: number }[]): SimContext {
  const characters: CharacterStats[] = makeCharacters()
  return {
    track: makeFlatTrack(startPositions),
    query: makeFlatQuery(),
    tuning: makeTuning(),
    characters,
    isLeader: true,
  }
}

/**
 * Eight grid slots, 4 m apart, sitting BEHIND the s = 0 start/finish line -- not
 * past it. `createState` [Task 5] starts every kart's `lap.checkpointIdx` at
 * `checkpointS.length - 1` (the *last* checkpoint), on the premise that the grid
 * sits in that same last segment, so the first crossing of s = 0 is what earns
 * lap 1. On this 4-checkpoint track (`checkpointS = [0, 0.25, 0.5, 0.75]`) that
 * last segment is `[0.75, 1)`.
 *
 * A literal mirror (`s -> 1 - s`) does not work for seat 0: its old value was
 * `s = 0` exactly (0 m past the line), and `1 - 0 = 1`, which wraps straight back
 * to `s = 0` -- still inside segment 0, the bug this fixes. So instead of
 * mirroring each seat's *distance past* the line into an equal *distance before*
 * it, the whole row is shifted back by one 4 m step: seat 0 sits 4 m before the
 * line, seat 1 8 m before it, and so on up to seat 7 at 32 m before it. This
 * keeps the row's shape intact -- 4 m spacing, the same lateral pattern, 8 karts
 * -- and keeps seat 0 the pole position (closest to the line) exactly as before,
 * just with every seat now unambiguously inside `[0.75, 1)`.
 *
 * `s` is arc-normalized, so `0.996` is 996 m along the 1000 m lap (4 m short of a
 * full lap, i.e. 4 m before the line) and `sampleAt` puts that seat at world
 * x = 996. Seat 2 sits 3 m right of the centerline (+z), seat 3 sits 3 m left.
 */
export const EIGHT_STARTS: { s: number; lateral: number }[] = [
  { s: 0.996, lateral: 0 }, // 4 m before the line -> x = 996
  { s: 0.992, lateral: 0 }, // 8 m before the line -> x = 992
  { s: 0.988, lateral: 3 }, // 12 m before the line -> x = 988
  { s: 0.984, lateral: -3 }, // 16 m before the line -> x = 984
  { s: 0.98, lateral: 0 }, // 20 m before the line -> x = 980
  { s: 0.976, lateral: 0 }, // 24 m before the line -> x = 976
  { s: 0.972, lateral: 0 }, // 28 m before the line -> x = 972
  { s: 0.968, lateral: 0 }, // 32 m before the line -> x = 968
]

/**
 * A single kart at the origin, at rest, on tarmac, facing +X (heading 0).
 *
 * `lap.checkpointIdx` defaults to **3**, not 0 and not -1: that is exactly what
 * createState writes on the flat test track, whose `checkpointS` has 4 entries
 * and whose initial index is therefore `checkpointS.length - 1 = 3`. A kart built
 * here is indistinguishable from a freshly created one, so a lap test can use
 * either without changing its expectations.
 */
export function makeKart(over: Partial<KartState> = {}): KartState {
  return {
    playerId: 0,
    characterIdx: 0,
    isBot: false,
    connected: true,
    position: { x: 0, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    heading: 0,
    angularVelocity: 0,
    drift: { active: false, dir: 0, charge: 0 },
    item: 'none',
    airborne: false,
    surface: 'tarmac',
    spinOutTicks: 0,
    invulnTicks: 0,
    boostTicks: 0,
    respawnTicks: 0,
    shielded: false,
    lap: { lap: 0, checkpointIdx: 3, t: 0 },
    ...over,
  }
}

/** A neutral intent: no steer, no throttle, no brake, no drift, no item. */
export function makeIntent(over: Partial<Intent> = {}): Intent {
  return { tick: 0, steer: 0, accel: 0, brake: false, drift: false, useItem: false, ...over }
}
