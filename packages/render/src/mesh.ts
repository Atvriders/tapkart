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
      // version (lateral * sin(banking)) is off by 0.30 m on caldera's 0.35 rad corners
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
export function buildRampMesh(track: Track, query: TrackQuery, opts: MeshBuildOptions): MeshData {
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
