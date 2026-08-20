### Task 6: The snapshot codec — `encodeSnapshot`, `decodeSnapshot`, `applySnapshotToState`

This is Plan 2's Task 6, contract §3: `packages/protocol/src/snapshot.ts`. It projects
`SimState` onto the wire and back, at contract §4's per-kart layout. Task 4
(`bits.ts`) and Task 5 (`quant.ts`) are both already merged when this task starts;
Task 3's `packages/protocol/src/types.ts` supplies `WireKart`/`WireEntity`/
`WireSnapshot` exactly as contract §3 lists them — this task consumes those types,
it does not redefine them.

**`WireSnapshot` is a lossy projection, never a resume point.** Spec §3 names
conflating a `WireSnapshot` with `SimState` as "the single biggest defect found in
review." `SimState` carries process/race-lifecycle bookkeeping no client or shadow
ever needs from a 20Hz unreliable-channel packet — the PRNG cursor that only the
leader's item rolls consume, the event counter that a follower advances solely by
*applying* events (contract §0's eleventh convention), the entity-id allocator, and
so on. `applySnapshotToState` therefore writes only the fields the wire actually
carries, and **must not touch**: `rngCursor`, `nextEventSeq`, `nextEntityId`,
`itemBoxes`, `finishedOrder`, `phase`, `finishTick`, `heldBotIntent`, `heldBotTick`.
Two more fields are untouched for the same reason though nothing had to forbid them
explicitly — there is simply no wire data for them: `raceSeed` (not a
`WireSnapshot` field at all) and `karts[i].characterIdx` (see the next paragraph).
Step 17 below constructs a `dst` state with a marker value in every one of these
fields and asserts every marker survives `applySnapshotToState` untouched.

**`characterIdx` is deliberately absent from the wire.** Contract §1c/§5: it is
static for the whole race and arrives once, over the reliable channel, at character
select — it is not per-tick state, so the "per-kart record is a complete projection
of every `KartState` field" invariant does not reach it. `WireKart` has no
`characterIdx` field (confirmed by reading contract §3's interface directly, not
assumed), and `applySnapshotToState` leaves `dst.karts[i].characterIdx` exactly as
it found it. Do not "fix" this by adding the field — it is excluded on purpose.

**Entities are packed at the front with `entityCount` live; dead slots sentinel
`entityId === -1`.** `SimState.entities` already maintains this invariant internally
(verified by reading `packages/sim/src/entity.ts`'s `clearSlot`, lines 20-38: a dead
slot has `entityId: -1, kind: 'seeker', ownerId: -1`, zeroed position/velocity,
`heading: 0, targetId: -1, ttl: 0` — despawn is a swap-remove that keeps every live
entity inside `[0, entityCount)`). `encodeSnapshot` therefore only ever writes
`state.entityCount` entity records, not all `MAX_ENTITIES` — that is the whole
reason a typical 6-entity snapshot is smaller than a 32-entity one. `decodeSnapshot`
is the side that has to *restore* the invariant on a caller-owned, reused
`out.entities` array: it writes the `entityCount` live records from the wire into
`out.entities[0 .. entityCount)`, and it must **re-sentinel every slot from
`entityCount` to `MAX_ENTITIES - 1` on every call** — not just the first one. A
`WireSnapshot` target is decoded into repeatedly across a race (20 times a second),
and a slot that held a live entity on one decode and is empty on the next must not
be left showing the previous entity's `entityId`. Step 15 below decodes a 1-entity
snapshot, then decodes a 0-entity snapshot into the *same* `out`, and asserts slot 0
reads `entityId === -1` afterward — the specific failure mode a decoder that only
writes `[0, entityCount)` and never touches the rest would produce.

**`decodeSnapshot`'s re-sentinelling does not — and cannot — reach `targetId`,
because `WireEntity` has no such field (contract §3); the obligation lands on
`applySnapshotToState` instead, which writes into `SimState.entities`, and
`EntityState` *does* have one.** `packages/sim/src/entity.ts`'s `clearSlot`
pairs `entityId: -1` with `targetId: -1` always — a dead slot's `targetId` is
never meaningfully anything else. Step 7's `applySnapshotToState` below resets
`e.targetId` to `-1` on exactly the slots where `s.entityId === -1`, and leaves
a live slot's `targetId` exactly as it found it (still correct — `WireEntity`
carries no data for it either way). Without this, a slot that held a live
seeker on an earlier decode keeps that seeker's old `targetId` after the seeker
despawns and the slot is re-sentinelled — residue with no wire representation,
consumed downstream by `ShadowLoop.reconcile` (Task 16), which calls this
function directly.

**Two settled facts from contract §4's own current text — not open disputes, and not
this task's to re-litigate, but restated here because an earlier draft of this brief
argued them as unresolved:**

1. **No per-record byte alignment.** Contract §4 states this directly: *"The
   per-record byte figures are informational, not a padding rule. The stream is
   continuously bit-packed — `BitWriter`/`BitReader` expose no `align()` and none is
   wanted. A record does not start on a byte boundary, and encoders must not assume
   it does."* This task packs the header, then all 8 kart records, then all
   `entityCount` entity records, fully continuously; the only padding anywhere is
   the implicit zero-padding of the buffer's final partial byte, which
   `BitWriter.byteLength()` already accounts for and which `decodeSnapshot` never
   reads (it stops after the same fields the matching encode wrote).
2. **Entity `velocity` is a full quantised `Vec3` (3×12 bits, `Q.velocity`), not a
   packed single `u16`.** Contract §4 gives the itemised list directly: `entityId
   u16, kind u4, ownerId u3, position 3×u16, velocity 3×u12, heading u12, ttl u16` →
   **135 bits**, and says so explicitly: *"This is 135 bits, not the 13 B an earlier
   draft claimed... Resolved in favour of the itemised list and the locked type:
   entities are interpolated rather than predicted, and real per-axis velocity is
   what makes that interpolation good."* This task honors that itemised list and the
   locked `WireEntity.velocity: Vec3` type exactly; there is no packed-`u16` scheme
   to reconstruct. Step 12 below pins the entity bit count (135) in a test so a
   future "fix" that quietly reintroduces a packed scheme is caught immediately.

**Two more decisions, ordinary ones this file has to make that are not disputes with
the contract:**

3. **`isBot` and `connected` each get their own wire bit — they are never merged.**
   Contract §4 is explicit and deliberate about this: *"`isBot` and `connected` get a
   bit each, deliberately. An earlier draft implied they shared one, which only works
   if `isBot === !connected` always holds. It happens to hold in shipped Plan 1 code,
   but it is an *emergent* property... not an invariant anything enforces — and spec
   §5 has a dropped client's kart 'taken over by a bot' and then 'reclaim[ed] on
   reconnect', which is exactly the transition where the two could legitimately
   disagree for a tick."* `encodeSnapshot` therefore writes `k.isBot` and
   `k.connected` as two independent 1-bit fields, in that row order (`isBot` then
   `connected`, matching contract §4's table), and `decodeSnapshot` reads both back
   independently — neither is ever derived from the other. `applySnapshotToState`
   copies both `WireKart.isBot` and `WireKart.connected` straight into `SimState`,
   so a snapshot genuinely carrying a disagreement (bot-takeover, then a reconnect
   racing the next snapshot) reconciles correctly instead of silently normalising to
   `isBot = !connected`.
4. **`driftActive`+`driftDir` pack into 2 bits as `0`=inactive, `1`=active
   dir=-1, `2`=active dir=1 (`3` unused).** Verified against
   `packages/sim/src/drift.ts`: every branch of `updateDrift` that sets
   `d.active = false` also sets `d.dir = 0` in the same branch (the
   `steeringLocked` early return, the "released with no drift held" branch, and the
   "speed fell below `driftMinSpeed` while active" branch all do this together),
   and `d.dir` is set to a nonzero value only in the one branch that also sets
   `d.active = true`. So only three `(active, dir)` combinations are ever
   reachable, and 2 bits (4 codes) is exactly enough.

**Files:**
- Create: `packages/protocol/src/snapshot.ts`
- Test: `packages/protocol/test/snapshot.test.ts`

**Interfaces:**
- Consumes (from `@tapkart/sim`, already merged):
  - `type Vec3 = { x: number; y: number; z: number }`
  - `type Surface = 'tarmac' | 'dirt' | 'boost' | 'offtrack'`
  - `type ItemKind = 'none' | 'boost' | 'seeker' | 'bolt' | 'slick' | 'bubble' |
    'surge' | 'blink' | 'charge'`
  - `type EntityKind = 'seeker' | 'bolt' | 'slick' | 'bubble' | 'surge' | 'charge'`
  - `interface KartState { playerId; characterIdx; isBot; connected; position;
    velocity; heading; angularVelocity; drift: { active; dir; charge }; item;
    airborne; surface; spinOutTicks; invulnTicks; boostTicks; respawnTicks;
    shielded; lap: { lap; checkpointIdx; t } }`
  - `interface EntityState { entityId; kind; ownerId; position; velocity; heading;
    targetId; ttl }`
  - `interface SimState { tick; phase; raceSeed; rngCursor; nextEventSeq;
    finishTick; karts; entities; entityCount; nextEntityId; itemBoxes;
    finishedOrder; heldBotIntent; heldBotTick }` — the last two fields exist because
    Plan 2 Task 1 (contract §1a) already landed before this task starts.
  - `const MAX_KARTS = 8`, `const MAX_ENTITIES = 32`
- Consumes (from Task 3, `packages/protocol/src/types.ts`) — do not redefine any of
  these, and note that `WireKart`/`WireEntity` are **flat**: `driftCharge`,
  `driftActive`, `driftDir`, `lap`, `checkpointIdx`, `t` are top-level fields on
  `WireKart`, not nested the way `KartState.drift`/`KartState.lap` are:
  ```ts
  interface WireKart {
    playerId: number; position: Vec3; velocity: Vec3; heading: number
    angularVelocity: number; driftCharge: number; driftActive: boolean
    driftDir: -1 | 0 | 1; airborne: boolean; surface: Surface
    spinOutTicks: number; invulnTicks: number; item: ItemKind
    lap: number; checkpointIdx: number; t: number
    isBot: boolean; connected: boolean
    boostTicks: number; respawnTicks: number; shielded: boolean
  }
  interface WireEntity {
    entityId: number; kind: EntityKind; ownerId: number
    position: Vec3; velocity: Vec3; heading: number; ttl: number
  }
  interface WireSnapshot {
    tick: number; eventSeq: number
    lastProcessedInputTick: number[]      // length MAX_KARTS
    karts: WireKart[]                     // length MAX_KARTS
    entities: WireEntity[]                // length MAX_ENTITIES, live packed at front
    entityCount: number
  }
  ```
- Consumes (from Task 4, `packages/protocol/src/bits.ts`): `BitWriter`, `BitReader`
  exactly as that task built them.
- Consumes (from Task 5, `packages/protocol/src/quant.ts`): `Q` (this task never
  needs `EPS` or `quantStep` for its implementation — only its tests, to compute
  round-trip tolerances). `Q` covers only the six continuous fields (`position,
  velocity, heading, angularVelocity, driftCharge, t`); this task sources the
  fourteen exact/enum fields' bit widths itself, as local constants (Step 3).
- Produces (`packages/protocol/src/snapshot.ts`), contract §3:
  ```ts
  export function encodeSnapshot(out: Uint8Array, state: SimState,
                                 lastProcessedInputTick: number[]): number   // bytes written
  export function decodeSnapshot(buf: Uint8Array, out: WireSnapshot): void
  export function applySnapshotToState(snap: WireSnapshot, dst: SimState): void
  ```
  Plus module-private helpers this task defines and does not export (not in the
  contract, so declared here per its own instruction that a task needing something
  absent "must define it in its own files and say so"): `ITEM_KINDS`, `SURFACES`,
  `ENTITY_KINDS` (arrays giving each string-literal enum a wire index, in the exact
  declaration order `packages/sim/src/types.ts` lists them — verified by reading
  that file directly), `packDrift`, `unpackDriftActive`, `unpackDriftDir`, and 22
  bit-width constants named in Step 3: 4 for the entity record (`ENTITY_ID_BITS`,
  etc.), 4 for the header (`HEADER_TICK_BITS`, etc.), and 14 for the per-kart exact
  fields (`SPIN_OUT_TICKS_BITS` through `PLAYER_ID_BITS`) that contract §4 gives no
  `Q`/`EPS` entry to, per Task 5.

**Wire order, stated once here because nothing else in the codebase enforces it and
encode/decode must agree byte-for-byte:** header, then all `MAX_KARTS` kart records
in slot order `0..7` (each kart's 24 fields — `position`/`velocity` count as 3 wire
writes each, x/y/z — in exactly contract §4's row order, listed field-by-field in
Step 3), then `state.entityCount` entity records in their already-packed order.
Header field order is `tick`, `eventSeq`, `lastProcessedInputTick[0..7]`,
`entityCount` — `entityCount` is read *before* the entities so a streaming decoder
knows how many to expect; `WireSnapshot`'s own TypeScript field order (which lists
`entities` before `entityCount`, purely for interface readability) is not the wire
order.

**`lastProcessedInputTick` entries are biased by `+1` on the wire, the same scheme
contract §4a already uses for `AuthEvent.playerId`/`entityId`.** The field is `-1`
for "no real input received yet from this player" (spec §5's definition: the
newest *real*, non-held input the authority had folded in) and unsigned `u16`
otherwise (contract §4). Writing the raw signed value with `writeBits(v, 16)` is
not a round-trip bug in the narrow sense — `BitWriter`/`BitReader` treat `-1` as
`0xFFFF` and read it back as `0xFFFF` — but it silently *relabels* "nothing
received yet" as "the authority's newest real input for this player was tick
65535," which is a different, false claim about the world. Task 9's `events.ts`
already establishes the pattern for exactly this shape of problem: store
`value + 1`, so the sentinel travels as `0` and every real tick `T` travels as
`T + 1`. `encodeSnapshot` therefore writes `lastProcessedInputTick[i] + 1`, and
`decodeSnapshot` reads it back and subtracts `1`. The cost is one representable
tick at the far end of the 16-bit range (`65534` instead of `65535`), matching the
cost Task 9 already accepted for `playerId`/`entityId`. Nothing in Plan 2 compares
against this field yet (contract §0/§5: no task anchors reconciliation on it), so
the bug was latent — but the wire format is still wrong today, and a later plan
that starts reading it inherits a value that means the opposite of what it says.

---

- [ ] **Step 1: Write the failing tests for `encodeSnapshot`/`decodeSnapshot`**

Create `packages/protocol/test/snapshot.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { EntityState, Intent, KartState, SimState } from '@tapkart/sim'
import { MAX_ENTITIES, MAX_KARTS } from '@tapkart/sim'
import type { WireEntity, WireKart, WireSnapshot } from '../src/types'
import { BitWriter } from '../src/bits'
import { Q, quantStep } from '../src/quant'
import { decodeSnapshot, encodeSnapshot } from '../src/snapshot'

// 743 B covers the worst case (MAX_ENTITIES=32 live entities, all 8 karts) with
// margin: header(200) + 8*178 kart bits + 32*135 entity bits = 5944 bits = 743 B
// exactly. 1024 gives headroom above that without needing to be recomputed if a
// field width ever changes by a bit or two.
const BUF_SIZE = 1024

const STEP_POS = quantStep(Q.position.min, Q.position.max, Q.position.bits)
const STEP_VEL = quantStep(Q.velocity.min, Q.velocity.max, Q.velocity.bits)
const STEP_HEADING = quantStep(Q.heading.min, Q.heading.max, Q.heading.bits)
const STEP_ANGVEL = quantStep(Q.angularVelocity.min, Q.angularVelocity.max, Q.angularVelocity.bits)
const STEP_DRIFT_CHARGE = quantStep(Q.driftCharge.min, Q.driftCharge.max, Q.driftCharge.bits)
const STEP_T = quantStep(Q.t.min, Q.t.max, Q.t.bits)

function makeNeutralIntent(): Intent {
  return { tick: 0, steer: 0, accel: 0, brake: false, drift: false, useItem: false }
}

function makeKart(playerId: number): KartState {
  return {
    playerId,
    characterIdx: 0,
    isBot: true,
    connected: false,
    position: { x: 0, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    heading: 0,
    angularVelocity: 0,
    drift: { active: false, dir: 0, charge: 0 },
    item: 'none',
    airborne: false,
    surface: 'tarmac',
    spinOutTicks: 0,
    invulnTicks: 0,
    boostTicks: 0,
    respawnTicks: 0,
    shielded: false,
    lap: { lap: 0, checkpointIdx: 0, t: 0 },
  }
}

function makeDeadEntity(): EntityState {
  return {
    entityId: -1,
    kind: 'seeker',
    ownerId: -1,
    position: { x: 0, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    heading: 0,
    targetId: -1,
    ttl: 0,
  }
}

function makeState(): SimState {
  const karts: KartState[] = []
  for (let i = 0; i < MAX_KARTS; i++) karts.push(makeKart(i))
  const entities: EntityState[] = []
  for (let i = 0; i < MAX_ENTITIES; i++) entities.push(makeDeadEntity())
  return {
    tick: 0,
    phase: 'racing',
    raceSeed: 0,
    rngCursor: 0,
    nextEventSeq: 0,
    finishTick: -1,
    karts,
    entities,
    entityCount: 0,
    nextEntityId: 1,
    itemBoxes: [],
    finishedOrder: [-1, -1, -1, -1, -1, -1, -1, -1],
    heldBotIntent: Array.from({ length: MAX_KARTS }, makeNeutralIntent),
    heldBotTick: Array.from({ length: MAX_KARTS }, () => -1),
  }
}

function makeWireKart(): WireKart {
  return {
    playerId: 0,
    position: { x: 0, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    heading: 0,
    angularVelocity: 0,
    driftCharge: 0,
    driftActive: false,
    driftDir: 0,
    airborne: false,
    surface: 'tarmac',
    spinOutTicks: 0,
    invulnTicks: 0,
    item: 'none',
    lap: 0,
    checkpointIdx: 0,
    t: 0,
    isBot: true,
    connected: false,
    boostTicks: 0,
    respawnTicks: 0,
    shielded: false,
  }
}

function makeWireEntity(): WireEntity {
  return {
    entityId: -1,
    kind: 'seeker',
    ownerId: -1,
    position: { x: 0, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    heading: 0,
    ttl: 0,
  }
}

function makeEmptySnapshot(): WireSnapshot {
  return {
    tick: 0,
    eventSeq: 0,
    lastProcessedInputTick: new Array(MAX_KARTS).fill(0) as number[],
    karts: Array.from({ length: MAX_KARTS }, makeWireKart),
    entities: Array.from({ length: MAX_ENTITIES }, makeWireEntity),
    entityCount: 0,
  }
}

describe('encodeSnapshot / decodeSnapshot', () => {
  it('round-trips every kart field, within step for continuous fields, exactly for exact fields', () => {
    const state = makeState()
    state.tick = 12345
    state.nextEventSeq = 42
    const k0 = state.karts[0]
    k0.position = { x: 100.25, y: 3, z: -400.5 }
    k0.velocity = { x: 10, y: -2, z: 5.5 }
    k0.heading = 1.2
    k0.angularVelocity = -3.5
    k0.drift = { active: true, dir: -1, charge: 40 }
    k0.item = 'bolt'
    k0.airborne = true
    k0.surface = 'dirt'
    k0.spinOutTicks = 12
    k0.invulnTicks = 30
    k0.boostTicks = 5
    k0.respawnTicks = 9
    k0.shielded = true
    k0.connected = true
    k0.isBot = false
    k0.lap = { lap: 2, checkpointIdx: 5, t: 0.37 }

    // kart 1 deliberately disagrees: isBot and connected both true. Under a decode
    // that (wrongly) derives isBot as !connected, this combination is unreachable;
    // it is also NOT makeWireKart's default pair (isBot: true, connected: false),
    // so this proves both bits are read off the wire independently rather than one
    // being inferred from the other's default. This is exactly the spec §5
    // transition ("taken over by a bot", "reclaim[ed] on reconnect") where the two
    // can legitimately disagree for a tick.
    const k1 = state.karts[1]
    k1.drift = { active: true, dir: 1, charge: 200 }
    k1.item = 'charge'
    k1.surface = 'boost'
    k1.connected = true
    k1.isBot = true

    const buf = new Uint8Array(BUF_SIZE)
    const lastProcessedInputTick = [100, 101, 0, 0, 0, 0, 0, 0]
    const bytes = encodeSnapshot(buf, state, lastProcessedInputTick)

    const snap = makeEmptySnapshot()
    decodeSnapshot(buf.subarray(0, bytes), snap)

    expect(snap.tick).toBe(12345)
    expect(snap.eventSeq).toBe(42)
    expect(snap.lastProcessedInputTick).toEqual(lastProcessedInputTick)

    const d0 = snap.karts[0]
    expect(Math.abs(d0.position.x - 100.25)).toBeLessThan(STEP_POS)
    expect(Math.abs(d0.position.y - 3)).toBeLessThan(STEP_POS)
    expect(Math.abs(d0.position.z - -400.5)).toBeLessThan(STEP_POS)
    expect(Math.abs(d0.velocity.x - 10)).toBeLessThan(STEP_VEL)
    expect(Math.abs(d0.velocity.y - -2)).toBeLessThan(STEP_VEL)
    expect(Math.abs(d0.velocity.z - 5.5)).toBeLessThan(STEP_VEL)
    expect(Math.abs(d0.heading - 1.2)).toBeLessThan(STEP_HEADING)
    expect(Math.abs(d0.angularVelocity - -3.5)).toBeLessThan(STEP_ANGVEL)
    expect(Math.abs(d0.driftCharge - 40)).toBeLessThan(STEP_DRIFT_CHARGE)
    expect(Math.abs(d0.t - 0.37)).toBeLessThan(STEP_T)
    expect(d0.driftActive).toBe(true)
    expect(d0.driftDir).toBe(-1)
    expect(d0.item).toBe('bolt')
    expect(d0.airborne).toBe(true)
    expect(d0.surface).toBe('dirt')
    expect(d0.spinOutTicks).toBe(12)
    expect(d0.invulnTicks).toBe(30)
    expect(d0.boostTicks).toBe(5)
    expect(d0.respawnTicks).toBe(9)
    expect(d0.shielded).toBe(true)
    expect(d0.connected).toBe(true)
    expect(d0.isBot).toBe(false)
    expect(d0.lap).toBe(2)
    expect(d0.checkpointIdx).toBe(5)
    expect(d0.playerId).toBe(0)

    const d1 = snap.karts[1]
    expect(d1.driftActive).toBe(true)
    expect(d1.driftDir).toBe(1)
    expect(d1.item).toBe('charge')
    expect(d1.surface).toBe('boost')
    // Both true: proves connected did not decode as !isBot, and vice versa.
    expect(d1.connected).toBe(true)
    expect(d1.isBot).toBe(true)
    // kart 0's playerId (0) is tautological -- it equals both the slot index and
    // WireKart's own default. kart 1's playerId (1) is neither, so this is the
    // assertion that actually proves playerId is read off the wire.
    expect(d1.playerId).toBe(1)
  })

  it('round-trips every continuous kart field at both range endpoints exactly', () => {
    const state = makeState()
    const k = state.karts[0]
    k.position = { x: -1024, y: 1024, z: -1024 }
    k.velocity = { x: -64, y: 64, z: -64 }
    k.heading = -Math.PI
    k.angularVelocity = 16
    k.drift.charge = 255
    // t's range is [0, 1); 1 is the upper endpoint writeFloatQ clamps to and
    // quantises exactly. 0 would coincide with makeWireKart's default and prove
    // nothing about decode actually running.
    k.lap.t = 1

    const buf = new Uint8Array(BUF_SIZE)
    const bytes = encodeSnapshot(buf, state, new Array(MAX_KARTS).fill(0))
    const snap = makeEmptySnapshot()
    decodeSnapshot(buf.subarray(0, bytes), snap)

    const d = snap.karts[0]
    expect(d.position).toEqual({ x: -1024, y: 1024, z: -1024 })
    expect(d.velocity).toEqual({ x: -64, y: 64, z: -64 })
    expect(d.heading).toBe(-Math.PI)
    expect(d.angularVelocity).toBe(16)
    expect(d.driftCharge).toBe(255)
    expect(d.t).toBe(1)
  })

  it('clamps out-of-range continuous kart fields instead of wrapping', () => {
    const state = makeState()
    const k = state.karts[0]
    k.position = { x: 5000, y: -5000, z: 0 }
    k.velocity = { x: 100, y: -100, z: 0 }

    const buf = new Uint8Array(BUF_SIZE)
    const bytes = encodeSnapshot(buf, state, new Array(MAX_KARTS).fill(0))
    const snap = makeEmptySnapshot()
    decodeSnapshot(buf.subarray(0, bytes), snap)

    const d = snap.karts[0]
    expect(d.position.x).toBe(1024)
    expect(d.position.y).toBe(-1024)
    expect(d.velocity.x).toBe(64)
    expect(d.velocity.y).toBe(-64)
  })

  it('round-trips live entities packed at the front, sentinels the rest', () => {
    const state = makeState()
    state.entityCount = 2
    state.entities[0] = {
      entityId: 7, kind: 'seeker', ownerId: 3,
      position: { x: 10, y: 0, z: -20 }, velocity: { x: 1, y: 0, z: -1 },
      heading: 0.5, targetId: 4, ttl: 560,
    }
    state.entities[1] = {
      entityId: 8, kind: 'bolt', ownerId: 1,
      position: { x: -5, y: 2, z: 5 }, velocity: { x: -3, y: 0, z: 3 },
      heading: -1.1, targetId: -1, ttl: 30,
    }

    const buf = new Uint8Array(BUF_SIZE)
    const bytes = encodeSnapshot(buf, state, new Array(MAX_KARTS).fill(0))
    const snap = makeEmptySnapshot()
    // Dirty a dead-range slot before decoding, so the tail loop below proves
    // decodeSnapshot actively re-sentinels rather than reading makeWireEntity's
    // already-(-1) default off an untouched object.
    snap.entities[5].entityId = 12345
    decodeSnapshot(buf.subarray(0, bytes), snap)

    expect(snap.entityCount).toBe(2)
    expect(snap.entities[0].entityId).toBe(7)
    expect(snap.entities[0].kind).toBe('seeker')
    expect(snap.entities[0].ownerId).toBe(3)
    expect(Math.abs(snap.entities[0].position.x - 10)).toBeLessThan(STEP_POS)
    expect(Math.abs(snap.entities[0].velocity.z - -1)).toBeLessThan(STEP_VEL)
    expect(Math.abs(snap.entities[0].heading - 0.5)).toBeLessThan(STEP_HEADING)
    expect(snap.entities[0].ttl).toBe(560) // exercises the u8 -> u16 amendment headroom

    expect(snap.entities[1].entityId).toBe(8)
    expect(snap.entities[1].kind).toBe('bolt')

    for (let i = 2; i < MAX_ENTITIES; i++) {
      expect(snap.entities[i].entityId).toBe(-1)
    }
  })

  it('re-sentinels a slot that held a live entity on a previous decode', () => {
    const buf = new Uint8Array(BUF_SIZE)
    const snap = makeEmptySnapshot()

    const busy = makeState()
    busy.entityCount = 1
    busy.entities[0] = {
      entityId: 9, kind: 'slick', ownerId: 2,
      position: { x: 1, y: 0, z: 1 }, velocity: { x: 0, y: 0, z: 0 },
      heading: 0, targetId: -1, ttl: 100,
    }
    let bytes = encodeSnapshot(buf, busy, new Array(MAX_KARTS).fill(0))
    decodeSnapshot(buf.subarray(0, bytes), snap)
    expect(snap.entities[0].entityId).toBe(9)

    const empty = makeState()
    empty.entityCount = 0
    bytes = encodeSnapshot(buf, empty, new Array(MAX_KARTS).fill(0))
    decodeSnapshot(buf.subarray(0, bytes), snap)
    // the same caller-owned `snap` object, decoded into a second time: slot 0 held
    // entity 9 a moment ago and must not still claim to
    expect(snap.entities[0].entityId).toBe(-1)
  })

  it('returns the exact byte count for a given entityCount - no per-record padding', () => {
    const state = makeState()
    state.entityCount = 3
    for (let i = 0; i < 3; i++) state.entities[i] = { ...makeDeadEntity(), entityId: i }
    const buf = new Uint8Array(BUF_SIZE)
    const bytes = encodeSnapshot(buf, state, new Array(MAX_KARTS).fill(0))
    // 200 header bits + 8*178 kart bits + 3*135 entity bits, continuously packed,
    // rounded up once at the very end (this task's settled facts 1 and 2)
    const totalBits = 200 + MAX_KARTS * 178 + 3 * 135
    expect(bytes).toBe(Math.ceil(totalBits / 8))
  })

  it('round-trips at the worst case: MAX_ENTITIES live entities, all karts populated', () => {
    // header(200) + 8*178 kart bits + 32*135 entity bits = 5944 bits = 743 B
    // exactly -- the figure contract §4 and spec §5 both give as the worst case.
    // BitWriter.writeBits silently no-ops past a Uint8Array's end (Task 4), so an
    // undersized buffer here would truncate without ever throwing; this is the one
    // test in this task that would catch it.
    const state = makeState()
    state.entityCount = MAX_ENTITIES
    for (let i = 0; i < MAX_ENTITIES; i++) {
      state.entities[i] = {
        entityId: i + 1, kind: 'seeker', ownerId: i % MAX_KARTS,
        position: { x: i, y: 0, z: -i }, velocity: { x: 1, y: 0, z: -1 },
        heading: 0.1 * i, targetId: -1, ttl: 100 + i,
      }
    }
    const buf = new Uint8Array(BUF_SIZE)
    const bytes = encodeSnapshot(buf, state, new Array(MAX_KARTS).fill(0))
    expect(bytes).toBe(743)

    const snap = makeEmptySnapshot()
    decodeSnapshot(buf.subarray(0, bytes), snap)
    expect(snap.entityCount).toBe(MAX_ENTITIES)
    expect(snap.entities[MAX_ENTITIES - 1].entityId).toBe(MAX_ENTITIES)
    expect(snap.entities[MAX_ENTITIES - 1].ttl).toBe(100 + MAX_ENTITIES - 1)
  })

  it('round-trips the -1 "no real input yet" sentinel in lastProcessedInputTick, biased so it never collides with a real tick', () => {
    // Without the +1 bias, -1 encodes as the raw two's-complement bit pattern
    // BitWriter.writeBits produces for a negative value into 16 bits (0xFFFF)
    // and decodes back as 65535 -- a real (if implausible) tick number, not
    // "nothing received yet". This state's tick/entity contents don't matter;
    // only the header's lastProcessedInputTick array is under test here.
    const state = makeState()
    const buf = new Uint8Array(BUF_SIZE)
    // Mixes the sentinel with real ticks, including one adjacent to the
    // sentinel's own biased wire value (0) and one near the top of the
    // biased range, so an off-by-one in the bias would show up as a specific
    // wrong number rather than a coincidental pass.
    const lastProcessedInputTick = [-1, 0, 1, -1, 65534, -1, -1, -1]
    const bytes = encodeSnapshot(buf, state, lastProcessedInputTick)

    const snap = makeEmptySnapshot()
    decodeSnapshot(buf.subarray(0, bytes), snap)

    expect(snap.lastProcessedInputTick).toEqual(lastProcessedInputTick)
  })

  it('writes header then karts in exactly contract §4 row order, then entities', () => {
    const state = makeState()
    const k = state.karts[3]
    k.position = { x: 50, y: -6, z: 12 }
    k.velocity = { x: 4, y: 1, z: -2 }
    k.heading = -0.3
    k.angularVelocity = 2
    k.drift = { active: true, dir: 1, charge: 90 }
    k.item = 'surge'
    k.airborne = true
    k.surface = 'offtrack'
    k.spinOutTicks = 3
    k.invulnTicks = 20
    k.boostTicks = 60
    k.respawnTicks = 40
    k.lap = { lap: 1, checkpointIdx: 4, t: 0.8 }
    k.shielded = true
    k.connected = true
    k.isBot = false

    const buf = new Uint8Array(BUF_SIZE)
    const lastProcessedInputTick = [1, 2, 3, 4, 5, 6, 7, 8]
    const bytes = encodeSnapshot(buf, state, lastProcessedInputTick)

    // Independently reconstruct the same message with the raw primitives, in
    // exactly contract §4's row order - this is the specification, not a restated
    // guess at the implementation's internals.
    const ITEM_KINDS = ['none', 'boost', 'seeker', 'bolt', 'slick', 'bubble', 'surge', 'blink', 'charge']
    const SURFACES = ['tarmac', 'dirt', 'boost', 'offtrack']
    const ref = new Uint8Array(BUF_SIZE)
    const rw = new BitWriter(ref)
    rw.writeBits(state.tick, 32)
    rw.writeBits(state.nextEventSeq, 32)
    // +1-biased, same as encodeSnapshot: -1 travels as 0.
    for (let i = 0; i < MAX_KARTS; i++) rw.writeBits(lastProcessedInputTick[i] + 1, 16)
    rw.writeBits(state.entityCount, 8)
    for (let i = 0; i < MAX_KARTS; i++) {
      const kk = state.karts[i]
      rw.writeFloatQ(kk.position.x, Q.position.min, Q.position.max, Q.position.bits)
      rw.writeFloatQ(kk.position.y, Q.position.min, Q.position.max, Q.position.bits)
      rw.writeFloatQ(kk.position.z, Q.position.min, Q.position.max, Q.position.bits)
      rw.writeFloatQ(kk.velocity.x, Q.velocity.min, Q.velocity.max, Q.velocity.bits)
      rw.writeFloatQ(kk.velocity.y, Q.velocity.min, Q.velocity.max, Q.velocity.bits)
      rw.writeFloatQ(kk.velocity.z, Q.velocity.min, Q.velocity.max, Q.velocity.bits)
      rw.writeFloatQ(kk.heading, Q.heading.min, Q.heading.max, Q.heading.bits)
      rw.writeFloatQ(kk.angularVelocity, Q.angularVelocity.min, Q.angularVelocity.max, Q.angularVelocity.bits)
      rw.writeFloatQ(kk.drift.charge, Q.driftCharge.min, Q.driftCharge.max, Q.driftCharge.bits)
      rw.writeFloatQ(kk.lap.t, Q.t.min, Q.t.max, Q.t.bits)
      rw.writeBits(kk.spinOutTicks, 8)
      rw.writeBits(kk.invulnTicks, 8)
      rw.writeBits(kk.boostTicks, 7)
      rw.writeBits(kk.respawnTicks, 7)
      rw.writeBits(kk.lap.lap, 3)
      rw.writeBits(kk.lap.checkpointIdx, 6)
      rw.writeBits(ITEM_KINDS.indexOf(kk.item), 4)
      rw.writeBits(SURFACES.indexOf(kk.surface), 2)
      rw.writeBits(!kk.drift.active ? 0 : kk.drift.dir === -1 ? 1 : 2, 2)
      rw.writeBits(kk.airborne ? 1 : 0, 1)
      rw.writeBits(kk.shielded ? 1 : 0, 1)
      rw.writeBits(kk.isBot ? 1 : 0, 1)
      rw.writeBits(kk.connected ? 1 : 0, 1)
      rw.writeBits(kk.playerId, 3)
    }

    expect(bytes).toBe(rw.byteLength())
    expect(Array.from(buf.subarray(0, bytes))).toEqual(Array.from(ref.subarray(0, bytes)))
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/protocol/test/snapshot.test.ts`

Expected: FAIL — suite fails to load, under "Failed Suites":
`Error: Cannot find module '../src/snapshot' imported from
'<repo>/packages/protocol/test/snapshot.test.ts'`. Zero tests
collected (`src/snapshot.ts` does not exist yet).

- [ ] **Step 3: Write `encodeSnapshot` and `decodeSnapshot`**

Create `packages/protocol/src/snapshot.ts`:

```ts
import type { EntityKind, ItemKind, SimState, Surface } from '@tapkart/sim'
import { MAX_ENTITIES, MAX_KARTS } from '@tapkart/sim'
import type { WireSnapshot } from './types'
import { BitReader, BitWriter } from './bits'
import { Q } from './quant'

// WireKart and WireEntity are never named directly in this file: `out.karts[i]`
// and `out.entities[i]` are inferred through WireSnapshot's own field types, and
// `noUnusedLocals` (tsconfig.base.json) rejects an import that is never
// referenced by name - only WireSnapshot itself is written as a type annotation
// below.

// Enum <-> wire-index tables. Order matches packages/sim/src/types.ts exactly
// (verified by reading that file): a reorder there without a matching reorder
// here silently relabels every item/surface/entity kind on the wire.
const ITEM_KINDS: ItemKind[] = [
  'none', 'boost', 'seeker', 'bolt', 'slick', 'bubble', 'surge', 'blink', 'charge',
]
const SURFACES: Surface[] = ['tarmac', 'dirt', 'boost', 'offtrack']
const ENTITY_KINDS: EntityKind[] = ['seeker', 'bolt', 'slick', 'bubble', 'surge', 'charge']

// Entity and header fields are plain fixed-width integers with no epsilon concept:
// sourced here as literals straight from contract §4's prose, not through Q, which
// covers only the six continuous per-kart fields.
const ENTITY_ID_BITS = 16
const ENTITY_KIND_BITS = 4
const ENTITY_OWNER_BITS = 3
const ENTITY_TTL_BITS = 16
const HEADER_TICK_BITS = 32
const HEADER_EVENT_SEQ_BITS = 32
const HEADER_LAST_INPUT_TICK_BITS = 16
const HEADER_ENTITY_COUNT_BITS = 8

// The fourteen exact/enum per-kart fields contract §4 gives no Q/EPS entry to
// (Task 5): no quantisation noise, so no epsilon, and the widths live here as
// literals in exactly contract §4's row order.
const SPIN_OUT_TICKS_BITS = 8
const INVULN_TICKS_BITS = 8
const BOOST_TICKS_BITS = 7
const RESPAWN_TICKS_BITS = 7
const LAP_BITS = 3
const CHECKPOINT_IDX_BITS = 6
const ITEM_BITS = 4
const SURFACE_BITS = 2
const DRIFT_PACKED_BITS = 2
const AIRBORNE_BITS = 1
const SHIELDED_BITS = 1
const IS_BOT_BITS = 1
const CONNECTED_BITS = 1
const PLAYER_ID_BITS = 3

/** driftActive+driftDir -> 2 raw bits. 0 = inactive, 1 = active dir -1, 2 = active
 * dir 1. 3 is unused: packages/sim/src/drift.ts never produces dir != 0 while
 * inactive (this task's decision 4). */
function packDrift(active: boolean, dir: -1 | 0 | 1): number {
  if (!active) return 0
  return dir === -1 ? 1 : 2
}

function unpackDriftActive(raw: number): boolean {
  return raw !== 0
}

function unpackDriftDir(raw: number): -1 | 0 | 1 {
  if (raw === 0) return 0
  return raw === 1 ? -1 : 1
}

/**
 * Projects `state` onto the wire. Writes the header, then all MAX_KARTS kart
 * records in slot order (each one's fields in exactly contract §4's row order),
 * then `state.entityCount` entity records (only the live ones - dead slots are
 * never written, which is why a typical snapshot is far smaller than the
 * MAX_ENTITIES worst case). Returns the number of bytes written.
 */
export function encodeSnapshot(
  out: Uint8Array,
  state: SimState,
  lastProcessedInputTick: number[],
): number {
  const bw = new BitWriter(out)

  bw.writeBits(state.tick, HEADER_TICK_BITS)
  bw.writeBits(state.nextEventSeq, HEADER_EVENT_SEQ_BITS)
  for (let i = 0; i < MAX_KARTS; i++) {
    // Biased by +1, same scheme as AuthEvent.playerId/entityId (Task 9): -1
    // ("no real input yet") travels as 0, and real tick T travels as T + 1.
    // An unbiased write would make -1 indistinguishable from "the newest real
    // input was tick 65535" on the wire.
    bw.writeBits(lastProcessedInputTick[i] + 1, HEADER_LAST_INPUT_TICK_BITS)
  }
  bw.writeBits(state.entityCount, HEADER_ENTITY_COUNT_BITS)

  for (let i = 0; i < MAX_KARTS; i++) {
    const k = state.karts[i]
    bw.writeFloatQ(k.position.x, Q.position.min, Q.position.max, Q.position.bits)
    bw.writeFloatQ(k.position.y, Q.position.min, Q.position.max, Q.position.bits)
    bw.writeFloatQ(k.position.z, Q.position.min, Q.position.max, Q.position.bits)
    bw.writeFloatQ(k.velocity.x, Q.velocity.min, Q.velocity.max, Q.velocity.bits)
    bw.writeFloatQ(k.velocity.y, Q.velocity.min, Q.velocity.max, Q.velocity.bits)
    bw.writeFloatQ(k.velocity.z, Q.velocity.min, Q.velocity.max, Q.velocity.bits)
    bw.writeFloatQ(k.heading, Q.heading.min, Q.heading.max, Q.heading.bits)
    bw.writeFloatQ(k.angularVelocity, Q.angularVelocity.min, Q.angularVelocity.max, Q.angularVelocity.bits)
    bw.writeFloatQ(k.drift.charge, Q.driftCharge.min, Q.driftCharge.max, Q.driftCharge.bits)
    bw.writeFloatQ(k.lap.t, Q.t.min, Q.t.max, Q.t.bits)
    bw.writeBits(k.spinOutTicks, SPIN_OUT_TICKS_BITS)
    bw.writeBits(k.invulnTicks, INVULN_TICKS_BITS)
    bw.writeBits(k.boostTicks, BOOST_TICKS_BITS)
    bw.writeBits(k.respawnTicks, RESPAWN_TICKS_BITS)
    bw.writeBits(k.lap.lap, LAP_BITS)
    bw.writeBits(k.lap.checkpointIdx, CHECKPOINT_IDX_BITS)
    bw.writeBits(ITEM_KINDS.indexOf(k.item), ITEM_BITS)
    bw.writeBits(SURFACES.indexOf(k.surface), SURFACE_BITS)
    bw.writeBits(packDrift(k.drift.active, k.drift.dir), DRIFT_PACKED_BITS)
    bw.writeBits(k.airborne ? 1 : 0, AIRBORNE_BITS)
    bw.writeBits(k.shielded ? 1 : 0, SHIELDED_BITS)
    // isBot and connected are two independent bits (contract §4, this task's
    // decision 3) -- neither is ever derived from the other.
    bw.writeBits(k.isBot ? 1 : 0, IS_BOT_BITS)
    bw.writeBits(k.connected ? 1 : 0, CONNECTED_BITS)
    bw.writeBits(k.playerId, PLAYER_ID_BITS)
  }

  for (let i = 0; i < state.entityCount; i++) {
    const e = state.entities[i]
    bw.writeBits(e.entityId, ENTITY_ID_BITS)
    bw.writeBits(ENTITY_KINDS.indexOf(e.kind), ENTITY_KIND_BITS)
    bw.writeBits(e.ownerId, ENTITY_OWNER_BITS)
    bw.writeFloatQ(e.position.x, Q.position.min, Q.position.max, Q.position.bits)
    bw.writeFloatQ(e.position.y, Q.position.min, Q.position.max, Q.position.bits)
    bw.writeFloatQ(e.position.z, Q.position.min, Q.position.max, Q.position.bits)
    bw.writeFloatQ(e.velocity.x, Q.velocity.min, Q.velocity.max, Q.velocity.bits)
    bw.writeFloatQ(e.velocity.y, Q.velocity.min, Q.velocity.max, Q.velocity.bits)
    bw.writeFloatQ(e.velocity.z, Q.velocity.min, Q.velocity.max, Q.velocity.bits)
    bw.writeFloatQ(e.heading, Q.heading.min, Q.heading.max, Q.heading.bits)
    bw.writeBits(e.ttl, ENTITY_TTL_BITS)
  }

  return bw.byteLength()
}

/**
 * Reverses encodeSnapshot into a caller-owned, reused `out`. `out.karts` (length
 * MAX_KARTS) and `out.entities` (length MAX_ENTITIES) are never resized - every
 * field of every element is overwritten in place, field by field, the same
 * "shared scratch" discipline `TrackQuery` uses in packages/sim.
 *
 * Entities from `entityCount` to MAX_ENTITIES - 1 are sentineled on every call
 * (entityId -1, matching packages/sim/src/entity.ts's own dead-slot convention
 * minus targetId, which WireEntity does not carry) - not just when `out` is fresh,
 * because `out` is reused across many decode calls and a slot that held a live
 * entity a moment ago must not keep claiming to.
 */
export function decodeSnapshot(buf: Uint8Array, out: WireSnapshot): void {
  const br = new BitReader(buf)

  out.tick = br.readBits(HEADER_TICK_BITS)
  out.eventSeq = br.readBits(HEADER_EVENT_SEQ_BITS)
  for (let i = 0; i < MAX_KARTS; i++) {
    // Inverse of encodeSnapshot's +1 bias: wire 0 -> -1 ("no real input yet"),
    // wire T + 1 -> real tick T.
    out.lastProcessedInputTick[i] = br.readBits(HEADER_LAST_INPUT_TICK_BITS) - 1
  }
  const entityCount = br.readBits(HEADER_ENTITY_COUNT_BITS)
  out.entityCount = entityCount

  for (let i = 0; i < MAX_KARTS; i++) {
    const k = out.karts[i]
    k.position.x = br.readFloatQ(Q.position.min, Q.position.max, Q.position.bits)
    k.position.y = br.readFloatQ(Q.position.min, Q.position.max, Q.position.bits)
    k.position.z = br.readFloatQ(Q.position.min, Q.position.max, Q.position.bits)
    k.velocity.x = br.readFloatQ(Q.velocity.min, Q.velocity.max, Q.velocity.bits)
    k.velocity.y = br.readFloatQ(Q.velocity.min, Q.velocity.max, Q.velocity.bits)
    k.velocity.z = br.readFloatQ(Q.velocity.min, Q.velocity.max, Q.velocity.bits)
    k.heading = br.readFloatQ(Q.heading.min, Q.heading.max, Q.heading.bits)
    k.angularVelocity = br.readFloatQ(Q.angularVelocity.min, Q.angularVelocity.max, Q.angularVelocity.bits)
    k.driftCharge = br.readFloatQ(Q.driftCharge.min, Q.driftCharge.max, Q.driftCharge.bits)
    k.t = br.readFloatQ(Q.t.min, Q.t.max, Q.t.bits)
    k.spinOutTicks = br.readBits(SPIN_OUT_TICKS_BITS)
    k.invulnTicks = br.readBits(INVULN_TICKS_BITS)
    k.boostTicks = br.readBits(BOOST_TICKS_BITS)
    k.respawnTicks = br.readBits(RESPAWN_TICKS_BITS)
    k.lap = br.readBits(LAP_BITS)
    k.checkpointIdx = br.readBits(CHECKPOINT_IDX_BITS)
    k.item = ITEM_KINDS[br.readBits(ITEM_BITS)]
    k.surface = SURFACES[br.readBits(SURFACE_BITS)]
    const driftRaw = br.readBits(DRIFT_PACKED_BITS)
    k.driftActive = unpackDriftActive(driftRaw)
    k.driftDir = unpackDriftDir(driftRaw)
    k.airborne = br.readBits(AIRBORNE_BITS) !== 0
    k.shielded = br.readBits(SHIELDED_BITS) !== 0
    // Two independent reads -- neither is derived from the other (decision 3).
    k.isBot = br.readBits(IS_BOT_BITS) !== 0
    k.connected = br.readBits(CONNECTED_BITS) !== 0
    k.playerId = br.readBits(PLAYER_ID_BITS)
  }

  for (let i = 0; i < entityCount; i++) {
    const e = out.entities[i]
    e.entityId = br.readBits(ENTITY_ID_BITS)
    e.kind = ENTITY_KINDS[br.readBits(ENTITY_KIND_BITS)]
    e.ownerId = br.readBits(ENTITY_OWNER_BITS)
    e.position.x = br.readFloatQ(Q.position.min, Q.position.max, Q.position.bits)
    e.position.y = br.readFloatQ(Q.position.min, Q.position.max, Q.position.bits)
    e.position.z = br.readFloatQ(Q.position.min, Q.position.max, Q.position.bits)
    e.velocity.x = br.readFloatQ(Q.velocity.min, Q.velocity.max, Q.velocity.bits)
    e.velocity.y = br.readFloatQ(Q.velocity.min, Q.velocity.max, Q.velocity.bits)
    e.velocity.z = br.readFloatQ(Q.velocity.min, Q.velocity.max, Q.velocity.bits)
    e.heading = br.readFloatQ(Q.heading.min, Q.heading.max, Q.heading.bits)
    e.ttl = br.readBits(ENTITY_TTL_BITS)
  }
  for (let i = entityCount; i < MAX_ENTITIES; i++) {
    const e = out.entities[i]
    e.entityId = -1
    e.kind = 'seeker'
    e.ownerId = -1
    e.position.x = 0
    e.position.y = 0
    e.position.z = 0
    e.velocity.x = 0
    e.velocity.y = 0
    e.velocity.z = 0
    e.heading = 0
    e.ttl = 0
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/protocol/test/snapshot.test.ts`

Expected: PASS — 9 passed.

---

- [ ] **Step 5: Write the failing tests for `applySnapshotToState`**

Append to `packages/protocol/test/snapshot.test.ts`. First widen the import from
`../src/snapshot` at the top of the file to:

```ts
import { applySnapshotToState, decodeSnapshot, encodeSnapshot } from '../src/snapshot'
```

Then append this block at the end of the file:

```ts
describe('applySnapshotToState', () => {
  it('copies every WireKart field into the matching nested SimState field', () => {
    const source = makeState()
    const k = source.karts[2]
    k.position = { x: 11, y: 2, z: -33 }
    k.velocity = { x: 1, y: 0, z: -1 }
    k.heading = 0.9
    k.angularVelocity = -1
    k.drift = { active: true, dir: -1, charge: 15 }
    k.item = 'bubble'
    k.airborne = true
    k.surface = 'dirt'
    k.spinOutTicks = 7
    k.invulnTicks = 3
    k.boostTicks = 20
    // 0 would coincide with makeKart's default and dst's own starting value,
    // proving nothing about whether this field was actually copied.
    k.respawnTicks = 15
    k.shielded = true
    k.connected = true
    k.isBot = false
    k.lap = { lap: 1, checkpointIdx: 2, t: 0.6 }

    const buf = new Uint8Array(BUF_SIZE)
    const bytes = encodeSnapshot(buf, source, new Array(MAX_KARTS).fill(0))
    const snap = makeEmptySnapshot()
    decodeSnapshot(buf.subarray(0, bytes), snap)

    const dst = makeState()
    applySnapshotToState(snap, dst)

    const dk = dst.karts[2]
    expect(Math.abs(dk.position.x - 11)).toBeLessThan(STEP_POS)
    expect(Math.abs(dk.velocity.z - -1)).toBeLessThan(STEP_VEL)
    expect(Math.abs(dk.heading - 0.9)).toBeLessThan(STEP_HEADING)
    expect(Math.abs(dk.angularVelocity - -1)).toBeLessThan(STEP_ANGVEL)
    expect(dk.drift.active).toBe(true)
    expect(dk.drift.dir).toBe(-1)
    expect(Math.abs(dk.drift.charge - 15)).toBeLessThan(STEP_DRIFT_CHARGE)
    expect(dk.item).toBe('bubble')
    expect(dk.airborne).toBe(true)
    expect(dk.surface).toBe('dirt')
    expect(dk.spinOutTicks).toBe(7)
    expect(dk.invulnTicks).toBe(3)
    expect(dk.boostTicks).toBe(20)
    expect(dk.respawnTicks).toBe(15)
    expect(dk.shielded).toBe(true)
    expect(dk.connected).toBe(true)
    expect(dk.isBot).toBe(false)
    expect(dk.lap.lap).toBe(1)
    expect(dk.lap.checkpointIdx).toBe(2)
    expect(Math.abs(dk.lap.t - 0.6)).toBeLessThan(STEP_T)
  })

  it('copies every WireEntity field except targetId, which the wire does not carry', () => {
    const source = makeState()
    source.entityCount = 1
    source.entities[0] = {
      entityId: 5, kind: 'charge', ownerId: 2,
      position: { x: 3, y: 0, z: 4 }, velocity: { x: 0, y: 0, z: 1 },
      heading: 1, targetId: 6, ttl: 200,
    }
    const buf = new Uint8Array(BUF_SIZE)
    const bytes = encodeSnapshot(buf, source, new Array(MAX_KARTS).fill(0))
    const snap = makeEmptySnapshot()
    decodeSnapshot(buf.subarray(0, bytes), snap)

    const dst = makeState()
    dst.entities[0].targetId = 999 // marker: not on the wire, must survive untouched

    applySnapshotToState(snap, dst)

    expect(dst.entityCount).toBe(1)
    expect(dst.entities[0].entityId).toBe(5)
    expect(dst.entities[0].kind).toBe('charge')
    expect(dst.entities[0].ownerId).toBe(2)
    expect(Math.abs(dst.entities[0].position.z - 4)).toBeLessThan(STEP_POS)
    expect(dst.entities[0].ttl).toBe(200)
    expect(dst.entities[0].targetId).toBe(999)
  })

  it('resets a re-sentinelled entity slot\'s targetId to -1, matching entity.ts\'s clearSlot convention', () => {
    // A dead slot on the wire (entityId === -1) carries no targetId at all -
    // WireEntity has no such field - but the DESTINATION slot may still hold
    // one left over from an earlier decode, when it was a live seeker homing
    // on some kart. Left alone, a shadow that reconciles right after that
    // seeker despawns (Task 16's ShadowLoop.reconcile calls this function
    // directly) would carry a targetId referencing a kart no entity in the
    // decoded state is actually homing on - residue entity.ts's own
    // clearSlot() would never produce for a real dead slot.
    const source = makeState()
    source.entityCount = 0 // nothing live on the wire
    const buf = new Uint8Array(BUF_SIZE)
    const bytes = encodeSnapshot(buf, source, new Array(MAX_KARTS).fill(0))
    const snap = makeEmptySnapshot()
    decodeSnapshot(buf.subarray(0, bytes), snap)
    expect(snap.entities[0].entityId).toBe(-1)

    const dst = makeState()
    // Marker: simulates the slot's leftover state from an earlier decode that
    // held a live seeker targeting kart 5. Not -1, so a fix-free run leaves it
    // exactly here rather than by coincidence landing on the right answer.
    dst.entities[0].targetId = 5

    applySnapshotToState(snap, dst)

    expect(dst.entities[0].entityId).toBe(-1)
    expect(dst.entities[0].targetId).toBe(-1)
  })

  it('writes tick and entityCount, since both are carried on the wire', () => {
    const source = makeState()
    source.tick = 777
    // Nonzero and different from dst's starting value below, so this proves a
    // real copy rather than two defaults happening to agree at 0.
    source.entityCount = 4
    const buf = new Uint8Array(BUF_SIZE)
    const bytes = encodeSnapshot(buf, source, new Array(MAX_KARTS).fill(0))
    const snap = makeEmptySnapshot()
    decodeSnapshot(buf.subarray(0, bytes), snap)

    const dst = makeState()
    dst.tick = 1
    dst.entityCount = 1
    applySnapshotToState(snap, dst)
    expect(dst.tick).toBe(777)
    expect(dst.entityCount).toBe(4)
  })

  it('does not touch any field the wire does not carry, while still writing the fields it does', () => {
    const source = makeState()
    // A positive companion to the negative checks below: proves this function
    // does something, not just that it leaves the exclusion list alone (a
    // complete no-op would otherwise pass every assertion in this test).
    source.tick = 999
    const buf = new Uint8Array(BUF_SIZE)
    const bytes = encodeSnapshot(buf, source, new Array(MAX_KARTS).fill(0))
    const snap = makeEmptySnapshot()
    decodeSnapshot(buf.subarray(0, bytes), snap)

    const dst = makeState()
    dst.rngCursor = 999
    dst.nextEventSeq = 888
    dst.nextEntityId = 777
    dst.itemBoxes = [{ boxIdx: 0, respawnTicks: 42 }]
    dst.finishedOrder = [3, -1, -1, -1, -1, -1, -1, -1]
    dst.phase = 'finished'
    dst.finishTick = 555
    dst.raceSeed = 333
    dst.heldBotIntent = dst.heldBotIntent.map((intent, i) =>
      i === 0 ? { ...intent, tick: 111 } : intent,
    )
    dst.heldBotTick = dst.heldBotTick.map((t, i) => (i === 0 ? 222 : t))
    dst.karts[0].characterIdx = 6

    applySnapshotToState(snap, dst)

    expect(dst.tick).toBe(999)
    expect(dst.rngCursor).toBe(999)
    expect(dst.nextEventSeq).toBe(888)
    expect(dst.nextEntityId).toBe(777)
    expect(dst.itemBoxes).toEqual([{ boxIdx: 0, respawnTicks: 42 }])
    expect(dst.finishedOrder).toEqual([3, -1, -1, -1, -1, -1, -1, -1])
    expect(dst.phase).toBe('finished')
    expect(dst.finishTick).toBe(555)
    expect(dst.raceSeed).toBe(333)
    expect(dst.heldBotIntent[0].tick).toBe(111)
    expect(dst.heldBotTick[0]).toBe(222)
    expect(dst.karts[0].characterIdx).toBe(6)
  })
})
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `npx vitest run packages/protocol/test/snapshot.test.ts -t "applySnapshotToState"`

Expected: FAIL — `TypeError: (0 , applySnapshotToState) is not a function`.
(`encodeSnapshot`/`decodeSnapshot` already exist and work from Step 3; the imported
`applySnapshotToState` binding is `undefined` because `src/snapshot.ts` does not
export it yet, and calling it throws this at the call site.)

- [ ] **Step 7: Write `applySnapshotToState`**

Append to the end of `packages/protocol/src/snapshot.ts`:

```ts
/**
 * Writes the fields a WireSnapshot carries into `dst`, and nothing else. Does
 * NOT touch: rngCursor, nextEventSeq, nextEntityId, itemBoxes, finishedOrder,
 * phase, finishTick, heldBotIntent, heldBotTick (none of these have wire data -
 * contract §0's "a follower's nextEventSeq is advanced only by applying received
 * events" is exactly why nextEventSeq is on this list despite snap.eventSeq
 * existing; that field is for the caller to read directly off the decoded
 * WireSnapshot, not to be replayed into SimState here), nor raceSeed
 * (WireSnapshot has no such field) nor karts[i].characterIdx (deliberately absent
 * from the wire, contract §1c/§5). DOES write dst.tick and dst.entityCount - both
 * are carried on the wire and neither is on the exclusion list. Writes k.isBot
 * and k.connected as two independent fields (decision 3) - a snapshot that
 * genuinely carries them disagreeing (bot-takeover racing a reconnect)
 * reconciles correctly.
 *
 * entities[i].targetId is a partial exception, not a blanket one: WireEntity
 * has no such field, so a LIVE slot's targetId is left exactly as this
 * function found it (still correct - there is no wire data to prefer either
 * way). A DEAD slot (wire entityId === -1) is different: entity.ts's
 * clearSlot() always pairs entityId === -1 with targetId === -1, and this
 * function is the only place with both the dead-slot signal (from the wire)
 * and a targetId field to clear (WireEntity has none) - decodeSnapshot's own
 * re-sentinelling cannot reach it. Leaving it alone here means a slot that
 * held a live seeker on an earlier decode keeps that seeker's old targetId
 * after the seeker despawns and the slot goes dead - residue with no wire
 * representation, consumed downstream by ShadowLoop.reconcile (Task 16).
 */
export function applySnapshotToState(snap: WireSnapshot, dst: SimState): void {
  dst.tick = snap.tick
  dst.entityCount = snap.entityCount

  for (let i = 0; i < MAX_KARTS; i++) {
    const s = snap.karts[i]
    const k = dst.karts[i]
    k.playerId = s.playerId
    k.isBot = s.isBot
    k.connected = s.connected
    k.position.x = s.position.x
    k.position.y = s.position.y
    k.position.z = s.position.z
    k.velocity.x = s.velocity.x
    k.velocity.y = s.velocity.y
    k.velocity.z = s.velocity.z
    k.heading = s.heading
    k.angularVelocity = s.angularVelocity
    k.drift.active = s.driftActive
    k.drift.dir = s.driftDir
    k.drift.charge = s.driftCharge
    k.item = s.item
    k.airborne = s.airborne
    k.surface = s.surface
    k.spinOutTicks = s.spinOutTicks
    k.invulnTicks = s.invulnTicks
    k.boostTicks = s.boostTicks
    k.respawnTicks = s.respawnTicks
    k.shielded = s.shielded
    k.lap.lap = s.lap
    k.lap.checkpointIdx = s.checkpointIdx
    k.lap.t = s.t
    // k.characterIdx: deliberately untouched, see this function's docstring
  }

  for (let i = 0; i < MAX_ENTITIES; i++) {
    const s = snap.entities[i]
    const e = dst.entities[i]
    e.entityId = s.entityId
    e.kind = s.kind
    e.ownerId = s.ownerId
    e.position.x = s.position.x
    e.position.y = s.position.y
    e.position.z = s.position.z
    e.velocity.x = s.velocity.x
    e.velocity.y = s.velocity.y
    e.velocity.z = s.velocity.z
    e.heading = s.heading
    e.ttl = s.ttl
    // e.targetId: WireEntity carries no such field, so a LIVE slot's targetId
    // is left exactly as this function found it (see docstring). A DEAD slot
    // (entityId === -1) is different: entity.ts's clearSlot() always pairs
    // entityId === -1 with targetId === -1, and a slot that held a live
    // seeker on a previous decode must not keep claiming to target a kart
    // once the wire says the slot is empty - re-sentinel it here, the same
    // convention decodeSnapshot already applies to entityId/position/etc for
    // dead slots (that function just has no targetId field to do it with).
    if (s.entityId === -1) e.targetId = -1
  }
}
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `npx vitest run packages/protocol/test/snapshot.test.ts`

Expected: PASS — 14 passed (9 from `encodeSnapshot`/`decodeSnapshot`, 5 from
`applySnapshotToState`).

---

- [ ] **Step 9: Typecheck and run the whole protocol suite**

Run: `npx tsc --noEmit -p packages/protocol && npx vitest run packages/protocol`

Expected: PASS — no TypeScript errors; `snapshot.test.ts` 14 passed, plus Tasks 3,
4 and 5's tests (`types.test.ts` 13, `bits.test.ts` 14, `quant.test.ts` 13).

---

- [ ] **Step 10: Write the failing test — `encodeSnapshot`, `decodeSnapshot`, `applySnapshotToState` reachable through the barrel**

Contract §3: "The barrel exists from Task 3, not Task 18" — by the time this task
runs, `packages/protocol/src/index.ts` re-exports `./types`, `./bits` and `./quant`
(Tasks 3-5). This task's module is `snapshot.ts`; appending its own line is this
task's last implementation step, exactly as Plan 1's Tasks 3-10 each did for
`@tapkart/sim/src/index.ts`, so `packages/net` can `import ... from
'@tapkart/protocol'` from Task 11 onward without waiting for Task 18.

Append to `packages/protocol/test/snapshot.test.ts`, after the closing `})` of
`describe('applySnapshotToState', ...)`:

```ts
describe('@tapkart/protocol barrel', () => {
  it('re-exports encodeSnapshot, decodeSnapshot and applySnapshotToState', async () => {
    const pkg = await import('@tapkart/protocol')
    expect(typeof pkg.encodeSnapshot).toBe('function')
    expect(typeof pkg.decodeSnapshot).toBe('function')
    expect(typeof pkg.applySnapshotToState).toBe('function')
  })
})
```

This is a dynamic import, matching Task 3's own barrel test in `types.test.ts` and
`packages/sim/test/barrel.test.ts`'s `'resolves through the @tapkart/sim package entry
point'` test, so a resolution failure fails this one test rather than the whole file.

- [ ] **Step 11: Run the test to verify it fails**

Run: `npx vitest run packages/protocol/test/snapshot.test.ts -t "re-exports encodeSnapshot, decodeSnapshot and applySnapshotToState"`

Expected: FAIL — `packages/protocol/src/index.ts` does not yet re-export
`./snapshot`, so the dynamically-imported package object has no `encodeSnapshot`
property: `AssertionError: expected 'undefined' to be 'function'` at
`expect(typeof pkg.encodeSnapshot).toBe('function')`.

(This step's own count is unaffected by this brief's two added tests — Step 11
targets a single test by name, not the whole file.)

- [ ] **Step 12: Widen the barrel**

In `packages/protocol/src/index.ts`. Before:

```ts
export * from './types'
export * from './bits'
export * from './quant'
```

After:

```ts
export * from './types'
export * from './bits'
export * from './quant'
export * from './snapshot'
```

- [ ] **Step 13: Run the test to verify it passes, then the whole file and package**

Run: `npx vitest run packages/protocol/test/snapshot.test.ts`
Expected: PASS — 15 passed (14 from Steps 4/8, plus the barrel test).

Run: `npx tsc --noEmit -p packages/protocol && npx vitest run packages/protocol`
Expected: PASS — no TypeScript errors; every test across the package still passes,
including Tasks 3, 4 and 5's own barrel tests, which this task's edit to
`index.ts` does not touch.

- [ ] **Step 14: Commit**

```bash
git add packages/protocol/src/snapshot.ts packages/protocol/src/index.ts \
        packages/protocol/test/snapshot.test.ts
git commit -m "feat(protocol): snapshot codec - encode/decode/apply against contract §4

Per-kart wire record is 178 bits, not 177: isBot and connected are two
independent bits, matching contract §4's explicit ruling that they must never
be merged (an earlier draft of this codec derived isBot as !connected on
decode, which cannot represent the spec §5 bot-takeover/reconnect transition
where the two legitimately disagree for a tick). The fourteen exact/enum
per-kart fields have no Q/EPS entry (Task 5) and are sourced here as local
bit-width constants instead, the same pattern already used for the entity and
header fields.

Also raises the worst-case buffer size from 512B to 1024B (743B is the actual
worst case at 178 bits/kart -- BitWriter truncates silently past a buffer's
end) and adds a MAX_ENTITIES round-trip test that would have caught it, plus
a kart with isBot/connected deliberately disagreeing so the fix is actually
exercised rather than coinciding with a test fixture's defaults.

Two more fixes from this brief's residual-findings pass: lastProcessedInputTick
is now +1-biased on the wire (matching events.ts's own scheme for
playerId/entityId), so the -1 "no real input yet" sentinel round-trips as -1
instead of silently becoming tick 65535; and applySnapshotToState now resets a
re-sentinelled entity slot's targetId to -1, matching entity.ts's clearSlot
convention, instead of leaving a despawned seeker's stale target reference
behind for ShadowLoop.reconcile to inherit.

Widens packages/protocol/src/index.ts to re-export snapshot.ts, so
packages/net can reach these three functions through @tapkart/protocol from
Task 11 onward instead of waiting for Task 18's barrel widening."
```
