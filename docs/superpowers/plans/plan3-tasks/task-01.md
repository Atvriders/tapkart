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

  From `@tapkart/net` and `@tapkart/protocol`, contract §2.5's gate — **Plan 2 Tasks 15b and 15c** — and verified by Step 1 before anything else in this plan is written. This is the **whole** surface this plan reaches for: contract §2.5's **33 elements (23 named exports and 10 members/fields)**, plus amendment 4's four accumulator symbols and the six room-code symbols that retire `game/src/roomcode.ts` — **43 in all**. The gate checks every one of them, because a gate that covers two thirds of its surface lets the plan discover at the session task that this task was incomplete.

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

  export class RemoteInterpolator {
    push(kf: RemoteKeyframe): void
    sampleKart(playerId: number, nowMs: number): RemoteSample | null
    sampleEntity(entityId: number, nowMs: number): RemoteEntitySample | null
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

Contract §2.5 names the surface `@tapkart/net` and `@tapkart/protocol` must export before Plan 3's first import compiles. Counted across all of this plan's tasks that is **33 elements — 23 named exports and 10 members/fields** — plus the two amendment-4 symbols, and the gate checks **every one of them**. At the time this task was written they did **not** exist: the `plan2-net` worktree had no `packages/net/src/localinput.ts`, no `TICK_MS`, no `correctionDeltaOf`, no `sampleEntity`/`liveEntityIds`, and no `phase` on `WireSnapshot`. Building against a surface that does not exist is how a plan discovers at task 20 that task 3 was fiction, so this is a real gate and not a formality.

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

// --- named value exports (10) ---
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
const sampleKart: (playerId: number, nowMs: number) => RemoteSample | null =
  null as unknown as RemoteInterpolator['sampleKart']
const sampleEntity: (entityId: number, nowMs: number) => RemoteEntitySample | null =
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
void interpolatorCtor; void interpDelayMs; void bufferCapacity; void extrapolateCapMs
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
