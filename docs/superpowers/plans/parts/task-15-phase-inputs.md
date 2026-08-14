### Task 15: Race Phase and Input Resolution

**Files:**
- Create: `packages/sim/src/phase.ts`
- Modify: `packages/sim/src/step.ts` (import block, the module-scope input buffer Task 6 created, and three exact anchors inside `step()`; all five edits shown verbatim in Step 11)
- Test: `packages/sim/test/phase.test.ts`

**Interfaces:**

- Consumes (all exist before this task; signatures repeated in full so this task can be read in isolation):
  - `packages/sim/src/types.ts` [Task 2] — `TICK_HZ = 60`, `TICK_DT = 1/60`, `MAX_KARTS = 8`, `MAX_ENTITIES = 32`, `RACE_LAPS = 3`, `COUNTDOWN_TICKS = 180`, and the types `Vec3`, `Intent`, `DriftState`, `LapProgress`, `KartState`, `EntityState`, `SimState`, `SimContext`, `AuthEvent`, `AuthEventKind`, `ItemKind`, `RacePhase`, `Tuning`, `Track`, `TrackQuery`, `CharacterStats`.
    - `Intent` is exactly `{ tick: number; steer: number; accel: number; brake: boolean; drift: boolean; useItem: boolean }`.
    - `SimState` is exactly `{ tick, phase, raceSeed, rngCursor, nextEventSeq, finishTick, karts, entities, entityCount, nextEntityId, itemBoxes, finishedOrder }`; `karts` is always length `MAX_KARTS`; `finishTick` is `-1` until the first kart finishes.
    - `finishedOrder` is a **fixed-length** `number[]` of length `MAX_KARTS` (locked contract §0). Slot `p` holds the `playerId` that finished in 1-based place `p + 1`; every unused slot holds `-1`. It is **never** `push`ed, never `indexOf`ed and never read through `.length` for a finisher count — `cloneState` throws when `dst` and `src` differ in shape, so growing it past 8 would break `recordRun`/`replayRun` [Task 16] and the golden run [Task 17]. Count finishers by scanning the 8 slots for entries `!== -1`.
    - `RacePhase = 'countdown' | 'racing' | 'finished'`.
    - `SimContext` is `{ track, query, tuning, characters, isLeader }`; `isLeader` is `true` only on the authority that assigns event sequence numbers.
  - `packages/sim/src/mathutil.ts` [Task 2] — `export function clamp(v: number, lo: number, hi: number): number`
  - `packages/sim/src/state.ts` [Task 5] — `export function createState(ctx: SimContext, seed: number, characterIdx: number[]): SimState`, and `export function emit(state: SimState, out: AuthEvent[], kind: AuthEventKind, playerId: number, entityId: number, item: ItemKind, data: number): void` (pushes one `AuthEvent` onto `out` with `eventSeq = state.nextEventSeq`, then increments `state.nextEventSeq`).
  - `packages/sim/src/bot.ts` [Task 14] — `export function botIntent(ctx: SimContext, state: SimState, playerId: number): Intent` (pure: same `(ctx, state, playerId)` returns the same field values; it never mutates `state` and never advances `state.rngCursor`). It returns a **pooled** `Intent`, one object per `playerId`, reused on every call — `botIntent(ctx, s, 2) === botIntent(ctx, s, 2)` is `true`, and the next call for that `playerId` overwrites the fields in place. Callers must **copy the fields out** (this task's `copyIntent`) and must never retain the reference.
  - `packages/sim/src/placement.ts` [Task 11] — `export function placementOrder(state: SimState): number[]` (returns all `MAX_KARTS` `playerId`s best-first, ordered by `lap.lap` descending, then `lap.checkpointIdx` descending, then `lap.t` descending).
  - `packages/sim/src/step.ts` [Task 5, extended by 6–14] — `export function step(ctx: SimContext, prev: SimState, next: SimState, inputs: Intent[], events: AuthEvent[]): void`
  - `packages/sim/test/fixtures/track-fixtures.ts` [Task 3] — `makeTuning(overrides?: Partial<Tuning>): Tuning`, `makeCharacters(): CharacterStats[]`, `makeStraightTrack(overrides?: Partial<Track>): Track`, `makeCircleTrack(overrides?: Partial<Track>): Track`, `makeOvalTrack(overrides?: Partial<Track>): Track`, and `makeContext(track: Track, isLeader?: boolean): SimContext` [Task 4, because it needs `buildTrackQuery`] (`isLeader` defaults to `true`).

- Produces (later tasks and Task 16 rely on exactly these):
  - `export const FINISH_GRACE_TICKS = 1800` — ticks after `state.finishTick` at which the race is force-ended, 30 s at 60 Hz. Not in the locked contract; defined here because the contract names "a post-first-place timer" without a value.
  - `export function makeIntentBuffer(): Intent[]` — a new array of exactly `MAX_KARTS` distinct `Intent` objects, every field zeroed (`tick: 0, steer: 0, accel: 0, brake: false, drift: false, useItem: false`). Callers allocate one of these once and reuse it forever; nothing in the hot path allocates.
  - `export function resetBotHold(): void` — clears the module-level 30 Hz bot-intent hold. Must be called by any harness that starts or restarts a run (Task 16's `recordRun` / `replayRun` both call it).
  - `export function resolveInputs(ctx: SimContext, state: SimState, inputs: Intent[], out: Intent[]): void` — writes `MAX_KARTS` resolved intents into the caller-owned `out`. `inputs` and `out` are both indexed by **kart slot**, i.e. `inputs[i]` is the raw intent for `state.karts[i]`. Never allocates, never mutates `inputs`, never mutates `state`.
  - `export function updatePhase(ctx: SimContext, state: SimState, events: AuthEvent[]): void` — advances `state.phase`, sets `state.finishTick`, writes DNF karts into the free `state.finishedOrder` slots on a timeout, and emits `'finish'` events **only when `ctx.isLeader`**. Each per-kart DNF event carries `data ===` that kart's **1-based finishing place**, i.e. the number of filled `finishedOrder` slots *after* it was recorded — the same meaning `updateLaps` [Task 11] gives `data` on a real finish. The race-level finish event uses `playerId === -1`, `entityId === -1`, `item === 'none'`, and `data ===` the finisher count, which is always `MAX_KARTS` by the time the race ends because the DNF fill leaves no slot at `-1`.

**Behaviour this task locks in (read before writing code):**

1. `resolveInputs` is position 1 of the canonical per-kart order. Everything after it — `updateRecovery`, `updateDrift`, `stepKart`, `applyAirYaw`, `integrateVertical`, `applyRamps`, `decayBoost`, `updateLaps` — reads the **resolved** intent and never the raw `inputs` array.
2. While `state.phase === 'countdown'`, every kart's resolved intent is all-zero. Nobody, human or bot, moves before the lights go out.
3. A kart with `isBot === true` **or** `connected === false` is driven by `botIntent`. A dropped human is taken over by a bot mid-race, which is the design's stated failure behaviour, and it costs one boolean here.
4. Bots run at 30 Hz against a 60 Hz sim: `botIntent` is called only when `state.tick % 2 === 0`, and the odd tick of the pair reuses the even tick's value. The held value lives in a **module-level** buffer, not in `SimState` — `SimState` is locked and has no field for it. That is the one piece of simulation state outside `SimState`, and Task 16's checkpoint-replay parity invariant exists precisely because of it.
5. Human input is sanitised at this boundary: `steer` clamped to `[-1, 1]`, `accel` clamped to `[0, 1]`, non-finite values replaced with `0`, booleans compared with `=== true`. A `NaN` that reaches `stepKart` poisons a kart's position forever — `NaN` propagates through every subsequent multiply and never recovers, and there is no meaningful "clamp" of `NaN`, so it becomes `0`.
6. `updatePhase` runs **last** in the tick, after the kart loop and after `resolveKartCollisions → updateEntities → updateItemBoxes`. Consequence: the tick on which the countdown ends still ran with frozen input, and the first tick with live input is `COUNTDOWN_TICKS + 1`.
7. `finishedOrder` is a fixed-length, `-1`-padded array of `MAX_KARTS` slots. `updatePhase` writes a DNF kart into the **first slot holding `-1`** and derives every count by scanning those 8 slots. No `push`, no `indexOf`, no `.length` used as a finisher count. `updateLaps` [Task 11] fills it the same way for real finishers, and both give a `finish` event's `data` field the same meaning: a 1-based finishing place.

---

- [ ] **Step 1: Write the failing test — `resolveInputs`**

Create `packages/sim/test/phase.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { Intent, SimContext, SimState } from '../src/types'
import { COUNTDOWN_TICKS, MAX_KARTS } from '../src/types'
import { createState } from '../src/state'
import { botIntent } from '../src/bot'
import { makeIntentBuffer, resetBotHold, resolveInputs } from '../src/phase'
import { makeContext, makeStraightTrack } from './fixtures/track-fixtures'

const CHARS = [0, 1, 2, 3, 4, 5, 6, 7]

/** A state with all eight slots human-controlled and connected, phase forced. */
function humanState(ctx: SimContext, phase: SimState['phase'], tick: number): SimState {
  const s = createState(ctx, 0x0badc0de, CHARS)
  for (let i = 0; i < MAX_KARTS; i++) {
    s.karts[i].isBot = false
    s.karts[i].connected = true
  }
  s.phase = phase
  s.tick = tick
  return s
}

function intent(over: Partial<Intent>): Intent {
  return { tick: 0, steer: 0, accel: 0, brake: false, drift: false, useItem: false, ...over }
}

describe('resolveInputs', () => {
  it('freezes every input while the phase is countdown', () => {
    const ctx = makeContext(makeStraightTrack())
    const s = humanState(ctx, 'countdown', 42)
    const out = makeIntentBuffer()
    const inputs: Intent[] = []
    for (let i = 0; i < MAX_KARTS; i++) {
      inputs.push(intent({ tick: 41, steer: 0.7, accel: 1, brake: true, drift: true, useItem: true }))
    }

    resolveInputs(ctx, s, inputs, out)

    for (let i = 0; i < MAX_KARTS; i++) {
      expect(out[i].tick).toBe(42)      // stamped with the tick it is applied at
      expect(out[i].steer).toBe(0)
      expect(out[i].accel).toBe(0)
      expect(out[i].brake).toBe(false)
      expect(out[i].drift).toBe(false)
      expect(out[i].useItem).toBe(false)
    }
    // the raw inputs are the caller's; resolveInputs must not have touched them
    expect(inputs[0].steer).toBe(0.7)
    expect(inputs[0].drift).toBe(true)
  })

  it('freezes bots during countdown too', () => {
    const ctx = makeContext(makeStraightTrack())
    const s = humanState(ctx, 'countdown', COUNTDOWN_TICKS) // tick 180, still countdown
    s.karts[5].isBot = true
    const out = makeIntentBuffer()
    const inputs = makeIntentBuffer()

    resetBotHold()
    resolveInputs(ctx, s, inputs, out)

    expect(out[5].tick).toBe(180)
    expect(out[5].steer).toBe(0)
    expect(out[5].accel).toBe(0)
  })

  it('clamps and sanitises human input while racing', () => {
    const ctx = makeContext(makeStraightTrack())
    const s = humanState(ctx, 'racing', 200)
    const out = makeIntentBuffer()
    const inputs: Intent[] = [
      intent({ tick: 199, steer: 3.5, accel: 2.25, brake: true, drift: false, useItem: true }),
      intent({ tick: 199, steer: -4, accel: -0.5, brake: false, drift: true, useItem: false }),
      intent({ tick: 199, steer: Number.NaN, accel: Number.NaN }),
      intent({ tick: 199, steer: Number.POSITIVE_INFINITY, accel: Number.NEGATIVE_INFINITY }),
      intent({ tick: 199, steer: 0.25, accel: 0.75 }),
      intent({ tick: 199, steer: -0.5, accel: 0.5 }),
      // a hostile / sloppy client sending non-booleans
      intent({ tick: 199, brake: 1 as unknown as boolean, drift: 'yes' as unknown as boolean }),
      intent({ tick: 199, steer: -1, accel: 1, brake: true, drift: true, useItem: true }),
    ]

    resolveInputs(ctx, s, inputs, out)

    expect(out[0].steer).toBe(1)        // clamp(3.5, -1, 1)
    expect(out[0].accel).toBe(1)        // clamp(2.25, 0, 1)
    expect(out[0].tick).toBe(200)       // restamped from state.tick, not the client's 199
    expect(out[0].brake).toBe(true)
    expect(out[0].useItem).toBe(true)

    expect(out[1].steer).toBe(-1)       // clamp(-4, -1, 1)
    expect(out[1].accel).toBe(0)        // clamp(-0.5, 0, 1)
    expect(out[1].drift).toBe(true)

    expect(out[2].steer).toBe(0)        // NaN is not clampable; it becomes 0
    expect(out[2].accel).toBe(0)
    expect(Number.isNaN(out[2].steer)).toBe(false)

    expect(out[3].steer).toBe(0)        // +Infinity is non-finite -> 0
    expect(out[3].accel).toBe(0)        // -Infinity is non-finite -> 0

    expect(out[4].steer).toBe(0.25)     // in range, passed through exactly (0.25 = 2^-2)
    expect(out[4].accel).toBe(0.75)     // 0.75 = 3 * 2^-2, exact in binary64
    expect(out[5].steer).toBe(-0.5)
    expect(out[5].accel).toBe(0.5)

    expect(out[6].brake).toBe(false)    // 1 !== true
    expect(out[6].drift).toBe(false)    // 'yes' !== true

    expect(out[7].steer).toBe(-1)
    expect(out[7].accel).toBe(1)
  })

  it('freezes a slot whose raw input is missing', () => {
    const ctx = makeContext(makeStraightTrack())
    const s = humanState(ctx, 'racing', 77)
    const out = makeIntentBuffer()
    // pre-dirty the buffer so a no-op implementation cannot pass by accident
    for (let i = 0; i < MAX_KARTS; i++) {
      out[i].steer = 0.9
      out[i].accel = 0.9
      out[i].drift = true
    }

    resolveInputs(ctx, s, [], out)

    for (let i = 0; i < MAX_KARTS; i++) {
      expect(out[i].tick).toBe(77)
      expect(out[i].steer).toBe(0)
      expect(out[i].accel).toBe(0)
      expect(out[i].drift).toBe(false)
    }
  })

  it('fills bot and disconnected slots from botIntent and ignores their raw input', () => {
    const ctx = makeContext(makeStraightTrack())
    const s = humanState(ctx, 'racing', 200) // 200 % 2 === 0 -> fresh bot compute
    s.karts[3].isBot = true
    s.karts[4].isBot = false
    s.karts[4].connected = false

    const expected3 = botIntent(ctx, s, s.karts[3].playerId)
    const expected4 = botIntent(ctx, s, s.karts[4].playerId)
    const cursorBefore = s.rngCursor

    const out = makeIntentBuffer()
    const inputs: Intent[] = []
    for (let i = 0; i < MAX_KARTS; i++) {
      inputs.push(intent({ tick: 199, steer: 0.9, accel: 0.1, useItem: true }))
    }

    resetBotHold()
    resolveInputs(ctx, s, inputs, out)

    // bot slot: botIntent wins, raw input discarded
    expect(Object.is(out[3].steer, expected3.steer)).toBe(true)
    expect(Object.is(out[3].accel, expected3.accel)).toBe(true)
    expect(out[3].brake).toBe(expected3.brake)
    expect(out[3].drift).toBe(expected3.drift)
    expect(out[3].useItem).toBe(expected3.useItem)
    expect(out[3].tick).toBe(200)
    expect(out[3].steer).not.toBe(0.9)

    // disconnected human: also bot-driven
    expect(Object.is(out[4].steer, expected4.steer)).toBe(true)
    expect(Object.is(out[4].accel, expected4.accel)).toBe(true)
    expect(out[4].tick).toBe(200)

    // connected human next door is untouched by any of that
    expect(out[5].steer).toBe(0.9)
    expect(out[5].accel).toBe(0.1)

    // resolving input is not an authority action: it must not consume PRNG draws
    expect(s.rngCursor).toBe(cursorBefore)
  })

  it('holds bot intents across a tick pair so bots run at 30Hz', () => {
    const ctx = makeContext(makeStraightTrack())
    const s = humanState(ctx, 'racing', 200)
    s.karts[0].isBot = true
    const out = makeIntentBuffer()
    const inputs = makeIntentBuffer()

    resetBotHold()

    // even tick 200: fresh compute
    resolveInputs(ctx, s, inputs, out)
    const first = { steer: out[0].steer, accel: out[0].accel, drift: out[0].drift }
    expect(Object.is(first.steer, botIntent(ctx, s, 0).steer)).toBe(true)
    expect(out[0].tick).toBe(200)

    // move the kart 6 m off the centreline and advance to the ODD tick of the pair.
    // makeStraightTrack runs along +X, so +z is 6 m of lateral displacement.
    s.karts[0].position.z += 6
    s.tick = 201

    resolveInputs(ctx, s, inputs, out)
    expect(Object.is(out[0].steer, first.steer)).toBe(true)   // reused, not recomputed
    expect(Object.is(out[0].accel, first.accel)).toBe(true)
    expect(out[0].drift).toBe(first.drift)
    expect(out[0].tick).toBe(201)                             // but restamped

    // Proof the hold is doing work: a fresh compute from the displaced state differs.
    // If this assertion ever fails, the displacement above is too small for this
    // fixture — raise the 6 m. The load-bearing assertion is the Object.is one above.
    const fresh201 = botIntent(ctx, s, 0)
    expect(fresh201.steer === first.steer && fresh201.accel === first.accel).toBe(false)

    // next even tick 202: recompute from the displaced state
    s.tick = 202
    resolveInputs(ctx, s, inputs, out)
    const fresh202 = botIntent(ctx, s, 0)
    expect(Object.is(out[0].steer, fresh202.steer)).toBe(true)
    expect(Object.is(out[0].steer, first.steer)).toBe(false)
    expect(out[0].tick).toBe(202)
  })

  it('computes a fresh bot intent when the pair starts cold on an odd tick', () => {
    const ctx = makeContext(makeStraightTrack())
    const s = humanState(ctx, 'racing', 301) // odd, and the hold is empty
    s.karts[0].isBot = true
    const out = makeIntentBuffer()

    resetBotHold()
    resolveInputs(ctx, s, makeIntentBuffer(), out)

    const fresh = botIntent(ctx, s, 0)
    expect(Object.is(out[0].steer, fresh.steer)).toBe(true)
    expect(Object.is(out[0].accel, fresh.accel)).toBe(true)
    expect(out[0].tick).toBe(301)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/sim/test/phase.test.ts`

Expected: FAIL with `Error: Failed to resolve import "../src/phase" from "packages/sim/test/phase.test.ts". Does the file exist?`

- [ ] **Step 3: Write minimal implementation — `resolveInputs`**

Create `packages/sim/src/phase.ts`:

```ts
import type { Intent, SimContext, SimState } from './types'
import { MAX_KARTS } from './types'
import { clamp } from './mathutil'
import { botIntent } from './bot'

/**
 * Ticks after `state.finishTick` at which the race force-ends and every kart
 * still driving is recorded as a DNF, in placement order. 1800 ticks = 30 s at
 * 60 Hz. Not part of the locked contract; the contract names the timer but not
 * its length, so it is defined here and this module owns it.
 */
export const FINISH_GRACE_TICKS = 1800

/**
 * A reusable, caller-owned intent buffer of exactly MAX_KARTS slots. Allocate
 * one per loop, never per tick: `step()` must not allocate in the hot path.
 */
export function makeIntentBuffer(): Intent[] {
  const out: Intent[] = []
  for (let i = 0; i < MAX_KARTS; i++) {
    out.push({ tick: 0, steer: 0, accel: 0, brake: false, drift: false, useItem: false })
  }
  return out
}

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
  o.tick = tick
  o.steer = 0
  o.accel = 0
  o.brake = false
  o.drift = false
  o.useItem = false
}

function copyIntent(src: Intent, dst: Intent, tick: number): void {
  dst.tick = tick
  dst.steer = src.steer
  dst.accel = src.accel
  dst.brake = src.brake
  dst.drift = src.drift
  dst.useItem = src.useItem
}

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

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/sim/test/phase.test.ts`

Expected: PASS — 7 tests in the `resolveInputs` describe block.

- [ ] **Step 5: Write the failing test — `updatePhase`**

Append to `packages/sim/test/phase.test.ts`. Also extend the existing import lines at the top of the file:

Replace this line:

```ts
import { makeIntentBuffer, resetBotHold, resolveInputs } from '../src/phase'
```

with:

```ts
import type { AuthEvent } from '../src/types'
import { FINISH_GRACE_TICKS, makeIntentBuffer, resetBotHold, resolveInputs, updatePhase } from '../src/phase'
```

Then append this describe block to the end of the file:

```ts
describe('updatePhase', () => {
  /**
   * finishedOrder is fixed length MAX_KARTS with -1 in every unused slot, so a
   * test that wants "only kart 2 has finished" must hand updatePhase the padded
   * form. `order(2)` is `[2, -1, -1, -1, -1, -1, -1, -1]`.
   */
  function order(...ids: number[]): number[] {
    const a: number[] = []
    for (let i = 0; i < MAX_KARTS; i++) a.push(i < ids.length ? ids[i] : -1)
    return a
  }

  it('flips countdown to racing at COUNTDOWN_TICKS and emits nothing', () => {
    const ctx = makeContext(makeStraightTrack())
    const events: AuthEvent[] = []

    const early = humanState(ctx, 'countdown', COUNTDOWN_TICKS - 1) // 179
    updatePhase(ctx, early, events)
    expect(early.phase).toBe('countdown')
    expect(events.length).toBe(0)

    const on = humanState(ctx, 'countdown', COUNTDOWN_TICKS)        // 180
    updatePhase(ctx, on, events)
    expect(on.phase).toBe('racing')
    expect(events.length).toBe(0)     // there is no AuthEventKind for "go"

    const late = humanState(ctx, 'countdown', COUNTDOWN_TICKS + 40) // 220
    updatePhase(ctx, late, events)
    expect(late.phase).toBe('racing')
  })

  it('never advances a countdown straight to finished', () => {
    const ctx = makeContext(makeStraightTrack())
    const s = humanState(ctx, 'countdown', COUNTDOWN_TICKS)
    s.finishedOrder = order(0, 1, 2, 3, 4, 5, 6, 7)   // all 8 slots filled
    s.finishTick = 10
    const events: AuthEvent[] = []

    updatePhase(ctx, s, events)

    expect(s.phase).toBe('racing')    // one transition per tick, countdown first
    expect(events.length).toBe(0)
  })

  it('sets finishTick on the tick the first kart appears in finishedOrder', () => {
    const ctx = makeContext(makeStraightTrack())
    const events: AuthEvent[] = []

    const s = humanState(ctx, 'racing', 1234)
    expect(s.finishTick).toBe(-1)     // createState leaves it at -1
    expect(s.finishedOrder).toEqual(order())   // createState leaves all 8 slots at -1
    s.finishedOrder = order(3)

    updatePhase(ctx, s, events)

    expect(s.finishTick).toBe(1234)
    expect(s.phase).toBe('racing')    // 1234 - 1234 = 0 < FINISH_GRACE_TICKS
    expect(events.length).toBe(0)

    // idempotent: a finishTick already set by updateLaps is never overwritten
    const t = humanState(ctx, 'racing', 1234)
    t.finishTick = 1000
    t.finishedOrder = order(3)
    updatePhase(ctx, t, events)
    expect(t.finishTick).toBe(1000)
  })

  it('finishes when every kart is in finishedOrder', () => {
    const ctx = makeContext(makeStraightTrack())
    const s = humanState(ctx, 'racing', 5000)
    s.finishTick = 4000
    s.finishedOrder = order(4, 1, 0, 7, 2, 6, 3, 5) // all 8 slots filled, no -1 left
    const seqBefore = s.nextEventSeq
    const events: AuthEvent[] = []

    updatePhase(ctx, s, events)

    expect(s.phase).toBe('finished')
    expect(s.finishedOrder).toEqual([4, 1, 0, 7, 2, 6, 3, 5]) // unchanged, nobody DNF'd
    expect(events.length).toBe(1)
    expect(events[0].kind).toBe('finish')
    expect(events[0].playerId).toBe(-1)   // -1 = the race itself, not a kart
    expect(events[0].entityId).toBe(-1)
    expect(events[0].item).toBe('none')
    expect(events[0].data).toBe(8)        // 8 filled slots = 8 finishers
    expect(events[0].tick).toBe(5000)
    expect(events[0].eventSeq).toBe(seqBefore)
    expect(s.nextEventSeq).toBe(seqBefore + 1)

    // running again on a finished race is a no-op
    updatePhase(ctx, s, events)
    expect(events.length).toBe(1)
    expect(s.nextEventSeq).toBe(seqBefore + 1)
  })

  it('holds the race open until the grace timer expires', () => {
    const ctx = makeContext(makeStraightTrack())
    const events: AuthEvent[] = []

    expect(FINISH_GRACE_TICKS).toBe(1800)  // 30 s at 60 Hz

    // finishTick 3000, so the race ends on tick 3000 + 1800 = 4800
    const nearly = humanState(ctx, 'racing', 4799)
    nearly.finishTick = 3000
    nearly.finishedOrder = order(2)
    updatePhase(ctx, nearly, events)
    expect(nearly.phase).toBe('racing')    // 4799 - 3000 = 1799 < 1800
    expect(events.length).toBe(0)
  })

  it('finishes on the grace timer and fills DNF karts in placement order', () => {
    const ctx = makeContext(makeStraightTrack())
    const s = humanState(ctx, 'racing', 4800)
    s.finishTick = 3000                    // 4800 - 3000 = 1800 >= FINISH_GRACE_TICKS
    s.finishedOrder = order(2)             // [2, -1, -1, -1, -1, -1, -1, -1]
    // Give every kart a distinct, descending checkpoint index so placement is
    // unambiguous: kart i sits at checkpointIdx 7 - i, all on lap 0, all t 0.
    // Placement best-first is therefore [0,1,2,3,4,5,6,7]; kart 2 already holds
    // slot 0, so the DNF fill writes 0,1,3,4,5,6,7 into slots 1..7 in that order.
    for (let i = 0; i < MAX_KARTS; i++) {
      s.karts[i].lap.lap = 0
      s.karts[i].lap.checkpointIdx = 7 - i
      s.karts[i].lap.t = 0
    }
    const seqBefore = s.nextEventSeq
    const events: AuthEvent[] = []

    updatePhase(ctx, s, events)

    expect(s.phase).toBe('finished')
    expect(s.finishedOrder).toEqual([2, 0, 1, 3, 4, 5, 6, 7])
    expect(s.finishedOrder.length).toBe(8)

    // 7 per-kart DNF finish events, then 1 race-level event
    expect(events.length).toBe(8)
    expect(events.map((e) => e.playerId)).toEqual([0, 1, 3, 4, 5, 6, 7, -1])
    // `data` on a per-kart finish is the 1-based finishing place, exactly as
    // updateLaps [Task 11] emits it: the number of filled finishedOrder slots
    // AFTER that kart was recorded. Kart 2 already held place 1, so the seven
    // DNF karts take places 2..8:
    //   0 -> 2 filled -> 2      4 -> 5 filled -> 5
    //   1 -> 3 filled -> 3      5 -> 6 filled -> 6
    //   3 -> 4 filled -> 4      6 -> 7 filled -> 7
    //                           7 -> 8 filled -> 8
    // The trailing 8 is the race-level event, which carries the finisher count
    // (8, because the fill leaves no slot at -1).
    expect(events.map((e) => e.data)).toEqual([2, 3, 4, 5, 6, 7, 8, 8])
    for (let i = 0; i < 8; i++) {
      expect(events[i].kind).toBe('finish')
      expect(events[i].tick).toBe(4800)
      expect(events[i].entityId).toBe(-1)
      expect(events[i].item).toBe('none')
      expect(events[i].eventSeq).toBe(seqBefore + i)   // strictly monotonic, no gaps
    }
    expect(s.nextEventSeq).toBe(seqBefore + 8)
  })

  it('transitions on a non-leader but emits nothing and burns no eventSeq', () => {
    const ctx = makeContext(makeStraightTrack(), false)  // isLeader = false
    expect(ctx.isLeader).toBe(false)
    const s = humanState(ctx, 'racing', 5000)
    s.finishTick = 4000
    s.finishedOrder = order(4, 1, 0, 7, 2, 6, 3, 5)
    const seqBefore = s.nextEventSeq
    const events: AuthEvent[] = []

    updatePhase(ctx, s, events)

    expect(s.phase).toBe('finished')      // the transition is deterministic everywhere
    expect(events.length).toBe(0)         // but only the authority numbers events
    expect(s.nextEventSeq).toBe(seqBefore)
  })

  it('fills DNF karts on a non-leader too, so finishedOrder stays in sync', () => {
    const ctx = makeContext(makeStraightTrack(), false)
    const s = humanState(ctx, 'racing', 4800)
    s.finishTick = 3000
    s.finishedOrder = order(2)
    for (let i = 0; i < MAX_KARTS; i++) {
      s.karts[i].lap.lap = 0
      s.karts[i].lap.checkpointIdx = 7 - i
      s.karts[i].lap.t = 0
    }
    const seqBefore = s.nextEventSeq
    const events: AuthEvent[] = []

    updatePhase(ctx, s, events)

    expect(s.finishedOrder).toEqual([2, 0, 1, 3, 4, 5, 6, 7])
    expect(events.length).toBe(0)
    expect(s.nextEventSeq).toBe(seqBefore)
  })
})
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run packages/sim/test/phase.test.ts -t "flips countdown to racing"`

Expected: FAIL. `tsc`/vitest reports `"updatePhase" is not exported by "packages/sim/src/phase.ts"`, or at runtime `TypeError: updatePhase is not a function`.

- [ ] **Step 7: Write minimal implementation — `updatePhase`**

Two edits to `packages/sim/src/phase.ts`.

First, replace the four import lines at the top of the file. Before:

```ts
import type { Intent, SimContext, SimState } from './types'
import { MAX_KARTS } from './types'
import { clamp } from './mathutil'
import { botIntent } from './bot'
```

After:

```ts
import type { AuthEvent, Intent, SimContext, SimState } from './types'
import { COUNTDOWN_TICKS, MAX_KARTS } from './types'
import { clamp } from './mathutil'
import { emit } from './state'
import { botIntent } from './bot'
import { placementOrder } from './placement'
```

Second, append this function to the end of the file:

```ts
/**
 * Last call of the tick, after the kart loop and after
 * resolveKartCollisions -> updateEntities -> updateItemBoxes.
 *
 * countdown -> racing:  on the first tick at or past COUNTDOWN_TICKS. Because
 *   this runs at the END of the tick, the tick that ends the countdown still ran
 *   with frozen input, and COUNTDOWN_TICKS + 1 is the first live tick.
 *
 * racing -> finished:  when every kart is in finishedOrder, or when
 *   FINISH_GRACE_TICKS have elapsed since finishTick. On a timeout the karts
 *   still driving are written into the free finishedOrder slots in placement
 *   order, so the results screen has a complete ranking and no kart is missing.
 *
 * finishedOrder is FIXED LENGTH MAX_KARTS with -1 in every unused slot (locked
 * contract §0). It is never pushed and never indexOf'd: growing it past 8 makes
 * the next cloneState throw, which would take recordRun/replayRun [Task 16] and
 * the golden run [Task 17] down with it. Every count below is a scan of the 8
 * slots for entries !== -1.
 *
 * The transition itself is deterministic and happens on every peer. Only
 * `ctx.isLeader` emits, because eventSeq is assigned by the current authority
 * and a client that emitted here would silently desync `state.nextEventSeq`.
 */
export function updatePhase(ctx: SimContext, state: SimState, events: AuthEvent[]): void {
  if (state.phase === 'countdown') {
    if (state.tick >= COUNTDOWN_TICKS) state.phase = 'racing'
    return
  }
  if (state.phase !== 'racing') return

  let finishers = 0
  for (let i = 0; i < MAX_KARTS; i++) {
    if (state.finishedOrder[i] !== -1) finishers++
  }

  // Defensive: updateLaps [Task 11] normally stamps finishTick on the tick it
  // records the first finisher. If it did, this guard is already false.
  if (state.finishTick < 0 && finishers > 0) {
    state.finishTick = state.tick
  }

  const allDone = finishers >= MAX_KARTS
  const graceUp =
    state.finishTick >= 0 && state.tick - state.finishTick >= FINISH_GRACE_TICKS
  if (!allDone && !graceUp) return

  if (!allDone) {
    const order = placementOrder(state)
    for (let n = 0; n < order.length; n++) {
      const pid = order[n]

      // Already recorded? Scan the 8 fixed slots. A playerId is never -1, so a
      // hit here is always a real finisher and never the padding.
      let seen = false
      for (let i = 0; i < MAX_KARTS; i++) {
        if (state.finishedOrder[i] === pid) {
          seen = true
          break
        }
      }
      if (seen) continue

      // Write into the first slot still holding -1. placementOrder returns all
      // MAX_KARTS playerIds and each is written at most once, so a free slot
      // always exists here. The guard exists so a malformed array stops the loop
      // instead of assigning to index -1, which would hang a stray '-1' property
      // off the array and desync cloneState/statesEqual.
      let slot = -1
      for (let i = 0; i < MAX_KARTS; i++) {
        if (state.finishedOrder[i] === -1) {
          slot = i
          break
        }
      }
      if (slot < 0) break

      state.finishedOrder[slot] = pid
      finishers++
      if (ctx.isLeader) {
        // 1-based finishing place, the same meaning updateLaps [Task 11] gives
        // `data`: the number of filled slots after this kart was recorded.
        emit(state, events, 'finish', pid, -1, 'none', finishers)
      }
    }
  }

  state.phase = 'finished'
  if (ctx.isLeader) {
    emit(state, events, 'finish', -1, -1, 'none', finishers)
  }
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npx vitest run packages/sim/test/phase.test.ts`

Expected: PASS — 15 tests (7 in `resolveInputs`, 8 in `updatePhase`).

- [ ] **Step 9: Write the failing test — `step()` wiring**

Append to `packages/sim/test/phase.test.ts`. Extend the import lines at the top of the file once more.

Replace:

```ts
import { createState } from '../src/state'
```

with:

```ts
import { createState } from '../src/state'
import { step } from '../src/step'
```

Then append:

```ts
describe('step() wiring', () => {
  it('runs resolveInputs at position 1 and updatePhase in the tail', () => {
    const ctx = makeContext(makeStraightTrack())
    let cur = createState(ctx, 7, [0, 0, 0, 0, 0, 0, 0, 0])
    let nxt = createState(ctx, 7, [0, 0, 0, 0, 0, 0, 0, 0])
    for (let i = 0; i < MAX_KARTS; i++) {
      cur.karts[i].isBot = false
      cur.karts[i].connected = true
    }
    cur.karts[7].isBot = true

    // Precondition on the fixture grid. If two karts start closer than one kart
    // diameter (2 * kartRadius = 2 * 0.9 = 1.8 m) then resolveKartCollisions
    // would push them apart during the countdown and the exact-zero assertions
    // below would be measuring collisions instead of the input freeze.
    for (let i = 0; i < MAX_KARTS; i++) {
      for (let j = i + 1; j < MAX_KARTS; j++) {
        const dx = cur.karts[i].position.x - cur.karts[j].position.x
        const dz = cur.karts[i].position.z - cur.karts[j].position.z
        expect(Math.sqrt(dx * dx + dz * dz)).toBeGreaterThan(2 * ctx.tuning.kartRadius)
      }
    }

    const startX0 = cur.karts[0].position.x
    const startZ0 = cur.karts[0].position.z
    const startX7 = cur.karts[7].position.x

    // Everyone mashes the throttle through the whole countdown.
    const inputs: Intent[] = []
    for (let i = 0; i < MAX_KARTS; i++) {
      inputs.push(intent({ tick: 0, steer: 0, accel: 1, brake: false, drift: true, useItem: true }))
    }
    const events: AuthEvent[] = []

    resetBotHold()
    expect(cur.tick).toBe(0)
    expect(cur.phase).toBe('countdown')

    for (let n = 0; n < COUNTDOWN_TICKS - 1; n++) {   // 179 ticks -> tick 179
      events.length = 0
      step(ctx, cur, nxt, inputs, events)
      const tmp = cur
      cur = nxt
      nxt = tmp
    }
    expect(cur.tick).toBe(179)
    expect(cur.phase).toBe('countdown')

    events.length = 0
    step(ctx, cur, nxt, inputs, events)          // the 180th step
    let tmp = cur
    cur = nxt
    nxt = tmp
    expect(cur.tick).toBe(180)
    expect(cur.phase).toBe('racing')             // updatePhase ran in the tail

    // 180 ticks of full throttle produced exactly nothing, because
    // resolveInputs zeroed every intent before stepKart ever saw one.
    expect(Object.is(cur.karts[0].velocity.x, 0)).toBe(true)
    expect(Object.is(cur.karts[0].velocity.z, 0)).toBe(true)
    expect(Object.is(cur.karts[0].position.x, startX0)).toBe(true)
    expect(Object.is(cur.karts[0].position.z, startZ0)).toBe(true)
    expect(cur.karts[0].drift.active).toBe(false)
    expect(cur.karts[0].drift.charge).toBe(0)
    // and the bot slot was frozen on exactly the same rule
    expect(Object.is(cur.karts[7].velocity.x, 0)).toBe(true)
    expect(Object.is(cur.karts[7].position.x, startX7)).toBe(true)

    // one more tick, now racing: the same input finally does something
    events.length = 0
    step(ctx, cur, nxt, inputs, events)
    tmp = cur
    cur = nxt
    nxt = tmp
    expect(cur.tick).toBe(181)
    expect(cur.phase).toBe('racing')
    expect(cur.karts[0].velocity.x).toBeGreaterThan(0)
    expect(Object.is(cur.karts[0].velocity.z, 0)).toBe(true)  // steer 0, heading 0, +X track
    expect(cur.karts[0].position.x).toBeGreaterThan(startX0)
  })
})
```

- [ ] **Step 10: Run test to verify it fails**

Run: `npx vitest run packages/sim/test/phase.test.ts -t "runs resolveInputs at position 1"`

Expected: FAIL at `expect(cur.phase).toBe('racing')` after the 180th step with `expected 'countdown' to be 'racing'` — `step()` does not call `updatePhase` yet, so nothing ever leaves the countdown. That is the first failing assertion, because it precedes the velocity checks in the test body. The assertions after it are failing too and will surface once Step 11 lands `updatePhase`: Task 6's stand-in fill loop copies each raw intent through verbatim, so all 180 countdown ticks ran at `accel: 1` and `Object.is(cur.karts[0].velocity.x, 0)` is `false`. Both halves of the test go green only when Step 11's Edit 4 has *replaced* that fill loop rather than run before it.

- [ ] **Step 11: Wire `phase.ts` into `step.ts`**

Five exact edits to `packages/sim/src/step.ts`. Nothing else in the file changes; leave the bodies of the per-kart calls exactly as Tasks 6–14 left them.

Read this before making them: `step.ts` **already has** a module-scope `resolvedInputs`
buffer and a module-scope `NEUTRAL_INTENT`, both written by Task 6 (Task 6 Step 15's
complete-file listing), and it already fills that buffer with a stand-in loop that copies
each raw intent straight through. This task does not *add* a buffer — it swaps Task 6's
initializer for `makeIntentBuffer()`, deletes the stand-in fill loop and `NEUTRAL_INTENT`
with it, and puts `resolveInputs` in the fill loop's exact place. Getting that placement
wrong is not cosmetic: if `resolveInputs` lands *before* the fill loop, the fill loop then
overwrites `resolvedInputs` with the raw client intents and the countdown freeze, bot fill
and 30 Hz hold are all silently discarded — which is exactly what Step 9's test checks.

**Edit 1 — add the import.** Add this line at the end of the existing import block:

```ts
import { makeIntentBuffer, resolveInputs, updatePhase } from './phase'
```

**Edit 2 — replace Task 6's stand-in buffer: delete `NEUTRAL_INTENT` and swap the
initializer for `makeIntentBuffer()`.** These two declarations are adjacent, in this order,
between the import block and the `step()` doc comment. Before:

```ts
/**
 * The intent used for a seat the caller supplied nothing for. Module-level so the
 * hot path allocates nothing; never mutated, and never handed to a kart directly —
 * it is copied into `resolvedInputs` like any other source intent.
 */
const NEUTRAL_INTENT: Intent = {
  tick: 0,
  steer: 0,
  accel: 0,
  brake: false,
  drift: false,
  useItem: false,
}

/**
 * The resolved intents the whole tick reads. `MAX_KARTS` distinct Intent objects,
 * allocated once at module load and rewritten in place every tick, because step()
 * must never allocate in the hot path. Indexed by kart slot.
 *
 * Task 15 replaces the fill loop below with
 * `resolveInputs(ctx, next, inputs, resolvedInputs)` and this initializer with
 * `makeIntentBuffer()`, which produces exactly this shape. The buffer, and the
 * `const raw = resolvedInputs[i]` line in the kart loop, exist from this task
 * onward so that Tasks 7, 8, 13 and 15 all edit against locals that are already
 * there.
 */
const resolvedInputs: Intent[] = Array.from({ length: MAX_KARTS }, () => ({
  tick: 0,
  steer: 0,
  accel: 0,
  brake: false,
  drift: false,
  useItem: false,
}))
```

After:

```ts
/**
 * The resolved intents the whole tick reads. Exactly `MAX_KARTS` distinct Intent
 * objects, allocated once at module load and rewritten in place every tick,
 * because step() must never allocate in the hot path. Indexed by kart slot.
 *
 * `makeIntentBuffer()` [Task 15] produces exactly the shape Task 6's `Array.from`
 * literal produced, so every reader of this buffer is unaffected by the swap.
 */
const resolvedInputs: Intent[] = makeIntentBuffer()
```

`NEUTRAL_INTENT` goes in the same edit rather than a later one because Edit 4 removes its
only reader, and `packages/sim/tsconfig.json` [Task 1] sets `"noUnusedLocals": true` — a
surviving `NEUTRAL_INTENT` fails Step 13's `tsc --noEmit` with
`TS6133: 'NEUTRAL_INTENT' is declared but its value is never read`. `Intent` stays imported
(it is in `step`'s own signature and in this declaration) and `MAX_KARTS` stays imported
(the per-kart loop still uses it), so neither import line changes.

**Edit 3 — retire the stand-in note in `step()`'s stage-order comment.** One line inside the
doc comment above `export function step`. Before:

```ts
 *   1. resolveInputs      [Task 15] <- this task's fill loop stands in for it
 *   2. updateRecovery     [Task 9]
```

After:

```ts
 *   1. resolveInputs      [Task 15] <- implemented
 *   2. updateRecovery     [Task 9]
```

**Edit 4 — delete Task 6's fill loop and put `resolveInputs` in its place.** The `before`
block below runs from `next.tick = prev.tick + 1` through the first three lines of the
per-kart loop; those three locals are quoted only to pin the insertion point and come back
byte-identical in the `after` block. Do not touch them, and do not touch anything after
them — `if (raw.useItem) useItem(ctx, next, k, events)` [Task 13] and every stage below it
stay exactly as Tasks 7–14 left them. Before:

```ts
  next.tick = prev.tick + 1

  // Canonical position 1, in its pre-Task-15 form: copy each supplied intent into
  // the resolved buffer, substituting NEUTRAL_INTENT for a seat the caller left
  // out. No phase gating, no bot fill, no 30Hz hold and no sanitisation yet — all
  // four arrive with Task 15, which replaces this whole loop with one call.
  for (let i = 0; i < MAX_KARTS; i++) {
    const supplied = inputs[i]
    const src = supplied === undefined ? NEUTRAL_INTENT : supplied
    const dst = resolvedInputs[i]
    dst.tick = src.tick
    dst.steer = src.steer
    dst.accel = src.accel
    dst.brake = src.brake
    dst.drift = src.drift
    dst.useItem = src.useItem
  }

  for (let i = 0; i < MAX_KARTS; i++) {
    const k = next.karts[i]
    const prevKart = prev.karts[i]
    const raw = resolvedInputs[i]
```

After:

```ts
  next.tick = prev.tick + 1

  // Canonical per-kart order, position 1: phase gating, bot fill, 30Hz hold and
  // sanitisation, all four at once — this call is what Task 6's stand-in fill loop
  // was standing in for, and it occupies exactly that loop's position. Every stage
  // below this line reads `resolvedInputs`, never the raw `inputs`.
  resolveInputs(ctx, next, inputs, resolvedInputs)

  for (let i = 0; i < MAX_KARTS; i++) {
    const k = next.karts[i]
    const prevKart = prev.karts[i]
    const raw = resolvedInputs[i]
```

`resolveInputs` reads `next.tick` and `next.phase`, which is why it sits after
`next.tick = prev.tick + 1`: the intent is stamped with the tick it is applied at, and
`next.phase` is still the phase `updatePhase` set at the end of the *previous* tick, so the
countdown freeze covers ticks 1…`COUNTDOWN_TICKS` inclusive.

**Edit 5 — run `updatePhase` last.** `updateItemBoxes` is the final statement of `step()` after Task 13, so this anchor is unique. Before:

```ts
  updateItemBoxes(ctx, next, events)
}
```

After:

```ts
  updateItemBoxes(ctx, next, events)
  updatePhase(ctx, next, events)
}
```

- [ ] **Step 12: Run test to verify it passes**

Run: `npx vitest run packages/sim/test/phase.test.ts`

Expected: PASS — 16 tests.

- [ ] **Step 13: Run the full sim suite and typecheck**

Run: `npx tsc --noEmit -p packages/sim && npx vitest run packages/sim`

Expected: PASS, zero type errors. Two things could have broken here and neither may be papered over:

- **Type errors.** Edit 2 deleted `NEUTRAL_INTENT`; if `tsc` reports `TS6133` for it, the deletion did not happen. If `tsc` reports `TS2451: Cannot redeclare block-scoped variable 'resolvedInputs'`, Edit 2 was applied as an *addition* instead of a replacement of Task 6's `Array.from(...)` initializer — go back and remove the Task 6 declaration.
- **Earlier tests.** The kart loop still reads `resolvedInputs[i]`, exactly as Tasks 6–14 wrote it; what changed is how that buffer is filled. Any test from Tasks 6–14 that fed live input while `phase === 'countdown'` now sees a frozen kart. If one fails for that reason, set `state.phase = 'racing'` in that test's setup; do not weaken `resolveInputs`.

- [ ] **Step 14: Commit**

```bash
git add packages/sim/src/phase.ts packages/sim/src/step.ts packages/sim/test/phase.test.ts
git commit -m "feat(sim): race phase transitions and per-tick input resolution

resolveInputs freezes all input during the countdown, drives bot and
disconnected slots from botIntent held across tick pairs so bots run at
30Hz against the 60Hz sim, and clamps/sanitises human input at the
authority boundary. updatePhase ends the countdown at COUNTDOWN_TICKS
and ends the race when every kart has finished or FINISH_GRACE_TICKS
have elapsed since finishTick, filling DNF karts in placement order and
emitting only on the leader. Wired at position 1 and in the tail of
step()."
```
