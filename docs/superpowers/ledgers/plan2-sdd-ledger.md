# SDD ledger — plan: docs/superpowers/plans/2026-08-14-tapkart-plan2-protocol-netcode.md

Spec: docs/superpowers/specs/2026-08-13-tapkart-design.md (read — binding authority, amended
  three times on 2026-08-14 for this plan)
Contract: the plan's Global Constraints section (= plans/2026-08-14-tapkart-plan2-contract.md)
Worktree: .claude/worktrees/plan2-net on branch worktree-plan2-net (base 2a8085e)
Tasks: 18. Baseline verified at setup: 477 passed + 1 skipped, typecheck clean.

---

## Pre-flight scan

**This plan arrived pre-scanned, far more thoroughly than this step normally is.** Three
adversarial audits (`PLAN2-AUDIT-A.md` tasks 1-9, `-B.md` tasks 10-18, `-C.md` cross-cutting)
ran over the eighteen briefs before any execution, followed by four fix rounds
(`PLAN2-FIX-A.md` through `-D.md`). They found ~30 blocking defects and 13 spec-coverage gaps
and closed all of them. Rather than re-derive that work, this scan records what those rounds
established and rules on what they left.

### A. Files edited by more than one task

| File | Task chain | Finding |
|---|---|---|
| `packages/sim/src/types.ts` | T1 only | Clean — T1 is the sole exception to Plan 1's "no task edits types.ts"; contract §1a grants it |
| `packages/sim/src/state.ts` | T1 (create/clone/equal carry the hold) | Clean |
| `packages/sim/src/phase.ts` | T1 (hold → state), T2 (emit gate) | Clean — disjoint edits, audit C verified they compose by applying both to a scratch sim (483 passed) |
| `packages/sim/src/replay.ts` | T1 (delete parity guard + needsOddCheckpoint) | Clean |
| `packages/sim/src/{recovery,laps,entity,items}.ts` | T2 (emit gates, 3 signature changes) | Clean — contract §2a lists all three |
| `packages/protocol/src/index.ts` | T3 creates, T4/T5/T6 append, T18 widens | Clean after FIX-A; each module appends itself so `net` is not blocked on T18 |
| `packages/net/src/index.ts` | T11 creates, T18 widens | Clean after FIX-B |

### B. Interface pairs (producer → consumer)

Audit C produced the full table and every row now agrees. The pairs that were broken and are
now fixed, worth naming because they were the plan's worst defects:

| Producer | Consumers | Was | Now |
|---|---|---|---|
| T3 `WIRE_TAG`/`encodeHeader`/`decodeHeader` | T14, T15, T16 | **T3 did not produce them**; T16 invented its own scheme, T14/T15 sent untagged payloads — the three loops could not parse each other | T3 produces them with real TDD steps; all three loops frame and dispatch through them |
| T5 `Q`/`EPS` | T6, T7, T15, T16 | 19-key `Record` keyed `lapT`, 177-bit kart | 6-key interface keyed `t`, 178-bit kart, `isBot`/`connected` separate bits |
| T6 `WireSnapshot` | T15, T16 | 177 bits, `isBot` dropped | 178 bits |
| T14/T15 reconciliation anchor | T16, T17 | `lastProcessedInputTick` (a *different instant* from `snap.tick`) | `snap.tick`; `lastProcessedInputTick` is an input-buffer cursor only |

### C. Per-task self-consistency

T1-T18 verified by the audits. Audit C additionally **executed** T1 and T2 against a scratch
`packages/sim` — 483 passing, both control tests genuinely failing when the bug is present —
and found three false step-level expectations, since corrected by FIX-A.

### D. Rulings made before execution begins

- **Ruling P2-R1: per-task commits, squashed before merge.** Same as Plan 1's R1. The SDD loop
  needs commit ranges for review packages and ledger recovery; the standing preference is one
  commit at the end. Squashing at finish satisfies both.
  *Cost if wrong:* a multi-commit branch reaches finishing-a-development-branch and is squashed
  there instead — trivial.

- **Ruling P2-R2: `RemoteInterpolator`'s `WeakMap` wiring in T15 stands.** FIX-D flagged it as
  its riskiest change and asked whether it should defer to Plan 3. Decided: keep it. Spec §5
  requires remote karts and entities to be interpolated ~100 ms in the past and **never
  predicted**; without the wiring that requirement is unimplemented, and "unimplemented but
  planned" is how a spec clause silently becomes a Plan 3 surprise. The `WeakMap` exists only
  because contract §5 locks `ClientLoop` to four members, so the alternative is amending the
  contract mid-execution — worse.
  *Cost if wrong:* four inserted steps in T15 to unpick, and the interpolation moves to Plan 3.

- **Ruling P2-R3: the three audits and four fix rounds replace a fresh pre-flight scan.** They
  are strictly more thorough than this step requires (they included executing two tasks against
  a scratch checkout), and re-deriving them would cost hours and find less.
  *Cost if wrong:* a defect they missed is caught at task-review time instead, which is the
  net the loop provides anyway.

Scan complete. Proceeding to Task 1.

---

## Task log

Task 1: complete (commits 2a8085e..6b026c8, review clean). 476 passed + 1 skipped, tsc clean.
  Reviewer hand-traced BOTH decisive tests against the pre-change design and confirmed each
  genuinely fails there: the two-SimState test (old odd-tick branch sees holdTick[0]===tick-1,
  reuses room1's intent for room2) and the even-tick checkpoint test (old needsOddCheckpoint
  fires a RangeError at tick 360). It also verified the test's +6 m displacement is NECESSARY —
  without it both rooms' bots emit identical output regardless of the bug and the test is dead.
  Deep-copy confirmed alias-free by inspection AND by statesEqual's differsAfter assertions.
  The sim is now instanceable: spec §5's one-sim-per-room server is possible.
Task 1: minor (deferred): state.test.ts's "reuses every existing object" test wasn't extended to
  pin heldBotIntent[i] object identity across cloneState. Correct by inspection; coverage gap.

--- Task 2 dispatched, BASE 6b026c8 ---
Task 2: review returned Needs fixes — implementation correct (all 11 sites gated, 3 signatures
  contract-exact, every gate wraps only the emit and never a mutation, verified line by line),
  but the flagship parity test structurally excludes the item path.
Ruling P2-R4: EXTEND the parity test rather than reword the claim. `stubContext()` sets
  `itemBoxes: []`, so the leader-only roll never runs and kart 4's item is assigned directly.
  That hides a real divergence: items.ts's gate wraps `k.item = item` and the `rngCursor` advance
  as well as the emit, and both are `statesEqual`-compared — so on a granting tick a leader and
  follower also differ in `k.item` and `rngCursor`.
  Decided: cover the case, do not reword around it. An item grant is the ONLY event a follower
  cannot re-simulate — spin-outs, respawns, lap crossings and entity lifecycle all still happen
  locally, only their announcement is suppressed, whereas `k.item` stays 'none' until Task 13's
  applyEvent delivers it. That asymmetry is the entire reason `isLeader` exists, so a parity test
  routing around it leaves the most important case unverified. Reworded claim: identical except
  `nextEventSeq`, the events array, and — on a granting tick — `k.item` and `rngCursor`.
  *Cost if wrong:* one extra test exercising a path the netcode depends on. Minimal.
Task 2: minor (deferred): the revert-all-8 substitute verification proves aggregate
  discrimination, not per-site. Adequate given each paired test isolates one function.

Task 3: complete (commits b0ab84a..a3dcdfe, review clean). 496 passed + 1 skipped.
  `packages/protocol` exists with WIRE_TAG, encodeHeader/decodeHeader and the barrel wired
  through `exports` — so `net` can import `@tapkart/protocol` from Task 11 rather than reaching
  across the package boundary. Reviewer hand-traced the version-mismatch test and OVERTURNED the
  implementer's own doubt: it uses a valid tag with a bad version, so it can only pass by reaching
  the version branch. No vacuous RED reported — type-only surface took its RED from tsc (TS2305),
  runtime values from vitest, exactly the discipline this repo's prior incidents demand.

Ruling P2-R5: ONE committing agent at a time from here. Reviews (read-only) may still run
  concurrently with an implementer; two implementers may not.
  Why: running T2's fix alongside T4/T5's implementers produced a real git race — two agents
  staging and committing in the same worktree, and T5's commit briefly swept up T2's staged
  test file. Both agents detected it and repaired it non-destructively, and an audit of every
  commit's file list confirms the history is now exactly right — but that was partly luck.
  The SDD skill already says "never dispatch multiple implementation subagents in parallel
  (conflicts)"; I read that as being about file conflicts and treated disjoint files as safe.
  It is also about the index, which is shared regardless of which files each agent touches.
  *Cost if wrong:* ~12 min per task instead of ~8. Cheap next to a corrupted history.

Task 2: fix round 1/5 (1 addressed, 0 open; commit aeaf679). The companion test proves the
  item-grant divergence is EXACTLY three fields (nextEventSeq, karts[0].item, rngCursor) via
  statesEqual after equalising precisely those three, and the implementer verified BOTH failure
  modes by temporarily breaking items.ts's gate: a missing gate fails at followerEvents.length,
  and an unexpectedly-matching item/rngCursor fails at karts[0].item even with the event-count
  checks disabled. Original Step 30 title/comments reworded to drop the universal two-field claim.
Task 2: complete (commits 6b026c8..b0ab84a + aeaf679, review clean after 1 fix round)

Task 4: complete (commits a3dcdfe..a8198af) — BitWriter/BitReader, 510+1. Review pending.
  The implementer caught a vacuous RED in the brief itself: Step 3's code block included
  writeFloatQ/readFloatQ inline, which would have made Step 6's RED pass trivially. It withheld
  them so the RED was genuine, and the final file matches Step 3 + Step 7 combined.
Task 5: complete (commits a8198af..ecc60eb) — Q/EPS/quantStep, 523+1. Review pending.
Task 4: complete (a3dcdfe..a8198af + c334e91 fix). Approved. Fix round closed a subtler vacuity
  than usual: the byte-straddle test's value 0b101 is a bit-PALINDROME, so it detected a
  byte-cursor-direction reversal but NOT a value-bit-order reversal — MSB-first extraction wrote
  identical bytes. Every byte-level assertion in the file used reversal-symmetric values (0,
  2^bits-1, 0b101). Replaced with 0b110; new expectation (191,1) hand-traced to diverge under both
  wrong implementations. Test-only; bits.ts untouched.
Task 5: complete (a8198af..ecc60eb). Q/EPS/quantStep, six continuous keys, frozen.
Task 6: complete (ecc60eb..392f2c3 + f91f54a fix). Snapshot codec. 178/135/200 bits verified by
  the reviewer summing actual writeBits calls against real Q values. 743 B worst case matches the
  spec amendment's independently-derived figure exactly.
  Fix round: `applySnapshotToState` reset targetId only on a DEAD slot, but entity.ts's
  despawnEntityAt is a SWAP-REMOVE — a slot's occupant changes identity without ever reading -1 at
  that index, so a dead seeker's targetId got silently reattributed to whichever entity was
  swapped in. Shipped rule captures prevEntityId before the overwrite and resets on
  `dead || (was-live && identity-changed)`.
  CONTROLLER CORRECTION: my suggested one-liner `s.entityId !== e.entityId` was wrong, and the
  implementer caught it — applied literally it broke two approved tests. The re-reviewer then
  corrected my second claim too: the new residue test does NOT fail under the naive one-liner,
  because that form gets swap-remove right; its bugs are on dead→dead and dead→live where it
  over-fires, caught by the two pre-existing tests. Recorded because I was wrong twice about the
  same line and both corrections came from agents reading the code rather than my reasoning.
Task 7: complete (392f2c3..a7e656d). Approved. Round-trip bounds + the epsilon>step invariant.
  The teeth control uses a perturbed EPS copy; the reviewer verified its detection power
  EMPIRICALLY by running the real check with `>` and then a regressed `>=` and confirming every
  assertion flips. All six margins 1.5x-2.05x.
Task 8: complete (a7e656d..26e48a9). Full-precision checkpoint codec; review pending.
Task 6: fix round 1/5 complete (commit f91f54a) — ADDRESSED. Re-reviewer confirmed the
  swap-remove premise directly against despawnEntityAt and verified all five transitions.
Task 8: complete (a7e656d..26e48a9), review clean. Floats genuinely raw (zero uses of
  writeFloatQ/Q/quantStep in the file). All nine snapshot-excluded fields carried, including
  heldBotIntent/heldBotTick with their own explicit per-index assertions rather than relying on
  statesEqual alone — the Task 1 regression guard. Reviewer independently recomputed the encoded
  length (673 fields x 8 B = 5384) and it matches the asserted constant, so a dropped or
  duplicated field fails on byte count before statesEqual runs. Test state is genuinely rich:
  8 populated karts, 5 live + 27 dead-residue entities, mixed item-box cooldowns, a deliberate
  -0 velocity component verifying no -0 special-casing is needed.
Task 8: minor (deferred): the "independent copy" test checks only one direction of aliasing.
  Moot given the codec assigns primitives into pre-existing nested objects and never rebinds them.
Task 9: complete (f91f54a..53d40ca) — AuthEvent codec, 579+1. Review running.
Task 9: complete (f91f54a..53d40ca), review clean. The +1 bias on playerId/entityId is real and
  tested at both the -1 sentinel and the real-value boundary; the unrecognised-kind throw is
  placed BEFORE any writeBits, which is what prevents an invalid index masking to a valid-but-
  wrong 3-bit pattern rather than merely detecting it after.
Task 10: complete (53d40ca..c85109e) — input codec. @tapkart/protocol is now COMPLETE.
  Review: implementation correct on every dimension. One Important finding, and the root cause
  is MY BRIEF, not the implementer.

Ruling P2-R6: the drop-recovery property cannot be tested in Task 10 and moves to Task 17.
  I asked Task 10 for a test proving spec §5's "a dropped packet costs nothing". The reviewer
  proved that test is causally inert — it bundled input.ts with esbuild, ran the scenario with
  and without the two "dropped" datagrams being encoded, and got bit-for-bit identical output.
  The reason is structural: encodeInput/decodeInput are STATELESS per call. There is no
  cross-datagram state in that file, so no mechanism exists for a later datagram to recover an
  earlier one's tick. The tick passed because it was one of the decoded window's own eight
  entries.
  "A dropped packet costs nothing" is a consequence of TWO things: this codec round-tripping
  whatever window it is handed (Task 10's first test proves that), AND a caller assembling
  overlapping windows over successive ticks. That caller is ClientLoop (T15) / AuthorityLoop
  (T14), which did not exist when I wrote the brief.
  Decided: T10's second test is reframed to state what it actually verifies (a differently-
  offset window round-trips; decode never fabricates out-of-window ticks), with the dead
  "dropped" datagrams removed — dead code dressed as a mechanism is worse than no test, because
  the next reader believes the property is covered. The genuine assertion moves to T17, where a
  real ClientLoop assembles windows over time against a real 5%-loss LoopbackTransport and the
  test can actually fail.
  *Cost if wrong:* the property is verified one task later than intended, at the only layer where
  it is verifiable at all.
  Worth recording as a controller error: I demanded proof of a property at a layer that
  structurally cannot exhibit it, and the implementer faithfully produced a test that looked like
  the proof I asked for. The reviewer caught it by executing the code rather than reading it.
Task 11: complete (c85109e..06f7bac), review clean. @tapkart/net scaffold + Transport interface.
  RED came from tsc throughout (types-only module); the reviewer reproduced the 12-diagnostic
  cascade live in the worktree to confirm the explanation rather than accepting it.
Task 10: fix round 1/5 complete (commit 6beef74, test-only). Dead "dropped datagram" code removed;
  second test reframed to what it actually verifies, now with IRREGULAR tick spacing so it also
  distinguishes "reads each stored tickDelta" from "assumes a fixed cadence" — closing the
  reviewer's Minor. Task 17 deferral noted in the test file itself.
Task 12: complete (06f7bac..a2d05d5), review clean. Cursor isolation airtight — `cursor` is
  closure-scoped per makeLoopbackPair call, `state.rngCursor` appears only in a doc comment, and
  reliable sends provably consume zero draws (separate branch, no rngAt call). No real clock
  anywhere; pump(nowMs) is the sole time seam. All four load-bearing tests independently re-run
  and shown discriminating. The loss-rate band is quantitatively justified: N=20000, sigma
  ~0.00154, band +-0.01 ~= 6.5 sigma — tight enough to catch a defect, wide enough not to flake.
Task 12: minor (deferred): no test interleaves reliable sends BEFORE unreliable ones to prove
  reliable traffic cannot perturb subsequent unreliable determinism. Ruled out by reading the
  source (reliable branch makes no rngAt call) but not behaviourally asserted.

CONTROLLER PROCESS NOTE: I dispatched T12's review citing a diff file I had not generated — I had
  packaged T11's range and never ran review-package for T12. The reviewer regenerated it read-only
  via git diff and proceeded. Correct adaptation on its part; my error. Generate the package
  BEFORE dispatching, not in the same breath.
Task 13: complete (a2d05d5..45dcc3a), review clean. `applyEvent` — the follower's half of
  emit-gating. Ruling P2-R7 recorded in the contract: applyEvent OBEYS, it does not re-adjudicate.
  It is the sole exception to the startSpinOut sole-writer rule, because a follower that re-ran
  the adjudication would double-apply on the authority and desync everywhere else.
Task 14: complete (45dcc3a..b8518a2) — AuthorityLoop, the host's 60Hz leader loop with 20Hz
  snapshot broadcast, 30Hz input hold across both ticks of a pair, per-player
  lastProcessedInputTick (published only), and bot takeover on drop. 616 passed + 1 skipped.
  The implementer found the 14th vacuous test IN ITS OWN BRIEF: the 30Hz-hold test asserted only
  `taggedSnapshots > 0`, which passes even if the loop broadcasts every single tick. It added an
  exact-sequence cadence test and confirmed by mutation (broadcast unconditionally -> red, revert
  -> green). First time an implementer caught one by reading its brief sceptically rather than a
  reviewer catching it after the fact. Review running.
Task 14: review clean — APPROVED. Reviewer independently traced the new cadence assertion and
  confirmed it is a full ordered-sequence `toEqual` against [3,6,...,30]: "every tick" gives 31
  entries, "never" gives 0, "every 2nd" gives 15, a phase-shifted mod-3 gives [1,4,7,...] — all
  four fail. Genuine improvement, not cosmetic. Tick counts: cadence 31 ticks, 30Hz hold 40 ticks
  across two transmission windows AND the gap between them, bot takeover 120 ticks post-drop.
  lastProcessedInputTick confirmed WRITE-then-PUBLISH only: written once per tick from
  heldIntentTick[i], read once into encodeSnapshot, never compared to state.tick or snap.tick.
Task 14: minor (deferred): the brief's inherited 30Hz-hold test sends 8 redundant intents whose
  control fields are identical (steer 0.5, accel 1) and differ only in `tick`, so it cannot
  distinguish "apply per aligned 2-tick pair" from "apply the newest value forever until
  replaced". The shipped code satisfies the spec either way (unconditional per-tick reapplication
  is a strict superset), so this is a test-design weakness, not a defect — and it is pre-existing
  in the brief, not introduced by T14.

--- Rulings raised by the Plan 3 contract draft (which read Plan 2's real surface) ---

Ruling P2-R8 (Plan 3 draft Q4 — a guest cannot see entities at all). `RemoteKeyframe` carries
  only `karts`, so `ClientLoop` decodes `WireSnapshot.entities` and throws them away. Spec §5
  forbids predicting entities, so a guest today has three options and all three are wrong: draw
  them from the predicted state (forbidden), draw nothing (shells and slicks invisible to every
  non-host), or widen `net`. RULED: widen `net`, as a PLAN 2 amendment, not a Plan 3 task —
  Plan 3 must never write into `net` (dependency direction, spec §3). `RemoteKeyframe` gains
  `entities: WireEntity[]` and `entityCount: number`; `RemoteInterpolator` gains
  `sampleEntity(entityId, nowMs)`.
  CRITICAL DETAIL for that method: entities are packed at the front of the array and removed by
  SWAP-REMOVE, so `entities[i]` in keyframe A and keyframe B are NOT the same entity. It must
  match on `entityId`, never on index — the index-keyed version compiles, passes a
  one-entity test, and teleports entities into each other the moment two are live.
  *Cost if wrong:* entities pop between snapshot positions at 20Hz, or swap identities.

Ruling P2-R9 (Plan 3 draft Q5 — a guest's HUD is driven by bot AI). `ClientLoop` never applies
  the snapshot to non-local seats, so the other seven karts in `state()` are the local sim's own
  bots. Every remote lap counter, standings row, and held-item icon a guest sees would be
  fiction. RULED: do NOT fix this by calling `applySnapshotToState` on the predicted state —
  mixing authoritative and predicted data in one struct is exactly the confusion that breeds
  these bugs, and a replay would re-simulate remote seats straight back over the authoritative
  values. Instead `RemoteSample` gains `kart: WireKart` — the newest authoritative record for
  that seat, verbatim off the wire. Interpolated `position`/`heading` stay where they are; every
  discrete field is read from `sample.kart`.
  This makes the seat-source rule mechanically checkable, which was the point: a renderer reads
  the LOCAL seat from `state()` and every OTHER seat from the interpolator, never both. It also
  resolves placement without a new wire field, because `WireKart` already carries `lap`,
  `checkpointIdx` and `t` — everything `placementOrder` needs — for all eight seats.
  *Cost if wrong:* one extra object reference per sample; no bandwidth change (the data is
  already decoded and already retained in the keyframe).

Ruling P2-R10 (Plan 3 draft Q6). `@tapkart/net` exports `TICK_MS`. It is currently a private
  const in `client.ts` and Plan 3 would have redefined it. One line against a permanent
  two-definition hazard.

Ruling P2-R11 (Plan 3 draft Q7 — CONFIRMED, not changed). `ClientLoop` stamps keyframes with
  `tick * TICK_MS`, so the interpolator's timebase is SIM TIME, not wall time. Passing
  `sampleKart` a `Date.now()`-derived `nowMs` makes every remote kart extrapolate at the 200ms
  cap forever — silently, with nothing CI would catch. Plan 3 §6.3 states the rule; Task 15b
  adds the assertion that pins it here, at the layer that owns the stamp.

These land as TASK 15b, dispatched after Task 15's review closes. Not folded into Task 15: that
  task is mid-flight against a locked brief, and amending a brief under a running implementer is
  how the startSpinOut signature defect happened.
Task 15: complete (b8518a2..f1dee8f) — ClientLoop, prediction + reconciliation. 632 passed + 1
  skipped (16 new). Review running on opus, dispatched to adjudicate three brief deviations:
  (1) the client must predict on the WIRE FORM of its own intent — encodeInput quantises steer to
      8 bits, so predicting the raw analog value simulates an input the authority never receives.
      186 corrections/600 ticks before, 1 after.
  (2) a resync rebases PER FIELD with EPS as a dead band — a field already agreeing keeps its
      full-precision predicted value rather than being overwritten with the quantised one, because
      overwriting an agreeing field injects a sub-epsilon residual that makes true error GROW.
  (3) the claim that the brief's Step 16 (end-to-end zero corrections over 600 ticks) is NOT
      ACHIEVABLE at any epsilon: every correction leaves a <=0.0156 m/s velocity residual, below
      EPS.velocity and therefore never corrected, which integrates past EPS.position in 3-6 s.
      Measured 0-2 per window across 20 seeds.
  Also the SIXTEENTH vacuous test, again found by an implementer in its own brief: Step 16's
  convergence assertion compared two karts freshly snapped to the same respawn point, so the
  measured delta was 0.0000 on every seed.

Ruling P2-R12 (pre-registered, subject to the review's independent check of the impossibility
  argument). Deviation 3 is ACCEPTED and the split stands, because it is what spec §8 actually
  asks for. That row requires TWO things — "assert client converges and stays within epsilon,
  AND that steady-state quantization noise triggers zero corrections" — and the section then
  states the second assertion's purpose outright: "The zero-corrections-in-steady-state assertion
  is the one that protects against the epsilon being set below the quantization step — the defect
  that would ship as an unexplained visual buzz."
  A literal end-to-end zero conflates quantisation noise with latency-induced mispredicts, and so
  tests the stated purpose LESS precisely than the mirrored-authority form, where quantisation is
  the only difference between the two sims and the sub-/beyond-epsilon controls bracket it. The
  implementer's split maps one-to-one onto the spec's own two clauses.
  The impossibility argument is also sound on its face: the wire carries 12-bit velocity, so once
  a correction forces the client to adopt a quantised velocity it holds a permanent sub-step error
  against the authority's full-precision value, and no epsilon can stop a constant velocity error
  from integrating into an unbounded position error. The only fixes are architectural (input-tick
  buffering in AuthorityLoop, or render-side error smoothing) and neither is Plan 2's business.
  *Cost if wrong:* if the review's independent derivation contradicts this, the split is hiding a
  real reconciliation defect and Task 15 reopens. That is why the review was told to derive it
  from quant.ts itself rather than accept the report's arithmetic.
Task 16: dispatched (ShadowLoop + promotion).
Task 15: review clean — APPROVED (opus). The reviewer did not take the report on trust: it
  re-derived the quantisation table from quant.ts, instrumented reconcile in a scratch copy, and
  ran SIX mutations that reproduced the report's numbers exactly.
  Ruling P2-R12 CONFIRMED by independent derivation. position/velocity both step 0.03125 with
  half-step 0.0156 against EPS 0.05 (3.2x). The reviewer found the mechanism is OVER-determined:
  heading is the worse channel and the report never mentions it — a sub-epsilon 0.0024 rad error
  at 20 m/s is 0.048 m/s of lateral drift, crossing EPS.position in ONE second. Measured 1-2
  corrections per 600-tick window across 20 seeds, never zero; and at least one is guaranteed by
  the startup transient (vx off by 1.03 m/s before the authority has received any input).
  Deviation 1 is broader than the report claimed: encodeInput also quantises ACCEL to 6 bits, and
  because throughWire round-trips the real codec rather than re-deriving STEER_BITS, accel is
  covered. A hand-rolled steer-only round trip would have missed it, and the shipped test runs
  accel 0.4, which is not on the 6-bit grid.
  Sixteenth vacuous test CONFIRMED on six seeds: dp = 0.000000 exactly, every seed.

Ruling P2-R13 (from the reviewer's OWN finding, which neither brief nor report covers, and which
  outranks the task it was found in). Every convergence test uses a HELD-STEADY intent. Under
  varying input — which is all real driving — corrections rise to ~3/second: measured 1
  held-steady, 29 under a sine, 39 under a square wave, per 600 ticks. The reviewer attributed it
  rather than guessing: it implemented the time-axis analogue of Deviation 1 (predict against the
  intent the authority is holding) and it changed NOTHING (30 vs 40). So it is not a client
  omission. It falls out of spec §5's own rule that the authority applies the newest intent it has
  RECEIVED at its own tick rather than buffering by stamped tick — and under jitter, which intent
  is newest at authority-tick T is a fact about packet delivery no client can predict.
  RULED: keep immediate application, absorb the corrections in RENDERING. A tick-buffered
  authority with a playout delay trades this for added input latency on every control, on a
  touchscreen arcade racer where latency is the first thing a player feels. Corrections are small
  — they fire just past EPS.position, ~5cm, against 33cm of travel per tick at speed — so `render`
  eases the visual offset to zero instead of snapping. **Error smoothing is therefore REQUIRED in
  Plan 3's render layer, not a polish item.** Spec §5 amended to record all of this.
  *Cost if wrong:* if smoothing cannot hide a 5cm ease at 3/second, the fallback is a tick-buffered
  authority, which is a Plan 4 change and costs input latency.
Task 15: minor (scheduled into 15b): event-to-ring off-by-one — events arriving at predicted.tick
  T are applied live BEFORE that tick's step(), but banked on ring entry T+1 and replayed AFTER
  its step(). Narrow (needs useItem on the tick after an itemGrant) and self-healing, but the
  RingEntry comment ASSERTS the replay lands "the same instant they took effect live", which is
  false — and a comment saying there is nothing to fix is how this survives.
Task 15: minor (scheduled into 15b): hot-path allocation. Measured 157 objects / 17.8 KB per tick,
  ~9,400 objects/s, 2.3 MB retained by the 128-entry ring. AuthorityLoop pre-allocates everything;
  ClientLoop does not. "No allocation in the hot path" is a locked constraint, so this is a
  contract violation, not a preference.

--- Rulings raised by the Plan 4 contract draft ---

Ruling P2-R14. Spec §5's promotion re-seed — "a PRNG re-seeded deterministically from
  (raceSeed, promotionTick)" — was prose with no formula, and Task 16 would have had to invent
  one. Pinned as `promotionCursor(raceSeed, promotionTick)` in sim/src/rng.ts, reusing rngAt's own
  avalanche and returning the int32 instead of dividing into [0,1).
  The thing to understand: rngAt is a PURE FUNCTION with no internal state, so "re-seed" cannot
  mean changing the seed — raceSeed is raceSeed. What is re-derived is SimState.rngCursor. It is
  needed because a follower never rolls items, so the shadow's cursor sits where it started while
  the host's advanced with every grant; promoting without re-deriving replays draws the host
  already consumed. A 32-bit avalanche output cannot land in the small low range the dead host
  actually used.

Ruling P2-R15. The Plan 4 draft's Q21 worried that re-seeding permanently falsifies statesEqual
  between host and shadow, breaking the very promotion test it supports. It does not — the spec
  settles it: "Accepted divergence: post-promotion item rolls differ from what the original host
  would have produced. This is unobservable to players and is accepted." The divergence is
  DESIGNED. And spec §8's promotion test never asks for statesEqual: it asks that the state match
  the last checkpoint "within bounds", that no lap counter regresses, no entity disappears, and no
  event is applied twice. statesEqual is sim's SAME-PROCESS bit-identity instrument, and the spec
  is explicit that bit-identity is only ever asserted same-process — a network migration is the
  opposite of that. Any convenience whole-state compare must exclude rngCursor with the exclusion
  named as spec-mandated, never incidental.

Ruling P2-R16 (Plan 4 draft Q25 — a real gap in Plan 2, scheduled into Task 15b). Spec §5's "A
  client that drops ... reclaims it on reconnect with the same room code" HAS NO IMPLEMENTATION
  ANYWHERE. AuthorityLoop.onPeerLost clears `connected` and nothing ever sets it back, so a
  reconnecting player's decoded inputs are silently discarded by resolveInputs and their kart
  stays bot-driven for the rest of the race. RULED: AuthorityLoop restores connected = true when
  a peer sends input for a seat currently marked disconnected — the natural trigger, needing no
  new message kind. Noted for Plan 4: in Plan 2's loopback scope this is identity-by-claim, which
  is fine; the lobby handshake is where reclaiming gets authenticated, and Plan 4 owns that.

Ruling P3-R46 (REVERSES my own Plan 3 Q1 ruling). I put TUNING/CHARACTERS in packages/game and
  called a separate package "ceremony for two constants". The Plan 4 draft found the hole: the
  shadow authority in packages/server needs the identical Tuning to run step() in lockstep, and
  spec §3 forbids server depending on game — so as ruled, the shadow authority is UNBUILDABLE.
  It is also not two constants once Q2/Q3/Q12 are counted: tuning + 8 characters + 8 karts +
  6 themes + 6 tracks, needed by render (themes), game (all) and server (tuning + tracks).
  NEW packages/content, depending on @tapkart/sim for types only. The fixture-equality tests move
  with it and still bind.

--- Task 15b scope, accumulated from four sources (dispatch AFTER Task 16 commits, per P2-R5) ---
  From P2-R8/R9/R10 (Plan 3 draft):
    - RemoteKeyframe gains entities + entityCount; RemoteInterpolator.sampleEntity(entityId,nowMs)
      keyed by entityId NOT index (swap-remove makes indices lie)
    - RemoteInterpolator.liveEntityIds(out) — entity ids come from a monotonic counter and cannot
      be probed, so sampleEntity is unusable without it (P3 finalizer's catch)
    - RemoteSample gains kart: WireKart (the newest authoritative record, verbatim)
    - export TICK_MS from @tapkart/net
  From the Task 15 review (all confirmed by mutation, not asserted):
    - move the applyEvent loop ABOVE step() in the replay loop; entry i's events belong to cur at
      tick i-1. Fix the RingEntry comment, which currently ASSERTS the replay lands "the same
      instant they took effect live" and is false.
    - pool the ring: 157 objects / 17.8 KB per tick, ~9,400 objects/s, 2.3 MB retained. Locked
      constraint says no allocation in the hot path, so this is a violation not a preference.
    - resyncOwnKart's comment presents EPS as the principled dead-band width; the principled width
      is nearer one quantisation step. One sentence so the choice reads as deliberate.
  From P2-R16 (Plan 4 draft): AuthorityLoop restores connected = true when a disconnected seat's
    peer sends input again. Spec §5's "reclaims it on reconnect" currently has NO implementation.
  From R42/R47/R48 (Plan 3 contract):
    - withLocalInput / createNullTransport / LocalInputTransport / LOCAL_PEER_ID move into net.
      AuthorityLoop has NO local input path at all today — a host cannot steer. Routing host input
      through the real encodeInput codec also gives the host the same 8-bit steer / 6-bit accel
      quantisation every guest gets; otherwise the host drives a measurably different car.
    - correctionDeltaOf(client, outPos): number | null — position delta into outPos, heading delta
      returned, null when no correction. Plan 3's error smoothing needs the discontinuity and
      reconcile currently overwrites `predicted` wholesale, so it cannot be recovered from outside.
      Heading is included because the T15 reviewer showed heading DOMINATES error growth (0.0024
      rad at 20 m/s = 0.048 m/s lateral drift, crossing EPS.position in one second) — the Plan 3
      finalizer had dropped it after mistaking EPS.heading, the firing THRESHOLD, for the size of
      the correction that follows.
Task 15c scope: WireSnapshot gains `phase` as 2 bits, 178 -> 180. Without it ClientLoop forces
  phase='racing' and a guest can never see a countdown — every guest just starts driving while the
  host counts down. Touches the snapshot codec, its bit-count assertions, AuthorityLoop, ClientLoop
  and spec §5's WireSnapshot table.
Task 16: complete (f1dee8f..40ba73b) — ShadowLoop + authorityChange codec + promotionCursor.
  671 passed + 1 skipped (35 shadow + 4 promotionCursor). Both mid-flight rulings applied:
  P2-R14 overrode the brief's `rngCursor = tick`; P2-R15 honoured (statesEqual appears once, in a
  follower test where nothing promotes). Six mutations confirm the assertions bite — frozen
  shadow, from-scratch shadow, never-reconciling shadow, deleted checkpoint branch, dropped
  pending events all fail BY NAME. Review running.
  THREE defects found in its own brief, all confirmed by running: (a) the 300-tick "never emits"
  test cannot pass against its own implementation, because a deaf transport auto-promotes at tick
  90; (b) the item-box assertion is off by one tick of decay; (c) Step 10's predicted RED is
  unreachable because Step 7 already contains the checkpoint branch — recovered by mutation,
  failing with exactly the predicted `expected 6 to be 501`.
  That is the THIRD consecutive task whose implementer found defects in its own brief. The pattern
  is now established rather than exceptional, and the dispatch instruction that produces it
  ("read your brief sceptically; if an expectation would pass under the bug it exists to catch,
  say so and strengthen it") is carrying its weight.

Ruling P2-R17 (Task 16's Concern 1). Spec §5's "continue eventSeq from the highest observed" has a
  hole: a host event lost in flight collides with a sequence the promoted shadow reuses, and since
  clients ignore any eventSeq at or below the highest applied, the shadow's post-promotion events
  are SILENTLY DROPPED until its counter climbs past the host's. The implementer tested both
  interleavings and found it always resolves as a drop, never a double-apply — so §8's clause
  holds and this is not a correctness break, but events are lost exactly when the race is most
  disrupted. RULED: adopt max(highestObserved, snap.eventSeq) as the floor. WireSnapshot.eventSeq
  already carries the host's counter and is decoded-then-ignored today. It cannot cause a
  double-apply (it only RAISES the floor, making emissions strictly more novel) and it self-heals
  a lagging follower. Scheduled into Task 15b item F9, along with ShadowLoop.onPeerLost (F10),
  which is missing entirely — a promoted shadow never bot-fills a dropped client.
Task 15b: dispatched (A-F: interpolator entities + host input path + correctionDeltaOf + the three
  T15 review defects + reconnect + the two ShadowLoop gaps).

--- Gaps found by the Plan 4/5 question triage (an audit of two drafts against shipped code) ---

Ruling P2-R18 (GAP-2 — the most serious defect found in net so far; added to Task 15b as item G).
  decodeHeader throws on an unknown tag, a version mismatch, AND a short buffer (buf[0] of an
  empty array is undefined, missing TAG_TO_KIND). All three loops call it DIRECTLY INSIDE their
  Transport.onMessage callback, and client.ts:313's comment documents the throw as intended.
  Under LoopbackTransport both ends always speak PROTOCOL_VERSION 1, so it has never fired and
  every test is green. Over Plan 4's real WebSocket/WebRTC transports the bytes come from a public
  socket: on the server the throw propagates out of ws's 'message' handler as an uncaught
  exception and THE PROCESS EXITS, KILLING EVERY ROOM — reachable by any guest sending one byte.
  And the expected trigger is not an attacker: it is a version mismatch after a deploy, which the
  never-auto-skipWaiting service worker policy guarantees. Same family: decodeCheckpoint throws on
  an itemBoxes length mismatch inside ClientLoop.onMessage.
  RULED: an undecodable datagram is a datagram that never arrived — drop, leave state untouched,
  keep running. ONE shared helper, not three copies, so a fourth loop inherits it. Body decodes
  wrapped too (a valid header can precede a truncated payload — exactly what a half-delivered
  frame looks like). Drops are COUNTED and exposed, because a room quietly discarding 30% of its
  traffic must be diagnosable. The load-bearing test clause: a VALID datagram delivered right
  after a bad one must still be processed — a guard that drops the bad one and wedges the loop
  passes every test that only checks "it did not throw".

Ruling P3-R49 (GAP-1 — the SEVENTEENTH vacuous test, and the first found in a CONTRACT rather
  than in code). buildAudioModel(prev, view, out) derives every one-shot from the delta between
  two RaceViews, but the locked Plan 3 contract allocates exactly ONE RaceView per session and
  ViewBuilder.build is its sole writer, called once per frame. There is no second view and no swap
  anywhere. So prev is either the same object as view — every delta empty — or does not exist, and
  NO impact/itemUse/itemPickup/boost/spinOut/lapCross/countdownBeep/finish cue can ever fire in
  the shipped game. It stays green because §8.1's cue assertion hand-builds two views with the
  test-only makeRaceView: the unit test passes and the shell cannot reproduce its precondition.
  RULED: two RaceViews allocated at session construction, alternated per frame, swap AFTER
  audio.apply (cues are consumed in the frame they are raised). Both primed at construction, or
  frame 1 compares against a zeroed view and fires a burst of spurious cues on the grid. The test
  must drive the REAL per-frame path — a test using makeRaceView cannot detect this, which is
  exactly how it reached a locked contract. Sent to the three live task authors mid-flight.

Ruling P2-R19 (GAP-3 — no demotion path; scheduled into Task 15c). ShadowLoop.promote() flips
  ctx.isLeader and starts broadcasting, but AuthorityLoop handles ONLY kind === 'input' and has no
  demote, no stop, and no authorityChange handler. So a host merely unreachable for 1.5 s (a
  backgrounded tab, a tunnel hiccup) resumes broadcasting authoritative snapshots and events on
  the same channels as the promoted shadow, with its own nextEventSeq — and every client still
  holding the WebRTC channel reconciles alternately against TWO DIVERGENT AUTHORITIES.
  RULED: authority never returns to the old host. AuthorityLoop handles authorityChange it did not
  itself send by demoting — stop broadcasting snapshots and events, stop emitting. Plan 4's
  session then swaps it for a ClientLoop. Minimal, and it makes the policy question moot rather
  than answering it: there is exactly one authority at every instant.
Task 16: review verdict NEEDS FIXES (opus). Everything the brief and spec §8 demand is correct —
  both rulings landed, and the reviewer verified "no event is applied twice" by an INVARIANT
  rather than a test (applyEvent's monotone rule alone forces it), then constructed the real
  collision from the running loop: host seqs 12,13 lost in flight, shadow promoted, shadow emits
  seq 12. All 3 order-preserving interleavings apply exactly 2 of 3 and drop exactly 1. Nine
  mutations run, all six reported ones reproducing with the EXACT quoted failure strings.
  It also confirmed all three brief defects AND a fourth the implementer found: the 300-tick
  window was vacuous anyway, because a correct leader on that fixture first emits at tick 227 and
  first ROLLS at tick 837 — so `rngCursor === 0` at 300 ticks is a value a correct leader also
  reports. The 900-tick rewrite with a control leader is a real fix.
  Sharpened residual on P2-R17: at eventSeq granularity the clause holds, but at EFFECT
  granularity one real event is lost per collision. Most self-heal because the next WireSnapshot
  carries item/spinOutTicks/lap/shielded as truth — but `finish` does NOT: finishedOrder and
  finishTick appear in no WireKart field, so a lost finish across the handover NEVER repairs.
  That is the case that justifies the max(own, snap.eventSeq) floor.

Task 16 BLOCKER -> Task 15b item H. The stale-snapshot ordering guard ShadowLoop added on its own
  initiative is defeated by aliasing: shadow.ts:274-282 decodes into snapshotScratch
  UNCONDITIONALLY, before testing tick > lastSnapshotTick, and pendingSnapshot references that
  same scratch. So when two snapshots land in one inter-tick window the loop reconciles against
  the snapshot the guard JUST REJECTED. Not exotic — it is the exact reorder the guard's own
  comment describes, at a 3-tick cadence with 50ms jitter, i.e. the normal case. Proven: with
  lastSnapshotTick=18, delivering tick 20 then tick 15 leaves the kart at grid-4.99 instead of
  grid+5. The shipped test passes ONLY because it delivers its two snapshots in separate windows —
  the EIGHTEENTH vacuous test, and a guard whose test cannot detect the guard failing.

Ruling P2-R20 — MY item G INSTRUCTION WAS INSUFFICIENT AND I CORRECTED IT MID-FLIGHT. I told the
  implementer to wrap the decodes in try/catch. That closes the throwing cases and MISSES THE
  WORSE ONE: a truncated snapshot does not throw at all. BitReader.readBits reads this.buf[byteIdx]
  past the end, `undefined >> n` is 0, so a half-frame decodes to a well-formed ALL-ZEROS WORLD and
  the shadow snaps onto it (kart0.x = -1024 one tick later). A half-delivered frame is not an error
  today, it is a valid-looking snapshot placing every kart at the corner of the world — silently.
  RULED: fix it in BitReader, not the three call sites. readBits must REJECT a read past the end of
  its buffer instead of returning zeros. That closes it for every codec present and future and
  converts a silent corruption into exactly the catchable failure item G already handles. A
  per-call-site length check works too but must be repeated forever, and the next codec forgets.

Ruling P2-R21 (item G/H ORDERING — found by the T16 reviewer building both fixes in scratch).
  The BitReader throw fires MID-DECODE, leaving snapshotScratch half-overwritten by the rejected
  frame — and via H's aliasing, pendingSnapshot may still point at that same object from an
  earlier ACCEPTED frame. So G alone drops the bad frame and then reconciles against its wreckage.
  Measured: accept a good snapshot (kart0 at grid+5), then deliver a DIFFERENT truncated frame
  (kart0 at grid-40) in the same window -> kart0.x - grid = -39.988.
  G alone turns a silent 1024m teleport into a silent 40m one AND adds a counted drop that makes
  it LOOK HANDLED — the worse outcome, because now there is a metric saying the guard worked.
  RULED: H lands before G. With H's buffer split, a frame rejected by tick and a frame rejected by
  truncation are equally incapable of reaching reconcile.
  BitReader fix verified safe repo-wide: full suite 671+1 unchanged, zero other edits. No codec
  relies on over-reading, and BitWriter.byteLength() rounds up to a whole byte.

Ruling P2-R22 (item H WIDENS — and this half is a LIVE BUG, not a hazard created by G).
  shadow.ts:283-290 has the identical aliasing on the CHECKPOINT path: one checkpointScratch and a
  bare `pendingCheckpoint` boolean, so an accepted checkpoint and a dropped truncated one write the
  same object. Measured: tick = 9001 (want 501), kart0.x = -247.75 (want -167.75) — a tick the host
  NEVER REACHED and a kart 80m from where either checkpoint put it. Worse than the snapshot case
  because a checkpoint replaces the WHOLE state, and reachable TODAY without the BitReader fix,
  because decodeCheckpoint throws from DataView.getFloat64 rather than returning zeros.
  Full audit of the four onMessage decode paths: snapshot and checkpoint need the split; `input`
  is safe (commit into heldInput happens after decodeInput returns) and `events` is safe
  (decodeEvents pushes freshly allocated objects, so queued events are distinct).
  RULED: "every buffered decode target gets a distinct pending buffer, committed only after the
  decode returns." Reference swap between two pre-allocated buffers, not a copy — stays
  allocation-free.
  Test rule for both: truncate a frame whose EARLY fields DIFFER, and assert on `tick` for the
  checkpoint (9001 vs 501 is unmistakable; a position delta could be argued away). Truncating the
  SAME good frame passes trivially — a prefix of identical bytes decodes to identical values. The
  reviewer hit that trap on its first probe and backed out of it.

CONTROLLER ERROR: I sent items G and H to the Task 16 REVIEWER rather than the Task 15b
  implementer, three messages running. The reviewer verified them read-only anyway (which is how
  the ordering hazard and the checkpoint path were found at all), and said plainly each time that
  it holds no part of 15b. Corrected by re-sending the consolidated G+H to ae6b7747d0b438542.
  Check the agent id against what the DISPATCH returned, not against whichever agent last spoke.
Task 15b: complete (40ba73b..a975a92), all eight items A-H. 704 passed + 1 skipped, typecheck clean.
Task 15b: review APPROVED (opus). The reviewer reproduced all three ledger corruptions from RUNNING
  code rather than quoting them: checkpoint 9001 vs 501, snapshot -4.9876, truncated-frame -39.988.
  It ran 13 mutations (12 caught) plus 2 hand-written probes plus 2 pre-fix reverts, and built its
  own aliasing probe for the pooled ring — a 900-tick race at 40ms/20ms/5% with 206 corrections and
  ~7 full wraps of the 128-entry ring, fingerprinted against a no-reuse reference build. BIT-
  IDENTICAL, so the pool aliases nothing a replay reads.
  It also confirmed the G test avoids the truncation trap deliberately (different frame, different
  early fields, assertion on the ACCEPTED frame's value) and that the loop-state assertion bites
  INDEPENDENTLY of the drop counter — which was the specific worry.
  Ruling P2-R17 deviation ACCEPTED and independently verified: applying the eventSeq floor
  continuously really does break the shipped 900-tick §1b test (`nextEventSeq moved on tick 227`),
  so holding the floor beside the state and raising at promotion was forced, not chosen. The floor
  is a private loop field, invisible to statesEqual — which matters because Task 16's promotion
  test compares states.
Task 15b -> 15c: three findings handed forward.
  (Important) The ClientLoop malformed test contains NO truncated frame — only header garbage — so
    it cannot detect the silent half of the very failure item G exists for. Proven: with the
    BitReader bound removed the ShadowLoop test fails and the ClientLoop test still passes. The code
    is correct; this is test debt on the loop that renders a race for a human.
  (Minor) The new `decoded.tick > pendingTick` clause has NO test — removing it leaves all 216
    tests passing. The H1 test establishes a floor at tick 18 so the stale frame is rejectable by
    lastSnapshotTick, which means it exercises the OLD guard, not the new clause.
  (Minor) withLocalInput imposes no cadence and 15b's test submits EVERY tick, so a host gets 60Hz
    input granularity against every guest's 30Hz. Item B exists so the host does not "drive a
    measurably different car" — quantisation parity was achieved and measured, TEMPORAL parity was
    not.
Noted for Plan 3 (no action in Plan 2): RemoteInterpolator.push silently drops the second of two
  snapshots arriving in one client tick, because recvAtMs is predicted.tick * TICK_MS and push
  rejects recvAtMs <= the newest. Pre-existing from Task 15; RemoteSample.kart now inherits it, so
  "newest" can be one snapshot stale exactly when jitter bunches frames.
Task 15c: complete (a975a92..4b809e9) — all seven items A-G plus the three findings carried forward
  from 15b's review. 741 passed + 1 skipped (from 704+1), typecheck clean, one commit. Three items
  proved by temporarily reverting the mechanism (C, the ShadowLoop half of A, and finding 2).

Ruling P2-R23 — I RULED "178 -> 180 bits" AND THE IMPLEMENTER WAS RIGHT TO REFUSE IT. `phase` lives
  on SimState, not KartState, and spec §5's per-kart table states as its invariant that it projects
  KartState alone. So phase goes in the HEADER: 200 -> 202 bits, per-kart unchanged at 178, worst
  case 743 -> 744 B. Encoding it per kart would ship eight copies of one global value and produce a
  wire format capable of expressing eight karts that disagree about whether the race has started.
  Spec §5 amended to match (202-bit header, ~305 B typical / ~744 B worst, with the reasoning).
  This is the second time an implementer has improved on a controller ruling by reading the spec's
  own invariant more carefully than I did.

TWENTY-FIRST vacuous test, found by the implementer IN SHIPPED CODE THAT HAD ALREADY PASSED A
  REVIEW: the snapshot bit-count assertion was not sensitive — it passed with 2 bits added. The
  whole point of that assertion is to fail when a field is added without updating the total, and it
  could not. Replaced with a sweep over nine entity counts plus a byte-boundary control, verified to
  catch a single added bit.
  Worth recording as a pattern: bit-count assertions that check `bytes === Math.ceil(bits/8)` are
  insensitive to any change smaller than a byte, which is exactly the change they exist to catch.

Task 15c concerns carried into review: ShadowLoop.tick(nowMs) changes a locked contract signature
  (contract amended in place); a guest joining an already-racing authority carries a bot field
  offset from the host's (pre-existing shape, now reachable via late join, nothing renders from it);
  MAX_CATCHUP_TICKS = 5 is chosen, not derived from any spec text.
Task 17: dispatched (integration tests + golden run). Its brief predates 15b/15c, so it was told
  shipped code wins over the brief and to report every stale point.
Task 15c: review verdict NEEDS FIXES (opus). All seven items and all three carried-forward findings
  landed as described; 15 of 17 planted mutations caught. Item A verified: phase is in the header,
  nothing per-kart carries it, the per-kart table's printed invariant is intact, and the spec's
  arithmetic checks out (202+1424+810 = 2436 bits = 305 B; 202+1424+4320 = 5946 = 744 B).
  The replacement bit-count sweep was verified sensitive to ONE bit by adding a bit properly (write
  AND read, so round-trips still pass and only a size assertion can see it): "2 entities: encoded
  size disagrees with 1896 bits: expected 238 to be 237". The byte-boundary control is real, not
  decorative — 1626 mod 8 = 2 and 135 mod 8 = 7, so n=2 lands on exactly 1896 bits.
  Confirmed WHY the old assertion was blind: it rounded to bytes once, so any sub-byte change is
  invisible seven times in eight.

Task 15c BLOCKER -> fix round. Phase adoption ignores snap.tick, so at the plan's OWN DEFAULT
  LATENCY the guest falls back into 'countdown' for three ticks just after the lights go out — and
  is frozen on those ticks while the host accelerates. A snapshot in flight is ~9 ticks old at
  150ms; resolveInputs runs FIRST in step() and updatePhase LAST, so an adopted stale 'countdown'
  discards every input on the next tick before local inference flips it back.
  Measured: as-shipped racing,countdown,racing,racing,countdown,... — 3 flickers, 1 correction. A
  variant refusing phase regression: 0 flickers, 0 corrections.
  This is the MIRROR of the defect item A exists to remove, and no test exercises the phase
  transition at realistic latency. One line to fix (refuse a regression, or re-apply the local
  tick >= COUNTDOWN_TICKS rule right after adopting) plus a test at 150ms across the boundary.
  Task 17 warned mid-flight NOT to bake the flicker into its golden fixture.
Task 15c minors for the fix round: two new phase writes untested (reconcile's resyncBase.phase and
  hardResync's predicted.phase — deleting either leaves all 143 net tests green, and the reconcile
  one is load-bearing because the ring banks its entry BEFORE phase adoption); the Plan 2 contract
  §4 still says a 200-bit header while §3 of the same document says phase is in the header; three
  stale comments cite 743 B / 200 bits; the fourth unused phase code decodes to `undefined` and
  reaches SimState, where updatePhase returns early so the race can never reach 'finished'.
For Plan 4's brief: demotion is unauthenticated and irreversible — two bytes on the reliable
  channel with tag 0x20 from any peer permanently stops a host broadcasting. It degrades gracefully
  where a shadow exists and kills the room where one does not. Now the most damaging unauthenticated
  message in the protocol.
Measured, for MAX_CATCHUP_TICKS: AuthorityLoop.tick() is 0.53 ms on this machine, so a five-tick
  burst is ~2.7 ms against a 16.7 ms frame — ~6x margin. Directionally sound, but the margin shrinks
  on a mid-range phone also running a 3D render, so "chosen, not derived" is the right label.
Task 17: complete (4b809e9..e9d41ec) — integration tests + golden run. 762 passed + 2 skipped
  (from 741+1): convergence 3, promotion 2, late join 3, golden 12 + 1 opt-in regenerator. Ten
  mutations applied to src, measured, reverted, all ten caught. Review running.
  It honoured the mid-flight phase warning: every run starts in 'racing' and never crosses the
  start line, so the 35 KB golden fixture will NOT need regenerating after the 15c fix, and no
  asserted number depends on it. No client.ts edit.
  Four stale-brief calls, all reported: HOST_TIMEOUT_TICKS/ShadowLoop.tick() gone; the brief's
  second promotion test dropped (duplicates apply.test.ts AND does not compile — `CHARS`
  undefined); PRE_KILL_TICKS 300 -> 900, because the leader first emits at 227 and a 300-tick
  window is one a CORRECT leader also passes silently; and a test-only three-party mesh fixture
  replacing the one-pair topology so a real ClientLoop runs beside a real ShadowLoop with no src
  change.

Ruling P2-R24 (Task 17's finding, and it breaks a Plan 3 ruling — scheduled into the 15c fix round
  as item D). ONLY EVERY OTHER 60Hz GUEST INTENT REACHES THE WIRE. Found because a single-tick
  golden perturbation changed NOTHING: a one-tick input spike is invisible to the authority.
  This is a defect rather than a curiosity because Plan 3 ruled that useItem is a ONE-TICK PULSE
  emitted on press — precisely so a held button cannot auto-fire the next item the instant it is
  granted. With odd-tick intents dropped, HALF OF ALL ITEM USES ARE SILENTLY LOST, and the player
  has no way to tell which half.
  RULED: the send path OR-s the boolean fields across the ticks it drops — brake, drift and useItem
  are latched, set by EITHER tick of the pair, cleared once sent. steer and accel are continuous
  and keep taking the newest value. Fixed in the client's send path and in
  withLocalInput.submitLocalInput (same parity rule, so a host must not lose presses either) —
  NOT in Plan 3's adapters, because the wire cadence is net's business and an adapter that had to
  know about it would be a second place to get this wrong.
  *Cost if wrong:* a latch that fails to clear repeats a pulse, which is the opposite defect.
Task 17 finding for Plan 4: a late joiner settles PERMANENTLY ~12 ticks behind the authority's tick
  number. Harmless for a guest, but it would be a 200ms rewind if a shadow ever joined late.
Task 17 concern: the golden fixture is a committed 35 KB whole-stack expectation, so deliberate
  netcode changes now need UPDATE_GOLDEN=1 and a human reading the diff. That is the intended cost.
  Suite wall time 7.5s -> 9.2s.
Task 17: review APPROVED (opus), no Critical and no Important — the first task in this plan with
  neither. The reviewer re-derived the mirrored harness against client.ts rather than trusting the
  comment and confirmed the only transform between the two sides is encodeSnapshot/decodeSnapshot,
  so the isolation of quantisation is genuine. It measured the <=30 bound's STABILITY by varying
  transport seeds rather than trusting one run: [16,16,14,14,16,14,14,14] across eight seed triples,
  so 30 is ~2x a quantity whose real spread is 14-16 — will not flake, and the two regressions it
  exists to catch land at 107 and 1022.
  It verified the golden compares FIELDS not a hash by mutating ShadowLoop.diverges to false:
  86 named fields with path, both values, delta and tolerance. And it traced all 1200 ticks of the
  golden replay to confirm exactly ONE phase transition, countdown->racing at tick 14, in the
  correct direction — so the 15c defect is structurally unreachable in the fixture and the bug is
  not baked in.
Task 17 minors (folded into the 15c fix round): GOLDEN_NET_REGEN_COMMAND names a file that cannot
  regenerate (the reviewer ran it: md5 unchanged, nothing written — and it is the one instruction a
  stuck maintainer will follow); "first emit at 227" is not reproducible (measured 58 on promotion's
  own fixture, 46 on the golden's) and the number sits in a code comment; the clause-4 heading
  overstates (it proves no event is DELIVERED twice — idempotence is covered in apply.test.ts and
  shadow.test.ts, verified by mutation); and the golden is a CHANGE-DETECTOR, not a correctness
  oracle — a fixture regenerated from a raw-analog-prediction build passes all 12 golden tests,
  moving corrections only 308 -> 309.

Ruling P2-R25 (scope of P2-R24 — the analog half is DECLINED, on measurement). T17's reviewer is
  right that the finding is understated: the guest predicts on all 60 intents while transmitting 30,
  so on every unsent tick it simulates an input the authority will never apply — the temporal half
  of the family throughWire() fixed for quantisation.
  DECLINED anyway, because it has already been measured: Task 15's reviewer implemented exactly that
  fix (predict on the intent the authority is actually holding) and it changed NOTHING — 30 vs 40
  corrections under varying input. Under real jitter, which intent is newest at authority-tick T is
  a fact about packet delivery no client can predict, so removing the sampling mismatch does not
  remove the corrections. Predicting on the last-sent intent costs up to 16ms of local input lag on
  a touchscreen racer, which is precisely what P2-R13 already declined to pay.
  The booleans are different in kind, which is why P2-R24 stands: a dropped useItem pulse is not a
  small correction, it is AN ACTION THE PLAYER TOOK THAT NEVER HAPPENED, and no amount of
  reconciliation recovers it. A comment at the latch records the analog half as known, measured and
  deliberately unfixed, so the next reader does not "complete" the fix and buy 16ms of lag.
For Plan 4 (from T17's reviewer, stronger than the report stated): a shadow introduced mid-race
  without a checkpoint settles ~12 ticks behind PERMANENTLY, and if it then promoted it would
  broadcast snapshots with tick numbers BELOW the last the host sent — ClientLoop's
  `decodeTarget.tick > highestSeenSnapshotTick` filter would discard ~4 snapshots and the first
  accepted one would rewind the guest's world by ~12 ticks of travel. That is spec §5's "no kart
  teleports backward". CONSTRAINT: the shadow must never be introduced mid-race without a
  checkpoint. Unreachable today because Plan 4 starts the shadow with the room at tick 0.
Task 15c fix round: complete (e9d41ec..3d43533), 12 files, +780/-38. 771 passed + 2 skipped.
  All five items plus T17's defect D plus the four review fixes and the item-D scope ruling.
  Every item verified failing-first AND mutation-verified against the FINAL code: A -> flickers at
  [181, 184, 187]; B -> velocity 0 vs >2 and 'racing' vs 'countdown', one failing test each;
  C -> no throw / dropped 0; D -> `firedAt -1` on BOTH send paths.
  GOLDEN FIXTURE REPRODUCES MD5-IDENTICAL through a fresh whole-stack recording — only the
  `generatedBy` string changed. That is the strongest possible statement that these fixes altered
  nothing they were not meant to.
  Decisions: A -> refuse a phase REGRESSION rather than re-applying the local COUNTDOWN_TICKS rule,
  which covers all three transitions and keeps phase.ts the sole owner of COUNTDOWN_TICKS, with
  hardResync the one documented exception. C -> REJECT via the drop guard rather than clamp,
  because clamping manufactures an authoritative fact from two known-bad bits, silently — which is
  exactly how the original hole survived.

Ruling P2-R26 (fix round's concern 1 — a DEFECT CLASS, not one defect; scheduled into Task 18).
  `item` (4 bits, 9 valid values, 7 unused codes) and entity `kind` (4 bits, 6 valid, 10 unused)
  have the IDENTICAL latent hole that `phase` had: an unused code decodes to `undefined` and
  reaches a field the simulation reads. `phase`'s version made the race unable to ever reach
  'finished'. RULED: close them the same way — reject through the drop guard, count it, never
  clamp — and AUDIT every other enum decoded from a fixed-width field (surface, driftDir,
  MessageKind, anything else), reporting each field's valid-code count so the audit is checkable
  rather than asserted.
  Worth recording as a pattern: every fixed-width enum whose value count is not a power of two has
  this hole by construction, and the decoder cannot see it because `ARRAY[code]` returning
  undefined is not an error in JavaScript.
Task 15c fix round concern 3: a useItem press is now one of the few inputs that reliably costs one
  small correction — predicted locally on press, applied by the authority 1-2 ticks later. That is
  the correct trade (spec §5 already says the local kart's hit reaction plays on receipt, not on
  prediction) and it is the price of the pulse never being lost.
Task 18: dispatched (barrels + the enum-hole audit). Its brief predates 15b/15c/17/fix, so it was
  told shipped code wins and to enumerate the real surface from source rather than trust any list.
Task 15c fix round: re-review clean — ALL FINDINGS ADDRESSED. The re-reviewer did not accept the
  md5 claim: it copied the worktree to a scratch path, ran the regenerator, diffed against the
  tracked fixture (empty) and matched md5s (b0e5ea675c2caeb04cb26e69e54821ce). It also checked the
  "latch cannot touch the golden" REASONING rather than the claim, by reading the recorder: on even
  ticks it recomputes `held` from botIntent, on odd ticks it reuses the same object unchanged, and
  quantizeIntent passes booleans through verbatim — so both ticks of every pair already carried
  identical booleans and OR-ing identical values is a no-op. The reasoning holds.
  Every reported mutation reproduced with its exact failure string, including the unconditional-
  adoption revert giving `expected [ 181, 184, 187 ] to deeply equal []`.
  Confirmed SURFACE_BITS = 2 for exactly 4 Surface values is SAFE — a power-of-two enum has no
  unused codes by construction. That is the exception; every non-power-of-two fixed-width enum has
  the hole.
Task 18 (enum audit) gained one more site from the re-review, passed on mid-flight:
  packages/protocol/src/checkpoint.ts:126 — `dst.phase = PHASE_ORDER[f()]!` — a NON-NULL-ASSERTED
  unguarded phase decode in the AuthorityCheckpoint codec. The `!` actively suppresses the type
  system's one chance to flag an array index that provably can be undefined, on bytes from a
  socket. It matters MORE than the snapshot version: a checkpoint REPLACES THE ENTIRE STATE, so a
  corrupt phase there is not a field that self-heals on the next snapshot — it is the baseline
  every subsequent tick builds on. And checkpoints are used at exactly the three moments things are
  already going wrong: late join, a client diverged past recovery, and shadow resync after a
  partition. Task 18 also told to grep for other non-null assertions on wire-byte array indexing
  across protocol, since `!` on a lookup from wire bytes is the greppable signature of this class.
Task 18: complete (3d43533..351e754) — barrels + the enum-hole audit. 805 passed + 2 skipped
  (from 771+2, +34), typecheck clean. Golden green and NEVER regenerated (git diff on the fixture
  empty). PLAN 2'S LAST TASK.
  Part 1: neither barrel needed widening — both already listed every module. The value added was
  the PIN: toEqual on sorted Object.keys, declared PER MODULE so a name MOVING between modules is
  caught, via relative path AND bare specifier, plus a compile-time Record<keyof T, true> for the
  18 type-only exports. Proven non-vacuous by 4 mutations including the silent add-and-remove that
  a count-based test misses. All 34 exports of all 5 net fixture modules asserted absent — the
  brief named 2.
  Part 2: 14 enum decode sites audited, NINE HOLES CLOSED, 2 confirmed safe (surface 4/4, event
  kind 8/8 — power-of-two, so a guard there is unreachable), 1 already closed (MessageKind).
  Counts recorded so the audit is checkable: snapshot item 9/16, entity kind 6/16, drift 3/4;
  events item 9/16; checkpoint phase/item/surface/kind/drift.dir all float64. The `!` grep found
  exactly 6 sites, all in those two files, all gone; packages/net/src has zero.
  Stale-brief points: module counts 7/6 -> 8/9; HOST_TIMEOUT_TICKS=90 -> HOST_TIMEOUT_MS=1500;
  ShadowLoop.tick() takes nowMs; WIRE_TAG has 13 entries not 5; function counts 14/7 -> 26/27. And
  four names in MY OWN dispatch hint list (sampleEntity, liveEntityIds, submitLocalInput,
  promotionCursor) are methods or sim's export, not barrel names — a controller error, caught.

Task 18 concerns -> whole-branch review: decodeEvents and decodeCheckpoint leave their `out`
  argument PARTIALLY WRITTEN when they throw. Safe today only because every caller decodes into
  scratch and commits after — an invariant held by CALLERS, not by the codec, and Plan 4 adds new
  callers. This is the same shape as ruling P2-R22's aliasing defect, which cost a real bug. The
  final review rules on whether a documented invariant plus a per-call-site test is enough, or
  whether the codecs must not corrupt `out` at all.
FINAL: whole-branch review dispatched (25 commits, 81 files, +17,747/-301) alongside T18's task
  review. Next: rule the final findings, squash, merge to master.
Task 18: review APPROVED. The reviewer independently re-ran the `!`-grep against the BASE commit
  and got exactly the six claimed sites at the exact claimed line numbers (checkpoint.ts:126,146,
  148,161 and events.ts:55,58, plus an `as -1|0|1` cast at checkpoint.ts:144), then confirmed zero
  postfix `!` in both source trees after the diff. It spot-checked both "safe" calls against the
  source types — Surface is exactly 4 values against SURFACE_BITS 2, AuthEventKind exactly 8
  against KIND_BITS 3 — because a wrong "safe" is worse than a missed hole: it closes the question.
  It also verified the checkpoint float64 claim by reading the codec, which matters because it
  changes the failure mode: a float64 field faces the whole double space, with none of the natural
  ceiling a 4-bit field has.
  It ran the silent add-and-remove mutation ITSELF rather than trusting the report's table —
  renaming quantStep -> quantStepSneaky (same module, same export count) failed 4 of 9 protocol
  barrel tests, and isDemoted -> isDemotedSneaky failed 3 of 10 net ones. A count-based test
  survives both.
Task 18 IMPORTANT (folded into the final fix pass, not a separate round): only `phase` of
  checkpoint's FIVE enum fields got the loop-level three-clause test (drop+count, no state moved, a
  valid datagram after it still processed). item, surface, entity kind and drift.dir are proven
  only to THROW at the codec level. Architecturally low-risk — the guard wraps the entire
  decodeCheckpoint call uniformly and the scratch-then-swap is field-position-independent, both
  verified — but it is a real gap against "for each closed hole", and the report does not disclose
  it as a limitation the way it discloses its other three concerns. Three cheap assertions.
Task 18 minors: the report says "34 fixture exports across 5 modules"; measured 25 runtime names
  (30 with types). The test is not hardcoded to any count — it enumerates Object.keys per module
  and asserts each absent, with a per-module non-empty floor — so only the prose is wrong. And the
  report's mutation table contains no literal same-count add-and-remove, so its "proven by four
  mutations including exactly that case" overstates what was actually run.

=== WHOLE-BRANCH REVIEW (25 commits, 81 files, +17,747/-301) — READY TO MERGE: YES, after the
=== final fix pass. No Critical. Four Important, all at seams a per-task gate structurally could
=== not see. 17 of 17 targeted mutations caught against the load-bearing invariants.

Verified coherent: the full send/receive matrix (every send has a receiver, every ignored tag is
  deliberately ignored with a comment); nextEventSeq cannot legitimately diverge across all six
  paths; every buffer derivation tracks the 202-bit header with no stale figures left in src or
  test; zero wall-clock/Math.random/module-scope-mutable anywhere (the four new module-scope
  bindings are all WeakMap/WeakSet keyed on the instance, so two loops in one process cannot reach
  each other's entry — the Plan 1 violation is genuinely the only one and it is gone).
  The 2 skipped tests are the two UPDATE_GOLDEN regenerators, and each has a NOT-skipped companion
  asserting regeneration throws under CI. Correct, and the count is fully explained.

Ruling P2-R27 (Important 1 — the worst finding of the branch). UNBOUNDED 32-BIT WIRE CURSORS WEDGE
  A PEER PERMANENTLY, and nothing counts it. The enum holes were closed because those bytes come
  off a public socket; the counters beside them were not, and their failure mode is STRICTLY WORSE
  — the enum holes were per-datagram and self-healing, these are permanent with no repair path.
  Measured: one events datagram with eventSeq = 2^32-1 discards every subsequent legitimate event
  FOREVER; one snapshot with tick = 2^32-1 leaves 60 later snapshots producing 0 corrections and 0
  keyframes (a guest frozen with a dead render feed); one input with baseTick ~ 2^32 pins a seat on
  the poisoned intent forever. dropped = 0 in all three.
  RULED: reject a cursor that jumps implausibly far ahead of the receiver's, count it as a drop,
  derive the bound from the protocol's own rates. NOT clamp — a clamped cursor is still a wrong
  authoritative fact, which is the reasoning that made rejection right for the enums.
  Note the ledger recorded exactly ONE member of this family (unauthenticated demotion) and called
  it "the most damaging unauthenticated message in the protocol". That was demonstrably incomplete.

Ruling P2-R28 (Important 2 — a comment that lied through two reviews). encodeSnapshot's four
  indexOf lookups are unguarded and writeBits(-1, n) writes all-ones. Adding a fifth Surface leaves
  ALL 805 TESTS GREEN AND TYPECHECK CLEAN, and every kart carrying it silently encodes as
  'offtrack' — a WRONG-BUT-VALID AUTHORITATIVE FACT, exactly what snapshot.ts's own DRIFT_CODES
  comment argues is no better than undefined. THREE separate places assert this cannot happen and
  all three are false, because both the codec's table and the test's are hand-written literals with
  no binding to the union.
  RULED: guard all four lookups AND bind each wire table to its union with a compile-time
  exhaustiveness check, so the comments become true rather than aspirational.

Ruling P2-R29 (Important 3 — fix now, while it is free). sampleKart/sampleEntity allocate two
  objects per call on the per-frame API Plan 3 is about to build a renderer on: ~4,700 objects/s,
  half the churn that was ruled a contract violation rather than a preference. The inconsistency is
  INSIDE ONE CLASS — liveEntityIds(out) takes a caller-owned buffer with the docstring "for the
  same reason every other buffer in this package is: a renderer calls this every frame", added in
  the same task. RULED: out-parameter form for both, returning boolean. Plan 3 is authored but not
  executed, so amending it is a targeted edit pass; after it ships this is a breaking change to a
  locked contract. ClientLoop.onDatagram's ~55 KB/s is measured, defensible and KEPT, with a
  comment so the next reader knows it was measured rather than missed.

Ruling P2-R30 (Important 4). ShadowLoop is the only loop that does not validate the channel, and it
  is the one that accepts `checkpoint`. Verified: a snapshot delivered on 'reliable' hard-snapped a
  shadow from tick 1 to 501. AuthorityLoop refuses authorityChange off the unreliable path because
  "standing down is irreversible" — that reasoning applies at least as strongly to a message that
  REPLACES THE ENTIRE STATE. Gate every kind on its channel.

Ruling P2-R31 (the `out`-argument decision, taking the reviewer's own analysis). decodeEvents is
  fixed AT THE CODEC (commit on success — one temporary array on a path that already allocates per
  event). decodeCheckpoint instead HOISTS AN EXACT-LENGTH CHECK TO THE TOP, because not corrupting
  dst at all would need a second full SimState of scratch; the encoded size is a pure function of
  dst's shape, so the check eliminates the TRUNCATION case — the reachable one, the one that
  produced tick = 9001 — before a byte is written, and subsumes the existing boxCount check which
  today fires only after everything ahead of it is already overwritten. Both invariants go in the
  CODEC's docstring, not shadow.ts's comment where the next caller will never read it.
  This follows P2-R20's precedent, which explicitly rejected the per-call-site alternative.
FINAL FIX PASS: dispatched (A-G). Then squash and merge.
FINAL FIX PASS: complete (351e754..b613c3a), items A-H, 19 files. 845 passed + 2 skipped (from
  805+2), typecheck clean. Golden GREEN AND BYTE-IDENTICAL, never regenerated — item C touches
  nothing on the golden path. Failing-first evidence per item (A: 10 tests fail with the guard
  stubbed; B: 4; C: 3; D: 4; E: 5; F: 4; G: 1; H: 1).
  Cursor bound, derived not chosen: MAX_CURSOR_ADVANCE_TICKS = ceil(HOST_TIMEOUT_MS/TICK_MS) +
  2*ceil(200/TICK_MS) = 90 + 24 = 114 (38 lost snapshots at 20Hz / 57 lost inputs at 30Hz);
  MAX_WIRE_TICK = 65534 (the 16-bit lastProcessedInputTick); MAX_CURSOR_ADVANCE_EVENTS = 114*320 =
  32640. ONE TRANSIT WAS NOT ENOUGH — the promotion handover legitimately jumps ~93-105, so a
  tighter bound would have rejected a legal promotion, which is worse than the defect it fixes.

CONTROLLER ERROR, caught by the implementer — Ruling P2-R32 REVERSES my item G.1. I relayed the
  whole-branch review's claim that shadow.test.ts:281's "first emit at tick 227" was unreproducible
  and the real figure was 58. The implementer MEASURED IT TWICE and refused: shadow.test.ts's
  fixture really does emit first at 227, and 58 is promotion.test.ts's figure — a DIFFERENT SEED
  with a racing start — where it is already correct. The reviewer had conflated two fixtures, and I
  passed that on without checking. Resolution kept 227 and made BOTH figures assertions rather than
  comments, so neither can rot again.
  Worth recording: this is the second time an implementer has been right to refuse an instruction
  from me, and both times the refusal came with a measurement rather than an argument.
Final fix pass concerns: (1) cursors are anchored on THEMSELVES, not on each loop's tick counter —
  the latter measured 181 good datagrams dropped against a host that stopped ticking, which
  shadow.ts's own HOST_TIMEOUT comment predicts; input cursors take max(cursor, own tick).
  (2) Three residuals remain where "the first authoritative datagram cannot be checked against
  anything" — now BOUNDED (65534 / 32640) rather than unbounded, plus checkpoint.tick, deliberately
  unbounded because a checkpoint IS the rebase. Plan 4's authenticated sender is the only sound
  closure, and a client stalled past ~1.9 s still needs a checkpoint path ClientLoop lacks.
  (3) Two barrel exports the brief did not specify — makeRemoteSample / makeRemoteEntitySample,
  unavoidable for the out-param form; now in the Plan 3 amendment.

=== POST-MERGE HARDENING (2026-08-20, after Plans 4-5 merged at 5d3297e) ===

Ruling P3-R63 (C-6 closed). compose.yaml was never checked against ENV_SCHEMA, and nothing in the
  repo referenced it. That is worse than ordinary drift because parseConfig THROWS on an unknown
  TAPKART_* variable: an undeclared name in compose does not misconfigure the server, it stops the
  container booting. The failure was found once by cross-reading two contract drafts, fixed, and
  left unguarded. Now four assertions, mutation-verified three ways (undeclared var fails the rule
  AND the boot check; a drifted default fails the block check; reversing the block's order fails it).

Ruling P3-R64 (a real defect, and a new instance of an old shape). DEFAULT_TRACK_THEME — the
  fallback EVERY unthemed track renders from — had road/ground only 0.083 apart in sqrt space,
  under the 0.10 floor all six shipped themes clear. A grey road on the same grey ground.
  It survived because **the legibility gate only ever inspected GENERATED content**: the fallback
  is hand-written in theme.ts, where the pipeline never looked. Same family as B2 (theme.ground
  gated but rendered by nothing) and P3-R62 (sky.top gated and unrendered) — a value checked in one
  place and consumed in another, with no path between the two.
  Fixed by darkening the fallback ground to [0.09, 0.11, 0.09] (0.206), not by loosening the rule,
  and the fallback is now required to re-parse through its own parser — a fallback its own
  validator would reject is a latent crash rather than a cosmetic flaw.

Ruling P3-R65 (cross-field constraints now bind at load, not only at generation). parseKartDescriptor
  and parseTrackTheme validated fields INDEPENDENTLY, so each accepted records that were
  individually in range and jointly nonsense — the same shape as glacier-pass's fold, where every
  field was legal and the combination folded the drivable surface. The legibility thresholds lived
  only in the delegation gate, which runs when content is GENERATED, never when it is LOADED.
  Moved into the parser so they bind every caller; the gate now calls the parser rather than
  restating the formula, keeping only the two roster-scope checks a per-record parser cannot see.
  Note the honest disclosure: `wheelWidth < chassisWidth / 2` is UNREACHABLE from in-range values
  (max wheelWidth 0.35 < min chassisWidth/2 = 0.45), so it is evaluated on any two finite numbers
  rather than gated behind the ranges — gated, it would be untestable code.
