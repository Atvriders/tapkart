// PURE (contract §0a): no DOM, no GPU, no clock, no `three` import. Deterministic
// parametric meshes — same descriptor in, byte-identical MeshData out.
//
// The descriptor TYPES and PARSERS are @tapkart/content's (§3a.3): content is data +
// schema + parsers, render turns that data into triangles. `PaletteRGB` is content's
// too, so a palette is one type across all four packages.
//
// These meshes are built once, when content loads — never per frame — so the array
// growth here is outside §7.3's no-allocation rule, which governs the frame path.
import type { CharacterDescriptor, KartDescriptor, PaletteRGB } from '@tapkart/content'
import type { MeshData } from './mesh'

/** Radial segments in every cylinder and sphere. 8 puts a vertex at exactly 0 deg and
 *  90 deg, which is what makes meshBounds equal the declared radius exactly instead of
 *  r * cos(pi / 8) — the bounds identity the tests assert to 1e-6 depends on it. */
const RADIAL_SEGMENTS = 8

/** Polar stacks in the head sphere. 4 puts a ring exactly on the equator, so the
 *  sphere's XZ extent is exactly its radius. */
const SPHERE_STACKS = 4

/** Silhouette scales the body's XZ radius only. Height and head are untouched. */
const SILHOUETTE_XZ: Readonly<Record<CharacterDescriptor['silhouette'], number>> = {
  compact: 1,
  tall: 0.85,
  wide: 1.3,
}

interface MeshBuilder {
  positions: number[]
  normals: number[]
  uvs: number[]
  colors: number[]
  indices: number[]
}

function newBuilder(): MeshBuilder {
  return { positions: [], normals: [], uvs: [], colors: [], indices: [] }
}

function addVertex(
  b: MeshBuilder,
  x: number,
  y: number,
  z: number,
  nx: number,
  ny: number,
  nz: number,
  u: number,
  v: number,
  c: PaletteRGB,
): number {
  const index = b.positions.length / 3
  b.positions.push(x, y, z)
  b.normals.push(nx, ny, nz)
  b.uvs.push(u, v)
  b.colors.push(c[0], c[1], c[2])
  return index
}

function addTriangle(b: MeshBuilder, a: number, c: number, d: number): void {
  b.indices.push(a, c, d)
}

function toMesh(b: MeshBuilder): MeshData {
  return {
    positions: Float32Array.from(b.positions),
    normals: Float32Array.from(b.normals),
    uvs: Float32Array.from(b.uvs),
    colors: Float32Array.from(b.colors),
    indices: Uint32Array.from(b.indices),
  }
}

/** A capped cylinder about the Y axis, centred on (0, ·, 0). 34 vertices, 32 triangles,
 *  all wound CCW seen from outside. */
function addCylinderY(
  b: MeshBuilder,
  y0: number,
  y1: number,
  radius: number,
  side: PaletteRGB,
  cap: PaletteRGB,
): void {
  const sideBase = b.positions.length / 3
  for (let k = 0; k < RADIAL_SEGMENTS; k++) {
    const a = (k / RADIAL_SEGMENTS) * Math.PI * 2
    const cx = Math.cos(a)
    const cz = Math.sin(a)
    const u = k / RADIAL_SEGMENTS
    addVertex(b, cx * radius, y0, cz * radius, cx, 0, cz, u, 0, side)
    addVertex(b, cx * radius, y1, cz * radius, cx, 0, cz, u, 1, side)
  }
  for (let k = 0; k < RADIAL_SEGMENTS; k++) {
    const n = (k + 1) % RADIAL_SEGMENTS
    const a0 = sideBase + k * 2
    const a1 = a0 + 1
    const b0 = sideBase + n * 2
    const b1 = b0 + 1
    addTriangle(b, a0, b1, b0)
    addTriangle(b, a0, a1, b1)
  }

  const bottomCentre = addVertex(b, 0, y0, 0, 0, -1, 0, 0.5, 0.5, cap)
  const bottomRim = b.positions.length / 3
  for (let k = 0; k < RADIAL_SEGMENTS; k++) {
    const a = (k / RADIAL_SEGMENTS) * Math.PI * 2
    addVertex(
      b,
      Math.cos(a) * radius,
      y0,
      Math.sin(a) * radius,
      0,
      -1,
      0,
      0.5 + Math.cos(a) * 0.5,
      0.5 + Math.sin(a) * 0.5,
      cap,
    )
  }
  for (let k = 0; k < RADIAL_SEGMENTS; k++) {
    addTriangle(b, bottomCentre, bottomRim + k, bottomRim + ((k + 1) % RADIAL_SEGMENTS))
  }

  const topCentre = addVertex(b, 0, y1, 0, 0, 1, 0, 0.5, 0.5, cap)
  const topRim = b.positions.length / 3
  for (let k = 0; k < RADIAL_SEGMENTS; k++) {
    const a = (k / RADIAL_SEGMENTS) * Math.PI * 2
    addVertex(
      b,
      Math.cos(a) * radius,
      y1,
      Math.sin(a) * radius,
      0,
      1,
      0,
      0.5 + Math.cos(a) * 0.5,
      0.5 + Math.sin(a) * 0.5,
      cap,
    )
  }
  for (let k = 0; k < RADIAL_SEGMENTS; k++) {
    addTriangle(b, topCentre, topRim + ((k + 1) % RADIAL_SEGMENTS), topRim + k)
  }
}

/** A capped cylinder about the Z axis (a wheel), centred on (cx, cy, ·). Same 34/32
 *  budget as addCylinderY. */
function addCylinderZ(
  b: MeshBuilder,
  cx: number,
  cy: number,
  z0: number,
  z1: number,
  radius: number,
  side: PaletteRGB,
  cap: PaletteRGB,
): void {
  const sideBase = b.positions.length / 3
  for (let k = 0; k < RADIAL_SEGMENTS; k++) {
    const a = (k / RADIAL_SEGMENTS) * Math.PI * 2
    const nx = Math.cos(a)
    const ny = Math.sin(a)
    const u = k / RADIAL_SEGMENTS
    addVertex(b, cx + nx * radius, cy + ny * radius, z0, nx, ny, 0, u, 0, side)
    addVertex(b, cx + nx * radius, cy + ny * radius, z1, nx, ny, 0, u, 1, side)
  }
  for (let k = 0; k < RADIAL_SEGMENTS; k++) {
    const n = (k + 1) % RADIAL_SEGMENTS
    const a0 = sideBase + k * 2
    const a1 = a0 + 1
    const b0 = sideBase + n * 2
    const b1 = b0 + 1
    addTriangle(b, a0, b0, b1)
    addTriangle(b, a0, b1, a1)
  }

  const nearCentre = addVertex(b, cx, cy, z0, 0, 0, -1, 0.5, 0.5, cap)
  const nearRim = b.positions.length / 3
  for (let k = 0; k < RADIAL_SEGMENTS; k++) {
    const a = (k / RADIAL_SEGMENTS) * Math.PI * 2
    addVertex(
      b,
      cx + Math.cos(a) * radius,
      cy + Math.sin(a) * radius,
      z0,
      0,
      0,
      -1,
      0.5 + Math.cos(a) * 0.5,
      0.5 + Math.sin(a) * 0.5,
      cap,
    )
  }
  for (let k = 0; k < RADIAL_SEGMENTS; k++) {
    addTriangle(b, nearCentre, nearRim + ((k + 1) % RADIAL_SEGMENTS), nearRim + k)
  }

  const farCentre = addVertex(b, cx, cy, z1, 0, 0, 1, 0.5, 0.5, cap)
  const farRim = b.positions.length / 3
  for (let k = 0; k < RADIAL_SEGMENTS; k++) {
    const a = (k / RADIAL_SEGMENTS) * Math.PI * 2
    addVertex(
      b,
      cx + Math.cos(a) * radius,
      cy + Math.sin(a) * radius,
      z1,
      0,
      0,
      1,
      0.5 + Math.cos(a) * 0.5,
      0.5 + Math.sin(a) * 0.5,
      cap,
    )
  }
  for (let k = 0; k < RADIAL_SEGMENTS; k++) {
    addTriangle(b, farCentre, farRim + k, farRim + ((k + 1) % RADIAL_SEGMENTS))
  }
}

/** A low-poly sphere: two pole fans and (SPHERE_STACKS - 2) bands. 26 vertices, 48
 *  triangles, and no degenerate pole triangles — the fans are built as fans, not as a
 *  grid with collapsed rows. */
function addSphere(
  b: MeshBuilder,
  cx: number,
  cy: number,
  cz: number,
  radius: number,
  upper: PaletteRGB,
  lower: PaletteRGB,
): void {
  const north = addVertex(b, cx, cy + radius, cz, 0, 1, 0, 0.5, 1, upper)
  const ringBase = b.positions.length / 3
  const ringCount = SPHERE_STACKS - 1
  for (let j = 1; j < SPHERE_STACKS; j++) {
    const phi = (j / SPHERE_STACKS) * Math.PI
    const ry = Math.cos(phi)
    const rr = Math.sin(phi)
    for (let k = 0; k < RADIAL_SEGMENTS; k++) {
      const a = (k / RADIAL_SEGMENTS) * Math.PI * 2
      const nx = Math.cos(a) * rr
      const nz = Math.sin(a) * rr
      addVertex(
        b,
        cx + nx * radius,
        cy + ry * radius,
        cz + nz * radius,
        nx,
        ry,
        nz,
        k / RADIAL_SEGMENTS,
        1 - j / SPHERE_STACKS,
        ry > 0 ? upper : lower,
      )
    }
  }
  const south = addVertex(b, cx, cy - radius, cz, 0, -1, 0, 0.5, 0, lower)

  for (let k = 0; k < RADIAL_SEGMENTS; k++) {
    const n = (k + 1) % RADIAL_SEGMENTS
    addTriangle(b, north, ringBase + n, ringBase + k)
  }
  for (let j = 0; j < ringCount - 1; j++) {
    const upperRow = ringBase + j * RADIAL_SEGMENTS
    const lowerRow = upperRow + RADIAL_SEGMENTS
    for (let k = 0; k < RADIAL_SEGMENTS; k++) {
      const n = (k + 1) % RADIAL_SEGMENTS
      addTriangle(b, lowerRow + k, upperRow + n, lowerRow + n)
      addTriangle(b, lowerRow + k, upperRow + k, upperRow + n)
    }
  }
  const lastRow = ringBase + (ringCount - 1) * RADIAL_SEGMENTS
  for (let k = 0; k < RADIAL_SEGMENTS; k++) {
    const n = (k + 1) % RADIAL_SEGMENTS
    addTriangle(b, south, lastRow + k, lastRow + n)
  }
}

function addQuad(
  b: MeshBuilder,
  p0: readonly [number, number, number],
  p1: readonly [number, number, number],
  p2: readonly [number, number, number],
  p3: readonly [number, number, number],
  n: readonly [number, number, number],
  c: PaletteRGB,
): void {
  const i0 = addVertex(b, p0[0], p0[1], p0[2], n[0], n[1], n[2], 0, 0, c)
  const i1 = addVertex(b, p1[0], p1[1], p1[2], n[0], n[1], n[2], 1, 0, c)
  const i2 = addVertex(b, p2[0], p2[1], p2[2], n[0], n[1], n[2], 1, 1, c)
  const i3 = addVertex(b, p3[0], p3[1], p3[2], n[0], n[1], n[2], 0, 1, c)
  addTriangle(b, i0, i1, i2)
  addTriangle(b, i0, i2, i3)
}

/** An axis-aligned box with flat per-face normals: 24 vertices, 12 triangles. */
function addBox(
  b: MeshBuilder,
  x0: number,
  y0: number,
  z0: number,
  x1: number,
  y1: number,
  z1: number,
  side: PaletteRGB,
  top: PaletteRGB,
): void {
  addQuad(b, [x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [1, 0, 0], side)
  addQuad(b, [x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [-1, 0, 0], side)
  addQuad(b, [x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], [0, 1, 0], top)
  addQuad(b, [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [0, -1, 0], side)
  addQuad(b, [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1], side)
  addQuad(b, [x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [0, 0, -1], side)
}

/**
 * Deterministic parametric mesh from a character descriptor. 60 vertices, 80 triangles.
 *
 * Local space: feet on y = 0, `+y` up, centred on the XZ origin. Bounds are exactly
 * `(-xz, 0, -xz)` to `(xz, bodyHeight + 2 * headRadius, xz)` with
 * `xz = max(bodyRadius * silhouetteScale, headRadius)`.
 *
 * The palette lands as: body cylinder `primary`, head upper hemisphere `accent` (a
 * helmet), head lower hemisphere `secondary` (a face). All three appear; nothing else
 * does.
 */
export function buildCharacterMesh(desc: CharacterDescriptor): MeshData {
  const b = newBuilder()
  const bodyRadius = desc.bodyRadius * SILHOUETTE_XZ[desc.silhouette]
  addCylinderY(b, 0, desc.bodyHeight, bodyRadius, desc.palette.primary, desc.palette.primary)
  addSphere(
    b,
    0,
    desc.bodyHeight + desc.headRadius,
    0,
    desc.headRadius,
    desc.palette.accent,
    desc.palette.secondary,
  )
  return toMesh(b)
}

/**
 * Deterministic parametric mesh from a kart descriptor. 160 vertices, 140 triangles.
 *
 * Local space: `+x` forward, `+z` right, `+y` up, wheels standing on y = 0 (contract §0:
 * forward = (cos h, 0, sin h), right = (-t.z, 0, t.x)).
 *
 * Wheels are INBOARD — the outer face is flush with +/-chassisWidth/2 — so the drawn kart
 * is never wider than its declared chassis, and their axles sit at
 * `x = +/-(chassisLength/2 - wheelRadius)` so each wheel's own extent ends exactly at the
 * nose or tail. Bounds are therefore exactly `(-L/2, 0, -W/2)` to
 * `(L/2, max(wheelRadius + chassisHeight, 2 * wheelRadius), W/2)`.
 *
 * Palette: chassis `body`, chassis roof and wheel hubs `trim`, tyres `wheel`.
 */
export function buildKartMesh(desc: KartDescriptor): MeshData {
  const b = newBuilder()
  const halfLength = desc.chassisLength / 2
  const halfWidth = desc.chassisWidth / 2
  const axle = desc.wheelRadius // the chassis floor sits at axle height

  addBox(
    b,
    -halfLength,
    axle,
    -halfWidth,
    halfLength,
    axle + desc.chassisHeight,
    halfWidth,
    desc.palette.body,
    desc.palette.trim,
  )

  const wheelX = halfLength - desc.wheelRadius
  const xSigns: readonly number[] = [-1, 1]
  const zSigns: readonly number[] = [-1, 1]
  for (const sx of xSigns) {
    for (const sz of zSigns) {
      const outer = sz * halfWidth
      const inner = sz * (halfWidth - desc.wheelWidth)
      addCylinderZ(
        b,
        sx * wheelX,
        desc.wheelRadius,
        Math.min(inner, outer),
        Math.max(inner, outer),
        desc.wheelRadius,
        desc.palette.wheel,
        desc.palette.trim,
      )
    }
  }
  return toMesh(b)
}
