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
