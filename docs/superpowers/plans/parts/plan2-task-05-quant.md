### Task 5: The quantisation and epsilon tables — `Q`, `EPS`, `quantStep`

This is Plan 2's Task 5, contract §3: `packages/protocol/src/quant.ts`. It transcribes
contract §4 — "the heart of this plan" — into frozen, typed constants. Every later
task that touches a wire field (Task 6's `snapshot.ts`, Task 8's `checkpoint.ts`, and
Task 7's exhaustive epsilon-exceeds-step assertion, none of which are this task) reads
`Q[field].{min,max,bits}` rather than repeating a magic number, so a single wrong
constant here is wrong everywhere at once — which is exactly why every number below is
derived from contract §4's own numbers (range, bits) rather than copied from its
rounded prose "Step" column. This task has no dependency on Task 4's `bits.ts` and
Task 4 has none on this task; they may be done in either order, but both must land
before Task 6.

**Read contract §4 before writing anything.** It is a 17-row table (`position`
through `playerId`) of `Field | Range | Bits | Step | Epsilon | Compared as`, plus two
paragraphs of prose below it for the entity record and the header. This task's `Q`
and `EPS` cover **only the 17-row table** — the per-kart record. The entity record's
`entityId u16`/`kind u4`/`ownerId u3`/`ttl u16` and the header's `tick u32`/`eventSeq
u32`/`entityCount u8` are plain fixed-width integers with no epsilon concept at all
(`WireEntity` fields are never compared with an epsilon band — spec §5 states
entities are "authority-simulated and client-interpolated only, never predicted", so
there is nothing to reconcile against a locally-predicted value the way a kart's own
fields are). Task 6 writes those bit widths as literal numbers, sourced directly from
contract §4's prose, not through `Q`. Keeping `Q`/`EPS` scoped to exactly the table
that has a Step/Epsilon/Compared-as column is what "transcribed from contract §4
exactly" means here — widening it to fields that were never given an epsilon would be
inventing a table contract §4 does not contain.

**Two decisions this task makes, both load-bearing for Task 6 and for Task 7 (not
this task, but the next reader of `Q`/`EPS`):**

1. **19 keys, not 17 rows.** Contract §4's row `` `airborne`, `shielded`,
   `isBot`/`connected` | — | 1 each `` packs three named things into one prose row.
   Summing the table's own Bits column confirms this is *three* 1-bit fields, not
   four: `position`(48) + `velocity`(36) + `heading`(12) + `angularVelocity`(10) +
   `driftCharge`(8) + `lapT`(10) + `spinOutTicks`(8) + `invulnTicks`(8) +
   `boostTicks`(7) + `respawnTicks`(7) + `lap`(3) + `checkpointIdx`(6) + `item`(4) +
   `surface`(2) + `driftPacked`(2) + `airborne`(1) + `shielded`(1) +
   `connected`(1) + `playerId`(3) = **177**, matching contract §4's stated total
   exactly. Reading `isBot`/`connected` as *two* separate 1-bit fields sums to 178,
   one over. So `isBot` and `connected` share a single wire bit — see decision 2 —
   and `Q`/`EPS` name that shared bit `connected` (the network-observable ground
   truth), not `isBot` (the derived flag). `driftActive`+`driftDir` is likewise one
   named key here, `driftPacked`, because it is packed as one field on the wire even
   though it fills two `KartState` fields; Task 6 owns the packing scheme, this task
   only reserves its 2-bit width and 0 epsilon.
2. **The prose "Step" column is illustrative, not the source of truth — `quantStep`
   is.** Two of contract §4's own rows do not match the formula their own signature
   specifies (`quantStep(min, max, bits) = (max - min) / ((1 << bits) - 1)`):
   `angularVelocity`'s row says step `0.03125` (copied down from the `position`/
   `velocity` rows above it), but `32 / ((1 << 10) - 1) = 32 / 1023 =
   0.03128054741...`, not `0.03125`. `lap.t`'s row says step `0.0009766`, which is
   `1 / 1024`; the formula gives `1 / ((1 << 10) - 1) = 1 / 1023 =
   0.00097751710...`, an off-by-one in the denominator. This task's tests assert
   `quantStep` against exact fraction expressions (`32 / 1023`, `1 / 1023`, ...) —
   the same arithmetic the function itself performs — rather than against the
   prose's rounded decimals, so a correct implementation is not penalized for
   disagreeing with a table that rounds inconsistently. `Q`'s `min`/`max`/`bits`
   integers (the only inputs `quantStep` and `writeFloatQ`/`readFloatQ` actually
   consume) are unambiguous in contract §4 and are transcribed exactly.

**Files:**
- Create: `packages/protocol/src/quant.ts`
- Test: `packages/protocol/test/quant.test.ts`

**Interfaces:**
- Consumes: nothing. This file has zero imports (not even from `bits.ts`).
- Produces (`packages/protocol/src/quant.ts`), contract §3's signature plus the types
  it requires but does not itself name (`QuantTable`/`EpsilonTable` are referenced by
  contract §3 as types but defined here, per the contract's own instruction that "a
  task needing something absent must define it in its own files and say so"):
  ```ts
  export const WORLD_HALF = 1024

  export interface QuantField {
    readonly min: number
    readonly max: number
    readonly bits: number
  }

  export type QuantFieldName =
    | 'position' | 'velocity' | 'heading' | 'angularVelocity' | 'driftCharge' | 'lapT'
    | 'spinOutTicks' | 'invulnTicks' | 'boostTicks' | 'respawnTicks'
    | 'lap' | 'checkpointIdx' | 'item' | 'surface' | 'driftPacked'
    | 'airborne' | 'shielded' | 'connected' | 'playerId'

  export type QuantTable = Readonly<Record<QuantFieldName, QuantField>>
  export type EpsilonTable = Readonly<Record<QuantFieldName, number>>

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

  it('disagrees with contract §4 prose exactly where the prose rounds wrong', () => {
    // angularVelocity's prose Step is "0.03125" (copied from position/velocity);
    // the formula gives 32/1023, not 32/1024 - these differ at the 4th decimal
    const angularVelocityStep = quantStep(-16, 16, 10)
    expect(angularVelocityStep).toBeCloseTo(0.0312805, 6)
    expect(angularVelocityStep).not.toBeCloseTo(0.03125, 6)
    // lap.t's prose Step is "0.0009766", which is 1/1024; the formula's
    // denominator is (2^bits - 1) = 1023, not 1024
    const lapTStep = quantStep(0, 1, 10)
    expect(lapTStep).toBeCloseTo(0.0009775, 6)
    expect(lapTStep).not.toBeCloseTo(0.0009766, 6)
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
 * step - and the denominator here - is `(2^bits - 1)`, not `2^bits`. Two rows of
 * contract §4's own prose table round as if it were `2^bits` (see this task's
 * decision 2); this function implements the formula the contract's own signature
 * specifies, not the rounded prose.
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
import { EPS, Q, type QuantFieldName } from '../src/quant'

const ALL_FIELDS: QuantFieldName[] = [
  'position', 'velocity', 'heading', 'angularVelocity', 'driftCharge', 'lapT',
  'spinOutTicks', 'invulnTicks', 'boostTicks', 'respawnTicks',
  'lap', 'checkpointIdx', 'item', 'surface', 'driftPacked',
  'airborne', 'shielded', 'connected', 'playerId',
]

describe('Q', () => {
  it('has exactly the 19 fields contract §4 names, position/velocity shared once', () => {
    expect(Object.keys(Q).sort()).toEqual([...ALL_FIELDS].sort())
  })

  it('matches contract §4 range and bits for every continuous field', () => {
    expect(Q.position).toEqual({ min: -WORLD_HALF, max: WORLD_HALF, bits: 16 })
    expect(Q.velocity).toEqual({ min: -64, max: 64, bits: 12 })
    expect(Q.heading).toEqual({ min: -Math.PI, max: Math.PI, bits: 12 })
    expect(Q.angularVelocity).toEqual({ min: -16, max: 16, bits: 10 })
    expect(Q.driftCharge).toEqual({ min: 0, max: 255, bits: 8 })
    expect(Q.lapT).toEqual({ min: 0, max: 1, bits: 10 })
  })

  it('matches contract §4 range and bits for every exact/enum field', () => {
    expect(Q.spinOutTicks).toEqual({ min: 0, max: 255, bits: 8 })
    expect(Q.invulnTicks).toEqual({ min: 0, max: 255, bits: 8 })
    expect(Q.boostTicks).toEqual({ min: 0, max: 127, bits: 7 })
    expect(Q.respawnTicks).toEqual({ min: 0, max: 127, bits: 7 })
    expect(Q.lap).toEqual({ min: 0, max: 7, bits: 3 })
    expect(Q.checkpointIdx).toEqual({ min: 0, max: 63, bits: 6 })
    expect(Q.item).toEqual({ min: 0, max: 15, bits: 4 })
    expect(Q.surface).toEqual({ min: 0, max: 3, bits: 2 })
    expect(Q.driftPacked).toEqual({ min: 0, max: 3, bits: 2 })
    expect(Q.airborne).toEqual({ min: 0, max: 1, bits: 1 })
    expect(Q.shielded).toEqual({ min: 0, max: 1, bits: 1 })
    expect(Q.connected).toEqual({ min: 0, max: 1, bits: 1 })
    expect(Q.playerId).toEqual({ min: 0, max: 7, bits: 3 })
  })

  it('sums to 177 bits per kart when position/velocity are counted 3x each', () => {
    const single = ALL_FIELDS.reduce((sum, f) => sum + Q[f].bits, 0)
    // position and velocity are one Q entry each but three wire fields each (x,y,z)
    const total = single + 2 * Q.position.bits + 2 * Q.velocity.bits
    expect(total).toBe(177)
  })

  it('is deeply frozen: the table and every field object inside it', () => {
    expect(Object.isFrozen(Q)).toBe(true)
    expect(Object.isFrozen(Q.position)).toBe(true)
    expect(Object.isFrozen(Q.playerId)).toBe(true)
  })
})

describe('EPS', () => {
  it('has exactly the same 19 keys as Q', () => {
    expect(Object.keys(EPS).sort()).toEqual(Object.keys(Q).sort())
  })

  it('matches contract §4 epsilon for every continuous (band-compared) field', () => {
    expect(EPS.position).toBe(0.05)
    expect(EPS.velocity).toBe(0.05)
    expect(EPS.heading).toBe(0.0025)
    expect(EPS.angularVelocity).toBe(0.05)
    expect(EPS.driftCharge).toBe(1.5)
    expect(EPS.lapT).toBe(0.002)
  })

  it('is exactly 0 for every exact (Object.is-compared) field', () => {
    const exactFields: QuantFieldName[] = [
      'spinOutTicks', 'invulnTicks', 'boostTicks', 'respawnTicks',
      'lap', 'checkpointIdx', 'item', 'surface', 'driftPacked',
      'airborne', 'shielded', 'connected', 'playerId',
    ]
    for (const f of exactFields) {
      expect(EPS[f]).toBe(0)
    }
  })

  it('is frozen', () => {
    expect(Object.isFrozen(EPS)).toBe(true)
  })

  it('exceeds quantStep for every continuous field - the buzz-prevention invariant', () => {
    // contract §0/§4: an epsilon at or below its field's step means quantisation
    // noise alone triggers a correction every snapshot. This is a basic sanity
    // check at the point of authorship; Task 7 asserts the same inequality
    // mechanically for every field as its own dedicated test.
    const continuousFields: QuantFieldName[] = [
      'position', 'velocity', 'heading', 'angularVelocity', 'driftCharge', 'lapT',
    ]
    for (const f of continuousFields) {
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
 * The 19 named fields of contract §4's per-kart table. `position` and `velocity`
 * are listed once each and reused for x, y and z by whoever encodes them (Task 6).
 * `driftPacked` is the 2-bit combination of KartState's `drift.active` and
 * `drift.dir` (Task 6 owns the packing scheme; this only reserves its width and
 * epsilon). `connected` is the single wire bit contract §4's row `airborne`,
 * `shielded`, `isBot`/`connected` shares between KartState's `isBot` and
 * `connected` fields (decision 1 above) - `isBot` has no Q/EPS entry of its own
 * because it never has its own wire bit.
 */
export type QuantFieldName =
  | 'position' | 'velocity' | 'heading' | 'angularVelocity' | 'driftCharge' | 'lapT'
  | 'spinOutTicks' | 'invulnTicks' | 'boostTicks' | 'respawnTicks'
  | 'lap' | 'checkpointIdx' | 'item' | 'surface' | 'driftPacked'
  | 'airborne' | 'shielded' | 'connected' | 'playerId'

export type QuantTable = Readonly<Record<QuantFieldName, QuantField>>
export type EpsilonTable = Readonly<Record<QuantFieldName, number>>

function qf(min: number, max: number, bits: number): QuantField {
  return Object.freeze({ min, max, bits })
}

/** Contract §4's per-kart table, transcribed field by field. Frozen two levels
 * deep: the table itself and every QuantField inside it. */
export const Q: QuantTable = Object.freeze({
  position: qf(-WORLD_HALF, WORLD_HALF, 16),
  velocity: qf(-64, 64, 12),
  heading: qf(-Math.PI, Math.PI, 12),
  angularVelocity: qf(-16, 16, 10),
  driftCharge: qf(0, 255, 8),
  lapT: qf(0, 1, 10),
  spinOutTicks: qf(0, 255, 8),
  invulnTicks: qf(0, 255, 8),
  boostTicks: qf(0, 127, 7),
  respawnTicks: qf(0, 127, 7),
  lap: qf(0, 7, 3),
  checkpointIdx: qf(0, 63, 6),
  item: qf(0, 15, 4),
  surface: qf(0, 3, 2),
  driftPacked: qf(0, 3, 2),
  airborne: qf(0, 1, 1),
  shielded: qf(0, 1, 1),
  connected: qf(0, 1, 1),
  playerId: qf(0, 7, 3),
})

/** Contract §4's Epsilon column. 0 for every exact/enum field (Object.is-compared,
 * never banded); every continuous field's epsilon exceeds its own quantStep - see
 * the last test in this task's file, and Task 7's exhaustive version of the same
 * check. Do not tune any of these down (contract §0). */
export const EPS: EpsilonTable = Object.freeze({
  position: 0.05,
  velocity: 0.05,
  heading: 0.0025,
  angularVelocity: 0.05,
  driftCharge: 1.5,
  lapT: 0.002,
  spinOutTicks: 0,
  invulnTicks: 0,
  boostTicks: 0,
  respawnTicks: 0,
  lap: 0,
  checkpointIdx: 0,
  item: 0,
  surface: 0,
  driftPacked: 0,
  airborne: 0,
  shielded: 0,
  connected: 0,
  playerId: 0,
})
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `npx vitest run packages/protocol/test/quant.test.ts`

Expected: PASS — 13 passed (4 from `quantStep`/`WORLD_HALF`, 5 from `Q`, 4 from
`EPS`).

---

- [ ] **Step 9: Typecheck and run the whole protocol suite**

Run: `npx tsc --noEmit -p packages/protocol && npx vitest run packages/protocol`

Expected: PASS — no TypeScript errors; `quant.test.ts` 13 passed, plus Task 3's and
Task 4's tests (this task adds no new dependency on either and removes nothing).

- [ ] **Step 10: Commit**

```bash
git add packages/protocol/src/quant.ts packages/protocol/test/quant.test.ts
git commit -m "feat(protocol): quantisation and epsilon tables transcribed from contract §4"
```
