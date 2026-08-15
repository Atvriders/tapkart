import { describe, expect, it } from 'vitest'

import type { CharacterDescriptor, KartDescriptor, PaletteRGB } from '@tapkart/content'
import { loadContentBundle } from '@tapkart/content'

import type { MeshData } from '../src/mesh'
import { meshBounds } from '../src/mesh'
import { buildCharacterMesh, buildKartMesh } from '../src/descriptors'
// The barrel, to prove §4.11's new `export * from './descriptors'` line is actually
// there: every other import in this file reaches `src` by relative path, so a missing or
// misspelled barrel line leaves `@tapkart/render` without either builder and every other
// assertion here still green.
import * as barrel from '../src/index'
import {
  makeCharacterDescriptorFixture,
  makeKartDescriptorFixture,
} from './fixtures/render-fixtures'

/** The silhouette scale table, pinned by this task. The module's own copy is private,
 *  so this is the spec: change one and the other must follow, deliberately.
 *
 *  RECOMPUTE, declared as one: the bounds sweeps below multiply by this table exactly as
 *  the builder does, so they cannot catch a wrong SCALE VALUE — only a builder that
 *  ignores the field, applies it to the wrong axis, or clamps it. The independent check
 *  on the values themselves is `keeps every shipped compact silhouette narrower than
 *  every shipped wide one`, which asserts an ORDERING over the shipped eight and never
 *  names 1 / 0.85 / 1.3. */
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

/**
 * The worst agreement, over every triangle, between the WINDING normal (the cross
 * product of two edges, which is what a GPU culls by) and the average of the triangle's
 * three VERTEX normals (which is what a shader lights by).
 *
 * ADDED. A mesh wound inside-out has unit-length normals, exact bounds, non-degenerate
 * triangles and the right vertex count: every other assertion in this file passes while
 * the kart is invisible under backface culling and lit from within. Nothing else here
 * can see it.
 */
function worstWindingAgreement(mesh: MeshData): number {
  let worst = Infinity
  const p = mesh.positions
  const n = mesh.normals
  for (let k = 0; k < mesh.indices.length; k += 3) {
    const ia = mesh.indices[k]
    const ib = mesh.indices[k + 1]
    const ic = mesh.indices[k + 2]
    const a = ia * 3
    const b = ib * 3
    const c = ic * 3
    const ux = p[b] - p[a]
    const uy = p[b + 1] - p[a + 1]
    const uz = p[b + 2] - p[a + 2]
    const vx = p[c] - p[a]
    const vy = p[c + 1] - p[a + 1]
    const vz = p[c + 2] - p[a + 2]
    const gx = uy * vz - uz * vy
    const gy = uz * vx - ux * vz
    const gz = ux * vy - uy * vx
    const glen = Math.hypot(gx, gy, gz)
    const ax = (n[a] + n[b] + n[c]) / 3
    const ay = (n[a + 1] + n[b + 1] + n[c + 1]) / 3
    const az = (n[a + 2] + n[b + 2] + n[c + 2]) / 3
    const alen = Math.hypot(ax, ay, az)
    const dot = glen > 0 && alen > 0 ? (gx * ax + gy * ay + gz * az) / (glen * alen) : -1
    if (dot < worst) worst = dot
  }
  return worst
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

function isColor(mesh: MeshData, vertex: number, c: PaletteRGB): boolean {
  return (
    Math.abs(mesh.colors[vertex * 3] - c[0]) < 1e-6 &&
    Math.abs(mesh.colors[vertex * 3 + 1] - c[1]) < 1e-6 &&
    Math.abs(mesh.colors[vertex * 3 + 2] - c[2]) < 1e-6
  )
}

/**
 * ADDED. Buffer-level integrity that no bounds or count assertion can see: an index that
 * points past the end of the vertex buffer is a GPU crash, an orphaned vertex is an
 * indexing bug that still adds up, and a UV outside [0, 1] wraps a texture the artist
 * never meant to tile.
 */
function expectStructurallySound(mesh: MeshData): void {
  const vertexCount = mesh.positions.length / 3
  expect(Number.isInteger(vertexCount)).toBe(true)
  expect(mesh.indices.length % 3).toBe(0)

  const referenced = new Set<number>()
  for (let i = 0; i < mesh.indices.length; i++) {
    const idx = mesh.indices[i]
    expect(idx).toBeLessThan(vertexCount)
    referenced.add(idx)
  }
  // no orphans: every vertex the builder emitted is used by at least one triangle
  expect(referenced.size).toBe(vertexCount)

  for (let i = 0; i < mesh.uvs.length; i++) {
    expect(mesh.uvs[i]).toBeGreaterThanOrEqual(0)
    expect(mesh.uvs[i]).toBeLessThanOrEqual(1)
  }

  for (let i = 0; i < mesh.positions.length; i++) {
    expect(Number.isFinite(mesh.positions[i])).toBe(true)
  }
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
  // WIDENED from the brief, which asserted this on the fixture alone while claiming
  // "for every descriptor". The budget is the point: it must not grow with the numbers.
  it.each(CHARACTER_CASES)('%s: emits the same low-poly budget', (_l, d) => {
    const mesh = buildCharacterMesh(d)
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
   *
   * The exactness depends on the 8 radial segments and 4 sphere stacks the module pins:
   * they put a vertex at exactly 0 deg, 90 deg and on the equator, so the extent is the
   * radius rather than r * cos(pi / segments). That is a REQUIREMENT (spec §8.1 wants
   * bounds equal to the declared dimensions to 1e-6), not an accident of sampling.
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
    // ADDED: the same ordering on Z and on both minima. Task 8's lesson — a ribbon
    // offset sideways passed every assertion that only ever looked at one axis. A body
    // scaled on X alone is an ellipse, and every X-only assertion above accepts it.
    expect(wide.max.z).toBeGreaterThan(compact.max.z)
    expect(compact.max.z).toBeGreaterThan(tall.max.z)
    for (const b of [wide, compact, tall]) {
      expect(b.min.x).toBeCloseTo(-b.max.x, 6)
      expect(b.min.z).toBeCloseTo(-b.max.z, 6)
      expect(b.max.z).toBeCloseTo(b.max.x, 6)
    }
    expect(wide.max.y).toBeCloseTo(compact.max.y, 6)
    expect(tall.max.y).toBeCloseTo(compact.max.y, 6)
  })

  /**
   * ADDED, and the reason this task exists in the shape it does. Task 5's review caught a
   * COMPACT racer authored at bodyRadius 0.40 — above the 0.38 floor the WIDE records
   * sit on — which would have drawn the lightest racer as broad as the heavyweights and
   * inverted silhouette-as-a-handling-cue. The content records were made disjoint; this
   * asserts the GEOMETRY preserves that, because a clamp, a saturating scale or a
   * silhouette-blind builder undoes the content fix in triangles and no other test here
   * looks at the shipped eight at all.
   *
   * Independent of SILHOUETTE_XZ: it names no scale value, only the ordering.
   *
   * DECLINED, deliberately: asserting the TALL records land between compact and wide.
   * They do today (0.289 and 0.281 against a widest compact of 0.330) but only because
   * of the particular bodyRadius values shipped — the scale table guarantees no such
   * ordering across descriptors, so that assertion would be true by accident of today's
   * content and would fire on a legal edit. Same reason for not asserting
   * halfWidth === bodyRadius * scale over the shipped eight: it holds only while every
   * shipped head is narrower than its scaled body, which is content's business, not
   * geometry's.
   */
  it('keeps every shipped compact silhouette narrower than every shipped wide one', () => {
    const { characters } = loadContentBundle()
    expect(characters.length).toBe(8)

    const measured = characters.map((d) => {
      const b = meshBounds(buildCharacterMesh(d))
      // the silhouette a player reads is the full width, and it must be square in XZ
      expect(b.max.z).toBeCloseTo(b.max.x, 6)
      return { id: d.id, silhouette: d.silhouette, halfWidth: b.max.x }
    })

    const compact = measured.filter((m) => m.silhouette === 'compact')
    const wide = measured.filter((m) => m.silhouette === 'wide')
    // never let the two groups be empty: `[].every(...)` is `true` and would make the
    // whole test vacuous the day a silhouette value is renamed
    expect(compact.length).toBeGreaterThanOrEqual(3)
    expect(wide.length).toBeGreaterThanOrEqual(3)

    const widestCompact = Math.max(...compact.map((m) => m.halfWidth))
    const narrowestWide = Math.min(...wide.map((m) => m.halfWidth))
    // MEASURABLY narrower, not merely different: 0.1 m of half-width is 0.2 m across the
    // figure, a gap a player can read at race camera distance. The shipped margin is
    // 0.242 m, so this leaves room for content edits without accepting a hair's breadth.
    expect(narrowestWide - widestCompact).toBeGreaterThan(0.1)
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

  /**
   * ADDED. `paletteUsage` proves the three colours all appear somewhere; a builder that
   * dealt them out at random per vertex passes it. This ties each colour to the REGION it
   * belongs to, by height rather than by vertex index, so it is a claim about the figure
   * and not about the emission order: body below the shoulders is `primary`, the helmet
   * above the head's centre is `accent`, the face between them is `secondary`.
   *
   * The two SEAMS are excluded on purpose, and each band is asserted non-empty so that
   * exclusion cannot quietly empty the test:
   *  - y = bodyHeight, where the cylinder's top cap (primary) meets the head's south pole
   *    (secondary) — two parts genuinely touch there;
   *  - y = headCentre, the head's equator ring. The builder splits the hemispheres on
   *    `ry > 0`, and `ry` at the equator is `Math.cos(Math.PI / 2)` = 6.12e-17, not 0, so
   *    that ring is currently `accent`. It lands there on the last bit of a trig result
   *    the ECMAScript spec leaves implementation-approximated, so asserting either colour
   *    for it would be an assertion that holds by accident of this engine. It moves no
   *    geometry: the ring's y is `cy + 6.12e-17 * r`, which is `cy` exactly in float32.
   */
  it.each(CHARACTER_CASES)('%s: the palette lands by region, not at random', (_l, d) => {
    const mesh = buildCharacterMesh(d)
    const headCentre = d.bodyHeight + d.headRadius
    let body = 0
    let helmet = 0
    let face = 0
    for (let v = 0; v < mesh.positions.length / 3; v++) {
      const y = mesh.positions[v * 3 + 1]
      if (y < d.bodyHeight - 1e-6) {
        body++
        expect(isColor(mesh, v, d.palette.primary)).toBe(true)
      } else if (y > headCentre + 1e-6) {
        helmet++
        expect(isColor(mesh, v, d.palette.accent)).toBe(true)
      } else if (y > d.bodyHeight + 1e-6 && y < headCentre - 1e-6) {
        face++
        expect(isColor(mesh, v, d.palette.secondary)).toBe(true)
      }
    }
    expect(body).toBeGreaterThan(0)
    expect(helmet).toBeGreaterThan(0)
    expect(face).toBeGreaterThan(0)
  })

  it('is deterministic: the same descriptor yields identical arrays', () => {
    const d = makeCharacterDescriptorFixture()
    const a = buildCharacterMesh(d)
    const b = buildCharacterMesh(d)
    expect(Array.from(a.positions)).toEqual(Array.from(b.positions))
    expect(Array.from(a.normals)).toEqual(Array.from(b.normals))
    expect(Array.from(a.colors)).toEqual(Array.from(b.colors))
    expect(Array.from(a.indices)).toEqual(Array.from(b.indices))
    // ADDED: equal, but not the SAME buffers. A builder that memoised and handed the same
    // Float32Array to every caller would pass every assertion above and let one kart's
    // upload scribble on another's geometry.
    expect(a.positions).not.toBe(b.positions)
    expect(a.indices).not.toBe(b.indices)
  })

  /**
   * ADDED. The bundle is memoised — `loadContentBundle` hands every caller the same
   * records — so a builder that scaled `desc.bodyRadius` in place would corrupt the
   * shipped character for the rest of the process, and would do it silently: the first
   * mesh built is correct and every later one is 1.3x wider than the last.
   */
  it('does not mutate the descriptor it was handed', () => {
    const d = character({ silhouette: 'wide' })
    const before = JSON.stringify(d)
    buildCharacterMesh(d)
    buildCharacterMesh(d)
    expect(JSON.stringify(d)).toBe(before)
  })

  it.each(CHARACTER_CASES)('%s: no degenerate triangles, all normals unit length', (_l, d) => {
    const mesh = buildCharacterMesh(d)
    expect(smallestTriangleArea(mesh)).toBeGreaterThan(1e-9)
    for (let i = 0; i < mesh.normals.length; i += 3) {
      const len = Math.hypot(mesh.normals[i], mesh.normals[i + 1], mesh.normals[i + 2])
      expect(Math.abs(len - 1)).toBeLessThan(1e-5)
    }
  })

  it.each(CHARACTER_CASES)('%s: every triangle is wound to face outward', (_l, d) => {
    expect(worstWindingAgreement(buildCharacterMesh(d))).toBeGreaterThan(0)
  })

  it.each(CHARACTER_CASES)('%s: indices, UVs and positions are sound', (_l, d) => {
    expectStructurallySound(buildCharacterMesh(d))
  })
})

describe('buildKartMesh', () => {
  // WIDENED from the brief, same reason as the character budget above.
  it.each(KART_CASES)('%s: emits the same low-poly budget', (_l, d) => {
    const mesh = buildKartMesh(d)
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
    // ADDED: the axis that did NOT change must not move either — widening a kart that
    // also lengthens it passes both assertions above on their own.
    expect(long.max.z).toBeCloseTo(short.max.z, 6)
    expect(long.max.y).toBeCloseTo(short.max.y, 6)
  })

  it('uses all three palette entries and no other colour', () => {
    const d = makeKartDescriptorFixture()
    const hits = paletteUsage(buildKartMesh(d), [d.palette.body, d.palette.trim, d.palette.wheel])
    for (const h of hits) expect(h).toBeGreaterThan(0)
  })

  /**
   * ADDED, and NOT redundant with the bounds sweep. A chassis built from y = 0 instead of
   * from axle height is invisible to `meshBounds` whenever the wheels are the taller part
   * — exactly the `wheels taller than the chassis roof` case — because max.y is 2 *
   * wheelRadius either way. Colour is what still knows which vertices are chassis.
   *
   * Likewise the tyres: every `wheel`-coloured vertex must lie in the outboard band
   * [halfWidth - wheelWidth, halfWidth], which is the inboard-mounting claim stated per
   * wheel rather than as a whole-mesh extent.
   */
  it.each(KART_CASES)('%s: chassis and tyre colours land where the parts are', (_l, d) => {
    const mesh = buildKartMesh(d)
    const halfWidth = d.chassisWidth / 2
    let chassis = 0
    let tyre = 0
    for (let v = 0; v < mesh.positions.length / 3; v++) {
      const y = mesh.positions[v * 3 + 1]
      const z = mesh.positions[v * 3 + 2]
      if (isColor(mesh, v, d.palette.body)) {
        chassis++
        expect(y).toBeGreaterThanOrEqual(d.wheelRadius - 1e-6)
        expect(y).toBeLessThanOrEqual(d.wheelRadius + d.chassisHeight + 1e-6)
      }
      if (isColor(mesh, v, d.palette.wheel)) {
        tyre++
        expect(Math.abs(z)).toBeGreaterThanOrEqual(halfWidth - d.wheelWidth - 1e-6)
        expect(Math.abs(z)).toBeLessThanOrEqual(halfWidth + 1e-6)
      }
    }
    expect(chassis).toBeGreaterThan(0)
    expect(tyre).toBeGreaterThan(0)
  })

  it('is deterministic: the same descriptor yields identical arrays', () => {
    const d = makeKartDescriptorFixture()
    const a = buildKartMesh(d)
    const b = buildKartMesh(d)
    expect(Array.from(a.positions)).toEqual(Array.from(b.positions))
    expect(Array.from(a.indices)).toEqual(Array.from(b.indices))
    expect(a.positions).not.toBe(b.positions)
  })

  it('does not mutate the descriptor it was handed', () => {
    const d = makeKartDescriptorFixture()
    const before = JSON.stringify(d)
    buildKartMesh(d)
    buildKartMesh(d)
    expect(JSON.stringify(d)).toBe(before)
  })

  it.each(KART_CASES)('%s: no degenerate triangles, all normals unit length', (_l, d) => {
    const mesh = buildKartMesh(d)
    expect(smallestTriangleArea(mesh)).toBeGreaterThan(1e-9)
    for (let i = 0; i < mesh.normals.length; i += 3) {
      const len = Math.hypot(mesh.normals[i], mesh.normals[i + 1], mesh.normals[i + 2])
      expect(Math.abs(len - 1)).toBeLessThan(1e-5)
    }
  })

  it.each(KART_CASES)('%s: every triangle is wound to face outward', (_l, d) => {
    expect(worstWindingAgreement(buildKartMesh(d))).toBeGreaterThan(0)
  })

  it.each(KART_CASES)('%s: indices, UVs and positions are sound', (_l, d) => {
    expectStructurallySound(buildKartMesh(d))
  })

  /**
   * Four wheels, one per corner, all four distinct. A loop bug that builds the same wheel
   * four times leaves three of them hidden inside one and every count still adds up.
   *
   * STRENGTHENED from the brief, which read the SIGN of one coordinate of each wheel's
   * FIRST vertex. That is true by accident of where the ring starts, and it would still
   * pass with a wheel parked halfway to the centreline or sunk under the road. Averaging
   * all 34 of a wheel's vertices gives its axle instead: a capped cylinder's vertices are
   * symmetric about its axis (8 evenly spaced radial samples sum to zero on both
   * transverse axes, and 17 vertices sit on each end cap), so the mean is the centre of
   * the axle, independently of how the builder ordered them.
   *
   * The expected axle is the brief's stated identity — x = +/-(chassisLength/2 -
   * wheelRadius), z = +/-(chassisWidth/2 - wheelWidth/2), y = wheelRadius — so THAT half
   * is a recompute of the spec; the averaging that produces the measured value is not.
   */
  it.each(KART_CASES)('%s: places four wheels, one per corner, on their axles', (_l, d) => {
    const mesh = buildKartMesh(d)
    // emission order pinned by this task: the 24-vertex chassis box, then wheels at
    // (-x,-z), (-x,+z), (+x,-z), (+x,+z), 34 vertices each
    const corners: readonly (readonly [number, number])[] = [
      [-1, -1],
      [-1, 1],
      [1, -1],
      [1, 1],
    ]
    const seen = new Set<string>()
    for (let w = 0; w < corners.length; w++) {
      const base = 24 + w * 34
      let sx = 0
      let sy = 0
      let sz = 0
      for (let i = 0; i < 34; i++) {
        sx += mesh.positions[(base + i) * 3]
        sy += mesh.positions[(base + i) * 3 + 1]
        sz += mesh.positions[(base + i) * 3 + 2]
      }
      const [ex, ez] = corners[w]
      expect(sx / 34).toBeCloseTo(ex * (d.chassisLength / 2 - d.wheelRadius), 5)
      expect(sy / 34).toBeCloseTo(d.wheelRadius, 5)
      expect(sz / 34).toBeCloseTo(ez * (d.chassisWidth / 2 - d.wheelWidth / 2), 5)
      seen.add(`${ex}:${ez}`)
    }
    expect(seen.size).toBe(4)
  })
})

/**
 * ADDED. §4.11's barrel line is part of this task's diff and nothing else in the package
 * covers it: every other import here reaches `src/descriptors` by relative path, so a
 * missing `export * from './descriptors'` leaves `@tapkart/render` without either builder
 * and leaves this whole file green. Identity, not presence: a re-implementation under the
 * same name would pass `toBeDefined()` and ship two copies of the geometry rules.
 */
describe('the @tapkart/render barrel re-exports descriptors (§4.11)', () => {
  it('carries both of the module’s runtime exports, by identity', () => {
    expect(barrel.buildCharacterMesh).toBe(buildCharacterMesh)
    expect(barrel.buildKartMesh).toBe(buildKartMesh)
  })
})
