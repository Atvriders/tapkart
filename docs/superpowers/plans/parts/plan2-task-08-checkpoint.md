### Task 8: `packages/protocol/src/checkpoint.ts`

**Files:**
- Create: `packages/protocol/src/checkpoint.ts`
- Create: `packages/protocol/test/checkpoint.test.ts`

**A verified, not assumed, premise about `SimState`'s shape:** this task
depends on contract §1a — `SimState` gains `heldBotIntent: Intent[]` and
`heldBotTick: number[]`, appended after `finishedOrder`, and `cloneState`
deep-copies both. **This was checked directly against the checkout this brief
was written against, not taken on faith:** `grep -rn "heldBotIntent"
packages/sim/src/` returns **zero matches**, in both `types.ts` and
`state.ts`. Task 1 (the amendment that adds these fields) has **not landed in
this checkout**. This brief is written for the shape `SimState` has *after*
Task 1 lands, per the contract's task ordering (§1 states Tasks 1 and 2 run
"before `protocol` or `net` exist"). Before starting Task 8, confirm Task 1
has actually landed — `heldBotIntent`/`heldBotTick` exist on `SimState`,
`createState` initializes them, and `cloneState`/`statesEqual` handle them —
by re-running the same grep. If it still returns nothing, Task 8 is blocked
on Task 1, not on Tasks 3–6.

---

**Interfaces:**

- Consumes, contract §3, verbatim:
  ```ts
  export function encodeCheckpoint(out: Uint8Array, state: SimState): number
  export function decodeCheckpoint(buf: Uint8Array, dst: SimState): void
  ```

- Consumes from `@tapkart/sim` (verified directly against
  `packages/sim/src/types.ts` in this checkout):
  ```ts
  export const MAX_KARTS = 8
  export const MAX_ENTITIES = 32
  export type RacePhase = 'countdown' | 'racing' | 'finished'
  export type Surface = 'tarmac' | 'dirt' | 'boost' | 'offtrack'
  export type ItemKind = 'none' | 'boost' | 'seeker' | 'bolt' | 'slick' | 'bubble' | 'surge' | 'blink' | 'charge'
  export type EntityKind = 'seeker' | 'bolt' | 'slick' | 'bubble' | 'surge' | 'charge'
  export interface Intent { tick: number; steer: number; accel: number; brake: boolean; drift: boolean; useItem: boolean }
  export interface KartState {
    playerId: number; characterIdx: number; isBot: boolean; connected: boolean
    position: Vec3; velocity: Vec3; heading: number; angularVelocity: number
    drift: { active: boolean; dir: -1 | 0 | 1; charge: number }
    item: ItemKind; airborne: boolean; surface: Surface
    spinOutTicks: number; invulnTicks: number; boostTicks: number; respawnTicks: number
    shielded: boolean; lap: { lap: number; checkpointIdx: number; t: number }
  }
  export interface EntityState {
    entityId: number; kind: EntityKind; ownerId: number
    position: Vec3; velocity: Vec3; heading: number; targetId: number; ttl: number
  }
  export interface ItemBoxState { boxIdx: number; respawnTicks: number }
  export interface SimState {
    tick: number; phase: RacePhase; raceSeed: number; rngCursor: number
    nextEventSeq: number; finishTick: number
    karts: KartState[]; entities: EntityState[]; entityCount: number; nextEntityId: number
    itemBoxes: ItemBoxState[]; finishedOrder: number[]
    heldBotIntent: Intent[]; heldBotTick: number[]   // [Task 1] — see the premise note above
  }
  export function statesEqual(a: SimState, b: SimState): boolean   // Object.is on every scalar
  ```

- Produces:
  ```ts
  export function encodeCheckpoint(out: Uint8Array, state: SimState): number
  export function decodeCheckpoint(buf: Uint8Array, dst: SimState): void
  ```
  Internal (not exported): `PHASE_ORDER`, `SURFACE_ORDER`, `ITEM_ORDER`,
  `ENTITY_KIND_ORDER` — fixed-order lookup tables for the four string-enum
  types, and a private `idx()` helper.

---

**Two design decisions this task makes on its own authority,** because
`AuthorityCheckpoint`'s wire layout is not specified anywhere in the locked
contract (§4 covers only `WireSnapshot`) — contract §0's own rule applies: "A
task needing something absent must define it in its own files and say so in
its `Interfaces` block."

1. **Every field, without exception, is written as a raw IEEE-754 float64**
   via `DataView.setFloat64`/`getFloat64` at 8 bytes each, little-endian
   (contract §0: "Byte order on the wire: little-endian, everywhere, no
   exceptions"). This includes fields that are conceptually booleans (written
   as `0.0`/`1.0`) and string enums (written as an index into a fixed-order
   table). Unlike `WireSnapshot`, byte budget is explicitly not a constraint
   here — spec §5: *"Not sent periodically in the steady state"* — so this
   task optimizes for the one property that matters, bit-identity, and for
   implementation simplicity: encode/decode become one repeated `(write
   field, read field)` shape applied in `SimState`'s declared field order,
   with **no bit-packing, no quantization, and — because a raw float64 copy
   preserves the IEEE-754 sign bit exactly — no special-casing needed
   anywhere for `-0`.** A quantized or bit-packed scheme would need explicit
   `-0` handling; this one gets it for free.

2. **This task does not use `SimContext`, `Track`, or any track fixture.**
   `encodeCheckpoint`/`decodeCheckpoint` take only a `SimState`, so the test
   below builds `SimState` fixtures by hand rather than via `createState` +
   a track. This is deliberate, not laziness: `@tapkart/sim`'s test fixtures
   (`makeContext`, `makeOvalTrack`) live under `packages/sim/test/fixtures/`,
   outside `packages/sim/package.json`'s `exports` map (`"." :
   "./src/index.ts"` only) — verified by reading that file — so they are not
   importable from another workspace package at all. Reaching for them here
   would not compile.

---

- [ ] **Step 1: Write the failing test — full-state round trip, bit-identical**

Create `packages/protocol/test/checkpoint.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type {
  EntityKind,
  EntityState,
  Intent,
  ItemKind,
  KartState,
  SimState,
  Surface,
} from '@tapkart/sim'
import { MAX_ENTITIES, MAX_KARTS, statesEqual } from '@tapkart/sim'
import { decodeCheckpoint, encodeCheckpoint } from '../src/checkpoint'

/** Test-local enum-value pools, independent of checkpoint.ts's internal wire
 * order — this test must pass regardless of how the codec orders its lookup
 * tables internally, as long as encode/decode agree with themselves. */
const ITEM_POOL: ItemKind[] = ['none', 'boost', 'seeker', 'bolt', 'slick', 'bubble', 'surge', 'blink', 'charge']
const SURFACE_POOL: Surface[] = ['tarmac', 'dirt', 'boost', 'offtrack']
const ENTITY_KIND_POOL: EntityKind[] = ['seeker', 'bolt', 'slick', 'bubble', 'surge', 'charge']

function makeKart(i: number): KartState {
  return {
    playerId: i,
    characterIdx: (i * 3) % 8,
    isBot: i % 2 === 0,
    connected: i % 3 !== 0,
    position: { x: i * 12.5 - 40, y: 0.5, z: -i * 7.25 },
    velocity: { x: i === 0 ? -0 : i * 1.5, y: 0, z: 3.25 - i },
    heading: (i - 4) * 0.4,
    angularVelocity: i % 2 === 0 ? -0.75 : 0.75,
    drift: { active: i % 2 === 1, dir: ((i % 3) - 1) as -1 | 0 | 1, charge: i * 9 },
    item: ITEM_POOL[i % ITEM_POOL.length]!,
    airborne: i === 5,
    surface: SURFACE_POOL[i % SURFACE_POOL.length]!,
    spinOutTicks: i * 4,
    invulnTicks: i * 5,
    boostTicks: i * 3,
    respawnTicks: i * 2,
    shielded: i === 7,
    lap: { lap: i % 4, checkpointIdx: i, t: i / 10 },
  }
}

function makeEntity(i: number): EntityState {
  const alive = i < 5
  return {
    entityId: alive ? 100 + i : -1,
    kind: ENTITY_KIND_POOL[i % ENTITY_KIND_POOL.length]!,
    ownerId: alive ? i % MAX_KARTS : -1,
    position: { x: i * 3.1, y: alive ? 1.2 : 0, z: -i * 2.2 },
    velocity: { x: 0.5 * i, y: 0, z: -0.25 * i },
    heading: (i % 7) * 0.3 - 1,
    targetId: alive ? (i + 1) % MAX_KARTS : -1,
    ttl: alive ? 600 - i * 10 : 0,   // 600 = Tuning.entityTtl's max, contract \$1c
  }
}

function makeHeldIntent(i: number): Intent {
  return { tick: 100 + i, steer: (i - 4) / 8, accel: i % 2, brake: i === 3, drift: i === 5, useItem: i === 6 }
}

const richState: SimState = {
  tick: 4211,
  phase: 'racing',
  raceSeed: 0x1234abcd,
  rngCursor: 987654,
  nextEventSeq: 321,
  finishTick: -1,
  entityCount: 5,
  nextEntityId: 137,
  karts: Array.from({ length: MAX_KARTS }, (_, i) => makeKart(i)),
  entities: Array.from({ length: MAX_ENTITIES }, (_, i) => makeEntity(i)),
  itemBoxes: [
    { boxIdx: 0, respawnTicks: 0 },
    { boxIdx: 1, respawnTicks: 45 },
    { boxIdx: 2, respawnTicks: 0 },
    { boxIdx: 3, respawnTicks: 180 },
  ],
  finishedOrder: [3, -1, -1, -1, -1, -1, -1, -1],
  heldBotIntent: Array.from({ length: MAX_KARTS }, (_, i) => makeHeldIntent(i)),
  heldBotTick: [-1, 12, -1, 45, -1, 7, -1, 3],
}

/** Same shape as `src` (same array lengths throughout), every value
 * different, so the round-trip test is meaningful rather than vacuous. */
function makeBlankLike(src: SimState): SimState {
  return {
    tick: 0,
    phase: 'countdown',
    raceSeed: 0,
    rngCursor: 0,
    nextEventSeq: 0,
    finishTick: 0,
    entityCount: 0,
    nextEntityId: 0,
    karts: src.karts.map(() => ({
      playerId: 0,
      characterIdx: 0,
      isBot: false,
      connected: false,
      position: { x: 0, y: 0, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
      heading: 0,
      angularVelocity: 0,
      drift: { active: false, dir: 0 as const, charge: 0 },
      item: 'none' as const,
      airborne: false,
      surface: 'tarmac' as const,
      spinOutTicks: 0,
      invulnTicks: 0,
      boostTicks: 0,
      respawnTicks: 0,
      shielded: false,
      lap: { lap: 0, checkpointIdx: 0, t: 0 },
    })),
    entities: src.entities.map(() => ({
      entityId: 0,
      kind: 'seeker' as const,
      ownerId: 0,
      position: { x: 0, y: 0, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
      heading: 0,
      targetId: 0,
      ttl: 0,
    })),
    itemBoxes: src.itemBoxes.map(() => ({ boxIdx: 0, respawnTicks: 0 })),
    finishedOrder: src.finishedOrder.map(() => 0),
    heldBotIntent: src.heldBotIntent.map(() => ({
      tick: 0,
      steer: 0,
      accel: 0,
      brake: false,
      drift: false,
      useItem: false,
    })),
    heldBotTick: src.heldBotTick.map(() => 0),
  }
}

describe('checkpoint round trip', () => {
  it('is bit-identical for a fully populated SimState, per statesEqual', () => {
    const buf = new Uint8Array(6000)
    const n = encodeCheckpoint(buf, richState)

    // 8 header fields + 8 karts * 26 fields + 32 entities * 12 fields
    // + (1 count + 4 boxes * 2 fields) + 8 finishedOrder
    // + 8 heldBotIntent * 6 fields + 8 heldBotTick, all at 8 bytes/field:
    // (8 + 8*26 + 32*12 + 1 + 4*2 + 8 + 8*6 + 8) * 8 = 5384
    expect(n).toBe(5384)

    const dst = makeBlankLike(richState)
    expect(statesEqual(dst, richState)).toBe(false) // the placeholder really differs

    decodeCheckpoint(buf.subarray(0, n), dst)

    expect(statesEqual(dst, richState)).toBe(true)

    // statesEqual returns a bare boolean; name the fields too, per this
    // plan's style (Task 16), so a failure says which kart/entity/quantity.
    for (let i = 0; i < MAX_KARTS; i++) {
      const a = dst.karts[i]!
      const b = richState.karts[i]!
      expect(Object.is(a.position.x, b.position.x)).toBe(true)
      expect(Object.is(a.position.y, b.position.y)).toBe(true)
      expect(Object.is(a.position.z, b.position.z)).toBe(true)
      expect(Object.is(a.velocity.x, b.velocity.x)).toBe(true)
      expect(Object.is(a.heading, b.heading)).toBe(true)
      expect(Object.is(a.angularVelocity, b.angularVelocity)).toBe(true)
      expect(Object.is(a.drift.charge, b.drift.charge)).toBe(true)
      expect(a.drift.dir).toBe(b.drift.dir)
      expect(a.item).toBe(b.item)
      expect(a.surface).toBe(b.surface)
      expect(a.boostTicks).toBe(b.boostTicks)
      expect(a.respawnTicks).toBe(b.respawnTicks)
      expect(a.shielded).toBe(b.shielded)
      expect(Object.is(a.lap.t, b.lap.t)).toBe(true)
    }
    for (let i = 0; i < MAX_ENTITIES; i++) {
      expect(Object.is(dst.entities[i]!.entityId, richState.entities[i]!.entityId)).toBe(true)
      expect(dst.entities[i]!.kind).toBe(richState.entities[i]!.kind)
      expect(Object.is(dst.entities[i]!.ttl, richState.entities[i]!.ttl)).toBe(true)
    }

    // The specific defect this task exists to prevent: heldBotIntent and
    // heldBotTick (Plan 2 Task 1) must be carried. Dropping them would
    // resurrect the cross-room bot-hold bug Task 1 exists to fix.
    for (let i = 0; i < MAX_KARTS; i++) {
      expect(dst.heldBotIntent[i]).toEqual(richState.heldBotIntent[i])
      expect(Object.is(dst.heldBotTick[i], richState.heldBotTick[i])).toBe(true)
    }

    // -0 survives a raw float64 round trip, not just === 0.
    expect(Object.is(dst.karts[0]!.velocity.x, -0)).toBe(true)
  })

  it('writes an independent copy: mutating dst does not affect the source state', () => {
    const buf = new Uint8Array(6000)
    const n = encodeCheckpoint(buf, richState)
    const dst = makeBlankLike(richState)
    decodeCheckpoint(buf.subarray(0, n), dst)

    dst.karts[0]!.position.x += 1000
    expect(richState.karts[0]!.position.x).not.toBe(dst.karts[0]!.position.x)
  })

  it('throws if dst.itemBoxes.length disagrees with the encoded count', () => {
    const buf = new Uint8Array(6000)
    const n = encodeCheckpoint(buf, richState) // encoded with 4 item boxes
    const dst = makeBlankLike(richState)
    dst.itemBoxes.pop() // now 3; the buffer says 4

    expect(() => decodeCheckpoint(buf.subarray(0, n), dst)).toThrow(/itemBoxes/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/protocol/test/checkpoint.test.ts`

Expected: FAIL with `Error: Failed to resolve import "../src/checkpoint" from
"packages/protocol/test/checkpoint.test.ts". Does the file exist?` —
`checkpoint.ts` does not exist yet, so this is a module resolution failure at
the ESM loading stage, not a runtime `TypeError` (that distinction matters
only once the file exists but is missing a specific export — not the case
here, since nothing exists yet).

- [ ] **Step 3: Write the implementation**

Create `packages/protocol/src/checkpoint.ts`:

```ts
import type {
  EntityKind,
  EntityState,
  Intent,
  ItemKind,
  KartState,
  RacePhase,
  SimState,
  Surface,
} from '@tapkart/sim'

/**
 * Full-precision serialization of SimState for AuthorityCheckpoint (spec
 * \$5): late join, a client resynced after reconciliation diverges past
 * recovery, and shadow resync after a partition. Not sent periodically.
 *
 * Every field - including booleans and string enums - is written as a raw
 * IEEE-754 float64 (8 bytes, little-endian), in SimState's declared field
 * order. This is deliberately not bit-packed: this message carries no byte
 * budget (spec \$5), and a raw float64 round trip preserves every JS safe
 * integer and the -0/+0 sign bit exactly, with no special-casing.
 */

const PHASE_ORDER: RacePhase[] = ['countdown', 'racing', 'finished']
const SURFACE_ORDER: Surface[] = ['tarmac', 'dirt', 'boost', 'offtrack']
const ITEM_ORDER: ItemKind[] = [
  'none', 'boost', 'seeker', 'bolt', 'slick', 'bubble', 'surge', 'blink', 'charge',
]
const ENTITY_KIND_ORDER: EntityKind[] = ['seeker', 'bolt', 'slick', 'bubble', 'surge', 'charge']

function idx<T>(order: readonly T[], value: T, label: string): number {
  const i = order.indexOf(value)
  if (i < 0) throw new Error(`checkpoint: unknown ${label} ${String(value)}`)
  return i
}

export function encodeCheckpoint(out: Uint8Array, state: SimState): number {
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength)
  let o = 0

  const f = (value: number): void => {
    dv.setFloat64(o, value, true)
    o += 8
  }
  const bit = (value: boolean): void => f(value ? 1 : 0)

  f(state.tick)
  f(idx(PHASE_ORDER, state.phase, 'RacePhase'))
  f(state.raceSeed)
  f(state.rngCursor)
  f(state.nextEventSeq)
  f(state.finishTick)
  f(state.entityCount)
  f(state.nextEntityId)

  for (const k of state.karts) {
    f(k.playerId)
    f(k.characterIdx)
    bit(k.isBot)
    bit(k.connected)
    f(k.position.x); f(k.position.y); f(k.position.z)
    f(k.velocity.x); f(k.velocity.y); f(k.velocity.z)
    f(k.heading)
    f(k.angularVelocity)
    bit(k.drift.active)
    f(k.drift.dir)
    f(k.drift.charge)
    f(idx(ITEM_ORDER, k.item, 'ItemKind'))
    bit(k.airborne)
    f(idx(SURFACE_ORDER, k.surface, 'Surface'))
    f(k.spinOutTicks)
    f(k.invulnTicks)
    f(k.boostTicks)
    f(k.respawnTicks)
    bit(k.shielded)
    f(k.lap.lap)
    f(k.lap.checkpointIdx)
    f(k.lap.t)
  }

  for (const e of state.entities) {
    f(e.entityId)
    f(idx(ENTITY_KIND_ORDER, e.kind, 'EntityKind'))
    f(e.ownerId)
    f(e.position.x); f(e.position.y); f(e.position.z)
    f(e.velocity.x); f(e.velocity.y); f(e.velocity.z)
    f(e.heading)
    f(e.targetId)
    f(e.ttl)
  }

  f(state.itemBoxes.length)
  for (const box of state.itemBoxes) {
    f(box.boxIdx)
    f(box.respawnTicks)
  }

  for (const v of state.finishedOrder) f(v)

  for (const iv of state.heldBotIntent) {
    f(iv.tick)
    f(iv.steer)
    f(iv.accel)
    bit(iv.brake)
    bit(iv.drift)
    bit(iv.useItem)
  }

  for (const v of state.heldBotTick) f(v)

  return o
}

export function decodeCheckpoint(buf: Uint8Array, dst: SimState): void {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  let o = 0

  const f = (): number => {
    const v = dv.getFloat64(o, true)
    o += 8
    return v
  }
  const bit = (): boolean => f() !== 0

  dst.tick = f()
  dst.phase = PHASE_ORDER[f()]!
  dst.raceSeed = f()
  dst.rngCursor = f()
  dst.nextEventSeq = f()
  dst.finishTick = f()
  dst.entityCount = f()
  dst.nextEntityId = f()

  for (const k of dst.karts as KartState[]) {
    k.playerId = f()
    k.characterIdx = f()
    k.isBot = bit()
    k.connected = bit()
    k.position.x = f(); k.position.y = f(); k.position.z = f()
    k.velocity.x = f(); k.velocity.y = f(); k.velocity.z = f()
    k.heading = f()
    k.angularVelocity = f()
    k.drift.active = bit()
    k.drift.dir = f() as -1 | 0 | 1
    k.drift.charge = f()
    k.item = ITEM_ORDER[f()]!
    k.airborne = bit()
    k.surface = SURFACE_ORDER[f()]!
    k.spinOutTicks = f()
    k.invulnTicks = f()
    k.boostTicks = f()
    k.respawnTicks = f()
    k.shielded = bit()
    k.lap.lap = f()
    k.lap.checkpointIdx = f()
    k.lap.t = f()
  }

  for (const e of dst.entities as EntityState[]) {
    e.entityId = f()
    e.kind = ENTITY_KIND_ORDER[f()]!
    e.ownerId = f()
    e.position.x = f(); e.position.y = f(); e.position.z = f()
    e.velocity.x = f(); e.velocity.y = f(); e.velocity.z = f()
    e.heading = f()
    e.targetId = f()
    e.ttl = f()
  }

  const boxCount = f()
  if (boxCount !== dst.itemBoxes.length) {
    throw new Error(
      `decodeCheckpoint: buffer has ${boxCount} itemBoxes but dst was preallocated with ${dst.itemBoxes.length}`,
    )
  }
  for (const box of dst.itemBoxes) {
    box.boxIdx = f()
    box.respawnTicks = f()
  }

  for (let i = 0; i < dst.finishedOrder.length; i++) dst.finishedOrder[i] = f()

  for (const iv of dst.heldBotIntent as Intent[]) {
    iv.tick = f()
    iv.steer = f()
    iv.accel = f()
    iv.brake = bit()
    iv.drift = bit()
    iv.useItem = bit()
  }

  for (let i = 0; i < dst.heldBotTick.length; i++) dst.heldBotTick[i] = f()
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/protocol/test/checkpoint.test.ts`

Expected: PASS — 3 tests. If the first test's `statesEqual` assertion fails,
do not weaken it: bisect which field diverges using the per-field
`Object.is` assertions immediately below it in the same test, in this order
of likelihood — a field order mismatch between `encodeCheckpoint` and
`decodeCheckpoint` (most common category of bug in a purely-sequential
codec), a missed `heldBotIntent`/`heldBotTick` field (the specific defect
this task exists to catch), or an enum value absent from one of the four
`*_ORDER` tables.

- [ ] **Step 5: Run the full protocol suite and typecheck**

Run: `npx tsc --noEmit -p packages/protocol && npx vitest run packages/protocol`

Expected: PASS, zero type errors, every protocol test green (including Task
7's `roundtrip.test.ts` if it has already landed).

- [ ] **Step 6: Commit**

```bash
git add packages/protocol/src/checkpoint.ts packages/protocol/test/checkpoint.test.ts
git commit -m "feat(protocol): full-precision AuthorityCheckpoint codec

encodeCheckpoint/decodeCheckpoint serialize every SimState field - every
kart, every entity slot including dead residue, item-box timers, PRNG
cursor, race phase, tick, eventSeq, and Task 1's heldBotIntent/
heldBotTick - as raw little-endian float64s in SimState's declared
field order. No bit-packing and no quantization: this message has no
byte budget (spec \$5, not sent periodically), so the design optimizes
for exact statesEqual bit-identity instead, which a raw float64 copy
gives for free, -0 included.

Decisive test: decodeCheckpoint(encodeCheckpoint(s)) satisfies
statesEqual against a shape-matched but content-different dst, with
heldBotIntent/heldBotTick asserted field-by-field - dropping them would
resurrect the cross-room bot-hold bug Plan 2 Task 1 exists to fix."
```
