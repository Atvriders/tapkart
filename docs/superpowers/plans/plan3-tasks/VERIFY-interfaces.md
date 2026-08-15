# Plan 3 — anchor verification across the 24 task files

Method: every `**Interfaces:**` block in `task-01.md` … `task-23.md` (+ `task-11b.md`) was read,
plus every code body that names a cross-task symbol. Each consumed symbol was matched against its
producing task and against `2026-08-14-tapkart-plan3-contract.md`. Sim-side claims were checked
against real source in `packages/sim/src/`. Items already recorded in `AUTHOR-DECISIONS.md`
(execution order 3→4→6→5, the shared `game-fixtures.ts`, Task 19's `results.ts` forward reference,
barrel ownership, the closed Plan 2 gate, `CHARACTERS.slice()`, the controls ESM cycle, the §2.6
fixture path) are **not** re-reported.

Findings are ranked by **how late they surface**: an assertion nobody writes never surfaces at all;
a compile break surfaces inside its own task.

---

## 1. BROKEN ANCHORS

### B1 — §8.1's "error smoothing, end to end" row has no owning task, and `makeCorrectingGuest` has no consumer
**Never surfaces. Highest rank.**

Contract §8.1 (line 2819) makes this row mandatory:

> | error smoothing, end to end | drive the §8.1 flagship guest session, record the drawn local
> position every frame, and assert **no frame-to-frame jump exceeds one tick of plausible travel** —
> the R41 defect, made visible. Without the smoother this fails ~3 times a second under changing input |

Contract §9.1 (lines 2903-2907) provides the fixture it needs:

```ts
/** A guest session whose ClientLoop has taken N corrections, for R41's smoothing
 *  tests: drives makeSessionPair with a changing (sine) intent, which is what
 *  actually produces corrections — a held-steady intent produces ~1 per 600 ticks. */
export function makeCorrectingGuest(ticks?: number):
  { host: RaceSession; guest: RaceSession; pump(nowMs: number): void; corrections(): number }
```

- **Producer:** Task 20 (`task-20.md:862-878`), verbatim to the contract.
- **Consumers:** none. A grep for `makeCorrectingGuest` across all 24 files returns Task 20 and
  `AUTHOR-DECISIONS.md:15` only.
- A grep for `frame-to-frame`, `end to end` and `plausible travel` across all 24 files returns
  **nothing**.

Why no task picked it up: Task 14 owns `smoothing.ts` and lives in `packages/render`, which may not
import `packages/game`'s fixtures (§1's dependency arrow), so it tests `advanceVisualOffset` in
isolation (`task-14.md:150-481`) and explicitly does not drive a session. Task 21 owns the *other*
flagship (`viewSourceViolations` over 600 guest ticks, `task-21.md:280-330`) and asserts nothing
about frame-to-frame position continuity. Task 20 builds the fixture and never uses it.

**Consequence:** every unit-level assertion about the smoother passes while the one assertion that
proves R41's defect is actually absorbed — the kart not jumping ~3×/s under real driving — is never
made. Section §4.9a's opening claim ("the netcode's central trade is dishonest without it") is left
unverified by CI, which is exactly the class of gap §8.1 exists to close.

**Right answer:** the test belongs in `packages/game/test/` (it needs `RaceSession` + `ViewBuilder`),
alongside Task 21's flagship, and it is the only consumer `makeCorrectingGuest` will ever have.
Assign it to Task 21 (or a new task after 21), reading the drawn local position off
`view.karts[localPlayerId].position` each frame.

---

### B2 — `TrackTheme.ground` and `TrackScene.bounds` are produced, gated, and consumed by nothing: there is no ground plane
**Never surfaces in CI. Rank 2.**

Contract §12 states the whole visual budget: *"A ribbon over a themed ground plane plus procedural
edge markers is the whole visual budget."* Q19 (§3, §4.3) rules `track.bounds` a **render extent** —
*"ground-plane size, camera far clamp, skybox scale"*.

The producers are all present:
- `TrackTheme.ground: PaletteRGB` — Task 4 (`task-04.md:35`, `task-04.md:403`), and Task 6 *gates* it:
  `roster.test.ts` asserts every theme's markers stay legible against `theme.ground`
  (`task-06.md:307-312`) and that road ≠ ground (`task-06.md:319-326`), and `gate-descriptors.mjs`
  enforces the same thresholds (`task-06.md:745-754`).
- `TrackScene.bounds` — Task 8 (`task-08.md:797`, `task-08.md:1313-1315`), `meshBounds(road)`.

The consumers are absent:
- Task 15's adapter (`task-15.md:978-1008`) adds `road`, `boostPads`, `ramps`, edge markers and
  checkpoints to `staticRoot`. It sets `scene.background` from `theme.sky.bottom`, `scene.fog` from
  `theme.fog`, `ambient.intensity` from `theme.ambient` and the sun from `theme.sunDirection`. It
  **never reads `theme.ground` and never reads `scene.bounds`**, and it creates no ground geometry
  (`PlaneGeometry(2, 2)` at `task-15.md:804` is the screen-space overlay quad, not a ground plane).
- No other task builds ground geometry: `render/mesh` (§4.3, Task 8) exports `buildTrackMesh`,
  `buildBoostPadMesh`, `buildRampMesh`, `buildCheckpointMarkers`, `buildEdgeMarkers` — and nothing
  else. §11's census fixes `render/mesh` at 15 symbols, so there is no room for a
  `buildGroundMesh` nobody wrote.

**Consequence:** the shipped scene is a ribbon floating over the sky-bottom clear colour. Q20's
justification for the edge markers ("a bare ribbon on a flat plane gives the player no speed cue")
is half-delivered, and six themes are gated for a ground colour nothing renders. CI cannot see it —
§8.3 says the pixels are owner-verified — so Task 23's operator check (`task-23.md:336-353`) is the
only place it can be caught, and its script does not mention the ground.

**Right answer:** the contract's §12 wins. The cheapest fix that touches one adapter and no pure
module is for Task 15's `setScene` to add a ground quad sized from `scene.bounds` (which is exactly
what Task 8 computes it for) and coloured `theme.ground`. If instead the ground is deliberately out
of v1, `theme.ground` should stop being a gated field and §12 should stop promising it.

---

### B3 — `TrackScene` in Task 15 is missing `itemBoxes: Vec3[]`
**Compile break inside Task 15; the behavioural half never surfaces. Rank 3.**

This is amendment 2, un-propagated. Details and line references are in section 2 below. Summary of
the mismatch:

| Side | Text |
|---|---|
| Task 8 (**producer**), `task-08.md:143-147` | `export interface TrackScene { road: MeshData; boostPads: MeshData; ramps: MeshData` / `checkpoints: MarkerPlacement[]; edgeMarkers: EdgeMarkerPlacement[]` / **`itemBoxes: Vec3[]`** `// one per track.itemBoxes, SAME INDEX as` / `// RenderFrame.itemBoxAlpha and ItemBoxView.boxIdx` / `bounds: { min: Vec3; max: Vec3 } }` |
| Task 15 (**consumer**), `task-15.md:90-97` | `export interface TrackScene {` / `road: MeshData` / `boostPads: MeshData` / `ramps: MeshData` / `checkpoints: MarkerPlacement[]` / `edgeMarkers: EdgeMarkerPlacement[]` / `bounds: { min: Vec3; max: Vec3 }` / `}` — **no `itemBoxes`** |
| Task 22 (**consumer**), `task-22.md:74-76` | `export interface TrackScene { road: MeshData; boostPads: MeshData; ramps: MeshData` / `checkpoints: MarkerPlacement[]; edgeMarkers: EdgeMarkerPlacement[]` / `bounds: { min: Vec3; max: Vec3 } }` — **no `itemBoxes`** |
| Contract §4.3, lines 1294-1301 | pre-amendment: no `itemBoxes`. **Superseded by the amendment.** |

**Task 8 is right.** Two concrete failures follow:

1. `task-15.md:209-221` builds a `TrackScene`-typed object literal for `backend.test.ts` with six
   properties. Once `itemBoxes` is required this is `TS2741: Property 'itemBoxes' is missing in type
   '{ road: …; boostPads: …; ramps: …; checkpoints: …; edgeMarkers: …; bounds: …; }' but required in
   type 'TrackScene'`. Task 15's own Step 4 gate (`npx tsc --noEmit -p packages/render/tsconfig.json`,
   `task-15.md:1145`) fails.
2. `task-15.md:1092-1097` and its commit body `task-15.md:1199-1203` still assert the pre-amendment
   position and propose the amendment as future work:

   > **Item boxes are not drawn.** `RenderFrame` carries `itemBoxAlpha` (Q29) but no item-box
   > positions, and `TrackScene` (§4.3) carries none either […] the cheapest fix is one
   > `itemBoxes: Vec3[]` field on `TrackScene`, filled from `itemBoxWorldPos`, and it is a `mesh.ts`
   > change, not this task's.

   That change has already been made (Task 8), so the prose is stale **and** the adapter still draws
   no item boxes — which is the gameplay defect the amendment was issued to close.

---

### B4 — `buildTrackScene` is called with the pre-amendment 4-argument signature in Task 22
**Compile break inside Task 22. Rank 4.**

| Side | Text |
|---|---|
| Task 8 (**producer**), `task-08.md:148-149` | `export function buildTrackScene(ctx: SimContext, theme: TrackTheme,` / `                                opts: MeshBuildOptions): TrackScene` |
| Task 22 (**consumer**), `task-22.md:77-78` | `export function buildTrackScene(track: Track, query: TrackQuery, theme: TrackTheme,` / `                                opts: MeshBuildOptions): TrackScene` |
| Task 22 call site, `task-22.md:763` | `buildTrackScene(loaded.track, loaded.query, loaded.theme, DEFAULT_MESH_OPTIONS),` |
| Contract §4.3, lines 1302-1303 | pre-amendment 4-arg form. **Superseded by the amendment.** |

**Task 8 is right** — `itemBoxWorldPos(ctx, boxIdx, out)` needs a `SimContext`, and `SimContext`
carries both `track` and `query`, so the 3-arg form is strictly narrower.

Fails as `TS2345: Argument of type 'Track' is not assignable to parameter of type 'SimContext'`
(plus `TS2554: Expected 3 arguments, but got 4`) at `packages/game/src/shell.ts`.

**The fix is one line and the input is already in scope**: `startRace` builds `const ctx: SimContext`
at `task-22.md:737-745`, immediately above the call. Replace `task-22.md:763` with
`buildTrackScene(ctx, loaded.theme, DEFAULT_MESH_OPTIONS),` and correct the Consumes block at
`task-22.md:74-78` to carry `itemBoxes: Vec3[]` and the 3-arg signature.

---

### B5 — The two root files are produced twice: Tasks 1 and 23 both own `package.json` and `vitest.config.ts`
**Surfaces as an empty commit. Rank 5.**

| Task | Claim |
|---|---|
| Task 1, `task-01.md:5-6` | `- Modify: package.json:6-8 — the workspaces array` / `- Modify: vitest.config.ts:5 — the include array` |
| Task 1, `task-01.md:96-97` | `Root package.json workspaces: ["packages/*", "apps/*"] … Root vitest.config.ts include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts']` |
| Task 1, `task-01.md:279-292` | performs both edits, and `task-01.md:194-210` asserts both in `packages/content/test/scaffold.test.ts` |
| Task 23, `task-23.md:4-5` | `- Modify: package.json:6-8 — workspaces gains "apps/*" (R36)` / `- Modify: vitest.config.ts:5 — include gains the apps glob (R37)` |
| Task 23, `task-23.md:112-132` | performs both edits again |
| Contract §10.2, lines 3027-3043 | assigns both to "Plan 3" without naming a task |

Not destructive — the edits are byte-identical and idempotent — but Task 23's Step 1 presents them
as changes with a stated verification, and `git add package.json vitest.config.ts` at
`task-23.md:682` would stage nothing, which reads as a mistake to whoever runs it. Task 16
(`task-16.md:49-53`) explicitly declines to make them and says they belong to "the `apps/web` task",
i.e. Task 23 — a third opinion.

**Task 1 should win** (its own `scaffold.test.ts` is the standing regression guard for both, and
Task 23's `apps/web` cannot resolve `@tapkart/game` without them anyway). Task 23's Step 1 should
become a *verify*, not a *modify*, matching how it already treats `packages/game/src/vite-env.d.ts`
elsewhere in the plan.

---

### B6 — `CHARACTERS` is declared mutable in Tasks 18 and 19, `readonly` everywhere else
**No compile break today. Rank 6.**

| Side | Text |
|---|---|
| Contract §3a.2, line 918 | `export const CHARACTERS: readonly CharacterStats[]` |
| Task 2 (**producer**), `task-02.md:103` | `export const CHARACTERS: readonly CharacterStats[]` |
| Task 18, `task-18.md:43` | `export const CHARACTERS: CharacterStats[]` |
| Task 19, `task-19.md:29` | `export const CHARACTERS: CharacterStats[]                    // length 8` |
| Task 22, `task-22.md:24` | `export const CHARACTERS: readonly CharacterStats[]` ✓ |
| Task 23, `task-23.md:66-67` | `**CHARACTERS is readonly CharacterStats[] …** — write CHARACTERS.slice()` ✓ |

**Task 2 / the contract are right.** Tasks 18 and 19 only read `CHARACTERS.length`
(`task-18.md:624`, `task-19.md:121`), so nothing breaks today — but this is precisely the asymmetry
`AUTHOR-DECISIONS.md:40-42` records as the one that bites, and a later edit that assigns
`CHARACTERS` into a `SimContext` from either file would be written against a wrong declaration.
Correct both Consumes blocks to `readonly CharacterStats[]`.

---

## 2. AMENDMENT PROPAGATION

### Amendment 1 — `buildTrackScene(ctx: SimContext, theme, opts)`

| Task | Status | Evidence |
|---|---|---|
| **Task 8** | **APPLIED** | Rationale `task-08.md:34-42`; Produces `task-08.md:148-149`; implementation `task-08.md:1286-1292`; its own call sites `task-08.md:586`, `:609`, `:663`; commit body `task-08.md:1386-1387` |
| **Task 22** | **NOT APPLIED** | Consumes `task-22.md:77-78` (4-arg); call site `task-22.md:763`. See B4 |
| Task 15 | n/a | names the `TrackScene` *type* only, never the function — nothing to propagate |
| all others | n/a | no task other than 8, 15 and 22 names `buildTrackScene` (verified by grep) |

### Amendment 2 — `TrackScene` gains `itemBoxes: Vec3[]`, index-paired with `RenderFrame.itemBoxAlpha`

| Task | Status | Evidence |
|---|---|---|
| **Task 8** | **APPLIED** | Rationale `task-08.md:25-32`; Produces `task-08.md:143-147`; declaration `task-08.md:786-798`; fill `task-08.md:1296-1304`; index-pairing test with an off-by-one witness `task-08.md:658-695` |
| **Task 15** | **NOT APPLIED** | Consumes `task-15.md:90-97`; test literal `task-15.md:209-221` (becomes `TS2741`); stale prose `task-15.md:1092-1097`; stale commit body `task-15.md:1199-1203`. See B3 |
| **Task 22** | **NOT APPLIED** | Consumes `task-22.md:74-76`. See B3 |
| Task 11 / 11b | n/a | own `RenderFrame.itemBoxAlpha` (`task-11.md:82`, `task-11b.md:917-923`); the amendment adds no field to `RenderFrame`, so nothing changes here |
| Task 7 / 21 | consistent | `ItemBoxView.position` (`task-07.md:522-526`) is a separate, correctly-wired path; Task 21 fills it from `itemBoxWorldPos` (`task-21.md:989-998`) |
| Task 23 | n/a | the golden fixture covers `itemBoxAlpha` (`task-23.md:627-629`), not scene positions |

**Follow-on the amendment does not by itself close:** with `itemBoxes` on `TrackScene`, Task 15's
adapter now *can* draw the pickups. It still does not (`task-15.md:978-1008` adds no item-box mesh),
so applying the amendment to the type without also adding the draw leaves the gameplay defect the
amendment was issued for.

### Amendment 3 — `RaceSession` gains `currentView()` / `prevView()` / `swapViews()`; `createViewBuilder` primes both

**Fully propagated.** Every task that builds or consumes a `RaceView` reflects it.

| Task | Status | Evidence |
|---|---|---|
| **Task 13** (origin) | **APPLIED** | Consumes-an-arrangement block `task-13.md:40-53`; "The precondition: two views, or no cue can ever fire" `task-13.md:78-117`; executable single-vs-double-buffer proof `task-13.md:529-641` |
| **Task 20** (producer) | **APPLIED** | Produces `task-20.md:106-108`; interface docs `task-20.md:571-590`; implementation `task-20.md:617-618`, `:654-656`, `:720-732`; ruling `task-20.md:124-137`; test `task-20.md:347-377` |
| **Task 21** | **APPLIED** | Consumes `task-21.md:27-29`; **priming** `task-21.md:1033-1039` with its rationale at `task-21.md:1022-1032`; Produces note `task-21.md:90-92`; `frameloop.test.ts` `task-21.md:612-682` asserts frame 1 fires zero one-shots |
| **Task 22** | **APPLIED** | Ruling `task-22.md:193-198`; frame order `task-22.md:1009-1020` (`swapViews()` **after** `audio.apply`); priming comment `task-22.md:771-773` |
| Task 11 | consistent | `task-11.md:118-123` records the double buffer and correctly states nothing in `frame.ts` is affected |
| Task 23 | **applied in code, missing from its Interfaces block** | uses `prevView()` `task-23.md:461`, `currentView()` `task-23.md:462`, `swapViews()` `task-23.md:470`; but the `Consumes … from @tapkart/game` block at `task-23.md:17-23` lists only `realFrameClock`, `createSession`, `createSoloTransport`, `createViewBuilder`. Cosmetic — the code is right |
| Task 12 | n/a | `buildHudModel` reads one view; unaffected |

### Amendment 4 — `advanceAccumulator` moves out of `packages/game/src/clock.ts` into `@tapkart/net`

Not yet sent. **Every site that defines, imports or tests it:**

**Definition — Task 16**
| Site | Line(s) | What is there |
|---|---|---|
| `Produces` block | `task-16.md:102-106` | the doc comment + `export function advanceAccumulator(acc: TickAccumulator, nowMs: number): number` |
| implementation | `task-16.md:674-700` | the whole function, inside `packages/game/src/clock.ts` |
| test import | `task-16.md:218-227` | `import { MAX_CATCHUP_TICKS, accumulatorAlpha, advanceAccumulator, createAccumulator, makeFixedClock, realFrameClock, renderNowMs } from '../src/clock'` and `import type { FrameClock, TickAccumulator } from '../src/clock'` |
| tests | `task-16.md:343-459` | `describe('advanceAccumulator')` — 9 tests, all calling it |
| adjacent tests | `task-16.md:461-475`, `task-16.md:506-511` | `accumulatorAlpha` and `MAX_CATCHUP_TICKS` blocks, which call `advanceAccumulator` to set up |
| test-rationale table | `task-16.md:522-525` | three rows describing `advanceAccumulator` bugs |
| commit message | `task-16.md:800-808` | a paragraph about `advanceAccumulator` |
| module header | `task-16.md:41-47`, `task-16.md:83` | "Files" and "Produces — the nine exports §5.1 pins" |

**Import — Task 22**
| Site | Line(s) | What is there |
|---|---|---|
| `Consumes` block | `task-22.md:94-97` | `TickAccumulator`, `createAccumulator`, `advanceAccumulator`, `accumulatorAlpha` listed under `// ./clock (§5.1)` |
| import statement | `task-22.md:600` | `import { accumulatorAlpha, advanceAccumulator, createAccumulator } from './clock'` |
| doc comment | `task-22.md:694` | the frame-order comment naming `advanceAccumulator` |
| construction | `task-22.md:725` | `const acc = createAccumulator(clock.nowMs())` |
| call site | `task-22.md:992` | `const ticks = advanceAccumulator(acc, clock.nowMs())` |

**Contract sites** (for completeness): §5.1 line 1898 (the signature), §5.13 line 2532 (frame order),
§6.1 line 2582, §7.2 line 2753 (sole-writer table), §8.1 line 2812 (the assertion row), §11 line 3092
(`game/clock` = 9).

**No other task names it.** Grep over all 24 files returns Tasks 16 and 22 only.

**One entanglement the edit must decide, stated because it is not optional:**
`advanceAccumulator` is §7.2's **sole writer of `TickAccumulator`**, and `TickAccumulator`,
`createAccumulator`, `accumulatorAlpha` and `MAX_CATCHUP_TICKS` all live in `game/clock.ts`. Moving
the function alone puts a sole-writer rule across a package boundary and forces `@tapkart/net` to
import `TickAccumulator` from `@tapkart/game` — inverting §1's arrow, which is the one thing §1 and
§12 forbid outright. The minimum coherent move is the five accumulator symbols together
(`TickAccumulator`, `createAccumulator`, `advanceAccumulator`, `accumulatorAlpha`,
`MAX_CATCHUP_TICKS`), leaving `FrameClock`, `realFrameClock`, `makeFixedClock` and `renderNowMs` in
`game/clock.ts`. That takes `game/clock` from 9 to 4 in §11's census and `net`'s count up by 5.

Two things the move does **not** break, checked:
- Task 16's repo-wide `TICK_MS` scan (`task-16.md:260-288`) already excludes `packages/net`, and its
  positive assertion (`task-16.md:277-278`, "`clock.ts` still imports `TICK_MS`") stays true because
  `renderNowMs` needs it.
- Task 16's "only wall clock" scan (`task-16.md:290-302`) covers `content`, `render`, `game` only —
  unaffected.

---

## 3. SILENT DISAGREEMENTS

### SD1 — The road theme is applied twice: Task 8 bakes it into vertex colours, Task 15 also sets it on the material

The contract says only that `buildTrackScene` applies the theme (§4.3, line 1256 and the
`buildTrackMesh` doc) and says nothing about the adapter's materials.

- **Task 8** writes `1,1,1` into `road.colors` from `buildTrackMesh` (`task-08.md:927-929`) and then
  `applyRoadTheme` overwrites each vertex with `theme.road` / `theme.roadDirt` / `theme.shoulder` /
  `theme.wall` (`task-08.md:1253-1277`). Its test asserts the vertex colours are exactly the theme's
  (`task-08.md:605-646`).
- **Task 15** then builds the material as
  `new MeshLambertMaterial({ vertexColors: data.colors.length > 0 })` and *also* does
  `setColor(mat.color, color)` with `color = theme.road` (`task-15.md:891-899`, called at
  `task-15.md:981`). In Three.js, `vertexColors: true` **multiplies** `material.color` by the vertex
  colour — so the road ships at `theme.road²` (a 0.18 grey becomes 0.032, near-black).

**Task 8 should win**: it is the pure layer, its choice is asserted by a test, and §0a forbids the
adapter from making colour decisions. Task 15's `addSurface` should pass `color: 0xffffff` (or omit
`mat.color`) whenever `data.colors.length > 0`.

### SD2 — Who colours boost pads and ramps: nobody (Task 8) or the adapter (Task 15)

Same code sites, opposite direction, and the contract is silent on pad/ramp colour in both §4.3 and
§4.10.

- **Task 8**'s `applyRoadTheme` tints the **road pass only**; `buildBoostPadMesh` and `buildRampMesh`
  leave their `colors` arrays at `1,1,1` (`task-08.md:1060-1062`, `task-08.md:1144-1146`) and
  `buildTrackScene` does not touch them (`task-08.md:1306-1316`).
- **Task 15** decides in the adapter that boost pads are `theme.roadDirt` and ramps are
  `theme.shoulder` (`task-15.md:982-983`).

The *result* happens to be correct (all-white vertex colours × a material colour = the material
colour), which is why neither author saw a conflict. But it is a game decision — "a boost pad is
dirt-coloured" — living in a file §0a says contains no decisions and §8.2 says CI never imports.

**Task 8's layer should win**: `buildTrackScene` should write pad and ramp vertex colours the way it
writes the road's, and the adapter should carry no theme field mapping at all. Failing that, the
mapping belongs in the contract so two authors cannot pick two.

### Note — a contract self-contradiction both game authors resolved the same way

Not a disagreement between tasks, recorded because the contract is the artefact that is wrong.
Contract §5.10's `RaceSession` doc comment (lines 2279-2280) says

> `/** The tick the race clock counts from: COUNTDOWN_TICKS for 'solo', 0 for 'host' and 'guest' (§15.2). */`

while the same section's table two paragraphs later (line 2349) says

> `raceStartTick` is `COUNTDOWN_TICKS` in every role, because every role now starts in `'countdown'`.

Task 20 (`task-20.md:523-525`, `task-20.md:606`) and Task 21 (`task-21.md:600`) both independently
took **COUNTDOWN_TICKS in every role**, which is the reading R44/§15.2 justifies. The stale doc
comment should be deleted from the contract.

---

## 4. CLEAN

One line per interface boundary checked and found consistent across consumer, producer and contract.

**Content package**
1. `Tuning` / `CharacterStats` / `SimContext` shapes, contract §2.1 → Task 2 — field-for-field, including the mutable `[number, number, number]` tuples.
2. `TUNING` / `CHARACTERS` values, contract §3a.2 → Task 2's literals → Tasks 14, 22, 23 — all 25 tuning fields and 8×4 stats transcribe correctly.
3. `PaletteRGB`, contract §3a.3 → Task 3 (sole definition) → Tasks 4, 5, 6, 7, 8, 9, 11, 11b, 15 — one type, never redefined.
4. `CharacterDescriptor` / `KartDescriptor` / `parseCharacterDescriptor` / `parseKartDescriptor`, §3a.3 → Task 3 → Tasks 5, 6, 7, 9, 11b, 22, 23 — identical field lists and ranges at every site.
5. `EdgeMarkerParams` / `TrackTheme` / `DEFAULT_TRACK_THEME` / `parseTrackTheme`, §3a.4 → Task 4 → Tasks 5, 6, 7, 8, 11b, 15, 22 — identical at every site.
6. Task 3's `makeCharacterDescriptorJson` / `makeKartDescriptorJson` are correctly named apart from §9.1's `make*DescriptorFixture` (`task-03.md:45`) — no collision.
7. `TrackManifestEntry` / `TRACK_MANIFEST` / `parseTrack` / `LoadedTrack` / `loadTrack`, §3a.5 → Task 5 → Tasks 18, 19, 22, 23.
8. `ContentBundle` / `loadContentBundle`, §3a.6 → Task 5 → Tasks 22, 23.
9. Task 6's 22 generated files ↔ Task 5's 22 static import paths — exact path-for-path match (`content/characters/character-{0..7}.json`, `content/karts/kart-{0..7}.json`, `content/themes/{six ids}.json`), including the `theme-caldera.json` → `caldera.json` rename at `task-06.md:864-872`.
10. Task 5's `parseTrack` delegates every range to sim's `validateTrack` and its expected message `checkpointS[0]: must be within 0..1, got 5` is byte-identical to `packages/sim/src/track.ts:55`.
11. `content` barrel (5 modules, 18 symbols) — Task 5's list matches §3a.7 and §11's census exactly.

**Sim consumption**
12. Every `@tapkart/sim` symbol any task consumes exists in real source: `resetBotHold` (`phase.ts:42`), `spawnEntity` (`entity.ts:45`, 8-arg, returns `number`), `updateEntities` (`entity.ts:228`), `surgeActiveOn` (`entity.ts:299`), `statesEqual` (`state.ts:220`), `computePlacement`, `allocStateLike`, `cloneState`, `driftTierFor`, `itemBoxWorldPos`, `motionLocked`, `validateTrack`, `buildArcTable`, `arcAt`, `BOOST_PAD_HALF_LENGTH`, `DRIFT_STEER_MIN`, `ITEM_BOOST_TICKS`, `CHARGE_TTL_TICKS`, `FINISH_GRACE_TICKS`, `BOUNDS_HALF_WIDTH_MUL`, `SAMPLES_PER_SEGMENT`. (`resetBotHold`, `spawnEntity`, `updateEntities` are absent from contract §2.2's list but are real, test-only consumptions.)
13. `Task 11`'s `ENTITY_SCALE` values ↔ sim's `hitRadiusFor` (`entity.ts:125-138`): seeker 1.6, bolt 1.4, slick 1.2, charge 6.0 — exact.
14. `BUBBLE_ORBIT_RADIUS_M = 2.0` ↔ sim's module-private `BUBBLE_ORBIT_RADIUS = 2.0` (`entity.ts:12`) — exact, and Task 11's re-derivation test is the required §8.1 guard.
15. `makeContext(track, isLeader = true)` ↔ `packages/sim/test/fixtures/track-fixtures.ts:235` — signature matches everywhere it is used (Tasks 7, 8, 20).
16. Every relative reach into `packages/sim/test/fixtures/` counts the right number of `..`: Task 2 (`../../`), Task 7 fixtures (`../../../`), Task 8 test (`../../`), Task 20 fixtures (`../../../`), Task 23 (`../../render/test/fixtures/`).

**render/types → everything**
17. `ViewRole`, §4.2 → Task 7 → Tasks 19, 20, 21, 22 — one union, no second `SessionRole` anywhere.
18. `ViewSource`, §4.2 → Task 7 → Tasks 11, 11b, 21.
19. `KartView` — all 28 fields identical in Task 7 (producer), Task 10, Task 11, Task 11b, Task 12, Task 13, Task 21, Task 22, Task 23 and contract §4.2.
20. `EntityView` (8 fields), `ItemBoxView` (3 fields), `RaceView` (13 fields) — identical at every site.
21. `createRaceView(itemBoxCount)` / `viewSourceViolations(view, role)` — Task 7 → Tasks 11, 11b, 12, 13, 20, 21, 22.
22. `viewSourceViolations`'s message format — Task 7's implementation (`task-07.md:635-685`) reproduces §7.1's three message templates verbatim, including the ordering rule that the source message precedes the entityId message.
23. `KartView.place` 0-based ↔ `HudModel.place` 1-based — Task 7, Task 12 and Task 22 all agree; §13's highest-risk name is intact.
24. Drift-tier encoding `-1 | 0 | 1 | 2` — one encoding, one call site (`driftTierFor` in Task 21 step 8), copied unmodified through `KartView.driftTier` → `KartDraw.driftSparkTier` → `HudModel.driftTier`. No second encoding exists.

**render internals**
25. `MeshData` (5 typed arrays) — identical in Tasks 8, 9, 15, 22.
26. `MeshBuildOptions` / `DEFAULT_MESH_OPTIONS` (8/6/6/0) — Task 8 → Task 22, matching §4.3's stated numbers.
27. `MarkerPlacement` / `EdgeMarkerPlacement` — Task 8 → Task 15.
28. `ROAD_DECAL_LIFT = 0.02` / `meshBounds` / `meshCounts` — Task 8 → Tasks 9, 15.
29. `buildCharacterMesh` / `buildKartMesh` — Task 9 → Task 22.
30. `CameraMode` / `CameraParams` / `DEFAULT_CAMERA_PARAMS` (all nine numbers) / `CameraState` / `createCameraState` / `updateCamera` — Task 10 → Tasks 11, 11b, 15, 22, 23.
31. `KartDraw` (13 fields) / `EntityDraw` (8 fields) / `RenderFrame` (9 fields) / `createRenderFrame` — Task 11 → Tasks 11b, 15, 22, 23.
32. `buildRenderFrame(view, cam, theme, characters, karts, out)` — Task 11b → Tasks 22, 23 and §4.7 — argument-for-argument.
33. All eleven §4.7 frame constants — Task 11 → Task 11b's test, identical names and values.
34. `bubblePosition` / `surgeAffects` — Task 11 → Task 11b, both used exactly as §4.7's table specifies.
35. `CountdownLabel` / `countdownLabelFor(phase, countdownTicksLeft, ticksSinceStart)` — Task 12 → Task 13, identical; the countdown beep firing on a label change means the beep and the on-screen digit cannot disagree.
36. `HudModel` (15 fields) / `HudStanding` / `createHudModel` / `buildHudModel` / `formatRaceClock` / `GO_LABEL_TICKS` — Task 12 → Tasks 22, 23.
37. `AudioCueKind` / `AudioCue` / `AudioModel` / `MAX_AUDIO_CUES` / `createAudioModel` / `buildAudioModel(prev, view, out)` / `AudioConfig` / `AudioBackend` / `nullAudioBackend` — Task 13 → Tasks 21, 22, 23.
38. `VisualOffset` / `createVisualOffset` / `easeRemaining` / `advanceVisualOffset(prev, correctionPos, correctionHeading, ticksElapsed, out)` / the three `ERROR_SMOOTH_*` constants — Task 14 → Task 21, and the `number | null` nullable travels unchanged from `correctionDeltaOf` → `RaceSession.correctionDelta` → `advanceVisualOffset` with no reconstruction at any layer.
39. `RendererStats` / `RendererBackend` (5 methods) — Task 15 → Tasks 22, 23.
40. `ThreeRendererOptions` / `DEFAULT_THREE_OPTIONS` / `createThreeRenderer` — Task 15 → Task 23 via `@tapkart/render/three`.
41. `render` barrel — Task 15's nine-module list matches §4.11 exactly, omits `three/renderer`, and Task 15's directory scan matches the nine `src/*.ts` files Tasks 7-15 actually create.

**game**
42. `FrameClock` / `realFrameClock` / `makeFixedClock` / `renderNowMs` — Task 16 → Tasks 20, 21, 22, 23.
43. All 26 `controls/` symbols — Task 17 → Tasks 18, 22, and §5.5 / §11's per-module counts (9/11/4/1/1/1/2/1).
44. `InputSource` / `attachInputSource(target, viewport)` / `requestTiltPermission()` — Task 18 → Task 22, and `controls/index.ts` provably does not reach `./source` (Task 18's `dom-seam.test.ts`).
45. `Settings` (8 fields) / `DEFAULT_SETTINGS` / `SETTINGS_STORAGE_KEY` / `KeyValueStore` / `memoryStore` / `loadSettings` / `saveSettings` — Task 18 → Tasks 19, 22, 23.
46. `normalizeRoomCode` / `isValidRoomCode` / `ROOM_CODE_*` — Task 18 → Tasks 19, 22.
47. `ScreenId` / `LobbySlot` / `AppState` / `createAppState` / `AppEvent` (all 15 variants, payload-for-payload) / `reduceApp` / `SCREEN_TRANSITIONS` — Task 19 → Task 22.
48. `SessionOptions` / `RaceSession` / `createSession` / `createSoloTransport` — Task 20 → Tasks 21, 22, 23.
49. `RaceSession.correctionDelta(outPos): number | null` ↔ net's `correctionDeltaOf(client, outPos): number | null` — Task 20 delegates and computes nothing, exactly as §5.10 requires.
50. `ViewBuilder` / `createViewBuilder` — Task 21 → Tasks 22, 23.
51. `ViewBuilder.build`'s 13 steps ↔ §5.11 — checked step by step: internal `nowMs`, seat-order fill, alpha-lerp on every state-sourced seat, `characterIdx` from the session, `s` reconstruction (including `checkpointIdx < 0` → `n - 1`), `bankAngle` copied out before the next `sampleAt`, plan-view `speed`, single `driftTierFor` call site, `computePlacement` over view values, entity packing, item boxes, smoothing insertion point, scalars, DEV assertion last.
52. `ResultRow` / `isDnf` / `buildResultRows` — Task 22 → Task 19 (type-only forward reference, already recorded in AUTHOR-DECISIONS).
53. `ShellOptions` (6 fields) / `GameShell` / `startShell` — Task 22 → Task 23, exact.
54. `game` barrel — Task 22's 13-module list matches §5.15 exactly, omits `shell` and `controls/source`, and omits the three sub-adapter factories.
55. §11's exported-symbol census holds: content 18, render 78, game 72 = 168, plus 16 fixture exports — recounted from the tasks' own Produces blocks.

**Fixtures**
56. `packages/render/test/fixtures/render-fixtures.ts` — all 8 §9.1 exports created exactly once, by Task 7. Consumers: `makeRenderContext` (11, 12), `makeKartView` (10), `makeThemeFixture` (8, 11b), `makeCharacterDescriptorFixture` / `makeKartDescriptorFixture` (9, 11b), `loadShippedTrack` / `SHIPPED_TRACK_IDS` (8). `makeRaceView` is defined and unused — §9.1 requires it, so this is correct, not a defect.
57. `packages/game/test/fixtures/game-fixtures.ts` — all 6 §9.1 exports defined exactly once across Tasks 17/18/19/20, no duplicate definition, no name collision. Consumers: `makeControlInputsFixture` (17), `makeSettingsFixture` (18, 19), `makeLobbySlots` (19), `makeGameContext` (20, 21), `makeSessionPair` (20, 21). `makeCorrectingGuest` has no consumer — see B1.
58. `packages/render/test/fixtures/golden-frame.ts` — `serializeDerivedFrame` / `GOLDEN_FRAME_FILE` created once by Task 23 and consumed once by Task 23's game-side test; its covered/not-covered split matches §9.2's table row for row.
59. No fixture is used by any task that does not import it, and no fixture is defined twice.

---

### Cosmetic, recorded but not counted as findings

- `task-20.md:63` and `task-21.md:34` both cite `./clock` as "Task 2"; it is Task 16.
- `task-04.md:678` expects 39 theme tests; `task-05.md:1066` refers to "Task 4's 38 theme tests".
- `task-23.md:649` expects "57 lines for `caldera`"; the arithmetic is 8 karts + 32 entities +
  camera + hud + 16 item boxes = **58**.
- `task-21.md:65-78`'s `@tapkart/sim` Consumes block omits `cloneState`, `createState`,
  `resetBotHold` and `RACE_LAPS`, which its two test files import. All four exist.
