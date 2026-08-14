### Task 11: Lap validation and race placement

**Files:**
- Create: `packages/sim/src/laps.ts`
- Create: `packages/sim/src/placement.ts`
- Modify: `packages/sim/src/step.ts` — one import and one insertion, exact before/after in Step 11
- Test: `packages/sim/test/laps.test.ts`
- Test: `packages/sim/test/placement.test.ts`

**Interfaces:**

- Consumes (already exist, do not redefine):
  - `packages/sim/src/types.ts` — `Vec3`, `Surface`, `ItemKind`, `EntityKind`, `RacePhase`, `LapProgress`, `DriftState`, `KartState`, `EntityState`, `ItemBoxState`, `SimState`, `AuthEvent`, `AuthEventKind`, `Intent`, `Track`, `TrackPoint`, `TrackQuery`, `TrackProjection`, `Tuning`, `CharacterStats`, `SimContext`, and the constants `TICK_HZ = 60`, `TICK_DT = 1/60`, `MAX_KARTS = 8`, `MAX_ENTITIES = 32`, `RACE_LAPS = 3`, `COUNTDOWN_TICKS = 180`.
  - `packages/sim/src/mathutil.ts` — `export function clamp(v: number, lo: number, hi: number): number`
  - `packages/sim/src/state.ts` — `export function emit(state: SimState, out: AuthEvent[], kind: AuthEventKind, playerId: number, entityId: number, item: ItemKind, data: number): void`. It appends exactly one `AuthEvent` to `out` with `eventSeq = state.nextEventSeq++` and `tick = state.tick`.
  - `packages/sim/src/step.ts` [Task 5, extended by 6–10] — `export function step(ctx: SimContext, prev: SimState, next: SimState, inputs: Intent[], events: AuthEvent[]): void`. It clones `prev` into `next`, sets `next.tick = prev.tick + 1`, and runs a per-kart loop whose locals are `k` (`next.karts[i]`), `prevKart` (`prev.karts[i]`) and `raw` (that kart's intent). This task appends `updateLaps` as the **last** statement of that loop body, per the contract's canonical order.
  - `packages/sim/test/fixtures/track-fixtures.ts` — `export function makeTuning(overrides?: Partial<Tuning>): Tuning`, `export function makeCharacters(): CharacterStats[]`.
  - `ctx.query: TrackQuery` — `project(p: Vec3): TrackProjection` (`{ s, lateral, distance }`) and `checkpointIndexAt(s: number): number`. These are the only two query methods this task calls.
  - `createState(ctx, seed, characterIdx)` gives every kart `lap = { lap: 0, checkpointIdx: track.checkpointS.length - 1, t: 0 }`, because karts start *behind* the s = 0 start/finish line. `updateLaps` depends on that starting value: a kart that starts at `checkpointIdx = 0` would need four line crossings to finish a three-lap race. The local `blankKart` helper in `laps.test.ts` deliberately repeats that default (`checkpointIdx: 3` on this file's 4-checkpoint stub track) instead of importing `makeKart` from `test/helpers/flat-context.ts`, so this file's stub track and its checkpoint count stay owned by this file. `placement.test.ts`'s local helper uses `checkpointIdx: 0` because placement never reads a track at all — it only compares the stored triple.

- **`s` is arc-normalised.** The contract fixes `TrackQuery.project().s`, `Track.checkpointS[i]` and every `s` argument in this package as a value in `[0, 1)`, never metres. A lap distance in metres is only ever reached by multiplying an `s`-delta by `query.totalLength()`, and `updateLaps` never needs to: every quantity it computes is a ratio of `s`-deltas, so the lap length cancels out.

- Produces (later tasks rely on exactly these):
  - `packages/sim/src/laps.ts` — `export function updateLaps(ctx: SimContext, state: SimState, k: KartState, events: AuthEvent[]): void`
  - `packages/sim/src/placement.ts` — `export function placementOrder(state: SimState): number[]` (leader first, allocates) and `export function computePlacement(state: SimState, outIndexOf: Int32Array, outOrder: Int32Array): void` (zero-alloc; both arrays must be length `MAX_KARTS`; `outOrder[place] = playerId`, `outIndexOf[playerId] = place`).

- Rules fixed by this task, relied on by Tasks 12–15:
  - Checkpoint index **0 is the start/finish line**. A lap increments when, and only when, a kart enters checkpoint segment 0 from segment `N-1`.
  - `k.lap.t` is the fraction `[0, 1]` of the way from `checkpointS[checkpointIdx]` to the next checkpoint, and is only written while the kart is inside its own current segment. Off-segment excursions (backwards or shortcut) leave `t` frozen.
  - **`finishedOrder` is fixed length `MAX_KARTS`**, exactly as `createState` allocates it: finishers are written into the lowest slot still holding the `-1` sentinel, and the array is **never** `push`ed to or truncated. Growing it changes the state's shape, and `cloneState` throws `'cloneState: dst was not preallocated with the same shape as src'` the moment `prev` and `next` disagree — which would take out `recordRun`, `replayRun` and the golden run with it. The number of finishers is therefore *derived*: it is the count of entries `!== -1`, which for a front-packed array is the index of the first `-1`.
  - The **`finish` event's `data` is the 1-based finishing place** (first finisher `1`, second `2`, …), i.e. `slot + 1` for the slot just written. Task 15's DNF path emits the same 1-based place.
  - `finishedOrder` takes precedence over `(lap, checkpointIdx, t)` in placement.
  - Placement ties break on `playerId` ascending, so the order is total and deterministic.
  - Every `playerId` is in `[0, MAX_KARTS)` — it is a 3-bit wire field — so it can index an `Int32Array(MAX_KARTS)` directly.

---

- [ ] **Step 1: Write the failing test for lap validation**

Create `packages/sim/test/laps.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import type {
  AuthEvent, EntityState, KartState, SimContext, SimState, Track, TrackQuery,
} from '../src/types'
import { MAX_ENTITIES, MAX_KARTS, RACE_LAPS } from '../src/types'
import { makeCharacters, makeTuning } from './fixtures/track-fixtures'
import { updateLaps } from '../src/laps'

// A stub track: a 400 m loop whose arc-normalised parameter is simply the
// kart's x divided by the lap length, wrapped into [0, 1). The contract fixes
// `s` as arc-normalised everywhere in this package -- never metres -- so
// checkpointS holds 0 / 0.25 / 0.5 / 0.75 and every segment is a quarter lap
// (100 m of the 400 m loop). Checkpoint 0 is the start/finish line.
//
// project() follows the locked convention right = (-t.z, 0, t.x); for the +X
// tangent (1,0,0) that is (0,0,1), so lateral is +z.
//
// Every kart x below is a multiple of 12.5 m, which is exactly 1/32 of a lap,
// so every s is a dyadic rational and every t assertion in this file is exact
// in binary floating point rather than approximate.
const TRACK_LEN = 400

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
    bounds: { min: { x: -1000, y: -10, z: -1000 }, max: { x: 1000, y: 10, z: 1000 } },
  }
  const query: TrackQuery = {
    sampleAt: (s) => ({
      position: { x: wrap01(s) * TRACK_LEN, y: 0, z: 0 },
      width: 20,
      banking: 0,
      surface: 'tarmac',
    }),
    tangentAt: () => ({ x: 1, y: 0, z: 0 }),
    project: (p) => ({ s: wrap01(p.x / TRACK_LEN), lateral: p.z, distance: Math.abs(p.z) }),
    groundHeight: () => 0,
    surfaceAt: () => 'tarmac',
    isInBounds: (_s, lateral) => Math.abs(lateral) <= 10,
    checkpointIndexAt: (s) => Math.min(3, Math.floor(wrap01(s) * 4)),
    totalLength: () => TRACK_LEN,
  }
  return { track, query, tuning: makeTuning(), characters: makeCharacters(), isLeader: true }
}

// checkpointIdx 3 is what createState [Task 5] gives every kart on a
// 4-checkpoint track: karts start behind the s = 0 line holding the last
// checkpoint, so the first crossing of the line is worth a lap.
function blankKart(playerId: number): KartState {
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
    tick: 500,
    phase: 'racing',
    raceSeed: 12345,
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

describe('updateLaps', () => {
  it('advances the checkpoint index when the next checkpoint is crossed in order', () => {
    const ctx = stubContext()
    const state = blankState()
    const k = state.karts[0]
    const events: AuthEvent[] = []
    k.lap.lap = 0
    k.lap.checkpointIdx = 0
    k.lap.t = 0.5
    k.position.x = 137.5 // s = 137.5 / 400 = 0.34375 -> segment 1, which starts at s = 0.25

    updateLaps(ctx, state, k, events)

    expect(k.lap.checkpointIdx).toBe(1)
    // t = (0.34375 - 0.25) / (0.5 - 0.25) = 0.09375 / 0.25 = 0.375
    expect(k.lap.t).toBe(0.375)
    expect(k.lap.lap).toBe(0)
    expect(events.length).toBe(0)
  })

  it('increments the lap when the finish line is crossed with every checkpoint hit', () => {
    const ctx = stubContext()
    const state = blankState()
    const k = state.karts[4]
    const events: AuthEvent[] = []
    k.lap.lap = 0
    k.lap.checkpointIdx = 3
    k.lap.t = 0.9
    k.position.x = 412.5 // 412.5 / 400 = 1.03125 -> wraps to s = 0.03125 -> segment 0

    updateLaps(ctx, state, k, events)

    expect(k.lap.checkpointIdx).toBe(0)
    expect(k.lap.lap).toBe(1)
    // t = (0.03125 - 0) / (0.25 - 0) = 0.125
    expect(k.lap.t).toBe(0.125)
    expect(events.length).toBe(1)
    expect(events[0].kind).toBe('lapCross')
    expect(events[0].playerId).toBe(4)
    expect(events[0].entityId).toBe(-1)
    expect(events[0].item).toBe('none')
    expect(events[0].data).toBe(1) // the new lap number
    expect(events[0].eventSeq).toBe(0)
    expect(events[0].tick).toBe(500)
    expect(state.nextEventSeq).toBe(1)
    // no finisher yet, so every fixed slot still holds the -1 sentinel
    expect(state.finishedOrder).toEqual([-1, -1, -1, -1, -1, -1, -1, -1])
    expect(state.finishTick).toBe(-1)
  })

  it('does not advance when a checkpoint is crossed backwards', () => {
    const ctx = stubContext()
    const state = blankState()
    const k = state.karts[1]
    const events: AuthEvent[] = []
    k.lap.lap = 1
    k.lap.checkpointIdx = 2
    k.lap.t = 0.05
    k.position.x = 187.5 // s = 0.46875 -> segment 1, i.e. BEHIND checkpoint 2

    updateLaps(ctx, state, k, events)

    expect(k.lap.checkpointIdx).toBe(2) // unchanged: 1 is neither 2 nor 3
    expect(k.lap.lap).toBe(1)
    expect(k.lap.t).toBe(0.05) // frozen while off-segment
    expect(events.length).toBe(0)

    // driving forward again into its own segment resumes t updates only
    k.position.x = 250 // s = 0.625 -> segment 2
    updateLaps(ctx, state, k, events)
    expect(k.lap.checkpointIdx).toBe(2)
    expect(k.lap.lap).toBe(1)
    // t = (0.625 - 0.5) / (0.75 - 0.5) = 0.125 / 0.25 = 0.5
    expect(k.lap.t).toBe(0.5)
    expect(events.length).toBe(0)
  })

  it('does not advance when a checkpoint is skipped', () => {
    const ctx = stubContext()
    const state = blankState()
    const k = state.karts[2]
    const events: AuthEvent[] = []
    k.lap.lap = 0
    k.lap.checkpointIdx = 0
    k.lap.t = 0.9
    k.position.x = 250 // s = 0.625 -> segment 2, skipping checkpoint 1

    updateLaps(ctx, state, k, events)

    expect(k.lap.checkpointIdx).toBe(0)
    expect(k.lap.t).toBe(0.9)
    expect(k.lap.lap).toBe(0)
    expect(events.length).toBe(0)
  })

  it('does not decrement the lap when the finish line is crossed backwards', () => {
    const ctx = stubContext()
    const state = blankState()
    const k = state.karts[3]
    const events: AuthEvent[] = []
    k.lap.lap = 2
    k.lap.checkpointIdx = 0
    k.lap.t = 0.02
    k.position.x = 375 // s = 0.9375 -> segment 3, i.e. back across the line

    updateLaps(ctx, state, k, events)

    expect(k.lap.lap).toBe(2)
    expect(k.lap.checkpointIdx).toBe(0)
    expect(k.lap.t).toBe(0.02)
    expect(events.length).toBe(0)

    // driving forward again lands back in segment 0, which the kart already
    // holds, so it only resumes t: no second lap for the same crossing
    k.position.x = 25 // s = 0.0625 -> segment 0
    updateLaps(ctx, state, k, events)
    expect(k.lap.lap).toBe(2)
    expect(k.lap.checkpointIdx).toBe(0)
    // t = (0.0625 - 0) / (0.25 - 0) = 0.25
    expect(k.lap.t).toBe(0.25)
    expect(events.length).toBe(0)
  })

  it('records the finish once at RACE_LAPS and never again', () => {
    const ctx = stubContext()
    const state = blankState()
    state.tick = 1234
    const k = state.karts[6]
    const events: AuthEvent[] = []
    k.lap.lap = RACE_LAPS - 1 // 2
    k.lap.checkpointIdx = 3
    k.lap.t = 0.8
    k.position.x = 412.5 // s = 0.03125 -> segment 0

    updateLaps(ctx, state, k, events)

    expect(k.lap.lap).toBe(3)
    // written into slot 0; the other seven slots keep the -1 sentinel
    expect(state.finishedOrder).toEqual([6, -1, -1, -1, -1, -1, -1, -1])
    expect(state.finishTick).toBe(1234)
    expect(events.length).toBe(2)
    expect(events[0].kind).toBe('lapCross')
    expect(events[0].data).toBe(3)
    expect(events[0].eventSeq).toBe(0)
    expect(events[1].kind).toBe('finish')
    expect(events[1].playerId).toBe(6)
    expect(events[1].entityId).toBe(-1)
    expect(events[1].item).toBe('none')
    expect(events[1].data).toBe(1) // 1-based finishing place: slot 0 + 1
    expect(events[1].eventSeq).toBe(1)
    expect(events[1].tick).toBe(1234)

    // a fourth line crossing still counts the lap but must not re-finish
    state.tick = 1600
    k.lap.checkpointIdx = 3
    k.position.x = 812.5 // 812.5 / 400 = 2.03125 -> wraps to s = 0.03125 -> segment 0
    updateLaps(ctx, state, k, events)

    expect(k.lap.lap).toBe(4)
    expect(state.finishedOrder).toEqual([6, -1, -1, -1, -1, -1, -1, -1])
    expect(state.finishTick).toBe(1234)
    expect(events.length).toBe(3)
    expect(events[2].kind).toBe('lapCross')
    expect(events[2].data).toBe(4)
  })

  it('sets finishTick from the first finisher only and keeps finishedOrder in crossing order', () => {
    const ctx = stubContext()
    const state = blankState()
    const events: AuthEvent[] = []

    const a = state.karts[5]
    a.lap.lap = 2
    a.lap.checkpointIdx = 3
    a.position.x = 412.5 // s = 0.03125 -> segment 0
    state.tick = 900
    updateLaps(ctx, state, a, events)

    const b = state.karts[2]
    b.lap.lap = 2
    b.lap.checkpointIdx = 3
    b.position.x = 425 // 425 / 400 = 1.0625 -> wraps to s = 0.0625 -> segment 0
    state.tick = 950
    updateLaps(ctx, state, b, events)

    // slots fill front to back; the six unused slots keep the -1 sentinel
    expect(state.finishedOrder).toEqual([5, 2, -1, -1, -1, -1, -1, -1])
    expect(state.finishTick).toBe(900)
    // 2 events per finisher: lapCross then finish
    expect(events.length).toBe(4)
    expect(events[1].kind).toBe('finish')
    expect(events[1].playerId).toBe(5)
    expect(events[1].data).toBe(1)
    expect(events[3].kind).toBe('finish')
    expect(events[3].playerId).toBe(2)
    expect(events[3].data).toBe(2) // second place: slot 1 + 1
    expect(events[3].tick).toBe(950)
  })
})
```

- [ ] **Step 2: Run the lap test to verify it fails**

Run: `npx vitest run packages/sim/test/laps.test.ts`
Expected: FAIL with `Failed to resolve import "../src/laps" from "packages/sim/test/laps.test.ts"`.

- [ ] **Step 3: Implement `packages/sim/src/laps.ts`**

Create `packages/sim/src/laps.ts`:

```ts
import type { AuthEvent, KartState, SimContext, SimState } from './types'
import { RACE_LAPS } from './types'
import { clamp } from './mathutil'
import { emit } from './state'

/**
 * Fraction [0,1] of the way from checkpoint `idx` to the next checkpoint, for a
 * kart at arc-normalised `s`. Every `s` in this package is in [0, 1) and never
 * metres, so the segment that wraps past the start/finish line ends at
 * `checkpointS[0] + 1` -- one whole lap on -- and a negative delta is corrected
 * by adding a whole lap, not a track length. The lap length never appears here:
 * `t` is a ratio of two s-deltas, so it cancels out.
 */
function segmentT(ctx: SimContext, idx: number, s: number): number {
  const cps = ctx.track.checkpointS
  const n = cps.length
  const start = cps[idx]
  const end = idx + 1 < n ? cps[idx + 1] : cps[0] + 1
  const span = end - start
  if (span <= 0) return 0
  let ds = s - start
  if (ds < 0) ds += 1
  return clamp(ds / span, 0, 1)
}

/** True when `playerId` already holds one of the fixed finish slots. */
function hasFinished(state: SimState, playerId: number): boolean {
  const order = state.finishedOrder
  for (let i = 0; i < order.length; i++) {
    if (order[i] === playerId) return true
  }
  return false
}

/**
 * The lowest slot still holding the -1 sentinel, or -1 when all MAX_KARTS slots
 * are taken. `finishedOrder` is fixed length and is never pushed to: growing it
 * changes the state's shape, and cloneState throws the moment `prev` and `next`
 * disagree. Because slots fill front to back, this index is also the count of
 * entries that are already !== -1, i.e. the 0-based finishing place.
 */
function nextFinishSlot(state: SimState): number {
  const order = state.finishedOrder
  for (let i = 0; i < order.length; i++) {
    if (order[i] === -1) return i
  }
  return -1
}

/**
 * Checkpoint ring validation. Checkpoint 0 is the start/finish line.
 * A kart is credited only for entering the segment immediately after the one
 * it currently holds; driving backwards over a checkpoint, or skipping one,
 * changes nothing. Crossing into segment 0 from segment N-1 completes a lap.
 */
export function updateLaps(
  ctx: SimContext,
  state: SimState,
  k: KartState,
  events: AuthEvent[],
): void {
  const n = ctx.track.checkpointS.length
  if (n < 2) return

  const s = ctx.query.project(k.position).s
  const idx = ctx.query.checkpointIndexAt(s)
  const cur = k.lap.checkpointIdx
  const next = cur + 1 >= n ? 0 : cur + 1

  if (idx === cur) {
    k.lap.t = segmentT(ctx, cur, s)
    return
  }
  // Backwards over a checkpoint, or a skipped checkpoint: no credit, and t
  // stays frozen at whatever it was when the kart left its own segment.
  if (idx !== next) return

  k.lap.checkpointIdx = idx
  k.lap.t = segmentT(ctx, idx, s)
  if (idx !== 0) return // an ordinary checkpoint, not the finish line

  k.lap.lap += 1
  emit(state, events, 'lapCross', k.playerId, -1, 'none', k.lap.lap)

  if (k.lap.lap < RACE_LAPS) return
  if (hasFinished(state, k.playerId)) return
  const slot = nextFinishSlot(state)
  if (slot < 0) return // every seat has already finished
  state.finishedOrder[slot] = k.playerId
  if (state.finishTick < 0) state.finishTick = state.tick
  // The contract fixes the finish event's data as the 1-based finishing place,
  // and slot is the 0-based one.
  emit(state, events, 'finish', k.playerId, -1, 'none', slot + 1)
}
```

- [ ] **Step 4: Run the lap test to verify it passes**

Run: `npx vitest run packages/sim/test/laps.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Write the failing test for race placement**

Create `packages/sim/test/placement.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import type { EntityState, KartState, SimState } from '../src/types'
import { MAX_ENTITIES, MAX_KARTS } from '../src/types'
import { computePlacement, placementOrder } from '../src/placement'

// checkpointIdx 0 here is arbitrary: placement never consults a track, only the
// stored (lap, checkpointIdx, t) triple, and every test below overwrites it.
function blankKart(playerId: number): KartState {
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
    tick: 0,
    phase: 'racing',
    raceSeed: 7,
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

function setLap(state: SimState, playerId: number, lap: number, cp: number, t: number): void {
  const k = state.karts[playerId]
  k.lap.lap = lap
  k.lap.checkpointIdx = cp
  k.lap.t = t
}

/**
 * Record finishers the way updateLaps does: into the fixed slots, front to
 * back, never by pushing. `pids` is the crossing order.
 */
function setFinished(state: SimState, pids: number[]): void {
  for (let i = 0; i < pids.length; i++) state.finishedOrder[i] = pids[i]
}

// Grid used by every test below (checkpoint indices are from an 8-checkpoint
// track; placement never consults the track, only the stored triple):
//   p0 (2, 5, 0.90)   p1 (2, 5, 0.10)   p2 (3, 0, 0.00)   p3 (1, 7, 0.50)
//   p4 (2, 6, 0.20)   p5 (3, 0, 0.10)   p6 (0, 0, 0.00)   p7 (2, 5, 0.90)
function gridState(): SimState {
  const state = blankState()
  setLap(state, 0, 2, 5, 0.9)
  setLap(state, 1, 2, 5, 0.1)
  setLap(state, 2, 3, 0, 0.0)
  setLap(state, 3, 1, 7, 0.5)
  setLap(state, 4, 2, 6, 0.2)
  setLap(state, 5, 3, 0, 0.1)
  setLap(state, 6, 0, 0, 0.0)
  setLap(state, 7, 2, 5, 0.9)
  return state
}

describe('placementOrder', () => {
  it('sorts leader first by (lap, checkpointIdx, t) descending with playerId breaking ties', () => {
    const state = gridState()

    // lap 3: p5 (t 0.10) ahead of p2 (t 0.00)
    // lap 2: p4 (cp 6) ahead of cp 5, where p0 and p7 tie at t 0.90 and p0
    //        wins on the lower playerId, then p1 at t 0.10
    // lap 1: p3.  lap 0: p6.
    expect(placementOrder(state)).toEqual([5, 2, 4, 0, 7, 1, 3, 6])
  })

  it('gives finishedOrder precedence over lap progress', () => {
    const state = gridState()
    setFinished(state, [2, 5])
    expect(state.finishedOrder).toEqual([2, 5, -1, -1, -1, -1, -1, -1])

    // p2 crossed the line first even though p5 has the larger t, so p2 is P1.
    // The six -1 slots are not karts and must not rank anything.
    expect(placementOrder(state)).toEqual([2, 5, 4, 0, 7, 1, 3, 6])
  })
})

describe('computePlacement', () => {
  it('fills outOrder and outIndexOf as exact inverses with no finishers', () => {
    const state = gridState()
    const indexOf = new Int32Array(MAX_KARTS)
    const order = new Int32Array(MAX_KARTS)

    computePlacement(state, indexOf, order)

    expect(Array.from(order)).toEqual([5, 2, 4, 0, 7, 1, 3, 6])
    // place of p0..p7: p0->3 p1->5 p2->1 p3->6 p4->2 p5->0 p6->7 p7->4
    expect(Array.from(indexOf)).toEqual([3, 5, 1, 6, 2, 0, 7, 4])
    for (let place = 0; place < MAX_KARTS; place++) {
      expect(indexOf[order[place]]).toBe(place)
    }
  })

  it('fills outOrder and outIndexOf with finishedOrder taking precedence', () => {
    const state = gridState()
    setFinished(state, [2, 5])
    const indexOf = new Int32Array(MAX_KARTS)
    const order = new Int32Array(MAX_KARTS)

    computePlacement(state, indexOf, order)

    expect(Array.from(order)).toEqual([2, 5, 4, 0, 7, 1, 3, 6])
    // place of p0..p7: p0->3 p1->5 p2->0 p3->6 p4->2 p5->1 p6->7 p7->4
    expect(Array.from(indexOf)).toEqual([3, 5, 0, 6, 2, 1, 7, 4])
  })

  it('agrees with placementOrder in every case, and allocates nothing on repeat calls', () => {
    const indexOf = new Int32Array(MAX_KARTS)
    const order = new Int32Array(MAX_KARTS)

    const plain = gridState()
    computePlacement(plain, indexOf, order)
    expect(Array.from(order)).toEqual(placementOrder(plain))

    const finished = gridState()
    setFinished(finished, [2, 5])
    computePlacement(finished, indexOf, order)
    expect(Array.from(order)).toEqual(placementOrder(finished))

    // all eight finished, in a deliberately non-progress order: every slot is
    // taken, so no -1 is left
    const allDone = gridState()
    const crossing = [7, 3, 0, 6, 1, 4, 2, 5]
    setFinished(allDone, crossing)
    expect(allDone.finishedOrder).toEqual(crossing)
    computePlacement(allDone, indexOf, order)
    expect(Array.from(order)).toEqual(crossing)
    expect(Array.from(order)).toEqual(placementOrder(allDone))
    expect(Array.from(indexOf)).toEqual([2, 4, 6, 1, 5, 7, 3, 0])

    // reusing the same out-arrays must overwrite completely, not merge
    computePlacement(plain, indexOf, order)
    expect(Array.from(order)).toEqual([5, 2, 4, 0, 7, 1, 3, 6])
    expect(Array.from(indexOf)).toEqual([3, 5, 1, 6, 2, 0, 7, 4])
  })
})
```

- [ ] **Step 6: Run the placement test to verify it fails**

Run: `npx vitest run packages/sim/test/placement.test.ts`
Expected: FAIL with `Failed to resolve import "../src/placement" from "packages/sim/test/placement.test.ts"`.

- [ ] **Step 7: Implement `packages/sim/src/placement.ts`**

Create `packages/sim/src/placement.ts`:

```ts
import type { KartState, SimState } from './types'
import { MAX_KARTS } from './types'

// Module-level scratch: placement runs every tick, so it must not allocate.
// playerId is a 3-bit wire field, so it always indexes safely into these.
const finishRank = new Int32Array(MAX_KARTS)
const slotOrder = new Int32Array(MAX_KARTS)

/**
 * `state.finishedOrder` is fixed length MAX_KARTS with -1 in every slot that has
 * no finisher yet, so the `pid >= 0` guard is what skips the empty slots.
 */
function fillFinishRank(state: SimState): void {
  for (let i = 0; i < MAX_KARTS; i++) finishRank[i] = -1
  const order = state.finishedOrder
  for (let i = 0; i < order.length; i++) {
    const pid = order[i]
    if (pid >= 0 && pid < MAX_KARTS) finishRank[pid] = i
  }
}

/**
 * Negative when `a` is ahead of `b`. Reads `finishRank`, so `fillFinishRank`
 * must run first. A finisher always outranks a non-finisher; among finishers
 * the crossing order wins; otherwise (lap, checkpointIdx, t) descending, with
 * playerId ascending as the tie-break that makes the order total.
 */
function comparePlacement(a: KartState, b: KartState): number {
  const ra = finishRank[a.playerId]
  const rb = finishRank[b.playerId]
  if (ra >= 0 || rb >= 0) {
    if (ra >= 0 && rb >= 0) return ra - rb
    return ra >= 0 ? -1 : 1
  }
  if (a.lap.lap !== b.lap.lap) return b.lap.lap - a.lap.lap
  if (a.lap.checkpointIdx !== b.lap.checkpointIdx) {
    return b.lap.checkpointIdx - a.lap.checkpointIdx
  }
  if (a.lap.t !== b.lap.t) return a.lap.t < b.lap.t ? 1 : -1
  return a.playerId - b.playerId
}

/**
 * Zero-alloc placement. `outOrder[place] = playerId` (leader at place 0),
 * `outIndexOf[playerId] = place`. Both arrays must be length MAX_KARTS.
 * Insertion sort over 8 karts: no allocation, no comparator closure.
 */
export function computePlacement(
  state: SimState,
  outIndexOf: Int32Array,
  outOrder: Int32Array,
): void {
  fillFinishRank(state)
  const karts = state.karts
  for (let i = 0; i < MAX_KARTS; i++) {
    let j = i - 1
    while (j >= 0 && comparePlacement(karts[slotOrder[j]], karts[i]) > 0) {
      slotOrder[j + 1] = slotOrder[j]
      j--
    }
    slotOrder[j + 1] = i
  }
  for (let place = 0; place < MAX_KARTS; place++) {
    const pid = karts[slotOrder[place]].playerId
    outOrder[place] = pid
    outIndexOf[pid] = place
  }
}

/**
 * Allocating convenience form of the same ordering, leader first. Not for the
 * hot path — use computePlacement there.
 */
export function placementOrder(state: SimState): number[] {
  fillFinishRank(state)
  const karts = state.karts
  const slots: number[] = []
  for (let i = 0; i < MAX_KARTS; i++) slots.push(i)
  slots.sort((a, b) => comparePlacement(karts[a], karts[b]))
  const out: number[] = []
  for (let i = 0; i < slots.length; i++) out.push(karts[slots[i]].playerId)
  return out
}
```

- [ ] **Step 8: Run the placement test to verify it passes**

Run: `npx vitest run packages/sim/test/placement.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 9: Write the failing test for the `step()` wiring**

`updateLaps` is slot 9 of the contract's canonical per-kart order — the last
per-kart call — and nothing calls it yet. Two edits to
`packages/sim/test/laps.test.ts`.

**9a.** Change the type-only import at the top of the file. Before:

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

**9b.** Change the last import line. Before:

```ts
import { updateLaps } from '../src/laps'
```

After:

```ts
import { updateLaps } from '../src/laps'
import { step } from '../src/step'
```

**9c.** Append this suite to the end of the file:

```ts
describe('step() wiring', () => {
  it('runs updateLaps for every kart as the last per-kart stage', () => {
    const ctx = stubContext()
    const prev = blankState()
    const next = blankState()
    prev.tick = 700
    prev.phase = 'racing'

    // Kart 0 sits just past the start/finish line still holding the last
    // checkpoint, so updateLaps owes it a lap: x = 412.5 -> s = 0.03125,
    // which is checkpoint segment 0.
    prev.karts[0].position.x = 412.5
    prev.karts[0].lap.lap = 0
    prev.karts[0].lap.checkpointIdx = 3
    // Everyone else is spaced 20 m apart (far past kartRadius 0.9, so
    // resolveKartCollisions never fires) and holds checkpoint 1. They sit in
    // segments 0 and 1, neither of which is checkpoint 2, so none of them is
    // credited anything and none of them emits.
    for (let i = 1; i < MAX_KARTS; i++) {
      prev.karts[i].position.x = 412.5 + 20 * i
      prev.karts[i].lap.checkpointIdx = 1
    }

    const inputs: Intent[] = []
    for (let i = 0; i < MAX_KARTS; i++) {
      inputs.push({
        tick: 700, steer: 0, accel: 0, brake: false, drift: false, useItem: false,
      })
    }
    const events: AuthEvent[] = []

    step(ctx, prev, next, inputs, events)

    expect(next.tick).toBe(701)
    expect(next.karts[0].lap.checkpointIdx).toBe(0)
    expect(next.karts[0].lap.lap).toBe(1)
    // Every kart is at rest with accel 0, so stepKart moves nobody and the
    // lap arithmetic is the same as the direct call above:
    // t = (0.03125 - 0) / (0.25 - 0) = 0.125
    expect(next.karts[0].lap.t).toBe(0.125)

    expect(events.length).toBe(1)
    expect(events[0].kind).toBe('lapCross')
    expect(events[0].playerId).toBe(0)
    expect(events[0].data).toBe(1)
    // updateLaps runs against `next`, whose tick is already prev.tick + 1
    expect(events[0].tick).toBe(701)

    // step never mutates prev
    expect(prev.karts[0].lap.lap).toBe(0)
    expect(prev.karts[0].lap.checkpointIdx).toBe(3)
    expect(prev.tick).toBe(700)
  })
})
```

- [ ] **Step 10: Run the wiring test to verify it fails**

Run: `npx vitest run packages/sim/test/laps.test.ts -t "step() wiring"`
Expected: FAIL with `expected 3 to be 0` — `step()` does not call `updateLaps`, so
kart 0's `checkpointIdx` is still the 3 it was cloned with.

- [ ] **Step 11: Wire `updateLaps` into `step()`**

Two edits in `packages/sim/src/step.ts`.

**11a.** Add the import. Before (the `./kart` import Task 6 added):

```ts
import { stepKart } from './kart'
```

After:

```ts
import { stepKart } from './kart'
import { updateLaps } from './laps'
```

**11b.** Append the call to the per-kart loop body. `decayBoost(k)` is the last
statement of that body and the file's only call to `decayBoost` (Task 8 put it
there as canonical slot 8). Before:

```ts
    decayBoost(k)
```

After:

```ts
    decayBoost(k)
    updateLaps(ctx, next, k, events)
```

`updateLaps` must stay last in the loop body: it reads the position the kart
finished the tick at, so anything that still moves the kart — steering, the
integrator, ramps — has to have run already. `events` is a live parameter here;
Task 9's `updateRecovery` wiring already deleted the `void events` line Task 5
left behind.

- [ ] **Step 12: Run the wiring test to verify it passes**

Run: `npx vitest run packages/sim/test/laps.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 13: Typecheck and run the whole sim suite**

Run: `npx tsc --noEmit -p packages/sim && npx vitest run packages/sim`
Expected: no TypeScript output, and every existing sim test still passes alongside the 13 new ones.

- [ ] **Step 14: Commit**

```bash
git add packages/sim/src/laps.ts packages/sim/src/placement.ts packages/sim/src/step.ts \
        packages/sim/test/laps.test.ts packages/sim/test/placement.test.ts
git commit -m "feat(sim): checkpoint-ordered lap validation and race placement

updateLaps credits only the next checkpoint in the ring, so driving
backwards over a checkpoint or skipping one earns nothing. Crossing
checkpoint 0 from the last segment completes a lap; the RACE_LAPS-th
crossing writes the finisher into the lowest free slot of the
fixed-length finishedOrder, sets finishTick once, and emits lapCross
plus finish, whose data is the 1-based finishing place.

step() now calls updateLaps as the last per-kart stage, canonical
slot 9.

placementOrder / computePlacement sort leader-first by (lap,
checkpointIdx, t) descending with finishedOrder taking precedence and
playerId breaking ties. computePlacement is the zero-alloc out-param
form used per tick."
```
