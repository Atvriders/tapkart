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
'/home/kasm-user/tapkart/packages/net/test/client.test.ts'
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
