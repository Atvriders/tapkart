# Tapkart Plan 1 — Locked Interface Contract

> This is the **Global Constraints** section of the Plan 1 implementation plan.
> Every task's requirements implicitly include everything here. No task may
> rename, re-sign, or add fields to anything below. A task needing something
> absent must define it in its own files and say so in its `Interfaces` block.

**Spec:** `docs/superpowers/specs/2026-08-13-tapkart-design.md`

---

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
