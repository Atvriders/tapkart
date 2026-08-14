# Plan 2 Fix A — Tasks 1–6

Fixes applied to `docs/superpowers/plans/parts/plan2-task-01-*.md` through
`plan2-task-06-*.md` in response to findings in `PLAN2-AUDIT-A.md`, `-B.md` and
`-C.md` that name a task in this range. The contract
(`docs/superpowers/plans/2026-08-14-tapkart-plan2-contract.md`) was treated as
authoritative throughout; where a brief disagreed with it, the brief was changed.

---

## Task 5 (`quant.ts`) — full rewrite of `Q`/`EPS`'s shape

**Audits:** A's BD-1, BD-2; C's Blocking #1, #2; C's Interface-pairs rows 3, 4, 8;
C's Contract-drift table rows 1–4.

**Finding:** `Q`/`EPS` were an open `Record<QuantFieldName, QuantField>` with 19
keys — six continuous fields plus thirteen exact/enum fields, the continuous lap
field named `lapT` — and summed to 177 bits/kart by treating `isBot`/`connected`
as one shared wire bit. Contract §3 locks a closed six-key interface
(`position, velocity, heading, angularVelocity, driftCharge, t`); contract §4
fixes the per-kart total at 178 bits with `isBot` and `connected` each getting
their own bit, explicitly rejecting the shared-bit scheme as unable to represent
spec §5's bot-takeover/reconnect transition.

**What changed:** Rewrote `quant.ts`'s `QuantField`/`QuantTable`/`EpsilonTable`
interfaces and the `Q`/`EPS` object literals to the exact six-key shape from
contract §3, keyed `t`. Deleted all thirteen exact-field entries from `Q`/`EPS`
(they now have no epsilon concept, per contract §4: "giving them one would invite
someone to compare an integer with a tolerance") — their bit widths move to Task 6
as local literal constants, mirroring the pattern Task 6 already used for the
entity/header fields. Rewrote the "Two decisions" section: decision 1 (six keys,
not twenty rows; `t` not `lapT`; `isBot`/`connected` never merged) and decision 2
(the prose Step column is illustrative — `quantStep` is the source of truth,
reworded to cite the contract's own now-current text instead of arguing against a
superseded draft). Rewrote every test in `quant.test.ts`'s `Q`/`EPS` blocks to the
six-key shape; deleted the exact-field assertions and the `sums to 177 bits` test,
replacing it with a `sums to 124 bits` test scoped to what `Q` actually contains,
with a comment explaining the full 178-bit total is Task 6's to assert (since Task
6 owns the other 54 bits as local constants).

**Derivation (124 bits, the six continuous fields):**
`position` 3×16 = 48, `velocity` 3×12 = 36, `heading` 12, `angularVelocity` 10,
`driftCharge` 8, `t` 10 → 48+36+12+10+8+10 = **124**.

**Also fixed:** the contract's own prose ("An earlier draft of this table divided
by `1 << bits`...") describes a dispute that the *current* contract has already
resolved in its own Step column (0.0312805 / 0.0009775, matching `quantStep`'s
output) — the original Task 5 brief was arguing against the *superseded* draft's
numbers as if they were still current. Reworded to cite the settled contract text.

---

## Task 6 (`snapshot.ts`) — full rewrite to consume the fixed `Q`/`EPS` and carry `isBot` as its own bit

**Audits:** A's BD-3; C's Blocking #1, #13; C's Interface-pairs rows 1, 2 (NO), 8,
43, 46b; C's "Tests that cannot fail" #8.

**Finding 1 (wire format):** `encodeSnapshot`/`decodeSnapshot` read/wrote eleven
`Q.<exactField>.bits` lookups that no longer exist once Task 5 is fixed, and wrote
only a single `connected` bit, deriving `isBot = !connected` on decode — the exact
scenario contract §4 names as unsafe.

**What changed:** Replaced every `Q.<exactField>.bits` read with a local bit-width
constant (`SPIN_OUT_TICKS_BITS` … `PLAYER_ID_BITS`, 14 total, plus the 8 that
already existed for entity/header fields — 22 in total, corrected from the
brief's own stale "four" count). `Q.lapT` → `Q.t` throughout. `encodeSnapshot` now
writes `k.isBot` and `k.connected` as two independent bits, in contract §4's row
order (`isBot` before `connected`); `decodeSnapshot` reads both back independently
— neither is ever derived from the other. `applySnapshotToState` was already
copying `WireKart.isBot` field-for-field, so no change was needed there beyond the
docstring. Rewrote the module's "Two decisions" section: settled facts 1 and 2 (no
per-record byte alignment; entity `velocity` is a full `Vec3`) now cite the
contract's own current, already-resolved text instead of re-arguing a dispute the
contract has already settled; decision 3 (`isBot`/`connected` share one bit) was
replaced with the corrected rule (two independent bits, quoting contract §4's
"deliberately" passage directly).

**Derivation (178 bits/kart):** six continuous fields (124, per Task 5 above) +
fourteen exact fields — `spinOutTicks`(8) + `invulnTicks`(8) + `boostTicks`(7) +
`respawnTicks`(7) + `lap`(3) + `checkpointIdx`(6) + `item`(4) + `surface`(2) +
`driftActive`+`driftDir`(2) + `airborne`(1) + `shielded`(1) + `isBot`(1) +
`connected`(1) + `playerId`(3) = 54 → 124 + 54 = **178**. (Contract §4's own prose
calls these "the eleven exact rows"; the table itself lists fourteen. I did not
alter the contract file — out of my territory — but my brief's text and tests use
the recomputed fourteen, not the contract's imprecise "eleven".)

**`writes header then karts in exactly contract §4 row order` reference test:**
this test independently reconstructs the wire format with raw `BitWriter` calls,
deliberately not importing the implementation's own constants. It was missing the
`isBot` bit entirely and used `Q.lapT`; both fixed (inserted
`rw.writeBits(kk.isBot ? 1 : 0, 1)` between `shielded` and `connected`, matching
contract row order; `Q.lapT` → `Q.t`). The byte-count test's `totalBits` formula
changed `MAX_KARTS * 177` → `MAX_KARTS * 178`.

**Finding 2 (Blocking #13, buffer size):** `BUF_SIZE = 512` in the test file is
smaller than the worst-case snapshot, and `BitWriter.writeBits` overflows a
`Uint8Array` silently (no throw) — a snapshot at `MAX_ENTITIES` would truncate
without any test catching it.

**Derivation (743 B worst case):** header 200 bits + 8 karts × 178 bits (1424) +
32 entities × 135 bits (4320) = 200 + 1424 + 4320 = 5944 bits = 5944/8 = **743
bytes exactly** — matches spec §5's recomputed "~743 B" figure. Raised
`BUF_SIZE` to 1024 (safe margin, matches Task 14's own `SNAPSHOT_BUF_BYTES`) and
added a new test, `'round-trips at the worst case: MAX_ENTITIES live entities, all
karts populated'`, asserting `bytes === 743` and spot-checking the last entity
slot decodes correctly — this is the test that would have caught a truncation.

**Finding 3 (C's "Tests that cannot fail" #8):** eight assertions in this task's
test file passed regardless of whether the code under test worked, because the
value asserted coincided with a test fixture's default:
- `d1.connected === false` / `d1.isBot === true` (main round-trip test) — matched
  `makeWireKart`'s defaults exactly, so the decode half of the (now-deleted)
  `isBot = !connected` derivation was never exercised either way. **Fixed:**
  changed kart 1's fixture to `connected: true, isBot: true` — a combination the
  old shared-bit scheme could never produce, and which differs from both the
  default pair and kart 0's pair, so it can only pass if both bits are read
  independently off the wire.
- `d0.playerId === 0` — tautological (kart 0's `playerId` is 0 by construction,
  same as the decode target's default). **Fixed:** added `d1.playerId === 1` in
  the same test, which is neither.
- `snap.entityCount === 0` in the main round-trip test — coincided with both the
  encode input and the decode target's default. **Fixed:** deleted (redundant
  with the dedicated entity test, which does use a real nonzero value).
- `d.t === 0` in the endpoint test — coincided with `makeWireKart`'s default.
  **Fixed:** changed to test `t`'s other endpoint (`k.lap.t = 1`,
  `expect(d.t).toBe(1)`), matching how the same test already exercises both
  endpoints of `position`/`velocity` via their vector components.
- the dead-slot tail loop (`entityId === -1` for slots `[2, MAX_ENTITIES)`) —
  `makeWireEntity()` already defaults to `entityId: -1`, so a decoder that never
  touched those slots would still pass. **Fixed:** dirtied `snap.entities[5]`
  before the decode call so the loop proves re-sentinelling actually happened.
- `dk.respawnTicks === 0` in `applySnapshotToState`'s first test — matched both
  source and destination defaults. **Fixed:** changed the source value to 15.
- `dst.entityCount === 0` in the `'writes tick and entityCount'` test — matched
  both source and destination defaults. **Fixed:** source set to 4, destination
  pre-seeded to 1 before the call, so the assertion proves a real transfer.
- the `'does not touch any field the wire does not carry'` test — a purely
  negative test with no positive companion; a complete no-op `applySnapshotToState`
  would pass it. **Fixed:** added `source.tick = 999` /
  `expect(dst.tick).toBe(999)` as the positive companion in the same test.

**Barrel widening (Blocking #5, shared with Tasks 4 and 5):** added a Step 10–13
block appending `export * from './snapshot'` to `packages/protocol/src/index.ts`,
with a real RED/GREEN pair proving `encodeSnapshot`/`decodeSnapshot`/
`applySnapshotToState` become reachable via `@tapkart/protocol`.

---

## Task 3 (`protocol-scaffold.md`) — `WIRE_TAG`, `encodeHeader`, `decodeHeader` never produced

**Audits:** C's Blocking #3 (also A's "Outside my territory" note, which flagged
this gap without being able to fix it since it fell outside Audit A's own
territory).

**Finding:** Task 3's Produces list and every implementation step omitted
`WIRE_TAG`, `encodeHeader`, `decodeHeader` even though contract §3 assigns all
three to `types.ts`. This is the root cause of the header-format three-way split
between Tasks 14/15/16 in the other agent's territory.

**What changed:** Added a new TDD cycle (Steps 11–14, with the pre-existing
barrel steps renumbered 15–20) that:
- Writes 5 real tests: `WIRE_TAG` has the contract's exact 11 hex values and no
  duplicates; `encodeHeader` writes `[tag, PROTOCOL_VERSION]` and returns 2;
  `decodeHeader` round-trips every `MessageKind`; `decodeHeader` throws on an
  unrecognised tag byte; `decodeHeader` throws on a `PROTOCOL_VERSION` mismatch.
- Implements `WIRE_TAG` (exact hex values from contract §3), a private
  `TAG_TO_KIND` reverse map, `encodeHeader`, and `decodeHeader` with both throws.
- States the RED for each of the 5 new tests precisely, verified empirically
  against this repo (see Verification below) rather than assumed: these are
  runtime values (unlike the type-only interfaces elsewhere in this file), so
  their RED comes from vitest, not `tsc` — a missing named value export binds to
  `undefined` at the call site once the module already exists, producing
  `AssertionError: expected undefined to deeply equal {...}` for the `WIRE_TAG`
  object comparison and `TypeError: ... is not a function` for the two function
  calls (with the two `toThrow()`-wrapped tests failing on a message mismatch,
  not a missing throw).
- Renumbered the pre-existing barrel steps (11→15 … 16→20) and fixed the barrel
  test's insertion anchor, which had been left pointing at the wrong (now
  earlier) block.

---

## Barrel widening (Task 4) — `bits.ts` never appended to the protocol barrel

**Audit:** C's Blocking #5 (names Tasks 4, 5, 6, 8, 9, 10; 8/9/10 are outside my
territory).

**Finding:** Task 3's barrel (`export * from './types'`) is never widened before
Task 18, so Tasks 14/15 (other territory) import codec functions from
`@tapkart/protocol` that the barrel does not yet carry.

**What changed:** Added Steps 10–14 to Task 4, appending `export * from './bits'`
to `packages/protocol/src/index.ts` as the task's last implementation step, with a
real RED/GREEN test pair (`BitWriter`/`BitReader` reachable via a dynamic
`import('@tapkart/protocol')`) — mirroring exactly what Plan 1's Tasks 3–10 did
for `@tapkart/sim`'s own barrel. Tasks 5 and 6 chain the same pattern (see above),
each appending one more line and asserting reachability of their own exports.

---

## Task 1 — three step-level defects (Audit C's empirical finding)

**Audit:** C's Blocking #18, #19; A's Non-blocking observation (Step 13 label).

**Finding 1 (Blocking #18):** Step 4's note and Step 17's "Expected" both claimed
`npx vitest run packages/sim` stays green mid-task because the five hand-built-
`SimState` test files "never exercise `cloneState`/`statesEqual`/`resolveInputs`
on their hand-built states." This is true at Step 4 (before `cloneState` reads the
new fields) but **false by Step 17** (after Step 7 widens `cloneState`'s guard):
`entity.test.ts`'s `'runs updateEntities once per tick, after the kart loop'` and
`laps.test.ts`'s `'runs updateLaps for every kart as the last per-kart stage'`
both call `step()` → `cloneState()` on this file's own `blankState()` literal,
which has no `heldBotIntent` until Step 18. Audit C reproduced this on a scratch
copy: 2 failed / 474 passed.

**What changed:** Step 17's "Expected" now states the real outcome — FAIL, 2
failed / 474 passed / 1 skipped (477 total), naming both failing tests, the exact
`cloneState`-guard line that throws, and why the other three hand-built-literal
files stay green. Step 4's note was narrowed to state it is true "at this exact
point in the task" rather than as a blanket claim about the five files, and points
forward to Step 17's note.

**Finding 2 (Blocking #19):** Step 19's "Expected: no output, exit code 0" for
`tsc` is false as written: deleting the parity-guard tests (Step 14) orphans the
`COUNTDOWN_TICKS` import (used only by the deleted countdown-parity test) and the
`makeIntentBuffer`/`resolveInputs` import from `../src/phase` (used only by the
deleted dirty-hold test) in `replay.test.ts`, producing `TS6133`/`TS6192` under
`noUnusedLocals`.

**What changed:** Added the two import fixes to Step 14 itself (the step that
causes both imports to go dead), immediately after the test-body deletion:
`COUNTDOWN_TICKS` dropped from the `types` import, and the `phase` import line
deleted entirely. Step 19's expected test count was also corrected (see below).

**Derivation (476 passed, 1 skipped, 477 total):** baseline 477 passed / 1 skipped
(478 total, per contract's "Plan 1... 477 tests" and Audit C's own measurement).
Task 1 nets: +1 (`'initialises heldBotIntent...'`) +1 (`'proves two SimStates
never share a bot hold...'`) −2 (3 parity-guard tests replaced by 1) −1 (dirty-hold
test deleted) = −1 test overall. 478 − 1 = 477 total; the 1 skipped test is
untouched by this task, so 476 passed. Matches Audit C's own scratch-copy
measurement ("Task 1 alone → 477 total").

**Finding 3 (cosmetic, Audit A):** Step 13's header said "five edits" for
`phase.test.ts` while enumerating six (Edit 1–6). **Fixed:** "five edits" → "six
edits".

---

## Task 2 — `startSpinOut` parameter order (Blocking #17) and `stubContext()` coverage gap (Blocking #20)

**Audit:** C's Blocking #17, #20; A's Non-blocking observation (Produces hedge).

**Finding 1 (Blocking #17), and a correction to this finding itself:** Contract
§2a's text at the time read `startSpinOut(ctx: SimContext, k: KartState,
ticks: number, state: SimState, events: AuthEvent[]): void`, and Task 2 shipped
`(ctx, state, k, ticks, events)` — `ctx` correctly prepended, but `state`/`k`
in the old, un-reordered positions relative to that text. My first pass at this
finding reordered the brief to match the contract's literal text (13 call sites
changed to `(ctx, k, ticks, state, events)`), on the stated rule that the brief
changes where it disagrees with the contract.

**That reorder was wrong, and the error was in the contract, not the brief.**
The plan's coordinator identified that contract §2a's parameter order was itself
a transcription slip — §1b's whole stated justification for touching
`startSpinOut` at all is "it needs `ctx` to gate its emit", which argues only for
prepending `ctx`, not for moving `state` from first to fourth. The corrected
contract now reads `startSpinOut(ctx: SimContext, state: SimState, k: KartState,
ticks: number, events: AuthEvent[]): void` — `ctx` prepended, nothing else moved —
which is exactly what Task 2 shipped in the first place.

**What changed:** Reverted the reorder in full: `startSpinOut`'s definition, its
one `src` caller (`entity.ts:261`), and every test call site are back to
`(ctx, state, k, ticks, events)`. The "Produces" bullet now reads "`ctx`
prepended, nothing else moved. Matches contract §2a exactly" — no more
"deviation" language, since there is no deviation once the contract itself is
read correctly. Confirmed against `git diff` that the file is now byte-identical
to the pre-reorder version except for that one bullet's wording.

**Call-site count, confirmed against disk per the coordinator's request:**
exactly **one** call site in `packages/sim/src` — `entity.ts:261` — plus the
definition in `recovery.ts:51`, verified directly with
`grep -rn "startSpinOut(" packages/sim/src/`. My earlier "13 call sites" total
was imprecise; the correct count is **11 call expressions**: the 1 `src` caller,
8 pre-existing call expressions in `packages/sim/test/recovery.test.ts` (grouped
into 6 "call sites" in the brief's own numbering — one of the six,
`'never shortens a spin-out already in progress'`, makes 3 calls in one test —
verified with `grep -c "startSpinOut(" packages/sim/test/recovery.test.ts` = 8),
and 2 new call expressions in Step 14's new follower test. All 11 are listed in
Task 2's brief: Step 12 updates the `src` caller and all six numbered test call
sites (all 9 pre-existing expressions) in one pass, so there is no intermediate
state where a signature change and a stale call site coexist; Step 14 then adds
the follower test fresh, already in the correct 5-argument shape. No unlisted
call site exists.

**Finding 2 (Blocking #20):** Step 19's own audit of `entity.test.ts` claimed to
have "grepped `stubContext()` against every line range that calls
`spawnEntity`/`despawnEntityAt`" and found seven blocks lacking one. It missed
two: `'takes the shield down when a bubble is despawned directly'` and `'does not
touch shields when a non-bubble entity despawns'`, both inside
`describe('updateEntities collision', ...)`, both calling `spawnEntity`/
`despawnEntityAt` directly. Left unfixed, `tsc` reports `TS2304: Cannot find name
'ctx'` four times after Step 19's mechanical `sed` pass.

**What changed:** Added Edit 8 and Edit 9 (giving both blocks
`const ctx = stubContext()`), updated the "seven"/"nine" counts in Step 19's own
audit paragraph and its closing verification paragraph, and retitled the step
("nine call sites", not seven).

**Finding 3 (cosmetic, Audit C non-blocking #20):** the Produces bullet hedged
that `startSpinOut`/`beginRespawn` get "an equivalent single-line guard" instead
of stating they get the identical `if (ctx.isLeader) emit(...)` form the other six
sites use. Fixed in the same edit as Finding 1's Produces-bullet correction.

---

## Verification performed

- Reread contract §3 and §4 in full against the rewritten Tasks 3, 5 and 6;
  every signature, constant and bit width in this territory now matches the
  contract's literal text (six-key `Q`/`EPS`; 178 bits/kart derived and shown
  above; `WIRE_TAG`'s eleven hex values; `encodeHeader`/`decodeHeader` signatures).
- Every new/changed RED prediction was checked empirically against this repo's
  actual Vitest behavior, not assumed: probed a named-value-import-with-no-
  matching-export against an existing module (`packages/sim/src/state.ts`) to
  confirm `TypeError: (0 , x) is not a function` for a bare call,
  `TypeError: Cannot read properties of undefined (reading 'x')` for a property
  read, `AssertionError: expected undefined to deeply equal {...}` /
  `expected undefined to be N` for `toEqual`/`toBe` against an `undefined`
  binding, and `AssertionError: expected 'undefined' to be 'function'` for the
  barrel tests' `typeof pkg.X).toBe('function')` pattern. All scratch probe files
  were removed after use; `git status` confirms no stray files remain.
- Re-checked every numeric claim in this report by recomputing from contract §4's
  table rather than copying any prior draft's number (124, 54, 178, 135, 200, 743
  all shown with their derivations above).
- Confirmed the six briefs' Step numbering is sequential with no gaps or
  duplicates after editing (1–20, 1–34, 1–20, 1–14, 1–14, 1–14 for Tasks 1–6
  respectively).

## Left open / could not fix

- ~~Contract §4's own prose says "the eleven 'exact' rows carry no quantisation
  noise"; the table itself lists fourteen.~~ **Resolved by the coordinator**,
  outside this territory: contract §4 now states the rule ("not one of the six
  continuous rows") instead of a tally that drifted when `isBot`/`connected`
  were split into separate bits. No action needed on my side; my briefs already
  used the recomputed count (fourteen) rather than the stale "eleven," so
  Tasks 5/6's own text needed no further change once the contract caught up.
- **Task 5/Task 4 barrel-append ordering.** Task 5's brief states Tasks 4 and 5
  "may be done in either order" for their codec logic, which remains true — but
  my barrel-widening Step 12 in each task shows a specific "Before" state of
  `packages/protocol/src/index.ts` that assumes strict Task-3→4→5→6 execution
  order (matching how the rest of this 18-task plan is written throughout). Added
  a note in Task 5 rather than a structural fix, since the append itself is
  order-independent and only the diff text shown would need adjusting if executed
  out of order.
- **Task 2's Step 11 is a no-op step** ("no command to run here") — Audit C
  non-blocking #18 suggests deleting it. Left in place: deleting it would require
  renumbering every subsequent step (12 through 34) and every cross-reference to
  them throughout the file, for a purely cosmetic gain, and increases the risk of
  introducing a real numbering error into an otherwise now-correct 34-step file.
- Everything else audits A and C named against Tasks 1–6 is addressed above.
  Findings against Tasks 7–18 (barrel-import convention in Tasks 11/12/16/17,
  `AuthorityLoop`/`ClientLoop.state()`, the promotion/convergence test defects,
  etc.) are outside this territory and were left untouched, per instructions.
