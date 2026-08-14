### Task 7: Wire Round-Trip Bounds and the Epsilon/Step Assertion

**Files:**
- Create: `packages/protocol/test/roundtrip.test.ts`
- No `src` changes. This task adds zero production code — it is a verification
  suite over Tasks 4 (`bits.ts`) and 5 (`quant.ts`), which must both already
  exist when this task runs (they precede it in the contract's module map,
  §3). Neither file exists in the checkout this brief was written against
  (`packages/protocol` does not exist yet at all — confirmed by listing the
  directory), so every claim below about their exports is drawn from the
  locked contract's signatures, never from reading their source.

**Why this task has no RED-then-implement cycle, unlike a feature task:**
Every other task in this plan writes a failing test and then writes the code
that makes it pass. This task's code already exists by the time it runs — the
whole point of §8's "wire round-trip bounds" test is to catch a defect in
`quant.ts`'s frozen `Q`/`EPS` tables, not to drive new code into existence. So
the honest RED prediction here is different in kind from Task 8/9's: either
the suite passes on the first run (the expected, non-suspicious outcome for a
regression-proofing test against already-correct code), or it fails and names
a real defect that must be fixed in `quant.ts`, never here. **Do not weaken
any assertion in this file to make it pass.** That is stated once, here,
because it applies to every step below.

---

**Interfaces:**

- Consumes, contract §3, verbatim (Task 4, `packages/protocol/src/bits.ts`):
  ```ts
  export class BitWriter {
    constructor(buf: Uint8Array)
    reset(): void
    writeBits(value: number, bits: number): void
    writeFloatQ(value: number, min: number, max: number, bits: number): void
    byteLength(): number
  }
  export class BitReader {
    constructor(buf: Uint8Array)
    reset(): void
    readBits(bits: number): number
    readFloatQ(min: number, max: number, bits: number): number
  }
  ```
  Used here by constructing a fresh instance per buffer and reading/writing
  immediately — `reset()` is assumed to exist for reusing one instance across
  multiple buffers/positions, not as a required first call. If Task 4 turns
  out to require an explicit `reset()` before first use, add `w.reset()` /
  `r.reset()` immediately after each `new BitWriter(...)` / `new
  BitReader(...)` below; nothing else in this file changes.

- Consumes, contract §3, verbatim (Task 5, `packages/protocol/src/quant.ts`):
  ```ts
  export const Q: QuantTable
  export const EPS: EpsilonTable
  export function quantStep(min: number, max: number, bits: number): number
  ```

- **Flagged ambiguity — `QuantTable`/`EpsilonTable`'s per-field shape is not
  specified anywhere in the locked contract.** §3 gives only the top-level
  export names and type names; §4 is explicitly prose ("the table is prose
  and the constants are code" — contract §4, verbatim). This brief therefore
  **pins a required shape** and this is the single biggest risk in this task:

  ```ts
  export interface QuantField { min: number; max: number; bits: number }
  export interface QuantTable {
    position: QuantField
    velocity: QuantField
    heading: QuantField
    angularVelocity: QuantField
    driftCharge: QuantField
    t: QuantField
  }
  export interface EpsilonTable {
    position: number
    velocity: number
    heading: number
    angularVelocity: number
    driftCharge: number
    t: number
  }
  ```

  Two things about this shape are deliberate, not arbitrary:
  1. Only the six **continuous** ("band"-compared) rows of contract §4 get an
     entry. The other eleven rows (`spinOutTicks`, `lap`, `item`, `playerId`,
     …) are marked "exact" / `Object.is` in §4 — they carry no quantization
     noise and therefore need no epsilon at all, so they are not part of
     `EpsilonTable`.
  2. The sixth key is **`t`, not `lap.t` and not `lapT`.** Contract §4's row
     is written `lap.t` because that is where the quantity lives inside
     `KartState` (`k.lap.t`), but contract §3's **locked** `WireKart`
     interface — the actual encode/decode target — declares it as a flat
     sibling field: `lap: number; checkpointIdx: number; t: number`. The
     locked interface is the more authoritative source than the prose table's
     dotted notation, so `t` is used here.
  3. `QuantTable` is required to expose raw `{min, max, bits}` rather than a
     precomputed `step`, deliberately. `quantStep` is exported as its own
     function specifically so a consumer can *recompute* a field's step from
     its raw parameters rather than trust a value someone hand-typed — that
     recomputation is exactly what claim (b) below needs, and it means this
     test never hardcodes a single decimal step or epsilon value copied from
     the prose table.

  If Task 5 ships a different shape, **Step 2's run is where that surfaces**
  (see below) — fix it by editing only the `CONTINUOUS_FIELDS` list and the
  three interfaces at the top of this test file to match `quant.ts`'s real
  exports. Do not touch any numeric assertion to make an import error go
  away.

- Produces: nothing exported. `CONTINUOUS_FIELDS` and `EXACT_FIELDS` below are
  test-local constants.

---

- [ ] **Step 1: Write the test file**

Create `packages/protocol/test/roundtrip.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { BitReader, BitWriter } from '../src/bits'
import { EPS, Q, quantStep } from '../src/quant'
import type { EpsilonTable, QuantTable } from '../src/quant'

/**
 * The six continuous ("band"-compared) fields from the locked contract §4.
 * Keyed to match WireKart's flat field names (§3) — in particular `t`, not
 * `lap.t`, because WireKart declares `t: number` as a sibling of `lap` and
 * `checkpointIdx`, not nested. See this file's task brief for the full
 * reasoning; if `Q`/`EPS` use different keys, edit this list and the two
 * `type` aliases below to match, and nothing else.
 */
const CONTINUOUS_FIELDS: (keyof QuantTable & keyof EpsilonTable)[] = [
  'position',
  'velocity',
  'heading',
  'angularVelocity',
  'driftCharge',
  't',
]

describe('epsilon strictly exceeds step, for every continuous field', () => {
  // Claim (b): epsilon > step, asserted against Q and EPS themselves — never
  // against a decimal copied out of the contract's prose table. `step` is
  // recomputed here via the real `quantStep`, from Q's own min/max/bits, so
  // this catches a wrong step in Q just as readily as a wrong epsilon in EPS.
  for (const field of CONTINUOUS_FIELDS) {
    it(`EPS.${field} > quantStep(Q.${field})`, () => {
      const { min, max, bits } = Q[field]
      const step = quantStep(min, max, bits)
      expect(EPS[field]).toBeGreaterThan(step)
    })
  }
})

describe('that invariant actually has teeth', () => {
  // The off-by-one-in-the-safe-direction check. This does NOT read the real
  // EPS — it proves that the comparison technique above (`toBeGreaterThan`,
  // i.e. strict `>`) is the thing doing the protecting. A `toBeGreaterThan`
  // check is exactly what would go red if a field's epsilon were ever tuned
  // down to equal its step: `x > x` is false for every x. This is the case
  // this whole task exists to prevent — contract §0: "Do not tune an epsilon
  // downward to make a test pass; that test is the one protecting the player
  // from a buzzing kart."
  it('an epsilon tuned exactly equal to its step fails the invariant', () => {
    for (const field of CONTINUOUS_FIELDS) {
      const step = quantStep(Q[field].min, Q[field].max, Q[field].bits)
      const badEpsilon = step // the forbidden tuning, stood in for directly
      expect(badEpsilon).not.toBeGreaterThan(step)
    }
  })

  // And the mirror image: a `>=` comparison (the wrong tool) would let that
  // exact tuning through. This does not exercise src code either — it is
  // documentation-by-test of why the assertions above use `toBeGreaterThan`
  // and not `toBeGreaterThanOrEqual`.
  it('demonstrates why the check above must use > and not >=', () => {
    for (const field of CONTINUOUS_FIELDS) {
      const step = quantStep(Q[field].min, Q[field].max, Q[field].bits)
      const badEpsilon = step
      expect(badEpsilon >= step).toBe(true) // a >= check would wrongly pass this
      expect(badEpsilon > step).toBe(false) // the real check correctly rejects it
    }
  })
})

describe('round trip stays within one quantization step', () => {
  // Claim (a): decode(encode(x)) differs from x by less than that field's
  // step. min/max/bits always come from Q, never from a literal, so this
  // exercises whatever quantization Task 5 actually shipped.
  for (const field of CONTINUOUS_FIELDS) {
    it(`${field}: min, max, midpoint, and an off-center sample`, () => {
      const { min, max, bits } = Q[field]
      const step = quantStep(min, max, bits)
      const samples = [min, max, (min + max) / 2, min + (max - min) * 0.137]
      for (const value of samples) {
        const buf = new Uint8Array(8)
        const w = new BitWriter(buf)
        w.writeFloatQ(value, min, max, bits)
        const r = new BitReader(buf)
        const decoded = r.readFloatQ(min, max, bits)
        // The true bound for a linear quantizer is step/2; asserting the
        // full step leaves comfortable headroom against float rounding right
        // at a bucket boundary, while still matching spec §8's wording
        // ("differs from x by less than each field's stated quantization
        // step") via a strict less-than.
        expect(Math.abs(decoded - value)).toBeLessThan(step)
      }
    })
  }
})

describe('continuous fields survive at each range endpoint', () => {
  for (const field of CONTINUOUS_FIELDS) {
    it(`${field} at Q.${field}.min and Q.${field}.max`, () => {
      const { min, max, bits } = Q[field]
      const step = quantStep(min, max, bits)
      for (const value of [min, max]) {
        const buf = new Uint8Array(8)
        const w = new BitWriter(buf)
        w.writeFloatQ(value, min, max, bits)
        const decoded = new BitReader(buf).readFloatQ(min, max, bits)
        expect(Math.abs(decoded - value)).toBeLessThan(step)
      }
    })
  }
})

/**
 * Representative exact (Object.is-compared) integer field widths, taken
 * directly from contract §4's Bits column. These do not go through
 * writeFloatQ/readFloatQ or through Q/EPS at all — they are raw bitfields,
 * exact by construction, and this section proves BitWriter/BitReader hold
 * that promise at the specific widths the wire format actually uses.
 */
const EXACT_FIELDS: { name: string; bits: number }[] = [
  { name: 'spinOutTicks', bits: 8 },
  { name: 'invulnTicks', bits: 8 },
  { name: 'boostTicks', bits: 7 },
  { name: 'respawnTicks', bits: 7 },
  { name: 'lap', bits: 3 },
  { name: 'checkpointIdx', bits: 6 },
  { name: 'item', bits: 4 },
  { name: 'surface', bits: 2 },
  { name: 'playerId', bits: 3 },
]

describe('integer fields round-trip exactly, via Object.is', () => {
  for (const { name, bits } of EXACT_FIELDS) {
    it(`${name} (${bits} bits): 0, its max, and a mid value`, () => {
      const max = 2 ** bits - 1
      const mid = Math.floor(max / 3)
      for (const value of [0, max, mid]) {
        const buf = new Uint8Array(8)
        const w = new BitWriter(buf)
        w.writeBits(value, bits)
        const decoded = new BitReader(buf).readBits(bits)
        expect(Object.is(decoded, value)).toBe(true)
      }
    })
  }

  it('normalises -0 to +0', () => {
    const buf = new Uint8Array(8)
    const w = new BitWriter(buf)
    w.writeBits(-0, 8)
    const decoded = new BitReader(buf).readBits(8)
    expect(Object.is(decoded, -0)).toBe(false)
    expect(Object.is(decoded, 0)).toBe(true)
  })
})
```

- [ ] **Step 2: Run the suite**

Run: `npx vitest run packages/protocol/test/roundtrip.test.ts`

There are three distinct possible outcomes here, and they mean different
things — read the message before acting:

1. **All tests PASS.** This is the expected, unremarkable outcome. This task
   adds no production code; a clean pass means Tasks 4 and 5 shipped a
   `bits.ts`/`quant.ts` that satisfies the contract. Proceed to Step 3.
2. **`TypeError: Cannot read properties of undefined (reading 'min')`** (or
   `'bits'`, `'max'`, or a field name in the error stack) — this is a Vitest
   /esbuild runtime error, not a compile-time one (esbuild's SSR transform
   does not check named exports statically), and it means the assumed
   `QuantTable`/`EpsilonTable` shape in this file's header does not match
   what `quant.ts` actually exports. Open `packages/protocol/src/quant.ts`,
   read `Q`'s and `EPS`'s real property names, and edit only
   `CONTINUOUS_FIELDS` and the two interface aliases at the top of this test
   file to match. Do not change any `expect(...)` line.
3. **An `AssertionError` naming a specific field** (e.g. `EPS.driftCharge >
   quantStep(...)` fails, or a round-trip/endpoint test for `heading`
   exceeds its step) — this is a real defect in `quant.ts`'s `Q` or `EPS`
   values. The fix belongs in `quant.ts`. Do not weaken this test to pass;
   per contract §0, that would defeat the one thing protecting the player
   from a visibly buzzing kart.

- [ ] **Step 3: Typecheck and run the full protocol suite**

Run: `npx tsc --noEmit -p packages/protocol && npx vitest run packages/protocol`

Expected: zero type errors, every protocol test green (including this file's
~30 test cases: 6 epsilon-invariant checks, 2 teeth-demonstration checks, 6
round-trip checks with 4 samples each, 6 endpoint checks, 9 exact-field
checks with 3 samples each, plus the `-0` normalisation check).

- [ ] **Step 4: Commit**

```bash
git add packages/protocol/test/roundtrip.test.ts
git commit -m "test(protocol): wire round-trip bounds and the epsilon/step invariant

Two distinct claims, kept distinct per spec §8: (a) decode(encode(x))
for every continuous field stays within that field's quantization step,
asserted at each field's min, max, midpoint and an off-center sample;
(b) epsilon strictly exceeds step for every field in EPS, asserted
mechanically against Q and EPS's own values via quantStep, never
against the contract's prose table.

A dedicated 'teeth' check proves (b) isn't vacuous: it shows that an
epsilon tuned exactly equal to its step - the forbidden tuning contract
\$0 warns about - fails the same toBeGreaterThan comparison the real
invariant test uses. Integer (Object.is-compared) fields are checked
separately at their exact \$4 bit widths, including a -0-normalises-to-
+0 case, independent of Q/EPS entirely.

This task adds no production code - it is a regression suite over
Tasks 4 and 5's already-frozen bits.ts/quant.ts. A failure here names a
real defect in quant.ts; per contract \$0, it must never be fixed by
weakening this test."
```
