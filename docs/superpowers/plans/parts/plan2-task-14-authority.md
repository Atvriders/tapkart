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
    `ChannelName = 'unreliable' | 'reliable'`.
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

- Produces (locked contract §5):
  - `export class AuthorityLoop { constructor(ctx: SimContext, state: SimState, t: Transport); tick(): void }`

**Verification performed for this brief:** this brief's core algorithm — the
per-player 60Hz input hold with catch-up across a gap, `lastAppliedInputTick`
bookkeeping, the double-buffer-with-`cloneState`-back pattern that keeps the
caller's `state` object current by mutation, and connected-kart bot takeover —
was written as a small stand-alone class (`FakeAuthority`, no networking, no
protocol codecs) and run against the real, currently-merged `packages/sim`
before this brief was written. Three tests, all passing: a 30Hz intent applied
across the pair and repeated over a gap, a redundant re-delivery correctly
ignored (`lastAppliedInputTick` advances, never regresses), and a
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

---

- [ ] **Step 1: Write the failing test — bare ticking and the countdown boundary**

Create `packages/net/test/authority.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { COUNTDOWN_TICKS, MAX_ENTITIES, MAX_KARTS, createState } from '@tapkart/sim'
import type { WireEntity, WireKart, WireSnapshot } from '@tapkart/protocol'
import { decodeSnapshot, encodeInput } from '@tapkart/protocol'
import { AuthorityLoop } from '../src/authority'
import { makeLossyPair, makeNetContext } from './fixtures/net-fixtures'

const CHARS = [0, 0, 0, 0, 0, 0, 0, 0]

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
    pair.b.onMessage((_peerId, channel, data) => {
      if (channel !== 'unreliable') return
      const snap = makeWireSnapshot()
      decodeSnapshot(data, snap)
      if (latest === null || snap.tick > latest.tick) latest = snap
    })

    let nowMs = 0
    const frame = (): void => {
      authority.tick()
      pair.pump(nowMs)
      nowMs += 1000 / 60
    }

    const mkIntents = (startTick: number): { tick: number; steer: number; accel: number; brake: boolean; drift: boolean; useItem: boolean }[] =>
      Array.from({ length: 8 }, (_, i) => ({
        tick: startTick + i * 2, steer: 0.5, accel: 1, brake: false, drift: false, useItem: false,
      }))

    const buf1 = new Uint8Array(128)
    const n1 = encodeInput(buf1, 3, mkIntents(0))   // ticks 0,2,...,14
    pair.b.broadcast('unreliable', buf1.slice(0, n1))
    for (let i = 0; i < 20; i++) frame()

    expect(latest).not.toBeNull()
    expect(latest!.lastProcessedInputTick[3]).toBe(14)
    const xAfterFirst = state.karts[3].position.x
    expect(xAfterFirst).not.toBe(0)   // the held intent was actually applied to physics

    const buf2 = new Uint8Array(128)
    const n2 = encodeInput(buf2, 3, mkIntents(16))  // ticks 16,18,...,30
    pair.b.broadcast('unreliable', buf2.slice(0, n2))
    for (let i = 0; i < 20; i++) frame()

    expect(latest!.lastProcessedInputTick[3]).toBe(30)
    expect(state.karts[3].position.x).toBeGreaterThan(xAfterFirst)   // kept moving, still forward
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/net/test/authority.test.ts`

Expected: FAIL. `packages/net/src/authority.ts` does not exist yet:

```
Error: Cannot find module '../src/authority' imported from
'/home/kasm-user/tapkart/packages/net/test/authority.test.ts'
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
import { INPUT_REDUNDANCY, decodeInput, encodeEvents, encodeSnapshot } from '@tapkart/protocol'
import type { Transport } from './transport'

/** 60Hz sim / 20Hz snapshot broadcast. Spec section 5. Exact: 60 / 20 = 3. */
const SNAPSHOT_INTERVAL_TICKS = 3

/**
 * Generous fixed allocations, not protocol-mandated sizes: encodeSnapshot and
 * encodeEvents take a caller-owned buffer and return bytes written, so any
 * buffer at least as large as the worst case is correct. Locked contract §4:
 * worst-case snapshot is ~625B (32 live entities); 1024 leaves headroom.
 * Events carry no stated per-tick cap; 2048B comfortably covers dozens.
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
  private readonly state: SimState
  private readonly scratch: SimState
  private readonly transport: Transport

  private readonly heldIntent: Intent[] = makeIntentBuffer()
  private readonly lastAppliedInputTick: number[] = new Array(MAX_KARTS).fill(-1)
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
    this.state = state
    this.scratch = allocStateLike(this.ctx, state)
    this.transport = t
    t.onMessage((peerId, channel, data) => this.onMessage(peerId, channel, data))
    t.onPeerLost((peerId) => this.onPeerLost(peerId))
  }

  private onMessage(peerId: string, channel: ChannelName, data: Uint8Array): void {
    // Reliable-channel traffic FROM a peer (lobby state, checkpoint requests)
    // is a later plan's scope: this plan's protocol module map defines no
    // codec for it (locked contract §3's MessageKind lists the kinds, but
    // Tasks 3-10 export no encode/decode pair for any of them).
    if (channel !== 'unreliable') return

    decodeInput(data, this.inputDatagram)
    const playerId = this.inputDatagram.playerId
    if (playerId < 0 || playerId >= MAX_KARTS) return
    this.peerIdToPlayerId.set(peerId, playerId)

    const intents = this.inputDatagram.intents
    for (let i = 0; i < intents.length; i++) {
      const it = intents[i]
      if (it.tick > this.lastAppliedInputTick[playerId]) {
        const h = this.heldIntent[playerId]
        h.tick = it.tick
        h.steer = it.steer
        h.accel = it.accel
        h.brake = it.brake
        h.drift = it.drift
        h.useItem = it.useItem
        this.lastAppliedInputTick[playerId] = it.tick
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
    this.state.karts[playerId].connected = false
  }

  tick(): void {
    for (let i = 0; i < MAX_KARTS; i++) {
      const h = this.heldIntent[i]
      const dst = this.stepInputs[i]
      dst.tick = this.state.tick + 1
      dst.steer = h.steer
      dst.accel = h.accel
      dst.brake = h.brake
      dst.drift = h.drift
      dst.useItem = h.useItem
    }

    this.events.length = 0
    step(this.ctx, this.state, this.scratch, this.stepInputs, this.events)
    cloneState(this.scratch, this.state)

    if (this.events.length > 0) {
      const n = encodeEvents(this.eventsBuf, this.events)
      this.transport.broadcast('reliable', this.eventsBuf.slice(0, n))
    }

    if (this.state.tick % SNAPSHOT_INTERVAL_TICKS === 0) {
      const n = encodeSnapshot(this.snapshotBuf, this.state, this.lastAppliedInputTick)
      this.transport.broadcast('unreliable', this.snapshotBuf.slice(0, n))
    }
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/net/test/authority.test.ts`

Expected: PASS — 3 tests. (The input-hold algorithm and the countdown-boundary
fact were both verified against real `packages/sim` before this brief was
written — see the verification note above — so this is expected to pass on
the first implementation, not require iteration.)

- [ ] **Step 5: Write the failing test — event broadcast on occurrence, and bot takeover on peer loss**

Append to `packages/net/test/authority.test.ts`. Add one more import line at
the top, next to the existing `@tapkart/sim` import:

```ts
import { itemBoxWorldPos } from '@tapkart/sim'
```

and next to the existing `@tapkart/protocol` import:

```ts
import type { AuthEvent } from '@tapkart/sim'
import type { ChannelName } from '@tapkart/protocol'
import { decodeEvents } from '@tapkart/protocol'
```

and add this import for the peer-loss test's hand-rolled transport:

```ts
import type { Transport } from '../src/transport'
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
      const out: AuthEvent[] = []
      decodeEvents(data, out)
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

    const intents = Array.from({ length: 8 }, (_, i) => ({
      tick: i * 2, steer: 0.3, accel: 1, brake: false, drift: false, useItem: false,
    }))
    const buf = new Uint8Array(128)
    const n = encodeInput(buf, 5, intents)
    t.deliver('remote-peer-42', 'unreliable', buf.slice(0, n))

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

Expected: FAIL, 3 new failures. The two new `describe` blocks reference
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

Expected: PASS — 6 tests total.

- [ ] **Step 8: Typecheck and run the full net suite**

Run: `npx tsc --noEmit -p packages/net/tsconfig.json && npx vitest run packages/net`

Expected: PASS, zero type errors, every `net` test green (this task's 6 plus
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
takeover mechanism is that one field."
```
