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

**Two decisions this task makes that diverge from contract §4's own prose, both
because a locked TypeScript signature outranks a rounded arithmetic aside — flag
these upstream when this task lands, they are genuine contract inconsistencies, not
liberties taken lightly:**

1. **No per-record byte alignment.** Contract §4 labels the per-kart record "177
   bits ≈ 23 B" and the entity record "13 B" (disputed below) and the header
   "25 B". Summing the header's own fields exactly — `tick`(32) + `eventSeq`(32) +
   `lastProcessedInputTick`(8×16=128) + `entityCount`(8) = 200 bits — gives exactly
   25 B with no rounding at all, and 8 karts × 177 bits = 1416 bits is *also*
   exactly 177 B with no rounding. The "≈" is doing real work only on the per-kart
   figure in isolation (177 bits alone is 22.125 B); once multiplied by 8 it stops
   needing rounding. This is strong evidence the byte figures in contract §4 are
   human-readable approximations of a continuously bit-packed stream, not a literal
   per-record byte-alignment requirement — and `BitWriter`/`BitReader` (Task 4) have
   no `align()`/`pad()` method, which is what a real per-record alignment rule would
   need. This task packs the header, then all 8 kart records, then all
   `entityCount` entity records, fully continuously; the only padding anywhere is
   the implicit zero-padding of the buffer's final partial byte, which
   `BitWriter.byteLength()` already accounts for and which `decodeSnapshot` never
   reads (it stops after the same fields the matching encode wrote).
2. **Entity `velocity` is a full quantised `Vec3` (3×12 bits, `Q.velocity`), not a
   packed single `u16`.** Contract §4's own itemized entity-record sentence reads
   `entityId u16, kind u4, ownerId u3, position 3×u16 ..., velocity packed 3×u12,
   heading u12, ttl u16`, which sums to 135 bits (16.875 B) — not the "13 B" the
   same sentence ends with. Spec §5's *older*, pre-Task-3 wording describes a
   single combined `packed velocity/heading u16` field instead (103 bits, which
   does land on 13 B), but that wording predates `WireEntity`'s locked shape:
   contract §3 types `WireEntity.velocity` as a full `Vec3` — three independent
   components — which a single combined 16-bit scalar cannot losslessly populate
   without inventing an unspecified magnitude+direction split found nowhere in
   either document. Rather than fabricate that scheme, this task honors the locked
   `Vec3` type and contract §4's own itemized bit list, both of which are more
   specific than the round "13 B" label. The entity record is therefore **135
   bits**, not 13 B; this makes the "typical ~287 B / worst-case ~625 B" bandwidth
   figures in spec §5 stale too (they were computed assuming the 13 B entity). None
   of this affects correctness inside `packages/protocol` — encode and decode agree
   with each other because both live in this one file — but whoever next touches
   contract §4 or spec §5's bandwidth table should reconcile the entity record size
   with `WireEntity.velocity: Vec3`, or explicitly narrow the type instead. Step 12
   below pins the corrected entity bit count (135) in a test so a future "fix" that
   quietly reintroduces the 13 B scheme is caught immediately.

**Two more decisions, ordinary ones this file has to make that are not disputes with
the contract:**

3. **`isBot`/`connected` share one wire bit, named `connected`.** Contract §4's row
   `` `airborne`, `shielded`, `isBot`/`connected` | 1 each `` sums the whole table to
   177 only if that row is *three* 1-bit fields, not four (Task 5's brief derives
   this the same way). `KartState.isBot` and `KartState.connected` are therefore
   assumed complementary — `isBot === !connected` — which is true of every state
   `packages/sim` produces today: `createState` sets `isBot: true, connected: false`
   for every seat, and a repo-wide grep for writes to either field
   (`grep -rn "isBot\s*=\|connected\s*="  packages/sim/src/*.ts`) turns up only
   `createState` and `cloneState`'s field-by-field copy — no other shipped code
   writes either field, so the invariant cannot currently be broken from inside
   `sim`. It is a `net`-package responsibility going forward (a client claiming or
   dropping a seat) to preserve it; this codec cannot verify code that does not
   exist yet, so it is stated here as the assumption it is, not proven. `connected`
   is the bit written (the network-observable ground truth); `isBot` is derived on
   decode/apply as its logical negation.
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
  round-trip tolerances).
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
  that file directly), `packDrift`, `unpackDriftActive`, `unpackDriftDir`, and the
  four entity/header bit-width constants named in Step 3.

**Wire order, stated once here because nothing else in the codebase enforces it and
encode/decode must agree byte-for-byte:** header, then all `MAX_KARTS` kart records
in slot order `0..7` (each kart's 23 fields in exactly contract §4's row order,
listed field-by-field in Step 3), then `state.entityCount` entity records in their
already-packed order. Header field order is `tick`, `eventSeq`,
`lastProcessedInputTick[0..7]`, `entityCount` — `entityCount` is read *before* the
entities so a streaming decoder knows how many to expect; `WireSnapshot`'s own
TypeScript field order (which lists `entities` before `entityCount`, purely for
interface readability) is not the wire order.

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

const BUF_SIZE = 512

const STEP_POS = quantStep(Q.position.min, Q.position.max, Q.position.bits)
const STEP_VEL = quantStep(Q.velocity.min, Q.velocity.max, Q.velocity.bits)
const STEP_HEADING = quantStep(Q.heading.min, Q.heading.max, Q.heading.bits)
const STEP_ANGVEL = quantStep(Q.angularVelocity.min, Q.angularVelocity.max, Q.angularVelocity.bits)
const STEP_DRIFT_CHARGE = quantStep(Q.driftCharge.min, Q.driftCharge.max, Q.driftCharge.bits)
const STEP_LAP_T = quantStep(Q.lapT.min, Q.lapT.max, Q.lapT.bits)

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

    const k1 = state.karts[1]
    k1.drift = { active: true, dir: 1, charge: 200 }
    k1.item = 'charge'
    k1.surface = 'boost'
    k1.connected = false
    k1.isBot = true

    const buf = new Uint8Array(BUF_SIZE)
    const lastProcessedInputTick = [100, 101, 0, 0, 0, 0, 0, 0]
    const bytes = encodeSnapshot(buf, state, lastProcessedInputTick)

    const snap = makeEmptySnapshot()
    decodeSnapshot(buf.subarray(0, bytes), snap)

    expect(snap.tick).toBe(12345)
    expect(snap.eventSeq).toBe(42)
    expect(snap.entityCount).toBe(0)
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
    expect(Math.abs(d0.t - 0.37)).toBeLessThan(STEP_LAP_T)
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
    expect(d1.connected).toBe(false)
    expect(d1.isBot).toBe(true)
  })

  it('round-trips every continuous kart field at both range endpoints exactly', () => {
    const state = makeState()
    const k = state.karts[0]
    k.position = { x: -1024, y: 1024, z: -1024 }
    k.velocity = { x: -64, y: 64, z: -64 }
    k.heading = -Math.PI
    k.angularVelocity = 16
    k.drift.charge = 255
    k.lap.t = 0

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
    expect(d.t).toBe(0)
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
    // 200 header bits + 8*177 kart bits + 3*135 entity bits, continuously packed,
    // rounded up once at the very end (this task's decision 1 and 2)
    const totalBits = 200 + MAX_KARTS * 177 + 3 * 135
    expect(bytes).toBe(Math.ceil(totalBits / 8))
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
    for (let i = 0; i < MAX_KARTS; i++) rw.writeBits(lastProcessedInputTick[i], 16)
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
      rw.writeFloatQ(kk.lap.t, Q.lapT.min, Q.lapT.max, Q.lapT.bits)
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
'/home/kasm-user/tapkart/packages/protocol/test/snapshot.test.ts'`. Zero tests
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

// Entity and header fields are plain fixed-width integers with no epsilon concept
// (Task 5's brief, decision-setting paragraph): sourced here as literals straight
// from contract §4's prose, not through Q, which covers only the per-kart table.
const ENTITY_ID_BITS = 16
const ENTITY_KIND_BITS = 4
const ENTITY_OWNER_BITS = 3
const ENTITY_TTL_BITS = 16
const HEADER_TICK_BITS = 32
const HEADER_EVENT_SEQ_BITS = 32
const HEADER_LAST_INPUT_TICK_BITS = 16
const HEADER_ENTITY_COUNT_BITS = 8

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
    bw.writeBits(lastProcessedInputTick[i], HEADER_LAST_INPUT_TICK_BITS)
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
    bw.writeFloatQ(k.lap.t, Q.lapT.min, Q.lapT.max, Q.lapT.bits)
    bw.writeBits(k.spinOutTicks, Q.spinOutTicks.bits)
    bw.writeBits(k.invulnTicks, Q.invulnTicks.bits)
    bw.writeBits(k.boostTicks, Q.boostTicks.bits)
    bw.writeBits(k.respawnTicks, Q.respawnTicks.bits)
    bw.writeBits(k.lap.lap, Q.lap.bits)
    bw.writeBits(k.lap.checkpointIdx, Q.checkpointIdx.bits)
    bw.writeBits(ITEM_KINDS.indexOf(k.item), Q.item.bits)
    bw.writeBits(SURFACES.indexOf(k.surface), Q.surface.bits)
    bw.writeBits(packDrift(k.drift.active, k.drift.dir), Q.driftPacked.bits)
    bw.writeBits(k.airborne ? 1 : 0, Q.airborne.bits)
    bw.writeBits(k.shielded ? 1 : 0, Q.shielded.bits)
    bw.writeBits(k.connected ? 1 : 0, Q.connected.bits)
    bw.writeBits(k.playerId, Q.playerId.bits)
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
    out.lastProcessedInputTick[i] = br.readBits(HEADER_LAST_INPUT_TICK_BITS)
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
    k.t = br.readFloatQ(Q.lapT.min, Q.lapT.max, Q.lapT.bits)
    k.spinOutTicks = br.readBits(Q.spinOutTicks.bits)
    k.invulnTicks = br.readBits(Q.invulnTicks.bits)
    k.boostTicks = br.readBits(Q.boostTicks.bits)
    k.respawnTicks = br.readBits(Q.respawnTicks.bits)
    k.lap = br.readBits(Q.lap.bits)
    k.checkpointIdx = br.readBits(Q.checkpointIdx.bits)
    k.item = ITEM_KINDS[br.readBits(Q.item.bits)]
    k.surface = SURFACES[br.readBits(Q.surface.bits)]
    const driftRaw = br.readBits(Q.driftPacked.bits)
    k.driftActive = unpackDriftActive(driftRaw)
    k.driftDir = unpackDriftDir(driftRaw)
    k.airborne = br.readBits(Q.airborne.bits) !== 0
    k.shielded = br.readBits(Q.shielded.bits) !== 0
    const connected = br.readBits(Q.connected.bits) !== 0
    k.connected = connected
    k.isBot = !connected
    k.playerId = br.readBits(Q.playerId.bits)
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

Expected: PASS — 7 passed.

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
    k.respawnTicks = 0
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
    expect(dk.respawnTicks).toBe(0)
    expect(dk.shielded).toBe(true)
    expect(dk.connected).toBe(true)
    expect(dk.isBot).toBe(false)
    expect(dk.lap.lap).toBe(1)
    expect(dk.lap.checkpointIdx).toBe(2)
    expect(Math.abs(dk.lap.t - 0.6)).toBeLessThan(STEP_LAP_T)
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

  it('writes tick and entityCount, since both are carried on the wire', () => {
    const source = makeState()
    source.tick = 777
    source.entityCount = 0
    const buf = new Uint8Array(BUF_SIZE)
    const bytes = encodeSnapshot(buf, source, new Array(MAX_KARTS).fill(0))
    const snap = makeEmptySnapshot()
    decodeSnapshot(buf.subarray(0, bytes), snap)

    const dst = makeState()
    dst.tick = 1
    applySnapshotToState(snap, dst)
    expect(dst.tick).toBe(777)
    expect(dst.entityCount).toBe(0)
  })

  it('does not touch any field the wire does not carry', () => {
    const source = makeState()
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
 * from the wire, contract §1c/§5) nor entities[i].targetId (WireEntity has no such
 * field). DOES write dst.tick and dst.entityCount - both are carried on the wire
 * and neither is on the exclusion list.
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
    // e.targetId: deliberately untouched, see this function's docstring
  }
}
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `npx vitest run packages/protocol/test/snapshot.test.ts`

Expected: PASS — 11 passed (7 from `encodeSnapshot`/`decodeSnapshot`, 4 from
`applySnapshotToState`).

---

- [ ] **Step 9: Typecheck and run the whole protocol suite**

Run: `npx tsc --noEmit -p packages/protocol && npx vitest run packages/protocol`

Expected: PASS — no TypeScript errors; `snapshot.test.ts` 11 passed, plus Tasks 3,
4 and 5's tests (`bits.test.ts` 13, `quant.test.ts` 13, plus whatever Task 3
shipped for `types.ts`).

- [ ] **Step 10: Commit**

```bash
git add packages/protocol/src/snapshot.ts packages/protocol/test/snapshot.test.ts
git commit -m "feat(protocol): snapshot codec - encode/decode/apply against contract §4"
```
