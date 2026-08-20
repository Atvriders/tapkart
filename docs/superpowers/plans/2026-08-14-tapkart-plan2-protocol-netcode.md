# Tapkart Plan 2 — Protocol and Netcode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `@tapkart/protocol` and `@tapkart/net` — the bit-packed wire format and the three loops (authority, client, shadow) that turn Plan 1's pure simulation into an eight-player networked race with client-side prediction, reconciliation, and host migration.

**Architecture:** `protocol` is a pure codec package: message types, a bit-level reader/writer, a lossy quantised `WireSnapshot` for the 20 Hz unreliable stream, a full-precision `AuthorityCheckpoint` for late join and resync, plus event and input datagrams. It has no clock and no I/O. `net` layers three loops over one `Transport` interface with two channels — unreliable-unordered for input and snapshots, reliable-ordered for events, checkpoints and lobby state — so nothing above the transport knows whether it is speaking WebRTC, WebSocket or an in-process loopback. The server runs a **shadow authority** per room: it simulates in lockstep from the same inputs, never rolls items, and is promoted on host loss without a rewind.

**Tech Stack:** TypeScript 5.9 (strict, `moduleResolution: Bundler`, `verbatimModuleSyntax`), Node 20, vitest 3, npm workspaces. No runtime dependencies in either package.

**Spec:** [`docs/superpowers/specs/2026-08-13-tapkart-design.md`](../specs/2026-08-13-tapkart-design.md) — §5 in full, plus §8's netcode tests.

**Builds on:** Plan 1, merged at `1f1f2c4` — `@tapkart/sim`, 19 modules, 477 tests.

**Plan sequence:** This is Plan 2 of 5. Plan 1 = simulation core (done); Plan 3 = render + game shell; Plan 4 = server, lobby, WebRTC signalling; Plan 5 = APK, NFC/HCE, App Links, CI/deploy. Each produces working, testable software on its own.

---

## How this plan came to be, and what that means for executing it

Plan 1's whole-branch review found three conflicts between shipped code and the
spec. All three are settled — in the **spec**, not just here — and Tasks 1 and 2
implement two of them before `protocol` or `net` exist, because they change
`SimState` and every later task depends on its final shape.

The contract in Global Constraints below was written **before** any task text, and
then amended twelve times during authoring, every time because an author verified
a premise against real code rather than assuming. Two of those amendments fixed
contradictions inside the contract itself. Three adversarial audits then found
~30 blocking defects and 13 spec-coverage gaps across the eighteen briefs, and a
fix round addressed them.

Two things follow for whoever executes this:

**The contract wins over any task brief.** Where they disagree, the brief is
stale. Where the contract and the spec disagree, stop and ask — do not choose.

**Verify premises, not just anchors.** Plan 1 shipped six real defects that three
audit rounds all passed, and every one came from a premise: a task's *claim about
another task's behaviour* that happened to be false. The rounds checked that
quoted "Before" text existed — a syntactic question — and never checked whether a
behavioural claim was true. When a brief tells you something about code it does
not own, open that file.

Two habits that repeatedly caught real defects here, worth keeping:

- **A test that cannot fail is worse than no test.** This plan's audits found
  eight, including one that compared a value to itself and one whose loop body was
  a comment — and they were the entire implementation of two of spec §8's four
  promotion assertions. For any test you write or touch, answer: *how would this
  fail if the code were broken?*
- **Anything stateful across ticks must be tested across ticks.** Plan 1 shipped a
  function that was broken from its second consecutive call while every test
  called it once. `ClientLoop`, `AuthorityLoop` and `ShadowLoop` are all
  tick-stateful.

---

## Global Constraints

> absent must define it in its own files and say so in its `Interfaces` block.

**Spec:** `docs/superpowers/specs/2026-08-13-tapkart-design.md` (amended 2026-08-14)
**Builds on:** Plan 1, merged at `1f1f2c4` — `@tapkart/sim`, 19 modules, 477 tests.

---

## 0. Conventions that are decided, not negotiable

Plan 1's conventions carry forward unchanged and are **not** restated here except
where Plan 2 adds to them. In particular: `forward = (cos h, 0, sin h)`;
`right = (-t.z, 0, t.x)` normalised; positive `lateral` is right of travel; up is
`+y`; headings wrapped to `(-π, π]`; **track parameter `s` is arc-normalised
`[0, 1)`, never metres**; extensionless imports; `import type` under
`verbatimModuleSyntax`; vitest with `globals: false`.

New for Plan 2:

| Convention | Value |
|---|---|
| Byte order on the wire | **little-endian**, everywhere, no exceptions |
| Bit packing order | LSB-first within each byte; fields written in table order |
| Wire buffers | `Uint8Array` views over a caller-owned `ArrayBuffer`; codecs never allocate |
| Integer fields | quantised **exactly** — encode is lossless, epsilon is `0`, compare with `Object.is` |
| Continuous fields | quantised lossily; every one has a **step** and an **epsilon**, and `epsilon > step` |
| Time | ticks only. No `Date.now()` anywhere in `protocol`; `net` reads the clock **only** in transports and loop schedulers, never in codecs or reconciliation |
| Channel names | `'unreliable'` and `'reliable'` — those exact strings |
| A follower never emits | `emit()` is gated on `ctx.isLeader` at **all** call sites; a follower's `nextEventSeq` is advanced only by applying received events |

**The single most error-prone thing in this package is the epsilon/step
relationship.** Spec §5: *"Each epsilon is derived from, and must exceed, that
field's quantization step — otherwise quantization noise alone triggers a
correction every single snapshot and the kart visibly buzzes."* Every epsilon in
§4 below is stated together with the step it must exceed, and Task 7 asserts the
inequality for every field mechanically. Do not tune an epsilon downward to make
a test pass; that test is the one protecting the player from a buzzing kart.

---

## 1. Amendments to Plan 1 — done first, in Tasks 1 and 2

Plan 1's whole-branch review found three conflicts between the shipped code and
the spec. All three are settled in the spec (amended 2026-08-14) and are
implemented here, **before** `protocol` or `net` exist, because two of them
change `SimState` and every later task depends on its final shape.

### 1a. The bot hold moves into `SimState` *(Task 1)*

`packages/sim/src/phase.ts` holds the 30 Hz bot-input hold at module scope. It is
the only mutable binding in `@tapkart/sim` that survives a call, so it belongs to
the process rather than to a state — two rooms in one Node process drive each
other's bots, measured at 3 cm of divergence after 40 ticks.

`SimState` gains exactly two fields, appended after `finishedOrder`:

```ts
  heldBotIntent: Intent[]   // always length MAX_KARTS
  heldBotTick: number[]     // always length MAX_KARTS, -1 = no held intent
```

`createState` initialises `heldBotIntent` to `MAX_KARTS` neutral intents and
`heldBotTick` to `MAX_KARTS` entries of `-1`. `cloneState` deep-copies both.
`statesEqual` compares both, every field, with `Object.is`, like everything else.

`resolveInputs` reads and writes `state.heldBotIntent` / `state.heldBotTick`
instead of the module-scope arrays. `makeIntentBuffer` is unchanged.
`resetBotHold` is **deleted** — it existed only to scrub process-global state, is
a process-wide side effect, and has no meaning once the hold is per-state.
`recordRun` and `replayRun` drop their `resetBotHold()` calls.

**`replayRun`'s checkpoint-parity `RangeError` guard is deleted in the same
task,** along with `needsOddCheckpoint`. With the hold inside the state,
`cloneState` carries it and every tick is a legal checkpoint. Task 1 replaces the
guard's three tests with one asserting the opposite: an **even**-tick checkpoint
with bot-driven karts now replays bit-identically.

### 1b. `emit()` is gated on `ctx.isLeader` at all eleven call sites *(Task 2)*

Plan 1 gates 3 of 11. A follower therefore advances `nextEventSeq` — a `SimState`
field that `statesEqual` compares and `AuthorityCheckpoint` carries — by a
different amount than the leader.

Every `emit()` call site takes an `isLeader` gate. A follower's simulation is
unchanged: spin-outs, respawns, lap crossings and entity lifecycle all still
*happen*; only their announcement is suppressed. The eleven sites are in
`recovery.ts` (spinOut, respawn), `laps.ts` (lapCross, finish), `entity.ts`
(entitySpawn, entityDespawn, hit ×2), `items.ts` (itemGrant), `phase.ts`
(finish ×2 — already gated).

Several of those functions do not currently receive `ctx`. Task 2 threads it.
Signatures that change are listed in §2a and **no other task may change them**.

### 1c. `WireSnapshot` carries three more kart fields *(reflected in §4)*

`boostTicks` (7 bits), `respawnTicks` (7 bits) and `shielded` (1 bit) join the
per-kart record; `characterIdx` deliberately does not (static, arrives at
character select). Entity `ttl` widens `u8 → u16` because `Tuning.entityTtl` is
600 and the old field maxed at 255.

---

## 2. Signatures Plan 1 exports that Plan 2 consumes

Unchanged from Plan 1 and used verbatim:

```ts
step(ctx: SimContext, prev: SimState, next: SimState, inputs: Intent[], events: AuthEvent[]): void
createState(ctx: SimContext, seed: number, characterIdx: number[]): SimState
cloneState(src: SimState, dst: SimState): void
statesEqual(a: SimState, b: SimState): boolean
buildTrackQuery(track: Track): TrackQuery
validateTrack(track: Track): string[]
```

### 2a. Signatures Task 2 changes, listed once

```ts
// packages/sim/src/recovery.ts
export function updateRecovery(ctx: SimContext, state: SimState, k: KartState, events: AuthEvent[]): void  // unchanged, already has ctx
// packages/sim/src/laps.ts
export function updateLaps(ctx: SimContext, state: SimState, k: KartState, events: AuthEvent[]): void      // unchanged, already has ctx
// packages/sim/src/entity.ts
export function spawnEntity(ctx: SimContext, state: SimState, kind: EntityKind, ownerId: number,
                            position: Vec3, heading: number, targetId: number,
                            ttl: number, events: AuthEvent[]): number                                       // CHANGED: ctx prepended
export function despawnEntityAt(ctx: SimContext, state: SimState, idx: number, events: AuthEvent[]): void   // CHANGED: ctx prepended
```

```ts
// packages/sim/src/recovery.ts
export function startSpinOut(ctx: SimContext, state: SimState, k: KartState,
                             ticks: number, events: AuthEvent[]): void        // CHANGED: ctx prepended, nothing else moved
```

`updateEntities`, `updateItemBoxes`, `useItem` and `updatePhase` already take
`ctx`. **Three** functions change shape, not two — an earlier draft of this
section said two and was wrong. `startSpinOut` emits the `'spinOut'` event named
in §1b's eleven-site list, has no `ctx` parameter, and has no path to one without
a signature change; it has exactly one caller in `src`, verified.

### 1d. Widening `SimState` reaches further than `state.ts` *(Task 1 scope)*

Adding two fields to `SimState` breaks compilation in **five test files that
hand-build `SimState` object literals** rather than calling `createState`:
`recovery.test.ts`, `collision.test.ts`, `entity.test.ts`, `laps.test.ts` and
`placement.test.ts`. Confirmed by an actual `tsc --noEmit` run — six `TS2739`
errors. Task 1 fixes all five; they are part of its scope, not a surprise for
whoever runs it.

`resetBotHold` also has call sites the §1a text did not name: `barrel.test.ts`
imports it, and `replay.test.ts` both calls it and contains a test whose entire
premise — that a module-scope hold can be poisoned across runs — **stops existing**
once the hold lives in `SimState`. That test is deleted rather than adapted; there
is nothing left for it to assert.

---

## 3. `packages/protocol` — module map and exact signatures

Zero dependencies except `@tapkart/sim` for its types. No DOM. No clock.

```ts
// packages/protocol/src/types.ts                              [Task 3]
export const PROTOCOL_VERSION = 1
export type ChannelName = 'unreliable' | 'reliable'

export type MessageKind =
  | 'hello' | 'welcome' | 'lobby' | 'start'
  | 'input' | 'snapshot' | 'events' | 'checkpoint'
  | 'authorityChange' | 'ping' | 'pong'

export interface WireHeader { kind: MessageKind; protocolVersion: number }

// Every datagram begins with this one byte. Without a shared tag a receiver
// cannot dispatch, and each of Tasks 11/14/15/16 would invent its own —
// which is exactly what happened when this was left unspecified.
export const WIRE_TAG = {
  hello: 0x01, welcome: 0x02, lobby: 0x03, start: 0x04,
  input: 0x10, snapshot: 0x11, events: 0x12, checkpoint: 0x13,
  authorityChange: 0x20, ping: 0x30, pong: 0x31,
} as const
export function encodeHeader(out: Uint8Array, kind: MessageKind): number  // bytes written (2: tag + version)
export function decodeHeader(buf: Uint8Array): WireHeader                 // throws on unknown tag or version mismatch

// packages/protocol/src/bits.ts                               [Task 4]
export class BitWriter {
  constructor(buf: Uint8Array)
  reset(): void
  writeBits(value: number, bits: number): void
  writeFloatQ(value: number, min: number, max: number, bits: number): void
  byteLength(): number
}
export class BitReader {
  constructor(buf: Uint8Array)
  reset(): void
  readBits(bits: number): number
  readFloatQ(min: number, max: number, bits: number): number
}

// packages/protocol/src/quant.ts                              [Task 5]
export interface QuantField { min: number; max: number; bits: number }
export interface QuantTable {
  position: QuantField; velocity: QuantField; heading: QuantField
  angularVelocity: QuantField; driftCharge: QuantField; t: QuantField
}
export interface EpsilonTable {
  position: number; velocity: number; heading: number
  angularVelocity: number; driftCharge: number; t: number
}
export const Q: QuantTable          // §4's table, frozen
export const EPS: EpsilonTable      // §4's table, frozen
export function quantStep(min: number, max: number, bits: number): number

// packages/protocol/src/snapshot.ts                           [Task 6]
export function encodeSnapshot(out: Uint8Array, state: SimState,
                               lastProcessedInputTick: number[]): number   // bytes written
export function decodeSnapshot(buf: Uint8Array, out: WireSnapshot): void
export function applySnapshotToState(snap: WireSnapshot, dst: SimState): void

// packages/protocol/src/checkpoint.ts                         [Task 8]
export function encodeCheckpoint(out: Uint8Array, state: SimState): number
export function decodeCheckpoint(buf: Uint8Array, dst: SimState): void

// packages/protocol/src/events.ts                             [Task 9]
export function encodeEvents(out: Uint8Array, events: AuthEvent[]): number
export function decodeEvents(buf: Uint8Array, out: AuthEvent[]): void

// packages/protocol/src/input.ts                              [Task 10]
export const INPUT_REDUNDANCY = 8
export function encodeInput(out: Uint8Array, playerId: number, intents: Intent[]): number
export function decodeInput(buf: Uint8Array, out: InputDatagram): void

// packages/protocol/src/index.ts             [Task 3 creates, Task 18 widens]
```

**The barrel exists from Task 3, not Task 18.** Task 3's scaffold creates
`packages/protocol/src/index.ts` already re-exporting `./types`, exactly as Plan
1's Task 2 did for `@tapkart/sim`; Task 18 widens it to every module and adds the
no-ambiguous-export test. This matters because `net` needs `ChannelName` from
Task 11 onward, and the alternative — reaching across with a relative path like
`'../../protocol/src/types'` — punches through the package boundary, bypasses the
`exports` map, and would survive into Plan 3. **`net` imports `@tapkart/protocol`,
always.** The same applies to `packages/net/src/index.ts`: Task 11's scaffold
creates it re-exporting `./transport`, Task 18 widens it.

### RED steps for a types-only module need `tsc`, not vitest

Established empirically in this repo, not assumed: a missing *runtime* export
surfaces under Vitest as `TypeError: (0 , x) is not a function`, and a missing
module as `Cannot find module` — but a **type-only** import of a missing module
**silently passes**, because `verbatimModuleSyntax` erases it before resolution.

So for a module with zero runtime code — `protocol/src/types.ts` (Task 3) and
`net/src/transport.ts` (Task 11) are both pure interface files — a vitest RED is
*vacuous*: it passes whether or not the file exists. Those tasks must take their
RED from `npm run typecheck` and expect **`TS2307: Cannot find module`**. A task
that "proves" a types-only RED with a green vitest run has proved nothing, which
is the same failure mode that let two of Plan 1's control tests ship.

`WireSnapshot` and `InputDatagram` are **decode targets, not `SimState`** — they
are the lossy projection. Spec §3 is explicit that conflating them was the single
biggest defect found in the original design review:

```ts
export interface WireKart {
  playerId: number; position: Vec3; velocity: Vec3; heading: number
  angularVelocity: number; driftCharge: number; driftActive: boolean
  driftDir: -1 | 0 | 1; airborne: boolean; surface: Surface
  spinOutTicks: number; invulnTicks: number; item: ItemKind
  lap: number; checkpointIdx: number; t: number
  isBot: boolean; connected: boolean
  boostTicks: number; respawnTicks: number; shielded: boolean
}
export interface WireEntity {
  entityId: number; kind: EntityKind; ownerId: number
  position: Vec3; velocity: Vec3; heading: number; ttl: number
}
export interface WireSnapshot {
  tick: number; eventSeq: number
  lastProcessedInputTick: number[]      // length MAX_KARTS
  karts: WireKart[]                     // length MAX_KARTS
  entities: WireEntity[]                // length MAX_ENTITIES, live packed at front
  entityCount: number
}
export interface InputDatagram {
  playerId: number; intents: Intent[]   // length INPUT_REDUNDANCY, newest last
}
```

---

## 4. The quantisation and epsilon table — the heart of this plan

World bounds are `±WORLD_HALF = 1024` m, which encloses every shipped track with
margin (the largest generated track spans x ∈ [-82, 722]).

**Steps below are `quantStep(min, max, bits) = (max - min) / ((1 << bits) - 1)`,
computed, not rounded.** An earlier draft of this table divided by `1 << bits`
and was wrong in the fourth decimal for several rows. The code always derives the
step through `quantStep`, so the arithmetic never mattered to behaviour — but a
reader who "fixed" the formula to match the wrong prose would break every one of
them at once. Every epsilon still clears its corrected step with margin.

| Field | Range | Bits | Step | Epsilon | Compared as |
|---|---|---|---|---|---|
| `position.{x,y,z}` | ±1024 | 16 | 0.0312548 m | **0.05 m** | band |
| `velocity.{x,y,z}` | ±64 | 12 | 0.0312576 m/s | **0.05 m/s** | band |
| `heading` | (-π, π] | 12 | 0.0015343 rad | **0.0025 rad** | shortest signed angle |
| `angularVelocity` | ±16 | 10 | 0.0312805 rad/s | **0.05 rad/s** | band |
| `driftCharge` | 0..255 | 8 | 1.0 | **1.5** | band |
| `lap.t` | [0, 1) | 10 | 0.0009775 | **0.002** | band |
| `spinOutTicks` | 0..255 | 8 | exact | **0** | `Object.is` |
| `invulnTicks` | 0..255 | 8 | exact | **0** | `Object.is` |
| `boostTicks` | 0..127 | 7 | exact | **0** | `Object.is` |
| `respawnTicks` | 0..127 | 7 | exact | **0** | `Object.is` |
| `lap` | 0..7 | 3 | exact | **0** | `Object.is` |
| `checkpointIdx` | 0..63 | 6 | exact | **0** | `Object.is` |
| `item` | enum | 4 | exact | **0** | `Object.is` |
| `surface` | enum | 2 | exact | **0** | `Object.is` |
| `driftActive`+`driftDir` | — | 2 | exact | **0** | `Object.is` |
| `airborne` | — | 1 | exact | **0** | `Object.is` |
| `shielded` | — | 1 | exact | **0** | `Object.is` |
| `isBot` | — | 1 | exact | **0** | `Object.is` |
| `connected` | — | 1 | exact | **0** | `Object.is` |
| `playerId` | 0..7 | 3 | exact | **0** | `Object.is` |

Per-kart total: **178 bits**.

*`isBot` and `connected` get a bit each, deliberately.* An earlier draft implied
they shared one, which only works if `isBot === !connected` always holds. It
happens to hold in shipped Plan 1 code, but it is an *emergent* property of how
`createState` and the drop-handling path assign them, not an invariant anything
enforces — and spec §5 has a dropped client's kart "taken over by a bot" and then
"reclaim[ed] on reconnect", which is exactly the transition where the two could
legitimately disagree for a tick. One extra bit per kart is 8 bits per snapshot;
an implicit invariant that a future task can silently break is not worth that.

Entity record: `entityId u16`, `kind u4`, `ownerId u3`, `position 3×u16`,
`velocity 3×u12`, `heading u12`, `ttl u16` → **135 bits**.

*This is 135 bits, not the 13 B an earlier draft claimed.* The 13 B figure came
from spec §5's original entity record, which packed velocity **and** heading into
a single `u16`. That is incompatible with `WireEntity.velocity: Vec3` in §3,
which requires three independent components. Resolved in favour of the itemised
list and the locked type: entities are interpolated rather than predicted, and
real per-axis velocity is what makes that interpolation good. The cost is ~4 B
per live entity, capped at 32.

Header: `tick u32`, `eventSeq u32`, `lastProcessedInputTick 8×u16`,
`entityCount u8` → **200 bits**.

**The per-record byte figures are informational, not a padding rule.** The stream
is continuously bit-packed — `BitWriter`/`BitReader` expose no `align()` and none
is wanted. A record does not start on a byte boundary, and encoders must not
assume it does.

**Only the six continuous rows above appear in `Q` and `EPS`.** Every other row is
"exact": it carries no quantisation noise and therefore needs no epsilon — giving
one would invite someone to compare an integer with a tolerance. (An earlier draft
said "the eleven exact rows"; the count changed when `isBot` and `connected` were
split, so the number is deliberately not restated here — the rule is "not one of
the six above", not a tally that drifts.) They are compared
with `Object.is`, and `-0` is normalised to `+0` first. `QuantTable` deliberately
exposes raw `{min, max, bits}` rather than a precomputed `step`, so `quantStep`
can recompute it and Task 7's `epsilon > step` assertion is checking the
constants against each other rather than against a cached number that could drift.
The key is `t`, not `lap.t`, matching the flat `WireKart` interface in §3.

**Every epsilon strictly exceeds its step.** Task 7 asserts this field by field
against `Q` and `EPS` rather than trusting the table, because the table is prose
and the constants are code.

### 4a. `AuthEvent` wire layout *(Task 9 owns it; stated here so nothing else invents one)*

`AuthEvent` is `{ eventSeq, tick, kind, playerId, entityId, item, data }`. Two of
those fields are routinely **negative** and a naive unsigned packing loses them:
`playerId` is `-1` on the race-level `finish` that `updatePhase` emits, and
`entityId` is `-1` whenever an event is not about an entity. Both are therefore
encoded **biased by +1** — store `value + 1`, read back `value - 1` — so `-1`
travels as `0`. `data` must hold a `ttl` of up to `Tuning.entityTtl` (600), so it
is wider than a byte. Task 9 fixes the exact bit widths and asserts every one of
the eight `AuthEventKind`s round-trips including both `-1` cases.

**The steady-state invariant, spec §8:** at 150 ms latency, 50 ms jitter and 5%
loss, a converged client must take **zero** corrections from quantisation noise
alone. That test is what proves the epsilons are above the noise floor, and it is
the reason no epsilon may be tuned down.

---

## 5. `packages/net` — module map and exact signatures

```ts
// packages/net/src/transport.ts                               [Task 11]
export interface Transport {
  send(channel: ChannelName, peerId: string, data: Uint8Array): void
  broadcast(channel: ChannelName, data: Uint8Array): void
  onMessage(cb: (peerId: string, channel: ChannelName, data: Uint8Array) => void): void
  onPeerLost(cb: (peerId: string) => void): void
  peers(): string[]
  close(): void
}

// packages/net/src/loopback.ts                                [Task 12]
export interface LoopbackOptions { latencyMs: number; jitterMs: number; lossRate: number; seed: number }
export function makeLoopbackPair(opts: LoopbackOptions): { a: Transport; b: Transport; pump(nowMs: number): void }

// packages/net/src/apply.ts                                   [Task 13]
export function applyEvent(ctx: SimContext, state: SimState, ev: AuthEvent): boolean  // false if already applied

// packages/net/src/authority.ts                               [Task 14]
export class AuthorityLoop {
  constructor(ctx: SimContext, state: SimState, t: Transport)
  tick(): void              // reads client input off its own Transport; takes no input param
  state(): SimState         // read-only view, so the promotion test can compare authorities
}

// packages/net/src/client.ts                                  [Task 15]
export class ClientLoop {
  constructor(ctx: SimContext, playerId: number, t: Transport)
  tick(localIntent: Intent): void
  corrections(): number     // count, for the zero-corrections test
  state(): SimState         // read-only view; the convergence test asserts on it directly
}

// packages/net/src/shadow.ts                                  [Task 16]
export class ShadowLoop { constructor(ctx: SimContext, state: SimState, t: Transport); tick(): void; promote(tick: number): void }

// packages/net/src/index.ts                                   [Task 18]
```

### Which transports Plan 2 actually builds — resolved

Spec §3 lists three `Transport` implementations: `WebRTCTransport`,
`WebSocketTransport`, `LoopbackTransport`. **Plan 2 builds the interface and
Loopback only.** WebRTC and WebSocket land in **Plan 4**, alongside the signalling
endpoint, the room registry and the server that terminates them — they are
meaningless without a peer to connect to, and Plan 2 is specifically the part that
must be verifiable with no network at all.

This is not a gap in coverage; it is where the seam falls. Spec §8's netcode tests
are all written against `LoopbackTransport` precisely so convergence, the
zero-corrections invariant and promotion can be proven deterministically, in
process, with injected latency, jitter and loss. Nothing above the transport knows
which implementation it is speaking to, so Plan 4 adds two implementations and
changes no loop.

### The client sends input to both host and shadow — how, with one `Transport`

Spec §5: *"Every client sends its input to **both** the host and the server
shadow. That is 2 KB/s up per client, and it is what makes promotion
near-instant."* `ClientLoop` takes a single `Transport`, which looks like a
contradiction and is not.

`Transport.broadcast(channel, data)` sends to **every peer** the transport holds.
A client's transport holds two: the host and the shadow. So the dual-send is
`broadcast('unreliable', inputDatagram)` — one call, two recipients, and the loop
never needs to know which peer is which. `send(channel, peerId, data)` remains for
the cases that genuinely target one peer.

This is also why promotion needs no reconnection at the `ClientLoop` level: the
shadow was already a peer receiving every input, so promotion changes which peer
the client *listens* to, not who it talks to.

**Loopback determinism:** `LoopbackOptions.seed` exists because jitter and loss
must be reproducible. `makeLoopbackPair` draws from `rngAt(seed, cursor)` with
its own cursor — **never** `state.rngCursor`, which belongs to the leader's item
rolls. A transport that advanced the sim's cursor would desynchronise the shadow.

**Promotion, spec §5:** host loss is declared after **1.5 s with no snapshot**
(30 missed at 20 Hz). The shadow broadcasts `authorityChange {tick, eventSeq}`,
switches to leader mode, re-seeds its item PRNG from `(raceSeed, promotionTick)`,
and continues `eventSeq` from the highest observed. Because it has been ticking
in lockstep all along there is no rewind: no kart teleports back, no lap counter
regresses, no in-flight projectile vanishes. Post-promotion item rolls differ
from what the original host would have produced; §5 states that divergence is
unobservable and accepted.

---

## 6. Test fixtures — `packages/net/test/fixtures/net-fixtures.ts` [Task 12]

> **`@tapkart/sim`'s test fixtures are NOT importable from another package.**
> `makeTuning`, `makeCharacters`, `makeOvalTrack` and `makeContext` live under
> `packages/sim/test/`, which is outside the package's `exports` map — an import
> from `protocol` or `net` will not resolve. This was found by an author reading
> `packages/sim/package.json` rather than assuming, and it would otherwise have
> bitten every task in this plan that wants a `SimContext`.
>
> Plan 2 tasks therefore either build their `SimState`/`SimContext` by hand from
> the public barrel (`createState`, `buildTrackQuery`, and a locally-declared
> `Tuning`/`CharacterStats` transcribed from Plan 1 contract §3), or use
> `makeNetContext` below, which does exactly that once so eighteen tasks do not
> each re-transcribe the tuning table. **Do not "fix" this by widening
> `@tapkart/sim`'s exports to publish test fixtures** — shipping fixtures in the
> public surface is how they end up in the game bundle.

```ts
export function makeNetContext(isLeader?: boolean): SimContext   // makeOvalTrack + Plan 1 tuning
export function makeLossyPair(overrides?: Partial<LoopbackOptions>): ReturnType<typeof makeLoopbackPair>
```

Default `LoopbackOptions`: `{ latencyMs: 150, jitterMs: 50, lossRate: 0.05, seed: 0xC0FFEE }` —
the exact conditions spec §8 names for the convergence and zero-corrections tests.

---

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

Note: `npx tsc --noEmit -p packages/sim` will still report errors at this point (the five hand-built `SimState` literals in other test files, per the scope note above). That is expected and is fixed in Step 18. `npx vitest run packages/sim` stays green in the meantime — at this exact point in the task, only `types.ts` and `createState` (this step) have changed, and `cloneState`/`statesEqual`/`resolveInputs` do not read `heldBotIntent`/`heldBotTick` yet (Steps 7 and 11 add those reads), so nothing in the five hand-built-literal files can observe the missing fields at runtime yet. This stops being true once Step 7 lands — see Step 17's note below, which is the point two of those five files' own `step()`-calling tests start failing for real.

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

**`packages/sim/test/phase.test.ts`** — six edits.

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

**Two imports are now dead and must go in the same step**, or `tsc` fails later at Step 19 with `noUnusedLocals`/`noUnusedParameters` errors (`tsconfig.base.json`). `COUNTDOWN_TICKS` was used only by the deleted `'accepts an even checkpoint tick with bot-driven karts during countdown'` test (`expect(T).toBeLessThan(COUNTDOWN_TICKS)`, part of the `describe('replayRun checkpoint parity guard', ...)` block this step's earlier edit already replaced); `makeIntentBuffer` and `resolveInputs` (from `../src/phase`) were used only by the `'is independent of a bot hold left dirty by an earlier run'` test just deleted above. Neither has any other reference left in this file.

Before:

```ts
import { COUNTDOWN_TICKS, MAX_KARTS } from '../src/types'
```

After:

```ts
import { MAX_KARTS } from '../src/types'
```

Before:

```ts
import { makeIntentBuffer, resolveInputs } from '../src/phase'
```

After: delete this line entirely — nothing in the file calls either function anymore (Step 13 already removed `resetBotHold` from this same import).

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
Expected: FAIL — 2 failed, 474 passed, 1 skipped (477 total). By this point `cloneState`'s guard (Step 7) reads `dst.heldBotIntent.length`, and two of the five hand-built-`SimState` files do exercise `cloneState` at runtime, not just at the type level: `packages/sim/test/entity.test.ts`'s `describe('step() wiring', ...) > 'runs updateEntities once per tick, after the kart loop'` and `packages/sim/test/laps.test.ts`'s `describe('step() wiring', ...) > 'runs updateLaps for every kart as the last per-kart stage'` both build `prev`/`next` via this file's own `blankState()` helper (not yet widened — that is Step 18) and call `step(ctx, prev, next, inputs, events)`, which calls `cloneState(prev, next)` internally. Since `blankState()`'s literal has no `heldBotIntent` field until Step 18, `dst.heldBotIntent` is `undefined` and the guard throws `TypeError: Cannot read properties of undefined (reading 'length')`. The other three hand-built-literal files (`recovery.test.ts`, `collision.test.ts`, `placement.test.ts`) never call `step()`/`cloneState` on their hand-built states, so they stay green — this is a `tsc`-only breakage for those three, exactly as the Step 4 note describes, but not for these two. Proceed to Step 18, which fixes all five files' literals and resolves both failures.

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
Expected: PASS — 476 passed, 1 skipped (477 total). One more than the Plan 1
baseline of 477: this task adds 1 (`'initialises heldBotIntent...'`) and 1
(`'proves two SimStates never share a bot hold...'`), replaces 3 parity-guard
tests with 1 new even-checkpoint test (net -2), and deletes 1 dirty-hold test
(net -1): 477 + 1 + 1 - 2 - 1 = 476.

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

---

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
  - `export function startSpinOut(ctx: SimContext, state: SimState, k: KartState, ticks: number, events: AuthEvent[]): void` — **signature changed**: `ctx` prepended, nothing else moved. Matches contract §2a exactly.
  - `export function spawnEntity(ctx: SimContext, state: SimState, kind: EntityKind, ownerId: number, position: Vec3, heading: number, targetId: number, ttl: number, events: AuthEvent[]): number` — matches contract §2a exactly.
  - `export function despawnEntityAt(ctx: SimContext, state: SimState, idx: number, events: AuthEvent[]): void` — matches contract §2a exactly.
  - Every one of the eight sites this task touches now reads `if (ctx.isLeader) emit(...)` (or, for `startSpinOut`/`beginRespawn`, the identical single-line guard) instead of an unconditional `emit(...)`. A follower's simulation is unchanged: the state mutation that accompanies each event (spin-out timer, respawn timer/position, lap/checkpoint/finish bookkeeping, entity pool contents, `shielded` flag) happens exactly as before; only the `emit()` call is skipped.

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

- [ ] **Step 19: Give the nine call sites that lack a `ctx` in scope one, then thread `ctx` through every call site in the file**

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

Nine `it` blocks call `spawnEntity`/`despawnEntityAt` without ever having built a `ctx` (verified: grepped `stubContext()` against every line range that calls `spawnEntity`/`despawnEntityAt` in this file — `describe('spawnEntity', ...)`'s two tests, `describe('despawnEntityAt', ...)`'s two tests, three of `describe('surgeActiveOn', ...)`'s tests, and two of `describe('updateEntities collision', ...)`'s tests — `'takes the shield down when a bubble is despawned directly'` and `'does not touch shields when a non-bubble entity despawns'`, both of which call `spawnEntity`/`despawnEntityAt` directly rather than through `updateEntities` and so never had a `ctx` in scope either). Give each a `const ctx = stubContext()` as its first statement.

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

Edit 8. Before:

```ts
  it('takes the shield down when a bubble is despawned directly', () => {
    // Covering the call rather than the caller: every despawn path runs through
    // despawnEntityAt, which is why the clear lives there.
    const state = blankState()
```

After:

```ts
  it('takes the shield down when a bubble is despawned directly', () => {
    // Covering the call rather than the caller: every despawn path runs through
    // despawnEntityAt, which is why the clear lives there.
    const ctx = stubContext()
    const state = blankState()
```

Edit 9. Before:

```ts
  it('does not touch shields when a non-bubble entity despawns', () => {
    const state = blankState()
```

After:

```ts
  it('does not touch shields when a non-bubble entity despawns', () => {
    const ctx = stubContext()
    const state = blankState()
```

Now every `spawnEntity`/`despawnEntityAt` call site in the file has `ctx` reachable in its enclosing `it` block — either just added above, or already present from an existing `const ctx = stubContext()` (verified: `grep -n "stubContext()" packages/sim/test/entity.test.ts` lists one per `it` block that calls `updateEntities`/`spawnEntity`/`despawnEntityAt`, covering the whole file once the nine above are added). Run this single command to thread `ctx` into all 48 call sites mechanically:

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

---

### Task 3: packages/protocol scaffold, types.ts and its barrel

**Amendment folded in.** Two changes to contract §3 landed after this brief was started, both applied below:

1. **`packages/protocol/src/index.ts` is created in this task**, re-exporting `./types` immediately — it is no longer deferred to Task 18. `packages/net` needs `ChannelName` from Task 11 onward, and without a barrel from Task 3 it would have to reach across with a relative path like `'../../protocol/src/types'`, punching through the package boundary and bypassing the `exports` map. `net` must import `@tapkart/protocol`. Task 18 widens this same file to every module and adds the no-ambiguous-export test, exactly as Plan 1's Task 2 → Task 18 did for `@tapkart/sim`'s barrel (`packages/sim/src/index.ts`, read as the model: a one-line `export * from './x'` per module, nothing else).

2. **The RED for everything in `types.ts` except `PROTOCOL_VERSION` must come from `npm run typecheck`, not vitest.** I verified this empirically in this repo before writing the steps below, not assumed it:
   - A **value** import of a module that does not exist (`import { PROTOCOL_VERSION } from '../src/types'` with no `src/types.ts` on disk) fails vitest with `Error: Cannot find module '../src/types' imported from ...` — a real, useful RED.
   - A **type-only** import of that same missing module (`import type { WireHeader } from '../src/types'`) does **not** fail vitest at all — I wrote a test file containing only a type-only import and a typed object literal, ran it against a nonexistent `src/types.ts`, and it reported `1 passed`. Under this repo's `verbatimModuleSyntax` + esbuild transform, a type-only import is erased before module resolution is even attempted, so vitest never notices the file is missing.
   - Once the module exists but is missing one specific named type, `tsc` reports `TS2305: Module '"../src/types"' has no exported member 'WireKart'` (verified directly) — one such error per missing name, all pointing at the same import line.
   - Once the module does not exist at all, `tsc` reports `TS2307: Cannot find module '../src/types' or its corresponding type declarations` — for *every* import from it, value or type-only alike, because `tsc` (unlike the vitest/esbuild runtime path) always resolves the module to type-check it.

   `types.ts` is a pure interface file with only one runtime value (`PROTOCOL_VERSION`) until Step 13 below adds three more (`WIRE_TAG`, `encodeHeader`, `decodeHeader`). Steps 5–6 and 8–9 below take their RED from `tsc`; the `PROTOCOL_VERSION` test (Steps 3–4) and the `WIRE_TAG`/`encodeHeader`/`decodeHeader` tests (Steps 11–14) take theirs from vitest, since all four are runtime values, not type-only imports. Do not run vitest on the type-shape tests expecting a red result — it will pass whether or not the types exist, which is exactly the failure mode ("a green vitest run 'proving' a vacuous RED") that let two of Plan 1's control tests ship silently wrong.

3. **`WIRE_TAG`, `encodeHeader` and `decodeHeader` are in this task's scope.** An earlier draft of this brief's Produces list omitted all three even though contract §3 assigns them to `types.ts`: *"Every datagram begins with this one byte. Without a shared tag a receiver cannot dispatch, and each of Tasks 11/14/15/16 would invent its own — which is exactly what happened when this was left unspecified."* That is precisely what happened: without this task producing them, downstream tasks built incompatible, un-interoperable tag schemes. Steps 11–14 below add all three with real TDD coverage, including `decodeHeader` throwing on an unrecognised tag byte and on a `PROTOCOL_VERSION` mismatch.

**Files:**
- Create: `packages/protocol/package.json`
- Create: `packages/protocol/tsconfig.json`
- Create: `packages/protocol/src/types.ts`
- Create: `packages/protocol/src/index.ts`
- Create: `packages/protocol/test/types.test.ts`

**Interfaces:**

- Consumes (read directly from the files named, not recalled from memory):
  - `packages/sim/package.json` — `{ "name": "@tapkart/sim", "version": "0.1.0", "private": true, "type": "module", "exports": { ".": "./src/index.ts" }, "scripts": { "typecheck": "tsc --noEmit -p tsconfig.json" } }`. This task's `package.json` mirrors this shape exactly, with the package renamed and a dependency on `@tapkart/sim` added.
  - `packages/sim/tsconfig.json` — `{ "extends": "../../tsconfig.base.json", "include": ["src/**/*.ts", "test/**/*.ts"] }`. Copied verbatim, no changes.
  - `tsconfig.base.json` (repo root) — `strict: true`, `verbatimModuleSyntax: true`, `isolatedModules: true`, `noUnusedLocals: true`, `noUnusedParameters: true`, `module: "ESNext"`, `moduleResolution: "Bundler"`, `noEmit: true`. Governs every `import type` decision below.
  - `vitest.config.ts` (repo root) — `test.include: ['packages/*/test/**/*.test.ts']`. Any `packages/protocol/test/*.test.ts` file is picked up automatically; no per-package vitest config is needed.
  - `package.json` (repo root) — `workspaces: ["packages/*"]`, `scripts.typecheck: "npm run typecheck --workspaces --if-present"`. Creating `packages/protocol/package.json` and running `npm install` at the repo root is what registers it as a workspace member (verified: before that install, `node_modules/@tapkart/` contains only `sim`; after, it contains a symlink `protocol -> ../../packages/protocol` alongside it).
  - `packages/sim/src/index.ts` — the barrel pattern this task's `src/index.ts` follows: one `export * from './module'` line per module, nothing else, no default export.
  - From `@tapkart/sim`'s public surface (all `export type`, all defined in `packages/sim/src/types.ts`, read directly rather than recalled): `Vec3 = { x: number; y: number; z: number }`, `Surface = 'tarmac' | 'dirt' | 'boost' | 'offtrack'`, `ItemKind = 'none' | 'boost' | 'seeker' | 'bolt' | 'slick' | 'bubble' | 'surge' | 'blink' | 'charge'`, `EntityKind = 'seeker' | 'bolt' | 'slick' | 'bubble' | 'surge' | 'charge'`, `Intent = { tick: number; steer: number; accel: number; brake: boolean; drift: boolean; useItem: boolean }`.
  - Contract §3's exact interface list, reproduced field-for-field in Step 8 below.

- Produces (exact names and shapes later tasks rely on):
  - `packages/protocol/package.json`, `packages/protocol/tsconfig.json` — the scaffold every later `protocol` task's files sit inside.
  - `export const PROTOCOL_VERSION = 1`
  - `export type ChannelName = 'unreliable' | 'reliable'`
  - `export type MessageKind = 'hello' | 'welcome' | 'lobby' | 'start' | 'input' | 'snapshot' | 'events' | 'checkpoint' | 'authorityChange' | 'ping' | 'pong'`
  - `export interface WireHeader { kind: MessageKind; protocolVersion: number }`
  - `export const WIRE_TAG = { hello: 0x01, welcome: 0x02, lobby: 0x03, start: 0x04, input: 0x10, snapshot: 0x11, events: 0x12, checkpoint: 0x13, authorityChange: 0x20, ping: 0x30, pong: 0x31 } as const` — the one byte every datagram begins with.
  - `export function encodeHeader(out: Uint8Array, kind: MessageKind): number` — writes `out[0] = WIRE_TAG[kind]`, `out[1] = PROTOCOL_VERSION`, returns `2`.
  - `export function decodeHeader(buf: Uint8Array): WireHeader` — throws on a tag byte with no matching `MessageKind` and on a `protocolVersion` that does not equal `PROTOCOL_VERSION`.
  - `export interface WireKart { ... }` — 21 fields, listed in full in Step 8.
  - `export interface WireEntity { ... }` — 7 fields.
  - `export interface WireSnapshot { ... }` — 6 fields.
  - `export interface InputDatagram { ... }` — 2 fields.
  - `packages/protocol/src/index.ts` re-exporting all of the above (`export * from './types'`), reachable as `@tapkart/protocol`.

---

- [ ] **Step 1: Write the scaffold — `package.json` and `tsconfig.json`**

Create `packages/protocol/package.json`:

```json
{
  "name": "@tapkart/protocol",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "dependencies": {
    "@tapkart/sim": "^0.1.0"
  },
  "scripts": {
    "typecheck": "tsc --noEmit -p tsconfig.json"
  }
}
```

Create `packages/protocol/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

- [ ] **Step 2: Register the workspace member**

Run: `npm install` (repo root)
Expected: exit code 0. `node_modules/@tapkart/protocol` is now a symlink to `packages/protocol` — verify with `ls -la node_modules/@tapkart/`, which should list both `protocol -> ../../packages/protocol` and `sim -> ../../packages/sim`. This is what makes `import ... from '@tapkart/sim'` resolvable from inside `packages/protocol` and, once Step 10 lands, `import ... from '@tapkart/protocol'` resolvable from anywhere else in the repo.

Run: `npx tsc --noEmit -p packages/protocol`
Expected: FAIL — `error TS18003: No inputs were found in config file '.../packages/protocol/tsconfig.json'. Specified 'include' paths were '["src/**/*.ts","test/**/*.ts"]' and 'exclude' paths were '[]'.` (verified directly). Neither `src/` nor `test/` has a single `.ts` file in it yet. This is expected — it becomes the first real input the moment Step 3 creates a test file, and is not treated as a bug to fix on its own.

---

- [ ] **Step 3: Write the failing test — `PROTOCOL_VERSION`, `ChannelName`, `MessageKind`, `WireHeader`**

Create `packages/protocol/test/types.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { PROTOCOL_VERSION } from '../src/types'
import type { ChannelName, MessageKind, WireHeader } from '../src/types'

describe('protocol wire types', () => {
  it('fixes PROTOCOL_VERSION at 1', () => {
    expect(PROTOCOL_VERSION).toBe(1)
  })

  it('accepts exactly the two channel names the contract fixes', () => {
    const a: ChannelName = 'unreliable'
    const b: ChannelName = 'reliable'
    expect(a).toBe('unreliable')
    expect(b).toBe('reliable')
  })

  it('builds a WireHeader for every MessageKind the contract lists', () => {
    const kinds: MessageKind[] = [
      'hello', 'welcome', 'lobby', 'start', 'input', 'snapshot', 'events',
      'checkpoint', 'authorityChange', 'ping', 'pong',
    ]
    expect(kinds).toHaveLength(11)
    for (const kind of kinds) {
      const h: WireHeader = { kind, protocolVersion: PROTOCOL_VERSION }
      expect(h.kind).toBe(kind)
      expect(h.protocolVersion).toBe(1)
    }
  })
})
```

- [ ] **Step 4: Run test to verify it fails, two ways**

Run: `npx vitest run packages/protocol/test/types.test.ts`
Expected: FAIL — `Error: Cannot find module '../src/types' imported from '.../packages/protocol/test/types.test.ts'`. This is the value import of `PROTOCOL_VERSION` failing at real module resolution; it is the one assertion in this file vitest can meaningfully red on right now, and it fails the whole file (no tests collected), which is why the two type-only tests below it don't get a chance to run yet either.

Run: `npx tsc --noEmit -p packages/protocol`
Expected: FAIL — two `TS2307: Cannot find module '../src/types' or its corresponding type declarations.` errors, one at the `PROTOCOL_VERSION` import and one at the `ChannelName, MessageKind, WireHeader` import (verified directly: `tsc` reports one per import statement referencing the missing module, regardless of whether the statement is a value or type-only import).

- [ ] **Step 5: Write the minimal implementation — `PROTOCOL_VERSION`, `ChannelName`, `MessageKind`, `WireHeader`**

Create `packages/protocol/src/types.ts`:

```ts
export const PROTOCOL_VERSION = 1

export type ChannelName = 'unreliable' | 'reliable'

export type MessageKind =
  | 'hello' | 'welcome' | 'lobby' | 'start'
  | 'input' | 'snapshot' | 'events' | 'checkpoint'
  | 'authorityChange' | 'ping' | 'pong'

export interface WireHeader { kind: MessageKind; protocolVersion: number }
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run packages/protocol/test/types.test.ts`
Expected: PASS — 3 tests.

Run: `npx tsc --noEmit -p packages/protocol`
Expected: no output, exit code 0.

---

- [ ] **Step 7: Write the failing test — `WireKart`, `WireEntity`, `WireSnapshot`, `InputDatagram`**

In `packages/protocol/test/types.test.ts`, widen the import from `'../src/types'`. Before:

```ts
import { PROTOCOL_VERSION } from '../src/types'
import type { ChannelName, MessageKind, WireHeader } from '../src/types'
```

After:

```ts
import { PROTOCOL_VERSION } from '../src/types'
import type {
  ChannelName, InputDatagram, MessageKind, WireEntity, WireHeader, WireKart, WireSnapshot,
} from '../src/types'
import type { EntityKind, Intent, ItemKind, Surface } from '@tapkart/sim'
```

Then append to the end of the `describe('protocol wire types', ...)` block, before its closing `})`. Before:

```ts
      expect(h.protocolVersion).toBe(1)
    }
  })
})
```

After:

```ts
      expect(h.protocolVersion).toBe(1)
    }
  })

  it('builds a WireKart with all 21 fields the contract lists, and only those', () => {
    const wk: WireKart = {
      playerId: 3,
      position: { x: 1, y: 2, z: 3 },
      velocity: { x: 0, y: 0, z: 0 },
      heading: 0,
      angularVelocity: 0,
      driftCharge: 0,
      driftActive: false,
      driftDir: 0,
      airborne: false,
      surface: 'tarmac' as Surface,
      spinOutTicks: 0,
      invulnTicks: 0,
      item: 'none' as ItemKind,
      lap: 1,
      checkpointIdx: 2,
      t: 0.5,
      isBot: false,
      connected: true,
      boostTicks: 0,
      respawnTicks: 0,
      shielded: false,
    }
    // 21 fields exactly. Spec §5's invariant is that this is a COMPLETE
    // projection of KartState's per-tick fields (characterIdx is the one
    // named exception, arriving over the reliable channel instead) -- a field
    // added to KartState without a matching addition here is the defect the
    // invariant exists to catch, so this count is asserted, not just implied
    // by the object literal typechecking.
    expect(Object.keys(wk).length).toBe(21)
    expect(wk.playerId).toBe(3)
    expect(wk.driftDir).toBe(0)
  })

  it('builds a WireEntity with all 7 fields', () => {
    const we: WireEntity = {
      entityId: 5,
      kind: 'seeker' as EntityKind,
      ownerId: 2,
      position: { x: 0, y: 0, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
      heading: 0,
      ttl: 600,
    }
    expect(Object.keys(we).length).toBe(7)
    expect(we.ttl).toBe(600)
  })

  it('builds a WireSnapshot with all 6 fields', () => {
    const ws: WireSnapshot = {
      tick: 100,
      eventSeq: 4,
      lastProcessedInputTick: [1, 2, 3, 4, 5, 6, 7, 8],
      karts: [],
      entities: [],
      entityCount: 0,
    }
    expect(Object.keys(ws).length).toBe(6)
    expect(ws.lastProcessedInputTick).toHaveLength(8)
  })

  it('builds an InputDatagram with both fields', () => {
    const intent: Intent = { tick: 0, steer: 0, accel: 0, brake: false, drift: false, useItem: false }
    const id: InputDatagram = { playerId: 0, intents: [intent] }
    expect(Object.keys(id).length).toBe(2)
    expect(id.intents).toHaveLength(1)
  })
})
```

- [ ] **Step 8: Run test to verify it fails — `tsc` only**

Do **not** run `npx vitest run packages/protocol/test/types.test.ts` and treat its result as meaningful here. All four new imports (`WireKart`, `WireEntity`, `WireSnapshot`, `InputDatagram`) are `import type`, and `PROTOCOL_VERSION`'s import — the one thing keeping this file's vitest run honest in Step 4 — already resolves successfully as of Step 5. Vitest will run this file and **pass all 7 tests**, including the four new ones, even though none of `WireKart`/`WireEntity`/`WireSnapshot`/`InputDatagram` exist yet: the type-only imports are erased before module resolution, and the object literals typecheck against nothing, so they are plain untyped JS objects at runtime and every `Object.keys(...).length` assertion is measuring a literal you just wrote, not a contract. This is not a bug in the test; it is the precise reason this step's RED must come from `tsc`.

Run: `npx tsc --noEmit -p packages/protocol`
Expected: FAIL — four `TS2305` errors, one per missing name, all on the same import line (verified directly, exact text):

```
test/types.test.ts(3,3): error TS2305: Module '"../src/types"' has no exported member 'InputDatagram'.
test/types.test.ts(3,18): error TS2305: Module '"../src/types"' has no exported member 'WireEntity'.
test/types.test.ts(3,30): error TS2305: Module '"../src/types"' has no exported member 'WireKart'.
test/types.test.ts(3,40): error TS2305: Module '"../src/types"' has no exported member 'WireSnapshot'.
```

- [ ] **Step 9: Write the minimal implementation — `WireKart`, `WireEntity`, `WireSnapshot`, `InputDatagram`**

In `packages/protocol/src/types.ts`, add the import from `@tapkart/sim` at the top. Before:

```ts
export const PROTOCOL_VERSION = 1
```

After:

```ts
import type { EntityKind, Intent, ItemKind, Surface, Vec3 } from '@tapkart/sim'

export const PROTOCOL_VERSION = 1
```

Then append the four interfaces to the end of the file. Before:

```ts
export interface WireHeader { kind: MessageKind; protocolVersion: number }
```

After:

```ts
export interface WireHeader { kind: MessageKind; protocolVersion: number }

export interface WireKart {
  playerId: number; position: Vec3; velocity: Vec3; heading: number
  angularVelocity: number; driftCharge: number; driftActive: boolean
  driftDir: -1 | 0 | 1; airborne: boolean; surface: Surface
  spinOutTicks: number; invulnTicks: number; item: ItemKind
  lap: number; checkpointIdx: number; t: number
  isBot: boolean; connected: boolean
  boostTicks: number; respawnTicks: number; shielded: boolean
}

export interface WireEntity {
  entityId: number; kind: EntityKind; ownerId: number
  position: Vec3; velocity: Vec3; heading: number; ttl: number
}

export interface WireSnapshot {
  tick: number; eventSeq: number
  lastProcessedInputTick: number[]      // length MAX_KARTS
  karts: WireKart[]                     // length MAX_KARTS
  entities: WireEntity[]                // length MAX_ENTITIES, live packed at front
  entityCount: number
}

export interface InputDatagram {
  playerId: number; intents: Intent[]   // length INPUT_REDUNDANCY, newest last
}
```

- [ ] **Step 10: Run test to verify it passes**

Run: `npx tsc --noEmit -p packages/protocol`
Expected: no output, exit code 0.

Run: `npx vitest run packages/protocol/test/types.test.ts`
Expected: PASS — 7 tests. This run is now meaningful (it was not, in Step 8): every field on every interface is exercised by a real object literal, `tsc` has just confirmed those literals conform to the interfaces, and the `Object.keys(...).length` counts guard against a field silently added to one side (KartState) without its counterpart here.

---

- [ ] **Step 11: Write the failing test — `WIRE_TAG`, `encodeHeader`, `decodeHeader`**

In `packages/protocol/test/types.test.ts`, widen the value import. Before:

```ts
import { PROTOCOL_VERSION } from '../src/types'
import type {
  ChannelName, InputDatagram, MessageKind, WireEntity, WireHeader, WireKart, WireSnapshot,
} from '../src/types'
import type { EntityKind, Intent, ItemKind, Surface } from '@tapkart/sim'
```

After:

```ts
import { PROTOCOL_VERSION, WIRE_TAG, decodeHeader, encodeHeader } from '../src/types'
import type {
  ChannelName, InputDatagram, MessageKind, WireEntity, WireHeader, WireKart, WireSnapshot,
} from '../src/types'
import type { EntityKind, Intent, ItemKind, Surface } from '@tapkart/sim'
```

Then append a new `describe` block at the end of the file, after `describe('protocol wire types', ...)`'s closing `})`. Before:

```ts
  it('builds an InputDatagram with both fields', () => {
    const intent: Intent = { tick: 0, steer: 0, accel: 0, brake: false, drift: false, useItem: false }
    const id: InputDatagram = { playerId: 0, intents: [intent] }
    expect(Object.keys(id).length).toBe(2)
    expect(id.intents).toHaveLength(1)
  })
})
```

After:

```ts
  it('builds an InputDatagram with both fields', () => {
    const intent: Intent = { tick: 0, steer: 0, accel: 0, brake: false, drift: false, useItem: false }
    const id: InputDatagram = { playerId: 0, intents: [intent] }
    expect(Object.keys(id).length).toBe(2)
    expect(id.intents).toHaveLength(1)
  })
})

describe('WIRE_TAG, encodeHeader, decodeHeader', () => {
  const ALL_KINDS: MessageKind[] = [
    'hello', 'welcome', 'lobby', 'start', 'input', 'snapshot', 'events',
    'checkpoint', 'authorityChange', 'ping', 'pong',
  ]

  it('fixes a distinct byte for every MessageKind the contract lists', () => {
    expect(WIRE_TAG).toEqual({
      hello: 0x01, welcome: 0x02, lobby: 0x03, start: 0x04,
      input: 0x10, snapshot: 0x11, events: 0x12, checkpoint: 0x13,
      authorityChange: 0x20, ping: 0x30, pong: 0x31,
    })
    // Every datagram is dispatched on this one byte alone, so no two kinds
    // may share a value.
    const values = Object.values(WIRE_TAG)
    expect(new Set(values).size).toBe(values.length)
  })

  it('encodeHeader writes [tag, PROTOCOL_VERSION] and returns 2', () => {
    const out = new Uint8Array(4).fill(0xff)
    const n = encodeHeader(out, 'snapshot')
    expect(n).toBe(2)
    expect(out[0]).toBe(WIRE_TAG.snapshot)
    expect(out[1]).toBe(PROTOCOL_VERSION)
    expect(out[2]).toBe(0xff) // encodeHeader writes only its own 2 bytes
  })

  it('decodeHeader round-trips every MessageKind through encodeHeader', () => {
    const buf = new Uint8Array(2)
    for (const kind of ALL_KINDS) {
      encodeHeader(buf, kind)
      const h: WireHeader = decodeHeader(buf)
      expect(h.kind).toBe(kind)
      expect(h.protocolVersion).toBe(PROTOCOL_VERSION)
    }
  })

  it('decodeHeader throws on a tag byte no MessageKind maps to', () => {
    // 0x99 is not one of WIRE_TAG's eleven values.
    const buf = new Uint8Array([0x99, PROTOCOL_VERSION])
    expect(() => decodeHeader(buf)).toThrow(/unknown wire tag/)
  })

  it('decodeHeader throws on a PROTOCOL_VERSION mismatch', () => {
    const buf = new Uint8Array([WIRE_TAG.input, PROTOCOL_VERSION + 1])
    expect(() => decodeHeader(buf)).toThrow(/protocol version/)
  })
})
```

- [ ] **Step 12: Run test to verify it fails**

Run: `npx vitest run packages/protocol/test/types.test.ts -t "WIRE_TAG, encodeHeader, decodeHeader"`
Expected: FAIL, all 5 tests, for two distinct reasons. Verified directly against this repo's esbuild-transpiled vitest by probing the identical pattern against an existing module (`packages/sim/src/state.ts`, importing two names it does not export): a named **value** import with no matching export binds to `undefined` at the call site rather than failing module resolution, because `types.ts` already exists and exports `PROTOCOL_VERSION` — the whole file still collects and runs.

- `'fixes a distinct byte for every MessageKind the contract lists'`: `AssertionError: expected undefined to deeply equal {...}` — `WIRE_TAG` is `undefined`, and `toEqual` compares it directly without throwing (probed: `expect(undefined).toEqual({ hello: 1 })` reports exactly this).
- `'encodeHeader writes [tag, PROTOCOL_VERSION] and returns 2'`: `TypeError: encodeHeader is not a function` — `encodeHeader` is `undefined`, called as a function.
- `'decodeHeader round-trips every MessageKind through encodeHeader'`: the same `TypeError: encodeHeader is not a function`, at the first `encodeHeader(buf, kind)` call inside the loop.
- `'decodeHeader throws on a tag byte no MessageKind maps to'`: the `toThrow(/unknown wire tag/)` assertion itself fails, not the call — `decodeHeader` is `undefined`, so calling it throws `TypeError: decodeHeader is not a function`, which does not match `/unknown wire tag/`: `AssertionError: expected [Function] to throw error matching /unknown wire tag/ but got '...is not a function'` (probed against the same pattern).
- `'decodeHeader throws on a PROTOCOL_VERSION mismatch'`: the same shape as above, mismatched against `/protocol version/`.

- [ ] **Step 13: Write the minimal implementation — `WIRE_TAG`, `encodeHeader`, `decodeHeader`**

In `packages/protocol/src/types.ts`, insert after `WireHeader` and before `WireKart`. Before:

```ts
export interface WireHeader { kind: MessageKind; protocolVersion: number }

export interface WireKart {
```

After:

```ts
export interface WireHeader { kind: MessageKind; protocolVersion: number }

// Every datagram begins with this byte, so a receiver can dispatch before
// decoding anything else. Without a shared tag, Tasks 11/14/15/16 would each
// invent their own -- which is exactly what happened when this was left
// unspecified in an earlier draft of this contract.
export const WIRE_TAG = {
  hello: 0x01, welcome: 0x02, lobby: 0x03, start: 0x04,
  input: 0x10, snapshot: 0x11, events: 0x12, checkpoint: 0x13,
  authorityChange: 0x20, ping: 0x30, pong: 0x31,
} as const

const TAG_TO_KIND = ((): ReadonlyMap<number, MessageKind> => {
  const m = new Map<number, MessageKind>()
  for (const kind of Object.keys(WIRE_TAG) as MessageKind[]) {
    m.set(WIRE_TAG[kind], kind)
  }
  return m
})()

/** Writes [tag, PROTOCOL_VERSION] into out[0..1] and returns 2, the byte count. */
export function encodeHeader(out: Uint8Array, kind: MessageKind): number {
  out[0] = WIRE_TAG[kind]
  out[1] = PROTOCOL_VERSION
  return 2
}

/**
 * Reads the 2-byte header written by encodeHeader. Throws on an unrecognised
 * tag byte or a PROTOCOL_VERSION that does not match this build's.
 */
export function decodeHeader(buf: Uint8Array): WireHeader {
  const tag = buf[0]
  const kind = TAG_TO_KIND.get(tag)
  if (kind === undefined) {
    throw new Error(`decodeHeader: unknown wire tag ${tag}`)
  }
  const protocolVersion = buf[1]
  if (protocolVersion !== PROTOCOL_VERSION) {
    throw new Error(
      `decodeHeader: protocol version mismatch (expected ${PROTOCOL_VERSION}, got ${protocolVersion})`,
    )
  }
  return { kind, protocolVersion }
}

export interface WireKart {
```

- [ ] **Step 14: Run test to verify it passes**

Run: `npx vitest run packages/protocol/test/types.test.ts -t "WIRE_TAG, encodeHeader, decodeHeader"`
Expected: PASS — 5 tests.

Run: `npx tsc --noEmit -p packages/protocol`
Expected: no output, exit code 0.

---

- [ ] **Step 15: Write the failing test — the barrel**

Append a new test to `packages/protocol/test/types.test.ts`, after the `describe('WIRE_TAG, encodeHeader, decodeHeader', ...)` block closes (Step 11 made this the file's last block). Before (the file's last four lines):

```ts
  it('decodeHeader throws on a PROTOCOL_VERSION mismatch', () => {
    const buf = new Uint8Array([WIRE_TAG.input, PROTOCOL_VERSION + 1])
    expect(() => decodeHeader(buf)).toThrow(/protocol version/)
  })
})
```

After:

```ts
  it('decodeHeader throws on a PROTOCOL_VERSION mismatch', () => {
    const buf = new Uint8Array([WIRE_TAG.input, PROTOCOL_VERSION + 1])
    expect(() => decodeHeader(buf)).toThrow(/protocol version/)
  })
})

describe('@tapkart/protocol barrel', () => {
  it('resolves through the package entry point', async () => {
    const pkg = await import('@tapkart/protocol')
    expect(pkg.PROTOCOL_VERSION).toBe(1)
  })
})
```

This is a dynamic import (not a static one at the top of the file) so a resolution failure fails this one test rather than the whole file, matching `packages/sim/test/barrel.test.ts`'s own `'resolves through the @tapkart/sim package entry point'` test, which this mirrors.

- [ ] **Step 16: Run test to verify it fails**

Run: `npx vitest run packages/protocol/test/types.test.ts -t "resolves through the package entry point"`
Expected: FAIL. `packages/protocol/package.json`'s `exports` map already points `"."` at `./src/index.ts` (Step 1), but that file does not exist yet, so Node's package resolution fails: `Error: Cannot find module '@tapkart/protocol' imported from ...` (or equivalent — the exact wording depends on Vite's resolver, but the failure is a resolution error, not an assertion error, because there is nothing at the far end of the `exports` map yet).

- [ ] **Step 17: Write the minimal implementation — the barrel**

Create `packages/protocol/src/index.ts`:

```ts
// Public barrel for @tapkart/protocol.
//
// packages/protocol/package.json maps "." to this file. Task 3 re-exports only
// types.ts; Task 18 widens this list to every module this package ends up with
// (bits, quant, snapshot, checkpoint, events, input), mirroring exactly what
// Plan 1's Task 2 -> Task 18 did for packages/sim/src/index.ts.
export * from './types'
```

- [ ] **Step 18: Run test to verify it passes**

Run: `npx vitest run packages/protocol/test/types.test.ts`
Expected: PASS — 13 tests (3 from Step 3 + 4 from Step 7 + 5 from Step 11 + 1 barrel test from Step 15).

---

- [ ] **Step 19: Run the whole package and typecheck**

Run: `npx vitest run packages/protocol`
Expected: PASS — 13 tests, 1 file.

Run: `npx tsc --noEmit -p packages/protocol`
Expected: no output, exit code 0.

Run: `npm run typecheck` (repo root)
Expected: exit code 0. This runs `typecheck` in every workspace with that script (`--workspaces --if-present`), so it now also covers `packages/sim`; confirm it still reports success there too, since this task did not touch `packages/sim`.

- [ ] **Step 20: Commit**

```bash
git add packages/protocol/package.json packages/protocol/tsconfig.json \
        packages/protocol/src/types.ts packages/protocol/src/index.ts \
        packages/protocol/test/types.test.ts package-lock.json
git commit -m "feat(protocol): scaffold packages/protocol, wire message types, header codec and its barrel

New npm workspace mirroring packages/sim's package.json/tsconfig.json shape,
depending on @tapkart/sim for Vec3/Surface/ItemKind/EntityKind/Intent and on
nothing else. types.ts carries PROTOCOL_VERSION, ChannelName, MessageKind,
WireHeader, and the WireKart/WireEntity/WireSnapshot/InputDatagram wire
shapes exactly as the locked contract's §3 lists them -- decode targets, not
SimState, and lossy by construction.

WIRE_TAG, encodeHeader and decodeHeader also ship here: the one shared 2-byte
tag+version header every datagram begins with, so a receiver can dispatch
before decoding anything else. decodeHeader throws on an unrecognised tag
byte and on a PROTOCOL_VERSION mismatch. Without this, every later task that
sends a message would invent its own incompatible tag scheme.

src/index.ts re-exports types.ts and is created now, not deferred to Task 18,
because packages/net needs ChannelName from Task 11 onward and must reach it
through @tapkart/protocol rather than a relative path across the package
boundary.

types.ts is mostly a pure interface file; the RED for every type-only
interface in it came from tsc (TS2307 while the module didn't exist, TS2305
once it existed but a name was still missing), not vitest -- a type-only
import of a missing module is erased by verbatimModuleSyntax before module
resolution and passes vitest vacuously, verified directly before writing
these steps. PROTOCOL_VERSION, WIRE_TAG, encodeHeader and decodeHeader are
runtime values, so their RED came from vitest instead, also verified
directly: a named value import with no matching export binds to undefined
at the call site rather than failing module resolution, once the module
itself already exists."
```

---

### Task 4: Bit-level wire codec — `BitWriter` and `BitReader`

This is Plan 2's Task 4, contract §3: `packages/protocol/src/bits.ts`. It is the lowest
layer of `packages/protocol` — zero imports, pure arithmetic on a caller-owned
`Uint8Array` — and every later protocol task (quant.ts's round-trip tests, snapshot.ts,
checkpoint.ts, events.ts, input.ts) builds directly on it. Task 3 (contract §3) has
already run and created `packages/protocol/package.json`, `packages/protocol/tsconfig.json`
(both mirroring `packages/sim`'s: `"exports": {".":"./src/index.ts"}`,
`tsconfig` extending `../../tsconfig.base.json` with `include: ["src/**/*.ts",
"test/**/*.ts"]`) and `packages/protocol/src/types.ts`. This task does not touch any
of those and does not need anything from `types.ts` — `bits.ts` never imports.

**Read contract §0 before writing anything:** byte order is little-endian everywhere
(not relevant inside a single field here, but binding for how multi-byte fields are
laid out across the buffer — LSB-first bit packing is the mechanism, see decision 1
below), bit packing is **LSB-first within each byte**, fields are written in table
order (enforced by the *caller*, not by this file — `bits.ts` has no concept of a
"table", it just packs whatever `writeBits`/`writeFloatQ` calls it receives, in the
order it receives them), and **codecs never allocate**: `BitWriter`/`BitReader` each
take a caller-owned `Uint8Array` in their constructor and never create a new
`Uint8Array` or `ArrayBuffer` themselves.

**Four decisions this task makes, all load-bearing for Tasks 5, 6, 8, 9, 10:**

1. **LSB-first, verified by construction, not by convention.** The first bit ever
   written lands at bit 0 (the `1`s place) of byte 0. The 9th bit written lands at
   bit 0 of byte 1. `writeBits` computes each bit as `Math.floor(value / 2**i) % 2`
   for `i` from `0` to `bits-1` and writes it to bit `(bitPos) % 8` of byte
   `Math.floor(bitPos / 8)`, incrementing `bitPos` after every single bit. This is
   the only implementation of "LSB-first" in this file; there is no separate
   byte-orientation step.
2. **No bit width is special-cased, including 32.** `writeBits`/`readBits` must
   correctly round-trip a full 32-bit value, because the wire header carries `tick`
   and `eventSeq` as `u32` (contract §4). Two specific traps, both real bugs a
   plausible-looking implementation falls into:
   - **Building a single mask `(1 << bits) - 1` for `bits = 32` is wrong.** JS's `<<`
     operator takes its shift amount modulo 32, so `1 << 32 === 1 << 0 === 1`, and
     `(1 << 32) - 1 === 0` — a silent, non-throwing bug that would make every
     32-bit field encode as zero. This file never builds that mask. `writeBits`
     extracts one bit at a time with `Math.floor(value / 2**i) % 2`, where `i` only
     ever reaches `bits - 1` (31 at most for a 32-bit field) — the shift-by-32 case
     never arises because there is no single 32-wide shift anywhere.
   - **Accumulating a read with `result |= bit << i` is wrong at `i = 31`.** `|=`
     coerces to a signed 32-bit integer, so setting bit 31 produces a *negative* JS
     number for any decoded value at or above `2**31` — exactly the range a
     long-running server's monotonic `eventSeq` will eventually reach. `readBits`
     accumulates with `result += bit * mult; mult *= 2` instead: plain
     floating-point arithmetic, no sign bit, correct up to `2**53`.
3. **`writeFloatQ` clamps, it does not wrap.** `clamp(value, min, max)` then
   quantise: `q = Math.round(((clamped - min) / (max - min)) * (2**bits - 1))`,
   written via `writeBits(q, bits)`. A value outside `[min, max]` — a kart
   momentarily beyond `WORLD_HALF` during a physics glitch, say — must land exactly
   on the endpoint it overshot, never fold into the opposite side of the range the
   way a modulo-based implementation would.
4. **`reset()` rewinds the cursor; it does not clear the buffer.** Both classes hold
   only a `buf` reference and a `bitPos` cursor. `reset()` sets `bitPos = 0` so the
   same writer/reader and the same caller-owned buffer can be reused across many
   encode/decode calls without allocating — this is what "codecs never allocate"
   means in practice, one `BitWriter`/`BitReader` pair reused every tick rather than
   constructed fresh. Stale bytes from a previous, longer encode are never read: a
   decoder that stops after the same number of fields the matching encoder wrote
   never reaches them.

**Files:**
- Create: `packages/protocol/src/bits.ts`
- Test: `packages/protocol/test/bits.test.ts`

**Interfaces:**
- Consumes: nothing. This file has zero imports.
- Produces (`packages/protocol/src/bits.ts`), exactly contract §3:
  ```ts
  export class BitWriter {
    constructor(buf: Uint8Array)
    reset(): void
    writeBits(value: number, bits: number): void
    writeFloatQ(value: number, min: number, max: number, bits: number): void
    byteLength(): number
  }
  export class BitReader {
    constructor(buf: Uint8Array)
    reset(): void
    readBits(bits: number): number
    readFloatQ(min: number, max: number, bits: number): number
  }
  ```

**On the expected RED failures below:** this repo runs Vitest over Vite's esbuild SSR
transform, not native Node ESM, so a missing named export does **not** throw a
link-time `SyntaxError: does not provide an export named 'X'`. Instead the import
succeeds with `X` bound to `undefined`, and the failure surfaces at the point `X` is
*used* — `TypeError: (0 , X) is not a function` for a bare function call,
`TypeError: X is not a constructor` for `new X()`, `TypeError: obj.method is not a
function` for a missing method on an object that does exist. When the whole *file*
`src/bits.ts` does not exist yet, the failure is a suite-load error instead:
`Error: Cannot find module '../src/bits' imported from '<abs path to the test
file>'`, and Vitest reports it under "Failed Suites" with zero tests collected. All
of this was verified empirically against this exact repo and Vitest version before
writing the steps below — do not substitute the more commonly-assumed `SyntaxError`
wording from other codebases or older Vitest versions.

---

- [ ] **Step 1: Write the failing tests for `writeBits`/`readBits`**

Create `packages/protocol/test/bits.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { BitReader, BitWriter } from '../src/bits'

describe('BitWriter/BitReader: writeBits/readBits', () => {
  it('packs LSB-first: the first bit written lands at bit 0 of byte 0', () => {
    const buf = new Uint8Array(1)
    const bw = new BitWriter(buf)
    bw.writeBits(1, 1) // bit 0
    bw.writeBits(0, 3) // bits 1-3
    bw.writeBits(1, 1) // bit 4
    // MSB-first packing would put the first bit at bit 7 (byte 0b10001000 = 136);
    // LSB-first puts it at bit 0, so the byte is 0b00010001 = 17
    expect(buf[0]).toBe(0b00010001)
  })

  it('round-trips a single field at several bit widths, at each endpoint', () => {
    const cases: Array<[bits: number, value: number]> = [
      [1, 0], [1, 1],
      [3, 0], [3, 7],
      [7, 0], [7, 127],
      [8, 0], [8, 255],
      [12, 0], [12, 4095],
      [16, 0], [16, 65535],
    ]
    for (const [bits, value] of cases) {
      const buf = new Uint8Array(4)
      const bw = new BitWriter(buf)
      bw.writeBits(value, bits)
      const br = new BitReader(buf)
      expect(br.readBits(bits)).toBe(value)
    }
  })

  it('packs a field starting at bit 6 across the byte boundary', () => {
    const buf = new Uint8Array(2)
    const bw = new BitWriter(buf)
    bw.writeBits(0b111111, 6) // fills bits 0-5 of byte 0
    bw.writeBits(0b101, 3) // bits 6-7 of byte 0, then bit 0 of byte 1
    // value 0b101, LSB-first: bit0=1, bit1=0, bit2=1
    // byte0 bit6=1, byte0 bit7=0 -> byte0 = 0b01111111 = 127
    // byte1 bit0=1 -> byte1 = 0b00000001 = 1
    expect(buf[0]).toBe(0b01111111)
    expect(buf[1]).toBe(0b00000001)
    const br = new BitReader(buf)
    expect(br.readBits(6)).toBe(0b111111)
    expect(br.readBits(3)).toBe(0b101)
  })

  it('round-trips sequential fields of mixed widths in call order', () => {
    const buf = new Uint8Array(4)
    const bw = new BitWriter(buf)
    bw.writeBits(5, 3)
    bw.writeBits(200, 8)
    bw.writeBits(1, 1)
    bw.writeBits(4095, 12)
    const br = new BitReader(buf)
    expect(br.readBits(3)).toBe(5)
    expect(br.readBits(8)).toBe(200)
    expect(br.readBits(1)).toBe(1)
    expect(br.readBits(12)).toBe(4095)
  })

  it('round-trips a 32-bit value at or above 2^31 without going negative', () => {
    // tick and eventSeq are u32 counters a long-running server will eventually push
    // past 2^31; `result |= bit << 31` would set JS's sign bit here and return a
    // negative number instead of this value
    const buf = new Uint8Array(4)
    const bw = new BitWriter(buf)
    const value = 3_000_000_000 // > 2^31 (2147483648), < 2^32 (4294967296)
    bw.writeBits(value, 32)
    const br = new BitReader(buf)
    expect(br.readBits(32)).toBe(value)
  })

  it('byteLength reports bytes touched, rounding a partial byte up', () => {
    const buf = new Uint8Array(4)
    const bw = new BitWriter(buf)
    expect(bw.byteLength()).toBe(0)
    bw.writeBits(1, 1)
    expect(bw.byteLength()).toBe(1)
    bw.writeBits(1, 8) // 9 bits total now
    expect(bw.byteLength()).toBe(2)
  })

  it('reset rewinds the cursor so the same writer and buffer can be reused', () => {
    const buf = new Uint8Array(1)
    const bw = new BitWriter(buf)
    bw.writeBits(0b1111, 4)
    bw.reset()
    bw.writeBits(0b0101, 4) // overwrites the low nibble written above
    const br = new BitReader(buf)
    expect(br.readBits(4)).toBe(0b0101)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/protocol/test/bits.test.ts`

Expected: FAIL — the suite fails to load, under "Failed Suites":
`Error: Cannot find module '../src/bits' imported from
'<repo>/packages/protocol/test/bits.test.ts'`. Zero tests collected
(`src/bits.ts` does not exist yet).

- [ ] **Step 3: Write the minimal `BitWriter`/`BitReader` — `writeBits`/`readBits` only**

Create `packages/protocol/src/bits.ts`:

```ts
/**
 * Bit-packs into a caller-owned Uint8Array. Never allocates a buffer itself: the
 * Uint8Array is supplied by the constructor and reused across many encode calls via
 * reset(). Bit order is LSB-first within each byte (contract §0): the first bit
 * written is byte 0's 1s place; the 9th bit written is byte 1's 1s place.
 *
 * writeBits/writeFloatQ enforce no field order of their own - a caller (snapshot.ts,
 * checkpoint.ts, events.ts, input.ts) is what makes "fields written in table order"
 * true, by calling these methods in that order.
 */
export class BitWriter {
  private buf: Uint8Array
  private bitPos: number

  constructor(buf: Uint8Array) {
    this.buf = buf
    this.bitPos = 0
  }

  /** Rewinds the write cursor to the start of the same buffer. Allocates nothing. */
  reset(): void {
    this.bitPos = 0
  }

  /**
   * Writes the low `bits` bits of `value`, LSB-first. `value` must already be a
   * non-negative integer in [0, 2**bits - 1] - writeBits does not clamp or mask;
   * that is writeFloatQ's job for continuous fields. Every exact/enum field this
   * codebase writes directly (an enum index, a tick count, a 0/1 flag) is already
   * in range by construction.
   *
   * Extracts one bit at a time by division, not by building a single mask: a mask
   * of `(1 << bits) - 1` is wrong at bits = 32 (see this task's decision 2).
   */
  writeBits(value: number, bits: number): void {
    for (let i = 0; i < bits; i++) {
      const bit = Math.floor(value / 2 ** i) % 2
      const byteIdx = this.bitPos >> 3
      const bitIdx = this.bitPos & 7
      if (bit) this.buf[byteIdx] |= 1 << bitIdx
      else this.buf[byteIdx] &= ~(1 << bitIdx)
      this.bitPos++
    }
  }

  /** Bytes touched so far, rounding a partial trailing byte up. */
  byteLength(): number {
    return Math.ceil(this.bitPos / 8)
  }
}

export class BitReader {
  private buf: Uint8Array
  private bitPos: number

  constructor(buf: Uint8Array) {
    this.buf = buf
    this.bitPos = 0
  }

  /** Rewinds the read cursor to the start of the same buffer. Allocates nothing. */
  reset(): void {
    this.bitPos = 0
  }

  /**
   * Reads `bits` bits LSB-first and returns them as a non-negative integer.
   * Accumulates by addition (`result += bit * mult; mult *= 2`), not by
   * `result |= bit << i`: the OR form sets JS's Int32 sign bit on the last
   * iteration of a 32-bit read and returns a negative number for any value at or
   * above 2**31 (see this task's decision 2). Addition has no sign bit to corrupt
   * and stays exact up to 2**53.
   */
  readBits(bits: number): number {
    let result = 0
    let mult = 1
    for (let i = 0; i < bits; i++) {
      const byteIdx = this.bitPos >> 3
      const bitIdx = this.bitPos & 7
      const bit = (this.buf[byteIdx] >> bitIdx) & 1
      result += bit * mult
      mult *= 2
      this.bitPos++
    }
    return result
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/protocol/test/bits.test.ts`

Expected: PASS — 7 passed. (`writeFloatQ`/`readFloatQ` are not called by any test yet.)

---

- [ ] **Step 5: Write the failing tests for `writeFloatQ`/`readFloatQ`**

Append to `packages/protocol/test/bits.test.ts`, after the closing `})` of
`describe('BitWriter/BitReader: writeBits/readBits', ...)`:

```ts
describe('BitWriter/BitReader: writeFloatQ/readFloatQ', () => {
  it('round-trips a mid-range value within one quantisation step', () => {
    const buf = new Uint8Array(4)
    const bw = new BitWriter(buf)
    bw.writeFloatQ(12.5, -1024, 1024, 16)
    const br = new BitReader(buf)
    const step = 2048 / 65535
    expect(Math.abs(br.readFloatQ(-1024, 1024, 16) - 12.5)).toBeLessThan(step)
  })

  it('round-trips both range endpoints exactly', () => {
    const buf = new Uint8Array(4)
    const bw = new BitWriter(buf)
    bw.writeFloatQ(-1024, -1024, 1024, 16)
    bw.writeFloatQ(1024, -1024, 1024, 16)
    const br = new BitReader(buf)
    expect(br.readFloatQ(-1024, 1024, 16)).toBe(-1024)
    expect(br.readFloatQ(-1024, 1024, 16)).toBe(1024)
  })

  it('clamps a value above max instead of wrapping', () => {
    const buf = new Uint8Array(4)
    const bw = new BitWriter(buf)
    bw.writeFloatQ(5000, -1024, 1024, 16)
    const br = new BitReader(buf)
    // a wrap (e.g. modulo back into range) would land far from 1024; clamping
    // lands exactly on the endpoint the value overshot
    expect(br.readFloatQ(-1024, 1024, 16)).toBe(1024)
  })

  it('clamps a value below min instead of wrapping', () => {
    const buf = new Uint8Array(4)
    const bw = new BitWriter(buf)
    bw.writeFloatQ(-5000, -1024, 1024, 16)
    const br = new BitReader(buf)
    expect(br.readFloatQ(-1024, 1024, 16)).toBe(-1024)
  })

  it('interleaves with writeBits without losing alignment', () => {
    const buf = new Uint8Array(8)
    const bw = new BitWriter(buf)
    bw.writeBits(5, 3)
    bw.writeFloatQ(0.5, 0, 1, 10)
    bw.writeBits(2, 2)
    const br = new BitReader(buf)
    expect(br.readBits(3)).toBe(5)
    const step10 = 1 / 1023
    expect(Math.abs(br.readFloatQ(0, 1, 10) - 0.5)).toBeLessThan(step10)
    expect(br.readBits(2)).toBe(2)
  })

  it('a narrow 2-bit field over [0,1] quantises to the nearest of 3 levels', () => {
    const buf = new Uint8Array(1)
    const bw = new BitWriter(buf)
    bw.writeFloatQ(0.5, 0, 1, 2) // 0.5 / (1/3) = 1.5 -> Math.round -> level 2 -> 2/3
    const br = new BitReader(buf)
    expect(br.readFloatQ(0, 1, 2)).toBeCloseTo(2 / 3, 12)
  })
})
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `npx vitest run packages/protocol/test/bits.test.ts -t "writeFloatQ/readFloatQ"`

Expected: FAIL — `TypeError: bw.writeFloatQ is not a function`. (`BitWriter` exists
from Step 3 but has no `writeFloatQ` method yet; this is a missing-method error on an
object that exists, not a missing-module or missing-export error.)

- [ ] **Step 7: Write `writeFloatQ`/`readFloatQ`**

In `packages/protocol/src/bits.ts`, add this method to `BitWriter`, after
`writeBits` and before `byteLength`:

```ts
  /**
   * Clamps `value` to [min, max], then writes a `bits`-wide uniform quantisation
   * of it. Never wraps: a value past either end of the range is written as that
   * endpoint, not folded back into range.
   */
  writeFloatQ(value: number, min: number, max: number, bits: number): void {
    const clamped = value < min ? min : value > max ? max : value
    const span = max - min
    const levels = 2 ** bits - 1
    const q = span > 0 ? Math.round(((clamped - min) / span) * levels) : 0
    this.writeBits(q, bits)
  }
```

And add this method to `BitReader`, after `readBits`:

```ts
  /** Reverses writeFloatQ: reads `bits` bits and maps them back into [min, max]. */
  readFloatQ(min: number, max: number, bits: number): number {
    const q = this.readBits(bits)
    const levels = 2 ** bits - 1
    return levels > 0 ? min + (q / levels) * (max - min) : min
  }
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `npx vitest run packages/protocol/test/bits.test.ts`

Expected: PASS — 13 passed (7 from `writeBits`/`readBits` plus 6 from
`writeFloatQ`/`readFloatQ`).

---

- [ ] **Step 9: Typecheck and run the whole protocol suite**

Run: `npx tsc --noEmit -p packages/protocol && npx vitest run packages/protocol`

Expected: PASS — no TypeScript errors; `bits.test.ts` 13 passed, plus whatever Task 3
already shipped for `types.ts` (this task does not add or remove any of those).

---

- [ ] **Step 10: Write the failing test — `BitWriter`/`BitReader` reachable through the barrel**

Contract §3: "The barrel exists from Task 3, not Task 18" — Task 3 created
`packages/protocol/src/index.ts` re-exporting only `./types`. Every module Tasks 4-10
add must append its own `export * from './<module>'` line as its last implementation
step, exactly as Plan 1's Tasks 3-10 each did for `@tapkart/sim/src/index.ts`, so that
`packages/net` can `import ... from '@tapkart/protocol'` from Task 11 onward without
waiting for Task 18. This task's module is `bits.ts`.

Append to `packages/protocol/test/bits.test.ts`, after the closing `})` of
`describe('BitWriter/BitReader: writeFloatQ/readFloatQ', ...)`:

```ts
describe('@tapkart/protocol barrel', () => {
  it('re-exports BitWriter and BitReader', async () => {
    const pkg = await import('@tapkart/protocol')
    expect(typeof pkg.BitWriter).toBe('function')
    expect(typeof pkg.BitReader).toBe('function')
  })
})
```

This is a dynamic import, matching Task 3's own barrel test in `types.test.ts` and
`packages/sim/test/barrel.test.ts`'s `'resolves through the @tapkart/sim package entry
point'` test, so a resolution failure fails this one test rather than the whole file.

- [ ] **Step 11: Run the test to verify it fails**

Run: `npx vitest run packages/protocol/test/bits.test.ts -t "re-exports BitWriter and BitReader"`

Expected: FAIL — `packages/protocol/src/index.ts` currently re-exports only `./types`
(Task 3), so the dynamically-imported package object has no `BitWriter`/`BitReader`
property: `AssertionError: expected 'undefined' to be 'function'` at
`expect(typeof pkg.BitWriter).toBe('function')`.

- [ ] **Step 12: Widen the barrel**

In `packages/protocol/src/index.ts`. Before:

```ts
// Public barrel for @tapkart/protocol.
//
// packages/protocol/package.json maps "." to this file. Task 3 re-exports only
// types.ts; Task 18 widens this list to every module this package ends up with
// (bits, quant, snapshot, checkpoint, events, input), mirroring exactly what
// Plan 1's Task 2 -> Task 18 did for packages/sim/src/index.ts.
export * from './types'
```

After:

```ts
// Public barrel for @tapkart/protocol.
//
// packages/protocol/package.json maps "." to this file. Each module task (3-10)
// appends its own line here as its last implementation step, exactly as Plan 1's
// Tasks 3-10 did for packages/sim/src/index.ts. Task 18 only adds the
// no-ambiguous-export test; every export line already exists by then.
export * from './types'
export * from './bits'
```

- [ ] **Step 13: Run the test to verify it passes, then the whole file and package**

Run: `npx vitest run packages/protocol/test/bits.test.ts`
Expected: PASS — 14 passed (13 from Steps 4/8, plus the barrel test).

Run: `npx tsc --noEmit -p packages/protocol && npx vitest run packages/protocol`
Expected: PASS — no TypeScript errors; every test across the package still passes,
including Task 3's own barrel test (`types.test.ts`'s `'resolves through the package
entry point'`), which this task's edit to `index.ts` does not touch.

- [ ] **Step 14: Commit**

```bash
git add packages/protocol/src/bits.ts packages/protocol/src/index.ts \
        packages/protocol/test/bits.test.ts
git commit -m "feat(protocol): LSB-first bit-packed wire codec primitives (BitWriter/BitReader)

Widens packages/protocol/src/index.ts to re-export bits.ts, so packages/net
can reach BitWriter/BitReader through @tapkart/protocol from Task 11 onward
instead of waiting for Task 18's barrel widening."
```

---

### Task 5: The quantisation and epsilon tables — `Q`, `EPS`, `quantStep`

This is Plan 2's Task 5, contract §3: `packages/protocol/src/quant.ts`. It transcribes
contract §4 — "the heart of this plan" — into frozen, typed constants. Every later
task that touches a wire field (Task 6's `snapshot.ts`, Task 8's `checkpoint.ts`, and
Task 7's exhaustive epsilon-exceeds-step assertion, none of which are this task) reads
`Q[field].{min,max,bits}` rather than repeating a magic number, so a single wrong
constant here is wrong everywhere at once — which is exactly why every number below is
derived from contract §4's own numbers (range, bits) rather than copied from its
prose "Step" column. This task has no dependency on Task 4's `bits.ts` and Task 4 has
none on this task; they may be done in either order, but both must land before Task 6.
(This independence is about the two modules' code, not the shared barrel file: Step
12 below appends `export * from './quant'` to `packages/protocol/src/index.ts` and
its "Before" anchor assumes Task 4 already appended `./bits` there, matching this
plan's own convention of executing Tasks 1-18 in numeric order. If Task 5 is ever
run before Task 4 in practice, adjust that one anchor to match whatever the barrel
actually contains at the time — the append itself is order-independent, only the
diff text shown is not.)

**Read contract §4 before writing anything.** It is a 20-row table (`position.{x,y,z}`
through `playerId`) of `Field | Range | Bits | Step | Epsilon | Compared as`, plus two
paragraphs of prose below it for the entity record and the header. This task's `Q`
and `EPS` cover **only the six continuous rows** — `position, velocity, heading,
angularVelocity, driftCharge, t` — the only ones with a real step and epsilon.
Contract §4 is explicit about the other fourteen: *"Only the six continuous rows
above appear in `Q` and `EPS`. The [...] 'exact' rows carry no quantisation noise and
therefore need no epsilon — giving them one would invite someone to compare an
integer with a tolerance."* Those fourteen rows (`spinOutTicks`, `invulnTicks`,
`boostTicks`, `respawnTicks`, `lap`, `checkpointIdx`, `item`, `surface`,
`driftActive`+`driftDir`, `airborne`, `shielded`, `isBot`, `connected`, `playerId` —
`isBot` and `connected` are two separate 1-bit rows, each with its own bit, not one
shared bit) plus the entity record's `entityId u16`/`kind u4`/`ownerId u3`/`ttl u16`
and the header's `tick u32`/`eventSeq u32`/`entityCount u8` are plain fixed-width
integers or 1-bit flags with no epsilon concept at all. Task 6 writes all of those bit
widths as literal numbers, sourced directly from contract §4's prose, not through `Q`
— the same pattern Task 6 already uses for the entity/header fields (`ENTITY_ID_BITS =
16`, etc.). Keeping `Q`/`EPS` scoped to exactly the six rows contract §4 gives a
step/epsilon value is what "transcribed from contract §4 exactly" means here —
widening it to fields that were never given an epsilon would be inventing a table
contract §4 does not contain.

**Two decisions this task makes, both load-bearing for Task 6 and for Task 7 (not
this task, but the next reader of `Q`/`EPS`):**

1. **Six keys, not twenty rows, and the continuous key is `t`.** Contract §3
   (`QuantTable`/`EpsilonTable`) locks the interface to exactly `position, velocity,
   heading, angularVelocity, driftCharge, t` — a closed shape, not an open
   `Record<string, QuantField>` a later file could widen by accident. The key for lap
   progress is `t`, not `lap.t` and not `lapT`, "matching the flat `WireKart`
   interface" (contract §4) that Task 3 already ships. `isBot` and `connected` are
   **not** in this table at all — contract §4 gives each its own dedicated wire bit
   ("deliberately... An earlier draft implied they shared one, which only works if
   `isBot === !connected` always holds... it is an *emergent* property... not an
   invariant anything enforces") and both are exact (0-epsilon) fields Task 6 owns
   directly, the same as the other twelve exact fields. Nothing in this file merges
   any two `KartState` fields into one wire bit; packing decisions for exact fields
   belong entirely to Task 6.
2. **The prose "Step" column is illustrative; `quantStep` is the source of truth.**
   Contract §4 states this itself: *"Steps below are `quantStep(min, max, bits) =
   (max - min) / ((1 << bits) - 1)`, computed, not rounded. An earlier draft of this
   table divided by `1 << bits` and was wrong in the fourth decimal for several rows
   ... The code always derives the step through `quantStep`, so the arithmetic never
   mattered to behaviour — but a reader who 'fixed' the formula to match the wrong
   prose would break every one of them at once."* This task's tests assert `quantStep`
   against exact fraction expressions (`32 / 1023`, `1 / 1023`, ...) — the same
   arithmetic the function itself performs — rather than against any rounded decimal,
   so a correct implementation cannot be made to disagree with itself no matter which
   draft of the prose table a reader is looking at. `Q`'s `min`/`max`/`bits` integers
   (the only inputs `quantStep` and `writeFloatQ`/`readFloatQ` actually consume) are
   unambiguous in contract §4 and are transcribed exactly.

**Files:**
- Create: `packages/protocol/src/quant.ts`
- Test: `packages/protocol/test/quant.test.ts`

**Interfaces:**
- Consumes: nothing. This file has zero imports (not even from `bits.ts`).
- Produces (`packages/protocol/src/quant.ts`), contract §3's signature verbatim:
  ```ts
  export const WORLD_HALF = 1024

  export interface QuantField {
    readonly min: number
    readonly max: number
    readonly bits: number
  }

  export interface QuantTable {
    readonly position: QuantField
    readonly velocity: QuantField
    readonly heading: QuantField
    readonly angularVelocity: QuantField
    readonly driftCharge: QuantField
    readonly t: QuantField
  }

  export interface EpsilonTable {
    readonly position: number
    readonly velocity: number
    readonly heading: number
    readonly angularVelocity: number
    readonly driftCharge: number
    readonly t: number
  }

  export const Q: QuantTable
  export const EPS: EpsilonTable
  export function quantStep(min: number, max: number, bits: number): number
  ```
  `position` and `velocity` each describe one shared `{min,max,bits}` reused three
  times by whoever encodes `x`, `y`, `z` (Task 6) — `Q` has one `position` entry, not
  three.

---

- [ ] **Step 1: Write the failing test for `quantStep` and `WORLD_HALF`**

Create `packages/protocol/test/quant.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { quantStep, WORLD_HALF } from '../src/quant'

describe('WORLD_HALF', () => {
  it('is 1024', () => {
    expect(WORLD_HALF).toBe(1024)
  })
})

describe('quantStep', () => {
  it('matches (max - min) / (2^bits - 1) for every continuous field range', () => {
    expect(quantStep(-1024, 1024, 16)).toBe(2048 / 65535)
    expect(quantStep(-64, 64, 12)).toBe(128 / 4095)
    expect(quantStep(-Math.PI, Math.PI, 12)).toBe((2 * Math.PI) / 4095)
    expect(quantStep(-16, 16, 10)).toBe(32 / 1023)
    expect(quantStep(0, 255, 8)).toBe(255 / 255)
    expect(quantStep(0, 1, 10)).toBe(1 / 1023)
  })

  it('divides by 2^bits - 1, not 2^bits, at 10 bits', () => {
    // An earlier draft of contract §4's prose table rounded two 10-bit rows as if
    // the denominator were 2^bits (1024): angularVelocity would round to 0.03125
    // and t (lap progress) to 0.0009766. The formula's denominator is 2^bits - 1
    // (1023) - these differ at the 4th decimal, and the current contract's own
    // Step column already reflects the corrected value (0.0312805 / 0.0009775).
    const angularVelocityStep = quantStep(-16, 16, 10)
    expect(angularVelocityStep).toBeCloseTo(0.0312805, 6)
    expect(angularVelocityStep).not.toBeCloseTo(0.03125, 6)
    const tStep = quantStep(0, 1, 10)
    expect(tStep).toBeCloseTo(0.0009775, 6)
    expect(tStep).not.toBeCloseTo(0.0009766, 6)
  })

  it('is exactly 1 for every field whose range spans exactly 2^bits - 1 integers', () => {
    expect(quantStep(0, 255, 8)).toBe(1)
    expect(quantStep(0, 127, 7)).toBe(1)
    expect(quantStep(0, 63, 6)).toBe(1)
    expect(quantStep(0, 15, 4)).toBe(1)
    expect(quantStep(0, 7, 3)).toBe(1)
    expect(quantStep(0, 3, 2)).toBe(1)
    expect(quantStep(0, 1, 1)).toBe(1)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/protocol/test/quant.test.ts`

Expected: FAIL — suite fails to load, under "Failed Suites":
`Error: Cannot find module '../src/quant' imported from
'<repo>/packages/protocol/test/quant.test.ts'`. Zero tests collected
(`src/quant.ts` does not exist yet).

- [ ] **Step 3: Write `WORLD_HALF` and `quantStep`**

Create `packages/protocol/src/quant.ts`:

```ts
/** Half-width of the world in metres; ±WORLD_HALF encloses every shipped track with
 * margin (the largest generated track spans x in [-82, 722] - contract §4). */
export const WORLD_HALF = 1024

/**
 * Uniform quantisation step size for a `bits`-wide field spanning [min, max].
 * `2^bits` distinct codes exist but only `2^bits - 1` *gaps* separate them, so the
 * step - and the denominator here - is `(2^bits - 1)`, not `2^bits` (contract §4).
 */
export function quantStep(min: number, max: number, bits: number): number {
  return (max - min) / ((1 << bits) - 1)
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/protocol/test/quant.test.ts`

Expected: PASS — 4 passed.

---

- [ ] **Step 5: Write the failing tests for `Q` and `EPS`**

Append to `packages/protocol/test/quant.test.ts`:

```ts
import { EPS, Q } from '../src/quant'

const CONTINUOUS_FIELDS = ['angularVelocity', 'driftCharge', 'heading', 'position', 't', 'velocity'] as const

describe('Q', () => {
  it('has exactly the six continuous fields contract §3/§4 name, keyed t not lapT', () => {
    expect(Object.keys(Q).sort()).toEqual([...CONTINUOUS_FIELDS].sort())
  })

  it('matches contract §4 range and bits for every field', () => {
    expect(Q.position).toEqual({ min: -WORLD_HALF, max: WORLD_HALF, bits: 16 })
    expect(Q.velocity).toEqual({ min: -64, max: 64, bits: 12 })
    expect(Q.heading).toEqual({ min: -Math.PI, max: Math.PI, bits: 12 })
    expect(Q.angularVelocity).toEqual({ min: -16, max: 16, bits: 10 })
    expect(Q.driftCharge).toEqual({ min: 0, max: 255, bits: 8 })
    expect(Q.t).toEqual({ min: 0, max: 1, bits: 10 })
  })

  it('sums to 124 bits across the six continuous fields, position/velocity counted 3x each', () => {
    // 3*16 (position.x,y,z) + 3*12 (velocity.x,y,z) + 12 (heading) + 10 (angularVelocity)
    // + 8 (driftCharge) + 10 (t) = 48 + 36 + 12 + 10 + 8 + 10 = 124.
    // The full 178-bit-per-kart total (contract §4) also needs the fourteen exact
    // fields' widths, which are Task 6's local constants, not Q -- Task 6 asserts
    // the full 178-bit total once those constants exist alongside these six.
    const singleWidth = (['heading', 'angularVelocity', 'driftCharge', 't'] as const)
      .reduce((sum, f) => sum + Q[f].bits, 0)
    const total = singleWidth + 3 * Q.position.bits + 3 * Q.velocity.bits
    expect(total).toBe(124)
  })

  it('is deeply frozen: the table and every field object inside it', () => {
    expect(Object.isFrozen(Q)).toBe(true)
    expect(Object.isFrozen(Q.position)).toBe(true)
    expect(Object.isFrozen(Q.t)).toBe(true)
  })
})

describe('EPS', () => {
  it('has exactly the same six keys as Q', () => {
    expect(Object.keys(EPS).sort()).toEqual(Object.keys(Q).sort())
  })

  it('matches contract §4 epsilon for every field', () => {
    expect(EPS.position).toBe(0.05)
    expect(EPS.velocity).toBe(0.05)
    expect(EPS.heading).toBe(0.0025)
    expect(EPS.angularVelocity).toBe(0.05)
    expect(EPS.driftCharge).toBe(1.5)
    expect(EPS.t).toBe(0.002)
  })

  it('is frozen', () => {
    expect(Object.isFrozen(EPS)).toBe(true)
  })

  it('exceeds quantStep for every field - the buzz-prevention invariant', () => {
    // contract §0/§4: an epsilon at or below its field's step means quantisation
    // noise alone triggers a correction every snapshot. This is a basic sanity
    // check at the point of authorship; Task 7 asserts the same inequality
    // mechanically for every field as its own dedicated test.
    for (const f of CONTINUOUS_FIELDS) {
      const step = quantStep(Q[f].min, Q[f].max, Q[f].bits)
      expect(EPS[f]).toBeGreaterThan(step)
    }
  })
})
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `npx vitest run packages/protocol/test/quant.test.ts -t "^Q "`

Expected: FAIL — `TypeError: Cannot read properties of undefined (reading
'position')`. (`Q` is not exported yet, so the imported binding is `undefined`;
`Q.position` in the first assertion throws reading a property of `undefined`.)

- [ ] **Step 7: Write `Q` and `EPS`**

Append to `packages/protocol/src/quant.ts`:

```ts
/** One quantised field's shape: linear range plus bit width. Frozen per-instance so
 * `Object.freeze(Q)` (shallow) is not the only thing standing between a caller and
 * a mutated table - each field object is frozen too. */
export interface QuantField {
  readonly min: number
  readonly max: number
  readonly bits: number
}

/**
 * The six continuous fields of contract §4's per-kart table - the only ones with a
 * real step and epsilon. `position` and `velocity` are listed once each and reused
 * for x, y and z by whoever encodes them (Task 6). The fourteen exact/enum fields
 * (spinOutTicks .. playerId, isBot and connected each with their own bit) have no
 * entry here: they carry no quantisation noise, so an epsilon for them would invite
 * comparing an integer with a tolerance (contract §4). Task 6 owns their bit widths
 * directly, as local constants.
 */
export interface QuantTable {
  readonly position: QuantField
  readonly velocity: QuantField
  readonly heading: QuantField
  readonly angularVelocity: QuantField
  readonly driftCharge: QuantField
  readonly t: QuantField
}

export interface EpsilonTable {
  readonly position: number
  readonly velocity: number
  readonly heading: number
  readonly angularVelocity: number
  readonly driftCharge: number
  readonly t: number
}

function qf(min: number, max: number, bits: number): QuantField {
  return Object.freeze({ min, max, bits })
}

/** Contract §4's six continuous rows, transcribed field by field. Frozen two levels
 * deep: the table itself and every QuantField inside it. */
export const Q: QuantTable = Object.freeze({
  position: qf(-WORLD_HALF, WORLD_HALF, 16),
  velocity: qf(-64, 64, 12),
  heading: qf(-Math.PI, Math.PI, 12),
  angularVelocity: qf(-16, 16, 10),
  driftCharge: qf(0, 255, 8),
  t: qf(0, 1, 10),
})

/** Contract §4's Epsilon column for the six continuous rows. Every value here
 * exceeds its own quantStep - see the last test in this task's file, and Task 7's
 * exhaustive version of the same check. Do not tune any of these down (contract §0). */
export const EPS: EpsilonTable = Object.freeze({
  position: 0.05,
  velocity: 0.05,
  heading: 0.0025,
  angularVelocity: 0.05,
  driftCharge: 1.5,
  t: 0.002,
})
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `npx vitest run packages/protocol/test/quant.test.ts`

Expected: PASS — 12 passed (4 from `quantStep`/`WORLD_HALF`, 4 from `Q`, 4 from `EPS`).

---

- [ ] **Step 9: Typecheck and run the whole protocol suite**

Run: `npx tsc --noEmit -p packages/protocol && npx vitest run packages/protocol`

Expected: PASS — no TypeScript errors; `quant.test.ts` 12 passed, plus Task 3's and
Task 4's tests (this task adds no new dependency on either and removes nothing).

---

- [ ] **Step 10: Write the failing test — `Q`, `EPS`, `quantStep`, `WORLD_HALF` reachable through the barrel**

Contract §3: "The barrel exists from Task 3, not Task 18" — by the time this task
runs, `packages/protocol/src/index.ts` re-exports `./types` (Task 3) and `./bits`
(Task 4). This task's module is `quant.ts`; appending its own line is this task's
last implementation step, exactly as Plan 1's Tasks 3-10 each did for
`@tapkart/sim/src/index.ts`, so `packages/net` can `import ... from
'@tapkart/protocol'` from Task 11 onward without waiting for Task 18.

Append to `packages/protocol/test/quant.test.ts`, after the closing `})` of
`describe('EPS', ...)`:

```ts
describe('@tapkart/protocol barrel', () => {
  it('re-exports Q, EPS, quantStep and WORLD_HALF', async () => {
    const pkg = await import('@tapkart/protocol')
    expect(pkg.WORLD_HALF).toBe(1024)
    expect(typeof pkg.quantStep).toBe('function')
    expect(pkg.Q.position.bits).toBe(16)
    expect(pkg.EPS.position).toBe(0.05)
  })
})
```

This is a dynamic import, matching Task 3's own barrel test in `types.test.ts` and
`packages/sim/test/barrel.test.ts`'s `'resolves through the @tapkart/sim package entry
point'` test, so a resolution failure fails this one test rather than the whole file.

- [ ] **Step 11: Run the test to verify it fails**

Run: `npx vitest run packages/protocol/test/quant.test.ts -t "re-exports Q, EPS, quantStep and WORLD_HALF"`

Expected: FAIL — `packages/protocol/src/index.ts` does not yet re-export `./quant`
(only `./types` and `./bits`), so the dynamically-imported package object has no
`WORLD_HALF` property: `AssertionError: expected undefined to be 1024` at
`expect(pkg.WORLD_HALF).toBe(1024)`.

- [ ] **Step 12: Widen the barrel**

In `packages/protocol/src/index.ts`. Before:

```ts
export * from './types'
export * from './bits'
```

After:

```ts
export * from './types'
export * from './bits'
export * from './quant'
```

- [ ] **Step 13: Run the test to verify it passes, then the whole file and package**

Run: `npx vitest run packages/protocol/test/quant.test.ts`
Expected: PASS — 13 passed (12 from Steps 4/8, plus the barrel test).

Run: `npx tsc --noEmit -p packages/protocol && npx vitest run packages/protocol`
Expected: PASS — no TypeScript errors; every test across the package still passes,
including Task 3's and Task 4's own barrel tests, which this task's edit to
`index.ts` does not touch.

- [ ] **Step 14: Commit**

```bash
git add packages/protocol/src/quant.ts packages/protocol/src/index.ts \
        packages/protocol/test/quant.test.ts
git commit -m "feat(protocol): quantisation and epsilon tables transcribed from contract §4

Q/EPS cover exactly the six continuous fields (position, velocity, heading,
angularVelocity, driftCharge, t) contract §3 locks -- the fourteen exact/enum
fields (isBot and connected each with their own bit, not shared) carry no
epsilon and are Task 6's local constants instead.

Widens packages/protocol/src/index.ts to re-export quant.ts, so packages/net
can reach Q/EPS/quantStep/WORLD_HALF through @tapkart/protocol from Task 11
onward instead of waiting for Task 18's barrel widening."
```

---

### Task 6: The snapshot codec — `encodeSnapshot`, `decodeSnapshot`, `applySnapshotToState`

This is Plan 2's Task 6, contract §3: `packages/protocol/src/snapshot.ts`. It projects
`SimState` onto the wire and back, at contract §4's per-kart layout. Task 4
(`bits.ts`) and Task 5 (`quant.ts`) are both already merged when this task starts;
Task 3's `packages/protocol/src/types.ts` supplies `WireKart`/`WireEntity`/
`WireSnapshot` exactly as contract §3 lists them — this task consumes those types,
it does not redefine them.

**`WireSnapshot` is a lossy projection, never a resume point.** Spec §3 names
conflating a `WireSnapshot` with `SimState` as "the single biggest defect found in
review." `SimState` carries process/race-lifecycle bookkeeping no client or shadow
ever needs from a 20Hz unreliable-channel packet — the PRNG cursor that only the
leader's item rolls consume, the event counter that a follower advances solely by
*applying* events (contract §0's eleventh convention), the entity-id allocator, and
so on. `applySnapshotToState` therefore writes only the fields the wire actually
carries, and **must not touch**: `rngCursor`, `nextEventSeq`, `nextEntityId`,
`itemBoxes`, `finishedOrder`, `phase`, `finishTick`, `heldBotIntent`, `heldBotTick`.
Two more fields are untouched for the same reason though nothing had to forbid them
explicitly — there is simply no wire data for them: `raceSeed` (not a
`WireSnapshot` field at all) and `karts[i].characterIdx` (see the next paragraph).
Step 17 below constructs a `dst` state with a marker value in every one of these
fields and asserts every marker survives `applySnapshotToState` untouched.

**`characterIdx` is deliberately absent from the wire.** Contract §1c/§5: it is
static for the whole race and arrives once, over the reliable channel, at character
select — it is not per-tick state, so the "per-kart record is a complete projection
of every `KartState` field" invariant does not reach it. `WireKart` has no
`characterIdx` field (confirmed by reading contract §3's interface directly, not
assumed), and `applySnapshotToState` leaves `dst.karts[i].characterIdx` exactly as
it found it. Do not "fix" this by adding the field — it is excluded on purpose.

**Entities are packed at the front with `entityCount` live; dead slots sentinel
`entityId === -1`.** `SimState.entities` already maintains this invariant internally
(verified by reading `packages/sim/src/entity.ts`'s `clearSlot`, lines 20-38: a dead
slot has `entityId: -1, kind: 'seeker', ownerId: -1`, zeroed position/velocity,
`heading: 0, targetId: -1, ttl: 0` — despawn is a swap-remove that keeps every live
entity inside `[0, entityCount)`). `encodeSnapshot` therefore only ever writes
`state.entityCount` entity records, not all `MAX_ENTITIES` — that is the whole
reason a typical 6-entity snapshot is smaller than a 32-entity one. `decodeSnapshot`
is the side that has to *restore* the invariant on a caller-owned, reused
`out.entities` array: it writes the `entityCount` live records from the wire into
`out.entities[0 .. entityCount)`, and it must **re-sentinel every slot from
`entityCount` to `MAX_ENTITIES - 1` on every call** — not just the first one. A
`WireSnapshot` target is decoded into repeatedly across a race (20 times a second),
and a slot that held a live entity on one decode and is empty on the next must not
be left showing the previous entity's `entityId`. Step 15 below decodes a 1-entity
snapshot, then decodes a 0-entity snapshot into the *same* `out`, and asserts slot 0
reads `entityId === -1` afterward — the specific failure mode a decoder that only
writes `[0, entityCount)` and never touches the rest would produce.

**`decodeSnapshot`'s re-sentinelling does not — and cannot — reach `targetId`,
because `WireEntity` has no such field (contract §3); the obligation lands on
`applySnapshotToState` instead, which writes into `SimState.entities`, and
`EntityState` *does* have one.** `packages/sim/src/entity.ts`'s `clearSlot`
pairs `entityId: -1` with `targetId: -1` always — a dead slot's `targetId` is
never meaningfully anything else. Step 7's `applySnapshotToState` below resets
`e.targetId` to `-1` on exactly the slots where `s.entityId === -1`, and leaves
a live slot's `targetId` exactly as it found it (still correct — `WireEntity`
carries no data for it either way). Without this, a slot that held a live
seeker on an earlier decode keeps that seeker's old `targetId` after the seeker
despawns and the slot is re-sentinelled — residue with no wire representation,
consumed downstream by `ShadowLoop.reconcile` (Task 16), which calls this
function directly.

**Two settled facts from contract §4's own current text — not open disputes, and not
this task's to re-litigate, but restated here because an earlier draft of this brief
argued them as unresolved:**

1. **No per-record byte alignment.** Contract §4 states this directly: *"The
   per-record byte figures are informational, not a padding rule. The stream is
   continuously bit-packed — `BitWriter`/`BitReader` expose no `align()` and none is
   wanted. A record does not start on a byte boundary, and encoders must not assume
   it does."* This task packs the header, then all 8 kart records, then all
   `entityCount` entity records, fully continuously; the only padding anywhere is
   the implicit zero-padding of the buffer's final partial byte, which
   `BitWriter.byteLength()` already accounts for and which `decodeSnapshot` never
   reads (it stops after the same fields the matching encode wrote).
2. **Entity `velocity` is a full quantised `Vec3` (3×12 bits, `Q.velocity`), not a
   packed single `u16`.** Contract §4 gives the itemised list directly: `entityId
   u16, kind u4, ownerId u3, position 3×u16, velocity 3×u12, heading u12, ttl u16` →
   **135 bits**, and says so explicitly: *"This is 135 bits, not the 13 B an earlier
   draft claimed... Resolved in favour of the itemised list and the locked type:
   entities are interpolated rather than predicted, and real per-axis velocity is
   what makes that interpolation good."* This task honors that itemised list and the
   locked `WireEntity.velocity: Vec3` type exactly; there is no packed-`u16` scheme
   to reconstruct. Step 12 below pins the entity bit count (135) in a test so a
   future "fix" that quietly reintroduces a packed scheme is caught immediately.

**Two more decisions, ordinary ones this file has to make that are not disputes with
the contract:**

3. **`isBot` and `connected` each get their own wire bit — they are never merged.**
   Contract §4 is explicit and deliberate about this: *"`isBot` and `connected` get a
   bit each, deliberately. An earlier draft implied they shared one, which only works
   if `isBot === !connected` always holds. It happens to hold in shipped Plan 1 code,
   but it is an *emergent* property... not an invariant anything enforces — and spec
   §5 has a dropped client's kart 'taken over by a bot' and then 'reclaim[ed] on
   reconnect', which is exactly the transition where the two could legitimately
   disagree for a tick."* `encodeSnapshot` therefore writes `k.isBot` and
   `k.connected` as two independent 1-bit fields, in that row order (`isBot` then
   `connected`, matching contract §4's table), and `decodeSnapshot` reads both back
   independently — neither is ever derived from the other. `applySnapshotToState`
   copies both `WireKart.isBot` and `WireKart.connected` straight into `SimState`,
   so a snapshot genuinely carrying a disagreement (bot-takeover, then a reconnect
   racing the next snapshot) reconciles correctly instead of silently normalising to
   `isBot = !connected`.
4. **`driftActive`+`driftDir` pack into 2 bits as `0`=inactive, `1`=active
   dir=-1, `2`=active dir=1 (`3` unused).** Verified against
   `packages/sim/src/drift.ts`: every branch of `updateDrift` that sets
   `d.active = false` also sets `d.dir = 0` in the same branch (the
   `steeringLocked` early return, the "released with no drift held" branch, and the
   "speed fell below `driftMinSpeed` while active" branch all do this together),
   and `d.dir` is set to a nonzero value only in the one branch that also sets
   `d.active = true`. So only three `(active, dir)` combinations are ever
   reachable, and 2 bits (4 codes) is exactly enough.

**Files:**
- Create: `packages/protocol/src/snapshot.ts`
- Test: `packages/protocol/test/snapshot.test.ts`

**Interfaces:**
- Consumes (from `@tapkart/sim`, already merged):
  - `type Vec3 = { x: number; y: number; z: number }`
  - `type Surface = 'tarmac' | 'dirt' | 'boost' | 'offtrack'`
  - `type ItemKind = 'none' | 'boost' | 'seeker' | 'bolt' | 'slick' | 'bubble' |
    'surge' | 'blink' | 'charge'`
  - `type EntityKind = 'seeker' | 'bolt' | 'slick' | 'bubble' | 'surge' | 'charge'`
  - `interface KartState { playerId; characterIdx; isBot; connected; position;
    velocity; heading; angularVelocity; drift: { active; dir; charge }; item;
    airborne; surface; spinOutTicks; invulnTicks; boostTicks; respawnTicks;
    shielded; lap: { lap; checkpointIdx; t } }`
  - `interface EntityState { entityId; kind; ownerId; position; velocity; heading;
    targetId; ttl }`
  - `interface SimState { tick; phase; raceSeed; rngCursor; nextEventSeq;
    finishTick; karts; entities; entityCount; nextEntityId; itemBoxes;
    finishedOrder; heldBotIntent; heldBotTick }` — the last two fields exist because
    Plan 2 Task 1 (contract §1a) already landed before this task starts.
  - `const MAX_KARTS = 8`, `const MAX_ENTITIES = 32`
- Consumes (from Task 3, `packages/protocol/src/types.ts`) — do not redefine any of
  these, and note that `WireKart`/`WireEntity` are **flat**: `driftCharge`,
  `driftActive`, `driftDir`, `lap`, `checkpointIdx`, `t` are top-level fields on
  `WireKart`, not nested the way `KartState.drift`/`KartState.lap` are:
  ```ts
  interface WireKart {
    playerId: number; position: Vec3; velocity: Vec3; heading: number
    angularVelocity: number; driftCharge: number; driftActive: boolean
    driftDir: -1 | 0 | 1; airborne: boolean; surface: Surface
    spinOutTicks: number; invulnTicks: number; item: ItemKind
    lap: number; checkpointIdx: number; t: number
    isBot: boolean; connected: boolean
    boostTicks: number; respawnTicks: number; shielded: boolean
  }
  interface WireEntity {
    entityId: number; kind: EntityKind; ownerId: number
    position: Vec3; velocity: Vec3; heading: number; ttl: number
  }
  interface WireSnapshot {
    tick: number; eventSeq: number
    lastProcessedInputTick: number[]      // length MAX_KARTS
    karts: WireKart[]                     // length MAX_KARTS
    entities: WireEntity[]                // length MAX_ENTITIES, live packed at front
    entityCount: number
  }
  ```
- Consumes (from Task 4, `packages/protocol/src/bits.ts`): `BitWriter`, `BitReader`
  exactly as that task built them.
- Consumes (from Task 5, `packages/protocol/src/quant.ts`): `Q` (this task never
  needs `EPS` or `quantStep` for its implementation — only its tests, to compute
  round-trip tolerances). `Q` covers only the six continuous fields (`position,
  velocity, heading, angularVelocity, driftCharge, t`); this task sources the
  fourteen exact/enum fields' bit widths itself, as local constants (Step 3).
- Produces (`packages/protocol/src/snapshot.ts`), contract §3:
  ```ts
  export function encodeSnapshot(out: Uint8Array, state: SimState,
                                 lastProcessedInputTick: number[]): number   // bytes written
  export function decodeSnapshot(buf: Uint8Array, out: WireSnapshot): void
  export function applySnapshotToState(snap: WireSnapshot, dst: SimState): void
  ```
  Plus module-private helpers this task defines and does not export (not in the
  contract, so declared here per its own instruction that a task needing something
  absent "must define it in its own files and say so"): `ITEM_KINDS`, `SURFACES`,
  `ENTITY_KINDS` (arrays giving each string-literal enum a wire index, in the exact
  declaration order `packages/sim/src/types.ts` lists them — verified by reading
  that file directly), `packDrift`, `unpackDriftActive`, `unpackDriftDir`, and 22
  bit-width constants named in Step 3: 4 for the entity record (`ENTITY_ID_BITS`,
  etc.), 4 for the header (`HEADER_TICK_BITS`, etc.), and 14 for the per-kart exact
  fields (`SPIN_OUT_TICKS_BITS` through `PLAYER_ID_BITS`) that contract §4 gives no
  `Q`/`EPS` entry to, per Task 5.

**Wire order, stated once here because nothing else in the codebase enforces it and
encode/decode must agree byte-for-byte:** header, then all `MAX_KARTS` kart records
in slot order `0..7` (each kart's 24 fields — `position`/`velocity` count as 3 wire
writes each, x/y/z — in exactly contract §4's row order, listed field-by-field in
Step 3), then `state.entityCount` entity records in their already-packed order.
Header field order is `tick`, `eventSeq`, `lastProcessedInputTick[0..7]`,
`entityCount` — `entityCount` is read *before* the entities so a streaming decoder
knows how many to expect; `WireSnapshot`'s own TypeScript field order (which lists
`entities` before `entityCount`, purely for interface readability) is not the wire
order.

**`lastProcessedInputTick` entries are biased by `+1` on the wire, the same scheme
contract §4a already uses for `AuthEvent.playerId`/`entityId`.** The field is `-1`
for "no real input received yet from this player" (spec §5's definition: the
newest *real*, non-held input the authority had folded in) and unsigned `u16`
otherwise (contract §4). Writing the raw signed value with `writeBits(v, 16)` is
not a round-trip bug in the narrow sense — `BitWriter`/`BitReader` treat `-1` as
`0xFFFF` and read it back as `0xFFFF` — but it silently *relabels* "nothing
received yet" as "the authority's newest real input for this player was tick
65535," which is a different, false claim about the world. Task 9's `events.ts`
already establishes the pattern for exactly this shape of problem: store
`value + 1`, so the sentinel travels as `0` and every real tick `T` travels as
`T + 1`. `encodeSnapshot` therefore writes `lastProcessedInputTick[i] + 1`, and
`decodeSnapshot` reads it back and subtracts `1`. The cost is one representable
tick at the far end of the 16-bit range (`65534` instead of `65535`), matching the
cost Task 9 already accepted for `playerId`/`entityId`. Nothing in Plan 2 compares
against this field yet (contract §0/§5: no task anchors reconciliation on it), so
the bug was latent — but the wire format is still wrong today, and a later plan
that starts reading it inherits a value that means the opposite of what it says.

---

- [ ] **Step 1: Write the failing tests for `encodeSnapshot`/`decodeSnapshot`**

Create `packages/protocol/test/snapshot.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { EntityState, Intent, KartState, SimState } from '@tapkart/sim'
import { MAX_ENTITIES, MAX_KARTS } from '@tapkart/sim'
import type { WireEntity, WireKart, WireSnapshot } from '../src/types'
import { BitWriter } from '../src/bits'
import { Q, quantStep } from '../src/quant'
import { decodeSnapshot, encodeSnapshot } from '../src/snapshot'

// 743 B covers the worst case (MAX_ENTITIES=32 live entities, all 8 karts) with
// margin: header(200) + 8*178 kart bits + 32*135 entity bits = 5944 bits = 743 B
// exactly. 1024 gives headroom above that without needing to be recomputed if a
// field width ever changes by a bit or two.
const BUF_SIZE = 1024

const STEP_POS = quantStep(Q.position.min, Q.position.max, Q.position.bits)
const STEP_VEL = quantStep(Q.velocity.min, Q.velocity.max, Q.velocity.bits)
const STEP_HEADING = quantStep(Q.heading.min, Q.heading.max, Q.heading.bits)
const STEP_ANGVEL = quantStep(Q.angularVelocity.min, Q.angularVelocity.max, Q.angularVelocity.bits)
const STEP_DRIFT_CHARGE = quantStep(Q.driftCharge.min, Q.driftCharge.max, Q.driftCharge.bits)
const STEP_T = quantStep(Q.t.min, Q.t.max, Q.t.bits)

function makeNeutralIntent(): Intent {
  return { tick: 0, steer: 0, accel: 0, brake: false, drift: false, useItem: false }
}

function makeKart(playerId: number): KartState {
  return {
    playerId,
    characterIdx: 0,
    isBot: true,
    connected: false,
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

function makeDeadEntity(): EntityState {
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

function makeState(): SimState {
  const karts: KartState[] = []
  for (let i = 0; i < MAX_KARTS; i++) karts.push(makeKart(i))
  const entities: EntityState[] = []
  for (let i = 0; i < MAX_ENTITIES; i++) entities.push(makeDeadEntity())
  return {
    tick: 0,
    phase: 'racing',
    raceSeed: 0,
    rngCursor: 0,
    nextEventSeq: 0,
    finishTick: -1,
    karts,
    entities,
    entityCount: 0,
    nextEntityId: 1,
    itemBoxes: [],
    finishedOrder: [-1, -1, -1, -1, -1, -1, -1, -1],
    heldBotIntent: Array.from({ length: MAX_KARTS }, makeNeutralIntent),
    heldBotTick: Array.from({ length: MAX_KARTS }, () => -1),
  }
}

function makeWireKart(): WireKart {
  return {
    playerId: 0,
    position: { x: 0, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    heading: 0,
    angularVelocity: 0,
    driftCharge: 0,
    driftActive: false,
    driftDir: 0,
    airborne: false,
    surface: 'tarmac',
    spinOutTicks: 0,
    invulnTicks: 0,
    item: 'none',
    lap: 0,
    checkpointIdx: 0,
    t: 0,
    isBot: true,
    connected: false,
    boostTicks: 0,
    respawnTicks: 0,
    shielded: false,
  }
}

function makeWireEntity(): WireEntity {
  return {
    entityId: -1,
    kind: 'seeker',
    ownerId: -1,
    position: { x: 0, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    heading: 0,
    ttl: 0,
  }
}

function makeEmptySnapshot(): WireSnapshot {
  return {
    tick: 0,
    eventSeq: 0,
    lastProcessedInputTick: new Array(MAX_KARTS).fill(0) as number[],
    karts: Array.from({ length: MAX_KARTS }, makeWireKart),
    entities: Array.from({ length: MAX_ENTITIES }, makeWireEntity),
    entityCount: 0,
  }
}

describe('encodeSnapshot / decodeSnapshot', () => {
  it('round-trips every kart field, within step for continuous fields, exactly for exact fields', () => {
    const state = makeState()
    state.tick = 12345
    state.nextEventSeq = 42
    const k0 = state.karts[0]
    k0.position = { x: 100.25, y: 3, z: -400.5 }
    k0.velocity = { x: 10, y: -2, z: 5.5 }
    k0.heading = 1.2
    k0.angularVelocity = -3.5
    k0.drift = { active: true, dir: -1, charge: 40 }
    k0.item = 'bolt'
    k0.airborne = true
    k0.surface = 'dirt'
    k0.spinOutTicks = 12
    k0.invulnTicks = 30
    k0.boostTicks = 5
    k0.respawnTicks = 9
    k0.shielded = true
    k0.connected = true
    k0.isBot = false
    k0.lap = { lap: 2, checkpointIdx: 5, t: 0.37 }

    // kart 1 deliberately disagrees: isBot and connected both true. Under a decode
    // that (wrongly) derives isBot as !connected, this combination is unreachable;
    // it is also NOT makeWireKart's default pair (isBot: true, connected: false),
    // so this proves both bits are read off the wire independently rather than one
    // being inferred from the other's default. This is exactly the spec §5
    // transition ("taken over by a bot", "reclaim[ed] on reconnect") where the two
    // can legitimately disagree for a tick.
    const k1 = state.karts[1]
    k1.drift = { active: true, dir: 1, charge: 200 }
    k1.item = 'charge'
    k1.surface = 'boost'
    k1.connected = true
    k1.isBot = true

    const buf = new Uint8Array(BUF_SIZE)
    const lastProcessedInputTick = [100, 101, 0, 0, 0, 0, 0, 0]
    const bytes = encodeSnapshot(buf, state, lastProcessedInputTick)

    const snap = makeEmptySnapshot()
    decodeSnapshot(buf.subarray(0, bytes), snap)

    expect(snap.tick).toBe(12345)
    expect(snap.eventSeq).toBe(42)
    expect(snap.lastProcessedInputTick).toEqual(lastProcessedInputTick)

    const d0 = snap.karts[0]
    expect(Math.abs(d0.position.x - 100.25)).toBeLessThan(STEP_POS)
    expect(Math.abs(d0.position.y - 3)).toBeLessThan(STEP_POS)
    expect(Math.abs(d0.position.z - -400.5)).toBeLessThan(STEP_POS)
    expect(Math.abs(d0.velocity.x - 10)).toBeLessThan(STEP_VEL)
    expect(Math.abs(d0.velocity.y - -2)).toBeLessThan(STEP_VEL)
    expect(Math.abs(d0.velocity.z - 5.5)).toBeLessThan(STEP_VEL)
    expect(Math.abs(d0.heading - 1.2)).toBeLessThan(STEP_HEADING)
    expect(Math.abs(d0.angularVelocity - -3.5)).toBeLessThan(STEP_ANGVEL)
    expect(Math.abs(d0.driftCharge - 40)).toBeLessThan(STEP_DRIFT_CHARGE)
    expect(Math.abs(d0.t - 0.37)).toBeLessThan(STEP_T)
    expect(d0.driftActive).toBe(true)
    expect(d0.driftDir).toBe(-1)
    expect(d0.item).toBe('bolt')
    expect(d0.airborne).toBe(true)
    expect(d0.surface).toBe('dirt')
    expect(d0.spinOutTicks).toBe(12)
    expect(d0.invulnTicks).toBe(30)
    expect(d0.boostTicks).toBe(5)
    expect(d0.respawnTicks).toBe(9)
    expect(d0.shielded).toBe(true)
    expect(d0.connected).toBe(true)
    expect(d0.isBot).toBe(false)
    expect(d0.lap).toBe(2)
    expect(d0.checkpointIdx).toBe(5)
    expect(d0.playerId).toBe(0)

    const d1 = snap.karts[1]
    expect(d1.driftActive).toBe(true)
    expect(d1.driftDir).toBe(1)
    expect(d1.item).toBe('charge')
    expect(d1.surface).toBe('boost')
    // Both true: proves connected did not decode as !isBot, and vice versa.
    expect(d1.connected).toBe(true)
    expect(d1.isBot).toBe(true)
    // kart 0's playerId (0) is tautological -- it equals both the slot index and
    // WireKart's own default. kart 1's playerId (1) is neither, so this is the
    // assertion that actually proves playerId is read off the wire.
    expect(d1.playerId).toBe(1)
  })

  it('round-trips every continuous kart field at both range endpoints exactly', () => {
    const state = makeState()
    const k = state.karts[0]
    k.position = { x: -1024, y: 1024, z: -1024 }
    k.velocity = { x: -64, y: 64, z: -64 }
    k.heading = -Math.PI
    k.angularVelocity = 16
    k.drift.charge = 255
    // t's range is [0, 1); 1 is the upper endpoint writeFloatQ clamps to and
    // quantises exactly. 0 would coincide with makeWireKart's default and prove
    // nothing about decode actually running.
    k.lap.t = 1

    const buf = new Uint8Array(BUF_SIZE)
    const bytes = encodeSnapshot(buf, state, new Array(MAX_KARTS).fill(0))
    const snap = makeEmptySnapshot()
    decodeSnapshot(buf.subarray(0, bytes), snap)

    const d = snap.karts[0]
    expect(d.position).toEqual({ x: -1024, y: 1024, z: -1024 })
    expect(d.velocity).toEqual({ x: -64, y: 64, z: -64 })
    expect(d.heading).toBe(-Math.PI)
    expect(d.angularVelocity).toBe(16)
    expect(d.driftCharge).toBe(255)
    expect(d.t).toBe(1)
  })

  it('clamps out-of-range continuous kart fields instead of wrapping', () => {
    const state = makeState()
    const k = state.karts[0]
    k.position = { x: 5000, y: -5000, z: 0 }
    k.velocity = { x: 100, y: -100, z: 0 }

    const buf = new Uint8Array(BUF_SIZE)
    const bytes = encodeSnapshot(buf, state, new Array(MAX_KARTS).fill(0))
    const snap = makeEmptySnapshot()
    decodeSnapshot(buf.subarray(0, bytes), snap)

    const d = snap.karts[0]
    expect(d.position.x).toBe(1024)
    expect(d.position.y).toBe(-1024)
    expect(d.velocity.x).toBe(64)
    expect(d.velocity.y).toBe(-64)
  })

  it('round-trips live entities packed at the front, sentinels the rest', () => {
    const state = makeState()
    state.entityCount = 2
    state.entities[0] = {
      entityId: 7, kind: 'seeker', ownerId: 3,
      position: { x: 10, y: 0, z: -20 }, velocity: { x: 1, y: 0, z: -1 },
      heading: 0.5, targetId: 4, ttl: 560,
    }
    state.entities[1] = {
      entityId: 8, kind: 'bolt', ownerId: 1,
      position: { x: -5, y: 2, z: 5 }, velocity: { x: -3, y: 0, z: 3 },
      heading: -1.1, targetId: -1, ttl: 30,
    }

    const buf = new Uint8Array(BUF_SIZE)
    const bytes = encodeSnapshot(buf, state, new Array(MAX_KARTS).fill(0))
    const snap = makeEmptySnapshot()
    // Dirty a dead-range slot before decoding, so the tail loop below proves
    // decodeSnapshot actively re-sentinels rather than reading makeWireEntity's
    // already-(-1) default off an untouched object.
    snap.entities[5].entityId = 12345
    decodeSnapshot(buf.subarray(0, bytes), snap)

    expect(snap.entityCount).toBe(2)
    expect(snap.entities[0].entityId).toBe(7)
    expect(snap.entities[0].kind).toBe('seeker')
    expect(snap.entities[0].ownerId).toBe(3)
    expect(Math.abs(snap.entities[0].position.x - 10)).toBeLessThan(STEP_POS)
    expect(Math.abs(snap.entities[0].velocity.z - -1)).toBeLessThan(STEP_VEL)
    expect(Math.abs(snap.entities[0].heading - 0.5)).toBeLessThan(STEP_HEADING)
    expect(snap.entities[0].ttl).toBe(560) // exercises the u8 -> u16 amendment headroom

    expect(snap.entities[1].entityId).toBe(8)
    expect(snap.entities[1].kind).toBe('bolt')

    for (let i = 2; i < MAX_ENTITIES; i++) {
      expect(snap.entities[i].entityId).toBe(-1)
    }
  })

  it('re-sentinels a slot that held a live entity on a previous decode', () => {
    const buf = new Uint8Array(BUF_SIZE)
    const snap = makeEmptySnapshot()

    const busy = makeState()
    busy.entityCount = 1
    busy.entities[0] = {
      entityId: 9, kind: 'slick', ownerId: 2,
      position: { x: 1, y: 0, z: 1 }, velocity: { x: 0, y: 0, z: 0 },
      heading: 0, targetId: -1, ttl: 100,
    }
    let bytes = encodeSnapshot(buf, busy, new Array(MAX_KARTS).fill(0))
    decodeSnapshot(buf.subarray(0, bytes), snap)
    expect(snap.entities[0].entityId).toBe(9)

    const empty = makeState()
    empty.entityCount = 0
    bytes = encodeSnapshot(buf, empty, new Array(MAX_KARTS).fill(0))
    decodeSnapshot(buf.subarray(0, bytes), snap)
    // the same caller-owned `snap` object, decoded into a second time: slot 0 held
    // entity 9 a moment ago and must not still claim to
    expect(snap.entities[0].entityId).toBe(-1)
  })

  it('returns the exact byte count for a given entityCount - no per-record padding', () => {
    const state = makeState()
    state.entityCount = 3
    for (let i = 0; i < 3; i++) state.entities[i] = { ...makeDeadEntity(), entityId: i }
    const buf = new Uint8Array(BUF_SIZE)
    const bytes = encodeSnapshot(buf, state, new Array(MAX_KARTS).fill(0))
    // 200 header bits + 8*178 kart bits + 3*135 entity bits, continuously packed,
    // rounded up once at the very end (this task's settled facts 1 and 2)
    const totalBits = 200 + MAX_KARTS * 178 + 3 * 135
    expect(bytes).toBe(Math.ceil(totalBits / 8))
  })

  it('round-trips at the worst case: MAX_ENTITIES live entities, all karts populated', () => {
    // header(200) + 8*178 kart bits + 32*135 entity bits = 5944 bits = 743 B
    // exactly -- the figure contract §4 and spec §5 both give as the worst case.
    // BitWriter.writeBits silently no-ops past a Uint8Array's end (Task 4), so an
    // undersized buffer here would truncate without ever throwing; this is the one
    // test in this task that would catch it.
    const state = makeState()
    state.entityCount = MAX_ENTITIES
    for (let i = 0; i < MAX_ENTITIES; i++) {
      state.entities[i] = {
        entityId: i + 1, kind: 'seeker', ownerId: i % MAX_KARTS,
        position: { x: i, y: 0, z: -i }, velocity: { x: 1, y: 0, z: -1 },
        heading: 0.1 * i, targetId: -1, ttl: 100 + i,
      }
    }
    const buf = new Uint8Array(BUF_SIZE)
    const bytes = encodeSnapshot(buf, state, new Array(MAX_KARTS).fill(0))
    expect(bytes).toBe(743)

    const snap = makeEmptySnapshot()
    decodeSnapshot(buf.subarray(0, bytes), snap)
    expect(snap.entityCount).toBe(MAX_ENTITIES)
    expect(snap.entities[MAX_ENTITIES - 1].entityId).toBe(MAX_ENTITIES)
    expect(snap.entities[MAX_ENTITIES - 1].ttl).toBe(100 + MAX_ENTITIES - 1)
  })

  it('round-trips the -1 "no real input yet" sentinel in lastProcessedInputTick, biased so it never collides with a real tick', () => {
    // Without the +1 bias, -1 encodes as the raw two's-complement bit pattern
    // BitWriter.writeBits produces for a negative value into 16 bits (0xFFFF)
    // and decodes back as 65535 -- a real (if implausible) tick number, not
    // "nothing received yet". This state's tick/entity contents don't matter;
    // only the header's lastProcessedInputTick array is under test here.
    const state = makeState()
    const buf = new Uint8Array(BUF_SIZE)
    // Mixes the sentinel with real ticks, including one adjacent to the
    // sentinel's own biased wire value (0) and one near the top of the
    // biased range, so an off-by-one in the bias would show up as a specific
    // wrong number rather than a coincidental pass.
    const lastProcessedInputTick = [-1, 0, 1, -1, 65534, -1, -1, -1]
    const bytes = encodeSnapshot(buf, state, lastProcessedInputTick)

    const snap = makeEmptySnapshot()
    decodeSnapshot(buf.subarray(0, bytes), snap)

    expect(snap.lastProcessedInputTick).toEqual(lastProcessedInputTick)
  })

  it('writes header then karts in exactly contract §4 row order, then entities', () => {
    const state = makeState()
    const k = state.karts[3]
    k.position = { x: 50, y: -6, z: 12 }
    k.velocity = { x: 4, y: 1, z: -2 }
    k.heading = -0.3
    k.angularVelocity = 2
    k.drift = { active: true, dir: 1, charge: 90 }
    k.item = 'surge'
    k.airborne = true
    k.surface = 'offtrack'
    k.spinOutTicks = 3
    k.invulnTicks = 20
    k.boostTicks = 60
    k.respawnTicks = 40
    k.lap = { lap: 1, checkpointIdx: 4, t: 0.8 }
    k.shielded = true
    k.connected = true
    k.isBot = false

    const buf = new Uint8Array(BUF_SIZE)
    const lastProcessedInputTick = [1, 2, 3, 4, 5, 6, 7, 8]
    const bytes = encodeSnapshot(buf, state, lastProcessedInputTick)

    // Independently reconstruct the same message with the raw primitives, in
    // exactly contract §4's row order - this is the specification, not a restated
    // guess at the implementation's internals.
    const ITEM_KINDS = ['none', 'boost', 'seeker', 'bolt', 'slick', 'bubble', 'surge', 'blink', 'charge']
    const SURFACES = ['tarmac', 'dirt', 'boost', 'offtrack']
    const ref = new Uint8Array(BUF_SIZE)
    const rw = new BitWriter(ref)
    rw.writeBits(state.tick, 32)
    rw.writeBits(state.nextEventSeq, 32)
    // +1-biased, same as encodeSnapshot: -1 travels as 0.
    for (let i = 0; i < MAX_KARTS; i++) rw.writeBits(lastProcessedInputTick[i] + 1, 16)
    rw.writeBits(state.entityCount, 8)
    for (let i = 0; i < MAX_KARTS; i++) {
      const kk = state.karts[i]
      rw.writeFloatQ(kk.position.x, Q.position.min, Q.position.max, Q.position.bits)
      rw.writeFloatQ(kk.position.y, Q.position.min, Q.position.max, Q.position.bits)
      rw.writeFloatQ(kk.position.z, Q.position.min, Q.position.max, Q.position.bits)
      rw.writeFloatQ(kk.velocity.x, Q.velocity.min, Q.velocity.max, Q.velocity.bits)
      rw.writeFloatQ(kk.velocity.y, Q.velocity.min, Q.velocity.max, Q.velocity.bits)
      rw.writeFloatQ(kk.velocity.z, Q.velocity.min, Q.velocity.max, Q.velocity.bits)
      rw.writeFloatQ(kk.heading, Q.heading.min, Q.heading.max, Q.heading.bits)
      rw.writeFloatQ(kk.angularVelocity, Q.angularVelocity.min, Q.angularVelocity.max, Q.angularVelocity.bits)
      rw.writeFloatQ(kk.drift.charge, Q.driftCharge.min, Q.driftCharge.max, Q.driftCharge.bits)
      rw.writeFloatQ(kk.lap.t, Q.t.min, Q.t.max, Q.t.bits)
      rw.writeBits(kk.spinOutTicks, 8)
      rw.writeBits(kk.invulnTicks, 8)
      rw.writeBits(kk.boostTicks, 7)
      rw.writeBits(kk.respawnTicks, 7)
      rw.writeBits(kk.lap.lap, 3)
      rw.writeBits(kk.lap.checkpointIdx, 6)
      rw.writeBits(ITEM_KINDS.indexOf(kk.item), 4)
      rw.writeBits(SURFACES.indexOf(kk.surface), 2)
      rw.writeBits(!kk.drift.active ? 0 : kk.drift.dir === -1 ? 1 : 2, 2)
      rw.writeBits(kk.airborne ? 1 : 0, 1)
      rw.writeBits(kk.shielded ? 1 : 0, 1)
      rw.writeBits(kk.isBot ? 1 : 0, 1)
      rw.writeBits(kk.connected ? 1 : 0, 1)
      rw.writeBits(kk.playerId, 3)
    }

    expect(bytes).toBe(rw.byteLength())
    expect(Array.from(buf.subarray(0, bytes))).toEqual(Array.from(ref.subarray(0, bytes)))
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/protocol/test/snapshot.test.ts`

Expected: FAIL — suite fails to load, under "Failed Suites":
`Error: Cannot find module '../src/snapshot' imported from
'<repo>/packages/protocol/test/snapshot.test.ts'`. Zero tests
collected (`src/snapshot.ts` does not exist yet).

- [ ] **Step 3: Write `encodeSnapshot` and `decodeSnapshot`**

Create `packages/protocol/src/snapshot.ts`:

```ts
import type { EntityKind, ItemKind, SimState, Surface } from '@tapkart/sim'
import { MAX_ENTITIES, MAX_KARTS } from '@tapkart/sim'
import type { WireSnapshot } from './types'
import { BitReader, BitWriter } from './bits'
import { Q } from './quant'

// WireKart and WireEntity are never named directly in this file: `out.karts[i]`
// and `out.entities[i]` are inferred through WireSnapshot's own field types, and
// `noUnusedLocals` (tsconfig.base.json) rejects an import that is never
// referenced by name - only WireSnapshot itself is written as a type annotation
// below.

// Enum <-> wire-index tables. Order matches packages/sim/src/types.ts exactly
// (verified by reading that file): a reorder there without a matching reorder
// here silently relabels every item/surface/entity kind on the wire.
const ITEM_KINDS: ItemKind[] = [
  'none', 'boost', 'seeker', 'bolt', 'slick', 'bubble', 'surge', 'blink', 'charge',
]
const SURFACES: Surface[] = ['tarmac', 'dirt', 'boost', 'offtrack']
const ENTITY_KINDS: EntityKind[] = ['seeker', 'bolt', 'slick', 'bubble', 'surge', 'charge']

// Entity and header fields are plain fixed-width integers with no epsilon concept:
// sourced here as literals straight from contract §4's prose, not through Q, which
// covers only the six continuous per-kart fields.
const ENTITY_ID_BITS = 16
const ENTITY_KIND_BITS = 4
const ENTITY_OWNER_BITS = 3
const ENTITY_TTL_BITS = 16
const HEADER_TICK_BITS = 32
const HEADER_EVENT_SEQ_BITS = 32
const HEADER_LAST_INPUT_TICK_BITS = 16
const HEADER_ENTITY_COUNT_BITS = 8

// The fourteen exact/enum per-kart fields contract §4 gives no Q/EPS entry to
// (Task 5): no quantisation noise, so no epsilon, and the widths live here as
// literals in exactly contract §4's row order.
const SPIN_OUT_TICKS_BITS = 8
const INVULN_TICKS_BITS = 8
const BOOST_TICKS_BITS = 7
const RESPAWN_TICKS_BITS = 7
const LAP_BITS = 3
const CHECKPOINT_IDX_BITS = 6
const ITEM_BITS = 4
const SURFACE_BITS = 2
const DRIFT_PACKED_BITS = 2
const AIRBORNE_BITS = 1
const SHIELDED_BITS = 1
const IS_BOT_BITS = 1
const CONNECTED_BITS = 1
const PLAYER_ID_BITS = 3

/** driftActive+driftDir -> 2 raw bits. 0 = inactive, 1 = active dir -1, 2 = active
 * dir 1. 3 is unused: packages/sim/src/drift.ts never produces dir != 0 while
 * inactive (this task's decision 4). */
function packDrift(active: boolean, dir: -1 | 0 | 1): number {
  if (!active) return 0
  return dir === -1 ? 1 : 2
}

function unpackDriftActive(raw: number): boolean {
  return raw !== 0
}

function unpackDriftDir(raw: number): -1 | 0 | 1 {
  if (raw === 0) return 0
  return raw === 1 ? -1 : 1
}

/**
 * Projects `state` onto the wire. Writes the header, then all MAX_KARTS kart
 * records in slot order (each one's fields in exactly contract §4's row order),
 * then `state.entityCount` entity records (only the live ones - dead slots are
 * never written, which is why a typical snapshot is far smaller than the
 * MAX_ENTITIES worst case). Returns the number of bytes written.
 */
export function encodeSnapshot(
  out: Uint8Array,
  state: SimState,
  lastProcessedInputTick: number[],
): number {
  const bw = new BitWriter(out)

  bw.writeBits(state.tick, HEADER_TICK_BITS)
  bw.writeBits(state.nextEventSeq, HEADER_EVENT_SEQ_BITS)
  for (let i = 0; i < MAX_KARTS; i++) {
    // Biased by +1, same scheme as AuthEvent.playerId/entityId (Task 9): -1
    // ("no real input yet") travels as 0, and real tick T travels as T + 1.
    // An unbiased write would make -1 indistinguishable from "the newest real
    // input was tick 65535" on the wire.
    bw.writeBits(lastProcessedInputTick[i] + 1, HEADER_LAST_INPUT_TICK_BITS)
  }
  bw.writeBits(state.entityCount, HEADER_ENTITY_COUNT_BITS)

  for (let i = 0; i < MAX_KARTS; i++) {
    const k = state.karts[i]
    bw.writeFloatQ(k.position.x, Q.position.min, Q.position.max, Q.position.bits)
    bw.writeFloatQ(k.position.y, Q.position.min, Q.position.max, Q.position.bits)
    bw.writeFloatQ(k.position.z, Q.position.min, Q.position.max, Q.position.bits)
    bw.writeFloatQ(k.velocity.x, Q.velocity.min, Q.velocity.max, Q.velocity.bits)
    bw.writeFloatQ(k.velocity.y, Q.velocity.min, Q.velocity.max, Q.velocity.bits)
    bw.writeFloatQ(k.velocity.z, Q.velocity.min, Q.velocity.max, Q.velocity.bits)
    bw.writeFloatQ(k.heading, Q.heading.min, Q.heading.max, Q.heading.bits)
    bw.writeFloatQ(k.angularVelocity, Q.angularVelocity.min, Q.angularVelocity.max, Q.angularVelocity.bits)
    bw.writeFloatQ(k.drift.charge, Q.driftCharge.min, Q.driftCharge.max, Q.driftCharge.bits)
    bw.writeFloatQ(k.lap.t, Q.t.min, Q.t.max, Q.t.bits)
    bw.writeBits(k.spinOutTicks, SPIN_OUT_TICKS_BITS)
    bw.writeBits(k.invulnTicks, INVULN_TICKS_BITS)
    bw.writeBits(k.boostTicks, BOOST_TICKS_BITS)
    bw.writeBits(k.respawnTicks, RESPAWN_TICKS_BITS)
    bw.writeBits(k.lap.lap, LAP_BITS)
    bw.writeBits(k.lap.checkpointIdx, CHECKPOINT_IDX_BITS)
    bw.writeBits(ITEM_KINDS.indexOf(k.item), ITEM_BITS)
    bw.writeBits(SURFACES.indexOf(k.surface), SURFACE_BITS)
    bw.writeBits(packDrift(k.drift.active, k.drift.dir), DRIFT_PACKED_BITS)
    bw.writeBits(k.airborne ? 1 : 0, AIRBORNE_BITS)
    bw.writeBits(k.shielded ? 1 : 0, SHIELDED_BITS)
    // isBot and connected are two independent bits (contract §4, this task's
    // decision 3) -- neither is ever derived from the other.
    bw.writeBits(k.isBot ? 1 : 0, IS_BOT_BITS)
    bw.writeBits(k.connected ? 1 : 0, CONNECTED_BITS)
    bw.writeBits(k.playerId, PLAYER_ID_BITS)
  }

  for (let i = 0; i < state.entityCount; i++) {
    const e = state.entities[i]
    bw.writeBits(e.entityId, ENTITY_ID_BITS)
    bw.writeBits(ENTITY_KINDS.indexOf(e.kind), ENTITY_KIND_BITS)
    bw.writeBits(e.ownerId, ENTITY_OWNER_BITS)
    bw.writeFloatQ(e.position.x, Q.position.min, Q.position.max, Q.position.bits)
    bw.writeFloatQ(e.position.y, Q.position.min, Q.position.max, Q.position.bits)
    bw.writeFloatQ(e.position.z, Q.position.min, Q.position.max, Q.position.bits)
    bw.writeFloatQ(e.velocity.x, Q.velocity.min, Q.velocity.max, Q.velocity.bits)
    bw.writeFloatQ(e.velocity.y, Q.velocity.min, Q.velocity.max, Q.velocity.bits)
    bw.writeFloatQ(e.velocity.z, Q.velocity.min, Q.velocity.max, Q.velocity.bits)
    bw.writeFloatQ(e.heading, Q.heading.min, Q.heading.max, Q.heading.bits)
    bw.writeBits(e.ttl, ENTITY_TTL_BITS)
  }

  return bw.byteLength()
}

/**
 * Reverses encodeSnapshot into a caller-owned, reused `out`. `out.karts` (length
 * MAX_KARTS) and `out.entities` (length MAX_ENTITIES) are never resized - every
 * field of every element is overwritten in place, field by field, the same
 * "shared scratch" discipline `TrackQuery` uses in packages/sim.
 *
 * Entities from `entityCount` to MAX_ENTITIES - 1 are sentineled on every call
 * (entityId -1, matching packages/sim/src/entity.ts's own dead-slot convention
 * minus targetId, which WireEntity does not carry) - not just when `out` is fresh,
 * because `out` is reused across many decode calls and a slot that held a live
 * entity a moment ago must not keep claiming to.
 */
export function decodeSnapshot(buf: Uint8Array, out: WireSnapshot): void {
  const br = new BitReader(buf)

  out.tick = br.readBits(HEADER_TICK_BITS)
  out.eventSeq = br.readBits(HEADER_EVENT_SEQ_BITS)
  for (let i = 0; i < MAX_KARTS; i++) {
    // Inverse of encodeSnapshot's +1 bias: wire 0 -> -1 ("no real input yet"),
    // wire T + 1 -> real tick T.
    out.lastProcessedInputTick[i] = br.readBits(HEADER_LAST_INPUT_TICK_BITS) - 1
  }
  const entityCount = br.readBits(HEADER_ENTITY_COUNT_BITS)
  out.entityCount = entityCount

  for (let i = 0; i < MAX_KARTS; i++) {
    const k = out.karts[i]
    k.position.x = br.readFloatQ(Q.position.min, Q.position.max, Q.position.bits)
    k.position.y = br.readFloatQ(Q.position.min, Q.position.max, Q.position.bits)
    k.position.z = br.readFloatQ(Q.position.min, Q.position.max, Q.position.bits)
    k.velocity.x = br.readFloatQ(Q.velocity.min, Q.velocity.max, Q.velocity.bits)
    k.velocity.y = br.readFloatQ(Q.velocity.min, Q.velocity.max, Q.velocity.bits)
    k.velocity.z = br.readFloatQ(Q.velocity.min, Q.velocity.max, Q.velocity.bits)
    k.heading = br.readFloatQ(Q.heading.min, Q.heading.max, Q.heading.bits)
    k.angularVelocity = br.readFloatQ(Q.angularVelocity.min, Q.angularVelocity.max, Q.angularVelocity.bits)
    k.driftCharge = br.readFloatQ(Q.driftCharge.min, Q.driftCharge.max, Q.driftCharge.bits)
    k.t = br.readFloatQ(Q.t.min, Q.t.max, Q.t.bits)
    k.spinOutTicks = br.readBits(SPIN_OUT_TICKS_BITS)
    k.invulnTicks = br.readBits(INVULN_TICKS_BITS)
    k.boostTicks = br.readBits(BOOST_TICKS_BITS)
    k.respawnTicks = br.readBits(RESPAWN_TICKS_BITS)
    k.lap = br.readBits(LAP_BITS)
    k.checkpointIdx = br.readBits(CHECKPOINT_IDX_BITS)
    k.item = ITEM_KINDS[br.readBits(ITEM_BITS)]
    k.surface = SURFACES[br.readBits(SURFACE_BITS)]
    const driftRaw = br.readBits(DRIFT_PACKED_BITS)
    k.driftActive = unpackDriftActive(driftRaw)
    k.driftDir = unpackDriftDir(driftRaw)
    k.airborne = br.readBits(AIRBORNE_BITS) !== 0
    k.shielded = br.readBits(SHIELDED_BITS) !== 0
    // Two independent reads -- neither is derived from the other (decision 3).
    k.isBot = br.readBits(IS_BOT_BITS) !== 0
    k.connected = br.readBits(CONNECTED_BITS) !== 0
    k.playerId = br.readBits(PLAYER_ID_BITS)
  }

  for (let i = 0; i < entityCount; i++) {
    const e = out.entities[i]
    e.entityId = br.readBits(ENTITY_ID_BITS)
    e.kind = ENTITY_KINDS[br.readBits(ENTITY_KIND_BITS)]
    e.ownerId = br.readBits(ENTITY_OWNER_BITS)
    e.position.x = br.readFloatQ(Q.position.min, Q.position.max, Q.position.bits)
    e.position.y = br.readFloatQ(Q.position.min, Q.position.max, Q.position.bits)
    e.position.z = br.readFloatQ(Q.position.min, Q.position.max, Q.position.bits)
    e.velocity.x = br.readFloatQ(Q.velocity.min, Q.velocity.max, Q.velocity.bits)
    e.velocity.y = br.readFloatQ(Q.velocity.min, Q.velocity.max, Q.velocity.bits)
    e.velocity.z = br.readFloatQ(Q.velocity.min, Q.velocity.max, Q.velocity.bits)
    e.heading = br.readFloatQ(Q.heading.min, Q.heading.max, Q.heading.bits)
    e.ttl = br.readBits(ENTITY_TTL_BITS)
  }
  for (let i = entityCount; i < MAX_ENTITIES; i++) {
    const e = out.entities[i]
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
    e.ttl = 0
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/protocol/test/snapshot.test.ts`

Expected: PASS — 9 passed.

---

- [ ] **Step 5: Write the failing tests for `applySnapshotToState`**

Append to `packages/protocol/test/snapshot.test.ts`. First widen the import from
`../src/snapshot` at the top of the file to:

```ts
import { applySnapshotToState, decodeSnapshot, encodeSnapshot } from '../src/snapshot'
```

Then append this block at the end of the file:

```ts
describe('applySnapshotToState', () => {
  it('copies every WireKart field into the matching nested SimState field', () => {
    const source = makeState()
    const k = source.karts[2]
    k.position = { x: 11, y: 2, z: -33 }
    k.velocity = { x: 1, y: 0, z: -1 }
    k.heading = 0.9
    k.angularVelocity = -1
    k.drift = { active: true, dir: -1, charge: 15 }
    k.item = 'bubble'
    k.airborne = true
    k.surface = 'dirt'
    k.spinOutTicks = 7
    k.invulnTicks = 3
    k.boostTicks = 20
    // 0 would coincide with makeKart's default and dst's own starting value,
    // proving nothing about whether this field was actually copied.
    k.respawnTicks = 15
    k.shielded = true
    k.connected = true
    k.isBot = false
    k.lap = { lap: 1, checkpointIdx: 2, t: 0.6 }

    const buf = new Uint8Array(BUF_SIZE)
    const bytes = encodeSnapshot(buf, source, new Array(MAX_KARTS).fill(0))
    const snap = makeEmptySnapshot()
    decodeSnapshot(buf.subarray(0, bytes), snap)

    const dst = makeState()
    applySnapshotToState(snap, dst)

    const dk = dst.karts[2]
    expect(Math.abs(dk.position.x - 11)).toBeLessThan(STEP_POS)
    expect(Math.abs(dk.velocity.z - -1)).toBeLessThan(STEP_VEL)
    expect(Math.abs(dk.heading - 0.9)).toBeLessThan(STEP_HEADING)
    expect(Math.abs(dk.angularVelocity - -1)).toBeLessThan(STEP_ANGVEL)
    expect(dk.drift.active).toBe(true)
    expect(dk.drift.dir).toBe(-1)
    expect(Math.abs(dk.drift.charge - 15)).toBeLessThan(STEP_DRIFT_CHARGE)
    expect(dk.item).toBe('bubble')
    expect(dk.airborne).toBe(true)
    expect(dk.surface).toBe('dirt')
    expect(dk.spinOutTicks).toBe(7)
    expect(dk.invulnTicks).toBe(3)
    expect(dk.boostTicks).toBe(20)
    expect(dk.respawnTicks).toBe(15)
    expect(dk.shielded).toBe(true)
    expect(dk.connected).toBe(true)
    expect(dk.isBot).toBe(false)
    expect(dk.lap.lap).toBe(1)
    expect(dk.lap.checkpointIdx).toBe(2)
    expect(Math.abs(dk.lap.t - 0.6)).toBeLessThan(STEP_T)
  })

  it('copies every WireEntity field except targetId, which the wire does not carry', () => {
    const source = makeState()
    source.entityCount = 1
    source.entities[0] = {
      entityId: 5, kind: 'charge', ownerId: 2,
      position: { x: 3, y: 0, z: 4 }, velocity: { x: 0, y: 0, z: 1 },
      heading: 1, targetId: 6, ttl: 200,
    }
    const buf = new Uint8Array(BUF_SIZE)
    const bytes = encodeSnapshot(buf, source, new Array(MAX_KARTS).fill(0))
    const snap = makeEmptySnapshot()
    decodeSnapshot(buf.subarray(0, bytes), snap)

    const dst = makeState()
    dst.entities[0].targetId = 999 // marker: not on the wire, must survive untouched

    applySnapshotToState(snap, dst)

    expect(dst.entityCount).toBe(1)
    expect(dst.entities[0].entityId).toBe(5)
    expect(dst.entities[0].kind).toBe('charge')
    expect(dst.entities[0].ownerId).toBe(2)
    expect(Math.abs(dst.entities[0].position.z - 4)).toBeLessThan(STEP_POS)
    expect(dst.entities[0].ttl).toBe(200)
    expect(dst.entities[0].targetId).toBe(999)
  })

  it('resets a re-sentinelled entity slot\'s targetId to -1, matching entity.ts\'s clearSlot convention', () => {
    // A dead slot on the wire (entityId === -1) carries no targetId at all -
    // WireEntity has no such field - but the DESTINATION slot may still hold
    // one left over from an earlier decode, when it was a live seeker homing
    // on some kart. Left alone, a shadow that reconciles right after that
    // seeker despawns (Task 16's ShadowLoop.reconcile calls this function
    // directly) would carry a targetId referencing a kart no entity in the
    // decoded state is actually homing on - residue entity.ts's own
    // clearSlot() would never produce for a real dead slot.
    const source = makeState()
    source.entityCount = 0 // nothing live on the wire
    const buf = new Uint8Array(BUF_SIZE)
    const bytes = encodeSnapshot(buf, source, new Array(MAX_KARTS).fill(0))
    const snap = makeEmptySnapshot()
    decodeSnapshot(buf.subarray(0, bytes), snap)
    expect(snap.entities[0].entityId).toBe(-1)

    const dst = makeState()
    // Marker: simulates the slot's leftover state from an earlier decode that
    // held a live seeker targeting kart 5. Not -1, so a fix-free run leaves it
    // exactly here rather than by coincidence landing on the right answer.
    dst.entities[0].targetId = 5

    applySnapshotToState(snap, dst)

    expect(dst.entities[0].entityId).toBe(-1)
    expect(dst.entities[0].targetId).toBe(-1)
  })

  it('writes tick and entityCount, since both are carried on the wire', () => {
    const source = makeState()
    source.tick = 777
    // Nonzero and different from dst's starting value below, so this proves a
    // real copy rather than two defaults happening to agree at 0.
    source.entityCount = 4
    const buf = new Uint8Array(BUF_SIZE)
    const bytes = encodeSnapshot(buf, source, new Array(MAX_KARTS).fill(0))
    const snap = makeEmptySnapshot()
    decodeSnapshot(buf.subarray(0, bytes), snap)

    const dst = makeState()
    dst.tick = 1
    dst.entityCount = 1
    applySnapshotToState(snap, dst)
    expect(dst.tick).toBe(777)
    expect(dst.entityCount).toBe(4)
  })

  it('does not touch any field the wire does not carry, while still writing the fields it does', () => {
    const source = makeState()
    // A positive companion to the negative checks below: proves this function
    // does something, not just that it leaves the exclusion list alone (a
    // complete no-op would otherwise pass every assertion in this test).
    source.tick = 999
    const buf = new Uint8Array(BUF_SIZE)
    const bytes = encodeSnapshot(buf, source, new Array(MAX_KARTS).fill(0))
    const snap = makeEmptySnapshot()
    decodeSnapshot(buf.subarray(0, bytes), snap)

    const dst = makeState()
    dst.rngCursor = 999
    dst.nextEventSeq = 888
    dst.nextEntityId = 777
    dst.itemBoxes = [{ boxIdx: 0, respawnTicks: 42 }]
    dst.finishedOrder = [3, -1, -1, -1, -1, -1, -1, -1]
    dst.phase = 'finished'
    dst.finishTick = 555
    dst.raceSeed = 333
    dst.heldBotIntent = dst.heldBotIntent.map((intent, i) =>
      i === 0 ? { ...intent, tick: 111 } : intent,
    )
    dst.heldBotTick = dst.heldBotTick.map((t, i) => (i === 0 ? 222 : t))
    dst.karts[0].characterIdx = 6

    applySnapshotToState(snap, dst)

    expect(dst.tick).toBe(999)
    expect(dst.rngCursor).toBe(999)
    expect(dst.nextEventSeq).toBe(888)
    expect(dst.nextEntityId).toBe(777)
    expect(dst.itemBoxes).toEqual([{ boxIdx: 0, respawnTicks: 42 }])
    expect(dst.finishedOrder).toEqual([3, -1, -1, -1, -1, -1, -1, -1])
    expect(dst.phase).toBe('finished')
    expect(dst.finishTick).toBe(555)
    expect(dst.raceSeed).toBe(333)
    expect(dst.heldBotIntent[0].tick).toBe(111)
    expect(dst.heldBotTick[0]).toBe(222)
    expect(dst.karts[0].characterIdx).toBe(6)
  })
})
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `npx vitest run packages/protocol/test/snapshot.test.ts -t "applySnapshotToState"`

Expected: FAIL — `TypeError: (0 , applySnapshotToState) is not a function`.
(`encodeSnapshot`/`decodeSnapshot` already exist and work from Step 3; the imported
`applySnapshotToState` binding is `undefined` because `src/snapshot.ts` does not
export it yet, and calling it throws this at the call site.)

- [ ] **Step 7: Write `applySnapshotToState`**

Append to the end of `packages/protocol/src/snapshot.ts`:

```ts
/**
 * Writes the fields a WireSnapshot carries into `dst`, and nothing else. Does
 * NOT touch: rngCursor, nextEventSeq, nextEntityId, itemBoxes, finishedOrder,
 * phase, finishTick, heldBotIntent, heldBotTick (none of these have wire data -
 * contract §0's "a follower's nextEventSeq is advanced only by applying received
 * events" is exactly why nextEventSeq is on this list despite snap.eventSeq
 * existing; that field is for the caller to read directly off the decoded
 * WireSnapshot, not to be replayed into SimState here), nor raceSeed
 * (WireSnapshot has no such field) nor karts[i].characterIdx (deliberately absent
 * from the wire, contract §1c/§5). DOES write dst.tick and dst.entityCount - both
 * are carried on the wire and neither is on the exclusion list. Writes k.isBot
 * and k.connected as two independent fields (decision 3) - a snapshot that
 * genuinely carries them disagreeing (bot-takeover racing a reconnect)
 * reconciles correctly.
 *
 * entities[i].targetId is a partial exception, not a blanket one: WireEntity
 * has no such field, so a LIVE slot's targetId is left exactly as this
 * function found it (still correct - there is no wire data to prefer either
 * way). A DEAD slot (wire entityId === -1) is different: entity.ts's
 * clearSlot() always pairs entityId === -1 with targetId === -1, and this
 * function is the only place with both the dead-slot signal (from the wire)
 * and a targetId field to clear (WireEntity has none) - decodeSnapshot's own
 * re-sentinelling cannot reach it. Leaving it alone here means a slot that
 * held a live seeker on an earlier decode keeps that seeker's old targetId
 * after the seeker despawns and the slot goes dead - residue with no wire
 * representation, consumed downstream by ShadowLoop.reconcile (Task 16).
 */
export function applySnapshotToState(snap: WireSnapshot, dst: SimState): void {
  dst.tick = snap.tick
  dst.entityCount = snap.entityCount

  for (let i = 0; i < MAX_KARTS; i++) {
    const s = snap.karts[i]
    const k = dst.karts[i]
    k.playerId = s.playerId
    k.isBot = s.isBot
    k.connected = s.connected
    k.position.x = s.position.x
    k.position.y = s.position.y
    k.position.z = s.position.z
    k.velocity.x = s.velocity.x
    k.velocity.y = s.velocity.y
    k.velocity.z = s.velocity.z
    k.heading = s.heading
    k.angularVelocity = s.angularVelocity
    k.drift.active = s.driftActive
    k.drift.dir = s.driftDir
    k.drift.charge = s.driftCharge
    k.item = s.item
    k.airborne = s.airborne
    k.surface = s.surface
    k.spinOutTicks = s.spinOutTicks
    k.invulnTicks = s.invulnTicks
    k.boostTicks = s.boostTicks
    k.respawnTicks = s.respawnTicks
    k.shielded = s.shielded
    k.lap.lap = s.lap
    k.lap.checkpointIdx = s.checkpointIdx
    k.lap.t = s.t
    // k.characterIdx: deliberately untouched, see this function's docstring
  }

  for (let i = 0; i < MAX_ENTITIES; i++) {
    const s = snap.entities[i]
    const e = dst.entities[i]
    e.entityId = s.entityId
    e.kind = s.kind
    e.ownerId = s.ownerId
    e.position.x = s.position.x
    e.position.y = s.position.y
    e.position.z = s.position.z
    e.velocity.x = s.velocity.x
    e.velocity.y = s.velocity.y
    e.velocity.z = s.velocity.z
    e.heading = s.heading
    e.ttl = s.ttl
    // e.targetId: WireEntity carries no such field, so a LIVE slot's targetId
    // is left exactly as this function found it (see docstring). A DEAD slot
    // (entityId === -1) is different: entity.ts's clearSlot() always pairs
    // entityId === -1 with targetId === -1, and a slot that held a live
    // seeker on a previous decode must not keep claiming to target a kart
    // once the wire says the slot is empty - re-sentinel it here, the same
    // convention decodeSnapshot already applies to entityId/position/etc for
    // dead slots (that function just has no targetId field to do it with).
    if (s.entityId === -1) e.targetId = -1
  }
}
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `npx vitest run packages/protocol/test/snapshot.test.ts`

Expected: PASS — 14 passed (9 from `encodeSnapshot`/`decodeSnapshot`, 5 from
`applySnapshotToState`).

---

- [ ] **Step 9: Typecheck and run the whole protocol suite**

Run: `npx tsc --noEmit -p packages/protocol && npx vitest run packages/protocol`

Expected: PASS — no TypeScript errors; `snapshot.test.ts` 14 passed, plus Tasks 3,
4 and 5's tests (`types.test.ts` 13, `bits.test.ts` 14, `quant.test.ts` 13).

---

- [ ] **Step 10: Write the failing test — `encodeSnapshot`, `decodeSnapshot`, `applySnapshotToState` reachable through the barrel**

Contract §3: "The barrel exists from Task 3, not Task 18" — by the time this task
runs, `packages/protocol/src/index.ts` re-exports `./types`, `./bits` and `./quant`
(Tasks 3-5). This task's module is `snapshot.ts`; appending its own line is this
task's last implementation step, exactly as Plan 1's Tasks 3-10 each did for
`@tapkart/sim/src/index.ts`, so `packages/net` can `import ... from
'@tapkart/protocol'` from Task 11 onward without waiting for Task 18.

Append to `packages/protocol/test/snapshot.test.ts`, after the closing `})` of
`describe('applySnapshotToState', ...)`:

```ts
describe('@tapkart/protocol barrel', () => {
  it('re-exports encodeSnapshot, decodeSnapshot and applySnapshotToState', async () => {
    const pkg = await import('@tapkart/protocol')
    expect(typeof pkg.encodeSnapshot).toBe('function')
    expect(typeof pkg.decodeSnapshot).toBe('function')
    expect(typeof pkg.applySnapshotToState).toBe('function')
  })
})
```

This is a dynamic import, matching Task 3's own barrel test in `types.test.ts` and
`packages/sim/test/barrel.test.ts`'s `'resolves through the @tapkart/sim package entry
point'` test, so a resolution failure fails this one test rather than the whole file.

- [ ] **Step 11: Run the test to verify it fails**

Run: `npx vitest run packages/protocol/test/snapshot.test.ts -t "re-exports encodeSnapshot, decodeSnapshot and applySnapshotToState"`

Expected: FAIL — `packages/protocol/src/index.ts` does not yet re-export
`./snapshot`, so the dynamically-imported package object has no `encodeSnapshot`
property: `AssertionError: expected 'undefined' to be 'function'` at
`expect(typeof pkg.encodeSnapshot).toBe('function')`.

(This step's own count is unaffected by this brief's two added tests — Step 11
targets a single test by name, not the whole file.)

- [ ] **Step 12: Widen the barrel**

In `packages/protocol/src/index.ts`. Before:

```ts
export * from './types'
export * from './bits'
export * from './quant'
```

After:

```ts
export * from './types'
export * from './bits'
export * from './quant'
export * from './snapshot'
```

- [ ] **Step 13: Run the test to verify it passes, then the whole file and package**

Run: `npx vitest run packages/protocol/test/snapshot.test.ts`
Expected: PASS — 15 passed (14 from Steps 4/8, plus the barrel test).

Run: `npx tsc --noEmit -p packages/protocol && npx vitest run packages/protocol`
Expected: PASS — no TypeScript errors; every test across the package still passes,
including Tasks 3, 4 and 5's own barrel tests, which this task's edit to
`index.ts` does not touch.

- [ ] **Step 14: Commit**

```bash
git add packages/protocol/src/snapshot.ts packages/protocol/src/index.ts \
        packages/protocol/test/snapshot.test.ts
git commit -m "feat(protocol): snapshot codec - encode/decode/apply against contract §4

Per-kart wire record is 178 bits, not 177: isBot and connected are two
independent bits, matching contract §4's explicit ruling that they must never
be merged (an earlier draft of this codec derived isBot as !connected on
decode, which cannot represent the spec §5 bot-takeover/reconnect transition
where the two legitimately disagree for a tick). The fourteen exact/enum
per-kart fields have no Q/EPS entry (Task 5) and are sourced here as local
bit-width constants instead, the same pattern already used for the entity and
header fields.

Also raises the worst-case buffer size from 512B to 1024B (743B is the actual
worst case at 178 bits/kart -- BitWriter truncates silently past a buffer's
end) and adds a MAX_ENTITIES round-trip test that would have caught it, plus
a kart with isBot/connected deliberately disagreeing so the fix is actually
exercised rather than coinciding with a test fixture's defaults.

Two more fixes from this brief's residual-findings pass: lastProcessedInputTick
is now +1-biased on the wire (matching events.ts's own scheme for
playerId/entityId), so the -1 "no real input yet" sentinel round-trips as -1
instead of silently becoming tick 65535; and applySnapshotToState now resets a
re-sentinelled entity slot's targetId to -1, matching entity.ts's clearSlot
convention, instead of leaving a despawned seeker's stale target reference
behind for ShadowLoop.reconcile to inherit.

Widens packages/protocol/src/index.ts to re-export snapshot.ts, so
packages/net can reach these three functions through @tapkart/protocol from
Task 11 onward instead of waiting for Task 18's barrel widening."
```

---

### Task 7: Wire Round-Trip Bounds and the Epsilon/Step Assertion

**Files:**
- Create: `packages/protocol/test/roundtrip.test.ts`
- No `src` changes. This task adds zero production code — it is a verification
  suite over Tasks 4 (`bits.ts`) and 5 (`quant.ts`), which must both already
  exist when this task runs (they precede it in the contract's module map,
  §3). Neither file exists in the checkout this brief was written against
  (`packages/protocol` does not exist yet at all — confirmed by listing the
  directory), so every claim below about their exports is drawn from the
  locked contract's signatures, never from reading their source.

**Why this task has no RED-then-implement cycle, unlike a feature task:**
Every other task in this plan writes a failing test and then writes the code
that makes it pass. This task's code already exists by the time it runs — the
whole point of §8's "wire round-trip bounds" test is to catch a defect in
`quant.ts`'s frozen `Q`/`EPS` tables, not to drive new code into existence. So
the honest RED prediction here is different in kind from Task 8/9's: either
the suite passes on the first run (the expected, non-suspicious outcome for a
regression-proofing test against already-correct code), or it fails and names
a real defect that must be fixed in `quant.ts`, never here. **Do not weaken
any assertion in this file to make it pass.** That is stated once, here,
because it applies to every step below.

---

**Interfaces:**

- Consumes, contract §3, verbatim (Task 4, `packages/protocol/src/bits.ts`):
  ```ts
  export class BitWriter {
    constructor(buf: Uint8Array)
    reset(): void
    writeBits(value: number, bits: number): void
    writeFloatQ(value: number, min: number, max: number, bits: number): void
    byteLength(): number
  }
  export class BitReader {
    constructor(buf: Uint8Array)
    reset(): void
    readBits(bits: number): number
    readFloatQ(min: number, max: number, bits: number): number
  }
  ```
  Used here by constructing a fresh instance per buffer and reading/writing
  immediately — `reset()` is assumed to exist for reusing one instance across
  multiple buffers/positions, not as a required first call. If Task 4 turns
  out to require an explicit `reset()` before first use, add `w.reset()` /
  `r.reset()` immediately after each `new BitWriter(...)` / `new
  BitReader(...)` below; nothing else in this file changes.

- Consumes, contract §3, verbatim (Task 5, `packages/protocol/src/quant.ts`):
  ```ts
  export const Q: QuantTable
  export const EPS: EpsilonTable
  export function quantStep(min: number, max: number, bits: number): number
  ```

- **`QuantTable`/`EpsilonTable`'s per-field shape is locked by contract §3**,
  not merely assumed by this brief. (An earlier draft of this brief was
  written before that amendment landed and described the shape below as an
  unresolved ambiguity this brief was pinning on its own authority. That
  framing is stale and is corrected here — the shape is no longer this
  brief's own choice, it is the contract's.)

  ```ts
  export interface QuantField { min: number; max: number; bits: number }
  export interface QuantTable {
    position: QuantField
    velocity: QuantField
    heading: QuantField
    angularVelocity: QuantField
    driftCharge: QuantField
    t: QuantField
  }
  export interface EpsilonTable {
    position: number
    velocity: number
    heading: number
    angularVelocity: number
    driftCharge: number
    t: number
  }
  ```

  This is contract §3 verbatim. Two things about the shape are worth stating
  explicitly, both taken directly from contract §4 rather than inferred:
  1. Only the six **continuous** ("band"-compared) rows get an entry. The
     other eleven rows (`spinOutTicks`, `lap`, `item`, `playerId`, …) are
     marked "exact" / `Object.is` in §4 — they carry no quantization noise
     and therefore need no epsilon at all: "giving them one would invite
     someone to compare an integer with a tolerance" (contract §4, verbatim).
  2. The sixth key is **`t`, not `lap.t` and not `lapT`.** Contract §4 states
     this outright: "The key is `t`, not `lap.t`, matching the flat
     `WireKart` interface in §3." Contract §3's `WireKart` declares it as a
     flat sibling field, `lap: number; checkpointIdx: number; t: number`, not
     nested the way it lives inside `KartState` (`k.lap.t`).
  3. `QuantTable` deliberately exposes raw `{min, max, bits}` rather than a
     precomputed `step` — contract §4, verbatim: "`QuantTable` deliberately
     exposes raw `{min, max, bits}` rather than a precomputed `step`, so
     `quantStep` can recompute it and Task 7's `epsilon > step` assertion is
     checking the constants against each other rather than against a cached
     number that could drift." That recomputation is exactly what claim (b)
     below needs, and it means this test never hardcodes a single decimal
     step or epsilon value copied from the prose table.

  Task 5 owns `quant.ts` and must ship exactly this shape. **If Step 2's run
  below shows otherwise, that is a Task 5 defect, not an ambiguity for this
  test file to absorb** — do not edit `CONTINUOUS_FIELDS` or the interface
  aliases here to match a nonconforming `quant.ts`; report it and stop
  instead. (An earlier version of this brief instructed exactly that silent
  absorption — see Step 2 below — which would launder a real contract
  violation into a passing test rather than catching it. That instruction is
  withdrawn.)

- Produces: nothing exported. `CONTINUOUS_FIELDS` and `EXACT_FIELDS` below are
  test-local constants.

---

- [ ] **Step 1: Write the test file**

Create `packages/protocol/test/roundtrip.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { BitReader, BitWriter } from '../src/bits'
import { EPS, Q, quantStep } from '../src/quant'
import type { EpsilonTable, QuantTable } from '../src/quant'

/**
 * The six continuous ("band"-compared) fields from the locked contract §4.
 * Keyed to match WireKart's flat field names (§3) — in particular `t`, not
 * `lap.t`, because WireKart declares `t: number` as a sibling of `lap` and
 * `checkpointIdx`, not nested. This shape is contract §3, not a choice this
 * file makes: if `Q`/`EPS` use different keys, that is a defect in
 * quant.ts's Task 5, not a cue to edit this list to match it. See this
 * file's task brief for the full reasoning.
 */
const CONTINUOUS_FIELDS: (keyof QuantTable & keyof EpsilonTable)[] = [
  'position',
  'velocity',
  'heading',
  'angularVelocity',
  'driftCharge',
  't',
]

describe('epsilon strictly exceeds step, for every continuous field', () => {
  // Claim (b): epsilon > step, asserted against Q and EPS themselves — never
  // against a decimal copied out of the contract's prose table. `step` is
  // recomputed here via the real `quantStep`, from Q's own min/max/bits, so
  // this catches a wrong step in Q just as readily as a wrong epsilon in EPS.
  for (const field of CONTINUOUS_FIELDS) {
    it(`EPS.${field} > quantStep(Q.${field})`, () => {
      const { min, max, bits } = Q[field]
      const step = quantStep(min, max, bits)
      expect(EPS[field]).toBeGreaterThan(step)
    })
  }
})

/**
 * The mechanical check under test, factored out so it can be run against
 * both the real tables and a deliberately mistuned copy. This is the same
 * technique the first describe block above uses inline (`EPS[field] >
 * quantStep(...)`); pulling it into a function is what lets "that invariant
 * actually has teeth" below prove the check rejects a bad tuning, rather
 * than merely restating `!(x > x)` against numbers nobody read from EPS/Q.
 */
function epsilonExceedsStep(
  field: keyof QuantTable & keyof EpsilonTable,
  eps: EpsilonTable,
  q: QuantTable,
): boolean {
  const { min, max, bits } = q[field]
  return eps[field] > quantStep(min, max, bits)
}

describe('that invariant actually has teeth', () => {
  // Sanity: the extracted check agrees with the real EPS/Q for every field,
  // before trusting it to catch a bad tuning below.
  it('the real EPS/Q tables pass the mechanical check for every field', () => {
    for (const field of CONTINUOUS_FIELDS) {
      expect(epsilonExceedsStep(field, EPS, Q)).toBe(true)
    }
  })

  // The actual control. Builds a copy of EPS with exactly one field's
  // epsilon set equal to its own step -- the forbidden tuning contract §0
  // names by name ("Do not tune an epsilon downward to make a test pass;
  // that test is the one protecting the player from a buzzing kart") -- and
  // asserts the mechanical check rejects it. This reads the real Q (for
  // min/max/bits) and only perturbs EPS, so unlike a version that just
  // restates `!(x > x)` against invented numbers, it genuinely fails if
  // epsilonExceedsStep is ever loosened from `>` to `>=`.
  it('an epsilon tuned exactly equal to its step fails the mechanical check, field by field', () => {
    for (const field of CONTINUOUS_FIELDS) {
      const step = quantStep(Q[field].min, Q[field].max, Q[field].bits)
      const badEps: EpsilonTable = { ...EPS, [field]: step }
      expect(epsilonExceedsStep(field, badEps, Q)).toBe(false)
    }
  })

  // The mirror image, against the same perturbed table rather than invented
  // numbers: a `>=` comparison (the wrong tool) would wrongly accept the
  // exact forbidden tuning `>` correctly rejects above.
  it('demonstrates why the check must use > and not >=, against the same perturbed table', () => {
    for (const field of CONTINUOUS_FIELDS) {
      const step = quantStep(Q[field].min, Q[field].max, Q[field].bits)
      const badEps: EpsilonTable = { ...EPS, [field]: step }
      const recomputedStep = quantStep(Q[field].min, Q[field].max, Q[field].bits)
      expect(badEps[field] >= recomputedStep).toBe(true) // the wrong tool wrongly passes this
      expect(badEps[field] > recomputedStep).toBe(false) // the real check correctly rejects it
    }
  })
})

describe('round trip stays within one quantization step', () => {
  // Claim (a): decode(encode(x)) differs from x by less than that field's
  // step. min/max/bits always come from Q, never from a literal, so this
  // exercises whatever quantization Task 5 actually shipped.
  for (const field of CONTINUOUS_FIELDS) {
    it(`${field}: min, max, midpoint, and an off-center sample`, () => {
      const { min, max, bits } = Q[field]
      const step = quantStep(min, max, bits)
      const samples = [min, max, (min + max) / 2, min + (max - min) * 0.137]
      for (const value of samples) {
        const buf = new Uint8Array(8)
        const w = new BitWriter(buf)
        w.writeFloatQ(value, min, max, bits)
        const r = new BitReader(buf)
        const decoded = r.readFloatQ(min, max, bits)
        // The true bound for a linear quantizer is step/2; asserting the
        // full step leaves comfortable headroom against float rounding right
        // at a bucket boundary, while still matching spec §8's wording
        // ("differs from x by less than each field's stated quantization
        // step") via a strict less-than.
        expect(Math.abs(decoded - value)).toBeLessThan(step)
      }
    })
  }
})

describe('continuous fields survive at each range endpoint', () => {
  for (const field of CONTINUOUS_FIELDS) {
    it(`${field} at Q.${field}.min and Q.${field}.max`, () => {
      const { min, max, bits } = Q[field]
      const step = quantStep(min, max, bits)
      for (const value of [min, max]) {
        const buf = new Uint8Array(8)
        const w = new BitWriter(buf)
        w.writeFloatQ(value, min, max, bits)
        const decoded = new BitReader(buf).readFloatQ(min, max, bits)
        expect(Math.abs(decoded - value)).toBeLessThan(step)
      }
    })
  }
})

/**
 * Representative exact (Object.is-compared) integer field widths, taken
 * directly from contract §4's Bits column. These do not go through
 * writeFloatQ/readFloatQ or through Q/EPS at all — they are raw bitfields,
 * exact by construction, and this section proves BitWriter/BitReader hold
 * that promise at the specific widths the wire format actually uses.
 */
const EXACT_FIELDS: { name: string; bits: number }[] = [
  { name: 'spinOutTicks', bits: 8 },
  { name: 'invulnTicks', bits: 8 },
  { name: 'boostTicks', bits: 7 },
  { name: 'respawnTicks', bits: 7 },
  { name: 'lap', bits: 3 },
  { name: 'checkpointIdx', bits: 6 },
  { name: 'item', bits: 4 },
  { name: 'surface', bits: 2 },
  { name: 'playerId', bits: 3 },
]

describe('integer fields round-trip exactly, via Object.is', () => {
  for (const { name, bits } of EXACT_FIELDS) {
    it(`${name} (${bits} bits): 0, its max, and a mid value`, () => {
      const max = 2 ** bits - 1
      const mid = Math.floor(max / 3)
      for (const value of [0, max, mid]) {
        const buf = new Uint8Array(8)
        const w = new BitWriter(buf)
        w.writeBits(value, bits)
        const decoded = new BitReader(buf).readBits(bits)
        expect(Object.is(decoded, value)).toBe(true)
      }
    })
  }

  it('normalises -0 to +0', () => {
    const buf = new Uint8Array(8)
    const w = new BitWriter(buf)
    w.writeBits(-0, 8)
    const decoded = new BitReader(buf).readBits(8)
    expect(Object.is(decoded, -0)).toBe(false)
    expect(Object.is(decoded, 0)).toBe(true)
  })
})
```

- [ ] **Step 2: Run the suite**

Run: `npx vitest run packages/protocol/test/roundtrip.test.ts`

There are three distinct possible outcomes here, and they mean different
things — read the message before acting:

1. **All tests PASS.** This is the expected, unremarkable outcome. This task
   adds no production code; a clean pass means Tasks 4 and 5 shipped a
   `bits.ts`/`quant.ts` that satisfies the contract. Proceed to Step 3.
2. **`TypeError: Cannot read properties of undefined (reading 'min')`** (or
   `'bits'`, `'max'`, or a field name in the error stack) — this is a Vitest
   /esbuild runtime error, not a compile-time one (esbuild's SSR transform
   does not check named exports statically), and it means `quant.ts` does not
   export the six-key, `t`-keyed `QuantTable`/`EpsilonTable` shape contract
   §3 locks. **This is a Task 5 defect, not an ambiguity for this file to
   resolve.** Open `packages/protocol/src/quant.ts`, confirm which keys `Q`/
   `EPS` actually carry, and fix `quant.ts` to match contract §3 — do not
   edit `CONTINUOUS_FIELDS` or the interface aliases here to match a
   nonconforming `quant.ts`, and do not change any `expect(...)` line. (An
   earlier version of this step instructed exactly that: edit this file's
   `CONTINUOUS_FIELDS`/interfaces to match whatever `quant.ts` happened to
   export. That instruction would silently launder a real contract violation
   into a passing test and is withdrawn.)
3. **An `AssertionError` naming a specific field** (e.g. `EPS.driftCharge >
   quantStep(...)` fails, or a round-trip/endpoint test for `heading`
   exceeds its step) — this is a real defect in `quant.ts`'s `Q` or `EPS`
   values. The fix belongs in `quant.ts`. Do not weaken this test to pass;
   per contract §0, that would defeat the one thing protecting the player
   from a visibly buzzing kart.

- [ ] **Step 3: Typecheck and run the full protocol suite**

Run: `npx tsc --noEmit -p packages/protocol && npx vitest run packages/protocol`

Expected: zero type errors, every protocol test green (including this file's
~31 test cases: 6 epsilon-invariant checks, 3 teeth-demonstration checks, 6
round-trip checks with 4 samples each, 6 endpoint checks, 9 exact-field
checks with 3 samples each, plus the `-0` normalisation check).

- [ ] **Step 4: Commit**

```bash
git add packages/protocol/test/roundtrip.test.ts
git commit -m "test(protocol): wire round-trip bounds and the epsilon/step invariant

Two distinct claims, kept distinct per spec §8: (a) decode(encode(x))
for every continuous field stays within that field's quantization step,
asserted at each field's min, max, midpoint and an off-center sample;
(b) epsilon strictly exceeds step for every field in EPS, asserted
mechanically against Q and EPS's own values via quantStep, never
against the contract's prose table.

A dedicated 'teeth' block proves (b) isn't vacuous: it perturbs a copy
of EPS, setting one field's epsilon equal to its own step - the
forbidden tuning contract \$0 warns about - and shows the same
mechanical epsilonExceedsStep check the real invariant test uses
rejects it, plus a mirror case showing why the check must use strict >
and not >=. Integer (Object.is-compared) fields are checked separately
at their exact \$4 bit widths, including a -0-normalises-to-+0 case,
independent of Q/EPS entirely.

This task adds no production code - it is a regression suite over
Tasks 4 and 5's already-frozen bits.ts/quant.ts. A failure here names a
real defect in quant.ts; per contract \$0, it must never be fixed by
weakening this test."
```

---

### Task 8: `packages/protocol/src/checkpoint.ts`

**Files:**
- Create: `packages/protocol/src/checkpoint.ts`
- Create: `packages/protocol/test/checkpoint.test.ts`

**A verified, not assumed, premise about `SimState`'s shape:** this task
depends on contract §1a — `SimState` gains `heldBotIntent: Intent[]` and
`heldBotTick: number[]`, appended after `finishedOrder`, and `cloneState`
deep-copies both. **This was checked directly against the checkout this brief
was written against, not taken on faith:** `grep -rn "heldBotIntent"
packages/sim/src/` returns **zero matches**, in both `types.ts` and
`state.ts`. Task 1 (the amendment that adds these fields) has **not landed in
this checkout**. This brief is written for the shape `SimState` has *after*
Task 1 lands, per the contract's task ordering (§1 states Tasks 1 and 2 run
"before `protocol` or `net` exist"). Before starting Task 8, confirm Task 1
has actually landed — `heldBotIntent`/`heldBotTick` exist on `SimState`,
`createState` initializes them, and `cloneState`/`statesEqual` handle them —
by re-running the same grep. If it still returns nothing, Task 8 is blocked
on Task 1, not on Tasks 3–6.

---

**Interfaces:**

- Consumes, contract §3, verbatim:
  ```ts
  export function encodeCheckpoint(out: Uint8Array, state: SimState): number
  export function decodeCheckpoint(buf: Uint8Array, dst: SimState): void
  ```

- Consumes from `@tapkart/sim` (verified directly against
  `packages/sim/src/types.ts` in this checkout):
  ```ts
  export const MAX_KARTS = 8
  export const MAX_ENTITIES = 32
  export type RacePhase = 'countdown' | 'racing' | 'finished'
  export type Surface = 'tarmac' | 'dirt' | 'boost' | 'offtrack'
  export type ItemKind = 'none' | 'boost' | 'seeker' | 'bolt' | 'slick' | 'bubble' | 'surge' | 'blink' | 'charge'
  export type EntityKind = 'seeker' | 'bolt' | 'slick' | 'bubble' | 'surge' | 'charge'
  export interface Intent { tick: number; steer: number; accel: number; brake: boolean; drift: boolean; useItem: boolean }
  export interface KartState {
    playerId: number; characterIdx: number; isBot: boolean; connected: boolean
    position: Vec3; velocity: Vec3; heading: number; angularVelocity: number
    drift: { active: boolean; dir: -1 | 0 | 1; charge: number }
    item: ItemKind; airborne: boolean; surface: Surface
    spinOutTicks: number; invulnTicks: number; boostTicks: number; respawnTicks: number
    shielded: boolean; lap: { lap: number; checkpointIdx: number; t: number }
  }
  export interface EntityState {
    entityId: number; kind: EntityKind; ownerId: number
    position: Vec3; velocity: Vec3; heading: number; targetId: number; ttl: number
  }
  export interface ItemBoxState { boxIdx: number; respawnTicks: number }
  export interface SimState {
    tick: number; phase: RacePhase; raceSeed: number; rngCursor: number
    nextEventSeq: number; finishTick: number
    karts: KartState[]; entities: EntityState[]; entityCount: number; nextEntityId: number
    itemBoxes: ItemBoxState[]; finishedOrder: number[]
    heldBotIntent: Intent[]; heldBotTick: number[]   // [Task 1] — see the premise note above
  }
  export function statesEqual(a: SimState, b: SimState): boolean   // Object.is on every scalar
  ```

- Produces:
  ```ts
  export function encodeCheckpoint(out: Uint8Array, state: SimState): number
  export function decodeCheckpoint(buf: Uint8Array, dst: SimState): void
  ```
  Internal (not exported): `PHASE_ORDER`, `SURFACE_ORDER`, `ITEM_ORDER`,
  `ENTITY_KIND_ORDER` — fixed-order lookup tables for the four string-enum
  types, and a private `idx()` helper.

---

**Two design decisions this task makes on its own authority,** because
`AuthorityCheckpoint`'s wire layout is not specified anywhere in the locked
contract (§4 covers only `WireSnapshot`) — contract §0's own rule applies: "A
task needing something absent must define it in its own files and say so in
its `Interfaces` block."

1. **Every field, without exception, is written as a raw IEEE-754 float64**
   via `DataView.setFloat64`/`getFloat64` at 8 bytes each, little-endian
   (contract §0: "Byte order on the wire: little-endian, everywhere, no
   exceptions"). This includes fields that are conceptually booleans (written
   as `0.0`/`1.0`) and string enums (written as an index into a fixed-order
   table). Unlike `WireSnapshot`, byte budget is explicitly not a constraint
   here — spec §5: *"Not sent periodically in the steady state"* — so this
   task optimizes for the one property that matters, bit-identity, and for
   implementation simplicity: encode/decode become one repeated `(write
   field, read field)` shape applied in `SimState`'s declared field order,
   with **no bit-packing, no quantization, and — because a raw float64 copy
   preserves the IEEE-754 sign bit exactly — no special-casing needed
   anywhere for `-0`.** A quantized or bit-packed scheme would need explicit
   `-0` handling; this one gets it for free.

2. **This task does not use `SimContext`, `Track`, or any track fixture.**
   `encodeCheckpoint`/`decodeCheckpoint` take only a `SimState`, so the test
   below builds `SimState` fixtures by hand rather than via `createState` +
   a track. This is deliberate, not laziness: `@tapkart/sim`'s test fixtures
   (`makeContext`, `makeOvalTrack`) live under `packages/sim/test/fixtures/`,
   outside `packages/sim/package.json`'s `exports` map (`"." :
   "./src/index.ts"` only) — verified by reading that file — so they are not
   importable from another workspace package at all. Reaching for them here
   would not compile.

---

- [ ] **Step 1: Write the failing test — full-state round trip, bit-identical**

Create `packages/protocol/test/checkpoint.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type {
  EntityKind,
  EntityState,
  Intent,
  ItemKind,
  KartState,
  SimState,
  Surface,
} from '@tapkart/sim'
import { MAX_ENTITIES, MAX_KARTS, statesEqual } from '@tapkart/sim'
import { decodeCheckpoint, encodeCheckpoint } from '../src/checkpoint'

/** Test-local enum-value pools, independent of checkpoint.ts's internal wire
 * order — this test must pass regardless of how the codec orders its lookup
 * tables internally, as long as encode/decode agree with themselves. */
const ITEM_POOL: ItemKind[] = ['none', 'boost', 'seeker', 'bolt', 'slick', 'bubble', 'surge', 'blink', 'charge']
const SURFACE_POOL: Surface[] = ['tarmac', 'dirt', 'boost', 'offtrack']
const ENTITY_KIND_POOL: EntityKind[] = ['seeker', 'bolt', 'slick', 'bubble', 'surge', 'charge']

function makeKart(i: number): KartState {
  return {
    playerId: i,
    characterIdx: (i * 3) % 8,
    isBot: i % 2 === 0,
    connected: i % 3 !== 0,
    position: { x: i * 12.5 - 40, y: 0.5, z: -i * 7.25 },
    velocity: { x: i === 0 ? -0 : i * 1.5, y: 0, z: 3.25 - i },
    heading: (i - 4) * 0.4,
    angularVelocity: i % 2 === 0 ? -0.75 : 0.75,
    drift: { active: i % 2 === 1, dir: ((i % 3) - 1) as -1 | 0 | 1, charge: i * 9 },
    item: ITEM_POOL[i % ITEM_POOL.length]!,
    airborne: i === 5,
    surface: SURFACE_POOL[i % SURFACE_POOL.length]!,
    spinOutTicks: i * 4,
    invulnTicks: i * 5,
    boostTicks: i * 3,
    respawnTicks: i * 2,
    shielded: i === 7,
    lap: { lap: i % 4, checkpointIdx: i, t: i / 10 },
  }
}

function makeEntity(i: number): EntityState {
  const alive = i < 5
  return {
    entityId: alive ? 100 + i : -1,
    kind: ENTITY_KIND_POOL[i % ENTITY_KIND_POOL.length]!,
    ownerId: alive ? i % MAX_KARTS : -1,
    position: { x: i * 3.1, y: alive ? 1.2 : 0, z: -i * 2.2 },
    velocity: { x: 0.5 * i, y: 0, z: -0.25 * i },
    heading: (i % 7) * 0.3 - 1,
    targetId: alive ? (i + 1) % MAX_KARTS : -1,
    ttl: alive ? 600 - i * 10 : 0,   // 600 = Tuning.entityTtl's max, contract \$1c
  }
}

function makeHeldIntent(i: number): Intent {
  return { tick: 100 + i, steer: (i - 4) / 8, accel: i % 2, brake: i === 3, drift: i === 5, useItem: i === 6 }
}

const richState: SimState = {
  tick: 4211,
  phase: 'racing',
  raceSeed: 0x1234abcd,
  rngCursor: 987654,
  nextEventSeq: 321,
  finishTick: -1,
  entityCount: 5,
  nextEntityId: 137,
  karts: Array.from({ length: MAX_KARTS }, (_, i) => makeKart(i)),
  entities: Array.from({ length: MAX_ENTITIES }, (_, i) => makeEntity(i)),
  itemBoxes: [
    { boxIdx: 0, respawnTicks: 0 },
    { boxIdx: 1, respawnTicks: 45 },
    { boxIdx: 2, respawnTicks: 0 },
    { boxIdx: 3, respawnTicks: 180 },
  ],
  finishedOrder: [3, -1, -1, -1, -1, -1, -1, -1],
  heldBotIntent: Array.from({ length: MAX_KARTS }, (_, i) => makeHeldIntent(i)),
  heldBotTick: [-1, 12, -1, 45, -1, 7, -1, 3],
}

/** Same shape as `src` (same array lengths throughout), every value
 * different, so the round-trip test is meaningful rather than vacuous. */
function makeBlankLike(src: SimState): SimState {
  return {
    tick: 0,
    phase: 'countdown',
    raceSeed: 0,
    rngCursor: 0,
    nextEventSeq: 0,
    finishTick: 0,
    entityCount: 0,
    nextEntityId: 0,
    karts: src.karts.map(() => ({
      playerId: 0,
      characterIdx: 0,
      isBot: false,
      connected: false,
      position: { x: 0, y: 0, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
      heading: 0,
      angularVelocity: 0,
      drift: { active: false, dir: 0 as const, charge: 0 },
      item: 'none' as const,
      airborne: false,
      surface: 'tarmac' as const,
      spinOutTicks: 0,
      invulnTicks: 0,
      boostTicks: 0,
      respawnTicks: 0,
      shielded: false,
      lap: { lap: 0, checkpointIdx: 0, t: 0 },
    })),
    entities: src.entities.map(() => ({
      entityId: 0,
      kind: 'seeker' as const,
      ownerId: 0,
      position: { x: 0, y: 0, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
      heading: 0,
      targetId: 0,
      ttl: 0,
    })),
    itemBoxes: src.itemBoxes.map(() => ({ boxIdx: 0, respawnTicks: 0 })),
    finishedOrder: src.finishedOrder.map(() => 0),
    heldBotIntent: src.heldBotIntent.map(() => ({
      tick: 0,
      steer: 0,
      accel: 0,
      brake: false,
      drift: false,
      useItem: false,
    })),
    heldBotTick: src.heldBotTick.map(() => 0),
  }
}

describe('checkpoint round trip', () => {
  it('is bit-identical for a fully populated SimState, per statesEqual', () => {
    const buf = new Uint8Array(6000)
    const n = encodeCheckpoint(buf, richState)

    // 8 header fields + 8 karts * 26 fields + 32 entities * 12 fields
    // + (1 count + 4 boxes * 2 fields) + 8 finishedOrder
    // + 8 heldBotIntent * 6 fields + 8 heldBotTick, all at 8 bytes/field:
    // (8 + 8*26 + 32*12 + 1 + 4*2 + 8 + 8*6 + 8) * 8 = 5384
    expect(n).toBe(5384)

    const dst = makeBlankLike(richState)
    expect(statesEqual(dst, richState)).toBe(false) // the placeholder really differs

    decodeCheckpoint(buf.subarray(0, n), dst)

    expect(statesEqual(dst, richState)).toBe(true)

    // statesEqual returns a bare boolean; name the fields too, per this
    // plan's style (Task 16), so a failure says which kart/entity/quantity.
    for (let i = 0; i < MAX_KARTS; i++) {
      const a = dst.karts[i]!
      const b = richState.karts[i]!
      expect(Object.is(a.position.x, b.position.x)).toBe(true)
      expect(Object.is(a.position.y, b.position.y)).toBe(true)
      expect(Object.is(a.position.z, b.position.z)).toBe(true)
      expect(Object.is(a.velocity.x, b.velocity.x)).toBe(true)
      expect(Object.is(a.heading, b.heading)).toBe(true)
      expect(Object.is(a.angularVelocity, b.angularVelocity)).toBe(true)
      expect(Object.is(a.drift.charge, b.drift.charge)).toBe(true)
      expect(a.drift.dir).toBe(b.drift.dir)
      expect(a.item).toBe(b.item)
      expect(a.surface).toBe(b.surface)
      expect(a.boostTicks).toBe(b.boostTicks)
      expect(a.respawnTicks).toBe(b.respawnTicks)
      expect(a.shielded).toBe(b.shielded)
      expect(Object.is(a.lap.t, b.lap.t)).toBe(true)
    }
    for (let i = 0; i < MAX_ENTITIES; i++) {
      expect(Object.is(dst.entities[i]!.entityId, richState.entities[i]!.entityId)).toBe(true)
      expect(dst.entities[i]!.kind).toBe(richState.entities[i]!.kind)
      expect(Object.is(dst.entities[i]!.ttl, richState.entities[i]!.ttl)).toBe(true)
    }

    // The specific defect this task exists to prevent: heldBotIntent and
    // heldBotTick (Plan 2 Task 1) must be carried. Dropping them would
    // resurrect the cross-room bot-hold bug Task 1 exists to fix.
    for (let i = 0; i < MAX_KARTS; i++) {
      expect(dst.heldBotIntent[i]).toEqual(richState.heldBotIntent[i])
      expect(Object.is(dst.heldBotTick[i], richState.heldBotTick[i])).toBe(true)
    }

    // -0 survives a raw float64 round trip, not just === 0.
    expect(Object.is(dst.karts[0]!.velocity.x, -0)).toBe(true)
  })

  it('writes an independent copy: mutating dst does not affect the source state', () => {
    const buf = new Uint8Array(6000)
    const n = encodeCheckpoint(buf, richState)
    const dst = makeBlankLike(richState)
    decodeCheckpoint(buf.subarray(0, n), dst)

    dst.karts[0]!.position.x += 1000
    expect(richState.karts[0]!.position.x).not.toBe(dst.karts[0]!.position.x)
  })

  it('throws if dst.itemBoxes.length disagrees with the encoded count', () => {
    const buf = new Uint8Array(6000)
    const n = encodeCheckpoint(buf, richState) // encoded with 4 item boxes
    const dst = makeBlankLike(richState)
    dst.itemBoxes.pop() // now 3; the buffer says 4

    expect(() => decodeCheckpoint(buf.subarray(0, n), dst)).toThrow(/itemBoxes/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/protocol/test/checkpoint.test.ts`

Expected: FAIL with `Error: Failed to resolve import "../src/checkpoint" from
"packages/protocol/test/checkpoint.test.ts". Does the file exist?` —
`checkpoint.ts` does not exist yet, so this is a module resolution failure at
the ESM loading stage, not a runtime `TypeError` (that distinction matters
only once the file exists but is missing a specific export — not the case
here, since nothing exists yet).

- [ ] **Step 3: Write the implementation**

Create `packages/protocol/src/checkpoint.ts`:

```ts
import type {
  EntityKind,
  EntityState,
  Intent,
  ItemKind,
  KartState,
  RacePhase,
  SimState,
  Surface,
} from '@tapkart/sim'

/**
 * Full-precision serialization of SimState for AuthorityCheckpoint (spec
 * \$5): late join, a client resynced after reconciliation diverges past
 * recovery, and shadow resync after a partition. Not sent periodically.
 *
 * Every field - including booleans and string enums - is written as a raw
 * IEEE-754 float64 (8 bytes, little-endian), in SimState's declared field
 * order. This is deliberately not bit-packed: this message carries no byte
 * budget (spec \$5), and a raw float64 round trip preserves every JS safe
 * integer and the -0/+0 sign bit exactly, with no special-casing.
 */

const PHASE_ORDER: RacePhase[] = ['countdown', 'racing', 'finished']
const SURFACE_ORDER: Surface[] = ['tarmac', 'dirt', 'boost', 'offtrack']
const ITEM_ORDER: ItemKind[] = [
  'none', 'boost', 'seeker', 'bolt', 'slick', 'bubble', 'surge', 'blink', 'charge',
]
const ENTITY_KIND_ORDER: EntityKind[] = ['seeker', 'bolt', 'slick', 'bubble', 'surge', 'charge']

function idx<T>(order: readonly T[], value: T, label: string): number {
  const i = order.indexOf(value)
  if (i < 0) throw new Error(`checkpoint: unknown ${label} ${String(value)}`)
  return i
}

export function encodeCheckpoint(out: Uint8Array, state: SimState): number {
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength)
  let o = 0

  const f = (value: number): void => {
    dv.setFloat64(o, value, true)
    o += 8
  }
  const bit = (value: boolean): void => f(value ? 1 : 0)

  f(state.tick)
  f(idx(PHASE_ORDER, state.phase, 'RacePhase'))
  f(state.raceSeed)
  f(state.rngCursor)
  f(state.nextEventSeq)
  f(state.finishTick)
  f(state.entityCount)
  f(state.nextEntityId)

  for (const k of state.karts) {
    f(k.playerId)
    f(k.characterIdx)
    bit(k.isBot)
    bit(k.connected)
    f(k.position.x); f(k.position.y); f(k.position.z)
    f(k.velocity.x); f(k.velocity.y); f(k.velocity.z)
    f(k.heading)
    f(k.angularVelocity)
    bit(k.drift.active)
    f(k.drift.dir)
    f(k.drift.charge)
    f(idx(ITEM_ORDER, k.item, 'ItemKind'))
    bit(k.airborne)
    f(idx(SURFACE_ORDER, k.surface, 'Surface'))
    f(k.spinOutTicks)
    f(k.invulnTicks)
    f(k.boostTicks)
    f(k.respawnTicks)
    bit(k.shielded)
    f(k.lap.lap)
    f(k.lap.checkpointIdx)
    f(k.lap.t)
  }

  for (const e of state.entities) {
    f(e.entityId)
    f(idx(ENTITY_KIND_ORDER, e.kind, 'EntityKind'))
    f(e.ownerId)
    f(e.position.x); f(e.position.y); f(e.position.z)
    f(e.velocity.x); f(e.velocity.y); f(e.velocity.z)
    f(e.heading)
    f(e.targetId)
    f(e.ttl)
  }

  f(state.itemBoxes.length)
  for (const box of state.itemBoxes) {
    f(box.boxIdx)
    f(box.respawnTicks)
  }

  for (const v of state.finishedOrder) f(v)

  for (const iv of state.heldBotIntent) {
    f(iv.tick)
    f(iv.steer)
    f(iv.accel)
    bit(iv.brake)
    bit(iv.drift)
    bit(iv.useItem)
  }

  for (const v of state.heldBotTick) f(v)

  return o
}

export function decodeCheckpoint(buf: Uint8Array, dst: SimState): void {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  let o = 0

  const f = (): number => {
    const v = dv.getFloat64(o, true)
    o += 8
    return v
  }
  const bit = (): boolean => f() !== 0

  dst.tick = f()
  dst.phase = PHASE_ORDER[f()]!
  dst.raceSeed = f()
  dst.rngCursor = f()
  dst.nextEventSeq = f()
  dst.finishTick = f()
  dst.entityCount = f()
  dst.nextEntityId = f()

  for (const k of dst.karts as KartState[]) {
    k.playerId = f()
    k.characterIdx = f()
    k.isBot = bit()
    k.connected = bit()
    k.position.x = f(); k.position.y = f(); k.position.z = f()
    k.velocity.x = f(); k.velocity.y = f(); k.velocity.z = f()
    k.heading = f()
    k.angularVelocity = f()
    k.drift.active = bit()
    k.drift.dir = f() as -1 | 0 | 1
    k.drift.charge = f()
    k.item = ITEM_ORDER[f()]!
    k.airborne = bit()
    k.surface = SURFACE_ORDER[f()]!
    k.spinOutTicks = f()
    k.invulnTicks = f()
    k.boostTicks = f()
    k.respawnTicks = f()
    k.shielded = bit()
    k.lap.lap = f()
    k.lap.checkpointIdx = f()
    k.lap.t = f()
  }

  for (const e of dst.entities as EntityState[]) {
    e.entityId = f()
    e.kind = ENTITY_KIND_ORDER[f()]!
    e.ownerId = f()
    e.position.x = f(); e.position.y = f(); e.position.z = f()
    e.velocity.x = f(); e.velocity.y = f(); e.velocity.z = f()
    e.heading = f()
    e.targetId = f()
    e.ttl = f()
  }

  const boxCount = f()
  if (boxCount !== dst.itemBoxes.length) {
    throw new Error(
      `decodeCheckpoint: buffer has ${boxCount} itemBoxes but dst was preallocated with ${dst.itemBoxes.length}`,
    )
  }
  for (const box of dst.itemBoxes) {
    box.boxIdx = f()
    box.respawnTicks = f()
  }

  for (let i = 0; i < dst.finishedOrder.length; i++) dst.finishedOrder[i] = f()

  for (const iv of dst.heldBotIntent as Intent[]) {
    iv.tick = f()
    iv.steer = f()
    iv.accel = f()
    iv.brake = bit()
    iv.drift = bit()
    iv.useItem = bit()
  }

  for (let i = 0; i < dst.heldBotTick.length; i++) dst.heldBotTick[i] = f()
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/protocol/test/checkpoint.test.ts`

Expected: PASS — 3 tests. If the first test's `statesEqual` assertion fails,
do not weaken it: bisect which field diverges using the per-field
`Object.is` assertions immediately below it in the same test, in this order
of likelihood — a field order mismatch between `encodeCheckpoint` and
`decodeCheckpoint` (most common category of bug in a purely-sequential
codec), a missed `heldBotIntent`/`heldBotTick` field (the specific defect
this task exists to catch), or an enum value absent from one of the four
`*_ORDER` tables.

- [ ] **Step 5: Run the full protocol suite and typecheck**

Run: `npx tsc --noEmit -p packages/protocol && npx vitest run packages/protocol`

Expected: PASS, zero type errors, every protocol test green (including Task
7's `roundtrip.test.ts` if it has already landed).

- [ ] **Step 6: Commit**

```bash
git add packages/protocol/src/checkpoint.ts packages/protocol/test/checkpoint.test.ts
git commit -m "feat(protocol): full-precision AuthorityCheckpoint codec

encodeCheckpoint/decodeCheckpoint serialize every SimState field - every
kart, every entity slot including dead residue, item-box timers, PRNG
cursor, race phase, tick, eventSeq, and Task 1's heldBotIntent/
heldBotTick - as raw little-endian float64s in SimState's declared
field order. No bit-packing and no quantization: this message has no
byte budget (spec \$5, not sent periodically), so the design optimizes
for exact statesEqual bit-identity instead, which a raw float64 copy
gives for free, -0 included.

Decisive test: decodeCheckpoint(encodeCheckpoint(s)) satisfies
statesEqual against a shape-matched but content-different dst, with
heldBotIntent/heldBotTick asserted field-by-field - dropping them would
resurrect the cross-room bot-hold bug Plan 2 Task 1 exists to fix."
```

---

### Task 9: `packages/protocol/src/events.ts`

**Files:**
- Create: `packages/protocol/src/events.ts`
- Create: `packages/protocol/test/events.test.ts`

---

**Interfaces:**

- Consumes, contract §3, verbatim:
  ```ts
  export function encodeEvents(out: Uint8Array, events: AuthEvent[]): number
  export function decodeEvents(buf: Uint8Array, out: AuthEvent[]): void
  ```

- Consumes `AuthEvent` from `@tapkart/sim` — **read directly from
  `packages/sim/src/types.ts` in this checkout, not assumed:**
  ```ts
  export type AuthEventKind =
    | 'itemGrant' | 'entitySpawn' | 'entityDespawn'
    | 'hit' | 'spinOut' | 'respawn' | 'lapCross' | 'finish'

  export interface AuthEvent {
    eventSeq: number
    tick: number
    kind: AuthEventKind
    playerId: number
    entityId: number     // -1 when not applicable
    item: ItemKind       // 'none' when not applicable
    data: number          // kind-specific scalar, 0 when unused
  }
  ```
  Eight `AuthEventKind` values, in this exact declared order. `ItemKind` has
  nine values (`'none' | 'boost' | 'seeker' | 'bolt' | 'slick' | 'bubble' |
  'surge' | 'blink' | 'charge'`), also read directly from `types.ts`.
  `EntityKind` (six values: `'seeker' | 'bolt' | 'slick' | 'bubble' | 'surge'
  | 'charge'`) is a strict subset of `ItemKind`'s string literals, which is
  why `entity.ts` and `laps.ts`/`recovery.ts` can pass an `EntityKind` value
  into the `item: ItemKind` parameter of `emit()` for `entitySpawn`,
  `entityDespawn` and `hit` events — verified by reading
  `packages/sim/src/entity.ts` lines 76, 97, 256 and 258, all of which call
  `emit(state, events, <kind>, ..., kind-or-e.kind, ...)` where `kind`/
  `e.kind` is typed `EntityKind`. This task's `ITEM_ORDER` table (nine
  entries) therefore already covers every value these events can carry; no
  separate entity-kind table is needed for `item`.

- Produces:
  ```ts
  export function encodeEvents(out: Uint8Array, events: AuthEvent[]): number
  export function decodeEvents(buf: Uint8Array, out: AuthEvent[]): void
  ```
  `decodeEvents` **clears `out` first** (`out.length = 0`) and then pushes
  one freshly-allocated `AuthEvent` object per decoded record, in wire
  order — this is this task's own definition, stated here per contract §0's
  rule, because the contract's `void`-returning signature doesn't otherwise
  say whether `out` is appended to or replaced. Appending would silently
  accumulate stale events across repeated decode calls into the same array,
  which is not how every other reader of an out-array in this codebase
  behaves (`step()`'s `events: AuthEvent[]` out-param is cleared by its
  caller before each call, by the same convention).

---

**The wire layout is this task's own design**, because `AuthEvent` is not in
contract §4 (§4 covers only `WireSnapshot`'s per-kart/per-entity records).
Per contract §0: "A task needing something absent must define it in its own
files and say so in its `Interfaces` block." Every `AuthEvent` field is
already discrete (a counter, a tick, an enum, small integers) — none of it is
the continuous, lossy-by-design data `WireSnapshot` carries — so this codec
uses `BitWriter`/`BitReader`'s exact `writeBits`/`readBits`, matching
contract §0's rule for integer fields ("quantised exactly ... compare with
`Object.is`"), not `writeFloatQ`.

| Field | Bits | Encoding |
|---|---|---|
| `eventSeq` | 32 | raw unsigned |
| `tick` | 32 | raw unsigned |
| `kind` | 3 | index into `KIND_ORDER` (8 values, fits exactly in 3 bits) |
| `playerId` | 4 | `playerId + 1` — domain `-1..7` becomes wire `0..8`, fits in 4 bits (max 15) |
| `entityId` | 17 | `entityId + 1` — domain `-1..131070` becomes wire `0..131071`, the full range 17 bits can hold |
| `item` | 4 | index into `ITEM_ORDER` (9 values, fits exactly in 4 bits) |
| `data` | 16 | raw unsigned |

**Total: 108 bits per event.** A batch is prefixed by a 16-bit `eventCount`
(this task's own choice — nothing in the contract bounds how many events can
batch onto the reliable channel between ticks; 16 bits is generous headroom
without inventing a magic cap).

**Two of these widths are grounded in real observed values, not guesses:**

- `playerId`'s `-1` case is real, not hypothetical. `packages/sim/src/phase.ts`
  line 226 — verified by reading it directly — contains
  `emit(state, events, 'finish', -1, -1, 'none', finishers)`: `updatePhase`
  emits a **race-level** `finish` event with `playerId -1` once every kart has
  finished or the grace period elapses. The `playerId + 1` bias makes this
  representable in the same 4-bit field used for every other event's
  `playerId`, with no separate sentinel or special case.
- `data`'s 16-bit width is sized to the largest real value observed at any
  `emit()` call site, not to 8 bits. `packages/sim/src/entity.ts` line 76 —
  verified by reading it directly — calls
  `emit(state, events, 'entitySpawn', ownerId, entityId, kind, ttl)`, and
  `Tuning.entityTtl` is 600 (contract §1c, which independently widens
  `WireEntity.ttl` from `u8` to `u16` for the identical reason: "the wire
  format could not represent the tuning the simulation actually runs"). An
  8-bit `data` field would silently truncate this exact value; 16 bits
  covers it with headroom to spare (max 65535).

---

- [ ] **Step 1: Write the failing test**

Create `packages/protocol/test/events.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { AuthEvent, AuthEventKind } from '@tapkart/sim'
import { decodeEvents, encodeEvents } from '../src/events'

describe('encodeEvents / decodeEvents', () => {
  it('round-trips all eight AuthEventKinds, including the race-level finish (playerId -1)', () => {
    // Values below mirror real emit() call sites, verified by reading
    // packages/sim/src: itemGrant (items.ts:136), entitySpawn/entityDespawn/
    // hit (entity.ts:76,97,256,258), spinOut (recovery.ts:66), respawn
    // (recovery.ts:162), lapCross (laps.ts:97), finish, both per-kart
    // (laps.ts:107, phase.ts:219) and race-level with playerId -1
    // (phase.ts:226).
    const events: AuthEvent[] = [
      { eventSeq: 0, tick: 100, kind: 'itemGrant', playerId: 3, entityId: -1, item: 'boost', data: 12 },
      { eventSeq: 1, tick: 101, kind: 'entitySpawn', playerId: 3, entityId: 145, item: 'boost', data: 600 },
      { eventSeq: 2, tick: 250, kind: 'entityDespawn', playerId: 3, entityId: 145, item: 'boost', data: 0 },
      { eventSeq: 3, tick: 260, kind: 'hit', playerId: 5, entityId: 146, item: 'seeker', data: 1 },
      { eventSeq: 4, tick: 261, kind: 'hit', playerId: 6, entityId: 147, item: 'bolt', data: 0 },
      { eventSeq: 5, tick: 300, kind: 'spinOut', playerId: 2, entityId: -1, item: 'none', data: 60 },
      { eventSeq: 6, tick: 360, kind: 'respawn', playerId: 2, entityId: -1, item: 'none', data: 72 },
      { eventSeq: 7, tick: 500, kind: 'lapCross', playerId: 0, entityId: -1, item: 'none', data: 2 },
      { eventSeq: 8, tick: 3600, kind: 'finish', playerId: 4, entityId: -1, item: 'none', data: 1 },
      { eventSeq: 9, tick: 3600, kind: 'finish', playerId: -1, entityId: -1, item: 'none', data: 8 },
    ]

    const buf = new Uint8Array(256)
    const n = encodeEvents(buf, events)

    // header 16 bits + 10 events * 108 bits = 1096 bits = 137 bytes
    expect(n).toBe(137)

    const out: AuthEvent[] = [
      { eventSeq: -1, tick: -1, kind: 'hit', playerId: -1, entityId: -1, item: 'none', data: -1 },
    ]
    decodeEvents(buf.subarray(0, n), out)

    expect(out.length).toBe(events.length)
    for (let i = 0; i < events.length; i++) {
      expect(out[i]).toEqual(events[i])
    }

    // The specific hazard this task exists to guard: a negative playerId
    // must survive the round trip, exactly.
    expect(Object.is(out[9]!.playerId, -1)).toBe(true)
    expect(out[9]!.kind).toBe('finish')

    // entityId -1 (not applicable) and a real spawned id both survive.
    expect(out[0]!.entityId).toBe(-1)
    expect(out[1]!.entityId).toBe(145)

    // item 'none' (unused) and a real item both survive.
    expect(out[5]!.item).toBe('none')
    expect(out[1]!.item).toBe('boost')
  })

  it('clears out before decoding, rather than appending to it', () => {
    const single: AuthEvent[] = [
      { eventSeq: 42, tick: 7, kind: 'lapCross', playerId: 1, entityId: -1, item: 'none', data: 1 },
    ]
    const buf = new Uint8Array(64)
    const n = encodeEvents(buf, single)

    const out: AuthEvent[] = [
      { eventSeq: 0, tick: 0, kind: 'hit', playerId: 0, entityId: 0, item: 'none', data: 0 },
      { eventSeq: 0, tick: 0, kind: 'hit', playerId: 0, entityId: 0, item: 'none', data: 0 },
      { eventSeq: 0, tick: 0, kind: 'hit', playerId: 0, entityId: 0, item: 'none', data: 0 },
    ]
    decodeEvents(buf.subarray(0, n), out)

    expect(out.length).toBe(1)
    expect(out[0]).toEqual(single[0])
  })

  it('round-trips a zero-event batch', () => {
    const buf = new Uint8Array(16)
    const n = encodeEvents(buf, [])
    expect(n).toBe(2) // 16-bit count only

    const out: AuthEvent[] = [
      { eventSeq: 9, tick: 9, kind: 'hit', playerId: 9, entityId: 9, item: 'none', data: 9 },
    ]
    decodeEvents(buf.subarray(0, n), out)
    expect(out.length).toBe(0)
  })

  it('survives data and entityId at their representable extremes', () => {
    const events: AuthEvent[] = [
      { eventSeq: 100, tick: 200, kind: 'entitySpawn', playerId: 0, entityId: 0, item: 'seeker', data: 0 },
      { eventSeq: 101, tick: 201, kind: 'entitySpawn', playerId: 7, entityId: 131070, item: 'charge', data: 65535 },
    ]
    const buf = new Uint8Array(64)
    const n = encodeEvents(buf, events)
    const out: AuthEvent[] = []
    decodeEvents(buf.subarray(0, n), out)

    expect(out[0]!.entityId).toBe(0)
    expect(out[0]!.data).toBe(0)
    // 131070 = 2^17 - 2: the largest entityId the 17-bit, +1-biased field can
    // hold (wire max is 2^17 - 1 = 131071, reserved for entityId 131070).
    expect(out[1]!.entityId).toBe(131070)
    // 65535 = 2^16 - 1: the unsigned max of the 16-bit data field.
    expect(out[1]!.data).toBe(65535)
  })

  it('throws on an unrecognised AuthEventKind rather than silently miscoding it', () => {
    const bogus: AuthEvent[] = [
      { eventSeq: 0, tick: 0, kind: 'bogus' as AuthEventKind, playerId: 0, entityId: -1, item: 'none', data: 0 },
    ]
    const buf = new Uint8Array(32)
    expect(() => encodeEvents(buf, bogus)).toThrow(/AuthEventKind/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/protocol/test/events.test.ts`

Expected: FAIL with `Error: Failed to resolve import "../src/events" from
"packages/protocol/test/events.test.ts". Does the file exist?` — `events.ts`
does not exist yet, so this is a module resolution failure, not a runtime
`TypeError`.

- [ ] **Step 3: Write the implementation**

Create `packages/protocol/src/events.ts`:

```ts
import type { AuthEvent, AuthEventKind, ItemKind } from '@tapkart/sim'
import { BitReader, BitWriter } from './bits'

/** Fixed wire order, matching AuthEventKind's declaration in @tapkart/sim's types.ts. */
const KIND_ORDER: AuthEventKind[] = [
  'itemGrant', 'entitySpawn', 'entityDespawn', 'hit', 'spinOut', 'respawn', 'lapCross', 'finish',
]
/** Fixed wire order, matching ItemKind's declaration in @tapkart/sim's types.ts.
 * EntityKind's six values are a strict subset of these nine, so entitySpawn/
 * entityDespawn/hit events (whose `item` field actually carries an
 * EntityKind) are already covered - no separate table is needed. */
const ITEM_ORDER: ItemKind[] = [
  'none', 'boost', 'seeker', 'bolt', 'slick', 'bubble', 'surge', 'blink', 'charge',
]

const EVENT_COUNT_BITS = 16
const EVENT_SEQ_BITS = 32
const TICK_BITS = 32
const KIND_BITS = 3
const PLAYER_ID_BITS = 4 // wire = playerId + 1, domain -1..7
const ENTITY_ID_BITS = 17 // wire = entityId + 1, domain -1..131070
const ITEM_BITS = 4
const DATA_BITS = 16

export function encodeEvents(out: Uint8Array, events: AuthEvent[]): number {
  const w = new BitWriter(out)
  w.writeBits(events.length, EVENT_COUNT_BITS)

  for (const ev of events) {
    const kindIdx = KIND_ORDER.indexOf(ev.kind)
    if (kindIdx < 0) throw new Error(`encodeEvents: unknown AuthEventKind ${String(ev.kind)}`)
    const itemIdx = ITEM_ORDER.indexOf(ev.item)
    if (itemIdx < 0) throw new Error(`encodeEvents: unknown ItemKind ${String(ev.item)}`)

    w.writeBits(ev.eventSeq, EVENT_SEQ_BITS)
    w.writeBits(ev.tick, TICK_BITS)
    w.writeBits(kindIdx, KIND_BITS)
    w.writeBits(ev.playerId + 1, PLAYER_ID_BITS)
    w.writeBits(ev.entityId + 1, ENTITY_ID_BITS)
    w.writeBits(itemIdx, ITEM_BITS)
    w.writeBits(ev.data, DATA_BITS)
  }

  return w.byteLength()
}

export function decodeEvents(buf: Uint8Array, out: AuthEvent[]): void {
  const r = new BitReader(buf)
  const count = r.readBits(EVENT_COUNT_BITS)
  out.length = 0

  for (let i = 0; i < count; i++) {
    const eventSeq = r.readBits(EVENT_SEQ_BITS)
    const tick = r.readBits(TICK_BITS)
    const kind = KIND_ORDER[r.readBits(KIND_BITS)]!
    const playerId = r.readBits(PLAYER_ID_BITS) - 1
    const entityId = r.readBits(ENTITY_ID_BITS) - 1
    const item = ITEM_ORDER[r.readBits(ITEM_BITS)]!
    const data = r.readBits(DATA_BITS)
    out.push({ eventSeq, tick, kind, playerId, entityId, item, data })
  }
}
```

If Task 4's `BitWriter`/`BitReader` require an explicit `reset()` before
first use (see Task 7's brief for the same caveat), add `w.reset()` /
`r.reset()` immediately after each constructor call above; nothing else
changes.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/protocol/test/events.test.ts`

Expected: PASS — 5 tests. If the `playerId -1` assertion fails specifically,
check the bias arithmetic first (`ev.playerId + 1` on encode, `- 1` on
decode) before suspecting `BitWriter`/`BitReader` — a `+1`/`-1` mismatch
between encode and decode is the most likely single bug here, and it would
make every event's `playerId` wrong by one, not just the `-1` case, which is
a good first signal to check if the whole first test fails rather than just
that one assertion.

- [ ] **Step 5: Run the full protocol suite and typecheck**

Run: `npx tsc --noEmit -p packages/protocol && npx vitest run packages/protocol`

Expected: PASS, zero type errors, every protocol test green (including Tasks
7 and 8's suites if they have already landed).

- [ ] **Step 6: Commit**

```bash
git add packages/protocol/src/events.ts packages/protocol/test/events.test.ts
git commit -m "feat(protocol): AuthEvent codec for the reliable channel

encodeEvents/decodeEvents bit-pack a batch of AuthEvents: a 16-bit
count header, then 108 bits per event (eventSeq u32, tick u32, kind 3
bits into a fixed 8-entry table, playerId 4 bits biased +1 so -1 is
representable, entityId 17 bits biased +1, item 4 bits into a fixed
9-entry table, data 16 bits). AuthEvent isn't in the locked contract's
\$4 wire table, so this layout is this task's own definition.

playerId's -1 case and data's 16-bit width are both grounded in real
emit() call sites, not guesses: phase.ts's race-level finish event
passes playerId -1, and entity.ts's entitySpawn passes ttl (up to
Tuning.entityTtl = 600) as data, which would truncate silently at 8
bits. decodeEvents clears its out-array before decoding rather than
appending, matching how step()'s own events out-param is used
elsewhere in this codebase."
```

---

### Task 10: `packages/protocol/src/input.ts` — input datagram codec

Encodes and decodes the 30Hz input datagram a client sends to both the host
authority and the server shadow: `playerId` plus a sliding window of the last
`INPUT_REDUNDANCY` intents, newest last. Spec §5: *"Input intents at 30Hz, each
datagram carrying the last 8 intents. Redundancy is free at this size, so a
dropped packet costs nothing."*

**Why redundancy makes a dropped packet free.** The sim runs at 60Hz; input is
produced at 30Hz, i.e. once every 2 ticks. Each datagram doesn't just carry the
newest intent — it carries the newest **8**, oldest first, newest last. If one
datagram is lost, the next one still contains every tick the lost one carried
(they overlap by 7 of 8 entries), plus one new tick. A receiver that missed the
*previous two* datagrams in a row still recovers every one of their ticks from
the third, as long as those ticks are still inside the 8-entry window — a tick
only becomes truly unrecoverable once it ages out of every subsequent window.
This task's second test drops two datagrams outright (never decodes them) and
proves every tick they carried is still readable from a third, later datagram —
except the ticks old enough to have already fallen out of that later window,
which is the window's honest edge, not a bug.

**Files:**
- Create: `packages/protocol/src/input.ts`
- Test: `packages/protocol/test/input.test.ts`

**Interfaces:**

- Consumes (already exist by the time this task runs — Tasks 3–9 precede it —
  do not redefine):
  - `packages/sim/src/types.ts`, via the `@tapkart/sim` package specifier
    (`packages/sim`'s barrel is complete and merged; this is a normal package
    import, not a relative reach-around). Verified by reading the file
    directly: `export interface Intent { tick: number; steer: number /*
    -1..1 */; accel: number /* 0..1 */; brake: boolean; drift: boolean;
    useItem: boolean }`. Field order as shown.
  - `packages/protocol/src/types.ts` [Task 3], same package, relative import
    `'./types'` — `export interface InputDatagram { playerId: number;
    intents: Intent[] /* length INPUT_REDUNDANCY, newest last */ }`. This is
    the contract's decode target (§3): **do not** declare a local
    `InputDatagram` in this file, import the one Task 3 defines.
  - `packages/protocol/src/bits.ts` [Task 4], relative import `'./bits'`:
    ```ts
    export class BitWriter {
      constructor(buf: Uint8Array)
      reset(): void
      writeBits(value: number, bits: number): void
      writeFloatQ(value: number, min: number, max: number, bits: number): void
      byteLength(): number
    }
    export class BitReader {
      constructor(buf: Uint8Array)
      reset(): void
      readBits(bits: number): number
      readFloatQ(min: number, max: number, bits: number): number
    }
    ```
  - `packages/protocol/src/quant.ts` [Task 5], relative import `'./quant'`,
    **test-file only**: `export function quantStep(min: number, max: number,
    bits: number): number`. This task's production code never calls it — see
    below.

- Produces:
  - `export const INPUT_REDUNDANCY = 8`
  - `export function encodeInput(out: Uint8Array, playerId: number, intents: Intent[]): number` — bytes written.
  - `export function decodeInput(buf: Uint8Array, out: InputDatagram): void` — `out.intents` must already be an array of length `INPUT_REDUNDANCY` (any prior `Intent` values; every field is overwritten). Matches the "codecs never allocate" convention: the caller owns both buffers.

- **A design decision this task must make and own:** the contract's §4
  quantisation table (`Q`/`EPS` in `quant.ts`, Task 5, frozen) covers exactly
  the `WireSnapshot` fields — position, velocity, heading, and so on. `Intent`
  is a different struct on a different channel and appears nowhere in that
  table. `steer` and `accel` therefore have **no** contract-assigned bit width
  or step; this file defines its own (`STEER_BITS`, `ACCEL_BITS` below),
  local to `input.ts`, not added to `quant.ts`'s frozen table. `quantStep` is
  still useful — the *test* uses it to compute the tolerance band for the
  round-trip assertions, since `quantStep(min, max, bits) = (max - min) /
  (2**bits - 1)` is a general formula, not one of the frozen per-field
  constants.

- **Wire layout this task defines** (LSB-first within each byte, per the
  contract's global bit-packing convention, and delegated entirely to
  `BitWriter`/`BitReader` — this file never touches bytes directly):

  | Field | Bits | Notes |
  |---|---|---|
  | `playerId` | 3 | 0..7, matches `MAX_KARTS = 8` |
  | `baseTick` | 32 | the **newest** intent's tick (`intents[INPUT_REDUNDANCY - 1].tick`), absolute, matching the `u32` width `WireSnapshot`'s own `tick` header field uses elsewhere in this package |
  | per intent, ×8, oldest to newest (matching `intents`' own array order) | | |
  | — `tickDelta` | 8 | `baseTick - intent.tick`; 0 for the newest entry, 14 for the oldest in the steady 2-tick cadence — 8 bits covers up to 255, far more headroom than the window ever needs |
  | — `steer` | 8 | `writeFloatQ(steer, -1, 1, 8)` |
  | — `accel` | 6 | `writeFloatQ(accel, 0, 1, 6)` |
  | — `brake`, `drift`, `useItem` | 1 each | |

  Total: `3 + 32 + 8 × (8 + 8 + 6 + 1 + 1 + 1) = 3 + 32 + 8×25 = 235` bits =
  `⌈235 / 8⌉ = 30` bytes. This byte count is a mathematical consequence of the
  bit widths chosen above, not an assumption about how Task 4 rounds — any
  `BitWriter` whose `byteLength()` means "bytes touched so far" (the only
  sensible reading of that signature over a `Uint8Array`) returns 30 here.

---

- [ ] **Step 1: Write the failing test**

Create `packages/protocol/test/input.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { Intent } from '@tapkart/sim'
import type { InputDatagram } from '../src/types'
import { quantStep } from '../src/quant'
import { INPUT_REDUNDANCY, decodeInput, encodeInput } from '../src/input'

// Deterministic per-tick intent generator. steer cycles through -1..1 in 9
// steps and accel through 0..1 in 5 steps; the three booleans use moduli that
// vary independently across an all-even tick sequence (this window's 2-tick
// production cadence never emits an odd tick), so no two of the 8 entries
// built below are identical, and every field actually gets exercised.
function intentAt(tick: number): Intent {
  return {
    tick,
    steer: ((tick % 9) - 4) / 4,
    accel: (tick % 5) / 4,
    brake: tick % 4 === 0,
    drift: tick % 6 === 0,
    useItem: tick % 10 === 0,
  }
}

/** 8 intents at newestTick - 14 .. newestTick, step 2, oldest first. */
function windowEndingAt(newestTick: number): Intent[] {
  const out: Intent[] = []
  for (let t = newestTick - 14; t <= newestTick; t += 2) out.push(intentAt(t))
  return out
}

function blankDatagram(): InputDatagram {
  const intents: Intent[] = []
  for (let i = 0; i < INPUT_REDUNDANCY; i++) {
    intents.push({ tick: -1, steer: 0, accel: 0, brake: false, drift: false, useItem: false })
  }
  return { playerId: -1, intents }
}

const STEER_STEP = quantStep(-1, 1, 8)
const ACCEL_STEP = quantStep(0, 1, 6)

function expectIntentRecovered(actual: Intent, expected: Intent): void {
  expect(actual.tick).toBe(expected.tick)
  expect(Math.abs(actual.steer - expected.steer)).toBeLessThan(STEER_STEP)
  expect(Math.abs(actual.accel - expected.accel)).toBeLessThan(ACCEL_STEP)
  expect(actual.brake).toBe(expected.brake)
  expect(actual.drift).toBe(expected.drift)
  expect(actual.useItem).toBe(expected.useItem)
}

describe('encodeInput / decodeInput', () => {
  it('round-trips playerId and all 8 intents within each field\'s quantization step', () => {
    const intents = windowEndingAt(114) // ticks 100..114, step 2
    const buf = new Uint8Array(32)
    const bytes = encodeInput(buf, 4, intents)

    // 3 (playerId) + 32 (baseTick) + 8 * (8 delta + 8 steer + 6 accel + 3 bools)
    // = 3 + 32 + 200 = 235 bits = 30 bytes
    expect(bytes).toBe(30)

    const out = blankDatagram()
    decodeInput(buf.subarray(0, bytes), out)

    expect(out.playerId).toBe(4)
    expect(out.intents.length).toBe(INPUT_REDUNDANCY)
    for (let i = 0; i < INPUT_REDUNDANCY; i++) {
      expectIntentRecovered(out.intents[i], intents[i])
    }
  })

  it('recovers every tick still inside the window from a later datagram, even after two datagrams are dropped entirely', () => {
    // Three datagrams a real 30Hz sender produces back to back: newest tick
    // 14, then 16, then 18 (step 2, the spec's 60Hz-sim/30Hz-input cadence).
    // W1 and W2 are built AND encoded -- proving they really would have
    // carried these intents -- but neither is ever passed to decodeInput,
    // standing in for two packets lost in transit. Only W3 arrives.
    const w1 = windowEndingAt(14) // ticks 0..14
    const w2 = windowEndingAt(16) // ticks 2..16
    const w3 = windowEndingAt(18) // ticks 4..18

    const buf1 = new Uint8Array(32)
    const buf2 = new Uint8Array(32)
    const buf3 = new Uint8Array(32)
    encodeInput(buf1, 2, w1) // sent, then dropped -- never decoded below
    encodeInput(buf2, 2, w2) // sent, then dropped -- never decoded below
    const bytes3 = encodeInput(buf3, 2, w3)

    const out = blankDatagram()
    decodeInput(buf3.subarray(0, bytes3), out)

    // W3's window is ticks 4..18. Every one of those ticks is recovered here,
    // including tick 14 -- the entire payload focus of the FIRST dropped
    // datagram, W1 -- and tick 6, which both W1 and W2 also carried. A
    // dropped packet cost nothing as long as the tick it carried is still
    // inside a later window.
    expect(out.intents.map((iv) => iv.tick)).toEqual([4, 6, 8, 10, 12, 14, 16, 18])
    expectIntentRecovered(out.intents[1], intentAt(6))  // carried by W1, W2 and W3
    expectIntentRecovered(out.intents[5], intentAt(14)) // W1's own newest tick

    // Ticks 0 and 2 -- W1's oldest entries -- are NOT in W3's window. They
    // were only ever carried by W1 and W2, both dropped, so they are gone:
    // redundancy has a horizon, not infinite memory.
    expect(out.intents.some((iv) => iv.tick === 0)).toBe(false)
    expect(out.intents.some((iv) => iv.tick === 2)).toBe(false)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/protocol/test/input.test.ts`

Expected: FAIL. The last import in the file is the only one targeting a file
that doesn't exist yet (`@tapkart/sim` is a complete, merged package;
`../src/types` and `../src/quant` already exist from Tasks 3 and 5), so
Vitest's Vite-based resolver reports exactly one error:
`Error: Cannot find module '../src/input' imported from
'.../packages/protocol/test/input.test.ts'`, with a "Caused by: ... Does the
file exist?" line underneath. No test runs; this is a collection failure, not
an assertion failure.

- [ ] **Step 3: Implement `packages/protocol/src/input.ts`**

Create `packages/protocol/src/input.ts`:

```ts
import type { Intent } from '@tapkart/sim'
import type { InputDatagram } from './types'
import { BitReader, BitWriter } from './bits'

/**
 * How many recent intents each input datagram carries. Spec §5: input
 * intents are produced at 30Hz and sent with the last 8, so at 60Hz sim /
 * 30Hz input a fresh datagram overlaps the previous one by 7 of its 8
 * entries. A single dropped datagram costs nothing -- every intent it would
 * have carried reappears in the next one, and the one after that, for as long
 * as it stays inside this 8-entry sliding window.
 */
export const INPUT_REDUNDANCY = 8

const PLAYER_ID_BITS = 3    // 0..7, MAX_KARTS
const TICK_BITS = 32        // baseTick: the newest intent's absolute tick, u32
const TICK_DELTA_BITS = 8   // baseTick - intent.tick; 0..14 in the steady
                             // 2-tick cadence this window assumes, 0..255
                             // representable -- far more headroom than needed
const STEER_BITS = 8        // steer -1..1: absent from quant.ts's frozen §4
                             // table (that table is WireSnapshot fields only),
                             // so this file owns its own quantisation width
const ACCEL_BITS = 6        // accel 0..1: same reasoning

/**
 * Encodes `playerId` plus the 8-entry intent window into `out`, oldest first,
 * matching `intents`' own array order (`InputDatagram.intents` is "newest
 * last"). Only the newest intent's tick is written in full (32 bits); every
 * other entry stores its distance behind that tick in 8 bits, which is
 * lossless for any window spanning up to 255 ticks -- eighteen times the
 * 14-tick span an 8-entry, 2-tick-cadence window ever produces.
 *
 * Returns the number of bytes written.
 */
export function encodeInput(out: Uint8Array, playerId: number, intents: Intent[]): number {
  const w = new BitWriter(out)
  w.writeBits(playerId, PLAYER_ID_BITS)
  const baseTick = intents[INPUT_REDUNDANCY - 1].tick
  w.writeBits(baseTick, TICK_BITS)
  for (let i = 0; i < INPUT_REDUNDANCY; i++) {
    const intent = intents[i]
    w.writeBits(baseTick - intent.tick, TICK_DELTA_BITS)
    w.writeFloatQ(intent.steer, -1, 1, STEER_BITS)
    w.writeFloatQ(intent.accel, 0, 1, ACCEL_BITS)
    w.writeBits(intent.brake ? 1 : 0, 1)
    w.writeBits(intent.drift ? 1 : 0, 1)
    w.writeBits(intent.useItem ? 1 : 0, 1)
  }
  return w.byteLength()
}

/**
 * Decodes `buf` into the caller-owned `out`. `out.intents` must already be an
 * array of length INPUT_REDUNDANCY (any prior Intent values -- every field is
 * overwritten in place; nothing is allocated here). Mirrors encodeInput's
 * field order exactly.
 */
export function decodeInput(buf: Uint8Array, out: InputDatagram): void {
  const r = new BitReader(buf)
  out.playerId = r.readBits(PLAYER_ID_BITS)
  const baseTick = r.readBits(TICK_BITS)
  for (let i = 0; i < INPUT_REDUNDANCY; i++) {
    const intent = out.intents[i]
    intent.tick = baseTick - r.readBits(TICK_DELTA_BITS)
    intent.steer = r.readFloatQ(-1, 1, STEER_BITS)
    intent.accel = r.readFloatQ(0, 1, ACCEL_BITS)
    intent.brake = r.readBits(1) !== 0
    intent.drift = r.readBits(1) !== 0
    intent.useItem = r.readBits(1) !== 0
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/protocol/test/input.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Typecheck the package**

Run: `npx tsc --noEmit -p packages/protocol`
Expected: no diagnostics.

- [ ] **Step 6: Commit**

```bash
git add packages/protocol/src/input.ts packages/protocol/test/input.test.ts
git commit -m "feat(protocol): input datagram codec with an 8-tick redundant window

encodeInput/decodeInput pack playerId plus the last INPUT_REDUNDANCY (8)
intents into a fixed-format datagram: a 32-bit base tick (the newest
intent's), then 8 entries of an 8-bit delta plus quantized steer (8
bits) and accel (6 bits) and three 1-bit flags -- 235 bits, 30 bytes.

steer/accel quantization is local to this file: quant.ts's frozen §4
table covers WireSnapshot fields only, and Intent is a different
struct on a different channel.

A dropped datagram costs nothing as long as the ticks it carried are
still inside a later datagram's 8-entry window -- proven by a test
that encodes three back-to-back windows, decodes only the third, and
recovers ticks originally carried by the first two, including the
first datagram's own newest tick."
```

---

### Task 11: `packages/net` workspace scaffold and `src/transport.ts`

Creates the third workspace, `@tapkart/net`, mirroring `@tapkart/sim`'s shape
exactly (verified by reading `packages/sim/package.json`,
`packages/sim/tsconfig.json`, and the root `vitest.config.ts` directly — all
three are quoted below rather than paraphrased), and defines the `Transport`
interface: the one seam spec §5 requires everything above it to be ignorant
of. *"One interface, three implementations ... Nothing above the transport
layer knows which implementation is in use."*

**Files:**
- Create: `packages/net/package.json`
- Create: `packages/net/tsconfig.json`
- Create: `packages/net/src/index.ts`
- Create: `packages/net/src/transport.ts`
- Test: `packages/net/test/scaffold.test.ts`
- Test: `packages/net/test/transport.test.ts`

**Interfaces:**

- Consumes:
  - `packages/sim/package.json` (read directly):
    ```json
    { "name": "@tapkart/sim", "version": "0.1.0", "private": true, "type": "module",
      "exports": { ".": "./src/index.ts" }, "scripts": { "typecheck": "tsc --noEmit -p tsconfig.json" } }
    ```
    No `devDependencies` — `vitest`/`typescript` come from the root via npm
    workspace hoisting.
  - `packages/sim/tsconfig.json` (read directly):
    ```json
    { "extends": "../../tsconfig.base.json", "include": ["src/**/*.ts", "test/**/*.ts"] }
    ```
  - `vitest.config.ts` at the repo root (read directly): `include:
    ['packages/*/test/**/*.test.ts']`, `environment: 'node'`, `globals:
    false` — this new workspace is discovered automatically once its test
    files exist; nothing in the root config needs to change.
  - `packages/protocol/src/index.ts` [Task 3] — `export type ChannelName =
    'unreliable' | 'reliable'`, reachable via `@tapkart/protocol`. **Reached
    by the bare package specifier, never a relative path across the package
    boundary — this is load-bearing, not a style choice.** Contract §3 is
    explicit: "The barrel exists from Task 3, not Task 18. Task 3's scaffold
    creates `packages/protocol/src/index.ts` already re-exporting `./types`
    ... `net` imports `@tapkart/protocol`, always." By the time this task
    runs, Tasks 3–10 have executed: `packages/protocol/src/types.ts` exists
    with `ChannelName` exported, and `packages/protocol/src/index.ts` already
    re-exports it — that is Task 3's own scaffold step, not deferred to
    Task 18. (An earlier draft of this brief argued the protocol barrel
    stayed empty until Task 18 and reached `ChannelName` by a relative path,
    `'../../protocol/src/types'`, instead. That argument is superseded by the
    amended contract, and the relative-path approach is exactly what
    contract §3 forbids: "punches through the package boundary, bypasses the
    `exports` map, and would survive into Plan 3.")

- Produces:
  - Workspace `@tapkart/net` at `packages/net`, `"type": "module"`, exporting
    `"."` as `./src/index.ts`, depending on `@tapkart/sim` and
    `@tapkart/protocol`.
  - `packages/net/src/index.ts` — starts as an empty barrel (`export {}`,
    Step 5) while `transport.ts` doesn't exist yet, then is widened to
    `export * from './transport'` (Step 10) once it does. Contract §3: "The
    same applies to `packages/net/src/index.ts`: Task 11's scaffold creates
    it re-exporting `./transport`, Task 18 widens it." This task, not
    Task 18, is responsible for the barrel carrying `./transport` by the
    time it finishes; Task 18 only adds the remaining five modules
    (`loopback`, `apply`, `authority`, `client`, `shadow`) once Tasks 12–16
    ship them.
  - `export interface Transport { send(channel: ChannelName, peerId: string,
    data: Uint8Array): void; broadcast(channel: ChannelName, data:
    Uint8Array): void; onMessage(cb: (peerId: string, channel: ChannelName,
    data: Uint8Array) => void): void; onPeerLost(cb: (peerId: string) =>
    void): void; peers(): string[]; close(): void }` — verbatim from contract
    §5. No other export in this file; no task may add a method.

- **Testability, made concrete, not asserted.** Spec §5's claim ("nothing
  above the transport layer knows which implementation is in use") is only
  meaningful if code can be written against `Transport` alone and actually
  run. This task's test builds a small in-memory double — defined **only in
  the test file**, never in `transport.ts` — that implements the six methods
  and nothing else, plus a tiny helper function typed to accept `Transport`
  and nothing more specific. Driving the double through that helper is the
  proof: if `Transport` were missing a method some later loop needs, or if
  the helper accidentally required something implementation-specific, this
  test would not compile.

- **A verified fact about this repo's tooling that changes how this task's
  RED step must be checked.** `transport.ts` in this task contains *only* a
  type declaration and one `import type` — no runtime code at all. I
  confirmed by direct experiment (a throwaway test file, deleted after) that
  under this project's Vitest/Vite setup, `import type { X } from
  './nonexistent-module'` does **not** fail at `vitest run` time even when
  the module genuinely does not exist: `verbatimModuleSyntax` erases
  type-only imports completely before Vite's resolver ever sees them, so a
  test that only uses `Transport` in type position would silently collect
  and pass, RED or not. The same experiment confirmed that `npx tsc --noEmit`
  **does** catch it, with `error TS2307: Cannot find module '...' or its
  corresponding type declarations.` — so this task's RED/GREEN check for
  `transport.ts` uses `tsc`, not `vitest run`, and says so at the step level
  rather than leaving a future reader to discover this the hard way.

---

- [ ] **Step 1: Write the failing scaffold test**

Create `packages/net/test/scaffold.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import * as net from '../src/index'

describe('net workspace scaffold', () => {
  it('runs a TypeScript test from the new @tapkart/net workspace', () => {
    expect(2 + 2).toBe(4)
  })

  it('resolves the @tapkart/net entry point with extensionless imports', () => {
    expect(typeof net).toBe('object')
  })
})
```

- [ ] **Step 2: Run the scaffold test to verify it fails**

Run: `npx vitest run packages/net/test/scaffold.test.ts`

Expected: FAIL with `Error: Cannot find module '../src/index' imported from
'.../packages/net/test/scaffold.test.ts'` (a real, non-type-only namespace
import — `import * as net` — so this genuinely fails to resolve; unlike the
`Transport` case below, there is no type-erasure trap here). Vitest's glob in
`vitest.config.ts` matches this file by path regardless of whether
`packages/net/package.json` exists yet, so the explicit file argument runs
even though the workspace isn't registered — the same as Plan 1's Task 1.

- [ ] **Step 3: Write `packages/net/package.json`**

Create `packages/net/package.json`:

```json
{
  "name": "@tapkart/net",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "dependencies": {
    "@tapkart/protocol": "*",
    "@tapkart/sim": "*"
  },
  "scripts": {
    "typecheck": "tsc --noEmit -p tsconfig.json"
  }
}
```

`"*"` is the standard npm-workspaces idiom for "resolve to the local
workspace package," exactly as `packages/sim`'s own `package.json` would use
if it depended on anything. Neither dependency is used by a bare
`@tapkart/protocol`/`@tapkart/sim` import inside `transport.ts` itself (that
file only reaches `@tapkart/protocol` via the relative path explained above),
but `@tapkart/sim` **is** imported by its bare specifier in Task 12's
`net-fixtures.ts`, and declaring both dependencies now means the one `npm
install` this task runs (Step 6) links them before Task 12 needs them.

- [ ] **Step 4: Write `packages/net/tsconfig.json`**

Create `packages/net/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

- [ ] **Step 5: Write the empty barrel**

Create `packages/net/src/index.ts`:

```ts
// Public barrel for @tapkart/net. Task 18 replaces this line with re-exports
// of transport, loopback, apply, authority, client and shadow. The bare
// `export {}` keeps the file a module under isolatedModules while it is
// still empty -- the same role packages/sim/src/index.ts played from Task 1
// until Task 2 filled it in.
export {}
```

- [ ] **Step 6: Install and verify the scaffold test passes**

Run:

```bash
npm install
npx vitest run packages/net/test/scaffold.test.ts
```

Expected: `npm install` updates `package-lock.json` to include `@tapkart/net`
and links `@tapkart/protocol` and `@tapkart/sim` into its dependency tree.
`npx vitest run` reports `Test Files 1 passed (1)`, `Tests 2 passed (2)`.

Then run `npm ls --depth=0 -w @tapkart/net` and confirm the output includes
both `@tapkart/protocol` and `@tapkart/sim` as linked workspace dependencies.

- [ ] **Step 7: Write the failing test for the `Transport` interface**

Create `packages/net/test/transport.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { Transport } from '../src/transport'
import type { Transport as BarrelTransport } from '../src/index'
import type { ChannelName } from '@tapkart/protocol'

interface RecordingTransport extends Transport {
  sent: { channel: ChannelName; peerId: string; data: Uint8Array }[]
  broadcasts: { channel: ChannelName; data: Uint8Array }[]
}

/**
 * A minimal in-memory double. It lives only in this test file: transport.ts
 * defines the interface and nothing else, so any code exercising a Transport
 * goes through these six methods and nothing more -- which is exactly the
 * spec's "nothing above the transport layer knows which implementation is in
 * use" claim, made testable rather than merely asserted.
 */
function makeFakeTransport(): RecordingTransport {
  const sent: RecordingTransport['sent'] = []
  const broadcasts: RecordingTransport['broadcasts'] = []
  const messageCbs: ((peerId: string, channel: ChannelName, data: Uint8Array) => void)[] = []
  const peerLostCbs: ((peerId: string) => void)[] = []
  let closed = false
  return {
    sent,
    broadcasts,
    send(channel, peerId, data) {
      sent.push({ channel, peerId, data })
    },
    broadcast(channel, data) {
      broadcasts.push({ channel, data })
    },
    onMessage(cb) {
      messageCbs.push(cb)
    },
    onPeerLost(cb) {
      peerLostCbs.push(cb)
    },
    peers() {
      return closed ? [] : ['peerB']
    },
    close() {
      closed = true
    },
  }
}

/**
 * Written against the Transport interface alone -- no method beyond the six
 * in the contract, no property specific to any one implementation. This is
 * the shape every later loop (AuthorityLoop, ClientLoop, ShadowLoop) uses.
 */
function sendGreeting(t: Transport): void {
  const payload = new Uint8Array([1, 2, 3])
  t.send('reliable', 'peerB', payload)
  t.broadcast('unreliable', payload)
}

describe('Transport interface', () => {
  it('is fully exercised through its six methods by code that knows nothing else about it', () => {
    const fake = makeFakeTransport()
    sendGreeting(fake)

    expect(fake.sent).toEqual([
      { channel: 'reliable', peerId: 'peerB', data: new Uint8Array([1, 2, 3]) },
    ])
    expect(fake.broadcasts).toEqual([
      { channel: 'unreliable', data: new Uint8Array([1, 2, 3]) },
    ])
    expect(fake.peers()).toEqual(['peerB'])

    fake.close()
    expect(fake.peers()).toEqual([])
  })

  it('accepts exactly the two contract channel names and no others', () => {
    const fake = makeFakeTransport()
    const channels: ChannelName[] = ['unreliable', 'reliable']
    for (const c of channels) fake.send(c, 'peerB', new Uint8Array())
    expect(fake.sent.map((s) => s.channel)).toEqual(['unreliable', 'reliable'])
  })

  it('is reachable through the package barrel, structurally identical to the direct import', () => {
    // The real assertion here is that this file compiles at all:
    // BarrelTransport resolves only once packages/net/src/index.ts
    // re-exports transport.ts (Step 10). Contract §3/§5: "Task 11's scaffold
    // creates it re-exporting ./transport." Before Step 10 this import fails
    // tsc with TS2305 ("no exported member 'Transport'"), exactly like
    // Step 8's TS2307 for ../src/transport before Step 9 -- two separate
    // barrel-boundary defects, fixed by two separate steps.
    const fake = makeFakeTransport()
    const viaBarrel: BarrelTransport = fake
    const viaDirect: Transport = viaBarrel
    expect(viaDirect).toBe(fake)
  })
})
```

- [ ] **Step 8: Run the typecheck to verify it fails**

Run: `npx tsc --noEmit -p packages/net`

Expected: exactly **two** diagnostics, from two independent missing exports —
`transport.ts` doesn't exist yet (Step 9) and `index.ts` doesn't re-export
`Transport` yet (Step 10):

```
test/transport.test.ts(3,30): error TS2307: Cannot find module '../src/transport' or its corresponding type declarations.
test/transport.test.ts(4,36): error TS2305: Module '"../src/index"' has no exported member 'Transport'.
```

(Line/column will differ slightly with exact formatting, but both codes and
messages are as shown.) Resolving the first requires Step 9; resolving the
second requires Step 10 — these are genuinely two separate defects, not one
reported twice.

**Do not** run `npx vitest run packages/net/test/transport.test.ts` and
expect it to fail — it will not. Every reference to `Transport` in this test
file is a type-only import and a type position; under this project's
`verbatimModuleSyntax` + Vite/esbuild transform, that import is erased
entirely before module resolution happens, so the test collects and passes
even though `transport.ts` does not exist and `index.ts` doesn't re-export
it. This was confirmed directly by experiment, not assumed. `tsc` is the only
oracle for this step.

- [ ] **Step 9: Implement `packages/net/src/transport.ts`**

Create `packages/net/src/transport.ts`:

```ts
import type { ChannelName } from '@tapkart/protocol'

/**
 * One interface, three implementations (WebRTC, WebSocket, Loopback). Spec
 * §5: "Nothing above the transport layer knows which implementation is in
 * use." Two channels, named by the exact strings 'unreliable' and 'reliable'
 * -- ChannelName is imported from @tapkart/protocol's barrel, not redefined
 * here and not reached by a relative path (contract §3: "net imports
 * @tapkart/protocol, always").
 */
export interface Transport {
  send(channel: ChannelName, peerId: string, data: Uint8Array): void
  broadcast(channel: ChannelName, data: Uint8Array): void
  onMessage(cb: (peerId: string, channel: ChannelName, data: Uint8Array) => void): void
  onPeerLost(cb: (peerId: string) => void): void
  peers(): string[]
  close(): void
}
```

Run: `npx tsc --noEmit -p packages/net`

Expected: exactly **one** diagnostic remains — the same `TS2305` from Step 8,
unchanged, because `index.ts` still hasn't been widened:

```
test/transport.test.ts(4,36): error TS2305: Module '"../src/index"' has no exported member 'Transport'.
```

This confirms `transport.ts` alone resolves the `TS2307` half of Step 8's RED
and nothing else — the barrel still needs Step 10.

- [ ] **Step 10: Widen the barrel to re-export `transport.ts`**

Contract §3/§5: "Task 11's scaffold creates it re-exporting `./transport`,
Task 18 widens it." Replace `packages/net/src/index.ts`'s content. Before:

```ts
// Public barrel for @tapkart/net. Task 18 replaces this line with re-exports
// of transport, loopback, apply, authority, client and shadow. The bare
// `export {}` keeps the file a module under isolatedModules while it is
// still empty -- the same role packages/sim/src/index.ts played from Task 1
// until Task 2 filled it in.
export {}
```

After:

```ts
// Public barrel for @tapkart/net.
//
// Task 11 re-exports only transport.ts; Task 18 widens this list to every
// module this package ends up with (transport, loopback, apply, authority,
// client, shadow), mirroring exactly what Task 3 -> Task 18 did for
// packages/protocol/src/index.ts and what Plan 1's Task 1 -> Task 2 did for
// packages/sim/src/index.ts.
export * from './transport'
```

Run: `npx tsc --noEmit -p packages/net`
Expected: no output, exit code 0 — both Step 8 diagnostics are now resolved.

Run: `npx vitest run packages/net/test/transport.test.ts`
Expected: `Test Files 1 passed (1)`, `Tests 3 passed (3)` — the third test
(added in Step 7) is meaningful for the first time: it only compiles because
`BarrelTransport` genuinely resolves through `../src/index`.

- [ ] **Step 11: Full package and repo sanity check**

Run:

```bash
npx tsc --noEmit -p packages/net
npx vitest run packages/net
npm run typecheck
npm test
```

Expected: all four commands exit 0. `npm test` includes both new test files
(`packages/net/test/scaffold.test.ts`, `packages/net/test/transport.test.ts`)
alongside every existing `packages/sim`/`packages/protocol` test. This task
adds exactly 5 tests of its own (2 in `scaffold.test.ts`, 3 in
`transport.test.ts` after Step 7's addition) — confirm the total increases by
exactly 5 relative to whatever `npm test` reported immediately before this
task started, rather than trusting one absolute number stated here: Tasks 1–2
already changed `packages/sim`'s count from Plan 1's 477, and Tasks 3–10 have
each added their own tests to `packages/protocol` by the time this task runs,
so no single absolute figure in this brief can stay accurate across the whole
plan.

- [ ] **Step 12: Commit**

```bash
git add packages/net/package.json packages/net/tsconfig.json \
        packages/net/src/index.ts packages/net/src/transport.ts \
        packages/net/test/scaffold.test.ts packages/net/test/transport.test.ts \
        package-lock.json
git commit -m "feat(net): scaffold the @tapkart/net workspace and the Transport interface

Mirrors @tapkart/sim's package.json/tsconfig.json shape exactly:
'exports' mapping only '.', a barrel that starts empty and is widened
to re-export transport.ts by the end of this same task (contract §3:
'Task 11's scaffold creates it re-exporting ./transport'), no
devDependencies beyond the root's hoisted vitest and typescript.
Depends on @tapkart/sim and @tapkart/protocol.

Transport is the one seam above which nothing knows which of WebRTC,
WebSocket or Loopback is in use: six methods, two channels named
'unreliable' and 'reliable' via protocol's ChannelName, imported as
'@tapkart/protocol' -- protocol's own barrel has re-exported ChannelName
since Task 3, so net never reaches across the package boundary with a
relative path.

transport.ts has no runtime code, so its RED/GREEN is checked with tsc
--noEmit, not vitest run: a type-only import of a missing module is
erased by this project's esbuild transform before resolution and would
otherwise pass silently, confirmed by direct experiment. The barrel
widening carries the same trap: net's own index.ts re-exports only a
type, so its RED is a second, independent tsc diagnostic (TS2305),
resolved by its own dedicated step rather than folded silently into
transport.ts's."
```

---

### Task 12: `packages/net/src/loopback.ts` and the `net` test fixtures

Implements the in-process `Transport` pair every later `net` test drives
directly — `AuthorityLoop`, `ClientLoop`, `ShadowLoop` and the promotion test
all run against this, never against real WebRTC/WebSocket sockets — plus the
two fixture functions Tasks 13–17 build on: `makeNetContext` (a real
`SimContext` over the Plan 1 golden oval) and `makeLossyPair` (a
`LoopbackTransport` pair preset to spec §8's test conditions).

**Files:**
- Create: `packages/net/src/loopback.ts`
- Create: `packages/net/test/fixtures/net-fixtures.ts`
- Test: `packages/net/test/loopback.test.ts`
- Test: `packages/net/test/net-fixtures.test.ts`

**Interfaces:**

- Consumes:
  - `packages/net/src/transport.ts` [Task 11], same package, relative import
    `'./transport'` — `export interface Transport { ... }`, verbatim as
    written by Task 11.
  - `packages/protocol/src/index.ts` [Task 3] — `ChannelName`, reached via
    the `@tapkart/protocol` package specifier. Contract §3: "The barrel
    exists from Task 3, not Task 18 ... net imports @tapkart/protocol,
    always." Task 3's own scaffold step already re-exports `./types`, so by
    the time this task runs (after Tasks 3–11), `@tapkart/protocol` resolves
    `ChannelName` directly — the same fix applied to Task 11's `transport.ts`
    (an earlier draft of this brief reached across with a relative path,
    `'../../protocol/src/types'`, on the same now-superseded premise that
    Task 11's brief made; that premise is corrected there too).
  - `packages/sim/src/rng.ts`, via the `@tapkart/sim` package specifier
    (sim's barrel is complete and merged, so this is an ordinary package
    import, unlike the protocol case above). Verified by reading the file
    directly: `export function rngAt(seed: number, cursor: number): number`
    — its own doc comment states *"There is no internal state here on
    purpose. SimState.rngCursor is the only cursor in the system and only a
    leader authority advances it, so a shadow authority, a rewind, or a
    replay can recompute any draw in the race from (raceSeed, rngCursor)
    alone."* This is exactly why the loopback pair must keep its own cursor
    rather than touch `state.rngCursor`: that field belongs to the leader's
    item rolls (`packages/sim/src/items.ts` reads it via
    `rngAt(state.raceSeed, state.rngCursor)`, confirmed by reading that
    file), and a transport advancing it would make a follower or shadow
    authority compute different item rolls than the leader — the exact
    desync the contract calls out in §5.
  - `packages/sim/src/types.ts`, via `@tapkart/sim` — `SimContext`.
  - `packages/sim/src/track.ts`, via `@tapkart/sim` — `export function
    buildTrackQuery(track: Track): TrackQuery`.
  - `packages/sim/test/fixtures/track-fixtures.ts` — **not** reachable via
    the `@tapkart/sim` package specifier. Verified by reading
    `packages/sim/src/index.ts` directly: its barrel is 19 `export *` lines,
    every one a `./src/*` module: `types`, `vec3`, `mathutil`, `rng`,
    `track`, `state`, `step`, `kart`, `ground`, `drift`, `recovery`,
    `collision`, `laps`, `placement`, `entity`, `items`, `bot`, `phase`,
    `replay`. None of them is `test/fixtures/track-fixtures` — test fixtures
    are never part of any package's production barrel here, by design (the
    package's own `test/helpers/flat-context.ts` reaches `test/fixtures/`
    the same way, via a relative import, from *inside* the same package).
    `packages/net/test/fixtures/net-fixtures.ts` therefore reaches it via
    `'../../../sim/test/fixtures/track-fixtures'` (three `..` — `fixtures` →
    `test` → `net` → `packages`, then down into `sim/test/fixtures`). This is
    a permanent structural fact, unlike the protocol-barrel situation above,
    which resolves itself at Task 18 — do not "fix" this one into a bare
    specifier later; there is no export path that would make it one.
    Verified present at that path, with these exact signatures, by reading
    the file directly:
    ```ts
    export function makeOvalTrack(overrides?: Partial<Track>): Track
    export function makeTuning(overrides?: Partial<Tuning>): Tuning
    export function makeCharacters(): CharacterStats[]
    ```
    `makeOvalTrack()` returns `{ id: 'oval', ... }`; `makeTuning()` returns
    `kartRadius: 0.9` among its fields; `makeCharacters()` returns exactly 8
    entries. `buildTrackQuery(makeOvalTrack()).sampleAt(0)` returns `{
    position: { x: -200, y: 0, z: -100 }, width: 24, banking: 0, surface:
    'tarmac' }` — confirmed by running it, not inferred, and used as an exact
    assertion below.

- Produces:
  - `export interface LoopbackOptions { latencyMs: number; jitterMs: number; lossRate: number; seed: number }` (`packages/net/src/loopback.ts`)
  - `export function makeLoopbackPair(opts: LoopbackOptions): { a: Transport; b: Transport; pump(nowMs: number): void }` (`packages/net/src/loopback.ts`)
  - `export function makeNetContext(isLeader?: boolean): SimContext` (`packages/net/test/fixtures/net-fixtures.ts`)
  - `export function makeLossyPair(overrides?: Partial<LoopbackOptions>): ReturnType<typeof makeLoopbackPair>` (`packages/net/test/fixtures/net-fixtures.ts`)

- **Design decisions this task makes and must justify** (none of these is
  pinned by the contract beyond the two signatures above and the default
  option values):

  1. **Peer identity.** The pair's two sides are fixed as `'a'` and `'b'`.
     `a.peers()` returns `['b']` unless `b` has closed (or `a` itself has
     closed, in which case it returns `[]` regardless); symmetric for `b`.
     `send`'s `peerId` argument is accepted, per the interface, but not
     validated against `'a'`/`'b'` — a two-node pair has exactly one possible
     destination, and `broadcast` reaches that same sole peer.

  2. **Determinism — the cursor.** Every `'unreliable'` send consumes
     **exactly two** draws from the pair's own monotonic `cursor`, via
     `rngAt(seed, cursor)`: one loss roll, then one jitter roll at `cursor +
     1`, then `cursor += 2` — **unconditionally**, whether or not the message
     ends up dropped. `'reliable'` sends consume **zero** draws: a reliable
     channel neither drops nor needs timing variance to prove it is
     reliable. This makes the cursor's value after N sends a pure function of
     "how many `'unreliable'` sends happened, in what order" — independent of
     their outcomes — which is exactly what makes two independently
     constructed pairs, given the same `seed` and the same call sequence,
     produce bit-identical schedules. The cursor lives entirely inside the
     closure `makeLoopbackPair` returns; it is never read from or written to
     `SimState.rngCursor`, satisfying the contract's requirement in §5
     directly.

  3. **Determinism — jitter is one-sided.** `delay = latencyMs + rngAt(seed,
     cursor) * jitterMs`, i.e. the extra delay is uniform in `[0, jitterMs)`,
     never negative. This guarantees "arrives after latencyMs and not
     before" unconditionally for any `jitterMs >= 0` — no test needs to
     special-case a symmetric jitter model to prove the floor holds.

  4. **`pump(nowMs)` is the only clock.** `send`/`broadcast` never read a
     clock; they schedule delivery using whatever `nowMs` the *most recent*
     `pump()` call provided (`0` before the first `pump()`). `pump(nowMs)`
     records `nowMs`, then delivers every pending message whose scheduled
     time has passed, **sorted by scheduled time** (ties broken by original
     send order, via `Array.prototype.sort`'s guaranteed stability). Because
     `'reliable'` sends carry no jitter, their scheduled times are already
     monotonic non-decreasing in send order for a fixed `nowMs`-at-send-time,
     so this single sort-based delivery algorithm *provably* preserves
     `'reliable'` order as a structural consequence, not a coincidence of
     never triggering reordering logic — while `'unreliable'`'s jitter can
     and does produce scheduled times out of send order, which the same
     algorithm delivers exactly as scheduled, reordering included.

  5. **`close()`.** Marks that side closed. `peers()` on the other side then
     returns `[]`, and any message already queued for a closed destination is
     silently discarded at delivery time. `onPeerLost` callbacks are
     registered but this task does not exercise firing them — no test in
     this file asserts on it; that is in scope for whichever later task
     drives a real peer-loss scenario.

---

### Part A — `loopback.ts`

- [ ] **Step 1: Write the failing test for the core transport mechanics**

Create `packages/net/test/loopback.test.ts`. This file constructs
`LoopbackOptions` directly — it does not yet depend on `net-fixtures.ts`,
which Part B of this task builds on top of `loopback.ts` once it exists.

```ts
import { describe, expect, it } from 'vitest'
import type { LoopbackOptions } from '../src/loopback'
import { makeLoopbackPair } from '../src/loopback'

const DEFAULTS: LoopbackOptions = { latencyMs: 150, jitterMs: 50, lossRate: 0.05, seed: 0xc0ffee }

describe('makeLoopbackPair', () => {
  it('delivers a message after latencyMs and not before', () => {
    const { a, b, pump } = makeLoopbackPair({ ...DEFAULTS, jitterMs: 0, lossRate: 0 })
    let delivered = false
    b.onMessage(() => { delivered = true })
    a.send('unreliable', 'b', new Uint8Array([1]))

    pump(149)
    expect(delivered).toBe(false)

    pump(150)
    expect(delivered).toBe(true)
  })

  it('loses close to lossRate of 20000 unreliable sends, within a 0.01 band', () => {
    const { a, b, pump } = makeLoopbackPair(DEFAULTS)
    let deliveredCount = 0
    b.onMessage(() => { deliveredCount++ })

    const N = 20000
    for (let i = 0; i < N; i++) a.send('unreliable', 'b', new Uint8Array([i & 0xff]))
    pump(1000) // 150 + up to 50 jitter: every surviving send has arrived by 1000

    const observedLossRate = (N - deliveredCount) / N
    expect(Math.abs(observedLossRate - 0.05)).toBeLessThan(0.01)
  })

  it('produces the identical delivery pattern for the same seed, run twice', () => {
    function run(): number[] {
      const { a, b, pump } = makeLoopbackPair(DEFAULTS)
      const order: number[] = []
      b.onMessage((_peerId, _channel, data) => { order.push(data[0]) })
      for (let i = 0; i < 8; i++) a.send('unreliable', 'b', new Uint8Array([i]))
      pump(1000)
      return order
    }

    const run1 = run()
    const run2 = run()

    expect(run1).toEqual(run2)
    // Locked in by direct simulation of rngAt(0xC0FFEE, cursor) against this
    // exact 8-send sequence (two draws per send, loss then jitter): sent
    // order is 0..7; index 6 draws the least jitter and arrives first, index
    // 1 draws the most and arrives last.
    expect(run1).toEqual([6, 2, 3, 4, 0, 5, 7, 1])
  })

  it('allows out-of-order delivery on unreliable but never on reliable', () => {
    const { a, b, pump } = makeLoopbackPair(DEFAULTS)
    const unreliableOrder: number[] = []
    const reliableOrder: number[] = []
    b.onMessage((_peerId, channel, data) => {
      if (channel === 'unreliable') unreliableOrder.push(data[0])
      else reliableOrder.push(data[0])
    })

    for (let i = 0; i < 8; i++) a.send('unreliable', 'b', new Uint8Array([i]))
    for (let i = 0; i < 8; i++) a.send('reliable', 'b', new Uint8Array([i]))
    pump(1000)

    expect(unreliableOrder).toEqual([6, 2, 3, 4, 0, 5, 7, 1]) // reordered
    expect(reliableOrder).toEqual([0, 1, 2, 3, 4, 5, 6, 7])   // never reordered
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/net/test/loopback.test.ts`

Expected: FAIL with `Error: Cannot find module '../src/loopback' imported
from '.../packages/net/test/loopback.test.ts'`. (`import type { LoopbackOptions
} from '../src/loopback'` is erased by the type-only-import rule discussed in
Task 11, but `import { makeLoopbackPair } from '../src/loopback'` on the
following line is a real value import and fails to resolve on its own — the
same "Cannot find module" shape as every other missing-file RED in this
package.)

- [ ] **Step 3: Implement `packages/net/src/loopback.ts`**

Create `packages/net/src/loopback.ts`:

```ts
import { rngAt } from '@tapkart/sim'
import type { ChannelName } from '@tapkart/protocol'
import type { Transport } from './transport'

export interface LoopbackOptions {
  latencyMs: number
  jitterMs: number
  lossRate: number
  seed: number
}

type Side = 'a' | 'b'

interface PendingMessage {
  from: Side
  channel: ChannelName
  data: Uint8Array
  deliverAt: number
}

/**
 * Two Transports wired directly to each other with injected latency, jitter
 * and loss, plus a pump(nowMs) that is the only place this module reads a
 * clock: send() and broadcast() only ever see whatever nowMs the most recent
 * pump() call provided, so a test controls time completely.
 *
 * Jitter and loss are drawn from rngAt(seed, cursor) using a cursor this pair
 * owns and increments itself -- never state.rngCursor, which belongs to the
 * leader's item rolls. A transport that advanced the sim's cursor would
 * desynchronise the shadow authority.
 */
export function makeLoopbackPair(
  opts: LoopbackOptions,
): { a: Transport; b: Transport; pump(nowMs: number): void } {
  const { latencyMs, jitterMs, lossRate, seed } = opts
  let cursor = 0
  let lastNow = 0
  let aClosed = false
  let bClosed = false
  const pending: PendingMessage[] = []
  const aMessageCbs: Array<(peerId: string, channel: ChannelName, data: Uint8Array) => void> = []
  const bMessageCbs: Array<(peerId: string, channel: ChannelName, data: Uint8Array) => void> = []
  const aPeerLostCbs: Array<(peerId: string) => void> = []
  const bPeerLostCbs: Array<(peerId: string) => void> = []

  function isClosed(side: Side): boolean {
    return side === 'a' ? aClosed : bClosed
  }

  function enqueue(from: Side, channel: ChannelName, data: Uint8Array): void {
    if (channel === 'unreliable') {
      const lossRoll = rngAt(seed, cursor)
      const jitterRoll = rngAt(seed, cursor + 1)
      cursor += 2
      if (lossRoll < lossRate) return
      pending.push({ from, channel, data, deliverAt: lastNow + latencyMs + jitterRoll * jitterMs })
    } else {
      pending.push({ from, channel, data, deliverAt: lastNow + latencyMs })
    }
  }

  function makeSide(self: Side): Transport {
    const other: Side = self === 'a' ? 'b' : 'a'
    const messageCbs = self === 'a' ? aMessageCbs : bMessageCbs
    const peerLostCbs = self === 'a' ? aPeerLostCbs : bPeerLostCbs
    return {
      send(channel, _peerId, data) {
        if (isClosed(self)) return
        enqueue(self, channel, data)
      },
      broadcast(channel, data) {
        if (isClosed(self)) return
        enqueue(self, channel, data)
      },
      onMessage(cb) {
        messageCbs.push(cb)
      },
      onPeerLost(cb) {
        peerLostCbs.push(cb)
      },
      peers() {
        if (isClosed(self)) return []
        return isClosed(other) ? [] : [other]
      },
      close() {
        if (self === 'a') aClosed = true
        else bClosed = true
      },
    }
  }

  const a = makeSide('a')
  const b = makeSide('b')

  function pump(nowMs: number): void {
    lastNow = nowMs
    const ready: PendingMessage[] = []
    const stillPending: PendingMessage[] = []
    for (const m of pending) {
      if (m.deliverAt <= nowMs) ready.push(m)
      else stillPending.push(m)
    }
    pending.length = 0
    for (const m of stillPending) pending.push(m)
    ready.sort((x, y) => x.deliverAt - y.deliverAt)
    for (const m of ready) {
      const destination: Side = m.from === 'a' ? 'b' : 'a'
      if (isClosed(destination)) continue
      const cbs = destination === 'a' ? aMessageCbs : bMessageCbs
      for (const cb of cbs) cb(m.from, m.channel, m.data)
    }
  }

  return { a, b, pump }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/net/test/loopback.test.ts`
Expected: PASS, 4 tests.

### Part B — `net-fixtures.ts`

- [ ] **Step 5: Write the failing test for the fixtures**

Create `packages/net/test/net-fixtures.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { makeLossyPair, makeNetContext } from './fixtures/net-fixtures'

describe('makeNetContext', () => {
  it('builds a SimContext over the Plan 1 oval track with the fixture tuning and characters', () => {
    const ctx = makeNetContext()
    expect(ctx.track.id).toBe('oval')
    expect(ctx.characters.length).toBe(8)
    expect(ctx.tuning.kartRadius).toBe(0.9)
    expect(ctx.isLeader).toBe(true)

    // Proves query is built from the real oval track, not a stub: this is
    // makeOvalTrack()'s own first control point, confirmed by running
    // buildTrackQuery(makeOvalTrack()).sampleAt(0) directly.
    const p0 = ctx.query.sampleAt(0)
    expect(p0.position.x).toBe(-200)
    expect(p0.position.z).toBe(-100)
    expect(p0.width).toBe(24)
  })

  it('honours an explicit isLeader', () => {
    expect(makeNetContext(false).isLeader).toBe(false)
    expect(makeNetContext(true).isLeader).toBe(true)
  })
})

describe('makeLossyPair', () => {
  it('defaults to spec §8\'s conditions: 150ms latency, 50ms jitter, 5% loss, seed 0xC0FFEE', () => {
    const { a, b, pump } = makeLossyPair()
    let delivered = false
    b.onMessage(() => { delivered = true })
    a.send('unreliable', 'b', new Uint8Array([9]))

    pump(149)
    expect(delivered).toBe(false)
    pump(250) // 150 + up to 50 jitter: always arrived by 250
    expect(delivered).toBe(true)
  })

  it('applies overrides on top of the defaults', () => {
    const { a, b, pump } = makeLossyPair({ lossRate: 1 })
    let delivered = false
    b.onMessage(() => { delivered = true })
    a.send('unreliable', 'b', new Uint8Array([9]))
    pump(1000)
    expect(delivered).toBe(false) // lossRate 1 drops every unreliable send
  })
})
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `npx vitest run packages/net/test/net-fixtures.test.ts`

Expected: FAIL with `Error: Cannot find module './fixtures/net-fixtures'
imported from '.../packages/net/test/net-fixtures.test.ts'`.
`packages/net/src/loopback.ts` already exists from Part A, so this failure is
specifically about `net-fixtures.ts` not existing yet, not about anything
upstream.

- [ ] **Step 7: Implement `packages/net/test/fixtures/net-fixtures.ts`**

Create `packages/net/test/fixtures/net-fixtures.ts`:

```ts
import type { SimContext } from '@tapkart/sim'
import { buildTrackQuery } from '@tapkart/sim'
import { makeCharacters, makeOvalTrack, makeTuning } from '../../../sim/test/fixtures/track-fixtures'
import type { LoopbackOptions } from '../../src/loopback'
import { makeLoopbackPair } from '../../src/loopback'

/**
 * A SimContext over the Plan 1 golden oval track (packages/sim/test/fixtures
 * /track-fixtures.ts's makeOvalTrack) with Plan 1's base tuning table and its
 * 8 fixture characters. Reached by relative path, not the @tapkart/sim
 * package specifier: these three functions live under sim's test/fixtures,
 * which sim's own production barrel never re-exports -- see this task's
 * Interfaces block for the full justification.
 */
export function makeNetContext(isLeader = true): SimContext {
  const track = makeOvalTrack()
  return {
    track,
    query: buildTrackQuery(track),
    tuning: makeTuning(),
    characters: makeCharacters(),
    isLeader,
  }
}

/** Spec §8's convergence and zero-corrections conditions. */
const DEFAULT_LOOPBACK_OPTIONS: LoopbackOptions = {
  latencyMs: 150,
  jitterMs: 50,
  lossRate: 0.05,
  seed: 0xc0ffee,
}

export function makeLossyPair(
  overrides?: Partial<LoopbackOptions>,
): ReturnType<typeof makeLoopbackPair> {
  return makeLoopbackPair({ ...DEFAULT_LOOPBACK_OPTIONS, ...overrides })
}
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `npx vitest run packages/net/test/net-fixtures.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 9: Typecheck the package and run the whole `net` and `protocol` suites**

Run:

```bash
npx tsc --noEmit -p packages/net
npx vitest run packages/net packages/protocol
```

Expected: no diagnostics; every test in both packages passes, including this
task's 8 (`loopback.test.ts` 4, `net-fixtures.test.ts` 4) alongside Task 11's
5 (2 in `scaffold.test.ts`, 3 in `transport.test.ts` — Task 11's own
residual-findings pass added a third transport test, so this figure no longer
matches its original "4") and Task 10's 2.

- [ ] **Step 10: Full repo sanity check**

Run:

```bash
npm run typecheck
npm test
```

Expected: both exit 0.

- [ ] **Step 11: Commit**

```bash
git add packages/net/src/loopback.ts packages/net/test/loopback.test.ts \
        packages/net/test/fixtures/net-fixtures.ts packages/net/test/net-fixtures.test.ts
git commit -m "feat(net): LoopbackTransport pair and net test fixtures

makeLoopbackPair wires two Transports together with injected latency,
jitter and loss, and a pump(nowMs) that is the only clock this module
reads -- send()/broadcast() schedule against whatever nowMs the last
pump() call provided.

Jitter and loss are drawn from rngAt(seed, cursor) on a cursor this
pair owns and advances itself, two draws per unreliable send
(unconditionally, whether or not the message survives) and zero for
reliable sends -- never state.rngCursor, which belongs to the leader's
item rolls and would desynchronise the shadow authority if a transport
touched it. Jitter is one-sided (extra delay in [0, jitterMs)), so
'arrives after latencyMs and not before' holds unconditionally.

Reliable sends carry no jitter, so their scheduled delivery times are
already monotonic in send order; the single sort-based delivery
algorithm in pump() therefore preserves reliable order as a structural
consequence and allows unreliable reordering as the same algorithm's
natural consequence of jittered scheduling -- proven with a seed and
call sequence that reorders 8 sends into [6,2,3,4,0,5,7,1], reproduced
identically across two independent pairs built from the same seed.

net-fixtures.ts adds makeNetContext (the Plan 1 oval track, reached by
relative import since sim's production barrel never exports test
fixtures) and makeLossyPair, preset to spec §8's 150ms/50ms/5%/0xC0FFEE
convergence conditions."
```

---

### Task 13: The Follower's Event Applier

**Files:**
- Create: `packages/net/src/apply.ts`
- Test: `packages/net/test/apply.test.ts`

**Interfaces:**

- Consumes (all verified against real source before writing this brief — see the
  verification note below):
  - `packages/sim/src/types.ts` — `AuthEventKind` is exactly
    `'itemGrant' | 'entitySpawn' | 'entityDespawn' | 'hit' | 'spinOut' | 'respawn' | 'lapCross' | 'finish'`.
    `AuthEvent` is exactly `{ eventSeq: number; tick: number; kind: AuthEventKind; playerId: number; entityId: number; item: ItemKind; data: number }`,
    with `entityId` `-1` when not applicable, `item` `'none'` when not
    applicable, `data` `0` when unused. `SimState.nextEventSeq` is the field
    `emit()` (Plan 1, `packages/sim/src/state.ts`) stamps every event's
    `eventSeq` from and then post-increments; `createState` initializes it to
    `0`. `SimContext` carries `isLeader`.
  - `packages/sim/src/entity.ts` — `export function kartById(state: SimState, playerId: number): KartState | null`,
    a linear scan of `state.karts` returning `null` when no kart's `playerId`
    matches (in particular for `playerId === -1`, the finish-sentinel value).
  - `packages/sim/src/items.ts` — `export function applyItemGrant(ctx: SimContext, state: SimState, ev: AuthEvent): void`,
    already shipped in Plan 1 and already barrel-exported (`packages/sim/src/index.ts`
    has `export * from './items'`). Read directly: it returns early unless
    `ev.kind === 'itemGrant'`, looks the kart up with `kartById`, sets
    `k.item = ev.item`, and — the half a hand-rolled `k.item = ev.item` would
    miss — puts the *item box* named by `ev.data` back on its respawn timer
    (`if (box.respawnTicks <= 0) box.respawnTicks = ctx.tuning.itemBoxRespawnTicks`).
    Its own doc comment states the reason: *"`ev.data` carries the boxIdx, so a
    follower that missed the local pickup (fresh join, post-resync) still puts
    the box on its respawn timer."*
  - `packages/sim/src/state.ts` — `export function createState(ctx: SimContext, seed: number, characterIdx: number[]): SimState`,
    used only by this task's tests.
  - `packages/net/test/fixtures/net-fixtures.ts` [Task 12, locked contract §6] —
    `export function makeNetContext(isLeader?: boolean): SimContext`. This
    task's tests always pass `false` explicitly (never rely on the default),
    because `applyEvent` is the *follower's* half of the emit-gating rule and
    every test here represents a peer that never emits.
  - The barrel `@tapkart/sim` (`packages/sim/src/index.ts`) re-exports
    `types.ts`, `entity.ts` and `state.ts` in full via `export *`, so this
    task imports everything above through `@tapkart/sim`, never through a
    relative path into `packages/sim`.

- Produces (locked contract §5):
  - `export function applyEvent(ctx: SimContext, state: SimState, ev: AuthEvent): boolean`
    — `false` when `ev` was already applied (or is older than the highest
    already applied), `true` otherwise, having advanced `state.nextEventSeq`.

**Verification performed for this brief (the hazard this plan learned the
expensive way):** this brief makes claims about what six functions in
`packages/sim` actually do — `emit`, `kartById`, `startSpinOut`, `beginRespawn`,
`updateLaps`'s finish/lapCross emission, and `updateItemBoxes`'s itemGrant
emission. Every one of those claims was checked by reading
`packages/sim/src/state.ts`, `entity.ts`, `recovery.ts`, `laps.ts`, `items.ts`
and `phase.ts` directly, not inferred from the spec or the contract. The exact
per-`data`-field meaning table below is transcribed from that reading, with the
source cited per row. Where this brief also had to make a *design* decision not
settled by any of those files or by the locked contract (the exact mutation
`applyEvent` performs per event kind), that decision and its reasoning are
written out in full below, and the entire implementation and every test in this
brief were run against the real, currently-merged `packages/sim` (Plan 1,
`1f1f2c4`) before this brief was written, and passed — 10 tests, one file, zero
edits needed after the first pass. That run is not part of the checked-in
history (this brief's Step 1–4 recreate it from scratch inside `packages/net`,
which does not exist yet), but it is why every expected assertion value below
is exact rather than estimated.

---

**Why a function this small carries eight cases and not one.**

Spec §5 ("Events"): every event carries a global monotonic `eventSeq` assigned
by the current authority; a follower applies each event once and ignores any
`eventSeq` at or below the highest already applied. That much is uniform across
all eight kinds and is the *only* thing `entitySpawn` and `entityDespawn` need
`applyEvent` to do for them — see below. But four of the other five kinds carry
information a follower cannot always reconstruct by re-simulating, and the
brief that authored the parent contract only flagged one of them
(`itemGrant`) by name. Re-deriving the rest from the actual call sites found
two more categories:

1. **`itemGrant` — leader-only PRNG roll (`items.ts` line ~136).** A follower's
   `rollItem` returns `'none'` unconditionally (`if (!ctx.isLeader) return 'none'`,
   `items.ts`), so a follower's own kart's `k.item` never becomes anything but
   `'none'` through local simulation. The granted item exists nowhere except
   the event. **Must apply — and both halves of it, not just the kart's.**
   `updateItemBoxes` emits `emit(state, events, 'itemGrant', k.playerId, -1, item, box.boxIdx)`,
   so `ev.data` is the **box index**, and the pickup has two consequences: the
   kart holds the item *and* that box goes onto its respawn timer. Only the
   first is visible in `WireKart`; a box's `respawnTicks` is in neither
   `WireSnapshot` nor any other event, so a peer that never simulated the
   pickup — a `ClientLoop`, which never predicts remote karts — would keep
   offering a box the authority has already consumed. `packages/sim/src/items.ts`
   already ships exactly this operation as `applyItemGrant(ctx, state, ev)`,
   written for this path and tested in Plan 1, so `applyEvent` delegates to it
   rather than re-deriving half of it. **This is the one case where `applyEvent`
   reuses a sim function instead of writing its own fields** — the exception is
   deliberate and the reason is below.

2. **`hit` and the `spinOut` that follows an unshielded hit
   (`entity.ts` lines ~250–262) — caused by an entity the receiver never
   simulated.** Entities owned by other karts are never predicted (spec §5,
   "Prediction and reconciliation": "Entities are authority-simulated and
   client-interpolated only, never predicted"). A client that never simulated
   the seeker that just hit it cannot have independently run
   `startSpinOut`/cleared its own `shielded` flag — its local
   `updateRecovery`/`updateEntities` calls never saw that seeker, because the
   client's own predicted state never held it. Spec §5 says this outright:
   *"The local kart's hit reaction plays on receipt, not on prediction."*
   **Must apply.** `entity.ts`'s emit call is `emit(state, events, 'hit', k.playerId, e.entityId, e.kind, 1)`
   when a shield absorbed the hit and `... 0)` when it did not (the shield-clear,
   `k.shielded = false`, happens in the same branch as the `1` emit, immediately
   before it). The immediately following `startSpinOut(…)` call (only reached on
   the `0`/unshielded branch) is what actually emits `'spinOut'`. *That call site
   is **not** quoted with a parameter list here, deliberately:* Plan 1 ships
   `startSpinOut(state, k, ticks, events)`, and Plan 2 Task 2 re-signs it to
   take `ctx` (locked contract §2a) before this task runs — so any parameter
   list written here would be stale on the day this brief executes. Nothing in
   this task calls `startSpinOut`; only its *effect* on `KartState` matters
   below, and that effect is unchanged by the re-signing.
   `startSpinOut` (`recovery.ts`) sets
   `k.spinOutTicks = ticks; k.drift.active = false; k.drift.dir = 0; k.drift.charge = 0; k.boostTicks = 0`
   before its own `emit(state, events, 'spinOut', k.playerId, -1, 'none', ticks)`.

3. **`finish` — depends on every kart's placement, which a follower only
   predicts correctly for its own kart.** `WireSnapshot` (locked contract §3)
   has no field for race placement or finish order at all — no `finished`,
   no `place`, nothing — confirmed by reading the full `WireKart`/`WireSnapshot`
   interface in §3. `state.finishedOrder` is therefore recoverable **only**
   from `'finish'` events. This matters even for a lockstep-simulating peer
   (the future shadow authority, Task 16): `laps.ts`'s per-kart finish credit
   (`state.finishedOrder[slot] = k.playerId`, unconditional, not gated by
   `ctx.isLeader` — only its `emit()` call is gated) is self-sufficient for a
   peer simulating every kart's true input, but `phase.ts`'s DNF/timeout sweep
   calls `placementOrder(state)` across **all eight karts** to decide finishing
   order for karts still racing when `FINISH_GRACE_TICKS` elapses — and a
   `ClientLoop` (Task 15), which never predicts remote karts, does not have
   accurate placement data for the other seven. **Must apply**, both branches:
   `laps.ts` emits `emit(state, events, 'finish', k.playerId, -1, 'none', slot + 1)`
   (`data` is the **1-based** finishing place — `slot` is 0-based); `phase.ts`'s
   DNF sweep emits the same shape with the same 1-based-place meaning (its own
   comment says so: *"the same meaning updateLaps gives data"*); `phase.ts`'s
   final line emits the sentinel `emit(state, events, 'finish', -1, -1, 'none', finishers)`
   marking the phase transition itself, once, after every real per-kart finish
   for that tick.

4. **`respawn` and `lapCross` — always self-derivable for the kart's own
   local prediction, applied anyway for defense in depth and because
   `WireSnapshot` already carries their fields too (`respawnTicks` exact-compared,
   `lap` exact-compared per §4), so applying them here costs nothing and is
   idempotent with what the next snapshot would show regardless.** Both are
   triggered purely by the kart's own position (`recovery.ts`'s
   `!ctx.query.isInBounds(...)`, `laps.ts`'s own-position checkpoint projection)
   — no cross-kart information — so a `ClientLoop` predicting its own kart
   correctly will independently reach the same value. Applied anyway: `respawn`
   sets `k.respawnTicks = ev.data` (`recovery.ts`'s `beginRespawn` emits with
   `data = k.respawnTicks`, the value it just assigned); `lapCross` sets
   `k.lap.lap = ev.data` and `k.lap.checkpointIdx = 0` — the checkpoint index is
   not carried in the event's fields at all, but `laps.ts` only ever emits
   `'lapCross'` on the branch guarded by `if (idx !== 0) return`, i.e. exactly
   when the crossed checkpoint **is** index 0, so `0` is the only value it could
   ever be and this brief derives it rather than inventing a field.

5. **`entitySpawn` and `entityDespawn` — no mutation is possible, only
   sequencing.** `AuthEvent` carries no `Vec3` at all (re-read the type above:
   `eventSeq, tick, kind, playerId, entityId, item, data` — nothing else), so
   an entity's position, velocity and heading are not reconstructable from its
   spawn event under any design. `entitySpawn`'s emit call
   (`emit(state, events, 'entitySpawn', ownerId, entityId, kind, ttl)`) smuggles
   the spawned entity's `EntityKind` through `AuthEvent.item: ItemKind` — legal
   only because every `EntityKind` string (`'seeker' | 'bolt' | 'slick' | 'bubble' | 'surge' | 'charge'`)
   is also a valid `ItemKind` string — and carries `ttl` in `data`, but never a
   position. Entity truth is carried exclusively by `WireSnapshot` (never
   predicted, per spec §5), so these two kinds exist on the wire solely to keep
   `nextEventSeq` advancing in lockstep with every kind the authority emits.
   `applyEvent` does nothing beyond the universal sequencing step for them.

The resulting table, `data`'s meaning per kind, all six citations above:

| kind | `playerId` means | mutation |
|---|---|---|
| `itemGrant` | kart granted the item | `applyItemGrant(ctx, state, ev)`: `k.item = ev.item` **and** item box `ev.data` goes onto `ctx.tuning.itemBoxRespawnTicks` |
| `hit` | kart that was hit | `data === 1`: `k.shielded = false`. `data === 0`: none (the following `spinOut` event carries the real consequence) |
| `spinOut` | kart spinning out | `k.spinOutTicks = ev.data`; clear `drift.active`, `drift.dir`, `drift.charge`, `boostTicks` to their zero values, exactly mirroring `startSpinOut` |
| `respawn` | kart respawning | `k.respawnTicks = ev.data` |
| `lapCross` | kart completing a lap | `k.lap.lap = ev.data`; `k.lap.checkpointIdx = 0` |
| `finish`, `playerId >= 0` | kart finishing | `state.finishedOrder[ev.data - 1] = ev.playerId`; if `state.finishTick < 0`, `state.finishTick = ev.tick` |
| `finish`, `playerId === -1` | (sentinel: the race itself) | `state.phase = 'finished'` |
| `entitySpawn` / `entityDespawn` | owner of the entity | none — sequencing only |

**Why `applyEvent` calls `applyItemGrant` but does not call `startSpinOut`,
`beginRespawn`, `spawnEntity` or `despawnEntityAt`.** `applyItemGrant` is the
one sim function in this list written *for the receiving side*: its doc comment
says so ("Follower path for an authoritative item grant"), it emits nothing, it
has no leader-side entry guard, and it is the sole owner of the box-timer half
of a grant. Re-deriving it here would duplicate a tested function and, worse,
would silently drift from it the first time `items.ts` changes what a pickup
costs. The other four are the opposite case. All four are written for the
*leader's forward simulation* and carry guards appropriate to that context but
wrong for a receiver trusting the wire: `startSpinOut` refuses a shorter spin
than the one already running (`if (ticks <= k.spinOutTicks) return`) — correct
when a leader is *deciding whether a new hit should extend a spin*, wrong when
an authoritative event is *stating what happened*, because a legitimate
correction could then be silently dropped if the receiver's own guess happened
to already have a larger value. All four also call `emit()` themselves, which
would either double-count `nextEventSeq` (already advanced once by
`applyEvent`'s own gating step) or require threading a throwaway `events` array
through for no purpose. `applyEvent` performs its own narrow, unconditional
field writes instead, four to six lines each, matching only the *effect* those
functions have on `KartState`/`SimState`, never their entry guards.

**Why the first parameter is `ctx` and stays named `ctx`.** The locked
contract's signature is
`applyEvent(ctx: SimContext, state: SimState, ev: AuthEvent): boolean`. This
implementation reads `ctx` in exactly one place — it hands it to
`applyItemGrant`, which needs `ctx.tuning.itemBoxRespawnTicks` — so the
parameter is genuinely consumed and needs no underscore.

That is worth stating because an earlier draft of this brief named it `_ctx`
and explained at length why: `tsconfig.base.json` sets
`"noUnusedParameters": true`, and TypeScript 5.9 (confirmed by direct
compilation against this exact tsconfig) flags an unused *leading* parameter
with `TS6133` even when later parameters in the same function are used — it
does **not** exempt a parameter merely for preceding a used one. That finding
is still true and still relevant to Tasks 14–16, but it no longer applies here.
**Do not "simplify" the `itemGrant` case back to a bare `k.item = ev.item`:**
doing so drops the item box's respawn timer *and* makes `ctx` unused again,
and `TS6133` is the only thing that would tell you — a follower quietly
re-offering a consumed box is not a compile error.

---

- [ ] **Step 1: Write the failing test**

Create `packages/net/test/apply.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { AuthEvent } from '@tapkart/sim'
import { createState } from '@tapkart/sim'
import { applyEvent } from '../src/apply'
import { makeNetContext } from './fixtures/net-fixtures'

const SEED = 0x1234abcd
const CHARS = [0, 1, 2, 3, 4, 5, 6, 7]

describe('applyEvent — sequencing', () => {
  it('is a no-op the second time the same event is applied', () => {
    const ctx = makeNetContext(false)
    const state = createState(ctx, SEED, CHARS)
    const ev: AuthEvent = {
      eventSeq: 0, tick: 5, kind: 'itemGrant',
      playerId: 2, entityId: -1, item: 'boost', data: 0,
    }

    expect(applyEvent(ctx, state, ev)).toBe(true)
    expect(state.karts[2].item).toBe('boost')
    expect(state.itemBoxes[0].respawnTicks).toBe(ctx.tuning.itemBoxRespawnTicks)
    expect(state.nextEventSeq).toBe(1)

    // Both fields are changed between the two applications, so the second call
    // re-writing EITHER of them would be observable, not just a matching no-op.
    state.karts[2].item = 'seeker'
    state.itemBoxes[0].respawnTicks = 0
    expect(applyEvent(ctx, state, ev)).toBe(false)
    expect(state.karts[2].item).toBe('seeker')       // untouched: the 2nd apply did nothing
    expect(state.itemBoxes[0].respawnTicks).toBe(0)  // and did not re-arm the box either
    expect(state.nextEventSeq).toBe(1)
  })

  it('ignores any eventSeq at or below the highest already applied', () => {
    const ctx = makeNetContext(false)
    const state = createState(ctx, SEED, CHARS)
    const high: AuthEvent = {
      eventSeq: 5, tick: 10, kind: 'itemGrant',
      playerId: 0, entityId: -1, item: 'boost', data: 0,
    }
    const lower: AuthEvent = {
      eventSeq: 2, tick: 4, kind: 'itemGrant',
      playerId: 0, entityId: -1, item: 'seeker', data: 0,
    }
    const sameSeqDifferentEvent: AuthEvent = {
      eventSeq: 5, tick: 10, kind: 'itemGrant',
      playerId: 0, entityId: -1, item: 'bolt', data: 0,
    }

    expect(applyEvent(ctx, state, high)).toBe(true)
    expect(state.nextEventSeq).toBe(6)
    expect(state.karts[0].item).toBe('boost')

    expect(applyEvent(ctx, state, lower)).toBe(false)
    expect(state.nextEventSeq).toBe(6)          // unchanged
    expect(state.karts[0].item).toBe('boost')   // not overwritten by the stale event

    // "at or below": eventSeq 5 equals the highest already applied (5), not
    // just below it, and must also be ignored.
    expect(applyEvent(ctx, state, sameSeqDifferentEvent)).toBe(false)
    expect(state.karts[0].item).toBe('boost')
  })
})

describe('applyEvent — per-kind mutation', () => {
  it('itemGrant sets the kart\'s item AND puts the named box on its respawn timer', () => {
    const ctx = makeNetContext(false)
    const state = createState(ctx, SEED, CHARS)
    // data is the boxIdx (items.ts: emit(..., 'itemGrant', k.playerId, -1, item, box.boxIdx)).
    const ev: AuthEvent = {
      eventSeq: 0, tick: 1, kind: 'itemGrant',
      playerId: 5, entityId: -1, item: 'bubble', data: 3,
    }
    expect(state.itemBoxes.length).toBeGreaterThan(3)  // the oval fixture ships 6 boxes
    expect(state.itemBoxes[3].respawnTicks).toBe(0)
    expect(applyEvent(ctx, state, ev)).toBe(true)
    expect(state.karts[5].item).toBe('bubble')
    expect(state.itemBoxes[3].respawnTicks).toBe(ctx.tuning.itemBoxRespawnTicks)
    // and only that box: a receiver must not blanket-arm the whole track.
    expect(state.itemBoxes[0].respawnTicks).toBe(0)
    expect(state.itemBoxes[4].respawnTicks).toBe(0)
  })

  it('itemGrant with a data value outside the box array still grants the item', () => {
    const ctx = makeNetContext(false)
    const state = createState(ctx, SEED, CHARS)
    const ev: AuthEvent = {
      eventSeq: 0, tick: 1, kind: 'itemGrant',
      playerId: 5, entityId: -1, item: 'bubble', data: 999,
    }
    expect(applyEvent(ctx, state, ev)).toBe(true)
    expect(state.karts[5].item).toBe('bubble')
    for (const box of state.itemBoxes) expect(box.respawnTicks).toBe(0)
  })

  it('hit with data 1 clears the shield', () => {
    const ctx = makeNetContext(false)
    const state = createState(ctx, SEED, CHARS)
    state.karts[4].shielded = true
    const ev: AuthEvent = {
      eventSeq: 0, tick: 1, kind: 'hit',
      playerId: 4, entityId: 9, item: 'seeker', data: 1,
    }
    expect(applyEvent(ctx, state, ev)).toBe(true)
    expect(state.karts[4].shielded).toBe(false)
  })

  it('hit with data 0 changes no kart field beyond sequencing', () => {
    const ctx = makeNetContext(false)
    const state = createState(ctx, SEED, CHARS)
    state.karts[4].shielded = false
    const ev: AuthEvent = {
      eventSeq: 0, tick: 1, kind: 'hit',
      playerId: 4, entityId: 9, item: 'seeker', data: 0,
    }
    expect(applyEvent(ctx, state, ev)).toBe(true)
    expect(state.karts[4].shielded).toBe(false)
    expect(state.nextEventSeq).toBe(1)
  })

  it('spinOut sets the timer and clears drift and boost', () => {
    const ctx = makeNetContext(false)
    const state = createState(ctx, SEED, CHARS)
    state.karts[1].drift.active = true
    state.karts[1].drift.dir = 1
    state.karts[1].drift.charge = 90
    state.karts[1].boostTicks = 10
    const ev: AuthEvent = {
      eventSeq: 0, tick: 1, kind: 'spinOut',
      playerId: 1, entityId: -1, item: 'none', data: 60,
    }
    expect(applyEvent(ctx, state, ev)).toBe(true)
    expect(state.karts[1].spinOutTicks).toBe(60)
    expect(state.karts[1].drift.active).toBe(false)
    expect(state.karts[1].drift.dir).toBe(0)
    expect(state.karts[1].drift.charge).toBe(0)
    expect(state.karts[1].boostTicks).toBe(0)
  })

  it('respawn sets the respawn timer', () => {
    const ctx = makeNetContext(false)
    const state = createState(ctx, SEED, CHARS)
    const ev: AuthEvent = {
      eventSeq: 0, tick: 1, kind: 'respawn',
      playerId: 6, entityId: -1, item: 'none', data: 72,
    }
    expect(applyEvent(ctx, state, ev)).toBe(true)
    expect(state.karts[6].respawnTicks).toBe(72)
  })

  it('lapCross sets the lap count and resets checkpointIdx to 0', () => {
    const ctx = makeNetContext(false)
    const state = createState(ctx, SEED, CHARS)
    state.karts[3].lap.checkpointIdx = 11
    const ev: AuthEvent = {
      eventSeq: 0, tick: 1, kind: 'lapCross',
      playerId: 3, entityId: -1, item: 'none', data: 1,
    }
    expect(applyEvent(ctx, state, ev)).toBe(true)
    expect(state.karts[3].lap.lap).toBe(1)
    expect(state.karts[3].lap.checkpointIdx).toBe(0)
  })

  it('finish for a real kart writes finishedOrder at data-1 and stamps finishTick once', () => {
    const ctx = makeNetContext(false)
    const state = createState(ctx, SEED, CHARS)
    const first: AuthEvent = {
      eventSeq: 0, tick: 200, kind: 'finish',
      playerId: 3, entityId: -1, item: 'none', data: 1,
    }
    expect(applyEvent(ctx, state, first)).toBe(true)
    expect(state.finishedOrder[0]).toBe(3)
    expect(state.finishTick).toBe(200)

    const second: AuthEvent = {
      eventSeq: 1, tick: 250, kind: 'finish',
      playerId: 7, entityId: -1, item: 'none', data: 2,
    }
    expect(applyEvent(ctx, state, second)).toBe(true)
    expect(state.finishedOrder[1]).toBe(7)
    expect(state.finishTick).toBe(200)   // stamped once, at the first finisher's tick
  })

  it('finish with playerId -1 transitions the phase to finished', () => {
    const ctx = makeNetContext(false)
    const state = createState(ctx, SEED, CHARS)
    const sentinel: AuthEvent = {
      eventSeq: 0, tick: 500, kind: 'finish',
      playerId: -1, entityId: -1, item: 'none', data: 8,
    }
    expect(state.phase).toBe('countdown')
    expect(applyEvent(ctx, state, sentinel)).toBe(true)
    expect(state.phase).toBe('finished')
  })

  it('entitySpawn and entityDespawn advance nextEventSeq and touch nothing else', () => {
    const ctx = makeNetContext(false)
    const state = createState(ctx, SEED, CHARS)
    const entityCountBefore = state.entityCount
    const kartsSnapshot = JSON.stringify(state.karts)

    const spawn: AuthEvent = {
      eventSeq: 0, tick: 1, kind: 'entitySpawn',
      playerId: 2, entityId: 5, item: 'seeker', data: 600,
    }
    expect(applyEvent(ctx, state, spawn)).toBe(true)
    expect(state.entityCount).toBe(entityCountBefore)
    expect(state.nextEventSeq).toBe(1)
    expect(JSON.stringify(state.karts)).toBe(kartsSnapshot)

    const despawn: AuthEvent = {
      eventSeq: 1, tick: 30, kind: 'entityDespawn',
      playerId: 2, entityId: 5, item: 'seeker', data: 0,
    }
    expect(applyEvent(ctx, state, despawn)).toBe(true)
    expect(state.entityCount).toBe(entityCountBefore)
    expect(state.nextEventSeq).toBe(2)
  })
})

describe('applyEvent — a realistic multi-tick sequence', () => {
  it('applies six events spanning 190 ticks, threading nextEventSeq call to call', () => {
    const ctx = makeNetContext(false)
    const state = createState(ctx, SEED, CHARS)
    const events: AuthEvent[] = [
      { eventSeq: 0, tick: 10, kind: 'itemGrant', playerId: 3, entityId: -1, item: 'seeker', data: 0 },
      { eventSeq: 1, tick: 40, kind: 'lapCross', playerId: 3, entityId: -1, item: 'none', data: 1 },
      { eventSeq: 2, tick: 90, kind: 'spinOut', playerId: 5, entityId: -1, item: 'none', data: 60 },
      { eventSeq: 3, tick: 91, kind: 'hit', playerId: 5, entityId: 7, item: 'seeker', data: 0 },
      { eventSeq: 4, tick: 150, kind: 'lapCross', playerId: 3, entityId: -1, item: 'none', data: 2 },
      { eventSeq: 5, tick: 200, kind: 'finish', playerId: 3, entityId: -1, item: 'none', data: 1 },
    ]

    for (const ev of events) {
      expect(applyEvent(ctx, state, ev)).toBe(true)
    }

    expect(state.nextEventSeq).toBe(6)
    expect(state.karts[3].item).toBe('seeker')
    expect(state.itemBoxes[0].respawnTicks).toBe(ctx.tuning.itemBoxRespawnTicks)
    expect(state.karts[3].lap.lap).toBe(2)
    expect(state.karts[3].lap.checkpointIdx).toBe(0)
    expect(state.karts[5].spinOutTicks).toBe(60)
    expect(state.finishedOrder[0]).toBe(3)
    expect(state.finishTick).toBe(200)

    // Replaying the exact same six events again — as would happen if the
    // reliable channel redelivered a batch the peer had already applied — must
    // change nothing, in one pass, in order. Every field the six events wrote
    // is scrambled first, so a re-application is observable on every one of
    // them rather than being hidden by an identical rewrite.
    state.karts[3].item = 'none'
    state.itemBoxes[0].respawnTicks = 0
    state.karts[3].lap.lap = 9
    state.karts[5].spinOutTicks = 0
    state.finishedOrder[0] = -1
    for (const ev of events) {
      expect(applyEvent(ctx, state, ev)).toBe(false)
    }
    expect(state.nextEventSeq).toBe(6)
    expect(state.karts[3].item).toBe('none')
    expect(state.itemBoxes[0].respawnTicks).toBe(0)
    expect(state.karts[3].lap.lap).toBe(9)
    expect(state.karts[5].spinOutTicks).toBe(0)
    expect(state.finishedOrder[0]).toBe(-1)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/net/test/apply.test.ts`

Expected: FAIL. `packages/net/src/apply.ts` does not exist yet, so the whole
file fails to load (no individual test runs):

```
Error: Cannot find module '../src/apply' imported from
'<repo>/packages/net/test/apply.test.ts'
  ...
Caused by: Error: Failed to load url ../src/apply (resolved id: ../src/apply)
in .../packages/net/test/apply.test.ts. Does the file exist?

 Test Files  1 failed (1)
      Tests  no tests
```

(Verified directly against this repo's installed Vitest 3.2.7 / Vite toolchain,
not assumed: a probe test importing a nonexistent sibling module under this
exact `vitest.config.ts` produces exactly this two-part message — "Cannot find
module" as the primary error, "Failed to load url ... Does the file exist?" as
its cause. If `packages/net/package.json`, `packages/net/tsconfig.json` or
`packages/net/test/fixtures/net-fixtures.ts` also do not exist yet at the time
this step runs, the failure will instead be about one of *those* missing
first — Tasks 11 and 12 must land before this one for exactly that reason.)

- [ ] **Step 3: Write the minimal implementation**

Create `packages/net/src/apply.ts`:

```ts
import type { AuthEvent, SimContext, SimState } from '@tapkart/sim'
import { applyItemGrant, kartById } from '@tapkart/sim'

/**
 * The follower's half of the emit-gating rule (locked contract §1b, §5).
 *
 * A leader's `emit()` (packages/sim/src/state.ts) stamps every AuthEvent with
 * the state's own `nextEventSeq` and then advances it. A follower never calls
 * `emit()` (every one of its 11 call sites is gated on `ctx.isLeader`), so a
 * follower's `nextEventSeq` is advanced *only* by applying events received off
 * the wire — this function is the entire mechanism by which that happens.
 *
 * Returns `false`, and changes nothing, when `ev.eventSeq` is at or below the
 * highest already applied: a duplicate delivery (the reliable channel is
 * ordered but a caller might still redeliver a batch it already processed) or
 * a stale/out-of-order arrival is a safe no-op, which is exactly what makes
 * authority migration safe (spec §5) — a promoted shadow's re-broadcast events
 * are never double-counted by a peer that already saw them once.
 *
 * Per-kind mutation is documented in full in this task's brief; the short
 * version: `itemGrant` (leader-only PRNG roll), `hit`/`spinOut` (caused by an
 * entity the receiver never simulated) and `finish` (WireSnapshot carries no
 * placement data at all) carry information a receiver cannot derive any other
 * way and must be applied. `respawn` and `lapCross` are self-derivable by a
 * peer correctly predicting its own kart, but are applied anyway — cheap,
 * idempotent, and consistent with what the next WireSnapshot would show.
 * `entitySpawn`/`entityDespawn` carry no position (AuthEvent has no Vec3 field
 * at all) and mutate nothing; entity truth is exclusively WireSnapshot's job.
 */
export function applyEvent(ctx: SimContext, state: SimState, ev: AuthEvent): boolean {
  if (ev.eventSeq < state.nextEventSeq) return false
  state.nextEventSeq = ev.eventSeq + 1

  switch (ev.kind) {
    case 'itemGrant': {
      // Both halves of a pickup: the kart's item AND the box's respawn timer
      // (ev.data is the boxIdx). packages/sim/src/items.ts owns this operation
      // and is written for exactly this receiving path - see the brief.
      applyItemGrant(ctx, state, ev)
      return true
    }
    case 'hit': {
      if (ev.data === 1) {
        const k = kartById(state, ev.playerId)
        if (k !== null) k.shielded = false
      }
      return true
    }
    case 'spinOut': {
      const k = kartById(state, ev.playerId)
      if (k !== null) {
        k.spinOutTicks = ev.data
        k.drift.active = false
        k.drift.dir = 0
        k.drift.charge = 0
        k.boostTicks = 0
      }
      return true
    }
    case 'respawn': {
      const k = kartById(state, ev.playerId)
      if (k !== null) k.respawnTicks = ev.data
      return true
    }
    case 'lapCross': {
      const k = kartById(state, ev.playerId)
      if (k !== null) {
        k.lap.lap = ev.data
        k.lap.checkpointIdx = 0
      }
      return true
    }
    case 'finish': {
      if (ev.playerId === -1) {
        state.phase = 'finished'
        return true
      }
      const slot = ev.data - 1
      if (slot >= 0 && slot < state.finishedOrder.length) {
        state.finishedOrder[slot] = ev.playerId
      }
      if (state.finishTick < 0) state.finishTick = ev.tick
      return true
    }
    case 'entitySpawn':
    case 'entityDespawn':
      return true
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/net/test/apply.test.ts`

Expected: PASS — 13 tests. (This exact implementation and an equivalent test
file were run against the real, currently-merged `packages/sim` during the
writing of this brief, via temporary files under `packages/sim/test/` importing
`packages/sim/src` by relative path in place of `@tapkart/sim` — 10 tests in
that dry run, split into 12 here after separating two assertions in the
sequencing tests into their own `it` blocks for a clearer failure signal, plus
one more added by the fix pass for the item-box half of an `itemGrant`. Both
`npx vitest run` and `npx tsc --noEmit -p packages/sim/tsconfig.json` were
green on that dry run before it was deleted; no source of this brief is
untested reasoning.)

- [ ] **Step 5: Typecheck and run the full net suite**

Run: `npx tsc --noEmit -p packages/net/tsconfig.json && npx vitest run packages/net`

Expected: PASS, zero type errors, every `net` test green (this task's 13 plus
whatever Tasks 11–12 already shipped).

- [ ] **Step 6: Commit**

```bash
git add packages/net/src/apply.ts packages/net/test/apply.test.ts
git commit -m "feat(net): applyEvent, the follower's half of emit-gating

applyEvent(ctx, state, ev) is what makes a follower's nextEventSeq track
the leader's without ever emitting (contract §1b): it advances
nextEventSeq on every non-stale event and ignores anything at or below
the highest already applied, which is what makes authority migration
safe.

Per-kind mutation is real, not uniform bookkeeping: itemGrant (leader-only
PRNG roll - delegated to sim's own applyItemGrant so the item box's
respawn timer, the half no WireSnapshot field carries, is applied too),
hit/spinOut (caused by an entity the receiver never
simulated - 'the local kart's hit reaction plays on receipt, not on
prediction', spec 5) and finish (WireSnapshot carries no placement data
at all) all carry information a receiver cannot derive by re-simulating
and must be applied from the wire. respawn/lapCross are self-derivable
but applied anyway for defense in depth. entitySpawn/entityDespawn carry
no position - AuthEvent has no Vec3 field - and mutate nothing beyond
sequencing; entity truth is exclusively WireSnapshot's job."
```

---

### Task 14: `AuthorityLoop` — the Host's 60Hz Leader Loop

**Files:**
- Create: `packages/net/src/authority.ts`
- Test: `packages/net/test/authority.test.ts`

**Interfaces:**

- Consumes:
  - `packages/sim/src/types.ts` (via `@tapkart/sim`) — `MAX_KARTS = 8`,
    `COUNTDOWN_TICKS = 180`, `Intent`, `AuthEvent`, `SimContext`, `SimState`.
  - `packages/sim/src/state.ts` (via `@tapkart/sim`) — `createState`,
    `cloneState` (deep-copies every field into an already-shaped `dst`, used to
    keep the caller's `state` object updated in place every tick).
  - `packages/sim/src/replay.ts` [Plan 1, Task 16] (via `@tapkart/sim`) —
    `export function allocStateLike(ctx: SimContext, src: SimState): SimState`
    — a brand-new, fully detached deep copy, used as this task's double-buffer
    scratch state. Verified present and barrel-exported by reading
    `packages/sim/src/replay.ts` and `packages/sim/src/index.ts` directly
    (both are real, merged Plan 1 code, not upcoming work).
  - `packages/sim/src/phase.ts` (via `@tapkart/sim`) — `export function makeIntentBuffer(): Intent[]`
    — a new array of exactly `MAX_KARTS` distinct, zeroed `Intent` objects.
  - `packages/sim/src/step.ts` (via `@tapkart/sim`) — `export function step(ctx, prev, next, inputs, events): void`.
    Verified (by reading `packages/sim/src/step.ts` and Plan 1's
    `task-16-checkpoint-replay.md`, itself verified against real merged code)
    that `step()` never clears `events` itself — every caller in the codebase
    (`recordRun`, `replayRun`) sets `events.length = 0` immediately before
    calling `step()`, and this task does the same.
  - `packages/net/src/transport.ts` [Task 11, locked contract §5] —
    `export interface Transport { send(channel, peerId, data): void; broadcast(channel, data): void; onMessage(cb): void; onPeerLost(cb): void; peers(): string[]; close(): void }`.
  - `packages/protocol/src/types.ts` [Task 3, locked contract §3] —
    `ChannelName = 'unreliable' | 'reliable'`;
    `type MessageKind = 'hello' | 'welcome' | 'lobby' | 'start' | 'input' | 'snapshot' | 'events' | 'checkpoint' | 'authorityChange' | 'ping' | 'pong'`;
    `interface WireHeader { kind: MessageKind; protocolVersion: number }`;
    `const WIRE_TAG` (the frozen tag map, `input: 0x10`, `snapshot: 0x11`,
    `events: 0x12`, `checkpoint: 0x13`, `authorityChange: 0x20`, …);
    `encodeHeader(out: Uint8Array, kind: MessageKind): number` — writes the
    2-byte header (tag + protocol version) at offset 0 and returns **2**;
    `decodeHeader(buf: Uint8Array): WireHeader` — throws on an unknown tag or a
    protocol-version mismatch. **Every datagram this loop sends begins with
    that header, and every datagram it receives is dispatched on
    `decodeHeader(data).kind`.** See "One header, three loops" below.
  - `packages/protocol/src/snapshot.ts` [Task 6, locked contract §3] —
    `export function encodeSnapshot(out: Uint8Array, state: SimState, lastProcessedInputTick: number[]): number`,
    `export function decodeSnapshot(buf: Uint8Array, out: WireSnapshot): void`
    (this task's tests only, to observe what was broadcast).
  - `packages/protocol/src/events.ts` [Task 9, locked contract §3] —
    `export function encodeEvents(out: Uint8Array, events: AuthEvent[]): number`,
    `export function decodeEvents(buf: Uint8Array, out: AuthEvent[]): void`
    (tests only).
  - `packages/protocol/src/input.ts` [Task 10, locked contract §3] —
    `export const INPUT_REDUNDANCY = 8`,
    `export function encodeInput(out: Uint8Array, playerId: number, intents: Intent[]): number`
    (tests only, standing in for a not-yet-written `ClientLoop`),
    `export function decodeInput(buf: Uint8Array, out: InputDatagram): void`.
  - `packages/net/test/fixtures/net-fixtures.ts` [Task 12, locked contract §6] —
    `export function makeNetContext(isLeader?: boolean): SimContext`,
    `export function makeLossyPair(overrides?: Partial<LoopbackOptions>): ReturnType<typeof makeLoopbackPair>`.
    Every test in this brief passes `makeNetContext(true)` and an explicit
    `overrides` object to `makeLossyPair` — never the bare defaults — so this
    task's tests do not depend on an unstated default value in a file that
    does not exist yet.
  - `packages/sim/src/items.ts` (via `@tapkart/sim`) — `export function itemBoxWorldPos(ctx: SimContext, boxIdx: number, out: Vec3): void`,
    used only by this task's tests to force a deterministic `itemGrant` (see
    the verification note below).

- Produces (locked contract §5, verbatim — all four members):
  ```ts
  export class AuthorityLoop {
    constructor(ctx: SimContext, state: SimState, t: Transport)
    tick(): void              // reads client input off its own Transport; takes no input param
    state(): SimState         // read-only view, so the promotion test can compare authorities
  }
  ```
  `state()` is part of the locked signature and is **not** optional: contract §5
  annotates it *"read-only view, so the promotion test can compare authorities."*
  An earlier draft of this brief omitted it, and Task 17 grew a hand-rolled host
  loop and a `corrections()`-is-a-good-enough-proxy argument to work around the
  absence. It returns the very `SimState` object the constructor was handed —
  the same object `tick()` keeps current by `cloneState` — so a caller that
  already holds that object gains nothing, and a caller that does not (Task 17)
  gets the state without one.
- Defines in its own file, because the contract fixes the value but exports no
  constant for it (contract §0's "a task needing something absent must define it
  in its own files and say so"):
  - `const HEADER_BYTES = 2` — the width `encodeHeader` writes and therefore the
    payload offset `decodeHeader`'s caller must skip. Private, not exported:
    `client.ts` (Task 15) and `shadow.ts` (Task 16) each declare the same
    private constant rather than importing one net module into another.

**Verification performed for this brief:** this brief's core algorithm — the
per-player 60Hz input hold with catch-up across a gap, the held-input-tick
bookkeeping, the double-buffer-with-`cloneState`-back pattern that keeps the
caller's `state` object current by mutation, and connected-kart bot takeover —
was written as a small stand-alone class (`FakeAuthority`, no networking, no
protocol codecs) and run against the real, currently-merged `packages/sim`
before this brief was written. Three tests, all passing: a 30Hz intent applied
across the pair and repeated over a gap, a redundant re-delivery correctly
ignored (the held-input cursor advances, never regresses), and a
`connected = false` kart moving under bot AI despite never receiving input.
Separately, the exact tick at which `state.phase` flips from `'countdown'` to
`'racing'` was verified by stepping a real `SimState` from tick 0 to
`COUNTDOWN_TICKS + 2` and logging `state.phase` at every tick near the
boundary: **`state.phase` is already `'racing'` at `state.tick === COUNTDOWN_TICKS (180)`**
— the same step that produces tick 180 both runs `resolveInputs` with the
still-`'countdown'` phase it was cloned from (freezing that tick's input, per
`phase.ts`'s own comment: *"the tick that ends the countdown still ran with
frozen input"*) **and** flips `next.phase` at the end of the same call, because
`updatePhase` runs after the kart loop in the same `step()` invocation. This
brief's Step 1 test asserts that exact fact rather than the more intuitive but
wrong "still countdown at tick 180." Third, the deterministic `itemGrant`
fixture used in Step 6 — a kart with `characterIdx` all zero, `raceSeed = 0`,
parked exactly on item box 0, `phase` set directly to `'racing'` — was run for
5 ticks against real `packages/sim` and produces `itemGrant { tick: 1, playerId: 0, item: 'bolt', data: 0 }`
on the very first tick, exactly once. All four probes were deleted after
verification; none of this brief's confidence is unexamined reasoning about
code that does not exist.

---

**What this task does not attempt.** No lobby, no `'hello'`/`'welcome'`
handshake, no character selection, no `AuthorityCheckpoint` for late join —
`MessageKind` lists those kinds (locked contract §3) but the protocol module
map defines no codec for any of them, which means they are a later plan's
scope, not this one's. Concretely, that leaves one open question this task
must answer on its own: **how does `AuthorityLoop` learn which wire `peerId`
corresponds to which kart-slot `playerId`?** `Transport.onPeerLost(cb)` hands
back only a `peerId` string; nothing in the locked contract specifies what that
string looks like, because `Transport` (Task 11) and `LoopbackTransport`
(Task 12) do not exist yet, and this brief will not guess their format. The
answer used here needs no guess at all: **`InputDatagram` is self-describing**
— `decodeInput`'s output carries `playerId: number` directly (locked contract
§3) — so `AuthorityLoop` learns the mapping `peerId -> playerId` the moment it
receives that peer's first input datagram, and looks it up again when that
peer is later lost. A peer that disconnects before ever sending input (a pure
observer, or a connection that never got past signaling) has no entry, and its
loss is a safe no-op — nothing in `state` needs to change, because no kart was
ever known to belong to it.

**Why every `broadcast()` call is handed a `.slice()`, never a `.subarray()`.**
`Transport.broadcast(channel: ChannelName, data: Uint8Array): void` does not
document who owns `data` after the call returns, because `Transport` is an
interface this task consumes, not one it can inspect. `AuthorityLoop` reuses
one fixed `Uint8Array` per message kind across every tick (so the hot path
never allocates), which means the *next* tick's `encodeSnapshot`/`encodeEvents`
call overwrites those same bytes. If a transport implementation queues `data`
for delayed delivery (as any implementation with latency must) without copying
it first, a reused-and-overwritten buffer would corrupt an in-flight message.
`Uint8Array.prototype.slice(0, n)` copies; `.subarray(0, n)` is a view onto the
same backing `ArrayBuffer` and would not protect against this. This task always
slices before handing bytes to the transport, and never assumes the transport
copies on its own behalf.

**Snapshot cadence, exactly.** 60Hz sim, 20Hz snapshot: `60 / 20 = 3`, an exact
integer with no remainder, so `state.tick % 3 === 0` is broadcast on ticks
`0, 3, 6, ...` with no drift ever accumulating — unlike the 30Hz input rate
(`60 / 30 = 2`, also exact, owned by `ClientLoop`, Task 15). Events are not on
a cadence at all: they are broadcast the same tick they occur, whenever
`events.length > 0` after `step()` — spec §5 makes no claim about batching
events across ticks, and batching them would only add latency to information a
follower needs promptly (an `itemGrant` a client is waiting on to legally use
the item it was just told it holds).

`shadow.ts` (Task 16) exports the same number as `SNAPSHOT_PERIOD_TICKS`
because a promoted shadow broadcasts on the identical cadence. The two are
deliberately *not* shared through an import: Task 16 states, and this brief
agrees, that neither loop's correctness may depend on the other's file. Both
derive the value the same way (`TICK_HZ / 20`), and Task 17's convergence test
cross-checks them — it computes its snapshot-arrival floor from the shadow's
exported constant while counting snapshots the *authority* broadcast, so a
divergence between the two shows up as a failed floor, not as silence.

**One header, three loops.** Every datagram on the wire begins with the shared
2-byte header from `@tapkart/protocol` — `encodeHeader(out, kind)` writes
`[WIRE_TAG[kind], PROTOCOL_VERSION]` and returns 2; `decodeHeader(buf)` reads it
back and throws on an unknown tag or a version mismatch. This loop, `ClientLoop`
(Task 15) and `ShadowLoop` (Task 16) all use it, in both directions, with no
exceptions.

This is not decoration. Spec §5 has every client sending its input to **both**
the host and the server shadow, and the shadow receiving the host's snapshots
and events on the same callback, so at least one receiver in the deployed
topology sees more than one message kind on one channel. Without a shared tag,
`ShadowLoop` would read a snapshot's first payload byte as if it were an input
datagram. An earlier draft of this plan had exactly that: Task 16 invented a
private `WIRE_TAG_INPUT = 4 … WIRE_TAG_AUTHORITY_CHANGE = 8` scheme inside
`net/src/shadow.ts` while Tasks 14 and 15 sent untagged payloads and
blind-decoded every unreliable datagram. Contract §3 settles it, and names the
failure in its own text: *"Without a shared tag a receiver cannot dispatch, and
each of Tasks 11/14/15/16 would invent its own — which is exactly what happened
when this was left unspecified."*

Mechanically, in this file: `encodeHeader` returns the offset the payload starts
at, so a send is always `const h = encodeHeader(buf, kind)` then
`encodeXxx(buf.subarray(h), …)` and a `slice(0, h + n)` to the transport; a
receive is always `decodeHeader(data)`, a branch on `.kind`, then
`decodeXxx(data.subarray(HEADER_BYTES), …)`.

---

- [ ] **Step 1: Write the failing test — bare ticking and the countdown boundary**

Create `packages/net/test/authority.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { Intent } from '@tapkart/sim'
import { COUNTDOWN_TICKS, MAX_ENTITIES, MAX_KARTS, createState } from '@tapkart/sim'
import type { Transport } from '../src/transport'
import type { WireEntity, WireKart, WireSnapshot } from '@tapkart/protocol'
import { decodeHeader, decodeSnapshot, encodeHeader, encodeInput } from '@tapkart/protocol'
import { AuthorityLoop } from '../src/authority'
import { makeLossyPair, makeNetContext } from './fixtures/net-fixtures'

const CHARS = [0, 0, 0, 0, 0, 0, 0, 0]

/** encodeHeader writes tag + protocolVersion; locked contract §3 fixes it at 2. */
const HEADER_BYTES = 2

/** Sends one input datagram the way a real ClientLoop does: shared header, then
 * the payload. Every test below goes through this rather than hand-assembling
 * bytes, so a header change breaks one place, not six. */
function sendInput(t: Transport, playerId: number, intents: Intent[]): void {
  const buf = new Uint8Array(256)
  const h = encodeHeader(buf, 'input')
  const n = encodeInput(buf.subarray(h), playerId, intents)
  t.broadcast('unreliable', buf.slice(0, h + n))
}

/** decodeSnapshot writes into an already-shaped destination, same convention
 * as cloneState — these three build one. */
function makeWireKart(): WireKart {
  return {
    playerId: 0, position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 },
    heading: 0, angularVelocity: 0, driftCharge: 0, driftActive: false, driftDir: 0,
    airborne: false, surface: 'tarmac', spinOutTicks: 0, invulnTicks: 0, item: 'none',
    lap: 0, checkpointIdx: 0, t: 0, isBot: false, connected: false,
    boostTicks: 0, respawnTicks: 0, shielded: false,
  }
}

function makeWireEntity(): WireEntity {
  return {
    entityId: -1, kind: 'seeker', ownerId: -1,
    position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, heading: 0, ttl: 0,
  }
}

function makeWireSnapshot(): WireSnapshot {
  const karts: WireKart[] = []
  for (let i = 0; i < MAX_KARTS; i++) karts.push(makeWireKart())
  const entities: WireEntity[] = []
  for (let i = 0; i < MAX_ENTITIES; i++) entities.push(makeWireEntity())
  return {
    tick: 0, eventSeq: 0,
    lastProcessedInputTick: new Array(MAX_KARTS).fill(-1),
    karts, entities, entityCount: 0,
  }
}

describe('AuthorityLoop — bare ticking', () => {
  it('mutates the exact state object the constructor received, tick by tick', () => {
    const ctx = makeNetContext(true)
    const state = createState(ctx, 0, CHARS)
    state.karts[0].isBot = false
    state.karts[0].connected = true
    const pair = makeLossyPair({ latencyMs: 1, jitterMs: 0, lossRate: 0, seed: 1 })
    const authority = new AuthorityLoop(ctx, state, pair.a)

    expect(state.tick).toBe(0)
    authority.tick()
    expect(state.tick).toBe(1)
    authority.tick()
    expect(state.tick).toBe(2)
  })

  it('state() returns the same live SimState the constructor was handed, on every tick', () => {
    const ctx = makeNetContext(true)
    const state = createState(ctx, 0, CHARS)
    state.phase = 'racing'
    state.karts[0].isBot = false
    state.karts[0].connected = true
    const pair = makeLossyPair({ latencyMs: 1, jitterMs: 0, lossRate: 0, seed: 1 })
    const authority = new AuthorityLoop(ctx, state, pair.a)

    // Identity, not a copy: contract §5 calls state() a "read-only view".
    expect(authority.state()).toBe(state)
    // And it stays current across many ticks — the accessor must not hand back
    // a stale snapshot taken at construction (the failure mode a getter that
    // captured `{...state}` would have).
    for (let i = 1; i <= 30; i++) {
      authority.tick()
      expect(authority.state().tick).toBe(i)
    }
    expect(authority.state().karts[0].position.x).toBe(state.karts[0].position.x)
  })

  it('transitions countdown to racing on the tick that reaches COUNTDOWN_TICKS, not after it', () => {
    const ctx = makeNetContext(true)
    const state = createState(ctx, 0, CHARS)
    state.karts[0].isBot = false
    state.karts[0].connected = true
    const pair = makeLossyPair({ latencyMs: 1, jitterMs: 0, lossRate: 0, seed: 1 })
    const authority = new AuthorityLoop(ctx, state, pair.a)

    expect(state.phase).toBe('countdown')
    for (let i = 0; i < COUNTDOWN_TICKS - 1; i++) authority.tick()
    expect(state.tick).toBe(COUNTDOWN_TICKS - 1)
    expect(state.phase).toBe('countdown')

    authority.tick()
    expect(state.tick).toBe(COUNTDOWN_TICKS)
    expect(state.phase).toBe('racing')   // flips within the same step that produces tick 180
  })
})

describe('AuthorityLoop — the 30Hz-into-60Hz input hold', () => {
  it('holds the newest known intent, applies it across the pair, repeats it over a gap, and advances lastProcessedInputTick as later datagrams arrive', () => {
    const ctx = makeNetContext(true)
    const state = createState(ctx, 0, CHARS)
    state.phase = 'racing'
    state.karts[3].isBot = false
    state.karts[3].connected = true
    const pair = makeLossyPair({ latencyMs: 1, jitterMs: 0, lossRate: 0, seed: 1 })
    const authority = new AuthorityLoop(ctx, state, pair.a)

    let latest: WireSnapshot | null = null
    let taggedSnapshots = 0
    pair.b.onMessage((_peerId, channel, data) => {
      if (channel !== 'unreliable') return
      // Dispatch on the shared header, never on a bare first byte: this side of
      // the pair carries snapshots now and would carry other kinds in the
      // deployed topology. decodeHeader throws on an unknown tag, so a loop
      // that forgot to write the header fails here loudly rather than decoding
      // a snapshot's tick field as if it were a message kind.
      if (decodeHeader(data).kind !== 'snapshot') return
      taggedSnapshots++
      const snap = makeWireSnapshot()
      decodeSnapshot(data.subarray(HEADER_BYTES), snap)
      if (latest === null || snap.tick > latest.tick) latest = snap
    })

    let nowMs = 0
    const frame = (): void => {
      authority.tick()
      pair.pump(nowMs)
      nowMs += 1000 / 60
    }

    const mkIntents = (startTick: number): Intent[] =>
      Array.from({ length: 8 }, (_, i) => ({
        tick: startTick + i * 2, steer: 0.5, accel: 1, brake: false, drift: false, useItem: false,
      }))

    sendInput(pair.b, 3, mkIntents(0))   // ticks 0,2,...,14
    for (let i = 0; i < 20; i++) frame()

    expect(latest).not.toBeNull()
    expect(taggedSnapshots).toBeGreaterThan(0)   // the snapshots really carried the shared header
    expect(latest!.lastProcessedInputTick[3]).toBe(14)
    const xAfterFirst = state.karts[3].position.x
    expect(xAfterFirst).not.toBe(0)   // the held intent was actually applied to physics

    sendInput(pair.b, 3, mkIntents(16))  // ticks 16,18,...,30
    for (let i = 0; i < 20; i++) frame()

    expect(latest!.lastProcessedInputTick[3]).toBe(30)
    expect(state.karts[3].position.x).toBeGreaterThan(xAfterFirst)   // kept moving, still forward
  })

  it('ignores an unreliable datagram that is not an input message', () => {
    const ctx = makeNetContext(true)
    const state = createState(ctx, 0, CHARS)
    state.phase = 'racing'
    state.karts[3].isBot = false
    state.karts[3].connected = true
    const pair = makeLossyPair({ latencyMs: 1, jitterMs: 0, lossRate: 0, seed: 1 })
    const authority = new AuthorityLoop(ctx, state, pair.a)

    // A second authority's snapshot on the same channel — exactly what a
    // promoted ShadowLoop broadcasts at a host that has not noticed yet. The
    // host must skip it, not decode it as input. Without header dispatch this
    // reaches decodeInput, which either throws or writes garbage into
    // heldIntent[?] and starts driving somebody's kart.
    const startX = state.karts[3].position.x
    const startZ = state.karts[3].position.z
    const buf = new Uint8Array(1024)
    const h = encodeHeader(buf, 'snapshot')
    pair.b.broadcast('unreliable', buf.slice(0, h + 32))

    let nowMs = 0
    for (let i = 0; i < 10; i++) {
      authority.tick()
      pair.pump(nowMs)
      nowMs += 1000 / 60
    }
    // Kart 3 is connected and not a bot, so with no accepted input it holds a
    // neutral intent (accel 0) and does not move. Any byte of that snapshot
    // mistaken for an intent shows up here as motion.
    expect(state.tick).toBe(10)
    expect(authority.state().karts[3].position.x).toBe(startX)
    expect(authority.state().karts[3].position.z).toBe(startZ)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/net/test/authority.test.ts`

Expected: FAIL. `packages/net/src/authority.ts` does not exist yet:

```
Error: Cannot find module '../src/authority' imported from
'<repo>/packages/net/test/authority.test.ts'
Caused by: Error: Failed to load url ../src/authority (resolved id:
../src/authority) in .../authority.test.ts. Does the file exist?

 Test Files  1 failed (1)
      Tests  no tests
```

(Message format verified directly against this repo's installed Vitest 3.2.7 —
see Task 13's brief for the probe. If Tasks 11/12 have not landed yet, the
failure will instead name whichever of `../src/transport`,
`./fixtures/net-fixtures`, or `@tapkart/protocol` is missing first.)

- [ ] **Step 3: Write the minimal implementation**

Create `packages/net/src/authority.ts`:

```ts
import type { AuthEvent, Intent, SimContext, SimState } from '@tapkart/sim'
import { MAX_KARTS, allocStateLike, cloneState, makeIntentBuffer, step } from '@tapkart/sim'
import type { ChannelName, InputDatagram } from '@tapkart/protocol'
import { INPUT_REDUNDANCY, decodeHeader, decodeInput, encodeEvents, encodeHeader, encodeSnapshot } from '@tapkart/protocol'
import type { Transport } from './transport'

/** 60Hz sim / 20Hz snapshot broadcast. Spec section 5. Exact: 60 / 20 = 3.
 * shadow.ts exports the same number for the same reason; the two are
 * deliberately not shared through an import - see this task's brief. */
const SNAPSHOT_PERIOD_TICKS = 3

/** encodeHeader writes tag + protocolVersion and returns 2 (locked contract
 * §3). Declared here because protocol exports the writer, not the width, and
 * every receive path needs the payload offset. */
const HEADER_BYTES = 2

/**
 * Generous fixed allocations, not protocol-mandated sizes: encodeSnapshot and
 * encodeEvents take a caller-owned buffer and return bytes written, so any
 * buffer at least as large as the worst case is correct.
 *
 * Worst-case snapshot, recomputed from locked contract §4's bit counts rather
 * than from a rounded byte figure: 8 karts x 178 bits = 1424, plus 32 entities
 * x 135 bits = 4320, plus a 200-bit header = 5944 bits = 743 B exactly. With
 * this file's 2-byte message header that is 745 B on the wire; 1024 leaves
 * headroom and costs nothing. (An earlier draft cited "~625B", a figure from a
 * superseded 177-bit kart record with a packed entity velocity.)
 *
 * BitWriter neither throws nor grows on overflow - a typed-array write past the
 * end is a silent no-op - so an undersized buffer here truncates a snapshot
 * without any error at all, which is why this number is derived rather than
 * guessed. Events carry no stated per-tick cap; 2048B comfortably covers dozens.
 */
const SNAPSHOT_BUF_BYTES = 1024
const EVENTS_BUF_BYTES = 2048

/** A fresh array of exactly `n` distinct, zeroed Intent objects. */
function makeIntents(n: number): Intent[] {
  const out: Intent[] = []
  for (let i = 0; i < n; i++) {
    out.push({ tick: 0, steer: 0, accel: 0, brake: false, drift: false, useItem: false })
  }
  return out
}

/**
 * The host's 60Hz leader loop. Steps the sim, broadcasts a WireSnapshot at
 * 20Hz, broadcasts events on the reliable channel the tick they occur, and
 * holds each connected player's newest known intent across the 30Hz-into-60Hz
 * mismatch (spec section 5): "the authority holds the newest intent and
 * applies it to both ticks of the pair, repeating the last known intent
 * across gaps."
 *
 * peerId -> playerId is learned from traffic, not assumed: InputDatagram
 * carries playerId directly (locked contract §3), so the first input datagram
 * from a peer teaches this loop who that peer is, and onPeerLost looks the
 * mapping back up. A peer lost before ever sending input is a no-op — no kart
 * was ever known to be it.
 */
export class AuthorityLoop {
  private readonly ctx: SimContext
  private readonly live: SimState
  private readonly scratch: SimState
  private readonly transport: Transport

  private readonly heldIntent: Intent[] = makeIntentBuffer()
  /** Newest input tick RECEIVED per player - a receipt-side cursor. */
  private readonly heldIntentTick: number[] = new Array(MAX_KARTS).fill(-1)
  /** Newest input tick actually FOLDED INTO the simulation per player, which is
   * what spec §5 defines lastProcessedInputTick to mean ("the newest input from
   * that player the authority had folded in") and what every WireSnapshot
   * carries. Written in tick(), never in onMessage: a datagram that arrived but
   * has not yet been stepped is held, not processed.
   *
   * It is an input-buffer CURSOR and nothing else. Reconciliation compares at
   * `snap.tick` (spec §5, amended 2026-08-14, after a Plan 2 author prototyped
   * the literal "compare at lastProcessedInputTick" reading and measured
   * hundreds of spurious corrections in the test that must see zero). A
   * snapshot's `tick` and a player's `lastProcessedInputTick` describe
   * different instants; this loop publishes the second and never compares
   * against it. */
  private readonly lastProcessedInputTick: number[] = new Array(MAX_KARTS).fill(-1)
  private readonly stepInputs: Intent[] = makeIntentBuffer()
  private readonly events: AuthEvent[] = []
  private readonly inputDatagram: InputDatagram = { playerId: -1, intents: makeIntents(INPUT_REDUNDANCY) }
  private readonly snapshotBuf = new Uint8Array(SNAPSHOT_BUF_BYTES)
  private readonly eventsBuf = new Uint8Array(EVENTS_BUF_BYTES)
  private readonly peerIdToPlayerId = new Map<string, number>()

  constructor(ctx: SimContext, state: SimState, t: Transport) {
    // Defensive: a caller-supplied ctx with isLeader false would silently stop
    // item rolls and event emission. The host is always the leader.
    this.ctx = { ...ctx, isLeader: true }
    this.live = state
    this.scratch = allocStateLike(this.ctx, state)
    this.transport = t
    t.onMessage((peerId, channel, data) => this.onMessage(peerId, channel, data))
    t.onPeerLost((peerId) => this.onPeerLost(peerId))
  }

  /** The caller's own SimState, kept current by tick(). Contract §5: a
   * read-only view, so a test can compare two authorities without owning
   * either one's constructor argument. Never a copy - a copy would go stale. */
  state(): SimState {
    return this.live
  }

  private onMessage(peerId: string, channel: ChannelName, data: Uint8Array): void {
    // Every datagram carries the shared 2-byte header (contract §3), so this
    // dispatches on kind rather than assuming everything unreliable is input:
    // in the deployed topology a promoted ShadowLoop broadcasts snapshots on
    // this very channel. decodeHeader throws on an unknown tag or a version
    // mismatch, which is the intended behaviour - a peer speaking a different
    // protocol version must not be half-understood.
    const header = decodeHeader(data)
    if (header.kind !== 'input') return
    // Reliable-channel traffic FROM a peer (lobby state, checkpoint requests)
    // is a later plan's scope: this plan's protocol module map defines no
    // codec for it (locked contract §3's MessageKind lists the kinds, but
    // Tasks 3-10 export no encode/decode pair for any of them).
    if (channel !== 'unreliable') return

    decodeInput(data.subarray(HEADER_BYTES), this.inputDatagram)
    const playerId = this.inputDatagram.playerId
    if (playerId < 0 || playerId >= MAX_KARTS) return
    this.peerIdToPlayerId.set(peerId, playerId)

    const intents = this.inputDatagram.intents
    for (let i = 0; i < intents.length; i++) {
      const it = intents[i]
      if (it.tick > this.heldIntentTick[playerId]) {
        const h = this.heldIntent[playerId]
        h.tick = it.tick
        h.steer = it.steer
        h.accel = it.accel
        h.brake = it.brake
        h.drift = it.drift
        h.useItem = it.useItem
        this.heldIntentTick[playerId] = it.tick
      }
    }
  }

  private onPeerLost(peerId: string): void {
    const playerId = this.peerIdToPlayerId.get(peerId)
    if (playerId === undefined) return
    // Spec section 5: "A client that drops has its kart taken over by a bot."
    // resolveInputs (packages/sim/src/phase.ts) routes any kart with
    // !connected through bot AI regardless of `isBot`'s own value, so this one
    // field flip is the entire mechanism.
    this.live.karts[playerId].connected = false
  }

  tick(): void {
    for (let i = 0; i < MAX_KARTS; i++) {
      const h = this.heldIntent[i]
      const dst = this.stepInputs[i]
      dst.tick = this.live.tick + 1
      dst.steer = h.steer
      dst.accel = h.accel
      dst.brake = h.brake
      dst.drift = h.drift
      dst.useItem = h.useItem
      // Folded in as of this step(), which is exactly what the field means.
      this.lastProcessedInputTick[i] = this.heldIntentTick[i]
    }

    this.events.length = 0
    step(this.ctx, this.live, this.scratch, this.stepInputs, this.events)
    cloneState(this.scratch, this.live)

    if (this.events.length > 0) {
      const h = encodeHeader(this.eventsBuf, 'events')
      const n = encodeEvents(this.eventsBuf.subarray(h), this.events)
      this.transport.broadcast('reliable', this.eventsBuf.slice(0, h + n))
    }

    if (this.live.tick % SNAPSHOT_PERIOD_TICKS === 0) {
      const h = encodeHeader(this.snapshotBuf, 'snapshot')
      const n = encodeSnapshot(this.snapshotBuf.subarray(h), this.live, this.lastProcessedInputTick)
      this.transport.broadcast('unreliable', this.snapshotBuf.slice(0, h + n))
    }
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/net/test/authority.test.ts`

Expected: PASS — 5 tests. (The input-hold algorithm and the countdown-boundary
fact were both verified against real `packages/sim` before this brief was
written — see the verification note above — so this is expected to pass on
the first implementation, not require iteration.)

- [ ] **Step 5: Write the failing test — event broadcast on occurrence, and bot takeover on peer loss**

Append to `packages/net/test/authority.test.ts`. Add these import lines at the
top, next to the existing ones (`Transport` is already imported by Step 1's
`sendInput` helper, so it is not repeated here):

```ts
import type { AuthEvent } from '@tapkart/sim'
import { itemBoxWorldPos } from '@tapkart/sim'
import type { ChannelName } from '@tapkart/protocol'
import { decodeEvents } from '@tapkart/protocol'
```

Then append:

```ts
describe('AuthorityLoop — event broadcast', () => {
  it('broadcasts an event on the reliable channel the tick it occurs', () => {
    const ctx = makeNetContext(true)
    const state = createState(ctx, 0, CHARS)
    state.phase = 'racing'   // skip the countdown so the pickup happens tick 1
    state.karts[0].isBot = false
    state.karts[0].connected = true

    // Park kart 0 exactly on item box 0. Verified deterministic against real
    // packages/sim (see this brief's verification note): with raceSeed 0,
    // characterIdx all 0, this produces an itemGrant of item 'bolt' on tick 1.
    const box = { x: 0, y: 0, z: 0 }
    itemBoxWorldPos(ctx, 0, box)
    state.karts[0].position.x = box.x
    state.karts[0].position.z = box.z
    const proj = ctx.query.project(box)
    state.karts[0].position.y = ctx.query.groundHeight(proj.s, proj.lateral)

    const pair = makeLossyPair({ latencyMs: 1, jitterMs: 0, lossRate: 0, seed: 1 })
    const authority = new AuthorityLoop(ctx, state, pair.a)

    const received: AuthEvent[] = []
    pair.b.onMessage((_peerId: string, channel: ChannelName, data: Uint8Array) => {
      if (channel !== 'reliable') return
      expect(decodeHeader(data).kind).toBe('events')
      const out: AuthEvent[] = []
      decodeEvents(data.subarray(HEADER_BYTES), out)
      received.push(...out)
    })

    let nowMs = 0
    for (let i = 0; i < 5; i++) {
      authority.tick()
      pair.pump(nowMs)
      nowMs += 1000 / 60
    }

    const grant = received.find((e) => e.kind === 'itemGrant' && e.playerId === 0)
    expect(grant).toBeDefined()
    expect(grant!.item).toBe('bolt')
    expect(grant!.tick).toBe(1)
    expect(grant!.data).toBe(0)   // box index 0
    expect(state.karts[0].item).toBe('bolt')
  })
})

/**
 * A hand-rolled, minimal Transport for exactly one behaviour: simulating a
 * peer's loss deterministically. LoopbackTransport (Task 12) has no
 * documented way to simulate a disconnect on demand — makeLoopbackPair's
 * contract is only `{ a, b, pump }` — so this task does not guess at one.
 * Everything this test needs is already in the locked Transport interface.
 */
class FakeTransport implements Transport {
  private messageCb: ((peerId: string, channel: ChannelName, data: Uint8Array) => void) | null = null
  private peerLostCb: ((peerId: string) => void) | null = null

  send(): void {}
  broadcast(): void {}
  onMessage(cb: (peerId: string, channel: ChannelName, data: Uint8Array) => void): void {
    this.messageCb = cb
  }
  onPeerLost(cb: (peerId: string) => void): void {
    this.peerLostCb = cb
  }
  peers(): string[] {
    return []
  }
  close(): void {}

  // Test-only, not part of Transport.
  deliver(peerId: string, channel: ChannelName, data: Uint8Array): void {
    this.messageCb?.(peerId, channel, data)
  }
  dropPeer(peerId: string): void {
    this.peerLostCb?.(peerId)
  }
}

describe('AuthorityLoop — bot takeover on peer loss', () => {
  it('a peer lost after sending input has its kart marked disconnected and driven by bot AI', () => {
    const ctx = makeNetContext(true)
    const state = createState(ctx, 0, CHARS)
    state.phase = 'racing'
    state.karts[5].isBot = false
    state.karts[5].connected = true
    const t = new FakeTransport()
    const authority = new AuthorityLoop(ctx, state, t)

    const intents: Intent[] = Array.from({ length: 8 }, (_, i) => ({
      tick: i * 2, steer: 0.3, accel: 1, brake: false, drift: false, useItem: false,
    }))
    // Same shared header as sendInput(), delivered straight into the callback.
    const buf = new Uint8Array(256)
    const h = encodeHeader(buf, 'input')
    const n = encodeInput(buf.subarray(h), 5, intents)
    t.deliver('remote-peer-42', 'unreliable', buf.slice(0, h + n))

    expect(state.karts[5].connected).toBe(true)
    t.dropPeer('remote-peer-42')
    expect(state.karts[5].connected).toBe(false)

    const xBefore = state.karts[5].position.x
    for (let i = 0; i < 120; i++) authority.tick()
    expect(state.karts[5].position.x).not.toBe(xBefore)   // bot AI drove it: no input was ever sent again
  })

  it('dropping a peer that never sent input is a safe no-op', () => {
    const ctx = makeNetContext(true)
    const state = createState(ctx, 0, CHARS)
    const t = new FakeTransport()
    new AuthorityLoop(ctx, state, t)

    const before = JSON.stringify(state.karts)
    expect(() => t.dropPeer('never-seen')).not.toThrow()
    expect(JSON.stringify(state.karts)).toBe(before)
  })
})
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `npx vitest run packages/net/test/authority.test.ts`

Expected: FAIL, 3 new failures (the three tests Step 5 appended). The two new `describe` blocks reference
`AuthorityLoop`, which already exists and already exports correctly (Step 3
landed it), so this is **not** the "Cannot find module" shape — every
assertion in the three new tests should already pass against Step 3's
implementation, since bot takeover and event broadcast were both built into
`tick()`/`onPeerLost()` from the start. **If this step is actually green, skip
to Step 8** — that means Step 3's implementation already covers this
behaviour and there is nothing left to fix. Do not force a red step that
isn't there; the instruction to "run and see it fail" exists to catch a real
gap, not to manufacture one. (This differs from Task 13's and this task's own
Step 1/2, where the RED was structural — a missing file. Here, if Step 3's
`tick()`/`onPeerLost()` are correct, Step 5's new tests exercise code that
already exists and already does the right thing.)

- [ ] **Step 7: Run the test to verify it passes**

Run: `npx vitest run packages/net/test/authority.test.ts`

Expected: PASS — 8 tests total.

- [ ] **Step 8: Typecheck and run the full net suite**

Run: `npx tsc --noEmit -p packages/net/tsconfig.json && npx vitest run packages/net`

Expected: PASS, zero type errors, every `net` test green (this task's 8 plus
Tasks 11–13's).

- [ ] **Step 9: Commit**

```bash
git add packages/net/src/authority.ts packages/net/test/authority.test.ts
git commit -m "feat(net): AuthorityLoop, the host's 60Hz leader loop

Steps the sim every tick, broadcasts a WireSnapshot at exactly 20Hz
(60/20 = 3 ticks, no drift), and broadcasts events on the reliable
channel the tick they occur. Holds each player's newest known intent
across the 30Hz input / 60Hz sim mismatch and repeats it across a gap,
per spec section 5 - verified against real packages/sim before writing
this task's implementation.

peerId -> playerId is learned from InputDatagram.playerId on first
receipt, not assumed from any peerId string format, because Transport
and LoopbackTransport (Tasks 11-12) don't exist yet and this task
doesn't guess at their conventions. A dropped peer's kart is marked
disconnected, which resolveInputs already routes to bot AI - the entire
takeover mechanism is that one field.

Every datagram carries protocol's shared 2-byte header (WIRE_TAG +
version): sends go through encodeHeader, receives dispatch on
decodeHeader(data).kind. Without it a promoted ShadowLoop's snapshot,
broadcast on the same unreliable channel, would be decoded here as an
input datagram. state() exposes the caller's own SimState so a test can
compare two authorities, and lastProcessedInputTick now means what spec
5 says it means - folded in, not merely received."
```

---

**Flagged for the plan's author, not resolved here:**

1. **`lastProcessedInputTick`'s `-1` sentinel has no wire representation.**
   Contract §4's header layout gives the field as `8 × u16`, unsigned, while
   this loop (correctly) starts every seat at `-1` for "no input yet from this
   player." Task 6 owns the encoding; as its brief stands, `writeBits(-1, 16)`
   round-trips as `65535`, not `-1`. Nothing in Plan 2 reads the field back —
   reconciliation compares at `snap.tick`, never here (contract §0, spec §5) —
   so this is latent rather than live, but Task 9 biases `playerId` and
   `entityId` by `+1` for exactly this reason and this row should match. This
   task does not paper over it by starting the array at `0`: `0` is a real
   tick, and a receiver that could not tell "tick 0" from "never" would be
   worse off than one that gets an obviously-wrong `65535`.

---

### Task 15: `ClientLoop` — Prediction and Reconciliation

**Files:**
- Create: `packages/net/src/client.ts`
- Test: `packages/net/test/client.test.ts`

**Interfaces:**

- Consumes:
  - `packages/sim/src/types.ts` (via `@tapkart/sim`) — `MAX_KARTS = 8`, `MAX_ENTITIES = 32`,
    `TICK_HZ = 60`, `Intent`, `AuthEvent`, `KartState`, `SimContext`, `SimState`, `Vec3`.
    `TICK_HZ` is added in this brief's residual-findings pass, to timestamp
    `RemoteInterpolator` keyframes without a `Date.now()` call anywhere in this file
    (contract §0: "ticks only").
  - `packages/sim/src/state.ts` (via `@tapkart/sim`) — `createState`, `cloneState`.
  - `packages/sim/src/replay.ts` [Plan 1, Task 16] (via `@tapkart/sim`) — `allocStateLike`.
    Verified present and barrel-exported by reading `packages/sim/src/replay.ts` and
    `packages/sim/src/index.ts` directly (real, merged Plan 1 code).
  - `packages/sim/src/phase.ts` (via `@tapkart/sim`) — `makeIntentBuffer`.
  - `packages/sim/src/step.ts` (via `@tapkart/sim`) — `step`.
  - `packages/sim/src/mathutil.ts` (via `@tapkart/sim`) — `export function wrapAngle(h: number): number`,
    wraps to `(-π, π]`. Used both for the heading epsilon's shortest-signed-angle
    compare and for interpolating a remote kart's heading across the wrap boundary.
  - `packages/net/src/transport.ts` [Task 11, locked contract §5] — `Transport`.
  - `packages/net/src/apply.ts` [Task 13, this plan, same author] —
    `export function applyEvent(ctx: SimContext, state: SimState, ev: AuthEvent): boolean`.
    This task is downstream of Task 13 and consumes it verbatim; Task 13's own
    brief documents its per-kind behavior in full.
  - `packages/protocol/src/types.ts` [Task 3] — `ChannelName`, `MessageKind`,
    `WireHeader`, and the shared message header:
    `encodeHeader(out: Uint8Array, kind: MessageKind): number` (writes 2 bytes —
    tag + protocol version — and returns 2) and
    `decodeHeader(buf: Uint8Array): WireHeader` (throws on an unknown tag or a
    version mismatch). Every datagram this loop sends starts with that header
    and every datagram it receives is dispatched on `decodeHeader(data).kind`.
    This is not optional and not this task's invention: contract §3 assigns the
    header to Task 3 precisely so `AuthorityLoop`, `ClientLoop` and `ShadowLoop`
    can read each other, and spec §5 has every client sending its input to
    **both** the host and the shadow, so at least one receiver in the deployed
    topology sees more than one kind on one channel.
  - `packages/protocol/src/quant.ts` [Task 5] — `export const EPS: EpsilonTable`,
    and `quantStep(min, max, bits)` (tests only). `EpsilonTable`'s field names are
    **pinned by contract §3/§4**, not assumed by this task: exactly six keys, one
    per continuous row — `position`, `velocity`, `heading`, `angularVelocity`,
    `driftCharge`, `t`. Contract §4 states it outright: *"The key is `t`, not
    `lap.t`, matching the flat `WireKart` interface in §3."* An earlier draft of
    this brief used `EPS.lapT` and called the name an open assumption; it is not
    one, and `EPS.lapT` would be `undefined`, which makes every `> undefined`
    comparison `false` and silently disables the `t` check.
  - `packages/protocol/src/snapshot.ts` [Task 6] — `WireKart`, `WireEntity`, `WireSnapshot`,
    `decodeSnapshot`.
  - `packages/protocol/src/events.ts` [Task 9] — `decodeEvents`.
  - `packages/protocol/src/input.ts` [Task 10] — `INPUT_REDUNDANCY = 8`, `encodeInput`.
  - `packages/net/test/fixtures/net-fixtures.ts` [Task 12, locked contract §6] —
    `makeNetContext(isLeader?)`, `makeLossyPair(overrides?)`. Every test in this
    brief passes explicit arguments to both, per the same reasoning as Tasks 13–14.
  - `packages/net/src/authority.ts` [Task 14, this plan, same author] — `AuthorityLoop`,
    used only by this task's flagship integration test (Step 12).
  - `packages/sim/src/items.ts` (via `@tapkart/sim`) — `itemBoxWorldPos`, test-only.

- Produces:
  - The locked contract §5 class, verbatim — **all four members**:
    ```ts
    export class ClientLoop {
      constructor(ctx: SimContext, playerId: number, t: Transport)
      tick(localIntent: Intent): void
      corrections(): number     // count, for the zero-corrections test
      state(): SimState         // read-only view; the convergence test asserts on it directly
    }
    ```
    `state()` returns the live `predicted` state — the object `tick()` advances,
    not a copy. An earlier draft of this brief listed a three-member shape and
    called *that* "locked contract §5, verbatim"; it was not. The omission cost
    real coverage downstream: two tests in this file and one in Task 17 asserted
    `not.toThrow()` or a corrections counter because they had no way to look at
    the state they were actually testing. Those tests are rewritten below to use
    `state()`.
  - `const HEADER_BYTES = 2`, private to this file — the width `encodeHeader`
    writes, and therefore the payload offset every receive path must skip.
    Contract §3 fixes the value but exports no constant for it, and §0 allows a
    task to define what it needs in its own files. `authority.ts` and `shadow.ts`
    each declare the same private constant rather than importing one `net`
    module into another.
  - Additional exports, this task's own, not in the locked contract (permitted:
    "a task needing something absent must define it in its own files and say so"):
    `export const REMOTE_INTERP_DELAY_MS = 100`, `export const REMOTE_BUFFER_CAPACITY = 8`,
    `export const REMOTE_EXTRAPOLATE_CAP_MS = 200`, `export interface RemoteKeyframe`,
    `export interface RemoteSample`, `export class RemoteInterpolator`, and — added in
    this brief's residual-findings pass —
    `export function remoteInterpolatorOf(client: ClientLoop): RemoteInterpolator`.
    These exist because spec §5 requires remote-kart/entity
    interpolation-with-extrapolation-cap to exist, be fed from the live wire, and be
    tested (this brief's "non-negotiables"), but nothing in `ClientLoop`'s locked
    four-member shape can surface rendering data. `state()` does not close this: it
    exposes the *predicted* `SimState`, whose remote seats are locally-simulated bot
    trajectories that spec §5 says must never be trusted or rendered — the
    interpolated, 100 ms-delayed positions a renderer actually needs are a different
    quantity with no accessor on the locked class.

    `remoteInterpolatorOf` is a **free function, not a class method**: contract §5
    fixes `ClientLoop` at exactly four members and §0 forbids any task adding a
    field to a locked signature, so a fifth public method is not available regardless
    of how useful it would be. A private, module-scope `WeakMap<ClientLoop,
    RemoteInterpolator>` lets a same-module free function reach a per-instance value
    without touching the class's own public surface at all — the same "define what
    you need in your own files" allowance already used for `RemoteInterpolator`
    itself, applied one level further out.

    `ClientLoop`'s own `onMessage` now pushes every newly-accepted snapshot's karts
    into its `RemoteInterpolator` (Steps 12–15 below) — this is the half of "wired to
    nothing" that belongs to Plan 2, because it is purely a data-availability
    question inside a package this plan already owns, with no dependency on anything
    that doesn't exist yet. Wiring the *output* to an actual renderer remains a later
    plan's job (`render`/`game`, which does not exist in this repo): that is a
    presentation concern needing a scene graph and a frame clock this plan has
    neither of, not a data-plumbing one. Before this pass, `RemoteInterpolator`
    shipped standalone — implemented and tested in isolation, fed by nothing —
    which is the gap Task 15's audit named as spec §5 "PARTIAL."

---

**Verification performed for this brief — and what it changed.** Given the
plan's own warning that Plan 1 shipped a bug because a brief's behavioral claim
about code it didn't own was never checked, and given this is explicitly "the
subtlest task in the plan," this task's design was not written from reading the
spec once. A working `AuthorityLoop` + `ClientLoop` + `RemoteInterpolator`, a
functional (JSON-based, not bit-packed — bit-packing is Tasks 4–10's job, not
this brief's to re-verify) stand-in for `@tapkart/protocol` that applies the
real quantization steps from locked contract §4, and a small loopback transport
with real latency/jitter/loss, were written and run against the real, merged
`packages/sim`, end to end, before this brief was finalized. That exercise
**found and fixed three real bugs** that a spec-only reading would have shipped:

1. **The reconciliation anchor tick is `snap.tick`, not `lastProcessedInputTick[playerId]`.**
   Spec §5 literally says "dequantizes the authoritative state for its own kart
   at `lastProcessedInputTick` and compares." Read literally, and implemented
   that way, **the zero-corrections test failed by a wide, non-quantization
   margin** (up to hundreds of spurious corrections in 600 ticks, velocity
   errors of 0.4–1.5 m/s — far past `EPS.velocity`'s 0.05). The reason: a
   `WireSnapshot` has exactly one `tick` field for the whole message, because
   it is one coherent `SimState` at one simulation instant — every kart's
   fields in it, including the local player's, describe the world at
   `snap.tick`. `lastProcessedInputTick[i]` is a *different* number: the
   highest tick of *real* (non-held) input the authority had for player `i` as
   of that instant, which under real network latency lags `snap.tick` by
   roughly one one-way trip. Comparing the client's own checkpoint *at
   `lastProcessedInputTick`* against wire data that actually describes *a
   later instant, `snap.tick`, reached using held/repeated input for the ticks
   in between* compares two different moments of a kart under continuous
   accel/steer — they disagree by construction, growing with every correction
   because each one re-bases the client onto data that was never truly "at"
   the tick it was compared against. Comparing at `snap.tick` instead —
   the client's own checkpoint at the exact tick the wire data was computed
   for — is physically well-founded without needing any clock-offset or RTT
   handshake (no `'ping'`/`'pong'` codec exists in this plan's protocol module
   map, confirming that machinery is out of scope here): under a **held-steady**
   local input, "the value the authority is still holding from N ticks ago" and
   "the value the client is sending right now" are the *same value*, so the gap
   contributes zero physics error regardless of its size, leaving only
   quantization noise — exactly the invariant locked contract §4 needs
   Section 8's test to prove. Verified clean (zero corrections in the
   measured window) across 15 different `LoopbackOptions.seed` values,
   including the contract's own default `0xC0FFEE`. `lastProcessedInputTick`
   is still decoded and available on `WireSnapshot`, unused by this task —
   it is exactly the kind of thing a later task (e.g. connection-quality
   telemetry, or the shadow's promotion bookkeeping) might read.

2. **The client's decode target must double-buffer, or a stale out-of-order
   snapshot corrupts an already-pending fresher one.** `decodeSnapshot`
   overwrites its `out` argument's fields in place. Decoding into the *same*
   `WireSnapshot` object that a not-yet-consumed `pendingSnapshot` still
   points at means a later-arriving-but-earlier-tick message (real under
   50ms jitter on top of 150ms latency) silently rewrites the pending
   snapshot with stale data *before `tick()` ever reads it*, with no error —
   this alone produced dozens of spurious corrections in testing. The fix:
   two pre-allocated `WireSnapshot` scratch buffers, ping-ponged — decode
   always targets whichever one is *not* currently referenced by
   `pendingSnapshot`, so a discarded stale decode can never clobber a
   pending fresher one.

3. **`tsconfig.base.json`'s `noUnusedParameters` rejects an unused parameter
   even when later parameters in the same callback are used** (confirmed
   directly against this repo's TypeScript 5.9.3, same finding as Task 13's
   brief) — `t.onMessage((peerId, channel, data) => this.onMessage(channel, data))`
   fails `TS6133` on `peerId` even though `channel`/`data` are both used.
   `ClientLoop` only ever has one peer (the authority), so it is renamed
   `_peerId` rather than threaded through for no purpose.

The **steady-state zero-corrections test's exact numbers** — `WARMUP_TICKS = 360`,
`STEADY_TICKS = 600` — were chosen and verified empirically, not guessed: at
`WARMUP_TICKS = 180` (the tick this plan's other tasks use for
`COUNTDOWN_TICKS`, a tempting but wrong reuse here) the test was **flaky** — one
run in six, across the 15 seeds tried, showed exactly one correction a few
ticks past the warmup boundary, `posdiff.z` at 0.057 against a 0.05 epsilon,
still-settling residue from the initial input round-trip. `360` ticks (6s) gave
15/15 clean runs, including three repeats of the contract's own default seed.

---

**The design, briefly, before the code:**

- **Only the local kart is predicted.** `ClientLoop` bootstraps its own
  `predicted: SimState` via `createState`, marks *only* its own seat
  `isBot = false, connected = true`, and leaves the other seven at
  `createState`'s own default (`isBot: true, connected: false`). `resolveInputs`
  (`packages/sim/src/phase.ts`, unchanged by this task) therefore drives every
  other seat through the sim's own bot AI automatically — the same, already-shipped
  Plan 1 code, not a hand-rolled placeholder. Their resulting trajectory in
  `predicted` is real physics, not garbage, but it is **never trusted or
  rendered**: nothing in this file reads `predicted.karts[otherSeat]` for
  anything, and no test asserts anything about it. That is what "never
  predicted" means operationally here — the sim's `step()` signature always
  processes all `MAX_KARTS` seats (there is no partial-step entry point), so
  something has to occupy those seats each tick, and the sim's own bot AI is
  cheaper and more honest than inventing a second placeholder scheme.
  `ClientLoop` bootstraps with `characterIdx` all zero and `raceSeed = 0`
  because there is no character-selection or lobby-seed wiring in this plan
  (`'hello'`/`'welcome'`/`'lobby'`/`'start'` carry no codec in the protocol
  module map) — a later plan's handshake supplies the real values; neither
  affects this task's own kart's *position* (grid placement is purely a
  function of track + seat index) and `raceSeed` is inert on every non-leader
  peer regardless (`rollItem` returns `'none'` unconditionally when
  `!ctx.isLeader`, so a follower's PRNG cursor is never consulted).
- **The ring buffer** is `Array<{ tick, input, checkpoint, appliedEvents }>`,
  capacity `128` (≈2.13s at 60Hz). Under this plan's default lossy profile
  (150ms latency, 50ms jitter), worst-case one-way transit is 200ms = 12 ticks,
  so worst-case round trip is 400ms = 24 ticks — `128` gives more than 5×
  headroom for jitter spikes and pump-loop scheduling slop. `input` is the
  **raw** `Intent` handed to `tick()`, not the resolved one — same reasoning
  as Plan 1's `recordRun` (`packages/sim/src/replay.ts`, Task 16): what a
  replay must reproduce is the input that arrived, and `resolveInputs` is part
  of the simulation, not part of the input.
- **`appliedEvents` per ring entry exists because events are applied outside
  `step()`, and a replay that only re-runs `step()` would silently lose them.**
  Granted items (and any other authoritative event) are applied the instant
  they arrive over the reliable channel, directly to `predicted`, *outside*
  the tick loop — that mutation survives into the next tick only because
  `step()`'s `cloneState(prev, next)` copies whatever `predicted` currently
  holds. A reconciliation that discards history back to an *earlier* checkpoint
  and replays forward via `step()` alone has no way to know an event was ever
  applied at some tick in between — verified directly: an `itemGrant` applied
  at tick 5, followed by a reconciliation forced from tick 2, reverted the
  granted item to `'none'` without this. Fix: every event applied while
  `predicted.tick === T` is recorded onto ring entry `T`'s `appliedEvents`; a
  replay re-applies each entry's recorded events immediately after replaying
  that entry's `step()`, in the same order, which `applyEvent`'s own
  eventSeq-gating makes idempotent-safe regardless.
- **`corrections()` is the instrument for the zero-corrections invariant, and
  `state()` is the instrument for everything else.** Locked contract §4:
  *"That test is what proves the epsilons are above the noise floor... no
  epsilon may be tuned down."* Nothing but the counter exposes reconciliation
  *activity*, so a test that wants to know "did it correct" reads the counter
  before and after and diffs. But a counter is a poor instrument for
  "converged": zero corrections is also what a client with a dead transport
  reports. Every test below that asserts a zero delta therefore pairs it with
  two controls — a count of snapshots that actually arrived in the measured
  window, and a direct `state()` comparison against the authority's own kart.
- **The epsilon compare never uses a tolerance tighter than `EPS`.** `ownKartDiverged`
  below reads all six `EPS` keys by the names contract §3/§4 pins — `position`,
  `velocity`, `heading`, `angularVelocity`, `driftCharge`, **`t`** — and
  compares with strict `>`, never a
  hand-tightened constant — the buzzing-kart failure the whole epsilon table
  exists to prevent (locked contract §0) is a corrections-counter that fires on
  quantization noise alone, which is precisely the failure Step 12's test would
  catch if anyone loosened this later.

---

- [ ] **Step 1: Write the failing test — local prediction, the ring, and 30Hz input send**

Create `packages/net/test/client.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { Intent } from '@tapkart/sim'
import { createState } from '@tapkart/sim'
import type { InputDatagram } from '@tapkart/protocol'
import { decodeHeader, decodeInput, quantStep } from '@tapkart/protocol'
import { ClientLoop } from '../src/client'
import { makeLossyPair, makeNetContext } from './fixtures/net-fixtures'

const OWN = 4

/** encodeHeader writes tag + protocolVersion; locked contract §3 fixes it at 2. */
const HEADER_BYTES = 2

/** encodeInput quantises steer over [-1, 1] at 8 bits (Task 10), so a value
 * that round-trips is only ever accurate to one step. Asserting a decoded
 * steer to five decimal places would fail on a correct encoder: 0.02 lands on
 * bucket 130 and comes back 0.0196078…, an error of 3.9e-4 against a 5e-6
 * tolerance. Compare against the step instead of a hand-picked digit count. */
const STEER_STEP = quantStep(-1, 1, 8)

function mkIntent(steer: number): Intent {
  return { tick: 0, steer, accel: 1, brake: false, drift: false, useItem: false }
}

function makeInputDatagramTarget(): InputDatagram {
  const intents = []
  for (let i = 0; i < 8; i++) intents.push({ tick: 0, steer: 0, accel: 0, brake: false, drift: false, useItem: false })
  return { playerId: -1, intents }
}

describe('ClientLoop — local prediction', () => {
  it('steps its own kart forward every tick() call, driven by localIntent', () => {
    const ctx = makeNetContext(false)
    const pair = makeLossyPair({ latencyMs: 1, jitterMs: 0, lossRate: 0, seed: 1 })
    const client = new ClientLoop(ctx, OWN, pair.a)

    const startX = client.state().karts[OWN].position.x
    const startZ = client.state().karts[OWN].position.z
    expect(client.state().tick).toBe(0)

    for (let t = 1; t <= 60; t++) {
      client.tick(mkIntent(0.2))
      // The tick counter advances by exactly one per call - a loop that
      // double-stepped, or stopped stepping after the first call (the Plan 1
      // bug shape: a function that breaks on its second consecutive call),
      // fails on the very next iteration rather than at the end.
      expect(client.state().tick).toBe(t)
    }

    // 60 ticks (1s) of accel 1 actually moved the kart: a tick() that never
    // called step(), or called it with a neutral intent instead of
    // localIntent, leaves the kart on the grid and fails here.
    const k = client.state().karts[OWN]
    const moved = Math.hypot(k.position.x - startX, k.position.z - startZ)
    expect(moved).toBeGreaterThan(1)
    expect(Math.hypot(k.velocity.x, k.velocity.z)).toBeGreaterThan(0)
    // Nothing was ever received, so nothing could legitimately have corrected.
    expect(client.corrections()).toBe(0)
  })

  it('state() is the live predicted state, not a snapshot taken at construction', () => {
    const ctx = makeNetContext(false)
    const pair = makeLossyPair({ latencyMs: 1, jitterMs: 0, lossRate: 0, seed: 1 })
    const client = new ClientLoop(ctx, OWN, pair.a)

    const first = client.state()
    client.tick(mkIntent(0))
    client.tick(mkIntent(0))
    expect(client.state()).toBe(first)   // same object, identity not copy
    expect(first.tick).toBe(2)           // and it was advanced in place
    // Only this client's own seat is human; the other seven stay bot-driven,
    // which is what makes step() legal without a partial-seat entry point.
    expect(first.karts[OWN].isBot).toBe(false)
    expect(first.karts[OWN].connected).toBe(true)
  })
})

describe('ClientLoop — 30Hz input send with INPUT_REDUNDANCY', () => {
  it('sends a datagram every 2 ticks (60Hz sim / 30Hz send), carrying the last 8 intents newest-last', () => {
    const ctx = makeNetContext(false)
    const pair = makeLossyPair({ latencyMs: 1, jitterMs: 0, lossRate: 0, seed: 1 })
    const client = new ClientLoop(ctx, OWN, pair.a)

    const received: InputDatagram[] = []
    pair.b.onMessage((_peerId, channel, data) => {
      if (channel !== 'unreliable') return
      // Dispatch on the shared header, exactly as AuthorityLoop does: this
      // asserts, per message, that ClientLoop really tagged what it sent.
      expect(decodeHeader(data).kind).toBe('input')
      const dg = makeInputDatagramTarget()
      decodeInput(data.subarray(HEADER_BYTES), dg)
      received.push(dg)
    })

    let nowMs = 0
    for (let t = 1; t <= 20; t++) {
      client.tick(mkIntent(t * 0.01))
      pair.pump(nowMs)
      nowMs += 1000 / 60
    }

    // 20 client ticks at a 2-tick send interval -> sends on ticks 2,4,...,20: 10 datagrams.
    expect(received.length).toBe(10)
    expect(received[0].playerId).toBe(OWN)
    expect(received[0].intents.length).toBe(8)
    // newest-last: the datagram sent at tick 2 has its last slot's steer
    // matching the intent passed at tick 2 (t*0.01 = 0.02), to within one
    // quantisation step - encodeInput is lossy on steer by design.
    expect(Math.abs(received[0].intents[7].steer - 0.02)).toBeLessThan(STEER_STEP)
    // the LAST datagram sent (at tick 20) has newest slot steer 0.20.
    expect(Math.abs(received[9].intents[7].steer - 0.2)).toBeLessThan(STEER_STEP)
    // and the window really slid: the two datagrams differ, so this is not
    // eight copies of one value passing both checks by accident.
    expect(received[9].intents[7].steer).toBeGreaterThan(received[0].intents[7].steer)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/net/test/client.test.ts`

Expected: FAIL. `packages/net/src/client.ts` does not exist yet:

```
Error: Cannot find module '../src/client' imported from
'<repo>/packages/net/test/client.test.ts'
Caused by: Error: Failed to load url ../src/client (resolved id: ../src/client)
in .../client.test.ts. Does the file exist?

 Test Files  1 failed (1)
      Tests  no tests
```

(Format verified directly against this repo's Vitest 3.2.7 — see Task 13's brief.)

- [ ] **Step 3: Write the minimal implementation**

Create `packages/net/src/client.ts`:

```ts
import type { AuthEvent, Intent, KartState, SimContext, SimState } from '@tapkart/sim'
import { MAX_ENTITIES, MAX_KARTS, allocStateLike, cloneState, createState, makeIntentBuffer, step, wrapAngle } from '@tapkart/sim'
import type { ChannelName, WireEntity, WireKart, WireSnapshot } from '@tapkart/protocol'
import { EPS, INPUT_REDUNDANCY, decodeEvents, decodeHeader, decodeSnapshot, encodeHeader, encodeInput } from '@tapkart/protocol'
import type { Transport } from './transport'
import { applyEvent } from './apply'

/** 2.13s at 60Hz: >5x the 24-tick (400ms) worst-case round trip under this
 * plan's default lossy profile (150ms latency, 50ms jitter). See brief. */
const RING_CAPACITY = 128
/** 60Hz sim / 30Hz send = exact 2. */
const INPUT_SEND_INTERVAL_TICKS = 2
/** Generous fixed allocation, not a protocol-mandated size (see Task 14's
 * brief for the identical reasoning): an encoded input datagram is 8 small
 * intents plus the 2-byte message header, far under this. */
const SEND_BUF_BYTES = 256
/** encodeHeader writes tag + protocolVersion and returns 2 (locked contract
 * §3). Declared here because protocol exports the writer, not the width, and
 * every receive path needs the payload offset. */
const HEADER_BYTES = 2

/** No lobby/character-select wiring exists in this plan; see brief. */
const ZERO_CHARACTER_IDX = [0, 0, 0, 0, 0, 0, 0, 0]

function makeIntents(n: number): Intent[] {
  const out: Intent[] = []
  for (let i = 0; i < n; i++) out.push({ tick: 0, steer: 0, accel: 0, brake: false, drift: false, useItem: false })
  return out
}

function copyIntentInto(dst: Intent, src: Intent): void {
  dst.tick = src.tick
  dst.steer = src.steer
  dst.accel = src.accel
  dst.brake = src.brake
  dst.drift = src.drift
  dst.useItem = src.useItem
}

/** decodeSnapshot writes into an already-shaped destination, same convention
 * as cloneState. */
function makeWireSnapshotTarget(): WireSnapshot {
  const karts: WireKart[] = []
  for (let i = 0; i < MAX_KARTS; i++) {
    karts.push({
      playerId: 0, position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 },
      heading: 0, angularVelocity: 0, driftCharge: 0, driftActive: false, driftDir: 0,
      airborne: false, surface: 'tarmac', spinOutTicks: 0, invulnTicks: 0, item: 'none',
      lap: 0, checkpointIdx: 0, t: 0, isBot: false, connected: false,
      boostTicks: 0, respawnTicks: 0, shielded: false,
    })
  }
  const entities: WireEntity[] = []
  for (let i = 0; i < MAX_ENTITIES; i++) {
    entities.push({ entityId: -1, kind: 'seeker', ownerId: -1, position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, heading: 0, ttl: 0 })
  }
  return { tick: 0, eventSeq: 0, lastProcessedInputTick: new Array(MAX_KARTS).fill(-1), karts, entities, entityCount: 0 }
}

/** True when any field differs from `wire` by more than its EPS.*. Never
 * compares with a tighter tolerance than EPS - see brief. */
function ownKartDiverged(predicted: KartState, wire: WireKart): boolean {
  if (Math.abs(predicted.position.x - wire.position.x) > EPS.position) return true
  if (Math.abs(predicted.position.y - wire.position.y) > EPS.position) return true
  if (Math.abs(predicted.position.z - wire.position.z) > EPS.position) return true
  if (Math.abs(predicted.velocity.x - wire.velocity.x) > EPS.velocity) return true
  if (Math.abs(predicted.velocity.y - wire.velocity.y) > EPS.velocity) return true
  if (Math.abs(predicted.velocity.z - wire.velocity.z) > EPS.velocity) return true
  if (Math.abs(wrapAngle(predicted.heading - wire.heading)) > EPS.heading) return true
  if (Math.abs(predicted.angularVelocity - wire.angularVelocity) > EPS.angularVelocity) return true
  if (Math.abs(predicted.drift.charge - wire.driftCharge) > EPS.driftCharge) return true
  if (Math.abs(predicted.lap.t - wire.t) > EPS.t) return true
  if (predicted.spinOutTicks !== wire.spinOutTicks) return true
  if (predicted.invulnTicks !== wire.invulnTicks) return true
  if (predicted.boostTicks !== wire.boostTicks) return true
  if (predicted.respawnTicks !== wire.respawnTicks) return true
  if (predicted.lap.lap !== wire.lap) return true
  if (predicted.lap.checkpointIdx !== wire.checkpointIdx) return true
  if (predicted.item !== wire.item) return true
  if (predicted.surface !== wire.surface) return true
  if (predicted.drift.active !== wire.driftActive) return true
  if (predicted.drift.dir !== wire.driftDir) return true
  if (predicted.airborne !== wire.airborne) return true
  if (predicted.shielded !== wire.shielded) return true
  return false
}

function writeWireKartInto(kart: KartState, wire: WireKart): void {
  kart.position.x = wire.position.x
  kart.position.y = wire.position.y
  kart.position.z = wire.position.z
  kart.velocity.x = wire.velocity.x
  kart.velocity.y = wire.velocity.y
  kart.velocity.z = wire.velocity.z
  kart.heading = wire.heading
  kart.angularVelocity = wire.angularVelocity
  kart.drift.charge = wire.driftCharge
  kart.drift.active = wire.driftActive
  kart.drift.dir = wire.driftDir
  kart.airborne = wire.airborne
  kart.surface = wire.surface
  kart.spinOutTicks = wire.spinOutTicks
  kart.invulnTicks = wire.invulnTicks
  kart.item = wire.item
  kart.lap.lap = wire.lap
  kart.lap.checkpointIdx = wire.checkpointIdx
  kart.lap.t = wire.t
  kart.boostTicks = wire.boostTicks
  kart.respawnTicks = wire.respawnTicks
  kart.shielded = wire.shielded
}

interface RingEntry {
  tick: number
  input: Intent
  checkpoint: SimState
  /** Events applied to `predicted` while `predicted.tick === tick`, in
   * arrival order. Replayed again after this entry's step() during
   * reconciliation - see brief. */
  appliedEvents: AuthEvent[]
}

/**
 * The client's prediction and reconciliation loop. Only the local kart
 * (`playerId`) is ever predicted; the other seven seats are driven by the
 * sim's own bot AI (never trusted, never rendered) because step() has no
 * partial-seat entry point. Remote-kart/entity rendering is
 * RemoteInterpolator, below, standalone.
 */
export class ClientLoop {
  private readonly ctx: SimContext
  private readonly playerId: number
  private readonly transport: Transport

  private readonly predicted: SimState
  private readonly scratch: SimState
  private readonly resyncBase: SimState
  private readonly replayScratch: SimState
  private readonly replayInputs: Intent[]
  private readonly replayEvents: AuthEvent[] = []

  private readonly ring: RingEntry[] = []
  private pendingAppliedEvents: AuthEvent[] = []

  private readonly sendWindow: Intent[]
  private readonly sendBuf = new Uint8Array(SEND_BUF_BYTES)

  // Ping-ponged decode targets: see brief point 2. A stale, out-of-order
  // decode must never overwrite an already-pending fresher snapshot.
  private readonly decodeScratchA: WireSnapshot
  private readonly decodeScratchB: WireSnapshot
  private decodeTarget: WireSnapshot
  private pendingSnapshot: WireSnapshot | null = null
  private highestSeenSnapshotTick = -1

  private readonly decodedEvents: AuthEvent[] = []

  private correctionCount = 0

  constructor(ctx: SimContext, playerId: number, t: Transport) {
    // Defensive: a caller-supplied ctx with isLeader true would roll items and
    // try to emit - a follower must never do either.
    this.ctx = { ...ctx, isLeader: false }
    this.playerId = playerId
    this.transport = t

    this.predicted = createState(this.ctx, 0, ZERO_CHARACTER_IDX)
    // No 'start' handshake exists in this plan (contract §3 defines no codec
    // for the lobby kinds), so this loop starts racing immediately rather than
    // sitting out a countdown it can never be told has ended. CONSEQUENCE FOR
    // CALLERS: any authority paired with a ClientLoop must have its own
    // state.phase set to 'racing' too, or the authority freezes every kart for
    // COUNTDOWN_TICKS (phase.ts's resolveInputs) while this side drives, and
    // every snapshot in that window is a guaranteed correction.
    this.predicted.phase = 'racing'
    this.predicted.karts[playerId].isBot = false
    this.predicted.karts[playerId].connected = true

    this.scratch = allocStateLike(this.ctx, this.predicted)
    this.resyncBase = allocStateLike(this.ctx, this.predicted)
    this.replayScratch = allocStateLike(this.ctx, this.predicted)
    this.replayInputs = makeIntentBuffer()

    this.sendWindow = makeIntents(INPUT_REDUNDANCY)
    this.decodeScratchA = makeWireSnapshotTarget()
    this.decodeScratchB = makeWireSnapshotTarget()
    this.decodeTarget = this.decodeScratchA

    t.onMessage((_peerId, channel, data) => this.onMessage(channel, data))
  }

  private onMessage(channel: ChannelName, data: Uint8Array): void {
    // Dispatch on the shared header (locked contract §3), never on the channel
    // alone: a promoted ShadowLoop broadcasts snapshots and events on the same
    // two channels the host used, and this client keeps its transport. Reading
    // an events buffer as a snapshot because it happened to arrive on the
    // channel a snapshot usually uses is the failure this header prevents.
    // decodeHeader throws on an unknown tag or a version mismatch.
    const kind = decodeHeader(data).kind
    const payload = data.subarray(HEADER_BYTES)

    if (kind === 'snapshot' && channel === 'unreliable') {
      decodeSnapshot(payload, this.decodeTarget)
      if (this.decodeTarget.tick > this.highestSeenSnapshotTick) {
        this.highestSeenSnapshotTick = this.decodeTarget.tick
        this.pendingSnapshot = this.decodeTarget
        this.decodeTarget = this.decodeTarget === this.decodeScratchA ? this.decodeScratchB : this.decodeScratchA
      }
      return
    }
    if (kind === 'events' && channel === 'reliable') {
      // Applied the instant they arrive, not deferred to the next tick():
      // spec section 5, "the local kart's hit reaction plays on receipt, not
      // on prediction." See Task 13's brief for what applyEvent does per kind.
      this.decodedEvents.length = 0
      decodeEvents(payload, this.decodedEvents)
      for (const ev of this.decodedEvents) {
        applyEvent(this.ctx, this.predicted, ev)
        this.pendingAppliedEvents.push(ev)
      }
    }
    // Every other kind - checkpoint, authorityChange, the lobby kinds - has no
    // handler in this plan (contract §3 defines no codec for the lobby kinds,
    // and client-side authority migration is a later plan's scope, spec §5's
    // "clients swap transports"). Dropped deliberately, not silently: an
    // unknown TAG still throws in decodeHeader above; a known kind this loop
    // does not implement yet is simply ignored.
  }

  tick(localIntent: Intent): void {
    const inputs = makeIntentBuffer()
    copyIntentInto(inputs[this.playerId], localIntent)
    inputs[this.playerId].tick = this.predicted.tick + 1

    const events: AuthEvent[] = [] // scratch, discarded: a follower never emits
    step(this.ctx, this.predicted, this.scratch, inputs, events)
    cloneState(this.scratch, this.predicted)

    const checkpoint = allocStateLike(this.ctx, this.predicted)
    this.ring.push({
      tick: this.predicted.tick,
      input: { ...localIntent, tick: this.predicted.tick },
      checkpoint,
      appliedEvents: this.pendingAppliedEvents,
    })
    this.pendingAppliedEvents = []
    if (this.ring.length > RING_CAPACITY) this.ring.shift()

    if (this.predicted.tick % INPUT_SEND_INTERVAL_TICKS === 0) {
      for (let i = 0; i + 1 < this.sendWindow.length; i++) {
        copyIntentInto(this.sendWindow[i], this.sendWindow[i + 1])
      }
      copyIntentInto(this.sendWindow[this.sendWindow.length - 1], localIntent)
      this.sendWindow[this.sendWindow.length - 1].tick = this.predicted.tick
      const h = encodeHeader(this.sendBuf, 'input')
      const n = encodeInput(this.sendBuf.subarray(h), this.playerId, this.sendWindow)
      this.transport.broadcast('unreliable', this.sendBuf.slice(0, h + n))
    }

    if (this.pendingSnapshot !== null) {
      this.reconcile(this.pendingSnapshot)
      this.pendingSnapshot = null
    }
  }

  /** Count of corrections since construction. The zero-corrections test's
   * primary instrument - see brief. */
  corrections(): number {
    return this.correctionCount
  }

  /** The live predicted state, not a copy (locked contract §5: "read-only
   * view; the convergence test asserts on it directly"). Callers must not
   * mutate it: this loop reconciles against its own history, and an outside
   * write would be reverted by the next correction without warning. */
  state(): SimState {
    return this.predicted
  }

  /**
   * Anchored on `snap.tick`, not `lastProcessedInputTick[playerId]` - see
   * this brief's verification note for why the literal spec reading is wrong.
   */
  private reconcile(snap: WireSnapshot): void {
    const targetTick = snap.tick
    const idx = this.ring.findIndex((e) => e.tick === targetTick)
    if (idx < 0) {
      this.hardResync(snap)
      return
    }

    const wireKart = snap.karts[this.playerId]
    const predKart = this.ring[idx].checkpoint.karts[this.playerId]
    if (!ownKartDiverged(predKart, wireKart)) return

    this.correctionCount++
    cloneState(this.ring[idx].checkpoint, this.resyncBase)
    writeWireKartInto(this.resyncBase.karts[this.playerId], wireKart)

    let cur = this.resyncBase
    let scratch = this.replayScratch
    for (let i = idx + 1; i < this.ring.length; i++) {
      const e = this.ring[i]
      copyIntentInto(this.replayInputs[this.playerId], e.input)
      this.replayInputs[this.playerId].tick = cur.tick + 1
      this.replayEvents.length = 0
      step(this.ctx, cur, scratch, this.replayInputs, this.replayEvents)
      const tmp = cur
      cur = scratch
      scratch = tmp
      for (const ev of e.appliedEvents) applyEvent(this.ctx, cur, ev)
      // Refresh this entry's own checkpoint too, so a LATER reconcile() call
      // (targeting a tick further along) replays from corrected history
      // rather than the stale pre-correction data it held before.
      cloneState(cur, e.checkpoint)
    }
    cloneState(cur, this.predicted)
  }

  /**
   * Degraded-mode fallback for a ring that does not (or no longer) hold
   * `snap.tick` - in practice, only reachable if the ring capacity (128
   * ticks, 2.13s) is exceeded by an extreme stall, since normal reconnection
   * and late-join both need an AuthorityCheckpoint this task does not
   * implement (out of scope - see Task 16). This at least fixes the one
   * thing it can without one: the local kart's own fields, directly, with a
   * visible discontinuity accepted as the cost of not silently staying wrong
   * forever. Every other kart and every entity in `predicted` is unaffected -
   * neither is ever read for anything.
   */
  private hardResync(snap: WireSnapshot): void {
    this.correctionCount++
    writeWireKartInto(this.predicted.karts[this.playerId], snap.karts[this.playerId])
    this.predicted.tick = snap.tick
    this.ring.length = 0
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/net/test/client.test.ts`

Expected: PASS — 3 tests.

- [ ] **Step 5: Write the failing test — reconciliation, hard resync, and event application**

Append to `packages/net/test/client.test.ts`. First add imports for what this
round needs, next to the existing ones:

```ts
import type { AuthEvent } from '@tapkart/sim'
import { createState as createSimState, step as simStep, makeIntentBuffer as makeSimIntentBuffer } from '@tapkart/sim'
import { EPS, encodeEvents, encodeHeader, encodeSnapshot } from '@tapkart/protocol'
import type { Transport } from '../src/transport'
import { AuthorityLoop } from '../src/authority'
```

and this shared constant plus one helper, used by every test below:

```ts
const CHARS8 = [0, 0, 0, 0, 0, 0, 0, 0]

/**
 * Counts the snapshots that actually reached this side of the pair.
 *
 * Registering a second listener alongside ClientLoop's own is legal and does
 * not displace it: makeLoopbackPair (Task 12) keeps an array of callbacks per
 * side and invokes every one of them (`messageCbs.push(cb)` in its `onMessage`,
 * `for (const cb of cbs)` in its `pump`). Verified by reading Task 12's
 * implementation, not assumed - a transport that kept only the last callback
 * would silently unregister the code under test and every assertion after this
 * point would be meaningless.
 *
 * This exists because "zero corrections" is also what a client that received
 * NOTHING reports. Every zero-delta assertion below is paired with a floor on
 * this counter.
 */
function countSnapshots(t: Transport): () => number {
  let n = 0
  t.onMessage((_peerId, channel, data) => {
    if (channel === 'unreliable' && decodeHeader(data).kind === 'snapshot') n++
  })
  return () => n
}
```

Then append (this round drives a real `AuthorityLoop` for genuinely
authoritative wire data — a hand-typed `WireSnapshot` would not exercise the
real question, which is whether `ClientLoop` correctly finds and trusts real
authoritative data at `snap.tick`):

```ts
describe('ClientLoop — reconciliation', () => {
  it('converges to zero corrections against a real AuthorityLoop, steer held steady', () => {
    const ctxA = makeNetContext(true)
    const state = createSimState(ctxA, 0, CHARS8)
    state.phase = 'racing'
    state.karts[OWN].isBot = false
    state.karts[OWN].connected = true

    const pair = makeLossyPair({ latencyMs: 20, jitterMs: 5, lossRate: 0, seed: 3 })
    const authority = new AuthorityLoop(ctxA, state, pair.a)
    const ctxC = makeNetContext(false)
    const snapshotsSeen = countSnapshots(pair.b)
    const client = new ClientLoop(ctxC, OWN, pair.b)

    let nowMs = 0
    for (let t = 0; t < 120; t++) {
      authority.tick()
      client.tick(mkIntent(0.15))
      pair.pump(nowMs)
      nowMs += 1000 / 60
    }
    const baseline = client.corrections()
    const snapshotsAtBaseline = snapshotsSeen()
    for (let t = 0; t < 120; t++) {
      authority.tick()
      client.tick(mkIntent(0.15))
      pair.pump(nowMs)
      nowMs += 1000 / 60
    }

    expect(client.corrections() - baseline).toBe(0)
    // Control: the measured window must contain real traffic. 120 ticks at one
    // snapshot every 3 ticks is 40 broadcasts with lossRate 0; a floor of 30
    // absorbs the latency shift at the window edges without absorbing silence.
    expect(
      snapshotsSeen() - snapshotsAtBaseline,
      'no snapshots arrived in the measured window, so the zero above is vacuous',
    ).toBeGreaterThanOrEqual(30)
    // Control: converged means converged. The client's own kart really is
    // where the authority says it is, rather than merely "took no
    // corrections" - which a client that never compared anything also reports.
    //
    // The tolerance here is deliberately NOT EPS. Both loops are at the same
    // tick number, but not at the same instant of information: the client's
    // current tick is the authority's state at snap.tick replayed forward a
    // few ticks. The epsilon-tight claim is about the comparison AT snap.tick,
    // and the zero-corrections delta above is what asserts it. This assertion
    // answers a different question - "is the client tracking the right kart in
    // the right race at all" - where the failure mode is metres, not
    // centimetres. Widening it does not weaken the epsilon invariant, and
    // tightening it to EPS would make a correct implementation flaky.
    const CONVERGED_BAND_M = 0.5
    const CONVERGED_BAND_MS = 1.0
    const mine = client.state().karts[OWN]
    const theirs = authority.state().karts[OWN]
    expect(Math.abs(mine.position.x - theirs.position.x)).toBeLessThan(CONVERGED_BAND_M)
    expect(Math.abs(mine.position.z - theirs.position.z)).toBeLessThan(CONVERGED_BAND_M)
    expect(Math.abs(mine.velocity.x - theirs.velocity.x)).toBeLessThan(CONVERGED_BAND_MS)
    expect(Math.abs(mine.velocity.z - theirs.velocity.z)).toBeLessThan(CONVERGED_BAND_MS)
    // Deliberately no equality assertion on lap/checkpointIdx: two karts half a
    // metre apart can legitimately sit on opposite sides of a checkpoint line at
    // one arbitrary instant, and a test that flakes on a correct implementation
    // teaches the next reader to widen it.
  })

  it('a snapshot whose tick the ring cannot find (idx < 0) triggers a hard resync instead of throwing', () => {
    const ctx = makeNetContext(false)
    const pair = makeLossyPair({ latencyMs: 1, jitterMs: 0, lossRate: 0, seed: 1 })
    const client = new ClientLoop(ctx, OWN, pair.a)
    client.tick(mkIntent(0)) // ring now holds only tick 1

    // A real SimState far ahead of anything the ring could hold, stepped
    // directly through @tapkart/sim (not through AuthorityLoop - only a
    // valid SimState's shape matters here, not a realistic trajectory to it).
    const farCtx = makeNetContext(true)
    let a = createSimState(farCtx, 0, CHARS8)
    a.karts[OWN].isBot = false
    a.karts[OWN].connected = true
    let b = createSimState(farCtx, 0, CHARS8)
    const inputs = makeSimIntentBuffer()
    for (let t = 0; t < 500; t++) {
      for (let i = 0; i < 8; i++) inputs[i].tick = a.tick + 1
      const events: AuthEvent[] = []
      simStep(farCtx, a, b, inputs, events)
      const tmp = a
      a = b
      b = tmp
    }
    expect(a.tick).toBe(500)

    // Worst-case snapshot is 743 B (contract §4: 8x178 + 32x135 + 200 bits =
    // 5944 bits); 1024 plus the 2-byte header is comfortable headroom.
    const buf = new Uint8Array(1024)
    const h = encodeHeader(buf, 'snapshot')
    const n = encodeSnapshot(buf.subarray(h), a, new Array(8).fill(-1))
    pair.b.broadcast('unreliable', buf.slice(0, h + n))
    // pump() only DELIVERS a message once nowMs has advanced past the
    // moment it was scheduled - the same schedule-then-deliver split a real
    // transport needs, so one call right after broadcast() never delivers
    // anything (deliverAt is computed as >= that same nowMs). Several frames
    // of pumping guarantee delivery well before the loop ends.
    let nowMs = 0
    for (let i = 0; i < 10; i++) {
      pair.pump(nowMs)
      nowMs += 1000 / 60
    }

    expect(() => client.tick(mkIntent(0))).not.toThrow()
    expect(client.corrections()).toBeGreaterThan(0)
    // And the resync actually landed. tick() steps first (tick 1 -> 2) and
    // reconciles at the end of the same call, so hardResync's
    // `predicted.tick = snap.tick` leaves the clock at exactly 500. Without
    // hardResync the client would still be at tick 2 on the grid, having
    // ignored a snapshot it could not place in its ring.
    expect(client.state().tick).toBe(500)
    // The kart carries the dequantised authoritative position, which is within
    // one quantisation step of the source - and contract §4 guarantees every
    // epsilon exceeds its own step, so EPS.position is the correct bound here
    // rather than a hand-picked number.
    expect(
      Math.abs(client.state().karts[OWN].position.x - a.karts[OWN].position.x),
    ).toBeLessThanOrEqual(EPS.position)
  })
})
```

Now append the events-application test, in a new `describe`. Delivery needs
the same multi-frame pumping as the hard-resync test above, for the same
reason:

```ts
describe('ClientLoop — events applied immediately, not deferred', () => {
  it('an itemGrant received over the reliable channel updates the local kart before the next tick() returns', () => {
    const ctx = makeNetContext(false)
    const pair = makeLossyPair({ latencyMs: 1, jitterMs: 0, lossRate: 0, seed: 1 })
    const client = new ClientLoop(ctx, OWN, pair.a)

    for (let t = 0; t < 5; t++) client.tick(mkIntent(0))

    expect(client.state().karts[OWN].item).toBe('none')
    expect(client.state().nextEventSeq).toBe(0)

    const events: AuthEvent[] = [
      { eventSeq: 0, tick: 5, kind: 'itemGrant', playerId: OWN, entityId: -1, item: 'seeker', data: 0 },
    ]
    const buf = new Uint8Array(4096)
    const h = encodeHeader(buf, 'events')
    const n = encodeEvents(buf.subarray(h), events)
    pair.b.broadcast('reliable', buf.slice(0, h + n))
    let nowMs = 0
    for (let i = 0; i < 10; i++) {
      pair.pump(nowMs)
      nowMs += 1000 / 60
    }

    // applyEvent runs synchronously inside the onMessage callback fired by
    // pump() above, so by the time pump() returns the item is already there -
    // before any further tick() call. That is the whole claim in this test's
    // title, and state() (locked contract §5) is what makes it observable:
    // an earlier draft of this test could only assert `not.toThrow()`, which a
    // ClientLoop that dropped every reliable datagram on the floor also passes.
    expect(client.state().karts[OWN].item).toBe('seeker')
    expect(client.state().nextEventSeq).toBe(1)
    // A follower's nextEventSeq advances ONLY by applying received events
    // (contract §1b/§0), so this pair of assertions also proves the client
    // never emitted one of its own during those five ticks.

    // Still there after the next tick(): applying an event outside step() is
    // only durable because step()'s cloneState(prev, next) carries it forward.
    client.tick(mkIntent(0))
    expect(client.state().karts[OWN].item).toBe('seeker')
  })
})
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `npx vitest run packages/net/test/client.test.ts`

Expected: **the suite is already green.** All three new tests exercise
code Step 3 already wrote in full — reconciliation, the hard-resync fallback,
and event application are not separable from `tick()`/`onMessage()`, so there
is no partial implementation this round adds. This mirrors Task 14's Step 6:
the instruction to "run and see it fail" exists to catch a real gap, not to
manufacture one — if Step 3's implementation is correct, new tests against
already-complete code are coverage, not red. **Skip to Step 8.**

- [ ] **Step 7: Run the test to verify it passes** (present only for the case
  Step 6 was unexpectedly red; expected not to be needed)

Run: `npx vitest run packages/net/test/client.test.ts`

Expected: PASS — 6 tests total (3 from Step 1, 2 reconciliation, 1 events).

- [ ] **Step 8: Write the failing test — `RemoteInterpolator`**

Append to `packages/net/test/client.test.ts`:

```ts
import type { WireKart } from '@tapkart/protocol'
import { REMOTE_EXTRAPOLATE_CAP_MS, REMOTE_INTERP_DELAY_MS, RemoteInterpolator } from '../src/client'

function mkRemoteKart(x: number, vx: number): WireKart {
  return {
    playerId: 1, position: { x, y: 0, z: 0 }, velocity: { x: vx, y: 0, z: 0 },
    heading: 0, angularVelocity: 0, driftCharge: 0, driftActive: false, driftDir: 0,
    airborne: false, surface: 'tarmac', spinOutTicks: 0, invulnTicks: 0, item: 'none',
    lap: 0, checkpointIdx: 0, t: 0, isBot: false, connected: true,
    boostTicks: 0, respawnTicks: 0, shielded: false,
  }
}

describe('RemoteInterpolator', () => {
  it('returns null before anything has been pushed', () => {
    const ri = new RemoteInterpolator()
    expect(ri.sampleKart(1, 1000)).toBeNull()
  })

  it('interpolates linearly between two bracketing keyframes at the render-delay target', () => {
    const ri = new RemoteInterpolator()
    ri.push({ recvAtMs: 1000, karts: [mkRemoteKart(0, 0), mkRemoteKart(0, 0), mkRemoteKart(0, 5)] })
    ri.push({ recvAtMs: 1050, karts: [mkRemoteKart(0, 0), mkRemoteKart(0, 0), mkRemoteKart(0.25, 5)] })
    // nowMs=1125 -> targetMs = 1125 - REMOTE_INTERP_DELAY_MS(100) = 1025,
    // the midpoint of [1000, 1050].
    const s = ri.sampleKart(2, 1125)
    expect(s).not.toBeNull()
    expect(s!.position.x).toBeCloseTo(0.125, 5)
  })

  it('extrapolates briefly from the newest keyframe when the buffer starves, hard-capped at 200ms', () => {
    const ri = new RemoteInterpolator()
    ri.push({ recvAtMs: 1000, karts: [mkRemoteKart(0, 0), mkRemoteKart(0, 0), mkRemoteKart(10, 4)] })
    const nowMs = 1000 + REMOTE_INTERP_DELAY_MS + 5000 // target is 5s past the only keyframe
    const s = ri.sampleKart(2, nowMs)
    expect(s).not.toBeNull()
    const expected = 10 + 4 * (REMOTE_EXTRAPOLATE_CAP_MS / 1000)
    expect(s!.position.x).toBeCloseTo(expected, 5) // capped at 200ms of velocity, not 5s
  })

  it('respects REMOTE_BUFFER_CAPACITY (8), evicting the oldest keyframe first', () => {
    const ri = new RemoteInterpolator()
    for (let i = 0; i < 20; i++) {
      ri.push({ recvAtMs: i * 50, karts: [mkRemoteKart(0, 0), mkRemoteKart(0, 0), mkRemoteKart(i, 0)] })
    }
    // Capacity 8 means only i=12..19 (recvAtMs 600..950) survive. Sampling
    // before everything retained clamps to the oldest surviving keyframe.
    const s = ri.sampleKart(2, 0)
    expect(s).not.toBeNull()
    expect(s!.position.x).toBe(12)
  })
})
```

- [ ] **Step 9: Run the test to verify it fails**

Run: `npx vitest run packages/net/test/client.test.ts`

Expected: FAIL on the four new tests. `client.ts` exists (Step 3 landed it)
and already exports `ClientLoop`, so this is **not** the "Cannot find module"
shape — it is a missing named export from a file that does exist:

```
TypeError: RemoteInterpolator is not a constructor
 ❯ packages/net/test/client.test.ts:<line>
```

(Verified directly: constructing an undefined import throws exactly `TypeError: X is not a constructor` under this repo's esbuild SSR transform — the constructor-call analogue of Task 13's "is not a function" for a plain call. Confirmed by direct probe against Vitest 3.2.7 before writing this brief.)

- [ ] **Step 10: Write the minimal implementation**

Append to `packages/net/src/client.ts`:

```ts
// ---- RemoteInterpolator -----------------------------------------------
//
// Remote karts and all world entities are never predicted (spec section 5):
// buffered and rendered ~100ms in the past with interpolation, extrapolating
// briefly with a hard cap when the buffer starves. This is deliberately
// standalone, not yet wired into ClientLoop's tick()/onMessage() - see this
// brief's "Produces" section for why: nothing in ClientLoop's locked
// four-member shape can surface interpolated remote samples to a renderer
// (state() exposes the PREDICTED SimState, whose remote seats are exactly the
// locally-simulated values spec section 5 says never to render), and this task
// will not add a fifth member to a locked class. Step 14 below wires this
// class's INPUT to ClientLoop's own incoming snapshot stream, through a free
// function rather than a class member; a later plan wires its OUTPUT to an
// actual renderer/scene graph.

/** Spec section 5: "approximately 100ms in the past." Exact here. */
export const REMOTE_INTERP_DELAY_MS = 100
/** 8 keyframes at the 20Hz snapshot rate = 400ms of retained history, 4x the
 * render delay, with headroom for the default 5% loss rate. */
export const REMOTE_BUFFER_CAPACITY = 8
/** One full snapshot period (50ms) x4: enough to ride out a single missed
 * snapshot's worth of dead air before visibly giving up. */
export const REMOTE_EXTRAPOLATE_CAP_MS = 200

export interface RemoteKeyframe {
  recvAtMs: number
  karts: WireKart[]
}

export interface RemoteSample {
  position: { x: number; y: number; z: number }
  heading: number
}

export class RemoteInterpolator {
  private readonly buffer: RemoteKeyframe[] = []

  push(kf: RemoteKeyframe): void {
    // Out-of-order (jitter-delayed) keyframe: drop, never regress the buffer.
    if (this.buffer.length > 0 && kf.recvAtMs <= this.buffer[this.buffer.length - 1].recvAtMs) return
    this.buffer.push(kf)
    if (this.buffer.length > REMOTE_BUFFER_CAPACITY) this.buffer.shift()
  }

  sampleKart(playerId: number, nowMs: number): RemoteSample | null {
    if (this.buffer.length === 0) return null
    const targetMs = nowMs - REMOTE_INTERP_DELAY_MS

    let before: RemoteKeyframe | null = null
    let after: RemoteKeyframe | null = null
    for (const kf of this.buffer) {
      if (kf.recvAtMs <= targetMs) before = kf
      else if (after === null) after = kf
    }

    if (before !== null && after !== null) {
      const span = after.recvAtMs - before.recvAtMs
      const t = span > 0 ? (targetMs - before.recvAtMs) / span : 0
      const a = before.karts[playerId]
      const b = after.karts[playerId]
      return {
        position: {
          x: a.position.x + (b.position.x - a.position.x) * t,
          y: a.position.y + (b.position.y - a.position.y) * t,
          z: a.position.z + (b.position.z - a.position.z) * t,
        },
        heading: a.heading + wrapAngle(b.heading - a.heading) * t,
      }
    }

    const latest = before !== null ? before : (after as RemoteKeyframe)
    const overMs = Math.min(Math.max(targetMs - latest.recvAtMs, 0), REMOTE_EXTRAPOLATE_CAP_MS)
    const overS = overMs / 1000
    const k = latest.karts[playerId]
    return {
      position: {
        x: k.position.x + k.velocity.x * overS,
        y: k.position.y + k.velocity.y * overS,
        z: k.position.z + k.velocity.z * overS,
      },
      heading: k.heading,
    }
  }
}
```

- [ ] **Step 11: Run the test to verify it passes**

Run: `npx vitest run packages/net/test/client.test.ts`

Expected: PASS — 10 tests total (6 + 4 RemoteInterpolator tests).

- [ ] **Step 12: Write the failing test — wiring `RemoteInterpolator` to the incoming snapshot stream**

`RemoteInterpolator` from Step 10 is fully implemented and tested standalone, but nothing feeds
it: spec §5 requires remote karts to be "buffered and rendered approximately 100ms in the past
with interpolation" from the live snapshot stream, and until this step `ClientLoop` decodes every
incoming `WireSnapshot` only to reconcile its own kart against it (`reconcile`, above) — the other
seven karts' wire data is read and then discarded. Wiring the feed itself (not a renderer, which
does not exist in this plan — see the Produces section above) is this task's own scope, per this
brief's residual-findings pass.

Append to `packages/net/test/client.test.ts`. First widen the `@tapkart/sim` import used by the
reconciliation tests (added in Step 5) to add `MAX_KARTS`. Before:

```ts
import { createState as createSimState, step as simStep, makeIntentBuffer as makeSimIntentBuffer } from '@tapkart/sim'
```

After:

```ts
import { MAX_KARTS, createState as createSimState, step as simStep, makeIntentBuffer as makeSimIntentBuffer } from '@tapkart/sim'
```

Then widen the `RemoteInterpolator` import added in Step 8 to add `remoteInterpolatorOf`. Before:

```ts
import { REMOTE_EXTRAPOLATE_CAP_MS, REMOTE_INTERP_DELAY_MS, RemoteInterpolator } from '../src/client'
```

After:

```ts
import { REMOTE_EXTRAPOLATE_CAP_MS, REMOTE_INTERP_DELAY_MS, RemoteInterpolator, remoteInterpolatorOf } from '../src/client'
```

Then append a new `describe` block, after `describe('RemoteInterpolator', ...)`'s closing `})`:

```ts
describe('ClientLoop — RemoteInterpolator wiring', () => {
  it('feeds the incoming snapshot stream into its RemoteInterpolator, keyed by receipt tick', () => {
    const ctxA = makeNetContext(true)
    const state = createSimState(ctxA, 0, CHARS8)
    state.phase = 'racing'
    state.karts[OWN].isBot = false
    state.karts[OWN].connected = true

    const pair = makeLossyPair({ latencyMs: 1, jitterMs: 0, lossRate: 0, seed: 7 })
    const authority = new AuthorityLoop(ctxA, state, pair.a)
    const ctxC = makeNetContext(false)
    const client = new ClientLoop(ctxC, OWN, pair.b)

    // A remote seat's kart: bot-driven on the authority, real physics in
    // ClientLoop's own predicted SimState but never trusted or rendered from
    // there (see this brief's design section). Its only path into anything
    // this test can observe is the wire, through the wiring this step adds.
    const REMOTE_SEAT = (OWN + 1) % MAX_KARTS

    let nowMs = 0
    for (let t = 0; t < 30; t++) {
      authority.tick()
      client.tick(mkIntent(0))
      pair.pump(nowMs)
      nowMs += 1000 / 60
    }

    // Before anything is ever pushed, RemoteInterpolator.sampleKart returns
    // null (its own "returns null before anything has been pushed" test,
    // above) - so a non-null result here is only possible if at least one
    // snapshot's karts array actually reached this interpolator.
    const sample = remoteInterpolatorOf(client).sampleKart(REMOTE_SEAT, client.state().tick * (1000 / 60))
    expect(sample).not.toBeNull()
    // And it is real data, not a degenerate {0,0,0}: every shipped track's
    // grid start is off-origin (Plan 1's oval places seat 0 at
    // (-200, ., -100)), so a wired-through remote kart is nowhere near the
    // origin either.
    expect(Math.abs(sample!.position.x) + Math.abs(sample!.position.z)).toBeGreaterThan(1)
  })
})
```

- [ ] **Step 13: Run the test to verify it fails**

Run: `npx vitest run packages/net/test/client.test.ts`

Expected: FAIL. `client.ts` already exports `ClientLoop` and `RemoteInterpolator` (Steps 3 and
10), but not `remoteInterpolatorOf` — a missing named runtime export binds to `undefined` at the
call site (this repo's established pattern for a missing named value export, e.g. Task 1's
`TypeError: resetBotHold is not a function`, Task 3's `TypeError: encodeHeader is not a function`),
so this fails as a plain call, not a constructor call (contrast Step 9's
`TypeError: RemoteInterpolator is not a constructor`):

```
TypeError: remoteInterpolatorOf is not a function
 ❯ packages/net/test/client.test.ts:<line>
```

- [ ] **Step 14: Wire `RemoteInterpolator` into `ClientLoop`'s snapshot receipt path**

Five edits to `packages/net/src/client.ts`.

First, widen the `@tapkart/sim` import at the top of the file to add `TICK_HZ`. Before:

```ts
import { MAX_ENTITIES, MAX_KARTS, allocStateLike, cloneState, createState, makeIntentBuffer, step, wrapAngle } from '@tapkart/sim'
```

After:

```ts
import { MAX_ENTITIES, MAX_KARTS, TICK_HZ, allocStateLike, cloneState, createState, makeIntentBuffer, step, wrapAngle } from '@tapkart/sim'
```

Second, add a clock constant and a clone helper near the file's other small helpers, right after
`copyIntentInto` and before `makeWireSnapshotTarget`:

```ts
/** Milliseconds per sim tick at the fixed 60Hz rate (TICK_HZ, @tapkart/sim). Used
 * only to timestamp RemoteInterpolator keyframes - no Date.now() call anywhere in
 * this file, matching contract §0's "ticks only" convention; this loop's own tick
 * counter already advances in lockstep with real time under normal play. */
const TICK_MS = 1000 / TICK_HZ

/** RemoteInterpolator retains keyframes across many tick()s. A pushed karts array
 * must be this loop's own copy: `decodeTarget` is one of two ping-ponged scratch
 * buffers (this brief's verification note, finding 2) that a later decode
 * overwrites in place, and a keyframe holding a reference into it would
 * silently corrupt already-buffered history the moment the next snapshot
 * arrives. */
function cloneWireKarts(karts: WireKart[]): WireKart[] {
  return karts.map((k) => ({ ...k, position: { ...k.position }, velocity: { ...k.velocity } }))
}
```

Third, in `ClientLoop`'s `onMessage`, push into the interpolator right after a snapshot is accepted
as newer than anything seen so far — before the ping-pong buffer is swapped, while
`this.decodeTarget` still refers to the buffer that was just decoded into. Before:

```ts
    if (kind === 'snapshot' && channel === 'unreliable') {
      decodeSnapshot(payload, this.decodeTarget)
      if (this.decodeTarget.tick > this.highestSeenSnapshotTick) {
        this.highestSeenSnapshotTick = this.decodeTarget.tick
        this.pendingSnapshot = this.decodeTarget
        this.decodeTarget = this.decodeTarget === this.decodeScratchA ? this.decodeScratchB : this.decodeScratchA
      }
      return
    }
```

After:

```ts
    if (kind === 'snapshot' && channel === 'unreliable') {
      decodeSnapshot(payload, this.decodeTarget)
      if (this.decodeTarget.tick > this.highestSeenSnapshotTick) {
        this.highestSeenSnapshotTick = this.decodeTarget.tick
        // Every remote kart's wire data, not just this client's own seat -
        // spec §5's "buffered and rendered ~100ms in the past" requirement
        // (this brief's Produces section, RemoteInterpolator). Timestamped by
        // this loop's own tick counter, not a wall-clock read (see TICK_MS).
        this.remoteInterp.push({ recvAtMs: this.predicted.tick * TICK_MS, karts: cloneWireKarts(this.decodeTarget.karts) })
        this.pendingSnapshot = this.decodeTarget
        this.decodeTarget = this.decodeTarget === this.decodeScratchA ? this.decodeScratchB : this.decodeScratchA
      }
      return
    }
```

Fourth, add the `remoteInterp` field to `ClientLoop`, construct it, and register the instance for
the free function below. In the class field declarations, after `private correctionCount = 0`:

```ts
  private correctionCount = 0
  private readonly remoteInterp = new RemoteInterpolator()
```

And after the constructor body's existing last line, register the instance so
`remoteInterpolatorOf` can reach it:

```ts
    t.onMessage((_peerId, channel, data) => this.onMessage(channel, data))
    remoteInterpolators.set(this, this.remoteInterp)
```

`RemoteInterpolator` is declared later in this same file (Step 10), which is safe here:
`ClientLoop`'s constructor body only *runs* the first time `new ClientLoop(...)` is called, by
which point the whole module — including the `RemoteInterpolator` class declaration below — has
already finished executing. JavaScript's per-module, top-to-bottom evaluation order guarantees
this; nothing in this class is invoked at module-evaluation time, only referenced inside function
bodies that run later.

Finally, add the `WeakMap` and the free function immediately above the `RemoteInterpolator` class
(Step 10's block), since that is the first point in the file both `ClientLoop` and
`RemoteInterpolator` are in scope together:

```ts
/**
 * Per-instance access to a ClientLoop's RemoteInterpolator without adding a fifth
 * member to the locked four-member class (contract §5 fixes ClientLoop's shape
 * exactly: constructor, tick, corrections, state - "no task may... add fields to
 * anything below"). A free function reading a WeakMap is the same "define what you
 * need in your own files" allowance this task already used for RemoteInterpolator
 * itself; it adds nothing to ClientLoop's own public surface.
 */
const remoteInterpolators = new WeakMap<ClientLoop, RemoteInterpolator>()

/** Throws rather than returning undefined: every ClientLoop registers itself in its
 * own constructor, so a missing entry means a caller passed something this module
 * never actually constructed. */
export function remoteInterpolatorOf(client: ClientLoop): RemoteInterpolator {
  const ri = remoteInterpolators.get(client)
  if (!ri) throw new Error('remoteInterpolatorOf: not a ClientLoop instance')
  return ri
}
```

Fifth, update Step 10's `RemoteInterpolator` section comment now that it is no longer accurate — the class is wired as of this step. Before:

```ts
// Remote karts and all world entities are never predicted (spec section 5):
// buffered and rendered ~100ms in the past with interpolation, extrapolating
// briefly with a hard cap when the buffer starves. This is deliberately
// standalone, not yet wired into ClientLoop's tick()/onMessage() - see this
// brief's "Produces" section for why: nothing in ClientLoop's locked
// four-member shape can surface interpolated remote samples to a renderer
// (state() exposes the PREDICTED SimState, whose remote seats are exactly the
// locally-simulated values spec section 5 says never to render), and this task
// will not add a fifth member to a locked class. Step 14 below wires this
// class's INPUT to ClientLoop's own incoming snapshot stream, through a free
// function rather than a class member; a later plan wires its OUTPUT to an
// actual renderer/scene graph.
```

After:

```ts
// Remote karts and all world entities are never predicted (spec section 5):
// buffered and rendered ~100ms in the past with interpolation, extrapolating
// briefly with a hard cap when the buffer starves. The class itself is
// standalone on purpose - nothing in ClientLoop's locked four-member shape
// can surface interpolated remote samples to a renderer (state() exposes the
// PREDICTED SimState, whose remote seats are exactly the locally-simulated
// values spec section 5 says never to render), and this task will not add a
// fifth member to a locked class. Its INPUT is wired, though: onMessage's
// 'snapshot' branch above pushes every accepted snapshot in here, and
// remoteInterpolatorOf (just below) is the free-function accessor a later
// plan's renderer reads from. That renderer, and the OUTPUT half of wiring
// this to an actual scene graph, remains a later plan's job.
```

- [ ] **Step 15: Run the test to verify it passes**

Run: `npx vitest run packages/net/test/client.test.ts`

Expected: PASS — 11 tests total (10 from Steps 1–11, plus the wiring test).

- [ ] **Step 16: Write the failing test — the flagship zero-corrections invariant, spec §8**

Append to `packages/net/test/client.test.ts`:

```ts
describe('ClientLoop — the zero-corrections invariant (spec section 8)', () => {
  it('a converged client takes zero corrections from quantization noise alone, at the default lossy profile', () => {
    const ctxA = makeNetContext(true)
    const state = createSimState(ctxA, 0, CHARS8)
    state.phase = 'racing'
    // Only OWN is human/connected; the other seven stay bot-driven
    // (createState's own default), matching ClientLoop's internal bootstrap
    // exactly - both sims then run the SAME deterministic bot AI, in the
    // same process, off the same seed, so the other seven seats stay in
    // lockstep and cannot be a source of divergence for OWN's own kart
    // (e.g. via collision) that this test would wrongly blame on epsilon.
    state.karts[OWN].isBot = false
    state.karts[OWN].connected = true
    // Neutralize item boxes on the authority: an itemGrant travels the
    // reliable channel independently of the unreliable snapshot stream, and
    // under independent jitter can arrive either before or after a snapshot
    // that already reflects it - a real, timing-driven (not quantization)
    // divergence this test must not conflate with a buzzing-kart bug.
    for (const box of state.itemBoxes) box.respawnTicks = 1_000_000

    const pair = makeLossyPair({}) // contract default: 150ms latency, 50ms jitter, 5% loss, seed 0xC0FFEE
    const authority = new AuthorityLoop(ctxA, state, pair.a)
    const ctxC = makeNetContext(false)
    const snapshotsSeen = countSnapshots(pair.b)
    const client = new ClientLoop(ctxC, OWN, pair.b)

    // A HELD-STEADY intent, not a continuously varying one: with a changing
    // steer signal, the authority's latency-held copy is always behind the
    // client's current real value by ~latency ticks, which is a genuine
    // (non-quantization) physics discrepancy on every comparison - a lag
    // artifact, not noise. Only a truly steady input makes "held stale" and
    // "fresh" the same VALUE, isolating this test to quantization noise,
    // which is what section 8 actually asks for ("a converged client").
    const intent = mkIntent(0.3)

    // 360 ticks (6s) of warm-up, then 600 ticks (10s) measured. 180 ticks was
    // tried and found flaky (1/6 seeds, ~0.06 posdiff against the 0.05
    // epsilon, a few ticks past the boundary) - see this brief's verification
    // note for the empirical margin behind 360.
    const WARMUP_TICKS = 360
    const STEADY_TICKS = 600

    let nowMs = 0
    for (let t = 0; t < WARMUP_TICKS; t++) {
      authority.tick()
      client.tick(intent)
      pair.pump(nowMs)
      nowMs += 1000 / 60
    }
    const baseline = client.corrections()
    const snapshotsAtBaseline = snapshotsSeen()

    for (let t = 0; t < STEADY_TICKS; t++) {
      authority.tick()
      client.tick(intent)
      pair.pump(nowMs)
      nowMs += 1000 / 60
    }

    expect(client.corrections() - baseline).toBe(0)

    // The two controls without which the zero above proves nothing.
    //
    // 1. Snapshots really arrived in the measured window. 600 ticks at one
    //    broadcast every 3 ticks is 200, thinned by the default 5% loss to
    //    ~190 expected; a floor of 140 (70% of expectation) is far below any
    //    plausible run and far above the silence a broken transport produces.
    //    A client that received nothing also reports zero corrections, and
    //    that is precisely the failure this test existed to catch.
    const steadySnapshots = snapshotsSeen() - snapshotsAtBaseline
    expect(
      steadySnapshots,
      `only ${steadySnapshots} snapshots reached the client in the steady window; a count near zero means the transport delivered nothing and the zero-corrections assertion is vacuous, not a pass`,
    ).toBeGreaterThanOrEqual(140)

    // 2. The client is still on the same kart in the same race. See the
    //    reconciliation test above for why this band is not EPS: the epsilon
    //    claim is about the comparison at snap.tick, which the zero above
    //    already asserts, and both loops here are the same tick number but not
    //    the same instant of information.
    const mine = client.state().karts[OWN]
    const theirs = authority.state().karts[OWN]
    expect(Math.abs(mine.position.x - theirs.position.x)).toBeLessThan(0.5)
    expect(Math.abs(mine.position.z - theirs.position.z)).toBeLessThan(0.5)
    expect(Math.abs(mine.velocity.x - theirs.velocity.x)).toBeLessThan(1.0)
    expect(Math.abs(mine.velocity.z - theirs.velocity.z)).toBeLessThan(1.0)
  }, 30000)
})
```

- [ ] **Step 17: Run the test to verify it passes**

Run: `npx vitest run packages/net/test/client.test.ts`

Expected: PASS — 12 tests total, this one taking under a second of wall-clock
time despite simulating 960 ticks (16s of race time) — `pump()` advances a
caller-supplied `nowMs`, there is no real sleeping. This test was run, with
this exact implementation, against real `packages/sim` and a functional
(quantizing, non-bit-packed) protocol stand-in **15 times across different
`LoopbackOptions.seed` values, including the contract's own default
`0xC0FFEE` three times**, all clean, before this brief was finalized — see
the verification note above. If this is red here, the two most likely causes,
in order of likelihood given what already broke it once: the reconciliation
anchor silently reverted to `lastProcessedInputTick` (re-read this brief's
verification note item 1, do not revert it back), or the decode target lost
its ping-pong double-buffering (item 2).

- [ ] **Step 18: Typecheck and run the full net suite**

Run: `npx tsc --noEmit -p packages/net/tsconfig.json && npx vitest run packages/net`

Expected: PASS, zero type errors, every `net` test green (this task's 12 plus
Tasks 11–14's).

- [ ] **Step 19: Commit**

```bash
git add packages/net/src/client.ts packages/net/test/client.test.ts
git commit -m "feat(net): ClientLoop, prediction and reconciliation

Only the local kart is predicted: the other seven seats are driven by
the sim's own bot AI (never trusted, never rendered) because step() has
no partial-seat entry point. A 128-tick ring buffer of (tick, raw
input, checkpoint, appliedEvents) backs reconciliation; on a diverging
WireSnapshot the client rewinds to the matching checkpoint, overwrites
its own kart with the dequantized authoritative value, and replays
every buffered input and every applied event forward to the present
frame.

The reconciliation anchor is snap.tick, not lastProcessedInputTick as
a literal reading of spec section 5 suggests - verified end-to-end
against real packages/sim before writing this brief that the literal
reading fails the zero-corrections invariant by a wide, non-quantization
margin, because a WireSnapshot's kart data describes snap.tick, not
lastProcessedInputTick (a separate, laggier number under real latency).
Comparing at snap.tick is physically sound without any clock-offset
handshake because a held-steady local input makes 'stale held value'
and 'fresh value' the same number, isolating the comparison to
quantization noise - exactly what the zero-corrections test needs.
Also fixed in the same pass: a stale out-of-order snapshot decode must
never clobber an already-pending fresher one (ping-ponged decode
targets), and events applied outside step() must be replayed again
during reconciliation or a granted item silently reverts.

corrections() is the zero-corrections test's instrument; state() is the
locked contract's read-only view of the predicted SimState, which is
what lets the same tests assert convergence positively instead of
inferring it from a counter that a dead transport also zeroes. Every
datagram carries protocol's shared 2-byte header: input goes out
through encodeHeader, and onMessage dispatches on decodeHeader(data).kind
rather than assuming everything unreliable is a snapshot. Granted
items and other authoritative events are applied to the local kart the
instant they arrive, never predicted - spec section 5, 'the local
kart's hit reaction plays on receipt, not on prediction.'

RemoteInterpolator (100ms render delay, 8-keyframe buffer, 200ms
extrapolation cap) is now wired to ClientLoop's own incoming snapshot
stream: onMessage pushes every newly-accepted snapshot's karts into it,
timestamped by this loop's own tick counter (no Date.now() anywhere in
this file). Remote karts and entities are never predicted; they were
previously interpolated in isolation with nothing feeding them.
remoteInterpolatorOf(client), a free function backed by a private
WeakMap, is the accessor - not a fifth method on ClientLoop, which
contract §5 locks at exactly four members. Wiring the *output* to an
actual renderer remains a later plan's job (render/game does not exist
in this repo yet); wiring the *input*, which needed nothing outside
this package, is this commit's."
```

---

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

---

### Task 17: The netcode integration tests

**Files:**
- Create: `packages/net/test/fixtures/scripted-input.ts`
- Create: `packages/net/test/fixtures/spy-transport.ts`
- Test: `packages/net/test/convergence.test.ts`
- Test: `packages/net/test/promotion.test.ts`
- Test: `packages/net/test/latejoin.test.ts`

**Why these three and no others.** Spec §8's `net` row names exactly three approaches, and this plan's
whole point is netcode correctness, so each gets its own file with thousands of simulated ticks, not
a smoke test:

1. `LoopbackTransport` at 150ms latency, 50ms jitter, 5% loss: client converges and stays within
   epsilon; steady-state quantization noise triggers **zero** corrections.
2. **Promotion**: kill the host mid-race; the shadow's state matches the host's last checkpoint
   within bounds; no lap counter regresses; no entity disappears; no event is applied twice.
3. A late-join test exercising `AuthorityCheckpoint`.

**These tests assert on real state, through the locked accessors.** Contract §5 gives
`AuthorityLoop` and `ClientLoop` a `state(): SimState` each, annotated in the contract itself with
why they exist: *"read-only view, so the promotion test can compare authorities"* and *"read-only
view; the convergence test asserts on it directly."* An earlier draft of this brief was written
against a three-member `ClientLoop` and a two-member `AuthorityLoop`, and every workaround it grew
is deleted here: Test 1 no longer argues that `corrections()` is an acceptable proxy for a state
comparison — it does both — and Test 2 no longer hand-rolls a `makeFakeHost()` out of `step()` and
raw encoders. Test 2 drives a **real `AuthorityLoop`** against a **real `ShadowLoop`**, which is the
only version of that test that can fail when `AuthorityLoop` is broken.

**The one topology compromise, stated rather than hidden.** Spec §5 has every client sending its
input to *both* the host and the server shadow. `makeLoopbackPair` (Task 12) is a **pair**: a
message broadcast on side `a` is delivered to side `b` and vice versa, so three parties cannot share
one bus. Test 2 therefore places the host on `a`, the shadow on `b`, and has the test itself
broadcast the same scripted input datagram on **both** sides at 30 Hz — side `b` so the host
receives it, side `a` so the shadow does. That is the dual-send spec §5 describes, minus a real
third peer. A genuine three-party transport is not in this plan's module map (contract §5 lists
`transport.ts` and `loopback.ts` and nothing else), so this is a knowing limitation, not an
oversight, and it is repeated in the flagged-ambiguities list at the bottom of this brief.

**Interfaces:**

Consumes (exact signatures):

```ts
// @tapkart/sim (barrel — Plan 1, fully shipped)
export const MAX_KARTS = 8
export function createState(ctx: SimContext, seed: number, characterIdx: number[]): SimState
export function step(ctx: SimContext, prev: SimState, next: SimState, inputs: Intent[], events: AuthEvent[]): void
export function statesEqual(a: SimState, b: SimState): boolean
export function makeIntentBuffer(): Intent[]

// packages/net/src/shadow.ts                                  [Task 16, this plan]
export const HOST_TIMEOUT_TICKS = 90
export const SNAPSHOT_PERIOD_TICKS = 3
export function decodeAuthorityChange(buf: Uint8Array): { tick: number; eventSeq: number }
export class ShadowLoop { constructor(ctx: SimContext, state: SimState, t: Transport); tick(): void; promote(tick: number): void }

// packages/net/src/transport.ts                               [Task 11]
export interface Transport { send(...): void; broadcast(...): void; onMessage(...): void; onPeerLost(...): void; peers(): string[]; close(): void }

// packages/net/src/authority.ts                               [Task 14]
export class AuthorityLoop { constructor(ctx: SimContext, state: SimState, t: Transport); tick(): void; state(): SimState }

// packages/net/src/client.ts                                  [Task 15]
export class ClientLoop { constructor(ctx: SimContext, playerId: number, t: Transport); tick(localIntent: Intent): void; corrections(): number; state(): SimState }

// packages/net/test/fixtures/net-fixtures.ts                  [Task 12]
export function makeNetContext(isLeader?: boolean): SimContext
export function makeLossyPair(overrides?: Partial<LoopbackOptions>): { a: Transport; b: Transport; pump(nowMs: number): void }
// Default LoopbackOptions: { latencyMs: 150, jitterMs: 50, lossRate: 0.05, seed: 0xC0FFEE }

// @tapkart/protocol — the bare specifier, never a relative path into
// ../../protocol/src/*. Contract §3: the barrel exists from Task 3, and
// "net imports @tapkart/protocol, always."
export type ChannelName = 'unreliable' | 'reliable'
export type MessageKind = 'hello' | 'welcome' | 'lobby' | 'start' | 'input' | 'snapshot'
                        | 'events' | 'checkpoint' | 'authorityChange' | 'ping' | 'pong'
export const WIRE_TAG: { readonly [K in MessageKind]: number }
export function encodeHeader(out: Uint8Array, kind: MessageKind): number  // 2 bytes, returns 2
export function decodeHeader(buf: Uint8Array): WireHeader                 // throws on unknown tag
export const EPS: EpsilonTable            // six keys: position, velocity, heading,
                                          // angularVelocity, driftCharge, t
export function encodeInput(out: Uint8Array, playerId: number, intents: Intent[]): number
export const INPUT_REDUNDANCY = 8
export function encodeCheckpoint(out: Uint8Array, state: SimState): number
export function decodeCheckpoint(buf: Uint8Array, dst: SimState): void
```

Buffer sizes used below, derived rather than copied:

- **Snapshot: 1024 B.** Contract §4's worst case is `8 × 178` kart bits `+ 32 × 135` entity bits
  `+ 200` header bits `= 5944 bits = 743 B`, plus the 2-byte message header. `BitWriter` overflows
  *silently* (a typed-array write past the end is a no-op), so this figure is computed, not guessed.
- **Checkpoint: 8192 B.** Task 8 asserts `encodeCheckpoint` returns **5384** for this `SimState`
  shape. `DataView.setFloat64` past the end throws `RangeError`, so an undersized buffer here fails
  loudly — an earlier draft of this brief used 4096 and would have thrown on the first call.

Produces:

```ts
// packages/net/test/fixtures/scripted-input.ts
export function scriptedIntent(tick: number, playerId: number): Intent
export function broadcastScriptedInput(t: Transport, playerId: number, tick: number): void

// packages/net/test/fixtures/spy-transport.ts
export function spyTransport(inner: Transport, onEach: (peerId: string, channel: ChannelName, data: Uint8Array) => void): Transport
```

---

#### Fixture 1: deterministic scripted input

- [ ] **Step 1: Write the failing test**

Create a throwaway check inline — this fixture has no dedicated spec file (it is exercised by the
three integration suites below), so its correctness is proven by Step 2's failure and Step 3's
compile, matching how Plan 1's `track-fixtures.ts` [Task 3] is untested directly and is instead
exercised by everything that imports it. Skip straight to Step 2.

- [ ] **Step 2: Confirm scripted-input.ts does not exist**

Run: `test -f packages/net/test/fixtures/scripted-input.ts && echo EXISTS || echo MISSING`
Expected: `MISSING`.

- [ ] **Step 3: Write the fixture**

Create `packages/net/test/fixtures/scripted-input.ts`:

```ts
// Deterministic per-tick input for kart 0, shared by every integration test in this plan so a
// reference run and a networked run always agree bit-for-bit on "what the player did."
import type { Intent } from '@tapkart/sim'
import type { ChannelName } from '@tapkart/protocol'
import { INPUT_REDUNDANCY, encodeHeader, encodeInput } from '@tapkart/protocol'

/**
 * Smooth low-frequency sine steer, constant half-throttle, a brief periodic drift tap. No
 * `Math.random()` anywhere: two independent callers computing `scriptedIntent(tick, playerId)` for
 * the same arguments always agree, which is what makes a same-process reference run meaningful.
 *
 * NOT used by the convergence test. A varying steer signal puts the authority's latency-held copy
 * behind the client's current value by ~one one-way trip, which is a real physics difference and
 * not quantization noise - Task 15 measured exactly that and settled on a held-steady intent for
 * the zero-corrections invariant. This function is for the promotion and late-join tests, where
 * what matters is that two peers agree on a non-trivial trajectory, not that the trajectory is
 * noise-free.
 */
export function scriptedIntent(tick: number, playerId: number): Intent {
  const phase = tick / 97 + playerId
  return {
    tick,
    steer: Math.sin(phase) * 0.6,
    accel: 0.5,
    brake: false,
    drift: tick % 240 < 40,
    useItem: false,
  }
}

/**
 * Encodes the redundant window ending at `tick` (spec S5: "each datagram carrying the last 8
 * intents") behind the contract's shared 2-byte header and broadcasts it. Before `tick >=
 * INPUT_REDUNDANCY - 1`, the window is padded by repeating the earliest available intent, which is
 * harmless: every entry in the padded region is identical to what `scriptedIntent` would compute
 * for that tick anyway.
 *
 * The header is `encodeHeader(buf, 'input')` - protocol's, shared with AuthorityLoop, ClientLoop
 * and ShadowLoop. An earlier draft of this fixture wrote a private tag byte imported from
 * `../../src/shadow`, which no other loop in the plan wrote or read.
 */
export function broadcastScriptedInput(
  t: { broadcast(channel: ChannelName, data: Uint8Array): void },
  playerId: number,
  tick: number,
): void {
  const intents: Intent[] = []
  const first = Math.max(0, tick - INPUT_REDUNDANCY + 1)
  for (let ti = first; ti <= tick; ti++) intents.push(scriptedIntent(ti, playerId))
  while (intents.length < INPUT_REDUNDANCY) intents.unshift(scriptedIntent(first, playerId))
  const buf = new Uint8Array(256)
  const h = encodeHeader(buf, 'input')
  const n = encodeInput(buf.subarray(h), playerId, intents)
  t.broadcast('unreliable', buf.slice(0, h + n))
}
```

- [ ] **Step 4: Confirm it compiles**

Run: `npx tsc --noEmit -p packages/net`
Expected: PASS. (No test imports it yet; this only proves the file itself type-checks against
`INPUT_REDUNDANCY`/`encodeInput`/`encodeHeader`'s real shapes.)

#### Fixture 2: transport spy

- [ ] **Step 5: Write the fixture**

Create `packages/net/test/fixtures/spy-transport.ts`:

```ts
// Wraps a real Transport so a test can observe every message that flows through it without
// contending with whatever the code under test (ClientLoop, ShadowLoop) separately registers via
// its own onMessage call. `onEach` fires for every message before the wrapped user callback does;
// `onMessage` on the returned Transport is what the code under test registers against, so exactly
// one real listener is ever attached to `inner`, regardless of how many times this wrapper's own
// onMessage is (re)called.
//
// `ChannelName` comes from @tapkart/protocol, not from ../../src/transport: transport.ts imports
// that type but never re-exports it, so naming it there is TS2305 ("has no exported member").
import type { ChannelName } from '@tapkart/protocol'
import type { Transport } from '../../src/transport'

export function spyTransport(
  inner: Transport,
  onEach: (peerId: string, channel: ChannelName, data: Uint8Array) => void,
): Transport {
  let userCb: ((peerId: string, channel: ChannelName, data: Uint8Array) => void) | null = null
  inner.onMessage((peerId, channel, data) => {
    onEach(peerId, channel, data)
    userCb?.(peerId, channel, data)
  })
  return {
    send: (c, p, d) => inner.send(c, p, d),
    broadcast: (c, d) => inner.broadcast(c, d),
    onMessage: (cb) => { userCb = cb },
    onPeerLost: (cb) => inner.onPeerLost(cb),
    peers: () => inner.peers(),
    close: () => inner.close(),
  }
}
```

- [ ] **Step 6: Confirm it compiles**

Run: `npx tsc --noEmit -p packages/net`
Expected: PASS.

---

#### Test 1: convergence and zero steady-state corrections

**What "converged, within epsilon" means here, stated before it is used.** Two claims, asserted
two different ways:

1. **Zero steady-state corrections.** Per spec §5/§8, `corrections()` increments *if and only if*
   some field of the client's own kart, compared against the just-arrived authoritative value at
   `snap.tick`, exceeded its contract §4 epsilon. A zero delta across a long window therefore *is*
   the epsilon claim, not a proxy for it. But it is also what a client that received nothing
   reports, which is why this test counts the snapshots that actually arrived in the measured
   window and fails on a floor.
2. **The client is genuinely on the authority's kart.** `client.state()` and `host.state()` are
   both locked accessors (contract §5), so this test compares them directly at the end of the run.
   The tolerance for that comparison is deliberately looser than `EPS`: both loops are at the same
   tick number but not the same instant of information — the client's present tick is the
   authority's state at `snap.tick` replayed forward — so the epsilon-tight claim belongs to (1),
   at the instant (1) compares, and this comparison exists to catch the metre-scale failures a
   counter cannot see.

Warm-up corrections are *allowed* to be nonzero and are not asserted either way: a client that
never needed to correct even in the first second is the best case, not a failure.

**This test's setup mirrors Task 15's Step 12 exactly, and not by coincidence.** Task 15 built a
working prototype of this same invariant and measured four things this brief originally got wrong,
every one of which manufactures a correction that has nothing to do with quantization:

- **`CHARS8 = [0,0,0,0,0,0,0,0]`,** because `ClientLoop` bootstraps its own state with
  `characterIdx` all zero (no lobby handshake exists in this plan). A host built with
  `[0,1,2,…,7]` runs seats 1–7 on *different* `CharacterStats`, their bot trajectories diverge, and
  a bot eventually collides with kart 0 — a real physics difference the epsilon test would blame on
  quantization.
- **`hostState.phase = 'racing'`,** because `ClientLoop`'s constructor sets its own phase to
  `'racing'`. Left in `'countdown'`, `resolveInputs` freezes every host kart for
  `COUNTDOWN_TICKS = 180` ticks while the client drives.
- **`isBot = false` / `connected = true` on seat 0 of the host**, because `createState` defaults
  every kart to `isBot: true, connected: false` (`packages/sim/src/state.ts:60-61`) and
  `resolveInputs` routes any such kart through bot AI — so the authority would ignore the client's
  input entirely and correct on every single snapshot.
- **Item boxes neutralised**, because an `itemGrant` travels the reliable channel independently of
  the unreliable snapshot stream and can arrive on either side of a snapshot that already reflects
  it. That is a timing difference, not noise.

And a **held-steady intent** with `WARMUP_TICKS = 360`: Task 15 measured a varying steer as a
genuine, non-quantization discrepancy (the authority's held copy lags the client's current value by
a one-way trip), and measured 180 warm-up ticks as flaky at 1 run in 6 — 0.057 position difference
against a 0.05 epsilon, a few ticks past the boundary. This brief originally used `scriptedIntent`
and 180. Both are corrected here. **Do not reintroduce either.**

- [ ] **Step 7: Write the failing test**

Create `packages/net/test/convergence.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import type { Intent } from '@tapkart/sim'
import { createState } from '@tapkart/sim'
import { decodeHeader } from '@tapkart/protocol'
import { makeLossyPair, makeNetContext } from './fixtures/net-fixtures'
import { spyTransport } from './fixtures/spy-transport'
import { SNAPSHOT_PERIOD_TICKS } from '../src/shadow'
import { AuthorityLoop } from '../src/authority'
import { ClientLoop } from '../src/client'

const SEED = 0x20260814
/** All-zero, matching ClientLoop's own bootstrap — see this section's preamble. */
const CHARS8 = [0, 0, 0, 0, 0, 0, 0, 0]
const TICK_MS = 1000 / 60
const OWN = 0

/** 6s. Task 15 measured 180 as flaky for this exact invariant (1 run in 6, 0.057 position
 *  difference against a 0.05 epsilon a few ticks past the boundary) and settled on 360. */
const WARMUP_TICKS = 360
/** 60s total, thousands of ticks, per this task's brief. */
const RUN_TICKS = 3600

/**
 * Expected snapshot arrivals in the steady window: (RUN_TICKS - WARMUP_TICKS) / SNAPSHOT_PERIOD_TICKS
 * datagrams broadcast, independently thinned by the default 5% loss rate. The exact count is
 * deterministic (LoopbackOptions.seed = 0xC0FFEE), but computing it exactly would require depending
 * on Task 12's internal RNG-consumption pattern; asserting a generous lower bound instead
 * (70% of the loss-adjusted expectation) still fails hard if the transport is silently broken.
 * (3600-360)/3 = 1080 broadcasts, x0.95 = 1026 expected, x0.7 = 718.
 */
const EXPECTED_STEADY_SNAPSHOTS = Math.floor(((RUN_TICKS - WARMUP_TICKS) / SNAPSHOT_PERIOD_TICKS) * 0.95)
const MIN_STEADY_SNAPSHOTS = Math.floor(EXPECTED_STEADY_SNAPSHOTS * 0.7)

/** Held steady for the whole run: with a constant intent, "the value the authority is still
 *  holding from N ticks ago" and "the value the client is sending now" are the same number, so the
 *  comparison is isolated to quantization noise. See this section's preamble. */
const STEADY: Intent = { tick: 0, steer: 0.3, accel: 1, brake: false, drift: false, useItem: false }

describe('convergence at 150ms/50ms/5% (spec S8)', () => {
  it(
    'the client takes zero corrections in steady state, and snapshots actually arrived',
    () => {
      const ctxHost = makeNetContext(true)
      const ctxClient = makeNetContext(false)
      const hostState = createState(ctxHost, SEED, CHARS8)
      // Every one of these four lines removes a manufactured correction. See preamble.
      hostState.phase = 'racing'
      hostState.karts[OWN].isBot = false
      hostState.karts[OWN].connected = true
      for (const box of hostState.itemBoxes) box.respawnTicks = 1_000_000

      const pair = makeLossyPair() // default: 150ms latency, 50ms jitter, 5% loss, seed 0xC0FFEE

      let steadySnapshots = 0
      const clientSideTransport = spyTransport(pair.b, (_peerId, channel, data) => {
        // decodeHeader, not data[0]: the first payload byte of a bit-packed
        // snapshot is the low byte of state.tick and matches any given constant
        // about once every 256 snapshots.
        if (channel === 'unreliable' && decodeHeader(data).kind === 'snapshot') steadySnapshots++
      })

      const host = new AuthorityLoop(ctxHost, hostState, pair.a)
      const client = new ClientLoop(ctxClient, OWN, clientSideTransport)

      const clientStartX = client.state().karts[OWN].position.x
      const clientStartZ = client.state().karts[OWN].position.z

      let settleCount = -1
      let nowMs = 0
      let snapshotsAtWarmup = 0

      for (let t = 0; t < RUN_TICKS; t++) {
        host.tick()
        client.tick(STEADY)
        pair.pump(nowMs)
        nowMs += TICK_MS

        if (t === WARMUP_TICKS - 1) {
          settleCount = client.corrections()
          snapshotsAtWarmup = steadySnapshots
        }
      }

      const steadyCorrections = client.corrections() - settleCount
      expect(steadyCorrections, 'client took a correction after the settle window, from quantization noise alone').toBe(0)

      const snapshotsInSteadyWindow = steadySnapshots - snapshotsAtWarmup
      expect(
        snapshotsInSteadyWindow,
        `only ${snapshotsInSteadyWindow} snapshots reached the client in the steady window; expected >= ${MIN_STEADY_SNAPSHOTS}. A count near zero means the transport delivered nothing and the zero-corrections assertion above is vacuous, not a pass.`,
      ).toBeGreaterThanOrEqual(MIN_STEADY_SNAPSHOTS)

      // Both loops really ran, and the race really happened: the host reached
      // every tick, and the client's own kart travelled a long way from where
      // createState put it. Comparing against the kart's OWN start position,
      // not against the origin - seat 0 starts at the oval's first control
      // point, (-200, ., -100), so `|x| + |z| > 1` is 300 before a tick runs.
      expect(host.state().tick).toBe(RUN_TICKS)
      expect(client.state().tick).toBe(RUN_TICKS)
      const travelled = Math.hypot(
        client.state().karts[OWN].position.x - clientStartX,
        client.state().karts[OWN].position.z - clientStartZ,
      )
      expect(travelled, 'the client never moved, so "converged" is meaningless').toBeGreaterThan(50)

      // And the client converged onto the AUTHORITY's kart, not merely onto
      // some self-consistent trajectory of its own. Band, not EPS - see the
      // preamble for why the two questions take different tolerances.
      const mine = client.state().karts[OWN]
      const theirs = host.state().karts[OWN]
      expect(Math.abs(mine.position.x - theirs.position.x)).toBeLessThan(0.5)
      expect(Math.abs(mine.position.z - theirs.position.z)).toBeLessThan(0.5)
      expect(Math.abs(mine.velocity.x - theirs.velocity.x)).toBeLessThan(1.0)
      expect(Math.abs(mine.velocity.z - theirs.velocity.z)).toBeLessThan(1.0)
      // Deliberately no equality assertion on lap/checkpointIdx here: two karts
      // half a metre apart can legitimately sit on opposite sides of a
      // checkpoint line at one arbitrary instant, and a test that flakes on a
      // correct implementation teaches the next reader to widen it.
    },
    30_000,
  )
})
```

- [ ] **Step 8: Run the test and confirm the RED**

Run: `npx vitest run packages/net/test/convergence.test.ts`
Expected: FAIL with `TypeError: AuthorityLoop is not a constructor` (or `ClientLoop is not a
constructor`, whichever import Vitest's SSR transform reaches first) — neither Task 14 nor Task 15
has shipped when this brief is written, but by the time this task actually *executes* both exist
(they are Tasks 14–15, before this Task 17). If this instead fails with a resolution error naming
`./fixtures/net-fixtures`, `../src/authority` or `../src/client` as unresolvable, that names a real
missing dependency from an earlier task — stop and fix the earlier task, this brief does not own
those files.

- [ ] **Step 9: Run to confirm the GREEN**

Run: `npx vitest run packages/net/test/convergence.test.ts`
Expected: PASS — 1 test (it is intentionally one large scenario; splitting the assertions into
separate `it` blocks would require re-running the whole 3600-tick loop per assertion for no benefit).
If `steadyCorrections` is nonzero, the failure names the exact count
(`expected X to be 0`), which is a real defect: either an epsilon in `protocol/src/quant.ts` was
tuned below its step (contract §4/Task 7's job to prevent), or `ClientLoop`'s reconciliation logic
has a bug that fires on noise. Do not lower this test's expectation to make it pass.

---

#### Test 2: promotion

- [ ] **Step 10: Write the failing test**

Create `packages/net/test/promotion.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import type { AuthEvent, SimState } from '@tapkart/sim'
import { MAX_KARTS, createState } from '@tapkart/sim'
import { decodeEvents, decodeHeader } from '@tapkart/protocol'
import { makeLossyPair, makeNetContext } from './fixtures/net-fixtures'
import { broadcastScriptedInput } from './fixtures/scripted-input'
import { spyTransport } from './fixtures/spy-transport'
import { HOST_TIMEOUT_TICKS, SNAPSHOT_PERIOD_TICKS, ShadowLoop, decodeAuthorityChange } from '../src/shadow'
import { AuthorityLoop } from '../src/authority'
import { applyEvent } from '../src/apply'

const SEED = 0x20260814
const CHARS8 = [0, 0, 0, 0, 0, 0, 0, 0]
const TICK_MS = 1000 / 60
const OWN = 0
/** encodeHeader writes tag + protocolVersion; locked contract §3 fixes it at 2. */
const HEADER_BYTES = 2

/**
 * "Matches within bounds" is a metre-scale claim, not an epsilon-scale one, and the difference is
 * load-bearing. The shadow's state at tick T is the host's state at T-minus-one-one-way-trip,
 * corrected and replayed forward with input that arrived on a different schedule; contract §4's
 * 0.05 m epsilon describes the comparison the RECONCILER makes at snap.tick, not the residue two
 * independently-scheduled loops carry at the same tick number. 5 m is the band this test asserts:
 * far tighter than the ~30 m a kart covers in the second before the kill (so a shadow that stopped
 * tracking fails), and far looser than any legitimate scheduling residue (so a correct one does
 * not flake).
 */
const MATCH_BAND_M = 5.0

/**
 * A live entity that cannot legitimately disappear, seeded identically into both authorities.
 *
 * Spec §8 asks the promotion test to prove "no entity disappears", and the only entity whose
 * disappearance is unambiguously a bug is one that can neither expire nor be struck: `slick` sits
 * still and only its ttl moves (`entity.ts`'s stepEntity default branch), a ttl far longer than the
 * run can never reach zero, and at (500, 0, 500) it is hundreds of metres outside the oval, so its
 * 2.1 m strike radius can never fire. Items the bots pick up will spawn and despawn other entities
 * legitimately during this run - those are NOT watched, precisely because a seeker that hits a kart
 * is supposed to vanish.
 *
 * Written directly into the pool rather than through spawnEntity() because spawnEntity emits an
 * 'entitySpawn', which after Task 2 is gated on ctx.isLeader - so seeding the leader and the
 * follower through it would leave them with different nextEventSeq before the race even starts.
 */
const WATCHED_ID = 4242
const WATCHED_TTL = 60_000

function seedWatchedEntity(state: SimState): void {
  const e = state.entities[state.entityCount]
  e.entityId = WATCHED_ID
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
  e.ttl = WATCHED_TTL
  state.entityCount += 1
  state.nextEntityId = Math.max(state.nextEntityId, WATCHED_ID + 1)
}

function watchedIn(state: SimState): { entityId: number; ttl: number } | undefined {
  for (let i = 0; i < state.entityCount; i++) {
    if (state.entities[i].entityId === WATCHED_ID) return state.entities[i]
  }
  return undefined
}

/** Both authorities start from the identical world, which is what makes "matches" meaningful. */
function makeRaceState(ctx: ReturnType<typeof makeNetContext>): SimState {
  const s = createState(ctx, SEED, CHARS8)
  s.phase = 'racing'
  s.karts[OWN].isBot = false
  s.karts[OWN].connected = true
  for (const k of s.karts) k.lap.lap = 1   // nonzero: "lap >= 0" cannot fail, "lap >= 1" can
  seedWatchedEntity(s)
  return s
}

describe('promotion (spec S5, S8)', () => {
  it(
    'the shadow auto-promotes after the host goes silent, with no rewind, no lost entities, no lap regression',
    () => {
      const hostCtx = makeNetContext(true)
      const shadowCtx = makeNetContext(false)
      const hostState = makeRaceState(hostCtx)
      const shadowState = makeRaceState(shadowCtx)
      const pair = makeLossyPair()

      // The spy goes on side A - the HOST's side. ShadowLoop.promote() broadcasts
      // through its own transport on side B, and the loopback routes b -> a, so a
      // spy on the shadow's own receive path never sees the message it sends.
      const authorityChanges: { tick: number; eventSeq: number }[] = []
      const hostTransport = spyTransport(pair.a, (_peerId, channel, data) => {
        if (channel === 'reliable' && decodeHeader(data).kind === 'authorityChange') {
          authorityChanges.push(decodeAuthorityChange(data))
        }
      })

      // ...and a second spy on side B records the events the shadow actually
      // received, so "the shadow applied the host's event stream" is checkable
      // rather than assumed.
      let highestEventSeqSeen = -1
      let eventMessagesSeen = 0
      const shadowTransport = spyTransport(pair.b, (_peerId, channel, data) => {
        if (channel !== 'reliable' || decodeHeader(data).kind !== 'events') return
        eventMessagesSeen++
        const out: AuthEvent[] = []
        decodeEvents(data.subarray(HEADER_BYTES), out)
        for (const ev of out) highestEventSeqSeen = Math.max(highestEventSeqSeen, ev.eventSeq)
      })

      const host = new AuthorityLoop(hostCtx, hostState, hostTransport)
      const shadow = new ShadowLoop(shadowCtx, shadowState, shadowTransport)
      const hostStart = {
        x: hostState.karts[OWN].position.x,
        z: hostState.karts[OWN].position.z,
      }

      const PRE_KILL_TICKS = 300 // 5s: host is alive and feeding the shadow
      const POST_KILL_TICKS = 300 // 5s: host is silent; promotion happens in here

      let nowMs = 0
      let lastMatchedTick = -1
      let hostAtMatch: SimState | null = null
      let shadowAtMatch: SimState | null = null

      const lapMax = shadowState.karts.map((k) => k.lap.lap)
      let watchedTtl = watchedIn(shadowState)!.ttl

      for (let t = 0; t < PRE_KILL_TICKS; t++) {
        // Spec S5: every client sends its input to BOTH the host and the shadow.
        // One loopback pair cannot carry three parties, so the test plays the
        // client on both sides at 30 Hz - side b reaches the host, side a
        // reaches the shadow. See this brief's topology note.
        if (t % 2 === 0) {
          broadcastScriptedInput(pair.b, OWN, t)
          broadcastScriptedInput(pair.a, OWN, t)
        }
        host.tick()
        pair.pump(nowMs)
        nowMs += TICK_MS
        shadow.tick()

        for (let k = 0; k < MAX_KARTS; k++) {
          expect(shadowState.karts[k].lap.lap, `lap regressed for kart ${k} at tick ${t}`).toBeGreaterThanOrEqual(lapMax[k])
          lapMax[k] = shadowState.karts[k].lap.lap
        }
        const w = watchedIn(shadowState)
        expect(w, `watched entity vanished from the shadow at tick ${t}, ttl ${watchedTtl} last seen`).toBeDefined()
        expect(w!.ttl, `watched entity ttl jumped at tick ${t}`).toBe(watchedTtl - 1)
        watchedTtl = w!.ttl

        // Capture the last tick on which both authorities were on the SAME tick
        // number. The condition is only about the clock, never about agreement -
        // an earlier draft selected the instant by comparing kart 0's position
        // within epsilon and then "asserted" that same comparison afterwards,
        // which cannot fail by construction.
        if (shadowState.tick === host.state().tick) {
          lastMatchedTick = shadowState.tick
          hostAtMatch = structuredClone(host.state())
          shadowAtMatch = structuredClone(shadowState)
        }
      }

      // Both loops advance exactly one tick per call from the same starting
      // tick, so the same-tick condition holds on every iteration and the last
      // capture is the last pre-kill tick. Asserting the exact number rather
      // than "> 0" is what makes a loop that skipped or double-stepped a
      // failure here instead of a silently earlier snapshot.
      expect(lastMatchedTick, 'the two authorities desynchronised before the kill').toBe(PRE_KILL_TICKS)
      expect(hostAtMatch).not.toBeNull()
      expect(shadowAtMatch).not.toBeNull()
      const hostAtKill = hostAtMatch as SimState
      const shadowAtKill = shadowAtMatch as SimState

      // The shadow really was following the host's event stream, not just its
      // snapshots: a follower's nextEventSeq advances ONLY by applying received
      // events (contract §1b), so this equality is only reachable by applying
      // every one of them, and applying none leaves it at 0.
      if (eventMessagesSeen > 0) {
        expect(shadowState.nextEventSeq).toBe(highestEventSeqSeen + 1)
      }

      for (let t = 0; t < POST_KILL_TICKS; t++) {
        // The host is dead: no host.tick(), and nothing is broadcast on side b
        // any more. The client keeps feeding the shadow, which is exactly what
        // spec S5's dual send buys.
        if (t % 2 === 0) broadcastScriptedInput(pair.a, OWN, PRE_KILL_TICKS + t)
        pair.pump(nowMs)
        nowMs += TICK_MS
        shadow.tick()

        for (let k = 0; k < MAX_KARTS; k++) {
          expect(shadowState.karts[k].lap.lap, `lap regressed for kart ${k} post-kill tick ${t}`).toBeGreaterThanOrEqual(lapMax[k])
          lapMax[k] = shadowState.karts[k].lap.lap
        }
        // "No entity disappears", asserted rather than reasoned about. The
        // watched entity cannot expire (ttl 60000) and cannot be struck
        // (unreachable position), so it has no legal way to leave the pool -
        // through the promotion tick or any other. Its ttl must also walk down
        // by exactly one per tick, which is what catches a promotion that
        // rebuilt state from an older buffer instead of continuing forward.
        const w = watchedIn(shadowState)
        expect(w, `watched entity vanished post-kill at tick ${t}, ttl ${watchedTtl} last seen`).toBeDefined()
        expect(w!.ttl, `watched entity ttl jumped post-kill at tick ${t}`).toBe(watchedTtl - 1)
        watchedTtl = w!.ttl
      }

      expect(authorityChanges).toHaveLength(1)
      // Promotion fires HOST_TIMEOUT_TICKS after the LAST snapshot the shadow actually received,
      // which — given the loopback's latency and the host's own last broadcast before falling
      // silent — lands within a small, bounded window of PRE_KILL_TICKS + HOST_TIMEOUT_TICKS.
      expect(authorityChanges[0].tick).toBeGreaterThanOrEqual(PRE_KILL_TICKS)
      expect(authorityChanges[0].tick).toBeLessThan(PRE_KILL_TICKS + HOST_TIMEOUT_TICKS + SNAPSHOT_PERIOD_TICKS + 5)
      expect(shadowCtx.isLeader, 'the shadow never actually switched to leader mode').toBe(true)

      // "Matches the host's last checkpoint within bounds" (spec S8), asserted
      // between the SHADOW's captured state and the HOST's captured state, at
      // the same tick. Every kart, both horizontal axes.
      expect(shadowAtKill.tick).toBe(hostAtKill.tick)
      for (let k = 0; k < MAX_KARTS; k++) {
        const s = shadowAtKill.karts[k]
        const h = hostAtKill.karts[k]
        expect(
          Math.abs(s.position.x - h.position.x),
          `kart ${k} x diverged by more than ${MATCH_BAND_M}m at tick ${hostAtKill.tick}`,
        ).toBeLessThan(MATCH_BAND_M)
        expect(
          Math.abs(s.position.z - h.position.z),
          `kart ${k} z diverged by more than ${MATCH_BAND_M}m at tick ${hostAtKill.tick}`,
        ).toBeLessThan(MATCH_BAND_M)
      }
      // ...and the world was actually moving, so "within 5 m of each other" is
      // not two frozen grids agreeing about nothing. Seat 0 is the only human
      // seat, so if the shadow never received the client's input it sits at
      // accel 0 while the host drives away - which the band above catches only
      // because this line proves the host drove away at all.
      const hostTravelled = Math.hypot(
        hostAtKill.karts[OWN].position.x - hostStart.x,
        hostAtKill.karts[OWN].position.z - hostStart.z,
      )
      expect(
        hostTravelled,
        'the host kart never moved, so the match assertion is comparing two grids',
      ).toBeGreaterThan(20)
    },
    30_000,
  )

  it('applyEvent never applies the same eventSeq twice', () => {
    const ctx = makeNetContext(false)
    const state = createState(ctx, SEED, CHARS)
    const ev: AuthEvent = { eventSeq: 0, tick: 0, kind: 'itemGrant', playerId: 2, entityId: -1, item: 'boost', data: 0 }

    const first = applyEvent(ctx, state, ev)
    expect(first).toBe(true)
    expect(state.karts[2].item).toBe('boost')

    state.karts[2].item = 'none' // simulate the item being spent between the two deliveries
    const second = applyEvent(ctx, state, ev)
    expect(second, 'applyEvent re-applied an eventSeq it had already seen').toBe(false)
    expect(state.karts[2].item, 'a duplicate delivery must not re-grant the item').toBe('none')
  })
})
```

Note: there is no `require(...)` anywhere in this file. An earlier draft used one inside a
hand-rolled `makeFakeHost` to pull in `encodeInput`, calling it "deliberate CommonJS interop that
Vitest's Node environment supports." Every package here sets `"type": "module"` and Vitest
transforms to ESM, where `require` is not defined at all — it would have thrown
`ReferenceError: require is not defined` on the first host tick. Every import in this file is a
top-level ESM import.

- [ ] **Step 11: Run the test and confirm the RED**

Run: `npx vitest run packages/net/test/promotion.test.ts`
Expected: FAIL with `TypeError: ShadowLoop is not a constructor` if Task 16 has not landed yet in
this working tree, or (once it has) `TypeError: applyEvent is not a function` if Task 13 has not.
By the time this task actually executes, both exist (Tasks 13 and 16 precede Task 17), and the
suite should reach the real assertions.

- [ ] **Step 12: Run to confirm the GREEN**

Run: `npx vitest run packages/net/test/promotion.test.ts`
Expected: PASS — 2 tests. Every assertion in the scripted scenario names what tripped: a lap
regression names the kart and tick, a vanished entity names its id and the ttl it was last seen
with, a ttl jump names the tick, and the match assertion names the kart and the axis. Do not weaken
the `lapMax` seeding, the watched-entity bookkeeping or `MATCH_BAND_M` to make a failure disappear —
each of those was a real assertion added to replace one that could not fail, and the place to trace
a failure is `ShadowLoop.reconcile`/`promote` (Task 16) or `AuthorityLoop.tick` (Task 14), which are
the only places state can move backward or stop tracking.

---

#### Test 3: late join via `AuthorityCheckpoint`

**Design.** `AuthorityCheckpoint` (spec §5) is *"a full-precision serialization of `SimState`"* —
not lossy the way `WireSnapshot` is. That claim is directly testable: `decode(encode(state))` should
equal `state` field-for-field, via the sim's own `statesEqual` (`Object.is` on every field, the same
comparator Plan 1's checkpoint-replay-equivalence test uses). Having proven the round trip is exact,
the second half proves the round trip is *useful*: a state restored from a wire checkpoint, fed the
same subsequent inputs as the source, must continue **bit-identically** — the same "same-process
determinism is both achievable and meaningful" claim spec §8 already establishes for in-memory
checkpoints (Plan 1, Task 16's `replayRun`), now carried across the wire format that a real late
joiner would actually receive.

- [ ] **Step 13: Write the failing test**

Create `packages/net/test/latejoin.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { createState, makeIntentBuffer, statesEqual, step } from '@tapkart/sim'
import { encodeCheckpoint, decodeCheckpoint } from '@tapkart/protocol'
import { makeNetContext } from './fixtures/net-fixtures'
import { scriptedIntent } from './fixtures/scripted-input'

const SEED = 0x20260814
const CHARS = [0, 1, 2, 3, 4, 5, 6, 7]
const PRE_CHECKPOINT_TICKS = 400
const POST_CHECKPOINT_TICKS = 800
/** Task 8 asserts encodeCheckpoint returns 5384 bytes for this SimState shape.
 *  DataView.setFloat64 past the end of the view throws RangeError, so a 4096-byte
 *  buffer - what an earlier draft of this brief used - fails on the first call. */
const CHECKPOINT_BUF_BYTES = 8192

function driveOneTick(ctx: ReturnType<typeof makeNetContext>, cur: ReturnType<typeof createState>, scratch: ReturnType<typeof createState>, tickIndex: number) {
  const inputs = makeIntentBuffer()
  inputs[0] = scriptedIntent(tickIndex, 0)
  step(ctx, cur, scratch, inputs, [])
  return [scratch, cur] as const
}

describe('late join via AuthorityCheckpoint (spec S5, S8)', () => {
  it('encode -> decode reproduces the source SimState exactly, not just approximately', () => {
    const ctx = makeNetContext(true)
    let cur = createState(ctx, SEED, CHARS)
    let scratch = createState(ctx, SEED, CHARS)
    for (let t = 0; t < PRE_CHECKPOINT_TICKS; t++) {
      ;[cur, scratch] = driveOneTick(ctx, cur, scratch, t)
    }

    const buf = new Uint8Array(CHECKPOINT_BUF_BYTES)
    const n = encodeCheckpoint(buf, cur)
    expect(n).toBeGreaterThan(0)

    const decoded = createState(ctx, SEED, CHARS) // preallocates the right shape for decodeCheckpoint
    decodeCheckpoint(buf.subarray(0, n), decoded)

    expect(statesEqual(cur, decoded), 'a full-precision checkpoint must round-trip exactly, per spec S5').toBe(true)
  })

  it('a late joiner restored from the checkpoint tracks the source bit-identically for 800 more ticks', () => {
    const ctx = makeNetContext(true)
    let source = createState(ctx, SEED, CHARS)
    let sourceScratch = createState(ctx, SEED, CHARS)
    for (let t = 0; t < PRE_CHECKPOINT_TICKS; t++) {
      ;[source, sourceScratch] = driveOneTick(ctx, source, sourceScratch, t)
    }

    const buf = new Uint8Array(CHECKPOINT_BUF_BYTES)
    const n = encodeCheckpoint(buf, source)
    let joiner = createState(ctx, SEED, CHARS)
    decodeCheckpoint(buf.subarray(0, n), joiner)
    let joinerScratch = createState(ctx, SEED, CHARS)

    expect(statesEqual(source, joiner)).toBe(true)

    for (let t = PRE_CHECKPOINT_TICKS; t < PRE_CHECKPOINT_TICKS + POST_CHECKPOINT_TICKS; t++) {
      ;[source, sourceScratch] = driveOneTick(ctx, source, sourceScratch, t)
      ;[joiner, joinerScratch] = driveOneTick(ctx, joiner, joinerScratch, t)
      expect(
        statesEqual(source, joiner),
        `source and the checkpoint-restored joiner diverged at tick ${t}`,
      ).toBe(true)
    }
  })
})
```

- [ ] **Step 14: Run the test and confirm the RED**

Run: `npx vitest run packages/net/test/latejoin.test.ts`
Expected: FAIL with `TypeError: encodeCheckpoint is not a function`. `@tapkart/protocol`'s barrel
exists from Task 3 and every codec task widens it, so the specifier resolves; a name the barrel does
not carry binds to `undefined` under Vitest's esbuild transform and fails at the call site, not at
import time. (Task 8 precedes Task 17, so by execution time the name is there and this step is about
confirming the test file itself is wired up correctly.)

- [ ] **Step 15: Run to confirm the GREEN**

Run: `npx vitest run packages/net/test/latejoin.test.ts`
Expected: PASS — 2 tests. If the first test fails, `statesEqual` returning `false` for a real
full-precision round trip means `encodeCheckpoint`/`decodeCheckpoint` (Task 8) dropped or rounded a
field — this is exactly the kind of defect the "full-precision, not lossy" design claim exists to
catch, and the fix belongs in `packages/protocol/src/checkpoint.ts`, not in this test.

---

- [ ] **Step 16: Full package verification**

Run: `npx tsc --noEmit -p packages/net && npx vitest run packages/net`
Expected: PASS, zero type errors, every `packages/net` test green, including this task's 5
integration tests (1 + 2 + 2) across roughly 3600 + 600 + 1200 = 5400 simulated ticks total.
The promotion test runs two full authorities side by side, so it simulates 600 ticks twice.

- [ ] **Step 17: Commit**

```bash
git add packages/net/test/fixtures/scripted-input.ts packages/net/test/fixtures/spy-transport.ts \
        packages/net/test/convergence.test.ts packages/net/test/promotion.test.ts packages/net/test/latejoin.test.ts
git commit -m "test(net): add the three netcode integration tests spec S8 names

Convergence: AuthorityLoop + ClientLoop over a 150ms/50ms/5% LoopbackPair
for 3600 ticks, on a held-steady intent with the host set up exactly as
Task 15's own flagship test sets it up (all-zero characterIdx, phase
racing, seat 0 human and connected, item boxes neutralised) - every one
of those removes a correction that has nothing to do with quantization.
Asserts a zero corrections() delta across the 3240-tick steady window, a
floor on snapshots that actually arrived (a dead transport also reports
zero corrections), and, through the contract's state() accessors, that
the client's own kart really is where the authority's is.

Promotion: a real AuthorityLoop feeds a real ShadowLoop for 300 ticks
with the client's input broadcast to both, then goes silent for 300 more.
Asserts exactly one authorityChange (observed on the HOST's side, which
is where a b->a broadcast lands), no per-kart lap regression from a
seeded nonzero lap, that a seeded entity which cannot expire or be struck
is still live with a ttl that walked down by exactly one per tick, and
that the shadow's captured state matches the host's captured state at the
same tick within a stated band.

Late join: encodeCheckpoint/decodeCheckpoint round-trips a SimState
exactly (statesEqual, not an epsilon), and a joiner restored from that
checkpoint tracks the source bit-identically for 800 further ticks,
extending Plan 1's same-process checkpoint-replay equivalence claim
across the wire format a real late joiner receives."
```

---

**Dependencies and open limits flagged for the plan's author:**

1. **Open: one loopback pair cannot carry spec §5's three-party topology.** Both tests here place
   two loops on one pair and let the test itself play the client on both sides. That covers the
   dual-send behaviour but not a real third peer, and `ClientLoop.tick()` still broadcasts on a
   single `Transport` - so "every client sends its input to both the host and the server shadow"
   is structurally unimplemented in `net`, not merely untested. Closing it needs either a
   multi-peer transport or a second `Transport` argument on `ClientLoop`, and both are outside the
   contract's §5 module map.
2. **Settled: the message header.** An earlier draft of this brief inherited Task 16's private
   `WIRE_TAG_*` bytes. Contract §3's `WIRE_TAG`/`encodeHeader`/`decodeHeader` replace them; every
   fixture and test in this file frames and dispatches through those.
3. **Settled: the state accessors.** `AuthorityLoop.state()` and `ClientLoop.state()` are in the
   locked contract, so neither test needs a workaround, and Test 2 drives real loops rather than a
   hand-rolled host.
4. **Depends on Task 12's loopback delivering `a -> b` and `b -> a` and on `close()` not being
   needed to stop a peer.** Test 2 kills the host by ceasing to call `host.tick()` and ceasing to
   broadcast on side `b`, rather than by calling `close()`, because `Transport.close()`'s effect on
   an in-flight queue is Task 12's business and this test does not need to depend on it.

---

### Task 18: Public barrel exports for `packages/protocol` and `packages/net`

**Files:**
- Widen: `packages/protocol/src/index.ts` *(created by Task 3, widened by each codec task)*
- Test: `packages/protocol/test/barrel.test.ts`
- Widen: `packages/net/src/index.ts` *(created by Task 11)*
- Test: `packages/net/test/barrel.test.ts`

**Why two packages in one task, and why "widen" rather than "create".** Contract §3's module map
labels `packages/protocol/src/index.ts` **`[Task 3 creates, Task 18 widens]`**, and its prose is
explicit: *"The barrel exists from Task 3, not Task 18. Task 3's scaffold creates
`packages/protocol/src/index.ts` already re-exporting `./types`, exactly as Plan 1's Task 2 did for
`@tapkart/sim`; Task 18 widens it to every module and adds the no-ambiguous-export test."* §3
applies the same rule to `net`: *"Task 11's scaffold creates it re-exporting `./transport`, Task 18
widens it."*

An earlier draft of this brief assumed the opposite — that neither package was reachable by its bare
specifier until this task ran — and used that assumption to justify every `net` task importing
`protocol` by relative path. Contract §3 forbids that by name: a relative path *"punches through the
package boundary, bypasses the `exports` map, and would survive into Plan 3."* **`net` imports
`@tapkart/protocol`, always**, from Task 11 onward. Nothing in this task's own output changes as a
result — the finished barrels are the same seven and six lines either way — but two of its RED steps
predicted the wrong failure, and both are corrected below.

This task therefore: appends the remaining `export *` lines to two files that already exist, and
adds the two barrel test files, which are the only *new* files it creates. It adds no behaviour and
changes no signature.

**Assumption stated up front, since neither `index.ts` is created here:** this task assumes
`packages/protocol/package.json` and `packages/net/package.json` already exist (created by Tasks 3
and 11 respectively) with `"exports": { ".": "./src/index.ts" }`, mirroring
`packages/sim/package.json` exactly. If either is missing that field, Step 5 or Step 10 below (the
"resolves through the package entry point" test) fails with a Node resolution error naming the
package, not a missing-export error — that is the tell that this assumption, not this task's own
code, is what needs fixing.

**Facts this task rests on — checked, not assumed, mirroring Plan 1's Task 18 exactly:**

1. `export *` re-exports types and values together and is legal under `isolatedModules`; only a
   named `export { SomeType }` would need `export type`.
2. **`packages/net/src/transport.ts` (Task 11) exports nothing at runtime.** Its only member per the
   locked contract §5 is `export interface Transport { … }` — an interface, erased at compile time.
   `export * from './transport'` is legal and necessary (the module-completeness scan in Step 9
   requires the line to exist) but contributes zero names to the runtime namespace. This is a
   stronger version of Plan 1's `types.ts` exception (which at least had six numeric constants):
   `transport.ts` has nothing runtime at all, and this task's "exports a function from every module"
   test list does not include an entry for it, exactly as Plan 1's excluded `types` from its own list
   for the same underlying reason.
3. **`packages/protocol/src/types.ts` (Task 3) exports four runtime values:** the constants
   `PROTOCOL_VERSION` and `WIRE_TAG`, and the functions `encodeHeader` and `decodeHeader`
   (contract §3). Everything else in that file (`ChannelName`, `MessageKind`, `WireHeader`,
   `WireKart`, `WireEntity`, `WireSnapshot`, `InputDatagram`) is a type. The barrel test below
   covers the two constants in its constants check and the two functions in its function list —
   unlike Plan 1's `sim/types.ts`, which had no functions at all, this module does.
4. No two `src` modules in either package export the same name, so no `export *` is ambiguous. As in
   Plan 1, this is asserted at runtime rather than trusted: an ambiguous star-export is silently
   dropped from the ESM namespace and importing it by name is a `SyntaxError`.
5. Test fixtures (`packages/net/test/fixtures/net-fixtures.ts`, Task 12) live under `test/`, never
   under `src/`, so neither barrel can leak `makeNetContext`/`makeLossyPair` into the public surface.
   Both barrel tests assert this directly.
6. The barrel imports every module; no module imports its own package's barrel. Widening it
   therefore creates no import cycle in either package. Cross-package imports are already
   `@tapkart/protocol` everywhere in `net` (contract §3, from Task 11 onward), so this task rewrites
   nothing in Tasks 11–17 and touches no file outside the two `index.ts` files and their two test
   files.
7. **The ambiguity scan below builds its expected namespace map from direct per-module imports
   (`import * as bitsNs from '../src/bits'`), never from the barrel.** This is not a style choice.
   An ambiguous `export *` is silently *dropped* from the ESM namespace object, so a check that
   derived its expectations from the barrel would be inspecting evidence the ambiguity has already
   destroyed — it would report "no clashes" precisely when there is one. The per-module namespaces
   are the only place the two colliding names both still exist.

**Interfaces:**

Consumes — every `src` module in both packages, by the exact names the locked contract fixes.

```ts
// packages/protocol/src/types.ts                              [Task 3]
export const PROTOCOL_VERSION = 1
export const WIRE_TAG: { readonly [K in MessageKind]: number }   // input 0x10, snapshot 0x11,
                                                                 // events 0x12, checkpoint 0x13,
                                                                 // authorityChange 0x20, ...
export function encodeHeader(out: Uint8Array, kind: MessageKind): number
export function decodeHeader(buf: Uint8Array): WireHeader
// plus types only: ChannelName, MessageKind, WireHeader, WireKart, WireEntity, WireSnapshot, InputDatagram

// packages/protocol/src/bits.ts                                [Task 4]
export class BitWriter { constructor(buf: Uint8Array); reset(): void; writeBits(value: number, bits: number): void; writeFloatQ(value: number, min: number, max: number, bits: number): void; byteLength(): number }
export class BitReader { constructor(buf: Uint8Array); reset(): void; readBits(bits: number): number; readFloatQ(min: number, max: number, bits: number): number }

// packages/protocol/src/quant.ts                               [Task 5]
export const Q: QuantTable
export const EPS: EpsilonTable
export function quantStep(min: number, max: number, bits: number): number

// packages/protocol/src/snapshot.ts                            [Task 6]
export function encodeSnapshot(out: Uint8Array, state: SimState, lastProcessedInputTick: number[]): number
export function decodeSnapshot(buf: Uint8Array, out: WireSnapshot): void
export function applySnapshotToState(snap: WireSnapshot, dst: SimState): void

// packages/protocol/src/checkpoint.ts                          [Task 8]
export function encodeCheckpoint(out: Uint8Array, state: SimState): number
export function decodeCheckpoint(buf: Uint8Array, dst: SimState): void

// packages/protocol/src/events.ts                              [Task 9]
export function encodeEvents(out: Uint8Array, events: AuthEvent[]): number
export function decodeEvents(buf: Uint8Array, out: AuthEvent[]): void

// packages/protocol/src/input.ts                               [Task 10]
export const INPUT_REDUNDANCY = 8
export function encodeInput(out: Uint8Array, playerId: number, intents: Intent[]): number
export function decodeInput(buf: Uint8Array, out: InputDatagram): void

// packages/net/src/transport.ts                                [Task 11]
export interface Transport { /* … */ }   // no runtime export — see verified fact 2 above

// packages/net/src/loopback.ts                                 [Task 12]
export function makeLoopbackPair(opts: LoopbackOptions): { a: Transport; b: Transport; pump(nowMs: number): void }

// packages/net/src/apply.ts                                    [Task 13]
export function applyEvent(ctx: SimContext, state: SimState, ev: AuthEvent): boolean

// packages/net/src/authority.ts                                [Task 14]
export class AuthorityLoop { constructor(ctx: SimContext, state: SimState, t: Transport); tick(): void; state(): SimState }

// packages/net/src/client.ts                                   [Task 15]
export class ClientLoop { constructor(ctx: SimContext, playerId: number, t: Transport); tick(localIntent: Intent): void; corrections(): number; state(): SimState }

// packages/net/src/shadow.ts                                   [Task 16, this plan]
// No WIRE_TAG_* constants: the message header is protocol's (contract §3), and
// shadow.ts's own HEADER_BYTES is private.
export const HOST_TIMEOUT_TICKS = 90
export const SNAPSHOT_PERIOD_TICKS = 3
export const SHADOW_HISTORY_TICKS = 24
export const AUTHORITY_CHANGE_BYTES = 10
export function encodeAuthorityChange(out: Uint8Array, tick: number, eventSeq: number): number
export function decodeAuthorityChange(buf: Uint8Array): { tick: number; eventSeq: number }
export class ShadowLoop { constructor(ctx: SimContext, state: SimState, t: Transport); tick(): void; promote(tick: number): void }

// packages/net/test/fixtures/net-fixtures.ts                   [Task 12]
export function makeNetContext(isLeader?: boolean): SimContext
export function makeLossyPair(overrides?: Partial<LoopbackOptions>): ReturnType<typeof makeLoopbackPair>
```

Produces:
- `packages/protocol/src/index.ts` re-exporting all seven modules — `types`, `bits`, `quant`,
  `snapshot`, `checkpoint`, `events`, `input` — so `import { encodeSnapshot, Q } from
  '@tapkart/protocol'` works from any workspace package (in particular, `net`'s own future
  refactors, and the eventual `server`/`game` packages).
- `packages/net/src/index.ts` re-exporting all six modules — `transport`, `loopback`, `apply`,
  `authority`, `client`, `shadow` — so `import { ShadowLoop, AuthorityLoop } from '@tapkart/net'`
  works the same way.

---

#### Part A: `packages/protocol`

- [ ] **Step 1: Write the failing test**

Create `packages/protocol/test/barrel.test.ts`:

```ts
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import * as protocol from '../src/index'
import {
  // types [Task 3]
  PROTOCOL_VERSION,
  WIRE_TAG,
  decodeHeader,
  encodeHeader,
  // bits [Task 4]
  BitReader,
  BitWriter,
  // quant [Task 5]
  EPS,
  Q,
  quantStep,
  // snapshot [Task 6]
  applySnapshotToState,
  decodeSnapshot,
  encodeSnapshot,
  // checkpoint [Task 8]
  decodeCheckpoint,
  encodeCheckpoint,
  // events [Task 9]
  decodeEvents,
  encodeEvents,
  // input [Task 10]
  INPUT_REDUNDANCY,
  decodeInput,
  encodeInput,
} from '../src/index'

// The same three bindings imported straight from their own modules, to prove the barrel re-exports
// them rather than redeclaring anything.
import { quantStep as quantStepDirect } from '../src/quant'
import { encodeSnapshot as encodeSnapshotDirect } from '../src/snapshot'
import { BitWriter as BitWriterDirect } from '../src/bits'

// Every module as a namespace, for the ambiguity scan.
import * as bitsNs from '../src/bits'
import * as checkpointNs from '../src/checkpoint'
import * as eventsNs from '../src/events'
import * as inputNs from '../src/input'
import * as quantNs from '../src/quant'
import * as snapshotNs from '../src/snapshot'
import * as typesNs from '../src/types'

const HERE = dirname(fileURLToPath(import.meta.url)) // packages/protocol/test
const SRC = join(HERE, '..', 'src')

/** The seven modules the barrel must re-export, in the locked contract's SS3 order. */
const BARREL_MODULES = ['types', 'bits', 'quant', 'snapshot', 'checkpoint', 'events', 'input']

const NAMESPACES: [string, object][] = [
  ['types', typesNs],
  ['bits', bitsNs],
  ['quant', quantNs],
  ['snapshot', snapshotNs],
  ['checkpoint', checkpointNs],
  ['events', eventsNs],
  ['input', inputNs],
]

describe('@tapkart/protocol barrel', () => {
  it('exports a named function or class from every module that has one', () => {
    const fns: [string, unknown][] = [
      ['types.encodeHeader', encodeHeader],
      ['types.decodeHeader', decodeHeader],
      ['bits.BitWriter', BitWriter],
      ['bits.BitReader', BitReader],
      ['quant.quantStep', quantStep],
      ['snapshot.encodeSnapshot', encodeSnapshot],
      ['snapshot.decodeSnapshot', decodeSnapshot],
      ['snapshot.applySnapshotToState', applySnapshotToState],
      ['checkpoint.encodeCheckpoint', encodeCheckpoint],
      ['checkpoint.decodeCheckpoint', decodeCheckpoint],
      ['events.encodeEvents', encodeEvents],
      ['events.decodeEvents', decodeEvents],
      ['input.encodeInput', encodeInput],
      ['input.decodeInput', decodeInput],
    ]
    // 14 functions/classes across all 7 modules. types contributes the two header
    // functions (contract §3) on top of its two constants, which the constants
    // test below covers.
    // 2 types + 2 bits + 1 quant + 3 snapshot + 2 checkpoint + 2 events + 2 input = 14.
    expect(fns).toHaveLength(14)
    for (const [name, fn] of fns) {
      expect(typeof fn, `${name} did not come through the barrel as a function`).toBe('function')
    }
  })

  it('carries the contract constants through unchanged', () => {
    expect(PROTOCOL_VERSION).toBe(1)
    expect(INPUT_REDUNDANCY).toBe(8)
    // The shared wire tags, by the exact values contract §3 fixes. Every net
    // loop dispatches on these, so a barrel that forwarded a stale copy would
    // desynchronise host, client and shadow with no other symptom.
    expect(WIRE_TAG.input).toBe(0x10)
    expect(WIRE_TAG.snapshot).toBe(0x11)
    expect(WIRE_TAG.events).toBe(0x12)
    expect(WIRE_TAG.checkpoint).toBe(0x13)
    expect(WIRE_TAG.authorityChange).toBe(0x20)
    // ...and a header written through the barrel reads back through it.
    const hdr = new Uint8Array(2)
    expect(encodeHeader(hdr, 'snapshot')).toBe(2)
    expect(decodeHeader(hdr)).toEqual({ kind: 'snapshot', protocolVersion: PROTOCOL_VERSION })
    // Q and EPS's exact internal shape belongs to Task 5, not this task: only existence, frozen-ness
    // and object-ness are asserted here.
    expect(Q).toBeTruthy()
    expect(EPS).toBeTruthy()
    expect(Object.isFrozen(Q)).toBe(true)
    expect(Object.isFrozen(EPS)).toBe(true)
  })

  it("re-exports each module's own binding, not a copy", () => {
    expect(quantStep).toBe(quantStepDirect)
    expect(encodeSnapshot).toBe(encodeSnapshotDirect)
    expect(BitWriter).toBe(BitWriterDirect)
  })

  it('lists every module in src/ exactly once', () => {
    const onDisk = readdirSync(SRC)
      .filter((f) => f.endsWith('.ts') && f !== 'index.ts')
      .map((f) => f.slice(0, -3))
      .sort()
    expect(onDisk).toEqual([...BARREL_MODULES].sort())

    const barrel = readFileSync(join(SRC, 'index.ts'), 'utf8')
    for (const name of BARREL_MODULES) {
      const line = `export * from './${name}'`
      expect(barrel, `barrel is missing ${line}`).toContain(line)
      expect(barrel.split(line).length - 1, `${line} appears more than once`).toBe(1)
    }
  })

  it('has no ambiguous re-export, and forwards every runtime export', () => {
    const owners = new Map<string, string[]>()
    for (const [mod, ns] of NAMESPACES) {
      for (const key of Object.keys(ns)) {
        const list = owners.get(key) ?? []
        list.push(mod)
        owners.set(key, list)
      }
    }
    const clashes = Array.from(owners.entries()).filter(([, mods]) => mods.length > 1)
    expect(clashes).toEqual([])

    for (const [mod, ns] of NAMESPACES) {
      for (const key of Object.keys(ns)) {
        expect(
          Object.prototype.hasOwnProperty.call(protocol, key),
          `${mod}.${key} is not reachable through the barrel`,
        ).toBe(true)
      }
    }
  })

  it('encodes and decodes a snapshot header field through the barrel alone', () => {
    const w = new BitWriter(new Uint8Array(8))
    w.writeBits(42, 8)
    expect(w.byteLength()).toBeGreaterThan(0)
    expect(quantStep(0, 1, 10)).toBeCloseTo(1 / 1023, 6)
  })

  it('resolves through the @tapkart/protocol package entry point', async () => {
    const pkg = await import('@tapkart/protocol')
    expect(pkg.quantStep).toBe(quantStepDirect)
    expect(pkg.PROTOCOL_VERSION).toBe(1)
  })
})
```

- [ ] **Step 2: Run the test and confirm the RED**

Run: `npx vitest run packages/protocol/test/barrel.test.ts`

Expected: FAIL — but **not** a resolution failure. `packages/protocol/src/index.ts` exists from Task
3, and each codec task appended its own line to it, so the specifier resolves; what fails is a name
the barrel does not carry. Under Vitest's esbuild transform a missing named export binds to
`undefined`, so the first assertion to touch one throws at the call site:

```
TypeError: encodeHeader is not a function
```

If the barrel happens to be complete already (every codec task appended its line), this step is
green and there is nothing to do in Step 3 — say so and move on rather than manufacturing a red.
(If the failure is instead `Failed to resolve import "../src/index"`, Task 3's scaffold did not
create the file: that is a real gap in Task 3, not in this task, and contract §3 says whose it is.)

- [ ] **Step 3: Widen the barrel to every module**

Bring `packages/protocol/src/index.ts` to exactly this content — appending whichever
`export * from` lines are not already there, in this order:

```typescript
// Public barrel for @tapkart/protocol.
//
// packages/protocol/package.json maps "." to this file, so this list IS the package's public
// surface. Task 3 created it re-exporting ./types and each codec task appended its own line as its
// final step, which is what lets `net` import @tapkart/protocol from Task 11 onward (contract SS3:
// "net imports @tapkart/protocol, always"). This task widens it to the full seven and adds the
// tests that keep it honest.
//
// Ordered as the locked contract's SS3 module map lists them. `export *` carries types and values
// together and is legal under isolatedModules; no two modules below export the same name, so no
// re-export is ambiguous - barrel.test.ts asserts that at runtime rather than leaving it to this
// comment.
export * from './types'
export * from './bits'
export * from './quant'
export * from './snapshot'
export * from './checkpoint'
export * from './events'
export * from './input'
```

- [ ] **Step 4: Run the test and confirm the GREEN**

Run: `npx vitest run packages/protocol/test/barrel.test.ts`
Expected: PASS — 7 tests.

If "has no ambiguous re-export" fails, it prints the clashing name and the two modules that both
export it. The fix is to rename the copy in whichever module does not own the name per the locked
contract's §3 module map — not to drop a line from the barrel.

- [ ] **Step 5: Verify the public surface and run the whole protocol suite**

Run:

```bash
npx vitest run packages/protocol/test/barrel.test.ts -t "resolves through the @tapkart/protocol package entry point"
npx tsc --noEmit -p packages/protocol && npx vitest run packages/protocol
```

Expected: PASS throughout, zero type errors, every `packages/protocol` test green. The only way the
full-suite run can go red from this task's own change is a genuine name clash between two modules
(`TS2308: Module './x' has already exported a member named 'y'`), which Step 4's test would already
have named.

---

#### Part B: `packages/net`

- [ ] **Step 6: Write the failing test**

Create `packages/net/test/barrel.test.ts`:

```ts
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Top-level ESM import, not `require('@tapkart/sim')`: every package here sets
// "type": "module" and Vitest transforms to ESM, where `require` is undefined.
import { createState } from '@tapkart/sim'
import * as net from '../src/index'
import {
  // loopback [Task 12]
  makeLoopbackPair,
  // apply [Task 13]
  applyEvent,
  // authority [Task 14]
  AuthorityLoop,
  // client [Task 15]
  ClientLoop,
  // shadow [Task 16]
  AUTHORITY_CHANGE_BYTES,
  HOST_TIMEOUT_TICKS,
  SHADOW_HISTORY_TICKS,
  SNAPSHOT_PERIOD_TICKS,
  ShadowLoop,
  decodeAuthorityChange,
  encodeAuthorityChange,
} from '../src/index'

import { applyEvent as applyEventDirect } from '../src/apply'
import { ShadowLoop as ShadowLoopDirect } from '../src/shadow'

import * as applyNs from '../src/apply'
import * as authorityNs from '../src/authority'
import * as clientNs from '../src/client'
import * as loopbackNs from '../src/loopback'
import * as shadowNs from '../src/shadow'
import * as transportNs from '../src/transport'

import { makeLossyPair, makeNetContext } from './fixtures/net-fixtures'

const HERE = dirname(fileURLToPath(import.meta.url)) // packages/net/test
const SRC = join(HERE, '..', 'src')

/** The six modules the barrel must re-export, in the locked contract's SS5 order. */
const BARREL_MODULES = ['transport', 'loopback', 'apply', 'authority', 'client', 'shadow']

const NAMESPACES: [string, object][] = [
  ['transport', transportNs],
  ['loopback', loopbackNs],
  ['apply', applyNs],
  ['authority', authorityNs],
  ['client', clientNs],
  ['shadow', shadowNs],
]

describe('@tapkart/net barrel', () => {
  it('exports a named function or class from every module that has one', () => {
    const fns: [string, unknown][] = [
      ['loopback.makeLoopbackPair', makeLoopbackPair],
      ['apply.applyEvent', applyEvent],
      ['authority.AuthorityLoop', AuthorityLoop],
      ['client.ClientLoop', ClientLoop],
      ['shadow.ShadowLoop', ShadowLoop],
      ['shadow.encodeAuthorityChange', encodeAuthorityChange],
      ['shadow.decodeAuthorityChange', decodeAuthorityChange],
    ]
    // 7 functions/classes across 5 of the 6 modules. The sixth, `transport`, exports only the
    // Transport interface (a type, erased at compile time) and has nothing runtime at all - a
    // stronger version of protocol's `types` exception, since transport.ts has no constant either.
    // 1 loopback + 1 apply + 1 authority + 1 client + 3 shadow = 7.
    expect(fns).toHaveLength(7)
    for (const [name, fn] of fns) {
      expect(typeof fn, `${name} did not come through the barrel as a function`).toBe('function')
    }
  })

  it('carries the shadow module constants through unchanged', () => {
    expect(HOST_TIMEOUT_TICKS).toBe(90)
    expect(SNAPSHOT_PERIOD_TICKS).toBe(3)
    expect(SHADOW_HISTORY_TICKS).toBe(24)
    expect(AUTHORITY_CHANGE_BYTES).toBe(10) // 2-byte shared header + two u32s
    // No WIRE_TAG_* here: the message tags belong to @tapkart/protocol (contract
    // §3). An earlier draft of this test asserted a private [4,5,6,7,8] scheme
    // that shadow.ts defined and no other loop in the plan ever wrote or read.
  })

  it("re-exports each module's own binding, not a copy", () => {
    expect(applyEvent).toBe(applyEventDirect)
    expect(ShadowLoop).toBe(ShadowLoopDirect)
  })

  it('lists every module in src/ exactly once, and no test fixture', () => {
    const onDisk = readdirSync(SRC)
      .filter((f) => f.endsWith('.ts') && f !== 'index.ts')
      .map((f) => f.slice(0, -3))
      .sort()
    expect(onDisk).toEqual([...BARREL_MODULES].sort())

    const barrel = readFileSync(join(SRC, 'index.ts'), 'utf8')
    for (const name of BARREL_MODULES) {
      const line = `export * from './${name}'`
      expect(barrel, `barrel is missing ${line}`).toContain(line)
      expect(barrel.split(line).length - 1, `${line} appears more than once`).toBe(1)
    }

    // net-fixtures.ts lives in test/, so its exports cannot be part of the public surface.
    expect(Object.prototype.hasOwnProperty.call(net, 'makeNetContext')).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(net, 'makeLossyPair')).toBe(false)
  })

  it('has no ambiguous re-export, and forwards every runtime export', () => {
    const owners = new Map<string, string[]>()
    for (const [mod, ns] of NAMESPACES) {
      for (const key of Object.keys(ns)) {
        const list = owners.get(key) ?? []
        list.push(mod)
        owners.set(key, list)
      }
    }
    const clashes = Array.from(owners.entries()).filter(([, mods]) => mods.length > 1)
    expect(clashes).toEqual([])

    for (const [mod, ns] of NAMESPACES) {
      for (const key of Object.keys(ns)) {
        expect(
          Object.prototype.hasOwnProperty.call(net, key),
          `${mod}.${key} is not reachable through the barrel`,
        ).toBe(true)
      }
    }
  })

  it('drives a ShadowLoop through the barrel alone', () => {
    const ctx = makeNetContext(false)
    const state = createState(ctx, 0x1, [0, 1, 2, 3, 4, 5, 6, 7])
    const shadow = new ShadowLoop(ctx, state, {
      send() {}, broadcast() {}, onMessage() {}, onPeerLost() {}, peers: () => [], close() {},
    })
    shadow.tick()
    expect(state.tick).toBe(1)
  })

  it('resolves through the @tapkart/net package entry point', async () => {
    const pkg = await import('@tapkart/net')
    expect(pkg.applyEvent).toBe(applyEventDirect)
    expect(pkg.HOST_TIMEOUT_TICKS).toBe(90)
  })
})
```

- [ ] **Step 7: Run the test and confirm the RED**

Run: `npx vitest run packages/net/test/barrel.test.ts`

Expected: FAIL, and again **not** a resolution failure: contract §3 has Task 11's scaffold create
`packages/net/src/index.ts` re-exporting `./transport`. `transport.ts` contributes nothing at
runtime, so the barrel exists and is empty of values, and the first named import to be used throws:

```
TypeError: ShadowLoop is not a constructor
```

- [ ] **Step 8: Widen the barrel to every module**

Bring `packages/net/src/index.ts` to exactly this content — appending the five lines Task 11's
scaffold does not already have:

```typescript
// Public barrel for @tapkart/net.
//
// packages/net/package.json maps "." to this file. Task 11's scaffold created it re-exporting
// ./transport; this task appends the other five. Ordered as the locked contract's SS5 module map
// lists them. `transport` contributes nothing at runtime (Transport is an interface only) but the
// export line is still required — barrel.test.ts's module-completeness scan checks for the line
// itself, not for anything it produces.
export * from './transport'
export * from './loopback'
export * from './apply'
export * from './authority'
export * from './client'
export * from './shadow'
```

- [ ] **Step 9: Run the test and confirm the GREEN**

Run: `npx vitest run packages/net/test/barrel.test.ts`
Expected: PASS — 7 tests.

- [ ] **Step 10: Verify the public surface and run the whole net suite**

Run:

```bash
npx vitest run packages/net/test/barrel.test.ts -t "resolves through the @tapkart/net package entry point"
npx tsc --noEmit -p packages/net && npx vitest run packages/net
```

Expected: PASS throughout, zero type errors, every `packages/net` test green — including this
plan's Task 16 (`shadow.test.ts`, 19 tests — Task 16's own residual-findings pass added one) and
Task 17 (5 integration tests across ~5400 ticks).

---

- [ ] **Step 11: Full workspace verification**

Run: `npm run typecheck && npx vitest run`
Expected: PASS across every package — `sim`, `protocol` and `net`.

**`sim`'s test count is not 477 here.** That was Plan 1's merged baseline (477 passed / 1 skipped).
Plan 2's Tasks 1 and 2 change it: Task 1 deletes three checkpoint-parity tests and one
hold-poisoning test and adds its own, Task 2 adds a full-tick leader/follower parity test. Measured
on a scratch tree by the cross-cutting audit: baseline 478 total, Task 1 alone 477 total, Tasks 1+2
**484 total**. Expect that figure, not "477+", and treat a mismatch as a signal that Tasks 1–2 did
not land as written rather than as a number to edit.

This is the first point in Plan 2 where all three packages are typechecked and tested together, and
the first where `@tapkart/net` is exercised as a bare specifier — `@tapkart/protocol` has been one
since Task 3.

- [ ] **Step 12: Commit**

```bash
git add packages/protocol/src/index.ts packages/protocol/test/barrel.test.ts \
        packages/net/src/index.ts packages/net/test/barrel.test.ts
git commit -m "feat(protocol,net): add public barrel exports for both packages

packages/protocol/src/index.ts re-exports all seven modules (types, bits,
quant, snapshot, checkpoint, events, input); packages/net/src/index.ts
re-exports all six (transport, loopback, apply, authority, client,
shadow). Both files already existed - Task 3 and Task 11 created them as
part of their scaffolds, and each codec task appended its own line - so
this task widens them rather than creating them, which is what let every
net task import @tapkart/protocol by its bare specifier all along.

Both barrel tests import one named export from each module through the
barrel, pin the contract constants, prove each barrel forwards its
modules' own bindings rather than copies, check the module list against
src/ so a future module cannot be forgotten, scan for ambiguous
re-exports, confirm neither test-only fixture module leaks into the
public surface, and resolve the bare @tapkart/protocol and @tapkart/net
specifiers the way a downstream package will."
```

---

**Ambiguities and dependencies flagged for the plan's author:**

1. This task assumes `packages/protocol/package.json` and `packages/net/package.json` already carry
   `"exports": { ".": "./src/index.ts" }` from their scaffolding tasks (3 and 11), and that both
   `src/index.ts` files already exist with at least their scaffold line. Neither file is created by
   this task; if either is missing, Step 5's or Step 10's package-entry-point test names the package
   directly.
2. `packages/net/src/transport.ts` has zero runtime exports under the locked contract's given
   signature. If Task 11 ends up adding any runtime value there (a constant, an error class), this
   task's net barrel test's function-count assertion (currently 7) and module-exclusion list will
   need a one-line update to match — not a structural change.

---

