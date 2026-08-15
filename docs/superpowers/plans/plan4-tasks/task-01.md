### Task 1: Repo plumbing, the Plan 2 + Plan 3 gate, and the `packages/server` scaffold

**Files:**
- Verify (temporary, created and deleted inside Step 1, **never committed**): `plan4-gate.check.ts` (repo root)
- Create: `packages/server/package.json`
- Create: `packages/server/tsconfig.json`
- Test: `packages/server/test/scaffold.test.ts`
- Modify: `package-lock.json` — the `npm install` side effect of Step 4, declared because several tasks in this plan rewrite it and an undeclared root file in a diff reads as an accident

**This task creates no file under `packages/server/src/`.** Contract §5.13's barrel re-exports twelve modules that do not exist yet; it is written by the task that lands the last of them. `packages/server/package.json`'s `exports` map therefore points at files a later task creates, exactly as `packages/content`'s did in Plan 3. `tsc` does not report `TS18003: No inputs were found in config file` because `include`'s `test/**/*.ts` matches this task's test file.

**Interfaces:**

- **Consumes** — the three root files, read out of the repo and quoted so nothing is edited from memory:

  `package.json` (repo root), today:

  ```jsonc
  {
    "name": "tapkart",
    "version": "0.1.0",
    "private": true,
    "type": "module",
    "workspaces": [
      "packages/*"
    ],
    "engines": { "node": ">=20.0.0" },
    "scripts": {
      "test": "vitest run",
      "test:watch": "vitest",
      "typecheck": "npm run typecheck --workspaces --if-present"
    },
    "devDependencies": {
      "@types/node": "^24.0.0",
      "typescript": "^5.9.0",
      "vitest": "^3.2.0"
    }
  }
  ```

  `workspaces` already contains `packages/*`, so `packages/server` needs **no change there** (contract §10.4.1). Plan 3 adds `apps/*`. **This task edits no root file except `package-lock.json`.**

  `vitest.config.ts` (repo root), whole file today:

  ```ts
  import { defineConfig } from 'vitest/config'

  export default defineConfig({
    test: {
      include: ['packages/*/test/**/*.test.ts'],
      environment: 'node',
      globals: false,
      reporters: ['default'],
    },
  })
  ```

  `include` already matches `packages/server/test/`. **No change** (contract §10.4.2). `bench/` and `e2e/` fall outside the glob by construction, which is what keeps a benchmark and a browser out of `npm test` permanently.

  `tsconfig.base.json` (repo root) — `"target": "ES2022"`, `"lib": ["ES2022"]`, `"module": "ESNext"`, `"moduleResolution": "Bundler"`, `verbatimModuleSyntax`, `isolatedModules`, `strict`, `noImplicitOverride`, `noImplicitReturns`, `noFallthroughCasesInSwitch`, `noUnusedLocals`, `noUnusedParameters`, `"noUncheckedIndexedAccess": false`, `useDefineForClassFields`, `forceConsistentCasingInFileNames`, `skipLibCheck`, `noEmit`. **No `DOM` in `lib`, no `resolveJsonModule`, and this task adds neither.**

  `packages/protocol/tsconfig.json`, whole file: `{ "extends": "../../tsconfig.base.json", "include": ["src/**/*.ts", "test/**/*.ts"] }`. `packages/server`'s mirrors it exactly.

- **Consumes** — the gate surface. Everything below is quoted from Plan 2's and Plan 3's shipped source and is the whole of what Plan 4 reaches for across all of its tasks. Step 1 checks **every one of it**:

  ```ts
  // @tapkart/net — src/transport.ts
  export interface Transport {
    send(channel: ChannelName, peerId: string, data: Uint8Array): void
    broadcast(channel: ChannelName, data: Uint8Array): void
    onMessage(cb: (peerId: string, channel: ChannelName, data: Uint8Array) => void): void
    onPeerLost(cb: (peerId: string) => void): void
    peers(): string[]
    close(): void
  }

  // @tapkart/net — src/shadow.ts
  export const HOST_TIMEOUT_MS = 1500
  export const SNAPSHOT_PERIOD_TICKS = 3
  export const SHADOW_HISTORY_TICKS = 24
  export const AUTHORITY_CHANGE_BYTES = 10
  export function encodeAuthorityChange(out: Uint8Array, tick: number, eventSeq: number): number
  export function decodeAuthorityChange(buf: Uint8Array): { tick: number; eventSeq: number }
  export class ShadowLoop {
    constructor(ctx: SimContext, state: SimState, t: Transport)
    tick(nowMs: number): void
    promote(tick: number): void
    promotionTick(): number        // GATE ITEM G3 — see below
  }

  // @tapkart/net — src/authority.ts
  export class AuthorityLoop {
    constructor(ctx: SimContext, state: SimState, t: Transport)
    state(): SimState
    tick(): void
  }
  export function isDemoted(loop: AuthorityLoop): boolean   // GATE ITEM G2

  // @tapkart/net — src/client.ts
  export const TICK_MS: number
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
  export interface RemoteSample { position: Vec3; heading: number; kart: WireKart }
  export interface RemoteEntitySample { position: Vec3; heading: number; entity: WireEntity }
  export class RemoteInterpolator {
    push(kf: RemoteKeyframe): void
    sampleKart(playerId: number, nowMs: number): RemoteSample | null
    sampleEntity(entityId: number, nowMs: number): RemoteEntitySample | null
    liveEntityIds(out: Int32Array): number
  }
  export function remoteInterpolatorOf(client: ClientLoop): RemoteInterpolator
  export function correctionDeltaOf(client: ClientLoop, outPos: Vec3): number | null

  // @tapkart/net — src/receive.ts, src/local.ts, src/loopback.ts, src/apply.ts, src/clock.ts
  export interface DatagramGuard {
    wrap(handle: (peerId: string, channel: ChannelName, kind: MessageKind, payload: Uint8Array) => void):
      (peerId: string, channel: ChannelName, data: Uint8Array) => void
    dropped(): number
  }
  export function createDatagramGuard(owner: object): DatagramGuard
  export function droppedDatagramsOf(loop: object): number
  export const LOCAL_PEER_ID = 'local'
  export function createNullTransport(): Transport
  export interface LocalInputTransport extends Transport {
    submitLocalInput(playerId: number, intent: Intent): void
  }
  export function withLocalInput(t: Transport): LocalInputTransport
  export interface LoopbackOptions { latencyMs: number; jitterMs: number; lossRate: number; seed: number }
  export function makeLoopbackPair(opts: LoopbackOptions): { a: Transport; b: Transport; pump(nowMs: number): void }
  export function applyEvent(ctx: SimContext, state: SimState, ev: AuthEvent): boolean
  export const MAX_CATCHUP_TICKS = 5
  export interface TickAccumulator { residualMs: number }         // ONE field. No lastNowMs.
  export function makeTickAccumulator(): TickAccumulator
  export function advanceAccumulator(acc: TickAccumulator, elapsedMs: number): number  // a DELTA, not a nowMs

  // @tapkart/protocol
  export const PROTOCOL_VERSION: number      // presence only — see the G1 note below
  export type ChannelName = 'unreliable' | 'reliable'
  export type MessageKind =
    | 'hello' | 'welcome' | 'lobby' | 'start' | 'clientUpdate'
    | 'input' | 'snapshot' | 'events' | 'checkpoint' | 'resyncRequest'
    | 'authorityChange' | 'ping' | 'pong'
  export interface WireHeader { kind: MessageKind; protocolVersion: number }
  export const WIRE_TAG: {
    hello: 0x01; welcome: 0x02; lobby: 0x03; start: 0x04; clientUpdate: 0x05
    input: 0x10; snapshot: 0x11; events: 0x12; checkpoint: 0x13; resyncRequest: 0x14
    authorityChange: 0x20; ping: 0x30; pong: 0x31
  }
  export function encodeHeader(out: Uint8Array, kind: MessageKind): number
  export function decodeHeader(buf: Uint8Array): WireHeader
  export interface WireSnapshot {
    tick: number; eventSeq: number; phase: RacePhase
    lastProcessedInputTick: number[]; karts: WireKart[]; entities: WireEntity[]; entityCount: number
  }
  export interface InputDatagram { playerId: number; intents: Intent[] }
  export class BitWriter { constructor(buf: Uint8Array); reset(): void
    writeBits(value: number, bits: number): void
    writeFloatQ(value: number, min: number, max: number, bits: number): void
    byteLength(): number }
  export class BitReader { constructor(buf: Uint8Array); reset(): void
    readBits(bits: number): number
    readFloatQ(min: number, max: number, bits: number): number }
  export const WORLD_HALF = 1024
  export function quantStep(min: number, max: number, bits: number): number
  export const Q: QuantTable
  export const EPS: EpsilonTable
  export function encodeSnapshot(out: Uint8Array, state: SimState, lastProcessedInputTick: number[]): number
  export function decodeSnapshot(buf: Uint8Array, out: WireSnapshot): void
  export function applySnapshotToState(snap: WireSnapshot, dst: SimState): void
  export function encodeCheckpoint(out: Uint8Array, state: SimState): number
  export function decodeCheckpoint(buf: Uint8Array, dst: SimState): void
  export function encodeEvents(out: Uint8Array, events: AuthEvent[]): number
  export function decodeEvents(buf: Uint8Array, out: AuthEvent[]): void
  export const INPUT_REDUNDANCY = 8
  export function encodeInput(out: Uint8Array, playerId: number, intents: Intent[]): number
  export function decodeInput(buf: Uint8Array, out: InputDatagram): void
  export const ROOM_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
  export const ROOM_CODE_LENGTH = 5
  export const LOBBY_PATH_PREFIX = '/r/'
  export function normalizeRoomCode(input: string): string
  export function isValidRoomCode(code: string): boolean
  export function lobbyPathFor(code: string): string

  // @tapkart/sim
  export const TICK_HZ = 60
  export const TICK_DT = 1 / 60
  export const MAX_KARTS = 8
  export const MAX_ENTITIES = 32
  export const COUNTDOWN_TICKS = 180
  export interface SimContext { track: Track; query: TrackQuery; tuning: Tuning; characters: CharacterStats[]; isLeader: boolean }
  export function createState(ctx: SimContext, seed: number, characterIdx: number[]): SimState
  export function cloneState(src: SimState, dst: SimState): void
  export function statesEqual(a: SimState, b: SimState): boolean
  export function allocStateLike(ctx: SimContext, src: SimState): SimState
  export function makeIntentBuffer(): Intent[]
  export function rngAt(seed: number, cursor: number): number
  export function promotionCursor(raceSeed: number, promotionTick: number): number
  export function validateTrack(track: Track): string[]
  export function buildTrackQuery(track: Track): TrackQuery
  export function step(ctx: SimContext, prev: SimState, next: SimState, inputs: Intent[], events: AuthEvent[]): void

  // @tapkart/content  (Plan 3 §3a, ruling R46)
  export const TUNING: Readonly<Tuning>
  export const CHARACTERS: readonly CharacterStats[]
  export const TRACK_MANIFEST: readonly { id: string }[]        // six ids, menu order
  export interface LoadedTrack { track: Track; query: TrackQuery; theme: unknown }
  export function loadTrack(id: string): LoadedTrack            // total over TRACK_MANIFEST ids, memoised
  ```

  **Two gate items are deliberately absent from that list, and both absences are load-bearing:**

  - **G1 (`PROTOCOL_VERSION` becomes `2`) is not checked for its value.** Contract §2.10 lists it as pending with source *"derived — §3.0"*, and **Task 2 of this plan is what discharges it.** A gate asserting `2` here would halt the plan on work the plan itself is about to do. The gate checks that the binding exists and is a `number`, nothing more. If Plan 2 has already shipped `2`, Task 2's change is a no-op that its test still pins.
  - **G4 (`playerIdOfInput` in `protocol/src/input.ts`) is not checked at all.** Contract §2.10 says in those words: *"Plan 4 may write this one itself: `input.ts` is not a file 15c touches, and §4.7 is the only caller."* It is the authorisation task's to write.

  Everything else in §2.10's table **is** checked, including the two that are still Plan 2's:

  - **G2** — `isDemoted(loop: AuthorityLoop): boolean`, the reader for `AuthorityLoop` standing down on an `authorityChange` it did not send (F-P4-23, GAP-3).
  - **G3** — `ShadowLoop.promotionTick(): number`, `-1` until promoted. The server needs it for `RaceRuntime` bookkeeping, one log line, and `seatMapOf`'s `isAuthority` (§5.5).

- **Produces** — what every later Plan 4 task builds on:
  - `packages/server/package.json` — the `@tapkart/server` workspace member, contract §10.1's manifest.
  - `packages/server/tsconfig.json` — `{ "extends": "../../tsconfig.base.json", "include": ["src/**/*.ts", "test/**/*.ts"] }`, **with no `lib` override**. Ruling R35 keeps DOM out of the four packages `server` imports and `server` itself has no use for it, so a `lib` line here is the one edit that would silently make a DOM type compile inside a headless process.
  - `packages/server/test/scaffold.test.ts` — the standing regression guard that the manifest matches §10.1, that no package in `server`'s import closure ever widens `lib`, that `ws` stays pinned without a range operator, and that the five constants every later task reads (`MAX_CATCHUP_TICKS`, `HOST_TIMEOUT_MS`, `ROOM_CODE_LENGTH`, `ROOM_CODE_ALPHABET`, `LOBBY_PATH_PREFIX`) still hold their contract values.

---

- [ ] **Step 1: Verify the Plan 2 + Plan 3 gate is open — and stop the plan here if it is not**

Contract §2.10 names what must exist before Plan 4's first import compiles. **At the time this task was written the gate was CLOSED in two places**, verified against the worktree: `ShadowLoop` had no `promotionTick()` (`promoted` was a private field with no reader), and `packages/content` did not exist at all because Plan 3 had not executed. Building against a surface that does not exist is how a plan discovers at task 20 that task 3 was fiction, so this is a real gate and not a formality.

The gate is deliberately **wider than the tasks that run next**. Tasks 2–5 touch `protocol` and one file in `net`; the gate also binds `ShadowLoop`, `AuthorityLoop`, `ClientLoop`, `RemoteInterpolator`, the accumulator and the whole of `@tapkart/content`, none of which is first *used* until the race-runtime task twenty-odd tasks away. A gate that covers only what the next task needs postpones exactly the discovery it exists to force, and the failure then arrives at the race-runtime task attributed to the race-runtime task.

Create `plan4-gate.check.ts` **at the repo root** with exactly this content:

```ts
// TEMPORARY. Plan 4's Task 1 gate check. Deleted at the end of this step and
// never committed. One binding per element of contract §2.1-§2.8 plus §2.10's
// G2 and G3. A binding that compiles proves the name exists AND has the stated
// shape. Where a signature below differs from the contract's prose, it is
// quoted from SHIPPED code and the prose is the stale one (contract §2.10:
// "Line numbers in §2 are evidence, not contract").
import {
  AUTHORITY_CHANGE_BYTES,
  AuthorityLoop,
  ClientLoop,
  HOST_TIMEOUT_MS,
  LOCAL_PEER_ID,
  MAX_CATCHUP_TICKS,
  REMOTE_BUFFER_CAPACITY,
  REMOTE_EXTRAPOLATE_CAP_MS,
  REMOTE_INTERP_DELAY_MS,
  RemoteInterpolator,
  SHADOW_HISTORY_TICKS,
  SNAPSHOT_PERIOD_TICKS,
  ShadowLoop,
  TICK_MS,
  advanceAccumulator,
  applyEvent,
  correctionDeltaOf,
  createDatagramGuard,
  createNullTransport,
  decodeAuthorityChange,
  droppedDatagramsOf,
  encodeAuthorityChange,
  isDemoted,
  makeLoopbackPair,
  makeTickAccumulator,
  remoteInterpolatorOf,
  withLocalInput,
} from '@tapkart/net'
import type {
  DatagramGuard,
  LocalInputTransport,
  LoopbackOptions,
  RemoteEntitySample,
  RemoteKeyframe,
  RemoteSample,
  TickAccumulator,
  Transport,
} from '@tapkart/net'
import {
  BitReader,
  BitWriter,
  EPS,
  INPUT_REDUNDANCY,
  LOBBY_PATH_PREFIX,
  PROTOCOL_VERSION,
  Q,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  WIRE_TAG,
  WORLD_HALF,
  applySnapshotToState,
  decodeCheckpoint,
  decodeEvents,
  decodeHeader,
  decodeInput,
  decodeSnapshot,
  encodeCheckpoint,
  encodeEvents,
  encodeHeader,
  encodeInput,
  encodeSnapshot,
  isValidRoomCode,
  lobbyPathFor,
  normalizeRoomCode,
  quantStep,
} from '@tapkart/protocol'
import type {
  ChannelName,
  EpsilonTable,
  InputDatagram,
  MessageKind,
  QuantField,
  QuantTable,
  WireEntity,
  WireHeader,
  WireKart,
  WireSnapshot,
} from '@tapkart/protocol'
import {
  COUNTDOWN_TICKS,
  MAX_ENTITIES,
  MAX_KARTS,
  TICK_DT,
  TICK_HZ,
  allocStateLike,
  buildTrackQuery,
  cloneState,
  createState,
  makeIntentBuffer,
  promotionCursor,
  rngAt,
  statesEqual,
  step,
  validateTrack,
} from '@tapkart/sim'
import type { AuthEvent, Intent, RacePhase, SimContext, SimState, Vec3 } from '@tapkart/sim'
import { CHARACTERS, TRACK_MANIFEST, TUNING, loadTrack } from '@tapkart/content'
import type { LoadedTrack } from '@tapkart/content'

// --- §2.1 the Transport surface. keyof, not a cast: a renamed or dropped
//     method fails the assignment, and Plan 4 writes two implementations of it.
const transportSurface: (keyof Transport)[] =
  ['send', 'broadcast', 'onMessage', 'onPeerLost', 'peers', 'close']
const unreliable: ChannelName = 'unreliable'
const reliable: ChannelName = 'reliable'

// --- §2.2 ShadowLoop, plus GATE ITEM G3 ---
const shadowCtor: new (ctx: SimContext, state: SimState, t: Transport) => ShadowLoop = ShadowLoop
const shadowTick: (nowMs: number) => void = null as unknown as ShadowLoop['tick']
const shadowPromote: (tick: number) => void = null as unknown as ShadowLoop['promote']
// G3. `-1` until promoted. Today `promoted` is a private field with no reader.
const shadowPromotionTick: () => number = null as unknown as ShadowLoop['promotionTick']
const hostTimeoutMs: number = HOST_TIMEOUT_MS
const snapshotPeriod: number = SNAPSHOT_PERIOD_TICKS
const shadowHistory: number = SHADOW_HISTORY_TICKS
const authorityChangeBytes: number = AUTHORITY_CHANGE_BYTES
const encodeAc: (out: Uint8Array, tick: number, eventSeq: number) => number = encodeAuthorityChange
const decodeAc: (buf: Uint8Array) => { tick: number; eventSeq: number } = decodeAuthorityChange

// --- §2.3 AuthorityLoop, plus GATE ITEM G2 ---
const authorityCtor: new (ctx: SimContext, state: SimState, t: Transport) => AuthorityLoop = AuthorityLoop
const authorityTick: () => void = null as unknown as AuthorityLoop['tick']
const authorityState: () => SimState = null as unknown as AuthorityLoop['state']
// G2. The reader for "stood down on a foreign authorityChange" (F-P4-23).
const demoted: (loop: AuthorityLoop) => boolean = isDemoted

// --- §2.4 ClientLoop and the interpolator ---
const clientCtor: new (ctx: SimContext, playerId: number, t: Transport) => ClientLoop = ClientLoop
const clientTick: (localIntent: Intent) => void = null as unknown as ClientLoop['tick']
const clientCorrections: () => number = null as unknown as ClientLoop['corrections']
const clientState: () => SimState = null as unknown as ClientLoop['state']
const interpolatorCtor: typeof RemoteInterpolator = RemoteInterpolator
const push: (kf: RemoteKeyframe) => void = null as unknown as RemoteInterpolator['push']
const sampleKart: (playerId: number, nowMs: number) => RemoteSample | null =
  null as unknown as RemoteInterpolator['sampleKart']
const sampleEntity: (entityId: number, nowMs: number) => RemoteEntitySample | null =
  null as unknown as RemoteInterpolator['sampleEntity']
const liveEntityIds: (out: Int32Array) => number = null as unknown as RemoteInterpolator['liveEntityIds']
const interpolatorOf: (client: ClientLoop) => RemoteInterpolator = remoteInterpolatorOf
const correction: (client: ClientLoop, outPos: Vec3) => number | null = correctionDeltaOf
const sampledKart: WireKart = null as unknown as RemoteSample['kart']
const sampledEntity: WireEntity = null as unknown as RemoteEntitySample['entity']
const keyframeEntities: WireEntity[] = null as unknown as RemoteKeyframe['entities']
const keyframeEntityCount: number = null as unknown as RemoteKeyframe['entityCount']
const tickMs: number = TICK_MS
const interpDelayMs: number = REMOTE_INTERP_DELAY_MS
const bufferCapacity: number = REMOTE_BUFFER_CAPACITY
const extrapolateCapMs: number = REMOTE_EXTRAPOLATE_CAP_MS

// --- §2.5 the receive guard, local input, loopback, apply, the accumulator ---
const guardFactory: (owner: object) => DatagramGuard = createDatagramGuard
const guardWrap: (
  handle: (peerId: string, channel: ChannelName, kind: MessageKind, payload: Uint8Array) => void,
) => (peerId: string, channel: ChannelName, data: Uint8Array) => void =
  null as unknown as DatagramGuard['wrap']
const guardDropped: () => number = null as unknown as DatagramGuard['dropped']
const droppedOf: (loop: object) => number = droppedDatagramsOf
const localPeerId: string = LOCAL_PEER_ID
const nullTransport: () => Transport = createNullTransport
const decorate: (t: Transport) => LocalInputTransport = withLocalInput
const submit: (playerId: number, intent: Intent) => void =
  null as unknown as LocalInputTransport['submitLocalInput']
const loopbackOptions: LoopbackOptions = { latencyMs: 0, jitterMs: 0, lossRate: 0, seed: 1 }
const loopback: (opts: LoopbackOptions) => { a: Transport; b: Transport; pump(nowMs: number): void } =
  makeLoopbackPair
const apply: (ctx: SimContext, state: SimState, ev: AuthEvent) => boolean = applyEvent
// The object literal is the check that matters: an excess-property error here
// means the type still carries `lastNowMs`, and every loop in this plan is
// written against the one-field version.
const accumulator: TickAccumulator = { residualMs: 0 }
const makeAcc: () => TickAccumulator = makeTickAccumulator
const advance: (acc: TickAccumulator, elapsedMs: number) => number = advanceAccumulator
const maxCatchup: number = MAX_CATCHUP_TICKS

// --- §2.6 protocol. PROTOCOL_VERSION is bound for PRESENCE only: G1 is Task 2's
//     to discharge, and a gate asserting 2 would halt on this plan's own work.
const protocolVersion: number = PROTOCOL_VERSION
const helloTag: number = WIRE_TAG.hello
const clientUpdateTag: number = WIRE_TAG.clientUpdate
const resyncRequestTag: number = WIRE_TAG.resyncRequest
const pongTag: number = WIRE_TAG.pong
const encodeHdr: (out: Uint8Array, kind: MessageKind) => number = encodeHeader
const decodeHdr: (buf: Uint8Array) => WireHeader = decodeHeader
const helloKind: MessageKind = 'hello'
const snapshotPhase: RacePhase = null as unknown as WireSnapshot['phase']
const inputDatagram: InputDatagram = null as unknown as InputDatagram
const writerCtor: new (buf: Uint8Array) => BitWriter = BitWriter
const readerCtor: new (buf: Uint8Array) => BitReader = BitReader
const writeBits: (value: number, bits: number) => void = null as unknown as BitWriter['writeBits']
const writeFloatQ: (value: number, min: number, max: number, bits: number) => void =
  null as unknown as BitWriter['writeFloatQ']
const byteLength: () => number = null as unknown as BitWriter['byteLength']
const readBits: (bits: number) => number = null as unknown as BitReader['readBits']
const readFloatQ: (min: number, max: number, bits: number) => number =
  null as unknown as BitReader['readFloatQ']
const worldHalf: number = WORLD_HALF
const qStep: (min: number, max: number, bits: number) => number = quantStep
const quantTable: QuantTable = Q
const epsTable: EpsilonTable = EPS
const positionField: QuantField = Q.position
const encSnap: (out: Uint8Array, state: SimState, lastProcessedInputTick: number[]) => number = encodeSnapshot
const decSnap: (buf: Uint8Array, out: WireSnapshot) => void = decodeSnapshot
const applySnap: (snap: WireSnapshot, dst: SimState) => void = applySnapshotToState
const encCp: (out: Uint8Array, state: SimState) => number = encodeCheckpoint
const decCp: (buf: Uint8Array, dst: SimState) => void = decodeCheckpoint
const encEv: (out: Uint8Array, events: AuthEvent[]) => number = encodeEvents
const decEv: (buf: Uint8Array, out: AuthEvent[]) => void = decodeEvents
const redundancy: number = INPUT_REDUNDANCY
const encIn: (out: Uint8Array, playerId: number, intents: Intent[]) => number = encodeInput
const decIn: (buf: Uint8Array, out: InputDatagram) => void = decodeInput
// The room-code family (C-1, C-7, F-P4-34). Task 4 EXTENDS this file; it changes
// not one character of these six.
const roomAlphabet: string = ROOM_CODE_ALPHABET
const roomLength: number = ROOM_CODE_LENGTH
const lobbyPrefix: string = LOBBY_PATH_PREFIX
const normalize: (input: string) => string = normalizeRoomCode
const isValid: (code: string) => boolean = isValidRoomCode
const lobbyPath: (code: string) => string = lobbyPathFor

// --- §2.7 sim ---
const tickHz: number = TICK_HZ
const tickDt: number = TICK_DT
const maxKarts: number = MAX_KARTS
const maxEntities: number = MAX_ENTITIES
const countdownTicks: number = COUNTDOWN_TICKS
const create: (ctx: SimContext, seed: number, characterIdx: number[]) => SimState = createState
const clone: (src: SimState, dst: SimState) => void = cloneState
const equal: (a: SimState, b: SimState) => boolean = statesEqual
const allocLike: (ctx: SimContext, src: SimState) => SimState = allocStateLike
const intentBuffer: () => Intent[] = makeIntentBuffer
const rng: (seed: number, cursor: number) => number = rngAt
const promoCursor: (raceSeed: number, promotionTick: number) => number = promotionCursor
const validate: (track: SimContext['track']) => string[] = validateTrack
const buildQuery: (track: SimContext['track']) => SimContext['query'] = buildTrackQuery
const stepFn: (
  ctx: SimContext,
  prev: SimState,
  next: SimState,
  inputs: Intent[],
  events: AuthEvent[],
) => void = step
const isLeader: boolean = null as unknown as SimContext['isLeader']

// --- §2.8 content. THE REASON THIS PLAN CAN EXIST: the shadow authority runs
//     step() in lockstep with the host, so it needs the IDENTICAL tuning,
//     characters and tracks, out of a package that carries no DOM and no three.
const tuning: SimContext['tuning'] = TUNING
const characters: readonly SimContext['characters'][number][] = CHARACTERS
const manifestId: string = TRACK_MANIFEST[0].id
const load: (id: string) => LoadedTrack = loadTrack
const loadedTrack: SimContext['track'] = null as unknown as LoadedTrack['track']
const loadedQuery: SimContext['query'] = null as unknown as LoadedTrack['query']

void transportSurface; void unreliable; void reliable
void shadowCtor; void shadowTick; void shadowPromote; void shadowPromotionTick
void hostTimeoutMs; void snapshotPeriod; void shadowHistory; void authorityChangeBytes
void encodeAc; void decodeAc
void authorityCtor; void authorityTick; void authorityState; void demoted
void clientCtor; void clientTick; void clientCorrections; void clientState
void interpolatorCtor; void push; void sampleKart; void sampleEntity; void liveEntityIds
void interpolatorOf; void correction; void sampledKart; void sampledEntity
void keyframeEntities; void keyframeEntityCount
void tickMs; void interpDelayMs; void bufferCapacity; void extrapolateCapMs
void guardFactory; void guardWrap; void guardDropped; void droppedOf
void localPeerId; void nullTransport; void decorate; void submit
void loopbackOptions; void loopback; void apply
void accumulator; void makeAcc; void advance; void maxCatchup
void protocolVersion; void helloTag; void clientUpdateTag; void resyncRequestTag; void pongTag
void encodeHdr; void decodeHdr; void helloKind; void snapshotPhase; void inputDatagram
void writerCtor; void readerCtor; void writeBits; void writeFloatQ; void byteLength
void readBits; void readFloatQ; void worldHalf; void qStep
void quantTable; void epsTable; void positionField
void encSnap; void decSnap; void applySnap; void encCp; void decCp; void encEv; void decEv
void redundancy; void encIn; void decIn
void roomAlphabet; void roomLength; void lobbyPrefix; void normalize; void isValid; void lobbyPath
void tickHz; void tickDt; void maxKarts; void maxEntities; void countdownTicks
void create; void clone; void equal; void allocLike; void intentBuffer
void rng; void promoCursor; void validate; void buildQuery; void stepFn; void isLeader
void tuning; void characters; void manifestId; void load; void loadedTrack; void loadedQuery
```

Run, from the repo root:

`npx tsc --noEmit --strict --target ES2022 --module ESNext --moduleResolution Bundler --verbatimModuleSyntax --skipLibCheck plan4-gate.check.ts && echo GATE_OPEN`

Expected when the gate is open: **no output from `tsc`, then the single line `GATE_OPEN`** (exit code 0).

A closed gate reports itself precisely, and each shape means one thing:

- `error TS2307: Cannot find module '@tapkart/net' or its corresponding type declarations.` (or `'@tapkart/protocol'`) — Plan 2 is not merged into this working tree at all.
- `error TS2307: Cannot find module '@tapkart/content' or its corresponding type declarations.` — **Plan 3 has not executed.** `@tapkart/content` is the fifth dependency and the reason this plan can exist: the shadow authority must run `step()` in lockstep with the host, which needs the identical `Tuning`, `CharacterStats[]` and six tracks out of a package that carries no DOM and no `three` (contract §1, ruling R46). **Do not** write a second tuning table in `server`, and **do not** add a `server → game` edge: spec §3 forbids it and `game` pulls `three`, which is a server that fails to start on a headless box.
- `error TS2339: Property 'promotionTick' does not exist on type 'ShadowLoop'.` — **gate item G3.** Plan 2 has not added the read-only accessor. It is a reader with no policy in it; `promoted` is a private field today. **Do not** add it from a Plan 4 task: contract §2.10 says in those words that *no Plan 4 task may write into `shadow.ts`, `authority.ts` or `clock.ts`*.
- `error TS2305: Module '"@tapkart/net"' has no exported member 'isDemoted'.` — **gate item G2.** `AuthorityLoop` still has no demotion path (F-P4-23, GAP-3), so a promoted shadow and the original host would both broadcast snapshots into the same room. Plan 2 Task 15c owns it.
- `error TS2305: Module '"@tapkart/net"' has no exported member 'advanceAccumulator'.` (or `'TickAccumulator'`, `'MAX_CATCHUP_TICKS'`, `'TICK_MS'`) — F-P4-7 has not landed. The accumulator is still in `game/src/clock.ts` or nowhere. `server` may not import `game`; both import `net`.
- `error TS2353: Object literal may only specify known properties, and 'lastNowMs' does not exist in type 'TickAccumulator'` — you are running an older draft of this file. The shipped accumulator has **one** field and `advanceAccumulator` takes a **delta**.
- `error TS2551: Property 'tick' does not exist on type 'ShadowLoop'. Did you mean 'poll'?` — someone added the `poll(elapsedMs)` an early draft of the contract asked for. §2.10 settles this: the host-loss detector stays inside `tick(nowMs)` and counts wall milliseconds.
- `error TS2339: Property 'phase' does not exist on type 'WireSnapshot'.` — Task 15c item A has not landed; a guest can never be told the race has not started.
- `error TS2305: Module '"@tapkart/protocol"' has no exported member 'ROOM_CODE_ALPHABET'.` (or any of the other five) — Task 15c item E has not landed. **Do not** write a second room-code module: the alphabet's *order is the 5-bit wire index*, so a second copy is a second wire format, and this constant has already had three homes with three different values (§15.12).
- `error TS2322: Type 'string' is not assignable to type '"send" | ...'` from the `keyof Transport` array — the transport surface was renamed, and Plan 4 writes two implementations of it.
- Any other `error TS2322: Type '...' is not assignable to type '...'` — it shipped with a **different signature** than the block above states, which is the most dangerous shape because it compiles at the call site and misbehaves at runtime.

**If any of those appear, stop. Do not continue to Step 2, do not write a shim, and above all do not write into `packages/net`, `packages/protocol` or `packages/content` to make the gate pass — that inverts the dependency direction spec §3 fixes and, for `shadow.ts`/`authority.ts`/`clock.ts`, is forbidden outright by §2.10.** Report the exact `tsc` output and wait.

Delete the temporary file whether the gate passed or failed — it must never reach a commit:

`rm plan4-gate.check.ts`

Verify with `git status --porcelain`, which must not list `plan4-gate.check.ts`.

- [ ] **Step 2: Write the failing test**

Create `packages/server/test/scaffold.test.ts`:

```ts
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { CHARACTERS, TRACK_MANIFEST, TUNING, loadTrack } from '@tapkart/content'
import { HOST_TIMEOUT_MS, MAX_CATCHUP_TICKS, ShadowLoop, createNullTransport } from '@tapkart/net'
import {
  LOBBY_PATH_PREFIX,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  lobbyPathFor,
} from '@tapkart/protocol'
import { MAX_KARTS, createState } from '@tapkart/sim'
import type { SimContext } from '@tapkart/sim'

/**
 * The scaffold guard, and the runtime half of the Plan 2 + Plan 3 gate.
 *
 * Step 1's `tsc` check proves every name Plan 4 imports EXISTS and has the
 * stated SHAPE. It cannot prove that the four packages compose in one process,
 * and composition is where this project has repeatedly found its gaps. So this
 * file constructs a real `SimContext` out of `@tapkart/content`, hands it to
 * `@tapkart/sim`'s `createState` and then to `@tapkart/net`'s `ShadowLoop` -
 * the exact three-package path the server's per-room shadow authority takes -
 * and asserts the one accessor the server needs off the far end of it.
 */

const HERE = dirname(fileURLToPath(import.meta.url)) // packages/server/test
const PKG_ROOT = join(HERE, '..') // packages/server
const REPO_ROOT = join(PKG_ROOT, '..', '..')

const readJson = (p: string): Record<string, unknown> =>
  JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>

describe('packages/server scaffold', () => {
  it('is contract §10.1\'s manifest, exactly', () => {
    const pkg = readJson(join(PKG_ROOT, 'package.json'))
    expect(pkg.name).toBe('@tapkart/server')
    expect(pkg.version).toBe('0.1.0')
    expect(pkg.private).toBe(true)
    expect(pkg.type).toBe('module')
    // Two entries, and the second is deliberate: it keeps main.ts reachable to
    // the build script while keeping it out of the headless barrel (§0).
    expect(pkg.exports).toEqual({ '.': './src/index.ts', './main': './src/main.ts' })
  })

  it('declares exactly the five dependencies spec §3 allows, and never game or render', () => {
    const pkg = readJson(join(PKG_ROOT, 'package.json'))
    const deps = pkg.dependencies as Record<string, string>
    // Equality, not "contains". `server` importing `game` or `render` is a
    // server that pulls `three` and fails to start on a headless box, and it is
    // the arrow spec §3 fixes.
    expect(Object.keys(deps).sort()).toEqual(
      ['@tapkart/content', '@tapkart/net', '@tapkart/protocol', '@tapkart/sim', 'ws'].sort(),
    )
    expect(deps['@tapkart/game']).toBeUndefined()
    expect(deps['@tapkart/render']).toBeUndefined()
    expect(deps.three).toBeUndefined()
  })

  it('pins ws exactly, with no range operator anywhere in it', () => {
    // "<pinned exactly, no caret>" (§10.1). A caret on the one third-party
    // runtime dependency in the image means the deployed bytes are whatever the
    // registry served that morning, which is not a deploy anybody can reproduce.
    const pkg = readJson(join(PKG_ROOT, 'package.json'))
    const deps = pkg.dependencies as Record<string, string>
    const dev = pkg.devDependencies as Record<string, string>
    expect(deps.ws, 'ws is not pinned to an exact version').toMatch(/^\d+\.\d+\.\d+$/)
    expect(dev['@types/ws'], '@types/ws is not pinned to an exact version').toMatch(/^\d+\.\d+\.\d+$/)
    // @types/ws is a devDependency and therefore never ships (§10.1).
    expect(deps['@types/ws']).toBeUndefined()
  })

  it('has a DOM-free tsconfig, and so does every package server imports', () => {
    const own = readJson(join(PKG_ROOT, 'tsconfig.json'))
    expect(own.extends).toBe('../../tsconfig.base.json')
    expect(own.include).toEqual(['src/**/*.ts', 'test/**/*.ts'])
    // No `compilerOptions` at all: R35 keeps DOM out of the four packages
    // `server` imports, and `server` itself has no use for it. A `lib` override
    // here is the one edit that would silently make a DOM type compile inside a
    // headless process.
    expect(own.compilerOptions).toBeUndefined()

    const base = readJson(join(REPO_ROOT, 'tsconfig.base.json'))
    const baseOpts = base.compilerOptions as Record<string, unknown>
    expect(baseOpts.lib).toEqual(['ES2022'])

    for (const p of ['sim', 'protocol', 'net', 'content', 'server']) {
      const cfg = readJson(join(REPO_ROOT, 'packages', p, 'tsconfig.json'))
      const opts = (cfg.compilerOptions ?? {}) as Record<string, unknown>
      expect(opts.lib, `packages/${p} widened lib; server's import closure must stay DOM-free`)
        .toBeUndefined()
    }
  })
})

describe('the Plan 2 + Plan 3 gate, at runtime', () => {
  const makeContext = (): SimContext => {
    const loaded = loadTrack(TRACK_MANIFEST[0].id)
    return {
      track: loaded.track,
      query: loaded.query,
      tuning: TUNING,
      characters: [...CHARACTERS],
      isLeader: false,
    }
  }

  it('composes content + sim + net into a ShadowLoop in one process', () => {
    const ctx = makeContext()
    const state = createState(ctx, 1, new Array<number>(MAX_KARTS).fill(0))
    const shadow = new ShadowLoop(ctx, state, createNullTransport())
    // G3, at runtime: -1 until promoted. `RaceRuntime` bookkeeping, one log line
    // and `seatMapOf`'s `isAuthority` all read it.
    expect(shadow.promotionTick()).toBe(-1)
    // §7.1: ShadowLoop does NOT copy its ctx, so constructing one must not have
    // flipped the caller's isLeader. A memoised contextFor would make one room's
    // promotion turn every room into a leader.
    expect(ctx.isLeader).toBe(false)
  })

  it('carries the six tracks and a non-empty character table', () => {
    expect(TRACK_MANIFEST).toHaveLength(6)
    expect(CHARACTERS.length).toBeGreaterThan(0)
    expect(new Set(TRACK_MANIFEST.map((t) => t.id)).size).toBe(6)
  })

  it('holds the four constants every later task reads, at their contract values', () => {
    // 5, not 8: two copies of a catch-up constant drift, and spec §11 names
    // catch-up as a top risk (F-P4-7).
    expect(MAX_CATCHUP_TICKS).toBe(5)
    // Milliseconds, not the 90 ticks it was before Task 15c item C (F-P4-22).
    expect(HOST_TIMEOUT_MS).toBe(1500)
    // FIVE characters (F-P4-34), and Crockford's alphabet - which KEEPS 0 and 1
    // and drops I, L, O and U. Three drafts proposed three alphabets; only this
    // one is on the wire, and its ORDER is the 5-bit index.
    expect(ROOM_CODE_LENGTH).toBe(5)
    expect(ROOM_CODE_ALPHABET).toBe('0123456789ABCDEFGHJKMNPQRSTVWXYZ')
    expect(ROOM_CODE_ALPHABET).toHaveLength(32)
  })

  it('freezes LOBBY_PATH_PREFIX, which the APK compiles into its intent filter', () => {
    // C-1. This string is the APK's `autoVerify` pathPrefix, matched
    // case-sensitively and prefix-exactly, and it is FROZEN AT THE FIRST SIGNED
    // RELEASE. A mismatch between the server's routing and the APK is a SILENT
    // App Links failure: the tap opens a browser instead of the app, with no
    // error anywhere. One constant, read by everything.
    expect(LOBBY_PATH_PREFIX).toBe('/r/')
    expect(lobbyPathFor('0ABCD')).toBe('/r/0ABCD')
    // Built from the constant, so the two can never disagree.
    expect(lobbyPathFor('0ABCD').startsWith(LOBBY_PATH_PREFIX)).toBe(true)
    // No host anywhere: the server answers with PATHS and the client builds the
    // absolute URL from its own origin (C-3, contract §0).
    expect(LOBBY_PATH_PREFIX).not.toMatch(/:\/\//)
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run packages/server/test/scaffold.test.ts`

Expected: **FAIL**, with the file failing to collect at all:

```
Error: ENOENT: no such file or directory, open '<repo>/packages/server/package.json'
```

thrown from the first `readJson` call. `describe` bodies run at collect time and the `it` callbacks do not, so vitest reports the four `packages/server scaffold` tests and the four gate tests as failed against that one error rather than reporting eight separate messages.

If instead the run fails at import with `Failed to resolve import "@tapkart/content"`, the gate was never open and Step 1 was skipped. Go back to Step 1 and halt there.

- [ ] **Step 4: Write the implementation**

Create `packages/server/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

Create `packages/server/package.json`. **Write it without the `ws` and `@types/ws` lines** — the next command adds them with a registry-resolved exact version, and a hand-typed version number is a guess:

```json
{
  "name": "@tapkart/server",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./main": "./src/main.ts"
  },
  "dependencies": {
    "@tapkart/sim": "*",
    "@tapkart/protocol": "*",
    "@tapkart/net": "*",
    "@tapkart/content": "*"
  },
  "scripts": {
    "typecheck": "tsc --noEmit -p tsconfig.json"
  }
}
```

Then, from the repo root, link the workspace and pin `ws`:

```bash
npm install
npm install --save-exact --workspace @tapkart/server ws
npm install --save-exact --save-dev --workspace @tapkart/server @types/ws
```

`--save-exact` is what writes `"ws": "8.18.3"` rather than `"ws": "^8.18.3"`, satisfying §10.1's *"pinned exactly, no caret"*. **The version number itself is whatever the registry resolves — do not type one in.** The test asserts the *shape* of the pin (`/^\d+\.\d+\.\d+$/`), never a specific version, because a test that pinned a number would have to be edited on every upgrade and would then stop meaning anything.

Why `ws` at all: Node has no built-in WebSocket **server** — Node 20's global `WebSocket` is a client — and hand-rolling RFC 6455 framing to keep the dependency count at zero would be the least defensible line of code in the project (§10.1, P4 Q4). Why `@types/ws` rather than a hand-written ambient declaration: a local re-declaration of a third-party surface is a silent drift source, and as a `devDependency` it never ships.

The remaining `scripts` from §10.1 — `build`, `start`, `bench` — are **not** added here. Each names a file this task does not create (`scripts/build-server.mjs`, `dist/main.mjs`, `bench/rooms.ts`); the esbuild-bundle task and the benchmark task add their own script line beside the file it runs. `typecheck` is added now because `npm run typecheck --workspaces --if-present` at the root must cover this package from its first commit.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run packages/server/test/scaffold.test.ts`

Expected: **8 passed**, in two describe blocks.

Then confirm the package typechecks and nothing else regressed:

```bash
npm run typecheck -w @tapkart/server
npx vitest run
```

`typecheck` must print no errors. The full run must show no new failures against the pre-task baseline — this task adds a package and changes no shipped file, so every previously passing test still passes.

- [ ] **Step 6: Commit**

```bash
git add packages/server/package.json packages/server/tsconfig.json packages/server/test/scaffold.test.ts package-lock.json && git commit -m "feat(server): scaffold packages/server and pin the Plan 2 + Plan 3 gate"
```

Confirm `plan4-gate.check.ts` is not in the commit:

```bash
git show --stat --name-only HEAD
```

The file list must be exactly the four paths above.
