# Tapkart Plan 4 — Locked Interface Contract (DRAFT, for ruling)

> **STATUS: DRAFT.** This is not yet binding. It is written for the controller to
> rule on and amend. §16 lists every place a guess was made; each item there is an
> amendment that would otherwise land mid-authoring, and Plan 2 measured each
> mid-authoring amendment at roughly two blocking defects at audit.
>
> Once ruled on, this becomes the **Global Constraints** section of the Plan 4
> implementation plan. Every task's requirements implicitly include everything
> here. No task may rename, re-sign, or add fields to anything below. A task
> needing something absent must define it in its own files and say so in its
> `Interfaces` block.

**Spec:** `docs/superpowers/specs/2026-08-13-tapkart-design.md` (amended 2026-08-14)
**Builds on:** Plan 1 (`@tapkart/sim`, merged at `1f1f2c4`, 19 modules, 477 tests),
Plan 2 (`@tapkart/protocol` + `@tapkart/net`, in the `plan2-net` worktree,
finishing), Plan 3 (`@tapkart/render` + `@tapkart/game` + `apps/web`, contract
ruled).
**Scope:** `packages/server`, plus `WebRtcTransport` and `WebSocketTransport` in
`packages/net`, plus the seven `MessageKind`s `packages/protocol` names and does
not yet encode. Plan 4 of 5.

Every signature in §3 was read out of real source in
`.claude/worktrees/plan2-net/packages/*/src/` and is quoted, not reconstructed.
Where a name Plan 4 needs does not exist yet, §3 or §16 says so explicitly.

---

## 0. What Plan 4 is, in one paragraph

Plan 4 is the first plan whose product is a *process*. Plans 1–3 produce
libraries that a test can call; Plan 4 produces a Node server that holds rooms,
brokers WebRTC handshakes, relays for guests whose NAT defeats STUN, runs one
60 Hz shadow simulation per active room, and takes over as authority when the
host's phone leaves. It also produces the two real `Transport` implementations
that Plan 2 deliberately deferred, so that the loops written against
`LoopbackTransport` run unchanged over a real network.

None of that may require a network or a browser to test. The whole contract
below is arranged around one seam: **every decision is a pure function over
injected data; every syscall is a three-line adapter that makes no decisions.**

---

## 1. Conventions that are decided, not negotiable

Plans 1–3's conventions carry forward unchanged and are **not** restated except
where Plan 4 adds to them. In particular: extensionless imports; `import type`
under `verbatimModuleSyntax`; vitest with `globals: false` and
`environment: 'node'`; bare specifiers (`@tapkart/sim`, `@tapkart/protocol`,
`@tapkart/net`) across packages in `src`, never a relative path into another
package; little-endian on the wire; LSB-first bit packing; codecs never allocate
their own buffers; channel names are the exact strings `'unreliable'` and
`'reliable'`.

New for Plan 4:

| Convention | Value |
|---|---|
| Time in `packages/server` | **Every function that needs "now" takes `nowMs: number` as a parameter.** `Date.now()` appears in exactly one file, `packages/server/src/runtime/clock.ts`. `setInterval`/`setTimeout` appear in exactly that file too |
| Time in the two real transports | **Neither reads a clock at all.** They are event-driven: a datagram arrives, a callback fires. Liveness is `packages/net/src/liveness.ts`, which is pure over an injected `nowMs` |
| Sim time vs wall time | The shadow's tick count is produced by `advanceTicker(ticker, nowMs)`, a pure fixed-step accumulator. `SimState.tick` is never derived from a clock reading anywhere else |
| Randomness | Every mint (room code, session token, race seed) goes through `RandomSource`, injected. `node:crypto` appears in exactly one file, `packages/server/src/runtime/random.ts`. Tests pass a counting fake and assert exact strings |
| I/O | `node:fs`, `node:http`, `node:path` and `ws` are importable **only** from `packages/server/src/runtime/**` and `packages/server/src/main.ts`. No other file in the repository may import them |
| Barrels never reach the adapters | `packages/server/src/index.ts` re-exports no file under `src/runtime/` and not `main.ts`; `packages/net/src/index.ts` re-exports no file whose name ends `-browser.ts`. Identical discipline to Plan 3 §8.2, for the identical reason |
| Hostnames | No absolute URL containing a host is constructed anywhere in `src`. The server answers with **paths**; the client builds the absolute URL from its own `location.origin`. No real LAN IP, hostname or host filesystem path appears in any file, fixture, comment or test — RFC 5737 ranges and `example.invalid` only |
| Config paths | Every path in `ServerConfig` is **relative to the process working directory**. An absolute default would bake a host path into a public repo |
| Untrusted input never throws into the event loop | Every decoder that reads bytes off a socket has a total, non-throwing wrapper. A malformed frame closes one socket; it never takes the process down. This is a hard rule, and §9 names which function is which |
| Errors are values in the pure layer | `parseSignal` returns `null`, `resolveRoute` returns a `Route`, `handleHello` returns a `WelcomeMessage` carrying a `JoinResult`. Only the registry's two capacity errors are thrown, and only across a boundary that catches them |

### 1a. The rule that decides whether this plan is testable

Every module in `packages/server` and every new module in `packages/net` is one
of exactly two kinds, and the file says which in its first line:

- **Pure** — a function of its arguments and injected collaborators. No socket,
  no `RTCPeerConnection`, no filesystem, no clock, no timer. **Testable
  headlessly, and every one of them is tested.**
- **Adapter** — the thin layer that hands plain data to a real syscall. Contains
  no decisions: no branching on game or room state, no arithmetic beyond unit
  conversion, no policy. **Not tested in CI, owner-verified** (spec §8, "What CI
  cannot verify").

A conditional in an adapter is a contract violation, because it is a decision CI
cannot see. §9 enumerates both sides, file by file, with nothing left in between.

**The specific failure this rule exists to prevent:** a `WebRtcTransport` that
can only be exercised by opening two browsers. It is avoided by
`RtcConnectionLike` (§5.4) — the transport never names `RTCPeerConnection`, it
takes an interface, and the test passes a two-sided in-memory implementation
that completes an offer/answer/ICE exchange in-process, in microseconds, with no
UDP.

---

## 2. Dependency direction, and what Plan 4 edits in already-shipped code

Spec §3, verbatim:

> `sim` and `protocol` depend on nothing and on each other not at all. `net`
> depends on both. `game` depends on `net`, `render`, and `sim`. `render` reads
> `sim` types and track geometry but never mutates simulation state. `server`
> depends on `sim`, `protocol`, and `net`.

Resolved into `package.json` `dependencies`, exactly:

| Package | Depends on |
|---|---|
| `@tapkart/server` | `@tapkart/sim`, `@tapkart/protocol`, `@tapkart/net`, `ws` |

**Nothing depends on `@tapkart/server`.** In particular `game` does not: the
browser talks to the server over the wire, never over an import. A test that
wants both ends in one process constructs `RoomHub` and a `RoomClient` directly;
that is a `server` test importing `net`, which the direction permits.

**`server` does not depend on `@tapkart/game` or `@tapkart/render`.** This is
load-bearing, not tidy: `game` pulls `three` (Plan 3 §10), and a server that
imports `three` is a server that fails to start on a headless box. It is also
the single largest unresolved problem in this draft, because Plan 3's ruling Q1
put the shipped `Tuning` and `CharacterStats[]` inside `game`, and the shadow
authority cannot build a `SimContext` without them. See §16 Q1.

### 2a. Files Plan 4 modifies in packages Plans 1–2 shipped

Listed once, here, so no task discovers one mid-flight. Nothing else in `sim`,
`protocol` or `net` is touched.

| File | Change | Why it cannot wait |
|---|---|---|
| `packages/protocol/src/index.ts` | add `export * from './roomcode'`, `'./strings'`, `'./lobby'`, `'./control'` | four new modules |
| `packages/net/src/index.ts` | add `export * from './fanout'`, `'./socket'`, `'./wsframe'`, `'./websocket'`, `'./webrtc'`, `'./signal'`, `'./liveness'`, `'./roomclient'`. **Not** `'./webrtc-browser'`, **not** `'./websocket-browser'` | new modules; the two exclusions are §1's barrel rule |
| `packages/net/src/client.ts` | handle `'checkpoint'` and `'authorityChange'`; add `beginRace(seed, characterIdx)`; add `onHardResync(cb)` | `ClientLoop` today ignores both kinds by design (its own comment: "client-side authority migration is a later plan's scope") and hardcodes `createState(this.ctx, 0, ZERO_CHARACTER_IDX)` with `phase = 'racing'`. A guest cannot join a real race until all three land |
| `packages/net/src/authority.ts` | reclaim: input from a seat whose kart is `connected === false` re-marks it connected | spec §5's "reclaims it on reconnect" has **no implementation anywhere today**. §16 Q25 |
| root `package.json` | nothing — `workspaces: ["packages/*"]` already matches `packages/server` | — |
| root `vitest.config.ts` | nothing — `include: ['packages/*/test/**/*.test.ts']` already matches | — |

---

## 3. Signatures Plans 1–3 export that Plan 4 consumes

All quoted from real source in `.claude/worktrees/plan2-net/packages/`.

### 3.1 `@tapkart/net` — the interface the two real transports implement

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
(`src/loopback.ts:32-115`) exhibits and which Plan 4's two implementations
**must** match, because `AuthorityLoop`, `ClientLoop`, `ShadowLoop` and
`RoomClient` all depend on them:

1. **`onMessage` registers an *additional* listener; it never replaces one.**
   `loopback.ts:75-77` pushes onto `messageCbs`. Plan 4 needs this: on a guest,
   `ClientLoop` and `RoomClient` both subscribe to the same transport. A
   replace-semantics implementation silently deletes the lobby.
2. `onPeerLost` likewise appends.
3. `broadcast` reaches **every** peer the transport holds, and the sender is
   never one of them.
4. `send`'s `peerId` must be one of `peers()`; an unknown peer is a **no-op, not
   a throw**.
5. `close()` is idempotent, and after it `peers()` is `[]` and nothing is
   delivered in either direction.
6. Delivered `data` is not retained by the transport after the callback returns;
   a receiver that needs the bytes past the callback copies them. (`AuthorityLoop`
   and `ClientLoop` both `.slice()` on send for exactly this reason —
   `authority.ts:175`, `authority.ts:181`.)

These six are hereby part of the `Transport` contract and §11 names the shared
conformance suite that asserts them against all four implementations.

### 3.2 `@tapkart/net` — the loops Plan 4 hosts and drives

```ts
// src/loopback.ts:5-10, 32-34
export interface LoopbackOptions { latencyMs: number; jitterMs: number; lossRate: number; seed: number }
export function makeLoopbackPair(opts: LoopbackOptions):
  { a: Transport; b: Transport; pump(nowMs: number): void }

// src/apply.ts:30
export function applyEvent(ctx: SimContext, state: SimState, ev: AuthEvent): boolean  // false if already applied

// src/authority.ts:60, 90, 104, 154
export class AuthorityLoop {
  constructor(ctx: SimContext, state: SimState, t: Transport)
  state(): SimState
  tick(): void
}

// src/client.ts:155, 190, 291, 333, 341
export class ClientLoop {
  constructor(ctx: SimContext, playerId: number, t: Transport)
  tick(localIntent: Intent): void
  corrections(): number
  state(): SimState
}

// src/shadow.ts — NOT YET WRITTEN. The Plan 2 contract §5 fixes it as:
export class ShadowLoop {
  constructor(ctx: SimContext, state: SimState, t: Transport)
  tick(): void
  promote(tick: number): void
}
```

**`packages/net/src/shadow.ts` does not exist in the worktree.** `packages/net/src/`
holds `apply.ts`, `authority.ts`, `client.ts`, `index.ts`, `loopback.ts`,
`transport.ts` and nothing else, and `index.ts` re-exports only the first four of
those. Plan 4 is built on top of a class whose behaviour is specified but not
observed. §16 Q20, Q21 and Q29 are the three places that costs a ruling.

Two facts about `AuthorityLoop` as built, which the server's shadow must mirror
and which no prose elsewhere states:

- It forces `isLeader: true` on a **copy** of the caller's `ctx`
  (`authority.ts:93`), so `promote()` flipping the shadow's own copy is legal and
  invisible to the caller.
- It publishes `lastProcessedInputTick` written **in `tick()`, never in
  `onMessage`** (`authority.ts:82`, `authority.ts:165`), and it broadcasts a
  snapshot when `this.live.tick % 3 === 0` (`authority.ts:10`, `authority.ts:178`)
  — the 20 Hz rate the host-loss timer counts against.

### 3.3 `@tapkart/protocol` — what already exists

```ts
// src/types.ts:3-22, 33, 43
export const PROTOCOL_VERSION = 1
export type ChannelName = 'unreliable' | 'reliable'
export type MessageKind =
  | 'hello' | 'welcome' | 'lobby' | 'start'
  | 'input' | 'snapshot' | 'events' | 'checkpoint'
  | 'authorityChange' | 'ping' | 'pong'
export interface WireHeader { kind: MessageKind; protocolVersion: number }
export const WIRE_TAG = {
  hello: 0x01, welcome: 0x02, lobby: 0x03, start: 0x04,
  input: 0x10, snapshot: 0x11, events: 0x12, checkpoint: 0x13,
  authorityChange: 0x20, ping: 0x30, pong: 0x31,
} as const
export function encodeHeader(out: Uint8Array, kind: MessageKind): number  // returns 2
export function decodeHeader(buf: Uint8Array): WireHeader                 // throws on unknown tag or version mismatch
```

`WIRE_TAG` already names all eleven kinds. **Seven of them have no codec**:
`hello`, `welcome`, `lobby`, `start`, `authorityChange`, `ping`, `pong`. Plan 4
writes those seven and adds no twelfth tag (§16 Q11 asks whether that self-imposed
limit is right).

```ts
// src/bits.ts:11-63, 65-107
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

`BitWriter` **neither throws nor grows on overflow** — a typed-array write past
the end is a silent no-op (`authority.ts:29-32` says so explicitly). Every buffer
size in §4 and §6 is therefore derived from a worst case, never guessed.

```ts
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

`encodeCheckpoint` writes **one float64 per field, little-endian, in `SimState`
declaration order** (`checkpoint.ts:12-22`). Counted against `SimState` and a
6-box track: 8 header fields + 8 karts × 24 + 32 entities × 12 + (1 + 2 × boxes)
+ 8 finishedOrder + 8 × 6 heldBotIntent + 8 heldBotTick = **661 fields ≈ 5,288 B**
for a 6-box track, growing 16 B per additional item box. §6.7's checkpoint buffer
is sized from that number and asserted against it.

`decodeCheckpoint` **throws** when `dst.itemBoxes.length` disagrees with the
buffer (`checkpoint.ts:171-175`), which is the server's late-join failure mode if
it hands a client a checkpoint built on a different track. §16 Q27.

### 3.4 `@tapkart/sim` — what the shadow needs

```ts
// src/types.ts:5-8, 151-157
export const MAX_KARTS = 8
export const MAX_ENTITIES = 32
export const TICK_HZ = 60
export const COUNTDOWN_TICKS = 180
export interface SimContext {
  track: Track
  query: TrackQuery
  tuning: Tuning
  characters: CharacterStats[]
  isLeader: boolean
}

// src/state.ts:31, 152, 249; src/replay.ts:75; src/rng.ts:25; src/track.ts:186, 463
export function createState(ctx: SimContext, seed: number, characterIdx: number[]): SimState
export function cloneState(src: SimState, dst: SimState): void
export function statesEqual(a: SimState, b: SimState): boolean
export function allocStateLike(ctx: SimContext, src: SimState): SimState
export function rngAt(seed: number, cursor: number): number
export function validateTrack(track: Track): string[]
export function buildTrackQuery(track: Track): TrackQuery
```

Two facts from `createState` (`state.ts:59-83`, `state.ts:123-138`) that the
`start` message in §4.5 exists to carry:

- **Every seat is created `isBot: true, connected: false`.** Nothing in `sim`
  knows which seats are human. The authority, the shadow and every client must be
  told, identically, or their bot AI drives different karts.
- The state begins at `tick: 0, phase: 'countdown'`, and `resolveInputs`
  (`phase.ts:72-79`) freezes every kart while `phase === 'countdown'`. Countdown
  is therefore free: everyone who calls `createState` with the same seed and the
  same seat map is aligned for the first 180 ticks whatever the network does.

### 3.5 `@tapkart/game` — what Plan 4 must *not* break

Plan 3's ruled contract already fixes two names in the browser that Plan 4's wire
format must agree with, and `game` is authored in parallel with this plan:

- `game/src/roomcode.ts` exports `ROOM_CODE_LENGTH = 4`, `ROOM_CODE_ALPHABET`
  ("Ambiguity-free: no O/0, no I/1"), `normalizeRoomCode`, `isValidRoomCode`.
  §4.2 puts the same four names in `protocol` and asks for the `game` copy to be
  deleted. §16 Q14.
- `game/src/session.ts` exports `createSession(opts: SessionOptions)` with
  `transport: Transport | null` and `localPlayerId: number`, and constructs
  `ClientLoop(ctx, playerId, t)`. Plan 4's `beginRace` is **additive** precisely
  so that signature survives. §16 Q26.

---

## 4. `packages/protocol` — the seven missing message kinds

Zero dependencies except `@tapkart/sim` for its types. No DOM. No clock. Every
codec below is a pure function over a caller-owned buffer, and every one is
round-trip tested field by field including its boundary values.

### 4.0 The convention split, stated before it surprises anyone

`decodeSnapshot`, `decodeInput`, `decodeEvents` and `decodeCheckpoint` all write
into a caller-owned `out` and return `void`, because they are hot-path and their
targets are large and preallocated.

**The seven kinds below are cold-path** — a handful of messages per player per
race — and three of them carry **strings**, which allocate no matter what. So:

> **Cold-path decoders return a fresh object. Hot-path decoders fill an `out`.**

The split is drawn at `WIRE_TAG < 0x10 || >= 0x20` (lobby and control kinds
return; race kinds fill), which is exactly the tag ranges Plan 2 already chose.
§16 Q10 asks for this to be confirmed rather than discovered by a task.

### 4.1 `packages/protocol/src/strings.ts` — length-prefixed UTF-8, pure

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
 *  else. Throws if `bytes.length` exceeds what `lenBits` can express. */
export function writeString(w: BitWriter, bytes: Uint8Array, lenBits: number): void

/** Reads what writeString wrote. Invalid UTF-8 decodes with U+FFFD rather than
 *  throwing: a hostile peer must not be able to throw inside a decode. */
export function readString(r: BitReader, lenBits: number): string
```

`TextEncoder`/`TextDecoder` are ES2022 globals in both Node ≥20 and every target
browser, so `strings.ts` adds no dependency and needs no DOM lib.

### 4.2 `packages/protocol/src/roomcode.ts` — codes and tokens, pure

```ts
/** Exactly 32 symbols: A–Z without I or O, 2–9. 32 = 2^5, so one character is
 *  exactly 5 bits and a 4-character code is exactly 20 bits with no padding and
 *  no lookup failure. This is why the alphabet is 32 and not 33. */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
export const CODE_CHAR_BITS = 5
export const ROOM_CODE_LENGTH = 4
export const ROOM_CODE_BITS = 20          // ROOM_CODE_LENGTH * CODE_CHAR_BITS
export const ROOM_CODE_SPACE = 1048576    // 32^4, stated because §16 Q34 argues about it
export const SESSION_TOKEN_LENGTH = 12
export const SESSION_TOKEN_BITS = 60

/** Upper-cases, maps O→0-class and I→1-class confusions out, strips everything
 *  not in the alphabet. Total: never throws, may return ''. */
export function normalizeRoomCode(raw: string): string
export function isValidRoomCode(raw: string): boolean
export function isValidSessionToken(raw: string): boolean

/** `length` characters as `length` × 5 raw bits, alphabet-index order. */
export function encodeCodeChars(w: BitWriter, code: string, length: number): void
export function decodeCodeChars(r: BitReader, length: number): string
```

**`normalizeRoomCode` substitutes nothing.** It upper-cases and drops every
character outside the alphabet, full stop. The usual "fix the ambiguous
character" mapping (`O`→`0`, `I`→`1`) is *impossible* here, because neither `0`
nor `1` is in the alphabet either — and any other substitution (`O`→`Q`, say)
would silently send a player to a **different real room**. A player who types `O`
therefore gets a short string, `isValidRoomCode` returns `false`, and the UI says
the code is wrong. That is the whole point of an ambiguity-free alphabet: the
disambiguation happens on the *display* side, by never printing a character that
can be misread. §16 Q17.

### 4.3 `packages/protocol/src/lobby.ts` — `hello`, `welcome`, `lobby`, `start`

```ts
export type PeerRole = 'host' | 'guest'

export const CLIENT_FLAG_WEBRTC          = 1 << 0  // this peer can attempt WebRTC
export const CLIENT_FLAG_RTC_FAILED      = 1 << 1  // WebRTC gave up; put me on relay
export const CLIENT_FLAG_NEED_CHECKPOINT = 1 << 2  // send me an AuthorityCheckpoint
export const CLIENT_FLAG_READY           = 1 << 3  // lobby ready toggle
export const CLIENT_FLAG_START_REQUEST   = 1 << 4  // host only; ignored from anyone else

export const SERVER_FLAG_IS_HOST         = 1 << 0
export const SERVER_FLAG_RACE_IN_PROGRESS= 1 << 1
export const SERVER_FLAG_RELAY_ASSIGNED  = 1 << 2
export const SERVER_FLAG_CHECKPOINT_NEXT = 1 << 3

export type JoinResult =
  | 'ok' | 'roomNotFound' | 'roomFull' | 'roomClosed'
  | 'versionMismatch' | 'badRequest' | 'rateLimited'

export interface HelloMessage {
  role: PeerRole
  roomCode: string        // '' when a host is creating a room
  token: string           // '' when this peer has never been welcomed
  characterIdx: number    // 0..15
  name: string            // <= NAME_MAX_BYTES once encoded
  trackId: string         // '' = no opinion; honoured only from the host
  flags: number           // CLIENT_FLAG_*
}

export interface WelcomeMessage {
  result: JoinResult
  roomCode: string
  playerId: number        // -1 unless result === 'ok'
  token: string           // '' unless result === 'ok'
  hostPlayerId: number    // -1 when the room has no host yet
  peerSlot: number        // 1..254; this peer's slot in §5.2's framing
  flags: number           // SERVER_FLAG_*
  lobbyVersion: number
}

export interface WireLobbySlot {
  occupied: boolean; isBot: boolean; connected: boolean; ready: boolean
  characterIdx: number; name: string
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

export function encodeHello(out: Uint8Array, msg: HelloMessage): number
export function decodeHello(buf: Uint8Array): HelloMessage
export function encodeWelcome(out: Uint8Array, msg: WelcomeMessage): number
export function decodeWelcome(buf: Uint8Array): WelcomeMessage
export function encodeLobby(out: Uint8Array, msg: LobbyMessage): number
export function decodeLobby(buf: Uint8Array): LobbyMessage
export function encodeStart(out: Uint8Array, msg: StartMessage): number
export function decodeStart(buf: Uint8Array): StartMessage

/** Worst-case encoded sizes, derived in §4.6 and asserted by a test that encodes
 *  a maximal message and compares byteLength. Every caller sizes its buffer from
 *  these, because BitWriter truncates silently. */
export const HELLO_MAX_BYTES = 55
export const WELCOME_MAX_BYTES = 17
export const LOBBY_MAX_BYTES = 169
export const START_MAX_BYTES = 34
```

### 4.4 `packages/protocol/src/control.ts` — `authorityChange`, `ping`, `pong`

```ts
export interface AuthorityChangeMessage { tick: number; eventSeq: number }

/** One shape for both kinds. `echoMs` is the PINGER's own clock reading and is
 *  opaque to the receiver, which copies it back verbatim. That is what keeps
 *  round-trip timing out of every deterministic path: nobody but the originator
 *  ever interprets it. */
export interface HeartbeatMessage { seq: number; echoMs: number }

export function encodeAuthorityChange(out: Uint8Array, msg: AuthorityChangeMessage): number
export function decodeAuthorityChange(buf: Uint8Array): AuthorityChangeMessage
export function encodeHeartbeat(out: Uint8Array, msg: HeartbeatMessage): number
export function decodeHeartbeat(buf: Uint8Array): HeartbeatMessage

export const AUTHORITY_CHANGE_BYTES = 8
export const HEARTBEAT_BYTES = 6
```

`ping` and `pong` share `encodeHeartbeat`; the two are distinguished only by the
`WIRE_TAG` byte the caller writes with `encodeHeader`. A `pong` copies the
`ping`'s `seq` and `echoMs` unchanged — asserted by a test, because a receiver
that stamps its *own* time turns RTT into clock skew and nothing fails loudly.

### 4.5 Bit layouts, at the precision `snapshot.ts` already uses

All fields LSB-first, in table order, continuously bit-packed with no per-record
padding, exactly like `WireSnapshot`. Every layout is **after** the 2-byte
`encodeHeader` output; the caller writes the header and passes
`out.subarray(2)`, exactly as `authority.ts:179-180` does.

**`hello` (client → server, reliable, tag `0x01`)**

| Field | Bits | Notes |
|---|---|---|
| `role` | 2 | 0 = host, 1 = guest; 2–3 reserved, decode rejects |
| `hasCode` | 1 | 0 when a host is creating a room |
| `roomCode` | 20 | 4 × u5 alphabet index; all zero when `hasCode = 0` |
| `hasToken` | 1 | |
| `token` | 60 | 12 × u5; all zero when `hasToken = 0` |
| `characterIdx` | 4 | |
| `flags` | 16 | `CLIENT_FLAG_*` |
| `nameLen` | 5 | 0..16 |
| `name` | 8 × `nameLen` | UTF-8 |
| `trackIdLen` | 5 | 0..24 |
| `trackId` | 8 × `trackIdLen` | ASCII in practice, UTF-8 by rule |
| **fixed total** | **114 bits** | + 8 × (`nameLen` + `trackIdLen`); max **434 bits = 55 B** |

**`welcome` (server → one client, reliable, tag `0x02`)**

| Field | Bits | Notes |
|---|---|---|
| `result` | 4 | `JoinResult` index, table order as declared in §4.3 |
| `roomCode` | 20 | |
| `playerId` | 4 | **biased +1**; `-1` travels as `0`, same scheme as `AuthEvent.playerId` |
| `hasToken` | 1 | |
| `token` | 60 | |
| `hostPlayerId` | 4 | biased +1 |
| `peerSlot` | 8 | 1..254; 0 and 255 are reserved (§5.2) |
| `flags` | 16 | `SERVER_FLAG_*` |
| `lobbyVersion` | 16 | wraps at 65536, compared with `!==` never `<` |
| **total** | **133 bits = 17 B** | |

**`lobby` (server → all in room, reliable, tag `0x03`)**

| Field | Bits |
|---|---|
| `lobbyVersion` | 16 |
| `hostPlayerId` | 4 (biased +1) |
| `trackIdLen` | 5 |
| `trackId` | 8 × `trackIdLen` |
| per slot × `MAX_KARTS`: `occupied` 1, `isBot` 1, `connected` 1, `ready` 1, `characterIdx` 4, `nameLen` 5, `name` 8×`nameLen` | 13 + 8×`nameLen` |
| **fixed total** | **129 bits**; max **1345 bits = 169 B** |

Slot index **is** `playerId`; there is no `playerId` field in the slot record and
no reordering is legal. `occupied === false` implies `name === ''` and
`ready === false`, asserted on decode.

**`start` (server → all in room, reliable, tag `0x04`)**

| Field | Bits |
|---|---|
| `raceSeed` | 32 |
| `trackIdLen` | 5 |
| `trackId` | 8 × `trackIdLen` |
| `humanMask` | 8 |
| `characterIdx` | 8 × 4 = 32 |
| **fixed total** | **77 bits**; max **269 bits = 34 B** |

**`authorityChange` (server → all, reliable, tag `0x20`)**

| Field | Bits |
|---|---|
| `tick` | 32 |
| `eventSeq` | 32 |
| **total** | **64 bits = 8 B** |

Spec §5 says `authorityChange {tick, eventSeq}` and this carries exactly those
two. It deliberately does **not** name the new authority: every client already
holds a socket to the server, so the swap needs no address. §16 Q30.

**`ping` (tag `0x30`) / `pong` (tag `0x31`), either direction, unreliable**

| Field | Bits |
|---|---|
| `seq` | 16 |
| `echoMs` | 32 |
| **total** | **48 bits = 6 B** |

`echoMs` is a `u32` of milliseconds and wraps every 49.7 days. `notePong`
(§5.6) computes `(nowMs - echoMs) >>> 0` so a wrap costs one bogus RTT sample
and never a negative one.

### 4.6 Why every `*_MAX_BYTES` is derived and not guessed

`BitWriter` silently truncates past the end of its buffer (§3.3). A `lobby`
message with eight 16-byte names encodes to 169 B; a caller with a 128 B buffer
gets a *valid-looking* message whose last two slots are garbage, with no error at
any layer. So every one of the four lobby constants is computed from the table
above **and** asserted by a test that builds the maximal message, encodes it, and
compares `byteLength()` to the constant. Same discipline as `SNAPSHOT_BUF_BYTES`
in `authority.ts:20-33`.

---

## 5. `packages/net` — the two real transports and their pure scaffolding

### 5.1 `packages/net/src/socket.ts` — PURE (interface only)

```ts
export type SocketData = string | Uint8Array
export type SocketReadyState = 'connecting' | 'open' | 'closing' | 'closed'

/** The whole of what a WebSocket is, to everything above the adapter. Both
 *  `ws` on the server and the browser's global WebSocket wrap into this, and
 *  a test's fake pair implements it in 40 lines with no network. */
export interface SocketLike {
  send(data: SocketData): void
  close(code?: number, reason?: string): void
  onMessage(cb: (data: SocketData) => void): void   // appends, never replaces
  onClose(cb: () => void): void                     // appends, never replaces
  readyState(): SocketReadyState
  bufferedAmount(): number
}
```

**Text vs binary is the channel split that makes signalling free:** a WebSocket
frame is natively one or the other, `SocketData` preserves that, and §5.5's
signalling rides text while every `WIRE_TAG` message rides binary. Nothing needs
a discriminator byte to tell them apart.

### 5.2 `packages/net/src/wsframe.ts` — PURE

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
/** Total: returns null on a short, unknown-kind or unknown-channel frame.
 *  Never throws — a hostile peer must not be able to crash a room. */
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

The rejected alternative was deriving the channel from `MessageKind` and shipping
no envelope. It costs zero bytes and is wrong: it makes `kind → channel` a second
source of truth that `ClientLoop`'s existing
`kind === 'snapshot' && channel === 'unreliable'` guards (`client.ts:234`,
`client.ts:243`) would then be checking against themselves. §16 Q38.

### 5.3 `packages/net/src/websocket.ts` — PURE over `SocketLike`

The **client-side** transport: one socket, many peers behind it.

```ts
export const WS_MAX_BUFFERED_BYTES = 1 << 20   // 1 MiB

export interface WebSocketTransportOptions {
  socket: SocketLike
  /** This endpoint's own slot, from WelcomeMessage.peerSlot. Frames whose
   *  origin equals it are dropped: a relay must never echo a peer to itself. */
  selfSlot: number
  /** Slot -> stable peer id. Default `(s) => 'p' + s`; the server's room
   *  transport passes its own so ids match across both ends of a test. */
  peerIdOfSlot?: (slot: number) => string
  maxBufferedBytes?: number
}

export interface WebSocketTransport extends Transport {
  /** Signalling rides text frames on the same socket (§5.5). */
  sendText(text: string): void
  onText(cb: (text: string) => void): void
  /** Unreliable datagrams dropped because bufferedAmount() exceeded the cap.
   *  A test asserts this is 0 in the steady state and non-zero under a stalled
   *  socket — the only visible symptom of back-pressure. */
  droppedUnreliable(): number
  knownSlots(): number[]
}

export function makeWebSocketTransport(opts: WebSocketTransportOptions): WebSocketTransport
```

Behaviour, fixed here because two tasks would otherwise pick differently:

- `broadcast(channel, data)` emits **one** frame addressed to `WS_SLOT_BROADCAST`.
  The server fans it out. It does not emit one frame per peer.
- `send(channel, peerId, data)` emits one frame to that peer's slot; an unknown
  peer id is a **no-op** (§3.1 rule 4).
- `peers()` is every slot learned from a `WS_CONTROL_PEER_JOINED` frame, minus
  `selfSlot`, plus the constant peer for `WS_SLOT_SERVER`. The room itself is
  always a peer, from the first frame onward, because the shadow is always
  listening.
- `WS_CONTROL_PEER_GONE` fires `onPeerLost` for that slot's peer id and removes
  it. **This is the entire mechanism by which a host learns that a relayed guest
  dropped**, and without it `AuthorityLoop.onPeerLost` (`authority.ts:144-152`)
  never runs for a relay guest and their kart never becomes bot-driven.
- When `channel === 'unreliable'` and `socket.bufferedAmount() > maxBufferedBytes`,
  the datagram is **dropped** and `droppedUnreliable()` increments. A `'reliable'`
  datagram is **never** dropped — dropping one silently breaks `eventSeq`
  monotonicity, which is the one thing `applyEvent` cannot recover from.
- `close()` closes the socket and clears the slot table, idempotently.

`packages/net/src/websocket-browser.ts` — **ADAPTER**, not barrel-exported:
`export function browserWebSocket(url: string): SocketLike`. It is the only file
in `net` that names the global `WebSocket`, and because `tsconfig.base.json` sets
`"lib": ["ES2022"]` with no DOM, it declares the two-method shape it needs
locally rather than pulling the DOM lib into the whole repository. §16 Q5.

### 5.4 `packages/net/src/webrtc.ts` — PURE over `RtcConnectionLike`

```ts
export type RtcConnectionState =
  | 'new' | 'connecting' | 'connected' | 'disconnected' | 'failed' | 'closed'

export interface RtcChannelInit { ordered: boolean; maxRetransmits: number | null }

/** Spec §5's two channels, and the only place their RTC configuration is
 *  written. 'unreliable' is ordered:false + maxRetransmits:0 — an SCTP partial-
 *  reliability channel, which is what makes a dropped input datagram free. */
export const RTC_CHANNEL_INIT: Readonly<Record<ChannelName, RtcChannelInit>>

export interface IceCandidateInit {
  candidate: string; sdpMid: string | null; sdpMLineIndex: number | null
}
export interface IceServerConfig { urls: string[]; username?: string; credential?: string }

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

export type RtcConnectionFactory = (iceServers: IceServerConfig[]) => RtcConnectionLike

export interface WebRtcTransportOptions {
  peerId: string
  connection: RtcConnectionLike
  /** The OFFERER creates both DataChannels; the ANSWERER receives them through
   *  onDataChannel. Whichever side is which, the labels are the ChannelNames. */
  role: 'offerer' | 'answerer'
}

export interface WebRtcTransport extends Transport {
  /** Everything this transport wants said to the far side, as data. The caller
   *  posts it over whatever signalling path it has; this module never knows. */
  onLocalSignal(cb: (msg: SignalMessage) => void): void
  /** The far side's signalling, delivered in. Out-of-order and duplicate
   *  messages are tolerated; unknown ones are ignored. */
  acceptSignal(msg: SignalMessage): void
  connectionState(): RtcConnectionState
  /** Datagrams enqueued before both channels opened. Flushed in order on open. */
  queuedCount(): number
  start(): void   // offerer: createOffer + setLocalDescription. answerer: no-op.
}

export function makeWebRtcTransport(opts: WebRtcTransportOptions): WebRtcTransport
```

Behaviour fixed here:

- One `WebRtcTransport` is **one link to one peer**. `peers()` returns
  `[peerId]` while connected and `[]` otherwise. Eight guests on a host means
  eight of these behind one `FanOutTransport` (§5.7). Guests never link to
  guests: the topology is a star centred on the host, never a mesh.
- `send` and `broadcast` are the same operation on a one-peer transport, and
  `broadcast` is implemented as `send` to that peer.
- A datagram sent before `readyState() === 'open'` on its channel is **queued**,
  not dropped, and flushed in send order when the channel opens. Bounded at
  `RTC_QUEUE_MAX` (below); past that, unreliable datagrams are dropped and
  reliable ones keep queuing.
- `onStateChange('failed' | 'closed')` fires `onPeerLost(peerId)` exactly once.
- The transport never times out on its own. The **`RoomClient` owns the give-up
  timer** (§5.8), because giving up means asking the server for relay, which is a
  room decision and not a transport one.

```ts
export const RTC_QUEUE_MAX = 64
export const RTC_CONNECT_TIMEOUT_MS = 8000   // §16 Q39
```

`packages/net/src/webrtc-browser.ts` — **ADAPTER**, not barrel-exported:
`export const browserRtcFactory: RtcConnectionFactory`. The only file in the
repository that names `RTCPeerConnection`. Same local-declaration rule as §5.3.

### 5.5 `packages/net/src/signal.ts` — PURE

```ts
export const SIGNAL_VERSION = 1
export const SIGNAL_MAX_BYTES = 16384   // an SDP with many candidates, with room

export type SignalMessage =
  | { t: 'offer'; sdp: string }
  | { t: 'answer'; sdp: string }
  | { t: 'ice'; c: IceCandidateInit }
  | { t: 'iceDone' }
  | { t: 'giveUp'; reason: string }

/** `from`/`to` are peer SLOTS (§5.2), so signalling and framing share one
 *  address space and the server needs no second routing table. */
export interface SignalEnvelope { v: number; from: number; to: number; msg: SignalMessage }

export function encodeSignal(env: SignalEnvelope): string
/** TOTAL. Returns null on malformed JSON, a wrong version, an over-long payload,
 *  an unknown `t`, or any field of the wrong type. Never throws. The server
 *  calls this on every text frame from every socket, so it is the single most
 *  attacker-reachable function in the project. */
export function parseSignal(text: string): SignalEnvelope | null
```

Signalling is **JSON over text frames**, not a `WIRE_TAG` binary message. Three
reasons, stated so nobody "fixes" it: SDP is already a multi-kilobyte UTF-8 blob
and bit-packing it buys nothing; `MessageKind` has no offer/answer/candidate
members and adding three would put pre-connection setup into the same union as
race traffic; and a signalling exchange that a human can read in a devtools frame
inspector is worth real debugging hours on the one part of this system that fails
in the field and not in CI. §16 Q12.

### 5.6 `packages/net/src/liveness.ts` — PURE

```ts
export const PING_INTERVAL_MS = 1000
export const PEER_STALE_MS = 5000
/** Spec §5, verbatim: "Host loss is declared after 1.5s with no snapshot
 *  (30 missed at 20Hz)." Both numbers are stated so the derivation stays
 *  checkable: 1500 ms / (1000/20) ms = 30. */
export const HOST_LOSS_MS = 1500
export const SNAPSHOT_HZ = 20
export const HOST_LOSS_MISSED_SNAPSHOTS = 30

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

export interface HostWatch { lastSnapshotMs: number; declaredLost: boolean }
export function createHostWatch(nowMs: number): HostWatch
export function noteSnapshot(w: HostWatch, nowMs: number): void
/** True exactly once, on the first call at or past HOST_LOSS_MS since the last
 *  snapshot; sets `declaredLost` so a second call returns false. Promotion must
 *  be idempotent, and this is where that is enforced rather than at the caller. */
export function hostLost(w: HostWatch, nowMs: number): boolean
```

Every one of these is a pure function of `(state, nowMs)`. The 1.5 s promotion
rule is therefore a unit test with three lines and no timers, which is the whole
point.

### 5.7 `packages/net/src/fanout.ts` — PURE

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
 *  Neither a part id nor an inner peer id may contain '/', asserted on add. */
export function scopePeerId(partId: string, peerId: string): string
export function splitPeerId(scoped: string): { partId: string; peerId: string } | null

export function makeFanOutTransport(parts?: FanOutPart[]): FanOutTransport
```

- `broadcast` calls `broadcast` on **every** part — one call, N recipients, which
  is exactly the shape `ClientLoop.tick` already uses (`client.ts:322`).
- `send` routes by the part prefix; an unparseable or unknown scoped id is a
  no-op.
- `onPeerLost` from a part is re-emitted scoped. `removePart` emits
  `onPeerLost` for each of that part's peers first, so an authority learns about
  the karts rather than silently keeping them.
- `close()` closes every part.

### 5.8 `packages/net/src/roomclient.ts` — PURE

The client half of the handshake. It owns exactly the four lobby kinds and the
two heartbeat kinds; it owns none of the race kinds.

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
  relayMode: boolean
  error: string             // '' when none; a JoinResult when rejected
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
  /** Sends the first `hello`. Idempotent. */
  connect(): void
  /** Re-sends `hello` with the patch applied. `hello` IS the lobby update
   *  message — see §16 Q11 for the alternative that adds a twelfth WIRE_TAG. */
  update(patch: RoomClientUpdate): void
  requestStart(): void          // host only; sets CLIENT_FLAG_START_REQUEST
  requestCheckpoint(): void     // sets CLIENT_FLAG_NEED_CHECKPOINT
  reportRtcFailed(): void       // sets CLIENT_FLAG_RTC_FAILED; asks for relay
  /** The one clocked entry point, and `nowMs` is injected. Sends a ping when
   *  `shouldSendPing`, answers pongs, and marks the room closed when stale. */
  poll(nowMs: number): void
  onWelcome(cb: (m: WelcomeMessage) => void): void
  onLobby(cb: (m: LobbyMessage) => void): void
  onStart(cb: (m: StartMessage) => void): void
  onClosed(cb: (reason: string) => void): void
  close(): void
}
```

**Who handles which `MessageKind`** — the table two tasks would otherwise
disagree about:

| Kind | Client side | Server side |
|---|---|---|
| `hello` | `RoomClient` sends | `RoomHub` handles |
| `welcome`, `lobby`, `start` | `RoomClient` handles | `RoomHub` sends |
| `input` | `ClientLoop` sends | `ShadowLoop` handles; relayed to host |
| `snapshot`, `events` | `ClientLoop` handles | `ShadowLoop` handles pre-promotion, sends post-promotion |
| `checkpoint` | `ClientLoop` handles | `RoomHub` sends, from the shadow's state |
| `authorityChange` | `ClientLoop` handles | `RoomHub` sends |
| `ping`, `pong` | `RoomClient` | `RoomHub` |

Every one of those handlers calls `decodeHeader` first and ignores kinds that are
not its own; `decodeHeader` throws only on an unknown *tag* or a version
mismatch, which stays a hard failure by design (`types.ts:43-56`).

### 5.9 Changes to `ClientLoop` (`packages/net/src/client.ts`)

Additive only; the constructor and the four existing members are unchanged so
Plan 3's `createSession` keeps compiling.

```ts
export class ClientLoop {
  // ... existing members unchanged ...

  /** Rebuilds `predicted` as createState(ctx, seed, characterIdx), applies the
   *  seat map, clears the ring and the correction count, and leaves
   *  phase === 'countdown' so the 180-tick freeze runs locally. Replaces the
   *  constructor's placeholder state (client.ts:197-207), which exists only
   *  because Plan 2 had no `start` message to be told any of this by. */
  beginRace(seed: number, characterIdx: number[], humanMask: number): void

  /** Fires when reconciliation could not find `snap.tick` in the ring and had to
   *  hard-resync (client.ts:395). The consumer asks for an AuthorityCheckpoint;
   *  the loop itself never sends, because it holds the race transport and the
   *  request goes over the control transport. */
  onHardResync(cb: () => void): void

  /** Count of hard resyncs, for the repeated-divergence rule in §7.4. */
  hardResyncs(): number
}
```

New kinds handled inside the existing `onMessage` (`client.ts:224-260`):

- **`checkpoint` on `'reliable'`** → `decodeCheckpoint(payload, this.predicted)`,
  clear the ring, clear `pendingSnapshot`, set `highestSeenSnapshotTick` to
  `predicted.tick`. A checkpoint is full-precision truth and everything buffered
  against the old timeline is worthless.
- **`authorityChange` on `'reliable'`** → record `{tick, eventSeq}`. It does
  **not** clear the ring and does **not** reset the state: spec §5 is explicit
  that "there is no rewind" because the shadow has been ticking all along. The
  only state change is that `nextEventSeq` is raised to
  `max(nextEventSeq, msg.eventSeq)` so the promoted authority's first event is
  not rejected as a duplicate by `applyEvent`'s
  `ev.eventSeq < state.nextEventSeq` guard (`apply.ts:31`).

### 5.10 Change to `AuthorityLoop` (`packages/net/src/authority.ts`)

```
onMessage, after the playerId bounds check (authority.ts:125):
    if (!this.live.karts[playerId].connected) this.live.karts[playerId].connected = true
```

One line, and spec §5's "reclaims it on reconnect with the same room code" has no
other implementation anywhere. Without it a dropped player's kart stays
`connected: false` forever, `resolveInputs` keeps routing it through bot AI
(`phase.ts:82`), and their input is decoded, held, and then ignored — a silent
failure with no error and no failing test. §16 Q25 asks whether the host should
require proof of seat ownership before honouring the claim, because as written
any peer can seize any seat by sending an input datagram with that `playerId`.

---

## 6. `packages/server` — module map and exact signatures

### 6.1 `src/types.ts` — PURE

```ts
export type PeerId = string
export type RoomPhase = 'lobby' | 'racing' | 'finished' | 'closed'

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
  phase: RoomPhase
  hostPeerId: PeerId | null
  hostPlayerId: number
  trackId: string
  lobbyVersion: number
  raceSeed: number
  peers: Map<PeerId, PeerRecord>
  slotsInUse: Set<number>
  seats: (PeerId | null)[]      // length MAX_KARTS, index === playerId
  race: RaceRuntime | null
}

export interface RaceRuntime {
  ctx: SimContext               // ctx.isLeader is false until promotion
  state: SimState
  shadow: ShadowLoop
  transport: RoomTransport
  ticker: Ticker
  hostWatch: HostWatch
  promoted: boolean
  promotionTick: number         // -1 until promoted
  startedAtMs: number
}
```

### 6.2 `src/config.ts` — PURE

```ts
export interface RateLimitConfig { windowMs: number; max: number }

export interface ServerConfig {
  port: number                  // default 3031 (spec §9)
  bindHost: string              // default '0.0.0.0'; never a real hostname
  staticRoot: string            // RELATIVE, default 'apps/web/dist'
  tracksDir: string             // RELATIVE, default 'content/tracks'
  wellKnownDir: string          // RELATIVE, default 'public/.well-known'
  maxRooms: number              // default 64
  maxPeersPerRoom: number       // default MAX_KARTS
  roomIdleMs: number            // default 600_000
  joinRateLimit: RateLimitConfig
  iceServers: IceServerConfig[]
  shadowEnabled: boolean        // default true; false makes the server a pure relay
}

export const DEFAULT_CONFIG: Readonly<ServerConfig>

/** Pure over a plain record — `process.env` is passed in, never read here.
 *  Throws with the offending variable's NAME in the message; a server that
 *  starts with a silently-defaulted misspelled variable is worse than one that
 *  refuses. */
export function parseConfig(env: Readonly<Record<string, string | undefined>>): ServerConfig
```

Recognised variables: `PORT`, `BIND_HOST`, `STATIC_ROOT`, `TRACKS_DIR`,
`WELL_KNOWN_DIR`, `MAX_ROOMS`, `ROOM_IDLE_MS`, `JOIN_RATE_WINDOW_MS`,
`JOIN_RATE_MAX`, `ICE_SERVERS` (comma-separated URLs), `SHADOW_ENABLED`.

### 6.3 `src/random.ts` — PURE

```ts
/** Injected everywhere a mint happens. The one implementation that reads the
 *  OS CSPRNG lives in src/runtime/random.ts. */
export type RandomSource = (bytes: number) => Uint8Array

/** `length` characters drawn uniformly from ROOM_CODE_ALPHABET by rejection
 *  sampling — the alphabet is exactly 32 symbols, so 5 bits per character is
 *  uniform with no rejection at all, and that is why it is 32. */
export function mintCode(rand: RandomSource, length: number): string
export function mintRoomCode(rand: RandomSource): string        // ROOM_CODE_LENGTH
export function mintSessionToken(rand: RandomSource): string    // SESSION_TOKEN_LENGTH
export function mintRaceSeed(rand: RandomSource): number        // u32
```

### 6.4 `src/registry.ts` — PURE

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
   *  RoomPhase 'closed'. */
  expire(nowMs: number): RoomRecord[]
  rooms(): RoomRecord[]
  size(): number
}
```

### 6.5 `src/lobby.ts` — PURE

```ts
/** Lowest free seat index, or -1. Seats are assigned in ascending order so a
 *  four-player race always occupies 0..3 and the grid is dense. */
export function assignSeat(room: RoomRecord, peer: PeerRecord): number
export function releaseSeat(room: RoomRecord, peer: PeerRecord): void
export function seatOf(room: RoomRecord, peerId: PeerId): number
/** Sole writer of `lobbyVersion`; returns the new value. */
export function bumpLobbyVersion(room: RoomRecord): number
/** Pure projection of a RoomRecord onto the wire. No side effects, no minting. */
export function buildLobbyMessage(room: RoomRecord): LobbyMessage
export function buildStartMessage(room: RoomRecord, seed: number): StartMessage
export function humanMaskOf(room: RoomRecord): number
export function characterIdxOf(room: RoomRecord): number[]   // length MAX_KARTS
/** Host-only actions are gated here, not at the call site, so there is one
 *  answer to "may this peer do that". */
export function isHost(room: RoomRecord, peer: PeerRecord): boolean
export function canStart(room: RoomRecord, peer: PeerRecord): boolean
```

### 6.6 `src/roomtransport.ts` — PURE

The **server-side** `Transport`: one per room, N sockets behind it. This is what
`ShadowLoop` is constructed over.

```ts
export interface RoomTransportOptions {
  room: RoomRecord
  /** The hub's own send path. Given a peer and a fully framed WS binary frame. */
  sendFrame: (peer: PeerRecord, frame: Uint8Array) => void
}

export interface RoomTransport extends Transport {
  /** The hub calls this for every inbound data frame, after routing. This is
   *  the only way bytes enter a RoomTransport. */
  deliver(peerId: string, channel: ChannelName, payload: Uint8Array): void
  notePeerGone(peerId: string): void
}

export function makeRoomTransport(opts: RoomTransportOptions): RoomTransport
```

`broadcast` reaches every peer in the room except none — the room itself is not a
peer of itself. `peers()` is every `PeerRecord.peerId` currently connected.

### 6.7 `src/hub.ts` — PURE (over injected sockets, registry, clock parameter)

```ts
export interface HubDeps {
  config: ServerConfig
  registry: RoomRegistry
  content: ContentProvider
  rand: RandomSource
  log: LogSink
  rateLimiter: RateLimiter
}

export interface PeerHandle {
  peerId: PeerId
  roomCode(): string | null
  detach(nowMs: number): void
}

export class RoomHub {
  constructor(deps: HubDeps)
  /** A new socket, not yet in any room. The hub subscribes to it and waits for
   *  a `hello`. Sole creator of PeerIds. */
  attach(socket: SocketLike, nowMs: number): PeerHandle
  /** The single per-process heartbeat: advances every room's race by
   *  advanceTicker, evaluates promotion, sends pings, and expires idle rooms.
   *  Called by exactly one scheduler in runtime/clock.ts. */
  poll(nowMs: number): void
  registry(): RoomRegistry
  close(): void
}

/** Exported for tests and for one reason more important than tests: it is the
 *  entire join policy, and a policy that lives inside a socket callback cannot
 *  be asserted. Returns the WelcomeMessage the caller will send; mutates the
 *  room through the registry and lobby modules only. */
export function handleHello(
  deps: HubDeps, room: RoomRecord | null, peer: PeerRecord,
  msg: HelloMessage, nowMs: number,
): WelcomeMessage

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

export const CHECKPOINT_BUF_BYTES = 8192   // >= 5288 B for a 6-box track (§3.3)
export const LOBBY_BUF_BYTES = 256
```

### 6.8 `src/ticker.ts` — PURE

```ts
/** Ticks a single room will run in one catch-up burst before it drops the
 *  remainder. Bounded because N rooms share one process and one stalled room
 *  must not eat another's budget. */
export const MAX_CATCHUP_TICKS = 8
export interface Ticker { residualMs: number; lastNowMs: number }
export function createTicker(nowMs: number): Ticker
/** Folds `nowMs` in and returns how many 60 Hz ticks to run now. Sole writer of
 *  Ticker. Identical in shape to Plan 3's advanceAccumulator, deliberately NOT
 *  imported from it — `server` may not depend on `game`. §16 Q7. */
export function advanceTicker(t: Ticker, nowMs: number): number
```

### 6.9 `src/race.ts` — PURE

```ts
export interface StartRaceOptions {
  room: RoomRecord
  ctx: SimContext            // isLeader MUST be false
  seed: number
  characterIdx: number[]
  humanMask: number
  transport: RoomTransport
  nowMs: number
}

/** Builds the shadow's SimState with createState, applies humanMask to
 *  isBot/connected, constructs the ShadowLoop, and starts the ticker.
 *  Sole constructor of a ShadowLoop in the entire server. */
export function startRace(opts: StartRaceOptions): RaceRuntime

/** Runs advanceTicker(run.ticker, nowMs) ticks of run.shadow. Returns how many
 *  ran. Sole caller of ShadowLoop.tick(). */
export function stepRace(run: RaceRuntime, nowMs: number): number

/** Evaluates hostLost(run.hostWatch, nowMs); on the first true, calls
 *  run.shadow.promote(run.state.tick), sets promoted/promotionTick, and returns
 *  true. Idempotent by construction, because hostLost is. */
export function maybePromote(run: RaceRuntime, nowMs: number): boolean

/** Called on every snapshot the host broadcasts, to feed the host-loss timer.
 *  This is the ONLY thing that resets the 1.5 s clock. */
export function noteHostSnapshot(run: RaceRuntime, nowMs: number): void

export function endRace(run: RaceRuntime): void
```

### 6.10 `src/content.ts` — PURE over injected file access

```ts
export interface ContentProvider {
  track(id: string): Track | null
  /** A SimContext for the shadow. isLeader is FALSE; promote() flips the
   *  ShadowLoop's own copy, never this one. */
  contextFor(trackId: string): SimContext | null
  trackIds(): readonly string[]
}

export function makeContentProvider(
  tracks: Readonly<Record<string, Track>>,
  tuning: Tuning,
  characters: readonly CharacterStats[],
): ContentProvider

/** Pure over injected directory access — no node:fs import here. Runs
 *  validateTrack on every file and throws with the filename and every validator
 *  message when one fails, because a server that serves an invalid track
 *  diverges from every client silently. */
export function loadTracks(
  dir: string,
  listDir: (dir: string) => string[],
  readFile: (path: string) => string,
): Record<string, Track>
```

### 6.11 `src/static.ts` — PURE

```ts
export const WS_PATH = '/ws'
export const HEALTH_PATH = '/healthz'
export const ASSETLINKS_PATH = '/.well-known/assetlinks.json'
export const LOBBY_PATH_PREFIX = '/r/'

export type Route =
  | { kind: 'file'; relPath: string; contentType: string }
  | { kind: 'spa' }                 // serve index.html, 200
  | { kind: 'assetlinks' }          // application/json, NO redirect, ever
  | { kind: 'health' }
  | { kind: 'websocket' }
  | { kind: 'methodNotAllowed' }
  | { kind: 'notFound' }

/** Total, pure, and the whole routing policy. */
export function resolveRoute(method: string, pathname: string): Route

/** Joins and normalises, returning null on any traversal outside `root` —
 *  '..', absolute paths, encoded separators, NUL. The one function standing
 *  between a public URL and the filesystem, and it is unit-tested against a
 *  list of known-hostile paths. */
export function safeJoin(root: string, relPath: string): string | null

export function contentTypeOf(relPath: string): string

/** '/r/ABCD'. A PATH, never an absolute URL: the host's browser builds the
 *  invite URL from location.origin, so no hostname is ever compiled in. */
export function lobbyPathFor(code: string): string
```

Spec §2 and §9 both require `/.well-known/assetlinks.json` to be served with
`Content-Type: application/json` and **no redirect**; `resolveRoute` gives it its
own `Route` kind so that no future "redirect everything to the SPA" rule can
swallow it. The file itself is Plan 5's (the keystore does not exist yet); Plan 4
serves whatever is in `wellKnownDir` and returns 404 when absent. §16 Q8.

### 6.12 `src/log.ts` — PURE

```ts
export type LogEvent =
  | { kind: 'roomCreated'; code: string }
  | { kind: 'roomExpired'; code: string; ageMs: number }
  | { kind: 'peerJoined'; code: string; playerId: number; relay: boolean }
  | { kind: 'peerLeft'; code: string; playerId: number }
  | { kind: 'peerReclaimed'; code: string; playerId: number }
  | { kind: 'raceStarted'; code: string; seed: number; trackId: string }
  | { kind: 'promotion'; code: string; tick: number; eventSeq: number }
  | { kind: 'checkpointSent'; code: string; playerId: number; reason: 'lateJoin' | 'divergence' }
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
`checkpointSent` with `reason: 'divergence'` is that log line, and it is a typed
value rather than a string so a test can assert it happened.

### 6.13 `src/ratelimit.ts` — PURE

```ts
export interface RateLimiter {
  allow(key: string, nowMs: number): boolean
  reset(): void
}
export function makeRateLimiter(cfg: RateLimitConfig): RateLimiter
```

Fixed-window counter keyed by whatever the caller chooses. §16 Q34 is about
*what* the key should be, and it matters more than the algorithm: behind a
Cloudflare Tunnel every request arrives from one TCP peer, so an IP key is a
global throttle for the whole building.

### 6.14 `src/index.ts` — the barrel

Re-exports `types`, `config`, `random`, `registry`, `lobby`, `roomtransport`,
`hub`, `ticker`, `race`, `content`, `static`, `log`, `ratelimit`. **Not**
`runtime/*` and **not** `main`.

### 6.15 The adapters — `src/runtime/**` and `src/main.ts`

```ts
// src/runtime/clock.ts   ADAPTER — the only Date.now() and the only timer
export function realNowMs(): number
export interface Scheduler { start(intervalMs: number, cb: (nowMs: number) => void): void; stop(): void }
export function makeIntervalScheduler(): Scheduler
export const POLL_INTERVAL_MS = 8

// src/runtime/random.ts  ADAPTER — the only node:crypto
export const nodeRandomSource: RandomSource

// src/runtime/files.ts   ADAPTER — the only node:fs and node:path
export function listDirSync(dir: string): string[]
export function readFileSync(path: string): string
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
instead.

---

## 7. Numbers and rules that must agree, or nothing works

### 7.1 The promotion trigger, quoted

Spec §5: *"**Promotion.** Host loss is declared after **1.5s with no snapshot**
(30 missed at 20Hz). The server broadcasts `authorityChange {tick, eventSeq}` on
the reliable channel and switches to leader mode: it begins rolling items from a
PRNG re-seeded deterministically from `(raceSeed, promotionTick)`, and continues
`eventSeq` from the highest it observed."*

Resolved into code, exactly once:

| Fact | Where it lives |
|---|---|
| 1500 ms | `HOST_LOSS_MS`, `net/src/liveness.ts` |
| 20 Hz / 30 missed | `SNAPSHOT_HZ`, `HOST_LOSS_MISSED_SNAPSHOTS`, same file, stated so `1500 / (1000/20) === 30` is checkable |
| what resets the timer | `noteHostSnapshot`, called on every `snapshot` frame **from the host peer only** |
| who declares | `maybePromote`, called from `RoomHub.poll` |
| who broadcasts `authorityChange` | **`ShadowLoop.promote()` — assumed, not observed. §16 Q20** |
| the re-seed formula | **unwritten anywhere. §16 Q21** |
| `eventSeq` continuity | already emergent: `applyEvent` sets `state.nextEventSeq = ev.eventSeq + 1` (`apply.ts:32`), so the shadow's counter is the highest observed + 1 the moment it promotes |

### 7.2 The three cadences

| Cadence | Value | Owner |
|---|---|---|
| Simulation | 60 Hz | `advanceTicker` → `ShadowLoop.tick()` |
| Snapshot broadcast | 20 Hz (`tick % 3 === 0`) | `AuthorityLoop` pre-promotion, `ShadowLoop` post-promotion |
| Input send | 30 Hz, 8-intent window | `ClientLoop`, internally (`client.ts:12`, `client.ts:314`) |
| Ping | 1 Hz | `RoomClient.poll` / `RoomHub.poll` |
| Hub poll | 125 Hz (`POLL_INTERVAL_MS = 8`) | the one scheduler |

The hub polls faster than the sim ticks on purpose: the accumulator turns a
jittery 8 ms timer into exact 60 Hz steps, and a poll that is slower than the
tick makes every room permanently behind.

### 7.3 Buffer sizes, all derived

| Buffer | Bytes | Derivation |
|---|---|---|
| snapshot | 1024 | `authority.ts:34`; worst case 743 B + 2 B header |
| events | 2048 | `authority.ts:35` |
| input | 256 | `client.ts:16` |
| checkpoint | 8192 | 661 float64 fields = 5288 B for a 6-box track, + header, + growth |
| hello / welcome / lobby / start | 64 / 32 / 256 / 64 | §4.3's `*_MAX_BYTES` + header, rounded up to a power of two |
| WS frame | payload + 3 | `WS_HEADER_BYTES` |

### 7.4 Repeated divergence → checkpoint

Spec §5's third failure case, made concrete because nothing in the repository
implements it:

- `ClientLoop.hardResyncs()` counts hard resyncs (§5.9).
- `game` (or a test) calls `RoomClient.requestCheckpoint()` when that count
  crosses `HARD_RESYNC_LIMIT` within `HARD_RESYNC_WINDOW_TICKS`.
- `RoomHub` answers with a `checkpoint` message encoded from **the shadow's own
  state**, not the host's, because the shadow is in-process and already ticking.
- `LogSink` records `checkpointSent { reason: 'divergence' }`.

```ts
// packages/net/src/roomclient.ts
export const HARD_RESYNC_LIMIT = 3
export const HARD_RESYNC_WINDOW_TICKS = 600   // 10 s at 60 Hz
```

§16 Q28 asks whether those two numbers are right and whether the client is the
right place to decide.

### 7.5 Late join

Spec §5 lists late join as the first use of `AuthorityCheckpoint`. Resolved:
`handleHello` sets `SERVER_FLAG_RACE_IN_PROGRESS | SERVER_FLAG_CHECKPOINT_NEXT`
in the `welcome`, and the hub immediately sends a `checkpoint` from the shadow's
state on the reliable channel. The client calls `beginRace` first (so its
`itemBoxes` array is the right length — `decodeCheckpoint` **throws** otherwise,
`checkpoint.ts:171`) and then applies the checkpoint.

---

## 8. Sole-writer rules

Every field below is written by exactly one module. Where two plausibly could,
the rule says which, and why the other is wrong.

| Field | Sole writer | Note |
|---|---|---|
| `SimState.*` on the server | `ShadowLoop` (via `step`, `applyEvent`, `applySnapshotToState`) | The hub, the registry and the lobby never touch a `SimState`. A room's lobby bookkeeping and its simulation share nothing but `humanMask` at `start` |
| `karts[i].connected` on an **authority** | the loop's peer bookkeeping — `AuthorityLoop.onPeerLost` (`authority.ts:151`) and §5.10's reclaim line | Not `applySnapshotToState`: an authority never applies a snapshot to itself |
| `karts[i].connected` on a **follower** | `applySnapshotToState` (`snapshot.ts:280`) | The wire carries `isBot` and `connected` as two independent bits precisely so this transition survives (Plan 2 §4) |
| `SimState.nextEventSeq` on the shadow | `applyEvent` pre-promotion; `emit` post-promotion | The changeover is `ctx.isLeader`, flipped by `promote()` and nothing else |
| `ctx.isLeader` | the owning loop's constructor, and `ShadowLoop.promote()` | Every loop copies its `ctx` (`authority.ts:93`, `client.ts:193`), so no caller's object is ever mutated |
| `RoomRecord.peers`, `slotsInUse`, `PeerRecord.slot` | `RoomRegistry` | The hub asks; it never assigns |
| `RoomRecord.seats`, `PeerRecord.playerId` | `lobby.ts`'s `assignSeat` / `releaseSeat` | |
| `RoomRecord.lobbyVersion` | `bumpLobbyVersion` | One increment per accepted mutation, so a client can compare with `!==` |
| `RoomRecord.phase` | `RoomHub` for `lobby`→`racing`→`finished`; `RoomRegistry.expire` for `closed` | |
| `RoomRecord.lastActivityMs` | `RoomRegistry.touch` | |
| `RaceRuntime.promoted` / `promotionTick` | `maybePromote` | |
| `Ticker.residualMs` / `lastNowMs` | `advanceTicker` | |
| `HostWatch` | `noteSnapshot` and `hostLost` | `hostLost` writes `declaredLost`, which is what makes promotion idempotent |
| `LivenessState` | the five `note*`/`should*` functions in `liveness.ts` | |
| `WebSocketTransport`'s slot table | inbound `WS_FRAME_CONTROL` frames only | Never inferred from a data frame's origin: an unknown origin is a routing bug, and silently learning it hides one |
| the wall clock | `packages/server/src/runtime/clock.ts` (server), `packages/game/src/clock.ts` (browser, Plan 3 §5.1) | Two processes, two clocks, and no third |

**The `startSpinOut` exception from Plan 2 §0 carries forward unchanged**: inside
`applyEvent`, an authoritative event is applied as fact; everywhere else
`startSpinOut` is the sole writer of `spinOutTicks`. Plan 4 adds no new
exception.

---

## 9. Headless testability, per module

Spec §8's "What CI cannot verify" names two things and Plan 4 adds four. Below
that line, everything is a pure function and is tested.

### 9.1 Pure — what CI asserts, module by module

| Module | The assertion |
|---|---|
| `protocol/strings` | `utf8Truncate` never splits a multi-byte sequence, at every boundary from 1 to 16 bytes, over ASCII/BMP/astral inputs; `readString` on invalid UTF-8 yields U+FFFD and does not throw |
| `protocol/roomcode` | every 4-character code round-trips through 20 bits; `normalizeRoomCode` drops `O`/`I` rather than substituting; the alphabet is exactly 32 symbols with no duplicates (a one-line test that protects the whole 5-bit scheme) |
| `protocol/lobby` | all four messages round-trip field-by-field including `playerId === -1`, `token === ''`, empty and maximal names, 8 occupied slots; encoding a maximal message equals its `*_MAX_BYTES` |
| `protocol/control` | `authorityChange` round-trips at `tick = 2^32 - 1`; a `pong` built from a `ping` is byte-identical |
| `net/wsframe` | every frame round-trips; `decodeWsFrame` returns `null` — never throws — on empty, 1-byte, 2-byte, unknown-kind and unknown-channel input |
| `net/websocket` | over a fake `SocketLike` pair: broadcast reaches every learned slot; a `PEER_GONE` control frame fires `onPeerLost` exactly once; an unreliable send past `maxBufferedBytes` is dropped and counted; a reliable send never is; frames from `selfSlot` are ignored |
| `net/webrtc` | over a two-sided in-memory `RtcConnectionLike`: a full offer/answer/ICE exchange brings both channels up; datagrams sent before open are flushed **in order** on open; `'failed'` fires `onPeerLost` once; `RTC_CHANNEL_INIT.unreliable` is `{ordered: false, maxRetransmits: 0}` |
| `net/signal` | `parseSignal` returns `null` for 20 hostile inputs (truncated JSON, wrong version, `t` unknown, `sdp` a number, 1 MB string, prototype-pollution keys) and never throws |
| `net/liveness` | `hostLost` is false at 1499 ms, true at 1500 ms, false on every later call; `notePong` computes RTT across a `u32` wrap without going negative |
| `net/fanout` | one `broadcast` reaches both parts; `removePart` emits `onPeerLost` for each of its peers before dropping it; a `'/'` in a part id throws at `addPart` |
| `net/roomclient` | the full handshake against a scripted transport: `hello` → `welcome` → `lobby` → `start` drives `RoomPhase` in order; a `rateLimited` welcome ends in `closed` with the reason in `error` |
| `net/client` (amended) | a `checkpoint` clears the ring and adopts the decoded tick; an `authorityChange` changes **no** kart field and only raises `nextEventSeq`; `beginRace` produces a state `statesEqual` to `createState` with the same arguments |
| `net/authority` (amended) | input from a seat with `connected === false` re-marks it connected, and the kart stops being bot-driven on the next tick |
| `server/config` | every variable parses; a bad number throws with the variable name in the message; every default path is relative |
| `server/random` | `mintCode` with a counting fake yields an exact expected string; every character is in the alphabet over 10,000 draws |
| `server/registry` | slots are unique and dense; `maxRooms` throws `RoomLimitError`; a ninth peer throws `RoomFullError`; `expire` closes exactly the idle rooms at `roomIdleMs`, not at `roomIdleMs - 1`; `reclaim` returns the same `playerId` and a new slot |
| `server/lobby` | `buildLobbyMessage` on a 3-human room has 3 occupied slots and 5 empty; `humanMaskOf` matches; `canStart` is false for a guest |
| `server/roomtransport` | `broadcast` produces one `sendFrame` per peer; `deliver` reaches every registered `onMessage` listener |
| `server/hub` | **the flagship**: `routeDatagram` over a table of (topology, origin, slot) cases — relay guest broadcast reaches the host and no other guest; host broadcast reaches relay guests and not RTC guests; nothing ever returns to `from` |
| `server/hub` | `handleHello` returns `roomNotFound` / `roomFull` / `versionMismatch` / `rateLimited` for the corresponding setups, and `ok` with a fresh token for a clean join |
| `server/ticker` | 16.67 ms yields 1 tick; 1000 ms yields `MAX_CATCHUP_TICKS`; residual stays `< TICK_MS` |
| `server/race` | **the promotion test, spec §8**: host `AuthorityLoop` + shadow `ShadowLoop` over a loopback pair at 150 ms / 50 ms / 5 %, 600 ticks, then stop the host; assert promotion fires at 1500 ms and not before, no kart's `lap` regresses across it, `entityCount` does not drop to 0, and no `eventSeq` is applied twice |
| `server/content` | an invalid track throws naming the file and the validator message; `contextFor` returns `isLeader: false` |
| `server/static` | `safeJoin` returns `null` for `../`, `..%2f`, absolute paths, NUL, and a Windows-style separator; `resolveRoute('GET', '/r/ABCD')` is `spa`; `ASSETLINKS_PATH` is its own kind and is never `spa` |
| `server/log` | a promotion writes exactly one `promotion` event; a divergence checkpoint writes `checkpointSent { reason: 'divergence' }` |
| end-to-end, in-process | `RoomHub` + two `RoomClient`s over fake sockets: create room, join by code, start, race 600 ticks, kill the host socket, assert the guest keeps receiving snapshots after `authorityChange`. **No network, no browser, one process** |

### 9.2 Adapter — thin, and CI never imports it

Exactly seven adapter files, plus one composition root:

- `packages/net/src/webrtc-browser.ts` — the only `RTCPeerConnection`.
- `packages/net/src/websocket-browser.ts` — the only browser `WebSocket`.
- `packages/server/src/runtime/clock.ts` — the only `Date.now()` / timer.
- `packages/server/src/runtime/random.ts` — the only `node:crypto`.
- `packages/server/src/runtime/files.ts` — the only `node:fs` / `node:path`.
- `packages/server/src/runtime/ws.ts` — the only `ws`.
- `packages/server/src/runtime/http.ts` — the only `node:http`.
- `packages/server/src/main.ts` — the composition root: it wires the seven above
  into `RoomHub` and starts one scheduler. It performs no syscall of its own and
  makes no decision, which is why it is listed apart from the adapters.

Each is a mechanical translation with no branch on room or game state. If one
needs a conditional, the conditional belongs in the pure layer as a returned
value — the same rule Plan 3 §0a fixed for `render`.

### 9.3 What CI cannot verify — restated for this plan

- **How the game feels on a real phone** (spec §8).
- **The NFC tap** (spec §8). Plan 5's, and two physical devices.
- **That NAT traversal works.** CI proves the offer/answer/ICE state machine is
  correct against a fake `RtcConnectionLike`. It cannot prove a real STUN server
  answered, that a symmetric NAT actually defeated the direct path, or that the
  relay fallback triggered in the field. Owner-verified, and the reason
  `droppedUnreliable()` and `connectionState()` are on the public surface at all.
- **That an unreliable SCTP channel is really unreliable.** `maxRetransmits: 0`
  is asserted as configuration, not as observed packet loss.
- **Real socket back-pressure.** `bufferedAmount()` is a fake in every test.
- **Rooms per process** (spec §11's second risk). A budget measured on real
  hardware, not asserted in CI.

---

## 10. Test fixtures — `packages/net/test/fixtures/` and `packages/server/test/fixtures/`

Plan 2 §6's rule binds unchanged: `src` imports across packages by bare
specifier only; **test** code may reach a sibling package's fixtures by relative
path, and `@tapkart/sim`'s `exports` are never widened to publish fixtures.

```ts
// packages/net/test/fixtures/socket-fixtures.ts
/** Two SocketLikes wired to each other. `flush()` delivers everything queued —
 *  the same "the test owns time" discipline makeLoopbackPair uses. */
export function makeFakeSocketPair(): { a: SocketLike; b: SocketLike; flush(): void }
export function makeRecordingSocket(): SocketLike & {
  sentBinary(): Uint8Array[]; sentText(): string[]; deliver(data: SocketData): void; fireClose(): void
}

// packages/net/test/fixtures/rtc-fixtures.ts
/** Two RtcConnectionLikes that complete a real offer/answer/ICE exchange in
 *  memory. `settle()` runs the queued promise chain to completion so a test
 *  needs no timers and no fake clock. THIS is the seam that makes WebRtcTransport
 *  testable without a browser. */
export function makeFakeRtcPair(): {
  offerer: RtcConnectionLike; answerer: RtcConnectionLike
  settle(): Promise<void>; failBoth(): void
}
export function makeFakeRtcFactory(): { factory: RtcConnectionFactory; connections(): RtcConnectionLike[] }

// packages/server/test/fixtures/server-fixtures.ts
export function makeServerContext(): SimContext            // relative import of sim's fixtures
export function makeTestConfig(overrides?: Partial<ServerConfig>): ServerConfig
/** A deterministic RandomSource: byte i of draw n is (n * 31 + i) & 0xff. Every
 *  minted code and token in the suite is therefore an exact expected string. */
export function makeCountingRandom(): RandomSource
export function makeTestHub(overrides?: Partial<HubDeps>): { hub: RoomHub; log: ReturnType<typeof makeMemoryLogSink> }
/** Host + N guests attached to one hub over fake sockets, already welcomed and
 *  seated. The vehicle for the promotion and relay tests. */
export function makeTestRoom(hub: RoomHub, guests: number, nowMs: number): {
  code: string; host: SocketLike; guests: SocketLike[]
}
```

---

## 11. The `Transport` conformance suite

One shared, exported test factory, run against **all four** implementations —
`LoopbackTransport`, `WebSocketTransport`, `WebRtcTransport`, `RoomTransport`:

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

It asserts §3.1's six unstated behaviours. Without it, each implementation
satisfies whichever of the six its own author happened to notice, and the
divergence surfaces as a lobby that works on loopback and silently dies over
WebRTC.

---

## 12. Package manifest and config

```jsonc
// packages/server/package.json
{ "name": "@tapkart/server", "version": "0.1.0", "private": true, "type": "module",
  "exports": { ".": "./src/index.ts", "./main": "./src/main.ts" },
  "dependencies": {
    "@tapkart/sim": "*", "@tapkart/protocol": "*", "@tapkart/net": "*",
    "ws": "<pinned — §16 Q4>"
  },
  "devDependencies": { "@types/ws": "<pinned>" },
  "scripts": { "typecheck": "tsc --noEmit -p tsconfig.json", "start": "node --experimental-strip-types src/main.ts" } }
```

`packages/server/tsconfig.json` is `{ "extends": "../../tsconfig.base.json",
"include": ["src/**/*.ts", "test/**/*.ts"] }`, identical to every other package.

The second `exports` entry keeps `main.ts` reachable to whatever starts the
process while keeping it out of the headless barrel (§1).

`ws` is the **first runtime dependency of any package in this repository**
(Plan 3's `three` is the browser's). Node 20's built-in `WebSocket` is a
*client* only; there is no server implementation in core, and hand-rolling
RFC 6455 framing to avoid one dependency would be the least defensible line of
code in the project. §16 Q4.

The `start` script's `--experimental-strip-types` is a placeholder: the repository
has no build step today and every package's `exports` points at `.ts`. §16 Q6
asks how the server is actually launched in the shipped image.

---

## 13. Exported-symbol census

| Module | Count |
|---|---|
| `protocol/strings` | 7 |
| `protocol/roomcode` | 12 |
| `protocol/lobby` | 28 |
| `protocol/control` | 8 |
| **`protocol` subtotal (new)** | **55** |
| `net/socket` | 3 |
| `net/wsframe` | 15 |
| `net/websocket` | 4 |
| `net/websocket-browser` | 1 |
| `net/webrtc` | 13 |
| `net/webrtc-browser` | 1 |
| `net/signal` | 6 |
| `net/liveness` | 16 |
| `net/fanout` | 6 |
| `net/roomclient` | 7 |
| `net/client` (added members) | 3 |
| **`net` subtotal (new)** | **75** |
| `server/types` | 5 |
| `server/config` | 4 |
| `server/random` | 5 |
| `server/registry` | 6 |
| `server/lobby` | 10 |
| `server/roomtransport` | 3 |
| `server/hub` | 8 |
| `server/ticker` | 4 |
| `server/race` | 6 |
| `server/content` | 3 |
| `server/static` | 9 |
| `server/log` | 5 |
| `server/ratelimit` | 2 |
| `server/runtime/*` + `main` | 13 |
| **`server` subtotal** | **83** |
| **Total** | **213** |

Counted from the declarations in §4, §5 and §6, one per exported name, types and
values alike. Plus 9 fixture exports in §10 and 2 in §11, which are test-only and
not part of any package's public surface.

---

## 14. What Plan 4 deliberately does not build

Stated so a task does not "helpfully" add it:

- **No Dockerfile, no compose file, no CI workflow, no GHCR publish.** Spec §9's
  deploy lane is Plan 5's, consistent with Plan 3's ruling Q11 which already
  moved the PWA manifest, service worker and Dockerfile there.
- **No NFC, no HCE, no App Links verification, no keystore, no APK.** Plan 5. The
  `/.well-known/assetlinks.json` **route** exists; the file does not.
- **No TURN, no coturn, no relay over UDP.** Spec §3: STUN only. The fallback is
  the WebSocket relay this plan builds.
- **No delta encoding of snapshots.** Spec §5: v1 ships uncompressed.
- **No persistence.** Rooms live in memory and die with the process. Spec §1 puts
  accounts and matchmaking out of scope.
- **No matchmaking, no room listing, no public room browser.** A room is reachable
  by code only.
- **No spectators.** `PeerRole` has two members and the ninth joiner is refused
  with `roomFull`. §16 Q37.
- **No Playwright E2E**, unless §16 Q9 rules otherwise.

---

## 15. The failure this contract is written to prevent

Plan 2's contract needed twelve amendments during authoring and each cost roughly
two blocking defects at audit. The four highest-risk shared names in Plan 4,
ranked by how many independent tasks must agree on them:

1. **The WS frame envelope (§5.2).** The client transport, the server transport,
   the hub's router and the relay path all encode or decode those three bytes. A
   disagreement about whether byte 2 is the origin or the destination produces a
   room where everything works until the second guest joins.
2. **`peerSlot` as one address space (§4.5, §5.2, §5.5).** The `welcome` message,
   the frame header and the signalling envelope all carry it. If signalling used
   a separate id space, the server would need a second routing table and the two
   would disagree exactly when a peer reconnects.
3. **The `MessageKind` → handler table (§5.8).** Four classes subscribe to the
   same transport. Two of them handling `checkpoint`, or none of them, are both
   silent failures.
4. **`humanMask` (§4.5, §6.5, §5.9).** The host, the shadow and every client call
   `createState` independently. If they disagree by one bit, one kart is driven
   by bot AI on one machine and by a player on another, and the only symptom is
   that reconciliation never converges for that seat.

---

## 16. Open questions for the controller

Every item below is a place this draft guessed, a place the spec admits two
readings, or a place the existing code and the spec disagree. Each one is an
amendment avoided if ruled on now. Q1, Q20, Q21 and Q25 are functional gaps in
already-written or already-ruled work, not merely questions about this plan.

### Content, packaging and the biggest gap

**Q1. The server cannot build a `SimContext`, and the ruling that put `TUNING`
and `CHARACTERS` in `packages/game` is what prevents it.** Spec §3 says `server`
depends on `sim`, `protocol` and `net` — not `game` — and Plan 3's ruling Q1 put
the only shipped `Tuning` and `CharacterStats[]` in
`packages/game/src/content/tuning.ts`. `ShadowLoop` needs both, plus a `Track`,
or it cannot `step()` at all, which means **the shadow authority cannot exist as
currently packaged.** Four options: (a) a new zero-dependency `packages/content`
exporting `TUNING`, `CHARACTERS` and the six parsed tracks, which both `game` and
`server` depend on — this draft's recommendation; (b) move them into
`@tapkart/sim`'s `src` (not its test fixtures), which Plan 2 §6's "do not publish
fixtures" argument does not actually forbid, since these are shipped constants
rather than fixtures; (c) let `server` depend on `game` — rejected, it pulls
`three` into a headless process; (d) send the tuning table over the wire at
`start` — rejected, it makes the physics table a network-variable. **This is the
single highest-cost item in this document.**

**Q2. Does the server read `content/tracks/*.json` from disk at startup?** This
draft assumes yes, through the injected `listDir`/`readFile` in `content.ts`,
with `TRACKS_DIR` defaulting to the relative `content/tracks`. That works in a
checkout and in a container that copies the directory, but it means the server's
track bytes and the browser's bundled ones (Plan 3 ruling Q12: `import.meta.glob`,
eagerly bundled) come from two different mechanisms and can drift after a partial
deploy. Option: Q1's `packages/content` exports parsed tracks as TS, and neither
side reads a file. Same ruling probably settles both.

**Q3. `packages/server` or top-level `server/`?** Spec §3's tree shows `server/`
outside `packages/`. This draft uses `packages/server`, which the root
`workspaces: ["packages/*"]` and `vitest.config.ts`'s
`include: ['packages/*/test/**/*.test.ts']` both already match — a top-level
`server/` requires editing both, and would be the only workspace outside the
pattern. Confirm the deviation from the spec's tree is intended.

**Q4. `ws` is the first runtime dependency of a shipped package.** Node has no
built-in WebSocket *server*. Confirm `ws`, and name the exact pinned version and
whether `@types/ws` or a local ambient declaration is preferred (the latter keeps
`devDependencies` at zero for the package).

**Q5. `tsconfig.base.json` sets `"lib": ["ES2022"]` with no DOM, so no file in
the repository can name `RTCPeerConnection` or the browser `WebSocket` and
typecheck.** This draft has the two browser adapters declare the minimal shapes
they need locally, rather than adding `"DOM"` to the base config. The alternative
is a per-package `lib` override in `packages/net/tsconfig.json`, which would also
make `document` and `window` visible to every pure module in `net` — precisely
what Plan 3 §8.2 spent a paragraph preventing. Confirm the local-declaration
approach.

**Q6. How is the server actually launched?** Every package's `exports` points at
`.ts` and the repository has no build step. Options: `tsx`/`--experimental-strip-types`
in the image; add a `tsc` emit step for `server` only; or bundle with esbuild the
way Plan 3's ruling Q2 already built a gate script. This decides whether Plan 4
introduces the repository's first build tooling, and whether that is Plan 4's or
Plan 5's.

**Q7. `advanceTicker` duplicates Plan 3's `advanceAccumulator`.** Same shape,
same `MAX_CATCHUP_TICKS`, two implementations, because `server` may not depend on
`game`. Option: move the accumulator into `@tapkart/net` (which both depend on)
and have Plan 3 import it — but Plan 3's contract is already ruled and this would
amend it. Two definitions of one 12-line function, or one amendment?

**Q8. `/.well-known/assetlinks.json` in Plan 4 or Plan 5?** The route is Plan 4's
(it is a server route). The file's contents require the signing keystore, which
is Plan 5's. This draft serves whatever is in `WELL_KNOWN_DIR` and 404s when
absent. Confirm — and confirm that a 404 rather than an empty JSON document is
the right absent-state, since a malformed `assetlinks.json` fails App Links
verification *silently* (spec §2).

**Q9. Playwright E2E: Plan 4 or Plan 5?** Spec §8's last row calls for it and
Plan 3's contract §8.3 explicitly assigned it to Plan 4 ("it needs two browser
contexts joining by code, and there is no server to join until then"). But Plan
4's own brief says everything must be testable with **no browser**. Both cannot
hold. This draft assumes the vitest suite is browserless and complete, and that
Playwright is a separate lane; whether that lane runs in Plan 4 or Plan 5 needs a
ruling.

### Protocol shape

**Q10. Cold-path decoders return a value; hot-path decoders fill an `out`
(§4.0).** Confirm, or make all eleven kinds consistent one way. The existing four
codecs all use `out`, so "consistent" currently means `out` — but three of the new
messages carry strings and allocate regardless.

**Q11. `hello` doubles as every client→server lobby update and as the
checkpoint request (§4.3, §5.8).** A player toggling ready, changing character,
the host choosing a track, the host pressing start, a client asking for a resync,
and a reconnecting client reclaiming a seat are all one idempotent "here is my
current declaration" message. It needs no twelfth `WIRE_TAG` and `WIRE_TAG` is
already frozen by Plan 2. The alternative is adding `clientUpdate: 0x05` and
`resyncRequest: 0x14`, which is cleaner semantically and costs a protocol
amendment. Rule either way, but rule.

**Q12. Signalling is JSON over WebSocket text frames; everything else is binary
(§5.5).** Confirm. The alternative is three new `WIRE_TAG`s carrying
length-prefixed SDP.

**Q13. `trackId` travels as a string (up to 24 UTF-8 bytes), not as a manifest
index.** A string costs ~20 B per `lobby`/`start` and survives a manifest
reorder; an index is 3 bits and breaks silently if the six tracks are ever
reordered differently in `game` and on the server. Confirm the string.

**Q14. `ROOM_CODE_ALPHABET` exists in two places.** Plan 3's ruled contract §5.8
puts it in `packages/game/src/roomcode.ts`; this draft puts it in
`@tapkart/protocol` because the server must mint from the same alphabet and
`server` cannot import `game`. Recommendation: `protocol` owns it, `game`
re-exports or imports it, and Plan 3's copy is deleted. That is an amendment to a
ruled contract and needs saying out loud.

**Q15. Session tokens are 12 characters of the 32-symbol alphabet — 60 bits.**
Confirm the length, and confirm that the token is the *only* proof of seat
ownership. Related: the token is stored client-side (localStorage, Plan 3's
`KeyValueStore`) so a reclaim survives a page reload, which means it must not be
in the URL.

**Q16. Which STUN servers?** Spec §3 says STUN only, no coturn — but names no
server. This draft has `ServerConfig.iceServers` configurable via `ICE_SERVERS`,
delivered to clients in the signalling channel. The shipped default is unset: a
public third-party STUN endpoint is an external dependency and a privacy
disclosure, and the owner should choose it deliberately rather than inherit it
from a contract draft. Confirm the default (empty? a named public server?) — with
an empty list, WebRTC only ever succeeds on the same LAN and everything else
falls to relay.

**Q17. `normalizeRoomCode` drops unknown characters rather than substituting
(§4.2).** A player who types `O` in a code gets "invalid code" rather than being
routed to a room containing `Q` or `0`. This draft is confident, but the opposite
choice (map `O`→`0`, `I`→`1`) is common — and impossible here, because neither
`0` nor `1` is in the alphabet. Confirm the drop-and-reject behaviour and the UI
copy implication.

**Q18. Name handling.** Names are 16 UTF-8 bytes, displayed to every player in
the room. No filtering, no uniqueness, no reserved-name check is specified
anywhere. Is an empty name legal (this draft: yes, and the UI shows "Player 3")?

**Q19. `ping`/`pong` ride the unreliable channel.** Confirm. Over WebSocket both
channels are reliable anyway; over WebRTC, a heartbeat on the reliable channel
would queue behind retransmits and report the wrong liveness.

### Authority and handover

**Q20. `packages/net/src/shadow.ts` does not exist yet, and Plan 4 is built on
it.** Specifically: does `ShadowLoop.promote(tick)` broadcast the
`authorityChange` message itself (it holds a `Transport`), or does the caller?
Does it flip its own `ctx.isLeader`? Does it begin broadcasting snapshots at
20 Hz after promotion, the way `AuthorityLoop` does? This draft assumes yes to
all three and puts only *detection* in the server. If Plan 2's Task 16 shipped
differently, §6.9 and §7.1 both change.

**Q21. The PRNG re-seed formula is specified in prose and written nowhere.**
Spec §5: "a PRNG re-seeded deterministically from `(raceSeed, promotionTick)`".
`sim`'s PRNG is `rngAt(seed, cursor)` with `seed` and `cursor` both living in
`SimState`. So re-seeding means writing `state.raceSeed`, a field `statesEqual`
compares and `AuthorityCheckpoint` carries — after which the shadow's `raceSeed`
differs from every client's forever. That is harmless today (only a leader
draws), but it makes `statesEqual` between authority and shadow permanently
false, which is exactly what the promotion test wants to assert. Name the exact
formula and name what the promotion test compares instead.

**Q22. Who detects host loss?** This draft: the server, in `RoomHub.poll` via
`maybePromote`, because it is the only participant with both a clock and the
snapshot stream. Confirm. Also: is "no snapshot for 1.5 s" the *only* trigger?
A host whose socket closes cleanly is known-gone instantly, and waiting 1.5 s to
promote when the WebSocket already fired `close` is 1.5 s of nobody driving.
May a clean socket close promote immediately?

**Q23. Can authority ever return to the original host?** Spec is silent. This
draft: **never** — a promoted server stays the authority for the rest of the
race, and a returning host rejoins as an ordinary client. Confirm, because the
alternative needs a second `authorityChange` direction and a rewind rule.

**Q24. What happens when the *server* dies mid-race?** Every client holds a
socket to it, but the race is host-authoritative over WebRTC and would keep
running for the direct-connected guests, while relay guests would drop
instantly. Does the client tear the race down on server loss, keep playing
without a shadow, or attempt reconnection? Nothing in the spec covers it.

**Q25. Reclaim is not implemented anywhere, and today it silently fails.**
`AuthorityLoop.onPeerLost` sets `connected = false` (`authority.ts:151`), and
nothing ever sets it back. A reconnecting player's inputs are decoded, held, and
then discarded by `resolveInputs`, which routes any `!connected` kart through bot
AI (`phase.ts:82`). §5.10 proposes a one-line fix in `authority.ts`. But that fix
lets **any** peer seize **any** seat by sending an input datagram with that
`playerId`, because `AuthorityLoop` learns `peerId → playerId` from the datagram
itself (`authority.ts:126`) and validates nothing. Options: accept it (a
friends-only room over a code); have the server tell the host the authorised
`peerId → playerId` map over the reliable channel; or move seat assignment onto
the host entirely. This is a real security decision, not a style one.

**Q26. `ClientLoop.beginRace(seed, characterIdx, humanMask)` is additive so
Plan 3's `createSession` keeps compiling.** Confirm — or approve a constructor
change, which is cleaner but amends a ruled contract. Related: today's
constructor forces `phase = 'racing'` and warns that any paired authority must do
the same (`client.ts:198-205`); `beginRace` leaves `phase = 'countdown'`, which
is correct for a real race and **changes the behaviour Plan 2's own integration
test relies on**.

**Q27. Late-join checkpoints come from the shadow, not the host (§7.5).** The
shadow is in-process, already ticking, and needs no round trip to the host's
phone. The cost is that the joining client starts from a state up to one snapshot
interval behind the host's and reconciles forward. Confirm. Also confirm the
failure mode is acceptable: `decodeCheckpoint` **throws** when the client's
`itemBoxes` length differs (`checkpoint.ts:171`), which happens if the client
built its state on a different track — a mis-ordered `start`/`checkpoint` pair
crashes the client rather than desyncing it.

**Q28. Repeated-divergence thresholds (§7.4): `HARD_RESYNC_LIMIT = 3` within
`HARD_RESYNC_WINDOW_TICKS = 600`.** Both are invented by this draft; the spec
says only "diverges repeatedly". Confirm the numbers and confirm the client is
the right detector (it is the only participant that knows, but it is also the one
participant with an incentive to lie).

**Q29. Plan 2's `ShadowLoop` reconciliation is described but unobserved.**
`applySnapshotToState`'s docstring ends "This residue with no wire representation
is consumed downstream by `ShadowLoop.reconcile` (Task 16)" — a method not in the
class signature Plan 2 §5 locks. Does `ShadowLoop` expose `reconcile`, or is it
internal to `tick()`? The server never calls it either way, but the promotion
test asserts on its results.

**Q30. `authorityChange` carries `{tick, eventSeq}` and does not name the new
authority.** Correct today, because the only possible promotee is the server every
client already holds a socket to. If a future host-migration-to-another-phone
ever lands, this message needs a third field. Confirm the two-field form is
frozen for v1.

### Rooms and lobby

**Q31. The server owns lobby truth; the host is a privileged client.** Spec §5
step 1 has the server minting the code and starting a shadow, and step 5 has the
lobby riding the reliable channel without saying whose state it is. This draft
makes the server authoritative for seats, names, ready flags, track choice and
the start signal, because it is the only participant that survives a host's
backgrounded browser tab. The alternative — the host owns the lobby and the
server relays it — matches "host-authoritative" more literally. Rule.

**Q32. `humanMask` semantics.** Bit `i` set means seat `i` is a connected human
at the moment `start` is sent; every clear bit is a bot. A player who is in the
room but not "ready" is still a human seat. Confirm — and confirm that a player
who joins *after* `start` takes a bot's seat (this draft: yes, via late join,
and the kart's `isBot` flips on the authority, which reaches everyone through the
snapshot's two independent bits).

**Q33. Room idle timeout, room cap, peer cap.** Spec says only "Rooms expire
after a period of inactivity" and "This bounds room capacity per server process".
This draft: `roomIdleMs = 600_000`, `maxRooms = 64`, `maxPeersPerRoom = 8`.
64 rooms × one 60 Hz arcade sim is the number spec §11 says to measure early —
confirm it as a starting point, and confirm the behaviour at the cap (this draft
refuses room creation with `roomFull` rather than evicting).

**Q34. Room-code brute force behind a single-IP tunnel.** 32⁴ = 1,048,576 codes,
and a room lives ten minutes. An attacker enumerating codes finds live rooms
quickly. Rate limiting is the mitigation, but spec §9's Cloudflare Tunnel means
every request arrives from one TCP peer, so an IP key throttles the whole
building — this project has already been bitten by exactly that. Options: key the
limiter on `CF-Connecting-IP` (trusting a header the tunnel sets), limit *failed*
joins per room code rather than per client, lengthen codes to 5 characters
(33.5 M, still typeable), or accept it because a joined stranger can do nothing
but race. Rule.

**Q35. The server returns paths, never absolute URLs (§6.11).** `lobbyPathFor`
yields `/r/ABCD` and the host's browser builds the invite URL from
`location.origin`, so no hostname is ever compiled into the repository. Spec §5
step 1 says the server "mints a four-character code **and a URL**". Confirm the
path-only reading — it is the only one compatible with the no-real-hostnames rule
for a public repo.

**Q36. "Results screen, then back to the lobby with the room intact" (spec §5
step 7).** What resets? This draft: `RoomRecord.phase` returns to `'lobby'`, the
`RaceRuntime` is disposed, seats and `characterIdx` survive, `raceSeed` is
re-minted at the next `start`, and `lobbyVersion` bumps. Confirm — particularly
whether karts that were bot-filled last race stay bot-filled.

**Q37. The ninth joiner.** Refused with `roomFull`. No spectator mode, no queue.
Confirm, given `PeerRole` reserves two of its four bit values for exactly this.

### Transport and framing

**Q38. The three-byte WS envelope (§5.2) versus deriving the channel from
`MessageKind`.** This draft ships the envelope because the alternative creates a
second source of truth for a mapping `ClientLoop` already guards on. It costs
3 bytes on every datagram — at 20 Hz snapshots and 30 Hz inputs, about 150 B/s
per peer. Confirm.

**Q39. Who decides a guest is relay-only, and after how long?** This draft:
`RoomClient` starts an `RTC_CONNECT_TIMEOUT_MS = 8000` timer when signalling
begins, and on expiry sends `hello` with `CLIENT_FLAG_RTC_FAILED`; the server
sets `PeerRecord.relay` and begins relaying. 8 s is invented. Also: should a guest
attempt WebRTC at all when the room already knows the host is unreachable
directly (e.g. two prior guests both failed)?

**Q40. `Transport.onMessage` appends listeners rather than replacing (§3.1).**
`LoopbackTransport` does this and nothing states it. Plan 4 depends on it
absolutely: a guest has `ClientLoop` and `RoomClient` on one transport. Confirm
it as a locked part of the `Transport` contract, and confirm the conformance
suite in §11 is worth its weight.

**Q41. Fan-out peer ids are `partId + '/' + peerId` (§5.7), and neither half may
contain `/`.** Confirm the separator and the assertion. `AuthorityLoop` uses
`peerId` only as a `Map` key (`authority.ts:88`), so any opaque string works —
but a test that prints peer ids will show them, and a room log with
`rtc/host` in it is easier to read than a UUID.

**Q42. The guest is the offerer; the offerer creates both DataChannels.**
Convention only — the spec says nothing. Confirm, because the answerer's code
path (`onDataChannel`) is completely different from the offerer's and every task
touching WebRTC must assume the same one.

**Q43. Back-pressure: unreliable datagrams are dropped when `bufferedAmount()`
exceeds 1 MiB; reliable ones are never dropped (§5.3).** Confirm the threshold
and the asymmetry. The alternative for reliable traffic is closing the socket,
which at least fails loudly instead of growing memory without bound.

**Q44. The host uplink cost of the shadow.** Spec §5 computes ~55 KB/s typical
for "8 peers + shadow", so the shadow's share is already in the budget. But the
host's snapshots reach the shadow over the **WebSocket**, which is TCP: a stalled
TCP connection to the server head-of-line-blocks the host's own reliable channel
and can back-pressure into the game loop. Should the host's snapshot feed to the
server be droppable under back-pressure (this draft: yes, it is `'unreliable'`
and §5.3's rule applies) even though dropping it advances the host-loss timer
toward promoting a shadow that is perfectly healthy?

**Q45. Datagram size versus MTU.** A worst-case snapshot is 743 B + 2 B header +
3 B envelope = 748 B, comfortably inside any path MTU, so no fragmentation layer
is needed anywhere. A worst-case `AuthorityCheckpoint` is ~5.3 KB and rides the
reliable channel, which fragments for us. Confirm nothing else in this plan can
produce an oversized unreliable datagram (`lobby` at 169 B is the largest
non-race message and it is reliable).

### Testing

**Q46. May one smoke test bind `127.0.0.1:0`?** The brief says "no network".
Binding an ephemeral loopback port is hermetic, leaves the machine untouched, and
is the only way to prove `runtime/http.ts` and `runtime/ws.ts` are wired together
at all. Without it, the composition root is the one thing CI never runs. This
draft assumes **no** — the adapters are owner-verified — but the case for one
loopback test is strong.

**Q47. Where does spec §8's promotion test live?** Spec §8 lists it under `net`.
But with detection in `server/race.ts` and the room hub owning the transports, the
end-to-end version can only be written in `packages/server/test/`. This draft
puts a `net`-level test on `ShadowLoop` alone (Plan 2's) and the full
kill-the-host test in `server`. Confirm the split.

**Q48. Is the fake `RtcConnectionLike` pair (§10) enough?** It exercises the
state machine and the queue-before-open path. It cannot exercise SCTP ordering,
partial reliability, or ICE restarts. Is there appetite for an optional,
non-CI integration test against real `node:wrtc`-class bindings, or is
owner-verification on two phones the whole story?

**Q49. Rooms per process (spec §11's second risk) — measured how?** A benchmark
test that ticks N rooms for M ticks and asserts wall-clock cost is a flaky test
on shared CI. This draft has no such test and states the limit as
`maxRooms = 64`, unmeasured. Should Plan 4 ship a benchmark script that the owner
runs, rather than a test CI runs?

**Q50. Does anything assert that `packages/server` never imports `three`,
`@tapkart/game` or `@tapkart/render`?** Plan 3 relies on barrels and discipline
for the equivalent rule. A ten-line test that reads every `src/**/*.ts` and greps
its import specifiers against an allowlist would make §1's adapter rule and §2's
dependency direction mechanically checkable for the whole repository, not just
this package. Worth it, or ceremony?
