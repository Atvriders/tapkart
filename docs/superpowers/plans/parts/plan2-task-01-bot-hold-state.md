### Task 1: Move the bot hold into SimState

**Files:**
- Modify: `packages/sim/src/types.ts` (`SimState` gains two fields — the one task permitted to edit this file, per contract §1a)
- Modify: `packages/sim/src/state.ts` (`createState`, `cloneState`, `statesEqual`)
- Modify: `packages/sim/src/phase.ts` (`resolveInputs` rewritten to use `state`; `resetBotHold` and the module-scope hold deleted)
- Modify: `packages/sim/src/replay.ts` (`resetBotHold` calls dropped; the checkpoint-parity `RangeError` guard and `needsOddCheckpoint` deleted; the file-header comment corrected)
- Modify: `packages/sim/test/state.test.ts` (new assertions on `heldBotIntent`/`heldBotTick`)
- Modify: `packages/sim/test/phase.test.ts` (drop `resetBotHold` import/calls; extend one test and add one new test)
- Modify: `packages/sim/test/replay.test.ts` (drop `resetBotHold` import/calls; delete one obsolete test; replace a 3-test block with 1)
- Modify: `packages/sim/test/barrel.test.ts` (drop `resetBotHold` from the export inventory and its count)
- Modify: `packages/sim/test/recovery.test.ts`, `packages/sim/test/collision.test.ts`, `packages/sim/test/entity.test.ts`, `packages/sim/test/laps.test.ts`, `packages/sim/test/placement.test.ts` (each hand-builds a `SimState` object literal that must grow the two new fields)

**A note on scope.** The contract's own §1a text names only `createState`/`cloneState`/`statesEqual`/`resolveInputs`/`resetBotHold`/`replayRun`'s guard as what this task touches. Widening `SimState` — a type used as an object-literal shape in five other test files that do **not** go through `createState` — breaks those five files' compilation the moment `types.ts` changes, regardless of which task's contract text mentions them. I verified this is real, not a hypothetical: I temporarily added the two fields to `types.ts` alone and ran `npx tsc --noEmit -p packages/sim`. It reported exactly six `TS2739` errors — `packages/sim/src/state.ts(111,3)` and one in each of `collision.test.ts(60,3)`, `entity.test.ts(106,3)`, `laps.test.ts(108,3)`, `placement.test.ts(56,3)`, `recovery.test.ts(122,3)` — each reading `Type '{...}' is missing the following properties from type 'SimState': heldBotIntent, heldBotTick`. I reverted the probe before writing this brief. Step 18 below fixes the five test-file cases (the sixth, `state.ts`, is fixed by Step 3).

**Interfaces:**

- Consumes (unchanged signatures, all pre-existing):
  - `packages/sim/src/types.ts` — `MAX_KARTS` (`= 8`), `Intent`, `SimContext`, `SimState`.
  - `packages/sim/src/state.ts` — `createState(ctx: SimContext, seed: number, characterIdx: number[]): SimState`, `cloneState(src: SimState, dst: SimState): void`, `statesEqual(a: SimState, b: SimState): boolean`. This task changes their **bodies**, not their signatures.
  - `packages/sim/src/phase.ts` — `resolveInputs(ctx: SimContext, state: SimState, inputs: Intent[], out: Intent[]): void`, `makeIntentBuffer(): Intent[]`. `resolveInputs`'s signature is unchanged; only its body and the truthfulness of its doc comment change.
  - `packages/sim/src/bot.ts` — `botIntent(ctx: SimContext, state: SimState, playerId: number): Intent` (pooled per-playerId return value, verified by reading `bot.ts`'s doc comment reproduced in `phase.ts`).
  - `packages/sim/src/replay.ts` — `allocStateLike(ctx: SimContext, src: SimState): SimState`, `recordRun`, `replayRun` — signatures unchanged.
  - `packages/sim/test/helpers/flat-context.ts` — `makeTestContext`, `EIGHT_STARTS`, `makeIntent`.
  - `packages/sim/test/fixtures/track-fixtures.ts` — `makeContext(track, isLeader = true)`, `makeStraightTrack`, `makeOvalTrack`, `makeTuning`, `makeCharacters`.

- Produces (exact shapes later tasks and this task's own later steps rely on):
  - `SimState.heldBotIntent: Intent[]` — always length `MAX_KARTS`.
  - `SimState.heldBotTick: number[]` — always length `MAX_KARTS`, `-1` meaning "no held intent".
  - `createState` initialises `heldBotIntent[i]` to `{ tick: 0, steer: 0, accel: 0, brake: false, drift: false, useItem: false }` (the same neutral shape `makeIntentBuffer()` and `flat-context.ts`'s `makeIntent()` already use) and `heldBotTick[i]` to `-1`, for every `i` in `[0, MAX_KARTS)`.
  - `cloneState` deep-copies both fields, field by field, allocating nothing (same convention as every other array on `SimState`).
  - `statesEqual` compares both, every field of every held intent and every held tick, with `Object.is`.
  - `resolveInputs` reads and writes `state.heldBotIntent[i]` / `state.heldBotTick[i]` in place of the deleted module-scope `holdIntent[i]` / `holdTick[i]`. Two independently-created `SimState`s never observe each other's hold, which is the defect the spec names (3 cm of divergence after 40 ticks when two rooms share one process).
  - `resetBotHold` is **deleted** — no longer exported from `phase.ts`, and removed from `barrel.test.ts`'s 47-function inventory (46 after this task).
  - `replayRun` no longer throws `RangeError` for an even-tick checkpoint with a bot-driven or disconnected kart. `needsOddCheckpoint` is **deleted** (it was module-private, never exported, so nothing outside `replay.ts` can reference it).

---

- [ ] **Step 1: Write the failing test — `createState` populates the hold**

In `packages/sim/test/state.test.ts`, inside `describe('createState', ...)`, insert a new test immediately after `'preallocates every array to its fixed length with dead slots marked -1'` and before `'clamps characterIdx into range and defaults unsupplied seats to 0'`.

Before:

```ts
    for (let i = 0; i < 3; i++) {
      expect(st.itemBoxes[i].boxIdx).toBe(i)
      expect(st.itemBoxes[i].respawnTicks).toBe(0)
    }
  })

  it('clamps characterIdx into range and defaults unsupplied seats to 0', () => {
```

After:

```ts
    for (let i = 0; i < 3; i++) {
      expect(st.itemBoxes[i].boxIdx).toBe(i)
      expect(st.itemBoxes[i].respawnTicks).toBe(0)
    }
  })

  it('initialises heldBotIntent to neutral intents and heldBotTick to -1', () => {
    const ctx = makeTestContext(EIGHT_STARTS)
    const st = createState(ctx, 12345, [0, 1, 2, 3, 4, 5, 6, 7])

    expect(st.heldBotIntent).toHaveLength(MAX_KARTS)
    expect(st.heldBotTick).toHaveLength(MAX_KARTS)
    for (let i = 0; i < MAX_KARTS; i++) {
      expect(st.heldBotIntent[i].tick).toBe(0)
      expect(st.heldBotIntent[i].steer).toBe(0)
      expect(st.heldBotIntent[i].accel).toBe(0)
      expect(st.heldBotIntent[i].brake).toBe(false)
      expect(st.heldBotIntent[i].drift).toBe(false)
      expect(st.heldBotIntent[i].useItem).toBe(false)
      expect(st.heldBotTick[i]).toBe(-1)
    }
  })

  it('clamps characterIdx into range and defaults unsupplied seats to 0', () => {
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/sim/test/state.test.ts -t "initialises heldBotIntent"`
Expected: FAIL with `AssertionError: Target cannot be null or undefined.` at the `expect(st.heldBotIntent).toHaveLength(MAX_KARTS)` line — `st.heldBotIntent` does not exist on the object `createState` returns today. (Verified directly: `expect(({} as any).missingField).toHaveLength(8)` under this repo's vitest produces exactly that message, not a `TypeError`.)

- [ ] **Step 3: Add the fields to `SimState` and initialise them in `createState`**

In `packages/sim/src/types.ts`, widen `SimState`. Before:

```ts
  itemBoxes: ItemBoxState[]
  finishedOrder: number[]
}
```

After:

```ts
  itemBoxes: ItemBoxState[]
  finishedOrder: number[]
  heldBotIntent: Intent[]       // always length MAX_KARTS
  heldBotTick: number[]         // always length MAX_KARTS, -1 = no held intent
}
```

(`Intent` is already declared earlier in this same file, so no import changes are needed here.)

In `packages/sim/src/state.ts`, add `Intent` to the type-only import. Before:

```ts
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

After:

```ts
import type {
  AuthEvent,
  AuthEventKind,
  EntityState,
  Intent,
  ItemBoxState,
  ItemKind,
  KartState,
  SimContext,
  SimState,
} from './types'
```

Then, in `createState`, build the two arrays and return them. Before:

```ts
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

After:

```ts
  // Fixed length MAX_KARTS, every slot -1. Tasks 11 and 15 write a finisher into
  // the first slot holding -1; nothing ever pushes, pops or resizes this array,
  // because cloneState below rejects a dst whose lengths differ from src's.
  const finishedOrder: number[] = []
  for (let i = 0; i < MAX_KARTS; i++) {
    finishedOrder.push(-1)
  }

  // Plan 2 Task 1: the 30Hz bot-input hold, formerly module scope in phase.ts,
  // now lives here so two SimStates in one process never share it.
  // heldBotTick[i] === -1 means "no held intent"; otherwise it records the EVEN
  // tick the held intent belongs to, exactly as phase.ts's resolveInputs uses it.
  const heldBotIntent: Intent[] = []
  const heldBotTick: number[] = []
  for (let i = 0; i < MAX_KARTS; i++) {
    heldBotIntent.push({ tick: 0, steer: 0, accel: 0, brake: false, drift: false, useItem: false })
    heldBotTick.push(-1)
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
    heldBotIntent,
    heldBotTick,
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/sim/test/state.test.ts -t "initialises heldBotIntent"`
Expected: PASS — 1 test.

Note: `npx tsc --noEmit -p packages/sim` will still report errors at this point (the five hand-built `SimState` literals in other test files, per the scope note above). That is expected and is fixed in Step 18. `npx vitest run packages/sim` stays green in the meantime, because those five files never exercise `cloneState`/`statesEqual`/`resolveInputs` on their hand-built states in a way that reads the two new fields.

---

- [ ] **Step 5: Write the failing test — `cloneState` and `statesEqual` cover the hold**

In `packages/sim/test/state.test.ts`, extend the existing `'copies every field so the clone is bit-equal to the source'` test. Before:

```ts
    a.finishedOrder[0] = 6
    a.itemBoxes[2].respawnTicks = 41

    cloneState(a, b)
```

After:

```ts
    a.finishedOrder[0] = 6
    a.itemBoxes[2].respawnTicks = 41
    a.heldBotIntent[5].steer = 0.75
    a.heldBotIntent[5].accel = 0.5
    a.heldBotIntent[5].brake = true
    a.heldBotIntent[5].drift = true
    a.heldBotIntent[5].useItem = true
    a.heldBotIntent[5].tick = 200
    a.heldBotTick[5] = 200

    cloneState(a, b)
```

And before:

```ts
    expect(b.itemBoxes[2].respawnTicks).toBe(41)
  })

  it('writes into dst in place, reusing every existing object', () => {
```

After:

```ts
    expect(b.itemBoxes[2].respawnTicks).toBe(41)
    expect(b.heldBotIntent[5].steer).toBe(0.75)
    expect(b.heldBotIntent[5].accel).toBe(0.5)
    expect(b.heldBotIntent[5].brake).toBe(true)
    expect(b.heldBotIntent[5].drift).toBe(true)
    expect(b.heldBotIntent[5].useItem).toBe(true)
    expect(b.heldBotIntent[5].tick).toBe(200)
    expect(b.heldBotTick[5]).toBe(200)
  })

  it('writes into dst in place, reusing every existing object', () => {
```

Then extend `'detects a difference in any field, including dead entity slots'`. Before:

```ts
    expect(differsAfter(() => { b.itemBoxes[0].respawnTicks = 1 })).toBe(false)
    expect(differsAfter(() => { /* no mutation */ })).toBe(true)
  })
})
```

After:

```ts
    expect(differsAfter(() => { b.itemBoxes[0].respawnTicks = 1 })).toBe(false)
    expect(differsAfter(() => { b.heldBotIntent[2].steer = 0.5 })).toBe(false)
    expect(differsAfter(() => { b.heldBotTick[2] = 5 })).toBe(false)
    expect(differsAfter(() => { /* no mutation */ })).toBe(true)
  })
})
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run packages/sim/test/state.test.ts -t "copies every field"`
Expected: FAIL with `TypeError: Cannot set properties of undefined (setting 'steer')` at `a.heldBotIntent[5].steer = 0.75` — `heldBotIntent` exists on states built by `createState` since Step 3, but `cloneState` and `statesEqual` do not yet read or write it, and `a.heldBotIntent[5]` itself is a real object (Step 3 populated it) so this specific line does not fail; the actual first failure is later, at `expect(b.heldBotIntent[5].steer).toBe(0.75)`, which reports `AssertionError: expected 0 to be 0.75` because `cloneState` never copied it. (`a`'s write itself succeeds — Step 3 already gives every state a real `heldBotIntent` array — so re-derive the exact failure line from the test's own assertions rather than the field-access line.)

Run: `npx vitest run packages/sim/test/state.test.ts -t "detects a difference"`
Expected: FAIL — `expect(differsAfter(() => { b.heldBotIntent[2].steer = 0.5 })).toBe(false)` reports `expected true to be false`, because `statesEqual` does not yet compare `heldBotIntent`, so mutating `b`'s copy does not make `statesEqual(a, b)` return `false`.

- [ ] **Step 7: Make `cloneState` and `statesEqual` cover the hold**

In `packages/sim/src/state.ts`, widen `cloneState`'s shape guard. Before:

```ts
export function cloneState(src: SimState, dst: SimState): void {
  if (
    dst.karts.length !== src.karts.length ||
    dst.entities.length !== src.entities.length ||
    dst.itemBoxes.length !== src.itemBoxes.length ||
    dst.finishedOrder.length !== src.finishedOrder.length
  ) {
    throw new Error('cloneState: dst was not preallocated with the same shape as src')
  }
```

After:

```ts
export function cloneState(src: SimState, dst: SimState): void {
  if (
    dst.karts.length !== src.karts.length ||
    dst.entities.length !== src.entities.length ||
    dst.itemBoxes.length !== src.itemBoxes.length ||
    dst.finishedOrder.length !== src.finishedOrder.length ||
    dst.heldBotIntent.length !== src.heldBotIntent.length ||
    dst.heldBotTick.length !== src.heldBotTick.length
  ) {
    throw new Error('cloneState: dst was not preallocated with the same shape as src')
  }
```

Also update its doc comment. Before:

```ts
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
```

After:

```ts
/**
 * Deep-copy `src` into the already-allocated `dst`. Allocates nothing: every
 * object in `dst` is written field by field and reused.
 *
 * All six arrays must already match in length — `karts` (MAX_KARTS),
 * `entities` (MAX_ENTITIES), `itemBoxes` (the track's item-box count),
 * `finishedOrder`, `heldBotIntent` and `heldBotTick` (all MAX_KARTS) — which is
 * checked once up front and throws otherwise. That check is what forbids
 * `finishedOrder.push(...)` anywhere in the sim: a 9th entry would make every
 * subsequent clone throw.
 */
```

Then append the copy loop, at the end of the function. Before:

```ts
  for (let i = 0; i < src.finishedOrder.length; i++) {
    dst.finishedOrder[i] = src.finishedOrder[i]
  }
}
```

After:

```ts
  for (let i = 0; i < src.finishedOrder.length; i++) {
    dst.finishedOrder[i] = src.finishedOrder[i]
  }

  for (let i = 0; i < src.heldBotIntent.length; i++) {
    const a = src.heldBotIntent[i]
    const b = dst.heldBotIntent[i]
    b.tick = a.tick
    b.steer = a.steer
    b.accel = a.accel
    b.brake = a.brake
    b.drift = a.drift
    b.useItem = a.useItem
    dst.heldBotTick[i] = src.heldBotTick[i]
  }
}
```

Now widen `statesEqual`'s length guard. Before:

```ts
  if (
    a.karts.length !== b.karts.length ||
    a.entities.length !== b.entities.length ||
    a.itemBoxes.length !== b.itemBoxes.length ||
    a.finishedOrder.length !== b.finishedOrder.length
  ) {
    return false
  }
```

After:

```ts
  if (
    a.karts.length !== b.karts.length ||
    a.entities.length !== b.entities.length ||
    a.itemBoxes.length !== b.itemBoxes.length ||
    a.finishedOrder.length !== b.finishedOrder.length ||
    a.heldBotIntent.length !== b.heldBotIntent.length ||
    a.heldBotTick.length !== b.heldBotTick.length
  ) {
    return false
  }
```

And append the comparison loop before the final `return true`. Before:

```ts
  for (let i = 0; i < a.finishedOrder.length; i++) {
    if (!Object.is(a.finishedOrder[i], b.finishedOrder[i])) {
      return false
    }
  }

  return true
}
```

After:

```ts
  for (let i = 0; i < a.finishedOrder.length; i++) {
    if (!Object.is(a.finishedOrder[i], b.finishedOrder[i])) {
      return false
    }
  }

  for (let i = 0; i < a.heldBotIntent.length; i++) {
    const x = a.heldBotIntent[i]
    const y = b.heldBotIntent[i]
    if (
      !Object.is(x.tick, y.tick) ||
      !Object.is(x.steer, y.steer) ||
      !Object.is(x.accel, y.accel) ||
      !Object.is(x.brake, y.brake) ||
      !Object.is(x.drift, y.drift) ||
      !Object.is(x.useItem, y.useItem) ||
      !Object.is(a.heldBotTick[i], b.heldBotTick[i])
    ) {
      return false
    }
  }

  return true
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npx vitest run packages/sim/test/state.test.ts`
Expected: PASS — every test in the file, including the two extended in Step 5 and the one added in Step 1.

---

- [ ] **Step 9: Write the failing test — `resolveInputs` writes the hold into `state`**

In `packages/sim/test/phase.test.ts`, extend `'holds bot intents across a tick pair so bots run at 30Hz'`. Before:

```ts
    // even tick 200: fresh compute
    resolveInputs(ctx, s, inputs, out)
    const first = { steer: out[0].steer, accel: out[0].accel, drift: out[0].drift }
    expect(Object.is(first.steer, botIntent(ctx, s, 0).steer)).toBe(true)
    expect(out[0].tick).toBe(200)
```

After:

```ts
    // even tick 200: fresh compute
    resolveInputs(ctx, s, inputs, out)
    const first = { steer: out[0].steer, accel: out[0].accel, drift: out[0].drift }
    expect(Object.is(first.steer, botIntent(ctx, s, 0).steer)).toBe(true)
    expect(out[0].tick).toBe(200)
    // Plan 2 Task 1: the hold now lives on the state itself.
    expect(s.heldBotTick[0]).toBe(200)
    expect(Object.is(s.heldBotIntent[0].steer, first.steer)).toBe(true)
```

Then append a new test at the end of `describe('resolveInputs', ...)`, immediately before its closing `})`. Before:

```ts
    const fresh = botIntent(ctx, s, 0)
    expect(Object.is(out[0].steer, fresh.steer)).toBe(true)
    expect(Object.is(out[0].accel, fresh.accel)).toBe(true)
    expect(out[0].tick).toBe(301)
  })
})
```

After:

```ts
    const fresh = botIntent(ctx, s, 0)
    expect(Object.is(out[0].steer, fresh.steer)).toBe(true)
    expect(Object.is(out[0].accel, fresh.accel)).toBe(true)
    expect(out[0].tick).toBe(301)
  })

  it('proves two SimStates never share a bot hold, unlike the old module-scope design', () => {
    // The spec's motivating defect: two rooms driving bots in one process
    // interleave resolveInputs calls and drive each other's bots, measured at
    // 3 cm of divergence after 40 ticks. This reproduces the exact mechanism:
    // room1 computes a fresh hold on an even tick, then room2 -- cold, never
    // ticked before -- resolves an ODD tick immediately after. Under the old
    // module-scope hold, room2 would see holdTick[0] === room2.tick - 1 (both
    // are 200) and wrongly reuse room1's intent. With the hold on state, room2's
    // own heldBotTick starts at -1, so it must recompute from its own data.
    const ctx = makeContext(makeStraightTrack())
    const room1 = humanState(ctx, 'racing', 200)
    room1.karts[0].isBot = true

    const room2 = humanState(ctx, 'racing', 201)
    room2.karts[0].isBot = true
    room2.karts[0].position.z += 6 // displaced, so its own bot intent differs

    const out1 = makeIntentBuffer()
    resolveInputs(ctx, room1, makeIntentBuffer(), out1)
    expect(room1.heldBotTick[0]).toBe(200)

    const out2 = makeIntentBuffer()
    resolveInputs(ctx, room2, makeIntentBuffer(), out2)

    const fresh2 = botIntent(ctx, room2, 0)
    expect(Object.is(out2[0].steer, fresh2.steer)).toBe(true)
    expect(Object.is(out2[0].accel, fresh2.accel)).toBe(true)
    expect(room2.heldBotTick[0]).toBe(200) // room2's OWN hold tick
    expect(room1.heldBotTick[0]).toBe(200) // unaffected by room2's call

    // The two rooms' outputs genuinely differ, proving room2 did not simply
    // inherit room1's stale intent.
    expect(out1[0].steer === out2[0].steer && out1[0].accel === out2[0].accel).toBe(false)
  })
})
```

- [ ] **Step 10: Run test to verify it fails**

Run: `npx vitest run packages/sim/test/phase.test.ts -t "holds bot intents across a tick pair"`
Expected: FAIL — `expect(s.heldBotTick[0]).toBe(200)` reports `AssertionError: expected -1 to be 200`. `resolveInputs` still writes only the module-scope `holdTick`; `s.heldBotTick` was initialised to `-1` by `createState` (Step 3) and nothing has touched it since.

Run: `npx vitest run packages/sim/test/phase.test.ts -t "proves two SimStates"`
Expected: FAIL — `expect(room1.heldBotTick[0]).toBe(200)` reports `AssertionError: expected -1 to be 200`, for the same reason.

- [ ] **Step 11: Rewrite `resolveInputs` to use `state`, and delete the module-scope hold**

In `packages/sim/src/phase.ts`, delete the module-scope hold and `resetBotHold`. Before:

```ts
/**
 * The 30 Hz bot hold. Bots produce an Intent on even ticks only and the odd tick
 * of the pair reuses it, matching the 30 Hz human input rate exactly so bots and
 * humans quantise drift timing identically.
 *
 * This is the only simulation state that lives outside SimState, because
 * SimState is locked and has no field for it. `holdTick[i]` records the EVEN
 * tick the held intent belongs to; an odd tick may reuse the hold only when
 * `holdTick[i] === tick - 1`.
 */
const holdIntent: Intent[] = makeIntentBuffer()
const holdTick: Int32Array = new Int32Array(MAX_KARTS).fill(-1)

/** Clears the 30 Hz bot hold. Call this when starting or restarting a run. */
export function resetBotHold(): void {
  for (let i = 0; i < MAX_KARTS; i++) {
    holdTick[i] = -1
    const h = holdIntent[i]
    h.tick = 0
    h.steer = 0
    h.accel = 0
    h.brake = false
    h.drift = false
    h.useItem = false
  }
}

function freeze(o: Intent, tick: number): void {
```

After:

```ts
function freeze(o: Intent, tick: number): void {
```

Then rewrite `resolveInputs` itself. Before:

```ts
/**
 * Position 1 of the canonical per-kart order. Turns the raw per-slot intents
 * that arrived off the wire into the intents the rest of the tick actually
 * consumes.
 *
 *   - countdown  -> every slot is frozen to all-zero
 *   - bot slot, or a human whose `connected` is false -> botIntent, held at 30 Hz
 *   - connected human -> clamped, sanitised, restamped with `state.tick`
 *
 * `inputs` and `out` are indexed by kart slot: `inputs[i]` belongs to
 * `state.karts[i]`. Neither `inputs` nor `state` is mutated. Nothing allocates,
 * including `botIntent`: it returns a POOLED per-playerId Intent, the same
 * object on every call for that playerId, whose fields are copied out here by
 * copyIntent. The reference is never retained.
 */
export function resolveInputs(
  ctx: SimContext,
  state: SimState,
  inputs: Intent[],
  out: Intent[],
): void {
  const tick = state.tick
  const frozen = state.phase === 'countdown'

  for (let i = 0; i < MAX_KARTS; i++) {
    const o = out[i]

    if (frozen) {
      freeze(o, tick)
      continue
    }

    const k = state.karts[i]

    if (k.isBot || !k.connected) {
      if (tick % 2 === 0) {
        // even tick: recompute and own the pair (tick, tick + 1)
        copyIntent(botIntent(ctx, state, k.playerId), holdIntent[i], tick)
        holdTick[i] = tick
      } else if (holdTick[i] !== tick - 1) {
        // odd tick with no matching hold (cold start, or a slot that only just
        // became bot-driven): compute now and back-date the hold so the pair is
        // consistent from here on.
        copyIntent(botIntent(ctx, state, k.playerId), holdIntent[i], tick)
        holdTick[i] = tick - 1
      }
      copyIntent(holdIntent[i], o, tick)
      continue
    }

    const src = inputs[i]
    if (src === undefined || src === null) {
      freeze(o, tick)
      continue
    }

    o.tick = tick
    o.steer = Number.isFinite(src.steer) ? clamp(src.steer, -1, 1) : 0
    o.accel = Number.isFinite(src.accel) ? clamp(src.accel, 0, 1) : 0
    o.brake = src.brake === true
    o.drift = src.drift === true
    o.useItem = src.useItem === true
  }
}
```

After:

```ts
/**
 * Position 1 of the canonical per-kart order. Turns the raw per-slot intents
 * that arrived off the wire into the intents the rest of the tick actually
 * consumes.
 *
 *   - countdown  -> every slot is frozen to all-zero
 *   - bot slot, or a human whose `connected` is false -> botIntent, held at 30 Hz
 *   - connected human -> clamped, sanitised, restamped with `state.tick`
 *
 * `inputs` and `out` are indexed by kart slot: `inputs[i]` belongs to
 * `state.karts[i]`. `inputs` is never mutated. The 30Hz bot hold (Plan 2 Task 1)
 * lives on `state.heldBotIntent` / `state.heldBotTick`, so this is the only stage
 * that writes into `state` outside of `step()`'s own per-kart pipeline — every
 * other read of `state` in this function is read-only. `botIntent` allocates
 * nothing: it returns a POOLED per-playerId Intent, the same object on every
 * call for that playerId, whose fields are copied out here by copyIntent. The
 * reference is never retained.
 */
export function resolveInputs(
  ctx: SimContext,
  state: SimState,
  inputs: Intent[],
  out: Intent[],
): void {
  const tick = state.tick
  const frozen = state.phase === 'countdown'

  for (let i = 0; i < MAX_KARTS; i++) {
    const o = out[i]

    if (frozen) {
      freeze(o, tick)
      continue
    }

    const k = state.karts[i]

    if (k.isBot || !k.connected) {
      if (tick % 2 === 0) {
        // even tick: recompute and own the pair (tick, tick + 1)
        copyIntent(botIntent(ctx, state, k.playerId), state.heldBotIntent[i], tick)
        state.heldBotTick[i] = tick
      } else if (state.heldBotTick[i] !== tick - 1) {
        // odd tick with no matching hold (cold start, or a slot that only just
        // became bot-driven): compute now and back-date the hold so the pair is
        // consistent from here on.
        copyIntent(botIntent(ctx, state, k.playerId), state.heldBotIntent[i], tick)
        state.heldBotTick[i] = tick - 1
      }
      copyIntent(state.heldBotIntent[i], o, tick)
      continue
    }

    const src = inputs[i]
    if (src === undefined || src === null) {
      freeze(o, tick)
      continue
    }

    o.tick = tick
    o.steer = Number.isFinite(src.steer) ? clamp(src.steer, -1, 1) : 0
    o.accel = Number.isFinite(src.accel) ? clamp(src.accel, 0, 1) : 0
    o.brake = src.brake === true
    o.drift = src.drift === true
    o.useItem = src.useItem === true
  }
}
```

- [ ] **Step 12: Run test to verify it passes — then confirm the whole-suite breakage this deletion causes**

Run: `npx vitest run packages/sim/test/phase.test.ts -t "holds bot intents across a tick pair"` and `-t "proves two SimStates"`.
Expected: both PASS.

Run: `npx vitest run packages/sim`
Expected: FAIL. `resetBotHold` is deleted from `phase.ts` but `phase.test.ts`, `replay.test.ts` and `barrel.test.ts` still import and call it. Under this repo's esbuild-transpiled vitest, a named import with no matching export becomes `undefined` at the binding site rather than a link error, so every one of those calls fails at the call, not the import: `TypeError: resetBotHold is not a function`. Step 13 fixes all three files in one pass — this FAIL is expected and is not a separate bug to chase.

---

- [ ] **Step 13: Delete every remaining `resetBotHold` reference**

Four files. Each edit below removes a call or import that is now dead — `resetBotHold` no longer exists, and every state these tests use is already fresh from `createState`, which Step 3 made produce a clean hold on every call. None of these edits changes what any test asserts.

**`packages/sim/src/replay.ts`** — three edits.

Edit 1, the import. Before:

```ts
import { makeIntentBuffer, resetBotHold } from './phase'
```

After:

```ts
import { makeIntentBuffer } from './phase'
```

Edit 2, inside `recordRun`. Before:

```ts
  let a = allocStateLike(ctx, from)
  let b = allocStateLike(ctx, from)
  const inputs = makeIntentBuffer()
  const events: AuthEvent[] = []

  // Task 15's 30Hz bot hold is module-level state outside SimState. A run must
  // start from a cold hold or it inherits the previous run's last bot intent.
  resetBotHold()

  for (let n = 0; n < ticks; n++) {
```

After:

```ts
  let a = allocStateLike(ctx, from)
  let b = allocStateLike(ctx, from)
  const inputs = makeIntentBuffer()
  const events: AuthEvent[] = []

  for (let n = 0; n < ticks; n++) {
```

Edit 3, inside `replayRun`. Before:

```ts
  let a = allocStateLike(ctx, from)
  let b = allocStateLike(ctx, from)
  const inputs = makeIntentBuffer()
  const events: AuthEvent[] = []

  // Same reason as recordRun: start from a cold 30Hz bot hold. See the
  // checkpoint parity invariant in the file header.
  resetBotHold()

  while (a.tick < toTick) {
```

After:

```ts
  let a = allocStateLike(ctx, from)
  let b = allocStateLike(ctx, from)
  const inputs = makeIntentBuffer()
  const events: AuthEvent[] = []

  while (a.tick < toTick) {
```

**`packages/sim/test/phase.test.ts`** — five edits.

Edit 1, the import. Before:

```ts
import { FINISH_GRACE_TICKS, makeIntentBuffer, resetBotHold, resolveInputs, updatePhase } from '../src/phase'
```

After:

```ts
import { FINISH_GRACE_TICKS, makeIntentBuffer, resolveInputs, updatePhase } from '../src/phase'
```

Edit 2, inside `'freezes bots during countdown too'`. Before:

```ts
    const out = makeIntentBuffer()
    const inputs = makeIntentBuffer()

    resetBotHold()
    resolveInputs(ctx, s, inputs, out)

    expect(out[5].tick).toBe(180)
```

After:

```ts
    const out = makeIntentBuffer()
    const inputs = makeIntentBuffer()

    resolveInputs(ctx, s, inputs, out)

    expect(out[5].tick).toBe(180)
```

Edit 3, inside `'fills bot and disconnected slots from botIntent and ignores their raw input'`. Before:

```ts
    resetBotHold()
    resolveInputs(ctx, s, inputs, out)

    // bot slot: botIntent wins, raw input discarded
```

After:

```ts
    resolveInputs(ctx, s, inputs, out)

    // bot slot: botIntent wins, raw input discarded
```

Edit 4, inside `'holds bot intents across a tick pair so bots run at 30Hz'`. Before:

```ts
    const out = makeIntentBuffer()
    const inputs = makeIntentBuffer()

    resetBotHold()

    // even tick 200: fresh compute
    resolveInputs(ctx, s, inputs, out)
```

After:

```ts
    const out = makeIntentBuffer()
    const inputs = makeIntentBuffer()

    // even tick 200: fresh compute
    resolveInputs(ctx, s, inputs, out)
```

Edit 5, inside `'computes a fresh bot intent when the pair starts cold on an odd tick'`. Before:

```ts
    const out = makeIntentBuffer()

    resetBotHold()
    resolveInputs(ctx, s, makeIntentBuffer(), out)

    const fresh = botIntent(ctx, s, 0)
```

After:

```ts
    const out = makeIntentBuffer()

    resolveInputs(ctx, s, makeIntentBuffer(), out)

    const fresh = botIntent(ctx, s, 0)
```

Edit 6 (still `phase.test.ts`), inside `describe('step() wiring', ...)`'s `'runs resolveInputs at position 1 and updatePhase in the tail'`. Before:

```ts
    const events: AuthEvent[] = []

    resetBotHold()
    expect(cur.tick).toBe(0)
    expect(cur.phase).toBe('countdown')
```

After:

```ts
    const events: AuthEvent[] = []

    expect(cur.tick).toBe(0)
    expect(cur.phase).toBe('countdown')
```

**`packages/sim/test/replay.test.ts`** — import plus the calls inside `'is independent of a bot hold left dirty by an earlier run'`. That whole test is deleted in Step 15 below (its premise — a module-scope hold one run can poison for the next — no longer exists once the hold lives per-state), so only the import needs its own edit here; do not edit the test body separately. Before:

```ts
import { makeIntentBuffer, resetBotHold, resolveInputs } from '../src/phase'
```

After:

```ts
import { makeIntentBuffer, resolveInputs } from '../src/phase'
```

**`packages/sim/test/barrel.test.ts`** — three edits.

Edit 1, the import. Before:

```ts
  // phase [Task 15]
  FINISH_GRACE_TICKS,
  makeIntentBuffer,
  resetBotHold,
  resolveInputs,
  updatePhase,
  // replay [Task 16]
```

After:

```ts
  // phase [Task 15]
  FINISH_GRACE_TICKS,
  makeIntentBuffer,
  resolveInputs,
  updatePhase,
  // replay [Task 16]
```

Edit 2, the export inventory and its count. Before:

```ts
      ['bot.botIntent', botIntent],
      ['phase.makeIntentBuffer', makeIntentBuffer],
      ['phase.resetBotHold', resetBotHold],
      ['phase.resolveInputs', resolveInputs],
      ['phase.updatePhase', updatePhase],
      ['replay.intentOffset', intentOffset],
      ['replay.allocStateLike', allocStateLike],
      ['replay.recordRun', recordRun],
      ['replay.replayRun', replayRun],
    ]
    // 47 functions across the 18 modules that export any. The nineteenth,
    // `types`, exports only constants and types; the constants test below
    // covers it. 5 vec3 + 3 mathutil + 1 rng + 2 track + 4 state + 1 step
    // + 2 kart + 3 ground + 2 drift + 3 recovery + 1 collision + 1 laps
    // + 2 placement + 5 entity + 3 items + 1 bot + 4 phase + 4 replay = 47.
    expect(fns).toHaveLength(47)
```

After:

```ts
      ['bot.botIntent', botIntent],
      ['phase.makeIntentBuffer', makeIntentBuffer],
      ['phase.resolveInputs', resolveInputs],
      ['phase.updatePhase', updatePhase],
      ['replay.intentOffset', intentOffset],
      ['replay.allocStateLike', allocStateLike],
      ['replay.recordRun', recordRun],
      ['replay.replayRun', replayRun],
    ]
    // 46 functions across the 18 modules that export any. The nineteenth,
    // `types`, exports only constants and types; the constants test below
    // covers it. 5 vec3 + 3 mathutil + 1 rng + 2 track + 4 state + 1 step
    // + 2 kart + 3 ground + 2 drift + 3 recovery + 1 collision + 1 laps
    // + 2 placement + 5 entity + 3 items + 1 bot + 3 phase + 4 replay = 46.
    expect(fns).toHaveLength(46)
```

Edit 3, inside `'runs a tick through the barrel alone'`. Before:

```ts
    const inputs = makeIntentBuffer()
    const events: AuthEvent[] = []

    resetBotHold()
    step(ctx, prev, next, inputs, events)

    expect(next.tick).toBe(1)
```

After:

```ts
    const inputs = makeIntentBuffer()
    const events: AuthEvent[] = []

    step(ctx, prev, next, inputs, events)

    expect(next.tick).toBe(1)
```

Do not run the suite yet — Step 15 still has a test (`'is independent of a bot hold left dirty by an earlier run'`) whose body calls `resetBotHold` three times, and that body is deleted, not edited, in the next step. Deleting only the import here (as instructed above) and leaving the body in place would fail with the same `TypeError: resetBotHold is not a function`. Proceed directly to Step 14.

---

- [ ] **Step 14: Write the failing test — an even-tick checkpoint with bot-driven karts now replays bit-identically**

In `packages/sim/test/replay.test.ts`, replace the whole `describe('replayRun checkpoint parity guard', ...)` block (its three tests) with one test proving the opposite of what the guard used to enforce. Before:

```ts
describe('replayRun checkpoint parity guard', () => {
  it('rejects an even checkpoint tick when a bot-driven kart is racing', () => {
    const ctx = makeContext(makeOvalTrack())
    const start = botStart(ctx)

    // 360 is even and well past COUNTDOWN_TICKS (180), so the checkpoint is
    // racing, not countdown, and slots 4-7 are bot-driven: exactly the
    // condition needsOddCheckpoint is meant to catch.
    const seg1 = recordRun(ctx, start, 360, scriptedSrc)
    const seg2 = recordRun(ctx, seg1.end, 40, scriptedSrc)
    const checkpoint = allocStateLike(ctx, seg1.end)
    expect(checkpoint.tick % 2).toBe(0)
    expect(checkpoint.phase).toBe('racing')
    expect(checkpoint.karts.some((k) => k.isBot)).toBe(true)

    expect(() => replayRun(ctx, checkpoint, seg2.intents, 360, 400)).toThrow(
      /bot-driven or disconnected/,
    )
  })

  it('accepts an even checkpoint tick when every kart is connected and human', () => {
    const ctx = makeContext(makeOvalTrack())
    const start = humanStart(ctx)

    const N = 600
    const T = 360   // even, and no kart is bot-driven or disconnected
    const straight = recordRun(ctx, start, N, scriptedSrc)
    const seg1 = recordRun(ctx, start, T, scriptedSrc)
    const seg2 = recordRun(ctx, seg1.end, N - T, scriptedSrc)
    const checkpoint = allocStateLike(ctx, seg1.end)
    expect(checkpoint.tick % 2).toBe(0)
    expect(checkpoint.karts.every((k) => !k.isBot && k.connected)).toBe(true)

    // Must not throw, and the guard being scoped to bot/disconnected karts must
    // not have quietly become a blanket even-tick rejection.
    const replayed = replayRun(ctx, checkpoint, seg2.intents, T, N)
    expect(replayed.tick).toBe(600)
    expect(statesEqual(replayed, straight.end)).toBe(true)
  })

  it('accepts an even checkpoint tick with bot-driven karts during countdown', () => {
    const ctx = makeContext(makeOvalTrack())
    const start = botStart(ctx)   // phase stays 'countdown': createState's default

    // resolveInputs freezes every kart to all-zero while phase === 'countdown',
    // before it ever looks at isBot/connected, so the bot hold is never touched
    // here regardless of tick parity. 40 is even and well inside the 180-tick
    // countdown, so this checkpoint is the case needsOddCheckpoint must NOT flag.
    const N = 100
    const T = 40
    expect(T).toBeLessThan(COUNTDOWN_TICKS)
    const straight = recordRun(ctx, start, N, scriptedSrc)
    const seg1 = recordRun(ctx, start, T, scriptedSrc)
    const seg2 = recordRun(ctx, seg1.end, N - T, scriptedSrc)
    const checkpoint = allocStateLike(ctx, seg1.end)
    expect(checkpoint.tick % 2).toBe(0)
    expect(checkpoint.phase).toBe('countdown')
    expect(checkpoint.karts.some((k) => k.isBot)).toBe(true)

    const replayed = replayRun(ctx, checkpoint, seg2.intents, T, N)
    expect(replayed.tick).toBe(N)
    expect(statesEqual(replayed, straight.end)).toBe(true)
  })
})
```

After:

```ts
describe('replayRun with an even checkpoint and bot-driven karts', () => {
  it('replays bit-identically from an even checkpoint tick now that the hold lives in SimState', () => {
    const ctx = makeContext(makeOvalTrack())
    const start = botStart(ctx)

    // 360 is even and well past COUNTDOWN_TICKS (180): before this task this was
    // exactly the condition the deleted RangeError guard rejected. cloneState now
    // carries heldBotIntent/heldBotTick, so every tick is a legal checkpoint.
    const straight = recordRun(ctx, start, 600, scriptedSrc)
    const seg1 = recordRun(ctx, start, 360, scriptedSrc)
    const seg2 = recordRun(ctx, seg1.end, 240, scriptedSrc)
    expect(statesEqual(seg2.end, straight.end)).toBe(true)

    // the bots really drove: slot 7 is bot-driven and moved
    expect(straight.end.karts[7].isBot).toBe(true)
    expect(straight.end.karts[7].position.x).not.toBe(start.karts[7].position.x)

    const checkpoint = allocStateLike(ctx, seg1.end)
    expect(checkpoint.tick % 2).toBe(0)
    expect(checkpoint.phase).toBe('racing')
    expect(checkpoint.karts.some((k) => k.isBot)).toBe(true)

    const replayed = replayRun(ctx, checkpoint, seg2.intents, 360, 600)

    expect(replayed.tick).toBe(600)
    expect(statesEqual(replayed, straight.end)).toBe(true)
    for (let i = 4; i < MAX_KARTS; i++) {
      expect(Object.is(replayed.karts[i].position.x, straight.end.karts[i].position.x)).toBe(true)
      expect(Object.is(replayed.karts[i].heading, straight.end.karts[i].heading)).toBe(true)
      expect(Object.is(replayed.karts[i].drift.charge, straight.end.karts[i].drift.charge)).toBe(true)
    }
  })
})
```

The numbers (`T = 360`, `N = 600`, `N - T = 240`) are not new: they are the same `T`/`N` the deleted `'accepts an even checkpoint tick when every kart is connected and human'` test already ran successfully with human-only karts. This test changes only `humanStart(ctx)` to `botStart(ctx)` at that same split point, which is exactly the case the old guard used to refuse.

Also delete `'is independent of a bot hold left dirty by an earlier run'`, in the `describe('checkpoint-replay equivalence with bot-driven karts', ...)` block above the guard block. Its premise — that a module-scope hold left dirty by one `recordRun` call can poison the next one — no longer holds: the hold now lives inside each `SimState`, `allocStateLike` always clones it fresh from the state passed in, and there is no shared mutable location left for one run to poison for another. Before:

```ts
  it('is independent of a bot hold left dirty by an earlier run', () => {
    const ctx = makeContext(makeOvalTrack())
    resetBotHold()

    // kart.ts gates steering by `authority = sn * (1 - falloff * sn)`, sn = entry
    // speed / maxSpeed: a kart at rest has authority 0, so a poisoned steer intent
    // consumed on tick 1 of a cold start would move nothing and this test would
    // pass whether or not recordRun resets the hold. Two warm-up ticks give the
    // bots real, nonzero velocity so the poisoned steer is actually observable.
    const s0 = botStart(ctx)
    s0.phase = 'racing'
    const warm = recordRun(ctx, s0, 2, scriptedSrc).end
    expect(warm.tick % 2).toBe(0)   // even, so the next tick (odd) is a hold-reuse tick
    expect(warm.karts[4].velocity.x !== 0 || warm.karts[4].velocity.z !== 0).toBe(true)

    // Poison the module-level 30Hz hold: resolve the bot slots from a state offset
    // from `warm`, so holdTick becomes warm.tick and the real run's very next step
    // (the odd tick warm.tick + 1) would otherwise reuse this bogus intent instead
    // of recomputing.
    const bogus = allocStateLike(ctx, warm)
    for (let i = 4; i < MAX_KARTS; i++) bogus.karts[i].position.x += 25
    resetBotHold()
    resolveInputs(ctx, bogus, makeIntentBuffer(), makeIntentBuffer())

    const dirtyRun = recordRun(ctx, allocStateLike(ctx, warm), 40, scriptedSrc)

    resetBotHold()
    const cleanRun = recordRun(ctx, allocStateLike(ctx, warm), 40, scriptedSrc)

    expect(dirtyRun.end.tick).toBe(warm.tick + 40)
    expect(statesEqual(dirtyRun.end, cleanRun.end)).toBe(true)
  })
})
```

After: delete the whole `it(...)` block above, keeping the `describe`'s other test (`'is bit-identical from an odd checkpoint tick'`) and the block's closing `})`.

- [ ] **Step 15: Run test to verify it fails**

Run: `npx vitest run packages/sim/test/replay.test.ts -t "replays bit-identically from an even checkpoint"`
Expected: FAIL — `replayRun(ctx, checkpoint, seg2.intents, 360, 600)` throws `RangeError: replayRun: checkpoint at tick 360 is even, but a bot-driven or disconnected kart is active (phase is 'racing', not 'countdown')...` (the exact message the still-present guard in `replay.ts` constructs), and the test does not call `.toThrow(...)` — it calls `replayRun` directly and reads its return value, so vitest reports the raised `RangeError` as an unhandled test failure.

- [ ] **Step 16: Delete the checkpoint-parity guard and `needsOddCheckpoint`, and correct the file-header comment**

In `packages/sim/src/replay.ts`, first replace the "CHECKPOINT PARITY INVARIANT" section of the file's top doc comment — it now describes a hazard this task retires. Before:

```ts
 * CHECKPOINT PARITY INVARIANT
 *
 * Task 15's 30Hz bot hold is the one piece of simulation state outside
 * SimState, and therefore outside cloneState and statesEqual: bots recompute an
 * Intent only on even ticks and the odd tick of the pair reuses it. A checkpoint
 * at tick T replays bit-identically for any T when no kart is bot-driven. With
 * bots or disconnected karts present, T must be ODD, so the first replayed step
 * produces the even tick T+1 and recomputes bot intents from scratch. On an even
 * T the first replayed step produces an odd tick, which in the straight-through
 * run reused an intent derived from the kart data as it stood at the START of
 * tick T — data a checkpoint taken at the END of tick T does not contain.
 * Authority checkpoints are emitted on odd ticks.
 *
 * `replayRun` enforces this at runtime (see `needsOddCheckpoint`), not just in
 * this comment: an even-T checkpoint with a bot-driven or disconnected kart
 * outside the countdown phase throws a RangeError instead of silently
 * diverging. `resolveInputs` freezes every kart during countdown before it ever
 * looks at `isBot`/`connected`, so the hold is never touched there and an even
 * countdown-phase checkpoint is accepted at any parity.
 */
```

After:

```ts
 * CHECKPOINT PARITY — RETIRED BY PLAN 2 TASK 1
 *
 * Earlier, the 30Hz bot hold lived at module scope in phase.ts, outside
 * SimState and therefore outside cloneState/statesEqual, so a checkpoint taken
 * on an even tick could not capture it and replaying from one silently
 * diverged. `replayRun` used to enforce an odd-tick-only rule at runtime
 * (`needsOddCheckpoint`) for exactly that reason.
 *
 * Plan 2 Task 1 moved the hold into SimState as `heldBotIntent`/`heldBotTick`,
 * so `cloneState` now carries it exactly like every other field. Every tick is
 * a legal checkpoint regardless of parity, and the guard and
 * `needsOddCheckpoint` are gone.
 */
```

Then delete `needsOddCheckpoint` entirely. Before:

```ts
/**
 * True when restoring `state` and replaying forward would actually reach
 * Task 15's bot path (and therefore the 30Hz hold outside SimState) on the very
 * next tick — i.e. the checkpoint parity invariant binds.
 *
 * Mirrors `resolveInputs`'s own short-circuit order exactly, not just its
 * per-kart condition: `resolveInputs` checks `state.phase === 'countdown'`
 * FIRST and, when true, freezes every kart to all-zero and `continue`s before
 * ever looking at `isBot`/`connected` — so during countdown no kart's intent
 * comes from `botIntent`, no matter how many karts are bot-driven or
 * disconnected, and the hold is never touched. Only outside countdown does
 * `k.isBot || !k.connected` route a kart through the hold.
 */
function needsOddCheckpoint(state: SimState): boolean {
  if (state.phase === 'countdown') return false
  for (let i = 0; i < state.karts.length; i++) {
    const k = state.karts[i]
    if (k.isBot || !k.connected) return true
  }
  return false
}

/**
 * Run `ticks` steps from `from`, recording every raw Intent into a flat
 * Float64Array. `from` is never mutated; `end` is a fresh detached state.
```

After:

```ts
/**
 * Run `ticks` steps from `from`, recording every raw Intent into a flat
 * Float64Array. `from` is never mutated; `end` is a fresh detached state.
```

Then delete the `RangeError` guard inside `replayRun`. Before:

```ts
  if (fromTick < baseTick || toTick > baseTick + rows) {
    throw new RangeError(
      `replayRun: [${fromTick}, ${toTick}] is outside the recorded range ` +
        `[${baseTick}, ${baseTick + rows}]`,
    )
  }
  if (fromTick % 2 !== 1 && needsOddCheckpoint(from)) {
    throw new RangeError(
      `replayRun: checkpoint at tick ${fromTick} is even, but a bot-driven or ` +
        `disconnected kart is active (phase is '${from.phase}', not 'countdown'). ` +
        `Task 15's 30Hz bot-intent hold lives outside SimState, so cloneState/ ` +
        `allocStateLike cannot capture it: replaying from an even tick would ` +
        `silently recompute a different intent than the straight-through run used ` +
        `for the next (odd) tick, and the two runs would diverge with no error. ` +
        `Take authority checkpoints on odd ticks whenever any kart is bot-driven ` +
        `or disconnected.`,
    )
  }

  let a = allocStateLike(ctx, from)
```

After:

```ts
  if (fromTick < baseTick || toTick > baseTick + rows) {
    throw new RangeError(
      `replayRun: [${fromTick}, ${toTick}] is outside the recorded range ` +
        `[${baseTick}, ${baseTick + rows}]`,
    )
  }

  let a = allocStateLike(ctx, from)
```

- [ ] **Step 17: Run test to verify it passes, then the whole file**

Run: `npx vitest run packages/sim/test/replay.test.ts -t "replays bit-identically from an even checkpoint"`
Expected: PASS.

Run: `npx vitest run packages/sim/test/replay.test.ts`
Expected: PASS — every test in the file. The three deleted guard tests and the deleted dirty-hold test are gone from the count; nothing else in this file references `resetBotHold` or `needsOddCheckpoint` anymore.

Run: `npx vitest run packages/sim`
Expected: still FAIL — the five hand-built `SimState` literals (Step 18) are the only remaining breakage, and they are a `tsc`-only breakage (see the Step 4 note): `npx vitest run packages/sim` should actually be GREEN at this point, because none of those five files' tests exercise `cloneState`/`statesEqual`/`resolveInputs` on their hand-built states. Run it now to confirm; if anything besides those five files' own tests fails, stop and investigate before continuing — that would mean an assumption in this brief was wrong.

---

- [ ] **Step 18: Fix the five hand-built `SimState` literals so the package compiles**

Each of the five files below builds a `SimState` object literal directly (not through `createState`), ending its literal with a `finishedOrder` line. Add `heldBotIntent` and `heldBotTick` immediately after it, using the same neutral shape Step 3 gave `createState`. `Intent`'s fields are all wide primitive types (no literal unions to preserve), so TypeScript's contextual typing from the `SimState` return type accepts the inline array literal below without any new import in any of these five files.

**`packages/sim/test/recovery.test.ts`.** Before:

```ts
    itemBoxes: [],
    // Contract §0: finishedOrder is fixed length MAX_KARTS, unused slots hold -1.
    finishedOrder: new Array<number>(MAX_KARTS).fill(-1),
  }
}
```

After:

```ts
    itemBoxes: [],
    // Contract §0: finishedOrder is fixed length MAX_KARTS, unused slots hold -1.
    finishedOrder: new Array<number>(MAX_KARTS).fill(-1),
    // Plan 2 Task 1: SimState.heldBotIntent / heldBotTick, neutral and untouched.
    heldBotIntent: Array.from({ length: MAX_KARTS }, () => (
      { tick: 0, steer: 0, accel: 0, brake: false, drift: false, useItem: false }
    )),
    heldBotTick: new Array<number>(MAX_KARTS).fill(-1),
  }
}
```

**`packages/sim/test/collision.test.ts`.** Same before/after as `recovery.test.ts` immediately above — its `makeSimState` ends with the identical three lines (`itemBoxes: [],`, the `finishedOrder` comment and line, `}`, `}`).

**`packages/sim/test/entity.test.ts`.** Before:

```ts
    itemBoxes: [],
    finishedOrder: emptyFinishedOrder(),
  }
}
```

After:

```ts
    itemBoxes: [],
    finishedOrder: emptyFinishedOrder(),
    heldBotIntent: Array.from({ length: MAX_KARTS }, () => (
      { tick: 0, steer: 0, accel: 0, brake: false, drift: false, useItem: false }
    )),
    heldBotTick: new Array<number>(MAX_KARTS).fill(-1),
  }
}
```

**`packages/sim/test/laps.test.ts`.** Same before/after as `entity.test.ts` immediately above — its `blankState` ends with the identical two lines (`itemBoxes: [],`, `finishedOrder: emptyFinishedOrder(),`).

**`packages/sim/test/placement.test.ts`.** Same before/after as `entity.test.ts` above — its `blankState` ends with the identical two lines.

- [ ] **Step 19: Run the whole suite and typecheck**

Run: `npx vitest run packages/sim`
Expected: PASS — every test in the package.

Run: `npx tsc --noEmit -p packages/sim`
Expected: no output, exit code 0. If any error remains, it names a file and line; re-check that file's literal against the pattern above before assuming a new defect.

- [ ] **Step 20: Commit**

```bash
git add packages/sim/src/types.ts packages/sim/src/state.ts packages/sim/src/phase.ts \
        packages/sim/src/replay.ts \
        packages/sim/test/state.test.ts packages/sim/test/phase.test.ts \
        packages/sim/test/replay.test.ts packages/sim/test/barrel.test.ts \
        packages/sim/test/recovery.test.ts packages/sim/test/collision.test.ts \
        packages/sim/test/entity.test.ts packages/sim/test/laps.test.ts \
        packages/sim/test/placement.test.ts
git commit -m "feat(sim): move the 30Hz bot hold into SimState

SimState gains heldBotIntent/heldBotTick (both length MAX_KARTS), initialised
by createState, deep-copied by cloneState and compared by statesEqual exactly
like every other field. resolveInputs now reads and writes state instead of a
module-scope pair of arrays, which is what let two SimStates in one process
drive each other's bots -- measured at 3cm of divergence after 40 ticks,
silently. resetBotHold is deleted along with the module-scope arrays it reset.

With the hold inside the state, cloneState carries it and every tick is a
legal checkpoint: replayRun's checkpoint-parity RangeError guard and
needsOddCheckpoint are deleted, and an even-tick checkpoint with bot-driven
karts now replays bit-identically, which the new replay.test.ts case proves
directly against the same T/N an existing human-only test already used.

Five other test files build a SimState object literal without going through
createState; each grows the two new fields with neutral values so the package
still typechecks."
```
