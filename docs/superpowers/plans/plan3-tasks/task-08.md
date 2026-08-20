### Task 8: `src/mesh.ts` — track geometry, pure

The road ribbon, the boost-pad and ramp decals, the checkpoint gates and Q20's
procedural edge markers. All pure, all built once per race, none of them touching a
DOM, a GPU, a clock or `three`.

**`buildTrackMesh` is the sole producer of road-surface geometry.** Nothing else emits
triangles for the drivable surface, in any module, ever. That is what spec §3's "the
collision surface cannot drift from what the player sees" reduces to in code — and,
unusually, it is *assertable*: every generated vertex's `y` must equal
`query.groundHeight(s, lateral)` for its own `(s, lateral)`, to **`1e-3` world units**
(ruling Q31 — 1 mm, stated once in the contract precisely so two tasks do not pick two
tolerances).

**The tests run against the six shipped tracks, and that is required, not permitted
(ruling Q34).** `packages/render/test/` reads `content/tracks/*.json` from disk with
`node:fs` through the Task 7 fixture. Mesh-testing only a synthetic oval would mean the
six tracks players actually drive are never checked against the mesh generator at all.
This is not hypothetical: the track pipeline's own gates found a 1.3 m self-overlap in
`glacier-pass` precisely because they ran against real content instead of a fixture.
The six also carry the awkward cases a fixture would not — signed banking to ±0.35 rad
on `caldera`, **zero ramps** on `neon-district`, control-point `y` climbing 0 → 22 m on
`redwood-rise`, and widths from 15 m to 26 m.

**Contract amendment applied here (item boxes were undrawable).** `RenderFrame` carries
`itemBoxAlpha` (Q29's ghosting) so the adapter knows *how* to draw each box, but nothing
in the locked surface said *where* one is — so as written, the pickup the whole item
system depends on could not be drawn at all. `TrackScene` therefore gains
**`itemBoxes: Vec3[]`**, filled from `sim`'s `itemBoxWorldPos` at mesh-build time and
indexed so `itemBoxes[i]` and `itemBoxAlpha[i]` are the same box. They are static track
furniture — the positions come from track data and never move — so they belong to the
per-track scene, not the per-frame `RenderFrame`.

That forces one signature change, stated here rather than hidden: **`buildTrackScene`
takes `ctx: SimContext` in place of `(track, query)`.** `itemBoxWorldPos(ctx, boxIdx,
out)` is `sim`'s and is the **sole writer** of item-box world positions (§7.2) — the
drawn box and the pickup volume must be one object — and it needs a `SimContext`.
Re-deriving the formula in `render` would be exactly the second copy that rule exists to
prevent, and a cast to fake a context would break the moment `itemBoxWorldPos` reads
another field. `SimContext` carries both `track` and `query`, so the new signature is
also strictly narrower: it is no longer possible to hand this function a query built for
a different track. Every other builder keeps `(track, query, …)`.

**Vertex colours are the single source of track colour, and this file is the sole
writer.** `buildTrackMesh`, `buildBoostPadMesh` and `buildRampMesh` are handed no theme
(§4.3 pins their signatures) so they write the multiplicative identity `1,1,1`;
`buildTrackScene` then lands the palette on **every** mesh it returns — road, dirt,
shoulder and wall per vertex, boost pads `theme.roadDirt`, ramps `theme.shoulder`. The
adapter's materials are `vertexColors: true` over a white base and set no palette of
their own. Two reasons this side wins: `vertexColors: true` *multiplies*
`material.color` by the vertex colour, so a palette applied in both places ships the road
at `theme.road` squared — a 0.18 grey as 0.032, near-black; and "a boost pad is
dirt-coloured" is a game decision, which §0a forbids the adapter from holding and §8.2
keeps out of CI's reach entirely. One code path colours everything, and a mesh kind added
later cannot be forgotten by it.

**`s` is arc-normalised `[0, 1)`, never metres.** The spline helpers (`splinePointAt`,
`widthAtSeg`, `bankingAtSeg`, `surfaceOfSeg`) take `t`, a *segment parameter* whose
integer part selects the control point; `TrackQuery`'s methods take `s`. Mesh generation
walks `t` because it wants even geometry per segment; the test converts with
`s = arcAt(table, t) / table.total`. Mixing them silently produces a track mesh that does
not match the collision surface — the exact failure spec §3 says cannot happen.

**Files:**
- Create: `packages/render/src/mesh.ts`
- Modify: `packages/render/src/index.ts:9-10` (append one `export *` line after `export * from './types'`)
- Test: `packages/render/test/mesh.test.ts`

**Interfaces:**

- Consumes, from `@tapkart/sim`:
  ```ts
  export type Vec3 = { x: number; y: number; z: number }
  export type Surface = 'tarmac' | 'dirt' | 'boost' | 'offtrack'
  export interface TrackPoint { position: Vec3; width: number; banking: number; surface: Surface }
  export interface Track { id: string; name: string; controlPoints: TrackPoint[]
    checkpointS: number[]; itemBoxes: { s: number; lateral: number }[]
    ramps: { sStart: number; sEnd: number; launch: number }[]
    boostPads: { s: number; lateral: number; halfWidth: number }[]
    startPositions: { s: number; lateral: number }[]; bounds: { min: Vec3; max: Vec3 } }
  export interface TrackQuery {
    sampleAt(s: number): TrackPoint          // SCRATCH: same object every call
    tangentAt(s: number): Vec3               // SCRATCH: same object every call
    project(p: Vec3): TrackProjection        // SCRATCH: same object every call
    groundHeight(s: number, lateral: number): number
    surfaceAt(s: number, lateral: number): Surface
    isInBounds(s: number, lateral: number): boolean
    checkpointIndexAt(s: number): number
    totalLength(): number
  }
  export function splinePointAt(track: Track, t: number, out: Vec3): void
  export function splineTangentAt(track: Track, t: number, out: Vec3): void
  export function widthAtSeg(track: Track, t: number): number
  export function bankingAtSeg(track: Track, t: number): number
  export function surfaceOfSeg(track: Track, t: number): Surface
  export function buildTrackQuery(track: Track): TrackQuery
  export interface ArcTable { pts: Float64Array; cum: Float64Array
    samplesPerSegment: number; segments: number; total: number }
  export function buildArcTable(track: Track): ArcTable
  export function arcAt(table: ArcTable, t: number): number     // t -> METRES from the start line
  export const BOOST_PAD_HALF_LENGTH = 4                        // metres of centreline
  export interface SimContext { track: Track; query: TrackQuery; tuning: Tuning
    characters: CharacterStats[]; isLeader: boolean }
  /** Writes into `out` and returns void. Writes out.y = the CENTRELINE height, not
   *  groundHeight(s, lateral) — item boxes sit at centreline height even on banked
   *  track, and pickup is plan-view. Calls sampleAt and tangentAt internally, so it
   *  invalidates the shared scratch. SOLE WRITER of item-box world position (§7.2):
   *  the drawn box and the pickup volume are the same object. */
  export function itemBoxWorldPos(ctx: SimContext, boxIdx: number, out: Vec3): void
  ```
- Consumes, by **relative path** from the test only (contract §2.6):
  ```ts
  // packages/sim/test/fixtures/track-fixtures.ts
  export function makeContext(track: Track, isLeader?: boolean): SimContext
  ```
  and the identity the flagship assertion is written against, verbatim from
  `packages/sim/src/track.ts:491-496`:
  ```ts
  groundHeight(s, lateral) = splinePointAt(track, locateS(table, s)).y
                           + lateral * Math.tan(bankingAtSeg(track, locateS(table, s)))
  ```
- Consumes, from `@tapkart/content` (contract §3a.4, an earlier task) — types only:
  ```ts
  export type PaletteRGB = readonly [number, number, number]   // linear, 0..1
  export interface EdgeMarkerParams { spacing: number; height: number; offset: number
    colors: readonly [PaletteRGB, PaletteRGB] }
  export interface TrackTheme { trackId: string; road: PaletteRGB; roadDirt: PaletteRGB
    shoulder: PaletteRGB; wall: PaletteRGB; ground: PaletteRGB
    sky: { top: PaletteRGB; bottom: PaletteRGB }
    fog: { color: PaletteRGB; near: number; far: number }
    sunDirection: Vec3; ambient: number; edgeMarkers: EdgeMarkerParams }
  ```
- Consumes, from `packages/render/test/fixtures/render-fixtures` (Task 7, test-only):
  ```ts
  export const SHIPPED_TRACK_IDS: readonly string[]        // the six, ascending
  export function loadShippedTrack(id: string): Track      // node:fs + validateTrack
  export function makeThemeFixture(): TrackTheme           // road/roadDirt/shoulder all differ
  ```
- Produces — the 15 exports of `render/mesh` (contract §11's census for this module):
  ```ts
  export interface MeshData { positions: Float32Array; normals: Float32Array
    uvs: Float32Array; colors: Float32Array; indices: Uint32Array }
  export interface MeshBuildOptions { ringsPerSegment: number; lateralSteps: number
    shoulderWidth: number; wallHeight: number }
  export const DEFAULT_MESH_OPTIONS: Readonly<MeshBuildOptions>
  export function buildTrackMesh(track: Track, opts: MeshBuildOptions): MeshData
  export function buildBoostPadMesh(track: Track, query: TrackQuery): MeshData
  export function buildRampMesh(track: Track, query: TrackQuery, opts: MeshBuildOptions): MeshData
  export const ROAD_DECAL_LIFT = 0.02
  export interface MarkerPlacement { s: number; position: Vec3; heading: number; width: number }
  export function buildCheckpointMarkers(track: Track, query: TrackQuery): MarkerPlacement[]
  export interface EdgeMarkerPlacement { s: number; position: Vec3; heading: number
    side: -1 | 1; colorIdx: 0 | 1 }
  export function buildEdgeMarkers(track: Track, query: TrackQuery,
                                   params: EdgeMarkerParams): EdgeMarkerPlacement[]
  export interface TrackScene { road: MeshData; boostPads: MeshData; ramps: MeshData
    checkpoints: MarkerPlacement[]; edgeMarkers: EdgeMarkerPlacement[]
    itemBoxes: Vec3[]                    // one per track.itemBoxes, SAME INDEX as
                                         // RenderFrame.itemBoxAlpha and ItemBoxView.boxIdx
    bounds: { min: Vec3; max: Vec3 } }
  export function buildTrackScene(ctx: SimContext, theme: TrackTheme,
                                  opts: MeshBuildOptions): TrackScene
  export function meshBounds(mesh: MeshData): { min: Vec3; max: Vec3 }
  export function meshCounts(meshes: readonly MeshData[]): { vertices: number; triangles: number }
  ```

**Vertex layout, pinned by §4.3 and re-derived independently by the test:**
`buildTrackMesh` emits `controlPoints.length * ringsPerSegment` rings, ring `r` at
segment parameter `t = r / ringsPerSegment`, each ring holding `lateralSteps + 1`
vertices from `lateral = -(width/2 + shoulderWidth)` to `+(width/2 + shoulderWidth)`
inclusive, evenly spaced. The ribbon is closed: the last ring connects back to ring 0.
Vertex index is `ring * (lateralSteps + 1) + step`, and that index arithmetic is what
the test inverts to recover `(s, lateral)` for each vertex.

---

- [ ] **Step 1: Write the failing test**

Create `packages/render/test/mesh.test.ts`:

```ts
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
   * Measured worst deviation over the six shipped tracks: 9.4e-7 m (Float32 storage
   * rounding), a thousandfold inside the gate.
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
    if (track.ramps.length > 0) expect(smallestTriangleArea(mesh)).toBeGreaterThan(1e-6)
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
    const track = loadShippedTrack('neon-district') // zero banking, so the check is clean
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/render/test/mesh.test.ts`

Expected: FAIL to collect, with
`Error: Cannot find module '../src/mesh' imported from '<repo>/packages/render/test/mesh.test.ts'`
(caused by `Failed to load url ../src/mesh ... Does the file exist?`).

- [ ] **Step 3: Write the implementation**

Create `packages/render/src/mesh.ts`:

```ts
// PURE (contract §0a): no DOM, no GPU, no clock, no `three` import — not even a
// type-only one (§8.2). This module parses nothing and owns no data: `Track` and
// `TrackQuery` are sim's, `TrackTheme` and `EdgeMarkerParams` are content's, and all of
// them arrive as arguments. `content` is data + schema + parsers; `render` turns that
// data into triangles.
import type { SimContext, Track, TrackQuery, Vec3 } from '@tapkart/sim'
import {
  BOOST_PAD_HALF_LENGTH,
  bankingAtSeg,
  itemBoxWorldPos,
  splinePointAt,
  splineTangentAt,
  surfaceOfSeg,
  widthAtSeg,
} from '@tapkart/sim'
import type { EdgeMarkerParams, PaletteRGB, TrackTheme } from '@tapkart/content'

/** Plain, backend-agnostic geometry. 32-bit indices, so one MeshData per pass
 *  regardless of vertex count. */
export interface MeshData {
  positions: Float32Array // xyz triples, metres, world space
  normals: Float32Array // xyz triples, unit length
  uvs: Float32Array // uv pairs
  colors: Float32Array // rgb triples, linear 0..1
  indices: Uint32Array // triangle list, CCW front-facing
}

export interface MeshBuildOptions {
  ringsPerSegment: number // longitudinal subdivisions per control-point segment
  lateralSteps: number // cross-section subdivisions across the full width
  shoulderWidth: number // metres of run-off geometry beyond width/2, each side
  wallHeight: number // metres; 0 disables the wall pass
}

/** Stated numerically in the contract so two tasks cannot disagree about "default". */
export const DEFAULT_MESH_OPTIONS: Readonly<MeshBuildOptions> = {
  ringsPerSegment: 8,
  lateralSteps: 6,
  shoulderWidth: 6,
  wallHeight: 0,
}

/** Metres a decal (boost pad, ramp, start line) is lifted off the road to avoid
 *  z-fighting. */
export const ROAD_DECAL_LIFT = 0.02

export interface MarkerPlacement {
  s: number
  position: Vec3
  heading: number
  width: number
}

export interface EdgeMarkerPlacement {
  s: number
  position: Vec3
  heading: number // the centreline tangent's heading at that s
  side: -1 | 1 // -1 left edge, +1 right edge (+1 is +lateral)
  colorIdx: 0 | 1
}

export interface TrackScene {
  road: MeshData
  boostPads: MeshData
  ramps: MeshData
  checkpoints: MarkerPlacement[]
  edgeMarkers: EdgeMarkerPlacement[]
  /** One world position per `track.itemBoxes`, in the SAME index space as
   *  `RenderFrame.itemBoxAlpha` and `ItemBoxView.boxIdx`, so the adapter pairs a box
   *  with its ghost alpha by index and never looks anything up. Static track furniture:
   *  built once per track, never per frame. */
  itemBoxes: Vec3[]
  bounds: { min: Vec3; max: Vec3 } // meshBounds(road), NOT track.bounds (Q19)
}

/** Fractional part in [0, 1). `s` wraps: the track is a closed loop. */
function wrap01(s: number): number {
  const w = s - Math.floor(s)
  return w === 1 ? 0 : w
}

/** Unit right vector in XZ for a unit tangent: right = (-t.z, 0, t.x), normalised
 *  (contract §0). Positive lateral is right of travel. */
function rightVector(tan: Vec3, out: Vec3): void {
  let rx = -tan.z
  let rz = tan.x
  const len = Math.hypot(rx, rz)
  if (len > 1e-12) {
    rx /= len
    rz /= len
  } else {
    rx = 0
    rz = 1
  }
  out.x = rx
  out.y = 0
  out.z = rz
}

/** Surface normal of the banked ribbon: normalize(cross(L, T)) where L is the lateral
 *  direction (right.x, tan(banking), right.z) and T the unit tangent. Exactly +y on
 *  flat track. */
function surfaceNormal(right: Vec3, tan: Vec3, tanBank: number, out: Vec3): void {
  const lx = right.x
  const ly = tanBank
  const lz = right.z
  const nx = ly * tan.z - lz * tan.y
  const ny = lz * tan.x - lx * tan.z
  const nz = lx * tan.y - ly * tan.x
  const len = Math.hypot(nx, ny, nz)
  if (len > 1e-12) {
    out.x = nx / len
    out.y = ny / len
    out.z = nz / len
  } else {
    out.x = 0
    out.y = 1
    out.z = 0
  }
}

/** §4.3's pinned cross-section: `lateralSteps + 1` vertices from -halfSpan to +halfSpan
 *  inclusive, evenly spaced. Shared by the builder and the theme pass so the two cannot
 *  drift; the test re-derives it independently. */
function lateralAt(halfSpan: number, step: number, lateralSteps: number): number {
  return -halfSpan + (2 * halfSpan * step) / lateralSteps
}

function emptyMesh(): MeshData {
  return {
    positions: new Float32Array(0),
    normals: new Float32Array(0),
    uvs: new Float32Array(0),
    colors: new Float32Array(0),
    indices: new Uint32Array(0),
  }
}

function writeColor(colors: Float32Array, vi: number, c: PaletteRGB): void {
  colors[vi * 3] = c[0]
  colors[vi * 3 + 1] = c[1]
  colors[vi * 3 + 2] = c[2]
}

/** Every vertex of a decal pass one flat colour. The pad and ramp builders take no
 *  theme (§4.3 pins their signatures), so they write the multiplicative identity and
 *  `buildTrackScene` lands the palette here, exactly as it does for the road. */
function fillColor(mesh: MeshData, c: PaletteRGB): void {
  const vertexCount = mesh.positions.length / 3
  for (let vi = 0; vi < vertexCount; vi++) writeColor(mesh.colors, vi, c)
}

/**
 * The road ribbon: centreline + width profile + banking, evaluated on the same spline
 * `sim` derives ground height from. SOLE OWNER of road geometry — nothing else in the
 * repository emits triangles for the drivable surface.
 *
 * Layout (§4.3, pinned): `controlPoints.length * ringsPerSegment` rings, ring `r` at
 * segment parameter `t = r / ringsPerSegment`, `lateralSteps + 1` vertices per ring from
 * -(width/2 + shoulderWidth) to +(width/2 + shoulderWidth), vertex index
 * `ring * (lateralSteps + 1) + step`. Closed: the last ring bands back to ring 0.
 *
 * Colours are written as 1,1,1 — the multiplicative identity. This function is handed no
 * theme and `render` ships no palette of its own (§4.5); `buildTrackScene` applies the
 * theme.
 */
export function buildTrackMesh(track: Track, opts: MeshBuildOptions): MeshData {
  const rings = track.controlPoints.length * opts.ringsPerSegment
  const perRing = opts.lateralSteps + 1
  const ribbonVerts = rings * perRing
  const hasWall = opts.wallHeight > 0
  const wallVerts = hasWall ? rings * 4 : 0
  const vertexCount = ribbonVerts + wallVerts
  const triangles = rings * opts.lateralSteps * 2 + (hasWall ? rings * 4 : 0)

  const positions = new Float32Array(vertexCount * 3)
  const normals = new Float32Array(vertexCount * 3)
  const uvs = new Float32Array(vertexCount * 2)
  const colors = new Float32Array(vertexCount * 3)
  const indices = new Uint32Array(triangles * 3)

  const centre: Vec3 = { x: 0, y: 0, z: 0 }
  const tan: Vec3 = { x: 0, y: 0, z: 0 }
  const right: Vec3 = { x: 0, y: 0, z: 0 }
  const normal: Vec3 = { x: 0, y: 0, z: 0 }

  for (let r = 0; r < rings; r++) {
    const t = r / opts.ringsPerSegment
    splinePointAt(track, t, centre)
    splineTangentAt(track, t, tan)
    rightVector(tan, right)
    const halfSpan = widthAtSeg(track, t) / 2 + opts.shoulderWidth
    const tanBank = Math.tan(bankingAtSeg(track, t))
    surfaceNormal(right, tan, tanBank, normal)

    for (let i = 0; i < perRing; i++) {
      const lateral = lateralAt(halfSpan, i, opts.lateralSteps)
      const vi = r * perRing + i
      positions[vi * 3] = centre.x + right.x * lateral
      // sim's ground model, verbatim (track.ts:491-496): banking LIFTS the cross-section
      // by lateral * tan(banking); it does NOT rotate it about the tangent. The rotated
      // version (lateral * sin(banking)) is off by 0.34 m on caldera's 0.35 rad corners
      // and the mesh-vs-groundHeight test rejects it by two orders of magnitude.
      positions[vi * 3 + 1] = centre.y + lateral * tanBank
      positions[vi * 3 + 2] = centre.z + right.z * lateral
      normals[vi * 3] = normal.x
      normals[vi * 3 + 1] = normal.y
      normals[vi * 3 + 2] = normal.z
      uvs[vi * 2] = i / opts.lateralSteps
      uvs[vi * 2 + 1] = t
      colors[vi * 3] = 1
      colors[vi * 3 + 1] = 1
      colors[vi * 3 + 2] = 1
    }

    if (hasWall) {
      // Two vertical strips at the outer edges, appended AFTER every ribbon vertex so
      // the pinned layout above is untouched. Vertex pair index:
      // ribbonVerts + (sideIdx * rings + r) * 2, bottom then top.
      for (let sideIdx = 0; sideIdx < 2; sideIdx++) {
        const edgeStep = sideIdx === 0 ? 0 : opts.lateralSteps
        const src = (r * perRing + edgeStep) * 3
        const inward = sideIdx === 0 ? 1 : -1
        const base = ribbonVerts + (sideIdx * rings + r) * 2
        for (let k = 0; k < 2; k++) {
          const vi = base + k
          positions[vi * 3] = positions[src]
          positions[vi * 3 + 1] = positions[src + 1] + (k === 1 ? opts.wallHeight : 0)
          positions[vi * 3 + 2] = positions[src + 2]
          normals[vi * 3] = right.x * inward
          normals[vi * 3 + 1] = 0
          normals[vi * 3 + 2] = right.z * inward
          uvs[vi * 2] = k
          uvs[vi * 2 + 1] = t
          colors[vi * 3] = 1
          colors[vi * 3 + 1] = 1
          colors[vi * 3 + 2] = 1
        }
      }
    }
  }

  let w = 0
  for (let r = 0; r < rings; r++) {
    const next = (r + 1) % rings // closed loop
    for (let i = 0; i < opts.lateralSteps; i++) {
      const a = r * perRing + i
      const b = r * perRing + i + 1
      const c = next * perRing + i + 1
      const d = next * perRing + i
      // CCW seen from +y: (b - a) is +right, (c - a) is +tangent +right, and
      // cross(right, tangent) is +y.
      indices[w++] = a
      indices[w++] = b
      indices[w++] = c
      indices[w++] = a
      indices[w++] = c
      indices[w++] = d
    }
  }

  if (hasWall) {
    for (let sideIdx = 0; sideIdx < 2; sideIdx++) {
      for (let r = 0; r < rings; r++) {
        const next = (r + 1) % rings
        const b0 = ribbonVerts + (sideIdx * rings + r) * 2
        const b1 = ribbonVerts + (sideIdx * rings + next) * 2
        // Wound so the face points INWARD, matching the normals written above:
        // cross(up, tangent) = -right, cross(tangent, up) = +right.
        if (sideIdx === 0) {
          indices[w++] = b0
          indices[w++] = b1 + 1
          indices[w++] = b0 + 1
          indices[w++] = b0
          indices[w++] = b1
          indices[w++] = b1 + 1
        } else {
          indices[w++] = b0
          indices[w++] = b0 + 1
          indices[w++] = b1 + 1
          indices[w++] = b0
          indices[w++] = b1 + 1
          indices[w++] = b1
        }
      }
    }
  }

  return { positions, normals, uvs, colors, indices }
}

/**
 * Boost-pad quads, driven by `track.boostPads` and BOOST_PAD_HALF_LENGTH — NOT by
 * control-point `surface`, which never carries 'boost' (§3). One quad per pad, sitting
 * ROAD_DECAL_LIFT above the road surface at its own lateral, so a pad on a banked corner
 * lies in the road plane rather than across it.
 */
export function buildBoostPadMesh(track: Track, query: TrackQuery): MeshData {
  const pads = track.boostPads
  if (pads.length === 0) return emptyMesh()

  const positions = new Float32Array(pads.length * 4 * 3)
  const normals = new Float32Array(pads.length * 4 * 3)
  const uvs = new Float32Array(pads.length * 4 * 2)
  const colors = new Float32Array(pads.length * 4 * 3)
  const indices = new Uint32Array(pads.length * 6)

  const halfS = BOOST_PAD_HALF_LENGTH / query.totalLength()
  const tan: Vec3 = { x: 0, y: 0, z: 0 }
  const right: Vec3 = { x: 0, y: 0, z: 0 }
  const normal: Vec3 = { x: 0, y: 0, z: 0 }

  let w = 0
  for (let p = 0; p < pads.length; p++) {
    const pad = pads[p]
    for (let c = 0; c < 4; c++) {
      // corner order (s-,l-), (s-,l+), (s+,l+), (s+,l-): CCW seen from above
      const sSide = c < 2 ? -1 : 1
      const lSide = c === 1 || c === 2 ? 1 : -1
      const s = wrap01(pad.s + sSide * halfS)
      const lateral = pad.lateral + lSide * pad.halfWidth

      const pt = query.sampleAt(s)
      // §7.3: sampleAt returns the SAME object on every call. Copy before the next query.
      const cx = pt.position.x
      const cz = pt.position.z
      const bank = pt.banking
      const tv = query.tangentAt(s)
      tan.x = tv.x
      tan.y = tv.y
      tan.z = tv.z
      rightVector(tan, right)
      surfaceNormal(right, tan, Math.tan(bank), normal)

      const vi = p * 4 + c
      positions[vi * 3] = cx + right.x * lateral
      positions[vi * 3 + 1] = query.groundHeight(s, lateral) + ROAD_DECAL_LIFT
      positions[vi * 3 + 2] = cz + right.z * lateral
      normals[vi * 3] = normal.x
      normals[vi * 3 + 1] = normal.y
      normals[vi * 3 + 2] = normal.z
      uvs[vi * 2] = lSide < 0 ? 0 : 1
      uvs[vi * 2 + 1] = sSide < 0 ? 0 : 1
      colors[vi * 3] = 1
      colors[vi * 3 + 1] = 1
      colors[vi * 3 + 2] = 1
    }
    const a = p * 4
    indices[w++] = a
    indices[w++] = a + 1
    indices[w++] = a + 2
    indices[w++] = a
    indices[w++] = a + 2
    indices[w++] = a + 3
  }

  return { positions, normals, uvs, colors, indices }
}

/**
 * Ramp geometry from `track.ramps`. Empty `ramps` yields a MeshData whose five arrays
 * are all zero-length, never a throw (`neon-district` has none).
 *
 * `sim` does not raise the ground over a ramp — `applyRamps` writes `velocity.y` and
 * `airborne` and leaves the surface alone (`ground.ts:118-139`) — so a ramp is a decal
 * on the road, not a wedge above it. Raising it would put the drawn ramp above the
 * collision surface, which is the drift spec §3 forbids.
 *
 * Each ramp is subdivided into `opts.ringsPerSegment` longitudinal strips so it follows
 * the road. A single chord across a shipped ramp deviates from the real centreline by up
 * to 1.77 m (harbor-run; caldera's three are 0.26 – 0.28 m), and with a 0.02 m decal lift
 * that buries most of the ramp under the road it is meant to mark.
 */
export function buildRampMesh(
  track: Track,
  query: TrackQuery,
  opts: MeshBuildOptions,
): MeshData {
  const ramps = track.ramps
  if (ramps.length === 0) return emptyMesh()

  const strips = Math.max(1, opts.ringsPerSegment)
  const perRamp = (strips + 1) * 2
  const positions = new Float32Array(ramps.length * perRamp * 3)
  const normals = new Float32Array(ramps.length * perRamp * 3)
  const uvs = new Float32Array(ramps.length * perRamp * 2)
  const colors = new Float32Array(ramps.length * perRamp * 3)
  const indices = new Uint32Array(ramps.length * strips * 6)

  const tan: Vec3 = { x: 0, y: 0, z: 0 }
  const right: Vec3 = { x: 0, y: 0, z: 0 }
  const normal: Vec3 = { x: 0, y: 0, z: 0 }

  let w = 0
  for (let r = 0; r < ramps.length; r++) {
    const ramp = ramps[r]
    let span = ramp.sEnd - ramp.sStart
    // a ramp whose sStart exceeds its sEnd wraps through the start/finish line, exactly
    // as applyRamps reads it
    if (span <= 0) span += 1
    const base = r * perRamp

    for (let k = 0; k <= strips; k++) {
      const s = wrap01(ramp.sStart + (span * k) / strips)
      const pt = query.sampleAt(s)
      const cx = pt.position.x
      const cz = pt.position.z
      const half = pt.width / 2
      const bank = pt.banking
      const tv = query.tangentAt(s)
      tan.x = tv.x
      tan.y = tv.y
      tan.z = tv.z
      rightVector(tan, right)
      surfaceNormal(right, tan, Math.tan(bank), normal)

      for (let side = 0; side < 2; side++) {
        const lateral = (side === 0 ? -1 : 1) * half
        const vi = base + k * 2 + side
        positions[vi * 3] = cx + right.x * lateral
        positions[vi * 3 + 1] = query.groundHeight(s, lateral) + ROAD_DECAL_LIFT
        positions[vi * 3 + 2] = cz + right.z * lateral
        normals[vi * 3] = normal.x
        normals[vi * 3 + 1] = normal.y
        normals[vi * 3 + 2] = normal.z
        uvs[vi * 2] = side
        uvs[vi * 2 + 1] = k / strips
        colors[vi * 3] = 1
        colors[vi * 3 + 1] = 1
        colors[vi * 3 + 2] = 1
      }
    }

    for (let k = 0; k < strips; k++) {
      const a = base + k * 2 // left, this strip
      const b = a + 1 // right, this strip
      const c = a + 3 // right, next strip
      const d = a + 2 // left, next strip
      indices[w++] = a
      indices[w++] = b
      indices[w++] = c
      indices[w++] = a
      indices[w++] = c
      indices[w++] = d
    }
  }

  return { positions, normals, uvs, colors, indices }
}

/** Start/finish line and per-checkpoint gate placements, in world space. `s` is the
 *  checkpoint's own `track.checkpointS[i]`; index 0 is the finish line. On the
 *  centreline, so `position.y` is exactly `groundHeight(s, 0)`. */
export function buildCheckpointMarkers(track: Track, query: TrackQuery): MarkerPlacement[] {
  const out: MarkerPlacement[] = []
  for (let i = 0; i < track.checkpointS.length; i++) {
    const s = wrap01(track.checkpointS[i])
    const pt = query.sampleAt(s)
    // §7.3: copy before the next query call invalidates the scratch
    const px = pt.position.x
    const py = pt.position.y
    const pz = pt.position.z
    const width = pt.width
    const tv = query.tangentAt(s)
    // forward = (cos h, 0, sin h), contract §0
    const heading = Math.atan2(tv.z, tv.x)
    out.push({ s: track.checkpointS[i], position: { x: px, y: py, z: pz }, heading, width })
  }
  return out
}

/**
 * Q20's procedural edge markers: posts along both track edges, alternating colours,
 * generated from the existing spline plus the theme's parameters. They are a gameplay
 * cue, not decoration — a bare ribbon on a flat plane gives the player no speed cue and
 * no corner read.
 *
 * `side` is -1 for the left edge and +1 for the right (in the `right = (-t.z, 0, t.x)`
 * sense, so +1 is +lateral). `colorIdx` alternates 0,1,0,1... along each edge
 * INDEPENDENTLY, starting at 0 at s = 0. Posts sit at
 * `lateral = side * (width/2 + params.offset)` with `y = query.groundHeight(s, lateral)`.
 *
 * Order: every left post in ascending `s`, then every right post in ascending `s`.
 */
export function buildEdgeMarkers(
  track: Track,
  query: TrackQuery,
  params: EdgeMarkerParams,
): EdgeMarkerPlacement[] {
  // `track` is part of §4.3's pinned signature, kept so every builder takes the same
  // first argument. Everything this function needs — arc length, centreline, width,
  // banking — comes through `query`, which wraps this exact track.
  void track

  const total = query.totalLength()
  // `spacing` is metres of centreline, and `s` is arc-normalised, so `count` evenly
  // spaced values of `s` are evenly spaced in ARC LENGTH.
  const count = Math.max(1, Math.round(total / params.spacing))
  const out: EdgeMarkerPlacement[] = []
  const tan: Vec3 = { x: 0, y: 0, z: 0 }
  const right: Vec3 = { x: 0, y: 0, z: 0 }
  const sides: readonly (-1 | 1)[] = [-1, 1]

  for (const side of sides) {
    for (let i = 0; i < count; i++) {
      const s = i / count
      const pt = query.sampleAt(s)
      const cx = pt.position.x
      const cz = pt.position.z
      const width = pt.width
      const tv = query.tangentAt(s)
      tan.x = tv.x
      tan.y = tv.y
      tan.z = tv.z
      rightVector(tan, right)
      const lateral = side * (width / 2 + params.offset)
      out.push({
        s,
        position: {
          x: cx + right.x * lateral,
          y: query.groundHeight(s, lateral),
          z: cz + right.z * lateral,
        },
        heading: Math.atan2(tan.z, tan.x),
        side,
        colorIdx: (i % 2) as 0 | 1,
      })
    }
  }
  return out
}

/** `buildTrackMesh` writes 1,1,1; this is where the theme lands, and it is the only
 *  place road colour is written. Shoulder vertices are the ones beyond width/2; the road
 *  itself is `theme.road` or `theme.roadDirt` per the segment's own surface. 'boost' and
 *  'offtrack' never appear in control-point data (§3) — boost pads are their own pass. */
function applyRoadTheme(
  track: Track,
  road: MeshData,
  theme: TrackTheme,
  opts: MeshBuildOptions,
): void {
  const rings = track.controlPoints.length * opts.ringsPerSegment
  const perRing = opts.lateralSteps + 1
  for (let r = 0; r < rings; r++) {
    const t = r / opts.ringsPerSegment
    const halfWidth = widthAtSeg(track, t) / 2
    const halfSpan = halfWidth + opts.shoulderWidth
    const surfaceColor = surfaceOfSeg(track, t) === 'dirt' ? theme.roadDirt : theme.road
    for (let i = 0; i < perRing; i++) {
      const lateral = lateralAt(halfSpan, i, opts.lateralSteps)
      writeColor(
        road.colors,
        r * perRing + i,
        Math.abs(lateral) <= halfWidth ? surfaceColor : theme.shoulder,
      )
    }
  }
  const vertexCount = road.positions.length / 3
  for (let vi = rings * perRing; vi < vertexCount; vi++) writeColor(road.colors, vi, theme.wall)
}

/**
 * Everything the backend needs for one track, built once per race.
 *
 * Takes a `SimContext` rather than `(track, query)` because `itemBoxWorldPos` — sim's,
 * and the sole writer of item-box world position (§7.2) — needs one. That also makes it
 * impossible to hand this function a query built for a different track than the boxes.
 */
export function buildTrackScene(
  ctx: SimContext,
  theme: TrackTheme,
  opts: MeshBuildOptions,
): TrackScene {
  const track = ctx.track
  const query = ctx.query
  const road = buildTrackMesh(track, opts)
  applyRoadTheme(track, road, theme, opts)

  // Every mesh this function returns leaves here carrying its colour in its VERTICES.
  // That is §7.2's sole-writer rule applied to colour: the adapter's materials are
  // `vertexColors: true` over a white base and set no palette, so nothing downstream can
  // multiply a second palette into the first, and a mesh kind added later cannot be
  // forgotten by a colouring pass that lives in a file the tests never import.
  const boostPads = buildBoostPadMesh(track, query)
  fillColor(boostPads, theme.roadDirt)
  const ramps = buildRampMesh(track, query, opts)
  fillColor(ramps, theme.shoulder)

  // Index i is boxIdx i, which is the index RenderFrame.itemBoxAlpha uses. Each call
  // gets its own Vec3: itemBoxWorldPos writes into `out`, and one shared out would leave
  // every box at the last one's position.
  const itemBoxes: Vec3[] = []
  for (let i = 0; i < track.itemBoxes.length; i++) {
    const p: Vec3 = { x: 0, y: 0, z: 0 }
    itemBoxWorldPos(ctx, i, p)
    itemBoxes.push(p)
  }

  return {
    road,
    boostPads,
    ramps,
    checkpoints: buildCheckpointMarkers(track, query),
    edgeMarkers: buildEdgeMarkers(track, query, theme.edgeMarkers),
    itemBoxes,
    // Q19: track.bounds is a declared render extent and is much larger than the ribbon.
    // What the camera and the ground plane want is the extent of what was actually built.
    bounds: meshBounds(road),
  }
}

/** Axis-aligned bounds of a MeshData. An empty MeshData returns min = +Infinity,
 *  max = -Infinity in every axis. */
export function meshBounds(mesh: MeshData): { min: Vec3; max: Vec3 } {
  const min: Vec3 = { x: Infinity, y: Infinity, z: Infinity }
  const max: Vec3 = { x: -Infinity, y: -Infinity, z: -Infinity }
  const p = mesh.positions
  for (let i = 0; i < p.length; i += 3) {
    if (p[i] < min.x) min.x = p[i]
    if (p[i + 1] < min.y) min.y = p[i + 1]
    if (p[i + 2] < min.z) min.z = p[i + 2]
    if (p[i] > max.x) max.x = p[i]
    if (p[i + 1] > max.y) max.y = p[i + 1]
    if (p[i + 2] > max.z) max.z = p[i + 2]
  }
  return { min, max }
}

/** Sums vertex and triangle counts across a set. Test-facing, but exported because the
 *  adapter also reports it through RendererStats. */
export function meshCounts(meshes: readonly MeshData[]): { vertices: number; triangles: number } {
  let vertices = 0
  let triangles = 0
  for (const m of meshes) {
    vertices += m.positions.length / 3
    triangles += m.indices.length / 3
  }
  return { vertices, triangles }
}
```

Then modify `packages/render/src/index.ts` — append one line after `export * from './types'`
(contract §4.11's order is types, mesh, descriptors, camera, frame, hud, audio,
smoothing, backend):

```ts
export * from './types'
export * from './mesh'
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/render/test/mesh.test.ts`
Expected: PASS — 79 tests (most are `it.each` over the six shipped tracks), in roughly
1 s.

Then:

```bash
npm run typecheck --workspace @tapkart/render
npx vitest run
```

- [ ] **Step 5: Commit**

```bash
git add packages/render/src/mesh.ts packages/render/src/index.ts \
        packages/render/test/mesh.test.ts && \
git commit -m "feat(render): track geometry, asserted against sim's ground surface

- buildTrackMesh is the sole producer of road geometry; every vertex y is within
  1e-3 m (Q31) of query.groundHeight(s, lateral) on all six shipped tracks (Q34)
- banking lifts the cross-section (lateral * tan) exactly as sim's ground model does;
  the suite carries a witness proving a rotated cross-section misses by 0.34 m
- boost pads, subdivided ramp decals (zero ramps yields five empty arrays),
  checkpoint markers, Q20 procedural edge markers, meshBounds/meshCounts
- buildTrackScene applies the theme to EVERY mesh it returns -- road, boost pads and
  ramps -- into vertex colours, and reports meshBounds(road), not track.bounds (Q19).
  The adapter's materials are vertexColors over a white base and set no palette: two
  palettes multiply, and the road would ship at theme.road squared
- TrackScene.itemBoxes (amendment): world positions from sim's itemBoxWorldPos, index
  for index with RenderFrame.itemBoxAlpha, without which item boxes were undrawable;
  buildTrackScene now takes a SimContext, which is what itemBoxWorldPos requires"
```
