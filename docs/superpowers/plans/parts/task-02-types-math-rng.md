### Task 2: Types, vec3, mathutil and rng

The four leaf modules of `packages/sim`. They import nothing outside the package
and are imported by every task from 3 onward.

`types.ts` is transcribed **verbatim** from the locked contract. Nothing is
added, renamed, reordered or reformatted, and no later task edits it.

`vec3.ts` is out-param style: every function that produces a vector writes into a
caller-owned `out` and returns `void`. Only `v3()` allocates, and it is a setup
helper, never called from inside `step()`.

`rng.ts` exposes one function, `rngAt(seed, cursor)`. It is a **pure function of
its two arguments with no internal state** — it holds no counter, no module-level
variable, nothing. `SimState.rngCursor` is the only cursor in the system, and the
leader authority advances it. That is what lets a shadow authority or a rewind
recompute any draw from `(raceSeed, rngCursor)` alone.

**Files:**
- Create: `packages/sim/src/types.ts`
- Create: `packages/sim/src/vec3.ts`
- Create: `packages/sim/src/mathutil.ts`
- Create: `packages/sim/src/rng.ts`
- Modify: `packages/sim/src/index.ts` (replace the whole file, 3 lines -> 4 lines)
- Test: `packages/sim/test/types.test.ts`
- Test: `packages/sim/test/vec3.test.ts`
- Test: `packages/sim/test/mathutil.test.ts`
- Test: `packages/sim/test/rng.test.ts`

**Interfaces:**

- Consumes (from Task 1):
  - `npm test` at the repo root runs `vitest run` over
    `packages/*/test/**/*.test.ts`, with `globals: false`.
  - `npm run typecheck` runs `tsc --noEmit -p tsconfig.json` inside
    `packages/sim`.
  - `tsconfig.base.json` sets `moduleResolution: "Bundler"` (extensionless
    imports) and `verbatimModuleSyntax: true` (type imports must be written
    `import type`).
  - `packages/sim/src/index.ts` currently contains a comment and `export {}`.

- Produces (`packages/sim/src/types.ts`) — the whole file is transcribed verbatim in
  Step 3 below; this is the list of names it exports, so a later task can check a
  name without re-reading the file:
  - Type alias `Vec3` — `{ x: number; y: number; z: number }`
  - Constants `TICK_HZ = 60`, `TICK_DT = 1 / 60`, `MAX_KARTS = 8`,
    `MAX_ENTITIES = 32`, `RACE_LAPS = 3`, `COUNTDOWN_TICKS = 180`
  - Union types `Surface` (`'tarmac' | 'dirt' | 'boost' | 'offtrack'`), `ItemKind`
    (`'none' | 'boost' | 'seeker' | 'bolt' | 'slick' | 'bubble' | 'surge' | 'blink' | 'charge'`),
    `EntityKind` (`'seeker' | 'bolt' | 'slick' | 'bubble' | 'surge' | 'charge'`),
    `RacePhase` (`'countdown' | 'racing' | 'finished'`), `AuthEventKind`
    (`'itemGrant' | 'entitySpawn' | 'entityDespawn' | 'hit' | 'spinOut' | 'respawn' | 'lapCross' | 'finish'`)
  - Interfaces `Intent`, `DriftState`, `LapProgress`, `KartState` (18 fields — the
    count `types.test.ts` asserts), `EntityState`, `ItemBoxState`, `SimState`,
    `AuthEvent`, `TrackPoint`, `Track`, `CharacterStats`, `Tuning` (25 fields),
    `SimContext`, `TrackProjection`, `TrackQuery`

  Everything in that list except the six constants is a `type` or an `interface`, so
  downstream tasks must import it with `import type { ... }` (`verbatimModuleSyntax` is
  on). The six constants are values and are imported normally, with `import { ... }`.

- Produces (the three code modules):

```ts
// packages/sim/src/vec3.ts
export function v3(x: number, y: number, z: number): Vec3
export function v3add(a: Vec3, b: Vec3, out: Vec3): void
export function v3scale(a: Vec3, s: number, out: Vec3): void
export function v3len(a: Vec3): number
export function v3dot(a: Vec3, b: Vec3): number

// packages/sim/src/mathutil.ts
export function clamp(v: number, lo: number, hi: number): number
export function lerp(a: number, b: number, t: number): number
export function wrapAngle(a: number): number     // -> (-PI, PI]

// packages/sim/src/rng.ts
export const RNG_GOLDEN = 0x9e3779b9   // 2654435769
export const RNG_MIX1 = 0x21f0aaad     // 569420461
export const RNG_MIX2 = 0x735a2d97     // 1935289751
export function rngAt(seed: number, cursor: number): number   // [0, 1)
```

`RNG_GOLDEN`, `RNG_MIX1` and `RNG_MIX2` are the only symbols in this task that
are not named in the locked contract. They are exported solely so
`rng.test.ts` can assert them directly; nothing outside `rng.ts` and its test
uses them.

---

- [ ] **Step 1: Write the failing test for types.ts**

Create `packages/sim/test/types.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import type {
  AuthEvent,
  DriftState,
  EntityState,
  Intent,
  KartState,
  LapProgress,
  SimState,
  Vec3,
} from '../src/types'
import {
  COUNTDOWN_TICKS,
  MAX_ENTITIES,
  MAX_KARTS,
  RACE_LAPS,
  TICK_DT,
  TICK_HZ,
} from '../src/types'

describe('sim constants', () => {
  it('freezes the tick rate and its reciprocal', () => {
    expect(TICK_HZ).toBe(60)
    expect(TICK_DT).toBe(1 / 60)
    // 1/60 is not exactly representable in float64; the literal below is the
    // nearest double, and TICK_DT must be that exact double.
    expect(TICK_DT).toBe(0.016666666666666666)
    // 60 * (1/60) rounds back to exactly 1.
    expect(TICK_HZ * TICK_DT).toBe(1)
  })

  it('freezes the race shape', () => {
    expect(MAX_KARTS).toBe(8)
    expect(MAX_ENTITIES).toBe(32)
    expect(RACE_LAPS).toBe(3)
  })

  it('countdown is exactly three seconds of ticks', () => {
    expect(COUNTDOWN_TICKS).toBe(180)
    expect(COUNTDOWN_TICKS).toBe(TICK_HZ * 3) // 60 * 3 = 180
    expect(COUNTDOWN_TICKS * TICK_DT).toBe(3) // 180 / 60 = 3 seconds
  })
})

describe('type shapes compile and instantiate', () => {
  it('builds an Intent with every field the contract lists', () => {
    const intent: Intent = {
      tick: 7,
      steer: -1,
      accel: 1,
      brake: false,
      drift: true,
      useItem: false,
    }
    expect(intent.tick).toBe(7)
    expect(intent.steer).toBe(-1)
    expect(intent.accel).toBe(1)
    expect(intent.brake).toBe(false)
    expect(intent.drift).toBe(true)
    expect(intent.useItem).toBe(false)
  })

  it('builds a KartState with all 18 fields', () => {
    const position: Vec3 = { x: 0, y: 0, z: 0 }
    const velocity: Vec3 = { x: 0, y: 0, z: 0 }
    const drift: DriftState = { active: false, dir: 0, charge: 0 }
    const lap: LapProgress = { lap: 0, checkpointIdx: 0, t: 0 }
    const kart: KartState = {
      playerId: 0,
      characterIdx: 0,
      isBot: false,
      connected: true,
      position,
      velocity,
      heading: 0,
      angularVelocity: 0,
      drift,
      item: 'none',
      airborne: false,
      surface: 'tarmac',
      spinOutTicks: 0,
      invulnTicks: 0,
      boostTicks: 0,
      respawnTicks: 0,
      shielded: false,
      lap,
    }
    // 18 fields exactly. If this number changes, the WireSnapshot table in the
    // design spec is out of date, because that table is a complete projection
    // of the kart struct.
    expect(Object.keys(kart).length).toBe(18)
    expect(kart.item).toBe('none')
    expect(kart.surface).toBe('tarmac')
    expect(kart.drift.dir).toBe(0)
  })

  it('uses -1 as the dead-slot and not-applicable sentinel', () => {
    const dead: EntityState = {
      entityId: -1,
      kind: 'seeker',
      ownerId: -1,
      position: { x: 0, y: 0, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
      heading: 0,
      targetId: -1,
      ttl: 0,
    }
    expect(dead.entityId).toBe(-1)

    const ev: AuthEvent = {
      eventSeq: 0,
      tick: 0,
      kind: 'spinOut',
      playerId: 3,
      entityId: -1,
      item: 'none',
      data: 0,
    }
    expect(ev.entityId).toBe(-1)
    expect(ev.item).toBe('none')
    expect(ev.data).toBe(0)
  })

  it('uses -1 as SimState.finishTick before anyone finishes', () => {
    const partial: Pick<SimState, 'tick' | 'phase' | 'finishTick' | 'rngCursor'> = {
      tick: 0,
      phase: 'countdown',
      finishTick: -1,
      rngCursor: 0,
    }
    expect(partial.finishTick).toBe(-1)
    expect(partial.phase).toBe('countdown')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/sim/test/types.test.ts`

Expected: FAIL with
`Error: Cannot find module '../src/types' imported from '.../packages/sim/test/types.test.ts'`
and `Caused by: Error: Failed to load url ../src/types ... Does the file exist?`

- [ ] **Step 3: Write types.ts, transcribed verbatim from the contract**

Create `packages/sim/src/types.ts`. Copy this exactly — the comments and blank
lines are part of the contract text:

```typescript
export type Vec3 = { x: number; y: number; z: number }

export const TICK_HZ = 60
export const TICK_DT = 1 / 60
export const MAX_KARTS = 8
export const MAX_ENTITIES = 32
export const RACE_LAPS = 3
export const COUNTDOWN_TICKS = 180

export type Surface = 'tarmac' | 'dirt' | 'boost' | 'offtrack'
export type ItemKind =
  | 'none' | 'boost' | 'seeker' | 'bolt' | 'slick'
  | 'bubble' | 'surge' | 'blink' | 'charge'
export type EntityKind = 'seeker' | 'bolt' | 'slick' | 'bubble' | 'surge' | 'charge'
export type RacePhase = 'countdown' | 'racing' | 'finished'

export interface Intent {
  tick: number
  steer: number      // -1..1
  accel: number      // 0..1
  brake: boolean
  drift: boolean
  useItem: boolean
}

export interface DriftState { active: boolean; dir: -1 | 0 | 1; charge: number }

export interface LapProgress { lap: number; checkpointIdx: number; t: number }

export interface KartState {
  playerId: number
  characterIdx: number
  isBot: boolean
  connected: boolean
  position: Vec3
  velocity: Vec3
  heading: number
  angularVelocity: number
  drift: DriftState
  item: ItemKind
  airborne: boolean
  surface: Surface
  spinOutTicks: number
  invulnTicks: number
  boostTicks: number
  respawnTicks: number
  shielded: boolean
  lap: LapProgress
}

export interface EntityState {
  entityId: number
  kind: EntityKind
  ownerId: number
  position: Vec3
  velocity: Vec3
  heading: number
  targetId: number
  ttl: number
}

export interface ItemBoxState { boxIdx: number; respawnTicks: number }

export interface SimState {
  tick: number
  phase: RacePhase
  raceSeed: number
  rngCursor: number
  nextEventSeq: number
  finishTick: number            // -1 until the first kart finishes
  karts: KartState[]            // always length MAX_KARTS
  entities: EntityState[]       // always length MAX_ENTITIES, live ones packed at the front
  entityCount: number
  nextEntityId: number
  itemBoxes: ItemBoxState[]
  finishedOrder: number[]
}

export type AuthEventKind =
  | 'itemGrant' | 'entitySpawn' | 'entityDespawn'
  | 'hit' | 'spinOut' | 'respawn' | 'lapCross' | 'finish'

export interface AuthEvent {
  eventSeq: number
  tick: number
  kind: AuthEventKind
  playerId: number
  entityId: number     // -1 when not applicable
  item: ItemKind       // 'none' when not applicable
  data: number         // kind-specific scalar, 0 when unused
}

export interface TrackPoint {
  position: Vec3
  width: number
  banking: number
  surface: Surface
}

export interface Track {
  id: string
  name: string
  controlPoints: TrackPoint[]
  checkpointS: number[]
  itemBoxes: { s: number; lateral: number }[]
  ramps: { sStart: number; sEnd: number; launch: number }[]
  boostPads: { s: number; lateral: number; halfWidth: number }[]
  startPositions: { s: number; lateral: number }[]
  bounds: { min: Vec3; max: Vec3 }
}

export interface CharacterStats {
  id: string
  name: string
  speed: number
  accel: number
  handling: number
  weight: number
}

export interface Tuning {
  maxSpeed: number
  accelRate: number
  brakeRate: number
  steerRateBase: number
  steerSpeedFalloff: number
  gripTarmac: number
  gripDirt: number
  gripDrift: number
  gravity: number
  airYaw: number
  offtrackSpeedMul: number
  respawnTicks: number
  invulnTicks: number
  spinOutTicks: number
  driftMinSpeed: number
  driftTiers: [number, number, number]
  driftBoosts: [number, number, number]
  boostSpeedMul: number
  surgeSpeedMul: number
  kartRadius: number
  kartRestitution: number
  itemBoxRespawnTicks: number
  seekerSpeed: number
  boltSpeed: number
  entityTtl: number
}

export interface SimContext {
  track: Track
  query: TrackQuery
  tuning: Tuning
  characters: CharacterStats[]
  isLeader: boolean    // only a leader authority rolls items and advances rngCursor
}

export interface TrackProjection { s: number; lateral: number; distance: number }

export interface TrackQuery {
  sampleAt(s: number): TrackPoint
  tangentAt(s: number): Vec3
  project(p: Vec3): TrackProjection
  groundHeight(s: number, lateral: number): number
  surfaceAt(s: number, lateral: number): Surface
  isInBounds(s: number, lateral: number): boolean
  checkpointIndexAt(s: number): number
  totalLength(): number
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/sim/test/types.test.ts`

Expected: PASS — `Test Files 1 passed (1)`, `Tests 7 passed (7)`.

- [ ] **Step 5: Write the failing test for vec3.ts**

Create `packages/sim/test/vec3.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import { v3, v3add, v3dot, v3len, v3scale } from '../src/vec3'
import { wrapAngle } from '../src/mathutil'

describe('v3', () => {
  it('builds a Vec3 with exactly x, y, z', () => {
    const a = v3(1, 2, 3)
    expect(a.x).toBe(1)
    expect(a.y).toBe(2)
    expect(a.z).toBe(3)
    expect(Object.keys(a)).toEqual(['x', 'y', 'z'])
  })
})

describe('v3add', () => {
  it('writes the sum into out and leaves both inputs untouched', () => {
    const a = v3(1, 2, 3)
    const b = v3(10, 20, 30)
    const out = v3(-999, -999, -999)
    v3add(a, b, out)
    // (1+10, 2+20, 3+30)
    expect(out.x).toBe(11)
    expect(out.y).toBe(22)
    expect(out.z).toBe(33)
    expect(a.x).toBe(1); expect(a.y).toBe(2); expect(a.z).toBe(3)
    expect(b.x).toBe(10); expect(b.y).toBe(20); expect(b.z).toBe(30)
  })

  it('is correct when out aliases a', () => {
    const a = v3(1, 2, 3)
    const b = v3(0.5, -2, 100)
    v3add(a, b, a)
    // (1+0.5, 2-2, 3+100)
    expect(a.x).toBe(1.5)
    expect(a.y).toBe(0)
    expect(a.z).toBe(103)
  })

  it('is correct when out aliases b and a and b are the same object', () => {
    const a = v3(2, 4, 8)
    v3add(a, a, a)
    // (2+2, 4+4, 8+8)
    expect(a.x).toBe(4)
    expect(a.y).toBe(8)
    expect(a.z).toBe(16)
  })

  it('returns undefined (out-param style, never a fresh Vec3)', () => {
    const out = v3(0, 0, 0)
    expect(v3add(v3(1, 1, 1), v3(1, 1, 1), out)).toBeUndefined()
  })
})

describe('v3scale', () => {
  it('scales into out', () => {
    const a = v3(1, -2, 3)
    const out = v3(0, 0, 0)
    v3scale(a, -2, out)
    // (1*-2, -2*-2, 3*-2)
    expect(out.x).toBe(-2)
    expect(out.y).toBe(4)
    expect(out.z).toBe(-6)
    expect(a.x).toBe(1); expect(a.y).toBe(-2); expect(a.z).toBe(3)
  })

  it('is correct when out aliases a', () => {
    const a = v3(3, 6, 9)
    v3scale(a, 1 / 3, a)
    // 3*(1/3), 6*(1/3), 9*(1/3) are all exact in float64
    expect(a.x).toBe(1)
    expect(a.y).toBe(2)
    expect(a.z).toBe(3)
  })
})

describe('v3len', () => {
  it('is exact for pythagorean triples', () => {
    expect(v3len(v3(3, 0, 4))).toBe(5) // sqrt(9 + 0 + 16) = 5
    expect(v3len(v3(1, 2, 2))).toBe(3) // sqrt(1 + 4 + 4) = 3
    expect(v3len(v3(0, 0, 0))).toBe(0)
  })

  it('includes the y axis', () => {
    expect(v3len(v3(0, 5, 0))).toBe(5)
  })
})

describe('v3dot', () => {
  it('is the sum of componentwise products', () => {
    expect(v3dot(v3(1, 2, 3), v3(4, 5, 6))).toBe(32)   // 4 + 10 + 18
    expect(v3dot(v3(-1, 0, 2), v3(3, 7, -4))).toBe(-11) // -3 + 0 - 8
  })

  it('is zero for perpendicular axis vectors', () => {
    expect(v3dot(v3(1, 0, 0), v3(0, 0, 1))).toBe(0)
  })
})

describe('contract conventions', () => {
  it('forward = (cos h, 0, sin h) points along +x at heading 0', () => {
    const h = 0
    const forward = v3(Math.cos(h), 0, Math.sin(h))
    expect(forward.x).toBe(1)
    expect(forward.y).toBe(0)
    expect(forward.z).toBe(0)
  })

  it('forward = (cos h, 0, sin h) points along +z at heading PI/2', () => {
    const h = Math.PI / 2
    const forward = v3(Math.cos(h), 0, Math.sin(h))
    // Math.cos(Math.PI / 2) is 6.123233995736766e-17, not exactly 0.
    expect(forward.x).toBeCloseTo(0, 15)
    // Math.sin(Math.PI / 2) is exactly 1.
    expect(forward.z).toBe(1)
  })

  it('h = atan2(dir.z, dir.x) recovers PI/2 for the +z direction', () => {
    const dir = v3(0, 0, 1)
    expect(Math.atan2(dir.z, dir.x)).toBe(Math.PI / 2)
  })

  it('a kart facing -x has heading exactly PI and wrapAngle keeps it there', () => {
    const dir = v3(-1, 0, 0)
    const h = Math.atan2(dir.z, dir.x)
    expect(h).toBe(Math.PI)
    // This is why the wrap range is (-PI, PI] and not [-PI, PI).
    expect(wrapAngle(h)).toBe(Math.PI)
  })

  it('right = (-t.z, 0, t.x) is +z for a track tangent along +x', () => {
    const t = v3(1, 0, 0)
    const right = v3(-t.z, 0, t.x)
    // -t.z is -0 here, so compare with === (which treats -0 as 0) rather
    // than toBe (which uses Object.is and would reject -0).
    expect(right.x === 0).toBe(true)
    expect(right.y).toBe(0)
    expect(right.z).toBe(1)
    expect(v3len(right)).toBe(1)
  })

  it('right = (-t.z, 0, t.x) is -x for a track tangent along +z', () => {
    const t = v3(0, 0, 1)
    const right = v3(-t.z, 0, t.x)
    expect(right.x).toBe(-1)
    expect(right.y).toBe(0)
    expect(right.z).toBe(0)
    expect(v3len(right)).toBe(1)
  })
})
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run packages/sim/test/vec3.test.ts`

Expected: FAIL with
`Error: Cannot find module '../src/vec3' imported from '.../packages/sim/test/vec3.test.ts'`

- [ ] **Step 7: Write vec3.ts**

Create `packages/sim/src/vec3.ts`:

```typescript
import type { Vec3 } from './types'

/**
 * Allocates a Vec3. Setup only — never call this inside step().
 */
export function v3(x: number, y: number, z: number): Vec3 {
  return { x, y, z }
}

/**
 * out = a + b. Safe when out aliases a or b, because all three components are
 * computed before any is written.
 */
export function v3add(a: Vec3, b: Vec3, out: Vec3): void {
  const x = a.x + b.x
  const y = a.y + b.y
  const z = a.z + b.z
  out.x = x
  out.y = y
  out.z = z
}

/**
 * out = a * s. Safe when out aliases a.
 */
export function v3scale(a: Vec3, s: number, out: Vec3): void {
  const x = a.x * s
  const y = a.y * s
  const z = a.z * s
  out.x = x
  out.y = y
  out.z = z
}

export function v3len(a: Vec3): number {
  return Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z)
}

export function v3dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z
}
```

The temporaries in `v3add` and `v3scale` are what make aliasing safe. Writing
`out.x = a.x + b.x` first would corrupt the y and z reads when `out === a`.

- [ ] **Step 8: Write the failing test for mathutil.ts**

Create `packages/sim/test/mathutil.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import { clamp, lerp, wrapAngle } from '../src/mathutil'

describe('clamp', () => {
  it('clamps above hi', () => {
    expect(clamp(5, 0, 1)).toBe(1)
    expect(clamp(1.0001, -1, 1)).toBe(1)
  })

  it('clamps below lo', () => {
    expect(clamp(-3, -1, 1)).toBe(-1)
    expect(clamp(-0.0001, 0, 1)).toBe(0)
  })

  it('passes interior values through unchanged', () => {
    expect(clamp(0.25, 0, 1)).toBe(0.25)
    expect(clamp(0, -1, 1)).toBe(0)
  })

  it('returns the bound itself at the bound', () => {
    expect(clamp(1, 0, 1)).toBe(1)
    expect(clamp(0, 0, 1)).toBe(0)
  })

  it('propagates NaN rather than silently choosing a bound', () => {
    // NaN < lo and NaN > hi are both false, so NaN falls through.
    expect(Number.isNaN(clamp(NaN, 0, 1))).toBe(true)
  })
})

describe('lerp', () => {
  it('interpolates', () => {
    expect(lerp(0, 10, 0.25)).toBe(2.5)  // 0 + (10-0)*0.25
    expect(lerp(-1, 1, 0.5)).toBe(0)     // -1 + 2*0.5
  })

  it('is exact at both endpoints', () => {
    // a + (b-a)*t: at t=0 this is a exactly, at t=1 it is 2 + 6*1 = 8 exactly.
    expect(lerp(2, 8, 0)).toBe(2)
    expect(lerp(2, 8, 1)).toBe(8)
  })

  it('extrapolates outside 0..1', () => {
    expect(lerp(0, 10, 1.5)).toBe(15)
    expect(lerp(0, 10, -0.5)).toBe(-5)
  })
})

describe('wrapAngle', () => {
  it('leaves angles already inside (-PI, PI] alone', () => {
    expect(wrapAngle(0)).toBe(0)
    expect(wrapAngle(0.5)).toBe(0.5)
    expect(wrapAngle(Math.PI / 2)).toBe(Math.PI / 2)
    expect(wrapAngle(-Math.PI / 2)).toBe(-Math.PI / 2)
  })

  it('is half-open at the top: PI stays PI, -PI becomes PI', () => {
    // This is the whole point of the (-PI, PI] convention. A kart facing -x
    // has heading atan2(0, -1) === Math.PI and must not flip sign every tick.
    expect(wrapAngle(Math.PI)).toBe(Math.PI)
    // -Math.PI + 2*Math.PI is exactly Math.PI in float64.
    expect(wrapAngle(-Math.PI)).toBe(Math.PI)
  })

  it('wraps a heading just past PI to just past -PI', () => {
    // 3*PI/2 = 4.71238898038469; minus 2*PI = -1.5707963267948966 = -PI/2.
    expect(wrapAngle(3 * Math.PI / 2)).toBe(-Math.PI / 2)
    // -3*PI/2 = -4.71238898038469; plus 2*PI = 1.5707963267948966 = PI/2.
    expect(wrapAngle(-3 * Math.PI / 2)).toBe(Math.PI / 2)
  })

  it('wraps multiple turns', () => {
    expect(wrapAngle(2 * Math.PI)).toBe(0)
    // (3*Math.PI) % (2*Math.PI) is exactly Math.PI, which is in range.
    expect(wrapAngle(3 * Math.PI)).toBe(Math.PI)
    expect(wrapAngle(-3 * Math.PI)).toBe(Math.PI)
    // 5 % 2PI = 5, which is > PI, so 5 - 2PI = -1.2831853071795862.
    expect(wrapAngle(5)).toBe(5 - 2 * Math.PI)
    // 7 % 2PI = 0.7168146928204138, already in range.
    expect(wrapAngle(7)).toBe(7 - 2 * Math.PI)
  })

  it('never returns -0, because statesEqual compares with Object.is', () => {
    // (-2*Math.PI) % (2*Math.PI) is -0, and Object.is(-0, 0) is false, so a
    // stray -0 heading would read as a state divergence. The +0 at the end of
    // wrapAngle normalizes it.
    expect(Object.is(wrapAngle(-2 * Math.PI), 0)).toBe(true)
    expect(Object.is(wrapAngle(0), 0)).toBe(true)
    expect(Object.is(wrapAngle(-0), 0)).toBe(true)
  })

  it('lands in (-PI, PI] for 200001 sampled angles', () => {
    let violations = 0
    for (let i = -100000; i <= 100000; i++) {
      const w = wrapAngle(i * 0.137)
      if (!(w > -Math.PI && w <= Math.PI)) violations++
    }
    expect(violations).toBe(0)
  })

  it('is idempotent', () => {
    for (const a of [0, 5, 7, 100, -100, 1000, Math.PI, -Math.PI]) {
      expect(wrapAngle(wrapAngle(a))).toBe(wrapAngle(a))
    }
  })
})
```

- [ ] **Step 9: Run both tests to verify they fail**

Run: `npx vitest run packages/sim/test/mathutil.test.ts packages/sim/test/vec3.test.ts`

Expected: FAIL — two failed suites, with
`Error: Cannot find module '../src/mathutil' imported from '.../packages/sim/test/mathutil.test.ts'`
and the same for `../src/vec3`.

- [ ] **Step 10: Write mathutil.ts**

Create `packages/sim/src/mathutil.ts`:

```typescript
const TWO_PI = Math.PI * 2

export function clamp(v: number, lo: number, hi: number): number {
  if (v < lo) return lo
  if (v > hi) return hi
  return v
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

/**
 * Wraps an angle into the half-open range (-PI, PI].
 *
 * Upper-inclusive on purpose: a kart travelling along -x has heading
 * Math.atan2(0, -1) === Math.PI exactly, and it must stay at +PI rather than
 * oscillating between +PI and -PI on successive ticks.
 *
 * `a % TWO_PI` already lands in (-2*PI, 2*PI), so one adjustment is enough.
 * The trailing `+ 0` turns -0 into +0; without it wrapAngle(-2*PI) would be -0,
 * and statesEqual compares every scalar with Object.is, for which
 * Object.is(-0, 0) is false.
 */
export function wrapAngle(a: number): number {
  let r = a % TWO_PI
  if (r <= -Math.PI) r += TWO_PI
  else if (r > Math.PI) r -= TWO_PI
  return r + 0
}
```

- [ ] **Step 11: Run both tests to verify they pass**

Run: `npx vitest run packages/sim/test/mathutil.test.ts packages/sim/test/vec3.test.ts`

Expected: PASS — `Test Files 2 passed (2)`, `Tests 32 passed (32)` (15 in
mathutil, 17 in vec3).

- [ ] **Step 12: Write the failing test for rng.ts**

Create `packages/sim/test/rng.test.ts`. Every golden number below was produced by
running the reference splitmix32 in Node 20; the uint32 form is given so the
expectation is exact rather than a rounded decimal.

```typescript
import { describe, expect, it } from 'vitest'
import { RNG_GOLDEN, RNG_MIX1, RNG_MIX2, rngAt } from '../src/rng'

const TWO32 = 4294967296

describe('splitmix32 constants', () => {
  it('freezes the three magic numbers', () => {
    expect(RNG_GOLDEN).toBe(0x9e3779b9)
    expect(RNG_GOLDEN).toBe(2654435769)
    expect(RNG_MIX1).toBe(0x21f0aaad)
    expect(RNG_MIX1).toBe(569420461)
    expect(RNG_MIX2).toBe(0x735a2d97)
    expect(RNG_MIX2).toBe(1935289751)
  })
})

describe('rngAt golden values', () => {
  it('matches the recorded uint32 outputs divided by 2^32', () => {
    expect(rngAt(0, 0)).toBe(1684164658 / TWO32)
    expect(rngAt(0, 1)).toBe(3653269916 / TWO32)
    expect(rngAt(0, 2)).toBe(2939563536 / TWO32)
    expect(rngAt(0, 3)).toBe(2141751570 / TWO32)
    expect(rngAt(1, 0)).toBe(1580013426 / TWO32)
    expect(rngAt(12345, 0)).toBe(3283241497 / TWO32)
    expect(rngAt(12345, 1)).toBe(613117429 / TWO32)
    expect(rngAt(12345, 7)).toBe(3763538745 / TWO32)
    expect(rngAt(0xdeadbeef, 0)).toBe(46217145 / TWO32)
  })

  it('matches the recorded decimals to 15 places', () => {
    // 1684164658 / 4294967296 = 0.3921251413412392
    expect(rngAt(0, 0)).toBeCloseTo(0.3921251413412392, 15)
    // 3283241497 / 4294967296 = 0.7644392310176045
    expect(rngAt(12345, 0)).toBeCloseTo(0.7644392310176045, 15)
    // 3763538745 / 4294967296 = 0.8762671484146267
    expect(rngAt(12345, 7)).toBeCloseTo(0.8762671484146267, 15)
  })

  it('reproduces the classic stateful splitmix32 sequence', () => {
    // rngAt(seed, cursor) must equal the cursor-th output of a stateful
    // splitmix32 seeded with `seed`, which is why the implementation mixes
    // (seed + (cursor + 1) * GOLDEN) rather than (seed + cursor * GOLDEN).
    const seed = 12345
    let a = seed | 0
    const next = (): number => {
      a = (a + 0x9e3779b9) | 0
      let t = a ^ (a >>> 16)
      t = Math.imul(t, 0x21f0aaad)
      t = t ^ (t >>> 15)
      t = Math.imul(t, 0x735a2d97)
      t = t ^ (t >>> 15)
      return (t >>> 0) / TWO32
    }
    for (let cursor = 0; cursor < 8; cursor++) {
      expect(rngAt(seed, cursor)).toBe(next())
    }
  })
})

describe('rngAt purity', () => {
  it('holds no internal state: repeated calls return the same value', () => {
    const first = rngAt(777, 3)
    rngAt(999, 0)
    rngAt(777, 4)
    rngAt(0, 0)
    expect(rngAt(777, 3)).toBe(first)
    expect(rngAt(777, 3)).toBe(first)
  })

  it('is order independent: descending cursors match ascending cursors', () => {
    const ascending: number[] = []
    for (let c = 0; c < 32; c++) ascending.push(rngAt(4242, c))
    const descending: number[] = new Array<number>(32)
    for (let c = 31; c >= 0; c--) descending[c] = rngAt(4242, c)
    expect(descending).toEqual(ascending)
  })

  it('separates seeds', () => {
    expect(rngAt(1, 0)).not.toBe(rngAt(2, 0))
    expect(rngAt(1, 0)).not.toBe(rngAt(1, 1))
  })
})

describe('rngAt distribution', () => {
  it('stays inside [0, 1) over 100000 draws', () => {
    let min = 1
    let max = 0
    for (let c = 0; c < 100000; c++) {
      const v = rngAt(1337, c)
      if (v < min) min = v
      if (v > max) max = v
    }
    expect(min).toBeGreaterThanOrEqual(0)
    expect(max).toBeLessThan(1)
    // Observed over seed 1337: min 0.0000132790, max 0.9999998878.
    expect(min).toBeLessThan(0.0001)
    expect(max).toBeGreaterThan(0.9999)
  })

  it('has a mean near 0.5 and fills all ten deciles', () => {
    const buckets = new Array<number>(10).fill(0)
    let sum = 0
    for (let c = 0; c < 100000; c++) {
      const v = rngAt(1337, c)
      sum += v
      buckets[Math.floor(v * 10)]++
    }
    // Observed mean over seed 1337, 100000 draws: 0.4981690483844257.
    expect(sum / 100000).toBeGreaterThan(0.49)
    expect(sum / 100000).toBeLessThan(0.51)
    // Observed decile counts: 9988 10229 9863 10044 10046 10091 10113 9984
    // 9913 9729 — all inside 9500..10500, expected 10000.
    for (const b of buckets) {
      expect(b).toBeGreaterThan(9500)
      expect(b).toBeLessThan(10500)
    }
  })
})
```

- [ ] **Step 13: Run test to verify it fails**

Run: `npx vitest run packages/sim/test/rng.test.ts`

Expected: FAIL with
`Error: Cannot find module '../src/rng' imported from '.../packages/sim/test/rng.test.ts'`

- [ ] **Step 14: Write rng.ts**

Create `packages/sim/src/rng.ts`:

```typescript
/** splitmix32 increment: floor(2^32 / phi). */
export const RNG_GOLDEN = 0x9e3779b9

/** First avalanche multiplier. */
export const RNG_MIX1 = 0x21f0aaad

/** Second avalanche multiplier. */
export const RNG_MIX2 = 0x735a2d97

/**
 * splitmix32 as a pure function of (seed, cursor), returning a double in
 * [0, 1).
 *
 * There is no internal state here on purpose. SimState.rngCursor is the only
 * cursor in the system and only a leader authority advances it, so a shadow
 * authority, a rewind, or a replay can recompute any draw in the race from
 * (raceSeed, rngCursor) alone.
 *
 * Mixing (seed + (cursor + 1) * RNG_GOLDEN) rather than
 * (seed + cursor * RNG_GOLDEN) makes rngAt(seed, c) equal the c-th output of a
 * conventional stateful splitmix32 seeded with `seed`, which advances before it
 * mixes. Math.imul keeps every multiply in int32, and the final `>>> 0` makes
 * the division by 2^32 land in [0, 1).
 */
export function rngAt(seed: number, cursor: number): number {
  let z = (seed + Math.imul(cursor + 1, RNG_GOLDEN)) | 0
  z = Math.imul(z ^ (z >>> 16), RNG_MIX1)
  z = Math.imul(z ^ (z >>> 15), RNG_MIX2)
  z = z ^ (z >>> 15)
  return (z >>> 0) / 4294967296
}
```

- [ ] **Step 15: Run test to verify it passes**

Run: `npx vitest run packages/sim/test/rng.test.ts`

Expected: PASS — `Test Files 1 passed (1)`, `Tests 9 passed (9)`.

- [ ] **Step 16: Fill in the package barrel**

Modify `packages/sim/src/index.ts`. It currently contains exactly this:

```typescript
// Public barrel for @tapkart/sim. Task 2 replaces this line with re-exports of
// types, vec3, mathutil and rng. The bare `export {}` keeps the file a module
// under isolatedModules while it is still empty.
export {}
```

Replace the whole file with:

```typescript
export * from './types'
export * from './vec3'
export * from './mathutil'
export * from './rng'
```

`export *` re-exports types and values together and is legal under
`isolatedModules`; only a named `export { SomeType }` would need `export type`.
The scaffold test from Task 1 asserts only `typeof sim === 'object'`, so it keeps
passing.

- [ ] **Step 17: Run the whole suite and the typecheck**

Run:

```bash
npm test
npm run typecheck
```

Expected: `npm test` reports `Test Files  5 passed (5)` and
`Tests  50 passed (50)` — 2 scaffold, 7 types, 17 vec3, 15 mathutil, 9 rng.
`npm run typecheck` exits 0 with no diagnostics.

- [ ] **Step 18: Verify the barrel still resolves after the edit**

Run: `npx vitest run packages/sim/test/scaffold.test.ts`

Expected: PASS — `Tests 2 passed (2)`. That file does
`import * as sim from '../src/index'`, so it now loads all four new modules
through the barrel. If any of the four had a syntax or resolution error, this
test would fail to collect with
`Error: Cannot find module ... imported from '.../packages/sim/src/index.ts'`.

- [ ] **Step 19: Commit**

```bash
git add packages/sim/src/types.ts packages/sim/src/vec3.ts \
        packages/sim/src/mathutil.ts packages/sim/src/rng.ts \
        packages/sim/src/index.ts \
        packages/sim/test/types.test.ts packages/sim/test/vec3.test.ts \
        packages/sim/test/mathutil.test.ts packages/sim/test/rng.test.ts
git commit -m "feat(sim): types, vec3, mathutil and stateless splitmix32 rng

types.ts is the locked contract transcribed verbatim; no later task edits it.
vec3 is out-param style and aliasing-safe, so only v3() allocates. wrapAngle
returns (-PI, PI] — upper-inclusive so a kart facing -x holds heading PI — and
normalizes -0 to +0 because statesEqual compares scalars with Object.is.
rngAt(seed, cursor) is splitmix32 with no internal state, so any draw is
recomputable from (raceSeed, rngCursor); golden tests freeze the three
constants and nine recorded outputs."
```
