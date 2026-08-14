# Plan 2 Audit B — Tasks 10–18

Auditor scope: `docs/superpowers/plans/parts/plan2-task-10-input.md` through
`plan2-task-18-barrels.md`, checked against the current
`docs/superpowers/plans/2026-08-14-tapkart-plan2-contract.md` and
`docs/superpowers/specs/2026-08-13-tapkart-design.md` (§3, §4, §5, §8), with
premises spot-checked against the real merged `packages/sim` (`1f1f2c4`).

---

## Blocking defects

### B1. The promotion test's headline assertions are vacuous — it cannot detect a broken `ShadowLoop`

**Task 17**, `packages/net/test/promotion.test.ts` (brief lines 524–527):

```ts
// "Matches the host's last checkpoint within bounds": compare the shadow's state at the tick
// it last agreed with the host against that saved host state, at that SAME tick.
expect(shadowCtx).toBeDefined() // documents that ctx.isLeader flips are exercised via authorityChanges above
expect(withinEps(hostAtKill.karts[0].position.x, hostAtKill.karts[0].position.x, EPS_POSITION)).toBe(true) // trivial identity guard
```

`withinEps(hostAtKill.karts[0].position.x, hostAtKill.karts[0].position.x, EPS_POSITION)` compares
`hostAtKill` to **itself**. It is `Math.abs(x - x) <= eps`, which is `true` for every `x` and every
`eps >= 0`, unconditionally — the comment even calls it a "trivial identity guard." The comment two
lines above states the actual intent ("compare the shadow's state ... against that saved host
state"), but `shadowState` (a real, mutating object available throughout the test) never appears in
this comparison. Spec §8's stated requirement for this exact test — *"the shadow's state matches the
host's last checkpoint within bounds"* — is asserted in prose at the top of Task 17 (line 16-17) and
never checked in code. `expect(shadowCtx).toBeDefined()` is equally inert: `shadowCtx` is a plain
object assigned earlier in the test and can never be anything but defined.

A `ShadowLoop` that never reconciled at all, or reconciled onto the wrong kart, or dropped every
kart but kart 0, would pass this test exactly as written.

**Fix:** capture a shadow-side snapshot at the same instant `hostSnapshotAtKill` is captured (e.g.
`shadowStateAtKill = structuredClone(shadowState)` inside the same `if` block that sets
`lastMatchedTick`), then after the run assert `withinEps` between `shadowStateAtKill.karts[i]` and
`hostAtKill.karts[i]` for every kart `i`, not `hostAtKill` against itself. Delete the
`toBeDefined()` line; it asserts nothing.

### B2. The promotion test's "no entity disappears" check has an empty loop body — it asserts nothing

**Task 17**, `packages/net/test/promotion.test.ts` (brief lines 501–514), inside the post-kill loop:

```ts
const nowLive = new Set<number>()
for (let i = 0; i < shadowState.entityCount; i++) nowLive.add(shadowState.entities[i].entityId)
for (const id of liveEntityIds) {
  // An entity may legitimately expire; it must never simply vanish without its ttl having
  // run out. shadowState only exposes the CURRENT ttl, so an entity gone this tick is only
  // acceptable if it is no longer tracked as live — remove it from the watch set either way
  // and rely on the ring-buffer-free "ttl decrements by exactly 1/tick" definition to make
  // "vanished with ttl > 1 last seen" the only failure worth catching, which the promotion
  // mechanism (no rewind) rules out by construction: ...
}
liveEntityIds.clear()
for (const id of nowLive) liveEntityIds.add(id)
```

The `for (const id of liveEntityIds)` loop body is a comment and nothing else — no `expect`, no
computation, no side effect beyond what the two lines outside it already do. The reasoning in the
comment ("ShadowLoop's own tests already prove promotion never rewinds tick, so this loop only needs
to keep the watch set current") is used to justify *not* asserting the very property
(`no entity disappears`) that spec §8 names this test as responsible for proving end-to-end. There is
no other entity-related `expect` anywhere else in `promotion.test.ts`. Combined with B1, two of the
four properties spec §8 names for the promotion test ("matches ... within bounds", "no entity
disappears") are asserted in prose only. Only "no lap counter regresses" (the `lapMax` checks) is a
real, fail-able assertion; "no event is applied twice" is checked only by a disconnected unit test of
`applyEvent` at the bottom of the file, not within the scripted promotion scenario itself.

**Fix:** track, for each entity id last seen live, either (a) that it still appears in
`shadowState.entities` with `ttl` having decremented monotonically since last observed, or (b) that
it is now absent *and* was last observed with `ttl <= 1`. Assert the disjunction; fail with the
entity id and last-seen ttl otherwise.

### B3. `AuthorityLoop` and `ClientLoop` are missing the `state()` accessor the current contract requires

Current contract §5:

```ts
export class AuthorityLoop {
  constructor(ctx: SimContext, state: SimState, t: Transport)
  tick(): void
  state(): SimState         // read-only view, so the promotion test can compare authorities
}
export class ClientLoop {
  constructor(ctx: SimContext, playerId: number, t: Transport)
  tick(localIntent: Intent): void
  corrections(): number
  state(): SimState         // read-only view; the convergence test asserts on it directly
}
```

- **`plan2-task-14-authority.md`**, "Produces" (line 58): `export class AuthorityLoop { constructor(ctx: SimContext, state: SimState, t: Transport); tick(): void }` — no `state()`. The Step 3 implementation (lines 334–424) has no such method.
- **`plan2-task-15-client.md`**, "Produces" (lines 48–49): same omission; Step 3's `ClientLoop` (lines 429–606) has no `state()` method. The brief repeatedly documents the absence as a constraint rather than a defect (e.g. line 239: *"No direct accessor for predicted state exists (locked constructor/tick/corrections only)"*).
- Downstream cost: **`plan2-task-16-shadow.md`**'s closing "Ambiguities" section (item 2, lines 927–931) and **`plan2-task-17-integration.md`**'s entire "hazard" framing (lines 20–35, 209–224) exist to work around this exact absence — Task 17's convergence test is forced to argue `corrections()` is *equivalent to* a direct state comparison rather than simply doing one, and its promotion test hand-rolls a hand-rolled `makeFakeHost()` rather than driving a real `AuthorityLoop` at all (a separate, related gap — see the "Test quality" section).

**Fix:** add `state(): SimState { return this.state }` to `AuthorityLoop` and
`state(): SimState { return this.predicted }` to `ClientLoop`. Once present, Task 17's convergence
test can assert `client.state().karts[0]` directly against dequantized wire data instead of arguing
`corrections()` is a sufficient proxy, and the promotion test's B1 fix becomes trivial if it is ever
extended to drive a real `AuthorityLoop`.

### B4. Task 16 invents its own `WIRE_TAG_*`/tag-byte scheme instead of the contract's shared `WIRE_TAG`/`encodeHeader`/`decodeHeader`

This is the exact defect the contract's own §3 text names: *"Without a shared tag a receiver cannot
dispatch, and each of Tasks 11/14/15/16 would invent its own — which is exactly what happened when
this was left unspecified."*

**`plan2-task-16-shadow.md`**, "Wire format this task defines because no other task does" (lines
129–150) defines:

```ts
export const WIRE_TAG_INPUT = 4
export const WIRE_TAG_SNAPSHOT = 5
export const WIRE_TAG_EVENTS = 6
export const WIRE_TAG_CHECKPOINT = 7
export const WIRE_TAG_AUTHORITY_CHANGE = 8
```

and implements it throughout: Step 3 (lines 325–352, including a hand-rolled `encodeAuthorityChange`/
`decodeAuthorityChange` that writes tag+version+payload manually), Step 7's `onMessage` dispatch
(lines 512–539, `const tag = data[0]`), `broadcastSnapshot`/`broadcastEvents`/`promote()` (lines
595–610, 693–706). This entire scheme is superseded by the current contract §3:

```ts
export const WIRE_TAG = {
  hello: 0x01, welcome: 0x02, lobby: 0x03, start: 0x04,
  input: 0x10, snapshot: 0x11, events: 0x12, checkpoint: 0x13,
  authorityChange: 0x20, ping: 0x30, pong: 0x31,
} as const
export function encodeHeader(out: Uint8Array, kind: MessageKind): number  // 2 bytes: tag + version
export function decodeHeader(buf: Uint8Array): WireHeader                 // throws on unknown tag/version
```

Task 16's own numbering (4,5,6,7,8) does not match the contract's (0x10, 0x11, 0x12, 0x13, 0x20), and
Task 16 writes a bare 1-byte tag (plus its own separate version byte, hand-assembled) rather than
calling `encodeHeader`/`decodeHeader`.

**Fix:** delete `WIRE_TAG_INPUT`…`WIRE_TAG_AUTHORITY_CHANGE` and the hand-written header bytes in
`encodeAuthorityChange`/`decodeAuthorityChange`; import `WIRE_TAG`, `encodeHeader`, `decodeHeader`
from `packages/protocol/src/types.ts` (via `@tapkart/protocol`, see B5); dispatch in `onMessage` via
`decodeHeader(data).kind` instead of `data[0]`; `encodeAuthorityChange` should call
`encodeHeader(out, 'authorityChange')` for its first 2 bytes, then write `tick`/`eventSeq` after —
`AUTHORITY_CHANGE_BYTES` stays 10 (2 header + 8 payload), only the header's byte values change.

### B5. `AuthorityLoop` and `ClientLoop` never tag their messages at all — inconsistent with `ShadowLoop`'s tag-based dispatch (self-consistency across Tasks 14/15/16)

Independent of B4's specific tag values, there is a structural mismatch: **`ShadowLoop` requires every
message to begin with a kind tag** (it must tell a client's input datagram apart from the host's
`WireSnapshot`, since spec §5 has every client send input to *both* the host and the shadow, both over
`'unreliable'`), but **`AuthorityLoop` (Task 14) and `ClientLoop` (Task 15) never attach or expect any
tag byte**:

- `plan2-task-14-authority.md` Step 3 (lines 360–423): `onMessage` does `decodeInput(data, ...)`
  directly on the raw received bytes; `tick()` broadcasts `this.eventsBuf.slice(0, n)` and
  `this.snapshotBuf.slice(0, n)` with no header prepended.
- `plan2-task-15-client.md` Step 3 (lines 484–539): `onMessage` does `decodeSnapshot(data, ...)`/
  `decodeEvents(data, ...)` directly on raw bytes; `tick()` sends
  `this.transport.broadcast('unreliable', this.sendBuf.slice(0, n))` — raw `encodeInput` bytes, no
  header.

Once a `ShadowLoop` is on the same room's transport (the deployed topology per spec §5 — "every client
sends its input to both the host and the server shadow"), `AuthorityLoop`'s snapshot broadcast and
`ClientLoop`'s input broadcast are exactly the untagged payloads `ShadowLoop`'s `onMessage` tries to
read `data[0]` off of — `data[0]` would be the first raw payload byte (part of the quantized `tick`
field or similar), not a valid tag, and `decodeHeader` (once B4 is applied) would throw. Point-to-point
loopback tests in Tasks 14 and 15 never exercise a third party, so this defect is invisible to any
test in the current briefs.

**Fix:** every `broadcast`/`send` call in `AuthorityLoop` and `ClientLoop` must call
`encodeHeader(buf, kind)` first (writing the 2-byte header) and then the payload encoder into
`buf.subarray(2)`, incrementing the byte count returned/sliced accordingly; every `onMessage` must
call `decodeHeader(data)` first, branch on `.kind`, and pass `data.subarray(2)` to the matching
payload decoder. This also fixes the buffer-size constants (`SNAPSHOT_BUF_BYTES`, `EVENTS_BUF_BYTES`,
`SEND_BUF_BYTES`) trivially (2 bytes of headroom already exists in all three).

### B6. Tasks 11, 12, 16, 17, 18 assume `packages/protocol`'s barrel is empty until Task 18 — contradicted by the current contract and by Tasks 14/15 in the same territory

Current contract §3: *"The barrel exists from Task 3, not Task 18ǃ Task 3's scaffold creates
`packages/protocol/src/index.ts` already re-exporting `./types` ... `net` imports `@tapkart/protocol`,
always. The same applies to `packages/net/src/index.ts`: Task 11's scaffold creates it re-exporting
`./transport`, Task 18 widens it."*

This is contradicted, at length, by five briefs in my territory:

- **`plan2-task-11-net-scaffold.md`**, Interfaces block (lines 37–59): argues `ChannelName` "**must**"
  be reached by a relative import because "`packages/protocol/src/index.ts` is still the empty
  `export {}` stub" at the time Task 11 runs, and concludes *"resolving `@tapkart/protocol` as a bare
  specifier before Task 18 lands would hit that still-empty barrel and find no `ChannelName` at all."*
  Step 5 (lines 179–190) accordingly writes `packages/net/src/index.ts` as an empty `export {}`
  instead of `export * from './transport'`. Step 9 (line 320) has `transport.ts` import
  `ChannelName` from `'../../protocol/src/types'`. The commit message (lines 386–388) repeats the same
  now-false rationale.
- **`plan2-task-12-loopback.md`**, Interfaces block (lines 22–25) and Step 3 (line 237): same relative
  import of `ChannelName`, same stale justification ("Same reasoning as Task 11's transport.ts").
- **`plan2-task-16-shadow.md`**, Interfaces block (lines 80–86): *"`packages/protocol`'s own barrel is
  Task 18 ... `packages/net`'s tasks 11–17 therefore cannot `import … from '@tapkart/protocol'`; every
  cross-package import in this file (and in Task 17's) goes by relative path."* Step 3/Step 7 code
  (lines 297–304) imports every protocol module via `'../../protocol/src/*'`.
- **`plan2-task-17-integration.md`**, Interfaces block (line 71): *"relative, not `@tapkart/protocol`:
  see Task 16's Interfaces block for why."* `scripted-input.ts` (lines 115–117) follows suit.
- **`plan2-task-18-barrels.md`**: the entire brief is framed around this premise — "Why two packages in
  one task" (lines 9–17), "Assumption stated up front" (lines 19–25), fact 6 (lines 51–55: *"nothing
  in Tasks 11–17 needs to be rewritten to use `@tapkart/protocol` now that it exists"*). Its RED-step
  predictions are consequently **wrong under the current contract**: Step 2 (lines 302–308) predicts
  `Failed to resolve import "../src/index"` for `packages/protocol/test/barrel.test.ts`, but per the
  corrected contract `packages/protocol/src/index.ts` already exists (Task 3 created it, re-exporting
  `./types`) — the real failure is a *missing named export* error (e.g. `does not provide an export
  named 'BitReader'`), not a resolution failure. Step 7 (lines 519–522) has the identical problem for
  `packages/net/src/index.ts` once B-fixed Task 11 creates it re-exporting `./transport`. Step 3/Step
  8's "Create" instructions (lines 310–334, 524–541) should be "widen" instructions (append the
  remaining `export * from` lines to an existing file), not fresh creation.

Two briefs in the *same* territory already got this right — **`plan2-task-14-authority.md`** Step 3
(line 294: `import type { ChannelName, InputDatagram } from '@tapkart/protocol'`) and
**`plan2-task-15-client.md`** Step 3 (line 306: same) both correctly use the bare specifier — proving
the amendment landed after some of these briefs were drafted and before others.

**Fix:** in Tasks 11, 12, 16, 17: replace every `'../../protocol/src/<module>'` import with
`@tapkart/protocol`. In Task 11: populate `packages/net/src/index.ts` with
`export * from './transport'` at Step 5, not `export {}`. In Task 18: rewrite the "why two packages"
framing and both RED-step predictions to reflect that Task 3 and Task 11 already ship partial
barrels; Steps 3/8 become "append the remaining six/five `export * from` lines," and the RED-step text
becomes a missing-named-export message.

### B7. Task 15 and Task 16 use `EPS.lapT`; the current contract's field name is `t`

Contract §3/§4: `EpsilonTable` keys are `position | velocity | heading | angularVelocity | driftCharge
| t`, and §4 states explicitly: *"The key is `t`, not `lap.t`, matching the flat `WireKart` interface
in §3."*

- **`plan2-task-15-client.md`**, line 34 (the stated assumption): *"... `driftCharge`, `lapT`."* — and
  line 371 (`ownKartDiverged`): `if (Math.abs(predicted.lap.t - wire.t) > EPS.lapT) return true`.
- **`plan2-task-16-shadow.md`**, line 123 (the stated assumption) and line 660 (`diverges`):
  `if (exceeds(k.lap.t, w.t, EPS.lapT)) return true`.

Both briefs frame this as an assumption they *chose*, self-flagged as correctable ("If Task 5 ships
different property names, only this task's six `EPS.*` reads need renaming"). Under the amended
contract this is no longer an open assumption — `EPS.t` is pinned — so both are simply wrong as
written, not merely unverified.

**Fix:** rename `EPS.lapT` → `EPS.t` at both sites (client.ts's `ownKartDiverged`, shadow.ts's
`diverges`), and in the corresponding prose in both briefs.

---

## Contract drift

| Brief | Location | Superseded text cited | Current contract text |
|---|---|---|---|
| Task 11 | Interfaces, lines 37–59; Step 5 lines 179–190; Step 9 line 320; commit msg 386–388 | "`packages/protocol/src/index.ts` is still the empty `export {}` stub" / relative import required | §3: "The barrel exists from Task 3, not Task 18 ... `net` imports `@tapkart/protocol`, always." Net's own barrel: "Task 11's scaffold creates it re-exporting `./transport`." |
| Task 12 | Interfaces lines 22–25; Step 3 line 237 | "packages/protocol's barrel is deferred to the shared Task 18" | Same as above |
| Task 16 | Interfaces lines 80–86; Step 3/7 lines 297–304 | "`packages/protocol`'s own barrel is Task 18 ... every cross-package import ... goes by relative path" | Same as above |
| Task 16 | Interfaces "Wire format" lines 129–150; Step 3 lines 325–352; Step 7 lines 512–539 | Self-invented `WIRE_TAG_INPUT=4 .. WIRE_TAG_AUTHORITY_CHANGE=8`, hand-rolled header bytes | §3: `WIRE_TAG` object (`input:0x10, snapshot:0x11, events:0x12, checkpoint:0x13, authorityChange:0x20, ...`) + `encodeHeader`/`decodeHeader` |
| Task 17 | Interfaces line 71; `scripted-input.ts` fixture lines 115–117 | "relative, not `@tapkart/protocol`: see Task 16's Interfaces block for why"; imports `WIRE_TAG_INPUT` from `../src/shadow` | Same barrel text above; tag comes from `WIRE_TAG.input` via `@tapkart/protocol` |
| Task 18 | Whole-brief framing, lines 9–25, 51–55; RED predictions lines 302–308, 519–522 | "Neither package was reachable via its bare specifier before this task" / "Failed to resolve import" RED | §3/§5: Task 3 and Task 11 each ship a partial barrel already; RED is a missing-named-export error, not an unresolved module |
| Task 18 | Barrel test bodies, lines 112–119, 384–393, 451 | Asserts/imports `WIRE_TAG_INPUT`..`WIRE_TAG_AUTHORITY_CHANGE`, `[4,5,6,7,8]` | Must assert against the contract's `WIRE_TAG` map instead, once B4 lands |
| Task 15 | Line 34 (stated assumption), line 371 | `EpsilonTable` field `lapT` | §3/§4: field is `t` |
| Task 16 | Line 123 (stated assumption), line 660 | `EpsilonTable` field `lapT` | §3/§4: field is `t` |
| Task 14 | "Produces" line 58 | `AuthorityLoop { constructor; tick(): void }` (no `state()`) | §5: `AuthorityLoop` also has `state(): SimState` |
| Task 15 | "Produces" lines 48–49 | `ClientLoop { constructor; tick(); corrections() }` (no `state()`) | §5: `ClientLoop` also has `state(): SimState` |
| Task 16 | Design note, lines 178 | "matching `AuthorityLoop`'s ... caller-owned-`state` pattern in its own locked signature" (i.e. "no getter") | `AuthorityLoop` now has a getter; this specific justifying clause is stale (does not change `ShadowLoop`'s own correct no-getter design, since `ShadowLoop`'s contract signature genuinely has none) |

Note Task 14 and Task 15 are themselves **not** drifted on the barrel-import question (B6) — both
correctly use `@tapkart/protocol` as a bare specifier already, which is why B6 is listed against 11,
12, 16, 17, 18 only.

---

## Premises verified

| Task | Claim | File checked | True/False |
|---|---|---|---|
| 13 | `kartById(state, playerId)` linear-scans and returns `null` on no match | `packages/sim/src/entity.ts:113` | True |
| 13 | `rollItem` returns `'none'` unconditionally when `!ctx.isLeader` | `packages/sim/src/items.ts:71-72` | True |
| 13 | `laps.ts` emits `'finish'` with `data = slot + 1` (1-based place) | `packages/sim/src/laps.ts:97-107` | True |
| 13 | `phase.ts`'s DNF sweep emits `'finish'` with the same 1-based meaning, plus a `playerId=-1` sentinel with `data=finishers` | `packages/sim/src/phase.ts:190-227` | True (comment at line 217-218 literally states "the same meaning updateLaps gives data") |
| 13 | `entity.ts`'s `hit` emit is `data=1` when a shield absorbs, `data=0` otherwise, immediately followed by `startSpinOut` on the `0` branch | `packages/sim/src/entity.ts:251-261` | True |
| 13 | `tsconfig.base.json` sets `noUnusedParameters: true`, flagging an unused leading param (`TS6133`) even when later params are used | `tsconfig.base.json` | True (flag confirmed present; TS's documented behavior matches the claim) |
| 14 | `allocStateLike`, `makeIntentBuffer`, `itemBoxWorldPos`, `step(ctx, prev, next, inputs, events)` exist with the claimed signatures | `packages/sim/src/replay.ts:82`, `phase.ts:20`, `items.ts:89`, `step.ts:98-103` | True |
| 14 | `COUNTDOWN_TICKS = 180`; phase flips to `'racing'` on the tick that reaches it, not after | `packages/sim/src/types.ts:8`, `phase.ts:163` | True |
| 12 | `buildTrackQuery(makeOvalTrack()).sampleAt(0)` = `{x:-200, z:-100, width:24}` | `packages/sim/test/fixtures/track-fixtures.ts:187` | True |
| 12 | `makeTuning().kartRadius === 0.9`; `makeCharacters()` returns 8 entries | `packages/sim/test/fixtures/track-fixtures.ts:24-56` | True (kartRadius confirmed at line 45) |
| 11/12/16/17/18 | "`packages/protocol`'s barrel is empty/deferred to Task 18" | current contract §3 | **False** (see B6) |
| 15/16 | `EpsilonTable`'s continuous-`t`-field key is `lapT` | current contract §3/§4 | **False** (contract pins `t`) |
| 14/15 | `AuthorityLoop`/`ClientLoop` have no `state()` accessor | current contract §5 | **False** (contract adds it to both) |
| 18 | "The ambiguity test builds its namespace map from direct per-module imports, never the barrel" | `plan2-task-18-barrels.md` `NAMESPACES` arrays (protocol: lines 183-206; net: lines 401-423) | True — correctly implemented, both barrel tests import every module individually (`import * as bitsNs from '../src/bits'`, etc.) and only compare against the barrel's own `hasOwnProperty`, never derive the expected set from it. No defect here. |

---

## Test quality

Priority target per the audit brief: Task 17 owns the three integration tests the plan exists to
satisfy. Findings, in order of severity:

1. **B1 (promotion, "matches within bounds"): the assertion compares a value to itself.** Cannot fail
   under any implementation of `ShadowLoop`, correct or broken. This is the single most serious defect
   in the whole audit — see Blocking Defects above.
2. **B2 (promotion, "no entity disappears"): the loop body is a comment.** No assertion of any kind
   backs this spec-§8-named property anywhere in `promotion.test.ts`.
3. **Test 1 (convergence), sanity assertion cannot fail:** line 294,
   `expect(settleCount).toBeGreaterThanOrEqual(0)` — `client.corrections()` is a monotonically
   non-decreasing counter starting at 0; this is true by construction for any implementation. It adds
   nothing beyond "the test reached this line."
4. **Test 1 (convergence) may be measuring the wrong thing: it drives the client with a continuously
   varying `scriptedIntent` (a slow sine wave, period ≈610 ticks), not a held-steady intent.** Task
   15's own brief — in the *same plan*, about the *same invariant* — explicitly documents why this
   matters (its "Verification performed" section, bug #1's discussion): *"with a changing steer
   signal, the authority's latency-held copy is always behind the client's current real value by
   ~latency ticks, which is a genuine (non-quantization) physics discrepancy on every comparison — a
   lag artifact, not noise. Only a truly steady input ... isolat[es] this test to quantization
   noise."* Task 15's own flagship zero-corrections test therefore uses `mkIntent(0.3)` held constant
   for the entire measured window. Task 17's convergence test uses `scriptedIntent(t, 0)`, whose
   derivative near a sine zero-crossing (`d(steer)/dt ≈ 0.006/tick` at the fixture's parameters) can
   accumulate several hundredths of a unit of steer difference across a ~9–12 tick input-hold gap —
   plausibly enough to move the kart's real trajectory by more than `EPS.velocity`/`EPS.position` for
   reasons that have nothing to do with quantization. As written, this risks either a flaky/false
   failure (blocking an otherwise-correct implementation) or, if it happens to pass at the chosen seed,
   giving false confidence that varying input is safe when Task 15's own investigation found the
   opposite. **This directly reintroduces the exact confound Task 15 spent its verification pass
   eliminating.**
5. **Test 1 (convergence) reuses `WARMUP_TICKS = 180`, a value Task 15's own brief found flaky for
   this exact invariant.** Task 15's verification note: *"at `WARMUP_TICKS = 180` ... the test was
   flaky — one run in six ... showed exactly one correction a few ticks past the warmup boundary"* —
   which is why Task 15's own flagship test uses `WARMUP_TICKS = 360`. Task 17's convergence test
   (line 247) uses 180 for the same measured claim ("zero corrections in steady state") without
   re-deriving or even acknowledging the discrepancy.
6. **Positive finding:** Task 17's "no lap counter regresses" checks (both pre-kill and post-kill
   loops) are real, per-kart, per-tick assertions that can and would fail on a genuine regression —
   not vacuous.
7. **Positive finding:** Task 18's barrel "ambiguity" test correctly builds its namespace map from
   direct per-module imports (`import * as bitsNs from '../src/bits'`, etc.), never from the barrel
   itself, in both `packages/protocol/test/barrel.test.ts` and `packages/net/test/barrel.test.ts` —
   satisfying the audit's specific check on this point.

---

## Placeholders

None found. No "TBD", no "add appropriate error handling", no "similar to Task N" steps, no step
describing behavior without showing code, in Tasks 10–18. (Two literal hits for the string
"placeholder" in Task 15 are negations — "not a hand-rolled placeholder" — not actual placeholders.)

---

## Non-blocking observations

- **`plan2-task-13-apply.md`** (lines 91, ~163-177) quotes `recovery.ts`'s current call site as
  `startSpinOut(state, k, ctx.tuning.spinOutTicks, events)` (no `ctx` prepended) — accurate against the
  repo's actual state *today* (Plan 1 only, `1f1f2c4`), but Task 2 (outside my territory) prepends
  `ctx` to `startSpinOut` per contract §2a before Task 13 actually runs in sequence. This citation will
  be stale prose by the time Task 13 executes. It does not affect Task 13's own shipped code (which
  never calls `startSpinOut`, only documents its effect), so this is cosmetic, not blocking — but worth
  a one-line fix so a future reader doesn't try to copy the quoted call site verbatim.
- **`plan2-task-17-integration.md`** line 413 and **`plan2-task-18-barrels.md`** line 502 use
  `require(...)` inside otherwise-ESM (`verbatimModuleSyntax`, `"type": "module"`) test files. Vitest's
  `vite-node` runtime is known to support this hybrid pattern, so it is plausible rather than broken,
  but neither brief verifies it against this repo's actual Vitest config the way virtually every other
  claim in these briefs is verified — worth a quick empirical check before relying on it, consistent
  with this plan's own stated standard of practice.
- **`plan2-task-16-shadow.md`**'s self-reported "Ambiguities and dependencies flagged for the plan's
  author" section (items 1–2, lines 919–931) already correctly identifies both B4/B5 (tag byte) and B3
  (missing `ClientLoop` state getter) as open problems for the plan's author to resolve — the brief's
  own author saw the gap. The current contract resolved the tag-byte gap (§3's `WIRE_TAG`) and the
  state-getter gap (§5's `state()` additions) after this brief was written, but the brief's own
  implementation was never updated to match either resolution. This is consistent with the audit's
  framing: the contract absorbed exactly the ambiguities these briefs flagged, but the flagging briefs
  themselves are the ones now out of sync with the fix.

---

## Outside my territory

- The chain of fixes in B4–B6 depends on **Task 3** (`packages/protocol/src/types.ts`, outside my
  territory) actually shipping `WIRE_TAG`, `encodeHeader`, and `decodeHeader` exactly as the current
  contract specifies, and on Task 3 populating `packages/protocol/src/index.ts` with
  `export * from './types'` at scaffold time (not leaving it `export {}`) per the current contract's
  §3 note *"The barrel exists from Task 3, not Task 18."* I did not read Task 3's brief; the other
  auditor covering Tasks 1–9 should confirm both.
- Tasks 10–18 collectively assume `packages/sim`'s Plan-2 amendments (Task 1's `heldBotIntent`/
  `heldBotTick` widening, Task 2's eleven-site `emit()` gating, `startSpinOut`'s added `ctx` parameter)
  have already landed by the time Task 13 onward run. I spot-checked several of the *pre-amendment*
  call sites this territory's briefs cite (see Premises table) and found them accurate against the
  current, unamended repo state; I did not re-verify what the *post-amendment* shape of those same call
  sites will be, since that is Tasks 1–2's territory, not mine.
- I did not review Tasks 4–9 (`bits.ts`, `quant.ts`, `snapshot.ts`, `checkpoint.ts`, `events.ts`) in
  any detail beyond what Tasks 10–18 cite about them. In particular, Task 9's `AuthEvent` wire-bias
  (§4a, `playerId`/`entityId` encoded `+1`) is outside my territory to audit directly; I confirmed only
  that Task 13 (`applyEvent`, which consumes already-decoded, unbiased `AuthEvent` objects) has no
  dependency on getting the bias arithmetic right itself, so no defect crosses the boundary here.
