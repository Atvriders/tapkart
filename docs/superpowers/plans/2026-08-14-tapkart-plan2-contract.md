# Tapkart Plan 2 — Locked Interface Contract

> This is the **Global Constraints** section of the Plan 2 implementation plan.
> Every task's requirements implicitly include everything here. No task may
> rename, re-sign, or add fields to anything below. A task needing something
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
| `applyEvent` obeys, it does not re-adjudicate | applying an authoritative event writes state **directly**, bypassing the originating function's refusal rules |

### The `startSpinOut` sole-writer rule has exactly one exception: `applyEvent`

*Ruled 2026-08-14 during execution, after Task 13 correctly flagged the conflict.*

Plan 1 §0 says `startSpinOut` is the sole writer of `spinOutTicks` — nothing else
assigns it. `net`'s `applyEvent` breaks that rule deliberately when applying a
`spinOut` event, and must.

`startSpinOut` carries refusal rules: it declines while a kart is invulnerable or
respawning, and never shortens an existing spin. Those exist so the *authority*
cannot produce an illegal spin. But a `spinOut` event only exists **because the
authority already ran those rules and accepted**. If a follower routed the event
back through `startSpinOut`, its own slightly-diverged local state could refuse —
and the follower's kart would stay upright while the leader's spun. That is a
divergence introduced by the very function meant to prevent one.

So the rule is: **the authority adjudicates, the follower obeys.** Inside
`applyEvent`, an authoritative event is applied as fact. Everywhere else in the
simulation, `startSpinOut` remains the sole writer, and Plan 1's reasoning stands
unchanged.

The same principle governs every kind `applyEvent` handles — it is a replay of
decisions already made, not a second chance to make them.


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

// Amended by Task 15c (controller ruling, item D): `clientUpdate` and
// `resyncRequest` are additive — no existing message's bit layout changes.
// Overloading `hello` for ready toggles, character changes, track choice, start,
// resync requests and seat reclaims made every handler distinguish intent by
// FIELD INSPECTION, and the MessageKind -> handler table is a top-ranked shared
// name risk. Plan 4 defines the bodies.
export type MessageKind =
  | 'hello' | 'welcome' | 'lobby' | 'start' | 'clientUpdate'
  | 'input' | 'snapshot' | 'events' | 'checkpoint' | 'resyncRequest'
  | 'authorityChange' | 'ping' | 'pong'

export interface WireHeader { kind: MessageKind; protocolVersion: number }

// Every datagram begins with this one byte. Without a shared tag a receiver
// cannot dispatch, and each of Tasks 11/14/15/16 would invent its own —
// which is exactly what happened when this was left unspecified.
export const WIRE_TAG = {
  hello: 0x01, welcome: 0x02, lobby: 0x03, start: 0x04, clientUpdate: 0x05,
  input: 0x10, snapshot: 0x11, events: 0x12, checkpoint: 0x13, resyncRequest: 0x14,
  authorityChange: 0x20, ping: 0x30, pong: 0x31,
} as const

// packages/protocol/src/room.ts                        [Task 15c, item E]
// Room codes travel on the wire, so they live here and not in `server` or
// `game`; `LOBBY_PATH_PREFIX` is compiled into the APK's autoVerify pathPrefix
// and is FROZEN at the first signed release. FIVE characters, not four.
export const ROOM_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'  // Crockford: no I, L, O, U
export const ROOM_CODE_LENGTH = 5
export const LOBBY_PATH_PREFIX = '/r/'
export function normalizeRoomCode(input: string): string   // trim + uppercase, total
export function isValidRoomCode(code: string): boolean     // canonical form only
export function lobbyPathFor(code: string): string         // throws on an invalid code
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
  phase: RacePhase                      // Task 15c item A: 2 bits, in the header
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

Header: `tick u32`, `eventSeq u32`, `phase u2`, `lastProcessedInputTick 8×u16`,
`entityCount u8` → **202 bits**.

*Amended 2026-08-14 (Task 15c item A, corrected in its fix round).* The `phase`
row and the 200 → **202** bit total are the amendment. §3 above already listed
`phase: RacePhase` on `WireSnapshot` as of Task 15c; this line still said 200
bits with no phase row, so the same document gave two different answers about
whether the race phase is on the wire — and the header total is the number every
send-buffer comment in `@tapkart/net` derives its worst case from. The worst-case
snapshot is therefore **744 B** (`8×178 + 32×135 + 202 = 5946 bits`), not 743.
The row sits between `eventSeq` and `lastProcessedInputTick` because that is where
`encodeSnapshot` writes it, and it is written **once per snapshot in the header**
rather than as a 23rd per-kart column: `phase` lives on `SimState`, not on the
kart struct, and eight copies of one global value would be a wire format capable
of expressing eight karts disagreeing about whether the race has started.

Code 3 of the two is unreachable for an encoder — `RacePhase` has three values —
and `decodeSnapshot` **rejects** a datagram carrying it rather than clamping, so
it reaches @tapkart/net's datagram guard as a counted drop like every other
undecodable datagram.

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
// tick() takes the scheduler's wall clock as of Task 15c item C: host loss is
// 1.5s of WALL TIME with no snapshot (HOST_TIMEOUT_MS), never a tick count — a
// tick counter stalls exactly when the room's ticker stalls or clamps at
// MAX_CATCHUP_TICKS, which is when host loss actually happens. Absolute, on the
// same timebase as LoopbackTransport.pump(nowMs), and required, not optional.
export class ShadowLoop { constructor(ctx: SimContext, state: SimState, t: Transport); tick(nowMs: number): void; promote(tick: number): void }

// packages/net/src/clock.ts                            [Task 15c, item F]
// One home for the catch-up constant: Plan 3's game clock and Plan 4's server
// ticker are the same function, and `server` may not import `game`.
export const TICK_MS: number                 // 1000 / TICK_HZ, moved here from client.ts
export const MAX_CATCHUP_TICKS = 5
export interface TickAccumulator { residualMs: number }
export function makeTickAccumulator(): TickAccumulator
export function advanceAccumulator(acc: TickAccumulator, elapsedMs: number): number

// packages/net/src/authority.ts                        [Task 15c, item B]
// A host that receives a foreign `authorityChange` stands down for good: it
// stops broadcasting snapshots and events and stops emitting, while continuing
// to step its own view. Authority NEVER returns to the original host — exactly
// one authority at every instant, so no rewind rule is ever needed.
export function isDemoted(loop: AuthorityLoop): boolean

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
