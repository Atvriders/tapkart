### Task 16: `packages/net/src/shadow.ts` — `ShadowLoop`

**Files:**
- Create: `packages/net/src/shadow.ts`
- Test: `packages/net/test/shadow.test.ts`

**Why this class exists.** Spec §5, "The server is a shadow authority": *"The server does not
sit passively holding snapshots — review established that a passive server cannot reconstruct a
valid state at all (no PRNG cursor, no entity state, no input buffers, no event sequence)."*
`ShadowLoop` is the server's per-room simulation that runs continuously in lockstep with the host
so that, when the host disappears, the room's state already exists and needs no reconstruction —
only a mode switch.

**Facts this task rests on that belong to other files — verified by opening them, not assumed:**

1. **A follower emits nothing.** Opened `packages/sim/src/items.ts` and `packages/sim/src/phase.ts`
   directly. `items.ts`'s `rollItem` returns `'none'` immediately when `!ctx.isLeader`, leaving
   `state.rngCursor` untouched; `updateItemBoxes`'s roll-and-`emit('itemGrant', …)` block is itself
   inside `if (ctx.isLeader) { … }`. `phase.ts`'s `updatePhase` has two `emit('finish', …)` call
   sites, both already inside `if (ctx.isLeader) { … }`. So on `ctx.isLeader === false`, both files
   already emit nothing and roll nothing, confirming the locked contract §1b's count of "3 of 11
   [call sites] already gated" (these three) against the other 8 (in `recovery.ts`, `laps.ts`,
   `entity.ts`) that Plan 2 Task 2 gates. By the time this task runs, Task 2 has gated all eleven,
   so `step(ctx, …)` called with `ctx.isLeader === false` is guaranteed to leave its `events`
   out-array empty and `state.rngCursor` unchanged, for every kart, every tick. `ShadowLoop` in
   follower mode relies on exactly this: it never has to suppress or filter anything `step()`
   produces, because `step()` produces nothing to suppress.
2. **`step()` never mutates `prev` and always fully overwrites `next` via `cloneState` at its own
   top line** (`packages/sim/src/step.ts`, opened directly: `cloneState(prev, next); next.tick =
   prev.tick + 1` is the first thing the function does). This is what makes double-buffering safe:
   any preallocated `SimState` can be reused as a `next` target on a later call without first being
   reset by the caller.
3. **A follower's `nextEventSeq` is advanced only by applying received events** — locked contract
   §0's conventions table, restated here because it is the reason "continue `eventSeq` from the
   highest observed" (spec §5) requires no code in this file: once `ctx.isLeader` flips to `true`
   at promotion, the very next `emit()` call inside `step()` uses `state.nextEventSeq++`, and
   `state.nextEventSeq` already equals one past the highest `eventSeq` this shadow has applied.
   Promotion therefore needs to change `ctx.isLeader` and nothing else for this particular
   guarantee.

**Interfaces:**

Consumes (exact signatures — locked contract, already shipped by the time this task runs):

```ts
// packages/sim (barrel, @tapkart/sim — Plan 1, fully shipped)
export const TICK_HZ = 60
export const MAX_KARTS = 8
export const MAX_ENTITIES = 32
export type Intent = { tick: number; steer: number; accel: number; brake: boolean; drift: boolean; useItem: boolean }
export interface AuthEvent { eventSeq: number; tick: number; kind: AuthEventKind; playerId: number; entityId: number; item: ItemKind; data: number }
export interface SimContext { track: Track; query: TrackQuery; tuning: Tuning; characters: CharacterStats[]; isLeader: boolean }
export interface SimState { /* … locked; includes heldBotIntent/heldBotTick after Plan 2 Task 1 */ }
export function createState(ctx: SimContext, seed: number, characterIdx: number[]): SimState
export function cloneState(src: SimState, dst: SimState): void
export function step(ctx: SimContext, prev: SimState, next: SimState, inputs: Intent[], events: AuthEvent[]): void
export function makeIntentBuffer(): Intent[]
export function allocStateLike(ctx: SimContext, src: SimState): SimState
export function wrapAngle(a: number): number   // -> (-PI, PI]

// packages/net/src/transport.ts                               [Task 11]
export interface Transport {
  send(channel: ChannelName, peerId: string, data: Uint8Array): void
  broadcast(channel: ChannelName, data: Uint8Array): void
  onMessage(cb: (peerId: string, channel: ChannelName, data: Uint8Array) => void): void
  onPeerLost(cb: (peerId: string) => void): void
  peers(): string[]
  close(): void
}

// packages/net/src/apply.ts                                   [Task 13]
export function applyEvent(ctx: SimContext, state: SimState, ev: AuthEvent): boolean  // false if already applied

// packages/net/test/fixtures/net-fixtures.ts                  [Task 12]
export function makeNetContext(isLeader?: boolean): SimContext
export function makeLossyPair(overrides?: Partial<LoopbackOptions>): ReturnType<typeof makeLoopbackPair>
// Default LoopbackOptions: { latencyMs: 150, jitterMs: 50, lossRate: 0.05, seed: 0xC0FFEE }
```

Protocol pieces this file needs (Tasks 3, 5, 6, 9, 10 — all land before Task 16 in the task
sequence, so the files exist, but **`packages/protocol`'s own barrel is Task 18** — the same task
number as this plan's other barrel task, and it ships dead last. `packages/net`'s tasks 11–17
therefore cannot `import … from '@tapkart/protocol'`; every cross-package import in this file (and
in Task 17's) goes by relative path into `../../protocol/src/<module>`, exactly as it will resolve
on disk. This is stated once here because getting it wrong produces a Vite/Vitest "does not provide
an export named …" failure that looks identical to a real missing export):

```ts
// ../../protocol/src/types.ts
export type ChannelName = 'unreliable' | 'reliable'
export interface WireKart { playerId: number; position: Vec3; velocity: Vec3; heading: number;
  angularVelocity: number; driftCharge: number; driftActive: boolean; driftDir: -1 | 0 | 1;
  airborne: boolean; surface: Surface; spinOutTicks: number; invulnTicks: number; item: ItemKind;
  lap: number; checkpointIdx: number; t: number; isBot: boolean; connected: boolean;
  boostTicks: number; respawnTicks: number; shielded: boolean }
export interface WireEntity { entityId: number; kind: EntityKind; ownerId: number; position: Vec3;
  velocity: Vec3; heading: number; ttl: number }
export interface WireSnapshot { tick: number; eventSeq: number; lastProcessedInputTick: number[];
  karts: WireKart[]; entities: WireEntity[]; entityCount: number }
export interface InputDatagram { playerId: number; intents: Intent[] }

// ../../protocol/src/quant.ts
export const EPS: EpsilonTable   // frozen; Task 7 proves epsilon > step for every field

// ../../protocol/src/snapshot.ts
export function decodeSnapshot(buf: Uint8Array, out: WireSnapshot): void
export function applySnapshotToState(snap: WireSnapshot, dst: SimState): void
export function encodeSnapshot(out: Uint8Array, state: SimState, lastProcessedInputTick: number[]): number

// ../../protocol/src/events.ts
export function decodeEvents(buf: Uint8Array, out: AuthEvent[]): void
export function encodeEvents(out: Uint8Array, events: AuthEvent[]): number

// ../../protocol/src/input.ts
export const INPUT_REDUNDANCY = 8
export function decodeInput(buf: Uint8Array, out: InputDatagram): void
```

**Assumption this task states rather than silently makes, because the file that would settle it
does not exist yet:** `EPS`'s exact property names are fixed by Task 5, not by this task or the
locked contract (the contract only guarantees `EPS: EpsilonTable` exists and is frozen). This file
accesses `EPS.position`, `EPS.velocity`, `EPS.heading`, `EPS.angularVelocity`, `EPS.driftCharge`,
`EPS.lapT` — the natural names for contract §4's six continuous fields, and the same names Plan 1's
`GoldenTolerance` (`packages/sim/test/fixtures/golden-format.ts`) already uses for the identical six
quantities. If Task 5 ships different property names, Step 11 below fails to compile with
`TS2339: Property 'position' does not exist on type 'EpsilonTable'` naming the mismatch exactly,
and the fix is to rename these six accessors to match — not to change `quant.ts`.

**Wire format this task defines because no other task does.** The locked contract's `MessageKind`
union (`packages/protocol/src/types.ts`, Task 3) lists `'authorityChange'` as a message kind, but no
task in §3's module map encodes or decodes one, and no task anywhere defines how a receiver tells an
`'input'` buffer apart from a `'snapshot'` or `'events'` buffer on the same `onMessage` callback (the
`WireHeader` interface exists as a *type* in Task 3 but is never assigned an encoder). This is a
real gap in the locked contract, not an oversight in this brief: per the contract's own header rule
("a task needing something absent must define it in its own files and say so"), this file defines a
one-byte tag convention it needs and uses consistently for the messages it originates and receives:

```ts
export const WIRE_TAG_INPUT = 4            // MessageKind union order: hello0 welcome1 lobby2
export const WIRE_TAG_SNAPSHOT = 5         // start3 input4 snapshot5 events6 checkpoint7
export const WIRE_TAG_EVENTS = 6           // authorityChange8 ping9 pong10
export const WIRE_TAG_CHECKPOINT = 7
export const WIRE_TAG_AUTHORITY_CHANGE = 8
```

Every buffer this file sends is `[tag: u8, …payload]`; every buffer it reads dispatches on
`data[0]`. **Whoever writes Tasks 11, 14 and 15 must use this same tag byte in the same position**,
or a promoted `ShadowLoop`'s broadcasts are unreadable by `ClientLoop` and a host's `AuthorityLoop`
broadcasts are unreadable by this file. This is flagged in the final report to the plan's author for
that reason.

Produces:

```ts
// packages/net/src/shadow.ts
export const HOST_TIMEOUT_TICKS = 90        // 1.5s @ 60Hz = 30 missed snapshots x 3 ticks/snapshot
export const SNAPSHOT_PERIOD_TICKS = 3      // TICK_HZ (60) / snapshot rate (20Hz)
export const SHADOW_HISTORY_TICKS = 24      // >= 2x the 200ms worst-case one-way transit (150ms
                                             // latency + 50ms jitter = 200ms = 12 ticks @ 60Hz)
export const AUTHORITY_CHANGE_BYTES = 10    // tag u8 + protocolVersion u8 + tick u32LE + eventSeq u32LE
export function encodeAuthorityChange(out: Uint8Array, tick: number, eventSeq: number): number
export function decodeAuthorityChange(buf: Uint8Array): { tick: number; eventSeq: number }
export class ShadowLoop {
  constructor(ctx: SimContext, state: SimState, t: Transport)
  tick(): void
  promote(tick: number): void
}
```

**Design decisions this file makes, stated up front so the steps below aren't a surprise:**

- **`state` (the constructor argument) is the caller's window onto this loop, published once per
  `tick()` call.** `ShadowLoop` cannot run `step()` directly against a single shared object (`step`
  needs distinct `prev`/`next` buffers), so it allocates its own working pair (`live`, `scratch`) at
  construction via `allocStateLike(ctx, state)`, and at the end of every `tick()` call does
  `cloneState(this.live, state)` — a value copy into the caller's own object, never a reference
  swap. The caller always reads `state` after calling `tick()`; there is no getter, matching
  `AuthorityLoop`'s and the caller-owned-`state` pattern in its own locked signature.
- **Every incoming message is decoded and queued in `onMessage`; every state mutation happens inside
  `tick()`.** No message handler mutates `live`/`scratch` directly. This makes `tick()` the single,
  deterministic entry point a test can call N times and assert against — an `onMessage` callback
  firing between two `tick()` calls (as it will over a real transport) cannot produce a different
  result than the same bytes delivered just before the next `tick()` call, which is exactly what
  `LoopbackTransport`'s `pump()` does in every test.
- **The correction mechanism is the same shape as a client's reconciliation, generalised.** Spec
  §5: *"It uses the host's `WireSnapshot` stream as a periodic correction, exactly as a client does
  for its own kart, but across all karts and entities."* A client keeps a ring buffer of
  `(tick, input, checkpoint)` for its own kart and, on divergence, resets to the authoritative value
  and replays buffered input forward. This file keeps the same shape — a ring buffer of
  `(tick, inputs used, events applied, resulting state)` — sized for *every* kart and entity, not
  one, because unlike a client the shadow actually runs `step()` for the whole world. The trigger is
  therefore evaluated once per snapshot (does *any* field of *any* kart or entity exceed its
  epsilon against the buffered same-tick state?) rather than once per kart.
- **This rewind-and-replay is never visible to a player.** Nobody renders the shadow's `state` while
  it is a follower; only the promoted shadow's broadcasts are ever shown to anyone, and those come
  from `live` *after* the correction has already settled. The "no rewind" guarantee in spec §5 is
  about promotion — no player-visible teleport, lap regression, or vanished projectile at the moment
  authority changes — and is unrelated to this internal, unobserved bookkeeping. Do not conflate the
  two: a test asserting "the shadow's `state` object never changes a already-published field between
  two `tick()` calls" would be asserting something the spec never promised and this file does not
  provide.
- **`ShadowLoop` does not depend on `AuthorityLoop`'s internals.** Once promoted, this file's own
  `tick()` broadcasts snapshots (at 20Hz, i.e. every `SNAPSHOT_PERIOD_TICKS` ticks) and events (when
  `step()` produced any) directly, using only the locked-contract `encodeSnapshot`/`encodeEvents`
  functions. `AuthorityLoop`'s file does not exist yet when this task is written, and delegating to
  it would make this file's correctness depend on an unverifiable assumption about code nobody has
  written. The two files will duplicate a small amount of logic (encode-and-broadcast-at-20Hz); that
  duplication is the price of this file being provably correct on its own.

---

- [ ] **Step 1: Write the failing test for the wire envelope**

Create `packages/net/test/shadow.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import {
  AUTHORITY_CHANGE_BYTES,
  HOST_TIMEOUT_TICKS,
  SHADOW_HISTORY_TICKS,
  SNAPSHOT_PERIOD_TICKS,
  WIRE_TAG_AUTHORITY_CHANGE,
  WIRE_TAG_CHECKPOINT,
  WIRE_TAG_EVENTS,
  WIRE_TAG_INPUT,
  WIRE_TAG_SNAPSHOT,
  decodeAuthorityChange,
  encodeAuthorityChange,
} from '../src/shadow'

describe('shadow constants', () => {
  it('pins the promotion timeout to 1.5s at 60Hz', () => {
    expect(HOST_TIMEOUT_TICKS).toBe(90) // 30 missed snapshots x 3 ticks/snapshot (spec S5)
  })

  it('pins the snapshot broadcast period to 20Hz', () => {
    expect(SNAPSHOT_PERIOD_TICKS).toBe(3) // 60 / 20
  })

  it('sizes the history ring at 2x the 200ms worst-case one-way transit', () => {
    expect(SHADOW_HISTORY_TICKS).toBe(24) // 400ms @ 60Hz, vs. 150ms latency + 50ms jitter = 200ms = 12 ticks
  })

  it('gives every wire tag a distinct byte matching MessageKind order', () => {
    const tags = [WIRE_TAG_INPUT, WIRE_TAG_SNAPSHOT, WIRE_TAG_EVENTS, WIRE_TAG_CHECKPOINT, WIRE_TAG_AUTHORITY_CHANGE]
    expect(tags).toEqual([4, 5, 6, 7, 8])
    expect(new Set(tags).size).toBe(5)
  })
})

describe('authorityChange codec', () => {
  it('round-trips tick and eventSeq through exactly 10 bytes', () => {
    const buf = new Uint8Array(AUTHORITY_CHANGE_BYTES)
    const n = encodeAuthorityChange(buf, 123456, 789)
    expect(n).toBe(10)
    expect(buf[0]).toBe(WIRE_TAG_AUTHORITY_CHANGE)
    const decoded = decodeAuthorityChange(buf)
    expect(decoded).toEqual({ tick: 123456, eventSeq: 789 })
  })

  it('round-trips the largest tick and eventSeq a u32 can hold', () => {
    const buf = new Uint8Array(AUTHORITY_CHANGE_BYTES)
    encodeAuthorityChange(buf, 0xffffffff, 0xfffffffe)
    expect(decodeAuthorityChange(buf)).toEqual({ tick: 0xffffffff, eventSeq: 0xfffffffe })
  })

  it('refuses a destination buffer shorter than AUTHORITY_CHANGE_BYTES', () => {
    expect(() => encodeAuthorityChange(new Uint8Array(9), 0, 0)).toThrow(
      'encodeAuthorityChange: out is 9 bytes, need 10',
    )
  })
})
```

- [ ] **Step 2: Run the test and confirm the RED**

Run: `npx vitest run packages/net/test/shadow.test.ts`

Expected: FAIL with `Failed to resolve import "../src/shadow" from "packages/net/test/shadow.test.ts"`
— `packages/net/src/shadow.ts` does not exist yet.

- [ ] **Step 3: Write the constants and the authorityChange codec**

Create `packages/net/src/shadow.ts` with (only) this much for now:

```ts
// The server's per-room shadow simulation. See docs/superpowers/specs/2026-08-13-tapkart-design.md
// S5 "The server is a shadow authority" and the locked Plan 2 contract SS5-6.
import type { AuthEvent, Intent, SimContext, SimState } from '@tapkart/sim'
import { MAX_ENTITIES, MAX_KARTS, TICK_HZ, allocStateLike, cloneState, makeIntentBuffer, step, wrapAngle } from '@tapkart/sim'

import type { Transport } from './transport'
import { applyEvent } from './apply'

// ../../protocol/src/* is relative, not `@tapkart/protocol`: protocol's own barrel is Task 18,
// which lands after every net task including this one, so its bare specifier does not yet expose
// these modules. See this task's Interfaces block.
import type { InputDatagram, WireSnapshot } from '../../protocol/src/types'
import { EPS } from '../../protocol/src/quant'
import { applySnapshotToState, decodeSnapshot, encodeSnapshot } from '../../protocol/src/snapshot'
import { decodeEvents, encodeEvents } from '../../protocol/src/events'
import { decodeInput } from '../../protocol/src/input'

/** Host loss is declared after this many ticks with no snapshot: 1.5s @ 60Hz, spec S5. */
export const HOST_TIMEOUT_TICKS = 90

/** WireSnapshot broadcast cadence once promoted: 20Hz, i.e. every 3rd tick of a 60Hz sim. */
export const SNAPSHOT_PERIOD_TICKS = 3

/**
 * Depth of the correction ring buffer, in ticks. Sized so a snapshot's reference tick never falls
 * outside the window under the default LoopbackOptions (150ms latency + 50ms jitter = 200ms
 * worst-case one-way transit = 12 ticks @ 60Hz): 24 ticks (400ms) gives 2x headroom.
 */
export const SHADOW_HISTORY_TICKS = 24

/**
 * One-byte tag prefix identifying a wire message's kind, in `MessageKind` union order
 * (packages/protocol/src/types.ts, Task 3). No task in the locked contract's protocol module map
 * assigns an encoder to WireHeader, so this file defines the convention it needs and every other
 * net task's message producers/consumers must share it. See this task's Interfaces block.
 */
export const WIRE_TAG_INPUT = 4
export const WIRE_TAG_SNAPSHOT = 5
export const WIRE_TAG_EVENTS = 6
export const WIRE_TAG_CHECKPOINT = 7
export const WIRE_TAG_AUTHORITY_CHANGE = 8

/** tag u8 + protocolVersion u8 + tick u32LE + eventSeq u32LE. */
export const AUTHORITY_CHANGE_BYTES = 10

const PROTOCOL_VERSION_BYTE = 1

export function encodeAuthorityChange(out: Uint8Array, tick: number, eventSeq: number): number {
  if (out.length < AUTHORITY_CHANGE_BYTES) {
    throw new Error(`encodeAuthorityChange: out is ${out.length} bytes, need ${AUTHORITY_CHANGE_BYTES}`)
  }
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength)
  out[0] = WIRE_TAG_AUTHORITY_CHANGE
  out[1] = PROTOCOL_VERSION_BYTE
  dv.setUint32(2, tick >>> 0, true)
  dv.setUint32(6, eventSeq >>> 0, true)
  return AUTHORITY_CHANGE_BYTES
}

export function decodeAuthorityChange(buf: Uint8Array): { tick: number; eventSeq: number } {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  return { tick: dv.getUint32(2, true), eventSeq: dv.getUint32(6, true) }
}
```

- [ ] **Step 4: Run the test and confirm the GREEN**

Run: `npx vitest run packages/net/test/shadow.test.ts`
Expected: PASS — 6 tests. (`ShadowLoop` itself is not imported yet, so this file's later, unwritten
class does not block these.)

- [ ] **Step 5: Write the failing test for follower-mode ticking**

Append to `packages/net/test/shadow.test.ts`:

```ts
import type { AuthEvent } from '@tapkart/sim'
import { MAX_KARTS, createState } from '@tapkart/sim'
import { makeNetContext } from './fixtures/net-fixtures'
import { ShadowLoop } from '../src/shadow'

function neutralInputs() {
  const out = []
  for (let i = 0; i < MAX_KARTS; i++) out.push({ tick: 0, steer: 0, accel: 0, brake: false, drift: false, useItem: false })
  return out
}

describe('ShadowLoop: follower mode', () => {
  it('advances state.tick by exactly one per tick() call, starting from tick 0', () => {
    const ctx = makeNetContext(false)
    const state = createState(ctx, 0xabc, [0, 1, 2, 3, 4, 5, 6, 7])
    const shadow = new ShadowLoop(ctx, state, { send() {}, broadcast() {}, onMessage() {}, onPeerLost() {}, peers: () => [], close() {} })
    expect(state.tick).toBe(0)
    for (let i = 1; i <= 10; i++) {
      shadow.tick()
      expect(state.tick).toBe(i)
    }
  })

  it('never rolls items and never emits while ctx.isLeader is false, across 300 ticks', () => {
    // A stub Transport that never delivers anything: no host, no clients. Every kart therefore sits
    // on accel 0 the whole time, but rngCursor and nextEventSeq must still hold at their initial
    // values on every single tick, because a follower's step() never touches them (see this task's
    // verified-facts list above, fact 1).
    const ctx = makeNetContext(false)
    const state = createState(ctx, 0xabc, [0, 1, 2, 3, 4, 5, 6, 7])
    const shadow = new ShadowLoop(ctx, state, { send() {}, broadcast() {}, onMessage() {}, onPeerLost() {}, peers: () => [], close() {} })
    for (let i = 0; i < 300; i++) {
      shadow.tick()
      expect(state.rngCursor, `rngCursor moved on tick ${i}`).toBe(0)
      expect(state.nextEventSeq, `nextEventSeq moved on tick ${i}`).toBe(0)
    }
  })

  it('applies an incoming event exactly once, even if the same bytes are delivered twice', () => {
    const ctx = makeNetContext(false)
    const state = createState(ctx, 0xabc, [0, 1, 2, 3, 4, 5, 6, 7])
    let onMessageCb: (peerId: string, channel: string, data: Uint8Array) => void = () => {}
    const shadow = new ShadowLoop(ctx, state, {
      send() {}, broadcast() {},
      onMessage: (cb) => { onMessageCb = cb },
      onPeerLost() {}, peers: () => [], close() {},
    })

    const ev: AuthEvent = { eventSeq: 0, tick: 0, kind: 'itemGrant', playerId: 3, entityId: -1, item: 'boost', data: 0 }
    const buf = new Uint8Array(64)
    buf[0] = 6 // WIRE_TAG_EVENTS
    const { encodeEvents } = await import('../../protocol/src/events')
    const n = encodeEvents(buf.subarray(1), [ev])

    onMessageCb('host', 'reliable', buf.subarray(0, n + 1))
    onMessageCb('host', 'reliable', buf.subarray(0, n + 1)) // redelivered — reliable channels can still repeat a send
    shadow.tick()

    expect(state.karts[3].item).toBe('boost')
    expect(state.nextEventSeq).toBe(1) // applied once, not twice
  })
})
```

- [ ] **Step 6: Run the test and confirm the RED**

Run: `npx vitest run packages/net/test/shadow.test.ts`
Expected: FAIL with `TypeError: ShadowLoop is not a constructor` (Vitest's SSR transform reports a
missing named export as `undefined` at the call site, not a link-time error — this repo's
established pattern, see task-07/08/09/13/14/15's RED steps in Plan 1).

- [ ] **Step 7: Write the constructor and the follower-mode `tick()` path**

Append to `packages/net/src/shadow.ts`:

```ts
interface ShadowHistoryEntry {
  tick: number
  state: SimState
  inputs: Intent[]
  eventsApplied: AuthEvent[]
}

function freshWireSnapshot(): WireSnapshot {
  const karts = []
  for (let i = 0; i < MAX_KARTS; i++) {
    karts.push({
      playerId: 0, position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, heading: 0,
      angularVelocity: 0, driftCharge: 0, driftActive: false, driftDir: 0 as -1 | 0 | 1,
      airborne: false, surface: 'tarmac' as const, spinOutTicks: 0, invulnTicks: 0, item: 'none' as const,
      lap: 0, checkpointIdx: 0, t: 0, isBot: false, connected: false,
      boostTicks: 0, respawnTicks: 0, shielded: false,
    })
  }
  const entities = []
  for (let i = 0; i < MAX_ENTITIES; i++) {
    entities.push({
      entityId: -1, kind: 'seeker' as const, ownerId: -1, position: { x: 0, y: 0, z: 0 },
      velocity: { x: 0, y: 0, z: 0 }, heading: 0, ttl: 0,
    })
  }
  return { tick: 0, eventSeq: 0, lastProcessedInputTick: new Array(MAX_KARTS).fill(-1), karts, entities, entityCount: 0 }
}

function neutralIntent(tick: number): Intent {
  return { tick, steer: 0, accel: 0, brake: false, drift: false, useItem: false }
}

export class ShadowLoop {
  private readonly ctx: SimContext
  private readonly publish: SimState
  private live: SimState
  private scratch: SimState
  private readonly replayScratch: SimState
  private readonly heldInput: Intent[]
  private readonly heldInputTick: Int32Array
  private readonly lastProcessedInputTick: number[]
  private readonly pendingEvents: AuthEvent[]
  private pendingSnapshot: WireSnapshot | null
  private readonly snapshotScratch: WireSnapshot
  private readonly history: ShadowHistoryEntry[]
  private ticksSinceSnapshot: number
  private promoted: boolean
  private readonly t: Transport

  constructor(ctx: SimContext, state: SimState, t: Transport) {
    this.ctx = ctx
    this.publish = state
    this.t = t
    this.live = allocStateLike(ctx, state)
    this.scratch = allocStateLike(ctx, state)
    this.replayScratch = allocStateLike(ctx, state)
    this.heldInput = makeIntentBuffer()
    this.heldInputTick = new Int32Array(MAX_KARTS).fill(-1)
    this.lastProcessedInputTick = new Array(MAX_KARTS).fill(-1)
    this.pendingEvents = []
    this.pendingSnapshot = null
    this.snapshotScratch = freshWireSnapshot()
    this.history = []
    for (let i = 0; i < SHADOW_HISTORY_TICKS; i++) {
      this.history.push({ tick: -1, state: allocStateLike(ctx, state), inputs: makeIntentBuffer(), eventsApplied: [] })
    }
    this.ticksSinceSnapshot = 0
    this.promoted = ctx.isLeader
    t.onMessage((peerId, channel, data) => this.onMessage(peerId, channel, data))
  }

  private onMessage(_peerId: string, _channel: string, data: Uint8Array): void {
    if (this.promoted || data.length === 0) return
    const tag = data[0]
    if (tag === WIRE_TAG_INPUT) {
      const dg: InputDatagram = { playerId: 0, intents: [] }
      decodeInput(data.subarray(1), dg)
      if (dg.intents.length === 0) return
      const newest = dg.intents[dg.intents.length - 1]
      if (dg.playerId >= 0 && dg.playerId < MAX_KARTS && newest.tick > this.heldInputTick[dg.playerId]) {
        const h = this.heldInput[dg.playerId]
        h.tick = newest.tick
        h.steer = newest.steer
        h.accel = newest.accel
        h.brake = newest.brake
        h.drift = newest.drift
        h.useItem = newest.useItem
        this.heldInputTick[dg.playerId] = newest.tick
      }
    } else if (tag === WIRE_TAG_EVENTS) {
      const evs: AuthEvent[] = []
      decodeEvents(data.subarray(1), evs)
      for (const ev of evs) this.pendingEvents.push(ev)
    } else if (tag === WIRE_TAG_SNAPSHOT) {
      decodeSnapshot(data.subarray(1), this.snapshotScratch)
      this.pendingSnapshot = this.snapshotScratch
      this.ticksSinceSnapshot = 0
    }
  }

  tick(): void {
    if (!this.promoted && this.pendingSnapshot !== null) {
      this.reconcile(this.pendingSnapshot)
      this.pendingSnapshot = null
    }

    const appliedThisTick: AuthEvent[] = []
    if (!this.promoted) {
      for (const ev of this.pendingEvents) {
        applyEvent(this.ctx, this.live, ev)
        appliedThisTick.push(ev)
      }
      this.pendingEvents.length = 0
    }

    const inputsForStep = this.promoted ? this.heldInputForLeader() : this.heldInput
    const freshEvents: AuthEvent[] = []
    step(this.ctx, this.live, this.scratch, inputsForStep, freshEvents)
    const tmp = this.live
    this.live = this.scratch
    this.scratch = tmp

    for (let i = 0; i < MAX_KARTS; i++) this.lastProcessedInputTick[i] = this.heldInputTick[i]

    const slot = this.live.tick % SHADOW_HISTORY_TICKS
    const entry = this.history[slot]
    cloneState(this.live, entry.state)
    entry.tick = this.live.tick
    entry.eventsApplied = appliedThisTick
    for (let i = 0; i < MAX_KARTS; i++) {
      const src = inputsForStep[i]
      const dst = entry.inputs[i]
      dst.tick = src.tick; dst.steer = src.steer; dst.accel = src.accel
      dst.brake = src.brake; dst.drift = src.drift; dst.useItem = src.useItem
    }

    cloneState(this.live, this.publish)

    if (this.promoted) {
      if (this.live.tick % SNAPSHOT_PERIOD_TICKS === 0) this.broadcastSnapshot()
      if (freshEvents.length > 0) this.broadcastEvents(freshEvents)
      return
    }

    this.ticksSinceSnapshot++
    if (this.ticksSinceSnapshot >= HOST_TIMEOUT_TICKS) this.promote(this.live.tick)
  }

  private heldInputForLeader(): Intent[] {
    // Once promoted there is no more host to hold input for the pair-of-ticks rule on our behalf;
    // this loop simply keeps using whatever was last received per player, same as follower mode.
    return this.heldInput
  }

  promote(tick: number): void {
    if (this.promoted) return
    const out = new Uint8Array(AUTHORITY_CHANGE_BYTES)
    encodeAuthorityChange(out, tick, this.live.nextEventSeq)
    this.t.broadcast('reliable', out)
    // Re-seed the item PRNG deterministically from (raceSeed, promotionTick), spec S5. raceSeed
    // itself never changes (SimState.raceSeed is fixed at createState); rollItem (items.ts, not
    // owned by this task) always draws rngAt(state.raceSeed, state.rngCursor), so "re-seeded from
    // (raceSeed, promotionTick)" is realised here as jumping the cursor to `tick` rather than
    // continuing from wherever the last snapshot correction left it — a value that depended on
    // exactly how many items the since-dead host had granted, which is not a clean function of
    // promotionTick alone.
    this.live.rngCursor = tick
    this.ctx.isLeader = true
    this.promoted = true
  }

  private reconcile(snap: WireSnapshot): void {
    const targetTick = snap.tick
    const nowTick = this.live.tick
    const oldest = nowTick - SHADOW_HISTORY_TICKS + 1
    const slot = targetTick % SHADOW_HISTORY_TICKS
    const entry = this.history[slot]

    if (targetTick > nowTick || targetTick < oldest || entry.tick !== targetTick) {
      applySnapshotToState(snap, this.live)
      cloneState(this.live, entry.state) // best effort: keep the ring internally consistent
      entry.tick = this.live.tick
      return
    }

    if (!this.diverges(entry.state, snap)) return

    applySnapshotToState(snap, entry.state)

    let cur = entry.state
    let scratch = this.replayScratch
    for (let t = targetTick + 1; t <= nowTick; t++) {
      const histT = this.history[t % SHADOW_HISTORY_TICKS]
      for (const ev of histT.eventsApplied) applyEvent(this.ctx, cur, ev)
      step(this.ctx, cur, scratch, histT.inputs, [])
      const tmp = cur
      cur = scratch
      scratch = tmp
      cloneState(cur, histT.state)
      histT.tick = t
    }
    cloneState(cur, this.live)
  }

  private diverges(local: SimState, snap: WireSnapshot): boolean {
    const exceeds = (a: number, b: number, eps: number) => Math.abs(a - b) > eps
    const angleExceeds = (a: number, b: number, eps: number) => Math.abs(wrapAngle(a - b)) > eps
    for (let i = 0; i < MAX_KARTS; i++) {
      const k = local.karts[i]
      const w = snap.karts[i]
      if (exceeds(k.position.x, w.position.x, EPS.position)) return true
      if (exceeds(k.position.y, w.position.y, EPS.position)) return true
      if (exceeds(k.position.z, w.position.z, EPS.position)) return true
      if (exceeds(k.velocity.x, w.velocity.x, EPS.velocity)) return true
      if (exceeds(k.velocity.y, w.velocity.y, EPS.velocity)) return true
      if (exceeds(k.velocity.z, w.velocity.z, EPS.velocity)) return true
      if (angleExceeds(k.heading, w.heading, EPS.heading)) return true
      if (exceeds(k.angularVelocity, w.angularVelocity, EPS.angularVelocity)) return true
      if (exceeds(k.drift.charge, w.driftCharge, EPS.driftCharge)) return true
      if (exceeds(k.lap.t, w.t, EPS.lapT)) return true
      if (!Object.is(k.drift.active, w.driftActive)) return true
      if (!Object.is(k.drift.dir, w.driftDir)) return true
      if (!Object.is(k.item, w.item)) return true
      if (!Object.is(k.airborne, w.airborne)) return true
      if (!Object.is(k.surface, w.surface)) return true
      if (!Object.is(k.spinOutTicks, w.spinOutTicks)) return true
      if (!Object.is(k.invulnTicks, w.invulnTicks)) return true
      if (!Object.is(k.boostTicks, w.boostTicks)) return true
      if (!Object.is(k.respawnTicks, w.respawnTicks)) return true
      if (!Object.is(k.shielded, w.shielded)) return true
      if (!Object.is(k.lap.lap, w.lap)) return true
      if (!Object.is(k.lap.checkpointIdx, w.checkpointIdx)) return true
    }
    if (local.entityCount !== snap.entityCount) return true
    const n = Math.min(local.entityCount, snap.entityCount)
    for (let i = 0; i < n; i++) {
      const e = local.entities[i]
      const w = snap.entities[i]
      if (exceeds(e.position.x, w.position.x, EPS.position)) return true
      if (exceeds(e.position.y, w.position.y, EPS.position)) return true
      if (exceeds(e.position.z, w.position.z, EPS.position)) return true
      if (exceeds(e.velocity.x, w.velocity.x, EPS.velocity)) return true
      if (exceeds(e.velocity.y, w.velocity.y, EPS.velocity)) return true
      if (exceeds(e.velocity.z, w.velocity.z, EPS.velocity)) return true
      if (angleExceeds(e.heading, w.heading, EPS.heading)) return true
      if (!Object.is(e.entityId, w.entityId)) return true
      if (!Object.is(e.kind, w.kind)) return true
      if (!Object.is(e.ownerId, w.ownerId)) return true
    }
    return false
  }

  private broadcastSnapshot(): void {
    const buf = new Uint8Array(1 + 640) // 640 >= contract SS4's worst-case 625B snapshot
    buf[0] = WIRE_TAG_SNAPSHOT
    const n = encodeSnapshot(buf.subarray(1), this.live, this.lastProcessedInputTick)
    this.t.broadcast('unreliable', buf.subarray(0, n + 1))
  }

  private broadcastEvents(events: AuthEvent[]): void {
    const buf = new Uint8Array(1 + 4096) // generous: SS4 gives no per-event byte size to size this exactly
    buf[0] = WIRE_TAG_EVENTS
    const n = encodeEvents(buf.subarray(1), events)
    this.t.broadcast('reliable', buf.subarray(0, n + 1))
  }
}
```

Note the `useless neutralIntent` import isn't referenced above — remove the unused `neutralIntent`
helper if `tsc --noEmit` flags it under `noUnusedLocals` (it is not called by any of the code above;
it was scaffolding from an earlier draft of this file and must not ship). Delete that function before
running Step 8.

- [ ] **Step 8: Run the test and confirm the GREEN**

Run: `npx vitest run packages/net/test/shadow.test.ts`
Expected: PASS — 9 tests (6 from Step 1 + 3 from Step 5).

Run: `npx tsc --noEmit -p packages/net`
Expected: PASS, zero errors. If `EPS.position` (or any of the other five) does not exist on
`EpsilonTable`, this is where it surfaces — see the "Assumption" paragraph above for the fix.

- [ ] **Step 9: Write the failing test for snapshot correction**

Append to `packages/net/test/shadow.test.ts`:

```ts
describe('ShadowLoop: snapshot correction', () => {
  it('does nothing when the incoming snapshot matches the buffered tick within tolerance', () => {
    const ctx = makeNetContext(false)
    const state = createState(ctx, 0x111, [0, 1, 2, 3, 4, 5, 6, 7])
    let onMessageCb: (peerId: string, channel: string, data: Uint8Array) => void = () => {}
    const shadow = new ShadowLoop(ctx, state, {
      send() {}, broadcast() {}, onMessage: (cb) => { onMessageCb = cb }, onPeerLost() {}, peers: () => [], close() {},
    })
    for (let i = 0; i < 5; i++) shadow.tick()
    const beforePos = { ...state.karts[0].position }

    const { encodeSnapshot } = await import('../../protocol/src/snapshot')
    const buf = new Uint8Array(1 + 640)
    buf[0] = 5 // WIRE_TAG_SNAPSHOT
    const n = encodeSnapshot(buf.subarray(1), state, new Array(MAX_KARTS).fill(-1))
    onMessageCb('host', 'unreliable', buf.subarray(0, n + 1))
    shadow.tick()

    // Quantized-and-dequantized truth for an unmoving kart (accel 0 the whole time) is the same
    // value it started at, well inside the 0.05m position epsilon: no correction fires.
    expect(Math.abs(state.karts[0].position.x - beforePos.x)).toBeLessThan(0.05)
  })

  it('snaps every kart and every live entity onto the snapshot when a field exceeds its epsilon', async () => {
    const ctx = makeNetContext(false)
    const state = createState(ctx, 0x222, [0, 1, 2, 3, 4, 5, 6, 7])
    let onMessageCb: (peerId: string, channel: string, data: Uint8Array) => void = () => {}
    const shadow = new ShadowLoop(ctx, state, {
      send() {}, broadcast() {}, onMessage: (cb) => { onMessageCb = cb }, onPeerLost() {}, peers: () => [], close() {},
    })
    for (let i = 0; i < 5; i++) shadow.tick() // buffers ticks 1..5 in the ring

    const { encodeSnapshot } = await import('../../protocol/src/snapshot')
    const buf = new Uint8Array(1 + 640)
    buf[0] = 5
    const spoofed = createState(ctx, 0x222, [0, 1, 2, 3, 4, 5, 6, 7])
    spoofed.tick = 3 // a tick still inside the 24-deep ring
    spoofed.karts[0].position.x += 5 // 5m: nowhere near the 0.05m epsilon
    const n = encodeSnapshot(buf.subarray(1), spoofed, new Array(MAX_KARTS).fill(-1))
    onMessageCb('host', 'unreliable', buf.subarray(0, n + 1))
    shadow.tick() // triggers reconcile() at the top of this call, then steps tick 5 -> 6

    // After reconcile-and-replay, the live kart 0 position must have moved toward the corrected
    // value: still not bit-identical (two more ticks of accel-0 motion ran after the correction),
    // but the 5m jump must be visible, not silently absorbed.
    expect(Math.abs(state.karts[0].position.x - spoofed.karts[0].position.x)).toBeLessThan(0.5)
  })
})
```

- [ ] **Step 10: Run the test and confirm the RED**

Run: `npx vitest run packages/net/test/shadow.test.ts -t "snapshot correction"`
Expected: FAIL — both assertions fail because `reconcile()` from Step 7 already exists (it does
not; Step 7 as written above already includes `reconcile`/`diverges`). Skip to Step 11 only if this
actually passes already; otherwise the failure names the field that did not move
(`expected X to be less than 0.05`), confirming `reconcile` is not yet wired to fire from
`onMessage`'s stored `pendingSnapshot`.

Actually — Steps 7's implementation already wires `reconcile` into `tick()`. This step exists to
confirm the two dedicated tests above pass against that same code, so:

Run: `npx vitest run packages/net/test/shadow.test.ts`
Expected: PASS — 11 tests. If it does not, the failure is inside `reconcile`/`diverges`, not a
missing export — fix `shadow.ts` directly rather than adding new code elsewhere.

- [ ] **Step 11: Write the failing test for promotion**

Append to `packages/net/test/shadow.test.ts`:

```ts
describe('ShadowLoop: promotion', () => {
  it('auto-promotes at exactly HOST_TIMEOUT_TICKS with no snapshot ever received', () => {
    const ctx = makeNetContext(false)
    const state = createState(ctx, 0x333, [0, 1, 2, 3, 4, 5, 6, 7])
    const broadcasts: { channel: string; data: Uint8Array }[] = []
    const shadow = new ShadowLoop(ctx, state, {
      send() {}, broadcast: (channel, data) => broadcasts.push({ channel, data }),
      onMessage() {}, onPeerLost() {}, peers: () => [], close() {},
    })
    expect(ctx.isLeader).toBe(false)
    for (let i = 0; i < HOST_TIMEOUT_TICKS - 1; i++) shadow.tick()
    expect(ctx.isLeader).toBe(false) // not yet: 89 ticks with no snapshot

    shadow.tick() // the 90th
    expect(ctx.isLeader).toBe(true)

    const changes = broadcasts.filter((b) => b.channel === 'reliable' && b.data[0] === WIRE_TAG_AUTHORITY_CHANGE)
    expect(changes).toHaveLength(1)
    const decoded = decodeAuthorityChange(changes[0].data)
    expect(decoded.tick).toBe(HOST_TIMEOUT_TICKS)
  })

  it('re-seeds rngCursor to the promotion tick and never rewinds tick, lap, or a live entity', () => {
    const ctx = makeNetContext(false)
    const state = createState(ctx, 0x444, [0, 1, 2, 3, 4, 5, 6, 7])
    const shadow = new ShadowLoop(ctx, state, { send() {}, broadcast() {}, onMessage() {}, onPeerLost() {}, peers: () => [], close() {} })
    for (let i = 0; i < 40; i++) shadow.tick()
    const tickBefore = state.tick
    const lapsBefore = state.karts.map((k) => k.lap.lap)
    const liveBefore = new Set(state.entities.slice(0, state.entityCount).map((e) => e.entityId))

    shadow.promote(state.tick)
    expect(state.rngCursor).toBe(tickBefore)
    expect(ctx.isLeader).toBe(true)

    for (let i = 0; i < 40; i++) {
      shadow.tick()
      expect(state.tick).toBeGreaterThanOrEqual(tickBefore) // never rewinds
      for (let k = 0; k < MAX_KARTS; k++) {
        expect(state.karts[k].lap.lap).toBeGreaterThanOrEqual(lapsBefore[k])
      }
      const liveNow = new Set(state.entities.slice(0, state.entityCount).map((e) => e.entityId))
      for (const id of liveBefore) {
        // an entity may legitimately expire (ttl reaches 0) but never simply vanishes at promotion
        if (!liveNow.has(id)) liveBefore.delete(id)
      }
    }
  })

  it('rolls items and emits once promoted, at a broadcast cadence of every 3rd tick', () => {
    const ctx = makeNetContext(false)
    const state = createState(ctx, 0x555, [0, 1, 2, 3, 4, 5, 6, 7])
    const snapshots: Uint8Array[] = []
    const shadow = new ShadowLoop(ctx, state, {
      send() {},
      broadcast: (channel, data) => { if (channel === 'unreliable' && data[0] === WIRE_TAG_SNAPSHOT) snapshots.push(data) },
      onMessage() {}, onPeerLost() {}, peers: () => [], close() {},
    })
    shadow.promote(0)
    for (let i = 1; i <= 9; i++) shadow.tick()
    expect(snapshots).toHaveLength(3) // ticks 3, 6, 9
  })

  it('calling promote() twice is a no-op the second time', () => {
    const ctx = makeNetContext(false)
    const state = createState(ctx, 0x666, [0, 1, 2, 3, 4, 5, 6, 7])
    let count = 0
    const shadow = new ShadowLoop(ctx, state, {
      send() {}, broadcast: (channel) => { if (channel === 'reliable') count++ },
      onMessage() {}, onPeerLost() {}, peers: () => [], close() {},
    })
    shadow.promote(5)
    shadow.promote(5)
    expect(count).toBe(1)
  })
})
```

- [ ] **Step 12: Run the test and confirm the GREEN**

Run: `npx vitest run packages/net/test/shadow.test.ts`
Expected: PASS — 15 tests. Everything in this section already has an implementation from Step 7;
this step exists to catch a mismatch between what Step 7 wrote and what promotion actually needs to
guarantee (in particular the "never rewinds" loop, which exercises 40 real ticks post-promotion, not
one).

- [ ] **Step 13: Full package verification**

Run: `npx tsc --noEmit -p packages/net && npx vitest run packages/net`
Expected: PASS, zero type errors, all `packages/net` tests green (this file's 15 plus whatever
Tasks 11–15 shipped).

- [ ] **Step 14: Commit**

```bash
git add packages/net/src/shadow.ts packages/net/test/shadow.test.ts
git commit -m "feat(net): add ShadowLoop, the server's per-room shadow authority

The server cannot passively hold snapshots and reconstruct state on host
loss - no PRNG cursor, no entity state, no input buffers, no event
sequence (spec S5). ShadowLoop instead runs step() in lockstep as a
follower from tick 0: it applies every client's input and the host's
authoritative events, never rolls items, never originates events
(verified directly against items.ts and phase.ts's ctx.isLeader gates),
and uses the host's WireSnapshot stream as a periodic correction across
every kart and entity via a 24-tick rewind-and-replay ring buffer, the
same shape as a client's own reconciliation.

On 90 ticks (1.5s @ 60Hz) with no snapshot, it declares the host lost,
broadcasts authorityChange, re-seeds its item PRNG from
(raceSeed, promotionTick), and switches to leader mode - with no rewind,
because it has been simulating the whole race continuously.

Defines its own tiny wire format for authorityChange and a one-byte
message-kind tag convention, since the locked contract does not assign
either to any protocol task; flagged for Tasks 11/14/15 to share."
```

---

**Ambiguities and dependencies flagged for the plan's author, not resolved unilaterally here:**

1. **No task in the locked contract assigns an encoder to `WireHeader`, and no task defines how an
   `onMessage` receiver tells one `MessageKind` apart from another on the same callback.** This task
   defines `WIRE_TAG_*` and uses it for every message it sends and reads. Tasks 11 (transport), 14
   (`AuthorityLoop`) and 15 (`ClientLoop`) must use the identical one-byte-prefix convention, or a
   promoted shadow's broadcasts are unreadable by clients and a host's broadcasts are unreadable by
   this file's follower mode.
2. **`ClientLoop`'s locked signature (`constructor(ctx, playerId, t)`, `tick(localIntent)`,
   `corrections()`) exposes no way to read its predicted `SimState` from outside.** This did not
   block Task 16, which never touches `ClientLoop`, but it constrains what Task 17's convergence
   test can assert directly — see that task's brief for how it works around this without depending
   on `ClientLoop`'s unwritten internals.
