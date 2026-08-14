# Plan 2 — Cross-Cutting Audit (Audit C)

Scope: do the eighteen briefs form **one** coherent plan? Individual-task
placeholder/internal-consistency checks belong to Audits A and B; anything I
noticed there is parked in *Non-blocking observations*.

Sources read in full: the contract
(`docs/superpowers/plans/2026-08-14-tapkart-plan2-contract.md`), spec §3/§4/§5/§8
(`docs/superpowers/specs/2026-08-13-tapkart-design.md`), all eighteen
`docs/superpowers/plans/parts/plan2-task-*.md`, and the shipped
`packages/sim/src/*.ts` that the briefs make claims about.

---

## Verdict

**Not executable as written.** Tasks 5 and 6 encode a *different* wire format
than the contract and spec lock (177 bits, `isBot` dropped, 19-key `Q` keyed
`lapT`); no task implements the contract's `WIRE_TAG`/`encodeHeader`, so Task 16
invented an incompatible one that Tasks 14/15 do not use; Tasks 14/15 import
codecs from a `@tapkart/protocol` barrel that does not carry them until Task 18;
and both `AuthorityLoop.state()` and `ClientLoop.state()` are silently dropped
from the locked signatures. **21 blocking defects** below. The plan is
recoverable — Tasks 1-4 and 8-13 are strong, and Tasks 1 and 2 were verified by
applying their edits to a scratch `packages/sim` and running the suite — but the
fixes span task boundaries and no single task's author can make them.

Executable after the named fixes in *Blocking defects*, in this order: #3 and #4
(one header format), #5 and #6 (one import convention), #1 and #2 (one wire
format), then #17-#20 (the Tasks 1-2 step repairs, which gate everything else),
then #7-#12, #21 and #14-#16 (per-test repairs), then #13 (buffer sizes).

---

## Interface pairs

Producer → consumer, exact symbol, agreement.

| # | Producer | Consumer | Symbol / signature | Agree? |
|---|---|---|---|---|
| 1 | T5 `quant.ts` | T6 `snapshot.ts` | `Q.position/velocity/heading/angularVelocity/driftCharge` `{min,max,bits}` | **YES** — t05:339-343 vs t06:684-693 |
| 2 | T5 | T6 | `Q.lapT` | **YES** (both `lapT`) — t05:344, t06:575/693/761 |
| 3 | T5 | **T7** | `Q.t` / `EPS.t` | **NO** — T7 pins the key as `t` and says so explicitly ("**`t`, not `lap.t` and not `lapT`**", t07:91-97, list at t07:141); T5 ships `lapT` (t05:324, 344). Contract §3 (`t: QuantField`, line 209) and §4 ("The key is `t`, not `lap.t`", line 369) side with T7. `Q['t']` is `undefined` → `const {min,max,bits} = Q[field]` throws at t07:151 |
| 4 | T5 | **T7** | `QuantTable`/`EpsilonTable` cardinality | **NO** — contract §3:206-214 and §4:363-365 lock **six** continuous keys ("Only the six continuous rows above appear in `Q` and `EPS`… giving them one would invite someone to compare an integer with a tolerance"). T5 ships **19** keys with `EPS.x === 0` for thirteen of them (t05:203-204, 371-383). T7's `CONTINUOUS_FIELDS` (t07:135-142) is the six |
| 5 | T5 | T15 | `EPS.position/velocity/heading/angularVelocity/driftCharge` | **YES** — t05:365-369 vs t15:362-370 |
| 6 | T5 | T15 | `EPS.lapT` | **YES** (both `lapT`) — t05:370, t15:371 |
| 7 | T5 | T16 | `EPS.*` incl. `EPS.lapT` | **YES** — t16:122-123, 651-660 |
| 8 | T5 | T6 | `Q.isBot` | **NO — does not exist.** T5 deliberately merges `isBot`/`connected` into one wire bit (t05:32-46) and T6 concurs (t06:98-111). Contract §4:334-341 and spec §5:381-384 both say **two bits, one each**, and give the per-kart total as **178**. T5's test asserts `expect(total).toBe(177)` (t05:236); T6 sizes buffers off 177 (t06:523-525) |
| 9 | T5 | T7 | `quantStep(min,max,bits)` | **YES** — identical formula, t05:175-177 vs t07:169 |
| 10 | T4 `bits.ts` | T6 | `BitWriter(buf).writeBits/writeFloatQ`, `BitReader(buf).readBits/readFloatQ`, `byteLength()` | **YES** — t04:72-84 vs t06:672-724, 739-761 |
| 11 | T4 | T7 | same, plus `reset()` | **YES** — t04 provides `reset()`; T7 constructs fresh instances (t07:45-50) |
| 12 | T4 | T8 | — | **N/A** — T8 deliberately uses raw `DataView.setFloat64`, not `BitWriter` (t08:82-95). Legal under contract §0's "a task needing something absent may define it" |
| 13 | T4 | T9 | `BitWriter`/`BitReader` via `'./bits'` | **YES** — t09:245, 269, 291 |
| 14 | T4 | T10 | `BitWriter`/`BitReader` incl. `writeFloatQ` | **YES** — t10:266, 273-274, 289 |
| 15 | T3 `types.ts` | T6 | `WireKart` (21 fields), `WireEntity` (7), `WireSnapshot` (6) | **YES** on shape — t03:307-333 vs t06:156 |
| 16 | T3 | T14 | `WireKart`/`WireEntity`/`WireSnapshot` object literals | **YES** field-for-field — t14:151-178 |
| 17 | T3 | T15 | `WireKart`/`WireEntity`/`WireSnapshot` | **YES** field-for-field — t15:341-357 |
| 18 | T3 | T16 | `WireKart`/`WireEntity`/`WireSnapshot` | **YES** field-for-field — t16:91-99, 448-467 |
| 19 | T3 | T10 | `InputDatagram { playerId; intents }` | **YES** — t03:330-332, t10:232 |
| 20 | T3 | T14 | `InputDatagram` | **YES** — t14:294, 344 |
| 21 | T3 | **T11/T14/T15/T16** | `WIRE_TAG`, `encodeHeader(out,kind)`, `decodeHeader(buf)` | **NO — never produced.** Contract §3:182-188 assigns all three to Task 3's `types.ts`. Task 3's *Produces* list (t03:34-44) and every implementation step (t03:137-148, 304-333, 381-389) omit them. `grep -n "encodeHeader\|decodeHeader" plan2-task-*.md` → **zero hits**. T16 then invents `WIRE_TAG_INPUT=4 … WIRE_TAG_AUTHORITY_CHANGE=8` in `net/src/shadow.ts` (t16:325-329) — different names, different values (contract: `0x10/0x11/0x12/0x13/0x20`), different package, and a 1-byte header with no protocol-version byte |
| 22 | T16 `WIRE_TAG_*` | **T14** | `data[0]` tag on every broadcast | **NO** — `AuthorityLoop.tick()` broadcasts raw `encodeSnapshot`/`encodeEvents` output with no tag (t14:414-422) and `onMessage` calls `decodeInput` on *any* unreliable datagram (t14:365-367). T16 flags the requirement explicitly at t16:147-150 and t16:921-926 |
| 23 | T16 `WIRE_TAG_*` | **T15** | `data[0]` tag | **NO** — `ClientLoop` broadcasts untagged `encodeInput` (t15:532-533) and treats every unreliable datagram as a snapshot (t15:485-486) |
| 24 | T16 `WIRE_TAG_*` | T17 | `WIRE_TAG_INPUT/SNAPSHOT/EVENTS/AUTHORITY_CHANGE` | **YES** with T16 (t17:52-56, 117, 153, 237, 410-427), **NO** with T14/T15 — which is what breaks T17's convergence test (see Blocking #7) |
| 25 | T16 `WIRE_TAG_*` | T18 | five constants, values `[4,5,6,7,8]` | **YES** — t16:325-329 vs t18:112-116, 451 |
| 26 | T11 `Transport` | T12 | six-method interface | **YES** verbatim — t11:328-335 vs t12:297-325 |
| 27 | T11 `Transport` | T14 | `Transport` | **YES** — t14:296, `FakeTransport implements Transport` t14:514-538 |
| 28 | T11 `Transport` | T15 | `Transport` | **YES** — t15:308 |
| 29 | T11 `Transport` | T16 | `Transport` | **YES** — t16:294, 62-69 |
| 30 | T11 `transport.ts` | **T17 `spy-transport.ts`** | `import type { ChannelName, Transport } from '../../src/transport'` | **NO** — `transport.ts` imports `ChannelName` type-only and never re-exports it (t11:320-335). T17:178 imports it from there → **TS2305** |
| 31 | T12 `makeLoopbackPair` | T14/T15/T16/T17 | `{ a; b; pump(nowMs) }`, `LoopbackOptions` | **YES** — t12:77-78 vs consumers |
| 32 | T12 `makeNetContext` | T13/T14/T15/T16/T17 | `(isLeader?: boolean) => SimContext` | **YES** — t12:444 vs contract §6:468 |
| 33 | T12 `makeLossyPair` | T14/T15/T17 | `(overrides?: Partial<LoopbackOptions>)`, default `{150,50,0.05,0xC0FFEE}` | **YES** — t12:456-467 vs contract §6:472 |
| 34 | T13 `applyEvent` | T15 | `applyEvent(ctx, state, ev): boolean` | **YES** — t13:498 vs t15:501, 579 |
| 35 | T13 `applyEvent` | T16 | same | **YES** — t13:498 vs t16:550, 634 |
| 36 | T13 `applyEvent` | T17 | same | **YES** — t17:364, 537-543 |
| 37 | T10 `encodeInput/decodeInput/INPUT_REDUNDANCY` | T14 | `decodeInput(buf, out)`, `encodeInput(out, playerId, intents)` | **YES** on signature — t10:265/288 vs t14:295, 367; **but** T14 hands `decodeInput` a tagged-or-untagged buffer inconsistently with T16 (row 22) |
| 38 | T10 | T15 | `encodeInput`, `INPUT_REDUNDANCY` | **YES** — t15:307, 476, 532 |
| 39 | T10 | T16 | `decodeInput(data.subarray(1), dg)` | **Signature YES, contract NO** — T16 passes `dg = { playerId: 0, intents: [] }` (t16:516), an **empty** intents array. T10's `decodeInput` writes `out.intents[i]` for `i < INPUT_REDUNDANCY` with no allocation (t10:292-294, and its own doc: "`out.intents` must already be an array of length `INPUT_REDUNDANCY`"). Writing `undefined.tick` throws |
| 40 | T9 `encodeEvents/decodeEvents` | T14/T15/T16/T17 | `(out, events): number` / `(buf, out): void` | **YES** — t09:268/290 vs all consumers |
| 41 | T8 `encodeCheckpoint/decodeCheckpoint` | T17 | `(out, state): number` / `(buf, dst): void` | **Signature YES, buffer NO** — T8 writes **5384 bytes** (asserted t08:262); T17 allocates `new Uint8Array(4096)` (t17:620, 638) → `DataView.setFloat64` RangeError |
| 42 | T6 `encodeSnapshot` | T14 | `(out, state, lastProcessedInputTick)` | **YES** — t06:668-671 vs t14:420 |
| 43 | T6 `encodeSnapshot` | T16 | same | **Signature YES, buffer NO** — T16 sizes `1 + 640` claiming "640 >= contract §4's worst-case 625B" (t16:694). Contract §4:352 / spec §5:424 give **~743 B**. `BitWriter` writes past a `Uint8Array`'s end **silently** (t04:257-258, typed-array OOB assignment is a no-op) → silent truncation at ≥26 live entities |
| 44 | T6 `decodeSnapshot` | T14/T15/T16 | `(buf, out: WireSnapshot): void`, caller-owned target | **YES** — t06:739 vs t14:229, t15:486, t16:535 |
| 45 | T6 `applySnapshotToState` | T16 | `(snap, dst): void` | **YES** — t06:993 vs t16:620, 628 |
| 46 | T6 `applySnapshotToState` | T15 | — | **Not used.** T15 hand-rolls `writeWireKartInto` (t15:387-410) for its single kart. Legitimate (T15 corrects only its own seat), but the two must stay in sync by hand. Note the divergence: `applySnapshotToState` writes `k.isBot`/`k.connected` (t06:1002); `writeWireKartInto` writes neither |
| 46b | T6 `decodeSnapshot` | T15/T16 | `WireKart.isBot` | **Derived, not transmitted** — `k.isBot = !connected` (t06:775-777), then `applySnapshotToState` pushes the derived value into `SimState` (t06:1002). Spec §5:559-560's drop-then-reclaim path is exactly where the two can disagree, so a shadow corrected from a snapshot silently rewrites `isBot` |
| 46c | T6 `applySnapshotToState` | T16 `reconcile` | entity `targetId` | **Not written** (t06:1028-1044 copies every dead slot's other fields but skips `targetId`). `packages/sim/src/entity.ts:25-38`'s dead-slot form sets `targetId = -1`, and `statesEqual` (`packages/sim/src/state.ts:291`) compares it. A slot that held a live seeker keeps a stale `targetId` while `entityId === -1` |
| 47 | T1 `SimState.heldBotIntent/heldBotTick` | T8 | encoded/decoded field-by-field | **YES** — t08:60, 445-454, 528-537 |
| 48 | T1 `SimState` (2 new fields) | T14/T15/T16 | `allocStateLike`/`cloneState`/`createState` | **YES** — all three go through the sim's own constructors, so the widening is transparent |
| 49 | T2 `startSpinOut(ctx,k,ticks,state,events)` | T13 | `applyEvent` deliberately does **not** call it (t13:163-177) | **YES**, and correctly reasoned |
| 50 | T3 barrel `protocol/src/index.ts` | **T14/T15** | `import { EPS, INPUT_REDUNDANCY, decodeInput, decodeSnapshot, encodeEvents, encodeInput, encodeSnapshot } from '@tapkart/protocol'` | **NO** — T3's barrel is `export * from './types'` **only** (t03:388). Nothing widens it until T18 (t18:327-333). T14:295 and T15:307 import codec functions that the barrel does not carry when Tasks 14/15 run |
| 51 | T3 barrel | T11/T12/T16/T17 | relative `'../../protocol/src/<module>'` | **Works, violates contract.** Contract §3:245-249: "**`net` imports `@tapkart/protocol`, always**" and calls the relative path a boundary violation that "would survive into Plan 3". T11:38-59, T12:23-27/237, T16:83-86/300-304, T17:71/115-116/365-366/597 all use it |
| 52 | T11 `net/src/index.ts` | T18 | Task 11 leaves `export {}` (t11:189); T18 expects the file **absent** (RED at t18:522) | **NO** — contract §3:247-249 says Task 11's scaffold creates it "re-exporting `./transport`". T18's stated RED (`Failed to resolve import "../src/index"`) will not occur |
| 53 | T3 `protocol/src/index.ts` | T18 | T3 creates it (t03:379-389); T18 expects it **absent** (RED at t18:305-306) | **NO** — same shape as row 52 |
| 54 | Contract §5 `AuthorityLoop.state(): SimState` | T16/T17 promotion test | "read-only view, so the promotion test can compare authorities" | **NO — never produced.** T14 ships only `constructor`/`tick()` (t14:58, 334-424). T18's consumed list repeats the omission (t18:103) |
| 55 | Contract §5 `ClientLoop.state(): SimState` | T17 convergence test | "read-only view; the convergence test asserts on it directly" | **NO — never produced.** T15:48 calls its 3-member shape "locked contract §5, verbatim" — it is not (contract §5:420-426). T15:239-243 and T17:20-35, 718-721 then build elaborate workarounds for an accessor the contract already granted them |
| 56 | T14 `SNAPSHOT_INTERVAL_TICKS = 3` (private) | T16 `SNAPSHOT_PERIOD_TICKS = 3` (exported) | 20 Hz cadence | Same value, **two names in two modules** (t14:299 vs t16:310). T17 imports the shadow's (t17:237) while testing the authority's cadence |
| 57 | T15 `RemoteInterpolator` | nothing | `push`/`sampleKart` | Produced and tested, **wired to nothing** (t15:56-62). Spec §5's "buffered and rendered ~100 ms in the past" is therefore half-delivered |

---

## Shared-file edit chains

### `packages/sim/src/{types,state,phase,replay,recovery,laps,entity,items}.ts` — Task 1 then Task 2

- **Task 1** (contract §1a/§1d) widens `SimState` with `heldBotIntent`/`heldBotTick`,
  rewrites `resolveInputs` to read/write them, deletes `resetBotHold`, deletes
  `replayRun`'s parity `RangeError` and `needsOddCheckpoint`, and repairs the five
  hand-built-`SimState` test files.
- **Task 2** (contract §1b/§2a) then threads `ctx` into `startSpinOut`,
  `spawnEntity`, `despawnEntityAt` and gates all eleven `emit()` sites.
- **Overlap is real but disjoint by line**: Task 1 touches `phase.ts` lines 28-53
  and 107-121 (the hold) and `replay.ts` lines 36-54/60/108-115/145/206-217/226;
  Task 2 touches `phase.ts` only at 216/225 (already-gated sites, unchanged) and
  `recovery.ts`/`laps.ts`/`entity.ts`/`items.ts`. **No line collision found.**
- **The one ordering hazard**: Task 2's `startSpinOut` signature change is a
  *reorder plus prepend*, not a prepend. Shipped is
  `startSpinOut(state, k, ticks, events)` (`packages/sim/src/recovery.ts:51-56`);
  contract §2a:136-137 specifies `startSpinOut(ctx, k, ticks, state, events)`.
  The contract's own comment "`// CHANGED: ctx prepended`" understates it. The
  single `src` caller is `packages/sim/src/entity.ts:261` (contract's "exactly one
  caller in `src`, verified" — **TRUE**, I checked), but there are **seven** test
  call sites in `packages/sim/test/recovery.test.ts` (lines 519, 542, 555, 567,
  571, 575, 586, 601) that contract §1d does not list. Task 2 must fix them or
  `npm test` goes red at Task 2.
- `resetBotHold` call sites the contract *does* name are correct: `replay.ts:60`
  (import), `replay.ts:145`, `replay.ts:226`, `packages/sim/test/barrel.test.ts`,
  `packages/sim/test/replay.test.ts`.

### `packages/protocol/src/index.ts` — Task 3 creates, Task 18 widens

- Task 3 writes `export * from './types'` (t03:379-389). **Matches contract §3:241-243.**
- Tasks 4, 5, 6, 8, 9, 10 add modules and **never touch the barrel**.
- Task 18 overwrites the file with all seven `export *` lines (t18:312-334).
  Content is a superset, so the overwrite is harmless.
- **Mismatch**: Task 18's Step 2 RED (t18:305-306) predicts
  `Failed to resolve import "../src/index"`. The file exists from Task 3, so the
  actual failure is a *named-export* error (`BitWriter`, `encodeSnapshot`, … are
  not on the barrel). Still red, wrong reason — a documented-expectation miss, not
  a functional break.
- **Functional break**: because the barrel is not widened until Task 18, Tasks
  **14 and 15** cannot import codecs from `@tapkart/protocol` (row 50). Tasks 11,
  12, 16, 17 sidestep it with relative paths — which the contract forbids (row 51).

### `packages/net/src/index.ts` — Task 11 creates, Task 18 widens

- Task 11 writes `export {}` (t11:181-189). **Contract §3:248-249 says it should
  re-export `./transport`.** Minor, but it is the reason Task 11 argues itself into
  the forbidden relative import (t11:40-59) on a premise about the contract that is
  false (see *Premises checked*).
- Task 18 overwrites with six `export *` lines (t18:528-541) — content superset,
  harmless. Same wrong-RED-reason as the protocol barrel (t18:522).
- Task 18's `it('lists every module in src/ exactly once')` (t18:459-476) compares
  `readdirSync(SRC)` against `['transport','loopback','apply','authority','client','shadow']`.
  Tasks 11-16 create exactly those six. **Agrees.**
- Task 18's protocol equivalent (t18:250-263) expects exactly
  `['types','bits','quant','snapshot','checkpoint','events','input']`. Tasks
  3/4/5/6/8/9/10 create exactly those seven. **Agrees.**

---

## Spec coverage

### §5 — Netcode and session lifecycle

| Spec §5 clause (line) | Implementing task | Status |
|---|---|---|
| `Transport`: one interface (330-339) | T11 `transport.ts` | **COVERED** |
| `WebRTCTransport` (333) | — | **GAP** (contract §5 module map omits it; deferred to a later plan, but spec §5 says three) |
| `WebSocketTransport` (334) | — | **GAP** (same) |
| `LoopbackTransport` w/ latency, jitter, loss (335) | T12 `makeLoopbackPair` | **COVERED** |
| Two channels `'unreliable'` / `'reliable'` (337-338) | T3 `ChannelName`, T11 `Transport`, T12 `enqueue` | **COVERED** |
| unreliable carries input + snapshots (337) | T14:421, T15:533, T16:697 | **COVERED** |
| reliable carries events (338) | T14:416, T16:704 | **COVERED** |
| reliable carries checkpoints (338) | — | **GAP** — T8 ships the codec; no loop ever sends or receives one |
| reliable carries lobby state (338) | — | **GAP** (no `hello`/`welcome`/`lobby`/`start` codec; T14:90-92 declares it out of scope) |
| "Nothing above the transport knows which implementation" (339) | T11 test (t11:264-292) | **COVERED** |
| Input intents at 30 Hz (343) | T15 `INPUT_SEND_INTERVAL_TICKS = 2` (t15:315, 526) | **COVERED** |
| Each datagram carries the last 8 intents (343) | T10 `INPUT_REDUNDANCY = 8` + sliding window (t10:243, 270-278); T15 `sendWindow` (t15:527-531) | **COVERED** |
| Authority holds newest intent across **both** ticks of the 60 Hz pair, repeating over gaps (345-347) | T14 `heldIntent` + `lastAppliedInputTick` (t14:340-341, 375-385, 399-408); T16 `heldInput`/`heldInputTick` (t16:520-528, 556) | **COVERED** |
| Drift timing quantised to 2 ticks (347-349) | Plan 1 (`resolveInputs`) | inherited, out of Plan 2 scope |
| Every client sends input to **both** host and shadow (351-352) | — | **GAP** — `ClientLoop.tick()` broadcasts on one `Transport` only (t15:533); T17's promotion test fakes it by piggybacking on the host's own broadcast (t17:406-417) |
| `WireSnapshot` at 20 Hz (354) | T14 `state.tick % 3` (t14:419); T16 `SNAPSHOT_PERIOD_TICKS` (t16:580) | **COVERED** |
| Per-kart record = 178 bits, exact field/bit table (356-379) | T6 encoder | **DIVERGES** — 177 bits, `isBot` not on the wire (Blocking #1) |
| `bot/connected` are **two** bits (381-384) | — | **GAP / contradicted** by T5:41 and T6:98-111 |
| Invariant: per-kart record is a complete projection of `KartState` (386-388) | T3 21-field `WireKart` + `Object.keys().length === 21` (t03:225) | **COVERED** for the type; **violated** on the wire by #1 |
| `boostTicks` / `respawnTicks` / `shielded` on the wire (393-396) | T3:314, T6:687-697 | **COVERED** |
| `characterIdx` deliberately absent (397-400) | T3 `WireKart` omits it | **COVERED** |
| Entity record `velocity 3×u12` + `heading u12`, `ttl u16` (402-415) | T6 `ENTITY_TTL_BITS`/`Q.velocity`/`Q.heading` (t06:707-720) | **COVERED** |
| Header `tick u32`, `eventSeq u32`, 8×`lastProcessedInputTick u16`, `entityCount u8` (417-418) | T6:674-679 | **COVERED** (but `-1` sentinel is unbiased — see Non-blocking) |
| Client runs `step()` locally at 60 Hz on its own input (446) | T15 `tick()` (t15:507-514) | **COVERED** |
| Ring buffer of `(tick, input, SimCheckpoint)` full precision (447) | T15 `RingEntry` cap 128 (t15:412-420, 517-524) | **COVERED** |
| Compare at **`snap.tick`** (450-451, 456-466) | T15 `reconcile` (t15:552-554); T16 `reconcile` (t16:613-619) | **COVERED** |
| Reset to authoritative value + replay buffered inputs forward (452-453) | T15:565-585; T16:628-642 | **COVERED** |
| Per-field epsilon (451) | T5 `EPS`, T15 `ownKartDiverged` (t15:361-385), T16 `diverges` (t16:645-691) | **COVERED** |
| `lastProcessedInputTick` is an input-buffer cursor only (468-471) | T15 explicitly leaves it unread (t15:107-110); T16 only writes it for broadcast (t16:563, 696); T14 populates it (t14:341) | **COVERED** |
| Each epsilon derived from and exceeding its step (473-477) | T5 test (t05:275-287), T7 exhaustive test (t07:144-156) | **COVERED** (T7 blocked by key mismatch, row 3) |
| Remote karts + entities never predicted, interpolated ~100 ms in the past, capped extrapolation (479-481) | T15 `RemoteInterpolator` (t15:860-927) | **PARTIAL** — implemented and unit-tested, wired to nothing (t15:56-62) |
| Clients never predict item-box yields (296-300, 483-489) | Plan 1 `rollItem` `!isLeader → 'none'` (`items.ts:72`); T13 `itemGrant → k.item = ev.item` (t13:503-507); T15 applies on receipt (t15:494-504) | **COVERED** |
| Events on the reliable channel with monotonic `eventSeq`, applied exactly once (485-489) | T9 codec, T13 `applyEvent` gate (t13:499-500) | **COVERED** |
| A non-leader never emits — all eleven sites (491-508) | T2 | **See Inherited rulings** |
| Follower `nextEventSeq` advanced only by applying (505-507) | T13:500 | **COVERED** |
| Local kart's hit reaction plays on receipt, not prediction (513-515) | T15:494-504, T13 `hit`/`spinOut` cases | **COVERED** |
| Shadow in follower mode: receives client input + host events, runs `step()` in lockstep (523-527) | T16 `ShadowLoop.tick()` follower branch (t16:541-586) | **COVERED** |
| Shadow never rolls items, never originates events (525) | `ctx.isLeader === false` + T2's gating; T16 test (t16:388-401) | **COVERED** |
| Shadow uses the host's snapshot stream as periodic correction across **all** karts and entities (526-527) | T16 `reconcile`/`diverges` (t16:612-691) | **COVERED** |
| Promotion after **1.5 s with no snapshot** (529) | T16 `HOST_TIMEOUT_TICKS = 90`, `ticksSinceSnapshot` (t16:307, 585-586) | **COVERED** |
| Broadcast `authorityChange {tick, eventSeq}` on reliable (530-531) | T16 `encodeAuthorityChange` (t16:336-346, 597-599) | **COVERED** (bespoke format, not `WIRE_TAG`) |
| PRNG re-seeded from `(raceSeed, promotionTick)` (531-532) | T16 `this.live.rngCursor = tick` (t16:607) | **COVERED** (interpretation stated at t16:600-606) |
| Continue `eventSeq` from the highest observed (532-533) | T16 fact 3 (t16:33-39) — falls out of `applyEvent` | **COVERED** |
| No rewind at promotion: no teleport, no lap regression, no vanished projectile (536-537) | T16 test (t16:821-846), T17 promotion test (t17:462-515) | **NOT ACTUALLY TESTED** — both "controls" cannot fail (see *Tests that cannot fail*) |
| Clients swap transports and keep their tick baseline (533-534) | — | **GAP** (no client-side `authorityChange` handler anywhere) |
| Post-promotion item-roll divergence accepted (540-541) | T16 doc (t16:600-606) | **COVERED** (documentation only, as spec intends) |
| `AuthorityCheckpoint`: full-precision `SimState` serialization (549-550) | T8 `encodeCheckpoint`/`decodeCheckpoint` | **COVERED** |
| …used for **late join** (551) | T17 latejoin test only (t17:611-655) | **PARTIAL** — codec proven, no loop sends it |
| …used for a client diverged past recovery (551-552, 561-562) | T15 `hardResync` explicitly declines (t15:588-598) | **GAP** |
| …used for shadow resync after a partition (552) | T16 exports `WIRE_TAG_CHECKPOINT` (t16:328) and **never handles it** (t16:512-539) | **GAP** |
| WebRTC never establishes → WebSocket relay (557-558) | — | **GAP** (no transport) |
| A dropped client's kart taken over by a bot (559) | T14 `onPeerLost → connected = false` (t14:388-396) + Plan 1 `resolveInputs` | **COVERED**; test at t14:541-564 |
| …and reclaimed on reconnect (560) | — | **GAP** |
| Rooms expire after inactivity (563) | — | **GAP** (server scope) |
| Session lifecycle 1-7 (565-575) | — | **GAP** (server/game scope, contract-deferred) |

### §8 — Testing (the three named `net` tests)

| Spec §8 clause (line) | Implementing task | Status |
|---|---|---|
| `protocol` wire round-trip bounds, asserted against the epsilon constants (624) | T7 `roundtrip.test.ts` | **COVERED**, blocked by row 3 |
| `net` #1: Loopback @150/50/5%, client converges and stays within epsilon, **zero** steady-state corrections (625) | T17 `convergence.test.ts` (t17:261-314); duplicated by T15 Step 12 (t15:941-1000) | **PRESENT but will not pass** — Blocking #7-#10 |
| `net` #2: promotion — shadow matches the host's last checkpoint within bounds, no lap regresses, no entity disappears, no event applied twice (626) | T17 `promotion.test.ts` (t17:435-546) | **PARTIAL** — "matches within bounds" and "no entity disappears" are non-tests; "no event applied twice" and "no lap regresses" are real |
| Late join via `AuthorityCheckpoint` (spec §5:551; T17's own third pillar) | T17 `latejoin.test.ts` (t17:611-655) | **PRESENT but will not run** — 4096-byte buffer vs 5384-byte encode (row 41) |
| Bit-identity only asserted same-process (634-641) | T17 latejoin (same process) | **COVERED** |
| Golden-replay compares fields, not hashes (643-644) | T8/T17 use `statesEqual` | **COVERED** |
| Zero-corrections is the epsilon-below-step guard (646-648) | T7 + T15/T17 | **COVERED in intent** |

---

## Inherited rulings

| Ruling (contract) | Implemented by | Status |
|---|---|---|
| Bot hold moves into `SimState` as `heldBotIntent`/`heldBotTick`, appended after `finishedOrder`; `createState`/`cloneState`/`statesEqual` all handle both (§1a:59-68) | Task 1 (`:101-107`, `:181-207`, `:319-390`, `:409-457`) | **IMPLEMENTED** — `heldBotTick` is `number[]`, not the shipped `Int32Array`, which is correct for `cloneState`/`Object.is` |
| `resetBotHold` **deleted**; `recordRun`/`replayRun` drop their calls (§1a:71-74) | Task 1 (`:562-599`, `:752-940`) | **IMPLEMENTED** — including `replay.ts:60/145/226`, `barrel.test.ts` (import, inventory, call, count 47→46), `replay.test.ts:15`, and all five `phase.test.ts` calls |
| `replayRun`'s parity `RangeError` guard **and** `needsOddCheckpoint` **both deleted** (§1a:76-78) | Task 1 (`:1244-1280`, `:1284-1317`) | **IMPLEMENTED**; the stale `replay.ts:36-54` header block is rewritten too (`:1201-1241`) |
| A test asserts an **even**-tick checkpoint with bot karts replays bit-identically (§1a:78-80) | Task 1 (`:1116-1150`) | **IMPLEMENTED and proven non-vacuous** — see Premise #43 |
| Five hand-built-`SimState` test files fixed (§1d:146-153) | Task 1 Step 18 (`:1337-1388`) | **IMPLEMENTED** — every quoted anchor matches disk |
| `emit()` gated on `ctx.isLeader` at **all eleven** call sites (§1b:82-94) | Task 2 (`:136`, `:146`, `:258`, `:339`, `:670`, `:693`, `:721`, `:723`, plus 3 pre-existing) | **IMPLEMENTED** |
| A test proves follower and leader reach identical `SimState` **except** `nextEventSeq` and the events array (§1b) | Task 2 Step 30 (`:1224-1331`) | **IMPLEMENTED and proven non-vacuous** — see Premise #44 |
| The three changed signatures match §2a exactly (§2a:122-144, and the header's "No task may … re-sign") | Task 2 | **PARTIAL** — `spawnEntity`/`despawnEntityAt` match character for character; `startSpinOut` does not (Blocking #18) |
| `WireSnapshot` carries `boostTicks`, `respawnTicks`, `shielded` (§1c:100-102) | T3:314 (type), T6:687-689/696 (wire) | **IMPLEMENTED** |
| `characterIdx` deliberately absent from `WireKart` (§1c:102-103) | T3:307-315 — absent; T3's `Object.keys(wk).length === 21` (t03:225) locks it | **IMPLEMENTED** |
| Entity `ttl` is `u16` (§1c:103-104) | T6 `ENTITY_TTL_BITS` = 16 (t06:720) | **IMPLEMENTED** |
| `isBot` and `connected` get **a bit each** (§4:334-341) | — | **NOT IMPLEMENTED** — T5/T6 merge them into one (Blocking #1) |
| Reconciliation compares at **`snap.tick`**, never `lastProcessedInputTick` (§0/spec §5:450-471) | T15 `reconcile(snap)` uses `const targetTick = snap.tick` (t15:553); T16 `const targetTick = snap.tick` (t16:613) | **IMPLEMENTED** in both reconcilers. `lastProcessedInputTick` is used only as a cursor: T14 fills it for broadcast (t14:341, 420), T16 mirrors `heldInputTick` into it (t16:563) and never compares against it, T15 never reads it and says so (t15:107-110). **No task compares at `lastProcessedInputTick`.** |
| Every epsilon strictly exceeds its step, asserted mechanically field by field (§4:371-373) | T7 (t07:144-156) + T5 (t05:275-287) | **IMPLEMENTED** but T7 is blocked by the `t`/`lapT` key mismatch |
| `makeLoopbackPair` draws from its own cursor, never `state.rngCursor` (§5:434-437) | T12 `let cursor = 0` in closure (t12:271, 287-289) | **IMPLEMENTED**, and the reasoning is spelled out at t12:28-42 |
| Time: no `Date.now()` in `protocol`; `net` reads the clock only in transports/schedulers (§0:31) | T12 `pump(nowMs)` is the only clock (t12:114-126, 330); no codec reads a clock | **IMPLEMENTED** |
| Channel names are exactly `'unreliable'` / `'reliable'` (§0:32) | T3:140 | **IMPLEMENTED** |
| Wire byte order little-endian; bit packing LSB-first (§0:26-27) | T4 (t04:25-31), T8 (`setFloat64(…, true)`, t08:387), T16 (`setUint32(…, true)`, t16:343-344) | **IMPLEMENTED** |
| The barrel exists from Task 3, not Task 18; **`net` imports `@tapkart/protocol`, always** (§3:241-249) | — | **NOT IMPLEMENTED** — T3 creates a *types-only* barrel; T11/T12/T16/T17 use the forbidden relative path; T14/T15 use the bare specifier that does not yet resolve (rows 50-53) |
| `WIRE_TAG` / `encodeHeader` / `decodeHeader` in `protocol/src/types.ts` (§3:180-188) | — | **NOT IMPLEMENTED** (row 21) |
| `AuthorityLoop.state()` and `ClientLoop.state()` (§5:417, 425) | — | **NOT IMPLEMENTED** (rows 54-55) |
| Types-only modules take their RED from `tsc`, not vitest (§3:251-263) | T3 (t03:7-13, 266-278), T11 (t11:88-101, 296-313) | **IMPLEMENTED** — both are exemplary |
| Sim test fixtures are not importable from another package (§6:451-465) | T12 reaches `'../../../sim/test/fixtures/track-fixtures'` by relative path (t12:432) and does **not** widen sim's exports; T8 hand-builds fixtures (t08:97-106) | **IMPLEMENTED** in effect |

*Task 1 and Task 2 ruling detail is in the two subsections below.*

### Task 1 — the bot-hold amendment

**IMPLEMENTED, with one deviation and one stale artefact.**

- Fields added exactly as §1a:59-68 specifies, appended after `finishedOrder`:
  `heldBotIntent: Intent[]`, `heldBotTick: number[]` — plain `number[]`, not
  `Int32Array` (t01 `types.ts` edit). `createState` fills `MAX_KARTS` neutral
  intents and `MAX_KARTS` × `-1`; `cloneState` deep-copies both; `statesEqual`
  compares both with `Object.is`. All three required by §1a and all three present.
- `resetBotHold` deleted; the `resetBotHold()` calls in `recordRun` and
  `replayRun` and the `replay.ts` import are removed; `barrel.test.ts`'s import
  and `replay.test.ts`'s now-meaningless poisoning test are removed, matching
  §1d:155-159.
- `needsOddCheckpoint` **and** `replayRun`'s parity `RangeError` are both deleted.
- The replacement test asserts an **even**-tick checkpoint with bot-driven karts
  replays bit-identically via `statesEqual`. **It is a real control**: it fails
  against the pre-Task-1 code, because the module-scope hold genuinely could not
  be captured by `cloneState`.
- All five `TS2739` test files named in §1d:146-153 are fixed, and the brief
  names the exact diagnostics it saw from a real probe
  (`plan2-task-01-bot-hold-state.md:14`: six `TS2739`s at `state.ts(111,3)`,
  `collision.test.ts(60,3)`, `entity.test.ts(106,3)`, `laps.test.ts(108,3)`,
  `placement.test.ts(56,3)`, `recovery.test.ts(122,3)`).
- `barrel.test.ts`'s function inventory goes 47 → 46 (`:34`).
- The stale `CHECKPOINT PARITY INVARIANT` doc block at
  `packages/sim/src/replay.ts:36-54` **is** rewritten, not left behind
  (`plan2-task-01-bot-hold-state.md:1201-1232`, "CHECKPOINT PARITY — RETIRED BY
  PLAN 2 TASK 1").
- **No conflict with Task 2 found.** Task 1 owns `phase.ts:28-53` and `:107-121`
  and `replay.ts:36-54/60/108-115/145/206-217/226`; Task 2 owns `recovery.ts`,
  `laps.ts`, `entity.ts`, `items.ts` and only reads `phase.ts:216`/`:225`.

### Task 2 — emit gating

**Gating IMPLEMENTED and its control test is strong; the signature deviates from the contract.**

- All eleven sites gated, enumerated from a real grep
  (`plan2-task-02-emit-gating.md:5`): `recovery.ts:66` (`startSpinOut`),
  `recovery.ts:162` (`beginRespawn`), `laps.ts:97`/`:107`,
  `entity.ts:76`/`:97`/`:256`/`:258`, plus the three pre-existing gates at
  `items.ts:136`, `phase.ts:219`, `phase.ts:226`. Every new gate is
  `if (ctx.isLeader) emit(...)` (`:136`, `:146`, `:258`, `:339`, `:670`, `:693`,
  `:721`, `:723`) — the mutation is left unconditional, so a follower's
  simulation is unchanged exactly as §1b:85-88 requires.
- `spawnEntity` and `despawnEntityAt` match contract §2a character for character
  (`:24-25` vs contract:128-131).
- **`startSpinOut` does not** — see Blocking #18.
- All `src` callers updated (`entity.ts:261`; `items.ts:243/253/263/273/284/294`;
  `entity.ts:265/283/289`), and Step 12 (`:278`) explicitly updates the six/seven
  `startSpinOut` call sites in `packages/sim/test/recovery.test.ts` that
  contract §1d does not list — closing the gap I flagged in the shared-file chain.
- **The parity control is real.** Step 30 (`:1201-1345`) builds one `SimState`,
  runs a single `step()` as leader and as follower from bit-identical `prev`s,
  and asserts `leaderEvents.length === 8` / `followerEvents.length === 0` with
  the exact kind multiset, then equalises `nextEventSeq` alone and asserts
  `statesEqual(nextLeader, nextFollower) === true` (`:1316-1319`). It drives all
  eight *newly*-gated sites — respawn, lapCross, finish, both `hit` branches,
  spinOut, entitySpawn, entityDespawn — and deliberately excludes the
  already-gated `itemGrant` by using a track with `itemBoxes: []`. This can
  genuinely fail in both directions.
  The one risk in it — that `packages/sim/src/phase.ts:107` routes any
  `isBot || !connected` kart through `botIntent` and discards `inputs[4].useItem`
  — does not bite: `entity.test.ts:61-62`'s `blankKart` is
  `isBot: false, connected: true`, so the `useItem` flag reaches kart 4 and the
  `entitySpawn` really fires. **Verified by applying the brief's edits to a
  scratch copy of `packages/sim` and running the test: it passes as written,
  8 leader events / 0 follower events, `statesEqual` true.**
- **Composition verified.** Tasks 1 and 2 applied together against a scratch
  `packages/sim`: `tsc --noEmit` clean and 483 passed / 1 skipped, once the three
  Step-level defects below (Blocking #19, #20, #21) are fixed. Their `src`
  footprints are disjoint — Task 1 owns `types.ts`/`state.ts`/`phase.ts`/`replay.ts`,
  Task 2 owns `laps.ts`/`recovery.ts`/`entity.ts`/`items.ts` — and although both
  edit `recovery.test.ts`, `entity.test.ts` and `laps.test.ts`, they touch
  non-adjacent regions (Task 1 the `makeSimState`/`blankState` literal bodies,
  Task 2 the `stubContext`/`makeCtx` helpers above them and the test bodies
  below). **Every one of Task 2's quoted "Before" blocks matches disk today, not
  Task 1's output** — the one exception is Step 17's `startSpinOut(ctx, state, k, …)`
  inside `updateEntities`, which is Task 2's own Step 12 output and therefore
  correct intra-task sequencing. This is the exact failure mode Plan 1's fix
  passes hit, and it does **not** recur here.

---

## Blocking defects

**1. The wire format drops `isBot` — 177 bits where the contract and spec lock 178.**
`plan2-task-05-quant.md:32-46` and `:236` (`expect(total).toBe(177)`), and
`plan2-task-06-snapshot.md:98-111`, `:523-525`, `:705`.
Contract §4:332 says "Per-kart total: **178 bits**" and §4:334-341 explains at
length why the two flags each get a bit: *"an implicit invariant that a future
task can silently break is not worth that."* Spec §5:379-384 says the same and
was amended on 2026-08-14 specifically to say it. Task 5's justification —
"matching contract §4's stated total exactly" (t05:39) — is **false against the
current contract**; it matches an earlier draft.
*Fix*: add `isBot: qf(0,1,1)` and `isBot: 0` to `Q`/`EPS`; add
`bw.writeBits(k.isBot ? 1 : 0, Q.isBot.bits)` immediately before the `connected`
bit in `encodeSnapshot` and the mirrored `readBits` in `decodeSnapshot`; change
`expect(total).toBe(177)` → `178` (t05:236) and `MAX_KARTS * 177` → `MAX_KARTS * 178`
(t06:525); delete t06:98-111's complementarity assumption.

**2. `Q`/`EPS` have 19 keys and the sixth continuous key is named `lapT`, not `t`.**
`plan2-task-05-quant.md:82-92`, `:324-327`, `:344`, `:370` vs contract §3:206-214
and §4:363-369 ("Only the six continuous rows above appear in `Q` and `EPS`… **The
key is `t`, not `lap.t`**"). `plan2-task-07-roundtrip-bounds.md:91-97, 135-142`
follows the contract and will throw `TypeError: Cannot read properties of
undefined (reading 'min')` at t07:151.
*Fix*: pick one. Recommended: keep T5's 19-key table (T6 legitimately needs the
exact-field bit widths in one place) but **rename `lapT` → `t`** everywhere
(t05:82, 196, 213, 257, 281, 324, 344, 370; t06:223, 575, 693, 761; t15:34, 371;
t16:123, 660), and amend contract §3's `QuantTable`/`EpsilonTable` to the 19-key
shape so the "eleven exact rows carry no epsilon" rule is preserved by the `EPS[f] === 0`
test (t05:260-269) rather than by absence.

**3. `WIRE_TAG`, `encodeHeader` and `decodeHeader` are never implemented.**
Contract §3:180-188 assigns all three to Task 3. `plan2-task-03-protocol-scaffold.md`
neither lists nor writes them (Produces block :34-44; implementation :137-148,
:304-333). Grep across all eighteen briefs: zero hits for `encodeHeader`.
*Fix*: add a Step to Task 3 that writes `WIRE_TAG` (exact hex values from
contract §3:182-186), `encodeHeader(out, kind): number` writing
`[tag, PROTOCOL_VERSION]` and returning 2, and `decodeHeader(buf): WireHeader`
throwing on unknown tag or version mismatch, plus its `tsc`-driven RED.

**4. Task 16 invents a conflicting tag scheme in `net`, and Tasks 14/15 do not use any.**
`plan2-task-16-shadow.md:325-329` defines `WIRE_TAG_INPUT = 4 …
WIRE_TAG_AUTHORITY_CHANGE = 8` in `packages/net/src/shadow.ts` and prefixes every
message with one byte (`:341`, `:695-704`), dispatching on `data[0]` (`:513-538`).
`plan2-task-14-authority.md:414-422` broadcasts **untagged** payloads and
`:365-367` decodes *every* unreliable datagram as input.
`plan2-task-15-client.md:485-486` decodes *every* unreliable datagram as a
snapshot and `:532-533` sends untagged input. Task 16 itself flags the hazard at
`:147-150` and `:921-926`; nobody acted on it.
*Fix*: after #3 lands, delete `WIRE_TAG_*` and `PROTOCOL_VERSION_BYTE` from
`shadow.ts`; have T14, T15 and T16 all call `encodeHeader(buf, kind)` before the
payload and `decodeHeader(data)` in `onMessage`, dispatching on `WireHeader.kind`.
Update T17:52-56/117/153/237/358-361/410-427 and T18:112-116/389-393/451
accordingly. `AUTHORITY_CHANGE_BYTES` stays at 10 (tag + version + two u32s) —
the layout already matches a 2-byte header.

**5. Tasks 14 and 15 import protocol codecs from a barrel that does not carry them yet.**
`plan2-task-14-authority.md:295` and `plan2-task-15-client.md:307` do
`import { EPS, INPUT_REDUNDANCY, decodeInput, decodeSnapshot, encodeEvents, encodeInput, encodeSnapshot } from '@tapkart/protocol'`.
Task 3's barrel is `export * from './types'` only (`plan2-task-03…md:388`) and no
task widens it before Task 18 (`plan2-task-18-barrels.md:312-334`). Under Vitest's
esbuild transform each name binds to `undefined`, so Task 14's Step 4 fails with
`TypeError: encodeSnapshot is not a function`.
*Fix (also resolves #6)*: have Tasks 4, 5, 6, 8, 9, 10 each append their own
`export * from './<module>'` line to `packages/protocol/src/index.ts` as their
final implementation step — exactly as Plan 1's tasks did for `@tapkart/sim`.
Task 18 then only adds the barrel *tests* and the ambiguity scan.

**6. Six briefs violate the contract's "`net` imports `@tapkart/protocol`, always" rule.**
`plan2-task-11-net-scaffold.md:215`, `:320`; `plan2-task-12-loopback.md:237`;
`plan2-task-16-shadow.md:300-304`; `plan2-task-17-integration.md:115-116`,
`:365-366`, `:597`. Contract §3:245-249 forbids this by name, and says it "would
survive into Plan 3."
*Fix*: with #5's progressive barrel in place, rewrite all of these to
`from '@tapkart/protocol'`. Also change Task 11's `net/src/index.ts` from
`export {}` (`:189`) to `export * from './transport'` per contract §3:248-249.

**7. Task 17's convergence test counts snapshots by a tag byte the authority never writes.**
`plan2-task-17-integration.md:271-273` counts
`channel === 'unreliable' && data[0] === WIRE_TAG_SNAPSHOT (5)`. `AuthorityLoop`
writes the bit-packed header first, so `data[0]` is the low byte of
`state.tick` — matching 5 roughly once per 256 snapshots. The floor at `:299-303`
(`MIN_STEADY_SNAPSHOTS` ≈ 758) fails.
*Fix*: falls out of #4.

**8. Task 17's convergence test never makes kart 0 a connected human on the host.**
`plan2-task-17-integration.md:266` builds `hostState = createState(ctxHost, SEED, CHARS)`
and never sets `hostState.karts[0].isBot = false` / `connected = true`.
`packages/sim/src/state.ts:60-61` defaults every kart to `isBot: true,
connected: false`, and `packages/sim/src/phase.ts:107` routes any
`isBot || !connected` kart through bot AI — so the authority **ignores the
client's input entirely** while `ClientLoop` drives its own seat from
`localIntent` (`plan2-task-15-client.md:468-469`). Permanent divergence, a
correction on every snapshot.
*Fix*: add the two field assignments before constructing `AuthorityLoop`, exactly
as `plan2-task-14-authority.md:184-185` and `plan2-task-15-client.md:643-644` do.

**9. Task 17's convergence test contradicts Task 15's own measured findings on three counts.**
Same file, `:242`, `:248`, `:282-292`:
 - `CHARS = [0,1,2,3,4,5,6,7]` on the host vs `ClientLoop`'s internal
   `ZERO_CHARACTER_IDX = [0,0,0,0,0,0,0,0]` (`plan2-task-15-client.md:322, 466`).
   Seats 1-7 then run different character stats on the two sides, so the bot
   trajectories diverge and can collide with kart 0. Task 15's equivalent test
   uses `CHARS8 = [0,…,0]` and explains why (`:947-951`).
 - `client.tick(scriptedIntent(t, 0))` is a **continuously varying** sine steer.
   Task 15's brief states, from a working prototype, that a varying input makes
   the authority's latency-held copy lag the client's current value by a real,
   non-quantisation margin, and that only a held-steady intent isolates the test
   to quantisation noise (`plan2-task-15-client.md:966-972`).
 - `WARMUP_TICKS = 180`. Task 15 measured 180 as flaky (1 run in 6, posdiff 0.057
   against a 0.05 epsilon) and settled on 360 (`:133-140`, `:975-978`).
 Task 17 also omits Task 15's item-box neutralisation (`:954-959`), which exists
 to stop a reliable-channel `itemGrant` racing an unreliable snapshot.
*Fix*: mirror Task 15's Step 12 setup exactly — `CHARS8`, `state.phase = 'racing'`,
`isBot=false/connected=true` on seat 0, item boxes neutralised, a held-steady
intent, `WARMUP_TICKS = 360`. Keep Task 17's snapshot-arrival floor; it is the one
thing Task 15's version is missing.

**10. Task 17's convergence test leaves the host in `'countdown'` for its whole warm-up.**
`plan2-task-17-integration.md:266` never sets `hostState.phase = 'racing'`, while
`ClientLoop`'s constructor does (`plan2-task-15-client.md:467`). For ticks 0-179
`resolveInputs` freezes every host kart (`packages/sim/src/phase.ts:100-103`)
while the client drives — and `WARMUP_TICKS` ends at t = 179, so the measured
window opens on the tick the host first starts moving.
*Fix*: set `hostState.phase = 'racing'` (as T14:219, T15:645, T15:945 all do), or
raise `WARMUP_TICKS` past `COUNTDOWN_TICKS + 360`.

**11. Task 17's promotion test can never observe the `authorityChange` it asserts.**
`plan2-task-17-integration.md:445-449` installs the spy on `pair.b`'s
**receive** path; `ShadowLoop.promote` broadcasts through that same
`shadowTransport` (`plan2-task-16-shadow.md:599`), and
`plan2-task-12-loopback.md:342` routes a message from side `b` to side **`a`**.
The spy never fires. `expect(authorityChanges).toHaveLength(1)` (t17:517) fails,
as do `:521-522`.
*Fix*: install the observer on `pair.a` (`spyTransport(pair.a, …)` for the host
side), or wrap `pair.b` with a spy that also intercepts `broadcast`.

**12. Task 17's late-join tests allocate 4096 bytes for a 5384-byte checkpoint.**
`plan2-task-17-integration.md:620` and `:638` use `new Uint8Array(4096)`;
`plan2-task-08-checkpoint.md:262` asserts `encodeCheckpoint` returns **5384**.
`DataView.setFloat64` past the view's end throws `RangeError`.
*Fix*: `new Uint8Array(8192)` in both places.

**13. Every snapshot buffer except Task 14's is smaller than the worst-case snapshot, and overflow is silent.**
`plan2-task-16-shadow.md:694` (`new Uint8Array(1 + 640) // 640 >= contract §4's
worst-case 625B snapshot`), `plan2-task-17-integration.md:420` (same figure), and
`plan2-task-06-snapshot.md:216` (`const BUF_SIZE = 512`, the only buffer figure
Task 6 states anywhere). Contract §4:352 and spec §5:424 both give **~743 B**
(742 B at Task 6's 177-bit record). `BitWriter.writeBits` assigns
`this.buf[byteIdx] |= …` (`plan2-task-04-bits.md:257`); a typed-array write past
the end is a **silent no-op**, so a snapshot with ≥26 live entities truncates
without error and every receiver decodes garbage. No test in the plan encodes at
`entityCount = MAX_ENTITIES`.
*Fix*: `new Uint8Array(1 + 1024)` in Tasks 16 and 17, matching
`plan2-task-14-authority.md:308`'s `SNAPSHOT_BUF_BYTES = 1024`; raise Task 6's
`BUF_SIZE` to 1024 and add a 32-entity encode/decode test.

**14. `ShadowLoop.promote()` writes `rngCursor` to `live`, but its own test reads it from `publish`.**
`plan2-task-16-shadow.md:607` sets `this.live.rngCursor = tick`; `this.publish`
(the caller's `state`) is only refreshed at the end of `tick()` (`:577`). The test
at `:830-831` calls `shadow.promote(state.tick)` and immediately asserts
`expect(state.rngCursor).toBe(tickBefore)` — `state.rngCursor` is still 0.
*Fix*: add `this.publish.rngCursor = tick` in `promote()`, or make the test tick
once before asserting.

**15. Three test files will not compile.**
 - `plan2-task-16-shadow.md:403` + `:416` and `:729` + `:739`: `await import(…)`
   inside a **non-async** `it(() => {…})` callback → syntax error. (The third
   instance at `:751` is correctly `async`.)
 - `plan2-task-16-shadow.md:406`, `:732`, `:754`: `onMessageCb` is declared with
   `channel: string` and assigned a callback contextually typed
   `channel: ChannelName`. Under `strict: true`'s `strictFunctionTypes`,
   `(p: string, c: ChannelName, d: Uint8Array) => void` is **not** assignable to
   `(p: string, c: string, d: Uint8Array) => void` → TS2322.
 - `plan2-task-17-integration.md:178`: `import type { ChannelName } from '../../src/transport'`
   — `transport.ts` never re-exports it (`plan2-task-11-net-scaffold.md:320-335`)
   → TS2305. Import it from `'../../../protocol/src/types'` (or, post-#6,
   `'@tapkart/protocol'`), as `scripted-input.ts` already does at `:115`.
 - `plan2-task-17-integration.md:413`: `require('../../protocol/src/input')` in an
   ESM module (`"type": "module"`, Vitest ESM) → `ReferenceError: require is not
   defined`. The brief's own note at `:549-554` offers the top-level-import fix;
   take it. Same defect at `plan2-task-18-barrels.md:502`
   (`require('@tapkart/sim')`).
 - `plan2-task-15-client.md:777` uses `WireKart` as a type annotation but no step
   ever adds `import type { WireKart }` to `client.test.ts` (Step 1 imports only
   `InputDatagram`; Step 5 and Step 8's import lists omit it) → TS2304.
 - `plan2-task-17-integration.md:233` imports `MAX_KARTS` and `:309` declares
   `const startX = 0`; neither is used → TS6133 under `noUnusedLocals`.
 - `plan2-task-16-shadow.md:292` imports `TICK_HZ`, never used → TS6133. (The
   brief already self-flags the unused `neutralIntent` helper at `:709-712`.)

**16. `ShadowLoop` hands `decodeInput` an empty `intents` array.**
`plan2-task-16-shadow.md:516`: `const dg: InputDatagram = { playerId: 0, intents: [] }`,
then `decodeInput(data.subarray(1), dg)`. `plan2-task-10-input.md:292-294` writes
`out.intents[i].tick = …` for `i < 8` and allocates nothing, per its own
documented contract (`:65`, `:283-287`). `out.intents[0]` is `undefined` →
`TypeError`.
*Fix*: hoist a pre-allocated `InputDatagram` with `INPUT_REDUNDANCY` intents onto
`ShadowLoop` as a field, the way `AuthorityLoop` already does
(`plan2-task-14-authority.md:344`). Note also that `:519`'s
`if (dg.intents.length === 0) return` becomes dead once the array is
pre-allocated — the emptiness check was standing in for the missing allocation.

**17. Task 2 ships `startSpinOut` with a different parameter order than contract §2a.**
Contract §2a:136-137 locks
`startSpinOut(ctx: SimContext, k: KartState, ticks: number, state: SimState, events: AuthEvent[]): void`
— both prepending `ctx` **and** moving `state` from position 1 to position 4.
`plan2-task-02-emit-gating.md:23` and `:323-329` ship
`startSpinOut(ctx: SimContext, state: SimState, k: KartState, ticks: number, events: AuthEvent[]): void`,
keeping the shipped `(state, k, ticks, …)` order. The brief calls itself "a
deviation from contract §2a's literal text" (`:23`) but attributes that solely to
*which* functions change shape — the parameter reorder is never disclosed. The
contract's own header forbids it: *"No task may rename, re-sign, or add fields to
anything below."* Both types are objects of different shape, so a Plan 3 caller
written against the contract fails to compile.
*Fix*: the brief's order is the better one (it preserves the shipped call shape).
Amend contract §2a:136-137 to `(ctx, state, k, ticks, events)` explicitly, rather
than letting Task 2 deviate silently.

**18. Task 1's Step 4 and Step 17 claim the suite stays green mid-task; it does not.**
`plan2-task-01-bot-hold-state.md:216` and `:1329` both assert the five
hand-built-`SimState` test files "never exercise `cloneState`/`statesEqual`/
`resolveInputs` on their hand-built states", so the breakage is "`tsc`-only".
They do: `packages/sim/test/entity.test.ts:871` and
`packages/sim/test/laps.test.ts:442` both call `step()`, which calls
`cloneState`. Reproduced on a scratch copy:
`TypeError: Cannot read properties of undefined (reading 'length')` at
`packages/sim/src/state.ts:153` (`dst.heldBotIntent.length`) — 2 failed / 474
passed. Step 17's own prose is self-contradictory: *"Expected: still FAIL — …
should actually be GREEN at this point."*
*Fix*: move Step 18 (the five literal fixes) ahead of Step 17, or restate both
steps' expectations as "2 failures in `entity.test.ts` and `laps.test.ts` until
Step 18".

**19. Task 1's Step 19 leaves three orphaned imports, so its "`tsc` exit code 0" fails.**
`tsconfig.base.json:15-16` sets `noUnusedLocals`/`noUnusedParameters`. Task 1
deletes the tests that were the sole users of three imports Step 13 explicitly
tells you to keep:
`packages/sim/test/replay.test.ts(3,10): error TS6133: 'COUNTDOWN_TICKS' is declared but its value is never read.`
and `packages/sim/test/replay.test.ts(15,1): error TS6192: All imports in import
declaration are unused.` (`COUNTDOWN_TICKS` was used only by the deleted
countdown-parity test at `replay.test.ts:491`; `makeIntentBuffer`/`resolveInputs`
only by the deleted dirty-hold test at `:429`.)
*Fix*: drop `COUNTDOWN_TICKS` from `replay.test.ts:3` and delete line 15 entirely.
With that, Task 1 is `tsc`-clean at 476 passed / 1 skipped.

**20. Task 2's Step 19 `stubContext()` audit misses two `it` blocks, so Step 20's typecheck fails.**
`plan2-task-02-emit-gating.md:882` claims it "grepped `stubContext()` against
every line range that calls `spawnEntity`/`despawnEntityAt`" and names **seven**
blocks. Two more exist inside `describe('updateEntities collision', …)`:
`packages/sim/test/entity.test.ts:703` (calls at `:710`, `:712`) and
`packages/sim/test/entity.test.ts:719` (calls at `:724`, `:726`). Neither has a
`ctx` in scope. After Step 19's `sed`, `tsc` reports
`error TS2304: Cannot find name 'ctx'` **four times**.
*Fix*: add `const ctx = stubContext()` to those two blocks as well — nine, not
seven. With that, Task 2 is `tsc`-clean at 484 passed / 1 skipped.

**21. Task 15's 30 Hz-send test asserts a quantised value to 5 decimal places.**
`plan2-task-15-client.md:274`: `expect(received[0].intents[7].steer).toBeCloseTo(0.02, 5)`.
`encodeInput` quantises `steer` over `[-1, 1]` at 8 bits
(`plan2-task-10-input.md:250`, `:273`), step `2/255 ≈ 0.00784`. `0.02` round-trips
to `-1 + 130/255 × 2 = 0.0196078…`, an error of `3.9e-4` against a `5e-6`
tolerance. (`:276`'s `0.2` happens to land exactly on a bucket and passes, which
is why this reads as fine.)
*Fix*: `toBeCloseTo(0.02, 2)`, or assert `Math.abs(actual - 0.02) < quantStep(-1, 1, 8)`
as `plan2-task-10-input.md:148` already does.

---

## Premises checked

Each row: a claim a brief makes about another brief's code, about shipped
`packages/sim`, or about the contract; and whether it holds.

| # | Claim | Where | Verified against | True? |
|---|---|---|---|---|
| 1 | "contract §4's stated total" is **177** bits per kart | t05:39 | contract:332 says **178** | **FALSE** |
| 2 | Contract §4 labels the per-kart record "177 bits" | t06:57, :61-63 | contract:332 | **FALSE** |
| 2b | Contract §4 labels the entity record "13 B" and the header "≈25 B", and Task 6 must "correct" both | t06:57-59, :73-93 | Contract §4:343-352 already specifies 135 bits and repudiates the 13 B figure in the same words; §4:354-356 gives 200 bits. The byte labels are the **spec's** (spec:418), not the contract's | **FALSE** — an argument with a superseded draft |
| 2c | Contract §4 mandates per-record byte alignment, which Task 6 diverges from | t06:57, :69-72 | Contract §4:358-361 already says the byte figures are "informational, not a padding rule" and that `BitWriter` "expose[s] no `align()` and none is wanted" | **FALSE** (conclusion right, premise wrong) |
| 2d | Spec §5's bandwidth figures are "typical ~287 B / worst-case ~625 B" and are stale | t06:86-88 | Spec:422-431 says ~304 B / ~743 B, recomputed 2026-08-14 from `8 × 178` kart bits | **FALSE** |
| 2e | Contract §4 contains a row `` `airborne`, `shielded`, `isBot`/`connected` \| 1 each `` | t06:98-100 | Contract §4:326-329 are **four** separate rows | **FALSE** — the whole basis of the 177-bit decision |
| 2f | "Task 1 already landed before this task starts", so `heldBotIntent`/`heldBotTick` exist | t06:140-143 | `packages/sim/src/types.ts:64-77` has neither today | **Precondition, not a fact** — correct once Task 1 runs, but Task 6's `makeState()` fixture (t06:283-284) and tests at t06:943-946, 959-960 do not compile without it |
| 3 | Contract §4's `angularVelocity` row says step `0.03125`, `lap.t` says `0.0009766` | t05:50-54 | contract:314 says `0.0312805`; :316 says `0.0009775` — both already correct | **FALSE** (T5 read a superseded draft; its assertions at :124-135 still pass, but the stated motive is wrong) |
| 4 | Contract §4's worst-case snapshot is **625 B** | t16:694 | contract:352 / spec:424: **743 B** | **FALSE** — Blocking #13 |
| 5 | Contract §4's worst-case snapshot is **~625 B** | t14:305-307 | same | **FALSE**, but T14's 1024-byte buffer is large enough anyway |
| 6 | "The contract's module map lists `packages/protocol/src/index.ts` as **[Task 18]**" | t11:40-42, t16:81-86, t17:12-16, t18:9-17 | contract:238 reads `[Task 3 creates, Task 18 widens]`, and :241-249 says so in prose | **FALSE** — the premise behind Blocking #6 |
| 7 | `ClientLoop`'s locked signature "exposes no way to read its predicted `SimState`" | t15:239-243, t17:20-23, t17:718-721 | contract §5:425 defines `state(): SimState` with the comment "the convergence test asserts on it directly" | **FALSE** |
| 8 | `AuthorityLoop` has no state accessor / "its constructor takes no input parameter at all" | t17:27-30 | contract §5:417 defines `state(): SimState`. (The no-input-param half is TRUE) | **HALF FALSE** |
| 9 | `startSpinOut` "has exactly one caller in `src`, verified" | contract §2a:144 | `grep -rn startSpinOut packages/sim/src` → declaration at `recovery.ts:51`, one call at `entity.ts:261` | **TRUE** |
| 10 | Exactly 3 of 11 `emit()` sites are gated today | contract §1b:83, t16:16-23 | `grep -n "emit(" packages/sim/src/*.ts` → 11 sites; `isLeader` guards at `phase.ts:216`, `phase.ts:225`, `items.ts:133` | **TRUE** |
| 11 | The eleven sites are in `recovery.ts` (×2), `laps.ts` (×2), `entity.ts` (×4), `items.ts` (×1), `phase.ts` (×2) | contract §1b:90-93 | `recovery.ts:66,162`; `laps.ts:97,107`; `entity.ts:76,97,256,258`; `items.ts:136`; `phase.ts:219,226` | **TRUE** |
| 12 | `rollItem` returns `'none'` immediately when `!ctx.isLeader`, leaving `rngCursor` untouched | t16:16-19, t13:73-76 | `packages/sim/src/items.ts:72` | **TRUE** |
| 13 | `updateItemBoxes`'s roll-and-emit block is inside `if (ctx.isLeader)` | t16:18-19 | `packages/sim/src/items.ts:133-137` | **TRUE** |
| 14 | `step()` starts with `cloneState(prev, next); next.tick = prev.tick + 1` and never mutates `prev` | t16:28-32 | `packages/sim/src/step.ts:26-28` (docstring) — behaviourally consistent with every caller | **TRUE** |
| 15 | `step()` never clears `events`; every caller does `events.length = 0` first | t14:24-28 | `packages/sim/src/replay.ts:167`, `:240` | **TRUE** |
| 16 | `state.phase` is already `'racing'` at `state.tick === COUNTDOWN_TICKS (180)` | t14:71-80 | `packages/sim/src/phase.ts:161-165` runs at the end of the same `step()` that produces tick 180 | **TRUE** |
| 17 | `resolveInputs` routes any kart with `!connected` through bot AI regardless of `isBot` | t14:391-394 | `packages/sim/src/phase.ts:107` (`if (k.isBot || !k.connected)`) | **TRUE** |
| 18 | `allocStateLike` is exported from `@tapkart/sim` | t14:15-20, t15:13-15, t16:58 | `packages/sim/src/replay.ts:82`, re-exported by `packages/sim/src/index.ts:30` | **TRUE** |
| 19 | `itemBoxWorldPos` and `kartById` are exported from `@tapkart/sim` | t14:53-56, t13:19-21 | `packages/sim/src/items.ts:89`, `packages/sim/src/entity.ts:113`, barrel lines 26-27 | **TRUE** |
| 20 | `rngAt(seed, cursor)` is stateless and `state.rngCursor` is the only cursor in the system | t12:28-42 | `packages/sim/src/rng.ts:12-31` (its own doc comment says exactly this) | **TRUE** |
| 21 | With seed `0xC0FFEE`, 8 unreliable sends deliver in order `[6,2,3,4,0,5,7,1]` and none is dropped | t12:196-197, :213 | Recomputed `rngAt(0xC0FFEE, ·)` against T12's own two-draws-per-send algorithm: order `[6,2,3,4,0,5,7,1]`, zero drops | **TRUE** |
| 22 | `packages/sim/test/fixtures/track-fixtures.ts` is not reachable via the `@tapkart/sim` specifier | t12:46-61, t08:97-106, contract §6:451-457 | `packages/sim/package.json` exports only `"." : "./src/index.ts"`; the barrel's 19 lines are all `./src/*` | **TRUE** |
| 23 | `EntityKind`'s six values are a strict subset of `ItemKind`'s nine, so `emit`'s `item` param accepts an `EntityKind` | t09:37-46, t13:141-147 | `packages/sim/src/types.ts:11-14`; call sites `entity.ts:76, 97, 256, 258` | **TRUE** |
| 24 | `phase.ts` emits a race-level `finish` with `playerId === -1` | t09:92-98, t13:114-117 | `packages/sim/src/phase.ts:226` | **TRUE** |
| 25 | `entity.ts` passes `ttl` (up to `Tuning.entityTtl = 600`) as `AuthEvent.data`, so 8 bits would truncate | t09:99-107 | `packages/sim/src/entity.ts:76`; `Tuning.entityTtl` at `types.ts:146` | **TRUE** |
| 26 | `laps.ts` emits `lapCross` only on the `idx === 0` branch, so `checkpointIdx` is derivable as `0` | t13:130-134 | `packages/sim/src/laps.ts:97` and its guard | **TRUE** |
| 27 | `startSpinOut` refuses a shorter spin than the one running, which is wrong for a receiver trusting the wire | t13:163-177 | `packages/sim/src/recovery.ts:59` (`if (ticks <= k.spinOutTicks) return`) | **TRUE** |
| 28 | `WireSnapshot` carries no placement/finish data, so `finishedOrder` is recoverable only from `finish` events | t13:97-103 | contract §3:270-289 — no such field | **TRUE** |
| 29 | `createState` defaults every kart to `isBot: true, connected: false` | t15:148-149 | `packages/sim/src/state.ts:60-61` | **TRUE** |
| 30 | A type-only import of a missing module passes vitest but fails `tsc` with TS2307 | t03:7-13, t11:88-101 | Consistent with `verbatimModuleSyntax: true` + `isolatedModules: true` in `tsconfig.base.json`; both briefs report direct experiment | **TRUE** (accepted) |
| 31 | `noUnusedParameters` flags an unused leading param even when later params are used | t13:179-194, t15:125-131 | `tsconfig.base.json` sets it; behaviour matches TS | **TRUE** |
| 32 | `applyEvent` covers every follower-visible consequence of an `itemGrant` | t13:150-161 | **Incomplete** — `packages/sim/src/items.ts:148-158` already ships `applyItemGrant`, which *also* starts the box's respawn timer. `applyEvent` sets only `k.item`, so a `ClientLoop` (which never predicts remote karts) never learns a remote pickup consumed a box | **FALSE (partial)** — non-blocking |
| 33 | "Vitest's Node environment supports [`require`]" inside an ESM test file | t17:549-554 | `packages/*/package.json` all set `"type": "module"`; Vitest transforms to ESM where `require` is undefined | **FALSE** — Blocking #15 |
| 34 | Task 16's `broadcast` reaches `ClientLoop` in Task 17's promotion topology | implied by t17:445-449 | `plan2-task-12-loopback.md:342` routes `b → a`; the spy observes `b`'s *receive* path | **FALSE** — Blocking #11 |
| 35 | Task 18's barrel RED is `Failed to resolve import "../src/index"` | t18:305-306, :522 | Task 3 (`:379-389`) and Task 11 (`:181-189`) both create the file | **FALSE** — cosmetic |
| 36 | `packages/sim` is untouched by Plan 2 beyond Tasks 1-2, so "477 tests" holds at Task 18 | t18:565 | Tasks 1 and 2 delete three parity tests and one poisoning test and add new ones; the count will differ | **FALSE** — cosmetic |
| 37 | `ClientLoop` "bootstraps with `characterIdx` all zero … neither affects this task's own kart's position" | t15:160-167 | True for seat 0's *grid placement*, but seats 1-7 then run different `CharacterStats` than a host built with `[0..7]`, which is exactly what breaks T17's convergence test | **TRUE in isolation, misleading in composition** — Blocking #9 |
| 38 | "Contract §2a states 'Only the two `entity.ts` helpers change shape'", and Task 2 must resolve that gap | t02:3 | **That string does not exist in the contract.** §2a:135-138 already declares `startSpinOut` with `ctx`, and :141-144 says verbatim: *"**Three** functions change shape, not two — an earlier draft of this section said two and was wrong."* | **FALSE** — a 300-word justification aimed at a superseded draft, which is also how the parameter-order deviation (Blocking #18) slipped in undisclosed |
| 39 | The five hand-built-`SimState` test files "never exercise `cloneState`/`statesEqual`/`resolveInputs` on their hand-built states", so Task 1's mid-task breakage is `tsc`-only | t01:216, :1329 | `packages/sim/test/entity.test.ts:871` and `packages/sim/test/laps.test.ts:442` both call `step()` → `cloneState`. Reproduced on a scratch copy: 2 runtime failures | **FALSE** — Blocking #19 |
| 40 | Task 1's Step 19 leaves `tsc` at exit code 0 | t01 Step 19 | TS6133 (`COUNTDOWN_TICKS`) + TS6192 (line 15) in `packages/sim/test/replay.test.ts` | **FALSE** — Blocking #20 |
| 41 | Task 2 Step 19 "grepped `stubContext()` against every line range that calls `spawnEntity`/`despawnEntityAt`" — seven blocks | t02:882 | Nine blocks; `packages/sim/test/entity.test.ts:703` and `:719` are missed → 4× TS2304 | **FALSE** — Blocking #21 |
| 42 | Task 1's `tsc` probe found exactly six `TS2739`s at six named locations | t01:14 | Reproduced exactly: `state.ts(111,3)`, `collision.test.ts(60,3)`, `entity.test.ts(106,3)`, `laps.test.ts(108,3)`, `placement.test.ts(56,3)`, `recovery.test.ts(122,3)` | **TRUE** |
| 43 | Task 1's even-tick replay test is a real control, not a vacuous replacement | t01:1116-1150 | Applied Task 1's edits with the module-scope hold **left in place** and only the guard deleted: the test **fails** (`expected false to be true` at `statesEqual(seg2.end, straight.end)`). With the hold in `SimState` it passes, bit-identical | **TRUE — it genuinely fails when the bug is present** |
| 44 | Task 2's full-tick parity test drives all eight newly-gated sites | t02:1224-1331 | Ran it: exactly 8 leader events (`respawn`, `lapCross`, `finish`, `entitySpawn`, `hit`×2, `spinOut`, `entityDespawn`), `nextEventSeq === 8`, 0 follower events, `statesEqual` true. `entity.test.ts:61-62`'s `blankKart` is `isBot:false, connected:true`, so `useItem` reaches kart 4; `stubContext`'s `itemBoxes: []` correctly excludes the already-gated `itemGrant` | **TRUE — a real control** |
| 45 | Task 2's edits apply on top of Task 1's without a stale "Before" | t02, all Steps | Every Task 2 "Before" matches disk today; the one non-disk "Before" (Step 17's `startSpinOut(ctx, state, k, …)` in `updateEntities`) is Task 2's own Step 12 output. Both tasks composed on a scratch copy: `tsc` clean, 483 passed / 1 skipped | **TRUE** — Plan 1's fix-pass failure mode does **not** recur |
| 46 | `packages/sim` still has "477 tests" at Task 18 | t18:565 | Measured: baseline 477 passed / 1 skipped (478 total) → Task 1 alone 477 total → Tasks 1+2 484 total | **FALSE** — cosmetic |

---

## Tests that cannot fail

Seven found. The first four are the highest-severity: each is the *only* assertion
standing behind a spec §8 clause.

1. **`plan2-task-17-integration.md:527`** —
   `expect(withinEps(hostAtKill.karts[0].position.x, hostAtKill.karts[0].position.x, EPS_POSITION)).toBe(true) // trivial identity guard`.
   Compares a value to itself. It is the entire implementation of spec §8:626's
   *"assert the shadow's state matches the host's last checkpoint within bounds."*
   The correct assertion compares `shadowState` (or the shadow's state at
   `lastMatchedTick`) against `hostAtKill`, per-field, with `withinEps`.

2. **`plan2-task-17-integration.md:503-514`** — the "no entity disappears" loop is a
   `for (const id of liveEntityIds) { /* comment only */ }` with **no `expect` inside
   it**, followed by `liveEntityIds.clear()`. It is the entire implementation of
   spec §8:626's *"no entity disappears."* The comment at `:508-511` argues the
   check is unnecessary; that argument belongs in a deleted test, not a silent one.

3. **`plan2-task-16-shadow.md:840-845`** — the same shape inside `ShadowLoop`'s own
   "never rewinds tick, lap, or a live entity" test: `if (!liveNow.has(id))
   liveBefore.delete(id)` with no assertion. The two surrounding assertions
   (`:836` `state.tick >= tickBefore`, `:838` `lap.lap >= lapsBefore[k]`) are also
   unfailable in this fixture: `tick` only ever increments and every kart's lap is
   0 for the whole 80-tick run. The test's name promises three guarantees and
   delivers none.

4. **`plan2-task-07-roundtrip-bounds.md:167-186`** — both "that invariant actually has
   teeth" tests. `const badEpsilon = step; expect(badEpsilon).not.toBeGreaterThan(step)`
   asserts `!(x > x)`; `expect(badEpsilon >= step).toBe(true)` and
   `expect(badEpsilon > step).toBe(false)` assert properties of JavaScript's
   comparison operators. Neither reads `EPS`. Neither can go red for any content
   of `quant.ts`. This is precisely the Plan 1 control-test failure mode: a test
   whose stated job is proving a check has teeth, which itself has none. A real
   control would perturb the table — e.g. assert that
   `EPS.position > quantStep(...)` fails when evaluated against a deliberately
   under-tuned copy of `EPS`.

5. **`plan2-task-17-integration.md:310`** —
   `expect(Math.abs(hostState.karts[0].position.x) + Math.abs(hostState.karts[0].position.z)).toBeGreaterThan(1)`,
   labelled "guards against a topology bug … that would make every assertion above
   trivially true because nothing happened anywhere." `createState` places seat 0 at
   the oval's first control point, `(-200, ·, -100)` (`plan2-task-12-loopback.md:71-74`),
   so the sum is 300 before a single tick runs. Compare against the kart's own
   *start* position instead.

6. **`plan2-task-15-client.md:232-244`** — `it('steps its own kart forward every tick()
   call, driven by localIntent')` asserts only `expect(client.corrections()).toBe(0)`
   with no snapshots ever delivered. It cannot fail unless `tick()` throws, and it
   tests nothing about its own title. Fixable for free once `ClientLoop.state()`
   exists (contract §5:425).

7. **`plan2-task-15-client.md:720-747`** — `it('an itemGrant received over the reliable
   channel updates the local kart before the next tick() returns')` asserts only
   `expect(() => client.tick(mkIntent(0))).not.toThrow()`. The brief admits it at
   `:743-745`. Again free once `state()` exists.

8. **`plan2-task-06-snapshot.md:411-412`** — `expect(d1.connected).toBe(false)` and
   `expect(d1.isBot).toBe(true)`, inside the test that is supposed to prove the
   `isBot = !connected` derivation. Both values equal `makeWireKart`'s defaults
   (`isBot: true, connected: false`, t06:306-307), so the decode half of the
   derivation is never exercised. Same file, same shape: `:376`
   (`entityCount === 0`, the default), `:404` (`playerId === 0`, the default),
   `:436` (`t === 0`, the default), `:488-490` (the dead-slot tail loop passes
   with no re-sentinelling at all, because `makeWireEntity` already returns
   `entityId: -1`), `:875` (`respawnTicks === 0`, the default), `:924`
   (`entityCount === 0`, the default). Test 11 at `:927` ("does not touch unwired
   fields") passes if `applySnapshotToState` is a complete no-op — it is a purely
   negative test with no positive companion in the same `it`.

*Near-miss, worth naming*: `plan2-task-15-client.md:998` and `:666` assert
`corrections() - baseline === 0` with **no** control proving snapshots arrived and
were compared. If `pendingSnapshot` were never set — the exact symptom Blocking #4
produces — both pass vacuously. Task 17's version at `:299-303` has the missing
control; Task 15's does not. Port it.

---

## Non-blocking observations

1. **`lastProcessedInputTick`'s `-1` sentinel is not biased on the wire.**
   `plan2-task-06-snapshot.md:677-679` writes each entry with `writeBits(v, 16)`;
   `BitWriter.writeBits(-1, 16)` (`plan2-task-04-bits.md:253-260`) computes
   `Math.floor(-1 / 2**i) % 2 === -1`, which is truthy, so `-1` encodes as
   `0xFFFF` and decodes as **65535**. Both `AuthorityLoop` (`:341`) and Task 17
   (`:422`) pass `-1`-filled arrays. Nothing consumes the field yet, so it is
   latent — but Task 9 biased `playerId` and `entityId` by `+1` for exactly this
   reason (`plan2-task-09-events.md:80-81`) and this row should match.

2. **`applyEvent` drops the item-box half of an `itemGrant`.** See Premise #32.
   `packages/sim/src/items.ts:148-158` (`applyItemGrant`) already exists and does
   both halves. Either call it from Task 13's `itemGrant` case or replicate the
   `box.respawnTicks` write.

3. **Duplicate 20 Hz constant.** `SNAPSHOT_INTERVAL_TICKS` (private,
   `plan2-task-14-authority.md:299`) and `SNAPSHOT_PERIOD_TICKS` (exported,
   `plan2-task-16-shadow.md:310`). Task 17 imports the shadow's while testing the
   authority (`:237`). One exported constant, in one place.

4. **`ShadowLoop.promote()` mutates the caller's `SimContext`** (`:608`
   `this.ctx.isLeader = true`), while `AuthorityLoop` (`:352`) and `ClientLoop`
   (`:462`) both defensively copy theirs. Task 16's own tests depend on the
   mutation (`:808`, `:813`, `:832`). Not wrong, but the three loops should agree
   on whether `ctx` is owned or borrowed.

5. **`ClientLoop.tick()` allocates every tick**: `makeIntentBuffer()` (`:508`),
   `allocStateLike()` (`:516`), a fresh `events` array (`:512`) and a spread
   `{ ...localIntent }` (`:519`). `allocStateLike` runs `createState`, which does
   eight track samples. Contract §0's no-allocate rule is scoped to codecs, so
   this is legal — but it is 128 live `SimState`s in the ring at steady state.

6. **`ShadowLoop.heldInputForLeader()`** (`:589-593`) returns `this.heldInput`
   unconditionally, making the ternary at `:556` a no-op. Delete one or the other.

7. **`plan2-task-14-authority.md:341` names the field `lastAppliedInputTick` and
   sets it on receipt**, then passes it as `encodeSnapshot`'s
   `lastProcessedInputTick` (`:420`). Spec §5:459-460 defines it as "the newest
   input from that player the authority had **folded in**." One tick of skew;
   harmless today because nothing compares against it (contract's own ruling), but
   the names should match the spec's.

8. **`plan2-task-01`'s stale doc block.** `packages/sim/src/replay.ts:36-54`'s
   `CHECKPOINT PARITY INVARIANT` section, including "`replayRun` enforces this at
   runtime (see `needsOddCheckpoint`)", survives a task that deletes both. Delete
   the block in Task 1.

9. **Task 14 Step 6 and Task 15 Step 6 are explicitly non-RED steps**
   (`t14:579-595`, `t15:751-761`) — both say "if this is green, skip ahead." Honest,
   and better than manufacturing a red, but it means five of Task 15's ten tests
   and three of Task 14's six never had a failing run.

10. **`ClientLoop` forces `predicted.phase = 'racing'` at construction**
    (`:467`) with no `'start'` message to synchronise against. Every test that
    pairs it with an authority must remember to set the host's phase too — which
    Task 17 forgets (Blocking #10). A `start` handshake is contract-deferred, so
    a comment at the constructor naming the requirement is the cheap fix.

11. **Task 12 compiles `packages/sim/test/fixtures/track-fixtures.ts` under
    `packages/net`'s tsconfig** via `'../../../sim/test/fixtures/track-fixtures'`
    (`:432`). It works and the contract's intent is satisfied, but `packages/net`'s
    `include` no longer describes what `tsc -p packages/net` actually reads.

12. **Contract §4's `position` step is slightly wrong in prose.** `2048/65535 =
    0.0312524`, not the tabulated `0.0312548` (contract:311). No task asserts it;
    every task derives the step through `quantStep`. Fix the prose so the next
    reader does not "correct" the code.

13. **Task 16's `AUTHORITY_CHANGE_BYTES = 10` layout** (`tag u8 + protocolVersion
    u8 + tick u32LE + eventSeq u32LE`, `:331`) is already shaped like contract §3's
    2-byte header. Once Blocking #3/#4 land, `encodeAuthorityChange` becomes
    `encodeHeader(out, 'authorityChange')` plus two `setUint32`s with no size change.

14. **`applySnapshotToState` leaves a stale entity `targetId` on a re-sentinelled
    slot.** `plan2-task-06-snapshot.md:1028-1044` copies every dead slot's fields
    from the wire but skips `targetId` (deliberately — `WireEntity` has no such
    field), while `packages/sim/src/entity.ts:25-38`'s `clearSlot` sets it to
    `-1` and `packages/sim/src/state.ts:291` compares it in `statesEqual`. Task
    16's `reconcile` calls `applySnapshotToState` (`:620`, `:628`), so a shadow
    corrected after a seeker despawns carries residue the leader does not. Set
    `e.targetId = -1` whenever `snap.entities[i].entityId === -1`.

15. **`BitWriter.writeBits` neither clamps nor masks** (`plan2-task-04-bits.md:243-250`),
    and Task 6 feeds it un-ranged `SimState` values (`:694-706`, `:711-721`).
    `createState` writes `lap.checkpointIdx = -1` when a track declares no
    checkpoints (`packages/sim/src/state.ts:39`); `writeBits(-1, 6)` decodes as
    63. The shipped oval fixture has checkpoints so no test trips it, but a
    6-bit `checkpointIdx` also caps a track at 64 checkpoints with no validator
    saying so.

16. **`snapshot.ts` and its test each keep their own copy of `ITEM_KINDS`/`SURFACES`**
    (`plan2-task-06-snapshot.md:626-630` and `:556-557`). A reorder desynchronises
    silently in two places, and the wire-order test (`:529-593`) would still pass.
    Import the tables from `snapshot.ts` in the test, or move them to `types.ts`.

17. **`snapshot.ts` allocates a `BitWriter`/`BitReader` per call**
    (`plan2-task-06-snapshot.md:673`, `:740`) and never calls `reset()`,
    contradicting Task 4's stated rationale for `reset()`
    (`plan2-task-04-bits.md:55-62`: "one `BitWriter`/`BitReader` pair reused every
    tick rather than constructed fresh") and contract §0:28's "codecs never
    allocate". Two small objects per snapshot, so it is a style break rather than
    a hot-path problem — but `reset()` currently has no caller anywhere in the plan.

18. **Task 2's Step 11 is a no-op step**: `plan2-task-02-emit-gating.md:272-276`
    says "run it to see the real error text Step 12 responds to" and then
    "(No command to run here)". Delete it.

19. **Task 1's Step 13 heading undercounts its own edits**:
    `plan2-task-01-bot-hold-state.md:822` says "`phase.test.ts` — five edits" and
    then lists six (Edit 1-6). Cosmetic.

20. **Task 2's Produces bullet hedges unnecessarily**:
    `plan2-task-02-emit-gating.md:26` says `startSpinOut`/`beginRespawn` get "an
    equivalent single-line guard". They get the identical
    `if (ctx.isLeader) emit(...)` form as the other six (`:339`, `:258`). Drop
    the hedge so a reader does not go looking for a second gating idiom.

21. **Test-count arithmetic for the plan's final verification.** Measured on a
    scratch tree: baseline 477 passed / 1 skipped; Task 1 alone → 477 total;
    Tasks 1+2 → 484 total. Task 18's Step 11 expectation of "477+" tests in
    `sim` (`plan2-task-18-barrels.md:565`) and Task 11's "477 from Plan 1 plus
    this task's 4" (`plan2-task-11-net-scaffold.md:366`) both need restating.

22. **Spec §5's WebRTC and WebSocket transports have no task.** The contract's §5
    module map lists only `transport.ts` and `loopback.ts`, so this is a knowing
    deferral rather than an oversight — but "one interface, three implementations"
    is currently one interface and one implementation, and spec §5:557-558's
    symmetric-NAT fallback has nothing to fall back to.
