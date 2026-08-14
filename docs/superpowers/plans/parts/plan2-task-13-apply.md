### Task 13: The Follower's Event Applier

**Files:**
- Create: `packages/net/src/apply.ts`
- Test: `packages/net/test/apply.test.ts`

**Interfaces:**

- Consumes (all verified against real source before writing this brief — see the
  verification note below):
  - `packages/sim/src/types.ts` — `AuthEventKind` is exactly
    `'itemGrant' | 'entitySpawn' | 'entityDespawn' | 'hit' | 'spinOut' | 'respawn' | 'lapCross' | 'finish'`.
    `AuthEvent` is exactly `{ eventSeq: number; tick: number; kind: AuthEventKind; playerId: number; entityId: number; item: ItemKind; data: number }`,
    with `entityId` `-1` when not applicable, `item` `'none'` when not
    applicable, `data` `0` when unused. `SimState.nextEventSeq` is the field
    `emit()` (Plan 1, `packages/sim/src/state.ts`) stamps every event's
    `eventSeq` from and then post-increments; `createState` initializes it to
    `0`. `SimContext` carries `isLeader`.
  - `packages/sim/src/entity.ts` — `export function kartById(state: SimState, playerId: number): KartState | null`,
    a linear scan of `state.karts` returning `null` when no kart's `playerId`
    matches (in particular for `playerId === -1`, the finish-sentinel value).
  - `packages/sim/src/items.ts` — `export function applyItemGrant(ctx: SimContext, state: SimState, ev: AuthEvent): void`,
    already shipped in Plan 1 and already barrel-exported (`packages/sim/src/index.ts`
    has `export * from './items'`). Read directly: it returns early unless
    `ev.kind === 'itemGrant'`, looks the kart up with `kartById`, sets
    `k.item = ev.item`, and — the half a hand-rolled `k.item = ev.item` would
    miss — puts the *item box* named by `ev.data` back on its respawn timer
    (`if (box.respawnTicks <= 0) box.respawnTicks = ctx.tuning.itemBoxRespawnTicks`).
    Its own doc comment states the reason: *"`ev.data` carries the boxIdx, so a
    follower that missed the local pickup (fresh join, post-resync) still puts
    the box on its respawn timer."*
  - `packages/sim/src/state.ts` — `export function createState(ctx: SimContext, seed: number, characterIdx: number[]): SimState`,
    used only by this task's tests.
  - `packages/net/test/fixtures/net-fixtures.ts` [Task 12, locked contract §6] —
    `export function makeNetContext(isLeader?: boolean): SimContext`. This
    task's tests always pass `false` explicitly (never rely on the default),
    because `applyEvent` is the *follower's* half of the emit-gating rule and
    every test here represents a peer that never emits.
  - The barrel `@tapkart/sim` (`packages/sim/src/index.ts`) re-exports
    `types.ts`, `entity.ts` and `state.ts` in full via `export *`, so this
    task imports everything above through `@tapkart/sim`, never through a
    relative path into `packages/sim`.

- Produces (locked contract §5):
  - `export function applyEvent(ctx: SimContext, state: SimState, ev: AuthEvent): boolean`
    — `false` when `ev` was already applied (or is older than the highest
    already applied), `true` otherwise, having advanced `state.nextEventSeq`.

**Verification performed for this brief (the hazard this plan learned the
expensive way):** this brief makes claims about what six functions in
`packages/sim` actually do — `emit`, `kartById`, `startSpinOut`, `beginRespawn`,
`updateLaps`'s finish/lapCross emission, and `updateItemBoxes`'s itemGrant
emission. Every one of those claims was checked by reading
`packages/sim/src/state.ts`, `entity.ts`, `recovery.ts`, `laps.ts`, `items.ts`
and `phase.ts` directly, not inferred from the spec or the contract. The exact
per-`data`-field meaning table below is transcribed from that reading, with the
source cited per row. Where this brief also had to make a *design* decision not
settled by any of those files or by the locked contract (the exact mutation
`applyEvent` performs per event kind), that decision and its reasoning are
written out in full below, and the entire implementation and every test in this
brief were run against the real, currently-merged `packages/sim` (Plan 1,
`1f1f2c4`) before this brief was written, and passed — 10 tests, one file, zero
edits needed after the first pass. That run is not part of the checked-in
history (this brief's Step 1–4 recreate it from scratch inside `packages/net`,
which does not exist yet), but it is why every expected assertion value below
is exact rather than estimated.

---

**Why a function this small carries eight cases and not one.**

Spec §5 ("Events"): every event carries a global monotonic `eventSeq` assigned
by the current authority; a follower applies each event once and ignores any
`eventSeq` at or below the highest already applied. That much is uniform across
all eight kinds and is the *only* thing `entitySpawn` and `entityDespawn` need
`applyEvent` to do for them — see below. But four of the other five kinds carry
information a follower cannot always reconstruct by re-simulating, and the
brief that authored the parent contract only flagged one of them
(`itemGrant`) by name. Re-deriving the rest from the actual call sites found
two more categories:

1. **`itemGrant` — leader-only PRNG roll (`items.ts` line ~136).** A follower's
   `rollItem` returns `'none'` unconditionally (`if (!ctx.isLeader) return 'none'`,
   `items.ts`), so a follower's own kart's `k.item` never becomes anything but
   `'none'` through local simulation. The granted item exists nowhere except
   the event. **Must apply — and both halves of it, not just the kart's.**
   `updateItemBoxes` emits `emit(state, events, 'itemGrant', k.playerId, -1, item, box.boxIdx)`,
   so `ev.data` is the **box index**, and the pickup has two consequences: the
   kart holds the item *and* that box goes onto its respawn timer. Only the
   first is visible in `WireKart`; a box's `respawnTicks` is in neither
   `WireSnapshot` nor any other event, so a peer that never simulated the
   pickup — a `ClientLoop`, which never predicts remote karts — would keep
   offering a box the authority has already consumed. `packages/sim/src/items.ts`
   already ships exactly this operation as `applyItemGrant(ctx, state, ev)`,
   written for this path and tested in Plan 1, so `applyEvent` delegates to it
   rather than re-deriving half of it. **This is the one case where `applyEvent`
   reuses a sim function instead of writing its own fields** — the exception is
   deliberate and the reason is below.

2. **`hit` and the `spinOut` that follows an unshielded hit
   (`entity.ts` lines ~250–262) — caused by an entity the receiver never
   simulated.** Entities owned by other karts are never predicted (spec §5,
   "Prediction and reconciliation": "Entities are authority-simulated and
   client-interpolated only, never predicted"). A client that never simulated
   the seeker that just hit it cannot have independently run
   `startSpinOut`/cleared its own `shielded` flag — its local
   `updateRecovery`/`updateEntities` calls never saw that seeker, because the
   client's own predicted state never held it. Spec §5 says this outright:
   *"The local kart's hit reaction plays on receipt, not on prediction."*
   **Must apply.** `entity.ts`'s emit call is `emit(state, events, 'hit', k.playerId, e.entityId, e.kind, 1)`
   when a shield absorbed the hit and `... 0)` when it did not (the shield-clear,
   `k.shielded = false`, happens in the same branch as the `1` emit, immediately
   before it). The immediately following `startSpinOut(…)` call (only reached on
   the `0`/unshielded branch) is what actually emits `'spinOut'`. *That call site
   is **not** quoted with a parameter list here, deliberately:* Plan 1 ships
   `startSpinOut(state, k, ticks, events)`, and Plan 2 Task 2 re-signs it to
   take `ctx` (locked contract §2a) before this task runs — so any parameter
   list written here would be stale on the day this brief executes. Nothing in
   this task calls `startSpinOut`; only its *effect* on `KartState` matters
   below, and that effect is unchanged by the re-signing.
   `startSpinOut` (`recovery.ts`) sets
   `k.spinOutTicks = ticks; k.drift.active = false; k.drift.dir = 0; k.drift.charge = 0; k.boostTicks = 0`
   before its own `emit(state, events, 'spinOut', k.playerId, -1, 'none', ticks)`.

3. **`finish` — depends on every kart's placement, which a follower only
   predicts correctly for its own kart.** `WireSnapshot` (locked contract §3)
   has no field for race placement or finish order at all — no `finished`,
   no `place`, nothing — confirmed by reading the full `WireKart`/`WireSnapshot`
   interface in §3. `state.finishedOrder` is therefore recoverable **only**
   from `'finish'` events. This matters even for a lockstep-simulating peer
   (the future shadow authority, Task 16): `laps.ts`'s per-kart finish credit
   (`state.finishedOrder[slot] = k.playerId`, unconditional, not gated by
   `ctx.isLeader` — only its `emit()` call is gated) is self-sufficient for a
   peer simulating every kart's true input, but `phase.ts`'s DNF/timeout sweep
   calls `placementOrder(state)` across **all eight karts** to decide finishing
   order for karts still racing when `FINISH_GRACE_TICKS` elapses — and a
   `ClientLoop` (Task 15), which never predicts remote karts, does not have
   accurate placement data for the other seven. **Must apply**, both branches:
   `laps.ts` emits `emit(state, events, 'finish', k.playerId, -1, 'none', slot + 1)`
   (`data` is the **1-based** finishing place — `slot` is 0-based); `phase.ts`'s
   DNF sweep emits the same shape with the same 1-based-place meaning (its own
   comment says so: *"the same meaning updateLaps gives data"*); `phase.ts`'s
   final line emits the sentinel `emit(state, events, 'finish', -1, -1, 'none', finishers)`
   marking the phase transition itself, once, after every real per-kart finish
   for that tick.

4. **`respawn` and `lapCross` — always self-derivable for the kart's own
   local prediction, applied anyway for defense in depth and because
   `WireSnapshot` already carries their fields too (`respawnTicks` exact-compared,
   `lap` exact-compared per §4), so applying them here costs nothing and is
   idempotent with what the next snapshot would show regardless.** Both are
   triggered purely by the kart's own position (`recovery.ts`'s
   `!ctx.query.isInBounds(...)`, `laps.ts`'s own-position checkpoint projection)
   — no cross-kart information — so a `ClientLoop` predicting its own kart
   correctly will independently reach the same value. Applied anyway: `respawn`
   sets `k.respawnTicks = ev.data` (`recovery.ts`'s `beginRespawn` emits with
   `data = k.respawnTicks`, the value it just assigned); `lapCross` sets
   `k.lap.lap = ev.data` and `k.lap.checkpointIdx = 0` — the checkpoint index is
   not carried in the event's fields at all, but `laps.ts` only ever emits
   `'lapCross'` on the branch guarded by `if (idx !== 0) return`, i.e. exactly
   when the crossed checkpoint **is** index 0, so `0` is the only value it could
   ever be and this brief derives it rather than inventing a field.

5. **`entitySpawn` and `entityDespawn` — no mutation is possible, only
   sequencing.** `AuthEvent` carries no `Vec3` at all (re-read the type above:
   `eventSeq, tick, kind, playerId, entityId, item, data` — nothing else), so
   an entity's position, velocity and heading are not reconstructable from its
   spawn event under any design. `entitySpawn`'s emit call
   (`emit(state, events, 'entitySpawn', ownerId, entityId, kind, ttl)`) smuggles
   the spawned entity's `EntityKind` through `AuthEvent.item: ItemKind` — legal
   only because every `EntityKind` string (`'seeker' | 'bolt' | 'slick' | 'bubble' | 'surge' | 'charge'`)
   is also a valid `ItemKind` string — and carries `ttl` in `data`, but never a
   position. Entity truth is carried exclusively by `WireSnapshot` (never
   predicted, per spec §5), so these two kinds exist on the wire solely to keep
   `nextEventSeq` advancing in lockstep with every kind the authority emits.
   `applyEvent` does nothing beyond the universal sequencing step for them.

The resulting table, `data`'s meaning per kind, all six citations above:

| kind | `playerId` means | mutation |
|---|---|---|
| `itemGrant` | kart granted the item | `applyItemGrant(ctx, state, ev)`: `k.item = ev.item` **and** item box `ev.data` goes onto `ctx.tuning.itemBoxRespawnTicks` |
| `hit` | kart that was hit | `data === 1`: `k.shielded = false`. `data === 0`: none (the following `spinOut` event carries the real consequence) |
| `spinOut` | kart spinning out | `k.spinOutTicks = ev.data`; clear `drift.active`, `drift.dir`, `drift.charge`, `boostTicks` to their zero values, exactly mirroring `startSpinOut` |
| `respawn` | kart respawning | `k.respawnTicks = ev.data` |
| `lapCross` | kart completing a lap | `k.lap.lap = ev.data`; `k.lap.checkpointIdx = 0` |
| `finish`, `playerId >= 0` | kart finishing | `state.finishedOrder[ev.data - 1] = ev.playerId`; if `state.finishTick < 0`, `state.finishTick = ev.tick` |
| `finish`, `playerId === -1` | (sentinel: the race itself) | `state.phase = 'finished'` |
| `entitySpawn` / `entityDespawn` | owner of the entity | none — sequencing only |

**Why `applyEvent` calls `applyItemGrant` but does not call `startSpinOut`,
`beginRespawn`, `spawnEntity` or `despawnEntityAt`.** `applyItemGrant` is the
one sim function in this list written *for the receiving side*: its doc comment
says so ("Follower path for an authoritative item grant"), it emits nothing, it
has no leader-side entry guard, and it is the sole owner of the box-timer half
of a grant. Re-deriving it here would duplicate a tested function and, worse,
would silently drift from it the first time `items.ts` changes what a pickup
costs. The other four are the opposite case. All four are written for the
*leader's forward simulation* and carry guards appropriate to that context but
wrong for a receiver trusting the wire: `startSpinOut` refuses a shorter spin
than the one already running (`if (ticks <= k.spinOutTicks) return`) — correct
when a leader is *deciding whether a new hit should extend a spin*, wrong when
an authoritative event is *stating what happened*, because a legitimate
correction could then be silently dropped if the receiver's own guess happened
to already have a larger value. All four also call `emit()` themselves, which
would either double-count `nextEventSeq` (already advanced once by
`applyEvent`'s own gating step) or require threading a throwaway `events` array
through for no purpose. `applyEvent` performs its own narrow, unconditional
field writes instead, four to six lines each, matching only the *effect* those
functions have on `KartState`/`SimState`, never their entry guards.

**Why the first parameter is `ctx` and stays named `ctx`.** The locked
contract's signature is
`applyEvent(ctx: SimContext, state: SimState, ev: AuthEvent): boolean`. This
implementation reads `ctx` in exactly one place — it hands it to
`applyItemGrant`, which needs `ctx.tuning.itemBoxRespawnTicks` — so the
parameter is genuinely consumed and needs no underscore.

That is worth stating because an earlier draft of this brief named it `_ctx`
and explained at length why: `tsconfig.base.json` sets
`"noUnusedParameters": true`, and TypeScript 5.9 (confirmed by direct
compilation against this exact tsconfig) flags an unused *leading* parameter
with `TS6133` even when later parameters in the same function are used — it
does **not** exempt a parameter merely for preceding a used one. That finding
is still true and still relevant to Tasks 14–16, but it no longer applies here.
**Do not "simplify" the `itemGrant` case back to a bare `k.item = ev.item`:**
doing so drops the item box's respawn timer *and* makes `ctx` unused again,
and `TS6133` is the only thing that would tell you — a follower quietly
re-offering a consumed box is not a compile error.

---

- [ ] **Step 1: Write the failing test**

Create `packages/net/test/apply.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { AuthEvent } from '@tapkart/sim'
import { createState } from '@tapkart/sim'
import { applyEvent } from '../src/apply'
import { makeNetContext } from './fixtures/net-fixtures'

const SEED = 0x1234abcd
const CHARS = [0, 1, 2, 3, 4, 5, 6, 7]

describe('applyEvent — sequencing', () => {
  it('is a no-op the second time the same event is applied', () => {
    const ctx = makeNetContext(false)
    const state = createState(ctx, SEED, CHARS)
    const ev: AuthEvent = {
      eventSeq: 0, tick: 5, kind: 'itemGrant',
      playerId: 2, entityId: -1, item: 'boost', data: 0,
    }

    expect(applyEvent(ctx, state, ev)).toBe(true)
    expect(state.karts[2].item).toBe('boost')
    expect(state.itemBoxes[0].respawnTicks).toBe(ctx.tuning.itemBoxRespawnTicks)
    expect(state.nextEventSeq).toBe(1)

    // Both fields are changed between the two applications, so the second call
    // re-writing EITHER of them would be observable, not just a matching no-op.
    state.karts[2].item = 'seeker'
    state.itemBoxes[0].respawnTicks = 0
    expect(applyEvent(ctx, state, ev)).toBe(false)
    expect(state.karts[2].item).toBe('seeker')       // untouched: the 2nd apply did nothing
    expect(state.itemBoxes[0].respawnTicks).toBe(0)  // and did not re-arm the box either
    expect(state.nextEventSeq).toBe(1)
  })

  it('ignores any eventSeq at or below the highest already applied', () => {
    const ctx = makeNetContext(false)
    const state = createState(ctx, SEED, CHARS)
    const high: AuthEvent = {
      eventSeq: 5, tick: 10, kind: 'itemGrant',
      playerId: 0, entityId: -1, item: 'boost', data: 0,
    }
    const lower: AuthEvent = {
      eventSeq: 2, tick: 4, kind: 'itemGrant',
      playerId: 0, entityId: -1, item: 'seeker', data: 0,
    }
    const sameSeqDifferentEvent: AuthEvent = {
      eventSeq: 5, tick: 10, kind: 'itemGrant',
      playerId: 0, entityId: -1, item: 'bolt', data: 0,
    }

    expect(applyEvent(ctx, state, high)).toBe(true)
    expect(state.nextEventSeq).toBe(6)
    expect(state.karts[0].item).toBe('boost')

    expect(applyEvent(ctx, state, lower)).toBe(false)
    expect(state.nextEventSeq).toBe(6)          // unchanged
    expect(state.karts[0].item).toBe('boost')   // not overwritten by the stale event

    // "at or below": eventSeq 5 equals the highest already applied (5), not
    // just below it, and must also be ignored.
    expect(applyEvent(ctx, state, sameSeqDifferentEvent)).toBe(false)
    expect(state.karts[0].item).toBe('boost')
  })
})

describe('applyEvent — per-kind mutation', () => {
  it('itemGrant sets the kart\'s item AND puts the named box on its respawn timer', () => {
    const ctx = makeNetContext(false)
    const state = createState(ctx, SEED, CHARS)
    // data is the boxIdx (items.ts: emit(..., 'itemGrant', k.playerId, -1, item, box.boxIdx)).
    const ev: AuthEvent = {
      eventSeq: 0, tick: 1, kind: 'itemGrant',
      playerId: 5, entityId: -1, item: 'bubble', data: 3,
    }
    expect(state.itemBoxes.length).toBeGreaterThan(3)  // the oval fixture ships 6 boxes
    expect(state.itemBoxes[3].respawnTicks).toBe(0)
    expect(applyEvent(ctx, state, ev)).toBe(true)
    expect(state.karts[5].item).toBe('bubble')
    expect(state.itemBoxes[3].respawnTicks).toBe(ctx.tuning.itemBoxRespawnTicks)
    // and only that box: a receiver must not blanket-arm the whole track.
    expect(state.itemBoxes[0].respawnTicks).toBe(0)
    expect(state.itemBoxes[4].respawnTicks).toBe(0)
  })

  it('itemGrant with a data value outside the box array still grants the item', () => {
    const ctx = makeNetContext(false)
    const state = createState(ctx, SEED, CHARS)
    const ev: AuthEvent = {
      eventSeq: 0, tick: 1, kind: 'itemGrant',
      playerId: 5, entityId: -1, item: 'bubble', data: 999,
    }
    expect(applyEvent(ctx, state, ev)).toBe(true)
    expect(state.karts[5].item).toBe('bubble')
    for (const box of state.itemBoxes) expect(box.respawnTicks).toBe(0)
  })

  it('hit with data 1 clears the shield', () => {
    const ctx = makeNetContext(false)
    const state = createState(ctx, SEED, CHARS)
    state.karts[4].shielded = true
    const ev: AuthEvent = {
      eventSeq: 0, tick: 1, kind: 'hit',
      playerId: 4, entityId: 9, item: 'seeker', data: 1,
    }
    expect(applyEvent(ctx, state, ev)).toBe(true)
    expect(state.karts[4].shielded).toBe(false)
  })

  it('hit with data 0 changes no kart field beyond sequencing', () => {
    const ctx = makeNetContext(false)
    const state = createState(ctx, SEED, CHARS)
    state.karts[4].shielded = false
    const ev: AuthEvent = {
      eventSeq: 0, tick: 1, kind: 'hit',
      playerId: 4, entityId: 9, item: 'seeker', data: 0,
    }
    expect(applyEvent(ctx, state, ev)).toBe(true)
    expect(state.karts[4].shielded).toBe(false)
    expect(state.nextEventSeq).toBe(1)
  })

  it('spinOut sets the timer and clears drift and boost', () => {
    const ctx = makeNetContext(false)
    const state = createState(ctx, SEED, CHARS)
    state.karts[1].drift.active = true
    state.karts[1].drift.dir = 1
    state.karts[1].drift.charge = 90
    state.karts[1].boostTicks = 10
    const ev: AuthEvent = {
      eventSeq: 0, tick: 1, kind: 'spinOut',
      playerId: 1, entityId: -1, item: 'none', data: 60,
    }
    expect(applyEvent(ctx, state, ev)).toBe(true)
    expect(state.karts[1].spinOutTicks).toBe(60)
    expect(state.karts[1].drift.active).toBe(false)
    expect(state.karts[1].drift.dir).toBe(0)
    expect(state.karts[1].drift.charge).toBe(0)
    expect(state.karts[1].boostTicks).toBe(0)
  })

  it('respawn sets the respawn timer', () => {
    const ctx = makeNetContext(false)
    const state = createState(ctx, SEED, CHARS)
    const ev: AuthEvent = {
      eventSeq: 0, tick: 1, kind: 'respawn',
      playerId: 6, entityId: -1, item: 'none', data: 72,
    }
    expect(applyEvent(ctx, state, ev)).toBe(true)
    expect(state.karts[6].respawnTicks).toBe(72)
  })

  it('lapCross sets the lap count and resets checkpointIdx to 0', () => {
    const ctx = makeNetContext(false)
    const state = createState(ctx, SEED, CHARS)
    state.karts[3].lap.checkpointIdx = 11
    const ev: AuthEvent = {
      eventSeq: 0, tick: 1, kind: 'lapCross',
      playerId: 3, entityId: -1, item: 'none', data: 1,
    }
    expect(applyEvent(ctx, state, ev)).toBe(true)
    expect(state.karts[3].lap.lap).toBe(1)
    expect(state.karts[3].lap.checkpointIdx).toBe(0)
  })

  it('finish for a real kart writes finishedOrder at data-1 and stamps finishTick once', () => {
    const ctx = makeNetContext(false)
    const state = createState(ctx, SEED, CHARS)
    const first: AuthEvent = {
      eventSeq: 0, tick: 200, kind: 'finish',
      playerId: 3, entityId: -1, item: 'none', data: 1,
    }
    expect(applyEvent(ctx, state, first)).toBe(true)
    expect(state.finishedOrder[0]).toBe(3)
    expect(state.finishTick).toBe(200)

    const second: AuthEvent = {
      eventSeq: 1, tick: 250, kind: 'finish',
      playerId: 7, entityId: -1, item: 'none', data: 2,
    }
    expect(applyEvent(ctx, state, second)).toBe(true)
    expect(state.finishedOrder[1]).toBe(7)
    expect(state.finishTick).toBe(200)   // stamped once, at the first finisher's tick
  })

  it('finish with playerId -1 transitions the phase to finished', () => {
    const ctx = makeNetContext(false)
    const state = createState(ctx, SEED, CHARS)
    const sentinel: AuthEvent = {
      eventSeq: 0, tick: 500, kind: 'finish',
      playerId: -1, entityId: -1, item: 'none', data: 8,
    }
    expect(state.phase).toBe('countdown')
    expect(applyEvent(ctx, state, sentinel)).toBe(true)
    expect(state.phase).toBe('finished')
  })

  it('entitySpawn and entityDespawn advance nextEventSeq and touch nothing else', () => {
    const ctx = makeNetContext(false)
    const state = createState(ctx, SEED, CHARS)
    const entityCountBefore = state.entityCount
    const kartsSnapshot = JSON.stringify(state.karts)

    const spawn: AuthEvent = {
      eventSeq: 0, tick: 1, kind: 'entitySpawn',
      playerId: 2, entityId: 5, item: 'seeker', data: 600,
    }
    expect(applyEvent(ctx, state, spawn)).toBe(true)
    expect(state.entityCount).toBe(entityCountBefore)
    expect(state.nextEventSeq).toBe(1)
    expect(JSON.stringify(state.karts)).toBe(kartsSnapshot)

    const despawn: AuthEvent = {
      eventSeq: 1, tick: 30, kind: 'entityDespawn',
      playerId: 2, entityId: 5, item: 'seeker', data: 0,
    }
    expect(applyEvent(ctx, state, despawn)).toBe(true)
    expect(state.entityCount).toBe(entityCountBefore)
    expect(state.nextEventSeq).toBe(2)
  })
})

describe('applyEvent — a realistic multi-tick sequence', () => {
  it('applies six events spanning 190 ticks, threading nextEventSeq call to call', () => {
    const ctx = makeNetContext(false)
    const state = createState(ctx, SEED, CHARS)
    const events: AuthEvent[] = [
      { eventSeq: 0, tick: 10, kind: 'itemGrant', playerId: 3, entityId: -1, item: 'seeker', data: 0 },
      { eventSeq: 1, tick: 40, kind: 'lapCross', playerId: 3, entityId: -1, item: 'none', data: 1 },
      { eventSeq: 2, tick: 90, kind: 'spinOut', playerId: 5, entityId: -1, item: 'none', data: 60 },
      { eventSeq: 3, tick: 91, kind: 'hit', playerId: 5, entityId: 7, item: 'seeker', data: 0 },
      { eventSeq: 4, tick: 150, kind: 'lapCross', playerId: 3, entityId: -1, item: 'none', data: 2 },
      { eventSeq: 5, tick: 200, kind: 'finish', playerId: 3, entityId: -1, item: 'none', data: 1 },
    ]

    for (const ev of events) {
      expect(applyEvent(ctx, state, ev)).toBe(true)
    }

    expect(state.nextEventSeq).toBe(6)
    expect(state.karts[3].item).toBe('seeker')
    expect(state.itemBoxes[0].respawnTicks).toBe(ctx.tuning.itemBoxRespawnTicks)
    expect(state.karts[3].lap.lap).toBe(2)
    expect(state.karts[3].lap.checkpointIdx).toBe(0)
    expect(state.karts[5].spinOutTicks).toBe(60)
    expect(state.finishedOrder[0]).toBe(3)
    expect(state.finishTick).toBe(200)

    // Replaying the exact same six events again — as would happen if the
    // reliable channel redelivered a batch the peer had already applied — must
    // change nothing, in one pass, in order. Every field the six events wrote
    // is scrambled first, so a re-application is observable on every one of
    // them rather than being hidden by an identical rewrite.
    state.karts[3].item = 'none'
    state.itemBoxes[0].respawnTicks = 0
    state.karts[3].lap.lap = 9
    state.karts[5].spinOutTicks = 0
    state.finishedOrder[0] = -1
    for (const ev of events) {
      expect(applyEvent(ctx, state, ev)).toBe(false)
    }
    expect(state.nextEventSeq).toBe(6)
    expect(state.karts[3].item).toBe('none')
    expect(state.itemBoxes[0].respawnTicks).toBe(0)
    expect(state.karts[3].lap.lap).toBe(9)
    expect(state.karts[5].spinOutTicks).toBe(0)
    expect(state.finishedOrder[0]).toBe(-1)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/net/test/apply.test.ts`

Expected: FAIL. `packages/net/src/apply.ts` does not exist yet, so the whole
file fails to load (no individual test runs):

```
Error: Cannot find module '../src/apply' imported from
'/home/kasm-user/tapkart/packages/net/test/apply.test.ts'
  ...
Caused by: Error: Failed to load url ../src/apply (resolved id: ../src/apply)
in .../packages/net/test/apply.test.ts. Does the file exist?

 Test Files  1 failed (1)
      Tests  no tests
```

(Verified directly against this repo's installed Vitest 3.2.7 / Vite toolchain,
not assumed: a probe test importing a nonexistent sibling module under this
exact `vitest.config.ts` produces exactly this two-part message — "Cannot find
module" as the primary error, "Failed to load url ... Does the file exist?" as
its cause. If `packages/net/package.json`, `packages/net/tsconfig.json` or
`packages/net/test/fixtures/net-fixtures.ts` also do not exist yet at the time
this step runs, the failure will instead be about one of *those* missing
first — Tasks 11 and 12 must land before this one for exactly that reason.)

- [ ] **Step 3: Write the minimal implementation**

Create `packages/net/src/apply.ts`:

```ts
import type { AuthEvent, SimContext, SimState } from '@tapkart/sim'
import { applyItemGrant, kartById } from '@tapkart/sim'

/**
 * The follower's half of the emit-gating rule (locked contract §1b, §5).
 *
 * A leader's `emit()` (packages/sim/src/state.ts) stamps every AuthEvent with
 * the state's own `nextEventSeq` and then advances it. A follower never calls
 * `emit()` (every one of its 11 call sites is gated on `ctx.isLeader`), so a
 * follower's `nextEventSeq` is advanced *only* by applying events received off
 * the wire — this function is the entire mechanism by which that happens.
 *
 * Returns `false`, and changes nothing, when `ev.eventSeq` is at or below the
 * highest already applied: a duplicate delivery (the reliable channel is
 * ordered but a caller might still redeliver a batch it already processed) or
 * a stale/out-of-order arrival is a safe no-op, which is exactly what makes
 * authority migration safe (spec §5) — a promoted shadow's re-broadcast events
 * are never double-counted by a peer that already saw them once.
 *
 * Per-kind mutation is documented in full in this task's brief; the short
 * version: `itemGrant` (leader-only PRNG roll), `hit`/`spinOut` (caused by an
 * entity the receiver never simulated) and `finish` (WireSnapshot carries no
 * placement data at all) carry information a receiver cannot derive any other
 * way and must be applied. `respawn` and `lapCross` are self-derivable by a
 * peer correctly predicting its own kart, but are applied anyway — cheap,
 * idempotent, and consistent with what the next WireSnapshot would show.
 * `entitySpawn`/`entityDespawn` carry no position (AuthEvent has no Vec3 field
 * at all) and mutate nothing; entity truth is exclusively WireSnapshot's job.
 */
export function applyEvent(ctx: SimContext, state: SimState, ev: AuthEvent): boolean {
  if (ev.eventSeq < state.nextEventSeq) return false
  state.nextEventSeq = ev.eventSeq + 1

  switch (ev.kind) {
    case 'itemGrant': {
      // Both halves of a pickup: the kart's item AND the box's respawn timer
      // (ev.data is the boxIdx). packages/sim/src/items.ts owns this operation
      // and is written for exactly this receiving path - see the brief.
      applyItemGrant(ctx, state, ev)
      return true
    }
    case 'hit': {
      if (ev.data === 1) {
        const k = kartById(state, ev.playerId)
        if (k !== null) k.shielded = false
      }
      return true
    }
    case 'spinOut': {
      const k = kartById(state, ev.playerId)
      if (k !== null) {
        k.spinOutTicks = ev.data
        k.drift.active = false
        k.drift.dir = 0
        k.drift.charge = 0
        k.boostTicks = 0
      }
      return true
    }
    case 'respawn': {
      const k = kartById(state, ev.playerId)
      if (k !== null) k.respawnTicks = ev.data
      return true
    }
    case 'lapCross': {
      const k = kartById(state, ev.playerId)
      if (k !== null) {
        k.lap.lap = ev.data
        k.lap.checkpointIdx = 0
      }
      return true
    }
    case 'finish': {
      if (ev.playerId === -1) {
        state.phase = 'finished'
        return true
      }
      const slot = ev.data - 1
      if (slot >= 0 && slot < state.finishedOrder.length) {
        state.finishedOrder[slot] = ev.playerId
      }
      if (state.finishTick < 0) state.finishTick = ev.tick
      return true
    }
    case 'entitySpawn':
    case 'entityDespawn':
      return true
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/net/test/apply.test.ts`

Expected: PASS — 13 tests. (This exact implementation and an equivalent test
file were run against the real, currently-merged `packages/sim` during the
writing of this brief, via temporary files under `packages/sim/test/` importing
`packages/sim/src` by relative path in place of `@tapkart/sim` — 10 tests in
that dry run, split into 12 here after separating two assertions in the
sequencing tests into their own `it` blocks for a clearer failure signal, plus
one more added by the fix pass for the item-box half of an `itemGrant`. Both
`npx vitest run` and `npx tsc --noEmit -p packages/sim/tsconfig.json` were
green on that dry run before it was deleted; no source of this brief is
untested reasoning.)

- [ ] **Step 5: Typecheck and run the full net suite**

Run: `npx tsc --noEmit -p packages/net/tsconfig.json && npx vitest run packages/net`

Expected: PASS, zero type errors, every `net` test green (this task's 13 plus
whatever Tasks 11–12 already shipped).

- [ ] **Step 6: Commit**

```bash
git add packages/net/src/apply.ts packages/net/test/apply.test.ts
git commit -m "feat(net): applyEvent, the follower's half of emit-gating

applyEvent(ctx, state, ev) is what makes a follower's nextEventSeq track
the leader's without ever emitting (contract §1b): it advances
nextEventSeq on every non-stale event and ignores anything at or below
the highest already applied, which is what makes authority migration
safe.

Per-kind mutation is real, not uniform bookkeeping: itemGrant (leader-only
PRNG roll - delegated to sim's own applyItemGrant so the item box's
respawn timer, the half no WireSnapshot field carries, is applied too),
hit/spinOut (caused by an entity the receiver never
simulated - 'the local kart's hit reaction plays on receipt, not on
prediction', spec 5) and finish (WireSnapshot carries no placement data
at all) all carry information a receiver cannot derive by re-simulating
and must be applied from the wire. respawn/lapCross are self-derivable
but applied anyway for defense in depth. entitySpawn/entityDespawn carry
no position - AuthEvent has no Vec3 field - and mutate nothing beyond
sequencing; entity truth is exclusively WireSnapshot's job."
```
