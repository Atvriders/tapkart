### Task 5: The quantisation and epsilon tables — `Q`, `EPS`, `quantStep`

This is Plan 2's Task 5, contract §3: `packages/protocol/src/quant.ts`. It transcribes
contract §4 — "the heart of this plan" — into frozen, typed constants. Every later
task that touches a wire field (Task 6's `snapshot.ts`, Task 8's `checkpoint.ts`, and
Task 7's exhaustive epsilon-exceeds-step assertion, none of which are this task) reads
`Q[field].{min,max,bits}` rather than repeating a magic number, so a single wrong
constant here is wrong everywhere at once — which is exactly why every number below is
derived from contract §4's own numbers (range, bits) rather than copied from its
prose "Step" column. This task has no dependency on Task 4's `bits.ts` and Task 4 has
none on this task; they may be done in either order, but both must land before Task 6.
(This independence is about the two modules' code, not the shared barrel file: Step
12 below appends `export * from './quant'` to `packages/protocol/src/index.ts` and
its "Before" anchor assumes Task 4 already appended `./bits` there, matching this
plan's own convention of executing Tasks 1-18 in numeric order. If Task 5 is ever
run before Task 4 in practice, adjust that one anchor to match whatever the barrel
actually contains at the time — the append itself is order-independent, only the
diff text shown is not.)

**Read contract §4 before writing anything.** It is a 20-row table (`position.{x,y,z}`
through `playerId`) of `Field | Range | Bits | Step | Epsilon | Compared as`, plus two
paragraphs of prose below it for the entity record and the header. This task's `Q`
and `EPS` cover **only the six continuous rows** — `position, velocity, heading,
angularVelocity, driftCharge, t` — the only ones with a real step and epsilon.
Contract §4 is explicit about the other fourteen: *"Only the six continuous rows
above appear in `Q` and `EPS`. The [...] 'exact' rows carry no quantisation noise and
therefore need no epsilon — giving them one would invite someone to compare an
integer with a tolerance."* Those fourteen rows (`spinOutTicks`, `invulnTicks`,
`boostTicks`, `respawnTicks`, `lap`, `checkpointIdx`, `item`, `surface`,
`driftActive`+`driftDir`, `airborne`, `shielded`, `isBot`, `connected`, `playerId` —
`isBot` and `connected` are two separate 1-bit rows, each with its own bit, not one
shared bit) plus the entity record's `entityId u16`/`kind u4`/`ownerId u3`/`ttl u16`
and the header's `tick u32`/`eventSeq u32`/`entityCount u8` are plain fixed-width
integers or 1-bit flags with no epsilon concept at all. Task 6 writes all of those bit
widths as literal numbers, sourced directly from contract §4's prose, not through `Q`
— the same pattern Task 6 already uses for the entity/header fields (`ENTITY_ID_BITS =
16`, etc.). Keeping `Q`/`EPS` scoped to exactly the six rows contract §4 gives a
step/epsilon value is what "transcribed from contract §4 exactly" means here —
widening it to fields that were never given an epsilon would be inventing a table
contract §4 does not contain.

**Two decisions this task makes, both load-bearing for Task 6 and for Task 7 (not
this task, but the next reader of `Q`/`EPS`):**

1. **Six keys, not twenty rows, and the continuous key is `t`.** Contract §3
   (`QuantTable`/`EpsilonTable`) locks the interface to exactly `position, velocity,
   heading, angularVelocity, driftCharge, t` — a closed shape, not an open
   `Record<string, QuantField>` a later file could widen by accident. The key for lap
   progress is `t`, not `lap.t` and not `lapT`, "matching the flat `WireKart`
   interface" (contract §4) that Task 3 already ships. `isBot` and `connected` are
   **not** in this table at all — contract §4 gives each its own dedicated wire bit
   ("deliberately... An earlier draft implied they shared one, which only works if
   `isBot === !connected` always holds... it is an *emergent* property... not an
   invariant anything enforces") and both are exact (0-epsilon) fields Task 6 owns
   directly, the same as the other twelve exact fields. Nothing in this file merges
   any two `KartState` fields into one wire bit; packing decisions for exact fields
   belong entirely to Task 6.
2. **The prose "Step" column is illustrative; `quantStep` is the source of truth.**
   Contract §4 states this itself: *"Steps below are `quantStep(min, max, bits) =
   (max - min) / ((1 << bits) - 1)`, computed, not rounded. An earlier draft of this
   table divided by `1 << bits` and was wrong in the fourth decimal for several rows
   ... The code always derives the step through `quantStep`, so the arithmetic never
   mattered to behaviour — but a reader who 'fixed' the formula to match the wrong
   prose would break every one of them at once."* This task's tests assert `quantStep`
   against exact fraction expressions (`32 / 1023`, `1 / 1023`, ...) — the same
   arithmetic the function itself performs — rather than against any rounded decimal,
   so a correct implementation cannot be made to disagree with itself no matter which
   draft of the prose table a reader is looking at. `Q`'s `min`/`max`/`bits` integers
   (the only inputs `quantStep` and `writeFloatQ`/`readFloatQ` actually consume) are
   unambiguous in contract §4 and are transcribed exactly.

**Files:**
- Create: `packages/protocol/src/quant.ts`
- Test: `packages/protocol/test/quant.test.ts`

**Interfaces:**
- Consumes: nothing. This file has zero imports (not even from `bits.ts`).
- Produces (`packages/protocol/src/quant.ts`), contract §3's signature verbatim:
  ```ts
  export const WORLD_HALF = 1024

  export interface QuantField {
    readonly min: number
    readonly max: number
    readonly bits: number
  }

  export interface QuantTable {
    readonly position: QuantField
    readonly velocity: QuantField
    readonly heading: QuantField
    readonly angularVelocity: QuantField
    readonly driftCharge: QuantField
    readonly t: QuantField
  }

  export interface EpsilonTable {
    readonly position: number
    readonly velocity: number
    readonly heading: number
    readonly angularVelocity: number
    readonly driftCharge: number
    readonly t: number
  }

  export const Q: QuantTable
  export const EPS: EpsilonTable
  export function quantStep(min: number, max: number, bits: number): number
  ```
  `position` and `velocity` each describe one shared `{min,max,bits}` reused three
  times by whoever encodes `x`, `y`, `z` (Task 6) — `Q` has one `position` entry, not
  three.

---

- [ ] **Step 1: Write the failing test for `quantStep` and `WORLD_HALF`**

Create `packages/protocol/test/quant.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { quantStep, WORLD_HALF } from '../src/quant'

describe('WORLD_HALF', () => {
  it('is 1024', () => {
    expect(WORLD_HALF).toBe(1024)
  })
})

describe('quantStep', () => {
  it('matches (max - min) / (2^bits - 1) for every continuous field range', () => {
    expect(quantStep(-1024, 1024, 16)).toBe(2048 / 65535)
    expect(quantStep(-64, 64, 12)).toBe(128 / 4095)
    expect(quantStep(-Math.PI, Math.PI, 12)).toBe((2 * Math.PI) / 4095)
    expect(quantStep(-16, 16, 10)).toBe(32 / 1023)
    expect(quantStep(0, 255, 8)).toBe(255 / 255)
    expect(quantStep(0, 1, 10)).toBe(1 / 1023)
  })

  it('divides by 2^bits - 1, not 2^bits, at 10 bits', () => {
    // An earlier draft of contract §4's prose table rounded two 10-bit rows as if
    // the denominator were 2^bits (1024): angularVelocity would round to 0.03125
    // and t (lap progress) to 0.0009766. The formula's denominator is 2^bits - 1
    // (1023) - these differ at the 4th decimal, and the current contract's own
    // Step column already reflects the corrected value (0.0312805 / 0.0009775).
    const angularVelocityStep = quantStep(-16, 16, 10)
    expect(angularVelocityStep).toBeCloseTo(0.0312805, 6)
    expect(angularVelocityStep).not.toBeCloseTo(0.03125, 6)
    const tStep = quantStep(0, 1, 10)
    expect(tStep).toBeCloseTo(0.0009775, 6)
    expect(tStep).not.toBeCloseTo(0.0009766, 6)
  })

  it('is exactly 1 for every field whose range spans exactly 2^bits - 1 integers', () => {
    expect(quantStep(0, 255, 8)).toBe(1)
    expect(quantStep(0, 127, 7)).toBe(1)
    expect(quantStep(0, 63, 6)).toBe(1)
    expect(quantStep(0, 15, 4)).toBe(1)
    expect(quantStep(0, 7, 3)).toBe(1)
    expect(quantStep(0, 3, 2)).toBe(1)
    expect(quantStep(0, 1, 1)).toBe(1)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/protocol/test/quant.test.ts`

Expected: FAIL — suite fails to load, under "Failed Suites":
`Error: Cannot find module '../src/quant' imported from
'/home/kasm-user/tapkart/packages/protocol/test/quant.test.ts'`. Zero tests collected
(`src/quant.ts` does not exist yet).

- [ ] **Step 3: Write `WORLD_HALF` and `quantStep`**

Create `packages/protocol/src/quant.ts`:

```ts
/** Half-width of the world in metres; ±WORLD_HALF encloses every shipped track with
 * margin (the largest generated track spans x in [-82, 722] - contract §4). */
export const WORLD_HALF = 1024

/**
 * Uniform quantisation step size for a `bits`-wide field spanning [min, max].
 * `2^bits` distinct codes exist but only `2^bits - 1` *gaps* separate them, so the
 * step - and the denominator here - is `(2^bits - 1)`, not `2^bits` (contract §4).
 */
export function quantStep(min: number, max: number, bits: number): number {
  return (max - min) / ((1 << bits) - 1)
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/protocol/test/quant.test.ts`

Expected: PASS — 4 passed.

---

- [ ] **Step 5: Write the failing tests for `Q` and `EPS`**

Append to `packages/protocol/test/quant.test.ts`:

```ts
import { EPS, Q } from '../src/quant'

const CONTINUOUS_FIELDS = ['angularVelocity', 'driftCharge', 'heading', 'position', 't', 'velocity'] as const

describe('Q', () => {
  it('has exactly the six continuous fields contract §3/§4 name, keyed t not lapT', () => {
    expect(Object.keys(Q).sort()).toEqual([...CONTINUOUS_FIELDS].sort())
  })

  it('matches contract §4 range and bits for every field', () => {
    expect(Q.position).toEqual({ min: -WORLD_HALF, max: WORLD_HALF, bits: 16 })
    expect(Q.velocity).toEqual({ min: -64, max: 64, bits: 12 })
    expect(Q.heading).toEqual({ min: -Math.PI, max: Math.PI, bits: 12 })
    expect(Q.angularVelocity).toEqual({ min: -16, max: 16, bits: 10 })
    expect(Q.driftCharge).toEqual({ min: 0, max: 255, bits: 8 })
    expect(Q.t).toEqual({ min: 0, max: 1, bits: 10 })
  })

  it('sums to 124 bits across the six continuous fields, position/velocity counted 3x each', () => {
    // 3*16 (position.x,y,z) + 3*12 (velocity.x,y,z) + 12 (heading) + 10 (angularVelocity)
    // + 8 (driftCharge) + 10 (t) = 48 + 36 + 12 + 10 + 8 + 10 = 124.
    // The full 178-bit-per-kart total (contract §4) also needs the fourteen exact
    // fields' widths, which are Task 6's local constants, not Q -- Task 6 asserts
    // the full 178-bit total once those constants exist alongside these six.
    const singleWidth = (['heading', 'angularVelocity', 'driftCharge', 't'] as const)
      .reduce((sum, f) => sum + Q[f].bits, 0)
    const total = singleWidth + 3 * Q.position.bits + 3 * Q.velocity.bits
    expect(total).toBe(124)
  })

  it('is deeply frozen: the table and every field object inside it', () => {
    expect(Object.isFrozen(Q)).toBe(true)
    expect(Object.isFrozen(Q.position)).toBe(true)
    expect(Object.isFrozen(Q.t)).toBe(true)
  })
})

describe('EPS', () => {
  it('has exactly the same six keys as Q', () => {
    expect(Object.keys(EPS).sort()).toEqual(Object.keys(Q).sort())
  })

  it('matches contract §4 epsilon for every field', () => {
    expect(EPS.position).toBe(0.05)
    expect(EPS.velocity).toBe(0.05)
    expect(EPS.heading).toBe(0.0025)
    expect(EPS.angularVelocity).toBe(0.05)
    expect(EPS.driftCharge).toBe(1.5)
    expect(EPS.t).toBe(0.002)
  })

  it('is frozen', () => {
    expect(Object.isFrozen(EPS)).toBe(true)
  })

  it('exceeds quantStep for every field - the buzz-prevention invariant', () => {
    // contract §0/§4: an epsilon at or below its field's step means quantisation
    // noise alone triggers a correction every snapshot. This is a basic sanity
    // check at the point of authorship; Task 7 asserts the same inequality
    // mechanically for every field as its own dedicated test.
    for (const f of CONTINUOUS_FIELDS) {
      const step = quantStep(Q[f].min, Q[f].max, Q[f].bits)
      expect(EPS[f]).toBeGreaterThan(step)
    }
  })
})
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `npx vitest run packages/protocol/test/quant.test.ts -t "^Q "`

Expected: FAIL — `TypeError: Cannot read properties of undefined (reading
'position')`. (`Q` is not exported yet, so the imported binding is `undefined`;
`Q.position` in the first assertion throws reading a property of `undefined`.)

- [ ] **Step 7: Write `Q` and `EPS`**

Append to `packages/protocol/src/quant.ts`:

```ts
/** One quantised field's shape: linear range plus bit width. Frozen per-instance so
 * `Object.freeze(Q)` (shallow) is not the only thing standing between a caller and
 * a mutated table - each field object is frozen too. */
export interface QuantField {
  readonly min: number
  readonly max: number
  readonly bits: number
}

/**
 * The six continuous fields of contract §4's per-kart table - the only ones with a
 * real step and epsilon. `position` and `velocity` are listed once each and reused
 * for x, y and z by whoever encodes them (Task 6). The fourteen exact/enum fields
 * (spinOutTicks .. playerId, isBot and connected each with their own bit) have no
 * entry here: they carry no quantisation noise, so an epsilon for them would invite
 * comparing an integer with a tolerance (contract §4). Task 6 owns their bit widths
 * directly, as local constants.
 */
export interface QuantTable {
  readonly position: QuantField
  readonly velocity: QuantField
  readonly heading: QuantField
  readonly angularVelocity: QuantField
  readonly driftCharge: QuantField
  readonly t: QuantField
}

export interface EpsilonTable {
  readonly position: number
  readonly velocity: number
  readonly heading: number
  readonly angularVelocity: number
  readonly driftCharge: number
  readonly t: number
}

function qf(min: number, max: number, bits: number): QuantField {
  return Object.freeze({ min, max, bits })
}

/** Contract §4's six continuous rows, transcribed field by field. Frozen two levels
 * deep: the table itself and every QuantField inside it. */
export const Q: QuantTable = Object.freeze({
  position: qf(-WORLD_HALF, WORLD_HALF, 16),
  velocity: qf(-64, 64, 12),
  heading: qf(-Math.PI, Math.PI, 12),
  angularVelocity: qf(-16, 16, 10),
  driftCharge: qf(0, 255, 8),
  t: qf(0, 1, 10),
})

/** Contract §4's Epsilon column for the six continuous rows. Every value here
 * exceeds its own quantStep - see the last test in this task's file, and Task 7's
 * exhaustive version of the same check. Do not tune any of these down (contract §0). */
export const EPS: EpsilonTable = Object.freeze({
  position: 0.05,
  velocity: 0.05,
  heading: 0.0025,
  angularVelocity: 0.05,
  driftCharge: 1.5,
  t: 0.002,
})
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `npx vitest run packages/protocol/test/quant.test.ts`

Expected: PASS — 12 passed (4 from `quantStep`/`WORLD_HALF`, 4 from `Q`, 4 from `EPS`).

---

- [ ] **Step 9: Typecheck and run the whole protocol suite**

Run: `npx tsc --noEmit -p packages/protocol && npx vitest run packages/protocol`

Expected: PASS — no TypeScript errors; `quant.test.ts` 12 passed, plus Task 3's and
Task 4's tests (this task adds no new dependency on either and removes nothing).

---

- [ ] **Step 10: Write the failing test — `Q`, `EPS`, `quantStep`, `WORLD_HALF` reachable through the barrel**

Contract §3: "The barrel exists from Task 3, not Task 18" — by the time this task
runs, `packages/protocol/src/index.ts` re-exports `./types` (Task 3) and `./bits`
(Task 4). This task's module is `quant.ts`; appending its own line is this task's
last implementation step, exactly as Plan 1's Tasks 3-10 each did for
`@tapkart/sim/src/index.ts`, so `packages/net` can `import ... from
'@tapkart/protocol'` from Task 11 onward without waiting for Task 18.

Append to `packages/protocol/test/quant.test.ts`, after the closing `})` of
`describe('EPS', ...)`:

```ts
describe('@tapkart/protocol barrel', () => {
  it('re-exports Q, EPS, quantStep and WORLD_HALF', async () => {
    const pkg = await import('@tapkart/protocol')
    expect(pkg.WORLD_HALF).toBe(1024)
    expect(typeof pkg.quantStep).toBe('function')
    expect(pkg.Q.position.bits).toBe(16)
    expect(pkg.EPS.position).toBe(0.05)
  })
})
```

This is a dynamic import, matching Task 3's own barrel test in `types.test.ts` and
`packages/sim/test/barrel.test.ts`'s `'resolves through the @tapkart/sim package entry
point'` test, so a resolution failure fails this one test rather than the whole file.

- [ ] **Step 11: Run the test to verify it fails**

Run: `npx vitest run packages/protocol/test/quant.test.ts -t "re-exports Q, EPS, quantStep and WORLD_HALF"`

Expected: FAIL — `packages/protocol/src/index.ts` does not yet re-export `./quant`
(only `./types` and `./bits`), so the dynamically-imported package object has no
`WORLD_HALF` property: `AssertionError: expected undefined to be 1024` at
`expect(pkg.WORLD_HALF).toBe(1024)`.

- [ ] **Step 12: Widen the barrel**

In `packages/protocol/src/index.ts`. Before:

```ts
export * from './types'
export * from './bits'
```

After:

```ts
export * from './types'
export * from './bits'
export * from './quant'
```

- [ ] **Step 13: Run the test to verify it passes, then the whole file and package**

Run: `npx vitest run packages/protocol/test/quant.test.ts`
Expected: PASS — 13 passed (12 from Steps 4/8, plus the barrel test).

Run: `npx tsc --noEmit -p packages/protocol && npx vitest run packages/protocol`
Expected: PASS — no TypeScript errors; every test across the package still passes,
including Task 3's and Task 4's own barrel tests, which this task's edit to
`index.ts` does not touch.

- [ ] **Step 14: Commit**

```bash
git add packages/protocol/src/quant.ts packages/protocol/src/index.ts \
        packages/protocol/test/quant.test.ts
git commit -m "feat(protocol): quantisation and epsilon tables transcribed from contract §4

Q/EPS cover exactly the six continuous fields (position, velocity, heading,
angularVelocity, driftCharge, t) contract §3 locks -- the fourteen exact/enum
fields (isBot and connected each with their own bit, not shared) carry no
epsilon and are Task 6's local constants instead.

Widens packages/protocol/src/index.ts to re-export quant.ts, so packages/net
can reach Q/EPS/quantStep/WORLD_HALF through @tapkart/protocol from Task 11
onward instead of waiting for Task 18's barrel widening."
```
