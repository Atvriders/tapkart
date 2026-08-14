# Plan 2 Audit A — Tasks 1–9

Auditor scope: `docs/superpowers/plans/parts/plan2-task-01-*.md` through
`plan2-task-09-*.md`, checked against `docs/superpowers/plans/2026-08-14-tapkart-plan2-contract.md`
(current, amended) and `docs/superpowers/specs/2026-08-13-tapkart-design.md` §3/§4/§5/§8.
`packages/protocol` does not exist yet in this checkout; `packages/sim` is Plan-1-shipped
and unmodified. All file/line references below are to the checkout as it stands today
unless marked otherwise.

---

## Blocking defects

### BD-1. Task 5's `Q`/`EPS` do not have the contract's shape at all

**Task:** 5 (`docs/superpowers/plans/parts/plan2-task-05-quant.md`)
**Location:** lines 81–93 (`Interfaces > Produces`), lines 300–385 (the actual `Q`/`EPS`
object literals), lines 192–289 (the tests that pin this shape).

The current contract (§3, lines 205–217) locks:

```ts
export interface QuantField { min: number; max: number; bits: number }
export interface QuantTable {
  position: QuantField; velocity: QuantField; heading: QuantField
  angularVelocity: QuantField; driftCharge: QuantField; t: QuantField
}
export interface EpsilonTable {
  position: number; velocity: number; heading: number
  angularVelocity: number; driftCharge: number; t: number
}
```
six fixed keys, key `t` (not `lap.t`, not `lapT`), and per §4 (lines 362–369): "Only the
six continuous rows above appear in `Q` and `EPS`. The eleven 'exact' rows carry no
quantisation noise and therefore need no epsilon."

Task 5 instead defines:

```ts
export type QuantFieldName =
  | 'position' | 'velocity' | 'heading' | 'angularVelocity' | 'driftCharge' | 'lapT'
  | 'spinOutTicks' | 'invulnTicks' | 'boostTicks' | 'respawnTicks'
  | 'lap' | 'checkpointIdx' | 'item' | 'surface' | 'driftPacked'
  | 'airborne' | 'shielded' | 'connected' | 'playerId'

export type QuantTable = Readonly<Record<QuantFieldName, QuantField>>
export type EpsilonTable = Readonly<Record<QuantFieldName, number>>
```

19 keys, an open `Record` instead of the locked closed interface, and the continuous
field named `lapT` rather than `t`. It also puts all eleven exact/enum fields into `Q`
and `EPS` (with `EPS[field] = 0` for each), which is exactly what §4 says not to do —
each entry's own docstring even predicts the drift: "giving them one would invite
someone to compare an integer with a tolerance."

The six numeric continuous values themselves (`EPS.position = 0.05`, `.velocity = 0.05`,
`.heading = 0.0025`, `.angularVelocity = 0.05`, `.driftCharge = 1.5`, `.lapT`/`t` `= 0.002`,
and the matching `min`/`max`/`bits` triples) are correct and match the current contract's
§4 table exactly — only the **shape and scope** of the exported types are wrong. This
narrows the fix (rename `lapT`→`t`, change `Record<QuantFieldName,…>` to the six-key
interface, delete the thirteen exact-field entries and move their bit widths to
whichever file needs them as local literals) but it does not make the current brief
executable as written: the code in Steps 3–8 must be substantially rewritten, and every
test in the file that references `Q.spinOutTicks`, `Q.playerId`, etc., must be deleted or
relocated.

### BD-2. Task 5's own text re-derives and re-commits the exact mistake contract amendment 9 overturned

**Task:** 5, lines 32–46 (decision 1) and lines 355–357 (the `connected` entry and its
docstring at lines 318–321).

Task 5 sums the per-kart table to **177 bits** by treating `isBot`/`connected` as a single
shared wire bit named `connected`, deriving `isBot` on decode as `!connected`. Its own
comment (lines 33–35) states: "Contract §4's row `` `airborne`, `shielded`,
`isBot`/`connected` | — | 1 each `` packs three named things into one prose row... Reading
`isBot`/`connected` as *two* separate 1-bit fields sums to 178, one over. So `isBot` and
`connected` share a single wire bit."

The **current** contract explicitly rejects this, in its own words (§4, lines 334–341):

> *`isBot` and `connected` get a bit each, deliberately.* An earlier draft implied they
> shared one, which only works if `isBot === !connected` always holds. It happens to hold
> in shipped Plan 1 code, but it is an *emergent* property... not an invariant anything
> enforces — and spec §5 has a dropped client's kart "taken over by a bot" and then
> "reclaim[ed] on reconnect", which is exactly the transition where the two could
> legitimately disagree for a tick. One extra bit per kart is 8 bits per snapshot; an
> implicit invariant that a future task can silently break is not worth that.

And explicitly: "Per-kart total: **178 bits**." (line 332). Task 5's brief is the literal
"earlier draft" the contract is describing and overruling — it was written before
amendment 9 landed and was never updated. This is not merely stale prose; it is a shipped
test assertion (`expect(total).toBe(177)`, quant.test.ts, line 236 of the brief) that
locks in the wrong wire format.

### BD-3. Task 6 inherits BD-1/BD-2 and hard-codes the 177-bit, shared-bit format into the snapshot codec

**Task:** 6 (`docs/superpowers/plans/parts/plan2-task-06-snapshot.md`)
**Location:** lines 98–112 (decision 3, "isBot/connected share one wire bit"), lines
694–706 and 762–778 (`encodeSnapshot`/`decodeSnapshot`'s use of `Q.spinOutTicks.bits`,
`Q.boostTicks.bits`, `Q.lap.bits`, `Q.checkpointIdx.bits`, `Q.item.bits`, `Q.surface.bits`,
`Q.driftPacked.bits`, `Q.airborne.bits`, `Q.shielded.bits`, `Q.connected.bits`,
`Q.playerId.bits`, and the single `k.connected`-only write with `k.isBot = !connected` on
decode), line 525 (`const totalBits = 200 + MAX_KARTS * 177 + 3 * 135`), lines 556–592
(the independent reference re-implementation in the "writes header then karts in exactly
contract §4 row order" test, which also sums to 177 bits per kart and never writes a
separate `isBot` bit).

Two independent problems, both blocking:

1. **Compile-time cascade.** Once Task 5 is fixed to match the contract's six-key
   `QuantTable` (BD-1), every one of the eleven `Q.<exactField>.bits` reads in Task 6
   above stops compiling (`Property '<x>' does not exist on type 'QuantTable'`). Task 6
   as written is only internally consistent with Task 5's *wrong* shape — it cannot be
   executed against a contract-conformant `quant.ts` without rewriting these eleven
   lookups as local bit-width constants (which is exactly the pattern Task 6 already uses
   correctly for the entity/header fields, e.g. `ENTITY_ID_BITS = 16`).
2. **Wire-format correctness.** Even taken in isolation (ignoring Task 5), Task 6 encodes
   only `connected` and derives `isBot` on decode/apply as its negation. This is the
   precise scenario the contract names as unsafe (a dropped client's kart taken over by a
   bot, then reclaimed — `isBot` and `connected` legitimately disagreeing for a tick) and
   is a direct, load-bearing violation of the current contract's §4, not just a stale
   citation. `applySnapshotToState` (Task 6, lines 993–1026) writes `k.isBot = s.isBot`
   from the decoded `WireKart.isBot`, but `decodeSnapshot` only ever set
   `k.isBot = !connected` in the first place — so the wire round-trip can never carry a
   state where the two disagree, no matter how far downstream you look.

### BD-4. Task 7's own contingency plan would silently launder BD-1/BD-2 rather than catch them

**Task:** 7 (`docs/superpowers/plans/parts/plan2-task-07-roundtrip-bounds.md`), lines
106–110.

Task 7 (correctly, see "Anchors"/"Premises" below — it matches the current contract) pins
the six-key, `t`-keyed `QuantTable`/`EpsilonTable` shape and writes its `CONTINUOUS_FIELDS`
list accordingly. But its own Step 2 instructions say: if `Q`/`EPS` from `quant.ts` throw a
`TypeError` because the shape differs, "edit only `CONTINUOUS_FIELDS` and the two interface
aliases at the top of this test file to match `quant.ts`'s real exports. Do not touch any
numeric assertion to make an import error go away."

Followed literally against Task 5 as currently written, this instruction tells whoever
executes Task 7 to rename `t` to `lapT` in its own test file to match Task 5's wrong key
name — silently absorbing BD-1 instead of flagging it as the contract violation it is. The
"do not touch any numeric assertion" clause protects the epsilon *values* but not the
*shape*, and the shape is exactly what is wrong. Recommend: once BD-1 is fixed in Task 5,
this contingency clause in Task 7 becomes moot (the shapes will agree), but as a
standing instruction it is a latent hazard — it should read "if the shape differs, treat
that as a Task 5 defect and stop" rather than "match `quant.ts`'s real exports."

---

## Contract drift

| # | Task | Location | Superseded text cited | Current contract text it must move to |
|---|---|---|---|---|
| 1 | 5 | lines 81–93, 323–330 | `QuantFieldName` (19-value union), `QuantTable = Readonly<Record<QuantFieldName, QuantField>>`, `EpsilonTable` likewise | Contract §3 (lines 206–217): closed interface, six keys `position, velocity, heading, angularVelocity, driftCharge, t` |
| 2 | 5 | lines 33–46 | "isBot and connected share a single wire bit... sums to 177" | Contract §4 (lines 332–341): "Per-kart total: 178 bits... isBot and connected get a bit each, deliberately" |
| 3 | 5 | line 84 (`'lapT'` in the union), line 344 (`lapT: qf(0, 1, 10)`) | key `lapT` | Contract §3/§4 (line 369): "The key is `t`, not `lap.t`, matching the flat `WireKart` interface" |
| 4 | 5 | lines 216–230, 260–269 (test) | `Q.spinOutTicks`, `Q.lap`, `Q.item`, etc. asserted to exist on `Q`/`EPS` | Contract §4 (lines 362–364): "Only the six continuous rows above appear in `Q` and `EPS`" — exact fields have no `Q`/`EPS` entry at all |
| 5 | 6 | lines 98–112 (decision 3) | "isBot/connected share one wire bit, named connected" | Contract §4 (lines 334–341), same as row 2 |
| 6 | 6 | lines 694–706, 762–778 | `Q.spinOutTicks.bits` … `Q.playerId.bits` (eleven lookups) | These fields have no `Q` entry once Task 5 is fixed (row 4); must become local bit-width constants, matching the pattern Task 6 already uses for `ENTITY_ID_BITS` etc. |
| 7 | 6 | line 525, lines 576–592 | per-kart total 177 bits, no separate `isBot` bit in the reference re-implementation | Contract §4 line 332: "Per-kart total: 178 bits" — the reference re-implementation (and `encodeSnapshot`/`decodeSnapshot`) must add a fourth exact bit for `isBot` alongside `connected` |

No other contract-drift instances were found in Tasks 1–4, 8, or 9 — see "Premises
verified" below for the specific claims checked in each.

---

## Anchors verified

Every "Before" block quoted in Tasks 1 and 2 was diffed character-for-character against
the file in this checkout (`packages/sim/src/*.ts`, `packages/sim/test/*.ts`). All
verified verbatim.

| Task | File | Anchor | Exists verbatim |
|---|---|---|---|
| 1 | `src/types.ts` | `SimState`'s closing `itemBoxes`/`finishedOrder` fields (Step 3) | Yes |
| 1 | `src/state.ts` | type-only import block (Step 3) | Yes |
| 1 | `src/state.ts` | `createState`'s `finishedOrder` build + `return {...}` (Step 3) | Yes |
| 1 | `src/state.ts` | `cloneState`'s length guard + doc comment (Step 7) | Yes |
| 1 | `src/state.ts` | `cloneState`'s `finishedOrder` copy loop (Step 7) | Yes |
| 1 | `src/state.ts` | `statesEqual`'s length guard (Step 7) | Yes |
| 1 | `src/state.ts` | `statesEqual`'s `finishedOrder` loop + `return true` (Step 7) | Yes |
| 1 | `src/phase.ts` | module-scope `holdIntent`/`holdTick`/`resetBotHold` block + `freeze` (Step 11) | Yes |
| 1 | `src/phase.ts` | full `resolveInputs` body (Step 11) | Yes |
| 1 | `src/replay.ts` | `import { makeIntentBuffer, resetBotHold } from './phase'` (Step 13) | Yes |
| 1 | `src/replay.ts` | `recordRun`'s `resetBotHold()` call + comment (Step 13) | Yes |
| 1 | `src/replay.ts` | `replayRun`'s `resetBotHold()` call + comment (Step 13) | Yes |
| 1 | `src/replay.ts` | file-header "CHECKPOINT PARITY INVARIANT" comment (Step 16) | Yes |
| 1 | `src/replay.ts` | `needsOddCheckpoint` function + its doc comment (Step 16) | Yes |
| 1 | `src/replay.ts` | `replayRun`'s `RangeError` parity guard (Step 16) | Yes |
| 1 | `test/recovery.test.ts` | hand-built `SimState` literal tail (Step 18) | Yes (line 135) |
| 1 | `test/collision.test.ts` | hand-built `SimState` literal tail (Step 18) | Yes (line 73) |
| 1 | `test/entity.test.ts` | hand-built `SimState` literal tail (Step 18) | Yes (line 118) |
| 1 | `test/laps.test.ts` | hand-built `SimState` literal tail (Step 18) | Yes (line 120) |
| 1 | `test/placement.test.ts` | hand-built `SimState` literal tail (Step 18) | Yes (line 68) |
| 1 | `test/barrel.test.ts` | `resetBotHold` import/inventory/count/call site | Yes (lines 74, 206, 214/219, 295) |
| 1 | `test/phase.test.ts` | `resetBotHold` import + 5 call sites | Yes (lines 8, 61, 154, 186, 226, 472) |
| 1 | `test/replay.test.ts` | `resetBotHold` import + 3 call sites (all inside the one deleted test) | Yes (lines 15, 409, 428, 433) |
| 2 | `src/laps.ts` | `updateLaps`'s `lapCross`/`finish` emit block (Step 4) | Yes (lines 116–128) |
| 2 | `src/recovery.ts` | `beginRespawn`'s `emit('respawn', ...)` call (Step 9) | Yes (line 162) |
| 2 | `src/recovery.ts` | `startSpinOut`'s full signature + body (Step 12) | Yes (lines 51–67) |
| 2 | `src/entity.ts` | `spawnEntity`'s full signature + body (Step 17) | Yes (lines 45–78) |
| 2 | `src/entity.ts` | `despawnEntityAt`'s signature + emit line (Step 17) | Yes (lines 93–98) |
| 2 | `src/entity.ts` | `updateEntities`'s two `'hit'` emits + `despawnEntityAt` calls (Step 17) | Yes (lines 254–268, 279–290) |
| 2 | `src/items.ts` | all six `spawnEntity(state, <kind>, ...)` calls (Step 17) | Yes (lines 243, 253, 263, 273, 284, 294) |
| 2 | `test/laps.test.ts` | `stubContext()` signature + return (Step 1) | Yes |
| 2 | `test/recovery.test.ts` | `makeCtx()` signature + return (Step 6) | Yes |
| 2 | `test/entity.test.ts` | `stubContext()` signature + return (Step 19) | Yes |

No mismatched anchor was found anywhere in Tasks 1 or 2.

---

## Premises verified

| Task | Claim | File checked | True/False |
|---|---|---|---|
| 1 | Adding `heldBotIntent`/`heldBotTick` to `SimState` alone produces exactly six `TS2739` errors at `state.ts(111,3)`, `collision.test.ts(60,3)`, `entity.test.ts(106,3)`, `laps.test.ts(108,3)`, `placement.test.ts(56,3)`, `recovery.test.ts(122,3)` | Reproduced the probe directly: patched `types.ts`, ran `npx tsc --noEmit -p packages/sim`, reverted | **True** — exact match, file/line/column and error text all confirmed |
| 2 | Exactly 11 `emit(` call sites in `packages/sim/src`, at the named files/lines, 3 already gated | `recovery.ts`, `laps.ts`, `entity.ts`, `items.ts`, `phase.ts` | **True** — all 11 confirmed at the cited lines; 3 already gated (`items.ts:136`, `phase.ts:219,226`) |
| 2 | `entity.test.ts` has 41 `spawnEntity(state,`, 1 `spawnEntity(prev,`, 6 `despawnEntityAt(state,` calls (48 total) | `grep -c` against `packages/sim/test/entity.test.ts` | **True** — 41 + 1 + 6 = 48, exact |
| 2 | `items.test.ts` needs no call-site edits for the `spawnEntity`/`startSpinOut` signature changes | `packages/sim/test/items.test.ts` | **True** — zero references to `spawnEntity`/`despawnEntityAt`/`startSpinOut` in that file |
| 3 | `packages/sim/package.json`, `tsconfig.json`, root `package.json`, `tsconfig.base.json`, `vitest.config.ts`, and `src/index.ts` have the exact shapes quoted | All six files, read directly | **True** — every quoted field/line matches |
| 3 | `node_modules/@tapkart/` currently contains only `sim` | `ls -la node_modules/@tapkart/` | **True** |
| 6 | `drift.ts`: every branch setting `d.active = false` also sets `d.dir = 0` in the same branch; `d.dir` is set nonzero only where `d.active = true` is also set | `packages/sim/src/drift.ts` | **True** — three branches (steeringLocked, release-with-no-drift, speed-fell-below-min) all pair `active=false`/`dir=0`; the one latch branch pairs `active=true`/`dir=±1` |
| 6 | Entity record is 135 bits (not the spec's stale "13 B"), per `WireEntity.velocity: Vec3` | Contract §4 (line 344), spec §5 (lines 402–415) | **True** — both already state 135 bits; Task 6 correctly implements this |
| 8 | `grep -rn "heldBotIntent" packages/sim/src/` returns zero matches (Task 1 has not landed) | `packages/sim/src/` | **True** |
| 9 | `phase.ts:226` emits `('finish', -1, -1, 'none', finishers)`; `entity.ts:76` emits `('entitySpawn', ownerId, entityId, kind, ttl)` | `packages/sim/src/phase.ts`, `packages/sim/src/entity.ts` | **True** — exact line and text match |
| 9 | `EntityKind`'s six values are a strict subset of `ItemKind`'s nine | `packages/sim/src/types.ts` | **True** |
| 5/6 | "Reading isBot/connected as two separate 1-bit fields sums to 178, one over" / per-kart total is 177 bits | Contract §4, line 332 (current, amended) | **False against the current contract** — the current contract fixes the total at 178 and requires the two separate bits (see BD-2) |

---

## Placeholders

None found in Tasks 1–9. No "TBD", no "add appropriate error handling", no "similar to
Task N" hand-waving, no step describing an action without showing the code, and no
reference to an undefined type or function, other than the Task-5/6 shape drift already
covered under Blocking defects (which is a wrong-but-fully-specified shape, not a
placeholder).

---

## Non-blocking observations

- **Task 1, Step 13, `packages/sim/test/phase.test.ts` edit count is mislabeled.** The
  brief's header says "five edits" but then enumerates "Edit 1" through "Edit 6" (one
  import + five call-site removals). The content of all six is correct and complete
  (verified against the file: 1 import + 5 `resetBotHold()` calls, matching exactly), so
  this is a labeling slip only, not a missing edit.
- **Task 6, lines 36–37: `clearSlot`'s cited line range ("lines 20-38") is slightly off.**
  In the current file, `clearSlot`'s doc comment starts at line 22 and the function body
  at line 27; lines 20–21 are the tail of the preceding module-scope scratch arrays. The
  *content* described (the exact dead-slot field values) is accurate; only the line
  numbers are approximate.
- **Task 7 is well-aligned with the current contract** and is the one brief in this
  territory that explicitly anticipates a `Q`/`EPS` shape mismatch (see BD-4) — its
  numeric assertions (epsilon-exceeds-step, round-trip-within-step, exact-field widths)
  are all correct against the current contract and require no changes once Task 5 is
  fixed.
- **Task 9's `AuthEvent` wire layout already reflects contract amendment 2** (`playerId`/
  `entityId` biased +1) correctly and completely — this task shows no drift.
- **Task 8's checkpoint codec already reflects contract §1a** (`heldBotIntent`/
  `heldBotTick` carried, with an explicit test naming the cross-room bot-hold bug) — no
  drift found.

---

## Outside my territory

- **`WIRE_TAG`/`encodeHeader`/`decodeHeader` integration point is not addressed by any
  task in 1–9, and may not be addressed anywhere.** Contract §3 (lines 182–188) adds a
  2-byte tag+version header via `encodeHeader`/`decodeHeader` in `types.ts` (Task 3), but
  `encodeSnapshot`/`encodeCheckpoint`/`encodeEvents` (Tasks 6/8/9, all in my territory)
  each start their own `BitWriter`/raw `DataView` at byte offset 0 of the buffer they're
  given, with no parameter for a header offset. Whichever task actually assembles a
  datagram for the wire (Tasks 11+) needs to either (a) write the 2-byte header into a
  buffer and then hand a `subarray(2)` view to `encodeSnapshot` et al., or (b) some other
  scheme — but I did not find this addressed in Tasks 1–9, and it isn't this territory's
  job to fix. Please check whether Tasks 11–18 specify this composition explicitly.
- **Contract §5's amendment 7** (`ClientLoop.state()`/`AuthorityLoop.state()` accessors,
  `AuthorityLoop.tick()` taking no input parameter and reading its own `Transport`
  instead) applies to Tasks 14–16, which I did not read. Worth confirming those briefs
  reflect it rather than an earlier draft, given how pervasive this pattern of stale
  citation is in Tasks 5–6.
- **Contract §6** (`makeNetContext`/`makeLossyPair` test fixtures, and the
  non-importability of `packages/sim/test/fixtures/*` across the package boundary)
  affects Tasks 10+ generally; Tasks 1–9 that touch this (6, 8) already handle it
  correctly (see Non-blocking observations), but it's worth the other auditors
  double-checking Tasks 11–18 build `SimContext`/`SimState` fixtures the sanctioned way.
