import { describe, expect, it } from 'vitest'

import type { Track, Vec3 } from '@tapkart/sim'
import {
  BOOST_PAD_HALF_LENGTH,
  arcAt,
  bankingAtSeg,
  buildArcTable,
  buildTrackQuery,
  itemBoxWorldPos,
  splinePointAt,
  splineTangentAt,
  surfaceOfSeg,
  widthAtSeg,
} from '@tapkart/sim'
// §2.6: sim's fixtures are outside @tapkart/sim's `exports` map, so a TEST reaches them
// by relative path. `src` never does.
import { makeContext } from '../../sim/test/fixtures/track-fixtures'

import type { MeshData, MeshBuildOptions } from '../src/mesh'
import {
  DEFAULT_MESH_OPTIONS,
  ROAD_DECAL_LIFT,
  buildBoostPadMesh,
  buildCheckpointMarkers,
  buildEdgeMarkers,
  buildRampMesh,
  buildTrackMesh,
  buildTrackScene,
  meshBounds,
  meshCounts,
} from '../src/mesh'
import { SHIPPED_TRACK_IDS, loadShippedTrack, makeThemeFixture } from './fixtures/render-fixtures'
// The barrel, to prove §4.11's new `export * from './mesh'` line is actually there.
import * as barrel from '../src/index'
import type {
  EdgeMarkerPlacement,
  MarkerPlacement,
  TrackScene,
  MeshBuildOptions as BarrelMeshBuildOptions,
  MeshData as BarrelMeshData,
} from '../src/index'

// String rows, so `it.each` passes each id as one argument. Never write an `it.each`
// table whose rows are arrays unless you mean them to be spread: `it.each([[], 42])`
// hands the `[]` row ZERO arguments and silently re-tests `undefined`. Labelled
// `[name, value]` rows are the form to reach for.
const IDS = [...SHIPPED_TRACK_IDS]

/**
 * Independent re-derivation of §4.3's pinned cross-section. The builder's own copy of
 * this arithmetic is module-private, so this is a second path rather than the same one:
 * if the builder spaces its steps differently, the y-vs-groundHeight assertion below
 * starts comparing a vertex against the ground height of a different lateral and fails.
 */
function lateralOf(track: Track, t: number, step: number, opts: MeshBuildOptions): number {
  const halfSpan = widthAtSeg(track, t) / 2 + opts.shoulderWidth
  return -halfSpan + (2 * halfSpan * step) / opts.lateralSteps
}

function smallestTriangleArea(mesh: MeshData): number {
  let smallest = Infinity
  const p = mesh.positions
  for (let k = 0; k < mesh.indices.length; k += 3) {
    const a = mesh.indices[k] * 3
    const b = mesh.indices[k + 1] * 3
    const c = mesh.indices[k + 2] * 3
    const ux = p[b] - p[a]
    const uy = p[b + 1] - p[a + 1]
    const uz = p[b + 2] - p[a + 2]
    const vx = p[c] - p[a]
    const vy = p[c + 1] - p[a + 1]
    const vz = p[c + 2] - p[a + 2]
    const area = 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx)
    if (area < smallest) smallest = area
  }
  return smallest
}

/**
 * `y` of triangle `k`'s geometric normal, `cross(b - a, c - a)`. Positive means the
 * triangle is wound CCW seen from above, i.e. front-facing.
 *
 * ADDED to the brief's suite. Winding is the one mesh defect CI is usually blind to and a
 * device never is: a surface wound the other way is backface-culled, so the player drives
 * over a hole in the world. `smallestTriangleArea` cannot see it — area is unsigned — and
 * neither can any count or any comparison against `groundHeight`, which is a function of
 * position alone and says nothing about the order vertices are joined in.
 */
function windingY(mesh: MeshData, k: number): number {
  const p = mesh.positions
  const a = mesh.indices[k] * 3
  const b = mesh.indices[k + 1] * 3
  const c = mesh.indices[k + 2] * 3
  // y component of cross(u, v) is u.z * v.x - u.x * v.z
  return (p[b + 2] - p[a + 2]) * (p[c] - p[a]) - (p[b] - p[a]) * (p[c + 2] - p[a + 2])
}

function smallestWindingY(mesh: MeshData): number {
  let smallest = Infinity
  for (let k = 0; k < mesh.indices.length; k += 3) {
    smallest = Math.min(smallest, windingY(mesh, k))
  }
  return smallest
}

function countInvertedWinding(mesh: MeshData): number {
  let inverted = 0
  for (let k = 0; k < mesh.indices.length; k += 3) {
    if (windingY(mesh, k) <= 0) inverted++
  }
  return inverted
}

describe('DEFAULT_MESH_OPTIONS', () => {
  // Stated numerically in §4.3 so two tasks cannot disagree about what "default" means.
  it('is exactly the four numbers the contract states', () => {
    expect(DEFAULT_MESH_OPTIONS).toEqual({
      ringsPerSegment: 8,
      lateralSteps: 6,
      shoulderWidth: 6,
      wallHeight: 0,
    })
  })
  it('ROAD_DECAL_LIFT is 0.02 m', () => {
    expect(ROAD_DECAL_LIFT).toBe(0.02)
  })
})

describe('buildTrackMesh over the six shipped tracks (Q34)', () => {
  it('exercises all six, so an empty id list cannot make this suite vacuous', () => {
    expect(IDS.length).toBe(6)
  })

  it.each(IDS)('%s: vertex and index counts match the pinned layout', (id) => {
    const track = loadShippedTrack(id)
    const opts = DEFAULT_MESH_OPTIONS
    const mesh = buildTrackMesh(track, opts)
    const rings = track.controlPoints.length * opts.ringsPerSegment
    const perRing = opts.lateralSteps + 1
    expect(mesh.positions.length).toBe(rings * perRing * 3)
    expect(mesh.normals.length).toBe(rings * perRing * 3)
    expect(mesh.colors.length).toBe(rings * perRing * 3)
    expect(mesh.uvs.length).toBe(rings * perRing * 2)
    // closed ribbon: the last ring connects back to ring 0, so it is `rings` bands, not
    // `rings - 1`. A builder that stops one ring short leaves a seam across the track.
    expect(mesh.indices.length).toBe(rings * opts.lateralSteps * 6)
    expect(mesh.indices instanceof Uint32Array).toBe(true)
  })

  /**
   * THE FLAGSHIP ASSERTION (§8.1 row 1, tolerance from Q31).
   *
   * The bug it catches: building the banked cross-section as a ROTATION about the
   * tangent (y = lateral * sin(banking)) instead of sim's LIFT (y = lateral *
   * tan(banking)). Both look plausible; only one matches the collision surface. On
   * caldera's 0.35 rad corners the two differ by 0.34 m at the outer edge — 340x this
   * tolerance — so the assertion fails hard rather than marginally. The next test
   * measures that difference explicitly, so this tolerance is never mistaken for one
   * that would pass anything.
   *
   * It also catches every s-vs-t confusion, because `s` here is arc-normalised and
   * `t` is a segment parameter running 0..controlPoints.length: swap them and the
   * lookup lands on a different part of the track entirely.
   *
   * Measured worst deviation over the six shipped tracks, all 17,864 ribbon vertices:
   * 9.33e-7 m, on redwood-rise — which is exactly half an ulp of Float32 at its 21.3 m
   * summit, i.e. the storage rounding and nothing else. A thousandfold inside the gate.
   */
  it.each(IDS)('%s: every vertex y equals query.groundHeight(s, lateral) to 1e-3', (id) => {
    const track = loadShippedTrack(id)
    const query = buildTrackQuery(track)
    const table = buildArcTable(track)
    const opts = DEFAULT_MESH_OPTIONS
    const mesh = buildTrackMesh(track, opts)
    const rings = track.controlPoints.length * opts.ringsPerSegment
    const perRing = opts.lateralSteps + 1

    let worst = 0
    for (let r = 0; r < rings; r++) {
      const t = r / opts.ringsPerSegment
      // arcAt returns METRES; s is arc-normalised [0, 1). The division is not optional.
      const s = arcAt(table, t) / table.total
      for (let i = 0; i < perRing; i++) {
        const lateral = lateralOf(track, t, i, opts)
        const y = mesh.positions[(r * perRing + i) * 3 + 1]
        const d = Math.abs(y - query.groundHeight(s, lateral))
        if (d > worst) worst = d
      }
    }
    expect(worst).toBeLessThan(1e-3)
  })

  /**
   * ADDED to the brief's suite: the other two axes of the same vertex.
   *
   * The flagship above compares only `y`, and `y` is `centre.y + lateral * tan(banking)`
   * — so on a ring whose banking is ZERO it is satisfied by ANY lateral spacing, and
   * glacier-pass and neon-district are unbanked over long stretches. That leaves the
   * cross-section itself — the thing `lateralOf` claims to re-derive — unchecked exactly
   * where the y-test goes blind. This pins x and z: the vertex must sit `lateral` metres
   * along the unit right vector from the centreline, which is false for any other
   * spacing, on flat track and banked alike.
   */
  it.each(IDS)('%s: every vertex sits `lateral` metres along the right vector', (id) => {
    const track = loadShippedTrack(id)
    const opts = DEFAULT_MESH_OPTIONS
    const mesh = buildTrackMesh(track, opts)
    const rings = track.controlPoints.length * opts.ringsPerSegment
    const perRing = opts.lateralSteps + 1
    const centre: Vec3 = { x: 0, y: 0, z: 0 }
    const tan: Vec3 = { x: 0, y: 0, z: 0 }

    let worst = 0
    for (let r = 0; r < rings; r++) {
      const t = r / opts.ringsPerSegment
      splinePointAt(track, t, centre)
      splineTangentAt(track, t, tan)
      // right = (-t.z, 0, t.x) normalised in XZ (contract §0); +lateral is right of travel
      const rl = Math.hypot(-tan.z, tan.x)
      const rx = -tan.z / rl
      const rz = tan.x / rl
      for (let i = 0; i < perRing; i++) {
        const lateral = lateralOf(track, t, i, opts)
        const vi = r * perRing + i
        worst = Math.max(
          worst,
          Math.abs(mesh.positions[vi * 3] - (centre.x + rx * lateral)),
          Math.abs(mesh.positions[vi * 3 + 2] - (centre.z + rz * lateral)),
        )
      }
    }
    expect(worst).toBeLessThan(1e-3)
  })

  // Proof that the gate above discriminates. Without this, "worst < 1e-3" is a claim
  // about float noise that nobody has checked can ever be violated.
  it('a rotated cross-section (sin instead of tan) misses the gate by two orders of magnitude', () => {
    const track = loadShippedTrack('caldera') // the steepest shipped banking, +/-0.35 rad
    const query = buildTrackQuery(track)
    const table = buildArcTable(track)
    const opts = DEFAULT_MESH_OPTIONS
    const centre = { x: 0, y: 0, z: 0 }
    let worstWrong = 0
    const rings = track.controlPoints.length * opts.ringsPerSegment
    for (let r = 0; r < rings; r++) {
      const t = r / opts.ringsPerSegment
      splinePointAt(track, t, centre)
      const s = arcAt(table, t) / table.total
      const bank = bankingAtSeg(track, t)
      for (let i = 0; i <= opts.lateralSteps; i++) {
        const lateral = lateralOf(track, t, i, opts)
        const wrongY = centre.y + lateral * Math.sin(bank) // the plausible wrong model
        const d = Math.abs(wrongY - query.groundHeight(s, lateral))
        if (d > worstWrong) worstWrong = d
      }
    }
    expect(worstWrong).toBeGreaterThan(0.1) // measured: 0.343 m
  })

  /**
   * §7.3's scratch-object trap: `query.sampleAt` and `tangentAt` return the SAME object
   * on every call. A builder that holds two samples at once gets one degenerate ring
   * after another and throws nothing — the mesh is simply collapsed. Zero-area
   * triangles are what that looks like from outside.
   */
  it.each(IDS)('%s: every triangle has non-zero area', (id) => {
    const mesh = buildTrackMesh(loadShippedTrack(id), DEFAULT_MESH_OPTIONS)
    expect(smallestTriangleArea(mesh)).toBeGreaterThan(1e-6)
  })

  /**
   * ADDED: winding, the defect no assertion above can see. A ribbon wound clockwise has
   * identical positions, identical normals, identical counts and identical unsigned
   * areas, and is then backface-culled on the device — the player drives over a hole in
   * the world.
   *
   * Scoped to the two bands either side of the centreline, and that scope is load-bearing
   * rather than timid: offsetting a ribbon around a corner TIGHTER THAN THE OFFSET folds
   * the inner edge over, and shipped content contains exactly that. glacier-pass's
   * hairpin at t = 45.0 has a centreline turn radius of 8.2 m while the ribbon reaches
   * 16.5 m either side, so 7 of its 4512 triangles are legitimately inverted (harbor-run,
   * 1 of 4416; the other four tracks, none). A blanket "every triangle" assertion is
   * therefore FALSE against real tracks — it was written that way first and these two
   * caught it. The centre bands reach at most halfSpan/3 = 6.3 m, inside the 8.1 m at
   * which glacier-pass's inside edge first reverses, so they never fold; and an index
   * order emitted backwards inverts every one of them.
   */
  it.each(IDS)('%s: the centre band of every ring is wound CCW seen from above', (id) => {
    const track = loadShippedTrack(id)
    const opts = DEFAULT_MESH_OPTIONS
    const mesh = buildTrackMesh(track, opts)
    const perRing = opts.lateralSteps + 1
    const mid = opts.lateralSteps / 2
    expect(Number.isInteger(mid)).toBe(true) // an odd lateralSteps has no centre band

    let checked = 0
    let worst = Infinity
    for (let k = 0; k < mesh.indices.length; k += 3) {
      // both triangles of band (ring, step) start at vertex ring * perRing + step
      const step = mesh.indices[k] % perRing
      if (step !== mid - 1 && step !== mid) continue
      checked++
      worst = Math.min(worst, windingY(mesh, k))
    }
    // non-vacuity: 2 bands x 2 triangles for every ring, or the filter above matched
    // nothing and `worst` is still Infinity
    expect(checked).toBe(track.controlPoints.length * opts.ringsPerSegment * 4)
    expect(worst).toBeGreaterThan(0)
  })

  /**
   * ADDED: and the fold stays a rounding error in the run-off rather than spreading.
   * Measured: 7/4512 on glacier-pass, 1/4416 on harbor-run, 0 on the other four — under
   * 0.16% at worst. This is the gate that would catch a shoulderWidth or a control point
   * that turned the ribbon inside out wholesale, and a backwards index order inverts
   * 100% of the ribbon rather than 0.16% of it.
   */
  it.each(IDS)('%s: fewer than 1% of triangles are inverted', (id) => {
    const mesh = buildTrackMesh(loadShippedTrack(id), DEFAULT_MESH_OPTIONS)
    const total = mesh.indices.length / 3
    expect(total).toBeGreaterThan(1000)
    expect(countInvertedWinding(mesh) / total).toBeLessThan(0.01)
  })

  /**
   * ADDED: shading normals, not just their length.
   *
   * "Every normal is unit length" below is satisfied by a normal pointing sideways or
   * straight down — and `cross(T, L)` instead of `cross(L, T)` is exactly the sign slip
   * that produces one. An inverted normal ships a road lit from underneath: black under
   * every light in the scene, and invisible to every count- and length-based assertion.
   */
  it.each(IDS)('%s: every ribbon normal faces upward', (id) => {
    const mesh = buildTrackMesh(loadShippedTrack(id), DEFAULT_MESH_OPTIONS)
    let worst = Infinity
    for (let i = 0; i < mesh.normals.length; i += 3) worst = Math.min(worst, mesh.normals[i + 1])
    expect(worst).toBeGreaterThan(0.5)
  })

  /**
   * Q19: `track.bounds` is a RENDER extent — `validateTrack` only asserts it encloses
   * the control points, and `sim` never uses it for containment (that is
   * `width * BOUNDS_HALF_WIDTH_MUL` in recovery.ts). So the ribbon must fit inside it,
   * and the ~40 m of clearance on every shipped track is what makes this a real test.
   *
   * The vacuity guard matters more than the containment: `meshBounds` of an EMPTY mesh
   * is min = +Infinity, max = -Infinity, which passes every containment comparison
   * trivially. Finiteness and a non-trivial extent are asserted first, so a builder
   * that emits nothing fails here instead of passing.
   */
  it.each(IDS)('%s: meshBounds(road) is finite, substantial, and inside track.bounds', (id) => {
    const track = loadShippedTrack(id)
    const b = meshBounds(buildTrackMesh(track, DEFAULT_MESH_OPTIONS))
    for (const v of [b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z]) {
      expect(Number.isFinite(v)).toBe(true)
    }
    expect(b.max.x - b.min.x).toBeGreaterThan(100)
    expect(b.max.z - b.min.z).toBeGreaterThan(100)
    expect(b.min.x).toBeGreaterThanOrEqual(track.bounds.min.x)
    expect(b.min.y).toBeGreaterThanOrEqual(track.bounds.min.y)
    expect(b.min.z).toBeGreaterThanOrEqual(track.bounds.min.z)
    expect(b.max.x).toBeLessThanOrEqual(track.bounds.max.x)
    expect(b.max.y).toBeLessThanOrEqual(track.bounds.max.y)
    expect(b.max.z).toBeLessThanOrEqual(track.bounds.max.z)
  })

  it('meshBounds of an empty mesh is +Infinity / -Infinity', () => {
    const empty: MeshData = {
      positions: new Float32Array(0),
      normals: new Float32Array(0),
      uvs: new Float32Array(0),
      colors: new Float32Array(0),
      indices: new Uint32Array(0),
    }
    expect(meshBounds(empty)).toEqual({
      min: { x: Infinity, y: Infinity, z: Infinity },
      max: { x: -Infinity, y: -Infinity, z: -Infinity },
    })
  })

  it.each(IDS)('%s: every normal is unit length', (id) => {
    const mesh = buildTrackMesh(loadShippedTrack(id), DEFAULT_MESH_OPTIONS)
    let worst = 0
    for (let i = 0; i < mesh.normals.length; i += 3) {
      const len = Math.hypot(mesh.normals[i], mesh.normals[i + 1], mesh.normals[i + 2])
      worst = Math.max(worst, Math.abs(len - 1))
    }
    expect(worst).toBeLessThan(1e-5)
  })

  /**
   * ADDED: the builders are handed no theme (§4.3 pins their signatures), so they write
   * the MULTIPLICATIVE IDENTITY. Nothing else in this file checks that: every colour
   * assertion runs through `buildTrackScene`, which overwrites all three passes, so a
   * builder that wrote 0,0,0 — black under a `vertexColors: true` material, for anyone
   * who calls these directly — would ship green.
   */
  it('caldera: the three mesh builders write the identity colour 1,1,1', () => {
    const track = loadShippedTrack('caldera')
    const query = buildTrackQuery(track)
    const meshes = [
      buildTrackMesh(track, DEFAULT_MESH_OPTIONS),
      buildBoostPadMesh(track, query),
      buildRampMesh(track, query, DEFAULT_MESH_OPTIONS),
    ]
    for (const mesh of meshes) {
      expect(mesh.colors.length).toBe(mesh.positions.length)
      expect(mesh.colors.length).toBeGreaterThan(0)
      let worst = 0
      for (let i = 0; i < mesh.colors.length; i++) worst = Math.max(worst, Math.abs(mesh.colors[i] - 1))
      expect(worst).toBe(0)
    }
  })

  // wallHeight 0 disables the pass; anything above it appends geometry AFTER the ribbon
  // so the pinned layout — and therefore the assertion above — still holds.
  it('a wall pass appends without disturbing one byte of the ribbon', () => {
    const track = loadShippedTrack('harbor-run')
    const flat = buildTrackMesh(track, DEFAULT_MESH_OPTIONS)
    const walled = buildTrackMesh(track, { ...DEFAULT_MESH_OPTIONS, wallHeight: 2 })
    const rings = track.controlPoints.length * DEFAULT_MESH_OPTIONS.ringsPerSegment
    const ribbonVerts = rings * (DEFAULT_MESH_OPTIONS.lateralSteps + 1)
    expect(walled.positions.length).toBe((ribbonVerts + rings * 4) * 3)
    for (let i = 0; i < ribbonVerts * 3; i++) {
      expect(walled.positions[i]).toBe(flat.positions[i])
    }
    for (let i = 0; i < flat.indices.length; i++) expect(walled.indices[i]).toBe(flat.indices[i])
    // every wall top sits exactly wallHeight above its own bottom
    for (let v = ribbonVerts; v < ribbonVerts + rings * 4; v += 2) {
      expect(walled.positions[(v + 1) * 3 + 1] - walled.positions[v * 3 + 1]).toBeCloseTo(2, 4)
      expect(walled.positions[(v + 1) * 3]).toBe(walled.positions[v * 3])
      expect(walled.positions[(v + 1) * 3 + 2]).toBe(walled.positions[v * 3 + 2])
    }
  })
})

describe('buildBoostPadMesh', () => {
  it.each(IDS)('%s: one quad per pad, lifted off the road', (id) => {
    const track = loadShippedTrack(id)
    const query = buildTrackQuery(track)
    const mesh = buildBoostPadMesh(track, query)
    const n = track.boostPads.length
    expect(n).toBeGreaterThan(0) // every shipped track has pads; §3's table
    expect(mesh.positions.length).toBe(n * 4 * 3)
    expect(mesh.indices.length).toBe(n * 6)
    expect(smallestTriangleArea(mesh)).toBeGreaterThan(1e-6)
    expect(smallestWindingY(mesh)).toBeGreaterThan(0) // ADDED: a decal wound away is unseen
  })

  /**
   * The bug: forgetting ROAD_DECAL_LIFT. A decal coplanar with the road z-fights, which
   * CI can never see and a device always can. The second half — that the pad sits at the
   * ground height for its OWN lateral, not the centreline's — catches a pad drawn flat
   * across a banked corner, which floats one edge into the air.
   */
  it('every corner sits exactly ROAD_DECAL_LIFT above its own ground height', () => {
    const track = loadShippedTrack('caldera')
    const query = buildTrackQuery(track)
    const mesh = buildBoostPadMesh(track, query)
    const halfS = BOOST_PAD_HALF_LENGTH / query.totalLength()
    for (let p = 0; p < track.boostPads.length; p++) {
      const pad = track.boostPads[p]
      for (let c = 0; c < 4; c++) {
        const sSide = c < 2 ? -1 : 1
        const lSide = c === 1 || c === 2 ? 1 : -1
        let s = pad.s + sSide * halfS
        s -= Math.floor(s)
        const lateral = pad.lateral + lSide * pad.halfWidth
        const y = mesh.positions[(p * 4 + c) * 3 + 1]
        expect(y - query.groundHeight(s, lateral)).toBeCloseTo(ROAD_DECAL_LIFT, 4)
      }
    }
  })
})

describe('buildRampMesh', () => {
  // neon-district ships ZERO ramps. A builder that assumes at least one produces a
  // zero-length buffer or throws; the contract says five zero-length arrays, no throw.
  it('neon-district has no ramps and yields five zero-length arrays', () => {
    const track = loadShippedTrack('neon-district')
    expect(track.ramps.length).toBe(0)
    const mesh = buildRampMesh(track, buildTrackQuery(track), DEFAULT_MESH_OPTIONS)
    expect(mesh.positions.length).toBe(0)
    expect(mesh.normals.length).toBe(0)
    expect(mesh.uvs.length).toBe(0)
    expect(mesh.colors.length).toBe(0)
    expect(mesh.indices.length).toBe(0)
  })

  it.each(IDS)('%s: one subdivided patch per ramp, on the road surface', (id) => {
    const track = loadShippedTrack(id)
    const query = buildTrackQuery(track)
    const opts = DEFAULT_MESH_OPTIONS
    const mesh = buildRampMesh(track, query, opts)
    const strips = opts.ringsPerSegment
    expect(mesh.positions.length).toBe(track.ramps.length * (strips + 1) * 2 * 3)
    expect(mesh.indices.length).toBe(track.ramps.length * strips * 6)
    if (track.ramps.length > 0) {
      expect(smallestTriangleArea(mesh)).toBeGreaterThan(1e-6)
      expect(smallestWindingY(mesh)).toBeGreaterThan(0) // ADDED
    }
    // every vertex is a decal on the road: ground height for its own lateral, plus lift
    for (let r = 0; r < track.ramps.length; r++) {
      const ramp = track.ramps[r]
      let span = ramp.sEnd - ramp.sStart
      if (span <= 0) span += 1
      for (let k = 0; k <= strips; k++) {
        let s = ramp.sStart + (span * k) / strips
        s -= Math.floor(s)
        const width = query.sampleAt(s).width
        for (let side = 0; side < 2; side++) {
          const lateral = (side === 0 ? -1 : 1) * (width / 2)
          const vi = r * (strips + 1) * 2 + k * 2 + side
          expect(mesh.positions[vi * 3 + 1] - query.groundHeight(s, lateral)).toBeCloseTo(
            ROAD_DECAL_LIFT,
            4,
          )
        }
      }
    }
  })
})

describe('buildCheckpointMarkers', () => {
  it.each(IDS)('%s: one per checkpointS, index 0 is the finish line', (id) => {
    const track = loadShippedTrack(id)
    const query = buildTrackQuery(track)
    const marks = buildCheckpointMarkers(track, query)
    expect(marks.length).toBe(track.checkpointS.length)
    expect(marks[0].s).toBe(track.checkpointS[0])
    for (let i = 0; i < marks.length; i++) {
      const s = track.checkpointS[i]
      expect(marks[i].s).toBe(s)
      // on the centreline, so y is exactly groundHeight(s, 0)
      expect(marks[i].position.y).toBeCloseTo(query.groundHeight(s, 0), 4)
      expect(marks[i].width).toBeCloseTo(query.sampleAt(s).width, 4)
      // heading is the centreline tangent's: forward = (cos h, 0, sin h)
      const tan = query.tangentAt(s)
      expect(Math.cos(marks[i].heading)).toBeCloseTo(tan.x / Math.hypot(tan.x, tan.z), 3)
      expect(Math.sin(marks[i].heading)).toBeCloseTo(tan.z / Math.hypot(tan.x, tan.z), 3)
    }
  })

  /**
   * ADDED: the x/z of the gate, which nothing above pins — every assertion in the test
   * above is on `s`, `y`, `width` or `heading`, so a marker parked at the world origin
   * passes all of them. A checkpoint gate drawn at (0, y, 0) is the most visible
   * possible defect and would have shipped.
   */
  it.each(IDS)('%s: each gate is on the centreline in x and z too', (id) => {
    const track = loadShippedTrack(id)
    const query = buildTrackQuery(track)
    const marks = buildCheckpointMarkers(track, query)
    for (let i = 0; i < marks.length; i++) {
      const pt = query.sampleAt(track.checkpointS[i])
      expect(marks[i].position.x).toBeCloseTo(pt.position.x, 4)
      expect(marks[i].position.z).toBeCloseTo(pt.position.z, 4)
    }
  })
})

describe('buildEdgeMarkers (Q20)', () => {
  it.each(IDS)('%s: both sides, alternating colours, standing on the ground', (id) => {
    const track = loadShippedTrack(id)
    const query = buildTrackQuery(track)
    const params = makeThemeFixture().edgeMarkers
    const posts = buildEdgeMarkers(track, query, params)

    const expected = Math.round(query.totalLength() / params.spacing)
    const left = posts.filter((p) => p.side === -1)
    const right = posts.filter((p) => p.side === 1)
    expect(Math.abs(left.length - expected)).toBeLessThanOrEqual(1)
    expect(right.length).toBe(left.length)
    expect(left.length).toBeGreaterThan(10)

    // colorIdx alternates 0,1,0,1... from 0 at s = 0, along each edge INDEPENDENTLY
    for (const side of [left, right]) {
      for (let i = 0; i < side.length; i++) expect(side[i].colorIdx).toBe((i % 2) as 0 | 1)
      for (let i = 1; i < side.length; i++) expect(side[i].s).toBeGreaterThan(side[i - 1].s)
    }

    /**
     * The bug this catches: placing posts at the centreline height, i.e. ignoring
     * banking. On caldera a post sits ~9.6 m off-centre where banking is 0.35 rad, so
     * it would float 3.5 m above the road — the single most visible geometry defect
     * available, and invisible to any test that only counted posts.
     */
    for (const p of posts) {
      const lateral = p.side * (query.sampleAt(p.s).width / 2 + params.offset)
      expect(Math.abs(p.position.y - query.groundHeight(p.s, lateral))).toBeLessThan(1e-3)
    }
  })

  it('is outboard of the road, on the correct side of travel', () => {
    // neon-district: the loop closest to a plane, so a post's XZ displacement is easy to
    // read. Banking does not enter this check at all — a post's x and z come from the
    // centreline and the right vector, and banking only moves y.
    const track = loadShippedTrack('neon-district')
    const query = buildTrackQuery(track)
    const posts = buildEdgeMarkers(track, query, makeThemeFixture().edgeMarkers)
    for (const p of posts.slice(0, 40)) {
      const pt = query.sampleAt(p.s)
      const cx = pt.position.x
      const cz = pt.position.z
      const half = pt.width / 2
      const tan = query.tangentAt(p.s)
      const rl = Math.hypot(-tan.z, tan.x)
      const rx = -tan.z / rl
      const rz = tan.x / rl
      // positive lateral is right of travel: right = (-t.z, 0, t.x) normalised
      const lateral = (p.position.x - cx) * rx + (p.position.z - cz) * rz
      expect(Math.sign(lateral)).toBe(p.side)
      expect(Math.abs(lateral)).toBeGreaterThan(half) // outboard of the drivable surface
    }
  })
})

describe('buildTrackScene', () => {
  it.each(IDS)('%s: assembles every pass and reports the MESH bounds, not track.bounds', (id) => {
    const track = loadShippedTrack(id)
    const theme = makeThemeFixture()
    const scene = buildTrackScene(makeContext(track), theme, DEFAULT_MESH_OPTIONS)
    expect(scene.checkpoints.length).toBe(track.checkpointS.length)
    expect(scene.boostPads.positions.length).toBe(track.boostPads.length * 12)
    expect(scene.ramps.indices.length).toBe(
      track.ramps.length * DEFAULT_MESH_OPTIONS.ringsPerSegment * 6,
    )
    expect(scene.edgeMarkers.length).toBeGreaterThan(20)
    // Q19 again: this is meshBounds(road), which is strictly inside track.bounds
    expect(scene.bounds).toEqual(meshBounds(scene.road))
    expect(scene.bounds.max.x).toBeLessThan(track.bounds.max.x)
  })

  /**
   * The bug: leaving the road white. `buildTrackMesh` is handed no theme (§4.3's
   * signature) so it writes the multiplicative identity 1,1,1; `buildTrackScene` is
   * where the palette lands. Without this test the whole road ships untinted and every
   * count-based assertion above still passes. caldera carries both tarmac and dirt
   * control points, so all three colours must appear.
   */
  it('caldera: road, dirt and shoulder vertices each carry their own theme colour', () => {
    const track = loadShippedTrack('caldera')
    const theme = makeThemeFixture()
    const opts = DEFAULT_MESH_OPTIONS
    const scene = buildTrackScene(makeContext(track), theme, opts)
    const rings = track.controlPoints.length * opts.ringsPerSegment
    const perRing = opts.lateralSteps + 1
    let sawRoad = 0
    let sawDirt = 0
    let sawShoulder = 0
    for (let r = 0; r < rings; r++) {
      const t = r / opts.ringsPerSegment
      const half = widthAtSeg(track, t) / 2
      const dirt = surfaceOfSeg(track, t) === 'dirt'
      for (let i = 0; i < perRing; i++) {
        const lateral = lateralOf(track, t, i, opts)
        const vi = r * perRing + i
        const got = [
          scene.road.colors[vi * 3],
          scene.road.colors[vi * 3 + 1],
          scene.road.colors[vi * 3 + 2],
        ]
        let want: readonly number[]
        if (Math.abs(lateral) > half) {
          want = theme.shoulder
          sawShoulder++
        } else if (dirt) {
          want = theme.roadDirt
          sawDirt++
        } else {
          want = theme.road
          sawRoad++
        }
        expect(got[0]).toBeCloseTo(want[0], 5)
        expect(got[1]).toBeCloseTo(want[1], 5)
        expect(got[2]).toBeCloseTo(want[2], 5)
      }
    }
    expect(sawRoad).toBeGreaterThan(0)
    expect(sawDirt).toBeGreaterThan(0)
    expect(sawShoulder).toBeGreaterThan(0)
  })

  /**
   * The other half of the same bug: pads and ramps left at the identity 1,1,1 and
   * coloured by the adapter's material instead. That ships the *right pixels* — white
   * times a material colour is that colour — so nothing looks wrong, and what actually
   * breaks is that "a boost pad is dirt-coloured" ends up living in the one file CI
   * never imports (§8.2), where the next mesh kind gets added without one. One code
   * path colours everything, here, and this is what holds it there.
   *
   * caldera carries 2 pads and 3 ramps; `makeThemeFixture` guarantees roadDirt and
   * shoulder differ, so a pass that coloured both from one field fails.
   */
  it('caldera: boost pads and ramps carry their own theme colour, not the identity', () => {
    const track = loadShippedTrack('caldera')
    const theme = makeThemeFixture()
    const scene = buildTrackScene(makeContext(track), theme, DEFAULT_MESH_OPTIONS)

    expect(track.boostPads.length).toBeGreaterThan(0)
    expect(track.ramps.length).toBeGreaterThan(0)
    expect(theme.roadDirt).not.toEqual(theme.shoulder)

    const passes = [
      ['boostPads', scene.boostPads, theme.roadDirt],
      ['ramps', scene.ramps, theme.shoulder],
    ] as const
    for (const [label, mesh, want] of passes) {
      const vertexCount = mesh.positions.length / 3
      expect(`${label}:${vertexCount > 0}`).toBe(`${label}:true`)
      expect(mesh.colors.length).toBe(vertexCount * 3)
      for (let vi = 0; vi < vertexCount; vi++) {
        expect(mesh.colors[vi * 3]).toBeCloseTo(want[0], 5)
        expect(mesh.colors[vi * 3 + 1]).toBeCloseTo(want[1], 5)
        expect(mesh.colors[vi * 3 + 2]).toBeCloseTo(want[2], 5)
      }
    }
  })

  /** neon-district has no ramps, so the colouring pass must be a no-op over five
   *  zero-length arrays rather than a throw or a read of `colors[0]`. */
  it('neon-district: colouring an empty ramp pass is a no-op', () => {
    const track = loadShippedTrack('neon-district')
    expect(track.ramps.length).toBe(0)
    const scene = buildTrackScene(makeContext(track), makeThemeFixture(), DEFAULT_MESH_OPTIONS)
    expect(scene.ramps.colors.length).toBe(0)
    expect(scene.ramps.positions.length).toBe(0)
  })

  /**
   * Item-box positions, and specifically their INDEX correspondence with
   * `RenderFrame.itemBoxAlpha`. Asserting the two arrays are the same length proves
   * nothing — that is the shape this project has shipped sixteen times — so this asserts
   * position-for-position identity against sim's own `itemBoxWorldPos`, which is the sole
   * writer of a box's position and the reason the drawn box and the pickup volume cannot
   * drift apart.
   *
   * The off-by-one witness at the end is what makes it a pairing test rather than a set
   * test: shipped boxes are at least 2 m apart on every track (measured), so a scene that
   * filled the array in any other order fails.
   */
  it.each(IDS)('%s: itemBoxes[i] is box i, at the position sim computes', (id) => {
    const track = loadShippedTrack(id)
    const ctx = makeContext(track)
    const scene = buildTrackScene(ctx, makeThemeFixture(), DEFAULT_MESH_OPTIONS)
    const n = track.itemBoxes.length
    expect(n).toBeGreaterThan(15)
    expect(scene.itemBoxes.length).toBe(n)

    const expected: Vec3[] = []
    for (let i = 0; i < n; i++) {
      const p: Vec3 = { x: 0, y: 0, z: 0 }
      itemBoxWorldPos(ctx, i, p)
      expected.push(p)
      expect(scene.itemBoxes[i].x).toBeCloseTo(p.x, 6)
      expect(scene.itemBoxes[i].y).toBeCloseTo(p.y, 6)
      expect(scene.itemBoxes[i].z).toBeCloseTo(p.z, 6)
    }

    // distinct objects: one shared `out` Vec3 would leave every box at the last position
    scene.itemBoxes[0].x += 1000
    expect(scene.itemBoxes[1].x).toBeCloseTo(expected[1].x, 6)
    scene.itemBoxes[0].x -= 1000

    // an off-by-one ordering must be detectable, or the identity above proves nothing
    let shifted = 0
    for (let i = 0; i < n; i++) {
      const other = expected[(i + 1) % n]
      const d = Math.hypot(
        scene.itemBoxes[i].x - other.x,
        scene.itemBoxes[i].y - other.y,
        scene.itemBoxes[i].z - other.z,
      )
      if (d > 0.5) shifted++
    }
    expect(shifted).toBe(n)
  })
})

/**
 * ADDED. §4.11's barrel line is part of this task's diff and nothing else in the package
 * covers it: `packages/render/test/` imports every module by relative path, so a missing
 * or misspelled `export * from './mesh'` leaves `@tapkart/render` without a single mesh
 * export and every test in this file still green. sim carries a barrel.test.ts for
 * exactly this reason; render had none.
 */
describe('the @tapkart/render barrel re-exports mesh (§4.11)', () => {
  it('carries all ten of the module’s runtime exports, by identity', () => {
    const expected = {
      DEFAULT_MESH_OPTIONS,
      ROAD_DECAL_LIFT,
      buildBoostPadMesh,
      buildCheckpointMarkers,
      buildEdgeMarkers,
      buildRampMesh,
      buildTrackMesh,
      buildTrackScene,
      meshBounds,
      meshCounts,
    }
    const names = Object.keys(expected) as (keyof typeof expected)[]
    expect(names.length).toBe(10) // §11's census: 10 values + 5 types = 15
    for (const name of names) {
      // identity, not presence: a re-implementation under the same name would pass
      // `toBeDefined()` and ship two copies of the geometry rules
      expect(barrel[name]).toBe(expected[name])
    }
  })

  // The five interfaces are compile-time only, so `tsc` is what checks them: this
  // function does not run, and referring to each type through the BARREL is the
  // assertion. It fails typecheck, not vitest, if a type stops being re-exported.
  it('re-exports the five interfaces too (enforced by tsc, not by this assertion)', () => {
    const useTypes = (
      a: BarrelMeshData,
      b: BarrelMeshBuildOptions,
      c: MarkerPlacement,
      d: EdgeMarkerPlacement,
      e: TrackScene,
    ): number => a.positions.length + b.lateralSteps + c.width + d.side + e.itemBoxes.length
    expect(typeof useTypes).toBe('function')
  })
})

describe('meshCounts', () => {
  it('sums vertices and triangles across a set', () => {
    const track = loadShippedTrack('harbor-run')
    const query = buildTrackQuery(track)
    const road = buildTrackMesh(track, DEFAULT_MESH_OPTIONS)
    const pads = buildBoostPadMesh(track, query)
    const counts = meshCounts([road, pads])
    expect(counts.vertices).toBe(road.positions.length / 3 + pads.positions.length / 3)
    expect(counts.triangles).toBe(road.indices.length / 3 + pads.indices.length / 3)
    expect(meshCounts([])).toEqual({ vertices: 0, triangles: 0 })
  })
})
