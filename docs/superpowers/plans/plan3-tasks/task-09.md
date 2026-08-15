### Task 9: `src/descriptors.ts` — descriptor meshes, pure

Spec §3: *"parametric low-poly meshes built in `render` from JSON descriptors. Eight
characters is eight JSON files, not eight modeled assets."* The descriptor **types and
parsers** live in `@tapkart/content` (§3a.3) because that is the package that ships and
validates the JSON; what stays here is the half that makes triangles.

Two functions, deterministic: same descriptor in, byte-identical `MeshData` out. No
randomness, no clock, no allocation policy — and no palette of `render`'s own: every
colour on these meshes comes from the descriptor.

**The geometry is pinned by an exact bounds identity**, because that is the only way a
headless test can tell a mesh built from the descriptor from a mesh that ignores it
(§8.1: *"`meshBounds` matches the descriptor's declared dimensions to `1e-6`"*):

- **Character**, origin at the feet, `+y` up: `min = (-xz, 0, -xz)`,
  `max = (xz, bodyHeight + 2 * headRadius, xz)` where
  `xz = max(bodyRadius * silhouetteScale, headRadius)` and `silhouetteScale` is
  **`compact: 1`, `tall: 0.85`, `wide: 1.3`**. The head is a sphere sitting on top of the
  body cylinder, centred at `bodyHeight + headRadius`.
- **Kart**, local space `+x` forward, `+z` right (contract §0: `forward = (cos h, 0,
  sin h)`, `right = (-t.z, 0, t.x)`), wheels on the ground at `y = 0`:
  `min = (-chassisLength/2, 0, -chassisWidth/2)`,
  `max = (chassisLength/2, max(wheelRadius + chassisHeight, 2 * wheelRadius), chassisWidth/2)`.
  Wheels are inboard — outer face flush with `±chassisWidth/2` — and their axles sit at
  `x = ±(chassisLength/2 - wheelRadius)`, so a wheel's own extent ends exactly at the
  chassis' nose and tail.

Both identities are exact under `Float32Array` storage because every cylinder and sphere
uses **8 radial segments** and the sphere **4 stacks**, which puts a vertex at exactly
0°, 90° and on the equator. Measured float32 error at these magnitudes: ≤ 2.4e-7, well
inside the 1e-6 gate.

**Files:**
- Create: `packages/render/src/descriptors.ts`
- Modify: `packages/render/src/index.ts:10-11` (append one `export *` line after `export * from './mesh'`)
- Test: `packages/render/test/descriptors.test.ts`

**Interfaces:**

- Consumes, from `@tapkart/content` (contract §3a.3, an earlier task) — types only:
  ```ts
  export type PaletteRGB = readonly [number, number, number]   // linear, 0..1
  export interface CharacterDescriptor {
    id: string; name: string
    bodyHeight: number           // metres, 0.4 – 1.4
    bodyRadius: number           // metres, 0.15 – 0.5
    headRadius: number           // metres, 0.1 – 0.4
    palette: { primary: PaletteRGB; secondary: PaletteRGB; accent: PaletteRGB }
    silhouette: 'compact' | 'tall' | 'wide'
  }
  export interface KartDescriptor {
    id: string; name: string
    chassisLength: number        // metres, 1.4 – 2.6
    chassisWidth: number         // metres, 0.9 – 1.6
    chassisHeight: number        // metres, 0.3 – 0.8
    wheelRadius: number          // metres, 0.2 – 0.45
    wheelWidth: number           // metres, 0.1 – 0.35
    palette: { body: PaletteRGB; trim: PaletteRGB; wheel: PaletteRGB }
  }
  ```
- Consumes, from `packages/render/src/mesh` (Task 8):
  ```ts
  export interface MeshData { positions: Float32Array; normals: Float32Array
    uvs: Float32Array; colors: Float32Array; indices: Uint32Array }
  export function meshBounds(mesh: MeshData): { min: Vec3; max: Vec3 }   // test only
  ```
- Consumes, from `packages/render/test/fixtures/render-fixtures` (Task 7, test-only):
  ```ts
  export function makeCharacterDescriptorFixture(): CharacterDescriptor
  export function makeKartDescriptorFixture(): KartDescriptor
  ```
- Produces — the 2 exports of `render/descriptors` (contract §11's census):
  ```ts
  export function buildCharacterMesh(desc: CharacterDescriptor): MeshData
  export function buildKartMesh(desc: KartDescriptor): MeshData
  ```

---

- [ ] **Step 1: Write the failing test**

Create `packages/render/test/descriptors.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import type { CharacterDescriptor, KartDescriptor } from '@tapkart/content'

import type { MeshData } from '../src/mesh'
import { meshBounds } from '../src/mesh'
import { buildCharacterMesh, buildKartMesh } from '../src/descriptors'
import {
  makeCharacterDescriptorFixture,
  makeKartDescriptorFixture,
} from './fixtures/render-fixtures'

/** The silhouette scale table, pinned by this task. The module's own copy is private,
 *  so this is the spec: change one and the other must follow, deliberately. */
const SILHOUETTE_XZ: Record<CharacterDescriptor['silhouette'], number> = {
  compact: 1,
  tall: 0.85,
  wide: 1.3,
}

function character(over: Partial<CharacterDescriptor>): CharacterDescriptor {
  return { ...makeCharacterDescriptorFixture(), ...over }
}

function kart(over: Partial<KartDescriptor>): KartDescriptor {
  return { ...makeKartDescriptorFixture(), ...over }
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

/** Every vertex colour must be one of the palette entries, and all of them must appear. */
function paletteUsage(mesh: MeshData, palette: readonly (readonly number[])[]): number[] {
  const hits = palette.map(() => 0)
  for (let v = 0; v < mesh.colors.length; v += 3) {
    let matched = -1
    for (let p = 0; p < palette.length; p++) {
      const c = palette[p]
      if (
        Math.abs(mesh.colors[v] - c[0]) < 1e-6 &&
        Math.abs(mesh.colors[v + 1] - c[1]) < 1e-6 &&
        Math.abs(mesh.colors[v + 2] - c[2]) < 1e-6
      ) {
        matched = p
        break
      }
    }
    expect(matched).toBeGreaterThanOrEqual(0)
    hits[matched]++
  }
  return hits
}

// Labelled `[name, value]` rows. NEVER write `it.each([someArray, other])` with bare
// array rows: vitest SPREADS an array row into arguments, so a `[]` row arrives as zero
// arguments and the case silently re-tests `undefined`.
const CHARACTER_CASES: readonly [string, CharacterDescriptor][] = [
  ['fixture', makeCharacterDescriptorFixture()],
  [
    'smallest declared, compact',
    character({ bodyHeight: 0.4, bodyRadius: 0.15, headRadius: 0.1, silhouette: 'compact' }),
  ],
  [
    'largest declared, tall',
    character({ bodyHeight: 1.4, bodyRadius: 0.5, headRadius: 0.4, silhouette: 'tall' }),
  ],
  [
    'head wider than the scaled body, tall',
    character({ bodyHeight: 1.1, bodyRadius: 0.15, headRadius: 0.4, silhouette: 'tall' }),
  ],
  ['wide silhouette', character({ bodyRadius: 0.4, silhouette: 'wide' })],
]

const KART_CASES: readonly [string, KartDescriptor][] = [
  ['fixture', makeKartDescriptorFixture()],
  [
    'smallest declared',
    kart({
      chassisLength: 1.4,
      chassisWidth: 0.9,
      chassisHeight: 0.3,
      wheelRadius: 0.2,
      wheelWidth: 0.1,
    }),
  ],
  [
    'largest declared',
    kart({
      chassisLength: 2.6,
      chassisWidth: 1.6,
      chassisHeight: 0.8,
      wheelRadius: 0.45,
      wheelWidth: 0.35,
    }),
  ],
  [
    'wheels taller than the chassis roof',
    kart({ chassisLength: 2, chassisWidth: 1.4, chassisHeight: 0.3, wheelRadius: 0.45 }),
  ],
]

describe('buildCharacterMesh', () => {
  it('emits the same low-poly budget for every descriptor', () => {
    const mesh = buildCharacterMesh(makeCharacterDescriptorFixture())
    expect(mesh.positions.length / 3).toBe(60) // 34 body + 26 head
    expect(mesh.indices.length).toBe(240) // 80 triangles
    expect(mesh.normals.length).toBe(mesh.positions.length)
    expect(mesh.colors.length).toBe(mesh.positions.length)
    expect(mesh.uvs.length).toBe((mesh.positions.length / 3) * 2)
  })

  /**
   * The bug this catches: a generator that builds a fixed unit figure and ignores the
   * descriptor (or applies its numbers to the wrong axis). Every count assertion above
   * passes under that bug. Sweeping the declared range and asserting the bounds ARE the
   * declared numbers is what sees it.
   */
  it.each(CHARACTER_CASES)('%s: meshBounds equals the declared dimensions to 1e-6', (_l, d) => {
    const b = meshBounds(buildCharacterMesh(d))
    const xz = Math.max(d.bodyRadius * SILHOUETTE_XZ[d.silhouette], d.headRadius)
    expect(b.min.x).toBeCloseTo(-xz, 6)
    expect(b.max.x).toBeCloseTo(xz, 6)
    expect(b.min.z).toBeCloseTo(-xz, 6)
    expect(b.max.z).toBeCloseTo(xz, 6)
    // feet on the ground plane: a character floating or sunk is invisible to CI otherwise
    expect(b.min.y).toBeCloseTo(0, 6)
    expect(b.max.y).toBeCloseTo(d.bodyHeight + 2 * d.headRadius, 6)
  })

  // Eight shipped characters differ by silhouette; if the field is ignored they are all
  // the same figure in eight palettes and nothing else in the suite notices.
  it('silhouette scales the body across XZ and nothing else', () => {
    const base = { bodyHeight: 1.2, bodyRadius: 0.45, headRadius: 0.2 }
    const wide = meshBounds(buildCharacterMesh(character({ ...base, silhouette: 'wide' })))
    const compact = meshBounds(buildCharacterMesh(character({ ...base, silhouette: 'compact' })))
    const tall = meshBounds(buildCharacterMesh(character({ ...base, silhouette: 'tall' })))
    expect(wide.max.x).toBeGreaterThan(compact.max.x)
    expect(compact.max.x).toBeGreaterThan(tall.max.x)
    expect(wide.max.y).toBeCloseTo(compact.max.y, 6)
    expect(tall.max.y).toBeCloseTo(compact.max.y, 6)
  })

  it('uses all three palette entries and no other colour', () => {
    const d = makeCharacterDescriptorFixture()
    const hits = paletteUsage(buildCharacterMesh(d), [
      d.palette.primary,
      d.palette.secondary,
      d.palette.accent,
    ])
    for (const h of hits) expect(h).toBeGreaterThan(0)
  })

  it('is deterministic: the same descriptor yields identical arrays', () => {
    const d = makeCharacterDescriptorFixture()
    const a = buildCharacterMesh(d)
    const b = buildCharacterMesh(d)
    expect(Array.from(a.positions)).toEqual(Array.from(b.positions))
    expect(Array.from(a.normals)).toEqual(Array.from(b.normals))
    expect(Array.from(a.colors)).toEqual(Array.from(b.colors))
    expect(Array.from(a.indices)).toEqual(Array.from(b.indices))
  })

  it.each(CHARACTER_CASES)('%s: no degenerate triangles, all normals unit length', (_l, d) => {
    const mesh = buildCharacterMesh(d)
    expect(smallestTriangleArea(mesh)).toBeGreaterThan(1e-9)
    for (let i = 0; i < mesh.normals.length; i += 3) {
      const len = Math.hypot(mesh.normals[i], mesh.normals[i + 1], mesh.normals[i + 2])
      expect(Math.abs(len - 1)).toBeLessThan(1e-5)
    }
  })
})

describe('buildKartMesh', () => {
  it('emits the same low-poly budget for every descriptor', () => {
    const mesh = buildKartMesh(makeKartDescriptorFixture())
    expect(mesh.positions.length / 3).toBe(160) // 24 chassis + 4 * 34 wheels
    expect(mesh.indices.length).toBe(420) // 140 triangles
    expect(mesh.normals.length).toBe(mesh.positions.length)
    expect(mesh.colors.length).toBe(mesh.positions.length)
    expect(mesh.uvs.length).toBe((mesh.positions.length / 3) * 2)
  })

  /**
   * Same bug class as the character sweep, plus two specific to a kart:
   *  - wheels mounted OUTSIDE the chassis, which makes the drawn kart wider than the
   *    0.9 m collision radius the sim uses and reads as karts overlapping on contact;
   *  - a body built around y = 0 instead of standing on it, which buries the kart in
   *    the road — the exact thing §8.3 says CI cannot see in pixels but can see here.
   */
  it.each(KART_CASES)('%s: meshBounds equals the declared dimensions to 1e-6', (_l, d) => {
    const b = meshBounds(buildKartMesh(d))
    expect(b.min.x).toBeCloseTo(-d.chassisLength / 2, 6)
    expect(b.max.x).toBeCloseTo(d.chassisLength / 2, 6)
    expect(b.min.z).toBeCloseTo(-d.chassisWidth / 2, 6)
    expect(b.max.z).toBeCloseTo(d.chassisWidth / 2, 6)
    expect(b.min.y).toBeCloseTo(0, 6) // wheels on the ground plane
    expect(b.max.y).toBeCloseTo(Math.max(d.wheelRadius + d.chassisHeight, 2 * d.wheelRadius), 6)
  })

  // Discrimination: change exactly one number and the mesh must move by exactly that
  // much. A generator that ignores the descriptor cannot fake this.
  it('tracks a single changed dimension exactly', () => {
    const narrow = meshBounds(buildKartMesh(kart({ chassisWidth: 1 })))
    const wide = meshBounds(buildKartMesh(kart({ chassisWidth: 1.5 })))
    expect(wide.max.z - narrow.max.z).toBeCloseTo(0.25, 6)
    expect(wide.max.x).toBeCloseTo(narrow.max.x, 6)
    const long = meshBounds(buildKartMesh(kart({ chassisLength: 2.4 })))
    const short = meshBounds(buildKartMesh(kart({ chassisLength: 1.6 })))
    expect(long.max.x - short.max.x).toBeCloseTo(0.4, 6)
  })

  it('uses all three palette entries and no other colour', () => {
    const d = makeKartDescriptorFixture()
    const hits = paletteUsage(buildKartMesh(d), [
      d.palette.body,
      d.palette.trim,
      d.palette.wheel,
    ])
    for (const h of hits) expect(h).toBeGreaterThan(0)
  })

  it('is deterministic: the same descriptor yields identical arrays', () => {
    const d = makeKartDescriptorFixture()
    const a = buildKartMesh(d)
    const b = buildKartMesh(d)
    expect(Array.from(a.positions)).toEqual(Array.from(b.positions))
    expect(Array.from(a.indices)).toEqual(Array.from(b.indices))
  })

  it.each(KART_CASES)('%s: no degenerate triangles, all normals unit length', (_l, d) => {
    const mesh = buildKartMesh(d)
    expect(smallestTriangleArea(mesh)).toBeGreaterThan(1e-9)
    for (let i = 0; i < mesh.normals.length; i += 3) {
      const len = Math.hypot(mesh.normals[i], mesh.normals[i + 1], mesh.normals[i + 2])
      expect(Math.abs(len - 1)).toBeLessThan(1e-5)
    }
  })

  // Four wheels, one per corner, all four distinct. A loop bug that builds the same
  // wheel four times leaves three of them hidden inside one and every count still adds up.
  it('places four distinct wheels, one per corner', () => {
    const d = makeKartDescriptorFixture()
    const mesh = buildKartMesh(d)
    const corners = new Set<string>()
    // wheel vertices follow the 24 chassis vertices, 34 per wheel
    for (let w = 0; w < 4; w++) {
      const v = (24 + w * 34) * 3
      corners.add(`${Math.sign(mesh.positions[v])}:${Math.sign(mesh.positions[v + 2])}`)
    }
    expect(corners.size).toBe(4)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/render/test/descriptors.test.ts`

Expected: FAIL to collect, with
`Error: Cannot find module '../src/descriptors' imported from '/home/kasm-user/tapkart/packages/render/test/descriptors.test.ts'`
(caused by `Failed to load url ../src/descriptors ... Does the file exist?`).

- [ ] **Step 3: Write the implementation**

Create `packages/render/src/descriptors.ts`:

```ts
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
```

Then modify `packages/render/src/index.ts` — append one line after `export * from './mesh'`:

```ts
export * from './types'
export * from './mesh'
export * from './descriptors'
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/render/test/descriptors.test.ts`
Expected: PASS — 27 tests (the two `it.each` sweeps expand to 5 and 4 cases each).

Then:

```bash
npm run typecheck --workspace @tapkart/render
npx vitest run
```

- [ ] **Step 5: Commit**

```bash
git add packages/render/src/descriptors.ts packages/render/src/index.ts \
        packages/render/test/descriptors.test.ts && \
git commit -m "feat(render): parametric character and kart meshes from descriptors

- buildCharacterMesh 60 verts / 80 tris, buildKartMesh 160 verts / 140 tris,
  deterministic and byte-identical for a given descriptor
- meshBounds equals the descriptor's declared dimensions to 1e-6, swept across the
  full declared range so a generator that ignores the descriptor cannot pass
- wheels inboard and standing on y = 0; palette entries are the only colours emitted"
```
