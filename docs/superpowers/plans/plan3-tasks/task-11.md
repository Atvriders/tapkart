### Task 11: `packages/render/src/frame.ts` — frame vocabulary, constants, and the two sim-mirroring helpers

`src/frame.ts` is the largest module in the plan, so it is authored in two tasks.
**This task** creates the file with the three frame structs, `createRenderFrame`,
all eleven exported constants, `bubblePosition` and `surgeAffects` — everything
whose correctness is decided by agreement with `@tapkart/sim` rather than by
the derived-field table. **Task 11b** adds `buildRenderFrame`, the derived-field
table itself, into the same file. The split is at a real seam: this task's tests
run a real `SimState` and assert `render` agrees with `sim`; Task 11b's tests
hand-build a `RaceView` and assert exact per-field values.

Contract §4.7. Rulings Q27, Q28, Q29.

**Files:**
- Create: `packages/render/src/frame.ts`
- Test: `packages/render/test/frame-core.test.ts`

**Interfaces:**

- Consumes, from `@tapkart/sim` (contract §2.1, §2.2 — quoted verbatim):
  ```ts
  export type Vec3 = { x: number; y: number; z: number }
  export type EntityKind = 'seeker' | 'bolt' | 'slick' | 'bubble' | 'surge' | 'charge'
  export const MAX_KARTS = 8
  export const MAX_ENTITIES = 32
  export function v3(x: number, y: number, z: number): Vec3
  // used by this task's tests only:
  export function createState(ctx: SimContext, seed: number, characterIdx: number[]): SimState
  export function spawnEntity(state: SimState, kind: EntityKind, ownerId: number,
                              position: Vec3, heading: number, targetId: number,
                              ttl: number, events: AuthEvent[]): number
  export function updateEntities(ctx: SimContext, state: SimState, events: AuthEvent[]): void
  export function surgeActiveOn(state: SimState, playerId: number): boolean
  export function computePlacement(state: SimState, outIndexOf: Int32Array,
                                   outOrder: Int32Array): void   // both length MAX_KARTS
  ```
- Consumes, from `@tapkart/content` (contract §3a.3):
  ```ts
  export type PaletteRGB = readonly [number, number, number]   // linear, 0..1
  ```
- Consumes, from `packages/render/src/camera.ts` (contract §4.6, an earlier task):
  ```ts
  export type CameraMode = 'chase' | 'countdown' | 'results' | 'free'
  export interface CameraState {
    position: Vec3; lookAt: Vec3; up: Vec3; fovDegrees: number; mode: CameraMode
  }
  export function createCameraState(): CameraState
  ```
- Consumes, from `packages/render/src/types.ts` (contract §4.2, an earlier task):
  ```ts
  export type ViewSource = 'authoritative' | 'predicted' | 'interpolated' | 'absent'
  export interface KartView { playerId: number; characterIdx: number; source: ViewSource
    position: Vec3; heading: number; velocity: Vec3; angularVelocity: number; speed: number
    s: number; bankAngle: number; driftActive: boolean; driftDir: -1 | 0 | 1
    driftCharge: number; driftTier: number; airborne: boolean; surface: Surface
    spinOutTicks: number; invulnTicks: number; boostTicks: number; respawnTicks: number
    shielded: boolean; item: ItemKind; lap: number; checkpointIdx: number; t: number
    place: number; isBot: boolean; connected: boolean }
  export interface EntityView { entityId: number; kind: EntityKind; ownerId: number
    source: ViewSource; position: Vec3; velocity: Vec3; heading: number; ttl: number }
  export interface ItemBoxView { boxIdx: number; position: Vec3; respawnTicks: number }
  export interface RaceView { tick: number; alpha: number; phase: RacePhase
    localPlayerId: number; raceStartTick: number; karts: KartView[]; entities: EntityView[]
    entityCount: number; itemBoxes: ItemBoxView[]; itemBoxRespawnTicks: number
    finishedOrder: number[]; finishTick: number; countdownTicksLeft: number }
  export function createRaceView(itemBoxCount: number): RaceView
  ```
- Consumes, from `packages/render/test/fixtures/render-fixtures.ts` (contract §9.1, an earlier task):
  ```ts
  export function makeRenderContext(): SimContext
  ```
- Produces — every symbol below is imported by Task 11b, by `src/index.ts` and by
  the Three.js adapter:
  ```ts
  export interface KartDraw { playerId: number; characterIdx: number; visible: boolean
    position: Vec3; heading: number; roll: number; wheelSpin: number; steerAngle: number
    bodyTint: PaletteRGB; alpha: number; driftSparkTier: number; boostFlame: number
    shieldVisible: boolean }
  export interface EntityDraw { entityId: number; kind: EntityKind; visible: boolean
    position: Vec3; heading: number; scale: number; tint: PaletteRGB; alpha: number }
  export interface RenderFrame { camera: CameraState; karts: KartDraw[]
    entities: EntityDraw[]; entityCount: number; itemBoxAlpha: Float32Array
    screenFlash: number; screenTintColor: PaletteRGB; screenTintAmount: number
    sourceTick: number }
  export function createRenderFrame(itemBoxCount: number): RenderFrame
  export function bubblePosition(ownerPosition: Vec3, heading: number, out: Vec3): void
  export function surgeAffects(view: RaceView, playerId: number): boolean
  export const BUBBLE_ORBIT_RADIUS_M = 2.0
  export const KART_DRIFT_LEAN_RADIANS = 0.22
  export const KART_SPINOUT_ROLL_RADIANS = 0.15
  export const KART_STEER_VISUAL_MAX_RADIANS = 0.5
  export const KART_STEER_VISUAL_YAW_RATE = 2.6
  export const INVULN_FLICKER_PERIOD_TICKS = 8
  export const INVULN_FLICKER_ALPHA = 0.35
  export const SURGE_TINT: PaletteRGB
  export const SURGE_TINT_AMOUNT = 0.28
  export const CHARGE_FLASH_RADIUS_M = 20
  export const ENTITY_SCALE: Readonly<Record<EntityKind, number>>
  ```

**Three things a reader must not get wrong**

1. **`render` adds no cosmetic orbit to the bubble (Q28).** `sim` already orbits
   it: `packages/sim/src/entity.ts:196-208` advances `e.heading` by
   `BUBBLE_ORBIT_RATE * TICK_DT` each tick and rewrites `e.position` to
   `owner.position + BUBBLE_ORBIT_RADIUS` at that heading, with
   `e.position.y = owner.position.y`. `bubblePosition` is **that same formula**,
   exported so the frame builder and its test call one function. It exists
   because at the 20 Hz snapshot rate consecutive sampled bubble positions are
   ~0.3 rad apart on the circle, and lerping those positions *chords across the
   orbit* — the bubble collapses toward its owner and springs back, 20 times a
   second. Task 11b applies it; this task proves it reproduces `sim` exactly.
2. **`BUBBLE_ORBIT_RADIUS_M` is a copy of a module-private `sim` constant**
   (`entity.ts:12`, `const BUBBLE_ORBIT_RADIUS = 2.0`), declared here because
   `render` may not widen `sim`'s exports. The re-derivation test below is
   **required** by contract §8.1 and is the only thing keeping the copy honest.
   Do not change one without the other.
3. **The double-buffered `RaceView`.** The session allocates **two** `RaceView`s
   and alternates them per frame (the audio model needs a previous view — see
   Task 13); the swap is owned by the session/shell tasks. Nothing in this file
   is affected: `surgeAffects` and `bubblePosition` read only the arguments they
   are handed, and `createRenderFrame` allocates one `RenderFrame` for the whole
   session regardless of how many views exist.

**Two contract gaps this task closes, and how** — flagged rather than buried,
because contract §4.7's constant list is otherwise exhaustive:

- **`ENTITY_SCALE`'s numbers are not in the contract.** They are set to `sim`'s
  own strike radii for the four kinds that strike (`hitRadiusFor`,
  `packages/sim/src/entity.ts:125-138`: seeker 1.6, bolt 1.4, slick 1.2, charge
  6.0), so the drawn object is the collision volume — the same principle that
  makes `itemBoxWorldPos` the sole owner of a box's position. `bubble` is 0.6: it
  has no strike radius (its collision role is the `shielded` flag), and it orbits
  at 2 m, so it must be small enough to read as an orbiting orb rather than a
  sphere swallowing the kart. `surge` is 0 because it is never drawn (Q27).
- **`createRenderFrame`'s "every field zeroed" is taken literally except twice.**
  `driftSparkTier` starts at `-1` and `EntityDraw.entityId` starts at `-1`,
  because in both encodings `0` is a *real* value: contract §0 pins `-1` as
  sim's "no mini-turbo pending" and §4.2 pins `-1` as the unused-entity-slot
  sentinel. Writing `0` into a field whose `0` means "tier 0 pending" is the
  two-encodings-of-one-fact defect this contract exists to prevent.

---

- [ ] **Step 1: Write the failing test**

Create `packages/render/test/frame-core.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { AuthEvent, EntityKind } from '@tapkart/sim'
import {
  MAX_ENTITIES,
  MAX_KARTS,
  computePlacement,
  createState,
  spawnEntity,
  surgeActiveOn,
  updateEntities,
  v3,
} from '@tapkart/sim'
import { createRaceView } from '../src/types'
import {
  BUBBLE_ORBIT_RADIUS_M,
  ENTITY_SCALE,
  bubblePosition,
  createRenderFrame,
  surgeAffects,
} from '../src/frame'
import { makeRenderContext } from './fixtures/render-fixtures'

const ALL_KINDS: readonly EntityKind[] = [
  'seeker',
  'bolt',
  'slick',
  'bubble',
  'surge',
  'charge',
]

/**
 * A real SimState carrying one live bubble owned by seat 0, stepped `ticks`
 * times through sim's own updateEntities.
 *
 * `shielded` must be true: updateEntities' bubble-consistency pass
 * (entity.ts:277-284) despawns a bubble whose owner is not shielded, and a
 * despawned bubble would make every assertion below vacuous — which is why the
 * tests assert entityCount === 1 on every tick.
 */
function bubbleState(ticks: number): {
  ownerX: number
  ownerY: number
  ownerZ: number
  heading: number
  x: number
  y: number
  z: number
  count: number
} {
  const ctx = makeRenderContext()
  const state = createState(ctx, 0x5eed, Array.from({ length: MAX_KARTS }, () => 0))
  const events: AuthEvent[] = []
  state.karts[0].shielded = true
  // Spawned AT the owner: a bubble that never moves therefore sits at radius 0
  // and fails the radius assertion immediately.
  spawnEntity(state, 'bubble', 0, state.karts[0].position, 0, -1, 600, events)
  for (let n = 0; n < ticks; n++) updateEntities(ctx, state, events)
  const e = state.entities[0]
  const owner = state.karts[0]
  return {
    ownerX: owner.position.x,
    ownerY: owner.position.y,
    ownerZ: owner.position.z,
    heading: e.heading,
    x: e.position.x,
    y: e.position.y,
    z: e.position.z,
    count: state.entityCount,
  }
}

describe('createRenderFrame', () => {
  it('allocates fixed-length arrays, itemBoxAlpha of 1, sourceTick 0', () => {
    const f = createRenderFrame(3)
    expect(f.karts).toHaveLength(MAX_KARTS)
    expect(f.entities).toHaveLength(MAX_ENTITIES)
    expect(f.itemBoxAlpha).toBeInstanceOf(Float32Array)
    expect(f.itemBoxAlpha).toHaveLength(3)
    expect(Array.from(f.itemBoxAlpha)).toEqual([1, 1, 1])
    expect(f.sourceTick).toBe(0)
    expect(f.entityCount).toBe(0)
    expect(f.screenFlash).toBe(0)
    expect(f.screenTintAmount).toBe(0)
    expect(f.screenTintColor).toHaveLength(3)
  })

  // Catches the aliasing bug: filling the pool with one shared object literal
  // (`const p = v3(0,0,0); for (...) karts.push({ position: p, ... })`). Every
  // kart then renders at the same place, and no length or count assertion sees
  // it. Object identity is asserted, not values, so this does not depend on any
  // default createCameraState chooses.
  it('gives every Vec3 in the frame a distinct object', () => {
    const f = createRenderFrame(2)
    expect(f.karts[0].position).not.toBe(f.karts[1].position)
    expect(f.entities[0].position).not.toBe(f.entities[1].position)
    expect(f.karts[0].position).not.toBe(f.entities[0].position)
    expect(f.camera.position).not.toBe(f.camera.lookAt)
    expect(f.camera.position).not.toBe(f.karts[0].position)
    f.karts[0].position.x = 7
    f.entities[0].position.z = 9
    expect(f.karts[1].position.x).toBe(0)
    expect(f.entities[1].position.z).toBe(0)
  })

  // Catches a second RenderFrame sharing the first's buffers, which would make
  // two sessions in one process draw each other's karts.
  it('returns independent frames on every call', () => {
    const a = createRenderFrame(1)
    const b = createRenderFrame(1)
    expect(a.karts[0]).not.toBe(b.karts[0])
    expect(a.itemBoxAlpha).not.toBe(b.itemBoxAlpha)
    a.itemBoxAlpha[0] = 0.25
    expect(b.itemBoxAlpha[0]).toBe(1)
  })

  // The two deliberate departures from "every field zeroed": 0 is a real value
  // in both encodings, so a fresh frame that reports tier 0 and entity id 0 is
  // reporting live content it does not have.
  it('starts driftSparkTier and entityId at the -1 sentinels', () => {
    const f = createRenderFrame(1)
    expect(f.karts[0].driftSparkTier).toBe(-1)
    expect(f.entities[0].entityId).toBe(-1)
    expect(f.karts[0].visible).toBe(false)
    expect(f.entities[0].visible).toBe(false)
  })
})

describe('BUBBLE_ORBIT_RADIUS_M', () => {
  // REQUIRED by contract §8.1. BUBBLE_ORBIT_RADIUS is module-private in
  // packages/sim/src/entity.ts:12, so this copy is the one number in `render`
  // that can silently disagree with the simulation. It catches exactly that:
  // change sim's 2.0 to 2.5 and this fails, while every hand-built-view test in
  // Task 11b still passes.
  it('equals the orbit radius sim actually produces', () => {
    for (const ticks of [1, 5, 17, 60]) {
      const b = bubbleState(ticks)
      expect(b.count).toBe(1)
      const r = Math.hypot(b.x - b.ownerX, b.z - b.ownerZ)
      expect(r).toBeCloseTo(BUBBLE_ORBIT_RADIUS_M, 9)
    }
  })
})

describe('bubblePosition', () => {
  // The radius test above cannot catch a sin/cos swap or a dropped y — both
  // preserve the radius exactly. This one does: it compares all three
  // components against sim's own output over a full orbit's worth of ticks.
  it('reproduces sim’s bubble position exactly, tick by tick', () => {
    const out = v3(0, 0, 0)
    for (let ticks = 1; ticks <= 12; ticks++) {
      const b = bubbleState(ticks)
      expect(b.count).toBe(1)
      bubblePosition({ x: b.ownerX, y: b.ownerY, z: b.ownerZ }, b.heading, out)
      expect(out.x).toBeCloseTo(b.x, 9)
      expect(out.y).toBeCloseTo(b.y, 9)
      expect(out.z).toBeCloseTo(b.z, 9)
    }
  })

  // Non-vacuity guard for the test above: if sim ever stopped orbiting the
  // bubble, every component comparison would still pass while the bubble stood
  // still, and Q28's whole justification would be gone.
  it('is comparing against a bubble that actually moves', () => {
    const a = bubbleState(1)
    const b = bubbleState(12)
    expect(Math.hypot(b.x - a.x, b.z - a.z)).toBeGreaterThan(0.1)
  })

  it('writes all three components of out on every call', () => {
    const owner = v3(10, 2, -4)
    const out = v3(0, 0, 0)
    bubblePosition(owner, 0, out)
    expect(out.x).toBeCloseTo(10 + BUBBLE_ORBIT_RADIUS_M, 12)
    expect(out.y).toBe(2)
    expect(out.z).toBeCloseTo(-4, 12)
    bubblePosition(owner, Math.PI / 2, out)
    expect(out.x).toBeCloseTo(10, 12)
    expect(out.z).toBeCloseTo(-4 + BUBBLE_ORBIT_RADIUS_M, 12)
  })
})

describe('surgeAffects', () => {
  /** A view whose places come from the real comparator, plus a surge cast by
   *  `casterSeat`. Seat i is given lap MAX_KARTS-1-i, so place === seat. */
  function surgeView(casterSeat: number, entityCount: number) {
    const ctx = makeRenderContext()
    const state = createState(ctx, 7, Array.from({ length: MAX_KARTS }, () => 0))
    for (let i = 0; i < MAX_KARTS; i++) state.karts[i].lap.lap = MAX_KARTS - 1 - i
    const events: AuthEvent[] = []
    spawnEntity(state, 'surge', casterSeat, state.karts[casterSeat].position, 0, -1, 300, events)
    const indexOf = new Int32Array(MAX_KARTS)
    const order = new Int32Array(MAX_KARTS)
    computePlacement(state, indexOf, order)

    const view = createRaceView(ctx.track.itemBoxes.length)
    view.tick = state.tick
    view.entityCount = entityCount
    for (let i = 0; i < MAX_KARTS; i++) {
      const k = view.karts[i]
      k.playerId = i
      k.place = indexOf[i]
      k.source = 'authoritative'
    }
    const e = view.entities[0]
    e.entityId = state.entities[0].entityId
    e.kind = 'surge'
    e.ownerId = casterSeat
    e.source = 'authoritative'
    e.ttl = 300
    return { view, state }
  }

  // The flagship: agreement with sim's surgeActiveOn for every seat. The two
  // non-vacuity assertions are the point — an implementation that returns false
  // unconditionally agrees with sim on 3 of 8 seats and would pass a
  // seats-agree loop that happened to be built with no one affected.
  it('agrees with surgeActiveOn on every seat', () => {
    const { view, state } = surgeView(5, 1)
    const mine: boolean[] = []
    for (let pid = 0; pid < MAX_KARTS; pid++) {
      const got = surgeAffects(view, pid)
      expect(got).toBe(surgeActiveOn(state, pid))
      mine.push(got)
    }
    expect(mine.filter((v) => v)).not.toHaveLength(0)
    expect(mine.filter((v) => !v)).not.toHaveLength(0)
    expect(surgeAffects(view, 0)).toBe(true) // leader, ahead of the caster
    expect(surgeAffects(view, 5)).toBe(false) // the caster itself
    expect(surgeAffects(view, 6)).toBe(false) // placed behind the caster
    expect(surgeAffects(view, 7)).toBe(false)
  })

  // Catches iterating `view.entities.length` instead of `view.entityCount`: the
  // pool is MAX_ENTITIES long and slot 0 keeps its last contents, so a stale
  // surge would slow the whole field forever with no live entity on screen.
  it('ignores slots at or past entityCount', () => {
    const { view } = surgeView(5, 0)
    expect(view.entities[0].kind).toBe('surge')
    for (let pid = 0; pid < MAX_KARTS; pid++) {
      expect(surgeAffects(view, pid)).toBe(false)
    }
  })

  it('is false for an out-of-range seat', () => {
    const { view } = surgeView(5, 1)
    expect(surgeAffects(view, -1)).toBe(false)
    expect(surgeAffects(view, MAX_KARTS)).toBe(false)
  })

  // Catches "any live entity counts": only 'surge' slows anyone.
  it('is false when the live entity is not a surge', () => {
    const { view } = surgeView(5, 1)
    view.entities[0].kind = 'seeker'
    for (let pid = 0; pid < MAX_KARTS; pid++) {
      expect(surgeAffects(view, pid)).toBe(false)
    }
  })
})

describe('ENTITY_SCALE', () => {
  // A freeze. It catches an accidental edit to a shipped visual constant and a
  // kind added to the table with a garbage value; it cannot judge whether a
  // number looks right on a phone — §8.3 says that is owner-verified.
  it('has a finite, non-negative metre scale for every EntityKind', () => {
    for (const kind of ALL_KINDS) {
      const s = ENTITY_SCALE[kind]
      expect(Number.isFinite(s)).toBe(true)
      expect(s).toBeGreaterThanOrEqual(0)
    }
    expect(Object.keys(ENTITY_SCALE).sort()).toEqual([...ALL_KINDS].sort())
  })

  it('matches sim’s strike radii, and draws surge at nothing (Q27)', () => {
    expect(ENTITY_SCALE.seeker).toBe(1.6)
    expect(ENTITY_SCALE.bolt).toBe(1.4)
    expect(ENTITY_SCALE.slick).toBe(1.2)
    expect(ENTITY_SCALE.charge).toBe(6.0)
    expect(ENTITY_SCALE.bubble).toBe(0.6)
    expect(ENTITY_SCALE.surge).toBe(0)
  })
})
```

There is deliberately **no** `expect(BUBBLE_ORBIT_RADIUS_M).toBe(2.0)` test. It
would restate the source line it is meant to police and pass in every world where
the constant and `sim` disagree — the re-derivation test above is the one that
can fail.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/render/test/frame-core.test.ts`

Expected: FAIL — the module under test does not exist yet:

```
Error: Failed to load url ../src/frame (resolved id: <repo>/packages/render/src/frame) in <repo>/packages/render/test/frame-core.test.ts. Does the file exist?
```

- [ ] **Step 3: Write the implementation**

Create `packages/render/src/frame.ts`:

```ts
// PURE (contract §0a): no DOM, no GPU, no clock, no `three` import, and nothing
// in the frame path allocates. Task 11b adds buildRenderFrame to this file.
import type { EntityKind, Vec3 } from '@tapkart/sim'
import { MAX_ENTITIES, MAX_KARTS, v3 } from '@tapkart/sim'
import type { PaletteRGB } from '@tapkart/content'
import type { CameraState } from './camera'
import { createCameraState } from './camera'
import type { RaceView } from './types'

export interface KartDraw {
  playerId: number
  characterIdx: number
  visible: boolean
  position: Vec3
  heading: number // radians - COPIED from KartView, never modified
  roll: number // radians: bankAngle + drift lean + spin-out tilt
  wheelSpin: number // radians, accumulated per SIM TICK, wrapped
  steerAngle: number // radians, front wheels
  bodyTint: PaletteRGB
  alpha: number // 0..1; invulnerability flickers this
  driftSparkTier: number // sim's encoding, copied from KartView.driftTier
  boostFlame: number // 0..1
  shieldVisible: boolean
}

export interface EntityDraw {
  entityId: number
  kind: EntityKind
  visible: boolean
  position: Vec3
  heading: number
  scale: number // metres; the adapter's unit sphere/box is scaled by this
  tint: PaletteRGB
  alpha: number // 0..1
}

export interface RenderFrame {
  camera: CameraState
  karts: KartDraw[] // length MAX_KARTS
  entities: EntityDraw[] // length MAX_ENTITIES
  entityCount: number
  itemBoxAlpha: Float32Array // length = itemBoxes.length; Q29
  screenFlash: number // 0..1, charge blast
  screenTintColor: PaletteRGB
  screenTintAmount: number // 0..1, surge slow
  /** The view tick this frame's accumulators were last advanced to. The ONLY
   *  field of `out` that buildRenderFrame reads besides KartDraw.wheelSpin. */
  sourceTick: number
}

/**
 * sim's BUBBLE_ORBIT_RADIUS, which is module-private in
 * packages/sim/src/entity.ts:12. It is declared here rather than imported
 * because `render` may not widen sim's exports, and it is protected from drift
 * by a REQUIRED test that re-derives it from real sim behaviour (§8.1). Do not
 * change one without the other.
 */
export const BUBBLE_ORBIT_RADIUS_M = 2.0

/** Roll added while drifting, times driftDir. */
export const KART_DRIFT_LEAN_RADIANS = 0.22
/** Roll added while spinOutTicks > 0. */
export const KART_SPINOUT_ROLL_RADIANS = 0.15
/** Front-wheel deflection at full lock. */
export const KART_STEER_VISUAL_MAX_RADIANS = 0.5
/** rad/s of angularVelocity that reads as full lock. */
export const KART_STEER_VISUAL_YAW_RATE = 2.6
/** 7.5 Hz at 60 Hz. */
export const INVULN_FLICKER_PERIOD_TICKS = 8
export const INVULN_FLICKER_ALPHA = 0.35
export const SURGE_TINT: PaletteRGB = [0.35, 0.15, 0.55]
export const SURGE_TINT_AMOUNT = 0.28
export const CHARGE_FLASH_RADIUS_M = 20

/**
 * Metres, per kind. seeker/bolt/slick/charge are sim's own strike radii
 * (hitRadiusFor, packages/sim/src/entity.ts:125-138), so the drawn object IS
 * the collision volume. A bubble has no strike radius - its collision role is
 * the owner's `shielded` flag - and it orbits at BUBBLE_ORBIT_RADIUS_M, so it
 * is a small orb rather than a sphere that swallows the kart. A surge is never
 * drawn at all (Q27): it has no meaningful location, and drawing a mesh at a
 * meaningless position is worse than drawing nothing, because players will try
 * to dodge it.
 */
export const ENTITY_SCALE: Readonly<Record<EntityKind, number>> = {
  seeker: 1.6,
  bolt: 1.4,
  slick: 1.2,
  bubble: 0.6,
  surge: 0,
  charge: 6.0,
}

/**
 * Every field zeroed, every Vec3 distinct, `sourceTick = 0`, `itemBoxAlpha`
 * filled with 1. Called once per session, never per frame.
 *
 * Two fields start at -1 rather than 0, because 0 is a real value in both
 * encodings: `driftSparkTier` uses sim's tier encoding, where -1 is "no
 * mini-turbo pending" and 0 is a real tier (§0), and `entityId` uses §4.2's
 * unused-slot sentinel.
 */
export function createRenderFrame(itemBoxCount: number): RenderFrame {
  const karts: KartDraw[] = []
  for (let i = 0; i < MAX_KARTS; i++) {
    karts.push({
      playerId: 0,
      characterIdx: 0,
      visible: false,
      position: v3(0, 0, 0),
      heading: 0,
      roll: 0,
      wheelSpin: 0,
      steerAngle: 0,
      bodyTint: [0, 0, 0],
      alpha: 0,
      driftSparkTier: -1,
      boostFlame: 0,
      shieldVisible: false,
    })
  }

  const entities: EntityDraw[] = []
  for (let j = 0; j < MAX_ENTITIES; j++) {
    entities.push({
      entityId: -1,
      kind: 'seeker',
      visible: false,
      position: v3(0, 0, 0),
      heading: 0,
      scale: 0,
      tint: [0, 0, 0],
      alpha: 0,
    })
  }

  const itemBoxAlpha = new Float32Array(Math.max(0, itemBoxCount))
  itemBoxAlpha.fill(1)

  return {
    camera: createCameraState(),
    karts,
    entities,
    entityCount: 0,
    itemBoxAlpha,
    screenFlash: 0,
    screenTintColor: [0, 0, 0],
    screenTintAmount: 0,
    sourceTick: 0,
  }
}

/**
 * Q28's bubble reconstruction, exported so the frame builder and its test call
 * one function. This is sim's formula verbatim (entity.ts:196-208), applied to
 * interpolated inputs: `out = ownerPosition + (cos h, 0, sin h) *
 * BUBBLE_ORBIT_RADIUS_M`, with `out.y = ownerPosition.y`.
 *
 * Safe when `out === ownerPosition`: no component is read after it is written.
 */
export function bubblePosition(ownerPosition: Vec3, heading: number, out: Vec3): void {
  out.x = ownerPosition.x + Math.cos(heading) * BUBBLE_ORBIT_RADIUS_M
  out.y = ownerPosition.y
  out.z = ownerPosition.z + Math.sin(heading) * BUBBLE_ORBIT_RADIUS_M
}

/**
 * True when a live surge field cast by a kart PLACED BEHIND `playerId` is
 * slowing it. Derived from the view alone (entity kind + ownerId +
 * KartView.place) so it works identically on a guest, where `state()` cannot be
 * consulted. Mirrors `surgeActiveOn` in @tapkart/sim - lower place index is
 * further ahead - and a test asserts they agree for every seat.
 */
export function surgeAffects(view: RaceView, playerId: number): boolean {
  if (playerId < 0 || playerId >= MAX_KARTS) return false
  const mine = view.karts[playerId].place
  for (let j = 0; j < view.entityCount; j++) {
    const e = view.entities[j]
    if (e.kind !== 'surge') continue
    if (e.ownerId === playerId) continue
    if (e.ownerId < 0 || e.ownerId >= MAX_KARTS) continue
    if (mine < view.karts[e.ownerId].place) return true
  }
  return false
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/render/test/frame-core.test.ts`
Expected: PASS, 14 tests.

Then typecheck the package, because `noUnusedLocals` / `noUnusedParameters` /
`verbatimModuleSyntax` are not exercised by vitest:

Run: `npm run typecheck --workspace @tapkart/render`
Expected: exit 0, no output.

- [ ] **Step 5: Commit**

```bash
git add packages/render/src/frame.ts packages/render/test/frame-core.test.ts && git commit -m "feat(render): frame structs, constants, bubblePosition and surgeAffects

createRenderFrame allocates one RenderFrame per session with every Vec3
distinct. bubblePosition is sim's own bubble formula (Q28), and
BUBBLE_ORBIT_RADIUS_M is re-derived from a real stepped SimState by a required
test, because the constant is module-private in sim. surgeAffects mirrors
surgeActiveOn from the view alone so a guest resolves it identically."
```
