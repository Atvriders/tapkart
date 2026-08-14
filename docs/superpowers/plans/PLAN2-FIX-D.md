# Plan 2 Fix D — the five residual findings

Scope: the five items left open across `PLAN2-FIX-A.md`, `-B.md` and `-C.md` after the
contract was amended to resolve transports (Plan 4) and the client's dual-send
(`Transport.broadcast`). Read against `PLAN2-AUDIT-A/-B/-C.md` for original wording,
against `2026-08-14-tapkart-plan2-contract.md` as authority, and against
`docs/superpowers/specs/2026-08-13-tapkart-design.md` for intent. Touched:
`plan2-task-06-snapshot.md`, `plan2-task-12-loopback.md`, `plan2-task-15-client.md`,
`plan2-task-16-shadow.md`, `plan2-task-18-barrels.md`. No other file was modified; no
scratch files were created.

---

## 1. `lastProcessedInputTick`'s `-1` sentinel — `plan2-task-06-snapshot.md`

**Was:** `encodeSnapshot` wrote each entry with a bare `writeBits(v, 16)`. `-1` ("no
real input received yet from this player") encodes as the raw bit pattern `0xFFFF`
and decodes back as `65535` — a real, if implausible, tick number. The sentinel
silently became a false claim ("the newest real input for this player was tick
65535") rather than staying "nothing received yet."

**Changed:** `encodeSnapshot` now writes `lastProcessedInputTick[i] + 1`;
`decodeSnapshot` reads it back and subtracts `1` — the identical `+1`-bias scheme
contract §4a already uses for `AuthEvent.playerId`/`entityId`. The reference test
that independently reconstructs the wire format with raw `BitWriter` calls (`'writes
header then karts in exactly contract §4 row order...'`) was updated to bias the
same way, so it stays a faithful independent spec rather than silently drifting from
the implementation. Added prose to the module's wire-order section explaining the
bias and its one-tick cost (`65534` instead of `65535` at the top of the range,
matching the cost Task 9 already accepted for its own fields).

**New test** — `'round-trips the -1 "no real input yet" sentinel in
lastProcessedInputTick, biased so it never collides with a real tick'`: encodes
`[-1, 0, 1, -1, 65534, -1, -1, -1]` and asserts the decoded array is `toEqual` the
same. **Failure mode:** without the bias, index 0 decodes as `65535`, not `-1`; the
assertion reads `expected [-1, 0, 1, ...] to deeply equal [65535, 0, 1, ...]`.

Test counts updated end-to-end: Step 4 (`encodeSnapshot`/`decodeSnapshot` block)
8 → 9; Step 8 (+`applySnapshotToState`, see finding 2) 12 → 14; Step 9 (whole-package
run) 12 → 14; Step 13 (+barrel test) 13 → 15. Commit message updated.

---

## 2. Stale entity `targetId` — `plan2-task-06-snapshot.md`

**Was:** `applySnapshotToState` copied every `WireEntity` field into `SimState`'s
entities but left `targetId` completely untouched on every slot, "deliberately"
(`WireEntity` has no such field). True for a *live* slot, but wrong for a *dead* one:
`decodeSnapshot`'s own re-sentinelling can reset `entityId`/`position`/etc. on a
now-dead slot, but has no `targetId` field to reset it with (`WireEntity` doesn't
carry one) — so a slot that held a live seeker homing on some kart keeps that stale
`targetId` after the seeker despawns and the slot goes dead, diverging from
`entity.ts`'s `clearSlot()` convention (`entityId: -1` always paired with
`targetId: -1`). `ShadowLoop.reconcile` (Task 16) calls `applySnapshotToState`
directly, so the residue reaches a real consumer.

**Changed:** `applySnapshotToState`'s entity loop now does
`if (s.entityId === -1) e.targetId = -1` — resetting `targetId` only on slots the
wire says are dead, leaving a live slot's `targetId` exactly as found (still correct;
there is no wire data either way). Docstring and the module's top-matter both updated
to state the rule as a *partial* exception, not a blanket one, and to explain why the
obligation lands here rather than in `decodeSnapshot` (this function is the only one
with both the dead-slot signal and a `targetId` field to clear).

**New test** — `'resets a re-sentinelled entity slot's targetId to -1, matching
entity.ts's clearSlot convention'`: encodes/decodes a 0-entity snapshot (wire says
slot 0 is dead), pre-seeds `dst.entities[0].targetId = 5` as a stale marker, calls
`applySnapshotToState`, asserts `targetId === -1`. **Failure mode:** without the
fix, `dst.entities[0].targetId` stays `5`; the assertion reads
`expected 5 to be -1`. The existing test proving a *live* slot's `targetId` survives
untouched (marker `999`) is unchanged and still passes — the fix is conditional, not
a blanket write.

---

## 3. `ShadowLoop`'s `ctx` mutation divergence — `plan2-task-16-shadow.md`

**Was:** Documented by Fix C as "open, deliberately not fixed" — `ShadowLoop.promote()`
mutates the caller's own `SimContext` object (`this.ctx.isLeader = true`) while
`AuthorityLoop`/`ClientLoop` each defensively copy theirs. No standalone test named
the mechanism; it was only exercised as a side effect of the larger promotion tests.

**Decision:** Confirmed this is not a contract-vs-spec conflict — it's a resolvable
implementation-consistency question. Kept the mutate-the-caller's-object design,
because it's the *only* channel available: contract §5 locks `ShadowLoop` at exactly
three members (`constructor`, `tick`, `promote`) with no `state()`-like accessor,
unlike its two peers, and §0 forbids adding a fourth. `AuthorityLoop`/`ClientLoop`
never need one because their role is fixed for their whole lifetime; `ShadowLoop`'s
role genuinely changes at promotion. Upgraded the brief's "ambiguities" section
(item 3) from "open" to a firm rule: **never share one `ctx` object between a
`ShadowLoop` and any other loop or subsystem that re-reads `ctx.isLeader` after its
own construction** — `AuthorityLoop`/`ClientLoop` are safe to share with regardless,
because each pins its own private copy at construction and never looks at the shared
object again.

**New test** — `'promote() mutates the exact ctx object passed to the constructor,
not a private copy'`, added to the promotion `describe` block, isolated from the
40-tick "never rewinds" test that only proved this incidentally. **Failure mode:** if
a future edit made `ShadowLoop` defensively copy `ctx` (matching its peers) without
providing another channel, the caller's own `ctx.isLeader` binding would stay
`false` after `promote()`; the assertion reads `expected false to be true`. This is
exactly the regression the "resolved" note now warns against by name.

Test counts updated: Step 12 18 → 19, Step 13's cross-reference likewise. Propagated
to `plan2-task-18-barrels.md`'s own citation of `shadow.test.ts`'s count (18 → 19).

---

## 4. `RemoteInterpolator` unwired — `plan2-task-15-client.md`

**Was:** `RemoteInterpolator` (Step 10) was fully implemented and tested standalone,
but nothing fed it. `ClientLoop.onMessage`'s `'snapshot'` branch decoded every
incoming `WireSnapshot` only to reconcile the local kart against it — the other seven
karts' wire data was read and discarded. Spec §5's "buffered and rendered ~100ms in
the past" requirement for remote karts was unimplemented, not merely untested.

**Decision:** Contract §5 locks `ClientLoop` at exactly four members and §0 forbids
adding a fifth — so wiring cannot mean adding a `sampleKart`-style method to the
class. It also cannot mean wiring to an actual renderer: no `render`/`game` package
exists in this repo, and that's rightly out of Plan 2's scope. What *is* in scope,
and closable without touching the locked class or inventing an out-of-plan
dependency, is feeding the interpolator from data `ClientLoop` already owns.

**Changed** (new Steps 12–15, old Steps 12–15 renumbered 16–19):
- `ClientLoop` gains a private `remoteInterp = new RemoteInterpolator()` field.
- `onMessage`'s `'snapshot'` branch now pushes every newly-accepted snapshot's karts
  (cloned via a new `cloneWireKarts` helper — the ping-ponged decode buffers get
  reused, so a keyframe must own its own copy) into `remoteInterp`, timestamped by
  `this.predicted.tick * TICK_MS` (`TICK_MS = 1000 / TICK_HZ`, `TICK_HZ` imported
  from `@tapkart/sim`) — no `Date.now()` anywhere, matching contract §0's "ticks
  only" convention.
- A new free function `export function remoteInterpolatorOf(client: ClientLoop):
  RemoteInterpolator`, backed by a private module-scope `WeakMap<ClientLoop,
  RemoteInterpolator>`, is the accessor — not a class method, so `ClientLoop`'s
  public surface stays exactly four members. This is the same "define what you need
  in your own files" allowance the brief already used for `RemoteInterpolator`
  itself, applied one level further out.
- Updated the stale `RemoteInterpolator` section comment (previously "not wired
  into ClientLoop... a later plan wires this") to state the input is wired here and
  only the renderer output remains later-plan scope.

**New test** — `'feeds the incoming snapshot stream into its RemoteInterpolator,
keyed by receipt tick'`: runs a real `AuthorityLoop` + `ClientLoop` pair for 30
ticks, then calls `remoteInterpolatorOf(client).sampleKart(REMOTE_SEAT, ...)` for a
bot-driven remote seat. **Failure mode:** `RemoteInterpolator.sampleKart` returns
`null` whenever nothing has ever been pushed (already proven by its own Step 8 test)
— so if the wiring is missing or removed, `expect(sample).not.toBeNull()` fails with
`expected null not to be null`. A second assertion
(`Math.abs(x) + Math.abs(z) > 1`) guards against a wired-but-degenerate `{0,0,0}`
passing by coincidence, since every shipped track's grid start is off-origin.

The test's title deliberately says "feeds the ... stream," not "pushes every
snapshot" — it proves at least one push reached the interpolator with sane data, not
that every accepted snapshot was pushed (the code does that; the test doesn't need to
re-prove it to close the "wired to nothing" gap).

Test counts: Step 11 (RemoteInterpolator standalone) unchanged at 10; new Step 15
(wiring) 10 → 11; old Step 12 zero-corrections test (now Step 16/17) 11 → 12;
Step 18 ("this task's N") 11 → 12. Step numbering re-verified sequential 1–19, no
gaps or duplicates. Commit message (Step 19) rewritten to describe the wiring.

---

## 5. Task 11's stale test-count claim — `plan2-task-12-loopback.md`

**Was:** Step 9 said "including this task's 8 ... alongside Task 11's 4 and Task 10's
2." Fix B's own pass on Task 11 (a different file, same fixer's territory) added a
third test to `transport.test.ts` (proving `Transport` is reachable through the net
barrel), bringing Task 11's own total to 5 (2 in `scaffold.test.ts` + 3 in
`transport.test.ts`) — but that fix never propagated to this cross-reference in
Task 12's brief, which still said 4.

**Changed:** `plan2-task-12-loopback.md` Step 9 now reads "Task 11's 5 (2 in
`scaffold.test.ts`, 3 in `transport.test.ts`...)" with a note explaining why the
figure moved. Verified Task 10's cited count (2) is still correct by counting `it(`
blocks in `plan2-task-10-input.md` directly, and verified Task 11's own brief already
states its total correctly in relative terms ("confirm the total increases by exactly
5") so no further edit was needed there. Verified no other file in the plan cites
Task 11's or Task 10's test counts.

This finding needed no new test — it is a stale number in prose, not an
unimplemented behavior; the fix is the recomputation itself (2 + 3 = 5, confirmed
against the actual test file content Fix B produced).

---

## Verification performed

- Re-read contract §3/§4/§5 against every changed file: no bit width, signature, or
  constant was altered — `178`/`135`/`200` bits, `WIRE_TAG`'s hex values, and every
  locked class's exact member list are untouched. All four changes (findings 1–4)
  are additive within a task's own already-defined territory or its "define what
  you need in your own files" allowance (§0); none renames or re-signs a locked
  export.
- Confirmed `TICK_HZ = 60` is a real, barrel-exported `@tapkart/sim` constant by
  reading `packages/sim/src/types.ts` and `packages/sim/src/index.ts` directly,
  not assumed.
- Every new RED prediction matches this repo's established patterns, cited by their
  own precedent rather than invented fresh: a missing named runtime export binds to
  `undefined` at the call site (`TypeError: remoteInterpolatorOf is not a function`,
  matching Task 1's `resetBotHold` and Task 3's `encodeHeader` precedents) — not the
  `(0, _mod.x)` form, which isn't this repo's dominant convention.
- Re-walked every test-count arithmetic chain end to end after edits (Task 6:
  8→9→14→15; Task 15: 10→11→12; Task 16: 18→19) rather than editing one number and
  assuming the rest still agreed, and grepped every other file for a cross-reference
  to each changed count (found and fixed one: Task 18's citation of
  `shadow.test.ts`'s total).
- Confirmed step numbering is sequential with no gaps or duplicates in both files
  where steps were inserted: Task 15 (1–19) and Task 16 (unchanged, 1–14, new test
  added inside existing Step 11's block).
- For every test added or touched in this pass, confirmed and stated a concrete
  failure mode above — none compares a value to itself, none iterates an empty
  collection, and each references the specific line of code whose absence or
  reversion it catches.
- `git status` confirms only the intended plan files changed; no scratch files were
  created or left behind.

---

## Executable?

**Yes.** All seven items from the three fix reports' "left open" sections are now
closed: two by the contract amendment (transports deferred to Plan 4, dual-send is
`Transport.broadcast`), five by this pass. Every remaining cross-file reference
(bit widths, signatures, test counts, RED predictions) was checked against the
files it actually now describes, not against a stale prior draft. No task in the
18-task sequence references a type, function, or constant that its own or an earlier
task fails to define, and no step's expected outcome was left inconsistent with the
test content immediately above it.

The one thing worth a human's attention before execution, not because it blocks
correctness but because it's a judgment call rather than a mechanical fix:
finding 4's `remoteInterpolatorOf`/`WeakMap` pattern is a legitimate, contract-
compliant way to route around a locked four-member class, but it's more machinery
than the other four fixes needed, and a plan reviewer who disagrees with the
free-function-accessor design (as opposed to, say, deferring the wiring itself to
Plan 3) should say so before Task 15 executes — reverting it later means unpicking
Steps 12–15 and renumbering 16–19 back down.
