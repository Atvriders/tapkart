# Tapkart Plan 1 — Simulation Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `@tapkart/sim` — a pure, headless, deterministic 60Hz kart-racing simulation with drift, items, world entities, bots, laps and placement — verifiable with no GPU, no network and no phone.

**Architecture:** One pure TypeScript package with zero runtime dependencies. `step(ctx, prev, next, inputs, events)` writes into a caller-owned buffer and is the single definition of what the game does; it will later run unchanged in three places (the host phone's authority loop, every client's prediction loop, the server's shadow authority). Tracks are data — a Catmull-Rom spline plus segment metadata — and both physics and (later) rendering read the same description, so the collision surface can never drift from what the player sees.

**Tech Stack:** TypeScript 5.9 (strict, `moduleResolution: Bundler`, `verbatimModuleSyntax`), Node 20, vitest 3, npm workspaces. No runtime dependencies in `packages/sim`.

**Spec:** [`docs/superpowers/specs/2026-08-13-tapkart-design.md`](../specs/2026-08-13-tapkart-design.md)

**Plan sequence:** This is Plan 1 of 5. Plan 2 = protocol + netcode; Plan 3 = render + game shell; Plan 4 = server, lobby, WebRTC; Plan 5 = APK, NFC/HCE, App Links, CI/deploy. Each produces working, testable software on its own.

---

## Global Constraints

Every task's requirements implicitly include this entire section. No task may rename, re-sign, or add fields to anything here. A task needing something absent must define it in its own files and say so in its `Interfaces` block.

> **Editing this plan:** this file is *assembled* from
> [`2026-08-13-tapkart-plan1-contract.md`](2026-08-13-tapkart-plan1-contract.md)
> (the authoritative contract, reproduced below) plus the per-task files in
> [`parts/`](parts/). Edit those and regenerate; do not hand-edit this file.
> Tasks cite the contract by path, so the standalone contract file is the one
> that must stay correct.

## 0. Conventions that are decided, not negotiable

These exist because an earlier draft of this plan contained two mutually
incompatible answers to each of them.

| Convention | Value |
|---|---|
| Forward vector from heading | `forward = (cos h, 0, sin h)` |
| Heading from a direction | `h = Math.atan2(dir.z, dir.x)` |
| Right vector from tangent `t` | `right = (-t.z, 0, t.x)`, normalized |
| Sign of `lateral` | positive is **right** of the direction of travel |
| Up axis | `+y` |
| Angle wrapping | every stored heading is wrapped to `(-π, π]` via `wrapAngle` |
| Import style | extensionless (`from './types'`), `moduleResolution: Bundler` |
| Type-only imports | must use `import type { ... }` (`verbatimModuleSyntax`) |
| Scalar equality in `statesEqual` | `Object.is` for **every** scalar, no exceptions |
| Dead entity slot sentinel | `entityId === -1` |
| Bot input rate | bots recompute an `Intent` only when `state.tick % 2 === 0`, reusing the previous value on odd ticks |
| Entity pool overflow | at `entityCount === MAX_ENTITIES`, a new spawn is **dropped**; existing entities are never evicted |
| Test framework | vitest, tests at `packages/sim/test/<name>.test.ts` |
| **Track parameter `s`** | **always arc-normalized `[0, 1)`** — never metres |
| Metres | reachable only by multiplying an `s`-delta by `query.totalLength()` |
| `finishedOrder` | fixed length `MAX_KARTS`, unused slots hold `-1`, never `push`ed |
| Initial `lap` | `{ lap: 0, checkpointIdx: track.checkpointS.length - 1, t: 0 }` |
| `finish` event `data` | 1-based finishing place |
| Sole writer of `spinOutTicks` | `startSpinOut` in `recovery.ts` — nothing else assigns it |
| `step()` wiring | the task that introduces a function ALSO adds its call site in `step.ts`, with its own failing test |

`s` being normalized is the single most error-prone thing in this package. A
value like `30` is not "30 metres along" — it wraps to `0.0`, silently. Every
fixture offset, ramp span, item-box position and bot lookahead is in `[0, 1)`.
A lookahead of 6 metres is written `6 / query.totalLength()`.

`step()` writes into `next`, never mutates `prev`, never allocates in the hot
path, never reads the wall clock, never calls `Math.random()`.

---

## 1. `packages/sim/src/types.ts`

Transcribed verbatim. Task 2 creates this file and no later task edits it.

```ts
export type Vec3 = { x: number; y: number; z: number }

export const TICK_HZ = 60
export const TICK_DT = 1 / 60
export const MAX_KARTS = 8
export const MAX_ENTITIES = 32
export const RACE_LAPS = 3
export const COUNTDOWN_TICKS = 180

export type Surface = 'tarmac' | 'dirt' | 'boost' | 'offtrack'
export type ItemKind =
  | 'none' | 'boost' | 'seeker' | 'bolt' | 'slick'
  | 'bubble' | 'surge' | 'blink' | 'charge'
export type EntityKind = 'seeker' | 'bolt' | 'slick' | 'bubble' | 'surge' | 'charge'
export type RacePhase = 'countdown' | 'racing' | 'finished'

export interface Intent {
  tick: number
  steer: number      // -1..1
  accel: number      // 0..1
  brake: boolean
  drift: boolean
  useItem: boolean
}

export interface DriftState { active: boolean; dir: -1 | 0 | 1; charge: number }

export interface LapProgress { lap: number; checkpointIdx: number; t: number }

export interface KartState {
  playerId: number
  characterIdx: number
  isBot: boolean
  connected: boolean
  position: Vec3
  velocity: Vec3
  heading: number
  angularVelocity: number
  drift: DriftState
  item: ItemKind
  airborne: boolean
  surface: Surface
  spinOutTicks: number
  invulnTicks: number
  boostTicks: number
  respawnTicks: number
  shielded: boolean
  lap: LapProgress
}

export interface EntityState {
  entityId: number
  kind: EntityKind
  ownerId: number
  position: Vec3
  velocity: Vec3
  heading: number
  targetId: number
  ttl: number
}

export interface ItemBoxState { boxIdx: number; respawnTicks: number }

export interface SimState {
  tick: number
  phase: RacePhase
  raceSeed: number
  rngCursor: number
  nextEventSeq: number
  finishTick: number            // -1 until the first kart finishes
  karts: KartState[]            // always length MAX_KARTS
  entities: EntityState[]       // always length MAX_ENTITIES, live ones packed at the front
  entityCount: number
  nextEntityId: number
  itemBoxes: ItemBoxState[]
  finishedOrder: number[]
}

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
  data: number         // kind-specific scalar, 0 when unused
}

export interface TrackPoint {
  position: Vec3
  width: number
  banking: number
  surface: Surface
}

export interface Track {
  id: string
  name: string
  controlPoints: TrackPoint[]
  checkpointS: number[]
  itemBoxes: { s: number; lateral: number }[]
  ramps: { sStart: number; sEnd: number; launch: number }[]
  boostPads: { s: number; lateral: number; halfWidth: number }[]
  startPositions: { s: number; lateral: number }[]
  bounds: { min: Vec3; max: Vec3 }
}

export interface CharacterStats {
  id: string
  name: string
  speed: number
  accel: number
  handling: number
  weight: number
}

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

export interface SimContext {
  track: Track
  query: TrackQuery
  tuning: Tuning
  characters: CharacterStats[]
  isLeader: boolean    // only a leader authority rolls items and advances rngCursor
}

export interface TrackProjection { s: number; lateral: number; distance: number }

export interface TrackQuery {
  sampleAt(s: number): TrackPoint
  tangentAt(s: number): Vec3
  project(p: Vec3): TrackProjection
  groundHeight(s: number, lateral: number): number
  surfaceAt(s: number, lateral: number): Surface
  isInBounds(s: number, lateral: number): boolean
  checkpointIndexAt(s: number): number
  totalLength(): number
}
```

---

## 2. Module map and exact signatures

Each function is **produced by exactly one task** and used verbatim elsewhere.

```ts
// packages/sim/src/vec3.ts                                   [Task 2]
export function v3(x: number, y: number, z: number): Vec3
export function v3add(a: Vec3, b: Vec3, out: Vec3): void
export function v3scale(a: Vec3, s: number, out: Vec3): void
export function v3len(a: Vec3): number
export function v3dot(a: Vec3, b: Vec3): number

// packages/sim/src/mathutil.ts                               [Task 2]
export function clamp(v: number, lo: number, hi: number): number
export function lerp(a: number, b: number, t: number): number
export function wrapAngle(a: number): number                  // -> (-PI, PI]

// packages/sim/src/rng.ts                                    [Task 2]
export function rngAt(seed: number, cursor: number): number   // splitmix32, [0,1)

// packages/sim/src/track.ts
export function validateTrack(track: Track): string[]            // [Task 3]
export function buildTrackQuery(track: Track): TrackQuery        // [Task 4]

// packages/sim/src/state.ts                                  [Task 5]
export function createState(ctx: SimContext, seed: number, characterIdx: number[]): SimState
export function cloneState(src: SimState, dst: SimState): void
export function statesEqual(a: SimState, b: SimState): boolean
export function emit(state: SimState, out: AuthEvent[], kind: AuthEventKind,
                     playerId: number, entityId: number, item: ItemKind, data: number): void

// packages/sim/src/step.ts                                   [Task 5, extended by 6-15]
export function step(ctx: SimContext, prev: SimState, next: SimState,
                     inputs: Intent[], events: AuthEvent[]): void

// packages/sim/src/kart.ts                                   [Task 6]
export function stepKart(ctx: SimContext, state: SimState, prevKart: KartState,
                         k: KartState, raw: Intent): void
export function targetSpeedFor(ctx: SimContext, state: SimState, k: KartState,
                               accel: number): number

// packages/sim/src/ground.ts                                 [Task 7]
export function applyAirYaw(ctx: SimContext, k: KartState, steer: number): void
export function integrateVertical(ctx: SimContext, k: KartState): void
export function applyRamps(ctx: SimContext, k: KartState, s: number): void

// packages/sim/src/drift.ts                                  [Task 8]
export function updateDrift(ctx: SimContext, k: KartState, raw: Intent): void
export function decayBoost(k: KartState): void

// packages/sim/src/recovery.ts                               [Task 9]
export function steeringLocked(k: KartState): boolean
export function surfaceSpeedFactor(k: KartState, t: Tuning): number
export function updateRecovery(ctx: SimContext, state: SimState,
                               k: KartState, events: AuthEvent[]): void

// packages/sim/src/collision.ts                              [Task 10]
export function resolveKartCollisions(ctx: SimContext, state: SimState): void

// packages/sim/src/laps.ts                                   [Task 11]
export function updateLaps(ctx: SimContext, state: SimState, k: KartState,
                           events: AuthEvent[]): void

// packages/sim/src/placement.ts                              [Task 11]
export function placementOrder(state: SimState): number[]
export function computePlacement(state: SimState, outIndexOf: Int32Array,
                                 outOrder: Int32Array): void

// packages/sim/src/entity.ts                                 [Task 12]
export function spawnEntity(state: SimState, kind: EntityKind, ownerId: number,
                            position: Vec3, heading: number, targetId: number,
                            ttl: number, events: AuthEvent[]): number   // entityId, -1 if pool full
export function despawnEntityAt(state: SimState, idx: number, events: AuthEvent[]): void
export function kartById(state: SimState, playerId: number): KartState | null
export function updateEntities(ctx: SimContext, state: SimState, events: AuthEvent[]): void
export function surgeActiveOn(state: SimState, playerId: number): boolean

// packages/sim/src/items.ts                                  [Task 13]
export function updateItemBoxes(ctx: SimContext, state: SimState, events: AuthEvent[]): void
export function rollItem(ctx: SimContext, state: SimState, placeIdx: number): ItemKind
export function useItem(ctx: SimContext, state: SimState, k: KartState,
                        events: AuthEvent[]): void

// packages/sim/src/bot.ts                                    [Task 14]
export function botIntent(ctx: SimContext, state: SimState, playerId: number): Intent

// packages/sim/src/phase.ts                                  [Task 15]
export function updatePhase(ctx: SimContext, state: SimState, events: AuthEvent[]): void
export function resolveInputs(ctx: SimContext, state: SimState,
                              inputs: Intent[], out: Intent[]): void

// packages/sim/src/index.ts                                   [Task 18]
// barrel: re-exports EVERY src module, so Plan 2's net/server/game
// can import the simulation through '@tapkart/sim'

// packages/sim/src/replay.ts                                 [Task 16]
export interface IntentSource { intentFor(state: SimState, playerId: number): Intent }
export function recordRun(ctx: SimContext, from: SimState, ticks: number,
                          src: IntentSource): { end: SimState; intents: Float64Array }
export function replayRun(ctx: SimContext, from: SimState, intents: Float64Array,
                          fromTick: number, toTick: number): SimState
```

### Where `targetSpeedFor` composes every speed modifier

This was previously spread across tasks that each assumed another would wire it
in, so it is stated once, here, and Task 6 owns it:

```
targetSpeed = tuning.maxSpeed
            * characters[k.characterIdx].speed
            * accel
            * surfaceSpeedFactor(k, tuning)              // offtrack penalty   [Task 9]
            * (surgeActiveOn(state, k.playerId) ? tuning.surgeSpeedMul : 1)   [Task 12]
            * (k.boostTicks > 0 ? tuning.boostSpeedMul : 1)                   [Task 8]
```

Tasks 8, 9 and 12 provide their factor; none of them re-derive the product.

### Canonical per-kart order inside `step()`

```
1.  resolveInputs         (phase gating, bot fill, 30Hz hold)        [Task 15]
2.  updateRecovery        (respawn / spin-out, may zero the steer)   [Task 9]
3.  updateDrift           (latch, charge, release boost)             [Task 8]
4.  stepKart              (steer, longitudinal, lateral grip)        [Task 6]
5.  applyAirYaw           (airborne steering authority)              [Task 7]
6.  integrateVertical     (gravity, ground snap, airborne flag)      [Task 7]
7.  applyRamps            (launch)                                   [Task 7]
8.  decayBoost                                                       [Task 8]
9.  updateLaps            (checkpoints, lap, finish)                 [Task 11]
```

Then once per tick, after the kart loop:
`resolveKartCollisions` → `updateEntities` → `updateItemBoxes` → `updatePhase`.

---

## 3. Test fixtures — `packages/sim/test/fixtures/track-fixtures.ts` [Task 3]

Every numeric expectation in every test depends on these exact values, so they
are fixed here and **Task 3** transcribes them. (`makeContext` is the one
exception: it needs `buildTrackQuery`, so it lands in Task 4.)

```ts
export function makeTuning(overrides?: Partial<Tuning>): Tuning
export function makeCharacters(): CharacterStats[]          // exactly 8
export function makeStraightTrack(overrides?: Partial<Track>): Track  // along +X
export function makeCircleTrack(overrides?: Partial<Track>): Track    // radius 100
export function makeOvalTrack(overrides?: Partial<Track>): Track      // golden fixture track
export function makeContext(track: Track, isLeader?: boolean): SimContext  // [Task 4] - needs buildTrackQuery; isLeader defaults true
```

Base `Tuning` values:

| Field | Value | Field | Value |
|---|---|---|---|
| `maxSpeed` | 40 | `driftMinSpeed` | 8 |
| `accelRate` | 24 | `driftTiers` | `[40, 90, 150]` |
| `brakeRate` | 48 | `driftBoosts` | `[24, 42, 66]` |
| `steerRateBase` | 2.6 | `boostSpeedMul` | 1.35 |
| `steerSpeedFalloff` | 0.55 | `surgeSpeedMul` | 0.7 |
| `gripTarmac` | 14 | `kartRadius` | 0.9 |
| `gripDirt` | 5 | `kartRestitution` | 0.4 |
| `gripDrift` | 3 | `itemBoxRespawnTicks` | 180 |
| `gravity` | 30 | `seekerSpeed` | 55 |
| `airYaw` | 0.6 | `boltSpeed` | 65 |
| `offtrackSpeedMul` | 0.55 | `entityTtl` | 600 |
| `respawnTicks` | 72 | `spinOutTicks` | 60 |
| `invulnTicks` | 90 | | |

Every entry of `driftTiers` and `driftBoosts` is even, because input is 30Hz
against a 60Hz sim and an odd threshold can fall inside a window no input can
land in. Task 8 asserts this with a test.

`makeStraightTrack` runs along **+X**, so a kart at `heading = 0` faces forward
down the track. Its tangent is `(1, 0, 0)`, so by §0's `right = (-t.z, 0, t.x)`
the right vector is `(0, 0, 1)` and **positive `lateral` is toward `+z`**.

(An earlier revision of this document asserted `-z` here. That was wrong and
contradicted §0. §0's formula is authoritative; this paragraph is derived from
it, never the reverse.)

Characters 0–7: `speed` `[1.00, 1.10, 0.92, 1.05, 0.95, 1.15, 0.88, 1.00]`,
`accel` `[1.00, 0.85, 1.15, 0.90, 1.10, 0.80, 1.20, 1.00]`,
`handling` `[1.00, 0.90, 1.10, 0.95, 1.05, 0.85, 1.15, 1.00]`,
`weight` `[1.00, 1.20, 0.85, 1.10, 0.90, 1.30, 0.80, 1.00]`.

---

### Task 1: npm-workspaces monorepo scaffold

Creates the repository skeleton every later task builds on: an npm-workspaces
root, the `@tapkart/sim` workspace, one shared strict TypeScript config that
encodes the contract's convention table, a root vitest config that discovers
tests at `packages/*/test/**/*.test.ts`, and one smoke test proving `npm test`
works from the repo root.

Nothing in this task imports from `packages/sim/src` except an empty barrel.
Task 2 fills that barrel in.

**Files:**
- Create: `package.json`
- Create: `tsconfig.base.json`
- Create: `vitest.config.ts`
- Create: `packages/sim/package.json`
- Create: `packages/sim/tsconfig.json`
- Create: `packages/sim/src/index.ts`
- Test: `packages/sim/test/scaffold.test.ts`

**Interfaces:**
- Consumes: nothing. This is the first task in the repo.
- Produces:
  - Root npm scripts `npm test` (`vitest run`), `npm run test:watch` (`vitest`),
    and `npm run typecheck` (`npm run typecheck --workspaces --if-present`).
  - Workspace `@tapkart/sim` at `packages/sim`, `"type": "module"`, exporting
    `"."` as `./src/index.ts`.
  - `packages/sim/src/index.ts` — a barrel that currently exports nothing. Task 2
    replaces its body with four `export *` lines.
  - `tsconfig.base.json` with `moduleResolution: "Bundler"`,
    `verbatimModuleSyntax: true`, `strict: true`, and
    `noUncheckedIndexedAccess: false`. Every package tsconfig extends it.
  - Test convention: vitest with `globals: false`, so every test file begins
    `import { describe, expect, it } from 'vitest'`.

**Preconditions:** Node 20 (`node -v` reports `v20.x`). The repo already exists
at the working directory root, is a git repo, and its `.gitignore` already
contains `node_modules/`, `dist/`, `.env`, and `*.local`. Do not add a
`package-lock.json` ignore rule — the lockfile is committed.

---

- [ ] **Step 1: Write the failing test**

Create `packages/sim/test/scaffold.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import * as sim from '../src/index'

describe('workspace scaffold', () => {
  it('runs a TypeScript test from the repo root', () => {
    // TICK_HZ is 60 in the contract; 60 ticks * 3 seconds of countdown = 180,
    // which is COUNTDOWN_TICKS. Plain arithmetic here — the real constants
    // arrive in Task 2. This test only proves the toolchain executes TS.
    const tickHz: number = 60
    expect(tickHz * 3).toBe(180)
  })

  it('resolves the @tapkart/sim entry point with extensionless imports', () => {
    // '../src/index' has no file extension. This asserts that
    // moduleResolution: "Bundler" plus vitest's resolver agree with the
    // contract's import-style convention.
    expect(typeof sim).toBe('object')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/sim/test/scaffold.test.ts`

Expected: FAIL. With no root `package.json` and no vitest installed, npx reports
`npm error could not determine executable to run` (or, if vitest resolves from a
global cache, it fails to collect the file with
`Error: Cannot find module '../src/index' imported from '.../packages/sim/test/scaffold.test.ts'`).

- [ ] **Step 3: Write the root workspace manifest**

Create `package.json`:

```json
{
  "name": "tapkart",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "workspaces": [
    "packages/*"
  ],
  "engines": {
    "node": ">=20.0.0"
  },
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

- [ ] **Step 4: Write the shared strict TypeScript config**

Create `tsconfig.base.json`. Every compiler option below is load-bearing; the
comments explain which contract convention each one enforces, but JSON does not
allow comments, so write the file exactly as shown without them.

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "strict": true,
    "noImplicitOverride": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noUncheckedIndexedAccess": false,
    "useDefineForClassFields": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "noEmit": true
  }
}
```

Why these exact values:

- `"moduleResolution": "Bundler"` — the contract's import-style row. It is what
  makes `from './types'` legal without a `.js` suffix.
- `"verbatimModuleSyntax": true` — the contract's type-only-import row. Type
  imports must be written `import type { Vec3 } from './types'` or the build
  fails.
- `"noUncheckedIndexedAccess": false` — **deliberately off.** `SimState.karts` is
  always length `MAX_KARTS` and `SimState.entities` is always length
  `MAX_ENTITIES`, so `state.karts[i]` is a `KartState`, not
  `KartState | undefined`. Turning this on would force a non-null assertion on
  every hot-path array read in Tasks 5–16.
- `"noEmit": true` — `packages/sim` is consumed as TypeScript source by vitest
  and by Vite. There is no `tsc` build output in Plan 1.

- [ ] **Step 5: Write the root vitest config**

Create `vitest.config.ts`:

```typescript
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

`globals: false` is intentional: every test file imports `describe`, `expect` and
`it` from `'vitest'` explicitly, so no `types` entry is needed in any tsconfig.
`environment: 'node'` because `packages/sim` has no DOM dependency.

- [ ] **Step 6: Write the sim workspace package and tsconfig**

Create `packages/sim/package.json`:

```json
{
  "name": "@tapkart/sim",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "typecheck": "tsc --noEmit -p tsconfig.json"
  }
}
```

Create `packages/sim/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

Create `packages/sim/src/index.ts`:

```typescript
// Public barrel for @tapkart/sim. Task 2 replaces this line with re-exports of
// types, vec3, mathutil and rng. The bare `export {}` keeps the file a module
// under isolatedModules while it is still empty.
export {}
```

- [ ] **Step 7: Install and run the test to verify it passes**

Run:

```bash
npm install
npx vitest run packages/sim/test/scaffold.test.ts
```

Expected: PASS — `Test Files 1 passed (1)`, `Tests 2 passed (2)`.

- [ ] **Step 8: Verify `npm test` and `npm run typecheck` work from the repo root**

Run:

```bash
npm test
npm run typecheck
```

Expected: `npm test` prints `Test Files  1 passed (1)` and
`Tests  2 passed (2)`, having discovered
`packages/sim/test/scaffold.test.ts` through the `packages/*/test/**/*.test.ts`
glob. `npm run typecheck` fans out to `@tapkart/sim` and exits 0 with no
diagnostics.

Also confirm the workspace link exists:

```bash
npm ls --depth=0
```

Expected output includes `├── @tapkart/sim@0.1.0 -> ./packages/sim`.

- [ ] **Step 9: Verify Node 20 and that the lockfile is present**

Run:

```bash
node -v
test -f package-lock.json && echo "lockfile present"
```

Expected: `v20.x.x` and `lockfile present`. If `node -v` reports anything below
v20, stop — the `engines` field and the ES2022 target both assume Node 20.

- [ ] **Step 10: Commit**

```bash
git add package.json package-lock.json tsconfig.base.json vitest.config.ts \
        packages/sim/package.json packages/sim/tsconfig.json \
        packages/sim/src/index.ts packages/sim/test/scaffold.test.ts
git commit -m "feat: npm-workspaces monorepo scaffold with strict TS and vitest

Root workspace plus the @tapkart/sim package. tsconfig.base.json encodes the
contract's convention table: moduleResolution Bundler for extensionless
imports, verbatimModuleSyntax for type-only imports, and
noUncheckedIndexedAccess deliberately off because SimState arrays are
fixed-length. Root 'npm test' runs vitest over packages/*/test/**/*.test.ts."
```

---

### Task 2: Types, vec3, mathutil and rng

The four leaf modules of `packages/sim`. They import nothing outside the package
and are imported by every task from 3 onward.

`types.ts` is transcribed **verbatim** from the locked contract. Nothing is
added, renamed, reordered or reformatted, and no later task edits it.

`vec3.ts` is out-param style: every function that produces a vector writes into a
caller-owned `out` and returns `void`. Only `v3()` allocates, and it is a setup
helper, never called from inside `step()`.

`rng.ts` exposes one function, `rngAt(seed, cursor)`. It is a **pure function of
its two arguments with no internal state** — it holds no counter, no module-level
variable, nothing. `SimState.rngCursor` is the only cursor in the system, and the
leader authority advances it. That is what lets a shadow authority or a rewind
recompute any draw from `(raceSeed, rngCursor)` alone.

**Files:**
- Create: `packages/sim/src/types.ts`
- Create: `packages/sim/src/vec3.ts`
- Create: `packages/sim/src/mathutil.ts`
- Create: `packages/sim/src/rng.ts`
- Modify: `packages/sim/src/index.ts` (replace the whole file, 3 lines -> 4 lines)
- Test: `packages/sim/test/types.test.ts`
- Test: `packages/sim/test/vec3.test.ts`
- Test: `packages/sim/test/mathutil.test.ts`
- Test: `packages/sim/test/rng.test.ts`

**Interfaces:**

- Consumes (from Task 1):
  - `npm test` at the repo root runs `vitest run` over
    `packages/*/test/**/*.test.ts`, with `globals: false`.
  - `npm run typecheck` runs `tsc --noEmit -p tsconfig.json` inside
    `packages/sim`.
  - `tsconfig.base.json` sets `moduleResolution: "Bundler"` (extensionless
    imports) and `verbatimModuleSyntax: true` (type imports must be written
    `import type`).
  - `packages/sim/src/index.ts` currently contains a comment and `export {}`.

- Produces (`packages/sim/src/types.ts`) — the whole file is transcribed verbatim in
  Step 3 below; this is the list of names it exports, so a later task can check a
  name without re-reading the file:
  - Type alias `Vec3` — `{ x: number; y: number; z: number }`
  - Constants `TICK_HZ = 60`, `TICK_DT = 1 / 60`, `MAX_KARTS = 8`,
    `MAX_ENTITIES = 32`, `RACE_LAPS = 3`, `COUNTDOWN_TICKS = 180`
  - Union types `Surface` (`'tarmac' | 'dirt' | 'boost' | 'offtrack'`), `ItemKind`
    (`'none' | 'boost' | 'seeker' | 'bolt' | 'slick' | 'bubble' | 'surge' | 'blink' | 'charge'`),
    `EntityKind` (`'seeker' | 'bolt' | 'slick' | 'bubble' | 'surge' | 'charge'`),
    `RacePhase` (`'countdown' | 'racing' | 'finished'`), `AuthEventKind`
    (`'itemGrant' | 'entitySpawn' | 'entityDespawn' | 'hit' | 'spinOut' | 'respawn' | 'lapCross' | 'finish'`)
  - Interfaces `Intent`, `DriftState`, `LapProgress`, `KartState` (18 fields — the
    count `types.test.ts` asserts), `EntityState`, `ItemBoxState`, `SimState`,
    `AuthEvent`, `TrackPoint`, `Track`, `CharacterStats`, `Tuning` (25 fields),
    `SimContext`, `TrackProjection`, `TrackQuery`

  Everything in that list except the six constants is a `type` or an `interface`, so
  downstream tasks must import it with `import type { ... }` (`verbatimModuleSyntax` is
  on). The six constants are values and are imported normally, with `import { ... }`.

- Produces (the three code modules):

```ts
// packages/sim/src/vec3.ts
export function v3(x: number, y: number, z: number): Vec3
export function v3add(a: Vec3, b: Vec3, out: Vec3): void
export function v3scale(a: Vec3, s: number, out: Vec3): void
export function v3len(a: Vec3): number
export function v3dot(a: Vec3, b: Vec3): number

// packages/sim/src/mathutil.ts
export function clamp(v: number, lo: number, hi: number): number
export function lerp(a: number, b: number, t: number): number
export function wrapAngle(a: number): number     // -> (-PI, PI]

// packages/sim/src/rng.ts
export const RNG_GOLDEN = 0x9e3779b9   // 2654435769
export const RNG_MIX1 = 0x21f0aaad     // 569420461
export const RNG_MIX2 = 0x735a2d97     // 1935289751
export function rngAt(seed: number, cursor: number): number   // [0, 1)
```

`RNG_GOLDEN`, `RNG_MIX1` and `RNG_MIX2` are the only symbols in this task that
are not named in the locked contract. They are exported solely so
`rng.test.ts` can assert them directly; nothing outside `rng.ts` and its test
uses them.

---

- [ ] **Step 1: Write the failing test for types.ts**

Create `packages/sim/test/types.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import type {
  AuthEvent,
  DriftState,
  EntityState,
  Intent,
  KartState,
  LapProgress,
  SimState,
  Vec3,
} from '../src/types'
import {
  COUNTDOWN_TICKS,
  MAX_ENTITIES,
  MAX_KARTS,
  RACE_LAPS,
  TICK_DT,
  TICK_HZ,
} from '../src/types'

describe('sim constants', () => {
  it('freezes the tick rate and its reciprocal', () => {
    expect(TICK_HZ).toBe(60)
    expect(TICK_DT).toBe(1 / 60)
    // 1/60 is not exactly representable in float64; the literal below is the
    // nearest double, and TICK_DT must be that exact double.
    expect(TICK_DT).toBe(0.016666666666666666)
    // 60 * (1/60) rounds back to exactly 1.
    expect(TICK_HZ * TICK_DT).toBe(1)
  })

  it('freezes the race shape', () => {
    expect(MAX_KARTS).toBe(8)
    expect(MAX_ENTITIES).toBe(32)
    expect(RACE_LAPS).toBe(3)
  })

  it('countdown is exactly three seconds of ticks', () => {
    expect(COUNTDOWN_TICKS).toBe(180)
    expect(COUNTDOWN_TICKS).toBe(TICK_HZ * 3) // 60 * 3 = 180
    expect(COUNTDOWN_TICKS * TICK_DT).toBe(3) // 180 / 60 = 3 seconds
  })
})

describe('type shapes compile and instantiate', () => {
  it('builds an Intent with every field the contract lists', () => {
    const intent: Intent = {
      tick: 7,
      steer: -1,
      accel: 1,
      brake: false,
      drift: true,
      useItem: false,
    }
    expect(intent.tick).toBe(7)
    expect(intent.steer).toBe(-1)
    expect(intent.accel).toBe(1)
    expect(intent.brake).toBe(false)
    expect(intent.drift).toBe(true)
    expect(intent.useItem).toBe(false)
  })

  it('builds a KartState with all 18 fields', () => {
    const position: Vec3 = { x: 0, y: 0, z: 0 }
    const velocity: Vec3 = { x: 0, y: 0, z: 0 }
    const drift: DriftState = { active: false, dir: 0, charge: 0 }
    const lap: LapProgress = { lap: 0, checkpointIdx: 0, t: 0 }
    const kart: KartState = {
      playerId: 0,
      characterIdx: 0,
      isBot: false,
      connected: true,
      position,
      velocity,
      heading: 0,
      angularVelocity: 0,
      drift,
      item: 'none',
      airborne: false,
      surface: 'tarmac',
      spinOutTicks: 0,
      invulnTicks: 0,
      boostTicks: 0,
      respawnTicks: 0,
      shielded: false,
      lap,
    }
    // 18 fields exactly. If this number changes, the WireSnapshot table in the
    // design spec is out of date, because that table is a complete projection
    // of the kart struct.
    expect(Object.keys(kart).length).toBe(18)
    expect(kart.item).toBe('none')
    expect(kart.surface).toBe('tarmac')
    expect(kart.drift.dir).toBe(0)
  })

  it('uses -1 as the dead-slot and not-applicable sentinel', () => {
    const dead: EntityState = {
      entityId: -1,
      kind: 'seeker',
      ownerId: -1,
      position: { x: 0, y: 0, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
      heading: 0,
      targetId: -1,
      ttl: 0,
    }
    expect(dead.entityId).toBe(-1)

    const ev: AuthEvent = {
      eventSeq: 0,
      tick: 0,
      kind: 'spinOut',
      playerId: 3,
      entityId: -1,
      item: 'none',
      data: 0,
    }
    expect(ev.entityId).toBe(-1)
    expect(ev.item).toBe('none')
    expect(ev.data).toBe(0)
  })

  it('uses -1 as SimState.finishTick before anyone finishes', () => {
    const partial: Pick<SimState, 'tick' | 'phase' | 'finishTick' | 'rngCursor'> = {
      tick: 0,
      phase: 'countdown',
      finishTick: -1,
      rngCursor: 0,
    }
    expect(partial.finishTick).toBe(-1)
    expect(partial.phase).toBe('countdown')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/sim/test/types.test.ts`

Expected: FAIL with
`Error: Cannot find module '../src/types' imported from '.../packages/sim/test/types.test.ts'`
and `Caused by: Error: Failed to load url ../src/types ... Does the file exist?`

- [ ] **Step 3: Write types.ts, transcribed verbatim from the contract**

Create `packages/sim/src/types.ts`. Copy this exactly — the comments and blank
lines are part of the contract text:

```typescript
export type Vec3 = { x: number; y: number; z: number }

export const TICK_HZ = 60
export const TICK_DT = 1 / 60
export const MAX_KARTS = 8
export const MAX_ENTITIES = 32
export const RACE_LAPS = 3
export const COUNTDOWN_TICKS = 180

export type Surface = 'tarmac' | 'dirt' | 'boost' | 'offtrack'
export type ItemKind =
  | 'none' | 'boost' | 'seeker' | 'bolt' | 'slick'
  | 'bubble' | 'surge' | 'blink' | 'charge'
export type EntityKind = 'seeker' | 'bolt' | 'slick' | 'bubble' | 'surge' | 'charge'
export type RacePhase = 'countdown' | 'racing' | 'finished'

export interface Intent {
  tick: number
  steer: number      // -1..1
  accel: number      // 0..1
  brake: boolean
  drift: boolean
  useItem: boolean
}

export interface DriftState { active: boolean; dir: -1 | 0 | 1; charge: number }

export interface LapProgress { lap: number; checkpointIdx: number; t: number }

export interface KartState {
  playerId: number
  characterIdx: number
  isBot: boolean
  connected: boolean
  position: Vec3
  velocity: Vec3
  heading: number
  angularVelocity: number
  drift: DriftState
  item: ItemKind
  airborne: boolean
  surface: Surface
  spinOutTicks: number
  invulnTicks: number
  boostTicks: number
  respawnTicks: number
  shielded: boolean
  lap: LapProgress
}

export interface EntityState {
  entityId: number
  kind: EntityKind
  ownerId: number
  position: Vec3
  velocity: Vec3
  heading: number
  targetId: number
  ttl: number
}

export interface ItemBoxState { boxIdx: number; respawnTicks: number }

export interface SimState {
  tick: number
  phase: RacePhase
  raceSeed: number
  rngCursor: number
  nextEventSeq: number
  finishTick: number            // -1 until the first kart finishes
  karts: KartState[]            // always length MAX_KARTS
  entities: EntityState[]       // always length MAX_ENTITIES, live ones packed at the front
  entityCount: number
  nextEntityId: number
  itemBoxes: ItemBoxState[]
  finishedOrder: number[]
}

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
  data: number         // kind-specific scalar, 0 when unused
}

export interface TrackPoint {
  position: Vec3
  width: number
  banking: number
  surface: Surface
}

export interface Track {
  id: string
  name: string
  controlPoints: TrackPoint[]
  checkpointS: number[]
  itemBoxes: { s: number; lateral: number }[]
  ramps: { sStart: number; sEnd: number; launch: number }[]
  boostPads: { s: number; lateral: number; halfWidth: number }[]
  startPositions: { s: number; lateral: number }[]
  bounds: { min: Vec3; max: Vec3 }
}

export interface CharacterStats {
  id: string
  name: string
  speed: number
  accel: number
  handling: number
  weight: number
}

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

export interface SimContext {
  track: Track
  query: TrackQuery
  tuning: Tuning
  characters: CharacterStats[]
  isLeader: boolean    // only a leader authority rolls items and advances rngCursor
}

export interface TrackProjection { s: number; lateral: number; distance: number }

export interface TrackQuery {
  sampleAt(s: number): TrackPoint
  tangentAt(s: number): Vec3
  project(p: Vec3): TrackProjection
  groundHeight(s: number, lateral: number): number
  surfaceAt(s: number, lateral: number): Surface
  isInBounds(s: number, lateral: number): boolean
  checkpointIndexAt(s: number): number
  totalLength(): number
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/sim/test/types.test.ts`

Expected: PASS — `Test Files 1 passed (1)`, `Tests 7 passed (7)`.

- [ ] **Step 5: Write the failing test for vec3.ts**

Create `packages/sim/test/vec3.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import { v3, v3add, v3dot, v3len, v3scale } from '../src/vec3'
import { wrapAngle } from '../src/mathutil'

describe('v3', () => {
  it('builds a Vec3 with exactly x, y, z', () => {
    const a = v3(1, 2, 3)
    expect(a.x).toBe(1)
    expect(a.y).toBe(2)
    expect(a.z).toBe(3)
    expect(Object.keys(a)).toEqual(['x', 'y', 'z'])
  })
})

describe('v3add', () => {
  it('writes the sum into out and leaves both inputs untouched', () => {
    const a = v3(1, 2, 3)
    const b = v3(10, 20, 30)
    const out = v3(-999, -999, -999)
    v3add(a, b, out)
    // (1+10, 2+20, 3+30)
    expect(out.x).toBe(11)
    expect(out.y).toBe(22)
    expect(out.z).toBe(33)
    expect(a.x).toBe(1); expect(a.y).toBe(2); expect(a.z).toBe(3)
    expect(b.x).toBe(10); expect(b.y).toBe(20); expect(b.z).toBe(30)
  })

  it('is correct when out aliases a', () => {
    const a = v3(1, 2, 3)
    const b = v3(0.5, -2, 100)
    v3add(a, b, a)
    // (1+0.5, 2-2, 3+100)
    expect(a.x).toBe(1.5)
    expect(a.y).toBe(0)
    expect(a.z).toBe(103)
  })

  it('is correct when out aliases b and a and b are the same object', () => {
    const a = v3(2, 4, 8)
    v3add(a, a, a)
    // (2+2, 4+4, 8+8)
    expect(a.x).toBe(4)
    expect(a.y).toBe(8)
    expect(a.z).toBe(16)
  })

  it('returns undefined (out-param style, never a fresh Vec3)', () => {
    const out = v3(0, 0, 0)
    expect(v3add(v3(1, 1, 1), v3(1, 1, 1), out)).toBeUndefined()
  })
})

describe('v3scale', () => {
  it('scales into out', () => {
    const a = v3(1, -2, 3)
    const out = v3(0, 0, 0)
    v3scale(a, -2, out)
    // (1*-2, -2*-2, 3*-2)
    expect(out.x).toBe(-2)
    expect(out.y).toBe(4)
    expect(out.z).toBe(-6)
    expect(a.x).toBe(1); expect(a.y).toBe(-2); expect(a.z).toBe(3)
  })

  it('is correct when out aliases a', () => {
    const a = v3(3, 6, 9)
    v3scale(a, 1 / 3, a)
    // 3*(1/3), 6*(1/3), 9*(1/3) are all exact in float64
    expect(a.x).toBe(1)
    expect(a.y).toBe(2)
    expect(a.z).toBe(3)
  })
})

describe('v3len', () => {
  it('is exact for pythagorean triples', () => {
    expect(v3len(v3(3, 0, 4))).toBe(5) // sqrt(9 + 0 + 16) = 5
    expect(v3len(v3(1, 2, 2))).toBe(3) // sqrt(1 + 4 + 4) = 3
    expect(v3len(v3(0, 0, 0))).toBe(0)
  })

  it('includes the y axis', () => {
    expect(v3len(v3(0, 5, 0))).toBe(5)
  })
})

describe('v3dot', () => {
  it('is the sum of componentwise products', () => {
    expect(v3dot(v3(1, 2, 3), v3(4, 5, 6))).toBe(32)   // 4 + 10 + 18
    expect(v3dot(v3(-1, 0, 2), v3(3, 7, -4))).toBe(-11) // -3 + 0 - 8
  })

  it('is zero for perpendicular axis vectors', () => {
    expect(v3dot(v3(1, 0, 0), v3(0, 0, 1))).toBe(0)
  })
})

describe('contract conventions', () => {
  it('forward = (cos h, 0, sin h) points along +x at heading 0', () => {
    const h = 0
    const forward = v3(Math.cos(h), 0, Math.sin(h))
    expect(forward.x).toBe(1)
    expect(forward.y).toBe(0)
    expect(forward.z).toBe(0)
  })

  it('forward = (cos h, 0, sin h) points along +z at heading PI/2', () => {
    const h = Math.PI / 2
    const forward = v3(Math.cos(h), 0, Math.sin(h))
    // Math.cos(Math.PI / 2) is 6.123233995736766e-17, not exactly 0.
    expect(forward.x).toBeCloseTo(0, 15)
    // Math.sin(Math.PI / 2) is exactly 1.
    expect(forward.z).toBe(1)
  })

  it('h = atan2(dir.z, dir.x) recovers PI/2 for the +z direction', () => {
    const dir = v3(0, 0, 1)
    expect(Math.atan2(dir.z, dir.x)).toBe(Math.PI / 2)
  })

  it('a kart facing -x has heading exactly PI and wrapAngle keeps it there', () => {
    const dir = v3(-1, 0, 0)
    const h = Math.atan2(dir.z, dir.x)
    expect(h).toBe(Math.PI)
    // This is why the wrap range is (-PI, PI] and not [-PI, PI).
    expect(wrapAngle(h)).toBe(Math.PI)
  })

  it('right = (-t.z, 0, t.x) is +z for a track tangent along +x', () => {
    const t = v3(1, 0, 0)
    const right = v3(-t.z, 0, t.x)
    // -t.z is -0 here, so compare with === (which treats -0 as 0) rather
    // than toBe (which uses Object.is and would reject -0).
    expect(right.x === 0).toBe(true)
    expect(right.y).toBe(0)
    expect(right.z).toBe(1)
    expect(v3len(right)).toBe(1)
  })

  it('right = (-t.z, 0, t.x) is -x for a track tangent along +z', () => {
    const t = v3(0, 0, 1)
    const right = v3(-t.z, 0, t.x)
    expect(right.x).toBe(-1)
    expect(right.y).toBe(0)
    expect(right.z).toBe(0)
    expect(v3len(right)).toBe(1)
  })
})
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run packages/sim/test/vec3.test.ts`

Expected: FAIL with
`Error: Cannot find module '../src/vec3' imported from '.../packages/sim/test/vec3.test.ts'`

- [ ] **Step 7: Write vec3.ts**

Create `packages/sim/src/vec3.ts`:

```typescript
import type { Vec3 } from './types'

/**
 * Allocates a Vec3. Setup only — never call this inside step().
 */
export function v3(x: number, y: number, z: number): Vec3 {
  return { x, y, z }
}

/**
 * out = a + b. Safe when out aliases a or b, because all three components are
 * computed before any is written.
 */
export function v3add(a: Vec3, b: Vec3, out: Vec3): void {
  const x = a.x + b.x
  const y = a.y + b.y
  const z = a.z + b.z
  out.x = x
  out.y = y
  out.z = z
}

/**
 * out = a * s. Safe when out aliases a.
 */
export function v3scale(a: Vec3, s: number, out: Vec3): void {
  const x = a.x * s
  const y = a.y * s
  const z = a.z * s
  out.x = x
  out.y = y
  out.z = z
}

export function v3len(a: Vec3): number {
  return Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z)
}

export function v3dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z
}
```

The temporaries in `v3add` and `v3scale` are what make aliasing safe. Writing
`out.x = a.x + b.x` first would corrupt the y and z reads when `out === a`.

- [ ] **Step 8: Write the failing test for mathutil.ts**

Create `packages/sim/test/mathutil.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import { clamp, lerp, wrapAngle } from '../src/mathutil'

describe('clamp', () => {
  it('clamps above hi', () => {
    expect(clamp(5, 0, 1)).toBe(1)
    expect(clamp(1.0001, -1, 1)).toBe(1)
  })

  it('clamps below lo', () => {
    expect(clamp(-3, -1, 1)).toBe(-1)
    expect(clamp(-0.0001, 0, 1)).toBe(0)
  })

  it('passes interior values through unchanged', () => {
    expect(clamp(0.25, 0, 1)).toBe(0.25)
    expect(clamp(0, -1, 1)).toBe(0)
  })

  it('returns the bound itself at the bound', () => {
    expect(clamp(1, 0, 1)).toBe(1)
    expect(clamp(0, 0, 1)).toBe(0)
  })

  it('propagates NaN rather than silently choosing a bound', () => {
    // NaN < lo and NaN > hi are both false, so NaN falls through.
    expect(Number.isNaN(clamp(NaN, 0, 1))).toBe(true)
  })
})

describe('lerp', () => {
  it('interpolates', () => {
    expect(lerp(0, 10, 0.25)).toBe(2.5)  // 0 + (10-0)*0.25
    expect(lerp(-1, 1, 0.5)).toBe(0)     // -1 + 2*0.5
  })

  it('is exact at both endpoints', () => {
    // a + (b-a)*t: at t=0 this is a exactly, at t=1 it is 2 + 6*1 = 8 exactly.
    expect(lerp(2, 8, 0)).toBe(2)
    expect(lerp(2, 8, 1)).toBe(8)
  })

  it('extrapolates outside 0..1', () => {
    expect(lerp(0, 10, 1.5)).toBe(15)
    expect(lerp(0, 10, -0.5)).toBe(-5)
  })
})

describe('wrapAngle', () => {
  it('leaves angles already inside (-PI, PI] alone', () => {
    expect(wrapAngle(0)).toBe(0)
    expect(wrapAngle(0.5)).toBe(0.5)
    expect(wrapAngle(Math.PI / 2)).toBe(Math.PI / 2)
    expect(wrapAngle(-Math.PI / 2)).toBe(-Math.PI / 2)
  })

  it('is half-open at the top: PI stays PI, -PI becomes PI', () => {
    // This is the whole point of the (-PI, PI] convention. A kart facing -x
    // has heading atan2(0, -1) === Math.PI and must not flip sign every tick.
    expect(wrapAngle(Math.PI)).toBe(Math.PI)
    // -Math.PI + 2*Math.PI is exactly Math.PI in float64.
    expect(wrapAngle(-Math.PI)).toBe(Math.PI)
  })

  it('wraps a heading just past PI to just past -PI', () => {
    // 3*PI/2 = 4.71238898038469; minus 2*PI = -1.5707963267948966 = -PI/2.
    expect(wrapAngle(3 * Math.PI / 2)).toBe(-Math.PI / 2)
    // -3*PI/2 = -4.71238898038469; plus 2*PI = 1.5707963267948966 = PI/2.
    expect(wrapAngle(-3 * Math.PI / 2)).toBe(Math.PI / 2)
  })

  it('wraps multiple turns', () => {
    expect(wrapAngle(2 * Math.PI)).toBe(0)
    // (3*Math.PI) % (2*Math.PI) is exactly Math.PI, which is in range.
    expect(wrapAngle(3 * Math.PI)).toBe(Math.PI)
    expect(wrapAngle(-3 * Math.PI)).toBe(Math.PI)
    // 5 % 2PI = 5, which is > PI, so 5 - 2PI = -1.2831853071795862.
    expect(wrapAngle(5)).toBe(5 - 2 * Math.PI)
    // 7 % 2PI = 0.7168146928204138, already in range.
    expect(wrapAngle(7)).toBe(7 - 2 * Math.PI)
  })

  it('never returns -0, because statesEqual compares with Object.is', () => {
    // (-2*Math.PI) % (2*Math.PI) is -0, and Object.is(-0, 0) is false, so a
    // stray -0 heading would read as a state divergence. The +0 at the end of
    // wrapAngle normalizes it.
    expect(Object.is(wrapAngle(-2 * Math.PI), 0)).toBe(true)
    expect(Object.is(wrapAngle(0), 0)).toBe(true)
    expect(Object.is(wrapAngle(-0), 0)).toBe(true)
  })

  it('lands in (-PI, PI] for 200001 sampled angles', () => {
    let violations = 0
    for (let i = -100000; i <= 100000; i++) {
      const w = wrapAngle(i * 0.137)
      if (!(w > -Math.PI && w <= Math.PI)) violations++
    }
    expect(violations).toBe(0)
  })

  it('is idempotent', () => {
    for (const a of [0, 5, 7, 100, -100, 1000, Math.PI, -Math.PI]) {
      expect(wrapAngle(wrapAngle(a))).toBe(wrapAngle(a))
    }
  })
})
```

- [ ] **Step 9: Run both tests to verify they fail**

Run: `npx vitest run packages/sim/test/mathutil.test.ts packages/sim/test/vec3.test.ts`

Expected: FAIL — two failed suites, with
`Error: Cannot find module '../src/mathutil' imported from '.../packages/sim/test/mathutil.test.ts'`
and the same for `../src/vec3`.

- [ ] **Step 10: Write mathutil.ts**

Create `packages/sim/src/mathutil.ts`:

```typescript
const TWO_PI = Math.PI * 2

export function clamp(v: number, lo: number, hi: number): number {
  if (v < lo) return lo
  if (v > hi) return hi
  return v
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

/**
 * Wraps an angle into the half-open range (-PI, PI].
 *
 * Upper-inclusive on purpose: a kart travelling along -x has heading
 * Math.atan2(0, -1) === Math.PI exactly, and it must stay at +PI rather than
 * oscillating between +PI and -PI on successive ticks.
 *
 * `a % TWO_PI` already lands in (-2*PI, 2*PI), so one adjustment is enough.
 * The trailing `+ 0` turns -0 into +0; without it wrapAngle(-2*PI) would be -0,
 * and statesEqual compares every scalar with Object.is, for which
 * Object.is(-0, 0) is false.
 */
export function wrapAngle(a: number): number {
  let r = a % TWO_PI
  if (r <= -Math.PI) r += TWO_PI
  else if (r > Math.PI) r -= TWO_PI
  return r + 0
}
```

- [ ] **Step 11: Run both tests to verify they pass**

Run: `npx vitest run packages/sim/test/mathutil.test.ts packages/sim/test/vec3.test.ts`

Expected: PASS — `Test Files 2 passed (2)`, `Tests 32 passed (32)` (15 in
mathutil, 17 in vec3).

- [ ] **Step 12: Write the failing test for rng.ts**

Create `packages/sim/test/rng.test.ts`. Every golden number below was produced by
running the reference splitmix32 in Node 20; the uint32 form is given so the
expectation is exact rather than a rounded decimal.

```typescript
import { describe, expect, it } from 'vitest'
import { RNG_GOLDEN, RNG_MIX1, RNG_MIX2, rngAt } from '../src/rng'

const TWO32 = 4294967296

describe('splitmix32 constants', () => {
  it('freezes the three magic numbers', () => {
    expect(RNG_GOLDEN).toBe(0x9e3779b9)
    expect(RNG_GOLDEN).toBe(2654435769)
    expect(RNG_MIX1).toBe(0x21f0aaad)
    expect(RNG_MIX1).toBe(569420461)
    expect(RNG_MIX2).toBe(0x735a2d97)
    expect(RNG_MIX2).toBe(1935289751)
  })
})

describe('rngAt golden values', () => {
  it('matches the recorded uint32 outputs divided by 2^32', () => {
    expect(rngAt(0, 0)).toBe(1684164658 / TWO32)
    expect(rngAt(0, 1)).toBe(3653269916 / TWO32)
    expect(rngAt(0, 2)).toBe(2939563536 / TWO32)
    expect(rngAt(0, 3)).toBe(2141751570 / TWO32)
    expect(rngAt(1, 0)).toBe(1580013426 / TWO32)
    expect(rngAt(12345, 0)).toBe(3283241497 / TWO32)
    expect(rngAt(12345, 1)).toBe(613117429 / TWO32)
    expect(rngAt(12345, 7)).toBe(3763538745 / TWO32)
    expect(rngAt(0xdeadbeef, 0)).toBe(46217145 / TWO32)
  })

  it('matches the recorded decimals to 15 places', () => {
    // 1684164658 / 4294967296 = 0.3921251413412392
    expect(rngAt(0, 0)).toBeCloseTo(0.3921251413412392, 15)
    // 3283241497 / 4294967296 = 0.7644392310176045
    expect(rngAt(12345, 0)).toBeCloseTo(0.7644392310176045, 15)
    // 3763538745 / 4294967296 = 0.8762671484146267
    expect(rngAt(12345, 7)).toBeCloseTo(0.8762671484146267, 15)
  })

  it('reproduces the classic stateful splitmix32 sequence', () => {
    // rngAt(seed, cursor) must equal the cursor-th output of a stateful
    // splitmix32 seeded with `seed`, which is why the implementation mixes
    // (seed + (cursor + 1) * GOLDEN) rather than (seed + cursor * GOLDEN).
    const seed = 12345
    let a = seed | 0
    const next = (): number => {
      a = (a + 0x9e3779b9) | 0
      let t = a ^ (a >>> 16)
      t = Math.imul(t, 0x21f0aaad)
      t = t ^ (t >>> 15)
      t = Math.imul(t, 0x735a2d97)
      t = t ^ (t >>> 15)
      return (t >>> 0) / TWO32
    }
    for (let cursor = 0; cursor < 8; cursor++) {
      expect(rngAt(seed, cursor)).toBe(next())
    }
  })
})

describe('rngAt purity', () => {
  it('holds no internal state: repeated calls return the same value', () => {
    const first = rngAt(777, 3)
    rngAt(999, 0)
    rngAt(777, 4)
    rngAt(0, 0)
    expect(rngAt(777, 3)).toBe(first)
    expect(rngAt(777, 3)).toBe(first)
  })

  it('is order independent: descending cursors match ascending cursors', () => {
    const ascending: number[] = []
    for (let c = 0; c < 32; c++) ascending.push(rngAt(4242, c))
    const descending: number[] = new Array<number>(32)
    for (let c = 31; c >= 0; c--) descending[c] = rngAt(4242, c)
    expect(descending).toEqual(ascending)
  })

  it('separates seeds', () => {
    expect(rngAt(1, 0)).not.toBe(rngAt(2, 0))
    expect(rngAt(1, 0)).not.toBe(rngAt(1, 1))
  })
})

describe('rngAt distribution', () => {
  it('stays inside [0, 1) over 100000 draws', () => {
    let min = 1
    let max = 0
    for (let c = 0; c < 100000; c++) {
      const v = rngAt(1337, c)
      if (v < min) min = v
      if (v > max) max = v
    }
    expect(min).toBeGreaterThanOrEqual(0)
    expect(max).toBeLessThan(1)
    // Observed over seed 1337: min 0.0000132790, max 0.9999998878.
    expect(min).toBeLessThan(0.0001)
    expect(max).toBeGreaterThan(0.9999)
  })

  it('has a mean near 0.5 and fills all ten deciles', () => {
    const buckets = new Array<number>(10).fill(0)
    let sum = 0
    for (let c = 0; c < 100000; c++) {
      const v = rngAt(1337, c)
      sum += v
      buckets[Math.floor(v * 10)]++
    }
    // Observed mean over seed 1337, 100000 draws: 0.4981690483844257.
    expect(sum / 100000).toBeGreaterThan(0.49)
    expect(sum / 100000).toBeLessThan(0.51)
    // Observed decile counts: 9988 10229 9863 10044 10046 10091 10113 9984
    // 9913 9729 — all inside 9500..10500, expected 10000.
    for (const b of buckets) {
      expect(b).toBeGreaterThan(9500)
      expect(b).toBeLessThan(10500)
    }
  })
})
```

- [ ] **Step 13: Run test to verify it fails**

Run: `npx vitest run packages/sim/test/rng.test.ts`

Expected: FAIL with
`Error: Cannot find module '../src/rng' imported from '.../packages/sim/test/rng.test.ts'`

- [ ] **Step 14: Write rng.ts**

Create `packages/sim/src/rng.ts`:

```typescript
/** splitmix32 increment: floor(2^32 / phi). */
export const RNG_GOLDEN = 0x9e3779b9

/** First avalanche multiplier. */
export const RNG_MIX1 = 0x21f0aaad

/** Second avalanche multiplier. */
export const RNG_MIX2 = 0x735a2d97

/**
 * splitmix32 as a pure function of (seed, cursor), returning a double in
 * [0, 1).
 *
 * There is no internal state here on purpose. SimState.rngCursor is the only
 * cursor in the system and only a leader authority advances it, so a shadow
 * authority, a rewind, or a replay can recompute any draw in the race from
 * (raceSeed, rngCursor) alone.
 *
 * Mixing (seed + (cursor + 1) * RNG_GOLDEN) rather than
 * (seed + cursor * RNG_GOLDEN) makes rngAt(seed, c) equal the c-th output of a
 * conventional stateful splitmix32 seeded with `seed`, which advances before it
 * mixes. Math.imul keeps every multiply in int32, and the final `>>> 0` makes
 * the division by 2^32 land in [0, 1).
 */
export function rngAt(seed: number, cursor: number): number {
  let z = (seed + Math.imul(cursor + 1, RNG_GOLDEN)) | 0
  z = Math.imul(z ^ (z >>> 16), RNG_MIX1)
  z = Math.imul(z ^ (z >>> 15), RNG_MIX2)
  z = z ^ (z >>> 15)
  return (z >>> 0) / 4294967296
}
```

- [ ] **Step 15: Run test to verify it passes**

Run: `npx vitest run packages/sim/test/rng.test.ts`

Expected: PASS — `Test Files 1 passed (1)`, `Tests 9 passed (9)`.

- [ ] **Step 16: Fill in the package barrel**

Modify `packages/sim/src/index.ts`. It currently contains exactly this:

```typescript
// Public barrel for @tapkart/sim. Task 2 replaces this line with re-exports of
// types, vec3, mathutil and rng. The bare `export {}` keeps the file a module
// under isolatedModules while it is still empty.
export {}
```

Replace the whole file with:

```typescript
export * from './types'
export * from './vec3'
export * from './mathutil'
export * from './rng'
```

`export *` re-exports types and values together and is legal under
`isolatedModules`; only a named `export { SomeType }` would need `export type`.
The scaffold test from Task 1 asserts only `typeof sim === 'object'`, so it keeps
passing.

- [ ] **Step 17: Run the whole suite and the typecheck**

Run:

```bash
npm test
npm run typecheck
```

Expected: `npm test` reports `Test Files  5 passed (5)` and
`Tests  50 passed (50)` — 2 scaffold, 7 types, 17 vec3, 15 mathutil, 9 rng.
`npm run typecheck` exits 0 with no diagnostics.

- [ ] **Step 18: Verify the barrel still resolves after the edit**

Run: `npx vitest run packages/sim/test/scaffold.test.ts`

Expected: PASS — `Tests 2 passed (2)`. That file does
`import * as sim from '../src/index'`, so it now loads all four new modules
through the barrel. If any of the four had a syntax or resolution error, this
test would fail to collect with
`Error: Cannot find module ... imported from '.../packages/sim/src/index.ts'`.

- [ ] **Step 19: Commit**

```bash
git add packages/sim/src/types.ts packages/sim/src/vec3.ts \
        packages/sim/src/mathutil.ts packages/sim/src/rng.ts \
        packages/sim/src/index.ts \
        packages/sim/test/types.test.ts packages/sim/test/vec3.test.ts \
        packages/sim/test/mathutil.test.ts packages/sim/test/rng.test.ts
git commit -m "feat(sim): types, vec3, mathutil and stateless splitmix32 rng

types.ts is the locked contract transcribed verbatim; no later task edits it.
vec3 is out-param style and aliasing-safe, so only v3() allocates. wrapAngle
returns (-PI, PI] — upper-inclusive so a kart facing -x holds heading PI — and
normalizes -0 to +0 because statesEqual compares scalars with Object.is.
rngAt(seed, cursor) is splitmix32 with no internal state, so any draw is
recomputable from (raceSeed, rngCursor); golden tests freeze the three
constants and nine recorded outputs."
```

---

### Task 3: Track Fixtures and Track Validator

This is **Task 3**, and the locked contract labels both halves of it Task 3: contract
§2 marks `validateTrack(track: Track): string[]` in `packages/sim/src/track.ts` as
`[Task 3]`, and contract §3 marks `packages/sim/test/fixtures/track-fixtures.ts` as
`[Task 3]`. The other two entries on those same lines belong to **Task 4**:
`buildTrackQuery(track: Track): TrackQuery` in the same `track.ts`, and
`makeContext(track, isLeader?)` appended to the same fixtures file. Task 3 writes the
file first; Task 4 appends to it. Neither task rewrites the other's half.

**Files:**
- Create: `packages/sim/test/fixtures/track-fixtures.ts`
- Create: `packages/sim/src/track.ts`
- Test: `packages/sim/test/track-fixtures.test.ts`
- Test: `packages/sim/test/track-validate.test.ts`

**Interfaces:**

- Consumes (from Task 2, `packages/sim/src/types.ts`):
  - `type Vec3 = { x: number; y: number; z: number }`
  - `const MAX_KARTS = 8`
  - `type Surface = 'tarmac' | 'dirt' | 'boost' | 'offtrack'`
  - `interface TrackPoint { position: Vec3; width: number; banking: number; surface: Surface }`
  - `interface Track { id: string; name: string; controlPoints: TrackPoint[]; checkpointS: number[]; itemBoxes: { s: number; lateral: number }[]; ramps: { sStart: number; sEnd: number; launch: number }[]; boostPads: { s: number; lateral: number; halfWidth: number }[]; startPositions: { s: number; lateral: number }[]; bounds: { min: Vec3; max: Vec3 } }`
  - `interface CharacterStats { id: string; name: string; speed: number; accel: number; handling: number; weight: number }`
  - `interface Tuning` — 25 fields, every one of them set by `makeTuning`, all `number`
    except the two 3-tuples: `maxSpeed`, `accelRate`, `brakeRate`, `steerRateBase`,
    `steerSpeedFalloff`, `gripTarmac`, `gripDirt`, `gripDrift`, `gravity`, `airYaw`,
    `offtrackSpeedMul`, `respawnTicks`, `invulnTicks`, `spinOutTicks`, `driftMinSpeed`,
    `driftTiers: [number, number, number]`, `driftBoosts: [number, number, number]`,
    `boostSpeedMul`, `surgeSpeedMul`, `kartRadius`, `kartRestitution`,
    `itemBoxRespawnTicks`, `seekerSpeed`, `boltSpeed`, `entityTtl`
- Consumes (from Task 2, `packages/sim/src/vec3.ts`):
  - `function v3(x: number, y: number, z: number): Vec3`
- Produces (`packages/sim/test/fixtures/track-fixtures.ts`):
  - `function makeTuning(overrides?: Partial<Tuning>): Tuning`
  - `function makeCharacters(): CharacterStats[]` — exactly 8
  - `function makeStraightTrack(overrides?: Partial<Track>): Track` — 12 control points, front straight along +X
  - `function makeCircleTrack(overrides?: Partial<Track>): Track` — 16 control points, radius 100
  - `function makeOvalTrack(overrides?: Partial<Track>): Track` — 20 control points, golden fixture track
- Produces (`packages/sim/src/track.ts`):
  - `const VALIDATION_KART_RADIUS = 0.9` — new constant, not in the contract; the validator has no `Tuning` argument, so the clearance rule needs its own copy of the base tuning's `kartRadius`
  - `function validateTrack(track: Track): string[]` — `[]` when valid

**Two sequencing notes the engineer must read before starting:**

1. `makeContext(track, isLeader?)` is **not** in this task — it is **Task 4**, appended
   to this same `track-fixtures.ts`, and contract §3 marks it `[Task 4]` for that reason.
   `SimContext.query` is a `TrackQuery`, and the only thing that can produce one is
   `buildTrackQuery`, which Task 4 writes. The reason this is a hard ordering and not a
   preference is ESM linking: `import { buildTrackQuery } from '../../src/track'` is
   resolved when the module graph is linked, *before* any test body runs, so if
   `track.ts` does not export that name yet the whole file fails to load with
   `SyntaxError: The requested module '../../src/track' does not provide an export named
   'buildTrackQuery'`. Every test in this task would then fail for the wrong reason, and
   the failure would look like a bug in the fixtures. So Task 3's `track-fixtures.ts`
   imports **only** `../../src/types` and `../../src/vec3`; Task 4 widens that import
   block when it appends `makeContext`.
2. `validateTrack` deliberately does **not** build the spline. It is a static check on
   track *data* and runs before any `TrackQuery` exists (it is what gates
   DeepSeek-generated track JSON). Where it needs a length or a width at some `s`, it
   uses the control polygon and a segment-uniform `s`, both documented below. The
   runtime `TrackQuery` in Task 4 uses true arc length; the two agree exactly on all
   three fixtures because their widths are constant across every segment a fixture
   places a start position, item box, or boost pad on.

**Contract note on the sign of `lateral`.** Section 0 of the contract fixes
`right = (-t.z, 0, t.x)` and "positive is **right** of the direction of travel". For a
kart travelling +X the tangent is `t = (1, 0, 0)`, so `right = (-0, 0, 1) = +z`.
Positive `lateral` is therefore toward **+z** on the straight fixture, which is what
contract §3 now says. (An earlier revision of the contract said `-z` there; that
revision is retracted, §0's formula is authoritative, and Task 4 asserts the resulting
sign numerically with `projectPoint(tr, table, v3(300, 0, 5), out)` → `lateral = +5`.)

**Contract note on `s`.** Every `s` in these fixtures — `checkpointS`, `itemBoxes[].s`,
`ramps[].sStart` / `.sEnd`, `boostPads[].s`, `startPositions[].s` — is **arc-normalised
into `[0, 1)`**, never metres, per contract §0. That is why `validateTrack` rejects
anything outside `0..1`, and why the start-grid separation rule below has to multiply an
`s`-delta by a length in metres before it can compare against `2 * kartRadius`.

**These fixture numbers are the contract, transcribed.** The `makeTuning` table below is
contract §3's base `Tuning` table value for value (all 25 fields), and `makeCharacters`
is contract §3's four stat rows for the 8 characters. Do not "improve" a number here: ten
other tasks derive concrete expectations from them.

---

- [ ] **Step 1: Write the failing test for the fixtures**

Create `packages/sim/test/track-fixtures.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  makeCharacters,
  makeCircleTrack,
  makeOvalTrack,
  makeStraightTrack,
  makeTuning,
} from './fixtures/track-fixtures'

describe('track fixtures', () => {
  it('makeTuning returns the locked base tuning values', () => {
    const t = makeTuning()
    expect(t.maxSpeed).toBe(40)
    expect(t.accelRate).toBe(24)
    expect(t.brakeRate).toBe(48)
    expect(t.steerRateBase).toBe(2.6)
    expect(t.steerSpeedFalloff).toBe(0.55)
    expect(t.gripTarmac).toBe(14)
    expect(t.gripDirt).toBe(5)
    expect(t.gripDrift).toBe(3)
    expect(t.gravity).toBe(30)
    expect(t.airYaw).toBe(0.6)
    expect(t.offtrackSpeedMul).toBe(0.55)
    expect(t.respawnTicks).toBe(72)
    expect(t.invulnTicks).toBe(90)
    expect(t.spinOutTicks).toBe(60)
    expect(t.driftMinSpeed).toBe(8)
    expect(t.driftTiers).toEqual([40, 90, 150])
    expect(t.driftBoosts).toEqual([24, 42, 66])
    expect(t.boostSpeedMul).toBe(1.35)
    expect(t.surgeSpeedMul).toBe(0.7)
    expect(t.kartRadius).toBe(0.9)
    expect(t.kartRestitution).toBe(0.4)
    expect(t.itemBoxRespawnTicks).toBe(180)
    expect(t.seekerSpeed).toBe(55)
    expect(t.boltSpeed).toBe(65)
    expect(t.entityTtl).toBe(600)
  })

  it('makeTuning applies overrides and leaves every other field alone', () => {
    const t = makeTuning({ maxSpeed: 10, gripTarmac: 1 })
    expect(t.maxSpeed).toBe(10)
    expect(t.gripTarmac).toBe(1)
    // untouched neighbours keep the base values
    expect(t.accelRate).toBe(24)
    expect(t.gripDirt).toBe(5)
    expect(t.entityTtl).toBe(600)
    // the base object is not mutated by an override call
    expect(makeTuning().maxSpeed).toBe(40)
  })

  it('makeCharacters returns exactly 8 rows matching the locked stat table', () => {
    const c = makeCharacters()
    expect(c).toHaveLength(8)
    expect(c.map((x) => x.speed)).toEqual([1.0, 1.1, 0.92, 1.05, 0.95, 1.15, 0.88, 1.0])
    expect(c.map((x) => x.accel)).toEqual([1.0, 0.85, 1.15, 0.9, 1.1, 0.8, 1.2, 1.0])
    expect(c.map((x) => x.handling)).toEqual([1.0, 0.9, 1.1, 0.95, 1.05, 0.85, 1.15, 1.0])
    expect(c.map((x) => x.weight)).toEqual([1.0, 1.2, 0.85, 1.1, 0.9, 1.3, 0.8, 1.0])
    expect(c.map((x) => x.id)).toEqual(['c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7'])
    expect(c[5].name).toBe('Racer 5')
  })

  it('makeStraightTrack has 12 control points with a +X front straight', () => {
    const tr = makeStraightTrack()
    expect(tr.id).toBe('straight')
    expect(tr.controlPoints).toHaveLength(12)
    // control points 0..4 are collinear along +X at z = 0, spaced 150 apart
    for (let i = 0; i <= 4; i++) {
      expect(tr.controlPoints[i].position.x).toBe(i * 150)
      expect(tr.controlPoints[i].position.y).toBe(0)
      expect(tr.controlPoints[i].position.z).toBe(0)
    }
    // the return leg sits at z = 120
    expect(tr.controlPoints[8].position).toEqual({ x: 600, y: 0, z: 120 })
    expect(tr.controlPoints[10].position).toEqual({ x: 0, y: 0, z: 120 })
    expect(tr.controlPoints[11].position).toEqual({ x: -140, y: 0, z: 60 })
    // uniform 20 m width, no banking, all tarmac
    expect(tr.controlPoints.every((p) => p.width === 20)).toBe(true)
    expect(tr.controlPoints.every((p) => p.banking === 0)).toBe(true)
    expect(tr.controlPoints.every((p) => p.surface === 'tarmac')).toBe(true)
    expect(tr.checkpointS).toEqual([0, 0.25, 0.5, 0.75])
    expect(tr.startPositions).toHaveLength(8)
    expect(tr.startPositions[0]).toEqual({ s: 0.01, lateral: -5 })
    expect(tr.startPositions[7]).toEqual({ s: 0.055, lateral: 5 })
    expect(tr.ramps).toEqual([{ sStart: 0.4, sEnd: 0.44, launch: 6 }])
    expect(tr.boostPads).toEqual([{ s: 0.6, lateral: 0, halfWidth: 3 }])
    expect(tr.bounds.min).toEqual({ x: -200, y: -20, z: -40 })
    expect(tr.bounds.max).toEqual({ x: 800, y: 40, z: 160 })
  })

  it('makeStraightTrack applies overrides', () => {
    const tr = makeStraightTrack({ checkpointS: [0.1, 0.4, 0.7], id: 'custom' })
    expect(tr.id).toBe('custom')
    expect(tr.checkpointS).toEqual([0.1, 0.4, 0.7])
    expect(tr.controlPoints).toHaveLength(12) // untouched
  })

  it('makeCircleTrack has 16 control points on a radius-100 circle', () => {
    const tr = makeCircleTrack()
    expect(tr.controlPoints).toHaveLength(16)
    // point i sits at angle i*2pi/16; point 0 is exactly (100, 0, 0)
    expect(tr.controlPoints[0].position.x).toBe(100)
    expect(tr.controlPoints[0].position.z).toBe(0)
    // point 4 is a quarter turn round: (100*cos(pi/2), 0, 100*sin(pi/2)) = (~0, 0, 100)
    expect(tr.controlPoints[4].position.x).toBeCloseTo(0, 9)
    expect(tr.controlPoints[4].position.z).toBeCloseTo(100, 9)
    for (const p of tr.controlPoints) {
      expect(Math.hypot(p.position.x, p.position.z)).toBeCloseTo(100, 9)
      expect(p.position.y).toBe(0)
      expect(p.width).toBe(20)
    }
    expect(tr.ramps).toEqual([])
    expect(tr.startPositions).toHaveLength(8)
  })

  it('makeOvalTrack has 20 control points, banked turns and a dirt sector', () => {
    const tr = makeOvalTrack()
    expect(tr.controlPoints).toHaveLength(20)
    // 0..4: bottom straight, z = -100, x from -200 to 200 in steps of 100
    expect(tr.controlPoints[0].position).toEqual({ x: -200, y: 0, z: -100 })
    expect(tr.controlPoints[4].position).toEqual({ x: 200, y: 0, z: -100 })
    // 5..9: right turn, radius 100 about (200, 0, 0); index 7 is theta = 0
    expect(tr.controlPoints[7].position.x).toBeCloseTo(300, 9)
    expect(tr.controlPoints[7].position.z).toBeCloseTo(0, 9)
    // 10..14: top straight, z = +100
    expect(tr.controlPoints[10].position).toEqual({ x: 200, y: 0, z: 100 })
    expect(tr.controlPoints[14].position).toEqual({ x: -200, y: 0, z: 100 })
    // 15..19: left turn, radius 100 about (-200, 0, 0); index 17 is theta = 180
    expect(tr.controlPoints[17].position.x).toBeCloseTo(-300, 9)
    expect(tr.controlPoints[17].position.z).toBeCloseTo(0, 9)
    // straights are 24 m wide and flat, turns are 20 m wide and banked 0.2 rad
    expect(tr.controlPoints[2].width).toBe(24)
    expect(tr.controlPoints[2].banking).toBe(0)
    expect(tr.controlPoints[7].width).toBe(20)
    expect(tr.controlPoints[7].banking).toBe(0.2)
    expect(tr.controlPoints[17].banking).toBe(0.2)
    // exactly two dirt control points, 12 and 13, so segments 12 and 13 are dirt
    expect(tr.controlPoints.map((p) => p.surface).filter((s) => s === 'dirt')).toHaveLength(2)
    expect(tr.controlPoints[12].surface).toBe('dirt')
    expect(tr.controlPoints[13].surface).toBe('dirt')
    expect(tr.controlPoints[11].surface).toBe('tarmac')
    expect(tr.controlPoints[14].surface).toBe('tarmac')
    expect(tr.checkpointS).toEqual([0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875])
    expect(tr.itemBoxes).toHaveLength(6)
    expect(tr.boostPads).toEqual([{ s: 0.1, lateral: 0, halfWidth: 4 }])
    expect(tr.ramps).toEqual([{ sStart: 0.55, sEnd: 0.58, launch: 7 }])
  })
})
```

- [ ] **Step 2: Run the fixture test to verify it fails**

Run: `npx vitest run packages/sim/test/track-fixtures.test.ts`

Expected: FAIL — `Failed to resolve import "./fixtures/track-fixtures" from "packages/sim/test/track-fixtures.test.ts". Does the file exist?`

- [ ] **Step 3: Write the fixtures file**

Create `packages/sim/test/fixtures/track-fixtures.ts`:

```ts
import type { CharacterStats, Surface, Track, TrackPoint, Tuning } from '../../src/types'
import { v3 } from '../../src/vec3'

function cp(
  x: number,
  y: number,
  z: number,
  width: number,
  banking: number,
  surface: Surface,
): TrackPoint {
  return { position: v3(x, y, z), width, banking, surface }
}

/** Base tuning table. Every numeric expectation in the sim tests derives from these. */
export function makeTuning(overrides?: Partial<Tuning>): Tuning {
  return {
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
    ...overrides,
  }
}

/** Exactly 8 characters, stats transcribed from the locked contract. */
export function makeCharacters(): CharacterStats[] {
  const speed = [1.0, 1.1, 0.92, 1.05, 0.95, 1.15, 0.88, 1.0]
  const accel = [1.0, 0.85, 1.15, 0.9, 1.1, 0.8, 1.2, 1.0]
  const handling = [1.0, 0.9, 1.1, 0.95, 1.05, 0.85, 1.15, 1.0]
  const weight = [1.0, 1.2, 0.85, 1.1, 0.9, 1.3, 0.8, 1.0]
  const out: CharacterStats[] = []
  for (let i = 0; i < 8; i++) {
    out.push({
      id: `c${i}`,
      name: `Racer ${i}`,
      speed: speed[i],
      accel: accel[i],
      handling: handling[i],
      weight: weight[i],
    })
  }
  return out
}

/**
 * A closed loop whose front straight runs along +X at z = 0.
 * Control points 0..4 are collinear, so the spline is exactly straight for the whole
 * span between control point 1 (x = 150) and control point 3 (x = 450): both of the
 * segments in that span use only z = 0 control points.
 * A kart at heading 0 drives down that straight, and positive lateral is toward +z
 * because right = (-t.z, 0, t.x) = (0, 0, 1) when t = (1, 0, 0).
 */
export function makeStraightTrack(overrides?: Partial<Track>): Track {
  const xz: [number, number][] = [
    [0, 0],
    [150, 0],
    [300, 0],
    [450, 0],
    [600, 0],
    [700, 30],
    [740, 60],
    [700, 90],
    [600, 120],
    [300, 120],
    [0, 120],
    [-140, 60],
  ]
  return {
    id: 'straight',
    name: 'Straight',
    controlPoints: xz.map(([x, z]) => cp(x, 0, z, 20, 0, 'tarmac')),
    checkpointS: [0, 0.25, 0.5, 0.75],
    itemBoxes: [
      { s: 0.3, lateral: -6 },
      { s: 0.3, lateral: 0 },
      { s: 0.3, lateral: 6 },
    ],
    ramps: [{ sStart: 0.4, sEnd: 0.44, launch: 6 }],
    boostPads: [{ s: 0.6, lateral: 0, halfWidth: 3 }],
    startPositions: [
      { s: 0.01, lateral: -5 },
      { s: 0.01, lateral: 5 },
      { s: 0.025, lateral: -5 },
      { s: 0.025, lateral: 5 },
      { s: 0.04, lateral: -5 },
      { s: 0.04, lateral: 5 },
      { s: 0.055, lateral: -5 },
      { s: 0.055, lateral: 5 },
    ],
    bounds: { min: v3(-200, -20, -40), max: v3(800, 40, 160) },
    ...overrides,
  }
}

/** 16 control points evenly spaced on a radius-100 circle centred on the origin. */
export function makeCircleTrack(overrides?: Partial<Track>): Track {
  const points: TrackPoint[] = []
  for (let i = 0; i < 16; i++) {
    const a = (i * 2 * Math.PI) / 16
    points.push(cp(100 * Math.cos(a), 0, 100 * Math.sin(a), 20, 0, 'tarmac'))
  }
  return {
    id: 'circle',
    name: 'Circle',
    controlPoints: points,
    checkpointS: [0, 0.25, 0.5, 0.75],
    itemBoxes: [
      { s: 0.5, lateral: -6 },
      { s: 0.5, lateral: 0 },
      { s: 0.5, lateral: 6 },
    ],
    ramps: [],
    boostPads: [{ s: 0.25, lateral: 0, halfWidth: 3 }],
    startPositions: [
      { s: 0.9, lateral: -5 },
      { s: 0.9, lateral: 5 },
      { s: 0.92, lateral: -5 },
      { s: 0.92, lateral: 5 },
      { s: 0.94, lateral: -5 },
      { s: 0.94, lateral: 5 },
      { s: 0.96, lateral: -5 },
      { s: 0.96, lateral: 5 },
    ],
    bounds: { min: v3(-120, -20, -120), max: v3(120, 20, 120) },
    ...overrides,
  }
}

/**
 * The golden fixture track: a 400 m x 200 m stadium oval.
 *   0..4   bottom straight, z = -100, 24 m wide, flat, tarmac
 *   5..9   right turn, radius 100 about (200, 0, 0), 20 m wide, banked 0.2 rad
 *   10..14 top straight, z = +100, 24 m wide, flat; 12 and 13 are dirt
 *   15..19 left turn, radius 100 about (-200, 0, 0), 20 m wide, banked 0.2 rad
 */
export function makeOvalTrack(overrides?: Partial<Track>): Track {
  const points: TrackPoint[] = []
  for (let i = 0; i < 5; i++) points.push(cp(-200 + i * 100, 0, -100, 24, 0, 'tarmac'))
  for (let i = 1; i <= 5; i++) {
    const a = ((-90 + i * 30) * Math.PI) / 180
    points.push(cp(200 + 100 * Math.cos(a), 0, 100 * Math.sin(a), 20, 0.2, 'tarmac'))
  }
  for (let i = 0; i < 5; i++) {
    const surface: Surface = i === 2 || i === 3 ? 'dirt' : 'tarmac'
    points.push(cp(200 - i * 100, 0, 100, 24, 0, surface))
  }
  for (let i = 1; i <= 5; i++) {
    const a = ((90 + i * 30) * Math.PI) / 180
    points.push(cp(-200 + 100 * Math.cos(a), 0, 100 * Math.sin(a), 20, 0.2, 'tarmac'))
  }
  return {
    id: 'oval',
    name: 'Oval',
    controlPoints: points,
    checkpointS: [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875],
    itemBoxes: [
      { s: 0.3, lateral: -6 },
      { s: 0.3, lateral: 0 },
      { s: 0.3, lateral: 6 },
      { s: 0.8, lateral: -6 },
      { s: 0.8, lateral: 0 },
      { s: 0.8, lateral: 6 },
    ],
    ramps: [{ sStart: 0.55, sEnd: 0.58, launch: 7 }],
    boostPads: [{ s: 0.1, lateral: 0, halfWidth: 4 }],
    startPositions: [
      { s: 0.005, lateral: -6 },
      { s: 0.005, lateral: 6 },
      { s: 0.02, lateral: -6 },
      { s: 0.02, lateral: 6 },
      { s: 0.035, lateral: -6 },
      { s: 0.035, lateral: 6 },
      { s: 0.05, lateral: -6 },
      { s: 0.05, lateral: 6 },
    ],
    bounds: { min: v3(-320, -20, -120), max: v3(320, 20, 120) },
    ...overrides,
  }
}
```

- [ ] **Step 4: Run the fixture test to verify it passes**

Run: `npx vitest run packages/sim/test/track-fixtures.test.ts`

Expected: PASS — 7 passed.

---

- [ ] **Step 5: Write the failing test for control point and checkpoint validation**

Create `packages/sim/test/track-validate.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { validateTrack } from '../src/track'
import { makeCircleTrack, makeOvalTrack, makeStraightTrack } from './fixtures/track-fixtures'

describe('validateTrack: control points and checkpoints', () => {
  it('accepts all three fixture tracks', () => {
    expect(validateTrack(makeStraightTrack())).toEqual([])
    expect(validateTrack(makeCircleTrack())).toEqual([])
    expect(validateTrack(makeOvalTrack())).toEqual([])
  })

  it('rejects fewer than 8 control points', () => {
    const base = makeStraightTrack()
    const tr = makeStraightTrack({ controlPoints: base.controlPoints.slice(0, 5) })
    expect(validateTrack(tr)).toEqual(['controlPoints: need at least 8, got 5'])
  })

  it('rejects a non-finite control point position', () => {
    const base = makeStraightTrack()
    const tr = makeStraightTrack({
      controlPoints: base.controlPoints.map((p, i) =>
        i === 4 ? { ...p, position: { x: NaN, y: 0, z: 0 } } : p,
      ),
    })
    expect(validateTrack(tr)).toEqual(['controlPoints[4].position: must be finite'])
  })

  it('rejects two coincident consecutive control points', () => {
    // control point 2 is already (300, 0, 0); moving 3 on top of it makes the pair (2, 3)
    // coincident, which would give the spline a zero-length segment
    const base = makeStraightTrack()
    const tr = makeStraightTrack({
      controlPoints: base.controlPoints.map((p, i) =>
        i === 3 ? { ...p, position: { x: 300, y: 0, z: 0 } } : p,
      ),
    })
    expect(validateTrack(tr)).toEqual(['controlPoints[2]: coincident with controlPoints[3]'])
  })

  it('treats the closing pair (last, first) as consecutive', () => {
    // last control point is (-140, 0, 60); moving it onto control point 0 at (0, 0, 0)
    // closes the loop with a zero-length segment
    const base = makeStraightTrack()
    const tr = makeStraightTrack({
      controlPoints: base.controlPoints.map((p, i) =>
        i === 11 ? { ...p, position: { x: 0, y: 0, z: 0 } } : p,
      ),
    })
    expect(validateTrack(tr)).toEqual(['controlPoints[11]: coincident with controlPoints[0]'])
  })

  it('rejects a non-positive width', () => {
    const base = makeStraightTrack()
    const tr = makeStraightTrack({
      controlPoints: base.controlPoints.map((p, i) => (i === 2 ? { ...p, width: 0 } : p)),
    })
    expect(validateTrack(tr)).toEqual([
      'controlPoints[2].width: must be positive and finite, got 0',
    ])
  })

  it('rejects an empty checkpoint ring', () => {
    expect(validateTrack(makeStraightTrack({ checkpointS: [] }))).toEqual([
      'checkpointS: must be non-empty',
    ])
  })

  it('rejects a non-ascending checkpoint ring', () => {
    expect(validateTrack(makeStraightTrack({ checkpointS: [0, 0.5, 0.5, 0.75] }))).toEqual([
      'checkpointS[2]: must be strictly ascending, got 0.5 after 0.5',
    ])
  })

  it('rejects a checkpoint outside 0..1', () => {
    expect(validateTrack(makeStraightTrack({ checkpointS: [0, 0.5, 1.4] }))).toEqual([
      'checkpointS[2]: must be within 0..1, got 1.4',
    ])
  })
})
```

- [ ] **Step 6: Run the validator test to verify it fails**

Run: `npx vitest run packages/sim/test/track-validate.test.ts`

Expected: FAIL — `Failed to resolve import "../src/track" from "packages/sim/test/track-validate.test.ts". Does the file exist?`

- [ ] **Step 7: Write the control point and checkpoint half of the validator**

Create `packages/sim/src/track.ts`:

```ts
import type { Track, Vec3 } from './types'

/**
 * Kart radius the static validator uses for the start-grid clearance rule.
 * `validateTrack` takes no `Tuning` (it runs on raw track data before a race exists),
 * so it carries its own copy of the base tuning's `kartRadius`.
 */
export const VALIDATION_KART_RADIUS = 0.9

function isFiniteVec(p: Vec3): boolean {
  return Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)
}

function checkControlPoints(track: Track, errs: string[]): void {
  const cps = track.controlPoints
  if (cps.length < 8) errs.push(`controlPoints: need at least 8, got ${cps.length}`)
  for (let i = 0; i < cps.length; i++) {
    if (!isFiniteVec(cps[i].position)) errs.push(`controlPoints[${i}].position: must be finite`)
    if (!(Number.isFinite(cps[i].width) && cps[i].width > 0)) {
      errs.push(`controlPoints[${i}].width: must be positive and finite, got ${cps[i].width}`)
    }
  }
  // the loop is closed, so the last control point is consecutive with the first
  for (let i = 0; i < cps.length; i++) {
    const j = (i + 1) % cps.length
    const a = cps[i].position
    const b = cps[j].position
    if (!isFiniteVec(a) || !isFiniteVec(b)) continue
    if (a.x === b.x && a.y === b.y && a.z === b.z) {
      errs.push(`controlPoints[${i}]: coincident with controlPoints[${j}]`)
    }
  }
}

function checkCheckpoints(track: Track, errs: string[]): void {
  const cs = track.checkpointS
  if (cs.length === 0) errs.push('checkpointS: must be non-empty')
  for (let i = 0; i < cs.length; i++) {
    if (!(Number.isFinite(cs[i]) && cs[i] >= 0 && cs[i] <= 1)) {
      errs.push(`checkpointS[${i}]: must be within 0..1, got ${cs[i]}`)
    } else if (i > 0 && !(cs[i] > cs[i - 1])) {
      errs.push(`checkpointS[${i}]: must be strictly ascending, got ${cs[i]} after ${cs[i - 1]}`)
    }
  }
}

/**
 * Static validation of raw track data. Returns [] when the track is valid.
 * Runs without building the spline, so it can gate generated track JSON.
 */
export function validateTrack(track: Track): string[] {
  const errs: string[] = []
  checkControlPoints(track, errs)
  checkCheckpoints(track, errs)
  return errs
}
```

- [ ] **Step 8: Run the validator test to verify it passes**

Run: `npx vitest run packages/sim/test/track-validate.test.ts`

Expected: PASS — 9 passed.

---

- [ ] **Step 9: Write the failing test for start-grid validation**

Append to `packages/sim/test/track-validate.test.ts`, after the closing `})` of the
`describe('validateTrack: control points and checkpoints', ...)` block:

```ts
describe('validateTrack: start grid', () => {
  it('rejects a grid that is not exactly MAX_KARTS entries', () => {
    const base = makeStraightTrack()
    const tr = makeStraightTrack({ startPositions: base.startPositions.slice(0, 7) })
    expect(validateTrack(tr)).toEqual(['startPositions: need exactly 8, got 7'])
  })

  it('rejects a start position outside 0..1', () => {
    const base = makeStraightTrack()
    const tr = makeStraightTrack({
      startPositions: base.startPositions.map((p, i) => (i === 3 ? { s: 1.2, lateral: 5 } : p)),
    })
    expect(validateTrack(tr)).toEqual(['startPositions[3].s: must be within 0..1, got 1.2'])
  })

  it('rejects a start position wider than the half-width', () => {
    // straight fixture is 20 m wide everywhere, so the half-width is exactly 10
    const base = makeStraightTrack()
    const tr = makeStraightTrack({
      startPositions: base.startPositions.map((p, i) => (i === 3 ? { s: p.s, lateral: 11 } : p)),
    })
    expect(validateTrack(tr)).toEqual([
      'startPositions[3].lateral: |11| exceeds half-width 10.000',
    ])
  })

  it('rejects two start positions closer than 2 * kart radius', () => {
    // slots 0 and 1 share s = 0.01, so their separation is purely lateral.
    // moving slot 1 from +5 to -3.5 leaves |-3.5 - -5| = 1.5, below 2 * 0.9 = 1.8
    const base = makeStraightTrack()
    const tr = makeStraightTrack({
      startPositions: base.startPositions.map((p, i) =>
        i === 1 ? { s: 0.01, lateral: -3.5 } : p,
      ),
    })
    expect(validateTrack(tr)).toEqual([
      'startPositions[0] and startPositions[1]: separation 1.500 is below 1.800',
    ])
  })

  it('measures separation along the track as well as across it', () => {
    // straight fixture control polygon is 1813.437 m round. Slots 0 and 1 are put on the
    // same lateral, ds apart: 0.0005 * 1813.437 = 0.907 m < 1.8, so this must be rejected,
    // and the reported separation is hypot(0.907, 0) = 0.907
    const base = makeStraightTrack()
    const tr = makeStraightTrack({
      startPositions: base.startPositions.map((p, i) =>
        i === 0 ? { s: 0.0095, lateral: 5 } : i === 1 ? { s: 0.01, lateral: 5 } : p,
      ),
    })
    expect(validateTrack(tr)).toEqual([
      'startPositions[0] and startPositions[1]: separation 0.907 is below 1.800',
    ])
  })

  it('keeps the oval start grid valid at 12 m minimum separation', () => {
    // oval slots pair up at the same s with lateral -6 and +6, so the tightest pair is 12 m
    expect(validateTrack(makeOvalTrack())).toEqual([])
  })
})
```

- [ ] **Step 10: Run the start-grid test to verify it fails**

Run: `npx vitest run packages/sim/test/track-validate.test.ts -t "start grid"`

Expected: FAIL — all six assertions get `[]` back, e.g.
`AssertionError: expected [] to deeply equal [ 'startPositions: need exactly 8, got 7' ]`.

- [ ] **Step 11: Add start-grid validation**

In `packages/sim/src/track.ts`, change the first line from:

```ts
import type { Track, Vec3 } from './types'
```

to:

```ts
import type { Track, Vec3 } from './types'
import { MAX_KARTS } from './types'
```

Then insert these two helpers and `checkStartPositions`
immediately after `checkCheckpoints` and before the `validateTrack` doc comment:

```ts
/**
 * Length of the closed control polygon. The validator's stand-in for arc length: it
 * needs no spline, and it is within 1% of the real arc length on all three fixtures
 * (straight 1813.437 vs 1828.324, circle 624.289 vs 628.135, oval 1421.166 vs 1427.756).
 */
function controlPolygonLength(track: Track): number {
  const cps = track.controlPoints
  let sum = 0
  for (let i = 0; i < cps.length; i++) {
    const a = cps[i].position
    const b = cps[(i + 1) % cps.length].position
    sum += Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z)
  }
  return sum
}

/**
 * Half-width at `s`, treating `s` as uniform over the control point segments.
 * Validation-only: the runtime TrackQuery resolves `s` by true arc length.
 */
function halfWidthAtParam(track: Track, s: number): number {
  const cps = track.controlPoints
  const n = cps.length
  const scaled = (s - Math.floor(s)) * n
  let i = Math.floor(scaled)
  if (i >= n) i = n - 1
  const u = scaled - i
  const a = cps[i].width
  const b = cps[(i + 1) % n].width
  return (a + (b - a) * u) / 2
}

function checkStartPositions(track: Track, errs: string[]): void {
  const sp = track.startPositions
  if (sp.length !== MAX_KARTS) {
    errs.push(`startPositions: need exactly ${MAX_KARTS}, got ${sp.length}`)
  }
  for (let i = 0; i < sp.length; i++) {
    if (!(Number.isFinite(sp[i].s) && sp[i].s >= 0 && sp[i].s <= 1)) {
      errs.push(`startPositions[${i}].s: must be within 0..1, got ${sp[i].s}`)
      continue
    }
    const half = halfWidthAtParam(track, sp[i].s)
    if (!(Math.abs(sp[i].lateral) <= half)) {
      errs.push(
        `startPositions[${i}].lateral: |${sp[i].lateral}| exceeds half-width ${half.toFixed(3)}`,
      )
    }
  }
  const length = controlPolygonLength(track)
  const minSep = 2 * VALIDATION_KART_RADIUS
  for (let i = 0; i < sp.length; i++) {
    for (let j = i + 1; j < sp.length; j++) {
      if (!Number.isFinite(sp[i].s) || !Number.isFinite(sp[j].s)) continue
      let ds = Math.abs(sp[i].s - sp[j].s)
      if (ds > 0.5) ds = 1 - ds // the loop is closed, so s = 0.99 and s = 0.01 are close
      const sep = Math.hypot(ds * length, sp[i].lateral - sp[j].lateral)
      if (sep < minSep) {
        errs.push(
          `startPositions[${i}] and startPositions[${j}]: ` +
            `separation ${sep.toFixed(3)} is below ${minSep.toFixed(3)}`,
        )
      }
    }
  }
}
```

Then change `validateTrack` from:

```ts
export function validateTrack(track: Track): string[] {
  const errs: string[] = []
  checkControlPoints(track, errs)
  checkCheckpoints(track, errs)
  return errs
}
```

to:

```ts
export function validateTrack(track: Track): string[] {
  const errs: string[] = []
  checkControlPoints(track, errs)
  checkCheckpoints(track, errs)
  checkStartPositions(track, errs)
  return errs
}
```

- [ ] **Step 12: Run the start-grid test to verify it passes**

Run: `npx vitest run packages/sim/test/track-validate.test.ts`

Expected: PASS — 15 passed.

---

- [ ] **Step 13: Write the failing test for item boxes, boost pads, ramps and bounds**

Append to `packages/sim/test/track-validate.test.ts`, after the closing `})` of the
`describe('validateTrack: start grid', ...)` block:

```ts
describe('validateTrack: props and bounds', () => {
  it('rejects an item box outside 0..1', () => {
    expect(validateTrack(makeStraightTrack({ itemBoxes: [{ s: 1.5, lateral: 0 }] }))).toEqual([
      'itemBoxes[0].s: must be within 0..1, got 1.5',
    ])
  })

  it('rejects an item box outside the half-width', () => {
    // straight fixture half-width is 10 everywhere
    expect(validateTrack(makeStraightTrack({ itemBoxes: [{ s: 0.3, lateral: 12 }] }))).toEqual([
      'itemBoxes[0].lateral: |12| exceeds half-width 10.000',
    ])
  })

  it('rejects a boost pad outside 0..1', () => {
    const tr = makeStraightTrack({ boostPads: [{ s: -0.1, lateral: 0, halfWidth: 3 }] })
    expect(validateTrack(tr)).toEqual(['boostPads[0].s: must be within 0..1, got -0.1'])
  })

  it('rejects a boost pad outside the half-width', () => {
    const tr = makeStraightTrack({ boostPads: [{ s: 0.6, lateral: -10.5, halfWidth: 3 }] })
    expect(validateTrack(tr)).toEqual([
      'boostPads[0].lateral: |-10.5| exceeds half-width 10.000',
    ])
  })

  it('rejects a ramp whose sStart is not before its sEnd', () => {
    const tr = makeStraightTrack({ ramps: [{ sStart: 0.5, sEnd: 0.4, launch: 6 }] })
    expect(validateTrack(tr)).toEqual(['ramps[0]: sStart 0.5 must be less than sEnd 0.4'])
  })

  it('rejects a ramp endpoint outside 0..1', () => {
    const tr = makeStraightTrack({ ramps: [{ sStart: -0.2, sEnd: 0.4, launch: 6 }] })
    expect(validateTrack(tr)).toEqual(['ramps[0].sStart: must be within 0..1, got -0.2'])
  })

  it('rejects bounds that do not enclose every control point', () => {
    // control point 11 sits at x = -140; a min.x of 0 leaves it outside
    const tr = makeStraightTrack({
      bounds: { min: { x: 0, y: -20, z: -40 }, max: { x: 800, y: 40, z: 160 } },
    })
    expect(validateTrack(tr)).toEqual(['bounds: does not enclose controlPoints[11]'])
  })

  it('accepts bounds that touch a control point exactly', () => {
    // control points span x in [-140, 740], z in [0, 120], y = 0
    const tr = makeStraightTrack({
      bounds: { min: { x: -140, y: 0, z: 0 }, max: { x: 740, y: 0, z: 120 } },
    })
    expect(validateTrack(tr)).toEqual([])
  })

  it('reports every independent failure at once', () => {
    const tr = makeStraightTrack({
      checkpointS: [],
      ramps: [{ sStart: 0.5, sEnd: 0.4, launch: 6 }],
      itemBoxes: [{ s: 1.5, lateral: 0 }],
    })
    expect(validateTrack(tr)).toEqual([
      'checkpointS: must be non-empty',
      'itemBoxes[0].s: must be within 0..1, got 1.5',
      'ramps[0]: sStart 0.5 must be less than sEnd 0.4',
    ])
  })
})
```

- [ ] **Step 14: Run the props test to verify it fails**

Run: `npx vitest run packages/sim/test/track-validate.test.ts -t "props and bounds"`

Expected: FAIL — 9 failing, each `expected [] to deeply equal [ ... ]`.

- [ ] **Step 15: Add item box, boost pad, ramp and bounds validation**

In `packages/sim/src/track.ts`, insert these four functions immediately after
`checkStartPositions` and before the `validateTrack` doc comment:

```ts
function checkItemBoxes(track: Track, errs: string[]): void {
  for (let i = 0; i < track.itemBoxes.length; i++) {
    const b = track.itemBoxes[i]
    if (!(Number.isFinite(b.s) && b.s >= 0 && b.s <= 1)) {
      errs.push(`itemBoxes[${i}].s: must be within 0..1, got ${b.s}`)
      continue
    }
    const half = halfWidthAtParam(track, b.s)
    if (!(Math.abs(b.lateral) <= half)) {
      errs.push(`itemBoxes[${i}].lateral: |${b.lateral}| exceeds half-width ${half.toFixed(3)}`)
    }
  }
}

function checkBoostPads(track: Track, errs: string[]): void {
  for (let i = 0; i < track.boostPads.length; i++) {
    const b = track.boostPads[i]
    if (!(Number.isFinite(b.s) && b.s >= 0 && b.s <= 1)) {
      errs.push(`boostPads[${i}].s: must be within 0..1, got ${b.s}`)
      continue
    }
    const half = halfWidthAtParam(track, b.s)
    if (!(Math.abs(b.lateral) <= half)) {
      errs.push(`boostPads[${i}].lateral: |${b.lateral}| exceeds half-width ${half.toFixed(3)}`)
    }
  }
}

function checkRamps(track: Track, errs: string[]): void {
  for (let i = 0; i < track.ramps.length; i++) {
    const r = track.ramps[i]
    const okStart = Number.isFinite(r.sStart) && r.sStart >= 0 && r.sStart <= 1
    const okEnd = Number.isFinite(r.sEnd) && r.sEnd >= 0 && r.sEnd <= 1
    if (!okStart) errs.push(`ramps[${i}].sStart: must be within 0..1, got ${r.sStart}`)
    if (!okEnd) errs.push(`ramps[${i}].sEnd: must be within 0..1, got ${r.sEnd}`)
    if (okStart && okEnd && !(r.sStart < r.sEnd)) {
      errs.push(`ramps[${i}]: sStart ${r.sStart} must be less than sEnd ${r.sEnd}`)
    }
  }
}

function checkBounds(track: Track, errs: string[]): void {
  const min = track.bounds.min
  const max = track.bounds.max
  const cps = track.controlPoints
  for (let i = 0; i < cps.length; i++) {
    const p = cps[i].position
    if (!isFiniteVec(p)) continue
    if (p.x < min.x || p.y < min.y || p.z < min.z || p.x > max.x || p.y > max.y || p.z > max.z) {
      errs.push(`bounds: does not enclose controlPoints[${i}]`)
    }
  }
}
```

Then change `validateTrack` from:

```ts
export function validateTrack(track: Track): string[] {
  const errs: string[] = []
  checkControlPoints(track, errs)
  checkCheckpoints(track, errs)
  checkStartPositions(track, errs)
  return errs
}
```

to:

```ts
export function validateTrack(track: Track): string[] {
  const errs: string[] = []
  checkControlPoints(track, errs)
  checkCheckpoints(track, errs)
  checkStartPositions(track, errs)
  checkItemBoxes(track, errs)
  checkBoostPads(track, errs)
  checkRamps(track, errs)
  checkBounds(track, errs)
  return errs
}
```

The call order fixes the message order asserted by the
"reports every independent failure at once" test: checkpoints, then item boxes, then ramps.

- [ ] **Step 16: Run the props test to verify it passes**

Run: `npx vitest run packages/sim/test/track-validate.test.ts`

Expected: PASS — 24 passed.

- [ ] **Step 17: Typecheck and run the whole sim suite**

Run: `npx tsc --noEmit -p packages/sim && npx vitest run packages/sim`

Expected: PASS — no TypeScript errors, all `packages/sim` tests green: 31 from these two
files (7 in `track-fixtures.test.ts`, 24 in `track-validate.test.ts`) plus the 50 Task 2
left (2 scaffold, 7 types, 17 vec3, 15 mathutil, 9 rng) — 81 in `packages/sim` overall.

- [ ] **Step 18: Commit**

```bash
git add packages/sim/src/track.ts packages/sim/test/fixtures/track-fixtures.ts packages/sim/test/track-fixtures.test.ts packages/sim/test/track-validate.test.ts
git commit -m "feat(sim): track fixtures and static track validator"
```

---

### Task 4: Track Query — closed-loop spline, arc-length parameterisation, projection

This is **Task 4**, and the locked contract labels both halves of it Task 4: contract §2
marks `buildTrackQuery(track: Track): TrackQuery` in `packages/sim/src/track.ts` as
`[Task 4]`, and contract §3 marks `makeContext(track, isLeader?)` in
`packages/sim/test/fixtures/track-fixtures.ts` as `[Task 4]`. The other entries on those
same lines belong to **Task 3**, which has already run: `validateTrack` in the same
`track.ts` (contract §2, `[Task 3]`) and the rest of the fixtures file — `makeTuning`,
`makeCharacters`, `makeStraightTrack`, `makeCircleTrack`, `makeOvalTrack` (contract §3,
`[Task 3]`). This task **appends** to both files and edits neither of Task 3's halves.

> **READ THIS BEFORE ANYTHING ELSE: `s` IS `[0, 1)`, NEVER METRES.**
>
> Contract §0: **"Track parameter `s` — always arc-normalised `[0, 1)`"**, and
> **"Metres — reachable only by multiplying an `s`-delta by `query.totalLength()`"**.
> This task is where that becomes real, so it is stated here at full volume:
>
> **`s = 30` is not "30 metres along the track". It is `wrap01(30) = 30 - Math.floor(30)
> = 0.0`, the start line, and nothing warns you.** Every method on `TrackQuery` takes or
> returns `s` in `[0, 1)` and silently wraps anything else, so a metres value passed as
> `s` does not throw, does not clamp, and does not log — it just teleports the caller to
> a wrong, plausible-looking place on the track and every number downstream is quietly
> wrong.
>
> On `makeStraightTrack`, `totalLength()` is `1828.3236243268896` m, so:
>
> | you mean | you write | you must NOT write |
> |---|---|---|
> | 30 m along from the start | `30 / query.totalLength()` = `0.016408473642648858` | `30` (→ `s = 0`) |
> | a 6 m bot lookahead | `sNow + 6 / query.totalLength()`, then `wrap01` | `sNow + 6` (→ `sNow`) |
> | the metres between two `s` values | `wrappedDelta * query.totalLength()` | the raw `s` delta |
>
> `checkpointS`, `itemBoxes[].s`, `boostPads[].s`, `ramps[].sStart` / `.sEnd` and
> `startPositions[].s` are all in `[0, 1)` for the same reason, and Task 3's
> `validateTrack` rejects any of them outside `0..1`. Step 13's test
> "reads `s` as arc-normalised" pins this behaviour so nobody can later decide `s` is
> metres and quietly break six other tasks.

**Files:**
- Modify: `packages/sim/src/track.ts:1` — widen the type import on line 1
- Modify: `packages/sim/src/track.ts` — append the spline core, the arc table, `projectPoint` and `buildTrackQuery` after the existing `validateTrack`
- Modify: `packages/sim/test/fixtures/track-fixtures.ts` — append `makeContext`
- Test: `packages/sim/test/track-query.test.ts`

**Interfaces:**

- Consumes (from Task 2, `packages/sim/src/types.ts`):
  - `type Vec3 = { x: number; y: number; z: number }`
  - `type Surface = 'tarmac' | 'dirt' | 'boost' | 'offtrack'`
  - `interface TrackPoint { position: Vec3; width: number; banking: number; surface: Surface }`
  - `interface Track { id: string; name: string; controlPoints: TrackPoint[]; checkpointS: number[]; itemBoxes: { s: number; lateral: number }[]; ramps: { sStart: number; sEnd: number; launch: number }[]; boostPads: { s: number; lateral: number; halfWidth: number }[]; startPositions: { s: number; lateral: number }[]; bounds: { min: Vec3; max: Vec3 } }`
  - `interface TrackProjection { s: number; lateral: number; distance: number }`
  - `interface TrackQuery { sampleAt(s: number): TrackPoint; tangentAt(s: number): Vec3; project(p: Vec3): TrackProjection; groundHeight(s: number, lateral: number): number; surfaceAt(s: number, lateral: number): Surface; isInBounds(s: number, lateral: number): boolean; checkpointIndexAt(s: number): number; totalLength(): number }`
  - `interface SimContext { track: Track; query: TrackQuery; tuning: Tuning; characters: CharacterStats[]; isLeader: boolean }`
- Consumes (from Task 2, `packages/sim/src/vec3.ts`): `function v3(x: number, y: number, z: number): Vec3`
- Consumes (from Task 3, `packages/sim/test/fixtures/track-fixtures.ts`):
  - `function makeTuning(overrides?: Partial<Tuning>): Tuning`
  - `function makeCharacters(): CharacterStats[]`
  - `function makeStraightTrack(overrides?: Partial<Track>): Track`
  - `function makeCircleTrack(overrides?: Partial<Track>): Track`
  - `function makeOvalTrack(overrides?: Partial<Track>): Track`
- Consumes (from Task 3, `packages/sim/src/track.ts`): the file already exists and exports
  `VALIDATION_KART_RADIUS` and `validateTrack(track: Track): string[]`. Do not edit either.
- Produces (`packages/sim/src/track.ts`):
  - `const SAMPLES_PER_SEGMENT = 64`
  - `const BOOST_PAD_HALF_LENGTH = 4` — new constant, not in the contract: `boostPads` carry a
    lateral `halfWidth` but no longitudinal extent, so a pad covers ±4 m of centreline
  - `const BOUNDS_HALF_WIDTH_MUL = 2` — new constant, not in the contract: `isInBounds` allows
    one half-width of run-off beyond each track edge
  - `function catmullRom(p0: number, p1: number, p2: number, p3: number, u: number): number`
  - `function splinePointAt(track: Track, t: number, out: Vec3): void`
  - `function splineTangentAt(track: Track, t: number, out: Vec3): void`
  - `function widthAtSeg(track: Track, t: number): number`
  - `function bankingAtSeg(track: Track, t: number): number`
  - `function surfaceOfSeg(track: Track, t: number): Surface`
  - `interface ArcTable { pts: Float64Array; cum: Float64Array; samplesPerSegment: number; segments: number; total: number }`
  - `function buildArcTable(track: Track): ArcTable`
  - `function locateS(table: ArcTable, s: number): number` — arc-normalised `s` → segment-parameter `t`
  - `function arcAt(table: ArcTable, t: number): number` — segment-parameter `t` → metres travelled
  - `function projectPoint(track: Track, table: ArcTable, p: Vec3, out: TrackProjection): void` —
    writes `out.s` arc-normalised into `[0, 1)`
  - `function buildTrackQuery(track: Track): TrackQuery` — **every method of the returned
    query takes or returns `s` in `[0, 1)` and wraps anything else without complaint;
    metres exist only via `totalLength()`**
- Produces (`packages/sim/test/fixtures/track-fixtures.ts`), contract §3 marks this `[Task 4]`:
  - `function makeContext(track: Track, isLeader?: boolean): SimContext` — `isLeader` defaults
    `true`; it is here rather than in Task 3 because it needs `buildTrackQuery`, see decision 5

**Five decisions this task makes, all load-bearing for Tasks 5–16:**

1. **`t` versus `s`, and where metres live.** `t` is the *segment parameter*: `t = 3.5` is
   halfway along the segment from control point 3 to control point 4, and `t` wraps modulo
   `controlPoints.length`. `s` is the *arc-normalised* position, `[0, 1)` over the whole lap,
   and it also wraps. The two are related only through the arc table. Everything on
   `TrackQuery` speaks `s` — `sampleAt`, `tangentAt`, `groundHeight`, `surfaceAt`,
   `isInBounds` and `checkpointIndexAt` all take `s`, and `project` returns `s`.
   This is what makes a kart at constant speed see `s` advance at a constant rate, and it is
   why `checkpointS` values are comparable to lap progress.
   **`totalLength()` is the only door between `s` and metres**, in both directions:
   `metres = sDelta * totalLength()` and `sDelta = metres / totalLength()`. `t` is internal;
   it never leaves `track.ts` and no other task may take a `t`. See the boxed warning at the
   top of this task: an `s` of `30` is `0.0`, not 30 m, and it fails silently.
2. **The returned objects are shared scratch.** `sampleAt`, `tangentAt` and `project` each
   return the *same* object on every call for a given query, overwritten in place. `step()`
   may not allocate in the hot path, so the caller must copy any field it wants to keep
   before calling again. Tests below assert this identity so nobody "fixes" it later.
3. **Projection is horizontal.** `project` searches and measures in the XZ plane, so a kart's
   ride height never leaks into `lateral` or `distance`. `distance` is the XZ distance from
   `p` to the centreline point at `s`.
4. **`lateral` sign.** From contract §0, `right = (-t.z, 0, t.x)` and positive `lateral` is
   to the right of the direction of travel. On the straight fixture the tangent is
   `(1, 0, 0)`, so `right = (0, 0, 1)` and positive `lateral` is toward **+z**, which is what
   contract §3 now says as well. (An earlier revision of the contract said `-z` there and is
   retracted; §0's formula is authoritative. The tests below pin the sign numerically, both
   on the straight fixture and on the circle, where travel is counter-clockwise so positive
   `lateral` points at the centre.)
5. **`makeContext` lives here, in Task 4, not in Task 3 where the rest of the fixtures live.**
   `SimContext.query` is a `TrackQuery`, and `buildTrackQuery` — the only producer of one —
   is written in *this* task. ESM linking is what makes this an ordering constraint rather
   than a preference: imports are resolved when the module graph links, before any test body
   runs, so a Task 3 `track-fixtures.ts` that did
   `import { buildTrackQuery } from '../../src/track'` would fail to load outright with
   `SyntaxError: The requested module '../../src/track' does not provide an export named
   'buildTrackQuery'`, taking all of Task 3's tests down with it for the wrong reason.
   Step 19 below is therefore the first edit that widens that fixture file's import block.

---

- [ ] **Step 1: Write the failing test for the spline core**

Create `packages/sim/test/track-query.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { v3 } from '../src/vec3'
import {
  bankingAtSeg,
  catmullRom,
  splinePointAt,
  splineTangentAt,
  surfaceOfSeg,
  widthAtSeg,
} from '../src/track'
import { makeOvalTrack, makeStraightTrack } from './fixtures/track-fixtures'

describe('spline core', () => {
  it('catmullRom interpolates p1..p2 and hits both ends exactly', () => {
    // p0=0 p1=0 p2=1 p3=1: u=0 -> p1, u=1 -> p2, u=0.5 -> the symmetric midpoint
    expect(catmullRom(0, 0, 1, 1, 0)).toBe(0)
    expect(catmullRom(0, 0, 1, 1, 1)).toBe(1)
    expect(catmullRom(0, 0, 1, 1, 0.5)).toBe(0.5)
  })

  it('splinePointAt returns the control point itself at integer t', () => {
    const tr = makeStraightTrack()
    const out = v3(0, 0, 0)
    splinePointAt(tr, 0, out)
    expect(out).toEqual({ x: 0, y: 0, z: 0 })
    splinePointAt(tr, 2, out)
    expect(out).toEqual({ x: 300, y: 0, z: 0 })
    splinePointAt(tr, 8, out)
    expect(out).toEqual({ x: 600, y: 0, z: 120 })
  })

  it('splinePointAt is exactly linear across evenly spaced collinear control points', () => {
    // segment 2 spans control points 2 (x=300) and 3 (x=450) and its window is
    // control points 1,2,3,4 = x 150,300,450,600 at z=0, all collinear and evenly
    // spaced, so the Catmull-Rom cubic degenerates to the straight midpoint 375
    const tr = makeStraightTrack()
    const out = v3(0, 0, 0)
    splinePointAt(tr, 2.5, out)
    expect(out).toEqual({ x: 375, y: 0, z: 0 })
  })

  it('splinePointAt wraps t around the closed loop', () => {
    // t = -0.5 is the same place as t = 11.5 on a 12-control-point loop
    const tr = makeStraightTrack()
    const a = v3(0, 0, 0)
    const b = v3(0, 0, 0)
    splinePointAt(tr, 11.5, a)
    splinePointAt(tr, -0.5, b)
    expect(a).toEqual({ x: -88.125, y: 0, z: 26.25 })
    expect(b).toEqual(a)
  })

  it('splineTangentAt returns a unit tangent, +X on the straight', () => {
    const tr = makeStraightTrack()
    const out = v3(0, 0, 0)
    splineTangentAt(tr, 2, out)
    expect(out).toEqual({ x: 1, y: 0, z: 0 })
    splineTangentAt(tr, 6, out)
    expect(Math.hypot(out.x, out.y, out.z)).toBeCloseTo(1, 12)
  })

  it('widthAtSeg and bankingAtSeg interpolate linearly between control points', () => {
    // oval control point 4 is 24 m wide and flat, control point 5 is 20 m wide banked 0.2
    const tr = makeOvalTrack()
    expect(widthAtSeg(tr, 4)).toBe(24)
    expect(widthAtSeg(tr, 4.5)).toBe(22) // (24 + 20) / 2
    expect(widthAtSeg(tr, 5)).toBe(20)
    expect(bankingAtSeg(tr, 4.5)).toBe(0.1) // (0 + 0.2) / 2
    // control points 6 and 7 are both banked 0.2, so the whole segment is 0.2
    expect(bankingAtSeg(tr, 6.25)).toBe(0.2)
  })

  it('surfaceOfSeg takes the surface of the segment start control point', () => {
    // oval control points 12 and 13 are dirt, so segments 12 and 13 are dirt
    const tr = makeOvalTrack()
    expect(surfaceOfSeg(tr, 11.9)).toBe('tarmac')
    expect(surfaceOfSeg(tr, 12.5)).toBe('dirt')
    expect(surfaceOfSeg(tr, 13.5)).toBe('dirt')
    expect(surfaceOfSeg(tr, 14)).toBe('tarmac')
  })
})
```

- [ ] **Step 2: Run the spline core test to verify it fails**

Run: `npx vitest run packages/sim/test/track-query.test.ts -t "spline core"`

Expected: FAIL — `SyntaxError: The requested module '../src/track' does not provide an export named 'catmullRom'`

- [ ] **Step 3: Write the spline core**

In `packages/sim/src/track.ts`, change line 1 from:

```ts
import type { Track, Vec3 } from './types'
```

to:

```ts
import type { Surface, Track, TrackPoint, TrackProjection, TrackQuery, Vec3 } from './types'
import { v3 } from './vec3'
```

Then append to the end of the file, after `validateTrack`:

```ts
/** Samples per control point segment in the arc-length table. */
export const SAMPLES_PER_SEGMENT = 64

/** Longitudinal half-extent of a boost pad, in metres of centreline. */
export const BOOST_PAD_HALF_LENGTH = 4

/** A kart stays in bounds until it is this many half-widths off the centreline. */
export const BOUNDS_HALF_WIDTH_MUL = 2

/** Uniform Catmull-Rom, tension 1/2, interpolating p1 at u=0 and p2 at u=1. */
export function catmullRom(p0: number, p1: number, p2: number, p3: number, u: number): number {
  const u2 = u * u
  const u3 = u2 * u
  return (
    0.5 *
    (2 * p1 +
      (-p0 + p2) * u +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * u2 +
      (-p0 + 3 * p1 - 3 * p2 + p3) * u3)
  )
}

/** Derivative of the same curve with respect to u. Not normalised. */
function catmullRomDeriv(p0: number, p1: number, p2: number, p3: number, u: number): number {
  const u2 = u * u
  return (
    0.5 *
    (-p0 + p2 + 2 * (2 * p0 - 5 * p1 + 4 * p2 - p3) * u + 3 * (-p0 + 3 * p1 - 3 * p2 + p3) * u2)
  )
}

function wrapIndex(i: number, n: number): number {
  const m = i % n
  return m < 0 ? m + n : m
}

/** Fractional part of s in [0, 1). s wraps: the track is a closed loop. */
function wrap01(s: number): number {
  const w = s - Math.floor(s)
  return w === 1 ? 0 : w
}

/**
 * Position at segment parameter `t`: the integer part selects the segment, the fraction
 * runs from that control point to the next. `t` wraps modulo controlPoints.length.
 */
export function splinePointAt(track: Track, t: number, out: Vec3): void {
  const cps = track.controlPoints
  const n = cps.length
  const floor = Math.floor(t)
  const u = t - floor
  const seg = wrapIndex(floor, n)
  const a = cps[wrapIndex(seg - 1, n)].position
  const b = cps[seg].position
  const c = cps[wrapIndex(seg + 1, n)].position
  const d = cps[wrapIndex(seg + 2, n)].position
  out.x = catmullRom(a.x, b.x, c.x, d.x, u)
  out.y = catmullRom(a.y, b.y, c.y, d.y, u)
  out.z = catmullRom(a.z, b.z, c.z, d.z, u)
}

/** Unit tangent at segment parameter `t`. Falls back to +X on a degenerate segment. */
export function splineTangentAt(track: Track, t: number, out: Vec3): void {
  const cps = track.controlPoints
  const n = cps.length
  const floor = Math.floor(t)
  const u = t - floor
  const seg = wrapIndex(floor, n)
  const a = cps[wrapIndex(seg - 1, n)].position
  const b = cps[seg].position
  const c = cps[wrapIndex(seg + 1, n)].position
  const d = cps[wrapIndex(seg + 2, n)].position
  const dx = catmullRomDeriv(a.x, b.x, c.x, d.x, u)
  const dy = catmullRomDeriv(a.y, b.y, c.y, d.y, u)
  const dz = catmullRomDeriv(a.z, b.z, c.z, d.z, u)
  const len = Math.hypot(dx, dy, dz)
  if (len > 1e-12) {
    out.x = dx / len
    out.y = dy / len
    out.z = dz / len
  } else {
    out.x = 1
    out.y = 0
    out.z = 0
  }
}

/** Width at segment parameter `t`, linear between the two control points of the segment. */
export function widthAtSeg(track: Track, t: number): number {
  const cps = track.controlPoints
  const n = cps.length
  const floor = Math.floor(t)
  const u = t - floor
  const seg = wrapIndex(floor, n)
  const a = cps[seg].width
  const b = cps[wrapIndex(seg + 1, n)].width
  return a + (b - a) * u
}

/** Banking at segment parameter `t`, in radians, linear across the segment. */
export function bankingAtSeg(track: Track, t: number): number {
  const cps = track.controlPoints
  const n = cps.length
  const floor = Math.floor(t)
  const u = t - floor
  const seg = wrapIndex(floor, n)
  const a = cps[seg].banking
  const b = cps[wrapIndex(seg + 1, n)].banking
  return a + (b - a) * u
}

/** Surface of the segment containing `t`, taken from its start control point. */
export function surfaceOfSeg(track: Track, t: number): Surface {
  const cps = track.controlPoints
  return cps[wrapIndex(Math.floor(t), cps.length)].surface
}
```

- [ ] **Step 4: Run the spline core test to verify it passes**

Run: `npx vitest run packages/sim/test/track-query.test.ts -t "spline core"`

Expected: PASS — 7 passed.

---

- [ ] **Step 5: Write the failing test for the arc-length table**

First replace the import block at the top of `packages/sim/test/track-query.test.ts` with:

```ts
import { describe, expect, it } from 'vitest'
import { v3 } from '../src/vec3'
import {
  arcAt,
  bankingAtSeg,
  buildArcTable,
  catmullRom,
  locateS,
  SAMPLES_PER_SEGMENT,
  splinePointAt,
  splineTangentAt,
  surfaceOfSeg,
  widthAtSeg,
} from '../src/track'
import { makeCircleTrack, makeOvalTrack, makeStraightTrack } from './fixtures/track-fixtures'
```

Then append this block after the closing `})` of `describe('spline core', ...)`:

```ts
describe('arc-length table', () => {
  it('samples every segment and accumulates a monotonic length', () => {
    const tr = makeCircleTrack()
    const table = buildArcTable(tr)
    expect(table.segments).toBe(16)
    expect(table.samplesPerSegment).toBe(SAMPLES_PER_SEGMENT)
    expect(table.cum.length).toBe(16 * 64 + 1) // 1025
    expect(table.pts.length).toBe(1025 * 3)
    expect(table.cum[0]).toBe(0)
    for (let i = 1; i < table.cum.length; i++) {
      expect(table.cum[i]).toBeGreaterThan(table.cum[i - 1])
    }
    expect(table.total).toBe(table.cum[table.cum.length - 1])
  })

  it('measures a radius-100 circle as just under 2*pi*100', () => {
    // chord sums always undershoot the true arc; with 64 samples per segment the
    // shortfall is 0.183 m on 628.319 m, i.e. 0.029%
    const table = buildArcTable(makeCircleTrack())
    const circumference = 2 * Math.PI * 100 // 628.3185307179587
    expect(table.total).toBeLessThan(circumference)
    expect(circumference - table.total).toBeLessThan(0.5)
    expect(table.total).toBeCloseTo(628.135, 2) // pinned to SAMPLES_PER_SEGMENT = 64
  })

  it('locateS maps arc-normalised s onto the segment parameter', () => {
    const table = buildArcTable(makeCircleTrack())
    expect(locateS(table, 0)).toBe(0)
    expect(locateS(table, 1)).toBe(0) // s wraps
    // the circle fixture is uniform, so a quarter of the arc is 4 of the 16 segments
    expect(locateS(table, 0.25)).toBeCloseTo(4, 9)
    expect(locateS(table, 0.5)).toBeCloseTo(8, 9)
  })

  it('normalises s by arc length, not by control point index', () => {
    // straight fixture: 12 segments, but their lengths run from 50 m (the end cap)
    // to 300 m (the return leg). Parameter-normalised, s = 0.5 would be segment 6
    // (control point 6 at x = 740). Arc-normalised it is t = 7.997, i.e. control
    // point 8 at x = 600, because control point 8 sits at s = 0.500288.
    const table = buildArcTable(makeStraightTrack())
    expect(table.segments).toBe(12)
    expect(table.cum.length).toBe(12 * 64 + 1) // 769
    expect(locateS(table, 0.5)).toBeCloseTo(7.9973389, 6)
    expect(locateS(table, 0.5)).toBeGreaterThan(7)
    // and the reverse: control point 6 is at s = 0.414, not s = 6/12 = 0.5
    expect(arcAt(table, 6) / table.total).toBeCloseTo(0.4141583, 6)
  })

  it('arcAt converts a segment parameter back to metres and wraps', () => {
    const table = buildArcTable(makeStraightTrack())
    expect(table.total).toBeCloseTo(1828.3236243, 6)
    expect(arcAt(table, 0)).toBe(0)
    expect(arcAt(table, 11.999)).toBeCloseTo(1828.1734072, 5)
    expect(arcAt(table, 12)).toBe(0) // one full lap wraps back to the start line
  })

  it('locateS and arcAt round-trip', () => {
    const table = buildArcTable(makeStraightTrack())
    for (const s of [0.05, 0.2, 0.37, 0.5, 0.61, 0.83, 0.99]) {
      expect(arcAt(table, locateS(table, s)) / table.total).toBeCloseTo(s, 9)
    }
  })
})
```

- [ ] **Step 6: Run the arc table test to verify it fails**

Run: `npx vitest run packages/sim/test/track-query.test.ts -t "arc-length table"`

Expected: FAIL — `SyntaxError: The requested module '../src/track' does not provide an export named 'buildArcTable'`

- [ ] **Step 7: Write the arc-length table**

Append to the end of `packages/sim/src/track.ts`, after `surfaceOfSeg`:

```ts
/**
 * Flat sample cache for one track: `pts` holds SAMPLES_PER_SEGMENT positions per segment
 * plus one closing sample, `cum` holds the running chord length to each of them.
 * Sample index i corresponds to segment parameter t = i / samplesPerSegment.
 */
export interface ArcTable {
  pts: Float64Array
  cum: Float64Array
  samplesPerSegment: number
  segments: number
  total: number
}

/** Build the arc-length table for a track. Called once per query, never in the hot path. */
export function buildArcTable(track: Track): ArcTable {
  const segments = track.controlPoints.length
  const count = segments * SAMPLES_PER_SEGMENT + 1
  const pts = new Float64Array(count * 3)
  const cum = new Float64Array(count)
  const p = v3(0, 0, 0)
  for (let i = 0; i < count; i++) {
    splinePointAt(track, i / SAMPLES_PER_SEGMENT, p)
    pts[i * 3] = p.x
    pts[i * 3 + 1] = p.y
    pts[i * 3 + 2] = p.z
    if (i > 0) {
      const dx = pts[i * 3] - pts[(i - 1) * 3]
      const dy = pts[i * 3 + 1] - pts[(i - 1) * 3 + 1]
      const dz = pts[i * 3 + 2] - pts[(i - 1) * 3 + 2]
      cum[i] = cum[i - 1] + Math.hypot(dx, dy, dz)
    }
  }
  return { pts, cum, samplesPerSegment: SAMPLES_PER_SEGMENT, segments, total: cum[count - 1] }
}

/** Arc-normalised s (wrapping) -> segment parameter t. Binary search plus linear inset. */
export function locateS(table: ArcTable, s: number): number {
  const target = wrap01(s) * table.total
  const cum = table.cum
  let lo = 0
  let hi = cum.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (cum[mid] <= target) lo = mid
    else hi = mid
  }
  const span = cum[hi] - cum[lo]
  const f = span > 1e-12 ? (target - cum[lo]) / span : 0
  return (lo + f) / table.samplesPerSegment
}

/** Segment parameter t (wrapping) -> metres travelled from the start line. */
export function arcAt(table: ArcTable, t: number): number {
  const wrapped = t % table.segments
  const tt = wrapped < 0 ? wrapped + table.segments : wrapped
  const idx = tt * table.samplesPerSegment
  const lo = Math.min(Math.floor(idx), table.cum.length - 2)
  const f = idx - lo
  return table.cum[lo] + (table.cum[lo + 1] - table.cum[lo]) * f
}
```

- [ ] **Step 8: Run the arc table test to verify it passes**

Run: `npx vitest run packages/sim/test/track-query.test.ts -t "arc-length table"`

Expected: PASS — 6 passed.

---

- [ ] **Step 9: Write the failing test for point projection**

Replace the import block at the top of `packages/sim/test/track-query.test.ts` with:

```ts
import { describe, expect, it } from 'vitest'
import type { TrackProjection } from '../src/types'
import { v3 } from '../src/vec3'
import {
  arcAt,
  bankingAtSeg,
  buildArcTable,
  catmullRom,
  locateS,
  projectPoint,
  SAMPLES_PER_SEGMENT,
  splinePointAt,
  splineTangentAt,
  surfaceOfSeg,
  widthAtSeg,
} from '../src/track'
import { makeCircleTrack, makeOvalTrack, makeStraightTrack } from './fixtures/track-fixtures'
```

Then append this block after the closing `})` of `describe('arc-length table', ...)`:

```ts
function emptyProjection(): TrackProjection {
  return { s: 0, lateral: 0, distance: 0 }
}

describe('projectPoint', () => {
  it('puts a point on the centreline at zero lateral and zero distance', () => {
    // (300, 0, 0) is control point 2 of the straight fixture, which sits at s = 0.164306
    const tr = makeStraightTrack()
    const table = buildArcTable(tr)
    const out = emptyProjection()
    projectPoint(tr, table, v3(300, 0, 0), out)
    expect(out.s).toBeCloseTo(0.1643056, 6)
    expect(Math.abs(out.lateral)).toBeLessThan(1e-6)
    expect(out.distance).toBeLessThan(1e-6)
  })

  it('signs lateral positive toward +z when travelling +X', () => {
    // right = (-t.z, 0, t.x) and t = (1, 0, 0) on the straight, so right = (0, 0, 1)
    const tr = makeStraightTrack()
    const table = buildArcTable(tr)
    const out = emptyProjection()
    projectPoint(tr, table, v3(300, 0, 5), out)
    expect(out.lateral).toBeCloseTo(5, 9)
    expect(out.distance).toBeCloseTo(5, 9)
    expect(out.s).toBeCloseTo(0.1643056, 6)
    projectPoint(tr, table, v3(300, 0, -5), out)
    expect(out.lateral).toBeCloseTo(-5, 9)
    expect(out.distance).toBeCloseTo(5, 9)
  })

  it('ignores height: a kart in the air projects like a kart on the ground', () => {
    const tr = makeStraightTrack()
    const table = buildArcTable(tr)
    const ground = emptyProjection()
    const air = emptyProjection()
    projectPoint(tr, table, v3(300, 0, 5), ground)
    projectPoint(tr, table, v3(300, 7, 5), air)
    expect(air.s).toBe(ground.s)
    expect(air.lateral).toBe(ground.lateral)
    expect(air.distance).toBe(ground.distance)
  })

  it('projects onto a curved centreline with the inside of the circle positive', () => {
    // travel is counter-clockwise in the x-z plane, so at (100, 0, 0) the tangent is
    // (0, 0, 1) and right = (-1, 0, 0), which points at the centre. A point 50 m
    // outside the circle is therefore lateral -50; one 10 m inside is lateral +10.
    const tr = makeCircleTrack()
    const table = buildArcTable(tr)
    const out = emptyProjection()
    projectPoint(tr, table, v3(150, 0, 0), out)
    expect(out.lateral).toBeCloseTo(-50, 6)
    expect(out.distance).toBeCloseTo(50, 6)
    // this point sits exactly on the start line, so s may converge to either side of the
    // seam - 1e-9 or 1 - 1e-9 are the same place on a closed loop
    expect(Math.min(out.s, 1 - out.s)).toBeLessThan(1e-6)
    projectPoint(tr, table, v3(90, 0, 0), out)
    expect(out.lateral).toBeCloseTo(10, 6)
    expect(out.distance).toBeCloseTo(10, 6)
    projectPoint(tr, table, v3(0, 0, -150), out)
    expect(out.s).toBeCloseTo(0.75, 6)
    expect(out.lateral).toBeCloseTo(-50, 6)
  })

  it('projects onto the oval bottom straight with the expected s', () => {
    // the oval bottom straight runs +X at z = -100; control point 2 is (0, 0, -100)
    // at s = 0.140104. A point 6 m toward +z is 6 m to the right of travel.
    const tr = makeOvalTrack()
    const table = buildArcTable(tr)
    const out = emptyProjection()
    projectPoint(tr, table, v3(0, 0, -94), out)
    expect(out.s).toBeCloseTo(0.1401039, 6)
    expect(out.lateral).toBeCloseTo(6, 9)
    expect(out.distance).toBeCloseTo(6, 9)
    projectPoint(tr, table, v3(0, 0, -106), out)
    expect(out.s).toBeCloseTo(0.1401039, 6)
    expect(out.lateral).toBeCloseTo(-6, 9)
    expect(out.distance).toBeCloseTo(6, 9)
  })
})
```

- [ ] **Step 10: Run the projection test to verify it fails**

Run: `npx vitest run packages/sim/test/track-query.test.ts -t "projectPoint"`

Expected: FAIL — `SyntaxError: The requested module '../src/track' does not provide an export named 'projectPoint'`

- [ ] **Step 11: Write the projection**

Append to the end of `packages/sim/src/track.ts`, after `arcAt`:

```ts
/** Every 4th table sample is tested in the coarse pass, then its neighbourhood is refined. */
const COARSE_STRIDE = 4

/** Ternary-search steps. Each cuts the bracket to 2/3, so 40 steps reach ~1e-7 of a segment. */
const REFINE_ITERATIONS = 40

const projScratch = v3(0, 0, 0)
const projTangent = v3(0, 0, 0)

function distanceXZSq(track: Track, t: number, px: number, pz: number): number {
  splinePointAt(track, t, projScratch)
  const dx = projScratch.x - px
  const dz = projScratch.z - pz
  return dx * dx + dz * dz
}

/**
 * Closest point on the centreline to `p`, measured in the XZ plane so ride height never
 * leaks into the result. Coarse scan over the arc table, then a ternary search on the
 * winning bracket. Writes into `out`; allocates nothing.
 */
export function projectPoint(
  track: Track,
  table: ArcTable,
  p: Vec3,
  out: TrackProjection,
): void {
  const count = table.cum.length - 1 // the closing sample repeats index 0
  let bestIdx = 0
  let bestD2 = Infinity
  for (let i = 0; i < count; i += COARSE_STRIDE) {
    const dx = table.pts[i * 3] - p.x
    const dz = table.pts[i * 3 + 2] - p.z
    const d2 = dx * dx + dz * dz
    if (d2 < bestD2) {
      bestD2 = d2
      bestIdx = i
    }
  }
  for (let i = bestIdx - COARSE_STRIDE; i <= bestIdx + COARSE_STRIDE; i++) {
    const j = ((i % count) + count) % count
    const dx = table.pts[j * 3] - p.x
    const dz = table.pts[j * 3 + 2] - p.z
    const d2 = dx * dx + dz * dz
    if (d2 < bestD2) {
      bestD2 = d2
      bestIdx = j
    }
  }
  let lo = (bestIdx - 1) / table.samplesPerSegment
  let hi = (bestIdx + 1) / table.samplesPerSegment
  for (let i = 0; i < REFINE_ITERATIONS; i++) {
    const m1 = lo + (hi - lo) / 3
    const m2 = hi - (hi - lo) / 3
    if (distanceXZSq(track, m1, p.x, p.z) <= distanceXZSq(track, m2, p.x, p.z)) hi = m2
    else lo = m1
  }
  const t = (lo + hi) / 2
  splinePointAt(track, t, projScratch)
  const cx = projScratch.x
  const cz = projScratch.z
  splineTangentAt(track, t, projTangent)
  let rx = -projTangent.z
  let rz = projTangent.x
  const rl = Math.hypot(rx, rz)
  if (rl > 1e-12) {
    rx /= rl
    rz /= rl
  } else {
    rx = 0
    rz = 1
  }
  const dx = p.x - cx
  const dz = p.z - cz
  out.s = wrap01(arcAt(table, t) / table.total)
  out.lateral = dx * rx + dz * rz
  out.distance = Math.hypot(dx, dz)
}
```

- [ ] **Step 12: Run the projection test to verify it passes**

Run: `npx vitest run packages/sim/test/track-query.test.ts -t "projectPoint"`

Expected: PASS — 5 passed.

---

- [ ] **Step 13: Write the failing test for the assembled query**

Replace the import block at the top of `packages/sim/test/track-query.test.ts` with:

```ts
import { describe, expect, it } from 'vitest'
import type { TrackProjection } from '../src/types'
import { v3 } from '../src/vec3'
import {
  arcAt,
  bankingAtSeg,
  buildArcTable,
  buildTrackQuery,
  catmullRom,
  locateS,
  projectPoint,
  SAMPLES_PER_SEGMENT,
  splinePointAt,
  splineTangentAt,
  surfaceOfSeg,
  widthAtSeg,
} from '../src/track'
import { makeCircleTrack, makeOvalTrack, makeStraightTrack } from './fixtures/track-fixtures'
```

Then append this block after the closing `})` of `describe('projectPoint', ...)`:

```ts
describe('buildTrackQuery', () => {
  it('reports the arc length of each fixture', () => {
    expect(buildTrackQuery(makeStraightTrack()).totalLength()).toBeCloseTo(1828.3236243, 6)
    expect(buildTrackQuery(makeCircleTrack()).totalLength()).toBeCloseTo(628.1351367, 6)
    expect(buildTrackQuery(makeOvalTrack()).totalLength()).toBeCloseTo(1427.7555092, 6)
  })

  it('reads s as arc-normalised, so s = 30 is the start line and not 30 metres along', () => {
    const q = buildTrackQuery(makeStraightTrack())
    // wrap01(30) = 30 - Math.floor(30) = 0, so s = 30 IS s = 0, silently. This is the
    // single most error-prone thing in the package (contract section 0), so it is pinned.
    expect(q.sampleAt(30).position).toEqual({ x: 0, y: 0, z: 0 })
    expect(q.sampleAt(0).position).toEqual({ x: 0, y: 0, z: 0 })
    // 30 metres along is a completely different place: 30 / 1828.3236243268896 =
    // 0.016408473642648858 of the lap. The centreline there is (29.7252259, 0, -3.8633698)
    // rather than (30, 0, 0), because segment 0's Catmull-Rom window includes control
    // point 11 at (-140, 0, 60), which bows the curve toward -z as it leaves the origin.
    const sFor30m = 30 / q.totalLength()
    expect(sFor30m).toBeCloseTo(0.0164085, 7)
    const p = q.sampleAt(sFor30m)
    expect(p.position.x).toBeCloseTo(29.7252259, 6)
    expect(p.position.y).toBe(0)
    expect(p.position.z).toBeCloseTo(-3.8633698, 6)
  })

  it('resolves s by arc length, not by control point index', () => {
    // the straight fixture's segments are 50 m to 300 m long. Control point 6 is
    // (740, 0, 60) and sits at index 6 of 12, so a parameter-normalised s = 0.5 would
    // land there. By arc length s = 0.5 is next to control point 8, (600, 0, 120),
    // which sits at s = 0.500288.
    const q = buildTrackQuery(makeStraightTrack())
    const p = q.sampleAt(0.5)
    expect(p.position.x).toBeCloseTo(600.5310186, 4)
    expect(p.position.y).toBe(0)
    expect(p.position.z).toBeCloseTo(119.9598713, 4)
    expect(Math.abs(p.position.x - 740)).toBeGreaterThan(100)
  })

  it('advances s at a constant rate along the track', () => {
    // this is the property arc-normalisation exists for: 0.01 of s is 0.01 of the lap
    // everywhere, whether the control points there are 150 m apart or 300 m apart
    const q = buildTrackQuery(makeStraightTrack())
    const total = q.totalLength() // 1828.3236, so 0.01 of s is 18.2832 m
    const a = q.sampleAt(0.1)
    const ax = a.position.x
    const az = a.position.z
    const b = q.sampleAt(0.11)
    const bx = b.position.x
    const bz = b.position.z
    const c = q.sampleAt(0.6)
    const cx = c.position.x
    const cz = c.position.z
    const d = q.sampleAt(0.61)
    const dx = d.position.x
    const dz = d.position.z
    const near = Math.hypot(bx - ax, bz - az) // 18.283236
    const far = Math.hypot(dx - cx, dz - cz) // 18.284069
    expect(near).toBeCloseTo(0.01 * total, 1)
    expect(far).toBeCloseTo(0.01 * total, 1)
    expect(Math.abs(far - near)).toBeLessThan(0.01)
  })

  it('returns shared scratch objects that the caller must copy', () => {
    const q = buildTrackQuery(makeStraightTrack())
    expect(q.sampleAt(0)).toBe(q.sampleAt(0.5))
    expect(q.tangentAt(0)).toBe(q.tangentAt(0.5))
    expect(q.project(v3(0, 0, 0))).toBe(q.project(v3(300, 0, 0)))
    // the second call overwrites the first result in place
    const first = q.sampleAt(0)
    expect(first.position.x).toBe(0)
    q.sampleAt(0.5)
    expect(first.position.x).toBeCloseTo(600.5310186, 4)
    // but two queries never share scratch
    const other = buildTrackQuery(makeCircleTrack())
    expect(q.sampleAt(0)).not.toBe(other.sampleAt(0))
  })

  it('samples the circle fixture on its radius', () => {
    const q = buildTrackQuery(makeCircleTrack())
    expect(q.sampleAt(0).position).toEqual({ x: 100, y: 0, z: 0 })
    const t = q.tangentAt(0)
    expect(t.x).toBeCloseTo(0, 12)
    expect(t.y).toBe(0)
    expect(t.z).toBeCloseTo(1, 12)
    // Catmull-Rom through 16 circle points bows very slightly inside the true circle:
    // the midpoint of a segment sits at radius 99.944974 instead of 100
    const mid = q.sampleAt(0.03125)
    expect(Math.hypot(mid.position.x, mid.position.z)).toBeCloseTo(99.944974, 5)
    const quarter = q.sampleAt(0.25)
    expect(quarter.position.x).toBeCloseTo(0, 9)
    expect(quarter.position.z).toBeCloseTo(100, 9)
  })

  it('samples width, banking and surface from the oval', () => {
    // s = 0.35 is inside the right turn, between control points 5 (s = 0.3168) and
    // 9 (s = 0.4634), which are all 20 m wide and banked 0.2 rad
    const q = buildTrackQuery(makeOvalTrack())
    const p = q.sampleAt(0.35)
    expect(p.position.x).toBeCloseTo(284.006904, 4)
    expect(p.position.z).toBeCloseTo(-54.209059, 4)
    expect(p.width).toBe(20)
    expect(p.banking).toBe(0.2)
    expect(p.surface).toBe('tarmac')
    // s = 0 is the start of the 24 m wide flat bottom straight
    const start = q.sampleAt(0)
    expect(start.position).toEqual({ x: -200, y: 0, z: -100 })
    expect(start.width).toBe(24)
    expect(start.banking).toBe(0)
  })

  it('groundHeight adds the spline height and the banking cross-fall', () => {
    // banked 0.2 rad, so the cross-fall is lateral * tan(0.2) = lateral * 0.2027100355
    // and 6 m to the right of the centreline is 6 * 0.2027100355 = 1.2162602131 higher
    const oval = buildTrackQuery(makeOvalTrack())
    expect(oval.groundHeight(0.35, 0)).toBe(0)
    expect(oval.groundHeight(0.35, 6)).toBeCloseTo(1.2162602131, 9)
    expect(oval.groundHeight(0.35, -6)).toBeCloseTo(-1.2162602131, 9)
    // the straight fixture has no banking at all, so lateral changes nothing
    const flat = buildTrackQuery(makeStraightTrack())
    expect(flat.groundHeight(0.2, 8)).toBe(0)
    // raise control point 2 to y = 10 and the height at that point follows the spline
    const base = makeStraightTrack()
    const hilly = buildTrackQuery(
      makeStraightTrack({
        controlPoints: base.controlPoints.map((p, i) => ({
          ...p,
          position: v3(p.position.x, i === 2 ? 10 : 0, p.position.z),
        })),
      }),
    )
    const sAtHill = hilly.project(v3(300, 0, 0)).s // control point 2 is (300, *, 0)
    expect(sAtHill).toBeCloseTo(0.1644481, 6)
    expect(hilly.groundHeight(sAtHill, 0)).toBeCloseTo(10, 6)
  })

  it('surfaceAt gives offtrack first, then boost pads, then the segment surface', () => {
    const q = buildTrackQuery(makeOvalTrack())
    // right turn: 20 m wide, so the edge is at |lateral| = 10
    expect(q.surfaceAt(0.35, 0)).toBe('tarmac')
    expect(q.surfaceAt(0.35, 9.9)).toBe('tarmac')
    expect(q.surfaceAt(0.35, 10.1)).toBe('offtrack')
    // boost pad at s = 0.1, lateral 0, halfWidth 4. Its longitudinal half-extent is
    // BOOST_PAD_HALF_LENGTH / totalLength = 4 / 1427.7555 = 0.0028016 of s
    expect(q.surfaceAt(0.1, 0)).toBe('boost')
    expect(q.surfaceAt(0.1, 3)).toBe('boost')
    expect(q.surfaceAt(0.1, 5)).toBe('tarmac') // outside the pad laterally
    expect(q.surfaceAt(0.105, 0)).toBe('tarmac') // 0.005 * 1427.76 = 7.1 m past the pad
    expect(q.surfaceAt(0.1, 13)).toBe('offtrack') // offtrack beats the pad (24 m wide here)
    // control points 12 and 13 are dirt, so s in [0.640104, 0.780208) is dirt
    expect(q.surfaceAt(0.63, 0)).toBe('tarmac')
    expect(q.surfaceAt(0.65, 0)).toBe('dirt')
    expect(q.surfaceAt(0.77, 0)).toBe('dirt')
    expect(q.surfaceAt(0.79, 0)).toBe('tarmac')
  })

  it('isInBounds allows one half-width of run-off past each edge', () => {
    const q = buildTrackQuery(makeOvalTrack())
    // bottom straight is 24 m wide: edge at 12, out of bounds past 24
    expect(q.isInBounds(0.02, 0)).toBe(true)
    expect(q.isInBounds(0.02, 24)).toBe(true)
    expect(q.isInBounds(0.02, -24)).toBe(true)
    expect(q.isInBounds(0.02, 24.001)).toBe(false)
    // right turn is 20 m wide: out of bounds past 20
    expect(q.isInBounds(0.35, 20)).toBe(true)
    expect(q.isInBounds(0.35, 20.001)).toBe(false)
  })

  it('checkpointIndexAt returns the last checkpoint passed, and wraps', () => {
    // oval ring is [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875]
    const oval = buildTrackQuery(makeOvalTrack())
    expect(oval.checkpointIndexAt(0)).toBe(0)
    expect(oval.checkpointIndexAt(0.124)).toBe(0)
    expect(oval.checkpointIndexAt(0.125)).toBe(1)
    expect(oval.checkpointIndexAt(0.9)).toBe(7)
    expect(oval.checkpointIndexAt(0.999)).toBe(7)
    expect(oval.checkpointIndexAt(1.125)).toBe(1) // s wraps
    expect(oval.checkpointIndexAt(-0.001)).toBe(7) // and wraps backwards
    // a ring that does not start at 0: anything before the first checkpoint belongs to
    // the last one, because the kart crossed it on the previous lap
    const shifted = buildTrackQuery(makeStraightTrack({ checkpointS: [0.1, 0.4, 0.7] }))
    expect(shifted.checkpointIndexAt(0.05)).toBe(2)
    expect(shifted.checkpointIndexAt(0.1)).toBe(0)
    expect(shifted.checkpointIndexAt(0.39)).toBe(0)
    expect(shifted.checkpointIndexAt(0.4)).toBe(1)
    expect(shifted.checkpointIndexAt(0.95)).toBe(2)
  })

  it('project matches projectPoint on the same track', () => {
    const tr = makeStraightTrack()
    const table = buildArcTable(tr)
    const q = buildTrackQuery(tr)
    const direct: TrackProjection = { s: 0, lateral: 0, distance: 0 }
    projectPoint(tr, table, v3(300, 0, 5), direct)
    const viaQuery = q.project(v3(300, 0, 5))
    expect(viaQuery.s).toBe(direct.s)
    expect(viaQuery.lateral).toBe(direct.lateral)
    expect(viaQuery.distance).toBe(direct.distance)
    expect(direct.lateral).toBeCloseTo(5, 9)
  })
})
```

- [ ] **Step 14: Run the query test to verify it fails**

Run: `npx vitest run packages/sim/test/track-query.test.ts -t "buildTrackQuery"`

Expected: FAIL — `SyntaxError: The requested module '../src/track' does not provide an export named 'buildTrackQuery'`

- [ ] **Step 15: Write buildTrackQuery**

Append to the end of `packages/sim/src/track.ts`, after `projectPoint`:

```ts
/**
 * Build the runtime query for a track. The arc-length table is built once, here, so every
 * method is a table lookup plus a cubic evaluation.
 *
 * `sampleAt`, `tangentAt` and `project` each return the same scratch object on every call
 * and overwrite it in place: `step()` must not allocate in the hot path. Copy any field
 * you need to keep before calling the query again.
 */
export function buildTrackQuery(track: Track): TrackQuery {
  const table = buildArcTable(track)
  const point: TrackPoint = { position: v3(0, 0, 0), width: 0, banking: 0, surface: 'tarmac' }
  const tangent = v3(0, 0, 0)
  const projection: TrackProjection = { s: 0, lateral: 0, distance: 0 }
  const scratch = v3(0, 0, 0)
  const padHalfS = BOOST_PAD_HALF_LENGTH / table.total

  return {
    sampleAt(s: number): TrackPoint {
      const t = locateS(table, s)
      splinePointAt(track, t, point.position)
      point.width = widthAtSeg(track, t)
      point.banking = bankingAtSeg(track, t)
      point.surface = surfaceOfSeg(track, t)
      return point
    },

    tangentAt(s: number): Vec3 {
      splineTangentAt(track, locateS(table, s), tangent)
      return tangent
    },

    project(p: Vec3): TrackProjection {
      projectPoint(track, table, p, projection)
      return projection
    },

    groundHeight(s: number, lateral: number): number {
      const t = locateS(table, s)
      splinePointAt(track, t, scratch)
      // banking is a roll angle in radians; positive banking lifts the +lateral side
      return scratch.y + lateral * Math.tan(bankingAtSeg(track, t))
    },

    surfaceAt(s: number, lateral: number): Surface {
      const t = locateS(table, s)
      if (Math.abs(lateral) > widthAtSeg(track, t) / 2) return 'offtrack'
      const ws = wrap01(s)
      for (let i = 0; i < track.boostPads.length; i++) {
        const pad = track.boostPads[i]
        let ds = Math.abs(ws - pad.s)
        if (ds > 0.5) ds = 1 - ds // the loop is closed
        if (ds <= padHalfS && Math.abs(lateral - pad.lateral) <= pad.halfWidth) return 'boost'
      }
      return surfaceOfSeg(track, t)
    },

    isInBounds(s: number, lateral: number): boolean {
      const t = locateS(table, s)
      return Math.abs(lateral) <= (widthAtSeg(track, t) / 2) * BOUNDS_HALF_WIDTH_MUL
    },

    checkpointIndexAt(s: number): number {
      const ws = wrap01(s)
      const cs = track.checkpointS
      // before the first checkpoint means the last one, crossed on the previous lap.
      // validateTrack rejects an empty ring, so cs.length is at least 1 in a real race.
      let idx = cs.length - 1
      for (let i = 0; i < cs.length; i++) {
        if (cs[i] <= ws) idx = i
      }
      return idx
    },

    totalLength(): number {
      return table.total
    },
  }
}
```

- [ ] **Step 16: Run the query test to verify it passes**

Run: `npx vitest run packages/sim/test/track-query.test.ts`

Expected: PASS — 30 passed (7 spline core + 6 arc-length table + 5 projectPoint +
12 buildTrackQuery).

---

- [ ] **Step 17: Write the failing test for makeContext**

Append to `packages/sim/test/track-query.test.ts`, after the closing `})` of
`describe('buildTrackQuery', ...)`, and add `makeContext` to the existing
`./fixtures/track-fixtures` import at the top of the file so it reads:

```ts
import {
  makeCircleTrack,
  makeContext,
  makeOvalTrack,
  makeStraightTrack,
} from './fixtures/track-fixtures'
```

```ts
describe('makeContext', () => {
  it('builds a leader context by default', () => {
    const track = makeStraightTrack()
    const ctx = makeContext(track)
    expect(ctx.track).toBe(track)
    expect(ctx.isLeader).toBe(true)
    expect(ctx.tuning.maxSpeed).toBe(40)
    expect(ctx.tuning.kartRadius).toBe(0.9)
    expect(ctx.characters).toHaveLength(8)
    expect(ctx.characters[5].speed).toBe(1.15)
    expect(ctx.query.totalLength()).toBeCloseTo(1828.3236243, 6)
  })

  it('builds a follower context when isLeader is false', () => {
    const ctx = makeContext(makeOvalTrack(), false)
    expect(ctx.isLeader).toBe(false)
    expect(ctx.query.totalLength()).toBeCloseTo(1427.7555092, 6)
    expect(ctx.query.sampleAt(0).position).toEqual({ x: -200, y: 0, z: -100 })
  })

  it('gives every context its own query and its own scratch', () => {
    const a = makeContext(makeStraightTrack())
    const b = makeContext(makeStraightTrack())
    expect(a.query).not.toBe(b.query)
    expect(a.query.sampleAt(0)).not.toBe(b.query.sampleAt(0))
  })
})
```

- [ ] **Step 18: Run the makeContext test to verify it fails**

Run: `npx vitest run packages/sim/test/track-query.test.ts -t "makeContext"`

Expected: FAIL — `SyntaxError: The requested module './fixtures/track-fixtures' does not provide an export named 'makeContext'`

- [ ] **Step 19: Write makeContext**

In `packages/sim/test/fixtures/track-fixtures.ts`, change the import block at the top from:

```ts
import type { CharacterStats, Surface, Track, TrackPoint, Tuning } from '../../src/types'
import { v3 } from '../../src/vec3'
```

to:

```ts
import type {
  CharacterStats,
  SimContext,
  Surface,
  Track,
  TrackPoint,
  Tuning,
} from '../../src/types'
import { buildTrackQuery } from '../../src/track'
import { v3 } from '../../src/vec3'
```

Then append to the end of the file, after `makeOvalTrack`:

```ts
/**
 * A SimContext over a fixture track: base tuning, the 8 fixture characters, and a freshly
 * built TrackQuery. `isLeader` defaults to true because most tests want the authority that
 * rolls items and advances the RNG cursor.
 */
export function makeContext(track: Track, isLeader = true): SimContext {
  return {
    track,
    query: buildTrackQuery(track),
    tuning: makeTuning(),
    characters: makeCharacters(),
    isLeader,
  }
}
```

- [ ] **Step 20: Run the makeContext test to verify it passes**

Run: `npx vitest run packages/sim/test/track-query.test.ts`

Expected: PASS — 33 passed (the 30 above plus the 3 `makeContext` tests).

- [ ] **Step 21: Typecheck and run the whole sim suite**

Run: `npx tsc --noEmit -p packages/sim && npx vitest run packages/sim`

Expected: PASS — no TypeScript errors; `track-query.test.ts` 33 passed, plus the 31 from
Task 3's `track-fixtures.test.ts` (7) and `track-validate.test.ts` (24), plus the 50 Task 2
left (2 scaffold, 7 types, 17 vec3, 15 mathutil, 9 rng) — 114 in `packages/sim` overall.

- [ ] **Step 22: Commit**

```bash
git add packages/sim/src/track.ts packages/sim/test/fixtures/track-fixtures.ts packages/sim/test/track-query.test.ts
git commit -m "feat(sim): arc-length track query over a closed Catmull-Rom centreline"
```

---

### Task 5: SimState lifecycle (`createState` / `cloneState` / `statesEqual` / `emit`) and the empty `step()`

This task builds the state container that every later task writes into, plus the
tick loop skeleton. Nothing simulates yet: `step()` copies `prev` into `next` and
advances the tick counter. Tasks 6–15 insert their stage calls into that loop.

**Files:**
- Create: `packages/sim/src/state.ts`
- Create: `packages/sim/src/step.ts`
- Create: `packages/sim/test/helpers/flat-context.ts`
- Test: `packages/sim/test/state.test.ts`
- Test: `packages/sim/test/step.test.ts`

**Interfaces:**

- Consumes (all already exist):
  - `packages/sim/src/types.ts` [Task 2] — the types `Vec3`, `Surface`, `ItemKind`,
    `EntityKind`, `RacePhase`, `Intent`, `DriftState`, `LapProgress`, `KartState`,
    `EntityState`, `ItemBoxState`, `SimState`, `AuthEventKind`, `AuthEvent`,
    `TrackPoint`, `Track`, `CharacterStats`, `Tuning`, `SimContext`,
    `TrackProjection`, `TrackQuery`; and the value constants
    `TICK_HZ = 60`, `TICK_DT = 1/60`, `MAX_KARTS = 8`, `MAX_ENTITIES = 32`,
    `RACE_LAPS = 3`, `COUNTDOWN_TICKS = 180`.
  - `packages/sim/src/vec3.ts` [Task 2] — `v3(x: number, y: number, z: number): Vec3`
  - `packages/sim/src/mathutil.ts` [Task 2] — `clamp(v: number, lo: number, hi: number): number`,
    `wrapAngle(a: number): number`
  - `packages/sim/test/fixtures/track-fixtures.ts` [Task 3] —
    `makeTuning(overrides?: Partial<Tuning>): Tuning`, `makeCharacters(): CharacterStats[]`

- Produces (later tasks rely on these verbatim):
  - `createState(ctx: SimContext, seed: number, characterIdx: number[]): SimState`
  - `cloneState(src: SimState, dst: SimState): void`
  - `statesEqual(a: SimState, b: SimState): boolean`
  - `emit(state: SimState, out: AuthEvent[], kind: AuthEventKind, playerId: number, entityId: number, item: ItemKind, data: number): void`
  - `step(ctx: SimContext, prev: SimState, next: SimState, inputs: Intent[], events: AuthEvent[]): void`
  - `packages/sim/test/helpers/flat-context.ts` — `makeFlatQuery(): TrackQuery`,
    `makeFlatTrack(startPositions: { s: number; lateral: number }[]): Track`,
    `makeTestContext(startPositions: { s: number; lateral: number }[]): SimContext`,
    `EIGHT_STARTS: { s: number; lateral: number }[]`

- Decisions this task makes that the locked contract does not pin, stated so
  later tasks can depend on them:
  - **`makeFlatQuery` obeys the contract's `s` rule: `s` is arc-normalized to
    `[0, 1)`, never metres.** The flat track is 1000 m long, so `s = 0.25` is
    250 m along and `project()` returns `wrap01(p.x / 1000)`. Every consumer of
    this helper — Tasks 6, 7, 8, 9, 11 and 16 all build contexts from it — must
    write track offsets as fractions: 6 m of bot lookahead is `6 / 1000`, and the
    grid slots in `EIGHT_STARTS` are `0, 0.004, 0.008 …`, i.e. 0 m, 4 m, 8 m.
    `groundHeight(s, lateral)` returns `0.5 * (s * 1000)` — half the arc distance
    **in metres** — so it is still deliberately non-constant and every existing
    world-space expectation (`y = 2` at 4 m) is unchanged.
  - Every seat starts `isBot: true`, `connected: false`. The lobby/net layer flips
    these before the race; nothing in `sim` special-cases seat 0.
  - `characterIdx` entries are truncated toward zero and clamped into
    `[0, ctx.characters.length - 1]`; a missing or non-finite entry becomes `0`.
  - `lap` starts at `{ lap: 0, checkpointIdx: ctx.track.checkpointS.length - 1, t: 0 }`,
    which is the locked contract's value — **not** `-1`. A kart on the grid sits
    *behind* checkpoint 0, i.e. it is already credited with the final checkpoint
    of the notional previous lap, so its first legal crossing is index 0. Task 11
    computes `next = cur + 1 >= n ? 0 : cur + 1`, which yields `0` from
    `cur = n - 1`. `-1` is not a valid checkpoint index and would leave
    `k.lap.checkpointIdx` outside `[0, n)` in every snapshot until the first
    crossing. On this task's 4-checkpoint flat test track the initial value is
    therefore **`3`**. `createState` guards the degenerate case explicitly: a
    track with `checkpointS.length === 0` has no last checkpoint, so its karts get
    `-1` — a value Task 11 never acts on, because `updateLaps` returns
    immediately when `checkpointS.length < 2`.
    Task 11 owns every transition out of the initial value.
  - `nextEntityId` starts at `1`, so the first spawned entity has `entityId === 1`
    and the dead-slot sentinel `-1` can never collide with a live id.
  - `finishedOrder` is a **fixed-length** `number[]` of length exactly `MAX_KARTS`
    (8), created full of `-1`, and it stays length 8 for the whole race. It is
    never `push`ed to, never `pop`ped, never resized and never replaced. A kart
    that finishes is written into the **first slot holding `-1`**; the finisher
    count is the number of entries `!== -1`; "has kart `p` finished?" is a scan of
    the 8 slots for `=== p`, not `indexOf(p) >= 0` on a growable list. Tasks 11
    and 15 are the only writers and both obey this.
    This is not a stylistic preference: `cloneState` below checks
    `dst.finishedOrder.length === src.finishedOrder.length` (together with
    `karts`, `entities` and `itemBoxes`) and throws
    `'cloneState: dst was not preallocated with the same shape as src'` when it
    differs, so a single `push` past 8 makes the next `cloneState` — and
    therefore every `step()`, `recordRun` and `replayRun` after it — throw.
    Fixed length is also what keeps `cloneState` allocation-free.
  - Dead entity slots carry `entityId: -1`, `ownerId: -1`, `targetId: -1`,
    `ttl: 0`, `kind: 'seeker'`. `kind` is meaningless while `entityId === -1`, but
    it is still copied and still compared, so despawn must leave deterministic
    residue (it does: same code path, same residue).
  - `statesEqual` compares **all** `MAX_ENTITIES` slots and **all** `MAX_KARTS`
    `finishedOrder` slots, live or not. That is what makes it bit-exact.
  - `emit` is the one place the sim allocates per call (it pushes an object onto
    the caller's array). Event volume is per-event, not per-tick, and the
    contract's signature takes an `AuthEvent[]`, so this is intended.
  - `step()` clones `prev` into `next` at the top of the tick. That is what makes
    "never mutates `prev`" true for every later stage: every stage writes only
    into `next`.

- Convention reminders that this task must obey exactly:
  - `forward = (cos h, 0, sin h)`, `h = Math.atan2(dir.z, dir.x)`,
    `right = (-t.z, 0, t.x)` normalized, positive `lateral` is right of travel,
    up is `+y`. **The `right` formula is the authority.** On a track whose tangent
    is `(1, 0, 0)` it yields `right = (0, 0, 1)`, so positive lateral offsets a
    start position toward `+z`.
  - Every stored heading passes through `wrapAngle` → `(-π, π]`.
  - Imports are extensionless (`from './types'`) and type-only imports use
    `import type { ... }`.

---

- [ ] **Step 1: Write the failing test for `createState`**

First create the shared test helper. It gives every sim test an analytic,
perfectly flat track query so expected values are hand-computable — the real
spline query from Task 3 is exercised by Task 3's own tests, not here.

Create `packages/sim/test/helpers/flat-context.ts`:

```typescript
import type {
  CharacterStats,
  SimContext,
  Surface,
  Track,
  TrackPoint,
  TrackProjection,
  TrackQuery,
  Vec3,
} from '../../src/types'
import { makeCharacters, makeTuning } from '../fixtures/track-fixtures'

/** The flat track's arc length in metres. `s` is arc length / this. */
const FLAT_TOTAL_LENGTH = 1000

/**
 * Fractional part of `s`, in `[0, 1)` — the track is a closed loop.
 *
 * Declared locally because `track.ts`'s own `wrap01` (Task 4) is private to that
 * module, and this helper must not depend on anything Task 4 does not export.
 */
function wrap01(s: number): number {
  const w = s - Math.floor(s)
  return w >= 1 ? 0 : w
}

/**
 * An analytic TrackQuery for a dead-straight 1000 m track running along +X.
 *
 * `s` is arc-NORMALIZED to [0, 1), exactly as the locked contract requires:
 * s = 0.25 is 250 m along, not 0.25 m. Metres are reached only by multiplying an
 * s-delta by totalLength().
 *
 *   sampleAt(s)          -> centerline point (s * 1000, 0, 0)
 *   tangentAt(s)         -> (1, 0, 0), so right = (-t.z, 0, t.x) = (0, 0, 1)
 *   project(p)           -> s = wrap01(p.x / 1000), lateral = p.z
 *   groundHeight(s, lat) -> 0.5 * (s * 1000), i.e. half the arc distance in
 *                           metres (deliberately NOT constant, so a test can
 *                           prove the query was actually consulted)
 *   surfaceAt(s, lat)    -> 'dirt' when lateral > 2, otherwise 'tarmac'
 *   checkpointIndexAt(s) -> floor(s * 4) clamped to 0..3, matching the four
 *                           checkpoints at s = 0, 0.25, 0.5, 0.75
 */
export function makeFlatQuery(): TrackQuery {
  return {
    sampleAt(s: number): TrackPoint {
      return {
        position: { x: s * FLAT_TOTAL_LENGTH, y: 0, z: 0 },
        width: 20,
        banking: 0,
        surface: 'tarmac',
      }
    },
    tangentAt(_s: number): Vec3 {
      return { x: 1, y: 0, z: 0 }
    },
    project(p: Vec3): TrackProjection {
      return {
        s: wrap01(p.x / FLAT_TOTAL_LENGTH),
        lateral: p.z,
        distance: Math.abs(p.y),
      }
    },
    groundHeight(s: number, _lateral: number): number {
      return 0.5 * (s * FLAT_TOTAL_LENGTH)
    },
    surfaceAt(_s: number, lateral: number): Surface {
      return lateral > 2 ? 'dirt' : 'tarmac'
    },
    isInBounds(_s: number, lateral: number): boolean {
      return Math.abs(lateral) <= 10
    },
    checkpointIndexAt(s: number): number {
      return Math.max(0, Math.min(3, Math.floor(wrap01(s) * 4)))
    },
    totalLength(): number {
      return FLAT_TOTAL_LENGTH
    },
  }
}

/**
 * A straight 1000 m track along +X with exactly 3 item boxes and 4 checkpoints.
 * Every `s` here is arc-normalized: the checkpoints sit at 0 m, 250 m, 500 m and
 * 750 m, the item boxes at 100 m, 300 m and 600 m.
 */
export function makeFlatTrack(startPositions: { s: number; lateral: number }[]): Track {
  return {
    id: 'flat',
    name: 'Flat Test Straight',
    controlPoints: [
      { position: { x: 0, y: 0, z: 0 }, width: 20, banking: 0, surface: 'tarmac' },
      { position: { x: 500, y: 0, z: 0 }, width: 20, banking: 0, surface: 'tarmac' },
      { position: { x: 1000, y: 0, z: 0 }, width: 20, banking: 0, surface: 'tarmac' },
    ],
    checkpointS: [0, 0.25, 0.5, 0.75],
    itemBoxes: [
      { s: 0.1, lateral: 0 },
      { s: 0.3, lateral: 2 },
      { s: 0.6, lateral: -2 },
    ],
    ramps: [],
    boostPads: [],
    startPositions,
    bounds: { min: { x: -50, y: -10, z: -50 }, max: { x: 1050, y: 10, z: 50 } },
  }
}

export function makeTestContext(startPositions: { s: number; lateral: number }[]): SimContext {
  const characters: CharacterStats[] = makeCharacters()
  return {
    track: makeFlatTrack(startPositions),
    query: makeFlatQuery(),
    tuning: makeTuning(),
    characters,
    isLeader: true,
  }
}

/**
 * Eight grid slots, 4 m apart. `s` is arc-normalized, so `0.004` is 4 m along the
 * 1000 m lap and `sampleAt` puts that seat at world x = 4. Seat 2 sits 3 m right
 * of the centerline (+z), seat 3 sits 3 m left.
 */
export const EIGHT_STARTS: { s: number; lateral: number }[] = [
  { s: 0, lateral: 0 }, // 0 m
  { s: 0.004, lateral: 0 }, // 4 m
  { s: 0.008, lateral: 3 }, // 8 m
  { s: 0.012, lateral: -3 }, // 12 m
  { s: 0.016, lateral: 0 }, // 16 m
  { s: 0.02, lateral: 0 }, // 20 m
  { s: 0.024, lateral: 0 }, // 24 m
  { s: 0.028, lateral: 0 }, // 28 m
]
```

Now create `packages/sim/test/state.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import { MAX_ENTITIES, MAX_KARTS } from '../src/types'
import { EIGHT_STARTS, makeTestContext } from './helpers/flat-context'
import { createState } from '../src/state'

describe('createState', () => {
  it('places every kart at its start position, facing along the tangent', () => {
    const ctx = makeTestContext(EIGHT_STARTS)
    const st = createState(ctx, 12345, [0, 1, 2, 3, 4, 5, 6, 7])

    // s is arc-normalized. The flat query gives sampleAt(s) = (s * 1000, 0, 0)
    // and tangentAt(s) = (1, 0, 0), so right = (-t.z, 0, t.x) = (0, 0, 1):
    // +lateral offsets toward +z. groundHeight(s) = 0.5 * (s * 1000).
    // Every s * 1000 below is exact in binary floating point (0.004 * 1000 === 4).
    // Seat 0: s = 0,     lateral = 0  -> x = 0,  z = 0,  y = 0.5 * 0  = 0
    expect(st.karts[0].position.x).toBe(0)
    expect(st.karts[0].position.z).toBe(0)
    expect(st.karts[0].position.y).toBe(0)
    // Seat 1: s = 0.004, lateral = 0  -> x = 4,  z = 0,  y = 0.5 * 4  = 2
    expect(st.karts[1].position.x).toBe(4)
    expect(st.karts[1].position.z).toBe(0)
    expect(st.karts[1].position.y).toBe(2)
    // Seat 2: s = 0.008, lateral = 3  -> x = 8 + 0*3 = 8, z = 0 + 1*3 = 3, y = 0.5*8  = 4
    expect(st.karts[2].position.x).toBe(8)
    expect(st.karts[2].position.z).toBe(3)
    expect(st.karts[2].position.y).toBe(4)
    // Seat 3: s = 0.012, lateral = -3 -> x = 12, z = -3, y = 0.5 * 12 = 6
    expect(st.karts[3].position.x).toBe(12)
    expect(st.karts[3].position.z).toBe(-3)
    expect(st.karts[3].position.y).toBe(6)

    // heading = wrapAngle(atan2(t.z, t.x)) = wrapAngle(atan2(0, 1)) = 0
    for (let i = 0; i < MAX_KARTS; i++) {
      expect(st.karts[i].heading).toBe(0)
      expect(st.karts[i].angularVelocity).toBe(0)
      expect(st.karts[i].velocity.x).toBe(0)
      expect(st.karts[i].velocity.y).toBe(0)
      expect(st.karts[i].velocity.z).toBe(0)
    }

    // surfaceAt is consulted with (s, lateral): 'dirt' only where lateral > 2.
    expect(st.karts[2].surface).toBe('dirt')
    expect(st.karts[3].surface).toBe('tarmac')
    expect(st.karts[0].surface).toBe('tarmac')
  })

  it('starts the race in countdown with every counter zeroed', () => {
    const ctx = makeTestContext(EIGHT_STARTS)
    const st = createState(ctx, 12345, [0, 1, 2, 3, 4, 5, 6, 7])

    expect(st.tick).toBe(0)
    expect(st.phase).toBe('countdown')
    expect(st.raceSeed).toBe(12345)
    expect(st.rngCursor).toBe(0)
    expect(st.nextEventSeq).toBe(0)
    expect(st.finishTick).toBe(-1)
    expect(st.entityCount).toBe(0)
    expect(st.nextEntityId).toBe(1)
  })

  it('preallocates every array to its fixed length with dead slots marked -1', () => {
    const ctx = makeTestContext(EIGHT_STARTS)
    const st = createState(ctx, 1, [0, 0, 0, 0, 0, 0, 0, 0])

    expect(st.karts).toHaveLength(MAX_KARTS) // 8
    expect(st.entities).toHaveLength(MAX_ENTITIES) // 32
    expect(st.finishedOrder).toHaveLength(MAX_KARTS) // 8
    expect(st.itemBoxes).toHaveLength(3) // the flat track declares 3 item boxes

    for (let i = 0; i < MAX_ENTITIES; i++) {
      expect(st.entities[i].entityId).toBe(-1)
      expect(st.entities[i].ownerId).toBe(-1)
      expect(st.entities[i].targetId).toBe(-1)
      expect(st.entities[i].ttl).toBe(0)
      expect(st.entities[i].heading).toBe(0)
      expect(st.entities[i].position.x).toBe(0)
      expect(st.entities[i].velocity.z).toBe(0)
    }
    for (let i = 0; i < MAX_KARTS; i++) {
      expect(st.finishedOrder[i]).toBe(-1)
    }
    for (let i = 0; i < 3; i++) {
      expect(st.itemBoxes[i].boxIdx).toBe(i)
      expect(st.itemBoxes[i].respawnTicks).toBe(0)
    }
  })

  it('clamps characterIdx into range and defaults unsupplied seats to 0', () => {
    const ctx = makeTestContext(EIGHT_STARTS)
    // makeCharacters() returns exactly 8 characters, so the valid range is 0..7.
    const st = createState(ctx, 1, [7, 99, -3, 2.9])

    expect(st.karts[0].characterIdx).toBe(7) // in range
    expect(st.karts[1].characterIdx).toBe(7) // 99 clamped down to 8 - 1 = 7
    expect(st.karts[2].characterIdx).toBe(0) // -3 clamped up to 0
    expect(st.karts[3].characterIdx).toBe(2) // 2.9 truncated toward zero
    expect(st.karts[4].characterIdx).toBe(0) // seat not supplied
    expect(st.karts[7].characterIdx).toBe(0) // seat not supplied

    expect(st.karts[0].playerId).toBe(0)
    expect(st.karts[7].playerId).toBe(7)
    expect(st.karts[0].isBot).toBe(true)
    expect(st.karts[0].connected).toBe(false)
    expect(st.karts[0].item).toBe('none')
    expect(st.karts[0].airborne).toBe(false)
    expect(st.karts[0].shielded).toBe(false)
    expect(st.karts[0].spinOutTicks).toBe(0)
    expect(st.karts[0].invulnTicks).toBe(0)
    expect(st.karts[0].boostTicks).toBe(0)
    expect(st.karts[0].respawnTicks).toBe(0)
    expect(st.karts[0].drift.active).toBe(false)
    expect(st.karts[0].drift.dir).toBe(0)
    expect(st.karts[0].drift.charge).toBe(0)
    expect(st.karts[0].lap.lap).toBe(0)
    // The flat track declares 4 checkpoints, so the contract's initial value
    // checkpointS.length - 1 is 3. See the dedicated test below.
    expect(st.karts[0].lap.checkpointIdx).toBe(3)
    expect(st.karts[0].lap.t).toBe(0)
  })

  it('starts every kart behind checkpoint 0, at checkpointS.length - 1', () => {
    const ctx = makeTestContext(EIGHT_STARTS)
    const st = createState(ctx, 1, [])

    // The flat track declares 4 checkpoints (s = 0, 0.25, 0.5, 0.75), so the
    // initial index is 4 - 1 = 3: the kart is credited with the last checkpoint
    // of the notional previous lap, and its first legal crossing is index 0.
    for (let i = 0; i < MAX_KARTS; i++) {
      expect(st.karts[i].lap.checkpointIdx).toBe(3)
      expect(st.karts[i].lap.lap).toBe(0)
      expect(st.karts[i].lap.t).toBe(0)
    }

    // Two checkpoints -> 2 - 1 = 1.
    const twoCtx = makeTestContext(EIGHT_STARTS)
    twoCtx.track = { ...twoCtx.track, checkpointS: [0, 0.5] }
    expect(createState(twoCtx, 1, []).karts[0].lap.checkpointIdx).toBe(1)

    // A track with no checkpoints has no last index at all, so createState
    // writes -1 explicitly instead of computing 0 - 1 and calling it an index.
    const noneCtx = makeTestContext(EIGHT_STARTS)
    noneCtx.track = { ...noneCtx.track, checkpointS: [] }
    expect(createState(noneCtx, 1, []).karts[0].lap.checkpointIdx).toBe(-1)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/sim/test/state.test.ts -t "places every kart at its start position"`

Expected: FAIL with `Failed to resolve import "../src/state"` (the module does not
exist yet).

- [ ] **Step 3: Write `createState`**

Create `packages/sim/src/state.ts`:

```typescript
import type {
  EntityState,
  ItemBoxState,
  KartState,
  SimContext,
  SimState,
} from './types'
import { MAX_ENTITIES, MAX_KARTS } from './types'
import { clamp, wrapAngle } from './mathutil'
import { v3 } from './vec3'

/**
 * Build a fresh race state with every array preallocated to its fixed length.
 *
 * `characterIdx[i]` selects the character for seat `i`; entries that are missing,
 * non-finite, or out of range are truncated and clamped into
 * `[0, ctx.characters.length - 1]`.
 *
 * Karts are placed from `ctx.track.startPositions` using the locked conventions:
 *   right   = (-t.z, 0, t.x), normalized
 *   heading = wrapAngle(atan2(t.z, t.x))
 *   y       = ctx.query.groundHeight(s, lateral)
 * Every `s` here is arc-normalized to [0, 1), never metres.
 * If the track declares fewer start positions than MAX_KARTS, the last one is
 * reused for the remaining seats; if it declares none, seats sit at s = 0.
 */
export function createState(ctx: SimContext, seed: number, characterIdx: number[]): SimState {
  const charCount = ctx.characters.length
  const spCount = ctx.track.startPositions.length

  // A kart on the grid is behind checkpoint 0, i.e. already credited with the
  // last checkpoint of the notional previous lap, so Task 11's
  // `next = cur + 1 >= n ? 0 : cur + 1` targets checkpoint 0 first. A track with
  // no checkpoints has no last index; -1 is written explicitly for that case.
  const cpCount = ctx.track.checkpointS.length
  const initialCheckpointIdx = cpCount > 0 ? cpCount - 1 : -1

  const karts: KartState[] = []
  for (let i = 0; i < MAX_KARTS; i++) {
    const rawIdx = Number(characterIdx[i])
    const ci = Number.isFinite(rawIdx) ? clamp(Math.trunc(rawIdx), 0, charCount - 1) : 0

    const sp = spCount > 0 ? ctx.track.startPositions[Math.min(i, spCount - 1)] : undefined
    const s = sp ? sp.s : 0
    const lateral = sp ? sp.lateral : 0

    const pt = ctx.query.sampleAt(s)
    const tan = ctx.query.tangentAt(s)
    // right = (-t.z, 0, t.x), normalized. Locked convention: +lateral is right.
    const rx = -tan.z
    const rz = tan.x
    const rlen = Math.sqrt(rx * rx + rz * rz)
    const inv = rlen > 0 ? 1 / rlen : 0

    karts.push({
      playerId: i,
      characterIdx: ci,
      isBot: true,
      connected: false,
      position: v3(
        pt.position.x + rx * inv * lateral,
        ctx.query.groundHeight(s, lateral),
        pt.position.z + rz * inv * lateral,
      ),
      velocity: v3(0, 0, 0),
      heading: wrapAngle(Math.atan2(tan.z, tan.x)),
      angularVelocity: 0,
      drift: { active: false, dir: 0, charge: 0 },
      item: 'none',
      airborne: false,
      surface: ctx.query.surfaceAt(s, lateral),
      spinOutTicks: 0,
      invulnTicks: 0,
      boostTicks: 0,
      respawnTicks: 0,
      shielded: false,
      lap: { lap: 0, checkpointIdx: initialCheckpointIdx, t: 0 },
    })
  }

  const entities: EntityState[] = []
  for (let i = 0; i < MAX_ENTITIES; i++) {
    entities.push({
      entityId: -1, // dead-slot sentinel
      kind: 'seeker', // meaningless while entityId === -1, but still copied/compared
      ownerId: -1,
      position: v3(0, 0, 0),
      velocity: v3(0, 0, 0),
      heading: 0,
      targetId: -1,
      ttl: 0,
    })
  }

  const itemBoxes: ItemBoxState[] = []
  for (let i = 0; i < ctx.track.itemBoxes.length; i++) {
    itemBoxes.push({ boxIdx: i, respawnTicks: 0 })
  }

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

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/sim/test/state.test.ts`

Expected: PASS — 5 tests in `createState`.

- [ ] **Step 5: Write the failing test for `cloneState` and `statesEqual`**

Change the last import line of `packages/sim/test/state.test.ts` from:

```typescript
import { createState } from '../src/state'
```

to:

```typescript
import { cloneState, createState, statesEqual } from '../src/state'
```

Then append to `packages/sim/test/state.test.ts`:

```typescript
describe('cloneState / statesEqual', () => {
  it('copies every field so the clone is bit-equal to the source', () => {
    const ctx = makeTestContext(EIGHT_STARTS)
    const a = createState(ctx, 99, [0, 1, 2, 3, 4, 5, 6, 7])
    const b = createState(ctx, 0, [0, 0, 0, 0, 0, 0, 0, 0])

    a.tick = 17
    a.phase = 'racing'
    a.rngCursor = 5
    a.nextEventSeq = 11
    a.finishTick = 900
    a.entityCount = 1
    a.nextEntityId = 4
    a.karts[3].velocity.x = 12.5
    a.karts[3].drift.charge = 46
    a.karts[3].lap.lap = 2
    a.entities[0].entityId = 3
    a.entities[0].kind = 'bolt'
    a.entities[0].ownerId = 5
    a.entities[0].ttl = 120
    a.finishedOrder[0] = 6
    a.itemBoxes[2].respawnTicks = 41

    cloneState(a, b)

    expect(statesEqual(a, b)).toBe(true)
    expect(b.tick).toBe(17)
    expect(b.phase).toBe('racing')
    expect(b.raceSeed).toBe(99)
    expect(b.rngCursor).toBe(5)
    expect(b.nextEventSeq).toBe(11)
    expect(b.finishTick).toBe(900)
    expect(b.entityCount).toBe(1)
    expect(b.nextEntityId).toBe(4)
    expect(b.karts[3].characterIdx).toBe(3)
    expect(b.karts[3].velocity.x).toBe(12.5)
    expect(b.karts[3].drift.charge).toBe(46)
    expect(b.karts[3].lap.lap).toBe(2)
    expect(b.entities[0].entityId).toBe(3)
    expect(b.entities[0].kind).toBe('bolt')
    expect(b.entities[0].ownerId).toBe(5)
    expect(b.entities[0].ttl).toBe(120)
    expect(b.finishedOrder[0]).toBe(6)
    expect(b.itemBoxes[2].respawnTicks).toBe(41)
  })

  it('writes into dst in place, reusing every existing object', () => {
    const ctx = makeTestContext(EIGHT_STARTS)
    const a = createState(ctx, 1, [0, 1, 2, 3, 4, 5, 6, 7])
    const b = createState(ctx, 1, [0, 1, 2, 3, 4, 5, 6, 7])

    const kartsRef = b.karts
    const kartRef = b.karts[2]
    const posRef = b.karts[2].position
    const velRef = b.karts[2].velocity
    const driftRef = b.karts[2].drift
    const lapRef = b.karts[2].lap
    const entRef = b.entities[5]
    const entPosRef = b.entities[5].position
    const boxRef = b.itemBoxes[1]

    cloneState(a, b)

    expect(b.karts).toBe(kartsRef)
    expect(b.karts[2]).toBe(kartRef)
    expect(b.karts[2].position).toBe(posRef)
    expect(b.karts[2].velocity).toBe(velRef)
    expect(b.karts[2].drift).toBe(driftRef)
    expect(b.karts[2].lap).toBe(lapRef)
    expect(b.entities[5]).toBe(entRef)
    expect(b.entities[5].position).toBe(entPosRef)
    expect(b.itemBoxes[1]).toBe(boxRef)

    // and it is a deep copy, not an alias
    expect(b.karts[2].position).not.toBe(a.karts[2].position)
    a.karts[2].position.x = 777
    expect(b.karts[2].position.x).toBe(8) // seat 2 sits at s = 0.008 -> x = 8 m
  })

  it('rejects a dst that was not preallocated with the same shape', () => {
    const a = createState(makeTestContext(EIGHT_STARTS), 1, [])
    const smallCtx = makeTestContext(EIGHT_STARTS)
    smallCtx.track = { ...smallCtx.track, itemBoxes: [{ s: 0.01, lateral: 0 }] }
    const b = createState(smallCtx, 1, [])

    expect(a.itemBoxes).toHaveLength(3)
    expect(b.itemBoxes).toHaveLength(1)
    expect(() => cloneState(a, b)).toThrow(
      'cloneState: dst was not preallocated with the same shape as src',
    )
  })

  it('uses Object.is for every scalar: -0 differs from 0, NaN equals NaN', () => {
    const ctx = makeTestContext(EIGHT_STARTS)
    const a = createState(ctx, 5, [])
    const b = createState(ctx, 5, [])
    cloneState(a, b)
    expect(statesEqual(a, b)).toBe(true)

    a.karts[0].position.x = -0
    b.karts[0].position.x = 0
    expect(statesEqual(a, b)).toBe(false) // Object.is(-0, 0) === false

    b.karts[0].position.x = -0
    expect(statesEqual(a, b)).toBe(true)

    a.karts[1].velocity.z = NaN
    expect(statesEqual(a, b)).toBe(false)
    b.karts[1].velocity.z = NaN
    expect(statesEqual(a, b)).toBe(true) // Object.is(NaN, NaN) === true
  })

  it('detects a difference in any field, including dead entity slots', () => {
    const ctx = makeTestContext(EIGHT_STARTS)
    const a = createState(ctx, 5, [0, 1, 2, 3, 4, 5, 6, 7])
    const b = createState(ctx, 5, [0, 1, 2, 3, 4, 5, 6, 7])

    const differsAfter = (mutate: () => void): boolean => {
      cloneState(a, b)
      mutate()
      return statesEqual(a, b)
    }

    expect(differsAfter(() => { b.tick = 1 })).toBe(false)
    expect(differsAfter(() => { b.phase = 'finished' })).toBe(false)
    expect(differsAfter(() => { b.raceSeed = 6 })).toBe(false)
    expect(differsAfter(() => { b.rngCursor = 1 })).toBe(false)
    expect(differsAfter(() => { b.nextEventSeq = 1 })).toBe(false)
    expect(differsAfter(() => { b.finishTick = 0 })).toBe(false)
    expect(differsAfter(() => { b.entityCount = 1 })).toBe(false)
    expect(differsAfter(() => { b.nextEntityId = 2 })).toBe(false)
    expect(differsAfter(() => { b.karts[6].heading = 0.001 })).toBe(false)
    expect(differsAfter(() => { b.karts[6].drift.dir = 1 })).toBe(false)
    expect(differsAfter(() => { b.karts[6].lap.t = 0.5 })).toBe(false)
    expect(differsAfter(() => { b.karts[6].surface = 'boost' })).toBe(false)
    expect(differsAfter(() => { b.karts[6].item = 'bolt' })).toBe(false)
    expect(differsAfter(() => { b.karts[6].shielded = true })).toBe(false)
    expect(differsAfter(() => { b.entities[31].ttl = 1 })).toBe(false)
    expect(differsAfter(() => { b.entities[31].kind = 'slick' })).toBe(false)
    expect(differsAfter(() => { b.finishedOrder[7] = 3 })).toBe(false)
    expect(differsAfter(() => { b.itemBoxes[0].respawnTicks = 1 })).toBe(false)
    expect(differsAfter(() => { /* no mutation */ })).toBe(true)
  })
})
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `npx vitest run packages/sim/test/state.test.ts -t "copies every field so the clone is bit-equal"`

Expected: FAIL with `The requested module '../src/state' does not provide an export named 'cloneState'`.

- [ ] **Step 7: Write `cloneState` and `statesEqual`**

Append to `packages/sim/src/state.ts`:

```typescript
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
export function cloneState(src: SimState, dst: SimState): void {
  if (
    dst.karts.length !== src.karts.length ||
    dst.entities.length !== src.entities.length ||
    dst.itemBoxes.length !== src.itemBoxes.length ||
    dst.finishedOrder.length !== src.finishedOrder.length
  ) {
    throw new Error('cloneState: dst was not preallocated with the same shape as src')
  }

  dst.tick = src.tick
  dst.phase = src.phase
  dst.raceSeed = src.raceSeed
  dst.rngCursor = src.rngCursor
  dst.nextEventSeq = src.nextEventSeq
  dst.finishTick = src.finishTick
  dst.entityCount = src.entityCount
  dst.nextEntityId = src.nextEntityId

  for (let i = 0; i < src.karts.length; i++) {
    const a = src.karts[i]
    const b = dst.karts[i]
    b.playerId = a.playerId
    b.characterIdx = a.characterIdx
    b.isBot = a.isBot
    b.connected = a.connected
    b.position.x = a.position.x
    b.position.y = a.position.y
    b.position.z = a.position.z
    b.velocity.x = a.velocity.x
    b.velocity.y = a.velocity.y
    b.velocity.z = a.velocity.z
    b.heading = a.heading
    b.angularVelocity = a.angularVelocity
    b.drift.active = a.drift.active
    b.drift.dir = a.drift.dir
    b.drift.charge = a.drift.charge
    b.item = a.item
    b.airborne = a.airborne
    b.surface = a.surface
    b.spinOutTicks = a.spinOutTicks
    b.invulnTicks = a.invulnTicks
    b.boostTicks = a.boostTicks
    b.respawnTicks = a.respawnTicks
    b.shielded = a.shielded
    b.lap.lap = a.lap.lap
    b.lap.checkpointIdx = a.lap.checkpointIdx
    b.lap.t = a.lap.t
  }

  for (let i = 0; i < src.entities.length; i++) {
    const a = src.entities[i]
    const b = dst.entities[i]
    b.entityId = a.entityId
    b.kind = a.kind
    b.ownerId = a.ownerId
    b.position.x = a.position.x
    b.position.y = a.position.y
    b.position.z = a.position.z
    b.velocity.x = a.velocity.x
    b.velocity.y = a.velocity.y
    b.velocity.z = a.velocity.z
    b.heading = a.heading
    b.targetId = a.targetId
    b.ttl = a.ttl
  }

  for (let i = 0; i < src.itemBoxes.length; i++) {
    dst.itemBoxes[i].boxIdx = src.itemBoxes[i].boxIdx
    dst.itemBoxes[i].respawnTicks = src.itemBoxes[i].respawnTicks
  }

  for (let i = 0; i < src.finishedOrder.length; i++) {
    dst.finishedOrder[i] = src.finishedOrder[i]
  }
}

/**
 * Bit-exact structural equality. Every scalar is compared with `Object.is`, so
 * -0 !== 0 and NaN === NaN. Dead entity slots are compared too: despawn leaves
 * deterministic residue, and the checkpoint-replay equivalence test depends on
 * that residue matching.
 */
export function statesEqual(a: SimState, b: SimState): boolean {
  if (
    !Object.is(a.tick, b.tick) ||
    !Object.is(a.phase, b.phase) ||
    !Object.is(a.raceSeed, b.raceSeed) ||
    !Object.is(a.rngCursor, b.rngCursor) ||
    !Object.is(a.nextEventSeq, b.nextEventSeq) ||
    !Object.is(a.finishTick, b.finishTick) ||
    !Object.is(a.entityCount, b.entityCount) ||
    !Object.is(a.nextEntityId, b.nextEntityId)
  ) {
    return false
  }
  if (
    a.karts.length !== b.karts.length ||
    a.entities.length !== b.entities.length ||
    a.itemBoxes.length !== b.itemBoxes.length ||
    a.finishedOrder.length !== b.finishedOrder.length
  ) {
    return false
  }

  for (let i = 0; i < a.karts.length; i++) {
    const x = a.karts[i]
    const y = b.karts[i]
    if (
      !Object.is(x.playerId, y.playerId) ||
      !Object.is(x.characterIdx, y.characterIdx) ||
      !Object.is(x.isBot, y.isBot) ||
      !Object.is(x.connected, y.connected) ||
      !Object.is(x.position.x, y.position.x) ||
      !Object.is(x.position.y, y.position.y) ||
      !Object.is(x.position.z, y.position.z) ||
      !Object.is(x.velocity.x, y.velocity.x) ||
      !Object.is(x.velocity.y, y.velocity.y) ||
      !Object.is(x.velocity.z, y.velocity.z) ||
      !Object.is(x.heading, y.heading) ||
      !Object.is(x.angularVelocity, y.angularVelocity) ||
      !Object.is(x.drift.active, y.drift.active) ||
      !Object.is(x.drift.dir, y.drift.dir) ||
      !Object.is(x.drift.charge, y.drift.charge) ||
      !Object.is(x.item, y.item) ||
      !Object.is(x.airborne, y.airborne) ||
      !Object.is(x.surface, y.surface) ||
      !Object.is(x.spinOutTicks, y.spinOutTicks) ||
      !Object.is(x.invulnTicks, y.invulnTicks) ||
      !Object.is(x.boostTicks, y.boostTicks) ||
      !Object.is(x.respawnTicks, y.respawnTicks) ||
      !Object.is(x.shielded, y.shielded) ||
      !Object.is(x.lap.lap, y.lap.lap) ||
      !Object.is(x.lap.checkpointIdx, y.lap.checkpointIdx) ||
      !Object.is(x.lap.t, y.lap.t)
    ) {
      return false
    }
  }

  for (let i = 0; i < a.entities.length; i++) {
    const x = a.entities[i]
    const y = b.entities[i]
    if (
      !Object.is(x.entityId, y.entityId) ||
      !Object.is(x.kind, y.kind) ||
      !Object.is(x.ownerId, y.ownerId) ||
      !Object.is(x.position.x, y.position.x) ||
      !Object.is(x.position.y, y.position.y) ||
      !Object.is(x.position.z, y.position.z) ||
      !Object.is(x.velocity.x, y.velocity.x) ||
      !Object.is(x.velocity.y, y.velocity.y) ||
      !Object.is(x.velocity.z, y.velocity.z) ||
      !Object.is(x.heading, y.heading) ||
      !Object.is(x.targetId, y.targetId) ||
      !Object.is(x.ttl, y.ttl)
    ) {
      return false
    }
  }

  for (let i = 0; i < a.itemBoxes.length; i++) {
    if (
      !Object.is(a.itemBoxes[i].boxIdx, b.itemBoxes[i].boxIdx) ||
      !Object.is(a.itemBoxes[i].respawnTicks, b.itemBoxes[i].respawnTicks)
    ) {
      return false
    }
  }

  for (let i = 0; i < a.finishedOrder.length; i++) {
    if (!Object.is(a.finishedOrder[i], b.finishedOrder[i])) {
      return false
    }
  }

  return true
}
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `npx vitest run packages/sim/test/state.test.ts`

Expected: PASS — 10 tests (5 in `createState`, 5 in `cloneState / statesEqual`).

- [ ] **Step 9: Write the failing test for `emit`**

Change the two import lines at the top of `packages/sim/test/state.test.ts` from:

```typescript
import { MAX_ENTITIES, MAX_KARTS } from '../src/types'
```

to:

```typescript
import type { AuthEvent } from '../src/types'
import { MAX_ENTITIES, MAX_KARTS } from '../src/types'
```

and from:

```typescript
import { cloneState, createState, statesEqual } from '../src/state'
```

to:

```typescript
import { cloneState, createState, emit, statesEqual } from '../src/state'
```

Then append to `packages/sim/test/state.test.ts`:

```typescript
describe('emit', () => {
  it('stamps a monotonic eventSeq and the current tick onto every event', () => {
    const ctx = makeTestContext(EIGHT_STARTS)
    const st = createState(ctx, 1, [])
    st.tick = 42

    const out: AuthEvent[] = []
    emit(st, out, 'itemGrant', 3, -1, 'boost', 0)
    emit(st, out, 'entitySpawn', 3, 7, 'none', 2)

    expect(out).toHaveLength(2)

    expect(out[0].eventSeq).toBe(0) // nextEventSeq started at 0
    expect(out[0].tick).toBe(42)
    expect(out[0].kind).toBe('itemGrant')
    expect(out[0].playerId).toBe(3)
    expect(out[0].entityId).toBe(-1)
    expect(out[0].item).toBe('boost')
    expect(out[0].data).toBe(0)

    expect(out[1].eventSeq).toBe(1)
    expect(out[1].tick).toBe(42)
    expect(out[1].kind).toBe('entitySpawn')
    expect(out[1].entityId).toBe(7)
    expect(out[1].item).toBe('none')
    expect(out[1].data).toBe(2)

    expect(st.nextEventSeq).toBe(2) // 0 and 1 consumed

    st.tick = 43
    emit(st, out, 'finish', 0, -1, 'none', 1)
    expect(out[2].eventSeq).toBe(2)
    expect(out[2].tick).toBe(43)
    expect(st.nextEventSeq).toBe(3)
  })

  it('appends to the caller array without touching earlier entries', () => {
    const ctx = makeTestContext(EIGHT_STARTS)
    const st = createState(ctx, 1, [])
    const out: AuthEvent[] = []
    for (let i = 0; i < 5; i++) {
      st.tick = i
      emit(st, out, 'hit', i, -1, 'none', i * 2)
    }
    expect(out).toHaveLength(5)
    for (let i = 0; i < 5; i++) {
      expect(out[i].eventSeq).toBe(i)
      expect(out[i].tick).toBe(i)
      expect(out[i].playerId).toBe(i)
      expect(out[i].data).toBe(i * 2)
    }
    expect(st.nextEventSeq).toBe(5)
  })
})
```

- [ ] **Step 10: Run the test to verify it fails**

Run: `npx vitest run packages/sim/test/state.test.ts -t "stamps a monotonic eventSeq"`

Expected: FAIL with `The requested module '../src/state' does not provide an export named 'emit'`.

- [ ] **Step 11: Write `emit`**

First extend the type import at the top of `packages/sim/src/state.ts` from:

```typescript
import type {
  EntityState,
  ItemBoxState,
  KartState,
  SimContext,
  SimState,
} from './types'
```

to:

```typescript
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

Then append to `packages/sim/src/state.ts`:

```typescript
/**
 * Append an authoritative event, stamping it with the state's monotonic
 * `nextEventSeq` and the state's current `tick`. This is the only allocation in
 * the sim, and it is per-event rather than per-tick.
 *
 * `entityId` is -1 when not applicable, `item` is 'none' when not applicable and
 * `data` is 0 when unused.
 */
export function emit(
  state: SimState,
  out: AuthEvent[],
  kind: AuthEventKind,
  playerId: number,
  entityId: number,
  item: ItemKind,
  data: number,
): void {
  out.push({
    eventSeq: state.nextEventSeq++,
    tick: state.tick,
    kind,
    playerId,
    entityId,
    item,
    data,
  })
}
```

- [ ] **Step 12: Run the test to verify it passes**

Run: `npx vitest run packages/sim/test/state.test.ts`

Expected: PASS — 12 tests (5 + 5 + 2).

- [ ] **Step 13: Write the failing test for `step`**

Create `packages/sim/test/step.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import type { AuthEvent, SimState } from '../src/types'
import { EIGHT_STARTS, makeTestContext } from './helpers/flat-context'
import { createState, statesEqual } from '../src/state'
import { step } from '../src/step'

describe('step', () => {
  // Every kart here stays at rest with no intents, so the only observable effect
  // of a tick is the tick counter. That stays true once Task 6 wires stepKart in:
  // at zero speed with a neutral intent, stepKart's yaw, longitudinal and lateral
  // terms are all exactly zero.
  it('advances the tick by exactly one and changes nothing else', () => {
    const ctx = makeTestContext(EIGHT_STARTS)
    const prev = createState(ctx, 7, [0, 1, 2, 3, 4, 5, 6, 7])
    const next = createState(ctx, 7, [0, 1, 2, 3, 4, 5, 6, 7])

    prev.tick = 7
    prev.nextEventSeq = 9
    prev.rngCursor = 4
    prev.karts[1].item = 'seeker'
    prev.karts[1].lap.lap = 2
    prev.finishedOrder[0] = 5
    prev.itemBoxes[0].respawnTicks = 30

    const events: AuthEvent[] = []
    step(ctx, prev, next, [], events)

    expect(next.tick).toBe(8)
    expect(prev.tick).toBe(7) // prev is never written
    expect(next.nextEventSeq).toBe(9)
    expect(next.rngCursor).toBe(4)
    expect(next.karts[1].item).toBe('seeker')
    expect(next.karts[1].lap.lap).toBe(2)
    expect(next.finishedOrder[0]).toBe(5)
    expect(next.itemBoxes[0].respawnTicks).toBe(30)

    next.tick = prev.tick
    expect(statesEqual(prev, next)).toBe(true)
  })

  it('writes only into next, never aliasing or reallocating', () => {
    const ctx = makeTestContext(EIGHT_STARTS)
    const prev = createState(ctx, 7, [0, 1, 2, 3, 4, 5, 6, 7])
    const next = createState(ctx, 7, [0, 1, 2, 3, 4, 5, 6, 7])

    const kartsRef = next.karts
    const posRef = next.karts[2].position
    step(ctx, prev, next, [], [])

    expect(next.karts).toBe(kartsRef)
    expect(next.karts[2].position).toBe(posRef)
    expect(next.karts[2].position).not.toBe(prev.karts[2].position)

    next.karts[2].position.x = 123
    expect(prev.karts[2].position.x).toBe(8) // seat 2 starts at s = 0.008 -> x = 8 m
  })

  it('counts ticks correctly when the caller double-buffers', () => {
    const ctx = makeTestContext(EIGHT_STARTS)
    let cur: SimState = createState(ctx, 7, [0, 1, 2, 3, 4, 5, 6, 7])
    let nxt: SimState = createState(ctx, 7, [0, 1, 2, 3, 4, 5, 6, 7])
    const events: AuthEvent[] = []

    for (let i = 0; i < 10; i++) {
      step(ctx, cur, nxt, [], events)
      const tmp = cur
      cur = nxt
      nxt = tmp
    }

    expect(cur.tick).toBe(10)
    expect(cur.karts[3].position.x).toBe(12) // seat 3 never moved: s = 0.012 -> x = 12 m
    expect(cur.karts[3].position.z).toBe(-3)
    expect(events).toHaveLength(0)
  })
})
```

- [ ] **Step 14: Run the test to verify it fails**

Run: `npx vitest run packages/sim/test/step.test.ts -t "advances the tick by exactly one"`

Expected: FAIL with `Failed to resolve import "../src/step"`.

- [ ] **Step 15: Write `step`**

Create `packages/sim/src/step.ts`:

```typescript
import type { AuthEvent, Intent, SimContext, SimState } from './types'
import { cloneState } from './state'

/**
 * Advance the simulation by exactly one 60Hz tick.
 *
 * The tick starts by copying `prev` into `next`; every stage after that writes
 * only into `next`, which is what makes "never mutates prev" true globally.
 * `step` never reads the wall clock and never calls Math.random().
 *
 * The canonical per-kart stage order, filled in by later tasks, is:
 *   1. resolveInputs      [Task 15]
 *   2. updateRecovery     [Task 9]
 *   3. updateDrift        [Task 8]
 *   4. stepKart           [Task 6]
 *   5. applyAirYaw        [Task 7]
 *   6. integrateVertical  [Task 7]
 *   7. applyRamps         [Task 7]
 *   8. decayBoost         [Task 8]
 *   9. updateLaps         [Task 11]
 * then, once per tick after the kart loop:
 *   resolveKartCollisions [Task 10] -> updateEntities [Task 12]
 *   -> updateItemBoxes    [Task 13] -> updatePhase    [Task 15]
 */
export function step(
  ctx: SimContext,
  prev: SimState,
  next: SimState,
  inputs: Intent[],
  events: AuthEvent[],
): void {
  void ctx // used from Task 6 onward
  void inputs // used from Task 6 onward
  void events // used from Task 9 onward

  cloneState(prev, next)
  next.tick = prev.tick + 1
}
```

- [ ] **Step 16: Run the test to verify it passes**

Run: `npx vitest run packages/sim/test/step.test.ts`

Expected: PASS — 3 tests.

- [ ] **Step 17: Run the whole sim suite and the typecheck**

Run: `npx vitest run packages/sim && npx tsc --noEmit -p packages/sim`

Expected: PASS — every `packages/sim` test green (15 new tests from this task —
12 in `state.test.ts`, 3 in `step.test.ts` — plus everything from Tasks 2–4), and
`tsc` reports no errors.

- [ ] **Step 18: Commit**

```bash
git add packages/sim/src/state.ts packages/sim/src/step.ts \
        packages/sim/test/state.test.ts packages/sim/test/step.test.ts \
        packages/sim/test/helpers/flat-context.ts
git commit -m "feat(sim): SimState create/clone/equal/emit and the tick skeleton"
```

---

### Task 6: Kart handling — `targetSpeedFor` and `stepKart`, wired into `step()`

This task implements the arcade handling model: steering yaw, longitudinal
acceleration toward a target speed, lateral grip, and horizontal position
integration. It also wires the per-kart loop into `step()`.

**Files:**
- Create: `packages/sim/src/kart.ts`
- Test: `packages/sim/test/kart.test.ts`
- Modify: `packages/sim/test/helpers/flat-context.ts` (append two helpers; exact code in Step 1)
- Modify: `packages/sim/src/step.ts` (whole file; Step 15 shows the complete
  before text and the complete final text — nothing is elided)
- Modify: `packages/sim/test/step.test.ts` (append one describe block; exact code in Step 13)

**Interfaces:**

- Consumes (all already exist):
  - `packages/sim/src/types.ts` [Task 2] — types `Vec3`, `Surface`, `Intent`,
    `KartState`, `SimState`, `SimContext`, `Tuning`, `CharacterStats`, `AuthEvent`;
    value constants `TICK_DT = 1/60`, `MAX_KARTS = 8`.
  - `packages/sim/src/mathutil.ts` [Task 2] —
    `clamp(v: number, lo: number, hi: number): number`,
    `wrapAngle(a: number): number` (wraps to `(-π, π]`)
  - `packages/sim/src/state.ts` [Task 5] —
    `createState(ctx: SimContext, seed: number, characterIdx: number[]): SimState`,
    `cloneState(src: SimState, dst: SimState): void`,
    `statesEqual(a: SimState, b: SimState): boolean`
  - `packages/sim/src/step.ts` [Task 5] —
    `step(ctx: SimContext, prev: SimState, next: SimState, inputs: Intent[], events: AuthEvent[]): void`
  - `packages/sim/test/fixtures/track-fixtures.ts` [Task 3] —
    `makeTuning(overrides?: Partial<Tuning>): Tuning`, `makeCharacters(): CharacterStats[]`
  - `packages/sim/test/helpers/flat-context.ts` [Task 5] —
    `makeTestContext(startPositions: { s: number; lateral: number }[]): SimContext`,
    `EIGHT_STARTS: { s: number; lateral: number }[]`. Its `s` values are
    **arc-normalized** (`0.004` is 4 m along the 1000 m flat track), so seat 1
    stands at world `x = 4`.

- Produces (later tasks rely on these verbatim):
  - `targetSpeedFor(ctx: SimContext, state: SimState, k: KartState, accel: number): number`
  - `stepKart(ctx: SimContext, state: SimState, prevKart: KartState, k: KartState, raw: Intent): void`
  - `step()` now runs a per-kart loop over `MAX_KARTS`. **Its exact locals are an
    interface**, because Tasks 7, 8, 13 and 15 all insert calls next to them:

    ```ts
    for (let i = 0; i < MAX_KARTS; i++) {
      const k = next.karts[i]
      const prevKart = prev.karts[i]
      const raw = resolvedInputs[i]
      stepKart(ctx, next, prevKart, k, raw)
    }
    ```

    Never rename `k`, `prevKart` or `raw`, and never add a second `stepKart` call.
  - `step()` also gains two module-scope values: `NEUTRAL_INTENT` (the frozen
    fallback for a seat the caller supplied nothing for) and
    `resolvedInputs: Intent[]`, a preallocated buffer of `MAX_KARTS` distinct
    `Intent` objects that the kart loop reads. Task 15 replaces the loop that
    fills `resolvedInputs` with its `resolveInputs(ctx, next, inputs, resolvedInputs)`
    call; the buffer and the `const raw = resolvedInputs[i]` anchor already exist
    from this task onward, so no later task has to invent them.
  - `packages/sim/test/helpers/flat-context.ts` gains
    `makeKart(over?: Partial<KartState>): KartState` and
    `makeIntent(over?: Partial<Intent>): Intent`. `makeKart` defaults
    `lap` to `{ lap: 0, checkpointIdx: 3, t: 0 }` — **3, not 0 and not -1** —
    because that is what Task 5's `createState` writes on the flat test track
    (`checkpointS.length - 1` with 4 checkpoints), so a kart from this helper is
    indistinguishable from a freshly created one. Tasks 7–12 that declare their
    own local kart builders must use the same default or say in their own text
    why they deliberately differ.

- **Fixture values this task's arithmetic depends on** (locked in the contract):
  `maxSpeed 40`, `accelRate 24`, `brakeRate 48`, `steerRateBase 2.6`,
  `steerSpeedFalloff 0.55`, `gripTarmac 14`, `gripDirt 5`, `gripDrift 3`,
  `boostSpeedMul 1.35`, `surgeSpeedMul 0.7`, `offtrackSpeedMul 0.55`,
  `TICK_DT = 1/60`.
  Character stats, index 0–7:
  `speed [1.00, 1.10, 0.92, 1.05, 0.95, 1.15, 0.88, 1.00]`,
  `accel [1.00, 0.85, 1.15, 0.90, 1.10, 0.80, 1.20, 1.00]`,
  `handling [1.00, 0.90, 1.10, 0.95, 1.05, 0.85, 1.15, 1.00]`,
  `weight [1.00, 1.20, 0.85, 1.10, 0.90, 1.30, 0.80, 1.00]`.

- **The speed-modifier product**, transcribed from the contract and owned here.
  The multiplication order is part of the contract and must not be reordered —
  float multiplication is not associative and the checkpoint-replay equivalence
  test asserts bit-identity:

  ```
  targetSpeed = tuning.maxSpeed
              * characters[k.characterIdx].speed
              * accel
              * surfaceSpeedFactor(k, tuning)                                [Task 9]
              * (surgeActiveOn(state, k.playerId) ? tuning.surgeSpeedMul : 1) [Task 12]
              * (k.boostTicks > 0 ? tuning.boostSpeedMul : 1)                [Task 8 sets boostTicks]
  ```

- **Three factors are owned by later tasks. Each hand-off is a named edit with
  literal before/after text, so no later task has to guess.** `recovery.ts`,
  `entity.ts` and `drift.ts` do not exist yet, so this task ships working code for
  each factor and names the exact replacement:

  1. **Off-track speed penalty — Task 9.** `targetSpeedFor` contains the literal
     line `const surfaceFactor = 1`. Task 9 must add `packages/sim/src/kart.ts`
     to its **Files**, add the import line
     `import { surfaceSpeedFactor } from './recovery'` to `kart.ts`, and replace
     exactly that one line with:

     ```ts
     const surfaceFactor = surfaceSpeedFactor(k, t)
     ```

     Until then the factor is `1`, i.e. no off-track penalty. `surfaceSpeedFactor`
     is not re-derived here: there must be exactly one definition of it and it
     lives in `recovery.ts`.

  2. **Surge field-wide slow — Task 12.** `kart.ts` defines a **local,
     non-exported** `surgeFactorFor(state: SimState, k: KartState, t: Tuning): number`
     and `targetSpeedFor` calls it as `const surgeFactor = surgeFactorFor(state, k, t)`.
     Its body here is complete and honest: it returns `t.surgeSpeedMul` when a
     live surge entity exists that this kart does not own, and `1` otherwise —
     which is `1` for the whole of Tasks 6–11, because nothing spawns an entity
     until Task 12 and `state.entityCount` is `0`. Task 12 must add
     `packages/sim/src/kart.ts` to its **Files**, add
     `import { surgeActiveOn } from './entity'` to `kart.ts`, and replace the
     whole function body with:

     ```ts
     function surgeFactorFor(state: SimState, k: KartState, t: Tuning): number {
       return surgeActiveOn(state, k.playerId) ? t.surgeSpeedMul : 1
     }
     ```

     That refines "any live surge this kart does not own" to Task 12's real rule,
     "a live surge owned by a kart *ahead* of this one", which needs
     `computePlacement` and therefore cannot exist before Task 12. The call site
     in `targetSpeedFor` does not change.
     This is also why `targetSpeedFor` has no `void state` line: `state` is a real
     argument with a real reader from this task onward.

  3. **Lateral grip — Task 8.** `kart.ts` defines a **local, non-exported**
     `gripFor(k: KartState, t: Tuning): number` — `gripDrift` while drifting,
     `gripDirt` on `'dirt'`, `gripTarmac` on everything else including
     `'offtrack'` — and `stepKart` calls it as `const grip = gripFor(k, t)`.
     Task 8 owns the single definition, `lateralGripFor(ctx, k)` in `drift.ts`,
     which returns exactly the same value for all four surfaces. Task 8 must add
     `packages/sim/src/kart.ts` to its **Files** and make three edits to it:
     add `import { lateralGripFor } from './drift'`, delete the whole local
     `gripFor` function, and change the one call site. Before:

     ```ts
     const grip = gripFor(k, t)
     ```

     After:

     ```ts
     const grip = lateralGripFor(ctx, k)
     ```

     No expectation in `kart.test.ts` changes, because the two functions agree on
     every surface — that agreement is the point, and Task 8's own test asserts
     `lateralGripFor(ctx, makeKart({ surface: 'offtrack' })) === 14`.
     **`offtrack` therefore grips like tarmac, not like dirt.** Off-track is
     punished with speed (factor 1 above, `offtrackSpeedMul` from Task 9), not
     with a slide.

  The boost factor needs no missing function — `boostTicks` is a `KartState`
  field that already exists — so it is implemented in full now; Task 8 is only
  what makes it nonzero. Likewise `gripFor` already selects `gripDrift` when
  `k.drift.active`, because the canonical order runs `updateDrift` **before**
  `stepKart` and `updateDrift`'s signature gives it no place to apply grip
  itself. Task 8 sets the flag; the consumer is already here.

- **Explicitly not implemented here** (and where they land):
  - Gravity, vertical integration, ground snap, the airborne flag, ramps →
    Task 7. `stepKart` never reads or writes `position.y` or `velocity.y`.
  - Airborne steering authority → Task 7's `applyAirYaw`. `stepKart` therefore
    skips its whole traction block when `k.airborne` is true, and only integrates
    horizontal position, so the two never double-apply yaw.
  - **`k.surface` is read here and never written here.** Task 7 recomputes it once
    per tick from `ctx.query.surfaceAt(...)` after the kart has moved, so a kart's
    surface changes underneath it during a full `step()`. Every grip test in this
    task therefore calls `stepKart` **directly** with a hand-built kart, and no
    test in this task may assume that a surface set before a `step()` survives
    that `step()`.
  - Kart-vs-kart impulses → Task 10, once per tick after the kart loop.
  - Phase gating, bot fill, input sanitisation and the 30Hz input hold → Task 15's
    `resolveInputs`. Until then `step()` fills its own `resolvedInputs` buffer by
    copying `inputs[i]` field by field, substituting `NEUTRAL_INTENT` for a seat
    the caller supplied nothing for, so karts do move during `'countdown'`. The
    step tests in this task set `prev.phase = 'racing'` anyway, so their
    expectations survive Task 15 unchanged.

- **Handling model decisions this task makes** (nothing in the contract pins
  them, so they are stated once here and are what later tasks tune against):
  - Steering authority curve: with `sn = clamp(speed / maxSpeed, 0, 1)`,
    `authority = sn * (1 - steerSpeedFalloff * sn)`. It is exactly `0` at rest —
    which is what stops the kart pivoting in place — rises to a peak of
    `0.4545…` at `sn = 1/(2 * 0.55) = 0.909`, and falls back to `0.45` at top
    speed. One parameter, no table.
  - `speed` for that curve is measured from **`prevKart.velocity`**, the speed at
    the top of the tick. That is the only use of `prevKart`, and it is deliberate:
    stages that run before `stepKart` within a tick cannot change this tick's yaw
    response, so yaw does not depend on stage ordering.
  - Braking wins over throttle: when `raw.brake` is true the target is `0` and
    the rate is `brakeRate`, regardless of `raw.accel`.
  - When not braking, the same rate — `accelRate * character.accel` — applies in
    both directions, so releasing the throttle coasts down at the acceleration
    rate rather than the brake rate.
  - Grip selection, in `gripFor(k, t)`: `gripDrift` while `drift.active`;
    `gripDirt` on `'dirt'`; `gripTarmac` on `'tarmac'`, `'boost'` **and
    `'offtrack'`**. Lateral damping is `vr * (1 - clamp(grip * TICK_DT, 0, 1))`.
    The `'offtrack'` case matches Task 8's `lateralGripFor` exactly, which is what
    lets Task 8 swap one for the other without touching a single expectation.
  - Horizontal position integrates the post-update velocity, and it runs whether
    or not the kart is airborne.

---

- [ ] **Step 1: Extend the shared test helper**

Append to `packages/sim/test/helpers/flat-context.ts`:

```typescript
/**
 * A single kart at the origin, at rest, on tarmac, facing +X (heading 0).
 *
 * `lap.checkpointIdx` defaults to **3**, not 0 and not -1: that is exactly what
 * createState writes on the flat test track, whose `checkpointS` has 4 entries
 * and whose initial index is therefore `checkpointS.length - 1 = 3`. A kart built
 * here is indistinguishable from a freshly created one, so a lap test can use
 * either without changing its expectations.
 */
export function makeKart(over: Partial<KartState> = {}): KartState {
  return {
    playerId: 0,
    characterIdx: 0,
    isBot: false,
    connected: true,
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
    lap: { lap: 0, checkpointIdx: 3, t: 0 },
    ...over,
  }
}

/** A neutral intent: no steer, no throttle, no brake, no drift, no item. */
export function makeIntent(over: Partial<Intent> = {}): Intent {
  return { tick: 0, steer: 0, accel: 0, brake: false, drift: false, useItem: false, ...over }
}
```

and extend that file's type import from:

```typescript
import type {
  CharacterStats,
  SimContext,
  Surface,
  Track,
  TrackPoint,
  TrackProjection,
  TrackQuery,
  Vec3,
} from '../../src/types'
```

to:

```typescript
import type {
  CharacterStats,
  Intent,
  KartState,
  SimContext,
  Surface,
  Track,
  TrackPoint,
  TrackProjection,
  TrackQuery,
  Vec3,
} from '../../src/types'
```

Then create `packages/sim/test/kart.test.ts` with the `targetSpeedFor` suite:

```typescript
import { describe, expect, it } from 'vitest'
import { EIGHT_STARTS, makeKart, makeTestContext } from './helpers/flat-context'
import { createState } from '../src/state'
import { targetSpeedFor } from '../src/kart'

const ctx = makeTestContext(EIGHT_STARTS)
const state = createState(ctx, 1, [0, 0, 0, 0, 0, 0, 0, 0])

describe('targetSpeedFor', () => {
  it('multiplies maxSpeed by the character speed stat and the accel input', () => {
    // maxSpeed 40 * speed 1.00 * accel 1 * 1 * 1 * 1 = 40
    expect(targetSpeedFor(ctx, state, makeKart({ characterIdx: 0 }), 1)).toBe(40)
    // 40 * 1.10 * 1 = 44
    expect(targetSpeedFor(ctx, state, makeKart({ characterIdx: 1 }), 1)).toBeCloseTo(44, 12)
    // 40 * 0.88 * 1 = 35.2   (character 6 is the slow/high-accel one)
    expect(targetSpeedFor(ctx, state, makeKart({ characterIdx: 6 }), 1)).toBeCloseTo(35.2, 12)
    // 40 * 1.15 * 0.5 = 23
    expect(targetSpeedFor(ctx, state, makeKart({ characterIdx: 5 }), 0.5)).toBeCloseTo(23, 12)
    // 40 * 1.00 * 0.25 = 10
    expect(targetSpeedFor(ctx, state, makeKart({ characterIdx: 0 }), 0.25)).toBe(10)
    // accel 0 -> target 0, the kart coasts down
    expect(targetSpeedFor(ctx, state, makeKart({ characterIdx: 3 }), 0)).toBe(0)
  })

  it('applies boostSpeedMul while boostTicks > 0 and not otherwise', () => {
    // 40 * 1.00 * 1 * 1 * 1 * 1.35 = 54
    expect(targetSpeedFor(ctx, state, makeKart({ characterIdx: 0, boostTicks: 5 }), 1))
      .toBeCloseTo(54, 12)
    // one tick of boost left still counts
    expect(targetSpeedFor(ctx, state, makeKart({ characterIdx: 0, boostTicks: 1 }), 1))
      .toBeCloseTo(54, 12)
    // boostTicks 0 -> factor 1
    expect(targetSpeedFor(ctx, state, makeKart({ characterIdx: 0, boostTicks: 0 }), 1))
      .toBe(40)
    // and it composes with the character stat: 40 * 1.10 * 1 * 1.35 = 59.4
    // (the exact double is 59.400000000000006, hence toBeCloseTo)
    expect(targetSpeedFor(ctx, state, makeKart({ characterIdx: 1, boostTicks: 3 }), 1))
      .toBeCloseTo(59.4, 12)
  })

  it('leaves the surge factor at 1 while no surge entity is live', () => {
    // createState leaves entityCount 0 and every slot dead, so surgeFactorFor
    // finds no 'surge' entity and returns 1: 40 * 1.00 * 1 * 1 * 1 * 1 = 40.
    // This stays true after Task 12 replaces the body with surgeActiveOn(),
    // which also returns false when the pool holds no surge entity.
    expect(state.entityCount).toBe(0)
    expect(targetSpeedFor(ctx, state, makeKart({ characterIdx: 0 }), 1)).toBe(40)
    expect(targetSpeedFor(ctx, state, makeKart({ characterIdx: 0, playerId: 5 }), 1)).toBe(40)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/sim/test/kart.test.ts -t "multiplies maxSpeed by the character speed stat"`

Expected: FAIL with `Failed to resolve import "../src/kart"` (the module does not
exist yet).

- [ ] **Step 3: Write `targetSpeedFor`**

Create `packages/sim/src/kart.ts`:

```typescript
import type { CharacterStats, KartState, SimContext, SimState, Tuning } from './types'

/**
 * The Surge item's field-wide slow, as a multiplier on the target speed.
 *
 * A surge is a live world entity, and no entity can exist before Task 12 creates
 * `entity.ts` — `state.entityCount` is 0 for the whole of Tasks 6-11 — so this
 * returns 1 today. It is still real code rather than a literal, because `state`
 * is a parameter of `targetSpeedFor` and something has to read it.
 *
 * Task 12 replaces this entire body with the placement-aware rule it owns:
 *
 *   return surgeActiveOn(state, k.playerId) ? t.surgeSpeedMul : 1
 *
 * which narrows "any live surge this kart does not own" to "a live surge owned by
 * a kart ahead of this one". That needs computePlacement, which does not exist
 * yet. The call site in targetSpeedFor does not change.
 */
function surgeFactorFor(state: SimState, k: KartState, t: Tuning): number {
  for (let i = 0; i < state.entityCount; i++) {
    const e = state.entities[i]
    if (e.kind !== 'surge') continue
    if (e.ownerId === k.playerId) continue
    return t.surgeSpeedMul
  }
  return 1
}

/**
 * The one place every speed modifier is composed. The multiplication order is
 * part of the locked contract: float multiplication is not associative, and the
 * checkpoint-replay equivalence test asserts bit-identity.
 *
 *   maxSpeed * character.speed * accel * surface * surge * boost
 */
export function targetSpeedFor(
  ctx: SimContext,
  state: SimState,
  k: KartState,
  accel: number,
): number {
  const t = ctx.tuning
  const ch = ctx.characters[k.characterIdx] as CharacterStats

  // Task 9 replaces this exact line with `const surfaceFactor = surfaceSpeedFactor(k, t)`
  // and adds `import { surfaceSpeedFactor } from './recovery'` at the top of this
  // file. Until then there is no off-track penalty.
  const surfaceFactor = 1
  const surgeFactor = surgeFactorFor(state, k, t)
  // Task 8 is what makes boostTicks nonzero; the factor itself is complete.
  const boostFactor = k.boostTicks > 0 ? t.boostSpeedMul : 1

  return t.maxSpeed * ch.speed * accel * surfaceFactor * surgeFactor * boostFactor
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/sim/test/kart.test.ts`

Expected: PASS — 3 tests.

- [ ] **Step 5: Write the failing test for `stepKart` steering**

Change the last import line of `packages/sim/test/kart.test.ts` from:

```typescript
import { targetSpeedFor } from '../src/kart'
```

to:

```typescript
import { stepKart, targetSpeedFor } from '../src/kart'
```

and change:

```typescript
import { EIGHT_STARTS, makeKart, makeTestContext } from './helpers/flat-context'
```

to:

```typescript
import { EIGHT_STARTS, makeIntent, makeKart, makeTestContext } from './helpers/flat-context'
```

Then append to `packages/sim/test/kart.test.ts`:

```typescript
describe('stepKart — steering', () => {
  it('yaws at steerRateBase * steer * handling * the speed-authority curve', () => {
    // At 20 m/s: sn = 20 / 40 = 0.5
    //            authority = 0.5 * (1 - 0.55 * 0.5) = 0.5 * 0.725 = 0.3625
    // character 0 handling 1.00: yaw = 2.6 * 1 * 1.00 * 0.3625 = 0.9425 rad/s
    // heading = 0 + 0.9425 / 60 = 0.015708333333333335
    const k = makeKart({ characterIdx: 0, velocity: { x: 20, y: 0, z: 0 } })
    const prevKart = makeKart({ characterIdx: 0, velocity: { x: 20, y: 0, z: 0 } })
    stepKart(ctx, state, prevKart, k, makeIntent({ steer: 1 }))
    expect(k.angularVelocity).toBeCloseTo(0.9425, 12)
    expect(k.heading).toBeCloseTo(0.015708333333333335, 12)

    // character 2 handling 1.10: yaw = 2.6 * 1 * 1.10 * 0.3625 = 1.03675 rad/s
    // heading = 1.03675 / 60 = 0.01727916666666667
    const k2 = makeKart({ characterIdx: 2, velocity: { x: 20, y: 0, z: 0 } })
    const prev2 = makeKart({ characterIdx: 2, velocity: { x: 20, y: 0, z: 0 } })
    stepKart(ctx, state, prev2, k2, makeIntent({ steer: 1 }))
    expect(k2.angularVelocity).toBeCloseTo(1.03675, 12)
    expect(k2.heading).toBeCloseTo(0.01727916666666667, 12)

    // steer is signed: -1 mirrors exactly
    const k3 = makeKart({ characterIdx: 0, velocity: { x: 20, y: 0, z: 0 } })
    const prev3 = makeKart({ characterIdx: 0, velocity: { x: 20, y: 0, z: 0 } })
    stepKart(ctx, state, prev3, k3, makeIntent({ steer: -1 }))
    expect(k3.angularVelocity).toBeCloseTo(-0.9425, 12)
    expect(k3.heading).toBeCloseTo(-0.015708333333333335, 12)
  })

  it('has zero steering authority at rest, so the kart cannot pivot in place', () => {
    // sn = 0 -> authority = 0 * (1 - 0) = 0 -> yaw = 0 regardless of steer
    const k = makeKart({ characterIdx: 0 })
    const prevKart = makeKart({ characterIdx: 0 })
    stepKart(ctx, state, prevKart, k, makeIntent({ steer: 1 }))
    expect(k.angularVelocity).toBe(0)
    expect(k.heading).toBe(0)
  })

  it('reduces steering authority at top speed by steerSpeedFalloff', () => {
    // At 40 m/s: sn = 1, authority = 1 * (1 - 0.55) = 0.45
    // yaw = 2.6 * 1 * 1.00 * 0.45 = 1.17 rad/s, heading = 1.17 / 60 = 0.0195
    const k = makeKart({ characterIdx: 0, velocity: { x: 40, y: 0, z: 0 } })
    const prevKart = makeKart({ characterIdx: 0, velocity: { x: 40, y: 0, z: 0 } })
    stepKart(ctx, state, prevKart, k, makeIntent({ steer: 1 }))
    expect(k.angularVelocity).toBeCloseTo(1.17, 12)
    expect(k.heading).toBeCloseTo(0.0195, 12)

    // above maxSpeed the curve clamps: sn is clamped to 1, so still 1.17
    const kFast = makeKart({ characterIdx: 0, velocity: { x: 80, y: 0, z: 0 } })
    const prevFast = makeKart({ characterIdx: 0, velocity: { x: 80, y: 0, z: 0 } })
    stepKart(ctx, state, prevFast, kFast, makeIntent({ steer: 1 }))
    expect(kFast.angularVelocity).toBeCloseTo(1.17, 12)
  })

  it('measures steering authority from prevKart, not from the live kart', () => {
    // The live kart is stationary but prevKart entered the tick at 20 m/s, so the
    // authority is the 20 m/s one: 2.6 * 1 * 1.00 * 0.3625 = 0.9425
    const k = makeKart({ characterIdx: 0, velocity: { x: 0, y: 0, z: 0 } })
    const prevKart = makeKart({ characterIdx: 0, velocity: { x: 20, y: 0, z: 0 } })
    stepKart(ctx, state, prevKart, k, makeIntent({ steer: 1 }))
    expect(k.angularVelocity).toBeCloseTo(0.9425, 12)
  })

  it('integrates horizontal position from the current velocity', () => {
    // No steer, no throttle, no brake: velocity is unchanged laterally-free here
    // because it is purely forward. position.x += 10 / 60 = 0.16666666666666666
    // minus one tick of coast-down, which the longitudinal test pins separately;
    // this test only fixes that position moves along +X by velocity * TICK_DT.
    const k = makeKart({ characterIdx: 0, velocity: { x: 10, y: 0, z: 0 } })
    const prevKart = makeKart({ characterIdx: 0, velocity: { x: 10, y: 0, z: 0 } })
    stepKart(ctx, state, prevKart, k, makeIntent({ accel: 0.25 }))
    // target = 40 * 1.00 * 0.25 = 10, vf = 10, so delta = 0 and speed holds at 10
    expect(k.velocity.x).toBeCloseTo(10, 12)
    expect(k.position.x).toBeCloseTo(0.16666666666666666, 12)
    expect(k.position.z).toBe(0)
  })
})
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `npx vitest run packages/sim/test/kart.test.ts -t "yaws at steerRateBase"`

Expected: FAIL with `The requested module '../src/kart' does not provide an export named 'stepKart'`.

- [ ] **Step 7: Write `stepKart`'s steering and position integration**

Extend the imports at the top of `packages/sim/src/kart.ts` from:

```typescript
import type { CharacterStats, KartState, SimContext, SimState, Tuning } from './types'
```

to:

```typescript
import type { CharacterStats, Intent, KartState, SimContext, SimState, Tuning } from './types'
import { TICK_DT } from './types'
import { clamp, wrapAngle } from './mathutil'
```

Then append to `packages/sim/src/kart.ts`:

```typescript
/**
 * One tick of ground handling for one kart: steering yaw, then longitudinal
 * accel/brake toward targetSpeedFor, then lateral grip, then horizontal position
 * integration.
 *
 * Never touches position.y or velocity.y — Task 7's integrateVertical owns those.
 * While airborne the whole traction block is skipped: Task 7's applyAirYaw owns
 * airborne steering, so the two can never double-apply yaw.
 */
export function stepKart(
  ctx: SimContext,
  state: SimState,
  prevKart: KartState,
  k: KartState,
  raw: Intent,
): void {
  const t = ctx.tuning
  const ch = ctx.characters[k.characterIdx] as CharacterStats

  if (!k.airborne) {
    // --- Steering -----------------------------------------------------------
    // Authority is measured from the speed at the TOP of the tick, so stages
    // that ran before stepKart cannot change this tick's yaw response.
    const pvx = prevKart.velocity.x
    const pvz = prevKart.velocity.z
    const entrySpeed = Math.sqrt(pvx * pvx + pvz * pvz)
    const sn = clamp(entrySpeed / t.maxSpeed, 0, 1)
    // 0 at rest (no pivoting in place), peak at sn = 1/(2*falloff), reduced at top speed
    const authority = sn * (1 - t.steerSpeedFalloff * sn)
    const yawRate = t.steerRateBase * raw.steer * ch.handling * authority
    k.angularVelocity = yawRate
    k.heading = wrapAngle(k.heading + yawRate * TICK_DT)
  }

  // --- Horizontal position integration (y is Task 7's) ----------------------
  k.position.x += k.velocity.x * TICK_DT
  k.position.z += k.velocity.z * TICK_DT
}
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `npx vitest run packages/sim/test/kart.test.ts`

Expected: PASS — 8 tests (3 `targetSpeedFor`, 5 steering). The steering suite
passes because with `accel: 0.25` at 10 m/s the not-yet-written longitudinal term
would be a no-op anyway.

- [ ] **Step 9: Write the failing test for longitudinal, lateral grip and airborne**

Append to `packages/sim/test/kart.test.ts`:

```typescript
describe('stepKart — longitudinal', () => {
  it('accelerates toward targetSpeedFor at accelRate * the character accel stat', () => {
    // character 0: rate = 24 * 1.00 = 24, maxDelta = 24 / 60 = 0.4
    // from rest with accel 1: target 40, delta = clamp(40, -0.4, 0.4) = 0.4
    // position.x = 0 + 0.4 / 60 = 0.006666666666666667
    const k = makeKart({ characterIdx: 0 })
    stepKart(ctx, state, makeKart({ characterIdx: 0 }), k, makeIntent({ accel: 1 }))
    expect(k.velocity.x).toBeCloseTo(0.4, 12)
    expect(k.velocity.z).toBeCloseTo(0, 12)
    expect(k.position.x).toBeCloseTo(0.006666666666666667, 12)

    // character 6: accel stat 1.20 -> rate = 24 * 1.20 = 28.8, maxDelta = 0.48
    // position.x = 0.48 / 60 = 0.008
    const k6 = makeKart({ characterIdx: 6 })
    stepKart(ctx, state, makeKart({ characterIdx: 6 }), k6, makeIntent({ accel: 1 }))
    expect(k6.velocity.x).toBeCloseTo(0.48, 12)
    expect(k6.position.x).toBeCloseTo(0.008, 12)
  })

  it('never overshoots the target speed', () => {
    // 40 - 39.75 = 0.25, which is inside maxDelta 0.4, so it lands exactly on 40
    const k = makeKart({ characterIdx: 0, velocity: { x: 39.75, y: 0, z: 0 } })
    const prevKart = makeKart({ characterIdx: 0, velocity: { x: 39.75, y: 0, z: 0 } })
    stepKart(ctx, state, prevKart, k, makeIntent({ accel: 1 }))
    expect(k.velocity.x).toBe(40)
    expect(k.position.x).toBeCloseTo(0.6666666666666666, 12) // 40 / 60

    // already at target: delta = 0
    const kAt = makeKart({ characterIdx: 0, velocity: { x: 40, y: 0, z: 0 } })
    const prevAt = makeKart({ characterIdx: 0, velocity: { x: 40, y: 0, z: 0 } })
    stepKart(ctx, state, prevAt, kAt, makeIntent({ accel: 1 }))
    expect(kAt.velocity.x).toBe(40)
  })

  it('brakes toward zero at brakeRate, ignoring the throttle', () => {
    // maxDelta = 48 / 60 = 0.8, so 20 -> 19.2
    const k = makeKart({ characterIdx: 0, velocity: { x: 20, y: 0, z: 0 } })
    const prevKart = makeKart({ characterIdx: 0, velocity: { x: 20, y: 0, z: 0 } })
    stepKart(ctx, state, prevKart, k, makeIntent({ accel: 1, brake: true }))
    expect(k.velocity.x).toBeCloseTo(19.2, 12)
  })

  it('coasts down at accelRate when the throttle is released', () => {
    // accel 0 -> target 0, rate = 24 * 1.00, maxDelta = 0.4, so 20 -> 19.6
    const k = makeKart({ characterIdx: 0, velocity: { x: 20, y: 0, z: 0 } })
    const prevKart = makeKart({ characterIdx: 0, velocity: { x: 20, y: 0, z: 0 } })
    stepKart(ctx, state, prevKart, k, makeIntent({ accel: 0 }))
    expect(k.velocity.x).toBeCloseTo(19.6, 12)
  })

  it('never touches the vertical axis', () => {
    const k = makeKart({ characterIdx: 0, velocity: { x: 20, y: -5, z: 0 }, position: { x: 0, y: 7, z: 0 } })
    const prevKart = makeKart({ characterIdx: 0, velocity: { x: 20, y: -5, z: 0 } })
    stepKart(ctx, state, prevKart, k, makeIntent({ accel: 1 }))
    expect(k.velocity.y).toBe(-5)
    expect(k.position.y).toBe(7)
  })
})

// These tests call stepKart directly with a hand-built kart, never through
// step(), because Task 7 recomputes k.surface from the query every tick and would
// otherwise decide the surface for them.
describe('stepKart — lateral grip', () => {
  it('damps sideways velocity by gripTarmac', () => {
    // heading 0 -> forward (1,0,0), right = (-sin h, 0, cos h) = (0,0,1)
    // vf = 0, vr = 10. accel 0 -> target 0 and vf is already 0, so delta = 0.
    // damp = clamp(14 / 60, 0, 1) = 0.23333333333333334
    // vr' = 10 * (1 - 0.23333333333333334) = 7.666666666666666
    // position.z = 0 + 7.666666666666666 / 60 = 0.12777777777777777
    const k = makeKart({ characterIdx: 0, velocity: { x: 0, y: 0, z: 10 }, surface: 'tarmac' })
    const prevKart = makeKart({ characterIdx: 0, velocity: { x: 0, y: 0, z: 10 } })
    stepKart(ctx, state, prevKart, k, makeIntent())
    expect(k.velocity.z).toBeCloseTo(7.666666666666666, 12)
    expect(k.velocity.x).toBeCloseTo(0, 12)
    expect(k.position.z).toBeCloseTo(0.12777777777777777, 12)
  })

  it('damps less on dirt, and least while drifting', () => {
    // dirt: damp = 5 / 60 = 0.08333333333333333 -> 10 * 0.9166666666666667 = 9.166666666666666
    const kDirt = makeKart({ characterIdx: 0, velocity: { x: 0, y: 0, z: 10 }, surface: 'dirt' })
    stepKart(ctx, state, makeKart({ velocity: { x: 0, y: 0, z: 10 } }), kDirt, makeIntent())
    expect(kDirt.velocity.z).toBeCloseTo(9.166666666666666, 12)

    // offtrack grips like TARMAC, not like dirt: gripFor returns gripDirt only for
    // 'dirt'. Off-track is punished with speed (offtrackSpeedMul, Task 9), not with
    // a slide, and Task 8's lateralGripFor makes the same choice — it asserts 14
    // for 'offtrack'. So: damp = 14 / 60 -> 10 * 0.7666666666666666 = 7.666666666666666
    const kOff = makeKart({ characterIdx: 0, velocity: { x: 0, y: 0, z: 10 }, surface: 'offtrack' })
    stepKart(ctx, state, makeKart({ velocity: { x: 0, y: 0, z: 10 } }), kOff, makeIntent())
    expect(kOff.velocity.z).toBeCloseTo(7.666666666666666, 12)

    // boost pads are tarmac-grippy: 7.666666666666666
    const kBoost = makeKart({ characterIdx: 0, velocity: { x: 0, y: 0, z: 10 }, surface: 'boost' })
    stepKart(ctx, state, makeKart({ velocity: { x: 0, y: 0, z: 10 } }), kBoost, makeIntent())
    expect(kBoost.velocity.z).toBeCloseTo(7.666666666666666, 12)

    // drifting overrides the surface: damp = 3 / 60 = 0.05 -> 10 * 0.95 = 9.5
    const kDrift = makeKart({
      characterIdx: 0,
      velocity: { x: 0, y: 0, z: 10 },
      surface: 'tarmac',
      drift: { active: true, dir: 1, charge: 0 },
    })
    stepKart(ctx, state, makeKart({ velocity: { x: 0, y: 0, z: 10 } }), kDrift, makeIntent())
    expect(kDrift.velocity.z).toBeCloseTo(9.5, 12)
  })
})

describe('stepKart — airborne', () => {
  it('leaves orientation and velocity alone but still integrates horizontally', () => {
    // Airborne: no traction, so no yaw, no throttle and no lateral damping.
    // position.x = 1 + 10 / 60 = 1.1666666666666667
    // position.z = 3 +  4 / 60 = 3.066666666666667
    const k = makeKart({
      characterIdx: 0,
      airborne: true,
      heading: 0.3,
      position: { x: 1, y: 2, z: 3 },
      velocity: { x: 10, y: 0, z: 4 },
    })
    const prevKart = makeKart({
      characterIdx: 0,
      airborne: true,
      heading: 0.3,
      velocity: { x: 10, y: 0, z: 4 },
    })
    stepKart(ctx, state, prevKart, k, makeIntent({ steer: 1, accel: 1 }))

    expect(k.velocity.x).toBe(10)
    expect(k.velocity.z).toBe(4)
    expect(k.heading).toBe(0.3)
    expect(k.angularVelocity).toBe(0)
    expect(k.position.x).toBeCloseTo(1.1666666666666667, 12)
    expect(k.position.z).toBeCloseTo(3.066666666666667, 12)
    expect(k.position.y).toBe(2)
  })
})
```

- [ ] **Step 10: Run the test to verify it fails**

Run: `npx vitest run packages/sim/test/kart.test.ts -t "accelerates toward targetSpeedFor"`

Expected: FAIL with `expected 0 to be close to 0.4` — `stepKart` currently only
steers and integrates position, so `velocity.x` is still `0`.

- [ ] **Step 11: Write the full `stepKart`**

First insert this local helper into `packages/sim/src/kart.ts`, between
`targetSpeedFor` and `stepKart`:

```typescript
/**
 * The lateral damping coefficient, in 1/s: how hard the sideways component of the
 * velocity is bled off this tick.
 *
 * `'offtrack'` grips like tarmac on purpose. Leaving the track is punished with
 * speed (`offtrackSpeedMul`, Task 9), not with a slide; making it slippery as
 * well would make a bad line unrecoverable.
 *
 * Task 8 owns the single definition of this rule, `lateralGripFor(ctx, k)` in
 * `drift.ts`, and it returns the same value for all four surfaces. Task 8 deletes
 * this function, adds `import { lateralGripFor } from './drift'` to this file and
 * changes the one call site below to `const grip = lateralGripFor(ctx, k)`.
 */
function gripFor(k: KartState, t: Tuning): number {
  if (k.drift.active) return t.gripDrift
  if (k.surface === 'dirt') return t.gripDirt
  return t.gripTarmac
}
```

Then replace the whole `stepKart` function in `packages/sim/src/kart.ts`. Before:

```typescript
  if (!k.airborne) {
    // --- Steering -----------------------------------------------------------
    // Authority is measured from the speed at the TOP of the tick, so stages
    // that ran before stepKart cannot change this tick's yaw response.
    const pvx = prevKart.velocity.x
    const pvz = prevKart.velocity.z
    const entrySpeed = Math.sqrt(pvx * pvx + pvz * pvz)
    const sn = clamp(entrySpeed / t.maxSpeed, 0, 1)
    // 0 at rest (no pivoting in place), peak at sn = 1/(2*falloff), reduced at top speed
    const authority = sn * (1 - t.steerSpeedFalloff * sn)
    const yawRate = t.steerRateBase * raw.steer * ch.handling * authority
    k.angularVelocity = yawRate
    k.heading = wrapAngle(k.heading + yawRate * TICK_DT)
  }
```

After:

```typescript
  if (!k.airborne) {
    // --- Steering -----------------------------------------------------------
    // Authority is measured from the speed at the TOP of the tick, so stages
    // that ran before stepKart cannot change this tick's yaw response.
    const pvx = prevKart.velocity.x
    const pvz = prevKart.velocity.z
    const entrySpeed = Math.sqrt(pvx * pvx + pvz * pvz)
    const sn = clamp(entrySpeed / t.maxSpeed, 0, 1)
    // 0 at rest (no pivoting in place), peak at sn = 1/(2*falloff), reduced at top speed
    const authority = sn * (1 - t.steerSpeedFalloff * sn)
    const yawRate = t.steerRateBase * raw.steer * ch.handling * authority
    k.angularVelocity = yawRate
    k.heading = wrapAngle(k.heading + yawRate * TICK_DT)

    // --- Longitudinal -------------------------------------------------------
    // forward = (cos h, 0, sin h); right = (-t.z, 0, t.x) = (-sin h, 0, cos h)
    const fx = Math.cos(k.heading)
    const fz = Math.sin(k.heading)
    const rx = -fz
    const rz = fx
    const vf = k.velocity.x * fx + k.velocity.z * fz
    const vr = k.velocity.x * rx + k.velocity.z * rz

    // Braking wins over the throttle. Off the brake, the same rate applies in
    // both directions, so releasing the throttle coasts down at accelRate.
    const target = raw.brake ? 0 : targetSpeedFor(ctx, state, k, raw.accel)
    const rate = raw.brake ? t.brakeRate : t.accelRate * ch.accel
    const maxDelta = rate * TICK_DT
    const newVf = vf + clamp(target - vf, -maxDelta, maxDelta)

    // --- Lateral grip -------------------------------------------------------
    // Task 8 sets drift.active; the consumer lives here because updateDrift runs
    // before stepKart in the canonical order and has nowhere to apply grip.
    // Task 8 changes this one line to: const grip = lateralGripFor(ctx, k)
    const grip = gripFor(k, t)
    const newVr = vr * (1 - clamp(grip * TICK_DT, 0, 1))

    k.velocity.x = newVf * fx + newVr * rx
    k.velocity.z = newVf * fz + newVr * rz
  }
```

- [ ] **Step 12: Run the test to verify it passes**

Run: `npx vitest run packages/sim/test/kart.test.ts`

Expected: PASS — 16 tests, one per `it(...)` across the five describe blocks this
task wrote: 3 `targetSpeedFor` + 5 steering + 5 longitudinal + 2 lateral grip +
1 airborne = 16.

**16 is the number later tasks count from.** Tasks 7 and 8 add no test to
`kart.test.ts` (Task 8 only re-runs it alongside `drift.test.ts`), and Task 9
appends 4 more, so `kart.test.ts` holds 20 tests after Task 9.

- [ ] **Step 13: Write the failing test for the `step()` per-kart loop**

Change the import lines at the top of `packages/sim/test/step.test.ts` from:

```typescript
import type { AuthEvent, SimState } from '../src/types'
import { EIGHT_STARTS, makeTestContext } from './helpers/flat-context'
```

to:

```typescript
import type { AuthEvent, Intent, SimState } from '../src/types'
import { EIGHT_STARTS, makeIntent, makeTestContext } from './helpers/flat-context'
```

Then append to `packages/sim/test/step.test.ts`:

```typescript
describe('step — per-kart loop', () => {
  // Every test here sets prev.phase = 'racing'. It changes nothing today — this
  // task's step() has no phase gating — but Task 15's resolveInputs freezes every
  // intent to zero while the phase is 'countdown', which is what createState
  // starts in. Setting it now means these expectations survive Task 15 untouched.
  it('runs stepKart for every seat, indexing inputs by playerId', () => {
    const ctx = makeTestContext(EIGHT_STARTS)
    const prev = createState(ctx, 7, [0, 0, 0, 0, 0, 0, 0, 0])
    const next = createState(ctx, 7, [0, 0, 0, 0, 0, 0, 0, 0])
    prev.phase = 'racing'

    const inputs: Intent[] = []
    inputs[0] = makeIntent({ accel: 1 })

    step(ctx, prev, next, inputs, [])

    // Seat 0, character 0: rate = accelRate 24 * accel stat 1.00 = 24,
    // maxDelta = 24 / 60 = 0.4, from rest -> velocity.x = 0.4
    // Its grid slot is s = 0 -> world x = 0, so
    // position.x = 0 + 0.4 / 60 = 0.006666666666666667
    expect(next.karts[0].velocity.x).toBeCloseTo(0.4, 12)
    expect(next.karts[0].position.x).toBeCloseTo(0.006666666666666667, 12)

    // Seat 1 got no intent -> NEUTRAL_INTENT -> still parked at its grid slot,
    // s = 0.004 of a 1000 m lap = world x = 4. Seat 7: s = 0.028 -> x = 28.
    expect(next.karts[1].velocity.x).toBe(0)
    expect(next.karts[1].position.x).toBe(4)
    expect(next.karts[7].velocity.x).toBe(0)
    expect(next.karts[7].position.x).toBe(28)

    // prev is never written
    expect(prev.karts[0].velocity.x).toBe(0)
    expect(prev.karts[0].position.x).toBe(0)
    expect(next.tick).toBe(1)
  })

  it('applies steering through the loop for a moving kart', () => {
    const ctx = makeTestContext(EIGHT_STARTS)
    const prev = createState(ctx, 7, [0, 0, 0, 0, 0, 0, 0, 0])
    const next = createState(ctx, 7, [0, 0, 0, 0, 0, 0, 0, 0])
    prev.phase = 'racing'
    prev.karts[0].velocity.x = 20

    const inputs: Intent[] = []
    inputs[0] = makeIntent({ steer: 1 })

    step(ctx, prev, next, inputs, [])

    // sn = 20 / 40 = 0.5, authority = 0.5 * (1 - 0.55 * 0.5) = 0.3625
    // yaw = 2.6 * 1 * 1.00 * 0.3625 = 0.9425, heading = 0.9425 / 60
    expect(next.karts[0].angularVelocity).toBeCloseTo(0.9425, 12)
    expect(next.karts[0].heading).toBeCloseTo(0.015708333333333335, 12)
    expect(prev.karts[0].heading).toBe(0)
    expect(prev.karts[0].angularVelocity).toBe(0)
  })

  it('is deterministic: the same inputs from the same state give bit-equal output', () => {
    const ctx = makeTestContext(EIGHT_STARTS)
    const prev = createState(ctx, 7, [0, 1, 2, 3, 4, 5, 6, 7])
    const a = createState(ctx, 7, [0, 1, 2, 3, 4, 5, 6, 7])
    const b = createState(ctx, 7, [0, 1, 2, 3, 4, 5, 6, 7])
    prev.phase = 'racing'

    const inputs: Intent[] = []
    for (let i = 0; i < 8; i++) {
      inputs[i] = makeIntent({ steer: i % 2 === 0 ? 0.5 : -0.5, accel: 1 })
    }

    step(ctx, prev, a, inputs, [])
    step(ctx, prev, b, inputs, [])
    expect(statesEqual(a, b)).toBe(true)
    expect(statesEqual(prev, a)).toBe(false)
  })
})
```

- [ ] **Step 14: Run the test to verify it fails**

Run: `npx vitest run packages/sim/test/step.test.ts -t "runs stepKart for every seat"`

Expected: FAIL with `expected 0 to be close to 0.4` — `step()` still only clones
and advances the tick.

- [ ] **Step 15: Wire `stepKart` into `step()`**

Replace `packages/sim/src/step.ts` in full. Before:

```typescript
import type { AuthEvent, Intent, SimContext, SimState } from './types'
import { cloneState } from './state'

/**
 * Advance the simulation by exactly one 60Hz tick.
 *
 * The tick starts by copying `prev` into `next`; every stage after that writes
 * only into `next`, which is what makes "never mutates prev" true globally.
 * `step` never reads the wall clock and never calls Math.random().
 *
 * The canonical per-kart stage order, filled in by later tasks, is:
 *   1. resolveInputs      [Task 15]
 *   2. updateRecovery     [Task 9]
 *   3. updateDrift        [Task 8]
 *   4. stepKart           [Task 6]
 *   5. applyAirYaw        [Task 7]
 *   6. integrateVertical  [Task 7]
 *   7. applyRamps         [Task 7]
 *   8. decayBoost         [Task 8]
 *   9. updateLaps         [Task 11]
 * then, once per tick after the kart loop:
 *   resolveKartCollisions [Task 10] -> updateEntities [Task 12]
 *   -> updateItemBoxes    [Task 13] -> updatePhase    [Task 15]
 */
export function step(
  ctx: SimContext,
  prev: SimState,
  next: SimState,
  inputs: Intent[],
  events: AuthEvent[],
): void {
  void ctx // used from Task 6 onward
  void inputs // used from Task 6 onward
  void events // used from Task 9 onward

  cloneState(prev, next)
  next.tick = prev.tick + 1
}
```

After — this is the complete file, nothing is elided:

```typescript
import type { AuthEvent, Intent, SimContext, SimState } from './types'
import { MAX_KARTS } from './types'
import { cloneState } from './state'
import { stepKart } from './kart'

/**
 * The intent used for a seat the caller supplied nothing for. Module-level so the
 * hot path allocates nothing; never mutated, and never handed to a kart directly —
 * it is copied into `resolvedInputs` like any other source intent.
 */
const NEUTRAL_INTENT: Intent = {
  tick: 0,
  steer: 0,
  accel: 0,
  brake: false,
  drift: false,
  useItem: false,
}

/**
 * The resolved intents the whole tick reads. `MAX_KARTS` distinct Intent objects,
 * allocated once at module load and rewritten in place every tick, because step()
 * must never allocate in the hot path. Indexed by kart slot.
 *
 * Task 15 replaces the fill loop below with
 * `resolveInputs(ctx, next, inputs, resolvedInputs)` and this initializer with
 * `makeIntentBuffer()`, which produces exactly this shape. The buffer, and the
 * `const raw = resolvedInputs[i]` line in the kart loop, exist from this task
 * onward so that Tasks 7, 8, 13 and 15 all edit against locals that are already
 * there.
 */
const resolvedInputs: Intent[] = Array.from({ length: MAX_KARTS }, () => ({
  tick: 0,
  steer: 0,
  accel: 0,
  brake: false,
  drift: false,
  useItem: false,
}))

/**
 * Advance the simulation by exactly one 60Hz tick.
 *
 * The tick starts by copying `prev` into `next`; every stage after that writes
 * only into `next`, which is what makes "never mutates prev" true globally.
 * `step` never reads the wall clock and never calls Math.random().
 *
 * `inputs` is indexed by kart slot (`inputs[i]` belongs to `next.karts[i]`, whose
 * `playerId` is `i`). The canonical per-kart stage order, filled in by later
 * tasks, is:
 *   1. resolveInputs      [Task 15] <- this task's fill loop stands in for it
 *   2. updateRecovery     [Task 9]
 *   3. updateDrift        [Task 8]
 *   4. stepKart           [Task 6]  <- implemented
 *   5. applyAirYaw        [Task 7]
 *   6. integrateVertical  [Task 7]
 *   7. applyRamps         [Task 7]
 *   8. decayBoost         [Task 8]
 *   9. updateLaps         [Task 11]
 * then, once per tick after the kart loop:
 *   resolveKartCollisions [Task 10] -> updateEntities [Task 12]
 *   -> updateItemBoxes    [Task 13] -> updatePhase    [Task 15]
 */
export function step(
  ctx: SimContext,
  prev: SimState,
  next: SimState,
  inputs: Intent[],
  events: AuthEvent[],
): void {
  void events // used from Task 9 onward, when updateRecovery joins the kart loop

  cloneState(prev, next)
  next.tick = prev.tick + 1

  // Canonical position 1, in its pre-Task-15 form: copy each supplied intent into
  // the resolved buffer, substituting NEUTRAL_INTENT for a seat the caller left
  // out. No phase gating, no bot fill, no 30Hz hold and no sanitisation yet — all
  // four arrive with Task 15, which replaces this whole loop with one call.
  for (let i = 0; i < MAX_KARTS; i++) {
    const supplied = inputs[i]
    const src = supplied === undefined ? NEUTRAL_INTENT : supplied
    const dst = resolvedInputs[i]
    dst.tick = src.tick
    dst.steer = src.steer
    dst.accel = src.accel
    dst.brake = src.brake
    dst.drift = src.drift
    dst.useItem = src.useItem
  }

  for (let i = 0; i < MAX_KARTS; i++) {
    const k = next.karts[i]
    const prevKart = prev.karts[i]
    const raw = resolvedInputs[i]
    stepKart(ctx, next, prevKart, k, raw)
  }
}
```

These three locals — `k`, `prevKart`, `raw` — are load-bearing. Tasks 7, 8, 13 and
15 insert their calls into this loop by anchoring on
`stepKart(ctx, next, prevKart, k, raw)`, so do not rename them, do not inline
them, and do not fold the two loops into one.

- [ ] **Step 16: Run the test to verify it passes**

Run: `npx vitest run packages/sim/test/step.test.ts`

Expected: PASS — 6 tests. The three tests written in Task 5 still pass unchanged:
they hold every kart at rest with no intents, so every seat resolves to
`NEUTRAL_INTENT`, and at zero speed with a neutral intent every term in `stepKart`
is exactly zero.

- [ ] **Step 17: Run the whole sim suite and the typecheck**

Run: `npx vitest run packages/sim && npx tsc --noEmit -p packages/sim`

Expected: PASS — every `packages/sim` test green (16 new kart tests and 3 new step
tests from this task, plus everything from Tasks 2–5), and `tsc` reports no errors.

- [ ] **Step 18: Commit**

```bash
git add packages/sim/src/kart.ts packages/sim/src/step.ts \
        packages/sim/test/kart.test.ts packages/sim/test/step.test.ts \
        packages/sim/test/helpers/flat-context.ts
git commit -m "feat(sim): kart steering, longitudinal and lateral grip wired into step()"
```

---

### Task 7: Ground, Air Yaw, Ramps and Boost Pads (`packages/sim/src/ground.ts`)

**Files:**
- Create: `packages/sim/src/ground.ts`
- Create: `packages/sim/test/ground.test.ts`
- Modify: `packages/sim/src/step.ts` — the per-kart loop body, immediately after the existing `stepKart(...)` call (canonical order slots 5, 6, the new surface slot 6b, 7 and the new boost-pad slot 7b)
- Test: `packages/sim/test/ground.test.ts`

**Interfaces:**

- Consumes (all already exist before this task):
  - From `./types` [Task 2]: `TICK_DT` (= `1/60`), and the types `KartState`, `SimContext`, `Surface`, `Vec3`, `TrackProjection`.
  - From `./mathutil` [Task 2]: `clamp(v: number, lo: number, hi: number): number`, `wrapAngle(a: number): number` (returns `(-PI, PI]`).
  - From `ctx.query` [Task 4, `TrackQuery`]: `project(p: Vec3): TrackProjection` (returns `{ s, lateral, distance }`), `sampleAt(s: number): TrackPoint`, `tangentAt(s: number): Vec3`, `groundHeight(s: number, lateral: number): number`, `surfaceAt(s: number, lateral: number): Surface`, `totalLength(): number`.
  - From `ctx.track` [Task 2 type, Task 3 fixtures]: `ramps: { sStart: number; sEnd: number; launch: number }[]` — `sStart` and `sEnd` are arc-normalised `s`, not metres.
  - From `ctx.tuning` [Task 2 type, Task 3 values]: `gravity` (30), `airYaw` (0.6), `steerRateBase` (2.6).
  - From `./fixtures/track-fixtures` [Task 3, `makeContext` from Task 4]: `makeStraightTrack(overrides?: Partial<Track>): Track`, `makeOvalTrack(overrides?: Partial<Track>): Track`, `makeContext(track: Track, isLeader?: boolean): SimContext`.
  - From `./state` [Task 5]: `createState(ctx: SimContext, seed: number, characterIdx: number[]): SimState` — used only by the `step()` wiring test.
  - From `./step` [Task 5, extended by Task 6]: `step(ctx, prev, next, inputs, events): void` — used only by the `step()` wiring test.
  - **One convention owned by Task 6 that this task depends on:** `stepKart` leaves `k.angularVelocity` holding the yaw rate it used on this tick, and has already advanced `k.heading` by `k.angularVelocity * TICK_DT`. `applyAirYaw` runs immediately after `stepKart` (slot 5) and rewrites both fields, so it must *undo* exactly that integration before putting the air-yaw share back. It never double-applies yaw.

- Produces:
  - `export function applyAirYaw(ctx: SimContext, k: KartState, steer: number): void` — contract signature, canonical slot 5.
  - `export function integrateVertical(ctx: SimContext, k: KartState): void` — contract signature, canonical slot 6.
  - `export function applyRamps(ctx: SimContext, k: KartState, s: number): void` — contract signature, canonical slot 7.
  - `export function applyBoostPad(ctx: SimContext, k: KartState, s: number, lateral: number): void` — **not in the locked contract**; defined by this task because `Track.boostPads` and `TrackQuery.surfaceAt` returning `'boost'` are otherwise inert. Runs at slot 7b, directly after `applyRamps`.
  - `export const RAMP_MIN_SPEED = 6` — **not in the locked contract**; the `Tuning` struct has no ramp speed threshold, so this task defines one and owns it.
  - `export const BOOST_PAD_TICKS = 36` — **not in the locked contract**; defined by this task. Even, for the same 30Hz-input reason `driftTiers` and `driftBoosts` are even.
  - One statement inside `step()`'s per-kart loop, at the new **slot 6b**:
    `k.surface = ctx.query.surfaceAt(groundS, groundLateral)`. **This task is the only writer of `k.surface` inside a tick** — `createState` seeds the field once at race start and nothing else ever recomputes it. Tasks 8, 9 and 6 all read it (`lateralGripFor`, `surfaceSpeedFactor`, the lateral damping), so without this line the dirt sector of `makeOvalTrack` drives as tarmac and no kart is ever `'offtrack'`.

**Design notes the implementation depends on (read before writing code):**

1. `applyAirYaw` is a no-op on the ground. Airborne, the kart keeps only `tuning.airYaw` (0.6) of a flat `tuning.steerRateBase` yaw rate — the speed falloff (`steerSpeedFalloff`) is deliberately *not* applied in the air, because the falloff models tyre grip and the tyres are not touching anything.
2. `integrateVertical` is the only place `position.y` and `velocity.y` are written. Grounded karts are snapped to `groundHeight` every tick, so a grounded kart can never accumulate a gap; the airborne flag is therefore only ever *entered* by `applyRamps` (and, in later tasks, by item effects that set `k.airborne` directly), and only ever *left* here.
3. The landing test is `position.y <= ground && velocity.y <= 0`. The `velocity.y <= 0` half is load-bearing: on the tick after a ramp launch the kart is at exactly ground height with a large positive `velocity.y`, and without that guard it would land instantly and the launch would be invisible.
4. `ctx.query.project()`, `sampleAt()` and `tangentAt()` each return a shared scratch object (Task 4 owns that decision, and `step()` must not allocate in the hot path). Copy `.s` and `.lateral` into locals immediately; never retain the returned object across another query call.
5. **Every `s` in this task is the contract's arc-normalised `[0, 1)` value, never metres.** `applyRamps` compares its `s` argument against `ramp.sStart`/`ramp.sEnd` directly, and `applyBoostPad` hands its `s` straight to `ctx.query.surfaceAt`, which wraps with `s - Math.floor(s)`. A test that passes `25` is therefore testing `s = 0.0`, not "25 m along". Metres are reached only by multiplying by `ctx.query.totalLength()`, which is **1828.3236243** for `makeStraightTrack` and **1427.7555092** for `makeOvalTrack`; every ramp span and pad offset below is written as a fraction of a lap with the metre figure in the comment.
6. `k.surface` is assigned at slot 6b from the *same* projection `applyRamps` and `applyBoostPad` use, so the surface a kart is damped by, penalised by and boosted by all describe the same square metre of track. It is written after `integrateVertical` so that a kart which landed this tick is classified where it landed.

---

- [ ] **Step 1: Write the failing test for `applyAirYaw`**

Create `packages/sim/test/ground.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import type { KartState } from '../src/types'
import {
  applyAirYaw,
  integrateVertical,
  applyRamps,
  applyBoostPad,
  RAMP_MIN_SPEED,
  BOOST_PAD_TICKS,
} from '../src/ground'
import { makeStraightTrack, makeContext } from './fixtures/track-fixtures'

/**
 * A complete KartState literal. Built locally rather than via createState() so the
 * numbers below depend on nothing but the fields set here. `lap` is never read by
 * this task; the real race-start value is
 * `{ lap: 0, checkpointIdx: track.checkpointS.length - 1, t: 0 }` (contract §0).
 */
function makeKart(overrides: Partial<KartState> = {}): KartState {
  return {
    playerId: 0,
    characterIdx: 0,
    isBot: false,
    connected: true,
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
    ...overrides,
  }
}

describe('ground fixture assumptions', () => {
  it('uses the base tuning values every number below is derived from', () => {
    const ctx = makeContext(makeStraightTrack())
    expect(ctx.tuning.gravity).toBe(30)
    expect(ctx.tuning.airYaw).toBe(0.6)
    expect(ctx.tuning.steerRateBase).toBe(2.6)
    // The straight fixture is a flat run along +X with no banking, so ground height
    // is 0 everywhere. s is arc-normalised [0, 1): 0.2 is a fifth of a lap.
    expect(ctx.query.groundHeight(0.2, 0)).toBe(0)
    // Every ramp span and pad offset below is a fraction of THIS length, in metres.
    expect(ctx.query.totalLength()).toBeCloseTo(1828.3236243, 6)
  })
})

describe('applyAirYaw', () => {
  it('does nothing at all while the kart is on the ground', () => {
    const ctx = makeContext(makeStraightTrack())
    const k = makeKart({ airborne: false, heading: 0.5, angularVelocity: 2 })

    applyAirYaw(ctx, k, 1)

    expect(k.heading).toBe(0.5)
    expect(k.angularVelocity).toBe(2)
  })

  it('cuts airborne yaw to steerRateBase * airYaw and rewinds stepKart yaw', () => {
    const ctx = makeContext(makeStraightTrack())
    const k = makeKart({ airborne: true, heading: 0.5, angularVelocity: 2 })

    applyAirYaw(ctx, k, 1)

    // airOmega = clamp(1) * steerRateBase(2.6) * airYaw(0.6) = 1.56
    expect(k.angularVelocity).toBeCloseTo(1.56, 10)
    // heading = 0.5 + (1.56 - 2) / 60 = 0.5 - 0.007333333333333333
    expect(k.heading).toBeCloseTo(0.4926666666666667, 10)
  })

  it('kills all yaw in the air when the stick is centred', () => {
    const ctx = makeContext(makeStraightTrack())
    const k = makeKart({ airborne: true, heading: 1, angularVelocity: 2 })

    applyAirYaw(ctx, k, 0)

    expect(k.angularVelocity).toBe(0)
    // heading = 1 + (0 - 2) / 60 = 1 - 0.03333333333333333
    expect(k.heading).toBeCloseTo(0.9666666666666667, 10)
  })

  it('clamps steer to -1..1 before scaling', () => {
    const ctx = makeContext(makeStraightTrack())
    const k = makeKart({ airborne: true, heading: 0, angularVelocity: 0 })

    applyAirYaw(ctx, k, -3)

    // clamp(-3) = -1 -> airOmega = -1 * 2.6 * 0.6 = -1.56
    expect(k.angularVelocity).toBeCloseTo(-1.56, 10)
    // heading = 0 + (-1.56 - 0) / 60 = -0.026
    expect(k.heading).toBeCloseTo(-0.026, 10)
  })

  it('wraps the resulting heading into (-PI, PI]', () => {
    const ctx = makeContext(makeStraightTrack())
    const k = makeKart({ airborne: true, heading: Math.PI - 0.001, angularVelocity: 0 })

    applyAirYaw(ctx, k, 1)

    // raw = (PI - 0.001) + 1.56 / 60 = 3.140592653589793 + 0.026 = 3.166592653589793
    // wrapped = 3.166592653589793 - 2*PI = -3.116592653589793
    expect(k.heading).toBeCloseTo(-3.116592653589793, 10)
    expect(k.heading).toBeGreaterThan(-Math.PI)
    expect(k.heading).toBeLessThanOrEqual(Math.PI)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/sim/test/ground.test.ts -t "applyAirYaw"`

Expected: FAIL with `Failed to resolve import "../src/ground"` (the module does not exist yet).

- [ ] **Step 3: Write `applyAirYaw`**

Create `packages/sim/src/ground.ts`:

```ts
import type { KartState, SimContext } from './types'
import { TICK_DT } from './types'
import { clamp, wrapAngle } from './mathutil'

/**
 * Minimum horizontal speed (world units/second) a kart needs before a ramp will
 * launch it. Not part of the locked Tuning struct; owned by this module.
 */
export const RAMP_MIN_SPEED = 6

/**
 * Boost ticks granted for touching a 'boost' surface. Even, for the same reason
 * every driftTiers/driftBoosts entry is: input arrives at 30Hz against a 60Hz
 * sim, so odd tick counts land inside windows no input can observe.
 */
export const BOOST_PAD_TICKS = 36

/**
 * Canonical order slot 5 — runs immediately after stepKart.
 *
 * stepKart has already set k.angularVelocity to the yaw rate it used and advanced
 * k.heading by that rate * TICK_DT. In the air the kart keeps only tuning.airYaw
 * of a flat steerRateBase turn (no speed falloff — the tyres are not on anything),
 * so this rewinds the ground yaw stepKart integrated and applies the air yaw in
 * its place. It is a no-op on the ground.
 */
export function applyAirYaw(ctx: SimContext, k: KartState, steer: number): void {
  if (!k.airborne) return
  const t = ctx.tuning
  const groundOmega = k.angularVelocity
  const airOmega = clamp(steer, -1, 1) * t.steerRateBase * t.airYaw
  k.heading = wrapAngle(k.heading + (airOmega - groundOmega) * TICK_DT)
  k.angularVelocity = airOmega
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/sim/test/ground.test.ts -t "applyAirYaw"`

Expected: PASS — 5 tests in the `applyAirYaw` block, plus the fixture-assumption test.

---

- [ ] **Step 5: Write the failing test for `integrateVertical`**

Append to `packages/sim/test/ground.test.ts`:

```ts
describe('integrateVertical', () => {
  it('applies gravity for one tick while airborne', () => {
    const ctx = makeContext(makeStraightTrack())
    const k = makeKart({
      airborne: true,
      position: { x: 10, y: 2, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
    })

    integrateVertical(ctx, k)

    // vy = 0 - gravity(30) / 60 = -0.5
    expect(k.velocity.y).toBeCloseTo(-0.5, 12)
    // y = 2 + (-0.5) / 60 = 2 - 0.008333333333333333
    expect(k.position.y).toBeCloseTo(1.9916666666666667, 12)
    expect(k.airborne).toBe(true)
  })

  it('accelerates downward over successive ticks', () => {
    const ctx = makeContext(makeStraightTrack())
    const k = makeKart({
      airborne: true,
      position: { x: 10, y: 2, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
    })

    integrateVertical(ctx, k)
    integrateVertical(ctx, k)

    // vy after two ticks = -1.0
    expect(k.velocity.y).toBeCloseTo(-1, 12)
    // y = 1.9916666666666667 + (-1) / 60 = 1.975
    expect(k.position.y).toBeCloseTo(1.975, 12)
    expect(k.airborne).toBe(true)
  })

  it('snaps to ground height and clears the airborne flag on landing', () => {
    const ctx = makeContext(makeStraightTrack())
    const k = makeKart({
      airborne: true,
      position: { x: 10, y: 0.004, z: 0 },
      velocity: { x: 0, y: -0.5, z: 0 },
    })

    integrateVertical(ctx, k)

    // vy = -0.5 - 0.5 = -1.0; y = 0.004 - 1/60 = -0.012666... which is <= ground(0)
    expect(k.position.y).toBe(0)
    expect(k.velocity.y).toBe(0)
    expect(k.airborne).toBe(false)
  })

  it('does not re-land a kart that is at ground height moving upward', () => {
    const ctx = makeContext(makeStraightTrack())
    const k = makeKart({
      airborne: true,
      position: { x: 10, y: 0, z: 0 },
      velocity: { x: 0, y: 9, z: 0 },
    })

    integrateVertical(ctx, k)

    // vy = 9 - 0.5 = 8.5; y = 0 + 8.5 / 60 = 0.14166666666666666
    expect(k.velocity.y).toBeCloseTo(8.5, 12)
    expect(k.position.y).toBeCloseTo(0.14166666666666666, 12)
    expect(k.airborne).toBe(true)
  })

  it('snaps a grounded kart to the surface and never applies gravity to it', () => {
    const ctx = makeContext(makeStraightTrack())
    const k = makeKart({
      airborne: false,
      position: { x: 10, y: 3, z: 0 },
      velocity: { x: 20, y: 0, z: 0 },
    })

    integrateVertical(ctx, k)

    expect(k.position.y).toBe(0)
    expect(k.velocity.y).toBe(0)   // not -0.5: gravity is airborne-only
    expect(k.airborne).toBe(false)
    expect(k.velocity.x).toBe(20)  // horizontal velocity is untouched
  })
})
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `npx vitest run packages/sim/test/ground.test.ts -t "integrateVertical"`

Expected: FAIL with `TypeError: integrateVertical is not a function` (imported but not yet exported by `src/ground.ts`).

- [ ] **Step 7: Write `integrateVertical`**

Append to `packages/sim/src/ground.ts`:

```ts
/**
 * Canonical order slot 6 — the only writer of position.y / velocity.y.
 *
 * Grounded: snapped to the analytic spline height every tick, so a grounded kart
 * can never drift off the surface. Airborne: integrate gravity, then land when the
 * kart has fallen to or below the surface *while descending*. The descending half
 * of that test is load-bearing — on the tick after a ramp launch the kart sits at
 * exactly ground height with a large positive velocity.y.
 *
 * ctx.query.project() may hand back a shared scratch object, so s and lateral are
 * read out immediately and the projection is never retained.
 */
export function integrateVertical(ctx: SimContext, k: KartState): void {
  const proj = ctx.query.project(k.position)
  const ground = ctx.query.groundHeight(proj.s, proj.lateral)

  if (!k.airborne) {
    k.position.y = ground
    k.velocity.y = 0
    return
  }

  k.velocity.y -= ctx.tuning.gravity * TICK_DT
  k.position.y += k.velocity.y * TICK_DT

  if (k.position.y <= ground && k.velocity.y <= 0) {
    k.position.y = ground
    k.velocity.y = 0
    k.airborne = false
  }
}
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `npx vitest run packages/sim/test/ground.test.ts -t "integrateVertical"`

Expected: PASS — 5 tests.

---

- [ ] **Step 9: Write the failing test for `applyRamps`**

Append to `packages/sim/test/ground.test.ts`:

```ts
/**
 * Ramp spans below are arc-normalised s, per the contract: s is always [0, 1).
 * makeStraightTrack's totalLength() is 1828.3236243 m, so the ramp used through
 * this block, { sStart: 0.2, sEnd: 0.3 }, covers
 *   0.2 * 1828.3236243 = 365.6647249 m  ..  0.3 * 1828.3236243 = 548.4970873 m
 * i.e. a 0.1-lap = 182.8323624 m stretch of the return leg.
 */
describe('applyRamps', () => {
  it('exposes an even, documented speed threshold', () => {
    expect(RAMP_MIN_SPEED).toBe(6)
  })

  it('launches a fast grounded kart inside the ramp s-range', () => {
    const ctx = makeContext(makeStraightTrack({ ramps: [{ sStart: 0.2, sEnd: 0.3, launch: 9 }] }))
    const k = makeKart({ airborne: false, velocity: { x: 12, y: 0, z: 0 } })

    // 0.25 * 1828.3236243 = 457.0809061 m, the middle of the ramp
    applyRamps(ctx, k, 0.25)

    expect(k.velocity.y).toBe(9)      // taken straight from ramp.launch
    expect(k.airborne).toBe(true)
    expect(k.velocity.x).toBe(12)     // horizontal velocity is preserved
  })

  it('treats both ends of the s-range as inside', () => {
    const ctx = makeContext(makeStraightTrack({ ramps: [{ sStart: 0.2, sEnd: 0.3, launch: 9 }] }))

    const atStart = makeKart({ velocity: { x: 12, y: 0, z: 0 } })
    applyRamps(ctx, atStart, 0.2)
    expect(atStart.velocity.y).toBe(9)

    const atEnd = makeKart({ velocity: { x: 12, y: 0, z: 0 } })
    applyRamps(ctx, atEnd, 0.3)
    expect(atEnd.velocity.y).toBe(9)
  })

  it('does not launch outside the s-range', () => {
    const ctx = makeContext(makeStraightTrack({ ramps: [{ sStart: 0.2, sEnd: 0.3, launch: 9 }] }))

    // 0.199 * 1828.3236243 = 363.8364012 m, i.e. 1.83 m short of the ramp
    const before = makeKart({ velocity: { x: 12, y: 0, z: 0 } })
    applyRamps(ctx, before, 0.199)
    expect(before.velocity.y).toBe(0)
    expect(before.airborne).toBe(false)

    // 0.301 * 1828.3236243 = 550.3254109 m, i.e. 1.83 m past its end
    const after = makeKart({ velocity: { x: 12, y: 0, z: 0 } })
    applyRamps(ctx, after, 0.301)
    expect(after.velocity.y).toBe(0)
    expect(after.airborne).toBe(false)
  })

  it('does not launch below RAMP_MIN_SPEED and does launch exactly at it', () => {
    const ctx = makeContext(makeStraightTrack({ ramps: [{ sStart: 0.2, sEnd: 0.3, launch: 9 }] }))

    const slow = makeKart({ velocity: { x: 5.9, y: 0, z: 0 } })
    applyRamps(ctx, slow, 0.25)
    expect(slow.velocity.y).toBe(0)
    expect(slow.airborne).toBe(false)

    const exact = makeKart({ velocity: { x: 6, y: 0, z: 0 } })  // speed = sqrt(36) = 6
    applyRamps(ctx, exact, 0.25)
    expect(exact.velocity.y).toBe(9)
    expect(exact.airborne).toBe(true)
  })

  it('measures speed on the xz plane only', () => {
    const ctx = makeContext(makeStraightTrack({ ramps: [{ sStart: 0.2, sEnd: 0.3, launch: 9 }] }))

    const diagonal = makeKart({ velocity: { x: 3, y: 0, z: 4 } })  // sqrt(9+16) = 5 < 6
    applyRamps(ctx, diagonal, 0.25)
    expect(diagonal.velocity.y).toBe(0)

    const faster = makeKart({ velocity: { x: 6, y: 0, z: 8 } })    // sqrt(36+64) = 10 >= 6
    applyRamps(ctx, faster, 0.25)
    expect(faster.velocity.y).toBe(9)
  })

  it('never re-launches a kart that is already airborne', () => {
    const ctx = makeContext(makeStraightTrack({ ramps: [{ sStart: 0.2, sEnd: 0.3, launch: 9 }] }))
    const k = makeKart({ airborne: true, velocity: { x: 20, y: -2, z: 0 } })

    applyRamps(ctx, k, 0.25)

    expect(k.velocity.y).toBe(-2)
    expect(k.airborne).toBe(true)
  })

  it('handles a ramp whose range wraps through s = 0', () => {
    // sStart 0.3 > sEnd 0.05, so the range is [0.3, 1) plus [0, 0.05]: from
    // 548.4970873 m round through the start line to 91.4161812 m.
    const ctx = makeContext(makeStraightTrack({ ramps: [{ sStart: 0.3, sEnd: 0.05, launch: 7 }] }))

    // 0.02 * 1828.3236243 = 36.5664725 m, inside the [0, 0.05] half
    const justAfterZero = makeKart({ velocity: { x: 12, y: 0, z: 0 } })
    applyRamps(ctx, justAfterZero, 0.02)
    expect(justAfterZero.velocity.y).toBe(7)

    // 0.35 * 1828.3236243 = 639.9132685 m, inside the [0.3, 1) half
    const justBeforeZero = makeKart({ velocity: { x: 12, y: 0, z: 0 } })
    applyRamps(ctx, justBeforeZero, 0.35)
    expect(justBeforeZero.velocity.y).toBe(7)

    // 0.17 * 1828.3236243 = 310.8150161 m, in the gap between the two halves
    const middle = makeKart({ velocity: { x: 12, y: 0, z: 0 } })
    applyRamps(ctx, middle, 0.17)
    expect(middle.velocity.y).toBe(0)
    expect(middle.airborne).toBe(false)
  })

  it('launches from the first matching ramp when ranges overlap', () => {
    const ctx = makeContext(
      makeStraightTrack({
        ramps: [
          { sStart: 0.2, sEnd: 0.3, launch: 9 },
          { sStart: 0.25, sEnd: 0.4, launch: 4 },
        ],
      }),
    )
    const k = makeKart({ velocity: { x: 12, y: 0, z: 0 } })

    // 0.27 * 1828.3236243 = 493.6473786 m, inside both ramps
    applyRamps(ctx, k, 0.27)

    expect(k.velocity.y).toBe(9)
  })
})
```

- [ ] **Step 10: Run the test to verify it fails**

Run: `npx vitest run packages/sim/test/ground.test.ts -t "applyRamps"`

Expected: FAIL with `TypeError: applyRamps is not a function`.

- [ ] **Step 11: Write `applyRamps`**

Append to `packages/sim/src/ground.ts`:

```ts
/**
 * Canonical order slot 7 — runs after the vertical integration, so a kart that
 * landed this tick can be launched again by the ramp it landed on.
 *
 * `s` is the kart's current arc-normalised position along the centreline, [0, 1)
 * per the contract — never metres. The caller supplies it rather than this function
 * re-projecting, because step() already has it. `ramp.sStart` and `ramp.sEnd` are in
 * the same units, so the comparison is direct; a ramp whose sStart is greater than
 * its sEnd wraps through the start/finish line.
 */
export function applyRamps(ctx: SimContext, k: KartState, s: number): void {
  if (k.airborne) return

  const vx = k.velocity.x
  const vz = k.velocity.z
  const speed = Math.sqrt(vx * vx + vz * vz)
  if (speed < RAMP_MIN_SPEED) return

  const ramps = ctx.track.ramps
  for (let i = 0; i < ramps.length; i++) {
    const r = ramps[i]
    const inside =
      r.sStart <= r.sEnd
        ? s >= r.sStart && s <= r.sEnd
        : s >= r.sStart || s <= r.sEnd
    if (!inside) continue
    k.velocity.y = r.launch
    k.airborne = true
    return
  }
}
```

- [ ] **Step 12: Run the test to verify it passes**

Run: `npx vitest run packages/sim/test/ground.test.ts -t "applyRamps"`

Expected: PASS — 9 tests.

---

- [ ] **Step 13: Write the failing test for `applyBoostPad`**

Append to `packages/sim/test/ground.test.ts`:

```ts
/**
 * The pad used through this block is { s: 0.1, lateral: 0, halfWidth: 2 } on
 * makeStraightTrack, whose totalLength() is 1828.3236243 m. So:
 *   - the pad sits 0.1 * 1828.3236243 = 182.8323624 m along the lap;
 *   - buildTrackQuery gives every pad BOOST_PAD_HALF_LENGTH = 4 m of longitudinal
 *     reach [Task 4], which is 4 / 1828.3236243 = 0.0021878 of s;
 *   - it is 2 m wide either side of the centreline (halfWidth), against the
 *     fixture's uniform 20 m track width, so lateral 3 is on tarmac, not on the pad.
 * s is arc-normalised [0, 1) per the contract: surfaceAt wraps with
 * `s - Math.floor(s)`, so a raw `30` would silently mean s = 0.0.
 */
describe('applyBoostPad', () => {
  it('grants an even number of boost ticks', () => {
    // Input is 30Hz against a 60Hz sim, so every tick budget the player can
    // perceive the start and end of is defined in multiples of 2 ticks.
    expect(BOOST_PAD_TICKS).toBe(36)
    expect(BOOST_PAD_TICKS % 2).toBe(0)
  })

  it('grants boost ticks when the surface under the kart is boost', () => {
    const ctx = makeContext(makeStraightTrack({ boostPads: [{ s: 0.1, lateral: 0, halfWidth: 2 }] }))
    expect(ctx.query.surfaceAt(0.1, 0)).toBe('boost')

    const k = makeKart({ airborne: false, boostTicks: 0 })
    applyBoostPad(ctx, k, 0.1, 0)

    expect(k.boostTicks).toBe(36)
  })

  it('grants nothing off the side of the pad', () => {
    const ctx = makeContext(makeStraightTrack({ boostPads: [{ s: 0.1, lateral: 0, halfWidth: 2 }] }))
    // |3 - 0| = 3 > halfWidth 2, and 3 is still inside the 20 m track, so: tarmac
    expect(ctx.query.surfaceAt(0.1, 3)).toBe('tarmac')

    const k = makeKart({ boostTicks: 0 })
    applyBoostPad(ctx, k, 0.1, 3)

    expect(k.boostTicks).toBe(0)
  })

  it('grants nothing further along the track than the pad', () => {
    const ctx = makeContext(makeStraightTrack({ boostPads: [{ s: 0.1, lateral: 0, halfWidth: 2 }] }))

    // 0.103 - 0.1 = 0.003 of a lap = 5.4849709 m, past the pad's 4 m reach
    expect(ctx.query.surfaceAt(0.103, 0)).toBe('tarmac')
    const justPast = makeKart({ boostTicks: 0 })
    applyBoostPad(ctx, justPast, 0.103, 0)
    expect(justPast.boostTicks).toBe(0)

    // 0.3 - 0.1 = 0.2 of a lap = 365.6647249 m, a fifth of the track away
    const farPast = makeKart({ boostTicks: 0 })
    applyBoostPad(ctx, farPast, 0.3, 0)
    expect(farPast.boostTicks).toBe(0)
  })

  it('grants nothing while the kart is flying over the pad', () => {
    const ctx = makeContext(makeStraightTrack({ boostPads: [{ s: 0.1, lateral: 0, halfWidth: 2 }] }))
    const k = makeKart({ airborne: true, boostTicks: 0 })

    applyBoostPad(ctx, k, 0.1, 0)

    expect(k.boostTicks).toBe(0)
  })

  it('extends a shorter boost but never shortens a longer one', () => {
    const ctx = makeContext(makeStraightTrack({ boostPads: [{ s: 0.1, lateral: 0, halfWidth: 2 }] }))

    const shorter = makeKart({ boostTicks: 20 })
    applyBoostPad(ctx, shorter, 0.1, 0)
    expect(shorter.boostTicks).toBe(36)

    const longer = makeKart({ boostTicks: 50 })   // e.g. a tier-3 drift boost of 66, part spent
    applyBoostPad(ctx, longer, 0.1, 0)
    expect(longer.boostTicks).toBe(50)
  })
})
```

- [ ] **Step 14: Run the test to verify it fails**

Run: `npx vitest run packages/sim/test/ground.test.ts -t "applyBoostPad"`

Expected: FAIL with `TypeError: applyBoostPad is not a function`.

- [ ] **Step 15: Write `applyBoostPad`**

Append to `packages/sim/src/ground.ts`:

```ts
/**
 * Canonical order slot 7b — directly after applyRamps, before decayBoost.
 *
 * This is what makes Track.boostPads and a 'boost' result from surfaceAt do
 * anything: it tops the kart's boost timer up to BOOST_PAD_TICKS. `s` is
 * arc-normalised [0, 1) per the contract and is handed straight to the query.
 *
 * It re-reads the surface from the query rather than from k.surface, so the pad
 * grant cannot depend on the order of the two: slot 6b writes k.surface from the
 * same s and lateral, one line earlier in step().
 *
 * Airborne karts are skipped — flying over a pad is not driving over it. The top-up
 * never shortens a longer boost already running (a tier-3 drift boost is 66 ticks;
 * clipping it to 36 on a pad would be a downgrade).
 */
export function applyBoostPad(ctx: SimContext, k: KartState, s: number, lateral: number): void {
  if (k.airborne) return
  if (ctx.query.surfaceAt(s, lateral) !== 'boost') return
  if (k.boostTicks < BOOST_PAD_TICKS) k.boostTicks = BOOST_PAD_TICKS
}
```

- [ ] **Step 16: Run the whole ground suite**

Run: `npx vitest run packages/sim/test/ground.test.ts`

Expected: PASS — 26 tests across the five describe blocks.

---

- [ ] **Step 17: Write the failing test for the surface slot in `step()`**

`k.surface` is written once by `createState` and, without this task, never again: the
dirt sector of `makeOvalTrack` would drive as tarmac forever and no kart would ever be
`'offtrack'`. Slot 6b fixes that, and it lives in `step()` because that is where the
projection already exists.

First replace the import block at the top of `packages/sim/test/ground.test.ts`.
Before:

```ts
import { describe, it, expect } from 'vitest'
import type { KartState } from '../src/types'
import {
  applyAirYaw,
  integrateVertical,
  applyRamps,
  applyBoostPad,
  RAMP_MIN_SPEED,
  BOOST_PAD_TICKS,
} from '../src/ground'
import { makeStraightTrack, makeContext } from './fixtures/track-fixtures'
```

After:

```ts
import { describe, it, expect } from 'vitest'
import type { KartState } from '../src/types'
import {
  applyAirYaw,
  integrateVertical,
  applyRamps,
  applyBoostPad,
  RAMP_MIN_SPEED,
  BOOST_PAD_TICKS,
} from '../src/ground'
import { createState } from '../src/state'
import { step } from '../src/step'
import { makeOvalTrack, makeStraightTrack, makeContext } from './fixtures/track-fixtures'
```

Then append to `packages/sim/test/ground.test.ts`:

```ts
describe('step — the surface under each kart', () => {
  it('recomputes k.surface from the query for every kart, every tick', () => {
    // makeOvalTrack: control points 12 and 13 are dirt, so s in [0.640104, 0.780208)
    // is dirt; the bottom straight is 24 m wide (edge at |lateral| = 12) and the
    // banked right turn is 20 m wide, all tarmac. totalLength() = 1427.7555092.
    const ctx = makeContext(makeOvalTrack())
    const prev = createState(ctx, 1, [0, 0, 0, 0, 0, 0, 0, 0])
    const next = createState(ctx, 1, [0, 0, 0, 0, 0, 0, 0, 0])

    // sampleAt and tangentAt hand back shared scratch, so each field is copied out
    // before the next query call.
    const banked = ctx.query.sampleAt(0.35).position   // inside the right turn
    const bankedX = banked.x
    const bankedZ = banked.z

    const dirt = ctx.query.sampleAt(0.7).position      // inside the dirt sector
    const dirtX = dirt.x
    const dirtZ = dirt.z

    const edge = ctx.query.sampleAt(0.02).position     // on the 24 m bottom straight
    const edgeX = edge.x
    const edgeZ = edge.z
    const tan = ctx.query.tangentAt(0.02)
    const rx = -tan.z                                  // right = (-t.z, 0, t.x)
    const rz = tan.x

    // step() copies prev into next before anything else, so the setup goes on prev.
    // Kart 0: centreline of the banked turn -> tarmac, overwriting a stale 'dirt'.
    prev.karts[0].position.x = bankedX
    prev.karts[0].position.y = 0
    prev.karts[0].position.z = bankedZ
    prev.karts[0].surface = 'dirt'

    // Kart 1: centreline of the dirt sector -> dirt.
    prev.karts[1].position.x = dirtX
    prev.karts[1].position.y = 0
    prev.karts[1].position.z = dirtZ
    prev.karts[1].surface = 'tarmac'

    // Kart 2: 20 m right of the centreline of a 24 m wide straight, so 8 m past the
    // edge -> offtrack. (isInBounds still allows it: the run-off reaches 24 m.)
    prev.karts[2].position.x = edgeX + rx * 20
    prev.karts[2].position.y = 0
    prev.karts[2].position.z = edgeZ + rz * 20
    prev.karts[2].surface = 'tarmac'

    // Empty inputs: every seat gets the neutral intent step()'s loop substitutes, so
    // no kart moves and the only thing under test is the surface classification.
    step(ctx, prev, next, [], [])

    expect(next.karts[0].surface).toBe('tarmac')
    expect(next.karts[1].surface).toBe('dirt')
    expect(next.karts[2].surface).toBe('offtrack')

    // prev is never written
    expect(prev.karts[0].surface).toBe('dirt')
    expect(prev.karts[1].surface).toBe('tarmac')
    expect(prev.karts[2].surface).toBe('tarmac')
  })

  it('marks a kart standing on a boost pad and pays it the pad boost', () => {
    // makeOvalTrack's pad is { s: 0.1, lateral: 0, halfWidth: 4 }, and buildTrackQuery
    // gives every pad BOOST_PAD_HALF_LENGTH = 4 m of reach = 4 / 1427.7555092 =
    // 0.0028016 of s, so the centreline point at s = 0.1 is inside it.
    const ctx = makeContext(makeOvalTrack())
    const prev = createState(ctx, 2, [0, 0, 0, 0, 0, 0, 0, 0])
    const next = createState(ctx, 2, [0, 0, 0, 0, 0, 0, 0, 0])

    const pad = ctx.query.sampleAt(0.1).position
    prev.karts[0].position.x = pad.x
    prev.karts[0].position.y = 0
    prev.karts[0].position.z = pad.z
    prev.karts[0].surface = 'tarmac'
    prev.karts[0].boostTicks = 0

    step(ctx, prev, next, [], [])

    expect(next.karts[0].surface).toBe('boost')
    // applyBoostPad granted BOOST_PAD_TICKS on this same tick. Task 8 later wires
    // decayBoost in as the last call of the loop, which spends one tick of it, so
    // this asserts the grant happened rather than an exact remaining count.
    expect(next.karts[0].boostTicks).toBeGreaterThanOrEqual(BOOST_PAD_TICKS - 1)
  })
})
```

- [ ] **Step 18: Run the test to verify it fails**

Run: `npx vitest run packages/sim/test/ground.test.ts -t "the surface under each kart"`

Expected: FAIL with `expected 'dirt' to be 'tarmac'` on the first test — `step()` still
ends its per-kart loop at `stepKart`, so nothing recomputes `k.surface` and kart 0 keeps
the stale value the setup put on it.

- [ ] **Step 19: Wire slots 5, 6, 6b, 7 and 7b into `step()`**

Modify `packages/sim/src/step.ts`.

Add this import alongside the other `./` imports at the top of the file:

```ts
import { applyAirYaw, integrateVertical, applyRamps, applyBoostPad } from './ground'
```

Then extend the per-kart loop body. Task 6 wrote that body as exactly these four lines,
and they are the anchor. Before:

```ts
    const k = next.karts[i]
    const prevKart = prev.karts[i]
    const raw = resolvedInputs[i]
    stepKart(ctx, next, prevKart, k, raw)
```

After:

```ts
    const k = next.karts[i]
    const prevKart = prev.karts[i]
    const raw = resolvedInputs[i]
    stepKart(ctx, next, prevKart, k, raw)
    applyAirYaw(ctx, k, raw.steer)
    integrateVertical(ctx, k)
    // project() returns shared scratch, so both fields are copied out at once and
    // the projection itself is never retained across the calls below.
    const groundProj = ctx.query.project(k.position)
    const groundS = groundProj.s
    const groundLateral = groundProj.lateral
    // Slot 6b: the only recomputation of k.surface in the whole tick. Tasks 6, 8 and
    // 9 read this field (lateral grip, lateralGripFor, surfaceSpeedFactor); without
    // this line it keeps whatever createState put there at the start line forever.
    k.surface = ctx.query.surfaceAt(groundS, groundLateral)
    applyRamps(ctx, k, groundS)
    applyBoostPad(ctx, k, groundS, groundLateral)
```

Do not add a second `stepKart` call and do not reorder anything else in the loop. The
three locals above `stepKart` are unchanged by this edit; they are quoted only so the
insertion point is unambiguous.

- [ ] **Step 20: Run the test to verify it passes**

Run: `npx vitest run packages/sim/test/ground.test.ts`

Expected: PASS — 28 tests across the six describe blocks.

- [ ] **Step 21: Verify nothing regressed**

Run: `npx vitest run packages/sim`

Expected: PASS — the whole `packages/sim` suite, including every test written by Tasks
2–6, still passes. The first 26 ground tests call the four functions directly, so they
are unaffected by the wiring; this step is checking that inserting the calls did not
break `step()`'s existing behaviour.

Then run: `npx tsc --noEmit -p packages/sim`

Expected: PASS with no output (no unused-local or type errors from the new import).

- [ ] **Step 22: Commit**

```bash
git add packages/sim/src/ground.ts packages/sim/src/step.ts packages/sim/test/ground.test.ts
git commit -m "feat(sim): air yaw, vertical integration, ramp launches, boost pads and the surface slot

applyAirYaw cuts steering authority to tuning.airYaw while airborne by rewinding
the yaw stepKart integrated this tick. integrateVertical is the only writer of
position.y/velocity.y: gravity while airborne, snap to query.groundHeight on
landing, and it owns the airborne flag's falling edge. applyRamps launches a
grounded kart above RAMP_MIN_SPEED whose s falls inside a ramp range (wrapping
ranges included), imparting ramp.launch as +y velocity. applyBoostPad tops the
boost timer up to BOOST_PAD_TICKS on a 'boost' surface, which is what finally
makes Track.boostPads do something.

step() also gains slot 6b, k.surface = query.surfaceAt(...) from the same
projection: createState seeded that field once and nothing recomputed it, so the
dirt sector drove as tarmac and no kart was ever offtrack.

Every s here is the contract's arc-normalised [0, 1), never metres: ramp spans and
pad offsets are fractions of query.totalLength()."
```

---

### Task 8: Drift, Mini-Turbo and Boost Decay (`packages/sim/src/drift.ts`)

**Files:**
- Create: `packages/sim/src/drift.ts`
- Create: `packages/sim/test/drift.test.ts`
- Modify: `packages/sim/src/kart.ts` — three edits: add the `lateralGripFor` import, replace `stepKart`'s call to Task 6's private `gripFor` with a call to `lateralGripFor`, and delete the now-callerless `gripFor` function, so the coefficient has exactly one definition (exact before/after in Step 19)
- Modify: `packages/sim/src/step.ts` — the per-kart loop body: `updateDrift` on the line before the existing `stepKart(...)` call (canonical order slot 3), `decayBoost` as the last statement of the loop body (canonical order slot 8) (exact before/after in Step 21)
- Test: `packages/sim/test/drift.test.ts`

**Interfaces:**

- Consumes (all already exist before this task):
  - From `./types` [Task 2]: `TICK_DT` (= `1/60`), and the types `Intent`, `KartState`, `SimContext`, `Surface`.
  - From `ctx.tuning` [Task 2 type, Task 3 values]: `driftMinSpeed` (8), `driftTiers` (`[40, 90, 150]`), `driftBoosts` (`[24, 42, 66]`), `gripDrift` (3), `gripDirt` (5), `gripTarmac` (14).
  - From `./state` [Task 5]: `createState(ctx: SimContext, seed: number, characterIdx: number[]): SimState` — used by two tests only.
  - From `./kart` [Task 6]: `stepKart(ctx: SimContext, state: SimState, prevKart: KartState, k: KartState, raw: Intent): void` — used by two tests, and edited by Step 19.
  - From `./fixtures/track-fixtures` [Task 3, `makeContext` from Task 4]: `makeTuning(overrides?: Partial<Tuning>): Tuning`, `makeStraightTrack(overrides?: Partial<Track>): Track`, `makeContext(track: Track, isLeader?: boolean): SimContext`.

- Produces:
  - `export function updateDrift(ctx: SimContext, k: KartState, raw: Intent): void` — contract signature, canonical slot 3 (runs **before** `stepKart`, so the drift flag it sets is visible to `stepKart`'s lateral damping on the same tick).
  - `export function decayBoost(k: KartState): void` — contract signature, canonical slot 8.
  - `export function driftTierFor(charge: number, tiers: [number, number, number]): number` — **not in the locked contract**; defined here. Returns `-1` (no tier), `0`, `1` or `2`, indexing straight into `tuning.driftBoosts`.
  - `export function lateralGripFor(ctx: SimContext, k: KartState): number` — **not in the locked contract**; defined here. The single definition of the lateral damping coefficient: `tuning.gripDrift` while drifting, `tuning.gripDirt` on dirt, `tuning.gripTarmac` otherwise. `stepKart` (Task 6) is the consumer, and **Step 19 of this task is what makes that true**: it deletes the private copy of the same rule that Task 6 wrote inside `kart.ts` as `function gripFor(k, t)`. That copy agrees with this one on all four surfaces (`'offtrack'` grips like tarmac in both), which is the only reason no expectation changes here — but two copies of one rule is how they drifted apart before, so exactly one of them survives this step.
  - `export const DRIFT_STEER_MIN = 0.35` — **not in the locked contract**; the `Tuning` struct has no drift steer threshold, so this task defines and owns one.

- **Import direction** (there is no cycle to worry about): `drift.ts` imports only from `./types`. Step 19 adds `import { lateralGripFor } from './drift'` to `kart.ts`, so the dependency runs `kart.ts → drift.ts` and never back. `drift.test.ts` imports both, which is a test-only edge.

**Design notes the implementation depends on (read before writing code):**

1. **`charge` is measured in ticks.** It increments by exactly 1 per tick while drift is held, including the tick the drift latches. `driftTiers` `[40, 90, 150]` therefore means 0.667s / 1.5s / 2.5s of held drift, and `driftBoosts` `[24, 42, 66]` means 0.4s / 0.7s / 1.1s of boost. This reading is what makes the "every entry is even" rule in the contract mean anything — see step 3 below.
2. **Latching.** A drift latches only on a tick where `raw.drift` is true, `Math.abs(raw.steer) >= DRIFT_STEER_MIN` and the kart's **xz** speed is strictly greater than `tuning.driftMinSpeed`. `drift.dir` is the sign of the steer that latched it (`+1` = the player was steering right). Once latched, the direction is *latched*: steering the other way, or straightening completely, does not change `dir` and does not stop the charge. That is the whole point of the word.
3. **Charge caps at `driftTiers[2]`** (150). The wire format gives drift charge 8 bits, so an uncapped counter would overflow the snapshot after ~4 seconds of held drift. Capping at the top tier is free — nothing above it does anything.
4. **Two things cancel a drift with no payout:** the xz speed falling to or below `driftMinSpeed` while still held (the boost is paid for by carrying speed through the corner), and `spinOutTicks > 0` or `respawnTicks > 0` (Task 9 owns those timers; this task only reads them).
5. **Being airborne does not break a drift.** A kart holding a drift over a ramp keeps its latch and keeps charging. Breaking on every jump would make ramp corners unchargeable.
6. **Boost grants use max, never assignment.** `k.boostTicks = Math.max(k.boostTicks, driftBoosts[tier])` — releasing a first-tier drift (24 ticks) must not truncate a boost-pad or item boost that is already running longer.

---

- [ ] **Step 1: Write the failing test for the tier table and its evenness rule**

Create `packages/sim/test/drift.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import type { Intent, KartState } from '../src/types'
import {
  updateDrift,
  decayBoost,
  driftTierFor,
  lateralGripFor,
  DRIFT_STEER_MIN,
} from '../src/drift'
import { createState } from '../src/state'
import { stepKart } from '../src/kart'
import { makeTuning, makeStraightTrack, makeContext } from './fixtures/track-fixtures'

/**
 * A complete KartState literal. Built locally rather than via createState() so the
 * numbers below depend on nothing but the fields set here. `lap` is never read by
 * this task; the real race-start value is
 * `{ lap: 0, checkpointIdx: track.checkpointS.length - 1, t: 0 }` (contract §0).
 */
function makeKart(overrides: Partial<KartState> = {}): KartState {
  return {
    playerId: 0,
    characterIdx: 0,
    isBot: false,
    connected: true,
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
    ...overrides,
  }
}

function makeIntent(overrides: Partial<Intent> = {}): Intent {
  return { tick: 0, steer: 0, accel: 1, brake: false, drift: false, useItem: false, ...overrides }
}

describe('drift fixture assumptions', () => {
  it('uses the base tuning values every number below is derived from', () => {
    const t = makeTuning()
    expect(t.driftMinSpeed).toBe(8)
    expect(t.driftTiers).toEqual([40, 90, 150])
    expect(t.driftBoosts).toEqual([24, 42, 66])
    expect(t.gripDrift).toBe(3)
    expect(t.gripDirt).toBe(5)
    expect(t.gripTarmac).toBe(14)
  })
})

describe('drift tier quantization', () => {
  it('defines every tier threshold and every boost length in whole 2-tick pairs', () => {
    const t = makeTuning()
    for (const threshold of t.driftTiers) {
      expect(threshold % 2).toBe(0)
    }
    for (const boost of t.driftBoosts) {
      expect(boost % 2).toBe(0)
    }
    // Spelled out so a tuning change that breaks the rule fails with a readable diff:
    expect(t.driftTiers).toEqual([40, 90, 150])   // 0.667s / 1.5s / 2.5s of held drift
    expect(t.driftBoosts).toEqual([24, 42, 66])   // 0.4s / 0.7s / 1.1s of boost
  })
})

describe('driftTierFor', () => {
  it('maps charge to the tier index that indexes driftBoosts', () => {
    const tiers: [number, number, number] = [40, 90, 150]
    expect(driftTierFor(0, tiers)).toBe(-1)
    expect(driftTierFor(39, tiers)).toBe(-1)
    expect(driftTierFor(40, tiers)).toBe(0)
    expect(driftTierFor(89, tiers)).toBe(0)
    expect(driftTierFor(90, tiers)).toBe(1)
    expect(driftTierFor(149, tiers)).toBe(1)
    expect(driftTierFor(150, tiers)).toBe(2)
  })

  it('saturates at the top tier', () => {
    const tiers: [number, number, number] = [40, 90, 150]
    expect(driftTierFor(1000, tiers)).toBe(2)
  })
})
```

**Why every entry of `driftTiers` and `driftBoosts` must be even.** Clients send input intents at 30Hz while the simulation runs at 60Hz, and the authority holds the newest intent and applies it to *both* ticks of each pair. `raw.drift` can therefore only change value on the first tick of a pair, so a held drift always spans an even number of ticks. Since `charge` increments by exactly 1 per tick while held, **the value of `charge` at the moment of release is always even**. An odd threshold — 41, say — would be unreachable: it would behave identically to 40 for every input a human can produce and identically to 42 for none, and the tuning table would contain a number with no observable meaning. Worse, it would be an invisible trap for whoever tunes the game next, who would move a tier by one and see nothing change. The same argument applies to `driftBoosts`, which `decayBoost` decrements once per tick: an odd duration ends on a tick that falls inside an input pair, so the boost's end lands one tick early or late depending on the parity of the tick it started on. Both tables are defined in multiples of 2 ticks, and the test above is what stops that rule from quietly rotting.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/sim/test/drift.test.ts -t "driftTierFor"`

Expected: FAIL with `Failed to resolve import "../src/drift"` (the module does not exist yet).

- [ ] **Step 3: Write `driftTierFor`, `lateralGripFor` and the module constants**

Create `packages/sim/src/drift.ts`:

```ts
import type { Intent, KartState, SimContext } from './types'

/**
 * Minimum |steer| that will latch a drift. Not part of the locked Tuning struct;
 * owned by this module.
 */
export const DRIFT_STEER_MIN = 0.35

/**
 * Which mini-turbo tier a charge has reached: -1 for none, otherwise an index
 * straight into tuning.driftBoosts.
 *
 * charge is a tick count, so the thresholds are tick counts too. Every threshold is
 * even because input is 30Hz against a 60Hz sim: a held drift always spans an even
 * number of ticks, so an odd threshold would sit inside a window no input can land
 * in and would be indistinguishable from the even number below it.
 */
export function driftTierFor(charge: number, tiers: [number, number, number]): number {
  if (charge >= tiers[2]) return 2
  if (charge >= tiers[1]) return 1
  if (charge >= tiers[0]) return 0
  return -1
}

/**
 * The lateral damping coefficient for this kart on this tick — the single
 * definition of it in the sim. Drifting deliberately retains lateral velocity
 * (gripDrift 3 against gripTarmac 14), which is what makes a drift a drift rather
 * than a tighter turn. Surfaces with no grip entry of their own ('boost',
 * 'offtrack') damp like tarmac; 'offtrack' is penalised through
 * surfaceSpeedFactor instead, not through grip.
 */
export function lateralGripFor(ctx: SimContext, k: KartState): number {
  const t = ctx.tuning
  if (k.drift.active) return t.gripDrift
  if (k.surface === 'dirt') return t.gripDirt
  return t.gripTarmac
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/sim/test/drift.test.ts -t "driftTierFor"`

Expected: PASS — 2 tests. Then run `npx vitest run packages/sim/test/drift.test.ts -t "quantization"` — the evenness test also passes.

---

- [ ] **Step 5: Write the failing test for latching**

Append to `packages/sim/test/drift.test.ts`:

```ts
describe('updateDrift — latching', () => {
  it('latches right and starts the charge on the same tick', () => {
    const ctx = makeContext(makeStraightTrack())
    const k = makeKart({ velocity: { x: 12, y: 0, z: 0 } })   // xz speed 12 > driftMinSpeed 8

    updateDrift(ctx, k, makeIntent({ drift: true, steer: 1 }))

    expect(k.drift.active).toBe(true)
    expect(k.drift.dir).toBe(1)
    expect(k.drift.charge).toBe(1)   // the latching tick itself counts
  })

  it('latches left on negative steer', () => {
    const ctx = makeContext(makeStraightTrack())
    const k = makeKart({ velocity: { x: 12, y: 0, z: 0 } })

    updateDrift(ctx, k, makeIntent({ drift: true, steer: -0.9 }))

    expect(k.drift.active).toBe(true)
    expect(k.drift.dir).toBe(-1)
    expect(k.drift.charge).toBe(1)
  })

  it('will not latch below the steer threshold and will at it', () => {
    expect(DRIFT_STEER_MIN).toBe(0.35)
    const ctx = makeContext(makeStraightTrack())

    const tooStraight = makeKart({ velocity: { x: 12, y: 0, z: 0 } })
    updateDrift(ctx, tooStraight, makeIntent({ drift: true, steer: 0.34 }))
    expect(tooStraight.drift.active).toBe(false)
    expect(tooStraight.drift.dir).toBe(0)
    expect(tooStraight.drift.charge).toBe(0)

    const atThreshold = makeKart({ velocity: { x: 12, y: 0, z: 0 } })
    updateDrift(ctx, atThreshold, makeIntent({ drift: true, steer: 0.35 }))
    expect(atThreshold.drift.active).toBe(true)
    expect(atThreshold.drift.charge).toBe(1)
  })

  it('will not latch at or below driftMinSpeed and will above it', () => {
    const ctx = makeContext(makeStraightTrack())

    const exactlyMin = makeKart({ velocity: { x: 8, y: 0, z: 0 } })   // speed 8 === driftMinSpeed
    updateDrift(ctx, exactlyMin, makeIntent({ drift: true, steer: 1 }))
    expect(exactlyMin.drift.active).toBe(false)
    expect(exactlyMin.drift.charge).toBe(0)

    const aboveMin = makeKart({ velocity: { x: 8.5, y: 0, z: 0 } })
    updateDrift(ctx, aboveMin, makeIntent({ drift: true, steer: 1 }))
    expect(aboveMin.drift.active).toBe(true)
    expect(aboveMin.drift.charge).toBe(1)
  })

  it('measures drift speed on the xz plane only', () => {
    const ctx = makeContext(makeStraightTrack())

    const diagonal = makeKart({ velocity: { x: 6, y: 99, z: 8 } })    // sqrt(36+64) = 10 > 8
    updateDrift(ctx, diagonal, makeIntent({ drift: true, steer: 1 }))
    expect(diagonal.drift.active).toBe(true)

    const fallingOnly = makeKart({ velocity: { x: 0, y: 99, z: 0 } }) // xz speed 0
    updateDrift(ctx, fallingOnly, makeIntent({ drift: true, steer: 1 }))
    expect(fallingOnly.drift.active).toBe(false)
  })

  it('does nothing when the drift button is not held and none is active', () => {
    const ctx = makeContext(makeStraightTrack())
    const k = makeKart({ velocity: { x: 30, y: 0, z: 0 }, boostTicks: 0 })

    updateDrift(ctx, k, makeIntent({ drift: false, steer: 1 }))

    expect(k.drift.active).toBe(false)
    expect(k.drift.dir).toBe(0)
    expect(k.drift.charge).toBe(0)
    expect(k.boostTicks).toBe(0)
  })
})
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `npx vitest run packages/sim/test/drift.test.ts -t "latching"`

Expected: FAIL with `TypeError: updateDrift is not a function`.

- [ ] **Step 7: Write `updateDrift`**

Append to `packages/sim/src/drift.ts`:

```ts
/**
 * Canonical order slot 3 — runs before stepKart, so the drift flag set here is
 * what stepKart's lateral damping sees on the same tick.
 *
 * Latch: drift held, |steer| at or beyond DRIFT_STEER_MIN, xz speed strictly above
 * tuning.driftMinSpeed. dir is the sign of the steer that latched it and never
 * changes afterwards, so a player may straighten or counter-steer mid-drift.
 *
 * Charge: +1 tick per held tick including the latching tick, capped at the top
 * tier (the wire format gives drift charge 8 bits).
 *
 * Release: the tier reached grants tuning.driftBoosts[tier] boost ticks, applied as
 * a maximum so a longer boost already running is never truncated.
 *
 * Cancelled with no payout by: speed falling to or below driftMinSpeed while held,
 * a spin-out, or a respawn. Being airborne does not cancel a drift.
 */
export function updateDrift(ctx: SimContext, k: KartState, raw: Intent): void {
  const t = ctx.tuning
  const d = k.drift

  if (k.spinOutTicks > 0 || k.respawnTicks > 0) {
    d.active = false
    d.dir = 0
    d.charge = 0
    return
  }

  const vx = k.velocity.x
  const vz = k.velocity.z
  const speed = Math.sqrt(vx * vx + vz * vz)

  if (!raw.drift) {
    if (d.active) {
      const tier = driftTierFor(d.charge, t.driftTiers)
      if (tier >= 0) {
        const ticks = t.driftBoosts[tier]
        if (k.boostTicks < ticks) k.boostTicks = ticks
      }
    }
    d.active = false
    d.dir = 0
    d.charge = 0
    return
  }

  if (!d.active) {
    if (speed <= t.driftMinSpeed) return
    if (Math.abs(raw.steer) < DRIFT_STEER_MIN) return
    d.active = true
    d.dir = raw.steer > 0 ? 1 : -1
    d.charge = 0
  } else if (speed <= t.driftMinSpeed) {
    d.active = false
    d.dir = 0
    d.charge = 0
    return
  }

  const cap = t.driftTiers[2]
  const next = d.charge + 1
  d.charge = next < cap ? next : cap
}
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `npx vitest run packages/sim/test/drift.test.ts -t "latching"`

Expected: PASS — 6 tests.

---

- [ ] **Step 9: Write the failing test for charging and cancellation**

Append to `packages/sim/test/drift.test.ts`:

```ts
describe('updateDrift — charging', () => {
  it('accrues exactly one charge per held tick', () => {
    const ctx = makeContext(makeStraightTrack())
    const k = makeKart({ velocity: { x: 20, y: 0, z: 0 } })
    const held = makeIntent({ drift: true, steer: 1 })

    for (let i = 0; i < 40; i++) updateDrift(ctx, k, held)

    expect(k.drift.charge).toBe(40)   // 40 calls, +1 each, latch tick included
    expect(k.drift.active).toBe(true)
    expect(k.drift.dir).toBe(1)
  })

  it('keeps the latched direction when the player counter-steers', () => {
    const ctx = makeContext(makeStraightTrack())
    const k = makeKart({ velocity: { x: 20, y: 0, z: 0 } })

    updateDrift(ctx, k, makeIntent({ drift: true, steer: 1 }))
    for (let i = 0; i < 5; i++) updateDrift(ctx, k, makeIntent({ drift: true, steer: -1 }))

    expect(k.drift.dir).toBe(1)       // latched right on tick 1 and stayed right
    expect(k.drift.charge).toBe(6)    // 1 + 5
    expect(k.drift.active).toBe(true)
  })

  it('keeps charging with the stick centred once latched', () => {
    const ctx = makeContext(makeStraightTrack())
    const k = makeKart({ velocity: { x: 20, y: 0, z: 0 } })

    updateDrift(ctx, k, makeIntent({ drift: true, steer: 1 }))
    for (let i = 0; i < 9; i++) updateDrift(ctx, k, makeIntent({ drift: true, steer: 0 }))

    expect(k.drift.charge).toBe(10)
    expect(k.drift.active).toBe(true)
  })

  it('caps charge at the top tier so the 8-bit wire field cannot overflow', () => {
    const ctx = makeContext(makeStraightTrack())
    const k = makeKart({ velocity: { x: 20, y: 0, z: 0 } })
    const held = makeIntent({ drift: true, steer: 1 })

    for (let i = 0; i < 200; i++) updateDrift(ctx, k, held)

    expect(k.drift.charge).toBe(150)  // driftTiers[2]
  })

  it('keeps the drift alive while the kart is airborne', () => {
    const ctx = makeContext(makeStraightTrack())
    const k = makeKart({ velocity: { x: 20, y: 0, z: 0 }, airborne: true })
    const held = makeIntent({ drift: true, steer: 1 })

    for (let i = 0; i < 10; i++) updateDrift(ctx, k, held)

    expect(k.drift.active).toBe(true)
    expect(k.drift.charge).toBe(10)
  })

  it('cancels with no boost when speed falls to driftMinSpeed while still held', () => {
    const ctx = makeContext(makeStraightTrack())
    const k = makeKart({ velocity: { x: 20, y: 0, z: 0 } })
    const held = makeIntent({ drift: true, steer: 1 })

    for (let i = 0; i < 50; i++) updateDrift(ctx, k, held)
    expect(k.drift.charge).toBe(50)   // past driftTiers[0] = 40, so a tier was reached

    k.velocity.x = 8                  // dropped to driftMinSpeed
    updateDrift(ctx, k, held)

    expect(k.drift.active).toBe(false)
    expect(k.drift.dir).toBe(0)
    expect(k.drift.charge).toBe(0)
    expect(k.boostTicks).toBe(0)      // charge is forfeited, not paid out
  })

  it('cancels with no boost during a spin-out or a respawn', () => {
    const ctx = makeContext(makeStraightTrack())
    const held = makeIntent({ drift: true, steer: 1 })

    const spun = makeKart({
      velocity: { x: 20, y: 0, z: 0 },
      drift: { active: true, dir: 1, charge: 100 },
      spinOutTicks: 30,
    })
    updateDrift(ctx, spun, held)
    expect(spun.drift.active).toBe(false)
    expect(spun.drift.charge).toBe(0)
    expect(spun.boostTicks).toBe(0)

    const respawning = makeKart({
      velocity: { x: 20, y: 0, z: 0 },
      drift: { active: true, dir: -1, charge: 100 },
      respawnTicks: 40,
    })
    updateDrift(ctx, respawning, held)
    expect(respawning.drift.active).toBe(false)
    expect(respawning.drift.charge).toBe(0)
    expect(respawning.boostTicks).toBe(0)
  })
})
```

- [ ] **Step 10: Run the test to verify it passes**

Run: `npx vitest run packages/sim/test/drift.test.ts -t "charging"`

Expected: PASS — 7 tests. `updateDrift` from step 7 already implements all of this; this cycle is the coverage that pins the accrual rate, the cap and both cancellation paths so a later tuning change cannot quietly break them. If any of the seven fails, the implementation in step 7 was mistyped — re-read it against the failure rather than editing the test.

---

- [ ] **Step 11: Write the failing test for the release payout**

Append to `packages/sim/test/drift.test.ts`:

```ts
describe('updateDrift — release', () => {
  it('pays nothing for a charge below the first tier', () => {
    const ctx = makeContext(makeStraightTrack())
    const k = makeKart({
      velocity: { x: 20, y: 0, z: 0 },
      drift: { active: true, dir: 1, charge: 39 },   // driftTiers[0] is 40
    })

    updateDrift(ctx, k, makeIntent({ drift: false, steer: 1 }))

    expect(k.boostTicks).toBe(0)
    expect(k.drift.active).toBe(false)
    expect(k.drift.dir).toBe(0)
    expect(k.drift.charge).toBe(0)
  })

  it('pays each tier the matching driftBoosts entry', () => {
    const ctx = makeContext(makeStraightTrack())
    const release = makeIntent({ drift: false, steer: 1 })
    const cases: Array<[number, number]> = [
      [40, 24],   // driftTiers[0] -> driftBoosts[0]
      [89, 24],
      [90, 42],   // driftTiers[1] -> driftBoosts[1]
      [149, 42],
      [150, 66],  // driftTiers[2] -> driftBoosts[2]
    ]

    for (const [charge, expected] of cases) {
      const k = makeKart({
        velocity: { x: 20, y: 0, z: 0 },
        drift: { active: true, dir: 1, charge },
      })
      updateDrift(ctx, k, release)
      expect(k.boostTicks).toBe(expected)
      expect(k.drift.active).toBe(false)
      expect(k.drift.charge).toBe(0)
    }
  })

  it('charges for 90 ticks and releases a second-tier boost end to end', () => {
    const ctx = makeContext(makeStraightTrack())
    const k = makeKart({ velocity: { x: 20, y: 0, z: 0 } })
    const held = makeIntent({ drift: true, steer: 1 })

    for (let i = 0; i < 90; i++) updateDrift(ctx, k, held)
    expect(k.drift.charge).toBe(90)

    updateDrift(ctx, k, makeIntent({ drift: false, steer: 1 }))

    // charge 90 >= driftTiers[1] (90) and < driftTiers[2] (150) -> driftBoosts[1] = 42
    expect(k.boostTicks).toBe(42)
    expect(k.drift.active).toBe(false)
  })

  it('extends a shorter running boost but never truncates a longer one', () => {
    const ctx = makeContext(makeStraightTrack())
    const release = makeIntent({ drift: false, steer: 1 })

    const longerAlreadyRunning = makeKart({
      velocity: { x: 20, y: 0, z: 0 },
      drift: { active: true, dir: 1, charge: 40 },   // would grant 24
      boostTicks: 50,                                // e.g. part of a tier-3 boost
    })
    updateDrift(ctx, longerAlreadyRunning, release)
    expect(longerAlreadyRunning.boostTicks).toBe(50)

    const shorterAlreadyRunning = makeKart({
      velocity: { x: 20, y: 0, z: 0 },
      drift: { active: true, dir: 1, charge: 150 },  // grants 66
      boostTicks: 10,
    })
    updateDrift(ctx, shorterAlreadyRunning, release)
    expect(shorterAlreadyRunning.boostTicks).toBe(66)
  })

  it('pays nothing when the button is released with no drift active', () => {
    const ctx = makeContext(makeStraightTrack())
    const k = makeKart({
      velocity: { x: 20, y: 0, z: 0 },
      drift: { active: false, dir: 0, charge: 140 },  // stale charge, no active drift
    })

    updateDrift(ctx, k, makeIntent({ drift: false, steer: 1 }))

    expect(k.boostTicks).toBe(0)
    expect(k.drift.charge).toBe(0)
  })
})
```

- [ ] **Step 12: Run the test to verify it passes**

Run: `npx vitest run packages/sim/test/drift.test.ts -t "release"`

Expected: PASS — 5 tests. As in step 10, the release path is already implemented by step 7; this cycle pins the payout table.

---

- [ ] **Step 13: Write the failing test for `decayBoost`**

Append to `packages/sim/test/drift.test.ts`:

```ts
describe('decayBoost', () => {
  it('spends one boost tick per call', () => {
    const k = makeKart({ boostTicks: 5 })
    decayBoost(k)
    expect(k.boostTicks).toBe(4)
  })

  it('stops at zero and never goes negative', () => {
    const k = makeKart({ boostTicks: 1 })
    decayBoost(k)
    expect(k.boostTicks).toBe(0)
    decayBoost(k)
    expect(k.boostTicks).toBe(0)
    decayBoost(k)
    expect(k.boostTicks).toBe(0)
  })

  it('spends a first-tier boost in exactly 24 ticks', () => {
    const k = makeKart({ boostTicks: 24 })   // driftBoosts[0]

    for (let i = 0; i < 23; i++) decayBoost(k)
    expect(k.boostTicks).toBe(1)

    decayBoost(k)
    expect(k.boostTicks).toBe(0)
  })

  it('touches nothing but boostTicks', () => {
    const k = makeKart({
      boostTicks: 5,
      spinOutTicks: 7,
      invulnTicks: 9,
      respawnTicks: 11,
      drift: { active: true, dir: 1, charge: 30 },
    })

    decayBoost(k)

    expect(k.boostTicks).toBe(4)
    expect(k.spinOutTicks).toBe(7)   // updateRecovery owns these, not this function
    expect(k.invulnTicks).toBe(9)
    expect(k.respawnTicks).toBe(11)
    expect(k.drift.charge).toBe(30)
  })

  it('leaves 23 ticks on the tick a first-tier boost is released', () => {
    // Canonical per-kart order: updateDrift is slot 3, decayBoost is slot 8, so the
    // tick a boost is granted also spends one tick of it.
    const ctx = makeContext(makeStraightTrack())
    const k = makeKart({
      velocity: { x: 20, y: 0, z: 0 },
      drift: { active: true, dir: 1, charge: 40 },
    })

    updateDrift(ctx, k, makeIntent({ drift: false, steer: 1 }))
    decayBoost(k)

    expect(k.boostTicks).toBe(23)   // 24 granted, 1 spent on the release tick
  })
})
```

- [ ] **Step 14: Run the test to verify it fails**

Run: `npx vitest run packages/sim/test/drift.test.ts -t "decayBoost"`

Expected: FAIL with `TypeError: decayBoost is not a function`.

- [ ] **Step 15: Write `decayBoost`**

Append to `packages/sim/src/drift.ts`:

```ts
/**
 * Canonical order slot 8 — the last thing to touch the kart before updateLaps.
 *
 * Spends one tick of any running boost, whatever granted it (drift release, boost
 * pad, boost item). It owns boostTicks and nothing else: spinOutTicks, invulnTicks
 * and respawnTicks belong to updateRecovery.
 */
export function decayBoost(k: KartState): void {
  if (k.boostTicks > 0) k.boostTicks -= 1
}
```

- [ ] **Step 16: Run the test to verify it passes**

Run: `npx vitest run packages/sim/test/drift.test.ts -t "decayBoost"`

Expected: PASS — 5 tests.

---

- [ ] **Step 17: Write the failing test for drift grip**

First widen the type import at the top of `packages/sim/test/drift.test.ts`. Before:

```ts
import type { Intent, KartState } from '../src/types'
```

After:

```ts
import type { Intent, KartState, Surface } from '../src/types'
import { TICK_DT } from '../src/types'
```

Then append to `packages/sim/test/drift.test.ts`:

```ts
describe('lateralGripFor', () => {
  it('returns gripDrift while drifting and the surface grip otherwise', () => {
    const ctx = makeContext(makeStraightTrack())

    expect(lateralGripFor(ctx, makeKart({ surface: 'tarmac' }))).toBe(14)
    expect(lateralGripFor(ctx, makeKart({ surface: 'dirt' }))).toBe(5)
    expect(lateralGripFor(ctx, makeKart({ surface: 'boost' }))).toBe(14)
    expect(lateralGripFor(ctx, makeKart({ surface: 'offtrack' }))).toBe(14)
  })

  it('lets the drift flag override every surface', () => {
    const ctx = makeContext(makeStraightTrack())
    const drifting = { active: true, dir: 1 as const, charge: 30 }

    expect(lateralGripFor(ctx, makeKart({ surface: 'tarmac', drift: drifting }))).toBe(3)
    expect(lateralGripFor(ctx, makeKart({ surface: 'dirt', drift: drifting }))).toBe(3)
  })

  it('makes a drifting kart hold more lateral velocity through stepKart', () => {
    // Every number here, recomputed from the base tuning:
    //   heading 0 -> forward = (1, 0, 0), right = (0, 0, 1), so velocity.z IS vr.
    //   vf = 20, vr = 6, character 0 (speed 1.00, accel 1.00), boostTicks 0.
    //   target  = maxSpeed 40 * 1.00 * accel 1 * 1 * 1 * 1 = 40
    //   maxDelta = accelRate 24 * 1.00 / 60 = 0.4, so newVf = 20 + 0.4 = 20.4 for both
    //   gripping: gripTarmac 14 -> 6 * (1 - 14/60) = 6 * 0.7666666666666666 = 4.6
    //   drifting: gripDrift  3 -> 6 * (1 -  3/60) = 6 * 0.95                = 5.7
    const ctx = makeContext(makeStraightTrack())
    const state = createState(ctx, 1, [0, 0, 0, 0, 0, 0, 0, 0])
    const raw = makeIntent({ accel: 1, steer: 0 })

    const gripping = state.karts[0]
    gripping.position.x = 20
    gripping.position.y = 0
    gripping.position.z = 0
    gripping.velocity.x = 20
    gripping.velocity.y = 0
    gripping.velocity.z = 6
    gripping.heading = 0
    gripping.surface = 'tarmac'
    gripping.drift.active = false
    gripping.drift.dir = 0
    gripping.drift.charge = 0
    gripping.boostTicks = 0
    const grippingPrev = makeKart({
      position: { x: 20, y: 0, z: 0 },
      velocity: { x: 20, y: 0, z: 6 },
    })
    stepKart(ctx, state, grippingPrev, gripping, raw)

    const drifting = state.karts[1]
    drifting.position.x = 20
    drifting.position.y = 0
    drifting.position.z = 0
    drifting.velocity.x = 20
    drifting.velocity.y = 0
    drifting.velocity.z = 6
    drifting.heading = 0
    drifting.surface = 'tarmac'
    drifting.drift.active = true
    drifting.drift.dir = 1
    drifting.drift.charge = 20
    drifting.boostTicks = 0
    const driftingPrev = makeKart({
      playerId: 1,
      position: { x: 20, y: 0, z: 0 },
      velocity: { x: 20, y: 0, z: 6 },
      drift: { active: true, dir: 1, charge: 19 },
    })
    stepKart(ctx, state, driftingPrev, drifting, raw)

    // gripTarmac 14 damps the 6 u/s slide hard; gripDrift 3 barely touches it.
    expect(gripping.velocity.z).toBeCloseTo(4.6, 12)
    expect(drifting.velocity.z).toBeCloseTo(5.7, 12)
    expect(Math.abs(drifting.velocity.z)).toBeGreaterThan(Math.abs(gripping.velocity.z))
    // the longitudinal half is identical for both, so only grip is under test here
    expect(gripping.velocity.x).toBeCloseTo(20.4, 12)
    expect(drifting.velocity.x).toBeCloseTo(20.4, 12)
  })

  it('damps lateral velocity by exactly lateralGripFor on every surface', () => {
    // This is the test that keeps stepKart and lateralGripFor from drifting apart:
    // the expectation is computed FROM lateralGripFor, not from a literal, so a
    // second private copy of the grip rule inside kart.ts cannot stay hidden.
    // Concretely: tarmac / boost / offtrack -> gripTarmac 14 -> 6 * (1 - 14/60) = 4.6
    //             dirt                      -> gripDirt    5 -> 6 * (1 -  5/60) = 5.5
    const ctx = makeContext(makeStraightTrack())
    const state = createState(ctx, 3, [0, 0, 0, 0, 0, 0, 0, 0])
    const raw = makeIntent({ accel: 1, steer: 0 })
    const surfaces: Surface[] = ['tarmac', 'dirt', 'boost', 'offtrack']

    for (const surface of surfaces) {
      const k = state.karts[0]
      k.position.x = 20
      k.position.y = 0
      k.position.z = 0
      k.velocity.x = 20
      k.velocity.y = 0
      k.velocity.z = 6
      k.heading = 0          // forward = (1, 0, 0), right = (0, 0, 1)
      k.angularVelocity = 0
      k.surface = surface
      k.drift.active = false
      k.drift.dir = 0
      k.drift.charge = 0
      k.boostTicks = 0

      // read before stepKart runs, so the coefficient is the one the tick will use
      const expected = 6 * (1 - lateralGripFor(ctx, k) * TICK_DT)

      const prevKart = makeKart({ velocity: { x: 20, y: 0, z: 6 } })
      stepKart(ctx, state, prevKart, k, raw)

      expect(k.velocity.z).toBeCloseTo(expected, 12)
    }
  })
})
```

- [ ] **Step 18: Run the grip tests**

Run: `npx vitest run packages/sim/test/drift.test.ts -t "lateralGripFor"`

Expected: PASS — 4 tests. The first two exercise `lateralGripFor` directly; the last two run it through `stepKart`, which is the consumer.

The fourth test computes its expectation by calling `lateralGripFor`, so it passes both before and after Step 19: Task 6's private expression and `lateralGripFor` return the same coefficient on all four surfaces, which is why the duplication went unnoticed long enough to end up in the audit. Step 19 is scheduled anyway — it is a de-duplication, not a behaviour change, and this test is what keeps the two from separating again.

---

- [ ] **Step 19: Make `stepKart` read `lateralGripFor`, deleting the second definition**

Task 6 wrote its own copy of the lateral-grip rule inside `kart.ts`, as a module-level `gripFor(k, t)`, because `drift.ts` did not exist yet. This step removes that copy so `lateralGripFor` is the only definition in the package. Task 6's **Interfaces** block names exactly these three edits and they must all be made together: after Edit 2 the call site is gone, so leaving `gripFor` in place would fail `tsc --noEmit` in Step 22 with `TS6133: 'gripFor' is declared but its value is never read`.

Modify `packages/sim/src/kart.ts`. Three edits.

**Edit 1 — add the import.** Before (the three import lines exactly as Task 6's Step 7 left them; the `Tuning` in the type import is Task 6's and stays):

```typescript
import type { CharacterStats, Intent, KartState, SimContext, SimState, Tuning } from './types'
import { TICK_DT } from './types'
import { clamp, wrapAngle } from './mathutil'
```

After:

```typescript
import type { CharacterStats, Intent, KartState, SimContext, SimState, Tuning } from './types'
import { TICK_DT } from './types'
import { clamp, wrapAngle } from './mathutil'
import { lateralGripFor } from './drift'
```

`drift.ts` imports nothing but `./types`, so this edge runs `kart.ts → drift.ts` and there is no cycle.

**Edit 2 — replace the lateral-grip block of `stepKart`.** It is the block that runs from the `// --- Lateral grip` banner to the `const newVr = ...` line, between the longitudinal block and the two `k.velocity` assignments. Before:

```typescript
    // --- Lateral grip -------------------------------------------------------
    // Task 8 sets drift.active; the consumer lives here because updateDrift runs
    // before stepKart in the canonical order and has nowhere to apply grip.
    // Task 8 changes this one line to: const grip = lateralGripFor(ctx, k)
    const grip = gripFor(k, t)
    const newVr = vr * (1 - clamp(grip * TICK_DT, 0, 1))
```

After:

```typescript
    // --- Lateral grip -------------------------------------------------------
    // lateralGripFor (Task 8) is the single definition of this coefficient:
    // gripDrift while drifting, gripDirt on dirt, gripTarmac on everything else
    // ('boost' and 'offtrack' included — offtrack is penalised through
    // surfaceSpeedFactor, not through grip). updateDrift runs at slot 3, before
    // stepKart, so k.drift.active already holds this tick's value.
    const newVr = vr * (1 - clamp(lateralGripFor(ctx, k) * TICK_DT, 0, 1))
```

**Edit 3 — delete `gripFor` outright.** Edit 2 removed its only call site. It sits between `targetSpeedFor` and `stepKart`, exactly as Task 6's Step 11 inserted it. Delete all of this, doc comment included. Before:

```typescript
/**
 * The lateral damping coefficient, in 1/s: how hard the sideways component of the
 * velocity is bled off this tick.
 *
 * `'offtrack'` grips like tarmac on purpose. Leaving the track is punished with
 * speed (`offtrackSpeedMul`, Task 9), not with a slide; making it slippery as
 * well would make a bad line unrecoverable.
 *
 * Task 8 owns the single definition of this rule, `lateralGripFor(ctx, k)` in
 * `drift.ts`, and it returns the same value for all four surfaces. Task 8 deletes
 * this function, adds `import { lateralGripFor } from './drift'` to this file and
 * changes the one call site below to `const grip = lateralGripFor(ctx, k)`.
 */
function gripFor(k: KartState, t: Tuning): number {
  if (k.drift.active) return t.gripDrift
  if (k.surface === 'dirt') return t.gripDirt
  return t.gripTarmac
}
```

After:

```
(nothing — the whole block above is removed. `targetSpeedFor`'s closing brace and
`stepKart`'s doc comment become adjacent, separated by one blank line.)
```

Nothing else in `kart.ts` changes, and nothing is left unused:

- `t` (`const t = ctx.tuning`) still has uses in both `stepKart` (`t.maxSpeed`, `t.steerSpeedFalloff`, `t.steerRateBase`, `t.brakeRate`, `t.accelRate`) and `targetSpeedFor`.
- the `Tuning` type import survives Edit 3 because `surgeFactorFor(state, k, t: Tuning)` — Task 6's other module-level helper, which Task 12 rewrites — still annotates with it.
- `clamp` and `TICK_DT` still have other uses, and `newVr` still feeds the same two `k.velocity` assignments below.

So after all three edits `tsc --noEmit` (Step 22) has no unused local, no unused import and no unresolved reference.

- [ ] **Step 20: Run the kart and drift suites**

Run: `npx vitest run packages/sim/test/kart.test.ts packages/sim/test/drift.test.ts`

Expected: PASS — Task 6's 15 kart tests and this task's 31 drift tests. Task 6's
"damps less on dirt" test and the four-surface test above now assert the same rule
against the same function.

---

- [ ] **Step 21: Wire slots 3 and 8 into `step()`**

Modify `packages/sim/src/step.ts`.

Add this import alongside the other `./` imports at the top of the file:

```ts
import { updateDrift, decayBoost } from './drift'
```

Then extend the per-kart loop body. `updateDrift` goes immediately **before** the `stepKart` call, and `decayBoost` becomes the **last statement of the loop body**. Task 6 wrote the first three lines and Task 7 appended the ground calls, so the block is exactly this. Before:

```ts
    const k = next.karts[i]
    const prevKart = prev.karts[i]
    const raw = resolvedInputs[i]
    stepKart(ctx, next, prevKart, k, raw)
    applyAirYaw(ctx, k, raw.steer)
    integrateVertical(ctx, k)
    // project() returns shared scratch, so both fields are copied out at once and
    // the projection itself is never retained across the calls below.
    const groundProj = ctx.query.project(k.position)
    const groundS = groundProj.s
    const groundLateral = groundProj.lateral
    // Slot 6b: the only recomputation of k.surface in the whole tick. Tasks 6, 8 and
    // 9 read this field (lateral grip, lateralGripFor, surfaceSpeedFactor); without
    // this line it keeps whatever createState put there at the start line forever.
    k.surface = ctx.query.surfaceAt(groundS, groundLateral)
    applyRamps(ctx, k, groundS)
    applyBoostPad(ctx, k, groundS, groundLateral)
```

After:

```ts
    const k = next.karts[i]
    const prevKart = prev.karts[i]
    const raw = resolvedInputs[i]
    updateDrift(ctx, k, raw)
    stepKart(ctx, next, prevKart, k, raw)
    applyAirYaw(ctx, k, raw.steer)
    integrateVertical(ctx, k)
    // project() returns shared scratch, so both fields are copied out at once and
    // the projection itself is never retained across the calls below.
    const groundProj = ctx.query.project(k.position)
    const groundS = groundProj.s
    const groundLateral = groundProj.lateral
    // Slot 6b: the only recomputation of k.surface in the whole tick. Tasks 6, 8 and
    // 9 read this field (lateral grip, lateralGripFor, surfaceSpeedFactor); without
    // this line it keeps whatever createState put there at the start line forever.
    k.surface = ctx.query.surfaceAt(groundS, groundLateral)
    applyRamps(ctx, k, groundS)
    applyBoostPad(ctx, k, groundS, groundLateral)
    decayBoost(k)
```

The order matters in both directions: `updateDrift` must run first so `stepKart` sees this tick's drift flag through `lateralGripFor`, and `decayBoost` must run last so a boost granted this tick is spent for exactly the number of ticks it was granted for.

- [ ] **Step 22: Verify nothing regressed**

Run: `npx vitest run packages/sim`

Expected: PASS — the whole `packages/sim` suite, including every test written by Tasks 2–7, still passes.

Then run: `npx tsc --noEmit -p packages/sim`

Expected: PASS with no output. This is the step that catches a half-applied Step 19: with `tsconfig`'s `noUnusedLocals: true`, keeping `gripFor` after Edit 2 removed its call site fails with `TS6133: 'gripFor' is declared but its value is never read`, and skipping Edit 1 fails with `TS2304: Cannot find name 'lateralGripFor'`. All three edits, or none.

- [ ] **Step 23: Commit**

```bash
git add packages/sim/src/drift.ts packages/sim/src/kart.ts packages/sim/src/step.ts \
        packages/sim/test/drift.test.ts
git commit -m "feat(sim): drift latch, mini-turbo charge and boost decay

updateDrift latches a slide direction when the drift button goes down with the
stick past DRIFT_STEER_MIN and xz speed above tuning.driftMinSpeed, accrues one
charge tick per held tick (capped at the top tier so the 8-bit wire field cannot
overflow), and on release grants tuning.driftBoosts[tier] as a maximum against
any boost already running. Losing speed, spinning out or respawning forfeits the
charge; being airborne does not. lateralGripFor is the single definition of the
lateral damping coefficient and returns tuning.gripDrift while drifting, which is
what makes a drift a slide rather than a tighter turn; kart.ts's own gripFor copy
of that rule is deleted here, so there is no second place for 'offtrack' to start
meaning gripDirt again. decayBoost spends one boost tick per tick and owns nothing
else.

driftTiers and driftBoosts are asserted to be even: input is 30Hz against a 60Hz
sim, so a held drift always spans an even number of ticks and an odd threshold
would sit in a window no input can land in."
```

---

### Task 9: Recovery — spin-out, respawn, surface speed penalty

**Files:**
- Create: `packages/sim/src/recovery.ts`
- Test: `packages/sim/test/recovery.test.ts`
- Modify: `packages/sim/src/kart.ts` (four edits — the import line, the `surfaceFactor`
  literal inside `targetSpeedFor`, and the motion and steering locks inside `stepKart`;
  exact before/after in Step 20)
- Modify: `packages/sim/test/kart.test.ts` (append one describe block; exact code in Step 18)
- Modify: `packages/sim/src/step.ts` (three edits — the import line, the slot-2 call in
  the per-kart loop, and the now-dead `void events`; exact before/after in Step 24)
- Modify: `packages/sim/test/step.test.ts` (append one describe block; exact code in Step 22)

**Interfaces:**

- Consumes (all fixed by the locked contract, all authored by earlier tasks):
  - `packages/sim/src/types.ts` [Task 2] — `TICK_DT` (`= 1/60`), `MAX_KARTS` (`= 8`),
    `MAX_ENTITIES` (`= 32`), and the types `AuthEvent`, `EntityState`, `KartState`,
    `SimContext`, `SimState`, `Surface`, `Track`, `TrackPoint`, `TrackProjection`,
    `TrackQuery`, `Tuning`, `Vec3`.
  - `packages/sim/src/mathutil.ts` [Task 2] — `lerp(a: number, b: number, t: number): number`,
    `wrapAngle(a: number): number` (returns a value in `(-PI, PI]`).
  - `packages/sim/src/state.ts` [Task 5] —
    `emit(state: SimState, out: AuthEvent[], kind: AuthEventKind, playerId: number,
    entityId: number, item: ItemKind, data: number): void`, and
    `createState(ctx: SimContext, seed: number, characterIdx: number[]): SimState`
    (used only by this task's `step()` tests).
  - `packages/sim/src/kart.ts` [Task 6] —
    `stepKart(ctx: SimContext, state: SimState, prevKart: KartState, k: KartState, raw: Intent): void`
    and `targetSpeedFor(ctx: SimContext, state: SimState, k: KartState, accel: number): number`.
    This task edits both: `stepKart` gains the two recovery locks, `targetSpeedFor`'s
    documented `const surfaceFactor = 1` stub becomes `surfaceSpeedFactor(k, t)`.
  - `packages/sim/src/step.ts` [Task 5, extended by 6–8] — the per-kart loop, whose
    body after Tasks 6, 7 and 8 contains `const k`, `const prevKart`, `const raw`,
    `updateDrift(ctx, k, raw)` and `stepKart(ctx, next, prevKart, k, raw)`. This task
    inserts canonical slot 2 immediately above `updateDrift`.
  - `packages/sim/test/fixtures/track-fixtures.ts` [Task 3] —
    `makeTuning(overrides?: Partial<Tuning>): Tuning`,
    `makeCharacters(): CharacterStats[]`,
    `makeStraightTrack(overrides?: Partial<Track>): Track`.
  - `packages/sim/test/helpers/flat-context.ts` [Task 5, extended by Task 6] —
    `makeTestContext(startPositions)`, `EIGHT_STARTS`, `makeKart(over?)`, `makeIntent(over?)`.
  - From `SimContext.query` (a `TrackQuery`, built in Task 4): `sampleAt(s)`,
    `tangentAt(s)`, `project(p)`, `groundHeight(s, lateral)`, `isInBounds(s, lateral)`.
  - Contract §0: **`s` is always arc-normalised to `[0, 1)`**, never metres. Metres are
    reached only by multiplying an `s`-delta by `query.totalLength()`. Every `s` this
    task passes to or receives from the query obeys that, including the test stub.
  - Contract §0: `right = (-t.z, 0, t.x)`, so on a track whose tangent is `(1, 0, 0)`
    **positive `lateral` is toward `+z`**.

- Produces (exact names and signatures later tasks rely on):
  - `export function steeringLocked(k: KartState): boolean`
    — `true` while `k.spinOutTicks > 0 || k.respawnTicks > 0`. Step 20 of this task is
    what makes `stepKart` read it: `const steer = steeringLocked(k) ? 0 : raw.steer`.
  - `export function motionLocked(k: KartState): boolean`
    — `true` while `k.respawnTicks > 0`. This name is **not** in the contract's module
    map; it is new, defined here, because `updateRecovery` runs at slot 2 of the
    canonical per-kart order while the integrator runs at slot 4, and the integrator
    must not overwrite the respawn interpolation. Step 20 of this task is what makes
    `stepKart` return early — past the traction block *and* past the horizontal
    position integration — when it is `true`.
  - `export function surfaceSpeedFactor(k: KartState, t: Tuning): number`
    — `t.offtrackSpeedMul` when `k.surface === 'offtrack'`, otherwise `1`. This is the
    off-track term of the `targetSpeedFor` product owned by Task 6, and Step 20 of this
    task is what replaces Task 6's documented `const surfaceFactor = 1` stub with it.
  - `export function updateRecovery(ctx: SimContext, state: SimState, k: KartState,
    events: AuthEvent[]): void`
    — slot 2 of the canonical per-kart order inside `step()`. Step 24 of this task is
    what adds that call site, per contract §0: the task that introduces a function also
    adds its call site in `step.ts`, with its own failing test.
  - `export function startSpinOut(state: SimState, k: KartState, ticks: number,
    events: AuthEvent[]): void`
    — new, defined here. The single entry point Tasks 12 and 13 call to put a kart into
    a spin-out; it is what emits the `'spinOut'` `AuthEvent` and what enforces
    invulnerability.
    **Contract §0 makes `startSpinOut` the sole writer of `spinOutTicks`: no module
    other than `recovery.ts` may assign that field.** Inside `recovery.ts` there are
    exactly two further writes, and both only ever spend or cancel a spin-out that
    `startSpinOut` already started: `updateRecovery` does `k.spinOutTicks -= 1` while
    the timer runs, and `beginRespawn` does `k.spinOutTicks = 0` because a respawn
    supersedes a spin. There is no third write anywhere in the package — Task 12 in
    particular must call `startSpinOut` rather than assigning the field itself.
  - `export const SPIN_YAW_RATE: number` — `4 * Math.PI` rad/s.
  - `export const SPIN_SPEED_DECAY: number` — `0.94`, per-tick horizontal speed retention.
  - Edits to `packages/sim/src/kart.ts` (Step 20) and `packages/sim/src/step.ts`
    (Step 24). After this task the assembled tick runs
    `updateRecovery → updateDrift → stepKart → applyAirYaw → integrateVertical →
    applyRamps → applyBoostPad → decayBoost` per kart, and Task 13 anchors its
    `useItem` insertion on the `updateRecovery` / `updateDrift` pair this task writes.

---

- [ ] **Step 1: Write the failing test — predicates**

Create `packages/sim/test/recovery.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type {
  EntityState, KartState, SimContext, SimState, TrackPoint, TrackProjection,
  TrackQuery, Tuning, Vec3,
} from '../src/types'
import { MAX_ENTITIES, MAX_KARTS } from '../src/types'
import { makeCharacters, makeStraightTrack, makeTuning } from './fixtures/track-fixtures'
import { motionLocked, steeringLocked, surfaceSpeedFactor } from '../src/recovery'

// A hand-built TrackQuery so every number in this file is exact and owned by the
// test. The centreline is a straight line along +X at y = 0, z = 0, and one lap is
// TRACK_LENGTH metres long.
//
// Contract §0: `s` is ALWAYS arc-normalised to [0, 1) — never metres. Metres are
// reached only by multiplying an s-delta by totalLength(). So sampleAt converts
// s -> metres with `s * TRACK_LENGTH` and project() converts back. TRACK_LENGTH is
// 400 and every checkpoint sits on a quarter, so every s in this file (0, 0.25,
// 0.5, 0.75) converts to a metre value that is exact in binary floating point.
//
// Contract §0 also fixes right = (-t.z, 0, t.x). With tangent (1, 0, 0) that is
// (0, 0, 1), so positive `lateral` is toward +z: project() returns `p.z` unnegated.
const TRACK_LENGTH = 400

function wrap01(v: number): number {
  const f = v - Math.floor(v)
  return f < 0 ? f + 1 : f
}

function stubQuery(): TrackQuery {
  return {
    sampleAt(s: number): TrackPoint {
      return {
        position: { x: s * TRACK_LENGTH, y: 0, z: 0 },
        width: 10,
        banking: 0,
        surface: 'tarmac',
      }
    },
    tangentAt(): Vec3 {
      return { x: 1, y: 0, z: 0 }
    },
    project(p: Vec3): TrackProjection {
      return { s: wrap01(p.x / TRACK_LENGTH), lateral: p.z, distance: Math.abs(p.z) }
    },
    groundHeight(): number {
      return 0
    },
    surfaceAt(_s: number, lateral: number) {
      return Math.abs(lateral) <= 5 ? 'tarmac' : 'offtrack'
    },
    isInBounds(_s: number, lateral: number): boolean {
      return Math.abs(lateral) <= 5
    },
    checkpointIndexAt(s: number): number {
      return s < 0.25 ? 0 : s < 0.5 ? 1 : s < 0.75 ? 2 : 3
    },
    totalLength(): number {
      return TRACK_LENGTH
    },
  }
}

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

// A deliberately local kart builder: this file's karts are addressed by playerId
// and every field is written explicitly, so it does not import Task 6's shared
// `makeKart(over?)`. `checkpointIdx` starts at 3 because that is what createState
// produces — contract §0 fixes the initial lap as
// `{ lap: 0, checkpointIdx: track.checkpointS.length - 1, t: 0 }`, and this file's
// track has four checkpoints. Tests that care set it explicitly anyway.
function makeKart(playerId: number): KartState {
  return {
    playerId,
    characterIdx: 0,
    isBot: false,
    connected: true,
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
    lap: { lap: 0, checkpointIdx: 3, t: 0 },
  }
}

function makeSimState(): SimState {
  const karts: KartState[] = []
  for (let i = 0; i < MAX_KARTS; i++) karts.push(makeKart(i))
  const entities: EntityState[] = []
  for (let i = 0; i < MAX_ENTITIES; i++) {
    entities.push({
      entityId: -1,
      kind: 'seeker',
      ownerId: -1,
      position: { x: 0, y: 0, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
      heading: 0,
      targetId: -1,
      ttl: 0,
    })
  }
  return {
    tick: 0,
    phase: 'racing',
    raceSeed: 1,
    rngCursor: 0,
    nextEventSeq: 0,
    finishTick: -1,
    karts,
    entities,
    entityCount: 0,
    nextEntityId: 1,
    itemBoxes: [],
    // Contract §0: finishedOrder is fixed length MAX_KARTS, unused slots hold -1.
    finishedOrder: new Array<number>(MAX_KARTS).fill(-1),
  }
}

describe('recovery predicates', () => {
  it('locks steering while spinning out or respawning, and only then', () => {
    const k = makeKart(0)
    expect(steeringLocked(k)).toBe(false)

    k.spinOutTicks = 1
    expect(steeringLocked(k)).toBe(true)

    k.spinOutTicks = 0
    k.respawnTicks = 1
    expect(steeringLocked(k)).toBe(true)

    k.spinOutTicks = 12
    expect(steeringLocked(k)).toBe(true)

    k.spinOutTicks = 0
    k.respawnTicks = 0
    expect(steeringLocked(k)).toBe(false)
  })

  it('locks motion only while respawning', () => {
    const k = makeKart(0)
    expect(motionLocked(k)).toBe(false)

    // A spinning kart still slides; only a respawning kart is teleport-driven.
    k.spinOutTicks = 60
    expect(motionLocked(k)).toBe(false)

    k.respawnTicks = 1
    expect(motionLocked(k)).toBe(true)
  })

  it('applies the off-track speed multiplier and nothing else', () => {
    const t = makeTuning()
    // Contract fixture: offtrackSpeedMul = 0.55
    expect(t.offtrackSpeedMul).toBe(0.55)

    const k = makeKart(0)

    k.surface = 'tarmac'
    expect(surfaceSpeedFactor(k, t)).toBe(1)

    k.surface = 'dirt'
    expect(surfaceSpeedFactor(k, t)).toBe(1)

    k.surface = 'boost'
    expect(surfaceSpeedFactor(k, t)).toBe(1)

    k.surface = 'offtrack'
    expect(surfaceSpeedFactor(k, t)).toBe(0.55)
  })

  it('honours an overridden off-track multiplier', () => {
    const t = makeTuning({ offtrackSpeedMul: 0.25 })
    const k = makeKart(0)
    k.surface = 'offtrack'
    expect(surfaceSpeedFactor(k, t)).toBe(0.25)
  })

  it('builds a context whose tuning matches the locked fixture values', () => {
    const ctx = makeCtx()
    expect(ctx.tuning.respawnTicks).toBe(72)
    expect(ctx.tuning.invulnTicks).toBe(90)
    expect(ctx.tuning.spinOutTicks).toBe(60)
    expect(makeSimState().karts.length).toBe(MAX_KARTS)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/sim/test/recovery.test.ts -t "recovery predicates"`
Expected: FAIL with `Failed to resolve import "../src/recovery"` — the module does not exist yet.

- [ ] **Step 3: Write minimal implementation — predicates**

Create `packages/sim/src/recovery.ts`:

```ts
import type { KartState, Tuning } from './types'

/**
 * Yaw rate, rad/s, forced on a kart while `spinOutTicks > 0`.
 * 4*PI rad/s is exactly two visible full turns per second of spin-out.
 */
export const SPIN_YAW_RATE = 4 * Math.PI

/** Per-tick multiplicative retention of horizontal speed while spinning out. */
export const SPIN_SPEED_DECAY = 0.94

/**
 * True while the kart has no steering authority: the whole spin-out, and the
 * whole respawn interpolation. Task 6's `stepKart` reads the steer axis as 0
 * when this is true.
 */
export function steeringLocked(k: KartState): boolean {
  return k.spinOutTicks > 0 || k.respawnTicks > 0
}

/**
 * True while position and velocity are owned by `updateRecovery` and must not
 * be integrated by anything else this tick. A spinning kart still slides, so
 * only the respawn interpolation locks motion.
 */
export function motionLocked(k: KartState): boolean {
  return k.respawnTicks > 0
}

/**
 * The off-track term of the `targetSpeedFor` product (Task 6 owns the product).
 */
export function surfaceSpeedFactor(k: KartState, t: Tuning): number {
  return k.surface === 'offtrack' ? t.offtrackSpeedMul : 1
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/sim/test/recovery.test.ts -t "recovery predicates"`
Expected: PASS — 5 tests.

---

- [ ] **Step 5: Write the failing test — respawn**

In `packages/sim/test/recovery.test.ts`, change the import of `../src/recovery`.

Before:

```ts
import { motionLocked, steeringLocked, surfaceSpeedFactor } from '../src/recovery'
```

After:

```ts
import {
  motionLocked, steeringLocked, surfaceSpeedFactor, updateRecovery,
} from '../src/recovery'
```

Then append this block to the end of the file:

```ts
describe('respawn', () => {
  // Track fixture: checkpointS = [0, 0.25, 0.5, 0.75], arc-normalised. The stub
  // centreline is (s * 400, 0, 0) with tangent (1, 0, 0), so checkpoint 1 sits at
  // (100, 0, 0) facing heading 0, and checkpoint 3 sits at (300, 0, 0).
  function outOfBoundsKart(state: SimState): KartState {
    const k = state.karts[0]
    k.position.x = 10
    k.position.y = 0
    k.position.z = 50 // lateral = +z = 50, |lateral| > 5 -> out of bounds
    k.velocity.x = 12
    k.velocity.y = 0
    k.velocity.z = 3
    k.heading = 1
    k.angularVelocity = 0.4
    k.drift.active = true
    k.drift.dir = 1
    k.drift.charge = 55
    k.boostTicks = 9
    k.airborne = true
    k.lap.checkpointIdx = 1
    return k
  }

  it('starts a respawn on the tick the kart leaves the bounds', () => {
    const ctx = makeCtx()
    const state = makeSimState()
    const k = outOfBoundsKart(state)
    const events: AuthEvent[] = []

    updateRecovery(ctx, state, k, events)

    // Detection tick arms the timer; it does not move the kart yet.
    expect(k.respawnTicks).toBe(72) // tuning.respawnTicks
    expect(k.position.x).toBe(10)
    expect(k.position.z).toBe(50)
    // and it freezes the kart
    expect(k.velocity.x).toBe(0)
    expect(k.velocity.y).toBe(0)
    expect(k.velocity.z).toBe(0)
    expect(k.angularVelocity).toBe(0)
    expect(k.airborne).toBe(false)
    expect(k.drift.active).toBe(false)
    expect(k.drift.dir).toBe(0)
    expect(k.drift.charge).toBe(0)
    expect(k.boostTicks).toBe(0)
    expect(k.invulnTicks).toBe(0) // invulnerability is granted on arrival, not on departure

    expect(events.length).toBe(1)
    expect(events[0].kind).toBe('respawn')
    expect(events[0].playerId).toBe(0)
    expect(events[0].entityId).toBe(-1)
    expect(events[0].item).toBe('none')
    expect(events[0].data).toBe(72)
    expect(events[0].eventSeq).toBe(0)
    expect(state.nextEventSeq).toBe(1)
  })

  it('interpolates linearly toward the last checkpoint', () => {
    const ctx = makeCtx()
    const state = makeSimState()
    const k = outOfBoundsKart(state)
    const events: AuthEvent[] = []

    // Call 1 arms the timer at 72. Calls 2..37 are 36 interpolation ticks.
    for (let i = 0; i < 37; i++) updateRecovery(ctx, state, k, events)

    expect(k.respawnTicks).toBe(36) // 72 - 36

    // Each tick moves 1/remaining of the way, so after n of R ticks the remaining
    // fraction is (R - n)/R: after 36 of 72 the kart is exactly half way.
    // Target is checkpoint 1: s = 0.25 -> x = 0.25 * 400 = 100.
    //   x: 10 + 0.5 * (100 - 10) = 55
    //   z: 50 + 0.5 * (0   - 50) = 25
    //   heading: 1 + 0.5 * (0 - 1) = 0.5
    // Not bit-exact because each tick rounds a separate 1/R multiply.
    expect(k.position.x).toBeCloseTo(55, 9)
    expect(k.position.y).toBeCloseTo(0, 12)
    expect(k.position.z).toBeCloseTo(25, 9)
    expect(k.heading).toBeCloseTo(0.5, 9)

    expect(steeringLocked(k)).toBe(true)
    expect(motionLocked(k)).toBe(true)
    expect(events.length).toBe(1) // still only the one respawn event
  })

  it('lands exactly on the checkpoint and grants invulnerability', () => {
    const ctx = makeCtx()
    const state = makeSimState()
    const k = outOfBoundsKart(state)
    const events: AuthEvent[] = []

    // 1 detection tick + 72 interpolation ticks = 73 calls.
    for (let i = 0; i < 73; i++) updateRecovery(ctx, state, k, events)

    expect(k.respawnTicks).toBe(0)
    // checkpointS[1] = 0.25 -> 0.25 * 400 = 100, snapped exactly on the last tick
    expect(k.position.x).toBe(100)
    expect(k.position.y).toBe(0)
    expect(k.position.z).toBe(0)
    expect(k.heading).toBe(0) // atan2(0, 1) == 0
    expect(k.invulnTicks).toBe(90) // tuning.invulnTicks
    expect(steeringLocked(k)).toBe(false)
    expect(motionLocked(k)).toBe(false)
    expect(events.length).toBe(1)
  })

  it('ticks invulnerability down once the kart is back in bounds', () => {
    const ctx = makeCtx()
    const state = makeSimState()
    const k = outOfBoundsKart(state)
    const events: AuthEvent[] = []

    // 73 calls to complete the respawn, then 7 more free-running ticks.
    for (let i = 0; i < 80; i++) updateRecovery(ctx, state, k, events)

    expect(k.invulnTicks).toBe(83) // 90 granted on call 73, minus 7 decrements
    expect(k.respawnTicks).toBe(0)
    // (100, 0, 0) projects to lateral 0, which is in bounds: no second respawn
    expect(events.length).toBe(1)
  })

  it('uses the previous checkpoint when checkpointIdx is -1', () => {
    const ctx = makeCtx()
    const state = makeSimState()
    const k = outOfBoundsKart(state)
    k.lap.checkpointIdx = -1 // wraps to index 3 of [0, 0.25, 0.5, 0.75]
    const events: AuthEvent[] = []

    for (let i = 0; i < 73; i++) updateRecovery(ctx, state, k, events)

    expect(k.position.x).toBe(300) // 0.75 * 400
    expect(k.position.z).toBe(0)
  })

  it('teleports immediately when respawnTicks is tuned to 0', () => {
    const ctx = makeCtx({ respawnTicks: 0 })
    const state = makeSimState()
    const k = outOfBoundsKart(state)
    const events: AuthEvent[] = []

    updateRecovery(ctx, state, k, events)

    expect(k.respawnTicks).toBe(0)
    expect(k.position.x).toBe(100) // 0.25 * 400
    expect(k.position.z).toBe(0)
    expect(k.invulnTicks).toBe(90)
    expect(events.length).toBe(1)
    expect(events[0].data).toBe(0)

    updateRecovery(ctx, state, k, events)
    expect(events.length).toBe(1) // in bounds now, no repeat
    expect(k.invulnTicks).toBe(89)
  })

  it('does not respawn a kart that is inside the bounds', () => {
    const ctx = makeCtx()
    const state = makeSimState()
    const k = state.karts[0]
    k.position.x = 10
    k.position.z = 2 // lateral = +2, inside |lateral| <= 5
    k.velocity.x = 12
    const events: AuthEvent[] = []

    for (let i = 0; i < 10; i++) updateRecovery(ctx, state, k, events)

    expect(k.respawnTicks).toBe(0)
    expect(k.position.x).toBe(10)
    expect(k.velocity.x).toBe(12)
    expect(events.length).toBe(0)
  })
})
```

Also add `AuthEvent` to the type-only import at the top of the file.

Before:

```ts
import type {
  EntityState, KartState, SimContext, SimState, TrackPoint, TrackProjection,
  TrackQuery, Tuning, Vec3,
} from '../src/types'
```

After:

```ts
import type {
  AuthEvent, EntityState, KartState, SimContext, SimState, TrackPoint,
  TrackProjection, TrackQuery, Tuning, Vec3,
} from '../src/types'
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run packages/sim/test/recovery.test.ts -t "respawn"`
Expected: FAIL with `updateRecovery is not a function` (the export does not exist yet).

- [ ] **Step 7: Write minimal implementation — respawn**

Replace the whole of `packages/sim/src/recovery.ts` with:

```ts
import type { AuthEvent, KartState, SimContext, SimState, Tuning, Vec3 } from './types'
import { lerp, wrapAngle } from './mathutil'
import { emit } from './state'

/**
 * Yaw rate, rad/s, forced on a kart while `spinOutTicks > 0`.
 * 4*PI rad/s is exactly two visible full turns per second of spin-out.
 */
export const SPIN_YAW_RATE = 4 * Math.PI

/** Per-tick multiplicative retention of horizontal speed while spinning out. */
export const SPIN_SPEED_DECAY = 0.94

/** Scratch respawn target. Module scope so the hot path never allocates. */
const TARGET: Vec3 = { x: 0, y: 0, z: 0 }

/**
 * True while the kart has no steering authority: the whole spin-out, and the
 * whole respawn interpolation. Task 6's `stepKart` reads the steer axis as 0
 * when this is true.
 */
export function steeringLocked(k: KartState): boolean {
  return k.spinOutTicks > 0 || k.respawnTicks > 0
}

/**
 * True while position and velocity are owned by `updateRecovery` and must not
 * be integrated by anything else this tick. A spinning kart still slides, so
 * only the respawn interpolation locks motion.
 */
export function motionLocked(k: KartState): boolean {
  return k.respawnTicks > 0
}

/**
 * The off-track term of the `targetSpeedFor` product (Task 6 owns the product).
 */
export function surfaceSpeedFactor(k: KartState, t: Tuning): number {
  return k.surface === 'offtrack' ? t.offtrackSpeedMul : 1
}

/**
 * Slot 2 of the canonical per-kart order inside `step()`.
 *
 * - A kart already respawning is interpolated one tick toward its checkpoint and
 *   nothing else happens to it.
 * - Otherwise invulnerability decays, then a live spin-out is advanced, then the
 *   kart is tested against the track bounds.
 */
export function updateRecovery(
  ctx: SimContext,
  state: SimState,
  k: KartState,
  events: AuthEvent[],
): void {
  const t = ctx.tuning

  if (k.respawnTicks > 0) {
    stepRespawn(ctx, k)
    if (k.respawnTicks === 0) k.invulnTicks = t.invulnTicks
    return
  }

  if (k.invulnTicks > 0) k.invulnTicks -= 1

  const proj = ctx.query.project(k.position)
  if (!ctx.query.isInBounds(proj.s, proj.lateral)) {
    beginRespawn(ctx, state, k, events)
  }
}

/**
 * Writes the last-crossed checkpoint's world position into TARGET and returns the
 * heading of the centreline there. `checkpointIdx` is wrapped, so -1 means "the
 * final checkpoint of the previous lap".
 */
function checkpointTarget(ctx: SimContext, k: KartState): number {
  const cps = ctx.track.checkpointS
  const n = cps.length
  let s = 0
  if (n > 0) {
    const idx = ((k.lap.checkpointIdx % n) + n) % n
    s = cps[idx]
  }
  const cp = ctx.query.sampleAt(s)
  TARGET.x = cp.position.x
  TARGET.y = ctx.query.groundHeight(s, 0)
  TARGET.z = cp.position.z
  const tan = ctx.query.tangentAt(s)
  return Math.atan2(tan.z, tan.x)
}

function snapToCheckpoint(ctx: SimContext, k: KartState): void {
  const h = checkpointTarget(ctx, k)
  k.position.x = TARGET.x
  k.position.y = TARGET.y
  k.position.z = TARGET.z
  k.heading = wrapAngle(h)
}

function beginRespawn(
  ctx: SimContext,
  state: SimState,
  k: KartState,
  events: AuthEvent[],
): void {
  const t = ctx.tuning
  k.spinOutTicks = 0
  k.boostTicks = 0
  k.invulnTicks = 0
  k.drift.active = false
  k.drift.dir = 0
  k.drift.charge = 0
  k.velocity.x = 0
  k.velocity.y = 0
  k.velocity.z = 0
  k.angularVelocity = 0
  k.airborne = false
  k.respawnTicks = t.respawnTicks > 0 ? t.respawnTicks : 0
  emit(state, events, 'respawn', k.playerId, -1, 'none', k.respawnTicks)
  if (k.respawnTicks === 0) {
    snapToCheckpoint(ctx, k)
    k.invulnTicks = t.invulnTicks
  }
}

/**
 * One tick of the respawn interpolation.
 *
 * The kart's departure point is never stored, because `KartState` has no field
 * for it. Instead each tick moves a fraction `1 / remaining` of the way to the
 * target, which is exactly a linear schedule: after n of R ticks the kart sits at
 * `p0 + (n / R) * (target - p0)`. The final tick assigns the target directly so
 * arrival is bit-exact rather than one rounding short.
 */
function stepRespawn(ctx: SimContext, k: KartState): void {
  k.velocity.x = 0
  k.velocity.y = 0
  k.velocity.z = 0
  k.angularVelocity = 0
  k.airborne = false
  k.boostTicks = 0
  k.drift.active = false
  k.drift.dir = 0
  k.drift.charge = 0

  if (k.respawnTicks <= 1) {
    snapToCheckpoint(ctx, k)
    k.respawnTicks = 0
    return
  }

  const h = checkpointTarget(ctx, k)
  const f = 1 / k.respawnTicks
  k.position.x = lerp(k.position.x, TARGET.x, f)
  k.position.y = lerp(k.position.y, TARGET.y, f)
  k.position.z = lerp(k.position.z, TARGET.z, f)
  k.heading = wrapAngle(k.heading + wrapAngle(h - k.heading) * f)
  k.respawnTicks -= 1
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npx vitest run packages/sim/test/recovery.test.ts -t "respawn"`
Expected: PASS — 7 tests.

---

- [ ] **Step 9: Write the failing test — spin-out**

In `packages/sim/test/recovery.test.ts`, change the import of `../src/recovery`.

Before:

```ts
import {
  motionLocked, steeringLocked, surfaceSpeedFactor, updateRecovery,
} from '../src/recovery'
```

After:

```ts
import {
  motionLocked, SPIN_SPEED_DECAY, SPIN_YAW_RATE, steeringLocked,
  surfaceSpeedFactor, updateRecovery,
} from '../src/recovery'
```

Then append this block to the end of the file:

```ts
describe('spin-out', () => {
  function spinningKart(state: SimState): KartState {
    const k = state.karts[0]
    k.position.x = 10
    k.position.y = 0
    k.position.z = 0 // lateral 0: firmly in bounds
    k.velocity.x = 20
    k.velocity.y = -5 // vertical component, must not be damped
    k.velocity.z = 0
    k.heading = 0
    k.drift.active = true
    k.drift.dir = -1
    k.drift.charge = 88
    k.boostTicks = 14
    k.spinOutTicks = 60 // tuning.spinOutTicks
    return k
  }

  it('exposes the spin constants the tuning table is written against', () => {
    // 4*PI rad/s over 60 ticks == 4*PI rad == exactly two full turns.
    expect(SPIN_YAW_RATE).toBeCloseTo(12.566370614359172, 12)
    expect(SPIN_SPEED_DECAY).toBe(0.94)
  })

  it('forces a visible yaw spin and decays horizontal speed each tick', () => {
    const ctx = makeCtx()
    const state = makeSimState()
    const k = spinningKart(state)
    const events: AuthEvent[] = []

    updateRecovery(ctx, state, k, events)

    expect(k.spinOutTicks).toBe(59)
    expect(k.angularVelocity).toBeCloseTo(12.566370614359172, 12) // 4*PI
    // heading advances SPIN_YAW_RATE * TICK_DT = 4*PI/60 = PI/15
    expect(k.heading).toBeCloseTo(0.20943951023931953, 12)
    // horizontal speed: 20 * 0.94 = 18.8
    expect(k.velocity.x).toBeCloseTo(18.8, 12)
    expect(k.velocity.z).toBeCloseTo(0, 12)
    // vertical speed is gravity's business, untouched
    expect(k.velocity.y).toBe(-5)
    // a spun kart cannot hold a drift charge or a boost
    expect(k.drift.active).toBe(false)
    expect(k.drift.dir).toBe(0)
    expect(k.drift.charge).toBe(0)
    expect(k.boostTicks).toBe(0)

    expect(steeringLocked(k)).toBe(true)
    expect(motionLocked(k)).toBe(false)
    expect(events.length).toBe(0)
  })

  it('runs down to zero over exactly tuning.spinOutTicks ticks', () => {
    const ctx = makeCtx()
    const state = makeSimState()
    const k = spinningKart(state)
    const events: AuthEvent[] = []

    for (let i = 0; i < 59; i++) updateRecovery(ctx, state, k, events)
    expect(k.spinOutTicks).toBe(1)
    expect(steeringLocked(k)).toBe(true)

    updateRecovery(ctx, state, k, events)
    expect(k.spinOutTicks).toBe(0)
    expect(steeringLocked(k)).toBe(false)

    // 20 * 0.94^60 = 0.48831... : the kart is very nearly stopped
    expect(k.velocity.x).toBeCloseTo(20 * Math.pow(0.94, 60), 12)
    expect(k.velocity.x).toBeGreaterThan(0.48)
    expect(k.velocity.x).toBeLessThan(0.49)

    // 60 ticks * 4*PI/60 = 4*PI == 0 mod 2*PI, and wrapAngle keeps it there
    expect(k.heading).toBeCloseTo(0, 9)
  })

  it('stops spinning the tick the kart finishes its spin-out', () => {
    const ctx = makeCtx()
    const state = makeSimState()
    const k = spinningKart(state)
    const events: AuthEvent[] = []

    for (let i = 0; i < 60; i++) updateRecovery(ctx, state, k, events)
    const restingX = k.velocity.x
    const restingHeading = k.heading

    updateRecovery(ctx, state, k, events)

    expect(k.velocity.x).toBe(restingX) // no further decay
    expect(k.heading).toBe(restingHeading) // no further yaw
    expect(k.angularVelocity).toBe(SPIN_YAW_RATE) // left as the spin set it
  })

  it('lets a respawn cancel and replace an in-flight spin-out', () => {
    const ctx = makeCtx()
    const state = makeSimState()
    const k = spinningKart(state)
    k.position.z = 50 // lateral = +50, out of bounds
    k.spinOutTicks = 30
    const events: AuthEvent[] = []

    updateRecovery(ctx, state, k, events)

    expect(k.spinOutTicks).toBe(0)
    expect(k.respawnTicks).toBe(72)
    expect(k.angularVelocity).toBe(0)
    expect(k.velocity.x).toBe(0)
    expect(k.velocity.y).toBe(0)
    expect(events.length).toBe(1)
    expect(events[0].kind).toBe('respawn')
  })

  it('does not spin a kart while it is respawning', () => {
    const ctx = makeCtx()
    const state = makeSimState()
    const k = state.karts[0]
    k.position.x = 10
    k.position.z = 0
    k.respawnTicks = 5
    k.spinOutTicks = 30
    k.lap.checkpointIdx = 1
    const events: AuthEvent[] = []

    updateRecovery(ctx, state, k, events)

    expect(k.respawnTicks).toBe(4)
    expect(k.spinOutTicks).toBe(30) // frozen, not advanced
    expect(k.angularVelocity).toBe(0)
  })
})
```

- [ ] **Step 10: Run test to verify it fails**

Run: `npx vitest run packages/sim/test/recovery.test.ts -t "spin-out"`
Expected: FAIL — "forces a visible yaw spin and decays horizontal speed each tick"
reports `expected 60 to be 59` for `k.spinOutTicks`; `updateRecovery` currently
ignores the spin-out timer entirely.

- [ ] **Step 11: Write minimal implementation — spin-out**

In `packages/sim/src/recovery.ts`, add `TICK_DT` to the value import.

Before:

```ts
import type { AuthEvent, KartState, SimContext, SimState, Tuning, Vec3 } from './types'
import { lerp, wrapAngle } from './mathutil'
import { emit } from './state'
```

After:

```ts
import type { AuthEvent, KartState, SimContext, SimState, Tuning, Vec3 } from './types'
import { TICK_DT } from './types'
import { lerp, wrapAngle } from './mathutil'
import { emit } from './state'
```

Then replace the whole `updateRecovery` function.

Before:

```ts
export function updateRecovery(
  ctx: SimContext,
  state: SimState,
  k: KartState,
  events: AuthEvent[],
): void {
  const t = ctx.tuning

  if (k.respawnTicks > 0) {
    stepRespawn(ctx, k)
    if (k.respawnTicks === 0) k.invulnTicks = t.invulnTicks
    return
  }

  if (k.invulnTicks > 0) k.invulnTicks -= 1

  const proj = ctx.query.project(k.position)
  if (!ctx.query.isInBounds(proj.s, proj.lateral)) {
    beginRespawn(ctx, state, k, events)
  }
}
```

After:

```ts
export function updateRecovery(
  ctx: SimContext,
  state: SimState,
  k: KartState,
  events: AuthEvent[],
): void {
  const t = ctx.tuning

  if (k.respawnTicks > 0) {
    stepRespawn(ctx, k)
    if (k.respawnTicks === 0) k.invulnTicks = t.invulnTicks
    return
  }

  if (k.invulnTicks > 0) k.invulnTicks -= 1

  if (k.spinOutTicks > 0) {
    // Steering is already locked by `steeringLocked`; here we force the yaw so the
    // spin is visible, and bleed off horizontal speed. Vertical velocity belongs
    // to gravity and is left alone.
    k.angularVelocity = SPIN_YAW_RATE
    k.heading = wrapAngle(k.heading + SPIN_YAW_RATE * TICK_DT)
    k.velocity.x *= SPIN_SPEED_DECAY
    k.velocity.z *= SPIN_SPEED_DECAY
    k.drift.active = false
    k.drift.dir = 0
    k.drift.charge = 0
    k.boostTicks = 0
    k.spinOutTicks -= 1
  }

  const proj = ctx.query.project(k.position)
  if (!ctx.query.isInBounds(proj.s, proj.lateral)) {
    beginRespawn(ctx, state, k, events)
  }
}
```

- [ ] **Step 12: Run test to verify it passes**

Run: `npx vitest run packages/sim/test/recovery.test.ts -t "spin-out"`
Expected: PASS — 6 tests.

---

- [ ] **Step 13: Write the failing test — startSpinOut**

In `packages/sim/test/recovery.test.ts`, change the import of `../src/recovery`.

Before:

```ts
import {
  motionLocked, SPIN_SPEED_DECAY, SPIN_YAW_RATE, steeringLocked,
  surfaceSpeedFactor, updateRecovery,
} from '../src/recovery'
```

After:

```ts
import {
  motionLocked, SPIN_SPEED_DECAY, SPIN_YAW_RATE, startSpinOut, steeringLocked,
  surfaceSpeedFactor, updateRecovery,
} from '../src/recovery'
```

Then append this block to the end of the file:

```ts
describe('startSpinOut', () => {
  it('arms the timer and emits one spinOut event', () => {
    const state = makeSimState()
    const k = state.karts[3]
    k.drift.active = true
    k.drift.dir = 1
    k.drift.charge = 120
    k.boostTicks = 30
    const events: AuthEvent[] = []

    startSpinOut(state, k, 60, events)

    expect(k.spinOutTicks).toBe(60)
    expect(k.drift.active).toBe(false)
    expect(k.drift.dir).toBe(0)
    expect(k.drift.charge).toBe(0)
    expect(k.boostTicks).toBe(0)

    expect(events.length).toBe(1)
    expect(events[0].kind).toBe('spinOut')
    expect(events[0].playerId).toBe(3)
    expect(events[0].entityId).toBe(-1)
    expect(events[0].item).toBe('none')
    expect(events[0].data).toBe(60)
    expect(state.nextEventSeq).toBe(1)
  })

  it('is refused while the kart is invulnerable', () => {
    const state = makeSimState()
    const k = state.karts[0]
    k.invulnTicks = 5
    const events: AuthEvent[] = []

    startSpinOut(state, k, 60, events)

    expect(k.spinOutTicks).toBe(0)
    expect(events.length).toBe(0)
    expect(state.nextEventSeq).toBe(0)
  })

  it('is refused while the kart is respawning', () => {
    const state = makeSimState()
    const k = state.karts[0]
    k.respawnTicks = 10
    const events: AuthEvent[] = []

    startSpinOut(state, k, 60, events)

    expect(k.spinOutTicks).toBe(0)
    expect(k.respawnTicks).toBe(10)
    expect(events.length).toBe(0)
  })

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

  it('ignores a non-positive duration', () => {
    const state = makeSimState()
    const k = state.karts[0]
    const events: AuthEvent[] = []

    startSpinOut(state, k, 0, events)

    expect(k.spinOutTicks).toBe(0)
    expect(events.length).toBe(0)
  })

  it('runs a full spin-out through updateRecovery with exactly one event', () => {
    const ctx = makeCtx()
    const state = makeSimState()
    const k = state.karts[0]
    k.position.x = 10
    k.position.z = 0
    k.velocity.x = 20
    const events: AuthEvent[] = []

    startSpinOut(state, k, ctx.tuning.spinOutTicks, events)
    expect(k.spinOutTicks).toBe(60)

    for (let i = 0; i < 60; i++) updateRecovery(ctx, state, k, events)

    expect(k.spinOutTicks).toBe(0)
    expect(steeringLocked(k)).toBe(false)
    expect(events.length).toBe(1)
    expect(events[0].kind).toBe('spinOut')
    // 20 * 0.94^60
    expect(k.velocity.x).toBeCloseTo(20 * Math.pow(0.94, 60), 12)
  })
})
```

- [ ] **Step 14: Run test to verify it fails**

Run: `npx vitest run packages/sim/test/recovery.test.ts -t "startSpinOut"`
Expected: FAIL with `startSpinOut is not a function` (the export does not exist yet).

- [ ] **Step 15: Write minimal implementation — startSpinOut**

In `packages/sim/src/recovery.ts`, insert this function immediately after
`surfaceSpeedFactor` and before `updateRecovery`:

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

- [ ] **Step 16: Run test to verify it passes**

Run: `npx vitest run packages/sim/test/recovery.test.ts -t "startSpinOut"`
Expected: PASS — 6 tests.

---

- [ ] **Step 17: Verify the whole module**

`packages/sim/src/recovery.ts` must now read exactly as follows. Diff it before
running; a mismatch means one of the incremental edits landed in the wrong place.

```ts
import type { AuthEvent, KartState, SimContext, SimState, Tuning, Vec3 } from './types'
import { TICK_DT } from './types'
import { lerp, wrapAngle } from './mathutil'
import { emit } from './state'

/**
 * Yaw rate, rad/s, forced on a kart while `spinOutTicks > 0`.
 * 4*PI rad/s is exactly two visible full turns per second of spin-out.
 */
export const SPIN_YAW_RATE = 4 * Math.PI

/** Per-tick multiplicative retention of horizontal speed while spinning out. */
export const SPIN_SPEED_DECAY = 0.94

/** Scratch respawn target. Module scope so the hot path never allocates. */
const TARGET: Vec3 = { x: 0, y: 0, z: 0 }

export function steeringLocked(k: KartState): boolean {
  return k.spinOutTicks > 0 || k.respawnTicks > 0
}

export function motionLocked(k: KartState): boolean {
  return k.respawnTicks > 0
}

export function surfaceSpeedFactor(k: KartState, t: Tuning): number {
  return k.surface === 'offtrack' ? t.offtrackSpeedMul : 1
}

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

export function updateRecovery(
  ctx: SimContext,
  state: SimState,
  k: KartState,
  events: AuthEvent[],
): void {
  const t = ctx.tuning

  if (k.respawnTicks > 0) {
    stepRespawn(ctx, k)
    if (k.respawnTicks === 0) k.invulnTicks = t.invulnTicks
    return
  }

  if (k.invulnTicks > 0) k.invulnTicks -= 1

  if (k.spinOutTicks > 0) {
    k.angularVelocity = SPIN_YAW_RATE
    k.heading = wrapAngle(k.heading + SPIN_YAW_RATE * TICK_DT)
    k.velocity.x *= SPIN_SPEED_DECAY
    k.velocity.z *= SPIN_SPEED_DECAY
    k.drift.active = false
    k.drift.dir = 0
    k.drift.charge = 0
    k.boostTicks = 0
    k.spinOutTicks -= 1
  }

  const proj = ctx.query.project(k.position)
  if (!ctx.query.isInBounds(proj.s, proj.lateral)) {
    beginRespawn(ctx, state, k, events)
  }
}

function checkpointTarget(ctx: SimContext, k: KartState): number {
  const cps = ctx.track.checkpointS
  const n = cps.length
  let s = 0
  if (n > 0) {
    const idx = ((k.lap.checkpointIdx % n) + n) % n
    s = cps[idx]
  }
  const cp = ctx.query.sampleAt(s)
  TARGET.x = cp.position.x
  TARGET.y = ctx.query.groundHeight(s, 0)
  TARGET.z = cp.position.z
  const tan = ctx.query.tangentAt(s)
  return Math.atan2(tan.z, tan.x)
}

function snapToCheckpoint(ctx: SimContext, k: KartState): void {
  const h = checkpointTarget(ctx, k)
  k.position.x = TARGET.x
  k.position.y = TARGET.y
  k.position.z = TARGET.z
  k.heading = wrapAngle(h)
}

function beginRespawn(
  ctx: SimContext,
  state: SimState,
  k: KartState,
  events: AuthEvent[],
): void {
  const t = ctx.tuning
  k.spinOutTicks = 0
  k.boostTicks = 0
  k.invulnTicks = 0
  k.drift.active = false
  k.drift.dir = 0
  k.drift.charge = 0
  k.velocity.x = 0
  k.velocity.y = 0
  k.velocity.z = 0
  k.angularVelocity = 0
  k.airborne = false
  k.respawnTicks = t.respawnTicks > 0 ? t.respawnTicks : 0
  emit(state, events, 'respawn', k.playerId, -1, 'none', k.respawnTicks)
  if (k.respawnTicks === 0) {
    snapToCheckpoint(ctx, k)
    k.invulnTicks = t.invulnTicks
  }
}

function stepRespawn(ctx: SimContext, k: KartState): void {
  k.velocity.x = 0
  k.velocity.y = 0
  k.velocity.z = 0
  k.angularVelocity = 0
  k.airborne = false
  k.boostTicks = 0
  k.drift.active = false
  k.drift.dir = 0
  k.drift.charge = 0

  if (k.respawnTicks <= 1) {
    snapToCheckpoint(ctx, k)
    k.respawnTicks = 0
    return
  }

  const h = checkpointTarget(ctx, k)
  const f = 1 / k.respawnTicks
  k.position.x = lerp(k.position.x, TARGET.x, f)
  k.position.y = lerp(k.position.y, TARGET.y, f)
  k.position.z = lerp(k.position.z, TARGET.z, f)
  k.heading = wrapAngle(k.heading + wrapAngle(h - k.heading) * f)
  k.respawnTicks -= 1
}
```

Run: `npx vitest run packages/sim/test/recovery.test.ts`
Expected: PASS — 24 tests, 4 describe blocks.

Run: `npx tsc --noEmit -p packages/sim`
Expected: no output, exit code 0.

Nothing in the package imports `recovery.ts` yet. Steps 18–25 are what give it
consumers: `kart.ts` (the control locks and the off-track speed factor) and
`step.ts` (canonical slot 2). Without them a spinning kart keeps full steering and
throttle, a respawning kart's interpolation is overwritten by the integrator on the
same tick, the off-track speed penalty never applies, and `updateRecovery` is never
called at all.

---

- [ ] **Step 18: Write the failing test — `stepKart` obeys the locks and the surface factor**

Append this block to the end of `packages/sim/test/kart.test.ts`. That file already
has, at module scope, `const ctx = makeTestContext(EIGHT_STARTS)`,
`const state = createState(ctx, 1, [0, 0, 0, 0, 0, 0, 0, 0])`, and imports
`{ stepKart, targetSpeedFor }` from `../src/kart` plus
`{ EIGHT_STARTS, makeIntent, makeKart, makeTestContext }` from
`./helpers/flat-context` — no import changes are needed.

```typescript
describe('stepKart — recovery locks and the off-track speed factor', () => {
  it('takes the steering axis away while spinning out, but still integrates motion', () => {
    // steeringLocked(k) is true, so stepKart reads the steer axis as 0 and the yaw
    // term vanishes even at full stick. Everything else still runs: a spinning kart
    // slides, it is not frozen.
    //   longitudinal: accel 0 -> target 0, rate = 24 * 1.00, maxDelta = 24/60 = 0.4,
    //                 so 20 -> 19.6
    //   lateral:      velocity is exactly along heading 0, so vr = 0 and grip is a
    //                 no-op whatever coefficient it picks
    //   position:     0 + 19.6 / 60 = 0.3266666666666667
    const k = makeKart({ characterIdx: 0, velocity: { x: 20, y: 0, z: 0 }, spinOutTicks: 12 })
    const prevKart = makeKart({ characterIdx: 0, velocity: { x: 20, y: 0, z: 0 } })
    stepKart(ctx, state, prevKart, k, makeIntent({ steer: 1 }))

    expect(k.angularVelocity).toBe(0)
    expect(k.heading).toBe(0)
    expect(k.velocity.x).toBeCloseTo(19.6, 12)
    expect(k.position.x).toBeCloseTo(0.3266666666666667, 12)
    expect(k.spinOutTicks).toBe(12) // stepKart never touches the timer

    // The identical kart with no spin-out steers normally, which is what makes the
    // assertions above about the lock and not about the speed-authority curve:
    // sn = 20/40 = 0.5, authority = 0.5 * (1 - 0.55 * 0.5) = 0.3625,
    // yaw = 2.6 * 1 * 1.00 * 0.3625 = 0.9425
    const free = makeKart({ characterIdx: 0, velocity: { x: 20, y: 0, z: 0 } })
    stepKart(ctx, state, makeKart({ velocity: { x: 20, y: 0, z: 0 } }), free, makeIntent({ steer: 1 }))
    expect(free.angularVelocity).toBeCloseTo(0.9425, 12)
  })

  it('does nothing at all while the kart is respawning', () => {
    // motionLocked(k) is true: updateRecovery owns this kart's position, velocity
    // and heading for the whole respawn interpolation, so stepKart must return
    // before the traction block AND before the horizontal position integration.
    // Full stick and full throttle, to prove it is the lock and not the input.
    // prevKart enters at 20 m/s, so without the lock the yaw term would be
    // sn = 0.5, authority = 0.3625, yawRate = 2.6 * 1 * 1.00 * 0.3625 = 0.9425.
    const k = makeKart({
      characterIdx: 0,
      position: { x: 5, y: 1, z: 2 },
      velocity: { x: 20, y: 0, z: 3 },
      heading: 0,
      angularVelocity: 0.5,
      respawnTicks: 7,
    })
    const prevKart = makeKart({ characterIdx: 0, velocity: { x: 20, y: 0, z: 0 } })
    stepKart(ctx, state, prevKart, k, makeIntent({ steer: 1, accel: 1 }))

    expect(k.heading).toBe(0)
    expect(k.angularVelocity).toBe(0.5)
    expect(k.position.x).toBe(5)
    expect(k.position.y).toBe(1)
    expect(k.position.z).toBe(2)
    expect(k.velocity.x).toBe(20)
    expect(k.velocity.z).toBe(3)
    expect(k.respawnTicks).toBe(7)
  })

  it('multiplies the target speed by offtrackSpeedMul, and only off-track', () => {
    // 40 * 1.00 * 1 * 0.55 * 1 * 1 = 22
    expect(targetSpeedFor(ctx, state, makeKart({ characterIdx: 0, surface: 'offtrack' }), 1))
      .toBeCloseTo(22, 12)

    // every other surface contributes exactly 1
    expect(targetSpeedFor(ctx, state, makeKart({ characterIdx: 0, surface: 'tarmac' }), 1)).toBe(40)
    expect(targetSpeedFor(ctx, state, makeKart({ characterIdx: 0, surface: 'dirt' }), 1)).toBe(40)
    expect(targetSpeedFor(ctx, state, makeKart({ characterIdx: 0, surface: 'boost' }), 1)).toBe(40)

    // and it composes with the other factors in the contract's order:
    // 40 * 1.10 * 0.5 * 0.55 * 1 * 1.35 = 16.335
    expect(
      targetSpeedFor(
        ctx,
        state,
        makeKart({ characterIdx: 1, surface: 'offtrack', boostTicks: 4 }),
        0.5,
      ),
    ).toBeCloseTo(16.335, 12)
  })

  it('drives the longitudinal term from the off-track target speed', () => {
    // Off-track target = 40 * 1.00 * 1 * 0.55 = 22. The kart is above it at 30 m/s,
    // so it sheds a full maxDelta: 30 - 24/60 = 29.6.
    const kOff = makeKart({ characterIdx: 0, velocity: { x: 30, y: 0, z: 0 }, surface: 'offtrack' })
    stepKart(
      ctx, state,
      makeKart({ characterIdx: 0, velocity: { x: 30, y: 0, z: 0 } }),
      kOff,
      makeIntent({ accel: 1 }),
    )
    expect(kOff.velocity.x).toBeCloseTo(29.6, 12)

    // The identical kart on tarmac targets 40 and gains instead: 30 + 0.4 = 30.4.
    const kOn = makeKart({ characterIdx: 0, velocity: { x: 30, y: 0, z: 0 }, surface: 'tarmac' })
    stepKart(
      ctx, state,
      makeKart({ characterIdx: 0, velocity: { x: 30, y: 0, z: 0 } }),
      kOn,
      makeIntent({ accel: 1 }),
    )
    expect(kOn.velocity.x).toBeCloseTo(30.4, 12)
  })
})
```

- [ ] **Step 19: Run test to verify it fails**

Run: `npx vitest run packages/sim/test/kart.test.ts -t "recovery locks and the off-track speed factor"`

Expected: FAIL — all four tests, each on its first assertion.
"takes the steering axis away while spinning out" reports `expected 0.9425 to be 0`
for `k.angularVelocity` (vitest prints the exact float; the point is that the yaw
term is non-zero) — `stepKart` still reads `raw.steer` unconditionally.
"does nothing at all while the kart is respawning" reports
`expected 0.015708333333333335 to be 0` for `k.heading`: one tick of the 0.9425 rad/s
yaw the lock is supposed to suppress.
"multiplies the target speed by offtrackSpeedMul" reports `expected 40 to be close
to 22`: `targetSpeedFor` still multiplies by the literal `1`.
"drives the longitudinal term from the off-track target speed" reports
`expected 30.4 to be close to 29.6`: with no surface penalty the off-track kart
targets 40 and accelerates instead of shedding speed. Its second assertion, the
tarmac control case, already passes.

- [ ] **Step 20: Wire the locks and the surface factor into `kart.ts`**

Four edits in `packages/sim/src/kart.ts`. Task 8 has already edited this file (it
replaced `stepKart`'s inline grip expression with `lateralGripFor(ctx, k)` and added
`import { lateralGripFor } from './drift'`); none of the four edits below touches
that block, and each anchor below is unique in the file.

**Edit 1 — the import.** Before:

```typescript
import { clamp, wrapAngle } from './mathutil'
```

After:

```typescript
import { clamp, wrapAngle } from './mathutil'
import { motionLocked, steeringLocked, surfaceSpeedFactor } from './recovery'
```

(`recovery.ts` imports `types`, `mathutil` and `state` only, so this introduces no
import cycle.)

**Edit 2 — the off-track factor.** Task 6 wrote the literal under a three-line
comment; all four lines go, replaced by the one line below. Before:

```typescript
  // Task 9 replaces this exact line with `const surfaceFactor = surfaceSpeedFactor(k, t)`
  // and adds `import { surfaceSpeedFactor } from './recovery'` at the top of this
  // file. Until then there is no off-track penalty.
  const surfaceFactor = 1
```

After:

```typescript
  const surfaceFactor = surfaceSpeedFactor(k, t)
```

**Edit 3 — the motion lock.** These three lines open `stepKart`; the pair
`const t` / `const ch` also appears in `targetSpeedFor`, so include the
`if (!k.airborne) {` line, which makes the anchor unique. Before:

```typescript
  const t = ctx.tuning
  const ch = ctx.characters[k.characterIdx] as CharacterStats

  if (!k.airborne) {
```

After:

```typescript
  const t = ctx.tuning
  const ch = ctx.characters[k.characterIdx] as CharacterStats

  // Canonical order slot 2 already ran this tick. A respawning kart's position and
  // velocity belong to updateRecovery's interpolation, so stepKart does nothing at
  // all for it — not the traction block, and not the position integration below.
  if (motionLocked(k)) return

  if (!k.airborne) {
```

**Edit 4 — the steering lock**, inside the block Edit 3 lands in front of. Before:

```typescript
    const authority = sn * (1 - t.steerSpeedFalloff * sn)
    const yawRate = t.steerRateBase * raw.steer * ch.handling * authority
```

After:

```typescript
    const authority = sn * (1 - t.steerSpeedFalloff * sn)
    // A spinning or respawning kart has no steering authority at all (Task 9).
    const steer = steeringLocked(k) ? 0 : raw.steer
    const yawRate = t.steerRateBase * steer * ch.handling * authority
```

`raw` is still read by the longitudinal block (`raw.brake`, `raw.accel`), so it does
not become unused.

- [ ] **Step 21: Run test to verify it passes**

Run: `npx vitest run packages/sim/test/kart.test.ts`

Expected: PASS — 20 tests: the four written in Step 18, plus the 16 Task 6 left in
this file (3 `targetSpeedFor` + 5 steering + 5 longitudinal + 2 lateral grip +
1 airborne = 16; 16 + 4 = 20), all still green. Tasks 7 and 8 add no test to
`kart.test.ts` — Task 8 only re-runs it — so 16 is still the count at the top of
this task. None of Task 6's numbers moves: none of its karts sets
`spinOutTicks` or `respawnTicks`, and its one `surface: 'offtrack'` case is the
lateral-grip test, which passes `accel 0` — `surfaceSpeedFactor` multiplies a target
speed that is already `40 * 1.00 * 0 = 0`.

---

- [ ] **Step 22: Write the failing test — `step()` runs `updateRecovery` at slot 2**

Append this block to the end of `packages/sim/test/step.test.ts`. That file already
imports `AuthEvent`, `Intent`, `createState`, `step`, `EIGHT_STARTS`, `makeIntent`
and `makeTestContext` — no import changes are needed.

```typescript
describe('step — recovery at slot 2', () => {
  it('spends a spin-out tick, and the integrator sees the steering lock', () => {
    const ctx = makeTestContext(EIGHT_STARTS)
    const prev = createState(ctx, 7, [0, 0, 0, 0, 0, 0, 0, 0])
    const next = createState(ctx, 7, [0, 0, 0, 0, 0, 0, 0, 0])
    prev.karts[0].spinOutTicks = 60
    prev.karts[0].velocity.x = 20 // enough speed that steering would bite

    const inputs: Intent[] = []
    inputs[0] = makeIntent({ steer: 1 })

    step(ctx, prev, next, inputs, [])

    // updateRecovery spent one tick of the spin and forced the yaw:
    //   heading = 0 + SPIN_YAW_RATE * TICK_DT = 4*PI / 60 = PI/15 = 0.20943951023931953
    expect(next.karts[0].spinOutTicks).toBe(59)
    expect(next.karts[0].heading).toBeCloseTo(0.20943951023931953, 12)
    // and stepKart, running after it, read steeringLocked and added no yaw of its
    // own — without the lock this would be 2.6 * 1 * 1.00 * 0.3625 = 0.9425
    expect(next.karts[0].angularVelocity).toBe(0)

    // prev is never written
    expect(prev.karts[0].spinOutTicks).toBe(60)
    expect(prev.karts[0].heading).toBe(0)
  })

  it('respawns a kart that is out of bounds at the top of the tick', () => {
    const ctx = makeTestContext(EIGHT_STARTS)
    const prev = createState(ctx, 7, [0, 0, 0, 0, 0, 0, 0, 0])
    const next = createState(ctx, 7, [0, 0, 0, 0, 0, 0, 0, 0])
    // makeFlatQuery projects lateral = position.z and bounds it at |lateral| <= 10
    prev.karts[0].position.z = 50
    prev.karts[0].velocity.x = 20
    const events: AuthEvent[] = []

    step(ctx, prev, next, [], events)

    expect(next.karts[0].respawnTicks).toBe(72) // tuning.respawnTicks
    expect(next.karts[0].velocity.x).toBe(0)    // beginRespawn freezes the kart
    expect(next.karts[0].position.z).toBe(50)   // the detection tick does not move it
    // and stepKart honoured motionLocked, so nothing integrated on top of it
    expect(next.karts[0].position.x).toBe(0)

    // Filtered by kind: later tasks add lap and item events to this same tick, and
    // this test is about the respawn only.
    const respawns = events.filter((e) => e.kind === 'respawn')
    expect(respawns.length).toBe(1)
    expect(respawns[0].playerId).toBe(0)
    expect(respawns[0].entityId).toBe(-1)
    expect(respawns[0].data).toBe(72)

    expect(prev.karts[0].respawnTicks).toBe(0) // prev is never written
  })
})
```

- [ ] **Step 23: Run test to verify it fails**

Run: `npx vitest run packages/sim/test/step.test.ts -t "recovery at slot 2"`

Expected: FAIL — both tests.
"spends a spin-out tick" reports `expected 60 to be 59`: `step()` never calls
`updateRecovery`, so the timer is untouched. (Its `angularVelocity` assertion already
passes, because Step 20 gave `stepKart` the lock and `spinOutTicks` is still 60.)
"respawns a kart that is out of bounds" reports `expected 0 to be 72` for
`respawnTicks`: nothing ever tests the kart against the track bounds.

- [ ] **Step 24: Wire `updateRecovery` into `step()` at canonical slot 2**

Three edits in `packages/sim/src/step.ts`.

**Edit 1 — the import.** Before:

```typescript
import { stepKart } from './kart'
```

After:

```typescript
import { stepKart } from './kart'
import { updateRecovery } from './recovery'
```

**Edit 2 — the slot-2 call.** Task 8 put `updateDrift` on the line immediately before
`stepKart`; slot 2 goes immediately before that. Before:

```typescript
    updateDrift(ctx, k, raw)
    stepKart(ctx, next, prevKart, k, raw)
```

After:

```typescript
    // Canonical order slot 2. Recovery runs before drift and before the integrator
    // because it owns this kart's controls for the rest of the tick: stepKart reads
    // steeringLocked / motionLocked, and updateDrift forfeits a charge on a kart
    // that recovery has just put into a spin-out or a respawn.
    updateRecovery(ctx, next, k, events)
    updateDrift(ctx, k, raw)
    stepKart(ctx, next, prevKart, k, raw)
```

**Edit 3 — delete the now-dead `void`.** `events` is genuinely read from here on, so
the statement that was standing in for a use goes away. Before:

```typescript
  void events // used from Task 9 onward, when updateRecovery joins the kart loop

  cloneState(prev, next)
```

After:

```typescript
  cloneState(prev, next)
```

- [ ] **Step 25: Run test to verify it passes, then the whole suite**

Run: `npx vitest run packages/sim/test/step.test.ts`

Expected: PASS — 8 tests: the 3 from Task 5, the 3 from Task 6, and the 2 from
Step 22. Task 5's and Task 6's tests are unaffected: their karts have
`spinOutTicks === 0` and `respawnTicks === 0`, and the widest `EIGHT_STARTS` seat
sits at `lateral 3`, well inside `makeFlatQuery.isInBounds`'s `|lateral| <= 10`, so
no kart respawns and no event is emitted.

Run: `npx vitest run packages/sim && npx tsc --noEmit -p packages/sim`

Expected: PASS — every `packages/sim` test green, and `tsc` reports no errors
(in particular no unused-parameter error, since Edit 3 removed the `void events`
that was standing in for a real use).

- [ ] **Step 26: Commit**

```bash
git add packages/sim/src/recovery.ts packages/sim/test/recovery.test.ts \
        packages/sim/src/kart.ts packages/sim/test/kart.test.ts \
        packages/sim/src/step.ts packages/sim/test/step.test.ts
git commit -m "feat(sim): spin-out and respawn recovery, wired into step() at slot 2

updateRecovery drives both recovery states: an out-of-bounds kart interpolates
linearly back to its last checkpoint over tuning.respawnTicks and is granted
tuning.invulnTicks on arrival, while startSpinOut - the sole writer of
spinOutTicks - forces a 4*PI rad/s yaw and decays horizontal speed by 0.94 per
tick. Both paths emit countable respawn/spinOut AuthEvents.

step() now calls updateRecovery at canonical slot 2, before updateDrift and the
integrator, and stepKart consumes all three predicates: steeringLocked zeroes
the steer axis, motionLocked makes stepKart a no-op so it cannot overwrite the
respawn interpolation, and surfaceSpeedFactor replaces the literal 1 that stood
in for the off-track term of targetSpeedFor."
```

---

### Task 10: Kart-vs-kart collision resolution

**Files:**
- Create: `packages/sim/src/collision.ts`
- Test: `packages/sim/test/collision.test.ts`
- Modify: `packages/sim/src/step.ts` (two edits — the import line and one call after the
  per-kart loop; exact before/after in Step 16)
- Modify: `packages/sim/test/step.test.ts` (append one describe block; exact code in Step 14)

**Interfaces:**

- Consumes (all fixed by the locked contract, all authored by earlier tasks):
  - `packages/sim/src/types.ts` [Task 2] — `MAX_KARTS` (`= 8`), `MAX_ENTITIES` (`= 32`),
    and the types `EntityState`, `KartState`, `SimContext`, `SimState`.
  - `SimContext.tuning.kartRadius` (fixture value `0.9`) and
    `SimContext.tuning.kartRestitution` (fixture value `0.4`).
  - `SimContext.characters[i].weight` — fixture weights for characters 0..7 are
    `[1.00, 1.20, 0.85, 1.10, 0.90, 1.30, 0.80, 1.00]`.
  - `KartState.respawnTicks` — a kart with `respawnTicks > 0` is being teleported by
    `updateRecovery` (Task 9) and takes no part in collision.
  - `packages/sim/test/fixtures/track-fixtures.ts` —
    `makeStraightTrack(overrides?: Partial<Track>): Track` [Task 3] and
    `makeContext(track: Track, isLeader?: boolean): SimContext` [Task 4, because it
    needs `buildTrackQuery`].
  - `packages/sim/test/helpers/flat-context.ts` [Task 5, extended by Task 6] —
    `makeTestContext(startPositions)`, `EIGHT_STARTS`; used only by this task's
    `step()` test.
  - `packages/sim/src/state.ts` [Task 5] — `createState(ctx, seed, characterIdx)`,
    used only by this task's `step()` test.
  - `packages/sim/src/step.ts` [Task 5, extended by 6–9] — the per-kart loop, whose
    last statement after Task 8 is `decayBoost(k)`. This task adds the first
    once-per-tick call after that loop closes.

- Produces (exact names and signatures later tasks rely on):
  - `export function resolveKartCollisions(ctx: SimContext, state: SimState): void`
    — called once per tick from `step()`, after the per-kart loop and before
    `updateEntities`, exactly as the contract's canonical order states. Mutates
    `state.karts[*].position` and `.velocity` only. Emits no events.
  - `export const POSITION_ITERATIONS: number` — `4`. New, defined here; the number of
    Jacobi position-correction passes per call.
  - The `step()` call site itself (Step 16), per contract §0: the task that introduces
    a function also adds its call site in `step.ts`, with its own failing test. Task 12
    inserts `updateEntities(ctx, next, events)` directly after the line this task adds,
    and Task 13 inserts `updateItemBoxes` after that, which is the contract's
    `resolveKartCollisions → updateEntities → updateItemBoxes → updatePhase`.

**Order independence is a hard requirement of this task.** The function must produce
bit-identical results no matter which array slot each kart occupies. Two properties
buy that, and both are asserted by tests below:

1. Pairs are visited by **ascending `playerId`**, not by array index, and the lower
   `playerId` is always the `a` side. A kart's identity, not its slot, decides every
   sign in the computation.
2. Each pass is **Jacobi**: every pair reads the same starting positions and writes
   into per-`playerId` accumulators, which are applied only after the whole pass.
   A Gauss-Seidel pass (apply as you go) makes each pair's input depend on which
   pairs ran before it, which is precisely the slot dependence we are eliminating.

---

- [ ] **Step 1: Write the failing test — the impulse**

Create `packages/sim/test/collision.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { EntityState, KartState, SimContext, SimState } from '../src/types'
import { MAX_ENTITIES, MAX_KARTS } from '../src/types'
import { makeContext, makeStraightTrack } from './fixtures/track-fixtures'
import { resolveKartCollisions } from '../src/collision'

// A deliberately local kart builder: this file addresses karts by playerId and
// writes every field explicitly, so it does not use Task 6's shared
// `makeKart(over?)`. `resolveKartCollisions` never reads `lap`, so the value below
// is inert; the real initial value createState produces is
// `{ lap: 0, checkpointIdx: track.checkpointS.length - 1, t: 0 }`.
function makeKart(playerId: number): KartState {
  return {
    playerId,
    characterIdx: 0,
    isBot: false,
    connected: true,
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

/**
 * Eight karts, playerId == slot, parked 100 apart along +X starting at x = 1000.
 * Nothing within 100 of anything else, so any kart a test does not explicitly
 * place cannot influence the result.
 */
function makeSimState(): SimState {
  const karts: KartState[] = []
  for (let i = 0; i < MAX_KARTS; i++) {
    const k = makeKart(i)
    k.position.x = 1000 + i * 100
    karts.push(k)
  }
  const entities: EntityState[] = []
  for (let i = 0; i < MAX_ENTITIES; i++) {
    entities.push({
      entityId: -1,
      kind: 'seeker',
      ownerId: -1,
      position: { x: 0, y: 0, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
      heading: 0,
      targetId: -1,
      ttl: 0,
    })
  }
  return {
    tick: 0,
    phase: 'racing',
    raceSeed: 1,
    rngCursor: 0,
    nextEventSeq: 0,
    finishTick: -1,
    karts,
    entities,
    entityCount: 0,
    nextEntityId: 1,
    itemBoxes: [],
    // Contract §0: finishedOrder is fixed length MAX_KARTS, unused slots hold -1.
    finishedOrder: new Array<number>(MAX_KARTS).fill(-1),
  }
}

function setKart(
  k: KartState,
  playerId: number,
  characterIdx: number,
  px: number, py: number, pz: number,
  vx: number, vy: number, vz: number,
): void {
  k.playerId = playerId
  k.characterIdx = characterIdx
  k.position.x = px
  k.position.y = py
  k.position.z = pz
  k.velocity.x = vx
  k.velocity.y = vy
  k.velocity.z = vz
  k.respawnTicks = 0
}

function byId(state: SimState, playerId: number): KartState {
  for (let i = 0; i < MAX_KARTS; i++) {
    if (state.karts[i].playerId === playerId) return state.karts[i]
  }
  throw new Error(`no kart with playerId ${playerId}`)
}

function distance(a: KartState, b: KartState): number {
  return Math.hypot(
    b.position.x - a.position.x,
    b.position.y - a.position.y,
    b.position.z - a.position.z,
  )
}

function ctxFor(): SimContext {
  return makeContext(makeStraightTrack())
}

describe('kart collision impulse', () => {
  it('uses the locked tuning and weight fixtures', () => {
    const ctx = ctxFor()
    expect(ctx.tuning.kartRadius).toBe(0.9) // contact distance is 2 * 0.9 = 1.8
    expect(ctx.tuning.kartRestitution).toBe(0.4)
    expect(ctx.characters[0].weight).toBe(1)
    expect(ctx.characters[7].weight).toBe(1)
    expect(ctx.characters[5].weight).toBe(1.3)
    expect(ctx.characters[6].weight).toBe(0.8)
  })

  it('drives an equal-weight head-on pair apart at the restitution ratio', () => {
    const ctx = ctxFor()
    const state = makeSimState()
    // both weight 1.00, 1.0 apart (contact is 1.8, so overlapping), closing at 20
    setKart(state.karts[0], 0, 0, 0, 0, 0, 10, 0, 0)
    setKart(state.karts[1], 1, 7, 1, 0, 0, -10, 0, 0)

    resolveKartCollisions(ctx, state)

    // n = (1,0,0); vn = (-10) - (10) = -20
    // j = -(1 + 0.4) * (-20) / (1/1 + 1/1) = 28 / 2 = 14
    // a.vx = 10 - 14 * 1 = -4 ; b.vx = -10 + 14 * 1 = 4
    expect(state.karts[0].velocity.x).toBeCloseTo(-4, 12)
    expect(state.karts[1].velocity.x).toBeCloseTo(4, 12)
    // separating speed is exactly restitution * closing speed: 0.4 * 20 = 8
    expect(state.karts[1].velocity.x - state.karts[0].velocity.x).toBeCloseTo(8, 12)
    // momentum: 1*(-4) + 1*4 = 0, same as 1*10 + 1*(-10) before
    expect(state.karts[0].velocity.x + state.karts[1].velocity.x).toBeCloseTo(0, 12)
    // nothing off-axis
    expect(state.karts[0].velocity.y).toBeCloseTo(0, 12)
    expect(state.karts[0].velocity.z).toBeCloseTo(0, 12)
    expect(state.karts[1].velocity.y).toBeCloseTo(0, 12)
    expect(state.karts[1].velocity.z).toBeCloseTo(0, 12)
  })

  it("scales the impulse by the two characters' weight stats", () => {
    const ctx = ctxFor()
    const state = makeSimState()
    // character 5 weight 1.30 rams stationary character 6 weight 0.80
    setKart(state.karts[0], 0, 5, 0, 0, 0, 10, 0, 0)
    setKart(state.karts[1], 1, 6, 1, 0, 0, 0, 0, 0)

    resolveKartCollisions(ctx, state)

    // invA = 1/1.3 = 10/13, invB = 1/0.8 = 5/4, sum = 105/52
    // vn = 0 - 10 = -10
    // j = -(1.4) * (-10) / (105/52) = 14 * 52 / 105 = 728/105 = 104/15
    // a.vx = 10 - j*(10/13) = 10 - 16/3 = 14/3 = 4.666666666666667
    // b.vx = 0  + j*(5/4)   = 26/3      = 8.666666666666666
    expect(state.karts[0].velocity.x).toBeCloseTo(4.666666666666667, 12)
    expect(state.karts[1].velocity.x).toBeCloseTo(8.666666666666666, 12)
    // heavy kart keeps more of its speed than the light one gains over it
    expect(state.karts[1].velocity.x - state.karts[0].velocity.x).toBeCloseTo(4, 12)
    // weighted momentum: 1.3*14/3 + 0.8*26/3 = 39/3 = 13 == 1.3 * 10
    const p = 1.3 * state.karts[0].velocity.x + 0.8 * state.karts[1].velocity.x
    expect(p).toBeCloseTo(13, 12)
  })

  it('applies no impulse to karts that are already moving apart', () => {
    const ctx = ctxFor()
    const state = makeSimState()
    setKart(state.karts[0], 0, 0, 0, 0, 0, -3, 0, 0)
    setKart(state.karts[1], 1, 7, 1, 0, 0, 7, 0, 0)

    resolveKartCollisions(ctx, state)

    // vn = 7 - (-3) = +10 : separating, so no impulse at all
    expect(state.karts[0].velocity.x).toBe(-3)
    expect(state.karts[1].velocity.x).toBe(7)
  })

  it('ignores karts at or beyond the contact distance', () => {
    const ctx = ctxFor()

    const touching = makeSimState()
    setKart(touching.karts[0], 0, 0, 0, 0, 0, 10, 0, 0)
    setKart(touching.karts[1], 1, 7, 1.8, 0, 0, -10, 0, 0) // exactly 2 * 0.9
    resolveKartCollisions(ctx, touching)
    expect(touching.karts[0].velocity.x).toBe(10)
    expect(touching.karts[1].velocity.x).toBe(-10)

    const apart = makeSimState()
    setKart(apart.karts[0], 0, 0, 0, 0, 0, 10, 0, 0)
    setKart(apart.karts[1], 1, 7, 2.5, 0, 0, -10, 0, 0)
    resolveKartCollisions(ctx, apart)
    expect(apart.karts[0].velocity.x).toBe(10)
    expect(apart.karts[1].velocity.x).toBe(-10)
  })

  it('leaves a respawning kart out of the collision entirely', () => {
    const ctx = ctxFor()
    const state = makeSimState()
    setKart(state.karts[0], 0, 0, 0, 0, 0, 10, 0, 0)
    setKart(state.karts[1], 1, 7, 1, 0, 0, -10, 0, 0)
    state.karts[0].respawnTicks = 10 // Task 9 owns this kart's position this tick

    resolveKartCollisions(ctx, state)

    expect(state.karts[0].velocity.x).toBe(10)
    expect(state.karts[1].velocity.x).toBe(-10)
  })

  it('collides in three dimensions, not just the ground plane', () => {
    const ctx = ctxFor()
    const state = makeSimState()
    // a kart landing on top of another: 1.0 apart along +y
    setKart(state.karts[0], 0, 0, 0, 0, 0, 0, 0, 0)
    setKart(state.karts[1], 1, 7, 0, 1, 0, 0, -20, 0)

    resolveKartCollisions(ctx, state)

    // identical arithmetic to the head-on case, rotated onto +y:
    // vn = -20 - 0 = -20, j = 14, a.vy = -14, b.vy = -20 + 14 = -6
    expect(state.karts[0].velocity.y).toBeCloseTo(-14, 12)
    expect(state.karts[1].velocity.y).toBeCloseTo(-6, 12)
    expect(state.karts[0].velocity.x).toBeCloseTo(0, 12)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/sim/test/collision.test.ts -t "kart collision impulse"`
Expected: FAIL with `Failed to resolve import "../src/collision"` — the module does not
exist yet.

- [ ] **Step 3: Write minimal implementation — the impulse**

Create `packages/sim/src/collision.ts`:

```ts
import type { KartState, SimContext, SimState } from './types'
import { MAX_KARTS } from './types'

/**
 * Sphere-vs-sphere kart collision. Called once per tick from `step()`, after the
 * per-kart loop and before `updateEntities`.
 */
export function resolveKartCollisions(ctx: SimContext, state: SimState): void {
  const t = ctx.tuning
  const contact = t.kartRadius * 2
  const contactSq = contact * contact
  const chars = ctx.characters

  for (let sa = 0; sa < MAX_KARTS; sa++) {
    const a = state.karts[sa]
    if (!collidable(a)) continue
    for (let sb = sa + 1; sb < MAX_KARTS; sb++) {
      const b = state.karts[sb]
      if (!collidable(b)) continue

      const dx = b.position.x - a.position.x
      const dy = b.position.y - a.position.y
      const dz = b.position.z - a.position.z
      const d2 = dx * dx + dy * dy + dz * dz
      if (d2 >= contactSq) continue

      // Exactly coincident karts get a fixed +X normal so the result stays
      // deterministic instead of dividing by zero.
      let nx = 1
      let ny = 0
      let nz = 0
      if (d2 > 0) {
        const dist = Math.sqrt(d2)
        nx = dx / dist
        ny = dy / dist
        nz = dz / dist
      }

      const rvx = b.velocity.x - a.velocity.x
      const rvy = b.velocity.y - a.velocity.y
      const rvz = b.velocity.z - a.velocity.z
      const vn = rvx * nx + rvy * ny + rvz * nz
      if (vn >= 0) continue // already separating

      const wa = chars[a.characterIdx].weight
      const wb = chars[b.characterIdx].weight
      const invA = 1 / wa
      const invB = 1 / wb
      const imp = -(1 + t.kartRestitution) * vn / (invA + invB)
      const ia = imp * invA
      const ib = imp * invB

      a.velocity.x -= nx * ia
      a.velocity.y -= ny * ia
      a.velocity.z -= nz * ia
      b.velocity.x += nx * ib
      b.velocity.y += ny * ib
      b.velocity.z += nz * ib
    }
  }
}

/** A kart being teleported by `updateRecovery` (Task 9) takes no part in collision. */
function collidable(k: KartState): boolean {
  return k.respawnTicks === 0
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/sim/test/collision.test.ts -t "kart collision impulse"`
Expected: PASS — 7 tests.

---

- [ ] **Step 5: Write the failing test — positional separation**

Append this block to the end of `packages/sim/test/collision.test.ts`:

```ts
const PILE_UP_SLOTS: number[][] = [
  [0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0],
]

/**
 * Three mutually overlapping karts. `slots[i]` is the array slot that test kart
 * `i` is written into; the five karts left over are parked far away and take the
 * remaining playerIds so all eight ids stay unique.
 *
 *   id 0, character 0, weight 1.00, at (0,   0, 0),   velocity (5, 0, 0)
 *   id 1, character 1, weight 1.20, at (1,   0, 0),   velocity (-5, 0, 0)
 *   id 2, character 2, weight 0.85, at (0.5, 0, 0.8), velocity (0, 0, -5)
 *
 * pair 0-1 is 1.0 apart, pairs 0-2 and 1-2 are sqrt(0.25 + 0.64) = 0.943 apart,
 * so all three pairs are inside the 1.8 contact distance.
 */
function pileUpState(slots: number[]): SimState {
  const state = makeSimState()
  const spare = [3, 4, 5, 6, 7]
  let n = 0
  for (let i = 0; i < MAX_KARTS; i++) {
    if (i === slots[0] || i === slots[1] || i === slots[2]) continue
    setKart(state.karts[i], spare[n], 0, 1000 + i * 100, 0, 0, 0, 0, 0)
    n += 1
  }
  setKart(state.karts[slots[0]], 0, 0, 0, 0, 0, 5, 0, 0)
  setKart(state.karts[slots[1]], 1, 1, 1, 0, 0, -5, 0, 0)
  setKart(state.karts[slots[2]], 2, 2, 0.5, 0, 0.8, 0, 0, -5)
  return state
}

function weightedSum(
  ctx: SimContext,
  state: SimState,
  ids: number[],
  pick: (k: KartState) => number,
): number {
  let acc = 0
  for (const id of ids) {
    const k = byId(state, id)
    acc += ctx.characters[k.characterIdx].weight * pick(k)
  }
  return acc
}

describe('kart collision separation', () => {
  it('pushes an equal-weight overlapping pair out to exactly 2 * kartRadius', () => {
    const ctx = ctxFor()
    const state = makeSimState()
    setKart(state.karts[0], 0, 0, 0, 0, 0, 10, 0, 0)
    setKart(state.karts[1], 1, 7, 1, 0, 0, -10, 0, 0)

    resolveKartCollisions(ctx, state)

    // overlap = 1.8 - 1.0 = 0.8, split 0.4 / 0.4 because the weights are equal
    expect(state.karts[0].position.x).toBeCloseTo(-0.4, 12)
    expect(state.karts[1].position.x).toBeCloseTo(1.4, 12)
    expect(distance(state.karts[0], state.karts[1])).toBeCloseTo(1.8, 12)
  })

  it('splits the separation by weight and preserves the weighted centroid', () => {
    const ctx = ctxFor()
    const state = makeSimState()
    setKart(state.karts[0], 0, 5, 0, 0, 0, 10, 0, 0) // weight 1.30
    setKart(state.karts[1], 1, 6, 1, 0, 0, 0, 0, 0)  // weight 0.80

    resolveKartCollisions(ctx, state)

    // total = 2.1, overlap = 0.8
    // heavy moves overlap * (0.8/2.1) = 0.30476190476190473
    // light moves overlap * (1.3/2.1) = 0.4952380952380953
    expect(state.karts[0].position.x).toBeCloseTo(-0.3047619047619048, 12)
    expect(state.karts[1].position.x).toBeCloseTo(1.4952380952380953, 12)
    expect(distance(state.karts[0], state.karts[1])).toBeCloseTo(1.8, 12)
    // weighted centroid before: (1.3*0 + 0.8*1) / 2.1 = 0.38095238095238093
    const c = (1.3 * state.karts[0].position.x + 0.8 * state.karts[1].position.x) / 2.1
    expect(c).toBeCloseTo(0.38095238095238093, 12)
  })

  it('separates overlapping karts even when they are already moving apart', () => {
    const ctx = ctxFor()
    const state = makeSimState()
    setKart(state.karts[0], 0, 0, 0, 0, 0, -3, 0, 0)
    setKart(state.karts[1], 1, 7, 1, 0, 0, 7, 0, 0)

    resolveKartCollisions(ctx, state)

    expect(state.karts[0].velocity.x).toBe(-3) // still no impulse
    expect(state.karts[1].velocity.x).toBe(7)
    expect(state.karts[0].position.x).toBeCloseTo(-0.4, 12)
    expect(state.karts[1].position.x).toBeCloseTo(1.4, 12)
  })

  it('separates exactly coincident karts along +X, deterministically', () => {
    const ctx = ctxFor()
    const state = makeSimState()
    setKart(state.karts[0], 0, 0, 5, 0, 5, 0, 0, 0)
    setKart(state.karts[1], 1, 7, 5, 0, 5, 0, 0, 0)

    resolveKartCollisions(ctx, state)

    // overlap is the whole 1.8, split 0.9 / 0.9 on the fallback +X normal
    expect(state.karts[0].position.x).toBeCloseTo(4.1, 12)
    expect(state.karts[1].position.x).toBeCloseTo(5.9, 12)
    expect(state.karts[0].position.z).toBeCloseTo(5, 12)
    expect(state.karts[1].position.z).toBeCloseTo(5, 12)
    expect(distance(state.karts[0], state.karts[1])).toBeCloseTo(1.8, 12)
  })

  it('clears a deep overlap in a single call', () => {
    const ctx = ctxFor()
    const state = makeSimState()
    setKart(state.karts[0], 0, 0, 0, 0, 0, 0, 0, 0)
    setKart(state.karts[1], 1, 7, 0.1, 0, 0, 0, 0, 0)

    resolveKartCollisions(ctx, state)

    // overlap = 1.8 - 0.1 = 1.7, split 0.85 / 0.85
    expect(state.karts[0].position.x).toBeCloseTo(-0.85, 12)
    expect(state.karts[1].position.x).toBeCloseTo(0.95, 12)
    expect(distance(state.karts[0], state.karts[1])).toBeGreaterThanOrEqual(1.8 - 1e-9)
  })

  it('does not move a respawning kart out of its interpolation', () => {
    const ctx = ctxFor()
    const state = makeSimState()
    setKart(state.karts[0], 0, 0, 0, 0, 0, 0, 0, 0)
    setKart(state.karts[1], 1, 7, 1, 0, 0, 0, 0, 0)
    state.karts[0].respawnTicks = 10

    resolveKartCollisions(ctx, state)

    expect(state.karts[0].position.x).toBe(0)
    expect(state.karts[1].position.x).toBe(1)
  })

  it('conserves weighted momentum and the weighted centroid of a pile-up', () => {
    const ctx = ctxFor()
    const state = pileUpState([0, 1, 2])
    const ids = [0, 1, 2]

    // before: sum(w*p.x) = 1.00*0 + 1.20*1 + 0.85*0.5 = 1.625
    //         sum(w*p.z) = 0.85*0.8                   = 0.68
    //         sum(w*v.x) = 1.00*5 + 1.20*(-5)         = -1
    //         sum(w*v.z) = 0.85*(-5)                  = -4.25
    resolveKartCollisions(ctx, state)

    expect(weightedSum(ctx, state, ids, (k) => k.position.x)).toBeCloseTo(1.625, 9)
    expect(weightedSum(ctx, state, ids, (k) => k.position.z)).toBeCloseTo(0.68, 9)
    expect(weightedSum(ctx, state, ids, (k) => k.velocity.x)).toBeCloseTo(-1, 9)
    expect(weightedSum(ctx, state, ids, (k) => k.velocity.z)).toBeCloseTo(-4.25, 9)

    for (let i = 0; i < 16; i++) resolveKartCollisions(ctx, state)

    expect(weightedSum(ctx, state, ids, (k) => k.position.x)).toBeCloseTo(1.625, 9)
    expect(weightedSum(ctx, state, ids, (k) => k.position.z)).toBeCloseTo(0.68, 9)
  })

  it('leaves no pair of a 3-kart pile-up overlapped', () => {
    const ctx = ctxFor()
    const state = pileUpState([0, 1, 2])

    for (let i = 0; i < 16; i++) resolveKartCollisions(ctx, state)

    const k0 = byId(state, 0)
    const k1 = byId(state, 1)
    const k2 = byId(state, 2)
    expect(distance(k0, k1)).toBeGreaterThanOrEqual(1.8 - 1e-9)
    expect(distance(k0, k2)).toBeGreaterThanOrEqual(1.8 - 1e-9)
    expect(distance(k1, k2)).toBeGreaterThanOrEqual(1.8 - 1e-9)
  })
})
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run packages/sim/test/collision.test.ts -t "kart collision separation"`
Expected: FAIL — "pushes an equal-weight overlapping pair out to exactly 2 *
kartRadius" reports `expected 0 to be close to -0.4`; the current implementation only
applies the impulse and never touches positions.

- [ ] **Step 7: Write minimal implementation — positional separation**

Replace the whole of `packages/sim/src/collision.ts` with:

```ts
import type { KartState, SimContext, SimState } from './types'
import { MAX_KARTS } from './types'

/**
 * Sphere-vs-sphere kart collision. Called once per tick from `step()`, after the
 * per-kart loop and before `updateEntities`.
 */
export function resolveKartCollisions(ctx: SimContext, state: SimState): void {
  const t = ctx.tuning
  const contact = t.kartRadius * 2
  const contactSq = contact * contact
  const chars = ctx.characters

  for (let sa = 0; sa < MAX_KARTS; sa++) {
    const a = state.karts[sa]
    if (!collidable(a)) continue
    for (let sb = sa + 1; sb < MAX_KARTS; sb++) {
      const b = state.karts[sb]
      if (!collidable(b)) continue

      const dx = b.position.x - a.position.x
      const dy = b.position.y - a.position.y
      const dz = b.position.z - a.position.z
      const d2 = dx * dx + dy * dy + dz * dz
      if (d2 >= contactSq) continue

      // Exactly coincident karts get a fixed +X normal so the result stays
      // deterministic instead of dividing by zero.
      let nx = 1
      let ny = 0
      let nz = 0
      let dist = 0
      if (d2 > 0) {
        dist = Math.sqrt(d2)
        nx = dx / dist
        ny = dy / dist
        nz = dz / dist
      }
      const overlap = contact - dist

      const wa = chars[a.characterIdx].weight
      const wb = chars[b.characterIdx].weight
      const total = wa + wb

      // Positional separation. Each kart yields in proportion to the OTHER kart's
      // weight, so the two shares sum to the whole overlap and the weight-weighted
      // centroid of the pair is unchanged.
      const sepA = overlap * (wb / total)
      const sepB = overlap * (wa / total)
      a.position.x -= nx * sepA
      a.position.y -= ny * sepA
      a.position.z -= nz * sepA
      b.position.x += nx * sepB
      b.position.y += ny * sepB
      b.position.z += nz * sepB

      const rvx = b.velocity.x - a.velocity.x
      const rvy = b.velocity.y - a.velocity.y
      const rvz = b.velocity.z - a.velocity.z
      const vn = rvx * nx + rvy * ny + rvz * nz
      if (vn >= 0) continue // already separating

      const invA = 1 / wa
      const invB = 1 / wb
      const imp = -(1 + t.kartRestitution) * vn / (invA + invB)
      const ia = imp * invA
      const ib = imp * invB

      a.velocity.x -= nx * ia
      a.velocity.y -= ny * ia
      a.velocity.z -= nz * ia
      b.velocity.x += nx * ib
      b.velocity.y += ny * ib
      b.velocity.z += nz * ib
    }
  }
}

/** A kart being teleported by `updateRecovery` (Task 9) takes no part in collision. */
function collidable(k: KartState): boolean {
  return k.respawnTicks === 0
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npx vitest run packages/sim/test/collision.test.ts`
Expected: PASS — 15 tests (7 impulse + 8 separation).

---

- [ ] **Step 9: Write the failing test — order independence**

Append this block to the end of `packages/sim/test/collision.test.ts`:

```ts
describe('kart collision order independence', () => {
  it('resolves a pair identically with the two karts in swapped slots', () => {
    const ctx = ctxFor()

    const forward = makeSimState()
    setKart(forward.karts[0], 0, 5, 0, 0, 0, 10, 0, 0)
    setKart(forward.karts[1], 1, 6, 1, 0, 0, 0, 0, 0)
    resolveKartCollisions(ctx, forward)

    const swapped = makeSimState()
    setKart(swapped.karts[0], 1, 6, 1, 0, 0, 0, 0, 0)
    setKart(swapped.karts[1], 0, 5, 0, 0, 0, 10, 0, 0)
    resolveKartCollisions(ctx, swapped)

    for (const id of [0, 1]) {
      const f = byId(forward, id)
      const s = byId(swapped, id)
      expect(s.position.x).toBe(f.position.x)
      expect(s.position.y).toBe(f.position.y)
      expect(s.position.z).toBe(f.position.z)
      expect(s.velocity.x).toBe(f.velocity.x)
      expect(s.velocity.y).toBe(f.velocity.y)
      expect(s.velocity.z).toBe(f.velocity.z)
    }
  })

  it('resolves a pair identically with the two playerIds swapped', () => {
    const ctx = ctxFor()

    const base = makeSimState()
    setKart(base.karts[0], 0, 5, 0, 0, 0, 10, 0, 0)
    setKart(base.karts[1], 1, 6, 1, 0, 0, 0, 0, 0)
    resolveKartCollisions(ctx, base)

    const renamed = makeSimState()
    setKart(renamed.karts[0], 1, 5, 0, 0, 0, 10, 0, 0) // same heavy kart, id 1
    setKart(renamed.karts[1], 0, 6, 1, 0, 0, 0, 0, 0)  // same light kart, id 0
    resolveKartCollisions(ctx, renamed)

    // compare the heavy kart to the heavy kart, whatever id it wears
    expect(renamed.karts[0].position.x).toBe(base.karts[0].position.x)
    expect(renamed.karts[0].velocity.x).toBe(base.karts[0].velocity.x)
    expect(renamed.karts[1].position.x).toBe(base.karts[1].position.x)
    expect(renamed.karts[1].velocity.x).toBe(base.karts[1].velocity.x)
  })

  it('resolves a 3-kart pile-up identically for all six slot permutations', () => {
    const ctx = ctxFor()
    const reference = pileUpState(PILE_UP_SLOTS[0])
    resolveKartCollisions(ctx, reference)

    for (let p = 1; p < PILE_UP_SLOTS.length; p++) {
      const state = pileUpState(PILE_UP_SLOTS[p])
      resolveKartCollisions(ctx, state)
      for (const id of [0, 1, 2]) {
        const r = byId(reference, id)
        const k = byId(state, id)
        expect(k.position.x).toBe(r.position.x)
        expect(k.position.y).toBe(r.position.y)
        expect(k.position.z).toBe(r.position.z)
        expect(k.velocity.x).toBe(r.velocity.x)
        expect(k.velocity.y).toBe(r.velocity.y)
        expect(k.velocity.z).toBe(r.velocity.z)
      }
    }
  })

  it('stays identical across 20 successive calls in every slot permutation', () => {
    const ctx = ctxFor()
    const reference = pileUpState(PILE_UP_SLOTS[0])
    for (let i = 0; i < 20; i++) resolveKartCollisions(ctx, reference)

    for (let p = 1; p < PILE_UP_SLOTS.length; p++) {
      const state = pileUpState(PILE_UP_SLOTS[p])
      for (let i = 0; i < 20; i++) resolveKartCollisions(ctx, state)
      for (const id of [0, 1, 2]) {
        const r = byId(reference, id)
        const k = byId(state, id)
        expect(k.position.x).toBe(r.position.x)
        expect(k.position.z).toBe(r.position.z)
        expect(k.velocity.x).toBe(r.velocity.x)
        expect(k.velocity.z).toBe(r.velocity.z)
      }
    }
  })

  it('runs the documented number of position passes', () => {
    expect(POSITION_ITERATIONS).toBe(4)
  })
})
```

Then change the import of `../src/collision` at the top of the file.

Before:

```ts
import { resolveKartCollisions } from '../src/collision'
```

After:

```ts
import { POSITION_ITERATIONS, resolveKartCollisions } from '../src/collision'
```

- [ ] **Step 10: Run test to verify it fails**

Run: `npx vitest run packages/sim/test/collision.test.ts -t "kart collision order independence"`
Expected: FAIL on two tests.
"resolves a 3-kart pile-up identically for all six slot permutations" fails with an
`expected <x> to be <y>` mismatch on the first permutation that reorders the karts —
the current pass applies each pair as it goes, so pair 1-2 reads positions that pair
0-1 already moved, and reordering the slots reorders that chain.
"runs the documented number of position passes" fails with `POSITION_ITERATIONS is not
defined` (the export does not exist yet).
The two pair tests already pass: with a single pair there is nothing to reorder. They
stay as regression guards on the sign symmetry of the normal.

- [ ] **Step 11: Write the order-independent implementation**

Replace the whole of `packages/sim/src/collision.ts` with:

```ts
import type { KartState, SimContext, SimState } from './types'
import { MAX_KARTS } from './types'

/**
 * Position-correction passes per call. Each pass is Jacobi — every pair reads the
 * same starting positions and writes into accumulators applied only at the end of
 * the pass — so one pass cannot fully separate a pile-up where a kart is pushed by
 * two neighbours at once. Four passes clear every configuration the 8-kart grid can
 * produce, and passes after separation is reached are no-ops.
 */
export const POSITION_ITERATIONS = 4

/** playerId -> array slot. Module scope: the hot path never allocates. */
const SLOT = new Int32Array(MAX_KARTS)
/** Per-playerId position and velocity accumulators, 3 components each. */
const DP = new Float64Array(MAX_KARTS * 3)
const DV = new Float64Array(MAX_KARTS * 3)

/**
 * Sphere-vs-sphere kart collision. Called once per tick from `step()`, after the
 * per-kart loop and before `updateEntities`.
 *
 * Order independence, which is a hard requirement:
 *
 *  - Pairs are visited by ascending `playerId`, never by array index, and the lower
 *    `playerId` is always the `a` side. Which slot a kart occupies therefore cannot
 *    change any sign in the computation.
 *  - Each pass is Jacobi, so no pair's input depends on which pairs ran before it.
 *  - Every kart's contributions land in its accumulator in ascending partner-id
 *    order (partners below it first, from the outer loop; partners above it after),
 *    so even the float summation order is a function of identity alone. Float
 *    addition is not associative, and this is what keeps a 3-kart pile-up
 *    bit-identical under permutation rather than merely close.
 */
export function resolveKartCollisions(ctx: SimContext, state: SimState): void {
  const t = ctx.tuning
  const contact = t.kartRadius * 2
  const contactSq = contact * contact
  const chars = ctx.characters
  const restitution = 1 + t.kartRestitution

  for (let p = 0; p < MAX_KARTS; p++) SLOT[p] = -1
  for (let i = 0; i < MAX_KARTS; i++) {
    const p = state.karts[i].playerId
    if (p >= 0 && p < MAX_KARTS && SLOT[p] === -1) SLOT[p] = i
  }

  for (let iter = 0; iter < POSITION_ITERATIONS; iter++) {
    const first = iter === 0
    for (let n = 0; n < MAX_KARTS * 3; n++) {
      DP[n] = 0
      if (first) DV[n] = 0
    }

    for (let pa = 0; pa < MAX_KARTS; pa++) {
      const ia = SLOT[pa]
      if (ia < 0) continue
      const a = state.karts[ia]
      if (!collidable(a)) continue

      for (let pb = pa + 1; pb < MAX_KARTS; pb++) {
        const ib = SLOT[pb]
        if (ib < 0) continue
        const b = state.karts[ib]
        if (!collidable(b)) continue

        const dx = b.position.x - a.position.x
        const dy = b.position.y - a.position.y
        const dz = b.position.z - a.position.z
        const d2 = dx * dx + dy * dy + dz * dz
        if (d2 >= contactSq) continue

        // Exactly coincident karts get a fixed +X normal so the result stays
        // deterministic instead of dividing by zero.
        let nx = 1
        let ny = 0
        let nz = 0
        let dist = 0
        if (d2 > 0) {
          dist = Math.sqrt(d2)
          nx = dx / dist
          ny = dy / dist
          nz = dz / dist
        }
        const overlap = contact - dist

        const wa = chars[a.characterIdx].weight
        const wb = chars[b.characterIdx].weight
        const total = wa + wb

        // Each kart yields in proportion to the OTHER kart's weight, so the two
        // shares sum to the whole overlap and the weight-weighted centroid of the
        // pair is unchanged.
        const sepA = overlap * (wb / total)
        const sepB = overlap * (wa / total)
        const oa = pa * 3
        const ob = pb * 3
        DP[oa] -= nx * sepA
        DP[oa + 1] -= ny * sepA
        DP[oa + 2] -= nz * sepA
        DP[ob] += nx * sepB
        DP[ob + 1] += ny * sepB
        DP[ob + 2] += nz * sepB

        if (!first) continue

        const rvx = b.velocity.x - a.velocity.x
        const rvy = b.velocity.y - a.velocity.y
        const rvz = b.velocity.z - a.velocity.z
        const vn = rvx * nx + rvy * ny + rvz * nz
        if (vn >= 0) continue // already separating

        const invA = 1 / wa
        const invB = 1 / wb
        const imp = -restitution * vn / (invA + invB)
        const ja = imp * invA
        const jb = imp * invB
        DV[oa] -= nx * ja
        DV[oa + 1] -= ny * ja
        DV[oa + 2] -= nz * ja
        DV[ob] += nx * jb
        DV[ob + 1] += ny * jb
        DV[ob + 2] += nz * jb
      }
    }

    for (let p = 0; p < MAX_KARTS; p++) {
      const i = SLOT[p]
      if (i < 0) continue
      const k = state.karts[i]
      if (!collidable(k)) continue
      const o = p * 3
      k.position.x += DP[o]
      k.position.y += DP[o + 1]
      k.position.z += DP[o + 2]
      if (first) {
        k.velocity.x += DV[o]
        k.velocity.y += DV[o + 1]
        k.velocity.z += DV[o + 2]
      }
    }
  }
}

/** A kart being teleported by `updateRecovery` (Task 9) takes no part in collision. */
function collidable(k: KartState): boolean {
  return k.respawnTicks === 0
}
```

- [ ] **Step 12: Run test to verify it passes**

Run: `npx vitest run packages/sim/test/collision.test.ts -t "kart collision order independence"`
Expected: PASS — 5 tests.

---

- [ ] **Step 13: Verify the whole module**

Run: `npx vitest run packages/sim/test/collision.test.ts`
Expected: PASS — 20 tests across 3 describe blocks. In particular the impulse and
separation numbers from Steps 1 and 5 must be unchanged by the rewrite: for a single
pair, a Jacobi pass and an apply-as-you-go pass compute the same thing.

Run: `npx tsc --noEmit -p packages/sim`
Expected: no output, exit code 0.

Nothing calls `resolveKartCollisions` yet. Steps 14–17 add the one call site, which
is what makes karts solid to each other in the live sim rather than only in this
test file.

---

- [ ] **Step 14: Write the failing test — `step()` resolves collisions once per tick**

Append this block to the end of `packages/sim/test/step.test.ts`. That file already
imports the type `SimState` and the values `createState`, `step`, `EIGHT_STARTS` and
`makeTestContext` — no import changes are needed.

```typescript
describe('step — kart collisions after the per-kart loop', () => {
  /**
   * Two karts abreast at the same `s`, one metre apart across the track, with the
   * other six parked far away so they cannot join in. Same `s` matters: the flat
   * query's groundHeight depends only on `s`, so both karts sit at the same height
   * and neither is airborne, and the contact normal is exactly (0, 0, 1).
   * Contact distance is 2 * tuning.kartRadius = 1.8, so 1.0 apart is overlapping.
   */
  function abreastPair(state: SimState): void {
    state.karts[0].position.x = 0
    state.karts[0].position.y = 0
    state.karts[0].position.z = 0
    state.karts[1].position.x = 0
    state.karts[1].position.y = 0
    state.karts[1].position.z = 1
    for (let i = 2; i < state.karts.length; i++) {
      state.karts[i].position.x = 1000 + i * 100
      state.karts[i].position.y = 0
      state.karts[i].position.z = 0
    }
  }

  it('pushes two overlapping karts apart to exactly 2 * kartRadius', () => {
    const ctx = makeTestContext(EIGHT_STARTS)
    const prev = createState(ctx, 7, [0, 0, 0, 0, 0, 0, 0, 0])
    const next = createState(ctx, 7, [0, 0, 0, 0, 0, 0, 0, 0])
    abreastPair(prev)

    step(ctx, prev, next, [], [])

    // Both karts are at rest with no intent, so every per-kart stage is a no-op and
    // resolveKartCollisions is the only thing that can move them. Equal weights
    // (both character 0, weight 1.00), so each yields half of the overlap
    // 1.8 - 1.0 = 0.8 along the +z normal:
    //   kart 0: 0 - 0.4 = -0.4 ; kart 1: 1 + 0.4 = 1.4
    expect(next.karts[0].position.z).toBeCloseTo(-0.4, 12)
    expect(next.karts[1].position.z).toBeCloseTo(1.4, 12)
    expect(next.karts[0].position.x).toBeCloseTo(0, 12)
    expect(next.karts[1].position.x).toBeCloseTo(0, 12)
    // neither kart was closing on the other, so no impulse was applied
    expect(next.karts[0].velocity.z).toBe(0)
    expect(next.karts[1].velocity.z).toBe(0)
    // prev is never written
    expect(prev.karts[0].position.z).toBe(0)
    expect(prev.karts[1].position.z).toBe(1)
  })

  it('applies the impulse to the velocities the per-kart loop just wrote', () => {
    const ctx = makeTestContext(EIGHT_STARTS)
    const prev = createState(ctx, 7, [0, 0, 0, 0, 0, 0, 0, 0])
    const next = createState(ctx, 7, [0, 0, 0, 0, 0, 0, 0, 0])
    abreastPair(prev)
    prev.karts[0].velocity.z = 10  // closing on kart 1
    prev.karts[1].velocity.z = -10 // closing on kart 0

    step(ctx, prev, next, [], [])

    // Stage 4 (stepKart) runs first and damps the lateral component: heading is 0,
    // so right = (0, 0, 1) and the whole velocity is lateral, vf = 0.
    //   damp  = clamp(gripTarmac * TICK_DT, 0, 1) = 14 / 60 = 0.23333333333333334
    //   v0.z  =  10 * (1 - 0.23333333333333334) =  7.666666666666666
    //   v1.z  = -10 * (1 - 0.23333333333333334) = -7.666666666666666
    // then it integrates position with the post-damp velocity:
    //   z0 = 0 + 7.666666666666666 / 60 = 0.12777777777777777
    //   z1 = 1 - 7.666666666666666 / 60 = 0.8722222222222222
    // Then resolveKartCollisions, normal (0, 0, 1), gap 0.7444444444444445:
    //   overlap = 1.8 - 0.7444444444444445 = 1.0555555555555554, split 50/50
    //   z0 = 0.12777777777777777 - 0.5277777777777777 = -0.4
    //   z1 = 0.8722222222222222  + 0.5277777777777777 =  1.4
    //   (equivalently: the pair's centroid stays at 0.5 and the gap becomes 1.8)
    //   vn = -7.666666666666666 - 7.666666666666666 = -15.333333333333332
    //   j  = -(1 + 0.4) * (-15.333333333333332) / (1/1 + 1/1) = 10.733333333333333
    //   v0.z =  7.666666666666666 - 10.733333333333333 = -3.066666666666667
    //   v1.z = -7.666666666666666 + 10.733333333333333 =  3.066666666666667
    expect(next.karts[0].position.z).toBeCloseTo(-0.4, 9)
    expect(next.karts[1].position.z).toBeCloseTo(1.4, 9)
    expect(next.karts[1].position.z - next.karts[0].position.z).toBeCloseTo(1.8, 9)
    expect(next.karts[0].velocity.z).toBeCloseTo(-3.066666666666667, 9)
    expect(next.karts[1].velocity.z).toBeCloseTo(3.066666666666667, 9)
    // separating speed is restitution * closing speed: 0.4 * 15.333333333333332
    expect(next.karts[1].velocity.z - next.karts[0].velocity.z)
      .toBeCloseTo(6.133333333333333, 9)
  })
})
```

- [ ] **Step 15: Run test to verify it fails**

Run: `npx vitest run packages/sim/test/step.test.ts -t "kart collisions after the per-kart loop"`

Expected: FAIL — both tests.
"pushes two overlapping karts apart" reports `expected 0 to be close to -0.4`:
`step()` never calls `resolveKartCollisions`, so the karts pass through each other.
"applies the impulse" reports `expected 0.12777777777777777 to be close to -0.4` —
the kart loop moved it, the collision pass did not.

- [ ] **Step 16: Wire `resolveKartCollisions` into `step()`**

Two edits in `packages/sim/src/step.ts`.

**Edit 1 — the import.** Before:

```typescript
import { stepKart } from './kart'
```

After:

```typescript
import { stepKart } from './kart'
import { resolveKartCollisions } from './collision'
```

**Edit 2 — the call, once per tick, after the per-kart loop closes.** `decayBoost(k)`
is the last statement of the loop body (Task 8 put it there, canonical slot 8) and is
the only occurrence of that call in the file. Before:

```typescript
    decayBoost(k)
  }
}
```

After:

```typescript
    decayBoost(k)
  }

  // Once per tick, after every kart has moved: contact resolution reads the final
  // positions of all eight karts, so it cannot run inside the loop. Contract order
  // from here on is resolveKartCollisions -> updateEntities [Task 12] ->
  // updateItemBoxes [Task 13] -> updatePhase [Task 15].
  resolveKartCollisions(ctx, next)
}
```

- [ ] **Step 17: Run test to verify it passes, then the whole suite**

Run: `npx vitest run packages/sim/test/step.test.ts`

Expected: PASS — 10 tests: 3 from Task 5, 3 from Task 6, 2 from Task 9 and the 2
from Step 14. Tasks 5 and 6 place their karts on the `EIGHT_STARTS` grid, 4 m apart,
which is far outside the 1.8 contact distance, so none of their numbers moves.

Run: `npx vitest run packages/sim && npx tsc --noEmit -p packages/sim`

Expected: PASS — every `packages/sim` test green, `tsc` reports no errors.

- [ ] **Step 18: Commit**

```bash
git add packages/sim/src/collision.ts packages/sim/test/collision.test.ts \
        packages/sim/src/step.ts packages/sim/test/step.test.ts
git commit -m "feat(sim): order-independent kart-vs-kart collision

Sphere overlap at 2 * tuning.kartRadius with an equal-and-opposite impulse
scaled by the two characters' weight stats and tuning.kartRestitution, plus
weight-split positional separation that leaves no pair overlapped and preserves
the weighted centroid.

Pairs are visited by ascending playerId rather than array slot and each of the
four passes is Jacobi, so a kart's slot cannot influence any sign or any float
summation order. Tests assert a pair resolves bit-identically with the karts
swapped and with their playerIds swapped, and that a 3-kart pile-up is
bit-identical across all six slot permutations, singly and over 20 ticks.

step() now calls it once per tick, immediately after the per-kart loop, which is
where the contract's canonical order puts it and what makes karts solid to each
other in the live sim rather than only in the unit tests."
```

---

### Task 11: Lap validation and race placement

**Files:**
- Create: `packages/sim/src/laps.ts`
- Create: `packages/sim/src/placement.ts`
- Modify: `packages/sim/src/step.ts` — one import and one insertion, exact before/after in Step 11
- Test: `packages/sim/test/laps.test.ts`
- Test: `packages/sim/test/placement.test.ts`

**Interfaces:**

- Consumes (already exist, do not redefine):
  - `packages/sim/src/types.ts` — `Vec3`, `Surface`, `ItemKind`, `EntityKind`, `RacePhase`, `LapProgress`, `DriftState`, `KartState`, `EntityState`, `ItemBoxState`, `SimState`, `AuthEvent`, `AuthEventKind`, `Intent`, `Track`, `TrackPoint`, `TrackQuery`, `TrackProjection`, `Tuning`, `CharacterStats`, `SimContext`, and the constants `TICK_HZ = 60`, `TICK_DT = 1/60`, `MAX_KARTS = 8`, `MAX_ENTITIES = 32`, `RACE_LAPS = 3`, `COUNTDOWN_TICKS = 180`.
  - `packages/sim/src/mathutil.ts` — `export function clamp(v: number, lo: number, hi: number): number`
  - `packages/sim/src/state.ts` — `export function emit(state: SimState, out: AuthEvent[], kind: AuthEventKind, playerId: number, entityId: number, item: ItemKind, data: number): void`. It appends exactly one `AuthEvent` to `out` with `eventSeq = state.nextEventSeq++` and `tick = state.tick`.
  - `packages/sim/src/step.ts` [Task 5, extended by 6–10] — `export function step(ctx: SimContext, prev: SimState, next: SimState, inputs: Intent[], events: AuthEvent[]): void`. It clones `prev` into `next`, sets `next.tick = prev.tick + 1`, and runs a per-kart loop whose locals are `k` (`next.karts[i]`), `prevKart` (`prev.karts[i]`) and `raw` (that kart's intent). This task appends `updateLaps` as the **last** statement of that loop body, per the contract's canonical order.
  - `packages/sim/test/fixtures/track-fixtures.ts` — `export function makeTuning(overrides?: Partial<Tuning>): Tuning`, `export function makeCharacters(): CharacterStats[]`.
  - `ctx.query: TrackQuery` — `project(p: Vec3): TrackProjection` (`{ s, lateral, distance }`) and `checkpointIndexAt(s: number): number`. These are the only two query methods this task calls.
  - `createState(ctx, seed, characterIdx)` gives every kart `lap = { lap: 0, checkpointIdx: track.checkpointS.length - 1, t: 0 }`, because karts start *behind* the s = 0 start/finish line. `updateLaps` depends on that starting value: a kart that starts at `checkpointIdx = 0` would need four line crossings to finish a three-lap race. The local `blankKart` helper in `laps.test.ts` deliberately repeats that default (`checkpointIdx: 3` on this file's 4-checkpoint stub track) instead of importing `makeKart` from `test/helpers/flat-context.ts`, so this file's stub track and its checkpoint count stay owned by this file. `placement.test.ts`'s local helper uses `checkpointIdx: 0` because placement never reads a track at all — it only compares the stored triple.

- **`s` is arc-normalised.** The contract fixes `TrackQuery.project().s`, `Track.checkpointS[i]` and every `s` argument in this package as a value in `[0, 1)`, never metres. A lap distance in metres is only ever reached by multiplying an `s`-delta by `query.totalLength()`, and `updateLaps` never needs to: every quantity it computes is a ratio of `s`-deltas, so the lap length cancels out.

- Produces (later tasks rely on exactly these):
  - `packages/sim/src/laps.ts` — `export function updateLaps(ctx: SimContext, state: SimState, k: KartState, events: AuthEvent[]): void`
  - `packages/sim/src/placement.ts` — `export function placementOrder(state: SimState): number[]` (leader first, allocates) and `export function computePlacement(state: SimState, outIndexOf: Int32Array, outOrder: Int32Array): void` (zero-alloc; both arrays must be length `MAX_KARTS`; `outOrder[place] = playerId`, `outIndexOf[playerId] = place`).

- Rules fixed by this task, relied on by Tasks 12–15:
  - Checkpoint index **0 is the start/finish line**. A lap increments when, and only when, a kart enters checkpoint segment 0 from segment `N-1`.
  - `k.lap.t` is the fraction `[0, 1]` of the way from `checkpointS[checkpointIdx]` to the next checkpoint, and is only written while the kart is inside its own current segment. Off-segment excursions (backwards or shortcut) leave `t` frozen.
  - **`finishedOrder` is fixed length `MAX_KARTS`**, exactly as `createState` allocates it: finishers are written into the lowest slot still holding the `-1` sentinel, and the array is **never** `push`ed to or truncated. Growing it changes the state's shape, and `cloneState` throws `'cloneState: dst was not preallocated with the same shape as src'` the moment `prev` and `next` disagree — which would take out `recordRun`, `replayRun` and the golden run with it. The number of finishers is therefore *derived*: it is the count of entries `!== -1`, which for a front-packed array is the index of the first `-1`.
  - The **`finish` event's `data` is the 1-based finishing place** (first finisher `1`, second `2`, …), i.e. `slot + 1` for the slot just written. Task 15's DNF path emits the same 1-based place.
  - `finishedOrder` takes precedence over `(lap, checkpointIdx, t)` in placement.
  - Placement ties break on `playerId` ascending, so the order is total and deterministic.
  - Every `playerId` is in `[0, MAX_KARTS)` — it is a 3-bit wire field — so it can index an `Int32Array(MAX_KARTS)` directly.

---

- [ ] **Step 1: Write the failing test for lap validation**

Create `packages/sim/test/laps.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import type {
  AuthEvent, EntityState, KartState, SimContext, SimState, Track, TrackQuery,
} from '../src/types'
import { MAX_ENTITIES, MAX_KARTS, RACE_LAPS } from '../src/types'
import { makeCharacters, makeTuning } from './fixtures/track-fixtures'
import { updateLaps } from '../src/laps'

// A stub track: a 400 m loop whose arc-normalised parameter is simply the
// kart's x divided by the lap length, wrapped into [0, 1). The contract fixes
// `s` as arc-normalised everywhere in this package -- never metres -- so
// checkpointS holds 0 / 0.25 / 0.5 / 0.75 and every segment is a quarter lap
// (100 m of the 400 m loop). Checkpoint 0 is the start/finish line.
//
// project() follows the locked convention right = (-t.z, 0, t.x); for the +X
// tangent (1,0,0) that is (0,0,1), so lateral is +z.
//
// Every kart x below is a multiple of 12.5 m, which is exactly 1/32 of a lap,
// so every s is a dyadic rational and every t assertion in this file is exact
// in binary floating point rather than approximate.
const TRACK_LEN = 400

const wrap01 = (v: number): number => ((v % 1) + 1) % 1

function stubContext(): SimContext {
  const track: Track = {
    id: 'stub-loop',
    name: 'Stub Loop',
    controlPoints: [],
    checkpointS: [0, 0.25, 0.5, 0.75],
    itemBoxes: [],
    ramps: [],
    boostPads: [],
    startPositions: [],
    bounds: { min: { x: -1000, y: -10, z: -1000 }, max: { x: 1000, y: 10, z: 1000 } },
  }
  const query: TrackQuery = {
    sampleAt: (s) => ({
      position: { x: wrap01(s) * TRACK_LEN, y: 0, z: 0 },
      width: 20,
      banking: 0,
      surface: 'tarmac',
    }),
    tangentAt: () => ({ x: 1, y: 0, z: 0 }),
    project: (p) => ({ s: wrap01(p.x / TRACK_LEN), lateral: p.z, distance: Math.abs(p.z) }),
    groundHeight: () => 0,
    surfaceAt: () => 'tarmac',
    isInBounds: (_s, lateral) => Math.abs(lateral) <= 10,
    checkpointIndexAt: (s) => Math.min(3, Math.floor(wrap01(s) * 4)),
    totalLength: () => TRACK_LEN,
  }
  return { track, query, tuning: makeTuning(), characters: makeCharacters(), isLeader: true }
}

// checkpointIdx 3 is what createState [Task 5] gives every kart on a
// 4-checkpoint track: karts start behind the s = 0 line holding the last
// checkpoint, so the first crossing of the line is worth a lap.
function blankKart(playerId: number): KartState {
  return {
    playerId,
    characterIdx: 0,
    isBot: false,
    connected: true,
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
    lap: { lap: 0, checkpointIdx: 3, t: 0 },
  }
}

function blankEntity(): EntityState {
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

/** The empty finishedOrder: fixed length MAX_KARTS, every slot the -1 sentinel. */
function emptyFinishedOrder(): number[] {
  const order: number[] = []
  for (let i = 0; i < MAX_KARTS; i++) order.push(-1)
  return order
}

function blankState(): SimState {
  const karts: KartState[] = []
  for (let i = 0; i < MAX_KARTS; i++) karts.push(blankKart(i))
  const entities: EntityState[] = []
  for (let i = 0; i < MAX_ENTITIES; i++) entities.push(blankEntity())
  return {
    tick: 500,
    phase: 'racing',
    raceSeed: 12345,
    rngCursor: 0,
    nextEventSeq: 0,
    finishTick: -1,
    karts,
    entities,
    entityCount: 0,
    nextEntityId: 1,
    itemBoxes: [],
    finishedOrder: emptyFinishedOrder(),
  }
}

describe('updateLaps', () => {
  it('advances the checkpoint index when the next checkpoint is crossed in order', () => {
    const ctx = stubContext()
    const state = blankState()
    const k = state.karts[0]
    const events: AuthEvent[] = []
    k.lap.lap = 0
    k.lap.checkpointIdx = 0
    k.lap.t = 0.5
    k.position.x = 137.5 // s = 137.5 / 400 = 0.34375 -> segment 1, which starts at s = 0.25

    updateLaps(ctx, state, k, events)

    expect(k.lap.checkpointIdx).toBe(1)
    // t = (0.34375 - 0.25) / (0.5 - 0.25) = 0.09375 / 0.25 = 0.375
    expect(k.lap.t).toBe(0.375)
    expect(k.lap.lap).toBe(0)
    expect(events.length).toBe(0)
  })

  it('increments the lap when the finish line is crossed with every checkpoint hit', () => {
    const ctx = stubContext()
    const state = blankState()
    const k = state.karts[4]
    const events: AuthEvent[] = []
    k.lap.lap = 0
    k.lap.checkpointIdx = 3
    k.lap.t = 0.9
    k.position.x = 412.5 // 412.5 / 400 = 1.03125 -> wraps to s = 0.03125 -> segment 0

    updateLaps(ctx, state, k, events)

    expect(k.lap.checkpointIdx).toBe(0)
    expect(k.lap.lap).toBe(1)
    // t = (0.03125 - 0) / (0.25 - 0) = 0.125
    expect(k.lap.t).toBe(0.125)
    expect(events.length).toBe(1)
    expect(events[0].kind).toBe('lapCross')
    expect(events[0].playerId).toBe(4)
    expect(events[0].entityId).toBe(-1)
    expect(events[0].item).toBe('none')
    expect(events[0].data).toBe(1) // the new lap number
    expect(events[0].eventSeq).toBe(0)
    expect(events[0].tick).toBe(500)
    expect(state.nextEventSeq).toBe(1)
    // no finisher yet, so every fixed slot still holds the -1 sentinel
    expect(state.finishedOrder).toEqual([-1, -1, -1, -1, -1, -1, -1, -1])
    expect(state.finishTick).toBe(-1)
  })

  it('does not advance when a checkpoint is crossed backwards', () => {
    const ctx = stubContext()
    const state = blankState()
    const k = state.karts[1]
    const events: AuthEvent[] = []
    k.lap.lap = 1
    k.lap.checkpointIdx = 2
    k.lap.t = 0.05
    k.position.x = 187.5 // s = 0.46875 -> segment 1, i.e. BEHIND checkpoint 2

    updateLaps(ctx, state, k, events)

    expect(k.lap.checkpointIdx).toBe(2) // unchanged: 1 is neither 2 nor 3
    expect(k.lap.lap).toBe(1)
    expect(k.lap.t).toBe(0.05) // frozen while off-segment
    expect(events.length).toBe(0)

    // driving forward again into its own segment resumes t updates only
    k.position.x = 250 // s = 0.625 -> segment 2
    updateLaps(ctx, state, k, events)
    expect(k.lap.checkpointIdx).toBe(2)
    expect(k.lap.lap).toBe(1)
    // t = (0.625 - 0.5) / (0.75 - 0.5) = 0.125 / 0.25 = 0.5
    expect(k.lap.t).toBe(0.5)
    expect(events.length).toBe(0)
  })

  it('does not advance when a checkpoint is skipped', () => {
    const ctx = stubContext()
    const state = blankState()
    const k = state.karts[2]
    const events: AuthEvent[] = []
    k.lap.lap = 0
    k.lap.checkpointIdx = 0
    k.lap.t = 0.9
    k.position.x = 250 // s = 0.625 -> segment 2, skipping checkpoint 1

    updateLaps(ctx, state, k, events)

    expect(k.lap.checkpointIdx).toBe(0)
    expect(k.lap.t).toBe(0.9)
    expect(k.lap.lap).toBe(0)
    expect(events.length).toBe(0)
  })

  it('does not decrement the lap when the finish line is crossed backwards', () => {
    const ctx = stubContext()
    const state = blankState()
    const k = state.karts[3]
    const events: AuthEvent[] = []
    k.lap.lap = 2
    k.lap.checkpointIdx = 0
    k.lap.t = 0.02
    k.position.x = 375 // s = 0.9375 -> segment 3, i.e. back across the line

    updateLaps(ctx, state, k, events)

    expect(k.lap.lap).toBe(2)
    expect(k.lap.checkpointIdx).toBe(0)
    expect(k.lap.t).toBe(0.02)
    expect(events.length).toBe(0)

    // driving forward again lands back in segment 0, which the kart already
    // holds, so it only resumes t: no second lap for the same crossing
    k.position.x = 25 // s = 0.0625 -> segment 0
    updateLaps(ctx, state, k, events)
    expect(k.lap.lap).toBe(2)
    expect(k.lap.checkpointIdx).toBe(0)
    // t = (0.0625 - 0) / (0.25 - 0) = 0.25
    expect(k.lap.t).toBe(0.25)
    expect(events.length).toBe(0)
  })

  it('records the finish once at RACE_LAPS and never again', () => {
    const ctx = stubContext()
    const state = blankState()
    state.tick = 1234
    const k = state.karts[6]
    const events: AuthEvent[] = []
    k.lap.lap = RACE_LAPS - 1 // 2
    k.lap.checkpointIdx = 3
    k.lap.t = 0.8
    k.position.x = 412.5 // s = 0.03125 -> segment 0

    updateLaps(ctx, state, k, events)

    expect(k.lap.lap).toBe(3)
    // written into slot 0; the other seven slots keep the -1 sentinel
    expect(state.finishedOrder).toEqual([6, -1, -1, -1, -1, -1, -1, -1])
    expect(state.finishTick).toBe(1234)
    expect(events.length).toBe(2)
    expect(events[0].kind).toBe('lapCross')
    expect(events[0].data).toBe(3)
    expect(events[0].eventSeq).toBe(0)
    expect(events[1].kind).toBe('finish')
    expect(events[1].playerId).toBe(6)
    expect(events[1].entityId).toBe(-1)
    expect(events[1].item).toBe('none')
    expect(events[1].data).toBe(1) // 1-based finishing place: slot 0 + 1
    expect(events[1].eventSeq).toBe(1)
    expect(events[1].tick).toBe(1234)

    // a fourth line crossing still counts the lap but must not re-finish
    state.tick = 1600
    k.lap.checkpointIdx = 3
    k.position.x = 812.5 // 812.5 / 400 = 2.03125 -> wraps to s = 0.03125 -> segment 0
    updateLaps(ctx, state, k, events)

    expect(k.lap.lap).toBe(4)
    expect(state.finishedOrder).toEqual([6, -1, -1, -1, -1, -1, -1, -1])
    expect(state.finishTick).toBe(1234)
    expect(events.length).toBe(3)
    expect(events[2].kind).toBe('lapCross')
    expect(events[2].data).toBe(4)
  })

  it('sets finishTick from the first finisher only and keeps finishedOrder in crossing order', () => {
    const ctx = stubContext()
    const state = blankState()
    const events: AuthEvent[] = []

    const a = state.karts[5]
    a.lap.lap = 2
    a.lap.checkpointIdx = 3
    a.position.x = 412.5 // s = 0.03125 -> segment 0
    state.tick = 900
    updateLaps(ctx, state, a, events)

    const b = state.karts[2]
    b.lap.lap = 2
    b.lap.checkpointIdx = 3
    b.position.x = 425 // 425 / 400 = 1.0625 -> wraps to s = 0.0625 -> segment 0
    state.tick = 950
    updateLaps(ctx, state, b, events)

    // slots fill front to back; the six unused slots keep the -1 sentinel
    expect(state.finishedOrder).toEqual([5, 2, -1, -1, -1, -1, -1, -1])
    expect(state.finishTick).toBe(900)
    // 2 events per finisher: lapCross then finish
    expect(events.length).toBe(4)
    expect(events[1].kind).toBe('finish')
    expect(events[1].playerId).toBe(5)
    expect(events[1].data).toBe(1)
    expect(events[3].kind).toBe('finish')
    expect(events[3].playerId).toBe(2)
    expect(events[3].data).toBe(2) // second place: slot 1 + 1
    expect(events[3].tick).toBe(950)
  })
})
```

- [ ] **Step 2: Run the lap test to verify it fails**

Run: `npx vitest run packages/sim/test/laps.test.ts`
Expected: FAIL with `Failed to resolve import "../src/laps" from "packages/sim/test/laps.test.ts"`.

- [ ] **Step 3: Implement `packages/sim/src/laps.ts`**

Create `packages/sim/src/laps.ts`:

```ts
import type { AuthEvent, KartState, SimContext, SimState } from './types'
import { RACE_LAPS } from './types'
import { clamp } from './mathutil'
import { emit } from './state'

/**
 * Fraction [0,1] of the way from checkpoint `idx` to the next checkpoint, for a
 * kart at arc-normalised `s`. Every `s` in this package is in [0, 1) and never
 * metres, so the segment that wraps past the start/finish line ends at
 * `checkpointS[0] + 1` -- one whole lap on -- and a negative delta is corrected
 * by adding a whole lap, not a track length. The lap length never appears here:
 * `t` is a ratio of two s-deltas, so it cancels out.
 */
function segmentT(ctx: SimContext, idx: number, s: number): number {
  const cps = ctx.track.checkpointS
  const n = cps.length
  const start = cps[idx]
  const end = idx + 1 < n ? cps[idx + 1] : cps[0] + 1
  const span = end - start
  if (span <= 0) return 0
  let ds = s - start
  if (ds < 0) ds += 1
  return clamp(ds / span, 0, 1)
}

/** True when `playerId` already holds one of the fixed finish slots. */
function hasFinished(state: SimState, playerId: number): boolean {
  const order = state.finishedOrder
  for (let i = 0; i < order.length; i++) {
    if (order[i] === playerId) return true
  }
  return false
}

/**
 * The lowest slot still holding the -1 sentinel, or -1 when all MAX_KARTS slots
 * are taken. `finishedOrder` is fixed length and is never pushed to: growing it
 * changes the state's shape, and cloneState throws the moment `prev` and `next`
 * disagree. Because slots fill front to back, this index is also the count of
 * entries that are already !== -1, i.e. the 0-based finishing place.
 */
function nextFinishSlot(state: SimState): number {
  const order = state.finishedOrder
  for (let i = 0; i < order.length; i++) {
    if (order[i] === -1) return i
  }
  return -1
}

/**
 * Checkpoint ring validation. Checkpoint 0 is the start/finish line.
 * A kart is credited only for entering the segment immediately after the one
 * it currently holds; driving backwards over a checkpoint, or skipping one,
 * changes nothing. Crossing into segment 0 from segment N-1 completes a lap.
 */
export function updateLaps(
  ctx: SimContext,
  state: SimState,
  k: KartState,
  events: AuthEvent[],
): void {
  const n = ctx.track.checkpointS.length
  if (n < 2) return

  const s = ctx.query.project(k.position).s
  const idx = ctx.query.checkpointIndexAt(s)
  const cur = k.lap.checkpointIdx
  const next = cur + 1 >= n ? 0 : cur + 1

  if (idx === cur) {
    k.lap.t = segmentT(ctx, cur, s)
    return
  }
  // Backwards over a checkpoint, or a skipped checkpoint: no credit, and t
  // stays frozen at whatever it was when the kart left its own segment.
  if (idx !== next) return

  k.lap.checkpointIdx = idx
  k.lap.t = segmentT(ctx, idx, s)
  if (idx !== 0) return // an ordinary checkpoint, not the finish line

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

- [ ] **Step 4: Run the lap test to verify it passes**

Run: `npx vitest run packages/sim/test/laps.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Write the failing test for race placement**

Create `packages/sim/test/placement.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import type { EntityState, KartState, SimState } from '../src/types'
import { MAX_ENTITIES, MAX_KARTS } from '../src/types'
import { computePlacement, placementOrder } from '../src/placement'

// checkpointIdx 0 here is arbitrary: placement never consults a track, only the
// stored (lap, checkpointIdx, t) triple, and every test below overwrites it.
function blankKart(playerId: number): KartState {
  return {
    playerId,
    characterIdx: 0,
    isBot: false,
    connected: true,
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

function blankEntity(): EntityState {
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

/** The empty finishedOrder: fixed length MAX_KARTS, every slot the -1 sentinel. */
function emptyFinishedOrder(): number[] {
  const order: number[] = []
  for (let i = 0; i < MAX_KARTS; i++) order.push(-1)
  return order
}

function blankState(): SimState {
  const karts: KartState[] = []
  for (let i = 0; i < MAX_KARTS; i++) karts.push(blankKart(i))
  const entities: EntityState[] = []
  for (let i = 0; i < MAX_ENTITIES; i++) entities.push(blankEntity())
  return {
    tick: 0,
    phase: 'racing',
    raceSeed: 7,
    rngCursor: 0,
    nextEventSeq: 0,
    finishTick: -1,
    karts,
    entities,
    entityCount: 0,
    nextEntityId: 1,
    itemBoxes: [],
    finishedOrder: emptyFinishedOrder(),
  }
}

function setLap(state: SimState, playerId: number, lap: number, cp: number, t: number): void {
  const k = state.karts[playerId]
  k.lap.lap = lap
  k.lap.checkpointIdx = cp
  k.lap.t = t
}

/**
 * Record finishers the way updateLaps does: into the fixed slots, front to
 * back, never by pushing. `pids` is the crossing order.
 */
function setFinished(state: SimState, pids: number[]): void {
  for (let i = 0; i < pids.length; i++) state.finishedOrder[i] = pids[i]
}

// Grid used by every test below (checkpoint indices are from an 8-checkpoint
// track; placement never consults the track, only the stored triple):
//   p0 (2, 5, 0.90)   p1 (2, 5, 0.10)   p2 (3, 0, 0.00)   p3 (1, 7, 0.50)
//   p4 (2, 6, 0.20)   p5 (3, 0, 0.10)   p6 (0, 0, 0.00)   p7 (2, 5, 0.90)
function gridState(): SimState {
  const state = blankState()
  setLap(state, 0, 2, 5, 0.9)
  setLap(state, 1, 2, 5, 0.1)
  setLap(state, 2, 3, 0, 0.0)
  setLap(state, 3, 1, 7, 0.5)
  setLap(state, 4, 2, 6, 0.2)
  setLap(state, 5, 3, 0, 0.1)
  setLap(state, 6, 0, 0, 0.0)
  setLap(state, 7, 2, 5, 0.9)
  return state
}

describe('placementOrder', () => {
  it('sorts leader first by (lap, checkpointIdx, t) descending with playerId breaking ties', () => {
    const state = gridState()

    // lap 3: p5 (t 0.10) ahead of p2 (t 0.00)
    // lap 2: p4 (cp 6) ahead of cp 5, where p0 and p7 tie at t 0.90 and p0
    //        wins on the lower playerId, then p1 at t 0.10
    // lap 1: p3.  lap 0: p6.
    expect(placementOrder(state)).toEqual([5, 2, 4, 0, 7, 1, 3, 6])
  })

  it('gives finishedOrder precedence over lap progress', () => {
    const state = gridState()
    setFinished(state, [2, 5])
    expect(state.finishedOrder).toEqual([2, 5, -1, -1, -1, -1, -1, -1])

    // p2 crossed the line first even though p5 has the larger t, so p2 is P1.
    // The six -1 slots are not karts and must not rank anything.
    expect(placementOrder(state)).toEqual([2, 5, 4, 0, 7, 1, 3, 6])
  })
})

describe('computePlacement', () => {
  it('fills outOrder and outIndexOf as exact inverses with no finishers', () => {
    const state = gridState()
    const indexOf = new Int32Array(MAX_KARTS)
    const order = new Int32Array(MAX_KARTS)

    computePlacement(state, indexOf, order)

    expect(Array.from(order)).toEqual([5, 2, 4, 0, 7, 1, 3, 6])
    // place of p0..p7: p0->3 p1->5 p2->1 p3->6 p4->2 p5->0 p6->7 p7->4
    expect(Array.from(indexOf)).toEqual([3, 5, 1, 6, 2, 0, 7, 4])
    for (let place = 0; place < MAX_KARTS; place++) {
      expect(indexOf[order[place]]).toBe(place)
    }
  })

  it('fills outOrder and outIndexOf with finishedOrder taking precedence', () => {
    const state = gridState()
    setFinished(state, [2, 5])
    const indexOf = new Int32Array(MAX_KARTS)
    const order = new Int32Array(MAX_KARTS)

    computePlacement(state, indexOf, order)

    expect(Array.from(order)).toEqual([2, 5, 4, 0, 7, 1, 3, 6])
    // place of p0..p7: p0->3 p1->5 p2->0 p3->6 p4->2 p5->1 p6->7 p7->4
    expect(Array.from(indexOf)).toEqual([3, 5, 0, 6, 2, 1, 7, 4])
  })

  it('agrees with placementOrder in every case, and allocates nothing on repeat calls', () => {
    const indexOf = new Int32Array(MAX_KARTS)
    const order = new Int32Array(MAX_KARTS)

    const plain = gridState()
    computePlacement(plain, indexOf, order)
    expect(Array.from(order)).toEqual(placementOrder(plain))

    const finished = gridState()
    setFinished(finished, [2, 5])
    computePlacement(finished, indexOf, order)
    expect(Array.from(order)).toEqual(placementOrder(finished))

    // all eight finished, in a deliberately non-progress order: every slot is
    // taken, so no -1 is left
    const allDone = gridState()
    const crossing = [7, 3, 0, 6, 1, 4, 2, 5]
    setFinished(allDone, crossing)
    expect(allDone.finishedOrder).toEqual(crossing)
    computePlacement(allDone, indexOf, order)
    expect(Array.from(order)).toEqual(crossing)
    expect(Array.from(order)).toEqual(placementOrder(allDone))
    expect(Array.from(indexOf)).toEqual([2, 4, 6, 1, 5, 7, 3, 0])

    // reusing the same out-arrays must overwrite completely, not merge
    computePlacement(plain, indexOf, order)
    expect(Array.from(order)).toEqual([5, 2, 4, 0, 7, 1, 3, 6])
    expect(Array.from(indexOf)).toEqual([3, 5, 1, 6, 2, 0, 7, 4])
  })
})
```

- [ ] **Step 6: Run the placement test to verify it fails**

Run: `npx vitest run packages/sim/test/placement.test.ts`
Expected: FAIL with `Failed to resolve import "../src/placement" from "packages/sim/test/placement.test.ts"`.

- [ ] **Step 7: Implement `packages/sim/src/placement.ts`**

Create `packages/sim/src/placement.ts`:

```ts
import type { KartState, SimState } from './types'
import { MAX_KARTS } from './types'

// Module-level scratch: placement runs every tick, so it must not allocate.
// playerId is a 3-bit wire field, so it always indexes safely into these.
const finishRank = new Int32Array(MAX_KARTS)
const slotOrder = new Int32Array(MAX_KARTS)

/**
 * `state.finishedOrder` is fixed length MAX_KARTS with -1 in every slot that has
 * no finisher yet, so the `pid >= 0` guard is what skips the empty slots.
 */
function fillFinishRank(state: SimState): void {
  for (let i = 0; i < MAX_KARTS; i++) finishRank[i] = -1
  const order = state.finishedOrder
  for (let i = 0; i < order.length; i++) {
    const pid = order[i]
    if (pid >= 0 && pid < MAX_KARTS) finishRank[pid] = i
  }
}

/**
 * Negative when `a` is ahead of `b`. Reads `finishRank`, so `fillFinishRank`
 * must run first. A finisher always outranks a non-finisher; among finishers
 * the crossing order wins; otherwise (lap, checkpointIdx, t) descending, with
 * playerId ascending as the tie-break that makes the order total.
 */
function comparePlacement(a: KartState, b: KartState): number {
  const ra = finishRank[a.playerId]
  const rb = finishRank[b.playerId]
  if (ra >= 0 || rb >= 0) {
    if (ra >= 0 && rb >= 0) return ra - rb
    return ra >= 0 ? -1 : 1
  }
  if (a.lap.lap !== b.lap.lap) return b.lap.lap - a.lap.lap
  if (a.lap.checkpointIdx !== b.lap.checkpointIdx) {
    return b.lap.checkpointIdx - a.lap.checkpointIdx
  }
  if (a.lap.t !== b.lap.t) return a.lap.t < b.lap.t ? 1 : -1
  return a.playerId - b.playerId
}

/**
 * Zero-alloc placement. `outOrder[place] = playerId` (leader at place 0),
 * `outIndexOf[playerId] = place`. Both arrays must be length MAX_KARTS.
 * Insertion sort over 8 karts: no allocation, no comparator closure.
 */
export function computePlacement(
  state: SimState,
  outIndexOf: Int32Array,
  outOrder: Int32Array,
): void {
  fillFinishRank(state)
  const karts = state.karts
  for (let i = 0; i < MAX_KARTS; i++) {
    let j = i - 1
    while (j >= 0 && comparePlacement(karts[slotOrder[j]], karts[i]) > 0) {
      slotOrder[j + 1] = slotOrder[j]
      j--
    }
    slotOrder[j + 1] = i
  }
  for (let place = 0; place < MAX_KARTS; place++) {
    const pid = karts[slotOrder[place]].playerId
    outOrder[place] = pid
    outIndexOf[pid] = place
  }
}

/**
 * Allocating convenience form of the same ordering, leader first. Not for the
 * hot path — use computePlacement there.
 */
export function placementOrder(state: SimState): number[] {
  fillFinishRank(state)
  const karts = state.karts
  const slots: number[] = []
  for (let i = 0; i < MAX_KARTS; i++) slots.push(i)
  slots.sort((a, b) => comparePlacement(karts[a], karts[b]))
  const out: number[] = []
  for (let i = 0; i < slots.length; i++) out.push(karts[slots[i]].playerId)
  return out
}
```

- [ ] **Step 8: Run the placement test to verify it passes**

Run: `npx vitest run packages/sim/test/placement.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 9: Write the failing test for the `step()` wiring**

`updateLaps` is slot 9 of the contract's canonical per-kart order — the last
per-kart call — and nothing calls it yet. Two edits to
`packages/sim/test/laps.test.ts`.

**9a.** Change the type-only import at the top of the file. Before:

```ts
import type {
  AuthEvent, EntityState, KartState, SimContext, SimState, Track, TrackQuery,
} from '../src/types'
```

After:

```ts
import type {
  AuthEvent, EntityState, Intent, KartState, SimContext, SimState, Track, TrackQuery,
} from '../src/types'
```

**9b.** Change the last import line. Before:

```ts
import { updateLaps } from '../src/laps'
```

After:

```ts
import { updateLaps } from '../src/laps'
import { step } from '../src/step'
```

**9c.** Append this suite to the end of the file:

```ts
describe('step() wiring', () => {
  it('runs updateLaps for every kart as the last per-kart stage', () => {
    const ctx = stubContext()
    const prev = blankState()
    const next = blankState()
    prev.tick = 700
    prev.phase = 'racing'

    // Kart 0 sits just past the start/finish line still holding the last
    // checkpoint, so updateLaps owes it a lap: x = 412.5 -> s = 0.03125,
    // which is checkpoint segment 0.
    prev.karts[0].position.x = 412.5
    prev.karts[0].lap.lap = 0
    prev.karts[0].lap.checkpointIdx = 3
    // Everyone else is spaced 20 m apart (far past kartRadius 0.9, so
    // resolveKartCollisions never fires) and holds checkpoint 1. They sit in
    // segments 0 and 1, neither of which is checkpoint 2, so none of them is
    // credited anything and none of them emits.
    for (let i = 1; i < MAX_KARTS; i++) {
      prev.karts[i].position.x = 412.5 + 20 * i
      prev.karts[i].lap.checkpointIdx = 1
    }

    const inputs: Intent[] = []
    for (let i = 0; i < MAX_KARTS; i++) {
      inputs.push({
        tick: 700, steer: 0, accel: 0, brake: false, drift: false, useItem: false,
      })
    }
    const events: AuthEvent[] = []

    step(ctx, prev, next, inputs, events)

    expect(next.tick).toBe(701)
    expect(next.karts[0].lap.checkpointIdx).toBe(0)
    expect(next.karts[0].lap.lap).toBe(1)
    // Every kart is at rest with accel 0, so stepKart moves nobody and the
    // lap arithmetic is the same as the direct call above:
    // t = (0.03125 - 0) / (0.25 - 0) = 0.125
    expect(next.karts[0].lap.t).toBe(0.125)

    expect(events.length).toBe(1)
    expect(events[0].kind).toBe('lapCross')
    expect(events[0].playerId).toBe(0)
    expect(events[0].data).toBe(1)
    // updateLaps runs against `next`, whose tick is already prev.tick + 1
    expect(events[0].tick).toBe(701)

    // step never mutates prev
    expect(prev.karts[0].lap.lap).toBe(0)
    expect(prev.karts[0].lap.checkpointIdx).toBe(3)
    expect(prev.tick).toBe(700)
  })
})
```

- [ ] **Step 10: Run the wiring test to verify it fails**

Run: `npx vitest run packages/sim/test/laps.test.ts -t "step() wiring"`
Expected: FAIL with `expected 3 to be 0` — `step()` does not call `updateLaps`, so
kart 0's `checkpointIdx` is still the 3 it was cloned with.

- [ ] **Step 11: Wire `updateLaps` into `step()`**

Two edits in `packages/sim/src/step.ts`.

**11a.** Add the import. Before (the `./kart` import Task 6 added):

```ts
import { stepKart } from './kart'
```

After:

```ts
import { stepKart } from './kart'
import { updateLaps } from './laps'
```

**11b.** Append the call to the per-kart loop body. `decayBoost(k)` is the last
statement of that body and the file's only call to `decayBoost` (Task 8 put it
there as canonical slot 8). Before:

```ts
    decayBoost(k)
```

After:

```ts
    decayBoost(k)
    updateLaps(ctx, next, k, events)
```

`updateLaps` must stay last in the loop body: it reads the position the kart
finished the tick at, so anything that still moves the kart — steering, the
integrator, ramps — has to have run already. `events` is a live parameter here;
Task 9's `updateRecovery` wiring already deleted the `void events` line Task 5
left behind.

- [ ] **Step 12: Run the wiring test to verify it passes**

Run: `npx vitest run packages/sim/test/laps.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 13: Typecheck and run the whole sim suite**

Run: `npx tsc --noEmit -p packages/sim && npx vitest run packages/sim`
Expected: no TypeScript output, and every existing sim test still passes alongside the 13 new ones.

- [ ] **Step 14: Commit**

```bash
git add packages/sim/src/laps.ts packages/sim/src/placement.ts packages/sim/src/step.ts \
        packages/sim/test/laps.test.ts packages/sim/test/placement.test.ts
git commit -m "feat(sim): checkpoint-ordered lap validation and race placement

updateLaps credits only the next checkpoint in the ring, so driving
backwards over a checkpoint or skipping one earns nothing. Crossing
checkpoint 0 from the last segment completes a lap; the RACE_LAPS-th
crossing writes the finisher into the lowest free slot of the
fixed-length finishedOrder, sets finishTick once, and emits lapCross
plus finish, whose data is the 1-based finishing place.

step() now calls updateLaps as the last per-kart stage, canonical
slot 9.

placementOrder / computePlacement sort leader-first by (lap,
checkpointIdx, t) descending with finishedOrder taking precedence and
playerId breaking ties. computePlacement is the zero-alloc out-param
form used per tick."
```

---

### Task 12: World entity pool, per-kind entity update, and entity/kart collision

**Files:**
- Create: `packages/sim/src/entity.ts`
- Modify: `packages/sim/src/kart.ts` — two edits: add the `surgeActiveOn` import, and replace the body of Task 6's staged `surgeFactorFor` helper (the call site in `targetSpeedFor` is untouched); exact before/after in Step 19
- Modify: `packages/sim/src/step.ts` — one import and one insertion; exact before/after in Step 23
- Test: `packages/sim/test/entity.test.ts`

**Interfaces:**

- Consumes (already exist, do not redefine):
  - `packages/sim/src/types.ts` — `Vec3`, `Surface`, `ItemKind`, `EntityKind` (`'seeker' | 'bolt' | 'slick' | 'bubble' | 'surge' | 'charge'`), `Intent`, `KartState`, `EntityState` (`{ entityId, kind, ownerId, position, velocity, heading, targetId, ttl }`), `SimState`, `AuthEvent`, `AuthEventKind`, `Track`, `TrackQuery`, `TrackPoint`, `TrackProjection`, `Tuning`, `SimContext`, and the constants `TICK_DT = 1/60`, `MAX_KARTS = 8`, `MAX_ENTITIES = 32`.
  - `packages/sim/src/mathutil.ts` — `export function clamp(v: number, lo: number, hi: number): number`, `export function wrapAngle(a: number): number` (result in `(-π, π]`).
  - `packages/sim/src/state.ts` — `export function emit(state: SimState, out: AuthEvent[], kind: AuthEventKind, playerId: number, entityId: number, item: ItemKind, data: number): void`. It appends exactly one `AuthEvent` with `eventSeq = state.nextEventSeq++` and `tick = state.tick`.
  - `packages/sim/src/placement.ts` [Task 11] — `export function computePlacement(state: SimState, outIndexOf: Int32Array, outOrder: Int32Array): void`. Both arrays are length `MAX_KARTS`; `outOrder[place] = playerId` with the leader at place 0, and `outIndexOf[playerId] = place`.
  - `packages/sim/src/recovery.ts` [Task 9] — `export function startSpinOut(state: SimState, k: KartState, ticks: number, events: AuthEvent[]): void`. **The contract's sole writer of `k.spinOutTicks`**: it arms the timer, clears the kart's drift and boost, and emits the one `'spinOut'` `AuthEvent` itself (`playerId` = the kart, `entityId` `-1`, `item` `'none'`, `data` = the ticks armed). It refuses outright while `invulnTicks > 0` or `respawnTicks > 0`, ignores a non-positive duration, and never shortens a spin-out already running. Nothing in this task assigns `spinOutTicks` directly.
  - `packages/sim/src/kart.ts` [Task 6] — `export function targetSpeedFor(ctx: SimContext, state: SimState, k: KartState, accel: number): number`, which composes `maxSpeed * character.speed * accel * surfaceFactor * surgeFactor * boostFactor` and gets its `surgeFactor` from a module-level, non-exported `surgeFactorFor(state, k, t)` that Task 6 also wrote. Task 6's body is real but deliberately **weaker** than the contract: it slows a kart whenever *any* live surge exists that the kart does not own. **This task replaces that body** with the contract's rule — a surge slows only the karts placed ahead of its caster — so the Surge item finally does the right thing. The call site does not change, and there is no `void state` line to remove: `state` has had a real reader since Task 6.
  - `packages/sim/src/step.ts` [Task 5, extended by 6–11] — `export function step(ctx: SimContext, prev: SimState, next: SimState, inputs: Intent[], events: AuthEvent[]): void`. After the per-kart loop it calls `resolveKartCollisions(ctx, next)`; this task inserts `updateEntities(ctx, next, events)` directly after it, which is the contract's canonical once-per-tick order `resolveKartCollisions → updateEntities → updateItemBoxes → updatePhase`.
  - `packages/sim/test/fixtures/track-fixtures.ts` — `export function makeTuning(overrides?: Partial<Tuning>): Tuning` (`kartRadius` 0.9, `spinOutTicks` 60, `surgeSpeedMul` 0.7, `seekerSpeed` 55, `boltSpeed` 65, `entityTtl` 600), `export function makeCharacters(): CharacterStats[]` (character 0 has `speed` 1.00).
  - `ctx.query: TrackQuery` — `project(p: Vec3): TrackProjection`, `sampleAt(s: number): TrackPoint`, `tangentAt(s: number): Vec3`. The contract fixes `TrackProjection.s` and every `s` argument as **arc-normalised `[0, 1)`**, never metres; this file's stub query obeys that, and `entity.ts` only ever feeds an `s` straight back into `sampleAt`/`tangentAt`, so no lap length appears in this task at all.
  - `createState(ctx, seed, characterIdx)` produces `entities` of length `MAX_ENTITIES` with `entityCount = 0` and `nextEntityId = 1`, every slot already in the canonical dead form described under **Pool** below, `karts` of length `MAX_KARTS` where `karts[i].playerId === i`, and `finishedOrder` of length `MAX_KARTS` with `-1` in every slot.

- Produces (later tasks rely on exactly these):
  - `export function spawnEntity(state: SimState, kind: EntityKind, ownerId: number, position: Vec3, heading: number, targetId: number, ttl: number, events: AuthEvent[]): number` — returns the new `entityId`, or `-1` when the pool is full. Copies `position` by value, wraps `heading`, zeroes `velocity`, emits `entitySpawn`.
  - `export function despawnEntityAt(state: SimState, idx: number, events: AuthEvent[]): void` — index into the packed live range, not an entityId. Emits `entityDespawn`, then swap-removes.
  - `export function kartById(state: SimState, playerId: number): KartState | null`
  - `export function updateEntities(ctx: SimContext, state: SimState, events: AuthEvent[]): void` — one call per tick, after the per-kart loop and `resolveKartCollisions`, wired into `step()` by this task.
  - `export function surgeActiveOn(state: SimState, playerId: number): boolean` — consumed by `kart.ts`'s `surgeFactorFor`, which is `targetSpeedFor`'s `tuning.surgeSpeedMul` gate; wired in by Step 19 of this task.

- Rules fixed by this task, relied on by Task 13 (`items.ts`) and Task 15:
  - **Pool.** Live entities are packed at `state.entities[0 .. entityCount-1]`. Despawn swaps the last live entity into the vacated index and clears the vacated slot to the canonical dead form: `entityId -1`, `kind 'seeker'`, `ownerId -1`, `targetId -1`, `heading 0`, `ttl 0`, `position` and `velocity` all zero. `entityId === -1` is the contract's dead sentinel; the rest of the canonical form exists so a slot's contents never depend on which entity last occupied it.
  - **Overflow.** At `entityCount === MAX_ENTITIES` a spawn is dropped: it returns `-1`, emits nothing, and does not advance `nextEntityId`. Existing entities are never evicted.
  - **Velocity is derived, not stored by the caller.** `spawnEntity` zeroes it; `updateEntities` rewrites it from `heading` and tuning every tick. Callers pass `heading`, not a velocity.
  - **Entities are planar.** `position.y` is whatever the spawner passed and is never integrated, except for a bubble, which copies its owner's `y`.
  - **Hit radii** live here, not in `Tuning`: seeker 1.6, bolt 1.4, slick 1.2, charge 6.0, bubble 0, surge 0. The test is `distance < radius + tuning.kartRadius`.
  - **Bubble and shield are one thing.** `k.shielded` is the truth; the bubble entity is its view. `updateEntities` despawns any live bubble whose owner is not `shielded`, so **Task 13's `useItem` must set `k.shielded = true` in the same tick it spawns the bubble**.
  - **A hit goes through `startSpinOut`.** The contract makes `startSpinOut` [Task 9] the sole writer of `k.spinOutTicks` and the sole emitter of `'spinOut'`; `updateEntities` calls it and writes neither field itself. Task 9's `updateRecovery` owns the countdown, the velocity kill and any follow-on invulnerability. `updateEntities` never writes `invulnTicks`.
  - **Surge slows karts ahead of its owner**, decided live from `computePlacement`, so it tracks positions changing while the field is up. It reaches the physics through `targetSpeedFor`'s surge factor and nowhere else.

---

- [ ] **Step 1: Write the failing test for the entity pool**

Create `packages/sim/test/entity.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import type {
  AuthEvent, EntityState, KartState, SimContext, SimState, Track, TrackQuery,
} from '../src/types'
import { MAX_ENTITIES, MAX_KARTS } from '../src/types'
import { makeCharacters, makeTuning } from './fixtures/track-fixtures'
import { despawnEntityAt, kartById, spawnEntity, updateEntities } from '../src/entity'

// A stub track: a 400 m loop, 20 m wide. The contract fixes `s` as
// arc-normalised [0, 1) everywhere in this package -- never metres -- so
// project() divides x by the lap length and wraps, checkpointS holds
// 0 / 0.25 / 0.5 / 0.75, and sampleAt() multiplies back out to place the
// centreline point. project() follows the locked convention
// right = (-t.z, 0, t.x); for the +X tangent (1,0,0) that is (0,0,1), so
// lateral is +z and the edges are z = +-10.
const TRACK_LEN = 400
const TRACK_WIDTH = 20

const wrap01 = (v: number): number => ((v % 1) + 1) % 1

function stubContext(): SimContext {
  const track: Track = {
    id: 'stub-loop',
    name: 'Stub Loop',
    controlPoints: [],
    checkpointS: [0, 0.25, 0.5, 0.75],
    itemBoxes: [],
    ramps: [],
    boostPads: [],
    startPositions: [],
    bounds: { min: { x: -1000, y: -10, z: -1000 }, max: { x: 2000, y: 10, z: 1000 } },
  }
  const query: TrackQuery = {
    sampleAt: (s) => ({
      position: { x: wrap01(s) * TRACK_LEN, y: 0, z: 0 },
      width: TRACK_WIDTH,
      banking: 0,
      surface: 'tarmac',
    }),
    tangentAt: () => ({ x: 1, y: 0, z: 0 }),
    project: (p) => ({ s: wrap01(p.x / TRACK_LEN), lateral: p.z, distance: Math.abs(p.z) }),
    groundHeight: () => 0,
    surfaceAt: () => 'tarmac',
    isInBounds: (_s, lateral) => Math.abs(lateral) <= TRACK_WIDTH * 0.5,
    checkpointIndexAt: (s) => Math.min(3, Math.floor(wrap01(s) * 4)),
    totalLength: () => TRACK_LEN,
  }
  return { track, query, tuning: makeTuning(), characters: makeCharacters(), isLeader: true }
}

// Blank karts are parked far down the track (x = 1000 + 10 * playerId) so that
// entity motion tests never trip a collision. Collision tests place karts
// explicitly.
function blankKart(playerId: number): KartState {
  return {
    playerId,
    characterIdx: 0,
    isBot: false,
    connected: true,
    position: { x: 1000 + 10 * playerId, y: 0, z: 0 },
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

function blankEntity(): EntityState {
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

/** The empty finishedOrder: fixed length MAX_KARTS, every slot the -1 sentinel. */
function emptyFinishedOrder(): number[] {
  const order: number[] = []
  for (let i = 0; i < MAX_KARTS; i++) order.push(-1)
  return order
}

function blankState(): SimState {
  const karts: KartState[] = []
  for (let i = 0; i < MAX_KARTS; i++) karts.push(blankKart(i))
  const entities: EntityState[] = []
  for (let i = 0; i < MAX_ENTITIES; i++) entities.push(blankEntity())
  return {
    tick: 100,
    phase: 'racing',
    raceSeed: 999,
    rngCursor: 0,
    nextEventSeq: 0,
    finishTick: -1,
    karts,
    entities,
    entityCount: 0,
    nextEntityId: 1,
    itemBoxes: [],
    finishedOrder: emptyFinishedOrder(),
  }
}

describe('spawnEntity', () => {
  it('appends at the front of the pool, copies the position, wraps the heading and emits entitySpawn', () => {
    const state = blankState()
    const events: AuthEvent[] = []
    const p = { x: 1, y: 0.5, z: 2 }

    // 7 rad wraps into (-PI, PI] as 7 - 2 * PI = 0.7168146928204138
    const id = spawnEntity(state, 'slick', 4, p, 7, -1, 600, events)

    expect(id).toBe(1)
    expect(state.nextEntityId).toBe(2)
    expect(state.entityCount).toBe(1)
    const e = state.entities[0]
    expect(e.entityId).toBe(1)
    expect(e.kind).toBe('slick')
    expect(e.ownerId).toBe(4)
    expect(e.position.x).toBe(1)
    expect(e.position.y).toBe(0.5)
    expect(e.position.z).toBe(2)
    expect(e.velocity.x).toBe(0)
    expect(e.velocity.y).toBe(0)
    expect(e.velocity.z).toBe(0)
    expect(e.heading).toBeCloseTo(0.7168146928204138, 12)
    expect(e.targetId).toBe(-1)
    expect(e.ttl).toBe(600)

    // the caller's Vec3 must not be aliased into the pool
    p.x = 99
    expect(state.entities[0].position.x).toBe(1)

    expect(events.length).toBe(1)
    expect(events[0].kind).toBe('entitySpawn')
    expect(events[0].playerId).toBe(4)
    expect(events[0].entityId).toBe(1)
    expect(events[0].item).toBe('slick')
    expect(events[0].data).toBe(600) // ttl
    expect(events[0].eventSeq).toBe(0)
    expect(events[0].tick).toBe(100)
  })

  it('drops the spawn and emits nothing when the pool is full', () => {
    const state = blankState()
    const events: AuthEvent[] = []
    for (let i = 0; i < MAX_ENTITIES; i++) {
      const id = spawnEntity(state, 'bolt', 0, { x: i, y: 0, z: 0 }, 0, -1, 600, events)
      expect(id).toBe(i + 1) // ids run 1..32
    }
    expect(state.entityCount).toBe(MAX_ENTITIES) // 32
    expect(state.nextEntityId).toBe(33)
    expect(events.length).toBe(32)

    const overflow = spawnEntity(state, 'bolt', 1, { x: 0, y: 0, z: 0 }, 0, -1, 600, events)

    expect(overflow).toBe(-1)
    expect(state.entityCount).toBe(32)
    expect(state.nextEntityId).toBe(33) // not advanced by a dropped spawn
    expect(events.length).toBe(32) // nothing emitted
  })
})

describe('despawnEntityAt', () => {
  it('swap-removes and clears the vacated slot to the canonical dead form', () => {
    const state = blankState()
    const events: AuthEvent[] = []
    spawnEntity(state, 'slick', 0, { x: 1, y: 0, z: 0 }, 0, -1, 600, events) // id 1, idx 0
    spawnEntity(state, 'bolt', 1, { x: 2, y: 0, z: 0 }, 0, -1, 600, events) // id 2, idx 1
    spawnEntity(state, 'seeker', 2, { x: 3, y: 0, z: 0 }, 0.25, 5, 600, events) // id 3, idx 2
    events.length = 0

    despawnEntityAt(state, 0, events)

    expect(state.entityCount).toBe(2)
    expect(state.entities[0].entityId).toBe(3) // last live entity moved into slot 0
    expect(state.entities[0].kind).toBe('seeker')
    expect(state.entities[0].ownerId).toBe(2)
    expect(state.entities[0].targetId).toBe(5)
    expect(state.entities[1].entityId).toBe(2)
    const dead = state.entities[2]
    expect(dead.entityId).toBe(-1)
    expect(dead.kind).toBe('seeker')
    expect(dead.ownerId).toBe(-1)
    expect(dead.targetId).toBe(-1)
    expect(dead.heading).toBe(0)
    expect(dead.ttl).toBe(0)
    expect(dead.position.x).toBe(0)
    expect(dead.position.y).toBe(0)
    expect(dead.position.z).toBe(0)
    expect(dead.velocity.x).toBe(0)
    expect(dead.velocity.z).toBe(0)

    expect(events.length).toBe(1)
    expect(events[0].kind).toBe('entityDespawn')
    expect(events[0].playerId).toBe(0) // owner of the removed slick
    expect(events[0].entityId).toBe(1)
    expect(events[0].item).toBe('slick')
    expect(events[0].data).toBe(0)
  })

  it('ignores an index outside the live range', () => {
    const state = blankState()
    const events: AuthEvent[] = []
    spawnEntity(state, 'slick', 0, { x: 1, y: 0, z: 0 }, 0, -1, 600, events)
    events.length = 0

    despawnEntityAt(state, 1, events)
    despawnEntityAt(state, -1, events)
    despawnEntityAt(state, MAX_ENTITIES, events)

    expect(state.entityCount).toBe(1)
    expect(state.entities[0].entityId).toBe(1)
    expect(events.length).toBe(0)
  })
})

describe('kartById', () => {
  it('finds a kart by playerId and returns null for anything else', () => {
    const state = blankState()
    const k = kartById(state, 3)
    expect(k).not.toBeNull()
    expect(k?.playerId).toBe(3)
    expect(k?.position.x).toBe(1030) // 1000 + 10 * 3
    expect(kartById(state, 8)).toBeNull()
    expect(kartById(state, -1)).toBeNull()
  })
})

describe('updateEntities ttl', () => {
  it('decrements ttl every tick and despawns at zero', () => {
    const ctx = stubContext()
    const state = blankState()
    const events: AuthEvent[] = []
    const id = spawnEntity(state, 'slick', 0, { x: 5, y: 0, z: 1 }, 0, -1, 2, events)
    expect(id).toBe(1)
    events.length = 0

    updateEntities(ctx, state, events)

    expect(state.entityCount).toBe(1)
    expect(state.entities[0].ttl).toBe(1) // 2 - 1
    expect(events.length).toBe(0)

    updateEntities(ctx, state, events)

    expect(state.entityCount).toBe(0)
    expect(state.entities[0].entityId).toBe(-1)
    expect(events.length).toBe(1)
    expect(events[0].kind).toBe('entityDespawn')
    expect(events[0].entityId).toBe(1)
    expect(events[0].item).toBe('slick')
  })

  it('expires several entities in one tick without skipping a live slot', () => {
    const ctx = stubContext()
    const state = blankState()
    const events: AuthEvent[] = []
    spawnEntity(state, 'slick', 0, { x: 1, y: 0, z: 0 }, 0, -1, 1, events) // id 1, expires
    spawnEntity(state, 'slick', 1, { x: 2, y: 0, z: 0 }, 0, -1, 5, events) // id 2, lives
    spawnEntity(state, 'slick', 2, { x: 3, y: 0, z: 0 }, 0, -1, 1, events) // id 3, expires
    spawnEntity(state, 'slick', 3, { x: 4, y: 0, z: 0 }, 0, -1, 5, events) // id 4, lives
    events.length = 0

    updateEntities(ctx, state, events)

    // backwards walk: idx3 ttl 5->4, idx2 expires (id4 swaps down into slot 2),
    // idx1 ttl 5->4, idx0 expires (id4 swaps down into slot 0)
    expect(state.entityCount).toBe(2)
    expect(state.entities[0].entityId).toBe(4)
    expect(state.entities[1].entityId).toBe(2)
    expect(state.entities[0].ttl).toBe(4) // 5 - 1
    expect(state.entities[1].ttl).toBe(4) // 5 - 1
    expect(state.entities[2].entityId).toBe(-1)
    expect(state.entities[3].entityId).toBe(-1)
    expect(events.length).toBe(2)
    expect(events[0].entityId).toBe(3) // the higher index expires first
    expect(events[1].entityId).toBe(1)
  })
})
```

- [ ] **Step 2: Run the pool test to verify it fails**

Run: `npx vitest run packages/sim/test/entity.test.ts`
Expected: FAIL with `Failed to resolve import "../src/entity" from "packages/sim/test/entity.test.ts"`.

- [ ] **Step 3: Implement the pool half of `packages/sim/src/entity.ts`**

Create `packages/sim/src/entity.ts`. `updateEntities` starts as the ttl pass only; Steps 7, 11 and 15 grow it.

```ts
import type {
  AuthEvent, EntityKind, EntityState, KartState, SimContext, SimState, Vec3,
} from './types'
import { MAX_ENTITIES } from './types'
import { wrapAngle } from './mathutil'
import { emit } from './state'

/**
 * The canonical dead form of a pool slot. entityId === -1 is the contract's
 * sentinel; the rest is cleared so a slot's contents never depend on which
 * entity last occupied it.
 */
function clearSlot(e: EntityState): void {
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
  e.targetId = -1
  e.ttl = 0
}

/**
 * Take the next free slot at the front of the pool. Returns the new entityId,
 * or -1 when the pool is full: the contract drops the spawn and never evicts.
 * `position` is copied by value; `velocity` is derived by updateEntities.
 */
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

/** Remove the entity at packed index `idx` (not an entityId) by swap-remove. */
export function despawnEntityAt(state: SimState, idx: number, events: AuthEvent[]): void {
  if (idx < 0 || idx >= state.entityCount) return

  const e = state.entities[idx]
  emit(state, events, 'entityDespawn', e.ownerId, e.entityId, e.kind, 0)

  const last = state.entityCount - 1
  if (idx !== last) {
    const tmp = state.entities[idx]
    state.entities[idx] = state.entities[last]
    state.entities[last] = tmp
  }
  state.entityCount = last
  clearSlot(state.entities[last])
}

export function kartById(state: SimState, playerId: number): KartState | null {
  const karts = state.karts
  for (let i = 0; i < karts.length; i++) {
    if (karts[i].playerId === playerId) return karts[i]
  }
  return null
}

/**
 * One call per tick, after the per-kart loop and resolveKartCollisions.
 * Iterates the live range backwards so a swap-remove can never skip or
 * re-process a slot: the entity moved down into `i` always comes from an index
 * that was already visited.
 */
export function updateEntities(
  _ctx: SimContext,
  state: SimState,
  events: AuthEvent[],
): void {
  for (let i = state.entityCount - 1; i >= 0; i--) {
    const e = state.entities[i]
    e.ttl -= 1
    if (e.ttl <= 0) despawnEntityAt(state, i, events)
  }
}
```

- [ ] **Step 4: Run the pool test to verify it passes**

Run: `npx vitest run packages/sim/test/entity.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Write the failing test for per-kind entity motion**

Append these two suites to the end of `packages/sim/test/entity.test.ts` (the imports and helpers from Step 1 already cover everything they need):

```ts
describe('updateEntities motion', () => {
  it('turns a seeker toward its target at the capped turn rate and flies at seekerSpeed', () => {
    const ctx = stubContext()
    const state = blankState()
    const events: AuthEvent[] = []
    state.karts[3].position.x = 10
    state.karts[3].position.y = 0
    state.karts[3].position.z = 10
    spawnEntity(state, 'seeker', 0, { x: 0, y: 0.5, z: 0 }, 0, 3, 600, events)
    events.length = 0

    updateEntities(ctx, state, events)

    const e = state.entities[0]
    // desired heading = atan2(10 - 0, 10 - 0) = PI/4 = 0.7853981633974483,
    // capped at SEEKER_TURN_RATE * TICK_DT = 4 / 60 = 0.06666666666666667
    expect(e.heading).toBeCloseTo(0.06666666666666667, 12)
    // velocity = seekerSpeed 55 * (cos h, 0, sin h)
    expect(e.velocity.x).toBeCloseTo(54.87782303856173, 9)
    expect(e.velocity.y).toBe(0)
    expect(e.velocity.z).toBeCloseTo(3.6639512207866147, 9)
    // position += velocity * TICK_DT
    expect(e.position.x).toBeCloseTo(0.9146303839760288, 9)
    expect(e.position.z).toBeCloseTo(0.06106585367977691, 9)
    expect(e.position.y).toBe(0.5) // entities are planar: y never integrates
    expect(e.ttl).toBe(599)
    expect(events.length).toBe(0)
  })

  it('flies a seeker straight when it has no target', () => {
    const ctx = stubContext()
    const state = blankState()
    const events: AuthEvent[] = []
    // heading 0: cos = 1 and sin = 0 exactly, so it runs straight down +X
    spawnEntity(state, 'seeker', 0, { x: 500, y: 0, z: 0 }, 0, -1, 600, events)
    events.length = 0

    updateEntities(ctx, state, events)

    const e = state.entities[0]
    expect(e.heading).toBe(0) // no target, so no homing turn at all
    expect(e.velocity.x).toBe(55) // seekerSpeed
    expect(e.velocity.z).toBe(0)
    // 500 + 55 / 60 = 500.9166666666667
    expect(e.position.x).toBeCloseTo(500.9166666666667, 9)
    expect(e.position.z).toBe(0)
  })

  it('bounces a bolt off the track edge and places it back inside', () => {
    const ctx = stubContext()
    const state = blankState()
    const events: AuthEvent[] = []
    // half width = 10; the bolt is at z = 9.9 heading PI/4 (out toward +z)
    spawnEntity(state, 'bolt', 0, { x: 0, y: 0.5, z: 9.9 }, Math.PI / 4, -1, 600, events)
    events.length = 0

    updateEntities(ctx, state, events)

    const e = state.entities[0]
    // step: velocity = 65 * (cos, sin)(PI/4) = (45.96194077712559, 0, 45.961940777125584)
    // z = 9.9 + 45.961940777125584 / 60 = 10.666032346285427 -> outside +-10
    // reflect about the tangent (1,0,0): heading PI/4 -> -PI/4
    expect(e.heading).toBeCloseTo(-0.7853981633974483, 12)
    // x is unaffected by the lateral push-back (right = (0,0,1))
    expect(e.position.x).toBeCloseTo(0.7660323462854265, 9)
    // pushed back to half - BOLT_EDGE_INSET = 10 - 0.05
    expect(e.position.z).toBeCloseTo(9.95, 9)
    // velocity is recomputed from the post-bounce heading
    expect(e.velocity.x).toBeCloseTo(45.96194077712559, 9)
    expect(e.velocity.z).toBeCloseTo(-45.961940777125584, 9)
    expect(state.entityCount).toBe(1) // a bounce never despawns
  })

  it('leaves a slick exactly where it was dropped', () => {
    const ctx = stubContext()
    const state = blankState()
    const events: AuthEvent[] = []
    spawnEntity(state, 'slick', 2, { x: 3, y: 0, z: -4 }, 1.25, -1, 600, events)
    events.length = 0

    updateEntities(ctx, state, events)
    updateEntities(ctx, state, events)

    const e = state.entities[0]
    expect(e.position.x).toBe(3)
    expect(e.position.y).toBe(0)
    expect(e.position.z).toBe(-4)
    expect(e.velocity.x).toBe(0)
    expect(e.velocity.z).toBe(0)
    expect(e.heading).toBe(1.25)
    expect(e.ttl).toBe(598) // 600 - 2
  })

  it('orbits a bubble around its owner', () => {
    const ctx = stubContext()
    const state = blankState()
    const events: AuthEvent[] = []
    const owner = state.karts[1]
    owner.position.x = 5
    owner.position.y = 0
    owner.position.z = -3
    owner.shielded = true // the bubble is the view of this flag
    spawnEntity(state, 'bubble', 1, { x: 0, y: 0, z: 0 }, 0, -1, 600, events)
    events.length = 0

    updateEntities(ctx, state, events)

    const e = state.entities[0]
    // heading += BUBBLE_ORBIT_RATE * TICK_DT = 6 / 60 = 0.1
    expect(e.heading).toBeCloseTo(0.1, 12)
    // position = owner + 2 * (cos 0.1, 0, sin 0.1) = (5 + 1.9900083305560514, 0, -3 + 0.1996668332936563)
    expect(e.position.x).toBeCloseTo(6.990008330556051, 9)
    expect(e.position.y).toBe(0)
    expect(e.position.z).toBeCloseTo(-2.8003331667063436, 9)
    // tangential velocity = rate * radius = 12
    expect(e.velocity.x).toBeCloseTo(-1.1980009997619379, 9)
    expect(e.velocity.z).toBeCloseTo(11.940049983336309, 9)
    expect(state.entityCount).toBe(1)
  })

  it('holds surge and charge fields still and only counts them down', () => {
    const ctx = stubContext()
    const state = blankState()
    const events: AuthEvent[] = []
    spawnEntity(state, 'surge', 2, { x: 7, y: 0, z: 8 }, 0.5, -1, 300, events)
    spawnEntity(state, 'charge', 3, { x: -5, y: 0, z: 6 }, -0.5, -1, 30, events)
    events.length = 0

    updateEntities(ctx, state, events)

    const surge = state.entities[0]
    const charge = state.entities[1]
    expect(surge.position.x).toBe(7)
    expect(surge.position.z).toBe(8)
    expect(surge.velocity.x).toBe(0)
    expect(surge.velocity.z).toBe(0)
    expect(surge.ttl).toBe(299)
    expect(charge.position.x).toBe(-5)
    expect(charge.position.z).toBe(6)
    expect(charge.velocity.x).toBe(0)
    expect(charge.ttl).toBe(29)
    expect(state.entityCount).toBe(2)
  })
})
```

- [ ] **Step 6: Run the motion test to verify it fails**

Run: `npx vitest run packages/sim/test/entity.test.ts -t "seeker"`
Expected: FAIL — the seeker does not move at all, so `expected 0 to be close to 0.06666666666666667`.

- [ ] **Step 7: Add the motion pass to `packages/sim/src/entity.ts`**

Three edits to the file created in Step 3.

**7a.** Replace the two import lines:

```ts
import { MAX_ENTITIES } from './types'
import { wrapAngle } from './mathutil'
```

with:

```ts
import { MAX_ENTITIES, TICK_DT } from './types'
import { clamp, wrapAngle } from './mathutil'
```

**7b.** Insert these constants directly below the import block, above `clearSlot`:

```ts
const SEEKER_TURN_RATE = 4.0 // rad/s of homing authority
const BOLT_EDGE_INSET = 0.05 // m inside the edge a bolt is placed after a bounce
const BUBBLE_ORBIT_RADIUS = 2.0 // m
const BUBBLE_ORBIT_RATE = 6.0 // rad/s
```

**7c.** Replace `updateEntities` together with its doc comment — currently the tail of the file reads:

```ts
/**
 * One call per tick, after the per-kart loop and resolveKartCollisions.
 * Iterates the live range backwards so a swap-remove can never skip or
 * re-process a slot: the entity moved down into `i` always comes from an index
 * that was already visited.
 */
export function updateEntities(
  _ctx: SimContext,
  state: SimState,
  events: AuthEvent[],
): void {
  for (let i = state.entityCount - 1; i >= 0; i--) {
    const e = state.entities[i]
    e.ttl -= 1
    if (e.ttl <= 0) despawnEntityAt(state, i, events)
  }
}
```

Note the parameter rename from `_ctx` to `ctx`: the ttl-only version never read the
context, and the leading underscore is what kept `noUnusedParameters` quiet.

with the motion pass plus the same ttl pass, and a new `stepEntity` helper above it:

```ts
/** One tick of per-kind motion. Never spawns or despawns. */
function stepEntity(ctx: SimContext, state: SimState, e: EntityState): void {
  switch (e.kind) {
    case 'seeker': {
      const target = e.targetId >= 0 ? kartById(state, e.targetId) : null
      if (target !== null) {
        const dx = target.position.x - e.position.x
        const dz = target.position.z - e.position.z
        if (dx !== 0 || dz !== 0) {
          const maxTurn = SEEKER_TURN_RATE * TICK_DT
          const diff = wrapAngle(Math.atan2(dz, dx) - e.heading)
          e.heading = wrapAngle(e.heading + clamp(diff, -maxTurn, maxTurn))
        }
      }
      const sp = ctx.tuning.seekerSpeed
      e.velocity.x = Math.cos(e.heading) * sp
      e.velocity.y = 0
      e.velocity.z = Math.sin(e.heading) * sp
      e.position.x += e.velocity.x * TICK_DT
      e.position.z += e.velocity.z * TICK_DT
      return
    }
    case 'bolt': {
      const sp = ctx.tuning.boltSpeed
      e.velocity.x = Math.cos(e.heading) * sp
      e.velocity.y = 0
      e.velocity.z = Math.sin(e.heading) * sp
      e.position.x += e.velocity.x * TICK_DT
      e.position.z += e.velocity.z * TICK_DT

      const proj = ctx.query.project(e.position)
      const half = ctx.query.sampleAt(proj.s).width * 0.5
      if (proj.lateral <= half && proj.lateral >= -half) return

      const tan = ctx.query.tangentAt(proj.s)
      const tl = Math.sqrt(tan.x * tan.x + tan.z * tan.z)
      if (tl < 1e-9) return
      const tx = tan.x / tl
      const tz = tan.z / tl
      // right = (-t.z, 0, t.x), normalized: positive lateral is right of travel
      const rx = -tz
      const rz = tx
      // reflect the heading direction about the tangent axis: 2(d.t)t - d
      const dx = Math.cos(e.heading)
      const dz = Math.sin(e.heading)
      const dot = dx * tx + dz * tz
      e.heading = wrapAngle(Math.atan2(2 * dot * tz - dz, 2 * dot * tx - dx))
      // and place it back just inside the edge it crossed
      const edge = half - BOLT_EDGE_INSET
      const shift = (proj.lateral > 0 ? edge : -edge) - proj.lateral
      e.position.x += rx * shift
      e.position.z += rz * shift
      e.velocity.x = Math.cos(e.heading) * sp
      e.velocity.z = Math.sin(e.heading) * sp
      return
    }
    case 'bubble': {
      e.heading = wrapAngle(e.heading + BUBBLE_ORBIT_RATE * TICK_DT)
      const tangential = BUBBLE_ORBIT_RATE * BUBBLE_ORBIT_RADIUS
      e.velocity.x = -Math.sin(e.heading) * tangential
      e.velocity.y = 0
      e.velocity.z = Math.cos(e.heading) * tangential
      const owner = kartById(state, e.ownerId)
      if (owner !== null) {
        e.position.x = owner.position.x + Math.cos(e.heading) * BUBBLE_ORBIT_RADIUS
        e.position.y = owner.position.y
        e.position.z = owner.position.z + Math.sin(e.heading) * BUBBLE_ORBIT_RADIUS
      }
      return
    }
    default: {
      // slick is a dropped hazard; surge and charge are timed fields. All
      // three sit still and only their ttl moves.
      e.velocity.x = 0
      e.velocity.y = 0
      e.velocity.z = 0
      return
    }
  }
}

/**
 * One call per tick, after the per-kart loop and resolveKartCollisions.
 * The ttl pass iterates the live range backwards so a swap-remove can never
 * skip or re-process a slot: the entity moved down into `i` always comes from
 * an index that was already visited.
 */
export function updateEntities(
  ctx: SimContext,
  state: SimState,
  events: AuthEvent[],
): void {
  for (let i = 0; i < state.entityCount; i++) {
    stepEntity(ctx, state, state.entities[i])
  }
  for (let i = state.entityCount - 1; i >= 0; i--) {
    const e = state.entities[i]
    e.ttl -= 1
    if (e.ttl <= 0) despawnEntityAt(state, i, events)
  }
}
```

- [ ] **Step 8: Run the motion test to verify it passes**

Run: `npx vitest run packages/sim/test/entity.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 9: Write the failing test for entity/kart collision**

Append this suite to the end of `packages/sim/test/entity.test.ts`:

```ts
describe('updateEntities collision', () => {
  it('spins out the kart it strikes and emits hit then spinOut', () => {
    const ctx = stubContext()
    const state = blankState()
    const events: AuthEvent[] = []
    const victim = state.karts[1]
    victim.position.x = 0
    victim.position.y = 0
    victim.position.z = 0
    // slick reach = 1.2 + kartRadius 0.9 = 2.1, and it sits 1.5 away
    spawnEntity(state, 'slick', 0, { x: 1.5, y: 0, z: 0 }, 0, -1, 600, events)
    events.length = 0
    state.nextEventSeq = 0 // drop the spawn event and number the hit from 0

    updateEntities(ctx, state, events)

    expect(victim.spinOutTicks).toBe(60) // tuning.spinOutTicks, armed by startSpinOut
    expect(victim.invulnTicks).toBe(0) // Task 9 owns invulnerability, not this
    expect(events.length).toBe(2)
    expect(events[0].kind).toBe('hit')
    expect(events[0].playerId).toBe(1)
    expect(events[0].entityId).toBe(1)
    expect(events[0].item).toBe('slick')
    expect(events[0].data).toBe(0) // 0 = took the hit, 1 = a shield ate it
    expect(events[0].eventSeq).toBe(0)
    // the spinOut event is emitted by startSpinOut, not by this module
    expect(events[1].kind).toBe('spinOut')
    expect(events[1].playerId).toBe(1)
    expect(events[1].item).toBe('none')
    expect(events[1].data).toBe(60)
    expect(events[1].eventSeq).toBe(1)
    // a slick is persistent: it survives the karts it spins out
    expect(state.entityCount).toBe(1)
    expect(state.entities[0].ttl).toBe(599)
  })

  it('consumes a seeker on impact', () => {
    const ctx = stubContext()
    const state = blankState()
    const events: AuthEvent[] = []
    const victim = state.karts[1]
    victim.position.x = 0
    victim.position.y = 0
    victim.position.z = 0
    // heading 0, no target: it steps to x = -2 + 55/60 = -1.0833333333333335,
    // inside the seeker reach of 1.6 + 0.9 = 2.5
    spawnEntity(state, 'seeker', 0, { x: -2, y: 0, z: 0 }, 0, -1, 600, events)
    events.length = 0

    updateEntities(ctx, state, events)

    expect(victim.spinOutTicks).toBe(60)
    expect(state.entityCount).toBe(0)
    expect(state.entities[0].entityId).toBe(-1)
    expect(events.length).toBe(3)
    expect(events[0].kind).toBe('hit')
    expect(events[1].kind).toBe('spinOut')
    expect(events[2].kind).toBe('entityDespawn')
    expect(events[2].playerId).toBe(0) // the owner, on a despawn
    expect(events[2].entityId).toBe(1)
    expect(events[2].item).toBe('seeker')
  })

  it('misses a kart outside the hit radius', () => {
    const ctx = stubContext()
    const state = blankState()
    const events: AuthEvent[] = []
    const near = state.karts[1]
    near.position.x = 0
    near.position.y = 0
    near.position.z = 0
    // 2.5 apart, and the slick only reaches 1.2 + 0.9 = 2.1
    spawnEntity(state, 'slick', 0, { x: 2.5, y: 0, z: 0 }, 0, -1, 600, events)
    events.length = 0

    updateEntities(ctx, state, events)

    expect(near.spinOutTicks).toBe(0)
    expect(events.length).toBe(0)
    expect(state.entityCount).toBe(1)
  })

  it('never strikes its own owner', () => {
    const ctx = stubContext()
    const state = blankState()
    const events: AuthEvent[] = []
    const owner = state.karts[1]
    owner.position.x = 0
    owner.position.y = 0
    owner.position.z = 0
    spawnEntity(state, 'slick', 1, { x: 1.5, y: 0, z: 0 }, 0, -1, 600, events)
    events.length = 0

    updateEntities(ctx, state, events)

    expect(owner.spinOutTicks).toBe(0)
    expect(events.length).toBe(0)
  })

  it('passes through karts that are spinning, invulnerable or respawning', () => {
    const ctx = stubContext()
    const state = blankState()
    const events: AuthEvent[] = []
    const invuln = state.karts[1]
    invuln.position.x = 0
    invuln.position.y = 0
    invuln.position.z = 0
    invuln.invulnTicks = 5
    const spinning = state.karts[2]
    spinning.position.x = 0
    spinning.position.y = 0
    spinning.position.z = 1
    spinning.spinOutTicks = 3
    const respawning = state.karts[3]
    respawning.position.x = 0
    respawning.position.y = 0
    respawning.position.z = -1
    respawning.respawnTicks = 7
    spawnEntity(state, 'slick', 0, { x: 1.5, y: 0, z: 0 }, 0, -1, 600, events)
    events.length = 0

    updateEntities(ctx, state, events)

    expect(invuln.spinOutTicks).toBe(0)
    expect(spinning.spinOutTicks).toBe(3) // untouched, not refreshed
    expect(respawning.spinOutTicks).toBe(0)
    // the guard skips these karts before the hit event, so not even a 'hit'
    // is emitted -- startSpinOut alone would still have let the hit through
    expect(events.length).toBe(0)
  })

  it('lets a shielded kart eat the hit and takes its bubble with it', () => {
    const ctx = stubContext()
    const state = blankState()
    const events: AuthEvent[] = []
    const victim = state.karts[1]
    victim.position.x = 0
    victim.position.y = 0
    victim.position.z = 0
    victim.shielded = true
    spawnEntity(state, 'slick', 0, { x: 1.5, y: 0, z: 0 }, 0, -1, 600, events) // id 1
    spawnEntity(state, 'bubble', 1, { x: 0, y: 0, z: 0 }, 0, -1, 600, events) // id 2
    events.length = 0

    updateEntities(ctx, state, events)

    expect(victim.shielded).toBe(false)
    expect(victim.spinOutTicks).toBe(0) // the shield ate it
    expect(events.length).toBe(2)
    expect(events[0].kind).toBe('hit')
    expect(events[0].playerId).toBe(1)
    expect(events[0].item).toBe('slick')
    expect(events[0].data).toBe(1) // 1 = absorbed
    expect(events[1].kind).toBe('entityDespawn')
    expect(events[1].entityId).toBe(2)
    expect(events[1].item).toBe('bubble')
    expect(events.some((ev) => ev.kind === 'spinOut')).toBe(false)
    expect(state.entityCount).toBe(1)
    expect(state.entities[0].entityId).toBe(1) // the slick outlives the shield
  })

  it('despawns a bubble whose owner is not shielded', () => {
    const ctx = stubContext()
    const state = blankState()
    const events: AuthEvent[] = []
    state.karts[4].shielded = false
    spawnEntity(state, 'bubble', 4, { x: 0, y: 0, z: 0 }, 0, -1, 600, events)
    events.length = 0

    updateEntities(ctx, state, events)

    expect(state.entityCount).toBe(0)
    expect(events.length).toBe(1)
    expect(events[0].kind).toBe('entityDespawn')
    expect(events[0].item).toBe('bubble')
  })
})
```

- [ ] **Step 10: Run the collision test to verify it fails**

Run: `npx vitest run packages/sim/test/entity.test.ts -t "spins out the kart"`
Expected: FAIL with `expected 0 to be 60` — nothing strikes karts yet.

- [ ] **Step 11: Add the collision and bubble passes to `packages/sim/src/entity.ts`**

Three edits.

**11a.** Add the `recovery` import. The contract makes `startSpinOut` the sole
writer of `k.spinOutTicks` and the sole emitter of `'spinOut'`, so this module
calls it rather than assigning the field. Before:

```ts
import { MAX_ENTITIES, TICK_DT } from './types'
import { clamp, wrapAngle } from './mathutil'
import { emit } from './state'
```

After:

```ts
import { MAX_ENTITIES, TICK_DT } from './types'
import { clamp, wrapAngle } from './mathutil'
import { emit } from './state'
import { startSpinOut } from './recovery'
```

(`recovery.ts` imports neither `entity.ts` nor `kart.ts`, so this adds no cycle.)

**11b.** Insert `hitRadiusFor` directly above `stepEntity`:

```ts
/**
 * Strike radius per kind, in metres, added to tuning.kartRadius at the test.
 * A bubble is a shield, and a surge is a slow field: neither strikes a kart.
 */
function hitRadiusFor(kind: EntityKind): number {
  switch (kind) {
    case 'seeker':
      return 1.6
    case 'bolt':
      return 1.4
    case 'slick':
      return 1.2
    case 'charge':
      return 6.0
    default:
      return 0
  }
}
```

**11c.** Replace `updateEntities` together with its doc comment — currently the tail of the file reads:

```ts
/**
 * One call per tick, after the per-kart loop and resolveKartCollisions.
 * The ttl pass iterates the live range backwards so a swap-remove can never
 * skip or re-process a slot: the entity moved down into `i` always comes from
 * an index that was already visited.
 */
export function updateEntities(
  ctx: SimContext,
  state: SimState,
  events: AuthEvent[],
): void {
  for (let i = 0; i < state.entityCount; i++) {
    stepEntity(ctx, state, state.entities[i])
  }
  for (let i = state.entityCount - 1; i >= 0; i--) {
    const e = state.entities[i]
    e.ttl -= 1
    if (e.ttl <= 0) despawnEntityAt(state, i, events)
  }
}
```

with the four-pass version:

```ts
/**
 * One call per tick, after the per-kart loop and resolveKartCollisions.
 * Motion, then strikes, then shield bookkeeping, then ttl. Every pass that can
 * despawn walks the live range backwards, so a swap-remove can never skip or
 * re-process a slot: the entity moved down into `i` always comes from an index
 * that was already visited.
 */
export function updateEntities(
  ctx: SimContext,
  state: SimState,
  events: AuthEvent[],
): void {
  for (let i = 0; i < state.entityCount; i++) {
    stepEntity(ctx, state, state.entities[i])
  }

  const karts = state.karts
  for (let i = state.entityCount - 1; i >= 0; i--) {
    const e = state.entities[i]
    const radius = hitRadiusFor(e.kind)
    if (radius <= 0) continue
    const reach = radius + ctx.tuning.kartRadius
    const reach2 = reach * reach
    for (let ki = 0; ki < karts.length; ki++) {
      const k = karts[ki]
      if (k.playerId === e.ownerId) continue
      // startSpinOut refuses these karts anyway; skipping them here is what
      // also suppresses the 'hit' event, so an untouchable kart is silent.
      if (k.spinOutTicks > 0 || k.invulnTicks > 0 || k.respawnTicks > 0) continue
      const dx = e.position.x - k.position.x
      const dy = e.position.y - k.position.y
      const dz = e.position.z - k.position.z
      if (dx * dx + dy * dy + dz * dz > reach2) continue
      if (k.shielded) {
        k.shielded = false
        emit(state, events, 'hit', k.playerId, e.entityId, e.kind, 1)
      } else {
        emit(state, events, 'hit', k.playerId, e.entityId, e.kind, 0)
        // startSpinOut is the contract's sole writer of spinOutTicks and it
        // emits the 'spinOut' event itself.
        startSpinOut(state, k, ctx.tuning.spinOutTicks, events)
      }
      if (e.kind === 'seeker' || e.kind === 'bolt') {
        // `e` is cleared by the swap-remove, so nothing may read it after this
        despawnEntityAt(state, i, events)
        break
      }
    }
  }

  // k.shielded is the truth; a bubble is its view. One outlives the other for
  // no ticks at all.
  for (let i = state.entityCount - 1; i >= 0; i--) {
    const e = state.entities[i]
    if (e.kind !== 'bubble') continue
    const owner = kartById(state, e.ownerId)
    if (owner === null || !owner.shielded) despawnEntityAt(state, i, events)
  }

  for (let i = state.entityCount - 1; i >= 0; i--) {
    const e = state.entities[i]
    e.ttl -= 1
    if (e.ttl <= 0) despawnEntityAt(state, i, events)
  }
}
```

- [ ] **Step 12: Run the collision test to verify it passes**

Run: `npx vitest run packages/sim/test/entity.test.ts`
Expected: PASS, 20 tests.

- [ ] **Step 13: Write the failing test for `surgeActiveOn`**

Append this suite to the end of `packages/sim/test/entity.test.ts`, and add `surgeActiveOn` to the entity import at the top of the file, changing:

```ts
import { despawnEntityAt, kartById, spawnEntity, updateEntities } from '../src/entity'
```

to:

```ts
import {
  despawnEntityAt, kartById, spawnEntity, surgeActiveOn, updateEntities,
} from '../src/entity'
```

```ts
describe('surgeActiveOn', () => {
  // Placement from (lap, checkpointIdx, t) descending, playerId breaking ties:
  // p2 (2,5,0.5) then p5 (1,3,0.2) then everyone still on (0,0,0) in playerId
  // order, so the order is [2, 5, 0, 1, 3, 4, 6, 7] and the places are
  // p2->0 p5->1 p0->2 p1->3 p3->4 p4->5 p6->6 p7->7.
  function progressState(): SimState {
    const state = blankState()
    state.karts[2].lap.lap = 2
    state.karts[2].lap.checkpointIdx = 5
    state.karts[2].lap.t = 0.5
    state.karts[5].lap.lap = 1
    state.karts[5].lap.checkpointIdx = 3
    state.karts[5].lap.t = 0.2
    return state
  }

  it('is false for everyone when no surge is live', () => {
    const state = progressState()
    for (let pid = 0; pid < MAX_KARTS; pid++) {
      expect(surgeActiveOn(state, pid)).toBe(false)
    }
  })

  it('slows only the karts placed ahead of the surge owner', () => {
    const state = progressState()
    const events: AuthEvent[] = []
    spawnEntity(state, 'surge', 5, { x: 0, y: 0, z: 0 }, 0, -1, 300, events)

    expect(surgeActiveOn(state, 2)).toBe(true) // place 0, ahead of p5's place 1
    expect(surgeActiveOn(state, 5)).toBe(false) // the owner is never slowed
    expect(surgeActiveOn(state, 0)).toBe(false) // place 2, behind p5
    expect(surgeActiveOn(state, 7)).toBe(false) // place 7, behind p5
  })

  it('ignores non-surge entities and out-of-range player ids', () => {
    const state = progressState()
    const events: AuthEvent[] = []
    spawnEntity(state, 'slick', 5, { x: 0, y: 0, z: 0 }, 0, -1, 600, events)
    expect(surgeActiveOn(state, 2)).toBe(false)

    spawnEntity(state, 'surge', 5, { x: 0, y: 0, z: 0 }, 0, -1, 300, events)
    expect(surgeActiveOn(state, 2)).toBe(true)
    expect(surgeActiveOn(state, -1)).toBe(false)
    expect(surgeActiveOn(state, MAX_KARTS)).toBe(false) // 8
  })

  it('lets one surge owner be caught by another surge', () => {
    const state = progressState()
    const events: AuthEvent[] = []
    spawnEntity(state, 'surge', 5, { x: 0, y: 0, z: 0 }, 0, -1, 300, events) // owner place 1
    spawnEntity(state, 'surge', 0, { x: 0, y: 0, z: 0 }, 0, -1, 300, events) // owner place 2

    expect(surgeActiveOn(state, 2)).toBe(true) // place 0: ahead of both
    expect(surgeActiveOn(state, 5)).toBe(true) // place 1: ahead of p0's surge
    expect(surgeActiveOn(state, 0)).toBe(false) // place 2: behind p5, owns the other
    expect(surgeActiveOn(state, 1)).toBe(false) // place 3: behind both
  })
})
```

- [ ] **Step 14: Run the surge test to verify it fails**

Run: `npx vitest run packages/sim/test/entity.test.ts -t "surge"`
Expected: FAIL with `"surgeActiveOn" is not exported by "packages/sim/src/entity.ts"`.

- [ ] **Step 15: Add `surgeActiveOn` to `packages/sim/src/entity.ts`**

Three edits.

**15a.** Replace the import block header — currently:

```ts
import { MAX_ENTITIES, TICK_DT } from './types'
import { clamp, wrapAngle } from './mathutil'
import { emit } from './state'
import { startSpinOut } from './recovery'
```

with:

```ts
import { MAX_ENTITIES, MAX_KARTS, TICK_DT } from './types'
import { clamp, wrapAngle } from './mathutil'
import { emit } from './state'
import { startSpinOut } from './recovery'
import { computePlacement } from './placement'
```

**15b.** Add two scratch arrays directly below the four motion constants:

```ts
// Placement scratch for surgeActiveOn. Module-level so the per-tick, per-kart
// call allocates nothing.
const placeIndexOf = new Int32Array(MAX_KARTS)
const placeOrder = new Int32Array(MAX_KARTS)
```

**15c.** Append to the end of the file:

```ts
/**
 * True when some live surge field, cast by a kart placed behind `playerId`,
 * is slowing it. Placement is read live, so a kart that drops behind the
 * caster stops being slowed. Task 6's targetSpeedFor multiplies by
 * tuning.surgeSpeedMul when this is true.
 */
export function surgeActiveOn(state: SimState, playerId: number): boolean {
  if (playerId < 0 || playerId >= MAX_KARTS) return false

  let anySurge = false
  for (let i = 0; i < state.entityCount; i++) {
    if (state.entities[i].kind === 'surge') {
      anySurge = true
      break
    }
  }
  if (!anySurge) return false // the common case: no sort at all

  computePlacement(state, placeIndexOf, placeOrder)
  const mine = placeIndexOf[playerId]
  for (let i = 0; i < state.entityCount; i++) {
    const e = state.entities[i]
    if (e.kind !== 'surge') continue
    if (e.ownerId === playerId) continue
    if (e.ownerId < 0 || e.ownerId >= MAX_KARTS) continue
    if (mine < placeIndexOf[e.ownerId]) return true // lower place is further ahead
  }
  return false
}
```

- [ ] **Step 16: Run the surge test to verify it passes**

Run: `npx vitest run packages/sim/test/entity.test.ts`
Expected: PASS, 24 tests.

- [ ] **Step 17: Write the failing test for the `kart.ts` wiring**

`surgeActiveOn` is fully implemented and nothing consumes it. `targetSpeedFor`
gets its surge factor from Task 6's staged `surgeFactorFor`, whose rule is *"any
live surge this kart does not own"* — so today the Surge item slows the whole
field except its caster, instead of only the karts ahead of the caster.

That divergence is quiet, which is why the second test below exists. A test with
the caster mid-pack and the subject **ahead** of it cannot see the difference:
both rules slow the subject. Only a subject placed **behind** the caster
separates them — the contract's rule leaves it alone, Task 6's staged rule slows
it. Two edits to `packages/sim/test/entity.test.ts`.

**17a.** Add the `kart.ts` import directly below the entity import. Before:

```ts
import {
  despawnEntityAt, kartById, spawnEntity, surgeActiveOn, updateEntities,
} from '../src/entity'
```

After:

```ts
import {
  despawnEntityAt, kartById, spawnEntity, surgeActiveOn, updateEntities,
} from '../src/entity'
import { targetSpeedFor } from '../src/kart'
```

**17b.** Append this suite to the end of the file:

```ts
describe('kart.ts wiring', () => {
  it('multiplies targetSpeedFor by tuning.surgeSpeedMul for a kart a surge is on', () => {
    const ctx = stubContext()
    const state = blankState()
    const events: AuthEvent[] = []
    // p2 leads on lap 2, p5 is second on lap 1, everyone else is level on
    // (0, 0, 0) and sorts by playerId: places are p2->0, p5->1, p0->2, ...
    state.karts[2].lap.lap = 2
    state.karts[5].lap.lap = 1
    const leader = state.karts[2] // characterIdx 0 -> speed 1.00, tarmac, no boost

    // no surge live yet:
    // maxSpeed 40 * speed 1.00 * accel 1 * surface 1 * surge 1 * boost 1 = 40
    expect(targetSpeedFor(ctx, state, leader, 1)).toBe(40)

    spawnEntity(state, 'surge', 5, { x: 0, y: 0, z: 0 }, 0, -1, 300, events)

    // p2 is placed ahead of the caster p5, so the surge is on it:
    // 40 * 1.00 * 1 * 1 * 0.7 * 1, evaluated left to right, is exactly 28 in
    // float64 (the exact product sits half an ulp below 28 and ties to even).
    expect(targetSpeedFor(ctx, state, leader, 1)).toBe(28)
    // the caster is never slowed by its own field
    expect(targetSpeedFor(ctx, state, state.karts[5], 1)).toBe(40)
  })

  it('leaves a kart placed behind the surge caster at full speed', () => {
    const ctx = stubContext()
    const state = blankState()
    const events: AuthEvent[] = []
    // Same field as above: p2 (lap 2) -> place 0, p5 (lap 1) -> place 1, and
    // everyone else is level on (0, 0, 0) and sorts by playerId, so p0 -> place 2.
    state.karts[2].lap.lap = 2
    state.karts[5].lap.lap = 1
    const behind = state.karts[0] // place 2: one place BEHIND the caster p5
    // characterIdx 0 -> speed 1.00, surface tarmac -> 1, boostTicks 0 -> 1

    expect(targetSpeedFor(ctx, state, behind, 1)).toBe(40)

    spawnEntity(state, 'surge', 5, { x: 0, y: 0, z: 0 }, 0, -1, 300, events)

    // A surge slows only the karts placed AHEAD of its caster, so p0's factor
    // stays 1 and its target speed does not move:
    //   40 * 1.00 * 1 (accel) * 1 (surface) * 1 (surge) * 1 (boost) = 40
    // Under the staged rule Task 6 wrote -- "any live surge this kart does not
    // own" -- p0 would take the field too:
    //   40 * 1.00 * 1 * 1 * 0.7 * 1 = 28
    // so this one expectation is the whole difference between the two rules.
    // The test above cannot see it: p2 is ahead of p5, where both say 28.
    expect(targetSpeedFor(ctx, state, behind, 1)).toBe(40)
    expect(surgeActiveOn(state, 0)).toBe(false)
  })
})
```

- [ ] **Step 18: Run the `kart.ts` wiring test to verify it fails**

Run: `npx vitest run packages/sim/test/entity.test.ts -t "kart.ts wiring"`

Expected: **1 passed, 1 failed.**

- `multiplies targetSpeedFor by tuning.surgeSpeedMul for a kart a surge is on`
  **passes already**, and that is not a mistake in it. Its subject p2 is ahead of
  the caster p5, and Task 6's staged rule ("any live surge this kart does not
  own") and the contract's rule ("a live surge owned by a kart ahead") agree on
  that kart: both give `28`, and both leave the caster at `40`.
- `leaves a kart placed behind the surge caster at full speed` **fails** with
  `AssertionError: expected 28 to be 40`, on the second `targetSpeedFor` call.
  Task 6's rule slows p0 because p0 does not own the surge; the contract's rule
  does not, because the caster p5 is ahead of p0. Step 19 is what fixes it.

If instead **both** tests pass here, `surgeFactorFor` has already been replaced
and Step 19 has nothing to do; if both fail, `surgeActiveOn` or `computePlacement`
is wrong, not the wiring — go back to Step 15.

- [ ] **Step 19: Wire `surgeActiveOn` into `targetSpeedFor`**

Two edits in `packages/sim/src/kart.ts`. There is **no `void state` line to
delete** — Task 6's `targetSpeedFor` never had one, because `surgeFactorFor` has
read `state` since Task 6.

**19a.** Add the import. Before (the `./mathutil` line of the import block, as
Task 6 wrote it — it is still a single unique line after Task 8 and Task 9 each
inserted their own import beneath it):

```ts
import { clamp, wrapAngle } from './mathutil'
```

After:

```ts
import { clamp, wrapAngle } from './mathutil'
import { surgeActiveOn } from './entity'
```

(`entity.ts` imports `./types`, `./mathutil`, `./state`, `./recovery` and
`./placement`, and none of those imports `./kart`, so this introduces no cycle.)

**19b.** Replace the body of `surgeFactorFor` with the contract's rule. This is
the module-level helper Task 6's Step 3 wrote directly above `targetSpeedFor`;
its doc comment goes with it, because the comment is the instruction being
carried out. Before:

```ts
/**
 * The Surge item's field-wide slow, as a multiplier on the target speed.
 *
 * A surge is a live world entity, and no entity can exist before Task 12 creates
 * `entity.ts` — `state.entityCount` is 0 for the whole of Tasks 6-11 — so this
 * returns 1 today. It is still real code rather than a literal, because `state`
 * is a parameter of `targetSpeedFor` and something has to read it.
 *
 * Task 12 replaces this entire body with the placement-aware rule it owns:
 *
 *   return surgeActiveOn(state, k.playerId) ? t.surgeSpeedMul : 1
 *
 * which narrows "any live surge this kart does not own" to "a live surge owned by
 * a kart ahead of this one". That needs computePlacement, which does not exist
 * yet. The call site in targetSpeedFor does not change.
 */
function surgeFactorFor(state: SimState, k: KartState, t: Tuning): number {
  for (let i = 0; i < state.entityCount; i++) {
    const e = state.entities[i]
    if (e.kind !== 'surge') continue
    if (e.ownerId === k.playerId) continue
    return t.surgeSpeedMul
  }
  return 1
}
```

After:

```ts
/**
 * The Surge item's field-wide slow, as a multiplier on the target speed.
 *
 * The rule is the contract's, and surgeActiveOn (Task 12, entity.ts) owns it: a
 * live surge slows every kart placed AHEAD of the kart that cast it, and never
 * the caster itself. Placement is read live from computePlacement, so a kart that
 * drops behind the caster stops being slowed on the next tick.
 *
 * This replaced Task 6's staged rule, "any live surge this kart does not own",
 * which slowed the whole field except the caster.
 */
function surgeFactorFor(state: SimState, k: KartState, t: Tuning): number {
  return surgeActiveOn(state, k.playerId) ? t.surgeSpeedMul : 1
}
```

The signature is unchanged, so the call site in `targetSpeedFor` —
`const surgeFactor = surgeFactorFor(state, k, t)` — is untouched, and all three
parameters are still read, so `noUnusedParameters` stays satisfied. This edit is
also what gives 19a's `surgeActiveOn` import its only consumer; without it
`tsc --noEmit` in Step 25 fails with
`TS6133: 'surgeActiveOn' is declared but its value is never read`.

Nothing else in `kart.ts` changes: the surrounding `surfaceFactor` (Task 9) and
`boostFactor` (Task 6) lines and the return expression's multiplication order are
part of the locked contract and must stay exactly as they are.

- [ ] **Step 20: Run the `kart.ts` wiring test to verify it passes**

Run: `npx vitest run packages/sim/test/entity.test.ts && npx vitest run packages/sim/test/kart.test.ts`
Expected: PASS — 26 tests in `entity.test.ts` (24 after Step 16, plus the two in
Step 17b), and every Task 6 kart test still green: they run states with no
entities at all, so `surgeActiveOn` returns `false` on its first loop and the
factor is still `1`.

- [ ] **Step 21: Write the failing test for the `step()` wiring**

`updateEntities` is the once-per-tick pass the contract orders
`resolveKartCollisions → updateEntities → updateItemBoxes → updatePhase`, and
`step()` does not call it yet — so in the live sim no projectile moves, expires or
ever strikes anyone. Three edits to `packages/sim/test/entity.test.ts`.

**21a.** Change the type-only import at the top of the file. Before:

```ts
import type {
  AuthEvent, EntityState, KartState, SimContext, SimState, Track, TrackQuery,
} from '../src/types'
```

After:

```ts
import type {
  AuthEvent, EntityState, Intent, KartState, SimContext, SimState, Track, TrackQuery,
} from '../src/types'
```

**21b.** Add the `step` import directly below the `kart.ts` import. Before:

```ts
import { targetSpeedFor } from '../src/kart'
```

After:

```ts
import { targetSpeedFor } from '../src/kart'
import { step } from '../src/step'
```

**21c.** Append this suite to the end of the file:

```ts
describe('step() wiring', () => {
  it('runs updateEntities once per tick, after the kart loop', () => {
    const ctx = stubContext()
    const prev = blankState()
    const next = blankState()
    prev.tick = 700
    prev.phase = 'racing'

    // The victim sits at the origin; every other kart stays parked at
    // x = 1000 + 10 * playerId, so nothing else is in reach and no kart-vs-kart
    // contact fires either.
    const victim = prev.karts[1]
    victim.position.x = 0
    victim.position.y = 0
    victim.position.z = 0
    // slick reach = 1.2 + kartRadius 0.9 = 2.1, and it sits 1.5 m away
    const spawnEvents: AuthEvent[] = []
    spawnEntity(prev, 'slick', 0, { x: 1.5, y: 0, z: 0 }, 0, -1, 600, spawnEvents)
    prev.nextEventSeq = 0 // renumber from 0: the spawn event is not under test

    const inputs: Intent[] = []
    for (let i = 0; i < MAX_KARTS; i++) {
      inputs.push({
        tick: 700, steer: 0, accel: 0, brake: false, drift: false, useItem: false,
      })
    }
    const events: AuthEvent[] = []

    step(ctx, prev, next, inputs, events)

    expect(next.tick).toBe(701)
    // every kart is at rest with accel 0, so nobody moves and the slick is
    // still 1.5 m from the victim when updateEntities runs
    expect(next.karts[1].spinOutTicks).toBe(60) // tuning.spinOutTicks
    expect(next.entities[0].ttl).toBe(599) // 600 - 1: the ttl pass ran too
    expect(events.length).toBe(2)
    expect(events[0].kind).toBe('hit')
    expect(events[0].playerId).toBe(1)
    expect(events[0].eventSeq).toBe(0)
    // updateEntities runs against `next`, whose tick is already prev.tick + 1
    expect(events[0].tick).toBe(701)
    expect(events[1].kind).toBe('spinOut')
    expect(events[1].playerId).toBe(1)

    // step never mutates prev
    expect(prev.karts[1].spinOutTicks).toBe(0)
    expect(prev.entities[0].ttl).toBe(600)
    expect(prev.tick).toBe(700)
  })
})
```

- [ ] **Step 22: Run the `step()` wiring test to verify it fails**

Run: `npx vitest run packages/sim/test/entity.test.ts -t "step() wiring"`
Expected: FAIL with `expected 0 to be 60` — `step()` never calls `updateEntities`,
so the slick neither strikes the victim nor counts down.

- [ ] **Step 23: Wire `updateEntities` into `step()`**

Two edits in `packages/sim/src/step.ts`.

**23a.** Add the import. Before (the `./collision` import Task 10 added):

```ts
import { resolveKartCollisions } from './collision'
```

After:

```ts
import { resolveKartCollisions } from './collision'
import { updateEntities } from './entity'
```

**23b.** Add the call to the once-per-tick section that follows the per-kart
`for` loop. `resolveKartCollisions(ctx, next)` is the only call to that function
in the file (Task 10 put it there). Before:

```ts
  resolveKartCollisions(ctx, next)
```

After:

```ts
  resolveKartCollisions(ctx, next)
  updateEntities(ctx, next, events)
```

The order is fixed by the contract: collisions settle the karts' final positions
for the tick, and only then are projectiles moved and tested against them, so a
kart can never be struck at a position it does not end the tick at. Task 13
inserts `updateItemBoxes` immediately after this line, and Task 15 `updatePhase`
after that.

- [ ] **Step 24: Run the `step()` wiring test to verify it passes**

Run: `npx vitest run packages/sim/test/entity.test.ts`
Expected: PASS, 27 tests (26 after Step 20, plus the one in Step 21c).

- [ ] **Step 25: Typecheck and run the whole sim suite**

Run: `npx tsc --noEmit -p packages/sim && npx vitest run packages/sim`
Expected: no TypeScript output, and every existing sim test still passes alongside the 27 in `entity.test.ts`.

- [ ] **Step 26: Commit**

```bash
git add packages/sim/src/entity.ts packages/sim/src/kart.ts packages/sim/src/step.ts \
        packages/sim/test/entity.test.ts
git commit -m "feat(sim): world entity pool, per-kind update and entity/kart hits

Fixed 32-slot pool with live entities packed at the front, swap-remove
on despawn, and vacated slots cleared to entityId -1. A spawn into a
full pool is dropped, returning -1 and emitting nothing, per the
contract's overflow policy.

Per kind: a seeker homes toward targetId at a capped turn rate, a bolt
flies straight and reflects off the track edge about the tangent, a
slick sits still, a bubble orbits its owner, and surge and charge are
timed fields. TTL counts down every tick and despawns at zero.

Entities strike karts within radius + kartRadius, emitting hit and then
routing the spin-out through recovery.ts's startSpinOut, the contract's
sole writer of spinOutTicks; a shielded kart eats the hit instead and
loses its bubble.

step() now calls updateEntities right after resolveKartCollisions, and
kart.ts's staged surgeFactorFor body is replaced with surgeActiveOn, so
a surge slows the karts ahead of its caster instead of the whole field."
```

---

### Task 13: Item boxes, placement-weighted rolls, and all eight item effects

**Files:**
- Create: `packages/sim/src/items.ts`
- Create: `packages/sim/test/items.test.ts`
- Modify: `packages/sim/src/step.ts` — three edits (the import, the per-kart `useItem` call, the post-loop `updateItemBoxes` call), exact before/after in Step 19
- Test: `packages/sim/test/items.test.ts`

**Interfaces:**

Consumes (all exist before this task; signatures verbatim from the locked contract):
- `packages/sim/src/types.ts` [Task 2] — types `Vec3`, `ItemKind`, `EntityKind`, `KartState`, `EntityState`, `ItemBoxState`, `SimState`, `SimContext`, `AuthEvent`, `AuthEventKind`, `Intent`; values `MAX_KARTS = 8`, `MAX_ENTITIES = 32`
- `packages/sim/src/mathutil.ts` [Task 2] — `export function clamp(v: number, lo: number, hi: number): number`
- `packages/sim/src/rng.ts` [Task 2] — `export function rngAt(seed: number, cursor: number): number` returning `[0, 1)`
- `packages/sim/src/vec3.ts` [Task 2] — `export function v3(x: number, y: number, z: number): Vec3`, `export function v3len(a: Vec3): number`
- `packages/sim/src/state.ts` [Task 5] — `export function createState(ctx: SimContext, seed: number, characterIdx: number[]): SimState`, `export function emit(state: SimState, out: AuthEvent[], kind: AuthEventKind, playerId: number, entityId: number, item: ItemKind, data: number): void`
- `packages/sim/src/placement.ts` [Task 11] — `export function computePlacement(state: SimState, outIndexOf: Int32Array, outOrder: Int32Array): void`, where `outOrder[place] = playerId` (leader at place 0) and `outIndexOf[playerId] = place`; both arrays must be length `MAX_KARTS`
- `packages/sim/src/entity.ts` [Task 12] — `export function spawnEntity(state: SimState, kind: EntityKind, ownerId: number, position: Vec3, heading: number, targetId: number, ttl: number, events: AuthEvent[]): number` (returns the new `entityId`, or `-1` when the pool is full), `export function kartById(state: SimState, playerId: number): KartState | null`
- `packages/sim/test/fixtures/track-fixtures.ts` [Task 3] — `makeStraightTrack(overrides?: Partial<Track>)` (runs along **+X**); and, in the same file but written by [Task 4] because it needs `buildTrackQuery`, `makeContext(track: Track, isLeader?: boolean): SimContext` (`isLeader` defaults `true`)
- Tuning values used here, from the contract's fixture table: `kartRadius = 0.9`, `itemBoxRespawnTicks = 180`, `seekerSpeed = 55`, `boltSpeed = 65`, `entityTtl = 600`, `invulnTicks = 90`

Produces (contract signatures, plus five additions this task defines because the contract does not name them):
- `export function updateItemBoxes(ctx: SimContext, state: SimState, events: AuthEvent[]): void` — contract
- `export function rollItem(ctx: SimContext, state: SimState, placeIdx: number): ItemKind` — contract
- `export function useItem(ctx: SimContext, state: SimState, k: KartState, events: AuthEvent[]): void` — contract
- `export function itemForRoll(placeIdx: number, r: number): ItemKind` — **addition**: the pure roll→item mapping, split out so the distribution can be tested with exact numbers and no PRNG
- `export function applyItemGrant(ctx: SimContext, state: SimState, ev: AuthEvent): void` — **addition**: the follower path. A non-leader never rolls, so it receives the item as an authoritative `'itemGrant'` `AuthEvent` and applies it here. Task 17+ (the `net` layer) calls this; nothing in `step()` does
- `export function itemBoxWorldPos(ctx: SimContext, boxIdx: number, out: Vec3): void` — **addition**: writes the world position of `ctx.track.itemBoxes[boxIdx]` into `out`
- `export function placeIndexOf(state: SimState, playerId: number): number` — **addition**: 0-based placement of one kart, zero-alloc
- `export function seekerTargetFor(state: SimState, playerId: number): number` — **addition**: the `playerId` one place ahead, or `-1` for the race leader
- Exported constants: `ITEM_ROLL_ORDER`, `ITEM_WEIGHTS`, `ITEM_WEIGHT_TOTAL`, `ITEM_BOX_RADIUS`, `ITEM_BOOST_TICKS`, `BLINK_BOOST_TICKS`, `BLINK_INVULN_TICKS`, `SURGE_TTL_TICKS`, `CHARGE_TTL_TICKS`, `ITEM_FIRE_OFFSET`, `ITEM_DROP_OFFSET`

Rules this task fixes, because they are the ones an earlier draft got wrong:

1. **Only `ctx.isLeader === true` rolls.** `rollItem` returns `'none'` and leaves `state.rngCursor` untouched on a follower, and `updateItemBoxes` never even calls it there. A follower's kart gets its item from `applyItemGrant`.
2. **A follower still runs box pickup detection and box respawn timers.** Pickup is a pure function of positions, which the follower already simulates in lockstep, so leader and follower agree on *which box was taken and when* without any event. The only thing that needs an event is *what came out of it*.
3. **All eight items are implemented**, `'blink'` included: brief invulnerability plus speed, no entity.
4. `useItem` itself emits nothing. `spawnEntity` [Task 12] owns the `'entitySpawn'` event.
5. `isLeader` gates **only** rolling. Entity spawning is not gated: the server shadow authority runs the same `step()` in lockstep and must hold the same entities. "Entities are never predicted" is a `net`-layer rendering rule, not a `sim` rule.
6. **Track parameter `s` is arc-normalised `[0, 1)`, never metres** (contract §0). `ctx.track.itemBoxes[i].s` is a fraction of a lap, and `itemBoxWorldPos` hands it straight to `ctx.query.sampleAt` / `ctx.query.tangentAt`, both of which wrap it. A fixture that writes `{ s: 20 }` is writing `s = 0`, silently. Metres are reached only by multiplying an `s`-delta by `ctx.query.totalLength()` — on `makeStraightTrack` that is `1828.3236243`.

---

- [ ] **Step 1: Write the failing test for the distribution table**

Create `packages/sim/test/items.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import {
  ITEM_ROLL_ORDER,
  ITEM_WEIGHTS,
  ITEM_WEIGHT_TOTAL,
  itemForRoll,
} from '../src/items'
import type { ItemKind } from '../src/types'

describe('item distribution table', () => {
  it('is 8 placements x 8 items and every row sums to exactly 100', () => {
    expect(ITEM_ROLL_ORDER).toEqual([
      'boost', 'seeker', 'bolt', 'slick', 'bubble', 'surge', 'blink', 'charge',
    ])
    expect(ITEM_WEIGHT_TOTAL).toBe(100)
    expect(ITEM_WEIGHTS.length).toBe(8)
    for (let p = 0; p < 8; p++) {
      expect(ITEM_WEIGHTS[p].length).toBe(8)
      let sum = 0
      for (let i = 0; i < 8; i++) sum += ITEM_WEIGHTS[p][i]
      expect(sum).toBe(100)
    }
  })

  it('shifts weight from defensive to catch-up items as placement worsens', () => {
    // Column indices, in ITEM_ROLL_ORDER: boost 0, seeker 1, bolt 2, slick 3,
    // bubble 4, surge 5, blink 6, charge 7.
    // surge is the pure catch-up item: unreachable in 1st, heaviest in 8th.
    expect(ITEM_WEIGHTS[0][5]).toBe(0)
    expect(ITEM_WEIGHTS[7][5]).toBe(22)
    // slick and bubble are the front-runner's defensive items.
    expect(ITEM_WEIGHTS[0][3]).toBe(30)
    expect(ITEM_WEIGHTS[7][3]).toBe(2)
    expect(ITEM_WEIGHTS[0][4]).toBe(24)
    expect(ITEM_WEIGHTS[7][4]).toBe(4)
    // boost, bolt and surge rise monotonically; slick and bubble fall.
    for (let p = 1; p < 8; p++) {
      expect(ITEM_WEIGHTS[p][0]).toBeGreaterThan(ITEM_WEIGHTS[p - 1][0])
      expect(ITEM_WEIGHTS[p][2]).toBeGreaterThan(ITEM_WEIGHTS[p - 1][2])
      expect(ITEM_WEIGHTS[p][5]).toBeGreaterThan(ITEM_WEIGHTS[p - 1][5])
      expect(ITEM_WEIGHTS[p][3]).toBeLessThan(ITEM_WEIGHTS[p - 1][3])
      expect(ITEM_WEIGHTS[p][4]).toBeLessThan(ITEM_WEIGHTS[p - 1][4])
    }
    // seeker peaks mid-field rather than at either end.
    expect(ITEM_WEIGHTS[3][1]).toBe(22)
    expect(ITEM_WEIGHTS[4][1]).toBe(22)
    expect(ITEM_WEIGHTS[0][1]).toBe(10)
    expect(ITEM_WEIGHTS[7][1]).toBe(12)
    // charge is flat across the whole field.
    for (let p = 0; p < 8; p++) expect(ITEM_WEIGHTS[p][7]).toBe(8)
  })

  it('maps a roll to the bucket its cumulative weight covers, in 1st place', () => {
    // Row 0 weights   : [10, 10,  6, 30, 24,  0, 12,   8]
    // Row 0 cumulative: [10, 20, 26, 56, 80, 80, 92, 100]
    // itemForRoll compares r * 100 against those, returning the first bucket
    // whose cumulative total is strictly greater.
    expect(itemForRoll(0, 0)).toBe('boost')        // 0.0   -> 0.0  < 10
    expect(itemForRoll(0, 0.001)).toBe('boost')    // 0.001 -> 0.1  < 10
    expect(itemForRoll(0, 0.199)).toBe('seeker')   // 0.199 -> 19.9 in [10, 20)
    expect(itemForRoll(0, 0.255)).toBe('bolt')     // 0.255 -> 25.5 in [20, 26)
    expect(itemForRoll(0, 0.407)).toBe('slick')    // 0.407 -> 40.7 in [26, 56)
    expect(itemForRoll(0, 0.707)).toBe('bubble')   // 0.707 -> 70.7 in [56, 80)
    expect(itemForRoll(0, 0.855)).toBe('blink')    // 0.855 -> 85.5 in [80, 92)
    expect(itemForRoll(0, 0.973)).toBe('charge')   // 0.973 -> 97.3 in [92, 100)
  })

  it('maps a roll to the bucket its cumulative weight covers, in 8th place', () => {
    // Row 7 weights   : [26, 12, 20,  2,  4, 22,  6,   8]
    // Row 7 cumulative: [26, 38, 58, 60, 64, 86, 92, 100]
    expect(itemForRoll(7, 0.101)).toBe('boost')    // 10.1 < 26
    expect(itemForRoll(7, 0.301)).toBe('seeker')   // 30.1 in [26, 38)
    expect(itemForRoll(7, 0.501)).toBe('bolt')     // 50.1 in [38, 58)
    expect(itemForRoll(7, 0.591)).toBe('slick')    // 59.1 in [58, 60)
    expect(itemForRoll(7, 0.621)).toBe('bubble')   // 62.1 in [60, 64)
    expect(itemForRoll(7, 0.801)).toBe('surge')    // 80.1 in [64, 86)
    expect(itemForRoll(7, 0.901)).toBe('blink')    // 90.1 in [86, 92)
    expect(itemForRoll(7, 0.991)).toBe('charge')   // 99.1 in [92, 100)
  })

  it('produces exactly weight*10 hits per item over a 1000-point sweep', () => {
    // r = (i + 0.5) / 1000 for i in 0..999. The half-offset keeps every sample
    // 0.05 away from a bucket edge, so no float rounding can move a sample
    // across a boundary. Bucket [a, b) then catches exactly 10*(b - a) samples.
    for (const place of [0, 7]) {
      const counts = new Map<ItemKind, number>()
      for (let i = 0; i < 1000; i++) {
        const item = itemForRoll(place, (i + 0.5) / 1000)
        counts.set(item, (counts.get(item) ?? 0) + 1)
      }
      for (let c = 0; c < 8; c++) {
        const item = ITEM_ROLL_ORDER[c]
        expect(counts.get(item) ?? 0).toBe(ITEM_WEIGHTS[place][c] * 10)
      }
    }
    // Spelled out for 1st place: boost 100, seeker 100, bolt 60, slick 300,
    // bubble 240, surge 0, blink 120, charge 80 -> 1000 samples.
    let firstPlaceSurge = 0
    for (let i = 0; i < 1000; i++) {
      if (itemForRoll(0, (i + 0.5) / 1000) === 'surge') firstPlaceSurge++
    }
    expect(firstPlaceSurge).toBe(0)
  })

  it('clamps an out-of-range placement into the table', () => {
    expect(itemForRoll(-3, 0.973)).toBe(itemForRoll(0, 0.973))
    expect(itemForRoll(99, 0.991)).toBe(itemForRoll(7, 0.991))
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/sim/test/items.test.ts -t "distribution table"`

Expected: FAIL with `Failed to resolve import "../src/items" from "packages/sim/test/items.test.ts"`.

- [ ] **Step 3: Write minimal implementation — the table and `itemForRoll`**

Create `packages/sim/src/items.ts`:

```typescript
import type { ItemKind } from './types'
import { MAX_KARTS } from './types'
import { clamp } from './mathutil'

/** Item columns, in the fixed order every row of ITEM_WEIGHTS uses. */
export const ITEM_ROLL_ORDER: readonly ItemKind[] = [
  'boost', 'seeker', 'bolt', 'slick', 'bubble', 'surge', 'blink', 'charge',
]

/** Every row of ITEM_WEIGHTS sums to exactly this. */
export const ITEM_WEIGHT_TOTAL = 100

/**
 * Row = the picker's 0-based placement (0 = 1st). Column = ITEM_ROLL_ORDER.
 *
 * The front of the field draws defensive items it can sit on (slick, bubble);
 * the back draws catch-up items (boost, bolt, surge). surge is unreachable in
 * 1st and heaviest in 8th. charge is flat at 8 everywhere so every placement
 * keeps one close-quarters answer. Every row sums to ITEM_WEIGHT_TOTAL.
 */
export const ITEM_WEIGHTS: readonly (readonly number[])[] = [
  //         boost seeker bolt slick bubble surge blink charge
  /* 1st */ [   10,    10,   6,   30,    24,    0,   12,     8],
  /* 2nd */ [   14,    16,   8,   24,    20,    2,    8,     8],
  /* 3rd */ [   16,    20,  10,   18,    16,    4,    8,     8],
  /* 4th */ [   18,    22,  12,   14,    12,    6,    8,     8],
  /* 5th */ [   20,    22,  14,   10,    10,   10,    6,     8],
  /* 6th */ [   22,    20,  16,    6,     8,   14,    6,     8],
  /* 7th */ [   24,    16,  18,    4,     6,   18,    6,     8],
  /* 8th */ [   26,    12,  20,    2,     4,   22,    6,     8],
]

/**
 * Pure roll -> item mapping. `r` is expected in [0, 1); anything at or above 1
 * falls through to the last column, which is non-zero in every row.
 */
export function itemForRoll(placeIdx: number, r: number): ItemKind {
  const row = ITEM_WEIGHTS[clamp(Math.floor(placeIdx), 0, MAX_KARTS - 1)]
  const target = r * ITEM_WEIGHT_TOTAL
  let acc = 0
  for (let i = 0; i < row.length; i++) {
    acc += row[i]
    if (target < acc) return ITEM_ROLL_ORDER[i]
  }
  return ITEM_ROLL_ORDER[ITEM_ROLL_ORDER.length - 1]
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/sim/test/items.test.ts -t "distribution table"`

Expected: PASS — 6 tests.

- [ ] **Step 5: Write the failing test for `rollItem` and the leader/follower split**

Append to `packages/sim/test/items.test.ts`. Also replace the existing import block at the top of the file so the new symbols resolve.

Before (top of `packages/sim/test/items.test.ts`):

```typescript
import { describe, it, expect } from 'vitest'
import {
  ITEM_ROLL_ORDER,
  ITEM_WEIGHTS,
  ITEM_WEIGHT_TOTAL,
  itemForRoll,
} from '../src/items'
import type { ItemKind } from '../src/types'
```

After:

```typescript
import { describe, it, expect } from 'vitest'
import {
  ITEM_ROLL_ORDER,
  ITEM_WEIGHTS,
  ITEM_WEIGHT_TOTAL,
  itemForRoll,
  placeIndexOf,
  rollItem,
} from '../src/items'
import type { ItemKind } from '../src/types'
import { createState } from '../src/state'
import { rngAt } from '../src/rng'
import { makeContext, makeStraightTrack } from './fixtures/track-fixtures'

const ALL_CHARACTERS = [0, 1, 2, 3, 4, 5, 6, 7]
```

Then append these tests to the end of the file:

```typescript
describe('rollItem', () => {
  it('draws at the current cursor and advances it by exactly one per roll', () => {
    const ctx = makeContext(makeStraightTrack())
    const state = createState(ctx, 12345, ALL_CHARACTERS)
    state.rngCursor = 0
    expect(state.raceSeed).toBe(12345)

    // rngAt is a pure function of (seed, cursor), so the expected item is
    // computable without touching the sim.
    const r0 = rngAt(12345, 0)
    const r1 = rngAt(12345, 1)
    expect(r0).toBeGreaterThanOrEqual(0)
    expect(r0).toBeLessThan(1)

    expect(rollItem(ctx, state, 7)).toBe(itemForRoll(7, r0))
    expect(state.rngCursor).toBe(1)
    expect(rollItem(ctx, state, 7)).toBe(itemForRoll(7, r1))
    expect(state.rngCursor).toBe(2)
  })

  it('advances the cursor once per roll over 100 rolls', () => {
    const ctx = makeContext(makeStraightTrack())
    const state = createState(ctx, 999, ALL_CHARACTERS)
    state.rngCursor = 40
    for (let i = 0; i < 100; i++) rollItem(ctx, state, i % 8)
    expect(state.rngCursor).toBe(140) // 40 + 100
  })

  it('never rolls and never advances the cursor on a follower context', () => {
    const follower = makeContext(makeStraightTrack(), false)
    expect(follower.isLeader).toBe(false)
    const state = createState(follower, 12345, ALL_CHARACTERS)
    state.rngCursor = 0
    for (let i = 0; i < 200; i++) {
      expect(rollItem(follower, state, i % 8)).toBe('none')
      expect(state.rngCursor).toBe(0)
    }
  })
})

describe('placeIndexOf', () => {
  it('returns the 0-based placement of one kart', () => {
    const ctx = makeContext(makeStraightTrack())
    const state = createState(ctx, 1, ALL_CHARACTERS)
    expect(state.karts[5].playerId).toBe(5)
    // placement sorts by (lap, checkpointIdx, t) descending, playerId ascending
    // as the tie-break, so lap 2 beats lap 1 beats lap 0.
    state.karts[5].lap.lap = 2
    state.karts[3].lap.lap = 1
    expect(placeIndexOf(state, 5)).toBe(0)
    expect(placeIndexOf(state, 3)).toBe(1)
    // Everyone else is on lap 0 and ties, so playerId ascending orders them:
    // 0, 1, 2, 4, 6, 7 take places 2..7.
    expect(placeIndexOf(state, 0)).toBe(2)
    expect(placeIndexOf(state, 7)).toBe(7)
  })
})
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run packages/sim/test/items.test.ts -t "rollItem"`

Expected: FAIL with `TypeError: rollItem is not a function` (the import resolves to `undefined` because `items.ts` does not export it yet).

- [ ] **Step 7: Write minimal implementation — `rollItem` and `placeIndexOf`**

Replace the import block at the top of `packages/sim/src/items.ts`.

Before:

```typescript
import type { ItemKind } from './types'
import { MAX_KARTS } from './types'
import { clamp } from './mathutil'
```

After:

```typescript
import type { ItemKind, SimContext, SimState } from './types'
import { MAX_KARTS } from './types'
import { clamp } from './mathutil'
import { rngAt } from './rng'
import { computePlacement } from './placement'
```

Then append to the end of `packages/sim/src/items.ts`:

```typescript
// Placement scratch. computePlacement fills both arrays; they are module-level
// because item logic runs every tick and step() must not allocate.
const placeIndexScratch = new Int32Array(MAX_KARTS)
const placeOrderScratch = new Int32Array(MAX_KARTS)

/** 0-based placement of one kart: 0 is the race leader. */
export function placeIndexOf(state: SimState, playerId: number): number {
  computePlacement(state, placeIndexScratch, placeOrderScratch)
  if (playerId < 0 || playerId >= MAX_KARTS) return MAX_KARTS - 1
  return placeIndexScratch[playerId]
}

/**
 * The single point where the race PRNG is consumed. Only a leader authority
 * rolls: a follower returns 'none' and leaves state.rngCursor exactly as it
 * found it, and takes its item from an incoming 'itemGrant' AuthEvent via
 * applyItemGrant instead.
 */
export function rollItem(ctx: SimContext, state: SimState, placeIdx: number): ItemKind {
  if (!ctx.isLeader) return 'none'
  const r = rngAt(state.raceSeed, state.rngCursor)
  state.rngCursor = state.rngCursor + 1
  return itemForRoll(placeIdx, r)
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npx vitest run packages/sim/test/items.test.ts`

Expected: PASS — 10 tests.

- [ ] **Step 9: Write the failing test for box positions, pickup, and the follower rule**

Append to `packages/sim/test/items.test.ts`. First replace the `../src/items` import block again.

Before:

```typescript
import {
  ITEM_ROLL_ORDER,
  ITEM_WEIGHTS,
  ITEM_WEIGHT_TOTAL,
  itemForRoll,
  placeIndexOf,
  rollItem,
} from '../src/items'
```

After:

```typescript
import {
  applyItemGrant,
  ITEM_BOX_RADIUS,
  ITEM_ROLL_ORDER,
  ITEM_WEIGHTS,
  ITEM_WEIGHT_TOTAL,
  itemBoxWorldPos,
  itemForRoll,
  placeIndexOf,
  rollItem,
  updateItemBoxes,
} from '../src/items'
```

And extend the `../src/types` import on the line below it.

Before:

```typescript
import type { ItemKind } from '../src/types'
```

After:

```typescript
import type { AuthEvent, ItemKind, SimState, Vec3 } from '../src/types'
import { v3 } from '../src/vec3'
```

Then append these tests to the end of the file:

```typescript
// Four boxes: three at the same station so only their lateral offsets differ,
// plus one 0.01 of a lap further down the track.
//
// `s` is arc-normalised [0, 1), never metres. makeStraightTrack's control points
// 1, 2 and 3 are (150, 0, 0), (300, 0, 0) and (450, 0, 0) — evenly spaced and
// collinear — so the Catmull-Rom spline is exactly straight and exactly
// arc-uniform between them:  x = 150 + (s * total - 150.403834),  where
// total = query.totalLength() = 1828.3236243. Control point 1 sits at
// s = 0.0822632 and control point 3 at s = 0.2463480, so s = 0.1 and s = 0.11
// are both inside that span. There the tangent is exactly (1, 0, 0), so
// right = (-t.z, 0, t.x) is exactly (0, 0, 1) and lateral moves purely in +z:
//   s = 0.10 -> x = 182.428528494678
//   s = 0.11 -> x = 200.711764737947   (0.01 * 1828.3236243 = 18.283236243 m on)
//
// The three lateral offsets are 0, +6 and -7 so that the nearest pair is 6 m
// apart — more than 2 * (ITEM_BOX_RADIUS + kartRadius) = 5 m — and the reach
// tests below can sit a kart 2.4 m or 2.6 m from box 0 without straying inside
// another box's radius.
const BOX_TRACK_OVERRIDES = {
  itemBoxes: [
    { s: 0.1, lateral: 0 },
    { s: 0.1, lateral: 6 },
    { s: 0.1, lateral: -7 },
    { s: 0.11, lateral: 0 },
  ],
}

function boxedState(isLeader = true): { ctx: ReturnType<typeof makeContext>; state: SimState } {
  const ctx = makeContext(makeStraightTrack(BOX_TRACK_OVERRIDES), isLeader)
  const state = createState(ctx, 12345, ALL_CHARACTERS)
  state.rngCursor = 0
  // Set the box slots explicitly so these tests do not depend on how Task 5
  // seeds them; createState produces the same four entries.
  state.itemBoxes = [
    { boxIdx: 0, respawnTicks: 0 },
    { boxIdx: 1, respawnTicks: 0 },
    { boxIdx: 2, respawnTicks: 0 },
    { boxIdx: 3, respawnTicks: 0 },
  ]
  // Park every kart far off to the side so only the kart a test moves can
  // reach a box. The boxes sit near (182, 0, 0); a kart at (0, 0, 400) is
  // 440 m away, well beyond ITEM_BOX_RADIUS + kartRadius = 2.5.
  for (let i = 0; i < state.karts.length; i++) {
    state.karts[i].position.x = 0
    state.karts[i].position.z = 400 + i * 50
    state.karts[i].item = 'none'
    state.karts[i].respawnTicks = 0
  }
  return { ctx, state }
}

describe('itemBoxWorldPos', () => {
  it('offsets along the track right vector and advances along +X with s', () => {
    const { ctx } = boxedState()
    const a = v3(0, 0, 0)
    const b = v3(0, 0, 0)
    const c = v3(0, 0, 0)
    const d = v3(0, 0, 0)
    itemBoxWorldPos(ctx, 0, a)
    itemBoxWorldPos(ctx, 1, b)
    itemBoxWorldPos(ctx, 2, c)
    itemBoxWorldPos(ctx, 3, d)
    // Box 0 is the bare centreline point at s = 0.1:
    // x = 150 + (0.1 * 1828.3236243 - 150.403834) = 182.428528494678, y = z = 0.
    expect(a.x).toBeCloseTo(182.428528494678, 6)
    expect(a.y).toBe(0)
    expect(a.z).toBeCloseTo(0, 9)
    // Boxes 0..2 share s = 0.1, so they differ only by lateral along +z, and on
    // this exactly-straight span the right vector is exactly (0, 0, 1).
    expect(b.x - a.x).toBeCloseTo(0, 9)
    expect(b.z - a.z).toBeCloseTo(6, 9)   // lateral +6
    expect(c.z - a.z).toBeCloseTo(-7, 9)  // lateral -7
    // Box 3 sits 0.01 of a lap further along the same +X centreline:
    // 0.01 * 1828.3236243 = 18.283236243 m, and on this span arc length and x
    // advance together exactly, so the difference is that in metres of x.
    expect(d.x - a.x).toBeCloseTo(0.01 * ctx.query.totalLength(), 6)
    expect(d.x - a.x).toBeCloseTo(18.283236243, 6)
    expect(d.z - a.z).toBeCloseTo(0, 9)
  })
})

describe('updateItemBoxes on a leader', () => {
  it('grants an item, starts the respawn timer, and emits one itemGrant', () => {
    const { ctx, state } = boxedState()
    const p = v3(0, 0, 0)
    itemBoxWorldPos(ctx, 0, p)
    state.karts[0].position.x = p.x
    state.karts[0].position.z = p.z
    const events: AuthEvent[] = []

    updateItemBoxes(ctx, state, events)

    expect(state.itemBoxes[0].respawnTicks).toBe(180) // tuning.itemBoxRespawnTicks
    expect(state.rngCursor).toBe(1)
    expect(state.karts[0].item).not.toBe('none')
    expect(events.length).toBe(1)
    expect(events[0].kind).toBe('itemGrant')
    expect(events[0].playerId).toBe(0)
    expect(events[0].entityId).toBe(-1)
    expect(events[0].data).toBe(0) // boxIdx
    expect(events[0].item).toBe(state.karts[0].item)
    // The granted item is the one the table gives for this kart's placement.
    expect(state.karts[0].item).toBe(itemForRoll(placeIndexOf(state, 0), rngAt(12345, 0)))
  })

  it('collects inside 2.5 m and misses outside it', () => {
    // Reach = ITEM_BOX_RADIUS (1.6) + tuning.kartRadius (0.9) = 2.5.
    // Box 1 sits 6 m away in +z, so neither probe below can reach it either:
    // the closer probe is 6 - 2.4 = 3.6 m from it, the farther 6 - 2.6 = 3.4 m.
    expect(ITEM_BOX_RADIUS).toBe(1.6)
    const inside = boxedState()
    const p = v3(0, 0, 0)
    itemBoxWorldPos(inside.ctx, 0, p)
    inside.state.karts[0].position.x = p.x
    inside.state.karts[0].position.z = p.z + 2.4
    updateItemBoxes(inside.ctx, inside.state, [])
    expect(inside.state.itemBoxes[0].respawnTicks).toBe(180)
    expect(inside.state.rngCursor).toBe(1)

    const outside = boxedState()
    itemBoxWorldPos(outside.ctx, 0, p)
    outside.state.karts[0].position.x = p.x
    outside.state.karts[0].position.z = p.z + 2.6
    updateItemBoxes(outside.ctx, outside.state, [])
    expect(outside.state.itemBoxes[0].respawnTicks).toBe(0)
    expect(outside.state.rngCursor).toBe(0)
    expect(outside.state.karts[0].item).toBe('none')
  })

  it('ignores a kart that already holds an item or is respawning', () => {
    const holding = boxedState()
    const p = v3(0, 0, 0)
    itemBoxWorldPos(holding.ctx, 0, p)
    holding.state.karts[0].position.x = p.x
    holding.state.karts[0].position.z = p.z
    holding.state.karts[0].item = 'boost'
    updateItemBoxes(holding.ctx, holding.state, [])
    expect(holding.state.itemBoxes[0].respawnTicks).toBe(0)
    expect(holding.state.rngCursor).toBe(0)
    expect(holding.state.karts[0].item).toBe('boost')

    const respawning = boxedState()
    itemBoxWorldPos(respawning.ctx, 0, p)
    respawning.state.karts[0].position.x = p.x
    respawning.state.karts[0].position.z = p.z
    respawning.state.karts[0].respawnTicks = 5
    updateItemBoxes(respawning.ctx, respawning.state, [])
    expect(respawning.state.itemBoxes[0].respawnTicks).toBe(0)
    expect(respawning.state.rngCursor).toBe(0)
  })

  it('counts a taken box back down to 0 in exactly itemBoxRespawnTicks calls', () => {
    const { ctx, state } = boxedState()
    state.itemBoxes[0].respawnTicks = 180
    // No kart is within reach, so nothing but the timer moves.
    for (let i = 0; i < 179; i++) updateItemBoxes(ctx, state, [])
    expect(state.itemBoxes[0].respawnTicks).toBe(1) // 180 - 179
    updateItemBoxes(ctx, state, [])
    expect(state.itemBoxes[0].respawnTicks).toBe(0) // 180 - 180
    expect(state.rngCursor).toBe(0)
  })

  it('grants at most one item per box per tick', () => {
    const { ctx, state } = boxedState()
    const p = v3(0, 0, 0)
    itemBoxWorldPos(ctx, 0, p)
    // Three karts stacked on the same box; only the lowest playerId collects.
    for (const id of [2, 5, 6]) {
      state.karts[id].position.x = p.x
      state.karts[id].position.z = p.z
    }
    const events: AuthEvent[] = []
    updateItemBoxes(ctx, state, events)
    expect(events.length).toBe(1)
    expect(events[0].playerId).toBe(2)
    expect(state.rngCursor).toBe(1)
    expect(state.karts[5].item).toBe('none')
    expect(state.karts[6].item).toBe('none')
  })
})

describe('updateItemBoxes on a follower', () => {
  it('NEVER advances rngCursor, grants nothing, and emits nothing', () => {
    const { ctx, state } = boxedState(false)
    expect(ctx.isLeader).toBe(false)
    const p = v3(0, 0, 0)
    itemBoxWorldPos(ctx, 0, p)
    // Sit every kart on a box so every pickup path is exercised.
    for (let i = 0; i < state.karts.length; i++) {
      state.karts[i].position.x = p.x
      state.karts[i].position.z = p.z
    }
    const events: AuthEvent[] = []
    for (let i = 0; i < 10; i++) {
      updateItemBoxes(ctx, state, events)
      expect(state.rngCursor).toBe(0)
    }
    expect(state.rngCursor).toBe(0)
    expect(events.length).toBe(0)
    for (let i = 0; i < state.karts.length; i++) {
      expect(state.karts[i].item).toBe('none')
    }
    // The follower still tracks the box: taken on call 1 (set to 180), then
    // decremented on calls 2..10 -> 180 - 9 = 171.
    expect(state.itemBoxes[0].respawnTicks).toBe(171)
  })

  it('takes its item from an incoming itemGrant event', () => {
    const { ctx, state } = boxedState(false)
    expect(state.karts[2].playerId).toBe(2)
    const ev: AuthEvent = {
      eventSeq: 4,
      tick: 30,
      kind: 'itemGrant',
      playerId: 2,
      entityId: -1,
      item: 'surge',
      data: 1,
    }
    applyItemGrant(ctx, state, ev)
    expect(state.karts[2].item).toBe('surge')
    expect(state.rngCursor).toBe(0)
    // The grant also confirms the box, in case the follower had not seen the
    // pickup locally (post-resync).
    expect(state.itemBoxes[1].respawnTicks).toBe(180)
  })

  it('ignores events of any other kind and unknown players', () => {
    const { ctx, state } = boxedState(false)
    applyItemGrant(ctx, state, {
      eventSeq: 5, tick: 31, kind: 'hit', playerId: 2,
      entityId: 7, item: 'bolt', data: 0,
    })
    expect(state.karts[2].item).toBe('none')
    applyItemGrant(ctx, state, {
      eventSeq: 6, tick: 32, kind: 'itemGrant', playerId: 99,
      entityId: -1, item: 'bolt', data: 0,
    })
    for (let i = 0; i < state.karts.length; i++) {
      expect(state.karts[i].item).toBe('none')
    }
    expect(state.rngCursor).toBe(0)
  })
})
```

- [ ] **Step 10: Run test to verify it fails**

Run: `npx vitest run packages/sim/test/items.test.ts -t "updateItemBoxes"`

Expected: FAIL with `TypeError: updateItemBoxes is not a function`.

- [ ] **Step 11: Write minimal implementation — box position, pickup, grant**

Replace the import block at the top of `packages/sim/src/items.ts`.

Before:

```typescript
import type { ItemKind, SimContext, SimState } from './types'
import { MAX_KARTS } from './types'
import { clamp } from './mathutil'
import { rngAt } from './rng'
import { computePlacement } from './placement'
```

After:

```typescript
import type { AuthEvent, ItemKind, SimContext, SimState, Vec3 } from './types'
import { MAX_KARTS } from './types'
import { clamp } from './mathutil'
import { rngAt } from './rng'
import { v3, v3len } from './vec3'
import { emit } from './state'
import { computePlacement } from './placement'
import { kartById } from './entity'
```

Then append to the end of `packages/sim/src/items.ts`:

```typescript
/** Plan-view pickup radius of an item box, in metres. */
export const ITEM_BOX_RADIUS = 1.6

// Hot-path scratch. Never returned, never retained across calls.
const boxPosScratch: Vec3 = v3(0, 0, 0)
const rightScratch: Vec3 = v3(0, 0, 0)

/**
 * World position of track item box `boxIdx`, written into `out`.
 * right = (-t.z, 0, t.x) normalized, and positive lateral is right of travel.
 */
export function itemBoxWorldPos(ctx: SimContext, boxIdx: number, out: Vec3): void {
  const box = ctx.track.itemBoxes[boxIdx]
  const tp = ctx.query.sampleAt(box.s)
  // Read the sample immediately: TrackQuery may hand back a shared scratch.
  const px = tp.position.x
  const py = tp.position.y
  const pz = tp.position.z
  const t = ctx.query.tangentAt(box.s)
  rightScratch.x = -t.z
  rightScratch.y = 0
  rightScratch.z = t.x
  const len = v3len(rightScratch) || 1
  out.x = px + (rightScratch.x / len) * box.lateral
  out.y = py
  out.z = pz + (rightScratch.z / len) * box.lateral
}

/**
 * Ticks every box timer and detects pickups. Pickup is plan-view (x/z only) so
 * a kart hopping or ramp-launched over a box still collects it, and so pickup
 * never depends on ground height.
 *
 * On a leader this rolls the item and emits 'itemGrant'. On a follower it does
 * everything except the roll: the box timer still starts, the cursor is never
 * touched, and the item arrives later through applyItemGrant.
 */
export function updateItemBoxes(ctx: SimContext, state: SimState, events: AuthEvent[]): void {
  const reach = ITEM_BOX_RADIUS + ctx.tuning.kartRadius
  const reachSq = reach * reach
  for (let b = 0; b < state.itemBoxes.length; b++) {
    const box = state.itemBoxes[b]
    if (box.respawnTicks > 0) {
      box.respawnTicks--
      continue
    }
    itemBoxWorldPos(ctx, box.boxIdx, boxPosScratch)
    for (let i = 0; i < state.karts.length; i++) {
      const k = state.karts[i]
      if (k.respawnTicks > 0) continue
      if (k.item !== 'none') continue
      const dx = k.position.x - boxPosScratch.x
      const dz = k.position.z - boxPosScratch.z
      if (dx * dx + dz * dz > reachSq) continue
      box.respawnTicks = ctx.tuning.itemBoxRespawnTicks
      if (ctx.isLeader) {
        const item = rollItem(ctx, state, placeIndexOf(state, k.playerId))
        k.item = item
        emit(state, events, 'itemGrant', k.playerId, -1, item, box.boxIdx)
      }
      break // one box yields one item per tick
    }
  }
}

/**
 * Follower path for an authoritative item grant. `ev.data` carries the boxIdx,
 * so a follower that missed the local pickup (fresh join, post-resync) still
 * puts the box on its respawn timer.
 */
export function applyItemGrant(ctx: SimContext, state: SimState, ev: AuthEvent): void {
  if (ev.kind !== 'itemGrant') return
  const k = kartById(state, ev.playerId)
  if (k === null) return
  k.item = ev.item
  const idx = ev.data
  if (idx >= 0 && idx < state.itemBoxes.length) {
    const box = state.itemBoxes[idx]
    if (box.respawnTicks <= 0) box.respawnTicks = ctx.tuning.itemBoxRespawnTicks
  }
}
```

- [ ] **Step 12: Run test to verify it passes**

Run: `npx vitest run packages/sim/test/items.test.ts`

Expected: PASS — 19 tests.

- [ ] **Step 13: Write the failing test for `useItem` across all eight items**

Append to `packages/sim/test/items.test.ts`. First replace the `../src/items` import block one last time.

Before:

```typescript
import {
  applyItemGrant,
  ITEM_BOX_RADIUS,
  ITEM_ROLL_ORDER,
  ITEM_WEIGHTS,
  ITEM_WEIGHT_TOTAL,
  itemBoxWorldPos,
  itemForRoll,
  placeIndexOf,
  rollItem,
  updateItemBoxes,
} from '../src/items'
```

After:

```typescript
import {
  applyItemGrant,
  BLINK_BOOST_TICKS,
  BLINK_INVULN_TICKS,
  CHARGE_TTL_TICKS,
  ITEM_BOX_RADIUS,
  ITEM_BOOST_TICKS,
  ITEM_DROP_OFFSET,
  ITEM_FIRE_OFFSET,
  ITEM_ROLL_ORDER,
  ITEM_WEIGHTS,
  ITEM_WEIGHT_TOTAL,
  SURGE_TTL_TICKS,
  itemBoxWorldPos,
  itemForRoll,
  placeIndexOf,
  rollItem,
  seekerTargetFor,
  updateItemBoxes,
  useItem,
} from '../src/items'
```

And extend the types import to bring in `MAX_ENTITIES`.

Before:

```typescript
import type { AuthEvent, ItemKind, SimState, Vec3 } from '../src/types'
import { v3 } from '../src/vec3'
```

After:

```typescript
import type { AuthEvent, ItemKind, SimState, Vec3 } from '../src/types'
import { MAX_ENTITIES } from '../src/types'
import { v3 } from '../src/vec3'
```

Then append these tests to the end of the file:

```typescript
function firingState(): { ctx: ReturnType<typeof makeContext>; state: SimState } {
  const ctx = makeContext(makeStraightTrack())
  const state = createState(ctx, 4242, ALL_CHARACTERS)
  state.rngCursor = 0
  state.entityCount = 0
  // Kart 3 fires from (10, 0, 4) pointing along +X: cos(0) = 1, sin(0) = 0, so
  // every offset below lands on exact integers.
  const k = state.karts[3]
  k.position.x = 10
  k.position.y = 0
  k.position.z = 4
  k.heading = 0
  k.item = 'none'
  k.boostTicks = 0
  k.invulnTicks = 0
  k.spinOutTicks = 0
  k.respawnTicks = 0
  k.shielded = false
  // Placement: kart 5 leads on lap 2, kart 3 is second on lap 1.
  state.karts[5].lap.lap = 2
  state.karts[3].lap.lap = 1
  return { ctx, state }
}

describe('seekerTargetFor', () => {
  it('targets the kart one place ahead, and nothing for the leader', () => {
    const { state } = firingState()
    expect(placeIndexOf(state, 5)).toBe(0)
    expect(placeIndexOf(state, 3)).toBe(1)
    expect(seekerTargetFor(state, 3)).toBe(5)
    expect(seekerTargetFor(state, 5)).toBe(-1)
  })
})

describe('useItem — no-entity items', () => {
  it('boost sets a 90-tick burst and consumes the item', () => {
    const { ctx, state } = firingState()
    const k = state.karts[3]
    k.item = 'boost'
    const events: AuthEvent[] = []
    useItem(ctx, state, k, events)
    expect(ITEM_BOOST_TICKS).toBe(90)
    expect(k.boostTicks).toBe(90)
    expect(k.item).toBe('none')
    expect(state.entityCount).toBe(0)
    expect(events.length).toBe(0) // useItem itself emits nothing
  })

  it('boost never shortens a longer burst already running', () => {
    const { ctx, state } = firingState()
    const k = state.karts[3]
    k.item = 'boost'
    k.boostTicks = 120
    useItem(ctx, state, k, [])
    expect(k.boostTicks).toBe(120)
  })

  it('blink grants invulnerability AND speed, with no entity', () => {
    const { ctx, state } = firingState()
    const k = state.karts[3]
    k.item = 'blink'
    const events: AuthEvent[] = []
    useItem(ctx, state, k, events)
    expect(BLINK_INVULN_TICKS).toBe(90)
    expect(BLINK_BOOST_TICKS).toBe(45)
    expect(k.invulnTicks).toBe(90)
    expect(k.boostTicks).toBe(45)
    expect(k.item).toBe('none')
    expect(state.entityCount).toBe(0)
    expect(events.length).toBe(0)
  })

  it('blink never shortens a longer invulnerability already running', () => {
    const { ctx, state } = firingState()
    const k = state.karts[3]
    k.item = 'blink'
    k.invulnTicks = 200
    k.boostTicks = 60
    useItem(ctx, state, k, [])
    expect(k.invulnTicks).toBe(200)
    expect(k.boostTicks).toBe(60)
  })

  it('does nothing at all with no item held', () => {
    const { ctx, state } = firingState()
    const k = state.karts[3]
    k.item = 'none'
    const events: AuthEvent[] = []
    useItem(ctx, state, k, events)
    expect(k.boostTicks).toBe(0)
    expect(k.invulnTicks).toBe(0)
    expect(state.entityCount).toBe(0)
    expect(events.length).toBe(0)
  })

  it('keeps the item instead of wasting it while spun out or respawning', () => {
    const spun = firingState()
    spun.state.karts[3].item = 'boost'
    spun.state.karts[3].spinOutTicks = 10
    useItem(spun.ctx, spun.state, spun.state.karts[3], [])
    expect(spun.state.karts[3].item).toBe('boost')
    expect(spun.state.karts[3].boostTicks).toBe(0)

    const dead = firingState()
    dead.state.karts[3].item = 'seeker'
    dead.state.karts[3].respawnTicks = 30
    useItem(dead.ctx, dead.state, dead.state.karts[3], [])
    expect(dead.state.karts[3].item).toBe('seeker')
    expect(dead.state.entityCount).toBe(0)
  })
})

describe('useItem — entity items', () => {
  it('seeker spawns 2 m ahead at seekerSpeed, homing on the kart in front', () => {
    const { ctx, state } = firingState()
    const k = state.karts[3]
    k.item = 'seeker'
    useItem(ctx, state, k, [])
    expect(state.entityCount).toBe(1)
    const e = state.entities[0]
    expect(e.kind).toBe('seeker')
    expect(e.ownerId).toBe(3)
    expect(ITEM_FIRE_OFFSET).toBe(2)
    expect(e.position.x).toBe(12) // 10 + cos(0) * 2
    expect(e.position.y).toBe(0)
    expect(e.position.z).toBe(4)  // 4 + sin(0) * 2
    expect(e.heading).toBe(0)
    expect(e.targetId).toBe(5)
    expect(e.velocity.x).toBe(55) // tuning.seekerSpeed
    expect(e.velocity.y).toBe(0)
    expect(e.velocity.z).toBe(0)
    expect(e.ttl).toBe(600)       // tuning.entityTtl
    expect(k.item).toBe('none')
  })

  it('bolt spawns 2 m ahead at boltSpeed with no target', () => {
    const { ctx, state } = firingState()
    const k = state.karts[3]
    k.item = 'bolt'
    useItem(ctx, state, k, [])
    expect(state.entityCount).toBe(1)
    const e = state.entities[0]
    expect(e.kind).toBe('bolt')
    expect(e.ownerId).toBe(3)
    expect(e.position.x).toBe(12)
    expect(e.position.z).toBe(4)
    expect(e.targetId).toBe(-1)
    expect(e.velocity.x).toBe(65) // tuning.boltSpeed
    expect(e.velocity.z).toBe(0)
    expect(e.ttl).toBe(600)
  })

  it('slick drops 2 m behind, stationary', () => {
    const { ctx, state } = firingState()
    const k = state.karts[3]
    k.item = 'slick'
    useItem(ctx, state, k, [])
    expect(state.entityCount).toBe(1)
    const e = state.entities[0]
    expect(e.kind).toBe('slick')
    expect(ITEM_DROP_OFFSET).toBe(2)
    expect(e.position.x).toBe(8) // 10 - cos(0) * 2
    expect(e.position.z).toBe(4)
    expect(e.velocity.x).toBe(0)
    expect(e.velocity.y).toBe(0)
    expect(e.velocity.z).toBe(0)
    expect(e.targetId).toBe(-1)
    expect(e.ttl).toBe(600)
  })

  it('bubble spawns on the owner, targets the owner, and raises the shield', () => {
    const { ctx, state } = firingState()
    const k = state.karts[3]
    k.item = 'bubble'
    useItem(ctx, state, k, [])
    expect(state.entityCount).toBe(1)
    const e = state.entities[0]
    expect(e.kind).toBe('bubble')
    expect(e.ownerId).toBe(3)
    expect(e.targetId).toBe(3)
    expect(e.position.x).toBe(10)
    expect(e.position.z).toBe(4)
    expect(e.velocity.x).toBe(0)
    expect(e.velocity.z).toBe(0)
    expect(k.shielded).toBe(true)
  })

  it('surge spawns a 300-tick field owned by the user', () => {
    const { ctx, state } = firingState()
    const k = state.karts[3]
    k.item = 'surge'
    useItem(ctx, state, k, [])
    expect(state.entityCount).toBe(1)
    const e = state.entities[0]
    expect(e.kind).toBe('surge')
    expect(e.ownerId).toBe(3)
    expect(e.targetId).toBe(-1)
    expect(SURGE_TTL_TICKS).toBe(300)
    expect(e.ttl).toBe(300)
    expect(e.position.x).toBe(10)
    expect(e.position.z).toBe(4)
  })

  it('charge spawns a 20-tick blast on the kart', () => {
    const { ctx, state } = firingState()
    const k = state.karts[3]
    k.item = 'charge'
    useItem(ctx, state, k, [])
    expect(state.entityCount).toBe(1)
    const e = state.entities[0]
    expect(e.kind).toBe('charge')
    expect(e.ownerId).toBe(3)
    expect(e.targetId).toBe(-1)
    expect(CHARGE_TTL_TICKS).toBe(20)
    expect(e.ttl).toBe(20)
    expect(e.position.x).toBe(10)
    expect(e.position.z).toBe(4)
  })

  it('consumes the item exactly once', () => {
    const { ctx, state } = firingState()
    const k = state.karts[3]
    k.item = 'bolt'
    useItem(ctx, state, k, [])
    expect(state.entityCount).toBe(1)
    useItem(ctx, state, k, [])
    expect(state.entityCount).toBe(1)
    expect(k.item).toBe('none')
  })

  it('consumes the item and raises no shield when the entity pool is full', () => {
    const { ctx, state } = firingState()
    state.entityCount = MAX_ENTITIES // 32
    const k = state.karts[3]
    k.item = 'bubble'
    useItem(ctx, state, k, [])
    expect(state.entityCount).toBe(MAX_ENTITIES)
    expect(k.item).toBe('none')
    expect(k.shielded).toBe(false)
  })
})
```

- [ ] **Step 14: Run test to verify it fails**

Run: `npx vitest run packages/sim/test/items.test.ts -t "useItem"`

Expected: FAIL with `TypeError: useItem is not a function`.

- [ ] **Step 15: Write minimal implementation — `useItem` and `seekerTargetFor`**

Replace the import block at the top of `packages/sim/src/items.ts`.

Before:

```typescript
import type { AuthEvent, ItemKind, SimContext, SimState, Vec3 } from './types'
import { MAX_KARTS } from './types'
import { clamp } from './mathutil'
import { rngAt } from './rng'
import { v3, v3len } from './vec3'
import { emit } from './state'
import { computePlacement } from './placement'
import { kartById } from './entity'
```

After:

```typescript
import type { AuthEvent, ItemKind, KartState, SimContext, SimState, Vec3 } from './types'
import { MAX_KARTS } from './types'
import { clamp } from './mathutil'
import { rngAt } from './rng'
import { v3, v3len } from './vec3'
import { emit } from './state'
import { computePlacement } from './placement'
import { kartById, spawnEntity } from './entity'
```

Then append to the end of `packages/sim/src/items.ts`:

```typescript
/** Speed burst from the boost item, in ticks (1.5 s at 60 Hz). */
export const ITEM_BOOST_TICKS = 90
/** Speed burst from blink, in ticks (0.75 s). */
export const BLINK_BOOST_TICKS = 45
/** Invulnerability from blink, in ticks (1.5 s). */
export const BLINK_INVULN_TICKS = 90
/** Lifetime of a surge field, in ticks (5 s). */
export const SURGE_TTL_TICKS = 300
/** Lifetime of a charge blast, in ticks (1/3 s). */
export const CHARGE_TTL_TICKS = 20
/** Muzzle offset ahead of the kart for fired projectiles, in metres. */
export const ITEM_FIRE_OFFSET = 2
/** Drop offset behind the kart for dropped hazards, in metres. */
export const ITEM_DROP_OFFSET = 2

const spawnPosScratch: Vec3 = v3(0, 0, 0)

/** playerId one place ahead of `playerId`, or -1 if it is already leading. */
export function seekerTargetFor(state: SimState, playerId: number): number {
  computePlacement(state, placeIndexScratch, placeOrderScratch)
  if (playerId < 0 || playerId >= MAX_KARTS) return -1
  const place = placeIndexScratch[playerId]
  return place <= 0 ? -1 : placeOrderScratch[place - 1]
}

/**
 * spawnEntity takes no velocity, so set it here from the firing heading. The
 * entity is found by scanning the live prefix backwards: it was just appended,
 * so this exits on the first comparison in practice.
 */
function setEntityVelocity(state: SimState, entityId: number, vx: number, vz: number): void {
  if (entityId === -1) return
  for (let i = state.entityCount - 1; i >= 0; i--) {
    const e = state.entities[i]
    if (e.entityId === entityId) {
      e.velocity.x = vx
      e.velocity.y = 0
      e.velocity.z = vz
      return
    }
  }
}

/**
 * Consumes the kart's held item and applies its effect. Covers all eight kinds.
 * Emits nothing itself: spawnEntity owns the 'entitySpawn' event.
 *
 * Not gated on ctx.isLeader — every authority and every follower runs the same
 * entity simulation. Only the *roll* is leader-only.
 */
export function useItem(ctx: SimContext, state: SimState, k: KartState, events: AuthEvent[]): void {
  const item = k.item
  if (item === 'none') return
  // A spun-out or respawning kart holds on to its item rather than wasting it.
  if (k.spinOutTicks > 0 || k.respawnTicks > 0) return

  k.item = 'none'
  const t = ctx.tuning
  const fx = Math.cos(k.heading)
  const fz = Math.sin(k.heading)

  if (item === 'boost') {
    if (k.boostTicks < ITEM_BOOST_TICKS) k.boostTicks = ITEM_BOOST_TICKS
    return
  }

  if (item === 'blink') {
    if (k.boostTicks < BLINK_BOOST_TICKS) k.boostTicks = BLINK_BOOST_TICKS
    if (k.invulnTicks < BLINK_INVULN_TICKS) k.invulnTicks = BLINK_INVULN_TICKS
    return
  }

  if (item === 'seeker') {
    spawnPosScratch.x = k.position.x + fx * ITEM_FIRE_OFFSET
    spawnPosScratch.y = k.position.y
    spawnPosScratch.z = k.position.z + fz * ITEM_FIRE_OFFSET
    const id = spawnEntity(state, 'seeker', k.playerId, spawnPosScratch, k.heading,
      seekerTargetFor(state, k.playerId), t.entityTtl, events)
    setEntityVelocity(state, id, fx * t.seekerSpeed, fz * t.seekerSpeed)
    return
  }

  if (item === 'bolt') {
    spawnPosScratch.x = k.position.x + fx * ITEM_FIRE_OFFSET
    spawnPosScratch.y = k.position.y
    spawnPosScratch.z = k.position.z + fz * ITEM_FIRE_OFFSET
    const id = spawnEntity(state, 'bolt', k.playerId, spawnPosScratch, k.heading,
      -1, t.entityTtl, events)
    setEntityVelocity(state, id, fx * t.boltSpeed, fz * t.boltSpeed)
    return
  }

  if (item === 'slick') {
    spawnPosScratch.x = k.position.x - fx * ITEM_DROP_OFFSET
    spawnPosScratch.y = k.position.y
    spawnPosScratch.z = k.position.z - fz * ITEM_DROP_OFFSET
    const id = spawnEntity(state, 'slick', k.playerId, spawnPosScratch, k.heading,
      -1, t.entityTtl, events)
    setEntityVelocity(state, id, 0, 0)
    return
  }

  if (item === 'bubble') {
    spawnPosScratch.x = k.position.x
    spawnPosScratch.y = k.position.y
    spawnPosScratch.z = k.position.z
    const id = spawnEntity(state, 'bubble', k.playerId, spawnPosScratch, k.heading,
      k.playerId, t.entityTtl, events)
    setEntityVelocity(state, id, 0, 0)
    if (id !== -1) k.shielded = true
    return
  }

  if (item === 'surge') {
    spawnPosScratch.x = k.position.x
    spawnPosScratch.y = k.position.y
    spawnPosScratch.z = k.position.z
    const id = spawnEntity(state, 'surge', k.playerId, spawnPosScratch, k.heading,
      -1, SURGE_TTL_TICKS, events)
    setEntityVelocity(state, id, 0, 0)
    return
  }

  if (item === 'charge') {
    spawnPosScratch.x = k.position.x
    spawnPosScratch.y = k.position.y
    spawnPosScratch.z = k.position.z
    const id = spawnEntity(state, 'charge', k.playerId, spawnPosScratch, k.heading,
      -1, CHARGE_TTL_TICKS, events)
    setEntityVelocity(state, id, 0, 0)
  }
}
```

- [ ] **Step 16: Run test to verify it passes**

Run: `npx vitest run packages/sim/test/items.test.ts`

Expected: PASS — 34 tests.

- [ ] **Step 17: Write the failing test for the `step()` wiring**

Append to `packages/sim/test/items.test.ts`:

```typescript
describe('step() wiring', () => {
  it('runs item boxes once per tick against the new state', async () => {
    const { step } = await import('../src/step')
    const ctx = makeContext(makeStraightTrack(BOX_TRACK_OVERRIDES))
    const prev = createState(ctx, 12345, ALL_CHARACTERS)
    const next = createState(ctx, 12345, ALL_CHARACTERS)
    prev.phase = 'racing'
    prev.tick = 300
    prev.rngCursor = 0
    prev.itemBoxes = [
      { boxIdx: 0, respawnTicks: 0 },
      { boxIdx: 1, respawnTicks: 0 },
      { boxIdx: 2, respawnTicks: 0 },
      { boxIdx: 3, respawnTicks: 0 },
    ]
    // Everyone except kart 0 is parked far off the racing line.
    for (let i = 1; i < prev.karts.length; i++) {
      prev.karts[i].position.z = 400 + i * 50
    }
    const p = v3(0, 0, 0)
    itemBoxWorldPos(ctx, 0, p)
    prev.karts[0].position.x = p.x
    prev.karts[0].position.y = p.y
    prev.karts[0].position.z = p.z
    prev.karts[0].item = 'none'

    const inputs = ALL_CHARACTERS.map(() => ({
      tick: 300, steer: 0, accel: 1, brake: false, drift: false, useItem: false,
    }))
    const events: AuthEvent[] = []
    step(ctx, prev, next, inputs, events)

    expect(next.itemBoxes[0].respawnTicks).toBe(180)
    expect(next.rngCursor).toBe(1)
    expect(next.karts[0].item).not.toBe('none')
    expect(prev.rngCursor).toBe(0) // step never mutates prev
  })

  it('fires the held item from inside the per-kart loop', async () => {
    const { step } = await import('../src/step')
    const ctx = makeContext(makeStraightTrack())
    const prev = createState(ctx, 777, ALL_CHARACTERS)
    const next = createState(ctx, 777, ALL_CHARACTERS)
    prev.phase = 'racing'
    prev.tick = 300
    // Slot 0 must be driven by the supplied Intent rather than by botIntent,
    // which is the distinction resolveInputs [Task 15] keys on once it exists.
    prev.karts[0].isBot = false
    prev.karts[0].connected = true
    prev.karts[0].item = 'boost'
    prev.karts[0].boostTicks = 0
    // Every kart is still at its start position, s = 0.01..0.055 of a lap, i.e.
    // inside the first 0.055 * 1828.3236243 = 100.6 m. The default straight
    // fixture's three item boxes are at s = 0.3, some 450 m further on, so
    // nothing is picked up on this tick and the item slot stays empty.

    const inputs = ALL_CHARACTERS.map((_, i) => ({
      tick: 300, steer: 0, accel: 1, brake: false, drift: false,
      useItem: i === 0,
    }))
    const events: AuthEvent[] = []
    step(ctx, prev, next, inputs, events)

    // useItem grants ITEM_BOOST_TICKS = 90 at the top of the kart loop body, and
    // decayBoost [Task 8] — canonical slot 8, the last statement of that same
    // loop body — spends one of them on the same tick: 90 - 1 = 89.
    expect(next.karts[0].boostTicks).toBe(ITEM_BOOST_TICKS - 1)
    expect(next.karts[0].boostTicks).toBe(89)
    expect(next.karts[0].item).toBe('none')
    // step never mutates prev
    expect(prev.karts[0].item).toBe('boost')
    expect(prev.karts[0].boostTicks).toBe(0)
  })
})
```

- [ ] **Step 18: Run test to verify it fails**

Run: `npx vitest run packages/sim/test/items.test.ts -t "step() wiring"`

Expected: FAIL — 2 failures. `expected 0 to be 180` on the first test, because `step()`
does not call `updateItemBoxes` yet, and `expected 0 to be 89` on the second, because it
does not call `useItem` yet.

- [ ] **Step 19: Wire `useItem` and `updateItemBoxes` into `step()`**

Three edits in `packages/sim/src/step.ts`. Every anchor below is text some earlier task
writes verbatim: the loop header comes from Task 6, `resolveKartCollisions` from Task 10,
`updateEntities` from Task 12. Nothing here edits against a line no task writes.

Edit 1 — add the import. Anchor on the `./kart` import Task 6 puts in the import block:

Before:

```typescript
import { stepKart } from './kart'
```

After:

```typescript
import { stepKart } from './kart'
import { updateItemBoxes, useItem } from './items'
```

(Tasks 7–12 add their own imports around this line; import order does not matter, so
insert after it wherever it now sits.)

Edit 2 — fire the held item at the top of the per-kart loop body, before every stage that
reads `boostTicks`, so a boost fired this tick is already live when `stepKart` runs. The
anchor is the three locals Task 6's loop body opens with:

Before:

```typescript
    const k = next.karts[i]
    const prevKart = prev.karts[i]
    const raw = resolvedInputs[i]
```

After:

```typescript
    const k = next.karts[i]
    const prevKart = prev.karts[i]
    const raw = resolvedInputs[i]
    if (raw.useItem) useItem(ctx, next, k, events)
```

`useItem` therefore runs ahead of `updateRecovery` (canonical slot 2). That ordering is
deliberate and safe: `useItem` refuses to fire while `spinOutTicks > 0` or
`respawnTicks > 0` and **keeps** the item rather than wasting it, so on the tick a timer
runs out the item is simply fired on the following tick instead. Reading those timers
before `updateRecovery` decrements them is what makes that refusal deterministic.

Edit 3 — in the once-per-tick section after the kart loop, insert the box update after
entities, exactly as the contract's canonical order specifies (`resolveKartCollisions` →
`updateEntities` → `updateItemBoxes` → `updatePhase`; `updatePhase` arrives in Task 15,
which anchors on the `updateItemBoxes` line this edit adds):

Before:

```typescript
  resolveKartCollisions(ctx, next)
  updateEntities(ctx, next, events)
```

After:

```typescript
  resolveKartCollisions(ctx, next)
  updateEntities(ctx, next, events)
  updateItemBoxes(ctx, next, events)
```

- [ ] **Step 20: Run the test and the whole sim suite**

Run: `npx vitest run packages/sim/test/items.test.ts && npx tsc --noEmit -p packages/sim && npx vitest run packages/sim`

Expected: PASS — 36 tests in `items.test.ts`, no TypeScript output, and every previously passing sim test still passes.

- [ ] **Step 21: Commit**

```bash
git add packages/sim/src/items.ts packages/sim/test/items.test.ts packages/sim/src/step.ts
git commit -m "feat(sim): item boxes, placement-weighted rolls, and all eight item effects

Rolls are leader-only and are the single consumer of state.rngCursor; a
follower runs the same pickup detection and box timers but takes its item
from an authoritative itemGrant event. Covers boost, seeker, bolt, slick,
bubble, surge, blink and charge."
```

---

### Task 14: Deterministic racing-line bots

**Files:**
- Create: `packages/sim/src/bot.ts`
- Create: `packages/sim/test/bot.test.ts`
- Test: `packages/sim/test/bot.test.ts`

**Interfaces:**

Consumes (all exist before this task; signatures verbatim from the locked contract):
- `packages/sim/src/types.ts` [Task 2] — types `Intent`, `KartState`, `SimContext`, `SimState`, `TrackPoint`, `TrackProjection`; value `MAX_KARTS = 8`
- `packages/sim/src/mathutil.ts` [Task 2] — `export function clamp(v: number, lo: number, hi: number): number`, `export function lerp(a: number, b: number, t: number): number`, `export function wrapAngle(a: number): number` (returns `(-π, π]`)
- `packages/sim/src/rng.ts` [Task 2] — `export function rngAt(seed: number, cursor: number): number` returning `[0, 1)`
- `packages/sim/src/vec3.ts` [Task 2] — `export function v3len(a: Vec3): number`
- `packages/sim/src/entity.ts` [Task 12] — `export function kartById(state: SimState, playerId: number): KartState | null`
- `ctx.query` — the `TrackQuery` built by `buildTrackQuery(track)` [Task 4] — `sampleAt(s): TrackPoint`, `tangentAt(s): Vec3`, `project(p: Vec3): TrackProjection`, `totalLength(): number`
- `packages/sim/test/fixtures/track-fixtures.ts` [Task 3] — `makeStraightTrack(overrides?: Partial<Track>)` (runs along **+X**), `makeCircleTrack(overrides?: Partial<Track>)` (radius 100); and, in the same file but written by [Task 4] because it needs `buildTrackQuery`, `makeContext(track: Track, isLeader?: boolean): SimContext`
- `packages/sim/src/state.ts` [Task 5] — `createState(ctx, seed, characterIdx)`, `cloneState(src, dst)`
- Tuning values used here, from the contract's fixture table: `kartRadius = 0.9`, `driftMinSpeed = 8`

Produces:
- `export function botIntent(ctx: SimContext, state: SimState, playerId: number): Intent` — contract.
  **The returned `Intent` is pooled: one object per `playerId`, overwritten in place on the
  next call for that same `playerId`.** It is never a fresh allocation, and it is never safe
  to retain. Every caller copies the six fields out before doing anything else —
  `resolveInputs` [Task 15] does exactly that, with its own `copyIntent` into its own
  `out: Intent[]`. A caller that stores the reference is aliasing a live buffer and will
  read a different bot's plan on the next tick.
- **Additions** this task defines, because the contract does not name them, all exported so each behaviour is independently testable:
  - `export function botLateralBias(state: SimState, playerId: number): number` — the bot's fixed racing-line offset as a fraction of usable half-width, in `[-BOT_MAX_BIAS, +BOT_MAX_BIAS]`
  - `export function botNoise(state: SimState, playerId: number): number` — the per-tick wander term, in `[-BOT_NOISE_AMPLITUDE, +BOT_NOISE_AMPLITUDE]`
  - `export function botLookaheadS(ctx: SimContext, state: SimState, playerId: number): number` — the **arc-normalised** `s` the bot aims at, wrapped into `[0, 1)`. The lookahead *distance* is metres and is divided by `ctx.query.totalLength()` before it is added to `s`
  - `export function botLateralTarget(ctx: SimContext, state: SimState, playerId: number): number` — bias + noise scaled to metres at the lookahead point
  - `export function botCurvature(ctx: SimContext, state: SimState, playerId: number): number` — radians of heading change per metre between the kart and its lookahead point
  - `export function botRubberDelta(ctx: SimContext, state: SimState, playerId: number): number` — leading human's lap progress minus this bot's, in checkpoint units; `0` when the field is all bots
  - `export function nearestOtherDistance(state: SimState, k: KartState, wantAhead: boolean): number` — plan-view distance to the closest other kart in front of (or behind) `k`, `Infinity` if there is none
  - Constants: `BOT_BIAS_SALT`, `BOT_NOISE_SALT`, `BOT_MAX_BIAS`, `BOT_NOISE_AMPLITUDE`, `BOT_NOISE_PERIOD`, `BOT_NOISE_STRIDE`, `BOT_LOOKAHEAD_BASE`, `BOT_LOOKAHEAD_PER_SPEED`, `BOT_EDGE_MARGIN`, `BOT_STEER_GAIN`, `BOT_DRIFT_LAT_ACCEL`, `BOT_BRAKE_LAT_ACCEL`, `BOT_BRAKE_MIN_SPEED`, `BOT_RUBBER_GAIN`, `BOT_RUBBER_MIN`, `BOT_RUBBER_MAX`, `BOT_AGGRESSIVE_DELTA`, `BOT_AGGRESSIVE_DRIFT_MUL`, `BOT_BOOST_MIN_SPEED`, `BOT_ITEM_STRAIGHT_CURVATURE`, `BOT_SEEKER_RANGE`, `BOT_BOLT_RANGE`, `BOT_SLICK_RANGE`, `BOT_BUBBLE_RANGE`, `BOT_SURGE_RANGE`, `BOT_CHARGE_RANGE`, `BOT_BLINK_RANGE`

Rules this task fixes:

1. **`botIntent` never touches `state.rngCursor`.** Both PRNG draws go through `rngAt` on a *salted seed* at a cursor that is a pure function of `playerId` (and, for noise, of `state.tick`). Nothing in `bot.ts` reads or writes `state.rngCursor`. Item rolling is the only consumer of that cursor, and it lives in Task 13.
2. **`botIntent` returns a pooled object**, one per `playerId`, so the hot path allocates nothing. This is a hard part of the interface, not an optimisation detail: callers must copy the six fields out and must never retain the reference. `resolveInputs` [Task 15] copies out of it with `copyIntent` into its own `out: Intent[]`, and Task 14's own determinism test snapshots with `{ ...botIntent(...) }` before comparing for exactly this reason.
3. **`botIntent` does no phase or 30 Hz gating.** The contract puts "bots recompute an `Intent` only when `state.tick % 2 === 0`, reusing the previous value on odd ticks" on the caller, and phase gating belongs to `resolveInputs` [Task 15]. `bot.ts` computes whenever it is called.
4. **Steering sign follows the contract**: `right = (-t.z, 0, t.x)`, positive `lateral` is right of travel, so a positive `steer` turns the kart to its right, which increases `heading`. On `makeStraightTrack` (+X) the tangent is `(1, 0, 0)` and right is `(0, 0, 1)`, i.e. +z.
5. **`TrackPoint.width` is the full track width**, so the usable half-width is `width * 0.5 - kartRadius * BOT_EDGE_MARGIN`.
6. **`TrackQuery` may return shared scratch objects**, so every `sampleAt` / `tangentAt` / `project` result is read into locals on the line after the call and never retained.
7. Rubber-banding is honest: `Intent.accel` is `0..1`, so a trailing bot can only ask for full throttle. Catch-up is expressed as *leaders easing off* (down to `BOT_RUBBER_MIN`) plus a lower drift threshold when behind, which earns more mini-turbos. Nothing here cheats the physics cap.
8. **Track parameter `s` is arc-normalised `[0, 1)`, never metres** (contract §0), and this is the task the rule bites hardest. `BOT_LOOKAHEAD_BASE` (6) and `BOT_LOOKAHEAD_PER_SPEED` (0.35) are **metres** and metres per m/s, so the lookahead is `sNow + (BOT_LOOKAHEAD_BASE + speed * BOT_LOOKAHEAD_PER_SPEED) / ctx.query.totalLength()`, wrapped into `[0, 1)`. Adding raw metres to `s` puts the aim point most of a lap away and silently makes every corner read as a hairpin. Going the other way, `botCurvature` recovers metres by multiplying its `s`-delta by `totalLength()`.

---

- [ ] **Step 1: Write the failing test for the per-bot lateral bias and noise**

Create `packages/sim/test/bot.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import {
  BOT_LOOKAHEAD_BASE,
  BOT_LOOKAHEAD_PER_SPEED,
  BOT_MAX_BIAS,
  BOT_NOISE_AMPLITUDE,
  BOT_NOISE_PERIOD,
  botLateralBias,
  botLateralTarget,
  botLookaheadS,
  botNoise,
} from '../src/bot'
import { createState } from '../src/state'
import { makeCircleTrack, makeContext, makeStraightTrack } from './fixtures/track-fixtures'

const ALL_CHARACTERS = [0, 1, 2, 3, 4, 5, 6, 7]

/**
 * Puts kart `id` on the centreline at arc-normalised `s` (a fraction of a lap,
 * in [0, 1) — never metres), facing along the track at `speed` m/s.
 *
 * STRAIGHT_S = 0.1 is the station every straight-track test below uses.
 * makeStraightTrack's control points 1, 2 and 3 are (150, 0, 0), (300, 0, 0),
 * (450, 0, 0) — evenly spaced and collinear — so the Catmull-Rom spline between
 * them is exactly straight and exactly arc-uniform:
 *   x = 150 + (s * total - 150.403834),   total = totalLength() = 1828.3236243
 * Control point 1 sits at s = 0.0822632 and control point 3 at s = 0.2463480, so
 * s = 0.1 (x = 182.428528494678) leaves 450 - 182.429 = 267.6 m of that span
 * still ahead — far more than any lookahead used here. Across it the tangent is
 * the exact constant (1, 0, 0) and the right vector, right = (-t.z, 0, t.x), is
 * the exact constant (0, 0, 1): curvature is exactly 0 and a lateral offset
 * moves purely in +z.
 *
 * On makeCircleTrack, total = 628.1351367 and s advances uniformly around the
 * radius-100 circle, so any s is as good as any other.
 */
const STRAIGHT_S = 0.1

function placeOnLine(ctx: ReturnType<typeof makeContext>, state: ReturnType<typeof createState>,
                     id: number, s: number, speed: number): void {
  const tp = ctx.query.sampleAt(s)
  const px = tp.position.x
  const py = tp.position.y
  const pz = tp.position.z
  const t = ctx.query.tangentAt(s)
  const heading = Math.atan2(t.z, t.x) // contract: h = atan2(dir.z, dir.x)
  const k = state.karts[id]
  k.position.x = px
  k.position.y = py
  k.position.z = pz
  k.heading = heading
  k.velocity.x = Math.cos(heading) * speed
  k.velocity.y = 0
  k.velocity.z = Math.sin(heading) * speed
  k.airborne = false
  k.spinOutTicks = 0
  k.respawnTicks = 0
  k.item = 'none'
}

describe('botLateralBias', () => {
  it('is a bounded, deterministic function of (raceSeed, playerId)', () => {
    const ctx = makeContext(makeStraightTrack())
    const state = createState(ctx, 12345, ALL_CHARACTERS)
    expect(BOT_MAX_BIAS).toBe(0.55)
    for (let id = 0; id < 8; id++) {
      const a = botLateralBias(state, id)
      const b = botLateralBias(state, id)
      expect(a).toBe(b)
      expect(a).toBeGreaterThanOrEqual(-0.55)
      expect(a).toBeLessThanOrEqual(0.55)
    }
  })

  it('never advances state.rngCursor, whatever the tick', () => {
    const ctx = makeContext(makeStraightTrack())
    const state = createState(ctx, 12345, ALL_CHARACTERS)
    state.rngCursor = 7
    for (let tick = 0; tick < 200; tick++) {
      state.tick = tick
      for (let id = 0; id < 8; id++) {
        botLateralBias(state, id)
        botNoise(state, id)
      }
    }
    expect(state.rngCursor).toBe(7)
  })

  it('gives all eight bots different lines', () => {
    const ctx = makeContext(makeStraightTrack())
    const state = createState(ctx, 12345, ALL_CHARACTERS)
    const biases = new Set<number>()
    for (let id = 0; id < 8; id++) biases.add(botLateralBias(state, id))
    // Eight independent splitmix32 draws. Equal values would mean the mixer is
    // broken, not that the bots are meant to share a line.
    expect(biases.size).toBe(8)
  })

  it('changes with the race seed', () => {
    const ctx = makeContext(makeStraightTrack())
    const a = createState(ctx, 12345, ALL_CHARACTERS)
    const b = createState(ctx, 6789, ALL_CHARACTERS)
    let differing = 0
    for (let id = 0; id < 8; id++) {
      if (botLateralBias(a, id) !== botLateralBias(b, id)) differing++
    }
    expect(differing).toBe(8)
  })
})

describe('botNoise', () => {
  it('stays inside the amplitude and moves in small steps', () => {
    const ctx = makeContext(makeStraightTrack())
    const state = createState(ctx, 12345, ALL_CHARACTERS)
    expect(BOT_NOISE_AMPLITUDE).toBe(0.18)
    expect(BOT_NOISE_PERIOD).toBe(30)
    // The noise is a piecewise-linear ramp between one draw per 30-tick phase,
    // and phase p's end draw is phase p+1's start draw, so it is continuous.
    // Worst-case step = 2 * 0.18 / 30 = 0.012 per tick.
    let prev = 0
    for (let tick = 0; tick <= 120; tick++) {
      state.tick = tick
      const n = botNoise(state, 4)
      expect(n).toBeGreaterThanOrEqual(-0.18)
      expect(n).toBeLessThanOrEqual(0.18)
      if (tick > 0) expect(Math.abs(n - prev)).toBeLessThanOrEqual(0.012 + 1e-9)
      prev = n
    }
  })

  it('actually varies inside a single phase', () => {
    const ctx = makeContext(makeStraightTrack())
    const state = createState(ctx, 12345, ALL_CHARACTERS)
    const seen = new Set<number>()
    for (let tick = 0; tick < 30; tick++) {
      state.tick = tick
      seen.add(botNoise(state, 4))
    }
    // 30 distinct interpolation fractions on a ramp of non-zero slope.
    expect(seen.size).toBe(30)
  })

  it('gives the eight bots independent noise streams at the same tick', () => {
    const ctx = makeContext(makeStraightTrack())
    const state = createState(ctx, 12345, ALL_CHARACTERS)
    state.tick = 17
    const seen = new Set<number>()
    for (let id = 0; id < 8; id++) seen.add(botNoise(state, id))
    expect(seen.size).toBe(8)
  })
})

describe('botLateralTarget', () => {
  it('scales bias plus noise into metres and stays inside the usable width', () => {
    const ctx = makeContext(makeStraightTrack())
    const state = createState(ctx, 12345, ALL_CHARACTERS)
    state.tick = 0
    const targets = new Set<number>()
    for (let id = 0; id < 8; id++) {
      const sLook = ctx.query.totalLength() > 0
        ? ctx.query.project(state.karts[id].position).s
        : 0
      const tp = ctx.query.sampleAt(sLook)
      // usable = width/2 - kartRadius * BOT_EDGE_MARGIN = width/2 - 0.9 * 1.5
      const usable = Math.max(0, tp.width * 0.5 - 0.9 * 1.5)
      const target = botLateralTarget(ctx, state, id)
      // |bias| + |noise| <= 0.55 + 0.18 = 0.73 of the usable half-width.
      expect(Math.abs(target)).toBeLessThanOrEqual(usable * 0.73 + 1e-9)
      targets.add(target)
    }
    expect(targets.size).toBe(8)
  })
})

describe('botLookaheadS', () => {
  it('adds metres of lookahead as a fraction of a lap, not as raw s', () => {
    const ctx = makeContext(makeStraightTrack())
    const state = createState(ctx, 12345, ALL_CHARACTERS)
    const total = ctx.query.totalLength() // 1828.3236243
    expect(BOT_LOOKAHEAD_BASE).toBe(6)
    expect(BOT_LOOKAHEAD_PER_SPEED).toBe(0.35)

    // At rest the lookahead is BOT_LOOKAHEAD_BASE = 6 m, which is
    // 6 / 1828.3236243 = 0.0032816947 of a lap:
    // 0.1 + 0.0032816947 = 0.1032816947
    placeOnLine(ctx, state, 3, STRAIGHT_S, 0)
    expect(botLookaheadS(ctx, state, 3)).toBeCloseTo(STRAIGHT_S + 6 / total, 9)
    expect(botLookaheadS(ctx, state, 3)).toBeCloseTo(0.1032816947, 9)

    // At 30 m/s it is 6 + 30 * 0.35 = 16.5 m, i.e.
    // 16.5 / 1828.3236243 = 0.0090246605 of a lap:
    // 0.1 + 0.0090246605 = 0.1090246605
    placeOnLine(ctx, state, 3, STRAIGHT_S, 30)
    expect(botLookaheadS(ctx, state, 3)).toBeCloseTo(STRAIGHT_S + 16.5 / total, 9)
    expect(botLookaheadS(ctx, state, 3)).toBeCloseTo(0.1090246605, 9)
  })

  it('wraps past the start line and never leaves [0, 1)', () => {
    const ctx = makeContext(makeCircleTrack())
    const state = createState(ctx, 12345, ALL_CHARACTERS)
    const total = ctx.query.totalLength() // 628.1351367
    // 6 + 44 * 0.35 = 21.4 m = 21.4 / 628.1351367 = 0.0340691019 of a lap, so
    // from s = 0.99 the aim point is 1.0240691019, which wraps to 0.0240691019.
    placeOnLine(ctx, state, 3, 0.99, 44)
    const s = botLookaheadS(ctx, state, 3)
    expect(s).toBeCloseTo(0.99 + 21.4 / total - 1, 9)
    expect(s).toBeCloseTo(0.0240691019, 9)
    expect(s).toBeGreaterThanOrEqual(0)
    expect(s).toBeLessThan(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/sim/test/bot.test.ts`

Expected: FAIL with `Failed to resolve import "../src/bot" from "packages/sim/test/bot.test.ts"` —
the whole file, all four describe blocks, because `src/bot.ts` does not exist yet.

- [ ] **Step 3: Write minimal implementation — bias, noise, lookahead, lateral target**

Create `packages/sim/src/bot.ts`:

```typescript
import type { SimContext, SimState } from './types'
import { clamp, lerp } from './mathutil'
import { rngAt } from './rng'
import { v3len } from './vec3'
import { kartById } from './entity'

/** Seed salt for the fixed per-bot racing-line offset. */
export const BOT_BIAS_SALT = 0x5f3a7b1d
/** Seed salt for the per-bot wander stream. */
export const BOT_NOISE_SALT = 0x2c1b3f91
/** Max fixed offset, as a fraction of usable half-width. */
export const BOT_MAX_BIAS = 0.55
/** Max wander, as a fraction of usable half-width. */
export const BOT_NOISE_AMPLITUDE = 0.18
/** Ticks between wander draws (0.5 s at 60 Hz). */
export const BOT_NOISE_PERIOD = 30
/** Cursor stride between bots in the wander stream. */
export const BOT_NOISE_STRIDE = 4096
/** Lookahead at a standstill, in metres. */
export const BOT_LOOKAHEAD_BASE = 6
/** Extra lookahead metres per m/s of speed. */
export const BOT_LOOKAHEAD_PER_SPEED = 0.35
/** Kart radii of clearance kept off the track edge. */
export const BOT_EDGE_MARGIN = 1.5

/**
 * Fractional part of an arc-normalised s, in [0, 1). Track s wraps: the loop is
 * closed. track.ts keeps its own copy of this; it is not exported, so bot.ts
 * carries its own two-line version rather than widening another module's API.
 */
function wrap01(s: number): number {
  const w = s - Math.floor(s)
  return w === 1 ? 0 : w
}

/**
 * Fixed racing-line offset for one bot, in [-BOT_MAX_BIAS, BOT_MAX_BIAS] as a
 * fraction of usable half-width.
 *
 * The cursor passed to rngAt is the playerId itself — constant for the whole
 * race — and the seed is salted, so this is a pure function of
 * (raceSeed, playerId) that neither reads nor advances state.rngCursor.
 */
export function botLateralBias(state: SimState, playerId: number): number {
  return (rngAt(state.raceSeed ^ BOT_BIAS_SALT, playerId) * 2 - 1) * BOT_MAX_BIAS
}

/**
 * Per-tick wander, so eight bots on the same line do not drive perfectly
 * parallel. Piecewise-linear between one draw per BOT_NOISE_PERIOD ticks;
 * phase p's end draw is phase p+1's start draw, so the result is continuous.
 * Cursors are (playerId * BOT_NOISE_STRIDE + phase): a 3-lap race is a few
 * thousand ticks, i.e. a couple of hundred phases, so bots never collide in
 * the cursor space. state.rngCursor is untouched.
 */
export function botNoise(state: SimState, playerId: number): number {
  const seed = state.raceSeed ^ BOT_NOISE_SALT
  const phase = Math.floor(state.tick / BOT_NOISE_PERIOD)
  const base = playerId * BOT_NOISE_STRIDE + phase
  const n0 = rngAt(seed, base)
  const n1 = rngAt(seed, base + 1)
  const f = (state.tick - phase * BOT_NOISE_PERIOD) / BOT_NOISE_PERIOD
  return (lerp(n0, n1, f) * 2 - 1) * BOT_NOISE_AMPLITUDE
}

/**
 * The arc-normalised s the bot aims at, wrapped into [0, 1).
 *
 * BOT_LOOKAHEAD_BASE and BOT_LOOKAHEAD_PER_SPEED are metres and metres per m/s,
 * while s is a fraction of a lap, so the lookahead distance is divided by
 * totalLength() before it is added. Adding the metres directly would push the
 * aim point most of a lap ahead and make every corner read as a hairpin.
 */
export function botLookaheadS(ctx: SimContext, state: SimState, playerId: number): number {
  const k = kartById(state, playerId)
  if (k === null) return 0
  const speed = v3len(k.velocity)
  const proj = ctx.query.project(k.position)
  const sNow = proj.s // read immediately: project() may return shared scratch
  const total = ctx.query.totalLength()
  if (!(total > 0)) return wrap01(sNow)
  const metres = BOT_LOOKAHEAD_BASE + speed * BOT_LOOKAHEAD_PER_SPEED
  return wrap01(sNow + metres / total)
}

/** Bias + noise, scaled to metres against the width at the lookahead point. */
export function botLateralTarget(ctx: SimContext, state: SimState, playerId: number): number {
  const k = kartById(state, playerId)
  if (k === null) return 0
  const tp = ctx.query.sampleAt(botLookaheadS(ctx, state, playerId))
  const width = tp.width // read immediately: sampleAt() may return shared scratch
  const usable = Math.max(0, width * 0.5 - ctx.tuning.kartRadius * BOT_EDGE_MARGIN)
  const f = clamp(botLateralBias(state, playerId) + botNoise(state, playerId), -1, 1)
  return f * usable
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/sim/test/bot.test.ts`

Expected: PASS — 10 tests.

Note: the `botLateralTarget` test computes `usable` from `project(...).s` rather than the lookahead `s`, which is the same value on the constant-width straight fixture (`width` is 20 at every control point).

- [ ] **Step 5: Write the failing test for curvature, rubber-banding, and proximity**

Append to `packages/sim/test/bot.test.ts`. First replace the `../src/bot` import block at the top of the file.

Before:

```typescript
import {
  BOT_LOOKAHEAD_BASE,
  BOT_LOOKAHEAD_PER_SPEED,
  BOT_MAX_BIAS,
  BOT_NOISE_AMPLITUDE,
  BOT_NOISE_PERIOD,
  botLateralBias,
  botLateralTarget,
  botLookaheadS,
  botNoise,
} from '../src/bot'
```

After:

```typescript
import {
  BOT_LOOKAHEAD_BASE,
  BOT_LOOKAHEAD_PER_SPEED,
  BOT_MAX_BIAS,
  BOT_NOISE_AMPLITUDE,
  BOT_NOISE_PERIOD,
  BOT_RUBBER_GAIN,
  BOT_RUBBER_MIN,
  botCurvature,
  botLateralBias,
  botLateralTarget,
  botLookaheadS,
  botNoise,
  botRubberDelta,
  nearestOtherDistance,
} from '../src/bot'
```

The `./fixtures/track-fixtures` import already brings in `makeCircleTrack`, from the first
test block.

Then append these tests to the end of the file:

```typescript
/**
 * Parks every kart except `keep` far away so proximity tests are clean.
 * `placeOnLine` and `STRAIGHT_S` are already at the top of this file, from the
 * first test block.
 */
function scatter(state: ReturnType<typeof createState>, keep: number[]): void {
  for (let i = 0; i < state.karts.length; i++) {
    if (keep.indexOf(i) >= 0) continue
    state.karts[i].position.x = 0
    state.karts[i].position.z = 5000 + i * 100
    state.karts[i].respawnTicks = 0
  }
}

describe('botCurvature', () => {
  it('is exactly 0 on the straight span of the straight fixture', () => {
    const ctx = makeContext(makeStraightTrack())
    const state = createState(ctx, 12345, ALL_CHARACTERS)
    // s = 0.1 is x = 182.43 and the 16.5 m lookahead reaches x = 198.93; both
    // sit between control points 1 (x = 150) and 3 (x = 450), where the four
    // spline control values are collinear and evenly spaced, so the tangent is
    // the exact constant (1, 0, 0). hB - hA is therefore exactly 0, not merely
    // small, and 0 / 16.5 m = 0.
    placeOnLine(ctx, state, 2, STRAIGHT_S, 30)
    expect(botCurvature(ctx, state, 2)).toBe(0)
  })

  it('is ~1/R on the radius-100 circle, independent of speed', () => {
    const ctx = makeContext(makeCircleTrack())
    const state = createState(ctx, 12345, ALL_CHARACTERS)
    // The 16-point Catmull-Rom circle measures 628.1351367 m round instead of
    // 628.3185307, so the heading swept per metre is very slightly over 1/100.
    // At 44 m/s the arc is 6 + 44 * 0.35 = 21.4 m and the curvature comes out
    // at 0.0099571; at 15 m/s the arc is 11.25 m and it comes out at 0.0103463.
    // The band below is 1/R = 0.01 +/- 20%, which both clear comfortably.
    placeOnLine(ctx, state, 2, 0, 44)
    const fast = botCurvature(ctx, state, 2)
    placeOnLine(ctx, state, 2, 0, 15)
    const slow = botCurvature(ctx, state, 2)
    expect(fast).toBeCloseTo(0.0099571, 6)
    expect(slow).toBeCloseTo(0.0103463, 6)
    expect(fast).toBeGreaterThan(0.008)
    expect(fast).toBeLessThan(0.012)
    expect(slow).toBeGreaterThan(0.008)
    expect(slow).toBeLessThan(0.012)
  })
})

describe('botRubberDelta', () => {
  it('is 0 when nobody in the field is human', () => {
    const ctx = makeContext(makeStraightTrack())
    const state = createState(ctx, 12345, ALL_CHARACTERS)
    for (let i = 0; i < state.karts.length; i++) state.karts[i].isBot = true
    state.karts[1].lap.lap = 2
    expect(botRubberDelta(ctx, state, 3)).toBe(0)
  })

  it('is negative for a bot ahead of the leading human', () => {
    const ctx = makeContext(makeStraightTrack())
    const state = createState(ctx, 12345, ALL_CHARACTERS)
    for (let i = 0; i < state.karts.length; i++) state.karts[i].isBot = true
    state.karts[0].isBot = false
    // Same lap, so the checkpoint-count term cancels:
    // human 0 at cp 1 t 0.25, bot 1 at cp 3 t 0.50
    // delta = (1 + 0.25) - (3 + 0.50) = -2.25
    state.karts[0].lap.lap = 2
    state.karts[0].lap.checkpointIdx = 1
    state.karts[0].lap.t = 0.25
    state.karts[1].lap.lap = 2
    state.karts[1].lap.checkpointIdx = 3
    state.karts[1].lap.t = 0.5
    expect(botRubberDelta(ctx, state, 1)).toBeCloseTo(-2.25, 10)
  })

  it('is positive and lap-scaled for a bot behind the leading human', () => {
    const ctx = makeContext(makeStraightTrack())
    const state = createState(ctx, 12345, ALL_CHARACTERS)
    for (let i = 0; i < state.karts.length; i++) state.karts[i].isBot = true
    state.karts[0].isBot = false
    state.karts[0].lap.lap = 2
    state.karts[0].lap.checkpointIdx = 3
    state.karts[0].lap.t = 0.5
    state.karts[1].lap.lap = 0
    state.karts[1].lap.checkpointIdx = 1
    state.karts[1].lap.t = 0.25
    // delta = 2*cp + (3 - 1) + (0.5 - 0.25) = 2*cp + 2.25
    const cp = ctx.track.checkpointS.length
    expect(botRubberDelta(ctx, state, 1)).toBeCloseTo(2 * cp + 2.25, 10)
  })

  it('takes the leading human when there are several', () => {
    const ctx = makeContext(makeStraightTrack())
    const state = createState(ctx, 12345, ALL_CHARACTERS)
    for (let i = 0; i < state.karts.length; i++) state.karts[i].isBot = true
    state.karts[0].isBot = false
    state.karts[6].isBot = false
    state.karts[0].lap.lap = 1
    state.karts[0].lap.checkpointIdx = 0
    state.karts[0].lap.t = 0
    state.karts[6].lap.lap = 1
    state.karts[6].lap.checkpointIdx = 4
    state.karts[6].lap.t = 0
    state.karts[1].lap.lap = 1
    state.karts[1].lap.checkpointIdx = 1
    state.karts[1].lap.t = 0
    // Leading human is kart 6 at cp 4: delta = 4 - 1 = 3
    expect(botRubberDelta(ctx, state, 1)).toBeCloseTo(3, 10)
    expect(BOT_RUBBER_GAIN).toBe(0.06)
    expect(BOT_RUBBER_MIN).toBe(0.82)
  })
})

describe('nearestOtherDistance', () => {
  it('splits the field by the kart forward axis and measures in plan view', () => {
    const ctx = makeContext(makeStraightTrack())
    const state = createState(ctx, 12345, ALL_CHARACTERS)
    scatter(state, [3, 1, 4])
    const k = state.karts[3]
    k.position.x = 0
    k.position.y = 0
    k.position.z = 0
    k.heading = 0 // forward = (1, 0, 0)
    state.karts[1].position.x = 30 // 30 m ahead
    state.karts[1].position.z = 0
    state.karts[4].position.x = -12 // 12 m behind
    state.karts[4].position.z = 0
    expect(nearestOtherDistance(state, k, true)).toBeCloseTo(30, 9)
    expect(nearestOtherDistance(state, k, false)).toBeCloseTo(12, 9)
  })

  it('returns Infinity when the requested side is empty, and skips respawners', () => {
    const ctx = makeContext(makeStraightTrack())
    const state = createState(ctx, 12345, ALL_CHARACTERS)
    scatter(state, [3, 1])
    const k = state.karts[3]
    k.position.x = 0
    k.position.z = 0
    k.heading = 0
    state.karts[1].position.x = 20
    state.karts[1].position.z = 0
    expect(nearestOtherDistance(state, k, false)).toBe(Infinity)
    state.karts[1].respawnTicks = 10
    expect(nearestOtherDistance(state, k, true)).toBe(Infinity)
  })
})
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run packages/sim/test/bot.test.ts -t "botCurvature"`

Expected: FAIL with `TypeError: botCurvature is not a function`.

- [ ] **Step 7: Write minimal implementation — curvature, rubber-banding, proximity**

Replace the import block at the top of `packages/sim/src/bot.ts`.

Before:

```typescript
import type { SimContext, SimState } from './types'
import { clamp, lerp } from './mathutil'
import { rngAt } from './rng'
import { v3len } from './vec3'
import { kartById } from './entity'
```

After:

```typescript
import type { KartState, SimContext, SimState } from './types'
import { clamp, lerp, wrapAngle } from './mathutil'
import { rngAt } from './rng'
import { v3len } from './vec3'
import { kartById } from './entity'
```

Then append to the end of `packages/sim/src/bot.ts`:

```typescript
/** Lateral acceleration (m/s^2) above which a bot drifts through the corner. */
export const BOT_DRIFT_LAT_ACCEL = 12
/** Lateral acceleration above which a bot also brakes. */
export const BOT_BRAKE_LAT_ACCEL = 26
/** Below this speed a bot never brakes for a corner. */
export const BOT_BRAKE_MIN_SPEED = 25
/** Throttle change per checkpoint-unit of lap-progress deficit. */
export const BOT_RUBBER_GAIN = 0.06
/** Floor on a leading bot's throttle. */
export const BOT_RUBBER_MIN = 0.82
/** Ceiling on throttle: Intent.accel is 0..1 and bots never exceed it. */
export const BOT_RUBBER_MAX = 1
/** Progress deficit past which a bot drives more aggressively. */
export const BOT_AGGRESSIVE_DELTA = 1
/** Drift threshold multiplier while behind: drift earlier, earn more turbos. */
export const BOT_AGGRESSIVE_DRIFT_MUL = 0.7

/**
 * Radians of heading change per metre between the kart and its lookahead
 * point. Speed-independent for a constant-radius corner, because the extra
 * lookahead a faster kart uses scales the arc and the angle together.
 */
export function botCurvature(ctx: SimContext, state: SimState, playerId: number): number {
  const k = kartById(state, playerId)
  if (k === null) return 0
  const proj = ctx.query.project(k.position)
  const sNow = proj.s // read immediately: project() may return shared scratch
  const sLook = botLookaheadS(ctx, state, playerId)
  const total = ctx.query.totalLength()
  // sNow and sLook are both arc-normalised [0, 1). Take the forward-going
  // difference around the closed loop, then convert it to metres: curvature is
  // radians per metre, so the denominator must not be a fraction of a lap.
  let ds = sLook - sNow
  if (ds < 0) ds += 1 // the lookahead wrapped past the start line
  const arc = ds * total
  if (arc < 1e-6) return 0
  const tA = ctx.query.tangentAt(sNow)
  const hA = Math.atan2(tA.z, tA.x) // read immediately: shared scratch
  const tB = ctx.query.tangentAt(sLook)
  const hB = Math.atan2(tB.z, tB.x)
  return Math.abs(wrapAngle(hB - hA)) / arc
}

/**
 * Leading human's lap progress minus this bot's, in checkpoint units.
 * Positive means the bot is behind. 0 when the field is all bots — a kart
 * taken over by a bot after a disconnect has isBot flipped by the net layer,
 * so no `connected` check is needed here.
 */
export function botRubberDelta(ctx: SimContext, state: SimState, playerId: number): number {
  const k = kartById(state, playerId)
  if (k === null) return 0
  const cp = ctx.track.checkpointS.length
  let lead = -Infinity
  for (let i = 0; i < state.karts.length; i++) {
    const o = state.karts[i]
    if (o.isBot) continue
    const p = o.lap.lap * cp + o.lap.checkpointIdx + clamp(o.lap.t, 0, 1)
    if (p > lead) lead = p
  }
  if (lead === -Infinity) return 0
  const mine = k.lap.lap * cp + k.lap.checkpointIdx + clamp(k.lap.t, 0, 1)
  return lead - mine
}

/**
 * Plan-view distance to the closest other kart in front of (wantAhead) or
 * behind `k`, split by the sign of the along-forward component. Infinity when
 * that side is empty. Scans by slot index, so it is order-deterministic.
 */
export function nearestOtherDistance(state: SimState, k: KartState, wantAhead: boolean): number {
  const fx = Math.cos(k.heading)
  const fz = Math.sin(k.heading)
  let best = Infinity
  for (let i = 0; i < state.karts.length; i++) {
    const o = state.karts[i]
    if (o.playerId === k.playerId) continue
    if (o.respawnTicks > 0) continue
    const dx = o.position.x - k.position.x
    const dz = o.position.z - k.position.z
    const along = dx * fx + dz * fz
    if (wantAhead ? along <= 0 : along >= 0) continue
    const d = Math.sqrt(dx * dx + dz * dz)
    if (d < best) best = d
  }
  return best
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npx vitest run packages/sim/test/bot.test.ts`

Expected: PASS — 18 tests.

- [ ] **Step 9: Write the failing test for `botIntent` steering, throttle, drift and brake**

Append to `packages/sim/test/bot.test.ts`. First replace the `../src/bot` import block again.

Before:

```typescript
import {
  BOT_LOOKAHEAD_BASE,
  BOT_LOOKAHEAD_PER_SPEED,
  BOT_MAX_BIAS,
  BOT_NOISE_AMPLITUDE,
  BOT_NOISE_PERIOD,
  BOT_RUBBER_GAIN,
  BOT_RUBBER_MIN,
  botCurvature,
  botLateralBias,
  botLateralTarget,
  botLookaheadS,
  botNoise,
  botRubberDelta,
  nearestOtherDistance,
} from '../src/bot'
```

After:

```typescript
import {
  BOT_LOOKAHEAD_BASE,
  BOT_LOOKAHEAD_PER_SPEED,
  BOT_MAX_BIAS,
  BOT_NOISE_AMPLITUDE,
  BOT_NOISE_PERIOD,
  BOT_RUBBER_GAIN,
  BOT_RUBBER_MIN,
  BOT_STEER_GAIN,
  botCurvature,
  botIntent,
  botLateralBias,
  botLateralTarget,
  botLookaheadS,
  botNoise,
  botRubberDelta,
  nearestOtherDistance,
} from '../src/bot'
```

And add `cloneState` to the state import.

Before:

```typescript
import { createState } from '../src/state'
```

After:

```typescript
import { cloneState, createState } from '../src/state'
```

Then append these tests to the end of the file:

```typescript
describe('botIntent — steering', () => {
  it('stamps the current tick', () => {
    const ctx = makeContext(makeStraightTrack())
    const state = createState(ctx, 12345, ALL_CHARACTERS)
    state.tick = 123
    placeOnLine(ctx, state, 3, STRAIGHT_S, 20)
    expect(botIntent(ctx, state, 3).tick).toBe(123)
  })

  it('steers toward its own lateral target with the contract sign', () => {
    const ctx = makeContext(makeStraightTrack())
    const state = createState(ctx, 12345, ALL_CHARACTERS)
    state.tick = 0
    for (let id = 0; id < 8; id++) {
      // speed 0 -> the lookahead is exactly BOT_LOOKAHEAD_BASE = 6 m, i.e.
      // 6 / 1828.3236243 = 0.0032816947 of a lap past STRAIGHT_S. Both ends sit
      // on the exactly-straight span, so the aim point is exactly 6 m ahead in
      // x (5.99999995 after the projector's refine tolerance) and `lat` m across
      // in z, measured from a kart at z = 0 with heading 0.
      placeOnLine(ctx, state, id, STRAIGHT_S, 0)
      const lat = botLateralTarget(ctx, state, id)
      const expected = clampTo1(Math.atan2(lat, BOT_LOOKAHEAD_BASE) * BOT_STEER_GAIN)
      const intent = botIntent(ctx, state, id)
      // The only error is the 5e-8 m the ternary-search projector leaves in x,
      // which moves the aim angle by under 1e-8 rad and the steer by under
      // 2e-8. Precision 6 (5e-7) covers that with three orders to spare.
      expect(intent.steer).toBeCloseTo(expected, 6)
      expect(Math.sign(intent.steer)).toBe(Math.sign(lat))
    }
    expect(BOT_STEER_GAIN).toBe(1.6)
  })

  it('saturates back toward the line from far off it', () => {
    const ctx = makeContext(makeStraightTrack())
    const state = createState(ctx, 12345, ALL_CHARACTERS)
    state.tick = 0
    placeOnLine(ctx, state, 3, STRAIGHT_S, 0)
    const centreZ = state.karts[3].position.z // exactly 0 on this span
    // 40 m right of the line, 6 m of lookahead. The aim point's own lateral is
    // at most 0.73 * (20/2 - 0.9 * 1.5) = 6.315 m, so the cross-track term is at
    // least 40 - 6.315 = 33.685 m and the aim angle is at least
    // atan2(33.685, 6) = 1.394 rad. Times BOT_STEER_GAIN 1.6 that is 2.23, well
    // past the clamp — and past the 0.625 rad at which the clamp first bites.
    // The kart is still nearest the front straight (z = 0 is 40 m away, the
    // return leg at z = 120 is 80 m), so it projects onto the same span.
    state.karts[3].position.z = centreZ + 40
    expect(botIntent(ctx, state, 3).steer).toBe(-1)
    state.karts[3].position.z = centreZ - 40
    expect(botIntent(ctx, state, 3).steer).toBe(1)
  })
})

function clampTo1(v: number): number {
  return v < -1 ? -1 : v > 1 ? 1 : v
}

describe('botIntent — throttle, drift and brake', () => {
  it('holds full throttle when behind and eases off when ahead', () => {
    const ctx = makeContext(makeStraightTrack())
    const state = createState(ctx, 12345, ALL_CHARACTERS)
    for (let i = 0; i < state.karts.length; i++) state.karts[i].isBot = true
    state.karts[0].isBot = false
    placeOnLine(ctx, state, 1, STRAIGHT_S, 20)

    // Bot 2.25 checkpoint-units ahead of the human:
    // accel = 1 + (-2.25 * 0.06) = 1 - 0.135 = 0.865
    state.karts[0].lap.lap = 2
    state.karts[0].lap.checkpointIdx = 1
    state.karts[0].lap.t = 0.25
    state.karts[1].lap.lap = 2
    state.karts[1].lap.checkpointIdx = 3
    state.karts[1].lap.t = 0.5
    expect(botIntent(ctx, state, 1).accel).toBeCloseTo(0.865, 10)

    // Far ahead: 1 + (-50 * 0.06) = -2, clamped to BOT_RUBBER_MIN.
    state.karts[0].lap.lap = 0
    state.karts[0].lap.checkpointIdx = 0
    state.karts[0].lap.t = 0
    state.karts[1].lap.lap = 50
    expect(botIntent(ctx, state, 1).accel).toBe(0.82)

    // Behind: clamped up to BOT_RUBBER_MAX, which is full throttle.
    state.karts[0].lap.lap = 50
    state.karts[1].lap.lap = 0
    expect(botIntent(ctx, state, 1).accel).toBe(1)
  })

  it('does not drift or brake on a straight', () => {
    const ctx = makeContext(makeStraightTrack())
    const state = createState(ctx, 12345, ALL_CHARACTERS)
    for (let i = 0; i < state.karts.length; i++) state.karts[i].isBot = true
    // At 40 m/s the lookahead is 6 + 40 * 0.35 = 20 m, so the aim point is at
    // x = 202.43 — still inside the straight span, where curvature is exactly 0
    // and latAccel = 40 * 40 * 0 = 0.
    placeOnLine(ctx, state, 2, STRAIGHT_S, 40)
    const intent = botIntent(ctx, state, 2)
    expect(intent.drift).toBe(false)
    expect(intent.brake).toBe(false)
  })

  it('drifts through the circle above the lateral-acceleration threshold', () => {
    const ctx = makeContext(makeCircleTrack())
    const state = createState(ctx, 12345, ALL_CHARACTERS)
    for (let i = 0; i < state.karts.length; i++) state.karts[i].isBot = true
    // latAccel = speed^2 * botCurvature, and botCurvature on this fixture is the
    // 0.0099571 / 0.0103463 measured in the botCurvature test above.
    // 44 m/s -> 1936 * 0.0099571 = 19.277 > BOT_DRIFT_LAT_ACCEL (12) -> drift
    // 15 m/s ->  225 * 0.0103463 =  2.328 < 12                       -> no drift
    placeOnLine(ctx, state, 2, 0, 44)
    expect(botIntent(ctx, state, 2).drift).toBe(true)
    placeOnLine(ctx, state, 2, 0, 15)
    expect(botIntent(ctx, state, 2).drift).toBe(false)
    // Below tuning.driftMinSpeed (8) it never drifts, whatever the corner.
    placeOnLine(ctx, state, 2, 0, 4)
    expect(botIntent(ctx, state, 2).drift).toBe(false)
  })

  it('never drifts while airborne', () => {
    const ctx = makeContext(makeCircleTrack())
    const state = createState(ctx, 12345, ALL_CHARACTERS)
    for (let i = 0; i < state.karts.length; i++) state.karts[i].isBot = true
    placeOnLine(ctx, state, 2, 0, 44)
    state.karts[2].airborne = true
    expect(botIntent(ctx, state, 2).drift).toBe(false)
  })

  it('brakes only above the brake threshold', () => {
    const ctx = makeContext(makeCircleTrack())
    const state = createState(ctx, 12345, ALL_CHARACTERS)
    for (let i = 0; i < state.karts.length; i++) state.karts[i].isBot = true
    // 44 m/s -> latAccel 19.277 < BOT_BRAKE_LAT_ACCEL (26) -> no brake
    placeOnLine(ctx, state, 2, 0, 44)
    expect(botIntent(ctx, state, 2).brake).toBe(false)
    // 60 m/s -> curvature 0.0098710 over a 6 + 60 * 0.35 = 27 m lookahead, so
    // latAccel = 3600 * 0.0098710 = 35.536 > 26, and 60 > BOT_BRAKE_MIN_SPEED
    // (25). 60 m/s is above anything the karts can reach; this exercises the
    // threshold directly.
    placeOnLine(ctx, state, 2, 0, 60)
    expect(botIntent(ctx, state, 2).brake).toBe(true)
  })

  it('goes limp but keeps the throttle down while spun out or respawning', () => {
    const ctx = makeContext(makeCircleTrack())
    const state = createState(ctx, 12345, ALL_CHARACTERS)
    placeOnLine(ctx, state, 2, 0, 44)
    state.karts[2].item = 'boost'
    state.karts[2].spinOutTicks = 20
    const spun = botIntent(ctx, state, 2)
    expect(spun.steer).toBe(0)
    expect(spun.drift).toBe(false)
    expect(spun.useItem).toBe(false)
    expect(spun.accel).toBe(1)

    state.karts[2].spinOutTicks = 0
    state.karts[2].respawnTicks = 40
    const dead = botIntent(ctx, state, 2)
    expect(dead.steer).toBe(0)
    expect(dead.useItem).toBe(false)
  })
})

describe('botIntent — determinism', () => {
  it('gives an identical Intent for the same state and playerId', () => {
    const ctx = makeContext(makeStraightTrack())
    const a = createState(ctx, 12345, ALL_CHARACTERS)
    const b = createState(ctx, 12345, ALL_CHARACTERS)
    a.tick = 77
    // Eight distinct stations, 0.1 .. 0.17 of a lap, all on the straight span.
    for (let id = 0; id < 8; id++) placeOnLine(ctx, a, id, STRAIGHT_S + id * 0.01, 22)
    cloneState(a, b)
    for (let id = 0; id < 8; id++) {
      // botIntent returns a pooled object, so snapshot before comparing.
      const first = { ...botIntent(ctx, a, id) }
      const second = { ...botIntent(ctx, b, id) }
      expect(second).toEqual(first)
    }
  })

  it('NEVER advances state.rngCursor', () => {
    const ctx = makeContext(makeStraightTrack())
    const state = createState(ctx, 12345, ALL_CHARACTERS)
    state.rngCursor = 7
    for (let id = 0; id < 8; id++) placeOnLine(ctx, state, id, STRAIGHT_S + id * 0.01, 22)
    for (let tick = 0; tick < 200; tick++) {
      state.tick = tick
      for (let id = 0; id < 8; id++) botIntent(ctx, state, id)
    }
    expect(state.rngCursor).toBe(7)
  })

  it('returns a separate pooled Intent per playerId', () => {
    const ctx = makeContext(makeStraightTrack())
    const state = createState(ctx, 12345, ALL_CHARACTERS)
    for (let id = 0; id < 8; id++) placeOnLine(ctx, state, id, STRAIGHT_S, 0)
    const a = botIntent(ctx, state, 2)
    const b = botIntent(ctx, state, 5)
    expect(a).not.toBe(b)
    expect(botIntent(ctx, state, 2)).toBe(a)
  })
})
```

- [ ] **Step 10: Run test to verify it fails**

Run: `npx vitest run packages/sim/test/bot.test.ts -t "botIntent"`

Expected: FAIL with `TypeError: botIntent is not a function`.

- [ ] **Step 11: Write minimal implementation — `botIntent`**

Replace the import block at the top of `packages/sim/src/bot.ts`.

Before:

```typescript
import type { KartState, SimContext, SimState } from './types'
import { clamp, lerp, wrapAngle } from './mathutil'
import { rngAt } from './rng'
import { v3len } from './vec3'
import { kartById } from './entity'
```

After:

```typescript
import type { Intent, KartState, SimContext, SimState } from './types'
import { MAX_KARTS } from './types'
import { clamp, lerp, wrapAngle } from './mathutil'
import { rngAt } from './rng'
import { v3len } from './vec3'
import { kartById } from './entity'
```

Then append to the end of `packages/sim/src/bot.ts`:

```typescript
/** Steer output per radian of heading error, before clamping to -1..1. */
export const BOT_STEER_GAIN = 1.6

// One reusable Intent per playerId: botIntent runs every other tick for up to
// eight karts and must not allocate. Callers copy the fields out; resolveInputs
// [Task 15] writes into its own out[] array.
const intentPool: Intent[] = []
for (let i = 0; i < MAX_KARTS; i++) {
  intentPool.push({ tick: 0, steer: 0, accel: 0, brake: false, drift: false, useItem: false })
}

/**
 * Racing-line AI. Deterministic: the same SimState and playerId always give
 * the same Intent, and nothing here reads or advances state.rngCursor.
 *
 * The returned object is pooled per playerId — copy the fields, do not retain
 * the reference. Phase gating and the 30 Hz recompute cadence belong to
 * resolveInputs [Task 15]; this function computes whenever it is called.
 */
export function botIntent(ctx: SimContext, state: SimState, playerId: number): Intent {
  const slot = playerId >= 0 && playerId < MAX_KARTS ? playerId : 0
  const out = intentPool[slot]
  out.tick = state.tick
  out.steer = 0
  out.accel = 0
  out.brake = false
  out.drift = false
  out.useItem = false

  const k = kartById(state, playerId)
  if (k === null) return out

  // Spun out or respawning: no steering authority, but keep the throttle down
  // so the kart pulls away the tick control returns.
  if (k.spinOutTicks > 0 || k.respawnTicks > 0) {
    out.accel = 1
    return out
  }

  // --- aim at a point on the racing line -------------------------------
  const sLook = botLookaheadS(ctx, state, playerId)
  const lat = botLateralTarget(ctx, state, playerId)
  const tp = ctx.query.sampleAt(sLook)
  const px = tp.position.x // read immediately: sampleAt() may return scratch
  const pz = tp.position.z
  const t = ctx.query.tangentAt(sLook)
  const rx = -t.z // right = (-t.z, 0, t.x), positive lateral is to the right
  const rz = t.x
  const rl = Math.sqrt(rx * rx + rz * rz) || 1
  const aimX = px + (rx / rl) * lat
  const aimZ = pz + (rz / rl) * lat

  const desired = Math.atan2(aimZ - k.position.z, aimX - k.position.x)
  const err = wrapAngle(desired - k.heading)
  out.steer = clamp(err * BOT_STEER_GAIN, -1, 1)

  // --- throttle, drift, brake ------------------------------------------
  const delta = botRubberDelta(ctx, state, playerId)
  out.accel = clamp(1 + delta * BOT_RUBBER_GAIN, BOT_RUBBER_MIN, BOT_RUBBER_MAX)

  const speed = v3len(k.velocity)
  const curvature = botCurvature(ctx, state, playerId)
  const latAccel = speed * speed * curvature

  out.brake = latAccel > BOT_BRAKE_LAT_ACCEL && speed > BOT_BRAKE_MIN_SPEED

  const driftGate = delta > BOT_AGGRESSIVE_DELTA
    ? BOT_DRIFT_LAT_ACCEL * BOT_AGGRESSIVE_DRIFT_MUL
    : BOT_DRIFT_LAT_ACCEL
  out.drift = !k.airborne && speed > ctx.tuning.driftMinSpeed && latAccel > driftGate

  return out
}
```

- [ ] **Step 12: Run test to verify it passes**

Run: `npx vitest run packages/sim/test/bot.test.ts`

Expected: PASS — 30 tests. The `useItem` flag is still always `false`; the item heuristics land in Step 15.

- [ ] **Step 13: Write the failing test for the item heuristics**

Append to `packages/sim/test/bot.test.ts`. First replace the `../src/bot` import block one last time.

Before:

```typescript
import {
  BOT_LOOKAHEAD_BASE,
  BOT_LOOKAHEAD_PER_SPEED,
  BOT_MAX_BIAS,
  BOT_NOISE_AMPLITUDE,
  BOT_NOISE_PERIOD,
  BOT_RUBBER_GAIN,
  BOT_RUBBER_MIN,
  BOT_STEER_GAIN,
  botCurvature,
  botIntent,
  botLateralBias,
  botLateralTarget,
  botLookaheadS,
  botNoise,
  botRubberDelta,
  nearestOtherDistance,
} from '../src/bot'
```

After:

```typescript
import {
  BOT_BOLT_RANGE,
  BOT_BOOST_MIN_SPEED,
  BOT_BUBBLE_RANGE,
  BOT_CHARGE_RANGE,
  BOT_LOOKAHEAD_BASE,
  BOT_LOOKAHEAD_PER_SPEED,
  BOT_MAX_BIAS,
  BOT_NOISE_AMPLITUDE,
  BOT_NOISE_PERIOD,
  BOT_RUBBER_GAIN,
  BOT_RUBBER_MIN,
  BOT_SEEKER_RANGE,
  BOT_SLICK_RANGE,
  BOT_STEER_GAIN,
  botCurvature,
  botIntent,
  botLateralBias,
  botLateralTarget,
  botLookaheadS,
  botNoise,
  botRubberDelta,
  nearestOtherDistance,
} from '../src/bot'
```

Then append these tests to the end of the file:

```typescript
/**
 * Straight track, kart 3 on the centreline at (250, 0, 0) heading 0
 * (forward = +X), every other kart parked 5 km away. `neighbourAt` puts one
 * kart at a signed distance along +X of kart 3, so `nearestOtherDistance`
 * returns exactly |alongX|.
 *
 * x = 250 is inside the exactly-straight span between control points 1
 * (x = 150) and 3 (x = 450). Even the longest lookahead used here — 6 + 30*0.35
 * = 16.5 m, reaching x = 266.5 — stays inside it, so botCurvature is exactly 0
 * and every "is this a straight?" gate is satisfied. (The old (0, 0, 0) is
 * control point 0, where the spline is bent by control point 11 at
 * (-140, 0, 60) and the tangent is atan2(-30, 145) = -0.204 rad, not 0.)
 *
 * The scattered karts sit at x = 0, so from x = 250 they all read as *behind*
 * at ~5 km — far outside every range constant below, which top out at 150 m.
 */
const ITEM_SCENARIO_X = 250

function itemScenario(speed: number) {
  const ctx = makeContext(makeStraightTrack())
  const state = createState(ctx, 12345, ALL_CHARACTERS)
  for (let i = 0; i < state.karts.length; i++) state.karts[i].isBot = true
  scatter(state, [3])
  const k = state.karts[3]
  k.position.x = ITEM_SCENARIO_X
  k.position.y = 0
  k.position.z = 0
  k.heading = 0
  k.velocity.x = speed
  k.velocity.y = 0
  k.velocity.z = 0
  k.airborne = false
  k.spinOutTicks = 0
  k.respawnTicks = 0
  k.item = 'none'
  const neighbourAt = (alongX: number): void => {
    state.karts[6].position.x = ITEM_SCENARIO_X + alongX
    state.karts[6].position.y = 0
    state.karts[6].position.z = 0
    state.karts[6].respawnTicks = 0
  }
  return { ctx, state, k, neighbourAt }
}

describe('botIntent — item heuristics', () => {
  it('holds fire with no item', () => {
    const { ctx, state, k } = itemScenario(30)
    k.item = 'none'
    expect(botIntent(ctx, state, 3).useItem).toBe(false)
  })

  it('fires boost on a straight above the minimum speed only', () => {
    expect(BOT_BOOST_MIN_SPEED).toBe(18)
    const fast = itemScenario(30)
    fast.k.item = 'boost'
    expect(botIntent(fast.ctx, fast.state, 3).useItem).toBe(true)
    const slow = itemScenario(10)
    slow.k.item = 'boost'
    expect(botIntent(slow.ctx, slow.state, 3).useItem).toBe(false)
    const air = itemScenario(30)
    air.k.item = 'boost'
    air.k.airborne = true
    expect(botIntent(air.ctx, air.state, 3).useItem).toBe(false)
  })

  it('fires a seeker at a kart ahead inside 60 m', () => {
    expect(BOT_SEEKER_RANGE).toBe(60)
    const near = itemScenario(30)
    near.k.item = 'seeker'
    near.neighbourAt(50)
    expect(botIntent(near.ctx, near.state, 3).useItem).toBe(true)
    const far = itemScenario(30)
    far.k.item = 'seeker'
    far.neighbourAt(70)
    expect(botIntent(far.ctx, far.state, 3).useItem).toBe(false)
    const behind = itemScenario(30)
    behind.k.item = 'seeker'
    behind.neighbourAt(-20) // behind does not count for a seeker
    expect(botIntent(behind.ctx, behind.state, 3).useItem).toBe(false)
  })

  it('fires a bolt at a kart ahead inside 40 m', () => {
    expect(BOT_BOLT_RANGE).toBe(40)
    const near = itemScenario(30)
    near.k.item = 'bolt'
    near.neighbourAt(30)
    expect(botIntent(near.ctx, near.state, 3).useItem).toBe(true)
    const far = itemScenario(30)
    far.k.item = 'bolt'
    far.neighbourAt(50)
    expect(botIntent(far.ctx, far.state, 3).useItem).toBe(false)
  })

  it('drops a slick for a kart behind inside 35 m', () => {
    expect(BOT_SLICK_RANGE).toBe(35)
    const near = itemScenario(30)
    near.k.item = 'slick'
    near.neighbourAt(-30)
    expect(botIntent(near.ctx, near.state, 3).useItem).toBe(true)
    const far = itemScenario(30)
    far.k.item = 'slick'
    far.neighbourAt(-40)
    expect(botIntent(far.ctx, far.state, 3).useItem).toBe(false)
    const ahead = itemScenario(30)
    ahead.k.item = 'slick'
    ahead.neighbourAt(10) // no threat behind, keep the slick
    expect(botIntent(ahead.ctx, ahead.state, 3).useItem).toBe(false)
  })

  it('raises a bubble for a kart behind inside 30 m', () => {
    expect(BOT_BUBBLE_RANGE).toBe(30)
    const near = itemScenario(30)
    near.k.item = 'bubble'
    near.neighbourAt(-25)
    expect(botIntent(near.ctx, near.state, 3).useItem).toBe(true)
    const far = itemScenario(30)
    far.k.item = 'bubble'
    far.neighbourAt(-35)
    expect(botIntent(far.ctx, far.state, 3).useItem).toBe(false)
  })

  it('detonates a charge only at close quarters, either side', () => {
    expect(BOT_CHARGE_RANGE).toBe(12)
    const ahead = itemScenario(30)
    ahead.k.item = 'charge'
    ahead.neighbourAt(10)
    expect(botIntent(ahead.ctx, ahead.state, 3).useItem).toBe(true)
    const behind = itemScenario(30)
    behind.k.item = 'charge'
    behind.neighbourAt(-10)
    expect(botIntent(behind.ctx, behind.state, 3).useItem).toBe(true)
    const far = itemScenario(30)
    far.k.item = 'charge'
    far.neighbourAt(15)
    expect(botIntent(far.ctx, far.state, 3).useItem).toBe(false)
  })

  it('releases a surge when anyone is ahead, and holds it when leading', () => {
    const someone = itemScenario(30)
    someone.k.item = 'surge'
    someone.neighbourAt(100)
    expect(botIntent(someone.ctx, someone.state, 3).useItem).toBe(true)
    const alone = itemScenario(30)
    alone.k.item = 'surge'
    alone.neighbourAt(-100) // only traffic is behind
    expect(botIntent(alone.ctx, alone.state, 3).useItem).toBe(false)
  })

  it('blinks under pressure from behind, or when well behind on progress', () => {
    const pressured = itemScenario(30)
    pressured.k.item = 'blink'
    pressured.neighbourAt(-20) // inside BOT_BLINK_RANGE (25)
    expect(botIntent(pressured.ctx, pressured.state, 3).useItem).toBe(true)

    const clear = itemScenario(30)
    clear.k.item = 'blink'
    clear.neighbourAt(-40)
    expect(botIntent(clear.ctx, clear.state, 3).useItem).toBe(false)

    // Nobody near, but 2 checkpoints down on the leading human
    // (delta 2 > BOT_AGGRESSIVE_DELTA 1) -> burn it to catch up.
    const trailing = itemScenario(30)
    trailing.k.item = 'blink'
    trailing.neighbourAt(-40)
    trailing.state.karts[6].isBot = false
    trailing.state.karts[6].lap.lap = 0
    trailing.state.karts[6].lap.checkpointIdx = 3
    trailing.state.karts[6].lap.t = 0
    trailing.state.karts[3].lap.lap = 0
    trailing.state.karts[3].lap.checkpointIdx = 1
    trailing.state.karts[3].lap.t = 0
    expect(botRubberDelta(trailing.ctx, trailing.state, 3)).toBeCloseTo(2, 10)
    expect(botIntent(trailing.ctx, trailing.state, 3).useItem).toBe(true)
  })

  it('never fires while spun out', () => {
    const { ctx, state, k, neighbourAt } = itemScenario(30)
    k.item = 'charge'
    neighbourAt(5)
    k.spinOutTicks = 12
    expect(botIntent(ctx, state, 3).useItem).toBe(false)
  })
})
```

- [ ] **Step 14: Run test to verify it fails**

Run: `npx vitest run packages/sim/test/bot.test.ts -t "item heuristics"`

Expected: FAIL with `expected false to be true` on the boost test — `botIntent` never sets `useItem` yet.

- [ ] **Step 15: Write minimal implementation — the item heuristics**

Append to the end of `packages/sim/src/bot.ts`:

```typescript
/** Below this speed a boost is wasted. */
export const BOT_BOOST_MIN_SPEED = 18
/** Curvature (rad/m) below which the bot treats the road as straight. */
export const BOT_ITEM_STRAIGHT_CURVATURE = 0.02
/** Firing range for a homing seeker, in metres. */
export const BOT_SEEKER_RANGE = 60
/** Firing range for a straight-fired bolt, in metres. */
export const BOT_BOLT_RANGE = 40
/** Threat range behind which a slick is worth dropping, in metres. */
export const BOT_SLICK_RANGE = 35
/** Threat range behind which a bubble goes up, in metres. */
export const BOT_BUBBLE_RANGE = 30
/** Range ahead within which a surge is worth releasing, in metres. */
export const BOT_SURGE_RANGE = 150
/** Blast range for a charge, either side, in metres. */
export const BOT_CHARGE_RANGE = 12
/** Threat range behind which a blink is worth burning, in metres. */
export const BOT_BLINK_RANGE = 25

/**
 * Simple per-item firing rules. Deterministic and allocation-free: two scans
 * of eight karts and a switch.
 */
function botWantsItem(
  state: SimState,
  k: KartState,
  curvature: number,
  delta: number,
  speed: number,
): boolean {
  if (k.item === 'none') return false
  const ahead = nearestOtherDistance(state, k, true)
  const behind = nearestOtherDistance(state, k, false)
  switch (k.item) {
    case 'boost':
      return speed > BOT_BOOST_MIN_SPEED && !k.airborne
        && curvature < BOT_ITEM_STRAIGHT_CURVATURE
    case 'blink':
      return !k.airborne && (behind < BOT_BLINK_RANGE || delta > BOT_AGGRESSIVE_DELTA)
    case 'seeker':
      return ahead < BOT_SEEKER_RANGE
    case 'bolt':
      return ahead < BOT_BOLT_RANGE
    case 'slick':
      return behind < BOT_SLICK_RANGE
    case 'bubble':
      return behind < BOT_BUBBLE_RANGE
    case 'surge':
      return ahead < BOT_SURGE_RANGE
    case 'charge':
      return Math.min(ahead, behind) < BOT_CHARGE_RANGE
    default:
      return false
  }
}
```

Then wire it into `botIntent`. Find the tail of the function.

Before:

```typescript
  const driftGate = delta > BOT_AGGRESSIVE_DELTA
    ? BOT_DRIFT_LAT_ACCEL * BOT_AGGRESSIVE_DRIFT_MUL
    : BOT_DRIFT_LAT_ACCEL
  out.drift = !k.airborne && speed > ctx.tuning.driftMinSpeed && latAccel > driftGate

  return out
}
```

After:

```typescript
  const driftGate = delta > BOT_AGGRESSIVE_DELTA
    ? BOT_DRIFT_LAT_ACCEL * BOT_AGGRESSIVE_DRIFT_MUL
    : BOT_DRIFT_LAT_ACCEL
  out.drift = !k.airborne && speed > ctx.tuning.driftMinSpeed && latAccel > driftGate

  out.useItem = botWantsItem(state, k, curvature, delta, speed)
  return out
}
```

- [ ] **Step 16: Run test to verify it passes**

Run: `npx vitest run packages/sim/test/bot.test.ts`

Expected: PASS — 40 tests.

- [ ] **Step 17: Typecheck and run the whole sim suite**

Run: `npx tsc --noEmit -p packages/sim && npx vitest run packages/sim`

Expected: no TypeScript output, and every existing sim test still passes alongside the 40 new ones.

- [ ] **Step 18: Commit**

```bash
git add packages/sim/src/bot.ts packages/sim/test/bot.test.ts
git commit -m "feat(sim): deterministic racing-line bots

Aim at a lookahead point offset by a per-bot lateral bias drawn from
rngAt at a fixed cursor, plus a continuous per-tick noise term, so eight
identical bots do not drive parallel lines. Rubber-bands throttle toward
the leading human's lap progress, drifts on lateral acceleration, and
fires each of the eight items on its own range heuristic. Nothing here
reads or advances state.rngCursor."
```

---

### Task 15: Race Phase and Input Resolution

**Files:**
- Create: `packages/sim/src/phase.ts`
- Modify: `packages/sim/src/step.ts` (import block, the module-scope input buffer Task 6 created, and three exact anchors inside `step()`; all five edits shown verbatim in Step 11)
- Test: `packages/sim/test/phase.test.ts`

**Interfaces:**

- Consumes (all exist before this task; signatures repeated in full so this task can be read in isolation):
  - `packages/sim/src/types.ts` [Task 2] — `TICK_HZ = 60`, `TICK_DT = 1/60`, `MAX_KARTS = 8`, `MAX_ENTITIES = 32`, `RACE_LAPS = 3`, `COUNTDOWN_TICKS = 180`, and the types `Vec3`, `Intent`, `DriftState`, `LapProgress`, `KartState`, `EntityState`, `SimState`, `SimContext`, `AuthEvent`, `AuthEventKind`, `ItemKind`, `RacePhase`, `Tuning`, `Track`, `TrackQuery`, `CharacterStats`.
    - `Intent` is exactly `{ tick: number; steer: number; accel: number; brake: boolean; drift: boolean; useItem: boolean }`.
    - `SimState` is exactly `{ tick, phase, raceSeed, rngCursor, nextEventSeq, finishTick, karts, entities, entityCount, nextEntityId, itemBoxes, finishedOrder }`; `karts` is always length `MAX_KARTS`; `finishTick` is `-1` until the first kart finishes.
    - `finishedOrder` is a **fixed-length** `number[]` of length `MAX_KARTS` (locked contract §0). Slot `p` holds the `playerId` that finished in 1-based place `p + 1`; every unused slot holds `-1`. It is **never** `push`ed, never `indexOf`ed and never read through `.length` for a finisher count — `cloneState` throws when `dst` and `src` differ in shape, so growing it past 8 would break `recordRun`/`replayRun` [Task 16] and the golden run [Task 17]. Count finishers by scanning the 8 slots for entries `!== -1`.
    - `RacePhase = 'countdown' | 'racing' | 'finished'`.
    - `SimContext` is `{ track, query, tuning, characters, isLeader }`; `isLeader` is `true` only on the authority that assigns event sequence numbers.
  - `packages/sim/src/mathutil.ts` [Task 2] — `export function clamp(v: number, lo: number, hi: number): number`
  - `packages/sim/src/state.ts` [Task 5] — `export function createState(ctx: SimContext, seed: number, characterIdx: number[]): SimState`, and `export function emit(state: SimState, out: AuthEvent[], kind: AuthEventKind, playerId: number, entityId: number, item: ItemKind, data: number): void` (pushes one `AuthEvent` onto `out` with `eventSeq = state.nextEventSeq`, then increments `state.nextEventSeq`).
  - `packages/sim/src/bot.ts` [Task 14] — `export function botIntent(ctx: SimContext, state: SimState, playerId: number): Intent` (pure: same `(ctx, state, playerId)` returns the same field values; it never mutates `state` and never advances `state.rngCursor`). It returns a **pooled** `Intent`, one object per `playerId`, reused on every call — `botIntent(ctx, s, 2) === botIntent(ctx, s, 2)` is `true`, and the next call for that `playerId` overwrites the fields in place. Callers must **copy the fields out** (this task's `copyIntent`) and must never retain the reference.
  - `packages/sim/src/placement.ts` [Task 11] — `export function placementOrder(state: SimState): number[]` (returns all `MAX_KARTS` `playerId`s best-first, ordered by `lap.lap` descending, then `lap.checkpointIdx` descending, then `lap.t` descending).
  - `packages/sim/src/step.ts` [Task 5, extended by 6–14] — `export function step(ctx: SimContext, prev: SimState, next: SimState, inputs: Intent[], events: AuthEvent[]): void`
  - `packages/sim/test/fixtures/track-fixtures.ts` [Task 3] — `makeTuning(overrides?: Partial<Tuning>): Tuning`, `makeCharacters(): CharacterStats[]`, `makeStraightTrack(overrides?: Partial<Track>): Track`, `makeCircleTrack(overrides?: Partial<Track>): Track`, `makeOvalTrack(overrides?: Partial<Track>): Track`, and `makeContext(track: Track, isLeader?: boolean): SimContext` [Task 4, because it needs `buildTrackQuery`] (`isLeader` defaults to `true`).

- Produces (later tasks and Task 16 rely on exactly these):
  - `export const FINISH_GRACE_TICKS = 1800` — ticks after `state.finishTick` at which the race is force-ended, 30 s at 60 Hz. Not in the locked contract; defined here because the contract names "a post-first-place timer" without a value.
  - `export function makeIntentBuffer(): Intent[]` — a new array of exactly `MAX_KARTS` distinct `Intent` objects, every field zeroed (`tick: 0, steer: 0, accel: 0, brake: false, drift: false, useItem: false`). Callers allocate one of these once and reuse it forever; nothing in the hot path allocates.
  - `export function resetBotHold(): void` — clears the module-level 30 Hz bot-intent hold. Must be called by any harness that starts or restarts a run (Task 16's `recordRun` / `replayRun` both call it).
  - `export function resolveInputs(ctx: SimContext, state: SimState, inputs: Intent[], out: Intent[]): void` — writes `MAX_KARTS` resolved intents into the caller-owned `out`. `inputs` and `out` are both indexed by **kart slot**, i.e. `inputs[i]` is the raw intent for `state.karts[i]`. Never allocates, never mutates `inputs`, never mutates `state`.
  - `export function updatePhase(ctx: SimContext, state: SimState, events: AuthEvent[]): void` — advances `state.phase`, sets `state.finishTick`, writes DNF karts into the free `state.finishedOrder` slots on a timeout, and emits `'finish'` events **only when `ctx.isLeader`**. Each per-kart DNF event carries `data ===` that kart's **1-based finishing place**, i.e. the number of filled `finishedOrder` slots *after* it was recorded — the same meaning `updateLaps` [Task 11] gives `data` on a real finish. The race-level finish event uses `playerId === -1`, `entityId === -1`, `item === 'none'`, and `data ===` the finisher count, which is always `MAX_KARTS` by the time the race ends because the DNF fill leaves no slot at `-1`.

**Behaviour this task locks in (read before writing code):**

1. `resolveInputs` is position 1 of the canonical per-kart order. Everything after it — `updateRecovery`, `updateDrift`, `stepKart`, `applyAirYaw`, `integrateVertical`, `applyRamps`, `decayBoost`, `updateLaps` — reads the **resolved** intent and never the raw `inputs` array.
2. While `state.phase === 'countdown'`, every kart's resolved intent is all-zero. Nobody, human or bot, moves before the lights go out.
3. A kart with `isBot === true` **or** `connected === false` is driven by `botIntent`. A dropped human is taken over by a bot mid-race, which is the design's stated failure behaviour, and it costs one boolean here.
4. Bots run at 30 Hz against a 60 Hz sim: `botIntent` is called only when `state.tick % 2 === 0`, and the odd tick of the pair reuses the even tick's value. The held value lives in a **module-level** buffer, not in `SimState` — `SimState` is locked and has no field for it. That is the one piece of simulation state outside `SimState`, and Task 16's checkpoint-replay parity invariant exists precisely because of it.
5. Human input is sanitised at this boundary: `steer` clamped to `[-1, 1]`, `accel` clamped to `[0, 1]`, non-finite values replaced with `0`, booleans compared with `=== true`. A `NaN` that reaches `stepKart` poisons a kart's position forever — `NaN` propagates through every subsequent multiply and never recovers, and there is no meaningful "clamp" of `NaN`, so it becomes `0`.
6. `updatePhase` runs **last** in the tick, after the kart loop and after `resolveKartCollisions → updateEntities → updateItemBoxes`. Consequence: the tick on which the countdown ends still ran with frozen input, and the first tick with live input is `COUNTDOWN_TICKS + 1`.
7. `finishedOrder` is a fixed-length, `-1`-padded array of `MAX_KARTS` slots. `updatePhase` writes a DNF kart into the **first slot holding `-1`** and derives every count by scanning those 8 slots. No `push`, no `indexOf`, no `.length` used as a finisher count. `updateLaps` [Task 11] fills it the same way for real finishers, and both give a `finish` event's `data` field the same meaning: a 1-based finishing place.

---

- [ ] **Step 1: Write the failing test — `resolveInputs`**

Create `packages/sim/test/phase.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { Intent, SimContext, SimState } from '../src/types'
import { COUNTDOWN_TICKS, MAX_KARTS } from '../src/types'
import { createState } from '../src/state'
import { botIntent } from '../src/bot'
import { makeIntentBuffer, resetBotHold, resolveInputs } from '../src/phase'
import { makeContext, makeStraightTrack } from './fixtures/track-fixtures'

const CHARS = [0, 1, 2, 3, 4, 5, 6, 7]

/** A state with all eight slots human-controlled and connected, phase forced. */
function humanState(ctx: SimContext, phase: SimState['phase'], tick: number): SimState {
  const s = createState(ctx, 0x0badc0de, CHARS)
  for (let i = 0; i < MAX_KARTS; i++) {
    s.karts[i].isBot = false
    s.karts[i].connected = true
  }
  s.phase = phase
  s.tick = tick
  return s
}

function intent(over: Partial<Intent>): Intent {
  return { tick: 0, steer: 0, accel: 0, brake: false, drift: false, useItem: false, ...over }
}

describe('resolveInputs', () => {
  it('freezes every input while the phase is countdown', () => {
    const ctx = makeContext(makeStraightTrack())
    const s = humanState(ctx, 'countdown', 42)
    const out = makeIntentBuffer()
    const inputs: Intent[] = []
    for (let i = 0; i < MAX_KARTS; i++) {
      inputs.push(intent({ tick: 41, steer: 0.7, accel: 1, brake: true, drift: true, useItem: true }))
    }

    resolveInputs(ctx, s, inputs, out)

    for (let i = 0; i < MAX_KARTS; i++) {
      expect(out[i].tick).toBe(42)      // stamped with the tick it is applied at
      expect(out[i].steer).toBe(0)
      expect(out[i].accel).toBe(0)
      expect(out[i].brake).toBe(false)
      expect(out[i].drift).toBe(false)
      expect(out[i].useItem).toBe(false)
    }
    // the raw inputs are the caller's; resolveInputs must not have touched them
    expect(inputs[0].steer).toBe(0.7)
    expect(inputs[0].drift).toBe(true)
  })

  it('freezes bots during countdown too', () => {
    const ctx = makeContext(makeStraightTrack())
    const s = humanState(ctx, 'countdown', COUNTDOWN_TICKS) // tick 180, still countdown
    s.karts[5].isBot = true
    const out = makeIntentBuffer()
    const inputs = makeIntentBuffer()

    resetBotHold()
    resolveInputs(ctx, s, inputs, out)

    expect(out[5].tick).toBe(180)
    expect(out[5].steer).toBe(0)
    expect(out[5].accel).toBe(0)
  })

  it('clamps and sanitises human input while racing', () => {
    const ctx = makeContext(makeStraightTrack())
    const s = humanState(ctx, 'racing', 200)
    const out = makeIntentBuffer()
    const inputs: Intent[] = [
      intent({ tick: 199, steer: 3.5, accel: 2.25, brake: true, drift: false, useItem: true }),
      intent({ tick: 199, steer: -4, accel: -0.5, brake: false, drift: true, useItem: false }),
      intent({ tick: 199, steer: Number.NaN, accel: Number.NaN }),
      intent({ tick: 199, steer: Number.POSITIVE_INFINITY, accel: Number.NEGATIVE_INFINITY }),
      intent({ tick: 199, steer: 0.25, accel: 0.75 }),
      intent({ tick: 199, steer: -0.5, accel: 0.5 }),
      // a hostile / sloppy client sending non-booleans
      intent({ tick: 199, brake: 1 as unknown as boolean, drift: 'yes' as unknown as boolean }),
      intent({ tick: 199, steer: -1, accel: 1, brake: true, drift: true, useItem: true }),
    ]

    resolveInputs(ctx, s, inputs, out)

    expect(out[0].steer).toBe(1)        // clamp(3.5, -1, 1)
    expect(out[0].accel).toBe(1)        // clamp(2.25, 0, 1)
    expect(out[0].tick).toBe(200)       // restamped from state.tick, not the client's 199
    expect(out[0].brake).toBe(true)
    expect(out[0].useItem).toBe(true)

    expect(out[1].steer).toBe(-1)       // clamp(-4, -1, 1)
    expect(out[1].accel).toBe(0)        // clamp(-0.5, 0, 1)
    expect(out[1].drift).toBe(true)

    expect(out[2].steer).toBe(0)        // NaN is not clampable; it becomes 0
    expect(out[2].accel).toBe(0)
    expect(Number.isNaN(out[2].steer)).toBe(false)

    expect(out[3].steer).toBe(0)        // +Infinity is non-finite -> 0
    expect(out[3].accel).toBe(0)        // -Infinity is non-finite -> 0

    expect(out[4].steer).toBe(0.25)     // in range, passed through exactly (0.25 = 2^-2)
    expect(out[4].accel).toBe(0.75)     // 0.75 = 3 * 2^-2, exact in binary64
    expect(out[5].steer).toBe(-0.5)
    expect(out[5].accel).toBe(0.5)

    expect(out[6].brake).toBe(false)    // 1 !== true
    expect(out[6].drift).toBe(false)    // 'yes' !== true

    expect(out[7].steer).toBe(-1)
    expect(out[7].accel).toBe(1)
  })

  it('freezes a slot whose raw input is missing', () => {
    const ctx = makeContext(makeStraightTrack())
    const s = humanState(ctx, 'racing', 77)
    const out = makeIntentBuffer()
    // pre-dirty the buffer so a no-op implementation cannot pass by accident
    for (let i = 0; i < MAX_KARTS; i++) {
      out[i].steer = 0.9
      out[i].accel = 0.9
      out[i].drift = true
    }

    resolveInputs(ctx, s, [], out)

    for (let i = 0; i < MAX_KARTS; i++) {
      expect(out[i].tick).toBe(77)
      expect(out[i].steer).toBe(0)
      expect(out[i].accel).toBe(0)
      expect(out[i].drift).toBe(false)
    }
  })

  it('fills bot and disconnected slots from botIntent and ignores their raw input', () => {
    const ctx = makeContext(makeStraightTrack())
    const s = humanState(ctx, 'racing', 200) // 200 % 2 === 0 -> fresh bot compute
    s.karts[3].isBot = true
    s.karts[4].isBot = false
    s.karts[4].connected = false

    const expected3 = botIntent(ctx, s, s.karts[3].playerId)
    const expected4 = botIntent(ctx, s, s.karts[4].playerId)
    const cursorBefore = s.rngCursor

    const out = makeIntentBuffer()
    const inputs: Intent[] = []
    for (let i = 0; i < MAX_KARTS; i++) {
      inputs.push(intent({ tick: 199, steer: 0.9, accel: 0.1, useItem: true }))
    }

    resetBotHold()
    resolveInputs(ctx, s, inputs, out)

    // bot slot: botIntent wins, raw input discarded
    expect(Object.is(out[3].steer, expected3.steer)).toBe(true)
    expect(Object.is(out[3].accel, expected3.accel)).toBe(true)
    expect(out[3].brake).toBe(expected3.brake)
    expect(out[3].drift).toBe(expected3.drift)
    expect(out[3].useItem).toBe(expected3.useItem)
    expect(out[3].tick).toBe(200)
    expect(out[3].steer).not.toBe(0.9)

    // disconnected human: also bot-driven
    expect(Object.is(out[4].steer, expected4.steer)).toBe(true)
    expect(Object.is(out[4].accel, expected4.accel)).toBe(true)
    expect(out[4].tick).toBe(200)

    // connected human next door is untouched by any of that
    expect(out[5].steer).toBe(0.9)
    expect(out[5].accel).toBe(0.1)

    // resolving input is not an authority action: it must not consume PRNG draws
    expect(s.rngCursor).toBe(cursorBefore)
  })

  it('holds bot intents across a tick pair so bots run at 30Hz', () => {
    const ctx = makeContext(makeStraightTrack())
    const s = humanState(ctx, 'racing', 200)
    s.karts[0].isBot = true
    const out = makeIntentBuffer()
    const inputs = makeIntentBuffer()

    resetBotHold()

    // even tick 200: fresh compute
    resolveInputs(ctx, s, inputs, out)
    const first = { steer: out[0].steer, accel: out[0].accel, drift: out[0].drift }
    expect(Object.is(first.steer, botIntent(ctx, s, 0).steer)).toBe(true)
    expect(out[0].tick).toBe(200)

    // move the kart 6 m off the centreline and advance to the ODD tick of the pair.
    // makeStraightTrack runs along +X, so +z is 6 m of lateral displacement.
    s.karts[0].position.z += 6
    s.tick = 201

    resolveInputs(ctx, s, inputs, out)
    expect(Object.is(out[0].steer, first.steer)).toBe(true)   // reused, not recomputed
    expect(Object.is(out[0].accel, first.accel)).toBe(true)
    expect(out[0].drift).toBe(first.drift)
    expect(out[0].tick).toBe(201)                             // but restamped

    // Proof the hold is doing work: a fresh compute from the displaced state differs.
    // If this assertion ever fails, the displacement above is too small for this
    // fixture — raise the 6 m. The load-bearing assertion is the Object.is one above.
    const fresh201 = botIntent(ctx, s, 0)
    expect(fresh201.steer === first.steer && fresh201.accel === first.accel).toBe(false)

    // next even tick 202: recompute from the displaced state
    s.tick = 202
    resolveInputs(ctx, s, inputs, out)
    const fresh202 = botIntent(ctx, s, 0)
    expect(Object.is(out[0].steer, fresh202.steer)).toBe(true)
    expect(Object.is(out[0].steer, first.steer)).toBe(false)
    expect(out[0].tick).toBe(202)
  })

  it('computes a fresh bot intent when the pair starts cold on an odd tick', () => {
    const ctx = makeContext(makeStraightTrack())
    const s = humanState(ctx, 'racing', 301) // odd, and the hold is empty
    s.karts[0].isBot = true
    const out = makeIntentBuffer()

    resetBotHold()
    resolveInputs(ctx, s, makeIntentBuffer(), out)

    const fresh = botIntent(ctx, s, 0)
    expect(Object.is(out[0].steer, fresh.steer)).toBe(true)
    expect(Object.is(out[0].accel, fresh.accel)).toBe(true)
    expect(out[0].tick).toBe(301)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/sim/test/phase.test.ts`

Expected: FAIL with `Error: Failed to resolve import "../src/phase" from "packages/sim/test/phase.test.ts". Does the file exist?`

- [ ] **Step 3: Write minimal implementation — `resolveInputs`**

Create `packages/sim/src/phase.ts`:

```ts
import type { Intent, SimContext, SimState } from './types'
import { MAX_KARTS } from './types'
import { clamp } from './mathutil'
import { botIntent } from './bot'

/**
 * Ticks after `state.finishTick` at which the race force-ends and every kart
 * still driving is recorded as a DNF, in placement order. 1800 ticks = 30 s at
 * 60 Hz. Not part of the locked contract; the contract names the timer but not
 * its length, so it is defined here and this module owns it.
 */
export const FINISH_GRACE_TICKS = 1800

/**
 * A reusable, caller-owned intent buffer of exactly MAX_KARTS slots. Allocate
 * one per loop, never per tick: `step()` must not allocate in the hot path.
 */
export function makeIntentBuffer(): Intent[] {
  const out: Intent[] = []
  for (let i = 0; i < MAX_KARTS; i++) {
    out.push({ tick: 0, steer: 0, accel: 0, brake: false, drift: false, useItem: false })
  }
  return out
}

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
  o.tick = tick
  o.steer = 0
  o.accel = 0
  o.brake = false
  o.drift = false
  o.useItem = false
}

function copyIntent(src: Intent, dst: Intent, tick: number): void {
  dst.tick = tick
  dst.steer = src.steer
  dst.accel = src.accel
  dst.brake = src.brake
  dst.drift = src.drift
  dst.useItem = src.useItem
}

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

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/sim/test/phase.test.ts`

Expected: PASS — 7 tests in the `resolveInputs` describe block.

- [ ] **Step 5: Write the failing test — `updatePhase`**

Append to `packages/sim/test/phase.test.ts`. Also extend the existing import lines at the top of the file:

Replace this line:

```ts
import { makeIntentBuffer, resetBotHold, resolveInputs } from '../src/phase'
```

with:

```ts
import type { AuthEvent } from '../src/types'
import { FINISH_GRACE_TICKS, makeIntentBuffer, resetBotHold, resolveInputs, updatePhase } from '../src/phase'
```

Then append this describe block to the end of the file:

```ts
describe('updatePhase', () => {
  /**
   * finishedOrder is fixed length MAX_KARTS with -1 in every unused slot, so a
   * test that wants "only kart 2 has finished" must hand updatePhase the padded
   * form. `order(2)` is `[2, -1, -1, -1, -1, -1, -1, -1]`.
   */
  function order(...ids: number[]): number[] {
    const a: number[] = []
    for (let i = 0; i < MAX_KARTS; i++) a.push(i < ids.length ? ids[i] : -1)
    return a
  }

  it('flips countdown to racing at COUNTDOWN_TICKS and emits nothing', () => {
    const ctx = makeContext(makeStraightTrack())
    const events: AuthEvent[] = []

    const early = humanState(ctx, 'countdown', COUNTDOWN_TICKS - 1) // 179
    updatePhase(ctx, early, events)
    expect(early.phase).toBe('countdown')
    expect(events.length).toBe(0)

    const on = humanState(ctx, 'countdown', COUNTDOWN_TICKS)        // 180
    updatePhase(ctx, on, events)
    expect(on.phase).toBe('racing')
    expect(events.length).toBe(0)     // there is no AuthEventKind for "go"

    const late = humanState(ctx, 'countdown', COUNTDOWN_TICKS + 40) // 220
    updatePhase(ctx, late, events)
    expect(late.phase).toBe('racing')
  })

  it('never advances a countdown straight to finished', () => {
    const ctx = makeContext(makeStraightTrack())
    const s = humanState(ctx, 'countdown', COUNTDOWN_TICKS)
    s.finishedOrder = order(0, 1, 2, 3, 4, 5, 6, 7)   // all 8 slots filled
    s.finishTick = 10
    const events: AuthEvent[] = []

    updatePhase(ctx, s, events)

    expect(s.phase).toBe('racing')    // one transition per tick, countdown first
    expect(events.length).toBe(0)
  })

  it('sets finishTick on the tick the first kart appears in finishedOrder', () => {
    const ctx = makeContext(makeStraightTrack())
    const events: AuthEvent[] = []

    const s = humanState(ctx, 'racing', 1234)
    expect(s.finishTick).toBe(-1)     // createState leaves it at -1
    expect(s.finishedOrder).toEqual(order())   // createState leaves all 8 slots at -1
    s.finishedOrder = order(3)

    updatePhase(ctx, s, events)

    expect(s.finishTick).toBe(1234)
    expect(s.phase).toBe('racing')    // 1234 - 1234 = 0 < FINISH_GRACE_TICKS
    expect(events.length).toBe(0)

    // idempotent: a finishTick already set by updateLaps is never overwritten
    const t = humanState(ctx, 'racing', 1234)
    t.finishTick = 1000
    t.finishedOrder = order(3)
    updatePhase(ctx, t, events)
    expect(t.finishTick).toBe(1000)
  })

  it('finishes when every kart is in finishedOrder', () => {
    const ctx = makeContext(makeStraightTrack())
    const s = humanState(ctx, 'racing', 5000)
    s.finishTick = 4000
    s.finishedOrder = order(4, 1, 0, 7, 2, 6, 3, 5) // all 8 slots filled, no -1 left
    const seqBefore = s.nextEventSeq
    const events: AuthEvent[] = []

    updatePhase(ctx, s, events)

    expect(s.phase).toBe('finished')
    expect(s.finishedOrder).toEqual([4, 1, 0, 7, 2, 6, 3, 5]) // unchanged, nobody DNF'd
    expect(events.length).toBe(1)
    expect(events[0].kind).toBe('finish')
    expect(events[0].playerId).toBe(-1)   // -1 = the race itself, not a kart
    expect(events[0].entityId).toBe(-1)
    expect(events[0].item).toBe('none')
    expect(events[0].data).toBe(8)        // 8 filled slots = 8 finishers
    expect(events[0].tick).toBe(5000)
    expect(events[0].eventSeq).toBe(seqBefore)
    expect(s.nextEventSeq).toBe(seqBefore + 1)

    // running again on a finished race is a no-op
    updatePhase(ctx, s, events)
    expect(events.length).toBe(1)
    expect(s.nextEventSeq).toBe(seqBefore + 1)
  })

  it('holds the race open until the grace timer expires', () => {
    const ctx = makeContext(makeStraightTrack())
    const events: AuthEvent[] = []

    expect(FINISH_GRACE_TICKS).toBe(1800)  // 30 s at 60 Hz

    // finishTick 3000, so the race ends on tick 3000 + 1800 = 4800
    const nearly = humanState(ctx, 'racing', 4799)
    nearly.finishTick = 3000
    nearly.finishedOrder = order(2)
    updatePhase(ctx, nearly, events)
    expect(nearly.phase).toBe('racing')    // 4799 - 3000 = 1799 < 1800
    expect(events.length).toBe(0)
  })

  it('finishes on the grace timer and fills DNF karts in placement order', () => {
    const ctx = makeContext(makeStraightTrack())
    const s = humanState(ctx, 'racing', 4800)
    s.finishTick = 3000                    // 4800 - 3000 = 1800 >= FINISH_GRACE_TICKS
    s.finishedOrder = order(2)             // [2, -1, -1, -1, -1, -1, -1, -1]
    // Give every kart a distinct, descending checkpoint index so placement is
    // unambiguous: kart i sits at checkpointIdx 7 - i, all on lap 0, all t 0.
    // Placement best-first is therefore [0,1,2,3,4,5,6,7]; kart 2 already holds
    // slot 0, so the DNF fill writes 0,1,3,4,5,6,7 into slots 1..7 in that order.
    for (let i = 0; i < MAX_KARTS; i++) {
      s.karts[i].lap.lap = 0
      s.karts[i].lap.checkpointIdx = 7 - i
      s.karts[i].lap.t = 0
    }
    const seqBefore = s.nextEventSeq
    const events: AuthEvent[] = []

    updatePhase(ctx, s, events)

    expect(s.phase).toBe('finished')
    expect(s.finishedOrder).toEqual([2, 0, 1, 3, 4, 5, 6, 7])
    expect(s.finishedOrder.length).toBe(8)

    // 7 per-kart DNF finish events, then 1 race-level event
    expect(events.length).toBe(8)
    expect(events.map((e) => e.playerId)).toEqual([0, 1, 3, 4, 5, 6, 7, -1])
    // `data` on a per-kart finish is the 1-based finishing place, exactly as
    // updateLaps [Task 11] emits it: the number of filled finishedOrder slots
    // AFTER that kart was recorded. Kart 2 already held place 1, so the seven
    // DNF karts take places 2..8:
    //   0 -> 2 filled -> 2      4 -> 5 filled -> 5
    //   1 -> 3 filled -> 3      5 -> 6 filled -> 6
    //   3 -> 4 filled -> 4      6 -> 7 filled -> 7
    //                           7 -> 8 filled -> 8
    // The trailing 8 is the race-level event, which carries the finisher count
    // (8, because the fill leaves no slot at -1).
    expect(events.map((e) => e.data)).toEqual([2, 3, 4, 5, 6, 7, 8, 8])
    for (let i = 0; i < 8; i++) {
      expect(events[i].kind).toBe('finish')
      expect(events[i].tick).toBe(4800)
      expect(events[i].entityId).toBe(-1)
      expect(events[i].item).toBe('none')
      expect(events[i].eventSeq).toBe(seqBefore + i)   // strictly monotonic, no gaps
    }
    expect(s.nextEventSeq).toBe(seqBefore + 8)
  })

  it('transitions on a non-leader but emits nothing and burns no eventSeq', () => {
    const ctx = makeContext(makeStraightTrack(), false)  // isLeader = false
    expect(ctx.isLeader).toBe(false)
    const s = humanState(ctx, 'racing', 5000)
    s.finishTick = 4000
    s.finishedOrder = order(4, 1, 0, 7, 2, 6, 3, 5)
    const seqBefore = s.nextEventSeq
    const events: AuthEvent[] = []

    updatePhase(ctx, s, events)

    expect(s.phase).toBe('finished')      // the transition is deterministic everywhere
    expect(events.length).toBe(0)         // but only the authority numbers events
    expect(s.nextEventSeq).toBe(seqBefore)
  })

  it('fills DNF karts on a non-leader too, so finishedOrder stays in sync', () => {
    const ctx = makeContext(makeStraightTrack(), false)
    const s = humanState(ctx, 'racing', 4800)
    s.finishTick = 3000
    s.finishedOrder = order(2)
    for (let i = 0; i < MAX_KARTS; i++) {
      s.karts[i].lap.lap = 0
      s.karts[i].lap.checkpointIdx = 7 - i
      s.karts[i].lap.t = 0
    }
    const seqBefore = s.nextEventSeq
    const events: AuthEvent[] = []

    updatePhase(ctx, s, events)

    expect(s.finishedOrder).toEqual([2, 0, 1, 3, 4, 5, 6, 7])
    expect(events.length).toBe(0)
    expect(s.nextEventSeq).toBe(seqBefore)
  })
})
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run packages/sim/test/phase.test.ts -t "flips countdown to racing"`

Expected: FAIL. `tsc`/vitest reports `"updatePhase" is not exported by "packages/sim/src/phase.ts"`, or at runtime `TypeError: updatePhase is not a function`.

- [ ] **Step 7: Write minimal implementation — `updatePhase`**

Two edits to `packages/sim/src/phase.ts`.

First, replace the four import lines at the top of the file. Before:

```ts
import type { Intent, SimContext, SimState } from './types'
import { MAX_KARTS } from './types'
import { clamp } from './mathutil'
import { botIntent } from './bot'
```

After:

```ts
import type { AuthEvent, Intent, SimContext, SimState } from './types'
import { COUNTDOWN_TICKS, MAX_KARTS } from './types'
import { clamp } from './mathutil'
import { emit } from './state'
import { botIntent } from './bot'
import { placementOrder } from './placement'
```

Second, append this function to the end of the file:

```ts
/**
 * Last call of the tick, after the kart loop and after
 * resolveKartCollisions -> updateEntities -> updateItemBoxes.
 *
 * countdown -> racing:  on the first tick at or past COUNTDOWN_TICKS. Because
 *   this runs at the END of the tick, the tick that ends the countdown still ran
 *   with frozen input, and COUNTDOWN_TICKS + 1 is the first live tick.
 *
 * racing -> finished:  when every kart is in finishedOrder, or when
 *   FINISH_GRACE_TICKS have elapsed since finishTick. On a timeout the karts
 *   still driving are written into the free finishedOrder slots in placement
 *   order, so the results screen has a complete ranking and no kart is missing.
 *
 * finishedOrder is FIXED LENGTH MAX_KARTS with -1 in every unused slot (locked
 * contract §0). It is never pushed and never indexOf'd: growing it past 8 makes
 * the next cloneState throw, which would take recordRun/replayRun [Task 16] and
 * the golden run [Task 17] down with it. Every count below is a scan of the 8
 * slots for entries !== -1.
 *
 * The transition itself is deterministic and happens on every peer. Only
 * `ctx.isLeader` emits, because eventSeq is assigned by the current authority
 * and a client that emitted here would silently desync `state.nextEventSeq`.
 */
export function updatePhase(ctx: SimContext, state: SimState, events: AuthEvent[]): void {
  if (state.phase === 'countdown') {
    if (state.tick >= COUNTDOWN_TICKS) state.phase = 'racing'
    return
  }
  if (state.phase !== 'racing') return

  let finishers = 0
  for (let i = 0; i < MAX_KARTS; i++) {
    if (state.finishedOrder[i] !== -1) finishers++
  }

  // Defensive: updateLaps [Task 11] normally stamps finishTick on the tick it
  // records the first finisher. If it did, this guard is already false.
  if (state.finishTick < 0 && finishers > 0) {
    state.finishTick = state.tick
  }

  const allDone = finishers >= MAX_KARTS
  const graceUp =
    state.finishTick >= 0 && state.tick - state.finishTick >= FINISH_GRACE_TICKS
  if (!allDone && !graceUp) return

  if (!allDone) {
    const order = placementOrder(state)
    for (let n = 0; n < order.length; n++) {
      const pid = order[n]

      // Already recorded? Scan the 8 fixed slots. A playerId is never -1, so a
      // hit here is always a real finisher and never the padding.
      let seen = false
      for (let i = 0; i < MAX_KARTS; i++) {
        if (state.finishedOrder[i] === pid) {
          seen = true
          break
        }
      }
      if (seen) continue

      // Write into the first slot still holding -1. placementOrder returns all
      // MAX_KARTS playerIds and each is written at most once, so a free slot
      // always exists here. The guard exists so a malformed array stops the loop
      // instead of assigning to index -1, which would hang a stray '-1' property
      // off the array and desync cloneState/statesEqual.
      let slot = -1
      for (let i = 0; i < MAX_KARTS; i++) {
        if (state.finishedOrder[i] === -1) {
          slot = i
          break
        }
      }
      if (slot < 0) break

      state.finishedOrder[slot] = pid
      finishers++
      if (ctx.isLeader) {
        // 1-based finishing place, the same meaning updateLaps [Task 11] gives
        // `data`: the number of filled slots after this kart was recorded.
        emit(state, events, 'finish', pid, -1, 'none', finishers)
      }
    }
  }

  state.phase = 'finished'
  if (ctx.isLeader) {
    emit(state, events, 'finish', -1, -1, 'none', finishers)
  }
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npx vitest run packages/sim/test/phase.test.ts`

Expected: PASS — 15 tests (7 in `resolveInputs`, 8 in `updatePhase`).

- [ ] **Step 9: Write the failing test — `step()` wiring**

Append to `packages/sim/test/phase.test.ts`. Extend the import lines at the top of the file once more.

Replace:

```ts
import { createState } from '../src/state'
```

with:

```ts
import { createState } from '../src/state'
import { step } from '../src/step'
```

Then append:

```ts
describe('step() wiring', () => {
  it('runs resolveInputs at position 1 and updatePhase in the tail', () => {
    const ctx = makeContext(makeStraightTrack())
    let cur = createState(ctx, 7, [0, 0, 0, 0, 0, 0, 0, 0])
    let nxt = createState(ctx, 7, [0, 0, 0, 0, 0, 0, 0, 0])
    for (let i = 0; i < MAX_KARTS; i++) {
      cur.karts[i].isBot = false
      cur.karts[i].connected = true
    }
    cur.karts[7].isBot = true

    // Precondition on the fixture grid. If two karts start closer than one kart
    // diameter (2 * kartRadius = 2 * 0.9 = 1.8 m) then resolveKartCollisions
    // would push them apart during the countdown and the exact-zero assertions
    // below would be measuring collisions instead of the input freeze.
    for (let i = 0; i < MAX_KARTS; i++) {
      for (let j = i + 1; j < MAX_KARTS; j++) {
        const dx = cur.karts[i].position.x - cur.karts[j].position.x
        const dz = cur.karts[i].position.z - cur.karts[j].position.z
        expect(Math.sqrt(dx * dx + dz * dz)).toBeGreaterThan(2 * ctx.tuning.kartRadius)
      }
    }

    const startX0 = cur.karts[0].position.x
    const startZ0 = cur.karts[0].position.z
    const startX7 = cur.karts[7].position.x

    // Everyone mashes the throttle through the whole countdown.
    const inputs: Intent[] = []
    for (let i = 0; i < MAX_KARTS; i++) {
      inputs.push(intent({ tick: 0, steer: 0, accel: 1, brake: false, drift: true, useItem: true }))
    }
    const events: AuthEvent[] = []

    resetBotHold()
    expect(cur.tick).toBe(0)
    expect(cur.phase).toBe('countdown')

    for (let n = 0; n < COUNTDOWN_TICKS - 1; n++) {   // 179 ticks -> tick 179
      events.length = 0
      step(ctx, cur, nxt, inputs, events)
      const tmp = cur
      cur = nxt
      nxt = tmp
    }
    expect(cur.tick).toBe(179)
    expect(cur.phase).toBe('countdown')

    events.length = 0
    step(ctx, cur, nxt, inputs, events)          // the 180th step
    let tmp = cur
    cur = nxt
    nxt = tmp
    expect(cur.tick).toBe(180)
    expect(cur.phase).toBe('racing')             // updatePhase ran in the tail

    // 180 ticks of full throttle produced exactly nothing, because
    // resolveInputs zeroed every intent before stepKart ever saw one.
    expect(Object.is(cur.karts[0].velocity.x, 0)).toBe(true)
    expect(Object.is(cur.karts[0].velocity.z, 0)).toBe(true)
    expect(Object.is(cur.karts[0].position.x, startX0)).toBe(true)
    expect(Object.is(cur.karts[0].position.z, startZ0)).toBe(true)
    expect(cur.karts[0].drift.active).toBe(false)
    expect(cur.karts[0].drift.charge).toBe(0)
    // and the bot slot was frozen on exactly the same rule
    expect(Object.is(cur.karts[7].velocity.x, 0)).toBe(true)
    expect(Object.is(cur.karts[7].position.x, startX7)).toBe(true)

    // one more tick, now racing: the same input finally does something
    events.length = 0
    step(ctx, cur, nxt, inputs, events)
    tmp = cur
    cur = nxt
    nxt = tmp
    expect(cur.tick).toBe(181)
    expect(cur.phase).toBe('racing')
    expect(cur.karts[0].velocity.x).toBeGreaterThan(0)
    expect(Object.is(cur.karts[0].velocity.z, 0)).toBe(true)  // steer 0, heading 0, +X track
    expect(cur.karts[0].position.x).toBeGreaterThan(startX0)
  })
})
```

- [ ] **Step 10: Run test to verify it fails**

Run: `npx vitest run packages/sim/test/phase.test.ts -t "runs resolveInputs at position 1"`

Expected: FAIL at `expect(cur.phase).toBe('racing')` after the 180th step with `expected 'countdown' to be 'racing'` — `step()` does not call `updatePhase` yet, so nothing ever leaves the countdown. That is the first failing assertion, because it precedes the velocity checks in the test body. The assertions after it are failing too and will surface once Step 11 lands `updatePhase`: Task 6's stand-in fill loop copies each raw intent through verbatim, so all 180 countdown ticks ran at `accel: 1` and `Object.is(cur.karts[0].velocity.x, 0)` is `false`. Both halves of the test go green only when Step 11's Edit 4 has *replaced* that fill loop rather than run before it.

- [ ] **Step 11: Wire `phase.ts` into `step.ts`**

Five exact edits to `packages/sim/src/step.ts`. Nothing else in the file changes; leave the bodies of the per-kart calls exactly as Tasks 6–14 left them.

Read this before making them: `step.ts` **already has** a module-scope `resolvedInputs`
buffer and a module-scope `NEUTRAL_INTENT`, both written by Task 6 (Task 6 Step 15's
complete-file listing), and it already fills that buffer with a stand-in loop that copies
each raw intent straight through. This task does not *add* a buffer — it swaps Task 6's
initializer for `makeIntentBuffer()`, deletes the stand-in fill loop and `NEUTRAL_INTENT`
with it, and puts `resolveInputs` in the fill loop's exact place. Getting that placement
wrong is not cosmetic: if `resolveInputs` lands *before* the fill loop, the fill loop then
overwrites `resolvedInputs` with the raw client intents and the countdown freeze, bot fill
and 30 Hz hold are all silently discarded — which is exactly what Step 9's test checks.

**Edit 1 — add the import.** Add this line at the end of the existing import block:

```ts
import { makeIntentBuffer, resolveInputs, updatePhase } from './phase'
```

**Edit 2 — replace Task 6's stand-in buffer: delete `NEUTRAL_INTENT` and swap the
initializer for `makeIntentBuffer()`.** These two declarations are adjacent, in this order,
between the import block and the `step()` doc comment. Before:

```ts
/**
 * The intent used for a seat the caller supplied nothing for. Module-level so the
 * hot path allocates nothing; never mutated, and never handed to a kart directly —
 * it is copied into `resolvedInputs` like any other source intent.
 */
const NEUTRAL_INTENT: Intent = {
  tick: 0,
  steer: 0,
  accel: 0,
  brake: false,
  drift: false,
  useItem: false,
}

/**
 * The resolved intents the whole tick reads. `MAX_KARTS` distinct Intent objects,
 * allocated once at module load and rewritten in place every tick, because step()
 * must never allocate in the hot path. Indexed by kart slot.
 *
 * Task 15 replaces the fill loop below with
 * `resolveInputs(ctx, next, inputs, resolvedInputs)` and this initializer with
 * `makeIntentBuffer()`, which produces exactly this shape. The buffer, and the
 * `const raw = resolvedInputs[i]` line in the kart loop, exist from this task
 * onward so that Tasks 7, 8, 13 and 15 all edit against locals that are already
 * there.
 */
const resolvedInputs: Intent[] = Array.from({ length: MAX_KARTS }, () => ({
  tick: 0,
  steer: 0,
  accel: 0,
  brake: false,
  drift: false,
  useItem: false,
}))
```

After:

```ts
/**
 * The resolved intents the whole tick reads. Exactly `MAX_KARTS` distinct Intent
 * objects, allocated once at module load and rewritten in place every tick,
 * because step() must never allocate in the hot path. Indexed by kart slot.
 *
 * `makeIntentBuffer()` [Task 15] produces exactly the shape Task 6's `Array.from`
 * literal produced, so every reader of this buffer is unaffected by the swap.
 */
const resolvedInputs: Intent[] = makeIntentBuffer()
```

`NEUTRAL_INTENT` goes in the same edit rather than a later one because Edit 4 removes its
only reader, and `packages/sim/tsconfig.json` [Task 1] sets `"noUnusedLocals": true` — a
surviving `NEUTRAL_INTENT` fails Step 13's `tsc --noEmit` with
`TS6133: 'NEUTRAL_INTENT' is declared but its value is never read`. `Intent` stays imported
(it is in `step`'s own signature and in this declaration) and `MAX_KARTS` stays imported
(the per-kart loop still uses it), so neither import line changes.

**Edit 3 — retire the stand-in note in `step()`'s stage-order comment.** One line inside the
doc comment above `export function step`. Before:

```ts
 *   1. resolveInputs      [Task 15] <- this task's fill loop stands in for it
 *   2. updateRecovery     [Task 9]
```

After:

```ts
 *   1. resolveInputs      [Task 15] <- implemented
 *   2. updateRecovery     [Task 9]
```

**Edit 4 — delete Task 6's fill loop and put `resolveInputs` in its place.** The `before`
block below runs from `next.tick = prev.tick + 1` through the first three lines of the
per-kart loop; those three locals are quoted only to pin the insertion point and come back
byte-identical in the `after` block. Do not touch them, and do not touch anything after
them — `if (raw.useItem) useItem(ctx, next, k, events)` [Task 13] and every stage below it
stay exactly as Tasks 7–14 left them. Before:

```ts
  next.tick = prev.tick + 1

  // Canonical position 1, in its pre-Task-15 form: copy each supplied intent into
  // the resolved buffer, substituting NEUTRAL_INTENT for a seat the caller left
  // out. No phase gating, no bot fill, no 30Hz hold and no sanitisation yet — all
  // four arrive with Task 15, which replaces this whole loop with one call.
  for (let i = 0; i < MAX_KARTS; i++) {
    const supplied = inputs[i]
    const src = supplied === undefined ? NEUTRAL_INTENT : supplied
    const dst = resolvedInputs[i]
    dst.tick = src.tick
    dst.steer = src.steer
    dst.accel = src.accel
    dst.brake = src.brake
    dst.drift = src.drift
    dst.useItem = src.useItem
  }

  for (let i = 0; i < MAX_KARTS; i++) {
    const k = next.karts[i]
    const prevKart = prev.karts[i]
    const raw = resolvedInputs[i]
```

After:

```ts
  next.tick = prev.tick + 1

  // Canonical per-kart order, position 1: phase gating, bot fill, 30Hz hold and
  // sanitisation, all four at once — this call is what Task 6's stand-in fill loop
  // was standing in for, and it occupies exactly that loop's position. Every stage
  // below this line reads `resolvedInputs`, never the raw `inputs`.
  resolveInputs(ctx, next, inputs, resolvedInputs)

  for (let i = 0; i < MAX_KARTS; i++) {
    const k = next.karts[i]
    const prevKart = prev.karts[i]
    const raw = resolvedInputs[i]
```

`resolveInputs` reads `next.tick` and `next.phase`, which is why it sits after
`next.tick = prev.tick + 1`: the intent is stamped with the tick it is applied at, and
`next.phase` is still the phase `updatePhase` set at the end of the *previous* tick, so the
countdown freeze covers ticks 1…`COUNTDOWN_TICKS` inclusive.

**Edit 5 — run `updatePhase` last.** `updateItemBoxes` is the final statement of `step()` after Task 13, so this anchor is unique. Before:

```ts
  updateItemBoxes(ctx, next, events)
}
```

After:

```ts
  updateItemBoxes(ctx, next, events)
  updatePhase(ctx, next, events)
}
```

- [ ] **Step 12: Run test to verify it passes**

Run: `npx vitest run packages/sim/test/phase.test.ts`

Expected: PASS — 16 tests.

- [ ] **Step 13: Run the full sim suite and typecheck**

Run: `npx tsc --noEmit -p packages/sim && npx vitest run packages/sim`

Expected: PASS, zero type errors. Two things could have broken here and neither may be papered over:

- **Type errors.** Edit 2 deleted `NEUTRAL_INTENT`; if `tsc` reports `TS6133` for it, the deletion did not happen. If `tsc` reports `TS2451: Cannot redeclare block-scoped variable 'resolvedInputs'`, Edit 2 was applied as an *addition* instead of a replacement of Task 6's `Array.from(...)` initializer — go back and remove the Task 6 declaration.
- **Earlier tests.** The kart loop still reads `resolvedInputs[i]`, exactly as Tasks 6–14 wrote it; what changed is how that buffer is filled. Any test from Tasks 6–14 that fed live input while `phase === 'countdown'` now sees a frozen kart. If one fails for that reason, set `state.phase = 'racing'` in that test's setup; do not weaken `resolveInputs`.

- [ ] **Step 14: Commit**

```bash
git add packages/sim/src/phase.ts packages/sim/src/step.ts packages/sim/test/phase.test.ts
git commit -m "feat(sim): race phase transitions and per-tick input resolution

resolveInputs freezes all input during the countdown, drives bot and
disconnected slots from botIntent held across tick pairs so bots run at
30Hz against the 60Hz sim, and clamps/sanitises human input at the
authority boundary. updatePhase ends the countdown at COUNTDOWN_TICKS
and ends the race when every kart has finished or FINISH_GRACE_TICKS
have elapsed since finishTick, filling DNF karts in placement order and
emitting only on the leader. Wired at position 1 and in the tail of
step()."
```

---

### Task 16: Run Recorder and Checkpoint-Replay Equivalence

**Files:**
- Create: `packages/sim/src/replay.ts`
- Test: `packages/sim/test/replay.test.ts`

**Interfaces:**

- Consumes (all exist before this task; signatures repeated in full so this task can be read in isolation):
  - `packages/sim/src/types.ts` [Task 2] — `MAX_KARTS = 8`, `MAX_ENTITIES = 32`, `COUNTDOWN_TICKS = 180`, `TICK_DT = 1/60`, and the types `Intent`, `SimState`, `SimContext`, `AuthEvent`, `Track`, `Tuning`, `CharacterStats`.
    - `Intent` is exactly `{ tick: number; steer: number; accel: number; brake: boolean; drift: boolean; useItem: boolean }`.
    - `SimState` is exactly `{ tick, phase, raceSeed, rngCursor, nextEventSeq, finishTick, karts, entities, entityCount, nextEntityId, itemBoxes, finishedOrder }`; `karts` is always length `MAX_KARTS`, `entities` always length `MAX_ENTITIES` with live ones packed at the front and dead slots carrying `entityId === -1`, and `finishedOrder` always length `MAX_KARTS` with `-1` in every unfilled slot (locked contract §0 — it is never `push`ed, and `cloneState` throws if `dst` and `src` disagree on any of those lengths).
  - `packages/sim/src/rng.ts` [Task 2] — `export function rngAt(seed: number, cursor: number): number` (splitmix32, returns `[0, 1)`, pure: no hidden state, does not touch `SimState`).
  - `packages/sim/src/state.ts` [Task 5] —
    - `export function createState(ctx: SimContext, seed: number, characterIdx: number[]): SimState`
    - `export function cloneState(src: SimState, dst: SimState): void` — deep copy of every field, every one of the `MAX_KARTS` karts and **all `MAX_ENTITIES` entity slots including dead ones**, `itemBoxes`, and `finishedOrder`.
    - `export function statesEqual(a: SimState, b: SimState): boolean` — `Object.is` on every scalar, no exceptions and no epsilons.
  - `packages/sim/src/step.ts` [Task 5, extended by 6–15] — `export function step(ctx: SimContext, prev: SimState, next: SimState, inputs: Intent[], events: AuthEvent[]): void`. Writes into `next`, never mutates `prev`, sets `next.tick = prev.tick + 1`, never reads the wall clock, never calls `Math.random()`.
  - `packages/sim/src/phase.ts` [Task 15] —
    - `export function makeIntentBuffer(): Intent[]` — a new array of exactly `MAX_KARTS` distinct `Intent` objects, all fields zeroed.
    - `export function resetBotHold(): void` — clears the module-level 30 Hz bot-intent hold.
    - `export function resolveInputs(ctx: SimContext, state: SimState, inputs: Intent[], out: Intent[]): void` — runs at position 1 of the per-kart order; freezes all input while `state.phase === 'countdown'`, substitutes `botIntent` for any kart with `isBot` or `!connected` (recomputed only when `state.tick % 2 === 0`, reused on the odd tick of the pair), and clamps/sanitises everything else.
  - `packages/sim/test/fixtures/track-fixtures.ts` [Task 3] — `makeOvalTrack(overrides?: Partial<Track>): Track` (the golden fixture track), `makeStraightTrack(overrides?: Partial<Track>): Track`, and `makeContext(track: Track, isLeader?: boolean): SimContext` [Task 4, because it needs `buildTrackQuery`] (`isLeader` defaults to `true`).

- Produces:
  - `export const INTENT_HEADER = 4` — doubles of header at the front of a recording.
  - `export const INTENT_STRIDE = 5` — doubles per `(tick, slot)` intent: `steer, accel, brake, drift, useItem`.
  - `export function intentOffset(intents: Float64Array, tick: number, slot: number): number` — index of the first double of the intent recorded for kart slot `slot` at pre-step tick `tick`.
  - `export function allocStateLike(ctx: SimContext, src: SimState): SimState` — a brand-new, fully detached `SimState` holding a deep copy of `src`.
  - `export interface IntentSource { intentFor(state: SimState, playerId: number): Intent }` — verbatim from the locked contract.
  - `export function recordRun(ctx: SimContext, from: SimState, ticks: number, src: IntentSource): { end: SimState; intents: Float64Array }`
  - `export function replayRun(ctx: SimContext, from: SimState, intents: Float64Array, fromTick: number, toTick: number): SimState`

---

**The recording layout, fixed here:**

```
intents[0] = baseTick        the tick of the state the recording starts from
intents[1] = rows            number of recorded ticks
intents[2] = MAX_KARTS       8
intents[3] = INTENT_STRIDE   5

body index for (tick t, slot i):
  INTENT_HEADER + ((t - baseTick) * MAX_KARTS + i) * INTENT_STRIDE
    +0 steer     (float)
    +1 accel     (float)
    +2 brake     (0 or 1)
    +3 drift     (0 or 1)
    +4 useItem   (0 or 1)

total length = 4 + rows * 8 * 5 = 4 + 40 * rows
```

`Intent.tick` is **not** stored: it is implied by the row, and `resolveInputs`
restamps it from `state.tick` anyway. A row is keyed by the **pre-step** tick —
row `t` holds the intents fed to the step that consumes the state at tick `t` and
produces tick `t + 1`. The header makes the array self-describing, so
`replayRun` can range-check absolute tick numbers instead of trusting its caller.

---

**Why this test is same-process only, and why that is exactly enough:**

IEEE-754 makes `+ - * / sqrt` bit-exactly reproducible on every conforming
engine — the standard specifies correctly-rounded results, so the same sequence
of those operations on the same inputs produces the same bits everywhere.
`Math.sin`, `Math.cos`, `Math.atan2` and `Math.pow` are a different category.
ECMA-262 explicitly declines to specify their precision: implementations may use
any approximation of the mathematical function, with `fdlibm` recommended and
not required. V8, JavaScriptCore and SpiderMonkey use different polynomial
kernels and different argument-reduction paths, and V8 has changed its own
`Math.sin` across releases. One ULP of difference in `Math.cos(heading)` on tick
one becomes metres of kart separation a few hundred ticks later, because the
integrator feeds its own output straight back in.

Tapkart's simulation calls `Math.cos`/`Math.sin` for every kart on every tick —
the contract fixes `forward = (cos h, 0, sin h)` — and `Math.atan2` wherever a
heading is derived from a direction. Cross-engine bit-identity is therefore not
available, and no amount of test discipline creates it. Getting it would mean
fixed-point or a software transcendental library, which is what lockstep RTS
games actually do.

**And it is not needed, because Tapkart is not lockstep.** The design is
snapshot plus reconciliation. The authority alone decides what happened; clients
predict locally and are corrected against `WireSnapshot`, which is quantized to
roughly 21 bytes per kart and lossy by construction. A client is *already* being
pulled onto values it did not compute, twenty times a second, on purpose.
Nothing anywhere in the netcode compares two independently-simulated float
streams across two machines for equality. A lockstep design would, and that is
precisely why lockstep games ship fixed-point math and Tapkart does not have to.

What the same-process test does buy is the one property the whole netcode rests
on: **restoring a `SimState` and replaying inputs reproduces the state exactly.**
That is reconciliation, stated as a test. If it holds, a client that rewinds to
an authoritative checkpoint and replays its buffered inputs lands on precisely
the state the authority computed from those same inputs, so a correction settles
instead of oscillating. If it fails — because `step()` read a field that
`cloneState` forgot to copy, or kept state in a module-level variable, or
consumed a PRNG draw it did not record in `rngCursor`, or wrote past
`entityCount` into a dead slot that `cloneState` skips — then reconciliation
drifts silently and the defect surfaces three months later as "the game feels
rubbery under packet loss". This test converts that entire class of bug into a
red test, in one process, on one engine, where it is both provable and cheap.

**The one known piece of state outside `SimState`,** and therefore outside
`cloneState` and `statesEqual`, is Task 15's 30 Hz bot hold: bots recompute an
`Intent` only on even ticks and the odd tick of the pair reuses it, and there is
no `SimState` field to store the held value in. That yields a stated invariant:

> **Checkpoint parity invariant.** A checkpoint taken at tick `T` replays
> bit-identically for **any** `T` when no kart is bot-driven. When bots or
> disconnected karts are present, `T` must be **odd**, so that the first replayed
> step produces the even tick `T + 1`, and an even tick always recomputes bot
> intents from scratch. On an even `T` the first replayed step produces an odd
> tick, which in the straight-through run reused an intent derived from the kart
> data as it stood at the *start* of tick `T` — data a checkpoint taken at the
> *end* of tick `T` does not contain. Authority checkpoints are therefore emitted
> on odd ticks.

---

- [ ] **Step 1: Write the failing test — layout, round trip, and checkpoint equivalence**

Create `packages/sim/test/replay.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { Intent, SimContext, SimState } from '../src/types'
import { COUNTDOWN_TICKS, MAX_KARTS } from '../src/types'
import { rngAt } from '../src/rng'
import { cloneState, createState, statesEqual } from '../src/state'
import type { IntentSource } from '../src/replay'
import {
  INTENT_HEADER,
  INTENT_STRIDE,
  allocStateLike,
  intentOffset,
  recordRun,
  replayRun,
} from '../src/replay'
import { makeContext, makeOvalTrack } from './fixtures/track-fixtures'

const CHARS = [0, 1, 2, 3, 4, 5, 6, 7]
const SEED = 0x1234abcd

/** Eight human, connected karts. No bot hold involvement at all. */
function humanStart(ctx: SimContext): SimState {
  const s = createState(ctx, SEED, CHARS)
  for (let i = 0; i < MAX_KARTS; i++) {
    s.karts[i].isBot = false
    s.karts[i].connected = true
  }
  return s
}

/**
 * A deterministic, varied driver. Pure in (state.tick, playerId): it draws from
 * splitmix32 on its own seed, so it never touches state.rngCursor and cannot
 * interfere with authority item rolls.
 */
const scriptedSrc: IntentSource = {
  intentFor(state: SimState, playerId: number): Intent {
    const c = state.tick * MAX_KARTS + playerId
    const a = rngAt(0x5eed, c * 4 + 0)
    const b = rngAt(0x5eed, c * 4 + 1)
    const d = rngAt(0x5eed, c * 4 + 2)
    const e = rngAt(0x5eed, c * 4 + 3)
    return {
      tick: state.tick,
      steer: a * 2 - 1,        // full -1..1 sweep
      accel: b < 0.1 ? 0 : 1,  // throttle 90% of ticks
      brake: d < 0.05,
      drift: e < 0.35,
      useItem: d > 0.98,
    }
  },
}

/** playerId-dependent constants, all exact binary64 multiples of 1/8. */
const constSrc: IntentSource = {
  intentFor(state: SimState, playerId: number): Intent {
    return {
      tick: state.tick,
      steer: playerId * 0.125 - 0.5,
      accel: 1,
      brake: false,
      drift: playerId === 3,
      useItem: false,
    }
  },
}

describe('recordRun', () => {
  it('writes a flat Float64Array with a four-double header', () => {
    const ctx = makeContext(makeOvalTrack())
    const start = humanStart(ctx)
    start.phase = 'racing'   // skip the countdown so the karts actually move

    const rec = recordRun(ctx, start, 4, constSrc)

    // 4 header doubles + 4 ticks * 8 karts * 5 doubles = 4 + 160 = 164
    expect(INTENT_HEADER).toBe(4)
    expect(INTENT_STRIDE).toBe(5)
    expect(rec.intents.length).toBe(164)
    expect(rec.intents[0]).toBe(0)   // baseTick = start.tick
    expect(rec.intents[1]).toBe(4)   // rows
    expect(rec.intents[2]).toBe(8)   // MAX_KARTS
    expect(rec.intents[3]).toBe(5)   // INTENT_STRIDE
    expect(rec.end.tick).toBe(4)

    // offset(tick 0, slot 0) = 4 + ((0 - 0) * 8 + 0) * 5 = 4
    expect(intentOffset(rec.intents, 0, 0)).toBe(4)
    expect(rec.intents[4]).toBe(-0.5)   // steer   = 0 * 0.125 - 0.5
    expect(rec.intents[5]).toBe(1)      // accel
    expect(rec.intents[6]).toBe(0)      // brake   false
    expect(rec.intents[7]).toBe(0)      // drift   false
    expect(rec.intents[8]).toBe(0)      // useItem false

    // offset(tick 0, slot 3) = 4 + ((0 - 0) * 8 + 3) * 5 = 19
    expect(intentOffset(rec.intents, 0, 3)).toBe(19)
    expect(rec.intents[19]).toBe(-0.125)  // 3 * 0.125 - 0.5
    expect(rec.intents[22]).toBe(1)       // drift true only for playerId 3

    // offset(tick 3, slot 7) = 4 + ((3 - 0) * 8 + 7) * 5 = 4 + 155 = 159
    expect(intentOffset(rec.intents, 3, 7)).toBe(159)
    expect(rec.intents[159]).toBe(0.375)  // 7 * 0.125 - 0.5
    expect(rec.intents[160]).toBe(1)

    // the run did something
    expect(rec.end.karts[0].position.x).not.toBe(start.karts[0].position.x)
  })

  it('with zero ticks returns a detached copy of the start state', () => {
    const ctx = makeContext(makeOvalTrack())
    const start = humanStart(ctx)

    const rec = recordRun(ctx, start, 0, constSrc)

    expect(rec.intents.length).toBe(4)   // header only
    expect(rec.intents[1]).toBe(0)
    expect(rec.end).not.toBe(start)      // a different object...
    expect(statesEqual(rec.end, start)).toBe(true)  // ...with identical contents

    rec.end.karts[2].position.x += 999
    expect(start.karts[2].position.x).not.toBe(rec.end.karts[2].position.x)
  })

  it('does not mutate the state it was handed', () => {
    const ctx = makeContext(makeOvalTrack())
    const start = humanStart(ctx)
    start.phase = 'racing'
    const before = allocStateLike(ctx, start)

    recordRun(ctx, start, 30, scriptedSrc)

    expect(statesEqual(start, before)).toBe(true)
    expect(start.tick).toBe(0)
  })
})

describe('replayRun', () => {
  it('reproduces a recorded run from its own start state', () => {
    const ctx = makeContext(makeOvalTrack())
    const start = humanStart(ctx)
    start.phase = 'racing'

    const rec = recordRun(ctx, start, 40, scriptedSrc)
    const replayed = replayRun(ctx, allocStateLike(ctx, start), rec.intents, 0, 40)

    expect(replayed.tick).toBe(40)
    expect(statesEqual(replayed, rec.end)).toBe(true)
  })

  it('is repeatable and never mutates the state it resumes from', () => {
    const ctx = makeContext(makeOvalTrack())
    const start = humanStart(ctx)
    start.phase = 'racing'
    const rec = recordRun(ctx, start, 40, scriptedSrc)

    const from = allocStateLike(ctx, start)
    const savedX = from.karts[0].position.x
    const a = replayRun(ctx, from, rec.intents, 0, 40)
    const b = replayRun(ctx, from, rec.intents, 0, 40)

    expect(statesEqual(a, b)).toBe(true)
    expect(a).not.toBe(b)
    expect(from.tick).toBe(0)
    expect(Object.is(from.karts[0].position.x, savedX)).toBe(true)
  })
})

describe('checkpoint-replay equivalence', () => {
  // N = 600 ticks from tick 0. COUNTDOWN_TICKS = 180, so ticks 1..180 run with
  // frozen input and 181..600 are live racing: 420 racing ticks = 7.0 s at 60Hz.
  // The checkpoint is taken at T = 361, an odd tick (see the parity invariant),
  // leaving 600 - 361 = 239 ticks to replay.
  const N = 600
  const T = 361

  it('replays bit-identically from a full-precision checkpoint', () => {
    const ctx = makeContext(makeOvalTrack())
    const start = humanStart(ctx)

    // A: the straight-through run, 0 -> 600.
    const straight = recordRun(ctx, start, N, scriptedSrc)
    expect(straight.end.tick).toBe(600)
    expect(straight.end.phase).toBe('racing')   // 600 ticks is far short of 3 laps
    expect(straight.end.karts[0].position.x).not.toBe(start.karts[0].position.x)
    expect(straight.end.karts[7].position.x).not.toBe(start.karts[7].position.x)

    // B: the same trajectory, split at T so we hold the state at T.
    const seg1 = recordRun(ctx, start, T, scriptedSrc)          // 0 -> 361
    const seg2 = recordRun(ctx, seg1.end, N - T, scriptedSrc)   // 361 -> 600
    expect(seg1.end.tick).toBe(361)
    expect(seg2.end.tick).toBe(600)
    // splitting the run changes nothing: the sim is a pure function of state+input
    expect(statesEqual(seg2.end, straight.end)).toBe(true)

    // 4 + 239 * 8 * 5 = 4 + 9560 = 9564
    expect(seg2.intents.length).toBe(9564)
    expect(seg2.intents[0]).toBe(361)   // baseTick
    expect(seg2.intents[1]).toBe(239)   // rows
    // row 361 holds what the source produced from the state at tick 361
    const o = intentOffset(seg2.intents, 361, 5)
    expect(o).toBe(INTENT_HEADER + ((361 - 361) * MAX_KARTS + 5) * INTENT_STRIDE) // 29
    expect(seg2.intents[o]).toBe(scriptedSrc.intentFor(seg1.end, 5).steer)

    // The checkpoint: a full-precision structural clone, exactly what
    // AuthorityCheckpoint carries on the reliable channel.
    const checkpoint = allocStateLike(ctx, seg1.end)
    expect(checkpoint).not.toBe(seg1.end)
    expect(checkpoint.tick).toBe(361)
    expect(statesEqual(checkpoint, seg1.end)).toBe(true)

    // Restore it and replay the recorded inputs 361 -> 600.
    const replayed = replayRun(ctx, checkpoint, seg2.intents, T, N)

    expect(replayed.tick).toBe(600)
    expect(statesEqual(replayed, straight.end)).toBe(true)

    // statesEqual returns a bare boolean, so name the fields too: a failure
    // should say which kart and which quantity, not just "false".
    for (let i = 0; i < MAX_KARTS; i++) {
      const r = replayed.karts[i]
      const s = straight.end.karts[i]
      expect(Object.is(r.position.x, s.position.x)).toBe(true)
      expect(Object.is(r.position.y, s.position.y)).toBe(true)
      expect(Object.is(r.position.z, s.position.z)).toBe(true)
      expect(Object.is(r.velocity.x, s.velocity.x)).toBe(true)
      expect(Object.is(r.velocity.z, s.velocity.z)).toBe(true)
      expect(Object.is(r.heading, s.heading)).toBe(true)
      expect(Object.is(r.angularVelocity, s.angularVelocity)).toBe(true)
      expect(Object.is(r.drift.charge, s.drift.charge)).toBe(true)
      expect(r.drift.active).toBe(s.drift.active)
      expect(r.drift.dir).toBe(s.drift.dir)
      expect(r.item).toBe(s.item)
      expect(r.surface).toBe(s.surface)
      expect(r.airborne).toBe(s.airborne)
      expect(r.boostTicks).toBe(s.boostTicks)
      expect(r.spinOutTicks).toBe(s.spinOutTicks)
      expect(r.invulnTicks).toBe(s.invulnTicks)
      expect(r.respawnTicks).toBe(s.respawnTicks)
      expect(r.lap.lap).toBe(s.lap.lap)
      expect(r.lap.checkpointIdx).toBe(s.lap.checkpointIdx)
      expect(Object.is(r.lap.t, s.lap.t)).toBe(true)
    }

    // World state, not just karts: PRNG cursor, event sequence, entity pool.
    expect(replayed.rngCursor).toBe(straight.end.rngCursor)
    expect(replayed.nextEventSeq).toBe(straight.end.nextEventSeq)
    expect(replayed.nextEntityId).toBe(straight.end.nextEntityId)
    expect(replayed.entityCount).toBe(straight.end.entityCount)
    expect(replayed.phase).toBe(straight.end.phase)
    expect(replayed.finishTick).toBe(straight.end.finishTick)
    expect(replayed.finishedOrder).toEqual(straight.end.finishedOrder)
    for (let e = 0; e < replayed.entities.length; e++) {
      expect(replayed.entities[e].entityId).toBe(straight.end.entities[e].entityId)
      expect(Object.is(replayed.entities[e].position.x, straight.end.entities[e].position.x)).toBe(true)
      expect(replayed.entities[e].ttl).toBe(straight.end.entities[e].ttl)
    }

    // The checkpoint is a real copy, not a view onto seg1.end.
    checkpoint.karts[0].position.x += 1000
    expect(seg1.end.karts[0].position.x).not.toBe(checkpoint.karts[0].position.x)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/sim/test/replay.test.ts`

Expected: FAIL with `Error: Failed to resolve import "../src/replay" from "packages/sim/test/replay.test.ts". Does the file exist?`

- [ ] **Step 3: Write minimal implementation**

Create `packages/sim/src/replay.ts`:

```ts
import type { AuthEvent, Intent, SimContext, SimState } from './types'
import { MAX_KARTS } from './types'
import { cloneState, createState } from './state'
import { step } from './step'
import { makeIntentBuffer } from './phase'

/** Doubles of header at the front of a recording. */
export const INTENT_HEADER = 4
/** Doubles per (tick, slot) intent: steer, accel, brake, drift, useItem. */
export const INTENT_STRIDE = 5

/**
 * Index of the first double of the intent recorded for kart slot `slot` at
 * pre-step tick `tick`. Row `t` holds the intents fed to the step that consumes
 * the state at tick `t` and produces tick `t + 1`.
 */
export function intentOffset(intents: Float64Array, tick: number, slot: number): number {
  const baseTick = intents[0]
  return INTENT_HEADER + ((tick - baseTick) * MAX_KARTS + slot) * INTENT_STRIDE
}

/**
 * A brand-new SimState holding a deep copy of `src`. `createState` is the only
 * constructor that builds the fixed-size karts/entities/itemBoxes arrays, so it
 * builds the shape and `cloneState` fills in every value.
 */
export function allocStateLike(ctx: SimContext, src: SimState): SimState {
  const characterIdx: number[] = []
  for (let i = 0; i < MAX_KARTS; i++) characterIdx.push(src.karts[i].characterIdx)
  const s = createState(ctx, src.raceSeed, characterIdx)
  cloneState(src, s)
  return s
}

/** Anything that can answer "what did this player do on this tick". */
export interface IntentSource {
  intentFor(state: SimState, playerId: number): Intent
}

/**
 * Run `ticks` steps from `from`, recording every raw Intent into a flat
 * Float64Array. `from` is never mutated; `end` is a fresh detached state.
 *
 * The raw intents are recorded, not the resolved ones: what a replay must
 * reproduce is the input that arrived, and `resolveInputs` (countdown freeze,
 * bot fill, clamping) is part of the simulation, not part of the input.
 */
export function recordRun(
  ctx: SimContext,
  from: SimState,
  ticks: number,
  src: IntentSource,
): { end: SimState; intents: Float64Array } {
  const baseTick = from.tick
  const intents = new Float64Array(INTENT_HEADER + ticks * MAX_KARTS * INTENT_STRIDE)
  intents[0] = baseTick
  intents[1] = ticks
  intents[2] = MAX_KARTS
  intents[3] = INTENT_STRIDE

  let a = allocStateLike(ctx, from)
  let b = allocStateLike(ctx, from)
  const inputs = makeIntentBuffer()
  const events: AuthEvent[] = []

  for (let n = 0; n < ticks; n++) {
    const t = a.tick
    const row = INTENT_HEADER + (t - baseTick) * MAX_KARTS * INTENT_STRIDE
    for (let slot = 0; slot < MAX_KARTS; slot++) {
      const it = src.intentFor(a, a.karts[slot].playerId)
      const o = row + slot * INTENT_STRIDE
      intents[o] = it.steer
      intents[o + 1] = it.accel
      intents[o + 2] = it.brake ? 1 : 0
      intents[o + 3] = it.drift ? 1 : 0
      intents[o + 4] = it.useItem ? 1 : 0

      const dst = inputs[slot]
      dst.tick = t + 1
      dst.steer = it.steer
      dst.accel = it.accel
      dst.brake = it.brake
      dst.drift = it.drift
      dst.useItem = it.useItem
    }
    events.length = 0   // events are not part of the recording; drop them
    step(ctx, a, b, inputs, events)
    const tmp = a
    a = b
    b = tmp
  }

  return { end: a, intents }
}

/**
 * Restore `from` (a full-precision checkpoint at tick `fromTick`) and replay the
 * recorded intents forward to `toTick`. `from` is never mutated; the returned
 * state is a fresh object.
 */
export function replayRun(
  ctx: SimContext,
  from: SimState,
  intents: Float64Array,
  fromTick: number,
  toTick: number,
): SimState {
  const baseTick = intents[0]

  let a = allocStateLike(ctx, from)
  let b = allocStateLike(ctx, from)
  const inputs = makeIntentBuffer()
  const events: AuthEvent[] = []

  while (a.tick < toTick) {
    const row = INTENT_HEADER + (a.tick - baseTick) * MAX_KARTS * INTENT_STRIDE
    for (let slot = 0; slot < MAX_KARTS; slot++) {
      const o = row + slot * INTENT_STRIDE
      const dst = inputs[slot]
      dst.tick = a.tick + 1
      dst.steer = intents[o]
      dst.accel = intents[o + 1]
      dst.brake = intents[o + 2] !== 0
      dst.drift = intents[o + 3] !== 0
      dst.useItem = intents[o + 4] !== 0
    }
    events.length = 0
    step(ctx, a, b, inputs, events)
    const tmp = a
    a = b
    b = tmp
  }

  return a
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/sim/test/replay.test.ts`

Expected: PASS — 6 tests, including `checkpoint-replay equivalence > replays bit-identically from a full-precision checkpoint`.

If the equivalence test fails here, do not weaken it. It has caught a real defect in `cloneState` or `step()`. The four usual causes, in order of likelihood: `cloneState` skips entity slots past `entityCount`; `step()` reads a `SimState` field `cloneState` never copies; something in the tick keeps state in a module-level variable other than Task 15's bot hold; something consumes a PRNG draw without recording it in `rngCursor`. Bisect by shrinking `N - T` until the divergence appears, then compare the two states field by field at that tick.

- [ ] **Step 5: Write the failing test — range guards, hold hygiene, and `statesEqual` strictness**

Append to `packages/sim/test/replay.test.ts`. First extend the imports at the top of the file.

Replace:

```ts
import { makeContext, makeOvalTrack } from './fixtures/track-fixtures'
```

with:

```ts
import { makeIntentBuffer, resetBotHold, resolveInputs } from '../src/phase'
import { makeContext, makeOvalTrack } from './fixtures/track-fixtures'
```

Then append these describe blocks:

```ts
/** Bumps a finite double by exactly one unit in the last place, away from zero. */
function ulpUp(x: number): number {
  const dv = new DataView(new ArrayBuffer(8))
  dv.setFloat64(0, x)
  const hi = dv.getUint32(0)
  const lo = dv.getUint32(4)
  if (lo === 0xffffffff) {
    dv.setUint32(0, hi + 1)
    dv.setUint32(4, 0)
  } else {
    dv.setUint32(4, lo + 1)
  }
  return dv.getFloat64(0)
}

/** Slots 0-3 human and connected, slots 4-7 bot-driven. */
function botStart(ctx: SimContext): SimState {
  const s = createState(ctx, SEED, CHARS)
  for (let i = 0; i < MAX_KARTS; i++) {
    s.karts[i].isBot = i >= 4
    s.karts[i].connected = true
  }
  return s
}

describe('statesEqual is Object.is-strict', () => {
  it('rejects a one-ULP difference', () => {
    const ctx = makeContext(makeOvalTrack())
    const start = humanStart(ctx)
    start.phase = 'racing'
    const rec = recordRun(ctx, start, 60, scriptedSrc)

    const probe = allocStateLike(ctx, rec.end)
    expect(statesEqual(probe, rec.end)).toBe(true)

    probe.karts[5].velocity.x = ulpUp(probe.karts[5].velocity.x)
    expect(probe.karts[5].velocity.x).not.toBe(rec.end.karts[5].velocity.x)
    expect(statesEqual(probe, rec.end)).toBe(false)
  })

  it('distinguishes 0 from -0, per the contract', () => {
    const ctx = makeContext(makeOvalTrack())
    const start = humanStart(ctx)
    const a = allocStateLike(ctx, start)
    const b = allocStateLike(ctx, start)
    a.karts[2].angularVelocity = 0
    b.karts[2].angularVelocity = -0

    expect(a.karts[2].angularVelocity === b.karts[2].angularVelocity).toBe(true) // === says equal
    expect(Object.is(a.karts[2].angularVelocity, b.karts[2].angularVelocity)).toBe(false)
    expect(statesEqual(a, b)).toBe(false)   // statesEqual must agree with Object.is
  })
})

describe('the equivalence test can actually fail', () => {
  it('diverges when the checkpoint is perturbed by one millimetre', () => {
    const ctx = makeContext(makeOvalTrack())
    const start = humanStart(ctx)
    const straight = recordRun(ctx, start, 600, scriptedSrc)
    const seg1 = recordRun(ctx, start, 361, scriptedSrc)
    const seg2 = recordRun(ctx, seg1.end, 239, scriptedSrc)

    const perturbed = allocStateLike(ctx, seg1.end)
    perturbed.karts[3].position.x = perturbed.karts[3].position.x + 1e-3

    const diverged = replayRun(ctx, perturbed, seg2.intents, 361, 600)

    expect(diverged.tick).toBe(600)
    expect(statesEqual(diverged, straight.end)).toBe(false)
    expect(statesEqual(seg2.end, straight.end)).toBe(true)  // the control still holds
  })
})

describe('replayRun range guards', () => {
  it('rejects a checkpoint whose tick does not match fromTick', () => {
    const ctx = makeContext(makeOvalTrack())
    const start = humanStart(ctx)
    const seg1 = recordRun(ctx, start, 361, scriptedSrc)
    const seg2 = recordRun(ctx, seg1.end, 239, scriptedSrc)
    const cp = allocStateLike(ctx, seg1.end)   // cp.tick === 361

    expect(() => replayRun(ctx, cp, seg2.intents, 360, 600)).toThrow(RangeError)
    expect(() => replayRun(ctx, cp, seg2.intents, 362, 600)).toThrow(RangeError)
  })

  it('rejects a tick range outside the recording', () => {
    const ctx = makeContext(makeOvalTrack())
    const start = humanStart(ctx)
    const seg1 = recordRun(ctx, start, 361, scriptedSrc)
    const seg2 = recordRun(ctx, seg1.end, 239, scriptedSrc)
    const cp = allocStateLike(ctx, seg1.end)

    // recorded rows cover 361..599, so toTick may be at most 361 + 239 = 600
    expect(() => replayRun(ctx, cp, seg2.intents, 361, 601)).toThrow(RangeError)
    // toTick before fromTick
    expect(() => replayRun(ctx, cp, seg2.intents, 361, 360)).toThrow(RangeError)
    // a checkpoint that predates the recording's baseTick of 361
    const early = allocStateLike(ctx, start)   // tick 0
    expect(() => replayRun(ctx, early, seg2.intents, 0, 4)).toThrow(RangeError)
    // the exact boundary is legal and is a no-op replay
    const edge = replayRun(ctx, cp, seg2.intents, 361, 361)
    expect(edge.tick).toBe(361)
    expect(statesEqual(edge, seg1.end)).toBe(true)
  })
})

describe('checkpoint-replay equivalence with bot-driven karts', () => {
  it('is bit-identical from an odd checkpoint tick', () => {
    const ctx = makeContext(makeOvalTrack())
    const start = botStart(ctx)

    const straight = recordRun(ctx, start, 600, scriptedSrc)
    const seg1 = recordRun(ctx, start, 361, scriptedSrc)   // 361 is odd
    const seg2 = recordRun(ctx, seg1.end, 239, scriptedSrc)
    expect(statesEqual(seg2.end, straight.end)).toBe(true)

    // the bots really drove: slot 7 is bot-driven and moved
    expect(straight.end.karts[7].isBot).toBe(true)
    expect(straight.end.karts[7].position.x).not.toBe(start.karts[7].position.x)

    const checkpoint = allocStateLike(ctx, seg1.end)
    expect(checkpoint.tick % 2).toBe(1)   // the parity invariant this test rests on

    const replayed = replayRun(ctx, checkpoint, seg2.intents, 361, 600)

    expect(replayed.tick).toBe(600)
    expect(statesEqual(replayed, straight.end)).toBe(true)
    for (let i = 4; i < MAX_KARTS; i++) {
      expect(Object.is(replayed.karts[i].position.x, straight.end.karts[i].position.x)).toBe(true)
      expect(Object.is(replayed.karts[i].heading, straight.end.karts[i].heading)).toBe(true)
      expect(Object.is(replayed.karts[i].drift.charge, straight.end.karts[i].drift.charge)).toBe(true)
    }
  })

  it('is independent of a bot hold left dirty by an earlier run', () => {
    const ctx = makeContext(makeOvalTrack())

    // Poison the module-level 30Hz hold: resolve a bot slot on EVEN tick 0 from
    // a state the real run never visits, so holdTick becomes 0 and the real
    // run's first step (odd tick 1) would otherwise reuse this bogus intent.
    const bogus = botStart(ctx)
    bogus.phase = 'racing'
    bogus.tick = 0
    for (let i = 4; i < MAX_KARTS; i++) bogus.karts[i].position.x += 25
    resetBotHold()
    resolveInputs(ctx, bogus, makeIntentBuffer(), makeIntentBuffer())

    const dirtyRun = recordRun(ctx, (() => {
      const s = botStart(ctx)
      s.phase = 'racing'
      return s
    })(), 40, scriptedSrc)

    resetBotHold()
    const cleanRun = recordRun(ctx, (() => {
      const s = botStart(ctx)
      s.phase = 'racing'
      return s
    })(), 40, scriptedSrc)

    expect(dirtyRun.end.tick).toBe(40)
    expect(statesEqual(dirtyRun.end, cleanRun.end)).toBe(true)
  })
})
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run packages/sim/test/replay.test.ts`

Expected: FAIL, 3 failing tests:
- `replayRun range guards > rejects a checkpoint whose tick does not match fromTick` — `expected [Function] to throw an error` (with `fromTick` 360 the replay silently reads row 360 of a recording that starts at 361, i.e. reads before the array body).
- `replayRun range guards > rejects a tick range outside the recording` — same message; `toTick` 601 currently reads five zeroes off the end of the `Float64Array`, which is `undefined`, and produces `NaN` positions rather than an error.
- `checkpoint-replay equivalence with bot-driven karts > is independent of a bot hold left dirty by an earlier run` — `expected false to be true`: `recordRun` does not reset the hold, so the first run reuses the poisoned intent on tick 1 and the second does not.

- [ ] **Step 7: Add the range guards and the bot-hold reset**

Three edits to `packages/sim/src/replay.ts`.

**Edit 1 — import `resetBotHold`.** Before:

```ts
import { makeIntentBuffer } from './phase'
```

After:

```ts
import { makeIntentBuffer, resetBotHold } from './phase'
```

**Edit 2 — reset the hold in `recordRun`.** Before:

```ts
  const inputs = makeIntentBuffer()
  const events: AuthEvent[] = []

  for (let n = 0; n < ticks; n++) {
    const t = a.tick
```

After:

```ts
  const inputs = makeIntentBuffer()
  const events: AuthEvent[] = []

  // Task 15's 30Hz bot hold is module-level state outside SimState. A run must
  // start from a cold hold or it inherits the previous run's last bot intent.
  resetBotHold()

  for (let n = 0; n < ticks; n++) {
    const t = a.tick
```

**Edit 3 — guard and reset in `replayRun`.** Before:

```ts
  const baseTick = intents[0]

  let a = allocStateLike(ctx, from)
  let b = allocStateLike(ctx, from)
  const inputs = makeIntentBuffer()
  const events: AuthEvent[] = []

  while (a.tick < toTick) {
```

After:

```ts
  const baseTick = intents[0]
  const rows = intents[1]

  if (from.tick !== fromTick) {
    throw new RangeError(
      `replayRun: checkpoint is at tick ${from.tick} but fromTick is ${fromTick}`,
    )
  }
  if (toTick < fromTick) {
    throw new RangeError(`replayRun: toTick ${toTick} is before fromTick ${fromTick}`)
  }
  if (fromTick < baseTick || toTick > baseTick + rows) {
    throw new RangeError(
      `replayRun: [${fromTick}, ${toTick}] is outside the recorded range ` +
        `[${baseTick}, ${baseTick + rows}]`,
    )
  }

  let a = allocStateLike(ctx, from)
  let b = allocStateLike(ctx, from)
  const inputs = makeIntentBuffer()
  const events: AuthEvent[] = []

  // Same reason as recordRun: start from a cold 30Hz bot hold. See the
  // checkpoint parity invariant in the file header.
  resetBotHold()

  while (a.tick < toTick) {
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npx vitest run packages/sim/test/replay.test.ts`

Expected: PASS — 12 tests.

- [ ] **Step 9: Document the same-process boundary in the module itself**

Add this block at the very top of `packages/sim/src/replay.ts`, above the existing `import type { AuthEvent, ... }` line:

```ts
/**
 * Deterministic run recorder and replayer.
 *
 * WHY THE EQUIVALENCE TEST IS SAME-PROCESS ONLY, AND WHY THAT IS ENOUGH
 *
 * IEEE-754 makes `+ - * / sqrt` bit-exactly reproducible on every conforming
 * engine: the standard specifies correctly-rounded results. `Math.sin`,
 * `Math.cos`, `Math.atan2` and `Math.pow` are not in that category. ECMA-262
 * explicitly declines to specify their precision — an implementation may use
 * any approximation of the mathematical function, with fdlibm recommended and
 * not required. V8, JavaScriptCore and SpiderMonkey use different kernels and
 * different argument-reduction paths, and V8 has changed its own `Math.sin`
 * across releases. One ULP of difference in `Math.cos(heading)` on tick one
 * becomes metres of separation a few hundred ticks later, because the
 * integrator feeds its own output back in.
 *
 * This sim calls `Math.cos`/`Math.sin` for every kart on every tick — the
 * contract fixes `forward = (cos h, 0, sin h)` — and `Math.atan2` wherever a
 * heading is derived from a direction. Cross-engine bit-identity is therefore
 * unavailable, and no test discipline creates it; you would need fixed-point or
 * a software transcendental library, which is what lockstep RTS games ship.
 *
 * It is also unnecessary. Tapkart is snapshot + reconciliation, not lockstep.
 * The authority alone decides what happened; clients predict locally and are
 * corrected against `WireSnapshot`, which is quantized to ~21 bytes per kart and
 * lossy by construction — a client is already being pulled onto values it did
 * not compute, twenty times a second, by design. Nothing in the netcode compares
 * two independently-simulated float streams across two machines for equality.
 *
 * What the same-process test does prove is the property reconciliation is built
 * on: restoring a SimState and replaying inputs reproduces the state exactly.
 * A client that rewinds to an authoritative checkpoint and replays its buffered
 * inputs then lands on precisely the state the authority computed, so a
 * correction settles instead of oscillating.
 *
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
 */
```

Run: `npx vitest run packages/sim/test/replay.test.ts`

Expected: PASS — 12 tests, unchanged. A comment cannot break the suite, but confirm the file still parses.

- [ ] **Step 10: Run the full sim suite and typecheck**

Run: `npx tsc --noEmit -p packages/sim && npx vitest run packages/sim`

Expected: PASS, zero type errors, every sim test green.

- [ ] **Step 11: Commit**

```bash
git add packages/sim/src/replay.ts packages/sim/test/replay.test.ts
git commit -m "feat(sim): run recorder, replayer, and checkpoint-replay equivalence

recordRun steps a run forward while writing every raw Intent into a flat
Float64Array with a self-describing four-double header; replayRun
restores a full-precision checkpoint and replays a recorded tick range
forward, range-checked against the recording.

The equivalence test is the load-bearing one: 600 ticks from createState,
a structural clone taken at tick 361, restored and replayed to 600, and
asserted bit-identical against the straight-through run via statesEqual
plus per-field Object.is. That property is reconciliation. Bit-identity
is asserted same-process only, because Math.sin/cos are not
precision-specified by ECMA-262 - and it is unnecessary across engines,
because the design uses snapshot + reconciliation rather than lockstep.
Documented in the module header along with the odd-tick checkpoint parity
invariant that Task 15's module-level 30Hz bot hold imposes."
```

---

### Task 17: Golden-Replay Fixture

**Files:**
- Create: `packages/sim/test/fixtures/golden-format.ts`
- Create: `packages/sim/test/fixtures/golden-harness.ts`
- Create: `packages/sim/test/fixtures/GOLDEN.md`
- Create: `packages/sim/test/fixtures/golden-oval-3lap-8bot.json` (generated in Step 12, committed)
- Test: `packages/sim/test/golden-format.test.ts`
- Test: `packages/sim/test/golden-harness.test.ts`
- Test: `packages/sim/test/golden-replay.test.ts`
- Test: `packages/sim/test/golden-regen.test.ts`

**Interfaces:**

Consumes (exact signatures, already shipped by earlier tasks):

```ts
// packages/sim/src/types.ts                                   [Task 2]
export const TICK_HZ = 60
export const TICK_DT = 1 / 60
export const MAX_KARTS = 8
export const MAX_ENTITIES = 32
export const RACE_LAPS = 3
export const COUNTDOWN_TICKS = 180
export type Vec3 = { x: number; y: number; z: number }
export type Surface = 'tarmac' | 'dirt' | 'boost' | 'offtrack'
export type ItemKind = 'none' | 'boost' | 'seeker' | 'bolt' | 'slick' | 'bubble' | 'surge' | 'blink' | 'charge'
export type EntityKind = 'seeker' | 'bolt' | 'slick' | 'bubble' | 'surge' | 'charge'
export type RacePhase = 'countdown' | 'racing' | 'finished'
export type AuthEventKind = 'itemGrant' | 'entitySpawn' | 'entityDespawn' | 'hit' | 'spinOut' | 'respawn' | 'lapCross' | 'finish'
export interface Intent { tick: number; steer: number; accel: number; brake: boolean; drift: boolean; useItem: boolean }
export interface DriftState { active: boolean; dir: -1 | 0 | 1; charge: number }
export interface LapProgress { lap: number; checkpointIdx: number; t: number }
export interface KartState {          // all 18 fields, transcribed from types.ts
  playerId: number
  characterIdx: number
  isBot: boolean
  connected: boolean
  position: Vec3
  velocity: Vec3
  heading: number
  angularVelocity: number
  drift: DriftState
  item: ItemKind
  airborne: boolean
  surface: Surface
  spinOutTicks: number
  invulnTicks: number
  boostTicks: number
  respawnTicks: number
  shielded: boolean
  lap: LapProgress
}
export interface EntityState { entityId: number; kind: EntityKind; ownerId: number; position: Vec3;
   velocity: Vec3; heading: number; targetId: number; ttl: number }
export interface ItemBoxState { boxIdx: number; respawnTicks: number }
export interface AuthEvent { eventSeq: number; tick: number; kind: AuthEventKind; playerId: number;
   entityId: number; item: ItemKind; data: number }
export interface SimState { tick: number; phase: RacePhase; raceSeed: number; rngCursor: number;
   nextEventSeq: number; finishTick: number; karts: KartState[]; entities: EntityState[];
   entityCount: number; nextEntityId: number; itemBoxes: ItemBoxState[]; finishedOrder: number[] }
// karts is always length MAX_KARTS; entities always length MAX_ENTITIES with the live ones packed
// at the front and dead slots at entityId -1; finishedOrder always length MAX_KARTS, with -1 in
// every slot no kart has finished into (locked contract §0 - it is never pushed).
export interface SimContext { track: Track; query: TrackQuery; tuning: Tuning;
   characters: CharacterStats[]; isLeader: boolean }

// packages/sim/src/mathutil.ts                                [Task 2]
export function clamp(v: number, lo: number, hi: number): number
export function wrapAngle(a: number): number                  // -> (-PI, PI]

// packages/sim/src/state.ts                                   [Task 5]
export function createState(ctx: SimContext, seed: number, characterIdx: number[]): SimState

// packages/sim/src/step.ts                                    [Task 5, extended by 6-15]
export function step(ctx: SimContext, prev: SimState, next: SimState,
                     inputs: Intent[], events: AuthEvent[]): void

// packages/sim/src/bot.ts                                     [Task 14]
export function botIntent(ctx: SimContext, state: SimState, playerId: number): Intent

// packages/sim/test/fixtures/track-fixtures.ts                [Task 3]
export function makeTuning(overrides?: Partial<Tuning>): Tuning
export function makeOvalTrack(overrides?: Partial<Track>): Track
export function makeContext(track: Track, isLeader?: boolean): SimContext  // [Task 4]; isLeader defaults true

// packages/sim/src/track.ts (via ctx.query, built by buildTrackQuery)   [Task 4]
totalLength(): number
```

**Depends on the whole tick being wired.** This task asserts on the *event stream* — `lapCross`,
`finish` and `hit` events, and the absence of `respawn` — so it cannot pass until every producer of
those events is actually called from `step()`. Those call sites are added by the tasks that own the
functions, each with its own failing test, not here:

| Event this task counts | Produced by | Wired into `step()` by |
|---|---|---|
| `respawn`, `spinOut` | `updateRecovery` | Task 9 (per-kart slot 2) |
| — (kart-vs-kart separation) | `resolveKartCollisions` | Task 10 (after the kart loop) |
| `lapCross`, `finish` | `updateLaps` | Task 11 (last per-kart call) |
| `hit`, `entitySpawn`, `entityDespawn` | `updateEntities` | Task 12 (after `resolveKartCollisions`) |
| `itemGrant` | `updateItemBoxes`, `useItem` | Task 13 |

If Step 12's generator reports zero `lapCross` events, or every kart stuck on `lap.lap === 0`, the
defect is a missing `step()` call site in Tasks 9–12 — not something to patch inside this harness.

**Why this task drives `step()` directly instead of using `recordRun` / `replayRun` from
Task 16's `packages/sim/src/replay.ts`:** those two return `{ end: SimState; intents: Float64Array }`
and `SimState` respectively — neither returns the `AuthEvent[]` stream. The spec's
bot-drivability criterion is *defined on the event stream* ("zero `respawn` events across the
entire run", and one `finish` event per kart), so this harness owns its own runner that passes a
single accumulating `AuthEvent[]` into every `step()` call. Task 16's replay path is unchanged and
untouched by this task.

Produces:

```ts
// packages/sim/test/fixtures/golden-format.ts
export const GOLDEN_FORMAT_VERSION = 1
export const GOLDEN_SEED = 20260813
export const GOLDEN_CHARACTER_IDX: number[]            // [0,1,2,3,4,5,6,7]
export const GOLDEN_TAIL_TICKS = 60
export const MAX_GOLDEN_TICKS = 18000
export const INTENT_SCALE = 10000
export const INTENT_BYTES_PER_KART = 5
export const B64_LINE_LENGTH = 120
export const GOLDEN_REGEN_COMMAND: string
export const GOLDEN_PATH: string
export const CI_ENV_FLAGS: readonly string[]
export interface GoldenTolerance { position: number; velocity: number; heading: number;
                                   angularVelocity: number; driftCharge: number; lapT: number }
export const GOLDEN_TOL: GoldenTolerance
export interface FieldDiff { path: string; expected: number | string | boolean;
                             actual: number | string | boolean; delta: number; tolerance: number }
export interface GoldenLap { lap: number; checkpointIdx: number; t: number }
export interface GoldenDrift { active: boolean; dir: -1 | 0 | 1; charge: number }
export interface GoldenKart { playerId: number; characterIdx: number; isBot: boolean;
  connected: boolean; position: [number, number, number]; velocity: [number, number, number];
  heading: number; angularVelocity: number; drift: GoldenDrift; item: ItemKind; airborne: boolean;
  surface: Surface; spinOutTicks: number; invulnTicks: number; boostTicks: number;
  respawnTicks: number; shielded: boolean; lap: GoldenLap }
export interface GoldenEntity { entityId: number; kind: EntityKind; ownerId: number;
  position: [number, number, number]; velocity: [number, number, number]; heading: number;
  targetId: number; ttl: number }
export interface GoldenExpectation { tick: number; phase: RacePhase; raceSeed: number;
  rngCursor: number; nextEventSeq: number; finishTick: number; entityCount: number;
  nextEntityId: number; finishedOrder: number[];
  itemBoxes: { boxIdx: number; respawnTicks: number }[];
  karts: GoldenKart[]; entities: GoldenEntity[] }
export interface GoldenEventSummary { total: number; countsByKind: Record<string, number>;
  finishes: { playerId: number; tick: number }[] }
export interface GoldenFixture { formatVersion: number; generatedBy: string; trackId: string;
  raceSeed: number; characterIdx: number[]; tickCount: number; intentScale: number;
  intentsB64: string[]; expected: GoldenExpectation; events: GoldenEventSummary }
export function normZero(v: number): number
export function quantizeIntent(src: Intent, tick: number): Intent
export function packIntents(intents: Intent[][]): Uint8Array
export function unpackIntents(bytes: Uint8Array, tickCount: number): Intent[][]
export function encodeB64Lines(bytes: Uint8Array): string[]
export function decodeB64Lines(lines: string[]): Uint8Array
export function assertRegenerationAllowed(env: Record<string, string | undefined>): void
export function loadGoldenFixture(path?: string): GoldenFixture
export function saveGoldenFixture(fx: GoldenFixture, path?: string): void
export function readGoldenFixtureText(path?: string): string

// packages/sim/test/fixtures/golden-harness.ts
export interface GoldenRun { end: SimState; events: AuthEvent[]; ticks: number }
export interface DrivabilityReport { respawnCount: number; finishedPlayerIds: number[];
                                     lapsByPlayer: number[]; allFinished: boolean; ok: boolean }
export function makeGoldenState(ctx: SimContext, seed: number, characterIdx: number[]): SimState
export function runGoldenTicks(ctx: SimContext, seed: number, characterIdx: number[],
                               intents: Intent[][], ticks: number): GoldenRun
export function replayGoldenFixture(ctx: SimContext, fx: GoldenFixture): GoldenRun
export function recordGoldenWithBots(ctx: SimContext, seed: number, characterIdx: number[],
                                     maxTicks: number): { run: GoldenRun; intents: Intent[][] }
export function toExpectation(state: SimState): GoldenExpectation
export function summarizeEvents(events: AuthEvent[]): GoldenEventSummary
export function checkDrivability(state: SimState, events: AuthEvent[]): DrivabilityReport
export function describeDrivabilityFailure(d: DrivabilityReport): string
export function diffAgainstGolden(exp: GoldenExpectation, act: SimState,
                                  tol?: GoldenTolerance): FieldDiff[]
export function diffEventSummary(exp: GoldenEventSummary, act: GoldenEventSummary): FieldDiff[]
export function formatDiffs(diffs: FieldDiff[]): string
```

---

#### Why this is a field-by-field comparison and not a digest

A digest compresses a state vector of roughly a thousand numbers into one number. When it
mismatches, the test can only say `expected "a3f1c2…" to be "9c0417…"`. That failure **names no
field, no value and no delta.** It cannot distinguish "the drift charge tier boundary moved by one
tick" from "kart 6 fell through the floor on lap 2", and it cannot tell you whether the underlying
change is 1e-15 metres (float noise from a harmless re-association of a sum) or 40 metres. Every
mismatch therefore costs a full bisect before anyone even knows what broke.

Worse, a digest forces **exact** comparison onto continuous fields. Reordering a floating-point sum
is a legal, behaviour-preserving refactor that changes the last bit of a double and therefore the
digest. The golden goes red, nobody can see that it was harmless, and the team learns to regenerate
the fixture reflexively — at which point the fixture asserts nothing at all.

So this fixture compares every field by name, with two comparison rules:

- **Exact** (`Object.is`, tolerance `0`) for integers, enums, booleans and counters:
  `tick`, `phase`, `raceSeed`, `rngCursor`, `nextEventSeq`, `finishTick`, `entityCount`,
  `nextEntityId`, `finishedOrder[]`, `itemBoxes[].boxIdx`, `itemBoxes[].respawnTicks`,
  every kart's `playerId`, `characterIdx`, `isBot`, `connected`, `drift.active`, `drift.dir`,
  `item`, `airborne`, `surface`, `spinOutTicks`, `invulnTicks`, `boostTicks`, `respawnTicks`,
  `shielded`, `lap.lap`, `lap.checkpointIdx`, and every live entity's `entityId`, `kind`,
  `ownerId`, `targetId`, `ttl`. These are decisions, not measurements. A one-unit change to any of
  them is a behaviour change, so nothing is tolerated.
- **Tolerated** for the continuous fields, with the tolerance stated in `GOLDEN_TOL` and printed in
  every failure line: `position` 1e-6 m, `velocity` 1e-6 m/s, `heading` 1e-7 rad,
  `angularVelocity` 1e-7 rad/s, `drift.charge` 1e-6, `lap.t` 1e-9.

**Where those tolerances come from.** A double carries ~2.22e-16 relative error. At a position
magnitude of ~1e3 m, one ULP is ~1.1e-13 m; over ~4,000 ticks, fully-correlated round-off drift is
bounded near 4e-10 m. The smallest *physically meaningful* change, on the other hand, is one tick of
acceleration: `accelRate` 24 m/s² × `TICK_DT` 1/60 s = 0.4 m/s of velocity, which is 6.7e-3 m of
position in that same tick. The tolerance of 1e-6 sits roughly 2,500× above the float-noise ceiling
and 6,700× below the smallest real change — six orders of magnitude of daylight on each side. The
same argument gives heading: `steerRateBase` 2.6 rad/s × 1/60 s = 0.0433 rad per tick of real
change, against ~1.6e-12 rad of accumulated round-off, so 1e-7 is comfortably between them.

`JSON.stringify` emits the shortest round-tripping decimal for every double and `JSON.parse` returns
the identical double, so storing the expectation as plain JSON loses nothing. JSON cannot represent
`-0`, `NaN` or `Infinity`: the writer therefore refuses to store a non-finite number (naming the
field), and the exact comparator normalises `-0` to `+0` on both sides.

---

- [ ] **Step 1: Write the failing test for the fixture format layer**

Create `packages/sim/test/golden-format.test.ts`:

```ts
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import type { Intent } from '../src/types'
import { MAX_KARTS } from '../src/types'
import type { GoldenFixture } from './fixtures/golden-format'
import {
  B64_LINE_LENGTH,
  GOLDEN_CHARACTER_IDX,
  GOLDEN_FORMAT_VERSION,
  GOLDEN_PATH,
  GOLDEN_REGEN_COMMAND,
  GOLDEN_SEED,
  GOLDEN_TOL,
  INTENT_BYTES_PER_KART,
  INTENT_SCALE,
  MAX_GOLDEN_TICKS,
  assertRegenerationAllowed,
  decodeB64Lines,
  encodeB64Lines,
  loadGoldenFixture,
  normZero,
  packIntents,
  quantizeIntent,
  saveGoldenFixture,
  unpackIntents,
} from './fixtures/golden-format'

function intent(tick: number, steer: number, accel: number, flags: number): Intent {
  return {
    tick,
    steer,
    accel,
    brake: (flags & 1) !== 0,
    drift: (flags & 2) !== 0,
    useItem: (flags & 4) !== 0,
  }
}

describe('golden fixture constants', () => {
  it('pins the values the fixture and the tests are written against', () => {
    expect(GOLDEN_FORMAT_VERSION).toBe(1)
    expect(GOLDEN_SEED).toBe(20260813)
    expect(GOLDEN_CHARACTER_IDX).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    expect(GOLDEN_CHARACTER_IDX).toHaveLength(MAX_KARTS)
    expect(INTENT_SCALE).toBe(10000)
    expect(INTENT_BYTES_PER_KART).toBe(5) // int16 steer + int16 accel + uint8 flags
    expect(B64_LINE_LENGTH).toBe(120)
    expect(MAX_GOLDEN_TICKS).toBe(18000) // 5 minutes at 60Hz; a runaway guard, not a target
    expect(GOLDEN_PATH.endsWith('golden-oval-3lap-8bot.json')).toBe(true)
    expect(GOLDEN_REGEN_COMMAND).toBe(
      'UPDATE_GOLDEN=1 npx vitest run packages/sim/test/golden-regen.test.ts',
    )
  })

  it('states a tolerance for every continuous field and nothing else', () => {
    expect(GOLDEN_TOL.position).toBe(1e-6)
    expect(GOLDEN_TOL.velocity).toBe(1e-6)
    expect(GOLDEN_TOL.heading).toBe(1e-7)
    expect(GOLDEN_TOL.angularVelocity).toBe(1e-7)
    expect(GOLDEN_TOL.driftCharge).toBe(1e-6)
    expect(GOLDEN_TOL.lapT).toBe(1e-9)
    expect(Object.keys(GOLDEN_TOL).sort()).toEqual([
      'angularVelocity',
      'driftCharge',
      'heading',
      'lapT',
      'position',
      'velocity',
    ])
  })
})

describe('normZero', () => {
  it('maps -0 to +0 and leaves everything else alone', () => {
    expect(Object.is(normZero(-0), 0)).toBe(true)
    expect(Object.is(normZero(0), 0)).toBe(true)
    expect(normZero(-1.5)).toBe(-1.5)
    expect(Number.isNaN(normZero(Number.NaN))).toBe(true)
  })
})

describe('quantizeIntent', () => {
  it('rounds steer and accel to 1/10000 and stamps the tick', () => {
    // 0.123456789 * 10000 = 1234.56789 -> round -> 1235 -> /10000 = 0.1235
    const q = quantizeIntent(intent(0, 0.123456789, 0.5, 0), 7)
    expect(q.tick).toBe(7)
    expect(q.steer).toBe(0.1235)
    expect(q.accel).toBe(0.5)
    expect(q.brake).toBe(false)
    expect(q.drift).toBe(false)
    expect(q.useItem).toBe(false)
  })

  it('clamps steer to -1..1 and accel to 0..1', () => {
    expect(quantizeIntent(intent(0, -1.7, 2.3, 0), 1).steer).toBe(-1)
    expect(quantizeIntent(intent(0, 1.7, 2.3, 0), 1).steer).toBe(1)
    expect(quantizeIntent(intent(0, 0, 2.3, 0), 1).accel).toBe(1)
    expect(quantizeIntent(intent(0, 0, -0.4, 0), 1).accel).toBe(0)
  })

  it('never produces -0, because JSON cannot represent it', () => {
    // -0.00004 * 10000 = -0.4 ; Math.round(-0.4) is -0 in JS
    const q = quantizeIntent(intent(0, -0.00004, 0, 0), 2)
    expect(Object.is(q.steer, 0)).toBe(true)
  })

  it('carries the three booleans through unchanged', () => {
    const q = quantizeIntent(intent(0, 0, 1, 7), 3)
    expect(q.brake).toBe(true)
    expect(q.drift).toBe(true)
    expect(q.useItem).toBe(true)
  })

  it('refuses a non-finite intent instead of silently storing 0', () => {
    expect(() => quantizeIntent(intent(0, Number.NaN, 1, 0), 3)).toThrow(
      'golden: non-finite intent at tick 3: steer=NaN accel=1',
    )
  })
})

describe('intent packing', () => {
  it('round-trips a two-tick stream byte-for-byte', () => {
    const rows: Intent[][] = []
    for (let t = 0; t < 2; t++) {
      const row: Intent[] = []
      for (let i = 0; i < MAX_KARTS; i++) {
        // steer (i-4)/8 spans -0.5..0.375, accel i/8 spans 0..0.875 - all exact at 1/10000
        row.push(quantizeIntent(intent(t, (i - 4) / 8, i / 8, i % 8), t))
      }
      rows.push(row)
    }

    const bytes = packIntents(rows)
    expect(bytes.length).toBe(2 * MAX_KARTS * INTENT_BYTES_PER_KART) // 2 * 8 * 5 = 80

    const back = unpackIntents(bytes, 2)
    expect(back).toEqual(rows)
    expect(back[1][7].steer).toBe(0.375)
    expect(back[1][7].accel).toBe(0.875)
    expect(back[1][7].brake).toBe(true)
    expect(back[1][7].drift).toBe(true)
    expect(back[1][7].useItem).toBe(true)
  })

  it('refuses a stream whose length does not match the tick count', () => {
    const bytes = new Uint8Array(3 * MAX_KARTS * INTENT_BYTES_PER_KART)
    expect(() => unpackIntents(bytes, 2)).toThrow(
      'golden: intent stream is 120 bytes, expected 80 for 2 ticks',
    )
  })
})

describe('base64 chunking', () => {
  it('emits one short line for a three-byte payload', () => {
    const lines = encodeB64Lines(new Uint8Array([0, 1, 2]))
    expect(lines).toEqual(['AAEC'])
    expect(Array.from(decodeB64Lines(lines))).toEqual([0, 1, 2])
  })

  it('splits into 120-character lines so the fixture stays diffable', () => {
    const bytes = new Uint8Array(200)
    for (let i = 0; i < 200; i++) bytes[i] = (i * 7) & 0xff
    // 200 bytes -> ceil(200/3) = 67 base64 quads -> 268 chars -> 120 + 120 + 28
    const lines = encodeB64Lines(bytes)
    expect(lines.map((l) => l.length)).toEqual([120, 120, 28])
    expect(Array.from(decodeB64Lines(lines))).toEqual(Array.from(bytes))
  })
})

describe('assertRegenerationAllowed', () => {
  it('refuses when CI is set, and says exactly why', () => {
    expect(() => assertRegenerationAllowed({ CI: 'true' })).toThrow(
      'golden: refusing to regenerate because CI=true. A regenerated golden fixture is a claim ' +
        'that a physics change was intentional; it must be produced on a developer machine and ' +
        'reviewed in the diff. Unset CI to proceed.',
    )
  })

  it('refuses on the other CI markers too', () => {
    expect(() => assertRegenerationAllowed({ GITHUB_ACTIONS: 'true' })).toThrow(
      /refusing to regenerate because GITHUB_ACTIONS=true/,
    )
    expect(() => assertRegenerationAllowed({ CONTINUOUS_INTEGRATION: '1' })).toThrow(
      /refusing to regenerate because CONTINUOUS_INTEGRATION=1/,
    )
  })

  it('allows a developer machine, including the explicitly-negative forms', () => {
    expect(() => assertRegenerationAllowed({})).not.toThrow()
    expect(() => assertRegenerationAllowed({ CI: '' })).not.toThrow()
    expect(() => assertRegenerationAllowed({ CI: '0' })).not.toThrow()
    expect(() => assertRegenerationAllowed({ CI: 'false' })).not.toThrow()
    expect(() => assertRegenerationAllowed({ CI: 'FALSE' })).not.toThrow()
    expect(() => assertRegenerationAllowed({ CI: undefined })).not.toThrow()
  })
})

describe('fixture io', () => {
  it('rejects a fixture written by a different format version', () => {
    const p = join(tmpdir(), 'tapkart-golden-version.json')
    saveGoldenFixture({ formatVersion: 999 } as unknown as GoldenFixture, p)
    expect(() => loadGoldenFixture(p)).toThrow('golden: fixture formatVersion 999, this build expects 1')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/sim/test/golden-format.test.ts`
Expected: FAIL with `Failed to resolve import "./fixtures/golden-format" from "packages/sim/test/golden-format.test.ts"`

- [ ] **Step 3: Write the fixture format layer**

Create `packages/sim/test/fixtures/golden-format.ts`:

```ts
// Golden-replay fixture format: constants, tolerances, the intent-stream codec,
// the CI regeneration guard, and fixture load/save.
//
// The comparison this format supports is field-by-field, NOT a digest. A digest
// mismatch names no field, no value and no delta, so it cannot tell a harmless
// last-bit re-association from a kart falling through the floor. See GOLDEN.md.
import { Buffer } from 'node:buffer'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { EntityKind, Intent, ItemKind, RacePhase, Surface } from '../../src/types'
import { MAX_KARTS } from '../../src/types'
import { clamp } from '../../src/mathutil'

export const GOLDEN_FORMAT_VERSION = 1

/** Race seed for the golden run. Fixed forever; changing it invalidates the fixture. */
export const GOLDEN_SEED = 20260813

/** One of each of the eight characters, so every stat row is exercised. */
export const GOLDEN_CHARACTER_IDX: number[] = [0, 1, 2, 3, 4, 5, 6, 7]

/** Ticks recorded after the last kart finishes, so the fixture also pins the post-race state. */
export const GOLDEN_TAIL_TICKS = 60

/** Runaway guard: 18000 ticks = 5 minutes at 60Hz. A race longer than this is a bug. */
export const MAX_GOLDEN_TICKS = 18000

/** Recorded steer/accel are quantised to 1/10000 so the stream is exactly reproducible. */
export const INTENT_SCALE = 10000

/** int16 steer + int16 accel + uint8 flags. */
export const INTENT_BYTES_PER_KART = 5

/** The packed stream is stored as base64 split into short lines so git can diff it. */
export const B64_LINE_LENGTH = 120

export const GOLDEN_REGEN_COMMAND =
  'UPDATE_GOLDEN=1 npx vitest run packages/sim/test/golden-regen.test.ts'

const HERE = dirname(fileURLToPath(import.meta.url))

export const GOLDEN_PATH = join(HERE, 'golden-oval-3lap-8bot.json')

/** Any of these, set to anything other than empty/0/false, blocks regeneration. */
export const CI_ENV_FLAGS: readonly string[] = ['CI', 'GITHUB_ACTIONS', 'CONTINUOUS_INTEGRATION']

export interface GoldenTolerance {
  position: number
  velocity: number
  heading: number
  angularVelocity: number
  driftCharge: number
  lapT: number
}

/**
 * Per-field tolerances for the continuous fields only. Everything else compares exactly.
 *
 * Sizing: one ULP at a position magnitude of ~1e3 m is ~1.1e-13 m, so ~4000 ticks of
 * fully-correlated round-off is bounded near 4e-10 m. The smallest physically meaningful
 * change is one tick of acceleration: accelRate 24 m/s^2 * TICK_DT (1/60 s) = 0.4 m/s,
 * i.e. 6.7e-3 m of position. 1e-6 sits between them with ~6 orders of magnitude either side.
 */
export const GOLDEN_TOL: GoldenTolerance = {
  position: 1e-6,
  velocity: 1e-6,
  heading: 1e-7,
  angularVelocity: 1e-7,
  driftCharge: 1e-6,
  lapT: 1e-9,
}

/** One differing field. `tolerance === 0` means the field is compared exactly. */
export interface FieldDiff {
  path: string
  expected: number | string | boolean
  actual: number | string | boolean
  delta: number
  tolerance: number
}

export interface GoldenLap {
  lap: number
  checkpointIdx: number
  t: number
}

export interface GoldenDrift {
  active: boolean
  dir: -1 | 0 | 1
  charge: number
}

export interface GoldenKart {
  playerId: number
  characterIdx: number
  isBot: boolean
  connected: boolean
  position: [number, number, number]
  velocity: [number, number, number]
  heading: number
  angularVelocity: number
  drift: GoldenDrift
  item: ItemKind
  airborne: boolean
  surface: Surface
  spinOutTicks: number
  invulnTicks: number
  boostTicks: number
  respawnTicks: number
  shielded: boolean
  lap: GoldenLap
}

export interface GoldenEntity {
  entityId: number
  kind: EntityKind
  ownerId: number
  position: [number, number, number]
  velocity: [number, number, number]
  heading: number
  targetId: number
  ttl: number
}

export interface GoldenExpectation {
  tick: number
  phase: RacePhase
  raceSeed: number
  rngCursor: number
  nextEventSeq: number
  finishTick: number
  entityCount: number
  nextEntityId: number
  finishedOrder: number[]
  itemBoxes: { boxIdx: number; respawnTicks: number }[]
  karts: GoldenKart[]
  /** Exactly `entityCount` live records. Slots at or beyond it must hold entityId -1. */
  entities: GoldenEntity[]
}

export interface GoldenEventSummary {
  total: number
  countsByKind: Record<string, number>
  finishes: { playerId: number; tick: number }[]
}

export interface GoldenFixture {
  formatVersion: number
  /** The command that regenerates this file. No timestamps, no hostnames, no absolute paths. */
  generatedBy: string
  trackId: string
  raceSeed: number
  characterIdx: number[]
  tickCount: number
  intentScale: number
  intentsB64: string[]
  expected: GoldenExpectation
  events: GoldenEventSummary
}

/** JSON has no -0, so -0 and +0 must compare equal on both sides. */
export function normZero(v: number): number {
  return v === 0 ? 0 : v
}

/**
 * Snap an intent onto the 1/10000 grid the fixture stores. The generator quantises before
 * simulating, so the recorded stream is byte-identical to the stream that produced the
 * expectation and replay is exact rather than merely close.
 */
export function quantizeIntent(src: Intent, tick: number): Intent {
  if (!Number.isFinite(src.steer) || !Number.isFinite(src.accel)) {
    throw new Error(
      `golden: non-finite intent at tick ${tick}: steer=${src.steer} accel=${src.accel}`,
    )
  }
  const steerQ = normZero(Math.round(clamp(src.steer, -1, 1) * INTENT_SCALE))
  const accelQ = normZero(Math.round(clamp(src.accel, 0, 1) * INTENT_SCALE))
  return {
    tick,
    steer: steerQ / INTENT_SCALE,
    accel: accelQ / INTENT_SCALE,
    brake: src.brake === true,
    drift: src.drift === true,
    useItem: src.useItem === true,
  }
}

export function packIntents(intents: Intent[][]): Uint8Array {
  const tickCount = intents.length
  const bytes = new Uint8Array(tickCount * MAX_KARTS * INTENT_BYTES_PER_KART)
  const dv = new DataView(bytes.buffer)
  for (let t = 0; t < tickCount; t++) {
    const row = intents[t]
    if (row.length !== MAX_KARTS) {
      throw new Error(`golden: intent row ${t} has ${row.length} karts, expected ${MAX_KARTS}`)
    }
    for (let i = 0; i < MAX_KARTS; i++) {
      const off = (t * MAX_KARTS + i) * INTENT_BYTES_PER_KART
      const it = row[i]
      dv.setInt16(off, normZero(Math.round(it.steer * INTENT_SCALE)), true)
      dv.setInt16(off + 2, normZero(Math.round(it.accel * INTENT_SCALE)), true)
      dv.setUint8(off + 4, (it.brake ? 1 : 0) | (it.drift ? 2 : 0) | (it.useItem ? 4 : 0))
    }
  }
  return bytes
}

export function unpackIntents(bytes: Uint8Array, tickCount: number): Intent[][] {
  const need = tickCount * MAX_KARTS * INTENT_BYTES_PER_KART
  if (bytes.length !== need) {
    throw new Error(
      `golden: intent stream is ${bytes.length} bytes, expected ${need} for ${tickCount} ticks`,
    )
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const out: Intent[][] = []
  for (let t = 0; t < tickCount; t++) {
    const row: Intent[] = []
    for (let i = 0; i < MAX_KARTS; i++) {
      const off = (t * MAX_KARTS + i) * INTENT_BYTES_PER_KART
      const flags = dv.getUint8(off + 4)
      row.push({
        tick: t,
        steer: dv.getInt16(off, true) / INTENT_SCALE,
        accel: dv.getInt16(off + 2, true) / INTENT_SCALE,
        brake: (flags & 1) !== 0,
        drift: (flags & 2) !== 0,
        useItem: (flags & 4) !== 0,
      })
    }
    out.push(row)
  }
  return out
}

export function encodeB64Lines(bytes: Uint8Array): string[] {
  const b64 = Buffer.from(bytes).toString('base64')
  const out: string[] = []
  for (let i = 0; i < b64.length; i += B64_LINE_LENGTH) {
    out.push(b64.slice(i, i + B64_LINE_LENGTH))
  }
  return out
}

export function decodeB64Lines(lines: string[]): Uint8Array {
  return new Uint8Array(Buffer.from(lines.join(''), 'base64'))
}

/**
 * A regenerated golden fixture is a claim that a physics change was intentional. That claim can
 * only be made by a human looking at the diff, so regeneration is refused inside CI.
 */
export function assertRegenerationAllowed(env: Record<string, string | undefined>): void {
  for (const name of CI_ENV_FLAGS) {
    const raw = env[name]
    if (raw === undefined) continue
    const v = raw.trim().toLowerCase()
    if (v === '' || v === '0' || v === 'false') continue
    throw new Error(
      `golden: refusing to regenerate because ${name}=${raw}. A regenerated golden fixture is a ` +
        'claim that a physics change was intentional; it must be produced on a developer machine ' +
        `and reviewed in the diff. Unset ${name} to proceed.`,
    )
  }
}

export function readGoldenFixtureText(path: string = GOLDEN_PATH): string {
  return readFileSync(path, 'utf8')
}

export function loadGoldenFixture(path: string = GOLDEN_PATH): GoldenFixture {
  const fx = JSON.parse(readGoldenFixtureText(path)) as GoldenFixture
  if (fx.formatVersion !== GOLDEN_FORMAT_VERSION) {
    throw new Error(
      `golden: fixture formatVersion ${fx.formatVersion}, this build expects ` +
        `${GOLDEN_FORMAT_VERSION}. Regenerate it with: ${GOLDEN_REGEN_COMMAND}`,
    )
  }
  return fx
}

export function saveGoldenFixture(fx: GoldenFixture, path: string = GOLDEN_PATH): void {
  writeFileSync(path, `${JSON.stringify(fx, null, 2)}\n`, 'utf8')
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/sim/test/golden-format.test.ts`
Expected: PASS — 16 tests.

- [ ] **Step 5: Write the failing test for the comparison harness**

Create `packages/sim/test/golden-harness.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import type { AuthEvent, Intent } from '../src/types'
import { COUNTDOWN_TICKS, MAX_ENTITIES, MAX_KARTS, RACE_LAPS } from '../src/types'
import { makeContext, makeOvalTrack } from './fixtures/track-fixtures'
import type { GoldenExpectation } from './fixtures/golden-format'
import { GOLDEN_CHARACTER_IDX, GOLDEN_SEED, GOLDEN_TOL } from './fixtures/golden-format'
import {
  checkDrivability,
  describeDrivabilityFailure,
  diffAgainstGolden,
  diffEventSummary,
  formatDiffs,
  makeGoldenState,
  runGoldenTicks,
  summarizeEvents,
  toExpectation,
} from './fixtures/golden-harness'

function clone(e: GoldenExpectation): GoldenExpectation {
  return JSON.parse(JSON.stringify(e)) as GoldenExpectation
}

function ev(kind: AuthEvent['kind'], playerId: number, tick: number, seq: number): AuthEvent {
  return { eventSeq: seq, tick, kind, playerId, entityId: -1, item: 'none', data: 0 }
}

const ctx = makeContext(makeOvalTrack())

describe('makeGoldenState', () => {
  it('hands every one of the eight karts to the recorded stream', () => {
    const s = makeGoldenState(ctx, GOLDEN_SEED, GOLDEN_CHARACTER_IDX)
    expect(s.karts).toHaveLength(MAX_KARTS)
    expect(s.entities).toHaveLength(MAX_ENTITIES)
    expect(s.tick).toBe(0)
    expect(s.raceSeed).toBe(GOLDEN_SEED)
    for (let i = 0; i < MAX_KARTS; i++) {
      // Not bots at replay time: the stream drives them, so resolveInputs never bot-fills
      // and the golden is a physics test rather than a bot-AI test.
      expect(s.karts[i].isBot).toBe(false)
      expect(s.karts[i].connected).toBe(true)
      expect(s.karts[i].characterIdx).toBe(i)
    }
    for (let i = 0; i < MAX_ENTITIES; i++) {
      expect(s.entities[i].entityId).toBe(-1)
    }
  })
})

describe('toExpectation / diffAgainstGolden', () => {
  it('reports zero differences against the state it was built from', () => {
    const s = makeGoldenState(ctx, GOLDEN_SEED, GOLDEN_CHARACTER_IDX)
    const exp = toExpectation(s)
    expect(exp.karts).toHaveLength(MAX_KARTS)
    expect(exp.entityCount).toBe(0)
    expect(exp.entities).toHaveLength(0)
    expect(formatDiffs(diffAgainstGolden(exp, s))).toBe('')
    expect(diffAgainstGolden(exp, s)).toHaveLength(0)
  })

  it('ignores a continuous change below tolerance and reports one above it', () => {
    const s = makeGoldenState(ctx, GOLDEN_SEED, GOLDEN_CHARACTER_IDX)
    const base = toExpectation(s)

    // 1e-9 m is 1000x under the 1e-6 m position tolerance -> not a difference
    const under = clone(base)
    under.karts[2].position[0] += 1e-9
    expect(diffAgainstGolden(under, s)).toHaveLength(0)

    // 1e-5 m is 10x over it -> exactly one difference, and it names the field
    const over = clone(base)
    over.karts[2].position[0] += 1e-5
    const diffs = diffAgainstGolden(over, s)
    expect(diffs).toHaveLength(1)
    expect(diffs[0].path).toBe('karts[2].position.x')
    expect(diffs[0].tolerance).toBe(GOLDEN_TOL.position)
    expect(diffs[0].delta).toBeCloseTo(-1e-5, 12)
  })

  it('reports an integer field with zero tolerance and an exact delta', () => {
    const s = makeGoldenState(ctx, GOLDEN_SEED, GOLDEN_CHARACTER_IDX)
    const exp = toExpectation(s)
    exp.karts[5].lap.checkpointIdx += 1
    const diffs = diffAgainstGolden(exp, s)
    expect(diffs).toHaveLength(1)
    expect(diffs[0].path).toBe('karts[5].lap.checkpointIdx')
    expect(diffs[0].tolerance).toBe(0)
    expect(diffs[0].delta).toBe(-1)
  })

  it('reports an enum field by name with no delta', () => {
    const s = makeGoldenState(ctx, GOLDEN_SEED, GOLDEN_CHARACTER_IDX)
    const exp = toExpectation(s)
    exp.karts[1].item = exp.karts[1].item === 'none' ? 'boost' : 'none'
    const diffs = diffAgainstGolden(exp, s)
    expect(diffs).toHaveLength(1)
    expect(diffs[0].path).toBe('karts[1].item')
    expect(diffs[0].tolerance).toBe(0)
    expect(Number.isNaN(diffs[0].delta)).toBe(true)
  })

  it('compares headings as angles but still enforces the wrap invariant', () => {
    const s = makeGoldenState(ctx, GOLDEN_SEED, GOLDEN_CHARACTER_IDX)
    const exp = toExpectation(s)
    // h + 2*PI is the same angle, so the angular delta is ~0 (under the 1e-7 tolerance),
    // but every stored heading must live in (-PI, PI] and h + 2*PI never does.
    s.karts[0].heading = exp.karts[0].heading + 2 * Math.PI
    const diffs = diffAgainstGolden(exp, s)
    expect(diffs).toHaveLength(1)
    expect(diffs[0].path).toBe('karts[0].heading[wrapped]')
    expect(diffs[0].expected).toBe('(-PI, PI]')
    expect(diffs[0].tolerance).toBe(0)
  })

  it('refuses to store a non-finite number rather than writing JSON null', () => {
    const s = makeGoldenState(ctx, GOLDEN_SEED, GOLDEN_CHARACTER_IDX)
    s.karts[3].velocity.z = Number.POSITIVE_INFINITY
    expect(() => toExpectation(s)).toThrow(
      'golden: karts[3].velocity.z is not finite (Infinity); refusing to store it',
    )
  })
})

describe('formatDiffs', () => {
  it('is empty for no differences and names field, values, delta and tolerance otherwise', () => {
    expect(formatDiffs([])).toBe('')
    const text = formatDiffs([
      { path: 'karts[2].position.x', expected: 1.5, actual: 2, delta: 0.5, tolerance: 1e-6 },
    ])
    expect(text).toContain('1 field(s) differ from the golden fixture')
    expect(text).toContain('karts[2].position.x')
    expect(text).toContain('delta 5.000e-1')
    expect(text).toContain('tolerance 1e-6')
  })
})

describe('summarizeEvents / diffEventSummary', () => {
  it('counts every kind and records the finish order', () => {
    const events: AuthEvent[] = [
      ev('lapCross', 4, 300, 0),
      ev('respawn', 2, 310, 1),
      ev('finish', 4, 900, 2),
      ev('finish', 2, 950, 3),
      ev('finish', -1, 950, 4), // updatePhase's race-level event [Task 15]
    ]
    const s = summarizeEvents(events)
    expect(s.total).toBe(5)
    expect(s.countsByKind.lapCross).toBe(1)
    expect(s.countsByKind.respawn).toBe(1)
    expect(s.countsByKind.finish).toBe(3)   // counts include the race-level one
    expect(s.countsByKind.hit).toBe(0)
    // ...but the finishing order is per-kart, so the playerId -1 event is not in it
    expect(s.finishes).toEqual([
      { playerId: 4, tick: 900 },
      { playerId: 2, tick: 950 },
    ])
    expect(diffEventSummary(s, summarizeEvents(events))).toHaveLength(0)
  })

  it('names the kind whose count moved', () => {
    const a = summarizeEvents([ev('hit', 1, 10, 0)])
    const b = summarizeEvents([ev('hit', 1, 10, 0), ev('hit', 2, 11, 1)])
    const diffs = diffEventSummary(a, b)
    // Both summaries have zero finishes, so only the total and the hit count move.
    expect(diffs.map((d) => d.path)).toEqual(['events.total', 'events.countsByKind.hit'])
    expect(diffs[1].expected).toBe(1)
    expect(diffs[1].actual).toBe(2)
    expect(diffs[1].delta).toBe(1)
  })
})

describe('checkDrivability', () => {
  it('counts respawns and collects the distinct finishers', () => {
    const s = makeGoldenState(ctx, GOLDEN_SEED, GOLDEN_CHARACTER_IDX)
    const report = checkDrivability(s, [
      ev('respawn', 0, 100, 0),
      ev('respawn', 0, 200, 1),
      ev('finish', 3, 900, 2),
      ev('finish', 1, 910, 3),
      ev('finish', -1, 910, 4), // the race-level event is not a finisher
    ])
    expect(report.respawnCount).toBe(2)
    expect(report.finishedPlayerIds).toEqual([1, 3])   // no -1
    expect(report.lapsByPlayer).toHaveLength(MAX_KARTS)
    expect(report.allFinished).toBe(false) // 2 of 8 finished, and no kart has 3 laps
    expect(report.ok).toBe(false)
  })

  it('describes the failure with the karts that fell short', () => {
    const s = makeGoldenState(ctx, GOLDEN_SEED, GOLDEN_CHARACTER_IDX)
    const text = describeDrivabilityFailure(checkDrivability(s, [ev('finish', 0, 900, 0)]))
    expect(text).toContain('respawn events: 0 (must be 0)')
    expect(text).toContain(`karts that did not finish ${RACE_LAPS} laps`)
    expect(text).toContain('player 7 (lap')
  })
})

describe('runGoldenTicks', () => {
  it('advances exactly the requested number of ticks and clears the countdown', () => {
    const ticks = COUNTDOWN_TICKS + 60 // 180 + 60 = 240
    const intents: Intent[][] = []
    for (let t = 0; t < ticks; t++) {
      const row: Intent[] = []
      for (let i = 0; i < MAX_KARTS; i++) {
        row.push({ tick: t, steer: 0, accel: 0, brake: false, drift: false, useItem: false })
      }
      intents.push(row)
    }

    const run = runGoldenTicks(ctx, GOLDEN_SEED, GOLDEN_CHARACTER_IDX, intents, ticks)
    expect(run.ticks).toBe(240)
    expect(run.end.tick).toBe(240)
    expect(run.end.phase).toBe('racing') // COUNTDOWN_TICKS is 180, so 240 is past it
    expect(run.end.karts).toHaveLength(MAX_KARTS)
    expect(run.end.entities).toHaveLength(MAX_ENTITIES)
    // Nobody moves on accel 0, so nobody can leave the track
    expect(run.events.filter((e) => e.kind === 'respawn')).toHaveLength(0)
    // finishedOrder is fixed length MAX_KARTS with -1 in every unfilled slot, so
    // "nobody finished" is eight -1s, not an empty array.
    expect(run.end.finishedOrder).toEqual([-1, -1, -1, -1, -1, -1, -1, -1])
    expect(run.end.finishedOrder).toHaveLength(MAX_KARTS)
  })
})
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run packages/sim/test/golden-harness.test.ts`
Expected: FAIL with `Failed to resolve import "./fixtures/golden-harness" from "packages/sim/test/golden-harness.test.ts"`

- [ ] **Step 7: Write the comparison harness**

Create `packages/sim/test/fixtures/golden-harness.ts`:

```ts
// Runs a recorded intent stream through step() and compares the resulting SimState to a stored
// expectation field by field: exact for integers, enums and booleans, per-field tolerance for the
// continuous ones. Every difference carries its path, both values, the delta and the tolerance -
// which is precisely what a digest cannot do.
import type {
  AuthEvent,
  EntityState,
  Intent,
  KartState,
  SimContext,
  SimState,
  Vec3,
} from '../../src/types'
import { MAX_ENTITIES, MAX_KARTS, RACE_LAPS } from '../../src/types'
import { wrapAngle } from '../../src/mathutil'
import { createState } from '../../src/state'
import { step } from '../../src/step'
import { botIntent } from '../../src/bot'
import type {
  FieldDiff,
  GoldenEntity,
  GoldenEventSummary,
  GoldenExpectation,
  GoldenFixture,
  GoldenKart,
  GoldenTolerance,
} from './golden-format'
import {
  GOLDEN_TAIL_TICKS,
  GOLDEN_TOL,
  decodeB64Lines,
  normZero,
  quantizeIntent,
  unpackIntents,
} from './golden-format'

export interface GoldenRun {
  end: SimState
  events: AuthEvent[]
  ticks: number
}

export interface DrivabilityReport {
  respawnCount: number
  finishedPlayerIds: number[]
  lapsByPlayer: number[]
  allFinished: boolean
  ok: boolean
}

/**
 * The golden start state. Every kart is marked connected and not a bot, so at replay time the
 * recorded stream is the only input source and no bot fill can run. The stream itself was authored
 * by botIntent at regeneration time, which is what makes replaying it a test of the bot's line.
 */
export function makeGoldenState(ctx: SimContext, seed: number, characterIdx: number[]): SimState {
  const s = createState(ctx, seed, characterIdx)
  for (let i = 0; i < MAX_KARTS; i++) {
    s.karts[i].isBot = false
    s.karts[i].connected = true
  }
  return s
}

/** Runs exactly `ticks` ticks, double-buffered, accumulating every emitted event. */
export function runGoldenTicks(
  ctx: SimContext,
  seed: number,
  characterIdx: number[],
  intents: Intent[][],
  ticks: number,
): GoldenRun {
  if (intents.length < ticks) {
    throw new Error(`golden: intent stream has ${intents.length} rows, need ${ticks}`)
  }
  let cur = makeGoldenState(ctx, seed, characterIdx)
  let nxt = makeGoldenState(ctx, seed, characterIdx)
  const events: AuthEvent[] = []
  for (let t = 0; t < ticks; t++) {
    if (cur.tick !== t) {
      throw new Error(`golden: state is at tick ${cur.tick} while replaying row ${t}`)
    }
    step(ctx, cur, nxt, intents[t], events)
    const tmp = cur
    cur = nxt
    nxt = tmp
  }
  return { end: cur, events, ticks }
}

export function replayGoldenFixture(ctx: SimContext, fx: GoldenFixture): GoldenRun {
  const intents = unpackIntents(decodeB64Lines(fx.intentsB64), fx.tickCount)
  return runGoldenTicks(ctx, fx.raceSeed, fx.characterIdx, intents, fx.tickCount)
}

/**
 * Drives all eight karts with botIntent and records the resulting stream. Stops
 * GOLDEN_TAIL_TICKS after the last kart's finish event, or at maxTicks.
 *
 * Bots recompute an Intent only on even ticks and reuse it on odd ticks, per the contract's
 * 30Hz-input-against-a-60Hz-sim convention.
 */
export function recordGoldenWithBots(
  ctx: SimContext,
  seed: number,
  characterIdx: number[],
  maxTicks: number,
): { run: GoldenRun; intents: Intent[][] } {
  let cur = makeGoldenState(ctx, seed, characterIdx)
  let nxt = makeGoldenState(ctx, seed, characterIdx)
  const events: AuthEvent[] = []
  const intents: Intent[][] = []
  const held: Intent[] = []
  for (let i = 0; i < MAX_KARTS; i++) {
    held.push({ tick: 0, steer: 0, accel: 0, brake: false, drift: false, useItem: false })
  }
  const finished = new Set<number>()
  let allFinishedAt = -1
  let ticks = 0

  while (ticks < maxTicks) {
    if (cur.tick !== ticks) {
      throw new Error(`golden: state is at tick ${cur.tick} while recording row ${ticks}`)
    }
    const row: Intent[] = []
    for (let i = 0; i < MAX_KARTS; i++) {
      if (cur.tick % 2 === 0) {
        const raw = botIntent(ctx, cur, i)
        held[i].steer = raw.steer
        held[i].accel = raw.accel
        held[i].brake = raw.brake
        held[i].drift = raw.drift
        held[i].useItem = raw.useItem
      }
      row.push(quantizeIntent(held[i], cur.tick))
    }
    intents.push(row)

    const before = events.length
    step(ctx, cur, nxt, row, events)
    const tmp = cur
    cur = nxt
    nxt = tmp
    ticks++

    for (let e = before; e < events.length; e++) {
      // playerId >= 0 only: updatePhase's race-level 'finish' carries -1.
      if (events[e].kind === 'finish' && events[e].playerId >= 0) finished.add(events[e].playerId)
    }
    if (allFinishedAt < 0 && finished.size >= MAX_KARTS) allFinishedAt = ticks
    if (allFinishedAt >= 0 && ticks >= allFinishedAt + GOLDEN_TAIL_TICKS) break
  }

  return { run: { end: cur, events, ticks }, intents }
}

function assertFinite(path: string, v: number): number {
  if (!Number.isFinite(v)) {
    throw new Error(`golden: ${path} is not finite (${v}); refusing to store it`)
  }
  return normZero(v)
}

function vec(path: string, v: Vec3): [number, number, number] {
  return [
    assertFinite(`${path}.x`, v.x),
    assertFinite(`${path}.y`, v.y),
    assertFinite(`${path}.z`, v.z),
  ]
}

export function toExpectation(state: SimState): GoldenExpectation {
  const karts: GoldenKart[] = []
  for (let i = 0; i < MAX_KARTS; i++) {
    const k = state.karts[i]
    karts.push({
      playerId: k.playerId,
      characterIdx: k.characterIdx,
      isBot: k.isBot,
      connected: k.connected,
      position: vec(`karts[${i}].position`, k.position),
      velocity: vec(`karts[${i}].velocity`, k.velocity),
      heading: assertFinite(`karts[${i}].heading`, k.heading),
      angularVelocity: assertFinite(`karts[${i}].angularVelocity`, k.angularVelocity),
      drift: {
        active: k.drift.active,
        dir: k.drift.dir,
        charge: assertFinite(`karts[${i}].drift.charge`, k.drift.charge),
      },
      item: k.item,
      airborne: k.airborne,
      surface: k.surface,
      spinOutTicks: k.spinOutTicks,
      invulnTicks: k.invulnTicks,
      boostTicks: k.boostTicks,
      respawnTicks: k.respawnTicks,
      shielded: k.shielded,
      lap: {
        lap: k.lap.lap,
        checkpointIdx: k.lap.checkpointIdx,
        t: assertFinite(`karts[${i}].lap.t`, k.lap.t),
      },
    })
  }

  const entities: GoldenEntity[] = []
  for (let i = 0; i < state.entityCount; i++) {
    const e = state.entities[i]
    entities.push({
      entityId: e.entityId,
      kind: e.kind,
      ownerId: e.ownerId,
      position: vec(`entities[${i}].position`, e.position),
      velocity: vec(`entities[${i}].velocity`, e.velocity),
      heading: assertFinite(`entities[${i}].heading`, e.heading),
      targetId: e.targetId,
      ttl: e.ttl,
    })
  }

  return {
    tick: state.tick,
    phase: state.phase,
    raceSeed: state.raceSeed,
    rngCursor: state.rngCursor,
    nextEventSeq: state.nextEventSeq,
    finishTick: state.finishTick,
    entityCount: state.entityCount,
    nextEntityId: state.nextEntityId,
    finishedOrder: state.finishedOrder.slice(),
    itemBoxes: state.itemBoxes.map((b) => ({ boxIdx: b.boxIdx, respawnTicks: b.respawnTicks })),
    karts,
    entities,
  }
}

function exact(
  out: FieldDiff[],
  path: string,
  expected: number | string | boolean,
  actual: number | string | boolean,
): void {
  const e = typeof expected === 'number' ? normZero(expected) : expected
  const a = typeof actual === 'number' ? normZero(actual) : actual
  if (Object.is(e, a)) return
  const delta = typeof e === 'number' && typeof a === 'number' ? a - e : Number.NaN
  out.push({ path, expected, actual, delta, tolerance: 0 })
}

function approx(
  out: FieldDiff[],
  path: string,
  expected: number,
  actual: number,
  tolerance: number,
): void {
  const delta = actual - expected
  // Written as a negated <= so a NaN actual is always reported.
  if (Math.abs(delta) <= tolerance) return
  out.push({ path, expected, actual, delta, tolerance })
}

/** Headings are compared as angles: the shortest signed difference, wrapped to (-PI, PI]. */
function approxAngle(
  out: FieldDiff[],
  path: string,
  expected: number,
  actual: number,
  tolerance: number,
): void {
  const delta = wrapAngle(actual - expected)
  if (Math.abs(delta) <= tolerance) return
  out.push({ path, expected, actual, delta, tolerance })
}

/** Every stored heading must already be wrapped; an unwrapped one is a contract violation. */
function checkWrapped(out: FieldDiff[], path: string, actual: number): void {
  if (actual > -Math.PI && actual <= Math.PI) return
  out.push({
    path: `${path}[wrapped]`,
    expected: '(-PI, PI]',
    actual,
    delta: Number.NaN,
    tolerance: 0,
  })
}

function diffKart(
  out: FieldDiff[],
  i: number,
  e: GoldenKart,
  a: KartState,
  tol: GoldenTolerance,
): void {
  const p = `karts[${i}]`
  exact(out, `${p}.playerId`, e.playerId, a.playerId)
  exact(out, `${p}.characterIdx`, e.characterIdx, a.characterIdx)
  exact(out, `${p}.isBot`, e.isBot, a.isBot)
  exact(out, `${p}.connected`, e.connected, a.connected)
  approx(out, `${p}.position.x`, e.position[0], a.position.x, tol.position)
  approx(out, `${p}.position.y`, e.position[1], a.position.y, tol.position)
  approx(out, `${p}.position.z`, e.position[2], a.position.z, tol.position)
  approx(out, `${p}.velocity.x`, e.velocity[0], a.velocity.x, tol.velocity)
  approx(out, `${p}.velocity.y`, e.velocity[1], a.velocity.y, tol.velocity)
  approx(out, `${p}.velocity.z`, e.velocity[2], a.velocity.z, tol.velocity)
  approxAngle(out, `${p}.heading`, e.heading, a.heading, tol.heading)
  checkWrapped(out, `${p}.heading`, a.heading)
  approx(out, `${p}.angularVelocity`, e.angularVelocity, a.angularVelocity, tol.angularVelocity)
  exact(out, `${p}.drift.active`, e.drift.active, a.drift.active)
  exact(out, `${p}.drift.dir`, e.drift.dir, a.drift.dir)
  approx(out, `${p}.drift.charge`, e.drift.charge, a.drift.charge, tol.driftCharge)
  exact(out, `${p}.item`, e.item, a.item)
  exact(out, `${p}.airborne`, e.airborne, a.airborne)
  exact(out, `${p}.surface`, e.surface, a.surface)
  exact(out, `${p}.spinOutTicks`, e.spinOutTicks, a.spinOutTicks)
  exact(out, `${p}.invulnTicks`, e.invulnTicks, a.invulnTicks)
  exact(out, `${p}.boostTicks`, e.boostTicks, a.boostTicks)
  exact(out, `${p}.respawnTicks`, e.respawnTicks, a.respawnTicks)
  exact(out, `${p}.shielded`, e.shielded, a.shielded)
  exact(out, `${p}.lap.lap`, e.lap.lap, a.lap.lap)
  exact(out, `${p}.lap.checkpointIdx`, e.lap.checkpointIdx, a.lap.checkpointIdx)
  approx(out, `${p}.lap.t`, e.lap.t, a.lap.t, tol.lapT)
}

function diffEntity(
  out: FieldDiff[],
  i: number,
  e: GoldenEntity,
  a: EntityState,
  tol: GoldenTolerance,
): void {
  const p = `entities[${i}]`
  exact(out, `${p}.entityId`, e.entityId, a.entityId)
  exact(out, `${p}.kind`, e.kind, a.kind)
  exact(out, `${p}.ownerId`, e.ownerId, a.ownerId)
  approx(out, `${p}.position.x`, e.position[0], a.position.x, tol.position)
  approx(out, `${p}.position.y`, e.position[1], a.position.y, tol.position)
  approx(out, `${p}.position.z`, e.position[2], a.position.z, tol.position)
  approx(out, `${p}.velocity.x`, e.velocity[0], a.velocity.x, tol.velocity)
  approx(out, `${p}.velocity.y`, e.velocity[1], a.velocity.y, tol.velocity)
  approx(out, `${p}.velocity.z`, e.velocity[2], a.velocity.z, tol.velocity)
  approxAngle(out, `${p}.heading`, e.heading, a.heading, tol.heading)
  checkWrapped(out, `${p}.heading`, a.heading)
  exact(out, `${p}.targetId`, e.targetId, a.targetId)
  exact(out, `${p}.ttl`, e.ttl, a.ttl)
}

export function diffAgainstGolden(
  exp: GoldenExpectation,
  act: SimState,
  tol: GoldenTolerance = GOLDEN_TOL,
): FieldDiff[] {
  const out: FieldDiff[] = []

  exact(out, 'tick', exp.tick, act.tick)
  exact(out, 'phase', exp.phase, act.phase)
  exact(out, 'raceSeed', exp.raceSeed, act.raceSeed)
  exact(out, 'rngCursor', exp.rngCursor, act.rngCursor)
  exact(out, 'nextEventSeq', exp.nextEventSeq, act.nextEventSeq)
  exact(out, 'finishTick', exp.finishTick, act.finishTick)
  exact(out, 'entityCount', exp.entityCount, act.entityCount)
  exact(out, 'nextEntityId', exp.nextEntityId, act.nextEntityId)
  exact(out, 'karts.length', MAX_KARTS, act.karts.length)
  exact(out, 'entities.length', MAX_ENTITIES, act.entities.length)

  exact(out, 'finishedOrder.length', exp.finishedOrder.length, act.finishedOrder.length)
  const nOrder = Math.min(exp.finishedOrder.length, act.finishedOrder.length)
  for (let i = 0; i < nOrder; i++) {
    exact(out, `finishedOrder[${i}]`, exp.finishedOrder[i], act.finishedOrder[i])
  }

  exact(out, 'itemBoxes.length', exp.itemBoxes.length, act.itemBoxes.length)
  const nBox = Math.min(exp.itemBoxes.length, act.itemBoxes.length)
  for (let i = 0; i < nBox; i++) {
    exact(out, `itemBoxes[${i}].boxIdx`, exp.itemBoxes[i].boxIdx, act.itemBoxes[i].boxIdx)
    exact(
      out,
      `itemBoxes[${i}].respawnTicks`,
      exp.itemBoxes[i].respawnTicks,
      act.itemBoxes[i].respawnTicks,
    )
  }

  const nKart = Math.min(MAX_KARTS, act.karts.length, exp.karts.length)
  for (let i = 0; i < nKart; i++) diffKart(out, i, exp.karts[i], act.karts[i], tol)

  const nLive = Math.min(exp.entityCount, exp.entities.length, act.entities.length)
  for (let i = 0; i < nLive; i++) diffEntity(out, i, exp.entities[i], act.entities[i], tol)
  // Live entities are packed at the front, so every slot past entityCount holds the dead sentinel.
  for (let i = exp.entityCount; i < act.entities.length; i++) {
    exact(out, `entities[${i}].entityId`, -1, act.entities[i].entityId)
  }

  return out
}

export function summarizeEvents(events: AuthEvent[]): GoldenEventSummary {
  const countsByKind: Record<string, number> = {
    itemGrant: 0,
    entitySpawn: 0,
    entityDespawn: 0,
    hit: 0,
    spinOut: 0,
    respawn: 0,
    lapCross: 0,
    finish: 0,
  }
  const finishes: { playerId: number; tick: number }[] = []
  for (const e of events) {
    countsByKind[e.kind] = (countsByKind[e.kind] ?? 0) + 1
    // Every event counts toward countsByKind, including updatePhase's race-level 'finish'
    // (playerId -1). `finishes` is the per-kart finishing ORDER, so it takes playerId >= 0 only.
    if (e.kind === 'finish' && e.playerId >= 0) finishes.push({ playerId: e.playerId, tick: e.tick })
  }
  return { total: events.length, countsByKind, finishes }
}

export function diffEventSummary(
  exp: GoldenEventSummary,
  act: GoldenEventSummary,
): FieldDiff[] {
  const out: FieldDiff[] = []
  exact(out, 'events.total', exp.total, act.total)
  const kinds = Object.keys(exp.countsByKind).sort()
  for (const kind of kinds) {
    exact(out, `events.countsByKind.${kind}`, exp.countsByKind[kind], act.countsByKind[kind] ?? -1)
  }
  exact(out, 'events.finishes.length', exp.finishes.length, act.finishes.length)
  const n = Math.min(exp.finishes.length, act.finishes.length)
  for (let i = 0; i < n; i++) {
    exact(out, `events.finishes[${i}].playerId`, exp.finishes[i].playerId, act.finishes[i].playerId)
    exact(out, `events.finishes[${i}].tick`, exp.finishes[i].tick, act.finishes[i].tick)
  }
  return out
}

/**
 * The spec's bot-drivability criterion: every kart finishes RACE_LAPS laps, with zero respawns.
 *
 * updatePhase [Task 15] emits ONE race-level 'finish' event with playerId -1 when the race ends,
 * on top of the per-kart 'finish' events updateLaps [Task 11] emits. Counting that one as a
 * finisher would make finishedPlayerIds nine entries long and allFinished permanently false, so
 * finishers are collected from playerId >= 0 only.
 */
export function checkDrivability(state: SimState, events: AuthEvent[]): DrivabilityReport {
  let respawnCount = 0
  const finished = new Set<number>()
  for (const e of events) {
    if (e.kind === 'respawn') respawnCount++
    else if (e.kind === 'finish' && e.playerId >= 0) finished.add(e.playerId)
  }
  const finishedPlayerIds = Array.from(finished).sort((a, b) => a - b)
  const lapsByPlayer: number[] = []
  for (let i = 0; i < MAX_KARTS; i++) lapsByPlayer.push(state.karts[i].lap.lap)
  const allFinished =
    finishedPlayerIds.length === MAX_KARTS && lapsByPlayer.every((l) => l >= RACE_LAPS)
  return { respawnCount, finishedPlayerIds, lapsByPlayer, allFinished, ok: allFinished && respawnCount === 0 }
}

export function describeDrivabilityFailure(d: DrivabilityReport): string {
  const missing: string[] = []
  for (let i = 0; i < MAX_KARTS; i++) {
    if (!d.finishedPlayerIds.includes(i)) missing.push(`player ${i} (lap ${d.lapsByPlayer[i]})`)
  }
  return (
    `golden: bot-drivability failed. respawn events: ${d.respawnCount} (must be 0); ` +
    `karts that did not finish ${RACE_LAPS} laps: ${missing.length === 0 ? 'none' : missing.join(', ')}; ` +
    `laps by player: [${d.lapsByPlayer.join(', ')}]`
  )
}

function fmtValue(v: number | string | boolean): string {
  if (typeof v !== 'number') return JSON.stringify(v)
  return Number.isInteger(v) ? String(v) : v.toPrecision(12)
}

export function formatDiffs(diffs: FieldDiff[]): string {
  if (diffs.length === 0) return ''
  const lines = diffs.map(
    (d) =>
      `${d.path}: expected ${fmtValue(d.expected)}, actual ${fmtValue(d.actual)}, ` +
      `delta ${Number.isNaN(d.delta) ? 'n/a' : d.delta.toExponential(3)}, ` +
      `tolerance ${d.tolerance === 0 ? 'exact' : d.tolerance.toExponential(0)}`,
  )
  return `${diffs.length} field(s) differ from the golden fixture:\n  ${lines.join('\n  ')}`
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npx vitest run packages/sim/test/golden-harness.test.ts`
Expected: PASS — 13 tests.

- [ ] **Step 9: Write the golden-replay test (it fails: no fixture yet)**

Create `packages/sim/test/golden-replay.test.ts`:

```ts
import { beforeAll, describe, expect, it } from 'vitest'

import type { SimContext } from '../src/types'
import { COUNTDOWN_TICKS, MAX_ENTITIES, MAX_KARTS, RACE_LAPS } from '../src/types'
import { makeContext, makeOvalTrack, makeTuning } from './fixtures/track-fixtures'
import type { GoldenExpectation, GoldenFixture } from './fixtures/golden-format'
import {
  GOLDEN_CHARACTER_IDX,
  GOLDEN_FORMAT_VERSION,
  GOLDEN_REGEN_COMMAND,
  GOLDEN_SEED,
  GOLDEN_TOL,
  INTENT_BYTES_PER_KART,
  INTENT_SCALE,
  MAX_GOLDEN_TICKS,
  decodeB64Lines,
  loadGoldenFixture,
  readGoldenFixtureText,
} from './fixtures/golden-format'
import {
  checkDrivability,
  diffAgainstGolden,
  diffEventSummary,
  formatDiffs,
  replayGoldenFixture,
  summarizeEvents,
} from './fixtures/golden-harness'
import type { GoldenRun } from './fixtures/golden-harness'

function clone(e: GoldenExpectation): GoldenExpectation {
  return JSON.parse(JSON.stringify(e)) as GoldenExpectation
}

let ctx: SimContext
let fixture: GoldenFixture
let run: GoldenRun

beforeAll(() => {
  ctx = makeContext(makeOvalTrack())
  fixture = loadGoldenFixture()
  run = replayGoldenFixture(ctx, fixture)
}, 180_000)

describe('golden fixture: 3-lap 8-bot race on makeOvalTrack', () => {
  it('is the race it claims to be', () => {
    expect(fixture.formatVersion).toBe(GOLDEN_FORMAT_VERSION)
    expect(fixture.generatedBy).toBe(GOLDEN_REGEN_COMMAND)
    expect(fixture.trackId).toBe(ctx.track.id)
    expect(fixture.raceSeed).toBe(GOLDEN_SEED)
    expect(fixture.raceSeed).toBe(20260813)
    expect(fixture.characterIdx).toEqual(GOLDEN_CHARACTER_IDX)
    expect(fixture.intentScale).toBe(INTENT_SCALE)
    expect(fixture.expected.raceSeed).toBe(GOLDEN_SEED)

    // The stream must cover every tick for every kart: tickCount * 8 karts * 5 bytes.
    const bytes = decodeB64Lines(fixture.intentsB64)
    expect(bytes.length).toBe(fixture.tickCount * MAX_KARTS * INTENT_BYTES_PER_KART)
  })

  it('lasts at least as long as physics allows for three laps', () => {
    // Absolute speed ceiling from the contract's targetSpeed product:
    //   maxSpeed 40 * fastest character speed 1.15 (character 5) * accel 1
    //   * surfaceSpeedFactor <= 1 * surge 0.7-or-1 * boostSpeedMul 1.35  =  62.1 m/s
    const ceilingSpeed = 40 * 1.15 * 1.35 // 62.1
    expect(ceilingSpeed).toBeCloseTo(62.1, 10)
    // Karts are frozen for the 180-tick countdown, then must cover 3 * trackLength metres.
    const lapMetres = ctx.query.totalLength()
    const floorTicks = COUNTDOWN_TICKS + Math.floor(((RACE_LAPS * lapMetres) / ceilingSpeed) * 60)
    expect(fixture.tickCount).toBeGreaterThan(floorTicks)
    expect(fixture.tickCount).toBeLessThanOrEqual(MAX_GOLDEN_TICKS)
    expect(run.ticks).toBe(fixture.tickCount)
  })

  it('carries no timestamp, hostname or absolute path', () => {
    const raw = readGoldenFixtureText()
    expect(Object.keys(fixture).sort()).toEqual([
      'characterIdx',
      'events',
      'expected',
      'formatVersion',
      'generatedBy',
      'intentScale',
      'intentsB64',
      'raceSeed',
      'tickCount',
      'trackId',
    ])
    expect(raw).not.toMatch(/\/home\//)
    expect(raw).not.toMatch(/\/Users\//)
    expect(raw).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/)
  })
})

describe('bot-drivability criterion', () => {
  it('finishes all three laps on all eight karts with zero respawns', () => {
    // Both halves of the spec §8 criterion are asserted here, and neither one alone is it:
    //   (a) all 8 karts complete RACE_LAPS laps, and
    //   (b) zero 'respawn' events across the entire run.
    const d = checkDrivability(run.end, run.events)

    // (b) "zero respawns" - the AuthEvent kind exists exactly so this is checkable.
    expect(d.respawnCount).toBe(0)
    expect(run.events.filter((e) => e.kind === 'respawn')).toHaveLength(0)
    expect(fixture.events.countsByKind.respawn).toBe(0)

    // (a) all eight finish the full race distance
    expect(d.finishedPlayerIds).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    expect(d.lapsByPlayer).toHaveLength(MAX_KARTS)
    for (let i = 0; i < MAX_KARTS; i++) {
      expect(d.lapsByPlayer[i]).toBeGreaterThanOrEqual(RACE_LAPS) // RACE_LAPS is 3
    }
    expect(d.allFinished).toBe(true)
    expect(d.ok).toBe(true)

    // finishedOrder is fixed length MAX_KARTS; every slot is filled, none left at -1
    expect(run.end.finishedOrder).toHaveLength(MAX_KARTS)
    expect(run.end.finishedOrder.filter((p) => p === -1)).toHaveLength(0)
    expect([...run.end.finishedOrder].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    expect(fixture.events.finishes).toHaveLength(MAX_KARTS)
    // 8 per-kart finish events from updateLaps [Task 11] + the 1 race-level event
    // updatePhase [Task 15] emits with playerId -1 = 9.
    expect(fixture.events.countsByKind.finish).toBe(MAX_KARTS + 1)

    // The first finish cannot happen during the 180-tick countdown, and the run keeps
    // recording for 60 ticks after the last kart finishes.
    expect(run.end.finishTick).toBeGreaterThan(COUNTDOWN_TICKS)
    expect(run.end.finishTick).toBeLessThan(run.end.tick)
  })
})

describe('replaying the recorded stream', () => {
  it('reproduces the stored state field by field', () => {
    const diffs = diffAgainstGolden(fixture.expected, run.end)
    // formatDiffs names every field, both values, the delta and the tolerance - which is
    // exactly what a digest mismatch cannot do.
    expect(formatDiffs(diffs)).toBe('')
    expect(diffs).toHaveLength(0)
    expect(run.end.karts).toHaveLength(MAX_KARTS)
    expect(run.end.entities).toHaveLength(MAX_ENTITIES)
    expect(fixture.expected.karts).toHaveLength(MAX_KARTS)
    expect(fixture.expected.entities).toHaveLength(fixture.expected.entityCount)
  })

  it('reproduces the stored event stream', () => {
    expect(formatDiffs(diffEventSummary(fixture.events, summarizeEvents(run.events)))).toBe('')
    expect(run.events).toHaveLength(fixture.events.total)
    for (let i = 1; i < run.events.length; i++) {
      expect(run.events[i].eventSeq).toBeGreaterThan(run.events[i - 1].eventSeq)
      expect(run.events[i].tick).toBeGreaterThanOrEqual(run.events[i - 1].tick)
    }
  })

  it('is deterministic across two runs in the same process', () => {
    const again = replayGoldenFixture(ctx, fixture)
    expect(formatDiffs(diffAgainstGolden(fixture.expected, again.end))).toBe('')
    expect(again.events).toHaveLength(run.events.length)
  })
})

describe('the fixture detects change', () => {
  it('catches a corrupted stored value and names the field', () => {
    // Below tolerance: 1e-9 m against a 1e-6 m band -> not a difference.
    const under = clone(fixture.expected)
    under.karts[3].position[0] += 1e-9
    expect(diffAgainstGolden(under, run.end)).toHaveLength(0)

    // Above tolerance: half a metre is 500000x the band -> exactly one named difference.
    const over = clone(fixture.expected)
    over.karts[3].position[0] += 0.5
    const posDiffs = diffAgainstGolden(over, run.end)
    expect(posDiffs).toHaveLength(1)
    expect(posDiffs[0].path).toBe('karts[3].position.x')
    expect(posDiffs[0].tolerance).toBe(GOLDEN_TOL.position)
    expect(posDiffs[0].delta).toBeLessThan(-0.4999999)
    expect(posDiffs[0].delta).toBeGreaterThan(-0.5000001)

    // An integer field has no band at all: one off is one difference.
    const lapCorrupt = clone(fixture.expected)
    lapCorrupt.karts[6].lap.lap += 1
    const lapDiffs = diffAgainstGolden(lapCorrupt, run.end)
    expect(lapDiffs).toHaveLength(1)
    expect(lapDiffs[0].path).toBe('karts[6].lap.lap')
    expect(lapDiffs[0].tolerance).toBe(0)
    expect(lapDiffs[0].delta).toBe(-1)

    // And a corrupted event count is caught by the event comparison, not the state one.
    const eventsCorrupt = JSON.parse(JSON.stringify(fixture.events)) as typeof fixture.events
    eventsCorrupt.countsByKind.finish -= 1
    const evDiffs = diffEventSummary(eventsCorrupt, summarizeEvents(run.events))
    expect(evDiffs.map((d) => d.path)).toContain('events.countsByKind.finish')
  })

  it('catches a one-part-in-240000 physics change on every kart', () => {
    // accelRate 24 -> 24.0001. One tick of that difference is
    //   0.0001 m/s^2 * TICK_DT (1/60 s) = 1.67e-6 m/s, already above the 1e-6 velocity band,
    // and it compounds over the whole race. Same recorded inputs, different physics.
    const bent = { ...ctx, tuning: makeTuning({ accelRate: 24.0001 }) }
    const bentRun = replayGoldenFixture(bent, fixture)
    const diffs = diffAgainstGolden(fixture.expected, bentRun.end)

    expect(diffs.length).toBeGreaterThanOrEqual(MAX_KARTS)
    const paths = diffs.map((d) => d.path)
    for (let i = 0; i < MAX_KARTS; i++) {
      const moved =
        paths.includes(`karts[${i}].position.x`) || paths.includes(`karts[${i}].position.z`)
      expect(moved).toBe(true)
    }
  })
})
```

- [ ] **Step 10: Run test to verify it fails**

Run: `npx vitest run packages/sim/test/golden-replay.test.ts`
Expected: FAIL — every test errors out of `beforeAll` with
`ENOENT: no such file or directory, open '.../packages/sim/test/fixtures/golden-oval-3lap-8bot.json'`

- [ ] **Step 11: Write the regeneration entry point and its documentation**

Create `packages/sim/test/golden-regen.test.ts`:

```ts
// Regenerating the golden fixture is an explicit, opt-in, developer-machine-only act:
//
//   UPDATE_GOLDEN=1 npx vitest run packages/sim/test/golden-regen.test.ts
//
// Without UPDATE_GOLDEN=1 the regeneration case is skipped, so this file is inert in a normal
// suite run. With UPDATE_GOLDEN=1 inside CI it fails loudly instead of quietly rewriting the
// thing CI is supposed to be checking.
import { describe, expect, it } from 'vitest'

import { MAX_KARTS } from '../src/types'
import { makeContext, makeOvalTrack } from './fixtures/track-fixtures'
import type { GoldenFixture } from './fixtures/golden-format'
import {
  GOLDEN_CHARACTER_IDX,
  GOLDEN_FORMAT_VERSION,
  GOLDEN_PATH,
  GOLDEN_REGEN_COMMAND,
  GOLDEN_SEED,
  INTENT_SCALE,
  MAX_GOLDEN_TICKS,
  assertRegenerationAllowed,
  encodeB64Lines,
  loadGoldenFixture,
  packIntents,
  saveGoldenFixture,
} from './fixtures/golden-format'
import {
  checkDrivability,
  describeDrivabilityFailure,
  diffAgainstGolden,
  formatDiffs,
  recordGoldenWithBots,
  replayGoldenFixture,
  summarizeEvents,
  toExpectation,
} from './fixtures/golden-harness'

const WANTS_REGEN = process.env.UPDATE_GOLDEN === '1'

describe('golden fixture regeneration', () => {
  it('refuses to run under CI, whatever the flag is called', () => {
    expect(() => assertRegenerationAllowed({ CI: 'true' })).toThrow(
      /refusing to regenerate because CI=true/,
    )
    expect(() => assertRegenerationAllowed({ GITHUB_ACTIONS: 'true' })).toThrow(
      /refusing to regenerate because GITHUB_ACTIONS=true/,
    )
    expect(() => assertRegenerationAllowed({ CONTINUOUS_INTEGRATION: 'yes' })).toThrow(
      /refusing to regenerate because CONTINUOUS_INTEGRATION=yes/,
    )
    expect(() => assertRegenerationAllowed({ CI: 'false' })).not.toThrow()
  })

  it.runIf(WANTS_REGEN)(
    'records a fresh 3-lap 8-bot race and writes the fixture',
    () => {
      assertRegenerationAllowed(process.env)

      const ctx = makeContext(makeOvalTrack())
      const rec = recordGoldenWithBots(ctx, GOLDEN_SEED, GOLDEN_CHARACTER_IDX, MAX_GOLDEN_TICKS)

      const drive = checkDrivability(rec.run.end, rec.run.events)
      if (!drive.ok) throw new Error(describeDrivabilityFailure(drive))
      expect(drive.finishedPlayerIds).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
      expect(drive.respawnCount).toBe(0)
      expect(rec.intents).toHaveLength(rec.run.ticks)
      expect(rec.intents[0]).toHaveLength(MAX_KARTS)

      const fx: GoldenFixture = {
        formatVersion: GOLDEN_FORMAT_VERSION,
        generatedBy: GOLDEN_REGEN_COMMAND,
        trackId: ctx.track.id,
        raceSeed: GOLDEN_SEED,
        characterIdx: GOLDEN_CHARACTER_IDX.slice(),
        tickCount: rec.run.ticks,
        intentScale: INTENT_SCALE,
        intentsB64: encodeB64Lines(packIntents(rec.intents)),
        expected: toExpectation(rec.run.end),
        events: summarizeEvents(rec.run.events),
      }
      saveGoldenFixture(fx)

      // A fixture that cannot reproduce itself is worse than no fixture, so prove it on the
      // way out - reload from disk and replay the stream we just wrote.
      const reloaded = loadGoldenFixture()
      const check = replayGoldenFixture(ctx, reloaded)
      expect(formatDiffs(diffAgainstGolden(reloaded.expected, check.end))).toBe('')

      // eslint-disable-next-line no-console
      console.log(
        `golden: wrote ${GOLDEN_PATH} - ${fx.tickCount} ticks, ` +
          `${fx.events.total} events, finish order [${fx.expected.finishedOrder.join(', ')}]`,
      )
    },
    600_000,
  )
})
```

Create `packages/sim/test/fixtures/GOLDEN.md`:

````md
# The golden-replay fixture

`golden-oval-3lap-8bot.json` is a recorded input stream for a full 3-lap, 8-kart race on
`makeOvalTrack`, plus the exact `SimState` and event stream that replaying it must produce.

## What it asserts

1. **Field-by-field state equality.** Every field of `SimState` after the final tick, compared by
   name: exactly for integers, enums and booleans, and within a stated per-field tolerance for the
   continuous ones.
2. **The event stream.** Total count, count per `AuthEventKind`, and the `(playerId, tick)` of every
   per-kart `finish` event. `updatePhase` also emits one race-level `finish` with `playerId -1` when
   the race ends: it is counted in `countsByKind.finish` (so a full race shows 9, not 8) but is not
   part of `finishes`, which is the finishing order.
3. **The spec's bot-drivability criterion.** Every kart finishes `RACE_LAPS` (3) laps *and* zero
   `respawn` events occurred across the entire run. `respawn` is one of the eight `AuthEventKind`s
   for exactly this reason: a track the bots cannot drive announces itself as respawn traffic.

## Why not a hash

A digest compresses ~1000 numbers into one. When it mismatches, the failure reads
`expected "a3f1c2…" to be "9c0417…"` — it **names no field, no value and no delta**. It cannot tell
"the drift charge tier boundary moved one tick" from "kart 6 fell through the floor on lap 2", nor
1e-15 metres of harmless float noise from 40 metres of broken physics. Every mismatch costs a bisect.

A digest also forces exact comparison onto continuous fields, so a legal re-association of a
floating-point sum turns the suite red for no behavioural reason. Teams respond by regenerating
reflexively, and a reflexively-regenerated fixture asserts nothing.

This fixture therefore compares fields and prints, for each difference: the path, the expected
value, the actual value, the delta, and the tolerance that was applied.

## Tolerances

| Field | Tolerance | Compared as |
|---|---|---|
| `position.{x,y,z}` | 1e-6 m | band |
| `velocity.{x,y,z}` | 1e-6 m/s | band |
| `heading` | 1e-7 rad | shortest signed angle, wrapped to (-PI, PI] |
| `angularVelocity` | 1e-7 rad/s | band |
| `drift.charge` | 1e-6 | band |
| `lap.t` | 1e-9 | band |
| everything else | — | exact (`Object.is`, with `-0` normalised to `+0`) |

Sizing: at a position magnitude of ~1e3 m one ULP is ~1.1e-13 m, so a few thousand ticks of
fully-correlated round-off is bounded near 4e-10 m. The smallest physically meaningful change is one
tick of acceleration — `accelRate` 24 m/s² × `TICK_DT` 1/60 s = 0.4 m/s, i.e. 6.7e-3 m of position.
The tolerance sits about six orders of magnitude above the noise and six below the signal.

Headings are compared as angles so that a kart sitting on ±π does not report a 2π "difference" that
is really the same direction. The wrap invariant is checked separately: any heading outside
(-PI, PI] is reported as `…heading[wrapped]`.

## Format

```
formatVersion  1
generatedBy    the command that regenerates this file
trackId        makeOvalTrack().id
raceSeed       20260813
characterIdx   [0,1,2,3,4,5,6,7]  - one of each character
tickCount      number of recorded ticks
intentScale    10000  - steer and accel are stored on a 1/10000 grid
intentsB64     the packed input stream, base64, split into 120-character lines
expected       the full SimState after the last tick
events         total, per-kind counts, and every finish
```

The packed stream is 5 bytes per kart per tick: `int16` steer (units 1/10000, little-endian),
`int16` accel, `uint8` flags (`1` brake, `2` drift, `4` useItem). Rows are 8 karts. The generator
**quantises before simulating**, so the stream that is stored is byte-identical to the stream that
produced the expectation, and replay is exact rather than merely close.

The fixture contains no timestamp, no hostname and no absolute path, so regenerating it with no
behaviour change produces no diff.

## Replay is not the bots

All eight karts are marked `connected: true, isBot: false` in the golden start state, so at replay
time the recorded stream is the only input source and no bot fill can run. The stream was *authored*
by `botIntent` when the fixture was recorded — which is what makes the drivability assertion
meaningful — but a later change to bot behaviour cannot move this fixture. Only physics can.

## Regenerating (intentional physics changes only)

```bash
UPDATE_GOLDEN=1 npx vitest run packages/sim/test/golden-regen.test.ts
```

- Without `UPDATE_GOLDEN=1` the regeneration case is skipped and the file is inert.
- With `CI`, `GITHUB_ACTIONS` or `CONTINUOUS_INTEGRATION` set to anything other than empty, `0` or
  `false`, it **refuses and throws**. Regenerating a golden is a claim that a physics change was
  intentional; only a human reading the diff can make that claim, so CI is never allowed to make it.
- The generator re-runs the drivability check before writing, and reloads and replays what it wrote
  before returning. A fixture that cannot reproduce itself is never committed.

Regenerate only when you meant to change physics. Read the resulting diff field by field: it is the
record of what your change did to the race.
````

- [ ] **Step 12: Generate the fixture**

Run: `UPDATE_GOLDEN=1 npx vitest run packages/sim/test/golden-regen.test.ts`
Expected: PASS — 2 tests, and a console line reading
`golden: wrote .../golden-oval-3lap-8bot.json - <N> ticks, <M> events, finish order [...]`.

Then confirm the file landed and note its tick count:

```bash
ls -l packages/sim/test/fixtures/golden-oval-3lap-8bot.json
node -e "const f=require('./packages/sim/test/fixtures/golden-oval-3lap-8bot.json');console.log('tickCount',f.tickCount,'seconds',(f.tickCount/60).toFixed(1),'events',f.events.total,'respawns',f.events.countsByKind.respawn,'finishes',f.events.finishes.length)"
```

Expected: `respawns 0`, `finishes 8`, and a `tickCount` well under 18000.

If the generator instead throws `golden: bot-drivability failed…`, it will name every kart that did
not finish and its lap count. That is a real defect upstream, not a fixture problem — fix it there
and re-run, never lower the criterion. Read the numbers it prints:

- **Every kart on `lap 0` and the event total near zero** — `step()` is not calling `updateLaps`
  [Task 11], so no `lapCross` or `finish` event can ever be emitted. Same shape of failure for
  `updateRecovery` [Task 9], `resolveKartCollisions` [Task 10] and `updateEntities` [Task 12]; see
  the dependency table in this task's Interfaces block.
- **Karts on lap 1 or 2 with respawn traffic** — a real bot line or track problem in Task 14's
  `botIntent` or in `makeOvalTrack`.

- [ ] **Step 13: Run the golden-replay test to verify it passes**

Run: `npx vitest run packages/sim/test/golden-replay.test.ts`
Expected: PASS — 9 tests, including `finishes all three laps on all eight karts with zero respawns`
and `catches a one-part-in-240000 physics change on every kart`.

- [ ] **Step 14: Deliberately corrupt one stored value and prove the fixture catches it**

```bash
cp packages/sim/test/fixtures/golden-oval-3lap-8bot.json /tmp/golden-backup.json
node -e "const fs=require('fs');const p='packages/sim/test/fixtures/golden-oval-3lap-8bot.json';const j=JSON.parse(fs.readFileSync(p,'utf8'));const before=j.expected.karts[3].position[0];j.expected.karts[3].position[0]=before+0.5;fs.writeFileSync(p,JSON.stringify(j,null,2)+'\n');console.log('corrupted karts[3].position.x',before,'->',before+0.5)"
npx vitest run packages/sim/test/golden-replay.test.ts
```

Expected: FAIL — `reproduces the stored state field by field` goes red (and so does
`catches a corrupted stored value and names the field`, which reads the same kart). The failure
message must contain the line

`karts[3].position.x: expected <the corrupted number>, actual <the simulated number>, delta -5.000e-1, tolerance 1e-6`

— the field, both values, the delta and the tolerance. A digest would have said only that two hex
strings differed. Then restore and confirm green again:

```bash
cp /tmp/golden-backup.json packages/sim/test/fixtures/golden-oval-3lap-8bot.json
npx vitest run packages/sim/test/golden-replay.test.ts
rm /tmp/golden-backup.json
```

Expected: PASS — 9 tests.

- [ ] **Step 15: Prove the regeneration command refuses to run in CI**

```bash
CI=true UPDATE_GOLDEN=1 npx vitest run packages/sim/test/golden-regen.test.ts
```

Expected: FAIL — `records a fresh 3-lap 8-bot race and writes the fixture` throws
`golden: refusing to regenerate because CI=true. A regenerated golden fixture is a claim that a
physics change was intentional; it must be produced on a developer machine and reviewed in the
diff. Unset CI to proceed.`

Then confirm the fixture on disk is untouched and that a plain CI run skips regeneration entirely:

```bash
git diff --stat packages/sim/test/fixtures/golden-oval-3lap-8bot.json
CI=true npx vitest run packages/sim/test/golden-regen.test.ts
```

Expected: an empty `git diff --stat`, and PASS with 1 test run and 1 skipped.

- [ ] **Step 16: Run the whole sim suite**

Run: `npx vitest run packages/sim`
Expected: PASS — every existing test plus the 4 files added here
(`golden-format.test.ts` 16, `golden-harness.test.ts` 13, `golden-replay.test.ts` 9,
`golden-regen.test.ts` 1 passed + 1 skipped).

- [ ] **Step 17: Commit**

```bash
git add packages/sim/test/fixtures/golden-format.ts \
        packages/sim/test/fixtures/golden-harness.ts \
        packages/sim/test/fixtures/GOLDEN.md \
        packages/sim/test/fixtures/golden-oval-3lap-8bot.json \
        packages/sim/test/golden-format.test.ts \
        packages/sim/test/golden-harness.test.ts \
        packages/sim/test/golden-replay.test.ts \
        packages/sim/test/golden-regen.test.ts
git commit -m "feat: golden-replay fixture for the 3-lap 8-bot oval race

Records an 8-kart input stream on makeOvalTrack and compares the resulting
SimState field by field - exact for integers, enums and booleans, and within
a stated per-field tolerance for position, velocity, heading, angular
velocity, drift charge and lap t. Not a hash: a digest mismatch names no
field, no value and no delta.

Also asserts the spec's bot-drivability criterion - all eight karts finish
three laps and zero respawn events occur across the whole run - and ships a
regeneration command that refuses to run when CI is set."
```

---

### Task 18: Public barrel export

**Files:**
- Modify: `packages/sim/src/index.ts` (replace the whole file: the 4 `export *` lines Task 2 left behind become 19, one per `src` module)
- Test: `packages/sim/test/barrel.test.ts`

**Interfaces:**

Task 1 pointed `packages/sim/package.json`'s `"exports"` map at `"." : "./src/index.ts"`, and Task 2
filled that file with four re-exports (`types`, `vec3`, `mathutil`, `rng`). Nothing has touched it
since, so fifteen of the nineteen simulation modules are unreachable through `@tapkart/sim` and
Plan 2's `net`, `server` and `game` packages cannot import the simulation at all. This task closes
that gap. It adds no new behaviour and changes no signature.

- Consumes — every `src` module, by the exact names the locked contract fixes. This list is the
  test's import list, and it is one named export per module so that a module missing from the barrel
  fails loudly:

  ```ts
  // packages/sim/src/types.ts                                 [Task 2]
  export const TICK_HZ = 60
  export const TICK_DT = 1 / 60
  export const MAX_KARTS = 8
  export const MAX_ENTITIES = 32
  export const RACE_LAPS = 3
  export const COUNTDOWN_TICKS = 180
  // plus the types: Vec3, Intent, DriftState, LapProgress, KartState, EntityState,
  // ItemBoxState, SimState, AuthEvent, AuthEventKind, ItemKind, EntityKind, Surface,
  // RacePhase, Track, TrackPoint, TrackQuery, TrackProjection, CharacterStats, Tuning,
  // SimContext

  // packages/sim/src/vec3.ts                                  [Task 2]
  export function v3(x: number, y: number, z: number): Vec3
  export function v3add(a: Vec3, b: Vec3, out: Vec3): void
  export function v3scale(a: Vec3, s: number, out: Vec3): void
  export function v3len(a: Vec3): number
  export function v3dot(a: Vec3, b: Vec3): number

  // packages/sim/src/mathutil.ts                              [Task 2]
  export function clamp(v: number, lo: number, hi: number): number
  export function lerp(a: number, b: number, t: number): number
  export function wrapAngle(a: number): number                 // -> (-PI, PI]

  // packages/sim/src/rng.ts                                   [Task 2]
  export function rngAt(seed: number, cursor: number): number  // splitmix32, [0,1)

  // packages/sim/src/track.ts
  export function validateTrack(track: Track): string[]            // [Task 3]
  export function buildTrackQuery(track: Track): TrackQuery        // [Task 4]

  // packages/sim/src/state.ts                                 [Task 5]
  export function createState(ctx: SimContext, seed: number, characterIdx: number[]): SimState
  export function cloneState(src: SimState, dst: SimState): void
  export function statesEqual(a: SimState, b: SimState): boolean
  export function emit(state: SimState, out: AuthEvent[], kind: AuthEventKind,
                       playerId: number, entityId: number, item: ItemKind, data: number): void

  // packages/sim/src/step.ts                                  [Task 5, extended by 6-15]
  export function step(ctx: SimContext, prev: SimState, next: SimState,
                       inputs: Intent[], events: AuthEvent[]): void

  // packages/sim/src/kart.ts                                  [Task 6]
  export function stepKart(ctx: SimContext, state: SimState, prevKart: KartState,
                           k: KartState, raw: Intent): void
  export function targetSpeedFor(ctx: SimContext, state: SimState, k: KartState,
                                 accel: number): number

  // packages/sim/src/ground.ts                                [Task 7]
  export function applyAirYaw(ctx: SimContext, k: KartState, steer: number): void
  export function integrateVertical(ctx: SimContext, k: KartState): void
  export function applyRamps(ctx: SimContext, k: KartState, s: number): void

  // packages/sim/src/drift.ts                                 [Task 8]
  export function updateDrift(ctx: SimContext, k: KartState, raw: Intent): void
  export function decayBoost(k: KartState): void

  // packages/sim/src/recovery.ts                              [Task 9]
  export function steeringLocked(k: KartState): boolean
  export function surfaceSpeedFactor(k: KartState, t: Tuning): number
  export function updateRecovery(ctx: SimContext, state: SimState,
                                 k: KartState, events: AuthEvent[]): void

  // packages/sim/src/collision.ts                             [Task 10]
  export function resolveKartCollisions(ctx: SimContext, state: SimState): void

  // packages/sim/src/laps.ts                                  [Task 11]
  export function updateLaps(ctx: SimContext, state: SimState, k: KartState,
                             events: AuthEvent[]): void

  // packages/sim/src/placement.ts                             [Task 11]
  export function placementOrder(state: SimState): number[]
  export function computePlacement(state: SimState, outIndexOf: Int32Array,
                                   outOrder: Int32Array): void

  // packages/sim/src/entity.ts                                [Task 12]
  export function spawnEntity(state: SimState, kind: EntityKind, ownerId: number,
                              position: Vec3, heading: number, targetId: number,
                              ttl: number, events: AuthEvent[]): number
  export function despawnEntityAt(state: SimState, idx: number, events: AuthEvent[]): void
  export function kartById(state: SimState, playerId: number): KartState | null
  export function updateEntities(ctx: SimContext, state: SimState, events: AuthEvent[]): void
  export function surgeActiveOn(state: SimState, playerId: number): boolean

  // packages/sim/src/items.ts                                 [Task 13]
  export function updateItemBoxes(ctx: SimContext, state: SimState, events: AuthEvent[]): void
  export function rollItem(ctx: SimContext, state: SimState, placeIdx: number): ItemKind
  export function useItem(ctx: SimContext, state: SimState, k: KartState,
                          events: AuthEvent[]): void

  // packages/sim/src/bot.ts                                   [Task 14]
  export function botIntent(ctx: SimContext, state: SimState, playerId: number): Intent

  // packages/sim/src/phase.ts                                 [Task 15]
  export const FINISH_GRACE_TICKS = 1800
  export function makeIntentBuffer(): Intent[]
  export function resetBotHold(): void
  export function resolveInputs(ctx: SimContext, state: SimState,
                                inputs: Intent[], out: Intent[]): void
  export function updatePhase(ctx: SimContext, state: SimState, events: AuthEvent[]): void

  // packages/sim/src/replay.ts                                [Task 16]
  export interface IntentSource { intentFor(state: SimState, playerId: number): Intent }
  export const INTENT_HEADER = 4
  export const INTENT_STRIDE = 5
  export function intentOffset(intents: Float64Array, tick: number, slot: number): number
  export function allocStateLike(ctx: SimContext, src: SimState): SimState
  export function recordRun(ctx: SimContext, from: SimState, ticks: number,
                            src: IntentSource): { end: SimState; intents: Float64Array }
  export function replayRun(ctx: SimContext, from: SimState, intents: Float64Array,
                            fromTick: number, toTick: number): SimState

  // packages/sim/test/fixtures/track-fixtures.ts              [Task 3]
  export function makeStraightTrack(overrides?: Partial<Track>): Track
  export function makeContext(track: Track, isLeader?: boolean): SimContext  // [Task 4]
  ```

- Produces:
  - `packages/sim/src/index.ts` re-exporting all nineteen modules — `types`, `vec3`, `mathutil`,
    `rng`, `track`, `state`, `step`, `kart`, `ground`, `drift`, `recovery`, `collision`, `laps`,
    `placement`, `entity`, `items`, `bot`, `phase`, `replay` — so `import { step, createState }
    from '@tapkart/sim'` works from any workspace package.

**Facts this task rests on (check them, do not assume them):**

1. `export *` re-exports types and values together and is legal under `isolatedModules`; only a
   named `export { SomeType }` would need `export type`.
2. No two `src` modules export the same name, so no `export *` is ambiguous. In ESM an ambiguous
   star-export is silently excluded from the namespace and importing it by name is a `SyntaxError`,
   which is why Step 1 asserts the absence of clashes at runtime rather than trusting this sentence.
3. The barrel imports every module; no module imports the barrel. Adding it therefore creates no
   import cycle.
4. Test fixtures live under `packages/sim/test/`, never under `src/`, so the barrel cannot leak
   `makeOvalTrack` or `makeTuning` into the public surface. Step 1 asserts that too.

---

- [ ] **Step 1: Write the failing test**

Create `packages/sim/test/barrel.test.ts`:

```ts
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import type { AuthEvent } from '../src/index'
import * as sim from '../src/index'
import {
  // types [Task 2]
  COUNTDOWN_TICKS,
  MAX_ENTITIES,
  MAX_KARTS,
  RACE_LAPS,
  TICK_DT,
  TICK_HZ,
  // vec3 [Task 2]
  v3,
  v3add,
  v3dot,
  v3len,
  v3scale,
  // mathutil [Task 2]
  clamp,
  lerp,
  wrapAngle,
  // rng [Task 2]
  rngAt,
  // track [Tasks 3 and 4]
  buildTrackQuery,
  validateTrack,
  // state [Task 5]
  cloneState,
  createState,
  emit,
  statesEqual,
  // step [Task 5]
  step,
  // kart [Task 6]
  stepKart,
  targetSpeedFor,
  // ground [Task 7]
  applyAirYaw,
  applyRamps,
  integrateVertical,
  // drift [Task 8]
  decayBoost,
  updateDrift,
  // recovery [Task 9]
  steeringLocked,
  surfaceSpeedFactor,
  updateRecovery,
  // collision [Task 10]
  resolveKartCollisions,
  // laps [Task 11]
  updateLaps,
  // placement [Task 11]
  computePlacement,
  placementOrder,
  // entity [Task 12]
  despawnEntityAt,
  kartById,
  spawnEntity,
  surgeActiveOn,
  updateEntities,
  // items [Task 13]
  rollItem,
  updateItemBoxes,
  useItem,
  // bot [Task 14]
  botIntent,
  // phase [Task 15]
  FINISH_GRACE_TICKS,
  makeIntentBuffer,
  resetBotHold,
  resolveInputs,
  updatePhase,
  // replay [Task 16]
  INTENT_HEADER,
  INTENT_STRIDE,
  allocStateLike,
  intentOffset,
  recordRun,
  replayRun,
} from '../src/index'

// The same three bindings imported straight from their own modules, to prove the
// barrel re-exports them rather than redeclaring anything.
import { botIntent as botIntentDirect } from '../src/bot'
import { createState as createStateDirect } from '../src/state'
import { step as stepDirect } from '../src/step'

// Every module as a namespace, for the ambiguity scan.
import * as botNs from '../src/bot'
import * as collisionNs from '../src/collision'
import * as driftNs from '../src/drift'
import * as entityNs from '../src/entity'
import * as groundNs from '../src/ground'
import * as itemsNs from '../src/items'
import * as kartNs from '../src/kart'
import * as lapsNs from '../src/laps'
import * as mathutilNs from '../src/mathutil'
import * as phaseNs from '../src/phase'
import * as placementNs from '../src/placement'
import * as recoveryNs from '../src/recovery'
import * as replayNs from '../src/replay'
import * as rngNs from '../src/rng'
import * as stateNs from '../src/state'
import * as stepNs from '../src/step'
import * as trackNs from '../src/track'
import * as typesNs from '../src/types'
import * as vec3Ns from '../src/vec3'

import { makeContext, makeStraightTrack } from './fixtures/track-fixtures'

const HERE = dirname(fileURLToPath(import.meta.url))   // packages/sim/test
const SRC = join(HERE, '..', 'src')

/** The nineteen modules the barrel must re-export, in the locked contract's order. */
const BARREL_MODULES = [
  'types',
  'vec3',
  'mathutil',
  'rng',
  'track',
  'state',
  'step',
  'kart',
  'ground',
  'drift',
  'recovery',
  'collision',
  'laps',
  'placement',
  'entity',
  'items',
  'bot',
  'phase',
  'replay',
]

const NAMESPACES: [string, object][] = [
  ['types', typesNs],
  ['vec3', vec3Ns],
  ['mathutil', mathutilNs],
  ['rng', rngNs],
  ['track', trackNs],
  ['state', stateNs],
  ['step', stepNs],
  ['kart', kartNs],
  ['ground', groundNs],
  ['drift', driftNs],
  ['recovery', recoveryNs],
  ['collision', collisionNs],
  ['laps', lapsNs],
  ['placement', placementNs],
  ['entity', entityNs],
  ['items', itemsNs],
  ['bot', botNs],
  ['phase', phaseNs],
  ['replay', replayNs],
]

describe('@tapkart/sim barrel', () => {
  it('exports a named function from every simulation module', () => {
    const fns: [string, unknown][] = [
      ['vec3.v3', v3],
      ['vec3.v3add', v3add],
      ['vec3.v3scale', v3scale],
      ['vec3.v3len', v3len],
      ['vec3.v3dot', v3dot],
      ['mathutil.clamp', clamp],
      ['mathutil.lerp', lerp],
      ['mathutil.wrapAngle', wrapAngle],
      ['rng.rngAt', rngAt],
      ['track.validateTrack', validateTrack],
      ['track.buildTrackQuery', buildTrackQuery],
      ['state.createState', createState],
      ['state.cloneState', cloneState],
      ['state.statesEqual', statesEqual],
      ['state.emit', emit],
      ['step.step', step],
      ['kart.stepKart', stepKart],
      ['kart.targetSpeedFor', targetSpeedFor],
      ['ground.applyAirYaw', applyAirYaw],
      ['ground.integrateVertical', integrateVertical],
      ['ground.applyRamps', applyRamps],
      ['drift.updateDrift', updateDrift],
      ['drift.decayBoost', decayBoost],
      ['recovery.steeringLocked', steeringLocked],
      ['recovery.surfaceSpeedFactor', surfaceSpeedFactor],
      ['recovery.updateRecovery', updateRecovery],
      ['collision.resolveKartCollisions', resolveKartCollisions],
      ['laps.updateLaps', updateLaps],
      ['placement.placementOrder', placementOrder],
      ['placement.computePlacement', computePlacement],
      ['entity.spawnEntity', spawnEntity],
      ['entity.despawnEntityAt', despawnEntityAt],
      ['entity.kartById', kartById],
      ['entity.updateEntities', updateEntities],
      ['entity.surgeActiveOn', surgeActiveOn],
      ['items.updateItemBoxes', updateItemBoxes],
      ['items.rollItem', rollItem],
      ['items.useItem', useItem],
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
    for (const [name, fn] of fns) {
      expect(typeof fn, `${name} did not come through the barrel as a function`).toBe('function')
    }
  })

  it('carries the contract constants through unchanged', () => {
    expect(TICK_HZ).toBe(60)
    expect(TICK_DT).toBe(1 / 60)
    expect(MAX_KARTS).toBe(8)
    expect(MAX_ENTITIES).toBe(32)
    expect(RACE_LAPS).toBe(3)
    expect(COUNTDOWN_TICKS).toBe(180)
    expect(FINISH_GRACE_TICKS).toBe(1800)   // phase.ts [Task 15], 30 s at 60 Hz
    expect(INTENT_HEADER).toBe(4)           // replay.ts [Task 16]
    expect(INTENT_STRIDE).toBe(5)
  })

  it('re-exports each module\'s own binding, not a copy', () => {
    expect(step).toBe(stepDirect)
    expect(createState).toBe(createStateDirect)
    expect(botIntent).toBe(botIntentDirect)
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

    // Fixtures live in test/, so none of them can be part of the public surface.
    expect(Object.prototype.hasOwnProperty.call(sim, 'makeOvalTrack')).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(sim, 'makeTuning')).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(sim, 'makeContext')).toBe(false)
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
    const clashes = Array.from(owners.entries()).filter(([, mods]) => mods.length > 1)
    expect(clashes).toEqual([])

    for (const [mod, ns] of NAMESPACES) {
      for (const key of Object.keys(ns)) {
        expect(
          Object.prototype.hasOwnProperty.call(sim, key),
          `${mod}.${key} is not reachable through the barrel`,
        ).toBe(true)
      }
    }
  })

  it('runs a tick through the barrel alone', () => {
    const ctx = makeContext(makeStraightTrack())
    const chars = [0, 1, 2, 3, 4, 5, 6, 7]
    const prev = createState(ctx, 0x7a17, chars)
    const next = createState(ctx, 0x7a17, chars)
    const inputs = makeIntentBuffer()
    const events: AuthEvent[] = []

    resetBotHold()
    step(ctx, prev, next, inputs, events)

    expect(next.tick).toBe(1)
    expect(prev.tick).toBe(0)                 // step never mutates prev
    expect(next.karts).toHaveLength(MAX_KARTS)
    expect(next.entities).toHaveLength(MAX_ENTITIES)
    expect(next.phase).toBe('countdown')      // tick 1 < COUNTDOWN_TICKS (180)
  })

  it('resolves through the @tapkart/sim package entry point', async () => {
    // package.json maps "." to ./src/index.ts, which is the exact path Plan 2's
    // net/server/game packages will import. Dynamic, so a resolution failure
    // fails this one test instead of preventing the file from being collected.
    const pkg = await import('@tapkart/sim')
    expect(pkg.step).toBe(stepDirect)
    expect(pkg.createState).toBe(createStateDirect)
    expect(pkg.MAX_KARTS).toBe(8)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/sim/test/barrel.test.ts`

Expected: FAIL — the file cannot even be collected, because `src/index.ts` still exports only
`types`, `vec3`, `mathutil` and `rng`:
`SyntaxError: The requested module '/…/packages/sim/src/index.ts' does not provide an export named
'buildTrackQuery'` (the first name in the import list that the barrel does not carry).

Run: `npx tsc --noEmit -p packages/sim`

Expected: FAIL with one `TS2305: Module '"../src/index"' has no exported member '<name>'` per
missing name — `buildTrackQuery`, `validateTrack`, `createState`, `step`, and so on down the list.

- [ ] **Step 3: Write the barrel**

Replace the whole of `packages/sim/src/index.ts`. It currently contains exactly this, from Task 2:

```typescript
export * from './types'
export * from './vec3'
export * from './mathutil'
export * from './rng'
```

Replace it with:

```typescript
// Public barrel for @tapkart/sim.
//
// packages/sim/package.json maps "." to this file, so this list IS the package's
// public surface: Plan 2's net, server and game packages import the simulation
// through `@tapkart/sim` and get exactly what is re-exported here.
//
// Ordered as the locked contract's module map lists them. `export *` carries
// types and values together and is legal under isolatedModules; only a named
// `export { SomeType }` would need `export type`. No two modules below export
// the same name, so no re-export is ambiguous - barrel.test.ts asserts that at
// runtime rather than leaving it to this comment.
export * from './types'
export * from './vec3'
export * from './mathutil'
export * from './rng'
export * from './track'
export * from './state'
export * from './step'
export * from './kart'
export * from './ground'
export * from './drift'
export * from './recovery'
export * from './collision'
export * from './laps'
export * from './placement'
export * from './entity'
export * from './items'
export * from './bot'
export * from './phase'
export * from './replay'
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/sim/test/barrel.test.ts`

Expected: PASS — 7 tests.

If `has no ambiguous re-export` fails, it prints the clashing name and the two modules that both
export it, e.g. `[ [ 'surfaceSpeedFactor', [ 'drift', 'recovery' ] ] ]`. The fix is to rename the
copy in the module that does **not** own the name per the locked contract's module map, not to drop
a line from the barrel: a module missing from the barrel is the defect this task exists to remove.

- [ ] **Step 5: Verify the public surface from outside the package**

Run:

```bash
npx vitest run packages/sim/test/barrel.test.ts -t "resolves through the @tapkart/sim package entry point"
npm ls --depth=0
```

Expected: PASS — 1 test, and `npm ls` lists `@tapkart/sim@0.1.0 -> ./packages/sim`, the workspace
link that made the bare specifier resolve.

- [ ] **Step 6: Run the full sim suite and typecheck**

Run: `npx tsc --noEmit -p packages/sim && npx vitest run packages/sim`

Expected: PASS, zero type errors, every sim test green including Task 17's golden replay. The barrel
adds no runtime behaviour; the only way this step can go red is a genuine name clash between two
modules (`TS2308: Module './x' has already exported a member named 'y'`), which Step 4's test would
already have named.

- [ ] **Step 7: Commit**

```bash
git add packages/sim/src/index.ts packages/sim/test/barrel.test.ts
git commit -m "feat(sim): re-export every simulation module from the package barrel

src/index.ts carried only types, vec3, mathutil and rng since Task 2, so
fifteen modules - track, state, step, kart, ground, drift, recovery,
collision, laps, placement, entity, items, bot, phase and replay - were
unreachable through @tapkart/sim and Plan 2's net/server/game packages
could not import the simulation at all.

barrel.test.ts imports one named export from each of the nineteen modules
through ../src/index, pins the contract constants, proves the barrel
forwards each module's own binding rather than a copy, checks the module
list against the src/ directory so a new module cannot be forgotten,
scans for ambiguous re-exports (an ambiguous star export is silently
dropped from an ESM namespace), and resolves the bare @tapkart/sim
specifier the way a downstream package will."
```
