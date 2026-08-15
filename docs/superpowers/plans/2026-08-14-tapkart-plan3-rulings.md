# Plan 3 — Controller Rulings on the Contract Draft's 34 Open Questions

**Status:** binding. The Plan 3 contract is amended to match every ruling below
before any task is authored. Where a ruling contradicts the draft, the ruling wins.

**Why this document exists.** Plan 2's contract took 12 amendments *during* parallel
task authoring, and each amendment cost roughly two blocking defects at audit. The
draft's open-questions section is the cheapest artifact this project has produced:
34 amendments bought for one agent-run. Every one is ruled here, before authoring.

Four of the 34 (Q4, Q5, Q6, Q7) bind **Plan 2**, not Plan 3, and are already recorded
as rulings P2-R8 … P2-R11 in the Plan 2 SDD ledger. They are restated here in brief
so this document is self-contained.

---

## Content that does not exist

### Q1 — Home of `Tuning` and `CharacterStats[]`. RULED: `packages/game/src/content/`.

`TUNING` and `CHARACTERS` live in `packages/game/src/content/tuning.ts`, as TypeScript
literals, exactly as the draft proposed. Not `@tapkart/sim` (Plan 2 §6 is right: a
fixture in the public surface ends up in the shipped bundle), not JSON (these are
consumed only by `game`, and a JSON round-trip buys nothing but a parse failure mode),
not a new `packages/content` (a package that exports two constants is ceremony).

**`TUNING` must be numerically identical to `makeTuning()`, and a test asserts it
field-by-field.** This is not optional. Plan 1 shipped 477 tests and a golden replay
fixture; if the shipped tuning diverges by one number, all 477 describe physics no
player ever experiences, and the golden replay stops being evidence about the game.
The test lives in `packages/game/test/` and imports the fixture by relative path
(permitted — see Q34).

Same rule for `CHARACTERS` against `makeCharacters()`.

*If a tuning value should change, it changes in both places in one commit, and the
golden replay is regenerated.* That friction is the point.

### Q2 — 8 character + 8 kart descriptors. RULED: DeepSeek-delegated, and it is a Plan 3 task.

Spec §10 names this as delegation work and it is a textbook fit: 16 independent records
against a fixed schema, reviewed before use, worth about a dollar. The schema in
contract §4.4 is **locked before the batch runs** — that ordering is the whole reason
this is answerable now.

The delegation task must ship a **gate script built from the real shipped code**, not a
reimplementation of it, the way the track pipeline did: the gate imports the actual
`CharacterStats` validator and the actual descriptor parser via esbuild-bundled entry
points and rejects any record the game itself would reject. A gate that reimplements
validation tests the gate.

Balance is not delegated. DeepSeek writes the descriptors — names, palettes, silhouette
parameters — and the eight `CharacterStats` **stat triples come from `makeCharacters()`**
(Q1), so no model gets to invent game balance.

### Q3 — Per-track theme palettes. RULED: same batch as Q2, same gate.

Six themes, one per shipped track, schema in contract §4.5. Folded into the Q2
delegation task so one instruction covers all 22 records — which is also what keeps the
DeepSeek prompt cache warm across the batch instead of paying the miss rate twice.

---

## Bindings on Plan 2 (restated; authoritative copies are P2-R8 … P2-R11)

### Q4 — Guests cannot see entities. RULED: widen `net`, as a **Plan 2** amendment.

`RemoteKeyframe` gains `entities: WireEntity[]` and `entityCount: number`;
`RemoteInterpolator` gains `sampleEntity(entityId, nowMs)`. Plan 3 never writes into
`net` — that would invert the dependency direction spec §3 fixes.

**`sampleEntity` matches on `entityId`, never on array index.** Entities are packed at
the front and removed by swap-remove, so `entities[i]` in two consecutive keyframes are
frequently different entities. The index-keyed version compiles, passes a one-entity
test, and teleports entities into each other the moment two are live.

Absent from the newest keyframe ⇒ return `null` (it despawned). Present in the newest
but not the older ⇒ extrapolate from the newest alone, under the same 200 ms cap.

### Q5 — Guests' HUD is driven by bot AI. RULED: `RemoteSample` gains `kart: WireKart`.

Not `applySnapshotToState` on the predicted state. Mixing authoritative and predicted
data in one struct is precisely the confusion that breeds this class of bug, and a
reconciliation replay would immediately re-simulate the remote seats back over the
authoritative values it just wrote.

Interpolated `position`/`heading` stay as they are. **Every discrete field — `lap`,
`checkpointIdx`, `t`, `item`, `connected`, `isBot`, `spinOutTicks`, `invulnTicks`,
`boostTicks`, `respawnTicks`, `shielded`, `driftActive`, `driftCharge`, `driftDir`,
`airborne`, `surface` — is read from `sample.kart`**, verbatim off the wire.

This makes contract §7.1's seat-source rule mechanically checkable, which was its
purpose: **the renderer reads the local seat from `state()` and every other seat from
the interpolator, and never both.** It also resolves placement with no new wire field,
because `WireKart` already carries `lap`, `checkpointIdx` and `t` — everything
`placementOrder` consumes — for all eight seats.

### Q6 — `TICK_MS`. RULED: `@tapkart/net` exports it. Plan 3 imports it and never redefines it.

### Q7 — Interpolator timebase. RULED: CONFIRMED as the draft read it.

`ClientLoop` stamps keyframes with `tick * TICK_MS`, so the interpolator's clock is
**sim time**. Callers pass `renderNowMs(tick, alpha)`. A wall-clock `nowMs` pins every
remote kart at the 200 ms extrapolation cap forever, silently. Plan 2 Task 15b adds the
assertion at the layer that owns the stamp; Plan 3 §6.3 restates the rule for callers.

---

## Timebase and loop

### Q8 — `ClientLoop.tick()` cadence. RULED: `game` calls it once per 60 Hz sim tick.

`ClientLoop` owns the 30 Hz send cadence and the `INPUT_REDUNDANCY = 8` window
internally — that is exactly the design `AuthorityLoop` was built to mirror, and it
keeps the network cadence out of the shell. Contract §5.1's accumulator and §6.1 stand
as drafted.

### Q9 — Local-kart interpolation between ticks. RULED: yes, interpolate. It is the cheap half of a 60 Hz game feeling right.

`game` retains the previous `SimState` and lerps the local kart's position and heading
by `alpha`. The cost is one extra `SimState` per session — allocated **once, at session
construction**, never per frame — and `cloneState` already exists.

Snapping the local kart to tick positions is the one artifact the player is guaranteed
to see, on the one object they are steering, on every frame of a 120 Hz display. The
remote karts already get smoothing; giving the local kart less is backwards.

**Constraint:** the lerp is render-only. It writes into a scratch view struct, never
back into either `SimState`.

---

## Architecture and packaging

### Q10 — Three.js. RULED: mandated, pinned at `three@0.180.0`, no Canvas2D fallback.

Spec §3 says "Three.js scene" and the spec is the binding authority; the brief's
"Canvas/WebGL" is a looser restatement, not a competing decision.

The `RendererBackend` seam stays — but its justification is **headless testability**
(contract §8.2), not device fallback. WebGL-or-nothing is correct for v1: every device
that can run this game has WebGL, and a second renderer is a second thing to keep
correct for no user.

### Q11 — `apps/web`. RULED: YES, Plan 3 creates it — but only the thin shell.

The draft flagged this as its likeliest-wrong assumption, and it was. A plan that ships
two libraries and an exported `startShell` nobody calls has not produced working,
testable software, which is the bar the plan structure exists to meet. Plan 3 must end
with something a human can open in a browser and play.

**In Plan 3:** `apps/web` with `index.html`, a Vite config, an entry module that calls
`startShell`, and a dev server that runs.

**Not in Plan 3, deferred to Plan 5:** PWA manifest, service worker, offline caching,
Dockerfile, CI publish. Those are deploy concerns and they travel with the deploy plan.

### Q12 — Runtime location of `content/tracks/*.json`. RULED: Vite `import.meta.glob`, eagerly bundled. `loadTrack` is synchronous.

The tracks are six small files that ship with the app and never change at runtime.
Fetching them buys a loading state, a failure path, and a race, in exchange for nothing.
Bundling them makes `loadTrack(id): TrackData` a total function, which deletes an entire
error branch from every screen that touches a track.

Contract §5.3's injected `FetchJson` seam is **removed**. The `node:fs` reach from tests
(Q34) is unaffected — tests keep reading the real files from disk, which is what makes
them evidence about shipped content.

### Q13 — Does `game` need `@tapkart/protocol` directly? RULED: yes. Add it to `package.json` now.

The draft's "no" is correct for *today's* Plan 3 surface but wrong the moment Q5's
ruling lands: `RemoteSample.kart` is a `WireKart`, which is a `protocol` type, and every
HUD and standings function in `game` will name it. Declaring a dependency you provably
need is not speculation.

---

## Screens and flow

### Q14 — The screen list. RULED: spec §3's five screens are canonical, with two clarifications.

`ScreenId = 'title' | 'characterSelect' | 'lobby' | 'race' | 'results'`.

- **Character select is its own screen.** Spec §3 lists it; the brief's six-item flow
  simply omitted it. It is also the natural home for the Q2 descriptors.
- **Countdown is not a screen.** `sim` already models it as `phase === 'countdown'`,
  and giving it a screen would create two sources of truth for the same fact — the
  exact defect class this project keeps paying for. The race screen renders the
  countdown overlay when `state.phase === 'countdown'`.
- **`join/host` is not a screen either.** It is the title screen's two buttons. A
  screen with two buttons and no state of its own is a control, not a screen.

### Q15 — Solo play. RULED: solo always uses a `LoopbackTransport`. `SessionOptions.transport` is never `null`.

Exactly one code path exists, and solo — the mode that will be run thousands of times
during development — exercises the same `AuthorityLoop` the host runs. A `null`
transport creates a second path that is simpler in the moment and untested forever;
this project has already paid for one of those (the module-scope bot hold that made
`step` non-instanceable, invisible until two rooms shared a process).

`LoopbackTransport` with zero peers, zero latency, zero loss costs one object.

### Q16 — Results content. RULED: positions only for v1. `game` does not record times.

Client-recorded times are non-authoritative and differ per peer, which means the results
screen would show eight players eight different sets of numbers for the same race. That
is worse than showing no numbers.

*Noted as the natural v1.1 item:* a `finishTick` per kart on the wire makes real,
agreeing times a small change. It is out of scope here because it is a spec change, and
the spec is the authority.

### Q17 — DNF display. RULED: yes, mark DNF, and derive it in `game`, not `sim`.

A kart is DNF **iff** the race ended by grace-timer expiry *and* that kart's lap
progress is short of `RACE_LAPS`. Both facts are already available to `game`:
`state.phase === 'finished'`, `state.finishTick`, `state.tick`, and each kart's
`lap`/`checkpointIdx`. No `sim` change, no wire change.

Showing a timed-out player "4th" with no qualifier is a lie the results screen tells,
and it is one line to stop telling it.

### Q18 — Lap display. RULED: CONFIRMED. `clamp(lap + 1, 1, RACE_LAPS)`, shown as "LAP n/3".

"LAP 0/3" on the grid is wrong in every racing game ever shipped.

---

## Track rendering

### Q19 — `track.bounds`. RULED: render extent. The draft's reading is right, and `track.ts:170-177` proves it.

`validateTrack` asserts only that `bounds` encloses the control points; containment for
gameplay is `width × BOUNDS_HALF_WIDTH_MUL` in `recovery.ts`. So `bounds` constrains
nothing the simulation does — it is a declared world extent, and that is precisely what
a ground plane, a camera far clamp and a skybox need. Contract §4.3's `meshBounds`
assertion stands.

### Q20 — Scenery. RULED: v1 ships a ribbon over a themed ground plane, plus **procedural edge markers**.

No props, no buildings, no crowd — none of it is in the track data and inventing a
second content schema to hold it is a plan of its own.

But a bare ribbon on a flat plane gives the player no speed cue and no corner read,
which is a **gameplay** problem, not a decoration one. So the theme (Q3) additionally
carries edge-marker parameters — post spacing, height, and the two alternating colours —
and `render` generates markers procedurally along both track edges from the existing
spline. That is derived entirely from data that already exists, costs one loop in
`mesh.ts`, and is the single highest-value visual per unit of risk.

The three scenery-named tracks stay scenery-free in v1. The names describe their palette.

---

## Controls

### Q21 — `accel` during motion lock. RULED: adapters keep reporting the player's real input; the HUD reads `motionLocked`, not `accel`.

`sim` ignores input under motion lock, so the adapter has no reason to lie about what
the player is doing — and an adapter that zeroes `accel` on a state it has to
re-derive is an adapter that will get the derivation wrong.

**Separately, and more importantly: `thumbZones` gets a brake.** The draft's table is
right that it currently has none, and the consequence it identified is real — a
`thumbZones` player who noses into a wall cannot reverse and must wait out the 1.2 s
out-of-bounds respawn, if the wall even counts as out of bounds. That is not an
acceptable v1 control scheme. **Brake is a long-press on the drift button** (drift is
already a hold, so a distinct threshold is needed anyway) — no new screen real estate,
no new affordance to teach.

### Q22 — iOS motion permission. RULED: requested from the settings toggle, on the tap that selects `tilt`. On denial, the selection reverts and the settings screen says why.

That tap is an unambiguous user gesture, which is what iOS requires, and it is the only
moment the player has expressed intent to use tilt.

**Silent fallback is forbidden.** A player who selects tilt, is denied by the OS, and
gets thumb-zones with no explanation concludes the game is broken. The revert plus one
line of text costs nothing and is the difference between a bug report and an informed
player.

### Q23 — Keyboard. RULED: a `CompositeAdapter` merges keyboard with the selected touch scheme. Not a fourth exclusive scheme.

Spec §6 says keyboard is *always* available on desktop, and "always" is not "instead of".
The draft was right to notice this collides with the sole-writer rule for `Intent`, and
right to flag it rather than quietly pick one.

The merge rule is stated here so no task invents its own:

- `steer` — the input of **greater absolute magnitude** wins; ties go to keyboard.
- `accel` — **maximum**.
- `brake`, `drift`, `useItem` — **logical OR**.

The sole-writer rule is preserved by construction: sub-adapters write into their own
scratch `Intent`s and only `CompositeAdapter` writes the one `game` submits.

### Q24 — `thumbZones` layout. RULED: steering is **relative to touch-down origin**; drift bottom-right, item above it.

Relative-to-origin is the mobile-racer convention, it is thumb-position-independent
across hand sizes and device widths, and — decisively — absolute steering means the
kart jerks to full lock the instant a thumb lands anywhere but the exact screen centre.

Full lock at 28 % of the half-width from origin. Drift button 88 pt, bottom-right,
16 pt from both edges. Item button 88 pt, directly above it, 16 pt gap. A touch landing
in the gap belongs to **neither** — dead space between buttons is correct; nearest-button
snapping fires the wrong one and the player cannot tell why.

### Q25 — `useItem`. RULED: adapters emit a **one-tick pulse** on press.

The draft correctly identified that a held button is harmless *today* only because
`useItem` guards on `item !== 'none'` — and then correctly identified the consequence:
a player holding the button auto-fires the next item the instant it is granted, which
they did not ask for and cannot prevent.

Edge semantics live in the adapter, where the press already is. `sim` is unchanged.

---

## Audio and scope

### Q26 — Procedural audio. RULED: **out of Plan 3**, deferred to Plan 5. The seam stays.

Plan 3 is already the largest plan in the project and audio is the one part with no
gameplay consequence. Contract §4.9's `AudioModel`/`AudioBackend` seam is **kept and
authored** — a pure model with a no-op backend — so Plan 5 adds a Web Audio
implementation and touches nothing else. Building the seam is hours; retrofitting one
is a refactor.

When it lands: **local kart engine voice only**, plus one-shots for items, impacts and
lap crossings. Eight oscillators for eight engines is a mobile battery problem and a
mix nobody can hear through.

### Q27 — `surge`. RULED: not drawn as a world object. Screen tint only.

It is a field-wide timed slow with no meaningful location; `spawnEntity` gives it a
position because every entity has one, not because it means anything. Drawing a mesh at
a meaningless position is worse than drawing nothing, because players will try to dodge
it.

### Q28 — `bubble`. RULED: `sim` already orbits it (`entity.ts:197-209`). `render` adds **no** cosmetic motion.

Confirmed against the shipped code: `updateEntities` advances `e.heading` by
`BUBBLE_ORBIT_RATE * TICK_DT` every tick and rewrites `e.position` to the owner's
position plus `BUBBLE_ORBIT_RADIUS` at that heading. The drawn bubble and the collision
bubble are the same object, and any orbit `render` layers on top would separate them.

**A consequence the draft could not have seen, and which is a real defect if unhandled:**
the bubble orbits fast, so at the 20 Hz snapshot rate a remote bubble's positions are
far apart on its circle. Interpolating those positions **linearly chords across the
orbit** — the bubble visibly collapses toward its owner and springs back, 20 times a
second.

So for `kind === 'bubble'` specifically, `render` reconstructs the position as
`ownerInterpolatedPosition + BUBBLE_ORBIT_RADIUS` at the interpolated **heading**
(angle-lerped, shortest arc), rather than lerping the sampled position. This is not
cosmetic motion invented by `render` — it is the same formula `sim` uses, applied to
interpolated inputs, and it reproduces the authoritative position exactly at every
keyframe.

### Q29 — Item box respawn. RULED: **ghosted**, so `itemBoxVisible: boolean[]` becomes `itemBoxAlpha: Float32Array`.

A box that vanishes gives the player no information; a ghosted box that fades back in
tells them exactly when it is worth driving over. `alpha = 1 - respawnTicks /
ITEM_BOX_RESPAWN_TICKS`, clamped. One number instead of one boolean.

---

## Testing

### Q30 — vitest environment. RULED: `node` everywhere. No jsdom, and no per-file `@vitest-environment` override.

Contract §8.2's seam exists to make this true, and it is the load-bearing decision
behind the whole "rendering is testable headlessly" claim. **If any task believes it
needs jsdom, that is a signal the seam is in the wrong place** — the fix is to move the
boundary, not to change the environment. A per-file override slipped in by one task
silently converts a global guarantee into a per-file accident.

### Q31 — Mesh-vs-`groundHeight` tolerance. RULED: **1 mm** (`1e-3` world units), stated once in the contract.

The two paths differ only in float ordering, so the real disagreement is many orders of
magnitude smaller than this; 1 mm is loose enough never to flake and far tighter than
any error a genuine mesh bug would produce. Naming it in the contract is the point —
two tasks picking two tolerances is how a suite ends up with a 1 cm assertion nobody
can justify.

### Q32 — `viewSourceViolations` in dev builds. RULED: yes. Vite's `import.meta.env.DEV` is the flag.

Q11's ruling gives Plan 3 a bundler, which removes the draft's only objection. The
seat-source rule (Q5) is exactly the kind of invariant that a test proves for the cases
it thought of and a dev-build assertion proves for the cases nobody thought of. It costs
one branch that the production build strips.

### Q33 — Golden `RenderFrame` fixture. RULED: yes, but **only over the derived-geometry subset**, and it lands in the plan's **final** task.

The draft named both sides correctly: strongest available regression net, but it freezes
constants that Plan 3 exists to tune by eye. Both are true, so split the frame.

The golden fixture covers what is **derived from simulation state** — kart transforms,
entity transforms, camera pose, HUD numeric values, item-box alphas. It does **not**
cover palettes, marker spacing, bloom, tint strengths, or any other visual tuning
constant.

Placing it in the last task means it freezes the constants *after* they are tuned,
which is the only ordering in which it is a net rather than a nuisance.

### Q34 — Where the six shipped tracks are exercised. RULED: permitted, and **required**.

`packages/render/test/` reads `content/tracks/*.json` from disk with `node:fs`, the same
test-only cross-boundary reach Plan 2 §6 already permits for fixtures. `src` still never
does this — Q12's ruling means `src` reaches the tracks through `import.meta.glob`.

**Required**, not merely allowed: mesh-testing only `makeOvalTrack` would mean the six
tracks players actually drive are never checked against the mesh generator at all. The
track pipeline's own gates found a 1.3 m self-overlap in `glacier-pass` precisely
because they ran against real content instead of a synthetic fixture.

---

## Summary of contract amendments required

| # | Section | Change |
|---|---------|--------|
| Q1 | §5.2 | `TUNING`/`CHARACTERS` in `game/src/content/`; equality test vs. fixtures **mandatory** |
| Q2, Q3 | §4.4, §4.5 | Descriptors + themes are a DeepSeek task with a real-code gate; stats come from `makeCharacters()` |
| Q4 | §2.4, §7.1 | `RemoteKeyframe.entities`, `sampleEntity` keyed by `entityId` (Plan 2) |
| Q5 | §2.4, §7.1 | `RemoteSample.kart: WireKart`; seat-source rule becomes checkable (Plan 2) |
| Q6 | §4.1 | Import `TICK_MS` from `net`; delete the redefinition |
| Q9 | §5.10, §4.7 | Local kart lerps by `alpha`; second `SimState` allocated once |
| Q10 | §4.10, §10 | `three@0.180.0` pinned; no Canvas2D backend |
| Q11 | §12 | `apps/web` **is** in Plan 3 (shell + Vite only; PWA/Docker → Plan 5) |
| Q12 | §5.3 | `import.meta.glob`, `loadTrack` synchronous, `FetchJson` seam deleted |
| Q13 | §10 | `game` depends on `@tapkart/protocol` |
| Q14 | §5.9 | Five screens; countdown and join/host are not screens |
| Q15 | §5.10 | `transport` never `null`; solo uses `LoopbackTransport` |
| Q17 | §4.8 | DNF derived in `game` from phase + finishTick + lap |
| Q20 | §4.3, §4.5 | Procedural edge markers from theme parameters |
| Q21 | §5.5 | `thumbZones` gains brake on drift long-press |
| Q23 | §5.5 | `CompositeAdapter` with the stated merge rule |
| Q24 | §5.5 | Relative steering, 28 % full-lock, 88 pt buttons, dead gap |
| Q25 | §5.5 | `useItem` is a one-tick pulse |
| Q26 | §4.9 | Audio seam authored, backend is a no-op, Web Audio → Plan 5 |
| Q28 | §4.7 | Bubble position reconstructed from owner + interpolated heading |
| Q29 | §4.7 | `itemBoxVisible: boolean[]` → `itemBoxAlpha: Float32Array` |
| Q31 | §8.1 | Mesh tolerance `1e-3` |
| Q32 | §8.1 | `viewSourceViolations` runs under `import.meta.env.DEV` |
| Q33 | §9 | Golden frame over derived geometry only, authored in the final task |
| Q34 | §9 | Real-track mesh tests are required |
