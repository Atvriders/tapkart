### Task 9: `packages/protocol/src/events.ts`

**Files:**
- Create: `packages/protocol/src/events.ts`
- Create: `packages/protocol/test/events.test.ts`

---

**Interfaces:**

- Consumes, contract §3, verbatim:
  ```ts
  export function encodeEvents(out: Uint8Array, events: AuthEvent[]): number
  export function decodeEvents(buf: Uint8Array, out: AuthEvent[]): void
  ```

- Consumes `AuthEvent` from `@tapkart/sim` — **read directly from
  `packages/sim/src/types.ts` in this checkout, not assumed:**
  ```ts
  export type AuthEventKind =
    | 'itemGrant' | 'entitySpawn' | 'entityDespawn'
    | 'hit' | 'spinOut' | 'respawn' | 'lapCross' | 'finish'

  export interface AuthEvent {
    eventSeq: number
    tick: number
    kind: AuthEventKind
    playerId: number
    entityId: number     // -1 when not applicable
    item: ItemKind       // 'none' when not applicable
    data: number          // kind-specific scalar, 0 when unused
  }
  ```
  Eight `AuthEventKind` values, in this exact declared order. `ItemKind` has
  nine values (`'none' | 'boost' | 'seeker' | 'bolt' | 'slick' | 'bubble' |
  'surge' | 'blink' | 'charge'`), also read directly from `types.ts`.
  `EntityKind` (six values: `'seeker' | 'bolt' | 'slick' | 'bubble' | 'surge'
  | 'charge'`) is a strict subset of `ItemKind`'s string literals, which is
  why `entity.ts` and `laps.ts`/`recovery.ts` can pass an `EntityKind` value
  into the `item: ItemKind` parameter of `emit()` for `entitySpawn`,
  `entityDespawn` and `hit` events — verified by reading
  `packages/sim/src/entity.ts` lines 76, 97, 256 and 258, all of which call
  `emit(state, events, <kind>, ..., kind-or-e.kind, ...)` where `kind`/
  `e.kind` is typed `EntityKind`. This task's `ITEM_ORDER` table (nine
  entries) therefore already covers every value these events can carry; no
  separate entity-kind table is needed for `item`.

- Produces:
  ```ts
  export function encodeEvents(out: Uint8Array, events: AuthEvent[]): number
  export function decodeEvents(buf: Uint8Array, out: AuthEvent[]): void
  ```
  `decodeEvents` **clears `out` first** (`out.length = 0`) and then pushes
  one freshly-allocated `AuthEvent` object per decoded record, in wire
  order — this is this task's own definition, stated here per contract §0's
  rule, because the contract's `void`-returning signature doesn't otherwise
  say whether `out` is appended to or replaced. Appending would silently
  accumulate stale events across repeated decode calls into the same array,
  which is not how every other reader of an out-array in this codebase
  behaves (`step()`'s `events: AuthEvent[]` out-param is cleared by its
  caller before each call, by the same convention).

---

**The wire layout is this task's own design**, because `AuthEvent` is not in
contract §4 (§4 covers only `WireSnapshot`'s per-kart/per-entity records).
Per contract §0: "A task needing something absent must define it in its own
files and say so in its `Interfaces` block." Every `AuthEvent` field is
already discrete (a counter, a tick, an enum, small integers) — none of it is
the continuous, lossy-by-design data `WireSnapshot` carries — so this codec
uses `BitWriter`/`BitReader`'s exact `writeBits`/`readBits`, matching
contract §0's rule for integer fields ("quantised exactly ... compare with
`Object.is`"), not `writeFloatQ`.

| Field | Bits | Encoding |
|---|---|---|
| `eventSeq` | 32 | raw unsigned |
| `tick` | 32 | raw unsigned |
| `kind` | 3 | index into `KIND_ORDER` (8 values, fits exactly in 3 bits) |
| `playerId` | 4 | `playerId + 1` — domain `-1..7` becomes wire `0..8`, fits in 4 bits (max 15) |
| `entityId` | 17 | `entityId + 1` — domain `-1..131070` becomes wire `0..131071`, the full range 17 bits can hold |
| `item` | 4 | index into `ITEM_ORDER` (9 values, fits exactly in 4 bits) |
| `data` | 16 | raw unsigned |

**Total: 108 bits per event.** A batch is prefixed by a 16-bit `eventCount`
(this task's own choice — nothing in the contract bounds how many events can
batch onto the reliable channel between ticks; 16 bits is generous headroom
without inventing a magic cap).

**Two of these widths are grounded in real observed values, not guesses:**

- `playerId`'s `-1` case is real, not hypothetical. `packages/sim/src/phase.ts`
  line 226 — verified by reading it directly — contains
  `emit(state, events, 'finish', -1, -1, 'none', finishers)`: `updatePhase`
  emits a **race-level** `finish` event with `playerId -1` once every kart has
  finished or the grace period elapses. The `playerId + 1` bias makes this
  representable in the same 4-bit field used for every other event's
  `playerId`, with no separate sentinel or special case.
- `data`'s 16-bit width is sized to the largest real value observed at any
  `emit()` call site, not to 8 bits. `packages/sim/src/entity.ts` line 76 —
  verified by reading it directly — calls
  `emit(state, events, 'entitySpawn', ownerId, entityId, kind, ttl)`, and
  `Tuning.entityTtl` is 600 (contract §1c, which independently widens
  `WireEntity.ttl` from `u8` to `u16` for the identical reason: "the wire
  format could not represent the tuning the simulation actually runs"). An
  8-bit `data` field would silently truncate this exact value; 16 bits
  covers it with headroom to spare (max 65535).

---

- [ ] **Step 1: Write the failing test**

Create `packages/protocol/test/events.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { AuthEvent, AuthEventKind } from '@tapkart/sim'
import { decodeEvents, encodeEvents } from '../src/events'

describe('encodeEvents / decodeEvents', () => {
  it('round-trips all eight AuthEventKinds, including the race-level finish (playerId -1)', () => {
    // Values below mirror real emit() call sites, verified by reading
    // packages/sim/src: itemGrant (items.ts:136), entitySpawn/entityDespawn/
    // hit (entity.ts:76,97,256,258), spinOut (recovery.ts:66), respawn
    // (recovery.ts:162), lapCross (laps.ts:97), finish, both per-kart
    // (laps.ts:107, phase.ts:219) and race-level with playerId -1
    // (phase.ts:226).
    const events: AuthEvent[] = [
      { eventSeq: 0, tick: 100, kind: 'itemGrant', playerId: 3, entityId: -1, item: 'boost', data: 12 },
      { eventSeq: 1, tick: 101, kind: 'entitySpawn', playerId: 3, entityId: 145, item: 'boost', data: 600 },
      { eventSeq: 2, tick: 250, kind: 'entityDespawn', playerId: 3, entityId: 145, item: 'boost', data: 0 },
      { eventSeq: 3, tick: 260, kind: 'hit', playerId: 5, entityId: 146, item: 'seeker', data: 1 },
      { eventSeq: 4, tick: 261, kind: 'hit', playerId: 6, entityId: 147, item: 'bolt', data: 0 },
      { eventSeq: 5, tick: 300, kind: 'spinOut', playerId: 2, entityId: -1, item: 'none', data: 60 },
      { eventSeq: 6, tick: 360, kind: 'respawn', playerId: 2, entityId: -1, item: 'none', data: 72 },
      { eventSeq: 7, tick: 500, kind: 'lapCross', playerId: 0, entityId: -1, item: 'none', data: 2 },
      { eventSeq: 8, tick: 3600, kind: 'finish', playerId: 4, entityId: -1, item: 'none', data: 1 },
      { eventSeq: 9, tick: 3600, kind: 'finish', playerId: -1, entityId: -1, item: 'none', data: 8 },
    ]

    const buf = new Uint8Array(256)
    const n = encodeEvents(buf, events)

    // header 16 bits + 10 events * 108 bits = 1096 bits = 137 bytes
    expect(n).toBe(137)

    const out: AuthEvent[] = [
      { eventSeq: -1, tick: -1, kind: 'hit', playerId: -1, entityId: -1, item: 'none', data: -1 },
    ]
    decodeEvents(buf.subarray(0, n), out)

    expect(out.length).toBe(events.length)
    for (let i = 0; i < events.length; i++) {
      expect(out[i]).toEqual(events[i])
    }

    // The specific hazard this task exists to guard: a negative playerId
    // must survive the round trip, exactly.
    expect(Object.is(out[9]!.playerId, -1)).toBe(true)
    expect(out[9]!.kind).toBe('finish')

    // entityId -1 (not applicable) and a real spawned id both survive.
    expect(out[0]!.entityId).toBe(-1)
    expect(out[1]!.entityId).toBe(145)

    // item 'none' (unused) and a real item both survive.
    expect(out[5]!.item).toBe('none')
    expect(out[1]!.item).toBe('boost')
  })

  it('clears out before decoding, rather than appending to it', () => {
    const single: AuthEvent[] = [
      { eventSeq: 42, tick: 7, kind: 'lapCross', playerId: 1, entityId: -1, item: 'none', data: 1 },
    ]
    const buf = new Uint8Array(64)
    const n = encodeEvents(buf, single)

    const out: AuthEvent[] = [
      { eventSeq: 0, tick: 0, kind: 'hit', playerId: 0, entityId: 0, item: 'none', data: 0 },
      { eventSeq: 0, tick: 0, kind: 'hit', playerId: 0, entityId: 0, item: 'none', data: 0 },
      { eventSeq: 0, tick: 0, kind: 'hit', playerId: 0, entityId: 0, item: 'none', data: 0 },
    ]
    decodeEvents(buf.subarray(0, n), out)

    expect(out.length).toBe(1)
    expect(out[0]).toEqual(single[0])
  })

  it('round-trips a zero-event batch', () => {
    const buf = new Uint8Array(16)
    const n = encodeEvents(buf, [])
    expect(n).toBe(2) // 16-bit count only

    const out: AuthEvent[] = [
      { eventSeq: 9, tick: 9, kind: 'hit', playerId: 9, entityId: 9, item: 'none', data: 9 },
    ]
    decodeEvents(buf.subarray(0, n), out)
    expect(out.length).toBe(0)
  })

  it('survives data and entityId at their representable extremes', () => {
    const events: AuthEvent[] = [
      { eventSeq: 100, tick: 200, kind: 'entitySpawn', playerId: 0, entityId: 0, item: 'seeker', data: 0 },
      { eventSeq: 101, tick: 201, kind: 'entitySpawn', playerId: 7, entityId: 131070, item: 'charge', data: 65535 },
    ]
    const buf = new Uint8Array(64)
    const n = encodeEvents(buf, events)
    const out: AuthEvent[] = []
    decodeEvents(buf.subarray(0, n), out)

    expect(out[0]!.entityId).toBe(0)
    expect(out[0]!.data).toBe(0)
    // 131070 = 2^17 - 2: the largest entityId the 17-bit, +1-biased field can
    // hold (wire max is 2^17 - 1 = 131071, reserved for entityId 131070).
    expect(out[1]!.entityId).toBe(131070)
    // 65535 = 2^16 - 1: the unsigned max of the 16-bit data field.
    expect(out[1]!.data).toBe(65535)
  })

  it('throws on an unrecognised AuthEventKind rather than silently miscoding it', () => {
    const bogus: AuthEvent[] = [
      { eventSeq: 0, tick: 0, kind: 'bogus' as AuthEventKind, playerId: 0, entityId: -1, item: 'none', data: 0 },
    ]
    const buf = new Uint8Array(32)
    expect(() => encodeEvents(buf, bogus)).toThrow(/AuthEventKind/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/protocol/test/events.test.ts`

Expected: FAIL with `Error: Failed to resolve import "../src/events" from
"packages/protocol/test/events.test.ts". Does the file exist?` — `events.ts`
does not exist yet, so this is a module resolution failure, not a runtime
`TypeError`.

- [ ] **Step 3: Write the implementation**

Create `packages/protocol/src/events.ts`:

```ts
import type { AuthEvent, AuthEventKind, ItemKind } from '@tapkart/sim'
import { BitReader, BitWriter } from './bits'

/** Fixed wire order, matching AuthEventKind's declaration in @tapkart/sim's types.ts. */
const KIND_ORDER: AuthEventKind[] = [
  'itemGrant', 'entitySpawn', 'entityDespawn', 'hit', 'spinOut', 'respawn', 'lapCross', 'finish',
]
/** Fixed wire order, matching ItemKind's declaration in @tapkart/sim's types.ts.
 * EntityKind's six values are a strict subset of these nine, so entitySpawn/
 * entityDespawn/hit events (whose `item` field actually carries an
 * EntityKind) are already covered - no separate table is needed. */
const ITEM_ORDER: ItemKind[] = [
  'none', 'boost', 'seeker', 'bolt', 'slick', 'bubble', 'surge', 'blink', 'charge',
]

const EVENT_COUNT_BITS = 16
const EVENT_SEQ_BITS = 32
const TICK_BITS = 32
const KIND_BITS = 3
const PLAYER_ID_BITS = 4 // wire = playerId + 1, domain -1..7
const ENTITY_ID_BITS = 17 // wire = entityId + 1, domain -1..131070
const ITEM_BITS = 4
const DATA_BITS = 16

export function encodeEvents(out: Uint8Array, events: AuthEvent[]): number {
  const w = new BitWriter(out)
  w.writeBits(events.length, EVENT_COUNT_BITS)

  for (const ev of events) {
    const kindIdx = KIND_ORDER.indexOf(ev.kind)
    if (kindIdx < 0) throw new Error(`encodeEvents: unknown AuthEventKind ${String(ev.kind)}`)
    const itemIdx = ITEM_ORDER.indexOf(ev.item)
    if (itemIdx < 0) throw new Error(`encodeEvents: unknown ItemKind ${String(ev.item)}`)

    w.writeBits(ev.eventSeq, EVENT_SEQ_BITS)
    w.writeBits(ev.tick, TICK_BITS)
    w.writeBits(kindIdx, KIND_BITS)
    w.writeBits(ev.playerId + 1, PLAYER_ID_BITS)
    w.writeBits(ev.entityId + 1, ENTITY_ID_BITS)
    w.writeBits(itemIdx, ITEM_BITS)
    w.writeBits(ev.data, DATA_BITS)
  }

  return w.byteLength()
}

export function decodeEvents(buf: Uint8Array, out: AuthEvent[]): void {
  const r = new BitReader(buf)
  const count = r.readBits(EVENT_COUNT_BITS)
  out.length = 0

  for (let i = 0; i < count; i++) {
    const eventSeq = r.readBits(EVENT_SEQ_BITS)
    const tick = r.readBits(TICK_BITS)
    const kind = KIND_ORDER[r.readBits(KIND_BITS)]!
    const playerId = r.readBits(PLAYER_ID_BITS) - 1
    const entityId = r.readBits(ENTITY_ID_BITS) - 1
    const item = ITEM_ORDER[r.readBits(ITEM_BITS)]!
    const data = r.readBits(DATA_BITS)
    out.push({ eventSeq, tick, kind, playerId, entityId, item, data })
  }
}
```

If Task 4's `BitWriter`/`BitReader` require an explicit `reset()` before
first use (see Task 7's brief for the same caveat), add `w.reset()` /
`r.reset()` immediately after each constructor call above; nothing else
changes.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/protocol/test/events.test.ts`

Expected: PASS — 5 tests. If the `playerId -1` assertion fails specifically,
check the bias arithmetic first (`ev.playerId + 1` on encode, `- 1` on
decode) before suspecting `BitWriter`/`BitReader` — a `+1`/`-1` mismatch
between encode and decode is the most likely single bug here, and it would
make every event's `playerId` wrong by one, not just the `-1` case, which is
a good first signal to check if the whole first test fails rather than just
that one assertion.

- [ ] **Step 5: Run the full protocol suite and typecheck**

Run: `npx tsc --noEmit -p packages/protocol && npx vitest run packages/protocol`

Expected: PASS, zero type errors, every protocol test green (including Tasks
7 and 8's suites if they have already landed).

- [ ] **Step 6: Commit**

```bash
git add packages/protocol/src/events.ts packages/protocol/test/events.test.ts
git commit -m "feat(protocol): AuthEvent codec for the reliable channel

encodeEvents/decodeEvents bit-pack a batch of AuthEvents: a 16-bit
count header, then 108 bits per event (eventSeq u32, tick u32, kind 3
bits into a fixed 8-entry table, playerId 4 bits biased +1 so -1 is
representable, entityId 17 bits biased +1, item 4 bits into a fixed
9-entry table, data 16 bits). AuthEvent isn't in the locked contract's
\$4 wire table, so this layout is this task's own definition.

playerId's -1 case and data's 16-bit width are both grounded in real
emit() call sites, not guesses: phase.ts's race-level finish event
passes playerId -1, and entity.ts's entitySpawn passes ttl (up to
Tuning.entityTtl = 600) as data, which would truncate silently at 8
bits. decodeEvents clears its out-array before decoding rather than
appending, matching how step()'s own events out-param is used
elsewhere in this codebase."
```
