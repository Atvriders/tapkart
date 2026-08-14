### Task 2: Gate emit() on ctx.isLeader at all eleven call sites

**A contract gap found and resolved while writing this brief.** Contract §2a states "Only the two `entity.ts` helpers change shape" (`spawnEntity`, `despawnEntityAt`). I read `recovery.ts` and grepped every call site of `startSpinOut` in `packages/sim/src`: it is defined in `recovery.ts` with signature `startSpinOut(state, k, ticks, events)` — **no `ctx` parameter** — and it has exactly one caller anywhere in `src`, `entity.ts`'s `updateEntities` (`startSpinOut(state, k, ctx.tuning.spinOutTicks, events)`), which already has `ctx` in scope. `startSpinOut` is also where the `'spinOut'` `AuthEvent` in contract §1b's eleven-site enumeration ("recovery.ts (spinOut, respawn)") is emitted. Gating that `emit()` call on `ctx.isLeader`, and gating it without skipping the call entirely (skipping would stop a follower from spinning out at all, which contract §1b forbids: "a follower's simulation is unchanged"), requires `ctx` to be reachable inside `startSpinOut`. There is no way to satisfy "gate all eleven sites" and "a non-leader's simulation is unchanged" and "only the two `entity.ts` helpers change shape" simultaneously — the third clause is incomplete. This brief resolves it the same way contract §2a already resolves `spawnEntity`/`despawnEntityAt`: `startSpinOut` also gains a `ctx: SimContext` first parameter. Its one `src` caller and its six test call sites are updated in Step 12.

**Verified count of the eleven sites** (grepped `packages/sim/src/*.ts` for `\bemit(`): `recovery.ts` lines 66 (`startSpinOut`, kind `'spinOut'`) and 162 (`beginRespawn`, kind `'respawn'`); `laps.ts` lines 97 (`'lapCross'`) and 107 (`'finish'`); `entity.ts` lines 76 (`spawnEntity`, `'entitySpawn'`), 97 (`despawnEntityAt`, `'entityDespawn'`), 256 and 258 (`updateEntities`, both `'hit'` — one shielded branch with `data 1`, one unshielded branch with `data 0`); `items.ts` line 136 (`'itemGrant'`, already wrapped in `if (ctx.isLeader)`); `phase.ts` lines 219 and 226 (both `'finish'`, both already wrapped in `if (ctx.isLeader)`). That is eleven, matching the contract. Three are already gated (`items.ts`'s one, `phase.ts`'s two) — matching contract §1b's "Plan 1 gates 3 of 11" — and this task gates the other eight.

**Files:**
- Modify: `packages/sim/src/laps.ts` (2 sites gated, no signature change)
- Modify: `packages/sim/src/recovery.ts` (2 sites gated; `startSpinOut` gains `ctx`)
- Modify: `packages/sim/src/entity.ts` (4 sites gated; `spawnEntity` and `despawnEntityAt` gain `ctx`; internal callers updated)
- Modify: `packages/sim/src/items.ts` (six `spawnEntity` call sites inside `useItem` thread `ctx` — no gating change, `useItem` was already correctly ungated)
- Modify: `packages/sim/test/laps.test.ts`, `packages/sim/test/recovery.test.ts`, `packages/sim/test/entity.test.ts` (follower context support, signature-threading fallout, new follower-parity tests)

**Interfaces:**

- Consumes (verified against the files as they exist before this task):
  - `packages/sim/src/types.ts` — `SimContext` (has `isLeader: boolean`), `AuthEvent`, `KartState`, `SimState`, `EntityKind`, `Vec3`.
  - `packages/sim/src/state.ts` — `emit(state, out, kind, playerId, entityId, item, data): void`, `statesEqual`, `createState`. Unchanged.
  - `packages/sim/src/step.ts` — `step(ctx, prev, next, inputs, events): void`. Unchanged; this task changes nothing in `step.ts` because every function it calls keeps its own call-site shape (`updateRecovery`, `updateLaps`, `updateEntities`, `updateItemBoxes`, `useItem`, `updatePhase` all already take `ctx` and none of their own signatures changes).
  - `packages/sim/test/fixtures/track-fixtures.ts` — `makeContext(track, isLeader = true)`, already follower-capable, used unchanged by the one new step-level test in this task.

- Produces (exact shapes later tasks and `net`/`server` rely on):
  - `export function startSpinOut(ctx: SimContext, state: SimState, k: KartState, ticks: number, events: AuthEvent[]): void` — **signature changed**, `ctx` prepended. This is the deviation from contract §2a's literal text, justified above.
  - `export function spawnEntity(ctx: SimContext, state: SimState, kind: EntityKind, ownerId: number, position: Vec3, heading: number, targetId: number, ttl: number, events: AuthEvent[]): number` — matches contract §2a exactly.
  - `export function despawnEntityAt(ctx: SimContext, state: SimState, idx: number, events: AuthEvent[]): void` — matches contract §2a exactly.
  - Every one of the eight sites this task touches now reads `if (ctx.isLeader) emit(...)` (or, for `startSpinOut`/`beginRespawn`, an equivalent single-line guard) instead of an unconditional `emit(...)`. A follower's simulation is unchanged: the state mutation that accompanies each event (spin-out timer, respawn timer/position, lap/checkpoint/finish bookkeeping, entity pool contents, `shielded` flag) happens exactly as before; only the `emit()` call is skipped.

---

- [ ] **Step 1: `laps.test.ts` — let its context be a follower**

`updateLaps` already takes `ctx` as its first parameter, so gating its two `emit` calls needs no signature change anywhere — only a way for the test file to build a follower `SimContext`. In `packages/sim/test/laps.test.ts`, widen `stubContext`. Before:

```ts
function stubContext(): SimContext {
```

After:

```ts
function stubContext(isLeader = true): SimContext {
```

And its return statement. Before:

```ts
  return { track, query, tuning: makeTuning(), characters: makeCharacters(), isLeader: true }
}
```

After:

```ts
  return { track, query, tuning: makeTuning(), characters: makeCharacters(), isLeader }
}
```

Run: `npx vitest run packages/sim/test/laps.test.ts`
Expected: PASS — every existing call site of `stubContext()` still gets `isLeader: true` via the default parameter, so nothing's behavior changes yet.

- [ ] **Step 2: Write the failing test — `updateLaps` on a follower**

Append to `packages/sim/test/laps.test.ts`, at the end of the file (after `describe('updateLaps', ...)`'s closing `})`):

```ts

describe('updateLaps on a follower', () => {
  it('crosses the line and finishes exactly as a leader does, but announces nothing', () => {
    const leaderCtx = stubContext(true)
    const followerCtx = stubContext(false)
    const leaderState = blankState()
    const followerState = blankState()
    const leaderKart = leaderState.karts[1]
    const followerKart = followerState.karts[1]
    // s = 4 / 400 = 0.01, inside checkpoint 0's [0, 0.25) range; checkpointIdx 3
    // (the last of four) plus lap 2 means this crossing completes lap 3.
    leaderKart.position.x = 4
    leaderKart.lap = { lap: 2, checkpointIdx: 3, t: 0.99 }
    followerKart.position.x = 4
    followerKart.lap = { lap: 2, checkpointIdx: 3, t: 0.99 }
    const leaderEvents: AuthEvent[] = []
    const followerEvents: AuthEvent[] = []

    updateLaps(leaderCtx, leaderState, leaderKart, leaderEvents)
    updateLaps(followerCtx, followerState, followerKart, followerEvents)

    // Simulation identical: both complete lap 3 and both finish.
    expect(followerKart.lap.lap).toBe(leaderKart.lap.lap)
    expect(followerKart.lap.lap).toBe(3)
    expect(followerKart.lap.checkpointIdx).toBe(leaderKart.lap.checkpointIdx)
    expect(followerState.finishedOrder[0]).toBe(leaderState.finishedOrder[0])
    expect(followerState.finishedOrder[0]).toBe(1)
    expect(followerState.finishTick).toBe(leaderState.finishTick)

    // Announcement suppressed on the follower only.
    expect(leaderEvents.length).toBe(2)
    expect(leaderEvents[0].kind).toBe('lapCross')
    expect(leaderEvents[1].kind).toBe('finish')
    expect(followerEvents.length).toBe(0)
    expect(leaderState.nextEventSeq).toBe(2)
    expect(followerState.nextEventSeq).toBe(0)
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run packages/sim/test/laps.test.ts -t "crosses the line and finishes"`
Expected: FAIL — `expect(followerEvents.length).toBe(0)` reports `AssertionError: expected 2 to be 0`. `updateLaps` currently emits on every caller regardless of `ctx.isLeader`.

- [ ] **Step 4: Gate `laps.ts`'s two `emit` calls**

In `packages/sim/src/laps.ts`. Before:

```ts
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

After:

```ts
  k.lap.lap += 1
  // A non-leader never emits (contract §0); the crossing still happened.
  if (ctx.isLeader) emit(state, events, 'lapCross', k.playerId, -1, 'none', k.lap.lap)

  if (k.lap.lap < RACE_LAPS) return
  if (hasFinished(state, k.playerId)) return
  const slot = nextFinishSlot(state)
  if (slot < 0) return // every seat has already finished
  state.finishedOrder[slot] = k.playerId
  if (state.finishTick < 0) state.finishTick = state.tick
  // The contract fixes the finish event's data as the 1-based finishing place,
  // and slot is the 0-based one.
  if (ctx.isLeader) emit(state, events, 'finish', k.playerId, -1, 'none', slot + 1)
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run packages/sim/test/laps.test.ts`
Expected: PASS — every test in the file.

---

- [ ] **Step 6: `recovery.test.ts` — let its context be a follower**

In `packages/sim/test/recovery.test.ts`, widen `makeCtx`. Before:

```ts
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
```

After:

```ts
function makeCtx(overrides?: Partial<Tuning>, isLeader = true): SimContext {
  return {
    // Four checkpoints, arc-normalised: 0 m, 100 m, 200 m, 300 m along the stub.
    track: makeStraightTrack({ checkpointS: [0, 0.25, 0.5, 0.75] }),
    query: stubQuery(),
    tuning: makeTuning(overrides),
    characters: makeCharacters(),
    isLeader,
  }
}
```

Run: `npx vitest run packages/sim/test/recovery.test.ts`
Expected: PASS — the default `isLeader = true` preserves every existing call site.

- [ ] **Step 7: Write the failing test — `beginRespawn`'s `'respawn'` event on a follower**

In `packages/sim/test/recovery.test.ts`, insert a new test into `describe('respawn', ...)` immediately after `'starts a respawn on the tick the kart leaves the bounds'`. Before:

```ts
    expect(events[0].eventSeq).toBe(0)
    expect(state.nextEventSeq).toBe(1)
  })

  it('interpolates linearly toward the last checkpoint', () => {
```

After:

```ts
    expect(events[0].eventSeq).toBe(0)
    expect(state.nextEventSeq).toBe(1)
  })

  it('respawns identically on a follower, but announces nothing', () => {
    const leaderCtx = makeCtx()
    const followerCtx = makeCtx(undefined, false)
    const leaderState = makeSimState()
    const followerState = makeSimState()
    const leaderKart = outOfBoundsKart(leaderState)
    const followerKart = outOfBoundsKart(followerState)
    const leaderEvents: AuthEvent[] = []
    const followerEvents: AuthEvent[] = []

    updateRecovery(leaderCtx, leaderState, leaderKart, leaderEvents)
    updateRecovery(followerCtx, followerState, followerKart, followerEvents)

    expect(followerKart.respawnTicks).toBe(leaderKart.respawnTicks)
    expect(followerKart.respawnTicks).toBe(72)
    expect(followerKart.position.x).toBe(leaderKart.position.x)
    expect(followerKart.position.z).toBe(leaderKart.position.z)
    expect(leaderEvents.length).toBe(1)
    expect(leaderEvents[0].kind).toBe('respawn')
    expect(followerEvents.length).toBe(0)
    expect(followerState.nextEventSeq).toBe(0)
    expect(leaderState.nextEventSeq).toBe(1)
  })

  it('interpolates linearly toward the last checkpoint', () => {
```

- [ ] **Step 8: Run test to verify it fails**

Run: `npx vitest run packages/sim/test/recovery.test.ts -t "respawns identically on a follower"`
Expected: FAIL — `expect(followerEvents.length).toBe(0)` reports `AssertionError: expected 1 to be 0`.

- [ ] **Step 9: Gate `beginRespawn`'s `emit` call**

In `packages/sim/src/recovery.ts`. Before:

```ts
  k.respawnTicks = t.respawnTicks > 0 ? t.respawnTicks : 0
  emit(state, events, 'respawn', k.playerId, -1, 'none', k.respawnTicks)
  if (k.respawnTicks === 0) {
```

After:

```ts
  k.respawnTicks = t.respawnTicks > 0 ? t.respawnTicks : 0
  // A non-leader never emits (contract §0); the respawn still happened.
  if (ctx.isLeader) emit(state, events, 'respawn', k.playerId, -1, 'none', k.respawnTicks)
  if (k.respawnTicks === 0) {
```

- [ ] **Step 10: Run test to verify it passes**

Run: `npx vitest run packages/sim/test/recovery.test.ts -t "respawns identically on a follower"`
Expected: PASS.

Run: `npx vitest run packages/sim/test/recovery.test.ts`
Expected: PASS — every test in the file (the `startSpinOut` tests are untouched so far and still pass; Step 12 changes their call shape).

---

- [ ] **Step 11: Run tsc to see the shape of the coming change**

This step is a preview, not a fix — run it to see the real error text Step 12 responds to, so the RED prediction below is verified rather than guessed. `startSpinOut` currently has signature `(state, k, ticks, events)`. Step 12 both prepends `ctx` to its definition and updates every call site in the same edit, so there is no intermediate state where the suite is actually red; this step exists only to record what *would* happen if the definition changed alone.

(No command to run here — proceed directly to Step 12, which changes the definition and every call site together.)

- [ ] **Step 12: Thread `ctx` through `startSpinOut` — definition, its one `src` caller, and its six test call sites**

In `packages/sim/src/recovery.ts`, change `startSpinOut`'s signature and doc comment. Before:

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

After:

```ts
/**
 * The only sanctioned way to put a kart into a spin-out. Tasks 12 and 13 call
 * this; nothing else writes `k.spinOutTicks`.
 *
 * Refused outright while the kart is invulnerable or respawning, and it never
 * shortens a spin already running. The `'spinOut'` event is emitted only when
 * the timer actually changes AND the caller is the leader (Plan 2 Task 2), so
 * counting events on a leader counts real spin-outs; a follower spins the kart
 * out identically and announces nothing.
 */
export function startSpinOut(
  ctx: SimContext,
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
  if (ctx.isLeader) emit(state, events, 'spinOut', k.playerId, -1, 'none', ticks)
}
```

In `packages/sim/src/entity.ts`, update `startSpinOut`'s one `src` call site inside `updateEntities`. Before:

```ts
        // startSpinOut is the contract's sole writer of spinOutTicks and it
        // emits the 'spinOut' event itself.
        startSpinOut(state, k, ctx.tuning.spinOutTicks, events)
```

After:

```ts
        // startSpinOut is the contract's sole writer of spinOutTicks and it
        // emits the 'spinOut' event itself.
        startSpinOut(ctx, state, k, ctx.tuning.spinOutTicks, events)
```

In `packages/sim/test/recovery.test.ts`, six call sites inside `describe('startSpinOut', ...)`.

Call site 1, in `'arms the timer and emits one spinOut event'`. Before:

```ts
  it('arms the timer and emits one spinOut event', () => {
    const state = makeSimState()
    const k = state.karts[3]
    k.drift.active = true
    k.drift.dir = 1
    k.drift.charge = 120
    k.boostTicks = 30
    const events: AuthEvent[] = []

    startSpinOut(state, k, 60, events)
```

After:

```ts
  it('arms the timer and emits one spinOut event', () => {
    const ctx = makeCtx()
    const state = makeSimState()
    const k = state.karts[3]
    k.drift.active = true
    k.drift.dir = 1
    k.drift.charge = 120
    k.boostTicks = 30
    const events: AuthEvent[] = []

    startSpinOut(ctx, state, k, 60, events)
```

Call site 2, in `'is refused while the kart is invulnerable'`. Before:

```ts
  it('is refused while the kart is invulnerable', () => {
    const state = makeSimState()
    const k = state.karts[0]
    k.invulnTicks = 5
    const events: AuthEvent[] = []

    startSpinOut(state, k, 60, events)
```

After:

```ts
  it('is refused while the kart is invulnerable', () => {
    const ctx = makeCtx()
    const state = makeSimState()
    const k = state.karts[0]
    k.invulnTicks = 5
    const events: AuthEvent[] = []

    startSpinOut(ctx, state, k, 60, events)
```

Call site 3, in `'is refused while the kart is respawning'`. Before:

```ts
  it('is refused while the kart is respawning', () => {
    const state = makeSimState()
    const k = state.karts[0]
    k.respawnTicks = 10
    const events: AuthEvent[] = []

    startSpinOut(state, k, 60, events)
```

After:

```ts
  it('is refused while the kart is respawning', () => {
    const ctx = makeCtx()
    const state = makeSimState()
    const k = state.karts[0]
    k.respawnTicks = 10
    const events: AuthEvent[] = []

    startSpinOut(ctx, state, k, 60, events)
```

Call site 4 (three calls in one test), in `'never shortens a spin-out already in progress'`. Before:

```ts
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
```

After:

```ts
  it('never shortens a spin-out already in progress', () => {
    const ctx = makeCtx()
    const state = makeSimState()
    const k = state.karts[0]
    const events: AuthEvent[] = []

    startSpinOut(ctx, state, k, 40, events)
    expect(k.spinOutTicks).toBe(40)
    expect(events.length).toBe(1)

    startSpinOut(ctx, state, k, 20, events) // shorter: ignored, no second event
    expect(k.spinOutTicks).toBe(40)
    expect(events.length).toBe(1)

    startSpinOut(ctx, state, k, 60, events) // longer: extends, and does emit
    expect(k.spinOutTicks).toBe(60)
    expect(events.length).toBe(2)
    expect(events[1].data).toBe(60)
  })
```

Call site 5, in `'ignores a non-positive duration'`. Before:

```ts
  it('ignores a non-positive duration', () => {
    const state = makeSimState()
    const k = state.karts[0]
    const events: AuthEvent[] = []

    startSpinOut(state, k, 0, events)
```

After:

```ts
  it('ignores a non-positive duration', () => {
    const ctx = makeCtx()
    const state = makeSimState()
    const k = state.karts[0]
    const events: AuthEvent[] = []

    startSpinOut(ctx, state, k, 0, events)
```

Call site 6, in `'runs a full spin-out through updateRecovery with exactly one event'` (this test already has `const ctx = makeCtx()`; only its `startSpinOut` call changes). Before:

```ts
    const events: AuthEvent[] = []

    startSpinOut(state, k, ctx.tuning.spinOutTicks, events)
    expect(k.spinOutTicks).toBe(60)
```

After:

```ts
    const events: AuthEvent[] = []

    startSpinOut(ctx, state, k, ctx.tuning.spinOutTicks, events)
    expect(k.spinOutTicks).toBe(60)
```

- [ ] **Step 13: Run test to verify the threading compiles and every existing assertion still passes**

Run: `npx tsc --noEmit -p packages/sim`
Expected: no output, exit code 0 — `startSpinOut`'s one `src` caller and all six test call sites now match its new five-parameter shape.

Run: `npx vitest run packages/sim/test/recovery.test.ts`
Expected: PASS — every test, unchanged in behavior. Gating has not been added yet in this step; `ctx` is threaded but `startSpinOut`'s `emit` call is still unconditional, and every test built its `ctx` with the default `isLeader = true`, so nothing observable moved.

- [ ] **Step 14: Write the failing test — `startSpinOut`'s `'spinOut'` event on a follower**

Append to `describe('startSpinOut', ...)` in `packages/sim/test/recovery.test.ts`, as the last test before its closing `})`. Before:

```ts
    // 20 * 0.94^60
    expect(k.velocity.x).toBeCloseTo(20 * Math.pow(0.94, 60), 12)
  })
})
```

After:

```ts
    // 20 * 0.94^60
    expect(k.velocity.x).toBeCloseTo(20 * Math.pow(0.94, 60), 12)
  })

  it('spins out identically on a follower, but announces nothing', () => {
    const leaderCtx = makeCtx()
    const followerCtx = makeCtx(undefined, false)
    const leaderState = makeSimState()
    const followerState = makeSimState()
    const leaderKart = leaderState.karts[0]
    const followerKart = followerState.karts[0]
    const leaderEvents: AuthEvent[] = []
    const followerEvents: AuthEvent[] = []

    startSpinOut(leaderCtx, leaderState, leaderKart, 60, leaderEvents)
    startSpinOut(followerCtx, followerState, followerKart, 60, followerEvents)

    expect(followerKart.spinOutTicks).toBe(leaderKart.spinOutTicks)
    expect(followerKart.spinOutTicks).toBe(60)
    expect(leaderEvents.length).toBe(1)
    expect(leaderEvents[0].kind).toBe('spinOut')
    expect(followerEvents.length).toBe(0)
    expect(followerState.nextEventSeq).toBe(0)
    expect(leaderState.nextEventSeq).toBe(1)
  })
})
```

- [ ] **Step 15: Run test to verify it fails**

Run: `npx vitest run packages/sim/test/recovery.test.ts -t "spins out identically on a follower"`
Expected: FAIL — `expect(followerEvents.length).toBe(0)` reports `AssertionError: expected 1 to be 0`.

- [ ] **Step 16: Run test to verify it passes**

The gate for this site was already added inside `startSpinOut`'s body in Step 12's "After" block (`if (ctx.isLeader) emit(...)`) — this step is verification only, no further code change.

Run: `npx vitest run packages/sim/test/recovery.test.ts`
Expected: PASS — every test in the file.

---

- [ ] **Step 17: Thread `ctx` through `spawnEntity` and `despawnEntityAt` — definitions, `items.ts`'s six callers, and `entity.ts`'s own internal callers**

In `packages/sim/src/entity.ts`, `spawnEntity`'s signature. Before:

```ts
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
```

After:

```ts
export function spawnEntity(
  ctx: SimContext,
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

  if (ctx.isLeader) emit(state, events, 'entitySpawn', ownerId, entityId, kind, ttl)
  return entityId
}
```

`despawnEntityAt`'s signature. Before:

```ts
export function despawnEntityAt(state: SimState, idx: number, events: AuthEvent[]): void {
  if (idx < 0 || idx >= state.entityCount) return

  const e = state.entities[idx]
  emit(state, events, 'entityDespawn', e.ownerId, e.entityId, e.kind, 0)
  if (e.kind === 'bubble') {
```

After:

```ts
export function despawnEntityAt(ctx: SimContext, state: SimState, idx: number, events: AuthEvent[]): void {
  if (idx < 0 || idx >= state.entityCount) return

  const e = state.entities[idx]
  if (ctx.isLeader) emit(state, events, 'entityDespawn', e.ownerId, e.entityId, e.kind, 0)
  if (e.kind === 'bubble') {
```

`updateEntities`'s own three `despawnEntityAt` calls and two `'hit'` emits, all in one function. Before:

```ts
      if (k.shielded) {
        k.shielded = false
        emit(state, events, 'hit', k.playerId, e.entityId, e.kind, 1)
      } else {
        emit(state, events, 'hit', k.playerId, e.entityId, e.kind, 0)
        // startSpinOut is the contract's sole writer of spinOutTicks and it
        // emits the 'spinOut' event itself.
        startSpinOut(ctx, state, k, ctx.tuning.spinOutTicks, events)
      }
      if (e.kind === 'seeker' || e.kind === 'bolt') {
        // `e` is cleared by the swap-remove, so nothing may read it after this
        despawnEntityAt(state, i, events)
        break
      }
```

After:

```ts
      if (k.shielded) {
        k.shielded = false
        if (ctx.isLeader) emit(state, events, 'hit', k.playerId, e.entityId, e.kind, 1)
      } else {
        if (ctx.isLeader) emit(state, events, 'hit', k.playerId, e.entityId, e.kind, 0)
        // startSpinOut is the contract's sole writer of spinOutTicks and it
        // emits the 'spinOut' event itself.
        startSpinOut(ctx, state, k, ctx.tuning.spinOutTicks, events)
      }
      if (e.kind === 'seeker' || e.kind === 'bolt') {
        // `e` is cleared by the swap-remove, so nothing may read it after this
        despawnEntityAt(ctx, state, i, events)
        break
      }
```

And the bubble-consistency and ttl passes, later in the same function. Before:

```ts
    if (owner === null || !owner.shielded) despawnEntityAt(state, i, events)
  }

  for (let i = state.entityCount - 1; i >= 0; i--) {
    const e = state.entities[i]
    e.ttl -= 1
    if (e.ttl <= 0) despawnEntityAt(state, i, events)
  }
}
```

After:

```ts
    if (owner === null || !owner.shielded) despawnEntityAt(ctx, state, i, events)
  }

  for (let i = state.entityCount - 1; i >= 0; i--) {
    const e = state.entities[i]
    e.ttl -= 1
    if (e.ttl <= 0) despawnEntityAt(ctx, state, i, events)
  }
}
```

In `packages/sim/src/items.ts`, all six `spawnEntity` calls inside `useItem` gain `ctx` as their first argument. `useItem` already receives `ctx` as its own first parameter, so every one of these calls already has it in scope.

Edit 1 (seeker). Before:

```ts
    const id = spawnEntity(state, 'seeker', k.playerId, spawnPosScratch, k.heading,
      seekerTargetFor(state, k.playerId), t.entityTtl, events)
```

After:

```ts
    const id = spawnEntity(ctx, state, 'seeker', k.playerId, spawnPosScratch, k.heading,
      seekerTargetFor(state, k.playerId), t.entityTtl, events)
```

Edit 2 (bolt). Before:

```ts
    const id = spawnEntity(state, 'bolt', k.playerId, spawnPosScratch, k.heading,
      -1, t.entityTtl, events)
```

After:

```ts
    const id = spawnEntity(ctx, state, 'bolt', k.playerId, spawnPosScratch, k.heading,
      -1, t.entityTtl, events)
```

Edit 3 (slick). Before:

```ts
    const id = spawnEntity(state, 'slick', k.playerId, spawnPosScratch, k.heading,
      -1, t.entityTtl, events)
```

After:

```ts
    const id = spawnEntity(ctx, state, 'slick', k.playerId, spawnPosScratch, k.heading,
      -1, t.entityTtl, events)
```

Edit 4 (bubble). Before:

```ts
    const id = spawnEntity(state, 'bubble', k.playerId, spawnPosScratch, k.heading,
      k.playerId, t.entityTtl, events)
```

After:

```ts
    const id = spawnEntity(ctx, state, 'bubble', k.playerId, spawnPosScratch, k.heading,
      k.playerId, t.entityTtl, events)
```

Edit 5 (surge). Before:

```ts
    const id = spawnEntity(state, 'surge', k.playerId, spawnPosScratch, k.heading,
      -1, SURGE_TTL_TICKS, events)
```

After:

```ts
    const id = spawnEntity(ctx, state, 'surge', k.playerId, spawnPosScratch, k.heading,
      -1, SURGE_TTL_TICKS, events)
```

Edit 6 (charge). Before:

```ts
    const id = spawnEntity(state, 'charge', k.playerId, spawnPosScratch, k.heading,
      -1, CHARGE_TTL_TICKS, events)
```

After:

```ts
    const id = spawnEntity(ctx, state, 'charge', k.playerId, spawnPosScratch, k.heading,
      -1, CHARGE_TTL_TICKS, events)
```

- [ ] **Step 18: Run tsc — the fallout in `entity.test.ts`**

Run: `npx tsc --noEmit -p packages/sim`
Expected: FAIL. `packages/sim/test/entity.test.ts` calls `spawnEntity`/`despawnEntityAt` with the old shape at every one of its call sites — 41 calls of the form `spawnEntity(state, ...)`, one of the form `spawnEntity(prev, ...)`, and 6 of the form `despawnEntityAt(state, ...)` (48 total; verified by `grep -c` against the file before this task touched it). tsc reports one `TS2554: Expected 9 arguments, but got 8` (or `TS2345`, depending on which parameter position mismatches first) per call site. Step 19 fixes all 48 in one pass.

- [ ] **Step 19: Give the seven call sites that lack a `ctx` in scope one, then thread `ctx` through every call site in the file**

In `packages/sim/test/entity.test.ts`, widen `stubContext`. Before:

```ts
function stubContext(): SimContext {
```

After:

```ts
function stubContext(isLeader = true): SimContext {
```

And its return statement. Before:

```ts
  return { track, query, tuning: makeTuning(), characters: makeCharacters(), isLeader: true }
}
```

After:

```ts
  return { track, query, tuning: makeTuning(), characters: makeCharacters(), isLeader }
}
```

Seven `it` blocks call `spawnEntity`/`despawnEntityAt` without ever having built a `ctx` (verified: grepped `stubContext()` against every line range that calls `spawnEntity`/`despawnEntityAt` in this file — `describe('spawnEntity', ...)`'s two tests, `describe('despawnEntityAt', ...)`'s two tests, and three of `describe('surgeActiveOn', ...)`'s tests have none). Give each a `const ctx = stubContext()` as its first statement.

Edit 1. Before:

```ts
  it('appends at the front of the pool, copies the position, wraps the heading and emits entitySpawn', () => {
    const state = blankState()
```

After:

```ts
  it('appends at the front of the pool, copies the position, wraps the heading and emits entitySpawn', () => {
    const ctx = stubContext()
    const state = blankState()
```

Edit 2. Before:

```ts
  it('drops the spawn and emits nothing when the pool is full', () => {
    const state = blankState()
```

After:

```ts
  it('drops the spawn and emits nothing when the pool is full', () => {
    const ctx = stubContext()
    const state = blankState()
```

Edit 3. Before:

```ts
  it('swap-removes and clears the vacated slot to the canonical dead form', () => {
    const state = blankState()
```

After:

```ts
  it('swap-removes and clears the vacated slot to the canonical dead form', () => {
    const ctx = stubContext()
    const state = blankState()
```

Edit 4. Before:

```ts
  it('ignores an index outside the live range', () => {
    const state = blankState()
```

After:

```ts
  it('ignores an index outside the live range', () => {
    const ctx = stubContext()
    const state = blankState()
```

Edit 5. Before:

```ts
  it('slows only the karts placed ahead of the surge owner', () => {
    const state = progressState()
```

After:

```ts
  it('slows only the karts placed ahead of the surge owner', () => {
    const ctx = stubContext()
    const state = progressState()
```

Edit 6. Before:

```ts
  it('ignores non-surge entities and out-of-range player ids', () => {
    const state = progressState()
```

After:

```ts
  it('ignores non-surge entities and out-of-range player ids', () => {
    const ctx = stubContext()
    const state = progressState()
```

Edit 7. Before:

```ts
  it('lets one surge owner be caught by another surge', () => {
    const state = progressState()
```

After:

```ts
  it('lets one surge owner be caught by another surge', () => {
    const ctx = stubContext()
    const state = progressState()
```

Now every `spawnEntity`/`despawnEntityAt` call site in the file has `ctx` reachable in its enclosing `it` block — either just added above, or already present from an existing `const ctx = stubContext()` (verified: `grep -n "stubContext()" packages/sim/test/entity.test.ts` lists one per `it` block that calls `updateEntities`/`spawnEntity`/`despawnEntityAt`, covering the whole file once the seven above are added). Run this single command to thread `ctx` into all 48 call sites mechanically:

```bash
sed -i -E 's/\bspawnEntity\((state|prev),/spawnEntity(ctx, \1,/g; s/\bdespawnEntityAt\(state,/despawnEntityAt(ctx, state,/g' packages/sim/test/entity.test.ts
```

Verify the count: `grep -c 'spawnEntity(ctx, state,' packages/sim/test/entity.test.ts` should print `41`, `grep -c 'spawnEntity(ctx, prev,' packages/sim/test/entity.test.ts` should print `1`, `grep -c 'despawnEntityAt(ctx, state,' packages/sim/test/entity.test.ts` should print `6`.

- [ ] **Step 20: Run test to verify it passes**

Run: `npx tsc --noEmit -p packages/sim`
Expected: no output, exit code 0.

Run: `npx vitest run packages/sim/test/entity.test.ts packages/sim/test/items.test.ts`
Expected: PASS — every test. Gating has not changed any behavior yet (every `stubContext()` call still defaults to `isLeader: true`); this step only proves the mechanical threading was correct.

---

- [ ] **Step 21: Write the failing test — `spawnEntity`'s `'entitySpawn'` event on a follower**

Append to `describe('spawnEntity', ...)` in `packages/sim/test/entity.test.ts`, as the last test before its closing `})`. Before:

```ts
    expect(overflow).toBe(-1)
    expect(state.entityCount).toBe(32)
    expect(state.nextEntityId).toBe(33) // not advanced by a dropped spawn
    expect(events.length).toBe(32) // nothing emitted
  })
})
```

After:

```ts
    expect(overflow).toBe(-1)
    expect(state.entityCount).toBe(32)
    expect(state.nextEntityId).toBe(33) // not advanced by a dropped spawn
    expect(events.length).toBe(32) // nothing emitted
  })

  it('spawns identically on a follower, but announces nothing', () => {
    const leaderCtx = stubContext()
    const followerCtx = stubContext(false)
    const leaderState = blankState()
    const followerState = blankState()
    const leaderEvents: AuthEvent[] = []
    const followerEvents: AuthEvent[] = []
    const p = { x: 1, y: 0.5, z: 2 }

    const leaderId = spawnEntity(leaderCtx, leaderState, 'slick', 4, p, 7, -1, 600, leaderEvents)
    const followerId = spawnEntity(followerCtx, followerState, 'slick', 4, p, 7, -1, 600, followerEvents)

    expect(followerId).toBe(leaderId)
    expect(followerState.entities[0].position.x).toBe(leaderState.entities[0].position.x)
    expect(followerState.entities[0].heading).toBe(leaderState.entities[0].heading)
    expect(followerState.entityCount).toBe(leaderState.entityCount)
    expect(leaderEvents.length).toBe(1)
    expect(leaderEvents[0].kind).toBe('entitySpawn')
    expect(followerEvents.length).toBe(0)
  })
})
```

- [ ] **Step 22: Run test to verify it fails**

Run: `npx vitest run packages/sim/test/entity.test.ts -t "spawns identically on a follower"`
Expected: FAIL — `expect(followerEvents.length).toBe(0)` reports `AssertionError: expected 1 to be 0`.

- [ ] **Step 23: Run test to verify it passes**

The gate for this site was already added inside `spawnEntity`'s body in Step 17's "After" block. This step is verification only.

Run: `npx vitest run packages/sim/test/entity.test.ts -t "spawns identically on a follower"`
Expected: PASS.

- [ ] **Step 24: Write the failing test — `despawnEntityAt`'s `'entityDespawn'` event on a follower**

Append to `describe('despawnEntityAt', ...)` in `packages/sim/test/entity.test.ts`, as the last test before its closing `})`. Before:

```ts
    expect(state.entityCount).toBe(1)
    expect(state.entities[0].entityId).toBe(1)
    expect(events.length).toBe(0)
  })
})
```

After:

```ts
    expect(state.entityCount).toBe(1)
    expect(state.entities[0].entityId).toBe(1)
    expect(events.length).toBe(0)
  })

  it('despawns identically on a follower, but announces nothing', () => {
    const leaderCtx = stubContext()
    const followerCtx = stubContext(false)
    const leaderState = blankState()
    const followerState = blankState()
    spawnEntity(leaderCtx, leaderState, 'slick', 0, { x: 1, y: 0, z: 0 }, 0, -1, 600, [])
    spawnEntity(followerCtx, followerState, 'slick', 0, { x: 1, y: 0, z: 0 }, 0, -1, 600, [])
    const leaderEvents: AuthEvent[] = []
    const followerEvents: AuthEvent[] = []

    despawnEntityAt(leaderCtx, leaderState, 0, leaderEvents)
    despawnEntityAt(followerCtx, followerState, 0, followerEvents)

    expect(followerState.entityCount).toBe(leaderState.entityCount)
    expect(followerState.entities[0].entityId).toBe(leaderState.entities[0].entityId)
    expect(leaderEvents.length).toBe(1)
    expect(leaderEvents[0].kind).toBe('entityDespawn')
    expect(followerEvents.length).toBe(0)
  })
})
```

- [ ] **Step 25: Run test to verify it fails**

Run: `npx vitest run packages/sim/test/entity.test.ts -t "despawns identically on a follower"`
Expected: FAIL — `expect(followerEvents.length).toBe(0)` reports `AssertionError: expected 1 to be 0`.

- [ ] **Step 26: Run test to verify it passes**

The gate for this site was already added inside `despawnEntityAt`'s body in Step 17's "After" block. Verification only.

Run: `npx vitest run packages/sim/test/entity.test.ts -t "despawns identically on a follower"`
Expected: PASS.

---

- [ ] **Step 27: Write the failing test — `updateEntities`'s two `'hit'` sites on a follower**

Append a new top-level `describe` block to `packages/sim/test/entity.test.ts`, at the very end of the file. Before:

```ts
    // step never mutates prev
    expect(prev.karts[1].spinOutTicks).toBe(0)
    expect(prev.entities[0].ttl).toBe(600)
    expect(prev.tick).toBe(700)
  })
})
```

After:

```ts
    // step never mutates prev
    expect(prev.karts[1].spinOutTicks).toBe(0)
    expect(prev.entities[0].ttl).toBe(600)
    expect(prev.tick).toBe(700)
  })
})

describe('updateEntities hit events on a follower', () => {
  it('resolves both hit branches identically, but announces nothing', () => {
    const leaderCtx = stubContext()
    const followerCtx = stubContext(false)
    const leaderState = blankState()
    const followerState = blankState()

    // unshielded kart 2 and shielded kart 3, both parked far from everyone
    // else, each sitting on its own long-lived slick (ttl 600, so this tick's
    // ttl pass does not also despawn it -- entityDespawn's gating is proven
    // separately, above).
    for (const state of [leaderState, followerState]) {
      state.karts[2].position.x = 200
      state.karts[2].position.z = 0
      state.karts[3].position.x = 250
      state.karts[3].position.z = 0
      state.karts[3].shielded = true
    }
    spawnEntity(leaderCtx, leaderState, 'slick', 7, { x: 200, y: 0, z: 0 }, 0, -1, 600, [])
    spawnEntity(leaderCtx, leaderState, 'slick', 7, { x: 250, y: 0, z: 0 }, 0, -1, 600, [])
    spawnEntity(followerCtx, followerState, 'slick', 7, { x: 200, y: 0, z: 0 }, 0, -1, 600, [])
    spawnEntity(followerCtx, followerState, 'slick', 7, { x: 250, y: 0, z: 0 }, 0, -1, 600, [])
    const leaderEvents: AuthEvent[] = []
    const followerEvents: AuthEvent[] = []

    updateEntities(leaderCtx, leaderState, leaderEvents)
    updateEntities(followerCtx, followerState, followerEvents)

    expect(followerState.karts[2].spinOutTicks).toBe(leaderState.karts[2].spinOutTicks)
    expect(followerState.karts[2].spinOutTicks).toBe(60)
    expect(followerState.karts[3].shielded).toBe(leaderState.karts[3].shielded)
    expect(followerState.karts[3].shielded).toBe(false)

    const leaderHits = leaderEvents.filter((e) => e.kind === 'hit')
    expect(leaderHits.length).toBe(2)
    expect(leaderHits.map((e) => e.data).sort()).toEqual([0, 1])
    expect(followerEvents.filter((e) => e.kind === 'hit').length).toBe(0)
  })
})
```

- [ ] **Step 28: Run test to verify it fails**

Run: `npx vitest run packages/sim/test/entity.test.ts -t "resolves both hit branches identically"`
Expected: FAIL — `expect(followerEvents.filter((e) => e.kind === 'hit').length).toBe(0)` reports `AssertionError: expected 2 to be 0`.

- [ ] **Step 29: Run test to verify it passes**

Both `'hit'` sites were already gated inside `updateEntities`'s body in Step 17's "After" block. Verification only.

Run: `npx vitest run packages/sim/test/entity.test.ts -t "resolves both hit branches identically"`
Expected: PASS.

Run: `npx vitest run packages/sim/test/entity.test.ts`
Expected: PASS — every test in the file.

---

- [ ] **Step 30: Write the failing test — a full tick, leader vs. follower, identical `SimState` except `nextEventSeq` and events**

This is the holistic proof the task needs: one `step()` call each, on two states that start bit-identical, exercising all eight of this task's gated sites in a single tick. Append at the very end of `packages/sim/test/entity.test.ts`. Before:

```ts
    const leaderHits = leaderEvents.filter((e) => e.kind === 'hit')
    expect(leaderHits.length).toBe(2)
    expect(leaderHits.map((e) => e.data).sort()).toEqual([0, 1])
    expect(followerEvents.filter((e) => e.kind === 'hit').length).toBe(0)
  })
})
```

After:

```ts
    const leaderHits = leaderEvents.filter((e) => e.kind === 'hit')
    expect(leaderHits.length).toBe(2)
    expect(leaderHits.map((e) => e.data).sort()).toEqual([0, 1])
    expect(followerEvents.filter((e) => e.kind === 'hit').length).toBe(0)
  })
})

describe('Task 2: follower parity across a full tick', () => {
  // stubContext's Track has itemBoxes: [], so updateItemBoxes never runs its
  // leader-only roll this tick -- the one already-correctly-gated site is
  // deliberately kept out of this test so it isolates exactly the eight sites
  // this task gates.
  function parityPrevState(): SimState {
    const state = blankState()
    state.phase = 'racing'
    state.tick = 100

    // kart 0: out of bounds -> updateRecovery's beginRespawn -> 'respawn'
    state.karts[0].position.x = 10
    state.karts[0].position.z = 50 // |lateral| = 50 > isInBounds's 10

    // kart 1: one tick from completing lap 3 -> updateLaps' 'lapCross' + 'finish'
    state.karts[1].position.x = 4 // s = 0.01, inside checkpoint 0's [0, 0.25)
    state.karts[1].position.z = 0
    state.karts[1].lap = { lap: 2, checkpointIdx: 3, t: 0.99 }

    // kart 2: unshielded, sits on a low-ttl slick -> 'hit' (data 0), 'spinOut',
    // and that same slick's ttl expiry -> 'entityDespawn'
    state.karts[2].position.x = 200
    state.karts[2].position.z = 0

    // kart 3: shielded, sits on a long-ttl slick -> 'hit' (data 1)
    state.karts[3].position.x = 250
    state.karts[3].position.z = 0
    state.karts[3].shielded = true

    // kart 4: holds a seeker and fires it -> useItem's spawnEntity -> 'entitySpawn'
    state.karts[4].position.x = 300
    state.karts[4].position.z = 0
    state.karts[4].item = 'seeker'

    // Two pre-placed entities, written directly rather than through
    // spawnEntity (one of the things under test), so their ids are exact.
    state.entityCount = 2
    state.nextEntityId = 3
    const e0 = state.entities[0] // kart 2's slick: ttl 1, expires this tick
    e0.entityId = 1
    e0.kind = 'slick'
    e0.ownerId = 7
    e0.position.x = 200
    e0.position.y = 0
    e0.position.z = 0
    e0.ttl = 1
    const e1 = state.entities[1] // kart 3's slick: ttl 600, survives this tick
    e1.entityId = 2
    e1.kind = 'slick'
    e1.ownerId = 7
    e1.position.x = 250
    e1.position.y = 0
    e1.position.z = 0
    e1.ttl = 600

    return state
  }

  function parityInputs(): Intent[] {
    const inputs: Intent[] = []
    for (let i = 0; i < MAX_KARTS; i++) {
      inputs.push({ tick: 0, steer: 0, accel: 0, brake: false, drift: false, useItem: i === 4 })
    }
    return inputs
  }

  it('mutates state identically to a leader, and only its announcements differ', () => {
    const leaderCtx = stubContext(true)
    const followerCtx = stubContext(false)
    const prevLeader = parityPrevState()
    const prevFollower = parityPrevState()
    const nextLeader = parityPrevState() // shape-compatible scratch for step()'s cloneState
    const nextFollower = parityPrevState()
    const inputs = parityInputs()
    const leaderEvents: AuthEvent[] = []
    const followerEvents: AuthEvent[] = []

    step(leaderCtx, prevLeader, nextLeader, inputs, leaderEvents)
    step(followerCtx, prevFollower, nextFollower, inputs, followerEvents)

    // All eight of Task 2's gated sites fired on the leader, none on the follower.
    expect(leaderEvents.length).toBe(8)
    expect(followerEvents.length).toBe(0)
    expect(leaderEvents.map((e) => e.kind).sort()).toEqual(
      ['entityDespawn', 'entitySpawn', 'finish', 'hit', 'hit', 'lapCross', 'respawn', 'spinOut'].sort(),
    )
    expect(nextLeader.nextEventSeq).toBe(8)
    expect(nextFollower.nextEventSeq).toBe(0)

    // Every other field of SimState is identical. statesEqual (state.ts) is
    // exhaustive and Object.is-strict, so borrow it for the "except
    // nextEventSeq" comparison by equalising just that one field first.
    const savedFollowerSeq = nextFollower.nextEventSeq
    nextFollower.nextEventSeq = nextLeader.nextEventSeq
    expect(statesEqual(nextLeader, nextFollower)).toBe(true)
    nextFollower.nextEventSeq = savedFollowerSeq

    // Name the mechanisms statesEqual just proved identical, so a regression
    // here says which one moved, not just "false".
    expect(nextFollower.karts[0].respawnTicks).toBe(72) // kart 0 respawned
    expect(nextFollower.karts[1].lap.lap).toBe(3) // kart 1 finished lap 3
    expect(nextFollower.finishedOrder[0]).toBe(1)
    expect(nextFollower.karts[2].spinOutTicks).toBe(60) // kart 2 spun out
    expect(nextFollower.entityCount).toBe(2) // slick 1 despawned, seeker spawned
    expect(nextFollower.karts[3].shielded).toBe(false) // kart 3's shield absorbed a hit
    expect(nextFollower.karts[4].item).toBe('none') // kart 4 spent its seeker
  })
})
```

This needs two more imports at the top of `packages/sim/test/entity.test.ts`. Before:

```ts
import type {
  AuthEvent, EntityState, Intent, KartState, SimContext, SimState, Track, TrackQuery,
} from '../src/types'
import { MAX_ENTITIES, MAX_KARTS } from '../src/types'
import { makeCharacters, makeTuning } from './fixtures/track-fixtures'
import {
  despawnEntityAt, kartById, spawnEntity, surgeActiveOn, updateEntities,
} from '../src/entity'
import { targetSpeedFor } from '../src/kart'
import { step } from '../src/step'
```

After:

```ts
import type {
  AuthEvent, EntityState, Intent, KartState, SimContext, SimState, Track, TrackQuery,
} from '../src/types'
import { MAX_ENTITIES, MAX_KARTS } from '../src/types'
import { makeCharacters, makeTuning } from './fixtures/track-fixtures'
import {
  despawnEntityAt, kartById, spawnEntity, surgeActiveOn, updateEntities,
} from '../src/entity'
import { targetSpeedFor } from '../src/kart'
import { step } from '../src/step'
import { statesEqual } from '../src/state'
```

(`Intent`, `SimState` and `step` are already imported; only `statesEqual` is new.)

- [ ] **Step 31: Run test to verify it fails**

Run: `npx vitest run packages/sim/test/entity.test.ts -t "mutates state identically to a leader"`
Expected: FAIL — `expect(followerEvents.length).toBe(0)` reports `AssertionError: expected 8 to be 0`. Before this task every one of the eight sites emitted unconditionally, so the follower run produces the same eight events the leader does.

- [ ] **Step 32: Run test to verify it passes**

All eight sites were already gated by the earlier steps in this task. Verification only.

Run: `npx vitest run packages/sim/test/entity.test.ts -t "mutates state identically to a leader"`
Expected: PASS.

---

- [ ] **Step 33: Run the whole suite and typecheck**

Run: `npx vitest run packages/sim`
Expected: PASS — every test in the package.

Run: `npx tsc --noEmit -p packages/sim`
Expected: no output, exit code 0.

- [ ] **Step 34: Commit**

```bash
git add packages/sim/src/laps.ts packages/sim/src/recovery.ts packages/sim/src/entity.ts \
        packages/sim/src/items.ts \
        packages/sim/test/laps.test.ts packages/sim/test/recovery.test.ts \
        packages/sim/test/entity.test.ts
git commit -m "feat(sim): gate emit() on ctx.isLeader at the remaining eight call sites

laps.ts (lapCross, finish), recovery.ts (respawn, spinOut) and entity.ts
(entitySpawn, entityDespawn, hit x2) now emit only when ctx.isLeader, joining
the three sites (itemGrant, phase.ts's two finish events) Plan 1 already
gated. A follower's simulation is unchanged -- spin-outs, respawns, lap
crossings and entity lifecycle all still happen -- only their announcement is
suppressed, proven per-site and by one full-tick test comparing a leader and
a follower run from identical states: every SimState field matches except
nextEventSeq and the events array.

startSpinOut also gains a ctx first parameter, alongside the two entity.ts
helpers the contract names -- its own 'spinOut' emit needed the same gate and
had nowhere else to read ctx from; it has exactly one caller in src, updated
here along with its six test call sites and entity.test.ts's 48 spawnEntity/
despawnEntityAt call sites (mechanical, verified by tsc)."
```
