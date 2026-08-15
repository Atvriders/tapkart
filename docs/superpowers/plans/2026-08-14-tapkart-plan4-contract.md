# Tapkart Plan 4 — Locked Interface Contract

> **STATUS: LOCKED.** This is binding. It is the **Global Constraints** section of
> the Plan 4 implementation plan: every task's requirements implicitly include
> everything here. No task may rename, re-sign, or add fields to anything below.
> A task needing something absent must define it in its own files and say so in
> its `Interfaces` block — and if two tasks would need the same absent thing, that
> is an amendment, not a local definition.
>
> The draft this replaces carried 50 open questions. They are triaged in
> `2026-08-14-plan45-question-triage.md` and ruled in
> `2026-08-14-tapkart-plan45-rulings.md`; every ruling is applied below and the
> open-questions section is gone. §14 indexes where each ruling landed. §15 lists
> every place the draft described the shipped code wrongly, because the draft was
> written against a stale read of the worktree and one of its central claims —
> *"`packages/net/src/shadow.ts` does not exist"* — is false.
>
> **§16 is not an open-questions section.** It holds two file-level divergences
> between already-locked documents and the code that shipped, plus one spec
> amendment a ruling forces. Nothing in this contract is waiting on it.

**Spec:** `docs/superpowers/specs/2026-08-13-tapkart-design.md` (amended 2026-08-14). The spec is the binding authority; where this contract and the spec disagree, the spec wins and this contract is wrong — with one ruled exception, §16.3.
**Rulings:** `docs/superpowers/plans/2026-08-14-tapkart-plan45-rulings.md`. Binding over every draft, always.
**Triage:** `docs/superpowers/plans/2026-08-14-plan45-question-triage.md`. Its §1 GAPS and its 53 pre-ruled answers in §4 are binding as written.
**Builds on:** Plan 1 (`@tapkart/sim`, merged at `1f1f2c4`, 19 modules, 477 tests), Plan 2 (`@tapkart/protocol` + `@tapkart/net`, worktree `plan2-net` at `40ba73b` plus uncommitted Task 15b, finishing), Plan 3 (`@tapkart/content` + `@tapkart/render` + `@tapkart/game` + `apps/web`, contract locked, not executed).
**Scope:** `packages/server`, plus `WebRtcTransport` and `WebSocketTransport` in `packages/net`, plus the six `MessageKind`s and two new `WIRE_TAG`s `packages/protocol` does not yet encode. Plan 4 of 5.

Every signature in §2 was read out of real source in
`.claude/worktrees/plan2-net/packages/*/src/` on 2026-08-14 — **including the
uncommitted working tree**, which is where Task 15b lives — and is quoted, not
reconstructed. Where a name Plan 4 needs does not exist in that source yet, §2.10
says so in those words and states the exact shape Plan 2 must ship.

---

## 0. Conventions that are decided, not negotiable

Plans 1–3's conventions carry forward unchanged and are **not** restated except
where Plan 4 adds to them. In particular: extensionless imports; `import type`
under `verbatimModuleSyntax`; vitest with `globals: false` and
`environment: 'node'`; bare specifiers (`@tapkart/sim`, `@tapkart/protocol`,
`@tapkart/net`, `@tapkart/content`) across packages in `src`, never a relative
path into another package; **little-endian on the wire**; **LSB-first bit
packing**, fields written in table order; codecs never allocate their own
buffers; channel names are the exact strings `'unreliable'` and `'reliable'`;
integer fields are quantised exactly and compared with `Object.is`; a follower
never emits.

New for Plan 4:

| Convention | Value |
|---|---|
| Time in `packages/server` | **Every function that needs "now" takes `nowMs: number` as a parameter.** `Date.now()` appears in exactly one file, `packages/server/src/runtime/clock.ts`. `setInterval`/`setTimeout` appear in exactly that file too |
| Time in the two real transports | **Neither reads a clock at all.** They are event-driven: a datagram arrives, a callback fires. Round-trip timing is `packages/net/src/liveness.ts`, pure over an injected `nowMs` |
| Time inside the shadow | **Wall milliseconds, passed in** (F-P4-22). `ShadowLoop.tick(nowMs)` carries the whole host-loss detector; `SimState.tick` is produced by `advanceAccumulator` and by nothing else |
| Randomness | Every mint (room code, session token, race seed) goes through `RandomSource`, injected. `node:crypto` appears in exactly one file, `packages/server/src/runtime/random.ts`. Tests pass a counting fake and assert exact strings |
| I/O | `node:fs`, `node:http`, `node:path`, `node:crypto` and `ws` are importable **only** from `packages/server/src/runtime/**` and `packages/server/src/main.ts`. No other file in the repository may import them, and §8.4's import-allowlist test proves it |
| Barrels never reach the adapters | `packages/server/src/index.ts` re-exports no file under `src/runtime/` and not `main.ts`; `packages/net/src/index.ts` re-exports no file whose name ends `-browser.ts`. Identical discipline to Plan 3 §8.2, for the identical reason |
| Hostnames | No absolute URL containing a host is constructed anywhere in `src`. The server answers with **paths**; the client builds the absolute URL from its own origin (C-3). No real LAN IP, hostname or host filesystem path appears in any file, fixture, comment or test — RFC 5737 ranges (`192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24`), `tapkart.example` and `example.invalid` only. The one deliberate exception is the public STUN default in §5.2, which is a third-party service endpoint and not anybody's infrastructure |
| Config paths | Every path in `ServerConfig` is **relative to the process working directory**. An absolute default would bake a host path into a public repo |
| Untrusted input never throws into the event loop | Every decoder that reads bytes off a socket is either total (returns `null`) or is called behind the shipped `createDatagramGuard`. A malformed frame is a counted drop; it never takes the process down. §8 names which function is which |
| Errors are values in the pure layer | `parseSignal` returns `null`, `decodeWsFrame` returns `null`, `resolveRoute` returns a `Route`, `handleHello` returns a `WelcomeMessage` carrying a `JoinResult`. Only the registry's three capacity errors are thrown, and only across a boundary that catches them |
| Cold path returns, hot path fills `out` | P4 Q10. `decodeSnapshot`/`decodeInput`/`decodeEvents`/`decodeCheckpoint` fill a caller-owned target and return `void`; the six lobby/control kinds return a fresh object, because three of them carry strings and allocate regardless. The split is drawn at the tag ranges Plan 2 already chose |

### 0a. The rule that decides whether this plan is testable

Every module in `packages/server` and every new module in `packages/net` is one
of exactly two kinds, and the file says which in its first line:

- **Pure** — a function of its arguments and injected collaborators. No socket,
  no `RTCPeerConnection`, no filesystem, no clock, no timer. **Testable
  headlessly, and every one of them is tested.**
- **Adapter** — the thin layer that hands plain data to a real syscall. Contains
  no decisions: no branching on game or room state, no arithmetic beyond unit
  conversion, no policy. **Owner-verified, plus exactly one composition smoke
  test** (§0b).

A conditional in an adapter is a contract violation, because it is a decision CI
cannot see. §8 enumerates both sides, file by file, with nothing left in between.
There are exactly **seven** adapter files in Plan 4, plus one composition root,
and §8.2 lists them.

**The specific failure this rule exists to prevent:** a `WebRtcTransport` that
can only be exercised by opening two browsers. It is avoided by
`RtcConnectionLike` (§5.2) — the transport never names `RTCPeerConnection`, it
takes an interface, and the test passes a two-sided in-memory implementation that
completes an offer/answer/ICE exchange in-process, in microseconds, with no UDP.

### 0b. The one loopback bind, named (F-P4-46)

The rule is **"no *external* network in tests"**, not "no network". Exactly one
test in the repository may bind a socket, it binds `127.0.0.1:0`, and it is:

```
packages/server/test/runtime-smoke.test.ts
  › 'the composition root answers /healthz and completes a WebSocket upgrade on an ephemeral loopback port'
```

It exists because without it `runtime/http.ts` + `runtime/ws.ts` + `main.ts` —
the composition root — is the one thing CI never executes, and untested
composition roots are where this project has repeatedly found its gaps: the host
had no input path at all and nobody noticed for a whole plan. An ephemeral
loopback bind is hermetic and leaves the machine untouched.

**What it asserts, exhaustively:** the process starts, `GET /healthz` returns 200,
a WebSocket upgrade on `WS_PATH` completes, and `close()` resolves. It asserts
**nothing** about rooms, routing, racing, promotion or the lobby — all of which
are asserted in the pure layer against fakes. No other test opens a socket, and
`packages/server/test/no-network.test.ts` greps every other test file for
`listen(`, `createServer`, `new WebSocket` and `fetch(` and fails on a hit.

---

## 1. Dependency direction — stated, because §3 of the spec binds it

Spec §3, verbatim:

> `sim` and `protocol` depend on nothing and on each other not at all. `net`
> depends on both. `game` depends on `net`, `render`, and `sim`. `render` reads
> `sim` types and track geometry but never mutates simulation state. `server`
> depends on `sim`, `protocol`, and `net`.

Resolved into `package.json` `dependencies`, exactly:

| Package | Depends on |
|---|---|
| `@tapkart/server` | `@tapkart/sim`, `@tapkart/protocol`, `@tapkart/net`, `@tapkart/content`, `ws` |
| `@tapkart/net` (unchanged) | `@tapkart/sim`, `@tapkart/protocol` |
| `@tapkart/protocol` (unchanged) | `@tapkart/sim` |

**`@tapkart/content` is the fifth dependency and it is the reason this plan can
exist at all.** The shadow authority must run `step()` in lockstep with the host,
which means it needs the *identical* `Tuning`, the identical `CharacterStats[]`
and the same six tracks. Plan 3's ruling R46 moved all of it out of `game` into a
package that depends only on `sim` and carries no DOM and no `three`
(Plan 3 §1, §3a). Without R46 the shadow authority is unbuildable as packaged,
and the alternatives are a second copy of the tuning table that drifts silently
or a dependency edge the spec forbids. This also deletes the draft's
`TRACKS_DIR`, `loadTracks`, `listDir` and `readFile` injection outright: the
server does not read track JSON from disk, it imports it (triage §5, P4 Q2).

**Nothing depends on `@tapkart/server`.** In particular `game` does not: the
browser talks to the server over the wire, never over an import. A test that
wants both ends in one process constructs `RoomHub` and a `RoomClient` directly;
that is a `server` test importing `net`, which the direction permits.

**`server` does not depend on `@tapkart/game` or `@tapkart/render`.** This is
load-bearing, not tidy: `game` pulls `three` (Plan 3 §10), and a server that
imports `three` is a server that fails to start on a headless box. §8.4's
import-allowlist test makes it mechanical rather than a matter of discipline.

**`@tapkart/invite` (Plan 5) depends on `@tapkart/protocol`.** C-7 says so
explicitly: `ROOM_CODE_ALPHABET` and the `/r/` prefix live in `protocol`, and
"`game`, `server` and `invite` may all depend on `protocol`." Plan 5's draft
described `invite` as zero-dependency; on this one edge that description is
superseded. `protocol` depends only on `@tapkart/sim` for its types, so the graph
stays acyclic.

### 1a. What a later plan is explicitly allowed to do to Plan 4's packages

Stated here so no Plan 5 task stalls asking permission:

- **Plan 5 may add `docker/`, `Dockerfile`, `compose.yaml` and a CI workflow that
  consume `packages/server/dist/main.mjs`** — the esbuild bundle §10.3 defines.
  Plan 5 owns the image; Plan 4 owns the bundle script and nothing about
  containers.
- **Plan 5 may add specs under `e2e/`** and may add the CI job that runs
  `npm run test:e2e`. Plan 4 creates `playwright.config.ts`, the `e2e/` directory
  and the first spec (C-4); Plan 5 adds to it.
- **Plan 5 may write files into `${STATIC_ROOT}/.well-known/`** at container
  start (C-2). Plan 4 serves that directory and asserts the route; Plan 5
  generates the bytes and asserts their content.
- **Plan 5's tests may import `ENV_SCHEMA` from `@tapkart/server`** and assert the
  Dockerfile, the compose file and the README table against it (C-6). That is a
  test-only import and does not invert any arrow — nothing in `src` anywhere
  depends on `server`.

What remains forbidden, in any plan: `server` importing `game`, `render` or
`three`; anything importing `server` from `src`; and `sim`, `protocol`, `net` or
`content` acquiring a DOM type (Plan 3 §10.1, R35).

---

## 2. Signatures Plans 1–3 export that Plan 4 consumes

All quoted from real source in `.claude/worktrees/plan2-net/packages/`, read
2026-08-14, working tree included. Line numbers are from the working tree as
read; where the draft of this contract quoted something that never existed or has
since drifted, §15 records the correction rather than leaving it inline.

### 2.1 `@tapkart/net` — the interface the two real transports implement

`src/transport.ts:11-18`, quoted exactly. **Plan 4 adds implementations and
changes not one character of this:**

```ts
export interface Transport {
  send(channel: ChannelName, peerId: string, data: Uint8Array): void
  broadcast(channel: ChannelName, data: Uint8Array): void
  onMessage(cb: (peerId: string, channel: ChannelName, data: Uint8Array) => void): void
  onPeerLost(cb: (peerId: string) => void): void
  peers(): string[]
  close(): void
}
```

Six behaviours this interface does not state, which `LoopbackTransport`
(`src/loopback.ts:62-90`) exhibits and which Plan 4's implementations **must**
match, because `AuthorityLoop`, `ClientLoop`, `ShadowLoop` and `RoomClient` all
depend on them. **These six are hereby part of the `Transport` contract**
(P4 Q40) and §9.2 names the shared conformance suite that asserts them against
all five implementations:

1. **`onMessage` registers an *additional* listener; it never replaces one.**
   `loopback.ts:75-77` pushes onto `messageCbs`, and so does `local.ts:97-103`.
   Plan 4 needs this absolutely: on a guest, `ClientLoop` and `RoomClient` both
   subscribe to the same transport, and a replace-semantics implementation
   silently deletes the lobby.
2. `onPeerLost` likewise appends (`loopback.ts:78-80`).
3. `broadcast` reaches **every** peer the transport holds, and the sender is
   never one of them.
4. `send`'s `peerId` must be one of `peers()`; an unknown peer is a **no-op, not
   a throw**.
5. `close()` is idempotent, and after it `peers()` is `[]` and nothing is
   delivered in either direction (`loopback.ts:46-48, 85-88`).
6. Delivered `data` is not retained by the transport after the callback returns;
   a receiver that needs the bytes past the callback copies them. Every shipped
   sender already `.slice()`s for exactly this reason
   (`authority.ts:208`, `authority.ts:214`, `shadow.ts:684`, `shadow.ts:690`,
   `client.ts:498`, `local.ts:131`).

### 2.2 `@tapkart/net` — `ShadowLoop`, as shipped

**`packages/net/src/shadow.ts` exists.** It shipped at `40ba73b`
("feat(net): add ShadowLoop, the server's per-room shadow authority"), is 615
lines, is re-exported from `packages/net/src/index.ts:17`, and Task 15b has
already amended it further. The draft of this contract asserted the opposite and
built §3.2, §6.9, §7.1 and five open questions on top of that assertion; all of
it is deleted. Quoted from source:

```ts
// src/shadow.ts:49, 52, 59, 85, 87, 107, 168, 282, 340, 352, 437, 516, 572, 576, 624, 679, 687
/** Spec §5, verbatim: host loss after 1.5 s with no snapshot. MILLISECONDS,
 *  not the 90 ticks this constant was until Task 15c item C. */
export const HOST_TIMEOUT_MS = 1500
export const SNAPSHOT_PERIOD_TICKS = 3
export const SHADOW_HISTORY_TICKS = 24
export const AUTHORITY_CHANGE_BYTES = 10      // = HEADER_BYTES(2) + 8
export function encodeAuthorityChange(out: Uint8Array, tick: number, eventSeq: number): number
export function decodeAuthorityChange(buf: Uint8Array): { tick: number; eventSeq: number }

export class ShadowLoop {
  constructor(ctx: SimContext, state: SimState, t: Transport)
  /** `nowMs` is the scheduler's wall clock, injected — the loop reads no clock.
   *  It is the host-loss timer's only time source and the only argument. */
  tick(nowMs: number): void
  promote(tick: number): void
  private onPeerLost(peerId: string): void
  private onDatagram(peerId: string, kind: MessageKind, payload: Uint8Array): void
  private reconcile(snap: WireSnapshot): void
  private diverges(local: SimState, snap: WireSnapshot): boolean
  private raiseToEventSeqFloor(): void
  private broadcastSnapshot(): void
  private broadcastEvents(events: AuthEvent[]): void
}
```

**Seven facts about the shipped class that the server is built on, none of which
Plan 4 may re-implement:**

0. **The host-loss detector is inside `tick(nowMs)` and it counts wall time.**
   `shadow.ts:711-513`:
   ```ts
   // Wall time since the last tick that held a snapshot - NOT a count of ticks
   // (item C). The two agree only while the scheduler is healthy, and they
   // disagree exactly when this check matters.
   if (nowMs - this.lastSnapshotAtMs >= HOST_TIMEOUT_MS) this.promote(this.live.tick)
   ```
   with `lastSnapshotAtMs` seeded on the first tick (`shadow.ts:443-446`) so the
   gap between construction and a room's first tick is not read as host silence.
   **There is no separate `poll` method and Plan 4 must not ask for one**: the
   server polls at 125 Hz and the accumulator emits ticks at 60 Hz, so `tick` is
   called about sixty times a second whatever the backlog does, and a clamped
   burst still carries a truthful `nowMs`. F-P4-22's objection was to counting
   *the loop's own ticks*, and this counts milliseconds.

1. **`promote()` broadcasts `authorityChange` itself.** `shadow.ts:538-540`:
   ```ts
   const out = new Uint8Array(AUTHORITY_CHANGE_BYTES)
   encodeAuthorityChange(out, tick, this.live.nextEventSeq)
   this.t.broadcast('reliable', out)
   ```
   The server never encodes or sends that message. It is not in `protocol`, it
   does not take a message struct, and it writes its own 2-byte header.
2. **`promote()` flips its own `ctx.isLeader`** (`shadow.ts:749`) and re-seeds the
   item PRNG through `sim`'s own `promotionCursor` (`shadow.ts:748`):
   ```ts
   this.live.rngCursor = promotionCursor(this.live.raceSeed, tick)
   this.ctx.isLeader = true
   ```
   `raceSeed` is never written, which is what keeps `statesEqual` between a host
   and a shadow meaningful — the exact property draft Q21 was written to protect.
3. **It broadcasts snapshots at `tick % SNAPSHOT_PERIOD_TICKS === 0` and events
   the tick they occur, after promotion** (`shadow.ts:504-509`), on
   `'unreliable'` and `'reliable'` respectively — the same cadences and the same
   channels `AuthorityLoop` uses.
4. **`reconcile` is private and is called from `tick()`** (`shadow.ts:576`, called at `shadow.ts:465`).
   Draft Q29 is answered by the source.
5. **It already holds an `eventSeqFloor`** — the highest `eventSeq` observed in
   *any* decoded snapshot header, raised into `live.nextEventSeq` at the instant
   of promotion and never while following (`shadow.ts:280, 399, 530, 572-573`).
   The draft's "eventSeq continuity is already emergent from `applyEvent`" is
   incomplete: an event lost in flight leaves a follower's counter *behind* the
   host's, and without the floor a newly promoted authority re-issues sequence
   numbers every peer then silently drops.
6. **It does not copy its `SimContext`.** `shadow.ts:283` is `this.ctx = ctx`,
   and `promote()` writes `this.ctx.isLeader = true` into the **caller's**
   object. `AuthorityLoop` (`authority.ts:95`) and `ClientLoop`
   (`client.ts:312`) both spread-copy theirs; `ShadowLoop` does not. §7 turns
   this into a sole-writer rule with teeth, because a memoised or shared
   `SimContext` would let one room's promotion flip `isLeader` for every other
   room in the process.

### 2.3 `@tapkart/net` — `AuthorityLoop`, as shipped

```ts
// src/authority.ts:58, 92, 112, 125, 177, 187
export class AuthorityLoop {
  constructor(ctx: SimContext, state: SimState, t: Transport)
  state(): SimState
  tick(): void
}
```

Facts the server and the host both depend on:

- It forces `isLeader: true` on a **copy** of the caller's `ctx`
  (`authority.ts:95`), so nothing it does is visible in the caller's object.
- It publishes `lastProcessedInputTick` written **in `tick()`, never in
  `onMessage`** (`authority.ts:80, 198`), and broadcasts a snapshot when
  `this.live.tick % 3 === 0` (`authority.ts:12, 211`).
- **Reclaim shipped.** `authority.ts:159`:
  `if (!this.live.karts[playerId].connected) this.live.karts[playerId].connected = true`.
  The draft's §5.10 proposed this as a one-line change Plan 4 must make and said
  it had "no implementation anywhere today". It has one, and `ShadowLoop` has the
  mirror at `shadow.ts:367`. Plan 4 writes neither. What Plan 4 *does* add is the
  authorisation the shipped comment defers to it (`authority.ts:156-158`:
  *"identity by claim … Plan 4's lobby handshake is where reclaiming a seat gets
  authenticated"*) — §4.7.
- It dispatches on `kind` **and** on `channel` (`authority.ts:126-134`), so a
  promoted shadow's snapshots on the same channels are ignored rather than
  mis-parsed.
- It has **no demotion path**. That is GAP-3, ruled by F-P4-23, and is a §2.10
  gate item.

### 2.4 `@tapkart/net` — `ClientLoop` and the interpolator, as shipped

```ts
// src/client.ts:49, 259, 312, 463, 526, 534, 639, 681, 707, 710, 713, 715, 724, 746, 766
export const TICK_MS = 1000 / TICK_HZ
export const REMOTE_INTERP_DELAY_MS = 100
export const REMOTE_BUFFER_CAPACITY = 8
export const REMOTE_EXTRAPOLATE_CAP_MS = 200

export class ClientLoop {
  constructor(ctx: SimContext, playerId: number, t: Transport)
  tick(localIntent: Intent): void
  corrections(): number
  state(): SimState
}

export interface RemoteKeyframe { recvAtMs: number; karts: WireKart[]; entities: WireEntity[]; entityCount: number }
export interface RemoteSample { position: { x: number; y: number; z: number }; heading: number; kart: WireKart }
export interface RemoteEntitySample { position: { x: number; y: number; z: number }; heading: number; entity: WireEntity }

export class RemoteInterpolator {
  push(kf: RemoteKeyframe): void
  sampleKart(playerId: number, nowMs: number): RemoteSample | null
  sampleEntity(entityId: number, nowMs: number): RemoteEntitySample | null
  liveEntityIds(out: Int32Array): number
}

export function remoteInterpolatorOf(client: ClientLoop): RemoteInterpolator
export function correctionDeltaOf(client: ClientLoop, outPos: Vec3): number | null
```

Every one of Plan 3 §2.5's `client.ts` gate items is therefore **already
shipped** — `TICK_MS`, the three interpolator constants, `RemoteSample.kart`,
`RemoteKeyframe.entities`/`entityCount`, `sampleEntity`, `liveEntityIds`,
`remoteInterpolatorOf`, `correctionDeltaOf`.

Two facts Plan 4 must not fight:

- The constructor still builds `createState(this.ctx, 0, ZERO_CHARACTER_IDX)`
  with seed 0 and an all-zero `characterIdx` (`client.ts:316`), because Plan 2
  has no `start` message to be told either by. **It no longer forces
  `phase = 'racing'`** — Task 15c item A landed and the loop adopts `snap.phase`
  on every accepted snapshot (`client.ts:535`, `client.ts:591`,
  `client.ts:638`), which is what makes a guest sit through the countdown
  instead of driving off three seconds early. `beginRace` (§4.10) replaces the
  seed and the seat map; it does not touch the phase.
- `onDatagram` (`client.ts:375-432`) handles `snapshot` on `'unreliable'` and
  `events` on `'reliable'` and **ignores every other kind**, including
  `checkpoint` and `authorityChange`. Plan 4 adds both (§4.10).

### 2.5 `@tapkart/net` — the receive guard, the local-input decorator, loopback, apply

```ts
// src/receive.ts:47, 83, 130   — Task 15b, the answer to GAP-2
export interface DatagramGuard {
  wrap(handle: (peerId: string, channel: ChannelName, kind: MessageKind, payload: Uint8Array) => void):
    (peerId: string, channel: ChannelName, data: Uint8Array) => void
  dropped(): number
}
export function createDatagramGuard(owner: object): DatagramGuard
export function droppedDatagramsOf(loop: object): number

// src/local.ts:11, 28, 41, 78   — Task 15b (R42)
export const LOCAL_PEER_ID = 'local'
export function createNullTransport(): Transport
export interface LocalInputTransport extends Transport {
  submitLocalInput(playerId: number, intent: Intent): void
}
export function withLocalInput(t: Transport): LocalInputTransport

// src/loopback.ts:5, 32
export interface LoopbackOptions { latencyMs: number; jitterMs: number; lossRate: number; seed: number }
export function makeLoopbackPair(opts: LoopbackOptions): { a: Transport; b: Transport; pump(nowMs: number): void }

// src/apply.ts:30
export function applyEvent(ctx: SimContext, state: SimState, ev: AuthEvent): boolean   // false if already applied

// src/clock.ts:20, 39, 46, 50, 83   — Task 15c item B (F-P4-7), ONE home for both
export const TICK_MS = 1000 / TICK_HZ
export const MAX_CATCHUP_TICKS = 5
export interface TickAccumulator { residualMs: number }
export function makeTickAccumulator(): TickAccumulator
/** Takes ELAPSED milliseconds, not a timestamp. Returns whole 60 Hz ticks to run
 *  and carries the sub-tick remainder in `acc`. Sole writer of TickAccumulator.
 *  Across a clamp the excess is DISCARDED, not banked. */
export function advanceAccumulator(acc: TickAccumulator, elapsedMs: number): number
```

Three details of `clock.ts` that the server's loop shape depends on and that
differ from the draft's `server/ticker.ts`:

- **`MAX_CATCHUP_TICKS` is 5, not 8.** 83 ms of simulation per call — about five
  ordinary frames, so a normal hitch is absorbed and the catch-up itself cannot
  cost more than the frame it is catching up to.
- **`advanceAccumulator(acc, elapsedMs)` takes a delta, not a `nowMs`.**
  `TickAccumulator` has one field, `residualMs`, and no `lastNowMs`: the caller
  owns the previous timestamp. `stepRace` (§5.8) is what holds it.
- **The clamp discards.** `residualMs` goes to 0, not to
  `backlog - MAX_CATCHUP_TICKS * TICK_MS`, because banking it makes the next call
  emit another full burst and the stall echoes for as many frames as it took.
  The file's own comment names the consequence this contract depends on: *"Those
  discarded milliseconds are wall time this simulation will never run, which is
  precisely why a host-loss detector must count wall time and not ticks."*

**The guard is the whole of GAP-2's fix and all three loops already use it**
(`authority.ts:102`, `client.ts:357`, `shadow.ts:320`). It wraps the header parse
**and** the body decode, so a truncated `checkpoint` — `decodeCheckpoint` throws
on an `itemBoxes` length mismatch, `checkpoint.ts:171-175` — is a counted drop
rather than a dead client. Draft Q27's "crashes the client rather than desyncing
it" is no longer reachable. The rule the guard enforces, verbatim from
`receive.ts:8-9`: **"A DATAGRAM THAT CANNOT BE DECODED IS A DATAGRAM THAT NEVER
ARRIVED."** Plan 4's two real transports are the reason it exists, and every new
decoder Plan 4 writes is either total or lives behind it.

`withLocalInput`'s shipped method is **`submitLocalInput(playerId, intent)`**,
taking the tick from `intent.tick`. Plan 3 §2.5 specifies
`deliverLocalInput(playerId, intent, tick)` on a module named `localinput.ts`.
That divergence is §16.1 and is the controller's to settle; Plan 4 codes against
whichever name survives and touches neither file.

### 2.6 `@tapkart/protocol` — what already exists

```ts
// src/types.ts:3, 23, 40, 111   — Task 15c items A and D have landed
export const PROTOCOL_VERSION = 1                       // becomes 2 — §3.0
export type ChannelName = 'unreliable' | 'reliable'
export type MessageKind =
  | 'hello' | 'welcome' | 'lobby' | 'start' | 'clientUpdate'
  | 'input' | 'snapshot' | 'events' | 'checkpoint' | 'resyncRequest'
  | 'authorityChange' | 'ping' | 'pong'
export interface WireHeader { kind: MessageKind; protocolVersion: number }
export const WIRE_TAG = {
  hello: 0x01, welcome: 0x02, lobby: 0x03, start: 0x04, clientUpdate: 0x05,
  input: 0x10, snapshot: 0x11, events: 0x12, checkpoint: 0x13, resyncRequest: 0x14,
  authorityChange: 0x20, ping: 0x30, pong: 0x31,
} as const
export function encodeHeader(out: Uint8Array, kind: MessageKind): number   // writes [tag, version], returns 2
export function decodeHeader(buf: Uint8Array): WireHeader                  // throws on unknown tag or version mismatch
export interface WireKart { /* 21 fields, spec §5's table */ }
export interface WireEntity { entityId; kind; ownerId; position; velocity; heading; ttl }
export interface WireSnapshot {
  tick; eventSeq; lastProcessedInputTick; karts; entities; entityCount
  phase: RacePhase        // Task 15c item A: 2 bits, IN THE HEADER, once per snapshot
}
export interface InputDatagram { playerId: number; intents: Intent[] }

// src/room.ts:20, 33, 49, 65, 83, 98   — Task 15c item E (C-1, C-7, F-P4-34)
export const ROOM_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
export const ROOM_CODE_LENGTH = 5
export const LOBBY_PATH_PREFIX = '/r/'
export function normalizeRoomCode(input: string): string   // trim + uppercase. Total.
export function isValidRoomCode(code: string): boolean     // canonical form only
export function lobbyPathFor(code: string): string         // throws on an invalid code

// src/bits.ts:11, 65
export class BitWriter { constructor(buf: Uint8Array); reset(): void
  writeBits(value: number, bits: number): void
  writeFloatQ(value: number, min: number, max: number, bits: number): void
  byteLength(): number }
export class BitReader { constructor(buf: Uint8Array); reset(): void
  readBits(bits: number): number            // THROWS past the end of the buffer — Task 15b
  readFloatQ(min: number, max: number, bits: number): number }

// src/quant.ts:3, 10, 17, 32, 41, 56, 72
export const WORLD_HALF = 1024
export function quantStep(min: number, max: number, bits: number): number
export interface QuantField { readonly min: number; readonly max: number; readonly bits: number }
export interface QuantTable { position; velocity; heading; angularVelocity; driftCharge; t }
export interface EpsilonTable { position; velocity; heading; angularVelocity; driftCharge; t }
export const Q: QuantTable
export const EPS: EpsilonTable

// src/snapshot.ts:76, 154, 271
export function encodeSnapshot(out: Uint8Array, state: SimState, lastProcessedInputTick: number[]): number
export function decodeSnapshot(buf: Uint8Array, out: WireSnapshot): void
export function applySnapshotToState(snap: WireSnapshot, dst: SimState): void

// src/checkpoint.ts:37, 114
export function encodeCheckpoint(out: Uint8Array, state: SimState): number
export function decodeCheckpoint(buf: Uint8Array, dst: SimState): void

// src/events.ts:25, 47
export function encodeEvents(out: Uint8Array, events: AuthEvent[]): number
export function decodeEvents(buf: Uint8Array, out: AuthEvent[]): void

// src/input.ts:13, 35, 58
export const INPUT_REDUNDANCY = 8
export function encodeInput(out: Uint8Array, playerId: number, intents: Intent[]): number
export function decodeInput(buf: Uint8Array, out: InputDatagram): void
```

`WIRE_TAG` names **thirteen** kinds since Task 15c item D added `clientUpdate`
and `resyncRequest` (F-P4-11). **Seven have no codec** — `hello`, `welcome`,
`lobby`, `start`, `clientUpdate`, `resyncRequest`, `ping`/`pong` — and
`authorityChange`'s codec lives in `net/src/shadow.ts`, not here (§2.2). The
draft said "seven of eleven" and assigned `authorityChange` to a
`protocol/src/control.ts` at 8 bytes with no header; the shipped one is 10 bytes
and writes its own header, and P4 Q30 confirms it frozen as shipped.

**`protocol/src/room.ts` already exists** and its three constants are the ones
this contract codes against — including an alphabet that is neither of the two
any draft proposed (§3.2).

`BitWriter` **neither throws nor grows on overflow** — a typed-array write past
the end is a silent no-op (`authority.ts:26-28` says so). Every buffer size in §3
and §5 is therefore derived from a worst case and asserted by a test that encodes
a maximal message, never guessed.

`encodeCheckpoint` writes **one float64 per field, little-endian, in `SimState`
declaration order** (`checkpoint.ts:12-22`). Counted against `SimState` and a
6-box track: 8 header fields + 8 karts × 24 + 32 entities × 12 + (1 + 2 × boxes)
+ 8 `finishedOrder` + 8 × 6 `heldBotIntent` + 8 `heldBotTick` = **661 fields =
5,288 B**, growing 16 B per additional item box. §6.3's checkpoint buffer is
sized from that number and a test asserts it.

### 2.7 `@tapkart/sim` — what the shadow needs

```ts
// src/types.ts:3-8, 151-157
export const TICK_HZ = 60
export const TICK_DT = 1 / 60
export const MAX_KARTS = 8
export const MAX_ENTITIES = 32
export const COUNTDOWN_TICKS = 180
export interface SimContext { track: Track; query: TrackQuery; tuning: Tuning; characters: CharacterStats[]; isLeader: boolean }

// src/state.ts:31, 152, 249; src/replay.ts:75; src/rng.ts:25, 51; src/track.ts:186, 463; src/phase.ts:20
export function createState(ctx: SimContext, seed: number, characterIdx: number[]): SimState
export function cloneState(src: SimState, dst: SimState): void
export function statesEqual(a: SimState, b: SimState): boolean
export function allocStateLike(ctx: SimContext, src: SimState): SimState
export function makeIntentBuffer(): Intent[]
export function rngAt(seed: number, cursor: number): number
export function promotionCursor(raceSeed: number, promotionTick: number): number
export function validateTrack(track: Track): string[]
export function buildTrackQuery(track: Track): TrackQuery

// src/step.ts:98
export function step(ctx: SimContext, prev: SimState, next: SimState, inputs: Intent[], events: AuthEvent[]): void
```

`promotionCursor` (`rng.ts:51-56`) is the PRNG re-seed formula draft Q21 said was
"unwritten anywhere". It shipped with Plan 1's `rng.ts` amendment, it is called
from `ShadowLoop.promote`, and its docstring states the property Plan 4 relies
on: *"Deterministic and peer-recomputable: every client knows `raceSeed` and
reads `promotionTick` off the `authorityChange` message, so nobody has to be told
it."*

Two facts from `createState` (`state.ts:59-83`) that the `start` message exists
to carry:

- **Every seat is created `isBot: true, connected: false`.** Nothing in `sim`
  knows which seats are human. The authority, the shadow and every client must be
  told, identically, or their bot AI drives different karts.
- The state begins at `tick: 0, phase: 'countdown'`, and `resolveInputs`
  (`phase.ts:64`) freezes every kart while `phase === 'countdown'`. Countdown is
  therefore free: everyone who calls `createState` with the same seed and the
  same seat map is aligned for the first 180 ticks whatever the network does.

### 2.8 `@tapkart/content` — the shipped data (Plan 3 §3a, R46)

```ts
// packages/content/src/index.ts re-exports:
export const TUNING: Readonly<Tuning>
export const CHARACTERS: readonly CharacterStats[]
export const TRACK_MANIFEST: readonly TrackManifestEntry[]      // six ids, menu order
export interface LoadedTrack { track: Track; query: TrackQuery; theme: TrackTheme }
export function loadTrack(id: string): LoadedTrack              // total over TRACK_MANIFEST ids, memoised
```

`loadTrack` **memoises**, so the `TrackQuery` arc table is built once per track
per process — which is right, and which is exactly why §7's `SimContext`
freshness rule exists: the memoised `LoadedTrack` may be shared between rooms,
but the `SimContext` built from it may not.

`content` is bundler-free by construction (Plan 3 §3a.1: 28 static JSON imports
with `with { type: 'json' }`, chosen *because* `server` runs under a plain
Node/esbuild toolchain). §10.3's bundle embeds all six tracks; the server opens no
track file at runtime.

### 2.9 `@tapkart/game` — what Plan 4 must not break

`game` is authored in parallel with this plan against a locked contract. Plan 4
must agree with it on exactly three things:

- **`createSession(opts: SessionOptions)`** (Plan 3 §5.10) takes
  `transport: Transport` (never `null`) and `localPlayerId: number`, and
  constructs `ClientLoop(ctx, playerId, t)` for a guest. `beginRace` is
  **additive** precisely so that signature survives (P4 Q26).
- **`game/src/roomcode.ts` is deleted.** Plan 3 §5.8's four symbols move to
  `@tapkart/protocol` (C-7), and `ROOM_CODE_LENGTH` becomes **5** (F-P4-34).
  `game` imports them by bare specifier. This is an amendment to a locked
  contract and it is recorded in §14 and §16.3.
- **`game/src/clock.ts` imports from `@tapkart/net/clock`** rather than defining
  its own (F-P4-7, shipped). Plan 3 §5.1's `TICK_MS`, `MAX_CATCHUP_TICKS`,
  `TickAccumulator`, `createAccumulator` and `advanceAccumulator` are replaced by
  `net`'s — and note the two differences §15.10 records: the constant is **5**,
  not 8, and `advanceAccumulator` takes an **elapsed delta**, not a `nowMs`, over
  a `TickAccumulator` with no `lastNowMs`. `accumulatorAlpha` and `renderNowMs`
  stay in `game`, because they are render concerns and the server has no use for
  either.

### 2.10 The gate: what Plan 2 must ship before Plan 4's first import compiles

**Plan 2 Tasks 15b and 15c are in flight, and the worktree moved while this
contract was being written.** 15b is in the working tree, uncommitted. 15c is
being written now: items A (`WireSnapshot.phase`), B (`net/src/clock.ts`),
C (the millisecond host-loss timer), D (the two new `WIRE_TAG`s) and
E (`protocol/src/room.ts`) had all landed by the time §2 was re-read, and every
signature above is quoted from that state.

Two consequences, stated because they change how this section must be read:

- **Line numbers in §2 are evidence, not contract.** They were accurate when
  read and several had already moved by 40–70 lines within the same session.
  What binds is the **signature and the behaviour**; a citation that has drifted
  is a stale pointer, not a contradiction.
- **The gate is now four items, not ten.** Six of the ten shapes this contract
  needs arrived during authoring.

The **Source** column separates what a ruling requires from what this contract
derives, so the controller can see which is which. If Plan 2 ships a different
shape for a pending item, the fix is in Plan 2 — **Plan 4 does not adapt, and no
Plan 4 task may write into `shadow.ts`, `authority.ts` or `clock.ts`.**

| # | Still pending | Source |
|---|---|---|
| G1 | `PROTOCOL_VERSION` becomes `2`. `ROOM_CODE_LENGTH` went 4 → 5 in Task 15c item E, which changes `hello`'s bit layout, so the wire is not backward compatible and the version byte must say so | derived — §3.0 |
| G2 | `AuthorityLoop` **demotes** on an `authorityChange` it did not send: stops broadcasting snapshots and events, stops emitting. `authority.ts` has no `demote`, no `stop` and no handler for the kind — its `onDatagram` still returns early on anything that is not `input` on `'unreliable'` | F-P4-23, GAP-3 |
| G3 | `ShadowLoop.promotionTick(): number`, `-1` until promoted. A read-only accessor with no policy in it; the server needs it for `RaceRuntime` bookkeeping, one log line, and `seatMapOf`'s `isAuthority` (§5.5), and today `promoted` is a private field with no reader | derived — §5.8 |
| G4 | `playerIdOfInput(buf: Uint8Array): number` in `protocol/src/input.ts` — the first 3 bits of an input body, `-1` on a buffer too short to hold them. Plan 4 may write this one itself: `input.ts` is not a file 15c touches, and §4.7 is the only caller | derived — §4.7 |

**Landed during authoring, and quoted above rather than demanded here:**

| Shape | Where |
|---|---|
| `WIRE_TAG.clientUpdate = 0x05`, `WIRE_TAG.resyncRequest = 0x14`, both in `MessageKind` | `types.ts:23, 40` |
| `WireSnapshot.phase: RacePhase`, 2 bits, **in the header** — exactly the placement §3.6 derives | `types.ts:111`, `snapshot.ts:48, 101, 176, 296` |
| `HOST_TIMEOUT_MS = 1500` and a wall-clock host-loss check inside `tick(nowMs)` | `shadow.ts:49, 437, 511-513` |
| `net/src/clock.ts`: `TICK_MS`, `MAX_CATCHUP_TICKS = 5`, `TickAccumulator`, `makeTickAccumulator`, `advanceAccumulator(acc, elapsedMs)` | `clock.ts:20, 39, 46, 50, 83` |
| `net/src/index.ts` re-exports `./clock` | `index.ts:16` |
| `ROOM_CODE_ALPHABET`, `ROOM_CODE_LENGTH = 5`, `LOBBY_PATH_PREFIX = '/r/'`, `normalizeRoomCode`, `isValidRoomCode`, `lobbyPathFor` in `protocol` | `room.ts:20, 33, 49, 65, 83, 98` |
| `ClientLoop` adopts `snap.phase` and no longer forces `'racing'` | `client.ts:316, 535, 591, 638` |

**Already in the tree before this contract began**, listed because the task brief
named them and a reader must be able to tell shipped from pending:
`withLocalInput`, `createNullTransport`, `LocalInputTransport`, `LOCAL_PEER_ID`
(`local.ts`); `correctionDeltaOf`, `RemoteSample.kart`, `RemoteKeyframe.entities`,
`sampleEntity`, `liveEntityIds` (`client.ts`) and `TICK_MS` (now `clock.ts`, same
binding, still on the barrel); the shared non-throwing decode guard and its drop
counters (`receive.ts`) and `BitReader` rejecting reads past the end of its buffer
(`bits.ts:104-108`); distinct pending buffers for the snapshot and checkpoint
decode paths (`shadow.ts:203-228`) and for `ClientLoop`'s snapshot path
(`client.ts:297-300`); `ShadowLoop.onPeerLost` (`shadow.ts:340`); the
`max(own, snap.eventSeq)` floor (`shadow.ts:280, 399, 572`); and
`AuthorityLoop`/`ShadowLoop` restoring `connected` on reconnect
(`authority.ts:159`, `shadow.ts:367`).

**Why the host-loss timer's shape is `tick(nowMs)` and not the `poll(elapsedMs)`
this contract first specified.** F-P4-22's objection is to a counter that
*"stalls exactly when `stepRace` runs zero ticks or clamps at
`MAX_CATCHUP_TICKS`"*. Task 15c's answer keeps the check inside `tick` and
changes what it counts — wall milliseconds since the last tick that held a
snapshot, from an injected `nowMs`. That satisfies the ruling: the clamp case,
which is the one spec §11 names, now promotes on time because `nowMs` is truthful
however few ticks ran. The residual case — `advanceAccumulator` returning zero
for 1.5 s straight — would need the process to be running the hub's 125 Hz poll
while emitting no ticks at all for ninety consecutive tick-intervals, which the
5-tick clamp at a 125 Hz poll rate cannot produce. **One detector, wall-clock,
in the loop with the tested promotion**, which is what the ruling asked for.

**There is exactly one host-loss detector in the system.** The draft's
`maybePromote`, `liveness.hostLost`, `noteHostSnapshot`, `HostWatch`,
`createHostWatch`, `HOST_LOSS_MISSED_SNAPSHOTS` and `RaceRuntime.hostWatch` are
all deleted (F-P4-22, GAP-4).

**A clean socket close does not promote immediately.** Mobile browsers close
sockets on backgrounding routinely and 1.5 s is already the spec's answer. A
clean close *does* immediately mark that player's kart bot-driven, through
`RoomTransport.notePeerGone` → `onPeerLost` → `connected = false`. Those are two
different concerns and this contract does not conflate them.

### 2.11 Test fixtures are still not importable by bare specifier

Plan 2 §6's rule binds unchanged: `src` imports across packages by bare specifier
only; **test** code may reach a sibling package's fixtures by relative path, and
no package's `exports` is ever widened to publish fixtures.
`packages/server/test/fixtures/server-fixtures.ts` reaches
`packages/sim/test/fixtures/track-fixtures.ts` by relative path for
`makeOvalTrack`/`makeContext`, exactly as `packages/net/test/` already does.

---

## 3. `packages/protocol` — the new message kinds

Zero dependencies except `@tapkart/sim` for its types. No DOM. No clock. Every
codec below is a pure function over a caller-owned buffer, and every one is
round-trip tested field by field including its boundary values.

### 3.0 The version bump, and why it is not optional

`ROOM_CODE_LENGTH` goes from 4 to 5 (F-P4-34), which changes `hello`'s bit layout
by five bits. That is a **breaking wire change**, so `PROTOCOL_VERSION` becomes
`2`. F-P4-11's "adding tags is additive" is true of the tags and false of the
room code, and the two land in the same release.

`decodeHeader` already throws on a version mismatch and the shipped guard turns
that into a counted drop — which is correct everywhere except one place. A v1
client's `hello` would be dropped silently and the player would watch a spinner
forever. So:

> **The version check for `hello` happens before the guard.** `RoomHub`'s frame
> handler reads `data[1]` directly (a fixed offset in a fixed-format 2-byte
> header, stable across every version this protocol will ever have), and on a
> mismatch it logs `rejected { versionMismatch }` and closes the socket with
> **`WS_CLOSE_VERSION_MISMATCH = 4001`**. A close code crosses versions; an
> encoded `welcome` does not.

`JoinResult.versionMismatch` survives for the same-version-malformed case.
`RoomClient` maps close code 4001 onto `error = 'versionMismatch'`, which is what
puts "this app is out of date" on the screen instead of a hang. P5 Q25 (never
auto-`skipWaiting`) makes this a **routine** event after every deploy, not an
exotic one.

### 3.1 `packages/protocol/src/strings.ts` — length-prefixed UTF-8, PURE

```ts
/** Bytes, not characters. A name is 16 UTF-8 bytes; a track id is 24. */
export const NAME_MAX_BYTES = 16
export const TRACK_ID_MAX_BYTES = 24
export const NAME_LEN_BITS = 5        // 0..16 fits; 0..31 representable
export const TRACK_ID_LEN_BITS = 5    // 0..24 fits; 0..31 representable

/** UTF-8 encodes `s` and truncates to at most `maxBytes` WITHOUT splitting a
 *  multi-byte sequence. Sole owner of the truncation rule. */
export function utf8Truncate(s: string, maxBytes: number): Uint8Array

/** Writes `lenBits` of length then that many bytes, LSB-first like everything
 *  else. Throws if `bytes.length` exceeds what `lenBits` can express — an
 *  ENCODE-side throw, on data this process produced, which is a bug and not an
 *  attack. */
export function writeString(w: BitWriter, bytes: Uint8Array, lenBits: number): void

/** Reads what writeString wrote. Invalid UTF-8 decodes with U+FFFD rather than
 *  throwing: a hostile peer must not be able to throw inside a decode. A read
 *  past the end of the buffer still throws, from BitReader, and the guard
 *  catches it. */
export function readString(r: BitReader, lenBits: number): string
```

`TextEncoder`/`TextDecoder` are ES2022 globals in Node ≥20 and every target
browser, so `strings.ts` adds no dependency and needs no DOM lib.

**Names: 16 UTF-8 bytes, no filter, no uniqueness, empty is legal** (P4 Q18). The
UI shows "Player *n*" for an empty name. This is a friends-only room reached by a
code; a moderation system for it is scope Plan 1 of 5 did not buy.

### 3.2 `packages/protocol/src/room.ts` — codes, tokens, and the one path prefix

**The module exists and is named `room.ts`, not `roomcode.ts`.** Task 15c item E
shipped three constants and three functions (§2.6); Plan 4 adds the bit-level
half and the session token to the same file. Quoted from source, then extended:

```ts
// SHIPPED — Task 15c item E. Plan 4 changes not one character of these six.
/** Crockford's base32: 32 symbols, DIGITS FIRST, with I, L, O and U removed.
 *  The exclusions are not cosmetic — a room code is read off one phone screen
 *  across a room and typed into another, and I/1, L/1 and O/0 are the three
 *  misreads that actually happen. U is dropped as well, which is Crockford's own
 *  choice and keeps the count at exactly 32 (5 bits per character).
 *
 *  The ORDER is the 5-bit index and is therefore part of the wire format. */
export const ROOM_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
/** FIVE, not four (F-P4-34). 32^5 = 33,554,432 against 32^4 = 1,048,576. */
export const ROOM_CODE_LENGTH = 5
/** C-1. Compiled into the APK's autoVerify `pathPrefix`, matched
 *  case-sensitively and prefix-exactly, FROZEN AT THE FIRST SIGNED RELEASE. */
export const LOBBY_PATH_PREFIX = '/r/'
/** Trim and uppercase. Total — never throws, never rejects. Deliberately does
 *  NOT fold confusable glyphs: the alphabet already removes the ambiguity at the
 *  source, and a second silent transformation of user input can only send a
 *  player to a different real room. Uppercasing is REQUIRED rather than
 *  cosmetic, because the code is part of a case-sensitively matched URL path. */
export function normalizeRoomCode(input: string): string
/** True only for a code already in canonical form. Lowercase is INVALID here
 *  rather than quietly accepted, which is what forces every caller through
 *  normalizeRoomCode before it routes. Written to survive being handed anything
 *  at all: a validator that throws on null turns a malformed request into a 500. */
export function isValidRoomCode(code: string): boolean
/** Normalizes, validates, then concatenates. Throws on a code that is not one —
 *  a path built from a bad code is a link that silently goes nowhere, and this is
 *  the last point at which that is still visible. */
export function lobbyPathFor(code: string): string

// PLAN 4 ADDS, into the same file:
export const CODE_CHAR_BITS = 5
export const ROOM_CODE_BITS = 25               // ROOM_CODE_LENGTH * CODE_CHAR_BITS
export const ROOM_CODE_SPACE = 33_554_432      // 32^5
export const SESSION_TOKEN_LENGTH = 12         // F-P4-15
export const SESSION_TOKEN_BITS = 60
export function isValidSessionToken(raw: string): boolean
/** `length` characters as `length` x 5 raw bits, alphabet-index order. The
 *  32-symbol alphabet is what makes this exact: 5 bits per character, no
 *  padding, and no index that can fail to map back. */
export function encodeCodeChars(w: BitWriter, code: string, length: number): void
export function decodeCodeChars(r: BitReader, length: number): string
```

**Three drafts proposed three different alphabets and the shipped one is none of
them.** Plan 4's draft wrote `'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'`; ruled Plan 3
§5.8 wrote `'23456789ABCDEFGHJKLMNPQRSTUVWXYZ'` and described it as *"no O/0, no
I/1"*; Task 15c shipped Crockford, which **keeps `0` and `1` and drops the
letters `I`, `L`, `O` and `U`**. All three are 32 symbols and all three are
ambiguity-free; only the shipped one is on the wire. This contract takes the
shipped one, and §15.12 records that ruled Plan 3 §5.8's constant and its
"no O/0" description are both superseded.

**One consequence that changes a behaviour the rulings discussed.** P4 Q17 and
Plan 3 §5.8 both describe `normalizeRoomCode` as *stripping* every character
outside the alphabet and *truncating* to `ROOM_CODE_LENGTH`. The shipped one does
neither — it trims and uppercases, and `isValidRoomCode` judges. The substance
that mattered survives intact and is arguably better served: **nothing is
substituted, so a typo can never route a player into a different real room**, and
a bad code produces "invalid code" rather than a silent redirect. What changes is
where the rejection happens — in the validator rather than in the normaliser — and
Plan 4's UI copy implication is unchanged.

### 3.3 `packages/protocol/src/lobby.ts` — the six lobby kinds

```ts
export type PeerRole = 'host' | 'guest'

/** F-P4-11 splits what the draft overloaded onto `hello`. `hello` is JOIN and
 *  nothing else; `clientUpdate` is every subsequent declaration. Field-inspection
 *  dispatch is how §13's #3 risk becomes a defect. */
export const CLIENT_FLAG_WEBRTC          = 1 << 0  // hello only: this peer can attempt WebRTC
export const CLIENT_FLAG_READY           = 1 << 1  // clientUpdate: lobby ready toggle
export const CLIENT_FLAG_START_REQUEST   = 1 << 2  // clientUpdate, host only; ignored from anyone else
export const CLIENT_FLAG_RTC_FAILED      = 1 << 3  // clientUpdate: WebRTC gave up; put me on relay

export const SERVER_FLAG_IS_HOST          = 1 << 0
export const SERVER_FLAG_RACE_IN_PROGRESS = 1 << 1
export const SERVER_FLAG_RELAY_ASSIGNED   = 1 << 2
export const SERVER_FLAG_RELAY_FIRST      = 1 << 3  // F-P4-39: attach over relay now, try WebRTC in the background
export const SERVER_FLAG_CHECKPOINT_NEXT  = 1 << 4

export type JoinResult =
  | 'ok' | 'roomNotFound' | 'roomFull' | 'roomClosed'
  | 'versionMismatch' | 'badRequest' | 'rateLimited'

export type ResyncReason = 'lateJoin' | 'divergence'

export interface HelloMessage {
  role: PeerRole
  roomCode: string        // '' when a host is creating a room
  token: string           // '' when this peer has never been welcomed
  characterIdx: number    // 0..15
  name: string            // <= NAME_MAX_BYTES once encoded
  trackId: string         // '' = no opinion; honoured only from the host
  flags: number           // CLIENT_FLAG_WEBRTC
}

export interface ClientUpdateMessage {
  flags: number           // READY | START_REQUEST | RTC_FAILED
  characterIdx: number
  name: string
  trackId: string         // '' = no change
}

export interface WelcomeMessage {
  result: JoinResult
  roomCode: string
  playerId: number        // -1 unless result === 'ok'
  token: string           // '' unless result === 'ok'
  hostPlayerId: number    // -1 when the room has no host yet
  peerSlot: number        // 1..254; this peer's slot in §4.2's framing
  flags: number           // SERVER_FLAG_*
  lobbyVersion: number
}

export interface WireLobbySlot {
  occupied: boolean; isBot: boolean; connected: boolean; ready: boolean
  characterIdx: number
  /** F-P4-15 / P2-R16: the transport slot that owns this seat, or 0 for none.
   *  This IS the authorised peer→seat map, and §5.3's `withPeerAuthority` is the
   *  one place it is enforced. Without it the host learns peer→playerId from the
   *  datagram itself and validates nothing, so any peer can seize any seat by
   *  sending one input datagram. */
  peerSlot: number
  name: string
}

export interface LobbyMessage {
  lobbyVersion: number
  hostPlayerId: number    // -1 when none
  trackId: string
  slots: WireLobbySlot[]  // length MAX_KARTS, index === playerId
}

export interface StartMessage {
  raceSeed: number        // u32
  trackId: string
  humanMask: number       // bit i set === seat i is a connected human at start
  characterIdx: number[]  // length MAX_KARTS
}

export interface ResyncRequestMessage {
  reason: ResyncReason
  lastTick: number        // the newest tick this client believes it holds
}

export function encodeHello(out: Uint8Array, msg: HelloMessage): number
export function decodeHello(buf: Uint8Array): HelloMessage
export function encodeClientUpdate(out: Uint8Array, msg: ClientUpdateMessage): number
export function decodeClientUpdate(buf: Uint8Array): ClientUpdateMessage
export function encodeWelcome(out: Uint8Array, msg: WelcomeMessage): number
export function decodeWelcome(buf: Uint8Array): WelcomeMessage
export function encodeLobby(out: Uint8Array, msg: LobbyMessage): number
export function decodeLobby(buf: Uint8Array): LobbyMessage
export function encodeStart(out: Uint8Array, msg: StartMessage): number
export function decodeStart(buf: Uint8Array): StartMessage
export function encodeResyncRequest(out: Uint8Array, msg: ResyncRequestMessage): number
export function decodeResyncRequest(buf: Uint8Array): ResyncRequestMessage

/** Worst-case encoded BODY sizes, derived in §3.5 and asserted by a test that
 *  encodes a maximal message and compares byteLength(). Every caller sizes its
 *  buffer from these, because BitWriter truncates silently. */
export const HELLO_MAX_BYTES = 55
export const CLIENT_UPDATE_MAX_BYTES = 44
export const WELCOME_MAX_BYTES = 18
export const LOBBY_MAX_BYTES = 177
export const START_MAX_BYTES = 34
export const RESYNC_REQUEST_BYTES = 5
```

**`humanMask`, exactly** (P4 Q32): bit `i` set means seat `i` is a connected
human at the moment `start` is sent; every clear bit is a bot. A player in the
room but not "ready" is still a human seat — `createState` makes every seat
`isBot: true, connected: false`, so the mask is the only thing that can say
otherwise. A player who joins **after** `start` takes a bot's seat via late join
and the authority flips `isBot`, which reaches everyone through the snapshot's
two independent bits.

**`trackId` travels as a string** (P4 Q13): ~20 B against a manifest index that
breaks silently the day the six tracks are reordered in one place and not the
other.

### 3.4 `packages/protocol/src/control.ts` — `ping` and `pong`

```ts
/** One shape for both kinds. `echoMs` is the PINGER's own clock reading and is
 *  opaque to the receiver, which copies it back verbatim. That is what keeps
 *  round-trip timing out of every deterministic path: nobody but the originator
 *  ever interprets it. */
export interface HeartbeatMessage { seq: number; echoMs: number }

export function encodeHeartbeat(out: Uint8Array, msg: HeartbeatMessage): number
export function decodeHeartbeat(buf: Uint8Array): HeartbeatMessage

export const HEARTBEAT_BYTES = 6
```

`ping` and `pong` share one codec; the two are distinguished only by the
`WIRE_TAG` byte the caller writes with `encodeHeader`. **A `pong` copies the
`ping`'s `seq` and `echoMs` unchanged** — asserted by a test, because a receiver
that stamps its *own* time turns RTT into clock skew and nothing fails loudly.

**Both ride the unreliable channel** (P4 Q19). A heartbeat behind retransmits
measures the retransmit queue, not liveness. Safe against mis-dispatch:
`AuthorityLoop` filters on `kind` (`authority.ts:126`), not on channel alone.
Heartbeats ride the **control transport only** — the socket to the server — and
never the WebRTC link: peer loss on that link is `onPeerLost`'s job, host loss is
the shadow's, and a third liveness signal would be a third source of truth.

### 3.5 Bit layouts, at the precision `snapshot.ts` already uses

All fields LSB-first, in table order, continuously bit-packed with no per-record
padding, exactly like `WireSnapshot`. Every layout is **after** the 2-byte
`encodeHeader` output; the caller writes the header and passes `out.subarray(2)`,
exactly as `authority.ts:206-208` does.

**`hello` — client → server, reliable, tag `0x01`**

| Field | Bits | Notes |
|---|---|---|
| `role` | 2 | 0 = host, 1 = guest; 2–3 reserved, decode returns `badRequest` |
| `hasCode` | 1 | 0 when a host is creating a room |
| `roomCode` | 25 | 5 × u5 alphabet index; all zero when `hasCode = 0` |
| `hasToken` | 1 | |
| `token` | 60 | 12 × u5; all zero when `hasToken = 0` |
| `characterIdx` | 4 | |
| `flags` | 16 | `CLIENT_FLAG_*` |
| `nameLen` | 5 | 0..16 |
| `name` | 8 × `nameLen` | UTF-8 |
| `trackIdLen` | 5 | 0..24 |
| `trackId` | 8 × `trackIdLen` | ASCII in practice, UTF-8 by rule |
| **fixed** | **119 bits** | + 8 × (`nameLen` + `trackIdLen`); max **439 bits = 55 B** |

**`clientUpdate` — client → server, reliable, tag `0x05`** (F-P4-11)

| Field | Bits |
|---|---|
| `flags` | 16 |
| `characterIdx` | 4 |
| `nameLen` | 5 |
| `name` | 8 × `nameLen` |
| `trackIdLen` | 5 |
| `trackId` | 8 × `trackIdLen` |
| **fixed** | **30 bits**; max **350 bits = 44 B** |

**`welcome` — server → one client, reliable, tag `0x02`**

| Field | Bits | Notes |
|---|---|---|
| `result` | 4 | `JoinResult` index, table order as declared in §3.3 |
| `roomCode` | 25 | |
| `playerId` | 4 | **biased +1**; `-1` travels as `0`, same scheme as `AuthEvent.playerId` |
| `hasToken` | 1 | |
| `token` | 60 | |
| `hostPlayerId` | 4 | biased +1 |
| `peerSlot` | 8 | 1..254; 0 and 255 are reserved (§4.2) |
| `flags` | 16 | `SERVER_FLAG_*` |
| `lobbyVersion` | 16 | wraps at 65536, compared with `!==` never `<` |
| **total** | **138 bits = 18 B** | |

**`lobby` — server → all in room, reliable, tag `0x03`**

| Field | Bits |
|---|---|
| `lobbyVersion` | 16 |
| `hostPlayerId` | 4 (biased +1) |
| `trackIdLen` | 5 |
| `trackId` | 8 × `trackIdLen` |
| per slot × `MAX_KARTS`: `occupied` 1, `isBot` 1, `connected` 1, `ready` 1, `characterIdx` 4, `peerSlot` 8, `nameLen` 5, `name` 8×`nameLen` | 21 + 8×`nameLen` |
| **fixed** | **193 bits**; max **1409 bits = 177 B** |

Slot index **is** `playerId`; there is no `playerId` field in the slot record and
no reordering is legal. `occupied === false` implies `name === ''`,
`ready === false` and `peerSlot === 0`, asserted on decode.

**`start` — server → all in room, reliable, tag `0x04`**

| Field | Bits |
|---|---|
| `raceSeed` | 32 |
| `trackIdLen` | 5 |
| `trackId` | 8 × `trackIdLen` |
| `humanMask` | 8 |
| `characterIdx` | 8 × 4 = 32 |
| **fixed** | **77 bits**; max **269 bits = 34 B** |

**`resyncRequest` — client → server, reliable, tag `0x14`** (F-P4-11)

| Field | Bits |
|---|---|
| `reason` | 2 (0 = `lateJoin`, 1 = `divergence`; 2–3 reserved) |
| `lastTick` | 32 |
| **total** | **34 bits = 5 B** |

**`ping` (tag `0x30`) / `pong` (tag `0x31`) — either direction, unreliable**

| Field | Bits |
|---|---|
| `seq` | 16 |
| `echoMs` | 32 |
| **total** | **48 bits = 6 B** |

`echoMs` is a `u32` of milliseconds and wraps every 49.7 days. `notePong` (§5.2)
computes `(nowMs - echoMs) >>> 0`, so a wrap costs one bogus RTT sample and never
a negative one.

**`authorityChange` — the promoted shadow → all, reliable, tag `0x20` — NOT
bit-packed, and NOT Plan 4's to write.** Shipped in `net/src/shadow.ts:67-97`:

| Byte | Meaning |
|---|---|
| 0 | `WIRE_TAG.authorityChange` |
| 1 | `PROTOCOL_VERSION` |
| 2–5 | `tick`, **u32 little-endian**, `DataView.setUint32(h, tick >>> 0, true)` |
| 6–9 | `eventSeq`, u32 LE |
| **total** | **10 B**, `AUTHORITY_CHANGE_BYTES` |

It is the one message in this system written with a `DataView` rather than a
`BitWriter`, because at 8 payload bytes the two are the same size and the
byte-aligned form is what shipped. `decodeAuthorityChange` validates the header
it skips (`shadow.ts:98-117`) rather than assuming it — *"a datagram of some other
kind … would otherwise decode into two plausible-looking numbers and silently
re-seat an entire room's authority."* Two fields, frozen for v1 (P4 Q30): the
only possible promotee is a server every client already holds a socket to, so the
message needs no address.

### 3.6 Where `WireSnapshot.phase` sits, and what it costs

Plan 3 §2.5 requires the field (R44) and writes its cost as "178 → 180 bits".
That arithmetic puts it in the **per-kart** record, which would be eight copies of
one fact about the world. **Task 15c shipped it in the header**
(`snapshot.ts:48, 101, 176`), whose own comment says *"Eight copies of one global
value would also be a lie about where the field lives"* — the placement this
contract's byte budgets assume, confirmed by the source rather than derived from
it. Header layout, as shipped:

| Header field | Bits |
|---|---|
| `tick` | 32 |
| `eventSeq` | 32 |
| `lastProcessedInputTick` × 8 | 8 × 16 = 128 |
| `entityCount` | 8 |
| **`phase`** | **2** (`countdown`/`racing`/`finished`, `PHASE_ORDER` index; 3 reserved) |
| **total** | **202 bits** (was 200) |

Worst case becomes `8 × 178 + 32 × 135 + 202 = 5946 bits = 744 B`, and the
largest unreliable datagram in the system is **744 + 2 header + 3 envelope =
749 B** — comfortably inside any path MTU, so no fragmentation layer exists
anywhere (P4 Q45). The shipped `SNAPSHOT_BUF_BYTES = 1024` still covers it with
275 B to spare. A worst-case `AuthorityCheckpoint` is ~5.3 KB and rides the
reliable channel, which fragments for us. `lobby` at 177 B is the largest
non-race message and it is reliable.

### 3.7 Why every `*_MAX_BYTES` is derived and not guessed

`BitWriter` silently truncates past the end of its buffer (§2.6). A `lobby`
message with eight 16-byte names encodes to 177 B; a caller with a 128 B buffer
gets a *valid-looking* message whose last two slots are garbage, with no error at
any layer. So every one of the six constants is computed from the tables above
**and** asserted by a test that builds the maximal message, encodes it, and
compares `byteLength()` to the constant. Same discipline as `SNAPSHOT_BUF_BYTES`
in `shadow.ts:62-71`, which exists because an earlier draft of that file used a
figure from a superseded 177-bit kart record.

---

## 4. `packages/net` — the two real transports and their pure scaffolding

### 4.1 `packages/net/src/socket.ts` — PURE (interface and constants only)

```ts
export type SocketData = string | Uint8Array
export type SocketReadyState = 'connecting' | 'open' | 'closing' | 'closed'

/** The whole of what a WebSocket is, to everything above the adapter. Both `ws`
 *  on the server and the browser's global WebSocket wrap into this, and a test's
 *  fake pair implements it in 40 lines with no network. */
export interface SocketLike {
  send(data: SocketData): void
  close(code?: number, reason?: string): void
  onMessage(cb: (data: SocketData) => void): void   // appends, never replaces
  onClose(cb: (code: number) => void): void         // appends, never replaces
  readyState(): SocketReadyState
  bufferedAmount(): number
}

/** Application close codes (4000–4999 is the range RFC 6455 reserves for us).
 *  A close code is the ONLY channel that crosses a protocol version boundary
 *  intact — see §3.0. */
export const WS_CLOSE_VERSION_MISMATCH = 4001
export const WS_CLOSE_ROOM_CLOSED      = 4002
export const WS_CLOSE_BACKPRESSURE     = 4003
```

**Text vs binary is the channel split that makes signalling free:** a WebSocket
frame is natively one or the other, `SocketData` preserves that, and §4.4's
signalling rides text while every `WIRE_TAG` message rides binary. Nothing needs
a discriminator byte to tell them apart.

`onClose` carries the code because `RoomClient` maps 4001 onto
`error = 'versionMismatch'` and 4002 onto `'roomClosed'`, which is the entire
mechanism by which a client that cannot even parse the server's messages still
learns why.

### 4.2 `packages/net/src/wsframe.ts` — PURE

One WebSocket carries traffic for two logical channels and, on the host's socket,
for several *origin peers* at once (the relay case). The three bytes below are
the transport's private envelope; nothing above `Transport` ever sees them.

```ts
export const WS_FRAME_DATA    = 0x00
export const WS_FRAME_CONTROL = 0x01
export const WS_CHANNEL_UNRELIABLE = 0x00
export const WS_CHANNEL_RELIABLE   = 0x01
export const WS_SLOT_SERVER    = 0x00   // the room itself
export const WS_SLOT_BROADCAST = 0xff   // "fan out to everyone but me"
export const WS_CONTROL_PEER_JOINED = 0x00
export const WS_CONTROL_PEER_GONE   = 0x01
export const WS_HEADER_BYTES = 3

export interface WsFrame {
  frameKind: number                 // WS_FRAME_*
  channel: ChannelName | null       // null on control frames
  controlOp: number | null          // null on data frames
  peerSlot: number                  // origin (inbound) or destination (outbound)
  payload: Uint8Array               // a WIRE_TAG message; empty on control frames
}

export function encodeWsData(out: Uint8Array, channel: ChannelName, peerSlot: number, payload: Uint8Array): number
export function encodeWsControl(out: Uint8Array, op: number, peerSlot: number): number
/** TOTAL: returns null on a short, unknown-kind or unknown-channel frame. Never
 *  throws — a hostile peer must not be able to crash a room, and this is the
 *  first function every inbound byte on a public socket reaches. */
export function decodeWsFrame(buf: Uint8Array): WsFrame | null
export function byteOfChannel(c: ChannelName): number
export function channelOfByte(b: number): ChannelName | null
```

Layout, byte-exact:

| Byte | Meaning |
|---|---|
| 0 | `frameKind`: `0x00` data, `0x01` control |
| 1 | data: `channel` (`0x00` unreliable, `0x01` reliable) · control: `controlOp` |
| 2 | `peerSlot` |
| 3.. | payload — the bytes `encodeHeader` + a codec produced |

`WsFrame.payload` is a **subarray view** of the inbound buffer, not a copy —
`Transport` rule 6 (§2.1) says a receiver that needs bytes past the callback
copies them, and every shipped loop already does.

The rejected alternative was deriving the channel from `MessageKind` and shipping
no envelope. It costs zero bytes and is wrong: it makes `kind → channel` a second
source of truth that `ClientLoop`'s existing
`kind === 'snapshot' && channel === 'unreliable'` guards (`client.ts:375`,
`client.ts:404`) would then be checking against themselves. 3 B on every datagram
is ~150 B/s per peer at 20 Hz snapshots and 30 Hz inputs (P4 Q38, confirmed).

### 4.3 `packages/net/src/websocket.ts` — PURE over `SocketLike`

The **client-side** transport: one socket, many peers behind it.

```ts
/** Above this bufferedAmount the socket is not writable and unreliable traffic
 *  goes to the mailbox instead (F-P4-44). */
export const WS_MAX_BUFFERED_BYTES = 1 << 20            // 1 MiB
/** A reliable backlog past this is not survivable: reliable traffic is never
 *  dropped, so the only remaining options are unbounded memory on a shared
 *  server process or closing one socket. We close it. (P4 Q43.) */
export const WS_MAX_RELIABLE_BUFFERED_BYTES = 4 << 20   // 4 MiB

export interface WebSocketTransportOptions {
  socket: SocketLike
  /** This endpoint's own slot, from WelcomeMessage.peerSlot. Frames whose origin
   *  equals it are dropped: a relay must never echo a peer to itself. */
  selfSlot: number
  /** Slot -> stable peer id. Default `(s) => 'p' + s`; the server's room
   *  transport passes its own so ids match across both ends of a test. */
  peerIdOfSlot?: (slot: number) => string
  maxBufferedBytes?: number
}

export interface WebSocketTransport extends Transport {
  /** Signalling rides text frames on the same socket (§4.4). */
  sendText(text: string): void
  onText(cb: (text: string) => void): void
  /** Unreliable datagrams superseded in the mailbox before they were ever sent.
   *  A test asserts this is 0 in the steady state and non-zero under a stalled
   *  socket — the only visible symptom of back-pressure. */
  droppedUnreliable(): number
  /** Unreliable datagrams currently held, waiting for the socket to drain. 0..N,
   *  where N is the number of distinct (slot, tag) pairs in flight. */
  mailboxDepth(): number
  knownSlots(): number[]
}

export function makeWebSocketTransport(opts: WebSocketTransportOptions): WebSocketTransport
```

Behaviour, fixed here because two tasks would otherwise pick differently:

- `broadcast(channel, data)` emits **one** frame addressed to `WS_SLOT_BROADCAST`.
  The server fans it out. It does not emit one frame per peer.
- `send(channel, peerId, data)` emits one frame to that peer's slot; an unknown
  peer id is a **no-op** (§2.1 rule 4).
- `peers()` is every slot learned from a `WS_CONTROL_PEER_JOINED` frame, minus
  `selfSlot`, plus the constant peer for `WS_SLOT_SERVER`. The room itself is
  always a peer, from the first frame onward, because the shadow is always
  listening.
- `WS_CONTROL_PEER_GONE` fires `onPeerLost` for that slot's peer id and removes
  it. **This is the entire mechanism by which a host learns that a relayed guest
  dropped**, and without it `AuthorityLoop.onPeerLost` (`authority.ts:177-185`)
  never runs for a relay guest and their kart never becomes bot-driven.
- The slot table is written **by inbound control frames only**. Never inferred
  from a data frame's origin: an unknown origin is a routing bug, and silently
  learning it hides one.
- `close()` closes the socket, clears the slot table and empties the mailbox,
  idempotently.

**The unreliable mailbox — latest wins, depth 1 per (slot, tag)** (F-P4-44):

> While `socket.bufferedAmount() > maxBufferedBytes`, an unreliable datagram is
> **not queued and not discarded — it replaces** whatever unsent datagram is
> already held for the same `(peerSlot, WIRE_TAG)` key, and
> `droppedUnreliable()` counts the one it replaced. When `bufferedAmount()` falls
> back under the cap, the mailbox flushes in insertion order and empties.

Neither drafted option was right. *"Droppable under back-pressure"* advances the
host-loss timer toward promoting a shadow whose host is perfectly healthy;
*"never dropped"* lets a bad server link head-of-line-block the host's own
reliable channel and back-pressure into the game loop. **Never queue; always
replace.** The host never blocks, the shadow always gets the freshest state the
socket can carry, and **starvation then means the socket is genuinely stalled —
which is host loss, correctly detected.** The failure mode the drafts were
trading off against each other stops existing.

Keying by `(slot, tag)` rather than by slot alone is what keeps a `ping` from
being displaced by a `snapshot`; the transport reads exactly one byte of the
payload — `payload[0]`, the tag `encodeHeader` wrote — and only to key the
mailbox. It decodes nothing.

**Replacement is lossless in the sense that matters, and only because of a
property of this protocol:** every unreliable message in this system is
*self-superseding*. A `WireSnapshot` is a complete state, so the newest one
subsumes every older one. An input datagram carries an 8-tick redundant window
(`INPUT_REDUNDANCY = 8`, spec §5), so the newest one carries everything the one
it replaced carried. A `ping` is a liveness probe whose whole design tolerates
loss. If a future message kind on the unreliable channel is *not*
self-superseding, this mailbox is wrong for it and the mailbox — not the message
— is what changes.

A `'reliable'` datagram is **never** dropped and never mailboxed: dropping one
silently breaks `eventSeq` monotonicity, which is the one thing `applyEvent`
cannot recover from. A socket whose `bufferedAmount()` exceeds
`WS_MAX_RELIABLE_BUFFERED_BYTES` is **closed** with `WS_CLOSE_BACKPRESSURE`.
Unbounded memory growth on a shared server process is worse than one peer
reconnecting.

`packages/net/src/websocket-browser.ts` — **ADAPTER**, not barrel-exported:
`export function browserWebSocket(url: string): SocketLike`. It is the only file
in `net` that names the global `WebSocket`, and because `tsconfig.base.json` sets
`"lib": ["ES2022"]` with no DOM and R35 forbids a per-package override on `net`,
it declares the shape it needs locally rather than pulling the DOM lib into four
packages the server imports (P4 Q5).

### 4.4 `packages/net/src/signal.ts` — PURE

```ts
export const SIGNAL_VERSION = 1
export const SIGNAL_MAX_BYTES = 16384   // an SDP with many candidates, with room

export type SignalMessage =
  | { t: 'offer'; sdp: string }
  | { t: 'answer'; sdp: string }
  | { t: 'ice'; c: IceCandidateInit }
  | { t: 'iceDone' }
  | { t: 'giveUp'; reason: string }

/** `from`/`to` are peer SLOTS (§4.2), so signalling and framing share one address
 *  space and the server needs no second routing table. */
export interface SignalEnvelope { v: number; from: number; to: number; msg: SignalMessage }

export function encodeSignal(env: SignalEnvelope): string
/** TOTAL. Returns null on malformed JSON, a wrong version, an over-long payload,
 *  an unknown `t`, or any field of the wrong type. Never throws. The server calls
 *  this on every text frame from every socket, so it is the single most
 *  attacker-reachable function in the project. */
export function parseSignal(text: string): SignalEnvelope | null
```

Signalling is **JSON over text frames**, not a `WIRE_TAG` binary message
(P4 Q12). Three reasons, stated so nobody "fixes" it: SDP is already a
multi-kilobyte UTF-8 blob and bit-packing it buys nothing; `MessageKind` has no
offer/answer/candidate members and adding three would put pre-connection setup
into the same union as race traffic; and a signalling exchange a human can read
in a devtools frame inspector is worth real debugging hours on the one part of
this system that fails in the field and not in CI.

`parseSignal` builds its result **field by field onto a fresh object literal**;
it never spreads the parsed JSON, so `__proto__` and `constructor` keys in a
hostile payload reach nothing.

### 4.5 `packages/net/src/webrtc.ts` — PURE over `RtcConnectionLike`

```ts
export type RtcConnectionState =
  | 'new' | 'connecting' | 'connected' | 'disconnected' | 'failed' | 'closed'

export interface RtcChannelInit { ordered: boolean; maxRetransmits: number | null }

/** Spec §5's two channels, and the only place their RTC configuration is
 *  written. 'unreliable' is ordered:false + maxRetransmits:0 — an SCTP
 *  partial-reliability channel, which is what makes a dropped input datagram
 *  free. 'reliable' is ordered:true + maxRetransmits:null. */
export const RTC_CHANNEL_INIT: Readonly<Record<ChannelName, RtcChannelInit>>

export interface IceCandidateInit {
  candidate: string; sdpMid: string | null; sdpMLineIndex: number | null
}
export interface IceServerConfig { urls: string[]; username?: string; credential?: string }

/** F-P4-16. An empty default means WebRTC succeeds only on the same LAN, so
 *  essentially every real guest falls to the WebSocket relay and the server
 *  carries the whole race — which discards the entire peer-to-peer architecture
 *  and multiplies server cost by the number of guests. That is not a
 *  conservative default, it is a different product.
 *
 *  This is a THIRD-PARTY ENDPOINT CONTACTED AT CONNECTION TIME. It is documented
 *  as such in the README and it is overridable with one environment variable
 *  (ICE_SERVERS, §5.6). Disclosure is the answer to the privacy cost, not
 *  crippling the transport. It is also not a host detail under §0's rule: it is
 *  a public service address, not anybody's infrastructure. */
export const DEFAULT_ICE_SERVERS: readonly IceServerConfig[]
  // = [{ urls: ['stun:stun.l.google.com:19302'] }]

export interface RtcDataChannelLike {
  readonly label: string
  send(data: Uint8Array): void
  close(): void
  onOpen(cb: () => void): void
  onMessage(cb: (data: Uint8Array) => void): void
  onClose(cb: () => void): void
  readyState(): 'connecting' | 'open' | 'closing' | 'closed'
  bufferedAmount(): number
}

export interface RtcConnectionLike {
  createDataChannel(label: string, init: RtcChannelInit): RtcDataChannelLike
  createOffer(): Promise<string>
  createAnswer(): Promise<string>
  setLocalDescription(sdp: string, type: 'offer' | 'answer'): Promise<void>
  setRemoteDescription(sdp: string, type: 'offer' | 'answer'): Promise<void>
  addIceCandidate(c: IceCandidateInit): Promise<void>
  onIceCandidate(cb: (c: IceCandidateInit | null) => void): void   // null = gathering done
  onDataChannel(cb: (ch: RtcDataChannelLike) => void): void
  onStateChange(cb: (s: RtcConnectionState) => void): void
  close(): void
}

export type RtcConnectionFactory = (iceServers: readonly IceServerConfig[]) => RtcConnectionLike

export interface WebRtcTransportOptions {
  peerId: string
  connection: RtcConnectionLike
  /** P4 Q42: the GUEST is the offerer, and the OFFERER creates both DataChannels;
   *  the answerer receives them through onDataChannel. One convention had to be
   *  picked, the answerer's code path is entirely different, and every task
   *  touching WebRTC must assume the same one. The labels are the ChannelNames. */
  role: 'offerer' | 'answerer'
}

export interface WebRtcTransport extends Transport {
  /** Everything this transport wants said to the far side, as data. The caller
   *  posts it over whatever signalling path it has; this module never knows. */
  onLocalSignal(cb: (msg: SignalMessage) => void): void
  /** The far side's signalling, delivered in. Out-of-order and duplicate messages
   *  are tolerated; unknown ones are ignored. */
  acceptSignal(msg: SignalMessage): void
  connectionState(): RtcConnectionState
  /** Datagrams enqueued before both channels opened. Flushed IN ORDER on open. */
  queuedCount(): number
  start(): void   // offerer: createOffer + setLocalDescription. answerer: no-op.
}

export function makeWebRtcTransport(opts: WebRtcTransportOptions): WebRtcTransport

export const RTC_QUEUE_MAX = 64
/** F-P4-39. 8 s of black screen before fallback is too long; 4 s is past the
 *  point where a working connection would have formed and short enough not to
 *  read as broken. The transport does NOT enforce it — RoomClient does (§4.7). */
export const RTC_CONNECT_TIMEOUT_MS = 4000
```

Behaviour fixed here:

- One `WebRtcTransport` is **one link to one peer**. `peers()` returns
  `[peerId]` while connected and `[]` otherwise. Eight guests on a host means
  eight of these behind one `FanOutTransport` (§4.6). Guests never link to
  guests: the topology is a star centred on the host, never a mesh.
- `send` and `broadcast` are the same operation on a one-peer transport, and
  `broadcast` is implemented as `send` to that peer.
- A datagram sent before `readyState() === 'open'` on its channel is **queued**,
  not dropped, and flushed in send order when the channel opens. Bounded at
  `RTC_QUEUE_MAX`; past that, unreliable datagrams are dropped and reliable ones
  keep queuing. (This queue is the pre-open case only and is unrelated to §4.3's
  mailbox: there is no back-pressure signal before a channel exists.)
- `onStateChange('failed' | 'closed')` fires `onPeerLost(peerId)` **exactly
  once**.
- The transport never times out on its own. **`RoomClient` owns the give-up
  timer**, because giving up means asking the server for relay, which is a room
  decision and not a transport one.

`packages/net/src/webrtc-browser.ts` — **ADAPTER**, not barrel-exported:
`export const browserRtcFactory: RtcConnectionFactory`. The only file in the
repository that names `RTCPeerConnection`. Same local-declaration rule as §4.3.

### 4.6 `packages/net/src/fanout.ts` — PURE

Spec §5: *"Every client sends its input to **both** the host and the server
shadow."* Plan 2 §5 resolved that as "a client's transport holds two peers", but
**no type in the repository combines two transports into one.** This is it.

```ts
export const PEER_ID_SEPARATOR = '/'

export interface FanOutPart { id: string; transport: Transport }

export interface FanOutTransport extends Transport {
  /** Late-joining guests appear on the host mid-lobby, so parts are dynamic. */
  addPart(part: FanOutPart): void
  removePart(id: string): void
  partIds(): string[]
}

/** Peer ids are namespaced `partId + '/' + peerId` so two parts cannot collide.
 *  Neither a part id nor an inner peer id may contain '/', asserted on add
 *  (P4 Q41). AuthorityLoop uses peerId only as a Map key
 *  (`authority.ts:86`), so any opaque string works — but a room log with
 *  `rtc/host` in it is easier to read than a UUID, and readable room logs are
 *  worth the assertion. */
export function scopePeerId(partId: string, peerId: string): string
export function splitPeerId(scoped: string): { partId: string; peerId: string } | null

export function makeFanOutTransport(parts?: FanOutPart[]): FanOutTransport
```

- `broadcast` calls `broadcast` on **every** part — one call, N recipients, which
  is exactly the shape `ClientLoop.tick` already uses (`client.ts:498`).
- `send` routes by the part prefix; an unparseable or unknown scoped id is a
  no-op.
- `onPeerLost` from a part is re-emitted scoped. `removePart` emits `onPeerLost`
  for each of that part's peers **first**, so an authority learns about the karts
  rather than silently keeping them frozen.
- `close()` closes every part.

### 4.7 `packages/net/src/authz.ts` — PURE

The decorator that makes P2-R16's identity-by-transport-peer real, and the reason
`AuthorityLoop`'s own comment can defer authentication to "Plan 4's lobby
handshake" (`authority.ts:146-148`).

```ts
export interface PeerAuthority {
  /** The seat this peer is authorised to submit input for, or -1 for none. */
  playerIdOf(peerId: string): number
  /** True only for the peer currently entitled to originate AUTHORITATIVE
   *  traffic — snapshots, events, checkpoints, authorityChange. On the server
   *  that is the room's host peer, until the shadow promotes; after promotion
   *  nothing inbound is authoritative and this returns false for everyone. */
  isAuthority(peerId: string): boolean
}

export interface PeerAuthorityDrops {
  /** Input datagrams whose claimed playerId was not this peer's seat. */
  wrongSeat: number
  /** Authoritative kinds from a peer that is not the authority. */
  notAuthority: number
  /** Datagrams too short to classify. */
  malformed: number
}

/** Wraps a Transport so every INBOUND datagram is checked against `authority`
 *  before any loop sees it. Everything else delegates. Allocation-free on the
 *  hot path: the seat check reads `playerIdOfInput(payload)` — three bits at a
 *  fixed offset — and never decodes the intent window. */
export function withPeerAuthority(inner: Transport, authority: PeerAuthority): Transport

/** The per-reason drop counts for a transport `withPeerAuthority` produced.
 *  Throws if it did not — a silent 0 for "this object has no counter" is
 *  indistinguishable from "nothing has been dropped", which is the exact
 *  confusion the counter exists to prevent. Same WeakMap idiom as
 *  `droppedDatagramsOf` (`receive.ts:130`). */
export function peerAuthorityDropsOf(t: Transport): PeerAuthorityDrops
```

Dropped, silently and counted, exactly as `receive.ts` drops an undecodable
datagram:

| Inbound kind | Dropped when |
|---|---|
| `input` | `playerIdOfInput(payload) !== authority.playerIdOf(peerId)` |
| `snapshot`, `events`, `checkpoint`, `authorityChange` | `!authority.isAuthority(peerId)` |
| everything else | never — lobby and control kinds are the hub's to adjudicate, and it has the full message |

**Why a decorator and not a change to the loops.** `AuthorityLoop`, `ClientLoop`
and `ShadowLoop` have locked public shapes (Plan 2 §5) and none of them takes a
seat map. A transport decorator is a transport, `net` owns transports, and this
is the identical shape `withLocalInput` already established (R42). It also means
**one implementation and one test** covers both the host's fan-out and the
server's room transport.

**Why it is not optional.** Without it, `AuthorityLoop` learns `peerId →
playerId` from the datagram itself (`authority.ts:142`) and validates nothing, so
any peer in the room can seize any seat — including the host's — by sending one
input datagram naming it, and the reclaim line at `authority.ts:159` will
helpfully mark that seat connected. And on the server, any guest could forge a
`snapshot` the shadow reconciles its whole race onto.

### 4.8 `packages/net/src/liveness.ts` — PURE

```ts
export const PING_INTERVAL_MS = 1000
export const PEER_STALE_MS = 5000

export interface LivenessState {
  lastSeenMs: number; lastPingSentMs: number; lastPingSeq: number
  rttMs: number; pingsSent: number; pongsSeen: number
}
export function createLiveness(nowMs: number): LivenessState
export function notePacket(l: LivenessState, nowMs: number): void
export function shouldSendPing(l: LivenessState, nowMs: number, intervalMs?: number): boolean
export function notePingSent(l: LivenessState, seq: number, nowMs: number): void
export function notePong(l: LivenessState, msg: HeartbeatMessage, nowMs: number): void
export function isStale(l: LivenessState, nowMs: number, timeoutMs?: number): boolean
```

Every one of these is a pure function of `(state, nowMs)`, so peer staleness is a
unit test with three lines and no timers.

**There is no `HostWatch` here and no `hostLost`.** F-P4-22 gives host-loss
detection to `ShadowLoop`, which owns the promotion path it guards, and deletes
the second detector entirely. This module measures *peer* liveness — RTT for a
HUD, and the 5 s staleness that closes a dead lobby socket — and nothing about
authority.

### 4.9 `packages/net/src/roomclient.ts` — PURE

The client half of the handshake. It owns exactly the six lobby kinds and the two
heartbeat kinds; it owns none of the race kinds.

```ts
export type RoomPhase = 'idle' | 'connecting' | 'lobby' | 'starting' | 'racing' | 'closed'

export interface RoomClientState {
  phase: RoomPhase
  playerId: number          // -1 until welcomed
  peerSlot: number          // -1 until welcomed
  roomCode: string
  token: string
  hostPlayerId: number
  lobby: LobbyMessage | null
  start: StartMessage | null
  authorityTick: number     // -1 until an authorityChange arrives
  authorityEventSeq: number // -1 likewise
  relayMode: boolean        // attached over the relay right now
  relayFirst: boolean       // F-P4-39: SERVER_FLAG_RELAY_FIRST was set at welcome
  /** F-P4-24. The server socket went away mid-race. The race KEEPS RUNNING
   *  host-authoritative over WebRTC; this flag is what the UI reads to say the
   *  backup authority is gone. v1 does not reconnect. */
  serverLost: boolean
  error: string             // '' when none; a JoinResult or a close-code name
}

export interface RoomClientOptions {
  transport: Transport      // the CONTROL transport (the server socket), not the fan-out
  role: PeerRole
  name: string
  characterIdx: number
  roomCode: string          // '' when hosting
  token: string             // '' when new
  trackId: string
}

export interface RoomClientUpdate {
  name?: string; characterIdx?: number; ready?: boolean; trackId?: string
}

export class RoomClient {
  constructor(opts: RoomClientOptions)
  state(): Readonly<RoomClientState>
  /** Sends `hello`. Idempotent: a second call before `welcome` re-sends nothing. */
  connect(): void
  /** Sends a `clientUpdate` with the patch applied to this client's own
   *  declaration. NOT a second `hello` — F-P4-11. */
  update(patch: RoomClientUpdate): void
  requestStart(): void                          // host only; CLIENT_FLAG_START_REQUEST
  requestResync(reason: ResyncReason, lastTick: number): void   // sends `resyncRequest`
  reportRtcFailed(): void                       // CLIENT_FLAG_RTC_FAILED; asks for relay
  /** The one clocked entry point, and `nowMs` is injected. Sends a ping when
   *  `shouldSendPing`, answers pongs, enforces RTC_CONNECT_TIMEOUT_MS, and marks
   *  the room closed (or `serverLost` mid-race) when the socket goes stale. */
  poll(nowMs: number): void
  onWelcome(cb: (m: WelcomeMessage) => void): void
  onLobby(cb: (m: LobbyMessage) => void): void
  onStart(cb: (m: StartMessage) => void): void
  /** F-P4-23. Fires when the shadow has taken over. `game` swaps its
   *  AuthorityLoop session for a ClientLoop session here; a host that does not
   *  is a demoted authority watching a race it no longer drives. */
  onAuthorityChange(cb: (tick: number, eventSeq: number) => void): void
  onClosed(cb: (reason: string) => void): void
  close(): void
}

/** §6.4. Starting values, and the client is the right detector: it is the only
 *  participant that knows, and a client that lies only costs itself a checkpoint
 *  the server's rate limiter already bounds. (P4 Q28.) */
export const HARD_RESYNC_LIMIT = 3
export const HARD_RESYNC_WINDOW_TICKS = 600   // 10 s at 60 Hz
```

**Who handles which `MessageKind`** — the table two tasks would otherwise
disagree about, and §13's #3 risk:

| Kind | Tag | Channel | Client side | Server side |
|---|---|---|---|---|
| `hello` | `0x01` | reliable | `RoomClient` sends | `RoomHub.handleHello` |
| `clientUpdate` | `0x05` | reliable | `RoomClient` sends | `RoomHub.handleClientUpdate` |
| `resyncRequest` | `0x14` | reliable | `RoomClient` sends | `RoomHub` answers with `checkpoint` |
| `welcome`, `lobby`, `start` | `0x02`–`0x04` | reliable | `RoomClient` handles | `RoomHub` sends |
| `input` | `0x10` | unreliable | `ClientLoop` sends | `ShadowLoop` handles; relayed to the host |
| `snapshot`, `events` | `0x11`, `0x12` | unreliable / reliable | `ClientLoop` handles | `ShadowLoop` handles pre-promotion, **sends** post-promotion |
| `checkpoint` | `0x13` | reliable | `ClientLoop` handles | `RoomHub` sends, from the shadow's state |
| `authorityChange` | `0x20` | reliable | `ClientLoop` **and** `RoomClient` handle | **`ShadowLoop.promote` sends** — not the hub |
| `ping`, `pong` | `0x30`, `0x31` | unreliable | `RoomClient` | `RoomHub` |

`authorityChange` is the one kind two client-side classes both consume, and that
is deliberate rather than an oversight: `ClientLoop` needs it to raise
`nextEventSeq` (§5.4) and `RoomClient` needs it to fire `onAuthorityChange`.
`Transport.onMessage` appends (§2.1 rule 1), which is the property that makes it
possible at all.

### 4.10 Changes to `packages/net/src/client.ts`

Additive only; the constructor and the four existing members are unchanged, so
Plan 3's `createSession` keeps compiling (P4 Q26).

```ts
export class ClientLoop {
  // ... existing members unchanged ...

  /** Rebuilds `predicted` as createState(ctx, seed, characterIdx), applies
   *  humanMask to isBot/connected, clears the ring, the correction count and the
   *  hard-resync count, and LEAVES phase === 'countdown' so the 180-tick freeze
   *  runs locally. Replaces the constructor's seed-0 / all-zero-characterIdx
   *  placeholder (client.ts:316), which exists only because Plan 2 had no
   *  `start` message to be told any of this by.
   *
   *  A test asserts the result is `statesEqual` to `createState` with the same
   *  arguments plus the mask. */
  beginRace(seed: number, characterIdx: number[], humanMask: number): void

  /** Fires when reconciliation could not find `snap.tick` in the ring and had to
   *  hardResync (client.ts:630). The consumer calls
   *  `RoomClient.requestResync('divergence', tick)`; the loop itself never
   *  sends, because it holds the RACE transport and the request goes over the
   *  CONTROL transport. */
  onHardResync(cb: (tick: number) => void): void

  /** Count of hard resyncs since construction, for §6.4's rule. */
  hardResyncs(): number
}
```

Two new kinds handled inside the existing `onDatagram` (`client.ts:375-432`),
which today ignores both:

- **`checkpoint` on `'reliable'`** → `decodeCheckpoint(payload, this.predicted)`,
  clear the ring (`ringNewestTick = -1`, `ringCount = 0`), clear
  `pendingSnapshot`, set `highestSeenSnapshotTick` to `predicted.tick`. A
  checkpoint is full-precision truth and everything buffered against the old
  timeline is worthless. It cannot crash the client: `decodeCheckpoint`'s
  `itemBoxes` throw (`checkpoint.ts:171-175`) is inside the shipped guard.
- **`authorityChange` on `'reliable'`** → record `{tick, eventSeq}` via
  `decodeAuthorityChange`. It does **not** clear the ring and does **not** reset
  the state: spec §5 is explicit that "there is no rewind", because the shadow has
  been ticking all along. The only state change is
  `nextEventSeq = max(nextEventSeq, msg.eventSeq)`, so the promoted authority's
  first event is not rejected as a duplicate by `applyEvent`'s
  `ev.eventSeq < state.nextEventSeq` guard (`apply.ts:31`).

### 4.11 The barrel

`packages/net/src/index.ts` gains
`export * from './socket'`, `'./wsframe'`, `'./websocket'`, `'./webrtc'`,
`'./signal'`, `'./liveness'`, `'./fanout'`, `'./authz'`, `'./roomclient'` —
and, from the gate, `'./clock'`. **Not** `'./webrtc-browser'` and **not**
`'./websocket-browser'`: §0's barrel rule, so a headless import of `@tapkart/net`
can never reach a file that names a DOM global. A test asserts no two re-exported
modules export the same name, exactly as the other three packages already do.

---

## 5. `packages/server` — module map and exact signatures

`packages/server`, not a top-level `server/` (P4 Q3). Root
`workspaces: ["packages/*"]` and `vitest.config.ts`'s
`include: ['packages/*/test/**/*.test.ts']` already match it and the ruled Plan 3
§1 lists it in the dependency table; spec §3's tree is a sketch, not a path spec.

Every module below is **PURE** unless it says ADAPTER. `server` is **DOM-free**:
`packages/server/tsconfig.json` inherits `"lib": ["ES2022"]` from the base and
adds nothing (R35).

### 5.1 `src/types.ts` — PURE

```ts
export type PeerId = string
/** The ROOM's phase, which is lobby bookkeeping. Not `SimState.phase`, which is
 *  the race's. F-P4-31 keeps them separate on purpose: "host-authoritative" is
 *  about the race simulation, and conflating the two is what makes
 *  host-owned lobby truth look tempting. */
export type ServerRoomPhase = 'lobby' | 'racing' | 'finished' | 'closed'

export interface PeerRecord {
  peerId: PeerId
  slot: number            // 1..254
  playerId: number        // -1 until seated
  token: string
  role: PeerRole
  name: string
  characterIdx: number
  ready: boolean
  relay: boolean          // true once CLIENT_FLAG_RTC_FAILED arrived
  connected: boolean
  joinedAtMs: number
  lastSeenMs: number
  liveness: LivenessState
}

export interface RoomRecord {
  code: string
  createdAtMs: number
  lastActivityMs: number
  phase: ServerRoomPhase
  /** The peer who CREATED the room. Unchanged by promotion: promotion re-seats
   *  the race authority, not the lobby owner (F-P4-31). A returning demoted host
   *  still owns the lobby and may still start the next race. */
  hostPeerId: PeerId | null
  hostPlayerId: number
  trackId: string
  lobbyVersion: number
  raceSeed: number
  peers: Map<PeerId, PeerRecord>
  slotsInUse: Set<number>
  seats: (PeerId | null)[]      // length MAX_KARTS, index === playerId
  /** F-P4-39: consecutive guests that gave up on WebRTC to this host. At
   *  RELAY_FIRST_AFTER_FAILURES, further guests attach over the relay
   *  immediately and attempt WebRTC in the background. */
  rtcFailures: number
  race: RaceRuntime | null
}

export interface RaceRuntime {
  /** FRESH per race — never shared, never memoised. See §7. */
  ctx: SimContext
  state: SimState
  shadow: ShadowLoop
  transport: Transport          // withPeerAuthority(roomTransport, ...)
  room: RoomTransport           // the undecorated one, for deliver/notePeerGone
  /** @tapkart/net's, not a server copy (F-P4-7). One field, `residualMs`. */
  acc: TickAccumulator
  /** The previous `stepRace` timestamp. It lives here rather than in the
   *  accumulator because `advanceAccumulator` takes an elapsed delta. */
  lastPollMs: number
  startedAtMs: number
}
```

**`RaceRuntime` has no `hostWatch`, no `promoted` and no `promotionTick`**
(F-P4-22, GAP-4). Promotion state lives in exactly one place — the
`ShadowLoop` — and the server reads it with `shadow.promotionTick()`.

### 5.2 `src/env.ts` — PURE, and the single source of truth for configuration (C-6)

The container's environment did not match the server's parser, in two drafts
written a day apart. That is not a naming slip, it is a missing single source of
truth.

```ts
export interface EnvVarSpec {
  name: string
  kind: 'number' | 'string' | 'boolean' | 'csv'
  required: boolean
  /** As a string, exactly as it would be written in a compose file. `null` when
   *  required. */
  defaultValue: string | null
  description: string
}

/** EVERY variable this server recognises, in one array. The Dockerfile, the
 *  compose file and the README table are checked against THIS by a test that
 *  fails when they drift — Plan 4 asserts docs/server-env.md, Plan 5 asserts its
 *  two container files against the same export (§1a). A variable that exists in
 *  one and not the other is a build failure, not a 3 a.m. discovery. */
export const ENV_SCHEMA: readonly EnvVarSpec[]

export interface RateLimitConfig { windowMs: number; max: number }

export interface ServerConfig {
  port: number                  // PORT, default 3031 (spec §9)
  bindHost: string              // BIND_HOST, default '0.0.0.0'; never a real hostname
  staticRoot: string            // STATIC_ROOT, RELATIVE, default 'apps/web/dist'
  maxRooms: number              // MAX_ROOMS, default 64
  maxPeersPerRoom: number       // MAX_PEERS_PER_ROOM, default MAX_KARTS
  roomIdleMs: number            // ROOM_IDLE_MS, default 600_000
  joinRateLimit: RateLimitConfig // JOIN_RATE_WINDOW_MS / JOIN_RATE_MAX
  iceServers: readonly IceServerConfig[]  // ICE_SERVERS, default DEFAULT_ICE_SERVERS
  shadowEnabled: boolean        // SHADOW_ENABLED, default true
}

export const DEFAULT_CONFIG: Readonly<ServerConfig>

/** Pure over a plain record — `process.env` is passed in, never read here.
 *  Throws with the offending variable's NAME in the message; a server that
 *  starts with a silently-defaulted misspelled variable is worse than one that
 *  refuses. An UNKNOWN variable is ignored (the container's environment is not
 *  ours alone), but an unknown variable with the prefix `TAPKART_` throws,
 *  because that prefix is ours and a typo in it is always a mistake. */
export function parseConfig(env: Readonly<Record<string, string | undefined>>): ServerConfig

/** ENV_SCHEMA as the exact Markdown table `docs/server-env.md` contains. The
 *  drift test is `expect(readFileSync(...)).toContain(formatEnvTable())`. */
export function formatEnvTable(): string
```

**`WELL_KNOWN_DIR` and `TRACKS_DIR` do not exist.** C-2 keeps Plan 5's generator
writing `<staticRoot>/.well-known/assetlinks.json`, so there is exactly **one**
well-known directory and it is derived from `staticRoot` — one variable instead of
two that must agree. `TRACKS_DIR` is deleted by R46: tracks are imported from
`@tapkart/content`, never read from disk (§1, triage §5 P4 Q2).

**`TAPKART_ORIGIN` is not here** (C-3). The running web app builds every invite
URI and QR payload from `location.origin`, at runtime, so a self-hoster on any
domain works with **no rebuild**. `TAPKART_ORIGIN` exists only where a build-time
constant is unavoidable — the Android intent filter and `assetlinks.json`, both
Plan 5's — because an intent filter is compiled into the APK and can never be
runtime-configurable.

**`SHADOW_ENABLED=false` makes the server a pure relay**, and the honest
consequence is stated rather than discovered: with no `ShadowLoop` there is no
host-loss detector and therefore **no promotion at all** (F-P4-22 put the
detector inside the loop). The variable exists for measuring the relay's cost in
isolation, and `startRace` logs one line naming that consequence when it is off.

### 5.3 `src/random.ts` — PURE

```ts
/** Injected everywhere a mint happens. The one implementation that reads the OS
 *  CSPRNG lives in src/runtime/random.ts. */
export type RandomSource = (bytes: number) => Uint8Array

/** `length` characters drawn uniformly from ROOM_CODE_ALPHABET. The alphabet is
 *  exactly 32 symbols, so 5 bits per character is uniform with NO REJECTION AT
 *  ALL — which is the whole reason it is 32 and not 33, and why this function
 *  has no retry loop and no modulo bias. */
export function mintCode(rand: RandomSource, length: number): string
export function mintRoomCode(rand: RandomSource): string        // ROOM_CODE_LENGTH = 5
export function mintSessionToken(rand: RandomSource): string    // SESSION_TOKEN_LENGTH = 12
export function mintRaceSeed(rand: RandomSource): number        // u32
```

**The session token is the reconnect credential and nothing else** (F-P4-15).
60 bits, stored in `localStorage`, **never in the URL**, and **never a
per-message credential**: per-message identity comes from the transport peer via
§4.7's authorised map. The token proves *"I am the player who held seat N"*
across a reconnect, when the peer identity is necessarily new. That division is
what makes P2-R16's identity-by-claim acceptable in Plan 2's loopback scope and
authenticated here.

### 5.4 `src/registry.ts` — PURE

```ts
export const ROOM_CODE_MINT_ATTEMPTS = 8

export class RoomLimitError extends Error {}
export class RoomFullError extends Error {}
export class CodeCollisionError extends Error {}

export interface RegistryOptions {
  maxRooms: number
  maxPeersPerRoom: number
  roomIdleMs: number
  rand: RandomSource
}

export class RoomRegistry {
  constructor(opts: RegistryOptions)
  /** Sole minter of room codes. Retries ROOM_CODE_MINT_ATTEMPTS times on
   *  collision, then throws CodeCollisionError rather than looping forever. */
  createRoom(nowMs: number): RoomRecord
  getRoom(code: string): RoomRecord | null
  /** Sole assigner of `slot` and sole writer of `peers` / `slotsInUse`. */
  addPeer(room: RoomRecord, peerId: PeerId, role: PeerRole, nowMs: number): PeerRecord
  removePeer(room: RoomRecord, peerId: PeerId, nowMs: number): PeerRecord | null
  /** Token match against a seat whose peer has gone. Returns the revived record
   *  with the SAME playerId and a NEW slot, or null when the token is unknown. */
  reclaim(room: RoomRecord, token: string, peerId: PeerId, nowMs: number): PeerRecord | null
  touch(room: RoomRecord, nowMs: number): void
  /** Closes and returns every room idle longer than roomIdleMs. Sole writer of
   *  ServerRoomPhase 'closed'. */
  expire(nowMs: number): RoomRecord[]
  rooms(): RoomRecord[]
  size(): number
}
```

`roomIdleMs = 600_000`, `maxRooms = 64`, `maxPeersPerRoom = 8` as starting points
(P4 Q33; spec §11 says measure early and §8.3 makes it measurable). **Refusing at
the cap beats evicting a live race**: `createRoom` throws `RoomLimitError` and the
hub answers `roomFull`. **The ninth joiner is refused with `roomFull`** — no
spectators, no queue (P4 Q37); spec §1 caps the grid at 8.

### 5.5 `src/lobby.ts` — PURE

```ts
/** Lowest free seat index, or -1. Seats are assigned in ascending order so a
 *  four-player race always occupies 0..3 and the grid is dense. */
export function assignSeat(room: RoomRecord, peer: PeerRecord): number
export function releaseSeat(room: RoomRecord, peer: PeerRecord): void
export function seatOf(room: RoomRecord, peerId: PeerId): number
/** Sole writer of `lobbyVersion`; returns the new value. One increment per
 *  ACCEPTED mutation, so a client compares with `!==` and never with `<`. */
export function bumpLobbyVersion(room: RoomRecord): number
/** Pure projections of a RoomRecord onto the wire. No side effects, no minting. */
export function buildLobbyMessage(room: RoomRecord): LobbyMessage
export function buildStartMessage(room: RoomRecord, seed: number): StartMessage
export function humanMaskOf(room: RoomRecord): number
export function characterIdxOf(room: RoomRecord): number[]   // length MAX_KARTS
/** §4.7's map, built from the room's seats. `isAuthority` is true only for
 *  `room.hostPeerId`, and only while `room.race?.shadow.promotionTick() < 0` —
 *  after promotion nothing inbound is authoritative. */
export function seatMapOf(room: RoomRecord): PeerAuthority
/** Host-only actions are gated here, not at the call site, so there is one
 *  answer to "may this peer do that". */
export function isHost(room: RoomRecord, peer: PeerRecord): boolean
export function canStart(room: RoomRecord, peer: PeerRecord): boolean
```

**Post-results reset** (P4 Q36): `phase` returns to `'lobby'`, the `RaceRuntime`
is disposed, seats and `characterIdx` survive, `raceSeed` is re-minted at the next
`start`, and `lobbyVersion` bumps. Bot-filled seats stay bot-filled until a human
claims one — the room's seat map is the room's, not the race's.

### 5.6 `src/roomtransport.ts` — PURE

The **server-side** `Transport`: one per room, N sockets behind it. This is what
`ShadowLoop` is constructed over — through §4.7's decorator.

```ts
export interface RoomTransportOptions {
  room: RoomRecord
  /** The hub's own send path. Given a peer and a fully framed WS binary frame. */
  sendFrame: (peer: PeerRecord, frame: Uint8Array) => void
}

export interface RoomTransport extends Transport {
  /** The hub calls this for every inbound data frame, after routing. This is the
   *  only way bytes enter a RoomTransport. */
  deliver(peerId: string, channel: ChannelName, payload: Uint8Array): void
  notePeerGone(peerId: string): void
}

export function makeRoomTransport(opts: RoomTransportOptions): RoomTransport
```

`broadcast` reaches every connected peer in the room — the room is not a peer of
itself. `peers()` is every `PeerRecord.peerId` currently connected.
`notePeerGone` fires `onPeerLost`, which is how a clean socket close makes a kart
bot-driven **immediately**, 1.5 s before any promotion decision (F-P4-22).

### 5.7 `src/hub.ts` — PURE (over injected sockets, registry and a clock parameter)

```ts
export interface HubDeps {
  config: ServerConfig
  registry: RoomRegistry
  content: ContentProvider
  rand: RandomSource
  log: LogSink
  /** F-P4-34: keyed by ROOM CODE, never by anything derived from an address. */
  failedJoins: RateLimiter
}

export interface PeerHandle {
  peerId: PeerId
  roomCode(): string | null
  detach(nowMs: number): void
}

export class RoomHub {
  constructor(deps: HubDeps)
  /** A new socket, not yet in any room. The hub subscribes to it and waits for a
   *  `hello`. Sole creator of PeerIds. */
  attach(socket: SocketLike, nowMs: number): PeerHandle
  /** The single per-process heartbeat: polls and steps every room's race, sends
   *  pings, and expires idle rooms. Called by exactly one scheduler in
   *  runtime/clock.ts. */
  poll(nowMs: number): void
  registry(): RoomRegistry
  close(): void
}

/** Exported for tests and for one reason more important than tests: it is the
 *  entire join policy, and a policy that lives inside a socket callback cannot be
 *  asserted. Returns the WelcomeMessage the caller will send; mutates the room
 *  through the registry and lobby modules only. */
export function handleHello(
  deps: HubDeps, room: RoomRecord | null, peer: PeerRecord,
  msg: HelloMessage, nowMs: number,
): WelcomeMessage

/** The lobby half, separated by F-P4-11 so no handler distinguishes intent by
 *  field inspection. Returns true when the room changed and a `lobby` broadcast
 *  is owed. Ignores CLIENT_FLAG_START_REQUEST from anyone `canStart` rejects. */
export function handleClientUpdate(
  deps: HubDeps, room: RoomRecord, peer: PeerRecord,
  msg: ClientUpdateMessage, nowMs: number,
): boolean

/** Pure. Every peer that must receive a datagram that arrived from `from`.
 *  The relay rule, in one testable function:
 *   - WS_SLOT_BROADCAST from a relay guest -> the host, and never other guests.
 *   - WS_SLOT_BROADCAST from the host -> every relay guest, and never a peer
 *     whose WebRTC link to the host is up (it already got the datagram there).
 *   - a specific slot -> that peer alone.
 *   - never back to `from`.
 *  Everything a room does with a datagram is decided here. */
export function routeDatagram(room: RoomRecord, from: PeerRecord, frame: WsFrame): PeerRecord[]

/** Pure. Whether the server must relay between these two at all. */
export function shouldRelay(room: RoomRecord, from: PeerRecord, to: PeerRecord): boolean

export const CHECKPOINT_BUF_BYTES = 8192   // >= 5288 B for a 6-box track (§2.6)
export const LOBBY_BUF_BYTES = 256         // >= LOBBY_MAX_BYTES 177 + 2 header
/** F-P4-39. After this many consecutive guests fail to reach the host directly,
 *  the room goes relay-first: further guests attach over the relay IMMEDIATELY
 *  and attempt WebRTC in the background, upgrading if it succeeds. Joins stay
 *  fast for everyone behind a symmetric NAT, and a transient failure does not
 *  condemn the room to relaying for its whole life. The transport swap this
 *  needs already exists for promotion, so it is reuse rather than new
 *  machinery. */
export const RELAY_FIRST_AFTER_FAILURES = 2
```

**The room datagram feed into the shadow.** `attach`'s binary handler is the one
place inbound bytes are classified, and it does exactly four things in order:
`decodeWsFrame` (total, null-checked); route via `routeDatagram` and re-frame to
each recipient; `room.race?.room.deliver(...)` so the shadow sees it; and
`registry.touch`. It decodes no game message. It reads `data[1]` for the version
check on a `hello` (§3.0) and nothing else.

**Failed-join limiting, exactly** (F-P4-34):

> `handleHello` calls `deps.failedJoins.allowed(normalizeRoomCode(msg.roomCode),
> nowMs)` **before** looking the room up, and `note(code, nowMs)` **only when the
> result is `roomNotFound` or `roomClosed`**. A successful join costs nothing.

This project has already been bitten by precisely the alternative: behind a
Cloudflare Tunnel every request is one TCP peer, and IP-keyed limiting once
collapsed to 60 accounts per building per 15 minutes. So **do not key on
`CF-Connecting-IP`** — trusting a header is correct only while the deployment is
behind the thing that sets it, and self-hosters will not be. Limiting failed
joins per room code needs no client identity, cannot be defeated by the tunnel,
and directly bounds the only attack. With 32⁵ ≈ 33.5 M codes and ten-minute
rooms, even sustained guessing is far below one hit per day, and a guessed room's
worst outcome is a stranger in a kart race.

**`packages/server/test/no-ip-keys.test.ts`** greps every file in
`packages/server/src` for `cf-connecting-ip`, `x-forwarded-for`, `remoteAddress`
and `socket.address` and fails on a hit. The rule is mechanical, not remembered.

### 5.8 `src/race.ts` — PURE

```ts
export interface StartRaceOptions {
  room: RoomRecord
  /** MUST be a FRESH SimContext with isLeader false — see §7. */
  ctx: SimContext
  seed: number
  characterIdx: number[]
  humanMask: number
  transport: RoomTransport
  nowMs: number
}

/** Builds the shadow's SimState with createState, applies humanMask to
 *  isBot/connected, wraps `transport` in withPeerAuthority(seatMapOf(room)),
 *  constructs the ShadowLoop and starts the accumulator.
 *  SOLE CONSTRUCTOR of a ShadowLoop in the entire server. */
export function startRace(opts: StartRaceOptions): RaceRuntime

/** Called ONCE per scheduler pass per room, and it is exactly this:
 *
 *    const n = advanceAccumulator(run.acc, nowMs - run.lastPollMs)
 *    run.lastPollMs = nowMs
 *    for (let i = 0; i < n; i++) run.shadow.tick(nowMs)
 *
 *  `advanceAccumulator` takes ELAPSED ms, so this function owns the previous
 *  timestamp — `TickAccumulator` has one field and no `lastNowMs`. `tick` takes
 *  the ABSOLUTE `nowMs`, because the host-loss timer inside it compares against
 *  `lastSnapshotAtMs`, and a truthful timestamp is what makes a clamped burst
 *  promote on time (§2.10). Every tick in one burst is handed the same `nowMs`,
 *  which is correct: they are catching up to that instant, not advancing past it.
 *
 *  Returns how many ticks ran. SOLE CALLER of ShadowLoop.tick(). */
export function stepRace(run: RaceRuntime, nowMs: number): number

/** Reads `run.shadow.promotionTick()` and, on the first pass where it is no
 *  longer -1, writes ONE `promotion` LogEvent. It decides nothing: promotion has
 *  already happened inside the loop by the time this observes it. Returns true
 *  on that first pass only. */
export function pollRace(run: RaceRuntime, log: LogSink, nowMs: number): boolean

export function endRace(run: RaceRuntime): void
```

**There is no `maybePromote`, no `noteHostSnapshot` and no `server/ticker.ts`**
(F-P4-22, F-P4-7). The shadow owns detection because the promote path it guards
is already written, tested and mutation-checked, and a second detector disagrees
with it exactly under load. The accumulator is `@tapkart/net`'s because `server`
may not import `game` and two copies of `MAX_CATCHUP_TICKS` do not stay equal —
and when they diverge the host and the server run the same race at two different
speeds under load.

### 5.9 `src/content.ts` — PURE

```ts
export interface ContentProvider {
  track(id: string): Track | null
  /** A FRESH SimContext for one race, allocated per call, with isLeader FALSE.
   *  Never memoised and never shared between rooms — ShadowLoop.promote() writes
   *  `ctx.isLeader = true` into the object it was handed (shadow.ts:245, 479),
   *  so a shared context would let one room's promotion turn every other room in
   *  the process into a leader. See §7. The `track` and `query` INSIDE it are
   *  shared, and that is fine: both are read-only and `loadTrack` memoises the
   *  arc table for exactly that reason. */
  contextFor(trackId: string): SimContext | null
  trackIds(): readonly string[]
}

/** Over `@tapkart/content`'s TRACK_MANIFEST, loadTrack, TUNING and CHARACTERS.
 *  No filesystem, no injection, no parsing at runtime: R46 makes the content a
 *  static import, so a malformed track is a build failure rather than a startup
 *  surprise. */
export function makeContentProvider(): ContentProvider

/** The one instance `main.ts` wires in. Tests construct their own over sim's
 *  fixture track rather than the six shipped ones. */
export const defaultContentProvider: ContentProvider
```

The draft's `loadTracks(dir, listDir, readFile)`, its `TRACKS_DIR` and its
"throws with the filename and every validator message" are all deleted: nothing
reads a track file at runtime, and `@tapkart/content`'s own `parseTrack` already
runs `validateTrack` at import time (Plan 3 §3a.5). This also deletes the
two-mechanisms drift the draft's Q2 worried about — the server's track bytes and
the browser's are now the same module.

### 5.10 `src/static.ts` — PURE

```ts
export const WS_PATH = '/ws'
export const HEALTH_PATH = '/healthz'
export const WELL_KNOWN_PREFIX = '/.well-known/'
export const ASSETLINKS_PATH = '/.well-known/assetlinks.json'

export type Route =
  | { kind: 'file'; relPath: string; contentType: string }
  | { kind: 'spa' }                                          // serve index.html, 200
  | { kind: 'wellKnown'; relPath: string; contentType: string }
  | { kind: 'health' }
  | { kind: 'websocket' }
  | { kind: 'methodNotAllowed' }
  | { kind: 'notFound' }

/** Total, pure, and the whole routing policy. */
export function resolveRoute(method: string, pathname: string): Route

/** Joins and normalises, returning null on any traversal outside `root` — '..',
 *  absolute paths, encoded separators, NUL, backslashes. The one function
 *  standing between a public URL and the filesystem, and it is unit-tested
 *  against a list of known-hostile paths. */
export function safeJoin(root: string, relPath: string): string | null

export function contentTypeOf(relPath: string): string
```

**`Route` has no redirect member, and that is the mechanism, not an omission**
(C-2). Spec §2 and §9 both require `/.well-known/assetlinks.json` to be served
over HTTPS with `Content-Type: application/json` and **no redirects**, and on
Android 12+ a failed App Links verification is *silent* — no chooser, the link
just opens in the browser. A routing table that cannot express a redirect cannot
acquire one later by accident. Three further rules, each asserted:

- `/.well-known/*` resolves to `wellKnown` for **any** path under the prefix, and
  `resolveRoute` applies **no trailing-slash normalisation** to it.
- `wellKnown` is checked **before** the SPA catch-all, so no future
  "redirect/serve everything as the SPA" rule can swallow it.
- `contentTypeOf('assetlinks.json')` is `application/json`, asserted directly.

The file's *contents* are Plan 5's — the keystore does not exist yet. Plan 4
serves whatever is in `${staticRoot}/.well-known/` and returns **404** when
absent, which is right: a malformed or placeholder `assetlinks.json` fails
verification silently, and a 404 at least fails visibly to anyone who looks.

`lobbyPathFor` is **not here** — it is in `@tapkart/protocol` (§3.2, C-1), because
the same prefix is compiled into an APK's intent filter and cannot have two
homes. `resolveRoute` imports `LOBBY_PATH_PREFIX` and routes `/r/ABCDE` to
`spa`.

### 5.11 `src/log.ts` — PURE

```ts
export type LogEvent =
  | { kind: 'roomCreated'; code: string }
  | { kind: 'roomExpired'; code: string; ageMs: number }
  | { kind: 'peerJoined'; code: string; playerId: number; relay: boolean }
  | { kind: 'peerLeft'; code: string; playerId: number }
  | { kind: 'peerReclaimed'; code: string; playerId: number }
  | { kind: 'raceStarted'; code: string; seed: number; trackId: string }
  | { kind: 'promotion'; code: string; tick: number; eventSeq: number }
  | { kind: 'checkpointSent'; code: string; playerId: number; reason: ResyncReason }
  | { kind: 'relayFirst'; code: string; failures: number }
  | { kind: 'rejected'; code: string; result: JoinResult }
  | { kind: 'badFrame'; code: string; peerId: string; why: string }

export interface LogSink { write(ev: LogEvent, nowMs: number): void }
export const nullLogSink: LogSink
export function makeMemoryLogSink(): LogSink & { events(): readonly LogEvent[] }
/** One line, no colours, no timestamps of its own — nowMs is passed in. */
export function formatLogEvent(ev: LogEvent, nowMs: number): string
```

Spec §5: *"A client whose reconciliation diverges repeatedly is sent an
`AuthorityCheckpoint` and hard-resynced, **and the event is logged**."*
`checkpointSent { reason: 'divergence' }` is that log line, and it is a typed
value rather than a string so a test can assert it happened.

**No log line ever carries a name, a token or a room code the player did not
type.** `code` is the room code, which is already public to everyone in the room;
`PeerRecord.name` and `PeerRecord.token` appear in no `LogEvent` member.

### 5.12 `src/ratelimit.ts` — PURE

```ts
export interface RateLimiter {
  /** True when `key` is still under its budget. Does NOT consume — a check and a
   *  charge are different operations here, because only a FAILED join is
   *  charged (§5.7). */
  allowed(key: string, nowMs: number): boolean
  /** Charges one failure against `key`. */
  note(key: string, nowMs: number): void
  reset(): void
}
export function makeRateLimiter(cfg: RateLimitConfig): RateLimiter
```

Fixed-window counter keyed by whatever the caller chooses. §5.7 fixes the key as
the room code and nothing else, and the algorithm matters far less than that
choice does.

### 5.13 `src/index.ts` — the barrel

Re-exports `types`, `env`, `random`, `registry`, `lobby`, `roomtransport`, `hub`,
`race`, `content`, `static`, `log`, `ratelimit`. **Not** `runtime/*` and **not**
`main`. A test asserts no two re-exported modules export the same name.

### 5.14 The adapters — `src/runtime/**` and `src/main.ts`

```ts
// src/runtime/clock.ts   ADAPTER — the only Date.now() and the only timer
export function realNowMs(): number
export interface Scheduler { start(intervalMs: number, cb: (nowMs: number) => void): void; stop(): void }
export function makeIntervalScheduler(): Scheduler
export const POLL_INTERVAL_MS = 8

// src/runtime/random.ts  ADAPTER — the only node:crypto
export const nodeRandomSource: RandomSource

// src/runtime/files.ts   ADAPTER — the only node:fs and node:path
export function readFileBytes(path: string): Uint8Array | null
export function fileExists(path: string): boolean

// src/runtime/ws.ts      ADAPTER — the only `ws` import
export function wrapWsSocket(raw: unknown): SocketLike

// src/runtime/http.ts    ADAPTER — the only node:http
export interface HttpServerHandle { port(): number; close(): Promise<void> }
export function startHttpServer(cfg: ServerConfig, hub: RoomHub, nowMs: () => number): Promise<HttpServerHandle>

// src/main.ts            ADAPTER — composition root
export function main(env: Readonly<Record<string, string | undefined>>): Promise<HttpServerHandle>
```

**One scheduler for the whole process**, at `POLL_INTERVAL_MS = 8`, calling
`hub.poll(realNowMs())`. Not one timer per room: the rooms-per-process budget
(spec §11) is spent on `step()`, and N timers would spend it on the event loop
instead. The hub polls faster than the sim ticks on purpose — the accumulator
turns a jittery 8 ms timer into exact 60 Hz steps, and a poll slower than the tick
makes every room permanently behind.

`runtime/files.ts` has no `listDirSync` and no `readFileSync(): string`: nothing
in this server reads a directory or parses a file. It reads static bytes for the
HTTP handler, and that is all.

---

## 6. Numbers and rules that must agree, or nothing works

### 6.1 The promotion trigger, quoted

Spec §5: *"**Promotion.** Host loss is declared after **1.5s with no snapshot**
(30 missed at 20Hz). The server broadcasts `authorityChange {tick, eventSeq}` on
the reliable channel and switches to leader mode: it begins rolling items from a
PRNG re-seeded deterministically from `(raceSeed, promotionTick)`, and continues
`eventSeq` from the highest it observed."*

Resolved into code, exactly once each:

| Fact | Where it lives |
|---|---|
| 1500 ms | `HOST_TIMEOUT_MS`, `net/src/shadow.ts:49` |
| what advances the timer | `nowMs - lastSnapshotAtMs`, inside `ShadowLoop.tick(nowMs)` (`shadow.ts:511-513`), with `nowMs` injected by `stepRace` |
| what resets it | any decoded `snapshot` on the shadow's transport (`shadow.ts:394`), including one too stale to reconcile against — the host is demonstrably still broadcasting |
| who declares | `ShadowLoop.tick` — **and nothing else in the system** |
| who broadcasts `authorityChange` | `ShadowLoop.promote()` (`shadow.ts:538-540`) |
| the re-seed formula | `promotionCursor(raceSeed, tick)` (`sim/src/rng.ts:51`), called at `shadow.ts:478` |
| `eventSeq` continuity | `eventSeqFloor`, raised into `nextEventSeq` by `raiseToEventSeqFloor()` at `shadow.ts:460`, from the highest `eventSeq` in **any** snapshot header seen |
| what the server does about it | `pollRace` reads `shadow.promotionTick()` and writes one log line |

### 6.2 The cadences

| Cadence | Value | Owner |
|---|---|---|
| Simulation | 60 Hz | `advanceAccumulator` (`net/src/clock.ts`) → `ShadowLoop.tick(nowMs)` |
| Snapshot broadcast | 20 Hz (`tick % 3 === 0`) | `AuthorityLoop` pre-promotion (`authority.ts:211`), `ShadowLoop` post-promotion (`shadow.ts:507`) |
| Input send | 30 Hz, 8-intent window | `ClientLoop`, internally (`client.ts:15, 490`) |
| Ping | 1 Hz | `RoomClient.poll` / `RoomHub.poll` |
| Host-loss check | once per `tick`, but measured in **wall milliseconds** | `ShadowLoop.tick(nowMs)` |
| Catch-up clamp | `MAX_CATCHUP_TICKS = 5` (83 ms), excess **discarded** | `advanceAccumulator` |
| Hub poll | 125 Hz (`POLL_INTERVAL_MS = 8`) | the one scheduler |

### 6.3 Buffer sizes, all derived

| Buffer | Bytes | Derivation |
|---|---|---|
| snapshot | 1024 | `shadow.ts:71`; worst case 744 B + 2 B header (§3.6), 278 B of headroom |
| events | 4096 shadow / 2048 authority | `shadow.ts:74`, `authority.ts:33` |
| input | 256 | `client.ts:19`, `local.ts:15` |
| checkpoint | 8192 | 661 float64 fields = 5288 B for a 6-box track, + header, + growth |
| hello / clientUpdate / welcome / lobby / start / resyncRequest | 64 / 64 / 32 / 256 / 64 / 16 | §3.3's `*_MAX_BYTES` + 2 B header, rounded up to a power of two |
| heartbeat | 16 | 6 B + 2 B header |
| WS frame | payload + 3 | `WS_HEADER_BYTES` |

### 6.4 Repeated divergence → checkpoint

Spec §5's third failure case, made concrete because nothing in the repository
implements it:

- `ClientLoop.hardResyncs()` counts hard resyncs (§4.10).
- `game` (or a test) calls
  `RoomClient.requestResync('divergence', tick)` when that count crosses
  `HARD_RESYNC_LIMIT` within `HARD_RESYNC_WINDOW_TICKS`.
- `RoomHub` answers with a `checkpoint` encoded from **the shadow's own state**,
  not the host's (F-P4-27), and `deps.failedJoins`-style bounding is unnecessary
  because the request is per-peer and the hub answers at most one per
  `HARD_RESYNC_WINDOW_TICKS` per peer.
- `LogSink` records `checkpointSent { reason: 'divergence' }`.

### 6.5 Late join

Spec §5 lists late join as the first use of `AuthorityCheckpoint`. Resolved
(F-P4-27): `handleHello` sets
`SERVER_FLAG_RACE_IN_PROGRESS | SERVER_FLAG_CHECKPOINT_NEXT` in the `welcome`,
sends `start` so the client can call `beginRace` first — **which is what makes its
`itemBoxes` array the right length, and `decodeCheckpoint` throws otherwise
(`checkpoint.ts:171-175`)** — and then sends a `checkpoint` from the shadow's
state on the reliable channel.

**From the shadow, not the host**: in-process, no round trip through a phone's
uplink at the worst possible moment. The joiner starts up to one snapshot interval
behind and reconciles forward — which is exactly what reconciliation is for, and
the shadow is by construction within reconciliation bounds of the host.

### 6.6 What happens when the server dies mid-race (F-P4-24)

**The race keeps playing.** Tearing down a working WebRTC race because the
*backup* authority died is the worst of the three options. Concretely:

- Direct-connected guests keep racing host-authoritative over WebRTC. Nothing in
  `AuthorityLoop` or `ClientLoop` depends on the server socket.
- Relay-attached guests drop — they have no path — and the host learns it through
  `onPeerLost`, so their karts become bot-driven.
- `RoomClient` sets `serverLost` and the UI surfaces that the backup authority is
  gone. **There is no promotion left** if the host also leaves, and that is
  stated rather than hidden.
- **v1 does not reconnect in the background.** It is the better behaviour and it
  is deliberately out of scope: Plan 4 is already the largest plan in the project
  and this is a graceful-degradation improvement on a path that already degrades
  gracefully.

---

## 7. Sole-writer rules

Every field below is written by exactly one module. Where two plausibly could,
the rule says which, and why the other is wrong.

| Field | Sole writer | Note |
|---|---|---|
| `SimState.*` on the server | `ShadowLoop` (via `step`, `applyEvent`, `applySnapshotToState`, `cloneState`) | The hub, the registry and the lobby never touch a `SimState`. A room's lobby bookkeeping and its simulation share exactly one value — `humanMask` at `start` |
| `RaceRuntime.state` | `ShadowLoop`, by publishing into it every `tick()` (`shadow.ts:501`) and in `promote()` (`shadow.ts:556`) | `ShadowLoop` has no `state()` accessor by design: the object handed to its constructor **is** the accessor |
| `karts[i].connected` on an **authority** | the loop's own peer bookkeeping — `AuthorityLoop.onPeerLost`/reclaim (`authority.ts:184`, `authority.ts:159`), `ShadowLoop.onPeerLost`/reclaim (`shadow.ts:343`, `shadow.ts:367`) | Not `applySnapshotToState`: an authority never applies a snapshot to itself |
| `karts[i].connected` on a **follower** | `applySnapshotToState` (`snapshot.ts:303`) | The wire carries `isBot` and `connected` as two independent bits precisely so the drop/reclaim transition survives |
| `SimState.nextEventSeq` on the shadow | `applyEvent` pre-promotion; `emit` post-promotion; `raiseToEventSeqFloor` **once**, inside `promote()` | Never `applySnapshotToState`, which deliberately excludes the field (`snapshot.ts:253-262`). The changeover is `ctx.isLeader`, flipped by `promote()` and nothing else |
| `SimState.rngCursor` on the shadow | `rollItem` post-promotion, and `promote()` once via `promotionCursor` | `raceSeed` is **never written**, which is what keeps `statesEqual(host, shadow)` meaningful |
| **`ctx.isLeader`** | **`ShadowLoop.promote()`, writing into the caller's object** | See below. This is the one sole-writer rule in Plan 4 that is a hazard rather than a convention |
| `RoomRecord.peers`, `slotsInUse`, `PeerRecord.slot` | `RoomRegistry` | The hub asks; it never assigns |
| `RoomRecord.seats`, `PeerRecord.playerId` | `lobby.ts`'s `assignSeat` / `releaseSeat` | |
| `RoomRecord.lobbyVersion` | `bumpLobbyVersion` | One increment per accepted mutation, so a client compares with `!==` |
| `RoomRecord.phase` | `RoomHub` for `lobby`→`racing`→`finished`; `RoomRegistry.expire` for `closed` | |
| `RoomRecord.lastActivityMs` | `RoomRegistry.touch` | |
| `RoomRecord.rtcFailures` | `handleClientUpdate`, on `CLIENT_FLAG_RTC_FAILED` | Reset to 0 by the first guest that reaches the host directly, so a transient failure does not condemn the room for its whole life (F-P4-39) |
| `TickAccumulator.residualMs` | `advanceAccumulator`, in `@tapkart/net` | One definition for the browser and the server both (F-P4-7). `RaceRuntime.lastPollMs` is `stepRace`'s, because the accumulator takes a delta and holds no timestamp |
| the host-loss timer (`lastSnapshotAtMs`) | `ShadowLoop.tick` and `ShadowLoop.onDatagram`'s snapshot branch | There is no second detector anywhere (F-P4-22) |
| `LivenessState` | the five `note*`/`should*` functions in `liveness.ts` | |
| `WebSocketTransport`'s slot table | inbound `WS_FRAME_CONTROL` frames only | Never inferred from a data frame's origin: an unknown origin is a routing bug, and silently learning it hides one |
| the unreliable mailbox | `WebSocketTransport`'s send path and its drain handler | |
| the wall clock | `packages/server/src/runtime/clock.ts` (server), `packages/game/src/clock.ts` (browser, Plan 3 §5.1) | Two processes, two clocks, and no third |

**The `startSpinOut` exception from Plan 2 §0 carries forward unchanged**: inside
`applyEvent`, an authoritative event is applied as fact; everywhere else
`startSpinOut` is the sole writer of `spinOutTicks`. Plan 4 adds no new exception.

### 7.1 `SimContext` freshness — the one rule whose violation is silent and process-wide

`AuthorityLoop` and `ClientLoop` both spread-copy the `SimContext` they are given
(`authority.ts:89`, `client.ts:312`), so nothing they do is visible in the
caller's object. **`ShadowLoop` does not** — `shadow.ts:245` is `this.ctx = ctx`
and `shadow.ts:479` is `this.ctx.isLeader = true`. Promotion therefore writes
`isLeader` into **the object the server handed it**.

That is fine, and is arguably right: the server *wants* `RaceRuntime.ctx` to
reflect the promotion. It becomes a defect the moment two rooms share one object.

> **`ContentProvider.contextFor` allocates a NEW `SimContext` on every call, and
> `RaceRuntime.ctx` is never assigned from anywhere else.** The `track`,
> `query`, `tuning` and `characters` *inside* it are shared and must be — they
> are read-only, and `loadTrack` memoises the arc table precisely so a
> sixty-fourth room does not rebuild it.

The failure this prevents is exactly the class this project has already paid for
once: Plan 1's module-scope bot-input hold made `step` non-instanceable, two
rooms in one process drove each other's bots, and it was invisible until measured
at 3 cm of divergence after 40 ticks (spec §3, amended). A memoised
`SimContext` is the same defect wearing the same costume — one room losing its
host would turn every other room in the process into a leader, and every one of
them would start rolling items and emitting events. Two tests:

- `contextFor('caldera') !== contextFor('caldera')`, and mutating `isLeader` on
  one leaves the other `false`.
- Two `RaceRuntime`s in one hub, promote one, assert the other's
  `ctx.isLeader === false` and its `nextEventSeq` unchanged after 60 further
  ticks.

---

## 8. Headless testability, per module

Spec §8's "What CI cannot verify" names two things and Plan 4 adds four. Below
that line, everything is a pure function and is tested.

### 8.1 Pure — what CI asserts, module by module

| Module | The assertion |
|---|---|
| `protocol/strings` | `utf8Truncate` never splits a multi-byte sequence, at every boundary from 1 to 16 bytes, over ASCII/BMP/astral inputs; `readString` on invalid UTF-8 yields U+FFFD and does not throw |
| `protocol/room` | every 5-character code round-trips through 25 bits; the alphabet is exactly 32 symbols with no duplicates (a one-line test that protects the whole 5-bit scheme) and contains none of `I`, `L`, `O`, `U`; `normalizeRoomCode` **substitutes nothing** and is idempotent; `isValidRoomCode` rejects lowercase; `lobbyPathFor('0ABCD') === '/r/0ABCD'`, contains no host, and throws on a 4-character code |
| `protocol/lobby` | all six messages round-trip field by field including `playerId === -1`, `token === ''`, empty and maximal names, 8 occupied slots, `peerSlot` at 1 and 254; encoding a maximal message equals its `*_MAX_BYTES`; `role = 2` decodes as `badRequest` rather than as a host |
| `protocol/control` | a `pong` built from a `ping` is byte-identical in `seq` and `echoMs` |
| `protocol/input` (amended) | `playerIdOfInput` agrees with `decodeInput(...).playerId` over all 8 seats, and returns `-1` on a 0-, 1- and 2-byte buffer |
| `protocol/snapshot` (amended) | `phase` round-trips for all three `RacePhase` values; a maximal snapshot with 32 live entities encodes to **744 B** and the constant says so |
| `net/wsframe` | every frame round-trips; `decodeWsFrame` returns `null` — never throws — on empty, 1-byte, 2-byte, unknown-kind and unknown-channel input |
| `net/websocket` | over a fake `SocketLike` pair: broadcast reaches every learned slot; a `PEER_GONE` control frame fires `onPeerLost` exactly once; frames from `selfSlot` are ignored; **past `maxBufferedBytes` a second unreliable datagram with the same tag REPLACES the first and `droppedUnreliable()` is 1, a ping is NOT displaced by a snapshot, the mailbox flushes in insertion order when the socket drains, and a reliable datagram is never dropped**; past `WS_MAX_RELIABLE_BUFFERED_BYTES` the socket is closed with 4003 |
| `net/webrtc` | over a two-sided in-memory `RtcConnectionLike`: a full offer/answer/ICE exchange brings both channels up; datagrams sent before open are flushed **in order** on open; `'failed'` fires `onPeerLost` **once**; `RTC_CHANNEL_INIT.unreliable` is `{ordered: false, maxRetransmits: 0}`; `DEFAULT_ICE_SERVERS` is non-empty |
| `net/signal` | `parseSignal` returns `null` for 20 hostile inputs (truncated JSON, wrong version, unknown `t`, `sdp` a number, a 1 MB string, `__proto__`/`constructor` keys) and never throws; a parsed envelope's prototype is `Object.prototype` and carries no injected key |
| `net/authz` | an input datagram naming a seat the peer does not hold is dropped and counted `wrongSeat`; a `snapshot` from a non-authority peer is dropped and counted `notAuthority`; the host's own traffic passes untouched; after promotion `isAuthority` is false for everyone and inbound snapshots stop reaching the loop |
| `net/liveness` | `notePong` computes RTT across a `u32` wrap without going negative; `isStale` is false at 4999 ms and true at 5000 ms |
| `net/fanout` | one `broadcast` reaches both parts; `removePart` emits `onPeerLost` for each of its peers **before** dropping it; a `'/'` in a part id throws at `addPart` |
| `net/roomclient` | the full handshake against a scripted transport: `hello` → `welcome` → `lobby` → `start` drives `RoomPhase` in order; `update()` sends `clientUpdate` and never a second `hello`; a `rateLimited` welcome ends in `closed` with the reason in `error`; close code 4001 lands as `error === 'versionMismatch'`; `RTC_CONNECT_TIMEOUT_MS` elapsing sends `CLIENT_FLAG_RTC_FAILED` exactly once |
| `net/client` (amended) | a `checkpoint` clears the ring and adopts the decoded tick; an `authorityChange` changes **no** kart field and only raises `nextEventSeq`; `beginRace` produces a state `statesEqual` to `createState` with the same arguments; a truncated `checkpoint` increments `droppedDatagramsOf` and changes nothing |
| `net/authority` (amended, §2.10 G2) | an `authorityChange` it did not send stops its snapshot and event broadcasts within one tick, and stops `emit` |
| `net/shadow` (Task 15c item C) | `tick(1499)` does not promote and `tick(1500)` does; a snapshot arriving mid-window resets the timer; **a run whose ticks are clamped at `MAX_CATCHUP_TICKS` still promotes at 1500 ms of wall time**, which is the whole reason the counter is milliseconds and not ticks |
| `net/clock` (Task 15c item B) | time is conserved: `ticks * TICK_MS + acc.residualMs` equals the total elapsed handed in across any number of calls; across a clamp the residual goes to **0**, not to the backlog remainder; a zero or negative `elapsedMs` is treated as zero |
| `server/env` | every variable in `ENV_SCHEMA` parses; a bad number throws with the variable's name in the message; every default path is relative; `formatEnvTable()` matches `docs/server-env.md` byte for byte; an unknown `TAPKART_*` variable throws |
| `server/random` | `mintCode` with a counting fake yields an exact expected string; every character is in the alphabet over 10,000 draws; no draw is rejected (the 32-symbol property) |
| `server/registry` | slots are unique and dense; `maxRooms` throws `RoomLimitError`; a ninth peer throws `RoomFullError`; `expire` closes exactly the rooms idle at `roomIdleMs`, not at `roomIdleMs - 1`; `reclaim` returns the same `playerId` and a **new** slot |
| `server/lobby` | `buildLobbyMessage` on a 3-human room has 3 occupied slots and 5 empty; `humanMaskOf` matches bit for bit; `canStart` is false for a guest; `seatMapOf().playerIdOf` returns `-1` for an unknown peer and `isAuthority` is false for every peer once promoted |
| `server/roomtransport` | `broadcast` produces one `sendFrame` per connected peer and none for the sender; `deliver` reaches **every** registered `onMessage` listener (the append rule, from the consumer's side) |
| `server/hub` | **the flagship**: `routeDatagram` over a table of (topology, origin, slot) cases — a relay guest's broadcast reaches the host and no other guest; a host broadcast reaches relay guests and not RTC guests; nothing ever returns to `from` |
| `server/hub` | `handleHello` returns `roomNotFound` / `roomFull` / `rateLimited` / `ok`-with-a-fresh-token for the corresponding setups; a `hello` at protocol version 1 closes the socket with 4001 and writes one `rejected` log line; **`failedJoins` is charged only on a failure, and the key is the room code** |
| `server/race` | `stepRace` hands `advanceAccumulator` a **delta** and `tick` an **absolute** `nowMs`, and every tick in one burst gets the same `nowMs`; 16.67 ms yields 1 tick; 1000 ms yields `MAX_CATCHUP_TICKS` and the excess is discarded, not banked; `lastPollMs` advances exactly once per call |
| `server/race` | **the promotion test, spec §8**: a host `AuthorityLoop` and a shadow `ShadowLoop` over a loopback pair at 150 ms / 50 ms / 5 %, 600 ticks, then stop the host; assert promotion fires at 1500 ms and not before, **no kart's `lap` regresses across it**, `entityCount` does not drop to 0, and **no `eventSeq` is applied twice** |
| `server/content` | `contextFor` returns `isLeader: false` and a **distinct object per call** (§7.1); `trackIds()` equals `TRACK_MANIFEST`'s ids |
| `server/static` | `safeJoin` returns `null` for `../`, `..%2f`, `%2e%2e/`, absolute paths, NUL and a backslash separator; `resolveRoute('GET', '/r/ABCDE')` is `spa`; `ASSETLINKS_PATH` is `wellKnown` with `application/json`; **no input produces a redirect, because `Route` has no such member**; `/.well-known/foo/` keeps its trailing slash |
| `server/log` | a promotion writes exactly one `promotion` event; a divergence checkpoint writes `checkpointSent { reason: 'divergence' }`; no `LogEvent` member is a name or a token |
| `server/ratelimit` | the window boundary is exact; `allowed` does not consume; `note` does |
| **end-to-end, in-process** | `RoomHub` + two `RoomClient`s over fake sockets: create a room, join by code, start, race 600 ticks, kill the host socket, and assert the guest keeps receiving snapshots after `authorityChange`, that the promoted authority's first event is applied rather than dropped, and that no lap counter regressed. **No network, no browser, one process** |
| **§7.1's two-room test** | promote one room, assert the other's `ctx.isLeader` is still `false` after 60 more ticks |
| **§0b's smoke test** | the composition root answers `/healthz` and completes a WebSocket upgrade on `127.0.0.1:0` |

**Where spec §8's promotion test lives** (P4 Q47): in **both** places. The
`ShadowLoop`-level test is `net`'s and Plan 2 already ships
`net/test/shadow.test.ts`; the end-to-end kill-the-host test is `server`'s,
because only the hub owns the transports. Spec §8's row is satisfied by the pair.

### 8.2 Adapter — thin, and CI imports it exactly once

Exactly seven adapter files, plus one composition root:

- `packages/net/src/webrtc-browser.ts` — the only `RTCPeerConnection`.
- `packages/net/src/websocket-browser.ts` — the only browser `WebSocket`.
- `packages/server/src/runtime/clock.ts` — the only `Date.now()` / timer.
- `packages/server/src/runtime/random.ts` — the only `node:crypto`.
- `packages/server/src/runtime/files.ts` — the only `node:fs` / `node:path`.
- `packages/server/src/runtime/ws.ts` — the only `ws`.
- `packages/server/src/runtime/http.ts` — the only `node:http`.
- `packages/server/src/main.ts` — the composition root: it wires the five server
  adapters into `RoomHub` and starts one scheduler. It performs no syscall of its
  own and makes no decision, which is why it is listed apart from the adapters.

Each is a mechanical translation with no branch on room or game state. If one
needs a conditional, the conditional belongs in the pure layer as a returned
value — the same rule Plan 3 §0a fixed for `render`. Three of them
(`http`, `ws`, `main`) are executed by §0b's single smoke test, which asserts
their *composition* and nothing about their behaviour; the two `-browser.ts`
files are never imported by any test, are absent from the barrel, and are
owner-verified.

### 8.3 What CI cannot verify — restated for this plan

- **How the game feels on a real phone** (spec §8).
- **The NFC tap** (spec §8). Plan 5's, and two physical devices.
- **That NAT traversal works.** CI proves the offer/answer/ICE state machine is
  correct against a fake `RtcConnectionLike`. It cannot prove a real STUN server
  answered, that a symmetric NAT actually defeated the direct path, or that the
  relay fallback triggered in the field. Owner-verified, and the reason
  `droppedUnreliable()` and `connectionState()` are on the public surface at all.
  There is deliberately **no `node:wrtc`-class integration test** (P4 Q48): SCTP
  ordering, partial reliability and ICE restarts are owner-verified on two
  phones.
- **That an unreliable SCTP channel is really unreliable.** `maxRetransmits: 0`
  is asserted as configuration, not as observed packet loss.
- **Real socket back-pressure.** `bufferedAmount()` is a fake in every test, so
  the mailbox is proven correct against a *modelled* stall and not a real one.
- **Rooms per process** (spec §11's second risk). `packages/server/bench/rooms.ts`
  ticks N rooms for M ticks and prints wall-clock cost; **the owner runs it, CI
  does not** (P4 Q49). A wall-clock assertion on shared CI is a flake generator,
  and spec §11 asks for a measurement, not a gate. `bench/` is outside
  `vitest.config.ts`'s `include` glob, so it can never become one by accident.

### 8.4 The import-allowlist test (P4 Q50)

`packages/server/test/import-direction.test.ts` reads every
`packages/*/src/**/*.ts` and `apps/*/src/**/*.ts`, extracts every import
specifier, and checks it against a table:

| Package | May import |
|---|---|
| `sim` | nothing |
| `protocol` | `@tapkart/sim` |
| `net` | `@tapkart/sim`, `@tapkart/protocol` |
| `content` | `@tapkart/sim` |
| `render` | `@tapkart/sim`, `@tapkart/content`, `three` |
| `game` | `@tapkart/sim`, `@tapkart/protocol`, `@tapkart/net`, `@tapkart/content`, `@tapkart/render`, `@tapkart/invite` |
| `server` | `@tapkart/sim`, `@tapkart/protocol`, `@tapkart/net`, `@tapkart/content`, and `node:*`/`ws` **only under `src/runtime/` and in `src/main.ts`** |

Ten lines that make spec §3's dependency direction mechanically checkable
repo-wide — including the rule that `server` never reaches `three`, `game` or
`render`, which is otherwise enforced by discipline alone. Same class as Plan 5's
no-secrets grep. It also catches a relative path into another package's `src`,
which no other check would.

### 8.5 The Playwright lane (C-4)

Spec §8's last row is *"Playwright drives two browser contexts joining by code
and finishing a race"* — which needs the server, the lobby and the room code. All
three are Plan 4's, and Plan 3 §8.3 already assigned the harness here.

**Plan 4 creates the lane:** `playwright.config.ts` at the repo root, an `e2e/`
directory, the first spec (`e2e/join-and-race.spec.ts`: two contexts, one hosts,
one joins by typed code, both finish three laps), and the root script
`"test:e2e": "playwright test"`. **Plan 5 adds specs to it** and owns the CI job
that runs it.

This lane is **exempt from §0's "no browser, no external network"** and that is
not a contradiction: those rules are about the **vitest suite**, which must stay
browserless and complete. Playwright is a separate lane with a separate command,
it is not in `vitest.config.ts`'s `include`, and it drives a server bound to
loopback. `npm test` never starts a browser.

---

## 9. Test fixtures, and the `Transport` conformance suite

### 9.1 Fixtures

Plan 2 §6's rule binds unchanged (§2.11): `src` imports across packages by bare
specifier only; **test** code may reach a sibling package's fixtures by relative
path, and no `exports` map is ever widened to publish fixtures.

```ts
// packages/net/test/fixtures/socket-fixtures.ts
/** Two SocketLikes wired to each other. `flush()` delivers everything queued —
 *  the same "the test owns time" discipline makeLoopbackPair uses. `stall()` and
 *  `drain()` drive bufferedAmount(), which is what makes §4.3's mailbox
 *  testable at all. */
export function makeFakeSocketPair(): {
  a: SocketLike; b: SocketLike; flush(): void; stall(bytes: number): void; drain(): void
}
export function makeRecordingSocket(): SocketLike & {
  sentBinary(): Uint8Array[]; sentText(): string[]
  deliver(data: SocketData): void; fireClose(code: number): void
}

// packages/net/test/fixtures/rtc-fixtures.ts
/** Two RtcConnectionLikes that complete a real offer/answer/ICE exchange in
 *  memory. `settle()` runs the queued promise chain to completion so a test needs
 *  no timers and no fake clock. THIS is the seam that makes WebRtcTransport
 *  testable without a browser. */
export function makeFakeRtcPair(): {
  offerer: RtcConnectionLike; answerer: RtcConnectionLike
  settle(): Promise<void>; failBoth(): void
}
export function makeFakeRtcFactory(): { factory: RtcConnectionFactory; connections(): RtcConnectionLike[] }

// packages/server/test/fixtures/server-fixtures.ts
/** Over sim's own track fixture, by relative path (§2.11). FRESH per call — §7.1. */
export function makeServerContext(): SimContext
export function makeTestConfig(overrides?: Partial<ServerConfig>): ServerConfig
/** A deterministic RandomSource: byte i of draw n is (n * 31 + i) & 0xff. Every
 *  minted code and token in the suite is therefore an exact expected string. */
export function makeCountingRandom(): RandomSource
export function makeTestHub(overrides?: Partial<HubDeps>): {
  hub: RoomHub; log: ReturnType<typeof makeMemoryLogSink>
}
/** Host + N guests attached to one hub over fake sockets, already welcomed and
 *  seated. The vehicle for the promotion, relay and two-room tests. */
export function makeTestRoom(hub: RoomHub, guests: number, nowMs: number): {
  code: string; host: SocketLike; guests: SocketLike[]
}
```

### 9.2 The `Transport` conformance suite

One shared, exported test factory, run against **all five** implementations —
`LoopbackTransport`, `LocalInputTransport`, `WebSocketTransport`,
`WebRtcTransport` and `RoomTransport`:

```ts
// packages/net/test/fixtures/transport-conformance.ts
export interface ConformanceHarness {
  a: Transport; b: Transport
  /** Deliver everything in flight. */
  flush(): void
  /** Simulate the far end vanishing, so onPeerLost must fire. */
  dropB(): void
}
export function runTransportConformance(name: string, make: () => ConformanceHarness): void
```

It asserts §2.1's six behaviours (P4 Q40, confirmed). Without it, each
implementation satisfies whichever of the six its own author happened to notice,
and the divergence surfaces as a lobby that works on loopback and silently dies
over WebRTC — because `onMessage` replaced a listener instead of appending one,
and `RoomClient` was the listener it deleted.

`packages/server/test/` imports it by relative path for `RoomTransport`, which is
the one implementation outside `net`.

---

## 10. Package manifest, config, the build, and the root files Plan 4 edits

### 10.1 `packages/server/package.json`

```jsonc
{ "name": "@tapkart/server", "version": "0.1.0", "private": true, "type": "module",
  "exports": { ".": "./src/index.ts", "./main": "./src/main.ts" },
  "dependencies": {
    "@tapkart/sim": "*", "@tapkart/protocol": "*", "@tapkart/net": "*",
    "@tapkart/content": "*",
    "ws": "<pinned exactly, no caret — the pin task fixes the version>"
  },
  "devDependencies": { "@types/ws": "<pinned>" },
  "scripts": {
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "build": "node scripts/build-server.mjs",
    "start": "node dist/main.mjs",
    "bench": "node --experimental-strip-types bench/rooms.ts"
  } }
```

`packages/server/tsconfig.json` is
`{ "extends": "../../tsconfig.base.json", "include": ["src/**/*.ts", "test/**/*.ts"] }`
— identical to `sim`, `protocol` and `net`, and **with no `lib` override**: R35
keeps DOM out of the four packages `server` imports, and `server` itself has no
use for it.

`ws`, **with `@types/ws`** (P4 Q4). Node has no built-in WebSocket *server* —
Node 20's global `WebSocket` is a client — and hand-rolling RFC 6455 framing to
keep the dependency count at zero would be the least defensible line of code in
the project. `@types/ws` rather than a hand-written ambient declaration: a local
re-declaration of a third-party surface is a silent drift source, and it is a
`devDependency`, so it never ships.

The second `exports` entry keeps `main.ts` reachable to the build script while
keeping it out of the headless barrel (§0).

### 10.2 The env documentation file

`docs/server-env.md` is a Plan 4 deliverable containing exactly
`formatEnvTable()`'s output plus one paragraph naming
`stun:stun.l.google.com:19302` as a **third-party endpoint contacted at
connection time**, and how to change it (F-P4-16's disclosure requirement).
Plan 5's README and compose file are asserted against `ENV_SCHEMA` directly
(§1a, C-6).

### 10.3 The build — one esbuild bundle (C-5, F-P4-6)

Three options were live: `tsx`/`--experimental-strip-types` in the image, `tsc`
emit for `server`, or an esbuild bundle. **esbuild bundle, one file.** It is the
fastest start, it is already the tool Plan 3's content gate uses, and it keeps
the repo's "every `exports` points at `.ts`" arrangement intact everywhere else.
Decisively: shipping an **experimental Node flag as the production entry point**
is a liability with no upside, and `tsc` emit means maintaining a second
module-resolution story for one package.

`packages/server/scripts/build-server.mjs`, and every option in it is
load-bearing:

```js
await esbuild.build({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/main.mjs',
  bundle: true,
  platform: 'node',
  target: 'node20',           // root `engines` says >=20
  format: 'esm',
  sourcemap: true,
  // `ws` lazily require()s these two native accelerators inside try/catch. They
  // are optional, they are not installed, and bundling them fails the build.
  external: ['bufferutil', 'utf-8-validate'],
  // ESM has no `require`, so ws's guarded require() throws ReferenceError instead
  // of the MODULE_NOT_FOUND its catch expects — the socket layer then dies at
  // the first frame, in production only. This banner is the fix.
  banner: { js: "import { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);" },
})
```

The bundle **embeds all six tracks**: `@tapkart/content` uses static JSON imports
(Plan 3 §3a.1), esbuild's default `json` loader inlines them, and the running
server opens no content file. That is why `TRACKS_DIR` does not exist, and it is
the reason R46 chose static imports over `import.meta.glob` in the first place.

`esbuild` is a **declared root devDependency** (P5 Q30): declaring a binary you
execute is correct, and relying on a transitive Vite dependency is how a major
bump breaks the deploy.

**Plan 4 owns the bundle script; Plan 5's Dockerfile consumes `dist/main.mjs`.**
Plan 4 ships no Dockerfile, no compose file and no CI workflow.

### 10.4 The root files Plan 4 edits, and nothing else

1. **`package.json`** — `workspaces` already contains `packages/*`, so
   `packages/server` needs no change there. Plan 3 adds `apps/*` (R36). Plan 4
   adds two scripts and one devDependency:
   ```jsonc
   "scripts": { "build:server": "npm run build -w @tapkart/server",
                "test:e2e": "playwright test" },
   "devDependencies": { "esbuild": "<pinned>", "@playwright/test": "<pinned>" }
   ```
2. **`vitest.config.ts`** — `include: ['packages/*/test/**/*.test.ts', ...]`
   already matches `packages/server/test/`. **No change.** `bench/` and `e2e/`
   are outside the glob by construction, which is what keeps a benchmark and a
   browser out of `npm test` permanently.
3. **`playwright.config.ts`** — new, at the repo root (§8.5). `testDir: 'e2e'`,
   two projects (chromium, and a second context in the same project), a
   `webServer` block that runs `npm run build:server && node
   packages/server/dist/main.mjs` on an ephemeral port bound to `127.0.0.1`.
4. **`docs/server-env.md`** — new (§10.2).

Nothing else at the root is touched.

---

## 11. Exported-symbol census

| Module | Count |
|---|---|
| `protocol/strings` | 7 |
| `protocol/room` (added to the shipped six) | 8 |
| `protocol/lobby` | 37 |
| `protocol/control` | 4 |
| `protocol/input` (added: `playerIdOfInput`) | 1 |
| **`protocol` subtotal (new)** | **57** |
| `net/socket` | 6 |
| `net/wsframe` | 15 |
| `net/websocket` | 5 |
| `net/websocket-browser` | 1 |
| `net/webrtc` | 14 |
| `net/webrtc-browser` | 1 |
| `net/signal` | 6 |
| `net/liveness` | 9 |
| `net/fanout` | 6 |
| `net/authz` | 4 |
| `net/roomclient` | 7 |
| `net/client` (added members) | 3 |
| **`net` subtotal (new)** | **77** |
| `server/types` | 5 |
| `server/env` | 7 |
| `server/random` | 5 |
| `server/registry` | 6 |
| `server/lobby` | 11 |
| `server/roomtransport` | 3 |
| `server/hub` | 10 |
| `server/race` | 5 |
| `server/content` | 3 |
| `server/static` | 8 |
| `server/log` | 5 |
| `server/ratelimit` | 2 |
| `server/runtime/*` + `main` | 11 |
| **`server` subtotal** | **81** |
| **Total** | **215** |

Counted from the declarations in §3, §4 and §5, one per exported name, types and
values alike. Plus **11** fixture exports (§9.1's 9, §9.2's 2), which are
test-only and not part of any package's public surface.

Symbols Plan 4 *uses* but does not own are counted against **Plan 2**, not here:
`HOST_TIMEOUT_MS`, `SNAPSHOT_PERIOD_TICKS`, `encodeAuthorityChange`/
`decodeAuthorityChange`/`AUTHORITY_CHANGE_BYTES` (`net/shadow`); `TICK_MS`,
`MAX_CATCHUP_TICKS`, `TickAccumulator`, `makeTickAccumulator`,
`advanceAccumulator` (`net/clock`); `ROOM_CODE_ALPHABET`, `ROOM_CODE_LENGTH`,
`LOBBY_PATH_PREFIX`, `normalizeRoomCode`, `isValidRoomCode`, `lobbyPathFor`
(`protocol/room`); and the one pending accessor `ShadowLoop.promotionTick`
(§2.10 G3). `playerIdOfInput` is counted above because Plan 4 writes it (G4).

The draft counted 213 across a materially different module map. The delta
itemises:

| Change | Δ |
|---|---|
| `protocol/control` loses the `authorityChange` codec (shipped in `net/shadow.ts` — §15.4) | −3 |
| `protocol/roomcode` becomes `protocol/room`, and six of its symbols shipped in Task 15c item E rather than being Plan 4's to add | −6 |
| `protocol/lobby` gains `ClientUpdateMessage`, `ResyncRequestMessage`, `ResyncReason`, their four codecs, two size constants, `SERVER_FLAG_RELAY_FIRST` (F-P4-11, F-P4-39) | +10 |
| `protocol/lobby` loses `CLIENT_FLAG_NEED_CHECKPOINT` (now `resyncRequest`) | −1 |
| `protocol/input` gains `playerIdOfInput` (F-P4-15's enforcement) | +1 |
| `net/socket` gains three close codes (§3.0) | +3 |
| `net/websocket` gains `WS_MAX_RELIABLE_BUFFERED_BYTES`, `mailboxDepth` (F-P4-44, P4 Q43) | +2 |
| `net/webrtc` gains `DEFAULT_ICE_SERVERS` (F-P4-16) | +1 |
| `net/liveness` loses `HostWatch`, `createHostWatch`, `noteSnapshot`, `hostLost`, `HOST_LOSS_MS`, `SNAPSHOT_HZ`, `HOST_LOSS_MISSED_SNAPSHOTS` (F-P4-22) | −7 |
| **`net/authz`** — new, and the only place P2-R16's authorised map is enforced (F-P4-15) | **+4** |
| `net/roomclient` gains `HARD_RESYNC_LIMIT`/`_WINDOW_TICKS` (moved from §7.4's prose) and `onAuthorityChange`/`requestResync` in place of `requestCheckpoint` | +2 |
| `server/config` becomes `server/env` and gains `EnvVarSpec`, `ENV_SCHEMA`, `formatEnvTable` (C-6) | +3 |
| `server/ticker` deleted entirely (F-P4-7) | −4 |
| `server/content` loses `loadTracks`, gains `defaultContentProvider` (R46) | 0 |
| `server/race` loses `maybePromote`, `noteHostSnapshot`, gains `pollRace` (F-P4-22) | −1 |
| `server/lobby` gains `seatMapOf` | +1 |
| `server/hub` gains `handleClientUpdate`, `RELAY_FIRST_AFTER_FAILURES` (F-P4-11, F-P4-39) | +2 |
| `server/static` loses `LOBBY_PATH_PREFIX`/`lobbyPathFor` to `protocol` (C-1), gains `WELL_KNOWN_PREFIX` (C-2) | −1 |
| `server/runtime/files` loses `listDirSync`/`readFileSync` (R46) | −2 |
| `server/registry`/`ratelimit` unchanged in count; `RateLimiter` gains `note`, loses nothing | 0 |

---

## 12. What Plan 4 deliberately does not build

Stated so a task does not "helpfully" add it:

- **No Dockerfile, no compose file, no CI workflow, no GHCR publish.** Spec §9's
  deploy lane is Plan 5's, consistent with Plan 3's ruling Q11. Plan 4 ships the
  esbuild bundle script; Plan 5 ships the image around it.
- **No `assetlinks.json` file, no keystore, no APK, no NFC, no HCE.** Plan 5. The
  `/.well-known/*` **route** exists; the file does not, and an absent file is a
  404 by design (§5.10).
- **No TURN, no coturn, no relay over UDP.** Spec §3: STUN only. The fallback is
  the WebSocket relay this plan builds.
- **No delta encoding of snapshots.** Spec §5: v1 ships uncompressed.
- **No persistence.** Rooms live in memory and die with the process. Spec §1 puts
  accounts and matchmaking out of scope.
- **No matchmaking, no room listing, no public room browser.** A room is
  reachable by code only.
- **No spectators.** `PeerRole` has two members and the ninth joiner is refused
  with `roomFull`.
- **No background reconnection to a dead server** (F-P4-24). The race survives
  without one; reconnecting is a graceful-degradation improvement on a path that
  already degrades gracefully, and Plan 4 is already the largest plan here.
- **No client-side session swap after promotion.** Plan 4 guarantees that the old
  authority demotes (§2.10 G2) and that `RoomClient.onAuthorityChange` fires. The
  swap from an `AuthorityLoop` session to a `ClientLoop` session is `game`'s, and
  the consequence is stated rather than hidden: **a demoted `AuthorityLoop` keeps
  stepping locally and never reconciles**, so a returning host that does not swap
  is watching a race that drifts. There is exactly one authority at every
  instant, which is what F-P4-23 bought; there is not automatically one *correct
  view* on the demoted machine.
- **No `node:wrtc` integration test** (P4 Q48), **no rooms-per-process CI gate**
  (P4 Q49, it is a benchmark the owner runs).

---

## 13. The failure this contract is written to prevent

Plan 2's contract needed twelve amendments during authoring and each cost roughly
two blocking defects at audit. The five highest-risk shared names in Plan 4,
ranked by how many independent tasks must agree on them:

1. **The WS frame envelope (§4.2).** The client transport, the server transport,
   the hub's router and the relay path all encode or decode those three bytes. A
   disagreement about whether byte 2 is the origin or the destination produces a
   room where everything works until the second guest joins.
2. **`peerSlot` as one address space (§3.5, §4.2, §4.4, `WireLobbySlot`).** The
   `welcome` message, the frame header, the signalling envelope and now the
   authorised seat map all carry it. If signalling used a separate id space, the
   server would need a second routing table and the two would disagree exactly
   when a peer reconnects.
3. **The `MessageKind` → handler table (§4.9).** Four classes subscribe to the
   same transports. Two of them handling `checkpoint`, or none of them, are both
   silent failures — and `authorityChange` is deliberately handled twice, which
   only works because `onMessage` appends.
4. **`humanMask` (§3.3, §5.5, §4.10).** The host, the shadow and every client
   call `createState` independently. If they disagree by one bit, one kart is
   driven by bot AI on one machine and by a player on another, and the only
   symptom is that reconciliation never converges for that seat.
5. **`SimContext` identity (§7.1).** `ShadowLoop.promote()` writes into the
   caller's object. One memoised context and a single host dropping turns every
   room in the process into a leader — silently, with 64 simultaneous item PRNGs
   and no failing test.

---

## 14. Where each ruling landed

| Ruling | Landed in |
|---|---|
| C-1 `/r/`, one constant | **Shipped**, Task 15c item E (`protocol/src/room.ts:49`); §3.2 quotes it, §5.10 imports it, `game`'s copy deleted (§2.9) |
| C-2 Plan 5 generates `assetlinks.json`, Plan 4 serves it | §5.10 `wellKnown` route, no redirect member, no trailing-slash normalisation; `WELL_KNOWN_DIR` deleted in favour of one directory under `staticRoot` (§5.2) |
| C-3 `location.origin` at runtime | §0 hostnames convention; §5.2 (`TAPKART_ORIGIN` is not a server variable) |
| C-4 Plan 4 owns Playwright | §8.5 |
| C-5 / F-P4-6 esbuild bundle | §10.3 |
| C-6 one env schema, asserted | §5.2 `ENV_SCHEMA`/`formatEnvTable`; §8.1's drift test; §1a's Plan 5 import |
| C-7 `ROOM_CODE_ALPHABET` in `protocol` | **Shipped**, Task 15c item E; §3.2 quotes it and §15.12 records that the shipped alphabet is a third one; §1 records `invite`'s edge |
| F-P4-7 one accumulator, in `net` | **Shipped**, Task 15c item B (`net/src/clock.ts`, `MAX_CATCHUP_TICKS = 5`); §2.5, §5.8 `stepRace`; `server/ticker.ts` deleted (§11) |
| F-P4-11 `clientUpdate` + `resyncRequest` | Tags **shipped**, Task 15c item D (`types.ts:23, 40`); codecs are Plan 4's — §3.3, §3.5's two new layouts, §4.9's table |
| F-P4-15 12-char token, reconnect-only | §5.3; §4.7 `withPeerAuthority`; `WireLobbySlot.peerSlot` |
| F-P4-16 public STUN default | §4.5 `DEFAULT_ICE_SERVERS`; §5.2 `ICE_SERVERS`; §10.2's disclosure |
| F-P4-22 the shadow owns host loss, in ms | **Shipped**, Task 15c item C (`HOST_TIMEOUT_MS = 1500`, the check inside `tick(nowMs)`); §2.2 fact 0, §2.10's shape note, §5.8, §6.1; `HostWatch` deleted (§4.8) |
| F-P4-23 authority never returns | §2.10 G7; §4.9 `onAuthorityChange`; §12's stated consequence |
| F-P4-24 race survives a dead server | §4.9 `serverLost`; §6.6 |
| F-P4-27 late-join checkpoints from the shadow | §6.5 |
| F-P4-31 the server owns lobby truth | §5.1's `ServerRoomPhase` note; §5.5; §5.7 |
| F-P4-34 five characters + per-code limiting | `ROOM_CODE_LENGTH = 5` **shipped**, Task 15c item E, citing this project's own Cloudflare-Tunnel incident; limiting is §5.7, §5.12, §8.1's no-IP-keys grep; §16.3's spec amendment |
| F-P4-39 4 s timeout, relay-first after two | §4.5 `RTC_CONNECT_TIMEOUT_MS`; §5.7 `RELAY_FIRST_AFTER_FAILURES`; `SERVER_FLAG_RELAY_FIRST` |
| F-P4-44 latest-wins mailbox, depth 1 | §4.3 |
| F-P4-46 one loopback bind | §0b, named |
| R44 `WireSnapshot.phase` | **Shipped**, Task 15c item A, **in the header** — the placement §3.6 derived independently; `ClientLoop` no longer forces `'racing'` |
| GAP-2 no throw into the event loop | Already shipped as `receive.ts` (§2.5); §4.2/§4.4's total decoders extend it |
| GAP-3 no demotion path | §2.10 G7 |
| GAP-4 two host-loss detectors | §2.2, §2.10 G5, §6.1 — one detector, in the loop |
| P4 Q3 `packages/server` | §5 header |
| P4 Q4 `ws` + `@types/ws` | §10.1 |
| P4 Q5 local DOM declarations in the two `-browser.ts` files | §4.3, §4.5 |
| P4 Q10 cold returns / hot fills `out` | §0's convention table |
| P4 Q12 JSON signalling over text frames | §4.4 |
| P4 Q13 `trackId` as a string | §3.3 |
| P4 Q17 `normalizeRoomCode` drops | §3.2 |
| P4 Q18 16-byte names, no filter | §3.1 |
| P4 Q19 `ping`/`pong` unreliable | §3.4 |
| P4 Q26 `beginRace` additive | §4.10 |
| P4 Q28 `HARD_RESYNC_LIMIT = 3` / 600 | §4.9, §6.4 |
| P4 Q30 `authorityChange` frozen at two fields | §3.5, and it is shipped code |
| P4 Q32 `humanMask` | §3.3 |
| P4 Q33 caps and idle timeout | §5.4 |
| P4 Q36 post-results reset | §5.5 |
| P4 Q37 ninth joiner refused | §5.4 |
| P4 Q38 the three-byte envelope | §4.2 |
| P4 Q40 `onMessage` appends + conformance suite | §2.1, §9.2 |
| P4 Q41 `partId + '/' + peerId` | §4.6 |
| P4 Q42 guest offers, offerer creates both channels | §4.5 |
| P4 Q43 back-pressure asymmetry | §4.3 |
| P4 Q45 MTU | §3.6 |
| P4 Q47 the promotion test lives in both places | §8.1 |
| P4 Q48 no `node:wrtc` test | §8.3 |
| P4 Q49 a benchmark, not a gate | §8.3 |
| P4 Q50 the import-allowlist test | §8.4 |
| P4 Q1/Q2 (invalidated by R46) | §1, §5.9 — `@tapkart/content`, imported not read |
| P4 Q20/Q21/Q25/Q29 (invalidated by shipped code) | §2.2, §2.3, §15 |
| P5 Q30 `esbuild` declared at the root | §10.3 |

---

## 15. What the draft claimed about shipped code, and what is actually there

Recorded so it is not re-litigated, and because this rewrite exists for exactly
this reason. Every line below was checked against
`.claude/worktrees/plan2-net/packages/*/src/` on 2026-08-14.

### 15.1 `packages/net/src/shadow.ts` exists

Draft §3.2: *"**`packages/net/src/shadow.ts` does not exist in the worktree.**
`packages/net/src/` holds `apply.ts`, `authority.ts`, `client.ts`, `index.ts`,
`loopback.ts`, `transport.ts` and nothing else, and `index.ts` re-exports only
the first four of those."*

It shipped at `40ba73b`, is 615 lines, and `packages/net/src/` holds **nine**
files — those six plus `shadow.ts`, `local.ts` and `receive.ts`. `index.ts`
re-exports **all eight** non-index modules, `shadow` included
(`index.ts:12-19`). Everything the draft built on the absence — §3.2's "specified
but not observed", §6.9, §7.1's four unknown rows, and Q20/Q21/Q29 — is deleted.

### 15.2 `promote()` already does the three things the draft assigned to the server

- It broadcasts `authorityChange` itself (`shadow.ts:538-540`). The draft's §7.1
  row reads *"who broadcasts `authorityChange` — **`ShadowLoop.promote()` —
  assumed, not observed. §16 Q20**"*.
- It flips its own `ctx.isLeader` (`shadow.ts:479`).
- It broadcasts snapshots at `tick % 3` and events after promotion
  (`shadow.ts:436-439`).

### 15.3 The PRNG re-seed formula is written, and it is in `sim`

Draft §7.1: *"the re-seed formula — **unwritten anywhere. §16 Q21**"*.
`promotionCursor(raceSeed, promotionTick)` is `packages/sim/src/rng.ts:51-56`,
shipped with Plan 1's amendment and called from `shadow.ts:478`. Draft Q21's
worry — that re-seeding means writing `state.raceSeed` and permanently breaking
`statesEqual` between authority and shadow — is answered by the implementation:
`raceSeed` is never written, the **cursor** is re-derived, and the function's own
docstring says so.

### 15.4 `authorityChange` already has a codec, and it is 10 bytes, not 8

Draft §4.4 puts `encodeAuthorityChange(out, msg)` / `decodeAuthorityChange` in a
new `packages/protocol/src/control.ts` with `AUTHORITY_CHANGE_BYTES = 8` and no
header. Shipped: `packages/net/src/shadow.ts:85-117`,
`encodeAuthorityChange(out, tick, eventSeq)` taking two scalars rather than a
message struct, writing its own 2-byte header, `AUTHORITY_CHANGE_BYTES = 10`, and
a decoder that **validates the header it skips** rather than assuming it. Plan 4
writes no `authorityChange` codec. Draft §3.3's *"Seven of them have no codec"*
is six.

### 15.5 `reconcile` is private and is called from `tick()`

Draft §16 Q29 asks whether `ShadowLoop` exposes it. `shadow.ts:506` is
`private reconcile(snap: WireSnapshot): void`, called at `shadow.ts:397`.

### 15.6 Reclaim shipped, on both loops

Draft §5.10: *"One line, and spec §5's 'reclaims it on reconnect with the same
room code' has **no other implementation anywhere**"*, and §2a lists it as a file
Plan 4 modifies. It is at `authority.ts:159` and mirrored at `shadow.ts:367`,
both with comments explaining the identity-by-claim caveat and both deferring
authentication to this plan — which §4.7 now supplies.

### 15.7 The datagram guard shipped, so GAP-2's crash is already closed

Draft §5.8: *"`decodeHeader` throws only on an unknown *tag* or a version
mismatch, which stays a hard failure by design"*, and §9.1 asserts non-throwing
behaviour only for `net/wsframe` and `net/signal`. `packages/net/src/receive.ts`
exists (Task 15b), all three loops route every datagram through it
(`authority.ts:102`, `client.ts:357`, `shadow.ts:320`), and `BitReader.readBits`
now throws on a read past the end of its buffer (`bits.ts:104-108`) so a
truncated frame fails loudly into that guard instead of decoding into a silent
all-zeros world. Draft Q27's *"crashes the client rather than desyncing it"* is
unreachable.

### 15.8 `eventSeq` continuity is not emergent

Draft §7.1: *"already emergent: `applyEvent` sets
`state.nextEventSeq = ev.eventSeq + 1`, so the shadow's counter is the highest
observed + 1 the moment it promotes."* That is true only if no event was ever
lost. The shipped loop keeps a separate `eventSeqFloor` — the highest `eventSeq`
seen in **any** snapshot header, applied or not (`shadow.ts:280, 399`) — and
raises `nextEventSeq` to it inside `promote()` (`shadow.ts:530, 572-573`),
because *"every client ignores an eventSeq at or below the highest it has
applied, so the newly promoted authority's events were SILENTLY DROPPED by the
whole room until its counter climbed past the host's."*

### 15.9 `ShadowLoop` does not copy its `SimContext`

Draft §8's sole-writer table: *"`ctx.isLeader` — the owning loop's constructor,
and `ShadowLoop.promote()`. Every loop copies its `ctx` (`authority.ts:93`,
`client.ts:193`), **so no caller's object is ever mutated**."* `AuthorityLoop`
and `ClientLoop` do copy (`authority.ts:89`, `client.ts:312`). **`ShadowLoop`
does not** — `shadow.ts:245` is `this.ctx = ctx`. The draft's conclusion is false
for the one loop the server owns, and the draft's own §6.10 `makeContentProvider`
gives no freshness rule, so the obvious optimisation (memoise `contextFor`, since
`loadTrack` already memoises) would have made one room's promotion flip
`isLeader` for all 64. §7.1 is the rule; §8.1's two-room test is the proof.

### 15.10 `MAX_CATCHUP_TICKS` is 5, not 8, and the accumulator takes a delta

Draft §6.8 gives `server/ticker.ts` `MAX_CATCHUP_TICKS = 8` and
`advanceTicker(t, nowMs)` over a `Ticker { residualMs, lastNowMs }`. Plan 3 §5.1
gives `game/clock.ts` the same 8 and `advanceAccumulator(acc, nowMs)`. Task 15c
item B shipped **`MAX_CATCHUP_TICKS = 5`** and
**`advanceAccumulator(acc, elapsedMs)`** over a `TickAccumulator { residualMs }`
with no `lastNowMs` — so the caller owns the previous timestamp. This is the one
place where the draft's number and a locked contract's number are both wrong
against shipped code, and it matters twice: 8 ticks is 133 ms of simulation per
call where 5 is 83 ms, and a function that takes a timestamp is not
substitutable for one that takes a delta. §5.8's `stepRace` is written against
what shipped, and Plan 3 §5.1 needs the same one-line correction it already needs
for the import (§2.9).

### 15.11 Every quoted line number in the draft is stale

The draft opens *"Every signature in §3 was read out of real source … and is
quoted, not reconstructed."* The signatures are broadly right; the citations are
not. A sample, draft → actual (the right-hand column as of this contract's second
read; the worktree is live and several of these moved again mid-session, which is
why §2.10 states that line numbers are evidence and signatures are contract):

| Draft cites | Actually at |
|---|---|
| `authority.ts:60, 90, 104, 154` (class, ctor, `state`, onMessage) | `56, 86, 105, 118` |
| `authority.ts:175, 181` (the two `.slice()`s) | `198, 204` |
| `authority.ts:10, 178` (snapshot cadence) | `11, 201` |
| `authority.ts:29-32, 34, 35` (buffer sizing) | `26-28, 30, 31` |
| `authority.ts:115-121, 125, 126, 144-152, 151` | `118-124, 131, 132, 167-175, 174` |
| `client.ts:155, 190, 291, 333, 341` (class, ctor, `tick`, `corrections`, `state`) | `259, 312, 463, 526, 534` |
| `client.ts:224-260` (onMessage), `client.ts:395` (hardResync) | `373-428`, `602` |
| `client.ts:12, 16, 193, 197-207, 234, 243, 313, 322` | `13, 17, 315, 319-329, 374, 400, 419, 494` |
| `shadow.ts:309-311, 319-357, 316` (triage's own citations) | `468-470, 436-439, 443` |
| `phase.ts:72-79, 82` (`resolveInputs`) | `64-79`, and the `!connected` branch inside it |
| `state.ts:31, 152, 249` (`createState`, `cloneState`, `statesEqual`) | correct |
| `checkpoint.ts:171-175` (the `itemBoxes` throw) | correct |

Two of them matter beyond tidiness: the draft cites `client.ts:193` for a `ctx`
copy that is at 315, in support of §15.9's false claim; and it cites
`authority.ts:115` as *"`const header = decodeHeader(data)`, no length guard"*
(triage GAP-2), which is the pre-15b code — that line is now
`t.onMessage(createDatagramGuard(this).wrap(...))` at `authority.ts:102`.

### 15.12 The room-code alphabet had three homes and three different values

Draft §4.2: `'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'`. Ruled Plan 3 §5.8:
`'23456789ABCDEFGHJKLMNPQRSTUVWXYZ'`, described as *"Ambiguity-free: no O/0, no
I/1"*. Shipped, Task 15c item E: `'0123456789ABCDEFGHJKMNPQRSTVWXYZ'` —
Crockford base32, which **keeps `0` and `1`** and removes the letters `I`, `L`,
`O` and `U`.

All three are 32 symbols and all three are ambiguity-free; they are three
different wire formats, because the alphabet's **order is the 5-bit index**. The
shipped one wins, and two descriptions in already-locked documents are superseded
with it: Plan 3 §5.8's constant, and its "no O/0, no I/1" gloss, which describes
the opposite exclusion set from the one that shipped.

Two smaller consequences ride along. `normalizeRoomCode` no longer strips
out-of-alphabet characters or truncates (Plan 3 §5.8, P4 Q17's ruling) — it trims
and uppercases, and `isValidRoomCode` rejects. And with `0` and `1` in the
alphabet, the draft's argument for *why* substitution is impossible ("neither `0`
nor `1` is in the alphabet either") no longer holds; the shipped file gives the
better reason instead, which is that a second silent transformation of user input
can only ever route a player into a different real room.

### 15.13 Smaller ones

- Draft §3.2's `ClientLoop` block omits `TICK_MS`, `RemoteInterpolator`,
  `RemoteSample`, `RemoteEntitySample`, `remoteInterpolatorOf` and
  `correctionDeltaOf`, all exported from the same file, and all of them things
  Plan 3 §2.5 requires and Plan 4's `game` counterpart consumes.
- Draft §3.4 omits `promotionCursor` from `@tapkart/sim`'s list — the answer to
  its own Q21, exported from `rng.ts` and re-exported by `sim`'s barrel.
- Draft §4.2's alphabet is `'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'`; ruled Plan 3
  §5.8's is `'23456789ABCDEFGHJKLMNPQRSTUVWXYZ'`. Same 32 symbols, different
  order — and **the order is the 5-bit index**, so the two are different wire
  formats. §3.2 takes Plan 3's, because it is the one already in a locked
  document.
- Draft §4.2's `normalizeRoomCode` doc comment says it *"maps O→0-class and
  I→1-class confusions out"* while the prose two paragraphs down says it
  substitutes nothing. §3.2 takes the prose, which matches ruled Plan 3 §5.8.
- Draft §16 Q11 asserts *"`WIRE_TAG` is already frozen by Plan 2"*. F-P4-11:
  *"`WIRE_TAG` is a map with unused space, not a frozen artifact."*
- Draft §12's `"start": "node --experimental-strip-types src/main.ts"` is
  replaced by C-5's bundle.
- Draft §7.3 quotes the buffer constants correctly (1024 / 2048 / 256) from the
  wrong lines, and omits `shadow.ts`'s own `EVENTS_BUF_BYTES = 4096`, which is
  double `authority.ts`'s and deliberately so.

---

## 16. Unruled, needs the controller

Four items. None of them blocks authoring — this contract states what it does in
each case — but each is a decision that belongs to the controller, not to a
contract author.

### 16.1 `net/src/local.ts` and ruled Plan 3 §2.5 disagree on a name and a signature

Plan 3's **locked** contract §2.5 specifies:

```ts
// packages/net/src/localinput.ts — Plan 2 Task 15b (R42)
export interface LocalInputTransport extends Transport {
  deliverLocalInput(playerId: number, intent: Intent, tick: number): void
}
```

Plan 2 shipped, in the working tree:

```ts
// packages/net/src/local.ts
export interface LocalInputTransport extends Transport {
  submitLocalInput(playerId: number, intent: Intent): void
}
```

Different module name, different method name, and the tick moves from a parameter
to `intent.tick`. Plan 3 §5.10's `tickOnce` calls
`transport.deliverLocalInput(localPlayerId, localIntent, state().tick + 1)` and
will not compile against what shipped. Plan 4 needs this only for the host's
composition (`withLocalInput(fanOut)`), so it is cheap for **this** plan either
way — but it is a hard compile error for Plan 3, and the fix is one edit in one
of the two documents. **This contract names neither and touches neither file.**

### 16.2 Who owns the README env table that C-6's drift test reads

C-6 says *"The Dockerfile, the compose file and the README table are checked
against it by a test that fails when they drift."* Plan 4 owns none of those
three files — they are all Plan 5's. §10.2 resolves the half it can: Plan 4 ships
`docs/server-env.md` and asserts it against `formatEnvTable()`, and Plan 5
asserts its own two files against the exported `ENV_SCHEMA`. What is unassigned is
whether the **repo README** also grows an env table (a fourth copy to keep in
step) or whether it links to `docs/server-env.md` (this contract's assumption,
and the one that keeps the count at two).

### 16.3 Ruled Plan 3 §5.8 is superseded three times over, and needs one edit

Not a fork — every one of these is settled by a ruling or by shipped code — but
they land in a **locked** contract that says *"No task may rename, re-sign, or add
fields to anything below"*, so somebody has to make the edit rather than leave two
documents disagreeing. Plan 3 §5.8 currently reads:

```ts
export const ROOM_CODE_LENGTH = 4
/** Ambiguity-free: no O/0, no I/1. Exactly '23456789ABCDEFGHJKLMNPQRSTUVWXYZ' (32 chars). */
export const ROOM_CODE_ALPHABET: string
/** Upper-cases, strips every character outside the alphabet, truncates to
 *  ROOM_CODE_LENGTH. Total: never throws, never returns undefined. */
export function normalizeRoomCode(raw: string): string
```

Three things are now false: the length is 5 (F-P4-34, shipped), the alphabet is
Crockford and the gloss describes the wrong exclusion set (§15.12, shipped), and
`normalizeRoomCode` neither strips nor truncates (shipped). A fourth was already
ruled: the module moves to `@tapkart/protocol` and `game`'s copy is deleted
(C-7). **The whole of Plan 3 §5.8 becomes one line — "room codes are
`@tapkart/protocol`'s, see Plan 4 §3.2" — and `game` imports them.**

### 16.4 F-P4-34's five-character room code contradicts the spec, in four places

The rulings document's own instruction is *"where a ruling contradicts the spec,
say so and stop."* Saying so:

**F-P4-34 rules five-character room codes.** The spec says four, four times:

- §1: *"Everyone else joins by tap, QR, or a **four-character** room code."*
- §2: *"**QR and a four-character room code are always displayed** alongside the
  NFC invite."*
- §2's table row and §5 step 1: *"Server mints a **four-character** code and a
  URL."*

The ruling is unambiguous and reasoned (*"Five characters — 32⁵ ≈ 33.5 M, still
typeable, 32× the space of four"*), and it is the mitigation for a brute-force
exposure this project has already been bitten by, so this contract implements
**five** and derives `PROTOCOL_VERSION = 2` from the resulting wire change
(§3.0). What the controller owes is a **one-word spec amendment in those four
places** — and, separately, the §16.3 edit that retires ruled Plan 3 §5.8.

Nothing else in this document is unruled.

