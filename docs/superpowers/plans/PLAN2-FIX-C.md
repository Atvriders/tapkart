# Plan 2 Fix Pass — Territory C (Tasks 13–18)

Scope: `docs/superpowers/plans/parts/plan2-task-13-apply.md` …
`plan2-task-18-barrels.md`. Sources: `PLAN2-AUDIT-A.md` (no findings in this
territory), `PLAN2-AUDIT-B.md`, `PLAN2-AUDIT-C.md`, the locked contract
(`2026-08-14-tapkart-plan2-contract.md`) and spec §5/§8. Tasks 1–12 were not
touched.

Where a brief and the contract disagreed, the contract won. Where the contract
and the spec disagree, nothing was chosen — those are listed under *Left open*.

---

## Fix 1 — one wire header across the three loops

**Raised by:** Audit C blocking #3/#4 and rows 21–25; Audit B B4/B5.

**Was:** Task 16 defined `WIRE_TAG_INPUT = 4 … WIRE_TAG_AUTHORITY_CHANGE = 8`
inside `net/src/shadow.ts`, prefixed every message with one byte plus a private
version byte, and dispatched on `data[0]`. Tasks 14 and 15 sent **untagged**
payloads and blind-decoded every unreliable datagram (`AuthorityLoop` as input,
`ClientLoop` as a snapshot). Task 17's fixtures and Task 18's barrel test
asserted Task 16's private values. Host, client and shadow could not read each
other's traffic.

**Now:** all three loops use contract §3's `WIRE_TAG` / `encodeHeader` /
`decodeHeader` from `@tapkart/protocol`.

- Task 16: the five `WIRE_TAG_*` constants and `PROTOCOL_VERSION_BYTE` are
  deleted. `AUTHORITY_CHANGE_BYTES` stays 10 and is now written
  `HEADER_BYTES + 8`; `encodeAuthorityChange` calls `encodeHeader(out,
  'authorityChange')` and writes two `u32`s after it; `decodeAuthorityChange`
  reads from `HEADER_BYTES`. `onMessage` dispatches on `decodeHeader(data).kind`
  across four kinds.
- Task 14: `onMessage` decodes the header and returns unless `kind === 'input'`;
  snapshot and events broadcasts go out through `encodeHeader` first.
- Task 15: same on both sides — input is framed on send, and `onMessage`
  branches on `kind` (`'snapshot'` / `'events'`) instead of on the channel alone.
- Task 17: `scripted-input.ts` frames with `encodeHeader`; the convergence test
  counts snapshots with `decodeHeader(data).kind === 'snapshot'`; the promotion
  test observes `authorityChange` the same way.
- Task 18: the barrel tests assert protocol's `WIRE_TAG` values (`0x10`, `0x11`,
  `0x12`, `0x13`, `0x20`) and a real `encodeHeader`→`decodeHeader` round trip
  through the barrel; the net barrel test no longer asserts `[4,5,6,7,8]`.

Each of the three `net` modules declares a private `const HEADER_BYTES = 2` with
the contract citation. The contract fixes the width but exports no constant for
it, and importing one `net` module into another to share a `2` would create
coupling the module map does not have. Send paths use `encodeHeader`'s **return
value** as the payload offset, so only receive paths depend on the constant.

**New tests that fail if this is broken:**

- Task 14, *"ignores an unreliable datagram that is not an input message"*:
  broadcasts a `snapshot`-framed buffer at the host. If `onMessage` skipped the
  header check, `decodeInput` reads snapshot bytes as an intent and drives
  someone's kart — the test's `position.x`/`position.z` equality against the
  captured start position fails. If the sender omitted the header,
  `decodeHeader` throws inside the callback.
- Task 14, *"holds the newest known intent…"*: `taggedSnapshots > 0` fails if the
  authority broadcast an unframed snapshot, because `decodeHeader` would have
  thrown before the counter incremented.
- Task 15, *"sends a datagram every 2 ticks…"*: asserts
  `decodeHeader(data).kind === 'input'` per received message; an unframed send
  throws on an unknown tag byte.
- Task 16, *"prefixes the contract's shared header, so a receiver can dispatch
  on it"*: asserts `buf[0] === WIRE_TAG.authorityChange` and
  `decodeHeader(buf)` equals `{ kind: 'authorityChange', protocolVersion }`. A
  reintroduced private tag byte (4…8) fails both.
- Task 18, protocol barrel constants test: `WIRE_TAG.snapshot === 0x11` etc. and
  a header round trip. A barrel forwarding a stale copy fails here.

---

## Fix 2 — the seven tests that could not fail

Every test below is stated with the failure mode it now detects. Where a test's
assertion could not be made falsifiable without changing the *scenario* (an
empty entity set, a zero lap counter), the scenario was changed too — an
assertion over an empty set is a vacuous test wearing an assertion's clothes.

### 2a. Task 17 promotion, *"matches the host's last checkpoint within bounds"*

**Raised by:** Audit B B1; Audit C *Tests that cannot fail* #1. Spec §8 flagship.

**Was:** `expect(withinEps(hostAtKill.karts[0].position.x,
hostAtKill.karts[0].position.x, EPS_POSITION)).toBe(true)` — a value against
itself — plus `expect(shadowCtx).toBeDefined()`. Both true for every possible
implementation.

**Now:** the test captures **both** states at the same instant
(`hostAtMatch = structuredClone(host.state())`,
`shadowAtMatch = structuredClone(shadowState)`) and, after the run, compares
`shadowAtKill.karts[k]` against `hostAtKill.karts[k]` on both horizontal axes
for **all eight karts**, inside a stated `MATCH_BAND_M = 5.0`.

Two secondary repairs were needed to make that assertion mean something:

1. **The capture instant is selected on `shadowState.tick === host.state().tick`
   only** — never on position agreement. The original selected the instant *by*
   comparing kart 0's position within epsilon and then "asserted" that same
   comparison, which is circular even after the self-comparison is fixed.
2. **`lastMatchedTick` is asserted to equal `PRE_KILL_TICKS` exactly**, not
   `> 0`. Both loops advance one tick per call from the same start, so the
   same-tick condition holds every iteration; the exact equality is what turns a
   skipped or doubled step into a failure instead of a silently earlier capture.

**How it fails if the code is broken:** a `ShadowLoop` that never reconciled,
reconciled onto the wrong kart, or dropped every kart but seat 0 puts at least
one kart outside 5 m and the message names the kart and axis. A shadow that
never received the client's input leaves seat 0 on the grid while the host
drives ~100 m away. A companion assertion (`hostTravelled > 20`) fails if the
host never moved, so "both within 5 m" can never pass by comparing two frozen
grids.

**Why 5 m and not `EPS.position`:** the two loops are at the same tick number
but not the same instant of information — the shadow's state is the host's
snapshot from ~one one-way trip ago, corrected and replayed forward with input
that arrived on a different schedule. Contract §4's 0.05 m epsilon describes
the comparison the *reconciler* makes at `snap.tick`, which `ShadowLoop`'s own
tests assert. Asserting it here instead would make a correct implementation
flaky, which is how tolerances get widened until they stop meaning anything.

### 2b. Task 17 promotion, *"no entity disappears"*

**Raised by:** Audit B B2; Audit C #2. Spec §8 flagship.

**Was:** `for (const id of liveEntityIds) { /* comment only */ }` — an iteration
with no `expect` inside it, followed by `liveEntityIds.clear()`. And it would
have iterated an **empty set** in any case: `scriptedIntent` never sets
`useItem`, so nothing in that scenario spawned an entity at all.

**Now:** both authorities are seeded with one identical `slick` entity
(`WATCHED_ID = 4242`, `ttl = 60000`, at `(500, 0, 500)`), and every tick of both
the pre-kill and post-kill loops asserts it is still live **and** that its `ttl`
decremented by exactly one.

The entity is chosen so that it has no legal way to leave the pool: `slick` sits
still and only its `ttl` moves (`entity.ts`'s `stepEntity` default branch), the
`ttl` cannot reach zero inside a 600-tick run, and at 500 m from the oval its
2.1 m strike radius can never fire. Entities the bots legitimately spawn and
destroy during the run are deliberately **not** watched — a seeker that hits a
kart is supposed to vanish, and asserting otherwise would be a false failure.
It is seeded by writing the pool slot directly rather than through
`spawnEntity`, because `spawnEntity` emits an `entitySpawn` that Task 2 gates on
`ctx.isLeader` — seeding leader and follower through it would desynchronise
`nextEventSeq` before the race started.

**How it fails if the code is broken:** a promotion that rebuilt state from an
older buffer, or a `reconcile` that clobbered the entity pool, drops the id —
the failure names the id and the ttl it was last seen with. A promotion that
rewound time leaves the ttl higher than expected and the `toBe(lastTtl - 1)`
assertion names the tick.

### 2c. Task 16, *"re-seeds rngCursor … and never rewinds tick, lap, or a live entity"*

**Raised by:** Audit C #3.

**Was:** `expect(state.tick).toBeGreaterThanOrEqual(tickBefore)` (tick only ever
increments), `expect(lap.lap).toBeGreaterThanOrEqual(lapsBefore[k])` where every
lap was 0 for the whole run (`x >= 0`), and an entity loop with no assertion
over an empty set. Three promises, zero teeth.

**Now:** every kart's `lap.lap` is seeded to **1** before construction, and one
watched `slick` (as in 2b) is seeded into the pool. The post-promotion loop
asserts `state.tick === tickBefore + i` exactly (not `>=`), `lap.lap >= 1` per
kart, and the watched entity present with `ttl === lastTtl - 1` every tick.
`state.rngCursor` is asserted immediately after `promote()` — which required a
real code fix, below.

**How it fails if the code is broken:** a lap counter reset to 0 fails
`>= lapsBefore[k]` (which is now 1, not 0). A tick that repeats or skips fails
the exact equality. An entity dropped at promotion fails with its id and ttl.

### 2d. Task 17 convergence, the "topology" guard

**Raised by:** Audit C #5.

**Was:** `expect(Math.abs(hostState.karts[0].position.x) +
Math.abs(hostState.karts[0].position.z)).toBeGreaterThan(1)`, labelled as a
guard against nothing having happened. `createState` places seat 0 at the oval's
first control point, `(-200, ·, -100)`, so the sum is **300 before a single tick
runs**. An unused `const startX = 0` sat next to it (also `TS6133`).

**Now:** the test captures the client's own start position at construction and
asserts it travelled more than 50 m, plus `host.state().tick === RUN_TICKS` and
`client.state().tick === RUN_TICKS`.

**How it fails if the code is broken:** a client whose `tick()` never stepped, or
a host frozen in `'countdown'`, leaves the kart within a few metres of the grid.

### 2e. Task 17 convergence, `expect(settleCount).toBeGreaterThanOrEqual(0)`

**Raised by:** Audit B *Test quality* #3.

**Was:** a "sanity" assertion on a monotonically non-decreasing counter that
starts at 0 — true by construction for every implementation.

**Now:** deleted. `settleCount` is still captured, and is used as the baseline
for the steady-state delta, which is a real assertion.

### 2f. Task 15, *"steps its own kart forward every tick(), driven by localIntent"*

**Raised by:** Audit C #6.

**Was:** `expect(client.corrections()).toBe(0)` with no snapshot ever delivered —
it could only fail if `tick()` threw, and it tested nothing in its own title.

**Now:** uses `state()` (contract §5). Asserts `client.state().tick === t` inside
the loop on **every one of 60 ticks**, then that the kart travelled more than
1 m from its captured start and that its speed is non-zero.

**How it fails if the code is broken:** a `tick()` that stops advancing after its
first call — the exact Plan 1 bug shape this plan was told to guard against —
fails on iteration 2, naming the tick. A `tick()` that ignores `localIntent`
leaves the kart on the grid and fails the displacement assertion.

A second new test asserts `client.state()` returns the *same object* across
ticks and that it was advanced in place, which fails if a getter hands back a
copy captured at construction.

### 2g. Task 15, *"an itemGrant … updates the local kart before the next tick() returns"*

**Raised by:** Audit C #7.

**Was:** `expect(() => client.tick(mkIntent(0))).not.toThrow()`. The brief
admitted in its own comment that it only confirmed the receipt path did not
error.

**Now:** asserts `client.state().karts[OWN].item === 'none'` before,
`=== 'seeker'` after `pump()` returns and *before* any further `tick()`, that
`state().nextEventSeq` went 0 → 1, and that the item survives the next `tick()`.

**How it fails if the code is broken:** a `ClientLoop` that drops reliable
datagrams, or defers event application to the next tick, leaves the item
`'none'`. A follower that advanced `nextEventSeq` without applying (or emitted
one of its own) fails the sequence assertion. An implementation whose
`step()` overwrote the applied event fails the after-tick assertion.

### 2h. The near-miss Audit C named: zero-delta with no arrival control

**Raised by:** Audit C *Tests that cannot fail*, closing note (`t15:998`,
`t15:666`).

**Was:** Task 15's two `corrections() - baseline === 0` assertions had no proof
that any snapshot ever arrived. A `ClientLoop` whose `pendingSnapshot` was never
set — the exact symptom the untagged-wire defect produces — passes both.

**Now:** both tests register a second `onMessage` listener on the client's side
of the pair, counting messages whose `decodeHeader(data).kind === 'snapshot'`,
and assert a floor (30 in the 120-tick window, 140 in the 600-tick steady
window). Both also compare `client.state().karts[OWN]` against
`authority.state().karts[OWN]` within a stated band.

Registering a second listener is safe and verified rather than assumed:
Task 12's `makeLoopbackPair` keeps an **array** of callbacks per side
(`messageCbs.push(cb)`, `for (const cb of cbs)`), so the code under test is not
displaced. That fact is cited in the brief at the helper.

**How it fails if the code is broken:** a transport delivering nothing, or a
client that never decodes a snapshot, drops the count to ~0 and the failure
message says so explicitly instead of reporting a green zero.

---

## Fix 3 — reconciliation anchors on `snap.tick`

**Raised by:** the fix brief; corroborated by Audit C's *Inherited rulings* row.

Confirmed across the territory, and one silent hazard closed:

- **Task 15** — already correct (`const targetTick = snap.tick`), and its
  verification note explains the measurement. Unchanged.
- **Task 16** — already correct (`const targetTick = snap.tick`). Unchanged.
- **Task 17** — no longer references `lastProcessedInputTick` at all: the
  hand-rolled host that passed `new Array(MAX_KARTS).fill(-1)` is gone, replaced
  by a real `AuthorityLoop`.
- **Task 14** — produced the field, and produced it with one tick of skew: it
  was named `lastAppliedInputTick`, written in `onMessage` on **receipt**, and
  then published as `lastProcessedInputTick`. Spec §5 defines the field as *"the
  newest input from that player the authority had folded in."* Split into two:
  `heldIntentTick` (receipt cursor, written in `onMessage`) and
  `lastProcessedInputTick` (written in `tick()` at the moment the held intent is
  copied into `stepInputs`, i.e. the moment it is folded in). The field's doc
  comment now states outright that it is an input-buffer cursor and never a
  comparison instant, and cites the amendment and the measurement behind it.

No task in this territory compares at `lastProcessedInputTick`.

---

## Fix 4 — contract drift and spec coverage

### Contract facts applied

| Fact (contract) | Where it was wrong | Now |
|---|---|---|
| `EPS`/`Q` are six-key, keyed **`t`** | T15 line 34 + `ownKartDiverged`; T16 assumption + `diverges` | `EPS.t`; both briefs state the key is pinned by §3/§4, not assumed, and that `EPS.lapT` would be `undefined` — making `> undefined` always `false` and silently disabling the check |
| Per-kart **178 bits**, entity **135**, header **200** | T14 and T16 buffer comments citing "worst-case ~625B" | Recomputed in both: `8×178 + 32×135 + 200 = 5944 bits = 743 B`; T14 keeps 1024, T16 goes `1 + 640` → 1024. Both note `BitWriter` overflows **silently** |
| `AuthorityLoop.state()`, `tick()` takes no input param | T14 "Produces" (no `state()`); T17 built a hand-rolled host around the absence | `state(): SimState` added, returning the caller's own object; the field is renamed `live` to free the name. T17 drives the real loop |
| `ClientLoop.state()` | T15 "Produces" called a 3-member shape "verbatim"; T16 and T17 built workarounds | `state(): SimState` added; three tests rewritten to use it (2f, 2g, 2h) |
| `net` imports `@tapkart/protocol`, always | T16 Interfaces + every import; T17 fixtures and tests | All bare-specifier. Both briefs quote §3's reason (a relative path "would survive into Plan 3") |
| `packages/net/src/index.ts` is created by **Task 11** | T18 framed both barrels as creations, and predicted `Failed to resolve import` REDs | T18 reframed to "widen"; both REDs restated as missing-named-export (`TypeError: encodeHeader is not a function`, `TypeError: ShadowLoop is not a constructor`) |
| T18's ambiguity map from direct per-module imports | already correct (Audit B confirmed) | kept, and the *reason* is now written down: an ambiguous `export *` is silently dropped from the namespace, so a barrel-derived expectation inspects evidence the ambiguity has already destroyed |

### Other blocking defects fixed in this territory

| # | Audit | Was | Now |
|---|---|---|---|
| C#7 | C | Convergence counted snapshots by `data[0] === 5` — the low byte of `state.tick`, matching ~1 in 256 | `decodeHeader(data).kind === 'snapshot'` |
| C#8 | C | Convergence never set `hostState.karts[0].isBot = false` / `connected = true`, so the authority ran seat 0 on bot AI and ignored the client entirely | both set, with the `state.ts:60-61` citation |
| C#9 | C | Convergence used `CHARS = [0..7]` vs `ClientLoop`'s all-zero bootstrap, a varying sine intent, `WARMUP_TICKS = 180`, and live item boxes | mirrors Task 15's Step 12: `CHARS8`, a held-steady `Intent`, `WARMUP_TICKS = 360`, item boxes neutralised — each with the measurement that motivates it |
| C#10 | C | Convergence left the host in `'countdown'` for its whole warm-up | `hostState.phase = 'racing'`; `ClientLoop`'s constructor now carries a comment naming this requirement for every future caller |
| C#11 | C | The `authorityChange` spy sat on `pair.b`'s **receive** path; the shadow broadcasts b→a, so it could never fire | spy moved to `pair.a` (the host's side), with the routing explained inline |
| C#12 | C | Late-join allocated 4096 B for a 5384 B checkpoint → `RangeError` | `CHECKPOINT_BUF_BYTES = 8192`, named and justified |
| C#13 | C | `new Uint8Array(1 + 640)` in T16 and T17 | 1024 in both, derived from the bit counts |
| C#14 | C | `promote()` wrote `rngCursor` to `live`; its own test read it from `publish` | `promote()` ends with `cloneState(this.live, this.publish)`. `ShadowLoop` has no `state()` getter by contract, so the published object *is* the accessor and any mutation outside `tick()` must republish |
| C#15 | C | `await import()` in non-async `it`; `onMessageCb` typed `channel: string` (TS2322 under `strictFunctionTypes`); `ChannelName` imported from `transport.ts` (TS2305); `require()` in ESM (T17, T18); missing `WireKart` import (T15); unused `MAX_KARTS`/`startX` (T17), unused `TICK_HZ` (T16) | all fixed: top-level imports throughout, `ChannelName` typed properly and imported from `@tapkart/protocol`, no `require` anywhere, unused imports removed |
| C#16 | C | `ShadowLoop` handed `decodeInput` `{ playerId: 0, intents: [] }`; `decodeInput` allocates nothing → `TypeError` on `out.intents[0].tick` | a pre-allocated `inputScratch` field with `INPUT_REDUNDANCY` intents, matching `AuthorityLoop`; the now-dead `if (dg.intents.length === 0) return` is gone |
| C#21 | C | T15 asserted a quantised steer to 5 dp (`0.02` round-trips to `0.0196078…`, error `3.9e-4` vs a `5e-6` tolerance) | compares against `quantStep(-1, 1, 8)`, plus a new assertion that the two sampled datagrams differ so eight copies of one value cannot pass |
| C nb#2 | C | `applyEvent`'s `itemGrant` set `k.item` only, dropping the item box's respawn timer that `items.ts` also sets — a `ClientLoop` never learns a remote pickup consumed a box | delegates to sim's own `applyItemGrant(ctx, state, ev)`, which does both halves. This makes `ctx` a *used* parameter, so `_ctx` reverts to `ctx` and the `TS6133` rationale is rewritten as a warning against reverting |
| C nb#3 | C | Two names for the 20 Hz cadence (`SNAPSHOT_INTERVAL_TICKS` / `SNAPSHOT_PERIOD_TICKS`) | T14's private constant renamed to `SNAPSHOT_PERIOD_TICKS`; both briefs state the duplication is deliberate (neither loop may depend on the other's file) and note that T17's snapshot floor cross-checks them |
| C nb#6 | C | `heldInputForLeader()` returned `this.heldInput`, making its ternary a no-op | deleted; the brief names it so it is not re-added |
| B nb | B | T13 quoted `startSpinOut(state, k, …)`, stale once Task 2 re-signs it | the parameter list is deliberately **not** quoted, with the reason; T13 never calls it |

### New coverage: two spec §5 gaps closed

- **"the reliable channel carries checkpoints"** and **"`AuthorityCheckpoint` …
  used for shadow resync after a network partition"** were both `GAP` in Audit
  C's §5 table: Task 8 shipped the codec and no loop ever sent or received one,
  while Task 16 exported a `WIRE_TAG_CHECKPOINT` it never handled. `ShadowLoop`
  now decodes a `checkpoint` message into a scratch `SimState` in `onMessage`
  and applies it at the top of the next `tick()`, ahead of any pending snapshot,
  invalidating its history ring. It deliberately does **not** reset the
  promotion timer: spec §5 declares host loss after 1.5 s with no *snapshot*.
  New test — *"a full-precision checkpoint replaces the whole state and outranks
  a pending snapshot"*: delivers a checkpoint at tick 500 to a shadow sitting at
  tick 5 and asserts `state.tick === 501` after one `tick()`. **If the branch is
  missing the loop keeps its own timeline and the assertion reads
  `expected 6 to be 501`.**

### New coverage: two loops now tested against each other

Task 17's promotion test drives a real `AuthorityLoop` against a real
`ShadowLoop` instead of a hand-rolled `makeFakeHost`, and adds an assertion that
the shadow's `nextEventSeq` equals one past the highest `eventSeq` its own
receive path observed. **If the shadow never applied the host's events, its
`nextEventSeq` stays 0 and the assertion names the gap** — a follower's
`nextEventSeq` advances only by applying (contract §1b), so nothing else can
move it. Also added: `expect(shadowCtx.isLeader).toBe(true)` after the kill,
which fails if promotion fired the broadcast but never switched modes.

Task 13 gained two assertions and one test around the item-box half of an
`itemGrant`, all falsifiable: the box named by `ev.data` is armed to
`ctx.tuning.itemBoxRespawnTicks` and **no other box is**; a duplicate delivery
re-arms nothing (the box is zeroed between the two calls, so a re-application is
observable); and the six-event replay now scrambles every field the events wrote
before replaying, so a re-application shows up on all five of them rather than
being hidden by an identical rewrite.

---

## Left open

1. **Spec §5 names three transports; the contract's module map has one.**
   `WebRTCTransport` and `WebSocketTransport` have no task, so spec §5's
   symmetric-NAT fallback has nothing to fall back to. This is a
   contract-vs-spec disagreement, so per instructions it is reported rather than
   resolved. Audit C row 22 of *Non-blocking observations* says the same.
2. **"Every client sends its input to both the host and the server shadow"
   (spec §5) is structurally unimplemented, not merely untested.**
   `ClientLoop.tick()` broadcasts on one `Transport`, and contract §5's
   constructor takes one. Task 17's promotion test approximates the dual send by
   playing the client on both sides of a single loopback pair; that is now
   stated in the brief and in its flagged-ambiguities list rather than hidden.
   Closing it needs either a multi-peer transport or a second constructor
   argument — both outside the contract.
3. **`lastProcessedInputTick`'s `-1` sentinel has no wire representation.**
   Contract §4 gives the field as `8 × u16`, unsigned; `writeBits(-1, 16)`
   round-trips as `65535`. The encoder is Task 6's (another agent's territory).
   Flagged in Task 14's brief with the reason it is not papered over by starting
   the array at `0`. Nothing in Plan 2 reads the field back, so it is latent.
4. **`applySnapshotToState` leaves a stale entity `targetId` on a re-sentinelled
   slot** (Audit C non-blocking #14). `ShadowLoop.reconcile` is the consumer, so
   the symptom lands in this territory, but the fix belongs in Task 6's
   `snapshot.ts`. Not touched.
5. **`ShadowLoop.promote()` mutates the caller's `SimContext`** while the other
   two loops defensively copy theirs (Audit C non-blocking #4). Left as is —
   `isLeader` genuinely changes at runtime and the change must reach the room's
   owner — but the divergence is now written down in Task 16's flagged list,
   including the hazard for a future task that shares one `ctx` between loops.
6. **`RemoteInterpolator` is implemented, tested and wired to nothing**
   (spec §5 *PARTIAL*). `state()` does not close this: it exposes the
   *predicted* `SimState`, whose remote seats are exactly the locally-simulated
   values spec §5 says never to render. Surfacing interpolated samples needs a
   fifth member on a locked class. Restated in Task 15 rather than left implying
   the old three-member shape was the obstacle.
7. **`startSpinOut`'s parameter order — settled elsewhere, mid-pass, and this
   territory is correct either way.** Audit C blocking #17 had contract §2a
   saying `(ctx, k, ticks, state, events)` against Task 2's
   `(ctx, state, k, ticks, events)`. Re-reading the contract at the end of this
   pass, §2a now reads `(ctx, state, k, ticks, events)` — amended by the agent
   holding Tasks 1–6 while this pass ran. Task 13 was the only brief here that
   quoted the call site, and it deliberately quotes the *effect* with no
   parameter list, so it needs no further change. Nothing in Tasks 13–18 calls
   `startSpinOut`.
8. **Test-count arithmetic elsewhere.** Task 18's "477+ tests in `sim`" is
   corrected to the audited 484 (Tasks 1+2 measured on a scratch tree), but
   Task 11's equivalent claim ("477 from Plan 1 plus this task's 4") is in
   another territory and was not touched.
