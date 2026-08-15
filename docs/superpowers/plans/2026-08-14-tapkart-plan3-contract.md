# Tapkart Plan 3 — Locked Interface Contract

> **STATUS: LOCKED.** This is binding. It is the **Global Constraints** section of
> the Plan 3 implementation plan: every task's requirements implicitly include
> everything here. No task may rename, re-sign, or add fields to anything below.
> A task needing something absent must define it in its own files and say so in
> its `Interfaces` block — and if two tasks would need the same absent thing,
> that is an amendment, not a local definition.
>
> The draft this replaces carried 34 open questions. All 34 are ruled in
> `docs/superpowers/plans/2026-08-14-tapkart-plan3-rulings.md`, every ruling is
> applied below, and the open-questions section is gone. §14 indexes where each
> ruling landed; §15 lists the four gaps the rulings did not reach and the call
> made on each, so nothing here is silently invented.

**Spec:** `docs/superpowers/specs/2026-08-13-tapkart-design.md` (amended 2026-08-14). The spec is the binding authority; where this contract and the spec disagree, the spec wins and this contract is wrong.
**Rulings:** `docs/superpowers/plans/2026-08-14-tapkart-plan3-rulings.md`. Binding over the draft, always.
**Builds on:** Plan 1 (`@tapkart/sim`, merged at `1f1f2c4`, 19 modules, 477 tests) and Plan 2 (`@tapkart/protocol` + `@tapkart/net`, merged to master `ff87a46` on 2026-08-15).
**Scope:** `packages/render`, `packages/game`, and `apps/web` (shell only — Q11). Plan 3 of 5.

> **Implementation correction (2026-08-15, supersedes later smoothing and frame-loop
> literals):** `correctionDeltaOf` and `RaceSession.correctionDelta` report
> **post-reconciliation minus pre-reconciliation**. `ViewBuilder` negates both
> components before seeding `VisualOffset`, because that offset is added to the
> corrected pose; passing the net delta through would double the visible jump.
> A frame interpolates the visual offset from its previous endpoint to its new
> endpoint with the same `alpha` used for the pose. In particular, `alpha = 0`
> retains an older residual when a second correction lands, while `alpha = 1`
> carries the newly seeded inverse in full. During a multi-tick catch-up frame,
> the shell calls `ViewBuilder.build(1, currentView)` after every non-final tick
> so the one-tick correction latch is consumed before the next tick resets it;
> only the final build produces camera/HUD/audio/render output. These rules are
> pinned by deterministic overlap and real two-tick catch-up regressions in the
> shipped implementation (`2c5598c`).

Every signature in §2 was read out of real source in
`packages/*/src/` on 2026-08-14, in the worktree Plan 2 was built in; re-verified against master after Plan 2 merged (`ff87a46`, 2026-08-15) and is quoted, not
reconstructed. Where a name Plan 3 needs does not exist in that source yet, §2.5
says so in those words and states the exact shape Plan 2 must ship.

---

## 0. Conventions that are decided, not negotiable

Plan 1's and Plan 2's conventions carry forward unchanged and are **not**
restated except where Plan 3 adds to them. In particular: `forward = (cos h, 0,
sin h)`; `right = (-t.z, 0, t.x)` normalised; positive `lateral` is right of
travel; up is `+y`; headings wrapped to `(-π, π]`; **track parameter `s` is
arc-normalised `[0, 1)`, never metres**; extensionless imports; `import type`
under `verbatimModuleSyntax`; vitest with `globals: false`; bare specifiers
(`@tapkart/sim`, `@tapkart/protocol`, `@tapkart/net`, `@tapkart/render`) across
packages in `src`, never a relative path into another package.

New for Plan 3:

| Convention | Value |
|---|---|
| Units | metres, radians, seconds-derived-from-ticks. Never pixels in any pure module **except** `packages/game/src/controls/*`, whose whole job is pixels, and which states `Px` in every such name |
| Screen units | **CSS pixels**, everywhere in `controls`. `Viewport.width/height` are CSS px; `devicePixelRatio` appears in exactly one call, `RendererBackend.resize` |
| Orientation | **landscape only** (R40). Q24's layout — 88 px buttons on fixed insets, left half steering — has no portrait meaning, so portrait is not a supported state to lay out for. The shell shows a rotate-your-device overlay and does not resize the canvas while `viewport.height > viewport.width`; Plan 5's PWA manifest `"orientation": "landscape"` is a consequence of this line, not an independent decision |
| Angles | same wrap as sim: `(-π, π]`, via `wrapAngle` from `@tapkart/sim` |
| Colour | `PaletteRGB = readonly [number, number, number]`, each component `0..1` **linear**. Never a CSS string, never `0..255`, never hex, in any pure module |
| Time in pure code | **ticks**, or tick-derived milliseconds via `TICK_MS`. `Date.now()` and `performance.now()` appear in **exactly one** file, `packages/game/src/clock.ts`, behind `FrameClock` |
| `TICK_MS` | exported by `@tapkart/net` (Q6). Imported, never redefined, and **`render` never sees it at all** — see §4.1 |
| Time in the interpolator | `RemoteInterpolator` keyframes are stamped `recvAtMs = tick * TICK_MS` by `ClientLoop`. Anything asking it for a sample **must** pass a `nowMs` in that same tick-derived basis. §6.3 makes this unbreakable by construction |
| Drift tier encoding | **sim's, exactly**: `-1` = no mini-turbo pending, `0`/`1`/`2` = an index into `Tuning.driftBoosts`. `driftTierFor` from `@tapkart/sim` is the only function that computes it, called from exactly one place (§5.11). No second encoding exists anywhere in Plan 3 |
| Out-parameters | every per-frame builder writes into a caller-owned `out` and returns `void`. Nothing in the frame path allocates, exactly as `step()` does not |
| `render` never mutates simulation state | Spec §3. `render` takes view structs; it holds no `SimState` reference and imports nothing that can write one |
| Screens are data | Screen transitions are a pure reducer over an event union. No screen module reaches into the DOM to decide what screen it is |
| Scratch discipline | `TrackQuery.sampleAt`, `tangentAt` and `project` **return the same object on every call** and overwrite it in place (`packages/sim/src/track.ts:463-490`, and its doc comment says so). Copy every field you need before the next call, in `render` and `game` exactly as in `sim` |
| Dev-only branches | `import.meta.env.DEV`, and nothing else. One declaration file makes it type-check (§5.14); Vite strips the branch from the production bundle; vitest sets it `true` |

### 0a. The one rule that decides whether this plan is testable

Every module in `packages/render` and `packages/game` is one of exactly two
kinds, and the file says which in its first line:

- **Pure** — a function of its arguments, no DOM, no GPU, no clock, no `three`
  import (not even `import type`, see §8.2). Returns or fills plain data.
  **Testable headlessly, and every one of them is tested.**
- **Adapter** — the thin layer that hands plain data to a real GPU, DOM or
  device. Contains no decisions: no branching on game state, no arithmetic
  beyond unit conversion, no allocation policy. **Not tested in CI,
  owner-verified** (spec §8, "What CI cannot verify").

A conditional in an adapter is a contract violation, because it is a decision CI
cannot see. If an adapter needs to branch, the branch is wrong-side-of-the-seam
and moves into the pure layer as a field on `RenderFrame`, `HudModel` or
`AudioModel`.

There are exactly **four** adapter files in Plan 3, listed in §8.2. Every other
file in both packages is pure.

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
| `@tapkart/content` | `@tapkart/sim` (types and `buildTrackQuery` only) |
| `@tapkart/render` | `@tapkart/sim`, `@tapkart/content`, `three` |
| `@tapkart/game` | `@tapkart/sim`, `@tapkart/protocol`, `@tapkart/net`, `@tapkart/content`, `@tapkart/render` |
| `apps/web` | `@tapkart/game`, `@tapkart/render` (and `vite`, dev) |
| `server` (Plan 4) | `@tapkart/sim`, `@tapkart/protocol`, `@tapkart/net`, **`@tapkart/content`** |

**`packages/content` is new in Plan 3 (R46), and it exists because the shadow
authority cannot be built without it.** Spec §3 forbids `server` from depending on
`game`, and `server`'s shadow loop must run `step()` in lockstep with the host —
which means it needs the *identical* `Tuning`, the identical `CharacterStats[]`
and the same six tracks. With that content living in `game`, Plan 4's server
cannot construct a `SimContext` at all, and the only ways out are a second copy of
the tuning table (which drifts, silently, exactly as Q1 says) or a dependency
edge the spec forbids.

It is also no longer "two constants": it is the tuning, eight character
descriptors, eight kart descriptors, six themes and six tracks, wanted by `render`
(themes and descriptors), `game` (all of it) and `server` (tuning, characters,
tracks). A package three others depend on is not ceremony — it is the thing that
stops two of them from copying it. `content` depends only on `sim`, and nothing
depends on `render` or `game`, so the direction spec §3 fixes is unchanged.

**`content` must stay runnable under a plain, non-Vite toolchain**, because
`server` imports it. That single requirement decides how the JSON is loaded —
§3a.1 — and it is the one place R46's move could have bitten.

**`render` does not depend on `@tapkart/net` and does not depend on
`@tapkart/protocol`.** Spec §3 lists only `sim` for it, and the omission is
load-bearing rather than an oversight: if `render` could import `net`, a render
module could reach `ClientLoop.state()` and draw a remote kart from the predicted
state, which spec §5 forbids. Keeping the dependency out makes the forbidden
thing *unreachable* instead of merely discouraged. `render` therefore defines its
own neutral view structs (§4.2) and `game` — which sees both worlds — is the only
place they meet.

**`game` depends on `@tapkart/protocol` (Q13).** Two provable needs, not one:
`RemoteSample.kart` is a `WireKart` (Q5), which every standings and HUD path in
`game` names; and `withLocalInput` (§5.10a) encodes the host's own intent with
the real `encodeInput`/`encodeHeader` codec rather than a second one.

**Nothing depends on `render` or `game`.** `sim`, `protocol` and `net` are
untouched by Plan 3. The three widenings Plan 3 *requires* of `net` (Q4, Q5, Q6)
are **Plan 2's work**, recorded as rulings P2-R8 … P2-R11, and §2.5 states them
as a gate.

`three` is the **first runtime dependency in the repository**, pinned at exactly
`0.180.0` (Q10).

### 1a. What a later plan is explicitly allowed to do to Plan 3's packages (R39)

Stated here so no Plan 5 task stalls asking permission. Spec §3's dependency rule
says nothing may **depend on** `render` or `game`; it says nothing about a later
plan adding an implementation *inside* them, and the three things below do not
invert any arrow:

- **Plan 5 may add files under `packages/render/src/audio/`** — the Web Audio
  implementation of §4.9's `AudioBackend` — **and may add the barrel lines that
  export them.** That is the whole point of authoring the seam now (Q26).
- **`@tapkart/game` may take a dependency on `@tapkart/invite`** (Plan 5's pure,
  zero-dependency invite/NFC/QR package). `invite` depends on nothing, so the
  graph stays acyclic and `game` remains a leaf that nothing depends on.
- **Plan 5 may add an `nfc` field to §5.13's `ShellOptions`.** Adding an optional
  field to an options struct owned by the shell adapter is not a re-signature of
  anything Plan 3 tasks share.

What remains forbidden, in any plan: `render` importing `net` or `protocol`;
anything importing `render` or `game`; and `sim`, `protocol` or `net` acquiring a
DOM type (§10.1).

---

## 2. Signatures Plans 1 and 2 export that Plan 3 consumes

All quoted from real source in `.claude/worktrees/plan2-net/packages/`, read
2026-08-14. Where the draft of this contract quoted something that has since
drifted or never existed, the correction is called out inline.

### 2.1 `@tapkart/sim` — types (`src/types.ts`, whole file)

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
  finishedOrder: number[]       // length MAX_KARTS, -1 in unfilled slots
  heldBotIntent: Intent[]       // always length MAX_KARTS
  heldBotTick: number[]         // always length MAX_KARTS, -1 = no held intent
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

`Tuning.driftTiers` and `driftBoosts` are **mutable** tuples, not `readonly`.
Anything in Plan 3 that passes one to `driftTierFor` must therefore hold it as
`[number, number, number]`, never `readonly [number, number, number]` — a
`readonly` tuple does not assign to a mutable parameter under `strict`, and the
fix is to hold the mutable type, never to cast.

`groundHeight` is, verbatim:

```ts
groundHeight(s, lateral) = splinePointAt(track, locateS(table, s)).y
                         + lateral * Math.tan(bankingAtSeg(track, locateS(table, s)))
```

That identity is what §8.1's mesh test asserts against, to 1e-3 m (Q31).

### 2.2 `@tapkart/sim` — functions and constants Plan 3 calls

Every one of these is exported from the barrel (`packages/sim/src/index.ts`
re-exports all 19 modules) and was checked against its definition.

```ts
// src/state.ts
export function createState(ctx: SimContext, seed: number, characterIdx: number[]): SimState
export function cloneState(src: SimState, dst: SimState): void
export function statesEqual(a: SimState, b: SimState): boolean

// src/step.ts
export function step(ctx: SimContext, prev: SimState, next: SimState,
                     inputs: Intent[], events: AuthEvent[]): void

// src/replay.ts
export function allocStateLike(ctx: SimContext, src: SimState): SimState

// src/phase.ts
export function makeIntentBuffer(): Intent[]           // exactly MAX_KARTS distinct Intents
export const FINISH_GRACE_TICKS = 1800                 // 30 s at 60 Hz

// src/track.ts
export function buildTrackQuery(track: Track): TrackQuery
export function validateTrack(track: Track): string[]  // [] when valid
export function splinePointAt(track: Track, t: number, out: Vec3): void
export function splineTangentAt(track: Track, t: number, out: Vec3): void
export function widthAtSeg(track: Track, t: number): number
export function bankingAtSeg(track: Track, t: number): number
export function surfaceOfSeg(track: Track, t: number): Surface
export interface ArcTable { pts: Float64Array; cum: Float64Array;
                            samplesPerSegment: number; segments: number; total: number }
export function buildArcTable(track: Track): ArcTable
export function locateS(table: ArcTable, s: number): number   // s -> segment parameter t
export function arcAt(table: ArcTable, t: number): number     // t -> metres from the start line
export const SAMPLES_PER_SEGMENT = 64
export const BOOST_PAD_HALF_LENGTH = 4
export const BOUNDS_HALF_WIDTH_MUL = 2

// src/placement.ts
export function computePlacement(state: SimState, outIndexOf: Int32Array,
                                 outOrder: Int32Array): void   // both length MAX_KARTS
export function placementOrder(state: SimState): number[]      // allocates; not for the frame path

// src/items.ts
export function itemBoxWorldPos(ctx: SimContext, boxIdx: number, out: Vec3): void
export const ITEM_BOX_RADIUS = 1.6
export const ITEM_BOOST_TICKS = 90
export const CHARGE_TTL_TICKS = 20

// src/entity.ts
export function kartById(state: SimState, playerId: number): KartState | null
export function surgeActiveOn(state: SimState, playerId: number): boolean

// src/drift.ts
export function driftTierFor(charge: number, tiers: [number, number, number]): number
export const DRIFT_STEER_MIN = 0.35

// src/recovery.ts
export function motionLocked(k: KartState): boolean      // === (k.respawnTicks > 0)
export function steeringLocked(k: KartState): boolean    // === (spinOutTicks > 0 || respawnTicks > 0)
export const SPIN_YAW_RATE = 4 * Math.PI

// src/mathutil.ts
export function clamp(v: number, lo: number, hi: number): number
export function lerp(a: number, b: number, t: number): number
export function wrapAngle(a: number): number

// src/vec3.ts
export function v3(x: number, y: number, z: number): Vec3
export function v3len(a: Vec3): number
```

Four shapes Plan 3 must not misread:

- **`splinePointAt` / `splineTangentAt` / `widthAtSeg` / `bankingAtSeg` /
  `surfaceOfSeg` take `t`, a *segment parameter*, not `s`.** The integer part
  selects the control point; the fraction runs to the next. `TrackQuery` methods
  take `s`, arc-normalised. Mesh generation (§4.3) walks `t` because it wants
  even geometry per segment; everything else uses `s`. Converting between them
  is `t = locateS(table, s)` and `s = arcAt(table, t) / table.total`, and both
  directions are used in §8.1's mesh test. Mixing them silently produces a track
  mesh that does not match the collision surface — the exact failure spec §3 says
  "cannot drift".
- **`driftTierFor` returns `-1 | 0 | 1 | 2`, typed `number`** — `-1` means *no
  mini-turbo pending*, and `0` is a real tier. The draft of this contract
  proposed a `render`-local `driftTierOf` returning `0 | 1 | 2 | 3` with `0`
  meaning "none". That second encoding is **deleted**: two encodings of one fact
  is the defect class this document exists to prevent, and `driftTierFor`
  already takes the tiers explicitly, so `render` needs no `SimContext` and no
  duplicate.
- **`itemBoxWorldPos` writes into `out` and returns `void`**, and it writes
  `out.y = spline.y` — the *centreline* height, **not** `groundHeight(s, lateral)`.
  Item boxes therefore sit at centreline height even on banked track, and pickup
  is plan-view (x/z only). Anything drawing a box uses this function verbatim, so
  the drawn box and the pickup volume are the same object. It calls
  `sampleAt`/`tangentAt` internally, so it invalidates the shared scratch (§0).
- **`computePlacement` reads exactly four things**: `karts[i].playerId`,
  `karts[i].lap.{lap, checkpointIdx, t}`, and `state.finishedOrder`. That is why
  §5.11 can compute placement for a guest by filling a scratch `SimState` with
  wire values and calling the real function, instead of re-implementing the
  comparator.

### 2.3 `@tapkart/protocol` — what Plan 3 names directly

`game` depends on `protocol` (Q13, §1). `render` does not and never names a wire
type.

```ts
// src/types.ts
export const PROTOCOL_VERSION = 1
export type ChannelName = 'unreliable' | 'reliable'
export type MessageKind =
  | 'hello' | 'welcome' | 'lobby' | 'start'
  | 'input' | 'snapshot' | 'events' | 'checkpoint'
  | 'authorityChange' | 'ping' | 'pong'
export const WIRE_TAG: Readonly<Record<MessageKind, number>>   // input 0x10, snapshot 0x11, events 0x12
export interface WireHeader { kind: MessageKind; protocolVersion: number }
export function encodeHeader(out: Uint8Array, kind: MessageKind): number   // returns 2
export function decodeHeader(buf: Uint8Array): WireHeader                  // throws on bad tag/version

export interface WireKart {
  playerId: number; position: Vec3; velocity: Vec3; heading: number
  angularVelocity: number; driftCharge: number; driftActive: boolean
  driftDir: -1 | 0 | 1; airborne: boolean; surface: Surface
  spinOutTicks: number; invulnTicks: number; item: ItemKind
  lap: number; checkpointIdx: number; t: number
  isBot: boolean; connected: boolean
  boostTicks: number; respawnTicks: number; shielded: boolean
}

export interface WireEntity {
  entityId: number; kind: EntityKind; ownerId: number
  position: Vec3; velocity: Vec3; heading: number; ttl: number
}

export interface WireSnapshot {
  tick: number; eventSeq: number
  phase: RacePhase                      // R44, Plan 2 Task 15c: 2 bits, 178 -> 180 bits
  lastProcessedInputTick: number[]      // length MAX_KARTS
  karts: WireKart[]                     // length MAX_KARTS
  entities: WireEntity[]                // length MAX_ENTITIES, live packed at front
  entityCount: number
}

export interface InputDatagram { playerId: number; intents: Intent[] }  // length INPUT_REDUNDANCY

// src/input.ts
export const INPUT_REDUNDANCY = 8
export function encodeInput(out: Uint8Array, playerId: number, intents: Intent[]): number
```

Three facts about `WireKart` that decide Plan 3's design:

1. It carries **no `characterIdx`**. A guest cannot learn from the wire which
   character a remote player picked. §5.10 therefore makes the session's own
   `characterIdx` array the single source for that field, for every role.
2. It carries **no `place`**. Placement is *derived* from `lap`,
   `checkpointIdx` and `t`, which it does carry — see §5.11.
3. `WireSnapshot` carries **no `finishedOrder` and no `itemBoxes`**, and — until
   Plan 2 Task 15c lands R44 — no `phase` either. A guest learns `finishedOrder`
   from the reliable `finish` events `applyEvent` already applies
   (`packages/net/src/apply.ts:73-85` writes `finishedOrder[ev.data - 1]` and
   `finishTick`, and sets `phase = 'finished'` on the `playerId === -1` event
   `updatePhase` emits last). **`phase` becomes a snapshot field** (R44, §2.5),
   because the events path can only ever announce `'finished'` — it cannot tell a
   guest that the race is still counting down, and a guest that assumes
   `'racing'` drives away while the host counts. Item boxes have **no**
   authoritative source at all, in any plan: §7.1 and §15.4 say why that stays
   true on purpose.

### 2.4 `@tapkart/net` — what is shipped today

Read from source. This is the whole public surface of `net` as it exists:

**`ChannelName` comes from `@tapkart/protocol`, not from here.** *Amended 2026-08-15, after
Plan 3 Task 1's gate check failed on it (TS2305) — the only symbol of the 45 that was filed under
the wrong package.* `net/src/transport.ts` `import type`s it and deliberately never re-exports it,
so a Plan 3 module importing `ChannelName` from `@tapkart/net` does not compile. It is the same
type `Transport.send` takes — Task 1 pins that with a mutual-assignability check rather than
trusting the name.

```ts
// src/transport.ts — ChannelName is imported from @tapkart/protocol, not exported from net
export interface Transport {
  send(channel: ChannelName, peerId: string, data: Uint8Array): void
  broadcast(channel: ChannelName, data: Uint8Array): void
  onMessage(cb: (peerId: string, channel: ChannelName, data: Uint8Array) => void): void
  onPeerLost(cb: (peerId: string) => void): void
  peers(): string[]
  close(): void
}

// src/loopback.ts
export interface LoopbackOptions { latencyMs: number; jitterMs: number; lossRate: number; seed: number }
export function makeLoopbackPair(opts: LoopbackOptions):
  { a: Transport; b: Transport; pump(nowMs: number): void }

// src/authority.ts
export class AuthorityLoop {
  constructor(ctx: SimContext, state: SimState, t: Transport)
  tick(): void
  state(): SimState
}

// src/apply.ts
export function applyEvent(ctx: SimContext, state: SimState, ev: AuthEvent): boolean

// src/client.ts
export class ClientLoop {
  constructor(ctx: SimContext, playerId: number, t: Transport)
  tick(localIntent: Intent): void
  corrections(): number
  state(): SimState
}
```

`packages/net/src/index.ts` re-exports **nine** modules: `clock`, `transport`,
`loopback`, `apply`, `authority`, `client`, `shadow`, `local`, `receive` — **35**
runtime names in total (`transport` contributes none; `Transport` is an
interface, erased at compile time). The set is pinned exactly, in both
directions, by `packages/net/test/barrel.test.ts`.

*Amended 2026-08-15: this used to read "four modules... `client` is not in the
barrel yet," describing a mid-Plan-2 barrel that predated Tasks 15b, 15c, 16 and
the final fix pass. Plan 2 is merged to master now; the barrel carries every
module the package ships, and the count above is read off `src/index.ts` and
`test/barrel.test.ts` directly rather than carried forward from an earlier
draft.*

Five behaviours of the shipped code that Plan 3 is built around, each verified
in source rather than inferred:

1. **`AuthorityLoop` has no entry point for its own player's input.** Its
   `heldIntent` is filled only in `onMessage`, from a decoded `InputDatagram`
   arriving on the `'unreliable'` channel with an `'input'` header
   (`authority.ts:108-142`). A host or solo player who never sends themselves a
   datagram is driven by bot AI. §5.10a is the resolution, and it uses only
   public API.
2. **A seat is bot-driven unless `connected` is true.** `resolveInputs`
   (`phase.ts:83`) routes any kart with `k.isBot || !k.connected` through
   `botIntent`, and `createState` builds every seat with `isBot: true,
   connected: false`. Any human seat must be flipped to `isBot: false,
   connected: true` on the authority's state, by `game`. `ClientLoop` already
   does this for its own seat (`client.ts:206-207`).
3. **`AuthorityLoop.tick()` broadcasts unconditionally**, without consulting
   `peers()`: events on the reliable channel whenever `events.length > 0`, and a
   snapshot every `SNAPSHOT_PERIOD_TICKS`. A solo transport must therefore drop
   cheaply rather than queue (§5.10a).
4. **`ClientLoop`'s constructor forces `phase = 'racing'`** on its predicted
   state and builds that state with seed `0` and an all-zero `characterIdx`
   (`client.ts:197-207`). Its own doc comment states the consequence for callers:
   *"any authority paired with a ClientLoop must have its own state.phase set to
   'racing' too, or the authority freezes every kart for COUNTDOWN_TICKS."*
   **R44 retires the forcing** — Task 15c makes `phase` a snapshot field and
   `ClientLoop` adopts it — so §5.10 starts a host in `'countdown'`. The seed and
   `characterIdx` are still the loop's own, which is why `RaceSession.characterIdx`
   is the source for that field (§2.3 fact 1).
5. **`ClientLoop.state()` returns the live predicted state, not a copy**, and
   its other seven seats are the local sim's bot AI. That is the whole reason
   §7.1 exists.
6. **A reconciliation is observable today only as a count.** `corrections()`
   returns how many have happened; nothing exposes *what* one moved, and
   `reconcile` overwrites `predicted` wholesale, so the discontinuity cannot be
   recovered from outside. R41's error smoothing needs exactly that vector and that
   angle, so **R47/R48 add `correctionDeltaOf` to `net`** — §2.5 has the
   signature.

*Amended 2026-08-14 (Plan 2's final fix pass): `ShadowLoop` has since shipped,
and with it a way to read the tick it was promoted at. It is a **free function,
not a member**:*

```ts
// src/shadow.ts
export function promotionTickOf(loop: ShadowLoop): number
```

*`ShadowLoop`'s shape is fixed at constructor / `tick` / `promote` by Plan 2's
own contract §5, so the tick is published over a `WeakMap` exactly as
`droppedDatagramsOf`, `isDemoted`, `remoteInterpolatorOf` and `correctionDeltaOf`
already are. It returns `-1` while the loop is still following — and also for a
loop constructed already leading, which never ran `promote()` — and throws for a
non-`ShadowLoop`, because a silent sentinel for "no record" is indistinguishable
from the real answer.*

***Plan 3 never calls it.*** *It exists for Plan 4's hub, which relays the
`authorityChange` so every peer can recompute `promotionCursor(raceSeed,
promotionTick)` from it. It is recorded here for one reason: an export missing
from the surface this section calls "the whole public surface of `net`" is one a
later reader assumes does not exist, and the next plan that needs it re-derives
it in the wrong package. This section never enumerated `ShadowLoop`'s members, so
there is no member list to extend — the note is the whole amendment. (§2.5's
closing line made the same "does not exist" claim about `ShadowLoop`; it is
corrected to match, in the 2026-08-15 amendment there.)*

### 2.5 What Plan 2 shipped — the `net` surface Plan 3 builds against, verified at merge

**Every item below shipped in Plan 2 and is quoted from the merged source, not
the draft.** Each was required by a ruling (P2-R8 … P2-R11), and this is the
exact shape Plan 3 codes against, read out of `packages/net/src/` on master the
same way §2.4 was. No Plan 3 task may write into `net`.

*Amended 2026-08-15: this section originally opened "None of the following
exists in `packages/net/src/` today," framing every item below as a gate Plan 2
had yet to clear before Plan 3's first import would compile, and closed by
saying `ShadowLoop` did not exist either (§2.4 already half-corrected that
closing line on 2026-08-14, when `ShadowLoop` itself shipped). Plan 2 has since
merged to master. Every symbol below is now shipped, not pending, so the section
is rewritten to say that — the per-symbol shapes are unchanged except where a
correction below is marked.*

```ts
// packages/net/src/clock.ts — Plan 2 Task 15c
/** 1000 / TICK_HZ. Exported (Q6) so nothing else in the repository defines it. */
export const TICK_MS: number

// packages/net/src/client.ts — Plan 2 Task 15/15b
export const REMOTE_INTERP_DELAY_MS = 100
export const REMOTE_BUFFER_CAPACITY = 8
export const REMOTE_EXTRAPOLATE_CAP_MS = 200

export interface RemoteKeyframe {
  recvAtMs: number          // ALWAYS tick * TICK_MS, never a wall clock
  karts: WireKart[]         // length MAX_KARTS, deep-copied out of the decode scratch
  entities: WireEntity[]    // length MAX_ENTITIES, deep-copied; live packed at front  (Q4)
  entityCount: number       // (Q4)
}

/** Q5: the interpolated pose PLUS the authoritative wire record it came from.
 *  A CALLER-OWNED BUFFER, filled in place — see the amendment note below. */
export interface RemoteSample {
  position: { x: number; y: number; z: number }
  heading: number
  kart: WireKart
}

/** Q4's entity counterpart. Same rule for `entity` as for `kart`. */
export interface RemoteEntitySample {
  position: { x: number; y: number; z: number }
  heading: number
  entity: WireEntity
}

/** How a caller allocates its buffers — ONCE, at construction, never per frame.
 *  `kart` / `entity` start as a neutral zeroed placeholder rather than null, so
 *  the interface has no optional field to check on the hot path; the placeholder
 *  is meaningless until the matching sample call has returned true. */
export function makeRemoteSample(): RemoteSample
export function makeRemoteEntitySample(): RemoteEntitySample

export class RemoteInterpolator {
  push(kf: RemoteKeyframe): void
  /** Fills the caller-owned `out` and returns true. `false` — leaving every
   *  field of `out` exactly as it was — when there is nothing to sample, which
   *  today means only "no keyframe has arrived yet". */
  sampleKart(playerId: number, nowMs: number, out: RemoteSample): boolean
  /** Q4: matched on entityId, NEVER on array index. `false`, with `out` left
   *  untouched, once the entity is absent from the newest keyframe (it
   *  despawned, or was never seen). Present in the newest but not the older:
   *  extrapolate from the newest alone, same 200 ms cap. */
  sampleEntity(entityId: number, nowMs: number, out: RemoteEntitySample): boolean
  /** The live entity ids in the NEWEST keyframe, written into `out` (length
   *  MAX_ENTITIES), returning how many were written. Without this, `sampleEntity`
   *  is unusable: entityIds come from a monotonic counter and cannot be probed.
   *  See §15.1. */
  liveEntityIds(out: Int32Array): number
}

export function remoteInterpolatorOf(client: ClientLoop): RemoteInterpolator

/**
 * R47, R48. The discontinuity the last reconciliation applied to the local kart:
 * position delta in metres into `outPos`, heading delta in radians (shortest arc,
 * wrapped to [-PI, PI]) as the return value. Returns null if the most recent
 * tick() applied no correction.
 *
 * `null` rather than a boolean, so "no correction" and "a correction of exactly
 * zero" stay distinguishable at the type level, at the source, instead of being
 * reconstructed a layer up.
 *
 * A free function for the same reason remoteInterpolatorOf is one: ClientLoop's
 * four-member shape is locked by Plan 2 contract §5.
 */
export function correctionDeltaOf(client: ClientLoop, outPos: Vec3): number | null

// packages/net/src/local.ts — Plan 2 Task 15b (R42)
export const LOCAL_PEER_ID = 'local'

export interface LocalInputTransport extends Transport {
  /** Submits `intent` to whatever loop is listening on THIS transport, exactly
   *  as if it had arrived from a peer: encodeHeader(_, 'input') + encodeInput
   *  over an INPUT_REDUNDANCY-long window whose newest slot carries
   *  `intent.tick`,
   *  dispatched to every registered onMessage callback with peerId LOCAL_PEER_ID
   *  and channel 'unreliable'.
   *
   *  Call this every simulation tick. The decorator itself sends on even ticks
   *  for 30 Hz parity with ClientLoop, and latches odd-tick brake, drift and
   *  useItem pulses into the next even-tick datagram.
   *
   *  `intent.tick` MUST be strictly increasing across calls: AuthorityLoop keeps an
   *  intent only when `it.tick > heldIntentTick[playerId]` (authority.ts:131).
   *  Callers stamp it with `state().tick + 1`. */
  submitLocalInput(playerId: number, intent: Intent): void
}

/** Decorates any Transport with submitLocalInput. Everything else delegates to
 *  `inner`; onMessage callbacks are registered with BOTH `inner` and this
 *  wrapper's own list. Allocates its encode buffer once. */
export function withLocalInput(inner: Transport): LocalInputTransport

/** A Transport with no peer on the other end: peers() is [], send/broadcast drop
 *  immediately, onPeerLost never fires, close() is idempotent. */
export function createNullTransport(): Transport

// packages/net/src/index.ts — the barrel; `client` and `local` are two of its
// nine re-exported modules (§2.4).
```

*Amended 2026-08-15: the two module comments above read `client.ts` (for
`TICK_MS`) and `localinput.ts` (for the local-input surface). Shipped source has
`TICK_MS` in `clock.ts` (Task 15c item F moved it there, per §2.4's own
already-amended text) and the local-input surface in `local.ts`, not
`localinput.ts` — that name belongs to `packages/game/src/localinput.ts` (§5.10a),
a different file in a different package. The comments and local-input shape
above are corrected to match shipped Plan 2: `submitLocalInput` takes two
arguments, reads `intent.tick`, owns the 30 Hz cadence, and latches odd-tick
boolean pulses.*

**Why it carries heading too (R48).** `EPS.heading = 0.0025` rad is the threshold
at which a heading correction *fires*, not the size of the correction that
follows: past that threshold `resyncOwnKart` writes the authoritative heading,
whatever the true divergence is. And heading is the channel that dominates error
growth — Task 15's reviewer, deriving it independently from the quantisation
table: *"a sub-epsilon heading error of 0.0024 rad at 20 m/s is 0.048 m/s of
lateral drift, one second to cross"* — roughly three times the position error the
velocity residual produces. A channel that dominates error growth is not one to
leave unsmoothed on the assumption its corrections are small.

**Why the correction delta is `net`'s and not reconstructed (R47).** Plan 3 can
*infer* it as `state().pos - prev.pos - prev.velocity * TICK_DT`, and an earlier
draft of this contract did. But that assumes constant velocity across the tick, so
the residual carries one tick of acceleration — and it degrades exactly when the
kart is accelerating hardest, which is when a correction is most likely and most
visible. `ClientLoop` knows the true value at the instant it applies it. Task 15b
is already amending `client.ts`, so it reports it rather than leaving Plan 3 to
approximate it.

**Why `withLocalInput` is `net`'s and not `game`'s (R42).** `AuthorityLoop` has
no entry point for its own player's input (§2.4 fact 1), so a host or solo player
is bot-driven — a real Plan 2 gap. The fix is a transport decorator, and a
transport decorator is a transport: `net` owns transports, and `server` will want
the same thing the day it drives a seat. `game` composes it (§5.10a) and defines
nothing about it.

Routing the host's own intent through the real `encodeInput` codec is not
ceremony. It gives the host's kart the **identical 8-bit steer / 6-bit accel
quantisation every guest's input crosses**; without it the host drives a
measurably different car from everyone else in the same race, on the same track,
and no test would say so.

```ts
// packages/protocol/src/snapshot.ts + net's two loops — Plan 2 Task 15c (R44)
// WireSnapshot gains `phase: RacePhase`, encoded as 2 bits: 178 -> 180 bits.
// AuthorityLoop writes it from `live.phase`; ClientLoop adopts it on every
// accepted snapshot and NO LONGER forces `predicted.phase = 'racing'` in its
// constructor.
```

**Why `phase` goes on the wire rather than being worked around (R44).** The
reliable `finish` event can only ever announce `'finished'`; nothing tells a guest
the race is still counting down. Without this field a guest starts driving the
instant it connects while the host is still on `COUNTDOWN_TICKS` of frozen inputs
— every snapshot in that window is a guaranteed correction, and the guest gets a
three-second head start. That is a core gameplay defect, not a lobby concern, and
2 bits is the cheapest fix anyone will ever propose for it. **This contract is
written assuming Task 15c has landed**: `createSession` starts a host in
`'countdown'` like the simulation intends (§5.10), and the countdown overlay Q14
puts on the race screen works for every role.

Two properties of `RemoteSample`/`RemoteEntitySample` that Plan 3 depends on and
that a Plan 2 implementation could get wrong without failing its own tests:

- **`kart` / `entity` is the newest keyframe received for this seat, verbatim off
  the wire** — never the older half of the interpolation bracket, and never
  re-derived per branch. One definition, used whether `sampleKart` /
  `sampleEntity` interpolated (`before` and `after` both present) or
  extrapolated (only one — and during extrapolation there is no `after` half to
  read from at all, so a bracket-relative definition cannot survive past the
  first dropped snapshot). **The consequence a renderer must know:**
  `position`/`heading` sample `targetMs = nowMs - REMOTE_INTERP_DELAY_MS`, ~100ms
  *behind* `nowMs`, while `kart` is the newest record *received*, which lands
  close to `nowMs` itself — so `kart` runs roughly 100ms *ahead* of the
  `position`/`heading` returned alongside it. A renderer computing placement
  from `kart.t` is mixing two instants. That is deliberate, and harmless for the
  discrete HUD fields this sample exists to carry (§7.1) — but it must be
  stated, not discovered.
- **`kart` / `entity` is stable until it is evicted from the buffer.** Keyframes
  are deep copies (Plan 2 Task 15's `cloneWireKarts`), so a caller may read
  fields off the returned record after the next `push`. Plan 3 copies every field
  it needs during `ViewBuilder.build` anyway.

*Amended 2026-08-15: the first bullet above previously read "`kart` / `entity`
is the record from the older bracketing keyframe... Discrete state must never
lead the drawn position: a kart whose interpolated position has not yet reached
the line must not already read `lap + 1`." Shipped `sampleKart` / `sampleEntity`
(`client.ts`) assign `out.kart = newest.karts[playerId]` unconditionally — the
newest keyframe in the buffer, not the older bracket half — and the shipped doc
comment on `RemoteSample.kart` says so explicitly: "NOT interpolated and NOT
taken from the older half of the bracket." This was ruled deliberately, not an
oversight: "the newest authoritative record" means the newest keyframe
*received*, which stays well-defined in the extrapolation branch, where there is
no `after` half at all — a bracket-relative reading would make `kart` mean a
different thing depending on which branch ran, and would change meaning the
moment a third keyframe landed. The corrected bullet also states the consequence
the old text got backwards: `kart` runs ~100ms *ahead* of the interpolated
render pose, not behind it, and a contract asserting the opposite of what a
renderer will actually observe is worse than one that says nothing.*

*Amended 2026-08-14 (ruling P2-R29, Plan 2's final fix pass): `sampleKart` and
`sampleEntity` are quoted above in **out-parameter form**, taking a caller-owned
buffer and returning a boolean. They previously returned `RemoteSample | null`
and `RemoteEntitySample | null`. The reason is the one that already made
`liveEntityIds` take an `Int32Array`: **these are per-frame calls.** The
allocating form returned two fresh objects per call — the sample and its
`position` — which at 60 fps across seven remote karts and up to 32 entities is
~4,700 objects/s, half the 9,400/s that was ruled a **contract violation rather
than a preference** when `ClientLoop`'s ring was pooled. The inconsistency was
inside one class: the same object already handed a caller-owned buffer for entity
ids and allocated for every sample.*

*It was changed **now** because Plan 3 has been authored and not executed. Once a
renderer ships against the allocating form, this is a breaking change to a locked
contract in a package Plan 3 is forbidden to edit (§1a); today it is a signature
in a document nobody has compiled against yet.*

*`false` means **no sample** — the buffer is empty, or the entity is gone — and
leaves `out` untouched, which is why a caller must treat `out` as meaningless
after a `false` rather than as "the last good pose". The buffers come from
`makeRemoteSample` / `makeRemoteEntitySample` and are allocated **once, at
construction**; that is the entire point of the change, so any call site that
allocates one inside a loop has reintroduced exactly what this removed:*

```ts
// ONCE, at construction — never in the frame path.
private readonly kartSample: RemoteSample = makeRemoteSample()
private readonly entitySample: RemoteEntitySample = makeRemoteEntitySample()

// Per frame, per seat.
if (session.sampleRemoteKart(playerId, nowMs, this.kartSample)) {
  // this.kartSample.position / .heading / .kart are valid here, and only here.
}
```

*The two factories are new exports of `@tapkart/net` and are part of the gate:
without them a caller has no legal way to make a buffer, since `RemoteSample.kart`
is non-optional and there is nothing neutral to put in it. §5.10, §5.11, §7.1 and
§7.3 are amended to match; §11 counts them against Plan 2.*

**`ShadowLoop` exists too — Plan 2's final fix pass shipped it (§2.4) — and Plan
3 still never constructs one.** It is the server's, and the server is Plan 4.

### 2.6 Test fixtures are still not importable by bare specifier

Plan 2 §6 established this and it binds Plan 3 unchanged: `makeTuning`,
`makeCharacters`, `makeOvalTrack`, `makeStraightTrack`, `makeCircleTrack` and
`makeContext` live in `packages/sim/test/fixtures/track-fixtures.ts`, **outside**
`@tapkart/sim`'s `exports` map. Plan 3's *tests* reach them by relative path
(`'../../../sim/test/fixtures/track-fixtures'`); Plan 3's *`src`* never does, and
`@tapkart/sim`'s exports are **not** widened to publish fixtures.

This matters more in Plan 3 than it did in Plan 2, because Plan 3 is the first
plan that ships a **real** `Tuning` and a **real** `CharacterStats[]` to a player
rather than borrowing the fixture — and Q1 requires the shipped ones to be
numerically identical to the fixture, asserted by a test that imports the fixture
by relative path. See §5.2.

---

## 3. The track JSON shape — measured, not assumed

All six shipped files were parsed on 2026-08-14. **The on-disk JSON is exactly
`Track` from `@tapkart/sim`: no extra keys, no missing keys, at every level.**
Top-level keys, in file order, for all six: `id`, `name`, `controlPoints`,
`checkpointS`, `itemBoxes`, `ramps`, `boostPads`, `startPositions`, `bounds`.
Object keys within the arrays are exactly `position,width,banking,surface` /
`s,lateral` / `sStart,sEnd,launch` / `s,lateral,halfWidth` / `s,lateral`.

```json
{
  "id": "neon-district",
  "name": "Neon District",
  "controlPoints": [
    { "position": { "x": 187.5, "y": 0, "z": 108.253 },
      "width": 18, "banking": 0, "surface": "tarmac" }
  ],
  "checkpointS": [ 0, 0.083 ],
  "itemBoxes":   [ { "s": 0.12, "lateral": -6 } ],
  "ramps":       [ { "sStart": 0.31, "sEnd": 0.35, "launch": 6 } ],
  "boostPads":   [ { "s": 0.58, "lateral": 0, "halfWidth": 3 } ],
  "startPositions": [ { "s": 0.99, "lateral": -5 } ],
  "bounds": { "min": { "x": -300, "y": -30, "z": -300 },
              "max": { "x":  300, "y":  30, "z":  300 } }
}
```

Measured, per file — these are the real numbers a mesh builder must handle:

| Track | ctrl pts | checkpoints | item boxes | ramps | boost pads | starts | surfaces present | width (m) | banking (rad) | ctrl-pt y (m) |
|---|---|---|---|---|---|---|---|---|---|---|
| `caldera` | 48 | 12 | 16 | 3 | 2 | 8 | tarmac, dirt | 15 – 19 | **−0.35 – 0.35** | −9 – 9 |
| `dust-canyon` | 52 | 12 | 16 | 2 | 4 | 8 | tarmac, dirt | 15 – 20 | −0.25 – 0.25 | −8 – 6 |
| `glacier-pass` | 47 | 12 | 30 | 2 | 5 | 8 | tarmac | 21 – 26 | 0 – 0.25 | −9 – 5 |
| `harbor-run` | 46 | 10 | 25 | 1 | 2 | 8 | tarmac | 21 – 24 | −0.14 – 0.14 | 0 – 4 |
| `neon-district` | 54 | 12 | 20 | **0** | 4 | 8 | tarmac | 18 – 22 | 0 – 0.22 | 0 – 0 |
| `redwood-rise` | 72 | 10 | 24 | 1 | 5 | 8 | tarmac, dirt | 19 – 24 | 0 – 0.15 | 0 – 22 |

Facts that bind the mesh builder:

- **`ramps` can be empty** (`neon-district`). A builder that assumes ≥ 1 ramp
  segment produces a zero-length buffer, not an error.
- **`banking` is signed.** It runs to ±0.35 rad (20°) on `caldera`. A builder
  that assumes non-negative banking rolls half of `caldera`'s corners the wrong
  way, and the mesh-vs-`groundHeight` test (§8.1) is what catches it: that
  identity has `+ lateral * tan(banking)` in it, sign included.
- Only two of the four `Surface` values ever appear in control-point data:
  `tarmac` and `dirt`. `boost` is **derived** by `TrackQuery.surfaceAt` from
  `boostPads`, and `offtrack` from `|lateral| > width/2`. A mesh builder that
  colours segments by `controlPoints[i].surface` will never draw a boost pad;
  boost pads are their own geometry pass driven by `track.boostPads`.
- `width` varies per control point (15 – 26 m across the six) and is **linear
  across a segment** (`widthAtSeg`). `banking` likewise, in radians.
- `y` is non-zero on real tracks (`redwood-rise` climbs 0 → 22 m; `caldera` runs
  −9 → 9). The ribbon is 3D; a flat-plane assumption is wrong.
- `bounds` is **much larger than the ribbon** and is **not symmetric** — e.g.
  `glacier-pass` is x −82 … 722, `redwood-rise` is x −187.529 … 687.529. It is
  also not used by `sim` for containment at all (`isInBounds` uses
  `width * BOUNDS_HALF_WIDTH_MUL`); `validateTrack`'s only bounds check is that
  it encloses the control points (`track.ts:169-183`). Q19 rules it a **render
  extent**: ground-plane size, camera far clamp, skybox scale. The clearance
  between the extreme control point and the bounds is ~60 m on every shipped
  track, which is what makes §4.3's `meshBounds ⊂ track.bounds` assertion a real
  test rather than a tautology.
- Track ids are stable, lowercase, hyphenated, and equal the filename stem. §5.3
  uses exactly that as the manifest key.
- Every track declares exactly 8 `startPositions`, so `createState`'s "reuse the
  last one" fallback never fires on shipped content.

`content/tracks-pool/` holds 12 further candidate tracks in the same shape plus a
README. They are **not** shipped content; v1 is the 6 in `content/tracks/`
(spec §1): §3a.1's static imports name the six in `content/tracks/` and nothing
from the pool.

---

## 3a. `packages/content` — the shipped data, and the only package three others share

New in Plan 3 (R46). Pure, DOM-free, `three`-free, bundler-free. It owns the
schema, the parsers, and the data itself; it owns no geometry and no rendering.
The split that keeps it honest: **`content` is data + schema + parsers; `render`
turns that data into triangles.**

### 3a.1 How the JSON gets in — static imports, not `import.meta.glob`

Q12's ruling stands in substance: the shipped content is **bundled, not fetched**,
and `loadTrack` is **synchronous and total**. Only the mechanism changes, and it
changes because of R46.

`import.meta.glob` is a Vite transform. `packages/server` will import
`@tapkart/content` under a plain Node/tsx/esbuild toolchain (spec §9: "Server runs
Node"), where `import.meta.glob` is not a function, is not polyfillable, and fails
at runtime rather than at build. Keeping the glob would force a Vite build step
onto the server purely to read six JSON files.

So `content` uses **explicit static imports** — 28 of them, all known at author
time:

```ts
import calderaJson from '../../../content/tracks/caldera.json' with { type: 'json' }
```

That form works in Vite, in vitest, in esbuild/tsx and in Node ESM, needs no
bundler feature, and is statically analysable by all of them. `packages/content`'s
own `tsconfig.json` sets `"resolveJsonModule": true` (§10.1); no other package
needs it, and `tsconfig.base.json` is untouched.

The cost is that adding a seventh track means adding one import line and one table
entry rather than dropping a file in a directory. That is the right trade for a
fixed v1 content set (spec §1: six tracks, eight characters, eight karts), and the
§8.1 test that reads `content/tracks/` with `node:fs` and asserts the manifest
matches the directory catches a forgotten line immediately.

**Q34 is unaffected:** tests still read the real files from disk with `node:fs`,
which is what makes them evidence about shipped content rather than about a
bundler.

### 3a.2 `src/tuning.ts` — the shipped tuning table (Q1, moved by R46)

```ts
/** The Tuning the game actually races with — and the one the shadow authority
 *  runs step() with, which is why this is not in `game`. */
export const TUNING: Readonly<Tuning>

/** The eight shipped characters' handling stats. Same index space as
 *  CHARACTER_DESCRIPTORS, KART_DESCRIPTORS and KartState.characterIdx. */
export const CHARACTERS: readonly CharacterStats[]
```

Q1's substance is unchanged and travels with the move:

> **`TUNING` must be numerically identical to `makeTuning()`, and a test asserts
> it field-by-field.** Same rule for `CHARACTERS` against `makeCharacters()` —
> **all four** stat fields (`speed`, `accel`, `handling`, `weight`), plus `id` and
> `name`.

The test now lives in `packages/content/test/` and imports the fixture by relative
path (§2.6). It is not optional: Plan 1 shipped 477 tests and a golden replay
fixture, and if the shipped tuning diverges by one number, all 477 describe physics
no player ever experiences and the golden replay stops being evidence about the
game. *If a tuning value should change, it changes in both places in one commit,
and the golden replay is regenerated.* That friction is the point.

The values, transcribed so a task can write the module without opening the fixture
and a reviewer can check both against a third copy:

```ts
maxSpeed: 40, accelRate: 24, brakeRate: 48, steerRateBase: 2.6,
steerSpeedFalloff: 0.55, gripTarmac: 14, gripDirt: 5, gripDrift: 3,
gravity: 30, airYaw: 0.6, offtrackSpeedMul: 0.55, respawnTicks: 72,
invulnTicks: 90, spinOutTicks: 60, driftMinSpeed: 8,
driftTiers: [40, 90, 150], driftBoosts: [24, 42, 66],
boostSpeedMul: 1.35, surgeSpeedMul: 0.7, kartRadius: 0.9,
kartRestitution: 0.4, itemBoxRespawnTicks: 180, seekerSpeed: 55,
boltSpeed: 65, entityTtl: 600
```

`CHARACTERS[i]` is `{ id: 'c' + i, name: 'Racer ' + i, speed: speed[i],
accel: accel[i], handling: handling[i], weight: weight[i] }` with
`speed = [1.0, 1.1, 0.92, 1.05, 0.95, 1.15, 0.88, 1.0]`,
`accel = [1.0, 0.85, 1.15, 0.9, 1.1, 0.8, 1.2, 1.0]`,
`handling = [1.0, 0.9, 1.1, 0.95, 1.05, 0.85, 1.15, 1.0]`,
`weight = [1.0, 1.2, 0.85, 1.1, 0.9, 1.3, 0.8, 1.0]`.

**`CharacterStats.name` is never displayed.** It is `'Racer 3'`, because Q1
requires equality with the fixture and Q2 gives the displayed name to the
DeepSeek-authored `CharacterDescriptor`. Every screen shows
`CHARACTER_DESCRIPTORS[i].name`, and nothing joins the two arrays by `id` (§3a.3).

### 3a.3 `src/descriptors.ts` — the character and kart schema and parsers (Q2)

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

Spec §3: "parametric low-poly meshes built in `render` from JSON descriptors.
Eight characters is eight JSON files, not eight modeled assets." The *meshes* are
`render`'s (§4.4); the *descriptors* are content's.

**The descriptor files are Q2's DeepSeek delegation and are a Plan 3 task**,
authored against this schema, which is locked *before* the batch runs. That task
ships a **gate script built from the real shipped code** — esbuild-bundled entry
points importing the actual `parseCharacterDescriptor`, `parseKartDescriptor` and
`parseTrackTheme` — and rejects any record the game itself would reject. A gate
that re-implements validation tests the gate. The same batch carries Q3's six
themes (§3a.4): 22 records, one instruction, one warm prompt cache.

**Balance is not delegated.** DeepSeek writes names, palettes and silhouette
parameters. The stats come from `makeCharacters()` (§3a.2), so no model invents
game balance.

**`CharacterDescriptor` is not `CharacterStats`.** `CharacterStats` is handling;
`CharacterDescriptor` is appearance. They are joined **only by array index**
(`KartState.characterIdx`), never by `id` — the two `id` spaces are unrelated.
Both arrays are length 8 and in the same order, and a test asserts exactly that.
**`KART_DESCRIPTORS[i]` is the kart of `CHARACTER_DESCRIPTORS[i]`**: v1 has no
separate kart selection, so `characterIdx` indexes both.

### 3a.4 `src/theme.ts` — per-track palettes (Q3) and edge-marker parameters (Q20)

```ts
/** Q20: the edge markers are gameplay, not decoration — they are the speed and
 *  corner cue a bare ribbon on a flat plane does not give. Parameters live on
 *  the theme so they are content, not code. */
export interface EdgeMarkerParams {
  spacing: number              // metres along the centreline between posts, 4 – 40
  height: number               // metres, 0.3 – 2.0
  offset: number               // metres outboard of width/2, 0 – 3
  colors: readonly [PaletteRGB, PaletteRGB]   // alternating, colorIdx 0 and 1
}

export interface TrackTheme {
  trackId: string              // equals the Track.id it themes
  road: PaletteRGB
  roadDirt: PaletteRGB
  shoulder: PaletteRGB
  wall: PaletteRGB
  ground: PaletteRGB
  sky: { top: PaletteRGB; bottom: PaletteRGB }
  fog: { color: PaletteRGB; near: number; far: number }   // metres; near < far
  sunDirection: Vec3           // normalised; parse throws if |v| is not 1 ± 1e-6
  ambient: number              // 0..1
  edgeMarkers: EdgeMarkerParams
}

/** A neutral grey theme with legible edge markers: what a track with no theme
 *  file falls back to. */
export const DEFAULT_TRACK_THEME: Readonly<TrackTheme>

/** Throws with a field-listing message on any shape violation. */
export function parseTrackTheme(json: unknown): TrackTheme
```

The three scenery-named tracks stay scenery-free in v1 (Q20): no props, no
buildings, no crowd. The names describe their palette.

### 3a.5 `src/tracks.ts` — track loading, synchronous and total (Q12)

```ts
export interface TrackManifestEntry { id: string; name: string }

/** The six shipped tracks (spec §1) in MENU ORDER, which is `id` ascending:
 *  caldera, dust-canyon, glacier-pass, harbor-run, neon-district, redwood-rise.
 *  Derived from the imported modules' own `id` and `name`, never hand-written, so
 *  it cannot drift from what actually shipped. */
export const TRACK_MANIFEST: readonly TrackManifestEntry[]

/** Shape-checks, then runs validateTrack. Throws with every validator message
 *  joined by '; ', never returns a half-valid Track. */
export function parseTrack(json: unknown): Track

export interface LoadedTrack { track: Track; query: TrackQuery; theme: TrackTheme }

/** TOTAL over TRACK_MANIFEST ids. Builds the TrackQuery (arc table) and resolves
 *  the theme (DEFAULT_TRACK_THEME when unthemed). Throws only on an unknown id,
 *  which is a programming error, not a runtime condition. Memoises, so the arc
 *  table is built once per track per process. */
export function loadTrack(id: string): LoadedTrack
```

### 3a.6 `src/bundle.ts` — everything a race needs in one struct

```ts
export interface ContentBundle {
  characters: readonly CharacterDescriptor[]    // length 8, index === characterIdx
  karts: readonly KartDescriptor[]              // length 8, same index space
  themes: Readonly<Record<string, TrackTheme>>  // keyed by track id
}

/** Parses every bundled descriptor and theme through §3a.3/§3a.4's parsers on
 *  first call and memoises. A malformed shipped file therefore throws at startup,
 *  loudly, rather than producing a half-populated bundle. */
export function loadContentBundle(): ContentBundle
```

Ordering is by `id` ascending within `characters` and `karts`, and the delegation
task's gate asserts the eight character ids and the eight kart ids sort into the
intended pairing, because index — not id — is the join (§3a.3).

### 3a.7 `src/index.ts` — the barrel

Re-exports `tuning`, `descriptors`, `theme`, `tracks`, `bundle`. As in the other
packages, a test asserts that no two re-exported modules export the same name.

---

## 4. `packages/render` — module map and exact signatures

Zero DOM, zero GPU, zero clock, zero `three` in everything below except §4.10's
second half.

### 4.1 There is no `render/src/time.ts` — the tick/millisecond bridge lives in `game`

Q6 rules that `@tapkart/net` exports `TICK_MS` and that Plan 3 imports it and
never redefines it. **`render` cannot import it**, because `render` does not
depend on `net` and §1 explains why that omission is load-bearing.

Both rules are kept by putting the bridge on the only side that can hold it:

- `TICK_MS` is imported from `@tapkart/net` by **`packages/game/src/clock.ts`**,
  and by nothing else in the repository (§5.1).
- `renderNowMs(tick, alpha)` lives there too, and `ViewBuilder` calls it
  internally so no caller can pass anything else (§6.3).
- `render` never names milliseconds-per-tick at all. The one place it needs
  tick-to-seconds — `formatRaceClock` — uses `TICK_DT` from `@tapkart/sim`,
  which is a different constant with a different name and cannot be confused
  with `TICK_MS`.

This section number is kept (rather than renumbering §4.2 – §4.11) so the
rulings document's section references still land.

### 4.2 `src/types.ts` — the view structs (the whole `game` → `render` handoff)

`render` is handed views, never `SimState`. This is what makes spec §5's "remote
karts render from the interpolated buffer, never from prediction" a structural
fact rather than a discipline.

```ts
/** The session's role, named once, in the lowest package that needs it.
 *  `game` imports this type rather than declaring a second union: one vocabulary,
 *  one place. There is no `SessionRole`. */
export type ViewRole = 'host' | 'guest' | 'solo'

/** Where a seat's transform came from. §7.1 is the full rule and
 *  `viewSourceViolations` is its executable form. */
export type ViewSource = 'authoritative' | 'predicted' | 'interpolated' | 'absent'

export interface KartView {
  playerId: number
  characterIdx: number         // from the session, never from the wire (§2.3)
  source: ViewSource
  position: Vec3               // metres, world
  heading: number              // radians, wrapped to (-π, π]
  velocity: Vec3               // m/s
  angularVelocity: number      // rad/s
  speed: number                // m/s, PLAN VIEW: hypot(velocity.x, velocity.z)
  s: number                    // arc-normalised [0, 1), reconstructed — §5.11
  bankAngle: number            // radians, track banking under the kart
  driftActive: boolean
  driftDir: -1 | 0 | 1
  driftCharge: number          // ticks
  driftTier: number            // sim's encoding: -1 none, 0..2 index into driftBoosts
  airborne: boolean
  surface: Surface
  spinOutTicks: number
  invulnTicks: number
  boostTicks: number
  respawnTicks: number
  shielded: boolean
  item: ItemKind
  lap: number                  // 0-based, exactly KartState.lap.lap
  checkpointIdx: number
  t: number
  place: number                // 0-based; 0 = leader
  isBot: boolean
  connected: boolean
}

export interface EntityView {
  entityId: number             // -1 in an unused slot
  kind: EntityKind
  ownerId: number
  source: ViewSource
  position: Vec3
  velocity: Vec3
  heading: number
  ttl: number                  // ticks
}

/** No `source` field, deliberately: item boxes have no authoritative wire form
 *  at all (§2.3), so there is nothing for §7.1 to police. Availability is
 *  `respawnTicks === 0` and is never stored twice. */
export interface ItemBoxView {
  boxIdx: number
  position: Vec3               // from itemBoxWorldPos, verbatim
  respawnTicks: number
}

export interface RaceView {
  tick: number
  alpha: number                // sub-tick fraction, [0, 1)
  phase: RacePhase
  localPlayerId: number        // -1 for a spectator or a replay; never -1 for a guest
  raceStartTick: number        // the tick the race clock starts from — §5.10
  karts: KartView[]            // always length MAX_KARTS, indexed BY SEAT: karts[i].playerId === i
  entities: EntityView[]       // always length MAX_ENTITIES, live packed at front
  entityCount: number
  itemBoxes: ItemBoxView[]     // length = ctx.track.itemBoxes.length
  itemBoxRespawnTicks: number  // ctx.tuning.itemBoxRespawnTicks — Q29's denominator
  finishedOrder: number[]      // length MAX_KARTS, -1 in unfilled slots
  finishTick: number           // -1 until the first kart finishes
  countdownTicksLeft: number   // 0 once racing
}

/** Allocates one fully-populated RaceView with every array at its fixed length
 *  and every Vec3 distinct. Called once per session, never per frame. */
export function createRaceView(itemBoxCount: number): RaceView

/** [] when the view obeys §7.1; otherwise one string per violating seat or slot,
 *  in the exact format §7.1 specifies. Exported (not test-only) because the CI
 *  honesty test and the dev-build assertion (Q32) must run the same code. */
export function viewSourceViolations(view: RaceView, role: ViewRole): string[]
```

**`karts` is indexed by seat, not by placement.** `view.karts[3]` is always
player 3. Anything wanting standings order reads `place`, or sorts a copy.

### 4.3 `src/mesh.ts` — track geometry, pure

`EdgeMarkerParams` and `TrackTheme` are `@tapkart/content` types (§3a.4),
imported here as types; `Track` and `TrackQuery` are `@tapkart/sim`'s. This module
parses nothing and owns no data.

```ts
/** Plain, backend-agnostic geometry. 32-bit indices, so one MeshData per pass
 *  regardless of vertex count. */
export interface MeshData {
  positions: Float32Array      // xyz triples, metres, world space
  normals: Float32Array        // xyz triples, unit length
  uvs: Float32Array            // uv pairs
  colors: Float32Array         // rgb triples, linear 0..1
  indices: Uint32Array         // triangle list, CCW front-facing
}

export interface MeshBuildOptions {
  ringsPerSegment: number      // longitudinal subdivisions per control-point segment
  lateralSteps: number         // cross-section subdivisions across the full width
  shoulderWidth: number        // metres of run-off geometry beyond width/2, each side
  wallHeight: number           // metres; 0 disables the wall pass
}

/** ringsPerSegment 8, lateralSteps 6, shoulderWidth 6, wallHeight 0.
 *  Stated numerically so two tasks cannot disagree about what "default" means. */
export const DEFAULT_MESH_OPTIONS: Readonly<MeshBuildOptions>

/** The road ribbon: centreline + width profile + banking, evaluated on the same
 *  spline `sim` derives ground height from. SOLE OWNER of road geometry. */
export function buildTrackMesh(track: Track, opts: MeshBuildOptions): MeshData

/** Boost-pad quads, driven by `track.boostPads` and BOOST_PAD_HALF_LENGTH — NOT
 *  by control-point `surface`, which never carries 'boost' (§3). One quad per
 *  pad, sitting ROAD_DECAL_LIFT above the road surface. */
export function buildBoostPadMesh(track: Track, query: TrackQuery): MeshData

/** Ramp geometry from `track.ramps`. Empty `ramps` yields a MeshData whose five
 *  arrays are all zero-length, never a throw (`neon-district` has none). */
export function buildRampMesh(track: Track, query: TrackQuery, opts: MeshBuildOptions): MeshData

/** Metres a decal (boost pad, start line, checkpoint gate footprint) is lifted
 *  off the road to avoid z-fighting. */
export const ROAD_DECAL_LIFT = 0.02

/** Start/finish line and per-checkpoint gate placements, in world space.
 *  `s` is the checkpoint's own `track.checkpointS[i]`; index 0 is the finish line. */
export interface MarkerPlacement { s: number; position: Vec3; heading: number; width: number }
export function buildCheckpointMarkers(track: Track, query: TrackQuery): MarkerPlacement[]

/** Q20's procedural edge markers: posts along both track edges, alternating
 *  colours, generated from the existing spline plus the theme's parameters.
 *  `side` is -1 for the left edge and +1 for the right (in the `right =
 *  (-t.z, 0, t.x)` sense, so +1 is +lateral). `colorIdx` alternates 0,1,0,1…
 *  along each edge INDEPENDENTLY, starting at 0 at s = 0. Post positions sit at
 *  `lateral = side * (width/2 + params.offset)` with
 *  `y = query.groundHeight(s, lateral)`. */
export interface EdgeMarkerPlacement {
  s: number
  position: Vec3
  heading: number              // the centreline tangent's heading at that s
  side: -1 | 1
  colorIdx: 0 | 1
}
export function buildEdgeMarkers(track: Track, query: TrackQuery,
                                 params: EdgeMarkerParams): EdgeMarkerPlacement[]

/** Everything the backend needs for one track, built once per race. */
export interface TrackScene {
  road: MeshData
  boostPads: MeshData
  ramps: MeshData
  checkpoints: MarkerPlacement[]
  edgeMarkers: EdgeMarkerPlacement[]
  bounds: { min: Vec3; max: Vec3 }      // meshBounds(road), NOT track.bounds
}
export function buildTrackScene(track: Track, query: TrackQuery, theme: TrackTheme,
                                opts: MeshBuildOptions): TrackScene

/** Axis-aligned bounds of a MeshData. Pure; used by camera framing and by the
 *  §8.1 test that asserts the generated ribbon sits inside `track.bounds`.
 *  An empty MeshData returns min = +Infinity, max = -Infinity in every axis. */
export function meshBounds(mesh: MeshData): { min: Vec3; max: Vec3 }

/** Sums vertex and triangle counts across a set. Test-facing, but exported
 *  because the adapter also reports it through RendererStats. */
export function meshCounts(meshes: readonly MeshData[]): { vertices: number; triangles: number }
```

**Sole writer:** `buildTrackMesh` is the only producer of road-surface geometry.
Nothing else emits triangles for the drivable surface, in any module, ever. This
is what spec §3's "the collision surface cannot drift from what the player sees"
reduces to in code, and it is assertable — §8.1's first row, at 1e-3 m (Q31).

**Vertex layout, pinned** so the mesh test and the mesh builder agree on what to
sample: `buildTrackMesh` emits `controlPoints.length * ringsPerSegment` rings,
ring `r` at segment parameter `t = r / ringsPerSegment`, each ring holding
`lateralSteps + 1` vertices from `lateral = -(width/2 + shoulderWidth)` to
`+(width/2 + shoulderWidth)` inclusive, evenly spaced. The ribbon is closed: the
last ring connects back to ring 0. Vertex index is `ring * (lateralSteps + 1) +
step`, and that index arithmetic is what the test inverts to recover
`(s, lateral)` for each vertex.

### 4.4 `src/descriptors.ts` — descriptor meshes, pure

The descriptor **types and parsers** moved to `@tapkart/content` (§3a.3) with
R46, because `content` is the package that ships and validates the JSON. What
stays in `render` is the half that makes triangles:

```ts
import type { CharacterDescriptor, KartDescriptor } from '@tapkart/content'

/** Deterministic parametric mesh from a descriptor. Same descriptor in, byte-identical
 *  MeshData out — no randomness, no clock, no allocation policy. */
export function buildCharacterMesh(desc: CharacterDescriptor): MeshData
export function buildKartMesh(desc: KartDescriptor): MeshData
```

Spec §3: "parametric low-poly meshes built in `render` from JSON descriptors.
Eight characters is eight JSON files, not eight modeled assets." The eight files
are Q2's DeepSeek delegation and are a Plan 3 task, gated against the real
parsers — §3a.3 has the schema and the gate rule.

`PaletteRGB` is a `@tapkart/content` export (§3a.3) and `render` imports it; it is
not redefined here, so a palette is one type across all four packages.

### 4.5 `src/theme.ts` does not exist — `TrackTheme` is content

R46 moves `TrackTheme`, `EdgeMarkerParams`, `DEFAULT_TRACK_THEME` and
`parseTrackTheme` into `@tapkart/content` (§3a.4). `render` imports the type and
consumes it in `buildTrackScene`, `buildEdgeMarkers` and `buildRenderFrame`; it
parses nothing and ships no palette of its own.

The section number is kept so the rulings' references still land. Q3's six themes
and Q20's edge-marker parameters are unchanged in substance — only their home
moved, and it moved because `server` may not depend on `game` and `render` may
not be the thing a server imports either.

### 4.6 `src/camera.ts` — pure, tick-driven, no wall clock

```ts
export type CameraMode = 'chase' | 'countdown' | 'results' | 'free'

export interface CameraParams {
  distance: number            // metres behind the kart
  height: number              // metres above the kart
  lookAhead: number           // metres ahead of the kart for the look target
  positionLerpPerTick: number // 0..1, applied once per sim tick
  headingLerpPerTick: number  // 0..1, applied once per sim tick, shortest arc
  fovDegrees: number
  fovBoostDegrees: number     // ADDITIONAL degrees at full boost, blended by boostTicks
  near: number                // metres
  far: number                 // metres
}
/** distance 7, height 3, lookAhead 8, positionLerpPerTick 0.18,
 *  headingLerpPerTick 0.22, fovDegrees 62, fovBoostDegrees 8, near 0.3, far 900. */
export const DEFAULT_CAMERA_PARAMS: Readonly<CameraParams>

export interface CameraState {
  position: Vec3
  lookAt: Vec3
  up: Vec3                    // (0, 1, 0) in every v1 mode; a field, not a constant,
                              // so the adapter never invents one
  fovDegrees: number
  mode: CameraMode
}
export function createCameraState(): CameraState

/** Advances `cam` by exactly `ticks` sim ticks toward the pose implied by
 *  `target`. `ticks` may be 0 (a render frame with no sim tick), in which case
 *  nothing changes. Deterministic: same (cam, target, params, mode, ticks) in,
 *  same cam out. SOLE WRITER of every CameraState field. */
export function updateCamera(cam: CameraState, target: KartView, params: CameraParams,
                             mode: CameraMode, ticks: number): void
```

Smoothing is **per tick, not per frame**. A frame-rate-dependent lerp makes the
camera behave differently on a 60 Hz phone and a 144 Hz desktop and cannot be
asserted in CI at all. `updateCamera` applies its lerp `ticks` times (or the
algebraically identical `1 - (1 - k) ** ticks`), which is what makes §8.1's "N
calls with 1 tick equal 1 call with N ticks" assertion true.

`fovDegrees` is `params.fovDegrees + params.fovBoostDegrees *
clamp(target.boostTicks / ITEM_BOOST_TICKS, 0, 1)`, set directly rather than
smoothed, so the boost kick is instant.

### 4.7 `src/frame.ts` — the pure frame description

```ts
export interface KartDraw {
  playerId: number
  characterIdx: number
  visible: boolean
  position: Vec3
  heading: number             // radians — COPIED from KartView, never modified
  roll: number                // radians: bankAngle + drift lean + spin-out tilt
  wheelSpin: number           // radians, accumulated per SIM TICK, wrapped
  steerAngle: number          // radians, front wheels
  bodyTint: PaletteRGB
  alpha: number               // 0..1; invulnerability flickers this
  driftSparkTier: number      // sim's encoding, copied from KartView.driftTier
  boostFlame: number          // 0..1
  shieldVisible: boolean
}

export interface EntityDraw {
  entityId: number
  kind: EntityKind
  visible: boolean
  position: Vec3
  heading: number
  scale: number               // metres; the adapter's unit sphere/box is scaled by this
  tint: PaletteRGB
  alpha: number               // 0..1
}

export interface RenderFrame {
  camera: CameraState
  karts: KartDraw[]           // length MAX_KARTS
  entities: EntityDraw[]      // length MAX_ENTITIES
  entityCount: number
  itemBoxAlpha: Float32Array  // length = itemBoxes.length; Q29
  screenFlash: number         // 0..1, charge blast
  screenTintColor: PaletteRGB
  screenTintAmount: number    // 0..1, surge slow
  /** The view tick this frame's accumulators were last advanced to. The ONLY
   *  field of `out` that buildRenderFrame reads. */
  sourceTick: number
}
/** Every field zeroed, every Vec3 distinct, `sourceTick = 0`, `itemBoxAlpha`
 *  filled with 1. */
export function createRenderFrame(itemBoxCount: number): RenderFrame

/** THE pure function of this package. (RaceView, CameraState, TrackTheme,
 *  descriptors) -> RenderFrame. No clock, no DOM, no allocation, no randomness.
 *  SOLE WRITER of every RenderFrame field.
 *
 *  It reads exactly two things out of `out`: `out.sourceTick` and
 *  `out.karts[i].wheelSpin`. Every other field of `out` is write-only. That is
 *  what makes wheel rotation frame-rate independent while keeping the function
 *  a deterministic function of (inputs, prior accumulator).
 *
 *  `characters` and `karts` are both length 8, indexed by characterIdx (§4.4). */
export function buildRenderFrame(view: RaceView, cam: CameraState, theme: TrackTheme,
                                 characters: readonly CharacterDescriptor[],
                                 karts: readonly KartDescriptor[],
                                 out: RenderFrame): void

/** Q28's bubble reconstruction, exported so the frame builder and its test call
 *  one function. `out = ownerPosition + (cos h, 0, sin h) * BUBBLE_ORBIT_RADIUS_M`,
 *  with `out.y = ownerPosition.y` — the exact formula sim uses. */
export function bubblePosition(ownerPosition: Vec3, heading: number, out: Vec3): void

/** True when a live surge field cast by a kart PLACED BEHIND `playerId` is
 *  slowing it. Derived from the view alone (entity kind + ownerId + KartView.place)
 *  so it works identically on a guest, where `state()` cannot be consulted.
 *  Mirrors `surgeActiveOn` in @tapkart/sim, and a test asserts they agree. */
export function surgeAffects(view: RaceView, playerId: number): boolean
```

Every constant `buildRenderFrame` uses, named and exported, because a task that
invents its own is a task whose output the golden frame (§9.2) cannot describe:

```ts
/** sim's BUBBLE_ORBIT_RADIUS, which is module-private in packages/sim/src/entity.ts:12.
 *  It is declared here rather than imported because `render` may not widen sim's
 *  exports, and it is protected from drift by a REQUIRED test that re-derives it
 *  from real sim behaviour (§8.1). Do not change one without the other. */
export const BUBBLE_ORBIT_RADIUS_M = 2.0

export const KART_DRIFT_LEAN_RADIANS = 0.22      // roll added while drifting, times driftDir
export const KART_SPINOUT_ROLL_RADIANS = 0.15    // roll added while spinOutTicks > 0
export const KART_STEER_VISUAL_MAX_RADIANS = 0.5 // front-wheel deflection at full lock
export const KART_STEER_VISUAL_YAW_RATE = 2.6    // rad/s of angularVelocity that reads as full lock
export const INVULN_FLICKER_PERIOD_TICKS = 8     // 7.5 Hz at 60 Hz
export const INVULN_FLICKER_ALPHA = 0.35
export const SURGE_TINT: PaletteRGB = [0.35, 0.15, 0.55]
export const SURGE_TINT_AMOUNT = 0.28
export const CHARGE_FLASH_RADIUS_M = 20
export const ENTITY_SCALE: Readonly<Record<EntityKind, number>>  // metres, per kind
```

Every derived field, stated as an expression so two tasks cannot disagree. `k`
is `view.karts[i]`, `dt = max(0, view.tick - out.sourceTick)`:

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

Three of those rows are load-bearing enough to justify themselves:

**`heading` is copied, never modified, and there is no `spinAngle`.** The draft
of this contract had a `spinAngle` field for "extra yaw applied while spun out".
`sim` already spins the kart: `updateRecovery` writes `k.heading =
wrapAngle(k.heading + SPIN_YAW_RATE * TICK_DT)` every tick of a spin-out
(`packages/sim/src/recovery.ts:98-99`), and `heading` is on the wire. A render-side
spin angle would double it — precisely the mistake Q28 forbids for the bubble,
made on a different object. The spin reads as a spin because `sim` spins it; the
only thing `render` adds is `KART_SPINOUT_ROLL_RADIANS` of tilt.

**The bubble (Q28).** `updateEntities` advances `e.heading` by
`BUBBLE_ORBIT_RATE * TICK_DT` every tick and rewrites `e.position` to the owner's
position plus `BUBBLE_ORBIT_RADIUS` at that heading (`entity.ts:197-209`, with
`e.position.y = owner.position.y`). The drawn bubble and the collision bubble are
the same object, and `render` adds **no** cosmetic orbit. But the bubble orbits
at 6 rad/s, so at the 20 Hz snapshot rate consecutive samples are ~0.3 rad apart
on the circle, and interpolating those *positions* linearly chords across the
orbit — the bubble visibly collapses toward its owner and springs back, 20 times
a second. So for `kind === 'bubble'` the position is **reconstructed** from the
owner's already-resolved `KartDraw.position` and the interpolated (shortest-arc)
heading, via `bubblePosition`. That is not invented motion: it is sim's own
formula applied to interpolated inputs, and it reproduces the authoritative
position exactly at every keyframe. Using the *drawn* owner position (whatever
its source) is what keeps the shield hugging the kart the player sees.
Consequently **karts are filled before entities** in both `buildRenderFrame` and
`ViewBuilder.build`.

**`surge` is never drawn (Q27).** It is a field-wide timed slow with no
meaningful location; `spawnEntity` gives it a position because every entity has
one, not because it means anything. Drawing a mesh at a meaningless position is
worse than drawing nothing, because players will try to dodge it. It is
`visible: false` in the frame and reaches the player only as
`screenTintAmount`.

### 4.8 `src/hud.ts` — pure

```ts
export type CountdownLabel = '' | '3' | '2' | '1' | 'GO'

export interface HudModel {
  visible: boolean
  place: number               // 1-BASED for display
  fieldSize: number           // MAX_KARTS in v1
  lap: number                 // 1-BASED for display: clamp(lap + 1, 1, totalLaps)
  totalLaps: number
  speedKph: number            // KartView.speed * 3.6, rounded to an integer
  item: ItemKind
  itemReady: boolean          // item !== 'none' && !motionLocked
  driftTier: number           // sim's encoding, copied from KartView.driftTier
  countdownLabel: CountdownLabel
  raceClock: string           // formatRaceClock(max(0, tick - raceStartTick))
  respawning: boolean         // respawnTicks > 0
  spunOut: boolean            // spinOutTicks > 0
  motionLocked: boolean       // === respawning; the HUD's throttle indicator reads THIS, not accel (Q21)
  standings: HudStanding[]    // length MAX_KARTS, sorted by place ascending
}
export interface HudStanding {
  playerId: number
  place: number               // 1-based
  lap: number                 // 1-based, clamped
  isBot: boolean
  connected: boolean
}
export function createHudModel(): HudModel

/** SOLE WRITER of every HudModel field. `visible` is false when
 *  `view.localPlayerId < 0`. Everything else is read off the local seat. */
export function buildHudModel(view: RaceView, totalLaps: number, out: HudModel): void

/** Ticks -> "m:ss.mmm" — minutes unpadded, seconds two digits, milliseconds
 *  three. `formatRaceClock(0) === '0:00.000'`, `formatRaceClock(3661) === '1:01.017'`.
 *  ms = Math.round(ticks * TICK_DT * 1000). Pure: no Date, no Intl. */
export function formatRaceClock(ticks: number): string

/** '' before the race, then '3' | '2' | '1' across COUNTDOWN_TICKS in equal
 *  thirds, then 'GO' for GO_LABEL_TICKS after `racing` begins, then ''.
 *  Given `countdownTicksLeft` and `phase` off the view, so it is a total function
 *  of two numbers and testable directly. */
export function countdownLabelFor(phase: RacePhase, countdownTicksLeft: number,
                                  ticksSinceStart: number): CountdownLabel
export const GO_LABEL_TICKS = 45
```

**Q18: lap display is `clamp(lap + 1, 1, totalLaps)`, shown as "LAP n/3".**
`KartState.lap.lap` starts at 0 and `updateLaps` credits lap 1 on the first
crossing, so the raw value would read "LAP 0/3" on the grid, which is wrong in
every racing game ever shipped.

**Q16: no times.** Client-recorded times are non-authoritative and differ per
peer, so the results screen would show eight players eight different sets of
numbers for the same race. `raceClock` is a live HUD element only; §5.12's
results carry positions and DNF, and nothing else. (Noted as the natural v1.1
item: a `finishTick` per kart on the wire makes real, agreeing times a small
change. It is out of scope here because it is a spec change, and the spec is the
authority.)

### 4.9 `src/audio.ts` — pure model, authored seam, no-op backend (Q26)

```ts
export type AudioCueKind =
  | 'engine' | 'skid' | 'impact' | 'itemPickup' | 'itemUse'
  | 'boost' | 'spinOut' | 'respawn' | 'lapCross' | 'countdownBeep' | 'finish'

export interface AudioCue {
  kind: AudioCueKind
  playerId: number
  intensity: number           // 0..1
  pan: number                 // -1 (left) .. 1 (right), from the camera's right axis
}

export interface AudioModel {
  engineFreqHz: number        // LOCAL kart only — see below
  engineGain: number          // 0..1
  skidGain: number            // 0..1
  cues: AudioCue[]            // fixed length MAX_AUDIO_CUES; only [0, cueCount) is live
  cueCount: number
}
export const MAX_AUDIO_CUES = 16
export function createAudioModel(): AudioModel

/** Derives continuous levels from `view` and one-shots from the delta between
 *  `prev` and `view`. SOLE WRITER of every AudioModel field. Pure and
 *  assertable: a test drives two views and asserts exactly which cues fire.
 *  Cues beyond MAX_AUDIO_CUES in one frame are dropped, oldest-kind-first, never
 *  grown. */
export function buildAudioModel(prev: RaceView, view: RaceView, out: AudioModel): void

/** Device/user preference, NOT a property of the audio the race is producing.
 *  R38: volume and mute must never be fields of AudioModel — a model that
 *  carries a setting means moving a slider re-plans a frame. */
export interface AudioConfig {
  masterGain: number          // 0..1
  enabled: boolean            // false mutes without tearing the backend down
}

/** ADAPTER boundary. Plan 5 puts Web Audio behind this and touches nothing else. */
export interface AudioBackend {
  apply(model: AudioModel): void
  /** R38: the seam carries its config from day one, so a live settings change
   *  has somewhere to go and Plan 5 needs no widened concrete type and no
   *  amendment to this contract. Called on every Settings change, not per frame. */
  setConfig(cfg: AudioConfig): void
  close(): void
}

/** The v1 backend. Implements all three methods trivially: Q26 defers audible
 *  audio to Plan 5 and keeps the seam authored, because building a seam is hours
 *  and retrofitting one is a refactor. */
export const nullAudioBackend: AudioBackend
```

When Plan 5 lands it: **local kart engine voice only**, plus one-shots for items,
impacts and lap crossings. Eight oscillators for eight engines is a mobile
battery problem and a mix nobody can hear through. `AudioModel` is shaped for
exactly that today — one engine, N one-shots — so Plan 5 changes no signature.

### 4.9a `src/smoothing.ts` — error smoothing, and why it is not a polish item (R41)

**This module is required, and the netcode's central trade is dishonest without
it.**

The measurement, from Task 15's review: `ClientLoop` converges to roughly **one
correction per 600 ticks under a held-steady intent**, but **about three
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
racer, where latency is the first thing a player feels. Spec §5 records the
amendment.

That ruling is only honest if something actually absorbs them. The corrections are
small: they fire just past `EPS.position` (~5 cm) against roughly 33 cm of travel
per tick at speed, so they are entirely hideable — **but only if the kart is not
snapped to them.** Without this module the trade is just "the kart jumps three
times a second."

```ts
/** The retained visual error for ONE seat: metres for position, radians for
 *  heading. `current`/`currentHeading` are what the view adds to the drawn pose;
 *  `origin`/`originHeading` are the offset at the instant of the most recent
 *  correction, which is what the ease decays from.
 *
 *  Both channels are smoothed, on ONE window and ONE curve — two smoothing rates
 *  on one object is how a kart ends up visually cornering out of phase with
 *  itself. */
export interface VisualOffset {
  origin: Vec3
  originHeading: number       // radians
  ticksSince: number          // ticks since the most recent correction
  current: Vec3               // the eased offset to ADD to the drawn position
  currentHeading: number      // radians, ADDED to the drawn heading
}
export function createVisualOffset(): VisualOffset

/** 0.2 s at 60 Hz. Long enough to hide 5 cm completely, short enough that a
 *  wrong prediction is not still on screen when the next one lands (~3/s). */
export const ERROR_SMOOTH_WINDOW_TICKS = 12
/** Beyond this the offset is ZEROED rather than eased: a hard resync
 *  (ClientLoop.hardResync) can move a kart tens of metres, and sliding it there
 *  smoothly is worse than a cut. */
export const ERROR_SMOOTH_MAX_POSITION_M = 2.5

/** The yaw analogue of the position cut, and it is derived rather than picked.
 *  Easing an offset of `x` radians over the window has a peak apparent yaw rate
 *  at t = 0 of `3x / (ERROR_SMOOTH_WINDOW_TICKS * TICK_DT)` = `15x` rad/s (the
 *  derivative of the cubic). The player reads any yaw the car produces on its own
 *  as steering, so the smoothing must stay under the car's own maximum steering
 *  rate, `TUNING.steerRateBase = 2.6` rad/s: 15 x 0.15 = 2.25 rad/s, comfortably
 *  under, and 0.15 rad is 8.6 degrees — larger than any correction that is not a
 *  resync. Past it, cut. §8.1 asserts the 2.25 < 2.6 bound rather than trusting
 *  this comment. */
export const ERROR_SMOOTH_MAX_HEADING_RAD = 0.15

/** The fraction of the offset still applied `t01` of the way through the window:
 *  `(1 - clamp(t01, 0, 1)) ** 3` — ease-out cubic, zero slope at the end, so the
 *  kart settles rather than arriving. Pure, total, exported for its own test. */
export function easeRemaining(t01: number): number

/** THE pure function this ruling asks for: (previous offset, correction delta,
 *  ticks elapsed) -> new offset. `out` MAY alias `prev`.
 *
 *  `correctionHeading` is the nullable, passed through UNCHANGED from
 *  `correctionDeltaOf` via `RaceSession.correctionDelta` (§5.10): `null` means no
 *  reconciliation happened this tick, and `0` means one happened and moved the
 *  heading by exactly zero. Those are different, and the difference is carried
 *  from its source rather than reconstructed here — which is why there is no
 *  separate `corrected` flag. `correctionPos` is ignored when it is null.
 *
 *  - `correctionHeading !== null` re-seeds:
 *      out.origin = prev.current + correctionPos,
 *      out.originHeading = wrapAngle(prev.currentHeading + correctionHeading),
 *      out.ticksSince = 0
 *  - `null`: both origins carry over,
 *      out.ticksSince = prev.ticksSince + ticksElapsed
 *  - then f = easeRemaining(out.ticksSince / ERROR_SMOOTH_WINDOW_TICKS),
 *      out.current = out.origin * f  and  out.currentHeading = out.originHeading * f
 *      — ONE f, so the two channels can never fall out of phase
 *  - and if |out.origin| > ERROR_SMOOTH_MAX_POSITION_M **or**
 *    |out.originHeading| > ERROR_SMOOTH_MAX_HEADING_RAD, every field is zeroed:
 *    either channel tripping its guard cuts BOTH, because easing half a resync is
 *    worse than cutting all of it.
 *
 *  Deterministic and frame-rate independent: `ticksElapsed` is SIM TICKS, never
 *  frames. Called once per tick per smoothed seat, from ViewBuilder (§5.11). */
export function advanceVisualOffset(prev: VisualOffset, correctionPos: Vec3,
                                    correctionHeading: number | null,
                                    ticksElapsed: number, out: VisualOffset): void
```

**The offset is render-only and is never written back into any `SimState`.** It
is added to `KartView.position` and `KartView.heading` by `ViewBuilder` and to
nothing else: `session.state()` stays exactly what `ClientLoop` reconciled, the
next tick predicts from the authoritative value, and the smoothing can therefore
never feed back into the simulation or into what the authority is told. It
applies to the **local seat on a guest only** — every other seat is interpolated,
which has no corrections to hide, and host/solo seats are authoritative.

`ViewBuilder` obtains both deltas from `RaceSession.correctionDelta` (§5.10),
which is `net`'s own `correctionDeltaOf` (R47, R48) — **the exact vector and angle
the reconciliation applied**, reported by the loop that applied them, not
reconstructed from before and after states.

**Heading is smoothed because it is the worse channel, not the milder one (R48).**
`EPS.heading = 0.0025` rad is the threshold at which a heading correction fires,
not a bound on its size — past it, `resyncOwnKart` writes the authoritative
heading whatever the divergence is. And heading error converts into position error
faster than anything else in the model: 0.0024 rad of heading error at 20 m/s is
0.048 m/s of lateral drift, about three times what the velocity residual produces,
and it crosses a lane in a second. Smoothing position while snapping heading would
leave the dominant error channel visible.

### 4.10 `src/backend.ts` and `src/three/renderer.ts` — the seam and the adapter

```ts
// src/backend.ts  — PURE (interface only, imports nothing but sibling types)
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
```

```ts
// src/three/renderer.ts  — ADAPTER. Not re-exported from the barrel (§8.2).
export interface ThreeRendererOptions {
  antialias: boolean
  maxPixelRatio: number       // 2 by default; phones lie about theirs
  shadows: boolean            // false in v1
}
export const DEFAULT_THREE_OPTIONS: Readonly<ThreeRendererOptions>
export function createThreeRenderer(canvas: HTMLCanvasElement,
                                    opts: ThreeRendererOptions): RendererBackend
```

**Sole writer:** `createThreeRenderer`'s returned object is the only thing in the
repository that touches a Three.js scene graph. Nothing else imports `three`.

**Q10: Three.js is mandated and pinned at exactly `three@0.180.0`** — not a
caret range, not a hand-rolled WebGL renderer. Spec §3 says "Three.js scene" and
the spec is the binding authority; the Plan 3 brief's "Canvas/WebGL" is a looser
restatement, not a competing decision. **There is no Canvas2D fallback backend.**
The `RendererBackend` seam exists for **headless testability** (§8.2), not device
fallback: every device that can run this game has WebGL, and a second renderer is
a second thing to keep correct for no user.

Type declarations for `three` are the concern of the single task that owns
`src/three/renderer.ts`: if the installed package does not resolve its own types,
that task adds `"@types/three": "0.180.0"` to `packages/render`'s
`devDependencies` and says so in its report. No other task touches this, so it
cannot cause two tasks to disagree.

### 4.11 `src/index.ts` — the barrel

Re-exports `types`, `mesh`, `descriptors`, `camera`, `frame`, `hud`, `audio`,
`smoothing`, `backend`. **It does not re-export `three/renderer`,** and there is
no `time` module (§4.1) and no `theme` module (§4.5). §8.2 says why the omission
is load-bearing. A test asserts no two re-exported modules export the same name,
exactly as `packages/sim/test/barrel.test.ts` does.

---

## 5. `packages/game` — module map and exact signatures

### 5.1 `src/clock.ts` — the only wall clock in the repository, and the only `TICK_MS` import

```ts
import { TICK_MS } from '@tapkart/net'      // Q6: imported, never redefined
import type { TickAccumulator } from '@tapkart/net'

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
 *  RemoteInterpolator.sampleKart / sampleEntity, and §6.3 makes that structural
 *  by keeping the call inside ViewBuilder. */
export function renderNowMs(tick: number, alpha: number): number
```

*Amended 2026-08-14: `MAX_CATCHUP_TICKS`, `TickAccumulator`, `createAccumulator`
and `advanceAccumulator` are removed from this file — ruling F-P4-7 moves the
whole accumulator (type, constructor, function and clamp) to `@tapkart/net`,
because `packages/server`'s fixed-step pump (Plan 4) needs the identical
function and `net` may not import `game` (§1's arrow points one way); two
copies of a catch-up clamp do not stay equal. Shipped
`packages/net/src/clock.ts` supersedes this section for those four symbols:*

```ts
export const MAX_CATCHUP_TICKS = 5                       // not 8
export interface TickAccumulator { residualMs: number }  // no lastNowMs
export function makeTickAccumulator(): TickAccumulator   // not createAccumulator; takes no argument
export function advanceAccumulator(acc: TickAccumulator, elapsedMs: number): number
```

*`elapsedMs` is a DELTA, not an absolute clock reading — the accumulator holds
no timestamp and does no clock arithmetic, so the caller (the frame loop) owns
the previous instant and subtracts it before calling; passing an absolute
`performance.now()` would run the clamp on the first frame and every frame
after. `game/clock.ts` imports these four from `@tapkart/net` and re-exports
none of them. This file drops from 9 exports to 5: `FrameClock`,
`realFrameClock`, `makeFixedClock`, `accumulatorAlpha`, `renderNowMs`.*

### 5.2 `src/content/tuning.ts` does not exist — `TUNING` and `CHARACTERS` are content

R46 moves them to `@tapkart/content` (§3a.2), because `packages/server`'s shadow
authority needs the identical `Tuning` to run `step()` in lockstep and spec §3
forbids `server` from depending on `game`. `game` imports `TUNING` and
`CHARACTERS` by bare specifier and defines neither.

Everything Q1 requires is unchanged and now lives in `packages/content/test/`:
numerical identity with `makeTuning()` and `makeCharacters()`, asserted
field-by-field, mandatory.

### 5.3 `src/content/tracks.ts` does not exist — `loadTrack` is content

R46 moves `TRACK_MANIFEST`, `parseTrack`, `LoadedTrack` and `loadTrack` to
`@tapkart/content` (§3a.5), for the same reason: the shadow authority simulates on
the same six tracks. Q12's substance is intact — bundled, **synchronous**, total,
no `FetchJson` anywhere in Plan 3 — and only the bundling mechanism changed, from
`import.meta.glob` to static JSON imports, because `server` runs without Vite
(§3a.1).

`game` calls `loadTrack(state.trackId)` when a race starts and stores nothing of
its own.

### 5.4 `src/content/bundle.ts` does not exist — the bundle is content

R46 moves `ContentBundle` and `loadContentBundle` to `@tapkart/content` (§3a.6).
`game` calls it once at startup and hands `bundle.characters` and `bundle.karts`
to `buildRenderFrame`, and `loadTrack(...).theme` to `buildTrackScene`.

### 5.5 `src/controls/` — spec §6, three schemes, keyboard always on top

```ts
// src/controls/types.ts
/** THREE schemes (spec §1: "3, selectable (plus keyboard for desktop)").
 *  Keyboard is NOT a fourth: Q23 rules it a merge, not an alternative. */
export type ControlScheme = 'thumbZones' | 'tilt' | 'virtualStick'

export type PointerPhase = 'down' | 'move' | 'up'
export interface PointerSample {
  id: number                  // the browser's pointerId; stable for one touch
  x: number                   // CSS px from the viewport's left edge
  y: number                   // CSS px from the viewport's TOP edge
  phase: PointerPhase
}
export interface TiltSample { alpha: number; beta: number; gamma: number }  // degrees
export interface Viewport { width: number; height: number }                // CSS px
export const MAX_POINTERS = 8

/** Raw, device-shaped input for ONE frame. Filled by the DOM source (§5.6) or by
 *  a test, and consumed by exactly one ControlAdapter. `pointers` is fixed
 *  length MAX_POINTERS; only [0, pointerCount) is live. */
export interface ControlInputs {
  pointers: PointerSample[]
  pointerCount: number
  keys: Record<string, boolean>     // KeyboardEvent.code, e.g. 'ArrowLeft', 'KeyZ'
  tilt: TiltSample | null           // null when unavailable or not permitted
  viewport: Viewport
}
export function createControlInputs(): ControlInputs

/** Every scheme is one of these and nothing more. Spec §6: "three schemes is
 *  three small adapters, not three control systems." */
export interface ControlAdapter {
  readonly scheme: ControlScheme
  /** Pure over (raw, tick, this adapter's own latched state). SOLE WRITER of
   *  `out`, and it writes EVERY field of `out` including `out.tick = tick`. */
  sample(raw: ControlInputs, tick: number, out: Intent): void
  /** Drops all latched state: drift hold, brake hold counter, stick origin,
   *  pointer ids, item edge latch. */
  reset(): void
}
```

```ts
// src/controls/config.ts
export interface ControlConfig {
  deadZone: number            // 0..1 of the full-lock distance, below which steer is 0
  steerGain: number           // multiplies the normalised steer axis before clamping
  steerSmoothingPerTick: number   // 0..1 lerp toward the raw axis, once per sample()
  tiltNeutralDegrees: number
  tiltRangeDegrees: number    // degrees from neutral to full lock
  tiltCalibration: TiltCalibration
  invertTilt: boolean
  keyBindings: Record<string, 'left' | 'right' | 'accel' | 'brake' | 'drift' | 'item'>
}
/** deadZone 0.06, steerGain 1, steerSmoothingPerTick 0.35,
 *  tiltNeutralDegrees 0, tiltRangeDegrees 25,
 *  tiltCalibration IDENTITY_TILT_CALIBRATION, invertTilt false,
 *  keyBindings: ArrowLeft/KeyA -> left, ArrowRight/KeyD -> right,
 *  ArrowUp/KeyW -> accel, ArrowDown/KeyS -> brake, ShiftLeft/Space -> drift,
 *  KeyE/ControlLeft -> item. */
export const DEFAULT_CONTROL_CONFIG: Readonly<ControlConfig>

// Q24's layout, in CSS px, shared by thumbZones and tilt so their buttons cannot
// disagree by a pixel.
export const TOUCH_BUTTON_SIZE_PX = 88
export const TOUCH_BUTTON_MARGIN_PX = 16
export const TOUCH_BUTTON_GAP_PX = 16
/** Full lock at 28 % of the half-width, measured from the touch-down origin. */
export const THUMBZONE_FULL_LOCK_FRACTION = 0.28
/** Q21's brake: ticks the drift button must be held before it also brakes. */
export const BRAKE_HOLD_TICKS = 18          // 0.3 s at 60 Hz

export interface Rect { x: number; y: number; w: number; h: number }   // CSS px, y down
/** Bottom-right, TOUCH_BUTTON_MARGIN_PX from both edges. */
export function driftButtonRect(v: Viewport, out: Rect): void
/** Directly above the drift button, TOUCH_BUTTON_GAP_PX of dead space between. */
export function itemButtonRect(v: Viewport, out: Rect): void
/** Half-open on the far edges: x in [r.x, r.x + r.w), y in [r.y, r.y + r.h). */
export function rectContains(r: Rect, x: number, y: number): boolean
```

```ts
// src/controls/tilt.ts
export interface TiltCalibration { betaZero: number; gammaZero: number }   // degrees
export const IDENTITY_TILT_CALIBRATION: Readonly<TiltCalibration>
/** Pure: the sample the player held while the calibration prompt was up. */
export function calibrateTilt(sample: TiltSample): TiltCalibration
export function makeTiltAdapter(cfg: ControlConfig): ControlAdapter

// src/controls/thumbzones.ts
export function makeThumbZonesAdapter(cfg: ControlConfig): ControlAdapter

// src/controls/stick.ts
export function makeVirtualStickAdapter(cfg: ControlConfig): ControlAdapter

// src/controls/keyboard.ts
export function makeKeyboardAdapter(cfg: ControlConfig): ControlAdapter
```

```ts
// src/controls/composite.ts  — Q23
/** Merges two Intents into `out`. NOT symmetric: on an equal-magnitude steer
 *  tie, `keyboard` wins. SOLE WRITER of `out`, and it writes every field. */
export function mergeIntents(touch: Intent, keyboard: Intent, out: Intent): void

/** `primary`'s scheme, `primary`'s and `secondary`'s own scratch Intents, and
 *  mergeIntents. The sole-writer rule for Intent is preserved by construction:
 *  sub-adapters write into their own scratch and only the composite writes the
 *  one `game` submits. */
export function makeCompositeAdapter(primary: ControlAdapter,
                                     secondary: ControlAdapter): ControlAdapter
```

```ts
// src/controls/index.ts
/** THE public entry point. Builds the scheme's touch adapter, a keyboard
 *  adapter, and returns the composite of the two — always, on every platform.
 *  Spec §6 says keyboard is *always* available on desktop, and "always" is not
 *  "instead of"; on a phone no key is ever down, so the merge is a no-op. */
export function makeControlAdapter(scheme: ControlScheme, cfg: ControlConfig): ControlAdapter
```

**Q23's merge rule, stated once so no task invents its own:**

| Field | Rule |
|---|---|
| `steer` | the input of **greater absolute magnitude** wins; ties go to **keyboard** |
| `accel` | **maximum** |
| `brake`, `drift`, `useItem` | **logical OR** |
| `tick` | the `tick` argument, written by the composite |

**Spec §6, made mechanical.** Every cell is a decision two tasks could otherwise
make differently:

| Scheme | `steer` | `accel` | `brake` | `drift` | `useItem` |
|---|---|---|---|---|---|
| `thumbZones` (default) | left half: `(x - originX) / (viewport.width/2 * THUMBZONE_FULL_LOCK_FRACTION)`, clamped to ±1, **relative to the touch-down origin** | always `1` | drift button held ≥ `BRAKE_HOLD_TICKS` **and** `|steer| < DRIFT_STEER_MIN` | drift button held | one-tick pulse on item-button press |
| `tilt` | `(gamma - calibration.gammaZero) / tiltRangeDegrees`, clamped, negated when `invertTilt` | always `1` | same rule as `thumbZones` | drift button held | one-tick pulse on item-button press |
| `virtualStick` | stick x from its own touch origin, same normalisation as `thumbZones` | gas button held → `1`, else `0` | brake button held | drift button held | one-tick pulse on item-button press |
| `keyboard` (merged into every scheme, never selected on its own) | `(right ? 1 : 0) - (left ? 1 : 0)`, then the same smoothing | accel key held → `1`, else `0` | brake key held | drift key held | one-tick pulse on item-key press |

Four rulings are baked into that table, and each has a reason worth keeping:

**Q24 — steering is relative to the touch-down origin, and the buttons have a
dead gap.** Relative-to-origin is the mobile-racer convention, it is
thumb-position-independent across hand sizes and device widths, and — decisively
— absolute steering means the kart jerks to full lock the instant a thumb lands
anywhere but the exact screen centre. Full lock at 28 % of the half-width from
the origin. Drift button 88 px, bottom-right, 16 px from both edges; item button
88 px directly above it with a 16 px gap. **A touch landing in the gap belongs to
neither** — dead space between buttons is correct; nearest-button snapping fires
the wrong one and the player cannot tell why. A touch that begins in the left
half steers; a touch that begins inside a button belongs to that button for its
whole life, even if it slides out.

**Q21 — `thumbZones` gains a brake, and adapters never lie about `accel`.** A
`thumbZones` player who noses into a wall could not previously reverse and had to
wait out the 1.2 s out-of-bounds respawn, if the wall even counted as out of
bounds; that is not an acceptable v1 control scheme. Brake is a **long press on
the drift button** — no new screen real estate, no new affordance to teach. The
`|steer| < DRIFT_STEER_MIN` qualifier is what keeps it from eating drifting:
`updateDrift` only engages a drift when `|steer| >= DRIFT_STEER_MIN` (0.35), so
holding the button *while turning* is a drift and holding it *straight* is a
brake, and the threshold that separates them is `sim`'s own constant, imported,
so the two can never drift apart. Separately: `sim` ignores input under motion
lock, so the adapter has no reason to zero `accel` on a state it would have to
re-derive — **the HUD reads `motionLocked`, not `accel`** (§4.8).

**Q25 — `useItem` is a one-tick pulse on press, in the adapter.** A held button
otherwise auto-fires the next item the instant it is granted, which the player
did not ask for and cannot prevent. `sim` is unchanged: edge semantics live in
the adapter, where the press already is.

**Q22 — iOS motion permission is requested from the settings toggle, on the tap
that selects `tilt`.** That tap is an unambiguous user gesture, which is what iOS
requires, and it is the only moment the player has expressed intent to use tilt.
**Silent fallback is forbidden:** on denial the selection **reverts** to the
previous scheme and the settings screen says why. A player who selects tilt, is
denied by the OS, and gets thumb-zones with no explanation concludes the game is
broken.

### 5.6 `src/controls/source.ts` — ADAPTER (thin, untestable)

```ts
export interface InputSource {
  /** Copies everything accumulated since the last call into `out`, then clears
   *  its own accumulator. Never allocates: `out.pointers` is reused. */
  drain(out: ControlInputs): void
  detach(): void
}

/** Attaches pointer, key and deviceorientation listeners. The ONLY file in
 *  packages/game that references a DOM event. */
export function attachInputSource(target: EventTarget, viewport: Viewport): InputSource

/** iOS requires a user-gesture-gated permission prompt for motion. Resolves
 *  `false` when denied or unsupported. Q22: the caller REVERTS the selection and
 *  shows a reason; it does not silently fall back. */
export function requestTiltPermission(): Promise<boolean>
```

### 5.7 `src/settings.ts`

```ts
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
/** scheme 'thumbZones', IDENTITY_TILT_CALIBRATION, invertTilt false,
 *  audioEnabled true, audioVolume 0.7, characterIdx 0,
 *  lastTrackId TRACK_MANIFEST[0].id, playerName ''. */
export const DEFAULT_SETTINGS: Readonly<Settings>

export const SETTINGS_STORAGE_KEY = 'tapkart.settings.v1'

/** Injected so tests never touch localStorage. */
export interface KeyValueStore { get(key: string): string | null; set(key: string, value: string): void }
export function memoryStore(): KeyValueStore

/** NEVER throws. Malformed JSON, a missing key, a wrong type or an out-of-range
 *  value falls back PER FIELD to DEFAULT_SETTINGS — not per object, so one bad
 *  field does not discard the other seven. */
export function loadSettings(store: KeyValueStore): Settings
export function saveSettings(store: KeyValueStore, s: Settings): void
```

### 5.8 `src/roomcode.ts` does not exist — room codes are `@tapkart/protocol`'s

Room codes travel on the wire (Task 15c item E) and moved to
`@tapkart/protocol` before Plan 3 was written (`packages/protocol/src/room.ts`,
§2), because the server that mints them, the game that types them in, and any
later invite package all depend on `protocol` and none of the other three
depend on each other. `game` imports `ROOM_CODE_ALPHABET`, `ROOM_CODE_LENGTH`,
`LOBBY_PATH_PREFIX`, `normalizeRoomCode`, `isValidRoomCode` and `lobbyPathFor`
by bare specifier and defines none of them:

```ts
export const ROOM_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'  // Crockford base32
export const ROOM_CODE_LENGTH = 5
export const LOBBY_PATH_PREFIX = '/r/'
export function normalizeRoomCode(raw: string): string
export function isValidRoomCode(raw: string): boolean
export function lobbyPathFor(code: string): string
```

Minting a room code is still the **server's** job (spec §5, step 1) and
therefore Plan 4's. Plan 3 only normalises what a player types and displays
what it is given.

*Amended 2026-08-14: this section originally specified a `game`-local
`src/roomcode.ts` with `ROOM_CODE_LENGTH = 4` and an alphabet reading
`'23456789ABCDEFGHJKLMNPQRSTUVWXYZ'` — dropping `0`/`1` along with `I`/`L`/`O`.
Shipped code disagrees on both counts: the alphabet is **Crockford's**, which
*keeps* `0` and `1` and drops `I`, `L`, `O` and `U` instead, and the length is
**5**, not 4 — forced by the Cloudflare Tunnel presenting every request as one
TCP peer, which collapses per-IP rate limiting, so the keyspace itself has to
do more of the work (spec, "the code was four characters" amendment).*

### 5.9 `src/app.ts` — the screen state machine, pure

```ts
/** Q14: spec §3's five screens are canonical. */
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
  role: ViewRole              // from @tapkart/render; there is no second union
  roomCode: string            // '' when solo or not yet minted
  trackId: string
  localPlayerId: number       // -1 until connected
  slots: LobbySlot[]          // length MAX_KARTS
  settings: Settings
  results: ResultRow[]        // [] until the race finishes
  error: string               // '' when none
  connecting: boolean
}
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

/** Pure and total: returns a NEW AppState and never mutates `prev`. SOLE WRITER
 *  of every AppState field. An event not legal for the current screen is an
 *  identity no-op returning `prev` BY REFERENCE, never a throw. */
export function reduceApp(prev: AppState, ev: AppEvent): AppState

/** Every legal (screen, event.kind) pair, as data. Exported so a test proves the
 *  table and the reducer agree, rather than testing the reducer against itself. */
export const SCREEN_TRANSITIONS: Readonly<Record<ScreenId, readonly AppEvent['kind'][]>>
```

Q14's three clarifications, each of which deletes a screen the draft had:

- **Character select is its own screen.** Spec §3 lists it; the Plan 3 brief's
  six-item flow simply omitted it. It is also the natural home for the Q2
  descriptors.
- **Countdown is not a screen.** `sim` already models it as `phase ===
  'countdown'`, and giving it a screen creates two sources of truth for one fact
  — the exact defect class this project keeps paying for. The race screen renders
  the countdown overlay when `view.phase === 'countdown'`.
- **`join/host` is not a screen either.** It is the title screen's buttons
  (`hostPressed`, `joinPressed`, `soloPressed`). A screen with two buttons and no
  state of its own is a control, not a screen. `connecting` and `error` carry the
  modal.

### 5.10 `src/session.ts` — the composition root for one race

```ts
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
  /** The characterIdx of every seat. THE source for KartView.characterIdx in
   *  every role, because WireKart does not carry it (§2.3). Length MAX_KARTS. */
  readonly characterIdx: readonly number[]
  /** The tick the race clock counts from: COUNTDOWN_TICKS in every role — R44
   *  puts every role, host and guest included, in 'countdown' at start (§15.2). */
  readonly raceStartTick: number

  /** Advance exactly one 60 Hz sim tick with the local player's intent.
   *  Copies the pre-tick state into the prev buffer FIRST, then ticks. */
  tickOnce(localIntent: Intent): void

  /** The state this session is entitled to read. Host/solo: the authoritative
   *  state. Guest: the predicted state, whose remote seats §7.1 forbids drawing.
   *  Live, never a copy — callers must not mutate it. */
  state(): SimState

  /** The state as of the previous tick, for Q9's sub-tick lerp — which is its
   *  only remaining purpose now that R47 makes the correction delta exact.
   *  Allocated ONCE, at construction. Equal to `state()` before the first
   *  tickOnce. */
  prevState(): SimState

  /** Guest only: the interpolated pose plus the authoritative WireKart for a
   *  remote seat, ~100 ms in the past, written into the caller-owned `out`.
   *  Returns false — leaving `out` untouched — on host/solo (where `state()` is
   *  already authoritative) and for the local seat. Delegates straight to
   *  `RemoteInterpolator.sampleKart(playerId, nowMs, out)`; the buffer is the
   *  caller's and is allocated once (§2.5, ruling P2-R29). */
  sampleRemoteKart(playerId: number, nowMs: number, out: RemoteSample): boolean

  /** Guest only, Q4. false, with `out` untouched, on host/solo and for an entity
   *  absent from the newest keyframe (it despawned). */
  sampleRemoteEntity(entityId: number, nowMs: number, out: RemoteEntitySample): boolean

  /** Guest only, Q4: the live entity ids in the newest keyframe, written into
   *  `out` (length MAX_ENTITIES), returning the count. Returns 0 on host/solo. */
  remoteEntityIds(out: Int32Array): number

  /** Reconciliation corrections so far; 0 on host/solo. Surfaced for the
   *  zero-corrections invariant and for a dev overlay. */
  corrections(): number

  /** R41's input, R47/R48's exactness. Writes the position delta the last
   *  reconciliation applied to the local kart into `outPos` and returns its
   *  heading delta in radians; returns `null` — writing (0,0,0) — when the most
   *  recent tick applied no correction. Always `null` on host and solo, which
   *  never reconcile.
   *
   *  It DELEGATES to `correctionDeltaOf(client, outPos)` from @tapkart/net (§2.5)
   *  and computes nothing: `ClientLoop` knows the true vector and angle at the
   *  instant it applies them, and any reconstruction from before/after states
   *  assumes constant velocity across the tick — degrading exactly when the kart
   *  is accelerating hardest, which is when a correction is most likely and most
   *  visible.
   *
   *  `null` and `0` are different answers and both are meaningful: a
   *  reconciliation that moved the heading by exactly zero still restarts the
   *  ease window. Valid until the next tickOnce. */
  correctionDelta(outPos: Vec3): number | null

  close(): void
}

/** Wires AuthorityLoop (host/solo) or ClientLoop (guest) over the given
 *  Transport. SOLE CONSTRUCTOR of a net loop in the entire game package. */
export function createSession(opts: SessionOptions): RaceSession
```

`createSession` does exactly this, and the order matters:

| Role | What it builds |
|---|---|
| `solo` | `state = createState(ctx, seed, characterIdx)` — phase `'countdown'`, as the simulation intends; `state.karts[localPlayerId].isBot = false; connected = true`; `new AuthorityLoop(ctx, state, transport)` |
| `host` | **identical to `solo`.** R44 puts `phase` on the wire, so a host counts down and every guest sees it; there is no longer a reason for the two to differ |
| `guest` | `new ClientLoop(ctx, localPlayerId, transport)`; `state()` is the loop's predicted state, whose `phase` now tracks the authority's through the snapshot (§2.5, Task 15c). `ClientLoop` builds its own state with seed 0 and an all-zero characterIdx, which is why `RaceSession.characterIdx` — not `state()` — is the source for that field |

`raceStartTick` is `COUNTDOWN_TICKS` in every role, because every role now starts
in `'countdown'`.

*Amended 2026-08-14: the `raceStartTick` doc comment above originally read
'COUNTDOWN_TICKS for solo, 0 for host and guest' — a leftover from the
deferral §15.2 describes, and contradicted by this very paragraph. R44 puts
`phase` on the wire and starts every role in `'countdown'`; the doc comment is
corrected to match.*

`tickOnce` is `cloneState(state(), prev)` and then `loop.tick(...)`: for host and
solo it additionally stamps `localIntent.tick = state().tick + 1` and calls
`transport.submitLocalInput(localPlayerId, localIntent)` **before**
`AuthorityLoop.tick()`, because `AuthorityLoop` has no other input path (§2.4
fact 1, §5.10a).

**Q15: `transport` is never absent, and solo uses a local-input decorator over a
zero-peer null transport.** Exactly one loop path exists, and solo — the mode
that will be run thousands of times during development — exercises the same
`AuthorityLoop` the host runs. The purpose-built null transport drops broadcasts
immediately; unlike one unpumped half of a loopback pair, it never accumulates
undeliverable snapshots. The local-input decorator still routes the player's
intent through the real codec and the authority's normal `onMessage` path.

*Amended 2026-08-14 (ruling P2-R29): `sampleRemoteKart` and `sampleRemoteEntity`
above take a caller-owned `out` and return a boolean, because the `@tapkart/net`
methods they delegate to now do (§2.5). They are one-line delegations — `return
interp.sampleKart(playerId, nowMs, out)` — and a wrapper that kept the nullable
return would have to allocate a `RemoteSample` per call to produce it, which is
precisely the per-frame allocation the change removes. The session allocates no
sample buffer of its own: the buffers belong to `ViewBuilder`, which is the only
caller (§6.3), and are made once by `makeRemoteSample` /
`makeRemoteEntitySample`.*

### 5.10a `src/localinput.ts` — one composition, because the decorator is `net`'s (R42)

`withLocalInput`, `createNullTransport`, `LocalInputTransport` and `LOCAL_PEER_ID`
are **`@tapkart/net` exports** (§2.5). A transport decorator is a transport, and
`net` owns transports. `game` composes them and defines nothing:

```ts
import { createNullTransport, withLocalInput } from '@tapkart/net'
import type { LocalInputTransport } from '@tapkart/net'

/** Q15's zero-peer local transport, composed from net's two pieces: a transport
 *  with nobody on the other end, wrapped so
 *  the solo player's own intent still reaches the AuthorityLoop through the real
 *  codec. One object, one code path, and the same AuthorityLoop the host runs. */
export function createSoloTransport(): LocalInputTransport
```

A host uses `withLocalInput(realTransport)` directly — Plan 4 supplies the real
transport; in Plan 3 it is one side of `makeLoopbackPair`. Hosts and solo sessions
put the local player's intent in through `submitLocalInput`; guests pass it to
`ClientLoop.tick`. This is what makes
`AuthorityLoop`'s "drop cheaply, never queue" behaviour (§2.4 fact 3) sufficient
for solo: nothing is waiting to be pumped.

### 5.11 `src/view.ts` — the one place prediction and interpolation are chosen between

```ts
export interface ViewBuilder {
  /** Fills `out` from the session captured at construction, obeying §7.1 seat by
   *  seat. SOLE WRITER of every RaceView field. Allocates nothing.
   *  This is the highest-value pure function in packages/game and it is tested
   *  against every role. */
  build(alpha: number, out: RaceView): void
}

/** Allocates the builder's scratch ONCE: the placement scratch SimState, two
 *  Int32Arrays for computePlacement, the Int32Array remoteEntityIds fills, one
 *  VisualOffset (R41), one Vec3 for the correction delta, and — P2-R29 — one
 *  RemoteSample from `makeRemoteSample` plus one RemoteEntitySample from
 *  `makeRemoteEntitySample`. ONE of each is enough and two would be a mistake:
 *  every field is copied into the view before the next sample call, exactly as
 *  §7.3 requires of `sampleAt`. */
export function createViewBuilder(session: RaceSession): ViewBuilder
```

`build` is specified step by step, because every task that reads a view depends
on all of it:

1. **`nowMs` is computed internally** as `renderNowMs(session.state().tick,
   alpha)` and is never a parameter. §6.3 explains what passing a wall clock
   would do and why no caller is given the chance.
2. **Karts, seat by seat, in seat order**, per §7.1's table. The local seat is
   read from `session.state()`; on a guest every other seat is read from
   `sampleRemoteKart(playerId, nowMs, this.kartSample)` into the builder's one
   sample buffer, and a `false` return means `source: 'absent'` with the seat's
   previous fields left untouched except `source` — *and the buffer's contents
   ignored*, since `false` leaves whatever the previous seat wrote in it.
3. **State-sourced seats are lerped by `alpha`** against `session.prevState()`
   (Q9): `position` component-wise, `heading` by shortest arc (`a +
   wrapAngle(b - a) * alpha`). Interpolator-sourced seats are **not** lerped —
   `renderNowMs` already resolved sub-tick time for them. The lerp is
   **render-only**: it writes into the view, never back into either `SimState`.
   Q9 rules the local kart in; this contract applies the same lerp to every
   state-sourced seat, because on a host the other seven seats come from the same
   `state()` and would otherwise judder alone (§15.3).
4. **`characterIdx` comes from `session.characterIdx[playerId]`**, in every role.
5. **`s` is reconstructed** from `checkpointIdx` and `t`:
   `s = wrap01(cp[i] + t * ((cp[(i+1) % n] - cp[i] + 1) % 1))`, where `cp =
   ctx.track.checkpointS` and `i = ((checkpointIdx % n) + n) % n`. This works on a
   guest because `checkpointIdx` and `t` are on the wire, and it costs no
   `project()` call in the frame path. `checkpointIdx < 0` (the grid) uses
   `i = n - 1`.
6. **`bankAngle` is `ctx.query.sampleAt(s).banking`**, copied out immediately
   (§7.3 — `sampleAt` returns shared scratch).
7. **`speed` is `Math.hypot(velocity.x, velocity.z)`** — plan view, so a ramp
   launch does not inflate the speedometer.
8. **`driftTier` is `driftTierFor(driftCharge, ctx.tuning.driftTiers)`** — the
   only call site in Plan 3, and the only place the tier is computed.
9. **Placement uses `computePlacement`, always.** The builder copies
   `playerId`, `lap.lap`, `lap.checkpointIdx` and `lap.t` for all eight seats —
   from the view's own kart values, whatever their source — plus
   `state().finishedOrder`, into its scratch `SimState`, then calls
   `computePlacement(scratch, indexOf, order)` and writes `place = indexOf[pid]`.
   Nothing in `game` or `render` re-implements the comparator; the scratch exists
   precisely so a guest's placement is computed by the same function the
   authority uses, over authoritative wire values.
10. **Entities.** Host/solo: slots `[0, state().entityCount)` copied from
    `state().entities`, lerped by `alpha` like karts, `source:
    'authoritative'`. Guest: `remoteEntityIds` enumerates the newest keyframe,
    each id is sampled with `sampleRemoteEntity(id, nowMs, this.entitySample)`
    into the builder's one entity buffer, and every sample that returns `true` is
    packed at the front with `source: 'interpolated'`; a `false` sample is simply
    not listed, and the buffer — which still holds the *previous* entity — is not
    read. Unused slots get `entityId: -1` and `source: 'absent'`.
11. **Item boxes** come from `state().itemBoxes` in every role, with
    `position = itemBoxWorldPos(ctx, boxIdx, out)` and
    `respawnTicks` copied. `itemBoxRespawnTicks = ctx.tuning.itemBoxRespawnTicks`.
    §7.1 explains why a guest's are approximate and why nothing polices them.
11a. **Error smoothing, local seat, guest only (R41, R47, R48).** Once per
    *tick* — not per frame — the builder calls
    `const h = session.correctionDelta(scratchVec3)` and
    `advanceVisualOffset(offset, scratchVec3, h, ticksElapsed, offset)`, where
    `ticksElapsed` is `state().tick - lastSeenTick`. The nullable travels
    unchanged from `correctionDeltaOf` through the session into the smoother, so
    "no correction" is never reconstructed from a zero delta. It then adds
    `offset.current` to the local `KartView.position` and `offset.currentHeading`
    to its `heading` (wrapped), **after** the step-3 lerp and **before** placement
    and entities. The offset is never written into a `SimState`, never applied to
    a remote seat, and never applied on host or solo. A frame that runs zero ticks
    re-uses the offset unchanged, which is what keeps the ease frame-rate
    independent.

12. **Scalars:** `tick`, `phase`, `finishTick`, `finishedOrder` from `state()` —
    `phase` is authoritative in every role now that R44 puts it in the snapshot;
    `alpha` from the argument; `localPlayerId` and `raceStartTick` from the
    session; `countdownTicksLeft = phase === 'countdown' ? max(0,
    COUNTDOWN_TICKS - tick) : 0`.
13. **Q32's dev assertion, last:**

```ts
if (import.meta.env.DEV) {
  const violations = viewSourceViolations(out, session.role)
  if (violations.length > 0) {
    throw new Error(`buildRaceView: seat-source violations:\n${violations.join('\n')}`)
  }
}
```

Q11's ruling gives Plan 3 a bundler, which removes the draft's only objection to
this. The seat-source rule is exactly the kind of invariant a test proves for the
cases it thought of and a dev-build assertion proves for the cases nobody thought
of. It costs one branch that the production build strips.

*Amended 2026-08-14 (ruling P2-R29): steps 2 and 10, and `createViewBuilder`'s
scratch list, are rewritten for the out-parameter `sampleKart` / `sampleEntity`
(§2.5). `ViewBuilder` is the reason the ruling exists — it is the only caller of
either method in the whole repository (§6.3), it runs both of them every frame,
and `build` already promises to allocate **nothing**. The allocating form made
that promise unkeepable: seven seats plus up to 32 entities, each returning a
fresh sample and a fresh `position`, is ~4,700 objects per second that `build`'s
own doc comment said did not exist. Two buffers made once in `createViewBuilder`
keep the promise literally true.*

*The one new hazard is worth stating because it is silent: a `false` return
leaves the buffer holding the **previous** seat's or entity's values, so reading
it anyway does not produce a null-shaped crash — it draws the wrong kart at the
right seat. Steps 2 and 10 say `false` means ignore the buffer, not "use what is
in it".*

### 5.12 `src/results.ts` — Q16 and Q17

```ts
export interface ResultRow {
  place: number               // 1-based
  playerId: number
  name: string                // from the lobby slot; falls back to the descriptor name
  dnf: boolean
}

/** Q17, literally: a kart is DNF iff the race ended by GRACE-TIMER EXPIRY and
 *  that kart's lap progress is short of RACE_LAPS.
 *
 *    const gracedOut = view.phase === 'finished' && view.finishTick >= 0
 *                      && (view.tick - view.finishTick) >= FINISH_GRACE_TICKS
 *    return gracedOut && kart.lap < RACE_LAPS
 *
 *  Both facts are already available to `game`, so there is no sim change and no
 *  wire change. Showing a timed-out player "4th" with no qualifier is a lie the
 *  results screen tells, and this is the one line that stops telling it. */
export function isDnf(view: RaceView, kart: KartView): boolean

/** Walks `view.finishedOrder` in slot order — which IS the finishing order,
 *  including the grace-expiry entries `updatePhase` appends in placement order —
 *  and emits one row per filled slot. Positions only (Q16): no times, no best
 *  lap, because client-recorded times are non-authoritative and differ per peer. */
export function buildResultRows(view: RaceView, slots: readonly LobbySlot[]): ResultRow[]
```

### 5.13 `src/shell.ts` — ADAPTER (thin, untestable)

```ts
export interface ShellOptions {
  canvas: HTMLCanvasElement
  root: HTMLElement           // where HUD/screen DOM is mounted
  clock: FrameClock
  store: KeyValueStore
  renderer: RendererBackend
  audio: AudioBackend         // nullAudioBackend in v1 (Q26)
}
export interface GameShell { stop(): void }

/** requestAnimationFrame loop, in this exact order:
 *    inputSource.drain -> advanceAccumulator -> N x (adapter.sample +
 *    session.tickOnce) -> updateCamera(N ticks) -> viewBuilder.build(alpha) ->
 *    buildRenderFrame -> renderer.applyFrame -> buildHudModel -> DOM ->
 *    buildAudioModel -> audio.apply.
 *  Contains no game decisions: every branch it would want is a field on
 *  RenderFrame, HudModel or AppState.
 *
 *  Two things it does outside that loop: it calls `audio.setConfig({ masterGain:
 *  settings.audioVolume, enabled: settings.audioEnabled })` on every Settings
 *  change and once at startup (R38 — never per frame), and it shows the
 *  rotate-your-device overlay while `viewport.height > viewport.width` (R40),
 *  skipping `renderer.resize` until the device is landscape again. */
export function startShell(opts: ShellOptions): GameShell
```

`startShell` does **not** take a `fetchJson` — Q12 deleted it — and does not take
a `SessionOptions`: it owns the whole app, including `reduceApp`, and constructs a
session when the screen becomes `'race'`.

#### The eleven cross-plan `data-testid` hooks the shell must carry

*Added 2026-08-14.* Plan 4's Task 24 ships `e2e/join-and-race.spec.ts`, spec §8's
last row, which drives two browser contexts through this shell. Its selector
contract lives in `e2e/fixtures/tapkart.ts`; Plan 5 adds the offline-solo hook.
Together they are **exactly these eleven values**,
which `startShell` must emit as `data-testid` attributes on the DOM it mounts
under `opts.root` (and, for one of them, on `opts.canvas`):

| `data-testid` | Where | What it is |
|---|---|---|
| `host-button` | Title screen | dispatches `{ kind: 'hostPressed' }` |
| `join-button` | Title screen | dispatches `{ kind: 'joinPressed' }` |
| `room-code-input` | Join flow | the five-character code input |
| `room-code-submit` | Join flow | submits `{ kind: 'roomCodeEntered' }` |
| `room-code` | Lobby | the room's own code, **as text** — the spec reads `textContent` and matches it against the Crockford-base32 five-character pattern |
| `ready-button` | Lobby | toggles this player's ready flag |
| `start-button` | Lobby, **host only** | requests the start. The spec asserts `toHaveCount(0)` on a guest, so it must be absent from a guest's DOM, not merely disabled |
| `race-canvas` | Race screen | the canvas `startShell` renders into |
| `lap-counter` | Race screen | the HUD's lap text, e.g. `"2/3"` — matched against `/[1-3]\s*\/\s*3/` |
| `results` | Results screen | present and visible once the race finishes |
| `solo-button` | Title screen | dispatches `{ kind: 'soloPressed' }` |

*`solo-button` added 2026-08-15, an eleventh, by Plan 5.* Its offline spec is a **build
gate** (ruling F-P5-26: offline solo is a requirement, not a nice-to-have), and without a hook
on the solo control that spec has nothing to drive — a gating test that cannot reach the thing
it gates is the failure this project keeps finding. `soloPressed` is already an `AppEvent`
(§5.9), so unlike ready and start this one is fully Plan 3's to wire.

Four of them name behaviour Plan 3 does not own: `room-code-input` /
`room-code-submit` reach a room that only Plan 4 mints, and `ready-button` /
`start-button` are lobby traffic §12 puts in Plan 4. **Plan 3's obligation is the
element and the hook on the right screen** — `hostPressed`, `joinPressed` and
`roomCodeEntered` are already `AppEvent`s (§5.9); ready and start have no
`AppEvent` yet and are Plan 4's to add. A hook on an element that does nothing
yet is still the contract being met, because what the E2E asserts is that the
adapter put the control where the model says the screen is.

**These names are a cross-plan contract and renaming one silently breaks an E2E
suite in another plan.** They are `data-testid` rather than class names or DOM
structure for the reason Plan 4 states: a class is styling and moves, a
`data-testid` is a contract and does not. `startShell` is an adapter and is
untestable in vitest by construction (§8.2) — it is the one place `HudModel` and
`AppState` become DOM — so these hooks are the *only* mechanical check that the
adapter wired the model to the screen at all.

`join-and-race.spec.ts` is **not** `test.skip`ped while it waits: it fails, and
each failure names the missing hook (`waiting for getByTestId('host-button')`).
That is deliberate on Plan 4's side and it is why the dependency is worth
honouring here — a skipped end-to-end asserts nothing while looking like it
asserts everything, and the visible red is what makes this row of the table a
real obligation rather than a note. A testid that does not match is the same
silent failure as a mismatched CSS selector, which is precisely what the scheme
exists to prevent, so **do not "improve" a name**: change it in Plan 4's fixture
first, or not at all.

Two behaviours the spec depends on beyond the names, stated so they are not
discovered as flakes: the lobby's `room-code` must render the code as text a
`textContent` read can uppercase and match, and a join for a room that does not
exist must surface a visible error matching `/not found|no such room|invalid/i`
rather than a spinner — the shell already has to handle that path, Plan 4 merely
asserts it.

### 5.14 `src/vite-env.d.ts` — the one declaration that makes `import.meta.env` type-check

```ts
/// <reference types="vite/client" />
```

That single line is the whole file, and it is the only place either package
references Vite's types. It is what makes `import.meta.env.DEV` (§5.11) and
`import.meta.env.DEV` compile under `tsc --noEmit`, and it costs `vite` as a
devDependency of `packages/game` (§10). It is **not** needed by
`packages/content`, which uses no Vite feature at all (§3a.1).

### 5.15 `src/index.ts` — the barrel

Re-exports `clock`, `controls/types`, `controls/config`, `controls/tilt`,
`controls/composite`, `controls/index`, `settings`, `app`, `results`,
`session`, `localinput`, `view` — **12** modules. There is no `content/`
directory in `game` at all any more (§5.2 – §5.4), and no `roomcode` either
(§5.8): room codes are `@tapkart/protocol`'s. **Not** `controls/source` and
**not** `shell` — both are DOM adapters (§8.2) — and **not**
`controls/thumbzones`, `controls/stick` or `controls/keyboard`, whose
factories reach the outside world only through `makeControlAdapter`.
(`controls/tilt` *is* re-exported, because `Settings` names `TiltCalibration`
and the screens call `calibrateTilt`; `makeTiltAdapter` rides along and is
harmless.) As in `render`, a test asserts that no two re-exported modules
export the same name.

*Amended 2026-08-14: this list named 13 modules, including `roomcode`. §5.8's
retirement drops it to 12.*

---

## 6. Three numbers that must agree, or nothing works

### 6.1 The tick is 60 Hz and `game` never invents a different one (Q8)

`session.tickOnce` is called exactly `advanceAccumulator()` times per frame, once
per 60 Hz sim tick. **`ClientLoop` owns the 30 Hz input send cadence and the
`INPUT_REDUNDANCY = 8` window internally** (`client.ts:314-323`,
`INPUT_SEND_INTERVAL_TICKS = 2`); `game` does not throttle, batch or skip calls to
`tickOnce`, and does not send anything itself on a guest. That is exactly the
design `AuthorityLoop` was built to mirror, and it keeps the network cadence out
of the shell.

The host's own input is submitted once per tick too: the caller stamps
`intent.tick = state().tick + 1` and calls `submitLocalInput(playerId, intent)`
(§5.10a). The decorator itself emits at 30 Hz, on even ticks, and carries
odd-tick boolean pulses forward. The strictly increasing intent tick is what
`AuthorityLoop` keys on.

### 6.2 `alpha` is the sub-tick fraction and it is used for exactly three things

Camera sub-tick blending, the Q9 lerp of state-sourced seats and entities
(§5.11 step 3), and `renderNowMs`. Nothing else. It is always in `[0, 1)`, always
`acc.residualMs / TICK_MS`, and the lerp it drives **never writes back into a
`SimState`**.

### 6.3 The interpolator timebase — made unbreakable rather than merely documented (Q7)

`ClientLoop` stamps every keyframe:

```ts
this.remoteInterp.push({
  recvAtMs: this.predicted.tick * TICK_MS,
  karts: cloneWireKarts(this.decodeTarget.karts),
  entities: cloneWireEntities(this.decodeTarget.entities),
  entityCount: this.decodeTarget.entityCount,
})
```

So `RemoteInterpolator`'s notion of "now" is **sim time — tick × 16.667 ms** —
not `performance.now()`. `sampleKart` subtracts `REMOTE_INTERP_DELAY_MS = 100`
from whatever it is passed and looks for bracketing keyframes.

**Therefore the only legal argument is `renderNowMs(session.state().tick,
alpha)`.** Pass `clock.nowMs()` instead and the target instant is thousands of
milliseconds past the newest keyframe on the very first frame, so **every** remote
kart takes the extrapolation branch, clamps at `REMOTE_EXTRAPOLATE_CAP_MS`, and
slides 200 ms along its last velocity forever. Nothing throws. Nothing logs. It
merely looks wrong on a device, which is the one place CI cannot see (spec §8).

The draft stated this as a rule for callers. This contract removes the caller's
opportunity instead: **`nowMs` is not a parameter of anything in `game`'s public
surface.** `ViewBuilder.build(alpha, out)` computes it internally, and
`ViewBuilder` is the only thing that ever calls `sampleRemoteKart` or
`sampleRemoteEntity`. A task cannot pass the wrong clock because it is never
handed the chance. §8.1 still asserts the behaviour, because a future refactor
could reopen the hole.

---

## 7. Sole-writer rules

### 7.1 The seat-source rule — spec §5, made mechanically checkable

Spec §5, verbatim:

> Remote karts and all world entities are not predicted. They are buffered and
> rendered approximately 100ms in the past with interpolation, extrapolating
> briefly and with a hard cap when the buffer starves.

This is **the central invariant of Plan 3**. Q5 is what makes it checkable rather
than aspirational: with `RemoteSample.kart` carrying the authoritative `WireKart`,
a renderer needs nothing from the predicted state for a remote seat, so the rule
becomes exact — **the renderer reads the LOCAL seat from `ClientLoop.state()` and
every OTHER seat from the interpolator, and never both.**

Resolved per role, per seat:

| Role | Local seat | Remote seats | Entities | Item boxes |
|---|---|---|---|---|
| `solo` | `state()` → `'authoritative'` | `state()` → `'authoritative'` | `state()` → `'authoritative'` | `state()`, unpoliced |
| `host` | `state()` → `'authoritative'` | `state()` → `'authoritative'` | `state()` → `'authoritative'` | `state()`, unpoliced |
| `guest` | `state()` → `'predicted'` | `sampleRemoteKart(…, out)` true → `'interpolated'`; **false** → `'absent'` | `sampleRemoteEntity(…, out)` true → `'interpolated'`; a **false** id simply not listed | `state()`, unpoliced |

*Amended 2026-08-14 (ruling P2-R29): the guest row read `null → 'absent'` and
`sampleRemoteKart()` / `sampleRemoteEntity()` without an `out`. Both methods take
a caller-owned buffer and return a boolean now (§2.5), so the rule's trigger is a
`false`, not a `null`. The rule itself is unchanged — a seat that could not be
sampled is `'absent'`, never filled from the predicted state — but the failure
mode it guards against got quieter: `null` could not be read by accident, and a
stale buffer can. Reading a buffer after `false` puts **another seat's**
authoritative `WireKart` on this seat, `source: 'interpolated'` and all, which
`viewSourceViolations` cannot see because every source label is legal.*

A host's `AuthorityLoop.state()` *is* the authority, so drawing every seat from
it is not a violation — the prohibition is on drawing a **client's local
prediction of somebody else's kart**, which on a guest is literally the sim's own
bot AI driving that seat (`packages/net/src/client.ts:150-153`: *"the other seven
seats are driven by the sim's own bot AI (never trusted, never rendered)"*).

**Every discrete field of a guest's remote seat is read from `sample.kart`,
verbatim off the wire** (Q5): `lap`, `checkpointIdx`, `t`, `item`, `connected`,
`isBot`, `spinOutTicks`, `invulnTicks`, `boostTicks`, `respawnTicks`, `shielded`,
`driftActive`, `driftCharge`, `driftDir`, `airborne`, `surface`. Only `position`
and `heading` come from the interpolation itself, and `velocity` and
`angularVelocity` come from `sample.kart` as well. Nothing is mixed: a
`KartView` is filled from exactly one source, and its `source` field says which.

**A guest's `phase` is authoritative** (R44): it arrives in every snapshot, so the
countdown overlay, the race clock and the results screen behave identically in
every role. Nothing derives phase from event history any more.

**Item boxes are the one thing this rule does not cover, and that is deliberate.**
`WireSnapshot` carries no item-box state at all (§2.3), so a guest has no
authoritative source to check against; its boxes come from the predicted state,
where the local bot sim can start a timer the authority never started. Two things
keep that from mattering: every real pickup arrives as an authoritative
`itemGrant` event, and `applyItemGrant` starts the box's respawn timer on the
receiver (`packages/sim/src/items.ts:148-159`, reached through
`applyEvent`); and a wrong box is a cosmetic ghost, not a wrong race. `ItemBoxView`
therefore has **no `source` field** and `viewSourceViolations` says nothing about
boxes — there is no rule to state, so none is faked.

**R45 records the price of the alternative, so nobody "fixes" this later.** Putting
box state on the wire costs roughly 8 bits × 16 boxes = **128 bits**, against a
snapshot that is 180 bits after R44's phase field. It would nearly double the
per-snapshot cost, at 20 Hz, for every peer — to correct an inaccuracy that is
cosmetic only: a box drawn as available a few hundred milliseconds before it truly
is. The reliable `itemGrant` stream already corrects every box a real player took.
That trade is not close.

#### `viewSourceViolations`, specified exactly

Two independent implementations of this must produce identical output, so nothing
below is left to taste.

```ts
export function viewSourceViolations(view: RaceView, role: ViewRole): string[]
```

Checks, in this order, appending at most one message per subject:

1. **Local seat identity.** If `role === 'guest'` and
   `!(view.localPlayerId >= 0 && view.localPlayerId < MAX_KARTS)`, append
   `` `localPlayerId ${view.localPlayerId} is illegal for role 'guest'` `` and
   **return immediately** — no per-seat check is meaningful without a local seat.
2. **Karts**, ascending seat index `i` from 0 to `MAX_KARTS - 1`. Expected set:

   | Role | Seat | Allowed `source` |
   |---|---|---|
   | `host`, `solo` | any | `'authoritative'` |
   | `guest` | `i === localPlayerId` | `'predicted'` |
   | `guest` | otherwise | `'interpolated'` or `'absent'` |

   On mismatch append exactly:
   `` `kart[${i}]: source '${actual}' is illegal for role '${role}' (expected ${expected})` ``
   where `expected` is the allowed values in the table's order, single-quoted and
   joined with `' or '` — e.g. `'interpolated' or 'absent'`.
3. **Entities**, ascending slot `j` from 0 to `MAX_ENTITIES - 1`. For
   `j < view.entityCount` the allowed source is `'authoritative'` on host/solo and
   `'interpolated'` on a guest; for `j >= view.entityCount` the slot must be
   `entityId === -1` and `source === 'absent'`, in every role. On mismatch append
   `` `entity[${j}] (id ${entityId}): source '${actual}' is illegal for role '${role}' (expected ${expected})` ``
   and, for a live slot with `entityId < 0` or a dead slot with `entityId >= 0`,
   `` `entity[${j}]: entityId ${entityId} is illegal at slot ${j} with entityCount ${view.entityCount}` ``.

Returns `[]` when there is nothing to report. It allocates, is not called in the
frame path in a production build, and is exported from `render` — not hidden in a
test file — precisely so the CI test (§8.1) and the dev-build assertion (§5.11,
Q32) run the same code rather than two readings of one table.

### 7.2 Every other sole writer

| Field / object | Sole writer | Nothing else may assign it |
|---|---|---|
| `SimState` (any field) | `@tapkart/net`'s loops, via `step`/`applyEvent` | `render` holds no reference; `game` writes it only through `session.tickOnce` |
| `RaceView` (any field) | `ViewBuilder.build` | `render` mutates nothing it is handed |
| `KartView.source` | `ViewBuilder.build` | — |
| `KartView.place` | `ViewBuilder.build`, from `computePlacement` | nothing re-derives an ordering; the HUD reads `place` |
| `KartView.driftTier` | `ViewBuilder.build`, from `driftTierFor` | the only call site of `driftTierFor` in Plan 3 |
| `CameraState` | `updateCamera` | `buildRenderFrame` reads the camera and copies it into the frame |
| `RenderFrame` | `buildRenderFrame` | the adapter reads only |
| `RenderFrame.sourceTick` / `KartDraw.wheelSpin` | `buildRenderFrame` | the two accumulator fields; nothing else touches them |
| `HudModel` | `buildHudModel` | — |
| `AudioModel` | `buildAudioModel` | — |
| `AppState` | `reduceApp` | no screen module mutates it |
| `Intent` (the one `game` submits) | the active `ControlAdapter.sample` — which is always a `CompositeAdapter` | sub-adapters write only their own scratch (§5.5) |
| `TickAccumulator` | `advanceAccumulator` | — |
| `VisualOffset` | `advanceVisualOffset` | applied to `KartView` by `ViewBuilder`, local seat, guest only; **never** written into a `SimState` (R41) |
| The Three.js scene graph | the object returned by `createThreeRenderer` | — |
| Road-surface geometry | `buildTrackMesh` | — |
| Item-box world position | `itemBoxWorldPos` (sim) | drawn box and pickup volume are one object |
| Placement order | `computePlacement` (sim) | §5.11 step 9 fills a scratch state rather than re-implementing the comparator |
| `Settings` persistence | `saveSettings` | — |

### 7.3 Scratch-object discipline, restated because `render` and `game` are the first packages likely to break it

`ctx.query.sampleAt`, `tangentAt` and `project` return **the same object every
call** (`packages/sim/src/track.ts:463-490`, and the doc comment says so). A mesh
builder that writes

```ts
const a = query.sampleAt(s0)
const b = query.sampleAt(s1)   // `a` is now `b`
```

produces a degenerate ribbon and no error. Every `render` and `game` call site
copies the fields it needs before the next query call — including §5.11 step 6's
`bankAngle` and §4.3's every ring. `itemBoxWorldPos` calls both `sampleAt` and
`tangentAt` internally, so it invalidates the scratch too. A test that builds a
mesh and asserts non-degenerate triangle area catches this, and is required.

*Amended 2026-08-14 (ruling P2-R29): `@tapkart/net`'s two remote samplers are now
under this same discipline, from the other side of it. `sampleKart(playerId,
nowMs, out)` and `sampleEntity(entityId, nowMs, out)` fill a **caller-owned**
buffer rather than returning a fresh object, for the per-frame reason
`liveEntityIds` always took an `Int32Array` (§2.5). Three rules follow, and none
of them is optional:*

- ***The buffer is allocated once, at construction*** — `makeRemoteSample()` and
  `makeRemoteEntitySample()` in `createViewBuilder` (§5.11). A buffer made inside
  the loop is the allocating form with extra steps, and it will pass every test.
- ***One buffer, reused across seats, is correct*** — every field is copied into
  the `KartView` before the next call, exactly as `sampleAt`'s result is. This is
  the same rule as the paragraph above, and the same test discipline applies:
  sample two seats and assert the first one's view fields did not follow the
  second.
- ***A `false` return leaves the buffer holding the previous subject***, not
  zeroes. `sampleAt` at least always writes something; a refused sample writes
  nothing, so the stale read is a *plausible* kart rather than a degenerate one.
  Treat `false` as "nothing to draw" and never as "reuse what is there".

*`out.kart` and `out.entity` are a further hazard of the same family, and they
were one before this change too: each is a **reference into the interpolator's
retained keyframe**, not a copy, valid only until `REMOTE_BUFFER_CAPACITY`
further pushes evict it, and never to be mutated. §5.11's `build` copies every
field it needs in the same frame, which is why this has no consequence in Plan 3
— but it is the reason nothing may stash a `RemoteSample` and read it a frame
later.*

---

## 8. Headless testability — how, explicitly

Spec §8 gives `render` one line — *"Scene-graph assertions against a mocked
renderer; visuals are owner-verified"* — and a "What CI cannot verify" section
naming only phone feel and the NFC tap. This section says what that means
concretely, because the difference between a testable and an untestable render
package is decided entirely by where the seam sits.

### 8.1 What is a pure function over state that a test asserts

Every one of these is a plain function, run under `environment: 'node'`, with no
canvas, no GPU, no DOM and no clock (Q30):

| Pure surface | The assertion CI makes |
|---|---|
| `buildTrackMesh` | vertex and index counts match §4.3's stated layout; every triangle has non-zero area; **every generated vertex's `y` is within `1e-3` m of `query.groundHeight(s, lateral)` for its own `(s, lateral)`**, with `s = arcAt(table, t) / table.total` for that vertex's ring and `lateral` from its step index; `meshBounds(mesh)` sits inside `track.bounds`. Run over **all six shipped tracks** (Q34) |
| `buildBoostPadMesh` / `buildRampMesh` | quad count equals `track.boostPads.length` / `track.ramps.length`; **zero ramps yields five zero-length arrays, not a throw** (`neon-district`) |
| `buildEdgeMarkers` | post count matches `round(totalLength / spacing)` per side within one; `colorIdx` alternates from 0 on each side independently; every post's `y` equals `groundHeight` at its own `(s, lateral)` to `1e-3`; both sides present on all six tracks |
| `buildKartMesh` / `buildCharacterMesh` | deterministic vertex counts per descriptor; `meshBounds` matches the descriptor's declared dimensions to `1e-6` |
| `parseTrack` / `parse*Descriptor` / `parseTrackTheme` | every shipped file parses; a fixture mutated one field at a time throws with a message naming that field |
| `updateCamera` | converges monotonically toward the target pose; identical output for identical `(state, ticks)`; **N calls with 1 tick equal 1 call with N ticks** to `1e-9`; `ticks = 0` is a no-op |
| `buildRenderFrame` | given a hand-built `RaceView`, exact `KartDraw` values per §4.7's table; an invulnerable kart flickers `alpha` on the stated period; a shielded kart sets `shieldVisible`; slot `entityCount` is `visible: false`; a `'surge'` entity is never visible; **a spun-out kart's `heading` equals the view's heading exactly** (no double spin) |
| `bubblePosition` | reproduces `sim`'s bubble position exactly: spawn a bubble in a real `SimState`, run `updateEntities`, and assert `bubblePosition(owner.position, e.heading, out)` equals `e.position` to `1e-9` |
| `BUBBLE_ORBIT_RADIUS_M` | **required, and it is what keeps §4.7's copied constant honest**: measure `hypot(e.position.x - owner.position.x, e.position.z - owner.position.z)` from that same real bubble and assert it equals `BUBBLE_ORBIT_RADIUS_M` to `1e-9` |
| `surgeAffects` | agrees with `surgeActiveOn(state, playerId)` for a host state carrying a live surge, for every seat, including the caster (false) and a kart behind it (false) |
| `buildHudModel` | `place` is 1-based; `lap` is `clamp(lap + 1, 1, RACE_LAPS)`; `countdownLabel` walks `3,2,1,GO` across `COUNTDOWN_TICKS`; `speedKph` is `speed * 3.6` rounded; `motionLocked` agrees with sim's `motionLocked` on the local kart |
| `formatRaceClock` | `0 → '0:00.000'`; `3661 → '1:01.017'`; monotonic in `ticks` |
| `isDnf` / `buildResultRows` | a grace-expiry finish marks every short-of-`RACE_LAPS` kart DNF and no one else; an all-finished race marks nobody, at any tick after the finish |
| `buildAudioModel` | a lap crossing between two views fires exactly one `lapCross` cue and no others; more than `MAX_AUDIO_CUES` cues in one frame drops rather than grows |
| every `ControlAdapter.sample` | a scripted `ControlInputs` sequence produces an exact `Intent` sequence; `steer` always in `[-1, 1]`, `accel` in `[0, 1]`; `useItem` is true on exactly one tick per press (Q25); a drift hold of `BRAKE_HOLD_TICKS` with `|steer| < DRIFT_STEER_MIN` sets `brake` and one with `|steer| >= DRIFT_STEER_MIN` does not (Q21); a touch in the inter-button gap presses neither button (Q24); `reset()` clears every latch |
| `mergeIntents` | max-magnitude steer with keyboard winning ties; `accel` max; three ORs — asserted as a table, not by example |
| `reduceApp` | every entry in `SCREEN_TRANSITIONS` is reachable; every event not in the table returns `prev` **by reference**; `prev` is never mutated |
| `advanceAccumulator` | 16.67 ms yields 1 tick; 1000 ms yields `MAX_CATCHUP_TICKS` and discards the rest; residual always `< TICK_MS`; `accumulatorAlpha` always in `[0, 1)` |
| `loadTrack` / `TRACK_MANIFEST` | all six ids load; `TRACK_MANIFEST` equals the six ids ascending; each loaded `Track` deep-equals the same file read with `node:fs`; **and the manifest matches the contents of `content/tracks/` on disk**, so a forgotten static import (§3a.1) fails immediately |
| `loadContentBundle` | 8 characters, 8 karts, 6 themes; every theme's `trackId` is in `TRACK_MANIFEST`; both descriptor arrays sort by `id` and pair by index |
| `TUNING` / `CHARACTERS` | **field-by-field equality against `makeTuning()` and `makeCharacters()`** (Q1) — mandatory, and it lives in `packages/content/test/` (R46) |
| `advanceVisualOffset` | a 5 cm / 0.05 rad correction is fully applied on the correction tick and **both channels are zero** after `ERROR_SMOOTH_WINDOW_TICKS`; both magnitudes decrease monotonically in between and share one eased fraction; a 30 m delta zeroes instead of easing, and so does a 0.5 rad one — **either guard cuts both channels**; a `0` heading delta still resets the window while `null` does not; `ticksElapsed = 0` changes nothing; N calls of 1 tick equal 1 call of N ticks |
| `ERROR_SMOOTH_MAX_HEADING_RAD` | the peak apparent yaw rate the smoother can produce, `3 * ERROR_SMOOTH_MAX_HEADING_RAD / (ERROR_SMOOTH_WINDOW_TICKS * TICK_DT)`, is **below `TUNING.steerRateBase`** — so smoothing can never out-yaw the car's own steering and read as the car steering itself |
| `easeRemaining` | `easeRemaining(0) === 1`, `easeRemaining(1) === 0`, clamped outside `[0, 1]`, and its derivative at 1 is 0 (the kart settles rather than arriving) |
| error smoothing, end to end | drive the §8.1 flagship guest session, record the drawn local position every frame, and assert **no frame-to-frame jump exceeds one tick of plausible travel** — the R41 defect, made visible. Without the smoother this fails ~3 times a second under changing input |
| `viewSourceViolations` | **the flagship**: run a guest `ClientLoop` and a host `AuthorityLoop` over `makeLoopbackPair` at 150 ms / 50 ms / 5 % for 600 ticks, build a view every frame, assert `[]` every time **and** assert at least one seat actually reported `'interpolated'` and at least one entity did too, so an all-`'absent'` view cannot pass |
| `renderNowMs` vs the interpolator | drive that same guest session and assert a remote sample is **not** pinned at `REMOTE_EXTRAPOLATE_CAP_MS` — the §6.3 failure, made visible — and that passing `clock.nowMs()` instead *would* pin it |

**The mesh tolerance is `1e-3` world units — 1 mm — and it is stated once, here**
(Q31). The two paths differ only in float ordering, so the real disagreement is
many orders of magnitude smaller; 1 mm is loose enough never to flake and far
tighter than any error a genuine mesh bug would produce. Two tasks picking two
tolerances is how a suite ends up with a 1 cm assertion nobody can justify.

### 8.2 What is the thin untestable draw layer

Exactly four files, and CI never imports any of them:

- `packages/render/src/three/renderer.ts` — the only `three` import.
- `packages/render/src/three/*` — any further Three-side helpers.
- `packages/game/src/controls/source.ts` — DOM event listeners,
  `deviceorientation`, the iOS permission call.
- `packages/game/src/shell.ts` — `requestAnimationFrame`, canvas sizing, DOM
  mounting, the orientation overlay.

**Neither package's barrel re-exports any of them.** This is not tidiness; it is
what keeps `import { buildRenderFrame } from '@tapkart/render'` resolvable under
vitest's `environment: 'node'`. A barrel that re-exported `three/renderer.ts`
would pull `three` — and, transitively, a WebGL context — into every headless test
in the repository, and the failure appears as an unrelated suite breaking.
`verbatimModuleSyntax` does **not** save this: a value import of `three` survives
erasure. Even `import type { Scene } from 'three'` is banned outside `src/three/`
so a later refactor cannot quietly turn it into a value import.

`RendererBackend` lives in `backend.ts`, which imports nothing but sibling types,
so the mock backend a test uses is a plain object literal and the scene-graph
assertions spec §8 asks for are made against `applyFrame`'s argument.

**Q30: `environment: 'node'` everywhere. No jsdom, and no per-file
`@vitest-environment` override.** §8.2's seam exists to make that true, and it is
the load-bearing decision behind the whole "rendering is testable headlessly"
claim. **If any task believes it needs jsdom, that is a signal the seam is in the
wrong place** — the fix is to move the boundary, not to change the environment. A
per-file override slipped in by one task silently converts a global guarantee into
a per-file accident.

### 8.3 What CI cannot verify — restated for this plan

Spec §8 names two. Plan 3 adds the ones specific to rendering, so nobody later
mistakes their absence for an oversight:

- **How the game feels on a real phone** (spec §8) — frame pacing, touch latency,
  whether the chase camera is nauseating, whether 28 % full-lock is right.
- **The NFC tap** (spec §8) — Plan 5's, and two physical devices.
- **That the pixels are correct.** CI proves `RenderFrame` is right and that the
  adapter was handed it. It cannot prove Three.js drew it, that the shader
  compiled, or that the kart is not inside the road. Owner-verified.
- **That the phone sustains authority loop plus 3D render** (spec §11's first
  risk). Measurable only on device.
- **Audio.** `AudioModel` is asserted; nothing is audible in Plan 3 at all (Q26).

Adding a test that needs a GPU, a headless browser or a canvas to the vitest suite
is out of scope for Plan 3 by this contract. Playwright E2E (spec §8's last row)
is a separate lane and is **Plan 4's**, because it needs two browser contexts
joining by code, and there is no server to join until then.

---

## 9. Test fixtures and the golden frame

### 9.1 Fixtures

```ts
// packages/render/test/fixtures/render-fixtures.ts
export function makeRenderContext(): SimContext        // relative import of sim's fixtures, per §2.6
export function makeKartView(overrides?: Partial<KartView>): KartView
export function makeRaceView(overrides?: Partial<RaceView>): RaceView
export function makeThemeFixture(): TrackTheme
export function makeCharacterDescriptorFixture(): CharacterDescriptor
export function makeKartDescriptorFixture(): KartDescriptor
/** Loads a real shipped track off disk with node:fs. Test-only; src never does. */
export function loadShippedTrack(id: string): Track
export const SHIPPED_TRACK_IDS: readonly string[]      // the six, ascending, for it.each
```

```ts
// packages/game/test/fixtures/game-fixtures.ts
export function makeGameContext(isLeader?: boolean): SimContext
/** A guest session whose ClientLoop has taken N corrections, for R41's smoothing
 *  tests: drives makeSessionPair with a changing (sine) intent, which is what
 *  actually produces corrections — a held-steady intent produces ~1 per 600 ticks. */
export function makeCorrectingGuest(ticks?: number):
  { host: RaceSession; guest: RaceSession; pump(nowMs: number): void; corrections(): number }
export function makeControlInputsFixture(overrides?: Partial<ControlInputs>): ControlInputs
export function makeSettingsFixture(overrides?: Partial<Settings>): Settings
export function makeLobbySlots(humanIds?: readonly number[]): LobbySlot[]
/** Host + guest over ONE shared loopback pair at spec §8's conditions, with the
 *  guest's seat marked isBot=false, connected=true on the HOST's state — without
 *  that flip, resolveInputs drives the guest's seat with bot AI on the authority
 *  (§2.4 fact 2) and the flagship test measures nothing. */
export function makeSessionPair(opts?: Partial<LoopbackOptions>):
  { host: RaceSession; guest: RaceSession; pump(nowMs: number): void }
```

`makeSessionPair`'s default `LoopbackOptions` is Plan 2's:
`{ latencyMs: 150, jitterMs: 50, lossRate: 0.05, seed: 0xC0FFEE }`. The host side
wraps its loopback transport with `withLocalInput` (§5.10a); the guest's
`ClientLoop` needs no wrapper, since `tick(localIntent)` already takes one.
There is **no `makeFetchJson`** — Q12 deleted the seam it existed for.

### 9.2 The golden `RenderFrame` fixture (Q33)

Yes, and **only over the derived-geometry subset**, and it lands in the plan's
**final task**. Both halves of that are load-bearing: it is the strongest
available regression net for `buildRenderFrame`, and it would otherwise freeze
the visual constants Plan 3 exists to tune by eye. Placing it last means it
freezes them *after* they are tuned, which is the only ordering in which it is a
net rather than a nuisance.

```ts
// packages/render/test/fixtures/golden-frame.ts
/** The covered subset, serialised deterministically: one line per record, keys
 *  in the order below, every number via `toFixed(6)`. Anything not listed is
 *  NOT in the fixture. */
export function serializeDerivedFrame(frame: RenderFrame, hud: HudModel): string
export const GOLDEN_FRAME_FILE = 'packages/render/test/fixtures/golden-frame.txt'
```

| Covered (derived from simulation state) | Not covered (visual tuning) |
|---|---|
| `KartDraw`: `playerId, visible, position, heading, roll, wheelSpin, steerAngle, alpha, driftSparkTier, boostFlame, shieldVisible` | `bodyTint` and every palette |
| `EntityDraw`: `entityId, kind, visible, position, heading, scale` | `tint`, `alpha` |
| `CameraState`: `position, lookAt, up, fovDegrees, mode` | — |
| `HudModel`: `place, lap, speedKph, countdownLabel, raceClock` | — |
| `itemBoxAlpha` | `screenFlash`, `screenTintColor`, `screenTintAmount` |
| — | marker spacing, bloom, fog, every theme number |

---

## 10. Package manifests, tsconfigs, and the three root files Plan 3 edits

```jsonc
// packages/content/package.json          — R46, new
{ "name": "@tapkart/content", "version": "0.1.0", "private": true, "type": "module",
  "exports": { ".": "./src/index.ts" },
  "dependencies": { "@tapkart/sim": "*" },
  "scripts": { "typecheck": "tsc --noEmit -p tsconfig.json" } }

// packages/render/package.json
{ "name": "@tapkart/render", "version": "0.1.0", "private": true, "type": "module",
  "exports": { ".": "./src/index.ts", "./three": "./src/three/renderer.ts" },
  "dependencies": { "@tapkart/sim": "*", "@tapkart/content": "*", "three": "0.180.0" },
  "scripts": { "typecheck": "tsc --noEmit -p tsconfig.json" } }

// packages/game/package.json
{ "name": "@tapkart/game", "version": "0.1.0", "private": true, "type": "module",
  "exports": { ".": "./src/index.ts", "./shell": "./src/shell.ts" },
  "dependencies": { "@tapkart/sim": "*", "@tapkart/protocol": "*",
                    "@tapkart/net": "*", "@tapkart/content": "*",
                    "@tapkart/render": "*" },
  "devDependencies": { "vite": "^7.0.0" },
  "scripts": { "typecheck": "tsc --noEmit -p tsconfig.json" } }

// apps/web/package.json
{ "name": "@tapkart/web", "version": "0.1.0", "private": true, "type": "module",
  "dependencies": { "@tapkart/game": "*", "@tapkart/render": "*" },
  "devDependencies": { "vite": "^7.0.0" },
  "scripts": { "dev": "vite", "build": "vite build",
               "typecheck": "tsc --noEmit -p tsconfig.json" } }
```

`three` is pinned **exactly** — no caret (Q10). The second `exports` entry in each
package is how the DOM adapter stays reachable to the app that needs it while
staying out of the headless barrel (§8.2).

### 10.1 tsconfigs — DOM is widened per package, never in the base (R35)

`tsconfig.base.json` has `"lib": ["ES2022"]` and **no DOM**, which is correct and
stays that way: `sim`, `protocol` and `net` must remain DOM-free, because a DOM
type leaking into `sim` is how a "pure" package silently acquires a browser
dependency. But `HTMLCanvasElement`, `PointerEvent`, `DeviceOrientationEvent`,
`EventTarget` and `localStorage` are all unresolvable under that base, so Plan 3's
three DOM-touching projects widen `lib` **in their own tsconfig only**:

```jsonc
// packages/render/tsconfig.json   AND   packages/game/tsconfig.json
{ "extends": "../../tsconfig.base.json",
  "compilerOptions": { "lib": ["ES2022", "DOM", "DOM.Iterable"] },
  "include": ["src/**/*.ts", "test/**/*.ts"] }

// packages/content/tsconfig.json — NO DOM lib: `server` imports this package,
// and a DOM type here is how a server-side package acquires a browser
// dependency. resolveJsonModule is what makes §3a.1's static imports type-check,
// and it is needed by no other package.
{ "extends": "../../tsconfig.base.json",
  "compilerOptions": { "resolveJsonModule": true },
  "include": ["src/**/*.ts", "test/**/*.ts"] }

// apps/web/tsconfig.json
{ "extends": "../../tsconfig.base.json",
  "compilerOptions": { "lib": ["ES2022", "DOM", "DOM.Iterable"] },
  "include": ["src/**/*.ts", "vite.config.ts"] }
```

`packages/sim`, `packages/protocol`, `packages/net` and `packages/content` keep
`lib: ["ES2022"]` — no DOM, ever. Those four are the packages `server` imports. Every other compiler option comes
from the base: `strict`, `noUnusedLocals`, `noUnusedParameters`,
`verbatimModuleSyntax`, `isolatedModules`, `moduleResolution: "Bundler"`,
`noImplicitOverride`, `noImplicitReturns`, `noFallthroughCasesInSwitch`.

### 10.2 The three root files Plan 3 edits, and nothing else

1. **`package.json` — `workspaces` gains `"apps/*"`** (R36). It is
   `["packages/*"]` today, so without this `@tapkart/game` does not resolve by
   bare specifier from `apps/web` and any task that assumed it would was
   typechecking nothing.

   ```jsonc
   "workspaces": ["packages/*", "apps/*"]
   ```

2. **`vitest.config.ts` — `include` gains the apps glob** (R37):

   ```ts
   include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts']
   ```

   `environment: 'node'`, `globals: false` and `reporters: ['default']` stay
   exactly as they are (Q30).

3. **`apps/web/`** is created: `index.html`, `src/main.ts` (which calls
   `startShell` and nothing else), `vite.config.ts`, `package.json`,
   `tsconfig.json`.

   ```ts
   // apps/web/vite.config.ts
   export default defineConfig({
     server: {
       port: 5173,
       // content/ lives at the repo root, OUTSIDE this Vite root, and
       // §3a.1's static JSON imports reach it. Without this the dev server
       // refuses to serve them.
       fs: { allow: ['../..'] },
     },
   })
   ```

**Q11: `apps/web` is in Plan 3, but only the thin shell.** A plan that ships two
libraries and an exported `startShell` nobody calls has not produced working,
testable software, which is the bar the plan structure exists to meet. Plan 3 must
end with something a human can open in a browser and play. **Deferred to Plan 5:**
PWA manifest, service worker, offline caching, Dockerfile, CI publish — those are
deploy concerns and they travel with the deploy plan.

---

## 11. Exported-symbol census

| Module | Count |
|---|---|
| `content/tuning` | 2 |
| `content/descriptors` | 5 |
| `content/theme` | 4 |
| `content/tracks` | 5 |
| `content/bundle` | 2 |
| **`content` subtotal** | **18** |
| `render/types` | 8 |
| `render/mesh` | 15 |
| `render/descriptors` | 2 |
| `render/camera` | 6 |
| `render/frame` | 18 |
| `render/hud` | 8 |
| `render/audio` | 9 |
| `render/smoothing` | 7 |
| `render/backend` | 2 |
| `render/three/renderer` | 3 |
| **`render` subtotal** | **78** |
| `game/clock` | 5 |
| `game/controls/types` | 9 |
| `game/controls/config` | 11 |
| `game/controls/tilt` | 4 |
| `game/controls/thumbzones` | 1 |
| `game/controls/stick` | 1 |
| `game/controls/keyboard` | 1 |
| `game/controls/composite` | 2 |
| `game/controls/index` | 1 |
| `game/controls/source` | 3 |
| `game/settings` | 7 |
| `game/app` | 7 |
| `game/results` | 3 |
| `game/session` | 3 |
| `game/localinput` | 1 |
| `game/view` | 2 |
| `game/shell` | 3 |
| **`game` subtotal** | **64** |
| **Total** | **160** |

*Amended 2026-08-14: `game/clock` read 9 and a `game/roomcode` row read 4,
subtotalling 72 and totalling 168. Ruling F-P4-7 (§5.1) moves
`MAX_CATCHUP_TICKS`, `TickAccumulator`, `createAccumulator` and
`advanceAccumulator` out of `game/clock` to `@tapkart/net`, dropping it to 5;
§5.8's retirement removes `game/roomcode` entirely, since room codes are
`@tapkart/protocol`'s and were never `game`'s to export. Net change: −8. This
is a correction against shipped code and the assembled plan, not a scope
change — no symbol Plan 3 ships moved into `game`'s count as a result.*

Plus **16** fixture exports in §9 (8 render, 2 golden-frame, 6 game), which are
test-only and not part of any package's public surface. `apps/web` exports
nothing: `src/main.ts` is an entry module, not a library. Seven symbols Plan 3
*uses* are counted against **Plan 2**, not here: `withLocalInput`,
`createNullTransport`, `LocalInputTransport`, `LOCAL_PEER_ID` (R42),
`correctionDeltaOf` (R47, R48), `makeRemoteSample` and `makeRemoteEntitySample`
(P2-R29) — all in §2.5.

*Amended 2026-08-14 (ruling P2-R29): that sentence read "Five symbols".
`makeRemoteSample` and `makeRemoteEntitySample` are new `@tapkart/net` exports
that Plan 3 calls — once each, in `createViewBuilder` (§5.11) — so they belong in
this list for the same reason the other five do. **The table above and its total
of 160 are unchanged**, and that is the point of recording it: P2-R29 re-signed
two `net` methods and added two `net` factories; it moved nothing into or out of
`content`, `render` or `game`, and no Plan 3 module gained or lost an export.
Anyone reconciling this census against a diff should find the delta entirely on
Plan 2's side of the line.*

The draft counted 117 across a materially different module map. The delta is not
scope creep, and it itemises:

| Change | Δ |
|---|---|
| `render/time` deleted; `renderNowMs` moved into `game/clock` (Q6 + §1) | −2, +1 |
| `FetchJson` and `makeFetchJson` deleted (Q12) | −1 |
| `driftTierOf` deleted — `driftTierFor` from sim is the only one (§2.2) | −1 |
| `trackIdFromGlobKey` deleted — static imports need no key parsing (§3a.1) | −1 |
| `withLocalInput`/`createNullTransport`/`LocalInputTransport`/`LOCAL_PEER_ID` moved to `net` (R42) | −4 |
| Q20's edge markers: `EdgeMarkerParams`, `EdgeMarkerPlacement`, `buildEdgeMarkers` | +3 |
| `TrackScene`/`buildTrackScene`/`ROAD_DECAL_LIFT` — what `setScene` actually takes | +3 |
| Q23's composite: `mergeIntents`, `makeCompositeAdapter`, four adapter factories | +6 |
| Q24/Q21's layout and brake constants + rect helpers | +8 |
| Q17's results module | +3 |
| Q26/R38's `AudioConfig`, `nullAudioBackend`, `MAX_AUDIO_CUES` | +3 |
| **R41's `render/smoothing` module** (position and heading, R48) | **+7** |
| §4.7's named frame constants (previously unnamed magic numbers) | +11 |
| Everything else — `ViewRole`, `HudStanding`, `CountdownLabel`, `Rect`, `MAX_POINTERS`, `SETTINGS_STORAGE_KEY`, `bubblePosition`, `surgeAffects`, `createSoloTransport`, etc. | the remainder |

**R46 moved 18 symbols rather than adding them**: `TUNING`, `CHARACTERS`, the
five descriptor types and parsers, the four theme symbols, the five track symbols
and the two bundle symbols left `game` and `render` for `content`. The total is
unchanged by the move; only its distribution is.

## 12. What Plan 3 deliberately does not build

Stated so a task does not "helpfully" add it:

- **No PWA manifest, no service worker, no offline caching, no Dockerfile, no CI
  publish.** `apps/web` in Plan 3 is `index.html` + entry module + Vite config + a
  dev server that runs (Q11). Everything else about shipping it is Plan 5's.
- **No WebRTC and no WebSocket transport.** Plan 2 built the interface and
  Loopback; Plan 4 builds the two real ones. A `guest` session in Plan 3 is a
  guest over `makeLoopbackPair`, which is exactly what spec §8's netcode tests use.
- **No signalling, no room registry, no server, no room-code minting.** Plan 4.
- **No NFC, no HCE, no App Links, no APK, no keystore.** Plan 5.
- **No audible audio.** The model and the seam are authored and tested; the
  backend is a no-op (Q26). Web Audio is Plan 5's.
- **No Playwright E2E.** Plan 4 (§8.3).
- **No scenery, no props, no buildings, no crowd** (Q20). A ribbon over a themed
  ground plane plus procedural edge markers is the whole visual budget.
- **No lap times, no best lap, no per-kart finish tick** (Q16).
- **No Canvas2D fallback backend** (Q10).
- **No portrait layout** (R40).
- **No delta encoding, no LOD, no instancing beyond what `RendererBackend`
  hides.** Spec §5 says v1 ships uncompressed; spec §11 names instanced meshes as
  a mitigation, which is an adapter-side implementation detail, not a contract.
- **No writes into `sim`, `protocol` or `net`.** Every widening Plan 3 needs —
  Q4/Q5/Q6's interpolator, R42's local-input transport, R43's `liveEntityIds`,
  R44's `WireSnapshot.phase` — is Plan 2's work, gated in §2.5.
- **No `packages/server` and no shadow authority.** Plan 4's. Plan 3 builds
  `packages/content` (R46) so that Plan 4 *can*, and stops there: `content` gets
  no server-only exports and no knowledge that a server exists.
- **No tick-buffered authority and no input playout delay.** R41's ruling is that
  the corrections are absorbed in rendering, not that the netcode is re-timed;
  §4.9a is the whole of Plan 3's response to it.

---

## 13. The failure this contract is written to prevent

Plan 2's contract needed twelve amendments during authoring and each cost roughly
two blocking defects at audit. The four highest-risk shared names in Plan 3,
ranked by how many tasks must agree on them independently:

1. **`RaceView` and `ViewSource`** — every render task and every game task reads
   or writes them. If two tasks disagree on whether `place` is 0- or 1-based, or
   on whether a guest's remote seat is `'interpolated'` or `'absent'` when the
   buffer is cold, the mismatch surfaces as a HUD off by one or a kart that
   vanishes for the first 100 ms of every race. Both are settled above:
   `KartView.place` is **0-based**, `HudModel.place` is **1-based**, and a cold
   buffer is `'absent'` with `visible: false`.
2. **The drift-tier encoding.** `sim` says `-1` means none; the draft said `0`
   did. One shifted comparison and every mini-turbo spark is one tier wrong, in a
   way that looks like a tuning choice rather than a bug. There is now exactly one
   encoding and exactly one call site (§5.11 step 8).
3. **The interpolator timebase** (§6.3). One wrong argument, no error, every
   remote kart wrong, invisible to CI — so the argument no longer exists.
4. **The pure/adapter seam** (§8.2). One `export * from './three/renderer'` in a
   barrel and the entire headless suite stops resolving, in a way whose error
   message points at the wrong package.

---

## 14. Where each ruling landed

| Ruling | Sections |
|---|---|
| Q1 `TUNING`/`CHARACTERS` shipped, equality test mandatory (home reversed by R46) | §3a.2, §5.2, §8.1 |
| Q2 descriptors are a DeepSeek task with a real-code gate | §3a.3, §4.4 |
| Q3 six themes, same batch, same gate | §3a.4, §3a.6 |
| Q4 `RemoteKeyframe.entities`, `sampleEntity` keyed by `entityId` | §2.5, §5.10, §5.11, §7.1 |
| Q5 `RemoteSample.kart: WireKart`; seat-source rule checkable | §2.5, §5.11, §7.1 |
| Q6 `TICK_MS` exported by `net`, imported, never redefined | §2.5, §4.1, §5.1 |
| Q7 interpolator clock is sim time | §6.3 |
| Q8 `tick()` once per 60 Hz sim tick | §6.1 |
| Q9 local kart lerped by `alpha`; second `SimState` allocated once | §5.10, §5.11 step 3, §6.2 |
| Q10 `three@0.180.0`, no Canvas2D | §4.10, §10 |
| Q11 `apps/web` shell + Vite only | §10.2, §12 |
| Q12 bundled content, `loadTrack` synchronous, `FetchJson` deleted | §3a.1, §3a.5, §3a.6, §5.3 |
| Q13 `game` depends on `@tapkart/protocol` | §1, §2.3 |
| Q14 five screens; countdown and join/host are not screens | §5.9 |
| Q15 `transport` never absent; solo uses local input over a zero-peer null transport | §5.10, §5.10a |
| Q16 positions only | §4.8, §5.12 |
| Q17 DNF derived in `game` | §5.12 |
| Q18 `clamp(lap + 1, 1, RACE_LAPS)` | §4.8 |
| Q19 `track.bounds` is a render extent | §3, §4.3, §8.1 |
| Q20 procedural edge markers from theme parameters | §3a.4, §4.3 |
| Q21 `thumbZones` brake on drift long-press; adapters do not fake `accel` | §5.5 |
| Q22 iOS permission on the settings tap; no silent fallback | §5.5, §5.6 |
| Q23 `CompositeAdapter` with the stated merge rule | §5.5 |
| Q24 relative steering, 28 %, 88 px buttons, dead gap | §5.5 |
| Q25 `useItem` one-tick pulse | §5.5 |
| Q26 audio seam authored, backend is a no-op | §4.9 |
| Q27 `surge` is screen tint only | §4.7 |
| Q28 bubble reconstructed from owner + interpolated heading | §4.7, §8.1 |
| Q29 `itemBoxAlpha: Float32Array` | §4.2, §4.7 |
| Q30 `environment: 'node'` everywhere | §8.1, §8.2, §10.2 |
| Q31 mesh tolerance `1e-3` | §8.1 |
| Q32 `viewSourceViolations` under `import.meta.env.DEV` | §5.11, §5.14, §7.1 |
| Q33 golden frame, derived subset, final task | §9.2 |
| Q34 real-track mesh tests required | §8.1, §9.1 |
| R35 DOM libs widened per package, never in the base | §10.1 |
| R36 `workspaces` gains `apps/*` | §10.2 |
| R37 vitest `include` gains `apps/*/test` | §10.2 |
| R38 `AudioBackend.setConfig` / `AudioConfig` | §4.9 |
| R39 what Plan 5 may add to Plan 3's packages | §1a |
| R40 landscape only | §0, §5.5 |
| R41 error smoothing is required, not polish | §4.9a, §5.10 (`correctionDelta`), §5.11 step 11a, §7.2, §8.1 |
| R42 `withLocalInput`/`createNullTransport` are `net`'s | §2.5, §5.10a |
| R43 `liveEntityIds(out)` accepted into Plan 2 | §2.5, §5.10, §5.11 step 10 |
| R44 `WireSnapshot.phase` (2 bits, 178 → 180) | §2.3, §2.4, §2.5, §5.10, §7.1 |
| R45 item boxes stay `'predicted'`, with the cost recorded | §7.1, §15.4 |
| R46 `packages/content` — tuning, descriptors, themes, tracks | §1, §3a, §4.4, §4.5, §5.2 – §5.4, §10, §11 |
| R47 `correctionDeltaOf` — the exact delta, from `net` | §2.4, §2.5, §4.9a, §5.10, §5.11 step 11a |
| R48 heading smoothed too; `correctionDeltaOf` returns `number \| null` | §2.5, §4.9a, §5.10, §5.11 step 11a, §8.1 |
| **P2-R29** `sampleKart`/`sampleEntity` are out-parameter form; `makeRemoteSample`/`makeRemoteEntitySample` added | §2.5, §5.10, §5.11 (scratch, steps 2 and 10), §7.1, §7.3, §11, §15.1 |
| **F-P4-24** Eleven cross-plan `data-testid` hooks in the shell: Plan 4's ten plus Plan 5's `solo-button` | §5.13 |

*Amended 2026-08-14: the two rows above are the only rulings in this table that
arrived **after** the lock. Both are cheap in this document and expensive in
code, which is the whole reason they were applied now: P2-R29 re-signs a
`@tapkart/net` method Plan 3 may not edit (§1a), and F-P4-24 names DOM hooks
the later plans' E2E suites assert. `promotionTickOf` (a free function over
a `ShadowLoop`, not a member of one) landed in
the same Plan 2 fix pass and is recorded in §2.4; it gets no row here because
Plan 3 never calls it.*

---

## 15. Gaps this contract found, and where each one ended up

The four things §15 originally recorded as unruled gaps were all taken up by the
controller. Three are now rulings; one is confirmed as a deliberate limit. They
stay here because a task reading §7.1 or §5.10a should be able to find out *why*
without reading three documents.

### 15.1 The host had no input path, and entity ids could not be enumerated → R42, R43

`AuthorityLoop`'s only input source is `onMessage` (§2.4 fact 1), so a host or
solo player was bot-driven with no way to steer — a real Plan 2 gap that Q15's
earlier "solo always uses a loopback transport" wording could not close, because `net` exports
`makeLoopbackPair`, which mints a *pair*, not a zero-peer transport.

**R42** puts the fix in `net`, where transports live: `withLocalInput`,
`createNullTransport`, `LocalInputTransport` and `LOCAL_PEER_ID` are Plan 2 Task
15b (§2.5). `game` keeps only the composition, `createSoloTransport` (§5.10a).
Routing the host's own intent through the real `encodeInput` codec gives its kart
the identical 8-bit steer / 6-bit accel quantisation every guest's input crosses;
without it the host drives a measurably different car and no test says so.

**R43** accepts `RemoteInterpolator.liveEntityIds(out)` into the same task. Q4's
`sampleEntity(entityId, nowMs, out)` is otherwise unusable: entity ids come from
a monotonic counter and cannot be probed. *(Amended 2026-08-14: that call was
written `sampleEntity(entityId, nowMs)` here. Ruling P2-R29 gave it an `out`
buffer — and it was `liveEntityIds`, accepted by this very ruling, that made the
inconsistency visible: one method on the class took a caller-owned buffer because
a renderer calls it every frame, and the two beside it allocated for the same
reason. §2.5 has the signatures and the arithmetic.)*

**R47** closes the last of these: `correctionDeltaOf(client, outPos)` reports the
exact discontinuity a reconciliation applied, so R41's smoothing consumes a
measurement instead of an inference. **R48** settles what it reports — position
*and* heading — and corrects a wrong argument this contract made in between, which
is worth recording because it is the kind of mistake that reads as reasoning:

> An intermediate draft dropped heading smoothing on the grounds that
> "`EPS.heading` is 0.0025 rad, so a heading correction is the least visible thing
> a reconciliation does." **`EPS.heading` is the threshold at which a correction
> fires, not a bound on the correction that follows.** Past that threshold
> `resyncOwnKart` writes the authoritative heading, whatever the divergence is, so
> 0.14° is the *smallest* a heading correction can be, not the largest. And
> heading is the channel that dominates error growth — 0.0024 rad at 20 m/s is
> 0.048 m/s of lateral drift, roughly three times what the velocity residual
> produces, crossing a lane in a second. The mildest-looking channel was the worst
> one.

So both channels are smoothed, on one window and one curve (§4.9a), and
`correctionDeltaOf` returns `number | null` — `null` for "no correction", `0` for
"a correction that moved the heading by exactly zero". That nullable travels
unchanged into `advanceVisualOffset`, which is why the smoother needs no separate
`corrected` flag: the distinction is preserved at its source instead of
reconstructed a layer up. `prevState()` remains, for Q9's alpha-lerp.

### 15.2 A guest could never see a countdown → R44, fixed in the protocol

`ClientLoop` forced `phase = 'racing'` and `WireSnapshot` carried no phase, so a
guest had no way to learn the race was still counting down — it would drive off
while the host counted, and every snapshot in that window would be a guaranteed
correction. This contract originally deferred a synchronised countdown to Plan 4
and started hosts at `'racing'`.

**R44 rejects that deferral and puts `phase` on the wire as 2 bits** (178 → 180
per snapshot), as Plan 2 Task 15c. It is a core gameplay defect rather than a
lobby concern, and 2 bits is the cheapest fix available. Consequently §5.10 starts
**every** role in `'countdown'`, `raceStartTick` is `COUNTDOWN_TICKS` everywhere,
and the countdown overlay Q14 puts on the race screen works for host, guest and
solo alike. This contract is written assuming Task 15c has landed and hedges
nothing against its absence.

### 15.3 Q9's lerp is applied to every state-sourced seat, not only the local one

Q9 rules the local kart interpolated between ticks: the one object the player is
steering must not judder, and the remote karts already get smoothing. On a **host
or solo** race there is no interpolator, so the other seven seats come from the
same `state()` and would judder alone at 60 Hz on a 120 Hz display.

**Call:** the lerp applies to every seat and every entity whose source is
`state()`-derived (§5.11 step 3). A strict superset of the ruling, costing nothing
extra — the previous `SimState` is already retained — and preserving its intent
exactly: nothing sourced from `state()` judders. Interpolated seats are untouched,
because `renderNowMs` already resolved their sub-tick time. The controller has not
objected; if this is wrong the fix is one branch in `ViewBuilder`.

### 15.4 A guest's item boxes are approximate, on purpose → R45

`WireSnapshot` carries karts, entities and (after R44) phase — never item boxes.
Q4 fixed entities and Q5 fixed karts; neither reaches boxes.

**R45 confirms the call and records the price**, so nobody "fixes" it later: a
guest's boxes come from the predicted state, `ItemBoxView` has no `source` field,
and `viewSourceViolations` says nothing about them (§7.1). Putting box state on
the wire would cost ~8 bits × 16 boxes = 128 bits against a 180-bit snapshot, at
20 Hz, to correct a purely cosmetic inaccuracy — a box drawn as available a few
hundred milliseconds early. Every pickup by a real player is already corrected by
the reliable `itemGrant` stream.

### 15.5 Content had to leave `game` before Plan 4 could build a server → R46

Not a gap this contract found; a gap the **Plan 4 contract draft** found in Q1,
and it reverses that ruling. `packages/server`'s shadow authority must run
`step()` in lockstep with the host, which needs the identical `Tuning`, the
identical `CharacterStats[]` and the same six tracks — and spec §3 forbids
`server` from depending on `game`. With the content in `game`, the shadow
authority is unbuildable, and the only escapes are a duplicated tuning table
(which drifts, silently, which is the exact thing Q1 exists to prevent) or a
forbidden dependency edge.

**R46 creates `packages/content`** (§3a): `sim`-only dependencies, imported by
`render`, `game` and Plan 4's `server`. Every substantive part of Q1, Q2, Q3, Q12
and Q34 travels with it unchanged — including the mandatory field-by-field
equality tests, which now live in `packages/content/test/`.

**The one thing that had to change, and the one place this move could have
bitten:** `import.meta.glob` is a Vite transform, and `server` imports `content`
under plain Node/tsx/esbuild. Keeping the glob would have forced a Vite build onto
the server to read six JSON files, or — worse — failed at runtime in Plan 4 rather
than at build time here. §3a.1 replaces it with 28 explicit static JSON imports,
which work in Vite, vitest, esbuild/tsx and Node ESM alike. Q12's substance
(bundled, synchronous, total, no fetch) is untouched; only the mechanism moved,
and the §8.1 test that compares `TRACK_MANIFEST` against the real directory
listing is what keeps the explicit list honest.

## 16. Two smaller corrections to the draft, recorded so they are not re-litigated

Neither is a ruling; both are places the draft's quoted code did not match the
shipped code, found while verifying §2.

**`driftTierOf` is deleted.** The draft proposed a `render`-local tier function
returning `0 | 1 | 2 | 3` with `0` meaning "no mini-turbo". `sim`'s shipped
`driftTierFor` returns `-1 | 0 | 1 | 2` with `-1` meaning that, and already takes
the tiers as a parameter — which was the draft's entire stated reason for a
duplicate. One encoding, one function, one call site (§5.11 step 8).

**`KartDraw.spinAngle` is deleted.** The draft added render-side yaw for a
spun-out kart. `updateRecovery` already advances `k.heading` by `SPIN_YAW_RATE *
TICK_DT` every tick of a spin-out, and `heading` is on the wire — so the field
would have double-spun the kart, which is exactly the defect Q28 forbids for the
bubble. The spin comes from `sim`; `render` adds `KART_SPINOUT_ROLL_RADIANS` of
tilt and nothing else (§4.7).
