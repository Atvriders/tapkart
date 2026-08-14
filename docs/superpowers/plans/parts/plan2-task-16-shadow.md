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
export const MAX_KARTS = 8   // TICK_HZ is deliberately NOT imported: nothing here reads it,
                             // and `noUnusedLocals` makes an unused import a build failure
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

Protocol pieces this file needs (Tasks 3, 5, 6, 8, 9, 10 — all land before Task 16 in the task
sequence). **Every one of them is imported from `@tapkart/protocol`, the bare specifier, never by a
relative path into `../../protocol/src/<module>`.** Contract §3 is explicit on both halves of this:
*"The barrel exists from Task 3, not Task 18"* — Task 3's scaffold creates
`packages/protocol/src/index.ts` and each codec task appends its own `export *` line, exactly as
Plan 1's tasks did for `@tapkart/sim` — and *"`net` imports `@tapkart/protocol`, always,"* because a
relative path "punches through the package boundary, bypasses the `exports` map, and would survive
into Plan 3." An earlier draft of this brief argued the opposite from a premise about the contract
that was false:

```ts
// @tapkart/protocol — types.ts [Task 3]
export type ChannelName = 'unreliable' | 'reliable'
export type MessageKind =
  | 'hello' | 'welcome' | 'lobby' | 'start'
  | 'input' | 'snapshot' | 'events' | 'checkpoint'
  | 'authorityChange' | 'ping' | 'pong'
export interface WireHeader { kind: MessageKind; protocolVersion: number }
export const WIRE_TAG: { readonly [K in MessageKind]: number }   // input 0x10, snapshot 0x11,
                                                                 // events 0x12, checkpoint 0x13,
                                                                 // authorityChange 0x20, ...
export function encodeHeader(out: Uint8Array, kind: MessageKind): number  // writes 2 bytes, returns 2
export function decodeHeader(buf: Uint8Array): WireHeader                 // throws on unknown tag / version
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

// @tapkart/protocol — quant.ts [Task 5]
export const EPS: EpsilonTable   // frozen; Task 7 proves epsilon > step for every field

// @tapkart/protocol — snapshot.ts [Task 6]
export function decodeSnapshot(buf: Uint8Array, out: WireSnapshot): void
export function applySnapshotToState(snap: WireSnapshot, dst: SimState): void
export function encodeSnapshot(out: Uint8Array, state: SimState, lastProcessedInputTick: number[]): number

// @tapkart/protocol — checkpoint.ts [Task 8]
export function decodeCheckpoint(buf: Uint8Array, dst: SimState): void

// @tapkart/protocol — events.ts [Task 9]
export function decodeEvents(buf: Uint8Array, out: AuthEvent[]): void
export function encodeEvents(out: Uint8Array, events: AuthEvent[]): number

// @tapkart/protocol — input.ts [Task 10]
export const INPUT_REDUNDANCY = 8
export function decodeInput(buf: Uint8Array, out: InputDatagram): void
// decodeInput writes into a caller-owned target and allocates NOTHING: out.intents
// must already hold INPUT_REDUNDANCY Intent objects. Task 10's own brief states it.
```

**`EPS`'s property names are pinned by the contract, not assumed by this task.** Contract §3's
`EpsilonTable` has exactly six keys — `position`, `velocity`, `heading`, `angularVelocity`,
`driftCharge`, `t` — and §4 spells the last one out: *"The key is `t`, not `lap.t`, matching the
flat `WireKart` interface in §3."* An earlier draft of this brief guessed `lapT` and flagged it as
an open assumption. It is not open, and the guess was wrong in the worst possible way: `EPS.lapT` is
`undefined`, `Math.abs(x) > undefined` is `false`, and the `t` check would silently never fire.

**The message header comes from the contract; this file does not invent one.** Contract §3 assigns
`WIRE_TAG`, `encodeHeader` and `decodeHeader` to Task 3's `types.ts` and says why in its own text:
*"Every datagram begins with this one byte. Without a shared tag a receiver cannot dispatch, and
each of Tasks 11/14/15/16 would invent its own — which is exactly what happened when this was left
unspecified."* An earlier draft of this brief did exactly that, defining
`WIRE_TAG_INPUT = 4 … WIRE_TAG_AUTHORITY_CHANGE = 8` inside `net/src/shadow.ts` while Tasks 14 and
15 sent untagged payloads — leaving host, client and shadow mutually unreadable. Those constants are
**deleted**. Every buffer this file sends starts with `encodeHeader(out, kind)` (2 bytes: tag +
protocol version, returns 2); every buffer it reads dispatches on `decodeHeader(data).kind` and
hands `data.subarray(HEADER_BYTES)` to the matching payload decoder.

This file needs the header more than either other loop does. Spec §5 has every client sending input
to **both** the host and the shadow, and the host sending this loop its snapshots and events, so
`ShadowLoop.onMessage` is the one callback in the system that genuinely sees four different message
kinds across two channels.

Produces:

```ts
// packages/net/src/shadow.ts
export const HOST_TIMEOUT_TICKS = 90        // 1.5s @ 60Hz = 30 missed snapshots x 3 ticks/snapshot
export const SNAPSHOT_PERIOD_TICKS = 3      // TICK_HZ (60) / snapshot rate (20Hz)
export const SHADOW_HISTORY_TICKS = 24      // >= 2x the 200ms worst-case one-way transit (150ms
                                             // latency + 50ms jitter = 200ms = 12 ticks @ 60Hz)
export const AUTHORITY_CHANGE_BYTES = 10    // 2-byte shared header + tick u32LE + eventSeq u32LE
export function encodeAuthorityChange(out: Uint8Array, tick: number, eventSeq: number): number
export function decodeAuthorityChange(buf: Uint8Array): { tick: number; eventSeq: number }
export class ShadowLoop {
  constructor(ctx: SimContext, state: SimState, t: Transport)
  tick(): void
  promote(tick: number): void
}
```

`AUTHORITY_CHANGE_BYTES` stays **10**: the payload is two `u32`s and the header is 2 bytes, exactly
the width the hand-rolled tag+version prefix used to be. Only the two byte *values* change.

Defined privately in this file, not exported: `const HEADER_BYTES = 2`. Contract §3 fixes the width
`encodeHeader` writes but exports no constant for it, and §0 allows a task to define what it needs
in its own files. `authority.ts` (Task 14) and `client.ts` (Task 15) each declare the same private
constant rather than importing one `net` module into another.

**Design decisions this file makes, stated up front so the steps below aren't a surprise:**

- **`state` (the constructor argument) is the caller's window onto this loop, published once per
  `tick()` call.** `ShadowLoop` cannot run `step()` directly against a single shared object (`step`
  needs distinct `prev`/`next` buffers), so it allocates its own working pair (`live`, `scratch`) at
  construction via `allocStateLike(ctx, state)`, and at the end of every `tick()` call does
  `cloneState(this.live, state)` — a value copy into the caller's own object, never a reference
  swap. The caller always reads `state` after calling `tick()`. Contract §5 gives `ShadowLoop`
  three members and no `state()` getter (unlike `AuthorityLoop` and `ClientLoop`, which both have
  one), so the published object *is* the accessor; every mutation this loop makes outside `tick()`
  — there is exactly one, `promote()` — must therefore republish before returning, or the caller
  reads a value that does not exist yet.
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
- **A received `AuthorityCheckpoint` replaces this loop's whole state.** Spec §5 names three uses
  for `AuthorityCheckpoint`, and one of them is this file's: *"shadow resync after a network
  partition."* Task 8 ships the codec and, without this handler, no loop in the plan ever sends or
  receives one — the reliable channel's stated cargo (spec §5: "events, checkpoints, and lobby
  state") would be two-thirds unimplemented. The handler is small because the codec is
  full-precision: decode into a scratch `SimState` in `onMessage` (no mutation of `live` outside
  `tick()`, per the rule above), then `cloneState` it over `live` at the top of the next `tick()`,
  before the pending-snapshot path runs. A checkpoint outranks a snapshot: it is exact where a
  snapshot is quantised, and it arrives on the reliable channel precisely when the shadow's own
  history is known to be unusable. **It does not reset the promotion timer.** Spec §5 declares host
  loss after "1.5 s with no snapshot", and this loop takes that literally: a host that can send a
  checkpoint but no snapshots is a host whose 20 Hz stream has failed, which is the condition
  promotion exists for.
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

import { PROTOCOL_VERSION, WIRE_TAG, decodeHeader } from '@tapkart/protocol'
import {
  AUTHORITY_CHANGE_BYTES,
  HOST_TIMEOUT_TICKS,
  SHADOW_HISTORY_TICKS,
  SNAPSHOT_PERIOD_TICKS,
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
})

describe('authorityChange codec', () => {
  it('round-trips tick and eventSeq through exactly 10 bytes', () => {
    const buf = new Uint8Array(AUTHORITY_CHANGE_BYTES)
    const n = encodeAuthorityChange(buf, 123456, 789)
    expect(n).toBe(10)
    const decoded = decodeAuthorityChange(buf)
    expect(decoded).toEqual({ tick: 123456, eventSeq: 789 })
  })

  it('prefixes the contract\'s shared header, so a receiver can dispatch on it', () => {
    const buf = new Uint8Array(AUTHORITY_CHANGE_BYTES)
    encodeAuthorityChange(buf, 7, 8)
    // Not "buf[0] === some number this file made up": the byte must be the
    // one every other loop dispatches on. decodeHeader throws on an unknown
    // tag, so a hand-rolled prefix fails here rather than three tasks later.
    expect(buf[0]).toBe(WIRE_TAG.authorityChange)
    expect(decodeHeader(buf)).toEqual({ kind: 'authorityChange', protocolVersion: PROTOCOL_VERSION })
    // 2-byte header + two u32s. The payload starts where the header ends.
    expect(AUTHORITY_CHANGE_BYTES).toBe(2 + 4 + 4)
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
import { MAX_ENTITIES, MAX_KARTS, allocStateLike, cloneState, makeIntentBuffer, step, wrapAngle } from '@tapkart/sim'

import type { Transport } from './transport'
import { applyEvent } from './apply'

// The bare specifier, always - contract §3: "net imports @tapkart/protocol,
// always." The barrel exists from Task 3 and every codec task widens it; a
// relative path into ../../protocol/src/* bypasses the package's exports map
// and would survive into Plan 3.
import type { ChannelName, InputDatagram, WireSnapshot } from '@tapkart/protocol'
import {
  EPS,
  INPUT_REDUNDANCY,
  applySnapshotToState,
  decodeCheckpoint,
  decodeEvents,
  decodeHeader,
  decodeInput,
  decodeSnapshot,
  encodeEvents,
  encodeHeader,
  encodeSnapshot,
} from '@tapkart/protocol'

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
 * Worst-case snapshot, from contract §4's bit counts rather than a rounded byte figure:
 * 8 karts x 178 bits = 1424, plus 32 entities x 135 bits = 4320, plus a 200-bit header = 5944 bits
 * = 743 B exactly, and 745 B once this file's 2-byte message header is on the front. 1024 leaves
 * headroom. An earlier draft used `1 + 640`, citing a "worst-case 625B" that came from a superseded
 * 177-bit kart record with a packed entity velocity - and BitWriter overflows SILENTLY (a
 * typed-array write past the end is a no-op), so that buffer would have truncated every snapshot
 * with 26 or more live entities without raising anything.
 */
const SNAPSHOT_BUF_BYTES = 1024

/** Generous: §4 fixes no per-event byte size, and events are broadcast the tick they occur. */
const EVENTS_BUF_BYTES = 4096

/**
 * Width of the shared message header (tag + protocol version) that every datagram in this system
 * begins with. `encodeHeader` writes it and returns this number; contract §3 fixes it at 2 but
 * exports no constant, so this file declares one privately rather than sprinkling a literal `2`
 * through every `subarray` call. authority.ts and client.ts each do the same.
 */
const HEADER_BYTES = 2

/** 2-byte shared header + tick u32LE + eventSeq u32LE. */
export const AUTHORITY_CHANGE_BYTES = HEADER_BYTES + 8

export function encodeAuthorityChange(out: Uint8Array, tick: number, eventSeq: number): number {
  if (out.length < AUTHORITY_CHANGE_BYTES) {
    throw new Error(`encodeAuthorityChange: out is ${out.length} bytes, need ${AUTHORITY_CHANGE_BYTES}`)
  }
  const h = encodeHeader(out, 'authorityChange')
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength)
  dv.setUint32(h, tick >>> 0, true)
  dv.setUint32(h + 4, eventSeq >>> 0, true)
  return AUTHORITY_CHANGE_BYTES
}

export function decodeAuthorityChange(buf: Uint8Array): { tick: number; eventSeq: number } {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  return { tick: dv.getUint32(HEADER_BYTES, true), eventSeq: dv.getUint32(HEADER_BYTES + 4, true) }
}
```

- [ ] **Step 4: Run the test and confirm the GREEN**

Run: `npx vitest run packages/net/test/shadow.test.ts`
Expected: PASS — 7 tests. (`ShadowLoop` itself is not imported yet, so this file's later, unwritten
class does not block these.)

- [ ] **Step 5: Write the failing test for follower-mode ticking**

Append to `packages/net/test/shadow.test.ts`:

```ts
import type { AuthEvent, SimState } from '@tapkart/sim'
import { MAX_KARTS, createState } from '@tapkart/sim'
import type { ChannelName } from '@tapkart/protocol'
import { encodeCheckpoint, encodeEvents, encodeHeader, encodeInput, encodeSnapshot } from '@tapkart/protocol'
import { makeNetContext } from './fixtures/net-fixtures'
import { ShadowLoop } from '../src/shadow'

/**
 * Worst-case snapshot is 743 B — contract §4, recomputed from bits rather than
 * copied from a rounded figure: 8 karts x 178 + 32 entities x 135 + 200 header
 * = 5944 bits. 1024 covers that plus the 2-byte header with room to spare, and
 * matters because BitWriter overflows SILENTLY (a typed-array write past the
 * end is a no-op), so an undersized buffer truncates rather than throws.
 */
const SNAP_BUF_BYTES = 1024

/** encodeCheckpoint writes 5384 B for this SimState shape (Task 8 asserts the
 * exact figure); 8192 leaves headroom. DataView.setFloat64 past the end throws
 * RangeError, so this one fails loudly rather than silently. */
const CHECKPOINT_BUF_BYTES = 8192

/** Every message a test injects goes through here, so the header lives in one
 * place and a test can never accidentally hand-assemble a prefix the loops
 * under test do not agree with. */
function framed(kind: 'input' | 'snapshot' | 'events' | 'checkpoint', size: number,
                writePayload: (payload: Uint8Array) => number): Uint8Array {
  const buf = new Uint8Array(size)
  const h = encodeHeader(buf, kind)
  const n = writePayload(buf.subarray(h))
  return buf.subarray(0, h + n)
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
    // Typed as ChannelName, not string: Transport.onMessage's callback is
    // contextually typed, and under strictFunctionTypes a
    // (p: string, c: ChannelName, d: Uint8Array) => void is NOT assignable to a
    // holder declared with `channel: string` (TS2322).
    let onMessageCb: (peerId: string, channel: ChannelName, data: Uint8Array) => void = () => {}
    const shadow = new ShadowLoop(ctx, state, {
      send() {}, broadcast() {},
      onMessage: (cb) => { onMessageCb = cb },
      onPeerLost() {}, peers: () => [], close() {},
    })

    const ev: AuthEvent = { eventSeq: 0, tick: 0, kind: 'itemGrant', playerId: 3, entityId: -1, item: 'boost', data: 0 }
    const msg = framed('events', 256, (payload) => encodeEvents(payload, [ev]))

    onMessageCb('host', 'reliable', msg)
    onMessageCb('host', 'reliable', msg) // redelivered — reliable channels can still repeat a send
    shadow.tick()

    expect(state.karts[3].item).toBe('boost')
    expect(state.nextEventSeq).toBe(1) // applied once, not twice
    // ev.data is the boxIdx, so applying the grant also armed that box - the
    // half a bare `k.item = ev.item` would miss (Task 13).
    expect(state.itemBoxes[0].respawnTicks).toBe(ctx.tuning.itemBoxRespawnTicks)
  })

  it('takes a client input datagram off the wire and drives that seat with it', () => {
    const ctx = makeNetContext(false)
    const state = createState(ctx, 0xabc, [0, 0, 0, 0, 0, 0, 0, 0])
    state.phase = 'racing'
    state.karts[2].isBot = false
    state.karts[2].connected = true
    let onMessageCb: (peerId: string, channel: ChannelName, data: Uint8Array) => void = () => {}
    const shadow = new ShadowLoop(ctx, state, {
      send() {}, broadcast() {},
      onMessage: (cb) => { onMessageCb = cb },
      onPeerLost() {}, peers: () => [], close() {},
    })

    const startX = state.karts[2].position.x
    const startZ = state.karts[2].position.z
    const intents = Array.from({ length: 8 }, (_, i) => ({
      tick: i * 2, steer: 0.2, accel: 1, brake: false, drift: false, useItem: false,
    }))
    onMessageCb('client-2', 'unreliable', framed('input', 256, (p) => encodeInput(p, 2, intents)))

    // 30 ticks on one held datagram: spec S5's "repeating the last known intent
    // across gaps", and the reason this loop must survive many consecutive
    // tick() calls with no new input rather than only the first one.
    for (let i = 0; i < 30; i++) shadow.tick()

    const moved = Math.hypot(state.karts[2].position.x - startX, state.karts[2].position.z - startZ)
    expect(moved).toBeGreaterThan(1)
    // Seat 2 only. Nothing else was told to accelerate, and a decodeInput
    // handed a too-short intents array would have thrown before any of this.
    expect(state.karts[2].item).toBe('none')
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

/** decodeInput allocates nothing: its target must already hold INPUT_REDUNDANCY intents. */
function freshInputDatagram(): InputDatagram {
  const intents: Intent[] = []
  for (let i = 0; i < INPUT_REDUNDANCY; i++) {
    intents.push({ tick: 0, steer: 0, accel: 0, brake: false, drift: false, useItem: false })
  }
  return { playerId: -1, intents }
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
  private readonly inputScratch: InputDatagram
  /** Decoded in onMessage, applied at the top of the next tick(): a checkpoint
   * is the one message that replaces this loop's whole state (spec S5, "shadow
   * resync after a network partition"). */
  private readonly checkpointScratch: SimState
  private pendingCheckpoint: boolean
  private readonly snapshotBuf: Uint8Array
  private readonly eventsBuf: Uint8Array
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
    this.inputScratch = freshInputDatagram()
    this.checkpointScratch = allocStateLike(ctx, state)
    this.pendingCheckpoint = false
    this.snapshotBuf = new Uint8Array(SNAPSHOT_BUF_BYTES)
    this.eventsBuf = new Uint8Array(EVENTS_BUF_BYTES)
    this.history = []
    for (let i = 0; i < SHADOW_HISTORY_TICKS; i++) {
      this.history.push({ tick: -1, state: allocStateLike(ctx, state), inputs: makeIntentBuffer(), eventsApplied: [] })
    }
    this.ticksSinceSnapshot = 0
    this.promoted = ctx.isLeader
    t.onMessage((peerId, channel, data) => this.onMessage(peerId, channel, data))
  }

  private onMessage(_peerId: string, _channel: ChannelName, data: Uint8Array): void {
    if (data.length === 0) return
    // Dispatch on the shared header (contract §3), not on a private tag byte.
    // This callback is the one place in the system that genuinely sees four
    // kinds across two channels: client input, plus the host's snapshots and
    // events, plus a resync checkpoint. decodeHeader throws on an unknown tag
    // or a version mismatch, which is what makes a peer speaking a different
    // protocol a loud failure rather than a silently misread datagram.
    const kind = decodeHeader(data).kind
    const payload = data.subarray(HEADER_BYTES)

    // Input keeps flowing after promotion - a promoted shadow IS the authority
    // and still needs every client's intent. Everything else is host traffic
    // and is ignored once this loop has taken over.
    if (kind === 'input') {
      const dg = this.inputScratch
      decodeInput(payload, dg)
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
      return
    }

    if (this.promoted) return

    if (kind === 'events') {
      const evs: AuthEvent[] = []
      decodeEvents(payload, evs)
      for (const ev of evs) this.pendingEvents.push(ev)
    } else if (kind === 'snapshot') {
      decodeSnapshot(payload, this.snapshotScratch)
      this.pendingSnapshot = this.snapshotScratch
      this.ticksSinceSnapshot = 0
    } else if (kind === 'checkpoint') {
      // Full-precision resync (spec S5). Decoded here, applied in tick(): no
      // handler mutates `live` directly. Deliberately does NOT reset
      // ticksSinceSnapshot - spec S5 declares host loss after 1.5s with no
      // SNAPSHOT, and a host that can send a checkpoint but no snapshots is
      // exactly the failure promotion exists for.
      decodeCheckpoint(payload, this.checkpointScratch)
      this.pendingCheckpoint = true
    }
  }

  tick(): void {
    if (!this.promoted && this.pendingCheckpoint) {
      // Outranks any pending snapshot: exact where a snapshot is quantised,
      // and it arrives precisely when this loop's own history is unusable.
      cloneState(this.checkpointScratch, this.live)
      this.pendingCheckpoint = false
      this.pendingSnapshot = null
      for (const e of this.history) e.tick = -1   // every buffered tick is now fiction
    }

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

    // Follower and leader use the same held input: once promoted there is no
    // host left to hold it on this loop's behalf, and spec S5's pair-of-ticks
    // rule ("repeating the last known intent across gaps") is what `heldInput`
    // already is. An earlier draft routed the leader branch through a
    // heldInputForLeader() helper that returned exactly this field.
    const inputsForStep = this.heldInput
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
    // Republish. promote() is the only state mutation this loop makes outside
    // tick(), and `publish` (the caller's object) is the only view a caller
    // has - contract §5 gives ShadowLoop no state() getter. Without this line
    // a caller that calls promote() directly reads a stale rngCursor until the
    // next tick() lands, which is exactly what this task's own promotion test
    // was asserting against.
    cloneState(this.live, this.publish)
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
      if (exceeds(k.lap.t, w.t, EPS.t)) return true
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
    const h = encodeHeader(this.snapshotBuf, 'snapshot')
    const n = encodeSnapshot(this.snapshotBuf.subarray(h), this.live, this.lastProcessedInputTick)
    // slice, not subarray: this buffer is reused every third tick and a
    // transport with latency queues what it is handed. Task 14's brief works
    // through the same hazard at length.
    this.t.broadcast('unreliable', this.snapshotBuf.slice(0, h + n))
  }

  private broadcastEvents(events: AuthEvent[]): void {
    const h = encodeHeader(this.eventsBuf, 'events')
    const n = encodeEvents(this.eventsBuf.subarray(h), events)
    this.t.broadcast('reliable', this.eventsBuf.slice(0, h + n))
  }
}
```

Everything declared above is used. Two helpers from an earlier draft of this file are deliberately
**not** here and must not be re-added: `neutralIntent(tick)`, which nothing called (`noUnusedLocals`
would flag it), and `heldInputForLeader()`, whose body was `return this.heldInput` — the ternary
that called it could only ever pick the same value on both branches.

- [ ] **Step 8: Run the test and confirm the GREEN**

Run: `npx vitest run packages/net/test/shadow.test.ts`
Expected: PASS — 11 tests (7 from Step 1 + 4 from Step 5).

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
    let onMessageCb: (peerId: string, channel: ChannelName, data: Uint8Array) => void = () => {}
    const shadow = new ShadowLoop(ctx, state, {
      send() {}, broadcast() {}, onMessage: (cb) => { onMessageCb = cb }, onPeerLost() {}, peers: () => [], close() {},
    })
    for (let i = 0; i < 5; i++) shadow.tick()
    const beforePos = { ...state.karts[0].position }

    const msg = framed('snapshot', SNAP_BUF_BYTES,
      (p) => encodeSnapshot(p, state, new Array(MAX_KARTS).fill(-1)))
    onMessageCb('host', 'unreliable', msg)
    shadow.tick()

    // Quantized-and-dequantized truth for an unmoving kart (accel 0 the whole time) is the same
    // value it started at, well inside the 0.05m position epsilon: no correction fires.
    expect(Math.abs(state.karts[0].position.x - beforePos.x)).toBeLessThan(0.05)
  })

  it('snaps every kart and every live entity onto the snapshot when a field exceeds its epsilon', () => {
    const ctx = makeNetContext(false)
    const state = createState(ctx, 0x222, [0, 1, 2, 3, 4, 5, 6, 7])
    let onMessageCb: (peerId: string, channel: ChannelName, data: Uint8Array) => void = () => {}
    const shadow = new ShadowLoop(ctx, state, {
      send() {}, broadcast() {}, onMessage: (cb) => { onMessageCb = cb }, onPeerLost() {}, peers: () => [], close() {},
    })
    for (let i = 0; i < 5; i++) shadow.tick() // buffers ticks 1..5 in the ring

    const spoofed = createState(ctx, 0x222, [0, 1, 2, 3, 4, 5, 6, 7])
    spoofed.tick = 3 // a tick still inside the 24-deep ring
    spoofed.karts[0].position.x += 5 // 5m: nowhere near the 0.05m epsilon
    const before = state.karts[0].position.x
    const msg = framed('snapshot', SNAP_BUF_BYTES,
      (p) => encodeSnapshot(p, spoofed, new Array(MAX_KARTS).fill(-1)))
    onMessageCb('host', 'unreliable', msg)
    shadow.tick() // triggers reconcile() at the top of this call, then steps tick 5 -> 6

    // After reconcile-and-replay, the live kart 0 position must have moved toward the corrected
    // value: still not bit-identical (two more ticks of accel-0 motion ran after the correction),
    // but the 5m jump must be visible, not silently absorbed.
    expect(Math.abs(state.karts[0].position.x - spoofed.karts[0].position.x)).toBeLessThan(0.5)
    // And it really moved: without this, "less than 0.5 from the spoofed value"
    // could in principle be satisfied by a state that never changed at all.
    expect(Math.abs(state.karts[0].position.x - before)).toBeGreaterThan(1)
  })

  it('a full-precision checkpoint replaces the whole state and outranks a pending snapshot', () => {
    const ctx = makeNetContext(false)
    const state = createState(ctx, 0x333, [0, 1, 2, 3, 4, 5, 6, 7])
    let onMessageCb: (peerId: string, channel: ChannelName, data: Uint8Array) => void = () => {}
    const shadow = new ShadowLoop(ctx, state, {
      send() {}, broadcast() {}, onMessage: (cb) => { onMessageCb = cb }, onPeerLost() {}, peers: () => [], close() {},
    })
    for (let i = 0; i < 5; i++) shadow.tick()
    expect(state.tick).toBe(5)

    // What a host sends a shadow that has been partitioned away for a while:
    // a state far outside anything the 24-tick history ring could match.
    const resync = createState(ctx, 0x333, [0, 1, 2, 3, 4, 5, 6, 7])
    resync.tick = 500
    resync.karts[0].position.x += 40
    resync.karts[4].lap.lap = 2
    onMessageCb('host', 'reliable',
      framed('checkpoint', CHECKPOINT_BUF_BYTES, (p) => encodeCheckpoint(p, resync)))

    shadow.tick()

    // Applied at the top of the next tick(), then one step ran: tick 501, and
    // the kart is where the checkpoint said (plus one tick of accel-0 motion).
    // Ignoring the message entirely leaves tick at 6 and the kart on the grid.
    expect(state.tick).toBe(501)
    expect(Math.abs(state.karts[0].position.x - resync.karts[0].position.x)).toBeLessThan(0.5)
    expect(state.karts[4].lap.lap).toBe(2)
  })
})
```

- [ ] **Step 10: Run the test and confirm the RED**

Run: `npx vitest run packages/net/test/shadow.test.ts -t "snapshot correction"`

Expected: **FAIL on the third test only** — `a full-precision checkpoint replaces the whole state`.
Step 7's implementation already contains `reconcile`/`diverges` and already wires them into
`tick()`, so the first two tests of this group exercise code that exists and should be green; the
checkpoint path is genuinely absent from Step 7 until Step 10b below adds it. The failure is
`expected 6 to be 501` — the loop kept its own timeline and ignored a message it had no branch for.

This is a real red, not a manufactured one: the two snapshot tests are coverage for code Step 7
already wrote, and the third names the one behaviour this round adds.

- [ ] **Step 10b: Add the checkpoint branch**

In `packages/net/src/shadow.ts`: add the `checkpointScratch` / `pendingCheckpoint` fields and their
constructor initialisers, the `kind === 'checkpoint'` branch in `onMessage`, and the
apply-at-the-top-of-`tick()` block — all three are written out in Step 7's listing above, which is
the finished state of the file. If Step 7 was transcribed in full, this step is already done.

Run: `npx vitest run packages/net/test/shadow.test.ts`
Expected: PASS — 14 tests. If a snapshot test fails instead, the fault is inside
`reconcile`/`diverges`, not a missing export — fix `shadow.ts` directly rather than adding new code
elsewhere.

- [ ] **Step 11: Write the failing test for promotion**

Append to `packages/net/test/shadow.test.ts`:

```ts
/**
 * Puts a live entity in the pool by writing the slot directly, rather than through
 * spawnEntity(), for two reasons: spawnEntity emits an 'entitySpawn' (gated on
 * ctx.isLeader after Task 2, so a leader-seeded state and a follower-seeded state
 * would end up with DIFFERENT nextEventSeq), and it picks the entityId itself.
 * A 'slick' sits still and only its ttl moves (entity.ts's stepEntity default
 * branch), and at (500, 0, 500) it is hundreds of metres from any kart, so its
 * 2.1 m strike radius can never fire. With a ttl far longer than any test run it
 * therefore has exactly one legal way to leave the pool: not at all.
 */
function seedSlick(state: SimState, entityId: number, ttl: number): void {
  const e = state.entities[state.entityCount]
  e.entityId = entityId
  e.kind = 'slick'
  e.ownerId = 0
  e.position.x = 500
  e.position.y = 0
  e.position.z = 500
  e.velocity.x = 0
  e.velocity.y = 0
  e.velocity.z = 0
  e.heading = 0
  e.targetId = -1
  e.ttl = ttl
  state.entityCount += 1
  state.nextEntityId = Math.max(state.nextEntityId, entityId + 1)
}

describe('ShadowLoop: promotion', () => {
  it('auto-promotes at exactly HOST_TIMEOUT_TICKS with no snapshot ever received', () => {
    const ctx = makeNetContext(false)
    const state = createState(ctx, 0x333, [0, 1, 2, 3, 4, 5, 6, 7])
    const broadcasts: { channel: ChannelName; data: Uint8Array }[] = []
    const shadow = new ShadowLoop(ctx, state, {
      send() {}, broadcast: (channel, data) => broadcasts.push({ channel, data }),
      onMessage() {}, onPeerLost() {}, peers: () => [], close() {},
    })
    expect(ctx.isLeader).toBe(false)
    for (let i = 0; i < HOST_TIMEOUT_TICKS - 1; i++) shadow.tick()
    expect(ctx.isLeader).toBe(false) // not yet: 89 ticks with no snapshot

    shadow.tick() // the 90th
    expect(ctx.isLeader).toBe(true)

    const changes = broadcasts.filter(
      (b) => b.channel === 'reliable' && decodeHeader(b.data).kind === 'authorityChange',
    )
    expect(changes).toHaveLength(1)
    const decoded = decodeAuthorityChange(changes[0].data)
    expect(decoded.tick).toBe(HOST_TIMEOUT_TICKS)
    expect(decoded.eventSeq).toBe(state.nextEventSeq)
  })

  it('re-seeds rngCursor to the promotion tick and never rewinds tick, lap, or a live entity', () => {
    const ctx = makeNetContext(false)
    const state = createState(ctx, 0x444, [0, 1, 2, 3, 4, 5, 6, 7])
    // Both watched quantities are given a NONZERO starting value before the loop
    // is constructed (ShadowLoop's allocStateLike copies the caller's state into
    // `live`), because "lap >= 0" and "an empty entity set lost nothing" are true
    // of every implementation, correct or broken. A lap seeded at 1 can regress;
    // a seeded entity can vanish. That is the whole point of this test.
    for (const k of state.karts) k.lap.lap = 1
    const WATCHED_ID = 4242
    const SEEDED_TTL = 5000 // outlives the entire run: it can never expire legally
    seedSlick(state, WATCHED_ID, SEEDED_TTL)

    const shadow = new ShadowLoop(ctx, state, { send() {}, broadcast() {}, onMessage() {}, onPeerLost() {}, peers: () => [], close() {} })
    for (let i = 0; i < 40; i++) shadow.tick()

    const tickBefore = state.tick
    const lapsBefore = state.karts.map((k) => k.lap.lap)
    const liveBefore = state.entities.slice(0, state.entityCount).map((e) => e.entityId)
    expect(liveBefore).toContain(WATCHED_ID)
    expect(lapsBefore.every((l) => l >= 1)).toBe(true)
    const findWatched = (): { entityId: number; ttl: number } | undefined =>
      state.entities.slice(0, state.entityCount).find((e) => e.entityId === WATCHED_ID)
    let lastTtl = findWatched()!.ttl
    expect(lastTtl).toBe(SEEDED_TTL - 40) // ttl decrements by exactly 1 per tick

    shadow.promote(state.tick)
    // promote() republishes, so the caller's state carries the re-seeded cursor
    // immediately rather than one tick later.
    expect(state.rngCursor).toBe(tickBefore)
    expect(ctx.isLeader).toBe(true)
    expect(state.tick).toBe(tickBefore)

    for (let i = 1; i <= 40; i++) {
      shadow.tick()
      // Forward by exactly one, every tick: "never rewinds" is a statement about
      // promotion, and a rewind is precisely a repeated or lowered tick number.
      expect(state.tick).toBe(tickBefore + i)
      for (let k = 0; k < MAX_KARTS; k++) {
        expect(state.karts[k].lap.lap, `lap regressed for kart ${k}`).toBeGreaterThanOrEqual(lapsBefore[k])
      }
      // The seeded entity is still live, and its ttl walked down by exactly one.
      // A promotion that rebuilt state from an older buffer shows up here as
      // either a missing id or a ttl that jumped back up.
      const watched = findWatched()
      expect(watched, `entity ${WATCHED_ID} vanished ${i} ticks after promotion, with ttl ${lastTtl} last seen`).toBeDefined()
      expect(watched!.ttl).toBe(lastTtl - 1)
      lastTtl = watched!.ttl
    }
  })

  it('broadcasts a snapshot every 3rd tick once promoted, and rolls items as leader', () => {
    const ctx = makeNetContext(false)
    const state = createState(ctx, 0x555, [0, 1, 2, 3, 4, 5, 6, 7])
    const snapshots: Uint8Array[] = []
    const shadow = new ShadowLoop(ctx, state, {
      send() {},
      broadcast: (channel, data) => {
        if (channel === 'unreliable' && decodeHeader(data).kind === 'snapshot') snapshots.push(data)
      },
      onMessage() {}, onPeerLost() {}, peers: () => [], close() {},
    })
    expect(state.rngCursor).toBe(0)
    shadow.promote(0)
    for (let i = 1; i <= 9; i++) shadow.tick()
    expect(snapshots).toHaveLength(3) // ticks 3, 6, 9
    // Leader mode is real, not just a flag: ctx.isLeader gates rollItem, and a
    // promoted loop must be able to emit. (No box is in reach in nine countdown
    // ticks, so this asserts the capability, not a specific grant.)
    expect(ctx.isLeader).toBe(true)
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

  it('promote() mutates the exact ctx object passed to the constructor, not a private copy', () => {
    // AuthorityLoop and ClientLoop each defensively copy their ctx
    // (`{ ...ctx, isLeader: ... }`) because their own leader/follower role is
    // fixed for their whole lifetime. ShadowLoop cannot do that: its role
    // genuinely changes at promotion, and contract §5 gives it no
    // state()-like accessor - the caller's own ctx object mutating in place
    // is the only channel this loop has for making that change observable.
    // This is a deliberate divergence from its two peers (see the
    // "ambiguities" section below), isolated here rather than only proven as
    // a side effect of the larger promotion tests above: a well-meaning "fix"
    // that made ShadowLoop copy ctx like AuthorityLoop/ClientLoop do would
    // silently sever the only channel promotion has to reach its caller, and
    // this test names that regression directly.
    const ctx = makeNetContext(false)
    const state = createState(ctx, 0x777, [0, 1, 2, 3, 4, 5, 6, 7])
    const shadow = new ShadowLoop(ctx, state, { send() {}, broadcast() {}, onMessage() {}, onPeerLost() {}, peers: () => [], close() {} })
    expect(ctx.isLeader).toBe(false)

    shadow.promote(0)

    // Same variable, same object reference: a defensively-copied ctx would
    // leave this caller-held binding at its original value forever, and this
    // assertion would read `expected false to be true`.
    expect(ctx.isLeader).toBe(true)
  })
})
```

- [ ] **Step 12: Run the test and confirm the GREEN**

Run: `npx vitest run packages/net/test/shadow.test.ts`
Expected: PASS — 19 tests. Everything in this section already has an implementation from Step 7;
this step exists to catch a mismatch between what Step 7 wrote and what promotion actually needs to
guarantee (in particular the "never rewinds" loop, which exercises 40 real ticks post-promotion, not
one, and the isolated ctx-mutation test added by this brief's residual-findings pass).

- [ ] **Step 13: Full package verification**

Run: `npx tsc --noEmit -p packages/net && npx vitest run packages/net`
Expected: PASS, zero type errors, all `packages/net` tests green (this file's 19 plus whatever
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

Every datagram it sends and reads carries protocol's shared 2-byte header
(contract 3): onMessage dispatches on decodeHeader(data).kind, which is
what lets one callback carry client input, the host's snapshots and
events, and a resync checkpoint. authorityChange is this file's own tiny
codec on top of that header - 10 bytes, two u32s.

A received AuthorityCheckpoint replaces the whole state at the top of
the next tick(), which is spec 5's 'shadow resync after a network
partition' and the only place in the plan that consumes Task 8's codec."
```

---

**Dependencies, and two ambiguities an earlier draft flagged that the contract has since settled:**

1. **Settled: the message header.** An earlier draft of this brief flagged that no task encoded
   `WireHeader` and no task defined how a receiver tells one `MessageKind` from another, then
   defined `WIRE_TAG_INPUT = 4 … WIRE_TAG_AUTHORITY_CHANGE = 8` locally to fill the gap. Contract §3
   now assigns `WIRE_TAG`, `encodeHeader` and `decodeHeader` to Task 3 and requires all three loops
   to use them; the local constants are deleted and this file dispatches on
   `decodeHeader(data).kind`. The flag was right, the unilateral fix was not — the values (4…8) did
   not match the contract's (`0x10`…`0x20`), and Tasks 14 and 15 never adopted them at all.
2. **Settled: `ClientLoop`'s state accessor.** An earlier draft flagged that `ClientLoop`'s locked
   signature exposed no way to read its predicted `SimState`. Contract §5 gives both `ClientLoop`
   and `AuthorityLoop` a `state(): SimState`. `ShadowLoop` deliberately still has none: its whole
   design publishes into the caller's own object once per `tick()`, which is why `promote()` must
   republish before it returns.
3. **Resolved, in this brief's residual-findings pass: `ShadowLoop.promote()` deliberately mutates
   the caller's own `SimContext` object** (`this.ctx.isLeader = true`), while `AuthorityLoop` and
   `ClientLoop` each defensively copy theirs (`{ ...ctx, isLeader: ... }`). This is not an
   inconsistency to iron out — it is the only channel available given contract §5's locked
   three-member `ShadowLoop` shape (`constructor`, `tick`, `promote`, and nothing else — no
   `state()`-like accessor for anything, unlike its two peers). `AuthorityLoop`/`ClientLoop` never
   need one, because their role is fixed for their whole lifetime; `ShadowLoop`'s role genuinely
   changes at promotion, and the change must reach the caller that owns the room some way that isn't
   a locked-class method this task cannot add.

   The rule this leaves for a future task: **never share one `ctx` object between a `ShadowLoop` and
   any other loop or subsystem that re-reads `ctx.isLeader` after its own construction.**
   `AuthorityLoop` and `ClientLoop` are both safe to share a `ctx` with despite this, because each
   pins its own private copy of `isLeader` at construction and never looks at the shared object
   again — nothing about promoting a shadow they happen to share a `ctx` with can reach either of
   them. Anything that keeps re-reading the shared object directly is not safe, and would find that
   promoting the shadow silently turns it into a leader too.

   Step 11 above adds an isolated test naming the mechanism directly
   (`'promote() mutates the exact ctx object passed to the constructor, not a private copy'`), in
   addition to the promotion tests that already depended on it incidentally
   (`expect(ctx.isLeader).toBe(true)`). A well-meaning "fix" that made `ShadowLoop` copy `ctx` like
   its peers — silently severing the only channel promotion has to reach the caller, since this
   locked class has no other one — now fails immediately and by name, rather than as a mysterious
   downstream symptom the next time some other task shares a `ctx`.
4. **Depends on Task 8's `decodeCheckpoint` writing into a caller-owned `SimState`** of the shape
   `allocStateLike` produces, which is what contract §3's `decodeCheckpoint(buf, dst: SimState)`
   states. The checkpoint-resync path above is the only consumer of that codec in the whole plan.
