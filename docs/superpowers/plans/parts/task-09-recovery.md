### Task 9: Recovery — spin-out, respawn, surface speed penalty

**Files:**
- Create: `packages/sim/src/recovery.ts`
- Test: `packages/sim/test/recovery.test.ts`
- Modify: `packages/sim/src/kart.ts` (four edits — the import line, the `surfaceFactor`
  literal inside `targetSpeedFor`, and the motion and steering locks inside `stepKart`;
  exact before/after in Step 20)
- Modify: `packages/sim/test/kart.test.ts` (append one describe block; exact code in Step 18)
- Modify: `packages/sim/src/step.ts` (three edits — the import line, the slot-2 call in
  the per-kart loop, and the now-dead `void events`; exact before/after in Step 24)
- Modify: `packages/sim/test/step.test.ts` (append one describe block; exact code in Step 22)

**Interfaces:**

- Consumes (all fixed by the locked contract, all authored by earlier tasks):
  - `packages/sim/src/types.ts` [Task 2] — `TICK_DT` (`= 1/60`), `MAX_KARTS` (`= 8`),
    `MAX_ENTITIES` (`= 32`), and the types `AuthEvent`, `EntityState`, `KartState`,
    `SimContext`, `SimState`, `Surface`, `Track`, `TrackPoint`, `TrackProjection`,
    `TrackQuery`, `Tuning`, `Vec3`.
  - `packages/sim/src/mathutil.ts` [Task 2] — `lerp(a: number, b: number, t: number): number`,
    `wrapAngle(a: number): number` (returns a value in `(-PI, PI]`).
  - `packages/sim/src/state.ts` [Task 5] —
    `emit(state: SimState, out: AuthEvent[], kind: AuthEventKind, playerId: number,
    entityId: number, item: ItemKind, data: number): void`, and
    `createState(ctx: SimContext, seed: number, characterIdx: number[]): SimState`
    (used only by this task's `step()` tests).
  - `packages/sim/src/kart.ts` [Task 6] —
    `stepKart(ctx: SimContext, state: SimState, prevKart: KartState, k: KartState, raw: Intent): void`
    and `targetSpeedFor(ctx: SimContext, state: SimState, k: KartState, accel: number): number`.
    This task edits both: `stepKart` gains the two recovery locks, `targetSpeedFor`'s
    documented `const surfaceFactor = 1` stub becomes `surfaceSpeedFactor(k, t)`.
  - `packages/sim/src/step.ts` [Task 5, extended by 6–8] — the per-kart loop, whose
    body after Tasks 6, 7 and 8 contains `const k`, `const prevKart`, `const raw`,
    `updateDrift(ctx, k, raw)` and `stepKart(ctx, next, prevKart, k, raw)`. This task
    inserts canonical slot 2 immediately above `updateDrift`.
  - `packages/sim/test/fixtures/track-fixtures.ts` [Task 3] —
    `makeTuning(overrides?: Partial<Tuning>): Tuning`,
    `makeCharacters(): CharacterStats[]`,
    `makeStraightTrack(overrides?: Partial<Track>): Track`.
  - `packages/sim/test/helpers/flat-context.ts` [Task 5, extended by Task 6] —
    `makeTestContext(startPositions)`, `EIGHT_STARTS`, `makeKart(over?)`, `makeIntent(over?)`.
  - From `SimContext.query` (a `TrackQuery`, built in Task 4): `sampleAt(s)`,
    `tangentAt(s)`, `project(p)`, `groundHeight(s, lateral)`, `isInBounds(s, lateral)`.
  - Contract §0: **`s` is always arc-normalised to `[0, 1)`**, never metres. Metres are
    reached only by multiplying an `s`-delta by `query.totalLength()`. Every `s` this
    task passes to or receives from the query obeys that, including the test stub.
  - Contract §0: `right = (-t.z, 0, t.x)`, so on a track whose tangent is `(1, 0, 0)`
    **positive `lateral` is toward `+z`**.

- Produces (exact names and signatures later tasks rely on):
  - `export function steeringLocked(k: KartState): boolean`
    — `true` while `k.spinOutTicks > 0 || k.respawnTicks > 0`. Step 20 of this task is
    what makes `stepKart` read it: `const steer = steeringLocked(k) ? 0 : raw.steer`.
  - `export function motionLocked(k: KartState): boolean`
    — `true` while `k.respawnTicks > 0`. This name is **not** in the contract's module
    map; it is new, defined here, because `updateRecovery` runs at slot 2 of the
    canonical per-kart order while the integrator runs at slot 4, and the integrator
    must not overwrite the respawn interpolation. Step 20 of this task is what makes
    `stepKart` return early — past the traction block *and* past the horizontal
    position integration — when it is `true`.
  - `export function surfaceSpeedFactor(k: KartState, t: Tuning): number`
    — `t.offtrackSpeedMul` when `k.surface === 'offtrack'`, otherwise `1`. This is the
    off-track term of the `targetSpeedFor` product owned by Task 6, and Step 20 of this
    task is what replaces Task 6's documented `const surfaceFactor = 1` stub with it.
  - `export function updateRecovery(ctx: SimContext, state: SimState, k: KartState,
    events: AuthEvent[]): void`
    — slot 2 of the canonical per-kart order inside `step()`. Step 24 of this task is
    what adds that call site, per contract §0: the task that introduces a function also
    adds its call site in `step.ts`, with its own failing test.
  - `export function startSpinOut(state: SimState, k: KartState, ticks: number,
    events: AuthEvent[]): void`
    — new, defined here. The single entry point Tasks 12 and 13 call to put a kart into
    a spin-out; it is what emits the `'spinOut'` `AuthEvent` and what enforces
    invulnerability.
    **Contract §0 makes `startSpinOut` the sole writer of `spinOutTicks`: no module
    other than `recovery.ts` may assign that field.** Inside `recovery.ts` there are
    exactly two further writes, and both only ever spend or cancel a spin-out that
    `startSpinOut` already started: `updateRecovery` does `k.spinOutTicks -= 1` while
    the timer runs, and `beginRespawn` does `k.spinOutTicks = 0` because a respawn
    supersedes a spin. There is no third write anywhere in the package — Task 12 in
    particular must call `startSpinOut` rather than assigning the field itself.
  - `export const SPIN_YAW_RATE: number` — `4 * Math.PI` rad/s.
  - `export const SPIN_SPEED_DECAY: number` — `0.94`, per-tick horizontal speed retention.
  - Edits to `packages/sim/src/kart.ts` (Step 20) and `packages/sim/src/step.ts`
    (Step 24). After this task the assembled tick runs
    `updateRecovery → updateDrift → stepKart → applyAirYaw → integrateVertical →
    applyRamps → applyBoostPad → decayBoost` per kart, and Task 13 anchors its
    `useItem` insertion on the `updateRecovery` / `updateDrift` pair this task writes.

---

- [ ] **Step 1: Write the failing test — predicates**

Create `packages/sim/test/recovery.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type {
  EntityState, KartState, SimContext, SimState, TrackPoint, TrackProjection,
  TrackQuery, Tuning, Vec3,
} from '../src/types'
import { MAX_ENTITIES, MAX_KARTS } from '../src/types'
import { makeCharacters, makeStraightTrack, makeTuning } from './fixtures/track-fixtures'
import { motionLocked, steeringLocked, surfaceSpeedFactor } from '../src/recovery'

// A hand-built TrackQuery so every number in this file is exact and owned by the
// test. The centreline is a straight line along +X at y = 0, z = 0, and one lap is
// TRACK_LENGTH metres long.
//
// Contract §0: `s` is ALWAYS arc-normalised to [0, 1) — never metres. Metres are
// reached only by multiplying an s-delta by totalLength(). So sampleAt converts
// s -> metres with `s * TRACK_LENGTH` and project() converts back. TRACK_LENGTH is
// 400 and every checkpoint sits on a quarter, so every s in this file (0, 0.25,
// 0.5, 0.75) converts to a metre value that is exact in binary floating point.
//
// Contract §0 also fixes right = (-t.z, 0, t.x). With tangent (1, 0, 0) that is
// (0, 0, 1), so positive `lateral` is toward +z: project() returns `p.z` unnegated.
const TRACK_LENGTH = 400

function wrap01(v: number): number {
  const f = v - Math.floor(v)
  return f < 0 ? f + 1 : f
}

function stubQuery(): TrackQuery {
  return {
    sampleAt(s: number): TrackPoint {
      return {
        position: { x: s * TRACK_LENGTH, y: 0, z: 0 },
        width: 10,
        banking: 0,
        surface: 'tarmac',
      }
    },
    tangentAt(): Vec3 {
      return { x: 1, y: 0, z: 0 }
    },
    project(p: Vec3): TrackProjection {
      return { s: wrap01(p.x / TRACK_LENGTH), lateral: p.z, distance: Math.abs(p.z) }
    },
    groundHeight(): number {
      return 0
    },
    surfaceAt(_s: number, lateral: number) {
      return Math.abs(lateral) <= 5 ? 'tarmac' : 'offtrack'
    },
    isInBounds(_s: number, lateral: number): boolean {
      return Math.abs(lateral) <= 5
    },
    checkpointIndexAt(s: number): number {
      return s < 0.25 ? 0 : s < 0.5 ? 1 : s < 0.75 ? 2 : 3
    },
    totalLength(): number {
      return TRACK_LENGTH
    },
  }
}

function makeCtx(overrides?: Partial<Tuning>): SimContext {
  return {
    // Four checkpoints, arc-normalised: 0 m, 100 m, 200 m, 300 m along the stub.
    track: makeStraightTrack({ checkpointS: [0, 0.25, 0.5, 0.75] }),
    query: stubQuery(),
    tuning: makeTuning(overrides),
    characters: makeCharacters(),
    isLeader: true,
  }
}

// A deliberately local kart builder: this file's karts are addressed by playerId
// and every field is written explicitly, so it does not import Task 6's shared
// `makeKart(over?)`. `checkpointIdx` starts at 3 because that is what createState
// produces — contract §0 fixes the initial lap as
// `{ lap: 0, checkpointIdx: track.checkpointS.length - 1, t: 0 }`, and this file's
// track has four checkpoints. Tests that care set it explicitly anyway.
function makeKart(playerId: number): KartState {
  return {
    playerId,
    characterIdx: 0,
    isBot: false,
    connected: true,
    position: { x: 0, y: 0, z: 0 },
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
    lap: { lap: 0, checkpointIdx: 3, t: 0 },
  }
}

function makeSimState(): SimState {
  const karts: KartState[] = []
  for (let i = 0; i < MAX_KARTS; i++) karts.push(makeKart(i))
  const entities: EntityState[] = []
  for (let i = 0; i < MAX_ENTITIES; i++) {
    entities.push({
      entityId: -1,
      kind: 'seeker',
      ownerId: -1,
      position: { x: 0, y: 0, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
      heading: 0,
      targetId: -1,
      ttl: 0,
    })
  }
  return {
    tick: 0,
    phase: 'racing',
    raceSeed: 1,
    rngCursor: 0,
    nextEventSeq: 0,
    finishTick: -1,
    karts,
    entities,
    entityCount: 0,
    nextEntityId: 1,
    itemBoxes: [],
    // Contract §0: finishedOrder is fixed length MAX_KARTS, unused slots hold -1.
    finishedOrder: new Array<number>(MAX_KARTS).fill(-1),
  }
}

describe('recovery predicates', () => {
  it('locks steering while spinning out or respawning, and only then', () => {
    const k = makeKart(0)
    expect(steeringLocked(k)).toBe(false)

    k.spinOutTicks = 1
    expect(steeringLocked(k)).toBe(true)

    k.spinOutTicks = 0
    k.respawnTicks = 1
    expect(steeringLocked(k)).toBe(true)

    k.spinOutTicks = 12
    expect(steeringLocked(k)).toBe(true)

    k.spinOutTicks = 0
    k.respawnTicks = 0
    expect(steeringLocked(k)).toBe(false)
  })

  it('locks motion only while respawning', () => {
    const k = makeKart(0)
    expect(motionLocked(k)).toBe(false)

    // A spinning kart still slides; only a respawning kart is teleport-driven.
    k.spinOutTicks = 60
    expect(motionLocked(k)).toBe(false)

    k.respawnTicks = 1
    expect(motionLocked(k)).toBe(true)
  })

  it('applies the off-track speed multiplier and nothing else', () => {
    const t = makeTuning()
    // Contract fixture: offtrackSpeedMul = 0.55
    expect(t.offtrackSpeedMul).toBe(0.55)

    const k = makeKart(0)

    k.surface = 'tarmac'
    expect(surfaceSpeedFactor(k, t)).toBe(1)

    k.surface = 'dirt'
    expect(surfaceSpeedFactor(k, t)).toBe(1)

    k.surface = 'boost'
    expect(surfaceSpeedFactor(k, t)).toBe(1)

    k.surface = 'offtrack'
    expect(surfaceSpeedFactor(k, t)).toBe(0.55)
  })

  it('honours an overridden off-track multiplier', () => {
    const t = makeTuning({ offtrackSpeedMul: 0.25 })
    const k = makeKart(0)
    k.surface = 'offtrack'
    expect(surfaceSpeedFactor(k, t)).toBe(0.25)
  })

  it('builds a context whose tuning matches the locked fixture values', () => {
    const ctx = makeCtx()
    expect(ctx.tuning.respawnTicks).toBe(72)
    expect(ctx.tuning.invulnTicks).toBe(90)
    expect(ctx.tuning.spinOutTicks).toBe(60)
    expect(makeSimState().karts.length).toBe(MAX_KARTS)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/sim/test/recovery.test.ts -t "recovery predicates"`
Expected: FAIL with `Failed to resolve import "../src/recovery"` — the module does not exist yet.

- [ ] **Step 3: Write minimal implementation — predicates**

Create `packages/sim/src/recovery.ts`:

```ts
import type { KartState, Tuning } from './types'

/**
 * Yaw rate, rad/s, forced on a kart while `spinOutTicks > 0`.
 * 4*PI rad/s is exactly two visible full turns per second of spin-out.
 */
export const SPIN_YAW_RATE = 4 * Math.PI

/** Per-tick multiplicative retention of horizontal speed while spinning out. */
export const SPIN_SPEED_DECAY = 0.94

/**
 * True while the kart has no steering authority: the whole spin-out, and the
 * whole respawn interpolation. Task 6's `stepKart` reads the steer axis as 0
 * when this is true.
 */
export function steeringLocked(k: KartState): boolean {
  return k.spinOutTicks > 0 || k.respawnTicks > 0
}

/**
 * True while position and velocity are owned by `updateRecovery` and must not
 * be integrated by anything else this tick. A spinning kart still slides, so
 * only the respawn interpolation locks motion.
 */
export function motionLocked(k: KartState): boolean {
  return k.respawnTicks > 0
}

/**
 * The off-track term of the `targetSpeedFor` product (Task 6 owns the product).
 */
export function surfaceSpeedFactor(k: KartState, t: Tuning): number {
  return k.surface === 'offtrack' ? t.offtrackSpeedMul : 1
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/sim/test/recovery.test.ts -t "recovery predicates"`
Expected: PASS — 5 tests.

---

- [ ] **Step 5: Write the failing test — respawn**

In `packages/sim/test/recovery.test.ts`, change the import of `../src/recovery`.

Before:

```ts
import { motionLocked, steeringLocked, surfaceSpeedFactor } from '../src/recovery'
```

After:

```ts
import {
  motionLocked, steeringLocked, surfaceSpeedFactor, updateRecovery,
} from '../src/recovery'
```

Then append this block to the end of the file:

```ts
describe('respawn', () => {
  // Track fixture: checkpointS = [0, 0.25, 0.5, 0.75], arc-normalised. The stub
  // centreline is (s * 400, 0, 0) with tangent (1, 0, 0), so checkpoint 1 sits at
  // (100, 0, 0) facing heading 0, and checkpoint 3 sits at (300, 0, 0).
  function outOfBoundsKart(state: SimState): KartState {
    const k = state.karts[0]
    k.position.x = 10
    k.position.y = 0
    k.position.z = 50 // lateral = +z = 50, |lateral| > 5 -> out of bounds
    k.velocity.x = 12
    k.velocity.y = 0
    k.velocity.z = 3
    k.heading = 1
    k.angularVelocity = 0.4
    k.drift.active = true
    k.drift.dir = 1
    k.drift.charge = 55
    k.boostTicks = 9
    k.airborne = true
    k.lap.checkpointIdx = 1
    return k
  }

  it('starts a respawn on the tick the kart leaves the bounds', () => {
    const ctx = makeCtx()
    const state = makeSimState()
    const k = outOfBoundsKart(state)
    const events: AuthEvent[] = []

    updateRecovery(ctx, state, k, events)

    // Detection tick arms the timer; it does not move the kart yet.
    expect(k.respawnTicks).toBe(72) // tuning.respawnTicks
    expect(k.position.x).toBe(10)
    expect(k.position.z).toBe(50)
    // and it freezes the kart
    expect(k.velocity.x).toBe(0)
    expect(k.velocity.y).toBe(0)
    expect(k.velocity.z).toBe(0)
    expect(k.angularVelocity).toBe(0)
    expect(k.airborne).toBe(false)
    expect(k.drift.active).toBe(false)
    expect(k.drift.dir).toBe(0)
    expect(k.drift.charge).toBe(0)
    expect(k.boostTicks).toBe(0)
    expect(k.invulnTicks).toBe(0) // invulnerability is granted on arrival, not on departure

    expect(events.length).toBe(1)
    expect(events[0].kind).toBe('respawn')
    expect(events[0].playerId).toBe(0)
    expect(events[0].entityId).toBe(-1)
    expect(events[0].item).toBe('none')
    expect(events[0].data).toBe(72)
    expect(events[0].eventSeq).toBe(0)
    expect(state.nextEventSeq).toBe(1)
  })

  it('interpolates linearly toward the last checkpoint', () => {
    const ctx = makeCtx()
    const state = makeSimState()
    const k = outOfBoundsKart(state)
    const events: AuthEvent[] = []

    // Call 1 arms the timer at 72. Calls 2..37 are 36 interpolation ticks.
    for (let i = 0; i < 37; i++) updateRecovery(ctx, state, k, events)

    expect(k.respawnTicks).toBe(36) // 72 - 36

    // Each tick moves 1/remaining of the way, so after n of R ticks the remaining
    // fraction is (R - n)/R: after 36 of 72 the kart is exactly half way.
    // Target is checkpoint 1: s = 0.25 -> x = 0.25 * 400 = 100.
    //   x: 10 + 0.5 * (100 - 10) = 55
    //   z: 50 + 0.5 * (0   - 50) = 25
    //   heading: 1 + 0.5 * (0 - 1) = 0.5
    // Not bit-exact because each tick rounds a separate 1/R multiply.
    expect(k.position.x).toBeCloseTo(55, 9)
    expect(k.position.y).toBeCloseTo(0, 12)
    expect(k.position.z).toBeCloseTo(25, 9)
    expect(k.heading).toBeCloseTo(0.5, 9)

    expect(steeringLocked(k)).toBe(true)
    expect(motionLocked(k)).toBe(true)
    expect(events.length).toBe(1) // still only the one respawn event
  })

  it('lands exactly on the checkpoint and grants invulnerability', () => {
    const ctx = makeCtx()
    const state = makeSimState()
    const k = outOfBoundsKart(state)
    const events: AuthEvent[] = []

    // 1 detection tick + 72 interpolation ticks = 73 calls.
    for (let i = 0; i < 73; i++) updateRecovery(ctx, state, k, events)

    expect(k.respawnTicks).toBe(0)
    // checkpointS[1] = 0.25 -> 0.25 * 400 = 100, snapped exactly on the last tick
    expect(k.position.x).toBe(100)
    expect(k.position.y).toBe(0)
    expect(k.position.z).toBe(0)
    expect(k.heading).toBe(0) // atan2(0, 1) == 0
    expect(k.invulnTicks).toBe(90) // tuning.invulnTicks
    expect(steeringLocked(k)).toBe(false)
    expect(motionLocked(k)).toBe(false)
    expect(events.length).toBe(1)
  })

  it('ticks invulnerability down once the kart is back in bounds', () => {
    const ctx = makeCtx()
    const state = makeSimState()
    const k = outOfBoundsKart(state)
    const events: AuthEvent[] = []

    // 73 calls to complete the respawn, then 7 more free-running ticks.
    for (let i = 0; i < 80; i++) updateRecovery(ctx, state, k, events)

    expect(k.invulnTicks).toBe(83) // 90 granted on call 73, minus 7 decrements
    expect(k.respawnTicks).toBe(0)
    // (100, 0, 0) projects to lateral 0, which is in bounds: no second respawn
    expect(events.length).toBe(1)
  })

  it('uses the previous checkpoint when checkpointIdx is -1', () => {
    const ctx = makeCtx()
    const state = makeSimState()
    const k = outOfBoundsKart(state)
    k.lap.checkpointIdx = -1 // wraps to index 3 of [0, 0.25, 0.5, 0.75]
    const events: AuthEvent[] = []

    for (let i = 0; i < 73; i++) updateRecovery(ctx, state, k, events)

    expect(k.position.x).toBe(300) // 0.75 * 400
    expect(k.position.z).toBe(0)
  })

  it('teleports immediately when respawnTicks is tuned to 0', () => {
    const ctx = makeCtx({ respawnTicks: 0 })
    const state = makeSimState()
    const k = outOfBoundsKart(state)
    const events: AuthEvent[] = []

    updateRecovery(ctx, state, k, events)

    expect(k.respawnTicks).toBe(0)
    expect(k.position.x).toBe(100) // 0.25 * 400
    expect(k.position.z).toBe(0)
    expect(k.invulnTicks).toBe(90)
    expect(events.length).toBe(1)
    expect(events[0].data).toBe(0)

    updateRecovery(ctx, state, k, events)
    expect(events.length).toBe(1) // in bounds now, no repeat
    expect(k.invulnTicks).toBe(89)
  })

  it('does not respawn a kart that is inside the bounds', () => {
    const ctx = makeCtx()
    const state = makeSimState()
    const k = state.karts[0]
    k.position.x = 10
    k.position.z = 2 // lateral = +2, inside |lateral| <= 5
    k.velocity.x = 12
    const events: AuthEvent[] = []

    for (let i = 0; i < 10; i++) updateRecovery(ctx, state, k, events)

    expect(k.respawnTicks).toBe(0)
    expect(k.position.x).toBe(10)
    expect(k.velocity.x).toBe(12)
    expect(events.length).toBe(0)
  })
})
```

Also add `AuthEvent` to the type-only import at the top of the file.

Before:

```ts
import type {
  EntityState, KartState, SimContext, SimState, TrackPoint, TrackProjection,
  TrackQuery, Tuning, Vec3,
} from '../src/types'
```

After:

```ts
import type {
  AuthEvent, EntityState, KartState, SimContext, SimState, TrackPoint,
  TrackProjection, TrackQuery, Tuning, Vec3,
} from '../src/types'
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run packages/sim/test/recovery.test.ts -t "respawn"`
Expected: FAIL with `updateRecovery is not a function` (the export does not exist yet).

- [ ] **Step 7: Write minimal implementation — respawn**

Replace the whole of `packages/sim/src/recovery.ts` with:

```ts
import type { AuthEvent, KartState, SimContext, SimState, Tuning, Vec3 } from './types'
import { lerp, wrapAngle } from './mathutil'
import { emit } from './state'

/**
 * Yaw rate, rad/s, forced on a kart while `spinOutTicks > 0`.
 * 4*PI rad/s is exactly two visible full turns per second of spin-out.
 */
export const SPIN_YAW_RATE = 4 * Math.PI

/** Per-tick multiplicative retention of horizontal speed while spinning out. */
export const SPIN_SPEED_DECAY = 0.94

/** Scratch respawn target. Module scope so the hot path never allocates. */
const TARGET: Vec3 = { x: 0, y: 0, z: 0 }

/**
 * True while the kart has no steering authority: the whole spin-out, and the
 * whole respawn interpolation. Task 6's `stepKart` reads the steer axis as 0
 * when this is true.
 */
export function steeringLocked(k: KartState): boolean {
  return k.spinOutTicks > 0 || k.respawnTicks > 0
}

/**
 * True while position and velocity are owned by `updateRecovery` and must not
 * be integrated by anything else this tick. A spinning kart still slides, so
 * only the respawn interpolation locks motion.
 */
export function motionLocked(k: KartState): boolean {
  return k.respawnTicks > 0
}

/**
 * The off-track term of the `targetSpeedFor` product (Task 6 owns the product).
 */
export function surfaceSpeedFactor(k: KartState, t: Tuning): number {
  return k.surface === 'offtrack' ? t.offtrackSpeedMul : 1
}

/**
 * Slot 2 of the canonical per-kart order inside `step()`.
 *
 * - A kart already respawning is interpolated one tick toward its checkpoint and
 *   nothing else happens to it.
 * - Otherwise invulnerability decays, then a live spin-out is advanced, then the
 *   kart is tested against the track bounds.
 */
export function updateRecovery(
  ctx: SimContext,
  state: SimState,
  k: KartState,
  events: AuthEvent[],
): void {
  const t = ctx.tuning

  if (k.respawnTicks > 0) {
    stepRespawn(ctx, k)
    if (k.respawnTicks === 0) k.invulnTicks = t.invulnTicks
    return
  }

  if (k.invulnTicks > 0) k.invulnTicks -= 1

  const proj = ctx.query.project(k.position)
  if (!ctx.query.isInBounds(proj.s, proj.lateral)) {
    beginRespawn(ctx, state, k, events)
  }
}

/**
 * Writes the last-crossed checkpoint's world position into TARGET and returns the
 * heading of the centreline there. `checkpointIdx` is wrapped, so -1 means "the
 * final checkpoint of the previous lap".
 */
function checkpointTarget(ctx: SimContext, k: KartState): number {
  const cps = ctx.track.checkpointS
  const n = cps.length
  let s = 0
  if (n > 0) {
    const idx = ((k.lap.checkpointIdx % n) + n) % n
    s = cps[idx]
  }
  const cp = ctx.query.sampleAt(s)
  TARGET.x = cp.position.x
  TARGET.y = ctx.query.groundHeight(s, 0)
  TARGET.z = cp.position.z
  const tan = ctx.query.tangentAt(s)
  return Math.atan2(tan.z, tan.x)
}

function snapToCheckpoint(ctx: SimContext, k: KartState): void {
  const h = checkpointTarget(ctx, k)
  k.position.x = TARGET.x
  k.position.y = TARGET.y
  k.position.z = TARGET.z
  k.heading = wrapAngle(h)
}

function beginRespawn(
  ctx: SimContext,
  state: SimState,
  k: KartState,
  events: AuthEvent[],
): void {
  const t = ctx.tuning
  k.spinOutTicks = 0
  k.boostTicks = 0
  k.invulnTicks = 0
  k.drift.active = false
  k.drift.dir = 0
  k.drift.charge = 0
  k.velocity.x = 0
  k.velocity.y = 0
  k.velocity.z = 0
  k.angularVelocity = 0
  k.airborne = false
  k.respawnTicks = t.respawnTicks > 0 ? t.respawnTicks : 0
  emit(state, events, 'respawn', k.playerId, -1, 'none', k.respawnTicks)
  if (k.respawnTicks === 0) {
    snapToCheckpoint(ctx, k)
    k.invulnTicks = t.invulnTicks
  }
}

/**
 * One tick of the respawn interpolation.
 *
 * The kart's departure point is never stored, because `KartState` has no field
 * for it. Instead each tick moves a fraction `1 / remaining` of the way to the
 * target, which is exactly a linear schedule: after n of R ticks the kart sits at
 * `p0 + (n / R) * (target - p0)`. The final tick assigns the target directly so
 * arrival is bit-exact rather than one rounding short.
 */
function stepRespawn(ctx: SimContext, k: KartState): void {
  k.velocity.x = 0
  k.velocity.y = 0
  k.velocity.z = 0
  k.angularVelocity = 0
  k.airborne = false
  k.boostTicks = 0
  k.drift.active = false
  k.drift.dir = 0
  k.drift.charge = 0

  if (k.respawnTicks <= 1) {
    snapToCheckpoint(ctx, k)
    k.respawnTicks = 0
    return
  }

  const h = checkpointTarget(ctx, k)
  const f = 1 / k.respawnTicks
  k.position.x = lerp(k.position.x, TARGET.x, f)
  k.position.y = lerp(k.position.y, TARGET.y, f)
  k.position.z = lerp(k.position.z, TARGET.z, f)
  k.heading = wrapAngle(k.heading + wrapAngle(h - k.heading) * f)
  k.respawnTicks -= 1
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npx vitest run packages/sim/test/recovery.test.ts -t "respawn"`
Expected: PASS — 7 tests.

---

- [ ] **Step 9: Write the failing test — spin-out**

In `packages/sim/test/recovery.test.ts`, change the import of `../src/recovery`.

Before:

```ts
import {
  motionLocked, steeringLocked, surfaceSpeedFactor, updateRecovery,
} from '../src/recovery'
```

After:

```ts
import {
  motionLocked, SPIN_SPEED_DECAY, SPIN_YAW_RATE, steeringLocked,
  surfaceSpeedFactor, updateRecovery,
} from '../src/recovery'
```

Then append this block to the end of the file:

```ts
describe('spin-out', () => {
  function spinningKart(state: SimState): KartState {
    const k = state.karts[0]
    k.position.x = 10
    k.position.y = 0
    k.position.z = 0 // lateral 0: firmly in bounds
    k.velocity.x = 20
    k.velocity.y = -5 // vertical component, must not be damped
    k.velocity.z = 0
    k.heading = 0
    k.drift.active = true
    k.drift.dir = -1
    k.drift.charge = 88
    k.boostTicks = 14
    k.spinOutTicks = 60 // tuning.spinOutTicks
    return k
  }

  it('exposes the spin constants the tuning table is written against', () => {
    // 4*PI rad/s over 60 ticks == 4*PI rad == exactly two full turns.
    expect(SPIN_YAW_RATE).toBeCloseTo(12.566370614359172, 12)
    expect(SPIN_SPEED_DECAY).toBe(0.94)
  })

  it('forces a visible yaw spin and decays horizontal speed each tick', () => {
    const ctx = makeCtx()
    const state = makeSimState()
    const k = spinningKart(state)
    const events: AuthEvent[] = []

    updateRecovery(ctx, state, k, events)

    expect(k.spinOutTicks).toBe(59)
    expect(k.angularVelocity).toBeCloseTo(12.566370614359172, 12) // 4*PI
    // heading advances SPIN_YAW_RATE * TICK_DT = 4*PI/60 = PI/15
    expect(k.heading).toBeCloseTo(0.20943951023931953, 12)
    // horizontal speed: 20 * 0.94 = 18.8
    expect(k.velocity.x).toBeCloseTo(18.8, 12)
    expect(k.velocity.z).toBeCloseTo(0, 12)
    // vertical speed is gravity's business, untouched
    expect(k.velocity.y).toBe(-5)
    // a spun kart cannot hold a drift charge or a boost
    expect(k.drift.active).toBe(false)
    expect(k.drift.dir).toBe(0)
    expect(k.drift.charge).toBe(0)
    expect(k.boostTicks).toBe(0)

    expect(steeringLocked(k)).toBe(true)
    expect(motionLocked(k)).toBe(false)
    expect(events.length).toBe(0)
  })

  it('runs down to zero over exactly tuning.spinOutTicks ticks', () => {
    const ctx = makeCtx()
    const state = makeSimState()
    const k = spinningKart(state)
    const events: AuthEvent[] = []

    for (let i = 0; i < 59; i++) updateRecovery(ctx, state, k, events)
    expect(k.spinOutTicks).toBe(1)
    expect(steeringLocked(k)).toBe(true)

    updateRecovery(ctx, state, k, events)
    expect(k.spinOutTicks).toBe(0)
    expect(steeringLocked(k)).toBe(false)

    // 20 * 0.94^60 = 0.48831... : the kart is very nearly stopped
    expect(k.velocity.x).toBeCloseTo(20 * Math.pow(0.94, 60), 12)
    expect(k.velocity.x).toBeGreaterThan(0.48)
    expect(k.velocity.x).toBeLessThan(0.49)

    // 60 ticks * 4*PI/60 = 4*PI == 0 mod 2*PI, and wrapAngle keeps it there
    expect(k.heading).toBeCloseTo(0, 9)
  })

  it('stops spinning the tick the kart finishes its spin-out', () => {
    const ctx = makeCtx()
    const state = makeSimState()
    const k = spinningKart(state)
    const events: AuthEvent[] = []

    for (let i = 0; i < 60; i++) updateRecovery(ctx, state, k, events)
    const restingX = k.velocity.x
    const restingHeading = k.heading

    updateRecovery(ctx, state, k, events)

    expect(k.velocity.x).toBe(restingX) // no further decay
    expect(k.heading).toBe(restingHeading) // no further yaw
    expect(k.angularVelocity).toBe(SPIN_YAW_RATE) // left as the spin set it
  })

  it('lets a respawn cancel and replace an in-flight spin-out', () => {
    const ctx = makeCtx()
    const state = makeSimState()
    const k = spinningKart(state)
    k.position.z = 50 // lateral = +50, out of bounds
    k.spinOutTicks = 30
    const events: AuthEvent[] = []

    updateRecovery(ctx, state, k, events)

    expect(k.spinOutTicks).toBe(0)
    expect(k.respawnTicks).toBe(72)
    expect(k.angularVelocity).toBe(0)
    expect(k.velocity.x).toBe(0)
    expect(k.velocity.y).toBe(0)
    expect(events.length).toBe(1)
    expect(events[0].kind).toBe('respawn')
  })

  it('does not spin a kart while it is respawning', () => {
    const ctx = makeCtx()
    const state = makeSimState()
    const k = state.karts[0]
    k.position.x = 10
    k.position.z = 0
    k.respawnTicks = 5
    k.spinOutTicks = 30
    k.lap.checkpointIdx = 1
    const events: AuthEvent[] = []

    updateRecovery(ctx, state, k, events)

    expect(k.respawnTicks).toBe(4)
    expect(k.spinOutTicks).toBe(30) // frozen, not advanced
    expect(k.angularVelocity).toBe(0)
  })
})
```

- [ ] **Step 10: Run test to verify it fails**

Run: `npx vitest run packages/sim/test/recovery.test.ts -t "spin-out"`
Expected: FAIL — "forces a visible yaw spin and decays horizontal speed each tick"
reports `expected 60 to be 59` for `k.spinOutTicks`; `updateRecovery` currently
ignores the spin-out timer entirely.

- [ ] **Step 11: Write minimal implementation — spin-out**

In `packages/sim/src/recovery.ts`, add `TICK_DT` to the value import.

Before:

```ts
import type { AuthEvent, KartState, SimContext, SimState, Tuning, Vec3 } from './types'
import { lerp, wrapAngle } from './mathutil'
import { emit } from './state'
```

After:

```ts
import type { AuthEvent, KartState, SimContext, SimState, Tuning, Vec3 } from './types'
import { TICK_DT } from './types'
import { lerp, wrapAngle } from './mathutil'
import { emit } from './state'
```

Then replace the whole `updateRecovery` function.

Before:

```ts
export function updateRecovery(
  ctx: SimContext,
  state: SimState,
  k: KartState,
  events: AuthEvent[],
): void {
  const t = ctx.tuning

  if (k.respawnTicks > 0) {
    stepRespawn(ctx, k)
    if (k.respawnTicks === 0) k.invulnTicks = t.invulnTicks
    return
  }

  if (k.invulnTicks > 0) k.invulnTicks -= 1

  const proj = ctx.query.project(k.position)
  if (!ctx.query.isInBounds(proj.s, proj.lateral)) {
    beginRespawn(ctx, state, k, events)
  }
}
```

After:

```ts
export function updateRecovery(
  ctx: SimContext,
  state: SimState,
  k: KartState,
  events: AuthEvent[],
): void {
  const t = ctx.tuning

  if (k.respawnTicks > 0) {
    stepRespawn(ctx, k)
    if (k.respawnTicks === 0) k.invulnTicks = t.invulnTicks
    return
  }

  if (k.invulnTicks > 0) k.invulnTicks -= 1

  if (k.spinOutTicks > 0) {
    // Steering is already locked by `steeringLocked`; here we force the yaw so the
    // spin is visible, and bleed off horizontal speed. Vertical velocity belongs
    // to gravity and is left alone.
    k.angularVelocity = SPIN_YAW_RATE
    k.heading = wrapAngle(k.heading + SPIN_YAW_RATE * TICK_DT)
    k.velocity.x *= SPIN_SPEED_DECAY
    k.velocity.z *= SPIN_SPEED_DECAY
    k.drift.active = false
    k.drift.dir = 0
    k.drift.charge = 0
    k.boostTicks = 0
    k.spinOutTicks -= 1
  }

  const proj = ctx.query.project(k.position)
  if (!ctx.query.isInBounds(proj.s, proj.lateral)) {
    beginRespawn(ctx, state, k, events)
  }
}
```

- [ ] **Step 12: Run test to verify it passes**

Run: `npx vitest run packages/sim/test/recovery.test.ts -t "spin-out"`
Expected: PASS — 6 tests.

---

- [ ] **Step 13: Write the failing test — startSpinOut**

In `packages/sim/test/recovery.test.ts`, change the import of `../src/recovery`.

Before:

```ts
import {
  motionLocked, SPIN_SPEED_DECAY, SPIN_YAW_RATE, steeringLocked,
  surfaceSpeedFactor, updateRecovery,
} from '../src/recovery'
```

After:

```ts
import {
  motionLocked, SPIN_SPEED_DECAY, SPIN_YAW_RATE, startSpinOut, steeringLocked,
  surfaceSpeedFactor, updateRecovery,
} from '../src/recovery'
```

Then append this block to the end of the file:

```ts
describe('startSpinOut', () => {
  it('arms the timer and emits one spinOut event', () => {
    const state = makeSimState()
    const k = state.karts[3]
    k.drift.active = true
    k.drift.dir = 1
    k.drift.charge = 120
    k.boostTicks = 30
    const events: AuthEvent[] = []

    startSpinOut(state, k, 60, events)

    expect(k.spinOutTicks).toBe(60)
    expect(k.drift.active).toBe(false)
    expect(k.drift.dir).toBe(0)
    expect(k.drift.charge).toBe(0)
    expect(k.boostTicks).toBe(0)

    expect(events.length).toBe(1)
    expect(events[0].kind).toBe('spinOut')
    expect(events[0].playerId).toBe(3)
    expect(events[0].entityId).toBe(-1)
    expect(events[0].item).toBe('none')
    expect(events[0].data).toBe(60)
    expect(state.nextEventSeq).toBe(1)
  })

  it('is refused while the kart is invulnerable', () => {
    const state = makeSimState()
    const k = state.karts[0]
    k.invulnTicks = 5
    const events: AuthEvent[] = []

    startSpinOut(state, k, 60, events)

    expect(k.spinOutTicks).toBe(0)
    expect(events.length).toBe(0)
    expect(state.nextEventSeq).toBe(0)
  })

  it('is refused while the kart is respawning', () => {
    const state = makeSimState()
    const k = state.karts[0]
    k.respawnTicks = 10
    const events: AuthEvent[] = []

    startSpinOut(state, k, 60, events)

    expect(k.spinOutTicks).toBe(0)
    expect(k.respawnTicks).toBe(10)
    expect(events.length).toBe(0)
  })

  it('never shortens a spin-out already in progress', () => {
    const state = makeSimState()
    const k = state.karts[0]
    const events: AuthEvent[] = []

    startSpinOut(state, k, 40, events)
    expect(k.spinOutTicks).toBe(40)
    expect(events.length).toBe(1)

    startSpinOut(state, k, 20, events) // shorter: ignored, no second event
    expect(k.spinOutTicks).toBe(40)
    expect(events.length).toBe(1)

    startSpinOut(state, k, 60, events) // longer: extends, and does emit
    expect(k.spinOutTicks).toBe(60)
    expect(events.length).toBe(2)
    expect(events[1].data).toBe(60)
  })

  it('ignores a non-positive duration', () => {
    const state = makeSimState()
    const k = state.karts[0]
    const events: AuthEvent[] = []

    startSpinOut(state, k, 0, events)

    expect(k.spinOutTicks).toBe(0)
    expect(events.length).toBe(0)
  })

  it('runs a full spin-out through updateRecovery with exactly one event', () => {
    const ctx = makeCtx()
    const state = makeSimState()
    const k = state.karts[0]
    k.position.x = 10
    k.position.z = 0
    k.velocity.x = 20
    const events: AuthEvent[] = []

    startSpinOut(state, k, ctx.tuning.spinOutTicks, events)
    expect(k.spinOutTicks).toBe(60)

    for (let i = 0; i < 60; i++) updateRecovery(ctx, state, k, events)

    expect(k.spinOutTicks).toBe(0)
    expect(steeringLocked(k)).toBe(false)
    expect(events.length).toBe(1)
    expect(events[0].kind).toBe('spinOut')
    // 20 * 0.94^60
    expect(k.velocity.x).toBeCloseTo(20 * Math.pow(0.94, 60), 12)
  })
})
```

- [ ] **Step 14: Run test to verify it fails**

Run: `npx vitest run packages/sim/test/recovery.test.ts -t "startSpinOut"`
Expected: FAIL with `startSpinOut is not a function` (the export does not exist yet).

- [ ] **Step 15: Write minimal implementation — startSpinOut**

In `packages/sim/src/recovery.ts`, insert this function immediately after
`surfaceSpeedFactor` and before `updateRecovery`:

```ts
/**
 * The only sanctioned way to put a kart into a spin-out. Tasks 12 and 13 call
 * this; nothing else writes `k.spinOutTicks`.
 *
 * Refused outright while the kart is invulnerable or respawning, and it never
 * shortens a spin already running. The `'spinOut'` event is emitted only when
 * the timer actually changes, so counting events counts real spin-outs.
 */
export function startSpinOut(
  state: SimState,
  k: KartState,
  ticks: number,
  events: AuthEvent[],
): void {
  if (ticks <= 0) return
  if (k.invulnTicks > 0 || k.respawnTicks > 0) return
  if (ticks <= k.spinOutTicks) return

  k.spinOutTicks = ticks
  k.drift.active = false
  k.drift.dir = 0
  k.drift.charge = 0
  k.boostTicks = 0
  emit(state, events, 'spinOut', k.playerId, -1, 'none', ticks)
}
```

- [ ] **Step 16: Run test to verify it passes**

Run: `npx vitest run packages/sim/test/recovery.test.ts -t "startSpinOut"`
Expected: PASS — 6 tests.

---

- [ ] **Step 17: Verify the whole module**

`packages/sim/src/recovery.ts` must now read exactly as follows. Diff it before
running; a mismatch means one of the incremental edits landed in the wrong place.

```ts
import type { AuthEvent, KartState, SimContext, SimState, Tuning, Vec3 } from './types'
import { TICK_DT } from './types'
import { lerp, wrapAngle } from './mathutil'
import { emit } from './state'

/**
 * Yaw rate, rad/s, forced on a kart while `spinOutTicks > 0`.
 * 4*PI rad/s is exactly two visible full turns per second of spin-out.
 */
export const SPIN_YAW_RATE = 4 * Math.PI

/** Per-tick multiplicative retention of horizontal speed while spinning out. */
export const SPIN_SPEED_DECAY = 0.94

/** Scratch respawn target. Module scope so the hot path never allocates. */
const TARGET: Vec3 = { x: 0, y: 0, z: 0 }

export function steeringLocked(k: KartState): boolean {
  return k.spinOutTicks > 0 || k.respawnTicks > 0
}

export function motionLocked(k: KartState): boolean {
  return k.respawnTicks > 0
}

export function surfaceSpeedFactor(k: KartState, t: Tuning): number {
  return k.surface === 'offtrack' ? t.offtrackSpeedMul : 1
}

export function startSpinOut(
  state: SimState,
  k: KartState,
  ticks: number,
  events: AuthEvent[],
): void {
  if (ticks <= 0) return
  if (k.invulnTicks > 0 || k.respawnTicks > 0) return
  if (ticks <= k.spinOutTicks) return

  k.spinOutTicks = ticks
  k.drift.active = false
  k.drift.dir = 0
  k.drift.charge = 0
  k.boostTicks = 0
  emit(state, events, 'spinOut', k.playerId, -1, 'none', ticks)
}

export function updateRecovery(
  ctx: SimContext,
  state: SimState,
  k: KartState,
  events: AuthEvent[],
): void {
  const t = ctx.tuning

  if (k.respawnTicks > 0) {
    stepRespawn(ctx, k)
    if (k.respawnTicks === 0) k.invulnTicks = t.invulnTicks
    return
  }

  if (k.invulnTicks > 0) k.invulnTicks -= 1

  if (k.spinOutTicks > 0) {
    k.angularVelocity = SPIN_YAW_RATE
    k.heading = wrapAngle(k.heading + SPIN_YAW_RATE * TICK_DT)
    k.velocity.x *= SPIN_SPEED_DECAY
    k.velocity.z *= SPIN_SPEED_DECAY
    k.drift.active = false
    k.drift.dir = 0
    k.drift.charge = 0
    k.boostTicks = 0
    k.spinOutTicks -= 1
  }

  const proj = ctx.query.project(k.position)
  if (!ctx.query.isInBounds(proj.s, proj.lateral)) {
    beginRespawn(ctx, state, k, events)
  }
}

function checkpointTarget(ctx: SimContext, k: KartState): number {
  const cps = ctx.track.checkpointS
  const n = cps.length
  let s = 0
  if (n > 0) {
    const idx = ((k.lap.checkpointIdx % n) + n) % n
    s = cps[idx]
  }
  const cp = ctx.query.sampleAt(s)
  TARGET.x = cp.position.x
  TARGET.y = ctx.query.groundHeight(s, 0)
  TARGET.z = cp.position.z
  const tan = ctx.query.tangentAt(s)
  return Math.atan2(tan.z, tan.x)
}

function snapToCheckpoint(ctx: SimContext, k: KartState): void {
  const h = checkpointTarget(ctx, k)
  k.position.x = TARGET.x
  k.position.y = TARGET.y
  k.position.z = TARGET.z
  k.heading = wrapAngle(h)
}

function beginRespawn(
  ctx: SimContext,
  state: SimState,
  k: KartState,
  events: AuthEvent[],
): void {
  const t = ctx.tuning
  k.spinOutTicks = 0
  k.boostTicks = 0
  k.invulnTicks = 0
  k.drift.active = false
  k.drift.dir = 0
  k.drift.charge = 0
  k.velocity.x = 0
  k.velocity.y = 0
  k.velocity.z = 0
  k.angularVelocity = 0
  k.airborne = false
  k.respawnTicks = t.respawnTicks > 0 ? t.respawnTicks : 0
  emit(state, events, 'respawn', k.playerId, -1, 'none', k.respawnTicks)
  if (k.respawnTicks === 0) {
    snapToCheckpoint(ctx, k)
    k.invulnTicks = t.invulnTicks
  }
}

function stepRespawn(ctx: SimContext, k: KartState): void {
  k.velocity.x = 0
  k.velocity.y = 0
  k.velocity.z = 0
  k.angularVelocity = 0
  k.airborne = false
  k.boostTicks = 0
  k.drift.active = false
  k.drift.dir = 0
  k.drift.charge = 0

  if (k.respawnTicks <= 1) {
    snapToCheckpoint(ctx, k)
    k.respawnTicks = 0
    return
  }

  const h = checkpointTarget(ctx, k)
  const f = 1 / k.respawnTicks
  k.position.x = lerp(k.position.x, TARGET.x, f)
  k.position.y = lerp(k.position.y, TARGET.y, f)
  k.position.z = lerp(k.position.z, TARGET.z, f)
  k.heading = wrapAngle(k.heading + wrapAngle(h - k.heading) * f)
  k.respawnTicks -= 1
}
```

Run: `npx vitest run packages/sim/test/recovery.test.ts`
Expected: PASS — 24 tests, 4 describe blocks.

Run: `npx tsc --noEmit -p packages/sim`
Expected: no output, exit code 0.

Nothing in the package imports `recovery.ts` yet. Steps 18–25 are what give it
consumers: `kart.ts` (the control locks and the off-track speed factor) and
`step.ts` (canonical slot 2). Without them a spinning kart keeps full steering and
throttle, a respawning kart's interpolation is overwritten by the integrator on the
same tick, the off-track speed penalty never applies, and `updateRecovery` is never
called at all.

---

- [ ] **Step 18: Write the failing test — `stepKart` obeys the locks and the surface factor**

Append this block to the end of `packages/sim/test/kart.test.ts`. That file already
has, at module scope, `const ctx = makeTestContext(EIGHT_STARTS)`,
`const state = createState(ctx, 1, [0, 0, 0, 0, 0, 0, 0, 0])`, and imports
`{ stepKart, targetSpeedFor }` from `../src/kart` plus
`{ EIGHT_STARTS, makeIntent, makeKart, makeTestContext }` from
`./helpers/flat-context` — no import changes are needed.

```typescript
describe('stepKart — recovery locks and the off-track speed factor', () => {
  it('takes the steering axis away while spinning out, but still integrates motion', () => {
    // steeringLocked(k) is true, so stepKart reads the steer axis as 0 and the yaw
    // term vanishes even at full stick. Everything else still runs: a spinning kart
    // slides, it is not frozen.
    //   longitudinal: accel 0 -> target 0, rate = 24 * 1.00, maxDelta = 24/60 = 0.4,
    //                 so 20 -> 19.6
    //   lateral:      velocity is exactly along heading 0, so vr = 0 and grip is a
    //                 no-op whatever coefficient it picks
    //   position:     0 + 19.6 / 60 = 0.3266666666666667
    const k = makeKart({ characterIdx: 0, velocity: { x: 20, y: 0, z: 0 }, spinOutTicks: 12 })
    const prevKart = makeKart({ characterIdx: 0, velocity: { x: 20, y: 0, z: 0 } })
    stepKart(ctx, state, prevKart, k, makeIntent({ steer: 1 }))

    expect(k.angularVelocity).toBe(0)
    expect(k.heading).toBe(0)
    expect(k.velocity.x).toBeCloseTo(19.6, 12)
    expect(k.position.x).toBeCloseTo(0.3266666666666667, 12)
    expect(k.spinOutTicks).toBe(12) // stepKart never touches the timer

    // The identical kart with no spin-out steers normally, which is what makes the
    // assertions above about the lock and not about the speed-authority curve:
    // sn = 20/40 = 0.5, authority = 0.5 * (1 - 0.55 * 0.5) = 0.3625,
    // yaw = 2.6 * 1 * 1.00 * 0.3625 = 0.9425
    const free = makeKart({ characterIdx: 0, velocity: { x: 20, y: 0, z: 0 } })
    stepKart(ctx, state, makeKart({ velocity: { x: 20, y: 0, z: 0 } }), free, makeIntent({ steer: 1 }))
    expect(free.angularVelocity).toBeCloseTo(0.9425, 12)
  })

  it('does nothing at all while the kart is respawning', () => {
    // motionLocked(k) is true: updateRecovery owns this kart's position, velocity
    // and heading for the whole respawn interpolation, so stepKart must return
    // before the traction block AND before the horizontal position integration.
    // Full stick and full throttle, to prove it is the lock and not the input.
    // prevKart enters at 20 m/s, so without the lock the yaw term would be
    // sn = 0.5, authority = 0.3625, yawRate = 2.6 * 1 * 1.00 * 0.3625 = 0.9425.
    const k = makeKart({
      characterIdx: 0,
      position: { x: 5, y: 1, z: 2 },
      velocity: { x: 20, y: 0, z: 3 },
      heading: 0,
      angularVelocity: 0.5,
      respawnTicks: 7,
    })
    const prevKart = makeKart({ characterIdx: 0, velocity: { x: 20, y: 0, z: 0 } })
    stepKart(ctx, state, prevKart, k, makeIntent({ steer: 1, accel: 1 }))

    expect(k.heading).toBe(0)
    expect(k.angularVelocity).toBe(0.5)
    expect(k.position.x).toBe(5)
    expect(k.position.y).toBe(1)
    expect(k.position.z).toBe(2)
    expect(k.velocity.x).toBe(20)
    expect(k.velocity.z).toBe(3)
    expect(k.respawnTicks).toBe(7)
  })

  it('multiplies the target speed by offtrackSpeedMul, and only off-track', () => {
    // 40 * 1.00 * 1 * 0.55 * 1 * 1 = 22
    expect(targetSpeedFor(ctx, state, makeKart({ characterIdx: 0, surface: 'offtrack' }), 1))
      .toBeCloseTo(22, 12)

    // every other surface contributes exactly 1
    expect(targetSpeedFor(ctx, state, makeKart({ characterIdx: 0, surface: 'tarmac' }), 1)).toBe(40)
    expect(targetSpeedFor(ctx, state, makeKart({ characterIdx: 0, surface: 'dirt' }), 1)).toBe(40)
    expect(targetSpeedFor(ctx, state, makeKart({ characterIdx: 0, surface: 'boost' }), 1)).toBe(40)

    // and it composes with the other factors in the contract's order:
    // 40 * 1.10 * 0.5 * 0.55 * 1 * 1.35 = 16.335
    expect(
      targetSpeedFor(
        ctx,
        state,
        makeKart({ characterIdx: 1, surface: 'offtrack', boostTicks: 4 }),
        0.5,
      ),
    ).toBeCloseTo(16.335, 12)
  })

  it('drives the longitudinal term from the off-track target speed', () => {
    // Off-track target = 40 * 1.00 * 1 * 0.55 = 22. The kart is above it at 30 m/s,
    // so it sheds a full maxDelta: 30 - 24/60 = 29.6.
    const kOff = makeKart({ characterIdx: 0, velocity: { x: 30, y: 0, z: 0 }, surface: 'offtrack' })
    stepKart(
      ctx, state,
      makeKart({ characterIdx: 0, velocity: { x: 30, y: 0, z: 0 } }),
      kOff,
      makeIntent({ accel: 1 }),
    )
    expect(kOff.velocity.x).toBeCloseTo(29.6, 12)

    // The identical kart on tarmac targets 40 and gains instead: 30 + 0.4 = 30.4.
    const kOn = makeKart({ characterIdx: 0, velocity: { x: 30, y: 0, z: 0 }, surface: 'tarmac' })
    stepKart(
      ctx, state,
      makeKart({ characterIdx: 0, velocity: { x: 30, y: 0, z: 0 } }),
      kOn,
      makeIntent({ accel: 1 }),
    )
    expect(kOn.velocity.x).toBeCloseTo(30.4, 12)
  })
})
```

- [ ] **Step 19: Run test to verify it fails**

Run: `npx vitest run packages/sim/test/kart.test.ts -t "recovery locks and the off-track speed factor"`

Expected: FAIL — all four tests, each on its first assertion.
"takes the steering axis away while spinning out" reports `expected 0.9425 to be 0`
for `k.angularVelocity` (vitest prints the exact float; the point is that the yaw
term is non-zero) — `stepKart` still reads `raw.steer` unconditionally.
"does nothing at all while the kart is respawning" reports
`expected 0.015708333333333335 to be 0` for `k.heading`: one tick of the 0.9425 rad/s
yaw the lock is supposed to suppress.
"multiplies the target speed by offtrackSpeedMul" reports `expected 40 to be close
to 22`: `targetSpeedFor` still multiplies by the literal `1`.
"drives the longitudinal term from the off-track target speed" reports
`expected 30.4 to be close to 29.6`: with no surface penalty the off-track kart
targets 40 and accelerates instead of shedding speed. Its second assertion, the
tarmac control case, already passes.

- [ ] **Step 20: Wire the locks and the surface factor into `kart.ts`**

Four edits in `packages/sim/src/kart.ts`. Task 8 has already edited this file (it
replaced `stepKart`'s inline grip expression with `lateralGripFor(ctx, k)` and added
`import { lateralGripFor } from './drift'`); none of the four edits below touches
that block, and each anchor below is unique in the file.

**Edit 1 — the import.** Before:

```typescript
import { clamp, wrapAngle } from './mathutil'
```

After:

```typescript
import { clamp, wrapAngle } from './mathutil'
import { motionLocked, steeringLocked, surfaceSpeedFactor } from './recovery'
```

(`recovery.ts` imports `types`, `mathutil` and `state` only, so this introduces no
import cycle.)

**Edit 2 — the off-track factor.** Task 6 wrote the literal under a three-line
comment; all four lines go, replaced by the one line below. Before:

```typescript
  // Task 9 replaces this exact line with `const surfaceFactor = surfaceSpeedFactor(k, t)`
  // and adds `import { surfaceSpeedFactor } from './recovery'` at the top of this
  // file. Until then there is no off-track penalty.
  const surfaceFactor = 1
```

After:

```typescript
  const surfaceFactor = surfaceSpeedFactor(k, t)
```

**Edit 3 — the motion lock.** These three lines open `stepKart`; the pair
`const t` / `const ch` also appears in `targetSpeedFor`, so include the
`if (!k.airborne) {` line, which makes the anchor unique. Before:

```typescript
  const t = ctx.tuning
  const ch = ctx.characters[k.characterIdx] as CharacterStats

  if (!k.airborne) {
```

After:

```typescript
  const t = ctx.tuning
  const ch = ctx.characters[k.characterIdx] as CharacterStats

  // Canonical order slot 2 already ran this tick. A respawning kart's position and
  // velocity belong to updateRecovery's interpolation, so stepKart does nothing at
  // all for it — not the traction block, and not the position integration below.
  if (motionLocked(k)) return

  if (!k.airborne) {
```

**Edit 4 — the steering lock**, inside the block Edit 3 lands in front of. Before:

```typescript
    const authority = sn * (1 - t.steerSpeedFalloff * sn)
    const yawRate = t.steerRateBase * raw.steer * ch.handling * authority
```

After:

```typescript
    const authority = sn * (1 - t.steerSpeedFalloff * sn)
    // A spinning or respawning kart has no steering authority at all (Task 9).
    const steer = steeringLocked(k) ? 0 : raw.steer
    const yawRate = t.steerRateBase * steer * ch.handling * authority
```

`raw` is still read by the longitudinal block (`raw.brake`, `raw.accel`), so it does
not become unused.

- [ ] **Step 21: Run test to verify it passes**

Run: `npx vitest run packages/sim/test/kart.test.ts`

Expected: PASS — 20 tests: the four written in Step 18, plus the 16 Task 6 left in
this file (3 `targetSpeedFor` + 5 steering + 5 longitudinal + 2 lateral grip +
1 airborne = 16; 16 + 4 = 20), all still green. Tasks 7 and 8 add no test to
`kart.test.ts` — Task 8 only re-runs it — so 16 is still the count at the top of
this task. None of Task 6's numbers moves: none of its karts sets
`spinOutTicks` or `respawnTicks`, and its one `surface: 'offtrack'` case is the
lateral-grip test, which passes `accel 0` — `surfaceSpeedFactor` multiplies a target
speed that is already `40 * 1.00 * 0 = 0`.

---

- [ ] **Step 22: Write the failing test — `step()` runs `updateRecovery` at slot 2**

Append this block to the end of `packages/sim/test/step.test.ts`. That file already
imports `AuthEvent`, `Intent`, `createState`, `step`, `EIGHT_STARTS`, `makeIntent`
and `makeTestContext` — no import changes are needed.

```typescript
describe('step — recovery at slot 2', () => {
  it('spends a spin-out tick, and the integrator sees the steering lock', () => {
    const ctx = makeTestContext(EIGHT_STARTS)
    const prev = createState(ctx, 7, [0, 0, 0, 0, 0, 0, 0, 0])
    const next = createState(ctx, 7, [0, 0, 0, 0, 0, 0, 0, 0])
    prev.karts[0].spinOutTicks = 60
    prev.karts[0].velocity.x = 20 // enough speed that steering would bite

    const inputs: Intent[] = []
    inputs[0] = makeIntent({ steer: 1 })

    step(ctx, prev, next, inputs, [])

    // updateRecovery spent one tick of the spin and forced the yaw:
    //   heading = 0 + SPIN_YAW_RATE * TICK_DT = 4*PI / 60 = PI/15 = 0.20943951023931953
    expect(next.karts[0].spinOutTicks).toBe(59)
    expect(next.karts[0].heading).toBeCloseTo(0.20943951023931953, 12)
    // and stepKart, running after it, read steeringLocked and added no yaw of its
    // own — without the lock this would be 2.6 * 1 * 1.00 * 0.3625 = 0.9425
    expect(next.karts[0].angularVelocity).toBe(0)

    // prev is never written
    expect(prev.karts[0].spinOutTicks).toBe(60)
    expect(prev.karts[0].heading).toBe(0)
  })

  it('respawns a kart that is out of bounds at the top of the tick', () => {
    const ctx = makeTestContext(EIGHT_STARTS)
    const prev = createState(ctx, 7, [0, 0, 0, 0, 0, 0, 0, 0])
    const next = createState(ctx, 7, [0, 0, 0, 0, 0, 0, 0, 0])
    // makeFlatQuery projects lateral = position.z and bounds it at |lateral| <= 10
    prev.karts[0].position.z = 50
    prev.karts[0].velocity.x = 20
    const events: AuthEvent[] = []

    step(ctx, prev, next, [], events)

    expect(next.karts[0].respawnTicks).toBe(72) // tuning.respawnTicks
    expect(next.karts[0].velocity.x).toBe(0)    // beginRespawn freezes the kart
    expect(next.karts[0].position.z).toBe(50)   // the detection tick does not move it
    // and stepKart honoured motionLocked, so nothing integrated on top of it
    expect(next.karts[0].position.x).toBe(0)

    // Filtered by kind: later tasks add lap and item events to this same tick, and
    // this test is about the respawn only.
    const respawns = events.filter((e) => e.kind === 'respawn')
    expect(respawns.length).toBe(1)
    expect(respawns[0].playerId).toBe(0)
    expect(respawns[0].entityId).toBe(-1)
    expect(respawns[0].data).toBe(72)

    expect(prev.karts[0].respawnTicks).toBe(0) // prev is never written
  })
})
```

- [ ] **Step 23: Run test to verify it fails**

Run: `npx vitest run packages/sim/test/step.test.ts -t "recovery at slot 2"`

Expected: FAIL — both tests.
"spends a spin-out tick" reports `expected 60 to be 59`: `step()` never calls
`updateRecovery`, so the timer is untouched. (Its `angularVelocity` assertion already
passes, because Step 20 gave `stepKart` the lock and `spinOutTicks` is still 60.)
"respawns a kart that is out of bounds" reports `expected 0 to be 72` for
`respawnTicks`: nothing ever tests the kart against the track bounds.

- [ ] **Step 24: Wire `updateRecovery` into `step()` at canonical slot 2**

Three edits in `packages/sim/src/step.ts`.

**Edit 1 — the import.** Before:

```typescript
import { stepKart } from './kart'
```

After:

```typescript
import { stepKart } from './kart'
import { updateRecovery } from './recovery'
```

**Edit 2 — the slot-2 call.** Task 8 put `updateDrift` on the line immediately before
`stepKart`; slot 2 goes immediately before that. Before:

```typescript
    updateDrift(ctx, k, raw)
    stepKart(ctx, next, prevKart, k, raw)
```

After:

```typescript
    // Canonical order slot 2. Recovery runs before drift and before the integrator
    // because it owns this kart's controls for the rest of the tick: stepKart reads
    // steeringLocked / motionLocked, and updateDrift forfeits a charge on a kart
    // that recovery has just put into a spin-out or a respawn.
    updateRecovery(ctx, next, k, events)
    updateDrift(ctx, k, raw)
    stepKart(ctx, next, prevKart, k, raw)
```

**Edit 3 — delete the now-dead `void`.** `events` is genuinely read from here on, so
the statement that was standing in for a use goes away. Before:

```typescript
  void events // used from Task 9 onward, when updateRecovery joins the kart loop

  cloneState(prev, next)
```

After:

```typescript
  cloneState(prev, next)
```

- [ ] **Step 25: Run test to verify it passes, then the whole suite**

Run: `npx vitest run packages/sim/test/step.test.ts`

Expected: PASS — 8 tests: the 3 from Task 5, the 3 from Task 6, and the 2 from
Step 22. Task 5's and Task 6's tests are unaffected: their karts have
`spinOutTicks === 0` and `respawnTicks === 0`, and the widest `EIGHT_STARTS` seat
sits at `lateral 3`, well inside `makeFlatQuery.isInBounds`'s `|lateral| <= 10`, so
no kart respawns and no event is emitted.

Run: `npx vitest run packages/sim && npx tsc --noEmit -p packages/sim`

Expected: PASS — every `packages/sim` test green, and `tsc` reports no errors
(in particular no unused-parameter error, since Edit 3 removed the `void events`
that was standing in for a real use).

- [ ] **Step 26: Commit**

```bash
git add packages/sim/src/recovery.ts packages/sim/test/recovery.test.ts \
        packages/sim/src/kart.ts packages/sim/test/kart.test.ts \
        packages/sim/src/step.ts packages/sim/test/step.test.ts
git commit -m "feat(sim): spin-out and respawn recovery, wired into step() at slot 2

updateRecovery drives both recovery states: an out-of-bounds kart interpolates
linearly back to its last checkpoint over tuning.respawnTicks and is granted
tuning.invulnTicks on arrival, while startSpinOut - the sole writer of
spinOutTicks - forces a 4*PI rad/s yaw and decays horizontal speed by 0.94 per
tick. Both paths emit countable respawn/spinOut AuthEvents.

step() now calls updateRecovery at canonical slot 2, before updateDrift and the
integrator, and stepKart consumes all three predicates: steeringLocked zeroes
the steer axis, motionLocked makes stepKart a no-op so it cannot overwrite the
respawn interpolation, and surfaceSpeedFactor replaces the literal 1 that stood
in for the off-track term of targetSpeedFor."
```
