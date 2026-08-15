# Plan 3 — decisions the task authors had to make, and cross-task issues for assembly

Seven authors wrote 23 tasks in parallel against the locked contract. Each ran its own code
before shipping. This file records what they decided where the contract was silent, and the
cross-task conflicts the anchor-verification round must resolve.

## Cross-task issues the assembler MUST resolve

1. **Execution order is NOT numeric in the content group: 3 -> 4 -> 6 -> 5.** Task 5's
   `bundle.ts` statically imports the 22 descriptor/theme files Task 6 generates, and
   `tracks.ts` imports `bundle.ts` for theme resolution. Both files state the dependency and
   the exact failure if run early.
2. **`packages/game/test/fixtures/game-fixtures.ts` is shared by four tasks.** Task 17 CREATES
   it (`makeControlInputsFixture`); Tasks 18, 19 and 20 APPEND (`makeSettingsFixture`,
   `makeLobbySlots`, `makeGameContext`, `makeSessionPair`, `makeCorrectingGuest`). Any task
   that says "Create" for this file after Task 17 will delete its siblings' fixtures.
   `makeGameContext` had NO owner until Task 20's author noticed and claimed it.
3. **Task 19 has a type-only forward reference to `src/results.ts`**, which Task 22 creates.
   Vitest is green either way (`import type` is erased) but `tsc -p packages/game` reports one
   TS2307 until Task 22 lands. FIX AT ASSEMBLY: split `results.ts` out of Task 22 into its own
   task placed before 19. The task file forbids stubbing it, correctly.
4. **Barrel ownership.** Task 16 creates `packages/game/src/index.ts` (clock only); Task 22
   modifies it. Task 14 explicitly does not touch `render/src/index.ts`; Task 15 writes the
   complete nine-module barrel, replacing any partial one. Task 15's barrel RED has two
   possible exact failures depending on order, and states both.
5. **Task 1 halts on a CLOSED Plan 2 gate.** Confirmed closed as of authoring: no
   `localinput.ts`, no `TICK_MS`, no `correctionDeltaOf`, no `sampleEntity`/`liveEntityIds`,
   no `WireSnapshot.phase`. That is what the step is for. Tasks 15b/15c must land and merge
   first.

## Contract gaps found and ruled during authoring

- **Item boxes were undrawable.** `RenderFrame` carries `itemBoxAlpha` but nothing carried box
  POSITIONS, so the adapter could not place them. RULED: `TrackScene` gains `itemBoxes: Vec3[]`
  from `itemBoxWorldPos`, index-paired with `itemBoxAlpha`. Static track furniture, so it
  belongs to the scene, not the per-frame struct.
- **`three@0.180.0` ships no types** — no `types` field, no `types` export condition, no `.d.ts`
  in `build/`. `@types/three@0.180.0` is a real devDependency of `packages/render`, with a
  manifest test asserting it and the caret-free `three` pin.
- **`CHARACTERS` does not compose into a `SimContext`.** `readonly CharacterStats[]` is not
  assignable to `CharacterStats[]`; every composition root writes `CHARACTERS.slice()`.
  (`TUNING: Readonly<Tuning>` DOES assign — arrays are the case that bites.)
- **A runtime ESM cycle in controls.** `config.ts` cannot value-import `tilt.ts`, because
  `tilt.ts` imports config's button rects, so entering `tilt.ts` first throws a TDZ
  ReferenceError. Broken with a type-only edge plus a duplicated literal, kept honest by a
  mandatory equality assertion. The one place a task deviated from the contract's literal
  wording.
- **`§2.6`'s fixture path is one level too deep** for `packages/content/test/` —
  `'../../sim/test/fixtures/track-fixtures'`, not `'../../../'`. Count directories, don't copy.

## Test-vacuity traps found empirically (this project's signature defect, now at 20 flavours)

- **`it.each` spreads array rows.** `it.each([null, undefined, 42, [], true])` delivers the `[]`
  case as ZERO arguments and silently re-tests `undefined`. Confirmed by watching an
  array-rejection bug PASS under it. Use `[label, value]` rows. Propagated to every live author.
- **A wrap assertion needs a synthetic prior.** With a 0.15 rad snap guard, a missing
  `wrapAngle` is unobservable — every near-PI case trips the guard either way. Task 14 uses
  `currentHeading = 6.2`.
- **`60 * TICK_MS` is 1000.0000000000001**, so 100 frames at 10 ms yields **59** ticks, not 60.
  The test that actually catches the reset-the-residual bug is the time-conservation identity
  (`total*TICK_MS + residual === elapsed`), not the tick count.
- **A colour-legibility gate must compare in a sqrt space.** Linear light crushes dark palettes
  together, so a linear threshold calls any two asphalt greys identical. The gate caught a real
  "wet black asphalt over near-black ground" palette this way.

## Notable design decisions (contract silent)

- `ENTITY_SCALE` set to `sim`'s own strike radii (seeker 1.6, bolt 1.4, slick 1.2, charge 6.0)
  so the drawn object IS the collision volume; bubble 0.6; surge 0 (never drawn, Q27).
- `createRenderFrame`'s "every field zeroed" is deliberately broken twice: `driftSparkTier` and
  `EntityDraw.entityId` start at `-1`, because `0` is a real tier and a real entity id.
- The **alphabetical roster**: slot i gets letter i, so §3a.6's id-ascending bundle order and
  the per-index stats order agree BY CONSTRUCTION and the violation is gate-checkable. Without
  it a slot silently gets another slot's handling and no type notices.
- `sunDirection` chosen from a 10-row table of exact unit vectors rather than computed — a 1e-6
  unit-length demand is an arithmetic task a cheap model fails and a selection task it does not.
- `createSession` THROWS rather than degrading on a plain `Transport` for host/solo, a bad
  `localPlayerId`, or `ctx.isLeader` disagreeing with the role. Each fails silently and
  permanently otherwise — a bot-driven host being the one Q15 warns about.
- `createViewBuilder` primes BOTH RaceViews before returning (build, swap, build), because
  `createSession` cannot build a view — the dependency runs the other way. Makes P3-R49's
  invariant structural rather than a shell responsibility.
- Entity slot-reuse guard in `ViewBuilder`: lerp only when `prev.entities[j].entityId ===
  state.entities[j].entityId`, since slots are packed and reused by swap-remove. Tested at
  900 m of separation.
- `SCREEN_TRANSITIONS`' contents are the author's (the contract fixed the type only).
  `connectFailed` legal on all five screens, because a mid-race disconnect otherwise strands
  the player.
