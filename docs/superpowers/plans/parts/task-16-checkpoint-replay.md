### Task 16: Run Recorder and Checkpoint-Replay Equivalence

**Files:**
- Create: `packages/sim/src/replay.ts`
- Test: `packages/sim/test/replay.test.ts`

**Interfaces:**

- Consumes (all exist before this task; signatures repeated in full so this task can be read in isolation):
  - `packages/sim/src/types.ts` [Task 2] — `MAX_KARTS = 8`, `MAX_ENTITIES = 32`, `COUNTDOWN_TICKS = 180`, `TICK_DT = 1/60`, and the types `Intent`, `SimState`, `SimContext`, `AuthEvent`, `Track`, `Tuning`, `CharacterStats`.
    - `Intent` is exactly `{ tick: number; steer: number; accel: number; brake: boolean; drift: boolean; useItem: boolean }`.
    - `SimState` is exactly `{ tick, phase, raceSeed, rngCursor, nextEventSeq, finishTick, karts, entities, entityCount, nextEntityId, itemBoxes, finishedOrder }`; `karts` is always length `MAX_KARTS`, `entities` always length `MAX_ENTITIES` with live ones packed at the front and dead slots carrying `entityId === -1`, and `finishedOrder` always length `MAX_KARTS` with `-1` in every unfilled slot (locked contract §0 — it is never `push`ed, and `cloneState` throws if `dst` and `src` disagree on any of those lengths).
  - `packages/sim/src/rng.ts` [Task 2] — `export function rngAt(seed: number, cursor: number): number` (splitmix32, returns `[0, 1)`, pure: no hidden state, does not touch `SimState`).
  - `packages/sim/src/state.ts` [Task 5] —
    - `export function createState(ctx: SimContext, seed: number, characterIdx: number[]): SimState`
    - `export function cloneState(src: SimState, dst: SimState): void` — deep copy of every field, every one of the `MAX_KARTS` karts and **all `MAX_ENTITIES` entity slots including dead ones**, `itemBoxes`, and `finishedOrder`.
    - `export function statesEqual(a: SimState, b: SimState): boolean` — `Object.is` on every scalar, no exceptions and no epsilons.
  - `packages/sim/src/step.ts` [Task 5, extended by 6–15] — `export function step(ctx: SimContext, prev: SimState, next: SimState, inputs: Intent[], events: AuthEvent[]): void`. Writes into `next`, never mutates `prev`, sets `next.tick = prev.tick + 1`, never reads the wall clock, never calls `Math.random()`.
  - `packages/sim/src/phase.ts` [Task 15] —
    - `export function makeIntentBuffer(): Intent[]` — a new array of exactly `MAX_KARTS` distinct `Intent` objects, all fields zeroed.
    - `export function resetBotHold(): void` — clears the module-level 30 Hz bot-intent hold.
    - `export function resolveInputs(ctx: SimContext, state: SimState, inputs: Intent[], out: Intent[]): void` — runs at position 1 of the per-kart order; freezes all input while `state.phase === 'countdown'`, substitutes `botIntent` for any kart with `isBot` or `!connected` (recomputed only when `state.tick % 2 === 0`, reused on the odd tick of the pair), and clamps/sanitises everything else.
  - `packages/sim/test/fixtures/track-fixtures.ts` [Task 3] — `makeOvalTrack(overrides?: Partial<Track>): Track` (the golden fixture track), `makeStraightTrack(overrides?: Partial<Track>): Track`, and `makeContext(track: Track, isLeader?: boolean): SimContext` [Task 4, because it needs `buildTrackQuery`] (`isLeader` defaults to `true`).

- Produces:
  - `export const INTENT_HEADER = 4` — doubles of header at the front of a recording.
  - `export const INTENT_STRIDE = 5` — doubles per `(tick, slot)` intent: `steer, accel, brake, drift, useItem`.
  - `export function intentOffset(intents: Float64Array, tick: number, slot: number): number` — index of the first double of the intent recorded for kart slot `slot` at pre-step tick `tick`.
  - `export function allocStateLike(ctx: SimContext, src: SimState): SimState` — a brand-new, fully detached `SimState` holding a deep copy of `src`.
  - `export interface IntentSource { intentFor(state: SimState, playerId: number): Intent }` — verbatim from the locked contract.
  - `export function recordRun(ctx: SimContext, from: SimState, ticks: number, src: IntentSource): { end: SimState; intents: Float64Array }`
  - `export function replayRun(ctx: SimContext, from: SimState, intents: Float64Array, fromTick: number, toTick: number): SimState`

---

**The recording layout, fixed here:**

```
intents[0] = baseTick        the tick of the state the recording starts from
intents[1] = rows            number of recorded ticks
intents[2] = MAX_KARTS       8
intents[3] = INTENT_STRIDE   5

body index for (tick t, slot i):
  INTENT_HEADER + ((t - baseTick) * MAX_KARTS + i) * INTENT_STRIDE
    +0 steer     (float)
    +1 accel     (float)
    +2 brake     (0 or 1)
    +3 drift     (0 or 1)
    +4 useItem   (0 or 1)

total length = 4 + rows * 8 * 5 = 4 + 40 * rows
```

`Intent.tick` is **not** stored: it is implied by the row, and `resolveInputs`
restamps it from `state.tick` anyway. A row is keyed by the **pre-step** tick —
row `t` holds the intents fed to the step that consumes the state at tick `t` and
produces tick `t + 1`. The header makes the array self-describing, so
`replayRun` can range-check absolute tick numbers instead of trusting its caller.

---

**Why this test is same-process only, and why that is exactly enough:**

IEEE-754 makes `+ - * / sqrt` bit-exactly reproducible on every conforming
engine — the standard specifies correctly-rounded results, so the same sequence
of those operations on the same inputs produces the same bits everywhere.
`Math.sin`, `Math.cos`, `Math.atan2` and `Math.pow` are a different category.
ECMA-262 explicitly declines to specify their precision: implementations may use
any approximation of the mathematical function, with `fdlibm` recommended and
not required. V8, JavaScriptCore and SpiderMonkey use different polynomial
kernels and different argument-reduction paths, and V8 has changed its own
`Math.sin` across releases. One ULP of difference in `Math.cos(heading)` on tick
one becomes metres of kart separation a few hundred ticks later, because the
integrator feeds its own output straight back in.

Tapkart's simulation calls `Math.cos`/`Math.sin` for every kart on every tick —
the contract fixes `forward = (cos h, 0, sin h)` — and `Math.atan2` wherever a
heading is derived from a direction. Cross-engine bit-identity is therefore not
available, and no amount of test discipline creates it. Getting it would mean
fixed-point or a software transcendental library, which is what lockstep RTS
games actually do.

**And it is not needed, because Tapkart is not lockstep.** The design is
snapshot plus reconciliation. The authority alone decides what happened; clients
predict locally and are corrected against `WireSnapshot`, which is quantized to
roughly 21 bytes per kart and lossy by construction. A client is *already* being
pulled onto values it did not compute, twenty times a second, on purpose.
Nothing anywhere in the netcode compares two independently-simulated float
streams across two machines for equality. A lockstep design would, and that is
precisely why lockstep games ship fixed-point math and Tapkart does not have to.

What the same-process test does buy is the one property the whole netcode rests
on: **restoring a `SimState` and replaying inputs reproduces the state exactly.**
That is reconciliation, stated as a test. If it holds, a client that rewinds to
an authoritative checkpoint and replays its buffered inputs lands on precisely
the state the authority computed from those same inputs, so a correction settles
instead of oscillating. If it fails — because `step()` read a field that
`cloneState` forgot to copy, or kept state in a module-level variable, or
consumed a PRNG draw it did not record in `rngCursor`, or wrote past
`entityCount` into a dead slot that `cloneState` skips — then reconciliation
drifts silently and the defect surfaces three months later as "the game feels
rubbery under packet loss". This test converts that entire class of bug into a
red test, in one process, on one engine, where it is both provable and cheap.

**The one known piece of state outside `SimState`,** and therefore outside
`cloneState` and `statesEqual`, is Task 15's 30 Hz bot hold: bots recompute an
`Intent` only on even ticks and the odd tick of the pair reuses it, and there is
no `SimState` field to store the held value in. That yields a stated invariant:

> **Checkpoint parity invariant.** A checkpoint taken at tick `T` replays
> bit-identically for **any** `T` when no kart is bot-driven. When bots or
> disconnected karts are present, `T` must be **odd**, so that the first replayed
> step produces the even tick `T + 1`, and an even tick always recomputes bot
> intents from scratch. On an even `T` the first replayed step produces an odd
> tick, which in the straight-through run reused an intent derived from the kart
> data as it stood at the *start* of tick `T` — data a checkpoint taken at the
> *end* of tick `T` does not contain. Authority checkpoints are therefore emitted
> on odd ticks.

---

- [ ] **Step 1: Write the failing test — layout, round trip, and checkpoint equivalence**

Create `packages/sim/test/replay.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { Intent, SimContext, SimState } from '../src/types'
import { COUNTDOWN_TICKS, MAX_KARTS } from '../src/types'
import { rngAt } from '../src/rng'
import { cloneState, createState, statesEqual } from '../src/state'
import type { IntentSource } from '../src/replay'
import {
  INTENT_HEADER,
  INTENT_STRIDE,
  allocStateLike,
  intentOffset,
  recordRun,
  replayRun,
} from '../src/replay'
import { makeContext, makeOvalTrack } from './fixtures/track-fixtures'

const CHARS = [0, 1, 2, 3, 4, 5, 6, 7]
const SEED = 0x1234abcd

/** Eight human, connected karts. No bot hold involvement at all. */
function humanStart(ctx: SimContext): SimState {
  const s = createState(ctx, SEED, CHARS)
  for (let i = 0; i < MAX_KARTS; i++) {
    s.karts[i].isBot = false
    s.karts[i].connected = true
  }
  return s
}

/**
 * A deterministic, varied driver. Pure in (state.tick, playerId): it draws from
 * splitmix32 on its own seed, so it never touches state.rngCursor and cannot
 * interfere with authority item rolls.
 */
const scriptedSrc: IntentSource = {
  intentFor(state: SimState, playerId: number): Intent {
    const c = state.tick * MAX_KARTS + playerId
    const a = rngAt(0x5eed, c * 4 + 0)
    const b = rngAt(0x5eed, c * 4 + 1)
    const d = rngAt(0x5eed, c * 4 + 2)
    const e = rngAt(0x5eed, c * 4 + 3)
    return {
      tick: state.tick,
      steer: a * 2 - 1,        // full -1..1 sweep
      accel: b < 0.1 ? 0 : 1,  // throttle 90% of ticks
      brake: d < 0.05,
      drift: e < 0.35,
      useItem: d > 0.98,
    }
  },
}

/** playerId-dependent constants, all exact binary64 multiples of 1/8. */
const constSrc: IntentSource = {
  intentFor(state: SimState, playerId: number): Intent {
    return {
      tick: state.tick,
      steer: playerId * 0.125 - 0.5,
      accel: 1,
      brake: false,
      drift: playerId === 3,
      useItem: false,
    }
  },
}

describe('recordRun', () => {
  it('writes a flat Float64Array with a four-double header', () => {
    const ctx = makeContext(makeOvalTrack())
    const start = humanStart(ctx)
    start.phase = 'racing'   // skip the countdown so the karts actually move

    const rec = recordRun(ctx, start, 4, constSrc)

    // 4 header doubles + 4 ticks * 8 karts * 5 doubles = 4 + 160 = 164
    expect(INTENT_HEADER).toBe(4)
    expect(INTENT_STRIDE).toBe(5)
    expect(rec.intents.length).toBe(164)
    expect(rec.intents[0]).toBe(0)   // baseTick = start.tick
    expect(rec.intents[1]).toBe(4)   // rows
    expect(rec.intents[2]).toBe(8)   // MAX_KARTS
    expect(rec.intents[3]).toBe(5)   // INTENT_STRIDE
    expect(rec.end.tick).toBe(4)

    // offset(tick 0, slot 0) = 4 + ((0 - 0) * 8 + 0) * 5 = 4
    expect(intentOffset(rec.intents, 0, 0)).toBe(4)
    expect(rec.intents[4]).toBe(-0.5)   // steer   = 0 * 0.125 - 0.5
    expect(rec.intents[5]).toBe(1)      // accel
    expect(rec.intents[6]).toBe(0)      // brake   false
    expect(rec.intents[7]).toBe(0)      // drift   false
    expect(rec.intents[8]).toBe(0)      // useItem false

    // offset(tick 0, slot 3) = 4 + ((0 - 0) * 8 + 3) * 5 = 19
    expect(intentOffset(rec.intents, 0, 3)).toBe(19)
    expect(rec.intents[19]).toBe(-0.125)  // 3 * 0.125 - 0.5
    expect(rec.intents[22]).toBe(1)       // drift true only for playerId 3

    // offset(tick 3, slot 7) = 4 + ((3 - 0) * 8 + 7) * 5 = 4 + 155 = 159
    expect(intentOffset(rec.intents, 3, 7)).toBe(159)
    expect(rec.intents[159]).toBe(0.375)  // 7 * 0.125 - 0.5
    expect(rec.intents[160]).toBe(1)

    // the run did something
    expect(rec.end.karts[0].position.x).not.toBe(start.karts[0].position.x)
  })

  it('with zero ticks returns a detached copy of the start state', () => {
    const ctx = makeContext(makeOvalTrack())
    const start = humanStart(ctx)

    const rec = recordRun(ctx, start, 0, constSrc)

    expect(rec.intents.length).toBe(4)   // header only
    expect(rec.intents[1]).toBe(0)
    expect(rec.end).not.toBe(start)      // a different object...
    expect(statesEqual(rec.end, start)).toBe(true)  // ...with identical contents

    rec.end.karts[2].position.x += 999
    expect(start.karts[2].position.x).not.toBe(rec.end.karts[2].position.x)
  })

  it('does not mutate the state it was handed', () => {
    const ctx = makeContext(makeOvalTrack())
    const start = humanStart(ctx)
    start.phase = 'racing'
    const before = allocStateLike(ctx, start)

    recordRun(ctx, start, 30, scriptedSrc)

    expect(statesEqual(start, before)).toBe(true)
    expect(start.tick).toBe(0)
  })
})

describe('replayRun', () => {
  it('reproduces a recorded run from its own start state', () => {
    const ctx = makeContext(makeOvalTrack())
    const start = humanStart(ctx)
    start.phase = 'racing'

    const rec = recordRun(ctx, start, 40, scriptedSrc)
    const replayed = replayRun(ctx, allocStateLike(ctx, start), rec.intents, 0, 40)

    expect(replayed.tick).toBe(40)
    expect(statesEqual(replayed, rec.end)).toBe(true)
  })

  it('is repeatable and never mutates the state it resumes from', () => {
    const ctx = makeContext(makeOvalTrack())
    const start = humanStart(ctx)
    start.phase = 'racing'
    const rec = recordRun(ctx, start, 40, scriptedSrc)

    const from = allocStateLike(ctx, start)
    const savedX = from.karts[0].position.x
    const a = replayRun(ctx, from, rec.intents, 0, 40)
    const b = replayRun(ctx, from, rec.intents, 0, 40)

    expect(statesEqual(a, b)).toBe(true)
    expect(a).not.toBe(b)
    expect(from.tick).toBe(0)
    expect(Object.is(from.karts[0].position.x, savedX)).toBe(true)
  })
})

describe('checkpoint-replay equivalence', () => {
  // N = 600 ticks from tick 0. COUNTDOWN_TICKS = 180, so ticks 1..180 run with
  // frozen input and 181..600 are live racing: 420 racing ticks = 7.0 s at 60Hz.
  // The checkpoint is taken at T = 361, an odd tick (see the parity invariant),
  // leaving 600 - 361 = 239 ticks to replay.
  const N = 600
  const T = 361

  it('replays bit-identically from a full-precision checkpoint', () => {
    const ctx = makeContext(makeOvalTrack())
    const start = humanStart(ctx)

    // A: the straight-through run, 0 -> 600.
    const straight = recordRun(ctx, start, N, scriptedSrc)
    expect(straight.end.tick).toBe(600)
    expect(straight.end.phase).toBe('racing')   // 600 ticks is far short of 3 laps
    expect(straight.end.karts[0].position.x).not.toBe(start.karts[0].position.x)
    expect(straight.end.karts[7].position.x).not.toBe(start.karts[7].position.x)

    // B: the same trajectory, split at T so we hold the state at T.
    const seg1 = recordRun(ctx, start, T, scriptedSrc)          // 0 -> 361
    const seg2 = recordRun(ctx, seg1.end, N - T, scriptedSrc)   // 361 -> 600
    expect(seg1.end.tick).toBe(361)
    expect(seg2.end.tick).toBe(600)
    // splitting the run changes nothing: the sim is a pure function of state+input
    expect(statesEqual(seg2.end, straight.end)).toBe(true)

    // 4 + 239 * 8 * 5 = 4 + 9560 = 9564
    expect(seg2.intents.length).toBe(9564)
    expect(seg2.intents[0]).toBe(361)   // baseTick
    expect(seg2.intents[1]).toBe(239)   // rows
    // row 361 holds what the source produced from the state at tick 361
    const o = intentOffset(seg2.intents, 361, 5)
    expect(o).toBe(INTENT_HEADER + ((361 - 361) * MAX_KARTS + 5) * INTENT_STRIDE) // 29
    expect(seg2.intents[o]).toBe(scriptedSrc.intentFor(seg1.end, 5).steer)

    // The checkpoint: a full-precision structural clone, exactly what
    // AuthorityCheckpoint carries on the reliable channel.
    const checkpoint = allocStateLike(ctx, seg1.end)
    expect(checkpoint).not.toBe(seg1.end)
    expect(checkpoint.tick).toBe(361)
    expect(statesEqual(checkpoint, seg1.end)).toBe(true)

    // Restore it and replay the recorded inputs 361 -> 600.
    const replayed = replayRun(ctx, checkpoint, seg2.intents, T, N)

    expect(replayed.tick).toBe(600)
    expect(statesEqual(replayed, straight.end)).toBe(true)

    // statesEqual returns a bare boolean, so name the fields too: a failure
    // should say which kart and which quantity, not just "false".
    for (let i = 0; i < MAX_KARTS; i++) {
      const r = replayed.karts[i]
      const s = straight.end.karts[i]
      expect(Object.is(r.position.x, s.position.x)).toBe(true)
      expect(Object.is(r.position.y, s.position.y)).toBe(true)
      expect(Object.is(r.position.z, s.position.z)).toBe(true)
      expect(Object.is(r.velocity.x, s.velocity.x)).toBe(true)
      expect(Object.is(r.velocity.z, s.velocity.z)).toBe(true)
      expect(Object.is(r.heading, s.heading)).toBe(true)
      expect(Object.is(r.angularVelocity, s.angularVelocity)).toBe(true)
      expect(Object.is(r.drift.charge, s.drift.charge)).toBe(true)
      expect(r.drift.active).toBe(s.drift.active)
      expect(r.drift.dir).toBe(s.drift.dir)
      expect(r.item).toBe(s.item)
      expect(r.surface).toBe(s.surface)
      expect(r.airborne).toBe(s.airborne)
      expect(r.boostTicks).toBe(s.boostTicks)
      expect(r.spinOutTicks).toBe(s.spinOutTicks)
      expect(r.invulnTicks).toBe(s.invulnTicks)
      expect(r.respawnTicks).toBe(s.respawnTicks)
      expect(r.lap.lap).toBe(s.lap.lap)
      expect(r.lap.checkpointIdx).toBe(s.lap.checkpointIdx)
      expect(Object.is(r.lap.t, s.lap.t)).toBe(true)
    }

    // World state, not just karts: PRNG cursor, event sequence, entity pool.
    expect(replayed.rngCursor).toBe(straight.end.rngCursor)
    expect(replayed.nextEventSeq).toBe(straight.end.nextEventSeq)
    expect(replayed.nextEntityId).toBe(straight.end.nextEntityId)
    expect(replayed.entityCount).toBe(straight.end.entityCount)
    expect(replayed.phase).toBe(straight.end.phase)
    expect(replayed.finishTick).toBe(straight.end.finishTick)
    expect(replayed.finishedOrder).toEqual(straight.end.finishedOrder)
    for (let e = 0; e < replayed.entities.length; e++) {
      expect(replayed.entities[e].entityId).toBe(straight.end.entities[e].entityId)
      expect(Object.is(replayed.entities[e].position.x, straight.end.entities[e].position.x)).toBe(true)
      expect(replayed.entities[e].ttl).toBe(straight.end.entities[e].ttl)
    }

    // The checkpoint is a real copy, not a view onto seg1.end.
    checkpoint.karts[0].position.x += 1000
    expect(seg1.end.karts[0].position.x).not.toBe(checkpoint.karts[0].position.x)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/sim/test/replay.test.ts`

Expected: FAIL with `Error: Failed to resolve import "../src/replay" from "packages/sim/test/replay.test.ts". Does the file exist?`

- [ ] **Step 3: Write minimal implementation**

Create `packages/sim/src/replay.ts`:

```ts
import type { AuthEvent, Intent, SimContext, SimState } from './types'
import { MAX_KARTS } from './types'
import { cloneState, createState } from './state'
import { step } from './step'
import { makeIntentBuffer } from './phase'

/** Doubles of header at the front of a recording. */
export const INTENT_HEADER = 4
/** Doubles per (tick, slot) intent: steer, accel, brake, drift, useItem. */
export const INTENT_STRIDE = 5

/**
 * Index of the first double of the intent recorded for kart slot `slot` at
 * pre-step tick `tick`. Row `t` holds the intents fed to the step that consumes
 * the state at tick `t` and produces tick `t + 1`.
 */
export function intentOffset(intents: Float64Array, tick: number, slot: number): number {
  const baseTick = intents[0]
  return INTENT_HEADER + ((tick - baseTick) * MAX_KARTS + slot) * INTENT_STRIDE
}

/**
 * A brand-new SimState holding a deep copy of `src`. `createState` is the only
 * constructor that builds the fixed-size karts/entities/itemBoxes arrays, so it
 * builds the shape and `cloneState` fills in every value.
 */
export function allocStateLike(ctx: SimContext, src: SimState): SimState {
  const characterIdx: number[] = []
  for (let i = 0; i < MAX_KARTS; i++) characterIdx.push(src.karts[i].characterIdx)
  const s = createState(ctx, src.raceSeed, characterIdx)
  cloneState(src, s)
  return s
}

/** Anything that can answer "what did this player do on this tick". */
export interface IntentSource {
  intentFor(state: SimState, playerId: number): Intent
}

/**
 * Run `ticks` steps from `from`, recording every raw Intent into a flat
 * Float64Array. `from` is never mutated; `end` is a fresh detached state.
 *
 * The raw intents are recorded, not the resolved ones: what a replay must
 * reproduce is the input that arrived, and `resolveInputs` (countdown freeze,
 * bot fill, clamping) is part of the simulation, not part of the input.
 */
export function recordRun(
  ctx: SimContext,
  from: SimState,
  ticks: number,
  src: IntentSource,
): { end: SimState; intents: Float64Array } {
  const baseTick = from.tick
  const intents = new Float64Array(INTENT_HEADER + ticks * MAX_KARTS * INTENT_STRIDE)
  intents[0] = baseTick
  intents[1] = ticks
  intents[2] = MAX_KARTS
  intents[3] = INTENT_STRIDE

  let a = allocStateLike(ctx, from)
  let b = allocStateLike(ctx, from)
  const inputs = makeIntentBuffer()
  const events: AuthEvent[] = []

  for (let n = 0; n < ticks; n++) {
    const t = a.tick
    const row = INTENT_HEADER + (t - baseTick) * MAX_KARTS * INTENT_STRIDE
    for (let slot = 0; slot < MAX_KARTS; slot++) {
      const it = src.intentFor(a, a.karts[slot].playerId)
      const o = row + slot * INTENT_STRIDE
      intents[o] = it.steer
      intents[o + 1] = it.accel
      intents[o + 2] = it.brake ? 1 : 0
      intents[o + 3] = it.drift ? 1 : 0
      intents[o + 4] = it.useItem ? 1 : 0

      const dst = inputs[slot]
      dst.tick = t + 1
      dst.steer = it.steer
      dst.accel = it.accel
      dst.brake = it.brake
      dst.drift = it.drift
      dst.useItem = it.useItem
    }
    events.length = 0   // events are not part of the recording; drop them
    step(ctx, a, b, inputs, events)
    const tmp = a
    a = b
    b = tmp
  }

  return { end: a, intents }
}

/**
 * Restore `from` (a full-precision checkpoint at tick `fromTick`) and replay the
 * recorded intents forward to `toTick`. `from` is never mutated; the returned
 * state is a fresh object.
 */
export function replayRun(
  ctx: SimContext,
  from: SimState,
  intents: Float64Array,
  fromTick: number,
  toTick: number,
): SimState {
  const baseTick = intents[0]

  let a = allocStateLike(ctx, from)
  let b = allocStateLike(ctx, from)
  const inputs = makeIntentBuffer()
  const events: AuthEvent[] = []

  while (a.tick < toTick) {
    const row = INTENT_HEADER + (a.tick - baseTick) * MAX_KARTS * INTENT_STRIDE
    for (let slot = 0; slot < MAX_KARTS; slot++) {
      const o = row + slot * INTENT_STRIDE
      const dst = inputs[slot]
      dst.tick = a.tick + 1
      dst.steer = intents[o]
      dst.accel = intents[o + 1]
      dst.brake = intents[o + 2] !== 0
      dst.drift = intents[o + 3] !== 0
      dst.useItem = intents[o + 4] !== 0
    }
    events.length = 0
    step(ctx, a, b, inputs, events)
    const tmp = a
    a = b
    b = tmp
  }

  return a
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/sim/test/replay.test.ts`

Expected: PASS — 6 tests, including `checkpoint-replay equivalence > replays bit-identically from a full-precision checkpoint`.

If the equivalence test fails here, do not weaken it. It has caught a real defect in `cloneState` or `step()`. The four usual causes, in order of likelihood: `cloneState` skips entity slots past `entityCount`; `step()` reads a `SimState` field `cloneState` never copies; something in the tick keeps state in a module-level variable other than Task 15's bot hold; something consumes a PRNG draw without recording it in `rngCursor`. Bisect by shrinking `N - T` until the divergence appears, then compare the two states field by field at that tick.

- [ ] **Step 5: Write the failing test — range guards, hold hygiene, and `statesEqual` strictness**

Append to `packages/sim/test/replay.test.ts`. First extend the imports at the top of the file.

Replace:

```ts
import { makeContext, makeOvalTrack } from './fixtures/track-fixtures'
```

with:

```ts
import { makeIntentBuffer, resetBotHold, resolveInputs } from '../src/phase'
import { makeContext, makeOvalTrack } from './fixtures/track-fixtures'
```

Then append these describe blocks:

```ts
/** Bumps a finite double by exactly one unit in the last place, away from zero. */
function ulpUp(x: number): number {
  const dv = new DataView(new ArrayBuffer(8))
  dv.setFloat64(0, x)
  const hi = dv.getUint32(0)
  const lo = dv.getUint32(4)
  if (lo === 0xffffffff) {
    dv.setUint32(0, hi + 1)
    dv.setUint32(4, 0)
  } else {
    dv.setUint32(4, lo + 1)
  }
  return dv.getFloat64(0)
}

/** Slots 0-3 human and connected, slots 4-7 bot-driven. */
function botStart(ctx: SimContext): SimState {
  const s = createState(ctx, SEED, CHARS)
  for (let i = 0; i < MAX_KARTS; i++) {
    s.karts[i].isBot = i >= 4
    s.karts[i].connected = true
  }
  return s
}

describe('statesEqual is Object.is-strict', () => {
  it('rejects a one-ULP difference', () => {
    const ctx = makeContext(makeOvalTrack())
    const start = humanStart(ctx)
    start.phase = 'racing'
    const rec = recordRun(ctx, start, 60, scriptedSrc)

    const probe = allocStateLike(ctx, rec.end)
    expect(statesEqual(probe, rec.end)).toBe(true)

    probe.karts[5].velocity.x = ulpUp(probe.karts[5].velocity.x)
    expect(probe.karts[5].velocity.x).not.toBe(rec.end.karts[5].velocity.x)
    expect(statesEqual(probe, rec.end)).toBe(false)
  })

  it('distinguishes 0 from -0, per the contract', () => {
    const ctx = makeContext(makeOvalTrack())
    const start = humanStart(ctx)
    const a = allocStateLike(ctx, start)
    const b = allocStateLike(ctx, start)
    a.karts[2].angularVelocity = 0
    b.karts[2].angularVelocity = -0

    expect(a.karts[2].angularVelocity === b.karts[2].angularVelocity).toBe(true) // === says equal
    expect(Object.is(a.karts[2].angularVelocity, b.karts[2].angularVelocity)).toBe(false)
    expect(statesEqual(a, b)).toBe(false)   // statesEqual must agree with Object.is
  })
})

describe('the equivalence test can actually fail', () => {
  it('diverges when the checkpoint is perturbed by one millimetre', () => {
    const ctx = makeContext(makeOvalTrack())
    const start = humanStart(ctx)
    const straight = recordRun(ctx, start, 600, scriptedSrc)
    const seg1 = recordRun(ctx, start, 361, scriptedSrc)
    const seg2 = recordRun(ctx, seg1.end, 239, scriptedSrc)

    const perturbed = allocStateLike(ctx, seg1.end)
    perturbed.karts[3].position.x = perturbed.karts[3].position.x + 1e-3

    const diverged = replayRun(ctx, perturbed, seg2.intents, 361, 600)

    expect(diverged.tick).toBe(600)
    expect(statesEqual(diverged, straight.end)).toBe(false)
    expect(statesEqual(seg2.end, straight.end)).toBe(true)  // the control still holds
  })
})

describe('replayRun range guards', () => {
  it('rejects a checkpoint whose tick does not match fromTick', () => {
    const ctx = makeContext(makeOvalTrack())
    const start = humanStart(ctx)
    const seg1 = recordRun(ctx, start, 361, scriptedSrc)
    const seg2 = recordRun(ctx, seg1.end, 239, scriptedSrc)
    const cp = allocStateLike(ctx, seg1.end)   // cp.tick === 361

    expect(() => replayRun(ctx, cp, seg2.intents, 360, 600)).toThrow(RangeError)
    expect(() => replayRun(ctx, cp, seg2.intents, 362, 600)).toThrow(RangeError)
  })

  it('rejects a tick range outside the recording', () => {
    const ctx = makeContext(makeOvalTrack())
    const start = humanStart(ctx)
    const seg1 = recordRun(ctx, start, 361, scriptedSrc)
    const seg2 = recordRun(ctx, seg1.end, 239, scriptedSrc)
    const cp = allocStateLike(ctx, seg1.end)

    // recorded rows cover 361..599, so toTick may be at most 361 + 239 = 600
    expect(() => replayRun(ctx, cp, seg2.intents, 361, 601)).toThrow(RangeError)
    // toTick before fromTick
    expect(() => replayRun(ctx, cp, seg2.intents, 361, 360)).toThrow(RangeError)
    // a checkpoint that predates the recording's baseTick of 361
    const early = allocStateLike(ctx, start)   // tick 0
    expect(() => replayRun(ctx, early, seg2.intents, 0, 4)).toThrow(RangeError)
    // the exact boundary is legal and is a no-op replay
    const edge = replayRun(ctx, cp, seg2.intents, 361, 361)
    expect(edge.tick).toBe(361)
    expect(statesEqual(edge, seg1.end)).toBe(true)
  })
})

describe('checkpoint-replay equivalence with bot-driven karts', () => {
  it('is bit-identical from an odd checkpoint tick', () => {
    const ctx = makeContext(makeOvalTrack())
    const start = botStart(ctx)

    const straight = recordRun(ctx, start, 600, scriptedSrc)
    const seg1 = recordRun(ctx, start, 361, scriptedSrc)   // 361 is odd
    const seg2 = recordRun(ctx, seg1.end, 239, scriptedSrc)
    expect(statesEqual(seg2.end, straight.end)).toBe(true)

    // the bots really drove: slot 7 is bot-driven and moved
    expect(straight.end.karts[7].isBot).toBe(true)
    expect(straight.end.karts[7].position.x).not.toBe(start.karts[7].position.x)

    const checkpoint = allocStateLike(ctx, seg1.end)
    expect(checkpoint.tick % 2).toBe(1)   // the parity invariant this test rests on

    const replayed = replayRun(ctx, checkpoint, seg2.intents, 361, 600)

    expect(replayed.tick).toBe(600)
    expect(statesEqual(replayed, straight.end)).toBe(true)
    for (let i = 4; i < MAX_KARTS; i++) {
      expect(Object.is(replayed.karts[i].position.x, straight.end.karts[i].position.x)).toBe(true)
      expect(Object.is(replayed.karts[i].heading, straight.end.karts[i].heading)).toBe(true)
      expect(Object.is(replayed.karts[i].drift.charge, straight.end.karts[i].drift.charge)).toBe(true)
    }
  })

  it('is independent of a bot hold left dirty by an earlier run', () => {
    const ctx = makeContext(makeOvalTrack())

    // Poison the module-level 30Hz hold: resolve a bot slot on EVEN tick 0 from
    // a state the real run never visits, so holdTick becomes 0 and the real
    // run's first step (odd tick 1) would otherwise reuse this bogus intent.
    const bogus = botStart(ctx)
    bogus.phase = 'racing'
    bogus.tick = 0
    for (let i = 4; i < MAX_KARTS; i++) bogus.karts[i].position.x += 25
    resetBotHold()
    resolveInputs(ctx, bogus, makeIntentBuffer(), makeIntentBuffer())

    const dirtyRun = recordRun(ctx, (() => {
      const s = botStart(ctx)
      s.phase = 'racing'
      return s
    })(), 40, scriptedSrc)

    resetBotHold()
    const cleanRun = recordRun(ctx, (() => {
      const s = botStart(ctx)
      s.phase = 'racing'
      return s
    })(), 40, scriptedSrc)

    expect(dirtyRun.end.tick).toBe(40)
    expect(statesEqual(dirtyRun.end, cleanRun.end)).toBe(true)
  })
})
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run packages/sim/test/replay.test.ts`

Expected: FAIL, 3 failing tests:
- `replayRun range guards > rejects a checkpoint whose tick does not match fromTick` — `expected [Function] to throw an error` (with `fromTick` 360 the replay silently reads row 360 of a recording that starts at 361, i.e. reads before the array body).
- `replayRun range guards > rejects a tick range outside the recording` — same message; `toTick` 601 currently reads five zeroes off the end of the `Float64Array`, which is `undefined`, and produces `NaN` positions rather than an error.
- `checkpoint-replay equivalence with bot-driven karts > is independent of a bot hold left dirty by an earlier run` — `expected false to be true`: `recordRun` does not reset the hold, so the first run reuses the poisoned intent on tick 1 and the second does not.

- [ ] **Step 7: Add the range guards and the bot-hold reset**

Three edits to `packages/sim/src/replay.ts`.

**Edit 1 — import `resetBotHold`.** Before:

```ts
import { makeIntentBuffer } from './phase'
```

After:

```ts
import { makeIntentBuffer, resetBotHold } from './phase'
```

**Edit 2 — reset the hold in `recordRun`.** Before:

```ts
  const inputs = makeIntentBuffer()
  const events: AuthEvent[] = []

  for (let n = 0; n < ticks; n++) {
    const t = a.tick
```

After:

```ts
  const inputs = makeIntentBuffer()
  const events: AuthEvent[] = []

  // Task 15's 30Hz bot hold is module-level state outside SimState. A run must
  // start from a cold hold or it inherits the previous run's last bot intent.
  resetBotHold()

  for (let n = 0; n < ticks; n++) {
    const t = a.tick
```

**Edit 3 — guard and reset in `replayRun`.** Before:

```ts
  const baseTick = intents[0]

  let a = allocStateLike(ctx, from)
  let b = allocStateLike(ctx, from)
  const inputs = makeIntentBuffer()
  const events: AuthEvent[] = []

  while (a.tick < toTick) {
```

After:

```ts
  const baseTick = intents[0]
  const rows = intents[1]

  if (from.tick !== fromTick) {
    throw new RangeError(
      `replayRun: checkpoint is at tick ${from.tick} but fromTick is ${fromTick}`,
    )
  }
  if (toTick < fromTick) {
    throw new RangeError(`replayRun: toTick ${toTick} is before fromTick ${fromTick}`)
  }
  if (fromTick < baseTick || toTick > baseTick + rows) {
    throw new RangeError(
      `replayRun: [${fromTick}, ${toTick}] is outside the recorded range ` +
        `[${baseTick}, ${baseTick + rows}]`,
    )
  }

  let a = allocStateLike(ctx, from)
  let b = allocStateLike(ctx, from)
  const inputs = makeIntentBuffer()
  const events: AuthEvent[] = []

  // Same reason as recordRun: start from a cold 30Hz bot hold. See the
  // checkpoint parity invariant in the file header.
  resetBotHold()

  while (a.tick < toTick) {
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npx vitest run packages/sim/test/replay.test.ts`

Expected: PASS — 12 tests.

- [ ] **Step 9: Document the same-process boundary in the module itself**

Add this block at the very top of `packages/sim/src/replay.ts`, above the existing `import type { AuthEvent, ... }` line:

```ts
/**
 * Deterministic run recorder and replayer.
 *
 * WHY THE EQUIVALENCE TEST IS SAME-PROCESS ONLY, AND WHY THAT IS ENOUGH
 *
 * IEEE-754 makes `+ - * / sqrt` bit-exactly reproducible on every conforming
 * engine: the standard specifies correctly-rounded results. `Math.sin`,
 * `Math.cos`, `Math.atan2` and `Math.pow` are not in that category. ECMA-262
 * explicitly declines to specify their precision — an implementation may use
 * any approximation of the mathematical function, with fdlibm recommended and
 * not required. V8, JavaScriptCore and SpiderMonkey use different kernels and
 * different argument-reduction paths, and V8 has changed its own `Math.sin`
 * across releases. One ULP of difference in `Math.cos(heading)` on tick one
 * becomes metres of separation a few hundred ticks later, because the
 * integrator feeds its own output back in.
 *
 * This sim calls `Math.cos`/`Math.sin` for every kart on every tick — the
 * contract fixes `forward = (cos h, 0, sin h)` — and `Math.atan2` wherever a
 * heading is derived from a direction. Cross-engine bit-identity is therefore
 * unavailable, and no test discipline creates it; you would need fixed-point or
 * a software transcendental library, which is what lockstep RTS games ship.
 *
 * It is also unnecessary. Tapkart is snapshot + reconciliation, not lockstep.
 * The authority alone decides what happened; clients predict locally and are
 * corrected against `WireSnapshot`, which is quantized to ~21 bytes per kart and
 * lossy by construction — a client is already being pulled onto values it did
 * not compute, twenty times a second, by design. Nothing in the netcode compares
 * two independently-simulated float streams across two machines for equality.
 *
 * What the same-process test does prove is the property reconciliation is built
 * on: restoring a SimState and replaying inputs reproduces the state exactly.
 * A client that rewinds to an authoritative checkpoint and replays its buffered
 * inputs then lands on precisely the state the authority computed, so a
 * correction settles instead of oscillating.
 *
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
 */
```

Run: `npx vitest run packages/sim/test/replay.test.ts`

Expected: PASS — 12 tests, unchanged. A comment cannot break the suite, but confirm the file still parses.

- [ ] **Step 10: Run the full sim suite and typecheck**

Run: `npx tsc --noEmit -p packages/sim && npx vitest run packages/sim`

Expected: PASS, zero type errors, every sim test green.

- [ ] **Step 11: Commit**

```bash
git add packages/sim/src/replay.ts packages/sim/test/replay.test.ts
git commit -m "feat(sim): run recorder, replayer, and checkpoint-replay equivalence

recordRun steps a run forward while writing every raw Intent into a flat
Float64Array with a self-describing four-double header; replayRun
restores a full-precision checkpoint and replays a recorded tick range
forward, range-checked against the recording.

The equivalence test is the load-bearing one: 600 ticks from createState,
a structural clone taken at tick 361, restored and replayed to 600, and
asserted bit-identical against the straight-through run via statesEqual
plus per-field Object.is. That property is reconciliation. Bit-identity
is asserted same-process only, because Math.sin/cos are not
precision-specified by ECMA-262 - and it is unnecessary across engines,
because the design uses snapshot + reconciliation rather than lockstep.
Documented in the module header along with the odd-tick checkpoint parity
invariant that Task 15's module-level 30Hz bot hold imposes."
```
