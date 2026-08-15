# Tapkart Plan 3 — Locked Interface Contract (DRAFT, for ruling)

> **STATUS: DRAFT.** This is not yet binding. It is written for the controller to
> rule on and amend. §14 lists every place a guess was made; each item there is an
> amendment that would otherwise land mid-authoring, and Plan 2 measured each
> mid-authoring amendment at roughly two blocking defects at audit.
>
> Once ruled on, this becomes the **Global Constraints** section of the Plan 3
> implementation plan. Every task's requirements implicitly include everything
> here. No task may rename, re-sign, or add fields to anything below. A task
> needing something absent must define it in its own files and say so in its
> `Interfaces` block.

**Spec:** `docs/superpowers/specs/2026-08-13-tapkart-design.md` (amended 2026-08-14)
**Builds on:** Plan 1 (`@tapkart/sim`, merged at `1f1f2c4`, 19 modules, 477 tests)
and Plan 2 (`@tapkart/protocol` + `@tapkart/net`, in the `plan2-net` worktree,
finishing).
**Scope:** `packages/render` and `packages/game`. Plan 3 of 5.

Every signature in §2 was read out of real source in
`.claude/worktrees/plan2-net/packages/*/src/` and is quoted, not reconstructed.
Where a name Plan 3 needs does not exist yet, §2 or §14 says so explicitly.

---

## 0. Conventions that are decided, not negotiable

Plan 1's and Plan 2's conventions carry forward unchanged and are **not**
restated except where Plan 3 adds to them. In particular: `forward = (cos h, 0,
sin h)`; `right = (-t.z, 0, t.x)` normalised; positive `lateral` is right of
travel; up is `+y`; headings wrapped to `(-π, π]`; **track parameter `s` is
arc-normalised `[0, 1)`, never metres**; extensionless imports; `import type`
under `verbatimModuleSyntax`; vitest with `globals: false`; bare specifiers
(`@tapkart/sim`, `@tapkart/protocol`, `@tapkart/net`) across packages in `src`,
never a relative path into another package.

New for Plan 3:

| Convention | Value |
|---|---|
| Units | metres, radians, seconds-derived-from-ticks. Never pixels in any pure module |
| Angles | same wrap as sim: `(-π, π]`, via `wrapAngle` from `@tapkart/sim` |
| Colour | `PaletteRGB = readonly [number, number, number]`, each component `0..1` linear. Never a CSS string, never `0..255`, never hex, in any pure module |
| Time in pure code | **ticks**, or tick-derived milliseconds via `TICK_MS`. `Date.now()` and `performance.now()` appear in **exactly one** file, `packages/game/src/clock.ts`, behind `FrameClock` |
| Time in the interpolator | `RemoteInterpolator` keyframes are stamped `recvAtMs = tick * TICK_MS` by `ClientLoop`. Anything asking it for a sample **must** pass `nowMs` in that same tick-derived basis. See §6.3 — this is the single easiest way to break every remote kart at once |
| Out-parameters | every per-frame builder writes into a caller-owned `out` and returns `void`. Nothing in the frame path allocates, exactly as `step()` does not |
| `render` never mutates simulation state | Spec §3. `render` takes `readonly` views; it holds no `SimState` reference and imports nothing that can write one |
| Screens are data | Screen transitions are a pure reducer over an event union. No screen module reaches into the DOM to decide what screen it is |
| Scratch discipline | `TrackQuery.sampleAt`, `tangentAt` and `project` **return the same object on every call** and overwrite it in place (`packages/sim/src/track.ts:455-461`). Copy every field you need before the next call, in `render` exactly as in `sim` |

### 0a. The one rule that decides whether this plan is testable

Every module in `packages/render` is one of exactly two kinds, and the file says
which in its first line:

- **Pure** — a function of its arguments, no DOM, no GPU, no clock, no
  `three` import (not even `import type`, see §8.2). Returns or fills plain data.
  **Testable headlessly, and every one of them is tested.**
- **Adapter** — the thin layer that hands plain data to a real GPU. Contains no
  decisions: no branching on game state, no arithmetic beyond unit conversion,
  no allocation policy. **Not tested in CI, owner-verified** (spec §8, "What CI
  cannot verify").

A conditional in an adapter is a contract violation, because it is a decision
that CI cannot see. If an adapter needs to branch, the branch is wrong-side-of-
the-seam and moves into the pure layer as a field on `RenderFrame`.

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
| `@tapkart/render` | `@tapkart/sim`, `three` |
| `@tapkart/game` | `@tapkart/sim`, `@tapkart/net`, `@tapkart/render` |

**`render` does not depend on `@tapkart/net` and does not depend on
`@tapkart/protocol`.** Spec §3 lists only `sim` for it, and the omission is
load-bearing rather than an oversight: if `render` could import `net`, a render
module could reach `ClientLoop.state()` and draw a remote kart from the predicted
state, which spec §5 forbids. Keeping the dependency out makes the forbidden
thing *unreachable* instead of merely discouraged. `render` therefore defines its
own neutral view structs (§4.2) and `game` — which may see both — is the only
place the two worlds meet.

**Nothing depends on `render` or `game`.** `sim`, `protocol` and `net` are
untouched by this plan except for the two barrel widenings named in §2.5.

`three` is the **first runtime dependency in the repository**. See §14 Q10.

---

## 2. Signatures Plans 1 and 2 export that Plan 3 consumes

All quoted from real source. Line references are to
`.claude/worktrees/plan2-net/packages/`.

### 2.1 `@tapkart/sim` — types (`src/types.ts`)

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
  heldBotIntent: Intent[]       // always length MAX_KARTS
  heldBotTick: number[]         // always length MAX_KARTS, -1 = no held intent
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

`Tuning` is a 25-field interface (`src/types.ts:123-149`); Plan 3 consumes it
whole and defines no subset of it. Its full field list is
`maxSpeed, accelRate, brakeRate, steerRateBase, steerSpeedFalloff, gripTarmac,
gripDirt, gripDrift, gravity, airYaw, offtrackSpeedMul, respawnTicks,
invulnTicks, spinOutTicks, driftMinSpeed, driftTiers, driftBoosts,
boostSpeedMul, surgeSpeedMul, kartRadius, kartRestitution, itemBoxRespawnTicks,
seekerSpeed, boltSpeed, entityTtl`.

### 2.2 `@tapkart/sim` — functions Plan 3 calls

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
export function makeIntentBuffer(): Intent[]          // exactly MAX_KARTS distinct Intents

// src/track.ts
export function buildTrackQuery(track: Track): TrackQuery
export function validateTrack(track: Track): string[]  // [] when valid
export function splinePointAt(track: Track, t: number, out: Vec3): void
export function splineTangentAt(track: Track, t: number, out: Vec3): void
export function widthAtSeg(track: Track, t: number): number
export function bankingAtSeg(track: Track, t: number): number
export function surfaceOfSeg(track: Track, t: number): Surface
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

// src/entity.ts
export function kartById(state: SimState, playerId: number): KartState | null

// src/mathutil.ts
export function clamp(v: number, lo: number, hi: number): number
export function lerp(a: number, b: number, t: number): number
export function wrapAngle(a: number): number

// src/vec3.ts
export function v3(x: number, y: number, z: number): Vec3
```

Two shapes Plan 3 must not misread:

- **`splinePointAt` / `widthAtSeg` / `bankingAtSeg` / `surfaceOfSeg` take
  `t`, a *segment parameter*, not `s`.** The integer part selects the control
  point; the fraction runs to the next. `TrackQuery` methods take `s`,
  arc-normalised. Mesh generation (§4.3) walks `t` because it wants even
  geometry per segment; everything else uses `s`. Mixing them silently produces
  a track mesh that does not match the collision surface — the exact failure
  spec §3 says "cannot drift".
- **`itemBoxWorldPos` writes into `out` and returns `void`.** It is safe to call
  from `render` (it reads `ctx.track` and `ctx.query`, mutates nothing), but it
  calls `ctx.query.sampleAt`/`tangentAt` internally, so it invalidates the shared
  scratch (§0).

### 2.3 `@tapkart/protocol` — what Plan 3 touches

Only `game` sees `protocol` at all, and only through `net`'s own types.
`packages/game` declares **no** dependency on `@tapkart/protocol`; if a task
finds it needs one, that is an amendment, not a quiet `package.json` edit.

The one shape that reaches Plan 3 indirectly is `WireKart` (`src/types.ts:58-66`),
because `RemoteKeyframe.karts` is `WireKart[]` — but Plan 3 never names the type:
`RemoteInterpolator.sampleKart` returns `RemoteSample`, which is plain.

### 2.4 `@tapkart/net` — the loops and the interpolator

```ts
// src/transport.ts
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

// src/client.ts   [Plan 2 Task 15 — file not yet present in the worktree]
export class ClientLoop {
  constructor(ctx: SimContext, playerId: number, t: Transport)
  tick(localIntent: Intent): void
  corrections(): number
  state(): SimState
}
export const REMOTE_INTERP_DELAY_MS = 100
export const REMOTE_BUFFER_CAPACITY = 8
export const REMOTE_EXTRAPOLATE_CAP_MS = 200
export interface RemoteKeyframe { recvAtMs: number; karts: WireKart[] }
export interface RemoteSample { position: { x: number; y: number; z: number }; heading: number }
export class RemoteInterpolator {
  push(kf: RemoteKeyframe): void
  sampleKart(playerId: number, nowMs: number): RemoteSample | null
}
export function remoteInterpolatorOf(client: ClientLoop): RemoteInterpolator

// src/shadow.ts   [Plan 2 Task 16 — file not yet present in the worktree]
export class ShadowLoop {
  constructor(ctx: SimContext, state: SimState, t: Transport)
  tick(): void
  promote(tick: number): void
}
```

`ShadowLoop` is listed for completeness; **Plan 3 never constructs one** — it is
the server's, and the server is Plan 4.

### 2.5 Two facts about Plan 2's surface that Plan 3 depends on

1. **`packages/net/src/index.ts` currently re-exports four modules**
   (`transport`, `loopback`, `apply`, `authority`). Plan 2's Task 18 widens it to
   six, adding `client` and `shadow`. Plan 3 imports `ClientLoop`,
   `RemoteInterpolator`, `RemoteSample` and `remoteInterpolatorOf` **by bare
   specifier from `@tapkart/net`**; if Task 18 lands without them, Plan 3 is
   blocked at its first import and the fix belongs in Plan 2, not here.
2. **`TICK_MS` is `const TICK_MS = 1000 / TICK_HZ` inside `client.ts` and is
   *not* exported.** `render` therefore defines its own (§4.1) with the identical
   expression. Two definitions of one number is a real hazard and §14 Q6 asks
   whether Plan 2 should export it instead.

### 2.6 Test fixtures are still not importable by bare specifier

Plan 2 §6 established this and it binds Plan 3 unchanged: `makeTuning`,
`makeCharacters`, `makeOvalTrack`, `makeStraightTrack` and `makeCircleTrack` live
in `packages/sim/test/fixtures/track-fixtures.ts`, **outside** `@tapkart/sim`'s
`exports` map. Plan 3's *tests* reach them by relative path
(`'../../../sim/test/fixtures/track-fixtures'`); Plan 3's *`src`* never does, and
`@tapkart/sim`'s exports are **not** widened to publish fixtures.

This matters more in Plan 3 than it did in Plan 2, because Plan 3 is the first
plan that must ship a **real** `Tuning` and a **real** `CharacterStats[]` to a
player rather than borrow the fixture. See §5.2 and §14 Q1.

---

## 3. The track JSON shape — read, not assumed

All six shipped tracks were parsed. **The on-disk JSON is exactly
`Track` from `@tapkart/sim`, with no extra keys and no missing keys.** Top-level
keys, in file order, for all six: `id`, `name`, `controlPoints`, `checkpointS`,
`itemBoxes`, `ramps`, `boostPads`, `startPositions`, `bounds`.

```json
{
  "id": "neon-district",
  "name": "Neon District",
  "controlPoints": [
    { "position": { "x": 187.5, "y": 0, "z": 108.253 },
      "width": 18, "banking": 0, "surface": "tarmac" }
  ],
  "checkpointS": [ 0, 0.083, "..." ],
  "itemBoxes":   [ { "s": 0.12, "lateral": -6 } ],
  "ramps":       [ { "sStart": 0.31, "sEnd": 0.35, "launch": 6 } ],
  "boostPads":   [ { "s": 0.58, "lateral": 0, "halfWidth": 3 } ],
  "startPositions": [ { "s": 0.99, "lateral": -5 } ],
  "bounds": { "min": { "x": -300, "y": -30, "z": -300 },
              "max": { "x":  300, "y":  30, "z":  300 } }
}
```

Measured, per file — these are the real numbers a mesh builder must handle:

| Track | ctrl pts | checkpoints | item boxes | ramps | boost pads | starts | surfaces present |
|---|---|---|---|---|---|---|---|
| `caldera` | 48 | 12 | 16 | 3 | 2 | 8 | tarmac, dirt |
| `dust-canyon` | 52 | 12 | 16 | 2 | 4 | 8 | tarmac, dirt |
| `glacier-pass` | 47 | 12 | 30 | 2 | 5 | 8 | tarmac |
| `harbor-run` | 46 | 10 | 25 | 1 | 2 | 8 | tarmac |
| `neon-district` | 54 | 12 | 20 | **0** | 4 | 8 | tarmac |
| `redwood-rise` | 72 | 10 | 24 | 1 | 5 | 8 | tarmac, dirt |

Facts that bind the mesh builder:

- **`ramps` can be empty** (`neon-district`). A builder that assumes ≥1 ramp
  segment produces a zero-length buffer, not an error.
- Only two of the four `Surface` values ever appear in control-point data:
  `tarmac` and `dirt`. `boost` is **derived** by `TrackQuery.surfaceAt` from
  `boostPads`, and `offtrack` is derived from `|lateral| > width/2`. A mesh
  builder that colours segments by `controlPoints[i].surface` will never draw a
  boost pad; boost pads are their own geometry pass driven by `track.boostPads`.
- `width` varies per control point (17–21.5 m observed) and is **linear across a
  segment** (`widthAtSeg`). `banking` likewise, in radians (0–0.2 observed).
- `y` is non-zero on real tracks (`redwood-rise` spans y −30..+52 in `bounds`,
  `dust-canyon` starts at y = 6). The ribbon is 3D; a flat-plane assumption is wrong.
- `bounds` is **much larger than the ribbon** and is not used by `sim` for
  containment at all (`isInBounds` uses `width * BOUNDS_HALF_WIDTH_MUL`). See §14 Q19.
- Track ids are stable, lowercase, hyphenated, and equal the filename stem. §5.3
  uses that as the manifest key.
- Every track declares exactly 8 `startPositions`, so `createState`'s
  "reuse the last one" fallback never fires on shipped content.

`content/tracks-pool/` holds 12 further candidate tracks in the same shape. They
are **not** shipped content; v1 is the 6 in `content/tracks/` (spec §1).

---

## 4. `packages/render` — module map and exact signatures

Zero DOM, zero GPU, zero clock in everything below except §4.10.

### 4.1 `src/time.ts` — the tick/millisecond bridge

```ts
/** 1000 / TICK_HZ. Deliberately the same expression as the unexported const in
 *  @tapkart/net's client.ts, because RemoteInterpolator keyframes are stamped
 *  with it. If these two ever disagree, every remote kart extrapolates forever. */
export const TICK_MS: number

/** The tick-derived instant a frame represents. `alpha` is the sub-tick
 *  fraction in [0, 1). This is the ONLY value that may be passed as `nowMs` to
 *  RemoteInterpolator.sampleKart. */
export function renderNowMs(tick: number, alpha: number): number
```

### 4.2 `src/types.ts` — the view structs (the whole `game` → `render` handoff)

`render` is handed views, never `SimState`. This is what makes spec §5's "remote
karts render from the interpolated buffer, never from prediction" a structural
fact rather than a discipline.

```ts
/** Where a seat's transform came from. `'predicted'` is legal only for the
 *  local player's own seat on a guest, and for every seat on a host or solo
 *  race (where the local state IS authoritative). §7.1 is the full rule. */
export type ViewSource = 'authoritative' | 'predicted' | 'interpolated' | 'absent'

export interface KartView {
  playerId: number
  characterIdx: number
  source: ViewSource
  position: Vec3
  heading: number
  velocity: Vec3
  angularVelocity: number
  driftActive: boolean
  driftDir: -1 | 0 | 1
  driftCharge: number
  driftTier: 0 | 1 | 2 | 3     // 0 = no mini-turbo pending; derived, see §4.7
  airborne: boolean
  surface: Surface
  spinOutTicks: number
  invulnTicks: number
  boostTicks: number
  respawnTicks: number
  shielded: boolean
  item: ItemKind
  lap: number
  checkpointIdx: number
  t: number
  place: number                // 0 = leader
  isBot: boolean
  connected: boolean
}

export interface EntityView {
  entityId: number             // -1 for an unused slot
  kind: EntityKind
  ownerId: number
  source: ViewSource
  position: Vec3
  velocity: Vec3
  heading: number
  ttl: number
}

export interface ItemBoxView {
  boxIdx: number
  position: Vec3
  available: boolean
}

export interface RaceView {
  tick: number
  alpha: number                // sub-tick fraction, [0, 1)
  phase: RacePhase
  localPlayerId: number        // -1 for a spectator or a replay
  karts: KartView[]            // always length MAX_KARTS
  entities: EntityView[]       // always length MAX_ENTITIES, live packed at front
  entityCount: number
  itemBoxes: ItemBoxView[]     // length = ctx.track.itemBoxes.length
  finishedOrder: number[]      // length MAX_KARTS, -1 in unfilled slots
  finishTick: number
  countdownTicksLeft: number   // 0 once racing
}

/** Allocates one fully-populated RaceView with every array at its fixed length.
 *  Called once per session, never per frame. */
export function createRaceView(itemBoxCount: number): RaceView

/** Returns [] when the view obeys §7.1, otherwise one human-readable string per
 *  violating seat. Exported (not test-only) so both the CI honesty test and an
 *  optional dev-build assertion call the same code. */
export function viewSourceViolations(view: RaceView, role: 'host' | 'guest' | 'solo'): string[]
```

### 4.3 `src/mesh.ts` — track geometry, pure

```ts
/** Plain, backend-agnostic geometry. Indices are 16-bit-safe per chunk; a
 *  builder that would exceed 65535 vertices emits multiple MeshData. */
export interface MeshData {
  positions: Float32Array      // xyz triples
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

export const DEFAULT_MESH_OPTIONS: Readonly<MeshBuildOptions>

/** The road ribbon: centreline + width profile + banking, evaluated on the same
 *  spline `sim` derives ground height from. Sole owner of road geometry. */
export function buildTrackMesh(track: Track, opts: MeshBuildOptions): MeshData

/** Boost-pad quads, driven by `track.boostPads` and BOOST_PAD_HALF_LENGTH — NOT
 *  by control-point `surface`, which never carries 'boost' (§3). */
export function buildBoostPadMesh(track: Track, query: TrackQuery): MeshData

/** Ramp geometry from `track.ramps`. Empty `ramps` yields a MeshData with
 *  zero-length arrays, never a throw (`neon-district` has none). */
export function buildRampMesh(track: Track, query: TrackQuery, opts: MeshBuildOptions): MeshData

/** Start/finish line and per-checkpoint gate placements, in world space. */
export interface MarkerPlacement { s: number; position: Vec3; heading: number; width: number }
export function buildCheckpointMarkers(track: Track, query: TrackQuery): MarkerPlacement[]

/** Axis-aligned bounds of a MeshData. Pure; used by camera framing and by tests
 *  that assert the generated ribbon sits inside `track.bounds`. */
export function meshBounds(mesh: MeshData): { min: Vec3; max: Vec3 }

/** Sums vertex and triangle counts across a set. Test-facing, but exported
 *  because the adapter also reports it through RendererStats. */
export function meshCounts(meshes: readonly MeshData[]): { vertices: number; triangles: number }
```

**Sole writer:** `buildTrackMesh` is the only producer of road-surface geometry.
Nothing else emits triangles for the drivable surface, in any module, ever. This
is what spec §3's "the collision surface cannot drift from what the player sees"
reduces to in code, and it is assertable: a test samples N points on the built
mesh and compares against `query.groundHeight(s, lateral)` within a stated
tolerance.

### 4.4 `src/descriptors.ts` — parametric characters and karts, pure

```ts
export type PaletteRGB = readonly [number, number, number]   // linear, 0..1

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

/** Throws with a field-listing message on any shape violation. Never returns a
 *  partially-populated descriptor. */
export function parseCharacterDescriptor(json: unknown): CharacterDescriptor
export function parseKartDescriptor(json: unknown): KartDescriptor

export function buildCharacterMesh(desc: CharacterDescriptor): MeshData
export function buildKartMesh(desc: KartDescriptor): MeshData
```

Spec §3: "parametric low-poly meshes built in `render` from JSON descriptors.
Eight characters is eight JSON files, not eight modeled assets." The descriptor
files themselves do not exist yet — §14 Q2.

**`CharacterDescriptor` is not `CharacterStats`.** `CharacterStats` (sim) is
handling; `CharacterDescriptor` (render) is appearance. They are joined only by
array index (`KartState.characterIdx`), and both arrays must be length 8 and in
the same order. A test asserts that.

### 4.5 `src/theme.ts` — per-track palettes, pure

```ts
export interface TrackTheme {
  trackId: string
  road: PaletteRGB
  roadDirt: PaletteRGB
  shoulder: PaletteRGB
  wall: PaletteRGB
  ground: PaletteRGB
  sky: { top: PaletteRGB; bottom: PaletteRGB }
  fog: { color: PaletteRGB; near: number; far: number }
  sunDirection: Vec3          // normalised
  ambient: number             // 0..1
}
export const DEFAULT_TRACK_THEME: Readonly<TrackTheme>
export function parseTrackTheme(json: unknown): TrackTheme
```

Spec §10 delegates "per-track theme palettes" to DeepSeek. The theme files do not
exist yet — §14 Q3.

### 4.6 `src/camera.ts` — pure, tick-driven, no wall clock

```ts
export type CameraMode = 'chase' | 'countdown' | 'results' | 'free'

export interface CameraParams {
  distance: number            // metres behind the kart
  height: number              // metres above the kart
  lookAhead: number           // metres ahead of the kart for the look target
  positionLerpPerTick: number // 0..1, applied once per sim tick
  headingLerpPerTick: number  // 0..1
  fovDegrees: number
  fovBoostDegrees: number     // additional FOV at full boost, blended by boostTicks
  near: number
  far: number
}
export const DEFAULT_CAMERA_PARAMS: Readonly<CameraParams>

export interface CameraState {
  position: Vec3
  lookAt: Vec3
  up: Vec3
  fovDegrees: number
  mode: CameraMode
}
export function createCameraState(): CameraState

/** Advances `cam` by exactly `ticks` sim ticks toward the pose implied by
 *  `target`. Deterministic: same (cam, target, params, mode, ticks) in, same cam
 *  out. Sole writer of every CameraState field. */
export function updateCamera(cam: CameraState, target: KartView, params: CameraParams,
                             mode: CameraMode, ticks: number): void
```

Smoothing is **per tick, not per frame**. A frame-rate-dependent lerp makes the
camera behave differently on a 60 Hz phone and a 144 Hz desktop and cannot be
asserted in CI at all.

### 4.7 `src/frame.ts` — the pure frame description

```ts
export interface KartDraw {
  playerId: number
  characterIdx: number
  visible: boolean
  position: Vec3
  heading: number
  roll: number                // banking + drift lean, radians
  wheelSpin: number           // radians, accumulated
  steerAngle: number          // radians, front wheels
  bodyTint: PaletteRGB
  alpha: number               // 0..1; blink invulnerability flickers this
  driftSparkTier: 0 | 1 | 2 | 3
  boostFlame: number          // 0..1
  shieldVisible: boolean
  spinAngle: number           // extra yaw applied while spun out, radians
}

export interface EntityDraw {
  entityId: number
  kind: EntityKind
  visible: boolean
  position: Vec3
  heading: number
  scale: number
  tint: PaletteRGB
  alpha: number
}

export interface RenderFrame {
  camera: CameraState
  karts: KartDraw[]           // length MAX_KARTS
  entities: EntityDraw[]      // length MAX_ENTITIES
  entityCount: number
  itemBoxVisible: boolean[]   // length = itemBoxes.length
  screenFlash: number         // 0..1, e.g. a charge blast
  screenTintScreen: PaletteRGB
  screenTintAmount: number    // 0..1, e.g. surge slow
}
export function createRenderFrame(itemBoxCount: number): RenderFrame

/** THE pure function of this package. (RaceView, CameraState, TrackTheme,
 *  descriptors) -> RenderFrame. No clock, no DOM, no allocation, no randomness.
 *  Sole writer of every RenderFrame field. This is what CI asserts on. */
export function buildRenderFrame(view: RaceView, cam: CameraState, theme: TrackTheme,
                                 characters: readonly CharacterDescriptor[],
                                 out: RenderFrame): void

/** Drift tier from charge, mirroring `driftTierFor` in @tapkart/sim but taking
 *  the tuning tiers explicitly so `render` needs no SimContext. */
export function driftTierOf(charge: number, tiers: readonly [number, number, number]): 0 | 1 | 2 | 3
```

### 4.8 `src/hud.ts` — pure

```ts
export interface HudModel {
  visible: boolean
  place: number               // 1-based for display
  fieldSize: number
  lap: number                 // 1-based for display, clamped to totalLaps
  totalLaps: number
  speedKph: number
  item: ItemKind
  itemReady: boolean
  driftTier: 0 | 1 | 2 | 3
  countdownLabel: '' | '3' | '2' | '1' | 'GO'
  raceClock: string           // mm:ss.mmm, from ticks
  respawning: boolean
  spunOut: boolean
  standings: { playerId: number; place: number; lap: number; isBot: boolean; connected: boolean }[]
}
export function createHudModel(): HudModel
export function buildHudModel(view: RaceView, totalLaps: number, out: HudModel): void

/** Ticks -> "m:ss.mmm". Pure, no Date, no Intl. */
export function formatRaceClock(ticks: number): string
```

### 4.9 `src/audio.ts` — pure model, thin backend

```ts
export type AudioCueKind =
  | 'engine' | 'skid' | 'impact' | 'itemPickup' | 'itemUse'
  | 'boost' | 'spinOut' | 'respawn' | 'lapCross' | 'countdownBeep' | 'finish'

export interface AudioCue { kind: AudioCueKind; playerId: number; intensity: number; pan: number }

export interface AudioModel {
  engineFreqHz: number
  engineGain: number
  skidGain: number
  cues: AudioCue[]            // one-shots for THIS frame; cleared each build
  cueCount: number
}
export function createAudioModel(): AudioModel

/** Derives continuous levels from `view` and one-shots from the delta between
 *  `prev` and `view`. Pure and assertable; a test drives two views and asserts
 *  exactly which cues fire. */
export function buildAudioModel(prev: RaceView, view: RaceView, out: AudioModel): void

/** ADAPTER boundary. The Web Audio implementation lives behind this and is
 *  owner-verified. */
export interface AudioBackend {
  apply(model: AudioModel): void
  close(): void
}
```

### 4.10 `src/backend.ts` and `src/three/renderer.ts` — the adapters

```ts
// src/backend.ts  — PURE (interface only, no three import)
export interface RendererStats { drawCalls: number; vertices: number; triangles: number }

export interface RendererBackend {
  /** Called once, after content load, before the first frame. */
  setScene(track: MeshData[], theme: TrackTheme,
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
  maxPixelRatio: number
  shadows: boolean
}
export const DEFAULT_THREE_OPTIONS: Readonly<ThreeRendererOptions>
export function createThreeRenderer(canvas: HTMLCanvasElement,
                                    opts: ThreeRendererOptions): RendererBackend
```

**Sole writer:** `createThreeRenderer`'s returned object is the only thing in the
repository that touches a Three.js scene graph. Nothing else imports `three`.

### 4.11 `src/index.ts` — the barrel

Re-exports `time`, `types`, `mesh`, `descriptors`, `theme`, `camera`, `frame`,
`hud`, `audio`, `backend`. **It does not re-export `three/renderer`.** §8.2 says why.

---

## 5. `packages/game` — module map and exact signatures

### 5.1 `src/clock.ts` — the only wall clock in the repository

```ts
export interface FrameClock { nowMs(): number }

/** performance.now() when available, Date.now() otherwise. The ONE impure
 *  binding. Everything else takes a FrameClock. */
export const realFrameClock: FrameClock

/** Deterministic clock for tests: starts at `startMs`, moves only on advance(). */
export function makeFixedClock(startMs?: number): FrameClock & { advance(ms: number): void }

/** Ticks the fixed-step accumulator will run in a single catch-up burst before
 *  it drops the remainder. Prevents a backgrounded tab from spiral-of-deathing. */
export const MAX_CATCHUP_TICKS = 8

export interface TickAccumulator { residualMs: number; lastNowMs: number }
export function createAccumulator(nowMs: number): TickAccumulator

/** Pure. Folds `nowMs` in, returns how many 60 Hz ticks to run now, and leaves
 *  the sub-tick remainder in `acc.residualMs`. Sole writer of TickAccumulator. */
export function advanceAccumulator(acc: TickAccumulator, nowMs: number): number

/** Sub-tick fraction in [0, 1) for the frame that follows the ticks just run. */
export function accumulatorAlpha(acc: TickAccumulator): number
```

### 5.2 `src/content/tuning.ts` — the shipped tuning table

```ts
/** The Tuning the game actually races with. Must stay numerically identical to
 *  makeTuning() in packages/sim/test/fixtures/track-fixtures.ts: Plan 1's 477
 *  tests and its golden replay fixture all describe THAT table, and a divergence
 *  leaves the suite green while describing physics no player experiences.
 *  A test asserts field-by-field equality against the fixture. */
export const TUNING: Readonly<Tuning>

/** The eight shipped characters' handling stats. Same index space as
 *  CHARACTER_DESCRIPTORS in render, and as KartState.characterIdx. */
export const CHARACTERS: readonly CharacterStats[]
```

This module exists because **no shipped `Tuning` or `CharacterStats[]` exists
anywhere in `src` today** — the only ones in the repository are test fixtures,
and Plan 2 §6 explicitly forbids publishing fixtures through `@tapkart/sim`'s
exports. Placement in `game` (the composition root) is this draft's guess. §14 Q1.

### 5.3 `src/content/tracks.ts` — track loading

```ts
/** Injected so no pure path and no test ever touches the network. */
export type FetchJson = (url: string) => Promise<unknown>

export interface TrackManifestEntry { id: string; name: string; url: string }

/** The six shipped tracks (spec §1), in menu order. Ids equal the filename
 *  stems in content/tracks/. */
export const TRACK_MANIFEST: readonly TrackManifestEntry[]

/** Shape-checks, then runs validateTrack. Throws with every validator message
 *  joined, never returns a half-valid Track. */
export function parseTrack(json: unknown): Track

export interface LoadedTrack { track: Track; query: TrackQuery; theme: TrackTheme }

export async function loadTrack(id: string, fetchJson: FetchJson): Promise<LoadedTrack>
```

### 5.4 `src/content/bundle.ts` — characters, karts, themes

```ts
export interface ContentBundle {
  characters: readonly CharacterDescriptor[]  // length 8
  karts: readonly KartDescriptor[]            // length 8
  themes: Readonly<Record<string, TrackTheme>>  // keyed by track id
}
export async function loadContentBundle(fetchJson: FetchJson): Promise<ContentBundle>
```

### 5.5 `src/controls/` — spec §6, three schemes plus keyboard

```ts
// src/controls/types.ts
export type ControlScheme = 'thumbZones' | 'tilt' | 'virtualStick' | 'keyboard'

export type PointerPhase = 'down' | 'move' | 'up'
export interface PointerSample { id: number; x: number; y: number; phase: PointerPhase }
export interface TiltSample { alpha: number; beta: number; gamma: number }
export interface Viewport { width: number; height: number }

/** Raw, device-shaped input for ONE frame. Filled by the DOM source (§5.6) or
 *  by a test, and consumed by exactly one ControlAdapter. */
export interface ControlInputs {
  pointers: PointerSample[]
  pointerCount: number
  keys: Readonly<Record<string, boolean>>
  tilt: TiltSample | null
  viewport: Viewport
}
export function createControlInputs(): ControlInputs

/** Every scheme is one of these and nothing more. Spec §6: "three schemes is
 *  three small adapters, not three control systems." */
export interface ControlAdapter {
  readonly scheme: ControlScheme
  /** Pure over (raw, tick, adapter's own latched state). Sole writer of `out`. */
  sample(raw: ControlInputs, tick: number, out: Intent): void
  /** Drops all latched state (drift hold, stick origin, pointer ids). */
  reset(): void
}
```

```ts
// src/controls/config.ts
export interface ControlConfig {
  deadZone: number            // 0..1 of half-screen for thumb zones / stick
  steerGain: number
  steerSmoothingPerTick: number
  tiltNeutralDegrees: number
  tiltRangeDegrees: number
  tiltCalibration: TiltCalibration
  invertTilt: boolean
  keyBindings: Readonly<Record<string, 'left' | 'right' | 'accel' | 'brake' | 'drift' | 'item'>>
}
export const DEFAULT_CONTROL_CONFIG: Readonly<ControlConfig>
```

```ts
// src/controls/tilt.ts
export interface TiltCalibration { betaZero: number; gammaZero: number }
export const IDENTITY_TILT_CALIBRATION: Readonly<TiltCalibration>
/** Pure: the sample the player held while the calibration prompt was up. */
export function calibrateTilt(sample: TiltSample): TiltCalibration
```

```ts
// src/controls/index.ts
export function makeControlAdapter(scheme: ControlScheme, cfg: ControlConfig): ControlAdapter
```

The four adapters themselves (`thumbzones.ts`, `tilt.ts`, `stick.ts`,
`keyboard.ts`) export only their factory, and `makeControlAdapter` is the sole
public entry point.

Spec §6, made mechanical:

| Scheme | `accel` | `brake` | `steer` | `drift` | `useItem` |
|---|---|---|---|---|---|
| `thumbZones` (default) | always `1` | never set | left-half drag, x-delta from touch origin | right-half hold zone | right-half tap zone |
| `tilt` | always `1` | never set | calibrated `gamma` | on-screen button | on-screen button |
| `virtualStick` | gas button | brake button | stick x | drift button | item button |
| `keyboard` | key | key | key pair | key | key |

§14 Q21–Q25 list the five places this table is a guess.

### 5.6 `src/controls/source.ts` — ADAPTER (thin, untestable)

```ts
export interface InputSource {
  /** Copies everything accumulated since the last call into `out`. */
  drain(out: ControlInputs): void
  detach(): void
}
/** Attaches pointer, key and deviceorientation listeners. The ONLY file in
 *  packages/game that references a DOM event. */
export function attachInputSource(target: EventTarget, viewport: Viewport): InputSource

/** iOS requires a user-gesture-gated permission prompt for motion. Resolves
 *  false when denied or unsupported; the caller falls back to `thumbZones`. */
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
  characterIdx: number
  lastTrackId: string
  playerName: string
}
export const DEFAULT_SETTINGS: Readonly<Settings>

/** Injected so tests never touch localStorage. */
export interface KeyValueStore { get(key: string): string | null; set(key: string, value: string): void }
export const memoryStore: () => KeyValueStore
export function loadSettings(store: KeyValueStore): Settings   // never throws; falls back per field
export function saveSettings(store: KeyValueStore, s: Settings): void
```

### 5.8 `src/roomcode.ts`

```ts
export const ROOM_CODE_LENGTH = 4
/** Ambiguity-free: no O/0, no I/1. */
export const ROOM_CODE_ALPHABET: string
export function normalizeRoomCode(raw: string): string    // upper-case, strip non-alphabet
export function isValidRoomCode(raw: string): boolean
```

Minting a room code is the **server's** job (spec §5, step 1) and therefore Plan
4's. Plan 3 only normalises what a player types and displays what it is given.

### 5.9 `src/app.ts` — the screen state machine, pure

```ts
export type ScreenId =
  | 'title' | 'connect' | 'characterSelect' | 'lobby'
  | 'countdown' | 'race' | 'results'

export interface LobbySlot {
  playerId: number
  name: string
  characterIdx: number
  isBot: boolean
  connected: boolean
  ready: boolean
}

export interface ResultRow { place: number; playerId: number; name: string; finished: boolean }

export interface AppState {
  screen: ScreenId
  role: SessionRole
  roomCode: string
  trackId: string
  localPlayerId: number
  slots: LobbySlot[]          // length MAX_KARTS
  settings: Settings
  results: ResultRow[]
  error: string               // '' when none
  connecting: boolean
}
export function createAppState(settings: Settings): AppState

export type AppEvent =
  | { kind: 'hostPressed' }
  | { kind: 'joinPressed' }
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

/** Pure, total, allocation-free-of-surprises: returns a NEW AppState and never
 *  mutates `prev`. Sole writer of every AppState field. An unknown transition is
 *  a no-op returning `prev` by identity, never a throw. */
export function reduceApp(prev: AppState, ev: AppEvent): AppState

/** Every legal (screen, event.kind) pair, as data. Exported so a test can prove
 *  the table and the reducer agree, rather than testing the reducer against
 *  itself. */
export const SCREEN_TRANSITIONS: Readonly<Record<ScreenId, readonly AppEvent['kind'][]>>
```

### 5.10 `src/session.ts` — the composition root for one race

```ts
export type SessionRole = 'host' | 'guest' | 'solo'

export interface SessionOptions {
  role: SessionRole
  ctx: SimContext             // ctx.isLeader MUST equal (role !== 'guest')
  localPlayerId: number       // -1 not allowed
  seed: number
  characterIdx: number[]      // length MAX_KARTS
  transport: Transport | null // null is legal ONLY for role 'solo'
}

export interface RaceSession {
  readonly role: SessionRole
  readonly localPlayerId: number
  readonly ctx: SimContext

  /** Advance exactly one 60 Hz sim tick with the local player's intent. */
  tickOnce(localIntent: Intent): void

  /** The state this session is entitled to read. Host/solo: the authoritative
   *  state. Guest: the predicted state, whose remote seats §7.1 forbids drawing. */
  state(): SimState

  /** Guest only: the interpolated pose for a remote seat, ~100 ms in the past.
   *  Returns null on host/solo (where `state()` is already authoritative) and
   *  null for the local seat. `nowMs` MUST come from `renderNowMs`. */
  sampleRemoteKart(playerId: number, nowMs: number): RemoteSample | null

  /** Reconciliation corrections so far; 0 on host/solo. Surfaced for the
   *  zero-corrections invariant and for a dev overlay. */
  corrections(): number

  close(): void
}

/** Wires AuthorityLoop (host/solo) or ClientLoop (guest) over the given
 *  Transport. Sole constructor of a net loop in the entire game package. */
export function createSession(opts: SessionOptions): RaceSession
```

### 5.11 `src/view.ts` — the one place prediction and interpolation are chosen between

```ts
/** Fills `out` from `session`, obeying §7.1 seat by seat. Sole writer of every
 *  RaceView field. Allocates nothing. This is the highest-value pure function in
 *  packages/game and it is tested against every role. */
export function buildRaceView(session: RaceSession, alpha: number, out: RaceView): void
```

### 5.12 `src/shell.ts` — ADAPTER (thin, untestable)

```ts
export interface ShellOptions {
  canvas: HTMLCanvasElement
  root: HTMLElement           // where HUD/screen DOM is mounted
  clock: FrameClock
  fetchJson: FetchJson
  store: KeyValueStore
  renderer: RendererBackend
  audio: AudioBackend | null
}
export interface GameShell { stop(): void }

/** requestAnimationFrame loop: drain input -> advanceAccumulator -> N x
 *  session.tickOnce -> buildRaceView -> updateCamera -> buildRenderFrame ->
 *  renderer.applyFrame -> buildHudModel -> DOM. Contains no game decisions. */
export function startShell(opts: ShellOptions): GameShell
```

### 5.13 `src/index.ts` — the barrel

Re-exports `clock`, `content/tuning`, `content/tracks`, `content/bundle`,
`controls/types`, `controls/config`, `controls/tilt`, `controls/index`,
`settings`, `roomcode`, `app`, `session`, `view`. **Not** `controls/source` and
**not** `shell` — both are DOM adapters (§8.2).

---

## 6. Three numbers that must agree, or nothing works

### 6.1 The tick is 60 Hz and `game` never invents a different one

`session.tickOnce` is called exactly `advanceAccumulator()` times per frame.
`ClientLoop` owns its own 30 Hz input send cadence internally; `game` does not
throttle, batch or skip calls to `tickOnce`. §14 Q8 asks this to be confirmed
against Plan 2's Task 15 as built.

### 6.2 `alpha` is the sub-tick fraction and it is used for exactly two things

Camera smoothing sub-tick blending, and `renderNowMs`. It is **not** used to
interpolate the local kart's own position unless §14 Q9 is ruled that way,
because doing so requires `game` to retain a previous `SimState` that nothing
currently keeps.

### 6.3 The interpolator timebase — the single easiest way to break every remote kart

`ClientLoop` stamps every keyframe:

```ts
this.remoteInterp.push({ recvAtMs: this.predicted.tick * TICK_MS, karts: ... })
```

So `RemoteInterpolator`'s notion of "now" is **tick × 16.667 ms**, not
`performance.now()`. `sampleKart` subtracts `REMOTE_INTERP_DELAY_MS = 100` from
whatever it is passed and looks for bracketing keyframes.

**Therefore:** the only legal argument is
`renderNowMs(session.state().tick, alpha)`.

Pass `clock.nowMs()` instead and the target instant is thousands of milliseconds
past the newest keyframe on the very first frame, so **every** remote kart takes
the extrapolation branch, clamps at `REMOTE_EXTRAPOLATE_CAP_MS`, and slides
200 ms along its last velocity forever. Nothing throws. Nothing logs. It merely
looks wrong on a device, which is the one place CI cannot see (spec §8).

This is stated here, in the contract, precisely because it is invisible to every
test that does not specifically assert it — and §8.1 requires one that does.

---

## 7. Sole-writer rules

### 7.1 The seat-source rule — spec §5, made checkable

> Remote karts and all world entities are not predicted. They are buffered and
> rendered approximately 100ms in the past with interpolation.

Resolved per role, per seat:

| Role | Local seat | Remote seats | Entities | Item boxes |
|---|---|---|---|---|
| `solo` | `state()` → `'authoritative'` | `state()` → `'authoritative'` | `state()` → `'authoritative'` | `state()` |
| `host` | `state()` → `'authoritative'` | `state()` → `'authoritative'` | `state()` → `'authoritative'` | `state()` |
| `guest` | `state()` → `'predicted'` | `sampleRemoteKart()` → `'interpolated'`; `'absent'` when it returns null | **unresolved — §14 Q4** | **unresolved — §14 Q5** |

A host's `AuthorityLoop.state()` *is* the authority, so drawing every seat from
it is not a violation — the prohibition is on drawing a **client's local
prediction of somebody else's kart**, which on a guest is literally the sim's own
bot AI driving that seat (`packages/net/src/client.ts` doc comment: "the other
seven seats are driven by the sim's own bot AI (never trusted, never rendered)").

`viewSourceViolations(view, role)` encodes exactly this table, and a CI test runs
it over a guest session after 600 ticks of loopback traffic.

### 7.2 Every other sole writer

| Field / object | Sole writer | Nothing else may assign it |
|---|---|---|
| `SimState` (any field) | `@tapkart/net`'s loops, via `step`/`applyEvent`/`applySnapshotToState` | `render` holds no reference; `game` writes it only through `session.tickOnce` |
| `RaceView` (any field) | `buildRaceView` | `render` receives it `readonly` in spirit and mutates nothing |
| `KartView.source` | `buildRaceView` | — |
| `KartView.place` | `buildRaceView`, from `computePlacement` | HUD reads, never derives its own ordering |
| `CameraState` | `updateCamera` | `buildRenderFrame` reads the camera and copies it into the frame |
| `RenderFrame` | `buildRenderFrame` | the adapter reads only |
| `HudModel` | `buildHudModel` | — |
| `AudioModel` | `buildAudioModel` | — |
| `AppState` | `reduceApp` | no screen module mutates it |
| `Intent` (the local one) | the active `ControlAdapter.sample` | exactly one adapter is active at a time (unless §14 Q23 rules otherwise) |
| `TickAccumulator` | `advanceAccumulator` | — |
| The Three.js scene graph | the object returned by `createThreeRenderer` | — |
| Road-surface geometry | `buildTrackMesh` | — |
| `Settings` persistence | `saveSettings` | — |

### 7.3 Scratch-object discipline, restated because `render` is the first package likely to break it

`ctx.query.sampleAt`, `tangentAt` and `project` return **the same object every
call**. A mesh builder that writes

```ts
const a = query.sampleAt(s0)
const b = query.sampleAt(s1)   // `a` is now `b`
```

produces a degenerate ribbon and no error. Every `render` call site copies the
fields it needs before the next query call. A test that builds a mesh and asserts
non-degenerate triangle area catches this and is required.

---

## 8. Headless testability — how, explicitly

Spec §8 gives `render` one line — *"Scene-graph assertions against a mocked
renderer; visuals are owner-verified"* — and a "What CI cannot verify" section
that names only phone feel and the NFC tap. This section says what that means
concretely, because the difference between a testable and an untestable render
package is decided entirely by where the seam sits.

### 8.1 What is a pure function over state that a test asserts

Every one of these is a plain function, run under `environment: 'node'`, with no
canvas, no GPU, no DOM and no clock:

| Pure surface | The assertion CI makes |
|---|---|
| `buildTrackMesh` | vertex/index counts match `ringsPerSegment × lateralSteps × controlPoints.length`; every triangle has non-zero area; every generated vertex's y is within tolerance of `query.groundHeight(s, lateral)` for its own (s, lateral); the mesh's bounds sit inside `track.bounds`. Run over **all six shipped tracks** |
| `buildBoostPadMesh` / `buildRampMesh` | quad count equals `track.boostPads.length` / `track.ramps.length`; **zero ramps yields empty arrays, not a throw** |
| `buildKartMesh` / `buildCharacterMesh` | deterministic vertex counts per descriptor; bounds match the descriptor's declared dimensions |
| `parseTrack` / `parse*Descriptor` / `parseTrackTheme` | every shipped file parses; a mutated fixture throws with a message naming the field |
| `updateCamera` | converges monotonically toward the target pose; identical output for identical (state, ticks); N calls with 1 tick equal 1 call with N ticks within tolerance |
| `buildRenderFrame` | given a hand-built `RaceView`, exact `KartDraw` values; a spun-out kart has non-zero `spinAngle`; an invulnerable kart flickers `alpha`; a shielded kart sets `shieldVisible`; `entityCount` is respected and slot `entityCount` is `visible: false` |
| `driftTierOf` | tier boundaries exactly at `Tuning.driftTiers` |
| `buildHudModel` | `place` is 1-based; `lap` is clamped to `RACE_LAPS`; `countdownLabel` walks `3,2,1,GO` across `COUNTDOWN_TICKS` |
| `buildAudioModel` | a lap crossing between two views fires exactly one `lapCross` cue and no others |
| every `ControlAdapter.sample` | a scripted `ControlInputs` sequence produces an exact `Intent` sequence; `steer` is always in `[-1, 1]` and `accel` in `[0, 1]`; `reset()` clears the drift latch |
| `reduceApp` | every entry in `SCREEN_TRANSITIONS` is reachable; every event not in the table is an identity no-op; `prev` is never mutated |
| `advanceAccumulator` | 16.67 ms yields 1 tick; 1000 ms yields `MAX_CATCHUP_TICKS`; residual is always `< TICK_MS` |
| `viewSourceViolations` | **the flagship**: run a guest `ClientLoop` and a host `AuthorityLoop` over `makeLoopbackPair` at 150 ms / 50 ms / 5 % for 600 ticks, build a view every frame, assert `[]` every time and assert at least one seat actually reported `'interpolated'` (so an all-`absent` view cannot pass) |
| `renderNowMs` vs the interpolator | drive a guest session, sample a remote kart with `renderNowMs(...)`, and assert the sample is **not** pinned at the extrapolation cap — the §6.3 failure, made visible |

### 8.2 What is the thin untestable draw layer

Exactly four files, and CI never imports any of them:

- `packages/render/src/three/renderer.ts` — the only `three` import.
- `packages/render/src/three/*` — any further Three-side helpers.
- `packages/game/src/controls/source.ts` — DOM event listeners, `deviceorientation`, iOS permission.
- `packages/game/src/shell.ts` — `requestAnimationFrame`, canvas sizing, DOM mounting.

**Neither package's barrel re-exports any of them.** This is not tidiness; it is
what keeps `import { buildRenderFrame } from '@tapkart/render'` resolvable under
vitest's `environment: 'node'`. A barrel that re-exported `three/renderer.ts`
would pull `three` — and, transitively, `HTMLCanvasElement` — into every headless
test in the repository, and the failure appears as an unrelated test suite
breaking. `verbatimModuleSyntax` does **not** save this: a value import of
`three` survives erasure. Even `import type { Scene } from 'three'` is banned
outside `src/three/` so that a later refactor cannot quietly turn it into a value
import.

The `RendererBackend` interface lives in `backend.ts`, which imports nothing, so
the mock backend a test uses is a plain object literal and the scene-graph
assertions spec §8 asks for are made against `applyFrame`'s argument.

### 8.3 What CI cannot verify — restated for this plan

Spec §8 names two. Plan 3 adds the ones that are specific to rendering, so nobody
later mistakes their absence for an oversight:

- **How the game feels on a real phone** (spec §8) — frame pacing, touch
  latency, whether the chase camera is nauseating.
- **The NFC tap** (spec §8) — Plan 5's, and two physical devices.
- **That the pixels are correct.** CI proves `RenderFrame` is right and that the
  adapter was handed it. It cannot prove Three.js drew it, that the shader
  compiled, or that the kart is not inside the road. Owner-verified.
- **That the phone sustains authority loop plus 3D render** (spec §11's first
  risk). Measurable only on device.
- **Audio.** `AudioModel` is asserted; whether it sounds like an engine is not.

Adding a test that needs a GPU, a headless browser, or a canvas to the vitest
suite is out of scope for Plan 3 by this contract. Playwright E2E (spec §8's last
row) is a separate lane and is **Plan 4's**, because it needs two browser
contexts joining by code, and there is no server to join until then.

---

## 9. Test fixtures — `packages/render/test/fixtures/` and `packages/game/test/fixtures/`

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
export const SHIPPED_TRACK_IDS: readonly string[]      // the six, for it.each
```

```ts
// packages/game/test/fixtures/game-fixtures.ts
export function makeGameContext(isLeader?: boolean): SimContext
export function makeFetchJson(files: Readonly<Record<string, unknown>>): FetchJson
export function makeControlInputsFixture(overrides?: Partial<ControlInputs>): ControlInputs
export function makeSettingsFixture(overrides?: Partial<Settings>): Settings
/** Host + guest over a shared loopback pair at spec §8's conditions. */
export function makeSessionPair(opts?: Partial<LoopbackOptions>):
  { host: RaceSession; guest: RaceSession; pump(nowMs: number): void }
```

`makeSessionPair`'s default `LoopbackOptions` is Plan 2's:
`{ latencyMs: 150, jitterMs: 50, lossRate: 0.05, seed: 0xC0FFEE }`.

---

## 10. Package manifests

```jsonc
// packages/render/package.json
{ "name": "@tapkart/render", "version": "0.1.0", "private": true, "type": "module",
  "exports": { ".": "./src/index.ts", "./three": "./src/three/renderer.ts" },
  "dependencies": { "@tapkart/sim": "*", "three": "<pinned — §14 Q10>" },
  "scripts": { "typecheck": "tsc --noEmit -p tsconfig.json" } }

// packages/game/package.json
{ "name": "@tapkart/game", "version": "0.1.0", "private": true, "type": "module",
  "exports": { ".": "./src/index.ts", "./shell": "./src/shell.ts" },
  "dependencies": { "@tapkart/sim": "*", "@tapkart/net": "*", "@tapkart/render": "*" },
  "scripts": { "typecheck": "tsc --noEmit -p tsconfig.json" } }
```

Both `tsconfig.json` files are `{ "extends": "../../tsconfig.base.json",
"include": ["src/**/*.ts", "test/**/*.ts"] }`, identical to `sim`'s.

The second `exports` entry in each is how the DOM adapter stays reachable to the
app that needs it while staying out of the headless barrel (§8.2).

---

## 11. Exported-symbol census

| Module | Count |
|---|---|
| `render/time` | 2 |
| `render/types` | 7 |
| `render/mesh` | 10 |
| `render/descriptors` | 7 |
| `render/theme` | 3 |
| `render/camera` | 6 |
| `render/frame` | 6 |
| `render/hud` | 4 |
| `render/audio` | 6 |
| `render/backend` | 2 |
| `render/three/renderer` | 3 |
| **`render` subtotal** | **56** |
| `game/clock` | 8 |
| `game/content/tuning` | 2 |
| `game/content/tracks` | 6 |
| `game/content/bundle` | 2 |
| `game/controls/types` | 8 |
| `game/controls/config` | 2 |
| `game/controls/tilt` | 3 |
| `game/controls/index` | 1 |
| `game/controls/source` | 3 |
| `game/settings` | 6 |
| `game/roomcode` | 4 |
| `game/app` | 8 |
| `game/session` | 4 |
| `game/view` | 1 |
| `game/shell` | 3 |
| **`game` subtotal** | **61** |
| **Total** | **117** |

Plus 13 fixture exports in §9, which are test-only and not part of either
package's public surface.

---

## 12. What Plan 3 deliberately does not build

Stated so a task does not "helpfully" add it:

- **No `apps/web`.** No Vite config, no `index.html`, no PWA manifest, no service
  worker, no Dockerfile. `packages/game` exports `startShell`; nothing calls it
  yet. §14 Q11 asks whether that is right.
- **No WebRTC and no WebSocket transport.** Plan 2 built the interface and
  Loopback; Plan 4 builds the two real ones. A `guest` session in Plan 3 is a
  guest over `makeLoopbackPair`, which is exactly what spec §8's netcode tests use.
- **No signalling, no room registry, no server.** Plan 4.
- **No NFC, no HCE, no App Links, no APK, no keystore.** Plan 5.
- **No Playwright E2E.** Plan 4 (§8.3).
- **No delta encoding, no LOD, no instancing beyond what `RendererBackend`
  hides.** Spec §5 says v1 ships uncompressed; spec §11 names instanced meshes as
  a mitigation, which is an adapter-side implementation detail, not a contract.

---

## 13. The failure this contract is written to prevent

Plan 2's contract needed twelve amendments during authoring and each one cost
roughly two blocking defects at audit. The three highest-risk shared names in
Plan 3, ranked by how many tasks would have to agree on them independently:

1. **`RaceView` and `ViewSource`** — every render task and every game task reads
   or writes them. If two tasks disagree on whether `place` is 0-based or 1-based,
   or on whether a guest's remote seat is `'interpolated'` or `'absent'` when the
   buffer is cold, the mismatch surfaces as a HUD that is off by one or a kart
   that vanishes for the first 100 ms of every race. Both are settled above:
   `KartView.place` is **0-based**, `HudModel.place` is **1-based**, and a cold
   buffer is `'absent'` with `visible: false`.
2. **The interpolator timebase** (§6.3). One wrong argument, no error, every
   remote kart wrong, invisible to CI.
3. **The pure/adapter seam** (§8.2). One `export * from './three/renderer'` in a
   barrel and the entire headless suite stops resolving, in a way whose error
   message points at the wrong package.

---

## 14. Open questions for the controller

Every item below is a place this draft guessed, a place the spec admits two
readings, or a place the existing code and the spec disagree. Each one is an
amendment avoided if ruled on now.

### Content that does not exist

**Q1. There is no shipped `Tuning` or `CharacterStats[]` anywhere in `src`.**
The only ones in the repository are `makeTuning()` and `makeCharacters()` in
`packages/sim/test/fixtures/track-fixtures.ts`, and Plan 2 §6 forbids publishing
fixtures through `@tapkart/sim`'s exports ("shipping fixtures in the public
surface is how they end up in the game bundle"). `game` cannot construct a
`SimContext` without both. This draft puts them in
`packages/game/src/content/tuning.ts` as `TUNING` and `CHARACTERS`. **Is that the
right home** — vs. a new `packages/content`, vs. JSON in `content/`, vs. widening
`@tapkart/sim` after all? And **must `TUNING` be numerically identical to
`makeTuning()`**, asserted by a test? If it may diverge, Plan 1's 477 tests and
the golden replay fixture describe physics no player experiences.

**Q2. The 8 character and 8 kart JSON descriptors (spec §7) do not exist.**
`content/` holds only tracks. Does Plan 3 author them by hand, or is this the
spec §10 DeepSeek delegation ("Eight character and eight kart descriptors")? If
delegated, the schema in §4.4 must be locked before the job runs, and the
delegation is a Plan 3 task. If hand-authored, whose judgment sets the palettes?

**Q3. Per-track theme palettes (spec §10) do not exist either.** Same question.
Six themes, one per shipped track, schema in §4.5. Without them every track is
`DEFAULT_TRACK_THEME` grey and the six tracks are visually identical.

**Q4. A guest has no data path for entities at all.** Spec §5: "Entities are
authority-simulated and client-interpolated only, never predicted." But
`RemoteInterpolator` has exactly one sampling method, `sampleKart`, and
`RemoteKeyframe` carries only `karts: WireKart[]`. `WireSnapshot` *does* carry
entities, and `ClientLoop` decodes them — then discards them. So on a guest,
today, there are three options and all three are bad: (a) draw entities from the
predicted `SimState`, which spec §5 explicitly forbids; (b) draw no entities on a
guest, so shells and slicks are invisible to everyone but the host; (c) amend
`net` to add `RemoteKeyframe.entities` and `sampleEntity`. **This draft assumes
(c) and marks the row "unresolved" in §7.1.** If (c), is it a Plan 2 amendment or
a Plan 3 task that edits `net`? A Plan 3 task editing `net` breaks §1's "nothing
depends on render/game" the other way round and needs an explicit ruling.

**Q5. A guest has no correct source for remote karts' lap, place, item or
connection state.** `ClientLoop` never calls `applySnapshotToState`, so the other
seven seats in `predicted` are the sim's own bot AI. `RemoteSample` carries only
`{ position, heading }`. That means a guest's HUD standings, the leaderboard, the
lap counter for anyone else, and every remote kart's held item are all derived
from a bot simulation that has nothing to do with the real race.
`WireSnapshot.karts[i]` carries every one of those fields. Options: amend `net` so
`RemoteInterpolator` retains the full `WireKart` and exposes it; or have
`ClientLoop` call `applySnapshotToState` for non-local seats. **This is the single
largest functional gap between what exists and what a playable guest needs, and
this draft cannot resolve it without a ruling.**

### Timebase and loop

**Q6. Should Plan 2 export `TICK_MS`?** It is `const TICK_MS = 1000 / TICK_HZ` in
`client.ts`, unexported. §4.1 redefines it in `render` with the identical
expression, and §6.3 explains what a divergence costs. Exporting it from `net`
(or `sim`) would make the coupling explicit. Ruling requested because the fix is
a one-line Plan 2 edit and the alternative is a permanent two-definition hazard.

**Q7. Confirm §6.3's rule** — that `sampleKart`'s `nowMs` is
`renderNowMs(session.state().tick, alpha)` and never a `FrameClock` reading. This
draft is confident, but it is derived from one line of Plan 2's task brief rather
than from shipped code (`client.ts` does not exist in the worktree yet), and if
Task 15 shipped a different stamp the rule inverts.

**Q8. Does `game` call `ClientLoop.tick()` once per 60 Hz sim tick?** Spec §5
says input goes out at 30 Hz carrying the last 8 intents, and `INPUT_REDUNDANCY`
is 8. This draft assumes `ClientLoop` owns that cadence internally and `game`
simply ticks it 60×/s. If instead `game` is expected to call it at 30 Hz, §5.1's
accumulator and §6.1 are both wrong.

**Q9. Is the local kart interpolated between ticks for rendering?** At 60 Hz sim
on a 120 Hz display, drawing the local kart at its exact tick position judders.
Doing better needs `game` to retain the previous `SimState` and lerp — an extra
full `SimState` per session and a real allocation. Worth it, or does the local
kart snap to tick positions in v1?

### Architecture and packaging

**Q10. `three` is the first runtime dependency in the repository.** Spec §3 says
"Three.js scene"; the Plan 3 brief says "Canvas/WebGL". Confirm Three.js is
mandated (rather than a hand-rolled WebGL renderer), and name the **exact pinned
version**. Also: does the `RendererBackend` seam mean a `Canvas2D` fallback
backend is wanted for low-end devices, or is WebGL-or-nothing correct for v1?

**Q11. Does Plan 3 create `apps/web`?** Spec §3's tree has it, and without it Plan
3 ships two libraries and nothing a human can open — `startShell` is exported and
never called. But `apps/web` also implies Vite config, PWA manifest, service
worker and the Dockerfile, which read like Plan 4/5 concerns. **This draft assumes
NO (§12) and it is the assumption most likely to be wrong.**

**Q12. Where do `content/tracks/*.json` live at runtime?** They sit outside every
package and outside every `exports` map. Options: copied to `apps/web/public/` by
a build step and fetched (what §5.3's injected `FetchJson` assumes); imported via
Vite `import.meta.glob` and bundled; or moved into `packages/game/src/content/`
as TS modules. The choice decides whether `loadTrack` is async at all.

**Q13. Does `game` ever need `@tapkart/protocol` directly?** This draft says no
(§2.3) and omits it from `package.json`. If a lobby message codec turns out to
live in `protocol` and be needed by a Plan 3 screen, that is an amendment.

### Screens and flow

**Q14. The screen list is stated twice and differently.** Spec §3 says `game`
holds "screens (title, character select, lobby, race, results)" — five. The Plan
3 brief says "title → join/host → lobby → countdown → race → results" — six, with
no character select and with `join/host` and `countdown` as screens. §5.9's
`ScreenId` unions both into seven. **Which is canonical?** Specifically: is
character select its own screen or a lobby panel, and is countdown a screen or
just `RacePhase === 'countdown'` inside the race screen (which is what `sim`
already models)?

**Q15. Solo play with no transport.** `SessionOptions.transport` may be `null`
only for `role: 'solo'`. Is that right — a solo race running `AuthorityLoop` with
no transport at all — or should solo always use a `LoopbackTransport` so exactly
one code path exists? The first is simpler; the second is better tested, because
solo then exercises the same loop the host does.

**Q16. Results screen content.** `SimState` carries `finishedOrder` and
`finishTick` and **nothing else** — no per-kart finish tick, no lap times. So the
results screen can show ranking but cannot show anyone's time or best lap without
`game` recording them client-side (non-authoritative, and different per peer).
Is positions-only correct for v1, or does Plan 3 record times locally?

**Q17. DNF display.** `updatePhase` writes still-driving karts into
`finishedOrder` in placement order when `FINISH_GRACE_TICKS` (1800 = 30 s)
elapses. Those entries are indistinguishable from real finishers in the array.
Should the results screen mark them DNF, and if so, from what — comparing against
`finishTick + FINISH_GRACE_TICKS`?

**Q18. Lap display.** `KartState.lap.lap` starts at 0 and `updateLaps` credits
lap 1 on the first crossing. This draft displays `clamp(lap + 1, 1, RACE_LAPS)`
as "LAP n/3". Confirm — the alternative reading shows "LAP 0/3" on the grid.

### Track rendering

**Q19. What is `track.bounds` for?** It is far larger than the ribbon (e.g.
`neon-district` is ±300 while the road spans roughly ±190), and `sim` never
consults it for containment — `isInBounds` uses `width × BOUNDS_HALF_WIDTH_MUL`.
Is it a render extent (ground plane size, camera far clamp, skybox scale), a
validator-only field, or dead? §4.3's `meshBounds` test asserts the generated
mesh sits inside it, which assumes "render extent".

**Q20. Is there any scenery?** The track JSON describes a ribbon and nothing
else: no props, no buildings, no trees, no crowd. `neon-district`, `redwood-rise`
and `glacier-pass` are named for scenery that does not exist in their data. Does
Plan 3 generate procedural scenery from the theme (and if so, from what schema),
or does v1 ship a ribbon over a tinted ground plane?

### Controls (spec §6)

**Q21. Does `accel` stay 1 during spin-out and respawn on the auto-accelerate
schemes?** `sim` ignores input while `motionLocked`, so it does not matter
mechanically — but it decides whether the HUD shows the throttle as live, and
whether a "brake" affordance exists at all on `thumbZones` (§5.5's table says it
never sets `brake`, which means a `thumbZones` player can never reverse out of a
wall and relies entirely on the 1.2 s out-of-bounds respawn).

**Q22. iOS motion permission.** `requestTiltPermission()` must be called from a
user gesture. Where in the flow — a settings toggle, or the first time `tilt` is
selected? And on denial, does the scheme silently fall back to `thumbZones`, or
does the settings screen show an error and keep the selection?

**Q23. Is keyboard simultaneous with a touch scheme, or exclusive?** Spec §6:
"Keyboard is always available on desktop for development and testing." "Always
available" reads as *merged with* whatever scheme is selected, which means two
adapters writing one `Intent` and breaks §7.2's sole-writer rule for `Intent`.
This draft made it a fourth exclusive `ControlScheme`. Confirm, or rule that a
`CompositeAdapter` exists with a stated merge rule (max-magnitude steer,
logical-OR buttons).

**Q24. `thumbZones` layout.** Spec §6: "The left half of the screen steers by
drag; the right half holds drift and item buttons." Two buttons in one half:
where exactly, how big, and what happens when a thumb lands between them? Also:
is steering **absolute** (x position relative to screen centre) or **relative**
(delta from touch-down origin)? This draft assumed relative-to-origin, which is
the mobile-racer convention, but the spec sentence supports either.

**Q25. Is `useItem` a level or an edge?** `Intent.useItem` is a per-tick boolean
and `sim`'s `useItem` fires on any true tick. A held item button therefore fires
every tick until the item is spent — harmless because `useItem` guards on
`item !== 'none'`, but it means a held button auto-fires the next item the
instant it is granted. Should adapters emit a **one-tick pulse** on press instead?

### Audio and scope

**Q26. Is procedural audio (spec §7) in Plan 3?** §4.9 designs the seam, but
audio could equally be a Plan 5 polish item. If it is in, is the `AudioBackend`
Web Audio implementation an adapter that CI never imports (this draft's
assumption), and does `AudioModel` need per-kart engine voices (8 oscillators) or
only the local kart's?

**Q27. `surge` has no meaningful world position.** It is "a timed field-wide slow
on everyone ahead" (spec §4), yet `spawnEntity` gives it a position like any
other entity. Is it drawn as a world object at all, or purely as
`RenderFrame.screenTint*` on affected karts?

**Q28. `bubble` orbits, but nothing in `EntityState` says so.** Spec §4 calls it
an "orbiting shield". `EntityState` carries `position`/`velocity`/`heading`
updated by `sim`. If `render` adds cosmetic orbital motion on top, the drawn
bubble is not where the collision bubble is. Does `sim` already orbit it (needs
checking in `entity.ts`'s `updateEntities`), or does `render` fake it and accept
the mismatch?

**Q29. Item-box visuals when `respawnTicks > 0`.** Hidden entirely, or shown
ghosted? §4.7's `itemBoxVisible: boolean[]` assumes binary. A ghosted state needs
a number.

### Testing

**Q30. Does anything in Plan 3 need a non-`node` vitest environment?** The root
`vitest.config.ts` sets `environment: 'node'` globally with
`include: ['packages/*/test/**/*.test.ts']`. §8.2's seam is designed so the answer
is no. If any task decides it needs jsdom, that is a root-config change affecting
every package and must be an amendment, not a per-file
`// @vitest-environment jsdom` slipped in.

**Q31. How much tolerance is "the mesh matches `groundHeight`"?** §8.1's flagship
mesh test compares generated vertex y against `query.groundHeight(s, lateral)`.
The two are computed by different code paths (`splinePointAt` at a segment
parameter vs. `locateS` then `splinePointAt`), so they will not be bit-identical.
This draft did not pick a tolerance. 1 mm? 1 cm? Whatever it is, it should be
stated in the contract so two tasks do not pick different ones.

**Q32. Should `viewSourceViolations` also run in dev builds?** It is exported
from `render` rather than living in a test file specifically so it *could*. If
yes, what is the "dev build" flag, given there is no bundler in Plan 3 (Q11)?

**Q33. Does Plan 3 add a golden-frame fixture** — a serialized `RenderFrame` for
a known `RaceView`, committed and compared field-by-field like `sim`'s golden
replay? It would be the strongest possible regression net for `buildRenderFrame`,
and it is cheap. But it also freezes every visual tuning constant, and Plan 3 is
the plan where those constants get tuned by eye.

**Q34. Where do the six shipped tracks get exercised?** §9's `loadShippedTrack`
reads `content/tracks/*.json` with `node:fs` from a test. That is a relative path
from `packages/render/test/` out to the repo root — the same class of cross-
boundary test-only reach Plan 2 §6 permitted for fixtures. Confirm it is
permitted here too, or the mesh tests run against `makeOvalTrack` only and the
six real tracks are never mesh-tested at all.
