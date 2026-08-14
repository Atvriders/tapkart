import type { Surface, Track, TrackPoint, TrackProjection, TrackQuery, Vec3 } from './types'
import { MAX_KARTS } from './types'
import { v3 } from './vec3'

/**
 * Kart radius the static validator uses for the start-grid clearance rule.
 * `validateTrack` takes no `Tuning` (it runs on raw track data before a race exists),
 * so it carries its own copy of the base tuning's `kartRadius`.
 */
export const VALIDATION_KART_RADIUS = 0.9

function isFiniteVec(p: Vec3): boolean {
  return Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)
}

function checkControlPoints(track: Track, errs: string[]): void {
  const cps = track.controlPoints
  if (cps.length < 8) errs.push(`controlPoints: need at least 8, got ${cps.length}`)
  for (let i = 0; i < cps.length; i++) {
    if (!isFiniteVec(cps[i].position)) errs.push(`controlPoints[${i}].position: must be finite`)
    if (!(Number.isFinite(cps[i].width) && cps[i].width > 0)) {
      errs.push(`controlPoints[${i}].width: must be positive and finite, got ${cps[i].width}`)
    }
  }
  // the loop is closed, so the last control point is consecutive with the first
  for (let i = 0; i < cps.length; i++) {
    const j = (i + 1) % cps.length
    const a = cps[i].position
    const b = cps[j].position
    if (!isFiniteVec(a) || !isFiniteVec(b)) continue
    if (a.x === b.x && a.y === b.y && a.z === b.z) {
      errs.push(`controlPoints[${i}]: coincident with controlPoints[${j}]`)
    }
  }
}

/**
 * `updateLaps` (laps.ts) returns immediately when `checkpointS.length < 2`, because
 * lap credit is "entered the segment after the one you hold" and a one-checkpoint
 * ring has no such segment: the only checkpoint is both the one held and the next.
 * A track with exactly one checkpoint is therefore a track on which no kart can ever
 * complete a lap, forever, with nothing said about it at any point. `validateTrack`
 * is the gate every generated track JSON passes through, so it is the one place
 * that silence can still be turned into a message.
 */
export const MIN_CHECKPOINTS = 2

function checkCheckpoints(track: Track, errs: string[]): void {
  const cs = track.checkpointS
  if (cs.length < MIN_CHECKPOINTS) {
    errs.push(`checkpointS: need at least ${MIN_CHECKPOINTS}, got ${cs.length}`)
  }
  for (let i = 0; i < cs.length; i++) {
    if (!(Number.isFinite(cs[i]) && cs[i] >= 0 && cs[i] <= 1)) {
      errs.push(`checkpointS[${i}]: must be within 0..1, got ${cs[i]}`)
    } else if (i > 0 && !(cs[i] > cs[i - 1])) {
      errs.push(`checkpointS[${i}]: must be strictly ascending, got ${cs[i]} after ${cs[i - 1]}`)
    }
  }
}

/**
 * Length of the closed control polygon. The validator's stand-in for arc length: it
 * needs no spline, and it is within 1% of the real arc length on all three fixtures
 * (straight 1813.437 vs 1828.324, circle 624.289 vs 628.135, oval 1421.166 vs 1427.756).
 */
function controlPolygonLength(track: Track): number {
  const cps = track.controlPoints
  let sum = 0
  for (let i = 0; i < cps.length; i++) {
    const a = cps[i].position
    const b = cps[(i + 1) % cps.length].position
    sum += Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z)
  }
  return sum
}

/**
 * Half-width at `s`, treating `s` as uniform over the control point segments.
 * Validation-only: the runtime TrackQuery resolves `s` by true arc length.
 */
function halfWidthAtParam(track: Track, s: number): number {
  const cps = track.controlPoints
  const n = cps.length
  const scaled = (s - Math.floor(s)) * n
  let i = Math.floor(scaled)
  if (i >= n) i = n - 1
  const u = scaled - i
  const a = cps[i].width
  const b = cps[(i + 1) % n].width
  return (a + (b - a) * u) / 2
}

function checkStartPositions(track: Track, errs: string[]): void {
  const sp = track.startPositions
  if (sp.length !== MAX_KARTS) {
    errs.push(`startPositions: need exactly ${MAX_KARTS}, got ${sp.length}`)
  }
  for (let i = 0; i < sp.length; i++) {
    if (!(Number.isFinite(sp[i].s) && sp[i].s >= 0 && sp[i].s <= 1)) {
      errs.push(`startPositions[${i}].s: must be within 0..1, got ${sp[i].s}`)
      continue
    }
    const half = halfWidthAtParam(track, sp[i].s)
    if (!(Math.abs(sp[i].lateral) <= half)) {
      errs.push(
        `startPositions[${i}].lateral: |${sp[i].lateral}| exceeds half-width ${half.toFixed(3)}`,
      )
    }
  }
  const length = controlPolygonLength(track)
  const minSep = 2 * VALIDATION_KART_RADIUS
  for (let i = 0; i < sp.length; i++) {
    for (let j = i + 1; j < sp.length; j++) {
      if (!Number.isFinite(sp[i].s) || !Number.isFinite(sp[j].s)) continue
      let ds = Math.abs(sp[i].s - sp[j].s)
      if (ds > 0.5) ds = 1 - ds // the loop is closed, so s = 0.99 and s = 0.01 are close
      const sep = Math.hypot(ds * length, sp[i].lateral - sp[j].lateral)
      if (sep < minSep) {
        errs.push(
          `startPositions[${i}] and startPositions[${j}]: ` +
            `separation ${sep.toFixed(3)} is below ${minSep.toFixed(3)}`,
        )
      }
    }
  }
}

function checkBoxesAndPads(
  track: Track,
  errs: string[],
  label: string,
  array: Array<{ s: number; lateral: number }>,
): void {
  for (let i = 0; i < array.length; i++) {
    const b = array[i]
    if (!(Number.isFinite(b.s) && b.s >= 0 && b.s <= 1)) {
      errs.push(`${label}[${i}].s: must be within 0..1, got ${b.s}`)
      continue
    }
    const half = halfWidthAtParam(track, b.s)
    if (!(Math.abs(b.lateral) <= half)) {
      errs.push(`${label}[${i}].lateral: |${b.lateral}| exceeds half-width ${half.toFixed(3)}`)
    }
  }
}

function checkItemBoxes(track: Track, errs: string[]): void {
  checkBoxesAndPads(track, errs, 'itemBoxes', track.itemBoxes)
}

function checkBoostPads(track: Track, errs: string[]): void {
  checkBoxesAndPads(track, errs, 'boostPads', track.boostPads)
}

function checkRamps(track: Track, errs: string[]): void {
  for (let i = 0; i < track.ramps.length; i++) {
    const r = track.ramps[i]
    const okStart = Number.isFinite(r.sStart) && r.sStart >= 0 && r.sStart <= 1
    const okEnd = Number.isFinite(r.sEnd) && r.sEnd >= 0 && r.sEnd <= 1
    if (!okStart) errs.push(`ramps[${i}].sStart: must be within 0..1, got ${r.sStart}`)
    if (!okEnd) errs.push(`ramps[${i}].sEnd: must be within 0..1, got ${r.sEnd}`)
    if (okStart && okEnd && !(r.sStart < r.sEnd)) {
      errs.push(`ramps[${i}]: sStart ${r.sStart} must be less than sEnd ${r.sEnd}`)
    }
  }
}

function checkBounds(track: Track, errs: string[]): void {
  const min = track.bounds.min
  const max = track.bounds.max
  const cps = track.controlPoints
  for (let i = 0; i < cps.length; i++) {
    const p = cps[i].position
    if (!isFiniteVec(p)) continue
    if (p.x < min.x || p.y < min.y || p.z < min.z || p.x > max.x || p.y > max.y || p.z > max.z) {
      errs.push(`bounds: does not enclose controlPoints[${i}]`)
    }
  }
}

/**
 * Static validation of raw track data. Returns [] when the track is valid.
 * Runs without building the spline, so it can gate generated track JSON.
 */
export function validateTrack(track: Track): string[] {
  const errs: string[] = []
  checkControlPoints(track, errs)
  checkCheckpoints(track, errs)
  checkStartPositions(track, errs)
  checkItemBoxes(track, errs)
  checkBoostPads(track, errs)
  checkRamps(track, errs)
  checkBounds(track, errs)
  return errs
}

/** Samples per control point segment in the arc-length table. */
export const SAMPLES_PER_SEGMENT = 64

/** Longitudinal half-extent of a boost pad, in metres of centreline. */
export const BOOST_PAD_HALF_LENGTH = 4

/** A kart stays in bounds until it is this many half-widths off the centreline. */
export const BOUNDS_HALF_WIDTH_MUL = 2

/** Uniform Catmull-Rom, tension 1/2, interpolating p1 at u=0 and p2 at u=1. */
export function catmullRom(p0: number, p1: number, p2: number, p3: number, u: number): number {
  const u2 = u * u
  const u3 = u2 * u
  return (
    0.5 *
    (2 * p1 +
      (-p0 + p2) * u +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * u2 +
      (-p0 + 3 * p1 - 3 * p2 + p3) * u3)
  )
}

/** Derivative of the same curve with respect to u. Not normalised. */
function catmullRomDeriv(p0: number, p1: number, p2: number, p3: number, u: number): number {
  const u2 = u * u
  return (
    0.5 *
    (-p0 + p2 + 2 * (2 * p0 - 5 * p1 + 4 * p2 - p3) * u + 3 * (-p0 + 3 * p1 - 3 * p2 + p3) * u2)
  )
}

function wrapIndex(i: number, n: number): number {
  const m = i % n
  return m < 0 ? m + n : m
}

/** Fractional part of s in [0, 1). s wraps: the track is a closed loop. */
function wrap01(s: number): number {
  const w = s - Math.floor(s)
  return w === 1 ? 0 : w
}

/**
 * Position at segment parameter `t`: the integer part selects the segment, the fraction
 * runs from that control point to the next. `t` wraps modulo controlPoints.length.
 */
export function splinePointAt(track: Track, t: number, out: Vec3): void {
  const cps = track.controlPoints
  const n = cps.length
  const floor = Math.floor(t)
  const u = t - floor
  const seg = wrapIndex(floor, n)
  const a = cps[wrapIndex(seg - 1, n)].position
  const b = cps[seg].position
  const c = cps[wrapIndex(seg + 1, n)].position
  const d = cps[wrapIndex(seg + 2, n)].position
  out.x = catmullRom(a.x, b.x, c.x, d.x, u)
  out.y = catmullRom(a.y, b.y, c.y, d.y, u)
  out.z = catmullRom(a.z, b.z, c.z, d.z, u)
}

/** Unit tangent at segment parameter `t`. Falls back to +X on a degenerate segment. */
export function splineTangentAt(track: Track, t: number, out: Vec3): void {
  const cps = track.controlPoints
  const n = cps.length
  const floor = Math.floor(t)
  const u = t - floor
  const seg = wrapIndex(floor, n)
  const a = cps[wrapIndex(seg - 1, n)].position
  const b = cps[seg].position
  const c = cps[wrapIndex(seg + 1, n)].position
  const d = cps[wrapIndex(seg + 2, n)].position
  const dx = catmullRomDeriv(a.x, b.x, c.x, d.x, u)
  const dy = catmullRomDeriv(a.y, b.y, c.y, d.y, u)
  const dz = catmullRomDeriv(a.z, b.z, c.z, d.z, u)
  const len = Math.hypot(dx, dy, dz)
  if (len > 1e-12) {
    out.x = dx / len
    out.y = dy / len
    out.z = dz / len
  } else {
    out.x = 1
    out.y = 0
    out.z = 0
  }
}

/** Width at segment parameter `t`, linear between the two control points of the segment. */
export function widthAtSeg(track: Track, t: number): number {
  const cps = track.controlPoints
  const n = cps.length
  const floor = Math.floor(t)
  const u = t - floor
  const seg = wrapIndex(floor, n)
  const a = cps[seg].width
  const b = cps[wrapIndex(seg + 1, n)].width
  return a + (b - a) * u
}

/** Banking at segment parameter `t`, in radians, linear across the segment. */
export function bankingAtSeg(track: Track, t: number): number {
  const cps = track.controlPoints
  const n = cps.length
  const floor = Math.floor(t)
  const u = t - floor
  const seg = wrapIndex(floor, n)
  const a = cps[seg].banking
  const b = cps[wrapIndex(seg + 1, n)].banking
  return a + (b - a) * u
}

/** Surface of the segment containing `t`, taken from its start control point. */
export function surfaceOfSeg(track: Track, t: number): Surface {
  const cps = track.controlPoints
  return cps[wrapIndex(Math.floor(t), cps.length)].surface
}

/**
 * Flat sample cache for one track: `pts` holds SAMPLES_PER_SEGMENT positions per segment
 * plus one closing sample, `cum` holds the running chord length to each of them.
 * Sample index i corresponds to segment parameter t = i / samplesPerSegment.
 */
export interface ArcTable {
  pts: Float64Array
  cum: Float64Array
  samplesPerSegment: number
  segments: number
  total: number
}

/** Build the arc-length table for a track. Called once per query, never in the hot path. */
export function buildArcTable(track: Track): ArcTable {
  const segments = track.controlPoints.length
  const count = segments * SAMPLES_PER_SEGMENT + 1
  const pts = new Float64Array(count * 3)
  const cum = new Float64Array(count)
  const p = v3(0, 0, 0)
  for (let i = 0; i < count; i++) {
    splinePointAt(track, i / SAMPLES_PER_SEGMENT, p)
    pts[i * 3] = p.x
    pts[i * 3 + 1] = p.y
    pts[i * 3 + 2] = p.z
    if (i > 0) {
      const dx = pts[i * 3] - pts[(i - 1) * 3]
      const dy = pts[i * 3 + 1] - pts[(i - 1) * 3 + 1]
      const dz = pts[i * 3 + 2] - pts[(i - 1) * 3 + 2]
      cum[i] = cum[i - 1] + Math.hypot(dx, dy, dz)
    }
  }
  return { pts, cum, samplesPerSegment: SAMPLES_PER_SEGMENT, segments, total: cum[count - 1] }
}

/** Arc-normalised s (wrapping) -> segment parameter t. Binary search plus linear inset. */
export function locateS(table: ArcTable, s: number): number {
  const target = wrap01(s) * table.total
  const cum = table.cum
  let lo = 0
  let hi = cum.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (cum[mid] <= target) lo = mid
    else hi = mid
  }
  const span = cum[hi] - cum[lo]
  const f = span > 1e-12 ? (target - cum[lo]) / span : 0
  return (lo + f) / table.samplesPerSegment
}

/** Segment parameter t (wrapping) -> metres travelled from the start line. */
export function arcAt(table: ArcTable, t: number): number {
  const wrapped = t % table.segments
  const tt = wrapped < 0 ? wrapped + table.segments : wrapped
  const idx = tt * table.samplesPerSegment
  const lo = Math.min(Math.floor(idx), table.cum.length - 2)
  const f = idx - lo
  return table.cum[lo] + (table.cum[lo + 1] - table.cum[lo]) * f
}

/** Every 4th table sample is tested in the coarse pass, then its neighbourhood is refined. */
const COARSE_STRIDE = 4

/** Ternary-search steps. Each cuts the bracket to 2/3, so 40 steps reach ~1e-7 of a segment. */
const REFINE_ITERATIONS = 40

const projScratch = v3(0, 0, 0)
const projTangent = v3(0, 0, 0)

function distanceXZSq(track: Track, t: number, px: number, pz: number): number {
  splinePointAt(track, t, projScratch)
  const dx = projScratch.x - px
  const dz = projScratch.z - pz
  return dx * dx + dz * dz
}

/**
 * Closest point on the centreline to `p`, measured in the XZ plane so ride height never
 * leaks into the result. Coarse scan over the arc table, then a ternary search on the
 * winning bracket. Writes into `out`; allocates nothing.
 */
export function projectPoint(
  track: Track,
  table: ArcTable,
  p: Vec3,
  out: TrackProjection,
): void {
  const count = table.cum.length - 1 // the closing sample repeats index 0
  let bestIdx = 0
  let bestD2 = Infinity
  for (let i = 0; i < count; i += COARSE_STRIDE) {
    const dx = table.pts[i * 3] - p.x
    const dz = table.pts[i * 3 + 2] - p.z
    const d2 = dx * dx + dz * dz
    if (d2 < bestD2) {
      bestD2 = d2
      bestIdx = i
    }
  }
  for (let i = bestIdx - COARSE_STRIDE; i <= bestIdx + COARSE_STRIDE; i++) {
    const j = ((i % count) + count) % count
    const dx = table.pts[j * 3] - p.x
    const dz = table.pts[j * 3 + 2] - p.z
    const d2 = dx * dx + dz * dz
    if (d2 < bestD2) {
      bestD2 = d2
      bestIdx = j
    }
  }
  let lo = (bestIdx - 1) / table.samplesPerSegment
  let hi = (bestIdx + 1) / table.samplesPerSegment
  for (let i = 0; i < REFINE_ITERATIONS; i++) {
    const m1 = lo + (hi - lo) / 3
    const m2 = hi - (hi - lo) / 3
    if (distanceXZSq(track, m1, p.x, p.z) <= distanceXZSq(track, m2, p.x, p.z)) hi = m2
    else lo = m1
  }
  const t = (lo + hi) / 2
  splinePointAt(track, t, projScratch)
  const cx = projScratch.x
  const cz = projScratch.z
  splineTangentAt(track, t, projTangent)
  let rx = -projTangent.z
  let rz = projTangent.x
  const rl = Math.hypot(rx, rz)
  if (rl > 1e-12) {
    rx /= rl
    rz /= rl
  } else {
    rx = 0
    rz = 1
  }
  const dx = p.x - cx
  const dz = p.z - cz
  out.s = wrap01(arcAt(table, t) / table.total)
  out.lateral = dx * rx + dz * rz
  out.distance = Math.hypot(dx, dz)
}

/**
 * Build the runtime query for a track. The arc-length table is built once, here, so every
 * method is a table lookup plus a cubic evaluation.
 *
 * `sampleAt`, `tangentAt` and `project` each return the same scratch object on every call
 * and overwrite it in place: `step()` must not allocate in the hot path. Copy any field
 * you need to keep before calling the query again.
 */
export function buildTrackQuery(track: Track): TrackQuery {
  const table = buildArcTable(track)
  const point: TrackPoint = { position: v3(0, 0, 0), width: 0, banking: 0, surface: 'tarmac' }
  const tangent = v3(0, 0, 0)
  const projection: TrackProjection = { s: 0, lateral: 0, distance: 0 }
  const scratch = v3(0, 0, 0)
  const padHalfS = BOOST_PAD_HALF_LENGTH / table.total

  return {
    sampleAt(s: number): TrackPoint {
      const t = locateS(table, s)
      splinePointAt(track, t, point.position)
      point.width = widthAtSeg(track, t)
      point.banking = bankingAtSeg(track, t)
      point.surface = surfaceOfSeg(track, t)
      return point
    },

    tangentAt(s: number): Vec3 {
      splineTangentAt(track, locateS(table, s), tangent)
      return tangent
    },

    project(p: Vec3): TrackProjection {
      projectPoint(track, table, p, projection)
      return projection
    },

    groundHeight(s: number, lateral: number): number {
      const t = locateS(table, s)
      splinePointAt(track, t, scratch)
      // banking is a roll angle in radians; positive banking lifts the +lateral side
      return scratch.y + lateral * Math.tan(bankingAtSeg(track, t))
    },

    surfaceAt(s: number, lateral: number): Surface {
      const t = locateS(table, s)
      if (Math.abs(lateral) > widthAtSeg(track, t) / 2) return 'offtrack'
      const ws = wrap01(s)
      for (let i = 0; i < track.boostPads.length; i++) {
        const pad = track.boostPads[i]
        let ds = Math.abs(ws - pad.s)
        if (ds > 0.5) ds = 1 - ds // the loop is closed
        if (ds <= padHalfS && Math.abs(lateral - pad.lateral) <= pad.halfWidth) return 'boost'
      }
      return surfaceOfSeg(track, t)
    },

    isInBounds(s: number, lateral: number): boolean {
      const t = locateS(table, s)
      return Math.abs(lateral) <= (widthAtSeg(track, t) / 2) * BOUNDS_HALF_WIDTH_MUL
    },

    checkpointIndexAt(s: number): number {
      const ws = wrap01(s)
      const cs = track.checkpointS
      // before the first checkpoint means the last one, crossed on the previous lap.
      // validateTrack rejects an empty ring, so cs.length is at least 1 in a real race.
      let idx = cs.length - 1
      for (let i = 0; i < cs.length; i++) {
        if (cs[i] <= ws) idx = i
      }
      return idx
    },

    totalLength(): number {
      return table.total
    },
  }
}
