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

- **`QuantTable`/`EpsilonTable`'s per-field shape is locked by contract §3**,
  not merely assumed by this brief. (An earlier draft of this brief was
  written before that amendment landed and described the shape below as an
  unresolved ambiguity this brief was pinning on its own authority. That
  framing is stale and is corrected here — the shape is no longer this
  brief's own choice, it is the contract's.)

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

  This is contract §3 verbatim. Two things about the shape are worth stating
  explicitly, both taken directly from contract §4 rather than inferred:
  1. Only the six **continuous** ("band"-compared) rows get an entry. The
     other eleven rows (`spinOutTicks`, `lap`, `item`, `playerId`, …) are
     marked "exact" / `Object.is` in §4 — they carry no quantization noise
     and therefore need no epsilon at all: "giving them one would invite
     someone to compare an integer with a tolerance" (contract §4, verbatim).
  2. The sixth key is **`t`, not `lap.t` and not `lapT`.** Contract §4 states
     this outright: "The key is `t`, not `lap.t`, matching the flat
     `WireKart` interface in §3." Contract §3's `WireKart` declares it as a
     flat sibling field, `lap: number; checkpointIdx: number; t: number`, not
     nested the way it lives inside `KartState` (`k.lap.t`).
  3. `QuantTable` deliberately exposes raw `{min, max, bits}` rather than a
     precomputed `step` — contract §4, verbatim: "`QuantTable` deliberately
     exposes raw `{min, max, bits}` rather than a precomputed `step`, so
     `quantStep` can recompute it and Task 7's `epsilon > step` assertion is
     checking the constants against each other rather than against a cached
     number that could drift." That recomputation is exactly what claim (b)
     below needs, and it means this test never hardcodes a single decimal
     step or epsilon value copied from the prose table.

  Task 5 owns `quant.ts` and must ship exactly this shape. **If Step 2's run
  below shows otherwise, that is a Task 5 defect, not an ambiguity for this
  test file to absorb** — do not edit `CONTINUOUS_FIELDS` or the interface
  aliases here to match a nonconforming `quant.ts`; report it and stop
  instead. (An earlier version of this brief instructed exactly that silent
  absorption — see Step 2 below — which would launder a real contract
  violation into a passing test rather than catching it. That instruction is
  withdrawn.)

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
 * `checkpointIdx`, not nested. This shape is contract §3, not a choice this
 * file makes: if `Q`/`EPS` use different keys, that is a defect in
 * quant.ts's Task 5, not a cue to edit this list to match it. See this
 * file's task brief for the full reasoning.
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

/**
 * The mechanical check under test, factored out so it can be run against
 * both the real tables and a deliberately mistuned copy. This is the same
 * technique the first describe block above uses inline (`EPS[field] >
 * quantStep(...)`); pulling it into a function is what lets "that invariant
 * actually has teeth" below prove the check rejects a bad tuning, rather
 * than merely restating `!(x > x)` against numbers nobody read from EPS/Q.
 */
function epsilonExceedsStep(
  field: keyof QuantTable & keyof EpsilonTable,
  eps: EpsilonTable,
  q: QuantTable,
): boolean {
  const { min, max, bits } = q[field]
  return eps[field] > quantStep(min, max, bits)
}

describe('that invariant actually has teeth', () => {
  // Sanity: the extracted check agrees with the real EPS/Q for every field,
  // before trusting it to catch a bad tuning below.
  it('the real EPS/Q tables pass the mechanical check for every field', () => {
    for (const field of CONTINUOUS_FIELDS) {
      expect(epsilonExceedsStep(field, EPS, Q)).toBe(true)
    }
  })

  // The actual control. Builds a copy of EPS with exactly one field's
  // epsilon set equal to its own step -- the forbidden tuning contract §0
  // names by name ("Do not tune an epsilon downward to make a test pass;
  // that test is the one protecting the player from a buzzing kart") -- and
  // asserts the mechanical check rejects it. This reads the real Q (for
  // min/max/bits) and only perturbs EPS, so unlike a version that just
  // restates `!(x > x)` against invented numbers, it genuinely fails if
  // epsilonExceedsStep is ever loosened from `>` to `>=`.
  it('an epsilon tuned exactly equal to its step fails the mechanical check, field by field', () => {
    for (const field of CONTINUOUS_FIELDS) {
      const step = quantStep(Q[field].min, Q[field].max, Q[field].bits)
      const badEps: EpsilonTable = { ...EPS, [field]: step }
      expect(epsilonExceedsStep(field, badEps, Q)).toBe(false)
    }
  })

  // The mirror image, against the same perturbed table rather than invented
  // numbers: a `>=` comparison (the wrong tool) would wrongly accept the
  // exact forbidden tuning `>` correctly rejects above.
  it('demonstrates why the check must use > and not >=, against the same perturbed table', () => {
    for (const field of CONTINUOUS_FIELDS) {
      const step = quantStep(Q[field].min, Q[field].max, Q[field].bits)
      const badEps: EpsilonTable = { ...EPS, [field]: step }
      const recomputedStep = quantStep(Q[field].min, Q[field].max, Q[field].bits)
      expect(badEps[field] >= recomputedStep).toBe(true) // the wrong tool wrongly passes this
      expect(badEps[field] > recomputedStep).toBe(false) // the real check correctly rejects it
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
   does not check named exports statically), and it means `quant.ts` does not
   export the six-key, `t`-keyed `QuantTable`/`EpsilonTable` shape contract
   §3 locks. **This is a Task 5 defect, not an ambiguity for this file to
   resolve.** Open `packages/protocol/src/quant.ts`, confirm which keys `Q`/
   `EPS` actually carry, and fix `quant.ts` to match contract §3 — do not
   edit `CONTINUOUS_FIELDS` or the interface aliases here to match a
   nonconforming `quant.ts`, and do not change any `expect(...)` line. (An
   earlier version of this step instructed exactly that: edit this file's
   `CONTINUOUS_FIELDS`/interfaces to match whatever `quant.ts` happened to
   export. That instruction would silently launder a real contract violation
   into a passing test and is withdrawn.)
3. **An `AssertionError` naming a specific field** (e.g. `EPS.driftCharge >
   quantStep(...)` fails, or a round-trip/endpoint test for `heading`
   exceeds its step) — this is a real defect in `quant.ts`'s `Q` or `EPS`
   values. The fix belongs in `quant.ts`. Do not weaken this test to pass;
   per contract §0, that would defeat the one thing protecting the player
   from a visibly buzzing kart.

- [ ] **Step 3: Typecheck and run the full protocol suite**

Run: `npx tsc --noEmit -p packages/protocol && npx vitest run packages/protocol`

Expected: zero type errors, every protocol test green (including this file's
~31 test cases: 6 epsilon-invariant checks, 3 teeth-demonstration checks, 6
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

A dedicated 'teeth' block proves (b) isn't vacuous: it perturbs a copy
of EPS, setting one field's epsilon equal to its own step - the
forbidden tuning contract \$0 warns about - and shows the same
mechanical epsilonExceedsStep check the real invariant test uses
rejects it, plus a mirror case showing why the check must use strict >
and not >=. Integer (Object.is-compared) fields are checked separately
at their exact \$4 bit widths, including a -0-normalises-to-+0 case,
independent of Q/EPS entirely.

This task adds no production code - it is a regression suite over
Tasks 4 and 5's already-frozen bits.ts/quant.ts. A failure here names a
real defect in quant.ts; per contract \$0, it must never be fixed by
weakening this test."
```
