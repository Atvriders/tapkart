### Task 4: Track Query — closed-loop spline, arc-length parameterisation, projection

This is **Task 4**, and the locked contract labels both halves of it Task 4: contract §2
marks `buildTrackQuery(track: Track): TrackQuery` in `packages/sim/src/track.ts` as
`[Task 4]`, and contract §3 marks `makeContext(track, isLeader?)` in
`packages/sim/test/fixtures/track-fixtures.ts` as `[Task 4]`. The other entries on those
same lines belong to **Task 3**, which has already run: `validateTrack` in the same
`track.ts` (contract §2, `[Task 3]`) and the rest of the fixtures file — `makeTuning`,
`makeCharacters`, `makeStraightTrack`, `makeCircleTrack`, `makeOvalTrack` (contract §3,
`[Task 3]`). This task **appends** to both files and edits neither of Task 3's halves.

> **READ THIS BEFORE ANYTHING ELSE: `s` IS `[0, 1)`, NEVER METRES.**
>
> Contract §0: **"Track parameter `s` — always arc-normalised `[0, 1)`"**, and
> **"Metres — reachable only by multiplying an `s`-delta by `query.totalLength()`"**.
> This task is where that becomes real, so it is stated here at full volume:
>
> **`s = 30` is not "30 metres along the track". It is `wrap01(30) = 30 - Math.floor(30)
> = 0.0`, the start line, and nothing warns you.** Every method on `TrackQuery` takes or
> returns `s` in `[0, 1)` and silently wraps anything else, so a metres value passed as
> `s` does not throw, does not clamp, and does not log — it just teleports the caller to
> a wrong, plausible-looking place on the track and every number downstream is quietly
> wrong.
>
> On `makeStraightTrack`, `totalLength()` is `1828.3236243268896` m, so:
>
> | you mean | you write | you must NOT write |
> |---|---|---|
> | 30 m along from the start | `30 / query.totalLength()` = `0.016408473642648858` | `30` (→ `s = 0`) |
> | a 6 m bot lookahead | `sNow + 6 / query.totalLength()`, then `wrap01` | `sNow + 6` (→ `sNow`) |
> | the metres between two `s` values | `wrappedDelta * query.totalLength()` | the raw `s` delta |
>
> `checkpointS`, `itemBoxes[].s`, `boostPads[].s`, `ramps[].sStart` / `.sEnd` and
> `startPositions[].s` are all in `[0, 1)` for the same reason, and Task 3's
> `validateTrack` rejects any of them outside `0..1`. Step 13's test
> "reads `s` as arc-normalised" pins this behaviour so nobody can later decide `s` is
> metres and quietly break six other tasks.

**Files:**
- Modify: `packages/sim/src/track.ts:1` — widen the type import on line 1
- Modify: `packages/sim/src/track.ts` — append the spline core, the arc table, `projectPoint` and `buildTrackQuery` after the existing `validateTrack`
- Modify: `packages/sim/test/fixtures/track-fixtures.ts` — append `makeContext`
- Test: `packages/sim/test/track-query.test.ts`

**Interfaces:**

- Consumes (from Task 2, `packages/sim/src/types.ts`):
  - `type Vec3 = { x: number; y: number; z: number }`
  - `type Surface = 'tarmac' | 'dirt' | 'boost' | 'offtrack'`
  - `interface TrackPoint { position: Vec3; width: number; banking: number; surface: Surface }`
  - `interface Track { id: string; name: string; controlPoints: TrackPoint[]; checkpointS: number[]; itemBoxes: { s: number; lateral: number }[]; ramps: { sStart: number; sEnd: number; launch: number }[]; boostPads: { s: number; lateral: number; halfWidth: number }[]; startPositions: { s: number; lateral: number }[]; bounds: { min: Vec3; max: Vec3 } }`
  - `interface TrackProjection { s: number; lateral: number; distance: number }`
  - `interface TrackQuery { sampleAt(s: number): TrackPoint; tangentAt(s: number): Vec3; project(p: Vec3): TrackProjection; groundHeight(s: number, lateral: number): number; surfaceAt(s: number, lateral: number): Surface; isInBounds(s: number, lateral: number): boolean; checkpointIndexAt(s: number): number; totalLength(): number }`
  - `interface SimContext { track: Track; query: TrackQuery; tuning: Tuning; characters: CharacterStats[]; isLeader: boolean }`
- Consumes (from Task 2, `packages/sim/src/vec3.ts`): `function v3(x: number, y: number, z: number): Vec3`
- Consumes (from Task 3, `packages/sim/test/fixtures/track-fixtures.ts`):
  - `function makeTuning(overrides?: Partial<Tuning>): Tuning`
  - `function makeCharacters(): CharacterStats[]`
  - `function makeStraightTrack(overrides?: Partial<Track>): Track`
  - `function makeCircleTrack(overrides?: Partial<Track>): Track`
  - `function makeOvalTrack(overrides?: Partial<Track>): Track`
- Consumes (from Task 3, `packages/sim/src/track.ts`): the file already exists and exports
  `VALIDATION_KART_RADIUS` and `validateTrack(track: Track): string[]`. Do not edit either.
- Produces (`packages/sim/src/track.ts`):
  - `const SAMPLES_PER_SEGMENT = 64`
  - `const BOOST_PAD_HALF_LENGTH = 4` — new constant, not in the contract: `boostPads` carry a
    lateral `halfWidth` but no longitudinal extent, so a pad covers ±4 m of centreline
  - `const BOUNDS_HALF_WIDTH_MUL = 2` — new constant, not in the contract: `isInBounds` allows
    one half-width of run-off beyond each track edge
  - `function catmullRom(p0: number, p1: number, p2: number, p3: number, u: number): number`
  - `function splinePointAt(track: Track, t: number, out: Vec3): void`
  - `function splineTangentAt(track: Track, t: number, out: Vec3): void`
  - `function widthAtSeg(track: Track, t: number): number`
  - `function bankingAtSeg(track: Track, t: number): number`
  - `function surfaceOfSeg(track: Track, t: number): Surface`
  - `interface ArcTable { pts: Float64Array; cum: Float64Array; samplesPerSegment: number; segments: number; total: number }`
  - `function buildArcTable(track: Track): ArcTable`
  - `function locateS(table: ArcTable, s: number): number` — arc-normalised `s` → segment-parameter `t`
  - `function arcAt(table: ArcTable, t: number): number` — segment-parameter `t` → metres travelled
  - `function projectPoint(track: Track, table: ArcTable, p: Vec3, out: TrackProjection): void` —
    writes `out.s` arc-normalised into `[0, 1)`
  - `function buildTrackQuery(track: Track): TrackQuery` — **every method of the returned
    query takes or returns `s` in `[0, 1)` and wraps anything else without complaint;
    metres exist only via `totalLength()`**
- Produces (`packages/sim/test/fixtures/track-fixtures.ts`), contract §3 marks this `[Task 4]`:
  - `function makeContext(track: Track, isLeader?: boolean): SimContext` — `isLeader` defaults
    `true`; it is here rather than in Task 3 because it needs `buildTrackQuery`, see decision 5

**Five decisions this task makes, all load-bearing for Tasks 5–16:**

1. **`t` versus `s`, and where metres live.** `t` is the *segment parameter*: `t = 3.5` is
   halfway along the segment from control point 3 to control point 4, and `t` wraps modulo
   `controlPoints.length`. `s` is the *arc-normalised* position, `[0, 1)` over the whole lap,
   and it also wraps. The two are related only through the arc table. Everything on
   `TrackQuery` speaks `s` — `sampleAt`, `tangentAt`, `groundHeight`, `surfaceAt`,
   `isInBounds` and `checkpointIndexAt` all take `s`, and `project` returns `s`.
   This is what makes a kart at constant speed see `s` advance at a constant rate, and it is
   why `checkpointS` values are comparable to lap progress.
   **`totalLength()` is the only door between `s` and metres**, in both directions:
   `metres = sDelta * totalLength()` and `sDelta = metres / totalLength()`. `t` is internal;
   it never leaves `track.ts` and no other task may take a `t`. See the boxed warning at the
   top of this task: an `s` of `30` is `0.0`, not 30 m, and it fails silently.
2. **The returned objects are shared scratch.** `sampleAt`, `tangentAt` and `project` each
   return the *same* object on every call for a given query, overwritten in place. `step()`
   may not allocate in the hot path, so the caller must copy any field it wants to keep
   before calling again. Tests below assert this identity so nobody "fixes" it later.
3. **Projection is horizontal.** `project` searches and measures in the XZ plane, so a kart's
   ride height never leaks into `lateral` or `distance`. `distance` is the XZ distance from
   `p` to the centreline point at `s`.
4. **`lateral` sign.** From contract §0, `right = (-t.z, 0, t.x)` and positive `lateral` is
   to the right of the direction of travel. On the straight fixture the tangent is
   `(1, 0, 0)`, so `right = (0, 0, 1)` and positive `lateral` is toward **+z**, which is what
   contract §3 now says as well. (An earlier revision of the contract said `-z` there and is
   retracted; §0's formula is authoritative. The tests below pin the sign numerically, both
   on the straight fixture and on the circle, where travel is counter-clockwise so positive
   `lateral` points at the centre.)
5. **`makeContext` lives here, in Task 4, not in Task 3 where the rest of the fixtures live.**
   `SimContext.query` is a `TrackQuery`, and `buildTrackQuery` — the only producer of one —
   is written in *this* task. ESM linking is what makes this an ordering constraint rather
   than a preference: imports are resolved when the module graph links, before any test body
   runs, so a Task 3 `track-fixtures.ts` that did
   `import { buildTrackQuery } from '../../src/track'` would fail to load outright with
   `SyntaxError: The requested module '../../src/track' does not provide an export named
   'buildTrackQuery'`, taking all of Task 3's tests down with it for the wrong reason.
   Step 19 below is therefore the first edit that widens that fixture file's import block.

---

- [ ] **Step 1: Write the failing test for the spline core**

Create `packages/sim/test/track-query.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { v3 } from '../src/vec3'
import {
  bankingAtSeg,
  catmullRom,
  splinePointAt,
  splineTangentAt,
  surfaceOfSeg,
  widthAtSeg,
} from '../src/track'
import { makeOvalTrack, makeStraightTrack } from './fixtures/track-fixtures'

describe('spline core', () => {
  it('catmullRom interpolates p1..p2 and hits both ends exactly', () => {
    // p0=0 p1=0 p2=1 p3=1: u=0 -> p1, u=1 -> p2, u=0.5 -> the symmetric midpoint
    expect(catmullRom(0, 0, 1, 1, 0)).toBe(0)
    expect(catmullRom(0, 0, 1, 1, 1)).toBe(1)
    expect(catmullRom(0, 0, 1, 1, 0.5)).toBe(0.5)
  })

  it('splinePointAt returns the control point itself at integer t', () => {
    const tr = makeStraightTrack()
    const out = v3(0, 0, 0)
    splinePointAt(tr, 0, out)
    expect(out).toEqual({ x: 0, y: 0, z: 0 })
    splinePointAt(tr, 2, out)
    expect(out).toEqual({ x: 300, y: 0, z: 0 })
    splinePointAt(tr, 8, out)
    expect(out).toEqual({ x: 600, y: 0, z: 120 })
  })

  it('splinePointAt is exactly linear across evenly spaced collinear control points', () => {
    // segment 2 spans control points 2 (x=300) and 3 (x=450) and its window is
    // control points 1,2,3,4 = x 150,300,450,600 at z=0, all collinear and evenly
    // spaced, so the Catmull-Rom cubic degenerates to the straight midpoint 375
    const tr = makeStraightTrack()
    const out = v3(0, 0, 0)
    splinePointAt(tr, 2.5, out)
    expect(out).toEqual({ x: 375, y: 0, z: 0 })
  })

  it('splinePointAt wraps t around the closed loop', () => {
    // t = -0.5 is the same place as t = 11.5 on a 12-control-point loop
    const tr = makeStraightTrack()
    const a = v3(0, 0, 0)
    const b = v3(0, 0, 0)
    splinePointAt(tr, 11.5, a)
    splinePointAt(tr, -0.5, b)
    expect(a).toEqual({ x: -88.125, y: 0, z: 26.25 })
    expect(b).toEqual(a)
  })

  it('splineTangentAt returns a unit tangent, +X on the straight', () => {
    const tr = makeStraightTrack()
    const out = v3(0, 0, 0)
    splineTangentAt(tr, 2, out)
    expect(out).toEqual({ x: 1, y: 0, z: 0 })
    splineTangentAt(tr, 6, out)
    expect(Math.hypot(out.x, out.y, out.z)).toBeCloseTo(1, 12)
  })

  it('widthAtSeg and bankingAtSeg interpolate linearly between control points', () => {
    // oval control point 4 is 24 m wide and flat, control point 5 is 20 m wide banked 0.2
    const tr = makeOvalTrack()
    expect(widthAtSeg(tr, 4)).toBe(24)
    expect(widthAtSeg(tr, 4.5)).toBe(22) // (24 + 20) / 2
    expect(widthAtSeg(tr, 5)).toBe(20)
    expect(bankingAtSeg(tr, 4.5)).toBe(0.1) // (0 + 0.2) / 2
    // control points 6 and 7 are both banked 0.2, so the whole segment is 0.2
    expect(bankingAtSeg(tr, 6.25)).toBe(0.2)
  })

  it('surfaceOfSeg takes the surface of the segment start control point', () => {
    // oval control points 12 and 13 are dirt, so segments 12 and 13 are dirt
    const tr = makeOvalTrack()
    expect(surfaceOfSeg(tr, 11.9)).toBe('tarmac')
    expect(surfaceOfSeg(tr, 12.5)).toBe('dirt')
    expect(surfaceOfSeg(tr, 13.5)).toBe('dirt')
    expect(surfaceOfSeg(tr, 14)).toBe('tarmac')
  })
})
```

- [ ] **Step 2: Run the spline core test to verify it fails**

Run: `npx vitest run packages/sim/test/track-query.test.ts -t "spline core"`

Expected: FAIL — `SyntaxError: The requested module '../src/track' does not provide an export named 'catmullRom'`

- [ ] **Step 3: Write the spline core**

In `packages/sim/src/track.ts`, change line 1 from:

```ts
import type { Track, Vec3 } from './types'
```

to:

```ts
import type { Surface, Track, TrackPoint, TrackProjection, TrackQuery, Vec3 } from './types'
import { v3 } from './vec3'
```

Then append to the end of the file, after `validateTrack`:

```ts
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
```

- [ ] **Step 4: Run the spline core test to verify it passes**

Run: `npx vitest run packages/sim/test/track-query.test.ts -t "spline core"`

Expected: PASS — 7 passed.

---

- [ ] **Step 5: Write the failing test for the arc-length table**

First replace the import block at the top of `packages/sim/test/track-query.test.ts` with:

```ts
import { describe, expect, it } from 'vitest'
import { v3 } from '../src/vec3'
import {
  arcAt,
  bankingAtSeg,
  buildArcTable,
  catmullRom,
  locateS,
  SAMPLES_PER_SEGMENT,
  splinePointAt,
  splineTangentAt,
  surfaceOfSeg,
  widthAtSeg,
} from '../src/track'
import { makeCircleTrack, makeOvalTrack, makeStraightTrack } from './fixtures/track-fixtures'
```

Then append this block after the closing `})` of `describe('spline core', ...)`:

```ts
describe('arc-length table', () => {
  it('samples every segment and accumulates a monotonic length', () => {
    const tr = makeCircleTrack()
    const table = buildArcTable(tr)
    expect(table.segments).toBe(16)
    expect(table.samplesPerSegment).toBe(SAMPLES_PER_SEGMENT)
    expect(table.cum.length).toBe(16 * 64 + 1) // 1025
    expect(table.pts.length).toBe(1025 * 3)
    expect(table.cum[0]).toBe(0)
    for (let i = 1; i < table.cum.length; i++) {
      expect(table.cum[i]).toBeGreaterThan(table.cum[i - 1])
    }
    expect(table.total).toBe(table.cum[table.cum.length - 1])
  })

  it('measures a radius-100 circle as just under 2*pi*100', () => {
    // chord sums always undershoot the true arc; with 64 samples per segment the
    // shortfall is 0.183 m on 628.319 m, i.e. 0.029%
    const table = buildArcTable(makeCircleTrack())
    const circumference = 2 * Math.PI * 100 // 628.3185307179587
    expect(table.total).toBeLessThan(circumference)
    expect(circumference - table.total).toBeLessThan(0.5)
    expect(table.total).toBeCloseTo(628.135, 2) // pinned to SAMPLES_PER_SEGMENT = 64
  })

  it('locateS maps arc-normalised s onto the segment parameter', () => {
    const table = buildArcTable(makeCircleTrack())
    expect(locateS(table, 0)).toBe(0)
    expect(locateS(table, 1)).toBe(0) // s wraps
    // the circle fixture is uniform, so a quarter of the arc is 4 of the 16 segments
    expect(locateS(table, 0.25)).toBeCloseTo(4, 9)
    expect(locateS(table, 0.5)).toBeCloseTo(8, 9)
  })

  it('normalises s by arc length, not by control point index', () => {
    // straight fixture: 12 segments, but their lengths run from 50 m (the end cap)
    // to 300 m (the return leg). Parameter-normalised, s = 0.5 would be segment 6
    // (control point 6 at x = 740). Arc-normalised it is t = 7.997, i.e. control
    // point 8 at x = 600, because control point 8 sits at s = 0.500288.
    const table = buildArcTable(makeStraightTrack())
    expect(table.segments).toBe(12)
    expect(table.cum.length).toBe(12 * 64 + 1) // 769
    expect(locateS(table, 0.5)).toBeCloseTo(7.9973389, 6)
    expect(locateS(table, 0.5)).toBeGreaterThan(7)
    // and the reverse: control point 6 is at s = 0.414, not s = 6/12 = 0.5
    expect(arcAt(table, 6) / table.total).toBeCloseTo(0.4141583, 6)
  })

  it('arcAt converts a segment parameter back to metres and wraps', () => {
    const table = buildArcTable(makeStraightTrack())
    expect(table.total).toBeCloseTo(1828.3236243, 6)
    expect(arcAt(table, 0)).toBe(0)
    expect(arcAt(table, 11.999)).toBeCloseTo(1828.1734072, 5)
    expect(arcAt(table, 12)).toBe(0) // one full lap wraps back to the start line
  })

  it('locateS and arcAt round-trip', () => {
    const table = buildArcTable(makeStraightTrack())
    for (const s of [0.05, 0.2, 0.37, 0.5, 0.61, 0.83, 0.99]) {
      expect(arcAt(table, locateS(table, s)) / table.total).toBeCloseTo(s, 9)
    }
  })
})
```

- [ ] **Step 6: Run the arc table test to verify it fails**

Run: `npx vitest run packages/sim/test/track-query.test.ts -t "arc-length table"`

Expected: FAIL — `SyntaxError: The requested module '../src/track' does not provide an export named 'buildArcTable'`

- [ ] **Step 7: Write the arc-length table**

Append to the end of `packages/sim/src/track.ts`, after `surfaceOfSeg`:

```ts
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
```

- [ ] **Step 8: Run the arc table test to verify it passes**

Run: `npx vitest run packages/sim/test/track-query.test.ts -t "arc-length table"`

Expected: PASS — 6 passed.

---

- [ ] **Step 9: Write the failing test for point projection**

Replace the import block at the top of `packages/sim/test/track-query.test.ts` with:

```ts
import { describe, expect, it } from 'vitest'
import type { TrackProjection } from '../src/types'
import { v3 } from '../src/vec3'
import {
  arcAt,
  bankingAtSeg,
  buildArcTable,
  catmullRom,
  locateS,
  projectPoint,
  SAMPLES_PER_SEGMENT,
  splinePointAt,
  splineTangentAt,
  surfaceOfSeg,
  widthAtSeg,
} from '../src/track'
import { makeCircleTrack, makeOvalTrack, makeStraightTrack } from './fixtures/track-fixtures'
```

Then append this block after the closing `})` of `describe('arc-length table', ...)`:

```ts
function emptyProjection(): TrackProjection {
  return { s: 0, lateral: 0, distance: 0 }
}

describe('projectPoint', () => {
  it('puts a point on the centreline at zero lateral and zero distance', () => {
    // (300, 0, 0) is control point 2 of the straight fixture, which sits at s = 0.164306
    const tr = makeStraightTrack()
    const table = buildArcTable(tr)
    const out = emptyProjection()
    projectPoint(tr, table, v3(300, 0, 0), out)
    expect(out.s).toBeCloseTo(0.1643056, 6)
    expect(Math.abs(out.lateral)).toBeLessThan(1e-6)
    expect(out.distance).toBeLessThan(1e-6)
  })

  it('signs lateral positive toward +z when travelling +X', () => {
    // right = (-t.z, 0, t.x) and t = (1, 0, 0) on the straight, so right = (0, 0, 1)
    const tr = makeStraightTrack()
    const table = buildArcTable(tr)
    const out = emptyProjection()
    projectPoint(tr, table, v3(300, 0, 5), out)
    expect(out.lateral).toBeCloseTo(5, 9)
    expect(out.distance).toBeCloseTo(5, 9)
    expect(out.s).toBeCloseTo(0.1643056, 6)
    projectPoint(tr, table, v3(300, 0, -5), out)
    expect(out.lateral).toBeCloseTo(-5, 9)
    expect(out.distance).toBeCloseTo(5, 9)
  })

  it('ignores height: a kart in the air projects like a kart on the ground', () => {
    const tr = makeStraightTrack()
    const table = buildArcTable(tr)
    const ground = emptyProjection()
    const air = emptyProjection()
    projectPoint(tr, table, v3(300, 0, 5), ground)
    projectPoint(tr, table, v3(300, 7, 5), air)
    expect(air.s).toBe(ground.s)
    expect(air.lateral).toBe(ground.lateral)
    expect(air.distance).toBe(ground.distance)
  })

  it('projects onto a curved centreline with the inside of the circle positive', () => {
    // travel is counter-clockwise in the x-z plane, so at (100, 0, 0) the tangent is
    // (0, 0, 1) and right = (-1, 0, 0), which points at the centre. A point 50 m
    // outside the circle is therefore lateral -50; one 10 m inside is lateral +10.
    const tr = makeCircleTrack()
    const table = buildArcTable(tr)
    const out = emptyProjection()
    projectPoint(tr, table, v3(150, 0, 0), out)
    expect(out.lateral).toBeCloseTo(-50, 6)
    expect(out.distance).toBeCloseTo(50, 6)
    // this point sits exactly on the start line, so s may converge to either side of the
    // seam - 1e-9 or 1 - 1e-9 are the same place on a closed loop
    expect(Math.min(out.s, 1 - out.s)).toBeLessThan(1e-6)
    projectPoint(tr, table, v3(90, 0, 0), out)
    expect(out.lateral).toBeCloseTo(10, 6)
    expect(out.distance).toBeCloseTo(10, 6)
    projectPoint(tr, table, v3(0, 0, -150), out)
    expect(out.s).toBeCloseTo(0.75, 6)
    expect(out.lateral).toBeCloseTo(-50, 6)
  })

  it('projects onto the oval bottom straight with the expected s', () => {
    // the oval bottom straight runs +X at z = -100; control point 2 is (0, 0, -100)
    // at s = 0.140104. A point 6 m toward +z is 6 m to the right of travel.
    const tr = makeOvalTrack()
    const table = buildArcTable(tr)
    const out = emptyProjection()
    projectPoint(tr, table, v3(0, 0, -94), out)
    expect(out.s).toBeCloseTo(0.1401039, 6)
    expect(out.lateral).toBeCloseTo(6, 9)
    expect(out.distance).toBeCloseTo(6, 9)
    projectPoint(tr, table, v3(0, 0, -106), out)
    expect(out.s).toBeCloseTo(0.1401039, 6)
    expect(out.lateral).toBeCloseTo(-6, 9)
    expect(out.distance).toBeCloseTo(6, 9)
  })
})
```

- [ ] **Step 10: Run the projection test to verify it fails**

Run: `npx vitest run packages/sim/test/track-query.test.ts -t "projectPoint"`

Expected: FAIL — `SyntaxError: The requested module '../src/track' does not provide an export named 'projectPoint'`

- [ ] **Step 11: Write the projection**

Append to the end of `packages/sim/src/track.ts`, after `arcAt`:

```ts
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
```

- [ ] **Step 12: Run the projection test to verify it passes**

Run: `npx vitest run packages/sim/test/track-query.test.ts -t "projectPoint"`

Expected: PASS — 5 passed.

---

- [ ] **Step 13: Write the failing test for the assembled query**

Replace the import block at the top of `packages/sim/test/track-query.test.ts` with:

```ts
import { describe, expect, it } from 'vitest'
import type { TrackProjection } from '../src/types'
import { v3 } from '../src/vec3'
import {
  arcAt,
  bankingAtSeg,
  buildArcTable,
  buildTrackQuery,
  catmullRom,
  locateS,
  projectPoint,
  SAMPLES_PER_SEGMENT,
  splinePointAt,
  splineTangentAt,
  surfaceOfSeg,
  widthAtSeg,
} from '../src/track'
import { makeCircleTrack, makeOvalTrack, makeStraightTrack } from './fixtures/track-fixtures'
```

Then append this block after the closing `})` of `describe('projectPoint', ...)`:

```ts
describe('buildTrackQuery', () => {
  it('reports the arc length of each fixture', () => {
    expect(buildTrackQuery(makeStraightTrack()).totalLength()).toBeCloseTo(1828.3236243, 6)
    expect(buildTrackQuery(makeCircleTrack()).totalLength()).toBeCloseTo(628.1351367, 6)
    expect(buildTrackQuery(makeOvalTrack()).totalLength()).toBeCloseTo(1427.7555092, 6)
  })

  it('reads s as arc-normalised, so s = 30 is the start line and not 30 metres along', () => {
    const q = buildTrackQuery(makeStraightTrack())
    // wrap01(30) = 30 - Math.floor(30) = 0, so s = 30 IS s = 0, silently. This is the
    // single most error-prone thing in the package (contract section 0), so it is pinned.
    expect(q.sampleAt(30).position).toEqual({ x: 0, y: 0, z: 0 })
    expect(q.sampleAt(0).position).toEqual({ x: 0, y: 0, z: 0 })
    // 30 metres along is a completely different place: 30 / 1828.3236243268896 =
    // 0.016408473642648858 of the lap. The centreline there is (29.7252259, 0, -3.8633698)
    // rather than (30, 0, 0), because segment 0's Catmull-Rom window includes control
    // point 11 at (-140, 0, 60), which bows the curve toward -z as it leaves the origin.
    const sFor30m = 30 / q.totalLength()
    expect(sFor30m).toBeCloseTo(0.0164085, 7)
    const p = q.sampleAt(sFor30m)
    expect(p.position.x).toBeCloseTo(29.7252259, 6)
    expect(p.position.y).toBe(0)
    expect(p.position.z).toBeCloseTo(-3.8633698, 6)
  })

  it('resolves s by arc length, not by control point index', () => {
    // the straight fixture's segments are 50 m to 300 m long. Control point 6 is
    // (740, 0, 60) and sits at index 6 of 12, so a parameter-normalised s = 0.5 would
    // land there. By arc length s = 0.5 is next to control point 8, (600, 0, 120),
    // which sits at s = 0.500288.
    const q = buildTrackQuery(makeStraightTrack())
    const p = q.sampleAt(0.5)
    expect(p.position.x).toBeCloseTo(600.5310186, 4)
    expect(p.position.y).toBe(0)
    expect(p.position.z).toBeCloseTo(119.9598713, 4)
    expect(Math.abs(p.position.x - 740)).toBeGreaterThan(100)
  })

  it('advances s at a constant rate along the track', () => {
    // this is the property arc-normalisation exists for: 0.01 of s is 0.01 of the lap
    // everywhere, whether the control points there are 150 m apart or 300 m apart
    const q = buildTrackQuery(makeStraightTrack())
    const total = q.totalLength() // 1828.3236, so 0.01 of s is 18.2832 m
    const a = q.sampleAt(0.1)
    const ax = a.position.x
    const az = a.position.z
    const b = q.sampleAt(0.11)
    const bx = b.position.x
    const bz = b.position.z
    const c = q.sampleAt(0.6)
    const cx = c.position.x
    const cz = c.position.z
    const d = q.sampleAt(0.61)
    const dx = d.position.x
    const dz = d.position.z
    const near = Math.hypot(bx - ax, bz - az) // 18.283236
    const far = Math.hypot(dx - cx, dz - cz) // 18.284069
    expect(near).toBeCloseTo(0.01 * total, 1)
    expect(far).toBeCloseTo(0.01 * total, 1)
    expect(Math.abs(far - near)).toBeLessThan(0.01)
  })

  it('returns shared scratch objects that the caller must copy', () => {
    const q = buildTrackQuery(makeStraightTrack())
    expect(q.sampleAt(0)).toBe(q.sampleAt(0.5))
    expect(q.tangentAt(0)).toBe(q.tangentAt(0.5))
    expect(q.project(v3(0, 0, 0))).toBe(q.project(v3(300, 0, 0)))
    // the second call overwrites the first result in place
    const first = q.sampleAt(0)
    expect(first.position.x).toBe(0)
    q.sampleAt(0.5)
    expect(first.position.x).toBeCloseTo(600.5310186, 4)
    // but two queries never share scratch
    const other = buildTrackQuery(makeCircleTrack())
    expect(q.sampleAt(0)).not.toBe(other.sampleAt(0))
  })

  it('samples the circle fixture on its radius', () => {
    const q = buildTrackQuery(makeCircleTrack())
    expect(q.sampleAt(0).position).toEqual({ x: 100, y: 0, z: 0 })
    const t = q.tangentAt(0)
    expect(t.x).toBeCloseTo(0, 12)
    expect(t.y).toBe(0)
    expect(t.z).toBeCloseTo(1, 12)
    // Catmull-Rom through 16 circle points bows very slightly inside the true circle:
    // the midpoint of a segment sits at radius 99.944974 instead of 100
    const mid = q.sampleAt(0.03125)
    expect(Math.hypot(mid.position.x, mid.position.z)).toBeCloseTo(99.944974, 5)
    const quarter = q.sampleAt(0.25)
    expect(quarter.position.x).toBeCloseTo(0, 9)
    expect(quarter.position.z).toBeCloseTo(100, 9)
  })

  it('samples width, banking and surface from the oval', () => {
    // s = 0.35 is inside the right turn, between control points 5 (s = 0.3168) and
    // 9 (s = 0.4634), which are all 20 m wide and banked 0.2 rad
    const q = buildTrackQuery(makeOvalTrack())
    const p = q.sampleAt(0.35)
    expect(p.position.x).toBeCloseTo(284.006904, 4)
    expect(p.position.z).toBeCloseTo(-54.209059, 4)
    expect(p.width).toBe(20)
    expect(p.banking).toBe(0.2)
    expect(p.surface).toBe('tarmac')
    // s = 0 is the start of the 24 m wide flat bottom straight
    const start = q.sampleAt(0)
    expect(start.position).toEqual({ x: -200, y: 0, z: -100 })
    expect(start.width).toBe(24)
    expect(start.banking).toBe(0)
  })

  it('groundHeight adds the spline height and the banking cross-fall', () => {
    // banked 0.2 rad, so the cross-fall is lateral * tan(0.2) = lateral * 0.2027100355
    // and 6 m to the right of the centreline is 6 * 0.2027100355 = 1.2162602131 higher
    const oval = buildTrackQuery(makeOvalTrack())
    expect(oval.groundHeight(0.35, 0)).toBe(0)
    expect(oval.groundHeight(0.35, 6)).toBeCloseTo(1.2162602131, 9)
    expect(oval.groundHeight(0.35, -6)).toBeCloseTo(-1.2162602131, 9)
    // the straight fixture has no banking at all, so lateral changes nothing
    const flat = buildTrackQuery(makeStraightTrack())
    expect(flat.groundHeight(0.2, 8)).toBe(0)
    // raise control point 2 to y = 10 and the height at that point follows the spline
    const base = makeStraightTrack()
    const hilly = buildTrackQuery(
      makeStraightTrack({
        controlPoints: base.controlPoints.map((p, i) => ({
          ...p,
          position: v3(p.position.x, i === 2 ? 10 : 0, p.position.z),
        })),
      }),
    )
    const sAtHill = hilly.project(v3(300, 0, 0)).s // control point 2 is (300, *, 0)
    expect(sAtHill).toBeCloseTo(0.1644481, 6)
    expect(hilly.groundHeight(sAtHill, 0)).toBeCloseTo(10, 6)
  })

  it('surfaceAt gives offtrack first, then boost pads, then the segment surface', () => {
    const q = buildTrackQuery(makeOvalTrack())
    // right turn: 20 m wide, so the edge is at |lateral| = 10
    expect(q.surfaceAt(0.35, 0)).toBe('tarmac')
    expect(q.surfaceAt(0.35, 9.9)).toBe('tarmac')
    expect(q.surfaceAt(0.35, 10.1)).toBe('offtrack')
    // boost pad at s = 0.1, lateral 0, halfWidth 4. Its longitudinal half-extent is
    // BOOST_PAD_HALF_LENGTH / totalLength = 4 / 1427.7555 = 0.0028016 of s
    expect(q.surfaceAt(0.1, 0)).toBe('boost')
    expect(q.surfaceAt(0.1, 3)).toBe('boost')
    expect(q.surfaceAt(0.1, 5)).toBe('tarmac') // outside the pad laterally
    expect(q.surfaceAt(0.105, 0)).toBe('tarmac') // 0.005 * 1427.76 = 7.1 m past the pad
    expect(q.surfaceAt(0.1, 13)).toBe('offtrack') // offtrack beats the pad (24 m wide here)
    // control points 12 and 13 are dirt, so s in [0.640104, 0.780208) is dirt
    expect(q.surfaceAt(0.63, 0)).toBe('tarmac')
    expect(q.surfaceAt(0.65, 0)).toBe('dirt')
    expect(q.surfaceAt(0.77, 0)).toBe('dirt')
    expect(q.surfaceAt(0.79, 0)).toBe('tarmac')
  })

  it('isInBounds allows one half-width of run-off past each edge', () => {
    const q = buildTrackQuery(makeOvalTrack())
    // bottom straight is 24 m wide: edge at 12, out of bounds past 24
    expect(q.isInBounds(0.02, 0)).toBe(true)
    expect(q.isInBounds(0.02, 24)).toBe(true)
    expect(q.isInBounds(0.02, -24)).toBe(true)
    expect(q.isInBounds(0.02, 24.001)).toBe(false)
    // right turn is 20 m wide: out of bounds past 20
    expect(q.isInBounds(0.35, 20)).toBe(true)
    expect(q.isInBounds(0.35, 20.001)).toBe(false)
  })

  it('checkpointIndexAt returns the last checkpoint passed, and wraps', () => {
    // oval ring is [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875]
    const oval = buildTrackQuery(makeOvalTrack())
    expect(oval.checkpointIndexAt(0)).toBe(0)
    expect(oval.checkpointIndexAt(0.124)).toBe(0)
    expect(oval.checkpointIndexAt(0.125)).toBe(1)
    expect(oval.checkpointIndexAt(0.9)).toBe(7)
    expect(oval.checkpointIndexAt(0.999)).toBe(7)
    expect(oval.checkpointIndexAt(1.125)).toBe(1) // s wraps
    expect(oval.checkpointIndexAt(-0.001)).toBe(7) // and wraps backwards
    // a ring that does not start at 0: anything before the first checkpoint belongs to
    // the last one, because the kart crossed it on the previous lap
    const shifted = buildTrackQuery(makeStraightTrack({ checkpointS: [0.1, 0.4, 0.7] }))
    expect(shifted.checkpointIndexAt(0.05)).toBe(2)
    expect(shifted.checkpointIndexAt(0.1)).toBe(0)
    expect(shifted.checkpointIndexAt(0.39)).toBe(0)
    expect(shifted.checkpointIndexAt(0.4)).toBe(1)
    expect(shifted.checkpointIndexAt(0.95)).toBe(2)
  })

  it('project matches projectPoint on the same track', () => {
    const tr = makeStraightTrack()
    const table = buildArcTable(tr)
    const q = buildTrackQuery(tr)
    const direct: TrackProjection = { s: 0, lateral: 0, distance: 0 }
    projectPoint(tr, table, v3(300, 0, 5), direct)
    const viaQuery = q.project(v3(300, 0, 5))
    expect(viaQuery.s).toBe(direct.s)
    expect(viaQuery.lateral).toBe(direct.lateral)
    expect(viaQuery.distance).toBe(direct.distance)
    expect(direct.lateral).toBeCloseTo(5, 9)
  })
})
```

- [ ] **Step 14: Run the query test to verify it fails**

Run: `npx vitest run packages/sim/test/track-query.test.ts -t "buildTrackQuery"`

Expected: FAIL — `SyntaxError: The requested module '../src/track' does not provide an export named 'buildTrackQuery'`

- [ ] **Step 15: Write buildTrackQuery**

Append to the end of `packages/sim/src/track.ts`, after `projectPoint`:

```ts
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
```

- [ ] **Step 16: Run the query test to verify it passes**

Run: `npx vitest run packages/sim/test/track-query.test.ts`

Expected: PASS — 30 passed (7 spline core + 6 arc-length table + 5 projectPoint +
12 buildTrackQuery).

---

- [ ] **Step 17: Write the failing test for makeContext**

Append to `packages/sim/test/track-query.test.ts`, after the closing `})` of
`describe('buildTrackQuery', ...)`, and add `makeContext` to the existing
`./fixtures/track-fixtures` import at the top of the file so it reads:

```ts
import {
  makeCircleTrack,
  makeContext,
  makeOvalTrack,
  makeStraightTrack,
} from './fixtures/track-fixtures'
```

```ts
describe('makeContext', () => {
  it('builds a leader context by default', () => {
    const track = makeStraightTrack()
    const ctx = makeContext(track)
    expect(ctx.track).toBe(track)
    expect(ctx.isLeader).toBe(true)
    expect(ctx.tuning.maxSpeed).toBe(40)
    expect(ctx.tuning.kartRadius).toBe(0.9)
    expect(ctx.characters).toHaveLength(8)
    expect(ctx.characters[5].speed).toBe(1.15)
    expect(ctx.query.totalLength()).toBeCloseTo(1828.3236243, 6)
  })

  it('builds a follower context when isLeader is false', () => {
    const ctx = makeContext(makeOvalTrack(), false)
    expect(ctx.isLeader).toBe(false)
    expect(ctx.query.totalLength()).toBeCloseTo(1427.7555092, 6)
    expect(ctx.query.sampleAt(0).position).toEqual({ x: -200, y: 0, z: -100 })
  })

  it('gives every context its own query and its own scratch', () => {
    const a = makeContext(makeStraightTrack())
    const b = makeContext(makeStraightTrack())
    expect(a.query).not.toBe(b.query)
    expect(a.query.sampleAt(0)).not.toBe(b.query.sampleAt(0))
  })
})
```

- [ ] **Step 18: Run the makeContext test to verify it fails**

Run: `npx vitest run packages/sim/test/track-query.test.ts -t "makeContext"`

Expected: FAIL — `SyntaxError: The requested module './fixtures/track-fixtures' does not provide an export named 'makeContext'`

- [ ] **Step 19: Write makeContext**

In `packages/sim/test/fixtures/track-fixtures.ts`, change the import block at the top from:

```ts
import type { CharacterStats, Surface, Track, TrackPoint, Tuning } from '../../src/types'
import { v3 } from '../../src/vec3'
```

to:

```ts
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
```

Then append to the end of the file, after `makeOvalTrack`:

```ts
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
```

- [ ] **Step 20: Run the makeContext test to verify it passes**

Run: `npx vitest run packages/sim/test/track-query.test.ts`

Expected: PASS — 33 passed (the 30 above plus the 3 `makeContext` tests).

- [ ] **Step 21: Typecheck and run the whole sim suite**

Run: `npx tsc --noEmit -p packages/sim && npx vitest run packages/sim`

Expected: PASS — no TypeScript errors; `track-query.test.ts` 33 passed, plus the 31 from
Task 3's `track-fixtures.test.ts` (7) and `track-validate.test.ts` (24), plus the 50 Task 2
left (2 scaffold, 7 types, 17 vec3, 15 mathutil, 9 rng) — 114 in `packages/sim` overall.

- [ ] **Step 22: Commit**

```bash
git add packages/sim/src/track.ts packages/sim/test/fixtures/track-fixtures.ts packages/sim/test/track-query.test.ts
git commit -m "feat(sim): arc-length track query over a closed Catmull-Rom centreline"
```
