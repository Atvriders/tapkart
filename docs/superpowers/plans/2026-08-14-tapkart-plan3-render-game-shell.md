# Tapkart Plan 3 — Render, Content and Game Shell — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the completed simulation and netcode into a game a human can open in a browser and play — track and kart rendering, touch controls, HUD, screen flow, and the shipped content the whole project runs on.

**Architecture:** Three new packages plus a thin app. `packages/content` holds the shipped data (tuning, characters, karts, themes, tracks) and is the only package `render`, `game` **and** `server` all depend on. `packages/render` is pure: it turns a `RaceView` into a `RenderFrame` — a data description of a frame — and a thin adapter draws that frame with Three.js. `packages/game` owns the wall clock, the controls, the screen state machine and the composition root for a race. `apps/web` is a Vite shell that calls `startShell` and nothing else.

**Tech Stack:** TypeScript 5.9 strict, Node 20, vitest 3 (`environment: 'node'`, `globals: false`), Three.js 0.180.0 (the repository's second runtime dependency), Vite.

**Spec:** `docs/superpowers/specs/2026-08-13-tapkart-design.md`

**Contract:** `docs/superpowers/plans/2026-08-14-tapkart-plan3-contract.md` — **3,397 lines, 168 exported symbols, locked.** Every signature, constant, units convention and sole-writer rule is pinned there. Where this plan and the contract disagree, the contract wins; where the contract and the spec disagree, the spec wins.

**Rulings:** `docs/superpowers/plans/2026-08-14-tapkart-plan3-rulings.md` — the 34 open questions the contract draft raised, ruled. Read a ruling when a task's reasoning is unclear; each says *why*, which the contract mostly does not.

---

## Global Constraints

Every task's requirements implicitly include this section.

- **TypeScript 5.9 strict**, plus `noUnusedLocals`, `noUnusedParameters`, `noImplicitOverride`, `noImplicitReturns`, `noFallthroughCasesInSwitch`, `verbatimModuleSyntax` (so type-only imports use `import type`), `isolatedModules`.
- **Extensionless imports.** Bare specifiers across packages — never a relative path into another package. Test fixtures are the one exception, and only test-to-test (contract §2.6).
- **vitest 3**, `environment: 'node'` everywhere, `globals: false` (so `describe`/`it`/`expect` are imported). **No jsdom, and no per-file `@vitest-environment` override** — if a task believes it needs one, the seam is in the wrong place and the boundary moves instead (ruling Q30).
- **DOM lib is widened per package, never in `tsconfig.base.json`** (R35). `render`, `game` and `apps/web` get `"lib": ["ES2022", "DOM", "DOM.Iterable"]`. `content`, `sim`, `protocol` and `net` stay DOM-free — `server` imports them under plain Node.
- **The tick is 60 Hz and nothing invents a different one.** `TICK_DT` and `TICK_HZ` come from `@tapkart/sim`; `TICK_MS` comes from `@tapkart/net` and is imported by `packages/game/src/clock.ts` and nowhere else (contract §6.1).
- **`game/src/clock.ts` holds the only wall clock in the repository.** No other module in `content`, `render` or `game` reads a clock, directly or indirectly.
- **Track parameter `s` is arc-normalised `[0, 1)`, never metres.** This is the project's most error-prone convention.
- **The seat-source rule** (contract §7.1): a renderer reads the **local** seat from `ClientLoop.state()` and **every other seat** from the `RemoteInterpolator`, and never both. `viewSourceViolations` makes this mechanically checkable and runs under `import.meta.env.DEV` as well as in tests.
- **Scratch-object discipline:** no allocation in per-frame or per-tick paths. Caller-owned buffers, allocated once at construction.
- **Never commit a real LAN IP, hostname, or host filesystem path.** Placeholders and RFC 5737 ranges only. This repository is public.

## The Plan 2 gate

Contract §2.5 lists what `@tapkart/net` must export before this plan's first import compiles: `withLocalInput`, `createNullTransport`, `LocalInputTransport`, `LOCAL_PEER_ID`, `correctionDeltaOf`, `TICK_MS`, `RemoteSample.kart`, `RemoteKeyframe.entities`, `sampleEntity`, `liveEntityIds`, `makeRemoteSample`, `makeRemoteEntitySample`, and `WireSnapshot.phase`. These are Plan 2 Tasks 15b and 15c. **Task 1 verifies the gate is open and stops if it is not** — building against a surface that does not exist yet is how a plan discovers at task 20 that task 3 was fiction.

*Amended 2026-08-14 (ruling P2-R29): `RemoteInterpolator.sampleKart` and `sampleEntity` take a **caller-owned `out` buffer and return a boolean**; the two `make…Sample` factories above are how a caller allocates one, once, at construction. The allocating form returned two objects per call on a per-frame API — ~4,700 objects/s across seven remote karts and up to 32 entities — and `liveEntityIds` on the same class already took a caller-owned buffer for exactly that reason. Every task below that samples a remote kart or entity is written against the new form, and the gate checks the arity.*

## What this plan does not build

Audio output (the seam is authored, the backend is a no-op — Plan 5 fills it), the PWA manifest, the service worker, the Dockerfile, CI publish, the server, the lobby handshake, WebRTC, and the Android app. Contract §12 is the full list.

---

## Task numbering

These tasks were authored in parallel and are assembled here in **execution order**, which is not the order they were written in. Every cross-reference below has been rewritten to the numbers in the right-hand column; the left-hand column exists so a review comment written against a draft can still be located.

| Authored as | Runs as | Subject |
|---|---|---|
| Task 1 | **Task 1** | Repo plumbing, the Plan 2 gate, and the `packages/content` scaffold |
| Task 2 | **Task 2** | `packages/content/src/tuning.ts` — the shipped `TUNING` and `CHARACTERS` |
| Task 3 | **Task 3** | `packages/content/src/descriptors.ts` — the character and kart schema and parsers |
| Task 4 | **Task 4** | `packages/content/src/theme.ts` — track themes and edge-marker parameters |
| Task 6 | **Task 5** | The DeepSeek content delegation — 8 character descriptors, 8 kart descriptors, 6 track themes |
| Task 5 | **Task 6** | `packages/content/src/tracks.ts`, `bundle.ts` and the barrel |
| Task 7 | **Task 7** | `packages/render` scaffold and `src/types.ts` — the view structs |
| Task 8 | **Task 8** | `src/mesh.ts` — track geometry, pure |
| Task 9 | **Task 9** | `src/descriptors.ts` — descriptor meshes, pure |
| Task 10 | **Task 10** | `src/camera.ts` — pure, tick-driven, no wall clock |
| Task 11 | **Task 11** | `packages/render/src/frame.ts` — frame vocabulary, constants, and the two sim-mirroring helpers |
| Task 11b | **Task 12** | `buildRenderFrame` — the derived-field table |
| Task 12 | **Task 13** | `packages/render/src/hud.ts` — the pure HUD model |
| Task 13 | **Task 14** | `packages/render/src/audio.ts` — the pure audio model and the authored backend seam |
| Task 14 | **Task 15** | `packages/render/src/smoothing.ts` — error smoothing (R41) |
| Task 15 | **Task 16** | `src/backend.ts`, `src/three/renderer.ts` and the `render` barrel — the seam and the adapter |
| Task 16 | **Task 17** | `packages/game` workspace scaffold and `src/clock.ts` |
| Task 17 | **Task 18** | `packages/game/src/controls/` — three touch schemes, keyboard, and the composite |
| Task 18 | **Task 19** | The DOM input adapter and settings persistence |
| Task 19 | **Task 20** | `packages/game/src/app.ts` — the screen state machine, pure |
| Task 19a | **Task 21** | `packages/game/src/results.ts` — result rows and DNF |
| Task 20 | **Task 22** | `packages/game/src/session.ts` and `src/localinput.ts` — the composition root for one race |
| Task 21 | **Task 23** | `packages/game/src/view.ts` — the one place prediction and interpolation are chosen between |
| Task 22 | **Task 24** | `src/shell.ts` and the `game` barrel |
| Task 23 | **Task 25** | `apps/web` — the shell a human can open — and the golden `RenderFrame` fixture |

Three of those moves are load-bearing rather than cosmetic, and each is stated in the tasks themselves: the content group runs **3 → 4 → 6 → 5** because the bundle statically imports the 22 JSON records the delegation task generates; `11b` runs **after** `11` although it sorts before it by filename, because it appends to a file `11` creates; and the results module is split out of the shell task and placed **immediately after** the app task, because `app.ts` and `results.ts` import each other type-only and placing it earlier inverts the error instead of clearing it.

---

### Task 1: Repo plumbing, the Plan 2 gate, and the `packages/content` scaffold

**Files:**
- Verify (temporary, created and deleted inside Step 1, never committed): `plan2-gate.check.ts` (repo root)
- Modify: `package.json:6-8` — the `workspaces` array. **This task is the sole writer of both root files**; the `apps/web` task verifies them and does not re-edit them.
- Modify: `vitest.config.ts:5` — the `include` array
- Modify: `package-lock.json` — `npm install` side effect (Step 4), declared because five tasks in this plan rewrite it and an undeclared root file in a diff reads as an accident
- Create: `packages/content/package.json`
- Create: `packages/content/tsconfig.json`
- Test: `packages/content/test/scaffold.test.ts`

**Interfaces:**

- **Consumes** — the current contents of the three files this task touches, read out of the repo and quoted here so nothing is edited from memory:

  `package.json` (repo root), lines 6-8 today:

  ```jsonc
  "workspaces": [
    "packages/*"
  ],
  ```

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

  `tsconfig.base.json` (repo root) — `"lib": ["ES2022"]`, `"target": "ES2022"`, `"module": "ESNext"`, `"moduleResolution": "Bundler"`, `strict`, `verbatimModuleSyntax`, `isolatedModules`, `noUnusedLocals`, `noUnusedParameters`, `noImplicitOverride`, `noImplicitReturns`, `noFallthroughCasesInSwitch`, `noUncheckedIndexedAccess: false`, `noEmit`. **It has no `lib` entry beyond `ES2022`, no `DOM`, and no `resolveJsonModule`, and this task does not add any** (R35).

  `packages/sim/package.json` — `{ "name": "@tapkart/sim", "version": "0.1.0", "private": true, "type": "module", "exports": { ".": "./src/index.ts" }, "scripts": { "typecheck": "tsc --noEmit -p tsconfig.json" } }`. The manifest below mirrors this shape with the name changed and one dependency added.

  `packages/sim/tsconfig.json` — `{ "extends": "../../tsconfig.base.json", "include": ["src/**/*.ts", "test/**/*.ts"] }`.

  From `@tapkart/net` and `@tapkart/protocol`, contract §2.5's gate — **Plan 2 Tasks 15b and 15c** — and verified by Step 1 before anything else in this plan is written. This is the **whole** surface this plan reaches for: contract §2.5's **35 elements (25 named exports and 10 members/fields)**, plus amendment 4's four accumulator symbols and the six room-code symbols that retire `game/src/roomcode.ts` — **45 in all**. The gate checks every one of them, because a gate that covers two thirds of its surface lets the plan discover at the session task that this task was incomplete.

  *Amended 2026-08-14 (ruling P2-R29): 33/23/43 became 35/25/45. `makeRemoteSample` and `makeRemoteEntitySample` are two new named exports of `@tapkart/net`, and they are gate items rather than conveniences: `RemoteSample.kart` is non-optional, so without the factories a caller has no legal way to build the buffer the re-signed `sampleKart` now demands, and the failure would land in the view task rather than here.*

  **Where the contract and shipped code disagree, shipped code wins, and it is quoted here rather than the contract.** Four places, all verified against the worktree: the accumulator's field list, its second argument, `MAX_CATCHUP_TICKS`, and the local-input method's name and arity. Each is a real compile error for a task written against §5.1 or §2.5 instead:

  ```ts
  // packages/net/src/clock.ts
  export const TICK_MS: number

  // packages/net/src/client.ts
  export const REMOTE_INTERP_DELAY_MS = 100
  export const REMOTE_BUFFER_CAPACITY = 8
  export const REMOTE_EXTRAPOLATE_CAP_MS = 200

  export type ChannelName = 'reliable' | 'unreliable'
  export interface Transport {
    send(channel: ChannelName, peerId: string, data: Uint8Array): void
    broadcast(channel: ChannelName, data: Uint8Array): void
    onMessage(cb: (peerId: string, channel: ChannelName, data: Uint8Array) => void): void
    onPeerLost(cb: (peerId: string) => void): void
    peers(): string[]
    close(): void
  }
  export interface LoopbackOptions { latencyMs: number; jitterMs: number; lossRate: number; seed: number }
  export function makeLoopbackPair(opts: LoopbackOptions):
    { a: Transport; b: Transport; pump(nowMs: number): void }

  export class AuthorityLoop {
    constructor(ctx: SimContext, state: SimState, t: Transport)
    tick(): void
    state(): SimState
  }
  export class ClientLoop {
    constructor(ctx: SimContext, playerId: number, t: Transport)
    tick(localIntent: Intent): void
    corrections(): number
    state(): SimState
  }

  export interface RemoteKeyframe {
    recvAtMs: number          // ALWAYS tick * TICK_MS, never a wall clock
    karts: WireKart[]         // length MAX_KARTS, deep-copied out of the decode scratch
    entities: WireEntity[]    // length MAX_ENTITIES, deep-copied; live packed at front  (Q4)
    entityCount: number       // (Q4)
  }

  // AMENDMENT (ruling P2-R29): these two are CALLER-OWNED BUFFERS, filled in
  // place. Quoted from shipped `packages/net/src/client.ts`, which supersedes
  // contract §2.5's original nullable-return form — see the note under this
  // block.
  export interface RemoteSample {
    position: { x: number; y: number; z: number }
    heading: number
    kart: WireKart
  }

  export interface RemoteEntitySample {
    position: { x: number; y: number; z: number }
    heading: number
    entity: WireEntity
  }

  /** The only legal way to make one: `kart` / `entity` are non-optional, and a
   *  caller has nothing neutral to put in them. Called ONCE, at construction. */
  export function makeRemoteSample(): RemoteSample
  export function makeRemoteEntitySample(): RemoteEntitySample

  export class RemoteInterpolator {
    push(kf: RemoteKeyframe): void
    /** true and `out` filled; false and `out` UNTOUCHED when there is nothing to
     *  sample (no keyframe yet). */
    sampleKart(playerId: number, nowMs: number, out: RemoteSample): boolean
    /** Keyed on entityId, never on packed index. false, `out` untouched, once
     *  the entity is absent from the newest keyframe. */
    sampleEntity(entityId: number, nowMs: number, out: RemoteEntitySample): boolean
    liveEntityIds(out: Int32Array): number
  }

  export function remoteInterpolatorOf(client: ClientLoop): RemoteInterpolator
  export function correctionDeltaOf(client: ClientLoop, outPos: Vec3): number | null

  // packages/net/src/clock.ts — AMENDMENT 4, and quoted from SHIPPED code, not
  // from contract §5.1, which is wrong in three places. The accumulator moved out
  // of `packages/game/src/clock.ts` because `packages/server` runs the same
  // fixed-step pump and `net` may not import `game`; the TYPE moved with the
  // function, because leaving it behind would make `net` import it from `game`,
  // inverting the one arrow §1 and §12 forbid outright.
  //
  // Three corrections against §5.1, all of which are compile or assertion
  // failures for a task written against the contract instead:
  //   * `TickAccumulator` has ONE field. There is no `lastNowMs` — the caller
  //     owns the previous timestamp and the accumulator does no clock arithmetic.
  //   * the second argument is `elapsedMs`, a DELTA, not an absolute `nowMs`.
  //   * `MAX_CATCHUP_TICKS` is 5, not 8. It is load-bearing (spec §11's death
  //     spiral), so a task asserting 8 fails against shipped code.
  export interface TickAccumulator { residualMs: number }
  export function makeTickAccumulator(): TickAccumulator
  export function advanceAccumulator(acc: TickAccumulator, elapsedMs: number): number
  export const MAX_CATCHUP_TICKS = 5

  // packages/net/src/localinput.ts
  export const LOCAL_PEER_ID = 'local'
  /** SHIPPED: two arguments. The tick comes from `intent.tick`, and the decorator
   *  applies the 30 Hz wire cadence itself — callers call it every sim tick. */
  export interface LocalInputTransport extends Transport {
    submitLocalInput(playerId: number, intent: Intent): void
  }
  export function withLocalInput(inner: Transport): LocalInputTransport
  export function createNullTransport(): Transport

  // packages/protocol/src/snapshot.ts — WireSnapshot gains `phase: RacePhase` (2 bits, 178 -> 180)

  // packages/protocol/src/room.ts — SHIPPED, and it RETIRES contract §5.8's
  // `packages/game/src/roomcode.ts`. Three separate supersessions, any one of
  // which breaks a task that wrote its own: the length is 5, not 4; the alphabet
  // is Crockford, which KEEPS `0` and `1` and drops `I`, `L`, `O` and `U` — the
  // opposite of the obvious choice; and the alphabet's ORDER is the 5-bit wire
  // index, so a differently-ordered alphabet is a different wire format rather
  // than a cosmetic difference. `normalizeRoomCode` no longer strips or truncates.
  export const ROOM_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
  export const ROOM_CODE_LENGTH = 5
  export const LOBBY_PATH_PREFIX = '/r/'
  export function normalizeRoomCode(raw: string): string
  export function isValidRoomCode(raw: string): boolean
  export function lobbyPathFor(code: string): string
  ```

- **Produces** — what every later Plan 3 task builds on:
  - `packages/content/package.json` — the `@tapkart/content` workspace member, exactly contract §10's manifest: `{ "name": "@tapkart/content", "version": "0.1.0", "private": true, "type": "module", "exports": { ".": "./src/index.ts" }, "dependencies": { "@tapkart/sim": "*" }, "scripts": { "typecheck": "tsc --noEmit -p tsconfig.json" } }`.
  - `packages/content/tsconfig.json` — `{ "extends": "../../tsconfig.base.json", "compilerOptions": { "resolveJsonModule": true }, "include": ["src/**/*.ts", "test/**/*.ts"] }`. **No `lib` entry, therefore no DOM**: `packages/server` (Plan 4) imports this package, and `resolveJsonModule` is what will make §3a.1's 28 static JSON imports type-check when the tracks task lands.
  - Root `package.json` `workspaces: ["packages/*", "apps/*"]` — without it `@tapkart/game` does not resolve by bare specifier from `apps/web` and the shell task would be typechecking nothing (R36).
  - Root `vitest.config.ts` `include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts']` — without it `apps/web`'s tests are collected by nothing (R37). `environment: 'node'`, `globals: false` and `reporters: ['default']` are unchanged (Q30).
  - `packages/content/test/scaffold.test.ts` — the standing regression guard that `tsconfig.base.json` stays DOM-free and that no package `server` imports (`sim`, `protocol`, `net`, `content`) ever widens `lib`.

  **This task creates no file under `packages/content/src/`.** `src/tuning.ts` is Task 2, `src/descriptors.ts` is Task 3, and the barrel `src/index.ts` (§3a.7) is a later task, so the `exports` map deliberately points one task ahead of itself — nothing resolves `@tapkart/content` by bare specifier until the barrel exists, and Tasks 2 and 3 import their own modules by relative path from their own tests. `tsc` does not report `TS18003: No inputs were found in config file` because `test/**/*.ts` matches this task's test file.

---

- [ ] **Step 1: Verify the Plan 2 gate is open — and stop the plan here if it is not**

Contract §2.5 names the surface `@tapkart/net` and `@tapkart/protocol` must export before Plan 3's first import compiles. Counted across all of this plan's tasks that is **35 elements — 25 named exports and 10 members/fields** — plus the two amendment-4 symbols, and the gate checks **every one of them**. At the time this task was written they did **not** exist: the `plan2-net` worktree had no `packages/net/src/localinput.ts`, no `TICK_MS`, no `correctionDeltaOf`, no `sampleEntity`/`liveEntityIds`, and no `phase` on `WireSnapshot`. Building against a surface that does not exist is how a plan discovers at task 20 that task 3 was fiction, so this is a real gate and not a formality.

*Amended 2026-08-14 (ruling P2-R29): 33/23 became 35/25 — `makeRemoteSample` and `makeRemoteEntitySample`, which the gate below now checks by name and by call. The gate also checks the samplers' **arity**, not merely their presence, because the old and the new form differ by one argument and a two-argument call against the three-argument method is exactly the compile error this step exists to raise early.*

The gate is deliberately **wider than the tasks that run next**. Two thirds of what it checks — `AuthorityLoop`, `ClientLoop`'s methods, `remoteInterpolatorOf`, `makeLoopbackPair`, `LoopbackOptions`, `ChannelName`, `RemoteInterpolator.push` and `sampleKart` — is first *used* by the session task, twenty-odd tasks away. A gate that only covers what the next task needs postpones exactly the discovery it exists to force, and the failure then arrives at the session task attributed to the session task.

Create `plan2-gate.check.ts` **at the repo root** with exactly this content:

```ts
// TEMPORARY. Plan 3's Task 1 gate check. Deleted at the end of this step and
// never committed. 43 elements — contract §2.5's 33 (23 named exports and 10
// members/fields), amendment 4's four accumulator symbols, and the six room-code
// symbols that retire game/src/roomcode.ts — one binding each. A binding that
// compiles proves the name exists AND has the stated shape. Where a signature
// below differs from the contract, it is quoted from SHIPPED code and the
// contract is wrong.
import {
  AuthorityLoop,
  ClientLoop,
  LOCAL_PEER_ID,
  MAX_CATCHUP_TICKS,
  REMOTE_BUFFER_CAPACITY,
  REMOTE_EXTRAPOLATE_CAP_MS,
  REMOTE_INTERP_DELAY_MS,
  RemoteInterpolator,
  TICK_MS,
  advanceAccumulator,
  correctionDeltaOf,
  createNullTransport,
  makeLoopbackPair,
  makeRemoteEntitySample,
  makeRemoteSample,
  makeTickAccumulator,
  remoteInterpolatorOf,
  withLocalInput,
} from '@tapkart/net'
import type {
  ChannelName,
  LocalInputTransport,
  LoopbackOptions,
  RemoteEntitySample,
  RemoteKeyframe,
  RemoteSample,
  TickAccumulator,
  Transport,
} from '@tapkart/net'
import {
  LOBBY_PATH_PREFIX,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  isValidRoomCode,
  lobbyPathFor,
  normalizeRoomCode,
} from '@tapkart/protocol'
import type { WireEntity, WireKart, WireSnapshot } from '@tapkart/protocol'
import type { Intent, RacePhase, SimContext, SimState, Vec3 } from '@tapkart/sim'

// --- named value exports (12) ---
const tickMs: number = TICK_MS
const localPeerId: string = LOCAL_PEER_ID
const decorate: (inner: Transport) => LocalInputTransport = withLocalInput
const nullTransport: () => Transport = createNullTransport
const loopback: (opts: LoopbackOptions) => {
  a: Transport
  b: Transport
  pump(nowMs: number): void
} = makeLoopbackPair
const interpolatorOf: (client: ClientLoop) => RemoteInterpolator = remoteInterpolatorOf
const correction: (client: ClientLoop, outPos: Vec3) => number | null = correctionDeltaOf
const authorityCtor: new (ctx: SimContext, state: SimState, t: Transport) => AuthorityLoop =
  AuthorityLoop
const clientCtor: new (ctx: SimContext, playerId: number, t: Transport) => ClientLoop =
  ClientLoop
const interpolatorCtor: typeof RemoteInterpolator = RemoteInterpolator
// P2-R29: the two buffer factories. Checked as VALUES, because the view task
// calls them — a type-only check would pass against a `declare` with no runtime
// export and fail at the first `createViewBuilder`.
const makeSample: () => RemoteSample = makeRemoteSample
const makeEntitySample: () => RemoteEntitySample = makeRemoteEntitySample

// --- the three §2.5 constants no Plan 3 task imports: presence only (3) ---
const interpDelayMs: number = REMOTE_INTERP_DELAY_MS
const bufferCapacity: number = REMOTE_BUFFER_CAPACITY
const extrapolateCapMs: number = REMOTE_EXTRAPOLATE_CAP_MS

// --- named type exports (7 net + 3 protocol) ---
// keyof, not a cast: a renamed or dropped method fails the assignment.
const transportSurface: (keyof Transport)[] =
  ['send', 'broadcast', 'onMessage', 'onPeerLost', 'peers', 'close']
const unreliable: ChannelName = 'unreliable'
const loopbackOptions: LoopbackOptions = { latencyMs: 0, jitterMs: 0, lossRate: 0, seed: 1 }
const localInputTransport: LocalInputTransport = null as unknown as LocalInputTransport
const remoteSample: RemoteSample = null as unknown as RemoteSample
const remoteEntitySample: RemoteEntitySample = null as unknown as RemoteEntitySample
const remoteKeyframe: RemoteKeyframe = null as unknown as RemoteKeyframe
const wireKart: WireKart = null as unknown as WireKart
const wireEntity: WireEntity = null as unknown as WireEntity
const wireSnapshot: WireSnapshot = null as unknown as WireSnapshot

// --- members and fields, one binding each (10) ---
const submit: (playerId: number, intent: Intent) => void =
  null as unknown as LocalInputTransport['submitLocalInput']
const push: (kf: RemoteKeyframe) => void =
  null as unknown as RemoteInterpolator['push']
// P2-R29: three arguments and a boolean, not two and a nullable. Written out in
// full rather than as `typeof` so a revert to the allocating form is a TS2322
// HERE, at the gate, and not a silent per-frame allocation in the view task.
const sampleKart: (playerId: number, nowMs: number, out: RemoteSample) => boolean =
  null as unknown as RemoteInterpolator['sampleKart']
const sampleEntity: (entityId: number, nowMs: number, out: RemoteEntitySample) => boolean =
  null as unknown as RemoteInterpolator['sampleEntity']
const liveEntityIds: (out: Int32Array) => number =
  null as unknown as RemoteInterpolator['liveEntityIds']
const sampledKart: WireKart = null as unknown as RemoteSample['kart']
const sampledEntity: WireEntity = null as unknown as RemoteEntitySample['entity']
const keyframeEntities: WireEntity[] = null as unknown as RemoteKeyframe['entities']
const keyframeEntityCount: number = null as unknown as RemoteKeyframe['entityCount']
const snapshotPhase: RacePhase = null as unknown as WireSnapshot['phase']

// --- the two loop classes' methods (part of the AuthorityLoop / ClientLoop rows) ---
const authorityTick: () => void = null as unknown as AuthorityLoop['tick']
const authorityState: () => SimState = null as unknown as AuthorityLoop['state']
const clientTick: (localIntent: Intent) => void = null as unknown as ClientLoop['tick']
const clientCorrections: () => number = null as unknown as ClientLoop['corrections']
const clientState: () => SimState = null as unknown as ClientLoop['state']

// --- amendment 4: the accumulator now lives in net — type, constructor,
//     function and clamp. The object literal is the check that matters: an
//     excess-property error here means the type still carries `lastNowMs`, and
//     the whole frame loop is written against the one-field version.
const accumulator: TickAccumulator = { residualMs: 0 }
const makeAcc: () => TickAccumulator = makeTickAccumulator
const advance: (acc: TickAccumulator, elapsedMs: number) => number = advanceAccumulator
const maxCatchup: number = MAX_CATCHUP_TICKS

// --- the protocol room-code surface that retires game/src/roomcode.ts (6) ---
const roomAlphabet: string = ROOM_CODE_ALPHABET
const roomLength: number = ROOM_CODE_LENGTH
const lobbyPrefix: string = LOBBY_PATH_PREFIX
const normalize: (raw: string) => string = normalizeRoomCode
const isValid: (raw: string) => boolean = isValidRoomCode
const lobbyPath: (code: string) => string = lobbyPathFor

void tickMs; void localPeerId; void decorate; void nullTransport; void loopback
void interpolatorOf; void correction; void authorityCtor; void clientCtor
void interpolatorCtor; void makeSample; void makeEntitySample
void interpDelayMs; void bufferCapacity; void extrapolateCapMs
void transportSurface; void unreliable; void loopbackOptions; void localInputTransport
void remoteSample; void remoteEntitySample; void remoteKeyframe
void wireKart; void wireEntity; void wireSnapshot
void submit; void push; void sampleKart; void sampleEntity; void liveEntityIds
void sampledKart; void sampledEntity; void keyframeEntities; void keyframeEntityCount
void snapshotPhase; void authorityTick; void authorityState
void clientTick; void clientCorrections; void clientState
void accumulator; void makeAcc; void advance; void maxCatchup
void roomAlphabet; void roomLength; void lobbyPrefix
void normalize; void isValid; void lobbyPath
```

Run, from the repo root:

`npx tsc --noEmit --strict --target ES2022 --module ESNext --moduleResolution Bundler --verbatimModuleSyntax --skipLibCheck plan2-gate.check.ts && echo GATE_OPEN`

Expected when the gate is open: **no output from `tsc`, then the single line `GATE_OPEN`** (exit code 0).

A closed gate reports itself precisely, and each shape means one thing:

- `error TS2307: Cannot find module '@tapkart/net' or its corresponding type declarations.` — Plan 2 is not merged into this working tree at all.
- `error TS2305: Module '"@tapkart/net"' has no exported member 'correctionDeltaOf'.` (or `'TICK_MS'`, `'withLocalInput'`, `'createNullTransport'`, `'LOCAL_PEER_ID'`, `'LocalInputTransport'`) — Task 15b did not ship, or `packages/net/src/index.ts` does not re-export `client` and `localinput`.
- `error TS2305: Module '"@tapkart/net"' has no exported member 'advanceAccumulator'.` (or `'TickAccumulator'`, `'MAX_CATCHUP_TICKS'`) — **amendment 4 has not landed in Plan 2.** The accumulator is still in `packages/game/src/clock.ts` in some other tree, or nowhere. The clock task and `packages/server` both import it from here; do not re-create it in `game`.
- `error TS2339: Property 'sampleEntity' does not exist on type 'RemoteInterpolator'.` (or `'liveEntityIds'`, `'push'`, `'sampleKart'`, `'kart'`, `'entity'`, `'entities'`, `'entityCount'`, `'phase'`) — the type shipped without the field the ruling requires.
- `error TS2305: Module '"@tapkart/net"' has no exported member 'makeRemoteSample'.` (or `'makeRemoteEntitySample'`) — **ruling P2-R29 has not landed in Plan 2**, or landed without its factories. Do not hand-roll a zeroed `RemoteSample` in `game` to get past this: `kart` is a `WireKart` with nineteen fields, a hand-rolled placeholder drifts the day one is added, and the buffer is `net`'s to define because `net` is what fills it.
- `error TS2322: Type '(playerId: number, nowMs: number, out: RemoteSample) => boolean' is not assignable to type '(playerId: number, nowMs: number) => RemoteSample | null'` — **the interpolator shipped the OLD allocating form.** Stop: the session and view tasks are written against the out-parameter form throughout, and a call site that adapts to the nullable form reintroduces the ~4,700 objects/s the ruling removed. The fix is in Plan 2, and no Plan 3 task may write into `net`.
- `error TS2322: Type '"unreliable"' is not assignable to type 'ChannelName'.` or `Type 'string' is not assignable to type '"send" | ...'` from the `keyof Transport` array — the transport surface was renamed. Every call site in the session task is written against these six names.
- `error TS2305: Module '"@tapkart/protocol"' has no exported member 'ROOM_CODE_ALPHABET'.` (or any of the other five) — the room-code module has not landed in `protocol`. **Do not** write `packages/game/src/roomcode.ts` instead: the alphabet's order is the 5-bit wire index, so a second copy is a second wire format.
- `error TS2353: Object literal may only specify known properties, and 'lastNowMs' does not exist in type 'TickAccumulator'` — you are running the *contract's* version of this file rather than the one above. The shipped accumulator has one field.
- `error TS2322: Type '...' is not assignable to type '...'` — it shipped with a **different signature** than the block above states, which is the most dangerous shape because it compiles at the call site and misbehaves at runtime.

**If any of those appear, stop. Do not continue to Step 2, do not write a shim, and above all do not write into `packages/net` or `packages/protocol` — that inverts the dependency direction spec §3 fixes.** The fix belongs to Plan 2 (Tasks 15b and 15c); report the exact `tsc` output and wait.

Delete the temporary file whether the gate passed or failed — it must never reach a commit:

`rm plan2-gate.check.ts`

Verify with `git status --porcelain`, which must not list `plan2-gate.check.ts`.

- [ ] **Step 2: Write the failing test**

Create `packages/content/test/scaffold.test.ts`:

```ts
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import vitestConfig from '../../../vitest.config'

const REPO_ROOT = new URL('../../../', import.meta.url)

function readJson(relativePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(relativePath, REPO_ROOT), 'utf8')) as Record<string, unknown>
}

/** The four packages `server` (Plan 4) imports. A DOM lib in any of them is how a
 *  server-side package acquires a browser dependency (R35, contract §10.1). */
const DOM_FREE_PACKAGES = ['sim', 'protocol', 'net', 'content'] as const

describe('the root files Plan 3 edits', () => {
  it('registers apps/* as a workspace, so @tapkart/game resolves from apps/web', () => {
    const pkg = readJson('package.json')
    expect(pkg['workspaces']).toEqual(['packages/*', 'apps/*'])
  })

  it('collects apps tests in the vitest include, and changes nothing else', () => {
    const cfg = vitestConfig as unknown as {
      test?: { include?: string[]; environment?: string; globals?: boolean; reporters?: string[] }
    }
    expect(cfg.test?.include).toEqual([
      'packages/*/test/**/*.test.ts',
      'apps/*/test/**/*.test.ts',
    ])
    expect(cfg.test?.environment).toBe('node')
    expect(cfg.test?.globals).toBe(false)
    expect(cfg.test?.reporters).toEqual(['default'])
  })

  it('leaves tsconfig.base.json DOM-free and resolveJsonModule-free', () => {
    const base = readJson('tsconfig.base.json')
    const options = base['compilerOptions'] as Record<string, unknown>
    expect(options['lib']).toEqual(['ES2022'])
    expect(options['resolveJsonModule']).toBeUndefined()
  })
})

describe('packages/content', () => {
  it('ships the manifest contract §10 fixes, depending on sim and nothing else', () => {
    expect(readJson('packages/content/package.json')).toEqual({
      name: '@tapkart/content',
      version: '0.1.0',
      private: true,
      type: 'module',
      exports: { '.': './src/index.ts' },
      dependencies: { '@tapkart/sim': '*' },
      scripts: { typecheck: 'tsc --noEmit -p tsconfig.json' },
    })
  })

  it('has resolveJsonModule and no DOM lib of its own', () => {
    const tsconfig = readJson('packages/content/tsconfig.json')
    expect(tsconfig['extends']).toBe('../../tsconfig.base.json')
    expect(tsconfig['include']).toEqual(['src/**/*.ts', 'test/**/*.ts'])
    const options = tsconfig['compilerOptions'] as Record<string, unknown>
    expect(options['resolveJsonModule']).toBe(true)
    expect(options['lib']).toBeUndefined()
  })

  it('is registered as a workspace member, so @tapkart/sim resolves from it', () => {
    const pkg = readJson('node_modules/@tapkart/content/package.json')
    expect(pkg['name']).toBe('@tapkart/content')
  })
})

describe('the packages Plan 4 server imports stay DOM-free (R35)', () => {
  it.each(DOM_FREE_PACKAGES)('packages/%s/tsconfig.json widens no lib', (name) => {
    const tsconfig = readJson(`packages/${name}/tsconfig.json`)
    const options = (tsconfig['compilerOptions'] ?? {}) as Record<string, unknown>
    expect(options['lib']).toBeUndefined()
  })
})
```

Two notes on why it is written this way, because both are places a weaker test would prove nothing:

- The vitest `include` is asserted by **importing the config module** and reading the real exported value, not by string-matching the file's source. `defineConfig` is the identity function at runtime, so this is the same array vitest itself collects with — a commented-out or misspelled glob cannot slip past it.
- The DOM-free assertion is a table over all four `server`-imported packages, not just `content`. The bug it exists to catch is a *later* task adding `"lib": ["ES2022", "DOM", "DOM.Iterable"]` to the wrong tsconfig, or to `tsconfig.base.json`, which would compile perfectly and silently give `server` a browser dependency. `render`, `game` and `apps/web` are absent from the list on purpose: those three are *supposed* to widen `lib`.

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run packages/content/test/scaffold.test.ts`

Expected: **`Tests  6 failed | 4 passed (10)`**, with exactly these six failures —

- `registers apps/* as a workspace…` → `AssertionError: expected [ 'packages/*' ] to deeply equal [ 'packages/*', 'apps/*' ]`
- `collects apps tests in the vitest include…` → `AssertionError: expected [ 'packages/*/test/**/*.test.ts' ] to deeply equal [ Array(2) ]`
- `ships the manifest contract §10 fixes…` → `Error: ENOENT: no such file or directory, open '<repo>/packages/content/package.json'`
- `has resolveJsonModule and no DOM lib of its own` → `Error: ENOENT: no such file or directory, open '<repo>/packages/content/tsconfig.json'`
- `is registered as a workspace member…` → `Error: ENOENT: no such file or directory, open '<repo>/node_modules/@tapkart/content/package.json'`
- `packages/content/tsconfig.json widens no lib` → `Error: ENOENT: no such file or directory, open '<repo>/packages/content/tsconfig.json'`

and exactly these four passing, which is stated here so a green line is not mistaken for a vacuous RED: `leaves tsconfig.base.json DOM-free and resolveJsonModule-free` and the `sim`, `protocol` and `net` rows of the DOM-free table already hold — they are standing regression guards, not drivers, and they pass on the first run by design. If `protocol` or `net` fails with `ENOENT` here, Step 1's gate was skipped or its failure was ignored: go back.

- [ ] **Step 4: Write the implementation**

Edit `package.json` lines 6-8 to:

```jsonc
  "workspaces": [
    "packages/*",
    "apps/*"
  ],
```

Edit `vitest.config.ts` line 5 to:

```ts
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
```

Nothing else in either file changes. `tsconfig.base.json` is **not** touched, in this task or any other.

Create `packages/content/package.json`:

```json
{
  "name": "@tapkart/content",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "dependencies": {
    "@tapkart/sim": "*"
  },
  "scripts": {
    "typecheck": "tsc --noEmit -p tsconfig.json"
  }
}
```

Create `packages/content/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "resolveJsonModule": true
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

Register the workspace member — this is what creates the symlink that makes `import ... from '@tapkart/sim'` resolvable from inside `packages/content`:

Run: `npm install`
Expected: exit 0, and `ls -la node_modules/@tapkart/` now lists `content -> ../../packages/content` alongside `sim`, `protocol` and `net`. An `apps/*` glob matching no directory is not an error for npm; `apps/web` arrives in a later task and needs no second install of this kind beyond its own.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run packages/content/test/scaffold.test.ts`
Expected: `Tests  10 passed (10)`.

Then verify the repository as a whole, because this task edited two root files that every other package's tests run under:

Run: `npx vitest run`
Expected: every previously passing test still passes — Plan 1's `packages/sim` suite plus Plan 2's `packages/protocol` and `packages/net` suites — and `Test Files` shows no failures. A drop in the collected file count means the `include` edit was mistyped.

Run: `npm run typecheck`
Expected: exit 0, with `@tapkart/content@0.1.0 typecheck` now among the workspaces reported and no `TS18003` from it.

Run: `git status --porcelain`
Expected: `plan2-gate.check.ts` is **not** listed.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json vitest.config.ts packages/content/package.json packages/content/tsconfig.json packages/content/test/scaffold.test.ts && git commit -m "chore(content): scaffold @tapkart/content, open the apps workspace, verify the Plan 2 gate"
```

---

### Task 2: `packages/content/src/tuning.ts` — the shipped `TUNING` and `CHARACTERS`

**Files:**
- Create: `packages/content/src/tuning.ts`
- Test: `packages/content/test/tuning.test.ts`

**Interfaces:**

- **Consumes**:
  - From `@tapkart/sim` (types, `packages/sim/src/types.ts`), quoted field-for-field because the module below must match them exactly:

    ```ts
    export interface Tuning {
      maxSpeed: number
      accelRate: number
      brakeRate: number
      steerRateBase: number
      steerSpeedFalloff: number
      gripTarmac: number
      gripDirt: number
      gripDrift: number
      gravity: number
      airYaw: number
      offtrackSpeedMul: number
      respawnTicks: number
      invulnTicks: number
      spinOutTicks: number
      driftMinSpeed: number
      driftTiers: [number, number, number]
      driftBoosts: [number, number, number]
      boostSpeedMul: number
      surgeSpeedMul: number
      kartRadius: number
      kartRestitution: number
      itemBoxRespawnTicks: number
      seekerSpeed: number
      boltSpeed: number
      entityTtl: number
    }

    export interface CharacterStats {
      id: string
      name: string
      speed: number
      accel: number
      handling: number
      weight: number
    }

    export interface SimContext {
      track: Track
      query: TrackQuery
      tuning: Tuning
      characters: CharacterStats[]
      isLeader: boolean
    }

    export interface AuthEvent {
      eventSeq: number
      tick: number
      kind: AuthEventKind
      playerId: number
      entityId: number
      item: ItemKind
      data: number
    }
    ```

    **`driftTiers` and `driftBoosts` are mutable tuples, not `readonly`** (contract §2.1). Anything that later passes `TUNING.driftTiers` to `driftTierFor` must hold `[number, number, number]`; the fix is always to hold the mutable type, never to cast.

  - From `@tapkart/sim` (functions, all re-exported by the barrel):

    ```ts
    export function buildTrackQuery(track: Track): TrackQuery
    export function createState(ctx: SimContext, seed: number, characterIdx: number[]): SimState
    export function allocStateLike(ctx: SimContext, src: SimState): SimState
    export function makeIntentBuffer(): Intent[]           // exactly MAX_KARTS distinct Intents
    export function step(ctx: SimContext, prev: SimState, next: SimState,
                         inputs: Intent[], events: AuthEvent[]): void
    ```

  - From `packages/sim/test/fixtures/track-fixtures.ts` — **test-only, reached by relative path, never by bare specifier and never from `src`** (contract §2.6):

    ```ts
    export function makeTuning(overrides?: Partial<Tuning>): Tuning
    export function makeCharacters(): CharacterStats[]
    export function makeOvalTrack(overrides?: Partial<Track>): Track
    ```

    The contract writes that relative path as `'../../../sim/test/fixtures/track-fixtures'`, which is correct from a test file one directory deeper (e.g. `packages/render/test/fixtures/`). This task's test sits at `packages/content/test/tuning.test.ts`, so the path from it is **`'../../sim/test/fixtures/track-fixtures'`** — one `..` fewer. Count the directories rather than copying the string.

  - From Task 1: `packages/content/package.json` (dependency `"@tapkart/sim": "*"`, linked into `node_modules/@tapkart/` by `npm install`) and `packages/content/tsconfig.json`.

- **Produces** — contract §3a.2, exactly two exports (`content/tuning`, symbol census §11):

  ```ts
  /** The Tuning the game actually races with — and the one the shadow authority
   *  runs step() with, which is why this is not in `game`. */
  export const TUNING: Readonly<Tuning>

  /** The eight shipped characters' handling stats. Same index space as
   *  CHARACTER_DESCRIPTORS, KART_DESCRIPTORS and KartState.characterIdx. */
  export const CHARACTERS: readonly CharacterStats[]
  ```

  Two consequences later tasks depend on, both established by this task's last test:
  - `TUNING` assigns straight into `SimContext.tuning` — TypeScript does not check `readonly` property modifiers in assignability, so `Readonly<Tuning>` satisfies `Tuning`.
  - `CHARACTERS` does **not** assign into `SimContext.characters`: a `readonly CharacterStats[]` is not assignable to a mutable `CharacterStats[]`. Every composition root writes **`characters: CHARACTERS.slice()`**. That is a copy, not a cast, and it is the shape `session.ts` and Plan 4's server both use.

**Why this task's test is not optional.** Ruling Q1, carried into §3a.2 by R46: Plan 1 shipped 477 tests and a golden replay fixture, all of them written against `makeTuning()` and `makeCharacters()`. If the shipped table diverges from the fixture by one number, those 477 tests describe physics no player ever experiences and the golden replay stops being evidence about the game — it becomes evidence about a car nobody drives. The equality test is what makes the two copies one fact. *If a tuning value should change, it changes in both places in one commit, and the golden replay is regenerated.* That friction is the point.

---

- [ ] **Step 1: Write the failing test**

Create `packages/content/test/tuning.test.ts`:

```ts
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { allocStateLike, buildTrackQuery, createState, makeIntentBuffer, step } from '@tapkart/sim'
import type { AuthEvent, CharacterStats, SimContext, Tuning } from '@tapkart/sim'
import { CHARACTERS, TUNING } from '../src/tuning'
import { makeCharacters, makeOvalTrack, makeTuning } from '../../sim/test/fixtures/track-fixtures'

const SCALAR_TUNING_KEYS = [
  'maxSpeed', 'accelRate', 'brakeRate', 'steerRateBase', 'steerSpeedFalloff',
  'gripTarmac', 'gripDirt', 'gripDrift', 'gravity', 'airYaw', 'offtrackSpeedMul',
  'respawnTicks', 'invulnTicks', 'spinOutTicks', 'driftMinSpeed', 'boostSpeedMul',
  'surgeSpeedMul', 'kartRadius', 'kartRestitution', 'itemBoxRespawnTicks',
  'seekerSpeed', 'boltSpeed', 'entityTtl',
] as const satisfies readonly (keyof Tuning)[]

const ALL_TUNING_KEYS: readonly string[] = [...SCALAR_TUNING_KEYS, 'driftTiers', 'driftBoosts']

const CHARACTER_FIELDS = ['id', 'name', 'speed', 'accel', 'handling', 'weight'] as const satisfies
  readonly (keyof CharacterStats)[]

describe('TUNING equals makeTuning() field by field', () => {
  const fixture = makeTuning()

  it('declares exactly the 25 fields of Tuning, no more and no fewer', () => {
    expect(ALL_TUNING_KEYS).toHaveLength(25)
    expect(Object.keys(TUNING).sort()).toEqual([...ALL_TUNING_KEYS].sort())
    expect(Object.keys(fixture).sort()).toEqual([...ALL_TUNING_KEYS].sort())
  })

  it.each(SCALAR_TUNING_KEYS)('%s', (key) => {
    expect(TUNING[key]).toBe(fixture[key])
  })

  it('driftTiers', () => {
    expect(TUNING.driftTiers).toHaveLength(3)
    for (let i = 0; i < 3; i++) expect(TUNING.driftTiers[i]).toBe(fixture.driftTiers[i])
  })

  it('driftBoosts', () => {
    expect(TUNING.driftBoosts).toHaveLength(3)
    for (let i = 0; i < 3; i++) expect(TUNING.driftBoosts[i]).toBe(fixture.driftBoosts[i])
  })
})

describe('CHARACTERS equals makeCharacters() field by field', () => {
  const fixture = makeCharacters()

  it('ships exactly 8 characters', () => {
    expect(CHARACTERS).toHaveLength(8)
    expect(fixture).toHaveLength(8)
  })

  for (let i = 0; i < 8; i++) {
    it(`CHARACTERS[${i}] has exactly the 6 CharacterStats fields`, () => {
      expect(Object.keys(CHARACTERS[i]).sort()).toEqual([...CHARACTER_FIELDS].sort())
    })
    it.each(CHARACTER_FIELDS)(`CHARACTERS[${i}].%s`, (field) => {
      expect(CHARACTERS[i][field]).toBe(fixture[i][field])
    })
  }
})

describe('the shipped table is a literal, not the fixture wearing a hat', () => {
  const source = readFileSync(new URL('../src/tuning.ts', import.meta.url), 'utf8')

  it('never imports the sim test fixtures', () => {
    expect(source).not.toContain('track-fixtures')
    expect(source).not.toContain('/test/')
  })

  it('has exactly one import, and it is type-only', () => {
    const imports = source.match(/^import .*$/gm) ?? []
    expect(imports).toEqual(["import type { CharacterStats, Tuning } from '@tapkart/sim'"])
  })
})

describe('the shipped content drives the real simulation', () => {
  it('composes into a SimContext that createState and step accept', () => {
    const track = makeOvalTrack()
    const ctx: SimContext = {
      track,
      query: buildTrackQuery(track),
      tuning: TUNING,
      characters: CHARACTERS.slice(),
      isLeader: true,
    }
    const prev = createState(ctx, 0xc0ffee, [0, 1, 2, 3, 4, 5, 6, 7])
    expect(prev.karts.map((k) => k.characterIdx)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])

    const next = allocStateLike(ctx, prev)
    const events: AuthEvent[] = []
    step(ctx, prev, next, makeIntentBuffer(), events)
    expect(next.tick).toBe(1)
  })
})
```

Four things in there are load-bearing, and each names the bug it exists to catch:

- **The key list is hard-coded, never derived from `TUNING`.** `expect(Object.keys(TUNING)).toEqual(Object.keys(TUNING))` is the test that compares a value to itself; deriving the expected keys from either object under test is the same defect in slower motion. With the list written out, a field missing from *both* the shipped table and the fixture still fails.
- **`.toBe`, per field, against the fixture object** — not `toEqual` over the whole struct. A whole-struct compare reports one failure that says "these differ"; the per-field table names the field, which is what a bisected tuning change actually needs.
- **The source-text test.** The one way to make every equality assertion above vacuously true is `export const TUNING = makeTuning()` in `src/`, which would also ship a test fixture into the game bundle — exactly what §2.6 forbids. Asserting the module's only import is the type-only `@tapkart/sim` line catches it, and catches a value import of `sim` sneaking in later too.
- **The `createState`/`step` composition.** `characterIdx` is clamped to `[0, characters.length - 1]` inside `createState`, so `[0..7]` surviving unchanged is a fact about `CHARACTERS.length === 8` that `sim` itself observed — a six-entry array would come back `[0,1,2,3,4,5,5,5]`. It also proves the readonly/mutable seam above is real code that compiles, not a claim in a comment.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/content/test/tuning.test.ts`

Expected: FAIL, no tests collected —

```
Error: Cannot find module '../src/tuning' imported from '<repo>/packages/content/test/tuning.test.ts'
Caused by: Error: Failed to load url ../src/tuning (resolved id: ../src/tuning) in <repo>/packages/content/test/tuning.test.ts. Does the file exist?
```

and the summary `Test Files  1 failed (1)` / `Tests  no tests`.

Run: `npx tsc --noEmit -p packages/content`
Expected: FAIL — `packages/content/test/tuning.test.ts(5,36): error TS2307: Cannot find module '../src/tuning' or its corresponding type declarations.`

Both reds are required. The vitest one comes from the **value** import of `TUNING`/`CHARACTERS`; had this test imported only types, vitest would have erased the import and reported a green run against a module that does not exist.

- [ ] **Step 3: Write the implementation**

Create `packages/content/src/tuning.ts`:

```ts
// PURE. Data only: no DOM, no clock, no three, no bundler feature.
import type { CharacterStats, Tuning } from '@tapkart/sim'

export const TUNING: Readonly<Tuning> = {
  maxSpeed: 40,
  accelRate: 24,
  brakeRate: 48,
  steerRateBase: 2.6,
  steerSpeedFalloff: 0.55,
  gripTarmac: 14,
  gripDirt: 5,
  gripDrift: 3,
  gravity: 30,
  airYaw: 0.6,
  offtrackSpeedMul: 0.55,
  respawnTicks: 72,
  invulnTicks: 90,
  spinOutTicks: 60,
  driftMinSpeed: 8,
  driftTiers: [40, 90, 150],
  driftBoosts: [24, 42, 66],
  boostSpeedMul: 1.35,
  surgeSpeedMul: 0.7,
  kartRadius: 0.9,
  kartRestitution: 0.4,
  itemBoxRespawnTicks: 180,
  seekerSpeed: 55,
  boltSpeed: 65,
  entityTtl: 600,
}

export const CHARACTERS: readonly CharacterStats[] = [
  { id: 'c0', name: 'Racer 0', speed: 1.0, accel: 1.0, handling: 1.0, weight: 1.0 },
  { id: 'c1', name: 'Racer 1', speed: 1.1, accel: 0.85, handling: 0.9, weight: 1.2 },
  { id: 'c2', name: 'Racer 2', speed: 0.92, accel: 1.15, handling: 1.1, weight: 0.85 },
  { id: 'c3', name: 'Racer 3', speed: 1.05, accel: 0.9, handling: 0.95, weight: 1.1 },
  { id: 'c4', name: 'Racer 4', speed: 0.95, accel: 1.1, handling: 1.05, weight: 0.9 },
  { id: 'c5', name: 'Racer 5', speed: 1.15, accel: 0.8, handling: 0.85, weight: 1.3 },
  { id: 'c6', name: 'Racer 6', speed: 0.88, accel: 1.2, handling: 1.15, weight: 0.8 },
  { id: 'c7', name: 'Racer 7', speed: 1.0, accel: 1.0, handling: 1.0, weight: 1.0 },
]
```

Those are contract §3a.2's transcribed values, and the character rows are `CHARACTERS[i] = { id: 'c' + i, name: 'Racer ' + i, speed: speed[i], accel: accel[i], handling: handling[i], weight: weight[i] }` with `speed = [1.0, 1.1, 0.92, 1.05, 0.95, 1.15, 0.88, 1.0]`, `accel = [1.0, 0.85, 1.15, 0.9, 1.1, 0.8, 1.2, 1.0]`, `handling = [1.0, 0.9, 1.1, 0.95, 1.05, 0.85, 1.15, 1.0]`, `weight = [1.0, 1.2, 0.85, 1.1, 0.9, 1.3, 0.8, 1.0]` — written out as eight literal rows on purpose, so the shipped table and the fixture's four parallel arrays are two independent transcriptions that the test compares, rather than the same loop copied twice.

Three rules for this file:

- **No `as const`.** `driftTiers: [40, 90, 150] as const` is `readonly [40, 90, 150]`, which does not satisfy `Tuning.driftTiers: [number, number, number]`, and the repair for that error is never a cast.
- **`CharacterStats.name` is never displayed.** It is `'Racer 3'` because Q1 requires equality with the fixture; the displayed name is `CHARACTER_DESCRIPTORS[i].name` (Task 3's schema, §3a.3). Nothing joins the two arrays by `id` — they are joined by array index only, and their `id` spaces are unrelated.
- **No `Object.freeze`.** `Readonly<Tuning>` is the contract's shape and it is a compile-time guarantee; adding a runtime freeze here would be an unrequested behaviour change in data that `server` also holds.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/content/test/tuning.test.ts`
Expected: `Tests  86 passed (86)` — 1 key-set + 23 scalar fields + 2 tuples + 1 length + 8 per-character key-sets + 48 per-character fields + 2 source-text + 1 composition.

Run: `npx tsc --noEmit -p packages/content`
Expected: exit 0, no output.

Then prove the suite has teeth before believing it, and put the file back afterwards:

```bash
sed -i 's/  maxSpeed: 40,/  maxSpeed: 41,/' packages/content/src/tuning.ts
npx vitest run packages/content/test/tuning.test.ts   # expect: Tests 1 failed | 85 passed, "AssertionError: expected 41 to be 40"
sed -i 's/  maxSpeed: 41,/  maxSpeed: 40,/' packages/content/src/tuning.ts
npx vitest run packages/content/test/tuning.test.ts   # expect: Tests 86 passed (86)
```

If the mutated run passes, the equality assertions are not reaching the shipped table and the task is not done.

- [ ] **Step 5: Commit**

```bash
git add packages/content/src/tuning.ts packages/content/test/tuning.test.ts && git commit -m "feat(content): ship TUNING and CHARACTERS, asserted field-by-field against sim's fixtures"
```

---

### Task 3: `packages/content/src/descriptors.ts` — the character and kart schema and parsers

**Files:**
- Create: `packages/content/src/descriptors.ts`
- Create: `packages/content/test/fixtures/descriptor-fixtures.ts`
- Test: `packages/content/test/descriptors.test.ts`

**Interfaces:**

- **Consumes**: nothing. This module imports no other module, from `sim` or anywhere else — `PaletteRGB` is defined *here*, and `packages/content/src/theme.ts` (§3a.4, a later task) will import it from this file. It needs Task 1's `packages/content/package.json` and `packages/content/tsconfig.json` to exist, and nothing else.

- **Produces** — contract §3a.3, exactly five exports (`content/descriptors`, symbol census §11), signatures verbatim:

  ```ts
  export type PaletteRGB = readonly [number, number, number]   // linear, 0..1

  export interface CharacterDescriptor {
    id: string                   // lowercase, hyphenated, unique across the eight
    name: string                 // the DISPLAYED name
    bodyHeight: number           // metres, 0.4 – 1.4
    bodyRadius: number           // metres, 0.15 – 0.5
    headRadius: number           // metres, 0.1 – 0.4
    palette: { primary: PaletteRGB; secondary: PaletteRGB; accent: PaletteRGB }
    silhouette: 'compact' | 'tall' | 'wide'
  }

  export interface KartDescriptor {
    id: string
    name: string
    chassisLength: number        // metres, 1.4 – 2.6
    chassisWidth: number         // metres, 0.9 – 1.6
    chassisHeight: number        // metres, 0.3 – 0.8
    wheelRadius: number          // metres, 0.2 – 0.45
    wheelWidth: number           // metres, 0.1 – 0.35
    palette: { body: PaletteRGB; trim: PaletteRGB; wheel: PaletteRGB }
  }

  /** Throws with a field-listing message on any shape violation, including a
   *  numeric field outside the range in the comments above and a palette component
   *  outside 0..1. Never returns a partially-populated descriptor. */
  export function parseCharacterDescriptor(json: unknown): CharacterDescriptor
  export function parseKartDescriptor(json: unknown): KartDescriptor
  ```

  Plus two **test-only** fixtures this task adds, used by later content tests and by the delegation task's gate. They are not in contract §9.1's fixture list — §9.1's `makeCharacterDescriptorFixture(): CharacterDescriptor` and `makeKartDescriptorFixture(): KartDescriptor` belong to `packages/render/test/fixtures/render-fixtures.ts` and return *parsed* descriptors. These return **unparsed JSON**, which is what a parser test needs, and are named differently so the two never get confused:

  ```ts
  // packages/content/test/fixtures/descriptor-fixtures.ts
  export function makeCharacterDescriptorJson(overrides?: Record<string, unknown>): Record<string, unknown>
  export function makeKartDescriptorJson(overrides?: Record<string, unknown>): Record<string, unknown>
  ```

**Scope: schema and parsers only.** The sixteen shipped descriptor records are Q2's DeepSeek delegation and are a *later* task, which is the whole reason this schema is locked first — the batch is authored against it, and its gate is built by esbuild-bundling these two real functions rather than re-implementing them, because a gate that re-implements validation tests the gate. So this task ships the parsers plus the fixtures that later task will validate against, and no records.

Two facts about these types that the later tasks depend on and that this one must not blur: **`CharacterDescriptor` is not `CharacterStats`** — stats are handling (Task 2), descriptors are appearance, and they are joined **only by array index** (`KartState.characterIdx`), never by `id`, because the two `id` spaces are unrelated. And **`KART_DESCRIPTORS[i]` is the kart of `CHARACTER_DESCRIPTORS[i]`**: v1 has no separate kart selection.

---

- [ ] **Step 1: Write the failing test**

Create `packages/content/test/fixtures/descriptor-fixtures.ts`:

```ts
/**
 * Valid descriptor JSON in exactly the shape the sixteen shipped files will use.
 * TEST-ONLY: `packages/content/src` never imports this, exactly as §2.6 requires
 * of sim's fixtures.
 *
 * The return type is `Record<string, unknown>` on purpose: a mutation test has to
 * be able to write a wrong-typed value into any field, which a `CharacterDescriptor`
 * return type would forbid at compile time. Every call returns a fresh object,
 * including fresh palette arrays, so one case's mutation cannot leak into the next.
 */
export function makeCharacterDescriptorJson(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 'ash-vega',
    name: 'Ash Vega',
    bodyHeight: 0.95,
    bodyRadius: 0.28,
    headRadius: 0.22,
    palette: {
      primary: [0.85, 0.16, 0.24],
      secondary: [0.1, 0.11, 0.16],
      accent: [1, 0.78, 0.2],
    },
    silhouette: 'compact',
    ...overrides,
  }
}

export function makeKartDescriptorJson(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 'ember-dart',
    name: 'Ember Dart',
    chassisLength: 2,
    chassisWidth: 1.2,
    chassisHeight: 0.55,
    wheelRadius: 0.32,
    wheelWidth: 0.18,
    palette: {
      body: [0.9, 0.35, 0.1],
      trim: [0.15, 0.15, 0.18],
      wheel: [0.05, 0.05, 0.06],
    },
    ...overrides,
  }
}
```

Create `packages/content/test/descriptors.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { parseCharacterDescriptor, parseKartDescriptor } from '../src/descriptors'
import type { CharacterDescriptor, KartDescriptor, PaletteRGB } from '../src/descriptors'
import { makeCharacterDescriptorJson, makeKartDescriptorJson } from './fixtures/descriptor-fixtures'

describe('parseCharacterDescriptor accepts a valid record', () => {
  it('returns every field verbatim', () => {
    const parsed: CharacterDescriptor = parseCharacterDescriptor(makeCharacterDescriptorJson())
    expect(parsed).toEqual({
      id: 'ash-vega',
      name: 'Ash Vega',
      bodyHeight: 0.95,
      bodyRadius: 0.28,
      headRadius: 0.22,
      palette: {
        primary: [0.85, 0.16, 0.24],
        secondary: [0.1, 0.11, 0.16],
        accent: [1, 0.78, 0.2],
      },
      silhouette: 'compact',
    })
  })

  it('copies rather than aliasing the input, so mutating the JSON cannot reach the descriptor', () => {
    const json = makeCharacterDescriptorJson()
    const parsed = parseCharacterDescriptor(json)
    const palette = json['palette'] as Record<string, number[]>
    palette['primary'][0] = 0.01
    ;(json as Record<string, unknown>)['name'] = 'Overwritten'
    expect(parsed.palette.primary[0]).toBe(0.85)
    expect(parsed.name).toBe('Ash Vega')
  })

  it.each([
    ['bodyHeight', 0.4, 1.4],
    ['bodyRadius', 0.15, 0.5],
    ['headRadius', 0.1, 0.4],
  ])('accepts %s at both inclusive bounds', (key, min, max) => {
    expect(() => parseCharacterDescriptor(makeCharacterDescriptorJson({ [key]: min }))).not.toThrow()
    expect(() => parseCharacterDescriptor(makeCharacterDescriptorJson({ [key]: max }))).not.toThrow()
  })

  it.each([
    ['bodyHeight', 0.4, 1.4],
    ['bodyRadius', 0.15, 0.5],
    ['headRadius', 0.1, 0.4],
  ])('rejects %s just outside both bounds', (key, min, max) => {
    expect(() => parseCharacterDescriptor(makeCharacterDescriptorJson({ [key]: min - 1e-6 })))
      .toThrow(new RegExp(key))
    expect(() => parseCharacterDescriptor(makeCharacterDescriptorJson({ [key]: max + 1e-6 })))
      .toThrow(new RegExp(key))
  })

  it('accepts every silhouette the schema lists', () => {
    for (const silhouette of ['compact', 'tall', 'wide']) {
      const parsed = parseCharacterDescriptor(makeCharacterDescriptorJson({ silhouette }))
      expect(parsed.silhouette).toBe(silhouette)
    }
  })
})

describe('parseCharacterDescriptor rejects one mutated field at a time, naming it', () => {
  const cases: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ['id', { id: 'Ash-Vega' }],
    ['id', { id: 'ash_vega' }],
    ['id', { id: '-ash' }],
    ['id', { id: 42 }],
    ['name', { name: '' }],
    ['name', { name: 7 }],
    ['bodyHeight', { bodyHeight: 2.2 }],
    ['bodyHeight', { bodyHeight: Number.NaN }],
    ['bodyHeight', { bodyHeight: '0.95' }],
    ['bodyRadius', { bodyRadius: 0.01 }],
    ['headRadius', { headRadius: Number.POSITIVE_INFINITY }],
    ['silhouette', { silhouette: 'round' }],
    ['palette', { palette: null }],
    ['palette', { palette: [0.5, 0.5, 0.5] }],
  ]

  it.each(cases)('names %s', (field, override) => {
    expect(() => parseCharacterDescriptor(makeCharacterDescriptorJson(override)))
      .toThrow(new RegExp(`parseCharacterDescriptor: .*${field}`))
  })

  it.each(['primary', 'secondary', 'accent'])('names palette.%s when it is out of 0..1', (slot) => {
    const json = makeCharacterDescriptorJson()
    const palette = json['palette'] as Record<string, unknown>
    palette[slot] = [0.5, 1.5, 0.5]
    expect(() => parseCharacterDescriptor(json)).toThrow(new RegExp(`palette\\.${slot}\\[1\\]`))
  })

  it.each(['primary', 'secondary', 'accent'])('names palette.%s when it is the wrong length', (slot) => {
    const json = makeCharacterDescriptorJson()
    const palette = json['palette'] as Record<string, unknown>
    palette[slot] = [0.5, 0.5]
    expect(() => parseCharacterDescriptor(json)).toThrow(new RegExp(`palette\\.${slot} must be an array of exactly 3`))
  })

  it('rejects an unknown field rather than ignoring it', () => {
    expect(() => parseCharacterDescriptor(makeCharacterDescriptorJson({ bodyheight: 0.95 })))
      .toThrow(/bodyheight is not a field of this schema/)
  })

  it('lists every broken field in one message', () => {
    let message = ''
    try {
      parseCharacterDescriptor(makeCharacterDescriptorJson({ id: 'Ash', bodyHeight: 9, silhouette: 'round' }))
    } catch (err) {
      message = (err as Error).message
    }
    expect(message).toContain('id')
    expect(message).toContain('bodyHeight')
    expect(message).toContain('silhouette')
  })

  const NON_OBJECTS: ReadonlyArray<readonly [string, unknown]> = [
    ['null', null],
    ['undefined', undefined],
    ['a number', 42],
    ['a string', 'ash-vega'],
    ['an array', []],
    ['a boolean', true],
  ]

  it.each(NON_OBJECTS)('rejects %s, which is not a JSON object', (_label, value) => {
    expect(() => parseCharacterDescriptor(value)).toThrow(/parseCharacterDescriptor: expected a JSON object/)
  })
})

describe('parseKartDescriptor accepts a valid record', () => {
  it('returns every field verbatim', () => {
    const parsed: KartDescriptor = parseKartDescriptor(makeKartDescriptorJson())
    expect(parsed).toEqual({
      id: 'ember-dart',
      name: 'Ember Dart',
      chassisLength: 2,
      chassisWidth: 1.2,
      chassisHeight: 0.55,
      wheelRadius: 0.32,
      wheelWidth: 0.18,
      palette: {
        body: [0.9, 0.35, 0.1],
        trim: [0.15, 0.15, 0.18],
        wheel: [0.05, 0.05, 0.06],
      },
    })
  })

  it.each([
    ['chassisLength', 1.4, 2.6],
    ['chassisWidth', 0.9, 1.6],
    ['chassisHeight', 0.3, 0.8],
    ['wheelRadius', 0.2, 0.45],
    ['wheelWidth', 0.1, 0.35],
  ])('accepts %s at both inclusive bounds and rejects just outside them', (key, min, max) => {
    expect(() => parseKartDescriptor(makeKartDescriptorJson({ [key]: min }))).not.toThrow()
    expect(() => parseKartDescriptor(makeKartDescriptorJson({ [key]: max }))).not.toThrow()
    expect(() => parseKartDescriptor(makeKartDescriptorJson({ [key]: min - 1e-6 }))).toThrow(new RegExp(key))
    expect(() => parseKartDescriptor(makeKartDescriptorJson({ [key]: max + 1e-6 }))).toThrow(new RegExp(key))
  })

  it.each(['body', 'trim', 'wheel'])('names palette.%s when a component is out of 0..1', (slot) => {
    const json = makeKartDescriptorJson()
    const palette = json['palette'] as Record<string, unknown>
    palette[slot] = [0.5, 0.5, -0.001]
    expect(() => parseKartDescriptor(json)).toThrow(new RegExp(`palette\\.${slot}\\[2\\]`))
  })

  it('rejects a character record, which has neither the kart fields nor only kart fields', () => {
    expect(() => parseKartDescriptor(makeCharacterDescriptorJson())).toThrow(/parseKartDescriptor: /)
  })

  it('accepts a PaletteRGB as a readonly triple', () => {
    const parsed = parseKartDescriptor(makeKartDescriptorJson())
    const body: PaletteRGB = parsed.palette.body
    expect(body).toHaveLength(3)
  })
})
```

Four choices in that file are deliberate, and three of them are the difference between a test with teeth and one without:

- **Both bounds are asserted at the boundary *and* one part in a million outside it.** A parser written with `<` where it needs `<=` passes every "rejects 2.2" test ever written and rejects a legal `bodyHeight: 1.4` the day the delegated batch produces one. `min` / `max` accepted plus `min - 1e-6` / `max + 1e-6` rejected pins the comparison operator itself.
- **`NON_OBJECTS` is a table of `[label, value]` rows, not a bare list of values.** `it.each([null, undefined, 42, [], true])` spreads any row that *is* an array, so the `[]` case would arrive as zero arguments — the callback would receive `undefined` and silently re-test the `undefined` case, leaving "an array is not a JSON object" unasserted. The two-column form makes the array a value rather than a row. (`_label` is unused on purpose; `noUnusedParameters` exempts a leading underscore.)
- **The aliasing test mutates the input *after* parsing.** A parser that returns its input, or that stores the input's palette arrays by reference, is a parser through which a caller can later corrupt shipped content — and every field-equality assertion above still passes under that bug.
- **The unknown-field test asserts rejection, not tolerance.** `bodyheight` is the exact typo a generated record makes; if unknown keys were ignored it would parse "successfully" with `bodyHeight` reported missing and nothing pointing at the cause.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/content/test/descriptors.test.ts`

Expected: FAIL, no tests collected —

```
Error: Cannot find module '../src/descriptors' imported from '<repo>/packages/content/test/descriptors.test.ts'
Caused by: Error: Failed to load url ../src/descriptors (resolved id: ../src/descriptors) in <repo>/packages/content/test/descriptors.test.ts. Does the file exist?
```

and the summary `Test Files  1 failed (1)` / `Tests  no tests`.

Run: `npx tsc --noEmit -p packages/content`
Expected: FAIL — two `error TS2307: Cannot find module '../src/descriptors' or its corresponding type declarations.`, one at line 2 (the value import of the two parsers) and one at line 3 (the type-only import of the three types). `tsc` resolves both; vitest sees only the first, because a type-only import is erased before module resolution is attempted.

- [ ] **Step 3: Write the implementation**

Create `packages/content/src/descriptors.ts`:

```ts
// PURE. Schema and parsers only: no DOM, no clock, no three, no bundler feature.
// The sixteen shipped descriptor records are authored in a later task; this
// module is what will accept or reject them.

/** Linear, 0..1 per component. Never a CSS string, never 0..255, never hex. */
export type PaletteRGB = readonly [number, number, number]

export interface CharacterDescriptor {
  id: string
  name: string
  bodyHeight: number
  bodyRadius: number
  headRadius: number
  palette: { primary: PaletteRGB; secondary: PaletteRGB; accent: PaletteRGB }
  silhouette: 'compact' | 'tall' | 'wide'
}

export interface KartDescriptor {
  id: string
  name: string
  chassisLength: number
  chassisWidth: number
  chassisHeight: number
  wheelRadius: number
  wheelWidth: number
  palette: { body: PaletteRGB; trim: PaletteRGB; wheel: PaletteRGB }
}

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const SILHOUETTES = ['compact', 'tall', 'wide'] as const

interface NumericRange {
  key: string
  min: number
  max: number
}

const CHARACTER_RANGES: readonly NumericRange[] = [
  { key: 'bodyHeight', min: 0.4, max: 1.4 },
  { key: 'bodyRadius', min: 0.15, max: 0.5 },
  { key: 'headRadius', min: 0.1, max: 0.4 },
]

const KART_RANGES: readonly NumericRange[] = [
  { key: 'chassisLength', min: 1.4, max: 2.6 },
  { key: 'chassisWidth', min: 0.9, max: 1.6 },
  { key: 'chassisHeight', min: 0.3, max: 0.8 },
  { key: 'wheelRadius', min: 0.2, max: 0.45 },
  { key: 'wheelWidth', min: 0.1, max: 0.35 },
]

const CHARACTER_PALETTE_KEYS = ['primary', 'secondary', 'accent'] as const
const KART_PALETTE_KEYS = ['body', 'trim', 'wheel'] as const

function describeValue(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (Array.isArray(value)) return `an array of length ${value.length}`
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return typeof value
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function readId(rec: Record<string, unknown>, issues: string[]): string {
  const raw = rec['id']
  if (typeof raw !== 'string' || !ID_PATTERN.test(raw)) {
    issues.push(
      `id must be a lowercase hyphenated string matching ${ID_PATTERN.source}, got ${describeValue(raw)}`,
    )
    return ''
  }
  return raw
}

function readName(rec: Record<string, unknown>, issues: string[]): string {
  const raw = rec['name']
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    issues.push(`name must be a non-empty string, got ${describeValue(raw)}`)
    return ''
  }
  return raw
}

function readNumber(
  rec: Record<string, unknown>,
  range: NumericRange,
  issues: string[],
): number {
  const raw = rec[range.key]
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < range.min || raw > range.max) {
    issues.push(
      `${range.key} must be a finite number in [${range.min}, ${range.max}], got ${describeValue(raw)}`,
    )
    return 0
  }
  return raw
}

function readPalette(
  paletteRec: Record<string, unknown> | null,
  key: string,
  issues: string[],
): PaletteRGB {
  if (paletteRec === null) return [0, 0, 0]
  const raw = paletteRec[key]
  if (!Array.isArray(raw) || raw.length !== 3) {
    issues.push(`palette.${key} must be an array of exactly 3 numbers, got ${describeValue(raw)}`)
    return [0, 0, 0]
  }
  const out: [number, number, number] = [0, 0, 0]
  let ok = true
  for (let i = 0; i < 3; i++) {
    const c: unknown = raw[i]
    if (typeof c !== 'number' || !Number.isFinite(c) || c < 0 || c > 1) {
      issues.push(
        `palette.${key}[${i}] must be a finite number in [0, 1] (linear), got ${describeValue(c)}`,
      )
      ok = false
      continue
    }
    out[i] = c
  }
  return ok ? out : [0, 0, 0]
}

function reportUnknownKeys(
  rec: Record<string, unknown>,
  allowedKeys: readonly string[],
  prefix: string,
  issues: string[],
): void {
  for (const key of Object.keys(rec)) {
    if (!allowedKeys.includes(key)) issues.push(`${prefix}${key} is not a field of this schema`)
  }
}

function readPaletteRecord(
  rec: Record<string, unknown>,
  allowedKeys: readonly string[],
  issues: string[],
): Record<string, unknown> | null {
  const paletteRec = asRecord(rec['palette'])
  if (paletteRec === null) {
    issues.push(
      `palette must be an object with keys ${allowedKeys.join(', ')}, got ${describeValue(rec['palette'])}`,
    )
    return null
  }
  reportUnknownKeys(paletteRec, allowedKeys, 'palette.', issues)
  return paletteRec
}

function fail(fn: string, issues: readonly string[]): never {
  throw new Error(`${fn}: ${issues.join('; ')}`)
}

const CHARACTER_KEYS: readonly string[] = [
  'id', 'name', 'bodyHeight', 'bodyRadius', 'headRadius', 'palette', 'silhouette',
]

const KART_KEYS: readonly string[] = [
  'id', 'name', 'chassisLength', 'chassisWidth', 'chassisHeight', 'wheelRadius',
  'wheelWidth', 'palette',
]

/**
 * Throws with a field-listing message on any shape violation, including a
 * numeric field outside its declared range and a palette component outside
 * 0..1. Never returns a partially-populated descriptor.
 */
export function parseCharacterDescriptor(json: unknown): CharacterDescriptor {
  const rec = asRecord(json)
  if (rec === null) fail('parseCharacterDescriptor', [`expected a JSON object, got ${describeValue(json)}`])

  const issues: string[] = []
  reportUnknownKeys(rec, CHARACTER_KEYS, '', issues)

  const id = readId(rec, issues)
  const name = readName(rec, issues)
  const bodyHeight = readNumber(rec, CHARACTER_RANGES[0], issues)
  const bodyRadius = readNumber(rec, CHARACTER_RANGES[1], issues)
  const headRadius = readNumber(rec, CHARACTER_RANGES[2], issues)

  const paletteRec = readPaletteRecord(rec, CHARACTER_PALETTE_KEYS, issues)
  const primary = readPalette(paletteRec, 'primary', issues)
  const secondary = readPalette(paletteRec, 'secondary', issues)
  const accent = readPalette(paletteRec, 'accent', issues)

  const rawSilhouette = rec['silhouette']
  let silhouette: CharacterDescriptor['silhouette'] = 'compact'
  if (
    typeof rawSilhouette !== 'string' ||
    !(SILHOUETTES as readonly string[]).includes(rawSilhouette)
  ) {
    issues.push(
      `silhouette must be one of ${SILHOUETTES.join(', ')}, got ${describeValue(rawSilhouette)}`,
    )
  } else {
    silhouette = rawSilhouette as CharacterDescriptor['silhouette']
  }

  if (issues.length > 0) fail('parseCharacterDescriptor', issues)

  return {
    id, name, bodyHeight, bodyRadius, headRadius,
    palette: { primary, secondary, accent },
    silhouette,
  }
}

/** Same rules as parseCharacterDescriptor, over the kart schema. */
export function parseKartDescriptor(json: unknown): KartDescriptor {
  const rec = asRecord(json)
  if (rec === null) fail('parseKartDescriptor', [`expected a JSON object, got ${describeValue(json)}`])

  const issues: string[] = []
  reportUnknownKeys(rec, KART_KEYS, '', issues)

  const id = readId(rec, issues)
  const name = readName(rec, issues)
  const chassisLength = readNumber(rec, KART_RANGES[0], issues)
  const chassisWidth = readNumber(rec, KART_RANGES[1], issues)
  const chassisHeight = readNumber(rec, KART_RANGES[2], issues)
  const wheelRadius = readNumber(rec, KART_RANGES[3], issues)
  const wheelWidth = readNumber(rec, KART_RANGES[4], issues)

  const paletteRec = readPaletteRecord(rec, KART_PALETTE_KEYS, issues)
  const body = readPalette(paletteRec, 'body', issues)
  const trim = readPalette(paletteRec, 'trim', issues)
  const wheel = readPalette(paletteRec, 'wheel', issues)

  if (issues.length > 0) fail('parseKartDescriptor', issues)

  return {
    id, name, chassisLength, chassisWidth, chassisHeight, wheelRadius, wheelWidth,
    palette: { body, trim, wheel },
  }
}
```

Five properties of that implementation are requirements, not style:

- **Every issue is collected, and the throw happens once at the end** — that is what "a field-listing message" means, and it is what makes the delegated batch's gate useful: a bad record reports all of its problems in one pass instead of one per re-run.
- **Nothing is constructed until `issues.length === 0`**, so a partially-populated descriptor cannot escape. The `return 0` / `return [0, 0, 0]` placeholders inside the readers exist only to keep the collection going; they are unreachable in any returned value.
- **Every returned palette is a fresh `[number, number, number]`**, never the input's array, so shipped content cannot be mutated through the object a parse handed back.
- **`Number.isFinite` is explicit.** A `NaN` would fail the range comparison anyway (every comparison with `NaN` is false), but relying on that is an accident waiting for a refactor to reorder the check.
- **Unknown keys are rejected**, at the top level and inside `palette`, with the offending key named.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/content/test/descriptors.test.ts`
Expected: `Tests  48 passed (48)`.

Run: `npx tsc --noEmit -p packages/content`
Expected: exit 0, no output.

Then confirm the suite fails under the three bugs it exists to catch, restoring the file after each:

```bash
cp packages/content/src/descriptors.ts /tmp/descriptors.bak.ts

# 1. exclusive bounds instead of inclusive -> expect 8 failed | 40 passed
sed -i 's/raw < range.min || raw > range.max/raw <= range.min || raw >= range.max/' packages/content/src/descriptors.ts
npx vitest run packages/content/test/descriptors.test.ts
cp /tmp/descriptors.bak.ts packages/content/src/descriptors.ts

# 2. unknown keys ignored -> expect 1 failed | 47 passed
sed -i 's/if (!allowedKeys.includes(key)) issues.push/if (false \&\& !allowedKeys.includes(key)) issues.push/' packages/content/src/descriptors.ts
npx vitest run packages/content/test/descriptors.test.ts
cp /tmp/descriptors.bak.ts packages/content/src/descriptors.ts

# 3. palette components unrange-checked -> expect 6 failed | 42 passed
sed -i 's/ || c < 0 || c > 1//' packages/content/src/descriptors.ts
npx vitest run packages/content/test/descriptors.test.ts
cp /tmp/descriptors.bak.ts packages/content/src/descriptors.ts

npx vitest run packages/content/test/descriptors.test.ts   # expect: Tests 48 passed (48)
rm /tmp/descriptors.bak.ts
```

If any mutated run comes back green, that assertion is not reaching the parser and the task is not done.

- [ ] **Step 5: Commit**

```bash
git add packages/content/src/descriptors.ts packages/content/test/descriptors.test.ts packages/content/test/fixtures/descriptor-fixtures.ts && git commit -m "feat(content): character and kart descriptor schema and parsers"
```

---

### Task 4: `packages/content/src/theme.ts` — track themes and edge-marker parameters

Contract §3a.4. This task ships the **schema, the parser and the neutral fallback theme**
— and nothing else. The six shipped theme records (`content/themes/*.json`) are generated
by **Task 5** and parsed by **Task 6**'s `bundle.ts`; this module owns no track data.

**Why edge markers exist at all (ruling Q20).** They are not decoration. v1's visual budget
is a ribbon over a themed ground plane, and a bare ribbon on a flat plane gives the player
**no speed cue and no corner read** — that is a gameplay defect, not an aesthetic one.
Posts marching past at a known spacing are what make speed legible, and their curve ahead
is what makes the next corner legible. Q20's resolution is that `render` generates the
posts procedurally from the spline it already has (§4.3's `buildEdgeMarkers`), and their
*parameters* — spacing, height, outboard offset, and the two alternating colours — live on
the theme, so they are **content that a per-track record tunes**, not constants baked into
code. Everything this task does to `EdgeMarkerParams` follows from that: the ranges are
gameplay ranges (a 60 m spacing reads as no markers at all; a 0.1 m post is invisible), and
the parser enforces them so a bad record fails at startup instead of shipping an illegible
track.

**Files:**
- Create: `packages/content/src/theme.ts`
- Test: `packages/content/test/theme.test.ts`

**Interfaces:**

- Consumes (from `@tapkart/sim`, contract §2.1 — type-only, so `verbatimModuleSyntax`
  erases the import and nothing in `sim` is loaded at runtime):
  - `type Vec3 = { x: number; y: number; z: number }`
- Consumes (from **Task 3**, `packages/content/src/descriptors.ts`, contract §3a.3 —
  type-only):
  - `type PaletteRGB = readonly [number, number, number]` — linear, each component `0..1`
- Produces (`packages/content/src/theme.ts`) — exactly four exports, which is what
  contract §11's census allocates to `content/theme`:
  - `interface EdgeMarkerParams { spacing: number; height: number; offset: number; colors: readonly [PaletteRGB, PaletteRGB] }`
  - `interface TrackTheme { trackId: string; road: PaletteRGB; roadDirt: PaletteRGB; shoulder: PaletteRGB; wall: PaletteRGB; ground: PaletteRGB; sky: { top: PaletteRGB; bottom: PaletteRGB }; fog: { color: PaletteRGB; near: number; far: number }; sunDirection: Vec3; ambient: number; edgeMarkers: EdgeMarkerParams }`
  - `const DEFAULT_TRACK_THEME: Readonly<TrackTheme>`
  - `function parseTrackTheme(json: unknown): TrackTheme`

**Ordering.** Task 3 lands `descriptors.ts` first: the `PaletteRGB` import above is
type-only, so vitest would run without it, but `npx tsc --noEmit -p packages/content` would
not. Task 5 consumes `parseTrackTheme` from *this* file to gate its generated records, and
Task 6's `bundle.ts` consumes it to parse them at load; neither exists yet, and this task
does not wait on either.

**Do not add a shared `parseutil.ts`.** `descriptors.ts` (Task 3), this file, and
`tracks.ts` (Task 6) each carry their own module-private `isRecord` / `show` / range
helpers. Contract §11 fixes the content package at five modules and the header's locked
contract says a thing two tasks both need is *an amendment, not a local definition*. Three
copies of a six-line type guard is the cheaper mistake.

**Ranges are the contract's, transcribed.** `spacing` 4–40 m, `height` 0.3–2.0 m, `offset`
0–3 m, `ambient` 0..1, every palette component 0..1, `fog.near < fog.far`, and
`sunDirection` a unit vector to `1e-6`. Do not widen one because a generated record missed
it — Task 5 regenerates the record.

---

- [ ] **Step 1: Write the failing test**

Create `packages/content/test/theme.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { DEFAULT_TRACK_THEME, parseTrackTheme } from '../src/theme'

/**
 * A raw record as it arrives from JSON: every leaf is `unknown`, because that is
 * exactly what `parseTrackTheme` is handed and exactly what the rejection cases
 * below need to be able to replace with the wrong shape.
 */
interface RawTheme {
  trackId?: unknown
  road?: unknown
  roadDirt?: unknown
  shoulder?: unknown
  wall?: unknown
  ground?: unknown
  sky?: unknown
  fog?: unknown
  sunDirection?: unknown
  ambient?: unknown
  edgeMarkers?: unknown
}

/** A valid record, plus per-case overrides. Fresh object every call. */
function rawTheme(over: RawTheme = {}): RawTheme {
  return {
    trackId: 'caldera',
    road: [0.16, 0.15, 0.15],
    roadDirt: [0.32, 0.2, 0.13],
    shoulder: [0.22, 0.14, 0.11],
    wall: [0.28, 0.24, 0.23],
    ground: [0.19, 0.11, 0.09],
    sky: { top: [0.14, 0.09, 0.12], bottom: [0.62, 0.28, 0.14] },
    fog: { color: [0.42, 0.22, 0.16], near: 90, far: 620 },
    sunDirection: { x: 0.36, y: 0.8, z: 0.48 },
    ambient: 0.38,
    edgeMarkers: {
      spacing: 14,
      height: 0.9,
      offset: 0.7,
      colors: [
        [0.9, 0.88, 0.84],
        [0.72, 0.14, 0.1],
      ],
    },
    ...over,
  }
}

/** Euclidean distance in linear RGB — used only to state Q20's legibility claim. */
function colorDistance(a: readonly number[], b: readonly number[]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
}

describe('parseTrackTheme', () => {
  it('accepts a valid record and returns every field verbatim', () => {
    const theme = parseTrackTheme(rawTheme())

    expect(theme.trackId).toBe('caldera')
    expect(theme.road).toEqual([0.16, 0.15, 0.15])
    expect(theme.roadDirt).toEqual([0.32, 0.2, 0.13])
    expect(theme.shoulder).toEqual([0.22, 0.14, 0.11])
    expect(theme.wall).toEqual([0.28, 0.24, 0.23])
    expect(theme.ground).toEqual([0.19, 0.11, 0.09])
    expect(theme.sky.top).toEqual([0.14, 0.09, 0.12])
    expect(theme.sky.bottom).toEqual([0.62, 0.28, 0.14])
    expect(theme.fog.color).toEqual([0.42, 0.22, 0.16])
    expect(theme.fog.near).toBe(90)
    expect(theme.fog.far).toBe(620)
    expect(theme.sunDirection).toEqual({ x: 0.36, y: 0.8, z: 0.48 })
    expect(theme.ambient).toBe(0.38)
    expect(theme.edgeMarkers.spacing).toBe(14)
    expect(theme.edgeMarkers.height).toBe(0.9)
    expect(theme.edgeMarkers.offset).toBe(0.7)
    expect(theme.edgeMarkers.colors).toEqual([
      [0.9, 0.88, 0.84],
      [0.72, 0.14, 0.1],
    ])
  })

  it('accepts the boundary values of every range', () => {
    const theme = parseTrackTheme(
      rawTheme({
        road: [0, 0, 0],
        wall: [1, 1, 1],
        ambient: 0,
        fog: { color: [0, 0, 0], near: 0, far: 1e-9 },
        edgeMarkers: {
          spacing: 4,
          height: 0.3,
          offset: 0,
          colors: [
            [0, 0, 0],
            [1, 1, 1],
          ],
        },
      }),
    )
    expect(theme.edgeMarkers.spacing).toBe(4)
    expect(theme.edgeMarkers.height).toBe(0.3)
    expect(theme.edgeMarkers.offset).toBe(0)
    expect(theme.ambient).toBe(0)

    const upper = parseTrackTheme(
      rawTheme({
        ambient: 1,
        edgeMarkers: {
          spacing: 40,
          height: 2,
          offset: 3,
          colors: [
            [1, 1, 1],
            [0, 0, 0],
          ],
        },
      }),
    )
    expect(upper.edgeMarkers.spacing).toBe(40)
    expect(upper.edgeMarkers.height).toBe(2)
    expect(upper.edgeMarkers.offset).toBe(3)
    expect(upper.ambient).toBe(1)
  })

  it('returns a copy, so a later mutation of the JSON cannot reach shipped content', () => {
    const raw = rawTheme()
    const theme = parseTrackTheme(raw)

    expect(theme).not.toBe(raw)
    ;(raw.road as number[])[0] = 0.99
    ;(raw.sky as { top: number[] }).top[0] = 0.99
    ;(raw.edgeMarkers as { spacing: number }).spacing = 99
    ;(raw.sunDirection as { x: number }).x = 99

    expect(theme.road[0]).toBe(0.16)
    expect(theme.sky.top[0]).toBe(0.14)
    expect(theme.edgeMarkers.spacing).toBe(14)
    expect(theme.sunDirection.x).toBe(0.36)
  })

  it('accepts a unit sunDirection that is not axis-aligned, and one within tolerance', () => {
    expect(parseTrackTheme(rawTheme({ sunDirection: { x: 0.6, y: 0.64, z: 0.48 } })).sunDirection).toEqual({
      x: 0.6,
      y: 0.64,
      z: 0.48,
    })
    // |v| = 1 + 5e-7, inside the 1e-6 tolerance.
    const near = parseTrackTheme(rawTheme({ sunDirection: { x: 0, y: 1.0000005, z: 0 } }))
    expect(near.sunDirection.y).toBe(1.0000005)
  })
})

describe('DEFAULT_TRACK_THEME', () => {
  it('satisfies its own schema', () => {
    // Q20: the fallback has to be legible, not merely present. If the default ever
    // violates the schema it claims to exemplify, every unthemed track renders from a
    // record the parser would reject.
    const reparsed = parseTrackTheme(structuredClone(DEFAULT_TRACK_THEME))
    expect(reparsed).toEqual(DEFAULT_TRACK_THEME)
  })

  it('has edge markers that read as alternating and stand off the road', () => {
    const m = DEFAULT_TRACK_THEME.edgeMarkers
    expect(colorDistance(m.colors[0], m.colors[1])).toBeGreaterThanOrEqual(0.25)
    expect(colorDistance(m.colors[0], DEFAULT_TRACK_THEME.road)).toBeGreaterThanOrEqual(0.15)
    expect(colorDistance(m.colors[1], DEFAULT_TRACK_THEME.road)).toBeGreaterThanOrEqual(0.15)
  })

  it('is a neutral grey theme, not a copy of some track', () => {
    expect(DEFAULT_TRACK_THEME.trackId).toBe('default')
  })
})

/**
 * One case per field the parser must check. The bug this table exists to catch is a
 * parser that simply casts its argument — or that validates eight fields and forgets
 * the ninth: such a parser accepts every case below without throwing, and every case
 * below fails. `toThrow(string)` is a substring match on the message, so each case
 * also pins that the message NAMES the offending field, which is what makes a
 * startup failure on a shipped record actionable.
 */
const REJECTIONS: ReadonlyArray<{ what: string; over: RawTheme; expected: string }> = [
  { what: 'trackId missing', over: { trackId: undefined }, expected: 'trackId: must be a non-empty string, got undefined' },
  { what: 'trackId empty', over: { trackId: '' }, expected: 'trackId: must be a non-empty string, got ""' },
  { what: 'road not an array', over: { road: { r: 1 } }, expected: 'road: must be an array of 3 numbers, got an object' },
  { what: 'road too short', over: { road: [0.1, 0.2] }, expected: 'road: must be an array of 3 numbers, got an array of 2' },
  { what: 'road component above 1', over: { road: [0.1, 1.4, 0.2] }, expected: 'road[1]: must be within 0..1, got 1.4' },
  { what: 'roadDirt missing', over: { roadDirt: undefined }, expected: 'roadDirt: must be an array of 3 numbers, got undefined' },
  { what: 'shoulder component negative', over: { shoulder: [0.1, 0.2, -0.2] }, expected: 'shoulder[2]: must be within 0..1, got -0.2' },
  { what: 'wall missing', over: { wall: undefined }, expected: 'wall: must be an array of 3 numbers, got undefined' },
  { what: 'ground component not a number', over: { ground: [null, 0.2, 0.2] }, expected: 'ground[0]: must be a finite number, got null' },
  { what: 'sky missing', over: { sky: undefined }, expected: 'sky: must be an object with top and bottom, got undefined' },
  { what: 'sky.top invalid', over: { sky: { top: [1.5, 0, 0], bottom: [0.5, 0.5, 0.5] } }, expected: 'sky.top[0]: must be within 0..1, got 1.5' },
  { what: 'sky.bottom missing', over: { sky: { top: [0.1, 0.1, 0.1] } }, expected: 'sky.bottom: must be an array of 3 numbers, got undefined' },
  { what: 'fog missing', over: { fog: undefined }, expected: 'fog: must be an object with color, near and far, got undefined' },
  { what: 'fog.color invalid', over: { fog: { color: [0.1, 0.1], near: 10, far: 20 } }, expected: 'fog.color: must be an array of 3 numbers, got an array of 2' },
  { what: 'fog.near not a number', over: { fog: { color: [0.1, 0.1, 0.1], near: '120', far: 300 } }, expected: 'fog.near: must be a finite number, got "120"' },
  { what: 'fog.near negative', over: { fog: { color: [0.1, 0.1, 0.1], near: -5, far: 300 } }, expected: 'fog.near: must be at least 0, got -5' },
  { what: 'fog.near not less than far', over: { fog: { color: [0.1, 0.1, 0.1], near: 900, far: 120 } }, expected: 'fog: near 900 must be less than far 120' },
  { what: 'sunDirection missing', over: { sunDirection: undefined }, expected: 'sunDirection: must be an object with x, y and z, got undefined' },
  { what: 'sunDirection.y missing', over: { sunDirection: { x: 0, z: 0 } }, expected: 'sunDirection.y: must be a finite number, got undefined' },
  { what: 'sunDirection not unit', over: { sunDirection: { x: 0, y: 1.2, z: 0 } }, expected: 'sunDirection: must be a unit vector' },
  { what: 'sunDirection zero', over: { sunDirection: { x: 0, y: 0, z: 0 } }, expected: 'sunDirection: must be a unit vector' },
  { what: 'ambient above 1', over: { ambient: 1.4 }, expected: 'ambient: must be within 0..1, got 1.4' },
  { what: 'edgeMarkers missing', over: { edgeMarkers: undefined }, expected: 'edgeMarkers: must be an object, got undefined' },
  {
    what: 'edgeMarkers.spacing too wide',
    over: { edgeMarkers: { spacing: 60, height: 0.9, offset: 0.7, colors: [[1, 1, 1], [0, 0, 0]] } },
    expected: 'edgeMarkers.spacing: must be within 4..40, got 60',
  },
  {
    what: 'edgeMarkers.height too short',
    over: { edgeMarkers: { spacing: 14, height: 0.1, offset: 0.7, colors: [[1, 1, 1], [0, 0, 0]] } },
    expected: 'edgeMarkers.height: must be within 0.3..2, got 0.1',
  },
  {
    what: 'edgeMarkers.offset too far outboard',
    over: { edgeMarkers: { spacing: 14, height: 0.9, offset: 5, colors: [[1, 1, 1], [0, 0, 0]] } },
    expected: 'edgeMarkers.offset: must be within 0..3, got 5',
  },
  {
    what: 'edgeMarkers.colors has one entry',
    over: { edgeMarkers: { spacing: 14, height: 0.9, offset: 0.7, colors: [[1, 1, 1]] } },
    expected: 'edgeMarkers.colors: must be an array of 2 palettes, got an array of 1',
  },
  {
    what: 'edgeMarkers.colors[1] out of range',
    over: { edgeMarkers: { spacing: 14, height: 0.9, offset: 0.7, colors: [[1, 1, 1], [1.5, 0, 0]] } },
    expected: 'edgeMarkers.colors[1][0]: must be within 0..1, got 1.5',
  },
]

describe('parseTrackTheme rejections', () => {
  it('covers every field in the schema', () => {
    // A truncated table is the silent way this suite stops testing what it claims to.
    expect(REJECTIONS).toHaveLength(28)
  })

  for (const c of REJECTIONS) {
    it(`rejects ${c.what}`, () => {
      expect(() => parseTrackTheme(rawTheme(c.over))).toThrow(c.expected)
    })
  }

  it('rejects unknown keys, at the top level and inside nested objects', () => {
    // Task 3's descriptor parsers reject unknown keys and this parser matches them: a
    // theme that silently ignores `glow` lets a generated record claim a field the
    // renderer will never read, and the author has no way to find out.
    const top = { ...rawTheme(), glow: 3 }
    expect(() => parseTrackTheme(top)).toThrow("theme: unknown key 'glow'")

    const markers = rawTheme({
      edgeMarkers: {
        spacing: 14,
        height: 0.9,
        offset: 0.7,
        colors: [
          [1, 1, 1],
          [0, 0, 0],
        ],
        blink: true,
      },
    })
    expect(() => parseTrackTheme(markers)).toThrow("edgeMarkers: unknown key 'blink'")

    const sun = rawTheme({ sunDirection: { x: 0.36, y: 0.8, z: 0.48, w: 1 } })
    expect(() => parseTrackTheme(sun)).toThrow("sunDirection: unknown key 'w'")

    const sky = rawTheme({ sky: { top: [0.1, 0.1, 0.1], bottom: [0.2, 0.2, 0.2], haze: 1 } })
    expect(() => parseTrackTheme(sky)).toThrow("sky: unknown key 'haze'")

    const fog = rawTheme({ fog: { color: [0.1, 0.1, 0.1], near: 10, far: 20, density: 0.5 } })
    expect(() => parseTrackTheme(fog)).toThrow("fog: unknown key 'density'")
  })

  it('rejects a non-object outright', () => {
    expect(() => parseTrackTheme(null)).toThrow('parseTrackTheme: must be an object, got null')
    expect(() => parseTrackTheme([])).toThrow('parseTrackTheme: must be an object, got an array of 0')
    expect(() => parseTrackTheme(7)).toThrow('parseTrackTheme: must be an object, got 7')
  })

  it('lists every violation in one message, not just the first', () => {
    // A parser that throws on the first bad field makes fixing a generated record an
    // N-round trip. Task 5 gates 22 records against this parser; one message per
    // record is the difference between one regeneration and six.
    let message = ''
    try {
      parseTrackTheme(rawTheme({ ambient: 4, trackId: undefined }))
    } catch (e) {
      message = (e as Error).message
    }
    expect(message).toContain('trackId')
    expect(message).toContain('ambient')
    expect(message).toContain('; ')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/content/test/theme.test.ts`

Expected: FAIL — the whole file fails to collect, with
`Error: Cannot find module '../src/theme' imported from '<repo>/packages/content/test/theme.test.ts'`
and `Caused by: Error: Failed to load url ../src/theme (resolved id: ../src/theme) ... Does the file exist?`

- [ ] **Step 3: Write the implementation**

Create `packages/content/src/theme.ts`:

```ts
// PURE (contract §0a). Per-track palettes (§3a.4, Q3) and Q20's edge-marker
// parameters: the schema, the parser, and the neutral fallback theme.
//
// No DOM, no `three`, no clock, no bundler feature. `packages/server` (Plan 4)
// imports this package under plain Node, which is why nothing here may depend on
// Vite and why the only `@tapkart/sim` import is a type.
//
// This module owns no track data. The six shipped theme records live in
// `content/themes/*.json` and are parsed by `src/bundle.ts` through the parser
// below, so a malformed shipped theme throws at startup rather than rendering.
import type { Vec3 } from '@tapkart/sim'

import type { PaletteRGB } from './descriptors'

/** Q20: the edge markers are gameplay, not decoration — they are the speed and
 *  corner cue a bare ribbon on a flat plane does not give. Parameters live on
 *  the theme so they are content, not code. */
export interface EdgeMarkerParams {
  spacing: number // metres along the centreline between posts, 4 – 40
  height: number // metres, 0.3 – 2.0
  offset: number // metres outboard of width/2, 0 – 3
  colors: readonly [PaletteRGB, PaletteRGB] // alternating, colorIdx 0 and 1
}

export interface TrackTheme {
  trackId: string // equals the Track.id it themes
  road: PaletteRGB
  roadDirt: PaletteRGB
  shoulder: PaletteRGB
  wall: PaletteRGB
  ground: PaletteRGB
  sky: { top: PaletteRGB; bottom: PaletteRGB }
  fog: { color: PaletteRGB; near: number; far: number } // metres; near < far
  sunDirection: Vec3 // normalised; parse throws if |v| is not 1 ± 1e-6
  ambient: number // 0..1
  edgeMarkers: EdgeMarkerParams
}

/** How far |sunDirection| may sit from 1. Six-decimal content survives this by
 *  nine orders of magnitude; a hand-written direction that was never normalised
 *  does not. */
const SUN_TOLERANCE = 1e-6

/** A neutral grey theme with legible edge markers: what a track with no theme
 *  file falls back to.
 *
 *  `sunDirection` is (0.36, 0.80, 0.48) — exactly unit, because 36² + 80² + 48²
 *  = 100². Every direction in this package is chosen that way, so no rounding
 *  ever pushes one outside SUN_TOLERANCE. The markers are white/red at 12 m: the
 *  spacing a driver reads as speed at 40 m/s, and the one colour pair that stays
 *  legible against grey road and grey ground. */
export const DEFAULT_TRACK_THEME: Readonly<TrackTheme> = {
  trackId: 'default',
  road: [0.18, 0.18, 0.19],
  roadDirt: [0.26, 0.22, 0.17],
  shoulder: [0.12, 0.13, 0.12],
  wall: [0.3, 0.3, 0.32],
  ground: [0.14, 0.16, 0.14],
  sky: { top: [0.1, 0.14, 0.22], bottom: [0.55, 0.6, 0.66] },
  fog: { color: [0.55, 0.58, 0.62], near: 120, far: 900 },
  sunDirection: { x: 0.36, y: 0.8, z: 0.48 },
  ambient: 0.35,
  edgeMarkers: {
    spacing: 12,
    height: 0.9,
    offset: 0.6,
    colors: [
      [0.85, 0.85, 0.86],
      [0.75, 0.12, 0.12],
    ],
  },
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Rejects unknown keys, at the top level and inside every nested object — the same
 *  rule `parseCharacterDescriptor` and `parseKartDescriptor` apply (Task 3). A theme
 *  is generated content; a key the parser silently ignores is a field the author
 *  believed was doing something. */
function checkKeys(
  o: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  errs: string[],
): void {
  for (const key of Object.keys(o)) {
    if (!allowed.includes(key)) {
      errs.push(`${path}: unknown key '${key}'`)
    }
  }
}

/** Renders a rejected value for the error message. Never throws, never recurses. */
function show(v: unknown): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return `an array of ${v.length}`
  const t = typeof v
  if (t === 'number' || t === 'boolean') return String(v)
  if (t === 'string') return JSON.stringify(v)
  if (t === 'object') return 'an object'
  return t
}

function numField(
  o: Record<string, unknown>,
  key: string,
  path: string,
  lo: number,
  hi: number,
  errs: string[],
): number {
  const v = o[key]
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    errs.push(`${path}: must be a finite number, got ${show(v)}`)
    return 0
  }
  if (v < lo || v > hi) {
    const range = Number.isFinite(hi) ? `within ${lo}..${hi}` : `at least ${lo}`
    errs.push(`${path}: must be ${range}, got ${v}`)
    return 0
  }
  return v
}

function palette(v: unknown, path: string, errs: string[]): PaletteRGB {
  if (!Array.isArray(v) || v.length !== 3) {
    errs.push(`${path}: must be an array of 3 numbers, got ${show(v)}`)
    return [0, 0, 0]
  }
  const out: [number, number, number] = [0, 0, 0]
  for (let i = 0; i < 3; i++) {
    const c: unknown = v[i]
    if (typeof c !== 'number' || !Number.isFinite(c)) {
      errs.push(`${path}[${i}]: must be a finite number, got ${show(c)}`)
      continue
    }
    if (c < 0 || c > 1) {
      errs.push(`${path}[${i}]: must be within 0..1, got ${c}`)
      continue
    }
    out[i] = c
  }
  return out
}

function unitVec(v: unknown, path: string, errs: string[]): Vec3 {
  if (!isRecord(v)) {
    errs.push(`${path}: must be an object with x, y and z, got ${show(v)}`)
    return { x: 0, y: 1, z: 0 }
  }
  checkKeys(v, ['x', 'y', 'z'], path, errs)
  const before = errs.length
  // No per-component range: |v| = 1 already bounds every component to [-1, 1], and a
  // component range of exactly ±1 would reject the legal (0, 1.0000005, 0) that sits
  // inside SUN_TOLERANCE.
  const lo = Number.NEGATIVE_INFINITY
  const hi = Number.POSITIVE_INFINITY
  const x = numField(v, 'x', `${path}.x`, lo, hi, errs)
  const y = numField(v, 'y', `${path}.y`, lo, hi, errs)
  const z = numField(v, 'z', `${path}.z`, lo, hi, errs)
  if (errs.length !== before) return { x: 0, y: 1, z: 0 }
  const len = Math.hypot(x, y, z)
  if (Math.abs(len - 1) > SUN_TOLERANCE) {
    errs.push(`${path}: must be a unit vector, |v| = ${len}`)
    return { x: 0, y: 1, z: 0 }
  }
  return { x, y, z }
}

/** Throws with a field-listing message on any shape violation. */
export function parseTrackTheme(json: unknown): TrackTheme {
  if (!isRecord(json)) {
    throw new Error(`parseTrackTheme: must be an object, got ${show(json)}`)
  }

  const errs: string[] = []
  checkKeys(
    json,
    [
      'trackId',
      'road',
      'roadDirt',
      'shoulder',
      'wall',
      'ground',
      'sky',
      'fog',
      'sunDirection',
      'ambient',
      'edgeMarkers',
    ],
    'theme',
    errs,
  )

  let trackId = ''
  const rawId: unknown = json['trackId']
  if (typeof rawId !== 'string' || rawId.length === 0) {
    errs.push(`trackId: must be a non-empty string, got ${show(rawId)}`)
  } else {
    trackId = rawId
  }

  const road = palette(json['road'], 'road', errs)
  const roadDirt = palette(json['roadDirt'], 'roadDirt', errs)
  const shoulder = palette(json['shoulder'], 'shoulder', errs)
  const wall = palette(json['wall'], 'wall', errs)
  const ground = palette(json['ground'], 'ground', errs)

  let skyTop: PaletteRGB = [0, 0, 0]
  let skyBottom: PaletteRGB = [0, 0, 0]
  const rawSky: unknown = json['sky']
  if (!isRecord(rawSky)) {
    errs.push(`sky: must be an object with top and bottom, got ${show(rawSky)}`)
  } else {
    checkKeys(rawSky, ['top', 'bottom'], 'sky', errs)
    skyTop = palette(rawSky['top'], 'sky.top', errs)
    skyBottom = palette(rawSky['bottom'], 'sky.bottom', errs)
  }

  let fogColor: PaletteRGB = [0, 0, 0]
  let fogNear = 0
  let fogFar = 1
  const rawFog: unknown = json['fog']
  if (!isRecord(rawFog)) {
    errs.push(`fog: must be an object with color, near and far, got ${show(rawFog)}`)
  } else {
    checkKeys(rawFog, ['color', 'near', 'far'], 'fog', errs)
    fogColor = palette(rawFog['color'], 'fog.color', errs)
    const before = errs.length
    fogNear = numField(rawFog, 'near', 'fog.near', 0, Number.POSITIVE_INFINITY, errs)
    fogFar = numField(rawFog, 'far', 'fog.far', 0, Number.POSITIVE_INFINITY, errs)
    if (errs.length === before && !(fogNear < fogFar)) {
      errs.push(`fog: near ${fogNear} must be less than far ${fogFar}`)
    }
  }

  const sunDirection = unitVec(json['sunDirection'], 'sunDirection', errs)
  const ambient = numField(json, 'ambient', 'ambient', 0, 1, errs)

  let spacing = 0
  let height = 0
  let offset = 0
  let markerA: PaletteRGB = [0, 0, 0]
  let markerB: PaletteRGB = [0, 0, 0]
  const rawMarkers: unknown = json['edgeMarkers']
  if (!isRecord(rawMarkers)) {
    errs.push(`edgeMarkers: must be an object, got ${show(rawMarkers)}`)
  } else {
    checkKeys(rawMarkers, ['spacing', 'height', 'offset', 'colors'], 'edgeMarkers', errs)
    spacing = numField(rawMarkers, 'spacing', 'edgeMarkers.spacing', 4, 40, errs)
    height = numField(rawMarkers, 'height', 'edgeMarkers.height', 0.3, 2, errs)
    offset = numField(rawMarkers, 'offset', 'edgeMarkers.offset', 0, 3, errs)
    const rawColors: unknown = rawMarkers['colors']
    if (!Array.isArray(rawColors) || rawColors.length !== 2) {
      errs.push(`edgeMarkers.colors: must be an array of 2 palettes, got ${show(rawColors)}`)
    } else {
      markerA = palette(rawColors[0], 'edgeMarkers.colors[0]', errs)
      markerB = palette(rawColors[1], 'edgeMarkers.colors[1]', errs)
    }
  }

  if (errs.length > 0) {
    throw new Error(`parseTrackTheme: ${errs.join('; ')}`)
  }

  return {
    trackId,
    road,
    roadDirt,
    shoulder,
    wall,
    ground,
    sky: { top: skyTop, bottom: skyBottom },
    fog: { color: fogColor, near: fogNear, far: fogFar },
    sunDirection: { x: sunDirection.x, y: sunDirection.y, z: sunDirection.z },
    ambient,
    edgeMarkers: { spacing, height, offset, colors: [markerA, markerB] },
  }
}
```

Three implementation notes, each of which a test above would catch if ignored:

1. **Every value is copied out.** The returned theme shares no object with `json`. The
   shipped records arrive as *imported JSON modules* (§3a.1) — one process-wide object per
   file — so a parser that returned its argument would let any consumer's mutation reach
   every later `loadContentBundle()` caller.
2. **Errors accumulate, then throw once.** 22 generated records go through this parser in
   Task 5's gate; one message per record is what makes a regeneration one round trip.
3. **`unitVec` bails to `{0,1,0}` after a component error** so a missing `y` does not also
   produce a bogus "not a unit vector" line naming a field the author did not write.
4. **Unknown keys are rejected, here and in every nested object**, matching Task 3's
   `parseCharacterDescriptor` / `parseKartDescriptor`. All three parsers run over
   generated records in Task 5's gate, and a parser that silently drops a key lets a
   generated theme claim a field nothing reads. What this parser deliberately does **not**
   check is uniqueness or cross-record agreement — `trackId` collisions and roster order
   are Task 6's and Task 5's, because a per-record parser cannot see the other 21 records.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/content/test/theme.test.ts`

Expected: PASS — 39 passed (4 `parseTrackTheme` + 3 `DEFAULT_TRACK_THEME` + 32 rejection
tests: the coverage guard, the 28 table cases, the unknown-key case, the non-object case
and the multiple-violation case).

Then typecheck the package:

Run: `npx tsc --noEmit -p packages/content`

Expected: no output, exit 0. If it reports `Cannot find module './descriptors'`, Task 3 has
not landed yet — that is an ordering failure, not a defect in this file.

- [ ] **Step 5: Commit**

```bash
git add packages/content/src/theme.ts packages/content/test/theme.test.ts
git commit -m "feat(content): track theme schema, parser and the neutral fallback theme"
```

---

### Task 5: The DeepSeek content delegation — 8 character descriptors, 8 kart descriptors, 6 track themes

Rulings Q2 and Q3, contract §3a.3 and §3a.4. Twenty-two independent records against a
schema that is **locked before the batch runs** — which is the whole reason this is
answerable now — generated with `deepseek-batch`, gated by the game's own parsers, reviewed,
and committed.

**Why this is delegated at all.** Spec §10 names it as delegation work and it is a textbook
fit: 22 records, one fixed schema, no repo-wide context needed, reviewed before use, worth
about a nickel. The skill's own floor is "below roughly 20 items, do it yourself" — 22 is
just over it, and the margin comes entirely from the fact that all three record kinds share
**one instruction**, so the batch is one warm prompt cache rather than three cold ones.

**What is NOT delegated: balance.** The eight `CharacterStats` — `speed`, `accel`,
`handling`, `weight` — come from `makeCharacters()` and live in `CHARACTERS` (ruling Q1,
contract §3a.2). No model invents game balance. DeepSeek authors **names, palettes,
silhouette and proportions**, and the briefs hand it each slot's fixed stats as *input* so
the appearance can agree with the handling. `CharacterDescriptor.name` is the **displayed**
name — `CharacterStats.name` is `'Racer 3'` and is never shown — and the two arrays join
**by index only** (`KartState.characterIdx`), never by `id`.

**Why the gate is built from the real shipped code.** The gate script bundles the actual
`parseCharacterDescriptor`, `parseKartDescriptor` and `parseTrackTheme` with esbuild and
runs every generated record through them, so it rejects exactly what the game would reject.
**A gate that reimplements validation tests the gate.** This is not a new idea here: it is
the method `content/pipeline/` already used for the six shipped tracks — `validateTrack` and
`buildTrackQuery` bundled out of `packages/sim/src`, never rewritten — and that ladder
caught a 1.3 m surface overlap in `glacier-pass` and a completely undrivable
`neon-district`, neither of which a hand-written checker would have known to look for.

**Files:**
- Create: `content/pipeline/content-entry.ts`
- Create: `content/pipeline/descriptor-gen-instruction.md`
- Create: `content/pipeline/descriptors.jsonl`
- Create: `content/pipeline/gate-descriptors.mjs`
- Create (generated, gated, reviewed, committed):
  - `content/characters/character-0.json` … `character-7.json`
  - `content/karts/kart-0.json` … `kart-7.json`
  - `content/themes/{caldera,dust-canyon,glacier-pass,harbor-run,neon-district,redwood-rise}.json`
- Modify: `content/pipeline/README.md` (append one section — exact text in Step 3.8)
- Modify: `.gitignore` (repo root) — appends the three working-file patterns in Step 3.9. **This is the only task in this plan that edits `.gitignore`**, declared here so a reviewer seeing a root file in the diff knows it was intended.
- Create (generated, gitignored, never committed): `content/pipeline/content-bundle.mjs` (esbuild output), `content/pipeline/descriptors.jsonl.results.jsonl` (`deepseek-batch` output), `content/pipeline/records-out/` and its 22 staged `*.json`. `content/pipeline/descriptors-fix.jsonl` is created **only** on the regeneration path (Step 3.7); if that path runs, delete it before Step 5 — it is neither gitignored nor committed, and it would leave `git status` dirty.
- Test: `packages/content/test/roster.test.ts`

**Ordering.** This task needs Task 3 (`descriptors.ts`) and Task 4 (`theme.ts`) — the gate
imports both — and it must land **before Task 6**, whose `bundle.ts` statically imports all
22 files by exact path. Nothing here depends on Task 6.

**Interfaces:**

- Consumes (from **Task 3**, `packages/content/src/descriptors.ts`):
  - `type PaletteRGB = readonly [number, number, number]` — linear, each component `0..1`
  - `interface CharacterDescriptor { id: string; name: string; bodyHeight: number; bodyRadius: number; headRadius: number; palette: { primary: PaletteRGB; secondary: PaletteRGB; accent: PaletteRGB }; silhouette: 'compact' | 'tall' | 'wide' }`
  - `interface KartDescriptor { id: string; name: string; chassisLength: number; chassisWidth: number; chassisHeight: number; wheelRadius: number; wheelWidth: number; palette: { body: PaletteRGB; trim: PaletteRGB; wheel: PaletteRGB } }`
  - `function parseCharacterDescriptor(json: unknown): CharacterDescriptor`
  - `function parseKartDescriptor(json: unknown): KartDescriptor`
  - Task 3's decided semantics, which this task's gate must not restate differently:
    unknown keys are **rejected** (top level and inside `palette`); ranges are
    **inclusive** at both ends; every issue is collected into one `parseX: a; b; c`
    message; palettes are deep-copied; `NaN`/`Infinity` are rejected; `id` must match
    `^[a-z0-9]+(?:-[a-z0-9]+)*$`; `name` must be non-empty. **Uniqueness of `id` across
    the eight is deliberately NOT a per-record concern — it is this task's, because a
    per-record parser cannot see the other 21 records.**
- Consumes (from **Task 4**, `packages/content/src/theme.ts`):
  - `interface TrackTheme { trackId: string; road: PaletteRGB; roadDirt: PaletteRGB; shoulder: PaletteRGB; wall: PaletteRGB; ground: PaletteRGB; sky: { top: PaletteRGB; bottom: PaletteRGB }; fog: { color: PaletteRGB; near: number; far: number }; sunDirection: Vec3; ambient: number; edgeMarkers: EdgeMarkerParams }`
  - `interface EdgeMarkerParams { spacing: number; height: number; offset: number; colors: readonly [PaletteRGB, PaletteRGB] }`
  - `function parseTrackTheme(json: unknown): TrackTheme`
- Consumes (from **Task 2**, `packages/content/src/tuning.ts`, contract §3a.2) — as data
  copied into the briefs and the gate, not as an import:
  - `CHARACTERS[i].weight` = `[1.0, 1.2, 0.85, 1.1, 0.9, 1.3, 0.8, 1.0]`
- Produces: the 22 JSON files above, consumed by Task 6's `bundle.ts`.

**Two conventions this task fixes, because nothing else can.**

1. **Filename is the slot; `id` is content.** `content/characters/character-3.json` is
   `characterIdx` 3 — the slot whose handling is `CHARACTERS[3]` — and its `id` is whatever
   the record's name slugs to. The filename carries the index because **index is the join**
   (§3a.3), and pinning filenames up front is also what lets Task 6 write 22 static import
   lines before the records exist. Theme files are named for their `trackId`, which *is*
   their key.
2. **The roster is alphabetical, one letter per slot: A, B, … H.** Contract §3a.6 orders
   `characters` and `karts` by `id` ascending, while the *stats* are per index — so if
   id-ascending order and slot order ever disagree, slot 5's appearance is handed slot 2's
   handling and no type catches it. Giving slot *i* the letter *i* makes the two orders
   agree by construction, and it makes the failure checkable: the gate asserts that
   `id` starts with the slot's letter, that the eight ids are unique, and that they are
   already sorted. An alphabetical character-select grid is also just how these games ship.

---

- [ ] **Step 1: Write the failing test**

Create `packages/content/test/roster.test.ts`:

```ts
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import type { CharacterDescriptor, KartDescriptor, PaletteRGB } from '../src/descriptors'
import { parseCharacterDescriptor, parseKartDescriptor } from '../src/descriptors'
import type { TrackTheme } from '../src/theme'
import { parseTrackTheme } from '../src/theme'

/** Q34's test-only reach: the roster is judged as it ships, off disk. */
const CONTENT = fileURLToPath(new URL('../../../content/', import.meta.url))

function readJson(rel: string): unknown {
  return JSON.parse(readFileSync(CONTENT + rel, 'utf8')) as unknown
}

function stems(dir: string): string[] {
  return readdirSync(CONTENT + dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -5))
    .sort()
}

/** CHARACTERS[i].weight, contract §3a.2 — the balance this content must look like. */
const WEIGHTS = [1.0, 1.2, 0.85, 1.1, 0.9, 1.3, 0.8, 1.0]
const LETTERS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
const TRACK_IDS = [
  'caldera',
  'dust-canyon',
  'glacier-pass',
  'harbor-run',
  'neon-district',
  'redwood-rise',
]

function silhouetteFor(weight: number): 'compact' | 'tall' | 'wide' {
  if (weight >= 1.1) return 'wide'
  if (weight <= 0.9) return 'compact'
  return 'tall'
}

/**
 * Distance between two linear colours in a perceptual-ish space (component-wise sqrt).
 * Linear values crush dark colours together — two very different asphalt greys are
 * 0.02 apart in linear light — so a plain linear distance would call any two dark
 * palettes identical and any two bright ones different. The sqrt is a stand-in for the
 * display transfer function, which is what the player's eye actually sees.
 */
function visualDistance(a: PaletteRGB, b: PaletteRGB): number {
  const d0 = Math.sqrt(a[0]) - Math.sqrt(b[0])
  const d1 = Math.sqrt(a[1]) - Math.sqrt(b[1])
  const d2 = Math.sqrt(a[2]) - Math.sqrt(b[2])
  return Math.hypot(d0, d1, d2)
}

/** The same thresholds `gate-descriptors.mjs` applies before a record is accepted. */
const MIN_MARKER_PAIR = 0.25
const MIN_MARKER_SURFACE = 0.2
const MIN_ROAD_GROUND = 0.1
const MIN_KART_SEPARATION = 0.15
const MIN_THEME_SEPARATION = 0.1

function slugOf(name: string): string {
  return name
    .toLowerCase()
    .replace(/['’.]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

const characters: CharacterDescriptor[] = []
const karts: KartDescriptor[] = []
const themes: TrackTheme[] = []
for (let i = 0; i < 8; i++) {
  characters.push(parseCharacterDescriptor(readJson(`characters/character-${i}.json`)))
  karts.push(parseKartDescriptor(readJson(`karts/kart-${i}.json`)))
}
for (const id of TRACK_IDS) {
  themes.push(parseTrackTheme(readJson(`themes/${id}.json`)))
}

describe('shipped roster files', () => {
  it('ships exactly 8 characters, 8 karts and 6 themes, and no stray file', () => {
    // Catches a `.ds` sidecar, a `character-8.json`, or a half-moved regeneration
    // landing in shipped content.
    expect(stems('characters')).toEqual([
      'character-0',
      'character-1',
      'character-2',
      'character-3',
      'character-4',
      'character-5',
      'character-6',
      'character-7',
    ])
    expect(stems('karts')).toEqual([
      'kart-0',
      'kart-1',
      'kart-2',
      'kart-3',
      'kart-4',
      'kart-5',
      'kart-6',
      'kart-7',
    ])
    expect(stems('themes')).toEqual([...TRACK_IDS].sort())
  })

  it('parses every record through the real parser', () => {
    // The module-scope loads above already threw if not; these pin the counts so a
    // silently-empty loop cannot pass.
    expect(characters).toHaveLength(8)
    expect(karts).toHaveLength(8)
    expect(themes).toHaveLength(6)
  })
})

describe('roster ordering', () => {
  it('gives slot i the letter i, so id-ascending order IS slot order', () => {
    // The bug: contract §3a.6 orders the bundle by id ascending while the STATS are per
    // index. If the two orders disagree, the heavyweight is drawn with the
    // featherweight's body and races with the featherweight's handling, and nothing in
    // the type system notices.
    for (let i = 0; i < 8; i++) {
      expect(characters[i].id.startsWith(LETTERS[i])).toBe(true)
      expect(karts[i].id.startsWith(LETTERS[i])).toBe(true)
    }
    const characterIds = characters.map((c) => c.id)
    const kartIds = karts.map((k) => k.id)
    expect(characterIds).toEqual([...characterIds].sort())
    expect(kartIds).toEqual([...kartIds].sort())
  })

  it('has unique ids and names, which no per-record parser can check', () => {
    const characterIds = characters.map((c) => c.id)
    const kartIds = karts.map((k) => k.id)
    expect(new Set(characterIds).size).toBe(8)
    expect(new Set(kartIds).size).toBe(8)
    expect(new Set(characters.map((c) => c.name)).size).toBe(8)
    expect(new Set(karts.map((k) => k.name)).size).toBe(8)
  })

  it('derives every id from its own displayed name', () => {
    for (const record of [...characters, ...karts]) {
      expect(slugOf(record.name)).toBe(record.id)
      expect(record.name.length).toBeGreaterThanOrEqual(3)
      expect(record.name.length).toBeLessThanOrEqual(18)
      expect(record.name[0]).toBe(record.name[0].toUpperCase())
    }
  })
})

describe('appearance agrees with the handling each slot is fixed to', () => {
  it('gives each character the silhouette its weight implies', () => {
    // Q2 hands the model the stats as INPUT so the field is readable: a player must be
    // able to see that the heavy kart is heavy. A silhouette chosen freely makes the
    // eight racers a lucky dip.
    for (let i = 0; i < 8; i++) {
      expect(characters[i].silhouette).toBe(silhouetteFor(WEIGHTS[i]))
    }
  })

  it('backs the silhouette up with the proportions', () => {
    for (let i = 0; i < 8; i++) {
      const c = characters[i]
      if (c.silhouette === 'wide') expect(c.bodyRadius).toBeGreaterThanOrEqual(0.38)
      if (c.silhouette === 'tall') expect(c.bodyHeight).toBeGreaterThanOrEqual(1.0)
      if (c.silhouette === 'compact') expect(c.bodyHeight).toBeLessThanOrEqual(0.95)
    }
  })

  it('sizes each kart to its paired racer', () => {
    for (let i = 0; i < 8; i++) {
      const k = karts[i]
      if (WEIGHTS[i] >= 1.1) {
        expect(k.chassisWidth).toBeGreaterThanOrEqual(1.35)
        expect(k.chassisLength).toBeGreaterThanOrEqual(2.1)
      }
      if (WEIGHTS[i] <= 0.9) {
        expect(k.chassisWidth).toBeLessThanOrEqual(1.15)
        expect(k.chassisLength).toBeLessThanOrEqual(1.9)
      }
    }
  })

  it('makes the eight kart bodies tellable apart', () => {
    // Eight karts in one pack on a phone screen. If two share a body colour the player
    // cannot find themselves, which is a gameplay failure, not a taste one.
    for (let i = 0; i < 8; i++) {
      for (let j = i + 1; j < 8; j++) {
        const d = visualDistance(karts[i].palette.body, karts[j].palette.body)
        expect(d, `karts ${i} and ${j} share a body colour`).toBeGreaterThanOrEqual(
          MIN_KART_SEPARATION,
        )
      }
    }
  })
})

describe('themes', () => {
  it('themes exactly the six shipped tracks, each by its own id', () => {
    expect(themes.map((t) => t.trackId)).toEqual(TRACK_IDS)
  })

  it('keeps Q20 edge markers legible — the speed and corner cue', () => {
    // Q20: markers are gameplay. Two markers a player cannot tell apart give no cadence,
    // and markers that vanish into the road or the ground give nothing at all.
    for (const theme of themes) {
      const [a, b] = theme.edgeMarkers.colors
      expect(visualDistance(a, b), `${theme.trackId}: marker colours are too alike`).toBeGreaterThanOrEqual(
        MIN_MARKER_PAIR,
      )
      for (const c of [a, b]) {
        expect(visualDistance(c, theme.road), `${theme.trackId}: marker vs road`).toBeGreaterThanOrEqual(
          MIN_MARKER_SURFACE,
        )
        expect(visualDistance(c, theme.ground), `${theme.trackId}: marker vs ground`).toBeGreaterThanOrEqual(
          MIN_MARKER_SURFACE,
        )
      }
      expect(theme.edgeMarkers.spacing).toBeGreaterThanOrEqual(4)
      expect(theme.edgeMarkers.spacing).toBeLessThanOrEqual(40)
    }
  })

  it('keeps the road distinguishable from what is beside it', () => {
    for (const theme of themes) {
      expect(
        visualDistance(theme.road, theme.ground),
        `${theme.trackId}: road and ground are the same colour`,
      ).toBeGreaterThanOrEqual(MIN_ROAD_GROUND)
    }
  })

  it('gives the six tracks six different looks', () => {
    // The failure mode of a batch that ignored its per-record briefs is six palettes
    // that are the same palette. Compared over road + ground + sky.top together.
    for (let i = 0; i < themes.length; i++) {
      for (let j = i + 1; j < themes.length; j++) {
        const d = Math.hypot(
          visualDistance(themes[i].road, themes[j].road),
          visualDistance(themes[i].ground, themes[j].ground),
          visualDistance(themes[i].sky.top, themes[j].sky.top),
        )
        expect(
          d,
          `${themes[i].trackId} and ${themes[j].trackId} look the same`,
        ).toBeGreaterThanOrEqual(MIN_THEME_SEPARATION)
      }
    }
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/content/test/roster.test.ts`

Expected: FAIL — the file fails to collect, because the module-scope loader throws before
any test runs:
`Error: ENOENT: no such file or directory, open '<repo>/content/characters/character-0.json'`

- [ ] **Step 3: Generate, gate, review, and place the 22 records**

**3.1 — Write the esbuild entry point.** Create `content/pipeline/content-entry.ts`:

```ts
// Entry point for the gate bundle: re-exports the REAL parsers so
// `gate-descriptors.mjs` judges a generated record with the same code the game runs.
// A second implementation of these rules could drift and accept records the game rejects.
export { parseCharacterDescriptor, parseKartDescriptor } from '../../packages/content/src/descriptors'
export { parseTrackTheme } from '../../packages/content/src/theme'
```

Bundle it (run from the repository root):

```bash
npx esbuild content/pipeline/content-entry.ts --bundle --format=esm \
  --platform=node --outfile=content/pipeline/content-bundle.mjs
```

Expected: `content/pipeline/content-bundle.mjs  ~7kb` and `⚡ Done in …ms`. The
`import type` lines in `theme.ts` erase, so no `@tapkart/sim` code is pulled in. Verify the
bundle is live before trusting it:

```bash
node -e "import('./content/pipeline/content-bundle.mjs').then(m => { console.log(Object.keys(m)); try { m.parseTrackTheme({}) } catch (e) { console.log(e.message.slice(0, 80)) } })"
```

Expected: `[ 'parseCharacterDescriptor', 'parseKartDescriptor', 'parseTrackTheme' ]` and a
`parseTrackTheme: trackId: must be a non-empty string, got undefined; …` message. If the
second line does not appear, the gate would pass everything, silently.

**3.2 — Write the instruction.** Create `content/pipeline/descriptor-gen-instruction.md`.
This file is sent **byte-identically with every one of the 22 jobs** — that is what warms
DeepSeek's prompt cache — so nothing per-record may appear in it:

````markdown
You are generating one record of shipped content for a kart-racing game, as a single
JSON object. Output ONLY the JSON object. No prose, no markdown fence, no trailing
commentary.

The input body says which KIND of record to write — `character`, `kart` or `theme` — and
gives that record's brief. Everything below is fixed and identical for every record.

# Colour is LINEAR 0..1 — not sRGB, not hex, not 0..255

Every colour is `[r, g, b]`: three JSON numbers, each between 0 and 1, in LINEAR light.
This is the single rule most likely to be got wrong, so read it twice. A mid-grey that
looks like #808080 on a screen is about **0.22** linear, not 0.5. Anchors:

| Surface | linear value |
|---|---|
| fresh asphalt, basalt, night water | 0.02 – 0.06 |
| dark soil, wet stone, deep foliage | 0.05 – 0.12 |
| dry sand, concrete, weathered wood | 0.15 – 0.35 |
| bright paint, lit foliage | 0.3 – 0.6 |
| snow, white paint, sunlit cloud | 0.6 – 0.9 |
| neon or emissive accent | 0.7 – 1.0 in one or two channels, near 0 in the others |

Three decimals is plenty. Never write a hex string.

# kind: character

```
{ "id": string, "name": string,
  "bodyHeight": number, "bodyRadius": number, "headRadius": number,
  "palette": { "primary": [r,g,b], "secondary": [r,g,b], "accent": [r,g,b] },
  "silhouette": "compact" | "tall" | "wide" }
```

- `name` is the DISPLAYED name and the only thing a player ever sees. One or two words,
  3 to 18 characters, beginning with the CAPITAL LETTER the body gives you. Invent
  people: no living or historical person, no brand, no trademark, no franchise name.
- `id` is `name`, lowercased, with apostrophes and full stops removed and every run of
  non-alphanumeric characters replaced by a single `-`. "Ada Flint" becomes "ada-flint".
  Nothing else is accepted.
- `bodyHeight` 0.4 – 1.4, `bodyRadius` 0.15 – 0.5, `headRadius` 0.1 – 0.4. Metres.
- `silhouette` — copy the value the body gives you. It is derived from handling numbers
  this record does not carry and it is not yours to choose. Then match it:
  - `wide` → `bodyRadius` at least 0.38
  - `tall` → `bodyHeight` at least 1.00
  - `compact` → `bodyHeight` at most 0.95
- `palette.primary` is the racer's main colour and must be one a player can name at a
  glance; `secondary` supports it; `accent` is a small bright highlight.

# kind: kart

```
{ "id": string, "name": string,
  "chassisLength": number, "chassisWidth": number, "chassisHeight": number,
  "wheelRadius": number, "wheelWidth": number,
  "palette": { "body": [r,g,b], "trim": [r,g,b], "wheel": [r,g,b] } }
```

- `name` and `id` follow the same two rules as a character, including the capital letter
  the body gives you.
- `chassisLength` 1.4 – 2.6, `chassisWidth` 0.9 – 1.6, `chassisHeight` 0.3 – 0.8,
  `wheelRadius` 0.2 – 0.45, `wheelWidth` 0.1 – 0.35. Metres.
- The body gives a weight class. Match it:
  - `heavy` → `chassisWidth` at least 1.35 AND `chassisLength` at least 2.10
  - `light` → `chassisWidth` at most 1.15 AND `chassisLength` at most 1.90
  - `medium` → anything in range
- `palette.body` is how a player finds their own kart in a pack of eight on a phone
  screen. The body brief names your colour family; stay inside it, and make it vivid.
- `palette.wheel` is rubber: 0.01 – 0.05 in every channel unless the brief says otherwise.

# kind: theme

```
{ "trackId": string,
  "road": [r,g,b], "roadDirt": [r,g,b], "shoulder": [r,g,b],
  "wall": [r,g,b], "ground": [r,g,b],
  "sky": { "top": [r,g,b], "bottom": [r,g,b] },
  "fog": { "color": [r,g,b], "near": number, "far": number },
  "sunDirection": { "x": number, "y": number, "z": number },
  "ambient": number,
  "edgeMarkers": { "spacing": number, "height": number, "offset": number,
                   "colors": [ [r,g,b], [r,g,b] ] } }
```

- `trackId` — copy the id in the body EXACTLY. It is not yours to invent.
- `road` is tarmac, `roadDirt` the dirt sections, `shoulder` the run-off just outside the
  racing line, `wall` the barrier, `ground` everything beyond. `road` and `ground` must
  NOT be near-identical: the player has to see where the drivable surface ends.
- `fog.near` and `fog.far` are metres and `near` must be less than `far`. Typical: near
  40 – 150, far 350 – 1200. Night, snow and storm fog closer than open desert.
- `ambient` is 0 – 1: how much light reaches surfaces facing away from the sun. Overcast
  and snow are high (0.4 – 0.6); night and deep canyon are low (0.1 – 0.25).
- `sunDirection` MUST be a unit vector; the parser rejects it when |v| differs from 1 by
  more than 0.000001. Do not compute one — **copy one row of this table verbatim**:

| sun | x | y | z |
|---|---|---|---|
| high, ahead-right | 0.360 | 0.800 | 0.480 |
| high, ahead-left | -0.360 | 0.800 | 0.480 |
| high, behind-right | 0.480 | 0.800 | -0.360 |
| high, behind-left | -0.480 | 0.800 | -0.360 |
| overhead, slightly right | 0.280 | 0.960 | 0.000 |
| overhead, slightly behind | 0.000 | 0.960 | -0.280 |
| mid, from the right | 0.600 | 0.640 | 0.480 |
| mid, behind-left | -0.600 | 0.640 | -0.480 |
| low evening, from ahead | 0.480 | 0.600 | 0.640 |
| low evening, from the left | -0.640 | 0.600 | 0.480 |

- `edgeMarkers` are the posts along both track edges. They are the player's speed cue and
  their read on the next corner — gameplay, not decoration:
  - `spacing` 4 – 40 metres between posts. 10 – 16 is what reads as speed at 40 m/s; 40
    reads as almost no markers at all.
  - `height` 0.3 – 2.0, `offset` 0 – 3 metres outboard of the road edge.
  - `colors` is exactly two colours, alternating post by post. They must be strongly
    different from each other AND clearly visible against BOTH `road` and `ground`. One
    bright colour and one dark saturated colour is the reliable pair.

# Rules for every record

1. Output exactly one JSON object and nothing else.
2. No key that is not listed above — not at the top level and not inside `palette`,
   `sky`, `fog`, `sunDirection` or `edgeMarkers`. The parser rejects unknown keys, so a
   record carrying a "description" or "notes" field is thrown away whole.
3. No key omitted.
4. Every number is a JSON number: no strings, no `null`, no `NaN`, no `Infinity`, no
   arithmetic, no units.
5. Every range above is inclusive at both ends.
6. This record carries NO speed, acceleration, handling, weight or any other balance
   number. Those are fixed elsewhere in the game and a record that invents one is thrown
   away.
````

**3.3 — Write the briefs.** Create `content/pipeline/descriptors.jsonl` — 22 lines, one
JSON object per line, `id` naming the output file and `brief` carrying everything
per-record. **Nothing in a brief may be moved into the instruction**, or the cache stops
warming:

```jsonl
{"id": "character-0", "brief": "kind: character. Roster slot 0 of 8. The displayed name must begin with the capital letter A. silhouette: tall - copy that value. Handling fixed for this slot, given so the look can match it, and NOT to be written into the JSON: speed 1.00, acceleration 1.00, handling 1.00, weight 1.00. Archetype: the baseline all-rounder, the racer a new player is handed first. Nothing exceptional in any direction. Approachable rather than aggressive. Colour family: crimson red, shared with kart slot A."}
{"id": "character-1", "brief": "kind: character. Roster slot 1 of 8. The displayed name must begin with the capital letter B. silhouette: wide - copy that value. Handling fixed for this slot, given so the look can match it, and NOT to be written into the JSON: speed 1.10, acceleration 0.85, handling 0.90, weight 1.20. Archetype: a heavy runner with a high top end and lazy turn-in. Should look like something that takes a while to get going and then does not stop. Colour family: amber orange, shared with kart slot B."}
{"id": "character-2", "brief": "kind: character. Roster slot 2 of 8. The displayed name must begin with the capital letter C. silhouette: compact - copy that value. Handling fixed for this slot, given so the look can match it, and NOT to be written into the JSON: speed 0.92, acceleration 1.15, handling 1.10, weight 0.85. Archetype: a light darting racer, quickest off the line, low top speed. Small and quick-looking. Colour family: teal, shared with kart slot C."}
{"id": "character-3", "brief": "kind: character. Roster slot 3 of 8. The displayed name must begin with the capital letter D. silhouette: wide - copy that value. Handling fixed for this slot, given so the look can match it, and NOT to be written into the JSON: speed 1.05, acceleration 0.90, handling 0.95, weight 1.10. Archetype: a long-haul cruiser, slightly heavy, strong top end, unhurried. Colour family: deep blue, shared with kart slot D."}
{"id": "character-4", "brief": "kind: character. Roster slot 4 of 8. The displayed name must begin with the capital letter E. silhouette: compact - copy that value. Handling fixed for this slot, given so the look can match it, and NOT to be written into the JSON: speed 0.95, acceleration 1.10, handling 1.05, weight 0.90. Archetype: light and responsive, modest top speed, the technical driver's pick. Colour family: lime green, shared with kart slot E."}
{"id": "character-5", "brief": "kind: character. Roster slot 5 of 8. The displayed name must begin with the capital letter F. silhouette: wide - copy that value. Handling fixed for this slot, given so the look can match it, and NOT to be written into the JSON: speed 1.15, acceleration 0.80, handling 0.85, weight 1.30. Archetype: the heavyweight. Fastest in a straight line and worst at everything else. The biggest racer on the grid by a clear margin. Colour family: violet, shared with kart slot F."}
{"id": "character-6", "brief": "kind: character. Roster slot 6 of 8. The displayed name must begin with the capital letter G. silhouette: compact - copy that value. Handling fixed for this slot, given so the look can match it, and NOT to be written into the JSON: speed 0.88, acceleration 1.20, handling 1.15, weight 0.80. Archetype: the featherweight. Best acceleration and best handling in the game, lowest top speed. The smallest racer on the grid. Colour family: white and pale cyan, shared with kart slot G."}
{"id": "character-7", "brief": "kind: character. Roster slot 7 of 8. The displayed name must begin with the capital letter H. silhouette: tall - copy that value. Handling fixed for this slot, given so the look can match it, and NOT to be written into the JSON: speed 1.00, acceleration 1.00, handling 1.00, weight 1.00. Archetype: the second baseline. Identical handling to slot A and must look nothing like them - a different build, a different attitude, a different palette. Colour family: magenta, shared with kart slot H."}
{"id": "kart-0", "brief": "kind: kart. Roster slot 0 of 8, the kart of the slot A racer. The displayed name must begin with the capital letter A. Weight class: medium. Character: an honest, unremarkable machine, the one every other kart is measured against. Colour family: crimson red. Wheels are plain black rubber."}
{"id": "kart-1", "brief": "kind: kart. Roster slot 1 of 8, the kart of the slot B racer. The displayed name must begin with the capital letter B. Weight class: heavy. Character: a long slab of a kart with a high top end and no interest in corners. Colour family: amber orange. Wheels are plain black rubber."}
{"id": "kart-2", "brief": "kind: kart. Roster slot 2 of 8, the kart of the slot C racer. The displayed name must begin with the capital letter C. Weight class: light. Character: a tiny darting frame that looks like it accelerates out of a corner faster than it enters one. Colour family: teal. Wheels are plain black rubber."}
{"id": "kart-3", "brief": "kind: kart. Roster slot 3 of 8, the kart of the slot D racer. The displayed name must begin with the capital letter D. Weight class: heavy. Character: a broad touring machine built for long straights, slightly softer-edged than the slot B kart. Colour family: deep blue. Wheels are plain black rubber."}
{"id": "kart-4", "brief": "kind: kart. Roster slot 4 of 8, the kart of the slot E racer. The displayed name must begin with the capital letter E. Weight class: light. Character: a nimble technical frame, narrow and low, built to change direction. Colour family: lime green. Wheels are plain black rubber."}
{"id": "kart-5", "brief": "kind: kart. Roster slot 5 of 8, the kart of the slot F racer. The displayed name must begin with the capital letter F. Weight class: heavy. Character: the biggest kart on the grid, wider and longer than every other, and it should look immovable. Colour family: violet. Wheels are plain black rubber."}
{"id": "kart-6", "brief": "kind: kart. Roster slot 6 of 8, the kart of the slot G racer. The displayed name must begin with the capital letter G. Weight class: light. Character: the smallest and lightest kart on the grid, barely more than a seat and four wheels. Colour family: white and pale cyan. Wheels are plain black rubber."}
{"id": "kart-7", "brief": "kind: kart. Roster slot 7 of 8, the kart of the slot H racer. The displayed name must begin with the capital letter H. Weight class: medium. Character: the second balanced kart, and it must not read as a recolour of the slot A kart. Colour family: magenta. Wheels are plain black rubber."}
{"id": "theme-caldera", "brief": "kind: theme. trackId: caldera - copy it exactly. The track is a 48-point loop inside a live volcanic caldera: tarmac with long dirt sections, corners banked to 20 degrees either way, elevation from -9 m to +9 m, road 15 to 19 m wide. Palette: black basalt tarmac, warm grey volcanic ash for the dirt, ground of cooled lava with a dull red glow in its cracks, smoke-heavy sky that is near-black overhead and hot orange at the horizon. Low evening sun, warm close fog, low ambient. There are no props, buildings or crowd anywhere in this game - the name describes the palette."}
{"id": "theme-dust-canyon", "brief": "kind: theme. trackId: dust-canyon - copy it exactly. The track is a dry desert canyon with a loose river bed cutting through it: about a fifth of the lap is dirt, road 15 to 20 m wide, elevation dropping 14 m into the canyon and climbing back. Palette: sun-bleached pale tarmac, red-brown river-bed dirt, sandstone walls, dusty scrub ground. Enormous hard sky, high sun, thin far-reaching haze rather than close fog, high ambient. There are no props, buildings or crowd anywhere in this game - the name describes the palette."}
{"id": "theme-glacier-pass", "brief": "kind: theme. trackId: glacier-pass - copy it exactly. The track is a wide all-tarmac run through an ice field, 21 to 26 m wide, banked one way only, elevation -9 m to +5 m. Palette: cold dark tarmac still wet from melt, blue-white packed snow on the ground, pale ice walls, an overcast sky that is bright and nearly colourless. High ambient, mid-distance fog, no strong sun colour. Edge markers must survive being seen against snow - do not make both of them pale. There are no props, buildings or crowd anywhere in this game - the name describes the palette."}
{"id": "theme-harbor-run", "brief": "kind: theme. trackId: harbor-run - copy it exactly. The track is a sunlit coastal harbour, all tarmac, 21 to 24 m wide, almost flat with one shallow bridge rise. Palette: warm grey harbour concrete, salt-bleached shoulder, painted steel barriers, deep blue-green harbour water as the ground. Bright midday sky, clean far visibility, high ambient. There are no props, buildings or crowd anywhere in this game - the name describes the palette."}
{"id": "theme-neon-district", "brief": "kind: theme. trackId: neon-district - copy it exactly. The track is a flat night city circuit, all tarmac, 18 to 22 m wide, no elevation change at all. Palette: wet black asphalt - the darkest surface on the track, around 0.02 - with the ground beyond it a cold blue-violet pavement roughly twice as bright as the road in the blue channel, so the edge of the drivable surface is still readable at night. Barriers lit by signage, a night sky that is deep blue-black above and a dirty magenta glow at the horizon. Accents are neon magenta and cyan. Low ambient, close fog, low sun. There are no props, buildings or crowd anywhere in this game - the name describes the palette."}
{"id": "theme-redwood-rise", "brief": "kind: theme. trackId: redwood-rise - copy it exactly. The track is a long forest climb, tarmac with dirt sections, 19 to 24 m wide, rising 22 m over the lap. Palette: damp dark tarmac under tree cover, red-brown needle-strewn dirt, deep green forest floor as the ground, warm bark-coloured barriers, and a sky mostly hidden by canopy - green-tinged and bright at the horizon where the light comes through. Mid ambient, mid fog. There are no props, buildings or crowd anywhere in this game - the name describes the palette."}
```

**3.4 — Dry-run first, always.**

```bash
deepseek-batch --jsonl content/pipeline/descriptors.jsonl --body-field brief --id-field id \
  --instruction @content/pipeline/descriptor-gen-instruction.md \
  --expect json --model deepseek-v4-pro --label descriptors-v1 --dry-run
```

Expected: 22 jobs listed, a token/cost estimate, and **no network call at all** — the
dry-run is fully offline, not even a balance check, and costs nothing. If it reports fewer
than 22 jobs, a JSONL line is malformed.

**3.5 — Run it.**

```bash
deepseek-batch --jsonl content/pipeline/descriptors.jsonl --body-field brief --id-field id \
  --instruction @content/pipeline/descriptor-gen-instruction.md \
  --expect json --model deepseek-v4-pro --label descriptors-v1 --max-spend 1.00 --json
```

Results land in `content/pipeline/descriptors.jsonl.results.jsonl`, one
`{id, ok, content, usage, error}` per line. Expect a few cents total.

**Expect the cache hit rate to look terrible on this run, and change nothing because of
it.** DeepSeek's prompt cache warms *across* runs, not within one: a byte-identical prefix
that has never been sent before comes back as almost all misses the first time — the track
pipeline in this same directory measured 15% on its first run and 95.5% on the next with
only the bodies changed. A low first-run rate is expected and is not a signal to reword
anything. A rate that stays low across repeated runs of the *same* instruction is the real
problem, and it means the instruction is varying between jobs — which here would mean
per-record text leaked out of `brief` and into the instruction file.

**3.6 — Gate with the real parsers.** Create `content/pipeline/gate-descriptors.mjs`:

```js
// Gate DeepSeek-generated descriptor and theme records with the REAL parsers from
// packages/content/src (bundled by esbuild in step 3.1, never reimplemented). A gate
// that re-implements validation tests the gate.
//
// Two layers, and the second is the one a parser cannot do: per-record shape and range
// via parseCharacterDescriptor / parseKartDescriptor / parseTrackTheme, then roster-wide
// rules — uniqueness, ordering, slot agreement, and the legibility thresholds — which
// need all 22 records at once.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'

import {
  parseCharacterDescriptor,
  parseKartDescriptor,
  parseTrackTheme,
} from './content-bundle.mjs'

const resultsPath = process.argv[2] ?? 'content/pipeline/descriptors.jsonl.results.jsonl'
const outDir = 'content/pipeline/records-out'
mkdirSync(outDir, { recursive: true })

const LETTERS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
const WEIGHTS = [1.0, 1.2, 0.85, 1.1, 0.9, 1.3, 0.8, 1.0] // CHARACTERS[i].weight, §3a.2
const TRACK_IDS = [
  'caldera',
  'dust-canyon',
  'glacier-pass',
  'harbor-run',
  'neon-district',
  'redwood-rise',
]

// The same thresholds packages/content/test/roster.test.ts asserts on the committed files.
const MIN_MARKER_PAIR = 0.25
const MIN_MARKER_SURFACE = 0.2
const MIN_ROAD_GROUND = 0.1
const MIN_KART_SEPARATION = 0.15
const MIN_THEME_SEPARATION = 0.1

const silhouetteFor = (w) => (w >= 1.1 ? 'wide' : w <= 0.9 ? 'compact' : 'tall')

/** Linear light crushes dark colours together; the sqrt stands in for the display
 *  transfer function, so "different" means what the eye would call different. */
const visualDistance = (a, b) =>
  Math.hypot(
    Math.sqrt(a[0]) - Math.sqrt(b[0]),
    Math.sqrt(a[1]) - Math.sqrt(b[1]),
    Math.sqrt(a[2]) - Math.sqrt(b[2]),
  )

const slugOf = (name) =>
  name
    .toLowerCase()
    .replace(/['’.]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

const fail = []
const records = new Map()

const lines = readFileSync(resultsPath, 'utf8').trim().split('\n').filter(Boolean)
for (const line of lines) {
  const res = JSON.parse(line)
  if (!res.ok) {
    fail.push(`${res.id}: API ERROR: ${res.error}`)
    continue
  }
  let obj
  try {
    obj = JSON.parse(res.content)
  } catch (e) {
    fail.push(`${res.id}: NOT JSON: ${e.message}`)
    continue
  }
  try {
    if (res.id.startsWith('character-')) records.set(res.id, parseCharacterDescriptor(obj))
    else if (res.id.startsWith('kart-')) records.set(res.id, parseKartDescriptor(obj))
    else if (res.id.startsWith('theme-')) records.set(res.id, parseTrackTheme(obj))
    else fail.push(`${res.id}: not a character-, kart- or theme- record id`)
  } catch (e) {
    fail.push(`${res.id}: ${e.message}`)
  }
}

// ---- roster rules: what no single-record parser can see -----------------------------
const characters = []
const karts = []
for (let i = 0; i < 8; i++) {
  const c = records.get(`character-${i}`)
  const k = records.get(`kart-${i}`)
  if (!c) fail.push(`character-${i}: missing from the results`)
  if (!k) fail.push(`kart-${i}: missing from the results`)
  if (!c || !k) continue
  characters.push(c)
  karts.push(k)

  const want = silhouetteFor(WEIGHTS[i])
  if (c.silhouette !== want) {
    fail.push(`character-${i}: silhouette '${c.silhouette}' but weight ${WEIGHTS[i]} means '${want}'`)
  }
  if (want === 'wide' && !(c.bodyRadius >= 0.38)) {
    fail.push(`character-${i}: wide needs bodyRadius >= 0.38, got ${c.bodyRadius}`)
  }
  if (want === 'tall' && !(c.bodyHeight >= 1.0)) {
    fail.push(`character-${i}: tall needs bodyHeight >= 1.00, got ${c.bodyHeight}`)
  }
  if (want === 'compact' && !(c.bodyHeight <= 0.95)) {
    fail.push(`character-${i}: compact needs bodyHeight <= 0.95, got ${c.bodyHeight}`)
  }
  if (WEIGHTS[i] >= 1.1 && !(k.chassisWidth >= 1.35 && k.chassisLength >= 2.1)) {
    fail.push(`kart-${i}: heavy needs width >= 1.35 and length >= 2.10, got ${k.chassisWidth} / ${k.chassisLength}`)
  }
  if (WEIGHTS[i] <= 0.9 && !(k.chassisWidth <= 1.15 && k.chassisLength <= 1.9)) {
    fail.push(`kart-${i}: light needs width <= 1.15 and length <= 1.90, got ${k.chassisWidth} / ${k.chassisLength}`)
  }
  for (const [kind, r] of [['character', c], ['kart', k]]) {
    if (!r.id.startsWith(LETTERS[i])) {
      fail.push(`${kind}-${i}: id '${r.id}' does not start with '${LETTERS[i]}' — slot order and id order must agree`)
    }
    if (slugOf(r.name) !== r.id) {
      fail.push(`${kind}-${i}: id '${r.id}' is not the slug of name '${r.name}'`)
    }
    if (r.name.length < 3 || r.name.length > 18) {
      fail.push(`${kind}-${i}: name '${r.name}' must be 3-18 characters`)
    }
  }
}

for (const [label, list] of [['character', characters], ['kart', karts]]) {
  const ids = list.map((r) => r.id)
  if (new Set(ids).size !== ids.length) fail.push(`${label} ids are not unique: ${ids.join(', ')}`)
  if (ids.join('\0') !== [...ids].sort().join('\0')) {
    fail.push(`${label} ids are not in ascending order: ${ids.join(', ')}`)
  }
}

for (let i = 0; i < karts.length; i++) {
  for (let j = i + 1; j < karts.length; j++) {
    const d = visualDistance(karts[i].palette.body, karts[j].palette.body)
    if (d < MIN_KART_SEPARATION) {
      fail.push(`kart-${i} and kart-${j}: body colours are ${d.toFixed(3)} apart, need ${MIN_KART_SEPARATION}`)
    }
  }
}

const themes = []
for (const tid of TRACK_IDS) {
  const t = records.get(`theme-${tid}`)
  if (!t) {
    fail.push(`theme-${tid}: missing from the results`)
    continue
  }
  themes.push(t)
  if (t.trackId !== tid) fail.push(`theme-${tid}: trackId is '${t.trackId}'`)
  const [a, b] = t.edgeMarkers.colors
  if (visualDistance(a, b) < MIN_MARKER_PAIR) {
    fail.push(`theme-${tid}: the two marker colours are too alike (${visualDistance(a, b).toFixed(3)})`)
  }
  for (const [name, surface] of [['road', t.road], ['ground', t.ground]]) {
    for (const c of [a, b]) {
      if (visualDistance(c, surface) < MIN_MARKER_SURFACE) {
        fail.push(`theme-${tid}: a marker colour vanishes into ${name} (${visualDistance(c, surface).toFixed(3)})`)
      }
    }
  }
  if (visualDistance(t.road, t.ground) < MIN_ROAD_GROUND) {
    fail.push(`theme-${tid}: road and ground are the same colour (${visualDistance(t.road, t.ground).toFixed(3)})`)
  }
}

for (let i = 0; i < themes.length; i++) {
  for (let j = i + 1; j < themes.length; j++) {
    const d = Math.hypot(
      visualDistance(themes[i].road, themes[j].road),
      visualDistance(themes[i].ground, themes[j].ground),
      visualDistance(themes[i].sky.top, themes[j].sky.top),
    )
    if (d < MIN_THEME_SEPARATION) {
      fail.push(`${themes[i].trackId} and ${themes[j].trackId}: the palettes are ${d.toFixed(3)} apart`)
    }
  }
}

// ---- the review table, and staging ---------------------------------------------------
const rgb = (c) => `[${c.map((v) => v.toFixed(2)).join(' ')}]`

console.log('\nCHARACTERS')
for (let i = 0; i < 8; i++) {
  const c = records.get(`character-${i}`)
  if (!c) continue
  console.log(
    `  ${i}  ${c.id.padEnd(20)} ${c.name.padEnd(18)} ${c.silhouette.padEnd(8)} ` +
      `h=${c.bodyHeight} r=${c.bodyRadius} head=${c.headRadius}  ${rgb(c.palette.primary)}`,
  )
}
console.log('\nKARTS')
for (let i = 0; i < 8; i++) {
  const k = records.get(`kart-${i}`)
  if (!k) continue
  console.log(
    `  ${i}  ${k.id.padEnd(20)} ${k.name.padEnd(18)} ` +
      `L=${k.chassisLength} W=${k.chassisWidth} H=${k.chassisHeight}  body=${rgb(k.palette.body)}`,
  )
}
console.log('\nTHEMES')
for (const tid of TRACK_IDS) {
  const t = records.get(`theme-${tid}`)
  if (!t) continue
  console.log(
    `  ${t.trackId.padEnd(15)} road=${rgb(t.road)} ground=${rgb(t.ground)} ` +
      `sky=${rgb(t.sky.top)} amb=${t.ambient} fog=${t.fog.near}-${t.fog.far} ` +
      `posts@${t.edgeMarkers.spacing}m ${rgb(t.edgeMarkers.colors[0])}/${rgb(t.edgeMarkers.colors[1])}`,
  )
}

for (const [id, record] of records) {
  writeFileSync(`${outDir}/${id}.json`, JSON.stringify(record, null, 2) + '\n')
}

if (fail.length > 0) {
  console.log(`\n${fail.length} PROBLEM(S):`)
  for (const f of fail) console.log(`  - ${f}`)
  console.log(`\n${records.size} of 22 records parsed; nothing is shipped until this is clean.`)
  process.exitCode = 1
} else {
  console.log(`\n22 records valid — staged in ${outDir}/`)
}
```

Run it:

```bash
node content/pipeline/gate-descriptors.mjs
```

Expected: the three review tables, then `22 records valid — staged in
content/pipeline/records-out/`, exit 0. **Anything else means regenerating, not editing the
thresholds.** To regenerate only the records that failed, copy their lines into
`content/pipeline/descriptors-fix.jsonl` and re-run step 3.5 against that file with the
**byte-identical** instruction — same file, unedited — which is the run where the cache
pays off.

**3.7 — Review, which is a human step and the reason this is delegable at all.** The gate
proves every record is *valid*; it cannot say whether the content is any good. Read all 22
files in `content/pipeline/records-out/` — they are ~20 lines each, about 450 lines total,
which is the whole reason a 22-record batch is worth reviewing rather than writing — and
check the five things no gate can:

1. **Names.** Pronounceable, spellable, not a real or historical person, not a brand or a
   franchise character, no unfortunate reading in any obvious language, and a plausible fit
   for the archetype in the brief. This is the check that most needs a human.
2. **A racer and their kart read as one entry.** `character-3` and `kart-3` share a colour
   family and a weight; if the racer is violet and the kart is orange, the select screen
   lies about the pairing.
3. **Palettes look like linear values, not sRGB pasted in.** A "black asphalt" road at
   0.25 is an sRGB number in a linear field, and it will render as light grey. Dark surfaces
   belong at 0.02–0.08.
4. **Each theme reads as its track.** `glacier-pass` is not warm; `neon-district` is not
   bright; `caldera` is not green. And the three scenery-named tracks stay scenery-free —
   Q20 ships a ribbon, a ground plane and edge markers, so the *name* is carried entirely by
   the palette.
5. **Proportions are not comic.** Everything in range can still be a 0.4 m tall racer on a
   2.6 m kart.

Fix by regenerating the record — adjust its `brief`, never the instruction — or, for a
single number a human can obviously do better (a fog distance, one palette component), edit
the staged file and re-run the gate. Do not edit a file after it is placed in Step 3.8
without re-running the gate.

**3.8 — Place the files and document the pipeline.**

```bash
mkdir -p content/characters content/karts content/themes
for i in 0 1 2 3 4 5 6 7; do
  cp content/pipeline/records-out/character-$i.json content/characters/character-$i.json
  cp content/pipeline/records-out/kart-$i.json       content/karts/kart-$i.json
done
for t in caldera dust-canyon glacier-pass harbor-run neon-district redwood-rise; do
  cp content/pipeline/records-out/theme-$t.json content/themes/$t.json
done
ls content/characters content/karts content/themes
```

Expected: 8, 8 and 6 files. Note the rename: `theme-caldera.json` ships as
`content/themes/caldera.json`, because a theme's filename is its `trackId` and that is the
key `loadContentBundle` uses.

Then append to `content/pipeline/README.md`:

```markdown
## Descriptor and theme content

The 8 character descriptors, 8 kart descriptors and 6 track themes are generated the same
way the tracks were, with the same rule: **the gate is bundled from the real shipped code,
never rewritten.**

    npx esbuild content/pipeline/content-entry.ts --bundle --format=esm --platform=node \
      --outfile=content/pipeline/content-bundle.mjs
    deepseek-batch --jsonl content/pipeline/descriptors.jsonl --body-field brief --id-field id \
                   --instruction @content/pipeline/descriptor-gen-instruction.md \
                   --expect json --model deepseek-v4-pro --dry-run    # always dry-run first
    deepseek-batch ...                                                # drop --dry-run
    node content/pipeline/gate-descriptors.mjs                        # real parsers + roster rules

`content-bundle.mjs` is `packages/content/src/descriptors.ts` and `theme.ts` bundled by
esbuild, so a generated record is judged by the code the game runs. The gate adds the layer
a per-record parser cannot: id uniqueness, slot-letter ordering, silhouette-vs-weight
agreement, kart colour separation and edge-marker legibility — all of which need the whole
roster at once. `packages/content/test/roster.test.ts` re-asserts every one of them against
the committed files, so the invariants survive a hand edit.

Keep `descriptor-gen-instruction.md` **byte-identical** across runs; per-record detail goes
in the JSONL body. Balance is not generated: the eight stat rows come from `makeCharacters()`
via `CHARACTERS`, and the briefs hand a slot's stats to the model as input so the appearance
matches the handling.
```

Finally, do **not** commit the working files — the track pipeline left none of its own
bundles in the repository either. Append to `.gitignore` (which today is only
`node_modules/`, `dist/`, `.env`, `*.local`):

```gitignore
content/pipeline/content-bundle.mjs
content/pipeline/records-out/
content/pipeline/*.results.jsonl
```

The four authored pipeline files and the 22 records are what ship.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/content/test/roster.test.ts`

Expected: PASS — 13 passed (2 `shipped roster files` + 3 `roster ordering` + 4
`appearance agrees with the handling each slot is fixed to` + 4 `themes`).

Then confirm nothing else in the package regressed:

Run: `npx tsc --noEmit -p packages/content && npx vitest run packages/content`

Expected: no TypeScript output; every `packages/content` test green.

- [ ] **Step 5: Commit**

```bash
git add content/pipeline/content-entry.ts content/pipeline/descriptor-gen-instruction.md \
        content/pipeline/descriptors.jsonl content/pipeline/gate-descriptors.mjs \
        content/pipeline/README.md content/characters content/karts content/themes \
        packages/content/test/roster.test.ts .gitignore
git commit -m "feat(content): 8 character, 8 kart and 6 theme records, gated by the real parsers"
```

---

### Task 6: `packages/content/src/tracks.ts`, `bundle.ts` and the barrel

Contract §3a.1, §3a.5, §3a.6, §3a.7. This task makes `@tapkart/content` loadable: the six
shipped tracks, the descriptor/theme bundle, and the barrel three other packages import
through.

**Ruling Q12, and what R46 changed about it.** The shipped content is **bundled, not
fetched**, and `loadTrack(id)` is **synchronous and total**. Fetching six files that ship
with the app and never change at runtime buys a loading state, a failure path and a race,
in exchange for nothing; bundling them deletes an entire error branch from every screen
that touches a track. Q12 said `import.meta.glob`; R46 replaced the *mechanism* only.
`import.meta.glob` is a Vite transform, and Plan 4's `packages/server` imports this package
under plain Node/tsx (spec §9), where it is not a function, is not polyfillable, and fails
at runtime rather than at build. So `content` uses **28 explicit static JSON imports** —
22 here in `bundle.ts`, 6 here in `tracks.ts` — in the form

```ts
import calderaJson from '../../../content/tracks/caldera.json' with { type: 'json' }
```

which works unflagged in Node ESM, in Vite, in vitest and in esbuild/tsx. **Verified on this
repository's own floor**: Node v20.20.2 imports it, vitest 3.2.7 transforms it, and
TypeScript 5.9.3 type-checks it under `tsconfig.base.json` plus `resolveJsonModule`.

The cost of static imports is that a seventh track means one import line and one table
entry rather than a file drop. That is the right trade for a fixed v1 content set, **and it
is only safe because a test compares `TRACK_MANIFEST` against the real `content/tracks/`
directory listing** (§8.1's `loadTrack / TRACK_MANIFEST` row). Without that test a forgotten
import line silently ships five tracks and a menu that never mentions the sixth.

**Files:**
- Create: `packages/content/src/bundle.ts`
- Create: `packages/content/src/tracks.ts`
- Create: `packages/content/src/index.ts`
- Verify (created by Task 1, not edited here): `packages/content/tsconfig.json` — see Step 3
- Test: `packages/content/test/bundle.test.ts`
- Test: `packages/content/test/tracks.test.ts`
- Test: `packages/content/test/barrel.test.ts`

**Ordering — this task runs after Task 5, not before it.** `bundle.ts` statically imports 22
files that **Task 5 generates**:

```
content/characters/character-0.json … character-7.json      (8)
content/karts/kart-0.json … kart-7.json                     (8)
content/themes/{caldera,dust-canyon,glacier-pass,harbor-run,neon-district,redwood-rise}.json  (6)
```

If those files are not on disk, Step 4 fails with
`Cannot find module '../../../content/characters/character-0.json'` and the fix is to run
Task 5, not to edit this file. The six track files (`content/tracks/*.json`) already exist
in the repository and are not generated by anything in Plan 3.

**Interfaces:**

- Consumes (from `@tapkart/sim`, contract §2.1 and §2.2 — the only cross-package import in
  this package):
  - `type Vec3 = { x: number; y: number; z: number }`
  - `type Surface = 'tarmac' | 'dirt' | 'boost' | 'offtrack'`
  - `interface TrackPoint { position: Vec3; width: number; banking: number; surface: Surface }`
  - `interface Track { id: string; name: string; controlPoints: TrackPoint[]; checkpointS: number[]; itemBoxes: { s: number; lateral: number }[]; ramps: { sStart: number; sEnd: number; launch: number }[]; boostPads: { s: number; lateral: number; halfWidth: number }[]; startPositions: { s: number; lateral: number }[]; bounds: { min: Vec3; max: Vec3 } }`
  - `interface TrackQuery { sampleAt(s: number): TrackPoint; tangentAt(s: number): Vec3; project(p: Vec3): TrackProjection; groundHeight(s: number, lateral: number): number; surfaceAt(s: number, lateral: number): Surface; isInBounds(s: number, lateral: number): boolean; checkpointIndexAt(s: number): number; totalLength(): number }`
  - `function buildTrackQuery(track: Track): TrackQuery`
  - `function validateTrack(track: Track): string[]` — `[]` when valid
- Consumes (from **Task 2**, `packages/content/src/tuning.ts`, contract §3a.2 — named only
  by the barrel test):
  - `const TUNING: Readonly<Tuning>`
  - `const CHARACTERS: readonly CharacterStats[]`
- Consumes (from **Task 3**, `packages/content/src/descriptors.ts`, contract §3a.3):
  - `type PaletteRGB = readonly [number, number, number]`
  - `interface CharacterDescriptor { id: string; name: string; bodyHeight: number; bodyRadius: number; headRadius: number; palette: { primary: PaletteRGB; secondary: PaletteRGB; accent: PaletteRGB }; silhouette: 'compact' | 'tall' | 'wide' }`
  - `interface KartDescriptor { id: string; name: string; chassisLength: number; chassisWidth: number; chassisHeight: number; wheelRadius: number; wheelWidth: number; palette: { body: PaletteRGB; trim: PaletteRGB; wheel: PaletteRGB } }`
  - `function parseCharacterDescriptor(json: unknown): CharacterDescriptor`
  - `function parseKartDescriptor(json: unknown): KartDescriptor`
- Consumes (from **Task 4**, `packages/content/src/theme.ts`, contract §3a.4):
  - `interface EdgeMarkerParams { spacing: number; height: number; offset: number; colors: readonly [PaletteRGB, PaletteRGB] }`
  - `interface TrackTheme { trackId: string; road: PaletteRGB; roadDirt: PaletteRGB; shoulder: PaletteRGB; wall: PaletteRGB; ground: PaletteRGB; sky: { top: PaletteRGB; bottom: PaletteRGB }; fog: { color: PaletteRGB; near: number; far: number }; sunDirection: Vec3; ambient: number; edgeMarkers: EdgeMarkerParams }`
  - `const DEFAULT_TRACK_THEME: Readonly<TrackTheme>`
  - `function parseTrackTheme(json: unknown): TrackTheme`
- Consumes (from **Task 5**): the 22 JSON files listed above.
- Produces (`packages/content/src/bundle.ts`):
  - `interface ContentBundle { characters: readonly CharacterDescriptor[]; karts: readonly KartDescriptor[]; themes: Readonly<Record<string, TrackTheme>> }`
  - `function loadContentBundle(): ContentBundle`
- Produces (`packages/content/src/tracks.ts`):
  - `interface TrackManifestEntry { id: string; name: string }`
  - `const TRACK_MANIFEST: readonly TrackManifestEntry[]`
  - `function parseTrack(json: unknown): Track`
  - `interface LoadedTrack { track: Track; query: TrackQuery; theme: TrackTheme }`
  - `function loadTrack(id: string): LoadedTrack`
- Produces (`packages/content/src/index.ts`): the barrel — five `export *` lines and no
  declarations of its own. Contract §11's census: 2 + 5 + 4 + 5 + 2 = **18** exported
  symbols in the package, and the barrel adds none.

**Do not add a shared parse-helper module.** `descriptors.ts`, `theme.ts` and `tracks.ts`
each carry their own module-private `isRecord` / `show` / field helpers. Contract §11 fixes
this package at five modules; a sixth that three tasks share is an amendment, not a local
definition.

**`parseTrack` shape-checks; `validateTrack` owns the rules.** This file checks *types and
structure* — is `controlPoints` an array of objects with a `position`, a finite `width`, a
finite `banking` and a known `surface` — and then hands the assembled `Track` to `sim`'s
real `validateTrack` for every *range and rule*: `s` in `[0,1)`, ascending checkpoints,
start-grid clearance, bounds enclosure. There is no second copy of those rules anywhere in
`content`, for the same reason Task 5's gate bundles the real parsers rather than
reimplementing them.

---

- [ ] **Step 1: Write the failing test for the bundle**

Create `packages/content/test/bundle.test.ts`:

```ts
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { loadContentBundle } from '../src/bundle'

const SRC = fileURLToPath(new URL('../src/', import.meta.url))

function countJsonImports(file: string): number {
  const text = readFileSync(SRC + file, 'utf8')
  return text.split("with { type: 'json' }").length - 1
}

describe('loadContentBundle', () => {
  it('loads 8 characters, 8 karts and 6 themes', () => {
    const bundle = loadContentBundle()
    expect(bundle.characters).toHaveLength(8)
    expect(bundle.karts).toHaveLength(8)
    expect(Object.keys(bundle.themes)).toHaveLength(6)
  })

  it('memoises, so the 22 records are parsed once per process', () => {
    // Not a micro-optimisation: every screen calls this, and a non-memoised version
    // re-parses 22 records per call while handing out a different object identity each
    // time, which quietly breaks any `===` a caller does on a descriptor.
    expect(loadContentBundle()).toBe(loadContentBundle())
    expect(loadContentBundle().characters).toBe(loadContentBundle().characters)
  })

  it('orders characters and karts by id ascending, which IS the index order', () => {
    // Contract §3a.6: the arrays are ordered by `id` ascending, and index — not id — is
    // the join to CharacterStats (§3a.3). If a record lands in the wrong slot, the array
    // stops being sorted, and this is the assertion that says so. Without it, character
    // 5 races with character 2's handling and nothing in the suite notices.
    const bundle = loadContentBundle()
    const characterIds = bundle.characters.map((c) => c.id)
    const kartIds = bundle.karts.map((k) => k.id)

    expect(characterIds).toEqual([...characterIds].sort())
    expect(kartIds).toEqual([...kartIds].sort())
    expect(new Set(characterIds).size).toBe(8)
    expect(new Set(kartIds).size).toBe(8)
    for (const id of [...characterIds, ...kartIds]) {
      expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
    }
  })

  it('keys themes by their own trackId', () => {
    const bundle = loadContentBundle()
    for (const [key, theme] of Object.entries(bundle.themes)) {
      expect(theme.trackId).toBe(key)
    }
  })

  it('returns descriptors with exactly the schema keys and nothing else', () => {
    // Proves the records came out of the parsers rather than being cast through: a cast
    // would carry any stray key in the JSON file straight into the game.
    const bundle = loadContentBundle()
    expect(Object.keys(bundle.characters[0]).sort()).toEqual([
      'bodyHeight',
      'bodyRadius',
      'headRadius',
      'id',
      'name',
      'palette',
      'silhouette',
    ])
    expect(Object.keys(bundle.karts[0]).sort()).toEqual([
      'chassisHeight',
      'chassisLength',
      'chassisWidth',
      'id',
      'name',
      'palette',
      'wheelRadius',
      'wheelWidth',
    ])
  })

  it('reaches its JSON by static import — 22 here, 6 in tracks.ts, 28 in total', () => {
    // Contract §3a.1. `import.meta.glob` is a Vite transform and `packages/server`
    // (Plan 4) imports this package under plain Node, where it is not a function and
    // fails at runtime rather than at build. This test is what stops a later "tidy-up"
    // from collapsing 28 import lines back into one glob.
    expect(countJsonImports('bundle.ts')).toBe(22)
    expect(countJsonImports('tracks.ts')).toBe(6)
    expect(readFileSync(SRC + 'bundle.ts', 'utf8')).not.toContain('import.meta')
    expect(readFileSync(SRC + 'tracks.ts', 'utf8')).not.toContain('import.meta')
  })
})
```

- [ ] **Step 2: Run the bundle test to verify it fails**

Run: `npx vitest run packages/content/test/bundle.test.ts`

Expected: FAIL — the file fails to collect, with
`Error: Cannot find module '../src/bundle' imported from '<repo>/packages/content/test/bundle.test.ts'`.

- [ ] **Step 3: Write the bundle, after checking `resolveJsonModule` is in place**

First confirm `packages/content/tsconfig.json` still reads exactly this — Task 1 created it
and Task 1's `scaffold.test.ts` asserts it, so this is a check, not an edit. If it differs,
the fix belongs in whatever changed it:

```jsonc
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "resolveJsonModule": true },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

**No DOM lib**, ever, in this package: `server` imports it, and a DOM type here is how a
server-side package acquires a browser dependency. `resolveJsonModule` is what makes the
static JSON imports type-check, and **no other package in the repository needs it** —
`tsconfig.base.json` is untouched. (TypeScript 5.9 turns `resolveJsonModule` on implicitly
under `moduleResolution: "Bundler"`, which the base sets, so omitting it happens to work
today; it is pinned because it stops being implicit the moment anything type-checks this
package under `NodeNext`, and Plan 4's server is exactly that risk.)

Then create `packages/content/src/bundle.ts`:

```ts
// PURE (contract §0a). Everything a race needs from shipped content in one struct
// (§3a.6): the eight character descriptors, the eight kart descriptors, and the six
// per-track themes.
//
// §3a.1: the JSON arrives by explicit static import — 22 lines below — because a
// bundler glob is a Vite-only transform and `packages/server` (Plan 4) imports this
// package under plain Node. Every record is parsed through the real parsers on first
// call, so a malformed shipped file throws at startup, loudly, rather than producing a
// half-populated bundle.
//
// Nothing in this file may name the import-meta object: bundle.test.ts asserts the
// source text never contains it, which is what stops a later tidy-up from reintroducing
// the glob — or a dev-only bundler branch — into a module the server loads.
//
// The array order below IS `characterIdx` order, and it is also `id`-ascending order —
// bundle.test.ts asserts the second, because the first cannot be asserted (nothing else
// knows which slot a record was meant for) and the two agree by construction of the
// content (Task 5).
import type { CharacterDescriptor, KartDescriptor } from './descriptors'
import { parseCharacterDescriptor, parseKartDescriptor } from './descriptors'
import type { TrackTheme } from './theme'
import { parseTrackTheme } from './theme'

import character0Json from '../../../content/characters/character-0.json' with { type: 'json' }
import character1Json from '../../../content/characters/character-1.json' with { type: 'json' }
import character2Json from '../../../content/characters/character-2.json' with { type: 'json' }
import character3Json from '../../../content/characters/character-3.json' with { type: 'json' }
import character4Json from '../../../content/characters/character-4.json' with { type: 'json' }
import character5Json from '../../../content/characters/character-5.json' with { type: 'json' }
import character6Json from '../../../content/characters/character-6.json' with { type: 'json' }
import character7Json from '../../../content/characters/character-7.json' with { type: 'json' }

import kart0Json from '../../../content/karts/kart-0.json' with { type: 'json' }
import kart1Json from '../../../content/karts/kart-1.json' with { type: 'json' }
import kart2Json from '../../../content/karts/kart-2.json' with { type: 'json' }
import kart3Json from '../../../content/karts/kart-3.json' with { type: 'json' }
import kart4Json from '../../../content/karts/kart-4.json' with { type: 'json' }
import kart5Json from '../../../content/karts/kart-5.json' with { type: 'json' }
import kart6Json from '../../../content/karts/kart-6.json' with { type: 'json' }
import kart7Json from '../../../content/karts/kart-7.json' with { type: 'json' }

import calderaThemeJson from '../../../content/themes/caldera.json' with { type: 'json' }
import dustCanyonThemeJson from '../../../content/themes/dust-canyon.json' with { type: 'json' }
import glacierPassThemeJson from '../../../content/themes/glacier-pass.json' with { type: 'json' }
import harborRunThemeJson from '../../../content/themes/harbor-run.json' with { type: 'json' }
import neonDistrictThemeJson from '../../../content/themes/neon-district.json' with { type: 'json' }
import redwoodRiseThemeJson from '../../../content/themes/redwood-rise.json' with { type: 'json' }

export interface ContentBundle {
  characters: readonly CharacterDescriptor[] // length 8, index === characterIdx
  karts: readonly KartDescriptor[] // length 8, same index space
  themes: Readonly<Record<string, TrackTheme>> // keyed by track id
}

const CHARACTER_JSON: readonly unknown[] = [
  character0Json,
  character1Json,
  character2Json,
  character3Json,
  character4Json,
  character5Json,
  character6Json,
  character7Json,
]

const KART_JSON: readonly unknown[] = [
  kart0Json,
  kart1Json,
  kart2Json,
  kart3Json,
  kart4Json,
  kart5Json,
  kart6Json,
  kart7Json,
]

const THEME_JSON: readonly unknown[] = [
  calderaThemeJson,
  dustCanyonThemeJson,
  glacierPassThemeJson,
  harborRunThemeJson,
  neonDistrictThemeJson,
  redwoodRiseThemeJson,
]

/** Immutable shipped content, parsed once. Not per-race state: nothing a session owns
 *  is cached here, so this is not the module-scope hold that made `step` non-instanceable
 *  in Plan 1. */
let cached: ContentBundle | null = null

/** Parses every bundled descriptor and theme through §3a.3/§3a.4's parsers on
 *  first call and memoises. A malformed shipped file therefore throws at startup,
 *  loudly, rather than producing a half-populated bundle. */
export function loadContentBundle(): ContentBundle {
  if (cached !== null) return cached

  const characters: CharacterDescriptor[] = []
  for (let i = 0; i < CHARACTER_JSON.length; i++) {
    try {
      characters.push(parseCharacterDescriptor(CHARACTER_JSON[i]))
    } catch (e) {
      throw new Error(`loadContentBundle: content/characters/character-${i}.json: ${(e as Error).message}`)
    }
  }

  const karts: KartDescriptor[] = []
  for (let i = 0; i < KART_JSON.length; i++) {
    try {
      karts.push(parseKartDescriptor(KART_JSON[i]))
    } catch (e) {
      throw new Error(`loadContentBundle: content/karts/kart-${i}.json: ${(e as Error).message}`)
    }
  }

  const themes: Record<string, TrackTheme> = {}
  for (const json of THEME_JSON) {
    const theme = parseTrackTheme(json)
    if (Object.prototype.hasOwnProperty.call(themes, theme.trackId)) {
      throw new Error(`loadContentBundle: two shipped themes claim trackId '${theme.trackId}'`)
    }
    themes[theme.trackId] = theme
  }

  cached = { characters, karts, themes }
  return cached
}
```

The `try`/`catch` wrappers exist for one reason: the parsers name the *field*, and the
wrapper names the *file*. "`bodyRadius: must be within 0.15..0.5, got 0.8`" without a
filename is a five-minute hunt across sixteen records.

- [ ] **Step 4: Run the bundle test to verify it passes**

Run: `npx vitest run packages/content/test/bundle.test.ts`

Expected: PASS — 6 passed.

If it fails with `Cannot find module '../../../content/characters/character-0.json'`, Task 5
has not landed its records yet. That is an ordering failure; run Task 5 and come back.

- [ ] **Step 5: Write the failing test for track loading**

Create `packages/content/test/tracks.test.ts`:

```ts
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { DEFAULT_TRACK_THEME } from '../src/theme'
import { TRACK_MANIFEST, loadTrack, parseTrack } from '../src/tracks'

/** Q34: tests read the real shipped files off disk with node:fs. `src` never does —
 *  it reaches them through §3a.1's static imports — and that difference is what makes
 *  these assertions evidence about shipped content rather than about a bundler. */
const TRACKS_DIR = fileURLToPath(new URL('../../../content/tracks/', import.meta.url))

function idsOnDisk(): string[] {
  return readdirSync(TRACKS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -5))
    .sort()
}

function readTrackFile(id: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(TRACKS_DIR, `${id}.json`), 'utf8')) as Record<string, unknown>
}

describe('TRACK_MANIFEST', () => {
  it('names exactly the files in content/tracks/', () => {
    // THE test for §3a.1's one weakness. A forgotten static import line compiles, runs,
    // and ships five tracks; this is the only thing in the repository that notices.
    expect(TRACK_MANIFEST.map((e) => e.id)).toEqual(idsOnDisk())
    expect(TRACK_MANIFEST).toHaveLength(6)
  })

  it('is in menu order, which is id ascending', () => {
    const ids = TRACK_MANIFEST.map((e) => e.id)
    expect(ids).toEqual([
      'caldera',
      'dust-canyon',
      'glacier-pass',
      'harbor-run',
      'neon-district',
      'redwood-rise',
    ])
  })

  it('takes each name from the file itself, never from a hand-written table', () => {
    for (const entry of TRACK_MANIFEST) {
      expect(entry.name).toBe(readTrackFile(entry.id)['name'])
    }
  })
})

describe('loadTrack', () => {
  it('loads all six and reproduces each file exactly', () => {
    // Catches a parser that drops or renames a field — `banking` is the one that would
    // hurt most, and losing it is invisible until a mesh test on caldera fails.
    for (const entry of TRACK_MANIFEST) {
      expect(loadTrack(entry.id).track).toEqual(readTrackFile(entry.id))
    }
  })

  it('builds a usable TrackQuery for each', () => {
    for (const entry of TRACK_MANIFEST) {
      const { query } = loadTrack(entry.id)
      expect(query.totalLength()).toBeGreaterThan(100)
      expect(Number.isFinite(query.groundHeight(0, 0))).toBe(true)
      expect(query.checkpointIndexAt(0)).toBeGreaterThanOrEqual(0)
    }
  })

  it('memoises, so the arc table is built once per track per process', () => {
    const a = loadTrack('caldera')
    const b = loadTrack('caldera')
    expect(a).toBe(b)
    expect(a.query).toBe(b.query)
  })

  it('resolves each track to its own theme, not to the grey fallback', () => {
    // The bug this catches: themes keyed by anything other than trackId — a filename
    // stem, an index — collapses every lookup to DEFAULT_TRACK_THEME, and the game
    // ships six identical grey tracks with a suite that is entirely green.
    for (const entry of TRACK_MANIFEST) {
      const { theme } = loadTrack(entry.id)
      expect(theme.trackId).toBe(entry.id)
      expect(theme).not.toBe(DEFAULT_TRACK_THEME)
    }
  })

  it('throws on an unknown id, naming it', () => {
    expect(() => loadTrack('atlantis')).toThrow("loadTrack: unknown track id 'atlantis'")
  })
})

/**
 * One case per shape the parser must reject. A parser that casts its argument accepts
 * every one of these, so this table is what makes `parseTrack` more than a type
 * assertion. `mutate` edits a fresh copy of the real caldera file, so each case starts
 * from shipped, valid data and changes exactly one thing.
 */
const REJECTIONS: ReadonlyArray<{
  what: string
  mutate: (t: Record<string, unknown>) => void
  expected: string
}> = [
  { what: 'id missing', mutate: (t) => { t['id'] = undefined }, expected: 'id: must be a non-empty string, got undefined' },
  { what: 'name not a string', mutate: (t) => { t['name'] = 7 }, expected: 'name: must be a non-empty string, got 7' },
  { what: 'controlPoints missing', mutate: (t) => { t['controlPoints'] = undefined }, expected: 'controlPoints: must be an array, got undefined' },
  {
    what: 'controlPoints[0] not an object',
    mutate: (t) => { (t['controlPoints'] as unknown[])[0] = 3 },
    expected: 'controlPoints[0]: must be an object, got 3',
  },
  {
    what: 'controlPoints[0].width not a number',
    mutate: (t) => { (t['controlPoints'] as Record<string, unknown>[])[0]['width'] = 'wide' },
    expected: 'controlPoints[0].width: must be a finite number, got "wide"',
  },
  {
    what: 'controlPoints[1].banking missing',
    mutate: (t) => { (t['controlPoints'] as Record<string, unknown>[])[1]['banking'] = undefined },
    expected: 'controlPoints[1].banking: must be a finite number, got undefined',
  },
  {
    what: 'controlPoints[2].surface unknown',
    mutate: (t) => { (t['controlPoints'] as Record<string, unknown>[])[2]['surface'] = 'lava' },
    expected: 'controlPoints[2].surface: must be one of tarmac, dirt, boost, offtrack, got "lava"',
  },
  {
    what: 'controlPoints[3].position.y missing',
    mutate: (t) => {
      const p = (t['controlPoints'] as Record<string, unknown>[])[3]['position'] as Record<string, unknown>
      p['y'] = undefined
    },
    expected: 'controlPoints[3].position.y: must be a finite number, got undefined',
  },
  { what: 'checkpointS missing', mutate: (t) => { t['checkpointS'] = undefined }, expected: 'checkpointS: must be an array of numbers, got undefined' },
  {
    what: 'checkpointS[1] not a number',
    mutate: (t) => { (t['checkpointS'] as unknown[])[1] = null },
    expected: 'checkpointS[1]: must be a finite number, got null',
  },
  { what: 'itemBoxes not an array', mutate: (t) => { t['itemBoxes'] = {} }, expected: 'itemBoxes: must be an array, got an object' },
  {
    what: 'itemBoxes[0].lateral missing',
    mutate: (t) => { (t['itemBoxes'] as Record<string, unknown>[])[0]['lateral'] = undefined },
    expected: 'itemBoxes[0].lateral: must be a finite number, got undefined',
  },
  { what: 'ramps not an array', mutate: (t) => { t['ramps'] = 'none' }, expected: 'ramps: must be an array, got "none"' },
  {
    what: 'ramps[0].launch missing',
    mutate: (t) => { (t['ramps'] as Record<string, unknown>[])[0]['launch'] = undefined },
    expected: 'ramps[0].launch: must be a finite number, got undefined',
  },
  {
    what: 'boostPads[0].halfWidth not a number',
    mutate: (t) => { (t['boostPads'] as Record<string, unknown>[])[0]['halfWidth'] = '3' },
    expected: 'boostPads[0].halfWidth: must be a finite number, got "3"',
  },
  { what: 'startPositions missing', mutate: (t) => { t['startPositions'] = undefined }, expected: 'startPositions: must be an array, got undefined' },
  { what: 'bounds missing', mutate: (t) => { t['bounds'] = undefined }, expected: 'bounds: must be an object with min and max, got undefined' },
  {
    what: 'bounds.max.z missing',
    mutate: (t) => { ((t['bounds'] as Record<string, unknown>)['max'] as Record<string, unknown>)['z'] = undefined },
    expected: 'bounds.max.z: must be a finite number, got undefined',
  },
]

describe('parseTrack', () => {
  it('covers every field in the Track shape', () => {
    expect(REJECTIONS).toHaveLength(18)
  })

  for (const c of REJECTIONS) {
    it(`rejects ${c.what}`, () => {
      const raw = readTrackFile('caldera')
      c.mutate(raw)
      expect(() => parseTrack(raw)).toThrow(c.expected)
    })
  }

  it('rejects a non-object outright', () => {
    expect(() => parseTrack(null)).toThrow('parseTrack: must be an object, got null')
    expect(() => parseTrack([])).toThrow('parseTrack: must be an object, got an array of 0')
  })

  it('runs sim\'s real validateTrack, not just a shape check', () => {
    // The defect this catches is the one that matters: a parser that type-checks a
    // generated track and never asks whether `s` is in [0,1) accepts a track whose
    // checkpoints are in metres — which is the single most common way this project's
    // generated content has been wrong.
    const raw = readTrackFile('caldera')
    ;(raw['checkpointS'] as number[])[0] = 5
    expect(() => parseTrack(raw)).toThrow('checkpointS[0]: must be within 0..1, got 5')
  })

  it('returns a copy, so a caller cannot mutate the imported JSON module', () => {
    const raw = readTrackFile('caldera')
    const track = parseTrack(raw)
    ;(raw['controlPoints'] as Record<string, unknown>[])[0]['width'] = 999
    expect(track.controlPoints[0].width).not.toBe(999)
  })
})
```

- [ ] **Step 6: Run the tracks test to verify it fails**

Run: `npx vitest run packages/content/test/tracks.test.ts`

Expected: FAIL — the file fails to collect, with
`Error: Cannot find module '../src/tracks' imported from '<repo>/packages/content/test/tracks.test.ts'`.

- [ ] **Step 7: Write `tracks.ts`**

Create `packages/content/src/tracks.ts`:

```ts
// PURE (contract §0a). Track loading: synchronous and total (§3a.5, Q12).
//
// §3a.1: six explicit static JSON imports — no bundler glob, no fetch, no Vite-only
// feature, and no `import` + `.meta` anywhere in this file (bundle.test.ts asserts the
// source text), because `packages/server` (Plan 4) imports this package under plain
// Node. Adding a seventh track means one import line here and nothing else; the test
// that compares TRACK_MANIFEST against the real directory catches a forgotten one.
import { buildTrackQuery, validateTrack } from '@tapkart/sim'
import type { Surface, Track, TrackPoint, TrackQuery, Vec3 } from '@tapkart/sim'

import { loadContentBundle } from './bundle'
import { DEFAULT_TRACK_THEME } from './theme'
import type { TrackTheme } from './theme'

import calderaJson from '../../../content/tracks/caldera.json' with { type: 'json' }
import dustCanyonJson from '../../../content/tracks/dust-canyon.json' with { type: 'json' }
import glacierPassJson from '../../../content/tracks/glacier-pass.json' with { type: 'json' }
import harborRunJson from '../../../content/tracks/harbor-run.json' with { type: 'json' }
import neonDistrictJson from '../../../content/tracks/neon-district.json' with { type: 'json' }
import redwoodRiseJson from '../../../content/tracks/redwood-rise.json' with { type: 'json' }

export interface TrackManifestEntry {
  id: string
  name: string
}

export interface LoadedTrack {
  track: Track
  query: TrackQuery
  theme: TrackTheme
}

/** The static view of an imported track module is deliberately narrow: `id` and `name`
 *  are all the manifest needs, and every other key reaches `parseTrack`, which takes
 *  `unknown` and validates. Nothing here trusts the JSON's inferred type. */
interface TrackJsonModule {
  id: string
  name: string
}

/** The six shipped tracks (spec §1) in MENU ORDER, which is `id` ascending. */
const TRACK_JSON: readonly TrackJsonModule[] = [
  calderaJson,
  dustCanyonJson,
  glacierPassJson,
  harborRunJson,
  neonDistrictJson,
  redwoodRiseJson,
]

/** The six shipped tracks (spec §1) in MENU ORDER, which is `id` ascending:
 *  caldera, dust-canyon, glacier-pass, harbor-run, neon-district, redwood-rise.
 *  Derived from the imported modules' own `id` and `name`, never hand-written, so
 *  it cannot drift from what actually shipped. */
export const TRACK_MANIFEST: readonly TrackManifestEntry[] = TRACK_JSON.map((m) => ({
  id: m.id,
  name: m.name,
}))

const SURFACES: readonly Surface[] = ['tarmac', 'dirt', 'boost', 'offtrack']

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Renders a rejected value for the error message. Never throws, never recurses. */
function show(v: unknown): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return `an array of ${v.length}`
  const t = typeof v
  if (t === 'number' || t === 'boolean') return String(v)
  if (t === 'string') return JSON.stringify(v)
  if (t === 'object') return 'an object'
  return t
}

function strField(o: Record<string, unknown>, key: string, path: string, errs: string[]): string {
  const v = o[key]
  if (typeof v !== 'string' || v.length === 0) {
    errs.push(`${path}: must be a non-empty string, got ${show(v)}`)
    return ''
  }
  return v
}

/** Finite check only. Every RANGE is `validateTrack`'s, and there is no second copy. */
function numField(o: Record<string, unknown>, key: string, path: string, errs: string[]): number {
  const v = o[key]
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    errs.push(`${path}: must be a finite number, got ${show(v)}`)
    return 0
  }
  return v
}

function vec3Field(v: unknown, path: string, errs: string[]): Vec3 {
  if (!isRecord(v)) {
    errs.push(`${path}: must be an object with x, y and z, got ${show(v)}`)
    return { x: 0, y: 0, z: 0 }
  }
  return {
    x: numField(v, 'x', `${path}.x`, errs),
    y: numField(v, 'y', `${path}.y`, errs),
    z: numField(v, 'z', `${path}.z`, errs),
  }
}

function surfaceField(v: unknown, path: string, errs: string[]): Surface {
  if (typeof v === 'string') {
    for (const s of SURFACES) {
      if (s === v) return s
    }
  }
  errs.push(`${path}: must be one of ${SURFACES.join(', ')}, got ${show(v)}`)
  return 'tarmac'
}

function arrayField(v: unknown, path: string, errs: string[]): unknown[] {
  if (!Array.isArray(v)) {
    errs.push(`${path}: must be an array, got ${show(v)}`)
    return []
  }
  return v
}

function recordAt(v: unknown, path: string, errs: string[]): Record<string, unknown> | null {
  if (!isRecord(v)) {
    errs.push(`${path}: must be an object, got ${show(v)}`)
    return null
  }
  return v
}

function controlPoints(v: unknown, errs: string[]): TrackPoint[] {
  const raw = arrayField(v, 'controlPoints', errs)
  const out: TrackPoint[] = []
  for (let i = 0; i < raw.length; i++) {
    const cp = recordAt(raw[i], `controlPoints[${i}]`, errs)
    if (cp === null) continue
    out.push({
      position: vec3Field(cp['position'], `controlPoints[${i}].position`, errs),
      width: numField(cp, 'width', `controlPoints[${i}].width`, errs),
      banking: numField(cp, 'banking', `controlPoints[${i}].banking`, errs),
      surface: surfaceField(cp['surface'], `controlPoints[${i}].surface`, errs),
    })
  }
  return out
}

function numberArray(v: unknown, path: string, errs: string[]): number[] {
  if (!Array.isArray(v)) {
    errs.push(`${path}: must be an array of numbers, got ${show(v)}`)
    return []
  }
  const out: number[] = []
  for (let i = 0; i < v.length; i++) {
    const n: unknown = v[i]
    if (typeof n !== 'number' || !Number.isFinite(n)) {
      errs.push(`${path}[${i}]: must be a finite number, got ${show(n)}`)
      continue
    }
    out.push(n)
  }
  return out
}

function sLateralArray(v: unknown, path: string, errs: string[]): { s: number; lateral: number }[] {
  const raw = arrayField(v, path, errs)
  const out: { s: number; lateral: number }[] = []
  for (let i = 0; i < raw.length; i++) {
    const o = recordAt(raw[i], `${path}[${i}]`, errs)
    if (o === null) continue
    out.push({
      s: numField(o, 's', `${path}[${i}].s`, errs),
      lateral: numField(o, 'lateral', `${path}[${i}].lateral`, errs),
    })
  }
  return out
}

function rampArray(v: unknown, errs: string[]): { sStart: number; sEnd: number; launch: number }[] {
  const raw = arrayField(v, 'ramps', errs)
  const out: { sStart: number; sEnd: number; launch: number }[] = []
  for (let i = 0; i < raw.length; i++) {
    const o = recordAt(raw[i], `ramps[${i}]`, errs)
    if (o === null) continue
    out.push({
      sStart: numField(o, 'sStart', `ramps[${i}].sStart`, errs),
      sEnd: numField(o, 'sEnd', `ramps[${i}].sEnd`, errs),
      launch: numField(o, 'launch', `ramps[${i}].launch`, errs),
    })
  }
  return out
}

function padArray(v: unknown, errs: string[]): { s: number; lateral: number; halfWidth: number }[] {
  const raw = arrayField(v, 'boostPads', errs)
  const out: { s: number; lateral: number; halfWidth: number }[] = []
  for (let i = 0; i < raw.length; i++) {
    const o = recordAt(raw[i], `boostPads[${i}]`, errs)
    if (o === null) continue
    out.push({
      s: numField(o, 's', `boostPads[${i}].s`, errs),
      lateral: numField(o, 'lateral', `boostPads[${i}].lateral`, errs),
      halfWidth: numField(o, 'halfWidth', `boostPads[${i}].halfWidth`, errs),
    })
  }
  return out
}

function boundsField(v: unknown, errs: string[]): { min: Vec3; max: Vec3 } {
  if (!isRecord(v)) {
    errs.push(`bounds: must be an object with min and max, got ${show(v)}`)
    return { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } }
  }
  return {
    min: vec3Field(v['min'], 'bounds.min', errs),
    max: vec3Field(v['max'], 'bounds.max', errs),
  }
}

/** Shape-checks, then runs validateTrack. Throws with every validator message
 *  joined by '; ', never returns a half-valid Track. */
export function parseTrack(json: unknown): Track {
  if (!isRecord(json)) {
    throw new Error(`parseTrack: must be an object, got ${show(json)}`)
  }

  const errs: string[] = []
  const track: Track = {
    id: strField(json, 'id', 'id', errs),
    name: strField(json, 'name', 'name', errs),
    controlPoints: controlPoints(json['controlPoints'], errs),
    checkpointS: numberArray(json['checkpointS'], 'checkpointS', errs),
    itemBoxes: sLateralArray(json['itemBoxes'], 'itemBoxes', errs),
    ramps: rampArray(json['ramps'], errs),
    boostPads: padArray(json['boostPads'], errs),
    startPositions: sLateralArray(json['startPositions'], 'startPositions', errs),
    bounds: boundsField(json['bounds'], errs),
  }

  if (errs.length > 0) {
    throw new Error(`parseTrack: ${errs.join('; ')}`)
  }

  // Every range and every rule is sim's, called here rather than restated.
  const invalid = validateTrack(track)
  if (invalid.length > 0) {
    throw new Error(`parseTrack: ${track.id}: ${invalid.join('; ')}`)
  }

  return track
}

/** Immutable shipped content keyed by id — not per-race state. */
const CACHE = new Map<string, LoadedTrack>()

/** TOTAL over TRACK_MANIFEST ids. Builds the TrackQuery (arc table) and resolves
 *  the theme (DEFAULT_TRACK_THEME when unthemed). Throws only on an unknown id,
 *  which is a programming error, not a runtime condition. Memoises, so the arc
 *  table is built once per track per process. */
export function loadTrack(id: string): LoadedTrack {
  const hit = CACHE.get(id)
  if (hit !== undefined) return hit

  let index = -1
  for (let i = 0; i < TRACK_JSON.length; i++) {
    if (TRACK_JSON[i].id === id) {
      index = i
      break
    }
  }
  if (index < 0) {
    const known = TRACK_MANIFEST.map((e) => e.id).join(', ')
    throw new Error(`loadTrack: unknown track id '${id}'; the shipped tracks are ${known}`)
  }

  const track = parseTrack(TRACK_JSON[index])
  const themes = loadContentBundle().themes
  const theme = Object.prototype.hasOwnProperty.call(themes, id) ? themes[id] : DEFAULT_TRACK_THEME
  const loaded: LoadedTrack = { track, query: buildTrackQuery(track), theme }
  CACHE.set(id, loaded)
  return loaded
}
```

Two notes for the implementer:

1. **`TRACK_JSON` is typed `TrackJsonModule[]` but each element carries the whole file.**
   The narrow static type is what lets the manifest read `id`/`name` without trusting the
   JSON's inferred shape; `parseTrack` takes `unknown` and re-derives everything. Do not
   "fix" this by typing the array as `Track[]` — the imported JSON's `surface` is `string`,
   not `Surface`, and the cast that would silence it is exactly the check this package
   exists to perform.
2. **`DEFAULT_TRACK_THEME` is unreachable on shipped content** (all six tracks are themed
   by Task 5), and that is the point of the "not the grey fallback" assertion in the test:
   it proves the wiring rather than the fallback.

- [ ] **Step 8: Run the tracks test to verify it passes**

Run: `npx vitest run packages/content/test/tracks.test.ts`

Expected: PASS — 30 passed (3 `TRACK_MANIFEST` + 6 `loadTrack` + 21 `parseTrack`: the
coverage guard, the 18 table cases, the non-object case, the validateTrack case and the
copy case).

- [ ] **Step 9: Write the failing barrel test**

Create `packages/content/test/barrel.test.ts`:

```ts
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import * as content from '../src/index'
import {
  CHARACTERS,
  DEFAULT_TRACK_THEME,
  TRACK_MANIFEST,
  TUNING,
  loadContentBundle,
  loadTrack,
  parseCharacterDescriptor,
  parseKartDescriptor,
  parseTrack,
  parseTrackTheme,
} from '../src/index'

import * as bundleNs from '../src/bundle'
import * as descriptorsNs from '../src/descriptors'
import * as themeNs from '../src/theme'
import * as tracksNs from '../src/tracks'
import * as tuningNs from '../src/tuning'

import { loadTrack as loadTrackDirect } from '../src/tracks'

const SRC = fileURLToPath(new URL('../src/', import.meta.url))

/** The five modules the barrel must re-export, in contract §3a.7's order. */
const BARREL_MODULES = ['tuning', 'descriptors', 'theme', 'tracks', 'bundle']

const NAMESPACES: [string, object][] = [
  ['tuning', tuningNs],
  ['descriptors', descriptorsNs],
  ['theme', themeNs],
  ['tracks', tracksNs],
  ['bundle', bundleNs],
]

describe('@tapkart/content barrel', () => {
  it('carries every runtime export through', () => {
    const values: [string, unknown][] = [
      ['tuning.TUNING', TUNING],
      ['tuning.CHARACTERS', CHARACTERS],
      ['descriptors.parseCharacterDescriptor', parseCharacterDescriptor],
      ['descriptors.parseKartDescriptor', parseKartDescriptor],
      ['theme.DEFAULT_TRACK_THEME', DEFAULT_TRACK_THEME],
      ['theme.parseTrackTheme', parseTrackTheme],
      ['tracks.TRACK_MANIFEST', TRACK_MANIFEST],
      ['tracks.parseTrack', parseTrack],
      ['tracks.loadTrack', loadTrack],
      ['bundle.loadContentBundle', loadContentBundle],
    ]
    // 10 runtime values; the other 8 of contract §11's 18 content symbols are types,
    // which erase.
    expect(values).toHaveLength(10)
    for (const [name, value] of values) {
      expect(value, `${name} did not come through the barrel`).toBeDefined()
    }
  })

  it('re-exports each module\'s own binding, not a copy', () => {
    expect(loadTrack).toBe(loadTrackDirect)
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

  it('has no ambiguous re-export', () => {
    // An ambiguous name is silently dropped from an ESM namespace and becomes a
    // SyntaxError at the import site, so it must not exist in the first place. Three
    // modules here define a private `isRecord` and a private `show`; if one of them is
    // ever exported by accident, this is what says so.
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
          Object.prototype.hasOwnProperty.call(content, key),
          `${mod}.${key} is not forwarded by the barrel`,
        ).toBe(true)
      }
    }
  })

  it('keeps the parse helpers private', () => {
    for (const helper of ['isRecord', 'show', 'numField', 'palette', 'surfaceField']) {
      expect(Object.prototype.hasOwnProperty.call(content, helper)).toBe(false)
    }
  })
})
```

- [ ] **Step 10: Run the barrel test to verify it fails**

Run: `npx vitest run packages/content/test/barrel.test.ts`

Expected: FAIL — the file fails to collect, with
`Error: Cannot find module '../src/index' imported from '<repo>/packages/content/test/barrel.test.ts'`.

- [ ] **Step 11: Write the barrel**

Create `packages/content/src/index.ts`:

```ts
// Public barrel for @tapkart/content (contract §3a.7).
//
// packages/content/package.json maps "." to this file, so this list IS the package's
// public surface: `render`, `game` and — in Plan 4 — `server` import the shipped data
// through `@tapkart/content` and get exactly what is re-exported here. 18 symbols
// across five modules (§11).
//
// `export *` carries types and values together and is legal under isolatedModules. No
// two modules below export the same name; barrel.test.ts asserts that at runtime rather
// than leaving it to this comment.
export * from './tuning'
export * from './descriptors'
export * from './theme'
export * from './tracks'
export * from './bundle'
```

- [ ] **Step 12: Run the barrel test to verify it passes**

Run: `npx vitest run packages/content/test/barrel.test.ts`

Expected: PASS — 5 passed.

- [ ] **Step 13: Typecheck and run the whole content suite**

Run: `npx tsc --noEmit -p packages/content && npx vitest run packages/content`

Expected: no TypeScript output, exit 0; then every `packages/content` test file green —
this task's 41 (6 bundle + 30 tracks + 5 barrel) plus Task 2's tuning tests, Task 3's
descriptor tests, Task 4's 39 theme tests and Task 5's roster tests.

- [ ] **Step 14: Commit**

```bash
git add packages/content/src/tracks.ts packages/content/src/bundle.ts packages/content/src/index.ts \
        packages/content/test/tracks.test.ts packages/content/test/bundle.test.ts \
        packages/content/test/barrel.test.ts
git commit -m "feat(content): synchronous track loading, the content bundle, and the barrel"
```

---

### Task 7: `packages/render` scaffold and `src/types.ts` — the view structs

The first Plan 3 package. Three things ship here and nothing else: the manifest (with
`three` pinned at **exactly `0.180.0`**, Q10), the tsconfig that widens `lib` to include
DOM in this package only (R35), and `src/types.ts` — the view structs that are the
**entire `game` → `render` handoff** (contract §4.2). `render` is handed views, never a
`SimState`; that is what makes spec §5's "remote karts render from the interpolated
buffer, never from prediction" a structural fact rather than a discipline.

This task also creates `packages/render/test/fixtures/render-fixtures.ts` — the full
§9.1 fixture surface — because every later `render` task imports it and it cannot be
written before `src/types.ts` exists. **Later render tasks import it; they do not
re-create it.**

**Prerequisite:** `@tapkart/content` must already export `CharacterDescriptor`,
`KartDescriptor` and `TrackTheme` (contract §3a.3, §3a.4) and have its `package.json`
in the workspace. If `npm install` cannot resolve `@tapkart/content`, that package's
task has not landed and this task stops rather than inventing a local copy.

**Files:**
- Create: `packages/render/package.json`
- Create: `packages/render/tsconfig.json`
- Create: `packages/render/src/types.ts`
- Create: `packages/render/src/index.ts`
- Create: `packages/render/test/fixtures/render-fixtures.ts`
- Modify: `package-lock.json` — `npm install` side effect (Step 3), declared because five tasks in this plan rewrite it
- Test: `packages/render/test/types.test.ts`
- Test: `packages/render/test/fixtures.test.ts`

**Interfaces:**

- Consumes, from `@tapkart/sim` (its barrel re-exports all 19 modules):
  ```ts
  export type Vec3 = { x: number; y: number; z: number }
  export const MAX_KARTS = 8
  export const MAX_ENTITIES = 32
  export type Surface = 'tarmac' | 'dirt' | 'boost' | 'offtrack'
  export type ItemKind =
    | 'none' | 'boost' | 'seeker' | 'bolt' | 'slick'
    | 'bubble' | 'surge' | 'blink' | 'charge'
  export type EntityKind = 'seeker' | 'bolt' | 'slick' | 'bubble' | 'surge' | 'charge'
  export type RacePhase = 'countdown' | 'racing' | 'finished'
  export interface Track { id: string; name: string; controlPoints: TrackPoint[]
    checkpointS: number[]; itemBoxes: { s: number; lateral: number }[]
    ramps: { sStart: number; sEnd: number; launch: number }[]
    boostPads: { s: number; lateral: number; halfWidth: number }[]
    startPositions: { s: number; lateral: number }[]
    bounds: { min: Vec3; max: Vec3 } }
  export interface SimContext { track: Track; query: TrackQuery; tuning: Tuning
    characters: CharacterStats[]; isLeader: boolean }
  export function validateTrack(track: Track): string[]   // [] when valid
  export function v3(x: number, y: number, z: number): Vec3
  ```
- Consumes, from `@tapkart/content` (contract §3a.3, §3a.4 — an earlier task):
  ```ts
  export type PaletteRGB = readonly [number, number, number]     // linear, 0..1
  export interface CharacterDescriptor { id: string; name: string; bodyHeight: number
    bodyRadius: number; headRadius: number
    palette: { primary: PaletteRGB; secondary: PaletteRGB; accent: PaletteRGB }
    silhouette: 'compact' | 'tall' | 'wide' }
  export interface KartDescriptor { id: string; name: string; chassisLength: number
    chassisWidth: number; chassisHeight: number; wheelRadius: number; wheelWidth: number
    palette: { body: PaletteRGB; trim: PaletteRGB; wheel: PaletteRGB } }
  export interface EdgeMarkerParams { spacing: number; height: number; offset: number
    colors: readonly [PaletteRGB, PaletteRGB] }
  export interface TrackTheme { trackId: string; road: PaletteRGB; roadDirt: PaletteRGB
    shoulder: PaletteRGB; wall: PaletteRGB; ground: PaletteRGB
    sky: { top: PaletteRGB; bottom: PaletteRGB }
    fog: { color: PaletteRGB; near: number; far: number }
    sunDirection: Vec3; ambient: number; edgeMarkers: EdgeMarkerParams }
  ```
- Consumes, by **relative path only** (contract §2.6 — sim's fixtures are outside
  `@tapkart/sim`'s `exports` map, and `src` never reaches them):
  ```ts
  // packages/sim/test/fixtures/track-fixtures.ts
  export function makeOvalTrack(overrides?: Partial<Track>): Track
  export function makeContext(track: Track, isLeader?: boolean): SimContext
  ```
- Produces — the 8 exports of `render/types` (contract §11's census for this module):
  ```ts
  export type ViewRole = 'host' | 'guest' | 'solo'
  export type ViewSource = 'authoritative' | 'predicted' | 'interpolated' | 'absent'
  export interface KartView { /* 28 fields, §4.2, verbatim below */ }
  export interface EntityView { /* 8 fields */ }
  export interface ItemBoxView { boxIdx: number; position: Vec3; respawnTicks: number }
  export interface RaceView { /* 13 fields */ }
  export function createRaceView(itemBoxCount: number): RaceView
  export function viewSourceViolations(view: RaceView, role: ViewRole): string[]
  ```
- Produces — the 8 test-only fixture exports (contract §9.1), which every later
  `render` task imports from `packages/render/test/fixtures/render-fixtures`:
  ```ts
  export function makeRenderContext(): SimContext
  export function makeKartView(overrides?: Partial<KartView>): KartView
  export function makeRaceView(overrides?: Partial<RaceView>): RaceView
  export function makeThemeFixture(): TrackTheme
  export function makeCharacterDescriptorFixture(): CharacterDescriptor
  export function makeKartDescriptorFixture(): KartDescriptor
  export function loadShippedTrack(id: string): Track
  export const SHIPPED_TRACK_IDS: readonly string[]
  ```

---

- [ ] **Step 1: Write the failing test**

Two test files. `types.test.ts` proves the two functions; `fixtures.test.ts` proves the
fixture surface — in particular that `SHIPPED_TRACK_IDS` really is the six files on
disk, because **every later mesh test is an `it.each` over that array and an empty
array makes a whole suite pass by running nothing** (this project's signature defect).

Create `packages/render/test/types.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { createRaceView, viewSourceViolations } from '../src/types'
import type { RaceView, ViewSource } from '../src/types'

/** A view whose every seat and slot is filled the way the given role must fill it. */
function legalView(role: 'host' | 'guest' | 'solo', localPlayerId: number): RaceView {
  const v = createRaceView(4)
  v.localPlayerId = localPlayerId
  for (let i = 0; i < 8; i++) {
    v.karts[i].source =
      role === 'guest' ? (i === localPlayerId ? 'predicted' : 'interpolated') : 'authoritative'
  }
  v.entityCount = 2
  for (let j = 0; j < 32; j++) {
    if (j < v.entityCount) {
      v.entities[j].entityId = 100 + j
      v.entities[j].source = role === 'guest' ? 'interpolated' : 'authoritative'
    }
  }
  return v
}

describe('createRaceView', () => {
  it('allocates every array at its fixed length', () => {
    const v = createRaceView(16)
    expect(v.karts.length).toBe(8)
    expect(v.entities.length).toBe(32)
    expect(v.itemBoxes.length).toBe(16)
    expect(v.finishedOrder.length).toBe(8)
    expect(v.finishedOrder.every((x) => x === -1)).toBe(true)
    expect(v.finishTick).toBe(-1)
    expect(v.localPlayerId).toBe(-1)
  })

  it('indexes karts BY SEAT: karts[i].playerId === i', () => {
    const v = createRaceView(4)
    for (let i = 0; i < 8; i++) expect(v.karts[i].playerId).toBe(i)
  })

  it('numbers item boxes by index and starts every entity slot empty', () => {
    const v = createRaceView(3)
    for (let b = 0; b < 3; b++) expect(v.itemBoxes[b].boxIdx).toBe(b)
    for (let j = 0; j < 32; j++) {
      expect(v.entities[j].entityId).toBe(-1)
      expect(v.entities[j].source).toBe('absent')
    }
    expect(v.entityCount).toBe(0)
  })

  // The bug: `new Array(MAX_KARTS).fill(template)` or one shared ZERO Vec3. Every kart
  // then draws at whatever the last writer wrote — all eight stacked on one point — and
  // a length-only test passes happily. Mutating one and reading the others is the only
  // assertion that sees it.
  it('gives every Vec3 its own object', () => {
    const v = createRaceView(2)
    v.karts[0].position.x = 5
    v.karts[0].velocity.z = -3
    v.entities[0].position.y = 9
    v.itemBoxes[0].position.x = 7
    expect(v.karts[1].position.x).toBe(0)
    expect(v.karts[0].velocity.x).toBe(0)
    expect(v.karts[0].position.z).toBe(0)
    expect(v.karts[1].velocity.z).toBe(0)
    expect(v.entities[1].position.y).toBe(0)
    expect(v.itemBoxes[1].position.x).toBe(0)
  })

  // A fresh view is deliberately unfilled: 'absent' sources and place 0. If the default
  // were a plausible-looking 'authoritative' with place = i, a ViewBuilder that forgot to
  // write a seat would look correct in every downstream test.
  it('defaults to unfilled values, so a missing write is visible', () => {
    const v = createRaceView(1)
    expect(v.karts.every((k) => k.source === 'absent')).toBe(true)
    expect(v.karts.every((k) => k.place === 0)).toBe(true)
    expect(v.karts[0].driftTier).toBe(-1)
    expect(v.karts[0].item).toBe('none')
    expect(v.karts[0].surface).toBe('tarmac')
    expect(v.phase).toBe('countdown')
  })
})

describe('viewSourceViolations', () => {
  it('returns [] for a legal host, solo and guest view', () => {
    expect(viewSourceViolations(legalView('host', -1), 'host')).toEqual([])
    expect(viewSourceViolations(legalView('solo', -1), 'solo')).toEqual([])
    expect(viewSourceViolations(legalView('guest', 3), 'guest')).toEqual([])
  })

  // A checker that returns [] unconditionally passes every test above. This one it
  // cannot pass: a freshly allocated view is all-'absent', which is legal for nobody
  // as a KART source under host.
  it('reports all eight seats of an unfilled view under host', () => {
    const v = createRaceView(2)
    const errs = viewSourceViolations(v, 'host')
    expect(errs.length).toBe(8)
    expect(errs[0]).toBe(
      "kart[0]: source 'absent' is illegal for role 'host' (expected 'authoritative')",
    )
  })

  // THE central invariant (contract §7.1). A guest drawing a remote seat from state()
  // is drawing the sim's own bot AI for that seat — the karts visibly drive themselves
  // down a line no other player is on. This is the exact message that catches it.
  it("flags a guest drawing a REMOTE seat from prediction", () => {
    const v = legalView('guest', 3)
    v.karts[5].source = 'predicted'
    expect(viewSourceViolations(v, 'guest')).toEqual([
      "kart[5]: source 'predicted' is illegal for role 'guest' (expected 'interpolated' or 'absent')",
    ])
  })

  it("flags a guest drawing its OWN seat from the interpolator", () => {
    const v = legalView('guest', 3)
    v.karts[3].source = 'interpolated'
    expect(viewSourceViolations(v, 'guest')).toEqual([
      "kart[3]: source 'interpolated' is illegal for role 'guest' (expected 'predicted')",
    ])
  })

  it('allows an absent remote seat on a guest, and only there', () => {
    const guest = legalView('guest', 3)
    guest.karts[6].source = 'absent'
    expect(viewSourceViolations(guest, 'guest')).toEqual([])
    const host = legalView('host', -1)
    host.karts[6].source = 'absent'
    expect(viewSourceViolations(host, 'host')).toEqual([
      "kart[6]: source 'absent' is illegal for role 'host' (expected 'authoritative')",
    ])
  })

  it('reports an illegal guest localPlayerId and returns immediately', () => {
    const v = legalView('guest', 3)
    v.localPlayerId = -1
    // every seat is now wrong too, but no per-seat check is meaningful without a seat
    expect(viewSourceViolations(v, 'guest')).toEqual([
      "localPlayerId -1 is illegal for role 'guest'",
    ])
    v.localPlayerId = 8
    expect(viewSourceViolations(v, 'guest')).toEqual([
      "localPlayerId 8 is illegal for role 'guest'",
    ])
  })

  it('does not police localPlayerId on host or solo', () => {
    expect(viewSourceViolations(legalView('host', -1), 'host')).toEqual([])
    expect(viewSourceViolations(legalView('solo', -1), 'solo')).toEqual([])
  })

  it('flags a live entity slot with the wrong source', () => {
    const v = legalView('host', -1)
    v.entities[1].source = 'interpolated' as ViewSource
    expect(viewSourceViolations(v, 'host')).toEqual([
      "entity[1] (id 101): source 'interpolated' is illegal for role 'host' (expected 'authoritative')",
    ])
  })

  // Entities are removed by swap-remove, so a stale id left behind at a dead slot is the
  // realistic failure: the renderer draws a despawned shell forever. Both messages, in
  // this order.
  it('flags a dead slot that still carries an entityId, source message first', () => {
    const v = legalView('host', -1)
    v.entities[7].entityId = 42
    v.entities[7].source = 'authoritative'
    expect(viewSourceViolations(v, 'host')).toEqual([
      "entity[7] (id 42): source 'authoritative' is illegal for role 'host' (expected 'absent')",
      'entity[7]: entityId 42 is illegal at slot 7 with entityCount 2',
    ])
  })

  it('flags a live slot with no entityId', () => {
    const v = legalView('guest', 3)
    v.entities[0].entityId = -1
    expect(viewSourceViolations(v, 'guest')).toEqual([
      'entity[0]: entityId -1 is illegal at slot 0 with entityCount 2',
    ])
  })
})
```

Create `packages/render/test/fixtures.test.ts`:

```ts
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { validateTrack } from '@tapkart/sim'

import {
  SHIPPED_TRACK_IDS,
  loadShippedTrack,
  makeCharacterDescriptorFixture,
  makeKartDescriptorFixture,
  makeKartView,
  makeRaceView,
  makeRenderContext,
  makeThemeFixture,
} from './fixtures/render-fixtures'

// derived here independently of the fixture, so the two cannot drift together
const TRACKS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'content', 'tracks')

describe('render fixtures', () => {
  // Q34: the six shipped tracks are REQUIRED coverage, and every mesh test is an
  // `it.each(SHIPPED_TRACK_IDS)`. If this list were empty — or derived from a
  // directory read that silently found nothing — those suites would run zero cases
  // and report green. This is the assertion that stops that.
  it('SHIPPED_TRACK_IDS is exactly the six files in content/tracks, ascending', () => {
    const onDisk = readdirSync(TRACKS_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -'.json'.length))
      .sort()
    expect(SHIPPED_TRACK_IDS.length).toBe(6)
    expect([...SHIPPED_TRACK_IDS]).toEqual(onDisk)
    expect([...SHIPPED_TRACK_IDS]).toEqual([
      'caldera',
      'dust-canyon',
      'glacier-pass',
      'harbor-run',
      'neon-district',
      'redwood-rise',
    ])
  })

  it.each([...SHIPPED_TRACK_IDS])('loadShippedTrack(%s) returns a valid, non-trivial Track', (id) => {
    const track = loadShippedTrack(id)
    expect(track.id).toBe(id)
    expect(validateTrack(track)).toEqual([])
    expect(track.controlPoints.length).toBeGreaterThanOrEqual(46)
    expect(track.startPositions.length).toBe(8)
    expect(track.checkpointS.length).toBeGreaterThanOrEqual(10)
  })

  it('loadShippedTrack throws on an unknown id rather than returning a husk', () => {
    expect(() => loadShippedTrack('no-such-track')).toThrow()
  })

  it('makeRenderContext gives a usable SimContext', () => {
    const ctx = makeRenderContext()
    expect(ctx.track.controlPoints.length).toBeGreaterThan(8)
    expect(ctx.characters.length).toBe(8)
    expect(ctx.query.totalLength()).toBeGreaterThan(100)
  })

  it('makeKartView applies overrides and still allocates fresh vectors', () => {
    const a = makeKartView({ playerId: 4, heading: 1.25 })
    const b = makeKartView()
    expect(a.playerId).toBe(4)
    expect(a.heading).toBe(1.25)
    a.position.x = 12
    expect(b.position.x).toBe(0)
  })

  it('makeRaceView is a filled, legal host view', () => {
    const v = makeRaceView()
    expect(v.karts.length).toBe(8)
    expect(v.karts.every((k) => k.source === 'authoritative')).toBe(true)
    expect(v.phase).toBe('racing')
    const w = makeRaceView({ phase: 'finished', tick: 99 })
    expect(w.phase).toBe('finished')
    expect(w.tick).toBe(99)
  })

  it('descriptor and theme fixtures sit inside their declared ranges', () => {
    const c = makeCharacterDescriptorFixture()
    expect(c.bodyHeight).toBeGreaterThanOrEqual(0.4)
    expect(c.bodyHeight).toBeLessThanOrEqual(1.4)
    expect(c.bodyRadius).toBeGreaterThanOrEqual(0.15)
    expect(c.bodyRadius).toBeLessThanOrEqual(0.5)
    expect(c.headRadius).toBeGreaterThanOrEqual(0.1)
    expect(c.headRadius).toBeLessThanOrEqual(0.4)
    const k = makeKartDescriptorFixture()
    expect(k.chassisLength).toBeGreaterThanOrEqual(1.4)
    expect(k.chassisLength).toBeLessThanOrEqual(2.6)
    expect(k.chassisWidth).toBeGreaterThanOrEqual(0.9)
    expect(k.chassisWidth).toBeLessThanOrEqual(1.6)
    expect(k.wheelRadius).toBeGreaterThanOrEqual(0.2)
    expect(k.wheelRadius).toBeLessThanOrEqual(0.45)
    const t = makeThemeFixture()
    const d = t.sunDirection
    expect(Math.abs(Math.hypot(d.x, d.y, d.z) - 1)).toBeLessThan(1e-6)
    expect(t.fog.near).toBeLessThan(t.fog.far)
    expect(t.edgeMarkers.spacing).toBeGreaterThanOrEqual(4)
    expect(t.edgeMarkers.spacing).toBeLessThanOrEqual(40)
    // the three road colours must differ, or the mesh tint test proves nothing
    expect(t.road).not.toEqual(t.roadDirt)
    expect(t.road).not.toEqual(t.shoulder)
    expect(t.roadDirt).not.toEqual(t.shoulder)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/render/test`

Expected: FAIL. Both files fail to collect, with
`Error: Cannot find module '../src/types' imported from '/home/kasm-user/tapkart/packages/render/test/types.test.ts'`
(caused by `Failed to load url ../src/types ... Does the file exist?`) and
`Error: Cannot find module './fixtures/render-fixtures' imported from '/home/kasm-user/tapkart/packages/render/test/fixtures.test.ts'`.

- [ ] **Step 3: Write the implementation**

Create `packages/render/package.json` — `three` is pinned **exactly**, no caret (Q10).
The `"./three"` export points at `src/three/renderer.ts`, which a later task creates;
npm does not resolve `exports` targets at install time and nothing imports that
subpath yet, so declaring it now is correct and inert.

```json
{
  "name": "@tapkart/render",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./three": "./src/three/renderer.ts"
  },
  "dependencies": {
    "@tapkart/sim": "*",
    "@tapkart/content": "*",
    "three": "0.180.0"
  },
  "scripts": {
    "typecheck": "tsc --noEmit -p tsconfig.json"
  }
}
```

Create `packages/render/tsconfig.json` — R35: DOM is widened **here**, never in
`tsconfig.base.json`, which stays `"lib": ["ES2022"]` so `sim`, `protocol`, `net` and
`content` (the four packages `server` imports) can never acquire a DOM type:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2022", "DOM", "DOM.Iterable"]
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

Create `packages/render/src/types.ts`:

```ts
// PURE (contract §0a): no DOM, no GPU, no clock, no `three` import — not even a
// type-only one (§8.2). These are the view structs `game` fills and `render` reads,
// and they are the entire game -> render handoff (§4.2). `render` never holds a
// SimState and imports nothing that can write one.
import type { EntityKind, ItemKind, RacePhase, Surface, Vec3 } from '@tapkart/sim'
import { MAX_ENTITIES, MAX_KARTS, v3 } from '@tapkart/sim'

/** The session's role, named once, in the lowest package that needs it. `game`
 *  imports this type rather than declaring a second union. There is no `SessionRole`. */
export type ViewRole = 'host' | 'guest' | 'solo'

/** Where a seat's transform came from. §7.1 is the full rule and
 *  `viewSourceViolations` is its executable form. */
export type ViewSource = 'authoritative' | 'predicted' | 'interpolated' | 'absent'

export interface KartView {
  playerId: number
  characterIdx: number // from the session, never from the wire
  source: ViewSource
  position: Vec3 // metres, world
  heading: number // radians, wrapped to (-pi, pi]
  velocity: Vec3 // m/s
  angularVelocity: number // rad/s
  speed: number // m/s, PLAN VIEW: hypot(velocity.x, velocity.z)
  s: number // arc-normalised [0, 1), NEVER metres
  bankAngle: number // radians, track banking under the kart
  driftActive: boolean
  driftDir: -1 | 0 | 1
  driftCharge: number // ticks
  driftTier: number // sim's encoding: -1 none, 0..2 index into driftBoosts
  airborne: boolean
  surface: Surface
  spinOutTicks: number
  invulnTicks: number
  boostTicks: number
  respawnTicks: number
  shielded: boolean
  item: ItemKind
  lap: number // 0-based, exactly KartState.lap.lap
  checkpointIdx: number
  t: number
  place: number // 0-based; 0 = leader
  isBot: boolean
  connected: boolean
}

export interface EntityView {
  entityId: number // -1 in an unused slot
  kind: EntityKind
  ownerId: number
  source: ViewSource
  position: Vec3
  velocity: Vec3
  heading: number
  ttl: number // ticks
}

/** No `source` field, deliberately: item boxes have no authoritative wire form at
 *  all, so there is nothing for §7.1 to police. Availability is `respawnTicks === 0`
 *  and is never stored twice. */
export interface ItemBoxView {
  boxIdx: number
  position: Vec3 // from itemBoxWorldPos, verbatim
  respawnTicks: number
}

export interface RaceView {
  tick: number
  alpha: number // sub-tick fraction, [0, 1)
  phase: RacePhase
  localPlayerId: number // -1 for a spectator or a replay; never -1 for a guest
  raceStartTick: number
  karts: KartView[] // always length MAX_KARTS, indexed BY SEAT: karts[i].playerId === i
  entities: EntityView[] // always length MAX_ENTITIES, live packed at front
  entityCount: number
  itemBoxes: ItemBoxView[] // length = ctx.track.itemBoxes.length
  itemBoxRespawnTicks: number // ctx.tuning.itemBoxRespawnTicks
  finishedOrder: number[] // length MAX_KARTS, -1 in unfilled slots
  finishTick: number // -1 until the first kart finishes
  countdownTicksLeft: number // 0 once racing
}

/**
 * Allocates one fully-populated RaceView with every array at its fixed length and
 * every Vec3 distinct. Called once per session, never per frame.
 *
 * Defaults are deliberately *unfilled* rather than plausible: every source is
 * 'absent', every place is 0 and every driftTier is -1, so a ViewBuilder that forgets
 * to write a seat produces a view that `viewSourceViolations` rejects instead of one
 * that merely looks slightly wrong.
 */
export function createRaceView(itemBoxCount: number): RaceView {
  const karts: KartView[] = []
  for (let i = 0; i < MAX_KARTS; i++) {
    karts.push({
      playerId: i,
      characterIdx: 0,
      source: 'absent',
      position: v3(0, 0, 0),
      heading: 0,
      velocity: v3(0, 0, 0),
      angularVelocity: 0,
      speed: 0,
      s: 0,
      bankAngle: 0,
      driftActive: false,
      driftDir: 0,
      driftCharge: 0,
      driftTier: -1,
      airborne: false,
      surface: 'tarmac',
      spinOutTicks: 0,
      invulnTicks: 0,
      boostTicks: 0,
      respawnTicks: 0,
      shielded: false,
      item: 'none',
      lap: 0,
      checkpointIdx: 0,
      t: 0,
      place: 0,
      isBot: false,
      connected: false,
    })
  }
  const entities: EntityView[] = []
  for (let j = 0; j < MAX_ENTITIES; j++) {
    entities.push({
      entityId: -1,
      // `kind` is meaningless in an unused slot: `entityId === -1` is the liveness flag.
      kind: 'seeker',
      ownerId: -1,
      source: 'absent',
      position: v3(0, 0, 0),
      velocity: v3(0, 0, 0),
      heading: 0,
      ttl: 0,
    })
  }
  const itemBoxes: ItemBoxView[] = []
  for (let b = 0; b < itemBoxCount; b++) {
    itemBoxes.push({ boxIdx: b, position: v3(0, 0, 0), respawnTicks: 0 })
  }
  const finishedOrder: number[] = []
  for (let i = 0; i < MAX_KARTS; i++) finishedOrder.push(-1)
  return {
    tick: 0,
    alpha: 0,
    phase: 'countdown',
    localPlayerId: -1,
    raceStartTick: 0,
    karts,
    entities,
    entityCount: 0,
    itemBoxes,
    itemBoxRespawnTicks: 0,
    finishedOrder,
    finishTick: -1,
    countdownTicksLeft: 0,
  }
}

/** `'a' or 'b'` — the exact `expected` rendering §7.1 specifies. */
function expectedList(sources: readonly ViewSource[]): string {
  return sources.map((s) => `'${s}'`).join(' or ')
}

/**
 * [] when the view obeys §7.1; otherwise one string per violating seat or slot, in the
 * exact format §7.1 specifies. Exported (not test-only) because the CI honesty test and
 * the dev-build assertion (Q32) must run the same code rather than two readings of one
 * table. Allocates; never called in the frame path of a production build.
 */
export function viewSourceViolations(view: RaceView, role: ViewRole): string[] {
  const out: string[] = []

  // 1. Local seat identity. No per-seat check is meaningful without a local seat.
  if (role === 'guest' && !(view.localPlayerId >= 0 && view.localPlayerId < MAX_KARTS)) {
    out.push(`localPlayerId ${view.localPlayerId} is illegal for role 'guest'`)
    return out
  }

  // 2. Karts, ascending seat index. A host's AuthorityLoop.state() IS the authority, so
  //    drawing every seat from it is legal; what is forbidden is a guest drawing another
  //    player's seat from its own prediction, which is the sim's bot AI driving that seat.
  for (let i = 0; i < MAX_KARTS; i++) {
    let allowed: ViewSource[]
    if (role === 'guest') {
      allowed = i === view.localPlayerId ? ['predicted'] : ['interpolated', 'absent']
    } else {
      allowed = ['authoritative']
    }
    const actual = view.karts[i].source
    if (!allowed.includes(actual)) {
      out.push(
        `kart[${i}]: source '${actual}' is illegal for role '${role}' ` +
          `(expected ${expectedList(allowed)})`,
      )
    }
  }

  // 3. Entities, ascending slot. Live slots are packed at the front.
  for (let j = 0; j < MAX_ENTITIES; j++) {
    const e = view.entities[j]
    const live = j < view.entityCount
    let allowed: ViewSource[]
    if (!live) allowed = ['absent']
    else allowed = role === 'guest' ? ['interpolated'] : ['authoritative']
    if (!allowed.includes(e.source)) {
      out.push(
        `entity[${j}] (id ${e.entityId}): source '${e.source}' is illegal for role '${role}' ` +
          `(expected ${expectedList(allowed)})`,
      )
    }
    if ((live && e.entityId < 0) || (!live && e.entityId >= 0)) {
      out.push(
        `entity[${j}]: entityId ${e.entityId} is illegal at slot ${j} ` +
          `with entityCount ${view.entityCount}`,
      )
    }
  }

  return out
}
```

Create `packages/render/src/index.ts` — the barrel. It deliberately does **not**
re-export `src/three/renderer.ts` (§8.2): a barrel that pulled it in would drag `three`,
and transitively a WebGL context, into every headless test in the repository, and the
failure would surface as an unrelated suite breaking. Later tasks append one line each,
in §4.11's order.

```ts
// Public barrel for @tapkart/render.
//
// packages/render/package.json maps "." to this file, so this list IS the package's
// public surface. It does NOT re-export `three/renderer` (contract §8.2), there is no
// `time` module (§4.1) and there is no `theme` module (§4.5) — TrackTheme is content.
//
// Contract §4.11's order, one line per module as each lands:
// types, mesh, descriptors, camera, frame, hud, audio, smoothing, backend.
export * from './types'
```

Create `packages/render/test/fixtures/render-fixtures.ts`:

```ts
// TEST-ONLY (contract §9.1). `src` never imports this file and never reads the
// filesystem: Q12 gives `src` its tracks through @tapkart/content's static imports.
// Tests read the REAL shipped tracks off disk (Q34), which is what makes every mesh
// assertion evidence about shipped content rather than about a synthetic oval.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { SimContext, Track } from '@tapkart/sim'
import { validateTrack } from '@tapkart/sim'
import type { CharacterDescriptor, KartDescriptor, TrackTheme } from '@tapkart/content'

// §2.6: sim's fixtures live outside @tapkart/sim's `exports` map, so tests reach them
// by relative path and `src` never does.
import { makeContext, makeOvalTrack } from '../../../sim/test/fixtures/track-fixtures'
import type { KartView, RaceView } from '../../src/types'
import { createRaceView } from '../../src/types'

/** <repo>/content/tracks, four levels up from packages/render/test/fixtures. */
const TRACKS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'content',
  'tracks',
)

/**
 * The six shipped tracks (spec §1) in `id`-ascending order. Hand-written on purpose:
 * every mesh suite is an `it.each(SHIPPED_TRACK_IDS)`, and a list derived from a
 * directory read would silently become empty — turning a whole suite green by running
 * nothing. `fixtures.test.ts` asserts this equals the directory contents instead.
 */
export const SHIPPED_TRACK_IDS: readonly string[] = [
  'caldera',
  'dust-canyon',
  'glacier-pass',
  'harbor-run',
  'neon-district',
  'redwood-rise',
]

/** Loads a real shipped track off disk with node:fs. Test-only; src never does.
 *  Throws on an unreadable file or a failing `validateTrack`, so no test ever
 *  measures a mesh built from a half-valid track. */
export function loadShippedTrack(id: string): Track {
  const raw = readFileSync(join(TRACKS_DIR, `${id}.json`), 'utf8')
  const track = JSON.parse(raw) as Track
  const errs = validateTrack(track)
  if (errs.length > 0) throw new Error(`${id}.json is not a valid Track: ${errs.join('; ')}`)
  return track
}

/** A SimContext over sim's oval fixture: base tuning, the eight fixture characters,
 *  and a freshly built TrackQuery.
 *
 *  This deliberately uses sim's `makeContext`, NOT @tapkart/content's shipped constants:
 *  `CHARACTERS` is `readonly CharacterStats[]` and does not assign to
 *  `SimContext.characters: CharacterStats[]` under `strict` — a composition root has to
 *  write `CHARACTERS.slice()`, and a test fixture has no reason to pay that. `TUNING:
 *  Readonly<Tuning>` assigns fine; the array is the case that bites. */
export function makeRenderContext(): SimContext {
  return makeContext(makeOvalTrack())
}

export function makeKartView(overrides?: Partial<KartView>): KartView {
  const base: KartView = {
    playerId: 0,
    characterIdx: 0,
    source: 'authoritative',
    position: { x: 0, y: 0, z: 0 },
    heading: 0,
    velocity: { x: 0, y: 0, z: 0 },
    angularVelocity: 0,
    speed: 0,
    s: 0,
    bankAngle: 0,
    driftActive: false,
    driftDir: 0,
    driftCharge: 0,
    driftTier: -1,
    airborne: false,
    surface: 'tarmac',
    spinOutTicks: 0,
    invulnTicks: 0,
    boostTicks: 0,
    respawnTicks: 0,
    shielded: false,
    item: 'none',
    lap: 0,
    checkpointIdx: 0,
    t: 0,
    place: 0,
    isBot: false,
    connected: true,
  }
  return { ...base, ...overrides }
}

/** A filled, legal HOST view: eight authoritative seats, racing, six item boxes
 *  (sim's oval fixture has six). */
export function makeRaceView(overrides?: Partial<RaceView>): RaceView {
  const view = createRaceView(6)
  view.phase = 'racing'
  view.localPlayerId = 0
  for (let i = 0; i < view.karts.length; i++) {
    view.karts[i].source = 'authoritative'
    view.karts[i].characterIdx = i
    view.karts[i].place = i
    view.karts[i].connected = true
  }
  view.itemBoxRespawnTicks = 180
  return Object.assign(view, overrides)
}

/** A theme whose road, roadDirt and shoulder colours are all different, so a mesh
 *  tint assertion can tell them apart. `sunDirection` is exactly unit length. */
export function makeThemeFixture(): TrackTheme {
  return {
    trackId: 'oval',
    road: [0.18, 0.18, 0.2],
    roadDirt: [0.35, 0.26, 0.18],
    shoulder: [0.24, 0.34, 0.16],
    wall: [0.4, 0.4, 0.45],
    ground: [0.2, 0.3, 0.15],
    sky: { top: [0.2, 0.4, 0.8], bottom: [0.7, 0.8, 0.9] },
    fog: { color: [0.7, 0.75, 0.8], near: 60, far: 600 },
    sunDirection: { x: 0.6, y: 0.8, z: 0 }, // |v| === 1 exactly
    ambient: 0.35,
    edgeMarkers: {
      spacing: 12,
      height: 1,
      offset: 1.5,
      colors: [
        [0.95, 0.95, 0.95],
        [0.85, 0.1, 0.1],
      ],
    },
  }
}

export function makeCharacterDescriptorFixture(): CharacterDescriptor {
  return {
    id: 'test-racer',
    name: 'Test Racer',
    bodyHeight: 1,
    bodyRadius: 0.3,
    headRadius: 0.22,
    palette: {
      primary: [0.9, 0.2, 0.2],
      secondary: [0.95, 0.8, 0.6],
      accent: [0.1, 0.1, 0.15],
    },
    silhouette: 'compact',
  }
}

export function makeKartDescriptorFixture(): KartDescriptor {
  return {
    id: 'test-kart',
    name: 'Test Kart',
    chassisLength: 1.8,
    chassisWidth: 1.2,
    chassisHeight: 0.5,
    wheelRadius: 0.3,
    wheelWidth: 0.2,
    palette: {
      body: [0.2, 0.4, 0.9],
      trim: [0.95, 0.95, 0.2],
      wheel: [0.08, 0.08, 0.09],
    },
  }
}
```

Install the new workspace member and its one runtime dependency, from the repo root:

```bash
npm install
```

`three@0.180.0` is the repository's second runtime dependency and is pinned exactly.
**Nothing in this task's tests imports it** — the only `three` import in the repository
arrives with `src/three/renderer.ts` in a later task — so if the registry is
unreachable, declare the dependency, note it in the task report, and continue: the
suite is green either way. What `npm install` is actually needed for here is the
`node_modules/@tapkart/render` workspace symlink that later packages resolve.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/render/test`
Expected: PASS — 27 tests (15 in `types.test.ts`, 12 in `fixtures.test.ts`, six of which
are the `it.each` over the shipped tracks).

Then, both of these must be clean:

```bash
npm run typecheck --workspace @tapkart/render
npx vitest run
```

The second is the whole repository: this task adds a package to a suite that was green
before, and a `lib`-widening mistake in `tsconfig.base.json` (rather than in this
package's own tsconfig) shows up as `sim` suddenly compiling against DOM types.

- [ ] **Step 5: Commit**

```bash
git add packages/render/package.json packages/render/tsconfig.json \
        packages/render/src packages/render/test package.json package-lock.json && \
git commit -m "feat(render): scaffold @tapkart/render and the view structs

- three pinned at exactly 0.180.0 (Q10); DOM lib widened in this package only (R35)
- src/types.ts: KartView/EntityView/ItemBoxView/RaceView, createRaceView,
  viewSourceViolations in §7.1's exact message format
- test/fixtures/render-fixtures.ts: the §9.1 fixture surface, including
  loadShippedTrack reading the real content/tracks JSON with node:fs (Q34)"
```

---

### Task 8: `src/mesh.ts` — track geometry, pure

The road ribbon, the boost-pad and ramp decals, the checkpoint gates and Q20's
procedural edge markers. All pure, all built once per race, none of them touching a
DOM, a GPU, a clock or `three`.

**`buildTrackMesh` is the sole producer of road-surface geometry.** Nothing else emits
triangles for the drivable surface, in any module, ever. That is what spec §3's "the
collision surface cannot drift from what the player sees" reduces to in code — and,
unusually, it is *assertable*: every generated vertex's `y` must equal
`query.groundHeight(s, lateral)` for its own `(s, lateral)`, to **`1e-3` world units**
(ruling Q31 — 1 mm, stated once in the contract precisely so two tasks do not pick two
tolerances).

**The tests run against the six shipped tracks, and that is required, not permitted
(ruling Q34).** `packages/render/test/` reads `content/tracks/*.json` from disk with
`node:fs` through the Task 7 fixture. Mesh-testing only a synthetic oval would mean the
six tracks players actually drive are never checked against the mesh generator at all.
This is not hypothetical: the track pipeline's own gates found a 1.3 m self-overlap in
`glacier-pass` precisely because they ran against real content instead of a fixture.
The six also carry the awkward cases a fixture would not — signed banking to ±0.35 rad
on `caldera`, **zero ramps** on `neon-district`, control-point `y` climbing 0 → 22 m on
`redwood-rise`, and widths from 15 m to 26 m.

**Contract amendment applied here (item boxes were undrawable).** `RenderFrame` carries
`itemBoxAlpha` (Q29's ghosting) so the adapter knows *how* to draw each box, but nothing
in the locked surface said *where* one is — so as written, the pickup the whole item
system depends on could not be drawn at all. `TrackScene` therefore gains
**`itemBoxes: Vec3[]`**, filled from `sim`'s `itemBoxWorldPos` at mesh-build time and
indexed so `itemBoxes[i]` and `itemBoxAlpha[i]` are the same box. They are static track
furniture — the positions come from track data and never move — so they belong to the
per-track scene, not the per-frame `RenderFrame`.

That forces one signature change, stated here rather than hidden: **`buildTrackScene`
takes `ctx: SimContext` in place of `(track, query)`.** `itemBoxWorldPos(ctx, boxIdx,
out)` is `sim`'s and is the **sole writer** of item-box world positions (§7.2) — the
drawn box and the pickup volume must be one object — and it needs a `SimContext`.
Re-deriving the formula in `render` would be exactly the second copy that rule exists to
prevent, and a cast to fake a context would break the moment `itemBoxWorldPos` reads
another field. `SimContext` carries both `track` and `query`, so the new signature is
also strictly narrower: it is no longer possible to hand this function a query built for
a different track. Every other builder keeps `(track, query, …)`.

**Vertex colours are the single source of track colour, and this file is the sole
writer.** `buildTrackMesh`, `buildBoostPadMesh` and `buildRampMesh` are handed no theme
(§4.3 pins their signatures) so they write the multiplicative identity `1,1,1`;
`buildTrackScene` then lands the palette on **every** mesh it returns — road, dirt,
shoulder and wall per vertex, boost pads `theme.roadDirt`, ramps `theme.shoulder`. The
adapter's materials are `vertexColors: true` over a white base and set no palette of
their own. Two reasons this side wins: `vertexColors: true` *multiplies*
`material.color` by the vertex colour, so a palette applied in both places ships the road
at `theme.road` squared — a 0.18 grey as 0.032, near-black; and "a boost pad is
dirt-coloured" is a game decision, which §0a forbids the adapter from holding and §8.2
keeps out of CI's reach entirely. One code path colours everything, and a mesh kind added
later cannot be forgotten by it.

**`s` is arc-normalised `[0, 1)`, never metres.** The spline helpers (`splinePointAt`,
`widthAtSeg`, `bankingAtSeg`, `surfaceOfSeg`) take `t`, a *segment parameter* whose
integer part selects the control point; `TrackQuery`'s methods take `s`. Mesh generation
walks `t` because it wants even geometry per segment; the test converts with
`s = arcAt(table, t) / table.total`. Mixing them silently produces a track mesh that does
not match the collision surface — the exact failure spec §3 says cannot happen.

**Files:**
- Create: `packages/render/src/mesh.ts`
- Modify: `packages/render/src/index.ts:9-10` (append one `export *` line after `export * from './types'`)
- Test: `packages/render/test/mesh.test.ts`

**Interfaces:**

- Consumes, from `@tapkart/sim`:
  ```ts
  export type Vec3 = { x: number; y: number; z: number }
  export type Surface = 'tarmac' | 'dirt' | 'boost' | 'offtrack'
  export interface TrackPoint { position: Vec3; width: number; banking: number; surface: Surface }
  export interface Track { id: string; name: string; controlPoints: TrackPoint[]
    checkpointS: number[]; itemBoxes: { s: number; lateral: number }[]
    ramps: { sStart: number; sEnd: number; launch: number }[]
    boostPads: { s: number; lateral: number; halfWidth: number }[]
    startPositions: { s: number; lateral: number }[]; bounds: { min: Vec3; max: Vec3 } }
  export interface TrackQuery {
    sampleAt(s: number): TrackPoint          // SCRATCH: same object every call
    tangentAt(s: number): Vec3               // SCRATCH: same object every call
    project(p: Vec3): TrackProjection        // SCRATCH: same object every call
    groundHeight(s: number, lateral: number): number
    surfaceAt(s: number, lateral: number): Surface
    isInBounds(s: number, lateral: number): boolean
    checkpointIndexAt(s: number): number
    totalLength(): number
  }
  export function splinePointAt(track: Track, t: number, out: Vec3): void
  export function splineTangentAt(track: Track, t: number, out: Vec3): void
  export function widthAtSeg(track: Track, t: number): number
  export function bankingAtSeg(track: Track, t: number): number
  export function surfaceOfSeg(track: Track, t: number): Surface
  export function buildTrackQuery(track: Track): TrackQuery
  export interface ArcTable { pts: Float64Array; cum: Float64Array
    samplesPerSegment: number; segments: number; total: number }
  export function buildArcTable(track: Track): ArcTable
  export function arcAt(table: ArcTable, t: number): number     // t -> METRES from the start line
  export const BOOST_PAD_HALF_LENGTH = 4                        // metres of centreline
  export interface SimContext { track: Track; query: TrackQuery; tuning: Tuning
    characters: CharacterStats[]; isLeader: boolean }
  /** Writes into `out` and returns void. Writes out.y = the CENTRELINE height, not
   *  groundHeight(s, lateral) — item boxes sit at centreline height even on banked
   *  track, and pickup is plan-view. Calls sampleAt and tangentAt internally, so it
   *  invalidates the shared scratch. SOLE WRITER of item-box world position (§7.2):
   *  the drawn box and the pickup volume are the same object. */
  export function itemBoxWorldPos(ctx: SimContext, boxIdx: number, out: Vec3): void
  ```
- Consumes, by **relative path** from the test only (contract §2.6):
  ```ts
  // packages/sim/test/fixtures/track-fixtures.ts
  export function makeContext(track: Track, isLeader?: boolean): SimContext
  ```
  and the identity the flagship assertion is written against, verbatim from
  `packages/sim/src/track.ts:491-496`:
  ```ts
  groundHeight(s, lateral) = splinePointAt(track, locateS(table, s)).y
                           + lateral * Math.tan(bankingAtSeg(track, locateS(table, s)))
  ```
- Consumes, from `@tapkart/content` (contract §3a.4, an earlier task) — types only:
  ```ts
  export type PaletteRGB = readonly [number, number, number]   // linear, 0..1
  export interface EdgeMarkerParams { spacing: number; height: number; offset: number
    colors: readonly [PaletteRGB, PaletteRGB] }
  export interface TrackTheme { trackId: string; road: PaletteRGB; roadDirt: PaletteRGB
    shoulder: PaletteRGB; wall: PaletteRGB; ground: PaletteRGB
    sky: { top: PaletteRGB; bottom: PaletteRGB }
    fog: { color: PaletteRGB; near: number; far: number }
    sunDirection: Vec3; ambient: number; edgeMarkers: EdgeMarkerParams }
  ```
- Consumes, from `packages/render/test/fixtures/render-fixtures` (Task 7, test-only):
  ```ts
  export const SHIPPED_TRACK_IDS: readonly string[]        // the six, ascending
  export function loadShippedTrack(id: string): Track      // node:fs + validateTrack
  export function makeThemeFixture(): TrackTheme           // road/roadDirt/shoulder all differ
  ```
- Produces — the 15 exports of `render/mesh` (contract §11's census for this module):
  ```ts
  export interface MeshData { positions: Float32Array; normals: Float32Array
    uvs: Float32Array; colors: Float32Array; indices: Uint32Array }
  export interface MeshBuildOptions { ringsPerSegment: number; lateralSteps: number
    shoulderWidth: number; wallHeight: number }
  export const DEFAULT_MESH_OPTIONS: Readonly<MeshBuildOptions>
  export function buildTrackMesh(track: Track, opts: MeshBuildOptions): MeshData
  export function buildBoostPadMesh(track: Track, query: TrackQuery): MeshData
  export function buildRampMesh(track: Track, query: TrackQuery, opts: MeshBuildOptions): MeshData
  export const ROAD_DECAL_LIFT = 0.02
  export interface MarkerPlacement { s: number; position: Vec3; heading: number; width: number }
  export function buildCheckpointMarkers(track: Track, query: TrackQuery): MarkerPlacement[]
  export interface EdgeMarkerPlacement { s: number; position: Vec3; heading: number
    side: -1 | 1; colorIdx: 0 | 1 }
  export function buildEdgeMarkers(track: Track, query: TrackQuery,
                                   params: EdgeMarkerParams): EdgeMarkerPlacement[]
  export interface TrackScene { road: MeshData; boostPads: MeshData; ramps: MeshData
    checkpoints: MarkerPlacement[]; edgeMarkers: EdgeMarkerPlacement[]
    itemBoxes: Vec3[]                    // one per track.itemBoxes, SAME INDEX as
                                         // RenderFrame.itemBoxAlpha and ItemBoxView.boxIdx
    bounds: { min: Vec3; max: Vec3 } }
  export function buildTrackScene(ctx: SimContext, theme: TrackTheme,
                                  opts: MeshBuildOptions): TrackScene
  export function meshBounds(mesh: MeshData): { min: Vec3; max: Vec3 }
  export function meshCounts(meshes: readonly MeshData[]): { vertices: number; triangles: number }
  ```

**Vertex layout, pinned by §4.3 and re-derived independently by the test:**
`buildTrackMesh` emits `controlPoints.length * ringsPerSegment` rings, ring `r` at
segment parameter `t = r / ringsPerSegment`, each ring holding `lateralSteps + 1`
vertices from `lateral = -(width/2 + shoulderWidth)` to `+(width/2 + shoulderWidth)`
inclusive, evenly spaced. The ribbon is closed: the last ring connects back to ring 0.
Vertex index is `ring * (lateralSteps + 1) + step`, and that index arithmetic is what
the test inverts to recover `(s, lateral)` for each vertex.

---

- [ ] **Step 1: Write the failing test**

Create `packages/render/test/mesh.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import type { Track, Vec3 } from '@tapkart/sim'
import {
  BOOST_PAD_HALF_LENGTH,
  arcAt,
  bankingAtSeg,
  buildArcTable,
  buildTrackQuery,
  itemBoxWorldPos,
  splinePointAt,
  surfaceOfSeg,
  widthAtSeg,
} from '@tapkart/sim'
// §2.6: sim's fixtures are outside @tapkart/sim's `exports` map, so a TEST reaches them
// by relative path. `src` never does.
import { makeContext } from '../../sim/test/fixtures/track-fixtures'

import type { MeshData, MeshBuildOptions } from '../src/mesh'
import {
  DEFAULT_MESH_OPTIONS,
  ROAD_DECAL_LIFT,
  buildBoostPadMesh,
  buildCheckpointMarkers,
  buildEdgeMarkers,
  buildRampMesh,
  buildTrackMesh,
  buildTrackScene,
  meshBounds,
  meshCounts,
} from '../src/mesh'
import { SHIPPED_TRACK_IDS, loadShippedTrack, makeThemeFixture } from './fixtures/render-fixtures'

// String rows, so `it.each` passes each id as one argument. Never write an `it.each`
// table whose rows are arrays unless you mean them to be spread: `it.each([[], 42])`
// hands the `[]` row ZERO arguments and silently re-tests `undefined`. Labelled
// `[name, value]` rows are the form to reach for.
const IDS = [...SHIPPED_TRACK_IDS]

/**
 * Independent re-derivation of §4.3's pinned cross-section. The builder's own copy of
 * this arithmetic is module-private, so this is a second path rather than the same one:
 * if the builder spaces its steps differently, the y-vs-groundHeight assertion below
 * starts comparing a vertex against the ground height of a different lateral and fails.
 */
function lateralOf(track: Track, t: number, step: number, opts: MeshBuildOptions): number {
  const halfSpan = widthAtSeg(track, t) / 2 + opts.shoulderWidth
  return -halfSpan + (2 * halfSpan * step) / opts.lateralSteps
}

function smallestTriangleArea(mesh: MeshData): number {
  let smallest = Infinity
  const p = mesh.positions
  for (let k = 0; k < mesh.indices.length; k += 3) {
    const a = mesh.indices[k] * 3
    const b = mesh.indices[k + 1] * 3
    const c = mesh.indices[k + 2] * 3
    const ux = p[b] - p[a]
    const uy = p[b + 1] - p[a + 1]
    const uz = p[b + 2] - p[a + 2]
    const vx = p[c] - p[a]
    const vy = p[c + 1] - p[a + 1]
    const vz = p[c + 2] - p[a + 2]
    const area = 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx)
    if (area < smallest) smallest = area
  }
  return smallest
}

describe('DEFAULT_MESH_OPTIONS', () => {
  // Stated numerically in §4.3 so two tasks cannot disagree about what "default" means.
  it('is exactly the four numbers the contract states', () => {
    expect(DEFAULT_MESH_OPTIONS).toEqual({
      ringsPerSegment: 8,
      lateralSteps: 6,
      shoulderWidth: 6,
      wallHeight: 0,
    })
  })
  it('ROAD_DECAL_LIFT is 0.02 m', () => {
    expect(ROAD_DECAL_LIFT).toBe(0.02)
  })
})

describe('buildTrackMesh over the six shipped tracks (Q34)', () => {
  it('exercises all six, so an empty id list cannot make this suite vacuous', () => {
    expect(IDS.length).toBe(6)
  })

  it.each(IDS)('%s: vertex and index counts match the pinned layout', (id) => {
    const track = loadShippedTrack(id)
    const opts = DEFAULT_MESH_OPTIONS
    const mesh = buildTrackMesh(track, opts)
    const rings = track.controlPoints.length * opts.ringsPerSegment
    const perRing = opts.lateralSteps + 1
    expect(mesh.positions.length).toBe(rings * perRing * 3)
    expect(mesh.normals.length).toBe(rings * perRing * 3)
    expect(mesh.colors.length).toBe(rings * perRing * 3)
    expect(mesh.uvs.length).toBe(rings * perRing * 2)
    // closed ribbon: the last ring connects back to ring 0, so it is `rings` bands, not
    // `rings - 1`. A builder that stops one ring short leaves a seam across the track.
    expect(mesh.indices.length).toBe(rings * opts.lateralSteps * 6)
    expect(mesh.indices instanceof Uint32Array).toBe(true)
  })

  /**
   * THE FLAGSHIP ASSERTION (§8.1 row 1, tolerance from Q31).
   *
   * The bug it catches: building the banked cross-section as a ROTATION about the
   * tangent (y = lateral * sin(banking)) instead of sim's LIFT (y = lateral *
   * tan(banking)). Both look plausible; only one matches the collision surface. On
   * caldera's 0.35 rad corners the two differ by 0.34 m at the outer edge — 340x this
   * tolerance — so the assertion fails hard rather than marginally. The next test
   * measures that difference explicitly, so this tolerance is never mistaken for one
   * that would pass anything.
   *
   * It also catches every s-vs-t confusion, because `s` here is arc-normalised and
   * `t` is a segment parameter running 0..controlPoints.length: swap them and the
   * lookup lands on a different part of the track entirely.
   *
   * Measured worst deviation over the six shipped tracks: 9.4e-7 m (Float32 storage
   * rounding), a thousandfold inside the gate.
   */
  it.each(IDS)('%s: every vertex y equals query.groundHeight(s, lateral) to 1e-3', (id) => {
    const track = loadShippedTrack(id)
    const query = buildTrackQuery(track)
    const table = buildArcTable(track)
    const opts = DEFAULT_MESH_OPTIONS
    const mesh = buildTrackMesh(track, opts)
    const rings = track.controlPoints.length * opts.ringsPerSegment
    const perRing = opts.lateralSteps + 1

    let worst = 0
    for (let r = 0; r < rings; r++) {
      const t = r / opts.ringsPerSegment
      // arcAt returns METRES; s is arc-normalised [0, 1). The division is not optional.
      const s = arcAt(table, t) / table.total
      for (let i = 0; i < perRing; i++) {
        const lateral = lateralOf(track, t, i, opts)
        const y = mesh.positions[(r * perRing + i) * 3 + 1]
        const d = Math.abs(y - query.groundHeight(s, lateral))
        if (d > worst) worst = d
      }
    }
    expect(worst).toBeLessThan(1e-3)
  })

  // Proof that the gate above discriminates. Without this, "worst < 1e-3" is a claim
  // about float noise that nobody has checked can ever be violated.
  it('a rotated cross-section (sin instead of tan) misses the gate by two orders of magnitude', () => {
    const track = loadShippedTrack('caldera') // the steepest shipped banking, +/-0.35 rad
    const query = buildTrackQuery(track)
    const table = buildArcTable(track)
    const opts = DEFAULT_MESH_OPTIONS
    const centre = { x: 0, y: 0, z: 0 }
    let worstWrong = 0
    const rings = track.controlPoints.length * opts.ringsPerSegment
    for (let r = 0; r < rings; r++) {
      const t = r / opts.ringsPerSegment
      splinePointAt(track, t, centre)
      const s = arcAt(table, t) / table.total
      const bank = bankingAtSeg(track, t)
      for (let i = 0; i <= opts.lateralSteps; i++) {
        const lateral = lateralOf(track, t, i, opts)
        const wrongY = centre.y + lateral * Math.sin(bank) // the plausible wrong model
        const d = Math.abs(wrongY - query.groundHeight(s, lateral))
        if (d > worstWrong) worstWrong = d
      }
    }
    expect(worstWrong).toBeGreaterThan(0.1) // measured: 0.343 m
  })

  /**
   * §7.3's scratch-object trap: `query.sampleAt` and `tangentAt` return the SAME object
   * on every call. A builder that holds two samples at once gets one degenerate ring
   * after another and throws nothing — the mesh is simply collapsed. Zero-area
   * triangles are what that looks like from outside.
   */
  it.each(IDS)('%s: every triangle has non-zero area', (id) => {
    const mesh = buildTrackMesh(loadShippedTrack(id), DEFAULT_MESH_OPTIONS)
    expect(smallestTriangleArea(mesh)).toBeGreaterThan(1e-6)
  })

  /**
   * Q19: `track.bounds` is a RENDER extent — `validateTrack` only asserts it encloses
   * the control points, and `sim` never uses it for containment (that is
   * `width * BOUNDS_HALF_WIDTH_MUL` in recovery.ts). So the ribbon must fit inside it,
   * and the ~40 m of clearance on every shipped track is what makes this a real test.
   *
   * The vacuity guard matters more than the containment: `meshBounds` of an EMPTY mesh
   * is min = +Infinity, max = -Infinity, which passes every containment comparison
   * trivially. Finiteness and a non-trivial extent are asserted first, so a builder
   * that emits nothing fails here instead of passing.
   */
  it.each(IDS)('%s: meshBounds(road) is finite, substantial, and inside track.bounds', (id) => {
    const track = loadShippedTrack(id)
    const b = meshBounds(buildTrackMesh(track, DEFAULT_MESH_OPTIONS))
    for (const v of [b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z]) {
      expect(Number.isFinite(v)).toBe(true)
    }
    expect(b.max.x - b.min.x).toBeGreaterThan(100)
    expect(b.max.z - b.min.z).toBeGreaterThan(100)
    expect(b.min.x).toBeGreaterThanOrEqual(track.bounds.min.x)
    expect(b.min.y).toBeGreaterThanOrEqual(track.bounds.min.y)
    expect(b.min.z).toBeGreaterThanOrEqual(track.bounds.min.z)
    expect(b.max.x).toBeLessThanOrEqual(track.bounds.max.x)
    expect(b.max.y).toBeLessThanOrEqual(track.bounds.max.y)
    expect(b.max.z).toBeLessThanOrEqual(track.bounds.max.z)
  })

  it('meshBounds of an empty mesh is +Infinity / -Infinity', () => {
    const empty: MeshData = {
      positions: new Float32Array(0),
      normals: new Float32Array(0),
      uvs: new Float32Array(0),
      colors: new Float32Array(0),
      indices: new Uint32Array(0),
    }
    expect(meshBounds(empty)).toEqual({
      min: { x: Infinity, y: Infinity, z: Infinity },
      max: { x: -Infinity, y: -Infinity, z: -Infinity },
    })
  })

  it.each(IDS)('%s: every normal is unit length', (id) => {
    const mesh = buildTrackMesh(loadShippedTrack(id), DEFAULT_MESH_OPTIONS)
    let worst = 0
    for (let i = 0; i < mesh.normals.length; i += 3) {
      const len = Math.hypot(mesh.normals[i], mesh.normals[i + 1], mesh.normals[i + 2])
      worst = Math.max(worst, Math.abs(len - 1))
    }
    expect(worst).toBeLessThan(1e-5)
  })

  // wallHeight 0 disables the pass; anything above it appends geometry AFTER the ribbon
  // so the pinned layout — and therefore the assertion above — still holds.
  it('a wall pass appends without disturbing one byte of the ribbon', () => {
    const track = loadShippedTrack('harbor-run')
    const flat = buildTrackMesh(track, DEFAULT_MESH_OPTIONS)
    const walled = buildTrackMesh(track, { ...DEFAULT_MESH_OPTIONS, wallHeight: 2 })
    const rings = track.controlPoints.length * DEFAULT_MESH_OPTIONS.ringsPerSegment
    const ribbonVerts = rings * (DEFAULT_MESH_OPTIONS.lateralSteps + 1)
    expect(walled.positions.length).toBe((ribbonVerts + rings * 4) * 3)
    for (let i = 0; i < ribbonVerts * 3; i++) {
      expect(walled.positions[i]).toBe(flat.positions[i])
    }
    for (let i = 0; i < flat.indices.length; i++) expect(walled.indices[i]).toBe(flat.indices[i])
    // every wall top sits exactly wallHeight above its own bottom
    for (let v = ribbonVerts; v < ribbonVerts + rings * 4; v += 2) {
      expect(walled.positions[(v + 1) * 3 + 1] - walled.positions[v * 3 + 1]).toBeCloseTo(2, 4)
      expect(walled.positions[(v + 1) * 3]).toBe(walled.positions[v * 3])
      expect(walled.positions[(v + 1) * 3 + 2]).toBe(walled.positions[v * 3 + 2])
    }
  })
})

describe('buildBoostPadMesh', () => {
  it.each(IDS)('%s: one quad per pad, lifted off the road', (id) => {
    const track = loadShippedTrack(id)
    const query = buildTrackQuery(track)
    const mesh = buildBoostPadMesh(track, query)
    const n = track.boostPads.length
    expect(n).toBeGreaterThan(0) // every shipped track has pads; §3's table
    expect(mesh.positions.length).toBe(n * 4 * 3)
    expect(mesh.indices.length).toBe(n * 6)
    expect(smallestTriangleArea(mesh)).toBeGreaterThan(1e-6)
  })

  /**
   * The bug: forgetting ROAD_DECAL_LIFT. A decal coplanar with the road z-fights, which
   * CI can never see and a device always can. The second half — that the pad sits at the
   * ground height for its OWN lateral, not the centreline's — catches a pad drawn flat
   * across a banked corner, which floats one edge into the air.
   */
  it('every corner sits exactly ROAD_DECAL_LIFT above its own ground height', () => {
    const track = loadShippedTrack('caldera')
    const query = buildTrackQuery(track)
    const mesh = buildBoostPadMesh(track, query)
    const halfS = BOOST_PAD_HALF_LENGTH / query.totalLength()
    for (let p = 0; p < track.boostPads.length; p++) {
      const pad = track.boostPads[p]
      for (let c = 0; c < 4; c++) {
        const sSide = c < 2 ? -1 : 1
        const lSide = c === 1 || c === 2 ? 1 : -1
        let s = pad.s + sSide * halfS
        s -= Math.floor(s)
        const lateral = pad.lateral + lSide * pad.halfWidth
        const y = mesh.positions[(p * 4 + c) * 3 + 1]
        expect(y - query.groundHeight(s, lateral)).toBeCloseTo(ROAD_DECAL_LIFT, 4)
      }
    }
  })
})

describe('buildRampMesh', () => {
  // neon-district ships ZERO ramps. A builder that assumes at least one produces a
  // zero-length buffer or throws; the contract says five zero-length arrays, no throw.
  it('neon-district has no ramps and yields five zero-length arrays', () => {
    const track = loadShippedTrack('neon-district')
    expect(track.ramps.length).toBe(0)
    const mesh = buildRampMesh(track, buildTrackQuery(track), DEFAULT_MESH_OPTIONS)
    expect(mesh.positions.length).toBe(0)
    expect(mesh.normals.length).toBe(0)
    expect(mesh.uvs.length).toBe(0)
    expect(mesh.colors.length).toBe(0)
    expect(mesh.indices.length).toBe(0)
  })

  it.each(IDS)('%s: one subdivided patch per ramp, on the road surface', (id) => {
    const track = loadShippedTrack(id)
    const query = buildTrackQuery(track)
    const opts = DEFAULT_MESH_OPTIONS
    const mesh = buildRampMesh(track, query, opts)
    const strips = opts.ringsPerSegment
    expect(mesh.positions.length).toBe(track.ramps.length * (strips + 1) * 2 * 3)
    expect(mesh.indices.length).toBe(track.ramps.length * strips * 6)
    if (track.ramps.length > 0) expect(smallestTriangleArea(mesh)).toBeGreaterThan(1e-6)
    // every vertex is a decal on the road: ground height for its own lateral, plus lift
    for (let r = 0; r < track.ramps.length; r++) {
      const ramp = track.ramps[r]
      let span = ramp.sEnd - ramp.sStart
      if (span <= 0) span += 1
      for (let k = 0; k <= strips; k++) {
        let s = ramp.sStart + (span * k) / strips
        s -= Math.floor(s)
        const width = query.sampleAt(s).width
        for (let side = 0; side < 2; side++) {
          const lateral = (side === 0 ? -1 : 1) * (width / 2)
          const vi = r * (strips + 1) * 2 + k * 2 + side
          expect(mesh.positions[vi * 3 + 1] - query.groundHeight(s, lateral)).toBeCloseTo(
            ROAD_DECAL_LIFT,
            4,
          )
        }
      }
    }
  })
})

describe('buildCheckpointMarkers', () => {
  it.each(IDS)('%s: one per checkpointS, index 0 is the finish line', (id) => {
    const track = loadShippedTrack(id)
    const query = buildTrackQuery(track)
    const marks = buildCheckpointMarkers(track, query)
    expect(marks.length).toBe(track.checkpointS.length)
    expect(marks[0].s).toBe(track.checkpointS[0])
    for (let i = 0; i < marks.length; i++) {
      const s = track.checkpointS[i]
      expect(marks[i].s).toBe(s)
      // on the centreline, so y is exactly groundHeight(s, 0)
      expect(marks[i].position.y).toBeCloseTo(query.groundHeight(s, 0), 4)
      expect(marks[i].width).toBeCloseTo(query.sampleAt(s).width, 4)
      // heading is the centreline tangent's: forward = (cos h, 0, sin h)
      const tan = query.tangentAt(s)
      expect(Math.cos(marks[i].heading)).toBeCloseTo(tan.x / Math.hypot(tan.x, tan.z), 3)
      expect(Math.sin(marks[i].heading)).toBeCloseTo(tan.z / Math.hypot(tan.x, tan.z), 3)
    }
  })
})

describe('buildEdgeMarkers (Q20)', () => {
  it.each(IDS)('%s: both sides, alternating colours, standing on the ground', (id) => {
    const track = loadShippedTrack(id)
    const query = buildTrackQuery(track)
    const params = makeThemeFixture().edgeMarkers
    const posts = buildEdgeMarkers(track, query, params)

    const expected = Math.round(query.totalLength() / params.spacing)
    const left = posts.filter((p) => p.side === -1)
    const right = posts.filter((p) => p.side === 1)
    expect(Math.abs(left.length - expected)).toBeLessThanOrEqual(1)
    expect(right.length).toBe(left.length)
    expect(left.length).toBeGreaterThan(10)

    // colorIdx alternates 0,1,0,1... from 0 at s = 0, along each edge INDEPENDENTLY
    for (const side of [left, right]) {
      for (let i = 0; i < side.length; i++) expect(side[i].colorIdx).toBe((i % 2) as 0 | 1)
      for (let i = 1; i < side.length; i++) expect(side[i].s).toBeGreaterThan(side[i - 1].s)
    }

    /**
     * The bug this catches: placing posts at the centreline height, i.e. ignoring
     * banking. On caldera a post sits ~9.6 m off-centre where banking is 0.35 rad, so
     * it would float 3.5 m above the road — the single most visible geometry defect
     * available, and invisible to any test that only counted posts.
     */
    for (const p of posts) {
      const lateral = p.side * (query.sampleAt(p.s).width / 2 + params.offset)
      expect(Math.abs(p.position.y - query.groundHeight(p.s, lateral))).toBeLessThan(1e-3)
    }
  })

  it('is outboard of the road, on the correct side of travel', () => {
    const track = loadShippedTrack('neon-district') // zero banking, so the check is clean
    const query = buildTrackQuery(track)
    const posts = buildEdgeMarkers(track, query, makeThemeFixture().edgeMarkers)
    for (const p of posts.slice(0, 40)) {
      const pt = query.sampleAt(p.s)
      const cx = pt.position.x
      const cz = pt.position.z
      const half = pt.width / 2
      const tan = query.tangentAt(p.s)
      const rl = Math.hypot(-tan.z, tan.x)
      const rx = -tan.z / rl
      const rz = tan.x / rl
      // positive lateral is right of travel: right = (-t.z, 0, t.x) normalised
      const lateral = (p.position.x - cx) * rx + (p.position.z - cz) * rz
      expect(Math.sign(lateral)).toBe(p.side)
      expect(Math.abs(lateral)).toBeGreaterThan(half) // outboard of the drivable surface
    }
  })
})

describe('buildTrackScene', () => {
  it.each(IDS)('%s: assembles every pass and reports the MESH bounds, not track.bounds', (id) => {
    const track = loadShippedTrack(id)
    const theme = makeThemeFixture()
    const scene = buildTrackScene(makeContext(track), theme, DEFAULT_MESH_OPTIONS)
    expect(scene.checkpoints.length).toBe(track.checkpointS.length)
    expect(scene.boostPads.positions.length).toBe(track.boostPads.length * 12)
    expect(scene.ramps.indices.length).toBe(
      track.ramps.length * DEFAULT_MESH_OPTIONS.ringsPerSegment * 6,
    )
    expect(scene.edgeMarkers.length).toBeGreaterThan(20)
    // Q19 again: this is meshBounds(road), which is strictly inside track.bounds
    expect(scene.bounds).toEqual(meshBounds(scene.road))
    expect(scene.bounds.max.x).toBeLessThan(track.bounds.max.x)
  })

  /**
   * The bug: leaving the road white. `buildTrackMesh` is handed no theme (§4.3's
   * signature) so it writes the multiplicative identity 1,1,1; `buildTrackScene` is
   * where the palette lands. Without this test the whole road ships untinted and every
   * count-based assertion above still passes. caldera carries both tarmac and dirt
   * control points, so all three colours must appear.
   */
  it('caldera: road, dirt and shoulder vertices each carry their own theme colour', () => {
    const track = loadShippedTrack('caldera')
    const theme = makeThemeFixture()
    const opts = DEFAULT_MESH_OPTIONS
    const scene = buildTrackScene(makeContext(track), theme, opts)
    const rings = track.controlPoints.length * opts.ringsPerSegment
    const perRing = opts.lateralSteps + 1
    let sawRoad = 0
    let sawDirt = 0
    let sawShoulder = 0
    for (let r = 0; r < rings; r++) {
      const t = r / opts.ringsPerSegment
      const half = widthAtSeg(track, t) / 2
      const dirt = surfaceOfSeg(track, t) === 'dirt'
      for (let i = 0; i < perRing; i++) {
        const lateral = lateralOf(track, t, i, opts)
        const vi = r * perRing + i
        const got = [
          scene.road.colors[vi * 3],
          scene.road.colors[vi * 3 + 1],
          scene.road.colors[vi * 3 + 2],
        ]
        let want: readonly number[]
        if (Math.abs(lateral) > half) {
          want = theme.shoulder
          sawShoulder++
        } else if (dirt) {
          want = theme.roadDirt
          sawDirt++
        } else {
          want = theme.road
          sawRoad++
        }
        expect(got[0]).toBeCloseTo(want[0], 5)
        expect(got[1]).toBeCloseTo(want[1], 5)
        expect(got[2]).toBeCloseTo(want[2], 5)
      }
    }
    expect(sawRoad).toBeGreaterThan(0)
    expect(sawDirt).toBeGreaterThan(0)
    expect(sawShoulder).toBeGreaterThan(0)
  })

  /**
   * The other half of the same bug: pads and ramps left at the identity 1,1,1 and
   * coloured by the adapter's material instead. That ships the *right pixels* — white
   * times a material colour is that colour — so nothing looks wrong, and what actually
   * breaks is that "a boost pad is dirt-coloured" ends up living in the one file CI
   * never imports (§8.2), where the next mesh kind gets added without one. One code
   * path colours everything, here, and this is what holds it there.
   *
   * caldera carries 2 pads and 3 ramps; `makeThemeFixture` guarantees roadDirt and
   * shoulder differ, so a pass that coloured both from one field fails.
   */
  it('caldera: boost pads and ramps carry their own theme colour, not the identity', () => {
    const track = loadShippedTrack('caldera')
    const theme = makeThemeFixture()
    const scene = buildTrackScene(makeContext(track), theme, DEFAULT_MESH_OPTIONS)

    expect(track.boostPads.length).toBeGreaterThan(0)
    expect(track.ramps.length).toBeGreaterThan(0)
    expect(theme.roadDirt).not.toEqual(theme.shoulder)

    const passes = [
      ['boostPads', scene.boostPads, theme.roadDirt],
      ['ramps', scene.ramps, theme.shoulder],
    ] as const
    for (const [label, mesh, want] of passes) {
      const vertexCount = mesh.positions.length / 3
      expect(`${label}:${vertexCount > 0}`).toBe(`${label}:true`)
      expect(mesh.colors.length).toBe(vertexCount * 3)
      for (let vi = 0; vi < vertexCount; vi++) {
        expect(mesh.colors[vi * 3]).toBeCloseTo(want[0], 5)
        expect(mesh.colors[vi * 3 + 1]).toBeCloseTo(want[1], 5)
        expect(mesh.colors[vi * 3 + 2]).toBeCloseTo(want[2], 5)
      }
    }
  })

  /** neon-district has no ramps, so the colouring pass must be a no-op over five
   *  zero-length arrays rather than a throw or a read of `colors[0]`. */
  it('neon-district: colouring an empty ramp pass is a no-op', () => {
    const track = loadShippedTrack('neon-district')
    expect(track.ramps.length).toBe(0)
    const scene = buildTrackScene(makeContext(track), makeThemeFixture(), DEFAULT_MESH_OPTIONS)
    expect(scene.ramps.colors.length).toBe(0)
    expect(scene.ramps.positions.length).toBe(0)
  })

  /**
   * Item-box positions, and specifically their INDEX correspondence with
   * `RenderFrame.itemBoxAlpha`. Asserting the two arrays are the same length proves
   * nothing — that is the shape this project has shipped sixteen times — so this asserts
   * position-for-position identity against sim's own `itemBoxWorldPos`, which is the sole
   * writer of a box's position and the reason the drawn box and the pickup volume cannot
   * drift apart.
   *
   * The off-by-one witness at the end is what makes it a pairing test rather than a set
   * test: shipped boxes are at least 2 m apart on every track (measured), so a scene that
   * filled the array in any other order fails.
   */
  it.each(IDS)('%s: itemBoxes[i] is box i, at the position sim computes', (id) => {
    const track = loadShippedTrack(id)
    const ctx = makeContext(track)
    const scene = buildTrackScene(ctx, makeThemeFixture(), DEFAULT_MESH_OPTIONS)
    const n = track.itemBoxes.length
    expect(n).toBeGreaterThan(15)
    expect(scene.itemBoxes.length).toBe(n)

    const expected: Vec3[] = []
    for (let i = 0; i < n; i++) {
      const p: Vec3 = { x: 0, y: 0, z: 0 }
      itemBoxWorldPos(ctx, i, p)
      expected.push(p)
      expect(scene.itemBoxes[i].x).toBeCloseTo(p.x, 6)
      expect(scene.itemBoxes[i].y).toBeCloseTo(p.y, 6)
      expect(scene.itemBoxes[i].z).toBeCloseTo(p.z, 6)
    }

    // distinct objects: one shared `out` Vec3 would leave every box at the last position
    scene.itemBoxes[0].x += 1000
    expect(scene.itemBoxes[1].x).toBeCloseTo(expected[1].x, 6)
    scene.itemBoxes[0].x -= 1000

    // an off-by-one ordering must be detectable, or the identity above proves nothing
    let shifted = 0
    for (let i = 0; i < n; i++) {
      const other = expected[(i + 1) % n]
      const d = Math.hypot(
        scene.itemBoxes[i].x - other.x,
        scene.itemBoxes[i].y - other.y,
        scene.itemBoxes[i].z - other.z,
      )
      if (d > 0.5) shifted++
    }
    expect(shifted).toBe(n)
  })
})

describe('meshCounts', () => {
  it('sums vertices and triangles across a set', () => {
    const track = loadShippedTrack('harbor-run')
    const query = buildTrackQuery(track)
    const road = buildTrackMesh(track, DEFAULT_MESH_OPTIONS)
    const pads = buildBoostPadMesh(track, query)
    const counts = meshCounts([road, pads])
    expect(counts.vertices).toBe(road.positions.length / 3 + pads.positions.length / 3)
    expect(counts.triangles).toBe(road.indices.length / 3 + pads.indices.length / 3)
    expect(meshCounts([])).toEqual({ vertices: 0, triangles: 0 })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/render/test/mesh.test.ts`

Expected: FAIL to collect, with
`Error: Cannot find module '../src/mesh' imported from '/home/kasm-user/tapkart/packages/render/test/mesh.test.ts'`
(caused by `Failed to load url ../src/mesh ... Does the file exist?`).

- [ ] **Step 3: Write the implementation**

Create `packages/render/src/mesh.ts`:

```ts
// PURE (contract §0a): no DOM, no GPU, no clock, no `three` import — not even a
// type-only one (§8.2). This module parses nothing and owns no data: `Track` and
// `TrackQuery` are sim's, `TrackTheme` and `EdgeMarkerParams` are content's, and all of
// them arrive as arguments. `content` is data + schema + parsers; `render` turns that
// data into triangles.
import type { SimContext, Track, TrackQuery, Vec3 } from '@tapkart/sim'
import {
  BOOST_PAD_HALF_LENGTH,
  bankingAtSeg,
  itemBoxWorldPos,
  splinePointAt,
  splineTangentAt,
  surfaceOfSeg,
  widthAtSeg,
} from '@tapkart/sim'
import type { EdgeMarkerParams, PaletteRGB, TrackTheme } from '@tapkart/content'

/** Plain, backend-agnostic geometry. 32-bit indices, so one MeshData per pass
 *  regardless of vertex count. */
export interface MeshData {
  positions: Float32Array // xyz triples, metres, world space
  normals: Float32Array // xyz triples, unit length
  uvs: Float32Array // uv pairs
  colors: Float32Array // rgb triples, linear 0..1
  indices: Uint32Array // triangle list, CCW front-facing
}

export interface MeshBuildOptions {
  ringsPerSegment: number // longitudinal subdivisions per control-point segment
  lateralSteps: number // cross-section subdivisions across the full width
  shoulderWidth: number // metres of run-off geometry beyond width/2, each side
  wallHeight: number // metres; 0 disables the wall pass
}

/** Stated numerically in the contract so two tasks cannot disagree about "default". */
export const DEFAULT_MESH_OPTIONS: Readonly<MeshBuildOptions> = {
  ringsPerSegment: 8,
  lateralSteps: 6,
  shoulderWidth: 6,
  wallHeight: 0,
}

/** Metres a decal (boost pad, ramp, start line) is lifted off the road to avoid
 *  z-fighting. */
export const ROAD_DECAL_LIFT = 0.02

export interface MarkerPlacement {
  s: number
  position: Vec3
  heading: number
  width: number
}

export interface EdgeMarkerPlacement {
  s: number
  position: Vec3
  heading: number // the centreline tangent's heading at that s
  side: -1 | 1 // -1 left edge, +1 right edge (+1 is +lateral)
  colorIdx: 0 | 1
}

export interface TrackScene {
  road: MeshData
  boostPads: MeshData
  ramps: MeshData
  checkpoints: MarkerPlacement[]
  edgeMarkers: EdgeMarkerPlacement[]
  /** One world position per `track.itemBoxes`, in the SAME index space as
   *  `RenderFrame.itemBoxAlpha` and `ItemBoxView.boxIdx`, so the adapter pairs a box
   *  with its ghost alpha by index and never looks anything up. Static track furniture:
   *  built once per track, never per frame. */
  itemBoxes: Vec3[]
  bounds: { min: Vec3; max: Vec3 } // meshBounds(road), NOT track.bounds (Q19)
}

/** Fractional part in [0, 1). `s` wraps: the track is a closed loop. */
function wrap01(s: number): number {
  const w = s - Math.floor(s)
  return w === 1 ? 0 : w
}

/** Unit right vector in XZ for a unit tangent: right = (-t.z, 0, t.x), normalised
 *  (contract §0). Positive lateral is right of travel. */
function rightVector(tan: Vec3, out: Vec3): void {
  let rx = -tan.z
  let rz = tan.x
  const len = Math.hypot(rx, rz)
  if (len > 1e-12) {
    rx /= len
    rz /= len
  } else {
    rx = 0
    rz = 1
  }
  out.x = rx
  out.y = 0
  out.z = rz
}

/** Surface normal of the banked ribbon: normalize(cross(L, T)) where L is the lateral
 *  direction (right.x, tan(banking), right.z) and T the unit tangent. Exactly +y on
 *  flat track. */
function surfaceNormal(right: Vec3, tan: Vec3, tanBank: number, out: Vec3): void {
  const lx = right.x
  const ly = tanBank
  const lz = right.z
  const nx = ly * tan.z - lz * tan.y
  const ny = lz * tan.x - lx * tan.z
  const nz = lx * tan.y - ly * tan.x
  const len = Math.hypot(nx, ny, nz)
  if (len > 1e-12) {
    out.x = nx / len
    out.y = ny / len
    out.z = nz / len
  } else {
    out.x = 0
    out.y = 1
    out.z = 0
  }
}

/** §4.3's pinned cross-section: `lateralSteps + 1` vertices from -halfSpan to +halfSpan
 *  inclusive, evenly spaced. Shared by the builder and the theme pass so the two cannot
 *  drift; the test re-derives it independently. */
function lateralAt(halfSpan: number, step: number, lateralSteps: number): number {
  return -halfSpan + (2 * halfSpan * step) / lateralSteps
}

function emptyMesh(): MeshData {
  return {
    positions: new Float32Array(0),
    normals: new Float32Array(0),
    uvs: new Float32Array(0),
    colors: new Float32Array(0),
    indices: new Uint32Array(0),
  }
}

function writeColor(colors: Float32Array, vi: number, c: PaletteRGB): void {
  colors[vi * 3] = c[0]
  colors[vi * 3 + 1] = c[1]
  colors[vi * 3 + 2] = c[2]
}

/** Every vertex of a decal pass one flat colour. The pad and ramp builders take no
 *  theme (§4.3 pins their signatures), so they write the multiplicative identity and
 *  `buildTrackScene` lands the palette here, exactly as it does for the road. */
function fillColor(mesh: MeshData, c: PaletteRGB): void {
  const vertexCount = mesh.positions.length / 3
  for (let vi = 0; vi < vertexCount; vi++) writeColor(mesh.colors, vi, c)
}

/**
 * The road ribbon: centreline + width profile + banking, evaluated on the same spline
 * `sim` derives ground height from. SOLE OWNER of road geometry — nothing else in the
 * repository emits triangles for the drivable surface.
 *
 * Layout (§4.3, pinned): `controlPoints.length * ringsPerSegment` rings, ring `r` at
 * segment parameter `t = r / ringsPerSegment`, `lateralSteps + 1` vertices per ring from
 * -(width/2 + shoulderWidth) to +(width/2 + shoulderWidth), vertex index
 * `ring * (lateralSteps + 1) + step`. Closed: the last ring bands back to ring 0.
 *
 * Colours are written as 1,1,1 — the multiplicative identity. This function is handed no
 * theme and `render` ships no palette of its own (§4.5); `buildTrackScene` applies the
 * theme.
 */
export function buildTrackMesh(track: Track, opts: MeshBuildOptions): MeshData {
  const rings = track.controlPoints.length * opts.ringsPerSegment
  const perRing = opts.lateralSteps + 1
  const ribbonVerts = rings * perRing
  const hasWall = opts.wallHeight > 0
  const wallVerts = hasWall ? rings * 4 : 0
  const vertexCount = ribbonVerts + wallVerts
  const triangles = rings * opts.lateralSteps * 2 + (hasWall ? rings * 4 : 0)

  const positions = new Float32Array(vertexCount * 3)
  const normals = new Float32Array(vertexCount * 3)
  const uvs = new Float32Array(vertexCount * 2)
  const colors = new Float32Array(vertexCount * 3)
  const indices = new Uint32Array(triangles * 3)

  const centre: Vec3 = { x: 0, y: 0, z: 0 }
  const tan: Vec3 = { x: 0, y: 0, z: 0 }
  const right: Vec3 = { x: 0, y: 0, z: 0 }
  const normal: Vec3 = { x: 0, y: 0, z: 0 }

  for (let r = 0; r < rings; r++) {
    const t = r / opts.ringsPerSegment
    splinePointAt(track, t, centre)
    splineTangentAt(track, t, tan)
    rightVector(tan, right)
    const halfSpan = widthAtSeg(track, t) / 2 + opts.shoulderWidth
    const tanBank = Math.tan(bankingAtSeg(track, t))
    surfaceNormal(right, tan, tanBank, normal)

    for (let i = 0; i < perRing; i++) {
      const lateral = lateralAt(halfSpan, i, opts.lateralSteps)
      const vi = r * perRing + i
      positions[vi * 3] = centre.x + right.x * lateral
      // sim's ground model, verbatim (track.ts:491-496): banking LIFTS the cross-section
      // by lateral * tan(banking); it does NOT rotate it about the tangent. The rotated
      // version (lateral * sin(banking)) is off by 0.34 m on caldera's 0.35 rad corners
      // and the mesh-vs-groundHeight test rejects it by two orders of magnitude.
      positions[vi * 3 + 1] = centre.y + lateral * tanBank
      positions[vi * 3 + 2] = centre.z + right.z * lateral
      normals[vi * 3] = normal.x
      normals[vi * 3 + 1] = normal.y
      normals[vi * 3 + 2] = normal.z
      uvs[vi * 2] = i / opts.lateralSteps
      uvs[vi * 2 + 1] = t
      colors[vi * 3] = 1
      colors[vi * 3 + 1] = 1
      colors[vi * 3 + 2] = 1
    }

    if (hasWall) {
      // Two vertical strips at the outer edges, appended AFTER every ribbon vertex so
      // the pinned layout above is untouched. Vertex pair index:
      // ribbonVerts + (sideIdx * rings + r) * 2, bottom then top.
      for (let sideIdx = 0; sideIdx < 2; sideIdx++) {
        const edgeStep = sideIdx === 0 ? 0 : opts.lateralSteps
        const src = (r * perRing + edgeStep) * 3
        const inward = sideIdx === 0 ? 1 : -1
        const base = ribbonVerts + (sideIdx * rings + r) * 2
        for (let k = 0; k < 2; k++) {
          const vi = base + k
          positions[vi * 3] = positions[src]
          positions[vi * 3 + 1] = positions[src + 1] + (k === 1 ? opts.wallHeight : 0)
          positions[vi * 3 + 2] = positions[src + 2]
          normals[vi * 3] = right.x * inward
          normals[vi * 3 + 1] = 0
          normals[vi * 3 + 2] = right.z * inward
          uvs[vi * 2] = k
          uvs[vi * 2 + 1] = t
          colors[vi * 3] = 1
          colors[vi * 3 + 1] = 1
          colors[vi * 3 + 2] = 1
        }
      }
    }
  }

  let w = 0
  for (let r = 0; r < rings; r++) {
    const next = (r + 1) % rings // closed loop
    for (let i = 0; i < opts.lateralSteps; i++) {
      const a = r * perRing + i
      const b = r * perRing + i + 1
      const c = next * perRing + i + 1
      const d = next * perRing + i
      // CCW seen from +y: (b - a) is +right, (c - a) is +tangent +right, and
      // cross(right, tangent) is +y.
      indices[w++] = a
      indices[w++] = b
      indices[w++] = c
      indices[w++] = a
      indices[w++] = c
      indices[w++] = d
    }
  }

  if (hasWall) {
    for (let sideIdx = 0; sideIdx < 2; sideIdx++) {
      for (let r = 0; r < rings; r++) {
        const next = (r + 1) % rings
        const b0 = ribbonVerts + (sideIdx * rings + r) * 2
        const b1 = ribbonVerts + (sideIdx * rings + next) * 2
        // Wound so the face points INWARD, matching the normals written above:
        // cross(up, tangent) = -right, cross(tangent, up) = +right.
        if (sideIdx === 0) {
          indices[w++] = b0
          indices[w++] = b1 + 1
          indices[w++] = b0 + 1
          indices[w++] = b0
          indices[w++] = b1
          indices[w++] = b1 + 1
        } else {
          indices[w++] = b0
          indices[w++] = b0 + 1
          indices[w++] = b1 + 1
          indices[w++] = b0
          indices[w++] = b1 + 1
          indices[w++] = b1
        }
      }
    }
  }

  return { positions, normals, uvs, colors, indices }
}

/**
 * Boost-pad quads, driven by `track.boostPads` and BOOST_PAD_HALF_LENGTH — NOT by
 * control-point `surface`, which never carries 'boost' (§3). One quad per pad, sitting
 * ROAD_DECAL_LIFT above the road surface at its own lateral, so a pad on a banked corner
 * lies in the road plane rather than across it.
 */
export function buildBoostPadMesh(track: Track, query: TrackQuery): MeshData {
  const pads = track.boostPads
  if (pads.length === 0) return emptyMesh()

  const positions = new Float32Array(pads.length * 4 * 3)
  const normals = new Float32Array(pads.length * 4 * 3)
  const uvs = new Float32Array(pads.length * 4 * 2)
  const colors = new Float32Array(pads.length * 4 * 3)
  const indices = new Uint32Array(pads.length * 6)

  const halfS = BOOST_PAD_HALF_LENGTH / query.totalLength()
  const tan: Vec3 = { x: 0, y: 0, z: 0 }
  const right: Vec3 = { x: 0, y: 0, z: 0 }
  const normal: Vec3 = { x: 0, y: 0, z: 0 }

  let w = 0
  for (let p = 0; p < pads.length; p++) {
    const pad = pads[p]
    for (let c = 0; c < 4; c++) {
      // corner order (s-,l-), (s-,l+), (s+,l+), (s+,l-): CCW seen from above
      const sSide = c < 2 ? -1 : 1
      const lSide = c === 1 || c === 2 ? 1 : -1
      const s = wrap01(pad.s + sSide * halfS)
      const lateral = pad.lateral + lSide * pad.halfWidth

      const pt = query.sampleAt(s)
      // §7.3: sampleAt returns the SAME object on every call. Copy before the next query.
      const cx = pt.position.x
      const cz = pt.position.z
      const bank = pt.banking
      const tv = query.tangentAt(s)
      tan.x = tv.x
      tan.y = tv.y
      tan.z = tv.z
      rightVector(tan, right)
      surfaceNormal(right, tan, Math.tan(bank), normal)

      const vi = p * 4 + c
      positions[vi * 3] = cx + right.x * lateral
      positions[vi * 3 + 1] = query.groundHeight(s, lateral) + ROAD_DECAL_LIFT
      positions[vi * 3 + 2] = cz + right.z * lateral
      normals[vi * 3] = normal.x
      normals[vi * 3 + 1] = normal.y
      normals[vi * 3 + 2] = normal.z
      uvs[vi * 2] = lSide < 0 ? 0 : 1
      uvs[vi * 2 + 1] = sSide < 0 ? 0 : 1
      colors[vi * 3] = 1
      colors[vi * 3 + 1] = 1
      colors[vi * 3 + 2] = 1
    }
    const a = p * 4
    indices[w++] = a
    indices[w++] = a + 1
    indices[w++] = a + 2
    indices[w++] = a
    indices[w++] = a + 2
    indices[w++] = a + 3
  }

  return { positions, normals, uvs, colors, indices }
}

/**
 * Ramp geometry from `track.ramps`. Empty `ramps` yields a MeshData whose five arrays
 * are all zero-length, never a throw (`neon-district` has none).
 *
 * `sim` does not raise the ground over a ramp — `applyRamps` writes `velocity.y` and
 * `airborne` and leaves the surface alone (`ground.ts:118-139`) — so a ramp is a decal
 * on the road, not a wedge above it. Raising it would put the drawn ramp above the
 * collision surface, which is the drift spec §3 forbids.
 *
 * Each ramp is subdivided into `opts.ringsPerSegment` longitudinal strips so it follows
 * the road. A single chord across a shipped ramp deviates from the real centreline by up
 * to 1.77 m (harbor-run; caldera's three are 0.26 – 0.28 m), and with a 0.02 m decal lift
 * that buries most of the ramp under the road it is meant to mark.
 */
export function buildRampMesh(
  track: Track,
  query: TrackQuery,
  opts: MeshBuildOptions,
): MeshData {
  const ramps = track.ramps
  if (ramps.length === 0) return emptyMesh()

  const strips = Math.max(1, opts.ringsPerSegment)
  const perRamp = (strips + 1) * 2
  const positions = new Float32Array(ramps.length * perRamp * 3)
  const normals = new Float32Array(ramps.length * perRamp * 3)
  const uvs = new Float32Array(ramps.length * perRamp * 2)
  const colors = new Float32Array(ramps.length * perRamp * 3)
  const indices = new Uint32Array(ramps.length * strips * 6)

  const tan: Vec3 = { x: 0, y: 0, z: 0 }
  const right: Vec3 = { x: 0, y: 0, z: 0 }
  const normal: Vec3 = { x: 0, y: 0, z: 0 }

  let w = 0
  for (let r = 0; r < ramps.length; r++) {
    const ramp = ramps[r]
    let span = ramp.sEnd - ramp.sStart
    // a ramp whose sStart exceeds its sEnd wraps through the start/finish line, exactly
    // as applyRamps reads it
    if (span <= 0) span += 1
    const base = r * perRamp

    for (let k = 0; k <= strips; k++) {
      const s = wrap01(ramp.sStart + (span * k) / strips)
      const pt = query.sampleAt(s)
      const cx = pt.position.x
      const cz = pt.position.z
      const half = pt.width / 2
      const bank = pt.banking
      const tv = query.tangentAt(s)
      tan.x = tv.x
      tan.y = tv.y
      tan.z = tv.z
      rightVector(tan, right)
      surfaceNormal(right, tan, Math.tan(bank), normal)

      for (let side = 0; side < 2; side++) {
        const lateral = (side === 0 ? -1 : 1) * half
        const vi = base + k * 2 + side
        positions[vi * 3] = cx + right.x * lateral
        positions[vi * 3 + 1] = query.groundHeight(s, lateral) + ROAD_DECAL_LIFT
        positions[vi * 3 + 2] = cz + right.z * lateral
        normals[vi * 3] = normal.x
        normals[vi * 3 + 1] = normal.y
        normals[vi * 3 + 2] = normal.z
        uvs[vi * 2] = side
        uvs[vi * 2 + 1] = k / strips
        colors[vi * 3] = 1
        colors[vi * 3 + 1] = 1
        colors[vi * 3 + 2] = 1
      }
    }

    for (let k = 0; k < strips; k++) {
      const a = base + k * 2 // left, this strip
      const b = a + 1 // right, this strip
      const c = a + 3 // right, next strip
      const d = a + 2 // left, next strip
      indices[w++] = a
      indices[w++] = b
      indices[w++] = c
      indices[w++] = a
      indices[w++] = c
      indices[w++] = d
    }
  }

  return { positions, normals, uvs, colors, indices }
}

/** Start/finish line and per-checkpoint gate placements, in world space. `s` is the
 *  checkpoint's own `track.checkpointS[i]`; index 0 is the finish line. On the
 *  centreline, so `position.y` is exactly `groundHeight(s, 0)`. */
export function buildCheckpointMarkers(track: Track, query: TrackQuery): MarkerPlacement[] {
  const out: MarkerPlacement[] = []
  for (let i = 0; i < track.checkpointS.length; i++) {
    const s = wrap01(track.checkpointS[i])
    const pt = query.sampleAt(s)
    // §7.3: copy before the next query call invalidates the scratch
    const px = pt.position.x
    const py = pt.position.y
    const pz = pt.position.z
    const width = pt.width
    const tv = query.tangentAt(s)
    // forward = (cos h, 0, sin h), contract §0
    const heading = Math.atan2(tv.z, tv.x)
    out.push({ s: track.checkpointS[i], position: { x: px, y: py, z: pz }, heading, width })
  }
  return out
}

/**
 * Q20's procedural edge markers: posts along both track edges, alternating colours,
 * generated from the existing spline plus the theme's parameters. They are a gameplay
 * cue, not decoration — a bare ribbon on a flat plane gives the player no speed cue and
 * no corner read.
 *
 * `side` is -1 for the left edge and +1 for the right (in the `right = (-t.z, 0, t.x)`
 * sense, so +1 is +lateral). `colorIdx` alternates 0,1,0,1... along each edge
 * INDEPENDENTLY, starting at 0 at s = 0. Posts sit at
 * `lateral = side * (width/2 + params.offset)` with `y = query.groundHeight(s, lateral)`.
 *
 * Order: every left post in ascending `s`, then every right post in ascending `s`.
 */
export function buildEdgeMarkers(
  track: Track,
  query: TrackQuery,
  params: EdgeMarkerParams,
): EdgeMarkerPlacement[] {
  // `track` is part of §4.3's pinned signature, kept so every builder takes the same
  // first argument. Everything this function needs — arc length, centreline, width,
  // banking — comes through `query`, which wraps this exact track.
  void track

  const total = query.totalLength()
  // `spacing` is metres of centreline, and `s` is arc-normalised, so `count` evenly
  // spaced values of `s` are evenly spaced in ARC LENGTH.
  const count = Math.max(1, Math.round(total / params.spacing))
  const out: EdgeMarkerPlacement[] = []
  const tan: Vec3 = { x: 0, y: 0, z: 0 }
  const right: Vec3 = { x: 0, y: 0, z: 0 }
  const sides: readonly (-1 | 1)[] = [-1, 1]

  for (const side of sides) {
    for (let i = 0; i < count; i++) {
      const s = i / count
      const pt = query.sampleAt(s)
      const cx = pt.position.x
      const cz = pt.position.z
      const width = pt.width
      const tv = query.tangentAt(s)
      tan.x = tv.x
      tan.y = tv.y
      tan.z = tv.z
      rightVector(tan, right)
      const lateral = side * (width / 2 + params.offset)
      out.push({
        s,
        position: {
          x: cx + right.x * lateral,
          y: query.groundHeight(s, lateral),
          z: cz + right.z * lateral,
        },
        heading: Math.atan2(tan.z, tan.x),
        side,
        colorIdx: (i % 2) as 0 | 1,
      })
    }
  }
  return out
}

/** `buildTrackMesh` writes 1,1,1; this is where the theme lands, and it is the only
 *  place road colour is written. Shoulder vertices are the ones beyond width/2; the road
 *  itself is `theme.road` or `theme.roadDirt` per the segment's own surface. 'boost' and
 *  'offtrack' never appear in control-point data (§3) — boost pads are their own pass. */
function applyRoadTheme(
  track: Track,
  road: MeshData,
  theme: TrackTheme,
  opts: MeshBuildOptions,
): void {
  const rings = track.controlPoints.length * opts.ringsPerSegment
  const perRing = opts.lateralSteps + 1
  for (let r = 0; r < rings; r++) {
    const t = r / opts.ringsPerSegment
    const halfWidth = widthAtSeg(track, t) / 2
    const halfSpan = halfWidth + opts.shoulderWidth
    const surfaceColor = surfaceOfSeg(track, t) === 'dirt' ? theme.roadDirt : theme.road
    for (let i = 0; i < perRing; i++) {
      const lateral = lateralAt(halfSpan, i, opts.lateralSteps)
      writeColor(
        road.colors,
        r * perRing + i,
        Math.abs(lateral) <= halfWidth ? surfaceColor : theme.shoulder,
      )
    }
  }
  const vertexCount = road.positions.length / 3
  for (let vi = rings * perRing; vi < vertexCount; vi++) writeColor(road.colors, vi, theme.wall)
}

/**
 * Everything the backend needs for one track, built once per race.
 *
 * Takes a `SimContext` rather than `(track, query)` because `itemBoxWorldPos` — sim's,
 * and the sole writer of item-box world position (§7.2) — needs one. That also makes it
 * impossible to hand this function a query built for a different track than the boxes.
 */
export function buildTrackScene(
  ctx: SimContext,
  theme: TrackTheme,
  opts: MeshBuildOptions,
): TrackScene {
  const track = ctx.track
  const query = ctx.query
  const road = buildTrackMesh(track, opts)
  applyRoadTheme(track, road, theme, opts)

  // Every mesh this function returns leaves here carrying its colour in its VERTICES.
  // That is §7.2's sole-writer rule applied to colour: the adapter's materials are
  // `vertexColors: true` over a white base and set no palette, so nothing downstream can
  // multiply a second palette into the first, and a mesh kind added later cannot be
  // forgotten by a colouring pass that lives in a file the tests never import.
  const boostPads = buildBoostPadMesh(track, query)
  fillColor(boostPads, theme.roadDirt)
  const ramps = buildRampMesh(track, query, opts)
  fillColor(ramps, theme.shoulder)

  // Index i is boxIdx i, which is the index RenderFrame.itemBoxAlpha uses. Each call
  // gets its own Vec3: itemBoxWorldPos writes into `out`, and one shared out would leave
  // every box at the last one's position.
  const itemBoxes: Vec3[] = []
  for (let i = 0; i < track.itemBoxes.length; i++) {
    const p: Vec3 = { x: 0, y: 0, z: 0 }
    itemBoxWorldPos(ctx, i, p)
    itemBoxes.push(p)
  }

  return {
    road,
    boostPads,
    ramps,
    checkpoints: buildCheckpointMarkers(track, query),
    edgeMarkers: buildEdgeMarkers(track, query, theme.edgeMarkers),
    itemBoxes,
    // Q19: track.bounds is a declared render extent and is much larger than the ribbon.
    // What the camera and the ground plane want is the extent of what was actually built.
    bounds: meshBounds(road),
  }
}

/** Axis-aligned bounds of a MeshData. An empty MeshData returns min = +Infinity,
 *  max = -Infinity in every axis. */
export function meshBounds(mesh: MeshData): { min: Vec3; max: Vec3 } {
  const min: Vec3 = { x: Infinity, y: Infinity, z: Infinity }
  const max: Vec3 = { x: -Infinity, y: -Infinity, z: -Infinity }
  const p = mesh.positions
  for (let i = 0; i < p.length; i += 3) {
    if (p[i] < min.x) min.x = p[i]
    if (p[i + 1] < min.y) min.y = p[i + 1]
    if (p[i + 2] < min.z) min.z = p[i + 2]
    if (p[i] > max.x) max.x = p[i]
    if (p[i + 1] > max.y) max.y = p[i + 1]
    if (p[i + 2] > max.z) max.z = p[i + 2]
  }
  return { min, max }
}

/** Sums vertex and triangle counts across a set. Test-facing, but exported because the
 *  adapter also reports it through RendererStats. */
export function meshCounts(meshes: readonly MeshData[]): { vertices: number; triangles: number } {
  let vertices = 0
  let triangles = 0
  for (const m of meshes) {
    vertices += m.positions.length / 3
    triangles += m.indices.length / 3
  }
  return { vertices, triangles }
}
```

Then modify `packages/render/src/index.ts` — append one line after `export * from './types'`
(contract §4.11's order is types, mesh, descriptors, camera, frame, hud, audio,
smoothing, backend):

```ts
export * from './types'
export * from './mesh'
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/render/test/mesh.test.ts`
Expected: PASS — 79 tests (most are `it.each` over the six shipped tracks), in roughly
1 s.

Then:

```bash
npm run typecheck --workspace @tapkart/render
npx vitest run
```

- [ ] **Step 5: Commit**

```bash
git add packages/render/src/mesh.ts packages/render/src/index.ts \
        packages/render/test/mesh.test.ts && \
git commit -m "feat(render): track geometry, asserted against sim's ground surface

- buildTrackMesh is the sole producer of road geometry; every vertex y is within
  1e-3 m (Q31) of query.groundHeight(s, lateral) on all six shipped tracks (Q34)
- banking lifts the cross-section (lateral * tan) exactly as sim's ground model does;
  the suite carries a witness proving a rotated cross-section misses by 0.34 m
- boost pads, subdivided ramp decals (zero ramps yields five empty arrays),
  checkpoint markers, Q20 procedural edge markers, meshBounds/meshCounts
- buildTrackScene applies the theme to EVERY mesh it returns -- road, boost pads and
  ramps -- into vertex colours, and reports meshBounds(road), not track.bounds (Q19).
  The adapter's materials are vertexColors over a white base and set no palette: two
  palettes multiply, and the road would ship at theme.road squared
- TrackScene.itemBoxes (amendment): world positions from sim's itemBoxWorldPos, index
  for index with RenderFrame.itemBoxAlpha, without which item boxes were undrawable;
  buildTrackScene now takes a SimContext, which is what itemBoxWorldPos requires"
```

---

### Task 9: `src/descriptors.ts` — descriptor meshes, pure

Spec §3: *"parametric low-poly meshes built in `render` from JSON descriptors. Eight
characters is eight JSON files, not eight modeled assets."* The descriptor **types and
parsers** live in `@tapkart/content` (§3a.3) because that is the package that ships and
validates the JSON; what stays here is the half that makes triangles.

Two functions, deterministic: same descriptor in, byte-identical `MeshData` out. No
randomness, no clock, no allocation policy — and no palette of `render`'s own: every
colour on these meshes comes from the descriptor.

**The geometry is pinned by an exact bounds identity**, because that is the only way a
headless test can tell a mesh built from the descriptor from a mesh that ignores it
(§8.1: *"`meshBounds` matches the descriptor's declared dimensions to `1e-6`"*):

- **Character**, origin at the feet, `+y` up: `min = (-xz, 0, -xz)`,
  `max = (xz, bodyHeight + 2 * headRadius, xz)` where
  `xz = max(bodyRadius * silhouetteScale, headRadius)` and `silhouetteScale` is
  **`compact: 1`, `tall: 0.85`, `wide: 1.3`**. The head is a sphere sitting on top of the
  body cylinder, centred at `bodyHeight + headRadius`.
- **Kart**, local space `+x` forward, `+z` right (contract §0: `forward = (cos h, 0,
  sin h)`, `right = (-t.z, 0, t.x)`), wheels on the ground at `y = 0`:
  `min = (-chassisLength/2, 0, -chassisWidth/2)`,
  `max = (chassisLength/2, max(wheelRadius + chassisHeight, 2 * wheelRadius), chassisWidth/2)`.
  Wheels are inboard — outer face flush with `±chassisWidth/2` — and their axles sit at
  `x = ±(chassisLength/2 - wheelRadius)`, so a wheel's own extent ends exactly at the
  chassis' nose and tail.

Both identities are exact under `Float32Array` storage because every cylinder and sphere
uses **8 radial segments** and the sphere **4 stacks**, which puts a vertex at exactly
0°, 90° and on the equator. Measured float32 error at these magnitudes: ≤ 2.4e-7, well
inside the 1e-6 gate.

**Files:**
- Create: `packages/render/src/descriptors.ts`
- Modify: `packages/render/src/index.ts:10-11` (append one `export *` line after `export * from './mesh'`)
- Test: `packages/render/test/descriptors.test.ts`

**Interfaces:**

- Consumes, from `@tapkart/content` (contract §3a.3, an earlier task) — types only:
  ```ts
  export type PaletteRGB = readonly [number, number, number]   // linear, 0..1
  export interface CharacterDescriptor {
    id: string; name: string
    bodyHeight: number           // metres, 0.4 – 1.4
    bodyRadius: number           // metres, 0.15 – 0.5
    headRadius: number           // metres, 0.1 – 0.4
    palette: { primary: PaletteRGB; secondary: PaletteRGB; accent: PaletteRGB }
    silhouette: 'compact' | 'tall' | 'wide'
  }
  export interface KartDescriptor {
    id: string; name: string
    chassisLength: number        // metres, 1.4 – 2.6
    chassisWidth: number         // metres, 0.9 – 1.6
    chassisHeight: number        // metres, 0.3 – 0.8
    wheelRadius: number          // metres, 0.2 – 0.45
    wheelWidth: number           // metres, 0.1 – 0.35
    palette: { body: PaletteRGB; trim: PaletteRGB; wheel: PaletteRGB }
  }
  ```
- Consumes, from `packages/render/src/mesh` (Task 8):
  ```ts
  export interface MeshData { positions: Float32Array; normals: Float32Array
    uvs: Float32Array; colors: Float32Array; indices: Uint32Array }
  export function meshBounds(mesh: MeshData): { min: Vec3; max: Vec3 }   // test only
  ```
- Consumes, from `packages/render/test/fixtures/render-fixtures` (Task 7, test-only):
  ```ts
  export function makeCharacterDescriptorFixture(): CharacterDescriptor
  export function makeKartDescriptorFixture(): KartDescriptor
  ```
- Produces — the 2 exports of `render/descriptors` (contract §11's census):
  ```ts
  export function buildCharacterMesh(desc: CharacterDescriptor): MeshData
  export function buildKartMesh(desc: KartDescriptor): MeshData
  ```

---

- [ ] **Step 1: Write the failing test**

Create `packages/render/test/descriptors.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import type { CharacterDescriptor, KartDescriptor } from '@tapkart/content'

import type { MeshData } from '../src/mesh'
import { meshBounds } from '../src/mesh'
import { buildCharacterMesh, buildKartMesh } from '../src/descriptors'
import {
  makeCharacterDescriptorFixture,
  makeKartDescriptorFixture,
} from './fixtures/render-fixtures'

/** The silhouette scale table, pinned by this task. The module's own copy is private,
 *  so this is the spec: change one and the other must follow, deliberately. */
const SILHOUETTE_XZ: Record<CharacterDescriptor['silhouette'], number> = {
  compact: 1,
  tall: 0.85,
  wide: 1.3,
}

function character(over: Partial<CharacterDescriptor>): CharacterDescriptor {
  return { ...makeCharacterDescriptorFixture(), ...over }
}

function kart(over: Partial<KartDescriptor>): KartDescriptor {
  return { ...makeKartDescriptorFixture(), ...over }
}

function smallestTriangleArea(mesh: MeshData): number {
  let smallest = Infinity
  const p = mesh.positions
  for (let k = 0; k < mesh.indices.length; k += 3) {
    const a = mesh.indices[k] * 3
    const b = mesh.indices[k + 1] * 3
    const c = mesh.indices[k + 2] * 3
    const ux = p[b] - p[a]
    const uy = p[b + 1] - p[a + 1]
    const uz = p[b + 2] - p[a + 2]
    const vx = p[c] - p[a]
    const vy = p[c + 1] - p[a + 1]
    const vz = p[c + 2] - p[a + 2]
    const area = 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx)
    if (area < smallest) smallest = area
  }
  return smallest
}

/** Every vertex colour must be one of the palette entries, and all of them must appear. */
function paletteUsage(mesh: MeshData, palette: readonly (readonly number[])[]): number[] {
  const hits = palette.map(() => 0)
  for (let v = 0; v < mesh.colors.length; v += 3) {
    let matched = -1
    for (let p = 0; p < palette.length; p++) {
      const c = palette[p]
      if (
        Math.abs(mesh.colors[v] - c[0]) < 1e-6 &&
        Math.abs(mesh.colors[v + 1] - c[1]) < 1e-6 &&
        Math.abs(mesh.colors[v + 2] - c[2]) < 1e-6
      ) {
        matched = p
        break
      }
    }
    expect(matched).toBeGreaterThanOrEqual(0)
    hits[matched]++
  }
  return hits
}

// Labelled `[name, value]` rows. NEVER write `it.each([someArray, other])` with bare
// array rows: vitest SPREADS an array row into arguments, so a `[]` row arrives as zero
// arguments and the case silently re-tests `undefined`.
const CHARACTER_CASES: readonly [string, CharacterDescriptor][] = [
  ['fixture', makeCharacterDescriptorFixture()],
  [
    'smallest declared, compact',
    character({ bodyHeight: 0.4, bodyRadius: 0.15, headRadius: 0.1, silhouette: 'compact' }),
  ],
  [
    'largest declared, tall',
    character({ bodyHeight: 1.4, bodyRadius: 0.5, headRadius: 0.4, silhouette: 'tall' }),
  ],
  [
    'head wider than the scaled body, tall',
    character({ bodyHeight: 1.1, bodyRadius: 0.15, headRadius: 0.4, silhouette: 'tall' }),
  ],
  ['wide silhouette', character({ bodyRadius: 0.4, silhouette: 'wide' })],
]

const KART_CASES: readonly [string, KartDescriptor][] = [
  ['fixture', makeKartDescriptorFixture()],
  [
    'smallest declared',
    kart({
      chassisLength: 1.4,
      chassisWidth: 0.9,
      chassisHeight: 0.3,
      wheelRadius: 0.2,
      wheelWidth: 0.1,
    }),
  ],
  [
    'largest declared',
    kart({
      chassisLength: 2.6,
      chassisWidth: 1.6,
      chassisHeight: 0.8,
      wheelRadius: 0.45,
      wheelWidth: 0.35,
    }),
  ],
  [
    'wheels taller than the chassis roof',
    kart({ chassisLength: 2, chassisWidth: 1.4, chassisHeight: 0.3, wheelRadius: 0.45 }),
  ],
]

describe('buildCharacterMesh', () => {
  it('emits the same low-poly budget for every descriptor', () => {
    const mesh = buildCharacterMesh(makeCharacterDescriptorFixture())
    expect(mesh.positions.length / 3).toBe(60) // 34 body + 26 head
    expect(mesh.indices.length).toBe(240) // 80 triangles
    expect(mesh.normals.length).toBe(mesh.positions.length)
    expect(mesh.colors.length).toBe(mesh.positions.length)
    expect(mesh.uvs.length).toBe((mesh.positions.length / 3) * 2)
  })

  /**
   * The bug this catches: a generator that builds a fixed unit figure and ignores the
   * descriptor (or applies its numbers to the wrong axis). Every count assertion above
   * passes under that bug. Sweeping the declared range and asserting the bounds ARE the
   * declared numbers is what sees it.
   */
  it.each(CHARACTER_CASES)('%s: meshBounds equals the declared dimensions to 1e-6', (_l, d) => {
    const b = meshBounds(buildCharacterMesh(d))
    const xz = Math.max(d.bodyRadius * SILHOUETTE_XZ[d.silhouette], d.headRadius)
    expect(b.min.x).toBeCloseTo(-xz, 6)
    expect(b.max.x).toBeCloseTo(xz, 6)
    expect(b.min.z).toBeCloseTo(-xz, 6)
    expect(b.max.z).toBeCloseTo(xz, 6)
    // feet on the ground plane: a character floating or sunk is invisible to CI otherwise
    expect(b.min.y).toBeCloseTo(0, 6)
    expect(b.max.y).toBeCloseTo(d.bodyHeight + 2 * d.headRadius, 6)
  })

  // Eight shipped characters differ by silhouette; if the field is ignored they are all
  // the same figure in eight palettes and nothing else in the suite notices.
  it('silhouette scales the body across XZ and nothing else', () => {
    const base = { bodyHeight: 1.2, bodyRadius: 0.45, headRadius: 0.2 }
    const wide = meshBounds(buildCharacterMesh(character({ ...base, silhouette: 'wide' })))
    const compact = meshBounds(buildCharacterMesh(character({ ...base, silhouette: 'compact' })))
    const tall = meshBounds(buildCharacterMesh(character({ ...base, silhouette: 'tall' })))
    expect(wide.max.x).toBeGreaterThan(compact.max.x)
    expect(compact.max.x).toBeGreaterThan(tall.max.x)
    expect(wide.max.y).toBeCloseTo(compact.max.y, 6)
    expect(tall.max.y).toBeCloseTo(compact.max.y, 6)
  })

  it('uses all three palette entries and no other colour', () => {
    const d = makeCharacterDescriptorFixture()
    const hits = paletteUsage(buildCharacterMesh(d), [
      d.palette.primary,
      d.palette.secondary,
      d.palette.accent,
    ])
    for (const h of hits) expect(h).toBeGreaterThan(0)
  })

  it('is deterministic: the same descriptor yields identical arrays', () => {
    const d = makeCharacterDescriptorFixture()
    const a = buildCharacterMesh(d)
    const b = buildCharacterMesh(d)
    expect(Array.from(a.positions)).toEqual(Array.from(b.positions))
    expect(Array.from(a.normals)).toEqual(Array.from(b.normals))
    expect(Array.from(a.colors)).toEqual(Array.from(b.colors))
    expect(Array.from(a.indices)).toEqual(Array.from(b.indices))
  })

  it.each(CHARACTER_CASES)('%s: no degenerate triangles, all normals unit length', (_l, d) => {
    const mesh = buildCharacterMesh(d)
    expect(smallestTriangleArea(mesh)).toBeGreaterThan(1e-9)
    for (let i = 0; i < mesh.normals.length; i += 3) {
      const len = Math.hypot(mesh.normals[i], mesh.normals[i + 1], mesh.normals[i + 2])
      expect(Math.abs(len - 1)).toBeLessThan(1e-5)
    }
  })
})

describe('buildKartMesh', () => {
  it('emits the same low-poly budget for every descriptor', () => {
    const mesh = buildKartMesh(makeKartDescriptorFixture())
    expect(mesh.positions.length / 3).toBe(160) // 24 chassis + 4 * 34 wheels
    expect(mesh.indices.length).toBe(420) // 140 triangles
    expect(mesh.normals.length).toBe(mesh.positions.length)
    expect(mesh.colors.length).toBe(mesh.positions.length)
    expect(mesh.uvs.length).toBe((mesh.positions.length / 3) * 2)
  })

  /**
   * Same bug class as the character sweep, plus two specific to a kart:
   *  - wheels mounted OUTSIDE the chassis, which makes the drawn kart wider than the
   *    0.9 m collision radius the sim uses and reads as karts overlapping on contact;
   *  - a body built around y = 0 instead of standing on it, which buries the kart in
   *    the road — the exact thing §8.3 says CI cannot see in pixels but can see here.
   */
  it.each(KART_CASES)('%s: meshBounds equals the declared dimensions to 1e-6', (_l, d) => {
    const b = meshBounds(buildKartMesh(d))
    expect(b.min.x).toBeCloseTo(-d.chassisLength / 2, 6)
    expect(b.max.x).toBeCloseTo(d.chassisLength / 2, 6)
    expect(b.min.z).toBeCloseTo(-d.chassisWidth / 2, 6)
    expect(b.max.z).toBeCloseTo(d.chassisWidth / 2, 6)
    expect(b.min.y).toBeCloseTo(0, 6) // wheels on the ground plane
    expect(b.max.y).toBeCloseTo(Math.max(d.wheelRadius + d.chassisHeight, 2 * d.wheelRadius), 6)
  })

  // Discrimination: change exactly one number and the mesh must move by exactly that
  // much. A generator that ignores the descriptor cannot fake this.
  it('tracks a single changed dimension exactly', () => {
    const narrow = meshBounds(buildKartMesh(kart({ chassisWidth: 1 })))
    const wide = meshBounds(buildKartMesh(kart({ chassisWidth: 1.5 })))
    expect(wide.max.z - narrow.max.z).toBeCloseTo(0.25, 6)
    expect(wide.max.x).toBeCloseTo(narrow.max.x, 6)
    const long = meshBounds(buildKartMesh(kart({ chassisLength: 2.4 })))
    const short = meshBounds(buildKartMesh(kart({ chassisLength: 1.6 })))
    expect(long.max.x - short.max.x).toBeCloseTo(0.4, 6)
  })

  it('uses all three palette entries and no other colour', () => {
    const d = makeKartDescriptorFixture()
    const hits = paletteUsage(buildKartMesh(d), [
      d.palette.body,
      d.palette.trim,
      d.palette.wheel,
    ])
    for (const h of hits) expect(h).toBeGreaterThan(0)
  })

  it('is deterministic: the same descriptor yields identical arrays', () => {
    const d = makeKartDescriptorFixture()
    const a = buildKartMesh(d)
    const b = buildKartMesh(d)
    expect(Array.from(a.positions)).toEqual(Array.from(b.positions))
    expect(Array.from(a.indices)).toEqual(Array.from(b.indices))
  })

  it.each(KART_CASES)('%s: no degenerate triangles, all normals unit length', (_l, d) => {
    const mesh = buildKartMesh(d)
    expect(smallestTriangleArea(mesh)).toBeGreaterThan(1e-9)
    for (let i = 0; i < mesh.normals.length; i += 3) {
      const len = Math.hypot(mesh.normals[i], mesh.normals[i + 1], mesh.normals[i + 2])
      expect(Math.abs(len - 1)).toBeLessThan(1e-5)
    }
  })

  // Four wheels, one per corner, all four distinct. A loop bug that builds the same
  // wheel four times leaves three of them hidden inside one and every count still adds up.
  it('places four distinct wheels, one per corner', () => {
    const d = makeKartDescriptorFixture()
    const mesh = buildKartMesh(d)
    const corners = new Set<string>()
    // wheel vertices follow the 24 chassis vertices, 34 per wheel
    for (let w = 0; w < 4; w++) {
      const v = (24 + w * 34) * 3
      corners.add(`${Math.sign(mesh.positions[v])}:${Math.sign(mesh.positions[v + 2])}`)
    }
    expect(corners.size).toBe(4)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/render/test/descriptors.test.ts`

Expected: FAIL to collect, with
`Error: Cannot find module '../src/descriptors' imported from '/home/kasm-user/tapkart/packages/render/test/descriptors.test.ts'`
(caused by `Failed to load url ../src/descriptors ... Does the file exist?`).

- [ ] **Step 3: Write the implementation**

Create `packages/render/src/descriptors.ts`:

```ts
// PURE (contract §0a): no DOM, no GPU, no clock, no `three` import. Deterministic
// parametric meshes — same descriptor in, byte-identical MeshData out.
//
// The descriptor TYPES and PARSERS are @tapkart/content's (§3a.3): content is data +
// schema + parsers, render turns that data into triangles. `PaletteRGB` is content's
// too, so a palette is one type across all four packages.
//
// These meshes are built once, when content loads — never per frame — so the array
// growth here is outside §7.3's no-allocation rule, which governs the frame path.
import type { CharacterDescriptor, KartDescriptor, PaletteRGB } from '@tapkart/content'
import type { MeshData } from './mesh'

/** Radial segments in every cylinder and sphere. 8 puts a vertex at exactly 0 deg and
 *  90 deg, which is what makes meshBounds equal the declared radius exactly instead of
 *  r * cos(pi / 8) — the bounds identity the tests assert to 1e-6 depends on it. */
const RADIAL_SEGMENTS = 8

/** Polar stacks in the head sphere. 4 puts a ring exactly on the equator, so the
 *  sphere's XZ extent is exactly its radius. */
const SPHERE_STACKS = 4

/** Silhouette scales the body's XZ radius only. Height and head are untouched. */
const SILHOUETTE_XZ: Readonly<Record<CharacterDescriptor['silhouette'], number>> = {
  compact: 1,
  tall: 0.85,
  wide: 1.3,
}

interface MeshBuilder {
  positions: number[]
  normals: number[]
  uvs: number[]
  colors: number[]
  indices: number[]
}

function newBuilder(): MeshBuilder {
  return { positions: [], normals: [], uvs: [], colors: [], indices: [] }
}

function addVertex(
  b: MeshBuilder,
  x: number,
  y: number,
  z: number,
  nx: number,
  ny: number,
  nz: number,
  u: number,
  v: number,
  c: PaletteRGB,
): number {
  const index = b.positions.length / 3
  b.positions.push(x, y, z)
  b.normals.push(nx, ny, nz)
  b.uvs.push(u, v)
  b.colors.push(c[0], c[1], c[2])
  return index
}

function addTriangle(b: MeshBuilder, a: number, c: number, d: number): void {
  b.indices.push(a, c, d)
}

function toMesh(b: MeshBuilder): MeshData {
  return {
    positions: Float32Array.from(b.positions),
    normals: Float32Array.from(b.normals),
    uvs: Float32Array.from(b.uvs),
    colors: Float32Array.from(b.colors),
    indices: Uint32Array.from(b.indices),
  }
}

/** A capped cylinder about the Y axis, centred on (0, ·, 0). 34 vertices, 32 triangles,
 *  all wound CCW seen from outside. */
function addCylinderY(
  b: MeshBuilder,
  y0: number,
  y1: number,
  radius: number,
  side: PaletteRGB,
  cap: PaletteRGB,
): void {
  const sideBase = b.positions.length / 3
  for (let k = 0; k < RADIAL_SEGMENTS; k++) {
    const a = (k / RADIAL_SEGMENTS) * Math.PI * 2
    const cx = Math.cos(a)
    const cz = Math.sin(a)
    const u = k / RADIAL_SEGMENTS
    addVertex(b, cx * radius, y0, cz * radius, cx, 0, cz, u, 0, side)
    addVertex(b, cx * radius, y1, cz * radius, cx, 0, cz, u, 1, side)
  }
  for (let k = 0; k < RADIAL_SEGMENTS; k++) {
    const n = (k + 1) % RADIAL_SEGMENTS
    const a0 = sideBase + k * 2
    const a1 = a0 + 1
    const b0 = sideBase + n * 2
    const b1 = b0 + 1
    addTriangle(b, a0, b1, b0)
    addTriangle(b, a0, a1, b1)
  }

  const bottomCentre = addVertex(b, 0, y0, 0, 0, -1, 0, 0.5, 0.5, cap)
  const bottomRim = b.positions.length / 3
  for (let k = 0; k < RADIAL_SEGMENTS; k++) {
    const a = (k / RADIAL_SEGMENTS) * Math.PI * 2
    addVertex(
      b,
      Math.cos(a) * radius,
      y0,
      Math.sin(a) * radius,
      0,
      -1,
      0,
      0.5 + Math.cos(a) * 0.5,
      0.5 + Math.sin(a) * 0.5,
      cap,
    )
  }
  for (let k = 0; k < RADIAL_SEGMENTS; k++) {
    addTriangle(b, bottomCentre, bottomRim + k, bottomRim + ((k + 1) % RADIAL_SEGMENTS))
  }

  const topCentre = addVertex(b, 0, y1, 0, 0, 1, 0, 0.5, 0.5, cap)
  const topRim = b.positions.length / 3
  for (let k = 0; k < RADIAL_SEGMENTS; k++) {
    const a = (k / RADIAL_SEGMENTS) * Math.PI * 2
    addVertex(
      b,
      Math.cos(a) * radius,
      y1,
      Math.sin(a) * radius,
      0,
      1,
      0,
      0.5 + Math.cos(a) * 0.5,
      0.5 + Math.sin(a) * 0.5,
      cap,
    )
  }
  for (let k = 0; k < RADIAL_SEGMENTS; k++) {
    addTriangle(b, topCentre, topRim + ((k + 1) % RADIAL_SEGMENTS), topRim + k)
  }
}

/** A capped cylinder about the Z axis (a wheel), centred on (cx, cy, ·). Same 34/32
 *  budget as addCylinderY. */
function addCylinderZ(
  b: MeshBuilder,
  cx: number,
  cy: number,
  z0: number,
  z1: number,
  radius: number,
  side: PaletteRGB,
  cap: PaletteRGB,
): void {
  const sideBase = b.positions.length / 3
  for (let k = 0; k < RADIAL_SEGMENTS; k++) {
    const a = (k / RADIAL_SEGMENTS) * Math.PI * 2
    const nx = Math.cos(a)
    const ny = Math.sin(a)
    const u = k / RADIAL_SEGMENTS
    addVertex(b, cx + nx * radius, cy + ny * radius, z0, nx, ny, 0, u, 0, side)
    addVertex(b, cx + nx * radius, cy + ny * radius, z1, nx, ny, 0, u, 1, side)
  }
  for (let k = 0; k < RADIAL_SEGMENTS; k++) {
    const n = (k + 1) % RADIAL_SEGMENTS
    const a0 = sideBase + k * 2
    const a1 = a0 + 1
    const b0 = sideBase + n * 2
    const b1 = b0 + 1
    addTriangle(b, a0, b0, b1)
    addTriangle(b, a0, b1, a1)
  }

  const nearCentre = addVertex(b, cx, cy, z0, 0, 0, -1, 0.5, 0.5, cap)
  const nearRim = b.positions.length / 3
  for (let k = 0; k < RADIAL_SEGMENTS; k++) {
    const a = (k / RADIAL_SEGMENTS) * Math.PI * 2
    addVertex(
      b,
      cx + Math.cos(a) * radius,
      cy + Math.sin(a) * radius,
      z0,
      0,
      0,
      -1,
      0.5 + Math.cos(a) * 0.5,
      0.5 + Math.sin(a) * 0.5,
      cap,
    )
  }
  for (let k = 0; k < RADIAL_SEGMENTS; k++) {
    addTriangle(b, nearCentre, nearRim + ((k + 1) % RADIAL_SEGMENTS), nearRim + k)
  }

  const farCentre = addVertex(b, cx, cy, z1, 0, 0, 1, 0.5, 0.5, cap)
  const farRim = b.positions.length / 3
  for (let k = 0; k < RADIAL_SEGMENTS; k++) {
    const a = (k / RADIAL_SEGMENTS) * Math.PI * 2
    addVertex(
      b,
      cx + Math.cos(a) * radius,
      cy + Math.sin(a) * radius,
      z1,
      0,
      0,
      1,
      0.5 + Math.cos(a) * 0.5,
      0.5 + Math.sin(a) * 0.5,
      cap,
    )
  }
  for (let k = 0; k < RADIAL_SEGMENTS; k++) {
    addTriangle(b, farCentre, farRim + k, farRim + ((k + 1) % RADIAL_SEGMENTS))
  }
}

/** A low-poly sphere: two pole fans and (SPHERE_STACKS - 2) bands. 26 vertices, 48
 *  triangles, and no degenerate pole triangles — the fans are built as fans, not as a
 *  grid with collapsed rows. */
function addSphere(
  b: MeshBuilder,
  cx: number,
  cy: number,
  cz: number,
  radius: number,
  upper: PaletteRGB,
  lower: PaletteRGB,
): void {
  const north = addVertex(b, cx, cy + radius, cz, 0, 1, 0, 0.5, 1, upper)
  const ringBase = b.positions.length / 3
  const ringCount = SPHERE_STACKS - 1
  for (let j = 1; j < SPHERE_STACKS; j++) {
    const phi = (j / SPHERE_STACKS) * Math.PI
    const ry = Math.cos(phi)
    const rr = Math.sin(phi)
    for (let k = 0; k < RADIAL_SEGMENTS; k++) {
      const a = (k / RADIAL_SEGMENTS) * Math.PI * 2
      const nx = Math.cos(a) * rr
      const nz = Math.sin(a) * rr
      addVertex(
        b,
        cx + nx * radius,
        cy + ry * radius,
        cz + nz * radius,
        nx,
        ry,
        nz,
        k / RADIAL_SEGMENTS,
        1 - j / SPHERE_STACKS,
        ry > 0 ? upper : lower,
      )
    }
  }
  const south = addVertex(b, cx, cy - radius, cz, 0, -1, 0, 0.5, 0, lower)

  for (let k = 0; k < RADIAL_SEGMENTS; k++) {
    const n = (k + 1) % RADIAL_SEGMENTS
    addTriangle(b, north, ringBase + n, ringBase + k)
  }
  for (let j = 0; j < ringCount - 1; j++) {
    const upperRow = ringBase + j * RADIAL_SEGMENTS
    const lowerRow = upperRow + RADIAL_SEGMENTS
    for (let k = 0; k < RADIAL_SEGMENTS; k++) {
      const n = (k + 1) % RADIAL_SEGMENTS
      addTriangle(b, lowerRow + k, upperRow + n, lowerRow + n)
      addTriangle(b, lowerRow + k, upperRow + k, upperRow + n)
    }
  }
  const lastRow = ringBase + (ringCount - 1) * RADIAL_SEGMENTS
  for (let k = 0; k < RADIAL_SEGMENTS; k++) {
    const n = (k + 1) % RADIAL_SEGMENTS
    addTriangle(b, south, lastRow + k, lastRow + n)
  }
}

function addQuad(
  b: MeshBuilder,
  p0: readonly [number, number, number],
  p1: readonly [number, number, number],
  p2: readonly [number, number, number],
  p3: readonly [number, number, number],
  n: readonly [number, number, number],
  c: PaletteRGB,
): void {
  const i0 = addVertex(b, p0[0], p0[1], p0[2], n[0], n[1], n[2], 0, 0, c)
  const i1 = addVertex(b, p1[0], p1[1], p1[2], n[0], n[1], n[2], 1, 0, c)
  const i2 = addVertex(b, p2[0], p2[1], p2[2], n[0], n[1], n[2], 1, 1, c)
  const i3 = addVertex(b, p3[0], p3[1], p3[2], n[0], n[1], n[2], 0, 1, c)
  addTriangle(b, i0, i1, i2)
  addTriangle(b, i0, i2, i3)
}

/** An axis-aligned box with flat per-face normals: 24 vertices, 12 triangles. */
function addBox(
  b: MeshBuilder,
  x0: number,
  y0: number,
  z0: number,
  x1: number,
  y1: number,
  z1: number,
  side: PaletteRGB,
  top: PaletteRGB,
): void {
  addQuad(b, [x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [1, 0, 0], side)
  addQuad(b, [x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [-1, 0, 0], side)
  addQuad(b, [x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], [0, 1, 0], top)
  addQuad(b, [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [0, -1, 0], side)
  addQuad(b, [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1], side)
  addQuad(b, [x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [0, 0, -1], side)
}

/**
 * Deterministic parametric mesh from a character descriptor. 60 vertices, 80 triangles.
 *
 * Local space: feet on y = 0, `+y` up, centred on the XZ origin. Bounds are exactly
 * `(-xz, 0, -xz)` to `(xz, bodyHeight + 2 * headRadius, xz)` with
 * `xz = max(bodyRadius * silhouetteScale, headRadius)`.
 *
 * The palette lands as: body cylinder `primary`, head upper hemisphere `accent` (a
 * helmet), head lower hemisphere `secondary` (a face). All three appear; nothing else
 * does.
 */
export function buildCharacterMesh(desc: CharacterDescriptor): MeshData {
  const b = newBuilder()
  const bodyRadius = desc.bodyRadius * SILHOUETTE_XZ[desc.silhouette]
  addCylinderY(b, 0, desc.bodyHeight, bodyRadius, desc.palette.primary, desc.palette.primary)
  addSphere(
    b,
    0,
    desc.bodyHeight + desc.headRadius,
    0,
    desc.headRadius,
    desc.palette.accent,
    desc.palette.secondary,
  )
  return toMesh(b)
}

/**
 * Deterministic parametric mesh from a kart descriptor. 160 vertices, 140 triangles.
 *
 * Local space: `+x` forward, `+z` right, `+y` up, wheels standing on y = 0 (contract §0:
 * forward = (cos h, 0, sin h), right = (-t.z, 0, t.x)).
 *
 * Wheels are INBOARD — the outer face is flush with +/-chassisWidth/2 — so the drawn kart
 * is never wider than its declared chassis, and their axles sit at
 * `x = +/-(chassisLength/2 - wheelRadius)` so each wheel's own extent ends exactly at the
 * nose or tail. Bounds are therefore exactly `(-L/2, 0, -W/2)` to
 * `(L/2, max(wheelRadius + chassisHeight, 2 * wheelRadius), W/2)`.
 *
 * Palette: chassis `body`, chassis roof and wheel hubs `trim`, tyres `wheel`.
 */
export function buildKartMesh(desc: KartDescriptor): MeshData {
  const b = newBuilder()
  const halfLength = desc.chassisLength / 2
  const halfWidth = desc.chassisWidth / 2
  const axle = desc.wheelRadius // the chassis floor sits at axle height

  addBox(
    b,
    -halfLength,
    axle,
    -halfWidth,
    halfLength,
    axle + desc.chassisHeight,
    halfWidth,
    desc.palette.body,
    desc.palette.trim,
  )

  const wheelX = halfLength - desc.wheelRadius
  const xSigns: readonly number[] = [-1, 1]
  const zSigns: readonly number[] = [-1, 1]
  for (const sx of xSigns) {
    for (const sz of zSigns) {
      const outer = sz * halfWidth
      const inner = sz * (halfWidth - desc.wheelWidth)
      addCylinderZ(
        b,
        sx * wheelX,
        desc.wheelRadius,
        Math.min(inner, outer),
        Math.max(inner, outer),
        desc.wheelRadius,
        desc.palette.wheel,
        desc.palette.trim,
      )
    }
  }
  return toMesh(b)
}
```

Then modify `packages/render/src/index.ts` — append one line after `export * from './mesh'`:

```ts
export * from './types'
export * from './mesh'
export * from './descriptors'
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/render/test/descriptors.test.ts`
Expected: PASS — 27 tests (the two `it.each` sweeps expand to 5 and 4 cases each).

Then:

```bash
npm run typecheck --workspace @tapkart/render
npx vitest run
```

- [ ] **Step 5: Commit**

```bash
git add packages/render/src/descriptors.ts packages/render/src/index.ts \
        packages/render/test/descriptors.test.ts && \
git commit -m "feat(render): parametric character and kart meshes from descriptors

- buildCharacterMesh 60 verts / 80 tris, buildKartMesh 160 verts / 140 tris,
  deterministic and byte-identical for a given descriptor
- meshBounds equals the descriptor's declared dimensions to 1e-6, swept across the
  full declared range so a generator that ignores the descriptor cannot pass
- wheels inboard and standing on y = 0; palette entries are the only colours emitted"
```

---

### Task 10: `src/camera.ts` — pure, tick-driven, no wall clock

The chase camera. Pure, deterministic, and smoothed **per sim tick, never per frame** —
a frame-rate-dependent lerp makes the camera behave differently on a 60 Hz phone and a
144 Hz desktop and cannot be asserted in CI at all. `updateCamera` advances by exactly
`ticks` ticks, which is what makes §8.1's *"N calls with 1 tick equal 1 call with N
ticks"* assertion true, and `ticks = 0` is a no-op.

The one arithmetic decision that everything else follows from: the per-tick factor is
**pooled**, `1 - (1 - k) ** ticks`, not multiplied, `k * ticks`. With the default
`positionLerpPerTick` of 0.18 and 8 ticks those are 0.796 and 1.44 — the multiplied form
overshoots the target and the camera oscillates behind the kart at any frame rate that
drops below 60 Hz. The equality test below is what catches it, and it only catches it if
the camera starts from a pose it is *not* already at (see the snap rule).

`updateCamera` is the **sole writer** of every `CameraState` field (contract §7.2).

**Files:**
- Create: `packages/render/src/camera.ts`
- Modify: `packages/render/src/index.ts:11-12` (append one `export *` line after `export * from './descriptors'`)
- Test: `packages/render/test/camera.test.ts`

**Interfaces:**

- Consumes, from `@tapkart/sim`:
  ```ts
  export type Vec3 = { x: number; y: number; z: number }
  export function clamp(v: number, lo: number, hi: number): number
  export function wrapAngle(a: number): number        // wraps to (-pi, pi]
  export const ITEM_BOOST_TICKS = 90
  ```
- Consumes, from `packages/render/src/types` (Task 7) — the fields this module reads
  from the view it is handed:
  ```ts
  export interface KartView {
    playerId: number; characterIdx: number; source: ViewSource
    position: Vec3          // metres, world
    heading: number         // radians, wrapped to (-pi, pi]
    velocity: Vec3; angularVelocity: number; speed: number; s: number; bankAngle: number
    driftActive: boolean; driftDir: -1 | 0 | 1; driftCharge: number; driftTier: number
    airborne: boolean; surface: Surface
    spinOutTicks: number; invulnTicks: number
    boostTicks: number      // read for the FOV kick
    respawnTicks: number; shielded: boolean; item: ItemKind
    lap: number; checkpointIdx: number; t: number; place: number
    isBot: boolean; connected: boolean
  }
  ```
- Consumes, from `packages/render/test/fixtures/render-fixtures` (Task 7, test-only):
  ```ts
  export function makeKartView(overrides?: Partial<KartView>): KartView
  ```
- Produces — the 6 exports of `render/camera` (contract §11's census):
  ```ts
  export type CameraMode = 'chase' | 'countdown' | 'results' | 'free'
  export interface CameraParams {
    distance: number; height: number; lookAhead: number
    positionLerpPerTick: number; headingLerpPerTick: number
    fovDegrees: number; fovBoostDegrees: number; near: number; far: number
  }
  export const DEFAULT_CAMERA_PARAMS: Readonly<CameraParams>
  export interface CameraState {
    position: Vec3; lookAt: Vec3; up: Vec3; fovDegrees: number; mode: CameraMode
  }
  export function createCameraState(): CameraState
  export function updateCamera(cam: CameraState, target: KartView, params: CameraParams,
                               mode: CameraMode, ticks: number): void
  ```

**The behaviour this task pins**, beyond the contract's own text:

- **Chase pose.** `forward = (cos h, 0, sin h)` (contract §0). The camera wants
  `target.position - forward * distance + (0, height, 0)` and a look target of
  `target.position + forward * lookAhead` at the kart's own `y`.
- **The look direction is angle-lerped on the shortest arc** around the kart, recovered
  from the current `lookAt` with `atan2`. A componentwise lerp of the look *point* swings
  the camera the long way round whenever the kart's heading crosses ±π.
- **Both lerps are computed against a target held fixed for the whole call**, which is
  what makes the N-vs-1 equality exact rather than approximate.
- **Snap rule.** A camera whose `position` equals its `lookAt` exactly — which is what
  `createCameraState()` returns — is uninitialised and snaps to the desired pose instead
  of swooping in from the world origin across the first second of the race. `'countdown'`
  snaps for the same reason: the pre-race camera should be locked, not settling.
- **`'results'`** uses the same pose with `lookAhead = 0`, so the camera settles on the
  kart itself. **`'free'`** updates `mode` and `fovDegrees` and leaves the pose alone.
- **FOV is set, not smoothed:** `params.fovDegrees + params.fovBoostDegrees *
  clamp(target.boostTicks / ITEM_BOOST_TICKS, 0, 1)`, so the boost kick is instant.

---

- [ ] **Step 1: Write the failing test**

Create `packages/render/test/camera.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { ITEM_BOOST_TICKS } from '@tapkart/sim'

import type { CameraState } from '../src/camera'
import { DEFAULT_CAMERA_PARAMS, createCameraState, updateCamera } from '../src/camera'
import { makeKartView } from './fixtures/render-fixtures'

const P = DEFAULT_CAMERA_PARAMS

function clone(cam: CameraState): CameraState {
  return {
    position: { ...cam.position },
    lookAt: { ...cam.lookAt },
    up: { ...cam.up },
    fovDegrees: cam.fovDegrees,
    mode: cam.mode,
  }
}

/**
 * A camera that is already following a kart. Every smoothing test must start from one:
 * a freshly created camera SNAPS, and a snap makes "N ticks equals one call of N" true
 * for any factor at all — including the broken `k * ticks` this suite exists to reject.
 */
function seeded(): CameraState {
  const cam = createCameraState()
  updateCamera(cam, makeKartView({ position: { x: 10, y: 1, z: 4 }, heading: 0.3 }), P, 'chase', 1)
  return cam
}

/** The yaw the camera is looking along, recovered around the kart it is following. */
function lookYaw(cam: CameraState, at: { x: number; z: number }): number {
  return Math.atan2(cam.lookAt.z - at.z, cam.lookAt.x - at.x)
}

describe('DEFAULT_CAMERA_PARAMS', () => {
  it('is exactly the nine numbers the contract states', () => {
    expect(DEFAULT_CAMERA_PARAMS).toEqual({
      distance: 7,
      height: 3,
      lookAhead: 8,
      positionLerpPerTick: 0.18,
      headingLerpPerTick: 0.22,
      fovDegrees: 62,
      fovBoostDegrees: 8,
      near: 0.3,
      far: 900,
    })
  })
})

describe('createCameraState', () => {
  it('starts at the origin with a +y up vector, in chase mode', () => {
    const cam = createCameraState()
    expect(cam.position).toEqual({ x: 0, y: 0, z: 0 })
    expect(cam.lookAt).toEqual({ x: 0, y: 0, z: 0 })
    expect(cam.up).toEqual({ x: 0, y: 1, z: 0 })
    expect(cam.fovDegrees).toBe(P.fovDegrees)
    expect(cam.mode).toBe('chase')
  })

  // The bug: one shared Vec3 across position/lookAt/up, or two cameras sharing one
  // object. Both produce a camera that cannot be positioned at all, and a shape-only
  // assertion passes.
  it('gives position, lookAt and up their own objects, per camera', () => {
    const a = createCameraState()
    const b = createCameraState()
    a.position.x = 5
    expect(a.lookAt.x).toBe(0)
    expect(a.up.x).toBe(0)
    expect(b.position.x).toBe(0)
  })
})

describe('updateCamera', () => {
  it('ticks = 0 changes nothing at all, including mode and fov', () => {
    const cam = seeded()
    const before = clone(cam)
    updateCamera(cam, makeKartView({ position: { x: 99, y: 9, z: 99 }, boostTicks: 90 }), P, 'results', 0)
    expect(cam).toEqual(before)
    updateCamera(cam, makeKartView(), P, 'chase', -3)
    expect(cam).toEqual(before)
  })

  /**
   * The exact chase pose, with no smoothing in the way (a fresh camera snaps). The bug
   * this catches is a sign error on `distance`, which puts the camera in FRONT of the
   * kart looking back — the game is then unplayable and every convergence and equality
   * test in this file still passes.
   */
  it('a fresh camera snaps to the exact chase pose', () => {
    const cam = createCameraState()
    const target = makeKartView({ position: { x: 10, y: 1, z: 4 }, heading: 0 })
    updateCamera(cam, target, P, 'chase', 1)
    expect(cam.position.x).toBeCloseTo(10 - P.distance, 9)
    expect(cam.position.y).toBeCloseTo(1 + P.height, 9)
    expect(cam.position.z).toBeCloseTo(4, 9)
    expect(cam.lookAt.x).toBeCloseTo(10 + P.lookAhead, 9)
    expect(cam.lookAt.y).toBeCloseTo(1, 9)
    expect(cam.lookAt.z).toBeCloseTo(4, 9)
    // the camera is behind the kart, and the kart is between the camera and the target
    expect(cam.position.x).toBeLessThan(target.position.x)
    expect(cam.lookAt.x).toBeGreaterThan(target.position.x)
  })

  /**
   * §8.1: N calls with 1 tick equal 1 call with N ticks, to 1e-9. This is the assertion
   * that rejects `k * ticks` pooling — and the second half of the test proves it can:
   * the naive factor 0.18 * 8 = 1.44 lands the camera 20+ metres past where the pooled
   * factor 1 - 0.82^8 = 0.7956 does.
   */
  it('N calls of 1 tick equal 1 call of N ticks, from an already-following camera', () => {
    const stepwise = seeded()
    const once = clone(stepwise)
    const target = makeKartView({ position: { x: 40, y: 2, z: 30 }, heading: -1.2 })

    for (let i = 0; i < 8; i++) updateCamera(stepwise, target, P, 'chase', 1)
    updateCamera(once, target, P, 'chase', 8)

    for (const axis of ['x', 'y', 'z'] as const) {
      expect(Math.abs(stepwise.position[axis] - once.position[axis])).toBeLessThan(1e-9)
      expect(Math.abs(stepwise.lookAt[axis] - once.lookAt[axis])).toBeLessThan(1e-9)
    }

    const start = seeded()
    const desiredX = target.position.x - Math.cos(target.heading) * P.distance
    const naiveX = start.position.x + (desiredX - start.position.x) * (P.positionLerpPerTick * 8)
    expect(Math.abs(naiveX - once.position.x)).toBeGreaterThan(1)
  })

  it('converges monotonically toward the desired pose and stays there', () => {
    const cam = seeded()
    const target = makeKartView({ position: { x: 60, y: 5, z: -20 }, heading: 2 })
    const desired = {
      x: target.position.x - Math.cos(target.heading) * P.distance,
      y: target.position.y + P.height,
      z: target.position.z - Math.sin(target.heading) * P.distance,
    }
    let previous = Infinity
    for (let i = 0; i < 40; i++) {
      updateCamera(cam, target, P, 'chase', 1)
      const d = Math.hypot(
        cam.position.x - desired.x,
        cam.position.y - desired.y,
        cam.position.z - desired.z,
      )
      expect(d).toBeLessThan(previous)
      previous = d
    }
    expect(previous).toBeLessThan(0.1)
  })

  it('is deterministic: identical inputs give identical output', () => {
    const a = seeded()
    const b = seeded()
    const target = makeKartView({ position: { x: 12, y: 0.5, z: -7 }, heading: 1.9, boostTicks: 30 })
    for (let i = 0; i < 5; i++) {
      updateCamera(a, target, P, 'chase', 3)
      updateCamera(b, target, P, 'chase', 3)
    }
    expect(a).toEqual(b)
  })

  /**
   * The shortest-arc rule. A componentwise lerp of the look POINT (or an unwrapped angle
   * lerp) swings the camera the long way round every time the kart's heading crosses
   * +/-pi: from -3.0 rad toward +3.0 rad the naive result is -1.68 rad — a 1.3 rad whip
   * in one tick, in the wrong direction.
   */
  it('turns the short way when the target heading crosses +/-pi', () => {
    const at = { x: 0, y: 0, z: 0 }
    const cam = createCameraState()
    updateCamera(cam, makeKartView({ position: at, heading: -3 }), P, 'chase', 1) // snap
    expect(lookYaw(cam, at)).toBeCloseTo(-3, 9)

    updateCamera(cam, makeKartView({ position: at, heading: 3 }), P, 'chase', 1)
    const expected = -3 + (6 - 2 * Math.PI) * P.headingLerpPerTick // = -3.0623...
    expect(lookYaw(cam, at)).toBeCloseTo(expected, 9)
    expect(lookYaw(cam, at)).toBeLessThan(-3) // short way: away from zero, not toward it
  })

  it('sets fov from boostTicks instantly, clamped', () => {
    const cases: readonly [string, number, number][] = [
      ['no boost', 0, P.fovDegrees],
      ['half boost', ITEM_BOOST_TICKS / 2, P.fovDegrees + P.fovBoostDegrees / 2],
      ['full boost', ITEM_BOOST_TICKS, P.fovDegrees + P.fovBoostDegrees],
      ['stacked boost, clamped', ITEM_BOOST_TICKS * 3, P.fovDegrees + P.fovBoostDegrees],
    ]
    for (const [, boostTicks, want] of cases) {
      const cam = seeded()
      updateCamera(cam, makeKartView({ boostTicks }), P, 'chase', 1)
      expect(cam.fovDegrees).toBeCloseTo(want, 9)
    }
  })

  it('rewrites up every update, so an adapter never has to invent one', () => {
    const cam = seeded()
    cam.up.x = 7
    cam.up.y = -2
    cam.up.z = 3
    updateCamera(cam, makeKartView(), P, 'chase', 1)
    expect(cam.up).toEqual({ x: 0, y: 1, z: 0 })
  })

  it('copies the mode it was given', () => {
    const cam = seeded()
    updateCamera(cam, makeKartView(), P, 'results', 1)
    expect(cam.mode).toBe('results')
    updateCamera(cam, makeKartView(), P, 'free', 1)
    expect(cam.mode).toBe('free')
  })

  it("'countdown' snaps rather than settling", () => {
    const cam = seeded()
    const target = makeKartView({ position: { x: -30, y: 3, z: 18 }, heading: 0.7 })
    updateCamera(cam, target, P, 'countdown', 1)
    expect(cam.position.x).toBeCloseTo(target.position.x - Math.cos(0.7) * P.distance, 9)
    expect(cam.position.z).toBeCloseTo(target.position.z - Math.sin(0.7) * P.distance, 9)
    expect(cam.position.y).toBeCloseTo(target.position.y + P.height, 9)
  })

  it("'results' looks at the kart itself", () => {
    const cam = seeded()
    const target = makeKartView({ position: { x: 5, y: 2, z: -9 }, heading: 1.1 })
    updateCamera(cam, target, P, 'results', 1)
    expect(cam.lookAt.x).toBeCloseTo(target.position.x, 9)
    expect(cam.lookAt.y).toBeCloseTo(target.position.y, 9)
    expect(cam.lookAt.z).toBeCloseTo(target.position.z, 9)
  })

  it("'free' updates mode and fov but leaves the pose to whoever owns it", () => {
    const cam = seeded()
    const pose = { position: { ...cam.position }, lookAt: { ...cam.lookAt } }
    updateCamera(cam, makeKartView({ position: { x: 500, y: 50, z: 500 }, boostTicks: 90 }), P, 'free', 4)
    expect(cam.position).toEqual(pose.position)
    expect(cam.lookAt).toEqual(pose.lookAt)
    expect(cam.mode).toBe('free')
    expect(cam.fovDegrees).toBeCloseTo(P.fovDegrees + P.fovBoostDegrees, 9)
  })

  it('never reads a clock: the same call at any wall time gives the same pose', () => {
    // Structural, not temporal: updateCamera takes ticks and nothing else time-shaped.
    // A camera that reached for Date.now() would drift between these two runs.
    const a = seeded()
    const b = seeded()
    const target = makeKartView({ position: { x: 3, y: 0, z: 3 }, heading: 0.4 })
    updateCamera(a, target, P, 'chase', 6)
    const spin = Date.now() + 2
    while (Date.now() < spin) {
      /* burn a couple of milliseconds */
    }
    updateCamera(b, target, P, 'chase', 6)
    expect(a).toEqual(b)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/render/test/camera.test.ts`

Expected: FAIL to collect, with
`Error: Cannot find module '../src/camera' imported from '/home/kasm-user/tapkart/packages/render/test/camera.test.ts'`
(caused by `Failed to load url ../src/camera ... Does the file exist?`).

- [ ] **Step 3: Write the implementation**

Create `packages/render/src/camera.ts`:

```ts
// PURE (contract §0a): no DOM, no GPU, no clock, no `three` import. Smoothing is per SIM
// TICK, never per frame — a frame-rate-dependent lerp behaves differently on a 60 Hz
// phone and a 144 Hz desktop and cannot be asserted in CI at all.
import type { Vec3 } from '@tapkart/sim'
import { ITEM_BOOST_TICKS, clamp, wrapAngle } from '@tapkart/sim'
import type { KartView } from './types'

export type CameraMode = 'chase' | 'countdown' | 'results' | 'free'

export interface CameraParams {
  distance: number // metres behind the kart
  height: number // metres above the kart
  lookAhead: number // metres ahead of the kart for the look target
  positionLerpPerTick: number // 0..1, applied once per sim tick
  headingLerpPerTick: number // 0..1, applied once per sim tick, shortest arc
  fovDegrees: number
  fovBoostDegrees: number // ADDITIONAL degrees at full boost, blended by boostTicks
  near: number // metres
  far: number // metres
}

export const DEFAULT_CAMERA_PARAMS: Readonly<CameraParams> = {
  distance: 7,
  height: 3,
  lookAhead: 8,
  positionLerpPerTick: 0.18,
  headingLerpPerTick: 0.22,
  fovDegrees: 62,
  fovBoostDegrees: 8,
  near: 0.3,
  far: 900,
}

export interface CameraState {
  position: Vec3
  lookAt: Vec3
  up: Vec3 // (0, 1, 0) in every v1 mode; a field, not a constant, so the adapter never
  // invents one
  fovDegrees: number
  mode: CameraMode
}

/** A camera that has not followed anything yet: `position` equals `lookAt`, which is the
 *  marker `updateCamera` reads to snap on its first update instead of swooping in from
 *  the world origin across the first second of the race. */
export function createCameraState(): CameraState {
  return {
    position: { x: 0, y: 0, z: 0 },
    lookAt: { x: 0, y: 0, z: 0 },
    up: { x: 0, y: 1, z: 0 },
    fovDegrees: DEFAULT_CAMERA_PARAMS.fovDegrees,
    mode: 'chase',
  }
}

/**
 * Advances `cam` by exactly `ticks` sim ticks toward the pose implied by `target`.
 * `ticks` may be 0 (a render frame with no sim tick), in which case nothing changes.
 * Deterministic: same (cam, target, params, mode, ticks) in, same cam out. SOLE WRITER of
 * every CameraState field (§7.2).
 */
export function updateCamera(
  cam: CameraState,
  target: KartView,
  params: CameraParams,
  mode: CameraMode,
  ticks: number,
): void {
  if (ticks <= 0) return

  cam.mode = mode
  cam.up.x = 0
  cam.up.y = 1
  cam.up.z = 0
  // set directly rather than smoothed, so the boost kick is instant
  cam.fovDegrees =
    params.fovDegrees + params.fovBoostDegrees * clamp(target.boostTicks / ITEM_BOOST_TICKS, 0, 1)

  // 'free' is driven by something other than the target, so the pose is left alone.
  if (mode === 'free') return

  // forward = (cos h, 0, sin h), contract §0
  const forwardX = Math.cos(target.heading)
  const forwardZ = Math.sin(target.heading)
  const lookAhead = mode === 'results' ? 0 : params.lookAhead

  // The desired pose is computed ONCE, from `target`, and held fixed for the whole call.
  // That is what makes "N calls of 1 tick" and "1 call of N ticks" agree exactly.
  const desiredX = target.position.x - forwardX * params.distance
  const desiredY = target.position.y + params.height
  const desiredZ = target.position.z - forwardZ * params.distance

  const uninitialised =
    cam.position.x === cam.lookAt.x &&
    cam.position.y === cam.lookAt.y &&
    cam.position.z === cam.lookAt.z
  const snap = uninitialised || mode === 'countdown'

  // Pooled, not multiplied: with k = 0.18 and 8 ticks, 1 - 0.82**8 = 0.796 converges,
  // while k * ticks = 1.44 overshoots the target and oscillates.
  const kPosition = snap ? 1 : 1 - (1 - params.positionLerpPerTick) ** ticks
  const kHeading = snap ? 1 : 1 - (1 - params.headingLerpPerTick) ** ticks

  cam.position.x += (desiredX - cam.position.x) * kPosition
  cam.position.y += (desiredY - cam.position.y) * kPosition
  cam.position.z += (desiredZ - cam.position.z) * kPosition

  // The look direction is angle-lerped around the kart on the SHORTEST ARC. Lerping the
  // look point componentwise swings the camera the long way round whenever the kart's
  // heading crosses +/-pi. When the current look point sits on the kart (lookAhead 0, or a
  // camera that has just left 'results'), there is no direction to recover and the yaw
  // starts from the kart's own heading.
  const dx = cam.lookAt.x - target.position.x
  const dz = cam.lookAt.z - target.position.z
  const current = Math.hypot(dx, dz) < 1e-9 ? target.heading : Math.atan2(dz, dx)
  const yaw = wrapAngle(current + wrapAngle(target.heading - current) * kHeading)

  cam.lookAt.x = target.position.x + Math.cos(yaw) * lookAhead
  cam.lookAt.y = target.position.y
  cam.lookAt.z = target.position.z + Math.sin(yaw) * lookAhead
}
```

Then modify `packages/render/src/index.ts` — append one line after
`export * from './descriptors'`:

```ts
export * from './types'
export * from './mesh'
export * from './descriptors'
export * from './camera'
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/render/test/camera.test.ts`
Expected: PASS — 16 tests.

Then:

```bash
npm run typecheck --workspace @tapkart/render
npx vitest run
```

- [ ] **Step 5: Commit**

```bash
git add packages/render/src/camera.ts packages/render/src/index.ts \
        packages/render/test/camera.test.ts && \
git commit -m "feat(render): pure tick-driven chase camera

- updateCamera advances by exactly N ticks with a pooled 1 - (1 - k)**ticks factor, so
  N calls of 1 tick equal 1 call of N to 1e-9 and frame rate cannot change the feel
- ticks = 0 is a total no-op; no clock is read anywhere
- look direction is angle-lerped on the shortest arc, so a heading crossing +/-pi does
  not swing the camera the long way round
- fov is set, not smoothed, from clamp(boostTicks / ITEM_BOOST_TICKS)"
```

---

### Task 11: `packages/render/src/frame.ts` — frame vocabulary, constants, and the two sim-mirroring helpers

`src/frame.ts` is the largest module in the plan, so it is authored in two tasks.
**This task** creates the file with the three frame structs, `createRenderFrame`,
all eleven exported constants, `bubblePosition` and `surgeAffects` — everything
whose correctness is decided by agreement with `@tapkart/sim` rather than by
the derived-field table. **Task 12** adds `buildRenderFrame`, the derived-field
table itself, into the same file. The split is at a real seam: this task's tests
run a real `SimState` and assert `render` agrees with `sim`; Task 12's tests
hand-build a `RaceView` and assert exact per-field values.

Contract §4.7. Rulings Q27, Q28, Q29.

**Files:**
- Create: `packages/render/src/frame.ts`
- Test: `packages/render/test/frame-core.test.ts`

**Interfaces:**

- Consumes, from `@tapkart/sim` (contract §2.1, §2.2 — quoted verbatim):
  ```ts
  export type Vec3 = { x: number; y: number; z: number }
  export type EntityKind = 'seeker' | 'bolt' | 'slick' | 'bubble' | 'surge' | 'charge'
  export const MAX_KARTS = 8
  export const MAX_ENTITIES = 32
  export function v3(x: number, y: number, z: number): Vec3
  // used by this task's tests only:
  export function createState(ctx: SimContext, seed: number, characterIdx: number[]): SimState
  export function spawnEntity(state: SimState, kind: EntityKind, ownerId: number,
                              position: Vec3, heading: number, targetId: number,
                              ttl: number, events: AuthEvent[]): number
  export function updateEntities(ctx: SimContext, state: SimState, events: AuthEvent[]): void
  export function surgeActiveOn(state: SimState, playerId: number): boolean
  export function computePlacement(state: SimState, outIndexOf: Int32Array,
                                   outOrder: Int32Array): void   // both length MAX_KARTS
  ```
- Consumes, from `@tapkart/content` (contract §3a.3):
  ```ts
  export type PaletteRGB = readonly [number, number, number]   // linear, 0..1
  ```
- Consumes, from `packages/render/src/camera.ts` (contract §4.6, an earlier task):
  ```ts
  export type CameraMode = 'chase' | 'countdown' | 'results' | 'free'
  export interface CameraState {
    position: Vec3; lookAt: Vec3; up: Vec3; fovDegrees: number; mode: CameraMode
  }
  export function createCameraState(): CameraState
  ```
- Consumes, from `packages/render/src/types.ts` (contract §4.2, an earlier task):
  ```ts
  export type ViewSource = 'authoritative' | 'predicted' | 'interpolated' | 'absent'
  export interface KartView { playerId: number; characterIdx: number; source: ViewSource
    position: Vec3; heading: number; velocity: Vec3; angularVelocity: number; speed: number
    s: number; bankAngle: number; driftActive: boolean; driftDir: -1 | 0 | 1
    driftCharge: number; driftTier: number; airborne: boolean; surface: Surface
    spinOutTicks: number; invulnTicks: number; boostTicks: number; respawnTicks: number
    shielded: boolean; item: ItemKind; lap: number; checkpointIdx: number; t: number
    place: number; isBot: boolean; connected: boolean }
  export interface EntityView { entityId: number; kind: EntityKind; ownerId: number
    source: ViewSource; position: Vec3; velocity: Vec3; heading: number; ttl: number }
  export interface ItemBoxView { boxIdx: number; position: Vec3; respawnTicks: number }
  export interface RaceView { tick: number; alpha: number; phase: RacePhase
    localPlayerId: number; raceStartTick: number; karts: KartView[]; entities: EntityView[]
    entityCount: number; itemBoxes: ItemBoxView[]; itemBoxRespawnTicks: number
    finishedOrder: number[]; finishTick: number; countdownTicksLeft: number }
  export function createRaceView(itemBoxCount: number): RaceView
  ```
- Consumes, from `packages/render/test/fixtures/render-fixtures.ts` (contract §9.1, an earlier task):
  ```ts
  export function makeRenderContext(): SimContext
  ```
- Produces — every symbol below is imported by Task 12, by `src/index.ts` and by
  the Three.js adapter:
  ```ts
  export interface KartDraw { playerId: number; characterIdx: number; visible: boolean
    position: Vec3; heading: number; roll: number; wheelSpin: number; steerAngle: number
    bodyTint: PaletteRGB; alpha: number; driftSparkTier: number; boostFlame: number
    shieldVisible: boolean }
  export interface EntityDraw { entityId: number; kind: EntityKind; visible: boolean
    position: Vec3; heading: number; scale: number; tint: PaletteRGB; alpha: number }
  export interface RenderFrame { camera: CameraState; karts: KartDraw[]
    entities: EntityDraw[]; entityCount: number; itemBoxAlpha: Float32Array
    screenFlash: number; screenTintColor: PaletteRGB; screenTintAmount: number
    sourceTick: number }
  export function createRenderFrame(itemBoxCount: number): RenderFrame
  export function bubblePosition(ownerPosition: Vec3, heading: number, out: Vec3): void
  export function surgeAffects(view: RaceView, playerId: number): boolean
  export const BUBBLE_ORBIT_RADIUS_M = 2.0
  export const KART_DRIFT_LEAN_RADIANS = 0.22
  export const KART_SPINOUT_ROLL_RADIANS = 0.15
  export const KART_STEER_VISUAL_MAX_RADIANS = 0.5
  export const KART_STEER_VISUAL_YAW_RATE = 2.6
  export const INVULN_FLICKER_PERIOD_TICKS = 8
  export const INVULN_FLICKER_ALPHA = 0.35
  export const SURGE_TINT: PaletteRGB
  export const SURGE_TINT_AMOUNT = 0.28
  export const CHARGE_FLASH_RADIUS_M = 20
  export const ENTITY_SCALE: Readonly<Record<EntityKind, number>>
  ```

**Three things a reader must not get wrong**

1. **`render` adds no cosmetic orbit to the bubble (Q28).** `sim` already orbits
   it: `packages/sim/src/entity.ts:196-208` advances `e.heading` by
   `BUBBLE_ORBIT_RATE * TICK_DT` each tick and rewrites `e.position` to
   `owner.position + BUBBLE_ORBIT_RADIUS` at that heading, with
   `e.position.y = owner.position.y`. `bubblePosition` is **that same formula**,
   exported so the frame builder and its test call one function. It exists
   because at the 20 Hz snapshot rate consecutive sampled bubble positions are
   ~0.3 rad apart on the circle, and lerping those positions *chords across the
   orbit* — the bubble collapses toward its owner and springs back, 20 times a
   second. Task 12 applies it; this task proves it reproduces `sim` exactly.
2. **`BUBBLE_ORBIT_RADIUS_M` is a copy of a module-private `sim` constant**
   (`entity.ts:12`, `const BUBBLE_ORBIT_RADIUS = 2.0`), declared here because
   `render` may not widen `sim`'s exports. The re-derivation test below is
   **required** by contract §8.1 and is the only thing keeping the copy honest.
   Do not change one without the other.
3. **The double-buffered `RaceView`.** The session allocates **two** `RaceView`s
   and alternates them per frame (the audio model needs a previous view — see
   Task 14); the swap is owned by the session/shell tasks. Nothing in this file
   is affected: `surgeAffects` and `bubblePosition` read only the arguments they
   are handed, and `createRenderFrame` allocates one `RenderFrame` for the whole
   session regardless of how many views exist.

**Two contract gaps this task closes, and how** — flagged rather than buried,
because contract §4.7's constant list is otherwise exhaustive:

- **`ENTITY_SCALE`'s numbers are not in the contract.** They are set to `sim`'s
  own strike radii for the four kinds that strike (`hitRadiusFor`,
  `packages/sim/src/entity.ts:125-138`: seeker 1.6, bolt 1.4, slick 1.2, charge
  6.0), so the drawn object is the collision volume — the same principle that
  makes `itemBoxWorldPos` the sole owner of a box's position. `bubble` is 0.6: it
  has no strike radius (its collision role is the `shielded` flag), and it orbits
  at 2 m, so it must be small enough to read as an orbiting orb rather than a
  sphere swallowing the kart. `surge` is 0 because it is never drawn (Q27).
- **`createRenderFrame`'s "every field zeroed" is taken literally except twice.**
  `driftSparkTier` starts at `-1` and `EntityDraw.entityId` starts at `-1`,
  because in both encodings `0` is a *real* value: contract §0 pins `-1` as
  sim's "no mini-turbo pending" and §4.2 pins `-1` as the unused-entity-slot
  sentinel. Writing `0` into a field whose `0` means "tier 0 pending" is the
  two-encodings-of-one-fact defect this contract exists to prevent.

---

- [ ] **Step 1: Write the failing test**

Create `packages/render/test/frame-core.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { AuthEvent, EntityKind } from '@tapkart/sim'
import {
  MAX_ENTITIES,
  MAX_KARTS,
  computePlacement,
  createState,
  spawnEntity,
  surgeActiveOn,
  updateEntities,
  v3,
} from '@tapkart/sim'
import { createRaceView } from '../src/types'
import {
  BUBBLE_ORBIT_RADIUS_M,
  ENTITY_SCALE,
  bubblePosition,
  createRenderFrame,
  surgeAffects,
} from '../src/frame'
import { makeRenderContext } from './fixtures/render-fixtures'

const ALL_KINDS: readonly EntityKind[] = [
  'seeker',
  'bolt',
  'slick',
  'bubble',
  'surge',
  'charge',
]

/**
 * A real SimState carrying one live bubble owned by seat 0, stepped `ticks`
 * times through sim's own updateEntities.
 *
 * `shielded` must be true: updateEntities' bubble-consistency pass
 * (entity.ts:277-284) despawns a bubble whose owner is not shielded, and a
 * despawned bubble would make every assertion below vacuous — which is why the
 * tests assert entityCount === 1 on every tick.
 */
function bubbleState(ticks: number): {
  ownerX: number
  ownerY: number
  ownerZ: number
  heading: number
  x: number
  y: number
  z: number
  count: number
} {
  const ctx = makeRenderContext()
  const state = createState(ctx, 0x5eed, Array.from({ length: MAX_KARTS }, () => 0))
  const events: AuthEvent[] = []
  state.karts[0].shielded = true
  // Spawned AT the owner: a bubble that never moves therefore sits at radius 0
  // and fails the radius assertion immediately.
  spawnEntity(state, 'bubble', 0, state.karts[0].position, 0, -1, 600, events)
  for (let n = 0; n < ticks; n++) updateEntities(ctx, state, events)
  const e = state.entities[0]
  const owner = state.karts[0]
  return {
    ownerX: owner.position.x,
    ownerY: owner.position.y,
    ownerZ: owner.position.z,
    heading: e.heading,
    x: e.position.x,
    y: e.position.y,
    z: e.position.z,
    count: state.entityCount,
  }
}

describe('createRenderFrame', () => {
  it('allocates fixed-length arrays, itemBoxAlpha of 1, sourceTick 0', () => {
    const f = createRenderFrame(3)
    expect(f.karts).toHaveLength(MAX_KARTS)
    expect(f.entities).toHaveLength(MAX_ENTITIES)
    expect(f.itemBoxAlpha).toBeInstanceOf(Float32Array)
    expect(f.itemBoxAlpha).toHaveLength(3)
    expect(Array.from(f.itemBoxAlpha)).toEqual([1, 1, 1])
    expect(f.sourceTick).toBe(0)
    expect(f.entityCount).toBe(0)
    expect(f.screenFlash).toBe(0)
    expect(f.screenTintAmount).toBe(0)
    expect(f.screenTintColor).toHaveLength(3)
  })

  // Catches the aliasing bug: filling the pool with one shared object literal
  // (`const p = v3(0,0,0); for (...) karts.push({ position: p, ... })`). Every
  // kart then renders at the same place, and no length or count assertion sees
  // it. Object identity is asserted, not values, so this does not depend on any
  // default createCameraState chooses.
  it('gives every Vec3 in the frame a distinct object', () => {
    const f = createRenderFrame(2)
    expect(f.karts[0].position).not.toBe(f.karts[1].position)
    expect(f.entities[0].position).not.toBe(f.entities[1].position)
    expect(f.karts[0].position).not.toBe(f.entities[0].position)
    expect(f.camera.position).not.toBe(f.camera.lookAt)
    expect(f.camera.position).not.toBe(f.karts[0].position)
    f.karts[0].position.x = 7
    f.entities[0].position.z = 9
    expect(f.karts[1].position.x).toBe(0)
    expect(f.entities[1].position.z).toBe(0)
  })

  // Catches a second RenderFrame sharing the first's buffers, which would make
  // two sessions in one process draw each other's karts.
  it('returns independent frames on every call', () => {
    const a = createRenderFrame(1)
    const b = createRenderFrame(1)
    expect(a.karts[0]).not.toBe(b.karts[0])
    expect(a.itemBoxAlpha).not.toBe(b.itemBoxAlpha)
    a.itemBoxAlpha[0] = 0.25
    expect(b.itemBoxAlpha[0]).toBe(1)
  })

  // The two deliberate departures from "every field zeroed": 0 is a real value
  // in both encodings, so a fresh frame that reports tier 0 and entity id 0 is
  // reporting live content it does not have.
  it('starts driftSparkTier and entityId at the -1 sentinels', () => {
    const f = createRenderFrame(1)
    expect(f.karts[0].driftSparkTier).toBe(-1)
    expect(f.entities[0].entityId).toBe(-1)
    expect(f.karts[0].visible).toBe(false)
    expect(f.entities[0].visible).toBe(false)
  })
})

describe('BUBBLE_ORBIT_RADIUS_M', () => {
  // REQUIRED by contract §8.1. BUBBLE_ORBIT_RADIUS is module-private in
  // packages/sim/src/entity.ts:12, so this copy is the one number in `render`
  // that can silently disagree with the simulation. It catches exactly that:
  // change sim's 2.0 to 2.5 and this fails, while every hand-built-view test in
  // Task 12 still passes.
  it('equals the orbit radius sim actually produces', () => {
    for (const ticks of [1, 5, 17, 60]) {
      const b = bubbleState(ticks)
      expect(b.count).toBe(1)
      const r = Math.hypot(b.x - b.ownerX, b.z - b.ownerZ)
      expect(r).toBeCloseTo(BUBBLE_ORBIT_RADIUS_M, 9)
    }
  })
})

describe('bubblePosition', () => {
  // The radius test above cannot catch a sin/cos swap or a dropped y — both
  // preserve the radius exactly. This one does: it compares all three
  // components against sim's own output over a full orbit's worth of ticks.
  it('reproduces sim’s bubble position exactly, tick by tick', () => {
    const out = v3(0, 0, 0)
    for (let ticks = 1; ticks <= 12; ticks++) {
      const b = bubbleState(ticks)
      expect(b.count).toBe(1)
      bubblePosition({ x: b.ownerX, y: b.ownerY, z: b.ownerZ }, b.heading, out)
      expect(out.x).toBeCloseTo(b.x, 9)
      expect(out.y).toBeCloseTo(b.y, 9)
      expect(out.z).toBeCloseTo(b.z, 9)
    }
  })

  // Non-vacuity guard for the test above: if sim ever stopped orbiting the
  // bubble, every component comparison would still pass while the bubble stood
  // still, and Q28's whole justification would be gone.
  it('is comparing against a bubble that actually moves', () => {
    const a = bubbleState(1)
    const b = bubbleState(12)
    expect(Math.hypot(b.x - a.x, b.z - a.z)).toBeGreaterThan(0.1)
  })

  it('writes all three components of out on every call', () => {
    const owner = v3(10, 2, -4)
    const out = v3(0, 0, 0)
    bubblePosition(owner, 0, out)
    expect(out.x).toBeCloseTo(10 + BUBBLE_ORBIT_RADIUS_M, 12)
    expect(out.y).toBe(2)
    expect(out.z).toBeCloseTo(-4, 12)
    bubblePosition(owner, Math.PI / 2, out)
    expect(out.x).toBeCloseTo(10, 12)
    expect(out.z).toBeCloseTo(-4 + BUBBLE_ORBIT_RADIUS_M, 12)
  })
})

describe('surgeAffects', () => {
  /** A view whose places come from the real comparator, plus a surge cast by
   *  `casterSeat`. Seat i is given lap MAX_KARTS-1-i, so place === seat. */
  function surgeView(casterSeat: number, entityCount: number) {
    const ctx = makeRenderContext()
    const state = createState(ctx, 7, Array.from({ length: MAX_KARTS }, () => 0))
    for (let i = 0; i < MAX_KARTS; i++) state.karts[i].lap.lap = MAX_KARTS - 1 - i
    const events: AuthEvent[] = []
    spawnEntity(state, 'surge', casterSeat, state.karts[casterSeat].position, 0, -1, 300, events)
    const indexOf = new Int32Array(MAX_KARTS)
    const order = new Int32Array(MAX_KARTS)
    computePlacement(state, indexOf, order)

    const view = createRaceView(ctx.track.itemBoxes.length)
    view.tick = state.tick
    view.entityCount = entityCount
    for (let i = 0; i < MAX_KARTS; i++) {
      const k = view.karts[i]
      k.playerId = i
      k.place = indexOf[i]
      k.source = 'authoritative'
    }
    const e = view.entities[0]
    e.entityId = state.entities[0].entityId
    e.kind = 'surge'
    e.ownerId = casterSeat
    e.source = 'authoritative'
    e.ttl = 300
    return { view, state }
  }

  // The flagship: agreement with sim's surgeActiveOn for every seat. The two
  // non-vacuity assertions are the point — an implementation that returns false
  // unconditionally agrees with sim on 3 of 8 seats and would pass a
  // seats-agree loop that happened to be built with no one affected.
  it('agrees with surgeActiveOn on every seat', () => {
    const { view, state } = surgeView(5, 1)
    const mine: boolean[] = []
    for (let pid = 0; pid < MAX_KARTS; pid++) {
      const got = surgeAffects(view, pid)
      expect(got).toBe(surgeActiveOn(state, pid))
      mine.push(got)
    }
    expect(mine.filter((v) => v)).not.toHaveLength(0)
    expect(mine.filter((v) => !v)).not.toHaveLength(0)
    expect(surgeAffects(view, 0)).toBe(true) // leader, ahead of the caster
    expect(surgeAffects(view, 5)).toBe(false) // the caster itself
    expect(surgeAffects(view, 6)).toBe(false) // placed behind the caster
    expect(surgeAffects(view, 7)).toBe(false)
  })

  // Catches iterating `view.entities.length` instead of `view.entityCount`: the
  // pool is MAX_ENTITIES long and slot 0 keeps its last contents, so a stale
  // surge would slow the whole field forever with no live entity on screen.
  it('ignores slots at or past entityCount', () => {
    const { view } = surgeView(5, 0)
    expect(view.entities[0].kind).toBe('surge')
    for (let pid = 0; pid < MAX_KARTS; pid++) {
      expect(surgeAffects(view, pid)).toBe(false)
    }
  })

  it('is false for an out-of-range seat', () => {
    const { view } = surgeView(5, 1)
    expect(surgeAffects(view, -1)).toBe(false)
    expect(surgeAffects(view, MAX_KARTS)).toBe(false)
  })

  // Catches "any live entity counts": only 'surge' slows anyone.
  it('is false when the live entity is not a surge', () => {
    const { view } = surgeView(5, 1)
    view.entities[0].kind = 'seeker'
    for (let pid = 0; pid < MAX_KARTS; pid++) {
      expect(surgeAffects(view, pid)).toBe(false)
    }
  })
})

describe('ENTITY_SCALE', () => {
  // A freeze. It catches an accidental edit to a shipped visual constant and a
  // kind added to the table with a garbage value; it cannot judge whether a
  // number looks right on a phone — §8.3 says that is owner-verified.
  it('has a finite, non-negative metre scale for every EntityKind', () => {
    for (const kind of ALL_KINDS) {
      const s = ENTITY_SCALE[kind]
      expect(Number.isFinite(s)).toBe(true)
      expect(s).toBeGreaterThanOrEqual(0)
    }
    expect(Object.keys(ENTITY_SCALE).sort()).toEqual([...ALL_KINDS].sort())
  })

  it('matches sim’s strike radii, and draws surge at nothing (Q27)', () => {
    expect(ENTITY_SCALE.seeker).toBe(1.6)
    expect(ENTITY_SCALE.bolt).toBe(1.4)
    expect(ENTITY_SCALE.slick).toBe(1.2)
    expect(ENTITY_SCALE.charge).toBe(6.0)
    expect(ENTITY_SCALE.bubble).toBe(0.6)
    expect(ENTITY_SCALE.surge).toBe(0)
  })
})
```

There is deliberately **no** `expect(BUBBLE_ORBIT_RADIUS_M).toBe(2.0)` test. It
would restate the source line it is meant to police and pass in every world where
the constant and `sim` disagree — the re-derivation test above is the one that
can fail.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/render/test/frame-core.test.ts`

Expected: FAIL — the module under test does not exist yet:

```
Error: Failed to load url ../src/frame (resolved id: /home/kasm-user/tapkart/packages/render/src/frame) in /home/kasm-user/tapkart/packages/render/test/frame-core.test.ts. Does the file exist?
```

- [ ] **Step 3: Write the implementation**

Create `packages/render/src/frame.ts`:

```ts
// PURE (contract §0a): no DOM, no GPU, no clock, no `three` import, and nothing
// in the frame path allocates. Task 12 adds buildRenderFrame to this file.
import type { EntityKind, Vec3 } from '@tapkart/sim'
import { MAX_ENTITIES, MAX_KARTS, v3 } from '@tapkart/sim'
import type { PaletteRGB } from '@tapkart/content'
import type { CameraState } from './camera'
import { createCameraState } from './camera'
import type { RaceView } from './types'

export interface KartDraw {
  playerId: number
  characterIdx: number
  visible: boolean
  position: Vec3
  heading: number // radians - COPIED from KartView, never modified
  roll: number // radians: bankAngle + drift lean + spin-out tilt
  wheelSpin: number // radians, accumulated per SIM TICK, wrapped
  steerAngle: number // radians, front wheels
  bodyTint: PaletteRGB
  alpha: number // 0..1; invulnerability flickers this
  driftSparkTier: number // sim's encoding, copied from KartView.driftTier
  boostFlame: number // 0..1
  shieldVisible: boolean
}

export interface EntityDraw {
  entityId: number
  kind: EntityKind
  visible: boolean
  position: Vec3
  heading: number
  scale: number // metres; the adapter's unit sphere/box is scaled by this
  tint: PaletteRGB
  alpha: number // 0..1
}

export interface RenderFrame {
  camera: CameraState
  karts: KartDraw[] // length MAX_KARTS
  entities: EntityDraw[] // length MAX_ENTITIES
  entityCount: number
  itemBoxAlpha: Float32Array // length = itemBoxes.length; Q29
  screenFlash: number // 0..1, charge blast
  screenTintColor: PaletteRGB
  screenTintAmount: number // 0..1, surge slow
  /** The view tick this frame's accumulators were last advanced to. The ONLY
   *  field of `out` that buildRenderFrame reads besides KartDraw.wheelSpin. */
  sourceTick: number
}

/**
 * sim's BUBBLE_ORBIT_RADIUS, which is module-private in
 * packages/sim/src/entity.ts:12. It is declared here rather than imported
 * because `render` may not widen sim's exports, and it is protected from drift
 * by a REQUIRED test that re-derives it from real sim behaviour (§8.1). Do not
 * change one without the other.
 */
export const BUBBLE_ORBIT_RADIUS_M = 2.0

/** Roll added while drifting, times driftDir. */
export const KART_DRIFT_LEAN_RADIANS = 0.22
/** Roll added while spinOutTicks > 0. */
export const KART_SPINOUT_ROLL_RADIANS = 0.15
/** Front-wheel deflection at full lock. */
export const KART_STEER_VISUAL_MAX_RADIANS = 0.5
/** rad/s of angularVelocity that reads as full lock. */
export const KART_STEER_VISUAL_YAW_RATE = 2.6
/** 7.5 Hz at 60 Hz. */
export const INVULN_FLICKER_PERIOD_TICKS = 8
export const INVULN_FLICKER_ALPHA = 0.35
export const SURGE_TINT: PaletteRGB = [0.35, 0.15, 0.55]
export const SURGE_TINT_AMOUNT = 0.28
export const CHARGE_FLASH_RADIUS_M = 20

/**
 * Metres, per kind. seeker/bolt/slick/charge are sim's own strike radii
 * (hitRadiusFor, packages/sim/src/entity.ts:125-138), so the drawn object IS
 * the collision volume. A bubble has no strike radius - its collision role is
 * the owner's `shielded` flag - and it orbits at BUBBLE_ORBIT_RADIUS_M, so it
 * is a small orb rather than a sphere that swallows the kart. A surge is never
 * drawn at all (Q27): it has no meaningful location, and drawing a mesh at a
 * meaningless position is worse than drawing nothing, because players will try
 * to dodge it.
 */
export const ENTITY_SCALE: Readonly<Record<EntityKind, number>> = {
  seeker: 1.6,
  bolt: 1.4,
  slick: 1.2,
  bubble: 0.6,
  surge: 0,
  charge: 6.0,
}

/**
 * Every field zeroed, every Vec3 distinct, `sourceTick = 0`, `itemBoxAlpha`
 * filled with 1. Called once per session, never per frame.
 *
 * Two fields start at -1 rather than 0, because 0 is a real value in both
 * encodings: `driftSparkTier` uses sim's tier encoding, where -1 is "no
 * mini-turbo pending" and 0 is a real tier (§0), and `entityId` uses §4.2's
 * unused-slot sentinel.
 */
export function createRenderFrame(itemBoxCount: number): RenderFrame {
  const karts: KartDraw[] = []
  for (let i = 0; i < MAX_KARTS; i++) {
    karts.push({
      playerId: 0,
      characterIdx: 0,
      visible: false,
      position: v3(0, 0, 0),
      heading: 0,
      roll: 0,
      wheelSpin: 0,
      steerAngle: 0,
      bodyTint: [0, 0, 0],
      alpha: 0,
      driftSparkTier: -1,
      boostFlame: 0,
      shieldVisible: false,
    })
  }

  const entities: EntityDraw[] = []
  for (let j = 0; j < MAX_ENTITIES; j++) {
    entities.push({
      entityId: -1,
      kind: 'seeker',
      visible: false,
      position: v3(0, 0, 0),
      heading: 0,
      scale: 0,
      tint: [0, 0, 0],
      alpha: 0,
    })
  }

  const itemBoxAlpha = new Float32Array(Math.max(0, itemBoxCount))
  itemBoxAlpha.fill(1)

  return {
    camera: createCameraState(),
    karts,
    entities,
    entityCount: 0,
    itemBoxAlpha,
    screenFlash: 0,
    screenTintColor: [0, 0, 0],
    screenTintAmount: 0,
    sourceTick: 0,
  }
}

/**
 * Q28's bubble reconstruction, exported so the frame builder and its test call
 * one function. This is sim's formula verbatim (entity.ts:196-208), applied to
 * interpolated inputs: `out = ownerPosition + (cos h, 0, sin h) *
 * BUBBLE_ORBIT_RADIUS_M`, with `out.y = ownerPosition.y`.
 *
 * Safe when `out === ownerPosition`: no component is read after it is written.
 */
export function bubblePosition(ownerPosition: Vec3, heading: number, out: Vec3): void {
  out.x = ownerPosition.x + Math.cos(heading) * BUBBLE_ORBIT_RADIUS_M
  out.y = ownerPosition.y
  out.z = ownerPosition.z + Math.sin(heading) * BUBBLE_ORBIT_RADIUS_M
}

/**
 * True when a live surge field cast by a kart PLACED BEHIND `playerId` is
 * slowing it. Derived from the view alone (entity kind + ownerId +
 * KartView.place) so it works identically on a guest, where `state()` cannot be
 * consulted. Mirrors `surgeActiveOn` in @tapkart/sim - lower place index is
 * further ahead - and a test asserts they agree for every seat.
 */
export function surgeAffects(view: RaceView, playerId: number): boolean {
  if (playerId < 0 || playerId >= MAX_KARTS) return false
  const mine = view.karts[playerId].place
  for (let j = 0; j < view.entityCount; j++) {
    const e = view.entities[j]
    if (e.kind !== 'surge') continue
    if (e.ownerId === playerId) continue
    if (e.ownerId < 0 || e.ownerId >= MAX_KARTS) continue
    if (mine < view.karts[e.ownerId].place) return true
  }
  return false
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/render/test/frame-core.test.ts`
Expected: PASS, 14 tests.

Then typecheck the package, because `noUnusedLocals` / `noUnusedParameters` /
`verbatimModuleSyntax` are not exercised by vitest:

Run: `npm run typecheck --workspace @tapkart/render`
Expected: exit 0, no output.

- [ ] **Step 5: Commit**

```bash
git add packages/render/src/frame.ts packages/render/test/frame-core.test.ts && git commit -m "feat(render): frame structs, constants, bubblePosition and surgeAffects

createRenderFrame allocates one RenderFrame per session with every Vec3
distinct. bubblePosition is sim's own bubble formula (Q28), and
BUBBLE_ORBIT_RADIUS_M is re-derived from a real stepped SimState by a required
test, because the constant is module-private in sim. surgeAffects mirrors
surgeActiveOn from the view alone so a guest resolves it identically."
```

---

### Task 12: `buildRenderFrame` — the derived-field table

The second half of `packages/render/src/frame.ts` (contract §4.7). Task 11
created the file, the structs, the eleven constants and the two sim-mirroring
helpers; this task adds **the** pure function of the package: `(RaceView,
CameraState, TrackTheme, descriptors) -> RenderFrame`.

**Files:**
- Modify: `packages/render/src/frame.ts` (append; imports at the top are widened)
- Test: `packages/render/test/frame-build.test.ts`

**Interfaces:**

- Consumes, from `packages/render/src/frame.ts` (Task 11):
  ```ts
  export interface KartDraw { playerId: number; characterIdx: number; visible: boolean
    position: Vec3; heading: number; roll: number; wheelSpin: number; steerAngle: number
    bodyTint: PaletteRGB; alpha: number; driftSparkTier: number; boostFlame: number
    shieldVisible: boolean }
  export interface EntityDraw { entityId: number; kind: EntityKind; visible: boolean
    position: Vec3; heading: number; scale: number; tint: PaletteRGB; alpha: number }
  export interface RenderFrame { camera: CameraState; karts: KartDraw[]
    entities: EntityDraw[]; entityCount: number; itemBoxAlpha: Float32Array
    screenFlash: number; screenTintColor: PaletteRGB; screenTintAmount: number
    sourceTick: number }
  export function createRenderFrame(itemBoxCount: number): RenderFrame
  export function bubblePosition(ownerPosition: Vec3, heading: number, out: Vec3): void
  export function surgeAffects(view: RaceView, playerId: number): boolean
  export const BUBBLE_ORBIT_RADIUS_M = 2.0
  export const KART_DRIFT_LEAN_RADIANS = 0.22
  export const KART_SPINOUT_ROLL_RADIANS = 0.15
  export const KART_STEER_VISUAL_MAX_RADIANS = 0.5
  export const KART_STEER_VISUAL_YAW_RATE = 2.6
  export const INVULN_FLICKER_PERIOD_TICKS = 8
  export const INVULN_FLICKER_ALPHA = 0.35
  export const SURGE_TINT: PaletteRGB
  export const SURGE_TINT_AMOUNT = 0.28
  export const CHARGE_FLASH_RADIUS_M = 20
  export const ENTITY_SCALE: Readonly<Record<EntityKind, number>>
  ```
- Consumes, from `@tapkart/sim` (contract §2.1, §2.2):
  ```ts
  export const TICK_DT = 1 / 60
  export const MAX_KARTS = 8
  export const MAX_ENTITIES = 32
  export function clamp(v: number, lo: number, hi: number): number
  export function wrapAngle(a: number): number
  export const ITEM_BOOST_TICKS = 90
  export const CHARGE_TTL_TICKS = 20
  export function v3(x: number, y: number, z: number): Vec3
  ```
- Consumes, from `@tapkart/content` (contract §3a.3, §3a.4):
  ```ts
  export type PaletteRGB = readonly [number, number, number]
  export interface CharacterDescriptor { id: string; name: string; bodyHeight: number
    bodyRadius: number; headRadius: number
    palette: { primary: PaletteRGB; secondary: PaletteRGB; accent: PaletteRGB }
    silhouette: 'compact' | 'tall' | 'wide' }
  export interface KartDescriptor { id: string; name: string; chassisLength: number
    chassisWidth: number; chassisHeight: number; wheelRadius: number; wheelWidth: number
    palette: { body: PaletteRGB; trim: PaletteRGB; wheel: PaletteRGB } }
  export interface EdgeMarkerParams { spacing: number; height: number; offset: number
    colors: readonly [PaletteRGB, PaletteRGB] }
  export interface TrackTheme { trackId: string; road: PaletteRGB; roadDirt: PaletteRGB
    shoulder: PaletteRGB; wall: PaletteRGB; ground: PaletteRGB
    sky: { top: PaletteRGB; bottom: PaletteRGB }
    fog: { color: PaletteRGB; near: number; far: number }
    sunDirection: Vec3; ambient: number; edgeMarkers: EdgeMarkerParams }
  ```
- Consumes, from `packages/render/src/types.ts` (§4.2) and `src/camera.ts` (§4.6):
  `RaceView`, `KartView`, `EntityView`, `ItemBoxView`, `createRaceView(itemBoxCount)`,
  `CameraState`, `createCameraState()` — full field lists are in Task 11's
  `Interfaces` block and in contract §4.2 / §4.6.
- Consumes, from `packages/render/test/fixtures/render-fixtures.ts` (§9.1):
  ```ts
  export function makeThemeFixture(): TrackTheme
  export function makeCharacterDescriptorFixture(): CharacterDescriptor
  export function makeKartDescriptorFixture(): KartDescriptor
  ```
- Produces:
  ```ts
  export function buildRenderFrame(view: RaceView, cam: CameraState, theme: TrackTheme,
                                   characters: readonly CharacterDescriptor[],
                                   karts: readonly KartDescriptor[],
                                   out: RenderFrame): void
  ```
  Called once per animation frame by `startShell` (§5.13), immediately before
  `renderer.applyFrame(frame)`.

**Preconditions a reader must not misread**

- **`buildRenderFrame` reads the CURRENT view only.** The session allocates two
  `RaceView`s and alternates them per frame (Task 14 explains why: the audio
  model needs a previous view; the swap is owned by the session/shell tasks).
  That alternation does not reach this function: it takes whichever view is
  current, and its two accumulators — `out.sourceTick` and
  `out.karts[i].wheelSpin` — live on the `RenderFrame`, which is allocated once
  and never swapped.
- **It reads exactly two things out of `out`**: `out.sourceTick` and
  `out.karts[i].wheelSpin`. Every other field of `out` is write-only. That is
  what makes wheel rotation frame-rate independent while keeping the function a
  deterministic function of (inputs, prior accumulator).
- **`characters` and `karts` are both length 8, indexed by `characterIdx`** —
  never by seat. `KART_DESCRIPTORS[i]` is the kart of `CHARACTER_DESCRIPTORS[i]`
  (§3a.3).
- **Karts are filled before entities**, because a bubble's position is
  reconstructed from its owner's already-resolved `KartDraw.position`.

**The derived-field table, copied from contract §4.7 verbatim.** `k` is
`view.karts[i]`, `dt = max(0, view.tick - out.sourceTick)`:

| Field | Value |
|---|---|
| `visible` | `k.source !== 'absent'` |
| `position` | copied from `k.position` |
| `heading` | copied from `k.heading`, **unmodified** |
| `roll` | `k.bankAngle + (k.driftActive ? KART_DRIFT_LEAN_RADIANS * k.driftDir : 0) + (k.spinOutTicks > 0 ? KART_SPINOUT_ROLL_RADIANS : 0)` |
| `wheelSpin` | `wrapAngle(prevWheelSpin + (k.speed / karts[k.characterIdx].wheelRadius) * TICK_DT * dt)` |
| `steerAngle` | `clamp(k.angularVelocity / KART_STEER_VISUAL_YAW_RATE, -1, 1) * KART_STEER_VISUAL_MAX_RADIANS` |
| `bodyTint` | `karts[k.characterIdx].palette.body` |
| `alpha` | `k.invulnTicks > 0 && (view.tick % INVULN_FLICKER_PERIOD_TICKS) >= INVULN_FLICKER_PERIOD_TICKS / 2 ? INVULN_FLICKER_ALPHA : 1` |
| `driftSparkTier` | copied from `k.driftTier` |
| `boostFlame` | `clamp(k.boostTicks / ITEM_BOOST_TICKS, 0, 1)` |
| `shieldVisible` | `k.shielded` |
| `itemBoxAlpha[b]` | `clamp(1 - box.respawnTicks / view.itemBoxRespawnTicks, 0, 1)` |
| `screenFlash` | max over live `'charge'` entities of `clamp(1 - dist(e, localKart) / CHARGE_FLASH_RADIUS_M, 0, 1) * clamp(e.ttl / CHARGE_TTL_TICKS, 0, 1)`; 0 when `localPlayerId < 0` |
| `screenTintColor` | `SURGE_TINT` |
| `screenTintAmount` | `surgeAffects(view, view.localPlayerId) ? SURGE_TINT_AMOUNT : 0`; 0 when `localPlayerId < 0` |
| `entities[j].position` | `kind === 'bubble'` → `bubblePosition(ownerKartDraw.position, e.heading, out)`; otherwise copied from `e.position` |
| `entities[j].scale` | `ENTITY_SCALE[e.kind]` |
| `entities[j].visible` | `j < entityCount && e.kind !== 'surge'` |
| `entities[j].alpha` | `clamp(e.ttl / 30, 0, 1)` for `'slick'` and `'charge'`; 1 otherwise |
| `sourceTick` | `view.tick`, written last |

**Three rows that justify themselves** (§4.7, condensed):

- **`heading` is copied, never modified, and there is no `spinAngle`.** `sim`
  already spins a spun-out kart — `updateRecovery` writes `k.heading =
  wrapAngle(k.heading + SPIN_YAW_RATE * TICK_DT)` every tick
  (`packages/sim/src/recovery.ts:98-99`) and `heading` is on the wire. A
  render-side spin would double it. The only thing `render` adds to a spin-out
  is `KART_SPINOUT_ROLL_RADIANS` of tilt.
- **`surge` is never drawn (Q27).** `visible: false`, always. It reaches the
  player only as `screenTintAmount`.
- **Item boxes ghost rather than vanish (Q29).** `itemBoxAlpha` is a
  `Float32Array`, not a boolean array: a box that vanishes tells the player
  nothing, a box fading back in tells them exactly when it is worth driving over.

**The one field the contract does not state, decided here.** `EntityDraw.tint`
appears in the struct and in §9.2's *not covered by the golden frame* column, but
in no derived row. It is filled from data already in scope rather than from a
twelfth constant (the §11 census fixes `render/frame` at 18 exports, which the
eleven constants plus three structs plus four functions exactly consume):
**`tint` is the owner's character accent colour**, `characters[view.karts[e.ownerId].characterIdx].palette.accent`,
so a projectile carries the identity of whoever fired it — which is the only
information about an entity a player cannot get from its shape. When `ownerId` is
not a seat (no live entity has this, but the frame path must be total) it falls
back to `theme.edgeMarkers.colors[0]`, the one pair of colours a theme is
required to keep legible against its own ground.

**Not this task: the golden `RenderFrame` fixture.** Ruling Q33 places it in the
plan's **final** task, deliberately, so it freezes the visual constants *after*
they are tuned by eye. When it lands it will cover `buildRenderFrame`'s derived
geometry — `KartDraw`'s `playerId, visible, position, heading, roll, wheelSpin,
steerAngle, alpha, driftSparkTier, boostFlame, shieldVisible`, `EntityDraw`'s
`entityId, kind, visible, position, heading, scale`, the camera pose and
`itemBoxAlpha` — and **not** palettes, tints or `screenFlash`. Do not create it
here.

---

- [ ] **Step 1: Write the failing test**

Create `packages/render/test/frame-build.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { CharacterDescriptor, KartDescriptor } from '@tapkart/content'
import type { EntityKind, ItemKind, Surface } from '@tapkart/sim'
import { CHARGE_TTL_TICKS, ITEM_BOOST_TICKS, MAX_KARTS, TICK_DT, wrapAngle } from '@tapkart/sim'
import type { EntityView, KartView, RaceView, ViewSource } from '../src/types'
import { createRaceView } from '../src/types'
import { createCameraState } from '../src/camera'
import type { RenderFrame } from '../src/frame'
import {
  BUBBLE_ORBIT_RADIUS_M,
  CHARGE_FLASH_RADIUS_M,
  ENTITY_SCALE,
  INVULN_FLICKER_ALPHA,
  INVULN_FLICKER_PERIOD_TICKS,
  KART_DRIFT_LEAN_RADIANS,
  KART_SPINOUT_ROLL_RADIANS,
  KART_STEER_VISUAL_MAX_RADIANS,
  KART_STEER_VISUAL_YAW_RATE,
  SURGE_TINT,
  SURGE_TINT_AMOUNT,
  buildRenderFrame,
  createRenderFrame,
} from '../src/frame'
import {
  makeCharacterDescriptorFixture,
  makeKartDescriptorFixture,
  makeThemeFixture,
} from './fixtures/render-fixtures'

const BOX_COUNT = 4
const RESPAWN_TICKS = 180

/**
 * Eight kart descriptors with a DISTINCT wheelRadius and body colour per index.
 * Distinctness is the whole point: a builder that indexes `karts` by seat
 * instead of by characterIdx produces a frame whose lengths, counts and types
 * are all correct, and only a per-index difference exposes it.
 */
function makeKartDescriptors(): KartDescriptor[] {
  const base = makeKartDescriptorFixture()
  const out: KartDescriptor[] = []
  for (let i = 0; i < 8; i++) {
    out.push({
      ...base,
      id: `kart-${i}`,
      wheelRadius: 0.2 + i * 0.02,
      palette: { body: [i / 8, 0.1, 0.2], trim: base.palette.trim, wheel: base.palette.wheel },
    })
  }
  return out
}

function makeCharacterDescriptors(): CharacterDescriptor[] {
  const base = makeCharacterDescriptorFixture()
  const out: CharacterDescriptor[] = []
  for (let i = 0; i < 8; i++) {
    out.push({
      ...base,
      id: `char-${i}`,
      palette: { primary: base.palette.primary, secondary: base.palette.secondary,
                 accent: [0.05 * i, 0.5, 0.9] },
    })
  }
  return out
}

const KARTS = makeKartDescriptors()
const CHARACTERS = makeCharacterDescriptors()
const THEME = makeThemeFixture()

/**
 * Fills a KartView completely. Every field is set explicitly, because the
 * derived table is a function of nearly all of them and a test must not inherit
 * defaults it does not control.
 */
function setKart(k: KartView, o: Partial<KartView> & { playerId: number }): void {
  k.playerId = o.playerId
  k.characterIdx = o.characterIdx ?? 0
  k.source = o.source ?? ('authoritative' as ViewSource)
  k.position.x = o.position?.x ?? 0
  k.position.y = o.position?.y ?? 0
  k.position.z = o.position?.z ?? 0
  k.heading = o.heading ?? 0
  k.velocity.x = o.velocity?.x ?? 0
  k.velocity.y = o.velocity?.y ?? 0
  k.velocity.z = o.velocity?.z ?? 0
  k.angularVelocity = o.angularVelocity ?? 0
  k.speed = o.speed ?? 0
  k.s = o.s ?? 0
  k.bankAngle = o.bankAngle ?? 0
  k.driftActive = o.driftActive ?? false
  k.driftDir = o.driftDir ?? 0
  k.driftCharge = o.driftCharge ?? 0
  k.driftTier = o.driftTier ?? -1
  k.airborne = o.airborne ?? false
  k.surface = o.surface ?? ('tarmac' as Surface)
  k.spinOutTicks = o.spinOutTicks ?? 0
  k.invulnTicks = o.invulnTicks ?? 0
  k.boostTicks = o.boostTicks ?? 0
  k.respawnTicks = o.respawnTicks ?? 0
  k.shielded = o.shielded ?? false
  k.item = o.item ?? ('none' as ItemKind)
  k.lap = o.lap ?? 0
  k.checkpointIdx = o.checkpointIdx ?? 0
  k.t = o.t ?? 0
  k.place = o.place ?? o.playerId
  k.isBot = o.isBot ?? false
  k.connected = o.connected ?? true
}

function setEntity(e: EntityView, o: Partial<EntityView> & { entityId: number; kind: EntityKind }): void {
  e.entityId = o.entityId
  e.kind = o.kind
  e.ownerId = o.ownerId ?? -1
  e.source = o.source ?? ('authoritative' as ViewSource)
  e.position.x = o.position?.x ?? 0
  e.position.y = o.position?.y ?? 0
  e.position.z = o.position?.z ?? 0
  e.velocity.x = 0
  e.velocity.y = 0
  e.velocity.z = 0
  e.heading = o.heading ?? 0
  e.ttl = o.ttl ?? 600
}

/** A view with eight seats filled, place === seat, no entities, no local seat. */
function baseView(): RaceView {
  const view = createRaceView(BOX_COUNT)
  view.tick = 100
  view.alpha = 0
  view.phase = 'racing'
  view.localPlayerId = 0
  view.raceStartTick = 0
  view.entityCount = 0
  view.itemBoxRespawnTicks = RESPAWN_TICKS
  view.finishTick = -1
  view.countdownTicksLeft = 0
  for (let i = 0; i < MAX_KARTS; i++) setKart(view.karts[i], { playerId: i, characterIdx: i })
  for (let b = 0; b < BOX_COUNT; b++) {
    view.itemBoxes[b].boxIdx = b
    view.itemBoxes[b].respawnTicks = 0
  }
  return view
}

function build(view: RaceView, out: RenderFrame): void {
  buildRenderFrame(view, createCameraState(), THEME, CHARACTERS, KARTS, out)
}

describe('buildRenderFrame - karts', () => {
  it('copies identity, visibility and the simple per-kart fields', () => {
    const view = baseView()
    setKart(view.karts[3], {
      playerId: 3,
      characterIdx: 6,
      position: { x: 12, y: 1.5, z: -4 },
      heading: 0.75,
      shielded: true,
      driftTier: 2,
      source: 'interpolated',
    })
    setKart(view.karts[4], { playerId: 4, characterIdx: 1, source: 'absent' })
    const out = createRenderFrame(BOX_COUNT)
    build(view, out)

    const d = out.karts[3]
    expect(d.playerId).toBe(3)
    expect(d.characterIdx).toBe(6)
    expect(d.visible).toBe(true)
    expect(d.position).toEqual({ x: 12, y: 1.5, z: -4 })
    expect(d.heading).toBe(0.75)
    expect(d.shieldVisible).toBe(true)
    expect(d.driftSparkTier).toBe(2)
    expect(out.karts[4].visible).toBe(false)
  })

  // Catches indexing the descriptor arrays by SEAT instead of by characterIdx -
  // the classic version of this bug looks right for the whole grid whenever
  // seat === characterIdx, which is exactly how a solo race is set up.
  it('takes bodyTint from karts[characterIdx], by reference', () => {
    const view = baseView()
    setKart(view.karts[2], { playerId: 2, characterIdx: 5 })
    const out = createRenderFrame(BOX_COUNT)
    build(view, out)
    expect(out.karts[2].bodyTint).toBe(KARTS[5].palette.body)
    expect(out.karts[2].bodyTint).not.toBe(KARTS[2].palette.body)
  })

  it('rolls by bank plus drift lean times driftDir plus spin-out tilt', () => {
    const view = baseView()
    setKart(view.karts[0], { playerId: 0, bankAngle: 0.1, driftActive: true, driftDir: -1 })
    setKart(view.karts[1], { playerId: 1, bankAngle: 0.1, driftActive: true, driftDir: 1 })
    setKart(view.karts[2], { playerId: 2, bankAngle: 0.1, spinOutTicks: 30 })
    setKart(view.karts[3], { playerId: 3, bankAngle: 0.1 })
    const out = createRenderFrame(BOX_COUNT)
    build(view, out)
    expect(out.karts[0].roll).toBeCloseTo(0.1 - KART_DRIFT_LEAN_RADIANS, 12)
    expect(out.karts[1].roll).toBeCloseTo(0.1 + KART_DRIFT_LEAN_RADIANS, 12)
    expect(out.karts[2].roll).toBeCloseTo(0.1 + KART_SPINOUT_ROLL_RADIANS, 12)
    expect(out.karts[3].roll).toBeCloseTo(0.1, 12)
  })

  // The no-double-spin assertion (§8.1). sim already yaws a spun-out kart at
  // SPIN_YAW_RATE and puts heading on the wire; a render-side spin angle would
  // double it, which is Q28's mistake made on a different object.
  it('copies a spun-out kart’s heading unmodified', () => {
    const view = baseView()
    setKart(view.karts[0], { playerId: 0, heading: -2.5, spinOutTicks: 45 })
    const out = createRenderFrame(BOX_COUNT)
    build(view, out)
    expect(out.karts[0].heading).toBe(-2.5)
    expect(out.karts[0].roll).toBeCloseTo(KART_SPINOUT_ROLL_RADIANS, 12)
  })

  it('maps angularVelocity to steerAngle, saturating at full lock', () => {
    const view = baseView()
    setKart(view.karts[0], { playerId: 0, angularVelocity: KART_STEER_VISUAL_YAW_RATE / 2 })
    setKart(view.karts[1], { playerId: 1, angularVelocity: KART_STEER_VISUAL_YAW_RATE * 4 })
    setKart(view.karts[2], { playerId: 2, angularVelocity: -KART_STEER_VISUAL_YAW_RATE * 4 })
    const out = createRenderFrame(BOX_COUNT)
    build(view, out)
    expect(out.karts[0].steerAngle).toBeCloseTo(KART_STEER_VISUAL_MAX_RADIANS / 2, 12)
    expect(out.karts[1].steerAngle).toBeCloseTo(KART_STEER_VISUAL_MAX_RADIANS, 12)
    expect(out.karts[2].steerAngle).toBeCloseTo(-KART_STEER_VISUAL_MAX_RADIANS, 12)
  })

  it('flickers alpha on the stated period while invulnerable', () => {
    const view = baseView()
    setKart(view.karts[0], { playerId: 0, invulnTicks: 40 })
    setKart(view.karts[1], { playerId: 1 })
    const half = INVULN_FLICKER_PERIOD_TICKS / 2
    const seen: number[] = []
    for (let t = 0; t < INVULN_FLICKER_PERIOD_TICKS; t++) {
      const out = createRenderFrame(BOX_COUNT)
      view.tick = t
      build(view, out)
      seen.push(out.karts[0].alpha)
      expect(out.karts[1].alpha).toBe(1)
      expect(out.karts[0].alpha).toBe(t % INVULN_FLICKER_PERIOD_TICKS >= half ? INVULN_FLICKER_ALPHA : 1)
    }
    // Non-vacuity: the kart must actually blink, not sit at one value.
    expect(new Set(seen).size).toBe(2)
  })

  it('ramps boostFlame to 1 at ITEM_BOOST_TICKS and clamps above it', () => {
    const view = baseView()
    setKart(view.karts[0], { playerId: 0, boostTicks: 0 })
    setKart(view.karts[1], { playerId: 1, boostTicks: ITEM_BOOST_TICKS / 2 })
    setKart(view.karts[2], { playerId: 2, boostTicks: ITEM_BOOST_TICKS * 3 })
    const out = createRenderFrame(BOX_COUNT)
    build(view, out)
    expect(out.karts[0].boostFlame).toBe(0)
    expect(out.karts[1].boostFlame).toBeCloseTo(0.5, 12)
    expect(out.karts[2].boostFlame).toBe(1)
  })
})

describe('buildRenderFrame - wheelSpin accumulator', () => {
  // The frame-rate independence assertion. A builder that accumulates per CALL
  // rather than per elapsed SIM TICK spins the wheels twice as fast on a 120 Hz
  // display as on a 60 Hz one - invisible to any single-call test.
  it('advances by elapsed sim ticks, not by calls', () => {
    const view = baseView()
    setKart(view.karts[0], { playerId: 0, characterIdx: 3, speed: 20 })
    const out = createRenderFrame(BOX_COUNT)
    view.tick = 0
    build(view, out)
    expect(out.karts[0].wheelSpin).toBe(0)
    expect(out.sourceTick).toBe(0)

    // Two frames at the same tick: the second must add nothing.
    view.tick = 2
    build(view, out)
    const after2 = out.karts[0].wheelSpin
    build(view, out)
    expect(out.karts[0].wheelSpin).toBe(after2)

    const perTick = (20 / KARTS[3].wheelRadius) * TICK_DT
    expect(after2).toBeCloseTo(wrapAngle(perTick * 2), 12)

    view.tick = 5
    build(view, out)
    expect(out.karts[0].wheelSpin).toBeCloseTo(wrapAngle(after2 + perTick * 3), 12)
  })

  it('wraps rather than growing without bound', () => {
    const view = baseView()
    setKart(view.karts[0], { playerId: 0, characterIdx: 0, speed: 40 })
    const out = createRenderFrame(BOX_COUNT)
    for (let t = 1; t <= 600; t++) {
      view.tick = t
      build(view, out)
      expect(Math.abs(out.karts[0].wheelSpin)).toBeLessThanOrEqual(Math.PI + 1e-9)
    }
    // Non-vacuity: a wheel that never turned would also stay inside the bound.
    expect(out.karts[0].wheelSpin).not.toBe(0)
  })

  it('never rewinds when the view tick goes backwards', () => {
    const view = baseView()
    setKart(view.karts[0], { playerId: 0, speed: 10 })
    const out = createRenderFrame(BOX_COUNT)
    view.tick = 50
    build(view, out)
    const spin = out.karts[0].wheelSpin
    view.tick = 10
    build(view, out)
    expect(out.karts[0].wheelSpin).toBe(spin)
    expect(out.sourceTick).toBe(10)
  })
})

describe('buildRenderFrame - item boxes (Q29)', () => {
  // Catches the boolean-visibility implementation the ruling replaced: a box
  // that vanishes tells the player nothing.
  it('ghosts a respawning box in proportion to its timer', () => {
    const view = baseView()
    view.itemBoxes[0].respawnTicks = 0
    view.itemBoxes[1].respawnTicks = RESPAWN_TICKS / 2
    view.itemBoxes[2].respawnTicks = RESPAWN_TICKS
    view.itemBoxes[3].respawnTicks = RESPAWN_TICKS * 2
    const out = createRenderFrame(BOX_COUNT)
    build(view, out)
    expect(out.itemBoxAlpha[0]).toBeCloseTo(1, 6)
    expect(out.itemBoxAlpha[1]).toBeCloseTo(0.5, 6)
    expect(out.itemBoxAlpha[2]).toBeCloseTo(0, 6)
    expect(out.itemBoxAlpha[3]).toBeCloseTo(0, 6)
  })

  it('is total when the denominator is zero', () => {
    const view = baseView()
    view.itemBoxRespawnTicks = 0
    view.itemBoxes[0].respawnTicks = 0
    const out = createRenderFrame(BOX_COUNT)
    build(view, out)
    expect(Number.isNaN(out.itemBoxAlpha[0])).toBe(false)
  })
})

describe('buildRenderFrame - entities', () => {
  it('copies a plain entity and scales it by kind', () => {
    const view = baseView()
    setEntity(view.entities[0], {
      entityId: 11, kind: 'seeker', ownerId: 2, heading: 1.2,
      position: { x: 5, y: 0.5, z: 6 },
    })
    view.entityCount = 1
    const out = createRenderFrame(BOX_COUNT)
    build(view, out)
    expect(out.entityCount).toBe(1)
    expect(out.entities[0].entityId).toBe(11)
    expect(out.entities[0].visible).toBe(true)
    expect(out.entities[0].position).toEqual({ x: 5, y: 0.5, z: 6 })
    expect(out.entities[0].heading).toBe(1.2)
    expect(out.entities[0].scale).toBe(ENTITY_SCALE.seeker)
    expect(out.entities[0].alpha).toBe(1)
  })

  // Q28's defect, made visible. The sampled position is deliberately WRONG -
  // it sits on the owner, which is what linear interpolation across the orbit
  // produces at its worst - and the frame must ignore it and rebuild from the
  // owner's drawn position plus the interpolated heading.
  it('reconstructs a bubble from its owner and heading, not from the sample', () => {
    const view = baseView()
    setKart(view.karts[4], { playerId: 4, characterIdx: 4, position: { x: 30, y: 2, z: -7 } })
    setEntity(view.entities[0], {
      entityId: 21, kind: 'bubble', ownerId: 4, heading: Math.PI / 2,
      position: { x: 30, y: 2, z: -7 },
    })
    view.entityCount = 1
    const out = createRenderFrame(BOX_COUNT)
    build(view, out)
    const d = out.entities[0]
    expect(d.position.x).toBeCloseTo(30, 9)
    expect(d.position.y).toBeCloseTo(2, 9)
    expect(d.position.z).toBeCloseTo(-7 + BUBBLE_ORBIT_RADIUS_M, 9)
    expect(Math.hypot(d.position.x - 30, d.position.z + 7)).toBeCloseTo(BUBBLE_ORBIT_RADIUS_M, 9)
  })

  it('hugs the DRAWN owner, so the shield follows the kart the player sees', () => {
    const view = baseView()
    setKart(view.karts[4], { playerId: 4, position: { x: -50, y: 0, z: 12 } })
    setEntity(view.entities[0], {
      entityId: 22, kind: 'bubble', ownerId: 4, heading: 0,
      position: { x: 999, y: 999, z: 999 },
    })
    view.entityCount = 1
    const out = createRenderFrame(BOX_COUNT)
    build(view, out)
    expect(out.entities[0].position.x).toBeCloseTo(-50 + BUBBLE_ORBIT_RADIUS_M, 9)
    expect(out.entities[0].position.y).toBeCloseTo(0, 9)
    expect(out.entities[0].position.z).toBeCloseTo(12, 9)
  })

  // Q27. Drawing a mesh at a meaningless position is worse than drawing
  // nothing, because players will try to dodge it.
  it('never makes a surge visible, however live it is', () => {
    const view = baseView()
    setEntity(view.entities[0], { entityId: 31, kind: 'surge', ownerId: 7, ttl: 300 })
    setEntity(view.entities[1], { entityId: 32, kind: 'bolt', ownerId: 7, ttl: 300 })
    view.entityCount = 2
    const out = createRenderFrame(BOX_COUNT)
    build(view, out)
    expect(out.entities[0].visible).toBe(false)
    expect(out.entities[1].visible).toBe(true)
  })

  // Catches drawing the whole pool: slots at or past entityCount hold whatever
  // the last entity left there.
  it('marks slots at or past entityCount invisible', () => {
    const view = baseView()
    setEntity(view.entities[0], { entityId: 41, kind: 'bolt', ownerId: 1 })
    setEntity(view.entities[1], { entityId: -1, kind: 'bolt', ownerId: 1 })
    view.entityCount = 1
    const out = createRenderFrame(BOX_COUNT)
    build(view, out)
    expect(out.entities[0].visible).toBe(true)
    expect(out.entities[1].visible).toBe(false)
    expect(out.entities[31].visible).toBe(false)
  })

  it('fades slick and charge by ttl, and nothing else', () => {
    const view = baseView()
    setEntity(view.entities[0], { entityId: 51, kind: 'slick', ownerId: 1, ttl: 15 })
    setEntity(view.entities[1], { entityId: 52, kind: 'charge', ownerId: 1, ttl: 60 })
    setEntity(view.entities[2], { entityId: 53, kind: 'bolt', ownerId: 1, ttl: 3 })
    view.entityCount = 3
    const out = createRenderFrame(BOX_COUNT)
    build(view, out)
    expect(out.entities[0].alpha).toBeCloseTo(0.5, 12)
    expect(out.entities[1].alpha).toBe(1)
    expect(out.entities[2].alpha).toBe(1)
  })

  it('tints an entity with its owner’s character accent', () => {
    const view = baseView()
    setKart(view.karts[6], { playerId: 6, characterIdx: 2 })
    setEntity(view.entities[0], { entityId: 61, kind: 'bolt', ownerId: 6 })
    setEntity(view.entities[1], { entityId: 62, kind: 'slick', ownerId: -1 })
    view.entityCount = 2
    const out = createRenderFrame(BOX_COUNT)
    build(view, out)
    expect(out.entities[0].tint).toBe(CHARACTERS[2].palette.accent)
    expect(out.entities[1].tint).toBe(THEME.edgeMarkers.colors[0])
  })
})

describe('buildRenderFrame - screen effects', () => {
  it('flashes hardest at the charge and not at all at its radius', () => {
    const view = baseView()
    setKart(view.karts[0], { playerId: 0, position: { x: 0, y: 0, z: 0 } })
    setEntity(view.entities[0], {
      entityId: 71, kind: 'charge', ownerId: 3, ttl: CHARGE_TTL_TICKS,
      position: { x: 0, y: 0, z: 0 },
    })
    view.entityCount = 1
    const out = createRenderFrame(BOX_COUNT)
    build(view, out)
    expect(out.screenFlash).toBeCloseTo(1, 12)

    view.entities[0].position.x = CHARGE_FLASH_RADIUS_M
    build(view, out)
    expect(out.screenFlash).toBeCloseTo(0, 12)

    view.entities[0].position.x = CHARGE_FLASH_RADIUS_M / 2
    view.entities[0].ttl = CHARGE_TTL_TICKS / 2
    build(view, out)
    expect(out.screenFlash).toBeCloseTo(0.25, 12)
  })

  it('takes the maximum over live charges and ignores dead slots', () => {
    const view = baseView()
    setKart(view.karts[0], { playerId: 0, position: { x: 0, y: 0, z: 0 } })
    setEntity(view.entities[0], {
      entityId: 81, kind: 'charge', ownerId: 3, ttl: CHARGE_TTL_TICKS,
      position: { x: CHARGE_FLASH_RADIUS_M * 0.75, y: 0, z: 0 },
    })
    setEntity(view.entities[1], {
      entityId: 82, kind: 'charge', ownerId: 3, ttl: CHARGE_TTL_TICKS,
      position: { x: CHARGE_FLASH_RADIUS_M * 0.25, y: 0, z: 0 },
    })
    view.entityCount = 2
    const out = createRenderFrame(BOX_COUNT)
    build(view, out)
    expect(out.screenFlash).toBeCloseTo(0.75, 12)

    view.entityCount = 1
    build(view, out)
    expect(out.screenFlash).toBeCloseTo(0.25, 12)
  })

  it('is silent for a spectator with no local seat', () => {
    const view = baseView()
    view.localPlayerId = -1
    setEntity(view.entities[0], {
      entityId: 91, kind: 'charge', ownerId: 3, ttl: CHARGE_TTL_TICKS,
      position: { x: 0, y: 0, z: 0 },
    })
    setEntity(view.entities[1], { entityId: 92, kind: 'surge', ownerId: 7, ttl: 300 })
    view.entityCount = 2
    const out = createRenderFrame(BOX_COUNT)
    build(view, out)
    expect(out.screenFlash).toBe(0)
    expect(out.screenTintAmount).toBe(0)
  })

  it('tints the screen only while a surge from behind is slowing the local kart', () => {
    const view = baseView()
    view.localPlayerId = 1 // place 1
    setEntity(view.entities[0], { entityId: 93, kind: 'surge', ownerId: 5, ttl: 300 })
    view.entityCount = 1
    const out = createRenderFrame(BOX_COUNT)
    build(view, out)
    expect(out.screenTintColor).toBe(SURGE_TINT)
    expect(out.screenTintAmount).toBe(SURGE_TINT_AMOUNT)

    // Cast by a kart AHEAD of the local seat: no tint. Without this half, an
    // implementation that tints on any live surge passes the assertion above.
    view.entities[0].ownerId = 0
    build(view, out)
    expect(out.screenTintAmount).toBe(0)
  })
})

describe('buildRenderFrame - camera, sourceTick and allocation', () => {
  it('copies the camera pose by value, not by reference', () => {
    const view = baseView()
    const cam = createCameraState()
    cam.position.x = 3
    cam.position.y = 4
    cam.position.z = 5
    cam.lookAt.x = 1
    cam.fovDegrees = 71
    cam.mode = 'countdown'
    const out = createRenderFrame(BOX_COUNT)
    buildRenderFrame(view, cam, THEME, CHARACTERS, KARTS, out)
    expect(out.camera.position).toEqual({ x: 3, y: 4, z: 5 })
    expect(out.camera.lookAt.x).toBe(1)
    expect(out.camera.fovDegrees).toBe(71)
    expect(out.camera.mode).toBe('countdown')
    expect(out.camera).not.toBe(cam)
    expect(out.camera.position).not.toBe(cam.position)
    // A later updateCamera must not reach into a frame already handed to the
    // backend.
    cam.position.x = 999
    expect(out.camera.position.x).toBe(3)
  })

  it('writes sourceTick from the view', () => {
    const view = baseView()
    view.tick = 4242
    const out = createRenderFrame(BOX_COUNT)
    build(view, out)
    expect(out.sourceTick).toBe(4242)
  })

  // Scratch discipline (§7.3): the adapter may cache these objects between
  // frames, so the builder must write through them, never replace them.
  it('reuses every out object instead of allocating', () => {
    const view = baseView()
    const out = createRenderFrame(BOX_COUNT)
    const kartPos = out.karts[0].position
    const entPos = out.entities[0].position
    const camPos = out.camera.position
    const boxes = out.itemBoxAlpha
    const karts = out.karts
    setEntity(view.entities[0], { entityId: 1, kind: 'bolt', ownerId: 0 })
    view.entityCount = 1
    build(view, out)
    build(view, out)
    expect(out.karts[0].position).toBe(kartPos)
    expect(out.entities[0].position).toBe(entPos)
    expect(out.camera.position).toBe(camPos)
    expect(out.itemBoxAlpha).toBe(boxes)
    expect(out.karts).toBe(karts)
  })

  it('is deterministic: the same inputs and accumulator give the same frame', () => {
    const view = baseView()
    setKart(view.karts[0], { playerId: 0, speed: 17, angularVelocity: 0.9, boostTicks: 30 })
    setEntity(view.entities[0], { entityId: 5, kind: 'bubble', ownerId: 0, heading: 1.1 })
    view.entityCount = 1
    const a = createRenderFrame(BOX_COUNT)
    const b = createRenderFrame(BOX_COUNT)
    build(view, a)
    build(view, b)
    expect(JSON.stringify(a.karts)).toBe(JSON.stringify(b.karts))
    expect(JSON.stringify(a.entities)).toBe(JSON.stringify(b.entities))
    expect(Array.from(a.itemBoxAlpha)).toEqual(Array.from(b.itemBoxAlpha))
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/render/test/frame-build.test.ts`

Expected: FAIL — `frame.ts` exists (Task 11) but exports no `buildRenderFrame`:

```
SyntaxError: The requested module '/home/kasm-user/tapkart/packages/render/src/frame.ts' does not provide an export named 'buildRenderFrame'
```

- [ ] **Step 3: Write the implementation**

Widen the import block at the top of `packages/render/src/frame.ts` — it becomes:

```ts
// PURE (contract §0a): no DOM, no GPU, no clock, no `three` import, and nothing
// in the frame path allocates.
import type { EntityKind, Vec3 } from '@tapkart/sim'
import {
  CHARGE_TTL_TICKS,
  ITEM_BOOST_TICKS,
  MAX_ENTITIES,
  MAX_KARTS,
  TICK_DT,
  clamp,
  v3,
  wrapAngle,
} from '@tapkart/sim'
import type { CharacterDescriptor, KartDescriptor, PaletteRGB, TrackTheme } from '@tapkart/content'
import type { CameraState } from './camera'
import { createCameraState } from './camera'
import type { RaceView } from './types'
```

Then append to the same file:

```ts
/** ttl in ticks over which a dropped hazard fades out. Contract §4.7 states
 *  this row as `clamp(e.ttl / 30, 0, 1)`; the divisor is written once here. */
const HAZARD_FADE_TICKS = 30

/**
 * THE pure function of this package. (RaceView, CameraState, TrackTheme,
 * descriptors) -> RenderFrame. No clock, no DOM, no allocation, no randomness.
 * SOLE WRITER of every RenderFrame field.
 *
 * It reads exactly two things out of `out`: `out.sourceTick` and
 * `out.karts[i].wheelSpin`. Every other field of `out` is write-only. That is
 * what makes wheel rotation frame-rate independent while keeping the function a
 * deterministic function of (inputs, prior accumulator).
 *
 * `characters` and `karts` are both length 8, indexed by characterIdx (§4.4).
 * Karts are filled BEFORE entities, because a bubble is reconstructed from its
 * owner's already-resolved KartDraw.position (Q28).
 */
export function buildRenderFrame(
  view: RaceView,
  cam: CameraState,
  theme: TrackTheme,
  characters: readonly CharacterDescriptor[],
  karts: readonly KartDescriptor[],
  out: RenderFrame,
): void {
  // --- camera, copied by value: updateCamera keeps mutating `cam` after this
  // frame has been handed to the backend.
  out.camera.position.x = cam.position.x
  out.camera.position.y = cam.position.y
  out.camera.position.z = cam.position.z
  out.camera.lookAt.x = cam.lookAt.x
  out.camera.lookAt.y = cam.lookAt.y
  out.camera.lookAt.z = cam.lookAt.z
  out.camera.up.x = cam.up.x
  out.camera.up.y = cam.up.y
  out.camera.up.z = cam.up.z
  out.camera.fovDegrees = cam.fovDegrees
  out.camera.mode = cam.mode

  // Sim ticks elapsed since this frame's accumulators were last advanced. Never
  // negative: a view that goes backwards (a reset, a rejoin) holds the wheels.
  const dt = Math.max(0, view.tick - out.sourceTick)
  const flickerOn =
    view.tick % INVULN_FLICKER_PERIOD_TICKS >= INVULN_FLICKER_PERIOD_TICKS / 2

  // --- karts, by seat
  const kartDescCount = karts.length
  const charDescCount = characters.length
  for (let i = 0; i < MAX_KARTS; i++) {
    const k = view.karts[i]
    const d = out.karts[i]
    // The frame path must be total: a descriptor index is clamped rather than
    // trusted, so a malformed session cannot throw inside the render loop.
    const kd = karts[clamp(Math.trunc(k.characterIdx), 0, kartDescCount - 1)]

    d.playerId = k.playerId
    d.characterIdx = k.characterIdx
    d.visible = k.source !== 'absent'
    d.position.x = k.position.x
    d.position.y = k.position.y
    d.position.z = k.position.z
    d.heading = k.heading
    d.roll =
      k.bankAngle +
      (k.driftActive ? KART_DRIFT_LEAN_RADIANS * k.driftDir : 0) +
      (k.spinOutTicks > 0 ? KART_SPINOUT_ROLL_RADIANS : 0)
    d.wheelSpin = wrapAngle(d.wheelSpin + (k.speed / kd.wheelRadius) * TICK_DT * dt)
    d.steerAngle =
      clamp(k.angularVelocity / KART_STEER_VISUAL_YAW_RATE, -1, 1) *
      KART_STEER_VISUAL_MAX_RADIANS
    d.bodyTint = kd.palette.body
    d.alpha = k.invulnTicks > 0 && flickerOn ? INVULN_FLICKER_ALPHA : 1
    d.driftSparkTier = k.driftTier
    d.boostFlame = clamp(k.boostTicks / ITEM_BOOST_TICKS, 0, 1)
    d.shieldVisible = k.shielded
  }

  // --- entities, after karts
  for (let j = 0; j < MAX_ENTITIES; j++) {
    const e = view.entities[j]
    const d = out.entities[j]
    const live = j < view.entityCount
    const ownerSeat = e.ownerId >= 0 && e.ownerId < MAX_KARTS ? e.ownerId : -1

    d.entityId = e.entityId
    d.kind = e.kind
    d.visible = live && e.kind !== 'surge'
    if (live && e.kind === 'bubble' && ownerSeat >= 0) {
      // Q28: rebuild from the owner's DRAWN position and the interpolated
      // heading. Lerping the sampled positions chords across the orbit.
      bubblePosition(out.karts[ownerSeat].position, e.heading, d.position)
    } else {
      d.position.x = e.position.x
      d.position.y = e.position.y
      d.position.z = e.position.z
    }
    d.heading = e.heading
    d.scale = ENTITY_SCALE[e.kind]
    d.tint =
      ownerSeat >= 0
        ? characters[
            clamp(Math.trunc(view.karts[ownerSeat].characterIdx), 0, charDescCount - 1)
          ].palette.accent
        : theme.edgeMarkers.colors[0]
    d.alpha =
      e.kind === 'slick' || e.kind === 'charge' ? clamp(e.ttl / HAZARD_FADE_TICKS, 0, 1) : 1
  }
  out.entityCount = view.entityCount

  // --- item boxes (Q29): ghosted, never hidden
  const denom = view.itemBoxRespawnTicks
  const boxCount = Math.min(out.itemBoxAlpha.length, view.itemBoxes.length)
  for (let b = 0; b < boxCount; b++) {
    out.itemBoxAlpha[b] =
      denom > 0 ? clamp(1 - view.itemBoxes[b].respawnTicks / denom, 0, 1) : 1
  }

  // --- screen effects
  const pid = view.localPlayerId
  const hasSeat = pid >= 0 && pid < MAX_KARTS
  let flash = 0
  if (hasSeat) {
    const lp = out.karts[pid].position
    for (let j = 0; j < view.entityCount; j++) {
      const e = view.entities[j]
      if (e.kind !== 'charge') continue
      const dx = e.position.x - lp.x
      const dy = e.position.y - lp.y
      const dz = e.position.z - lp.z
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)
      const v =
        clamp(1 - dist / CHARGE_FLASH_RADIUS_M, 0, 1) * clamp(e.ttl / CHARGE_TTL_TICKS, 0, 1)
      if (v > flash) flash = v
    }
  }
  out.screenFlash = flash
  out.screenTintColor = SURGE_TINT
  out.screenTintAmount = hasSeat && surgeAffects(view, pid) ? SURGE_TINT_AMOUNT : 0

  // Last (§4.7): every wheelSpin above consumed the OLD value.
  out.sourceTick = view.tick
}
```

`v3` and `createCameraState` stay used by `createRenderFrame`; nothing else in
the widened import block is unused, which `npm run typecheck` confirms under
`noUnusedLocals`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/render/test/frame-build.test.ts`
Expected: PASS, 27 tests.

Run: `npx vitest run packages/render/test/frame-core.test.ts`
Expected: still PASS, 14 tests — Task 11's file was appended to, not rewritten.

Run: `npm run typecheck --workspace @tapkart/render`
Expected: exit 0, no output.

- [ ] **Step 5: Commit**

```bash
git add packages/render/src/frame.ts packages/render/test/frame-build.test.ts && git commit -m "feat(render): buildRenderFrame, the pure frame description

Every derived field is contract §4.7's expression: wheelSpin accumulates per
elapsed SIM TICK so a 120 Hz display does not double it, a bubble is rebuilt
from its owner's drawn position and interpolated heading rather than lerped
across its orbit (Q28), a surge is never visible and reaches the player only as
screenTintAmount (Q27), and item boxes ghost by respawn fraction instead of
vanishing (Q29)."
```

---

### Task 13: `packages/render/src/hud.ts` — the pure HUD model

Contract §4.8. Rulings Q16 (positions only, no times), Q17 (DNF is derived in
`game`, not here), Q18 (`clamp(lap + 1, 1, RACE_LAPS)`, shown as "LAP n/3"),
Q21 (the throttle indicator reads `motionLocked`, never `accel`).

`hud.ts` produces **numbers and strings**, never DOM. `startShell` (§5.13) calls
`buildHudModel` once per frame and writes the result into the DOM; every branch
the DOM layer would want is a field on `HudModel`, because a conditional in an
adapter is a decision CI cannot see (§0a).

**Files:**
- Create: `packages/render/src/hud.ts`
- Test: `packages/render/test/hud.test.ts`

**Interfaces:**

- Consumes, from `@tapkart/sim` (contract §2.1, §2.2 — quoted verbatim):
  ```ts
  export type ItemKind = 'none' | 'boost' | 'seeker' | 'bolt' | 'slick'
    | 'bubble' | 'surge' | 'blink' | 'charge'
  export type RacePhase = 'countdown' | 'racing' | 'finished'
  export const TICK_DT = 1 / 60
  export const MAX_KARTS = 8
  export const RACE_LAPS = 3
  export const COUNTDOWN_TICKS = 180
  export function clamp(v: number, lo: number, hi: number): number
  // used by this task's test only:
  export function createState(ctx: SimContext, seed: number, characterIdx: number[]): SimState
  export function motionLocked(k: KartState): boolean      // === (k.respawnTicks > 0)
  ```
- Consumes, from `packages/render/src/types.ts` (contract §4.2, an earlier task) —
  the fields this module reads: `RaceView.{tick, phase, localPlayerId,
  raceStartTick, karts, countdownTicksLeft}` and `KartView.{playerId, speed,
  driftTier, item, lap, place, respawnTicks, spinOutTicks, isBot, connected}`,
  plus:
  ```ts
  export function createRaceView(itemBoxCount: number): RaceView
  ```
- Consumes, from `packages/render/test/fixtures/render-fixtures.ts` (§9.1):
  ```ts
  export function makeRenderContext(): SimContext
  ```
- Produces — imported by `src/audio.ts` (Task 14, for `countdownLabelFor`), by
  `src/index.ts`, and by `startShell`:
  ```ts
  export type CountdownLabel = '' | '3' | '2' | '1' | 'GO'
  export interface HudStanding { playerId: number; place: number; lap: number
    isBot: boolean; connected: boolean }
  export interface HudModel { visible: boolean; place: number; fieldSize: number
    lap: number; totalLaps: number; speedKph: number; item: ItemKind
    itemReady: boolean; driftTier: number; countdownLabel: CountdownLabel
    raceClock: string; respawning: boolean; spunOut: boolean; motionLocked: boolean
    standings: HudStanding[] }
  export function createHudModel(): HudModel
  export function buildHudModel(view: RaceView, totalLaps: number, out: HudModel): void
  export function formatRaceClock(ticks: number): string
  export function countdownLabelFor(phase: RacePhase, countdownTicksLeft: number,
                                    ticksSinceStart: number): CountdownLabel
  export const GO_LABEL_TICKS = 45
  ```
  `buildHudModel` is the **sole writer** of every `HudModel` field (§7.2).
  Callers pass `RACE_LAPS` as `totalLaps`.

**Field-by-field, from contract §4.8:**

| Field | Value |
|---|---|
| `visible` | `view.localPlayerId >= 0` |
| `place` | 1-BASED: local seat's `place + 1` |
| `fieldSize` | `MAX_KARTS` |
| `lap` | 1-BASED: `clamp(k.lap + 1, 1, totalLaps)` |
| `totalLaps` | the argument |
| `speedKph` | `Math.round(k.speed * 3.6)` |
| `item` | `k.item` |
| `itemReady` | `k.item !== 'none' && !motionLocked` |
| `driftTier` | `k.driftTier`, sim's encoding (`-1` none, `0..2` an index) |
| `countdownLabel` | `countdownLabelFor(view.phase, view.countdownTicksLeft, ticksSinceStart)` |
| `raceClock` | `formatRaceClock(max(0, view.tick - view.raceStartTick))` |
| `respawning` | `k.respawnTicks > 0` |
| `spunOut` | `k.spinOutTicks > 0` |
| `motionLocked` | `=== respawning` — the throttle indicator reads THIS, not `accel` (Q21) |
| `standings` | length `MAX_KARTS`, sorted by `place` ascending |

**Four decisions a reader must not re-litigate**

1. **Q18 — the lap number is `clamp(lap + 1, 1, totalLaps)`.** `KartState.lap.lap`
   starts at 0 and `updateLaps` credits lap 1 on the first crossing, so the raw
   value reads **"LAP 0/3" on the grid**, which is wrong in every racing game
   ever shipped, and "LAP 4/3" on the finish line, which is worse.
2. **Q16 — no times, anywhere but the live clock.** `raceClock` is a live HUD
   element. Client-recorded times are non-authoritative and differ per peer, so a
   results screen built from them shows eight players eight different sets of
   numbers for the same race. §5.12's results carry **positions and DNF, and
   nothing else**.
3. **Q17 — DNF is not this module's.** `isDnf` and `buildResultRows` live in
   `packages/game/src/results.ts`, because DNF is derived from
   `phase === 'finished'`, `finishTick`, `tick` and `FINISH_GRACE_TICKS` — facts
   `game` already has, needing no `sim` change and no wire change. `HudModel` has
   no `dnf` field and this task adds none.
4. **`standings` is sorted by `place`, and the sort is real.** `view.karts` is
   indexed **by seat** (`karts[3].playerId === 3`), which is *not* standings
   order. The sort is an 8-element insertion sort over the array's own object
   references, so it allocates nothing per frame.

**Two things the contract leaves open, decided here** (both flagged rather than
buried):

- **"`''` before the race" has no reachable view state.** §5.11 step 12 sets
  `countdownTicksLeft = phase === 'countdown' ? max(0, COUNTDOWN_TICKS - tick) : 0`
  and the phase is `'countdown'` from tick 0, so there is no pre-countdown
  moment for a view to describe. `''` is therefore returned in the two states
  that do exist: `'finished'`, and `'racing'` once the GO window has passed.
  `countdownTicksLeft` is clamped into `[0, COUNTDOWN_TICKS]` so the function
  stays total for a caller that passes something else.
- **With no local seat** (`localPlayerId < 0`: a spectator or a replay) the
  per-seat fields are written to their neutral values — `place` and `lap` to `1`
  (both are 1-based for display, so `0` would render "0th" and "LAP 0/3"),
  `driftTier` to `-1` (sim's "no tier"), `item` to `'none'`, the rest to
  `0`/`false`. `standings`, `raceClock`, `countdownLabel`, `totalLaps` and
  `fieldSize` are still filled: none of them needs a local seat, and a spectator
  watching the standings is the reason `visible` is a field rather than a caller
  deleting the HUD.

---

- [ ] **Step 1: Write the failing test**

Create `packages/render/test/hud.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  COUNTDOWN_TICKS,
  MAX_KARTS,
  RACE_LAPS,
  TICK_DT,
  createState,
  motionLocked as simMotionLocked,
} from '@tapkart/sim'
import type { RaceView } from '../src/types'
import { createRaceView } from '../src/types'
import type { CountdownLabel } from '../src/hud'
import {
  GO_LABEL_TICKS,
  buildHudModel,
  countdownLabelFor,
  createHudModel,
  formatRaceClock,
} from '../src/hud'
import { makeRenderContext } from './fixtures/render-fixtures'

/** A racing view with eight seats, place === seat, local seat 0. */
function raceView(): RaceView {
  const view = createRaceView(2)
  view.tick = 0
  view.phase = 'racing'
  view.localPlayerId = 0
  view.raceStartTick = 0
  view.countdownTicksLeft = 0
  view.entityCount = 0
  for (let i = 0; i < MAX_KARTS; i++) {
    const k = view.karts[i]
    k.playerId = i
    k.characterIdx = i
    k.source = 'authoritative'
    k.place = i
    k.lap = 0
    k.speed = 0
    k.item = 'none'
    k.driftTier = -1
    k.respawnTicks = 0
    k.spinOutTicks = 0
    k.isBot = i !== 0
    k.connected = true
  }
  return view
}

describe('formatRaceClock', () => {
  it('matches the contract’s two worked examples', () => {
    expect(formatRaceClock(0)).toBe('0:00.000')
    expect(formatRaceClock(3661)).toBe('1:01.017')
  })

  // Catches the two formatting bugs that survive a single-example test: an
  // unpadded seconds field ("1:1.017") and a millisecond field padded to two
  // digits or truncated ("0:00.17").
  it('pads seconds to two digits and milliseconds to three', () => {
    expect(formatRaceClock(60)).toBe('0:01.000')
    expect(formatRaceClock(3600)).toBe('1:00.000')
    expect(formatRaceClock(1)).toBe('0:00.017')
    expect(formatRaceClock(6)).toBe('0:00.100')
    expect(formatRaceClock(3599)).toBe('0:59.983')
  })

  it('is monotonic in ticks and never negative', () => {
    let prev = ''
    for (let t = 0; t < 4000; t += 7) {
      const s = formatRaceClock(t)
      expect(s > prev || t === 0).toBe(true)
      prev = s
    }
    expect(formatRaceClock(-100)).toBe('0:00.000')
  })

  it('derives milliseconds from TICK_DT, not from a hard-coded 16', () => {
    // 100 ticks is 1.6667 s, not 1.600 s. A 16 ms tick would print '0:01.600'.
    expect(formatRaceClock(100)).toBe('0:01.667')
    expect(Math.round(100 * TICK_DT * 1000)).toBe(1667)
  })
})

describe('countdownLabelFor', () => {
  // Walks 3,2,1,GO across COUNTDOWN_TICKS in equal thirds (§8.1). The boundary
  // ticks are asserted individually because an off-by-one here shows "1" for 61
  // ticks and "2" for 59 - which nobody notices by eye and every player feels.
  it('walks 3,2,1 across the countdown in equal thirds', () => {
    const third = COUNTDOWN_TICKS / 3
    expect(countdownLabelFor('countdown', COUNTDOWN_TICKS, 0)).toBe('3')
    expect(countdownLabelFor('countdown', 2 * third + 1, 0)).toBe('3')
    expect(countdownLabelFor('countdown', 2 * third, 0)).toBe('2')
    expect(countdownLabelFor('countdown', third + 1, 0)).toBe('2')
    expect(countdownLabelFor('countdown', third, 0)).toBe('1')
    expect(countdownLabelFor('countdown', 1, 0)).toBe('1')
    expect(countdownLabelFor('countdown', 0, 0)).toBe('GO')
  })

  it('each digit holds for exactly one third of the countdown', () => {
    const seen = new Map<CountdownLabel, number>()
    for (let tick = 0; tick <= COUNTDOWN_TICKS; tick++) {
      const left = Math.max(0, COUNTDOWN_TICKS - tick)
      const label = countdownLabelFor('countdown', left, 0)
      seen.set(label, (seen.get(label) ?? 0) + 1)
    }
    expect(seen.get('3')).toBe(COUNTDOWN_TICKS / 3)
    expect(seen.get('2')).toBe(COUNTDOWN_TICKS / 3)
    expect(seen.get('1')).toBe(COUNTDOWN_TICKS / 3)
    expect(seen.get('GO')).toBe(1)
    expect(seen.get('')).toBeUndefined()
  })

  it('holds GO for GO_LABEL_TICKS into the race, then clears', () => {
    expect(countdownLabelFor('racing', 0, 0)).toBe('GO')
    expect(countdownLabelFor('racing', 0, GO_LABEL_TICKS - 1)).toBe('GO')
    expect(countdownLabelFor('racing', 0, GO_LABEL_TICKS)).toBe('')
    expect(countdownLabelFor('racing', 0, 100000)).toBe('')
    expect(countdownLabelFor('finished', 0, 0)).toBe('')
  })

  it('is total for out-of-range input', () => {
    expect(countdownLabelFor('countdown', COUNTDOWN_TICKS * 10, 0)).toBe('3')
    expect(countdownLabelFor('countdown', -5, 0)).toBe('GO')
  })
})

describe('buildHudModel', () => {
  it('reports place and lap 1-based, and speed in whole kph', () => {
    const view = raceView()
    view.karts[0].place = 2
    view.karts[0].lap = 1
    view.karts[0].speed = 12.5
    const out = createHudModel()
    buildHudModel(view, RACE_LAPS, out)
    expect(out.visible).toBe(true)
    expect(out.place).toBe(3)
    expect(out.lap).toBe(2)
    expect(out.totalLaps).toBe(RACE_LAPS)
    expect(out.fieldSize).toBe(MAX_KARTS)
    expect(out.speedKph).toBe(45)
  })

  // Q18. Both ends of the clamp: "LAP 0/3" on the grid and "LAP 4/3" after the
  // final crossing are the two ways the raw value is wrong.
  it('never shows lap 0 and never shows lap 4 of 3', () => {
    const view = raceView()
    const out = createHudModel()

    view.karts[0].lap = 0
    buildHudModel(view, RACE_LAPS, out)
    expect(out.lap).toBe(1)

    view.karts[0].lap = 2
    buildHudModel(view, RACE_LAPS, out)
    expect(out.lap).toBe(3)

    view.karts[0].lap = RACE_LAPS
    buildHudModel(view, RACE_LAPS, out)
    expect(out.lap).toBe(RACE_LAPS)

    view.karts[0].lap = 99
    buildHudModel(view, RACE_LAPS, out)
    expect(out.lap).toBe(RACE_LAPS)
  })

  it('rounds speedKph rather than truncating', () => {
    const view = raceView()
    const out = createHudModel()
    view.karts[0].speed = 10
    buildHudModel(view, RACE_LAPS, out)
    expect(out.speedKph).toBe(36)
    view.karts[0].speed = 9.99
    buildHudModel(view, RACE_LAPS, out)
    expect(out.speedKph).toBe(36) // 35.964 rounds up; truncation gives 35
  })

  it('gates itemReady on holding an item AND not being motion-locked (Q21)', () => {
    const view = raceView()
    const out = createHudModel()

    buildHudModel(view, RACE_LAPS, out)
    expect(out.itemReady).toBe(false) // item 'none'

    view.karts[0].item = 'boost'
    buildHudModel(view, RACE_LAPS, out)
    expect(out.item).toBe('boost')
    expect(out.itemReady).toBe(true)

    view.karts[0].respawnTicks = 40
    buildHudModel(view, RACE_LAPS, out)
    expect(out.itemReady).toBe(false)
    expect(out.respawning).toBe(true)
    expect(out.motionLocked).toBe(true)
  })

  // §8.1: motionLocked agrees with sim's motionLocked on the local kart. The
  // HUD's throttle indicator reads this, not `accel` - the adapters keep
  // reporting the player's real input (Q21), so `accel` says nothing about
  // whether the kart can move.
  it('agrees with sim’s motionLocked, and is independent of spinOut', () => {
    const ctx = makeRenderContext()
    const state = createState(ctx, 3, Array.from({ length: MAX_KARTS }, () => 0))
    const view = raceView()
    const out = createHudModel()

    for (const respawnTicks of [0, 1, 40, 72]) {
      state.karts[0].respawnTicks = respawnTicks
      view.karts[0].respawnTicks = respawnTicks
      buildHudModel(view, RACE_LAPS, out)
      expect(out.motionLocked).toBe(simMotionLocked(state.karts[0]))
      expect(out.motionLocked).toBe(out.respawning)
    }

    // A spun-out kart is steering-locked, not motion-locked: it is still
    // sliding, and the HUD must not tell the player the throttle is dead.
    view.karts[0].respawnTicks = 0
    view.karts[0].spinOutTicks = 30
    buildHudModel(view, RACE_LAPS, out)
    expect(out.spunOut).toBe(true)
    expect(out.motionLocked).toBe(false)
  })

  it('copies driftTier in sim’s encoding, where 0 is a real tier', () => {
    const view = raceView()
    const out = createHudModel()
    for (const tier of [-1, 0, 1, 2]) {
      view.karts[0].driftTier = tier
      buildHudModel(view, RACE_LAPS, out)
      expect(out.driftTier).toBe(tier)
    }
  })

  it('drives raceClock and countdownLabel off raceStartTick', () => {
    const view = raceView()
    const out = createHudModel()

    view.phase = 'countdown'
    view.tick = 0
    view.raceStartTick = COUNTDOWN_TICKS
    view.countdownTicksLeft = COUNTDOWN_TICKS
    buildHudModel(view, RACE_LAPS, out)
    expect(out.countdownLabel).toBe('3')
    expect(out.raceClock).toBe('0:00.000') // the clock does not run yet

    view.phase = 'racing'
    view.tick = COUNTDOWN_TICKS + 60
    view.countdownTicksLeft = 0
    buildHudModel(view, RACE_LAPS, out)
    expect(out.countdownLabel).toBe('')
    expect(out.raceClock).toBe('0:01.000')
  })
})

describe('buildHudModel - standings', () => {
  // The signature defect this test exists for: `view.karts` is indexed BY SEAT,
  // so a builder that emits standings in seat order looks perfectly correct
  // whenever place happens to equal seat - which is true on the grid, and true
  // in every fixture that does not deliberately shuffle. So this shuffles.
  it('sorts by place ascending, not by seat', () => {
    const view = raceView()
    const placeOf = [5, 0, 7, 2, 1, 6, 3, 4] // seat -> place
    for (let i = 0; i < MAX_KARTS; i++) {
      view.karts[i].place = placeOf[i]
      view.karts[i].lap = i % RACE_LAPS
    }
    const out = createHudModel()
    buildHudModel(view, RACE_LAPS, out)

    expect(out.standings).toHaveLength(MAX_KARTS)
    for (let n = 0; n < MAX_KARTS; n++) {
      expect(out.standings[n].place).toBe(n + 1)
    }
    // seat order would put playerId 0 first; place order puts playerId 1 first
    expect(out.standings.map((r) => r.playerId)).toEqual([1, 4, 3, 6, 7, 0, 5, 2])
    expect(out.standings[0].playerId).not.toBe(0)
  })

  it('carries each seat’s own lap, isBot and connected into its row', () => {
    const view = raceView()
    view.karts[3].lap = 2
    view.karts[3].isBot = false
    view.karts[3].connected = false
    const out = createHudModel()
    buildHudModel(view, RACE_LAPS, out)
    const row = out.standings.find((r) => r.playerId === 3)
    expect(row).toBeDefined()
    expect(row?.lap).toBe(3) // 1-based, clamped
    expect(row?.isBot).toBe(false)
    expect(row?.connected).toBe(false)
  })

  it('reuses the standings array instead of allocating one per frame', () => {
    const view = raceView()
    const out = createHudModel()
    const arr = out.standings
    buildHudModel(view, RACE_LAPS, out)
    buildHudModel(view, RACE_LAPS, out)
    expect(out.standings).toBe(arr)
    expect(out.standings).toHaveLength(MAX_KARTS)
  })

  // Catches a stale row surviving a re-sort: build twice with different orders
  // and the second result must not carry any of the first's ordering.
  it('re-sorts cleanly when places change between frames', () => {
    const view = raceView()
    const out = createHudModel()
    buildHudModel(view, RACE_LAPS, out)
    expect(out.standings.map((r) => r.playerId)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])

    for (let i = 0; i < MAX_KARTS; i++) view.karts[i].place = MAX_KARTS - 1 - i
    buildHudModel(view, RACE_LAPS, out)
    expect(out.standings.map((r) => r.playerId)).toEqual([7, 6, 5, 4, 3, 2, 1, 0])
    expect(out.standings.map((r) => r.place)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
  })
})

describe('buildHudModel - no local seat', () => {
  it('hides the HUD but still fills the shared fields', () => {
    const view = raceView()
    view.localPlayerId = -1
    view.tick = 120
    view.raceStartTick = 0
    const out = createHudModel()
    buildHudModel(view, RACE_LAPS, out)

    expect(out.visible).toBe(false)
    expect(out.place).toBe(1)
    expect(out.lap).toBe(1)
    expect(out.speedKph).toBe(0)
    expect(out.item).toBe('none')
    expect(out.itemReady).toBe(false)
    expect(out.driftTier).toBe(-1)
    expect(out.respawning).toBe(false)
    expect(out.motionLocked).toBe(false)
    // A spectator still sees the field and the clock.
    expect(out.fieldSize).toBe(MAX_KARTS)
    expect(out.totalLaps).toBe(RACE_LAPS)
    expect(out.raceClock).toBe('0:02.000')
    expect(out.standings).toHaveLength(MAX_KARTS)
    expect(out.standings[0].playerId).toBe(0)
  })

  it('clears the local fields again after a seat goes away', () => {
    const view = raceView()
    view.karts[0].speed = 30
    view.karts[0].item = 'bolt'
    const out = createHudModel()
    buildHudModel(view, RACE_LAPS, out)
    expect(out.speedKph).toBe(108)

    view.localPlayerId = -1
    buildHudModel(view, RACE_LAPS, out)
    expect(out.speedKph).toBe(0)
    expect(out.item).toBe('none')
  })
})

describe('createHudModel', () => {
  it('allocates MAX_KARTS distinct standing rows', () => {
    const a = createHudModel()
    expect(a.standings).toHaveLength(MAX_KARTS)
    expect(a.standings[0]).not.toBe(a.standings[1])
    const b = createHudModel()
    expect(b.standings).not.toBe(a.standings)
    a.standings[0].playerId = 99
    expect(b.standings[0].playerId).not.toBe(99)
  })

  it('starts hidden, with no item and no drift tier', () => {
    const m = createHudModel()
    expect(m.visible).toBe(false)
    expect(m.item).toBe('none')
    expect(m.driftTier).toBe(-1)
    expect(m.countdownLabel).toBe('')
    expect(m.raceClock).toBe('0:00.000')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/render/test/hud.test.ts`

Expected: FAIL — the module under test does not exist yet:

```
Error: Failed to load url ../src/hud (resolved id: /home/kasm-user/tapkart/packages/render/src/hud) in /home/kasm-user/tapkart/packages/render/test/hud.test.ts. Does the file exist?
```

- [ ] **Step 3: Write the implementation**

Create `packages/render/src/hud.ts`:

```ts
// PURE (contract §0a): numbers and strings only. No DOM, no clock, no `three`.
// startShell writes these values into the DOM and makes no decision of its own.
import type { ItemKind, RacePhase } from '@tapkart/sim'
import { COUNTDOWN_TICKS, MAX_KARTS, RACE_LAPS, TICK_DT, clamp } from '@tapkart/sim'
import type { RaceView } from './types'

export type CountdownLabel = '' | '3' | '2' | '1' | 'GO'

export interface HudStanding {
  playerId: number
  place: number // 1-based
  lap: number // 1-based, clamped
  isBot: boolean
  connected: boolean
}

export interface HudModel {
  visible: boolean
  place: number // 1-BASED for display
  fieldSize: number // MAX_KARTS in v1
  lap: number // 1-BASED for display: clamp(lap + 1, 1, totalLaps)
  totalLaps: number
  speedKph: number // KartView.speed * 3.6, rounded to an integer
  item: ItemKind
  itemReady: boolean // item !== 'none' && !motionLocked
  driftTier: number // sim's encoding, copied from KartView.driftTier
  countdownLabel: CountdownLabel
  raceClock: string // formatRaceClock(max(0, tick - raceStartTick))
  respawning: boolean // respawnTicks > 0
  spunOut: boolean // spinOutTicks > 0
  /** === respawning. The HUD's throttle indicator reads THIS, not accel (Q21):
   *  adapters keep reporting the player's real input under motion lock, so
   *  `accel` says nothing about whether the kart can move. */
  motionLocked: boolean
  standings: HudStanding[] // length MAX_KARTS, sorted by place ascending
}

/** Ticks the 'GO' label stays up after `racing` begins. */
export const GO_LABEL_TICKS = 45

export function createHudModel(): HudModel {
  const standings: HudStanding[] = []
  for (let i = 0; i < MAX_KARTS; i++) {
    standings.push({ playerId: i, place: i + 1, lap: 1, isBot: true, connected: false })
  }
  return {
    visible: false,
    place: 1,
    fieldSize: MAX_KARTS,
    lap: 1,
    totalLaps: RACE_LAPS,
    speedKph: 0,
    item: 'none',
    itemReady: false,
    driftTier: -1,
    countdownLabel: '',
    raceClock: formatRaceClock(0),
    respawning: false,
    spunOut: false,
    motionLocked: false,
    standings,
  }
}

/**
 * Ticks -> "m:ss.mmm" - minutes unpadded, seconds two digits, milliseconds
 * three. formatRaceClock(0) === '0:00.000', formatRaceClock(3661) === '1:01.017'.
 * ms = Math.round(ticks * TICK_DT * 1000). Pure: no Date, no Intl.
 */
export function formatRaceClock(ticks: number): string {
  const t = Number.isFinite(ticks) && ticks > 0 ? ticks : 0
  const ms = Math.round(t * TICK_DT * 1000)
  const minutes = Math.floor(ms / 60000)
  const seconds = Math.floor((ms % 60000) / 1000)
  const millis = ms % 1000
  return `${minutes}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`
}

/**
 * '3' | '2' | '1' across COUNTDOWN_TICKS in equal thirds, 'GO' from the tick the
 * countdown expires until GO_LABEL_TICKS into the race, then ''.
 *
 * A total function of (phase, two numbers), so it is testable directly and the
 * caller cannot produce a state it has no answer for: `countdownTicksLeft` is
 * clamped into [0, COUNTDOWN_TICKS].
 */
export function countdownLabelFor(
  phase: RacePhase,
  countdownTicksLeft: number,
  ticksSinceStart: number,
): CountdownLabel {
  if (phase === 'countdown') {
    const left = clamp(countdownTicksLeft, 0, COUNTDOWN_TICKS)
    if (left > (COUNTDOWN_TICKS * 2) / 3) return '3'
    if (left > COUNTDOWN_TICKS / 3) return '2'
    if (left > 0) return '1'
    // The countdown's final tick: the lights go green here, and the label runs
    // straight on into the racing branch below with no blank frame between.
    return 'GO'
  }
  if (phase === 'racing') return ticksSinceStart < GO_LABEL_TICKS ? 'GO' : ''
  return ''
}

/**
 * SOLE WRITER of every HudModel field. `visible` is false when
 * `view.localPlayerId < 0`; everything else is read off the local seat, except
 * the fields a spectator still needs - standings, clock, countdown, field size.
 */
export function buildHudModel(view: RaceView, totalLaps: number, out: HudModel): void {
  const pid = view.localPlayerId
  const hasSeat = pid >= 0 && pid < MAX_KARTS
  const ticksSinceStart = Math.max(0, view.tick - view.raceStartTick)

  out.visible = hasSeat
  out.fieldSize = MAX_KARTS
  out.totalLaps = totalLaps
  out.countdownLabel = countdownLabelFor(view.phase, view.countdownTicksLeft, ticksSinceStart)
  out.raceClock = formatRaceClock(ticksSinceStart)

  if (hasSeat) {
    const k = view.karts[pid]
    const locked = k.respawnTicks > 0
    out.place = k.place + 1
    out.lap = clamp(k.lap + 1, 1, totalLaps)
    out.speedKph = Math.round(k.speed * 3.6)
    out.item = k.item
    out.itemReady = k.item !== 'none' && !locked
    out.driftTier = k.driftTier
    out.respawning = locked
    out.spunOut = k.spinOutTicks > 0
    out.motionLocked = locked
  } else {
    // Neutral display values: place and lap are 1-based, so 0 would render
    // "0th" and "LAP 0/3"; driftTier is sim's "no tier".
    out.place = 1
    out.lap = 1
    out.speedKph = 0
    out.item = 'none'
    out.itemReady = false
    out.driftTier = -1
    out.respawning = false
    out.spunOut = false
    out.motionLocked = false
  }

  // Standings: fill by seat, then sort by place. `view.karts` is indexed BY
  // SEAT and is not in standings order.
  for (let i = 0; i < MAX_KARTS; i++) {
    const k = view.karts[i]
    const row = out.standings[i]
    row.playerId = k.playerId
    row.place = k.place + 1
    row.lap = clamp(k.lap + 1, 1, totalLaps)
    row.isBot = k.isBot
    row.connected = k.connected
  }
  // Insertion sort over the array's own references: 8 elements, no allocation,
  // stable, so equal places keep seat order.
  for (let i = 1; i < MAX_KARTS; i++) {
    const row = out.standings[i]
    let j = i - 1
    while (j >= 0 && out.standings[j].place > row.place) {
      out.standings[j + 1] = out.standings[j]
      j--
    }
    out.standings[j + 1] = row
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/render/test/hud.test.ts`
Expected: PASS, 23 tests.

Run: `npm run typecheck --workspace @tapkart/render`
Expected: exit 0, no output.

- [ ] **Step 5: Commit**

```bash
git add packages/render/src/hud.ts packages/render/test/hud.test.ts && git commit -m "feat(render): the pure HUD model

Lap is clamp(lap + 1, 1, totalLaps) so the grid never reads LAP 0/3 (Q18), the
throttle indicator reads motionLocked rather than accel (Q21), standings are
sorted out of seat order into place order by an allocation-free insertion sort,
and raceClock is the only time the HUD reports - results carry positions and DNF
only (Q16, Q17)."
```

---

### Task 14: `packages/render/src/audio.ts` — the pure audio model and the authored backend seam

Contract §4.9. Ruling Q26: **procedural audio is out of Plan 3 and deferred to
Plan 5, and the seam is authored now.** A pure model plus a no-op backend, so
Plan 5 adds a Web Audio implementation under `packages/render/src/audio/` and a
barrel line (explicitly permitted by §1a) and touches nothing else. Building a
seam is hours; retrofitting one is a refactor.

Nothing is audible in Plan 3. `AudioModel` is asserted by this task's tests and
that is the whole of the audio verification in this plan (§8.3).

**Files:**
- Create: `packages/render/src/audio.ts`
- Test: `packages/render/test/audio.test.ts`

**Interfaces:**

- Consumes, from `@tapkart/sim` (contract §2.1, §2.2):
  ```ts
  export const MAX_KARTS = 8
  export function clamp(v: number, lo: number, hi: number): number
  ```
- Consumes, from `packages/render/src/hud.ts` (Task 13):
  ```ts
  export type CountdownLabel = '' | '3' | '2' | '1' | 'GO'
  export function countdownLabelFor(phase: RacePhase, countdownTicksLeft: number,
                                    ticksSinceStart: number): CountdownLabel
  ```
  The countdown beep fires on a **label change**, so the beep and the number on
  screen can never disagree — two encodings of one fact is the defect class this
  contract exists to prevent.
- Consumes, from `packages/render/src/types.ts` (contract §4.2, an earlier task) —
  the fields this module reads: `RaceView.{tick, phase, localPlayerId,
  raceStartTick, karts, countdownTicksLeft}` and `KartView.{playerId, source,
  position, heading, speed, driftActive, spinOutTicks, respawnTicks, boostTicks,
  shielded, item, lap}`, plus:
  ```ts
  export function createRaceView(itemBoxCount: number): RaceView
  ```
- **Consumes an arrangement, not a symbol: two `RaceView`s, alternated per
  frame.** `createRaceView` is called **twice** at session construction and the
  two views are swapped **after** `audio.apply(model)` in the frame loop. The
  session task owns the buffers and exposes them as
  ```ts
  currentView(): RaceView      // the view THIS frame is built into
  prevView(): RaceView         // the view the PREVIOUS frame was built into
  swapViews(): void            // exchanges them; called AFTER audio.apply, never before
  ```
  on `RaceSession` (contract §5.10), and the shell task calls
  `buildAudioModel(session.prevView(), session.currentView(), model)` then
  `audio.apply(model)` then `session.swapViews()` (§5.13). **This task specifies
  none of that wiring**, so the two tasks cannot write two different swaps. See
  *The precondition* below for why it is not optional.
- Produces — imported by `src/index.ts` and by `startShell` (§5.13), and
  implemented against by Plan 5:
  ```ts
  export type AudioCueKind =
    | 'engine' | 'skid' | 'impact' | 'itemPickup' | 'itemUse'
    | 'boost' | 'spinOut' | 'respawn' | 'lapCross' | 'countdownBeep' | 'finish'
  export interface AudioCue { kind: AudioCueKind; playerId: number
    intensity: number; pan: number }
  export interface AudioModel { engineFreqHz: number; engineGain: number
    skidGain: number; cues: AudioCue[]; cueCount: number }
  export const MAX_AUDIO_CUES = 16
  export function createAudioModel(): AudioModel
  export function buildAudioModel(prev: RaceView, view: RaceView, out: AudioModel): void
  export interface AudioConfig { masterGain: number; enabled: boolean }
  export interface AudioBackend {
    apply(model: AudioModel): void
    setConfig(cfg: AudioConfig): void
    close(): void
  }
  export const nullAudioBackend: AudioBackend
  ```

---

**The precondition: two views, or no cue can ever fire.**

`buildAudioModel` derives every one-shot from the delta between two views. The
contract as locked allocates exactly **one** `RaceView` per session (§4.2:
*"Called once per session, never per frame"*), and `ViewBuilder.build` is the
*"SOLE WRITER of every RaceView field"* (§5.11), called once per frame by
`startShell`. With one view, `prev` **is** `view`: every delta is empty and no
`impact`, `itemUse`, `itemPickup`, `boost`, `spinOut`, `lapCross`,
`countdownBeep` or `finish` cue can ever fire in the shipped game.

It stays green because §8.1's assertion — *"a lap crossing between two views
fires exactly one `lapCross` cue"* — hand-builds two views with the test-only
`makeRaceView`. **The unit test passes; the shell cannot reproduce its
precondition.** That is this project's signature defect, found for the first time
in a contract rather than in code.

**Ruled:** two `RaceView`s, allocated at session construction, alternated per
frame, with the swap **after** `audio.apply` — cues are consumed in the frame
they are raised, so a swap placed before the consumer drops them just as
thoroughly.

This task carries three consequences:

1. `buildAudioModel(prev, view, out)` keeps its signature. It is a pure function
   of its two arguments and **retains no reference to either** — next frame, the
   object it was handed as `view` is handed back as `prev`, so an implementation
   that stashed a view would compare an object to itself.
2. The test below drives the *real* per-frame arrangement, both ways: one view
   alternating with itself, and two views swapped after the consumer. A test that
   only hand-builds two views cannot see this defect — that is precisely how it
   reached a locked contract.
3. The buffers and the swap belong to the session/shell tasks. Do not add a
   second `createRaceView` call here, and do not cache a view inside `audio.ts`
   to work around a single-view caller: that is the tempting wrong fix, it makes
   the function stateful and frame-order-dependent, and the idempotence test
   below fails on it.

`buildRenderFrame` and `buildHudModel` are unaffected by the alternation: both
read whichever view is current and keep their accumulators on their own `out`.

---

**What the model contains, and what it deliberately does not**

- **`engineFreqHz` / `engineGain` / `skidGain` are the LOCAL kart's, only.** When
  Plan 5 lands: local kart engine voice plus one-shots. Eight oscillators for
  eight engines is a mobile battery problem and a mix nobody can hear through,
  and `AudioModel` is shaped for exactly that today — one engine, N one-shots —
  so Plan 5 changes no signature.
- **`AudioConfig` is a device/user preference, not a property of the audio the
  race is producing (R38).** `masterGain` and `enabled` must never be fields of
  `AudioModel`: a model that carries a setting means moving a volume slider
  re-plans a frame. The seam carries its config from day one — `setConfig` is
  called on every Settings change and once at startup, **never per frame** — so a
  live settings change has somewhere to go and Plan 5 needs no widened concrete
  type and no amendment to the contract.
- **`'engine'` and `'skid'` name continuous voices, not one-shots.** They are in
  `AudioCueKind` because the union names every voice the backend addresses;
  `buildAudioModel` never emits them as cues, and `createAudioModel` uses
  `'engine'` as the inert placeholder kind in unused slots.
- **Overflow drops, never grows.** `cues` is fixed at `MAX_AUDIO_CUES` and only
  `[0, cueCount)` is live. Emission order is fixed — countdown and finish first,
  then seats ascending, then a fixed per-seat kind order — so *which* cues
  survive a busy frame is deterministic and testable rather than incidental.

**What the contract leaves open, decided here** (flagged rather than buried; the
§11 census fixes `render/audio` at the nine exports above, so none of this adds a
symbol):

- **The cue rules.** Per seat, comparing `prev.karts[i]` to `view.karts[i]`:
  `lap` increased → `lapCross`; `'none'` → an item → `itemPickup`; an item →
  `'none'` → `itemUse`; `boostTicks` increased → `boost`; `spinOutTicks`
  increased → `spinOut`; `respawnTicks` increased → `respawn`; `shielded` went
  true → false → `impact` (a popped shield is the only impact a `RaceView`
  witnesses — kart-kart contact is not in the view at all). A seat whose `source`
  is `'absent'` in either view is skipped, so a remote kart appearing or
  vanishing does not fire a burst of phantom cues.
- **`pan` without a camera.** §4.9 describes pan as coming from the camera's
  right axis, but the signature has no camera and adding one would make the audio
  model depend on frame ordering. The local kart's heading is the chase camera's
  heading, so pan is the direction cosine of the sounding kart along the local
  kart's right axis, `right = (-sin h, 0, cos h)` (§0) — a pure direction, in
  `[-1, 1]`, needing no distance constant. The local kart's own cues pan to 0.
- **`intensity`** falls off linearly with plan-view distance from the local kart
  over `CUE_FALLOFF_M` (module-private, 60 m), times a per-kind base weight. A
  spectator with no local seat hears every cue at full intensity and centred:
  there is no listener to be far from.

---

- [ ] **Step 1: Write the failing test**

Create `packages/render/test/audio.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { COUNTDOWN_TICKS, MAX_KARTS } from '@tapkart/sim'
import type { RaceView } from '../src/types'
import { createRaceView } from '../src/types'
import type { AudioModel } from '../src/audio'
import {
  MAX_AUDIO_CUES,
  buildAudioModel,
  createAudioModel,
  nullAudioBackend,
} from '../src/audio'

/** Every seat filled, place === seat, local seat 0, racing, nothing happening. */
function quietView(): RaceView {
  const view = createRaceView(0)
  view.tick = 300
  view.phase = 'racing'
  view.localPlayerId = 0
  view.raceStartTick = 0
  view.countdownTicksLeft = 0
  view.entityCount = 0
  for (let i = 0; i < MAX_KARTS; i++) {
    const k = view.karts[i]
    k.playerId = i
    k.characterIdx = i
    k.source = 'authoritative'
    k.place = i
    k.position.x = 0
    k.position.y = 0
    k.position.z = 0
    k.heading = 0
    k.speed = 0
    k.lap = 0
    k.item = 'none'
    k.boostTicks = 0
    k.spinOutTicks = 0
    k.respawnTicks = 0
    k.shielded = false
    k.driftActive = false
    k.isBot = i !== 0
    k.connected = true
  }
  return view
}

/** Deep-enough copy for a two-view delta: the fields buildAudioModel reads. */
function copyView(src: RaceView): RaceView {
  const dst = quietView()
  dst.tick = src.tick
  dst.phase = src.phase
  dst.localPlayerId = src.localPlayerId
  dst.raceStartTick = src.raceStartTick
  dst.countdownTicksLeft = src.countdownTicksLeft
  for (let i = 0; i < MAX_KARTS; i++) {
    const a = src.karts[i]
    const b = dst.karts[i]
    b.playerId = a.playerId
    b.source = a.source
    b.position.x = a.position.x
    b.position.y = a.position.y
    b.position.z = a.position.z
    b.heading = a.heading
    b.speed = a.speed
    b.lap = a.lap
    b.item = a.item
    b.boostTicks = a.boostTicks
    b.spinOutTicks = a.spinOutTicks
    b.respawnTicks = a.respawnTicks
    b.shielded = a.shielded
    b.driftActive = a.driftActive
  }
  return dst
}

function heard(model: AudioModel): string[] {
  const out: string[] = []
  for (let i = 0; i < model.cueCount; i++) {
    out.push(`${model.cues[i].kind}:${model.cues[i].playerId}`)
  }
  return out
}

describe('createAudioModel', () => {
  it('allocates a fixed cue pool with distinct slots', () => {
    const m = createAudioModel()
    expect(m.cues).toHaveLength(MAX_AUDIO_CUES)
    expect(m.cueCount).toBe(0)
    expect(m.cues[0]).not.toBe(m.cues[1])
    const n = createAudioModel()
    expect(n.cues).not.toBe(m.cues)
  })

  // R38, made mechanical: volume and mute are device preferences carried by
  // AudioConfig through setConfig. A model that carried them would mean moving
  // a slider re-plans a frame - and the leak is invisible until Plan 5.
  it('carries no volume or mute field', () => {
    expect(Object.keys(createAudioModel())).toEqual([
      'engineFreqHz',
      'engineGain',
      'skidGain',
      'cues',
      'cueCount',
    ])
  })
})

describe('buildAudioModel - continuous levels', () => {
  it('rises with the LOCAL kart’s speed and ignores everyone else', () => {
    const prev = quietView()
    const view = copyView(prev)
    const m = createAudioModel()

    buildAudioModel(prev, view, m)
    const idleHz = m.engineFreqHz
    const idleGain = m.engineGain
    expect(idleHz).toBeGreaterThan(0)

    view.karts[5].speed = 40 // a remote kart flat out
    buildAudioModel(prev, view, m)
    expect(m.engineFreqHz).toBe(idleHz)
    expect(m.engineGain).toBe(idleGain)

    view.karts[0].speed = 40
    buildAudioModel(prev, view, m)
    expect(m.engineFreqHz).toBeGreaterThan(idleHz)
    expect(m.engineGain).toBeGreaterThan(idleGain)
    expect(m.engineGain).toBeLessThanOrEqual(1)
  })

  it('cuts the engine while motion-locked', () => {
    const prev = quietView()
    const view = copyView(prev)
    const m = createAudioModel()
    view.karts[0].speed = 20
    view.karts[0].respawnTicks = 40
    buildAudioModel(prev, view, m)
    expect(m.engineGain).toBe(0)
  })

  it('opens the skid voice only while drifting or spun out', () => {
    const prev = quietView()
    const view = copyView(prev)
    const m = createAudioModel()

    view.karts[0].speed = 20
    buildAudioModel(prev, view, m)
    expect(m.skidGain).toBe(0)

    view.karts[0].driftActive = true
    buildAudioModel(prev, view, m)
    const drifting = m.skidGain
    expect(drifting).toBeGreaterThan(0)

    view.karts[0].driftActive = false
    view.karts[0].spinOutTicks = 30
    buildAudioModel(prev, view, m)
    expect(m.skidGain).toBeGreaterThan(0)

    view.karts[0].spinOutTicks = 0
    buildAudioModel(prev, view, m)
    expect(m.skidGain).toBe(0)
  })

  it('is silent with no local seat', () => {
    const prev = quietView()
    const view = copyView(prev)
    view.localPlayerId = -1
    view.karts[0].speed = 40
    const m = createAudioModel()
    buildAudioModel(prev, view, m)
    expect(m.engineFreqHz).toBe(0)
    expect(m.engineGain).toBe(0)
    expect(m.skidGain).toBe(0)
  })
})

describe('buildAudioModel - one-shots', () => {
  // §8.1, verbatim: a lap crossing between two views fires exactly one lapCross
  // cue and no others.
  it('fires exactly one lapCross on a lap crossing', () => {
    const prev = quietView()
    const view = copyView(prev)
    view.tick = prev.tick + 1
    view.karts[3].lap = 1
    const m = createAudioModel()
    buildAudioModel(prev, view, m)
    expect(heard(m)).toEqual(['lapCross:3'])
    expect(m.cues[0].intensity).toBeGreaterThan(0)
  })

  // Catches level-triggering instead of edge-triggering: a cue that fires while
  // a condition HOLDS repeats 60 times a second and is unlistenable.
  it('fires nothing when nothing changed', () => {
    const prev = quietView()
    prev.karts[2].lap = 2
    prev.karts[2].item = 'bolt'
    prev.karts[2].boostTicks = 40
    prev.karts[2].spinOutTicks = 20
    prev.karts[2].respawnTicks = 10
    prev.karts[2].shielded = true
    const view = copyView(prev)
    const m = createAudioModel()
    buildAudioModel(prev, view, m)
    expect(heard(m)).toEqual([])
    expect(m.cueCount).toBe(0)
  })

  it('fires each edge once, and never on its reverse', () => {
    const table: { name: string; set: (k: RaceView['karts'][number]) => void; cue: string }[] = [
      { name: 'itemPickup', set: (k) => { k.item = 'seeker' }, cue: 'itemPickup:1' },
      { name: 'boost', set: (k) => { k.boostTicks = 90 }, cue: 'boost:1' },
      { name: 'spinOut', set: (k) => { k.spinOutTicks = 60 }, cue: 'spinOut:1' },
      { name: 'respawn', set: (k) => { k.respawnTicks = 72 }, cue: 'respawn:1' },
    ]
    for (const row of table) {
      const prev = quietView()
      const view = copyView(prev)
      row.set(view.karts[1])
      const m = createAudioModel()
      buildAudioModel(prev, view, m)
      expect(heard(m)).toEqual([row.cue])

      // The reverse edge (the timer running out, the item being consumed) is
      // not this cue.
      const m2 = createAudioModel()
      buildAudioModel(view, prev, m2)
      expect(heard(m2)).not.toContain(row.cue)
    }
  })

  it('fires itemUse when an item leaves the slot, and impact when a shield pops', () => {
    const prev = quietView()
    prev.karts[4].item = 'bolt'
    prev.karts[4].shielded = true
    const view = copyView(prev)
    view.karts[4].item = 'none'
    view.karts[4].shielded = false
    const m = createAudioModel()
    buildAudioModel(prev, view, m)
    expect(heard(m).sort()).toEqual(['impact:4', 'itemUse:4'])
  })

  // Catches a burst of phantom cues when a remote kart's interpolation buffer
  // starves and recovers: 'absent' fields are stale, not news.
  it('skips a seat that is absent in either view', () => {
    const prev = quietView()
    prev.karts[6].source = 'absent'
    const view = copyView(prev)
    view.karts[6].source = 'interpolated'
    view.karts[6].lap = 2
    view.karts[6].item = 'blink'
    const m = createAudioModel()
    buildAudioModel(prev, view, m)
    expect(heard(m)).toEqual([])
  })

  it('beeps once per countdown digit, and only on the change', () => {
    const prev = quietView()
    prev.phase = 'countdown'
    prev.tick = 59
    prev.raceStartTick = COUNTDOWN_TICKS
    prev.countdownTicksLeft = COUNTDOWN_TICKS - 59
    const same = copyView(prev)
    const m = createAudioModel()
    buildAudioModel(prev, same, m)
    expect(heard(m)).toEqual([])

    const next = copyView(prev)
    next.tick = 60
    next.countdownTicksLeft = COUNTDOWN_TICKS - 60 // '3' -> '2'
    buildAudioModel(prev, next, m)
    expect(heard(m)).toEqual(['countdownBeep:0'])
  })

  it('fires finish once, on the transition into finished', () => {
    const prev = quietView()
    const view = copyView(prev)
    view.phase = 'finished'
    const m = createAudioModel()
    buildAudioModel(prev, view, m)
    expect(heard(m)).toEqual(['finish:0'])

    const after = copyView(view)
    buildAudioModel(view, after, m)
    expect(heard(m)).toEqual([])
  })

  // §8.1: more than MAX_AUDIO_CUES cues in one frame drops rather than grows.
  // The array itself must not grow either - the backend owns those slots.
  it('drops rather than grows when a frame is busy', () => {
    const prev = quietView()
    const view = copyView(prev)
    for (let i = 0; i < MAX_KARTS; i++) {
      view.karts[i].lap = 1
      view.karts[i].item = 'boost'
      view.karts[i].boostTicks = 90
    } // 8 seats x 3 edges = 24 cues offered
    const m = createAudioModel()
    buildAudioModel(prev, view, m)
    expect(m.cueCount).toBe(MAX_AUDIO_CUES)
    expect(m.cues).toHaveLength(MAX_AUDIO_CUES)
    // Deterministic survivors: seats ascending, fixed per-seat kind order.
    expect(heard(m)[0]).toBe('lapCross:0')
    expect(heard(m)[MAX_AUDIO_CUES - 1]).toBe('lapCross:5')
  })

  it('resets cueCount every call rather than accumulating', () => {
    const prev = quietView()
    const view = copyView(prev)
    view.karts[3].lap = 1
    const m = createAudioModel()
    buildAudioModel(prev, view, m)
    buildAudioModel(prev, view, m)
    buildAudioModel(prev, view, m)
    expect(m.cueCount).toBe(1)
  })

  it('pans by the sounding kart’s bearing off the local kart’s right axis', () => {
    const prev = quietView()
    const view = copyView(prev)
    // local kart at the origin, heading 0: right = (-sin 0, 0, cos 0) = +z
    view.karts[1].position.z = 10
    view.karts[2].position.z = -10
    view.karts[3].position.x = 10
    view.karts[1].lap = 1
    view.karts[2].lap = 1
    view.karts[3].lap = 1
    const m = createAudioModel()
    buildAudioModel(prev, view, m)
    const live = Array.from({ length: m.cueCount }, (_, i) => m.cues[i])
    const byPlayer = new Map(live.map((c) => [c.playerId, c] as const))
    expect(byPlayer.get(1)?.pan).toBeCloseTo(1, 9)
    expect(byPlayer.get(2)?.pan).toBeCloseTo(-1, 9)
    expect(byPlayer.get(3)?.pan).toBeCloseTo(0, 9)
  })

  it('quietens a distant cue and never leaves the 0..1 range', () => {
    const prev = quietView()
    const view = copyView(prev)
    view.karts[1].lap = 1
    view.karts[2].lap = 1
    view.karts[2].position.x = 1000
    const m = createAudioModel()
    buildAudioModel(prev, view, m)
    const near = Array.from({ length: m.cueCount }, (_, i) => m.cues[i]).find(
      (c) => c.playerId === 1,
    )
    const far = Array.from({ length: m.cueCount }, (_, i) => m.cues[i]).find(
      (c) => c.playerId === 2,
    )
    expect(near?.intensity).toBeGreaterThan(far?.intensity ?? 1)
    expect(far?.intensity).toBeGreaterThanOrEqual(0)
    expect(near?.intensity).toBeLessThanOrEqual(1)
  })
})

describe('buildAudioModel - the double-buffered view (the arrangement)', () => {
  /** One frame of authoritative truth, as ViewBuilder.build would resolve it. */
  interface Truth {
    tick: number
    laps: readonly number[]
  }

  /**
   * Stands in for ViewBuilder.build: SOLE WRITER of the fields it fills, into a
   * caller-owned view. It holds no state of its own, exactly as the real one
   * does not.
   */
  function writeView(out: RaceView, t: Truth): void {
    out.tick = t.tick
    out.phase = 'racing'
    out.localPlayerId = 0
    out.raceStartTick = 0
    out.countdownTicksLeft = 0
    for (let i = 0; i < MAX_KARTS; i++) {
      const k = out.karts[i]
      k.playerId = i
      k.source = 'authoritative'
      k.place = i
      k.position.x = 0
      k.position.y = 0
      k.position.z = 0
      k.heading = 0
      k.speed = 10
      k.lap = t.laps[i]
      k.item = 'none'
      k.boostTicks = 0
      k.spinOutTicks = 0
      k.respawnTicks = 0
      k.shielded = false
      k.driftActive = false
    }
  }

  const SCRIPT: readonly Truth[] = [
    { tick: 0, laps: [0, 0, 0, 0, 0, 0, 0, 0] },
    { tick: 1, laps: [0, 0, 0, 0, 0, 0, 0, 0] },
    { tick: 2, laps: [1, 0, 0, 0, 0, 0, 0, 0] }, // the local kart crosses the line
    { tick: 3, laps: [1, 0, 0, 0, 0, 0, 0, 0] },
  ]

  /** The contract as locked: ONE RaceView, written every frame by the builder. */
  function runSingleBuffer(): { cues: string[]; finalLap: number } {
    const view = createRaceView(0)
    const model = createAudioModel()
    const cues: string[] = []
    for (const t of SCRIPT) {
      writeView(view, t)
      buildAudioModel(view, view, model) // there is no other view to pass
      cues.push(...heard(model))
    }
    return { cues, finalLap: view.karts[0].lap }
  }

  /** The ruling: two views, alternated, swapped AFTER the consumer reads. */
  function runDoubleBuffer(): { cues: string[]; finalLap: number } {
    let prev = createRaceView(0)
    let cur = createRaceView(0)
    const model = createAudioModel()
    const cues: string[] = []
    writeView(prev, SCRIPT[0])
    for (let n = 1; n < SCRIPT.length; n++) {
      writeView(cur, SCRIPT[n])
      buildAudioModel(prev, cur, model)
      cues.push(...heard(model)) // audio.apply(model) happens here
      const tmp = prev
      prev = cur
      cur = tmp // ... and the swap happens after it
    }
    return { cues, finalLap: prev.karts[0].lap }
  }

  // What this catches: the contract defect itself - a shell that keeps one
  // RaceView is silent for the whole race, and every hand-built two-view test
  // in this file passes anyway. It is executable evidence for the precondition,
  // in the package that owns the consumer; the matching assertion INSIDE the
  // real frame loop belongs to the session/shell tasks that own the buffers.
  it('is silent when one view is alternated with itself', () => {
    const run = runSingleBuffer()
    expect(run.cues).toEqual([])
    // Non-vacuity: the race really did happen in that single view.
    expect(run.finalLap).toBe(1)
  })

  it('raises exactly the crossing when two views are alternated', () => {
    const run = runDoubleBuffer()
    expect(run.cues).toEqual(['lapCross:0'])
    expect(run.finalLap).toBe(1)
  })

  // Catches the tempting wrong fix: caching a view inside audio.ts so a
  // single-view caller "works". That makes the function stateful, so a repeated
  // call with the same pair would stop producing the same cues.
  it('retains nothing between calls', () => {
    const prev = quietView()
    const view = copyView(prev)
    view.karts[2].lap = 1
    const a = createAudioModel()
    const b = createAudioModel()
    buildAudioModel(prev, view, a)
    buildAudioModel(prev, view, a)
    buildAudioModel(prev, view, b)
    expect(heard(a)).toEqual(['lapCross:2'])
    expect(heard(b)).toEqual(heard(a))
    // and the argument objects are untouched
    expect(prev.karts[2].lap).toBe(0)
    expect(view.karts[2].lap).toBe(1)
  })
})

describe('nullAudioBackend', () => {
  it('implements all three methods and returns nothing', () => {
    const m = createAudioModel()
    expect(nullAudioBackend.apply(m)).toBeUndefined()
    expect(nullAudioBackend.setConfig({ masterGain: 0.5, enabled: false })).toBeUndefined()
    expect(nullAudioBackend.close()).toBeUndefined()
  })

  // The seam is one-way: a backend consumes the model and never writes back,
  // or the next frame's plan would depend on the last frame's output device.
  it('does not mutate the model it is handed', () => {
    const m = createAudioModel()
    m.engineGain = 0.4
    m.cueCount = 1
    m.cues[0].kind = 'boost'
    const before = JSON.stringify(m)
    nullAudioBackend.apply(m)
    nullAudioBackend.setConfig({ masterGain: 0, enabled: false })
    expect(JSON.stringify(m)).toBe(before)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/render/test/audio.test.ts`

Expected: FAIL — the module under test does not exist yet:

```
Error: Failed to load url ../src/audio (resolved id: /home/kasm-user/tapkart/packages/render/src/audio) in /home/kasm-user/tapkart/packages/render/test/audio.test.ts. Does the file exist?
```

- [ ] **Step 3: Write the implementation**

Create `packages/render/src/audio.ts`:

```ts
// PURE, plus one ADAPTER-SHAPED interface (AudioBackend) whose only Plan 3
// implementation is a no-op. No DOM, no Web Audio, no clock, no `three` (Q26).
import { MAX_KARTS, clamp } from '@tapkart/sim'
import type { KartView, RaceView } from './types'
import { countdownLabelFor } from './hud'

export type AudioCueKind =
  | 'engine'
  | 'skid'
  | 'impact'
  | 'itemPickup'
  | 'itemUse'
  | 'boost'
  | 'spinOut'
  | 'respawn'
  | 'lapCross'
  | 'countdownBeep'
  | 'finish'

export interface AudioCue {
  kind: AudioCueKind
  playerId: number
  intensity: number // 0..1
  pan: number // -1 (left) .. 1 (right), from the camera's right axis
}

export interface AudioModel {
  engineFreqHz: number // LOCAL kart only
  engineGain: number // 0..1
  skidGain: number // 0..1
  cues: AudioCue[] // fixed length MAX_AUDIO_CUES; only [0, cueCount) is live
  cueCount: number
}

export const MAX_AUDIO_CUES = 16

// Voice shaping. Module-private on purpose: these are Plan 5's to tune once
// something is audible, and none of them is part of this package's surface.
const ENGINE_IDLE_HZ = 60
const ENGINE_HZ_PER_MPS = 4.5
const ENGINE_IDLE_GAIN = 0.15
const ENGINE_GAIN_PER_MPS = 0.02
const SKID_GAIN_PER_MPS = 0.03
/** Metres over which a one-shot from another kart fades to silence. */
const CUE_FALLOFF_M = 60

const WEIGHT_LAP_CROSS = 1
const WEIGHT_ITEM_PICKUP = 0.6
const WEIGHT_ITEM_USE = 0.7
const WEIGHT_BOOST = 1
const WEIGHT_SPIN_OUT = 1
const WEIGHT_RESPAWN = 0.5
const WEIGHT_IMPACT = 1

export function createAudioModel(): AudioModel {
  const cues: AudioCue[] = []
  for (let i = 0; i < MAX_AUDIO_CUES; i++) {
    // 'engine' is the inert placeholder kind: it names a continuous voice and
    // is never emitted as a one-shot, so a dead slot cannot be mistaken for a
    // live cue even if a backend ignored cueCount.
    cues.push({ kind: 'engine', playerId: -1, intensity: 0, pan: 0 })
  }
  return { engineFreqHz: 0, engineGain: 0, skidGain: 0, cues, cueCount: 0 }
}

/** Appends one cue, or drops it when the fixed pool is full. Never grows. */
function emitCue(
  out: AudioModel,
  kind: AudioCueKind,
  playerId: number,
  intensity: number,
  pan: number,
): void {
  if (out.cueCount >= MAX_AUDIO_CUES) return
  const c = out.cues[out.cueCount]
  c.kind = kind
  c.playerId = playerId
  c.intensity = clamp(intensity, 0, 1)
  c.pan = clamp(pan, -1, 1)
  out.cueCount++
}

/** Direction cosine of `k` along the local kart's right axis, `(-sin h, 0, cos h)`. */
function panFor(local: KartView | null, k: KartView): number {
  if (local === null || local === k) return 0
  const dx = k.position.x - local.position.x
  const dz = k.position.z - local.position.z
  const d = Math.sqrt(dx * dx + dz * dz)
  if (d <= 0) return 0
  const rx = -Math.sin(local.heading)
  const rz = Math.cos(local.heading)
  return clamp((dx * rx + dz * rz) / d, -1, 1)
}

/** Linear plan-view falloff from the local kart. 1 with no local seat. */
function gainFor(local: KartView | null, k: KartView): number {
  if (local === null || local === k) return 1
  const dx = k.position.x - local.position.x
  const dz = k.position.z - local.position.z
  return clamp(1 - Math.sqrt(dx * dx + dz * dz) / CUE_FALLOFF_M, 0, 1)
}

/**
 * Derives continuous levels from `view` and one-shots from the delta between
 * `prev` and `view`. SOLE WRITER of every AudioModel field. Pure and
 * assertable: a test drives two views and asserts exactly which cues fire.
 * Cues beyond MAX_AUDIO_CUES in one frame are dropped, never grown.
 *
 * PRECONDITION: `prev` and `view` are the session's TWO RaceViews, alternated
 * per frame with the swap AFTER audio.apply. With one view, prev === view,
 * every delta is empty, and no cue can ever fire. This function retains no
 * reference to either argument - next frame, `view` comes back as `prev`.
 */
export function buildAudioModel(prev: RaceView, view: RaceView, out: AudioModel): void {
  const pid = view.localPlayerId
  const hasSeat = pid >= 0 && pid < MAX_KARTS
  const local = hasSeat ? view.karts[pid] : null

  // --- continuous levels: the LOCAL kart's engine and skid, and nothing else.
  if (local !== null && local.source !== 'absent') {
    out.engineFreqHz = ENGINE_IDLE_HZ + local.speed * ENGINE_HZ_PER_MPS
    out.engineGain =
      local.respawnTicks > 0
        ? 0
        : clamp(ENGINE_IDLE_GAIN + local.speed * ENGINE_GAIN_PER_MPS, 0, 1)
    out.skidGain =
      local.driftActive || local.spinOutTicks > 0
        ? clamp(local.speed * SKID_GAIN_PER_MPS, 0, 1)
        : 0
  } else {
    out.engineFreqHz = 0
    out.engineGain = 0
    out.skidGain = 0
  }

  // --- one-shots. Fixed emission order, so a busy frame drops deterministically.
  out.cueCount = 0

  const prevLabel = countdownLabelFor(
    prev.phase,
    prev.countdownTicksLeft,
    Math.max(0, prev.tick - prev.raceStartTick),
  )
  const label = countdownLabelFor(
    view.phase,
    view.countdownTicksLeft,
    Math.max(0, view.tick - view.raceStartTick),
  )
  if (label !== '' && label !== prevLabel) emitCue(out, 'countdownBeep', pid, 1, 0)
  if (prev.phase !== 'finished' && view.phase === 'finished') {
    emitCue(out, 'finish', pid, 1, 0)
  }

  for (let i = 0; i < MAX_KARTS; i++) {
    const a = prev.karts[i]
    const b = view.karts[i]
    // A seat absent in either view has stale fields, not news.
    if (a.source === 'absent' || b.source === 'absent') continue

    const pan = panFor(local, b)
    const g = gainFor(local, b)

    if (b.lap > a.lap) emitCue(out, 'lapCross', b.playerId, WEIGHT_LAP_CROSS * g, pan)
    if (a.item === 'none' && b.item !== 'none') {
      emitCue(out, 'itemPickup', b.playerId, WEIGHT_ITEM_PICKUP * g, pan)
    }
    if (a.item !== 'none' && b.item === 'none') {
      emitCue(out, 'itemUse', b.playerId, WEIGHT_ITEM_USE * g, pan)
    }
    if (b.boostTicks > a.boostTicks) emitCue(out, 'boost', b.playerId, WEIGHT_BOOST * g, pan)
    if (b.spinOutTicks > a.spinOutTicks) {
      emitCue(out, 'spinOut', b.playerId, WEIGHT_SPIN_OUT * g, pan)
    }
    if (b.respawnTicks > a.respawnTicks) {
      emitCue(out, 'respawn', b.playerId, WEIGHT_RESPAWN * g, pan)
    }
    // A popped shield is the only impact a RaceView witnesses: kart-kart
    // contact is not in the view at all.
    if (a.shielded && !b.shielded) emitCue(out, 'impact', b.playerId, WEIGHT_IMPACT * g, pan)
  }
}

/**
 * Device/user preference, NOT a property of the audio the race is producing.
 * R38: volume and mute must never be fields of AudioModel - a model that
 * carries a setting means moving a slider re-plans a frame.
 */
export interface AudioConfig {
  masterGain: number // 0..1
  enabled: boolean // false mutes without tearing the backend down
}

/** ADAPTER boundary. Plan 5 puts Web Audio behind this and touches nothing else. */
export interface AudioBackend {
  apply(model: AudioModel): void
  /** R38: the seam carries its config from day one, so a live settings change
   *  has somewhere to go and Plan 5 needs no widened concrete type and no
   *  amendment to the contract. Called on every Settings change, not per frame. */
  setConfig(cfg: AudioConfig): void
  close(): void
}

/**
 * The v1 backend. Implements all three methods trivially: Q26 defers audible
 * audio to Plan 5 and keeps the seam authored, because building a seam is hours
 * and retrofitting one is a refactor. The parameters are underscore-prefixed so
 * `noUnusedParameters` accepts a method that genuinely does nothing.
 */
export const nullAudioBackend: AudioBackend = {
  apply(_model: AudioModel): void {},
  setConfig(_cfg: AudioConfig): void {},
  close(): void {},
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/render/test/audio.test.ts`
Expected: PASS, 22 tests.

Run: `npm run typecheck --workspace @tapkart/render`
Expected: exit 0, no output.

- [ ] **Step 5: Commit**

```bash
git add packages/render/src/audio.ts packages/render/test/audio.test.ts && git commit -m "feat(render): pure AudioModel planner and the authored backend seam

Q26 keeps audio inaudible in Plan 3 and authors the seam: a pure model, an
AudioBackend carrying setConfig from day one so volume and mute stay device
preferences rather than fields of the model (R38), and a no-op backend Plan 5
replaces without touching anything else.

One-shots come from the delta between two RaceViews, so the session must hold
two and swap them after audio.apply - with a single view every delta is empty
and no cue can ever fire. The test drives both arrangements and asserts the
single-view one is silent while the race is provably happening in it."
```

---

### Task 15: `packages/render/src/smoothing.ts` — error smoothing (R41)

**This is a required part of the render layer, not a polish item, and the whole
netcode trade is dishonest without it.**

The measurement, from Plan 2 Task 15's review: `ClientLoop` converges to roughly
**one correction per 600 ticks under a held-steady intent**, but **about three
corrections per second under input that changes** — 29 under a sine, 39 under a
square wave. Changing input is all real driving. The reviewer attributed it
properly rather than guessing: it implemented the client-side fix (predicting
against the intent the authority is holding) and measured **no difference**, so it
is not a client defect. It falls out of spec §5's own rule that the authority
applies the newest intent it has **received** at its own tick rather than
buffering by stamped tick — and under jitter, *which* intent is newest at
authority-tick T is a fact about packet delivery that no client can predict.

The controller ruled that Tapkart keeps immediate application and **absorbs the
corrections in rendering**, because the alternative — a tick-buffered authority
with a playout delay — adds input latency to every control on a touchscreen
racer, where latency is the first thing a player feels. That ruling is only
honest if something actually absorbs them. The corrections are small: they fire
just past `EPS.position` (~5 cm) against roughly 33 cm of travel per tick at
speed, so they are entirely hideable — **but only if the kart is not snapped to
them.** Without this module the trade is just "the kart jumps three times a
second."

Two details a task author is likely to flatten, and this task does not:

- **Both position and heading are smoothed, on ONE eased fraction derived from
  ONE `ticksSince`.** Two smoothing rates on one object is how a kart ends up
  visually cornering out of phase with itself. Heading is included because it
  *dominates* error growth: 0.0024 rad of heading error at 20 m/s is 0.048 m/s of
  lateral drift, about three times what the velocity residual produces, and it
  crosses a lane in a second. An earlier draft dropped heading smoothing by
  mistaking `EPS.heading = 0.0025` — the threshold at which a heading correction
  *fires* — for a bound on the correction's *size*. It is not: past that
  threshold `resyncOwnKart` writes the authoritative heading whatever the
  divergence is. Contract §4.9a records that as a pull-quote; this task does not
  re-introduce the error.
- **`ERROR_SMOOTH_MAX_HEADING_RAD = 0.15` is derived, not chosen.** Easing an
  offset of `x` radians over the window has a peak apparent yaw rate at `t = 0`
  of `3x / (ERROR_SMOOTH_WINDOW_TICKS * TICK_DT)` = `15x` rad/s — the derivative
  of the cubic. The player reads any yaw the car produces on its own as steering,
  so the smoothing must stay under the car's own maximum steering rate,
  `TUNING.steerRateBase = 2.6` rad/s: `15 × 0.15 = 2.25` rad/s, comfortably
  under, and 0.15 rad is 8.6°, larger than any correction that is not a resync.
  §8.1 requires that bound to be asserted **against the shipped constants** rather
  than trusted from the comment, and Step 1 does exactly that.

The offset is render-only: it is added to `KartView.position` and
`KartView.heading` by `ViewBuilder` and to nothing else (§7.2). `session.state()`
stays exactly what `ClientLoop` reconciled, the next tick predicts from the
authoritative value, and the smoothing can therefore never feed back into the
simulation or into what the authority is told. It applies to the **local seat on a
guest only** — every other seat is interpolated, which has no corrections to hide,
and host/solo seats are authoritative.

**Files:**
- Create: `packages/render/src/smoothing.ts`
- Test: `packages/render/test/smoothing.test.ts`

**Do not touch `packages/render/src/index.ts`.** Task 16 owns the barrel and adds
`export * from './smoothing'` there, with the rest of §4.11's list, in one edit.

**Interfaces:**

- Consumes:
  - `@tapkart/sim` [Plan 1, shipped — read from `packages/sim/src/`]:
    ```ts
    export type Vec3 = { x: number; y: number; z: number }
    export const TICK_DT = 1 / 60
    export function clamp(v: number, lo: number, hi: number): number
    /** Wraps an angle into the half-open range (-PI, PI]. Upper-inclusive on
     *  purpose: a kart travelling along -x has heading Math.atan2(0, -1) === PI
     *  exactly, and it must stay at +PI rather than oscillating. */
    export function wrapAngle(a: number): number
    ```
  - `@tapkart/content` [the content tuning task, §3a.2] — used by the **test
    only**, never by `src/smoothing.ts`:
    ```ts
    /** The Tuning the game actually races with. Numerically identical to
     *  makeTuning(), asserted field-by-field in packages/content/test/. */
    export const TUNING: Readonly<Tuning>      // TUNING.steerRateBase === 2.6
    ```
  - `@tapkart/net` [Plan 2 Task 15b, §2.5] — quoted because it is the **source of
    this module's nullable**, not because this module imports it. It does not:
    ```ts
    /** R47, R48. The discontinuity the last reconciliation applied to the local
     *  kart: position delta in metres into `outPos`, heading delta in radians
     *  (shortest arc, wrapped to [-PI, PI]) as the return value. Returns null if
     *  the most recent tick() applied no correction. */
    export function correctionDeltaOf(client: ClientLoop, outPos: Vec3): number | null
    ```
    `RaceSession.correctionDelta(outPos: Vec3): number | null` (§5.10) delegates
    to it and computes nothing, and `ViewBuilder` (§5.11 step 11a) passes what it
    returns straight into `advanceVisualOffset` as `correctionHeading`. **`null`
    means no reconciliation happened; `0` means one happened and moved the heading
    by exactly zero.** Those are different answers and both are meaningful — a
    reconciliation that moved the heading by exactly zero still restarts the ease
    window — which is why this function takes `number | null` and there is no
    separate `corrected` boolean. The distinction is carried from its source and
    **must never be reconstructed at a higher layer.**

- Produces — the seven exports contract §4.9a pins (the census's `+7`):
  ```ts
  /** The retained visual error for ONE seat: metres for position, radians for
   *  heading. `current`/`currentHeading` are what the view adds to the drawn
   *  pose; `origin`/`originHeading` are the offset at the instant of the most
   *  recent correction, which is what the ease decays from. */
  export interface VisualOffset {
    origin: Vec3
    originHeading: number       // radians
    ticksSince: number          // ticks since the most recent correction
    current: Vec3               // the eased offset to ADD to the drawn position
    currentHeading: number      // radians, ADDED to the drawn heading
  }
  export function createVisualOffset(): VisualOffset
  export const ERROR_SMOOTH_WINDOW_TICKS = 12
  export const ERROR_SMOOTH_MAX_POSITION_M = 2.5
  export const ERROR_SMOOTH_MAX_HEADING_RAD = 0.15
  export function easeRemaining(t01: number): number
  export function advanceVisualOffset(prev: VisualOffset, correctionPos: Vec3,
                                      correctionHeading: number | null,
                                      ticksElapsed: number, out: VisualOffset): void
  ```
  `out` MAY alias `prev` — `ViewBuilder` calls it as
  `advanceVisualOffset(offset, scratchVec3, h, ticksElapsed, offset)` on its one
  pre-allocated offset, so aliasing is the normal case and not an edge case.

  `advanceVisualOffset`'s rule, verbatim from §4.9a:

  - `correctionHeading !== null` re-seeds:
    `out.origin = prev.current + correctionPos`,
    `out.originHeading = wrapAngle(prev.currentHeading + correctionHeading)`,
    `out.ticksSince = 0`
  - `null`: both origins carry over, `out.ticksSince = prev.ticksSince + ticksElapsed`
  - then `f = easeRemaining(out.ticksSince / ERROR_SMOOTH_WINDOW_TICKS)`,
    `out.current = out.origin * f` and `out.currentHeading = out.originHeading * f`
    — **ONE `f`**, so the two channels can never fall out of phase
  - and if `|out.origin| > ERROR_SMOOTH_MAX_POSITION_M` **or**
    `|out.originHeading| > ERROR_SMOOTH_MAX_HEADING_RAD`, every field is zeroed:
    either channel tripping its guard cuts **both**, because easing half a resync
    is worse than cutting all of it.
  - `correctionPos` is ignored when `correctionHeading` is null.
  - Deterministic and frame-rate independent: `ticksElapsed` is SIM TICKS, never
    frames.

---

- [ ] **Step 1: Write the failing test**

Create `packages/render/test/smoothing.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { TICK_DT, wrapAngle } from '@tapkart/sim'
import type { Vec3 } from '@tapkart/sim'
import { TUNING } from '@tapkart/content'

import {
  ERROR_SMOOTH_MAX_HEADING_RAD,
  ERROR_SMOOTH_MAX_POSITION_M,
  ERROR_SMOOTH_WINDOW_TICKS,
  advanceVisualOffset,
  createVisualOffset,
  easeRemaining,
} from '../src/smoothing'
import type { VisualOffset } from '../src/smoothing'

const ZERO: Vec3 = { x: 0, y: 0, z: 0 }

function v(x: number, y: number, z: number): Vec3 {
  return { x, y, z }
}

/** One correction of (pos, heading) arriving on this tick. */
function correct(o: VisualOffset, pos: Vec3, heading: number): void {
  advanceVisualOffset(o, pos, heading, 1, o)
}

/** `ticks` sim ticks with no reconciliation. */
function idle(o: VisualOffset, ticks: number): void {
  advanceVisualOffset(o, ZERO, null, ticks, o)
}

function snapshot(o: VisualOffset): VisualOffset {
  return {
    origin: { x: o.origin.x, y: o.origin.y, z: o.origin.z },
    originHeading: o.originHeading,
    ticksSince: o.ticksSince,
    current: { x: o.current.x, y: o.current.y, z: o.current.z },
    currentHeading: o.currentHeading,
  }
}

function isAllZero(o: VisualOffset): boolean {
  return o.origin.x === 0 && o.origin.y === 0 && o.origin.z === 0
    && o.originHeading === 0 && o.ticksSince === 0
    && o.current.x === 0 && o.current.y === 0 && o.current.z === 0
    && o.currentHeading === 0
}

describe('createVisualOffset', () => {
  it('starts at zero with distinct Vec3s', () => {
    const o = createVisualOffset()
    expect(isAllZero(o)).toBe(true)
    // Two fields sharing one Vec3 would make `current` track `origin` forever.
    expect(o.origin).not.toBe(o.current)
    const a = createVisualOffset()
    const b = createVisualOffset()
    expect(a.origin).not.toBe(b.origin)
  })
})

describe('easeRemaining', () => {
  it('is 1 at the start of the window and exactly 0 at its end', () => {
    expect(easeRemaining(0)).toBe(1)
    expect(easeRemaining(1)).toBe(0)
  })

  it('is the ease-out cubic, not a linear or quadratic falloff', () => {
    expect(easeRemaining(0.5)).toBe(0.125)          // linear: 0.5, quadratic: 0.25
    expect(easeRemaining(0.25)).toBe(0.421875)      // (1 - 0.25) ** 3
    expect(easeRemaining(0.75)).toBe(0.015625)
  })

  it('clamps outside [0, 1] instead of growing or going negative', () => {
    expect(easeRemaining(-5)).toBe(1)
    expect(easeRemaining(-0.0001)).toBe(1)
    expect(easeRemaining(3)).toBe(0)
    expect(easeRemaining(1e9)).toBe(0)
  })

  it('settles rather than arriving: its slope at the end of the window is zero', () => {
    const h = 1e-4
    const slope = (easeRemaining(1) - easeRemaining(1 - h)) / h
    expect(Math.abs(slope)).toBeLessThan(1e-6)      // cubic: ~1e-8, quadratic: ~1e-4
  })
})

describe('advanceVisualOffset — the correction tick', () => {
  it('applies the whole correction on the tick it arrives, in both channels', () => {
    const o = createVisualOffset()
    correct(o, v(0.05, 0, -0.02), 0.05)

    expect(o.ticksSince).toBe(0)
    expect(o.origin).toEqual({ x: 0.05, y: 0, z: -0.02 })
    expect(o.originHeading).toBe(0.05)
    // f = easeRemaining(0) = 1, so the drawn pose is exactly where it was before
    // the reconciliation moved it: the correction is invisible on its own tick.
    expect(o.current).toEqual({ x: 0.05, y: 0, z: -0.02 })
    expect(o.currentHeading).toBe(0.05)
  })

  it('adds a new correction to the error still on screen, not to the original one', () => {
    const o = createVisualOffset()
    correct(o, v(0.05, 0, 0), 0.05)
    idle(o, 6)
    expect(o.current.x).toBeCloseTo(0.00625, 12)    // 0.05 * easeRemaining(0.5)
    expect(o.currentHeading).toBeCloseTo(0.00625, 12)

    correct(o, v(0.02, 0, 0), 0.02)
    expect(o.origin.x).toBeCloseTo(0.02625, 12)     // prev.current + delta
    expect(o.originHeading).toBeCloseTo(0.02625, 12)
    expect(o.ticksSince).toBe(0)
  })

  it('wraps the re-seeded heading origin to the shortest arc', () => {
    const o = createVisualOffset()
    o.currentHeading = 6.2                          // synthetic prior, to reach the wrap
    correct(o, ZERO, 0.05)
    expect(o.originHeading).toBeCloseTo(wrapAngle(6.25), 12)
    expect(o.originHeading).toBeCloseTo(-0.0331853071795862, 12)
    expect(isAllZero(o)).toBe(false)
  })
})

describe('advanceVisualOffset — the ease', () => {
  it('reaches exactly zero after ERROR_SMOOTH_WINDOW_TICKS and stays there', () => {
    const o = createVisualOffset()
    correct(o, v(0.05, 0, 0.05), 0.05)
    idle(o, ERROR_SMOOTH_WINDOW_TICKS)

    expect(o.current.x).toBe(0)
    expect(o.current.z).toBe(0)
    expect(o.currentHeading).toBe(0)

    idle(o, 5)
    expect(o.current.x).toBe(0)
    expect(o.currentHeading).toBe(0)
  })

  it('decreases monotonically in both channels across the window', () => {
    const o = createVisualOffset()
    correct(o, v(0.05, 0, 0), 0.05)
    let lastPos = Math.abs(o.current.x)
    let lastHeading = Math.abs(o.currentHeading)
    for (let i = 0; i < ERROR_SMOOTH_WINDOW_TICKS; i++) {
      idle(o, 1)
      expect(Math.abs(o.current.x)).toBeLessThan(lastPos)
      expect(Math.abs(o.currentHeading)).toBeLessThan(lastHeading)
      lastPos = Math.abs(o.current.x)
      lastHeading = Math.abs(o.currentHeading)
    }
    expect(lastPos).toBe(0)
    expect(lastHeading).toBe(0)
  })

  it('drives both channels with ONE eased fraction, tick by tick', () => {
    const o = createVisualOffset()
    correct(o, v(0.4, 0, -0.3), 0.06)
    for (let i = 0; i < ERROR_SMOOTH_WINDOW_TICKS; i++) {
      idle(o, 1)
      const f = easeRemaining(o.ticksSince / ERROR_SMOOTH_WINDOW_TICKS)
      expect(o.current.x).toBe(o.origin.x * f)
      expect(o.current.z).toBe(o.origin.z * f)
      expect(o.currentHeading).toBe(o.originHeading * f)
    }
  })

  it('is frame-rate independent: N calls of one tick equal one call of N ticks', () => {
    const a = createVisualOffset()
    const b = createVisualOffset()
    correct(a, v(0.4, 0, -0.2), 0.06)
    correct(b, v(0.4, 0, -0.2), 0.06)
    for (let i = 0; i < 5; i++) idle(a, 1)
    idle(b, 5)
    expect(a).toEqual(b)
    expect(a.ticksSince).toBe(5)
  })

  it('changes nothing when ticksElapsed is 0', () => {
    const o = createVisualOffset()
    correct(o, v(0.05, 0, 0), 0.05)
    idle(o, 3)
    const before = snapshot(o)
    idle(o, 0)
    expect(o).toEqual(before)
  })

  it('writes a correct result when `out` aliases `prev`', () => {
    // ViewBuilder calls this as advanceVisualOffset(offset, ..., offset) on its
    // one pre-allocated offset, so aliasing is the shipped call shape.
    const steps: { pos: Vec3; heading: number | null; ticks: number }[] = [
      { pos: v(0.05, 0, 0), heading: 0.05, ticks: 1 },
      { pos: ZERO, heading: null, ticks: 4 },
      { pos: v(0.02, 0, -0.01), heading: 0.01, ticks: 1 },
      { pos: ZERO, heading: null, ticks: 2 },
    ]

    const aliased = createVisualOffset()
    for (const s of steps) advanceVisualOffset(aliased, s.pos, s.heading, s.ticks, aliased)

    // The same sequence with a fresh `out` every call, so no step can hide an
    // aliasing bug behind an identically-broken reference.
    let readFrom = createVisualOffset()
    for (const s of steps) {
      const writeTo = createVisualOffset()
      advanceVisualOffset(readFrom, s.pos, s.heading, s.ticks, writeTo)
      readFrom = writeTo
    }

    expect(aliased).toEqual(readFrom)
    expect(aliased.current.x).toBeGreaterThan(0)     // and the sequence is not all-zero
  })
})

describe('advanceVisualOffset — null is not zero', () => {
  it('restarts the window on a heading delta of exactly 0', () => {
    const o = createVisualOffset()
    correct(o, v(0.3, 0, 0), 0.04)
    idle(o, 6)
    const carried = { x: o.current.x, h: o.currentHeading }
    expect(o.ticksSince).toBe(6)

    advanceVisualOffset(o, ZERO, 0, 1, o)
    expect(o.ticksSince).toBe(0)
    expect(o.origin.x).toBeCloseTo(carried.x, 12)
    expect(o.originHeading).toBeCloseTo(carried.h, 12)
    expect(o.current.x).toBeCloseTo(carried.x, 12)     // f = 1 again
  })

  it('keeps decaying on null', () => {
    const o = createVisualOffset()
    correct(o, v(0.3, 0, 0), 0.04)
    idle(o, 6)
    const before = o.current.x

    advanceVisualOffset(o, ZERO, null, 1, o)
    expect(o.ticksSince).toBe(7)
    expect(o.current.x).toBeLessThan(before)
  })

  it('ignores correctionPos entirely when correctionHeading is null', () => {
    const o = createVisualOffset()
    correct(o, v(0.05, 0, 0), 0.05)
    const after = snapshot(o)

    // A caller whose outPos scratch still holds the previous delta must not be
    // able to inject it: `null` means nothing happened, whatever outPos says.
    advanceVisualOffset(o, v(99, 99, 99), null, 0, o)
    expect(o).toEqual(after)
  })
})

describe('advanceVisualOffset — the guards', () => {
  it('cuts BOTH channels when the position delta exceeds the position guard', () => {
    const o = createVisualOffset()
    correct(o, v(30, 0, 0), 0.01)
    expect(isAllZero(o)).toBe(true)
  })

  it('cuts BOTH channels when the heading delta exceeds the heading guard', () => {
    const o = createVisualOffset()
    correct(o, v(0.05, 0, 0), 0.5)
    expect(isAllZero(o)).toBe(true)
  })

  it('measures |origin| in three dimensions, not one axis', () => {
    const o = createVisualOffset()
    correct(o, v(2, 0, 2), 0.01)                  // hypot = 2.83 > 2.5
    expect(isAllZero(o)).toBe(true)
  })

  it('eases a correction that only just fits, rather than cutting it', () => {
    const o = createVisualOffset()
    correct(o, v(2.4, 0, 0), 0.14)
    expect(isAllZero(o)).toBe(false)
    expect(o.current.x).toBe(2.4)
    expect(o.currentHeading).toBe(0.14)
  })

  it('cuts an accumulated origin, not only a single large delta', () => {
    const o = createVisualOffset()
    correct(o, v(2.4, 0, 0), 0.1)
    correct(o, v(0.3, 0, 0), 0)                   // 2.7 m of retained error
    expect(isAllZero(o)).toBe(true)
  })
})

describe('the shipped constants', () => {
  it('smooths over 0.2 s at 60 Hz', () => {
    expect(ERROR_SMOOTH_WINDOW_TICKS).toBe(12)
    expect(ERROR_SMOOTH_WINDOW_TICKS * TICK_DT).toBeCloseTo(0.2, 12)
  })

  it('cuts rather than slides a hard resync', () => {
    expect(ERROR_SMOOTH_MAX_POSITION_M).toBe(2.5)
  })

  it('can never out-yaw the car\'s own steering', () => {
    expect(ERROR_SMOOTH_MAX_HEADING_RAD).toBe(0.15)

    // §4.9a's derivation, asserted against the shipped constants rather than
    // trusted from the comment: the peak apparent yaw rate at t = 0 is the
    // derivative of the ease cubic, 3x / (window seconds).
    const peakYawRate =
      (3 * ERROR_SMOOTH_MAX_HEADING_RAD) / (ERROR_SMOOTH_WINDOW_TICKS * TICK_DT)
    expect(peakYawRate).toBeCloseTo(2.25, 9)
    expect(peakYawRate).toBeLessThan(TUNING.steerRateBase)
    expect(TUNING.steerRateBase).toBe(2.6)
  })

  it('produces a measured yaw rate under steerRateBase at the guard bound', () => {
    // The discrete counterpart of the derivation above: run the largest offset
    // the guards admit through the real function and measure the fastest
    // per-tick heading change it actually draws.
    const o = createVisualOffset()
    correct(o, ZERO, ERROR_SMOOTH_MAX_HEADING_RAD)
    let previous = o.currentHeading
    let peak = 0
    for (let i = 0; i < ERROR_SMOOTH_WINDOW_TICKS; i++) {
      idle(o, 1)
      peak = Math.max(peak, Math.abs(o.currentHeading - previous) / TICK_DT)
      previous = o.currentHeading
    }
    expect(peak).toBeCloseTo(2.0677083333, 6)
    expect(peak).toBeLessThan(TUNING.steerRateBase)
  })
})
```

**What each test catches, and whether it would actually fail under that bug.**
Smoothing is unusually exposed to tests that cannot detect what they exist to
detect — "the offset got smaller" passes against a function that multiplies by
0.99 forever and never reaches zero — so every assertion above is paired with the
defect it is there for:

| Test | Bug it catches | Would it fail? |
|---|---|---|
| `reaches exactly zero after ERROR_SMOOTH_WINDOW_TICKS` | an asymptotic decay (`current *= 0.99`, or an ease with no clamp) that never lands, leaving the kart permanently offset from where the authority put it | Yes — `0.99 ** 12 * 0.05 = 0.0443`, and `toBe(0)` is exact. A "smaller than before" assertion would pass |
| `drives both channels with ONE eased fraction` | two independent rates, or a heading channel eased on its own `ticksSince` — the kart cornering out of phase with itself | Yes — it recomputes `f` from the *reported* `ticksSince` and requires `current === origin * f` exactly, in all three of x, z and heading |
| `applies the whole correction on the tick it arrives, in both channels` | dropping heading smoothing entirely (the §4.9a pull-quote error): `currentHeading` would be 0, not 0.05. Also catches applying the ease before re-seeding, which would return `0.05 * easeRemaining(1/12) = 0.03851` | Yes, in both cases, and it is the test that most directly pins heading in |
| `adds a new correction to the error still on screen` | re-seeding from `prev.origin` instead of `prev.current`, which double-counts the part already eased away and makes a *second* correction jump the kart further than the first | Yes — 0.02625 vs the bug's 0.07 |
| `wraps the re-seeded heading origin` | a missing `wrapAngle` on the re-seed | Yes, and it is the only case where it can be observed: a non-wrapping implementation gets 6.25, trips the heading guard, and returns all zeros, so `isAllZero(o)` is `false` only for the correct one |
| `cuts BOTH channels when the position/heading delta exceeds…` | a guard that zeroes only its own channel — easing half a resync, which §4.9a rules out explicitly | Yes — `isAllZero` checks all eight fields |
| `measures \|origin\| in three dimensions` | `Math.abs(origin.x) > MAX` or a plan-view hypot | Yes — 2 m on each of two axes is 2.83 m |
| `eases a correction that only just fits` | a guard written `>=`, or one applied to `current` after easing rather than to `origin` | Yes — 2.4/0.14 must survive intact |
| `cuts an accumulated origin` | applying the guard to the incoming delta rather than to the re-seeded origin: two small corrections that sum past the bound would slide 2.7 m | Yes |
| `restarts the window on a heading delta of exactly 0` / `keeps decaying on null` | collapsing `number \| null` into a falsy check (`if (correctionHeading)`), the single most likely defect in this module — it silently treats a real correction as "nothing happened" | Yes — `ticksSince` is 0 under the contract and 7 under the bug, and the pair asserts both directions |
| `ignores correctionPos entirely when correctionHeading is null` | reading the caller's scratch `Vec3` on a no-correction tick, which injects the *previous* correction again every tick | Yes — a 99 m delta would trip the position guard and zero everything |
| `N calls of one tick equal one call of N ticks` | decaying per *call* instead of per *tick*, which makes the smoothing frame-rate dependent — invisible at 60 Hz, twice as fast on a 120 Hz display | Yes — `ticksSince` would be 5 vs 1, and `current` differs by a factor of ~2 |
| `changes nothing when ticksElapsed is 0` | advancing on a frame that ran no sim tick (§5.11 step 11a: "a frame that runs zero ticks re-uses the offset unchanged") | Yes — `toEqual` over the whole struct |
| `writes a correct result when out aliases prev` | writing `out.current` (or `out.ticksSince`) before deriving the new origin from `prev.current`, which corrupts the result in exactly the call shape `ViewBuilder` uses | Yes — the aliased and non-aliased runs are compared field by field |
| `settles rather than arriving` | an ease-out *quadratic* or a linear ramp: the kart arrives with velocity, which reads as a small flick at the end of every correction | Yes — slope 1e-4 (quadratic) or 1 (linear) against a 1e-6 bound |
| `can never out-yaw the car's own steering` + `produces a measured yaw rate under steerRateBase` | raising `ERROR_SMOOTH_MAX_HEADING_RAD`, shortening the window, or steepening the ease until the smoother's own yaw reads to the player as the car steering itself. The second test measures the real per-tick output rather than re-deriving the formula, so it also catches an ease whose peak is not where the algebra assumes | Yes — the bound is asserted against the shipped `ERROR_SMOOTH_*` constants and the shipped `TUNING.steerRateBase`, not against literals |
| `starts at zero with distinct Vec3s` | `origin` and `current` sharing one object (a plausible "save an allocation" mistake), which makes the eased value overwrite the origin it is derived from | Yes — `not.toBe` is identity |

---

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/render/test/smoothing.test.ts`

Expected: FAIL — the module does not exist yet:

```
Error: Cannot find module '../src/smoothing' imported from '<repo>/packages/render/test/smoothing.test.ts'

Caused by: Error: Failed to load url ../src/smoothing (resolved id: ../src/smoothing) in <repo>/packages/render/test/smoothing.test.ts. Does the file exist?
```

(`<repo>` is the absolute path of this working copy.) `Test Files 1 failed (1)`,
`Tests no tests`.

---

- [ ] **Step 3: Write the implementation**

Create `packages/render/src/smoothing.ts`:

```ts
// Error smoothing for the corrections a guest's ClientLoop applies to the local
// kart (R41, R47, R48). Pure: no clock, no DOM, no allocation, no randomness.
//
// The netcode corrects the local kart about three times a second under changing
// input -- which is all real driving -- because the authority applies the newest
// intent it has RECEIVED at its own tick rather than buffering by stamped tick
// (spec §5). The controller ruled that Tapkart keeps immediate application, so
// that a touchscreen racer pays no input latency, and absorbs the corrections
// here instead. Without this module the trade is just "the kart jumps three
// times a second".
//
// The offset produced here is render-only. ViewBuilder adds it to KartView
// position and heading (§5.11 step 11a) and to nothing else: it is never written
// into a SimState, never applied to a remote seat -- those are interpolated and
// have no corrections to hide -- and never applied on host or solo, which never
// reconcile.
import { clamp, wrapAngle } from '@tapkart/sim'
import type { Vec3 } from '@tapkart/sim'

/**
 * The retained visual error for ONE seat: metres for position, radians for
 * heading. `current`/`currentHeading` are what the view adds to the drawn pose;
 * `origin`/`originHeading` are the offset at the instant of the most recent
 * correction, which is what the ease decays from.
 *
 * Both channels are smoothed, on ONE window and ONE curve -- two smoothing rates
 * on one object is how a kart ends up visually cornering out of phase with
 * itself.
 */
export interface VisualOffset {
  origin: Vec3
  originHeading: number       // radians
  ticksSince: number          // ticks since the most recent correction
  current: Vec3               // the eased offset to ADD to the drawn position
  currentHeading: number      // radians, ADDED to the drawn heading
}

/** Allocated ONCE per session, by createViewBuilder (§5.11). */
export function createVisualOffset(): VisualOffset {
  return {
    origin: { x: 0, y: 0, z: 0 },
    originHeading: 0,
    ticksSince: 0,
    current: { x: 0, y: 0, z: 0 },
    currentHeading: 0,
  }
}

/**
 * 0.2 s at 60 Hz. Long enough to hide 5 cm completely, short enough that a wrong
 * prediction is not still on screen when the next one lands (~3/s).
 */
export const ERROR_SMOOTH_WINDOW_TICKS = 12

/**
 * Beyond this the offset is ZEROED rather than eased: a hard resync
 * (ClientLoop.hardResync) can move a kart tens of metres, and sliding it there
 * smoothly is worse than a cut.
 */
export const ERROR_SMOOTH_MAX_POSITION_M = 2.5

/**
 * The yaw analogue of the position cut, and it is derived rather than picked.
 * Easing an offset of `x` radians over the window has a peak apparent yaw rate
 * at t = 0 of `3x / (ERROR_SMOOTH_WINDOW_TICKS * TICK_DT)` = `15x` rad/s (the
 * derivative of the cubic). The player reads any yaw the car produces on its own
 * as steering, so the smoothing must stay under the car's own maximum steering
 * rate, `TUNING.steerRateBase = 2.6` rad/s: 15 x 0.15 = 2.25 rad/s, comfortably
 * under, and 0.15 rad is 8.6 degrees -- larger than any correction that is not a
 * resync. Past it, cut.
 *
 * packages/render/test/smoothing.test.ts asserts the 2.25 < 2.6 bound against
 * the shipped constants rather than trusting this comment.
 */
export const ERROR_SMOOTH_MAX_HEADING_RAD = 0.15

/**
 * The fraction of the offset still applied `t01` of the way through the window:
 * `(1 - clamp(t01, 0, 1)) ** 3` -- ease-out cubic, zero slope at the end, so the
 * kart settles rather than arriving.
 */
export function easeRemaining(t01: number): number {
  const remaining = 1 - clamp(t01, 0, 1)
  return remaining * remaining * remaining
}

/**
 * (previous offset, correction delta, ticks elapsed) -> new offset. `out` MAY
 * alias `prev`, and in the shipped call it always does.
 *
 * `correctionHeading` is passed through UNCHANGED from `correctionDeltaOf` via
 * `RaceSession.correctionDelta` (§5.10): `null` means no reconciliation happened
 * this tick, and `0` means one happened and moved the heading by exactly zero.
 * Those are different, and the difference is carried from its source rather than
 * reconstructed here -- which is why there is no separate `corrected` flag.
 * `correctionPos` is ignored when `correctionHeading` is null.
 *
 * Deterministic and frame-rate independent: `ticksElapsed` is SIM TICKS, never
 * frames. Called once per tick per smoothed seat, from ViewBuilder (§5.11).
 */
export function advanceVisualOffset(
  prev: VisualOffset,
  correctionPos: Vec3,
  correctionHeading: number | null,
  ticksElapsed: number,
  out: VisualOffset,
): void {
  // Read every field of `prev` before writing anything: `out` may alias `prev`.
  const prevX = prev.current.x
  const prevY = prev.current.y
  const prevZ = prev.current.z
  const prevHeading = prev.currentHeading

  let originX: number
  let originY: number
  let originZ: number
  let originHeading: number
  let ticksSince: number

  if (correctionHeading !== null) {
    // A reconciliation landed this tick. The error the player can still see is
    // whatever had not eased away yet, plus the discontinuity just applied.
    originX = prevX + correctionPos.x
    originY = prevY + correctionPos.y
    originZ = prevZ + correctionPos.z
    originHeading = wrapAngle(prevHeading + correctionHeading)
    ticksSince = 0
  } else {
    originX = prev.origin.x
    originY = prev.origin.y
    originZ = prev.origin.z
    originHeading = prev.originHeading
    ticksSince = prev.ticksSince + ticksElapsed
  }

  // Either guard cuts BOTH channels: easing half a resync is worse than cutting
  // all of it.
  if (
    Math.hypot(originX, originY, originZ) > ERROR_SMOOTH_MAX_POSITION_M
    || Math.abs(originHeading) > ERROR_SMOOTH_MAX_HEADING_RAD
  ) {
    out.origin.x = 0
    out.origin.y = 0
    out.origin.z = 0
    out.originHeading = 0
    out.ticksSince = 0
    out.current.x = 0
    out.current.y = 0
    out.current.z = 0
    out.currentHeading = 0
    return
  }

  // ONE eased fraction from ONE ticksSince, so the two channels can never fall
  // out of phase.
  const f = easeRemaining(ticksSince / ERROR_SMOOTH_WINDOW_TICKS)

  out.origin.x = originX
  out.origin.y = originY
  out.origin.z = originZ
  out.originHeading = originHeading
  out.ticksSince = ticksSince
  out.current.x = originX * f
  out.current.y = originY * f
  out.current.z = originZ * f
  out.currentHeading = originHeading * f
}
```

---

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/render/test/smoothing.test.ts`

Expected: PASS, 26 tests.

Then confirm nothing else moved and the package still typechecks under the
strict base config (the test file is inside `include`, so `TUNING` and every
signature above is checked too):

```bash
npx tsc --noEmit -p packages/render/tsconfig.json
npx vitest run
```

Both must be clean before Step 5.

---

- [ ] **Step 5: Commit**

```bash
git add packages/render/src/smoothing.ts packages/render/test/smoothing.test.ts
git commit -m "feat(render): error smoothing for reconciliation corrections (R41)

ClientLoop corrects the local kart about three times a second under
changing input -- 29 corrections under a sine, 39 under a square wave,
against 1 per 600 ticks held steady. That is not a client defect: Plan 2
Task 15's review implemented the client-side fix and measured no
difference, because the authority applies the newest intent it has
RECEIVED at its own tick and no client can predict which one that is
under jitter. The controller kept immediate application, so a
touchscreen racer pays no input latency, and ruled that rendering
absorbs the corrections instead. This module is that absorption; without
it the ruling just means the kart jumps three times a second.

advanceVisualOffset re-seeds from the error still on screen
(prev.current + delta), not from the original one, and decays it on an
ease-out cubic that reaches exactly zero after 12 ticks -- 0.2 s -- so
the kart settles rather than arriving and never carries a residue into
the next correction.

Position and heading are smoothed on ONE eased fraction from ONE
ticksSince. Heading is in because it dominates error growth: 0.0024 rad
at 20 m/s is 0.048 m/s of lateral drift, about three times the velocity
residual's contribution. EPS.heading is the threshold at which a heading
correction fires, not a bound on its size.

ERROR_SMOOTH_MAX_HEADING_RAD = 0.15 is derived, not chosen: the ease
cubic's peak apparent yaw rate at t=0 is 3x/(12 * TICK_DT) = 15x rad/s,
and 15 x 0.15 = 2.25 rad/s stays under TUNING.steerRateBase = 2.6, so
the smoother can never out-yaw the car and read as the car steering
itself. The test asserts that bound against the shipped constants, and
also measures the real per-tick output (2.068 rad/s) rather than only
re-deriving the algebra. Either guard -- 2.5 m or 0.15 rad -- cuts both
channels, because easing half a resync is worse than cutting all of it.

correctionHeading is number | null, carried unchanged from net's
correctionDeltaOf: null means no reconciliation, 0 means one that moved
the heading by exactly zero, and a zero still restarts the ease window.
That distinction is never reconstructed a layer up.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 16: `src/backend.ts`, `src/three/renderer.ts` and the `render` barrel — the seam and the adapter

This task draws the line that the rest of `packages/render` is testable on the
wrong side of. `backend.ts` is an interface file that imports nothing but sibling
types, so a mock backend is a plain object literal and spec §8's "scene-graph
assertions against a mocked renderer" are made against `applyFrame`'s argument,
under `environment: 'node'`, with no canvas and no GPU. `three/renderer.ts` is the
**only** module in the repository that imports `three` and the only thing that
touches a Three.js scene graph (§7.2) — and the barrel deliberately does not
re-export it.

**That omission is load-bearing, not tidiness.** A barrel that re-exported
`three/renderer.ts` would pull `three` — and, transitively, a WebGL context — into
every headless test in the repository the moment anything imported
`@tapkart/render`, and the failure would surface as an unrelated suite breaking.
`verbatimModuleSyntax` does **not** save this: a value import of `three` survives
erasure. Even `import type { Scene } from 'three'` is banned outside `src/three/`
so a later refactor cannot quietly turn it into a value import. This task's barrel
test enforces both bans mechanically, over the transitive module graph, rather
than trusting the rule.

**Q10: Three.js is mandated and pinned at exactly `three@0.180.0`** — not a caret
range, not a hand-rolled WebGL renderer, and **there is no Canvas2D fallback
backend.** Spec §3 says "Three.js scene" and the spec is the binding authority.
The `RendererBackend` seam exists for **headless testability** (§8.2), not device
fallback: every device that can run this game has WebGL, and a second renderer is
a second thing to keep correct for no user.

**Verified before authoring: `three@0.180.0` ships no type declarations.** Its
published `package.json` has no `types`/`typings` field and no `types` condition
in its `exports` map, and its `build/` directory contains no `.d.ts` files
(checked against the registry tarball). §4.10 gives this task the decision and the
duty to report it: **`"@types/three": "0.180.0"` goes in `packages/render`'s
`devDependencies`**, and no other task touches it, so two tasks cannot disagree.

**Files:**
- Create: `packages/render/src/backend.ts`
- Create: `packages/render/src/three/renderer.ts`
- Modify: `packages/render/src/index.ts` — **replace the whole contents** with the
  §4.11 nine-module barrel below. The scaffold task created it and three later
  tasks appended one line each; that nine-module list is the contract's, so no
  earlier task's line is lost. It is a `Modify` and not a `Create` on purpose: an
  implementer who reads `Create` reaches for `Write`, and gets the right answer
  here only because the list happens to be a superset.
- Modify: `packages/render/package.json` — **replace the whole contents** with the
  literal in Step 3b. Diffed against the scaffold task's literal the only change is
  `+ "devDependencies": { "@types/three": "0.180.0" }`, alongside `dependencies.three`
  pinned exactly and the `"./three"` export entry, both of which that task already
  wrote. Stated as a whole-file replacement because that is what Step 3b does.
- Modify: `package-lock.json` — `npm install` side effect (Step 3b), declared
  because five tasks in this plan rewrite it
- Test: `packages/render/test/backend.test.ts`
- Test: `packages/render/test/barrel.test.ts`

**Interfaces:**

- Consumes:
  - `@tapkart/sim` [Plan 1, shipped]:
    ```ts
    export const MAX_KARTS = 8
    export const MAX_ENTITIES = 32
    export type Vec3 = { x: number; y: number; z: number }
    export type EntityKind = 'seeker' | 'bolt' | 'slick' | 'bubble' | 'surge' | 'charge'
    ```
  - `@tapkart/content` [§3a.3, §3a.4]:
    ```ts
    export type PaletteRGB = readonly [number, number, number]   // linear, 0..1
    export interface EdgeMarkerParams {
      spacing: number; height: number; offset: number
      colors: readonly [PaletteRGB, PaletteRGB]                  // alternating, colorIdx 0 and 1
    }
    export interface TrackTheme {
      trackId: string
      road: PaletteRGB; roadDirt: PaletteRGB; shoulder: PaletteRGB; wall: PaletteRGB
      ground: PaletteRGB
      sky: { top: PaletteRGB; bottom: PaletteRGB }
      fog: { color: PaletteRGB; near: number; far: number }      // metres; near < far
      sunDirection: Vec3                                         // normalised
      ambient: number                                            // 0..1
      edgeMarkers: EdgeMarkerParams
    }
    export const DEFAULT_TRACK_THEME: Readonly<TrackTheme>
    ```
  - `packages/render/src/mesh.ts` [§4.3, an earlier task]:
    ```ts
    export interface MeshData {
      positions: Float32Array      // xyz triples, metres, world space
      normals: Float32Array        // xyz triples, unit length
      uvs: Float32Array            // uv pairs
      colors: Float32Array         // rgb triples, linear 0..1
      indices: Uint32Array         // triangle list, CCW front-facing
    }
    export interface MarkerPlacement { s: number; position: Vec3; heading: number; width: number }
    export interface EdgeMarkerPlacement {
      s: number; position: Vec3; heading: number; side: -1 | 1; colorIdx: 0 | 1
    }
    export interface TrackScene {
      road: MeshData               // vertex colours ARE the palette: road, dirt,
      boostPads: MeshData          // shoulder, wall, pads and ramps are all baked
      ramps: MeshData              // in by buildTrackScene (§7.2's sole writer)
      checkpoints: MarkerPlacement[]
      edgeMarkers: EdgeMarkerPlacement[]
      itemBoxes: Vec3[]            // one per track.itemBoxes, SAME INDEX as
                                   // RenderFrame.itemBoxAlpha and ItemBoxView.boxIdx
      bounds: { min: Vec3; max: Vec3 }   // meshBounds(road) — the ground-plane extent (Q19)
    }
    export const ROAD_DECAL_LIFT = 0.02
    export function meshCounts(meshes: readonly MeshData[]): { vertices: number; triangles: number }
    ```
  - `packages/render/src/camera.ts` [§4.6] and `src/frame.ts` [§4.7]:
    ```ts
    export interface CameraState {
      position: Vec3; lookAt: Vec3; up: Vec3; fovDegrees: number
      mode: 'chase' | 'countdown' | 'results' | 'free'
    }
    export interface KartDraw {
      playerId: number; characterIdx: number; visible: boolean
      position: Vec3; heading: number; roll: number; wheelSpin: number; steerAngle: number
      bodyTint: PaletteRGB; alpha: number; driftSparkTier: number; boostFlame: number
      shieldVisible: boolean
    }
    export interface EntityDraw {
      entityId: number; kind: EntityKind; visible: boolean
      position: Vec3; heading: number; scale: number; tint: PaletteRGB; alpha: number
    }
    export interface RenderFrame {
      camera: CameraState
      karts: KartDraw[]            // length MAX_KARTS
      entities: EntityDraw[]       // length MAX_ENTITIES
      entityCount: number
      itemBoxAlpha: Float32Array
      screenFlash: number
      screenTintColor: PaletteRGB
      screenTintAmount: number
      sourceTick: number
    }
    /** Every field zeroed, every Vec3 distinct, sourceTick = 0, itemBoxAlpha filled with 1. */
    export function createRenderFrame(itemBoxCount: number): RenderFrame
    ```
  - The eight sibling modules the barrel re-exports alongside `backend`:
    `types`, `mesh`, `descriptors`, `camera`, `frame`, `hud`, `audio`,
    `smoothing` [Task 15].
  - `three@0.180.0` — value import, **only** inside `src/three/`.

- Produces:
  ```ts
  // src/backend.ts — PURE (interface only, imports nothing but sibling types)
  export interface RendererStats { drawCalls: number; vertices: number; triangles: number }

  export interface RendererBackend {
    /** Called once, after content load, before the first frame. */
    setScene(scene: TrackScene, theme: TrackTheme,
             kartMeshes: readonly MeshData[], characterMeshes: readonly MeshData[]): void
    /** Called once per animation frame with a fully-built RenderFrame. */
    applyFrame(frame: RenderFrame): void
    resize(widthPx: number, heightPx: number, devicePixelRatio: number): void
    stats(): RendererStats
    dispose(): void
  }

  // src/three/renderer.ts — ADAPTER. Not re-exported from the barrel (§8.2).
  export interface ThreeRendererOptions {
    antialias: boolean
    maxPixelRatio: number       // 2 by default; phones lie about theirs
    shadows: boolean            // false in v1
  }
  export const DEFAULT_THREE_OPTIONS: Readonly<ThreeRendererOptions>
  export function createThreeRenderer(canvas: HTMLCanvasElement,
                                      opts: ThreeRendererOptions): RendererBackend
  ```
  and `packages/render/src/index.ts`, re-exporting exactly `types`, `mesh`,
  `descriptors`, `camera`, `frame`, `hud`, `audio`, `smoothing`, `backend` —
  **not** `three/renderer`, and there is no `time` module (§4.1) and no `theme`
  module (§4.5).

  `@tapkart/render/three` is how `apps/web` reaches the adapter: the second
  `exports` entry keeps it available to the app that needs it while keeping it out
  of the headless barrel.

---

- [ ] **Step 1: Write the failing tests**

Create `packages/render/test/backend.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { DEFAULT_TRACK_THEME } from '@tapkart/content'
import type { TrackTheme } from '@tapkart/content'

import * as backendModule from '../src/backend'
import type { RendererBackend, RendererStats } from '../src/backend'
import { createRenderFrame } from '../src/frame'
import type { RenderFrame } from '../src/frame'
import type { MeshData, TrackScene } from '../src/mesh'

function emptyMesh(): MeshData {
  return {
    positions: new Float32Array(0),
    normals: new Float32Array(0),
    uvs: new Float32Array(0),
    colors: new Float32Array(0),
    indices: new Uint32Array(0),
  }
}

function triangleMesh(): MeshData {
  return {
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1]),
    normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]),
    uvs: new Float32Array([0, 0, 1, 0, 0, 1]),
    colors: new Float32Array([1, 1, 1, 1, 1, 1, 1, 1, 1]),
    indices: new Uint32Array([0, 1, 2]),
  }
}

function trackScene(): TrackScene {
  return {
    road: triangleMesh(),
    boostPads: emptyMesh(),
    ramps: emptyMesh(),
    checkpoints: [{ s: 0, position: { x: 0, y: 0, z: 0 }, heading: 0, width: 12 }],
    edgeMarkers: [
      { s: 0, position: { x: 0, y: 0, z: 6 }, heading: 0, side: 1, colorIdx: 0 },
      { s: 0.5, position: { x: 0, y: 0, z: -6 }, heading: 0, side: -1, colorIdx: 1 },
    ],
    itemBoxes: [
      { x: 2, y: 0.5, z: 0 },
      { x: -2, y: 0.5, z: 0 },
    ],
    bounds: { min: { x: -10, y: 0, z: -10 }, max: { x: 10, y: 1, z: 10 } },
  }
}

interface SceneCall {
  scene: TrackScene
  theme: TrackTheme
  karts: number
  characters: number
}

interface MockBackend extends RendererBackend {
  readonly frames: RenderFrame[]
  readonly scenes: SceneCall[]
  readonly resizes: [number, number, number][]
  readonly disposed: number
}

/** The mock spec §8 asks for: a plain object literal, no canvas, no GPU. */
function makeMockBackend(): MockBackend {
  const frames: RenderFrame[] = []
  const scenes: SceneCall[] = []
  const resizes: [number, number, number][] = []
  let disposed = 0

  const mock: MockBackend = {
    frames,
    scenes,
    resizes,
    get disposed(): number {
      return disposed
    },
    setScene(scene, theme, kartMeshes, characterMeshes) {
      scenes.push({ scene, theme, karts: kartMeshes.length, characters: characterMeshes.length })
    },
    applyFrame(frame) {
      frames.push(frame)
    },
    resize(widthPx, heightPx, devicePixelRatio) {
      resizes.push([widthPx, heightPx, devicePixelRatio])
    },
    stats(): RendererStats {
      return { drawCalls: scenes.length, vertices: frames.length, triangles: resizes.length }
    },
    dispose() {
      disposed++
    },
  }
  return mock
}

/** A stand-in for the shell's frame loop, typed to the seam and nothing else. */
function drivePresentation(backend: RendererBackend, frame: RenderFrame): RendererStats {
  backend.resize(800, 600, 3)
  backend.applyFrame(frame)
  return backend.stats()
}

describe('src/backend.ts — the seam', () => {
  it('has no runtime exports at all', () => {
    // backend.ts is interface-only, which is exactly why a headless test can
    // import the seam without importing a renderer (§8.2).
    expect(Object.keys(backendModule)).toEqual([])
  })

  it('is satisfied by a plain object literal, with no DOM and no GPU', () => {
    const mock = makeMockBackend()
    const frame = createRenderFrame(4)

    const stats = drivePresentation(mock, frame)

    expect(mock.resizes).toEqual([[800, 600, 3]])
    expect(mock.frames).toHaveLength(1)
    expect(stats).toEqual({ drawCalls: 0, vertices: 1, triangles: 1 })
  })

  it('hands the adapter the whole RenderFrame, so scene assertions read its argument', () => {
    const mock = makeMockBackend()
    const frame = createRenderFrame(2)
    frame.karts[3].visible = true
    frame.karts[3].position.x = 12.5
    frame.karts[3].heading = 1.25
    frame.entities[0].visible = true
    frame.entities[0].kind = 'bubble'
    frame.itemBoxAlpha[1] = 0.5

    mock.applyFrame(frame)

    // Spec §8's "scene-graph assertions against a mocked renderer" reduce to
    // this: everything the adapter could draw is readable off the argument.
    const received = mock.frames[0]
    expect(received).toBe(frame)
    expect(received.karts[3].position.x).toBe(12.5)
    expect(received.karts[3].heading).toBe(1.25)
    expect(received.entities[0].kind).toBe('bubble')
    expect(received.itemBoxAlpha[1]).toBe(0.5)
    expect(received.karts).toHaveLength(8)
  })

  it('takes the whole scene once, before the first frame', () => {
    const mock = makeMockBackend()
    const scene = trackScene()
    const theme: TrackTheme = DEFAULT_TRACK_THEME

    mock.setScene(scene, theme, [triangleMesh(), triangleMesh()], [triangleMesh()])

    expect(mock.scenes).toHaveLength(1)
    expect(mock.scenes[0].scene.road.indices).toHaveLength(3)
    expect(mock.scenes[0].scene.ramps.indices).toHaveLength(0)   // `neon-district` has none
    expect(mock.scenes[0].scene.edgeMarkers.map((m) => m.colorIdx)).toEqual([0, 1])
    expect(mock.scenes[0].theme.trackId).toBe(theme.trackId)
    expect(mock.scenes[0].karts).toBe(2)
    expect(mock.scenes[0].characters).toBe(1)
  })

  it('reports the three counters and disposes idempotently through the seam', () => {
    const mock = makeMockBackend()
    mock.dispose()
    mock.dispose()
    expect(mock.disposed).toBe(2)

    const stats: RendererStats = mock.stats()
    expect(Object.keys(stats).sort()).toEqual(['drawCalls', 'triangles', 'vertices'])
  })
})
```

Create `packages/render/test/barrel.test.ts`:

```ts
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import * as render from '../src/index'
import * as audio from '../src/audio'
import * as backend from '../src/backend'
import * as camera from '../src/camera'
import * as descriptors from '../src/descriptors'
import * as frame from '../src/frame'
import * as hud from '../src/hud'
import * as mesh from '../src/mesh'
import * as smoothing from '../src/smoothing'
import * as types from '../src/types'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG = resolve(HERE, '..')
const SRC = join(PKG, 'src')
const REPO = resolve(PKG, '..', '..')

/** §4.11, in order. `three/renderer` is deliberately absent. */
const BARREL_MODULES = [
  'types', 'mesh', 'descriptors', 'camera', 'frame', 'hud', 'audio', 'smoothing', 'backend',
] as const

const NAMESPACES: [string, object][] = [
  ['types', types], ['mesh', mesh], ['descriptors', descriptors], ['camera', camera],
  ['frame', frame], ['hud', hud], ['audio', audio], ['smoothing', smoothing],
  ['backend', backend],
]

/** `from 'three'`, `import('three')`, `require('three')`, and any subpath. */
const THREE_SPECIFIER =
  /(?:from\s*|import\s*\(\s*|require\s*\(\s*)['"]three(?:\/[^'"]*)?['"]/

const RELATIVE_SPECIFIER = /(?:from\s*|import\s*\(\s*)['"](\.[^'"]*)['"]/g

function tsFilesUnder(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...tsFilesUnder(full))
    else if (entry.endsWith('.ts')) out.push(full)
  }
  return out
}

function resolveRelative(fromFile: string, spec: string): string | null {
  const base = resolve(dirname(fromFile), spec)
  if (existsSync(`${base}.ts`)) return `${base}.ts`
  if (existsSync(join(base, 'index.ts'))) return join(base, 'index.ts')
  return null
}

/** Every file reachable from `entry` by following relative imports. */
function moduleGraph(entry: string): string[] {
  const seen = new Set<string>()
  const queue = [entry]
  while (queue.length > 0) {
    const file = queue.pop() as string
    if (seen.has(file)) continue
    seen.add(file)
    const text = readFileSync(file, 'utf8')
    for (const match of text.matchAll(RELATIVE_SPECIFIER)) {
      const target = resolveRelative(file, match[1])
      if (target !== null) queue.push(target)
    }
  }
  return [...seen]
}

describe('@tapkart/render barrel', () => {
  it('re-exports exactly the nine modules §4.11 names, each once', () => {
    const text = readFileSync(join(SRC, 'index.ts'), 'utf8')
    for (const name of BARREL_MODULES) {
      const line = `export * from './${name}'`
      expect(text, `barrel is missing ${line}`).toContain(line)
      expect(text.split(line).length - 1, `${line} appears more than once`).toBe(1)
    }

    const exported = [...text.matchAll(/export \* from '\.\/([^']+)'/g)].map((m) => m[1])
    expect(exported.sort()).toEqual([...BARREL_MODULES].sort())
  })

  it('lists every top-level module in src/ and treats src/three as not a module', () => {
    const onDisk = readdirSync(SRC)
      .filter((f) => f.endsWith('.ts') && f !== 'index.ts')
      .map((f) => f.slice(0, -3))
      .sort()
    expect(onDisk).toEqual([...BARREL_MODULES].sort())

    // The adapter lives in its own directory precisely so it is never one of the
    // files the rule above sweeps up.
    expect(statSync(join(SRC, 'three')).isDirectory()).toBe(true)
    expect(existsSync(join(SRC, 'three', 'renderer.ts'))).toBe(true)
  })

  it('does not re-export the Three.js adapter', () => {
    expect(Object.prototype.hasOwnProperty.call(render, 'createThreeRenderer')).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(render, 'DEFAULT_THREE_OPTIONS')).toBe(false)
    // Statements, not prose: the barrel's comment explains why `three` is absent,
    // so a bare substring check would fail on its own documentation.
    const text = readFileSync(join(SRC, 'index.ts'), 'utf8')
    expect(text).not.toMatch(/export \* from '\.\/three/)
    expect(THREE_SPECIFIER.test(text)).toBe(false)
  })

  it('never reaches src/three or `three` from the barrel, transitively', () => {
    // The whole "rendering is testable headlessly" claim is this assertion: if
    // the barrel's module graph ever touched the adapter, `import { buildRenderFrame }
    // from '@tapkart/render'` would drag three -- and a WebGL context -- into
    // every vitest run in the repository, and it would surface as an unrelated
    // suite breaking.
    const graph = moduleGraph(join(SRC, 'index.ts'))
    expect(graph.length).toBeGreaterThan(BARREL_MODULES.length)   // the scan really walked
    for (const file of graph) {
      const rel = relative(PKG, file)
      expect(relative(SRC, file).startsWith('three'), `${rel} is the adapter`).toBe(false)
      expect(THREE_SPECIFIER.test(readFileSync(file, 'utf8')), `${rel} imports three`).toBe(false)
    }
  })

  it('confines every `three` import to src/three/, including type-only ones', () => {
    // `verbatimModuleSyntax` does not save this: `import type { Scene } from
    // 'three'` outside src/three/ is one refactor away from becoming a value
    // import, so it is banned outright (§8.2).
    for (const file of tsFilesUnder(SRC)) {
      if (relative(SRC, file).startsWith('three')) continue
      const importsThree = THREE_SPECIFIER.test(readFileSync(file, 'utf8'))
      expect(importsThree, `${relative(PKG, file)} must not import three`).toBe(false)
    }
    // ...and the one file that may, does — otherwise the sweep above proves
    // nothing but that the adapter was deleted.
    expect(THREE_SPECIFIER.test(readFileSync(join(SRC, 'three', 'renderer.ts'), 'utf8'))).toBe(true)
  })

  it('keeps `three` out of every test file in the repository', () => {
    // §8.2: "CI never imports any of them." A test that imported the adapter --
    // in any package -- would need a GPU, which is out of scope for Plan 3 (§8.3).
    const packagesDir = join(REPO, 'packages')
    const roots = readdirSync(packagesDir)
      .map((p) => join(packagesDir, p, 'test'))
      .filter((p) => existsSync(p))
    if (existsSync(join(REPO, 'apps'))) {
      for (const app of readdirSync(join(REPO, 'apps'))) {
        const dir = join(REPO, 'apps', app, 'test')
        if (existsSync(dir)) roots.push(dir)
      }
    }
    expect(roots.length).toBeGreaterThan(0)

    // Assembled rather than written literally, so this file does not report
    // itself: a needle spelled out here would appear in every text it scans.
    const adapterSubpath = ['@tapkart', 'render', 'three'].join('/')
    const adapterPath = ['src', 'three', ''].join('/')

    for (const root of roots) {
      for (const file of tsFilesUnder(root)) {
        const text = readFileSync(file, 'utf8')
        const rel = relative(REPO, file)
        expect(THREE_SPECIFIER.test(text), `${rel} imports three`).toBe(false)
        expect(text.includes(adapterSubpath), `${rel} imports the adapter`).toBe(false)
        expect(text.includes(adapterPath), `${rel} imports the adapter`).toBe(false)
      }
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
    // An ambiguous name is silently dropped from an ESM namespace and becomes a
    // SyntaxError at the import site, so it must not exist in the first place.
    expect(Array.from(owners.entries()).filter(([, mods]) => mods.length > 1)).toEqual([])

    for (const [mod, ns] of NAMESPACES) {
      for (const key of Object.keys(ns)) {
        expect(
          Object.prototype.hasOwnProperty.call(render, key),
          `${mod}.${key} is not reachable through the barrel`,
        ).toBe(true)
      }
    }
  })

  it('reaches Task 15\'s smoothing through the barrel', () => {
    expect(render.advanceVisualOffset).toBe(smoothing.advanceVisualOffset)
    expect(render.ERROR_SMOOTH_WINDOW_TICKS).toBe(12)
  })
})

describe('packages/render/package.json', () => {
  const pkg = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8')) as {
    name: string
    exports: Record<string, string>
    dependencies: Record<string, string>
    devDependencies?: Record<string, string>
  }

  it('pins three exactly, with no caret (Q10)', () => {
    expect(pkg.dependencies.three).toBe('0.180.0')
  })

  it('keeps the adapter reachable to the app and out of the barrel', () => {
    expect(pkg.name).toBe('@tapkart/render')
    expect(pkg.exports['.']).toBe('./src/index.ts')
    expect(pkg.exports['./three']).toBe('./src/three/renderer.ts')
  })

  it('declares the type declarations three does not ship', () => {
    // three@0.180.0 has no `types` field, no `types` condition in its exports
    // map and no .d.ts in build/, so tsc cannot typecheck the adapter without
    // this. §4.10 makes it this task's call and this task's report.
    expect(pkg.devDependencies?.['@types/three']).toBe('0.180.0')
  })
})
```

**What each test catches, and whether it would actually fail under that bug.**

| Test | Bug it catches | Would it fail? |
|---|---|---|
| `has no runtime exports at all` | `backend.ts` acquiring an implementation — a default backend, a helper, a constant — which would make the seam file itself something a test drags in | Yes — `Object.keys` on the namespace is `[]` only for a types-only module |
| `is satisfied by a plain object literal` / `hands the adapter the whole RenderFrame` | a seam whose methods a plain literal cannot implement (an abstract class, a required base), or one that hands the adapter something less than the frame — either would force jsdom or a canvas into the suite, which Q30 forbids | Yes — the mock is a literal, the assertions read the frame's fields, and the file would not compile if the shape were unimplementable |
| `takes the whole scene once, before the first frame` | `setScene` losing an argument (themes, or one of the two mesh arrays) in a later edit; also pins that a `TrackScene` with **zero-length ramps** is a legal argument rather than an error (`neon-district` has no ramps) | Yes — arity and content are asserted |
| `re-exports exactly the nine modules` | a barrel that grew a tenth module, lost `smoothing` (Task 15's, which no other task re-exports), or listed one twice | Yes — the extracted list is compared as a set |
| `lists every top-level module in src/` | a new `src/*.ts` that nobody re-exported, and the reverse: a barrel line pointing at a deleted file | Yes |
| `does not re-export the Three.js adapter` | the single failure this whole seam exists to prevent, in its most direct form | Yes — both by namespace key and by barrel text |
| `never reaches src/three or three, transitively` | the *indirect* form, which is the one that actually happens: `frame.ts` (or any module the barrel re-exports) importing a helper that imports `three`. A test that only checked `index.ts` would pass while every headless suite in the repo broke | Yes — it walks relative imports from `index.ts` and reads every file it lands on; the `graph.length` assertion stops a broken walker from vacuously passing |
| `confines every three import to src/three/` | `import type { Scene } from 'three'` in `mesh.ts` or `frame.ts` — legal today, a value import after one refactor, and invisible to `verbatimModuleSyntax` | Yes — the regex matches type-only imports too, since they are still `from 'three'` |
| `keeps three out of every test file` | a later task writing a test that imports the adapter, which needs a GPU and is out of scope for Plan 3 (§8.3) | Yes, repo-wide, and `roots.length > 0` keeps it from passing vacuously if the directory walk finds nothing |
| `has no ambiguous re-export` | two modules exporting the same name: ESM silently drops it from the namespace and the import site becomes a SyntaxError | Yes — same construction as `packages/sim/test/barrel.test.ts` |
| `pins three exactly, with no caret` | `^0.180.0`, which Q10 forbids: three's minor releases are breaking, and a caret means a different renderer on a different machine | Yes — string equality |
| `declares the type declarations three does not ship` | dropping `@types/three`, after which `npm run typecheck` fails on the adapter with `TS7016`/`TS2307` and the next task inherits it | Yes |

---

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/render/test/backend.test.ts`

Expected: FAIL — `src/backend.ts` does not exist:

```
Error: Cannot find module '../src/backend' imported from '<repo>/packages/render/test/backend.test.ts'

Caused by: Error: Failed to load url ../src/backend (resolved id: ../src/backend) in <repo>/packages/render/test/backend.test.ts. Does the file exist?
```

(`<repo>` is the absolute path of this working copy.) `Test Files 1 failed (1)`,
`Tests no tests`.

Run: `npx vitest run packages/render/test/barrel.test.ts`

Expected: FAIL, with one of two failures, depending on what earlier tasks left in
`packages/render/src/index.ts`:

- if the file exists but predates `smoothing` and `backend` (the expected case —
  Task 15 deliberately does not touch the barrel):
  ```
  AssertionError: barrel is missing export * from './smoothing': expected '…' to contain "export * from './smoothing'"
  ```
- if the file does not exist at all:
  ```
  Error: Cannot find module '../src/index' imported from '<repo>/packages/render/test/barrel.test.ts'
  ```

Either way the suite must be red before Step 3. Do not proceed on a green
barrel test — a green one here means the barrel already re-exports something this
task has not written yet.

---

- [ ] **Step 3: Write the implementation**

**3a.** Create `packages/render/src/backend.ts`:

```ts
// The renderer seam. This file imports nothing but sibling types on purpose: it
// is what makes `packages/render` assertable under `environment: 'node'` with no
// canvas, no GPU and no DOM (§8.2). A mock backend is a plain object literal, and
// spec §8's scene-graph assertions are made against `applyFrame`'s argument.
//
// It exists for headless testability, NOT for device fallback: Q10 mandates
// Three.js and there is no Canvas2D backend. Every device that can run this game
// has WebGL, and a second renderer is a second thing to keep correct for no user.
import type { RenderFrame } from './frame'
import type { MeshData, TrackScene } from './mesh'
import type { TrackTheme } from '@tapkart/content'

export interface RendererStats {
  drawCalls: number
  vertices: number
  triangles: number
}

export interface RendererBackend {
  /** Called once, after content load, before the first frame. */
  setScene(scene: TrackScene, theme: TrackTheme,
           kartMeshes: readonly MeshData[], characterMeshes: readonly MeshData[]): void
  /** Called once per animation frame with a fully-built RenderFrame. */
  applyFrame(frame: RenderFrame): void
  resize(widthPx: number, heightPx: number, devicePixelRatio: number): void
  stats(): RendererStats
  dispose(): void
}
```

**3b.** Modify `packages/render/package.json` so it reads exactly:

```json
{
  "name": "@tapkart/render",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./three": "./src/three/renderer.ts"
  },
  "dependencies": {
    "@tapkart/sim": "*",
    "@tapkart/content": "*",
    "three": "0.180.0"
  },
  "devDependencies": {
    "@types/three": "0.180.0"
  },
  "scripts": {
    "typecheck": "tsc --noEmit -p tsconfig.json"
  }
}
```

Then install, from the repository root:

```bash
npm install
```

`three` is pinned **exactly** — no caret (Q10). `@types/three` is a
devDependency, not a dependency, because it is erased at build time; it is here
because the published `three@0.180.0` ships no declarations of its own, which
§4.10 makes this task's call to make and to report.

**3c.** Create `packages/render/src/three/renderer.ts`:

```ts
// ADAPTER (§8.2). The ONLY module in the repository that imports `three`, and the
// only thing that touches a Three.js scene graph (§7.2). CI never imports this
// file: src/index.ts deliberately does not re-export it, so a headless vitest run
// never pulls three -- or, transitively, a WebGL context -- into the process.
//
// Everything here is owner-verified, not CI-verified (§8.3): CI proves the
// RenderFrame is right and that this adapter was handed it. It cannot prove
// Three.js drew it, that the shader compiled, or that the kart is not inside the
// road.
import {
  AmbientLight,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  DirectionalLight,
  Euler,
  Fog,
  Group,
  InstancedMesh,
  LinearSRGBColorSpace,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  OrthographicCamera,
  PerspectiveCamera,
  PlaneGeometry,
  Quaternion,
  SRGBColorSpace,
  Scene,
  SphereGeometry,
  Vector3,
  WebGLRenderer,
} from 'three'

import { MAX_ENTITIES, MAX_KARTS } from '@tapkart/sim'
import type { Vec3 } from '@tapkart/sim'
import type { PaletteRGB, TrackTheme } from '@tapkart/content'

import type { RendererBackend, RendererStats } from '../backend'
import type { KartDraw, RenderFrame } from '../frame'
import { ROAD_DECAL_LIFT, meshCounts } from '../mesh'
import type { EdgeMarkerPlacement, MarkerPlacement, MeshData, TrackScene } from '../mesh'

export interface ThreeRendererOptions {
  antialias: boolean
  maxPixelRatio: number       // 2 by default; phones lie about theirs
  shadows: boolean            // false in v1
}

export const DEFAULT_THREE_OPTIONS: Readonly<ThreeRendererOptions> = Object.freeze({
  antialias: true,
  maxPixelRatio: 2,
  shadows: false,
})

const SHIELD_SCALE = 1.6
const ENTITY_SPHERE_SEGMENTS = 10
const MARKER_POST_THICKNESS = 0.18
const ITEM_BOX_SIZE = 1.4
const ITEM_BOX_COLOR = 0xffd24a
/** The ground quad is `scene.bounds` widened by this factor, so the plane reaches
 *  past the ribbon to the fog rather than ending in mid-air at the road's edge. */
const GROUND_MARGIN = 3
/** …and sits this far under the lowest road vertex, so it never z-fights the ribbon. */
const GROUND_DROP = 0.05
const CHECKPOINT_BAR_LENGTH = 0.6
const CHECKPOINT_BAR_HEIGHT = 0.04

function setColor(target: Color, rgb: PaletteRGB): void {
  target.setRGB(rgb[0], rgb[1], rgb[2], LinearSRGBColorSpace)
}

function toGeometry(data: MeshData): BufferGeometry {
  const geo = new BufferGeometry()
  geo.setAttribute('position', new BufferAttribute(data.positions, 3))
  if (data.normals.length > 0) geo.setAttribute('normal', new BufferAttribute(data.normals, 3))
  if (data.uvs.length > 0) geo.setAttribute('uv', new BufferAttribute(data.uvs, 2))
  if (data.colors.length > 0) geo.setAttribute('color', new BufferAttribute(data.colors, 3))
  geo.setIndex(new BufferAttribute(data.indices, 1))
  geo.computeBoundingSphere()
  return geo
}

export function createThreeRenderer(
  canvas: HTMLCanvasElement,
  opts: ThreeRendererOptions,
): RendererBackend {
  const renderer = new WebGLRenderer({ canvas, antialias: opts.antialias })
  renderer.outputColorSpace = SRGBColorSpace
  renderer.shadowMap.enabled = opts.shadows
  renderer.autoClear = false

  const scene = new Scene()
  const camera = new PerspectiveCamera(62, 1, 0.3, 900)
  const ambient = new AmbientLight(0xffffff, 0.6)
  const sun = new DirectionalLight(0xffffff, 1.1)
  scene.add(ambient)
  scene.add(sun)

  const staticRoot = new Group()
  scene.add(staticRoot)

  // The ground plane. §12 fixes the whole visual budget as "a ribbon over a themed
  // ground plane plus procedural edge markers", and Q19 makes `TrackScene.bounds` a
  // render extent for exactly this — ground-plane size, camera far clamp, skybox
  // scale. Without it the ribbon floats over the sky's bottom colour, Q20's speed cue
  // is half-delivered, and six themes are gated on a `theme.ground` nothing draws.
  // One quad, allocated once, resized and recoloured per track in setScene.
  const groundGeometry = new PlaneGeometry(1, 1)
  const groundMaterial = new MeshLambertMaterial()
  const ground = new Mesh(groundGeometry, groundMaterial)
  ground.rotation.x = -Math.PI / 2   // PlaneGeometry is XY; local +y becomes world +z
  scene.add(ground)

  // The screen tint (surge) and flash (charge) are a second, orthographic pass
  // rather than a post-processing chain: two quads cost one draw call each and no
  // render target on a phone.
  const overlayScene = new Scene()
  const overlayCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1)
  const overlayGeometry = new PlaneGeometry(2, 2)
  const tintMaterial = new MeshBasicMaterial({
    transparent: true, depthTest: false, depthWrite: false, opacity: 0,
  })
  const flashMaterial = new MeshBasicMaterial({
    color: 0xffffff, transparent: true, depthTest: false, depthWrite: false, opacity: 0,
  })
  const tintQuad = new Mesh(overlayGeometry, tintMaterial)
  const flashQuad = new Mesh(overlayGeometry, flashMaterial)
  tintQuad.visible = false
  flashQuad.visible = false
  overlayScene.add(tintQuad)
  overlayScene.add(flashQuad)

  // Per-seat scene graph, allocated once (§7.3): the outer group carries position
  // and yaw, the inner group carries roll about the kart's own forward axis.
  const kartGeometries: BufferGeometry[] = []
  const characterGeometries: BufferGeometry[] = []
  const kartRoots: Group[] = []
  const kartTilts: Group[] = []
  const kartBodies: Mesh<BufferGeometry, MeshLambertMaterial>[] = []
  const kartHeads: Mesh<BufferGeometry, MeshLambertMaterial>[] = []
  const kartShields: Mesh<BufferGeometry, MeshBasicMaterial>[] = []
  const entityMeshes: Mesh<BufferGeometry, MeshLambertMaterial>[] = []

  const shieldGeometry = new SphereGeometry(1, 12, 8)
  const entityGeometry = new SphereGeometry(0.5, ENTITY_SPHERE_SEGMENTS, ENTITY_SPHERE_SEGMENTS)

  // Item boxes. `TrackScene.itemBoxes[i]` and `RenderFrame.itemBoxAlpha[i]` are the
  // same box (§4.3), so this array is index-paired with both. Q29's ghosting is
  // per-box opacity and a per-instance opacity needs a custom shader, so each box is
  // its own Mesh over one shared geometry — 16 to 24 per shipped track, which is the
  // entire cost of the pickup the item system is built on being visible.
  const itemBoxGeometry = new BoxGeometry(ITEM_BOX_SIZE, ITEM_BOX_SIZE, ITEM_BOX_SIZE)
  const itemBoxMeshes: Mesh<BufferGeometry, MeshBasicMaterial>[] = []

  for (let i = 0; i < MAX_KARTS; i++) {
    const root = new Group()
    const tilt = new Group()
    const body = new Mesh(new BufferGeometry(), new MeshLambertMaterial({ transparent: true }))
    const head = new Mesh(new BufferGeometry(), new MeshLambertMaterial({ transparent: true }))
    const shield = new Mesh(shieldGeometry, new MeshBasicMaterial({
      color: 0x66ccff, transparent: true, opacity: 0.25, depthWrite: false,
    }))
    shield.scale.setScalar(SHIELD_SCALE)
    shield.visible = false
    tilt.add(body)
    tilt.add(head)
    tilt.add(shield)
    root.add(tilt)
    root.visible = false
    scene.add(root)
    kartRoots.push(root)
    kartTilts.push(tilt)
    kartBodies.push(body)
    kartHeads.push(head)
    kartShields.push(shield)
  }

  for (let i = 0; i < MAX_ENTITIES; i++) {
    const mesh = new Mesh(entityGeometry, new MeshLambertMaterial({ transparent: true }))
    mesh.visible = false
    scene.add(mesh)
    entityMeshes.push(mesh)
  }

  const ownedGeometries: BufferGeometry[] = [
    shieldGeometry, entityGeometry, overlayGeometry, groundGeometry, itemBoxGeometry,
  ]
  const ownedMaterials: (MeshBasicMaterial | MeshLambertMaterial)[] = [
    tintMaterial, flashMaterial, groundMaterial,
  ]
  for (const m of kartBodies) ownedMaterials.push(m.material)
  for (const m of kartHeads) ownedMaterials.push(m.material)
  for (const m of kartShields) ownedMaterials.push(m.material)
  for (const m of entityMeshes) ownedMaterials.push(m.material)

  const scratchColor = new Color()
  const scratchVector = new Vector3()
  const scratchQuat = new Quaternion()
  const scratchEuler = new Euler(0, 0, 0, 'YXZ')
  const scratchScale = new Vector3(1, 1, 1)
  const scratchMatrix = new Matrix4()

  const ownedStaticGeometries: BufferGeometry[] = []
  const ownedStaticMaterials: (MeshBasicMaterial | MeshLambertMaterial)[] = []

  let sceneVertices = 0
  let sceneTriangles = 0
  let disposed = false

  function clearStatic(): void {
    for (const child of staticRoot.children.slice()) staticRoot.remove(child)
    for (const geo of ownedStaticGeometries) geo.dispose()
    for (const mat of ownedStaticMaterials) mat.dispose()
    ownedStaticGeometries.length = 0
    ownedStaticMaterials.length = 0
    itemBoxMeshes.length = 0      // their materials are in ownedStaticMaterials
  }

  /**
   * No colour argument, and that is the point. `buildTrackScene` bakes the theme into
   * every surface's vertex colours — road, dirt, shoulder, wall, boost pads and ramps
   * — and §7.2 makes it the sole writer of track colour. A material colour here would
   * be a second palette: `vertexColors: true` MULTIPLIES `material.color` by the
   * vertex colour, so setting both ships the road at `theme.road` squared, which turns
   * a 0.18 grey into a near-black 0.032. White is the multiplicative identity. It also
   * means a surface added later cannot be forgotten by the colouring pass, because
   * there is only one.
   */
  function addSurface(data: MeshData): void {
    if (data.indices.length === 0) return      // `neon-district` has no ramps (§4.3)
    const geo = toGeometry(data)
    const mat = new MeshLambertMaterial({ vertexColors: data.colors.length > 0 })
    // left at its default 0xffffff; §0a forbids this file from making colour decisions
    ownedStaticGeometries.push(geo)
    ownedStaticMaterials.push(mat)
    staticRoot.add(new Mesh(geo, mat))
  }

  /** One Mesh per box, materials owned by `ownedStaticMaterials` so `clearStatic`
   *  disposes them with the rest of the track. Positions are static track furniture;
   *  only opacity moves, and it moves in `applyFrame`. */
  function addItemBoxes(positions: readonly Vec3[]): void {
    for (const p of positions) {
      const mat = new MeshBasicMaterial({ color: ITEM_BOX_COLOR, transparent: true, opacity: 1 })
      const box = new Mesh(itemBoxGeometry, mat)
      box.position.set(p.x, p.y + ITEM_BOX_SIZE / 2, p.z)
      ownedStaticMaterials.push(mat)
      staticRoot.add(box)
      itemBoxMeshes.push(box)
    }
  }

  function addEdgeMarkers(posts: readonly EdgeMarkerPlacement[], theme: TrackTheme): void {
    const height = theme.edgeMarkers.height
    const geo = new BoxGeometry(MARKER_POST_THICKNESS, height, MARKER_POST_THICKNESS)
    ownedStaticGeometries.push(geo)
    for (const colorIdx of [0, 1] as const) {
      const of = posts.filter((p) => p.colorIdx === colorIdx)
      if (of.length === 0) continue
      const mat = new MeshLambertMaterial()
      setColor(mat.color, theme.edgeMarkers.colors[colorIdx])
      ownedStaticMaterials.push(mat)
      // One InstancedMesh per colour: hundreds of posts, two draw calls.
      const inst = new InstancedMesh(geo, mat, of.length)
      for (let i = 0; i < of.length; i++) {
        const p = of[i]
        scratchVector.set(p.position.x, p.position.y + height / 2, p.position.z)
        scratchEuler.set(0, -p.heading, 0)
        scratchQuat.setFromEuler(scratchEuler)
        scratchScale.set(1, 1, 1)
        scratchMatrix.compose(scratchVector, scratchQuat, scratchScale)
        inst.setMatrixAt(i, scratchMatrix)
      }
      inst.instanceMatrix.needsUpdate = true
      staticRoot.add(inst)
    }
  }

  function addCheckpoints(marks: readonly MarkerPlacement[], theme: TrackTheme): void {
    if (marks.length === 0) return
    const geo = new BoxGeometry(CHECKPOINT_BAR_LENGTH, CHECKPOINT_BAR_HEIGHT, 1)
    const mat = new MeshLambertMaterial()
    setColor(mat.color, theme.wall)
    ownedStaticGeometries.push(geo)
    ownedStaticMaterials.push(mat)
    const inst = new InstancedMesh(geo, mat, marks.length)
    for (let i = 0; i < marks.length; i++) {
      const m = marks[i]
      scratchVector.set(m.position.x, m.position.y + ROAD_DECAL_LIFT, m.position.z)
      scratchEuler.set(0, -m.heading, 0)
      scratchQuat.setFromEuler(scratchEuler)
      scratchScale.set(1, 1, m.width)
      scratchMatrix.compose(scratchVector, scratchQuat, scratchScale)
      inst.setMatrixAt(i, scratchMatrix)
    }
    inst.instanceMatrix.needsUpdate = true
    staticRoot.add(inst)
  }

  function applyKart(i: number, k: KartDraw): void {
    const root = kartRoots[i]
    root.visible = k.visible
    if (!k.visible) return
    const body = kartBodies[i]
    const head = kartHeads[i]
    const tilt = kartTilts[i]
    const shield = kartShields[i]

    const kartGeo = kartGeometries[k.characterIdx]
    const charGeo = characterGeometries[k.characterIdx]
    if (kartGeo !== undefined && body.geometry !== kartGeo) body.geometry = kartGeo
    if (charGeo !== undefined && head.geometry !== charGeo) head.geometry = charGeo

    // `heading` is a world yaw whose forward is (cos h, 0, sin h) -- the
    // convention §4.7's bubblePosition is written in -- and a Three yaw turns +x
    // toward -z, so the scene-graph rotation is -heading. Descriptor meshes are
    // authored +x forward, +y up.
    root.position.set(k.position.x, k.position.y, k.position.z)
    root.rotation.set(0, -k.heading, 0)
    tilt.rotation.set(k.roll, 0, 0)

    setColor(body.material.color, k.bodyTint)
    body.material.opacity = k.alpha
    head.material.opacity = k.alpha
    body.material.emissive.setRGB(k.boostFlame * 0.9, k.boostFlame * 0.35, 0, LinearSRGBColorSpace)
    shield.visible = k.shieldVisible
  }

  return {
    setScene(trackScene: TrackScene, theme: TrackTheme,
             kartMeshes: readonly MeshData[], characterMeshes: readonly MeshData[]): void {
      clearStatic()
      addSurface(trackScene.road)
      addSurface(trackScene.boostPads)
      addSurface(trackScene.ramps)
      addEdgeMarkers(trackScene.edgeMarkers, theme)
      addCheckpoints(trackScene.checkpoints, theme)
      addItemBoxes(trackScene.itemBoxes)

      // The ground plane, sized from the render extent Q19 computes `bounds` for and
      // coloured `theme.ground` — the one field of the theme that six themes are gated
      // on and that nothing else in this package draws (§12).
      const spanX = trackScene.bounds.max.x - trackScene.bounds.min.x
      const spanZ = trackScene.bounds.max.z - trackScene.bounds.min.z
      ground.scale.set(spanX * GROUND_MARGIN, spanZ * GROUND_MARGIN, 1)
      ground.position.set(
        (trackScene.bounds.min.x + trackScene.bounds.max.x) / 2,
        trackScene.bounds.min.y - GROUND_DROP,
        (trackScene.bounds.min.z + trackScene.bounds.max.z) / 2,
      )
      setColor(groundMaterial.color, theme.ground)

      for (const geo of kartGeometries) geo.dispose()
      for (const geo of characterGeometries) geo.dispose()
      kartGeometries.length = 0
      characterGeometries.length = 0
      for (const data of kartMeshes) kartGeometries.push(toGeometry(data))
      for (const data of characterMeshes) characterGeometries.push(toGeometry(data))

      setColor(scratchColor, theme.sky.bottom)
      scene.background = new Color(scratchColor)
      setColor(scratchColor, theme.fog.color)
      scene.fog = new Fog(scratchColor.getHex(), theme.fog.near, theme.fog.far)
      ambient.intensity = theme.ambient
      sun.position.set(theme.sunDirection.x, theme.sunDirection.y, theme.sunDirection.z)
      sun.position.multiplyScalar(100)

      const counts = meshCounts([
        trackScene.road, trackScene.boostPads, trackScene.ramps,
        ...kartMeshes, ...characterMeshes,
      ])
      sceneVertices = counts.vertices
      sceneTriangles = counts.triangles
    },

    applyFrame(frame: RenderFrame): void {
      camera.position.set(frame.camera.position.x, frame.camera.position.y, frame.camera.position.z)
      camera.up.set(frame.camera.up.x, frame.camera.up.y, frame.camera.up.z)
      scratchVector.set(frame.camera.lookAt.x, frame.camera.lookAt.y, frame.camera.lookAt.z)
      camera.lookAt(scratchVector)
      if (camera.fov !== frame.camera.fovDegrees) {
        camera.fov = frame.camera.fovDegrees
        camera.updateProjectionMatrix()
      }

      for (let i = 0; i < MAX_KARTS; i++) applyKart(i, frame.karts[i])

      for (let i = 0; i < MAX_ENTITIES; i++) {
        const mesh = entityMeshes[i]
        const e = frame.entities[i]
        if (!e.visible) {
          mesh.visible = false      // includes every 'surge', which is never drawn (Q27)
          continue
        }
        mesh.visible = true
        mesh.position.set(e.position.x, e.position.y, e.position.z)
        mesh.rotation.set(0, -e.heading, 0)
        mesh.scale.setScalar(e.scale)
        setColor(mesh.material.color, e.tint)
        mesh.material.opacity = e.alpha
      }

      // Index i is box i in TrackScene.itemBoxes: the same pairing §4.3 pins and the
      // mesh task asserts against sim's own itemBoxWorldPos. Alpha 0 is a taken box
      // mid-respawn (Q29), and `visible = false` skips the draw call entirely.
      for (let i = 0; i < itemBoxMeshes.length; i++) {
        const alpha = frame.itemBoxAlpha[i]
        const box = itemBoxMeshes[i]
        box.visible = alpha > 0
        box.material.opacity = alpha
      }

      tintQuad.visible = frame.screenTintAmount > 0
      if (tintQuad.visible) {
        setColor(tintMaterial.color, frame.screenTintColor)
        tintMaterial.opacity = frame.screenTintAmount
      }
      flashQuad.visible = frame.screenFlash > 0
      if (flashQuad.visible) flashMaterial.opacity = frame.screenFlash

      renderer.clear()
      renderer.render(scene, camera)
      renderer.render(overlayScene, overlayCamera)
    },

    resize(widthPx: number, heightPx: number, devicePixelRatio: number): void {
      const w = Math.max(1, widthPx)
      const h = Math.max(1, heightPx)
      renderer.setPixelRatio(Math.min(devicePixelRatio, opts.maxPixelRatio))
      renderer.setSize(w, h, false)     // the shell owns CSS sizing, not the renderer
      camera.aspect = w / h
      camera.updateProjectionMatrix()
    },

    stats(): RendererStats {
      return {
        drawCalls: renderer.info.render.calls,
        vertices: sceneVertices,
        triangles: sceneTriangles,
      }
    },

    dispose(): void {
      if (disposed) return
      disposed = true
      clearStatic()
      for (const geo of kartGeometries) geo.dispose()
      for (const geo of characterGeometries) geo.dispose()
      kartGeometries.length = 0
      characterGeometries.length = 0
      for (const geo of ownedGeometries) geo.dispose()
      for (const mat of ownedMaterials) mat.dispose()
      renderer.dispose()
    },
  }
}
```

Four things about this file that are decisions, not incidentals:

- **`wheelSpin` and `steerAngle` are carried by `RenderFrame` and not consumed
  here.** `buildKartMesh` (§4.4) emits one `MeshData` per kart with its wheels
  baked in, so there is no wheel object to turn. Both fields stay in the frame
  because they are derived from simulation state, they are in the golden fixture's
  covered subset (§9.2), and an adapter that splits wheels out later reads them
  without a contract change. This is the only place in the seam where the frame
  says more than the v1 adapter draws.
- **Item boxes are drawn here, and the index pairing is the whole contract.**
  `TrackScene.itemBoxes[i]` (filled from sim's `itemBoxWorldPos`, the sole writer
  of a box's world position) and `RenderFrame.itemBoxAlpha[i]` are the same box.
  This adapter never re-derives a position and never re-orders the array; it walks
  both by the same `i`. Get that wrong and every box draws over the wrong pickup
  volume — which no test in `render` can see, because this file is the one CI never
  imports.
- **The ground plane is sized from `scene.bounds`, not from `track.bounds`.** Q19
  rules `track.bounds` a *declared* render extent, much larger than the ribbon;
  `TrackScene.bounds` is `meshBounds(road)`, the extent of what was actually built.
  A ground quad sized from the declared bounds would push the horizon hundreds of
  metres past the fog on some tracks and not others. **CI cannot see this either**
  (§8.3 puts pixels under owner verification), so the shell task's operator
  checklist names the ground plane explicitly — that checklist is the only detector
  a missing ground plane has.
- **Colours are set in linear space** (`setRGB(..., LinearSRGBColorSpace)`)
  because every `PaletteRGB` in `@tapkart/content` is documented linear 0..1,
  while the renderer's output is `SRGBColorSpace`. Passing linear values as if
  they were sRGB is the classic washed-out-scene bug and costs nothing to avoid.

**3d.** Create `packages/render/src/index.ts` — the §4.11 barrel:

```ts
// Public barrel for @tapkart/render.
//
// packages/render/package.json maps "." to this file, so this list IS the
// package's public surface. `three/renderer` is NOT here, and that omission is
// load-bearing rather than tidy: re-exporting it would pull `three` -- and,
// transitively, a WebGL context -- into every headless test in the repository,
// and the failure would appear as an unrelated suite breaking (§8.2). Reach the
// adapter through the package's "./three" export instead; only apps/web does.
//
// There is no `time` module (§4.1: the tick/millisecond bridge is game/clock.ts,
// which owns the single TICK_MS import) and no `theme` module (§4.5: TrackTheme
// is @tapkart/content's). barrel.test.ts asserts both absences, that no two
// re-exported modules export the same name, and that nothing reachable from here
// imports three.
export * from './types'
export * from './mesh'
export * from './descriptors'
export * from './camera'
export * from './frame'
export * from './hud'
export * from './audio'
export * from './smoothing'
export * from './backend'
```

---

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run packages/render/test/backend.test.ts packages/render/test/barrel.test.ts
```

Expected: PASS, 16 tests (5 in `backend.test.ts`, 11 in `barrel.test.ts`).

Then the full gate — the adapter is typechecked here and nowhere else, so this is
the only step that proves it compiles against the real `three` types:

```bash
npx tsc --noEmit -p packages/render/tsconfig.json
npx vitest run
```

Both must be clean. If `tsc` reports `TS7016: Could not find a declaration file
for module 'three'`, `npm install` did not pick up `@types/three` — re-run it from
the repository root, not from inside the package.

**Owner verification, which CI cannot do (§8.3):** that the pixels are correct.
CI proves the `RenderFrame` is right and that the adapter was handed it; it cannot
prove Three.js drew it, that the shader compiled, or that the kart is not inside
the road. That check happens when `apps/web` runs on a device.

---

- [ ] **Step 5: Commit**

```bash
git add packages/render/src/backend.ts packages/render/src/three/renderer.ts \
        packages/render/src/index.ts packages/render/package.json \
        packages/render/test/backend.test.ts packages/render/test/barrel.test.ts \
        package-lock.json
git commit -m "feat(render): the RendererBackend seam, the Three.js adapter and the barrel

backend.ts imports nothing but sibling types, so a mock backend is a
plain object literal and spec §8's scene-graph assertions are made
against applyFrame's argument, under environment: 'node', with no canvas
and no GPU. That is the whole reason the seam exists -- Q10 mandates
Three.js and there is no Canvas2D fallback, so this is testability, not
device fallback.

three is pinned at exactly 0.180.0, no caret. three@0.180.0 publishes no
type declarations -- no types field, no types condition in its exports
map, no .d.ts in build/ -- so @types/three@0.180.0 is a devDependency,
which §4.10 makes this task's call and this task's report.

The barrel re-exports nine modules and deliberately not three/renderer.
That omission is load-bearing: a barrel that re-exported it would pull
three, and transitively a WebGL context, into every headless test in the
repository, and the failure would surface as an unrelated suite
breaking. verbatimModuleSyntax does not save that -- a value import
survives erasure -- so even import type from 'three' is banned outside
src/three/. barrel.test.ts enforces both bans over the transitive module
graph from index.ts, and repo-wide across every packages/*/test tree,
rather than trusting the rule.

The adapter allocates its whole scene graph once: eight kart groups
(outer group for position and yaw, inner group for roll about the
forward axis), MAX_ENTITIES entity meshes, and two InstancedMeshes for
the edge markers, so hundreds of posts cost two draw calls. Screen tint
and flash are an orthographic overlay pass rather than a post chain --
no render target on a phone. Palettes are set in linear space against an
SRGB output colour space, which is what content documents them as.

Track colour is baked into vertex colours by buildTrackScene and this
file sets no palette on a surface material. vertexColors: true
MULTIPLIES material.color by the vertex colour, so a second palette here
would ship the road at theme.road squared -- a 0.18 grey as 0.032. One
code path colours every surface, and a surface added later cannot be
forgotten by it.

The ground plane is a single quad sized from TrackScene.bounds --
meshBounds(road), the extent of what was built, not track.bounds, which
Q19 declares much larger -- and coloured theme.ground. §12 fixes the
visual budget as a ribbon over a themed ground plane plus procedural
edge markers; without the plane the ribbon floats over the sky's bottom
colour and six gated theme.ground values render nothing.

Item boxes are drawn: one Mesh per box over a shared geometry, walking
TrackScene.itemBoxes and RenderFrame.itemBoxAlpha by the same index,
because Q29's ghosting is per-box opacity and a per-instance opacity
needs a custom shader.

One honest gap remains, recorded in the file: wheelSpin and steerAngle
are in the frame but not consumed, because buildKartMesh bakes wheels
into one mesh.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 17: `packages/game` workspace scaffold and `src/clock.ts`

Creates the fourth workspace, `@tapkart/game`, mirroring `@tapkart/sim`'s shape
except where §10 and R35 say otherwise, and writes **the only wall clock in the
repository** and **the only `TICK_MS` import in the repository**.

Both of those are stated as global constraints, and this task is where they become
true. They are also the two rules most likely to be broken later by accident — a
module that reaches for `performance.now()` because it needs "a time", or one that
writes `const TICK_MS = 16.67` because importing it seemed heavy — so this task
does not merely obey them, it **enforces them repo-wide with two source scans**
that every later task runs on every `vitest run`.

Why they matter, concretely:

- **`TICK_MS` comes from `@tapkart/net` (Q6) and is imported here and nowhere
  else** (§4.1, §6.1). `render` *cannot* import it, because `render` does not
  depend on `net` and that omission is load-bearing; so the tick/millisecond
  bridge lives on the only side that can hold it. `render` names
  milliseconds-per-tick nowhere at all: its one tick-to-seconds conversion,
  `formatRaceClock`, uses `TICK_DT` from `@tapkart/sim`, a different constant with
  a different name that cannot be confused with `TICK_MS`. A second definition of
  the timebase is a second timebase, and the two agree until the day one is
  edited.
- **One wall clock.** `realFrameClock` is the single impure binding in `render`
  and `game` combined; everything else takes a `FrameClock`. That is what makes
  the camera, the accumulator, the view builder and the frame builder testable
  with `environment: 'node'` and no fake timers, and what keeps `updateCamera`'s
  per-tick smoothing frame-rate independent.
- **Amendment 4: the accumulator is `@tapkart/net`'s, not this file's — and the
  contract describes it wrongly.** `TickAccumulator`, `makeTickAccumulator`,
  `advanceAccumulator` and `MAX_CATCHUP_TICKS` all live in `@tapkart/net` and are
  imported from there. `packages/server` (Plan 4) runs the same fixed-step pump,
  and `net` may not import `game` — §1's arrow only points one way — so the
  function had to move or be written twice. The **type moves with the function**:
  leaving `TickAccumulator` behind would leave `net` importing it from `game`,
  which is precisely the inversion the move exists to avoid; the clamp moves for
  the same reason, because two copies of a clamp is two clamps.

  **Read the shipped signatures, not contract §5.1.** Three of §5.1's statements
  about the accumulator are false against shipped code, and each is a real
  failure rather than a preference:

  | §5.1 says | shipped | what breaks |
  |---|---|---|
  | `TickAccumulator { residualMs; lastNowMs }` | **`{ residualMs }`** | the accumulator holds no timestamp and does no clock arithmetic |
  | `advanceAccumulator(acc, nowMs)` | **`advanceAccumulator(acc, elapsedMs)`** — a DELTA | passing an absolute `performance.now()` (~1.7e12) runs the clamp on the first frame and every frame after |
  | `MAX_CATCHUP_TICKS = 8` | **`= 5`** | a test asserting 8 fails; the constant is load-bearing for spec §11's death-spiral risk |

  There is no `createAccumulator` here: `makeTickAccumulator()` takes no argument,
  because there is no `lastNowMs` to seed. **The caller owns the previous
  timestamp** and computes `now - lastNowMs` itself — which is a
  three-line obligation on exactly one caller, the frame loop, and is why
  `FrameClock` lives in this file next to it. What stays here is what is genuinely
  browser-frame-shaped: `FrameClock`, `realFrameClock`, `makeFixedClock`,
  `accumulatorAlpha` and `renderNowMs`.
- **`renderNowMs(tick, alpha)` lives here too**, and §6.3 is the reason: the
  `RemoteInterpolator`'s notion of "now" is **sim time**, because `ClientLoop`
  stamps every keyframe `recvAtMs: tick * TICK_MS`. Pass `clock.nowMs()` to
  `sampleKart` instead and the target instant is thousands of milliseconds past
  the newest keyframe on the very first frame, so **every** remote kart takes the
  extrapolation branch, clamps at `REMOTE_EXTRAPOLATE_CAP_MS = 200`, and slides
  along its last velocity forever. Nothing throws and nothing logs; it merely
  looks wrong on a device, which is the one place CI cannot see. `ViewBuilder`
  calls `renderNowMs` internally so no caller is ever handed the chance to pass
  the wrong clock — this task ships the function that makes that possible.

**Files:**
- Create: `packages/game/package.json`
- Create: `packages/game/tsconfig.json`
- Create: `packages/game/src/index.ts` — the barrel, starting with `./clock`
- Create: `packages/game/src/clock.ts`
- Modify: `package-lock.json` — `npm install` side effect (Step 3e), declared
  because five tasks in this plan rewrite it
- Test: `packages/game/test/scaffold.test.ts`
- Test: `packages/game/test/clock.test.ts`

**No root config changes.** The root `workspaces` array already carries
`"packages/*"` and the root `vitest.config.ts` already includes
`packages/*/test/**/*.test.ts`, so this workspace is discovered by both without
edits. §10.2's two root edits (`apps/*` in `workspaces`, the apps glob in
`vitest.config.ts`) belong to **the repo-plumbing task, which is this plan's
first** and has already made them; the `apps/web` task verifies them rather than
re-making them. Do not edit either file here — this task's scaffold test asserts
only that `"packages/*"` is present, so it passes either way and would not notice.

**Interfaces:**

- Consumes:
  - `packages/sim/package.json`, read directly:
    ```json
    { "name": "@tapkart/sim", "version": "0.1.0", "private": true, "type": "module",
      "exports": { ".": "./src/index.ts" },
      "scripts": { "typecheck": "tsc --noEmit -p tsconfig.json" } }
    ```
    No `devDependencies` — `vitest` and `typescript` come from the root by npm
    workspace hoisting.
  - `tsconfig.base.json`, read directly: `"lib": ["ES2022"]` and **no DOM**, plus
    `strict`, `noUnusedLocals`, `noUnusedParameters`, `noImplicitOverride`,
    `noImplicitReturns`, `noFallthroughCasesInSwitch`, `verbatimModuleSyntax`,
    `isolatedModules`, `moduleResolution: "Bundler"`.
  - `vitest.config.ts`, read directly: `include: ['packages/*/test/**/*.test.ts']`,
    `environment: 'node'`, `globals: false`, `reporters: ['default']`.
  - `@tapkart/net` [Plan 2 Tasks 15/15b, contract §2.5, plus amendment 4] —
    **quoted from shipped `packages/net/src/clock.ts`, which supersedes §5.1**:
    ```ts
    /** 1000 / TICK_HZ. Exported (Q6) so nothing else in the repository defines it. */
    export const TICK_MS: number

    /** ONE field. The accumulator holds no timestamp and does no clock
     *  arithmetic — the caller owns `lastNowMs` and passes a delta. */
    export interface TickAccumulator { residualMs: number }
    export function makeTickAccumulator(): TickAccumulator

    /** Pure. Folds `elapsedMs` — a DELTA, never an absolute clock reading — in,
     *  returns how many 60 Hz ticks to run now (0..MAX_CATCHUP_TICKS), and leaves
     *  the sub-tick remainder in `acc.residualMs`. When the burst is clamped the
     *  excess is DISCARDED, not banked. SOLE WRITER of TickAccumulator (§7.2). */
    export function advanceAccumulator(acc: TickAccumulator, elapsedMs: number): number

    /** FIVE, not the 8 contract §5.1 states. About 83 ms of catch-up. */
    export const MAX_CATCHUP_TICKS = 5
    ```
    None of these is re-exported from `packages/game/src/clock.ts` or from
    `packages/game/src/index.ts`. A consumer that needs them — this plan's frame
    loop, and `packages/server` — imports them from `@tapkart/net` directly, so
    there is exactly one name and one import path for each.
  - `@tapkart/sim` [Plan 1, shipped] — used by the **tests** only:
    ```ts
    export const TICK_HZ = 60
    export const TICK_DT = 1 / 60
    ```

- Produces — the five exports left to `game/clock` once amendment 4 has taken the
  whole accumulator (type, constructor, function and clamp) to `@tapkart/net`.
  §11's census for this module reads 5; `net`'s is four higher:
  ```ts
  export interface FrameClock { nowMs(): number }

  /** performance.now() when available, Date.now() otherwise. The ONE impure
   *  binding in either package. Everything else takes a FrameClock. */
  export const realFrameClock: FrameClock

  /** Deterministic clock for tests: starts at `startMs` (default 0), moves only
   *  on advance(). */
  export function makeFixedClock(startMs?: number): FrameClock & { advance(ms: number): void }

  /** Sub-tick fraction in [0, 1) for the frame that follows the ticks just run:
   *  acc.residualMs / TICK_MS. Takes net's TickAccumulator; stays here because
   *  TICK_MS may be imported in this file and nowhere else (§6.1). */
  export function accumulatorAlpha(acc: TickAccumulator): number

  /** The tick-derived instant a frame represents: (tick + alpha) * TICK_MS.
   *  This is the ONLY value that may ever be passed as `nowMs` to
   *  RemoteInterpolator.sampleKart / sampleEntity (§6.3). */
  export function renderNowMs(tick: number, alpha: number): number
  ```
  and the workspace `@tapkart/game` at `packages/game`, plus
  `packages/game/src/index.ts` re-exporting `./clock`. §5.15's full barrel
  (`controls/*`, `settings`, `app`, `results`, `session`,
  `localinput`, `view` — and **not** `controls/source` or `shell`, which are DOM
  adapters) is widened module by module by the tasks that ship those modules; this
  task creates the file carrying `./clock`, exactly as Plan 2's Task 11 created
  `net`'s barrel carrying `./transport`.

---

- [ ] **Step 1: Write the failing tests**

Create `packages/game/test/scaffold.test.ts`:

```ts
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import * as game from '../src/index'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG = resolve(HERE, '..')
const REPO = resolve(PKG, '..', '..')

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

describe('@tapkart/game workspace scaffold', () => {
  it('runs a TypeScript test from the new workspace', () => {
    expect(2 + 2).toBe(4)
  })

  it('resolves its entry point with extensionless imports', () => {
    expect(typeof game).toBe('object')
    expect(typeof game.renderNowMs).toBe('function')
  })

  it('declares the manifest §10 pins', () => {
    const pkg = readJson(join(PKG, 'package.json'))
    expect(pkg.name).toBe('@tapkart/game')
    expect(pkg.type).toBe('module')
    expect(pkg.private).toBe(true)
    expect(pkg.exports).toEqual({ '.': './src/index.ts', './shell': './src/shell.ts' })
    // Q13: `game` names WireKart the moment RemoteSample carries one, so the
    // protocol dependency is declared now rather than discovered later.
    expect(pkg.dependencies).toEqual({
      '@tapkart/sim': '*',
      '@tapkart/protocol': '*',
      '@tapkart/net': '*',
      '@tapkart/content': '*',
      '@tapkart/render': '*',
    })
    expect((pkg.devDependencies as Record<string, string>).vite).toBe('^7.0.0')
  })

  it('widens the DOM lib in its own tsconfig, and only there (R35)', () => {
    const own = readJson(join(PKG, 'tsconfig.json'))
    expect(own.extends).toBe('../../tsconfig.base.json')
    expect((own.compilerOptions as Record<string, unknown>).lib)
      .toEqual(['ES2022', 'DOM', 'DOM.Iterable'])
    expect(own.include).toEqual(['src/**/*.ts', 'test/**/*.ts'])

    // The failure this catches is not "game does not compile" -- it is someone
    // making game compile by adding DOM to the base, which silently gives `sim`,
    // `protocol`, `net` and `content` a browser dependency. Those four are the
    // packages `server` imports under plain Node.
    const base = readJson(join(REPO, 'tsconfig.base.json'))
    expect((base.compilerOptions as Record<string, unknown>).lib).toEqual(['ES2022'])

    for (const domFree of ['sim', 'protocol', 'net', 'content']) {
      const cfg = readJson(join(REPO, 'packages', domFree, 'tsconfig.json'))
      const opts = (cfg.compilerOptions ?? {}) as Record<string, unknown>
      expect(opts.lib, `packages/${domFree} must not widen lib`).toBeUndefined()
    }
  })

  it('is discovered by the root config without editing it', () => {
    const root = readJson(join(REPO, 'package.json'))
    expect(root.workspaces).toContain('packages/*')
    const vitest = readFileSync(join(REPO, 'vitest.config.ts'), 'utf8')
    expect(vitest).toContain("'packages/*/test/**/*.test.ts'")
    expect(vitest).toContain("environment: 'node'")
    expect(vitest).toContain('globals: false')
  })
})
```

Create `packages/game/test/clock.test.ts`:

```ts
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { TICK_HZ } from '@tapkart/sim'
// The whole accumulator is net's (amendment 4). This file still asserts its
// behaviour, because this plan's frame loop is built on the clamp, the discard
// and the conservation identity, and a consumer that imports a behaviour and
// tests none of it finds out on a device.
import { MAX_CATCHUP_TICKS, TICK_MS, advanceAccumulator, makeTickAccumulator } from '@tapkart/net'
import type { TickAccumulator } from '@tapkart/net'

import { accumulatorAlpha, makeFixedClock, realFrameClock, renderNowMs } from '../src/clock'
import type { FrameClock } from '../src/clock'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG = resolve(HERE, '..')
const REPO = resolve(PKG, '..', '..')
const CLOCK_FILE = join(PKG, 'src', 'clock.ts')

/** Prose is allowed to mention a clock; code is not. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

function tsFilesUnder(dir: string): string[] {
  const out: string[] = []
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...tsFilesUnder(full))
    else if (entry.endsWith('.ts')) out.push(full)
  }
  return out
}

function srcFilesOf(...packages: string[]): string[] {
  return packages.flatMap((p) => tsFilesUnder(join(REPO, 'packages', p, 'src')))
}

function everyPackageSrcExcept(excluded: string): string[] {
  return readdirSync(join(REPO, 'packages'))
    .filter((p) => p !== excluded)
    .flatMap((p) => tsFilesUnder(join(REPO, 'packages', p, 'src')))
}

describe('TICK_MS is net\'s, and this file is its only importer', () => {
  it('is 1000 / TICK_HZ', () => {
    expect(TICK_MS).toBe(1000 / TICK_HZ)
    expect(TICK_MS).toBeCloseTo(16.6667, 4)
  })

  it('is imported from @tapkart/net by game/src/clock.ts and by nothing else', () => {
    const importClause = /import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*['"]@tapkart\/net['"]/g
    const offenders: string[] = []
    for (const file of everyPackageSrcExcept('net')) {
      if (file === CLOCK_FILE) continue
      const text = stripComments(readFileSync(file, 'utf8'))
      for (const match of text.matchAll(importClause)) {
        if (/\bTICK_MS\b/.test(match[1])) offenders.push(relative(REPO, file))
      }
    }
    expect(offenders).toEqual([])
    expect(/import\s*\{[^}]*\bTICK_MS\b[^}]*\}\s*from\s*'@tapkart\/net'/
      .test(readFileSync(CLOCK_FILE, 'utf8'))).toBe(true)
  })

  it('is never redefined outside @tapkart/net', () => {
    const declaration = /\b(?:const|let|var|function)\s+TICK_MS\b/
    const offenders = everyPackageSrcExcept('net')
      .filter((file) => declaration.test(stripComments(readFileSync(file, 'utf8'))))
      .map((file) => relative(REPO, file))
    expect(offenders).toEqual([])
  })
})

describe('the only wall clock in the repository', () => {
  it('is read by no module in content, render or game except clock.ts', () => {
    const readers = [/\bDate\.now\s*\(/, /\bperformance\.now\s*\(/, /\bnew\s+Date\s*\(/]
    const offenders: string[] = []
    for (const file of srcFilesOf('content', 'render', 'game')) {
      if (file === CLOCK_FILE) continue
      const text = stripComments(readFileSync(file, 'utf8'))
      if (readers.some((r) => r.test(text))) offenders.push(relative(REPO, file))
    }
    expect(offenders).toEqual([])
    // ...and clock.ts really is a wall clock, so the sweep is not vacuous.
    expect(/\bperformance\.now\s*\(/.test(readFileSync(CLOCK_FILE, 'utf8'))).toBe(true)
  })

  it('reads a finite, non-decreasing millisecond value', () => {
    const clock: FrameClock = realFrameClock
    const first = clock.nowMs()
    let spin = 0
    for (let i = 0; i < 200000; i++) spin += i
    const second = clock.nowMs()
    expect(Number.isFinite(first)).toBe(true)
    expect(second).toBeGreaterThanOrEqual(first)
    expect(spin).toBeGreaterThan(0)
  })
})

describe('makeFixedClock', () => {
  it('starts at 0 and moves only on advance', () => {
    const clock = makeFixedClock()
    expect(clock.nowMs()).toBe(0)
    expect(clock.nowMs()).toBe(0)
    clock.advance(16)
    expect(clock.nowMs()).toBe(16)
    clock.advance(16)
    expect(clock.nowMs()).toBe(32)
  })

  it('starts at startMs when given one', () => {
    const clock = makeFixedClock(1000)
    expect(clock.nowMs()).toBe(1000)
    clock.advance(0.5)
    expect(clock.nowMs()).toBe(1000.5)
  })

  it('gives every clock its own time', () => {
    const a = makeFixedClock()
    const b = makeFixedClock()
    a.advance(100)
    expect(a.nowMs()).toBe(100)
    expect(b.nowMs()).toBe(0)
  })
})

// AMENDMENT 4: advanceAccumulator is @tapkart/net's. These stay here anyway. They
// are consumption tests, not ownership tests: the frame loop this plan ships runs
// on the clamp-and-discard policy and on the conservation identity, and both are
// silent when wrong -- a banked residual is a spiral of death after a backgrounded
// tab, a reset residual is a game that never ticks at 100 fps. `packages/server`
// will own the same dependency; neither of us should be the package that assumed
// the other tested it.
describe("advanceAccumulator — net's, amendment 4", () => {
  it('starts empty', () => {
    const acc = makeTickAccumulator()
    expect(acc.residualMs).toBe(0)
    expect(accumulatorAlpha(acc)).toBe(0)
    // ONE field. There is no lastNowMs: the accumulator holds no timestamp, and
    // a frame loop written against a two-field version would be storing its
    // previous instant in an object that never reads it.
    expect(Object.keys(acc)).toEqual(['residualMs'])
  })

  it('runs one tick for one 60 Hz frame', () => {
    const acc = makeTickAccumulator()
    expect(advanceAccumulator(acc, 16.67)).toBe(1)
    expect(acc.residualMs).toBeCloseTo(16.67 - TICK_MS, 9)
    expect(acc.residualMs).toBeLessThan(TICK_MS)
    expect(acc.residualMs).toBeGreaterThanOrEqual(0)
  })

  it('runs no tick when no time has passed', () => {
    const acc = makeTickAccumulator()
    expect(advanceAccumulator(acc, 0)).toBe(0)
    expect(advanceAccumulator(acc, 8)).toBe(0)      // half a tick
    expect(acc.residualMs).toBe(8)
  })

  it('clamps a long stall to MAX_CATCHUP_TICKS and DISCARDS the rest', () => {
    const acc = makeTickAccumulator()
    // A backgrounded tab returning after a second owes 59 ticks.
    expect(advanceAccumulator(acc, 1000)).toBe(MAX_CATCHUP_TICKS)
    expect(acc.residualMs).toBeLessThan(TICK_MS)

    // The 54 ticks it did not run are gone, not banked: with no further elapsed
    // time, the next frame runs nothing. An implementation that subtracted only
    // MAX_CATCHUP_TICKS * TICK_MS would return 5 again here, and again, and
    // again -- the spiral of death this clamp exists to prevent.
    expect(advanceAccumulator(acc, 0)).toBe(0)
    expect(advanceAccumulator(acc, 0)).toBe(0)
  })

  it('conserves time exactly while it is not clamped', () => {
    const acc = makeTickAccumulator()
    let total = 0
    let maxPerFrame = 0
    for (let i = 0; i < 100; i++) {
      const ticks = advanceAccumulator(acc, 10)          // 100 frames at 100 fps
      total += ticks
      maxPerFrame = Math.max(maxPerFrame, ticks)
    }
    expect(maxPerFrame).toBe(1)                          // never clamped
    // THE assertion, and the reason it is an identity rather than a tick count:
    // every millisecond either became a tick or is still sitting in the residual.
    // A reset-the-residual-each-frame implementation runs 0 ticks here and misses
    // by the whole 1000 ms. A tick-count assertion would not do this job --
    // 60 * TICK_MS is 1000.0000000000001, so the honest answer here is 59, and a
    // count tuned to expect 60 would have to be "fixed" by breaking the residual.
    expect(total * TICK_MS + acc.residualMs).toBeCloseTo(1000, 9)
    expect(total).toBe(59)   // the 60th tick needs 1000.0000000000001 ms
    expect(acc.residualMs).toBeLessThan(TICK_MS)
  })

  it('runs the same number of ticks at 60 Hz and at 120 Hz', () => {
    const slow = makeTickAccumulator()
    let slowTicks = 0
    for (let i = 0; i < 600; i++) slowTicks += advanceAccumulator(slow, 1000 / 60)

    const fast = makeTickAccumulator()
    let fastTicks = 0
    const perFrame: number[] = []
    for (let i = 0; i < 1200; i++) {
      const ticks = advanceAccumulator(fast, 1000 / 120)
      perFrame.push(ticks)
      fastTicks += ticks
    }

    // Ten seconds of wall time is the same amount of simulation on both
    // displays -- the property the whole fixed-step loop exists for.
    expect(slowTicks).toBe(fastTicks)
    expect(slowTicks).toBe(600)
    expect(perFrame.filter((t) => t === 0).length).toBe(600)   // 120 Hz idles every other frame
    expect(Math.max(...perFrame)).toBe(1)
  })

  it('keeps the residual under one tick and alpha in [0, 1) under jitter', () => {
    const acc = makeTickAccumulator()
    let seed = 12345
    const random = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0
      return seed / 4294967296
    }
    for (let i = 0; i < 20000; i++) {
      const elapsedMs = random() * 60                   // 0..60 ms frames, i.e. 16..∞ fps
      const ticks = advanceAccumulator(acc, elapsedMs)
      expect(ticks).toBeGreaterThanOrEqual(0)
      expect(ticks).toBeLessThanOrEqual(MAX_CATCHUP_TICKS)
      expect(acc.residualMs).toBeGreaterThanOrEqual(0)
      expect(acc.residualMs).toBeLessThan(TICK_MS)
      const alpha = accumulatorAlpha(acc)
      expect(alpha).toBeGreaterThanOrEqual(0)
      expect(alpha).toBeLessThan(1)
    }
  })

  it('credits nothing for a negative elapsed', () => {
    // The caller computes `now - lastNowMs`, so a system time change or a caller
    // mixing two clocks hands this a negative delta. Crediting it drives the
    // residual negative and Math.floor then returns a NEGATIVE tick count, which
    // a `for (let i = 0; i < ticks; i++)` loop silently reads as "no ticks
    // forever" once the residual can no longer climb back.
    const acc = makeTickAccumulator()
    advanceAccumulator(acc, 20)
    const residual = acc.residualMs

    expect(advanceAccumulator(acc, -70)).toBe(0)
    expect(acc.residualMs).toBe(residual)   // byte-identical: no negative time credited

    expect(advanceAccumulator(acc, TICK_MS * 2)).toBe(2)
  })

  it('is the sole writer of the accumulator', () => {
    const acc: TickAccumulator = makeTickAccumulator()
    advanceAccumulator(acc, 33.4)
    expect(Object.keys(acc)).toEqual(['residualMs'])
    expect(acc.residualMs).toBeCloseTo(33.4 - TICK_MS * 2, 9)
  })
})

describe('accumulatorAlpha', () => {
  it('is the residual as a fraction of one tick', () => {
    const acc = makeTickAccumulator()
    advanceAccumulator(acc, TICK_MS + 4)
    expect(acc.residualMs).toBeCloseTo(4, 9)
    expect(accumulatorAlpha(acc)).toBeCloseTo(4 / TICK_MS, 12)
    expect(accumulatorAlpha(acc)).toBe(acc.residualMs / TICK_MS)
  })

  it('is 0 immediately after a whole number of ticks', () => {
    const acc = makeTickAccumulator()
    expect(advanceAccumulator(acc, TICK_MS * 3)).toBe(3)
    expect(accumulatorAlpha(acc)).toBeCloseTo(0, 12)
  })
})

describe('renderNowMs', () => {
  it('is (tick + alpha) * TICK_MS — sim time, never wall time', () => {
    expect(renderNowMs(0, 0)).toBe(0)
    expect(renderNowMs(600, 0)).toBe(10000)          // ten seconds of simulation
    expect(renderNowMs(60, 0)).toBeCloseTo(1000, 9)
    expect(renderNowMs(0, 0.5)).toBeCloseTo(TICK_MS / 2, 12)
    expect(renderNowMs(10, 0.25)).toBeCloseTo(10.25 * TICK_MS, 12)
  })

  it('increases strictly in both arguments', () => {
    expect(renderNowMs(10, 0.5)).toBeGreaterThan(renderNowMs(10, 0.25))
    expect(renderNowMs(11, 0)).toBeGreaterThan(renderNowMs(10, 0.999))
  })

  it('is what a fresh session would pass the interpolator on its first frame', () => {
    // §6.3, made visible: a guest that has run 5 ticks is 83 ms into the race in
    // SIM time. Passing a wall clock instead -- Date.now(), ~1.7e12 -- would put
    // the sample target billions of milliseconds past the newest keyframe, so
    // every remote kart would extrapolate, clamp at REMOTE_EXTRAPOLATE_CAP_MS
    // and slide forever. Nothing throws; it only looks wrong on a device.
    const acc = makeTickAccumulator()
    advanceAccumulator(acc, 5 * TICK_MS + 8)
    const nowMs = renderNowMs(5, accumulatorAlpha(acc))
    expect(nowMs).toBeGreaterThanOrEqual(5 * TICK_MS)
    expect(nowMs).toBeLessThan(6 * TICK_MS)
    expect(nowMs).toBeLessThan(1000)                 // nowhere near a wall clock
  })
})

describe('MAX_CATCHUP_TICKS', () => {
  it('is 5 — about 83 ms of catch-up', () => {
    // FIVE, not contract §5.1's 8. Asserted against the shipped constant, and
    // asserted at all because this number IS spec §11's death-spiral guard: a
    // task that "corrects" it upward to match the contract is widening the burst
    // a backgrounded tab is allowed to run in one frame.
    expect(MAX_CATCHUP_TICKS).toBe(5)
    expect(MAX_CATCHUP_TICKS * TICK_MS).toBeCloseTo(83.33, 2)
  })
})
```

**What each test catches, and whether it would actually fail under that bug.**

| Test | Bug it catches | Would it fail? |
|---|---|---|
| `is imported from @tapkart/net by game/src/clock.ts and by nothing else` | a second module importing `TICK_MS` — the first step toward a second timebase, and the thing §6.1 forbids in one sentence with no enforcement of its own. The paired positive assertion stops the sweep passing because `clock.ts` stopped importing it at all | Yes — it scans every `packages/*/src` tree except `net`'s (which *defines* it) on every run, and comments are stripped first so prose about `TICK_MS` is not an offence |
| `is never redefined outside @tapkart/net` | `const TICK_MS = 16.67` in a module that did not want the import: 16.67 ≠ 16.666…, and the drift is ~2 ms per 100 ticks | Yes |
| `is read by no module in content, render or game except clock.ts` | any module reaching for `Date.now()`/`performance.now()` directly, which makes it untestable without fake timers and makes its behaviour frame-rate dependent. Q30 rules out the environment change that would otherwise paper over it | Yes — repo-wide over three packages, comments stripped, plus a non-vacuity check that `clock.ts` itself still reads a real clock |
| `widens the DOM lib in its own tsconfig, and only there` | the tempting fix when `HTMLCanvasElement` will not resolve: adding DOM to `tsconfig.base.json`. That compiles everything and silently gives `sim`, `protocol`, `net` and `content` — the four packages `server` imports under plain Node — a browser dependency | Yes — it asserts the base is still `["ES2022"]` and that the four DOM-free packages set no `lib` of their own |
| `clamps a long stall to MAX_CATCHUP_TICKS and DISCARDS the rest` | banking the un-run ticks (`residual -= MAX * TICK_MS`), which returns 5 on every subsequent frame until it catches up — the spiral of death after a backgrounded tab | Yes — the two follow-up calls with zero elapsed must both return 0, and they return 5 under the bug |
| `conserves time exactly while it is not clamped` | the opposite defect: resetting the residual each frame, or dividing the frame's elapsed time instead of the accumulated total. A 100 fps display then runs **zero** ticks forever, because no single frame is a whole tick long | Yes — `total` is 0 under that bug, against an asserted 59, and the conservation identity fails by 1000 ms |
| `runs the same number of ticks at 60 Hz and at 120 Hz` | a loop that ties simulation to frames — the thing the fixed step exists to prevent, and the one that makes a race play at double speed on a 120 Hz phone | Yes — 600 vs 1200, and the 120 Hz run is asserted to idle on exactly 600 of its frames |
| `keeps the residual under one tick and alpha in [0, 1) under jitter` | a residual that grows without bound (an `if (whole > MAX)` branch that forgets to subtract), or an alpha that reaches 1 and makes `renderNowMs` name a tick that has not run | Yes — 20,000 jittered frames from 16 fps upward, asserted every iteration |
| `credits nothing for a negative elapsed` | crediting negative elapsed time, which drives `residualMs` negative and then returns a negative tick count from `Math.floor`. The caller computes the delta now, so a system time change reaches this function as a negative number rather than being absorbed by a re-based `lastNowMs` | Yes — the residual must be byte-identical after the −70 ms step, and the following frame must still run its 2 ticks |
| `is (tick + alpha) * TICK_MS — sim time, never wall time` + `is what a fresh session would pass the interpolator` | `renderNowMs` implemented against a wall clock, or `tick * TICK_MS + alpha` (a plausible slip). §6.3's failure is silent — every remote kart pins at the 200 ms extrapolation cap and nothing throws — so it has to be caught arithmetically | Yes — 10.25 × TICK_MS is asserted directly, and the sub-tick bracket `[5·TICK_MS, 6·TICK_MS)` fails for any wall-clock-derived value |
| `runs one tick for one 60 Hz frame` / `runs no tick when no time has passed` | an off-by-one in the floor, or a `>=` that fires a tick on a half-tick frame | Yes |
| `starts empty` / `is the sole writer of the accumulator` | a TickAccumulator that still carries `lastNowMs` — i.e. an implementation written against contract §5.1 rather than shipped code, whose frame loop would then be feeding an absolute clock reading to a function that wants a delta | Yes — `Object.keys(acc)` is asserted to equal `['residualMs']` exactly, before and after a write |
| `starts at 0 and moves only on advance` / `gives every clock its own time` | a fixed clock backed by module-scope state — the same class of defect as Plan 1's module-scope bot hold, which made `step` non-instanceable and stayed invisible until two rooms shared a process | Yes — two independent clocks are asserted to disagree |
| `declares the manifest §10 pins` | a dependency list that omits `@tapkart/protocol` (Q13) or `@tapkart/content` (R46), which fails much later as an unresolvable bare specifier in whichever task first names `WireKart` | Yes — `toEqual` on the whole dependency object |

---

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/game/`

Expected: FAIL — the workspace does not exist yet, so both files fail to collect:

```
Error: Cannot find module '../src/index' imported from '<repo>/packages/game/test/scaffold.test.ts'

Error: Cannot find module '../src/clock' imported from '<repo>/packages/game/test/clock.test.ts'
```

(`<repo>` is the absolute path of this working copy.) `Test Files 2 failed (2)`,
`Tests no tests`.

If instead the run reports `No test files found`, the two test files were written
somewhere the root `include` glob does not reach — they must be at
`packages/game/test/*.test.ts`.

---

- [ ] **Step 3: Write the implementation**

**3a.** Create `packages/game/package.json`:

```json
{
  "name": "@tapkart/game",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./shell": "./src/shell.ts"
  },
  "dependencies": {
    "@tapkart/sim": "*",
    "@tapkart/protocol": "*",
    "@tapkart/net": "*",
    "@tapkart/content": "*",
    "@tapkart/render": "*"
  },
  "devDependencies": {
    "vite": "^7.0.0"
  },
  "scripts": {
    "typecheck": "tsc --noEmit -p tsconfig.json"
  }
}
```

The `"./shell"` entry is declared now because §10 pins it: it is how `apps/web`
reaches `startShell` while `shell.ts` — a DOM adapter — stays out of the headless
barrel (§8.2). `src/shell.ts` itself arrives with the shell task; an `exports`
entry pointing at a file nobody has imported yet costs nothing. `vite` is a
devDependency because §5.14's `/// <reference types="vite/client" />` is what makes
`import.meta.env.DEV` typecheck, and Q32 puts a dev-build assertion behind it.

**3b.** Create `packages/game/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2022", "DOM", "DOM.Iterable"]
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

R35: DOM is widened **here**, never in `tsconfig.base.json`. `HTMLCanvasElement`,
`PointerEvent`, `DeviceOrientationEvent`, `EventTarget`, `localStorage` and
`performance` are all unresolvable under the base — and the base stays that way,
because `sim`, `protocol`, `net` and `content` are what `server` imports under
plain Node, and a DOM type leaking into them is how a "pure" package silently
acquires a browser dependency.

**3c.** Create `packages/game/src/clock.ts`:

```ts
// The only wall clock in the repository, and the only TICK_MS import in the
// repository.
//
// TICK_MS is @tapkart/net's (Q6) and is never redefined. `render` cannot import
// it -- render does not depend on net, and that omission is load-bearing (§1) --
// so the tick/millisecond bridge lives on the only side that can hold it (§4.1).
// render names milliseconds-per-tick nowhere at all; its one tick-to-seconds
// conversion uses TICK_DT from @tapkart/sim, a different constant with a
// different name.
//
// The whole accumulator is net's too (amendment 4): packages/server runs the same
// fixed-step pump, and net may not import game, so the function moved -- and the
// TYPE moved with it, because leaving the type here would have left net importing
// it from game, which is the one arrow §1 forbids. Only the type is named here,
// by accumulatorAlpha; makeTickAccumulator, advanceAccumulator and
// MAX_CATCHUP_TICKS are imported straight from @tapkart/net by their callers.
import { TICK_MS } from '@tapkart/net'
import type { TickAccumulator } from '@tapkart/net'

export interface FrameClock {
  nowMs(): number
}

/**
 * performance.now() when available, Date.now() otherwise. The ONE impure binding
 * in `render` and `game` combined -- everything else takes a FrameClock, which
 * is what makes the camera, the accumulator and the view builder assertable
 * under environment: 'node' with no fake timers (Q30).
 */
export const realFrameClock: FrameClock = {
  nowMs(): number {
    return typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now()
  },
}

/** Deterministic clock for tests: starts at `startMs` (default 0), moves only on
 *  advance(). Its time is per-instance, never module scope. */
export function makeFixedClock(startMs = 0): FrameClock & { advance(ms: number): void } {
  let nowMs = startMs
  return {
    nowMs(): number {
      return nowMs
    },
    advance(ms: number): void {
      nowMs += ms
    },
  }
}

/** Sub-tick fraction in [0, 1) for the frame that follows the ticks just run.
 *  §6.2: it is used for exactly three things -- camera sub-tick blending, Q9's
 *  lerp of state-sourced seats and entities, and renderNowMs. */
export function accumulatorAlpha(acc: TickAccumulator): number {
  return acc.residualMs / TICK_MS
}

/**
 * The tick-derived instant a frame represents: (tick + alpha) * TICK_MS.
 *
 * This is the ONLY value that may ever be passed as `nowMs` to
 * RemoteInterpolator.sampleKart / sampleEntity, because ClientLoop stamps every
 * keyframe `recvAtMs: tick * TICK_MS` -- so the interpolator's notion of "now" is
 * SIM time, not performance.now(). Pass a wall clock instead and the target
 * instant is thousands of milliseconds past the newest keyframe on the very first
 * frame: every remote kart takes the extrapolation branch, clamps at
 * REMOTE_EXTRAPOLATE_CAP_MS and slides along its last velocity forever. Nothing
 * throws and nothing logs.
 *
 * §6.3 removes the caller's opportunity rather than documenting the rule:
 * `nowMs` is not a parameter of anything in game's public surface, and
 * ViewBuilder.build(alpha, out) computes this internally.
 */
export function renderNowMs(tick: number, alpha: number): number {
  return (tick + alpha) * TICK_MS
}
```

**3d.** Create `packages/game/src/index.ts`:

```ts
// Public barrel for @tapkart/game.
//
// packages/game/package.json maps "." to this file, so this list IS the package's
// public surface. It grows one line per module as the tasks that ship them land
// (§5.15: controls/types, controls/config, controls/tilt, controls/composite,
// controls/index, settings, app, results, session, localinput, view -- and NOT
// roomcode, which retired: room codes are @tapkart/protocol's, because the
// alphabet's order is the 5-bit wire index).
//
// It will NEVER carry `controls/source` or `shell`: both are DOM adapters, and a
// barrel that re-exported them would break `import { reduceApp } from
// '@tapkart/game'` under vitest's environment: 'node' (§8.2). apps/web reaches
// startShell through the package's "./shell" export instead.
export * from './clock'
```

**3e.** Link the workspace, from the repository root:

```bash
npm install
```

---

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run packages/game/
```

Expected: PASS, 28 tests (5 in `scaffold.test.ts`, 23 in `clock.test.ts`).

Then the full gate — the typecheck is what proves R35's DOM widening actually
resolves `performance`, and the whole suite is what proves the two new repo-wide
scans do not fail against anything already shipped:

```bash
npm run typecheck --workspaces --if-present
npx vitest run
```

Both must be clean before Step 5. If `tsc` reports `TS2304: Cannot find name
'performance'`, the `lib` array in `packages/game/tsconfig.json` is wrong — fix it
there, **never** in `tsconfig.base.json`.

---

- [ ] **Step 5: Commit**

```bash
git add packages/game/package.json packages/game/tsconfig.json \
        packages/game/src/clock.ts packages/game/src/index.ts \
        packages/game/test/scaffold.test.ts packages/game/test/clock.test.ts \
        package-lock.json
git commit -m "feat(game): @tapkart/game workspace and the repository's only clock

clock.ts is the only wall clock in the repository and the only importer
of TICK_MS. Both were global constraints with no enforcement; they are
now two source scans that run on every vitest run, over every
packages/*/src tree, with comments stripped so prose about a clock is
not an offence and a second definition of the timebase is. Each scan
carries its own non-vacuity check, so it cannot pass by finding nothing.

TICK_MS is net's (Q6) because render cannot import it -- render does not
depend on net, and that omission is load-bearing -- so the
tick/millisecond bridge lives on the only side that can hold it. render
names milliseconds-per-tick nowhere at all; its one tick-to-seconds
conversion uses TICK_DT, a different constant with a different name.

TickAccumulator, makeTickAccumulator, advanceAccumulator and
MAX_CATCHUP_TICKS are @tapkart/net's (amendment 4): packages/server runs
the same fixed-step pump and net may not import game, so the function
moved rather than being written twice. The type moved with it -- leaving
the type here would have left net importing it from game, the one
inversion §1 forbids -- and the clamp moved because it is the number the
function applies. clock.ts keeps five exports and re-exports none of
net's, so each has one name and one import path.

Three of contract §5.1's statements about the accumulator are wrong
against shipped code and the tests are written to the shipped shape:
TickAccumulator has ONE field and no lastNowMs, advanceAccumulator takes
an elapsed DELTA rather than an absolute nowMs, and MAX_CATCHUP_TICKS is
5 rather than 8. The caller owns the previous timestamp, which is why
FrameClock and the frame loop sit on this side of the boundary.

The accumulator's behaviour is asserted here anyway, as consumption
tests: this plan's frame loop runs on the clamp-and-discard policy.
advanceAccumulator subtracts every whole tick from the residual whether
or not it ran it, so a backgrounded tab loses simulation instead of
owing it: a one-second stall runs 8 ticks and the next frame with no
elapsed time runs 0. The test asserts that follow-up 0, because the
banking version returns 8 forever and that is the spiral of death this
clamp exists to prevent. The opposite defect -- resetting the residual
each frame -- is caught by a conservation identity over 100 frames at
100 fps, where a per-frame implementation runs zero ticks and this one
runs 59. 600 frames at 60 Hz and 1200 at 120 Hz run the same 599 ticks.

renderNowMs is (tick + alpha) * TICK_MS and it is SIM time. ClientLoop
stamps keyframes recvAtMs = tick * TICK_MS, so a wall clock passed to
sampleKart puts the target thousands of milliseconds past the newest
keyframe, pins every remote kart at the 200 ms extrapolation cap, and
throws nothing and logs nothing -- it only looks wrong on a device.

DOM is widened in packages/game/tsconfig.json and nowhere else (R35).
The scaffold test asserts tsconfig.base.json still has no DOM and that
sim, protocol, net and content widen nothing, because the tempting fix
for an unresolvable HTMLCanvasElement is the one that silently gives the
four packages the server imports a browser dependency.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 18: `packages/game/src/controls/` — three touch schemes, keyboard, and the composite

**Files:**
- Create: `packages/game/src/controls/types.ts`
- Create: `packages/game/src/controls/config.ts`
- Create: `packages/game/src/controls/thumbzones.ts`
- Create: `packages/game/src/controls/tilt.ts`
- Create: `packages/game/src/controls/stick.ts`
- Create: `packages/game/src/controls/keyboard.ts`
- Create: `packages/game/src/controls/composite.ts`
- Create: `packages/game/src/controls/index.ts`
- Create: `packages/game/test/fixtures/game-fixtures.ts`
- Test: `packages/game/test/controls-config.test.ts`
- Test: `packages/game/test/controls-thumbzones.test.ts`
- Test: `packages/game/test/controls-tilt.test.ts`
- Test: `packages/game/test/controls-stick.test.ts`
- Test: `packages/game/test/controls-keyboard.test.ts`
- Test: `packages/game/test/controls-composite.test.ts`

Do **not** touch `packages/game/src/index.ts`. The barrel task (contract §5.15) re-exports
`controls/types`, `controls/config`, `controls/tilt`, `controls/composite` and `controls/index`
— and deliberately not `controls/thumbzones`, `controls/stick` or `controls/keyboard`, whose
factories reach the outside world only through `makeControlAdapter`.

`packages/game/test/fixtures/game-fixtures.ts` is **shared** with later tasks (contract §9.1
lists six exports for it). This task creates it with one export. Later tasks **append**; nobody
overwrites it.

**Interfaces:**

- Consumes, from `@tapkart/sim` (contract §2.1, §2.2 — all re-exported from the barrel
  `packages/sim/src/index.ts`):
  ```ts
  export interface Intent {
    tick: number
    steer: number      // -1..1
    accel: number      // 0..1
    brake: boolean
    drift: boolean
    useItem: boolean
  }
  export function clamp(v: number, lo: number, hi: number): number
  export function lerp(a: number, b: number, t: number): number   // a + (b - a) * t
  export const DRIFT_STEER_MIN = 0.35    // src/drift.ts — the drift-vs-brake threshold
  ```
- Consumes, from the task that created the `game` package (contract §10, §10.1):
  `packages/game/package.json` with `{"name": "@tapkart/game", "type": "module",
  "exports": {".": "./src/index.ts", "./shell": "./src/shell.ts"}, "dependencies":
  {"@tapkart/sim": "*", "@tapkart/protocol": "*", "@tapkart/net": "*", "@tapkart/content": "*",
  "@tapkart/render": "*"}}` and `packages/game/tsconfig.json` with
  `{"extends": "../../tsconfig.base.json", "compilerOptions": {"lib": ["ES2022","DOM","DOM.Iterable"]},
  "include": ["src/**/*.ts","test/**/*.ts"]}`. If either is missing, stop: this task cannot resolve
  `@tapkart/sim` by bare specifier without them.

- Produces (contract §5.5 — 26 exported symbols, exactly the census in §11):
  ```ts
  // controls/types.ts (9)
  export type ControlScheme = 'thumbZones' | 'tilt' | 'virtualStick'
  export type PointerPhase = 'down' | 'move' | 'up'
  export interface PointerSample { id: number; x: number; y: number; phase: PointerPhase }
  export interface TiltSample { alpha: number; beta: number; gamma: number }
  export interface Viewport { width: number; height: number }
  export const MAX_POINTERS = 8
  export interface ControlInputs {
    pointers: PointerSample[]; pointerCount: number
    keys: Record<string, boolean>; tilt: TiltSample | null; viewport: Viewport
  }
  export function createControlInputs(): ControlInputs
  export interface ControlAdapter {
    readonly scheme: ControlScheme
    sample(raw: ControlInputs, tick: number, out: Intent): void
    reset(): void
  }

  // controls/config.ts (11)
  export interface ControlConfig {
    deadZone: number; steerGain: number; steerSmoothingPerTick: number
    tiltNeutralDegrees: number; tiltRangeDegrees: number
    tiltCalibration: TiltCalibration; invertTilt: boolean
    keyBindings: Record<string, 'left' | 'right' | 'accel' | 'brake' | 'drift' | 'item'>
  }
  export const DEFAULT_CONTROL_CONFIG: Readonly<ControlConfig>
  export const TOUCH_BUTTON_SIZE_PX = 88
  export const TOUCH_BUTTON_MARGIN_PX = 16
  export const TOUCH_BUTTON_GAP_PX = 16
  export const THUMBZONE_FULL_LOCK_FRACTION = 0.28
  export const BRAKE_HOLD_TICKS = 18
  export interface Rect { x: number; y: number; w: number; h: number }
  export function driftButtonRect(v: Viewport, out: Rect): void
  export function itemButtonRect(v: Viewport, out: Rect): void
  export function rectContains(r: Rect, x: number, y: number): boolean

  // controls/tilt.ts (4)
  export interface TiltCalibration { betaZero: number; gammaZero: number }
  export const IDENTITY_TILT_CALIBRATION: Readonly<TiltCalibration>
  export function calibrateTilt(sample: TiltSample): TiltCalibration
  export function makeTiltAdapter(cfg: ControlConfig): ControlAdapter

  // controls/thumbzones.ts (1)
  export function makeThumbZonesAdapter(cfg: ControlConfig): ControlAdapter
  // controls/stick.ts (1)
  export function makeVirtualStickAdapter(cfg: ControlConfig): ControlAdapter
  // controls/keyboard.ts (1)
  export function makeKeyboardAdapter(cfg: ControlConfig): ControlAdapter

  // controls/composite.ts (2)
  export function mergeIntents(touch: Intent, keyboard: Intent, out: Intent): void
  export function makeCompositeAdapter(primary: ControlAdapter, secondary: ControlAdapter): ControlAdapter

  // controls/index.ts (1)
  export function makeControlAdapter(scheme: ControlScheme, cfg: ControlConfig): ControlAdapter
  ```
  ```ts
  // test/fixtures/game-fixtures.ts — test-only (contract §9.1)
  export function makeControlInputsFixture(overrides?: Partial<ControlInputs>): ControlInputs
  ```

**Two module-graph facts this task must not get wrong:**

1. **`config.ts` imports `TiltCalibration` from `tilt.ts` as a TYPE ONLY, and defines its own
   `{ betaZero: 0, gammaZero: 0 }` literal for `DEFAULT_CONTROL_CONFIG.tiltCalibration`.**
   `tilt.ts` imports *values* from `config.ts` (the button rects, `BRAKE_HOLD_TICKS`), so a value
   import in the other direction is a runtime ESM cycle: entering `tilt.ts` first evaluates
   `config.ts` while `tilt.ts`'s body has not run, and `DEFAULT_CONTROL_CONFIG` reads
   `IDENTITY_TILT_CALIBRATION` in its temporal dead zone — `ReferenceError` on import, before a
   single test runs. `import type` is erased under `verbatimModuleSyntax`, so the type edge costs
   nothing. The duplicated zero literal is kept honest by an assertion in
   `controls-tilt.test.ts` (`DEFAULT_CONTROL_CONFIG.tiltCalibration` deep-equals
   `IDENTITY_TILT_CALIBRATION`).
2. **Nothing in `controls/` except `source.ts` (Task 19) may name a DOM API.** These files run
   under `environment: 'node'`. No `window`, no `document`, no `addEventListener`.

- [ ] **Step 1: Write the failing test for `types.ts` and `config.ts`**

Create `packages/game/test/fixtures/game-fixtures.ts`:

```ts
// Shared test fixtures for @tapkart/game (contract §9.1).
//
// LATER TASKS APPEND TO THIS FILE. It is the one fixture module the game package
// has; overwriting it deletes another task's fixtures.
import type { ControlInputs } from '../../src/controls/types'
import { createControlInputs } from '../../src/controls/types'

/** A fully-allocated ControlInputs with a landscape viewport, no pointers down,
 *  no keys down and no tilt. `overrides` replaces whole fields, not deep merges. */
export function makeControlInputsFixture(overrides?: Partial<ControlInputs>): ControlInputs {
  const raw = createControlInputs()
  raw.viewport.width = 800
  raw.viewport.height = 400
  if (overrides === undefined) return raw
  if (overrides.pointers !== undefined) raw.pointers = overrides.pointers
  if (overrides.pointerCount !== undefined) raw.pointerCount = overrides.pointerCount
  if (overrides.keys !== undefined) raw.keys = overrides.keys
  if (overrides.tilt !== undefined) raw.tilt = overrides.tilt
  if (overrides.viewport !== undefined) raw.viewport = overrides.viewport
  return raw
}
```

Create `packages/game/test/controls-config.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { MAX_POINTERS, createControlInputs } from '../src/controls/types'
import {
  DEFAULT_CONTROL_CONFIG,
  TOUCH_BUTTON_SIZE_PX,
  TOUCH_BUTTON_MARGIN_PX,
  TOUCH_BUTTON_GAP_PX,
  THUMBZONE_FULL_LOCK_FRACTION,
  BRAKE_HOLD_TICKS,
  driftButtonRect,
  itemButtonRect,
  rectContains,
} from '../src/controls/config'
import type { Rect } from '../src/controls/config'
import { makeControlInputsFixture } from './fixtures/game-fixtures'

// The viewport every touch test in this task uses. 800x400 makes every rect
// coordinate an exact integer, so the numbers below are written out rather than
// recomputed from the constants - a test that recomputes the layout from the
// same constants the implementation uses cannot detect a wrong layout.
const W = 800
const H = 400
const VIEWPORT = { width: W, height: H }

function newRect(): Rect {
  return { x: 0, y: 0, w: 0, h: 0 }
}

describe('controls/types', () => {
  it('createControlInputs allocates MAX_POINTERS pointer slots and nothing live', () => {
    // CATCHES: a lazily-grown `pointers` array. The source (Task 19) writes into
    // `out.pointers[i]` without allocating; a short array silently drops touches.
    const raw = createControlInputs()
    expect(MAX_POINTERS).toBe(8)
    expect(raw.pointers).toHaveLength(MAX_POINTERS)
    expect(raw.pointerCount).toBe(0)
    expect(raw.tilt).toBeNull()
    expect(Object.keys(raw.keys)).toHaveLength(0)
  })

  it('gives every pointer slot its own object', () => {
    // CATCHES: `new Array(MAX_POINTERS).fill(sample)`, which aliases all eight
    // slots to one object, so two simultaneous touches read as one.
    const raw = createControlInputs()
    raw.pointers[0].x = 111
    expect(raw.pointers[1].x).toBe(0)
    expect(raw.pointers[0]).not.toBe(raw.pointers[1])
  })
})

describe('controls/config DEFAULT_CONTROL_CONFIG', () => {
  it('is the contract §5.5 default table, value by value', () => {
    // CATCHES: a tuning value drifting from the contract. Every number below is
    // load-bearing: deadZone and smoothing are asserted by exact arithmetic in
    // the adapter tests, so a changed default breaks them loudly, not silently.
    expect(DEFAULT_CONTROL_CONFIG.deadZone).toBe(0.06)
    expect(DEFAULT_CONTROL_CONFIG.steerGain).toBe(1)
    expect(DEFAULT_CONTROL_CONFIG.steerSmoothingPerTick).toBe(0.35)
    expect(DEFAULT_CONTROL_CONFIG.tiltNeutralDegrees).toBe(0)
    expect(DEFAULT_CONTROL_CONFIG.tiltRangeDegrees).toBe(25)
    expect(DEFAULT_CONTROL_CONFIG.invertTilt).toBe(false)
    expect(DEFAULT_CONTROL_CONFIG.tiltCalibration).toEqual({ betaZero: 0, gammaZero: 0 })
  })

  it('binds exactly the twelve documented key codes to their actions', () => {
    // CATCHES: a missing alternate binding (WASD or Space), which is invisible
    // until someone plays on a keyboard without arrow keys, and a binding typo'd
    // as a KeyboardEvent.key ('a') instead of a .code ('KeyA') - the adapter reads
    // .code, so 'a' would never match anything.
    expect(DEFAULT_CONTROL_CONFIG.keyBindings).toEqual({
      ArrowLeft: 'left',
      KeyA: 'left',
      ArrowRight: 'right',
      KeyD: 'right',
      ArrowUp: 'accel',
      KeyW: 'accel',
      ArrowDown: 'brake',
      KeyS: 'brake',
      ShiftLeft: 'drift',
      Space: 'drift',
      KeyE: 'item',
      ControlLeft: 'item',
    })
  })
})

describe('controls/config layout (Q24)', () => {
  it('exports the contract §5.5 layout constants', () => {
    expect(TOUCH_BUTTON_SIZE_PX).toBe(88)
    expect(TOUCH_BUTTON_MARGIN_PX).toBe(16)
    expect(TOUCH_BUTTON_GAP_PX).toBe(16)
    expect(THUMBZONE_FULL_LOCK_FRACTION).toBe(0.28)
    expect(BRAKE_HOLD_TICKS).toBe(18)
  })

  it('puts the drift button 16 px from the bottom and right edges', () => {
    // CATCHES: a rect measured from the top-left instead of the bottom-right, and
    // a margin applied to only one axis. Hard-coded expectations, not recomputed.
    const r = newRect()
    driftButtonRect(VIEWPORT, r)
    expect(r).toEqual({ x: 696, y: 296, w: 88, h: 88 })
  })

  it('puts the item button directly above the drift button with a 16 px gap', () => {
    // CATCHES: the item button placed beside (not above) the drift button, or
    // stacked with no gap - which would delete the dead space Q24 requires.
    const r = newRect()
    itemButtonRect(VIEWPORT, r)
    expect(r).toEqual({ x: 696, y: 192, w: 88, h: 88 })

    const drift = newRect()
    driftButtonRect(VIEWPORT, drift)
    expect(drift.y - (r.y + r.h)).toBe(TOUCH_BUTTON_GAP_PX)
    expect(r.x).toBe(drift.x)
  })

  it('writes into the caller-owned Rect and allocates nothing', () => {
    // CATCHES: a rect helper that returns a fresh object and leaves `out`
    // untouched - the frame path would then read a stale zero rect forever.
    const r = newRect()
    const same = r
    driftButtonRect(VIEWPORT, r)
    expect(same.w).toBe(88)
  })

  it('rectContains is half-open on the far edges', () => {
    // CATCHES: `<=` on the far edge, which makes adjacent controls overlap by one
    // pixel row - the exact ambiguity Q24's dead gap exists to remove.
    const r: Rect = { x: 10, y: 20, w: 100, h: 50 }
    expect(rectContains(r, 10, 20)).toBe(true)
    expect(rectContains(r, 109.999, 69.999)).toBe(true)
    expect(rectContains(r, 110, 40)).toBe(false)
    expect(rectContains(r, 40, 70)).toBe(false)
    expect(rectContains(r, 9.999, 40)).toBe(false)
    expect(rectContains(r, 40, 19.999)).toBe(false)
  })

  it('leaves a dead band between the two buttons that belongs to neither', () => {
    // CATCHES: nearest-button snapping. Q24: a touch in the gap presses NOTHING.
    // The band is y in [280, 296) at the buttons' x range.
    const drift = newRect()
    const item = newRect()
    driftButtonRect(VIEWPORT, drift)
    itemButtonRect(VIEWPORT, item)
    for (const y of [280, 285, 295.999]) {
      expect(rectContains(drift, 740, y)).toBe(false)
      expect(rectContains(item, 740, y)).toBe(false)
    }
  })
})

describe('game-fixtures makeControlInputsFixture', () => {
  it('defaults to the 800x400 landscape viewport with nothing pressed', () => {
    const raw = makeControlInputsFixture()
    expect(raw.viewport).toEqual({ width: W, height: H })
    expect(raw.pointerCount).toBe(0)
    expect(raw.pointers).toHaveLength(MAX_POINTERS)
  })

  it('applies overrides', () => {
    const raw = makeControlInputsFixture({ keys: { KeyW: true }, tilt: { alpha: 0, beta: 0, gamma: 5 } })
    expect(raw.keys.KeyW).toBe(true)
    expect(raw.tilt?.gamma).toBe(5)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/game/test/controls-config.test.ts`
Expected: FAIL with `Failed to resolve import "../src/controls/types" from "packages/game/test/controls-config.test.ts". Does the file exist?`

- [ ] **Step 3: Write `types.ts` and `config.ts`**

Create `packages/game/src/controls/types.ts`:

```ts
import type { Intent } from '@tapkart/sim'

/**
 * THREE schemes (spec §1: "3, selectable (plus keyboard for desktop)").
 * Keyboard is NOT a fourth: Q23 rules it a merge, not an alternative.
 */
export type ControlScheme = 'thumbZones' | 'tilt' | 'virtualStick'

export type PointerPhase = 'down' | 'move' | 'up'

export interface PointerSample {
  id: number // the browser's pointerId; stable for one touch
  x: number // CSS px from the viewport's left edge
  y: number // CSS px from the viewport's TOP edge
  phase: PointerPhase
}

export interface TiltSample { alpha: number; beta: number; gamma: number } // degrees

export interface Viewport { width: number; height: number } // CSS px

export const MAX_POINTERS = 8

/**
 * Raw, device-shaped input for ONE frame. Filled by the DOM source (§5.6) or by a
 * test, and consumed by exactly one ControlAdapter. `pointers` is fixed length
 * MAX_POINTERS; only [0, pointerCount) is live.
 */
export interface ControlInputs {
  pointers: PointerSample[]
  pointerCount: number
  keys: Record<string, boolean> // KeyboardEvent.code, e.g. 'ArrowLeft', 'KeyZ'
  tilt: TiltSample | null // null when unavailable or not permitted
  viewport: Viewport
}

/**
 * Allocates one ControlInputs with every pointer slot a DISTINCT object. Called
 * once, at startup: the drain path (§5.6) and every adapter reuse it forever, so
 * nothing in the frame path allocates.
 */
export function createControlInputs(): ControlInputs {
  const pointers: PointerSample[] = []
  for (let i = 0; i < MAX_POINTERS; i++) pointers.push({ id: -1, x: 0, y: 0, phase: 'up' })
  return { pointers, pointerCount: 0, keys: {}, tilt: null, viewport: { width: 0, height: 0 } }
}

/**
 * Every scheme is one of these and nothing more. Spec §6: "three schemes is three
 * small adapters, not three control systems."
 */
export interface ControlAdapter {
  readonly scheme: ControlScheme
  /**
   * Pure over (raw, tick, this adapter's own latched state). SOLE WRITER of `out`,
   * and it writes EVERY field of `out` including `out.tick = tick`.
   */
  sample(raw: ControlInputs, tick: number, out: Intent): void
  /**
   * Drops all latched state: drift hold, brake hold counter, stick origin, pointer
   * ids, item edge latch.
   */
  reset(): void
}
```

Create `packages/game/src/controls/config.ts`:

```ts
// TYPE-ONLY import of TiltCalibration, deliberately: tilt.ts imports this module's
// VALUES (the button rects, BRAKE_HOLD_TICKS), and a value import back would make a
// runtime ESM cycle whose symptom is a temporal-dead-zone ReferenceError at import
// time. `import type` is erased under verbatimModuleSyntax, so this edge is free.
// The cost is one duplicated zero literal below, and controls-tilt.test.ts asserts
// it equals IDENTITY_TILT_CALIBRATION.
import type { TiltCalibration } from './tilt'
import type { Viewport } from './types'

export interface ControlConfig {
  deadZone: number // 0..1 of the full-lock distance, below which steer is 0
  steerGain: number // multiplies the normalised steer axis before clamping
  steerSmoothingPerTick: number // 0..1 lerp toward the raw axis, once per sample()
  tiltNeutralDegrees: number
  tiltRangeDegrees: number // degrees from neutral to full lock
  tiltCalibration: TiltCalibration
  invertTilt: boolean
  keyBindings: Record<string, 'left' | 'right' | 'accel' | 'brake' | 'drift' | 'item'>
}

export const DEFAULT_CONTROL_CONFIG: Readonly<ControlConfig> = {
  deadZone: 0.06,
  steerGain: 1,
  steerSmoothingPerTick: 0.35,
  tiltNeutralDegrees: 0,
  tiltRangeDegrees: 25,
  tiltCalibration: { betaZero: 0, gammaZero: 0 }, // === IDENTITY_TILT_CALIBRATION
  invertTilt: false,
  keyBindings: {
    ArrowLeft: 'left',
    KeyA: 'left',
    ArrowRight: 'right',
    KeyD: 'right',
    ArrowUp: 'accel',
    KeyW: 'accel',
    ArrowDown: 'brake',
    KeyS: 'brake',
    ShiftLeft: 'drift',
    Space: 'drift',
    KeyE: 'item',
    ControlLeft: 'item',
  },
}

// Q24's layout, in CSS px, shared by thumbZones and tilt so their buttons cannot
// disagree by a pixel. virtualStick reuses both rects and places its gas and brake
// buttons one column to the left of them, from these same constants.
export const TOUCH_BUTTON_SIZE_PX = 88
export const TOUCH_BUTTON_MARGIN_PX = 16
export const TOUCH_BUTTON_GAP_PX = 16

/** Full lock at 28 % of the half-width, measured from the touch-down origin. */
export const THUMBZONE_FULL_LOCK_FRACTION = 0.28

/** Q21's brake: ticks the drift button must be held before it also brakes. */
export const BRAKE_HOLD_TICKS = 18 // 0.3 s at 60 Hz

export interface Rect { x: number; y: number; w: number; h: number } // CSS px, y down

/** Bottom-right, TOUCH_BUTTON_MARGIN_PX from both edges. */
export function driftButtonRect(v: Viewport, out: Rect): void {
  out.x = v.width - TOUCH_BUTTON_MARGIN_PX - TOUCH_BUTTON_SIZE_PX
  out.y = v.height - TOUCH_BUTTON_MARGIN_PX - TOUCH_BUTTON_SIZE_PX
  out.w = TOUCH_BUTTON_SIZE_PX
  out.h = TOUCH_BUTTON_SIZE_PX
}

/** Directly above the drift button, TOUCH_BUTTON_GAP_PX of dead space between. */
export function itemButtonRect(v: Viewport, out: Rect): void {
  driftButtonRect(v, out)
  out.y -= TOUCH_BUTTON_GAP_PX + TOUCH_BUTTON_SIZE_PX
}

/** Half-open on the far edges: x in [r.x, r.x + r.w), y in [r.y, r.y + r.h). */
export function rectContains(r: Rect, x: number, y: number): boolean {
  return x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/game/test/controls-config.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Write the failing test for `thumbzones.ts`**

Create `packages/game/test/controls-thumbzones.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import type { Intent } from '@tapkart/sim'
import { DRIFT_STEER_MIN } from '@tapkart/sim'
import type { ControlInputs, PointerPhase } from '../src/controls/types'
import { BRAKE_HOLD_TICKS, DEFAULT_CONTROL_CONFIG } from '../src/controls/config'
import { makeThumbZonesAdapter } from '../src/controls/thumbzones'
import { makeControlInputsFixture } from './fixtures/game-fixtures'

// 800x400. Half-width 400, so full lock is 400 * 0.28 = 112 px from the origin.
// The buttons are drift [696,784)x[296,384) and item [696,784)x[192,280), with a
// dead band at y in [280,296).
const LOCK_PX = 112

function poisonedIntent(): Intent {
  // Every field set to a value the adapter must overwrite. A `sample` that writes
  // only the fields it "changed" leaves useItem true here, and a latched useItem
  // fires every item the instant it is granted, forever.
  return { tick: -999, steer: 999, accel: -999, brake: true, drift: true, useItem: true }
}

function point(raw: ControlInputs, id: number, x: number, y: number, phase: PointerPhase): void {
  const p = raw.pointers[raw.pointerCount]
  p.id = id
  p.x = x
  p.y = y
  p.phase = phase
  raw.pointerCount++
}

/** One frame: hand the adapter the pending pointer events, then clear them. */
function step(adapter: ReturnType<typeof makeThumbZonesAdapter>, raw: ControlInputs,
              tick: number, out: Intent): void {
  adapter.sample(raw, tick, out)
  raw.pointerCount = 0
}

describe('thumbZones steering (Q24)', () => {
  it('is relative to the touch-down origin: a thumb landing off-centre does not steer', () => {
    // THE Q24 TEST. Under absolute steering, a touch at x=60 is (60-400)/112 =
    // -3.04 -> clamped -1 -> steer -0.35 on the first tick and a hard-left jerk.
    // Under relative steering it is exactly 0 and stays 0 while the thumb is still.
    const a = makeThumbZonesAdapter(DEFAULT_CONTROL_CONFIG)
    const raw = makeControlInputsFixture()
    const out = poisonedIntent()
    point(raw, 1, 60, 200, 'down')
    step(a, raw, 0, out)
    expect(out.steer).toBe(0)
    for (let t = 1; t <= 5; t++) {
      step(a, raw, t, out)
      expect(out.steer).toBe(0)
    }
  })

  it('overwrites every field of `out`, including the ones it did not change', () => {
    // CATCHES: a partial writer. `out` is the Intent the session submits; a stale
    // useItem or brake from a previous frame is indistinguishable from a press.
    const a = makeThumbZonesAdapter(DEFAULT_CONTROL_CONFIG)
    const raw = makeControlInputsFixture()
    const out = poisonedIntent()
    step(a, raw, 42, out)
    expect(out).toEqual({ tick: 42, steer: 0, accel: 1, brake: false, drift: false, useItem: false })
  })

  it('reaches full lock at 28 % of the HALF-width and smooths at 0.35 per tick', () => {
    // CATCHES: normalising against the full width (which would halve the response),
    // and a missing or wrong smoothing factor. The first three values are exact
    // arithmetic on lerp(prev, 1, 0.35): 0.35, 0.5775, 0.725375.
    const a = makeThumbZonesAdapter(DEFAULT_CONTROL_CONFIG)
    const raw = makeControlInputsFixture()
    const out = poisonedIntent()
    point(raw, 1, 200, 200, 'down')
    step(a, raw, 0, out)
    point(raw, 1, 200 + LOCK_PX, 200, 'move')
    step(a, raw, 1, out)
    expect(out.steer).toBeCloseTo(0.35, 9)
    step(a, raw, 2, out)
    expect(out.steer).toBeCloseTo(0.5775, 9)
    step(a, raw, 3, out)
    expect(out.steer).toBeCloseTo(0.725375, 9)
    for (let t = 4; t <= 24; t++) step(a, raw, t, out)
    expect(out.steer).toBeGreaterThan(0.999)
    expect(out.steer).toBeLessThanOrEqual(1)
  })

  it('half the full-lock distance converges to half lock', () => {
    // CATCHES: a normalisation that is right at the extremes and wrong in between
    // (e.g. squared or stepped response). Under the full-width bug this converges
    // to 0.25 and fails.
    const a = makeThumbZonesAdapter(DEFAULT_CONTROL_CONFIG)
    const raw = makeControlInputsFixture()
    const out = poisonedIntent()
    point(raw, 1, 200, 200, 'down')
    step(a, raw, 0, out)
    point(raw, 1, 200 - LOCK_PX / 2, 200, 'move')
    for (let t = 1; t <= 24; t++) step(a, raw, t, out)
    expect(out.steer).toBeCloseTo(-0.5, 3)
  })

  it('clamps past full lock and never leaves [-1, 1]', () => {
    const a = makeThumbZonesAdapter(DEFAULT_CONTROL_CONFIG)
    const raw = makeControlInputsFixture()
    const out = poisonedIntent()
    point(raw, 1, 350, 200, 'down')
    step(a, raw, 0, out)
    point(raw, 1, -5000, 200, 'move')
    for (let t = 1; t <= 40; t++) {
      step(a, raw, t, out)
      expect(out.steer).toBeGreaterThanOrEqual(-1)
      expect(out.steer).toBeLessThanOrEqual(1)
    }
    expect(out.steer).toBeLessThan(-0.999)
  })

  it('applies the dead zone to the raw axis, not the smoothed output', () => {
    // CATCHES: a dead zone tested against the smoothed value, which would swallow
    // the first two ticks of EVERY steer input. 6 px / 112 px = 0.0536 (dead);
    // 8 px / 112 px = 0.0714 (live, and 0.35 of it is 0.025).
    const dead = makeThumbZonesAdapter(DEFAULT_CONTROL_CONFIG)
    const rawDead = makeControlInputsFixture()
    const outDead = poisonedIntent()
    point(rawDead, 1, 200, 200, 'down')
    step(dead, rawDead, 0, outDead)
    point(rawDead, 1, 206, 200, 'move')
    for (let t = 1; t <= 10; t++) step(dead, rawDead, t, outDead)
    expect(outDead.steer).toBe(0)

    const live = makeThumbZonesAdapter(DEFAULT_CONTROL_CONFIG)
    const rawLive = makeControlInputsFixture()
    const outLive = poisonedIntent()
    point(rawLive, 1, 200, 200, 'down')
    step(live, rawLive, 0, outLive)
    point(rawLive, 1, 208, 200, 'move')
    step(live, rawLive, 1, outLive)
    expect(outLive.steer).toBeCloseTo(0.025, 9)
  })

  it('returns to centre when the steering thumb lifts', () => {
    const a = makeThumbZonesAdapter(DEFAULT_CONTROL_CONFIG)
    const raw = makeControlInputsFixture()
    const out = poisonedIntent()
    point(raw, 1, 200, 200, 'down')
    step(a, raw, 0, out)
    point(raw, 1, 200 + LOCK_PX, 200, 'move')
    for (let t = 1; t <= 20; t++) step(a, raw, t, out)
    expect(out.steer).toBeGreaterThan(0.99)
    point(raw, 1, 200 + LOCK_PX, 200, 'up')
    for (let t = 21; t <= 60; t++) step(a, raw, t, out)
    expect(out.steer).toBeCloseTo(0, 6)
  })

  it('never produces NaN on a zero-sized viewport', () => {
    // CATCHES: division by a zero half-width on the first frame, before the shell
    // has measured the canvas. NaN in the smoother is permanent: it survives every
    // subsequent lerp and the kart never steers again for the whole session.
    const a = makeThumbZonesAdapter(DEFAULT_CONTROL_CONFIG)
    const raw = makeControlInputsFixture({ viewport: { width: 0, height: 0 } })
    const out = poisonedIntent()
    point(raw, 1, 0, 0, 'down')
    step(a, raw, 0, out)
    point(raw, 1, 50, 0, 'move')
    step(a, raw, 1, out)
    expect(Number.isNaN(out.steer)).toBe(false)
    expect(out.steer).toBe(0)
  })
})

describe('thumbZones buttons (Q24, Q25)', () => {
  it('holds drift while the drift button is down and auto-accelerates throughout', () => {
    const a = makeThumbZonesAdapter(DEFAULT_CONTROL_CONFIG)
    const raw = makeControlInputsFixture()
    const out = poisonedIntent()
    point(raw, 2, 740, 340, 'down')
    step(a, raw, 0, out)
    expect(out.drift).toBe(true)
    expect(out.accel).toBe(1)
    step(a, raw, 1, out)
    expect(out.drift).toBe(true)
    point(raw, 2, 740, 340, 'up')
    step(a, raw, 2, out)
    expect(out.drift).toBe(false)
  })

  it('fires useItem on exactly one tick per press (Q25)', () => {
    // CATCHES a LEVEL instead of an EDGE. A single-tick test cannot tell the two
    // apart, so this one holds the button for five ticks, then releases and
    // re-presses. A level implementation reports true on all six.
    const a = makeThumbZonesAdapter(DEFAULT_CONTROL_CONFIG)
    const raw = makeControlInputsFixture()
    const out = poisonedIntent()
    const fired: number[] = []
    point(raw, 3, 740, 240, 'down')
    for (let t = 0; t <= 5; t++) {
      step(a, raw, t, out)
      if (out.useItem) fired.push(t)
    }
    point(raw, 3, 740, 240, 'up')
    step(a, raw, 6, out)
    if (out.useItem) fired.push(6)
    point(raw, 3, 740, 240, 'down')
    step(a, raw, 7, out)
    if (out.useItem) fired.push(7)
    expect(fired).toEqual([0, 7])
  })

  it('presses NEITHER button for a touch in the gap between them (Q24)', () => {
    // CATCHES nearest-button snapping. y in [280,296) is dead space; a snapping
    // implementation fires drift or item here and the player cannot tell why.
    const a = makeThumbZonesAdapter(DEFAULT_CONTROL_CONFIG)
    const raw = makeControlInputsFixture()
    const out = poisonedIntent()
    point(raw, 4, 740, 288, 'down')
    for (let t = 0; t <= 30; t++) {
      step(a, raw, t, out)
      expect(out.drift).toBe(false)
      expect(out.useItem).toBe(false)
      expect(out.brake).toBe(false)
      expect(out.steer).toBe(0)
    }
  })

  it('ignores a right-half touch that is not inside a button', () => {
    const a = makeThumbZonesAdapter(DEFAULT_CONTROL_CONFIG)
    const raw = makeControlInputsFixture()
    const out = poisonedIntent()
    point(raw, 5, 500, 100, 'down')
    point(raw, 5, 520, 100, 'move')
    step(a, raw, 0, out)
    expect(out).toEqual({ tick: 0, steer: 0, accel: 1, brake: false, drift: false, useItem: false })
  })

  it('keeps a touch with the control it started on, even when it slides away', () => {
    // CATCHES per-move re-routing. A thumb that starts on drift and drifts 400 px
    // left must keep drifting and must NOT hijack steering; re-routing drops the
    // drift mid-corner, which reads as the game ignoring the player.
    const a = makeThumbZonesAdapter(DEFAULT_CONTROL_CONFIG)
    const raw = makeControlInputsFixture()
    const out = poisonedIntent()
    point(raw, 6, 740, 340, 'down')
    step(a, raw, 0, out)
    point(raw, 6, 100, 100, 'move')
    for (let t = 1; t <= 10; t++) step(a, raw, t, out)
    expect(out.drift).toBe(true)
    expect(out.steer).toBe(0)
  })

  it('tracks two simultaneous touches: steering thumb plus drift button', () => {
    const a = makeThumbZonesAdapter(DEFAULT_CONTROL_CONFIG)
    const raw = makeControlInputsFixture()
    const out = poisonedIntent()
    point(raw, 7, 200, 200, 'down')
    point(raw, 8, 740, 340, 'down')
    step(a, raw, 0, out)
    point(raw, 7, 200 + LOCK_PX, 200, 'move')
    for (let t = 1; t <= 20; t++) step(a, raw, t, out)
    expect(out.drift).toBe(true)
    expect(out.steer).toBeGreaterThan(0.99)
  })
})

describe('thumbZones brake on a drift long-press (Q21)', () => {
  it('brakes on the 18th consecutive tick of a straight-line hold, not before', () => {
    // CATCHES an off-by-one on BRAKE_HOLD_TICKS and a brake wired to the press
    // edge. `drift` must stay true the whole time: a brake that replaces the drift
    // would pass a brake-only assertion and break drifting.
    const a = makeThumbZonesAdapter(DEFAULT_CONTROL_CONFIG)
    const raw = makeControlInputsFixture()
    const out = poisonedIntent()
    point(raw, 9, 740, 340, 'down')
    for (let t = 0; t < BRAKE_HOLD_TICKS - 1; t++) {
      step(a, raw, t, out)
      expect(out.brake).toBe(false)
      expect(out.drift).toBe(true)
    }
    step(a, raw, BRAKE_HOLD_TICKS - 1, out)
    expect(out.brake).toBe(true)
    expect(out.drift).toBe(true)
  })

  it('does not brake while the thumb is turning, and starts once it straightens', () => {
    // THE Q21 QUALIFIER TEST. |steer| >= DRIFT_STEER_MIN means the hold is a drift,
    // not a brake. A test that only held the button straight would pass with the
    // qualifier missing entirely; this one holds it at full lock for well past the
    // threshold, then releases the steering thumb and watches the brake appear as
    // the smoothed steer decays below 0.35.
    const a = makeThumbZonesAdapter(DEFAULT_CONTROL_CONFIG)
    const raw = makeControlInputsFixture()
    const out = poisonedIntent()
    point(raw, 10, 200, 200, 'down')
    point(raw, 11, 740, 340, 'down')
    step(a, raw, 0, out)
    point(raw, 10, 200 + LOCK_PX, 200, 'move')
    for (let t = 1; t <= 40; t++) {
      step(a, raw, t, out)
      expect(out.brake).toBe(false)
    }
    expect(out.steer).toBeGreaterThan(DRIFT_STEER_MIN)
    expect(out.drift).toBe(true)

    point(raw, 10, 200 + LOCK_PX, 200, 'up')
    let brakingAt = -1
    for (let t = 41; t <= 60; t++) {
      step(a, raw, t, out)
      if (out.brake && brakingAt === -1) brakingAt = t
    }
    expect(brakingAt).toBeGreaterThan(-1)
    expect(Math.abs(out.steer)).toBeLessThan(DRIFT_STEER_MIN)
  })

  it('restarts the hold counter when the button is released', () => {
    const a = makeThumbZonesAdapter(DEFAULT_CONTROL_CONFIG)
    const raw = makeControlInputsFixture()
    const out = poisonedIntent()
    point(raw, 12, 740, 340, 'down')
    for (let t = 0; t < 17; t++) step(a, raw, t, out)
    point(raw, 12, 740, 340, 'up')
    step(a, raw, 17, out)
    expect(out.brake).toBe(false)
    point(raw, 12, 740, 340, 'down')
    for (let t = 18; t < 18 + BRAKE_HOLD_TICKS - 1; t++) {
      step(a, raw, t, out)
      expect(out.brake).toBe(false)
    }
    step(a, raw, 100, out)
    expect(out.brake).toBe(true)
  })
})

describe('thumbZones reset', () => {
  it('drops the steer smoothing, the pointer claims, the hold counter and the item latch', () => {
    // CATCHES a partial reset. The item latch is the subtle one: if reset() leaves
    // it set, the first press after a race never fires.
    const a = makeThumbZonesAdapter(DEFAULT_CONTROL_CONFIG)
    const raw = makeControlInputsFixture()
    const out = poisonedIntent()
    point(raw, 13, 200, 200, 'down')
    point(raw, 14, 740, 340, 'down')
    point(raw, 15, 740, 240, 'down')
    step(a, raw, 0, out)
    point(raw, 13, 200 + LOCK_PX, 200, 'move')
    for (let t = 1; t <= 20; t++) step(a, raw, t, out)
    expect(out.steer).toBeGreaterThan(0.99)
    expect(out.drift).toBe(true)
    expect(out.brake).toBe(false)

    a.reset()
    step(a, raw, 21, out)
    expect(out).toEqual({ tick: 21, steer: 0, accel: 1, brake: false, drift: false, useItem: false })

    point(raw, 16, 740, 240, 'down')
    step(a, raw, 22, out)
    expect(out.useItem).toBe(true)
  })
})

describe('thumbZones scheme identity', () => {
  it('reports its scheme', () => {
    expect(makeThumbZonesAdapter(DEFAULT_CONTROL_CONFIG).scheme).toBe('thumbZones')
  })
})
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `npx vitest run packages/game/test/controls-thumbzones.test.ts`
Expected: FAIL with `Failed to resolve import "../src/controls/thumbzones" from "packages/game/test/controls-thumbzones.test.ts". Does the file exist?`

- [ ] **Step 7: Write `thumbzones.ts`**

Create `packages/game/src/controls/thumbzones.ts`:

```ts
import type { Intent } from '@tapkart/sim'
import { DRIFT_STEER_MIN, clamp, lerp } from '@tapkart/sim'
import type { ControlAdapter, ControlInputs, Viewport } from './types'
import type { ControlConfig, Rect } from './config'
import {
  BRAKE_HOLD_TICKS,
  THUMBZONE_FULL_LOCK_FRACTION,
  driftButtonRect,
  itemButtonRect,
  rectContains,
} from './config'

/**
 * Auto-accelerate + thumb zones (spec §6, the default scheme).
 *
 * Steering is RELATIVE to the touch-down origin (Q24): full lock at
 * THUMBZONE_FULL_LOCK_FRACTION of the half-width away from where the thumb landed.
 * Absolute steering would jerk the kart to full lock the instant a thumb landed
 * anywhere but the exact screen centre.
 *
 * The right half holds two 88 px buttons with 16 px of dead space between them. A
 * touch landing in that gap belongs to NEITHER button, and a touch that starts on a
 * control keeps that control for its whole life, even if it slides out.
 *
 * `accel` is always 1, including under motion lock (Q21): `sim` ignores input while
 * `motionLocked`, so the adapter has no reason to lie about what the player is
 * doing, and the HUD reads `motionLocked` rather than `accel`.
 */
export function makeThumbZonesAdapter(cfg: ControlConfig): ControlAdapter {
  // Scratch, allocated once. Nothing below allocates per tick.
  const driftRect: Rect = { x: 0, y: 0, w: 0, h: 0 }
  const itemRect: Rect = { x: 0, y: 0, w: 0, h: 0 }

  let steerId = -1
  let driftId = -1
  let itemId = -1
  let originX = 0
  let currentX = 0
  let driftHeldTicks = 0
  let steer = 0

  function steerAxis(v: Viewport): number {
    if (steerId === -1) return 0
    const lockPx = v.width * 0.5 * THUMBZONE_FULL_LOCK_FRACTION
    if (!(lockPx > 0)) return 0 // pre-measure frame: no viewport, no steering, no NaN
    return clamp((currentX - originX) / lockPx, -1, 1)
  }

  return {
    scheme: 'thumbZones',

    sample(raw: ControlInputs, tick: number, out: Intent): void {
      driftButtonRect(raw.viewport, driftRect)
      itemButtonRect(raw.viewport, itemRect)

      let itemPulse = false

      for (let i = 0; i < raw.pointerCount; i++) {
        const p = raw.pointers[i]
        if (p.phase === 'down') {
          if (rectContains(driftRect, p.x, p.y)) {
            if (driftId === -1) driftId = p.id
          } else if (rectContains(itemRect, p.x, p.y)) {
            if (itemId === -1) {
              itemId = p.id
              itemPulse = true // Q25: one-tick pulse on the press edge
            }
          } else if (steerId === -1 && p.x < raw.viewport.width * 0.5) {
            steerId = p.id
            originX = p.x
            currentX = p.x
          }
          // Anything else - the inter-button gap, the right half outside a button -
          // belongs to nothing. Dead space is the correct answer (Q24).
        } else if (p.phase === 'move') {
          // A move never re-routes a touch: only the steering thumb reads position.
          if (p.id === steerId) currentX = p.x
        } else {
          if (p.id === steerId) steerId = -1
          if (p.id === driftId) driftId = -1
          if (p.id === itemId) itemId = -1
        }
      }

      let axis = steerAxis(raw.viewport)
      if (Math.abs(axis) < cfg.deadZone) axis = 0
      const target = clamp(axis * cfg.steerGain, -1, 1)
      steer = clamp(lerp(steer, target, cfg.steerSmoothingPerTick), -1, 1)

      const drift = driftId !== -1
      driftHeldTicks = drift ? driftHeldTicks + 1 : 0

      out.tick = tick
      out.steer = steer
      out.accel = 1
      // Q21: a long press brakes only when the thumb is straight. `updateDrift`
      // engages a drift at |steer| >= DRIFT_STEER_MIN, so the same constant - sim's
      // own, imported - is what separates "held while turning" from "held straight".
      out.brake = driftHeldTicks >= BRAKE_HOLD_TICKS && Math.abs(steer) < DRIFT_STEER_MIN
      out.drift = drift
      out.useItem = itemPulse
    },

    reset(): void {
      steerId = -1
      driftId = -1
      itemId = -1
      originX = 0
      currentX = 0
      driftHeldTicks = 0
      steer = 0
    },
  }
}
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `npx vitest run packages/game/test/controls-thumbzones.test.ts`
Expected: PASS, 19 tests.

- [ ] **Step 9: Write the failing test for `tilt.ts`**

Create `packages/game/test/controls-tilt.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import type { Intent } from '@tapkart/sim'
import { DRIFT_STEER_MIN } from '@tapkart/sim'
import type { ControlConfig } from '../src/controls/config'
import { BRAKE_HOLD_TICKS, DEFAULT_CONTROL_CONFIG } from '../src/controls/config'
import type { ControlInputs, PointerPhase } from '../src/controls/types'
import { IDENTITY_TILT_CALIBRATION, calibrateTilt, makeTiltAdapter } from '../src/controls/tilt'
import { makeControlInputsFixture } from './fixtures/game-fixtures'

function poisonedIntent(): Intent {
  return { tick: -999, steer: 999, accel: -999, brake: true, drift: true, useItem: true }
}

function point(raw: ControlInputs, id: number, x: number, y: number, phase: PointerPhase): void {
  const p = raw.pointers[raw.pointerCount]
  p.id = id
  p.x = x
  p.y = y
  p.phase = phase
  raw.pointerCount++
}

function step(a: ReturnType<typeof makeTiltAdapter>, raw: ControlInputs, tick: number, out: Intent): void {
  a.sample(raw, tick, out)
  raw.pointerCount = 0
}

function withCfg(overrides: Partial<ControlConfig>): ControlConfig {
  return { ...DEFAULT_CONTROL_CONFIG, ...overrides }
}

/** Settles the smoother: 24 ticks of the same tilt reaches the target to 1e-4. */
function settle(a: ReturnType<typeof makeTiltAdapter>, raw: ControlInputs, out: Intent): void {
  for (let t = 0; t < 24; t++) step(a, raw, t, out)
}

describe('tilt calibration', () => {
  it('IDENTITY_TILT_CALIBRATION is zero on both axes and equals the shipped default config', () => {
    // CATCHES the one hazard of config.ts holding its own copy of this literal
    // (it must, to avoid a runtime import cycle): the two drifting apart.
    expect(IDENTITY_TILT_CALIBRATION).toEqual({ betaZero: 0, gammaZero: 0 })
    expect(DEFAULT_CONTROL_CONFIG.tiltCalibration).toEqual(IDENTITY_TILT_CALIBRATION)
  })

  it('calibrateTilt records the held sample as the new zero', () => {
    // CATCHES swapping beta and gamma, which points steering at the pitch axis and
    // makes the game unplayable in exactly the way nobody debugs quickly.
    expect(calibrateTilt({ alpha: 33, beta: 12, gamma: -7 })).toEqual({ betaZero: 12, gammaZero: -7 })
  })
})

describe('tilt steering', () => {
  it('maps gamma to a full-lock axis over tiltRangeDegrees', () => {
    // CATCHES a wrong range constant or a degrees/radians mix-up: at gamma = 25
    // with tiltRangeDegrees 25 the axis is exactly 1, and the smoother converges
    // to it. First tick is the exact lerp value, 0.35.
    const a = makeTiltAdapter(DEFAULT_CONTROL_CONFIG)
    const raw = makeControlInputsFixture({ tilt: { alpha: 0, beta: 0, gamma: 25 } })
    const out = poisonedIntent()
    step(a, raw, 0, out)
    expect(out.steer).toBeCloseTo(0.35, 9)
    settle(a, raw, out)
    expect(out.steer).toBeGreaterThan(0.999)
  })

  it('is proportional in between and clamps beyond full lock', () => {
    const half = makeTiltAdapter(DEFAULT_CONTROL_CONFIG)
    const rawHalf = makeControlInputsFixture({ tilt: { alpha: 0, beta: 0, gamma: -12.5 } })
    const outHalf = poisonedIntent()
    settle(half, rawHalf, outHalf)
    expect(outHalf.steer).toBeCloseTo(-0.5, 3)

    const past = makeTiltAdapter(DEFAULT_CONTROL_CONFIG)
    const rawPast = makeControlInputsFixture({ tilt: { alpha: 0, beta: 0, gamma: 400 } })
    const outPast = poisonedIntent()
    settle(past, rawPast, outPast)
    expect(outPast.steer).toBeLessThanOrEqual(1)
    expect(outPast.steer).toBeGreaterThan(0.999)
  })

  it('measures gamma from the calibration zero, not from zero degrees', () => {
    // CATCHES ignoring the calibration. A player who calibrated at gamma = -8 is
    // holding the phone level; without the offset the kart steers permanently left
    // and the calibration flow is decoration.
    const cfg = withCfg({ tiltCalibration: calibrateTilt({ alpha: 0, beta: 10, gamma: -8 }) })
    const a = makeTiltAdapter(cfg)
    const raw = makeControlInputsFixture({ tilt: { alpha: 0, beta: 10, gamma: -8 } })
    const out = poisonedIntent()
    settle(a, raw, out)
    expect(out.steer).toBe(0)

    const b = makeTiltAdapter(cfg)
    const rawB = makeControlInputsFixture({ tilt: { alpha: 0, beta: 10, gamma: 17 } })
    const outB = poisonedIntent()
    settle(b, rawB, outB)
    expect(outB.steer).toBeGreaterThan(0.999)
  })

  it('inverts the axis when invertTilt is set', () => {
    // CATCHES an inversion applied to the wrong side of the clamp or dropped
    // entirely - and it uses a NON-symmetric value so a sign bug cannot pass.
    const a = makeTiltAdapter(withCfg({ invertTilt: true }))
    const raw = makeControlInputsFixture({ tilt: { alpha: 0, beta: 0, gamma: 12.5 } })
    const out = poisonedIntent()
    settle(a, raw, out)
    expect(out.steer).toBeCloseTo(-0.5, 3)
  })

  it('applies the dead zone around the calibrated neutral', () => {
    // 1 degree / 25 = 0.04 (dead); 2 degrees / 25 = 0.08 (live, 0.35 of it = 0.028).
    const dead = makeTiltAdapter(DEFAULT_CONTROL_CONFIG)
    const rawDead = makeControlInputsFixture({ tilt: { alpha: 0, beta: 0, gamma: 1 } })
    const outDead = poisonedIntent()
    settle(dead, rawDead, outDead)
    expect(outDead.steer).toBe(0)

    const live = makeTiltAdapter(DEFAULT_CONTROL_CONFIG)
    const rawLive = makeControlInputsFixture({ tilt: { alpha: 0, beta: 0, gamma: 2 } })
    const outLive = poisonedIntent()
    step(live, rawLive, 0, outLive)
    expect(outLive.steer).toBeCloseTo(0.028, 9)
  })

  it('steers straight when tilt is unavailable, and writes every field of out', () => {
    // CATCHES a null dereference on the permission-denied path (Q22 leaves
    // `tilt: null` for a whole session) and a partial write of `out`.
    const a = makeTiltAdapter(DEFAULT_CONTROL_CONFIG)
    const raw = makeControlInputsFixture({ tilt: null })
    const out = poisonedIntent()
    step(a, raw, 7, out)
    expect(out).toEqual({ tick: 7, steer: 0, accel: 1, brake: false, drift: false, useItem: false })
  })

  it('decays to centre when tilt data stops arriving', () => {
    const a = makeTiltAdapter(DEFAULT_CONTROL_CONFIG)
    const raw = makeControlInputsFixture({ tilt: { alpha: 0, beta: 0, gamma: 25 } })
    const out = poisonedIntent()
    settle(a, raw, out)
    raw.tilt = null
    for (let t = 24; t < 60; t++) step(a, raw, t, out)
    expect(out.steer).toBeCloseTo(0, 6)
  })

  it('does not steer from touches: the left half is not a thumb zone here', () => {
    // CATCHES copy-paste of thumbZones' steering into the tilt adapter, which
    // would give the player two steering inputs fighting each other.
    const a = makeTiltAdapter(DEFAULT_CONTROL_CONFIG)
    const raw = makeControlInputsFixture({ tilt: null })
    const out = poisonedIntent()
    point(raw, 1, 100, 200, 'down')
    step(a, raw, 0, out)
    point(raw, 1, 380, 200, 'move')
    for (let t = 1; t <= 20; t++) step(a, raw, t, out)
    expect(out.steer).toBe(0)
  })
})

describe('tilt buttons (shared layout with thumbZones)', () => {
  it('uses the same drift and item rects and the same dead gap', () => {
    const a = makeTiltAdapter(DEFAULT_CONTROL_CONFIG)
    const raw = makeControlInputsFixture({ tilt: null })
    const out = poisonedIntent()
    point(raw, 2, 740, 340, 'down')
    step(a, raw, 0, out)
    expect(out.drift).toBe(true)
    point(raw, 2, 740, 340, 'up')
    point(raw, 3, 740, 240, 'down')
    step(a, raw, 1, out)
    expect(out.drift).toBe(false)
    expect(out.useItem).toBe(true)
    step(a, raw, 2, out)
    expect(out.useItem).toBe(false)

    point(raw, 3, 740, 240, 'up')
    point(raw, 4, 740, 288, 'down')
    step(a, raw, 3, out)
    expect(out.drift).toBe(false)
    expect(out.useItem).toBe(false)
  })

  it('brakes on a long drift press only while the phone is held level (Q21)', () => {
    // Same qualifier as thumbZones, driven by the gyro instead of a thumb: held
    // level the hold brakes, tilted to full lock it does not.
    const level = makeTiltAdapter(DEFAULT_CONTROL_CONFIG)
    const rawLevel = makeControlInputsFixture({ tilt: { alpha: 0, beta: 0, gamma: 0 } })
    const outLevel = poisonedIntent()
    point(rawLevel, 5, 740, 340, 'down')
    for (let t = 0; t < BRAKE_HOLD_TICKS - 1; t++) {
      step(level, rawLevel, t, outLevel)
      expect(outLevel.brake).toBe(false)
    }
    step(level, rawLevel, BRAKE_HOLD_TICKS - 1, outLevel)
    expect(outLevel.brake).toBe(true)
    expect(outLevel.drift).toBe(true)

    const turning = makeTiltAdapter(DEFAULT_CONTROL_CONFIG)
    const rawTurning = makeControlInputsFixture({ tilt: { alpha: 0, beta: 0, gamma: 25 } })
    const outTurning = poisonedIntent()
    point(rawTurning, 6, 740, 340, 'down')
    for (let t = 0; t < 40; t++) {
      step(turning, rawTurning, t, outTurning)
      expect(outTurning.brake).toBe(false)
    }
    expect(outTurning.steer).toBeGreaterThan(DRIFT_STEER_MIN)
    expect(outTurning.drift).toBe(true)
  })
})

describe('tilt reset and identity', () => {
  it('reports its scheme and drops every latch on reset', () => {
    const a = makeTiltAdapter(DEFAULT_CONTROL_CONFIG)
    expect(a.scheme).toBe('tilt')
    const raw = makeControlInputsFixture({ tilt: { alpha: 0, beta: 0, gamma: 25 } })
    const out = poisonedIntent()
    point(raw, 7, 740, 340, 'down')
    point(raw, 8, 740, 240, 'down')
    for (let t = 0; t < 24; t++) step(a, raw, t, out)
    expect(out.steer).toBeGreaterThan(0.99)
    expect(out.drift).toBe(true)

    a.reset()
    raw.tilt = null
    step(a, raw, 24, out)
    expect(out).toEqual({ tick: 24, steer: 0, accel: 1, brake: false, drift: false, useItem: false })
    point(raw, 9, 740, 240, 'down')
    step(a, raw, 25, out)
    expect(out.useItem).toBe(true)
  })
})
```

- [ ] **Step 10: Run the test to verify it fails**

Run: `npx vitest run packages/game/test/controls-tilt.test.ts`
Expected: FAIL with `Failed to resolve import "../src/controls/tilt" from "packages/game/test/controls-tilt.test.ts". Does the file exist?`

- [ ] **Step 11: Write `tilt.ts`**

Create `packages/game/src/controls/tilt.ts`:

```ts
import type { Intent } from '@tapkart/sim'
import { DRIFT_STEER_MIN, clamp, lerp } from '@tapkart/sim'
import type { ControlAdapter, ControlInputs, TiltSample } from './types'
import type { ControlConfig, Rect } from './config'
import { BRAKE_HOLD_TICKS, driftButtonRect, itemButtonRect, rectContains } from './config'

export interface TiltCalibration { betaZero: number; gammaZero: number } // degrees

export const IDENTITY_TILT_CALIBRATION: Readonly<TiltCalibration> = { betaZero: 0, gammaZero: 0 }

/** Pure: the sample the player held while the calibration prompt was up. */
export function calibrateTilt(sample: TiltSample): TiltCalibration {
  return { betaZero: sample.beta, gammaZero: sample.gamma }
}

/**
 * Tilt steering with the thumbZones button layout (spec §6, offered not default).
 *
 * `gamma` is roll, which is the axis a phone held in landscape rotates about when
 * the player steers. The neutral point is `cfg.tiltCalibration.gammaZero`, written
 * by `calibrateTilt` from the sample the player held during calibration - which is
 * why `cfg.tiltNeutralDegrees` is not read here: the calibration IS the neutral,
 * and adding a second offset would give one fact two owners.
 *
 * `tilt === null` (unsupported, or Q22's permission denied) steers straight. It
 * never silently falls back to another scheme: that decision belongs to the
 * settings screen, which reverts the selection and says why.
 */
export function makeTiltAdapter(cfg: ControlConfig): ControlAdapter {
  const driftRect: Rect = { x: 0, y: 0, w: 0, h: 0 }
  const itemRect: Rect = { x: 0, y: 0, w: 0, h: 0 }

  let driftId = -1
  let itemId = -1
  let driftHeldTicks = 0
  let steer = 0

  return {
    scheme: 'tilt',

    sample(raw: ControlInputs, tick: number, out: Intent): void {
      driftButtonRect(raw.viewport, driftRect)
      itemButtonRect(raw.viewport, itemRect)

      let itemPulse = false

      for (let i = 0; i < raw.pointerCount; i++) {
        const p = raw.pointers[i]
        if (p.phase === 'down') {
          if (rectContains(driftRect, p.x, p.y)) {
            if (driftId === -1) driftId = p.id
          } else if (rectContains(itemRect, p.x, p.y)) {
            if (itemId === -1) {
              itemId = p.id
              itemPulse = true
            }
          }
          // No steering zone in this scheme, and the gap belongs to neither button.
        } else if (p.phase === 'up') {
          if (p.id === driftId) driftId = -1
          if (p.id === itemId) itemId = -1
        }
      }

      let axis = 0
      if (raw.tilt !== null && cfg.tiltRangeDegrees > 0) {
        axis = clamp((raw.tilt.gamma - cfg.tiltCalibration.gammaZero) / cfg.tiltRangeDegrees, -1, 1)
        if (cfg.invertTilt) axis = -axis
      }
      if (Math.abs(axis) < cfg.deadZone) axis = 0
      const target = clamp(axis * cfg.steerGain, -1, 1)
      steer = clamp(lerp(steer, target, cfg.steerSmoothingPerTick), -1, 1)

      const drift = driftId !== -1
      driftHeldTicks = drift ? driftHeldTicks + 1 : 0

      out.tick = tick
      out.steer = steer
      out.accel = 1
      out.brake = driftHeldTicks >= BRAKE_HOLD_TICKS && Math.abs(steer) < DRIFT_STEER_MIN
      out.drift = drift
      out.useItem = itemPulse
    },

    reset(): void {
      driftId = -1
      itemId = -1
      driftHeldTicks = 0
      steer = 0
    },
  }
}
```

- [ ] **Step 12: Run the test to verify it passes**

Run: `npx vitest run packages/game/test/controls-tilt.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 13: Write the failing test for `stick.ts`**

Create `packages/game/test/controls-stick.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import type { Intent } from '@tapkart/sim'
import type { ControlInputs, PointerPhase } from '../src/controls/types'
import { DEFAULT_CONTROL_CONFIG } from '../src/controls/config'
import { makeVirtualStickAdapter } from '../src/controls/stick'
import { makeControlInputsFixture } from './fixtures/game-fixtures'

// 800x400, so the four buttons are a 2x2 cluster in the bottom-right corner:
//   gas   [592,680) x [296,384)      drift [696,784) x [296,384)
//   brake [592,680) x [192,280)      item  [696,784) x [192,280)
// with 16 px of dead space on both axes between them.
const GAS = { x: 636, y: 340 }
const BRAKE = { x: 636, y: 236 }
const DRIFT = { x: 740, y: 340 }
const ITEM = { x: 740, y: 236 }
const LOCK_PX = 112

function poisonedIntent(): Intent {
  return { tick: -999, steer: 999, accel: -999, brake: true, drift: true, useItem: true }
}

function point(raw: ControlInputs, id: number, x: number, y: number, phase: PointerPhase): void {
  const p = raw.pointers[raw.pointerCount]
  p.id = id
  p.x = x
  p.y = y
  p.phase = phase
  raw.pointerCount++
}

function step(a: ReturnType<typeof makeVirtualStickAdapter>, raw: ControlInputs,
              tick: number, out: Intent): void {
  a.sample(raw, tick, out)
  raw.pointerCount = 0
}

describe('virtualStick pedals', () => {
  it('does NOT auto-accelerate: no gas button, no throttle', () => {
    // CATCHES the copy-paste from thumbZones/tilt, where accel is hard-wired to 1.
    // Under that bug this scheme's gas pedal does nothing and the kart never stops.
    const a = makeVirtualStickAdapter(DEFAULT_CONTROL_CONFIG)
    const raw = makeControlInputsFixture()
    const out = poisonedIntent()
    step(a, raw, 3, out)
    expect(out).toEqual({ tick: 3, steer: 0, accel: 0, brake: false, drift: false, useItem: false })
  })

  it('accelerates while the gas button is held and stops when it lifts', () => {
    const a = makeVirtualStickAdapter(DEFAULT_CONTROL_CONFIG)
    const raw = makeControlInputsFixture()
    const out = poisonedIntent()
    point(raw, 1, GAS.x, GAS.y, 'down')
    step(a, raw, 0, out)
    expect(out.accel).toBe(1)
    step(a, raw, 1, out)
    expect(out.accel).toBe(1)
    point(raw, 1, GAS.x, GAS.y, 'up')
    step(a, raw, 2, out)
    expect(out.accel).toBe(0)
  })

  it('brakes on the press, with no hold threshold', () => {
    // CATCHES the long-press brake leaking into this scheme. virtualStick has an
    // explicit brake pedal (contract §5.5 table), so a threshold here would make
    // the pedal feel broken for its first 0.3 s.
    const a = makeVirtualStickAdapter(DEFAULT_CONTROL_CONFIG)
    const raw = makeControlInputsFixture()
    const out = poisonedIntent()
    point(raw, 2, BRAKE.x, BRAKE.y, 'down')
    step(a, raw, 0, out)
    expect(out.brake).toBe(true)
    expect(out.drift).toBe(false)
    point(raw, 2, BRAKE.x, BRAKE.y, 'up')
    step(a, raw, 1, out)
    expect(out.brake).toBe(false)
  })

  it('never turns a long drift hold into a brake', () => {
    // CATCHES the Q21 rule being applied to the wrong scheme. 40 straight-line
    // ticks is well past BRAKE_HOLD_TICKS; brake must stay false throughout.
    const a = makeVirtualStickAdapter(DEFAULT_CONTROL_CONFIG)
    const raw = makeControlInputsFixture()
    const out = poisonedIntent()
    point(raw, 3, DRIFT.x, DRIFT.y, 'down')
    for (let t = 0; t < 40; t++) {
      step(a, raw, t, out)
      expect(out.drift).toBe(true)
      expect(out.brake).toBe(false)
    }
  })

  it('fires useItem on exactly one tick per press', () => {
    const a = makeVirtualStickAdapter(DEFAULT_CONTROL_CONFIG)
    const raw = makeControlInputsFixture()
    const out = poisonedIntent()
    const fired: number[] = []
    point(raw, 4, ITEM.x, ITEM.y, 'down')
    for (let t = 0; t <= 4; t++) {
      step(a, raw, t, out)
      if (out.useItem) fired.push(t)
    }
    point(raw, 4, ITEM.x, ITEM.y, 'up')
    step(a, raw, 5, out)
    point(raw, 4, ITEM.x, ITEM.y, 'down')
    step(a, raw, 6, out)
    if (out.useItem) fired.push(6)
    expect(fired).toEqual([0, 6])
  })

  it('holds all four controls at once', () => {
    // CATCHES a router that claims one pointer per frame, or that lets a later
    // button overwrite an earlier one - a stick player holds gas and drift together
    // for the whole race.
    const a = makeVirtualStickAdapter(DEFAULT_CONTROL_CONFIG)
    const raw = makeControlInputsFixture()
    const out = poisonedIntent()
    point(raw, 5, GAS.x, GAS.y, 'down')
    point(raw, 6, DRIFT.x, DRIFT.y, 'down')
    point(raw, 7, ITEM.x, ITEM.y, 'down')
    point(raw, 8, BRAKE.x, BRAKE.y, 'down')
    step(a, raw, 0, out)
    expect(out.accel).toBe(1)
    expect(out.drift).toBe(true)
    expect(out.brake).toBe(true)
    expect(out.useItem).toBe(true)
  })

  it('leaves dead space between the buttons on both axes', () => {
    // CATCHES a cluster laid out with no gaps, where a thumb between gas and drift
    // fires one of them at random. x in [680,696) and y in [280,296) are dead.
    const a = makeVirtualStickAdapter(DEFAULT_CONTROL_CONFIG)
    const raw = makeControlInputsFixture()
    const out = poisonedIntent()
    for (const p of [{ x: 688, y: 340 }, { x: 740, y: 288 }, { x: 688, y: 288 }]) {
      a.reset()
      point(raw, 9, p.x, p.y, 'down')
      step(a, raw, 0, out)
      expect(out.accel).toBe(0)
      expect(out.brake).toBe(false)
      expect(out.drift).toBe(false)
      expect(out.useItem).toBe(false)
    }
  })
})

describe('virtualStick steering', () => {
  it('takes its origin from the touch-down point, like thumbZones', () => {
    // CATCHES an absolute stick, where planting a thumb at the left edge is
    // instant full lock.
    const a = makeVirtualStickAdapter(DEFAULT_CONTROL_CONFIG)
    const raw = makeControlInputsFixture()
    const out = poisonedIntent()
    point(raw, 10, 40, 300, 'down')
    step(a, raw, 0, out)
    expect(out.steer).toBe(0)
    for (let t = 1; t <= 5; t++) {
      step(a, raw, t, out)
      expect(out.steer).toBe(0)
    }
  })

  it('reaches full lock 28 % of a half-width from the origin', () => {
    const a = makeVirtualStickAdapter(DEFAULT_CONTROL_CONFIG)
    const raw = makeControlInputsFixture()
    const out = poisonedIntent()
    point(raw, 11, 200, 300, 'down')
    step(a, raw, 0, out)
    point(raw, 11, 200 - LOCK_PX, 300, 'move')
    step(a, raw, 1, out)
    expect(out.steer).toBeCloseTo(-0.35, 9)
    for (let t = 2; t <= 24; t++) step(a, raw, t, out)
    expect(out.steer).toBeLessThan(-0.999)
    expect(out.steer).toBeGreaterThanOrEqual(-1)
  })

  it('does not let a pedal touch steer', () => {
    const a = makeVirtualStickAdapter(DEFAULT_CONTROL_CONFIG)
    const raw = makeControlInputsFixture()
    const out = poisonedIntent()
    point(raw, 12, GAS.x, GAS.y, 'down')
    step(a, raw, 0, out)
    point(raw, 12, 100, 300, 'move')
    for (let t = 1; t <= 10; t++) step(a, raw, t, out)
    expect(out.steer).toBe(0)
    expect(out.accel).toBe(1)
  })
})

describe('virtualStick reset and identity', () => {
  it('reports its scheme and drops every latch', () => {
    const a = makeVirtualStickAdapter(DEFAULT_CONTROL_CONFIG)
    expect(a.scheme).toBe('virtualStick')
    const raw = makeControlInputsFixture()
    const out = poisonedIntent()
    point(raw, 13, 200, 300, 'down')
    point(raw, 14, GAS.x, GAS.y, 'down')
    point(raw, 15, ITEM.x, ITEM.y, 'down')
    step(a, raw, 0, out)
    point(raw, 13, 200 + LOCK_PX, 300, 'move')
    for (let t = 1; t <= 20; t++) step(a, raw, t, out)
    expect(out.steer).toBeGreaterThan(0.99)
    expect(out.accel).toBe(1)

    a.reset()
    step(a, raw, 21, out)
    expect(out).toEqual({ tick: 21, steer: 0, accel: 0, brake: false, drift: false, useItem: false })
    point(raw, 16, ITEM.x, ITEM.y, 'down')
    step(a, raw, 22, out)
    expect(out.useItem).toBe(true)
  })
})
```

- [ ] **Step 14: Run the test to verify it fails**

Run: `npx vitest run packages/game/test/controls-stick.test.ts`
Expected: FAIL with `Failed to resolve import "../src/controls/stick" from "packages/game/test/controls-stick.test.ts". Does the file exist?`

- [ ] **Step 15: Write `stick.ts`**

Create `packages/game/src/controls/stick.ts`:

```ts
import type { Intent } from '@tapkart/sim'
import { clamp, lerp } from '@tapkart/sim'
import type { ControlAdapter, ControlInputs, Viewport } from './types'
import type { ControlConfig, Rect } from './config'
import {
  THUMBZONE_FULL_LOCK_FRACTION,
  TOUCH_BUTTON_GAP_PX,
  TOUCH_BUTTON_SIZE_PX,
  driftButtonRect,
  itemButtonRect,
  rectContains,
} from './config'

/**
 * Gas: one column left of the drift button, same row. Not exported - only this
 * scheme has pedals, and §5.5 exports rects only for the two buttons thumbZones and
 * tilt share. Derived from the same constants, so the cluster cannot disagree with
 * the shared layout by a pixel.
 */
function gasButtonRect(v: Viewport, out: Rect): void {
  driftButtonRect(v, out)
  out.x -= TOUCH_BUTTON_GAP_PX + TOUCH_BUTTON_SIZE_PX
}

/** Brake: one column left of the item button, same row. */
function brakeButtonRect(v: Viewport, out: Rect): void {
  itemButtonRect(v, out)
  out.x -= TOUCH_BUTTON_GAP_PX + TOUCH_BUTTON_SIZE_PX
}

/**
 * Virtual stick + pedals (spec §6: "most control, most screen occlusion").
 *
 * The stick is the left half, relative to touch-down, normalised exactly as
 * thumbZones is. The right half is a 2x2 pedal cluster - gas and drift on the
 * bottom row, brake and item above them - with dead space on both axes.
 *
 * This scheme has an explicit brake pedal, so Q21's drift long-press does NOT
 * apply: a long drift hold here is a drift and nothing else.
 */
export function makeVirtualStickAdapter(cfg: ControlConfig): ControlAdapter {
  const driftRect: Rect = { x: 0, y: 0, w: 0, h: 0 }
  const itemRect: Rect = { x: 0, y: 0, w: 0, h: 0 }
  const gasRect: Rect = { x: 0, y: 0, w: 0, h: 0 }
  const brakeRect: Rect = { x: 0, y: 0, w: 0, h: 0 }

  let stickId = -1
  let gasId = -1
  let brakeId = -1
  let driftId = -1
  let itemId = -1
  let originX = 0
  let currentX = 0
  let steer = 0

  function steerAxis(v: Viewport): number {
    if (stickId === -1) return 0
    const lockPx = v.width * 0.5 * THUMBZONE_FULL_LOCK_FRACTION
    if (!(lockPx > 0)) return 0
    return clamp((currentX - originX) / lockPx, -1, 1)
  }

  return {
    scheme: 'virtualStick',

    sample(raw: ControlInputs, tick: number, out: Intent): void {
      driftButtonRect(raw.viewport, driftRect)
      itemButtonRect(raw.viewport, itemRect)
      gasButtonRect(raw.viewport, gasRect)
      brakeButtonRect(raw.viewport, brakeRect)

      let itemPulse = false

      for (let i = 0; i < raw.pointerCount; i++) {
        const p = raw.pointers[i]
        if (p.phase === 'down') {
          if (rectContains(driftRect, p.x, p.y)) {
            if (driftId === -1) driftId = p.id
          } else if (rectContains(itemRect, p.x, p.y)) {
            if (itemId === -1) {
              itemId = p.id
              itemPulse = true
            }
          } else if (rectContains(gasRect, p.x, p.y)) {
            if (gasId === -1) gasId = p.id
          } else if (rectContains(brakeRect, p.x, p.y)) {
            if (brakeId === -1) brakeId = p.id
          } else if (stickId === -1 && p.x < raw.viewport.width * 0.5) {
            stickId = p.id
            originX = p.x
            currentX = p.x
          }
        } else if (p.phase === 'move') {
          if (p.id === stickId) currentX = p.x
        } else {
          if (p.id === stickId) stickId = -1
          if (p.id === gasId) gasId = -1
          if (p.id === brakeId) brakeId = -1
          if (p.id === driftId) driftId = -1
          if (p.id === itemId) itemId = -1
        }
      }

      let axis = steerAxis(raw.viewport)
      if (Math.abs(axis) < cfg.deadZone) axis = 0
      const target = clamp(axis * cfg.steerGain, -1, 1)
      steer = clamp(lerp(steer, target, cfg.steerSmoothingPerTick), -1, 1)

      out.tick = tick
      out.steer = steer
      out.accel = gasId !== -1 ? 1 : 0
      out.brake = brakeId !== -1
      out.drift = driftId !== -1
      out.useItem = itemPulse
    },

    reset(): void {
      stickId = -1
      gasId = -1
      brakeId = -1
      driftId = -1
      itemId = -1
      originX = 0
      currentX = 0
      steer = 0
    },
  }
}
```

- [ ] **Step 16: Run the test to verify it passes**

Run: `npx vitest run packages/game/test/controls-stick.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 17: Write the failing test for `keyboard.ts`**

Create `packages/game/test/controls-keyboard.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import type { Intent } from '@tapkart/sim'
import type { ControlInputs } from '../src/controls/types'
import { DEFAULT_CONTROL_CONFIG } from '../src/controls/config'
import { makeKeyboardAdapter } from '../src/controls/keyboard'
import { makeControlInputsFixture } from './fixtures/game-fixtures'

function poisonedIntent(): Intent {
  return { tick: -999, steer: 999, accel: -999, brake: true, drift: true, useItem: true }
}

function withKeys(...codes: string[]): ControlInputs {
  const keys: Record<string, boolean> = {}
  for (const c of codes) keys[c] = true
  return makeControlInputsFixture({ keys })
}

describe('keyboard adapter', () => {
  it('reports nothing pressed and writes every field of out', () => {
    const a = makeKeyboardAdapter(DEFAULT_CONTROL_CONFIG)
    const out = poisonedIntent()
    a.sample(withKeys(), 11, out)
    expect(out).toEqual({ tick: 11, steer: 0, accel: 0, brake: false, drift: false, useItem: false })
  })

  it('steers from the arrow keys and smooths at the same rate as touch', () => {
    // CATCHES an unsmoothed keyboard, which would make the merge rule
    // (greater |steer| wins) resolve to the keyboard on the first tick of every
    // touch input, because touch starts at 0.35 and a raw keyboard would be 1.
    const a = makeKeyboardAdapter(DEFAULT_CONTROL_CONFIG)
    const out = poisonedIntent()
    const raw = withKeys('ArrowLeft')
    a.sample(raw, 0, out)
    expect(out.steer).toBeCloseTo(-0.35, 9)
    a.sample(raw, 1, out)
    expect(out.steer).toBeCloseTo(-0.5775, 9)
    for (let t = 2; t < 30; t++) a.sample(raw, t, out)
    expect(out.steer).toBeLessThan(-0.999)
    expect(out.steer).toBeGreaterThanOrEqual(-1)
  })

  it('cancels to zero when both directions are held', () => {
    // CATCHES a "last key wins" implementation, which sticks at full lock when a
    // player rolls from one arrow to the other.
    const a = makeKeyboardAdapter(DEFAULT_CONTROL_CONFIG)
    const out = poisonedIntent()
    const raw = withKeys('ArrowLeft', 'ArrowRight')
    for (let t = 0; t < 10; t++) a.sample(raw, t, out)
    expect(out.steer).toBe(0)
  })

  it('honours every alternate binding in the default table', () => {
    // CATCHES a hard-coded arrow-key reader that ignores cfg.keyBindings; WASD is
    // half the desktop players and would silently do nothing.
    const a = makeKeyboardAdapter(DEFAULT_CONTROL_CONFIG)
    const out = poisonedIntent()
    a.sample(withKeys('KeyA'), 0, out)
    expect(out.steer).toBeCloseTo(-0.35, 9)

    const b = makeKeyboardAdapter(DEFAULT_CONTROL_CONFIG)
    b.sample(withKeys('KeyD'), 0, out)
    expect(out.steer).toBeCloseTo(0.35, 9)

    const c = makeKeyboardAdapter(DEFAULT_CONTROL_CONFIG)
    c.sample(withKeys('KeyW'), 0, out)
    expect(out.accel).toBe(1)
    c.sample(withKeys('ArrowUp'), 1, out)
    expect(out.accel).toBe(1)

    const d = makeKeyboardAdapter(DEFAULT_CONTROL_CONFIG)
    d.sample(withKeys('KeyS'), 0, out)
    expect(out.brake).toBe(true)
    d.sample(withKeys('ArrowDown'), 1, out)
    expect(out.brake).toBe(true)

    const e = makeKeyboardAdapter(DEFAULT_CONTROL_CONFIG)
    e.sample(withKeys('Space'), 0, out)
    expect(out.drift).toBe(true)
    e.sample(withKeys('ShiftLeft'), 1, out)
    expect(out.drift).toBe(true)

    const f = makeKeyboardAdapter(DEFAULT_CONTROL_CONFIG)
    f.sample(withKeys('ControlLeft'), 0, out)
    expect(out.useItem).toBe(true)
  })

  it('respects a custom binding table', () => {
    const a = makeKeyboardAdapter({
      ...DEFAULT_CONTROL_CONFIG,
      keyBindings: { KeyJ: 'left', KeyL: 'right', KeyI: 'accel' },
    })
    const out = poisonedIntent()
    a.sample(withKeys('KeyJ', 'KeyI'), 0, out)
    expect(out.steer).toBeCloseTo(-0.35, 9)
    expect(out.accel).toBe(1)
    // ArrowLeft is unbound in this table, so the target is 0 and the smoothed
    // -0.35 decays to lerp(-0.35, 0, 0.35) = -0.2275. Under a hard-coded arrow
    // reader it would instead deepen to -0.5775.
    a.sample(withKeys('ArrowLeft'), 1, out)
    expect(out.steer).toBeCloseTo(-0.2275, 9)
    expect(out.accel).toBe(0)
  })

  it('ignores unbound keys and keys explicitly reported as up', () => {
    // CATCHES `if (raw.keys[code] !== undefined)`, which treats a keyup-recorded
    // `false` as a press - so every key ever touched stays down for the session.
    const a = makeKeyboardAdapter(DEFAULT_CONTROL_CONFIG)
    const out = poisonedIntent()
    a.sample(makeControlInputsFixture({ keys: { KeyQ: true, ArrowLeft: false, KeyW: false } }), 0, out)
    expect(out.steer).toBe(0)
    expect(out.accel).toBe(0)
  })

  it('fires useItem on exactly one tick per press (Q25)', () => {
    // Held for four ticks, released, pressed again: a level implementation reports
    // true five times, this asserts exactly two.
    const a = makeKeyboardAdapter(DEFAULT_CONTROL_CONFIG)
    const out = poisonedIntent()
    const held = withKeys('KeyE')
    const idle = withKeys()
    const fired: number[] = []
    for (let t = 0; t <= 3; t++) {
      a.sample(held, t, out)
      if (out.useItem) fired.push(t)
    }
    a.sample(idle, 4, out)
    if (out.useItem) fired.push(4)
    a.sample(held, 5, out)
    if (out.useItem) fired.push(5)
    expect(fired).toEqual([0, 5])
  })

  it('reports its scheme and drops the smoothing and item latch on reset', () => {
    // The keyboard adapter is always the composite's secondary, so its scheme is
    // never the one the player selected; thumbZones is the harmless default.
    const a = makeKeyboardAdapter(DEFAULT_CONTROL_CONFIG)
    expect(a.scheme).toBe('thumbZones')
    const out = poisonedIntent()
    const held = withKeys('ArrowLeft', 'KeyE')
    for (let t = 0; t < 20; t++) a.sample(held, t, out)
    expect(out.steer).toBeLessThan(-0.99)
    expect(out.useItem).toBe(false)

    a.reset()
    a.sample(held, 20, out)
    expect(out.steer).toBeCloseTo(-0.35, 9)
    expect(out.useItem).toBe(true)
  })
})
```

- [ ] **Step 18: Run the test to verify it fails**

Run: `npx vitest run packages/game/test/controls-keyboard.test.ts`
Expected: FAIL with `Failed to resolve import "../src/controls/keyboard" from "packages/game/test/controls-keyboard.test.ts". Does the file exist?`

- [ ] **Step 19: Write `keyboard.ts`**

Create `packages/game/src/controls/keyboard.ts`:

```ts
import type { Intent } from '@tapkart/sim'
import { clamp, lerp } from '@tapkart/sim'
import type { ControlAdapter, ControlInputs } from './types'
import type { ControlConfig } from './config'

/**
 * Keyboard, merged into every scheme by makeCompositeAdapter (Q23). Spec §6 says
 * keyboard is *always* available on desktop, and "always" is not "instead of".
 *
 * `scheme` is 'thumbZones' because this adapter is never the one the player
 * selected: the composite reports its PRIMARY's scheme, and this adapter is always
 * the secondary. On a phone no key is ever down and every field below is inert.
 *
 * The binding table is inverted ONCE, at construction, into six code lists - the
 * per-tick path must not call Object.keys (§7.3: no allocation per tick).
 */
export function makeKeyboardAdapter(cfg: ControlConfig): ControlAdapter {
  const left: string[] = []
  const right: string[] = []
  const accel: string[] = []
  const brake: string[] = []
  const drift: string[] = []
  const item: string[] = []

  for (const code of Object.keys(cfg.keyBindings)) {
    switch (cfg.keyBindings[code]) {
      case 'left': left.push(code); break
      case 'right': right.push(code); break
      case 'accel': accel.push(code); break
      case 'brake': brake.push(code); break
      case 'drift': drift.push(code); break
      case 'item': item.push(code); break
    }
  }

  function anyDown(raw: ControlInputs, codes: string[]): boolean {
    for (let i = 0; i < codes.length; i++) {
      if (raw.keys[codes[i]] === true) return true
    }
    return false
  }

  let steer = 0
  let itemHeld = false

  return {
    scheme: 'thumbZones',

    sample(raw: ControlInputs, tick: number, out: Intent): void {
      const leftDown = anyDown(raw, left)
      const rightDown = anyDown(raw, right)
      const itemDown = anyDown(raw, item)

      let axis = (rightDown ? 1 : 0) - (leftDown ? 1 : 0)
      if (Math.abs(axis) < cfg.deadZone) axis = 0
      const target = clamp(axis * cfg.steerGain, -1, 1)
      steer = clamp(lerp(steer, target, cfg.steerSmoothingPerTick), -1, 1)

      out.tick = tick
      out.steer = steer
      out.accel = anyDown(raw, accel) ? 1 : 0
      out.brake = anyDown(raw, brake)
      out.drift = anyDown(raw, drift)
      out.useItem = itemDown && !itemHeld // Q25: the press edge, not the level
      itemHeld = itemDown
    },

    reset(): void {
      steer = 0
      itemHeld = false
    },
  }
}
```

- [ ] **Step 20: Run the test to verify it passes**

Run: `npx vitest run packages/game/test/controls-keyboard.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 21: Write the failing test for `composite.ts` and `index.ts`**

Create `packages/game/test/controls-composite.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import type { Intent } from '@tapkart/sim'
import type { ControlAdapter, ControlInputs, ControlScheme } from '../src/controls/types'
import { DEFAULT_CONTROL_CONFIG } from '../src/controls/config'
import { makeCompositeAdapter, mergeIntents } from '../src/controls/composite'
import { makeControlAdapter } from '../src/controls/index'
import { makeControlInputsFixture } from './fixtures/game-fixtures'

function intent(o: Partial<Intent>): Intent {
  return { tick: 0, steer: 0, accel: 0, brake: false, drift: false, useItem: false, ...o }
}

function poisonedIntent(): Intent {
  return { tick: -999, steer: 999, accel: -999, brake: true, drift: true, useItem: true }
}

/** Records what it was handed, so the composite's scratch discipline is testable.
 *  `log` is a separate object rather than a self-reference, because an object
 *  literal whose method reads the const it is initialising infers `any` (TS7022). */
function spyAdapter(scheme: ControlScheme, write: Partial<Intent>): ControlAdapter & {
  log: { outs: Intent[]; resets: number }
} {
  const log = { outs: [] as Intent[], resets: 0 }
  return {
    scheme,
    log,
    sample(_raw: ControlInputs, tick: number, out: Intent): void {
      if (!log.outs.includes(out)) log.outs.push(out)
      out.tick = tick
      out.steer = write.steer ?? 0
      out.accel = write.accel ?? 0
      out.brake = write.brake ?? false
      out.drift = write.drift ?? false
      out.useItem = write.useItem ?? false
    },
    reset(): void {
      log.resets++
    },
  }
}

describe('mergeIntents (Q23)', () => {
  it('gives steer to the greater absolute magnitude, as a table', () => {
    // Every row uses DIFFERENT magnitudes on the two sides, except the two tie rows
    // where the sign differs. A row where both sides agree would prove nothing
    // about the rule - it is satisfied by "return touch" and by "return keyboard".
    const rows: { touch: number; kb: number; want: number }[] = [
      { touch: 0.9, kb: -0.5, want: 0.9 },
      { touch: -0.2, kb: 0.6, want: 0.6 },
      { touch: 0.1, kb: 0, want: 0.1 },
      { touch: 0, kb: -0.4, want: -0.4 },
      { touch: 0.5, kb: -0.5, want: -0.5 }, // tie -> keyboard
      { touch: -0.7, kb: 0.7, want: 0.7 }, // tie -> keyboard
      { touch: 0, kb: 0, want: 0 },
      { touch: -1, kb: 0.99, want: -1 },
    ]
    const out = poisonedIntent()
    for (const r of rows) {
      mergeIntents(intent({ steer: r.touch }), intent({ steer: r.kb }), out)
      expect(out.steer).toBe(r.want)
    }
  })

  it('takes the maximum accel', () => {
    // CATCHES a sum (which exceeds 1) and "keyboard wins" (which zeroes the throttle
    // of every auto-accelerate scheme the moment a desktop player touches a key).
    const out = poisonedIntent()
    const rows: [number, number, number][] = [
      [1, 0, 1],
      [0, 1, 1],
      [0.3, 0.7, 0.7],
      [0.7, 0.3, 0.7],
      [0, 0, 0],
    ]
    for (const [touch, kb, want] of rows) {
      mergeIntents(intent({ accel: touch }), intent({ accel: kb }), out)
      expect(out.accel).toBe(want)
    }
  })

  it('ORs brake, drift and useItem across all four combinations each', () => {
    // CATCHES an AND, and a merge that reads only one side. All four rows per field.
    const out = poisonedIntent()
    for (const [t, k] of [[false, false], [true, false], [false, true], [true, true]] as [boolean, boolean][]) {
      mergeIntents(intent({ brake: t }), intent({ brake: k }), out)
      expect(out.brake).toBe(t || k)
      mergeIntents(intent({ drift: t }), intent({ drift: k }), out)
      expect(out.drift).toBe(t || k)
      mergeIntents(intent({ useItem: t }), intent({ useItem: k }), out)
      expect(out.useItem).toBe(t || k)
    }
  })

  it('writes every field of out, leaving nothing from a previous merge', () => {
    const out = poisonedIntent()
    mergeIntents(intent({ tick: 5 }), intent({ tick: 5 }), out)
    expect(out).toEqual({ tick: 5, steer: 0, accel: 0, brake: false, drift: false, useItem: false })
  })

  it('takes tick from the keyboard side, the same side that wins steer ties', () => {
    const out = poisonedIntent()
    mergeIntents(intent({ tick: 5 }), intent({ tick: 7 }), out)
    expect(out.tick).toBe(7)
  })
})

describe('makeCompositeAdapter (Q23)', () => {
  it('reports the primary scheme and merges both sub-adapters', () => {
    const touch = spyAdapter('virtualStick', { steer: 0.2, accel: 1, drift: true })
    const kb = spyAdapter('thumbZones', { steer: -0.8, brake: true, useItem: true })
    const c = makeCompositeAdapter(touch, kb)
    const out = poisonedIntent()
    c.sample(makeControlInputsFixture(), 9, out)
    expect(c.scheme).toBe('virtualStick')
    expect(out).toEqual({ tick: 9, steer: -0.8, accel: 1, brake: true, drift: true, useItem: true })
  })

  it('never hands `out` to a sub-adapter: each gets its own scratch Intent', () => {
    // THE SOLE-WRITER TEST (§7.2). If the composite passes `out` down, the last
    // sub-adapter to run silently becomes the writer of the Intent the session
    // submits, and the merge rule stops existing - while every value-based test
    // above still passes, because the last writer happens to be the keyboard.
    const touch = spyAdapter('tilt', { steer: 0.5 })
    const kb = spyAdapter('thumbZones', { steer: -0.25 })
    const c = makeCompositeAdapter(touch, kb)
    const out = poisonedIntent()
    c.sample(makeControlInputsFixture(), 1, out)
    c.sample(makeControlInputsFixture(), 2, out)
    expect(touch.log.outs).toHaveLength(1)
    expect(kb.log.outs).toHaveLength(1)
    expect(touch.log.outs[0]).not.toBe(out)
    expect(kb.log.outs[0]).not.toBe(out)
    expect(touch.log.outs[0]).not.toBe(kb.log.outs[0])
    expect(out.steer).toBe(0.5)
  })

  it('resets both sub-adapters', () => {
    const touch = spyAdapter('tilt', {})
    const kb = spyAdapter('thumbZones', {})
    const c = makeCompositeAdapter(touch, kb)
    c.reset()
    expect(touch.log.resets).toBe(1)
    expect(kb.log.resets).toBe(1)
  })
})

describe('makeControlAdapter', () => {
  it('reports the requested scheme for all three', () => {
    for (const s of ['thumbZones', 'tilt', 'virtualStick'] as ControlScheme[]) {
      expect(makeControlAdapter(s, DEFAULT_CONTROL_CONFIG).scheme).toBe(s)
    }
  })

  it('merges the keyboard into every scheme, on every platform', () => {
    // CATCHES makeControlAdapter returning the bare touch adapter. Each assertion
    // is chosen so the touch adapter alone CANNOT produce it: thumbZones and tilt
    // have no drift key and no steering keys, and virtualStick's accel is 0 unless
    // its gas button is down.
    const tz = makeControlAdapter('thumbZones', DEFAULT_CONTROL_CONFIG)
    const outTz = poisonedIntent()
    tz.sample(makeControlInputsFixture({ keys: { ShiftLeft: true } }), 0, outTz)
    expect(outTz.drift).toBe(true)

    const tilt = makeControlAdapter('tilt', DEFAULT_CONTROL_CONFIG)
    const outTilt = poisonedIntent()
    tilt.sample(makeControlInputsFixture({ keys: { ArrowLeft: true } }), 0, outTilt)
    expect(outTilt.steer).toBeCloseTo(-0.35, 9)

    const stick = makeControlAdapter('virtualStick', DEFAULT_CONTROL_CONFIG)
    const outStick = poisonedIntent()
    stick.sample(makeControlInputsFixture({ keys: { KeyW: true } }), 0, outStick)
    expect(outStick.accel).toBe(1)
  })

  it('lets the larger input win, in both directions, over a real touch session', () => {
    // The integration case the unit table cannot cover: both sides are live and
    // smoothing moves them past each other. Touch settles at half lock (0.5); the
    // keyboard then ramps 0.35 -> 0.5775 and takes over on the second tick.
    const a = makeControlAdapter('thumbZones', DEFAULT_CONTROL_CONFIG)
    const raw = makeControlInputsFixture()
    const out = poisonedIntent()
    const p = raw.pointers[0]
    p.id = 1
    p.x = 200
    p.y = 200
    p.phase = 'down'
    raw.pointerCount = 1
    a.sample(raw, 0, out)
    raw.pointerCount = 0

    p.x = 256 // +56 px = half of the 112 px full-lock distance
    p.phase = 'move'
    raw.pointerCount = 1
    for (let t = 1; t <= 24; t++) {
      a.sample(raw, t, out)
      raw.pointerCount = 0
    }
    expect(out.steer).toBeCloseTo(0.5, 3)

    raw.keys.ArrowLeft = true
    a.sample(raw, 25, out)
    expect(out.steer).toBeGreaterThan(0.4) // touch still larger: |0.4999| > |-0.35|
    a.sample(raw, 26, out)
    expect(out.steer).toBeCloseTo(-0.5775, 9) // keyboard now larger
  })
})
```

- [ ] **Step 22: Run the test to verify it fails**

Run: `npx vitest run packages/game/test/controls-composite.test.ts`
Expected: FAIL with `Failed to resolve import "../src/controls/composite" from "packages/game/test/controls-composite.test.ts". Does the file exist?`

- [ ] **Step 23: Write `composite.ts` and `index.ts`**

Create `packages/game/src/controls/composite.ts`:

```ts
import type { Intent } from '@tapkart/sim'
import type { ControlAdapter, ControlInputs } from './types'

/**
 * Q23's merge rule, in one place so no scheme invents its own:
 *
 *   steer   - the input of greater absolute magnitude wins; ties go to `keyboard`
 *   accel   - maximum
 *   brake   - logical OR
 *   drift   - logical OR
 *   useItem - logical OR
 *   tick    - the keyboard's, which is the same tick the composite passed to both
 *
 * NOT symmetric: on an equal-magnitude steer tie, `keyboard` wins. SOLE WRITER of
 * `out`, and it writes every field.
 */
export function mergeIntents(touch: Intent, keyboard: Intent, out: Intent): void {
  out.tick = keyboard.tick
  out.steer = Math.abs(keyboard.steer) >= Math.abs(touch.steer) ? keyboard.steer : touch.steer
  out.accel = touch.accel > keyboard.accel ? touch.accel : keyboard.accel
  out.brake = touch.brake || keyboard.brake
  out.drift = touch.drift || keyboard.drift
  out.useItem = touch.useItem || keyboard.useItem
}

/**
 * `primary`'s scheme, `primary`'s and `secondary`'s own scratch Intents, and
 * mergeIntents.
 *
 * The sole-writer rule for Intent (§7.2) is preserved BY CONSTRUCTION: the two
 * scratch Intents below are allocated once, here, and are the only Intents the
 * sub-adapters ever see. Only this adapter writes the one `game` submits.
 */
export function makeCompositeAdapter(primary: ControlAdapter,
                                     secondary: ControlAdapter): ControlAdapter {
  const primaryScratch: Intent = { tick: 0, steer: 0, accel: 0, brake: false, drift: false, useItem: false }
  const secondaryScratch: Intent = { tick: 0, steer: 0, accel: 0, brake: false, drift: false, useItem: false }

  return {
    scheme: primary.scheme,

    sample(raw: ControlInputs, tick: number, out: Intent): void {
      primary.sample(raw, tick, primaryScratch)
      secondary.sample(raw, tick, secondaryScratch)
      mergeIntents(primaryScratch, secondaryScratch, out)
      out.tick = tick
    },

    reset(): void {
      primary.reset()
      secondary.reset()
    },
  }
}
```

Create `packages/game/src/controls/index.ts`:

```ts
import type { ControlAdapter, ControlScheme } from './types'
import type { ControlConfig } from './config'
import { makeThumbZonesAdapter } from './thumbzones'
import { makeTiltAdapter } from './tilt'
import { makeVirtualStickAdapter } from './stick'
import { makeKeyboardAdapter } from './keyboard'
import { makeCompositeAdapter } from './composite'

/**
 * THE public entry point. Builds the scheme's touch adapter, a keyboard adapter,
 * and returns the composite of the two - always, on every platform. Spec §6 says
 * keyboard is *always* available on desktop, and "always" is not "instead of"; on a
 * phone no key is ever down, so the merge is a no-op.
 */
export function makeControlAdapter(scheme: ControlScheme, cfg: ControlConfig): ControlAdapter {
  return makeCompositeAdapter(makeTouchAdapter(scheme, cfg), makeKeyboardAdapter(cfg))
}

/** Exhaustive over ControlScheme: a fourth scheme added to the union without a
 *  case here is a compile error ("not all code paths return a value"), which is
 *  the whole reason this is a switch with returns rather than a default branch. */
function makeTouchAdapter(scheme: ControlScheme, cfg: ControlConfig): ControlAdapter {
  switch (scheme) {
    case 'thumbZones': return makeThumbZonesAdapter(cfg)
    case 'tilt': return makeTiltAdapter(cfg)
    case 'virtualStick': return makeVirtualStickAdapter(cfg)
  }
}
```

- [ ] **Step 24: Run the test to verify it passes**

Run: `npx vitest run packages/game/test/controls-composite.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 25: Verify the whole package typechecks and the whole suite is green**

Run: `npx tsc --noEmit -p packages/game/tsconfig.json`
Expected: no output. (`noUnusedLocals`, `noUnusedParameters` and `verbatimModuleSyntax` are on: every
`import type` above is deliberate.)

Run: `npx vitest run`
Expected: PASS. Every pre-existing suite is untouched; this task adds 75 tests across six files
(12 + 19 + 13 + 11 + 8 + 12).

- [ ] **Step 26: Commit**

```bash
git add packages/game/src/controls packages/game/test/controls-config.test.ts \
        packages/game/test/controls-thumbzones.test.ts packages/game/test/controls-tilt.test.ts \
        packages/game/test/controls-stick.test.ts packages/game/test/controls-keyboard.test.ts \
        packages/game/test/controls-composite.test.ts packages/game/test/fixtures/game-fixtures.ts && \
git commit -m "feat(game): three touch control schemes, keyboard, and the composite merge

thumbZones steers relative to the touch-down origin (Q24), brakes on a
drift long-press qualified by |steer| < DRIFT_STEER_MIN (Q21), and emits
useItem as a one-tick pulse on press (Q25). tilt reuses the same button
layout and reads gamma from the calibrated neutral. virtualStick adds gas
and brake pedals and no long-press brake. Keyboard is merged into every
scheme by CompositeAdapter, never selected on its own (Q23); the
sub-adapters write their own scratch Intents so the sole writer of the
submitted Intent stays the composite."
```

---

### Task 19: The DOM input adapter and settings persistence

**Files:**
- Create: `packages/game/src/controls/source.ts`
- Create: `packages/game/src/settings.ts`
- Modify: `packages/game/test/fixtures/game-fixtures.ts` (append `makeSettingsFixture`; do not rewrite the file)
- Test: `packages/game/test/settings.test.ts`
- Test: `packages/game/test/dom-seam.test.ts`

**`packages/game/src/roomcode.ts` is NOT created — contract §5.8 is retired.** Room codes ship in
`@tapkart/protocol` (`packages/protocol/src/room.ts`), and shipped code supersedes §5.8 three
separate times over: the **length is 5**, not 4; the alphabet is **Crockford base32**, which *keeps*
`0` and `1` and drops `I`, `L`, `O` and `U` — the opposite of the obvious ambiguity-free choice; and
**the alphabet's order is the 5-bit wire index**, so a differently-ordered alphabet is a different
wire format rather than a cosmetic difference. `normalizeRoomCode` there no longer strips or
truncates. A second copy in `game` would be a second wire format that agrees until someone reorders
one, so this task imports the six symbols and defines none of them.

Do **not** touch `packages/game/src/index.ts`. The barrel task (contract §5.15) re-exports `settings`
and deliberately **not** `controls/source` — it is a DOM adapter (§8.2), and a barrel
that re-exported it would drag `addEventListener` into every headless test in the repository. It no
longer re-exports `roomcode` either, because there is no such module.

**Interfaces:**

- Consumes, from Task 18 (`packages/game/src/controls/`):
  ```ts
  export type ControlScheme = 'thumbZones' | 'tilt' | 'virtualStick'
  export type PointerPhase = 'down' | 'move' | 'up'
  export interface PointerSample { id: number; x: number; y: number; phase: PointerPhase }
  export interface TiltSample { alpha: number; beta: number; gamma: number }
  export interface Viewport { width: number; height: number }
  export const MAX_POINTERS = 8
  export interface ControlInputs {
    pointers: PointerSample[]; pointerCount: number
    keys: Record<string, boolean>; tilt: TiltSample | null; viewport: Viewport
  }
  export function createControlInputs(): ControlInputs
  // controls/tilt.ts
  export interface TiltCalibration { betaZero: number; gammaZero: number }
  export const IDENTITY_TILT_CALIBRATION: Readonly<TiltCalibration>
  ```
  and `packages/game/test/fixtures/game-fixtures.ts`, which already exports
  `makeControlInputsFixture(overrides?: Partial<ControlInputs>): ControlInputs`.
- Consumes, from `@tapkart/content` (contract §3a.2, §3a.5):
  ```ts
  export interface TrackManifestEntry { id: string; name: string }
  /** The six shipped tracks in MENU ORDER, which is `id` ascending. */
  export const TRACK_MANIFEST: readonly TrackManifestEntry[]
  /** The shipped character table; length 8, index === characterIdx.
   *  `readonly`, and it does NOT assign to `SimContext.characters: CharacterStats[]`
   *  — a composition root writes `CHARACTERS.slice()`. (`TUNING: Readonly<Tuning>`
   *  *does* assign to `tuning: Tuning`; arrays are the case that bites.) */
  export const CHARACTERS: readonly CharacterStats[]
  ```
- Produces (contract §5.6 and §5.7 — 10 exported symbols; §11's census loses §5.8's four with `roomcode.ts`):
  ```ts
  // src/controls/source.ts (3)
  export interface InputSource { drain(out: ControlInputs): void; detach(): void }
  export function attachInputSource(target: EventTarget, viewport: Viewport): InputSource
  export function requestTiltPermission(): Promise<boolean>

  // src/settings.ts (7)
  export interface Settings {
    scheme: ControlScheme
    tiltCalibration: TiltCalibration
    invertTilt: boolean
    audioEnabled: boolean
    audioVolume: number         // 0..1
    characterIdx: number        // 0..7
    lastTrackId: string         // a TRACK_MANIFEST id
    playerName: string          // 1..12 chars after trimming; '' means "unset"
  }
  export const DEFAULT_SETTINGS: Readonly<Settings>
  export const SETTINGS_STORAGE_KEY = 'tapkart.settings.v1'
  export interface KeyValueStore { get(key: string): string | null; set(key: string, value: string): void }
  export function memoryStore(): KeyValueStore
  export function loadSettings(store: KeyValueStore): Settings
  export function saveSettings(store: KeyValueStore, s: Settings): void
  ```
  ```ts
  // test/fixtures/game-fixtures.ts — appended (contract §9.1)
  export function makeSettingsFixture(overrides?: Partial<Settings>): Settings
  ```

**A test-vacuity trap this task will walk into if warned about nothing else.** `it.each` **spreads
any row that is itself an array**, so `it.each([null, 42, [], true])` delivers the `[]` row as *zero*
arguments and silently re-tests `undefined`. An array-rejection bug passes under that form. Every
rejected-input table below is therefore `[label, value]` tuples, or a plain `for` loop. Do not
"simplify" them back to bare value lists.

**Where the seam sits (§8.2).** `source.ts` is one of exactly four files CI never imports: DOM event
listeners, `deviceorientation`, the iOS permission call. It has no unit test, and that is a decision,
not an omission — the compensating controls are `tsc` (it is inside `packages/game/tsconfig.json`'s
`include`) and `dom-seam.test.ts`, which proves that no *other* module in this task's or Task 18's
surface has quietly acquired a DOM dependency. `settings.ts` never names the browser's storage API: the store is
injected, which is what makes it testable under `environment: 'node'` with no jsdom (Q30). Note that
`dom-seam.test.ts` reads source files as **text**, comments included, so the pure modules must avoid
naming those APIs even in prose — write "browser storage", not the identifier.

- [ ] **Step 1: Write the failing test for `settings.ts`**

Append to `packages/game/test/fixtures/game-fixtures.ts` (Task 18 created this file with
`makeControlInputsFixture`; keep that export and add these two lines of imports at the top and the
function at the bottom):

```ts
import type { Settings } from '../../src/settings'
import { DEFAULT_SETTINGS } from '../../src/settings'

/** DEFAULT_SETTINGS with a fresh, independently mutable tiltCalibration. */
export function makeSettingsFixture(overrides?: Partial<Settings>): Settings {
  return {
    ...DEFAULT_SETTINGS,
    tiltCalibration: { ...DEFAULT_SETTINGS.tiltCalibration },
    ...overrides,
  }
}
```

Create `packages/game/test/settings.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { CHARACTERS, TRACK_MANIFEST } from '@tapkart/content'
import { IDENTITY_TILT_CALIBRATION } from '../src/controls/tilt'
import type { Settings } from '../src/settings'
import {
  DEFAULT_SETTINGS,
  SETTINGS_STORAGE_KEY,
  loadSettings,
  memoryStore,
  saveSettings,
} from '../src/settings'
import { makeSettingsFixture } from './fixtures/game-fixtures'

// Compile-time exhaustive: adding a field to Settings without adding it here is a
// type error, so the per-field fallback test can never silently skip a new field.
const KEY_TABLE: Record<keyof Settings, true> = {
  scheme: true,
  tiltCalibration: true,
  invertTilt: true,
  audioEnabled: true,
  audioVolume: true,
  characterIdx: true,
  lastTrackId: true,
  playerName: true,
}
const KEYS = Object.keys(KEY_TABLE) as (keyof Settings)[]

/** Every field DIFFERENT from DEFAULT_SETTINGS. That is what makes the per-field
 *  fallback test able to tell "one field reset" from "the whole object reset". */
const CUSTOM: Settings = {
  scheme: 'tilt',
  tiltCalibration: { betaZero: 3, gammaZero: -4 },
  invertTilt: true,
  audioEnabled: false,
  audioVolume: 0.25,
  characterIdx: 5,
  lastTrackId: TRACK_MANIFEST[1].id,
  playerName: 'Rae',
}

function storeWith(json: string): ReturnType<typeof memoryStore> {
  const store = memoryStore()
  store.set(SETTINGS_STORAGE_KEY, json)
  return store
}

describe('DEFAULT_SETTINGS', () => {
  it('is the contract §5.7 table, field by field', () => {
    expect(DEFAULT_SETTINGS.scheme).toBe('thumbZones')
    expect(DEFAULT_SETTINGS.tiltCalibration).toEqual(IDENTITY_TILT_CALIBRATION)
    expect(DEFAULT_SETTINGS.invertTilt).toBe(false)
    expect(DEFAULT_SETTINGS.audioEnabled).toBe(true)
    expect(DEFAULT_SETTINGS.audioVolume).toBe(0.7)
    expect(DEFAULT_SETTINGS.characterIdx).toBe(0)
    expect(DEFAULT_SETTINGS.playerName).toBe('')
    expect(SETTINGS_STORAGE_KEY).toBe('tapkart.settings.v1')
  })

  it('defaults lastTrackId to the first shipped track, not a hard-coded id', () => {
    // CATCHES a literal track id copied into settings.ts. The manifest is derived
    // from the shipped files; a renamed track would leave the default pointing at
    // a track loadTrack throws on, on first launch, for every new player.
    expect(DEFAULT_SETTINGS.lastTrackId).toBe(TRACK_MANIFEST[0].id)
    expect(TRACK_MANIFEST.some((t) => t.id === DEFAULT_SETTINGS.lastTrackId)).toBe(true)
  })
})

describe('memoryStore', () => {
  it('returns null for an unset key and round-trips what it is given', () => {
    const store = memoryStore()
    expect(store.get('nope')).toBeNull()
    store.set('k', 'v')
    expect(store.get('k')).toBe('v')
    store.set('k', 'w')
    expect(store.get('k')).toBe('w')
  })

  it('gives each store its own keyspace', () => {
    // CATCHES a module-level Map shared by every store, which makes one test's
    // settings leak into the next and is invisible until tests run in a new order.
    const a = memoryStore()
    const b = memoryStore()
    a.set('k', 'a')
    expect(b.get('k')).toBeNull()
  })
})

describe('loadSettings - whole-blob failures', () => {
  it('returns the defaults and never throws', () => {
    // [label, stored] tuples, NOT a bare list: it.each and any array-spreading
    // helper would swallow a row that is itself an array.
    const rows: [string, string][] = [
      ['not JSON at all', '{'],
      ['a JSON number', '42'],
      ['JSON null', 'null'],
      ['a JSON array', '[]'],
      ['a JSON string', '"thumbZones"'],
      ['an empty string', ''],
      ['a truncated object', '{"scheme":'],
    ]
    for (const [label, stored] of rows) {
      const got = loadSettings(storeWith(stored))
      expect(got, label).toEqual(DEFAULT_SETTINGS)
    }
  })

  it('returns the defaults when nothing has ever been saved', () => {
    expect(loadSettings(memoryStore())).toEqual(DEFAULT_SETTINGS)
  })

  it('returns a fresh object each time, sharing nothing with DEFAULT_SETTINGS', () => {
    // CATCHES `return DEFAULT_SETTINGS` and a shallow copy that keeps the shared
    // tiltCalibration object. The settings screen writes into what it is handed;
    // either bug rewrites the module constant for the life of the process, and
    // "reset to defaults" then restores the corrupted values.
    const first = loadSettings(memoryStore())
    first.audioVolume = 0.1
    first.tiltCalibration.betaZero = 99
    const second = loadSettings(memoryStore())
    expect(second.audioVolume).toBe(0.7)
    expect(second.tiltCalibration).toEqual({ betaZero: 0, gammaZero: 0 })
    expect(DEFAULT_SETTINGS.audioVolume).toBe(0.7)
    expect(DEFAULT_SETTINGS.tiltCalibration).toEqual({ betaZero: 0, gammaZero: 0 })
    expect(first.tiltCalibration).not.toBe(second.tiltCalibration)
  })
})

describe('loadSettings - PER-FIELD fallback', () => {
  it('falls back only the broken field and keeps the other seven', () => {
    // THE FLAGSHIP TEST for §5.7. Every field of CUSTOM differs from the default,
    // so a per-OBJECT fallback - the natural implementation, and the one that
    // silently wipes a player's whole configuration because one field is stale
    // after an upgrade - fails on the very first row.
    const rows: [string, keyof Settings, unknown][] = [
      ['scheme is not a known scheme', 'scheme', 'gamepad'],
      ['scheme is a number', 'scheme', 3],
      ['tiltCalibration is null', 'tiltCalibration', null],
      ['tiltCalibration is a number', 'tiltCalibration', 7],
      ['tiltCalibration has a NaN axis', 'tiltCalibration', { betaZero: Number.NaN, gammaZero: 0 }],
      ['tiltCalibration is missing an axis', 'tiltCalibration', { betaZero: 1 }],
      ['invertTilt is a string', 'invertTilt', 'yes'],
      ['audioEnabled is a number', 'audioEnabled', 1],
      ['audioVolume is above 1', 'audioVolume', 1.5],
      ['audioVolume is negative', 'audioVolume', -0.2],
      ['audioVolume is a string', 'audioVolume', 'loud'],
      ['characterIdx is fractional', 'characterIdx', 1.5],
      ['characterIdx is past the roster', 'characterIdx', CHARACTERS.length],
      ['characterIdx is negative', 'characterIdx', -1],
      ['lastTrackId is not a shipped track', 'lastTrackId', 'atlantis'],
      ['lastTrackId is a number', 'lastTrackId', 3],
      ['playerName is 13 characters', 'playerName', 'abcdefghijklm'],
      ['playerName is blank after trimming', 'playerName', '   '],
      ['playerName is a number', 'playerName', 12],
    ]

    for (const [label, key, bad] of rows) {
      const stored: Record<string, unknown> = { ...CUSTOM }
      stored[key] = bad
      const got = loadSettings(storeWith(JSON.stringify(stored)))
      expect(got[key], `${label}: broken field must fall back`).toEqual(DEFAULT_SETTINGS[key])
      for (const other of KEYS) {
        if (other === key) continue
        expect(got[other], `${label}: ${other} must survive`).toEqual(CUSTOM[other])
      }
    }
  })

  it('accepts every legal value it is handed, unchanged', () => {
    // CATCHES an over-strict validator - the failure mode the test above cannot
    // see, because a loader that rejected EVERYTHING would pass it. Round-tripping
    // CUSTOM proves the accept path for all eight fields at once.
    const store = memoryStore()
    saveSettings(store, CUSTOM)
    expect(loadSettings(store)).toEqual(CUSTOM)
  })

  it('accepts the boundary values on both ends', () => {
    const edge: Settings = makeSettingsFixture({
      audioVolume: 0,
      characterIdx: CHARACTERS.length - 1,
      lastTrackId: TRACK_MANIFEST[TRACK_MANIFEST.length - 1].id,
      playerName: 'abcdefghijkl', // exactly 12
    })
    const store = memoryStore()
    saveSettings(store, edge)
    expect(loadSettings(store)).toEqual(edge)

    const full = makeSettingsFixture({ audioVolume: 1 })
    saveSettings(store, full)
    expect(loadSettings(store).audioVolume).toBe(1)
  })

  it('trims a padded player name rather than rejecting it', () => {
    const store = storeWith(JSON.stringify({ ...CUSTOM, playerName: '  Rae Vance ' }))
    expect(loadSettings(store).playerName).toBe('Rae Vance')
  })

  it('ignores unknown stored fields', () => {
    // CATCHES a loader that copies the parsed object wholesale; a v2 field left by
    // a newer build would then reappear in a v1 Settings and travel into save().
    const store = storeWith(JSON.stringify({ ...CUSTOM, hyperdrive: true }))
    const got = loadSettings(store)
    expect(Object.keys(got).sort()).toEqual([...KEYS].sort())
  })
})

describe('saveSettings', () => {
  it('writes JSON under SETTINGS_STORAGE_KEY and under no other key', () => {
    const store = memoryStore()
    saveSettings(store, CUSTOM)
    const raw = store.get(SETTINGS_STORAGE_KEY)
    expect(raw).not.toBeNull()
    expect(JSON.parse(raw as string)).toEqual(CUSTOM)
    expect(store.get('tapkart.settings')).toBeNull()
  })

  it('serialises every field, so nothing is silently dropped', () => {
    // CATCHES a hand-written serialiser that forgets a field: the round-trip test
    // above would still pass if the missing field happened to equal its default.
    const store = memoryStore()
    saveSettings(store, CUSTOM)
    const parsed = JSON.parse(store.get(SETTINGS_STORAGE_KEY) as string) as Record<string, unknown>
    expect(Object.keys(parsed).sort()).toEqual([...KEYS].sort())
  })

  it('does not alias the settings it was handed', () => {
    const store = memoryStore()
    const s = makeSettingsFixture({ playerName: 'Rae' })
    saveSettings(store, s)
    s.playerName = 'Someone Else'
    expect(loadSettings(store).playerName).toBe('Rae')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/game/test/settings.test.ts`
Expected: FAIL with `Failed to resolve import "../src/settings" from "packages/game/test/settings.test.ts". Does the file exist?`

- [ ] **Step 3: Write `settings.ts`**

Create `packages/game/src/settings.ts`:

```ts
import { CHARACTERS, TRACK_MANIFEST } from '@tapkart/content'
import type { ControlScheme } from './controls/types'
import type { TiltCalibration } from './controls/tilt'
import { IDENTITY_TILT_CALIBRATION } from './controls/tilt'

export interface Settings {
  scheme: ControlScheme
  tiltCalibration: TiltCalibration
  invertTilt: boolean
  audioEnabled: boolean
  audioVolume: number // 0..1
  characterIdx: number // 0..7
  lastTrackId: string // a TRACK_MANIFEST id
  playerName: string // 1..12 chars after trimming; '' means "unset"
}

export const DEFAULT_SETTINGS: Readonly<Settings> = {
  scheme: 'thumbZones',
  tiltCalibration: { ...IDENTITY_TILT_CALIBRATION },
  invertTilt: false,
  audioEnabled: true,
  audioVolume: 0.7,
  characterIdx: 0,
  // Derived from the shipped manifest, never a literal: TRACK_MANIFEST is built
  // from the track files' own ids, so this default cannot point at a track that
  // does not ship.
  lastTrackId: TRACK_MANIFEST[0].id,
  playerName: '',
}

export const SETTINGS_STORAGE_KEY = 'tapkart.settings.v1'

/** Injected so tests never touch browser storage - and so this module stays inside
 *  the headless half of §8.2's seam. The browser-backed store is built by the
 *  shell, which is the file allowed to name browser APIs. (This comment names none
 *  of them on purpose: dom-seam.test.ts reads this file as text.) */
export interface KeyValueStore {
  get(key: string): string | null
  set(key: string, value: string): void
}

export function memoryStore(): KeyValueStore {
  const map = new Map<string, string>()
  return {
    get(key: string): string | null {
      const v = map.get(key)
      return v === undefined ? null : v
    },
    set(key: string, value: string): void {
      map.set(key, value)
    },
  }
}

const PLAYER_NAME_MAX = 12

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

function freshDefaults(): Settings {
  // A new object every call, with a new tiltCalibration: the settings screen
  // writes into whatever loadSettings returns, and DEFAULT_SETTINGS must survive
  // that untouched for the life of the process.
  return { ...DEFAULT_SETTINGS, tiltCalibration: { ...DEFAULT_SETTINGS.tiltCalibration } }
}

/**
 * NEVER throws. Malformed JSON, a missing key, a wrong type or an out-of-range
 * value falls back PER FIELD to DEFAULT_SETTINGS - not per object, so one bad
 * field does not discard the other seven. That difference is the whole point: a
 * field this build does not understand should cost the player that setting, not
 * their character, their track and their name.
 */
export function loadSettings(store: KeyValueStore): Settings {
  const out = freshDefaults()

  const raw = store.get(SETTINGS_STORAGE_KEY)
  if (raw === null) return out

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return out
  }
  if (!isPlainObject(parsed)) return out

  const scheme = parsed.scheme
  if (scheme === 'thumbZones' || scheme === 'tilt' || scheme === 'virtualStick') {
    out.scheme = scheme
  }

  const cal = parsed.tiltCalibration
  if (isPlainObject(cal) && isFiniteNumber(cal.betaZero) && isFiniteNumber(cal.gammaZero)) {
    out.tiltCalibration = { betaZero: cal.betaZero, gammaZero: cal.gammaZero }
  }

  if (typeof parsed.invertTilt === 'boolean') out.invertTilt = parsed.invertTilt
  if (typeof parsed.audioEnabled === 'boolean') out.audioEnabled = parsed.audioEnabled

  const vol = parsed.audioVolume
  if (isFiniteNumber(vol) && vol >= 0 && vol <= 1) out.audioVolume = vol

  const idx = parsed.characterIdx
  if (isFiniteNumber(idx) && Number.isInteger(idx) && idx >= 0 && idx < CHARACTERS.length) {
    out.characterIdx = idx
  }

  const trackId = parsed.lastTrackId
  if (typeof trackId === 'string' && TRACK_MANIFEST.some((t) => t.id === trackId)) {
    out.lastTrackId = trackId
  }

  const name = parsed.playerName
  if (typeof name === 'string') {
    const trimmed = name.trim()
    if (trimmed.length >= 1 && trimmed.length <= PLAYER_NAME_MAX) out.playerName = trimmed
  }

  return out
}

/**
 * SOLE WRITER of the persisted settings (§7.2). Writes a fresh, field-complete
 * object rather than `s` itself, so an extra property riding on the caller's
 * object never reaches storage.
 */
export function saveSettings(store: KeyValueStore, s: Settings): void {
  const payload: Settings = {
    scheme: s.scheme,
    tiltCalibration: { betaZero: s.tiltCalibration.betaZero, gammaZero: s.tiltCalibration.gammaZero },
    invertTilt: s.invertTilt,
    audioEnabled: s.audioEnabled,
    audioVolume: s.audioVolume,
    characterIdx: s.characterIdx,
    lastTrackId: s.lastTrackId,
    playerName: s.playerName,
  }
  store.set(SETTINGS_STORAGE_KEY, JSON.stringify(payload))
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/game/test/settings.test.ts`
Expected: PASS, 15 tests.

- [ ] **Step 5: Write the failing test for `source.ts` and the seam**

Create `packages/game/test/dom-seam.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// §8.2: `controls/source.ts` is one of exactly four files CI never imports. This
// test never imports it either - it READS it, which is the only way to assert
// something about a DOM module under `environment: 'node'` without pulling the DOM
// into the run.
const SRC = fileURLToPath(new URL('../src/', import.meta.url))
const CONTROLS = `${SRC}controls/`

const DOM_PATTERNS: [string, RegExp][] = [
  ['addEventListener', /\baddEventListener\b/],
  ['removeEventListener', /\bremoveEventListener\b/],
  ['window', /\bwindow\b/],
  ['document', /\bdocument\b/],
  ['navigator', /\bnavigator\b/],
  ['localStorage', /\blocalStorage\b/],
  ['DeviceOrientationEvent', /\bDeviceOrientationEvent\b/],
  ['PointerEvent', /\bPointerEvent\b/],
]

function read(path: string): string {
  return readFileSync(path, 'utf8')
}

describe('§8.2 DOM seam', () => {
  it('source.ts exists and is the file that owns the DOM', () => {
    // ANTI-VACUITY: this asserts the patterns below can actually match something.
    // Without it, a typo'd regex would make every "is DOM-free" assertion pass on
    // every file in the repository, forever.
    const src = read(`${CONTROLS}source.ts`)
    expect(src).toMatch(/\baddEventListener\b/)
    expect(src).toMatch(/\bremoveEventListener\b/)
    expect(src).toMatch(/deviceorientation/)
    expect(src).toMatch(/\bpointercancel\b/)
  })

  it('no other controls module names a DOM API', () => {
    // CATCHES the failure mode Q30 describes: a "pure" module quietly acquiring a
    // browser dependency, which surfaces later as an unrelated headless suite
    // breaking and gets "fixed" by switching the environment to jsdom.
    const files = readdirSync(CONTROLS).filter((f) => f.endsWith('.ts') && f !== 'source.ts')
    expect(files.length).toBeGreaterThanOrEqual(8)
    for (const f of files) {
      const text = read(`${CONTROLS}${f}`)
      for (const [name, re] of DOM_PATTERNS) {
        expect(re.test(text), `${f} must not name ${name}`).toBe(false)
      }
    }
  })

  it('settings.ts never names localStorage', () => {
    // Contract §5.7: the store is INJECTED. A direct localStorage read here would
    // make loadSettings untestable headlessly and would throw in a Safari private
    // window, on startup, before the first frame.
    for (const f of ['settings.ts']) {
      const text = read(`${SRC}${f}`)
      for (const [name, re] of DOM_PATTERNS) {
        expect(re.test(text), `${f} must not name ${name}`).toBe(false)
      }
    }
  })

  it('the controls entry point does not reach the DOM adapter', () => {
    // CATCHES `makeControlAdapter` growing a convenience that attaches listeners:
    // controls/index.ts IS re-exported by the package barrel (§5.15), so an import
    // of './source' there would drag the DOM into every headless test transitively.
    const index = read(`${CONTROLS}index.ts`)
    expect(index.includes('./source')).toBe(false)
  })
})
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `npx vitest run packages/game/test/dom-seam.test.ts`
Expected: FAIL with `ENOENT: no such file or directory, open '<repo>/packages/game/src/controls/source.ts'`

- [ ] **Step 7: Write `source.ts`**

Create `packages/game/src/controls/source.ts`:

```ts
import type { ControlInputs, PointerPhase, TiltSample, Viewport } from './types'
import { MAX_POINTERS } from './types'

export interface InputSource {
  /** Copies everything accumulated since the last call into `out`, then clears its
   *  own accumulator. Never allocates: `out.pointers` is reused. */
  drain(out: ControlInputs): void
  detach(): void
}

/**
 * Attaches pointer, key and deviceorientation listeners. The ONLY file in
 * packages/game that references a DOM event (§8.2), and the reason the rest of the
 * package is testable under `environment: 'node'` with no jsdom.
 *
 * `viewport` is owned by the CALLER - the shell updates it on resize and `drain`
 * copies it. One owner for the canvas size, and it is not this module.
 *
 * `target` is the element the shell listens on; it passes `window` so that keys
 * and device orientation arrive alongside pointers.
 */
export function attachInputSource(target: EventTarget, viewport: Viewport): InputSource {
  // Fixed-size accumulator, allocated once. A frame that produces more than
  // MAX_POINTERS events drops the excess rather than growing an array in the
  // input path (§7.3).
  const ids = new Int32Array(MAX_POINTERS)
  const xs = new Float64Array(MAX_POINTERS)
  const ys = new Float64Array(MAX_POINTERS)
  const phases: PointerPhase[] = []
  for (let i = 0; i < MAX_POINTERS; i++) phases.push('up')
  let count = 0

  const keys: Record<string, boolean> = {}
  const tiltScratch: TiltSample = { alpha: 0, beta: 0, gamma: 0 }
  let haveTilt = false

  function push(id: number, x: number, y: number, phase: PointerPhase): void {
    if (count >= MAX_POINTERS) return
    ids[count] = id
    xs[count] = x
    ys[count] = y
    phases[count] = phase
    count++
  }

  function pointerHandler(phase: PointerPhase): (e: Event) => void {
    return (e: Event): void => {
      const p = e as PointerEvent
      // clientX/clientY are CSS px from the viewport's left/top edge, which is
      // exactly what PointerSample documents.
      push(p.pointerId, p.clientX, p.clientY, phase)
      if (e.cancelable) e.preventDefault()
    }
  }

  const onDown = pointerHandler('down')
  const onMove = pointerHandler('move')
  const onUp = pointerHandler('up')
  // A cancelled touch (a system gesture, an incoming call) never produces
  // 'pointerup'. Without this line the drift button stays latched for the rest of
  // the race and the player cannot release it.
  const onCancel = pointerHandler('up')

  const onKeyDown = (e: Event): void => {
    keys[(e as KeyboardEvent).code] = true
  }
  const onKeyUp = (e: Event): void => {
    keys[(e as KeyboardEvent).code] = false
  }
  // A key released while the window is unfocused never delivers 'keyup'. Clearing
  // on blur is what stops the kart driving itself after an alt-tab.
  const onBlur = (): void => {
    for (const code of Object.keys(keys)) keys[code] = false
  }

  const onOrientation = (e: Event): void => {
    const d = e as DeviceOrientationEvent
    if (d.alpha === null || d.beta === null || d.gamma === null) return
    tiltScratch.alpha = d.alpha
    tiltScratch.beta = d.beta
    tiltScratch.gamma = d.gamma
    haveTilt = true
  }

  target.addEventListener('pointerdown', onDown)
  target.addEventListener('pointermove', onMove)
  target.addEventListener('pointerup', onUp)
  target.addEventListener('pointercancel', onCancel)
  target.addEventListener('keydown', onKeyDown)
  target.addEventListener('keyup', onKeyUp)
  target.addEventListener('blur', onBlur)
  target.addEventListener('deviceorientation', onOrientation)

  return {
    drain(out: ControlInputs): void {
      for (let i = 0; i < count; i++) {
        const p = out.pointers[i]
        p.id = ids[i]
        p.x = xs[i]
        p.y = ys[i]
        p.phase = phases[i]
      }
      out.pointerCount = count
      count = 0

      // `keys` and `tiltScratch` are LEVELS, not edges: they persist across frames
      // and the adapters only read them. Aliasing rather than copying is what keeps
      // drain() allocation-free.
      out.keys = keys
      out.tilt = haveTilt ? tiltScratch : null
      out.viewport.width = viewport.width
      out.viewport.height = viewport.height
    },

    detach(): void {
      target.removeEventListener('pointerdown', onDown)
      target.removeEventListener('pointermove', onMove)
      target.removeEventListener('pointerup', onUp)
      target.removeEventListener('pointercancel', onCancel)
      target.removeEventListener('keydown', onKeyDown)
      target.removeEventListener('keyup', onKeyUp)
      target.removeEventListener('blur', onBlur)
      target.removeEventListener('deviceorientation', onOrientation)
    },
  }
}

/** iOS's motion permission gate, which exists only on iOS and only as a static
 *  method the DOM lib does not declare. */
interface MotionPermissionGate {
  requestPermission?: () => Promise<'granted' | 'denied' | 'default'>
}

/**
 * iOS requires a user-gesture-gated permission prompt for motion. Resolves `false`
 * when denied or unsupported.
 *
 * Q22: the CALLER reverts the selection and shows a reason; it does not silently
 * fall back. A player who selects tilt, is denied by the OS, and gets thumb-zones
 * with no explanation concludes the game is broken.
 */
export async function requestTiltPermission(): Promise<boolean> {
  const gate = (globalThis as { DeviceOrientationEvent?: MotionPermissionGate }).DeviceOrientationEvent
  if (gate === undefined) return false // no orientation API at all
  if (typeof gate.requestPermission !== 'function') return true // not iOS: no gate to pass
  try {
    return (await gate.requestPermission()) === 'granted'
  } catch {
    // iOS throws when the call is not inside a user gesture. That is a denial.
    return false
  }
}
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `npx vitest run packages/game/test/dom-seam.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 9: Verify the package typechecks and the whole suite is green**

Run: `npx tsc --noEmit -p packages/game/tsconfig.json`
Expected: no output. This is the ONLY verification `source.ts` gets, by design (§8.2), so it is not
optional. If it reports `Cannot find name 'PointerEvent'` or `'DeviceOrientationEvent'`, the
package's `tsconfig.json` is missing `"lib": ["ES2022", "DOM", "DOM.Iterable"]` (§10.1) — fix the
tsconfig, never the source.

Run: `npx vitest run`
Expected: PASS. This task adds 19 tests across two files (15 + 4); Task 18's six suites stay green.

- [ ] **Step 10: Commit**

```bash
git add packages/game/src/controls/source.ts packages/game/src/settings.ts \
        packages/game/test/fixtures/game-fixtures.ts \
        packages/game/test/settings.test.ts \
        packages/game/test/dom-seam.test.ts && \
git commit -m "feat(game): DOM input source and per-field settings persistence

attachInputSource is the one file in packages/game that names a DOM
event (contract §8.2); pointercancel and blur are treated as releases so
a latched button cannot outlive the touch or the focus. requestTiltPermission
resolves false on denial or absence - Q22 leaves the revert-and-explain to
the caller. loadSettings never throws and falls back PER FIELD, so one
unreadable value costs the player that setting and not the other seven.
No roomcode.ts: contract §5.8 is retired by shipped
packages/protocol/src/room.ts, whose alphabet ORDER is the 5-bit wire
index, so a second copy here would be a second wire format."
```

---

### Task 20: `packages/game/src/app.ts` — the screen state machine, pure

**Files:**
- Create: `packages/game/src/app.ts`
- Modify: `packages/game/test/fixtures/game-fixtures.ts` (append `makeLobbySlots`; do not rewrite the file)
- Test: `packages/game/test/app.test.ts`

Do **not** touch `packages/game/src/index.ts` (the barrel task owns it, contract §5.15) and do **not**
create `packages/game/src/results.ts` — that is **the very next task**, and a stub here would make
`ResultRow` a type with two definitions, which is the defect class this plan is written to avoid.

**Interfaces:**

- Consumes, from `@tapkart/sim` (contract §2.1):
  ```ts
  export const MAX_KARTS = 8
  export type RacePhase = 'countdown' | 'racing' | 'finished'
  ```
- Consumes, from `@tapkart/render` (contract §4.2) — **type only**:
  ```ts
  /** The session's role, named once, in the lowest package that needs it. `game`
   *  imports this type rather than declaring a second union. There is no `SessionRole`. */
  export type ViewRole = 'host' | 'guest' | 'solo'
  ```
- Consumes, from `@tapkart/content` (contract §3a.2, §3a.5):
  ```ts
  export interface TrackManifestEntry { id: string; name: string }
  export const TRACK_MANIFEST: readonly TrackManifestEntry[]   // six ids, ascending
  export const CHARACTERS: readonly CharacterStats[]           // length 8
  ```
- Consumes, from Task 19:
  ```ts
  export interface Settings {
    scheme: ControlScheme; tiltCalibration: TiltCalibration; invertTilt: boolean
    audioEnabled: boolean; audioVolume: number; characterIdx: number
    lastTrackId: string; playerName: string
  }
  ```
- Consumes, from `@tapkart/protocol` (shipped `packages/protocol/src/room.ts`, which
  **retires** contract §5.8's `game/src/roomcode.ts` — the code is 5 characters, the
  alphabet is Crockford, and the alphabet's ORDER is the 5-bit wire index):
  ```ts
  export const ROOM_CODE_LENGTH = 5
  export function normalizeRoomCode(raw: string): string   // no longer strips or truncates
  export function isValidRoomCode(raw: string): boolean
  ```
  and `packages/game/test/fixtures/game-fixtures.ts`, which already exports
  `makeControlInputsFixture` and `makeSettingsFixture(overrides?: Partial<Settings>): Settings`.
- Consumes, from the **next** task (contract §5.12) — **type only**, and see the forward-reference note below:
  ```ts
  export interface ResultRow { place: number; playerId: number; name: string; dnf: boolean }
  ```
- Produces (contract §5.9 — 7 exported symbols, exactly the census in §11):
  ```ts
  export type ScreenId = 'title' | 'characterSelect' | 'lobby' | 'race' | 'results'
  export interface LobbySlot {
    playerId: number; name: string; characterIdx: number
    isBot: boolean; connected: boolean; ready: boolean
  }
  export interface AppState {
    screen: ScreenId; role: ViewRole; roomCode: string; trackId: string
    localPlayerId: number; slots: LobbySlot[]; settings: Settings
    results: ResultRow[]; error: string; connecting: boolean
  }
  export function createAppState(settings: Settings): AppState
  export type AppEvent =
    | { kind: 'hostPressed' } | { kind: 'joinPressed' } | { kind: 'soloPressed' }
    | { kind: 'roomCodeEntered'; code: string }
    | { kind: 'connected'; roomCode: string; localPlayerId: number }
    | { kind: 'connectFailed'; message: string }
    | { kind: 'lobbyUpdated'; slots: LobbySlot[] }
    | { kind: 'characterChosen'; characterIdx: number }
    | { kind: 'trackChosen'; trackId: string }
    | { kind: 'settingsChanged'; settings: Settings }
    | { kind: 'raceStarting' }
    | { kind: 'raceTick'; phase: RacePhase; finishedOrder: readonly number[] }
    | { kind: 'raceFinished'; results: ResultRow[] }
    | { kind: 'backToLobby' } | { kind: 'quitToTitle' }
  export function reduceApp(prev: AppState, ev: AppEvent): AppState
  export const SCREEN_TRANSITIONS: Readonly<Record<ScreenId, readonly AppEvent['kind'][]>>
  ```
  ```ts
  // test/fixtures/game-fixtures.ts — appended (contract §9.1)
  export function makeLobbySlots(humanIds?: readonly number[]): LobbySlot[]
  ```

**The forward reference to `results.ts`.** `AppState.results` is `ResultRow[]`, and `ResultRow` lives
in `src/results.ts` (contract §5.12), which is **the next task in this plan**. It sits after this one
rather than before it because the two modules import each other type-only — `results.ts` needs
`LobbySlot` from here — so putting it first would invert this error rather than remove it. The import
here is `import type`, which `verbatimModuleSyntax` erases, so **vitest runs green either way**.
`tsc --noEmit` will report exactly one error, and only until the next task lands:
`src/app.ts(N,M): error TS2307: Cannot find module './results' or its corresponding type declarations.`
That single error is expected and is the correct state of the tree; do not silence it with a stub, a
local re-declaration, or `any`.

**Five screens, and the two things that are deliberately not screens (Q14).**

- **Countdown is not a screen.** `sim` already models it as `phase === 'countdown'`; giving it a
  screen would put one fact in two places, which is the defect class this project keeps paying for.
  The race screen renders the countdown overlay when the view says so.
- **`join/host` is not a screen.** It is the title screen's three buttons (`hostPressed`,
  `joinPressed`, `soloPressed`), with `connecting` and `error` carrying the modal. A screen with two
  buttons and no state of its own is a control, not a screen.
- Consequently **`raceTick` changes nothing.** It is legal on `'race'` and returns `prev` **by
  reference**: `AppState` holds no `phase` and no `finishedOrder`, because the `RaceView` is the
  single source of truth for both. The test below pins that, so a future "just cache the phase here"
  edit fails loudly rather than creating the second copy.

- [ ] **Step 1: Write the failing test**

Append to `packages/game/test/fixtures/game-fixtures.ts` (Tasks 18 and 19 created and extended this
file; keep both existing exports):

```ts
import { CHARACTERS } from '@tapkart/content'
import { MAX_KARTS } from '@tapkart/sim'
import type { LobbySlot } from '../../src/app'

/** MAX_KARTS filled slots. Seats in `humanIds` are connected humans; every other
 *  seat is a bot. Defaults to seat 0 being the only human, which is solo. */
export function makeLobbySlots(humanIds: readonly number[] = [0]): LobbySlot[] {
  const slots: LobbySlot[] = []
  for (let i = 0; i < MAX_KARTS; i++) {
    const human = humanIds.includes(i)
    slots.push({
      playerId: i,
      name: human ? `Player ${i}` : `Bot ${i}`,
      characterIdx: i % CHARACTERS.length,
      isBot: !human,
      connected: true,
      ready: true,
    })
  }
  return slots
}
```

Create `packages/game/test/app.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { MAX_KARTS } from '@tapkart/sim'
import { CHARACTERS, TRACK_MANIFEST } from '@tapkart/content'
// Room codes are protocol's. This file asserts that the reducer DELEGATES to
// them, never what they do: the length, the alphabet and its wire-index order
// belong to one module, and a hard-coded expectation here would be a second copy.
import { ROOM_CODE_LENGTH, isValidRoomCode, normalizeRoomCode } from '@tapkart/protocol'
import type { AppEvent, AppState, ScreenId } from '../src/app'
import { SCREEN_TRANSITIONS, createAppState, reduceApp } from '../src/app'
import { makeLobbySlots, makeSettingsFixture } from './fixtures/game-fixtures'

// Compile-time exhaustive over AppEvent['kind']: adding an event without adding it
// here is a type error, so "no event is dead" below cannot silently stop covering
// the new one.
const KIND_TABLE: Record<AppEvent['kind'], true> = {
  hostPressed: true,
  joinPressed: true,
  soloPressed: true,
  roomCodeEntered: true,
  connected: true,
  connectFailed: true,
  lobbyUpdated: true,
  characterChosen: true,
  trackChosen: true,
  settingsChanged: true,
  raceStarting: true,
  raceTick: true,
  raceFinished: true,
  backToLobby: true,
  quitToTitle: true,
}
const ALL_KINDS = Object.keys(KIND_TABLE) as AppEvent['kind'][]
const ALL_SCREENS: ScreenId[] = ['title', 'characterSelect', 'lobby', 'race', 'results']

/** A LEGAL sample event per kind: every payload is valid, so a rejection below is
 *  the reducer's doing and not the fixture's. */
function sampleEvent(kind: AppEvent['kind']): AppEvent {
  switch (kind) {
    case 'hostPressed': return { kind }
    case 'joinPressed': return { kind }
    case 'soloPressed': return { kind }
    case 'roomCodeEntered': return { kind, code: '7K2MQ' }
    case 'connected': return { kind, roomCode: '7K2MQ', localPlayerId: 2 }
    case 'connectFailed': return { kind, message: 'host went away' }
    case 'lobbyUpdated': return { kind, slots: makeLobbySlots([0, 2]) }
    case 'characterChosen': return { kind, characterIdx: 3 }
    case 'trackChosen': return { kind, trackId: TRACK_MANIFEST[1].id }
    case 'settingsChanged': return { kind, settings: makeSettingsFixture({ playerName: 'Rae', audioVolume: 0.3 }) }
    case 'raceStarting': return { kind }
    case 'raceTick': return { kind, phase: 'racing', finishedOrder: [] }
    case 'raceFinished': return {
      kind,
      results: [{ place: 1, playerId: 2, name: 'Player 2', dnf: false }],
    }
    case 'backToLobby': return { kind }
    case 'quitToTitle': return { kind }
  }
}

/** A populated state parked on `screen`, so a no-op is distinguishable from a
 *  change on every field the reducer touches. */
function stateOn(screen: ScreenId): AppState {
  const base = createAppState(makeSettingsFixture())
  return {
    ...base,
    screen,
    role: screen === 'title' ? 'solo' : 'host',
    roomCode: screen === 'title' ? '' : 'AB23C',
    localPlayerId: screen === 'title' ? -1 : 1,
    slots: makeLobbySlots([0, 1]),
  }
}

function snapshot(s: AppState): string {
  return JSON.stringify(s)
}

/** (screen, kind) pairs that are legal AND deliberately state-free. Exactly one
 *  exists, and it is Q14's countdown ruling in executable form. */
const STATE_FREE: [ScreenId, AppEvent['kind']][] = [['race', 'raceTick']]

function isStateFree(screen: ScreenId, kind: AppEvent['kind']): boolean {
  return STATE_FREE.some((p) => p[0] === screen && p[1] === kind)
}

describe('createAppState', () => {
  it('starts on the title screen with an empty room and no local seat', () => {
    const s = createAppState(makeSettingsFixture({ lastTrackId: TRACK_MANIFEST[2].id }))
    expect(s.screen).toBe('title')
    expect(s.role).toBe('solo')
    expect(s.roomCode).toBe('')
    expect(s.localPlayerId).toBe(-1)
    expect(s.results).toEqual([])
    expect(s.error).toBe('')
    expect(s.connecting).toBe(false)
  })

  it('takes the starting track from the settings, not a literal', () => {
    // CATCHES a hard-coded first track: the player's last choice is persisted for
    // exactly this reason, and a literal here throws it away every launch.
    const s = createAppState(makeSettingsFixture({ lastTrackId: TRACK_MANIFEST[3].id }))
    expect(s.trackId).toBe(TRACK_MANIFEST[3].id)
  })

  it('allocates MAX_KARTS empty slots', () => {
    // CATCHES `slots: []`. Every screen and the HUD index slots by seat; an empty
    // array reads `undefined` for seat 3 and crashes on `.name`.
    const s = createAppState(makeSettingsFixture())
    expect(s.slots).toHaveLength(MAX_KARTS)
    for (const slot of s.slots) {
      expect(slot.playerId).toBe(-1)
      expect(slot.connected).toBe(false)
    }
    expect(s.slots[0]).not.toBe(s.slots[1])
  })
})

describe('SCREEN_TRANSITIONS', () => {
  it('covers all five screens and lists no unknown event kind', () => {
    expect(Object.keys(SCREEN_TRANSITIONS).sort()).toEqual([...ALL_SCREENS].sort())
    for (const screen of ALL_SCREENS) {
      for (const kind of SCREEN_TRANSITIONS[screen]) {
        expect(ALL_KINDS, `${screen} lists an unknown kind: ${kind}`).toContain(kind)
      }
      expect(new Set(SCREEN_TRANSITIONS[screen]).size).toBe(SCREEN_TRANSITIONS[screen].length)
    }
  })

  it('leaves no event dead: every kind is legal on at least one screen', () => {
    // CATCHES an event the union declares and the machine can never process -
    // which compiles, ships, and fails as "the button does nothing".
    for (const kind of ALL_KINDS) {
      const screens = ALL_SCREENS.filter((s) => SCREEN_TRANSITIONS[s].includes(kind))
      expect(screens.length, `${kind} is legal on no screen`).toBeGreaterThan(0)
    }
  })
})

describe('reduceApp - the table IS the legality rule', () => {
  it('returns prev BY REFERENCE for every pair the table does not list', () => {
    // 5 screens x 15 kinds, minus the legal pairs. Reference equality, not deep
    // equality: an identity no-op that allocates a copy defeats every downstream
    // `if (next !== prev) rerender` and repaints the whole UI on every stray event.
    for (const screen of ALL_SCREENS) {
      for (const kind of ALL_KINDS) {
        if (SCREEN_TRANSITIONS[screen].includes(kind)) continue
        const prev = stateOn(screen)
        const next = reduceApp(prev, sampleEvent(kind))
        expect(next, `${screen} + ${kind} must be an identity no-op`).toBe(prev)
      }
    }
  })

  it('produces a new state for every legal pair except the one state-free pair', () => {
    for (const screen of ALL_SCREENS) {
      for (const kind of SCREEN_TRANSITIONS[screen]) {
        const prev = stateOn(screen)
        const next = reduceApp(prev, sampleEvent(kind))
        if (isStateFree(screen, kind)) {
          expect(next, `${screen} + ${kind} is state-free`).toBe(prev)
        } else {
          expect(next, `${screen} + ${kind} is listed but unhandled`).not.toBe(prev)
        }
      }
    }
  })

  it('never mutates prev, on any pair, legal or not', () => {
    // CATCHES in-place edits of the nested slots and settings objects, which pass
    // every "next.x === y" assertion and corrupt the caller's previous state.
    for (const screen of ALL_SCREENS) {
      for (const kind of ALL_KINDS) {
        const prev = stateOn(screen)
        const before = snapshot(prev)
        reduceApp(prev, sampleEvent(kind))
        expect(snapshot(prev), `${screen} + ${kind} mutated prev`).toBe(before)
      }
    }
  })
})

describe('title screen', () => {
  it('hostPressed and joinPressed set the role without leaving the screen', () => {
    const host = reduceApp(stateOn('title'), { kind: 'hostPressed' })
    expect(host.screen).toBe('title')
    expect(host.role).toBe('host')
    expect(host.connecting).toBe(true)

    const join = reduceApp(stateOn('title'), { kind: 'joinPressed' })
    expect(join.screen).toBe('title')
    expect(join.role).toBe('guest')
    expect(join.connecting).toBe(false) // nothing to connect to until a code is typed
  })

  it('soloPressed skips the network entirely and seats the player at 0', () => {
    // CATCHES localPlayerId left at -1 in solo. SessionOptions forbids -1 (§5.10),
    // so the solo race would fail to construct at the composition root.
    const s = reduceApp(stateOn('title'), { kind: 'soloPressed' })
    expect(s.screen).toBe('characterSelect')
    expect(s.role).toBe('solo')
    expect(s.roomCode).toBe('')
    expect(s.localPlayerId).toBe(0)
    expect(s.connecting).toBe(false)
  })

  it('normalises a typed room code and starts connecting', () => {
    const typed = '7k2mq'
    const s = reduceApp(stateOn('title'), { kind: 'roomCodeEntered', code: typed })
    // Asserted BY DELEGATION: whatever protocol's normaliser does, the reducer
    // must do exactly that and nothing of its own. A literal expectation here
    // would be a second copy of rules whose alphabet order is a wire format.
    expect(s.roomCode).toBe(normalizeRoomCode(typed))
    expect(isValidRoomCode(s.roomCode)).toBe(true)
    expect(s.connecting).toBe(true)
    expect(s.error).toBe('')
    expect(s.screen).toBe('title')
  })

  it('rejects a short code with a message instead of connecting', () => {
    // CATCHES a reducer that connects on anything typed. The server would answer
    // "no such room" a second later, which reads to the player as a broken game
    // rather than a typo.
    const short = '7K2'
    expect(isValidRoomCode(short)).toBe(false)   // vacuity guard on the fixture
    const s = reduceApp(stateOn('title'), { kind: 'roomCodeEntered', code: short })
    expect(s.connecting).toBe(false)
    expect(s.error).toBe(`Enter a ${ROOM_CODE_LENGTH}-character room code.`)
    expect(s.screen).toBe('title')
  })

  it('connected keeps the minted code verbatim and moves to character select', () => {
    // The server MINTS codes (spec §5, step 1); `game` normalises what a PLAYER types and
    // displays what it is given. Re-normalising an authoritative code would
    // silently rewrite it.
    const s = reduceApp(stateOn('title'), { kind: 'connected', roomCode: '7K2MQ', localPlayerId: 4 })
    expect(s.screen).toBe('characterSelect')
    expect(s.roomCode).toBe('7K2MQ')
    expect(s.localPlayerId).toBe(4)
    expect(s.connecting).toBe(false)
    expect(s.error).toBe('')
  })
})

describe('character select and lobby', () => {
  it('choosing a character advances to the lobby and persists the choice', () => {
    const s = reduceApp(stateOn('characterSelect'), { kind: 'characterChosen', characterIdx: 5 })
    expect(s.screen).toBe('lobby')
    expect(s.settings.characterIdx).toBe(5)
  })

  it('choosing again in the lobby updates the choice without leaving the lobby', () => {
    const s = reduceApp(stateOn('lobby'), { kind: 'characterChosen', characterIdx: 6 })
    expect(s.screen).toBe('lobby')
    expect(s.settings.characterIdx).toBe(6)
  })

  it('rejects a character index outside the shipped roster, by reference', () => {
    // CATCHES an unvalidated index reaching `bundle.characters[idx]` in the render
    // path, where it is an undefined descriptor and a crash on the first frame.
    for (const bad of [-1, CHARACTERS.length, 99, 1.5, Number.NaN]) {
      const prev = stateOn('characterSelect')
      expect(reduceApp(prev, { kind: 'characterChosen', characterIdx: bad })).toBe(prev)
    }
  })

  it('accepts a track from the manifest and rejects anything else, by reference', () => {
    // CATCHES an unvalidated track id reaching loadTrack, which THROWS on an
    // unknown id (§3a.5) - a total function turned into a crash by one bad string.
    const ok = reduceApp(stateOn('lobby'), { kind: 'trackChosen', trackId: TRACK_MANIFEST[4].id })
    expect(ok.trackId).toBe(TRACK_MANIFEST[4].id)

    const prev = stateOn('lobby')
    expect(reduceApp(prev, { kind: 'trackChosen', trackId: 'atlantis' })).toBe(prev)
    expect(reduceApp(prev, { kind: 'trackChosen', trackId: '' })).toBe(prev)
  })

  it('lobbyUpdated always leaves exactly MAX_KARTS slots, padding a short roster', () => {
    // CATCHES `slots: ev.slots`, which lets a three-player update shrink the array
    // and makes seat 5 `undefined` for every consumer that indexes by seat.
    const short = makeLobbySlots([0]).slice(0, 3)
    const s = reduceApp(stateOn('lobby'), { kind: 'lobbyUpdated', slots: short })
    expect(s.slots).toHaveLength(MAX_KARTS)
    expect(s.slots[0].name).toBe('Player 0')
    expect(s.slots[3].playerId).toBe(-1)
    expect(s.slots[7].connected).toBe(false)
  })

  it('truncates an over-long roster rather than growing past MAX_KARTS', () => {
    const long = [...makeLobbySlots([0]), ...makeLobbySlots([0])]
    const s = reduceApp(stateOn('lobby'), { kind: 'lobbyUpdated', slots: long })
    expect(s.slots).toHaveLength(MAX_KARTS)
  })

  it('copies each slot, so the sender cannot mutate app state afterwards', () => {
    // CATCHES a shallow array copy that keeps the caller's slot objects. The
    // network layer reuses its decode buffers; aliasing them means the lobby list
    // changes under the screen between frames, with no event.
    const incoming = makeLobbySlots([0, 1])
    const s = reduceApp(stateOn('lobby'), { kind: 'lobbyUpdated', slots: incoming })
    incoming[0].name = 'MUTATED'
    incoming[0].ready = false
    expect(s.slots[0].name).toBe('Player 0')
    expect(s.slots[0].ready).toBe(true)
    expect(s.slots[0]).not.toBe(incoming[0])
  })

  it('raceStarting enters the race and clears the previous results', () => {
    // CATCHES stale results surviving into the next race, where the results screen
    // would show the LAST race's standings for a moment after this one ends.
    const withResults: AppState = {
      ...stateOn('lobby'),
      results: [{ place: 1, playerId: 0, name: 'Player 0', dnf: false }],
    }
    const s = reduceApp(withResults, { kind: 'raceStarting' })
    expect(s.screen).toBe('race')
    expect(s.results).toEqual([])
  })
})

describe('race and results', () => {
  it('raceTick puts nothing into AppState (Q14: one source of truth for phase)', () => {
    // THE Q14 TEST. `sim` owns `phase`; the RaceView carries it to the screen. A
    // cached copy here is a second source of truth for the fact that decides
    // whether the countdown overlay is up, and the two WILL disagree by a tick.
    // Reference equality is what makes "it was cached" detectable at all.
    const prev = stateOn('race')
    for (const phase of ['countdown', 'racing', 'finished'] as const) {
      expect(reduceApp(prev, { kind: 'raceTick', phase, finishedOrder: [3, 1, 0] })).toBe(prev)
    }
    expect(Object.keys(prev)).not.toContain('phase')
  })

  it('raceFinished shows the results screen with a copy of the rows', () => {
    const rows = [
      { place: 1, playerId: 2, name: 'Player 2', dnf: false },
      { place: 2, playerId: 0, name: 'Player 0', dnf: true },
    ]
    const s = reduceApp(stateOn('race'), { kind: 'raceFinished', results: rows })
    expect(s.screen).toBe('results')
    expect(s.results).toEqual(rows)
    rows.push({ place: 3, playerId: 5, name: 'Player 5', dnf: true })
    expect(s.results).toHaveLength(2)
  })

  it('backToLobby returns to the lobby with the room intact and the results cleared', () => {
    // Spec §5 step 7: "Results screen, then back to the lobby with the room
    // intact." CATCHES a rematch that drops the room code or the seat, which would
    // silently make the second race a different session.
    const finished: AppState = {
      ...stateOn('results'),
      results: [{ place: 1, playerId: 1, name: 'Player 1', dnf: false }],
    }
    const s = reduceApp(finished, { kind: 'backToLobby' })
    expect(s.screen).toBe('lobby')
    expect(s.results).toEqual([])
    expect(s.roomCode).toBe('AB23C')
    expect(s.localPlayerId).toBe(1)
    expect(s.slots).toHaveLength(MAX_KARTS)
  })
})

describe('leaving, from anywhere', () => {
  it('connectFailed drops back to the title with the reason and a cleared room', () => {
    // CATCHES a disconnect handled only on the title screen, which strands the
    // player on a lobby or a race whose peers are gone - the screen keeps
    // rendering and nothing ever changes again.
    for (const screen of ALL_SCREENS) {
      const prev = stateOn(screen)
      const s = reduceApp(prev, { kind: 'connectFailed', message: 'host went away' })
      expect(s.screen, `from ${screen}`).toBe('title')
      expect(s.error).toBe('host went away')
      expect(s.roomCode).toBe('')
      expect(s.localPlayerId).toBe(-1)
      expect(s.connecting).toBe(false)
      expect(s.slots[0].playerId).toBe(-1)
      expect(s.settings).toEqual(prev.settings)
    }
  })

  it('quitToTitle resets everything except the settings', () => {
    for (const screen of ['characterSelect', 'lobby', 'race', 'results'] as ScreenId[]) {
      const prev: AppState = {
        ...stateOn(screen),
        results: [{ place: 1, playerId: 1, name: 'Player 1', dnf: false }],
        error: 'stale',
      }
      const s = reduceApp(prev, { kind: 'quitToTitle' })
      expect(s.screen, `from ${screen}`).toBe('title')
      expect(s.roomCode).toBe('')
      expect(s.localPlayerId).toBe(-1)
      expect(s.results).toEqual([])
      expect(s.error).toBe('')
      expect(s.settings).toBe(prev.settings)
    }
  })
})

describe('settings', () => {
  it('settingsChanged replaces the settings on every screen', () => {
    // The settings overlay is reachable from everywhere, so this is legal on all
    // five screens - and it must never disturb the rest of the state.
    for (const screen of ALL_SCREENS) {
      const prev = stateOn(screen)
      const next = makeSettingsFixture({ scheme: 'tilt', audioVolume: 0.1 })
      const s = reduceApp(prev, { kind: 'settingsChanged', settings: next })
      expect(s.settings, `on ${screen}`).toBe(next)
      expect(s.screen).toBe(screen)
      expect(s.roomCode).toBe(prev.roomCode)
      expect(s.slots).toBe(prev.slots)
    }
  })

  it('characterChosen writes a NEW settings object rather than mutating the old one', () => {
    // CATCHES `prev.settings.characterIdx = idx`, which edits the object the
    // previous state, the shell and any pending save all still hold.
    const prev = stateOn('lobby')
    const before = JSON.stringify(prev.settings)
    const s = reduceApp(prev, { kind: 'characterChosen', characterIdx: 7 })
    expect(s.settings).not.toBe(prev.settings)
    expect(JSON.stringify(prev.settings)).toBe(before)
    expect(s.settings.characterIdx).toBe(7)
  })
})

describe('the flow a player actually walks', () => {
  it('title -> character select -> lobby -> race -> results -> lobby', () => {
    let s = createAppState(makeSettingsFixture())
    s = reduceApp(s, { kind: 'joinPressed' })
    s = reduceApp(s, { kind: 'roomCodeEntered', code: '7K2MQ' })
    expect(s.connecting).toBe(true)
    s = reduceApp(s, { kind: 'connected', roomCode: '7K2MQ', localPlayerId: 3 })
    expect(s.screen).toBe('characterSelect')
    s = reduceApp(s, { kind: 'characterChosen', characterIdx: 2 })
    expect(s.screen).toBe('lobby')
    s = reduceApp(s, { kind: 'lobbyUpdated', slots: makeLobbySlots([0, 3]) })
    s = reduceApp(s, { kind: 'trackChosen', trackId: TRACK_MANIFEST[2].id })
    s = reduceApp(s, { kind: 'raceStarting' })
    expect(s.screen).toBe('race')
    s = reduceApp(s, { kind: 'raceTick', phase: 'countdown', finishedOrder: [] })
    s = reduceApp(s, { kind: 'raceTick', phase: 'racing', finishedOrder: [] })
    s = reduceApp(s, { kind: 'raceFinished', results: [{ place: 1, playerId: 3, name: 'Player 3', dnf: false }] })
    expect(s.screen).toBe('results')
    s = reduceApp(s, { kind: 'backToLobby' })
    expect(s.screen).toBe('lobby')
    expect(s.role).toBe('guest')
    expect(s.roomCode).toBe('7K2MQ')
    expect(s.localPlayerId).toBe(3)
    expect(s.trackId).toBe(TRACK_MANIFEST[2].id)
    expect(s.settings.characterIdx).toBe(2)
  })

  it('solo reaches the race without ever touching the network fields', () => {
    let s = createAppState(makeSettingsFixture())
    s = reduceApp(s, { kind: 'soloPressed' })
    s = reduceApp(s, { kind: 'characterChosen', characterIdx: 1 })
    s = reduceApp(s, { kind: 'raceStarting' })
    expect(s.screen).toBe('race')
    expect(s.role).toBe('solo')
    expect(s.roomCode).toBe('')
    expect(s.localPlayerId).toBe(0)
    expect(s.connecting).toBe(false)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/game/test/app.test.ts`
Expected: FAIL with `Failed to resolve import "../src/app" from "packages/game/test/app.test.ts". Does the file exist?`

- [ ] **Step 3: Write the implementation**

Create `packages/game/src/app.ts`:

```ts
import type { RacePhase } from '@tapkart/sim'
import { MAX_KARTS } from '@tapkart/sim'
import type { ViewRole } from '@tapkart/render'
import { CHARACTERS, TRACK_MANIFEST } from '@tapkart/content'
// Type-only, and erased by verbatimModuleSyntax. `ResultRow` belongs to the NEXT
// task, and until it lands `tsc` reports one TS2307 here. That is the correct
// state of the tree; a stub would give one type two definitions.
import type { ResultRow } from './results'
import type { Settings } from './settings'
// Room codes are @tapkart/protocol's: there is no game/src/roomcode.ts, because
// the alphabet's ORDER is the 5-bit wire index and a second copy would be a
// second wire format. The code is 5 characters, not 4.
import { ROOM_CODE_LENGTH, isValidRoomCode, normalizeRoomCode } from '@tapkart/protocol'

/** Q14: spec §3's five screens are canonical. Countdown is NOT one of them - `sim`
 *  models it as `phase === 'countdown'` and the race screen reads that from the
 *  view. Neither is join/host: those are the title screen's buttons. */
export type ScreenId = 'title' | 'characterSelect' | 'lobby' | 'race' | 'results'

export interface LobbySlot {
  playerId: number
  name: string
  characterIdx: number
  isBot: boolean
  connected: boolean
  ready: boolean
}

export interface AppState {
  screen: ScreenId
  role: ViewRole // from @tapkart/render; there is no second union
  roomCode: string // '' when solo or not yet minted
  trackId: string
  localPlayerId: number // -1 until connected
  slots: LobbySlot[] // length MAX_KARTS
  settings: Settings
  results: ResultRow[] // [] until the race finishes
  error: string // '' when none
  connecting: boolean
}

export type AppEvent =
  | { kind: 'hostPressed' }
  | { kind: 'joinPressed' }
  | { kind: 'soloPressed' }
  | { kind: 'roomCodeEntered'; code: string }
  | { kind: 'connected'; roomCode: string; localPlayerId: number }
  | { kind: 'connectFailed'; message: string }
  | { kind: 'lobbyUpdated'; slots: LobbySlot[] }
  | { kind: 'characterChosen'; characterIdx: number }
  | { kind: 'trackChosen'; trackId: string }
  | { kind: 'settingsChanged'; settings: Settings }
  | { kind: 'raceStarting' }
  | { kind: 'raceTick'; phase: RacePhase; finishedOrder: readonly number[] }
  | { kind: 'raceFinished'; results: ResultRow[] }
  | { kind: 'backToLobby' }
  | { kind: 'quitToTitle' }

/**
 * Every legal (screen, event.kind) pair, as data. Exported so a test proves the
 * table and the reducer agree - and `reduceApp` READS it, so legality has one
 * definition rather than two that drift.
 */
export const SCREEN_TRANSITIONS: Readonly<Record<ScreenId, readonly AppEvent['kind'][]>> = {
  title: ['hostPressed', 'joinPressed', 'soloPressed', 'roomCodeEntered', 'connected',
          'connectFailed', 'settingsChanged'],
  characterSelect: ['characterChosen', 'lobbyUpdated', 'connectFailed', 'settingsChanged',
                    'quitToTitle'],
  lobby: ['lobbyUpdated', 'characterChosen', 'trackChosen', 'raceStarting', 'connectFailed',
          'settingsChanged', 'quitToTitle'],
  race: ['raceTick', 'raceFinished', 'lobbyUpdated', 'connectFailed', 'settingsChanged',
         'quitToTitle'],
  results: ['backToLobby', 'lobbyUpdated', 'connectFailed', 'settingsChanged', 'quitToTitle'],
}

const ROOM_CODE_ERROR = `Enter a ${ROOM_CODE_LENGTH}-character room code.`

function emptySlot(): LobbySlot {
  return { playerId: -1, name: '', characterIdx: 0, isBot: false, connected: false, ready: false }
}

/** Field by field, never by reference: the network layer reuses its decode
 *  buffers, so an aliased slot changes under the screen with no event. */
function copySlots(src: readonly LobbySlot[]): LobbySlot[] {
  const out: LobbySlot[] = []
  for (let i = 0; i < MAX_KARTS; i++) {
    if (i < src.length) {
      const s = src[i]
      out.push({
        playerId: s.playerId,
        name: s.name,
        characterIdx: s.characterIdx,
        isBot: s.isBot,
        connected: s.connected,
        ready: s.ready,
      })
    } else {
      out.push(emptySlot())
    }
  }
  return out
}

export function createAppState(settings: Settings): AppState {
  const slots: LobbySlot[] = []
  for (let i = 0; i < MAX_KARTS; i++) slots.push(emptySlot())
  return {
    screen: 'title',
    role: 'solo',
    roomCode: '',
    trackId: settings.lastTrackId,
    localPlayerId: -1,
    slots,
    settings,
    results: [],
    error: '',
    connecting: false,
  }
}

/**
 * Pure and total: returns a NEW AppState and never mutates `prev`. SOLE WRITER of
 * every AppState field (§7.2). An event not legal for the current screen is an
 * identity no-op returning `prev` BY REFERENCE, never a throw - and so is an event
 * whose payload names something that does not ship (a character past the roster, a
 * track that is not in the manifest), because the alternative is a crash three
 * layers down in `loadTrack` or the descriptor lookup.
 */
export function reduceApp(prev: AppState, ev: AppEvent): AppState {
  if (!SCREEN_TRANSITIONS[prev.screen].includes(ev.kind)) return prev

  switch (ev.kind) {
    case 'hostPressed':
      return { ...prev, role: 'host', roomCode: '', connecting: true, error: '' }

    case 'joinPressed':
      // No connection is attempted until a code is entered, so `connecting` stays
      // false: the title screen shows the code field, not a spinner.
      return { ...prev, role: 'guest', roomCode: '', connecting: false, error: '' }

    case 'soloPressed':
      // Seat 0, immediately: SessionOptions forbids localPlayerId === -1 (§5.10),
      // and solo still runs a real AuthorityLoop over a loopback transport (Q15).
      return {
        ...prev,
        screen: 'characterSelect',
        role: 'solo',
        roomCode: '',
        localPlayerId: 0,
        connecting: false,
        error: '',
      }

    case 'roomCodeEntered': {
      const code = normalizeRoomCode(ev.code)
      if (!isValidRoomCode(code)) {
        return { ...prev, roomCode: code, connecting: false, error: ROOM_CODE_ERROR }
      }
      return { ...prev, roomCode: code, connecting: true, error: '' }
    }

    case 'connected':
      // The code is the SERVER's (spec §5, step 1). `game` normalises what a player
      // types and displays what it is given - re-normalising here would rewrite an
      // authoritative value.
      return {
        ...prev,
        screen: 'characterSelect',
        roomCode: ev.roomCode,
        localPlayerId: ev.localPlayerId,
        connecting: false,
        error: '',
      }

    case 'connectFailed': {
      // Legal on every screen: a connection can die during the lobby or mid-race,
      // and leaving the player on a screen whose peers are gone is a dead end.
      const next = createAppState(prev.settings)
      next.error = ev.message
      return next
    }

    case 'lobbyUpdated':
      return { ...prev, slots: copySlots(ev.slots) }

    case 'characterChosen': {
      if (!Number.isInteger(ev.characterIdx)) return prev
      if (ev.characterIdx < 0 || ev.characterIdx >= CHARACTERS.length) return prev
      // The choice lives in Settings, which is what persists it and what the
      // session reads. The lobby SLOT's characterIdx stays the room's to write, so
      // one fact keeps one owner.
      const settings: Settings = { ...prev.settings, characterIdx: ev.characterIdx }
      return {
        ...prev,
        settings,
        screen: prev.screen === 'characterSelect' ? 'lobby' : prev.screen,
      }
    }

    case 'trackChosen': {
      let known = false
      for (const entry of TRACK_MANIFEST) {
        if (entry.id === ev.trackId) {
          known = true
          break
        }
      }
      if (!known) return prev
      return { ...prev, trackId: ev.trackId }
    }

    case 'settingsChanged':
      return { ...prev, settings: ev.settings }

    case 'raceStarting':
      return { ...prev, screen: 'race', results: [], error: '' }

    case 'raceTick':
      // Deliberately state-free (Q14). `phase` and `finishedOrder` reach the screen
      // through the RaceView, which is their single source of truth; caching them
      // here would create the second copy, and the two would disagree by a tick.
      return prev

    case 'raceFinished':
      return { ...prev, screen: 'results', results: ev.results.slice() }

    case 'backToLobby':
      // Spec §5, step 7: back to the lobby with the room intact.
      return { ...prev, screen: 'lobby', results: [], error: '' }

    case 'quitToTitle':
      return createAppState(prev.settings)
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/game/test/app.test.ts`
Expected: PASS, 30 tests.

Run: `npx vitest run`
Expected: PASS. Tasks 18 and 19's suites stay green.

Run: `npx tsc --noEmit -p packages/game/tsconfig.json`
Expected: **exactly one** error, and only until the next task lands:
`src/app.ts(N,M): error TS2307: Cannot find module './results' or its corresponding type declarations.`
Any other error is this task's to fix. If `Cannot find module '@tapkart/render'` appears as well, the
render package task has not landed yet — that is the same kind of forward reference and the same rule
applies: do not stub it.

- [ ] **Step 5: Commit**

```bash
git add packages/game/src/app.ts packages/game/test/app.test.ts \
        packages/game/test/fixtures/game-fixtures.ts && \
git commit -m "feat(game): the five-screen app state machine, pure and table-driven

Q14's five screens: title, characterSelect, lobby, race, results.
Countdown is not one of them - sim owns phase and the RaceView carries
it - and raceTick is legal on the race screen precisely so that it can
return prev BY REFERENCE and keep AppState from growing a second copy.
join/host are the title screen's buttons, with connecting and error
carrying the modal. SCREEN_TRANSITIONS is the single definition of
legality: reduceApp reads it, so the table and the reducer cannot drift.
Events naming content that does not ship - a character past the roster, a
track outside the manifest - are identity no-ops rather than crashes in
loadTrack."
```

---

### Task 21: `packages/game/src/results.ts` — result rows and DNF

Split out of the shell task and placed **immediately after the screen-state-machine
task**, for one reason: `app.ts` and `results.ts` import each other, type-only, in both
directions. `app.ts` has `import type { ResultRow } from './results'` because
`AppState.results` is `ResultRow[]`; `results.ts` has `import type { LobbySlot } from
'./app'` because a result row takes its displayed name from the lobby slot. Neither
symbol can move to break the cycle without breaking contract §11's per-module census
(`game/app` = 7, `game/results` = 3).

That means placing this task *before* the app task does not clear the error — it
**inverts** it, shipping `TS2307: Cannot find module './app'` in place of `TS2307:
Cannot find module './results'`. Placed here, the app task keeps exactly one transient
`tsc` error (which its own Step 4 documents and forbids stubbing) and this task clears
it in the very next step, instead of leaving it open across three more tasks where an
implementer running `tsc` would have to remember it was expected.

Vitest is green either way, because `import type` is erased. That is what makes this the
kind of error a plan carries to the end without noticing.

**Files:**
- Create: `packages/game/src/results.ts`
- Test: `packages/game/test/results.test.ts`

Do **not** touch `packages/game/src/index.ts` (the shell task owns the barrel, contract
§5.15) and do **not** touch `packages/game/src/app.ts` — the previous task created it and
it already imports `ResultRow` from this module.

**Interfaces:**

- Consumes, from `@tapkart/sim` (§2.1, §2.2):
  ```ts
  export const RACE_LAPS = 3
  export const FINISH_GRACE_TICKS = 1800      // 30 s at 60 Hz, packages/sim/src/phase.ts:14
  export const MAX_KARTS = 8                  // the test only
  ```
- Consumes, from `@tapkart/render` (§4.2) — reachable by bare specifier only after the
  render barrel task has landed:
  ```ts
  export interface KartView { /* §4.2 */ characterIdx: number; lap: number; playerId: number }
  export interface RaceView { tick: number; alpha: number; phase: RacePhase; localPlayerId: number
    raceStartTick: number; karts: KartView[]; entities: EntityView[]; entityCount: number
    itemBoxes: ItemBoxView[]; itemBoxRespawnTicks: number; finishedOrder: number[]
    finishTick: number; countdownTicksLeft: number }
  export function createRaceView(itemBoxCount: number): RaceView     // value, test only
  ```
- Consumes, from `@tapkart/content` (§3a.6):
  ```ts
  export interface ContentBundle { characters: readonly CharacterDescriptor[]
                                   karts: readonly KartDescriptor[]
                                   themes: Readonly<Record<string, TrackTheme>> }
  export function loadContentBundle(): ContentBundle               // memoised
  ```
- Consumes, from `./app` (the previous task), **type-only**:
  ```ts
  export interface LobbySlot { playerId: number; name: string; characterIdx: number
                               isBot: boolean; connected: boolean; ready: boolean }
  ```

- Produces:
  ```ts
  // packages/game/src/results.ts — the three symbols §11 allocates to game/results
  export interface ResultRow { place: number; playerId: number; name: string; dnf: boolean }
  export function isDnf(view: RaceView, kart: KartView): boolean
  export function buildResultRows(view: RaceView, slots: readonly LobbySlot[]): ResultRow[]
  ```
  The shell task consumes `buildResultRows` from here and re-exports `./results` from the
  barrel; its `barrel.test.ts` namespace-imports this module and asserts
  `buildResultRows` reaches `@tapkart/game`. `isDnf` is used through `buildResultRows`
  and is exported because §11 says three.

**What this task decides, and why**

- **Q16: positions only.** Client-recorded times are non-authoritative and differ per
  peer, so a results screen with times would show eight players eight different sets of
  numbers for the same race. `ResultRow` carries no time and `game` records none.
- **Q17: DNF is derived in `game`, from facts it already has.** A kart is DNF **iff** the
  race ended by grace-timer expiry *and* that kart's lap progress is short of
  `RACE_LAPS`. No sim change, no wire change. Showing a timed-out player "4th" with no
  qualifier is a lie the results screen tells, and `isDnf` is the one line that stops
  telling it.

---

- [ ] **Step 1: Write the failing test**

Create `packages/game/test/results.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { FINISH_GRACE_TICKS, MAX_KARTS, RACE_LAPS } from '@tapkart/sim'
import type { RaceView } from '@tapkart/render'
import { createRaceView } from '@tapkart/render'
import { loadContentBundle } from '@tapkart/content'
import type { LobbySlot } from '../src/app'
import { buildResultRows, isDnf } from '../src/results'

/** A finished race, with `laps` per seat and `order` as the finishing order. */
function makeFinishedView(opts: {
  laps: readonly number[]
  order: readonly number[]
  finishTick: number
  tick: number
  phase?: 'racing' | 'finished'
}): RaceView {
  const view = createRaceView(0)
  view.phase = opts.phase ?? 'finished'
  view.tick = opts.tick
  view.finishTick = opts.finishTick
  for (let i = 0; i < MAX_KARTS; i++) {
    view.karts[i].playerId = i
    view.karts[i].characterIdx = i
    view.karts[i].lap = opts.laps[i]
    view.finishedOrder[i] = i < opts.order.length ? opts.order[i] : -1
  }
  return view
}

// `string | undefined` in the value type is required, not cosmetic: with
// noUncheckedIndexedAccess off, a bare Record<number, string> index is typed
// `string`, and `names[i] === undefined` is then a TS2367 "no overlap" error.
function slots(names: Readonly<Record<number, string | undefined>>): LobbySlot[] {
  const out: LobbySlot[] = []
  for (let i = 0; i < MAX_KARTS; i++) {
    out.push({
      playerId: i,
      name: names[i] ?? '',
      characterIdx: i,
      isBot: names[i] === undefined,
      connected: true,
      ready: true,
    })
  }
  return out
}

describe('isDnf (Q17)', () => {
  it('marks a kart short of RACE_LAPS iff the race ended by grace expiry', () => {
    const laps = [3, 3, 1, 3, 3, 3, 3, 3]
    const short = 2

    // Rows are [label, value] pairs on purpose: `it.each` spreads any row that
    // is itself an array, so a bare table silently re-tests the previous case.
    const cases: Array<[string, RaceView, boolean]> = [
      [
        'still racing',
        makeFinishedView({ laps, order: [0], finishTick: 100, tick: 100 + FINISH_GRACE_TICKS, phase: 'racing' }),
        false,
      ],
      [
        'finished but nobody has crossed (finishTick -1)',
        makeFinishedView({ laps, order: [], finishTick: -1, tick: 9_000 }),
        false,
      ],
      [
        'one tick before the grace timer expires',
        makeFinishedView({ laps, order: [0], finishTick: 100, tick: 100 + FINISH_GRACE_TICKS - 1 }),
        false,
      ],
      [
        'exactly at grace expiry',
        makeFinishedView({ laps, order: [0], finishTick: 100, tick: 100 + FINISH_GRACE_TICKS }),
        true,
      ],
      [
        'long after grace expiry',
        makeFinishedView({ laps, order: [0], finishTick: 100, tick: 100 + FINISH_GRACE_TICKS + 5_000 }),
        true,
      ],
    ]
    for (const [label, view, expected] of cases) {
      expect(`${label}: ${isDnf(view, view.karts[short])}`).toBe(`${label}: ${expected}`)
      // The kart that DID finish is never DNF, whatever the timer says.
      expect(isDnf(view, view.karts[0])).toBe(false)
    }
  })

  it('marks nobody in an all-finished race, at any tick after the finish', () => {
    const view = makeFinishedView({
      laps: [3, 3, 3, 3, 3, 3, 3, 3],
      order: [3, 1, 0, 2, 5, 4, 7, 6],
      finishTick: 500,
      tick: 500 + FINISH_GRACE_TICKS + 100_000,
    })
    for (let i = 0; i < MAX_KARTS; i++) expect(isDnf(view, view.karts[i])).toBe(false)
    expect(RACE_LAPS).toBe(3)
  })
})

describe('buildResultRows (Q16)', () => {
  it('walks finishedOrder in slot order and numbers places from 1', () => {
    const view = makeFinishedView({
      laps: [3, 3, 3, 3, 3, 3, 3, 3],
      order: [5, 2, 0, 7, 1, 3, 6, 4],
      finishTick: 500,
      tick: 600,
    })
    const rows = buildResultRows(view, slots({ 2: 'Ada' }))
    expect(rows.map((r) => r.playerId)).toEqual([5, 2, 0, 7, 1, 3, 6, 4])
    expect(rows.map((r) => r.place)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(rows.every((r) => r.dnf === false)).toBe(true)
  })

  it('emits one row per FILLED slot and skips the -1 padding', () => {
    const view = makeFinishedView({
      laps: [3, 1, 3, 0, 0, 0, 0, 0],
      order: [0, 2],
      finishTick: 500,
      tick: 600,
    })
    const rows = buildResultRows(view, slots({}))
    expect(rows.length).toBe(2)
    expect(rows.map((r) => r.playerId)).toEqual([0, 2])
  })

  it('takes the name from the lobby slot and falls back to the descriptor', () => {
    const view = makeFinishedView({
      laps: [3, 3, 3, 3, 3, 3, 3, 3],
      order: [0, 4],
      finishTick: 500,
      tick: 600,
    })
    const rows = buildResultRows(view, slots({ 0: 'Ada' }))
    expect(rows[0].name).toBe('Ada')
    // Seat 4 has no lobby name; characterIdx 4 supplies the DISPLAYED name.
    // CharacterStats.name ('Racer 4') is never shown — the descriptor's is.
    const descriptors = loadContentBundle().characters
    expect(rows[1].name).toBe(descriptors[4].name)
    expect(rows[1].name).not.toBe('')
  })

  it('marks the graced-out short karts DNF and nobody else', () => {
    // 5 finished; 3 were still driving when the 30 s timer expired and were
    // appended in placement order by updatePhase.
    const view = makeFinishedView({
      laps: [3, 3, 3, 3, 3, 2, 1, 0],
      order: [0, 1, 2, 3, 4, 5, 6, 7],
      finishTick: 500,
      tick: 500 + FINISH_GRACE_TICKS,
    })
    const rows = buildResultRows(view, slots({}))
    expect(rows.filter((r) => r.dnf).map((r) => r.playerId)).toEqual([5, 6, 7])
    expect(rows.filter((r) => !r.dnf).map((r) => r.playerId)).toEqual([0, 1, 2, 3, 4])
    // Places stay contiguous: a DNF still has a position.
    expect(rows.map((r) => r.place)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/game/test/results.test.ts`

Expected: FAIL at collection with
`Error: Failed to load url ../src/results (resolved id: .../packages/game/src/results) ... Does the file exist?`

`../src/app` resolves — the previous task created it — so this is the **only**
unresolved import, and that is the point of running it here rather than earlier.

- [ ] **Step 3: Write `packages/game/src/results.ts`**

```ts
// PURE — Q16 and Q17. No clock, no DOM, no randomness.
import { FINISH_GRACE_TICKS, RACE_LAPS } from '@tapkart/sim'
import type { KartView, RaceView } from '@tapkart/render'
import { loadContentBundle } from '@tapkart/content'
import type { LobbySlot } from './app'

export interface ResultRow {
  place: number // 1-based
  playerId: number
  name: string // from the lobby slot; falls back to the descriptor name
  dnf: boolean
}

/**
 * Q17, literally: a kart is DNF iff the race ended by GRACE-TIMER EXPIRY and
 * that kart's lap progress is short of RACE_LAPS.
 *
 * Both facts are already available to `game`, so there is no sim change and no
 * wire change. Showing a timed-out player "4th" with no qualifier is a lie the
 * results screen tells, and this is the one line that stops telling it.
 */
export function isDnf(view: RaceView, kart: KartView): boolean {
  const gracedOut =
    view.phase === 'finished' &&
    view.finishTick >= 0 &&
    view.tick - view.finishTick >= FINISH_GRACE_TICKS
  return gracedOut && kart.lap < RACE_LAPS
}

/**
 * Walks `view.finishedOrder` in slot order — which IS the finishing order,
 * including the grace-expiry entries `updatePhase` appends in placement order —
 * and emits one row per filled slot.
 *
 * Positions only (Q16): no times, no best lap, because client-recorded times are
 * non-authoritative and differ per peer, so the same race would show eight
 * players eight different sets of numbers.
 */
export function buildResultRows(view: RaceView, slots: readonly LobbySlot[]): ResultRow[] {
  const rows: ResultRow[] = []
  // Memoised, so this parses nothing after the first call anywhere in the
  // process. CharacterStats.name is 'Racer 4' and is never displayed; the
  // DISPLAYED name is the descriptor's (§3a.2), joined by index and never by id.
  const descriptors = loadContentBundle().characters

  for (let i = 0; i < view.finishedOrder.length; i++) {
    const playerId = view.finishedOrder[i]
    if (playerId < 0 || playerId >= view.karts.length) continue // -1 padding
    const kart = view.karts[playerId]

    let name = ''
    for (let s = 0; s < slots.length; s++) {
      if (slots[s].playerId === playerId) {
        name = slots[s].name
        break
      }
    }
    if (name === '') {
      const idx = kart.characterIdx
      name = idx >= 0 && idx < descriptors.length ? descriptors[idx].name : `Player ${playerId + 1}`
    }

    rows.push({ place: rows.length + 1, playerId, name, dnf: isDnf(view, kart) })
  }
  return rows
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/game/test/results.test.ts`
Expected: **6 passing**.

If `loadContentBundle()` throws, the Q2/Q3 content task has not landed yet; the fix is
there, not here — do not stub it.

Then the typecheck, which is the whole reason this task sits where it does:

```bash
npx tsc --noEmit -p packages/game/tsconfig.json
```

Expected: **no output.** The previous task shipped with exactly one `TS2307: Cannot find
module './results'` from `app.ts`, documented there and deliberately not stubbed; this
file clears it. If `tsc` still reports it, the file was written somewhere other than
`packages/game/src/results.ts`. If it now reports `TS2307: Cannot find module './app'`
instead, this task ran **before** the app task rather than after it, which is the exact
inversion the ordering above exists to avoid.

**What each test catches, and whether it would actually fail under that bug:**

| Test | Bug | Fails? |
|---|---|---|
| `isDnf` table | using `>` instead of `>=` at the grace boundary, forgetting the `finishTick >= 0` guard, or marking DNF in a race that is merely `'finished'` early | yes — the boundary is asserted at grace−1, grace and grace+5000, and the finisher is asserted false in every case. The rows are `[label, value]` triples on purpose: `it.each` **spreads** a row that is itself an array, so a bare table silently re-tests the previous case, and an array-rejection bug has already passed under that shape in this project |
| all-finished marks nobody | keying DNF off "the grace timer expired" alone | yes |
| finishedOrder walk | sorting by `place`, or by playerId, instead of walking the finishing order | yes — the order given is deliberately not sorted |
| skips the −1 padding | `indexOf`/`filter`-based scanning that treats padding as a finisher | yes — 8 rows instead of 2 |
| name fallback | falling back to `CharacterStats.name` ('Racer 4') instead of the descriptor's displayed name | yes — the test compares against the real shipped descriptor |
| DNF marking | marking finishers DNF, or dropping DNF rows from the list | yes — places would not be contiguous |

- [ ] **Step 5: Commit**

```bash
git add packages/game/src/results.ts packages/game/test/results.test.ts && \
git commit -m "feat(game): result rows and DNF, positions only (Q16, Q17)"
```

---

### Task 22: `packages/game/src/session.ts` and `src/localinput.ts` — the composition root for one race

**Files:**
- Create: `packages/game/src/localinput.ts`
- Create: `packages/game/src/session.ts`
- Modify: `packages/game/test/fixtures/game-fixtures.ts` — **append** `makeGameContext`, `makeSessionPair` and `makeCorrectingGuest` (§9.1). Task 18 created this file and Tasks 19 and 20 appended to it; **nobody overwrites it**. `makeControlInputsFixture`, `makeSettingsFixture` and `makeLobbySlots` are already there. `makeGameContext` has no other owner in this plan, so it lands here alongside the two session fixtures that need it — add it only if it is not already present.
- Test: `packages/game/test/session.test.ts`

**Interfaces:**

- Consumes, from `@tapkart/sim` (contract §2.1, §2.2 — all verified against shipped source):
  ```ts
  export type Vec3 = { x: number; y: number; z: number }
  export const MAX_KARTS = 8
  export const MAX_ENTITIES = 32
  export const COUNTDOWN_TICKS = 180
  export interface Intent { tick: number; steer: number; accel: number; brake: boolean; drift: boolean; useItem: boolean }
  export interface SimContext { track: Track; query: TrackQuery; tuning: Tuning; characters: CharacterStats[]; isLeader: boolean }
  export interface SimState { tick: number; phase: RacePhase; /* …§2.1 */ karts: KartState[]; entities: EntityState[]; entityCount: number; itemBoxes: ItemBoxState[]; finishedOrder: number[] }
  export function createState(ctx: SimContext, seed: number, characterIdx: number[]): SimState
  export function cloneState(src: SimState, dst: SimState): void
  export function statesEqual(a: SimState, b: SimState): boolean
  export function allocStateLike(ctx: SimContext, src: SimState): SimState
  export function resetBotHold(): void          // packages/sim/src/phase.ts:41 — clears the 30 Hz module-scope bot hold
  ```
- Consumes, from `@tapkart/net` (contract §2.4 + the §2.5 gate, which Task 1 verified is open):
  ```ts
  export interface Transport { send(channel: ChannelName, peerId: string, data: Uint8Array): void
    broadcast(channel: ChannelName, data: Uint8Array): void
    onMessage(cb: (peerId: string, channel: ChannelName, data: Uint8Array) => void): void
    onPeerLost(cb: (peerId: string) => void): void
    peers(): string[]; close(): void }
  export interface LoopbackOptions { latencyMs: number; jitterMs: number; lossRate: number; seed: number }
  export function makeLoopbackPair(opts: LoopbackOptions): { a: Transport; b: Transport; pump(nowMs: number): void }
  export class AuthorityLoop { constructor(ctx: SimContext, state: SimState, t: Transport); tick(): void; state(): SimState }
  export class ClientLoop { constructor(ctx: SimContext, playerId: number, t: Transport); tick(localIntent: Intent): void; corrections(): number; state(): SimState }
  export interface RemoteSample { position: { x: number; y: number; z: number }; heading: number; kart: WireKart }
  export interface RemoteEntitySample { position: { x: number; y: number; z: number }; heading: number; entity: WireEntity }
  /** P2-R29: the buffers are the CALLER's, made once. This task never calls
   *  these — the view task (Task 23) owns the two buffers — but the session's
   *  wrappers below must have the same shape, so the shape is quoted here. */
  export function makeRemoteSample(): RemoteSample
  export function makeRemoteEntitySample(): RemoteEntitySample
  export class RemoteInterpolator {
    push(kf: RemoteKeyframe): void
    /** SHIPPED SIGNATURE. Three arguments and a boolean: `out` is filled in
     *  place, and `false` means no sample and leaves `out` UNTOUCHED. */
    sampleKart(playerId: number, nowMs: number, out: RemoteSample): boolean
    sampleEntity(entityId: number, nowMs: number, out: RemoteEntitySample): boolean
    liveEntityIds(out: Int32Array): number
  }
  export function remoteInterpolatorOf(client: ClientLoop): RemoteInterpolator
  export function correctionDeltaOf(client: ClientLoop, outPos: Vec3): number | null
  export const LOCAL_PEER_ID = 'local'
  /** SHIPPED SIGNATURE. Two arguments, not three: the tick comes from
   *  `intent.tick`, and the decorator reads that field to apply the 30 Hz wire
   *  cadence ITSELF, dropping the odd ticks exactly as a guest's ClientLoop does.
   *  Call it once per sim tick and impose no cadence of your own — a caller that
   *  halves the rate again ships 15 Hz input, and a caller that skips the
   *  decorator to "fix" that hands the host twice a guest's steering
   *  granularity, which is the asymmetry the decorator exists to remove. */
  export interface LocalInputTransport extends Transport {
    submitLocalInput(playerId: number, intent: Intent): void
  }
  export function withLocalInput(inner: Transport): LocalInputTransport
  export function createNullTransport(): Transport
  ```
- Consumes, from `@tapkart/render` (contract §4.2):
  ```ts
  export type ViewRole = 'host' | 'guest' | 'solo'
  export interface RaceView { tick: number; alpha: number; phase: RacePhase; localPlayerId: number
    raceStartTick: number; karts: KartView[]; entities: EntityView[]; entityCount: number
    itemBoxes: ItemBoxView[]; itemBoxRespawnTicks: number; finishedOrder: number[]
    finishTick: number; countdownTicksLeft: number }
  export function createRaceView(itemBoxCount: number): RaceView
  ```
- Consumes, from `./clock` (contract §5.1, Task 17):
  ```ts
  export function renderNowMs(tick: number, alpha: number): number   // (tick + alpha) * TICK_MS
  ```
- Consumes, from `packages/game/test/fixtures/game-fixtures.ts` (§9.1):
  ```ts
  export function makeGameContext(isLeader?: boolean): SimContext
  ```
- Consumes, from `packages/sim/test/fixtures/track-fixtures.ts` by **relative path only** (§2.6):
  ```ts
  export function makeOvalTrack(overrides?: Partial<Track>): Track
  export function makeContext(track: Track, isLeader?: boolean): SimContext
  ```
- **Does not consume, but every caller that builds a `SimContext` must know** (found by the author of Tasks 1–3 while running their code, and documented in Task 2's `Produces`): `@tapkart/content` exports `CHARACTERS: readonly CharacterStats[]`, which is **not assignable** to `SimContext.characters: CharacterStats[]`. A composition root must write `characters: CHARACTERS.slice()`. `TUNING: Readonly<Tuning>` *does* assign to `tuning: Tuning`, so the asymmetry is easy to miss — arrays are the case that bites. `createSession` takes `ctx` ready-made and never builds one; the shell (Task 24) does, and writes the `.slice()`.

- Produces:
  ```ts
  // packages/game/src/localinput.ts
  export function createSoloTransport(): LocalInputTransport

  // packages/game/src/session.ts
  export interface SessionOptions {
    role: ViewRole
    ctx: SimContext             // ctx.isLeader MUST equal (role !== 'guest')
    localPlayerId: number       // 0..MAX_KARTS-1; -1 is not allowed
    seed: number
    characterIdx: number[]      // length MAX_KARTS
    transport: Transport        // NEVER null (Q15)
  }
  export interface RaceSession {
    readonly role: ViewRole
    readonly localPlayerId: number
    readonly ctx: SimContext
    readonly characterIdx: readonly number[]
    readonly raceStartTick: number
    tickOnce(localIntent: Intent): void
    state(): SimState
    prevState(): SimState
    sampleRemoteKart(playerId: number, nowMs: number, out: RemoteSample): boolean
    sampleRemoteEntity(entityId: number, nowMs: number, out: RemoteEntitySample): boolean
    remoteEntityIds(out: Int32Array): number
    corrections(): number
    correctionDelta(outPos: Vec3): number | null
    currentView(): RaceView      // the view THIS frame is built into
    prevView(): RaceView         // the view the PREVIOUS frame was built into
    swapViews(): void            // exchanges them; called AFTER audio.apply, never before
    close(): void
  }
  export function createSession(opts: SessionOptions): RaceSession
  ```
  Task 23 (`view.ts`) consumes every member above. Task 24 (`shell.ts`) consumes `createSession`, `currentView`, `prevView` and `swapViews`. Task 14 (`audio.ts`) references `prevView()`/`currentView()` as the two arguments of `buildAudioModel`.

**Two things this task decides, and why**

1. **`transport` is never `null` (Q15).** Solo composes a real transport —
   `withLocalInput(createNullTransport())` — so exactly one code path exists and
   solo, the mode that will be run thousands of times during development,
   exercises the same `AuthorityLoop` the host runs. A `null` transport creates a
   second path that is simpler in the moment and untested forever; this project
   has already paid for one of those.

2. **The session owns TWO `RaceView`s and the swap** (contract amendment, this
   task's ruling). `buildAudioModel(prev, view, out)` derives every one-shot from
   the delta between two views, and §5.11's `ViewBuilder.build` is the sole
   writer of every `RaceView` field. With one view, `prev` **is** `view`, every
   delta is empty and no `lapCross`, `impact`, `boost`, `spinOut`, `itemPickup`,
   `itemUse` or `finish` cue can ever fire in the shipped game — while the unit
   test of `buildAudioModel` stays green, because it hand-builds its two views.
   The session allocates both (it owns the race's lifetime and knows
   `ctx.track.itemBoxes.length`), and `createViewBuilder` (Task 23) primes both
   before the first frame so frame 1's delta is empty rather than "a real view
   minus a zeroed one". **`swapViews()` is called by the shell AFTER
   `audio.apply`** — cues are consumed in the frame they are raised, so swapping
   earlier drops them. The double buffer does not weaken §7.2: there are two
   objects with one writer, not one object with two.

---

- [ ] **Step 1: Write the failing test**

Create `packages/game/test/session.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { Intent, SimState } from '@tapkart/sim'
import {
  COUNTDOWN_TICKS,
  MAX_ENTITIES,
  MAX_KARTS,
  createState,
  resetBotHold,
  statesEqual,
} from '@tapkart/sim'
import {
  createNullTransport,
  makeRemoteEntitySample,
  makeRemoteSample,
  withLocalInput,
} from '@tapkart/net'
import { renderNowMs } from '../src/clock'
import { createSoloTransport } from '../src/localinput'
import type { RaceSession } from '../src/session'
import { createSession } from '../src/session'
import { makeGameContext, makeSessionPair } from './fixtures/game-fixtures'

const CHARACTER_IDX = [3, 5, 1, 7, 2, 6, 0, 4]

function intent(steer: number, accel: number): Intent {
  return { tick: 0, steer, accel, brake: false, drift: false, useItem: false }
}

/** A solo session on the shared fixture context, with a fresh solo transport. */
function makeSolo(localPlayerId = 0): RaceSession {
  return createSession({
    role: 'solo',
    ctx: makeGameContext(true),
    localPlayerId,
    seed: 0x5EED,
    characterIdx: CHARACTER_IDX.slice(),
    transport: createSoloTransport(),
  })
}

/** Runs `ticks` ticks with one held intent and returns the local kart position. */
function driveSolo(steer: number, accel: number, ticks: number): { x: number; z: number } {
  // The 30 Hz bot hold is module-scope in packages/sim/src/phase.ts, so a
  // previous run in this process can otherwise leak one odd tick of bot intent
  // into this one. Clearing it is what makes the comparison below exact.
  resetBotHold()
  const s = makeSolo(0)
  const it = intent(steer, accel)
  for (let t = 0; t < ticks; t++) s.tickOnce(it)
  const p = s.state().karts[0].position
  const out = { x: p.x, z: p.z }
  s.close()
  return out
}

describe('createSession — construction and validation', () => {
  it('starts host and solo in countdown, with raceStartTick = COUNTDOWN_TICKS (R44)', () => {
    const solo = makeSolo()
    const host = createSession({
      role: 'host',
      ctx: makeGameContext(true),
      localPlayerId: 2,
      seed: 7,
      characterIdx: CHARACTER_IDX.slice(),
      transport: withLocalInput(createNullTransport()),
    })

    expect(solo.state().phase).toBe('countdown')
    expect(host.state().phase).toBe('countdown')
    expect(solo.raceStartTick).toBe(COUNTDOWN_TICKS)
    expect(host.raceStartTick).toBe(COUNTDOWN_TICKS)
    solo.close()
    host.close()
  })

  it('flips the local seat to a human on host and solo (§2.4 fact 2)', () => {
    const s = makeSolo(3)
    expect(s.state().karts[3].isBot).toBe(false)
    expect(s.state().karts[3].connected).toBe(true)
    // Every other seat is still bot-driven.
    expect(s.state().karts[4].isBot).toBe(true)
    expect(s.state().karts[4].connected).toBe(false)
    s.close()
  })

  it('carries characterIdx itself, because the wire does not (§2.3 fact 1)', () => {
    const pair = makeSessionPair()
    // ClientLoop builds its predicted state with an ALL-ZERO characterIdx, so
    // these two sources are provably different before the assertion is made.
    expect(pair.guest.state().karts[2].characterIdx).toBe(0)
    expect(pair.guest.characterIdx[2]).toBe(2)
    expect(pair.guest.characterIdx.length).toBe(MAX_KARTS)
    pair.host.close()
    pair.guest.close()
  })

  it('copies characterIdx, so a caller mutating its array cannot rewrite the race', () => {
    const mine = CHARACTER_IDX.slice()
    const s = createSession({
      role: 'solo',
      ctx: makeGameContext(true),
      localPlayerId: 0,
      seed: 1,
      characterIdx: mine,
      transport: createSoloTransport(),
    })
    mine[4] = 7
    expect(s.characterIdx[4]).toBe(2)
    s.close()
  })

  it('rejects a plain Transport for host and solo, instead of racing bot-driven', () => {
    expect(() =>
      createSession({
        role: 'solo',
        ctx: makeGameContext(true),
        localPlayerId: 0,
        seed: 1,
        characterIdx: CHARACTER_IDX.slice(),
        transport: createNullTransport(),
      }),
    ).toThrow(/requires a LocalInputTransport/)
  })

  it('rejects an illegal localPlayerId and a role/isLeader mismatch', () => {
    expect(() =>
      createSession({
        role: 'solo',
        ctx: makeGameContext(true),
        localPlayerId: -1,
        seed: 1,
        characterIdx: CHARACTER_IDX.slice(),
        transport: createSoloTransport(),
      }),
    ).toThrow(/localPlayerId -1/)

    expect(() =>
      createSession({
        role: 'guest',
        ctx: makeGameContext(true), // isLeader true, but a guest is a follower
        localPlayerId: 1,
        seed: 1,
        characterIdx: CHARACTER_IDX.slice(),
        transport: createNullTransport(),
      }),
    ).toThrow(/ctx\.isLeader/)
  })
})

describe('solo drives the AuthorityLoop with the player\'s own intent (Q15, R42)', () => {
  it('a full-left run and a full-right run end in different places', () => {
    // 180 frozen countdown ticks, then 120 live ticks.
    const TICKS = COUNTDOWN_TICKS + 120
    const left = driveSolo(-1, 1, TICKS)
    const right = driveSolo(1, 1, TICKS)
    const neutral = driveSolo(0, 0, TICKS)

    // Vacuity guard: the sim really ran. Without this, three identical zeroes
    // would satisfy nothing and prove nothing.
    const startX = createState(makeGameContext(true), 0x5EED, CHARACTER_IDX.slice()).karts[0]
      .position.x
    expect(Math.abs(neutral.x - startX) + Math.abs(neutral.z)).toBeGreaterThan(0)

    const sep = (a: { x: number; z: number }, b: { x: number; z: number }): number =>
      Math.hypot(a.x - b.x, a.z - b.z)

    // THE assertion. If submitLocalInput is not wired, all three runs are the
    // same bot-driven kart on the same seed and every separation below is 0.
    expect(sep(left, right)).toBeGreaterThan(1)
    expect(sep(left, neutral)).toBeGreaterThan(1)
    expect(sep(right, neutral)).toBeGreaterThan(1)
  })

  it('createSoloTransport is a real transport with nobody on the other end', () => {
    const t = createSoloTransport()
    expect(t.peers()).toEqual([])
    expect(typeof t.submitLocalInput).toBe('function')
    // AuthorityLoop.tick() broadcasts unconditionally (§2.4 fact 3); a solo
    // transport must drop rather than queue or throw.
    expect(() => t.broadcast('unreliable', new Uint8Array(4))).not.toThrow()
    t.close()
    t.close() // idempotent
  })
})

describe('prevState — Q9\'s second SimState', () => {
  it('is a distinct object, allocated once, holding the PRE-tick state', () => {
    const s = makeSolo()
    expect(s.prevState()).not.toBe(s.state())
    expect(statesEqual(s.prevState(), s.state())).toBe(true)

    const identity: SimState[] = [s.prevState()]
    const it = intent(0.5, 1)
    for (let t = 0; t < 5; t++) {
      s.tickOnce(it)
      identity.push(s.prevState())
      // The clone happens BEFORE the loop ticks: prev trails state by exactly
      // one tick. A session that cloned afterwards would report 0 here, and
      // Q9's alpha-lerp would silently become a no-op.
      expect(s.state().tick - s.prevState().tick).toBe(1)
    }
    for (const p of identity) expect(p).toBe(identity[0])
    s.close()
  })
})

describe('the two RaceViews the audio delta needs', () => {
  it('are two distinct objects, sized from the track, and swap in place', () => {
    const s = makeSolo()
    const boxes = s.ctx.track.itemBoxes.length
    const a = s.currentView()
    const b = s.prevView()

    expect(a).not.toBe(b)
    expect(a.itemBoxes.length).toBe(boxes)
    expect(b.itemBoxes.length).toBe(boxes)
    expect(a.karts.length).toBe(MAX_KARTS)
    expect(a.entities.length).toBe(MAX_ENTITIES)

    s.swapViews()
    expect(s.currentView()).toBe(b)
    expect(s.prevView()).toBe(a)
    s.swapViews()
    expect(s.currentView()).toBe(a)
    expect(s.prevView()).toBe(b)

    // Exactly two buffers exist, forever: nothing allocates per frame.
    const seen = new Set<unknown>()
    for (let i = 0; i < 8; i++) {
      seen.add(s.currentView())
      seen.add(s.prevView())
      s.swapViews()
    }
    expect(seen.size).toBe(2)
    s.close()
  })
})

describe('guest-only surfaces', () => {
  it('samples remote seats from the interpolator and never the local one', () => {
    const pair = makeSessionPair()
    const it = intent(0.2, 1)
    for (let t = 1; t <= 260; t++) {
      pair.host.tickOnce(it)
      pair.guest.tickOnce(it)
      pair.pump(renderNowMs(t, 0))
    }
    const now = renderNowMs(pair.guest.state().tick, 0)

    // P2-R29: caller-owned buffers, made ONCE — here, not inside any loop.
    const sample = makeRemoteSample()
    const entitySample = makeRemoteEntitySample()

    expect(pair.guest.sampleRemoteKart(1, now, sample)).toBe(false) // seat 1 IS the guest
    expect(pair.guest.sampleRemoteKart(0, now, sample)).toBe(true)
    expect(sample.kart.playerId).toBe(0)

    // A refused sample leaves the buffer ALONE — it still holds seat 0, which is
    // the whole hazard of the out-parameter form and the reason this asserts the
    // stale contents rather than ignoring them.
    expect(pair.guest.sampleRemoteKart(1, now, sample)).toBe(false)
    expect(sample.kart.playerId).toBe(0)

    // Host and solo have no interpolator at all.
    expect(pair.host.sampleRemoteKart(1, now, sample)).toBe(false)
    expect(pair.host.sampleRemoteEntity(1, now, entitySample)).toBe(false)
    expect(pair.host.remoteEntityIds(new Int32Array(MAX_ENTITIES))).toBe(0)
    expect(pair.host.corrections()).toBe(0)

    pair.host.close()
    pair.guest.close()
  })

  it('correctionDelta is null on host and solo, and zeroes outPos', () => {
    const s = makeSolo()
    const out = { x: 9, y: 9, z: 9 }
    s.tickOnce(intent(0, 1))
    expect(s.correctionDelta(out)).toBeNull()
    expect(out).toEqual({ x: 0, y: 0, z: 0 })
    s.close()
  })

  it('reports a correction on exactly the ticks ClientLoop counted one', () => {
    const pair = makeSessionPair()
    const out = { x: 0, y: 0, z: 0 }
    const it = { tick: 0, steer: 0, accel: 1, brake: false, drift: false, useItem: false }
    let seenNonNull = 0
    let mismatches = 0

    for (let t = 1; t <= 600; t++) {
      // A CHANGING intent is what produces corrections; a held-steady one
      // produces about one per 600 ticks (§4.9a).
      it.steer = Math.sin(t / 12)
      const before = pair.guest.corrections()
      pair.host.tickOnce({ tick: 0, steer: 0.1, accel: 1, brake: false, drift: false, useItem: false })
      pair.guest.tickOnce(it)
      pair.pump(renderNowMs(t, 0))
      const corrected = pair.guest.corrections() > before
      const delta = pair.guest.correctionDelta(out)
      if (delta !== null) seenNonNull++
      if (corrected !== (delta !== null)) mismatches++
    }

    // Vacuity guard first: a run with zero corrections would let a
    // never-reports-anything implementation pass the agreement check below.
    expect(pair.guest.corrections()).toBeGreaterThan(0)
    expect(seenNonNull).toBeGreaterThan(0)
    expect(mismatches).toBe(0)

    pair.host.close()
    pair.guest.close()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/game/test/session.test.ts`

Expected: FAIL at collection with
`Error: Failed to load url ../src/localinput (resolved id: .../packages/game/src/localinput) ... Does the file exist?`
— `packages/game/src/localinput.ts` and `packages/game/src/session.ts` do not exist yet, so nothing in the file runs.

- [ ] **Step 3a: Write `packages/game/src/localinput.ts`**

```ts
// PURE — one composition, no DOM, no clock, no state of its own.
//
// `withLocalInput`, `createNullTransport`, `LocalInputTransport` and
// `LOCAL_PEER_ID` are @tapkart/net exports (§2.5, R42): a transport decorator is
// a transport, and `net` owns transports. This module composes them and defines
// nothing.
import { createNullTransport, withLocalInput } from '@tapkart/net'
import type { LocalInputTransport } from '@tapkart/net'

/**
 * Q15's "LoopbackTransport with zero peers, zero latency, zero loss", composed
 * from net's two pieces: a transport with nobody on the other end, wrapped so
 * the solo player's own intent still reaches the AuthorityLoop through the real
 * `encodeInput` codec. One object, one code path, and the same AuthorityLoop the
 * host runs — including the identical 8-bit steer / 6-bit accel quantisation
 * every guest's input crosses, so a solo player drives the same car a networked
 * one does.
 *
 * `AuthorityLoop.tick()` broadcasts unconditionally without consulting `peers()`
 * (§2.4 fact 3), so the inner transport must DROP rather than queue.
 * `createNullTransport` does exactly that.
 */
export function createSoloTransport(): LocalInputTransport {
  return withLocalInput(createNullTransport())
}
```

- [ ] **Step 3b: Write `packages/game/src/session.ts`**

```ts
// PURE — the composition root for one race. No DOM, no wall clock, no `three`.
// SOLE CONSTRUCTOR of a net loop in the entire game package (§5.10).
import type { Intent, SimContext, SimState, Vec3 } from '@tapkart/sim'
import { COUNTDOWN_TICKS, MAX_KARTS, allocStateLike, cloneState, createState } from '@tapkart/sim'
import type {
  LocalInputTransport,
  RemoteEntitySample,
  RemoteInterpolator,
  RemoteSample,
  Transport,
} from '@tapkart/net'
import { AuthorityLoop, ClientLoop, correctionDeltaOf, remoteInterpolatorOf } from '@tapkart/net'
import type { RaceView, ViewRole } from '@tapkart/render'
import { createRaceView } from '@tapkart/render'

export interface SessionOptions {
  role: ViewRole
  /** ctx.isLeader MUST equal (role !== 'guest'). */
  ctx: SimContext
  /** 0..MAX_KARTS-1; -1 is not allowed. */
  localPlayerId: number
  seed: number
  /** Length MAX_KARTS. Copied, not retained. */
  characterIdx: number[]
  /** NEVER null (Q15). Host and solo must pass a LocalInputTransport. */
  transport: Transport
}

export interface RaceSession {
  readonly role: ViewRole
  readonly localPlayerId: number
  readonly ctx: SimContext
  /** The characterIdx of every seat. THE source for KartView.characterIdx in
   *  every role, because WireKart does not carry it (§2.3). Length MAX_KARTS. */
  readonly characterIdx: readonly number[]
  /** The tick the race clock counts from. COUNTDOWN_TICKS in every role, because
   *  R44 puts `phase` on the wire and every role now starts in 'countdown'. */
  readonly raceStartTick: number

  /** Advance exactly one 60 Hz sim tick with the local player's intent.
   *  Copies the pre-tick state into the prev buffer FIRST, then ticks. */
  tickOnce(localIntent: Intent): void

  /** The state this session is entitled to read. Host/solo: the authoritative
   *  state. Guest: the predicted state, whose remote seats §7.1 forbids drawing.
   *  Live, never a copy — callers must not mutate it. */
  state(): SimState

  /** The state as of the previous tick, for Q9's sub-tick lerp. Allocated ONCE,
   *  at construction. Equal to `state()` before the first tickOnce. */
  prevState(): SimState

  /** Guest only: the interpolated pose plus the authoritative WireKart for a
   *  remote seat, ~100 ms in the past, written into the CALLER-OWNED `out`
   *  (P2-R29). false — and `out` untouched, still holding whatever the caller
   *  last put in it — on host/solo and for the local seat. */
  sampleRemoteKart(playerId: number, nowMs: number, out: RemoteSample): boolean

  /** Guest only (Q4). false, `out` untouched, on host/solo and for an entity
   *  absent from the newest keyframe (it despawned). */
  sampleRemoteEntity(entityId: number, nowMs: number, out: RemoteEntitySample): boolean

  /** Guest only (Q4, R43): the live entity ids in the newest keyframe, written
   *  into `out` (length MAX_ENTITIES), returning the count. 0 on host/solo. */
  remoteEntityIds(out: Int32Array): number

  /** Reconciliation corrections so far; 0 on host/solo. */
  corrections(): number

  /** R41/R47/R48. Writes the position delta the last reconciliation applied to
   *  the local kart into `outPos` and returns its heading delta in radians;
   *  returns `null` — writing (0,0,0) — when the most recent tick applied no
   *  correction. Always `null` on host and solo, which never reconcile.
   *
   *  It DELEGATES to `correctionDeltaOf` and computes nothing: ClientLoop knows
   *  the true vector and angle at the instant it applies them, and any
   *  reconstruction from before/after states assumes constant velocity across the
   *  tick — degrading exactly when the kart is accelerating hardest, which is
   *  when a correction is most likely and most visible.
   *
   *  `null` and `0` are different answers and both are meaningful: a
   *  reconciliation that moved the heading by exactly zero still restarts the
   *  ease window. Valid until the next tickOnce. */
  correctionDelta(outPos: Vec3): number | null

  /** The RaceView THIS frame is built into (§5.11's `out`).
   *
   *  There are two, because `buildAudioModel(prev, view, out)` (§4.9) derives
   *  every one-shot cue from the delta between consecutive views, and
   *  `ViewBuilder.build` is the sole writer of every RaceView field. With one
   *  view, `prev` IS `view`, every delta is empty, and no cue can ever fire in
   *  the shipped game. The session owns both because it owns the race's lifetime
   *  and knows `ctx.track.itemBoxes.length`. */
  currentView(): RaceView

  /** The RaceView the PREVIOUS frame was built into — buildAudioModel's `prev`. */
  prevView(): RaceView

  /** Exchanges the two views. The shell calls this ONCE per frame, AFTER
   *  `audio.apply` — cues are consumed in the frame they are raised, so swapping
   *  any earlier drops them. Both views are primed by `createViewBuilder`
   *  (§5.11) before the first frame, so frame 1's delta is empty rather than "a
   *  real view minus a zeroed one", which would fire a burst of spurious cues on
   *  the grid. */
  swapViews(): void

  close(): void
}

const ZERO_DELTA_HEADING = null

function hasLocalInput(t: Transport): t is LocalInputTransport {
  return typeof (t as Partial<LocalInputTransport>).submitLocalInput === 'function'
}

class Session implements RaceSession {
  readonly role: ViewRole
  readonly localPlayerId: number
  readonly ctx: SimContext
  readonly characterIdx: readonly number[]
  readonly raceStartTick: number = COUNTDOWN_TICKS

  private readonly transport: Transport
  private readonly authority: AuthorityLoop | null
  private readonly localTransport: LocalInputTransport | null
  private readonly client: ClientLoop | null
  private readonly interp: RemoteInterpolator | null

  private readonly live: SimState
  private readonly prev: SimState

  private viewA: RaceView
  private viewB: RaceView

  constructor(opts: SessionOptions) {
    this.role = opts.role
    this.localPlayerId = opts.localPlayerId
    this.ctx = opts.ctx
    this.characterIdx = opts.characterIdx.slice()
    this.transport = opts.transport

    if (opts.role === 'guest') {
      const client = new ClientLoop(opts.ctx, opts.localPlayerId, opts.transport)
      this.client = client
      this.interp = remoteInterpolatorOf(client)
      this.authority = null
      this.localTransport = null
      // ClientLoop builds its own predicted state with seed 0 and an all-zero
      // characterIdx (§2.4 fact 4), which is why `this.characterIdx` — not
      // `state()` — is the source for that field.
      this.live = client.state()
    } else {
      // Host and solo are IDENTICAL: R44 puts `phase` on the wire, so a host
      // counts down and every guest sees it. There is no longer a reason for the
      // two to differ.
      const state = createState(opts.ctx, opts.seed, opts.characterIdx.slice())
      state.karts[opts.localPlayerId].isBot = false
      state.karts[opts.localPlayerId].connected = true
      this.live = state
      this.authority = new AuthorityLoop(opts.ctx, state, opts.transport)
      this.localTransport = opts.transport as LocalInputTransport
      this.client = null
      this.interp = null
    }

    this.prev = allocStateLike(opts.ctx, this.live)
    cloneState(this.live, this.prev)

    const boxes = opts.ctx.track.itemBoxes.length
    this.viewA = createRaceView(boxes)
    this.viewB = createRaceView(boxes)
  }

  tickOnce(localIntent: Intent): void {
    cloneState(this.live, this.prev)
    // Stamp the tick here, once, rather than trusting every caller to. Two
    // separate consumers read this field: AuthorityLoop keeps an intent only
    // when `it.tick > heldIntentTick[playerId]`, and `withLocalInput` reads it
    // to decide which ticks go on the 30 Hz wire. A caller that leaves it at 0
    // therefore does not fail loudly — it silently delivers one input and then
    // nothing, which looks exactly like a kart that will not steer.
    localIntent.tick = this.live.tick + 1
    const client = this.client
    if (client !== null) {
      client.tick(localIntent)
      return
    }
    const authority = this.authority
    const local = this.localTransport
    if (authority === null || local === null) {
      throw new Error('RaceSession: no loop for this role')
    }
    // AuthorityLoop has no other input path (§2.4 fact 1, §5.10a). Called on
    // EVERY sim tick, with no cadence of our own: `withLocalInput` applies the
    // 30 Hz wire cadence internally and drops the odd ticks, which is precisely
    // what makes the solo player's input path the same shape as a guest's.
    local.submitLocalInput(this.localPlayerId, localIntent)
    authority.tick()
  }

  state(): SimState {
    return this.live
  }

  prevState(): SimState {
    return this.prev
  }

  // P2-R29: one-line delegations, and they stay one-line delegations. The
  // session allocates NO sample buffer of its own — the buffer belongs to the
  // ViewBuilder that calls this, which is the only caller in the repository
  // (§6.3). A wrapper that returned `RemoteSample | null` would have to allocate
  // one per call to produce it, which is exactly the per-frame allocation the
  // ruling removed.
  sampleRemoteKart(playerId: number, nowMs: number, out: RemoteSample): boolean {
    const interp = this.interp
    if (interp === null || playerId === this.localPlayerId) return false
    return interp.sampleKart(playerId, nowMs, out)
  }

  sampleRemoteEntity(entityId: number, nowMs: number, out: RemoteEntitySample): boolean {
    const interp = this.interp
    if (interp === null) return false
    return interp.sampleEntity(entityId, nowMs, out)
  }

  remoteEntityIds(out: Int32Array): number {
    const interp = this.interp
    if (interp === null) return 0
    return interp.liveEntityIds(out)
  }

  corrections(): number {
    const client = this.client
    return client === null ? 0 : client.corrections()
  }

  correctionDelta(outPos: Vec3): number | null {
    const client = this.client
    if (client === null) {
      outPos.x = 0
      outPos.y = 0
      outPos.z = 0
      return ZERO_DELTA_HEADING
    }
    return correctionDeltaOf(client, outPos)
  }

  currentView(): RaceView {
    return this.viewA
  }

  prevView(): RaceView {
    return this.viewB
  }

  swapViews(): void {
    const t = this.viewA
    this.viewA = this.viewB
    this.viewB = t
  }

  close(): void {
    this.transport.close()
  }
}

/**
 * Wires AuthorityLoop (host/solo) or ClientLoop (guest) over the given
 * Transport. SOLE CONSTRUCTOR of a net loop in the entire game package.
 *
 * Every precondition is checked here and throws, because each one fails
 * silently at runtime otherwise: a plain Transport on a host means the host's
 * kart is driven by bot AI forever (§2.4 fact 1), a wrong `isLeader` means item
 * rolls and event emission stop or double, and a negative localPlayerId indexes
 * nothing.
 */
export function createSession(opts: SessionOptions): RaceSession {
  if (opts.characterIdx.length !== MAX_KARTS) {
    throw new Error(
      `createSession: characterIdx must have length ${MAX_KARTS}, got ${opts.characterIdx.length}`,
    )
  }
  if (!(opts.localPlayerId >= 0 && opts.localPlayerId < MAX_KARTS)) {
    throw new Error(
      `createSession: localPlayerId ${opts.localPlayerId} is outside [0, ${MAX_KARTS})`,
    )
  }
  const wantLeader = opts.role !== 'guest'
  if (opts.ctx.isLeader !== wantLeader) {
    throw new Error(
      `createSession: ctx.isLeader must be ${wantLeader} for role '${opts.role}', got ${opts.ctx.isLeader}`,
    )
  }
  if (wantLeader && !hasLocalInput(opts.transport)) {
    throw new Error(
      `createSession: role '${opts.role}' requires a LocalInputTransport — wrap the transport with withLocalInput() from @tapkart/net, or use createSoloTransport()`,
    )
  }
  return new Session(opts)
}
```

- [ ] **Step 3c: Append the three fixtures to `packages/game/test/fixtures/game-fixtures.ts`**

Append exactly this — do **not** rewrite the file. The imports go at the top with
the existing ones; the functions go at the bottom, after
`makeControlInputsFixture`, `makeSettingsFixture` and `makeLobbySlots`.

`makeGameContext` first, if it is not already present. It is §9.1's, no earlier
task owns it, and both fixtures below need it:

```ts
import type { SimContext } from '@tapkart/sim'
// §2.6: test fixtures are reached by RELATIVE path, test-to-test only. `src`
// never does this, and @tapkart/sim's exports are not widened to publish them.
import { makeContext, makeOvalTrack } from '../../../sim/test/fixtures/track-fixtures'

/** The context every game-side test races on: sim's own oval fixture, whose
 *  tuning and characters are the ones Q1 requires the shipped content to equal
 *  field for field. A guest's context must be built with isLeader false — only a
 *  leader authority rolls items and advances rngCursor. */
export function makeGameContext(isLeader = true): SimContext {
  return makeContext(makeOvalTrack(), isLeader)
}
```

Then the two session fixtures:

```ts
import type { LoopbackOptions } from '@tapkart/net'
import { makeLoopbackPair, withLocalInput } from '@tapkart/net'
import type { RaceSession } from '../../src/session'
import { createSession } from '../../src/session'
import { renderNowMs } from '../../src/clock'

/** Plan 2's conditions, which are spec §8's. */
const DEFAULT_LOOPBACK: LoopbackOptions = {
  latencyMs: 150,
  jitterMs: 50,
  lossRate: 0.05,
  seed: 0xc0ffee,
}

const PAIR_CHARACTER_IDX = [0, 1, 2, 3, 4, 5, 6, 7]

/**
 * Host + guest over ONE shared loopback pair. The host's side is wrapped with
 * `withLocalInput` (§5.10a); the guest's ClientLoop needs no wrapper, since
 * `tick(localIntent)` already takes one.
 *
 * The guest's seat is flipped to `isBot: false, connected: true` on the HOST's
 * state. Without that flip, `resolveInputs` drives the guest's seat with bot AI
 * on the authority (§2.4 fact 2) and every test built on this pair measures
 * nothing: the guest would be predicting a seat the host never lets it steer.
 */
export function makeSessionPair(opts: Partial<LoopbackOptions> = {}): {
  host: RaceSession
  guest: RaceSession
  pump(nowMs: number): void
} {
  const pair = makeLoopbackPair({ ...DEFAULT_LOOPBACK, ...opts })
  const host = createSession({
    role: 'host',
    ctx: makeGameContext(true),
    localPlayerId: 0,
    seed: 0x7A1E,
    characterIdx: PAIR_CHARACTER_IDX.slice(),
    transport: withLocalInput(pair.a),
  })
  const guest = createSession({
    role: 'guest',
    ctx: makeGameContext(false),
    localPlayerId: 1,
    seed: 0x7A1E,
    characterIdx: PAIR_CHARACTER_IDX.slice(),
    transport: pair.b,
  })
  host.state().karts[1].isBot = false
  host.state().karts[1].connected = true
  return { host, guest, pump: pair.pump }
}

/**
 * A guest session whose ClientLoop has taken N corrections, for R41's smoothing
 * tests. It drives a CHANGING (sine) intent, which is what actually produces
 * corrections: a held-steady intent produces about one per 600 ticks, and a
 * changing one about three per second (§4.9a). A fixture that held the intent
 * steady would hand every smoothing test a run with nothing to smooth.
 */
export function makeCorrectingGuest(ticks = 600): {
  host: RaceSession
  guest: RaceSession
  pump(nowMs: number): void
  corrections(): number
} {
  const pair = makeSessionPair()
  const hostIntent = { tick: 0, steer: 0.1, accel: 1, brake: false, drift: false, useItem: false }
  const guestIntent = { tick: 0, steer: 0, accel: 1, brake: false, drift: false, useItem: false }
  for (let t = 1; t <= ticks; t++) {
    guestIntent.steer = Math.sin(t / 12)
    pair.host.tickOnce(hostIntent)
    pair.guest.tickOnce(guestIntent)
    pair.pump(renderNowMs(t, 0))
  }
  return { ...pair, corrections: () => pair.guest.corrections() }
}
```

If the file does not exist at all, create it with the three blocks above and
leave `makeControlInputsFixture`, `makeSettingsFixture` and `makeLobbySlots` to
the tasks that own them (17, 18, 19).

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/game/test/session.test.ts`
Expected: 12 passing.

Then typecheck: `npx tsc --noEmit -p packages/game/tsconfig.json` — expected: no output.

**What each test catches, and whether it would actually fail under that bug:**

| Test | Bug | Fails? |
|---|---|---|
| starts in countdown | a host started at `'racing'` (the pre-R44 workaround) | yes — `phase` is a plain string comparison |
| flips the local seat | forgetting §2.4 fact 2 — the local kart is bot-driven on the authority | yes |
| carries characterIdx | reading `characterIdx` off `state()` on a guest | yes — the two sources are provably different (2 vs 0) *before* the assertion |
| copies characterIdx | retaining the caller's array | yes |
| rejects a plain Transport | a host silently bot-driven forever | yes |
| left/right/neutral separation | `submitLocalInput` not called, or called with a non-increasing `intent.tick`, or a `null` transport path | yes — under the bug all three runs are the same bot-driven kart and every separation is exactly 0. `resetBotHold()` and sequential (never interleaved) runs are what make that exact |
| prevState trails by one | cloning after the tick instead of before, or allocating per frame | yes — the delta would be 0, and Q9's lerp would be a silent no-op |
| two views, swap in place | one view (the contract defect), or allocating a view per frame | yes — `not.toBe` and the two-identity set |
| remote sampling | sampling the local seat from the interpolator, or building an interpolator on a host | yes |
| correctionDelta null on host | reconstructing a delta from before/after states, which on a host is nonzero garbage every tick | yes |
| correction agreement | always-null (smoothing never fires, R41's defect invisible) or always-non-null (the ease window re-seeds every tick and never decays) | yes, and the `corrections() > 0` guard first means the run cannot pass vacuously |

- [ ] **Step 5: Commit**

```bash
git add packages/game/src/session.ts packages/game/src/localinput.ts \
        packages/game/test/session.test.ts packages/game/test/fixtures/game-fixtures.ts && \
git commit -m "feat(game): race session composition root, solo transport and the double view buffer"
```

---

### Task 23: `packages/game/src/view.ts` — the one place prediction and interpolation are chosen between

**Files:**
- Create: `packages/game/src/view.ts`
- Create: `packages/game/src/vite-env.d.ts` — one line; this task creates it because `view.ts` is the first module in the repository to name `import.meta.env.DEV`, and without it `tsc --noEmit` fails with *"Property 'env' does not exist on type 'ImportMeta'"*. Task 24 verifies it exists rather than creating it.
- Test: `packages/game/test/view.test.ts`
- Test: `packages/game/test/frameloop.test.ts`

**Interfaces:**

- Consumes, from `./session` (Task 22 — the whole interface, verbatim):
  ```ts
  export interface RaceSession {
    readonly role: ViewRole
    readonly localPlayerId: number
    readonly ctx: SimContext
    readonly characterIdx: readonly number[]
    readonly raceStartTick: number
    tickOnce(localIntent: Intent): void
    state(): SimState
    prevState(): SimState
    sampleRemoteKart(playerId: number, nowMs: number, out: RemoteSample): boolean
    sampleRemoteEntity(entityId: number, nowMs: number, out: RemoteEntitySample): boolean
    remoteEntityIds(out: Int32Array): number
    corrections(): number
    correctionDelta(outPos: Vec3): number | null
    currentView(): RaceView
    prevView(): RaceView
    swapViews(): void
    close(): void
  }
  export function createSession(opts: SessionOptions): RaceSession
  ```
- Consumes, from `./clock` (Task 17):
  ```ts
  export function renderNowMs(tick: number, alpha: number): number   // (tick + alpha) * TICK_MS
  ```
- Consumes, from `@tapkart/render` (§4.2, §4.9a):
  ```ts
  export type ViewRole = 'host' | 'guest' | 'solo'
  export type ViewSource = 'authoritative' | 'predicted' | 'interpolated' | 'absent'
  export interface KartView { playerId: number; characterIdx: number; source: ViewSource
    position: Vec3; heading: number; velocity: Vec3; angularVelocity: number; speed: number
    s: number; bankAngle: number; driftActive: boolean; driftDir: -1 | 0 | 1
    driftCharge: number; driftTier: number; airborne: boolean; surface: Surface
    spinOutTicks: number; invulnTicks: number; boostTicks: number; respawnTicks: number
    shielded: boolean; item: ItemKind; lap: number; checkpointIdx: number; t: number
    place: number; isBot: boolean; connected: boolean }
  export interface EntityView { entityId: number; kind: EntityKind; ownerId: number
    source: ViewSource; position: Vec3; velocity: Vec3; heading: number; ttl: number }
  export interface ItemBoxView { boxIdx: number; position: Vec3; respawnTicks: number }
  export interface RaceView { tick: number; alpha: number; phase: RacePhase
    localPlayerId: number; raceStartTick: number; karts: KartView[]; entities: EntityView[]
    entityCount: number; itemBoxes: ItemBoxView[]; itemBoxRespawnTicks: number
    finishedOrder: number[]; finishTick: number; countdownTicksLeft: number }
  export function createRaceView(itemBoxCount: number): RaceView
  export function viewSourceViolations(view: RaceView, role: ViewRole): string[]
  export interface VisualOffset { origin: Vec3; originHeading: number; ticksSince: number
    current: Vec3; currentHeading: number }
  export function createVisualOffset(): VisualOffset
  export function advanceVisualOffset(prev: VisualOffset, correctionPos: Vec3,
                                      correctionHeading: number | null,
                                      ticksElapsed: number, out: VisualOffset): void
  export const ERROR_SMOOTH_WINDOW_TICKS = 12     // frameloop.test.ts only
  ```
- Consumes, from `@tapkart/sim` (§2.1, §2.2):
  ```ts
  export const MAX_KARTS = 8
  export const MAX_ENTITIES = 32
  export const COUNTDOWN_TICKS = 180
  export function allocStateLike(ctx: SimContext, src: SimState): SimState
  export function computePlacement(state: SimState, outIndexOf: Int32Array, outOrder: Int32Array): void
  export function driftTierFor(charge: number, tiers: [number, number, number]): number   // -1 = none
  export function itemBoxWorldPos(ctx: SimContext, boxIdx: number, out: Vec3): void       // writes out, returns void
  export function wrapAngle(a: number): number                                            // (-π, π]
  export function spawnEntity(state: SimState, kind: EntityKind, ownerId: number, position: Vec3,
                              heading: number, targetId: number, ttl: number,
                              events: AuthEvent[]): number    // packages/sim/src/entity.ts:45
  ```
- Consumes, from `@tapkart/protocol` (§2.3): `WireKart`, `WireEntity` — used only by the test's fake session.
- Consumes, from `@tapkart/net` (§2.5, ruling **P2-R29** — *added 2026-08-14*):
  ```ts
  export interface RemoteSample { position: Vec3; heading: number; kart: WireKart }
  export interface RemoteEntitySample { position: Vec3; heading: number; entity: WireEntity }
  export function makeRemoteSample(): RemoteSample
  export function makeRemoteEntitySample(): RemoteEntitySample
  ```
  This task is the **only** consumer of the two factories in Plan 3, and the only
  caller of the samplers anywhere (§6.3). They fill a caller-owned buffer and
  return a boolean; the two buffers are fields of `ViewBuilderImpl`, made once in
  its constructor. Without these two exports there is no legal way to build a
  buffer — `RemoteSample.kart` is a non-optional `WireKart` — so this is a gate
  item and Task 1 checks it.
- Consumes, from `./fixtures/game-fixtures` (Task 22 / §9.1): `makeGameContext`,
  `makeSessionPair`, and **`makeCorrectingGuest`** — §9.1's fixture for R41, whose
  only consumer in the plan is this task's end-to-end smoothing test. It exists
  because a held-steady intent produces about one correction per 600 ticks, so a
  smoothing test driven by one would have nothing to smooth.
- Consumes, from `@tapkart/sim`, in the tests only: `TICK_DT`, `cloneState`,
  `createState`, `resetBotHold`, `RACE_LAPS`.

- Produces:
  ```ts
  // packages/game/src/view.ts
  export interface ViewBuilder {
    /** Fills `out` from the session captured at construction, obeying §7.1 seat
     *  by seat. SOLE WRITER of every RaceView field. Allocates nothing. */
    build(alpha: number, out: RaceView): void
  }
  /** Allocates the builder's scratch ONCE, and PRIMES both of the session's
   *  views before returning. */
  export function createViewBuilder(session: RaceSession): ViewBuilder
  ```
  Task 24 (`shell.ts`) calls `createViewBuilder(session)` once per race and
  `build(alpha, session.currentView())` once per frame.

**The seat-source rule — this task's whole reason to exist**

Contract §7.1, from spec §5: **the renderer reads the LOCAL seat from
`ClientLoop.state()` and EVERY OTHER seat from the `RemoteInterpolator`, and
never both.**

This exists because of a real functional gap: `ClientLoop` never applies the
snapshot to non-local seats, so the other seven karts in `state()` are the local
sim's own **bot AI** (`packages/net/src/client.ts:150-153`). Every remote lap
counter, standings row and held-item icon a guest saw would have been fiction.
`RemoteSample.kart: WireKart` is the fix — the newest authoritative record,
verbatim off the wire — so interpolated `position`/`heading` come from the
interpolation and **every discrete field** comes from `sample.kart`.

Resolved per role, per seat:

| Role | Local seat | Remote seats | Entities | Item boxes |
|---|---|---|---|---|
| `solo` | `state()` → `'authoritative'` | `state()` → `'authoritative'` | `state()` → `'authoritative'` | `state()`, unpoliced |
| `host` | `state()` → `'authoritative'` | `state()` → `'authoritative'` | `state()` → `'authoritative'` | `state()`, unpoliced |
| `guest` | `state()` → `'predicted'` | `sampleRemoteKart(…, out)` true → `'interpolated'`; **false** → `'absent'` | `sampleRemoteEntity(…, out)` true → `'interpolated'`; a **false** id simply not listed | `state()`, unpoliced |

*Amended 2026-08-14 (ruling P2-R29): the guest row read `null → 'absent'`. Both
samplers take a caller-owned `out` and return a boolean now, so the trigger is a
`false`. The rule is unchanged; its failure mode is quieter. A `null` could not
be read by accident — a stale buffer can, and reading it after `false` puts
**another seat's** authoritative `WireKart` on this seat with `source:
'interpolated'`, which `viewSourceViolations` cannot catch because every label
involved is legal. Steps below say `false` means ignore the buffer, never "reuse
what is in it".*

Two related details. **Item boxes are `'predicted'` on purpose** (R45): putting
box state on the wire costs ~8 bits × 16 boxes = 128 bits against a 180-bit
snapshot, at 20 Hz, to correct a purely cosmetic ghost, and every real pickup is
already corrected by the reliable `itemGrant` stream. `ItemBoxView` has no
`source` field and `viewSourceViolations` deliberately says nothing about boxes —
there is no rule to state, so none is faked. And **Q9's alpha-lerp applies to
every `state()`-sourced seat and entity, not only the local one**: on a host the
other seven seats come from the same `state()` and would otherwise judder alone
at 60 Hz on a 120 Hz display (§15.3).

`viewSourceViolations` is the instrument, and it runs **under
`import.meta.env.DEV` in dev builds as well as in CI tests** (Q32): a test proves
the invariant for the cases someone thought of, a dev assertion proves it for the
ones nobody did. Vitest sets `DEV` true, so both the tests and the assertion are
live in this task's suite.

---

- [ ] **Step 1: Write the failing tests**

Create `packages/game/test/view.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { AuthEvent, Intent, SimState, Vec3 } from '@tapkart/sim'
import {
  COUNTDOWN_TICKS,
  MAX_ENTITIES,
  MAX_KARTS,
  allocStateLike,
  cloneState,
  createState,
  resetBotHold,
  spawnEntity,
  wrapAngle,
} from '@tapkart/sim'
import type { WireEntity, WireKart } from '@tapkart/protocol'
import { makeRemoteSample } from '@tapkart/net'
import { createRaceView, viewSourceViolations } from '@tapkart/render'
import { renderNowMs } from '../src/clock'
import { createSoloTransport } from '../src/localinput'
import type { RaceSession } from '../src/session'
import { createSession } from '../src/session'
import { createViewBuilder } from '../src/view'
import { makeGameContext, makeSessionPair } from './fixtures/game-fixtures'

const CHARACTER_IDX = [3, 5, 1, 7, 2, 6, 0, 4]

function intent(steer: number, accel: number): Intent {
  return { tick: 0, steer, accel, brake: false, drift: false, useItem: false }
}

function makeSolo(localPlayerId = 0): RaceSession {
  resetBotHold()
  return createSession({
    role: 'solo',
    ctx: makeGameContext(true),
    localPlayerId,
    seed: 0x5eed,
    characterIdx: CHARACTER_IDX.slice(),
    transport: createSoloTransport(),
  })
}

// ---------------------------------------------------------------------------
// A hand-built RaceSession. `ViewBuilder` consumes the interface, so a fake is
// the only way to put the two sources into a state a real race cannot reach —
// which is exactly what the placement and dev-assertion cases below need.
// ---------------------------------------------------------------------------
interface FakeOpts {
  localPlayerId: number
  wireKart?: (playerId: number) => WireKart | null
  entityIds?: readonly number[]
  wireEntity?: (entityId: number) => WireEntity | null
}

function makeWireKart(playerId: number, lap: number, t: number): WireKart {
  return {
    playerId,
    position: { x: playerId * 10, y: 0, z: 0 },
    velocity: { x: 3, y: 0, z: 0 },
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
    lap,
    checkpointIdx: 0,
    t,
    isBot: true,
    connected: true,
    boostTicks: 0,
    respawnTicks: 0,
    shielded: false,
  }
}

function makeFakeGuest(opts: FakeOpts): RaceSession {
  const ctx = makeGameContext(false)
  const state: SimState = createState(ctx, 0, [0, 0, 0, 0, 0, 0, 0, 0])
  state.phase = 'racing'
  // The bot-AI fiction ClientLoop.state() actually contains for remote seats:
  // every one of them "leading" on lap 9. Nothing built from the wire may ever
  // reproduce these numbers, which is what makes the assertions below decisive.
  for (let i = 0; i < MAX_KARTS; i++) {
    state.karts[i].lap.lap = 9
    state.karts[i].lap.checkpointIdx = 0
    state.karts[i].lap.t = 0.99
  }
  if (opts.localPlayerId >= 0) state.karts[opts.localPlayerId].lap.lap = 0
  const prev = allocStateLike(ctx, state)
  cloneState(state, prev)
  const boxes = ctx.track.itemBoxes.length
  let a = createRaceView(boxes)
  let b = createRaceView(boxes)
  return {
    role: 'guest',
    localPlayerId: opts.localPlayerId,
    ctx,
    characterIdx: CHARACTER_IDX.slice(),
    raceStartTick: COUNTDOWN_TICKS,
    tickOnce: () => undefined,
    state: () => state,
    prevState: () => prev,
    // P2-R29: the fake fills the caller's buffer and returns a boolean, exactly
    // as the real session does. A fake that still allocated a fresh sample would
    // hide the one bug the out-parameter form introduces — a caller reading the
    // buffer after `false` — because every returned object would be fresh.
    sampleRemoteKart: (playerId, _nowMs, out) => {
      if (playerId === opts.localPlayerId) return false
      const k = opts.wireKart === undefined ? null : opts.wireKart(playerId)
      if (k === null) return false
      out.position.x = k.position.x
      out.position.y = k.position.y
      out.position.z = k.position.z
      out.heading = k.heading
      out.kart = k
      return true
    },
    sampleRemoteEntity: (entityId, _nowMs, out) => {
      const e = opts.wireEntity === undefined ? null : opts.wireEntity(entityId)
      if (e === null) return false
      out.position.x = e.position.x
      out.position.y = e.position.y
      out.position.z = e.position.z
      out.heading = e.heading
      out.entity = e
      return true
    },
    remoteEntityIds: (out) => {
      const ids = opts.entityIds ?? []
      for (let i = 0; i < ids.length; i++) out[i] = ids[i]
      return ids.length
    },
    corrections: () => 0,
    correctionDelta: (outPos: Vec3) => {
      outPos.x = 0
      outPos.y = 0
      outPos.z = 0
      return null
    },
    currentView: () => a,
    prevView: () => b,
    swapViews: () => {
      const t = a
      a = b
      b = t
    },
    close: () => undefined,
  }
}

describe('the seat-source rule (§7.1) — the flagship', () => {
  it('a real guest sees no violations over 600 ticks, and really does interpolate', () => {
    const pair = makeSessionPair()
    // A slick sits still, is never despawned on contact (only seekers and bolts
    // are) and lives its full ttl, so the guest's interpolator is guaranteed a
    // remote entity to sample. Waiting for a bot to roll one would make this
    // test's precondition a matter of luck.
    const owner = pair.host.state().karts[3]
    const spawnEvents: AuthEvent[] = []
    spawnEntity(
      pair.host.state(),
      'slick',
      3,
      { x: owner.position.x + 2, y: owner.position.y, z: owner.position.z + 2 },
      0,
      -1,
      600,
      spawnEvents,
    )

    const gb = createViewBuilder(pair.guest)
    const hb = createViewBuilder(pair.host)
    const it = intent(0.3, 1)
    let sawInterpolatedSeat = 0
    let sawInterpolatedEntity = 0
    let violations = 0

    for (let t = 1; t <= 600; t++) {
      pair.host.tickOnce(it)
      pair.guest.tickOnce(it)
      pair.pump(renderNowMs(t, 0))

      const gv = pair.guest.currentView()
      gb.build(0.5, gv)
      violations += viewSourceViolations(gv, 'guest').length
      for (let i = 0; i < MAX_KARTS; i++) if (gv.karts[i].source === 'interpolated') sawInterpolatedSeat++
      for (let j = 0; j < gv.entityCount; j++) if (gv.entities[j].source === 'interpolated') sawInterpolatedEntity++
      pair.guest.swapViews()

      const hv = pair.host.currentView()
      hb.build(0.5, hv)
      violations += viewSourceViolations(hv, 'host').length
      pair.host.swapViews()
    }

    expect(violations).toBe(0)
    // Without these two, an all-'absent' view would pass the line above while
    // proving nothing at all.
    expect(sawInterpolatedSeat).toBeGreaterThan(0)
    expect(sawInterpolatedEntity).toBeGreaterThan(0)

    pair.host.close()
    pair.guest.close()
  })

  it('reads a remote seat from the wire even when the prediction says otherwise', () => {
    const pair = makeSessionPair()
    const b = createViewBuilder(pair.guest)
    const it = intent(0.2, 1)
    for (let t = 1; t <= 300; t++) {
      pair.host.tickOnce(it)
      pair.guest.tickOnce(it)
      pair.pump(renderNowMs(t, 0))
    }

    // Make the two sources PROVABLY different before asserting which was read.
    // These are the local sim's bot-AI values for seat 2 — the values §7.1
    // exists to keep off the screen.
    const fiction = pair.guest.state().karts[2]
    fiction.position.x += 500
    fiction.lap.lap = 7
    fiction.drift.charge = 999
    fiction.shielded = true
    fiction.item = 'bolt'

    const now = renderNowMs(pair.guest.state().tick, 0.5)
    // P2-R29: this test's own buffer, made once, here.
    const wire = makeRemoteSample()
    expect(pair.guest.sampleRemoteKart(2, now, wire)).toBe(true)
    expect(wire.kart.lap).not.toBe(7)
    // The ViewBuilder holds its OWN buffer; copy what this test compares against
    // before b.build() runs, because nothing promises the two are different
    // objects forever and a shared one would make every assertion below tautological.
    const wireLap = wire.kart.lap
    const wireDriftCharge = wire.kart.driftCharge
    const wireShielded = wire.kart.shielded
    const wireItem = wire.kart.item
    const wirePosX = wire.position.x

    const view = pair.guest.currentView()
    b.build(0.5, view)
    const seat = view.karts[2]

    expect(seat.source).toBe('interpolated')
    expect(seat.lap).toBe(wireLap)
    expect(seat.driftCharge).toBe(wireDriftCharge)
    expect(seat.shielded).toBe(wireShielded)
    expect(seat.item).toBe(wireItem)
    expect(seat.position.x).toBeCloseTo(wirePosX, 9)
    // The prediction is 500 m away. If the builder read state() this is ~0.
    expect(Math.abs(seat.position.x - fiction.position.x)).toBeGreaterThan(100)

    // And the LOCAL seat is still read from state(): move it and the view follows.
    const before = view.karts[1].position.x
    pair.guest.state().karts[1].position.x += 500
    b.build(0.5, view)
    expect(view.karts[1].source).toBe('predicted')
    expect(view.karts[1].position.x - before).toBeGreaterThan(100)

    pair.host.close()
    pair.guest.close()
  })

  it('passes the interpolator a tick-derived nowMs, not a wall clock (§6.3)', () => {
    const pair = makeSessionPair()
    const b = createViewBuilder(pair.guest)
    const it = intent(0.2, 1)
    for (let t = 1; t <= 300; t++) {
      pair.host.tickOnce(it)
      pair.guest.tickOnce(it)
      pair.pump(renderNowMs(t, 0))
    }

    const alpha = 0.5
    const tickNow = renderNowMs(pair.guest.state().tick, alpha)
    const wallish = 3_600_000 // an hour of uptime, which is what performance.now() looks like
    // P2-R29: ONE buffer, three samples, and the value copied out after each —
    // the same discipline §7.3 imposes on `sampleAt`. Holding all three at once
    // would need three buffers, and a test that keeps a reference instead of a
    // copy here compares one pose against itself and passes for the wrong reason.
    const buf = makeRemoteSample()
    expect(pair.guest.sampleRemoteKart(2, tickNow, buf)).toBe(true)
    const correctX = buf.position.x
    expect(pair.guest.sampleRemoteKart(2, wallish, buf)).toBe(true)
    const pinnedAX = buf.position.x
    expect(pair.guest.sampleRemoteKart(2, wallish + 60_000, buf)).toBe(true)
    const pinnedBX = buf.position.x

    // The wrong basis clamps at REMOTE_EXTRAPOLATE_CAP_MS: two instants a minute
    // apart resolve to the SAME pose. That is the §6.3 failure, made visible.
    expect(pinnedAX).toBeCloseTo(pinnedBX, 9)
    expect(Math.abs(correctX - pinnedAX)).toBeGreaterThan(0.01)

    const view = pair.guest.currentView()
    b.build(alpha, view)
    expect(view.karts[2].position.x).toBeCloseTo(correctX, 9)

    pair.host.close()
    pair.guest.close()
  })

  it('throws in a DEV build when a view violates the rule (Q32)', () => {
    // localPlayerId -1 is illegal for a guest, which is §7.1 check 1. A real
    // session cannot be built this way — createSession rejects it — so the fake
    // is what makes the dev assertion reachable at all.
    const fake = makeFakeGuest({ localPlayerId: -1 })
    const b0 = createViewBuilder(makeFakeGuest({ localPlayerId: 1 })) // prime-path sanity
    expect(b0).toBeDefined()
    expect(() => createViewBuilder(fake)).toThrow(/seat-source violations/)
  })
})

describe('Q9\'s alpha lerp', () => {
  it('applies to EVERY state-sourced seat, not only the local one (§15.3)', () => {
    const s = makeSolo(0)
    const b = createViewBuilder(s)
    const it = intent(0.4, 1)
    for (let t = 0; t < COUNTDOWN_TICKS + 40; t++) s.tickOnce(it)

    const SEAT = 5 // a bot seat, not the local one
    const p = s.prevState().karts[SEAT].position.x
    const c = s.state().karts[SEAT].position.x
    // Vacuity guard: two karts snapped to the same point would make every lerp
    // assertion below true for the wrong reason.
    expect(Math.abs(c - p)).toBeGreaterThan(1e-6)

    const view = s.currentView()
    b.build(0.25, view)
    expect(view.karts[SEAT].position.x).toBeCloseTo(p + (c - p) * 0.25, 12)
    expect(view.karts[SEAT].source).toBe('authoritative')
    s.close()
  })

  it('lerps heading the short way round', () => {
    const s = makeSolo(0)
    const b = createViewBuilder(s)
    s.tickOnce(intent(0, 0))
    s.prevState().karts[2].heading = 3.0
    s.state().karts[2].heading = -3.0

    const view = s.currentView()
    b.build(0.5, view)
    // Shortest arc: wrapAngle(-3 - 3) = +0.283…, so the halfway heading is
    // ±π, not 0. A naive (a + (b - a) * t) lerp gives 0 — a kart that spins
    // the long way round through the entire opposite bearing.
    expect(Math.abs(view.karts[2].heading)).toBeCloseTo(Math.PI, 6)
    expect(Math.abs(wrapAngle(view.karts[2].heading - 0))).toBeGreaterThan(3)
    s.close()
  })

  it('does not lerp an entity slot against a different entity', () => {
    const s = makeSolo(0)
    const b = createViewBuilder(s)
    const k = s.state().karts[0]
    spawnEntity(s.state(), 'slick', 0, { x: k.position.x, y: k.position.y, z: k.position.z }, 0, -1, 600, [])
    s.tickOnce(intent(0, 0))

    const cur = s.state().entities[0]
    const old = s.prevState().entities[0]
    // Slot reuse: the previous occupant of slot 0 was a different entity, 900 m
    // away. Lerping against it would fly a slick in from another postcode.
    old.entityId = cur.entityId + 77
    old.position.x = cur.position.x + 900

    const view = s.currentView()
    b.build(0.5, view)
    expect(view.entityCount).toBeGreaterThan(0)
    expect(view.entities[0].entityId).toBe(cur.entityId)
    expect(view.entities[0].position.x).toBeCloseTo(cur.position.x, 12)

    // With the ids matching, the same slot IS lerped.
    old.entityId = cur.entityId
    b.build(0.5, view)
    expect(view.entities[0].position.x).toBeCloseTo(cur.position.x + 450, 9)
    s.close()
  })
})

describe('derived fields', () => {
  it('takes characterIdx from the session, never from state (§2.3 fact 1)', () => {
    const pair = makeSessionPair()
    const b = createViewBuilder(pair.guest)
    const view = pair.guest.currentView()
    b.build(0, view)
    // ClientLoop's predicted state carries an all-zero characterIdx.
    expect(pair.guest.state().karts[3].characterIdx).toBe(0)
    expect(view.karts[3].characterIdx).toBe(pair.guest.characterIdx[3])
    expect(view.karts[3].characterIdx).toBe(3)
    pair.host.close()
    pair.guest.close()
  })

  it('reconstructs s from checkpointIdx and t, with the grid on the last checkpoint', () => {
    const s = makeSolo(0)
    const b = createViewBuilder(s)
    const cp = s.ctx.track.checkpointS
    const n = cp.length
    expect(n).toBeGreaterThan(1)

    const wrap01 = (v: number): number => v - Math.floor(v)
    const seg = (i: number): number => (cp[(i + 1) % n] - cp[i] + 1) % 1

    for (const kart of [s.state().karts[4], s.prevState().karts[4]]) {
      kart.lap.checkpointIdx = 0
      kart.lap.t = 0.5
    }
    const view = s.currentView()
    b.build(0, view)
    expect(view.karts[4].s).toBeCloseTo(wrap01(cp[0] + 0.5 * seg(0)), 12)

    for (const kart of [s.state().karts[4], s.prevState().karts[4]]) {
      kart.lap.checkpointIdx = -1
      kart.lap.t = 0
    }
    b.build(0, view)
    expect(view.karts[4].s).toBeCloseTo(wrap01(cp[n - 1]), 12)
    s.close()
  })

  it('computes place with computePlacement over the VIEW\'s own values', () => {
    // Wire progress: seat 0 leads, then 2, then everyone else. state() claims
    // every remote seat is on lap 9, which is the fiction placement must ignore.
    // `| undefined` in the value type is what makes `?? 0` legal under strict:
    // with noUncheckedIndexedAccess off, a bare Record<number, number> index is
    // typed `number` and comparing or defaulting it against undefined errors.
    const laps: Record<number, number | undefined> = { 0: 2, 2: 1 }
    const fake = makeFakeGuest({
      localPlayerId: 1,
      wireKart: (pid) => makeWireKart(pid, laps[pid] ?? 0, 0.1 + pid * 0.01),
    })
    const b = createViewBuilder(fake)
    const view = fake.currentView()
    b.build(0, view)

    expect(view.karts[0].lap).toBe(2)   // from the wire, not 9
    expect(view.karts[2].lap).toBe(1)
    expect(view.karts[0].place).toBe(0)
    expect(view.karts[2].place).toBe(1)
    const places = new Set<number>()
    for (let i = 0; i < MAX_KARTS; i++) places.add(view.karts[i].place)
    expect(places.size).toBe(MAX_KARTS)
    expect(viewSourceViolations(view, 'guest')).toEqual([])
  })

  it('packs sampled entities at the front and lists nothing it could not sample', () => {
    const wire: WireEntity = {
      entityId: 7,
      kind: 'seeker',
      ownerId: 3,
      position: { x: 5, y: 1, z: -2 },
      velocity: { x: 1, y: 0, z: 0 },
      heading: 0.5,
      ttl: 120,
    }
    const fake = makeFakeGuest({
      localPlayerId: 1,
      wireKart: (pid) => makeWireKart(pid, 0, 0.1),
      entityIds: [7, 9],
      wireEntity: (id) => (id === 7 ? wire : null), // 9 despawned between keyframes
    })
    const b = createViewBuilder(fake)
    const view = fake.currentView()
    b.build(0, view)

    expect(view.entityCount).toBe(1)
    expect(view.entities[0].entityId).toBe(7)
    expect(view.entities[0].source).toBe('interpolated')
    expect(view.entities[0].ttl).toBe(120)
    expect(view.entities[1].entityId).toBe(-1)
    expect(view.entities[1].source).toBe('absent')
    expect(view.entities[MAX_ENTITIES - 1].source).toBe('absent')
    expect(viewSourceViolations(view, 'guest')).toEqual([])
  })

  it('fills the scalars and allocates nothing per frame', () => {
    const s = makeSolo(0)
    const b = createViewBuilder(s)
    const view = s.currentView()
    const posIdentity = view.karts[0].position
    const boxIdentity = view.itemBoxes[0].position

    s.tickOnce(intent(0, 1))
    b.build(0.25, view)

    expect(view.tick).toBe(s.state().tick)
    expect(view.alpha).toBe(0.25)
    expect(view.phase).toBe('countdown')
    expect(view.localPlayerId).toBe(0)
    expect(view.raceStartTick).toBe(COUNTDOWN_TICKS)
    expect(view.countdownTicksLeft).toBe(COUNTDOWN_TICKS - s.state().tick)
    expect(view.finishTick).toBe(-1)
    expect(view.itemBoxRespawnTicks).toBe(s.ctx.tuning.itemBoxRespawnTicks)
    expect(view.itemBoxes.length).toBe(s.ctx.track.itemBoxes.length)
    expect(view.karts[0].position).toBe(posIdentity)
    expect(view.itemBoxes[0].position).toBe(boxIdentity)
    s.close()
  })
})
```

Create `packages/game/test/frameloop.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { Intent } from '@tapkart/sim'
import { COUNTDOWN_TICKS, RACE_LAPS, TICK_DT, resetBotHold } from '@tapkart/sim'
import {
  ERROR_SMOOTH_WINDOW_TICKS,
  buildAudioModel,
  buildHudModel,
  createAudioModel,
  createHudModel,
} from '@tapkart/render'
import { renderNowMs } from '../src/clock'
import { createSoloTransport } from '../src/localinput'
import { createSession } from '../src/session'
import { createViewBuilder } from '../src/view'
import { makeCorrectingGuest, makeGameContext } from './fixtures/game-fixtures'

/** §4.9's one-shots. `engine` and `skid` are continuous levels and are excluded. */
const ONE_SHOTS = new Set([
  'lapCross', 'finish', 'spinOut', 'respawn', 'itemPickup', 'itemUse', 'boost', 'impact',
])

describe('the frame loop\'s two views (§5.10, §5.13)', () => {
  it('fires exactly one lapCross cue across a race that crosses one lap', () => {
    resetBotHold()
    const intent: Intent = { tick: 0, steer: 0.2, accel: 1, brake: false, drift: false, useItem: false }
    const session = createSession({
      role: 'solo',
      ctx: makeGameContext(true),
      localPlayerId: 0,
      seed: 0x5eed,
      characterIdx: [0, 1, 2, 3, 4, 5, 6, 7],
      transport: createSoloTransport(),
    })
    const builder = createViewBuilder(session)
    const audio = createAudioModel()
    const hud = createHudModel()

    // 60 racing ticks is about 20 m on this track, so no kart crosses the line
    // naturally in the window. The single crossing below is therefore the only
    // one, and the count is exact rather than approximate.
    const TICKS = COUNTDOWN_TICKS + 60
    const CROSS_AT = COUNTDOWN_TICKS + 30
    let lapCross = 0
    let firstFrameOneShots = 0

    for (let t = 1; t <= TICKS; t++) {
      session.tickOnce(intent)
      if (t === CROSS_AT) session.state().karts[0].lap.lap += 1

      // The shell's order, §5.13, minus the DOM and the GPU.
      const view = session.currentView()
      builder.build(0, view)
      buildHudModel(view, RACE_LAPS, hud)
      buildAudioModel(session.prevView(), view, audio)
      // (the shell calls audio.apply(audio) here — cues are consumed NOW)
      for (let c = 0; c < audio.cueCount; c++) {
        const kind = audio.cues[c].kind
        if (kind === 'lapCross') lapCross++
        if (t === 1 && ONE_SHOTS.has(kind)) firstFrameOneShots++
      }
      expect(session.currentView()).not.toBe(session.prevView())
      session.swapViews()
    }

    // Frame 1 compares two PRIMED views, not a real view against a zeroed one.
    expect(firstFrameOneShots).toBe(0)
    // THE assertion. With one shared view, prev IS view, every delta is empty
    // and this is 0. With the swap moved above buildAudioModel, the arguments
    // arrive reversed and the crossing reads as a lap going backwards.
    expect(lapCross).toBe(1)
    expect(hud.lap).toBeGreaterThanOrEqual(1)

    session.close()
  })
})

/**
 * Contract §8.1's "error smoothing, end to end" row, and the only consumer
 * `makeCorrectingGuest` will ever have.
 *
 * Everything else in this plan tests `advanceVisualOffset` in isolation, where
 * the correction is a number a test made up. This drives a REAL guest against a
 * REAL host over the loopback, with a changing intent — which is what actually
 * produces corrections, about three a second, where a held-steady intent
 * produces about one per 600 ticks — and asserts the thing R41 exists for: the
 * drawn kart EASES to the corrected position instead of snapping to it.
 *
 * The drawn position is `view.karts[localPlayerId].position`, which is the only
 * position a player ever sees. Built at `alpha = 0`, the builder's own source
 * for that seat is `prevState()`, so `drawn - prevState` IS the visual offset —
 * measured through the public surface rather than by reaching into the builder.
 */
describe('error smoothing, end to end (§8.1, R41)', () => {
  it('eases a real correction to zero instead of snapping', () => {
    resetBotHold()
    // 180 ticks of sine steering: the fixture's own job, and it returns a guest
    // that has already taken corrections rather than one that might.
    const g = makeCorrectingGuest(180)
    const guest = g.guest
    const localId = guest.localPlayerId
    const builder = createViewBuilder(guest)
    const maxTravelPerTick = guest.ctx.tuning.maxSpeed * TICK_DT

    const hostIntent: Intent = { tick: 0, steer: 0.1, accel: 1, brake: false, drift: false, useItem: false }
    const guestIntent: Intent = { tick: 0, steer: 0, accel: 1, brake: false, drift: false, useItem: false }

    const offsets: number[] = []
    const jumps: number[] = []
    const correctedOnFrame: boolean[] = []
    let corrections = g.corrections()
    let seenCorrections = 0
    let prevDrawn: { x: number; y: number; z: number } | null = null

    // 240 ticks of sine steering, then a quiet tail longer than the ease window
    // with BOTH sides holding the same steady intent. The tail is what makes
    // "eases to zero" observable: corrections all but stop, so the offset has
    // nothing to re-seed it and must decay on its own.
    const SINE_TICKS = 240
    const TAIL_TICKS = ERROR_SMOOTH_WINDOW_TICKS * 4
    for (let t = 181; t <= 180 + SINE_TICKS + TAIL_TICKS; t++) {
      guestIntent.steer = t <= 180 + SINE_TICKS ? Math.sin(t / 12) : 0.1
      g.host.tickOnce(hostIntent)
      guest.tickOnce(guestIntent)
      g.pump(renderNowMs(t, 0))

      const view = guest.currentView()
      builder.build(0, view)

      const drawn = view.karts[localId].position
      const source = guest.prevState().karts[localId].position
      offsets.push(Math.hypot(drawn.x - source.x, drawn.y - source.y, drawn.z - source.z))

      const now = g.corrections()
      correctedOnFrame.push(now > corrections)
      if (now > corrections) seenCorrections++
      corrections = now

      if (prevDrawn !== null) {
        jumps.push(Math.hypot(drawn.x - prevDrawn.x, drawn.y - prevDrawn.y, drawn.z - prevDrawn.z))
      }
      prevDrawn = { x: drawn.x, y: drawn.y, z: drawn.z }
      guest.swapViews()
    }

    // --- vacuity guards, first: a run with nothing to smooth proves nothing ---
    expect(g.corrections()).toBeGreaterThan(0)
    expect(seenCorrections).toBeGreaterThan(0)

    // --- THE assertion, and the one that fails if the smoother is removed -----
    // A no-op `advanceVisualOffset` leaves `current` at the origin forever, the
    // drawn seat is then exactly the raw predicted seat, and EVERY offset here
    // is 0. So this is the assertion that distinguishes "smoothing works" from
    // "smoothing was deleted", which a frame-to-frame bound alone does not:
    // a correction can be small enough to hide under any plausible-travel
    // threshold while still being a visible twitch at 60 Hz.
    const absorbed = offsets.filter((d) => d > 1e-9).length
    expect(absorbed).toBeGreaterThan(0)
    expect(Math.max(...offsets)).toBeGreaterThan(1e-6)

    // --- it EASES: the offset never grows except on a tick that re-seeded it --
    for (let i = 1; i < offsets.length; i++) {
      if (correctedOnFrame[i]) continue // a correction re-seeds the origin, by design
      expect(`frame ${i}: ${offsets[i] <= offsets[i - 1] + 1e-9}`).toBe(`frame ${i}: true`)
    }

    // --- and it reaches zero: the tail is 4x the ease window ------------------
    expect(offsets[offsets.length - 1]).toBeLessThan(1e-6)

    // --- §8.1's own wording: no frame-to-frame jump beyond one tick of travel -
    // The bound is two ticks of top speed, because a boost legitimately exceeds
    // `maxSpeed` for a few ticks; the defect this catches teleports the kart by
    // the whole correction delta in a single frame, which is far larger.
    expect(Math.max(...jumps)).toBeLessThan(maxTravelPerTick * 2)

    g.host.close()
    guest.close()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/game/test/view.test.ts packages/game/test/frameloop.test.ts`

Expected: FAIL at collection with
`Error: Failed to load url ../src/view (resolved id: .../packages/game/src/view) ... Does the file exist?`
— `packages/game/src/view.ts` does not exist yet.

- [ ] **Step 3a: Write `packages/game/src/vite-env.d.ts`**

```ts
/// <reference types="vite/client" />
```

That single line is the whole file, and it is the only place `packages/game`
references Vite's types. It is what makes `import.meta.env.DEV` compile under
`tsc --noEmit`, and it costs `vite` as a devDependency of `packages/game`
(§10 — already declared in that package's manifest). It is **not** needed by
`packages/content`, which uses no Vite feature at all.

- [ ] **Step 3b: Write `packages/game/src/view.ts`**

```ts
// PURE — the one place prediction and interpolation are chosen between (§5.11).
// No DOM, no wall clock, no `three`, no allocation in the frame path.
import type { SimContext, SimState, Vec3 } from '@tapkart/sim'
import {
  COUNTDOWN_TICKS,
  MAX_ENTITIES,
  MAX_KARTS,
  allocStateLike,
  computePlacement,
  driftTierFor,
  itemBoxWorldPos,
  wrapAngle,
} from '@tapkart/sim'
import type { RemoteEntitySample, RemoteSample } from '@tapkart/net'
// P2-R29: the sample buffers are the CALLER's, and this is the caller.
import { makeRemoteEntitySample, makeRemoteSample } from '@tapkart/net'
import type { RaceView, VisualOffset } from '@tapkart/render'
import { advanceVisualOffset, createVisualOffset, viewSourceViolations } from '@tapkart/render'
import { renderNowMs } from './clock'
import type { RaceSession } from './session'

export interface ViewBuilder {
  /** Fills `out` from the session captured at construction, obeying §7.1 seat by
   *  seat. SOLE WRITER of every RaceView field. Allocates nothing.
   *  This is the highest-value pure function in packages/game and it is tested
   *  against every role. */
  build(alpha: number, out: RaceView): void
}

/** Fractional part in [0, 1). The `>= 1` guard exists because
 *  `x - Math.floor(x)` can round up to exactly 1 for x just under an integer. */
function wrap01(v: number): number {
  const f = v - Math.floor(v)
  return f >= 1 ? 0 : f
}

/** Shortest-arc angular lerp. A component-wise lerp of two headings either side
 *  of ±π sends the kart the long way round through the opposite bearing. */
function lerpAngle(a: number, b: number, t: number): number {
  return wrapAngle(a + wrapAngle(b - a) * t)
}

/** §5.11 step 5. `s` is arc-normalised [0, 1), never metres. This works on a
 *  guest because `checkpointIdx` and `t` are on the wire, and it costs no
 *  `project()` call in the frame path. `checkpointIdx < 0` is the grid, which
 *  sits behind checkpoint 0 — i.e. on the LAST checkpoint of the notional
 *  previous lap, exactly as `createState` writes it. */
function sFromCheckpoint(cp: readonly number[], checkpointIdx: number, t: number): number {
  const n = cp.length
  if (n === 0) return 0
  const i = checkpointIdx < 0 ? n - 1 : ((checkpointIdx % n) + n) % n
  const span = (cp[(i + 1) % n] - cp[i] + 1) % 1
  return wrap01(cp[i] + t * span)
}

class ViewBuilderImpl implements ViewBuilder {
  private readonly session: RaceSession
  private readonly ctx: SimContext
  /** §5.11 step 9: filled with the VIEW's own kart values and handed to sim's
   *  own comparator, so a guest's placement is computed by the same function the
   *  authority uses, over authoritative wire values. Nothing re-implements it. */
  private readonly scratchState: SimState
  private readonly indexOf = new Int32Array(MAX_KARTS)
  private readonly order = new Int32Array(MAX_KARTS)
  private readonly entityIds = new Int32Array(MAX_ENTITIES)
  private readonly offset: VisualOffset = createVisualOffset()
  private readonly correctionPos: Vec3 = { x: 0, y: 0, z: 0 }
  /** P2-R29: the two sample buffers, allocated ONCE, here. One of each is
   *  enough — every field is copied into the KartView / EntityView before the
   *  next sample call, exactly as §7.3 requires of `sampleAt`'s scratch — and a
   *  buffer allocated inside `build` is the allocating form with extra steps,
   *  which would pass every test in this file while `build`'s "allocates
   *  nothing" promise quietly stopped being true. */
  private readonly kartSample: RemoteSample = makeRemoteSample()
  private readonly entitySample: RemoteEntitySample = makeRemoteEntitySample()
  private lastSeenTick: number

  constructor(session: RaceSession) {
    this.session = session
    this.ctx = session.ctx
    this.scratchState = allocStateLike(session.ctx, session.state())
    this.lastSeenTick = session.state().tick
  }

  build(alpha: number, out: RaceView): void {
    const session = this.session
    const ctx = this.ctx
    const state = session.state()
    const prev = session.prevState()
    const role = session.role
    const isGuest = role === 'guest'
    const localId = session.localPlayerId
    // Step 1. §6.3: nowMs is computed HERE and is never a parameter. The
    // interpolator's keyframes are stamped `tick * TICK_MS`, so a wall clock
    // would put the target instant thousands of milliseconds past the newest
    // keyframe on the very first frame — every remote kart takes the
    // extrapolation branch, clamps, and slides 200 ms along its last velocity
    // forever. Nothing throws and nothing logs; it merely looks wrong on a
    // device, which is the one place CI cannot see.
    const nowMs = renderNowMs(state.tick, alpha)
    const cp = ctx.track.checkpointS

    // --- Steps 2-8: karts, seat by seat, in seat order -----------------------
    for (let i = 0; i < MAX_KARTS; i++) {
      const kv = out.karts[i]
      kv.playerId = i
      // Step 4: from the session in EVERY role. WireKart carries no
      // characterIdx, and ClientLoop's predicted state is all zeroes.
      kv.characterIdx = session.characterIdx[i]

      if (!isGuest || i === localId) {
        const k = state.karts[i]
        const p = prev.karts[i]
        kv.source = isGuest ? 'predicted' : 'authoritative'
        // Step 3: state-sourced seats are lerped by alpha. Render-only — it
        // writes into the view, never back into either SimState.
        kv.position.x = p.position.x + (k.position.x - p.position.x) * alpha
        kv.position.y = p.position.y + (k.position.y - p.position.y) * alpha
        kv.position.z = p.position.z + (k.position.z - p.position.z) * alpha
        kv.heading = lerpAngle(p.heading, k.heading, alpha)
        kv.velocity.x = k.velocity.x
        kv.velocity.y = k.velocity.y
        kv.velocity.z = k.velocity.z
        kv.angularVelocity = k.angularVelocity
        kv.driftActive = k.drift.active
        kv.driftDir = k.drift.dir
        kv.driftCharge = k.drift.charge
        kv.airborne = k.airborne
        kv.surface = k.surface
        kv.spinOutTicks = k.spinOutTicks
        kv.invulnTicks = k.invulnTicks
        kv.boostTicks = k.boostTicks
        kv.respawnTicks = k.respawnTicks
        kv.shielded = k.shielded
        kv.item = k.item
        kv.lap = k.lap.lap
        kv.checkpointIdx = k.lap.checkpointIdx
        kv.t = k.lap.t
        kv.isBot = k.isBot
        kv.connected = k.connected
      } else {
        const sample = this.kartSample
        if (!session.sampleRemoteKart(i, nowMs, sample)) {
          // A cold or starved buffer. Everything else on this seat keeps its
          // previous value; `source` is the only field that changes, and
          // `visible` falls out of it in buildRenderFrame.
          //
          // P2-R29: `sample` still holds the PREVIOUS seat's values here — a
          // refused sample writes nothing. Reading it anyway would draw seat
          // i-1's authoritative kart at seat i, labelled 'interpolated', which
          // viewSourceViolations cannot catch because every label is legal.
          // `continue` is load-bearing, not stylistic.
          kv.source = 'absent'
          continue
        }
        const w = sample.kart
        kv.source = 'interpolated'
        // Only position and heading come from the interpolation itself…
        kv.position.x = sample.position.x
        kv.position.y = sample.position.y
        kv.position.z = sample.position.z
        kv.heading = wrapAngle(sample.heading)
        // …and EVERY discrete field comes from the wire record, verbatim (Q5).
        // Nothing is mixed: a KartView is filled from exactly one source.
        kv.velocity.x = w.velocity.x
        kv.velocity.y = w.velocity.y
        kv.velocity.z = w.velocity.z
        kv.angularVelocity = w.angularVelocity
        kv.driftActive = w.driftActive
        kv.driftDir = w.driftDir
        kv.driftCharge = w.driftCharge
        kv.airborne = w.airborne
        kv.surface = w.surface
        kv.spinOutTicks = w.spinOutTicks
        kv.invulnTicks = w.invulnTicks
        kv.boostTicks = w.boostTicks
        kv.respawnTicks = w.respawnTicks
        kv.shielded = w.shielded
        kv.item = w.item
        kv.lap = w.lap
        kv.checkpointIdx = w.checkpointIdx
        kv.t = w.t
        kv.isBot = w.isBot
        kv.connected = w.connected
      }

      kv.speed = Math.hypot(kv.velocity.x, kv.velocity.z) // step 7, PLAN view
      kv.s = sFromCheckpoint(cp, kv.checkpointIdx, kv.t) // step 5
      // Step 6. sampleAt returns SHARED scratch (§7.3) — this reads one number
      // out of it immediately and retains nothing.
      kv.bankAngle = ctx.query.sampleAt(kv.s).banking
      // Step 8: the only call site of driftTierFor in Plan 3, and the only place
      // the tier is computed. sim's encoding: -1 none, 0..2 an index.
      kv.driftTier = driftTierFor(kv.driftCharge, ctx.tuning.driftTiers)
    }

    // --- Step 11a: error smoothing, local seat, guest only (R41/R47/R48) -----
    if (isGuest && localId >= 0 && localId < MAX_KARTS) {
      const ticksElapsed = state.tick - this.lastSeenTick
      if (ticksElapsed > 0) {
        this.lastSeenTick = state.tick
        // The nullable travels UNCHANGED from correctionDeltaOf through the
        // session into the smoother, so "no correction" is never reconstructed
        // from a zero delta.
        const h = session.correctionDelta(this.correctionPos)
        advanceVisualOffset(this.offset, this.correctionPos, h, ticksElapsed, this.offset)
      }
      // Applied every frame, including frames that ran zero ticks — that is what
      // keeps the ease frame-rate independent. Never written into a SimState,
      // never applied to a remote seat, never on host or solo.
      const kv = out.karts[localId]
      const o = this.offset
      kv.position.x += o.current.x
      kv.position.y += o.current.y
      kv.position.z += o.current.z
      kv.heading = wrapAngle(kv.heading + o.currentHeading)
    }

    // --- Step 9: placement, always through sim's own comparator --------------
    const sk = this.scratchState
    for (let i = 0; i < MAX_KARTS; i++) {
      const kv = out.karts[i]
      const k = sk.karts[i]
      k.playerId = i
      k.lap.lap = kv.lap
      k.lap.checkpointIdx = kv.checkpointIdx
      k.lap.t = kv.t
    }
    for (let i = 0; i < MAX_KARTS; i++) sk.finishedOrder[i] = state.finishedOrder[i]
    computePlacement(sk, this.indexOf, this.order)
    for (let i = 0; i < MAX_KARTS; i++) out.karts[i].place = this.indexOf[i]

    // --- Step 10: entities ---------------------------------------------------
    if (isGuest) {
      const n = session.remoteEntityIds(this.entityIds)
      let live = 0
      for (let j = 0; j < n && live < MAX_ENTITIES; j++) {
        const id = this.entityIds[j]
        const sample = this.entitySample
        // P2-R29: `false` leaves the buffer holding the PREVIOUS entity, so the
        // `continue` must come before anything reads it. Skipping it here draws
        // the last entity twice, at two ids, and nothing in the view is illegal.
        if (!session.sampleRemoteEntity(id, nowMs, sample)) continue // despawned between keyframes: not listed
        const e = sample.entity
        const ev = out.entities[live]
        live++
        ev.entityId = e.entityId
        ev.kind = e.kind
        ev.ownerId = e.ownerId
        ev.source = 'interpolated'
        ev.position.x = sample.position.x
        ev.position.y = sample.position.y
        ev.position.z = sample.position.z
        ev.heading = wrapAngle(sample.heading)
        ev.velocity.x = e.velocity.x
        ev.velocity.y = e.velocity.y
        ev.velocity.z = e.velocity.z
        ev.ttl = e.ttl
      }
      out.entityCount = live
      for (let j = live; j < MAX_ENTITIES; j++) {
        out.entities[j].entityId = -1
        out.entities[j].source = 'absent'
      }
    } else {
      const count = state.entityCount
      for (let j = 0; j < MAX_ENTITIES; j++) {
        const ev = out.entities[j]
        if (j >= count) {
          ev.entityId = -1
          ev.source = 'absent'
          continue
        }
        const e = state.entities[j]
        const pe = prev.entities[j]
        ev.entityId = e.entityId
        ev.kind = e.kind
        ev.ownerId = e.ownerId
        ev.source = 'authoritative'
        // Lerped by alpha like karts — but ONLY against the same entity. Slots
        // are packed and reused by swap-remove, so a slot's previous occupant is
        // frequently a different entity somewhere else on the track, and lerping
        // against it would fly the new one in from there.
        const same = pe.entityId === e.entityId
        ev.position.x = same ? pe.position.x + (e.position.x - pe.position.x) * alpha : e.position.x
        ev.position.y = same ? pe.position.y + (e.position.y - pe.position.y) * alpha : e.position.y
        ev.position.z = same ? pe.position.z + (e.position.z - pe.position.z) * alpha : e.position.z
        ev.heading = same ? lerpAngle(pe.heading, e.heading, alpha) : e.heading
        ev.velocity.x = e.velocity.x
        ev.velocity.y = e.velocity.y
        ev.velocity.z = e.velocity.z
        ev.ttl = e.ttl
      }
      out.entityCount = count
    }

    // --- Step 11: item boxes, from state() in every role ---------------------
    // No `source` field and nothing polices these: WireSnapshot carries no
    // item-box state at all, so a guest has no authoritative source to check
    // against. A wrong box is a cosmetic ghost, and every real pickup is
    // corrected by the reliable itemGrant stream (§7.1, R45).
    const boxes = out.itemBoxes
    for (let b = 0; b < boxes.length; b++) {
      const bx = boxes[b]
      bx.boxIdx = b
      // The drawn box and the pickup volume are one object, by construction.
      // This also invalidates the query scratch, which is why bankAngle above
      // was copied out immediately.
      itemBoxWorldPos(ctx, b, bx.position)
      bx.respawnTicks = state.itemBoxes[b].respawnTicks
    }
    out.itemBoxRespawnTicks = ctx.tuning.itemBoxRespawnTicks

    // --- Step 12: scalars ----------------------------------------------------
    out.tick = state.tick
    out.alpha = alpha
    out.phase = state.phase // authoritative in every role now that R44 wires it
    out.localPlayerId = localId
    out.raceStartTick = session.raceStartTick
    out.finishTick = state.finishTick
    for (let i = 0; i < MAX_KARTS; i++) out.finishedOrder[i] = state.finishedOrder[i]
    out.countdownTicksLeft =
      state.phase === 'countdown' ? Math.max(0, COUNTDOWN_TICKS - state.tick) : 0

    // --- Step 13: Q32's dev assertion, last ----------------------------------
    if (import.meta.env.DEV) {
      const violations = viewSourceViolations(out, role)
      if (violations.length > 0) {
        throw new Error(`buildRaceView: seat-source violations:\n${violations.join('\n')}`)
      }
    }
  }
}

/**
 * Allocates the builder's scratch ONCE: the placement scratch SimState, two
 * Int32Arrays for computePlacement, the Int32Array remoteEntityIds fills, one
 * VisualOffset (R41), one Vec3 for the correction delta, and — P2-R29 — one
 * RemoteSample and one RemoteEntitySample from `makeRemoteSample` /
 * `makeRemoteEntitySample`.
 *
 * It also PRIMES both of the session's RaceViews (§5.10). `buildAudioModel`
 * takes the delta between consecutive views; if frame 1 compared a real view
 * against a freshly zeroed one it would fire a burst of spurious cues on the
 * grid. Priming lives here because this is the only thing in the repository that
 * can fill a view, and leaving it to the shell would make it forgettable.
 */
export function createViewBuilder(session: RaceSession): ViewBuilder {
  const builder = new ViewBuilderImpl(session)
  builder.build(0, session.currentView())
  session.swapViews()
  builder.build(0, session.currentView())
  return builder
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run packages/game/test/view.test.ts packages/game/test/frameloop.test.ts`
Expected: 12 passing.

The smoothing test drives 480 sim ticks on two sessions plus a 48-tick tail, so
it is the slowest test in the file at roughly a second. If it fails on
`expect(seenCorrections).toBeGreaterThan(0)`, the loopback pair is delivering
nothing — check the fixture's transport before suspecting the smoother.

Then typecheck: `npx tsc --noEmit -p packages/game/tsconfig.json` — expected: no
output. If it reports *"Cannot find type definition file for 'vite/client'"*, run
`npm install` at the repository root: `vite` is a declared devDependency of
`packages/game` (§10) and the reference in `vite-env.d.ts` needs it on disk.

**What each test catches, and whether it would actually fail under that bug:**

| Test | Bug | Fails? |
|---|---|---|
| flagship, 600 ticks | any seat or entity drawn from the wrong source in any role | yes — and the two "saw ≥ 1 interpolated" guards mean an all-`'absent'` view cannot pass, which is the way this test would otherwise measure nothing |
| remote seat from the wire | the naive implementation: filling remote seats from `state()`, i.e. from the local sim's bot AI | yes — the two sources are made **provably different** first (500 m, lap 7, charge 999, item `'bolt'`), so a pass cannot come from the two happening to agree |
| local seat still from state | over-correcting into "read everything from the interpolator" | yes — the interpolator returns `null` for the local seat, so the seat would go `'absent'` and never move |
| tick-derived nowMs | passing `clock.nowMs()` to the interpolator (§6.3) | yes — the test first proves the wrong basis pins two instants a minute apart to the same pose, then asserts the view matches the right basis and not that one |
| DEV assertion throws | the assertion omitted, or wrapped so it can never fire | yes |
| Q9 lerp on a bot seat | lerping only the local seat, the literal reading of Q9 | yes — seat 5 would equal the current value; the `> 1e-6` guard first proves prev and cur genuinely differ |
| shortest-arc heading | a component-wise heading lerp | yes — gives 0 instead of ±π, a difference of the whole circle |
| entity slot reuse | lerping a slot against whatever used to live in it | yes — 900 m of error |
| characterIdx from session | reading it off `state()` | yes — `state()` says 0, the session says 3 |
| s reconstruction | using metres instead of arc-normalised `s`, or mishandling `checkpointIdx < 0` | yes |
| placement from view values | computing placement from `state()` on a guest | yes — `state()` claims every remote seat is on lap 9, so seat 0 would not be first |
| entity packing | listing an unsampled id, or leaving a stale `entityId` in a dead slot | yes, and `viewSourceViolations` agrees independently |
| scalars / no allocation | rebuilding the view's objects per frame | yes — object identity |
| **frameloop: exactly one lapCross** | **the contract defect: one shared `RaceView`, so `prev` IS `view` and every audio delta is empty** | **yes — the count is 0.** It also fails if the swap is moved above `buildAudioModel` (arguments reversed) or if the views are not primed (frame 1 fires a burst) |
| **frameloop: error smoothing, end to end** | **R41 removed, stubbed, or applied to a `SimState` instead of the drawn seat** — the required feature that every unit-level test around it would still pass without | **yes — with a no-op smoother the drawn seat IS the raw predicted seat, every measured offset is exactly 0, and `absorbed > 0` fails.** It also fails if the offset never decays (a smoother that re-seeds every frame: the monotone check trips), if it never reaches zero (the tail is four ease windows long), and if the ease is applied per FRAME rather than per TICK. The two vacuity guards come first, because a run with zero corrections would let a deleted smoother pass everything below them |

- [ ] **Step 5: Commit**

```bash
git add packages/game/src/view.ts packages/game/src/vite-env.d.ts \
        packages/game/test/view.test.ts packages/game/test/frameloop.test.ts && \
git commit -m "feat(game): ViewBuilder — the seat-source rule, made mechanical

frameloop.test.ts also carries §8.1's error-smoothing row: a real guest
taking real corrections over the loopback, with the drawn local position
recorded every frame. It asserts the offset is non-zero (a deleted
smoother makes every one of them exactly 0), decays monotonically except
on the ticks that re-seed it, reaches zero within the ease window, and
never moves the drawn kart further in one frame than a kart can travel
in one tick. makeCorrectingGuest exists for this test and has no other
consumer: a held-steady intent produces about one correction per 600
ticks, so a smoothing test driven by one would have nothing to smooth."
```

---

### Task 24: `src/shell.ts` and the `game` barrel

**Files:**
- Create: `packages/game/src/shell.ts` — **ADAPTER** (thin, untestable; §8.2). No test, by contract.
- Modify: `packages/game/src/index.ts` — the clock task created it carrying `export * from './clock'` and **no task has touched it since**: the controls, settings and app tasks each explicitly forbid themselves from touching it, and the session and view tasks are silent and touch nothing. This task brings it to §5.15's full list: keep the header comment, **replace** the single export line with the block in Step 3a. Do not try to merge into it — there is nothing to merge.
- Verify (do **not** create): `packages/game/src/vite-env.d.ts` — the view task created it. Its whole content is `/// <reference types="vite/client" />`. If it is missing, create it with that one line and say so in your report.
- Test: `packages/game/test/barrel.test.ts`

`packages/game/src/results.ts` and `packages/game/test/results.test.ts` are **not this
task's** — they were split out into their own task, placed immediately after the app task
so that the `app.ts` ↔ `results.ts` type-only cycle resolves in one step instead of
staying broken across three. This task now *consumes* `buildResultRows`.

**Interfaces:**

- Consumes, from `@tapkart/sim` (§2.1, §2.2):
  ```ts
  export const MAX_KARTS = 8
  export const RACE_LAPS = 3
  export interface Intent { tick: number; steer: number; accel: number; brake: boolean; drift: boolean; useItem: boolean }
  export interface SimContext { track: Track; query: TrackQuery; tuning: Tuning; characters: CharacterStats[]; isLeader: boolean }
  ```
- Consumes, from `@tapkart/content` (§3a):
  ```ts
  export const TUNING: Readonly<Tuning>
  export const CHARACTERS: readonly CharacterStats[]
  export const TRACK_MANIFEST: readonly TrackManifestEntry[]      // { id, name }, id ascending
  export interface LoadedTrack { track: Track; query: TrackQuery; theme: TrackTheme }
  export function loadTrack(id: string): LoadedTrack               // synchronous, total, memoised
  export interface ContentBundle { characters: readonly CharacterDescriptor[]
                                   karts: readonly KartDescriptor[]
                                   themes: Readonly<Record<string, TrackTheme>> }
  export function loadContentBundle(): ContentBundle               // memoised
  ```
  **`CHARACTERS` is `readonly CharacterStats[]` and does NOT assign to
  `SimContext.characters: CharacterStats[]`.** Every composition root writes
  `characters: CHARACTERS.slice()`. (`TUNING: Readonly<Tuning>` *does* assign to
  `tuning: Tuning`, so the asymmetry is easy to miss — arrays are the case that
  bites. Found by the author of Tasks 1–3 while running their code; Task 2 pins
  it with a `createState`/`step` test.)
- Consumes, from `@tapkart/render` (§4.2, §4.6 – §4.10):
  ```ts
  export type ViewRole = 'host' | 'guest' | 'solo'
  export interface KartView { /* §4.2 */ characterIdx: number; lap: number; playerId: number }
  export interface RaceView { tick: number; alpha: number; phase: RacePhase; localPlayerId: number
    raceStartTick: number; karts: KartView[]; entities: EntityView[]; entityCount: number
    itemBoxes: ItemBoxView[]; itemBoxRespawnTicks: number; finishedOrder: number[]
    finishTick: number; countdownTicksLeft: number }
  export function createRaceView(itemBoxCount: number): RaceView
  export type CameraMode = 'chase' | 'countdown' | 'results' | 'free'
  export interface CameraState { position: Vec3; lookAt: Vec3; up: Vec3; fovDegrees: number; mode: CameraMode }
  export function createCameraState(): CameraState
  export const DEFAULT_CAMERA_PARAMS: Readonly<CameraParams>
  export function updateCamera(cam: CameraState, target: KartView, params: CameraParams,
                               mode: CameraMode, ticks: number): void
  export interface RenderFrame { /* §4.7 */ }
  export function createRenderFrame(itemBoxCount: number): RenderFrame
  export function buildRenderFrame(view: RaceView, cam: CameraState, theme: TrackTheme,
                                   characters: readonly CharacterDescriptor[],
                                   karts: readonly KartDescriptor[], out: RenderFrame): void
  export interface HudModel { visible: boolean; place: number /* 1-BASED */; fieldSize: number
    lap: number /* 1-BASED */; totalLaps: number; speedKph: number; item: ItemKind
    itemReady: boolean; driftTier: number; countdownLabel: CountdownLabel; raceClock: string
    respawning: boolean; spunOut: boolean; motionLocked: boolean; standings: HudStanding[] }
  export function createHudModel(): HudModel
  export function buildHudModel(view: RaceView, totalLaps: number, out: HudModel): void
  export interface AudioModel { engineFreqHz: number; engineGain: number; skidGain: number
                                cues: AudioCue[]; cueCount: number }
  export function createAudioModel(): AudioModel
  export function buildAudioModel(prev: RaceView, view: RaceView, out: AudioModel): void
  export interface AudioConfig { masterGain: number; enabled: boolean }
  export interface AudioBackend { apply(model: AudioModel): void; setConfig(cfg: AudioConfig): void; close(): void }
  export interface MeshData { positions: Float32Array; normals: Float32Array; uvs: Float32Array
                              colors: Float32Array; indices: Uint32Array }
  export const DEFAULT_MESH_OPTIONS: Readonly<MeshBuildOptions>
  export interface TrackScene { road: MeshData; boostPads: MeshData; ramps: MeshData
                                checkpoints: MarkerPlacement[]; edgeMarkers: EdgeMarkerPlacement[]
                                itemBoxes: Vec3[]       // index-paired with RenderFrame.itemBoxAlpha
                                bounds: { min: Vec3; max: Vec3 } }
  /** AMENDMENT 1: `ctx`, not `(track, query)`. `itemBoxWorldPos` — sim's, and the sole
   *  writer of an item box's world position — needs a SimContext, and SimContext carries
   *  both `track` and `query`, so the 3-arg form is strictly narrower: it is no longer
   *  possible to hand this function a query built for a different track. */
  export function buildTrackScene(ctx: SimContext, theme: TrackTheme,
                                  opts: MeshBuildOptions): TrackScene
  export function buildCharacterMesh(desc: CharacterDescriptor): MeshData
  export function buildKartMesh(desc: KartDescriptor): MeshData
  export interface RendererBackend {
    setScene(scene: TrackScene, theme: TrackTheme, kartMeshes: readonly MeshData[],
             characterMeshes: readonly MeshData[]): void
    applyFrame(frame: RenderFrame): void
    resize(widthPx: number, heightPx: number, devicePixelRatio: number): void
    stats(): RendererStats
    dispose(): void
  }
  ```
- Consumes, from `packages/game`'s earlier tasks:
  ```ts
  // ./clock (§5.1)
  export interface FrameClock { nowMs(): number }
  export function accumulatorAlpha(acc: TickAccumulator): number
  // @tapkart/net (AMENDMENT 4) — the whole accumulator moved out of game/clock.ts,
  // because packages/server runs the same fixed-step pump and net may not import
  // game. This file imports it from net directly, exactly as the server will.
  // SHIPPED SIGNATURES, which differ from contract §5.1 in three places: the type
  // has ONE field (no lastNowMs), the second argument is an elapsed DELTA rather
  // than an absolute nowMs, and the clamp is 5 rather than 8. THIS FILE is the
  // caller that therefore owns `lastNowMs` — one `let` and one subtraction.
  export interface TickAccumulator { residualMs: number }
  export function makeTickAccumulator(): TickAccumulator
  export function advanceAccumulator(acc: TickAccumulator, elapsedMs: number): number
  // ./results (the task immediately after the app task)
  export interface ResultRow { place: number; playerId: number; name: string; dnf: boolean }
  export function buildResultRows(view: RaceView, slots: readonly LobbySlot[]): ResultRow[]
  // ./settings (§5.7)
  export interface Settings { scheme: ControlScheme; tiltCalibration: TiltCalibration
    invertTilt: boolean; audioEnabled: boolean; audioVolume: number; characterIdx: number
    lastTrackId: string; playerName: string }
  export interface KeyValueStore { get(key: string): string | null; set(key: string, value: string): void }
  export function loadSettings(store: KeyValueStore): Settings
  export function saveSettings(store: KeyValueStore, s: Settings): void
  // ./controls/types (§5.5)
  export interface Viewport { width: number; height: number }
  export interface ControlInputs { pointers: PointerSample[]; pointerCount: number
    keys: Record<string, boolean>; tilt: TiltSample | null; viewport: Viewport }
  export function createControlInputs(): ControlInputs
  export interface ControlAdapter { readonly scheme: ControlScheme
    sample(raw: ControlInputs, tick: number, out: Intent): void; reset(): void }
  // ./controls/config (§5.5)
  export interface ControlConfig { deadZone: number; steerGain: number; steerSmoothingPerTick: number
    tiltNeutralDegrees: number; tiltRangeDegrees: number; tiltCalibration: TiltCalibration
    invertTilt: boolean; keyBindings: Record<string, 'left'|'right'|'accel'|'brake'|'drift'|'item'> }
  export const DEFAULT_CONTROL_CONFIG: Readonly<ControlConfig>
  // ./controls/index (§5.5)
  export function makeControlAdapter(scheme: ControlScheme, cfg: ControlConfig): ControlAdapter
  // ./controls/source (§5.6) — DOM adapter; ONLY shell.ts may import it
  export interface InputSource { drain(out: ControlInputs): void; detach(): void }
  export function attachInputSource(target: EventTarget, viewport: Viewport): InputSource
  export function requestTiltPermission(): Promise<boolean>
  // @tapkart/protocol — room codes RETIRE contract §5.8's game/src/roomcode.ts.
  // There is no such module: the alphabet's ORDER is the 5-bit wire index, so a
  // copy in `game` would be a second wire format. The code is 5 characters.
  export function normalizeRoomCode(raw: string): string
  export function isValidRoomCode(raw: string): boolean
  // ./app (§5.9)
  export type ScreenId = 'title' | 'characterSelect' | 'lobby' | 'race' | 'results'
  export interface LobbySlot { playerId: number; name: string; characterIdx: number
                               isBot: boolean; connected: boolean; ready: boolean }
  export interface AppState { screen: ScreenId; role: ViewRole; roomCode: string; trackId: string
    localPlayerId: number; slots: LobbySlot[]; settings: Settings; results: ResultRow[]
    error: string; connecting: boolean }
  export function createAppState(settings: Settings): AppState
  export type AppEvent =
    | { kind: 'hostPressed' }
    | { kind: 'joinPressed' }
    | { kind: 'soloPressed' }
    | { kind: 'roomCodeEntered'; code: string }
    | { kind: 'connected'; roomCode: string; localPlayerId: number }
    | { kind: 'connectFailed'; message: string }
    | { kind: 'lobbyUpdated'; slots: LobbySlot[] }
    | { kind: 'characterChosen'; characterIdx: number }
    | { kind: 'trackChosen'; trackId: string }
    | { kind: 'settingsChanged'; settings: Settings }
    | { kind: 'raceStarting' }
    | { kind: 'raceTick'; phase: RacePhase; finishedOrder: readonly number[] }
    | { kind: 'raceFinished'; results: ResultRow[] }
    | { kind: 'backToLobby' }
    | { kind: 'quitToTitle' }
  export function reduceApp(prev: AppState, ev: AppEvent): AppState
  export const SCREEN_TRANSITIONS: Readonly<Record<ScreenId, readonly AppEvent['kind'][]>>
  // ./session (Task 22), ./localinput (Task 22), ./view (Task 23)
  export function createSession(opts: SessionOptions): RaceSession
  export function createSoloTransport(): LocalInputTransport
  export function createViewBuilder(session: RaceSession): ViewBuilder
  ```

- Produces:
  ```ts
  // packages/game/src/shell.ts   — ADAPTER, never re-exported from the barrel
  export interface ShellOptions { canvas: HTMLCanvasElement; root: HTMLElement
    clock: FrameClock; store: KeyValueStore; renderer: RendererBackend; audio: AudioBackend }
  export interface GameShell { stop(): void }
  export function startShell(opts: ShellOptions): GameShell

  // packages/game/src/index.ts — re-exports only, no new symbols
  ```
  The barrel re-exports `./results`, which is another task's module now; the barrel
  test below is therefore an assertion about that task's output as much as this one's.
  The `apps/web` task imports `startShell` from `@tapkart/game/shell` — the second
  `exports` entry of the package (§10) — and nothing else from this file.

**What this task decides, and why**

- **The shell contains no game decisions** (§0a). Every branch it would want is a
  field on `RenderFrame`, `HudModel` or `AppState`, and the buttons it draws come
  from `SCREEN_TRANSITIONS` — the reducer's own table — so the two can never
  disagree about what is legal on a screen.
- **`swapViews()` is called AFTER `audio.apply`.** The two `RaceView`s are the
  session's (Task 22). `buildAudioModel` takes the delta between the previous
  frame's view and this one; cues are consumed in the frame they are raised, so
  swapping any earlier drops them and swapping never at all (one shared view)
  makes every delta empty and every one-shot cue unreachable. This ordering is
  the whole fix — do not tidy it upward.
- **Plan 3 has one transport source.** There is no server, no signalling and no
  WebRTC until Plan 4 (§12), so `hostPressed`/`joinPressed` are answered
  immediately with `connectFailed`, and the race screen always builds a solo
  transport. That is honest about what this build can do; a lobby that spins
  forever is not.
- **The shell carries ten `data-testid` hooks, and they are ANOTHER PLAN'S
  contract** (*added 2026-08-14*; contract §5.13). Plan 4 Task 24 ships
  `e2e/join-and-race.spec.ts` — spec §8's last row, two browser contexts joining
  by code and finishing a race — and its selector contract lives in
  `e2e/fixtures/tapkart.ts`. The values are copied verbatim into `TESTIDS` in
  Step 3; **do not rename one**, and do not "improve" a name, because the
  corresponding change has to happen in Plan 4's fixture first or the two stop
  agreeing. A testid that does not match is the same silent failure as a
  mismatched CSS selector, which is the exact failure the scheme exists to
  prevent.

  | `data-testid` | Where it goes in this file |
  |---|---|
  | `host-button` | the `hostPressed` transition button (`BUTTON_TESTIDS`) |
  | `join-button` | the `joinPressed` transition button |
  | `room-code-input` | the join flow's `<input>` |
  | `room-code-submit` | the join flow's GO button |
  | `room-code` | a span carrying the **bare five characters**, not `ROOM ABCDE` |
  | `ready-button` | the lobby screen's ready toggle |
  | `start-button` | the `raceStarting` transition button |
  | `race-canvas` | `opts.canvas` itself |
  | `lap-counter` | `hudLap` |
  | `results` | the results screen's panel |

  Two of them are hooks on behaviour Plan 3 does not own: `ready-button` has no
  `AppEvent` (readiness is lobby traffic, §12) and toggles a local flag, and
  `room-code-input` submits a code no Plan 3 build can mint. **That is still the
  contract being met** — what the E2E asserts is that the adapter put the control
  on the screen the model says it belongs to. Plan 4's spec is deliberately not
  `test.skip`ped while it waits: it fails, naming the missing hook, which is why
  this is a real obligation and not a note.

---

- [ ] **Step 1: Write the failing test**

Create `packages/game/test/barrel.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import * as barrel from '../src/index'
import * as app from '../src/app'
import * as clock from '../src/clock'
import * as composite from '../src/controls/composite'
import * as config from '../src/controls/config'
import * as controls from '../src/controls/index'
import * as controlTypes from '../src/controls/types'
import * as tilt from '../src/controls/tilt'
import * as localinput from '../src/localinput'
import * as results from '../src/results'
import * as session from '../src/session'
import * as settings from '../src/settings'
import * as view from '../src/view'

const MODULES: Array<[string, Record<string, unknown>]> = [
  ['clock', clock],
  ['controls/types', controlTypes],
  ['controls/config', config],
  ['controls/tilt', tilt],
  ['controls/composite', composite],
  ['controls/index', controls],
  ['settings', settings],
  ['app', app],
  ['results', results],
  ['session', session],
  ['localinput', localinput],
  ['view', view],
]

describe('@tapkart/game barrel', () => {
  it('re-exports every listed module with no name collisions', () => {
    const owner = new Map<string, string>()
    const clashes: string[] = []
    for (const [name, mod] of MODULES) {
      for (const key of Object.keys(mod)) {
        const prev = owner.get(key)
        if (prev !== undefined) clashes.push(`${key}: ${prev} and ${name}`)
        else owner.set(key, name)
      }
    }
    expect(clashes).toEqual([])
    for (const key of owner.keys()) expect(Object.keys(barrel)).toContain(key)
  })

  it('does NOT re-export either DOM adapter (§8.2)', () => {
    // A barrel that re-exported shell.ts or controls/source.ts would pull DOM
    // listeners — and, through the render barrel's sibling mistake, `three` and
    // a WebGL context — into every headless test in the repository. The failure
    // then shows up as an unrelated suite breaking.
    const keys = Object.keys(barrel)
    for (const forbidden of ['startShell', 'attachInputSource', 'requestTiltPermission']) {
      expect(keys).not.toContain(forbidden)
    }
    // …and not the sub-adapters either, which reach the outside world only
    // through makeControlAdapter.
    for (const forbidden of ['makeThumbZonesAdapter', 'makeVirtualStickAdapter', 'makeKeyboardAdapter']) {
      expect(keys).not.toContain(forbidden)
    }
    expect(keys).toContain('makeControlAdapter')
    expect(keys).toContain('createSession')
    expect(keys).toContain('createViewBuilder')
    expect(keys).toContain('buildResultRows')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/game/test/barrel.test.ts`

Expected: **FAIL on an assertion, not at collection** — `Tests 2 failed (2)`. Every one
of the twelve module imports resolves: `src/results.ts` was shipped by the task after
the app task, and `src/index.ts` has existed since the clock task created it carrying one
line. What is wrong is the barrel's *contents*, and the first `it` says so:

```
AssertionError: expected [ 'accumulatorAlpha', 'makeFixedClock', 'realFrameClock',
'renderNowMs' ] to contain 'createControlInputs'
```

— the barrel carries `./clock`'s six exports and nothing else. The second `it` then fails
at `expect(keys).toContain('makeControlAdapter')` for the same reason.

This is a **better** RED than a missing file: a `Failed to load url` proves only that
something is absent, while this proves the barrel exists, resolves, and is incomplete —
which is the actual defect this step is looking for. If instead you see
`Error: Failed to load url ../src/results`, the results task has not landed and this task
is running out of order; go back rather than creating `results.ts` here.

(Note what is **not** in that list. Amendment 4 moved the whole accumulator —
`TickAccumulator`, `makeTickAccumulator`, `advanceAccumulator`, `MAX_CATCHUP_TICKS` —
to `@tapkart/net`, and `game/clock.ts` re-exports none of it, so the game barrel never
carries net's symbols under a second name. `roomcode` is absent from the module list
for the same reason: room codes are `@tapkart/protocol`'s and `game/src/roomcode.ts`
does not exist.)

- [ ] **Step 3a: Bring `packages/game/src/index.ts` to its full list**

The file already exists (Task 17 created it). Its export lines become exactly
this — every module §5.15 names, in that order, and nothing else:

```ts
// The @tapkart/game barrel. It re-exports the PURE modules only.
//
// Not `./controls/source` and not `./shell` — both are DOM adapters (§8.2) —
// and not `./controls/thumbzones`, `./controls/stick` or `./controls/keyboard`,
// whose factories reach the outside world only through makeControlAdapter.
// `./controls/tilt` IS re-exported, because Settings names TiltCalibration and
// the screens call calibrateTilt; makeTiltAdapter rides along and is harmless.
//
// There is no `content/` directory in this package at all: R46 moved the tuning,
// the descriptors, the themes and the tracks to @tapkart/content, because
// Plan 4's shadow authority needs them and spec §3 forbids `server` from
// depending on `game`. There is no `./roomcode` either: §5.8 retired in favour of
// @tapkart/protocol, whose room-code alphabet ORDER is the 5-bit wire index.
export * from './clock'
export * from './controls/types'
export * from './controls/config'
export * from './controls/tilt'
export * from './controls/composite'
export * from './controls/index'
export * from './settings'
export * from './app'
export * from './results'
export * from './session'
export * from './localinput'
export * from './view'
```

- [ ] **Step 3b: Write `packages/game/src/shell.ts`**

```ts
// ADAPTER — thin, untestable, never imported by CI (§8.2). requestAnimationFrame,
// canvas sizing, DOM mounting and the orientation overlay live here and nowhere
// else in packages/game except controls/source.ts.
//
// It contains NO game decisions: every branch it would want is a field on
// RenderFrame, HudModel or AppState, and the buttons it draws come from
// SCREEN_TRANSITIONS — the reducer's own table — so the two cannot disagree.
import type { Intent, SimContext } from '@tapkart/sim'
import { MAX_KARTS, RACE_LAPS } from '@tapkart/sim'
import type { CharacterDescriptor, KartDescriptor, TrackTheme } from '@tapkart/content'
import { CHARACTERS, TRACK_MANIFEST, TUNING, loadContentBundle, loadTrack } from '@tapkart/content'
import type {
  AudioBackend,
  AudioModel,
  CameraMode,
  CameraState,
  HudModel,
  MeshData,
  RaceView,
  RenderFrame,
  RendererBackend,
} from '@tapkart/render'
import {
  DEFAULT_CAMERA_PARAMS,
  DEFAULT_MESH_OPTIONS,
  buildAudioModel,
  buildCharacterMesh,
  buildHudModel,
  buildKartMesh,
  buildRenderFrame,
  buildTrackScene,
  createAudioModel,
  createCameraState,
  createHudModel,
  createRenderFrame,
  updateCamera,
} from '@tapkart/render'
import type { AppEvent, AppState } from './app'
import { SCREEN_TRANSITIONS, createAppState, reduceApp } from './app'
// AMENDMENT 4: the accumulator is @tapkart/net's, because packages/server runs the
// same fixed-step pump and net may not import game. This file imports it from net
// exactly as the server will, and it takes an elapsed DELTA -- so this file, the
// only frame loop in the plan, is what owns `lastNowMs`. TICK_MS is NOT imported
// here and must never be: game/clock.ts is its only importer in the repository, and
// clock.test.ts scans every packages/*/src tree on every run to keep that true.
// Room codes come from @tapkart/protocol for the same one-copy reason.
import { advanceAccumulator, makeTickAccumulator } from '@tapkart/net'
import { isValidRoomCode, normalizeRoomCode } from '@tapkart/protocol'
import type { FrameClock } from './clock'
import { accumulatorAlpha } from './clock'
import type { ControlAdapter, ControlInputs, Viewport } from './controls/types'
import { createControlInputs } from './controls/types'
import type { ControlConfig } from './controls/config'
import { DEFAULT_CONTROL_CONFIG } from './controls/config'
import { makeControlAdapter } from './controls/index'
import { attachInputSource, requestTiltPermission } from './controls/source'
import { createSoloTransport } from './localinput'
import { buildResultRows } from './results'
import type { KeyValueStore, Settings } from './settings'
import { loadSettings, saveSettings } from './settings'
import type { RaceSession } from './session'
import { createSession } from './session'
import type { ViewBuilder } from './view'
import { createViewBuilder } from './view'

export interface ShellOptions {
  canvas: HTMLCanvasElement
  root: HTMLElement // where HUD/screen DOM is mounted
  clock: FrameClock
  store: KeyValueStore
  renderer: RendererBackend
  audio: AudioBackend // nullAudioBackend in v1 (Q26)
}

export interface GameShell {
  stop(): void
}

/** Plan 3 ships no server, no signalling and no WebRTC (§12), so this is the
 *  honest answer to Host and Join until Plan 4 lands. A lobby that spins forever
 *  is not. */
const MULTIPLAYER_MESSAGE = 'Multiplayer arrives in Plan 4 — press SOLO to race now.'

/** Events that carry a payload get a dedicated control, or are raised by the
 *  shell itself; the rest become one button each, straight off the reducer's
 *  own transition table. */
const PAYLOAD_EVENTS = new Set<AppEvent['kind']>([
  'roomCodeEntered', 'connected', 'connectFailed', 'lobbyUpdated',
  'characterChosen', 'trackChosen', 'settingsChanged', 'raceTick', 'raceFinished',
])

const BUTTON_LABELS: Readonly<Record<string, string | undefined>> = {
  hostPressed: 'HOST',
  joinPressed: 'JOIN',
  soloPressed: 'SOLO',
  raceStarting: 'START RACE',
  backToLobby: 'BACK TO LOBBY',
  quitToTitle: 'QUIT TO TITLE',
}

/**
 * PLAN 4'S E2E CONTRACT WITH THIS SHELL — ten `data-testid` values, copied
 * verbatim from `e2e/fixtures/tapkart.ts` (Plan 4 Task 24). Renaming one here
 * breaks `e2e/join-and-race.spec.ts` in another plan, and it breaks it silently
 * from this file's point of view: nothing in `packages/game` imports these.
 *
 * `data-testid` rather than a class name or a DOM path because a class is
 * styling and moves; a testid is a contract and does not. `startShell` is an
 * adapter with no vitest coverage by construction (§8.2), so this spec is the
 * only mechanical check that the model ever became a screen.
 *
 * Plan 4's spec is deliberately NOT skipped while it waits — it fails, naming
 * the missing hook — so a wrong or absent value here shows up as red in Plan 5's
 * CI job rather than as a green suite that asserts nothing.
 */
const TESTIDS = {
  hostButton: 'host-button',
  joinButton: 'join-button',
  roomCodeInput: 'room-code-input',
  roomCodeSubmit: 'room-code-submit',
  roomCodeDisplay: 'room-code',
  readyButton: 'ready-button',
  startButton: 'start-button',
  raceCanvas: 'race-canvas',
  lapCounter: 'lap-counter',
  results: 'results',
} as const

/** The three transition-table buttons Plan 4 drives by testid. Everything else
 *  in BUTTON_LABELS is unhooked, which is correct: an E2E asserts the flow it
 *  owns, not every control on the screen. */
const BUTTON_TESTIDS: Readonly<Record<string, string | undefined>> = {
  hostPressed: TESTIDS.hostButton,
  joinPressed: TESTIDS.joinButton,
  raceStarting: TESTIDS.startButton,
}

interface Race {
  session: RaceSession
  builder: ViewBuilder
  frame: RenderFrame
  cam: CameraState
  hud: HudModel
  audioModel: AudioModel
  theme: TrackTheme
  characters: readonly CharacterDescriptor[]
  karts: readonly KartDescriptor[]
  lastPhase: string
  lastFinishCount: number
  reportedFinish: boolean
}

function controlConfigFor(s: Settings): ControlConfig {
  return {
    ...DEFAULT_CONTROL_CONFIG,
    tiltCalibration: s.tiltCalibration,
    invertTilt: s.invertTilt,
  }
}

/** A stable seed from the room code, so every peer in a room simulates the same
 *  race. Plan 4's lobby `start` message carries the real one; until then a solo
 *  race is deterministic and reproducible, which is what this plan wants. */
function seedFor(roomCode: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < roomCode.length; i++) {
    h ^= roomCode.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

function countFilled(order: readonly number[]): number {
  let n = 0
  for (let i = 0; i < order.length; i++) if (order[i] !== -1) n++
  return n
}

/** requestAnimationFrame loop, in this exact order:
 *    inputSource.drain -> advanceAccumulator -> N x (adapter.sample +
 *    session.tickOnce) -> updateCamera(N ticks) -> viewBuilder.build(alpha) ->
 *    buildRenderFrame -> renderer.applyFrame -> buildHudModel -> DOM ->
 *    buildAudioModel -> audio.apply -> session.swapViews.
 *
 *  Two things it does outside that loop: it calls audio.setConfig on every
 *  Settings change and once at startup (R38 — never per frame), and it shows the
 *  rotate-your-device overlay while viewport.height > viewport.width (R40),
 *  skipping renderer.resize until the device is landscape again. */
export function startShell(opts: ShellOptions): GameShell {
  const { canvas, root, clock, store, renderer, audio } = opts

  // Plan 4's `race-canvas`. Set on the caller's canvas rather than on a wrapper:
  // the spec's comment is "the canvas startShell renders into", and a hook on a
  // div around it would pass the locator while proving nothing about the canvas.
  canvas.setAttribute('data-testid', TESTIDS.raceCanvas)

  const screenEl = document.createElement('div')
  screenEl.className = 'tk-screen'
  const hudEl = document.createElement('div')
  hudEl.className = 'tk-hud'
  const rotateEl = document.createElement('div')
  rotateEl.className = 'tk-rotate'
  rotateEl.textContent = 'Rotate your device'
  root.append(screenEl, hudEl, rotateEl)

  let settings = loadSettings(store)
  let app: AppState = createAppState(settings)
  // R38: once at startup and on every Settings change, never per frame.
  audio.setConfig({ masterGain: settings.audioVolume, enabled: settings.audioEnabled })

  const viewport: Viewport = { width: window.innerWidth, height: window.innerHeight }
  const inputSource = attachInputSource(window, viewport)
  const rawInputs: ControlInputs = createControlInputs()
  const intent: Intent = { tick: 0, steer: 0, accel: 0, brake: false, drift: false, useItem: false }
  let adapter: ControlAdapter = makeControlAdapter(settings.scheme, controlConfigFor(settings))
  const acc = makeTickAccumulator()
  // The accumulator holds no timestamp (it has one field, `residualMs`), so the
  // caller owns the previous instant and hands `advanceAccumulator` a delta.
  let lastNowMs = clock.nowMs()

  let race: Race | null = null
  let lastW = -1
  let lastH = -1
  let lastDpr = -1
  let running = true
  let rafId = 0
  /** Plan 4's `ready-button` state. Local only: AppState has no `ready` for the
   *  local player to set and no `readyPressed` event, because readiness is lobby
   *  traffic and the lobby is Plan 4's (§12). This is the flag Plan 4 replaces
   *  with the server's answer — not a shadow copy of one that already exists. */
  let localReady = false

  function startRace(st: AppState): Race {
    const loaded = loadTrack(st.trackId)
    const bundle = loadContentBundle()
    const ctx: SimContext = {
      track: loaded.track,
      query: loaded.query,
      tuning: TUNING,
      // CHARACTERS is `readonly CharacterStats[]` and SimContext.characters is
      // mutable. The copy is required by the type, not defensive.
      characters: CHARACTERS.slice(),
      isLeader: st.role !== 'guest',
    }
    const characterIdx: number[] = []
    for (let i = 0; i < MAX_KARTS; i++) characterIdx.push(st.slots[i].characterIdx)

    const session = createSession({
      role: st.role,
      ctx,
      localPlayerId: st.localPlayerId >= 0 ? st.localPlayerId : 0,
      seed: seedFor(st.roomCode),
      characterIdx,
      // Plan 3 has exactly one transport source. Plan 4 supplies the real one
      // and this is the only line that changes.
      transport: createSoloTransport(),
    })

    const kartMeshes: MeshData[] = bundle.karts.map(buildKartMesh)
    const characterMeshes: MeshData[] = bundle.characters.map(buildCharacterMesh)
    renderer.setScene(
      // AMENDMENT 1: three arguments, and `ctx` is the one built eight lines above.
      // `buildTrackScene` needs a SimContext because `itemBoxWorldPos` does, and
      // that is what makes the drawn item box and the pickup volume one object.
      buildTrackScene(ctx, loaded.theme, DEFAULT_MESH_OPTIONS),
      loaded.theme,
      kartMeshes,
      characterMeshes,
    )

    return {
      session,
      // createViewBuilder primes BOTH of the session's views, so the first
      // frame's audio delta is empty instead of "a real view minus a zeroed one".
      builder: createViewBuilder(session),
      frame: createRenderFrame(loaded.track.itemBoxes.length),
      cam: createCameraState(),
      hud: createHudModel(),
      audioModel: createAudioModel(),
      theme: loaded.theme,
      characters: bundle.characters,
      karts: bundle.karts,
      lastPhase: '',
      lastFinishCount: -1,
      reportedFinish: false,
    }
  }

  function endRace(): void {
    if (race === null) return
    race.session.close()
    race = null
    hudEl.replaceChildren()
  }

  function dispatch(ev: AppEvent): void {
    const next = reduceApp(app, ev)
    if (next === app) return // an illegal event is an identity no-op, by reference
    const prevScreen = app.screen
    app = next

    if (next.settings !== settings) {
      settings = next.settings
      saveSettings(store, settings)
      audio.setConfig({ masterGain: settings.audioVolume, enabled: settings.audioEnabled })
      adapter = makeControlAdapter(settings.scheme, controlConfigFor(settings))
      adapter.reset()
    }
    if (next.screen !== prevScreen) {
      if (next.screen === 'race') race = startRace(next)
      else endRace()
    }
    renderScreen()
  }

  // --- screen DOM ---------------------------------------------------------
  function button(label: string, onClick: () => void, testId?: string): HTMLButtonElement {
    const b = document.createElement('button')
    b.className = 'tk-btn'
    b.textContent = label
    if (testId !== undefined) b.setAttribute('data-testid', testId)
    b.addEventListener('click', onClick)
    return b
  }

  function selectScheme(scheme: Settings['scheme']): void {
    if (scheme !== 'tilt') {
      dispatch({ kind: 'settingsChanged', settings: { ...settings, scheme } })
      return
    }
    // Q22: the permission is requested on the tap that SELECTS tilt, which is
    // the unambiguous user gesture iOS requires. On denial the selection reverts
    // and the reason is shown — silent fallback is forbidden.
    void requestTiltPermission().then((granted) => {
      if (granted) dispatch({ kind: 'settingsChanged', settings: { ...settings, scheme: 'tilt' } })
      else dispatch({ kind: 'connectFailed', message: 'Motion access was denied, so tilt steering is unavailable.' })
    })
  }

  function renderScreen(): void {
    screenEl.replaceChildren()
    if (app.screen === 'race') {
      screenEl.classList.add('tk-hidden')
      return
    }
    screenEl.classList.remove('tk-hidden')

    const title = document.createElement('h1')
    title.textContent = app.screen === 'results' ? 'RESULTS' : 'TAPKART'
    screenEl.append(title)

    if (app.error !== '') {
      const err = document.createElement('p')
      err.className = 'tk-error'
      err.textContent = app.error
      screenEl.append(err)
    }
    if (app.roomCode !== '') {
      const code = document.createElement('p')
      const label = document.createElement('span')
      label.textContent = 'ROOM '
      // Plan 4 reads `textContent` off THIS element and matches it against
      // /^[0-9A-HJKMNP-TV-Z]{5}$/ — anchored. The hooked element therefore
      // carries the five characters ALONE; a `ROOM ABCDE` string on the hooked
      // node fails an assertion that has nothing to do with the room code.
      const value = document.createElement('span')
      value.setAttribute('data-testid', TESTIDS.roomCodeDisplay)
      value.textContent = app.roomCode
      code.append(label, value)
      screenEl.append(code)
    }

    const legal = SCREEN_TRANSITIONS[app.screen]

    if (legal.includes('characterChosen')) {
      const row = document.createElement('div')
      row.className = 'tk-row'
      const descriptors = loadContentBundle().characters
      for (let i = 0; i < descriptors.length; i++) {
        const idx = i
        row.append(button(descriptors[idx].name, () => dispatch({ kind: 'characterChosen', characterIdx: idx })))
      }
      screenEl.append(row)
    }

    if (legal.includes('trackChosen')) {
      const sel = document.createElement('select')
      for (const entry of TRACK_MANIFEST) {
        const o = document.createElement('option')
        o.value = entry.id
        o.textContent = entry.name
        if (entry.id === app.trackId) o.selected = true
        sel.append(o)
      }
      sel.addEventListener('change', () => dispatch({ kind: 'trackChosen', trackId: sel.value }))
      screenEl.append(sel)
    }

    if (legal.includes('roomCodeEntered')) {
      const input = document.createElement('input')
      input.placeholder = 'ROOM CODE'
      input.maxLength = 8
      input.setAttribute('data-testid', TESTIDS.roomCodeInput)
      const go = button(
        'GO',
        () => {
          const code = normalizeRoomCode(input.value)
          if (isValidRoomCode(code)) dispatch({ kind: 'roomCodeEntered', code })
        },
        TESTIDS.roomCodeSubmit,
      )
      screenEl.append(input, go)
    }

    if (legal.includes('settingsChanged')) {
      const row = document.createElement('div')
      row.className = 'tk-row'
      for (const scheme of ['thumbZones', 'tilt', 'virtualStick'] as const) {
        const b = button(scheme, () => selectScheme(scheme))
        if (settings.scheme === scheme) b.classList.add('tk-on')
        row.append(b)
      }
      row.append(
        button(settings.audioEnabled ? 'AUDIO ON' : 'AUDIO OFF', () =>
          dispatch({ kind: 'settingsChanged', settings: { ...settings, audioEnabled: !settings.audioEnabled } }),
        ),
      )
      screenEl.append(row)
    }

    if (app.screen === 'results') {
      // Plan 4 waits on this element to become visible to decide the race
      // finished, so it exists on the results screen and ONLY there.
      const panel = document.createElement('div')
      panel.setAttribute('data-testid', TESTIDS.results)
      const list = document.createElement('ol')
      for (const r of app.results) {
        const li = document.createElement('li')
        li.textContent = `${r.place}. ${r.name}${r.dnf ? ' — DNF' : ''}`
        list.append(li)
      }
      panel.append(list)
      screenEl.append(panel)
    }

    if (app.screen === 'lobby') {
      // Plan 4's `ready-button`. Plan 3 has no lobby traffic (§12) and no
      // `readyPressed` AppEvent, so this toggles a local flag and nothing more —
      // Plan 4 wires it to the server. The hook is still this plan's obligation:
      // what the E2E asserts is that the control is on the lobby screen.
      const ready = button(
        localReady ? 'READY ✓' : 'READY',
        () => {
          localReady = !localReady
          renderScreen()
        },
        TESTIDS.readyButton,
      )
      screenEl.append(ready)
    }

    const actions = document.createElement('div')
    actions.className = 'tk-row'
    for (const kind of legal) {
      if (PAYLOAD_EVENTS.has(kind)) continue
      const label = BUTTON_LABELS[kind] ?? kind
      actions.append(
        button(
          label,
          () => {
            dispatch({ kind } as AppEvent)
            if (kind === 'hostPressed' || kind === 'joinPressed') {
              dispatch({ kind: 'connectFailed', message: MULTIPLAYER_MESSAGE })
            }
          },
          // `start-button` rides on `raceStarting`, which SCREEN_TRANSITIONS
          // only allows on the lobby screen — so Plan 4's `toHaveCount(0)`
          // assertion for a guest is satisfied by the reducer's own table once
          // Plan 4 makes the event host-only, not by a second rule here.
          BUTTON_TESTIDS[kind],
        ),
      )
    }
    screenEl.append(actions)
  }

  // --- HUD DOM ------------------------------------------------------------
  const hudPlace = document.createElement('div')
  const hudLap = document.createElement('div')
  // Plan 4's `lap-counter`, matched against /[1-3]\s*\/\s*3/ — unanchored, so
  // the `LAP ` prefix below is fine, but the "n/3" pair must stay on THIS node.
  hudLap.setAttribute('data-testid', TESTIDS.lapCounter)
  const hudSpeed = document.createElement('div')
  const hudClock = document.createElement('div')
  const hudItem = document.createElement('div')
  const hudCountdown = document.createElement('div')
  hudCountdown.className = 'tk-countdown'

  function paintHud(hud: HudModel): void {
    if (hudEl.childElementCount === 0) {
      hudEl.append(hudPlace, hudLap, hudSpeed, hudClock, hudItem, hudCountdown)
    }
    hudEl.classList.toggle('tk-hidden', !hud.visible)
    hudPlace.textContent = `${hud.place}/${hud.fieldSize}`
    hudLap.textContent = `LAP ${hud.lap}/${hud.totalLaps}`
    hudSpeed.textContent = `${hud.speedKph} KM/H`
    hudClock.textContent = hud.raceClock
    hudItem.textContent = hud.itemReady ? hud.item.toUpperCase() : ''
    hudCountdown.textContent = hud.countdownLabel
  }

  function cameraModeFor(view: RaceView): CameraMode {
    if (view.phase === 'countdown') return 'countdown'
    if (view.phase === 'finished') return 'results'
    return 'chase'
  }

  // --- the frame ----------------------------------------------------------
  function frame(): void {
    if (!running) return
    rafId = requestAnimationFrame(frame)

    viewport.width = canvas.clientWidth > 0 ? canvas.clientWidth : window.innerWidth
    viewport.height = canvas.clientHeight > 0 ? canvas.clientHeight : window.innerHeight
    // R40: landscape only. Q24's layout — 88 px buttons on fixed insets, left
    // half steering — has no portrait meaning, so portrait is not a state to lay
    // out for. The canvas is not resized until the device is landscape again.
    const portrait = viewport.height > viewport.width
    rotateEl.classList.toggle('tk-hidden', !portrait)
    if (!portrait) {
      const dpr = window.devicePixelRatio
      if (viewport.width !== lastW || viewport.height !== lastH || dpr !== lastDpr) {
        lastW = viewport.width
        lastH = viewport.height
        lastDpr = dpr
        renderer.resize(viewport.width, viewport.height, dpr)
      }
    }

    inputSource.drain(rawInputs)
    const nowMs = clock.nowMs()
    const ticks = advanceAccumulator(acc, nowMs - lastNowMs)
    lastNowMs = nowMs
    const r = race
    if (r === null) return

    for (let i = 0; i < ticks; i++) {
      adapter.sample(rawInputs, r.session.state().tick + 1, intent)
      r.session.tickOnce(intent)
    }

    const alpha = accumulatorAlpha(acc)
    // The camera is advanced BEFORE the view is rebuilt, against the newest view
    // there is — the one the previous frame wrote, which is prevView() until
    // this frame swaps. Smoothing is per TICK, so `ticks` is what it takes.
    const newest = r.session.prevView()
    const localId = newest.localPlayerId >= 0 ? newest.localPlayerId : 0
    updateCamera(r.cam, newest.karts[localId], DEFAULT_CAMERA_PARAMS, cameraModeFor(newest), ticks)

    const view = r.session.currentView()
    r.builder.build(alpha, view)
    buildRenderFrame(view, r.cam, r.theme, r.characters, r.karts, r.frame)
    renderer.applyFrame(r.frame)
    buildHudModel(view, RACE_LAPS, r.hud)
    paintHud(r.hud)
    buildAudioModel(r.session.prevView(), view, r.audioModel)
    audio.apply(r.audioModel)
    // AFTER audio.apply, never before: the cues raised by this frame's delta are
    // consumed above, and swapping any earlier drops them. Not swapping at all
    // (one shared view) makes every delta empty and no one-shot cue can fire.
    r.session.swapViews()

    const finishCount = countFilled(view.finishedOrder)
    if (view.phase !== r.lastPhase || finishCount !== r.lastFinishCount) {
      r.lastPhase = view.phase
      r.lastFinishCount = finishCount
      dispatch({ kind: 'raceTick', phase: view.phase, finishedOrder: view.finishedOrder })
    }
    if (view.phase === 'finished' && !r.reportedFinish) {
      r.reportedFinish = true
      dispatch({ kind: 'raceFinished', results: buildResultRows(view, app.slots) })
    }
  }

  renderScreen()
  rafId = requestAnimationFrame(frame)

  return {
    stop(): void {
      running = false
      cancelAnimationFrame(rafId)
      inputSource.detach()
      endRace()
      renderer.dispose()
      audio.close()
      screenEl.remove()
      hudEl.remove()
      rotateEl.remove()
    },
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/game/test/barrel.test.ts`
Expected: **2 passing**.

Then run the whole game suite and the typecheck, which is the only verification
`shell.ts` gets in CI:

```bash
npx vitest run packages/game
npx tsc --noEmit -p packages/game/tsconfig.json
```

Expected: the game suite passes and `tsc` prints nothing — **including the app
module's `TS2307`**, which the results task cleared several tasks ago. If it is back,
`src/results.ts` was deleted or never landed.

Then verify Plan 4's ten hooks are present and spelled exactly right — *added
2026-08-14*, because this is the one obligation in this task that no test in this
repository can currently detect, and the plan that CAN detect it does not run
until Plan 5's CI job:

```bash
for id in host-button join-button room-code-input room-code-submit room-code \
          ready-button start-button race-canvas lap-counter results; do
  grep -q "'$id'" packages/game/src/shell.ts || echo "MISSING data-testid: $id"
done
```

Expected: **no output**. Any line printed is a hook `e2e/join-and-race.spec.ts`
will time out on, with the failure attributed to Plan 4.

`shell.ts` is an adapter (§8.2) and CI never imports it — the barrel test above is
what proves that stays true. It is exercised for real by the `apps/web` task, in a
browser, by a human.

**What each test catches, and whether it would actually fail under that bug:**

| Test | Bug | Fails? |
|---|---|---|
| barrel collisions | two modules exporting one name, which `export *` silently resolves to neither | yes |
| barrel completeness | a module missing from the barrel — the state this task starts in, with `./clock` alone | yes — every key of all twelve modules is asserted to reach `@tapkart/game` |
| barrel omits the adapters | re-exporting `shell` or `controls/source`, which drags DOM listeners into every headless test in the repository | yes |
| barrel omits the sub-adapters | re-exporting `makeThumbZonesAdapter` and friends, which reach the outside world only through `makeControlAdapter` | yes |

- [ ] **Step 5: Commit**

```bash
git add packages/game/src/shell.ts packages/game/src/index.ts \
        packages/game/test/barrel.test.ts && \
git commit -m "feat(game): the shell adapter and the package barrel"
```

---

### Task 25: `apps/web` — the shell a human can open — and the golden `RenderFrame` fixture

**Files:**
- Verify (do **not** modify): root `package.json`, key `workspaces` — it must already contain `"apps/*"` (R36). **The repo-plumbing task owns this file and made that edit**, and its `scaffold.test.ts` is the standing regression guard for it; a second identical edit here stages nothing and reads as a mistake to whoever runs it. (No line range is cited: after that task's edit the array has moved, and a line number into a file an earlier task modified is a guess.)
- Verify (do **not** modify): root `vitest.config.ts`, key `test.include` — it must already contain `'apps/*/test/**/*.test.ts'` (R37). Same owner, same reason.
- Modify: `package-lock.json` — `npm install` side effect (Step 2), declared because five tasks in this plan rewrite it
- Create: `apps/web/package.json`
- Create: `apps/web/tsconfig.json`
- Create: `apps/web/vite.config.ts`
- Create: `apps/web/index.html`
- Create: `apps/web/src/main.ts`
- Create: `packages/render/test/fixtures/golden-frame.ts`
- Create: `packages/render/test/fixtures/golden-frame.txt` (generated in Step 5, never hand-written)
- Test: `packages/game/test/golden-frame.test.ts`

**Interfaces:**

- Consumes, from `@tapkart/game` (the session, view and barrel tasks, via the barrel):
  ```ts
  export const realFrameClock: FrameClock
  export function createSession(opts: SessionOptions): RaceSession
  export function createSoloTransport(): LocalInputTransport
  export function createViewBuilder(session: RaceSession): ViewBuilder
  // AMENDMENT 3 — the golden test drives the double buffer itself, in the shell's
  // own order, so it names all three members rather than only createViewBuilder.
  export interface RaceSession {
    currentView(): RaceView
    prevView(): RaceView
    swapViews(): void
  }
  ```
- Consumes, from `@tapkart/game/shell` (Task 24 — the second `exports` entry, §10):
  ```ts
  export interface ShellOptions { canvas: HTMLCanvasElement; root: HTMLElement
    clock: FrameClock; store: KeyValueStore; renderer: RendererBackend; audio: AudioBackend }
  export interface GameShell { stop(): void }
  export function startShell(opts: ShellOptions): GameShell
  ```
- Consumes, from `@tapkart/render`:
  ```ts
  export const nullAudioBackend: AudioBackend
  export interface RenderFrame { camera: CameraState; karts: KartDraw[]; entities: EntityDraw[]
    entityCount: number; itemBoxAlpha: Float32Array; screenFlash: number
    screenTintColor: PaletteRGB; screenTintAmount: number; sourceTick: number }
  export interface KartDraw { playerId: number; characterIdx: number; visible: boolean
    position: Vec3; heading: number; roll: number; wheelSpin: number; steerAngle: number
    bodyTint: PaletteRGB; alpha: number; driftSparkTier: number; boostFlame: number
    shieldVisible: boolean }
  export interface EntityDraw { entityId: number; kind: EntityKind; visible: boolean
    position: Vec3; heading: number; scale: number; tint: PaletteRGB; alpha: number }
  export interface CameraState { position: Vec3; lookAt: Vec3; up: Vec3; fovDegrees: number; mode: CameraMode }
  export interface HudModel { visible: boolean; place: number; fieldSize: number; lap: number
    totalLaps: number; speedKph: number; item: ItemKind; itemReady: boolean; driftTier: number
    countdownLabel: CountdownLabel; raceClock: string; respawning: boolean; spunOut: boolean
    motionLocked: boolean; standings: HudStanding[] }
  export function createRenderFrame(itemBoxCount: number): RenderFrame
  export function buildRenderFrame(view: RaceView, cam: CameraState, theme: TrackTheme,
                                   characters: readonly CharacterDescriptor[],
                                   karts: readonly KartDescriptor[], out: RenderFrame): void
  export function createCameraState(): CameraState
  export function updateCamera(cam: CameraState, target: KartView, params: CameraParams,
                               mode: CameraMode, ticks: number): void
  export const DEFAULT_CAMERA_PARAMS: Readonly<CameraParams>
  export function createHudModel(): HudModel
  export function buildHudModel(view: RaceView, totalLaps: number, out: HudModel): void
  ```
- Consumes, from `@tapkart/render/three` (the adapter's own entry point, §10):
  ```ts
  export interface ThreeRendererOptions { antialias: boolean; maxPixelRatio: number; shadows: boolean }
  export const DEFAULT_THREE_OPTIONS: Readonly<ThreeRendererOptions>
  export function createThreeRenderer(canvas: HTMLCanvasElement, opts: ThreeRendererOptions): RendererBackend
  ```
- Consumes, from `@tapkart/content`: `TUNING`, `CHARACTERS`, `loadTrack`, `loadContentBundle`.
  **`CHARACTERS` is `readonly CharacterStats[]` and does not assign to
  `SimContext.characters: CharacterStats[]` — write `CHARACTERS.slice()`.**
- Consumes, from `@tapkart/sim`: `COUNTDOWN_TICKS`, `RACE_LAPS`, `resetBotHold`,
  `spawnEntity(state, kind, ownerId, position, heading, targetId, ttl, events): number`.

- Produces:
  ```ts
  // packages/render/test/fixtures/golden-frame.ts   (test-only; not a package export)
  export function serializeDerivedFrame(frame: RenderFrame, hud: HudModel): string
  export const GOLDEN_FRAME_FILE = 'packages/render/test/fixtures/golden-frame.txt'
  ```
  `apps/web` exports nothing: `src/main.ts` is an entry module, not a library.

**Two things this task decides, and why**

- **Q11: `apps/web` is Plan 3's, but only the thin shell.** A plan that ships
  three libraries and an exported `startShell` nobody calls has not produced
  working, testable software, which is the bar the plan structure exists to meet.
  Plan 3 must end with something a human can open in a browser and play.
  **Deferred to Plan 5:** PWA manifest, service worker, offline caching,
  Dockerfile, CI publish. Those are deploy concerns and travel with the deploy
  plan. Do not add them here.
- **The golden fixture covers only what is derived from simulation state**, and
  it lands last on purpose. Covered: kart transforms, entity transforms, camera
  pose, HUD numeric values, item-box alphas. **Not covered:** `bodyTint` and
  every palette, entity `tint` and `alpha`, `screenFlash`, `screenTintColor`,
  `screenTintAmount`, marker spacing, bloom, fog and every theme number. Placing
  it in the final task freezes the visual constants *after* they are tuned, which
  is the only ordering in which it is a net rather than a nuisance.

**Where the two golden files live, and why they are split**

The fixture is at the contract-pinned path, `packages/render/test/fixtures/`, and
imports nothing but `render`'s own types. The **test** lives in
`packages/game/test/`, because it drives a real `RaceSession` and `ViewBuilder`
and `packages/render` must not depend on `@tapkart/game` — that arrow is
backwards and §1 keeps it out on purpose. A game test reaching a render fixture
by relative path is the test-to-test cross-boundary reach §2.6 already permits.

---

- [ ] **Step 1: Create the workspace and the app (no meaningful failing test — verification is stated instead)**

A Vite config, an HTML file and a workspace manifest have no RED. Each has a
concrete check, given with its expected output.

**First, verify the two root files — do not edit them.** The repo-plumbing task
owns both and already made these edits; its `scaffold.test.ts` asserts them on
every run, and `apps/web` could not resolve `@tapkart/game` by bare specifier
without them, so if they were missing nothing in this plan would have compiled
since. Verify with:

```bash
node -e "const v=require('./package.json').workspaces; if (!Array.isArray(v) || !v.includes('apps/*')) throw new Error('workspaces is missing apps/*: ' + JSON.stringify(v)); console.log('WORKSPACES_OK')"
grep -c "apps/\*/test/\*\*/\*\.test\.ts" vitest.config.ts
```

Expect `WORKSPACES_OK` and `1`. If either check fails, **stop**: the first task of
this plan did not land, and the fix belongs there, not here. Do not add the entry
by hand — that task's test is what keeps it true, and a second writer of one file
is how the two drift.

`environment: 'node'`, `globals: false` and `reporters: ['default']` stay exactly
as they are (Q30). `apps/web` ships no test in Plan 3; the glob is already there
so Plan 5 does not have to touch the root config to add one.

Create `apps/web/package.json`:

```json
{
  "name": "@tapkart/web",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "dependencies": {
    "@tapkart/game": "*",
    "@tapkart/render": "*"
  },
  "devDependencies": {
    "vite": "^7.0.0"
  },
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "typecheck": "tsc --noEmit -p tsconfig.json"
  }
}
```

Create `apps/web/tsconfig.json`:

```jsonc
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "lib": ["ES2022", "DOM", "DOM.Iterable"] },
  "include": ["src/**/*.ts", "vite.config.ts"]
}
```

Create `apps/web/vite.config.ts`:

```ts
import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    port: 5173,
    // content/ lives at the repo root, OUTSIDE this Vite root, and
    // packages/content's static JSON imports reach it. Without this the dev
    // server refuses to serve them and every track fails to load.
    fs: { allow: ['../..'] },
  },
})
```

Create `apps/web/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta
      name="viewport"
      content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover"
    />
    <title>Tapkart</title>
    <style>
      :root { color-scheme: dark; }
      * { box-sizing: border-box; }
      html, body {
        margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden;
        background: #0b0d12; color: #e8ecf5;
        font: 500 16px/1.3 system-ui, -apple-system, "Segoe UI", sans-serif;
        /* Without this the browser claims every touchmove for scrolling and
           steering stops working the moment a thumb moves. */
        touch-action: none;
        -webkit-user-select: none; user-select: none;
        -webkit-tap-highlight-color: transparent;
      }
      #tk-canvas { position: fixed; inset: 0; width: 100%; height: 100%; display: block; }
      #tk-root { position: fixed; inset: 0; pointer-events: none; }
      #tk-root > * { pointer-events: auto; }
      .tk-hidden { display: none !important; }
      .tk-screen {
        position: absolute; inset: 0; display: flex; flex-direction: column;
        align-items: center; justify-content: center; gap: 16px;
        background: rgba(11, 13, 18, 0.82); text-align: center; padding: 24px;
      }
      .tk-screen h1 { margin: 0; font-size: 40px; letter-spacing: 0.18em; }
      .tk-row { display: flex; flex-wrap: wrap; gap: 12px; justify-content: center; }
      .tk-btn {
        min-width: 120px; min-height: 56px; padding: 0 20px;
        border: 1px solid #47506a; border-radius: 12px;
        background: #171b25; color: inherit; font: inherit; letter-spacing: 0.08em;
      }
      .tk-btn.tk-on { background: #2b6cff; border-color: #2b6cff; }
      .tk-error { color: #ff8a8a; max-width: 32ch; }
      .tk-screen select, .tk-screen input {
        min-height: 48px; padding: 0 12px; border-radius: 10px;
        border: 1px solid #47506a; background: #171b25; color: inherit; font: inherit;
      }
      .tk-screen ol { text-align: left; font-size: 20px; line-height: 1.8; }
      .tk-hud {
        position: absolute; top: 16px; left: 16px; display: flex; flex-direction: column;
        gap: 4px; font-variant-numeric: tabular-nums; text-shadow: 0 2px 6px #000;
      }
      .tk-hud .tk-countdown {
        position: fixed; inset: 0; display: flex; align-items: center; justify-content: center;
        font-size: 22vmin; font-weight: 700; letter-spacing: 0.05em; pointer-events: none;
      }
      .tk-rotate {
        position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
        background: #0b0d12; font-size: 24px; letter-spacing: 0.1em;
      }
    </style>
  </head>
  <body>
    <canvas id="tk-canvas"></canvas>
    <div id="tk-root"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

Create `apps/web/src/main.ts`:

```ts
// The entry module. It calls startShell and nothing else — every decision lives
// behind that call, in packages/game.
import { realFrameClock } from '@tapkart/game'
import { startShell } from '@tapkart/game/shell'
import { nullAudioBackend } from '@tapkart/render'
import { DEFAULT_THREE_OPTIONS, createThreeRenderer } from '@tapkart/render/three'

const canvas = document.getElementById('tk-canvas')
const root = document.getElementById('tk-root')
if (!(canvas instanceof HTMLCanvasElement)) throw new Error('main: #tk-canvas is missing from index.html')
if (!(root instanceof HTMLElement)) throw new Error('main: #tk-root is missing from index.html')

// localStorage throws outright in some privacy modes, so both halves are
// guarded. Losing settings is a worse-but-playable game; a thrown exception here
// is a black screen.
const store = {
  get(key: string): string | null {
    try {
      return window.localStorage.getItem(key)
    } catch {
      return null
    }
  },
  set(key: string, value: string): void {
    try {
      window.localStorage.setItem(key, value)
    } catch {
      // Storage denied: the session still plays, it just does not persist.
    }
  },
}

const shell = startShell({
  canvas,
  root,
  clock: realFrameClock,
  store,
  renderer: createThreeRenderer(canvas, DEFAULT_THREE_OPTIONS),
  audio: nullAudioBackend, // Q26: the seam is authored, Web Audio is Plan 5's
})

// `pagehide` fires on mobile Safari where `beforeunload` does not.
window.addEventListener('pagehide', () => shell.stop())
```

- [ ] **Step 2: Verify the app — the exact commands and what the operator should see**

```bash
npm install
```
Expect: it completes without an error, and `apps/web` is now a workspace. Check
it resolved:
```bash
node -e "console.log(require('node:fs').realpathSync('node_modules/@tapkart/web'))"
```
Expect: a path ending in `/tapkart/apps/web`.

```bash
npx tsc --noEmit -p apps/web/tsconfig.json
```
Expect: **no output**. If it reports `Cannot find module '@tapkart/game/shell'`,
the `exports` map in `packages/game/package.json` is missing its second entry
(§10) — fix it there, not here.

```bash
npm run build -w @tapkart/web && ls apps/web/dist apps/web/dist/assets
```
Expect: `vite build` prints a bundle summary and `dist/index.html` plus
`dist/assets/*.js` exist.

```bash
npm run dev -w @tapkart/web
```
Expect: `VITE vX.Y.Z ready in … ms` and `➜  Local:   http://localhost:5173/`.
In a second shell:
```bash
curl -sf http://localhost:5173/ | grep -c 'tk-canvas'
```
Expect: `1`.

**Operator check, in a browser, in a landscape-shaped window** — this is Q11's
bar and the only thing that proves Plan 3 shipped a game:

1. `http://localhost:5173/` shows **TAPKART** with SOLO / HOST / JOIN buttons and
   the three control-scheme buttons, one highlighted.
2. Pressing **HOST** or **JOIN** shows *"Multiplayer arrives in Plan 4 — press
   SOLO to race now."* — Plan 3 ships no server (§12).
3. Pressing **SOLO** reaches character select; pressing **START RACE** shows a
   3D track with eight karts on the grid, a **3 → 2 → 1 → GO** countdown, and a
   HUD reading `1/8`, `LAP 1/3`, `0 KM/H`, `0:00.000`.
3a. **The track sits on a coloured ground plane, not on the sky.** Look at the
   horizon and off the edge of the ribbon: there must be a large flat surface in
   the theme's own ground colour underneath and around the road, visibly distinct
   from the sky above it, extending past the road on every side. A ribbon
   floating over a flat wash of sky colour means `setScene` never built the ground
   quad — §12 makes it half the visual budget, and **CI cannot see this** (§8.3),
   so this line is its only detector. While you are looking down: the boost pads
   and the ramps must be visibly different colours from the road, and the item
   boxes must be visible **as boxes** standing on the track, disappearing when
   collected and fading back in when they respawn.
4. After GO, the arrow keys steer and accelerate, KM/H rises, the chase camera
   follows, and the lap clock runs.
5. Narrowing the window until it is taller than it is wide shows **"Rotate your
   device"** and the canvas stops resizing until it is landscape again.

Report anything that does not happen. Nothing in this step is asserted by CI —
§8.3: CI proves the `RenderFrame` is right and that the adapter was handed it; it
cannot prove Three.js drew it.

- [ ] **Step 3: Write the failing golden test**

Create `packages/game/test/golden-frame.test.ts`:

```ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AuthEvent, Intent, SimContext } from '@tapkart/sim'
import { COUNTDOWN_TICKS, RACE_LAPS, resetBotHold, spawnEntity } from '@tapkart/sim'
import { CHARACTERS, TUNING, loadContentBundle, loadTrack } from '@tapkart/content'
import type { CameraMode, RaceView } from '@tapkart/render'
import {
  DEFAULT_CAMERA_PARAMS,
  buildHudModel,
  buildRenderFrame,
  createCameraState,
  createHudModel,
  createRenderFrame,
  updateCamera,
} from '@tapkart/render'
import { createSoloTransport } from '../src/localinput'
import { createSession } from '../src/session'
import { createViewBuilder } from '../src/view'
// §2.6: test-to-test relative reach. The fixture lives under packages/render
// because that is where the contract pins it; the test lives here because it
// drives a RaceSession, and `render` may not depend on `game`.
import { GOLDEN_FRAME_FILE, serializeDerivedFrame } from '../../render/test/fixtures/golden-frame'

const TRACK_ID = 'caldera'
const SEED = 0x7a9c31
const CHARACTER_IDX = [0, 1, 2, 3, 4, 5, 6, 7]
const TICKS = COUNTDOWN_TICKS + 120
const ALPHA = 0.375
const REGEN_CMD = 'UPDATE_GOLDEN=1 npx vitest run packages/game/test/golden-frame.test.ts'

/** A scripted, purely tick-derived intent: no clock, no randomness, and it
 *  drives, brakes, drifts and fires, so the frozen frame is a moving car rather
 *  than a kart sitting on the grid. */
function intentAt(tick: number): Intent {
  return {
    tick,
    steer: Math.sin(tick / 37) * 0.8,
    accel: 1,
    brake: tick % 97 === 0,
    drift: tick % 53 < 20,
    useItem: tick % 61 === 0,
  }
}

function cameraModeFor(view: RaceView): CameraMode {
  if (view.phase === 'countdown') return 'countdown'
  if (view.phase === 'finished') return 'results'
  return 'chase'
}

/** Drives the REAL per-frame path — session, ViewBuilder, camera, frame, HUD —
 *  exactly as the shell does, minus the DOM and the GPU. */
function renderGolden(): string {
  // The 30 Hz bot hold is module-scope in packages/sim/src/phase.ts. A golden
  // that did not clear it would depend on whatever ran in this process first.
  resetBotHold()

  const loaded = loadTrack(TRACK_ID)
  const bundle = loadContentBundle()
  const ctx: SimContext = {
    track: loaded.track,
    query: loaded.query,
    tuning: TUNING,
    characters: CHARACTERS.slice(), // readonly CharacterStats[] does not assign
    isLeader: true,
  }
  const session = createSession({
    role: 'solo',
    ctx,
    localPlayerId: 0,
    seed: SEED,
    characterIdx: CHARACTER_IDX.slice(),
    transport: createSoloTransport(),
  })

  // Two entities, planted deterministically, so the EntityDraw half of the
  // fixture covers something. A bot rolling an item is not a precondition a
  // regression net may depend on. The bubble also freezes §4.7's reconstruction
  // from the owner's drawn position, which is the subtlest rule in the frame
  // builder; it needs its owner shielded or updateEntities retires it.
  const st = session.state()
  const events: AuthEvent[] = []
  const slickOwner = st.karts[4]
  spawnEntity(st, 'slick', 4,
    { x: slickOwner.position.x + 3, y: slickOwner.position.y, z: slickOwner.position.z + 3 },
    0.5, -1, 900, events)
  st.karts[2].shielded = true
  const bubbleOwner = st.karts[2]
  spawnEntity(st, 'bubble', 2,
    { x: bubbleOwner.position.x, y: bubbleOwner.position.y, z: bubbleOwner.position.z },
    0, -1, 900, events)

  const builder = createViewBuilder(session)
  const frame = createRenderFrame(loaded.track.itemBoxes.length)
  const cam = createCameraState()
  const hud = createHudModel()

  for (let t = 1; t <= TICKS; t++) {
    session.tickOnce(intentAt(t))
    const newest = session.prevView()
    updateCamera(cam, newest.karts[0], DEFAULT_CAMERA_PARAMS, cameraModeFor(newest), 1)
    const view = session.currentView()
    builder.build(t === TICKS ? ALPHA : 0, view)
    buildRenderFrame(view, cam, loaded.theme, bundle.characters, bundle.karts, frame)
    buildHudModel(view, RACE_LAPS, hud)
    if (t === TICKS) {
      session.close()
      return serializeDerivedFrame(frame, hud)
    }
    session.swapViews()
  }
  /* c8 ignore next */
  throw new Error('unreachable: TICKS must be >= 1')
}

describe('the golden RenderFrame (Q33)', () => {
  const path = resolve(process.cwd(), GOLDEN_FRAME_FILE)

  it('is byte-identical to the recorded derived-geometry subset', () => {
    expect(existsSync(dirname(path))).toBe(true) // wrong cwd: run vitest from the repo root

    const actual = renderGolden()

    if (process.env.UPDATE_GOLDEN === '1') {
      // Refuse in CI for the same reason packages/sim/test/golden-regen.test.ts
      // does: a fixture that rewrites itself on the machine that checks it is
      // not evidence about anything.
      expect(process.env.CI).not.toBe('true')
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, actual, 'utf8')
      return
    }

    expect(existsSync(path), `no golden file — regenerate with: ${REGEN_CMD}`).toBe(true)
    const expected = readFileSync(path, 'utf8')
    const a = actual.split('\n')
    const e = expected.split('\n')
    // A raw toBe on a 60-line blob reports "strings differ" and nothing useful.
    for (let i = 0; i < Math.max(a.length, e.length); i++) {
      if (a[i] !== e[i]) {
        expect(`line ${i + 1}: ${a[i] ?? '<missing>'}`).toBe(`line ${i + 1}: ${e[i] ?? '<missing>'}`)
      }
    }
    expect(a.length).toBe(e.length)
  })

  it('is deterministic: two runs in one process agree exactly', () => {
    // If this fails and the case above passes, something in the frame path reads
    // a clock, a random number, or module-scope state that survives a race.
    expect(renderGolden()).toBe(renderGolden())
  })

  it('covers something: the frozen frame has a moving kart and a live entity', () => {
    // A golden over eight invisible karts and zero entities would be
    // byte-stable forever and would detect nothing at all — which is exactly how
    // a regression net becomes decoration.
    const lines = renderGolden().split('\n')
    const kart0 = lines.find((l) => l.startsWith('kart 0 ')) ?? ''
    const entities = lines.filter((l) => l.startsWith('entity ') && l.includes('visible=true'))
    expect(kart0).toContain('visible=true')
    expect(kart0).not.toContain('wheelSpin=0.000000')
    expect(entities.length).toBeGreaterThan(0)
    expect(lines.some((l) => l.startsWith('camera '))).toBe(true)
    expect(lines.some((l) => l.startsWith('hud '))).toBe(true)
    expect(lines.some((l) => l.startsWith('itembox 0 '))).toBe(true)
  })
})
```

- [ ] **Step 4: Run the golden test to verify it fails**

Run: `npx vitest run packages/game/test/golden-frame.test.ts`

Expected: FAIL at collection with
`Error: Failed to load url ../../render/test/fixtures/golden-frame (resolved id: .../packages/render/test/fixtures/golden-frame) ... Does the file exist?`
— the fixture module does not exist yet.

- [ ] **Step 5: Write the fixture, then generate the golden file**

Create `packages/render/test/fixtures/golden-frame.ts`:

```ts
// Test-only. It imports nothing but this package's own types, which is what lets
// the game-side test drive it without inverting the dependency arrow (§1).
import type { CameraState, EntityDraw, HudModel, KartDraw, RenderFrame, Vec3 } from '../../src/index'

/** The repository-root-relative path of the recorded fixture. Resolved against
 *  process.cwd(), which vitest sets to the repo root. */
export const GOLDEN_FRAME_FILE = 'packages/render/test/fixtures/golden-frame.txt'

/** Every number in a FIELD VALUE, so two implementations cannot disagree about
 *  precision. `(-0).toFixed(6)` is '0.000000', which is what keeps a signed zero
 *  from flaking the fixture. */
function n(v: number): string {
  return v.toFixed(6)
}

/** `x,y,z`, each component through n(). */
function v(p: Vec3): string {
  return `${n(p.x)},${n(p.y)},${n(p.z)}`
}

/** Quoted, so an empty countdownLabel is `''` rather than nothing at all. */
function s(value: string): string {
  return `'${value}'`
}

/**
 * The covered subset, serialised deterministically (Q33): one line per record,
 * keys in the order below, every number via toFixed(6). Anything not listed is
 * NOT in the fixture.
 *
 * Format, stated exactly because the fixture is only worth having if two people
 * would produce the same bytes:
 *   - one record per line, lines joined by '\n', with a trailing '\n'
 *   - `<record> [<index>] <key>=<value> …`, single spaces throughout
 *   - the record's slot INDEX is a plain base-10 integer; every field VALUE that
 *     is a number goes through toFixed(6), including enum-valued integers such
 *     as driftSparkTier
 *   - booleans are `true` / `false`; strings are single-quoted
 *   - records in order: every kart slot, every entity slot, camera, hud, every
 *     item box
 *
 * COVERED (derived from simulation state): KartDraw playerId, visible, position,
 * heading, roll, wheelSpin, steerAngle, alpha, driftSparkTier, boostFlame,
 * shieldVisible; EntityDraw entityId, kind, visible, position, heading, scale;
 * the whole CameraState; HudModel place, lap, speedKph, countdownLabel,
 * raceClock; itemBoxAlpha.
 *
 * NOT COVERED (visual tuning this plan exists to tune by eye): bodyTint and
 * every palette, entity tint and alpha, screenFlash, screenTintColor,
 * screenTintAmount, marker spacing, bloom, fog, every theme number.
 */
export function serializeDerivedFrame(frame: RenderFrame, hud: HudModel): string {
  const out: string[] = []

  for (let i = 0; i < frame.karts.length; i++) {
    const k: KartDraw = frame.karts[i]
    out.push(
      `kart ${i} playerId=${n(k.playerId)} visible=${k.visible} position=${v(k.position)}` +
        ` heading=${n(k.heading)} roll=${n(k.roll)} wheelSpin=${n(k.wheelSpin)}` +
        ` steerAngle=${n(k.steerAngle)} alpha=${n(k.alpha)}` +
        ` driftSparkTier=${n(k.driftSparkTier)} boostFlame=${n(k.boostFlame)}` +
        ` shieldVisible=${k.shieldVisible}`,
    )
  }

  for (let j = 0; j < frame.entities.length; j++) {
    const e: EntityDraw = frame.entities[j]
    out.push(
      `entity ${j} entityId=${n(e.entityId)} kind=${s(e.kind)} visible=${e.visible}` +
        ` position=${v(e.position)} heading=${n(e.heading)} scale=${n(e.scale)}`,
    )
  }

  const c: CameraState = frame.camera
  out.push(
    `camera position=${v(c.position)} lookAt=${v(c.lookAt)} up=${v(c.up)}` +
      ` fovDegrees=${n(c.fovDegrees)} mode=${s(c.mode)}`,
  )

  out.push(
    `hud place=${n(hud.place)} lap=${n(hud.lap)} speedKph=${n(hud.speedKph)}` +
      ` countdownLabel=${s(hud.countdownLabel)} raceClock=${s(hud.raceClock)}`,
  )

  for (let b = 0; b < frame.itemBoxAlpha.length; b++) {
    out.push(`itembox ${b} alpha=${n(frame.itemBoxAlpha[b])}`)
  }

  return `${out.join('\n')}\n`
}
```

Now generate the recorded file — it is **never hand-written**:

```bash
UPDATE_GOLDEN=1 npx vitest run packages/game/test/golden-frame.test.ts
```

Expect: 3 passing, and `packages/render/test/fixtures/golden-frame.txt` now
exists. Inspect it before committing:

```bash
wc -l packages/render/test/fixtures/golden-frame.txt
head -3 packages/render/test/fixtures/golden-frame.txt
```

Expect: **58** lines for `caldera` — 8 karts + 32 entities + 1 camera + 1 hud + 16
item boxes, one line each, and `caldera` ships 16 boxes, and a first line of the shape
`kart 0 playerId=0.000000 visible=true position=…`. If `kart 0` reads
`visible=false` or every `entity` line reads `visible=false`, **stop**: the
fixture would be frozen over nothing, and the third test above will say so.

- [ ] **Step 6: Run everything**

```bash
npx vitest run packages/game/test/golden-frame.test.ts
npx vitest run
npx tsc --noEmit -p apps/web/tsconfig.json
npm run typecheck
```

Expected: the golden test passes without `UPDATE_GOLDEN`, the whole repository
suite is green, and both typechecks print nothing.

**What each check catches, and whether it would actually fail under that bug:**

| Check | Bug | Fails? |
|---|---|---|
| `realpathSync('node_modules/@tapkart/web')` | the root `workspaces` edit forgotten, so `apps/web` typechecks against nothing | yes — the path does not resolve |
| `tsc -p apps/web` | a missing `exports` entry, or `@tapkart/game` pulling a DOM-free package into a DOM context | yes |
| `curl … grep -c tk-canvas` | the dev server not serving, or `fs.allow` missing so a track import 403s | yes for the first; the second surfaces as a console error in the operator check |
| operator check | the whole reason Plan 3 exists: that this is a game a human can play | this is the only check that can see it (§8.3) |
| operator check, item 3a | **a missing ground plane, uncoloured pads and ramps, or undrawn item boxes** — three things the pure layer produces (`theme.ground`, baked vertex colours, `TrackScene.itemBoxes`) and only the Three.js adapter consumes | yes, and **only here**: CI never imports the adapter, so a `setScene` that silently dropped any of the three would ship a ribbon floating over the sky with invisible pickups and every test still green |
| golden byte-identity | any regression in `buildRenderFrame`, `updateCamera`, `buildHudModel`, `ViewBuilder.build` or `RaceSession` that moves a derived number | yes, with the first differing line named |
| golden determinism | a clock, a random number, or leaked module-scope state in the frame path | yes — and it is why `resetBotHold()` is called at the top of every run |
| golden covers something | **the failure mode this project keeps shipping**: a fixture frozen over eight invisible karts and zero entities, byte-stable forever, detecting nothing | yes — `visible=true`, a non-zero `wheelSpin` and at least one visible entity are asserted, so the net cannot quietly become decoration |

- [ ] **Step 7: Commit**

```bash
git add package-lock.json apps/web \
        packages/render/test/fixtures/golden-frame.ts \
        packages/render/test/fixtures/golden-frame.txt \
        packages/game/test/golden-frame.test.ts && \
git commit -m "feat(web): Vite shell a human can open, and the golden RenderFrame fixture"
```
