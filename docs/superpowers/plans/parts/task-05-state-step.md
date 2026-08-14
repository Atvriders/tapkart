### Task 5: SimState lifecycle (`createState` / `cloneState` / `statesEqual` / `emit`) and the empty `step()`

This task builds the state container that every later task writes into, plus the
tick loop skeleton. Nothing simulates yet: `step()` copies `prev` into `next` and
advances the tick counter. Tasks 6–15 insert their stage calls into that loop.

**Files:**
- Create: `packages/sim/src/state.ts`
- Create: `packages/sim/src/step.ts`
- Create: `packages/sim/test/helpers/flat-context.ts`
- Test: `packages/sim/test/state.test.ts`
- Test: `packages/sim/test/step.test.ts`

**Interfaces:**

- Consumes (all already exist):
  - `packages/sim/src/types.ts` [Task 2] — the types `Vec3`, `Surface`, `ItemKind`,
    `EntityKind`, `RacePhase`, `Intent`, `DriftState`, `LapProgress`, `KartState`,
    `EntityState`, `ItemBoxState`, `SimState`, `AuthEventKind`, `AuthEvent`,
    `TrackPoint`, `Track`, `CharacterStats`, `Tuning`, `SimContext`,
    `TrackProjection`, `TrackQuery`; and the value constants
    `TICK_HZ = 60`, `TICK_DT = 1/60`, `MAX_KARTS = 8`, `MAX_ENTITIES = 32`,
    `RACE_LAPS = 3`, `COUNTDOWN_TICKS = 180`.
  - `packages/sim/src/vec3.ts` [Task 2] — `v3(x: number, y: number, z: number): Vec3`
  - `packages/sim/src/mathutil.ts` [Task 2] — `clamp(v: number, lo: number, hi: number): number`,
    `wrapAngle(a: number): number`
  - `packages/sim/test/fixtures/track-fixtures.ts` [Task 3] —
    `makeTuning(overrides?: Partial<Tuning>): Tuning`, `makeCharacters(): CharacterStats[]`

- Produces (later tasks rely on these verbatim):
  - `createState(ctx: SimContext, seed: number, characterIdx: number[]): SimState`
  - `cloneState(src: SimState, dst: SimState): void`
  - `statesEqual(a: SimState, b: SimState): boolean`
  - `emit(state: SimState, out: AuthEvent[], kind: AuthEventKind, playerId: number, entityId: number, item: ItemKind, data: number): void`
  - `step(ctx: SimContext, prev: SimState, next: SimState, inputs: Intent[], events: AuthEvent[]): void`
  - `packages/sim/test/helpers/flat-context.ts` — `makeFlatQuery(): TrackQuery`,
    `makeFlatTrack(startPositions: { s: number; lateral: number }[]): Track`,
    `makeTestContext(startPositions: { s: number; lateral: number }[]): SimContext`,
    `EIGHT_STARTS: { s: number; lateral: number }[]`

- Decisions this task makes that the locked contract does not pin, stated so
  later tasks can depend on them:
  - **`makeFlatQuery` obeys the contract's `s` rule: `s` is arc-normalized to
    `[0, 1)`, never metres.** The flat track is 1000 m long, so `s = 0.25` is
    250 m along and `project()` returns `wrap01(p.x / 1000)`. Every consumer of
    this helper — Tasks 6, 7, 8, 9, 11 and 16 all build contexts from it — must
    write track offsets as fractions: 6 m of bot lookahead is `6 / 1000`, and the
    grid slots in `EIGHT_STARTS` are `0, 0.004, 0.008 …`, i.e. 0 m, 4 m, 8 m.
    `groundHeight(s, lateral)` returns `0.5 * (s * 1000)` — half the arc distance
    **in metres** — so it is still deliberately non-constant and every existing
    world-space expectation (`y = 2` at 4 m) is unchanged.
  - Every seat starts `isBot: true`, `connected: false`. The lobby/net layer flips
    these before the race; nothing in `sim` special-cases seat 0.
  - `characterIdx` entries are truncated toward zero and clamped into
    `[0, ctx.characters.length - 1]`; a missing or non-finite entry becomes `0`.
  - `lap` starts at `{ lap: 0, checkpointIdx: ctx.track.checkpointS.length - 1, t: 0 }`,
    which is the locked contract's value — **not** `-1`. A kart on the grid sits
    *behind* checkpoint 0, i.e. it is already credited with the final checkpoint
    of the notional previous lap, so its first legal crossing is index 0. Task 11
    computes `next = cur + 1 >= n ? 0 : cur + 1`, which yields `0` from
    `cur = n - 1`. `-1` is not a valid checkpoint index and would leave
    `k.lap.checkpointIdx` outside `[0, n)` in every snapshot until the first
    crossing. On this task's 4-checkpoint flat test track the initial value is
    therefore **`3`**. `createState` guards the degenerate case explicitly: a
    track with `checkpointS.length === 0` has no last checkpoint, so its karts get
    `-1` — a value Task 11 never acts on, because `updateLaps` returns
    immediately when `checkpointS.length < 2`.
    Task 11 owns every transition out of the initial value.
  - `nextEntityId` starts at `1`, so the first spawned entity has `entityId === 1`
    and the dead-slot sentinel `-1` can never collide with a live id.
  - `finishedOrder` is a **fixed-length** `number[]` of length exactly `MAX_KARTS`
    (8), created full of `-1`, and it stays length 8 for the whole race. It is
    never `push`ed to, never `pop`ped, never resized and never replaced. A kart
    that finishes is written into the **first slot holding `-1`**; the finisher
    count is the number of entries `!== -1`; "has kart `p` finished?" is a scan of
    the 8 slots for `=== p`, not `indexOf(p) >= 0` on a growable list. Tasks 11
    and 15 are the only writers and both obey this.
    This is not a stylistic preference: `cloneState` below checks
    `dst.finishedOrder.length === src.finishedOrder.length` (together with
    `karts`, `entities` and `itemBoxes`) and throws
    `'cloneState: dst was not preallocated with the same shape as src'` when it
    differs, so a single `push` past 8 makes the next `cloneState` — and
    therefore every `step()`, `recordRun` and `replayRun` after it — throw.
    Fixed length is also what keeps `cloneState` allocation-free.
  - Dead entity slots carry `entityId: -1`, `ownerId: -1`, `targetId: -1`,
    `ttl: 0`, `kind: 'seeker'`. `kind` is meaningless while `entityId === -1`, but
    it is still copied and still compared, so despawn must leave deterministic
    residue (it does: same code path, same residue).
  - `statesEqual` compares **all** `MAX_ENTITIES` slots and **all** `MAX_KARTS`
    `finishedOrder` slots, live or not. That is what makes it bit-exact.
  - `emit` is the one place the sim allocates per call (it pushes an object onto
    the caller's array). Event volume is per-event, not per-tick, and the
    contract's signature takes an `AuthEvent[]`, so this is intended.
  - `step()` clones `prev` into `next` at the top of the tick. That is what makes
    "never mutates `prev`" true for every later stage: every stage writes only
    into `next`.

- Convention reminders that this task must obey exactly:
  - `forward = (cos h, 0, sin h)`, `h = Math.atan2(dir.z, dir.x)`,
    `right = (-t.z, 0, t.x)` normalized, positive `lateral` is right of travel,
    up is `+y`. **The `right` formula is the authority.** On a track whose tangent
    is `(1, 0, 0)` it yields `right = (0, 0, 1)`, so positive lateral offsets a
    start position toward `+z`.
  - Every stored heading passes through `wrapAngle` → `(-π, π]`.
  - Imports are extensionless (`from './types'`) and type-only imports use
    `import type { ... }`.

---

- [ ] **Step 1: Write the failing test for `createState`**

First create the shared test helper. It gives every sim test an analytic,
perfectly flat track query so expected values are hand-computable — the real
spline query from Task 3 is exercised by Task 3's own tests, not here.

Create `packages/sim/test/helpers/flat-context.ts`:

```typescript
import type {
  CharacterStats,
  SimContext,
  Surface,
  Track,
  TrackPoint,
  TrackProjection,
  TrackQuery,
  Vec3,
} from '../../src/types'
import { makeCharacters, makeTuning } from '../fixtures/track-fixtures'

/** The flat track's arc length in metres. `s` is arc length / this. */
const FLAT_TOTAL_LENGTH = 1000

/**
 * Fractional part of `s`, in `[0, 1)` — the track is a closed loop.
 *
 * Declared locally because `track.ts`'s own `wrap01` (Task 4) is private to that
 * module, and this helper must not depend on anything Task 4 does not export.
 */
function wrap01(s: number): number {
  const w = s - Math.floor(s)
  return w >= 1 ? 0 : w
}

/**
 * An analytic TrackQuery for a dead-straight 1000 m track running along +X.
 *
 * `s` is arc-NORMALIZED to [0, 1), exactly as the locked contract requires:
 * s = 0.25 is 250 m along, not 0.25 m. Metres are reached only by multiplying an
 * s-delta by totalLength().
 *
 *   sampleAt(s)          -> centerline point (s * 1000, 0, 0)
 *   tangentAt(s)         -> (1, 0, 0), so right = (-t.z, 0, t.x) = (0, 0, 1)
 *   project(p)           -> s = wrap01(p.x / 1000), lateral = p.z
 *   groundHeight(s, lat) -> 0.5 * (s * 1000), i.e. half the arc distance in
 *                           metres (deliberately NOT constant, so a test can
 *                           prove the query was actually consulted)
 *   surfaceAt(s, lat)    -> 'dirt' when lateral > 2, otherwise 'tarmac'
 *   checkpointIndexAt(s) -> floor(s * 4) clamped to 0..3, matching the four
 *                           checkpoints at s = 0, 0.25, 0.5, 0.75
 */
export function makeFlatQuery(): TrackQuery {
  return {
    sampleAt(s: number): TrackPoint {
      return {
        position: { x: s * FLAT_TOTAL_LENGTH, y: 0, z: 0 },
        width: 20,
        banking: 0,
        surface: 'tarmac',
      }
    },
    tangentAt(_s: number): Vec3 {
      return { x: 1, y: 0, z: 0 }
    },
    project(p: Vec3): TrackProjection {
      return {
        s: wrap01(p.x / FLAT_TOTAL_LENGTH),
        lateral: p.z,
        distance: Math.abs(p.y),
      }
    },
    groundHeight(s: number, _lateral: number): number {
      return 0.5 * (s * FLAT_TOTAL_LENGTH)
    },
    surfaceAt(_s: number, lateral: number): Surface {
      return lateral > 2 ? 'dirt' : 'tarmac'
    },
    isInBounds(_s: number, lateral: number): boolean {
      return Math.abs(lateral) <= 10
    },
    checkpointIndexAt(s: number): number {
      return Math.max(0, Math.min(3, Math.floor(wrap01(s) * 4)))
    },
    totalLength(): number {
      return FLAT_TOTAL_LENGTH
    },
  }
}

/**
 * A straight 1000 m track along +X with exactly 3 item boxes and 4 checkpoints.
 * Every `s` here is arc-normalized: the checkpoints sit at 0 m, 250 m, 500 m and
 * 750 m, the item boxes at 100 m, 300 m and 600 m.
 */
export function makeFlatTrack(startPositions: { s: number; lateral: number }[]): Track {
  return {
    id: 'flat',
    name: 'Flat Test Straight',
    controlPoints: [
      { position: { x: 0, y: 0, z: 0 }, width: 20, banking: 0, surface: 'tarmac' },
      { position: { x: 500, y: 0, z: 0 }, width: 20, banking: 0, surface: 'tarmac' },
      { position: { x: 1000, y: 0, z: 0 }, width: 20, banking: 0, surface: 'tarmac' },
    ],
    checkpointS: [0, 0.25, 0.5, 0.75],
    itemBoxes: [
      { s: 0.1, lateral: 0 },
      { s: 0.3, lateral: 2 },
      { s: 0.6, lateral: -2 },
    ],
    ramps: [],
    boostPads: [],
    startPositions,
    bounds: { min: { x: -50, y: -10, z: -50 }, max: { x: 1050, y: 10, z: 50 } },
  }
}

export function makeTestContext(startPositions: { s: number; lateral: number }[]): SimContext {
  const characters: CharacterStats[] = makeCharacters()
  return {
    track: makeFlatTrack(startPositions),
    query: makeFlatQuery(),
    tuning: makeTuning(),
    characters,
    isLeader: true,
  }
}

/**
 * Eight grid slots, 4 m apart. `s` is arc-normalized, so `0.004` is 4 m along the
 * 1000 m lap and `sampleAt` puts that seat at world x = 4. Seat 2 sits 3 m right
 * of the centerline (+z), seat 3 sits 3 m left.
 */
export const EIGHT_STARTS: { s: number; lateral: number }[] = [
  { s: 0, lateral: 0 }, // 0 m
  { s: 0.004, lateral: 0 }, // 4 m
  { s: 0.008, lateral: 3 }, // 8 m
  { s: 0.012, lateral: -3 }, // 12 m
  { s: 0.016, lateral: 0 }, // 16 m
  { s: 0.02, lateral: 0 }, // 20 m
  { s: 0.024, lateral: 0 }, // 24 m
  { s: 0.028, lateral: 0 }, // 28 m
]
```

Now create `packages/sim/test/state.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import { MAX_ENTITIES, MAX_KARTS } from '../src/types'
import { EIGHT_STARTS, makeTestContext } from './helpers/flat-context'
import { createState } from '../src/state'

describe('createState', () => {
  it('places every kart at its start position, facing along the tangent', () => {
    const ctx = makeTestContext(EIGHT_STARTS)
    const st = createState(ctx, 12345, [0, 1, 2, 3, 4, 5, 6, 7])

    // s is arc-normalized. The flat query gives sampleAt(s) = (s * 1000, 0, 0)
    // and tangentAt(s) = (1, 0, 0), so right = (-t.z, 0, t.x) = (0, 0, 1):
    // +lateral offsets toward +z. groundHeight(s) = 0.5 * (s * 1000).
    // Every s * 1000 below is exact in binary floating point (0.004 * 1000 === 4).
    // Seat 0: s = 0,     lateral = 0  -> x = 0,  z = 0,  y = 0.5 * 0  = 0
    expect(st.karts[0].position.x).toBe(0)
    expect(st.karts[0].position.z).toBe(0)
    expect(st.karts[0].position.y).toBe(0)
    // Seat 1: s = 0.004, lateral = 0  -> x = 4,  z = 0,  y = 0.5 * 4  = 2
    expect(st.karts[1].position.x).toBe(4)
    expect(st.karts[1].position.z).toBe(0)
    expect(st.karts[1].position.y).toBe(2)
    // Seat 2: s = 0.008, lateral = 3  -> x = 8 + 0*3 = 8, z = 0 + 1*3 = 3, y = 0.5*8  = 4
    expect(st.karts[2].position.x).toBe(8)
    expect(st.karts[2].position.z).toBe(3)
    expect(st.karts[2].position.y).toBe(4)
    // Seat 3: s = 0.012, lateral = -3 -> x = 12, z = -3, y = 0.5 * 12 = 6
    expect(st.karts[3].position.x).toBe(12)
    expect(st.karts[3].position.z).toBe(-3)
    expect(st.karts[3].position.y).toBe(6)

    // heading = wrapAngle(atan2(t.z, t.x)) = wrapAngle(atan2(0, 1)) = 0
    for (let i = 0; i < MAX_KARTS; i++) {
      expect(st.karts[i].heading).toBe(0)
      expect(st.karts[i].angularVelocity).toBe(0)
      expect(st.karts[i].velocity.x).toBe(0)
      expect(st.karts[i].velocity.y).toBe(0)
      expect(st.karts[i].velocity.z).toBe(0)
    }

    // surfaceAt is consulted with (s, lateral): 'dirt' only where lateral > 2.
    expect(st.karts[2].surface).toBe('dirt')
    expect(st.karts[3].surface).toBe('tarmac')
    expect(st.karts[0].surface).toBe('tarmac')
  })

  it('starts the race in countdown with every counter zeroed', () => {
    const ctx = makeTestContext(EIGHT_STARTS)
    const st = createState(ctx, 12345, [0, 1, 2, 3, 4, 5, 6, 7])

    expect(st.tick).toBe(0)
    expect(st.phase).toBe('countdown')
    expect(st.raceSeed).toBe(12345)
    expect(st.rngCursor).toBe(0)
    expect(st.nextEventSeq).toBe(0)
    expect(st.finishTick).toBe(-1)
    expect(st.entityCount).toBe(0)
    expect(st.nextEntityId).toBe(1)
  })

  it('preallocates every array to its fixed length with dead slots marked -1', () => {
    const ctx = makeTestContext(EIGHT_STARTS)
    const st = createState(ctx, 1, [0, 0, 0, 0, 0, 0, 0, 0])

    expect(st.karts).toHaveLength(MAX_KARTS) // 8
    expect(st.entities).toHaveLength(MAX_ENTITIES) // 32
    expect(st.finishedOrder).toHaveLength(MAX_KARTS) // 8
    expect(st.itemBoxes).toHaveLength(3) // the flat track declares 3 item boxes

    for (let i = 0; i < MAX_ENTITIES; i++) {
      expect(st.entities[i].entityId).toBe(-1)
      expect(st.entities[i].ownerId).toBe(-1)
      expect(st.entities[i].targetId).toBe(-1)
      expect(st.entities[i].ttl).toBe(0)
      expect(st.entities[i].heading).toBe(0)
      expect(st.entities[i].position.x).toBe(0)
      expect(st.entities[i].velocity.z).toBe(0)
    }
    for (let i = 0; i < MAX_KARTS; i++) {
      expect(st.finishedOrder[i]).toBe(-1)
    }
    for (let i = 0; i < 3; i++) {
      expect(st.itemBoxes[i].boxIdx).toBe(i)
      expect(st.itemBoxes[i].respawnTicks).toBe(0)
    }
  })

  it('clamps characterIdx into range and defaults unsupplied seats to 0', () => {
    const ctx = makeTestContext(EIGHT_STARTS)
    // makeCharacters() returns exactly 8 characters, so the valid range is 0..7.
    const st = createState(ctx, 1, [7, 99, -3, 2.9])

    expect(st.karts[0].characterIdx).toBe(7) // in range
    expect(st.karts[1].characterIdx).toBe(7) // 99 clamped down to 8 - 1 = 7
    expect(st.karts[2].characterIdx).toBe(0) // -3 clamped up to 0
    expect(st.karts[3].characterIdx).toBe(2) // 2.9 truncated toward zero
    expect(st.karts[4].characterIdx).toBe(0) // seat not supplied
    expect(st.karts[7].characterIdx).toBe(0) // seat not supplied

    expect(st.karts[0].playerId).toBe(0)
    expect(st.karts[7].playerId).toBe(7)
    expect(st.karts[0].isBot).toBe(true)
    expect(st.karts[0].connected).toBe(false)
    expect(st.karts[0].item).toBe('none')
    expect(st.karts[0].airborne).toBe(false)
    expect(st.karts[0].shielded).toBe(false)
    expect(st.karts[0].spinOutTicks).toBe(0)
    expect(st.karts[0].invulnTicks).toBe(0)
    expect(st.karts[0].boostTicks).toBe(0)
    expect(st.karts[0].respawnTicks).toBe(0)
    expect(st.karts[0].drift.active).toBe(false)
    expect(st.karts[0].drift.dir).toBe(0)
    expect(st.karts[0].drift.charge).toBe(0)
    expect(st.karts[0].lap.lap).toBe(0)
    // The flat track declares 4 checkpoints, so the contract's initial value
    // checkpointS.length - 1 is 3. See the dedicated test below.
    expect(st.karts[0].lap.checkpointIdx).toBe(3)
    expect(st.karts[0].lap.t).toBe(0)
  })

  it('starts every kart behind checkpoint 0, at checkpointS.length - 1', () => {
    const ctx = makeTestContext(EIGHT_STARTS)
    const st = createState(ctx, 1, [])

    // The flat track declares 4 checkpoints (s = 0, 0.25, 0.5, 0.75), so the
    // initial index is 4 - 1 = 3: the kart is credited with the last checkpoint
    // of the notional previous lap, and its first legal crossing is index 0.
    for (let i = 0; i < MAX_KARTS; i++) {
      expect(st.karts[i].lap.checkpointIdx).toBe(3)
      expect(st.karts[i].lap.lap).toBe(0)
      expect(st.karts[i].lap.t).toBe(0)
    }

    // Two checkpoints -> 2 - 1 = 1.
    const twoCtx = makeTestContext(EIGHT_STARTS)
    twoCtx.track = { ...twoCtx.track, checkpointS: [0, 0.5] }
    expect(createState(twoCtx, 1, []).karts[0].lap.checkpointIdx).toBe(1)

    // A track with no checkpoints has no last index at all, so createState
    // writes -1 explicitly instead of computing 0 - 1 and calling it an index.
    const noneCtx = makeTestContext(EIGHT_STARTS)
    noneCtx.track = { ...noneCtx.track, checkpointS: [] }
    expect(createState(noneCtx, 1, []).karts[0].lap.checkpointIdx).toBe(-1)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/sim/test/state.test.ts -t "places every kart at its start position"`

Expected: FAIL with `Failed to resolve import "../src/state"` (the module does not
exist yet).

- [ ] **Step 3: Write `createState`**

Create `packages/sim/src/state.ts`:

```typescript
import type {
  EntityState,
  ItemBoxState,
  KartState,
  SimContext,
  SimState,
} from './types'
import { MAX_ENTITIES, MAX_KARTS } from './types'
import { clamp, wrapAngle } from './mathutil'
import { v3 } from './vec3'

/**
 * Build a fresh race state with every array preallocated to its fixed length.
 *
 * `characterIdx[i]` selects the character for seat `i`; entries that are missing,
 * non-finite, or out of range are truncated and clamped into
 * `[0, ctx.characters.length - 1]`.
 *
 * Karts are placed from `ctx.track.startPositions` using the locked conventions:
 *   right   = (-t.z, 0, t.x), normalized
 *   heading = wrapAngle(atan2(t.z, t.x))
 *   y       = ctx.query.groundHeight(s, lateral)
 * Every `s` here is arc-normalized to [0, 1), never metres.
 * If the track declares fewer start positions than MAX_KARTS, the last one is
 * reused for the remaining seats; if it declares none, seats sit at s = 0.
 */
export function createState(ctx: SimContext, seed: number, characterIdx: number[]): SimState {
  const charCount = ctx.characters.length
  const spCount = ctx.track.startPositions.length

  // A kart on the grid is behind checkpoint 0, i.e. already credited with the
  // last checkpoint of the notional previous lap, so Task 11's
  // `next = cur + 1 >= n ? 0 : cur + 1` targets checkpoint 0 first. A track with
  // no checkpoints has no last index; -1 is written explicitly for that case.
  const cpCount = ctx.track.checkpointS.length
  const initialCheckpointIdx = cpCount > 0 ? cpCount - 1 : -1

  const karts: KartState[] = []
  for (let i = 0; i < MAX_KARTS; i++) {
    const rawIdx = Number(characterIdx[i])
    const ci = Number.isFinite(rawIdx) ? clamp(Math.trunc(rawIdx), 0, charCount - 1) : 0

    const sp = spCount > 0 ? ctx.track.startPositions[Math.min(i, spCount - 1)] : undefined
    const s = sp ? sp.s : 0
    const lateral = sp ? sp.lateral : 0

    const pt = ctx.query.sampleAt(s)
    const tan = ctx.query.tangentAt(s)
    // right = (-t.z, 0, t.x), normalized. Locked convention: +lateral is right.
    const rx = -tan.z
    const rz = tan.x
    const rlen = Math.sqrt(rx * rx + rz * rz)
    const inv = rlen > 0 ? 1 / rlen : 0

    karts.push({
      playerId: i,
      characterIdx: ci,
      isBot: true,
      connected: false,
      position: v3(
        pt.position.x + rx * inv * lateral,
        ctx.query.groundHeight(s, lateral),
        pt.position.z + rz * inv * lateral,
      ),
      velocity: v3(0, 0, 0),
      heading: wrapAngle(Math.atan2(tan.z, tan.x)),
      angularVelocity: 0,
      drift: { active: false, dir: 0, charge: 0 },
      item: 'none',
      airborne: false,
      surface: ctx.query.surfaceAt(s, lateral),
      spinOutTicks: 0,
      invulnTicks: 0,
      boostTicks: 0,
      respawnTicks: 0,
      shielded: false,
      lap: { lap: 0, checkpointIdx: initialCheckpointIdx, t: 0 },
    })
  }

  const entities: EntityState[] = []
  for (let i = 0; i < MAX_ENTITIES; i++) {
    entities.push({
      entityId: -1, // dead-slot sentinel
      kind: 'seeker', // meaningless while entityId === -1, but still copied/compared
      ownerId: -1,
      position: v3(0, 0, 0),
      velocity: v3(0, 0, 0),
      heading: 0,
      targetId: -1,
      ttl: 0,
    })
  }

  const itemBoxes: ItemBoxState[] = []
  for (let i = 0; i < ctx.track.itemBoxes.length; i++) {
    itemBoxes.push({ boxIdx: i, respawnTicks: 0 })
  }

  // Fixed length MAX_KARTS, every slot -1. Tasks 11 and 15 write a finisher into
  // the first slot holding -1; nothing ever pushes, pops or resizes this array,
  // because cloneState below rejects a dst whose lengths differ from src's.
  const finishedOrder: number[] = []
  for (let i = 0; i < MAX_KARTS; i++) {
    finishedOrder.push(-1)
  }

  return {
    tick: 0,
    phase: 'countdown',
    raceSeed: seed,
    rngCursor: 0,
    nextEventSeq: 0,
    finishTick: -1,
    karts,
    entities,
    entityCount: 0,
    nextEntityId: 1,
    itemBoxes,
    finishedOrder,
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/sim/test/state.test.ts`

Expected: PASS — 5 tests in `createState`.

- [ ] **Step 5: Write the failing test for `cloneState` and `statesEqual`**

Change the last import line of `packages/sim/test/state.test.ts` from:

```typescript
import { createState } from '../src/state'
```

to:

```typescript
import { cloneState, createState, statesEqual } from '../src/state'
```

Then append to `packages/sim/test/state.test.ts`:

```typescript
describe('cloneState / statesEqual', () => {
  it('copies every field so the clone is bit-equal to the source', () => {
    const ctx = makeTestContext(EIGHT_STARTS)
    const a = createState(ctx, 99, [0, 1, 2, 3, 4, 5, 6, 7])
    const b = createState(ctx, 0, [0, 0, 0, 0, 0, 0, 0, 0])

    a.tick = 17
    a.phase = 'racing'
    a.rngCursor = 5
    a.nextEventSeq = 11
    a.finishTick = 900
    a.entityCount = 1
    a.nextEntityId = 4
    a.karts[3].velocity.x = 12.5
    a.karts[3].drift.charge = 46
    a.karts[3].lap.lap = 2
    a.entities[0].entityId = 3
    a.entities[0].kind = 'bolt'
    a.entities[0].ownerId = 5
    a.entities[0].ttl = 120
    a.finishedOrder[0] = 6
    a.itemBoxes[2].respawnTicks = 41

    cloneState(a, b)

    expect(statesEqual(a, b)).toBe(true)
    expect(b.tick).toBe(17)
    expect(b.phase).toBe('racing')
    expect(b.raceSeed).toBe(99)
    expect(b.rngCursor).toBe(5)
    expect(b.nextEventSeq).toBe(11)
    expect(b.finishTick).toBe(900)
    expect(b.entityCount).toBe(1)
    expect(b.nextEntityId).toBe(4)
    expect(b.karts[3].characterIdx).toBe(3)
    expect(b.karts[3].velocity.x).toBe(12.5)
    expect(b.karts[3].drift.charge).toBe(46)
    expect(b.karts[3].lap.lap).toBe(2)
    expect(b.entities[0].entityId).toBe(3)
    expect(b.entities[0].kind).toBe('bolt')
    expect(b.entities[0].ownerId).toBe(5)
    expect(b.entities[0].ttl).toBe(120)
    expect(b.finishedOrder[0]).toBe(6)
    expect(b.itemBoxes[2].respawnTicks).toBe(41)
  })

  it('writes into dst in place, reusing every existing object', () => {
    const ctx = makeTestContext(EIGHT_STARTS)
    const a = createState(ctx, 1, [0, 1, 2, 3, 4, 5, 6, 7])
    const b = createState(ctx, 1, [0, 1, 2, 3, 4, 5, 6, 7])

    const kartsRef = b.karts
    const kartRef = b.karts[2]
    const posRef = b.karts[2].position
    const velRef = b.karts[2].velocity
    const driftRef = b.karts[2].drift
    const lapRef = b.karts[2].lap
    const entRef = b.entities[5]
    const entPosRef = b.entities[5].position
    const boxRef = b.itemBoxes[1]

    cloneState(a, b)

    expect(b.karts).toBe(kartsRef)
    expect(b.karts[2]).toBe(kartRef)
    expect(b.karts[2].position).toBe(posRef)
    expect(b.karts[2].velocity).toBe(velRef)
    expect(b.karts[2].drift).toBe(driftRef)
    expect(b.karts[2].lap).toBe(lapRef)
    expect(b.entities[5]).toBe(entRef)
    expect(b.entities[5].position).toBe(entPosRef)
    expect(b.itemBoxes[1]).toBe(boxRef)

    // and it is a deep copy, not an alias
    expect(b.karts[2].position).not.toBe(a.karts[2].position)
    a.karts[2].position.x = 777
    expect(b.karts[2].position.x).toBe(8) // seat 2 sits at s = 0.008 -> x = 8 m
  })

  it('rejects a dst that was not preallocated with the same shape', () => {
    const a = createState(makeTestContext(EIGHT_STARTS), 1, [])
    const smallCtx = makeTestContext(EIGHT_STARTS)
    smallCtx.track = { ...smallCtx.track, itemBoxes: [{ s: 0.01, lateral: 0 }] }
    const b = createState(smallCtx, 1, [])

    expect(a.itemBoxes).toHaveLength(3)
    expect(b.itemBoxes).toHaveLength(1)
    expect(() => cloneState(a, b)).toThrow(
      'cloneState: dst was not preallocated with the same shape as src',
    )
  })

  it('uses Object.is for every scalar: -0 differs from 0, NaN equals NaN', () => {
    const ctx = makeTestContext(EIGHT_STARTS)
    const a = createState(ctx, 5, [])
    const b = createState(ctx, 5, [])
    cloneState(a, b)
    expect(statesEqual(a, b)).toBe(true)

    a.karts[0].position.x = -0
    b.karts[0].position.x = 0
    expect(statesEqual(a, b)).toBe(false) // Object.is(-0, 0) === false

    b.karts[0].position.x = -0
    expect(statesEqual(a, b)).toBe(true)

    a.karts[1].velocity.z = NaN
    expect(statesEqual(a, b)).toBe(false)
    b.karts[1].velocity.z = NaN
    expect(statesEqual(a, b)).toBe(true) // Object.is(NaN, NaN) === true
  })

  it('detects a difference in any field, including dead entity slots', () => {
    const ctx = makeTestContext(EIGHT_STARTS)
    const a = createState(ctx, 5, [0, 1, 2, 3, 4, 5, 6, 7])
    const b = createState(ctx, 5, [0, 1, 2, 3, 4, 5, 6, 7])

    const differsAfter = (mutate: () => void): boolean => {
      cloneState(a, b)
      mutate()
      return statesEqual(a, b)
    }

    expect(differsAfter(() => { b.tick = 1 })).toBe(false)
    expect(differsAfter(() => { b.phase = 'finished' })).toBe(false)
    expect(differsAfter(() => { b.raceSeed = 6 })).toBe(false)
    expect(differsAfter(() => { b.rngCursor = 1 })).toBe(false)
    expect(differsAfter(() => { b.nextEventSeq = 1 })).toBe(false)
    expect(differsAfter(() => { b.finishTick = 0 })).toBe(false)
    expect(differsAfter(() => { b.entityCount = 1 })).toBe(false)
    expect(differsAfter(() => { b.nextEntityId = 2 })).toBe(false)
    expect(differsAfter(() => { b.karts[6].heading = 0.001 })).toBe(false)
    expect(differsAfter(() => { b.karts[6].drift.dir = 1 })).toBe(false)
    expect(differsAfter(() => { b.karts[6].lap.t = 0.5 })).toBe(false)
    expect(differsAfter(() => { b.karts[6].surface = 'boost' })).toBe(false)
    expect(differsAfter(() => { b.karts[6].item = 'bolt' })).toBe(false)
    expect(differsAfter(() => { b.karts[6].shielded = true })).toBe(false)
    expect(differsAfter(() => { b.entities[31].ttl = 1 })).toBe(false)
    expect(differsAfter(() => { b.entities[31].kind = 'slick' })).toBe(false)
    expect(differsAfter(() => { b.finishedOrder[7] = 3 })).toBe(false)
    expect(differsAfter(() => { b.itemBoxes[0].respawnTicks = 1 })).toBe(false)
    expect(differsAfter(() => { /* no mutation */ })).toBe(true)
  })
})
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `npx vitest run packages/sim/test/state.test.ts -t "copies every field so the clone is bit-equal"`

Expected: FAIL with `The requested module '../src/state' does not provide an export named 'cloneState'`.

- [ ] **Step 7: Write `cloneState` and `statesEqual`**

Append to `packages/sim/src/state.ts`:

```typescript
/**
 * Deep-copy `src` into the already-allocated `dst`. Allocates nothing: every
 * object in `dst` is written field by field and reused.
 *
 * All four arrays must already match in length — `karts` (MAX_KARTS),
 * `entities` (MAX_ENTITIES), `itemBoxes` (the track's item-box count) and
 * `finishedOrder` (MAX_KARTS) — which is checked once up front and throws
 * otherwise. That check is what forbids `finishedOrder.push(...)` anywhere in the
 * sim: a 9th entry would make every subsequent clone throw.
 */
export function cloneState(src: SimState, dst: SimState): void {
  if (
    dst.karts.length !== src.karts.length ||
    dst.entities.length !== src.entities.length ||
    dst.itemBoxes.length !== src.itemBoxes.length ||
    dst.finishedOrder.length !== src.finishedOrder.length
  ) {
    throw new Error('cloneState: dst was not preallocated with the same shape as src')
  }

  dst.tick = src.tick
  dst.phase = src.phase
  dst.raceSeed = src.raceSeed
  dst.rngCursor = src.rngCursor
  dst.nextEventSeq = src.nextEventSeq
  dst.finishTick = src.finishTick
  dst.entityCount = src.entityCount
  dst.nextEntityId = src.nextEntityId

  for (let i = 0; i < src.karts.length; i++) {
    const a = src.karts[i]
    const b = dst.karts[i]
    b.playerId = a.playerId
    b.characterIdx = a.characterIdx
    b.isBot = a.isBot
    b.connected = a.connected
    b.position.x = a.position.x
    b.position.y = a.position.y
    b.position.z = a.position.z
    b.velocity.x = a.velocity.x
    b.velocity.y = a.velocity.y
    b.velocity.z = a.velocity.z
    b.heading = a.heading
    b.angularVelocity = a.angularVelocity
    b.drift.active = a.drift.active
    b.drift.dir = a.drift.dir
    b.drift.charge = a.drift.charge
    b.item = a.item
    b.airborne = a.airborne
    b.surface = a.surface
    b.spinOutTicks = a.spinOutTicks
    b.invulnTicks = a.invulnTicks
    b.boostTicks = a.boostTicks
    b.respawnTicks = a.respawnTicks
    b.shielded = a.shielded
    b.lap.lap = a.lap.lap
    b.lap.checkpointIdx = a.lap.checkpointIdx
    b.lap.t = a.lap.t
  }

  for (let i = 0; i < src.entities.length; i++) {
    const a = src.entities[i]
    const b = dst.entities[i]
    b.entityId = a.entityId
    b.kind = a.kind
    b.ownerId = a.ownerId
    b.position.x = a.position.x
    b.position.y = a.position.y
    b.position.z = a.position.z
    b.velocity.x = a.velocity.x
    b.velocity.y = a.velocity.y
    b.velocity.z = a.velocity.z
    b.heading = a.heading
    b.targetId = a.targetId
    b.ttl = a.ttl
  }

  for (let i = 0; i < src.itemBoxes.length; i++) {
    dst.itemBoxes[i].boxIdx = src.itemBoxes[i].boxIdx
    dst.itemBoxes[i].respawnTicks = src.itemBoxes[i].respawnTicks
  }

  for (let i = 0; i < src.finishedOrder.length; i++) {
    dst.finishedOrder[i] = src.finishedOrder[i]
  }
}

/**
 * Bit-exact structural equality. Every scalar is compared with `Object.is`, so
 * -0 !== 0 and NaN === NaN. Dead entity slots are compared too: despawn leaves
 * deterministic residue, and the checkpoint-replay equivalence test depends on
 * that residue matching.
 */
export function statesEqual(a: SimState, b: SimState): boolean {
  if (
    !Object.is(a.tick, b.tick) ||
    !Object.is(a.phase, b.phase) ||
    !Object.is(a.raceSeed, b.raceSeed) ||
    !Object.is(a.rngCursor, b.rngCursor) ||
    !Object.is(a.nextEventSeq, b.nextEventSeq) ||
    !Object.is(a.finishTick, b.finishTick) ||
    !Object.is(a.entityCount, b.entityCount) ||
    !Object.is(a.nextEntityId, b.nextEntityId)
  ) {
    return false
  }
  if (
    a.karts.length !== b.karts.length ||
    a.entities.length !== b.entities.length ||
    a.itemBoxes.length !== b.itemBoxes.length ||
    a.finishedOrder.length !== b.finishedOrder.length
  ) {
    return false
  }

  for (let i = 0; i < a.karts.length; i++) {
    const x = a.karts[i]
    const y = b.karts[i]
    if (
      !Object.is(x.playerId, y.playerId) ||
      !Object.is(x.characterIdx, y.characterIdx) ||
      !Object.is(x.isBot, y.isBot) ||
      !Object.is(x.connected, y.connected) ||
      !Object.is(x.position.x, y.position.x) ||
      !Object.is(x.position.y, y.position.y) ||
      !Object.is(x.position.z, y.position.z) ||
      !Object.is(x.velocity.x, y.velocity.x) ||
      !Object.is(x.velocity.y, y.velocity.y) ||
      !Object.is(x.velocity.z, y.velocity.z) ||
      !Object.is(x.heading, y.heading) ||
      !Object.is(x.angularVelocity, y.angularVelocity) ||
      !Object.is(x.drift.active, y.drift.active) ||
      !Object.is(x.drift.dir, y.drift.dir) ||
      !Object.is(x.drift.charge, y.drift.charge) ||
      !Object.is(x.item, y.item) ||
      !Object.is(x.airborne, y.airborne) ||
      !Object.is(x.surface, y.surface) ||
      !Object.is(x.spinOutTicks, y.spinOutTicks) ||
      !Object.is(x.invulnTicks, y.invulnTicks) ||
      !Object.is(x.boostTicks, y.boostTicks) ||
      !Object.is(x.respawnTicks, y.respawnTicks) ||
      !Object.is(x.shielded, y.shielded) ||
      !Object.is(x.lap.lap, y.lap.lap) ||
      !Object.is(x.lap.checkpointIdx, y.lap.checkpointIdx) ||
      !Object.is(x.lap.t, y.lap.t)
    ) {
      return false
    }
  }

  for (let i = 0; i < a.entities.length; i++) {
    const x = a.entities[i]
    const y = b.entities[i]
    if (
      !Object.is(x.entityId, y.entityId) ||
      !Object.is(x.kind, y.kind) ||
      !Object.is(x.ownerId, y.ownerId) ||
      !Object.is(x.position.x, y.position.x) ||
      !Object.is(x.position.y, y.position.y) ||
      !Object.is(x.position.z, y.position.z) ||
      !Object.is(x.velocity.x, y.velocity.x) ||
      !Object.is(x.velocity.y, y.velocity.y) ||
      !Object.is(x.velocity.z, y.velocity.z) ||
      !Object.is(x.heading, y.heading) ||
      !Object.is(x.targetId, y.targetId) ||
      !Object.is(x.ttl, y.ttl)
    ) {
      return false
    }
  }

  for (let i = 0; i < a.itemBoxes.length; i++) {
    if (
      !Object.is(a.itemBoxes[i].boxIdx, b.itemBoxes[i].boxIdx) ||
      !Object.is(a.itemBoxes[i].respawnTicks, b.itemBoxes[i].respawnTicks)
    ) {
      return false
    }
  }

  for (let i = 0; i < a.finishedOrder.length; i++) {
    if (!Object.is(a.finishedOrder[i], b.finishedOrder[i])) {
      return false
    }
  }

  return true
}
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `npx vitest run packages/sim/test/state.test.ts`

Expected: PASS — 10 tests (5 in `createState`, 5 in `cloneState / statesEqual`).

- [ ] **Step 9: Write the failing test for `emit`**

Change the two import lines at the top of `packages/sim/test/state.test.ts` from:

```typescript
import { MAX_ENTITIES, MAX_KARTS } from '../src/types'
```

to:

```typescript
import type { AuthEvent } from '../src/types'
import { MAX_ENTITIES, MAX_KARTS } from '../src/types'
```

and from:

```typescript
import { cloneState, createState, statesEqual } from '../src/state'
```

to:

```typescript
import { cloneState, createState, emit, statesEqual } from '../src/state'
```

Then append to `packages/sim/test/state.test.ts`:

```typescript
describe('emit', () => {
  it('stamps a monotonic eventSeq and the current tick onto every event', () => {
    const ctx = makeTestContext(EIGHT_STARTS)
    const st = createState(ctx, 1, [])
    st.tick = 42

    const out: AuthEvent[] = []
    emit(st, out, 'itemGrant', 3, -1, 'boost', 0)
    emit(st, out, 'entitySpawn', 3, 7, 'none', 2)

    expect(out).toHaveLength(2)

    expect(out[0].eventSeq).toBe(0) // nextEventSeq started at 0
    expect(out[0].tick).toBe(42)
    expect(out[0].kind).toBe('itemGrant')
    expect(out[0].playerId).toBe(3)
    expect(out[0].entityId).toBe(-1)
    expect(out[0].item).toBe('boost')
    expect(out[0].data).toBe(0)

    expect(out[1].eventSeq).toBe(1)
    expect(out[1].tick).toBe(42)
    expect(out[1].kind).toBe('entitySpawn')
    expect(out[1].entityId).toBe(7)
    expect(out[1].item).toBe('none')
    expect(out[1].data).toBe(2)

    expect(st.nextEventSeq).toBe(2) // 0 and 1 consumed

    st.tick = 43
    emit(st, out, 'finish', 0, -1, 'none', 1)
    expect(out[2].eventSeq).toBe(2)
    expect(out[2].tick).toBe(43)
    expect(st.nextEventSeq).toBe(3)
  })

  it('appends to the caller array without touching earlier entries', () => {
    const ctx = makeTestContext(EIGHT_STARTS)
    const st = createState(ctx, 1, [])
    const out: AuthEvent[] = []
    for (let i = 0; i < 5; i++) {
      st.tick = i
      emit(st, out, 'hit', i, -1, 'none', i * 2)
    }
    expect(out).toHaveLength(5)
    for (let i = 0; i < 5; i++) {
      expect(out[i].eventSeq).toBe(i)
      expect(out[i].tick).toBe(i)
      expect(out[i].playerId).toBe(i)
      expect(out[i].data).toBe(i * 2)
    }
    expect(st.nextEventSeq).toBe(5)
  })
})
```

- [ ] **Step 10: Run the test to verify it fails**

Run: `npx vitest run packages/sim/test/state.test.ts -t "stamps a monotonic eventSeq"`

Expected: FAIL with `The requested module '../src/state' does not provide an export named 'emit'`.

- [ ] **Step 11: Write `emit`**

First extend the type import at the top of `packages/sim/src/state.ts` from:

```typescript
import type {
  EntityState,
  ItemBoxState,
  KartState,
  SimContext,
  SimState,
} from './types'
```

to:

```typescript
import type {
  AuthEvent,
  AuthEventKind,
  EntityState,
  ItemBoxState,
  ItemKind,
  KartState,
  SimContext,
  SimState,
} from './types'
```

Then append to `packages/sim/src/state.ts`:

```typescript
/**
 * Append an authoritative event, stamping it with the state's monotonic
 * `nextEventSeq` and the state's current `tick`. This is the only allocation in
 * the sim, and it is per-event rather than per-tick.
 *
 * `entityId` is -1 when not applicable, `item` is 'none' when not applicable and
 * `data` is 0 when unused.
 */
export function emit(
  state: SimState,
  out: AuthEvent[],
  kind: AuthEventKind,
  playerId: number,
  entityId: number,
  item: ItemKind,
  data: number,
): void {
  out.push({
    eventSeq: state.nextEventSeq++,
    tick: state.tick,
    kind,
    playerId,
    entityId,
    item,
    data,
  })
}
```

- [ ] **Step 12: Run the test to verify it passes**

Run: `npx vitest run packages/sim/test/state.test.ts`

Expected: PASS — 12 tests (5 + 5 + 2).

- [ ] **Step 13: Write the failing test for `step`**

Create `packages/sim/test/step.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import type { AuthEvent, SimState } from '../src/types'
import { EIGHT_STARTS, makeTestContext } from './helpers/flat-context'
import { createState, statesEqual } from '../src/state'
import { step } from '../src/step'

describe('step', () => {
  // Every kart here stays at rest with no intents, so the only observable effect
  // of a tick is the tick counter. That stays true once Task 6 wires stepKart in:
  // at zero speed with a neutral intent, stepKart's yaw, longitudinal and lateral
  // terms are all exactly zero.
  it('advances the tick by exactly one and changes nothing else', () => {
    const ctx = makeTestContext(EIGHT_STARTS)
    const prev = createState(ctx, 7, [0, 1, 2, 3, 4, 5, 6, 7])
    const next = createState(ctx, 7, [0, 1, 2, 3, 4, 5, 6, 7])

    prev.tick = 7
    prev.nextEventSeq = 9
    prev.rngCursor = 4
    prev.karts[1].item = 'seeker'
    prev.karts[1].lap.lap = 2
    prev.finishedOrder[0] = 5
    prev.itemBoxes[0].respawnTicks = 30

    const events: AuthEvent[] = []
    step(ctx, prev, next, [], events)

    expect(next.tick).toBe(8)
    expect(prev.tick).toBe(7) // prev is never written
    expect(next.nextEventSeq).toBe(9)
    expect(next.rngCursor).toBe(4)
    expect(next.karts[1].item).toBe('seeker')
    expect(next.karts[1].lap.lap).toBe(2)
    expect(next.finishedOrder[0]).toBe(5)
    expect(next.itemBoxes[0].respawnTicks).toBe(30)

    next.tick = prev.tick
    expect(statesEqual(prev, next)).toBe(true)
  })

  it('writes only into next, never aliasing or reallocating', () => {
    const ctx = makeTestContext(EIGHT_STARTS)
    const prev = createState(ctx, 7, [0, 1, 2, 3, 4, 5, 6, 7])
    const next = createState(ctx, 7, [0, 1, 2, 3, 4, 5, 6, 7])

    const kartsRef = next.karts
    const posRef = next.karts[2].position
    step(ctx, prev, next, [], [])

    expect(next.karts).toBe(kartsRef)
    expect(next.karts[2].position).toBe(posRef)
    expect(next.karts[2].position).not.toBe(prev.karts[2].position)

    next.karts[2].position.x = 123
    expect(prev.karts[2].position.x).toBe(8) // seat 2 starts at s = 0.008 -> x = 8 m
  })

  it('counts ticks correctly when the caller double-buffers', () => {
    const ctx = makeTestContext(EIGHT_STARTS)
    let cur: SimState = createState(ctx, 7, [0, 1, 2, 3, 4, 5, 6, 7])
    let nxt: SimState = createState(ctx, 7, [0, 1, 2, 3, 4, 5, 6, 7])
    const events: AuthEvent[] = []

    for (let i = 0; i < 10; i++) {
      step(ctx, cur, nxt, [], events)
      const tmp = cur
      cur = nxt
      nxt = tmp
    }

    expect(cur.tick).toBe(10)
    expect(cur.karts[3].position.x).toBe(12) // seat 3 never moved: s = 0.012 -> x = 12 m
    expect(cur.karts[3].position.z).toBe(-3)
    expect(events).toHaveLength(0)
  })
})
```

- [ ] **Step 14: Run the test to verify it fails**

Run: `npx vitest run packages/sim/test/step.test.ts -t "advances the tick by exactly one"`

Expected: FAIL with `Failed to resolve import "../src/step"`.

- [ ] **Step 15: Write `step`**

Create `packages/sim/src/step.ts`:

```typescript
import type { AuthEvent, Intent, SimContext, SimState } from './types'
import { cloneState } from './state'

/**
 * Advance the simulation by exactly one 60Hz tick.
 *
 * The tick starts by copying `prev` into `next`; every stage after that writes
 * only into `next`, which is what makes "never mutates prev" true globally.
 * `step` never reads the wall clock and never calls Math.random().
 *
 * The canonical per-kart stage order, filled in by later tasks, is:
 *   1. resolveInputs      [Task 15]
 *   2. updateRecovery     [Task 9]
 *   3. updateDrift        [Task 8]
 *   4. stepKart           [Task 6]
 *   5. applyAirYaw        [Task 7]
 *   6. integrateVertical  [Task 7]
 *   7. applyRamps         [Task 7]
 *   8. decayBoost         [Task 8]
 *   9. updateLaps         [Task 11]
 * then, once per tick after the kart loop:
 *   resolveKartCollisions [Task 10] -> updateEntities [Task 12]
 *   -> updateItemBoxes    [Task 13] -> updatePhase    [Task 15]
 */
export function step(
  ctx: SimContext,
  prev: SimState,
  next: SimState,
  inputs: Intent[],
  events: AuthEvent[],
): void {
  void ctx // used from Task 6 onward
  void inputs // used from Task 6 onward
  void events // used from Task 9 onward

  cloneState(prev, next)
  next.tick = prev.tick + 1
}
```

- [ ] **Step 16: Run the test to verify it passes**

Run: `npx vitest run packages/sim/test/step.test.ts`

Expected: PASS — 3 tests.

- [ ] **Step 17: Run the whole sim suite and the typecheck**

Run: `npx vitest run packages/sim && npx tsc --noEmit -p packages/sim`

Expected: PASS — every `packages/sim` test green (15 new tests from this task —
12 in `state.test.ts`, 3 in `step.test.ts` — plus everything from Tasks 2–4), and
`tsc` reports no errors.

- [ ] **Step 18: Commit**

```bash
git add packages/sim/src/state.ts packages/sim/src/step.ts \
        packages/sim/test/state.test.ts packages/sim/test/step.test.ts \
        packages/sim/test/helpers/flat-context.ts
git commit -m "feat(sim): SimState create/clone/equal/emit and the tick skeleton"
```
