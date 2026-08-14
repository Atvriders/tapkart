### Task 12: World entity pool, per-kind entity update, and entity/kart collision

**Files:**
- Create: `packages/sim/src/entity.ts`
- Modify: `packages/sim/src/kart.ts` — two edits: add the `surgeActiveOn` import, and replace the body of Task 6's staged `surgeFactorFor` helper (the call site in `targetSpeedFor` is untouched); exact before/after in Step 19
- Modify: `packages/sim/src/step.ts` — one import and one insertion; exact before/after in Step 23
- Test: `packages/sim/test/entity.test.ts`

**Interfaces:**

- Consumes (already exist, do not redefine):
  - `packages/sim/src/types.ts` — `Vec3`, `Surface`, `ItemKind`, `EntityKind` (`'seeker' | 'bolt' | 'slick' | 'bubble' | 'surge' | 'charge'`), `Intent`, `KartState`, `EntityState` (`{ entityId, kind, ownerId, position, velocity, heading, targetId, ttl }`), `SimState`, `AuthEvent`, `AuthEventKind`, `Track`, `TrackQuery`, `TrackPoint`, `TrackProjection`, `Tuning`, `SimContext`, and the constants `TICK_DT = 1/60`, `MAX_KARTS = 8`, `MAX_ENTITIES = 32`.
  - `packages/sim/src/mathutil.ts` — `export function clamp(v: number, lo: number, hi: number): number`, `export function wrapAngle(a: number): number` (result in `(-π, π]`).
  - `packages/sim/src/state.ts` — `export function emit(state: SimState, out: AuthEvent[], kind: AuthEventKind, playerId: number, entityId: number, item: ItemKind, data: number): void`. It appends exactly one `AuthEvent` with `eventSeq = state.nextEventSeq++` and `tick = state.tick`.
  - `packages/sim/src/placement.ts` [Task 11] — `export function computePlacement(state: SimState, outIndexOf: Int32Array, outOrder: Int32Array): void`. Both arrays are length `MAX_KARTS`; `outOrder[place] = playerId` with the leader at place 0, and `outIndexOf[playerId] = place`.
  - `packages/sim/src/recovery.ts` [Task 9] — `export function startSpinOut(state: SimState, k: KartState, ticks: number, events: AuthEvent[]): void`. **The contract's sole writer of `k.spinOutTicks`**: it arms the timer, clears the kart's drift and boost, and emits the one `'spinOut'` `AuthEvent` itself (`playerId` = the kart, `entityId` `-1`, `item` `'none'`, `data` = the ticks armed). It refuses outright while `invulnTicks > 0` or `respawnTicks > 0`, ignores a non-positive duration, and never shortens a spin-out already running. Nothing in this task assigns `spinOutTicks` directly.
  - `packages/sim/src/kart.ts` [Task 6] — `export function targetSpeedFor(ctx: SimContext, state: SimState, k: KartState, accel: number): number`, which composes `maxSpeed * character.speed * accel * surfaceFactor * surgeFactor * boostFactor` and gets its `surgeFactor` from a module-level, non-exported `surgeFactorFor(state, k, t)` that Task 6 also wrote. Task 6's body is real but deliberately **weaker** than the contract: it slows a kart whenever *any* live surge exists that the kart does not own. **This task replaces that body** with the contract's rule — a surge slows only the karts placed ahead of its caster — so the Surge item finally does the right thing. The call site does not change, and there is no `void state` line to remove: `state` has had a real reader since Task 6.
  - `packages/sim/src/step.ts` [Task 5, extended by 6–11] — `export function step(ctx: SimContext, prev: SimState, next: SimState, inputs: Intent[], events: AuthEvent[]): void`. After the per-kart loop it calls `resolveKartCollisions(ctx, next)`; this task inserts `updateEntities(ctx, next, events)` directly after it, which is the contract's canonical once-per-tick order `resolveKartCollisions → updateEntities → updateItemBoxes → updatePhase`.
  - `packages/sim/test/fixtures/track-fixtures.ts` — `export function makeTuning(overrides?: Partial<Tuning>): Tuning` (`kartRadius` 0.9, `spinOutTicks` 60, `surgeSpeedMul` 0.7, `seekerSpeed` 55, `boltSpeed` 65, `entityTtl` 600), `export function makeCharacters(): CharacterStats[]` (character 0 has `speed` 1.00).
  - `ctx.query: TrackQuery` — `project(p: Vec3): TrackProjection`, `sampleAt(s: number): TrackPoint`, `tangentAt(s: number): Vec3`. The contract fixes `TrackProjection.s` and every `s` argument as **arc-normalised `[0, 1)`**, never metres; this file's stub query obeys that, and `entity.ts` only ever feeds an `s` straight back into `sampleAt`/`tangentAt`, so no lap length appears in this task at all.
  - `createState(ctx, seed, characterIdx)` produces `entities` of length `MAX_ENTITIES` with `entityCount = 0` and `nextEntityId = 1`, every slot already in the canonical dead form described under **Pool** below, `karts` of length `MAX_KARTS` where `karts[i].playerId === i`, and `finishedOrder` of length `MAX_KARTS` with `-1` in every slot.

- Produces (later tasks rely on exactly these):
  - `export function spawnEntity(state: SimState, kind: EntityKind, ownerId: number, position: Vec3, heading: number, targetId: number, ttl: number, events: AuthEvent[]): number` — returns the new `entityId`, or `-1` when the pool is full. Copies `position` by value, wraps `heading`, zeroes `velocity`, emits `entitySpawn`.
  - `export function despawnEntityAt(state: SimState, idx: number, events: AuthEvent[]): void` — index into the packed live range, not an entityId. Emits `entityDespawn`, then swap-removes.
  - `export function kartById(state: SimState, playerId: number): KartState | null`
  - `export function updateEntities(ctx: SimContext, state: SimState, events: AuthEvent[]): void` — one call per tick, after the per-kart loop and `resolveKartCollisions`, wired into `step()` by this task.
  - `export function surgeActiveOn(state: SimState, playerId: number): boolean` — consumed by `kart.ts`'s `surgeFactorFor`, which is `targetSpeedFor`'s `tuning.surgeSpeedMul` gate; wired in by Step 19 of this task.

- Rules fixed by this task, relied on by Task 13 (`items.ts`) and Task 15:
  - **Pool.** Live entities are packed at `state.entities[0 .. entityCount-1]`. Despawn swaps the last live entity into the vacated index and clears the vacated slot to the canonical dead form: `entityId -1`, `kind 'seeker'`, `ownerId -1`, `targetId -1`, `heading 0`, `ttl 0`, `position` and `velocity` all zero. `entityId === -1` is the contract's dead sentinel; the rest of the canonical form exists so a slot's contents never depend on which entity last occupied it.
  - **Overflow.** At `entityCount === MAX_ENTITIES` a spawn is dropped: it returns `-1`, emits nothing, and does not advance `nextEntityId`. Existing entities are never evicted.
  - **Velocity is derived, not stored by the caller.** `spawnEntity` zeroes it; `updateEntities` rewrites it from `heading` and tuning every tick. Callers pass `heading`, not a velocity.
  - **Entities are planar.** `position.y` is whatever the spawner passed and is never integrated, except for a bubble, which copies its owner's `y`.
  - **Hit radii** live here, not in `Tuning`: seeker 1.6, bolt 1.4, slick 1.2, charge 6.0, bubble 0, surge 0. The test is `distance < radius + tuning.kartRadius`.
  - **Bubble and shield are one thing.** `k.shielded` is the truth; the bubble entity is its view. `updateEntities` despawns any live bubble whose owner is not `shielded`, so **Task 13's `useItem` must set `k.shielded = true` in the same tick it spawns the bubble**.
  - **A hit goes through `startSpinOut`.** The contract makes `startSpinOut` [Task 9] the sole writer of `k.spinOutTicks` and the sole emitter of `'spinOut'`; `updateEntities` calls it and writes neither field itself. Task 9's `updateRecovery` owns the countdown, the velocity kill and any follow-on invulnerability. `updateEntities` never writes `invulnTicks`.
  - **Surge slows karts ahead of its owner**, decided live from `computePlacement`, so it tracks positions changing while the field is up. It reaches the physics through `targetSpeedFor`'s surge factor and nowhere else.

---

- [ ] **Step 1: Write the failing test for the entity pool**

Create `packages/sim/test/entity.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import type {
  AuthEvent, EntityState, KartState, SimContext, SimState, Track, TrackQuery,
} from '../src/types'
import { MAX_ENTITIES, MAX_KARTS } from '../src/types'
import { makeCharacters, makeTuning } from './fixtures/track-fixtures'
import { despawnEntityAt, kartById, spawnEntity, updateEntities } from '../src/entity'

// A stub track: a 400 m loop, 20 m wide. The contract fixes `s` as
// arc-normalised [0, 1) everywhere in this package -- never metres -- so
// project() divides x by the lap length and wraps, checkpointS holds
// 0 / 0.25 / 0.5 / 0.75, and sampleAt() multiplies back out to place the
// centreline point. project() follows the locked convention
// right = (-t.z, 0, t.x); for the +X tangent (1,0,0) that is (0,0,1), so
// lateral is +z and the edges are z = +-10.
const TRACK_LEN = 400
const TRACK_WIDTH = 20

const wrap01 = (v: number): number => ((v % 1) + 1) % 1

function stubContext(): SimContext {
  const track: Track = {
    id: 'stub-loop',
    name: 'Stub Loop',
    controlPoints: [],
    checkpointS: [0, 0.25, 0.5, 0.75],
    itemBoxes: [],
    ramps: [],
    boostPads: [],
    startPositions: [],
    bounds: { min: { x: -1000, y: -10, z: -1000 }, max: { x: 2000, y: 10, z: 1000 } },
  }
  const query: TrackQuery = {
    sampleAt: (s) => ({
      position: { x: wrap01(s) * TRACK_LEN, y: 0, z: 0 },
      width: TRACK_WIDTH,
      banking: 0,
      surface: 'tarmac',
    }),
    tangentAt: () => ({ x: 1, y: 0, z: 0 }),
    project: (p) => ({ s: wrap01(p.x / TRACK_LEN), lateral: p.z, distance: Math.abs(p.z) }),
    groundHeight: () => 0,
    surfaceAt: () => 'tarmac',
    isInBounds: (_s, lateral) => Math.abs(lateral) <= TRACK_WIDTH * 0.5,
    checkpointIndexAt: (s) => Math.min(3, Math.floor(wrap01(s) * 4)),
    totalLength: () => TRACK_LEN,
  }
  return { track, query, tuning: makeTuning(), characters: makeCharacters(), isLeader: true }
}

// Blank karts are parked far down the track (x = 1000 + 10 * playerId) so that
// entity motion tests never trip a collision. Collision tests place karts
// explicitly.
function blankKart(playerId: number): KartState {
  return {
    playerId,
    characterIdx: 0,
    isBot: false,
    connected: true,
    position: { x: 1000 + 10 * playerId, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    heading: 0,
    angularVelocity: 0,
    drift: { active: false, dir: 0, charge: 0 },
    item: 'none',
    airborne: false,
    surface: 'tarmac',
    spinOutTicks: 0,
    invulnTicks: 0,
    boostTicks: 0,
    respawnTicks: 0,
    shielded: false,
    lap: { lap: 0, checkpointIdx: 0, t: 0 },
  }
}

function blankEntity(): EntityState {
  return {
    entityId: -1,
    kind: 'seeker',
    ownerId: -1,
    position: { x: 0, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    heading: 0,
    targetId: -1,
    ttl: 0,
  }
}

/** The empty finishedOrder: fixed length MAX_KARTS, every slot the -1 sentinel. */
function emptyFinishedOrder(): number[] {
  const order: number[] = []
  for (let i = 0; i < MAX_KARTS; i++) order.push(-1)
  return order
}

function blankState(): SimState {
  const karts: KartState[] = []
  for (let i = 0; i < MAX_KARTS; i++) karts.push(blankKart(i))
  const entities: EntityState[] = []
  for (let i = 0; i < MAX_ENTITIES; i++) entities.push(blankEntity())
  return {
    tick: 100,
    phase: 'racing',
    raceSeed: 999,
    rngCursor: 0,
    nextEventSeq: 0,
    finishTick: -1,
    karts,
    entities,
    entityCount: 0,
    nextEntityId: 1,
    itemBoxes: [],
    finishedOrder: emptyFinishedOrder(),
  }
}

describe('spawnEntity', () => {
  it('appends at the front of the pool, copies the position, wraps the heading and emits entitySpawn', () => {
    const state = blankState()
    const events: AuthEvent[] = []
    const p = { x: 1, y: 0.5, z: 2 }

    // 7 rad wraps into (-PI, PI] as 7 - 2 * PI = 0.7168146928204138
    const id = spawnEntity(state, 'slick', 4, p, 7, -1, 600, events)

    expect(id).toBe(1)
    expect(state.nextEntityId).toBe(2)
    expect(state.entityCount).toBe(1)
    const e = state.entities[0]
    expect(e.entityId).toBe(1)
    expect(e.kind).toBe('slick')
    expect(e.ownerId).toBe(4)
    expect(e.position.x).toBe(1)
    expect(e.position.y).toBe(0.5)
    expect(e.position.z).toBe(2)
    expect(e.velocity.x).toBe(0)
    expect(e.velocity.y).toBe(0)
    expect(e.velocity.z).toBe(0)
    expect(e.heading).toBeCloseTo(0.7168146928204138, 12)
    expect(e.targetId).toBe(-1)
    expect(e.ttl).toBe(600)

    // the caller's Vec3 must not be aliased into the pool
    p.x = 99
    expect(state.entities[0].position.x).toBe(1)

    expect(events.length).toBe(1)
    expect(events[0].kind).toBe('entitySpawn')
    expect(events[0].playerId).toBe(4)
    expect(events[0].entityId).toBe(1)
    expect(events[0].item).toBe('slick')
    expect(events[0].data).toBe(600) // ttl
    expect(events[0].eventSeq).toBe(0)
    expect(events[0].tick).toBe(100)
  })

  it('drops the spawn and emits nothing when the pool is full', () => {
    const state = blankState()
    const events: AuthEvent[] = []
    for (let i = 0; i < MAX_ENTITIES; i++) {
      const id = spawnEntity(state, 'bolt', 0, { x: i, y: 0, z: 0 }, 0, -1, 600, events)
      expect(id).toBe(i + 1) // ids run 1..32
    }
    expect(state.entityCount).toBe(MAX_ENTITIES) // 32
    expect(state.nextEntityId).toBe(33)
    expect(events.length).toBe(32)

    const overflow = spawnEntity(state, 'bolt', 1, { x: 0, y: 0, z: 0 }, 0, -1, 600, events)

    expect(overflow).toBe(-1)
    expect(state.entityCount).toBe(32)
    expect(state.nextEntityId).toBe(33) // not advanced by a dropped spawn
    expect(events.length).toBe(32) // nothing emitted
  })
})

describe('despawnEntityAt', () => {
  it('swap-removes and clears the vacated slot to the canonical dead form', () => {
    const state = blankState()
    const events: AuthEvent[] = []
    spawnEntity(state, 'slick', 0, { x: 1, y: 0, z: 0 }, 0, -1, 600, events) // id 1, idx 0
    spawnEntity(state, 'bolt', 1, { x: 2, y: 0, z: 0 }, 0, -1, 600, events) // id 2, idx 1
    spawnEntity(state, 'seeker', 2, { x: 3, y: 0, z: 0 }, 0.25, 5, 600, events) // id 3, idx 2
    events.length = 0

    despawnEntityAt(state, 0, events)

    expect(state.entityCount).toBe(2)
    expect(state.entities[0].entityId).toBe(3) // last live entity moved into slot 0
    expect(state.entities[0].kind).toBe('seeker')
    expect(state.entities[0].ownerId).toBe(2)
    expect(state.entities[0].targetId).toBe(5)
    expect(state.entities[1].entityId).toBe(2)
    const dead = state.entities[2]
    expect(dead.entityId).toBe(-1)
    expect(dead.kind).toBe('seeker')
    expect(dead.ownerId).toBe(-1)
    expect(dead.targetId).toBe(-1)
    expect(dead.heading).toBe(0)
    expect(dead.ttl).toBe(0)
    expect(dead.position.x).toBe(0)
    expect(dead.position.y).toBe(0)
    expect(dead.position.z).toBe(0)
    expect(dead.velocity.x).toBe(0)
    expect(dead.velocity.z).toBe(0)

    expect(events.length).toBe(1)
    expect(events[0].kind).toBe('entityDespawn')
    expect(events[0].playerId).toBe(0) // owner of the removed slick
    expect(events[0].entityId).toBe(1)
    expect(events[0].item).toBe('slick')
    expect(events[0].data).toBe(0)
  })

  it('ignores an index outside the live range', () => {
    const state = blankState()
    const events: AuthEvent[] = []
    spawnEntity(state, 'slick', 0, { x: 1, y: 0, z: 0 }, 0, -1, 600, events)
    events.length = 0

    despawnEntityAt(state, 1, events)
    despawnEntityAt(state, -1, events)
    despawnEntityAt(state, MAX_ENTITIES, events)

    expect(state.entityCount).toBe(1)
    expect(state.entities[0].entityId).toBe(1)
    expect(events.length).toBe(0)
  })
})

describe('kartById', () => {
  it('finds a kart by playerId and returns null for anything else', () => {
    const state = blankState()
    const k = kartById(state, 3)
    expect(k).not.toBeNull()
    expect(k?.playerId).toBe(3)
    expect(k?.position.x).toBe(1030) // 1000 + 10 * 3
    expect(kartById(state, 8)).toBeNull()
    expect(kartById(state, -1)).toBeNull()
  })
})

describe('updateEntities ttl', () => {
  it('decrements ttl every tick and despawns at zero', () => {
    const ctx = stubContext()
    const state = blankState()
    const events: AuthEvent[] = []
    const id = spawnEntity(state, 'slick', 0, { x: 5, y: 0, z: 1 }, 0, -1, 2, events)
    expect(id).toBe(1)
    events.length = 0

    updateEntities(ctx, state, events)

    expect(state.entityCount).toBe(1)
    expect(state.entities[0].ttl).toBe(1) // 2 - 1
    expect(events.length).toBe(0)

    updateEntities(ctx, state, events)

    expect(state.entityCount).toBe(0)
    expect(state.entities[0].entityId).toBe(-1)
    expect(events.length).toBe(1)
    expect(events[0].kind).toBe('entityDespawn')
    expect(events[0].entityId).toBe(1)
    expect(events[0].item).toBe('slick')
  })

  it('expires several entities in one tick without skipping a live slot', () => {
    const ctx = stubContext()
    const state = blankState()
    const events: AuthEvent[] = []
    spawnEntity(state, 'slick', 0, { x: 1, y: 0, z: 0 }, 0, -1, 1, events) // id 1, expires
    spawnEntity(state, 'slick', 1, { x: 2, y: 0, z: 0 }, 0, -1, 5, events) // id 2, lives
    spawnEntity(state, 'slick', 2, { x: 3, y: 0, z: 0 }, 0, -1, 1, events) // id 3, expires
    spawnEntity(state, 'slick', 3, { x: 4, y: 0, z: 0 }, 0, -1, 5, events) // id 4, lives
    events.length = 0

    updateEntities(ctx, state, events)

    // backwards walk: idx3 ttl 5->4, idx2 expires (id4 swaps down into slot 2),
    // idx1 ttl 5->4, idx0 expires (id4 swaps down into slot 0)
    expect(state.entityCount).toBe(2)
    expect(state.entities[0].entityId).toBe(4)
    expect(state.entities[1].entityId).toBe(2)
    expect(state.entities[0].ttl).toBe(4) // 5 - 1
    expect(state.entities[1].ttl).toBe(4) // 5 - 1
    expect(state.entities[2].entityId).toBe(-1)
    expect(state.entities[3].entityId).toBe(-1)
    expect(events.length).toBe(2)
    expect(events[0].entityId).toBe(3) // the higher index expires first
    expect(events[1].entityId).toBe(1)
  })
})
```

- [ ] **Step 2: Run the pool test to verify it fails**

Run: `npx vitest run packages/sim/test/entity.test.ts`
Expected: FAIL with `Failed to resolve import "../src/entity" from "packages/sim/test/entity.test.ts"`.

- [ ] **Step 3: Implement the pool half of `packages/sim/src/entity.ts`**

Create `packages/sim/src/entity.ts`. `updateEntities` starts as the ttl pass only; Steps 7, 11 and 15 grow it.

```ts
import type {
  AuthEvent, EntityKind, EntityState, KartState, SimContext, SimState, Vec3,
} from './types'
import { MAX_ENTITIES } from './types'
import { wrapAngle } from './mathutil'
import { emit } from './state'

/**
 * The canonical dead form of a pool slot. entityId === -1 is the contract's
 * sentinel; the rest is cleared so a slot's contents never depend on which
 * entity last occupied it.
 */
function clearSlot(e: EntityState): void {
  e.entityId = -1
  e.kind = 'seeker'
  e.ownerId = -1
  e.position.x = 0
  e.position.y = 0
  e.position.z = 0
  e.velocity.x = 0
  e.velocity.y = 0
  e.velocity.z = 0
  e.heading = 0
  e.targetId = -1
  e.ttl = 0
}

/**
 * Take the next free slot at the front of the pool. Returns the new entityId,
 * or -1 when the pool is full: the contract drops the spawn and never evicts.
 * `position` is copied by value; `velocity` is derived by updateEntities.
 */
export function spawnEntity(
  state: SimState,
  kind: EntityKind,
  ownerId: number,
  position: Vec3,
  heading: number,
  targetId: number,
  ttl: number,
  events: AuthEvent[],
): number {
  if (state.entityCount >= MAX_ENTITIES) return -1

  const idx = state.entityCount
  const e = state.entities[idx]
  const entityId = state.nextEntityId
  state.nextEntityId = entityId + 1
  state.entityCount = idx + 1

  e.entityId = entityId
  e.kind = kind
  e.ownerId = ownerId
  e.position.x = position.x
  e.position.y = position.y
  e.position.z = position.z
  e.velocity.x = 0
  e.velocity.y = 0
  e.velocity.z = 0
  e.heading = wrapAngle(heading)
  e.targetId = targetId
  e.ttl = ttl

  emit(state, events, 'entitySpawn', ownerId, entityId, kind, ttl)
  return entityId
}

/** Remove the entity at packed index `idx` (not an entityId) by swap-remove. */
export function despawnEntityAt(state: SimState, idx: number, events: AuthEvent[]): void {
  if (idx < 0 || idx >= state.entityCount) return

  const e = state.entities[idx]
  emit(state, events, 'entityDespawn', e.ownerId, e.entityId, e.kind, 0)

  const last = state.entityCount - 1
  if (idx !== last) {
    const tmp = state.entities[idx]
    state.entities[idx] = state.entities[last]
    state.entities[last] = tmp
  }
  state.entityCount = last
  clearSlot(state.entities[last])
}

export function kartById(state: SimState, playerId: number): KartState | null {
  const karts = state.karts
  for (let i = 0; i < karts.length; i++) {
    if (karts[i].playerId === playerId) return karts[i]
  }
  return null
}

/**
 * One call per tick, after the per-kart loop and resolveKartCollisions.
 * Iterates the live range backwards so a swap-remove can never skip or
 * re-process a slot: the entity moved down into `i` always comes from an index
 * that was already visited.
 */
export function updateEntities(
  _ctx: SimContext,
  state: SimState,
  events: AuthEvent[],
): void {
  for (let i = state.entityCount - 1; i >= 0; i--) {
    const e = state.entities[i]
    e.ttl -= 1
    if (e.ttl <= 0) despawnEntityAt(state, i, events)
  }
}
```

- [ ] **Step 4: Run the pool test to verify it passes**

Run: `npx vitest run packages/sim/test/entity.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Write the failing test for per-kind entity motion**

Append these two suites to the end of `packages/sim/test/entity.test.ts` (the imports and helpers from Step 1 already cover everything they need):

```ts
describe('updateEntities motion', () => {
  it('turns a seeker toward its target at the capped turn rate and flies at seekerSpeed', () => {
    const ctx = stubContext()
    const state = blankState()
    const events: AuthEvent[] = []
    state.karts[3].position.x = 10
    state.karts[3].position.y = 0
    state.karts[3].position.z = 10
    spawnEntity(state, 'seeker', 0, { x: 0, y: 0.5, z: 0 }, 0, 3, 600, events)
    events.length = 0

    updateEntities(ctx, state, events)

    const e = state.entities[0]
    // desired heading = atan2(10 - 0, 10 - 0) = PI/4 = 0.7853981633974483,
    // capped at SEEKER_TURN_RATE * TICK_DT = 4 / 60 = 0.06666666666666667
    expect(e.heading).toBeCloseTo(0.06666666666666667, 12)
    // velocity = seekerSpeed 55 * (cos h, 0, sin h)
    expect(e.velocity.x).toBeCloseTo(54.87782303856173, 9)
    expect(e.velocity.y).toBe(0)
    expect(e.velocity.z).toBeCloseTo(3.6639512207866147, 9)
    // position += velocity * TICK_DT
    expect(e.position.x).toBeCloseTo(0.9146303839760288, 9)
    expect(e.position.z).toBeCloseTo(0.06106585367977691, 9)
    expect(e.position.y).toBe(0.5) // entities are planar: y never integrates
    expect(e.ttl).toBe(599)
    expect(events.length).toBe(0)
  })

  it('flies a seeker straight when it has no target', () => {
    const ctx = stubContext()
    const state = blankState()
    const events: AuthEvent[] = []
    // heading 0: cos = 1 and sin = 0 exactly, so it runs straight down +X
    spawnEntity(state, 'seeker', 0, { x: 500, y: 0, z: 0 }, 0, -1, 600, events)
    events.length = 0

    updateEntities(ctx, state, events)

    const e = state.entities[0]
    expect(e.heading).toBe(0) // no target, so no homing turn at all
    expect(e.velocity.x).toBe(55) // seekerSpeed
    expect(e.velocity.z).toBe(0)
    // 500 + 55 / 60 = 500.9166666666667
    expect(e.position.x).toBeCloseTo(500.9166666666667, 9)
    expect(e.position.z).toBe(0)
  })

  it('bounces a bolt off the track edge and places it back inside', () => {
    const ctx = stubContext()
    const state = blankState()
    const events: AuthEvent[] = []
    // half width = 10; the bolt is at z = 9.9 heading PI/4 (out toward +z)
    spawnEntity(state, 'bolt', 0, { x: 0, y: 0.5, z: 9.9 }, Math.PI / 4, -1, 600, events)
    events.length = 0

    updateEntities(ctx, state, events)

    const e = state.entities[0]
    // step: velocity = 65 * (cos, sin)(PI/4) = (45.96194077712559, 0, 45.961940777125584)
    // z = 9.9 + 45.961940777125584 / 60 = 10.666032346285427 -> outside +-10
    // reflect about the tangent (1,0,0): heading PI/4 -> -PI/4
    expect(e.heading).toBeCloseTo(-0.7853981633974483, 12)
    // x is unaffected by the lateral push-back (right = (0,0,1))
    expect(e.position.x).toBeCloseTo(0.7660323462854265, 9)
    // pushed back to half - BOLT_EDGE_INSET = 10 - 0.05
    expect(e.position.z).toBeCloseTo(9.95, 9)
    // velocity is recomputed from the post-bounce heading
    expect(e.velocity.x).toBeCloseTo(45.96194077712559, 9)
    expect(e.velocity.z).toBeCloseTo(-45.961940777125584, 9)
    expect(state.entityCount).toBe(1) // a bounce never despawns
  })

  it('leaves a slick exactly where it was dropped', () => {
    const ctx = stubContext()
    const state = blankState()
    const events: AuthEvent[] = []
    spawnEntity(state, 'slick', 2, { x: 3, y: 0, z: -4 }, 1.25, -1, 600, events)
    events.length = 0

    updateEntities(ctx, state, events)
    updateEntities(ctx, state, events)

    const e = state.entities[0]
    expect(e.position.x).toBe(3)
    expect(e.position.y).toBe(0)
    expect(e.position.z).toBe(-4)
    expect(e.velocity.x).toBe(0)
    expect(e.velocity.z).toBe(0)
    expect(e.heading).toBe(1.25)
    expect(e.ttl).toBe(598) // 600 - 2
  })

  it('orbits a bubble around its owner', () => {
    const ctx = stubContext()
    const state = blankState()
    const events: AuthEvent[] = []
    const owner = state.karts[1]
    owner.position.x = 5
    owner.position.y = 0
    owner.position.z = -3
    owner.shielded = true // the bubble is the view of this flag
    spawnEntity(state, 'bubble', 1, { x: 0, y: 0, z: 0 }, 0, -1, 600, events)
    events.length = 0

    updateEntities(ctx, state, events)

    const e = state.entities[0]
    // heading += BUBBLE_ORBIT_RATE * TICK_DT = 6 / 60 = 0.1
    expect(e.heading).toBeCloseTo(0.1, 12)
    // position = owner + 2 * (cos 0.1, 0, sin 0.1) = (5 + 1.9900083305560514, 0, -3 + 0.1996668332936563)
    expect(e.position.x).toBeCloseTo(6.990008330556051, 9)
    expect(e.position.y).toBe(0)
    expect(e.position.z).toBeCloseTo(-2.8003331667063436, 9)
    // tangential velocity = rate * radius = 12
    expect(e.velocity.x).toBeCloseTo(-1.1980009997619379, 9)
    expect(e.velocity.z).toBeCloseTo(11.940049983336309, 9)
    expect(state.entityCount).toBe(1)
  })

  it('holds surge and charge fields still and only counts them down', () => {
    const ctx = stubContext()
    const state = blankState()
    const events: AuthEvent[] = []
    spawnEntity(state, 'surge', 2, { x: 7, y: 0, z: 8 }, 0.5, -1, 300, events)
    spawnEntity(state, 'charge', 3, { x: -5, y: 0, z: 6 }, -0.5, -1, 30, events)
    events.length = 0

    updateEntities(ctx, state, events)

    const surge = state.entities[0]
    const charge = state.entities[1]
    expect(surge.position.x).toBe(7)
    expect(surge.position.z).toBe(8)
    expect(surge.velocity.x).toBe(0)
    expect(surge.velocity.z).toBe(0)
    expect(surge.ttl).toBe(299)
    expect(charge.position.x).toBe(-5)
    expect(charge.position.z).toBe(6)
    expect(charge.velocity.x).toBe(0)
    expect(charge.ttl).toBe(29)
    expect(state.entityCount).toBe(2)
  })
})
```

- [ ] **Step 6: Run the motion test to verify it fails**

Run: `npx vitest run packages/sim/test/entity.test.ts -t "seeker"`
Expected: FAIL — the seeker does not move at all, so `expected 0 to be close to 0.06666666666666667`.

- [ ] **Step 7: Add the motion pass to `packages/sim/src/entity.ts`**

Three edits to the file created in Step 3.

**7a.** Replace the two import lines:

```ts
import { MAX_ENTITIES } from './types'
import { wrapAngle } from './mathutil'
```

with:

```ts
import { MAX_ENTITIES, TICK_DT } from './types'
import { clamp, wrapAngle } from './mathutil'
```

**7b.** Insert these constants directly below the import block, above `clearSlot`:

```ts
const SEEKER_TURN_RATE = 4.0 // rad/s of homing authority
const BOLT_EDGE_INSET = 0.05 // m inside the edge a bolt is placed after a bounce
const BUBBLE_ORBIT_RADIUS = 2.0 // m
const BUBBLE_ORBIT_RATE = 6.0 // rad/s
```

**7c.** Replace `updateEntities` together with its doc comment — currently the tail of the file reads:

```ts
/**
 * One call per tick, after the per-kart loop and resolveKartCollisions.
 * Iterates the live range backwards so a swap-remove can never skip or
 * re-process a slot: the entity moved down into `i` always comes from an index
 * that was already visited.
 */
export function updateEntities(
  _ctx: SimContext,
  state: SimState,
  events: AuthEvent[],
): void {
  for (let i = state.entityCount - 1; i >= 0; i--) {
    const e = state.entities[i]
    e.ttl -= 1
    if (e.ttl <= 0) despawnEntityAt(state, i, events)
  }
}
```

Note the parameter rename from `_ctx` to `ctx`: the ttl-only version never read the
context, and the leading underscore is what kept `noUnusedParameters` quiet.

with the motion pass plus the same ttl pass, and a new `stepEntity` helper above it:

```ts
/** One tick of per-kind motion. Never spawns or despawns. */
function stepEntity(ctx: SimContext, state: SimState, e: EntityState): void {
  switch (e.kind) {
    case 'seeker': {
      const target = e.targetId >= 0 ? kartById(state, e.targetId) : null
      if (target !== null) {
        const dx = target.position.x - e.position.x
        const dz = target.position.z - e.position.z
        if (dx !== 0 || dz !== 0) {
          const maxTurn = SEEKER_TURN_RATE * TICK_DT
          const diff = wrapAngle(Math.atan2(dz, dx) - e.heading)
          e.heading = wrapAngle(e.heading + clamp(diff, -maxTurn, maxTurn))
        }
      }
      const sp = ctx.tuning.seekerSpeed
      e.velocity.x = Math.cos(e.heading) * sp
      e.velocity.y = 0
      e.velocity.z = Math.sin(e.heading) * sp
      e.position.x += e.velocity.x * TICK_DT
      e.position.z += e.velocity.z * TICK_DT
      return
    }
    case 'bolt': {
      const sp = ctx.tuning.boltSpeed
      e.velocity.x = Math.cos(e.heading) * sp
      e.velocity.y = 0
      e.velocity.z = Math.sin(e.heading) * sp
      e.position.x += e.velocity.x * TICK_DT
      e.position.z += e.velocity.z * TICK_DT

      const proj = ctx.query.project(e.position)
      const half = ctx.query.sampleAt(proj.s).width * 0.5
      if (proj.lateral <= half && proj.lateral >= -half) return

      const tan = ctx.query.tangentAt(proj.s)
      const tl = Math.sqrt(tan.x * tan.x + tan.z * tan.z)
      if (tl < 1e-9) return
      const tx = tan.x / tl
      const tz = tan.z / tl
      // right = (-t.z, 0, t.x), normalized: positive lateral is right of travel
      const rx = -tz
      const rz = tx
      // reflect the heading direction about the tangent axis: 2(d.t)t - d
      const dx = Math.cos(e.heading)
      const dz = Math.sin(e.heading)
      const dot = dx * tx + dz * tz
      e.heading = wrapAngle(Math.atan2(2 * dot * tz - dz, 2 * dot * tx - dx))
      // and place it back just inside the edge it crossed
      const edge = half - BOLT_EDGE_INSET
      const shift = (proj.lateral > 0 ? edge : -edge) - proj.lateral
      e.position.x += rx * shift
      e.position.z += rz * shift
      e.velocity.x = Math.cos(e.heading) * sp
      e.velocity.z = Math.sin(e.heading) * sp
      return
    }
    case 'bubble': {
      e.heading = wrapAngle(e.heading + BUBBLE_ORBIT_RATE * TICK_DT)
      const tangential = BUBBLE_ORBIT_RATE * BUBBLE_ORBIT_RADIUS
      e.velocity.x = -Math.sin(e.heading) * tangential
      e.velocity.y = 0
      e.velocity.z = Math.cos(e.heading) * tangential
      const owner = kartById(state, e.ownerId)
      if (owner !== null) {
        e.position.x = owner.position.x + Math.cos(e.heading) * BUBBLE_ORBIT_RADIUS
        e.position.y = owner.position.y
        e.position.z = owner.position.z + Math.sin(e.heading) * BUBBLE_ORBIT_RADIUS
      }
      return
    }
    default: {
      // slick is a dropped hazard; surge and charge are timed fields. All
      // three sit still and only their ttl moves.
      e.velocity.x = 0
      e.velocity.y = 0
      e.velocity.z = 0
      return
    }
  }
}

/**
 * One call per tick, after the per-kart loop and resolveKartCollisions.
 * The ttl pass iterates the live range backwards so a swap-remove can never
 * skip or re-process a slot: the entity moved down into `i` always comes from
 * an index that was already visited.
 */
export function updateEntities(
  ctx: SimContext,
  state: SimState,
  events: AuthEvent[],
): void {
  for (let i = 0; i < state.entityCount; i++) {
    stepEntity(ctx, state, state.entities[i])
  }
  for (let i = state.entityCount - 1; i >= 0; i--) {
    const e = state.entities[i]
    e.ttl -= 1
    if (e.ttl <= 0) despawnEntityAt(state, i, events)
  }
}
```

- [ ] **Step 8: Run the motion test to verify it passes**

Run: `npx vitest run packages/sim/test/entity.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 9: Write the failing test for entity/kart collision**

Append this suite to the end of `packages/sim/test/entity.test.ts`:

```ts
describe('updateEntities collision', () => {
  it('spins out the kart it strikes and emits hit then spinOut', () => {
    const ctx = stubContext()
    const state = blankState()
    const events: AuthEvent[] = []
    const victim = state.karts[1]
    victim.position.x = 0
    victim.position.y = 0
    victim.position.z = 0
    // slick reach = 1.2 + kartRadius 0.9 = 2.1, and it sits 1.5 away
    spawnEntity(state, 'slick', 0, { x: 1.5, y: 0, z: 0 }, 0, -1, 600, events)
    events.length = 0
    state.nextEventSeq = 0 // drop the spawn event and number the hit from 0

    updateEntities(ctx, state, events)

    expect(victim.spinOutTicks).toBe(60) // tuning.spinOutTicks, armed by startSpinOut
    expect(victim.invulnTicks).toBe(0) // Task 9 owns invulnerability, not this
    expect(events.length).toBe(2)
    expect(events[0].kind).toBe('hit')
    expect(events[0].playerId).toBe(1)
    expect(events[0].entityId).toBe(1)
    expect(events[0].item).toBe('slick')
    expect(events[0].data).toBe(0) // 0 = took the hit, 1 = a shield ate it
    expect(events[0].eventSeq).toBe(0)
    // the spinOut event is emitted by startSpinOut, not by this module
    expect(events[1].kind).toBe('spinOut')
    expect(events[1].playerId).toBe(1)
    expect(events[1].item).toBe('none')
    expect(events[1].data).toBe(60)
    expect(events[1].eventSeq).toBe(1)
    // a slick is persistent: it survives the karts it spins out
    expect(state.entityCount).toBe(1)
    expect(state.entities[0].ttl).toBe(599)
  })

  it('consumes a seeker on impact', () => {
    const ctx = stubContext()
    const state = blankState()
    const events: AuthEvent[] = []
    const victim = state.karts[1]
    victim.position.x = 0
    victim.position.y = 0
    victim.position.z = 0
    // heading 0, no target: it steps to x = -2 + 55/60 = -1.0833333333333335,
    // inside the seeker reach of 1.6 + 0.9 = 2.5
    spawnEntity(state, 'seeker', 0, { x: -2, y: 0, z: 0 }, 0, -1, 600, events)
    events.length = 0

    updateEntities(ctx, state, events)

    expect(victim.spinOutTicks).toBe(60)
    expect(state.entityCount).toBe(0)
    expect(state.entities[0].entityId).toBe(-1)
    expect(events.length).toBe(3)
    expect(events[0].kind).toBe('hit')
    expect(events[1].kind).toBe('spinOut')
    expect(events[2].kind).toBe('entityDespawn')
    expect(events[2].playerId).toBe(0) // the owner, on a despawn
    expect(events[2].entityId).toBe(1)
    expect(events[2].item).toBe('seeker')
  })

  it('misses a kart outside the hit radius', () => {
    const ctx = stubContext()
    const state = blankState()
    const events: AuthEvent[] = []
    const near = state.karts[1]
    near.position.x = 0
    near.position.y = 0
    near.position.z = 0
    // 2.5 apart, and the slick only reaches 1.2 + 0.9 = 2.1
    spawnEntity(state, 'slick', 0, { x: 2.5, y: 0, z: 0 }, 0, -1, 600, events)
    events.length = 0

    updateEntities(ctx, state, events)

    expect(near.spinOutTicks).toBe(0)
    expect(events.length).toBe(0)
    expect(state.entityCount).toBe(1)
  })

  it('never strikes its own owner', () => {
    const ctx = stubContext()
    const state = blankState()
    const events: AuthEvent[] = []
    const owner = state.karts[1]
    owner.position.x = 0
    owner.position.y = 0
    owner.position.z = 0
    spawnEntity(state, 'slick', 1, { x: 1.5, y: 0, z: 0 }, 0, -1, 600, events)
    events.length = 0

    updateEntities(ctx, state, events)

    expect(owner.spinOutTicks).toBe(0)
    expect(events.length).toBe(0)
  })

  it('passes through karts that are spinning, invulnerable or respawning', () => {
    const ctx = stubContext()
    const state = blankState()
    const events: AuthEvent[] = []
    const invuln = state.karts[1]
    invuln.position.x = 0
    invuln.position.y = 0
    invuln.position.z = 0
    invuln.invulnTicks = 5
    const spinning = state.karts[2]
    spinning.position.x = 0
    spinning.position.y = 0
    spinning.position.z = 1
    spinning.spinOutTicks = 3
    const respawning = state.karts[3]
    respawning.position.x = 0
    respawning.position.y = 0
    respawning.position.z = -1
    respawning.respawnTicks = 7
    spawnEntity(state, 'slick', 0, { x: 1.5, y: 0, z: 0 }, 0, -1, 600, events)
    events.length = 0

    updateEntities(ctx, state, events)

    expect(invuln.spinOutTicks).toBe(0)
    expect(spinning.spinOutTicks).toBe(3) // untouched, not refreshed
    expect(respawning.spinOutTicks).toBe(0)
    // the guard skips these karts before the hit event, so not even a 'hit'
    // is emitted -- startSpinOut alone would still have let the hit through
    expect(events.length).toBe(0)
  })

  it('lets a shielded kart eat the hit and takes its bubble with it', () => {
    const ctx = stubContext()
    const state = blankState()
    const events: AuthEvent[] = []
    const victim = state.karts[1]
    victim.position.x = 0
    victim.position.y = 0
    victim.position.z = 0
    victim.shielded = true
    spawnEntity(state, 'slick', 0, { x: 1.5, y: 0, z: 0 }, 0, -1, 600, events) // id 1
    spawnEntity(state, 'bubble', 1, { x: 0, y: 0, z: 0 }, 0, -1, 600, events) // id 2
    events.length = 0

    updateEntities(ctx, state, events)

    expect(victim.shielded).toBe(false)
    expect(victim.spinOutTicks).toBe(0) // the shield ate it
    expect(events.length).toBe(2)
    expect(events[0].kind).toBe('hit')
    expect(events[0].playerId).toBe(1)
    expect(events[0].item).toBe('slick')
    expect(events[0].data).toBe(1) // 1 = absorbed
    expect(events[1].kind).toBe('entityDespawn')
    expect(events[1].entityId).toBe(2)
    expect(events[1].item).toBe('bubble')
    expect(events.some((ev) => ev.kind === 'spinOut')).toBe(false)
    expect(state.entityCount).toBe(1)
    expect(state.entities[0].entityId).toBe(1) // the slick outlives the shield
  })

  it('despawns a bubble whose owner is not shielded', () => {
    const ctx = stubContext()
    const state = blankState()
    const events: AuthEvent[] = []
    state.karts[4].shielded = false
    spawnEntity(state, 'bubble', 4, { x: 0, y: 0, z: 0 }, 0, -1, 600, events)
    events.length = 0

    updateEntities(ctx, state, events)

    expect(state.entityCount).toBe(0)
    expect(events.length).toBe(1)
    expect(events[0].kind).toBe('entityDespawn')
    expect(events[0].item).toBe('bubble')
  })
})
```

- [ ] **Step 10: Run the collision test to verify it fails**

Run: `npx vitest run packages/sim/test/entity.test.ts -t "spins out the kart"`
Expected: FAIL with `expected 0 to be 60` — nothing strikes karts yet.

- [ ] **Step 11: Add the collision and bubble passes to `packages/sim/src/entity.ts`**

Three edits.

**11a.** Add the `recovery` import. The contract makes `startSpinOut` the sole
writer of `k.spinOutTicks` and the sole emitter of `'spinOut'`, so this module
calls it rather than assigning the field. Before:

```ts
import { MAX_ENTITIES, TICK_DT } from './types'
import { clamp, wrapAngle } from './mathutil'
import { emit } from './state'
```

After:

```ts
import { MAX_ENTITIES, TICK_DT } from './types'
import { clamp, wrapAngle } from './mathutil'
import { emit } from './state'
import { startSpinOut } from './recovery'
```

(`recovery.ts` imports neither `entity.ts` nor `kart.ts`, so this adds no cycle.)

**11b.** Insert `hitRadiusFor` directly above `stepEntity`:

```ts
/**
 * Strike radius per kind, in metres, added to tuning.kartRadius at the test.
 * A bubble is a shield, and a surge is a slow field: neither strikes a kart.
 */
function hitRadiusFor(kind: EntityKind): number {
  switch (kind) {
    case 'seeker':
      return 1.6
    case 'bolt':
      return 1.4
    case 'slick':
      return 1.2
    case 'charge':
      return 6.0
    default:
      return 0
  }
}
```

**11c.** Replace `updateEntities` together with its doc comment — currently the tail of the file reads:

```ts
/**
 * One call per tick, after the per-kart loop and resolveKartCollisions.
 * The ttl pass iterates the live range backwards so a swap-remove can never
 * skip or re-process a slot: the entity moved down into `i` always comes from
 * an index that was already visited.
 */
export function updateEntities(
  ctx: SimContext,
  state: SimState,
  events: AuthEvent[],
): void {
  for (let i = 0; i < state.entityCount; i++) {
    stepEntity(ctx, state, state.entities[i])
  }
  for (let i = state.entityCount - 1; i >= 0; i--) {
    const e = state.entities[i]
    e.ttl -= 1
    if (e.ttl <= 0) despawnEntityAt(state, i, events)
  }
}
```

with the four-pass version:

```ts
/**
 * One call per tick, after the per-kart loop and resolveKartCollisions.
 * Motion, then strikes, then shield bookkeeping, then ttl. Every pass that can
 * despawn walks the live range backwards, so a swap-remove can never skip or
 * re-process a slot: the entity moved down into `i` always comes from an index
 * that was already visited.
 */
export function updateEntities(
  ctx: SimContext,
  state: SimState,
  events: AuthEvent[],
): void {
  for (let i = 0; i < state.entityCount; i++) {
    stepEntity(ctx, state, state.entities[i])
  }

  const karts = state.karts
  for (let i = state.entityCount - 1; i >= 0; i--) {
    const e = state.entities[i]
    const radius = hitRadiusFor(e.kind)
    if (radius <= 0) continue
    const reach = radius + ctx.tuning.kartRadius
    const reach2 = reach * reach
    for (let ki = 0; ki < karts.length; ki++) {
      const k = karts[ki]
      if (k.playerId === e.ownerId) continue
      // startSpinOut refuses these karts anyway; skipping them here is what
      // also suppresses the 'hit' event, so an untouchable kart is silent.
      if (k.spinOutTicks > 0 || k.invulnTicks > 0 || k.respawnTicks > 0) continue
      const dx = e.position.x - k.position.x
      const dy = e.position.y - k.position.y
      const dz = e.position.z - k.position.z
      if (dx * dx + dy * dy + dz * dz > reach2) continue
      if (k.shielded) {
        k.shielded = false
        emit(state, events, 'hit', k.playerId, e.entityId, e.kind, 1)
      } else {
        emit(state, events, 'hit', k.playerId, e.entityId, e.kind, 0)
        // startSpinOut is the contract's sole writer of spinOutTicks and it
        // emits the 'spinOut' event itself.
        startSpinOut(state, k, ctx.tuning.spinOutTicks, events)
      }
      if (e.kind === 'seeker' || e.kind === 'bolt') {
        // `e` is cleared by the swap-remove, so nothing may read it after this
        despawnEntityAt(state, i, events)
        break
      }
    }
  }

  // k.shielded is the truth; a bubble is its view. One outlives the other for
  // no ticks at all.
  for (let i = state.entityCount - 1; i >= 0; i--) {
    const e = state.entities[i]
    if (e.kind !== 'bubble') continue
    const owner = kartById(state, e.ownerId)
    if (owner === null || !owner.shielded) despawnEntityAt(state, i, events)
  }

  for (let i = state.entityCount - 1; i >= 0; i--) {
    const e = state.entities[i]
    e.ttl -= 1
    if (e.ttl <= 0) despawnEntityAt(state, i, events)
  }
}
```

- [ ] **Step 12: Run the collision test to verify it passes**

Run: `npx vitest run packages/sim/test/entity.test.ts`
Expected: PASS, 20 tests.

- [ ] **Step 13: Write the failing test for `surgeActiveOn`**

Append this suite to the end of `packages/sim/test/entity.test.ts`, and add `surgeActiveOn` to the entity import at the top of the file, changing:

```ts
import { despawnEntityAt, kartById, spawnEntity, updateEntities } from '../src/entity'
```

to:

```ts
import {
  despawnEntityAt, kartById, spawnEntity, surgeActiveOn, updateEntities,
} from '../src/entity'
```

```ts
describe('surgeActiveOn', () => {
  // Placement from (lap, checkpointIdx, t) descending, playerId breaking ties:
  // p2 (2,5,0.5) then p5 (1,3,0.2) then everyone still on (0,0,0) in playerId
  // order, so the order is [2, 5, 0, 1, 3, 4, 6, 7] and the places are
  // p2->0 p5->1 p0->2 p1->3 p3->4 p4->5 p6->6 p7->7.
  function progressState(): SimState {
    const state = blankState()
    state.karts[2].lap.lap = 2
    state.karts[2].lap.checkpointIdx = 5
    state.karts[2].lap.t = 0.5
    state.karts[5].lap.lap = 1
    state.karts[5].lap.checkpointIdx = 3
    state.karts[5].lap.t = 0.2
    return state
  }

  it('is false for everyone when no surge is live', () => {
    const state = progressState()
    for (let pid = 0; pid < MAX_KARTS; pid++) {
      expect(surgeActiveOn(state, pid)).toBe(false)
    }
  })

  it('slows only the karts placed ahead of the surge owner', () => {
    const state = progressState()
    const events: AuthEvent[] = []
    spawnEntity(state, 'surge', 5, { x: 0, y: 0, z: 0 }, 0, -1, 300, events)

    expect(surgeActiveOn(state, 2)).toBe(true) // place 0, ahead of p5's place 1
    expect(surgeActiveOn(state, 5)).toBe(false) // the owner is never slowed
    expect(surgeActiveOn(state, 0)).toBe(false) // place 2, behind p5
    expect(surgeActiveOn(state, 7)).toBe(false) // place 7, behind p5
  })

  it('ignores non-surge entities and out-of-range player ids', () => {
    const state = progressState()
    const events: AuthEvent[] = []
    spawnEntity(state, 'slick', 5, { x: 0, y: 0, z: 0 }, 0, -1, 600, events)
    expect(surgeActiveOn(state, 2)).toBe(false)

    spawnEntity(state, 'surge', 5, { x: 0, y: 0, z: 0 }, 0, -1, 300, events)
    expect(surgeActiveOn(state, 2)).toBe(true)
    expect(surgeActiveOn(state, -1)).toBe(false)
    expect(surgeActiveOn(state, MAX_KARTS)).toBe(false) // 8
  })

  it('lets one surge owner be caught by another surge', () => {
    const state = progressState()
    const events: AuthEvent[] = []
    spawnEntity(state, 'surge', 5, { x: 0, y: 0, z: 0 }, 0, -1, 300, events) // owner place 1
    spawnEntity(state, 'surge', 0, { x: 0, y: 0, z: 0 }, 0, -1, 300, events) // owner place 2

    expect(surgeActiveOn(state, 2)).toBe(true) // place 0: ahead of both
    expect(surgeActiveOn(state, 5)).toBe(true) // place 1: ahead of p0's surge
    expect(surgeActiveOn(state, 0)).toBe(false) // place 2: behind p5, owns the other
    expect(surgeActiveOn(state, 1)).toBe(false) // place 3: behind both
  })
})
```

- [ ] **Step 14: Run the surge test to verify it fails**

Run: `npx vitest run packages/sim/test/entity.test.ts -t "surge"`
Expected: FAIL with `"surgeActiveOn" is not exported by "packages/sim/src/entity.ts"`.

- [ ] **Step 15: Add `surgeActiveOn` to `packages/sim/src/entity.ts`**

Three edits.

**15a.** Replace the import block header — currently:

```ts
import { MAX_ENTITIES, TICK_DT } from './types'
import { clamp, wrapAngle } from './mathutil'
import { emit } from './state'
import { startSpinOut } from './recovery'
```

with:

```ts
import { MAX_ENTITIES, MAX_KARTS, TICK_DT } from './types'
import { clamp, wrapAngle } from './mathutil'
import { emit } from './state'
import { startSpinOut } from './recovery'
import { computePlacement } from './placement'
```

**15b.** Add two scratch arrays directly below the four motion constants:

```ts
// Placement scratch for surgeActiveOn. Module-level so the per-tick, per-kart
// call allocates nothing.
const placeIndexOf = new Int32Array(MAX_KARTS)
const placeOrder = new Int32Array(MAX_KARTS)
```

**15c.** Append to the end of the file:

```ts
/**
 * True when some live surge field, cast by a kart placed behind `playerId`,
 * is slowing it. Placement is read live, so a kart that drops behind the
 * caster stops being slowed. Task 6's targetSpeedFor multiplies by
 * tuning.surgeSpeedMul when this is true.
 */
export function surgeActiveOn(state: SimState, playerId: number): boolean {
  if (playerId < 0 || playerId >= MAX_KARTS) return false

  let anySurge = false
  for (let i = 0; i < state.entityCount; i++) {
    if (state.entities[i].kind === 'surge') {
      anySurge = true
      break
    }
  }
  if (!anySurge) return false // the common case: no sort at all

  computePlacement(state, placeIndexOf, placeOrder)
  const mine = placeIndexOf[playerId]
  for (let i = 0; i < state.entityCount; i++) {
    const e = state.entities[i]
    if (e.kind !== 'surge') continue
    if (e.ownerId === playerId) continue
    if (e.ownerId < 0 || e.ownerId >= MAX_KARTS) continue
    if (mine < placeIndexOf[e.ownerId]) return true // lower place is further ahead
  }
  return false
}
```

- [ ] **Step 16: Run the surge test to verify it passes**

Run: `npx vitest run packages/sim/test/entity.test.ts`
Expected: PASS, 24 tests.

- [ ] **Step 17: Write the failing test for the `kart.ts` wiring**

`surgeActiveOn` is fully implemented and nothing consumes it. `targetSpeedFor`
gets its surge factor from Task 6's staged `surgeFactorFor`, whose rule is *"any
live surge this kart does not own"* — so today the Surge item slows the whole
field except its caster, instead of only the karts ahead of the caster.

That divergence is quiet, which is why the second test below exists. A test with
the caster mid-pack and the subject **ahead** of it cannot see the difference:
both rules slow the subject. Only a subject placed **behind** the caster
separates them — the contract's rule leaves it alone, Task 6's staged rule slows
it. Two edits to `packages/sim/test/entity.test.ts`.

**17a.** Add the `kart.ts` import directly below the entity import. Before:

```ts
import {
  despawnEntityAt, kartById, spawnEntity, surgeActiveOn, updateEntities,
} from '../src/entity'
```

After:

```ts
import {
  despawnEntityAt, kartById, spawnEntity, surgeActiveOn, updateEntities,
} from '../src/entity'
import { targetSpeedFor } from '../src/kart'
```

**17b.** Append this suite to the end of the file:

```ts
describe('kart.ts wiring', () => {
  it('multiplies targetSpeedFor by tuning.surgeSpeedMul for a kart a surge is on', () => {
    const ctx = stubContext()
    const state = blankState()
    const events: AuthEvent[] = []
    // p2 leads on lap 2, p5 is second on lap 1, everyone else is level on
    // (0, 0, 0) and sorts by playerId: places are p2->0, p5->1, p0->2, ...
    state.karts[2].lap.lap = 2
    state.karts[5].lap.lap = 1
    const leader = state.karts[2] // characterIdx 0 -> speed 1.00, tarmac, no boost

    // no surge live yet:
    // maxSpeed 40 * speed 1.00 * accel 1 * surface 1 * surge 1 * boost 1 = 40
    expect(targetSpeedFor(ctx, state, leader, 1)).toBe(40)

    spawnEntity(state, 'surge', 5, { x: 0, y: 0, z: 0 }, 0, -1, 300, events)

    // p2 is placed ahead of the caster p5, so the surge is on it:
    // 40 * 1.00 * 1 * 1 * 0.7 * 1, evaluated left to right, is exactly 28 in
    // float64 (the exact product sits half an ulp below 28 and ties to even).
    expect(targetSpeedFor(ctx, state, leader, 1)).toBe(28)
    // the caster is never slowed by its own field
    expect(targetSpeedFor(ctx, state, state.karts[5], 1)).toBe(40)
  })

  it('leaves a kart placed behind the surge caster at full speed', () => {
    const ctx = stubContext()
    const state = blankState()
    const events: AuthEvent[] = []
    // Same field as above: p2 (lap 2) -> place 0, p5 (lap 1) -> place 1, and
    // everyone else is level on (0, 0, 0) and sorts by playerId, so p0 -> place 2.
    state.karts[2].lap.lap = 2
    state.karts[5].lap.lap = 1
    const behind = state.karts[0] // place 2: one place BEHIND the caster p5
    // characterIdx 0 -> speed 1.00, surface tarmac -> 1, boostTicks 0 -> 1

    expect(targetSpeedFor(ctx, state, behind, 1)).toBe(40)

    spawnEntity(state, 'surge', 5, { x: 0, y: 0, z: 0 }, 0, -1, 300, events)

    // A surge slows only the karts placed AHEAD of its caster, so p0's factor
    // stays 1 and its target speed does not move:
    //   40 * 1.00 * 1 (accel) * 1 (surface) * 1 (surge) * 1 (boost) = 40
    // Under the staged rule Task 6 wrote -- "any live surge this kart does not
    // own" -- p0 would take the field too:
    //   40 * 1.00 * 1 * 1 * 0.7 * 1 = 28
    // so this one expectation is the whole difference between the two rules.
    // The test above cannot see it: p2 is ahead of p5, where both say 28.
    expect(targetSpeedFor(ctx, state, behind, 1)).toBe(40)
    expect(surgeActiveOn(state, 0)).toBe(false)
  })
})
```

- [ ] **Step 18: Run the `kart.ts` wiring test to verify it fails**

Run: `npx vitest run packages/sim/test/entity.test.ts -t "kart.ts wiring"`

Expected: **1 passed, 1 failed.**

- `multiplies targetSpeedFor by tuning.surgeSpeedMul for a kart a surge is on`
  **passes already**, and that is not a mistake in it. Its subject p2 is ahead of
  the caster p5, and Task 6's staged rule ("any live surge this kart does not
  own") and the contract's rule ("a live surge owned by a kart ahead") agree on
  that kart: both give `28`, and both leave the caster at `40`.
- `leaves a kart placed behind the surge caster at full speed` **fails** with
  `AssertionError: expected 28 to be 40`, on the second `targetSpeedFor` call.
  Task 6's rule slows p0 because p0 does not own the surge; the contract's rule
  does not, because the caster p5 is ahead of p0. Step 19 is what fixes it.

If instead **both** tests pass here, `surgeFactorFor` has already been replaced
and Step 19 has nothing to do; if both fail, `surgeActiveOn` or `computePlacement`
is wrong, not the wiring — go back to Step 15.

- [ ] **Step 19: Wire `surgeActiveOn` into `targetSpeedFor`**

Two edits in `packages/sim/src/kart.ts`. There is **no `void state` line to
delete** — Task 6's `targetSpeedFor` never had one, because `surgeFactorFor` has
read `state` since Task 6.

**19a.** Add the import. Before (the `./mathutil` line of the import block, as
Task 6 wrote it — it is still a single unique line after Task 8 and Task 9 each
inserted their own import beneath it):

```ts
import { clamp, wrapAngle } from './mathutil'
```

After:

```ts
import { clamp, wrapAngle } from './mathutil'
import { surgeActiveOn } from './entity'
```

(`entity.ts` imports `./types`, `./mathutil`, `./state`, `./recovery` and
`./placement`, and none of those imports `./kart`, so this introduces no cycle.)

**19b.** Replace the body of `surgeFactorFor` with the contract's rule. This is
the module-level helper Task 6's Step 3 wrote directly above `targetSpeedFor`;
its doc comment goes with it, because the comment is the instruction being
carried out. Before:

```ts
/**
 * The Surge item's field-wide slow, as a multiplier on the target speed.
 *
 * A surge is a live world entity, and no entity can exist before Task 12 creates
 * `entity.ts` — `state.entityCount` is 0 for the whole of Tasks 6-11 — so this
 * returns 1 today. It is still real code rather than a literal, because `state`
 * is a parameter of `targetSpeedFor` and something has to read it.
 *
 * Task 12 replaces this entire body with the placement-aware rule it owns:
 *
 *   return surgeActiveOn(state, k.playerId) ? t.surgeSpeedMul : 1
 *
 * which narrows "any live surge this kart does not own" to "a live surge owned by
 * a kart ahead of this one". That needs computePlacement, which does not exist
 * yet. The call site in targetSpeedFor does not change.
 */
function surgeFactorFor(state: SimState, k: KartState, t: Tuning): number {
  for (let i = 0; i < state.entityCount; i++) {
    const e = state.entities[i]
    if (e.kind !== 'surge') continue
    if (e.ownerId === k.playerId) continue
    return t.surgeSpeedMul
  }
  return 1
}
```

After:

```ts
/**
 * The Surge item's field-wide slow, as a multiplier on the target speed.
 *
 * The rule is the contract's, and surgeActiveOn (Task 12, entity.ts) owns it: a
 * live surge slows every kart placed AHEAD of the kart that cast it, and never
 * the caster itself. Placement is read live from computePlacement, so a kart that
 * drops behind the caster stops being slowed on the next tick.
 *
 * This replaced Task 6's staged rule, "any live surge this kart does not own",
 * which slowed the whole field except the caster.
 */
function surgeFactorFor(state: SimState, k: KartState, t: Tuning): number {
  return surgeActiveOn(state, k.playerId) ? t.surgeSpeedMul : 1
}
```

The signature is unchanged, so the call site in `targetSpeedFor` —
`const surgeFactor = surgeFactorFor(state, k, t)` — is untouched, and all three
parameters are still read, so `noUnusedParameters` stays satisfied. This edit is
also what gives 19a's `surgeActiveOn` import its only consumer; without it
`tsc --noEmit` in Step 25 fails with
`TS6133: 'surgeActiveOn' is declared but its value is never read`.

Nothing else in `kart.ts` changes: the surrounding `surfaceFactor` (Task 9) and
`boostFactor` (Task 6) lines and the return expression's multiplication order are
part of the locked contract and must stay exactly as they are.

- [ ] **Step 20: Run the `kart.ts` wiring test to verify it passes**

Run: `npx vitest run packages/sim/test/entity.test.ts && npx vitest run packages/sim/test/kart.test.ts`
Expected: PASS — 26 tests in `entity.test.ts` (24 after Step 16, plus the two in
Step 17b), and every Task 6 kart test still green: they run states with no
entities at all, so `surgeActiveOn` returns `false` on its first loop and the
factor is still `1`.

- [ ] **Step 21: Write the failing test for the `step()` wiring**

`updateEntities` is the once-per-tick pass the contract orders
`resolveKartCollisions → updateEntities → updateItemBoxes → updatePhase`, and
`step()` does not call it yet — so in the live sim no projectile moves, expires or
ever strikes anyone. Three edits to `packages/sim/test/entity.test.ts`.

**21a.** Change the type-only import at the top of the file. Before:

```ts
import type {
  AuthEvent, EntityState, KartState, SimContext, SimState, Track, TrackQuery,
} from '../src/types'
```

After:

```ts
import type {
  AuthEvent, EntityState, Intent, KartState, SimContext, SimState, Track, TrackQuery,
} from '../src/types'
```

**21b.** Add the `step` import directly below the `kart.ts` import. Before:

```ts
import { targetSpeedFor } from '../src/kart'
```

After:

```ts
import { targetSpeedFor } from '../src/kart'
import { step } from '../src/step'
```

**21c.** Append this suite to the end of the file:

```ts
describe('step() wiring', () => {
  it('runs updateEntities once per tick, after the kart loop', () => {
    const ctx = stubContext()
    const prev = blankState()
    const next = blankState()
    prev.tick = 700
    prev.phase = 'racing'

    // The victim sits at the origin; every other kart stays parked at
    // x = 1000 + 10 * playerId, so nothing else is in reach and no kart-vs-kart
    // contact fires either.
    const victim = prev.karts[1]
    victim.position.x = 0
    victim.position.y = 0
    victim.position.z = 0
    // slick reach = 1.2 + kartRadius 0.9 = 2.1, and it sits 1.5 m away
    const spawnEvents: AuthEvent[] = []
    spawnEntity(prev, 'slick', 0, { x: 1.5, y: 0, z: 0 }, 0, -1, 600, spawnEvents)
    prev.nextEventSeq = 0 // renumber from 0: the spawn event is not under test

    const inputs: Intent[] = []
    for (let i = 0; i < MAX_KARTS; i++) {
      inputs.push({
        tick: 700, steer: 0, accel: 0, brake: false, drift: false, useItem: false,
      })
    }
    const events: AuthEvent[] = []

    step(ctx, prev, next, inputs, events)

    expect(next.tick).toBe(701)
    // every kart is at rest with accel 0, so nobody moves and the slick is
    // still 1.5 m from the victim when updateEntities runs
    expect(next.karts[1].spinOutTicks).toBe(60) // tuning.spinOutTicks
    expect(next.entities[0].ttl).toBe(599) // 600 - 1: the ttl pass ran too
    expect(events.length).toBe(2)
    expect(events[0].kind).toBe('hit')
    expect(events[0].playerId).toBe(1)
    expect(events[0].eventSeq).toBe(0)
    // updateEntities runs against `next`, whose tick is already prev.tick + 1
    expect(events[0].tick).toBe(701)
    expect(events[1].kind).toBe('spinOut')
    expect(events[1].playerId).toBe(1)

    // step never mutates prev
    expect(prev.karts[1].spinOutTicks).toBe(0)
    expect(prev.entities[0].ttl).toBe(600)
    expect(prev.tick).toBe(700)
  })
})
```

- [ ] **Step 22: Run the `step()` wiring test to verify it fails**

Run: `npx vitest run packages/sim/test/entity.test.ts -t "step() wiring"`
Expected: FAIL with `expected 0 to be 60` — `step()` never calls `updateEntities`,
so the slick neither strikes the victim nor counts down.

- [ ] **Step 23: Wire `updateEntities` into `step()`**

Two edits in `packages/sim/src/step.ts`.

**23a.** Add the import. Before (the `./collision` import Task 10 added):

```ts
import { resolveKartCollisions } from './collision'
```

After:

```ts
import { resolveKartCollisions } from './collision'
import { updateEntities } from './entity'
```

**23b.** Add the call to the once-per-tick section that follows the per-kart
`for` loop. `resolveKartCollisions(ctx, next)` is the only call to that function
in the file (Task 10 put it there). Before:

```ts
  resolveKartCollisions(ctx, next)
```

After:

```ts
  resolveKartCollisions(ctx, next)
  updateEntities(ctx, next, events)
```

The order is fixed by the contract: collisions settle the karts' final positions
for the tick, and only then are projectiles moved and tested against them, so a
kart can never be struck at a position it does not end the tick at. Task 13
inserts `updateItemBoxes` immediately after this line, and Task 15 `updatePhase`
after that.

- [ ] **Step 24: Run the `step()` wiring test to verify it passes**

Run: `npx vitest run packages/sim/test/entity.test.ts`
Expected: PASS, 27 tests (26 after Step 20, plus the one in Step 21c).

- [ ] **Step 25: Typecheck and run the whole sim suite**

Run: `npx tsc --noEmit -p packages/sim && npx vitest run packages/sim`
Expected: no TypeScript output, and every existing sim test still passes alongside the 27 in `entity.test.ts`.

- [ ] **Step 26: Commit**

```bash
git add packages/sim/src/entity.ts packages/sim/src/kart.ts packages/sim/src/step.ts \
        packages/sim/test/entity.test.ts
git commit -m "feat(sim): world entity pool, per-kind update and entity/kart hits

Fixed 32-slot pool with live entities packed at the front, swap-remove
on despawn, and vacated slots cleared to entityId -1. A spawn into a
full pool is dropped, returning -1 and emitting nothing, per the
contract's overflow policy.

Per kind: a seeker homes toward targetId at a capped turn rate, a bolt
flies straight and reflects off the track edge about the tangent, a
slick sits still, a bubble orbits its owner, and surge and charge are
timed fields. TTL counts down every tick and despawns at zero.

Entities strike karts within radius + kartRadius, emitting hit and then
routing the spin-out through recovery.ts's startSpinOut, the contract's
sole writer of spinOutTicks; a shielded kart eats the hit instead and
loses its bubble.

step() now calls updateEntities right after resolveKartCollisions, and
kart.ts's staged surgeFactorFor body is replaced with surgeActiveOn, so
a surge slows the karts ahead of its caster instead of the whole field."
```
