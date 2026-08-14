### Task 3: Track Fixtures and Track Validator

This is **Task 3**, and the locked contract labels both halves of it Task 3: contract
§2 marks `validateTrack(track: Track): string[]` in `packages/sim/src/track.ts` as
`[Task 3]`, and contract §3 marks `packages/sim/test/fixtures/track-fixtures.ts` as
`[Task 3]`. The other two entries on those same lines belong to **Task 4**:
`buildTrackQuery(track: Track): TrackQuery` in the same `track.ts`, and
`makeContext(track, isLeader?)` appended to the same fixtures file. Task 3 writes the
file first; Task 4 appends to it. Neither task rewrites the other's half.

**Files:**
- Create: `packages/sim/test/fixtures/track-fixtures.ts`
- Create: `packages/sim/src/track.ts`
- Test: `packages/sim/test/track-fixtures.test.ts`
- Test: `packages/sim/test/track-validate.test.ts`

**Interfaces:**

- Consumes (from Task 2, `packages/sim/src/types.ts`):
  - `type Vec3 = { x: number; y: number; z: number }`
  - `const MAX_KARTS = 8`
  - `type Surface = 'tarmac' | 'dirt' | 'boost' | 'offtrack'`
  - `interface TrackPoint { position: Vec3; width: number; banking: number; surface: Surface }`
  - `interface Track { id: string; name: string; controlPoints: TrackPoint[]; checkpointS: number[]; itemBoxes: { s: number; lateral: number }[]; ramps: { sStart: number; sEnd: number; launch: number }[]; boostPads: { s: number; lateral: number; halfWidth: number }[]; startPositions: { s: number; lateral: number }[]; bounds: { min: Vec3; max: Vec3 } }`
  - `interface CharacterStats { id: string; name: string; speed: number; accel: number; handling: number; weight: number }`
  - `interface Tuning` — 25 fields, every one of them set by `makeTuning`, all `number`
    except the two 3-tuples: `maxSpeed`, `accelRate`, `brakeRate`, `steerRateBase`,
    `steerSpeedFalloff`, `gripTarmac`, `gripDirt`, `gripDrift`, `gravity`, `airYaw`,
    `offtrackSpeedMul`, `respawnTicks`, `invulnTicks`, `spinOutTicks`, `driftMinSpeed`,
    `driftTiers: [number, number, number]`, `driftBoosts: [number, number, number]`,
    `boostSpeedMul`, `surgeSpeedMul`, `kartRadius`, `kartRestitution`,
    `itemBoxRespawnTicks`, `seekerSpeed`, `boltSpeed`, `entityTtl`
- Consumes (from Task 2, `packages/sim/src/vec3.ts`):
  - `function v3(x: number, y: number, z: number): Vec3`
- Produces (`packages/sim/test/fixtures/track-fixtures.ts`):
  - `function makeTuning(overrides?: Partial<Tuning>): Tuning`
  - `function makeCharacters(): CharacterStats[]` — exactly 8
  - `function makeStraightTrack(overrides?: Partial<Track>): Track` — 12 control points, front straight along +X
  - `function makeCircleTrack(overrides?: Partial<Track>): Track` — 16 control points, radius 100
  - `function makeOvalTrack(overrides?: Partial<Track>): Track` — 20 control points, golden fixture track
- Produces (`packages/sim/src/track.ts`):
  - `const VALIDATION_KART_RADIUS = 0.9` — new constant, not in the contract; the validator has no `Tuning` argument, so the clearance rule needs its own copy of the base tuning's `kartRadius`
  - `function validateTrack(track: Track): string[]` — `[]` when valid

**Two sequencing notes the engineer must read before starting:**

1. `makeContext(track, isLeader?)` is **not** in this task — it is **Task 4**, appended
   to this same `track-fixtures.ts`, and contract §3 marks it `[Task 4]` for that reason.
   `SimContext.query` is a `TrackQuery`, and the only thing that can produce one is
   `buildTrackQuery`, which Task 4 writes. The reason this is a hard ordering and not a
   preference is ESM linking: `import { buildTrackQuery } from '../../src/track'` is
   resolved when the module graph is linked, *before* any test body runs, so if
   `track.ts` does not export that name yet the whole file fails to load with
   `SyntaxError: The requested module '../../src/track' does not provide an export named
   'buildTrackQuery'`. Every test in this task would then fail for the wrong reason, and
   the failure would look like a bug in the fixtures. So Task 3's `track-fixtures.ts`
   imports **only** `../../src/types` and `../../src/vec3`; Task 4 widens that import
   block when it appends `makeContext`.
2. `validateTrack` deliberately does **not** build the spline. It is a static check on
   track *data* and runs before any `TrackQuery` exists (it is what gates
   DeepSeek-generated track JSON). Where it needs a length or a width at some `s`, it
   uses the control polygon and a segment-uniform `s`, both documented below. The
   runtime `TrackQuery` in Task 4 uses true arc length; the two agree exactly on all
   three fixtures because their widths are constant across every segment a fixture
   places a start position, item box, or boost pad on.

**Contract note on the sign of `lateral`.** Section 0 of the contract fixes
`right = (-t.z, 0, t.x)` and "positive is **right** of the direction of travel". For a
kart travelling +X the tangent is `t = (1, 0, 0)`, so `right = (-0, 0, 1) = +z`.
Positive `lateral` is therefore toward **+z** on the straight fixture, which is what
contract §3 now says. (An earlier revision of the contract said `-z` there; that
revision is retracted, §0's formula is authoritative, and Task 4 asserts the resulting
sign numerically with `projectPoint(tr, table, v3(300, 0, 5), out)` → `lateral = +5`.)

**Contract note on `s`.** Every `s` in these fixtures — `checkpointS`, `itemBoxes[].s`,
`ramps[].sStart` / `.sEnd`, `boostPads[].s`, `startPositions[].s` — is **arc-normalised
into `[0, 1)`**, never metres, per contract §0. That is why `validateTrack` rejects
anything outside `0..1`, and why the start-grid separation rule below has to multiply an
`s`-delta by a length in metres before it can compare against `2 * kartRadius`.

**These fixture numbers are the contract, transcribed.** The `makeTuning` table below is
contract §3's base `Tuning` table value for value (all 25 fields), and `makeCharacters`
is contract §3's four stat rows for the 8 characters. Do not "improve" a number here: ten
other tasks derive concrete expectations from them.

---

- [ ] **Step 1: Write the failing test for the fixtures**

Create `packages/sim/test/track-fixtures.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  makeCharacters,
  makeCircleTrack,
  makeOvalTrack,
  makeStraightTrack,
  makeTuning,
} from './fixtures/track-fixtures'

describe('track fixtures', () => {
  it('makeTuning returns the locked base tuning values', () => {
    const t = makeTuning()
    expect(t.maxSpeed).toBe(40)
    expect(t.accelRate).toBe(24)
    expect(t.brakeRate).toBe(48)
    expect(t.steerRateBase).toBe(2.6)
    expect(t.steerSpeedFalloff).toBe(0.55)
    expect(t.gripTarmac).toBe(14)
    expect(t.gripDirt).toBe(5)
    expect(t.gripDrift).toBe(3)
    expect(t.gravity).toBe(30)
    expect(t.airYaw).toBe(0.6)
    expect(t.offtrackSpeedMul).toBe(0.55)
    expect(t.respawnTicks).toBe(72)
    expect(t.invulnTicks).toBe(90)
    expect(t.spinOutTicks).toBe(60)
    expect(t.driftMinSpeed).toBe(8)
    expect(t.driftTiers).toEqual([40, 90, 150])
    expect(t.driftBoosts).toEqual([24, 42, 66])
    expect(t.boostSpeedMul).toBe(1.35)
    expect(t.surgeSpeedMul).toBe(0.7)
    expect(t.kartRadius).toBe(0.9)
    expect(t.kartRestitution).toBe(0.4)
    expect(t.itemBoxRespawnTicks).toBe(180)
    expect(t.seekerSpeed).toBe(55)
    expect(t.boltSpeed).toBe(65)
    expect(t.entityTtl).toBe(600)
  })

  it('makeTuning applies overrides and leaves every other field alone', () => {
    const t = makeTuning({ maxSpeed: 10, gripTarmac: 1 })
    expect(t.maxSpeed).toBe(10)
    expect(t.gripTarmac).toBe(1)
    // untouched neighbours keep the base values
    expect(t.accelRate).toBe(24)
    expect(t.gripDirt).toBe(5)
    expect(t.entityTtl).toBe(600)
    // the base object is not mutated by an override call
    expect(makeTuning().maxSpeed).toBe(40)
  })

  it('makeCharacters returns exactly 8 rows matching the locked stat table', () => {
    const c = makeCharacters()
    expect(c).toHaveLength(8)
    expect(c.map((x) => x.speed)).toEqual([1.0, 1.1, 0.92, 1.05, 0.95, 1.15, 0.88, 1.0])
    expect(c.map((x) => x.accel)).toEqual([1.0, 0.85, 1.15, 0.9, 1.1, 0.8, 1.2, 1.0])
    expect(c.map((x) => x.handling)).toEqual([1.0, 0.9, 1.1, 0.95, 1.05, 0.85, 1.15, 1.0])
    expect(c.map((x) => x.weight)).toEqual([1.0, 1.2, 0.85, 1.1, 0.9, 1.3, 0.8, 1.0])
    expect(c.map((x) => x.id)).toEqual(['c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7'])
    expect(c[5].name).toBe('Racer 5')
  })

  it('makeStraightTrack has 12 control points with a +X front straight', () => {
    const tr = makeStraightTrack()
    expect(tr.id).toBe('straight')
    expect(tr.controlPoints).toHaveLength(12)
    // control points 0..4 are collinear along +X at z = 0, spaced 150 apart
    for (let i = 0; i <= 4; i++) {
      expect(tr.controlPoints[i].position.x).toBe(i * 150)
      expect(tr.controlPoints[i].position.y).toBe(0)
      expect(tr.controlPoints[i].position.z).toBe(0)
    }
    // the return leg sits at z = 120
    expect(tr.controlPoints[8].position).toEqual({ x: 600, y: 0, z: 120 })
    expect(tr.controlPoints[10].position).toEqual({ x: 0, y: 0, z: 120 })
    expect(tr.controlPoints[11].position).toEqual({ x: -140, y: 0, z: 60 })
    // uniform 20 m width, no banking, all tarmac
    expect(tr.controlPoints.every((p) => p.width === 20)).toBe(true)
    expect(tr.controlPoints.every((p) => p.banking === 0)).toBe(true)
    expect(tr.controlPoints.every((p) => p.surface === 'tarmac')).toBe(true)
    expect(tr.checkpointS).toEqual([0, 0.25, 0.5, 0.75])
    expect(tr.startPositions).toHaveLength(8)
    expect(tr.startPositions[0]).toEqual({ s: 0.01, lateral: -5 })
    expect(tr.startPositions[7]).toEqual({ s: 0.055, lateral: 5 })
    expect(tr.ramps).toEqual([{ sStart: 0.4, sEnd: 0.44, launch: 6 }])
    expect(tr.boostPads).toEqual([{ s: 0.6, lateral: 0, halfWidth: 3 }])
    expect(tr.bounds.min).toEqual({ x: -200, y: -20, z: -40 })
    expect(tr.bounds.max).toEqual({ x: 800, y: 40, z: 160 })
  })

  it('makeStraightTrack applies overrides', () => {
    const tr = makeStraightTrack({ checkpointS: [0.1, 0.4, 0.7], id: 'custom' })
    expect(tr.id).toBe('custom')
    expect(tr.checkpointS).toEqual([0.1, 0.4, 0.7])
    expect(tr.controlPoints).toHaveLength(12) // untouched
  })

  it('makeCircleTrack has 16 control points on a radius-100 circle', () => {
    const tr = makeCircleTrack()
    expect(tr.controlPoints).toHaveLength(16)
    // point i sits at angle i*2pi/16; point 0 is exactly (100, 0, 0)
    expect(tr.controlPoints[0].position.x).toBe(100)
    expect(tr.controlPoints[0].position.z).toBe(0)
    // point 4 is a quarter turn round: (100*cos(pi/2), 0, 100*sin(pi/2)) = (~0, 0, 100)
    expect(tr.controlPoints[4].position.x).toBeCloseTo(0, 9)
    expect(tr.controlPoints[4].position.z).toBeCloseTo(100, 9)
    for (const p of tr.controlPoints) {
      expect(Math.hypot(p.position.x, p.position.z)).toBeCloseTo(100, 9)
      expect(p.position.y).toBe(0)
      expect(p.width).toBe(20)
    }
    expect(tr.ramps).toEqual([])
    expect(tr.startPositions).toHaveLength(8)
  })

  it('makeOvalTrack has 20 control points, banked turns and a dirt sector', () => {
    const tr = makeOvalTrack()
    expect(tr.controlPoints).toHaveLength(20)
    // 0..4: bottom straight, z = -100, x from -200 to 200 in steps of 100
    expect(tr.controlPoints[0].position).toEqual({ x: -200, y: 0, z: -100 })
    expect(tr.controlPoints[4].position).toEqual({ x: 200, y: 0, z: -100 })
    // 5..9: right turn, radius 100 about (200, 0, 0); index 7 is theta = 0
    expect(tr.controlPoints[7].position.x).toBeCloseTo(300, 9)
    expect(tr.controlPoints[7].position.z).toBeCloseTo(0, 9)
    // 10..14: top straight, z = +100
    expect(tr.controlPoints[10].position).toEqual({ x: 200, y: 0, z: 100 })
    expect(tr.controlPoints[14].position).toEqual({ x: -200, y: 0, z: 100 })
    // 15..19: left turn, radius 100 about (-200, 0, 0); index 17 is theta = 180
    expect(tr.controlPoints[17].position.x).toBeCloseTo(-300, 9)
    expect(tr.controlPoints[17].position.z).toBeCloseTo(0, 9)
    // straights are 24 m wide and flat, turns are 20 m wide and banked 0.2 rad
    expect(tr.controlPoints[2].width).toBe(24)
    expect(tr.controlPoints[2].banking).toBe(0)
    expect(tr.controlPoints[7].width).toBe(20)
    expect(tr.controlPoints[7].banking).toBe(0.2)
    expect(tr.controlPoints[17].banking).toBe(0.2)
    // exactly two dirt control points, 12 and 13, so segments 12 and 13 are dirt
    expect(tr.controlPoints.map((p) => p.surface).filter((s) => s === 'dirt')).toHaveLength(2)
    expect(tr.controlPoints[12].surface).toBe('dirt')
    expect(tr.controlPoints[13].surface).toBe('dirt')
    expect(tr.controlPoints[11].surface).toBe('tarmac')
    expect(tr.controlPoints[14].surface).toBe('tarmac')
    expect(tr.checkpointS).toEqual([0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875])
    expect(tr.itemBoxes).toHaveLength(6)
    expect(tr.boostPads).toEqual([{ s: 0.1, lateral: 0, halfWidth: 4 }])
    expect(tr.ramps).toEqual([{ sStart: 0.55, sEnd: 0.58, launch: 7 }])
  })
})
```

- [ ] **Step 2: Run the fixture test to verify it fails**

Run: `npx vitest run packages/sim/test/track-fixtures.test.ts`

Expected: FAIL — `Failed to resolve import "./fixtures/track-fixtures" from "packages/sim/test/track-fixtures.test.ts". Does the file exist?`

- [ ] **Step 3: Write the fixtures file**

Create `packages/sim/test/fixtures/track-fixtures.ts`:

```ts
import type { CharacterStats, Surface, Track, TrackPoint, Tuning } from '../../src/types'
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
      { s: 0.01, lateral: -5 },
      { s: 0.01, lateral: 5 },
      { s: 0.025, lateral: -5 },
      { s: 0.025, lateral: 5 },
      { s: 0.04, lateral: -5 },
      { s: 0.04, lateral: 5 },
      { s: 0.055, lateral: -5 },
      { s: 0.055, lateral: 5 },
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
      { s: 0.005, lateral: -6 },
      { s: 0.005, lateral: 6 },
      { s: 0.02, lateral: -6 },
      { s: 0.02, lateral: 6 },
      { s: 0.035, lateral: -6 },
      { s: 0.035, lateral: 6 },
      { s: 0.05, lateral: -6 },
      { s: 0.05, lateral: 6 },
    ],
    bounds: { min: v3(-320, -20, -120), max: v3(320, 20, 120) },
    ...overrides,
  }
}
```

- [ ] **Step 4: Run the fixture test to verify it passes**

Run: `npx vitest run packages/sim/test/track-fixtures.test.ts`

Expected: PASS — 7 passed.

---

- [ ] **Step 5: Write the failing test for control point and checkpoint validation**

Create `packages/sim/test/track-validate.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { validateTrack } from '../src/track'
import { makeCircleTrack, makeOvalTrack, makeStraightTrack } from './fixtures/track-fixtures'

describe('validateTrack: control points and checkpoints', () => {
  it('accepts all three fixture tracks', () => {
    expect(validateTrack(makeStraightTrack())).toEqual([])
    expect(validateTrack(makeCircleTrack())).toEqual([])
    expect(validateTrack(makeOvalTrack())).toEqual([])
  })

  it('rejects fewer than 8 control points', () => {
    const base = makeStraightTrack()
    const tr = makeStraightTrack({ controlPoints: base.controlPoints.slice(0, 5) })
    expect(validateTrack(tr)).toEqual(['controlPoints: need at least 8, got 5'])
  })

  it('rejects a non-finite control point position', () => {
    const base = makeStraightTrack()
    const tr = makeStraightTrack({
      controlPoints: base.controlPoints.map((p, i) =>
        i === 4 ? { ...p, position: { x: NaN, y: 0, z: 0 } } : p,
      ),
    })
    expect(validateTrack(tr)).toEqual(['controlPoints[4].position: must be finite'])
  })

  it('rejects two coincident consecutive control points', () => {
    // control point 2 is already (300, 0, 0); moving 3 on top of it makes the pair (2, 3)
    // coincident, which would give the spline a zero-length segment
    const base = makeStraightTrack()
    const tr = makeStraightTrack({
      controlPoints: base.controlPoints.map((p, i) =>
        i === 3 ? { ...p, position: { x: 300, y: 0, z: 0 } } : p,
      ),
    })
    expect(validateTrack(tr)).toEqual(['controlPoints[2]: coincident with controlPoints[3]'])
  })

  it('treats the closing pair (last, first) as consecutive', () => {
    // last control point is (-140, 0, 60); moving it onto control point 0 at (0, 0, 0)
    // closes the loop with a zero-length segment
    const base = makeStraightTrack()
    const tr = makeStraightTrack({
      controlPoints: base.controlPoints.map((p, i) =>
        i === 11 ? { ...p, position: { x: 0, y: 0, z: 0 } } : p,
      ),
    })
    expect(validateTrack(tr)).toEqual(['controlPoints[11]: coincident with controlPoints[0]'])
  })

  it('rejects a non-positive width', () => {
    const base = makeStraightTrack()
    const tr = makeStraightTrack({
      controlPoints: base.controlPoints.map((p, i) => (i === 2 ? { ...p, width: 0 } : p)),
    })
    expect(validateTrack(tr)).toEqual([
      'controlPoints[2].width: must be positive and finite, got 0',
    ])
  })

  it('rejects an empty checkpoint ring', () => {
    expect(validateTrack(makeStraightTrack({ checkpointS: [] }))).toEqual([
      'checkpointS: must be non-empty',
    ])
  })

  it('rejects a non-ascending checkpoint ring', () => {
    expect(validateTrack(makeStraightTrack({ checkpointS: [0, 0.5, 0.5, 0.75] }))).toEqual([
      'checkpointS[2]: must be strictly ascending, got 0.5 after 0.5',
    ])
  })

  it('rejects a checkpoint outside 0..1', () => {
    expect(validateTrack(makeStraightTrack({ checkpointS: [0, 0.5, 1.4] }))).toEqual([
      'checkpointS[2]: must be within 0..1, got 1.4',
    ])
  })
})
```

- [ ] **Step 6: Run the validator test to verify it fails**

Run: `npx vitest run packages/sim/test/track-validate.test.ts`

Expected: FAIL — `Failed to resolve import "../src/track" from "packages/sim/test/track-validate.test.ts". Does the file exist?`

- [ ] **Step 7: Write the control point and checkpoint half of the validator**

Create `packages/sim/src/track.ts`:

```ts
import type { Track, Vec3 } from './types'

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

function checkCheckpoints(track: Track, errs: string[]): void {
  const cs = track.checkpointS
  if (cs.length === 0) errs.push('checkpointS: must be non-empty')
  for (let i = 0; i < cs.length; i++) {
    if (!(Number.isFinite(cs[i]) && cs[i] >= 0 && cs[i] <= 1)) {
      errs.push(`checkpointS[${i}]: must be within 0..1, got ${cs[i]}`)
    } else if (i > 0 && !(cs[i] > cs[i - 1])) {
      errs.push(`checkpointS[${i}]: must be strictly ascending, got ${cs[i]} after ${cs[i - 1]}`)
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
  return errs
}
```

- [ ] **Step 8: Run the validator test to verify it passes**

Run: `npx vitest run packages/sim/test/track-validate.test.ts`

Expected: PASS — 9 passed.

---

- [ ] **Step 9: Write the failing test for start-grid validation**

Append to `packages/sim/test/track-validate.test.ts`, after the closing `})` of the
`describe('validateTrack: control points and checkpoints', ...)` block:

```ts
describe('validateTrack: start grid', () => {
  it('rejects a grid that is not exactly MAX_KARTS entries', () => {
    const base = makeStraightTrack()
    const tr = makeStraightTrack({ startPositions: base.startPositions.slice(0, 7) })
    expect(validateTrack(tr)).toEqual(['startPositions: need exactly 8, got 7'])
  })

  it('rejects a start position outside 0..1', () => {
    const base = makeStraightTrack()
    const tr = makeStraightTrack({
      startPositions: base.startPositions.map((p, i) => (i === 3 ? { s: 1.2, lateral: 5 } : p)),
    })
    expect(validateTrack(tr)).toEqual(['startPositions[3].s: must be within 0..1, got 1.2'])
  })

  it('rejects a start position wider than the half-width', () => {
    // straight fixture is 20 m wide everywhere, so the half-width is exactly 10
    const base = makeStraightTrack()
    const tr = makeStraightTrack({
      startPositions: base.startPositions.map((p, i) => (i === 3 ? { s: p.s, lateral: 11 } : p)),
    })
    expect(validateTrack(tr)).toEqual([
      'startPositions[3].lateral: |11| exceeds half-width 10.000',
    ])
  })

  it('rejects two start positions closer than 2 * kart radius', () => {
    // slots 0 and 1 share s = 0.01, so their separation is purely lateral.
    // moving slot 1 from +5 to -3.5 leaves |-3.5 - -5| = 1.5, below 2 * 0.9 = 1.8
    const base = makeStraightTrack()
    const tr = makeStraightTrack({
      startPositions: base.startPositions.map((p, i) =>
        i === 1 ? { s: 0.01, lateral: -3.5 } : p,
      ),
    })
    expect(validateTrack(tr)).toEqual([
      'startPositions[0] and startPositions[1]: separation 1.500 is below 1.800',
    ])
  })

  it('measures separation along the track as well as across it', () => {
    // straight fixture control polygon is 1813.437 m round. Slots 0 and 1 are put on the
    // same lateral, ds apart: 0.0005 * 1813.437 = 0.907 m < 1.8, so this must be rejected,
    // and the reported separation is hypot(0.907, 0) = 0.907
    const base = makeStraightTrack()
    const tr = makeStraightTrack({
      startPositions: base.startPositions.map((p, i) =>
        i === 0 ? { s: 0.0095, lateral: 5 } : i === 1 ? { s: 0.01, lateral: 5 } : p,
      ),
    })
    expect(validateTrack(tr)).toEqual([
      'startPositions[0] and startPositions[1]: separation 0.907 is below 1.800',
    ])
  })

  it('keeps the oval start grid valid at 12 m minimum separation', () => {
    // oval slots pair up at the same s with lateral -6 and +6, so the tightest pair is 12 m
    expect(validateTrack(makeOvalTrack())).toEqual([])
  })
})
```

- [ ] **Step 10: Run the start-grid test to verify it fails**

Run: `npx vitest run packages/sim/test/track-validate.test.ts -t "start grid"`

Expected: FAIL — all six assertions get `[]` back, e.g.
`AssertionError: expected [] to deeply equal [ 'startPositions: need exactly 8, got 7' ]`.

- [ ] **Step 11: Add start-grid validation**

In `packages/sim/src/track.ts`, change the first line from:

```ts
import type { Track, Vec3 } from './types'
```

to:

```ts
import type { Track, Vec3 } from './types'
import { MAX_KARTS } from './types'
```

Then insert these two helpers and `checkStartPositions`
immediately after `checkCheckpoints` and before the `validateTrack` doc comment:

```ts
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
```

Then change `validateTrack` from:

```ts
export function validateTrack(track: Track): string[] {
  const errs: string[] = []
  checkControlPoints(track, errs)
  checkCheckpoints(track, errs)
  return errs
}
```

to:

```ts
export function validateTrack(track: Track): string[] {
  const errs: string[] = []
  checkControlPoints(track, errs)
  checkCheckpoints(track, errs)
  checkStartPositions(track, errs)
  return errs
}
```

- [ ] **Step 12: Run the start-grid test to verify it passes**

Run: `npx vitest run packages/sim/test/track-validate.test.ts`

Expected: PASS — 15 passed.

---

- [ ] **Step 13: Write the failing test for item boxes, boost pads, ramps and bounds**

Append to `packages/sim/test/track-validate.test.ts`, after the closing `})` of the
`describe('validateTrack: start grid', ...)` block:

```ts
describe('validateTrack: props and bounds', () => {
  it('rejects an item box outside 0..1', () => {
    expect(validateTrack(makeStraightTrack({ itemBoxes: [{ s: 1.5, lateral: 0 }] }))).toEqual([
      'itemBoxes[0].s: must be within 0..1, got 1.5',
    ])
  })

  it('rejects an item box outside the half-width', () => {
    // straight fixture half-width is 10 everywhere
    expect(validateTrack(makeStraightTrack({ itemBoxes: [{ s: 0.3, lateral: 12 }] }))).toEqual([
      'itemBoxes[0].lateral: |12| exceeds half-width 10.000',
    ])
  })

  it('rejects a boost pad outside 0..1', () => {
    const tr = makeStraightTrack({ boostPads: [{ s: -0.1, lateral: 0, halfWidth: 3 }] })
    expect(validateTrack(tr)).toEqual(['boostPads[0].s: must be within 0..1, got -0.1'])
  })

  it('rejects a boost pad outside the half-width', () => {
    const tr = makeStraightTrack({ boostPads: [{ s: 0.6, lateral: -10.5, halfWidth: 3 }] })
    expect(validateTrack(tr)).toEqual([
      'boostPads[0].lateral: |-10.5| exceeds half-width 10.000',
    ])
  })

  it('rejects a ramp whose sStart is not before its sEnd', () => {
    const tr = makeStraightTrack({ ramps: [{ sStart: 0.5, sEnd: 0.4, launch: 6 }] })
    expect(validateTrack(tr)).toEqual(['ramps[0]: sStart 0.5 must be less than sEnd 0.4'])
  })

  it('rejects a ramp endpoint outside 0..1', () => {
    const tr = makeStraightTrack({ ramps: [{ sStart: -0.2, sEnd: 0.4, launch: 6 }] })
    expect(validateTrack(tr)).toEqual(['ramps[0].sStart: must be within 0..1, got -0.2'])
  })

  it('rejects bounds that do not enclose every control point', () => {
    // control point 11 sits at x = -140; a min.x of 0 leaves it outside
    const tr = makeStraightTrack({
      bounds: { min: { x: 0, y: -20, z: -40 }, max: { x: 800, y: 40, z: 160 } },
    })
    expect(validateTrack(tr)).toEqual(['bounds: does not enclose controlPoints[11]'])
  })

  it('accepts bounds that touch a control point exactly', () => {
    // control points span x in [-140, 740], z in [0, 120], y = 0
    const tr = makeStraightTrack({
      bounds: { min: { x: -140, y: 0, z: 0 }, max: { x: 740, y: 0, z: 120 } },
    })
    expect(validateTrack(tr)).toEqual([])
  })

  it('reports every independent failure at once', () => {
    const tr = makeStraightTrack({
      checkpointS: [],
      ramps: [{ sStart: 0.5, sEnd: 0.4, launch: 6 }],
      itemBoxes: [{ s: 1.5, lateral: 0 }],
    })
    expect(validateTrack(tr)).toEqual([
      'checkpointS: must be non-empty',
      'itemBoxes[0].s: must be within 0..1, got 1.5',
      'ramps[0]: sStart 0.5 must be less than sEnd 0.4',
    ])
  })
})
```

- [ ] **Step 14: Run the props test to verify it fails**

Run: `npx vitest run packages/sim/test/track-validate.test.ts -t "props and bounds"`

Expected: FAIL — 9 failing, each `expected [] to deeply equal [ ... ]`.

- [ ] **Step 15: Add item box, boost pad, ramp and bounds validation**

In `packages/sim/src/track.ts`, insert these four functions immediately after
`checkStartPositions` and before the `validateTrack` doc comment:

```ts
function checkItemBoxes(track: Track, errs: string[]): void {
  for (let i = 0; i < track.itemBoxes.length; i++) {
    const b = track.itemBoxes[i]
    if (!(Number.isFinite(b.s) && b.s >= 0 && b.s <= 1)) {
      errs.push(`itemBoxes[${i}].s: must be within 0..1, got ${b.s}`)
      continue
    }
    const half = halfWidthAtParam(track, b.s)
    if (!(Math.abs(b.lateral) <= half)) {
      errs.push(`itemBoxes[${i}].lateral: |${b.lateral}| exceeds half-width ${half.toFixed(3)}`)
    }
  }
}

function checkBoostPads(track: Track, errs: string[]): void {
  for (let i = 0; i < track.boostPads.length; i++) {
    const b = track.boostPads[i]
    if (!(Number.isFinite(b.s) && b.s >= 0 && b.s <= 1)) {
      errs.push(`boostPads[${i}].s: must be within 0..1, got ${b.s}`)
      continue
    }
    const half = halfWidthAtParam(track, b.s)
    if (!(Math.abs(b.lateral) <= half)) {
      errs.push(`boostPads[${i}].lateral: |${b.lateral}| exceeds half-width ${half.toFixed(3)}`)
    }
  }
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
```

Then change `validateTrack` from:

```ts
export function validateTrack(track: Track): string[] {
  const errs: string[] = []
  checkControlPoints(track, errs)
  checkCheckpoints(track, errs)
  checkStartPositions(track, errs)
  return errs
}
```

to:

```ts
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
```

The call order fixes the message order asserted by the
"reports every independent failure at once" test: checkpoints, then item boxes, then ramps.

- [ ] **Step 16: Run the props test to verify it passes**

Run: `npx vitest run packages/sim/test/track-validate.test.ts`

Expected: PASS — 24 passed.

- [ ] **Step 17: Typecheck and run the whole sim suite**

Run: `npx tsc --noEmit -p packages/sim && npx vitest run packages/sim`

Expected: PASS — no TypeScript errors, all `packages/sim` tests green: 31 from these two
files (7 in `track-fixtures.test.ts`, 24 in `track-validate.test.ts`) plus the 50 Task 2
left (2 scaffold, 7 types, 17 vec3, 15 mathutil, 9 rng) — 81 in `packages/sim` overall.

- [ ] **Step 18: Commit**

```bash
git add packages/sim/src/track.ts packages/sim/test/fixtures/track-fixtures.ts packages/sim/test/track-fixtures.test.ts packages/sim/test/track-validate.test.ts
git commit -m "feat(sim): track fixtures and static track validator"
```
