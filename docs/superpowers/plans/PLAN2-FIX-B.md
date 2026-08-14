# Plan 2 Fix Pass B — Tasks 7–12

Fixes applied against `docs/superpowers/plans/parts/plan2-task-07-*.md` through
`plan2-task-12-*.md`, per findings in `PLAN2-AUDIT-A.md`, `-B.md`, `-C.md` that
name tasks 7–12, checked against the locked
`docs/superpowers/plans/2026-08-14-tapkart-plan2-contract.md`.

Tasks 8 (`checkpoint.ts`), 9 (`events.ts`), and 10 (`input.ts`) had **no
findings** against them in any of the three audits and were re-read in full
against the current contract with no changes required — no edit was made to
their files.

---

## Task 7 (`plan2-task-07-roundtrip-bounds.md`)

### Finding: stale "flagged ambiguity" framing (Audit A, BD-4; implicit in Audit C's premises table)

The brief's Interfaces block described `QuantTable`/`EpsilonTable`'s six-key,
`t`-keyed shape as an ambiguity this brief was resolving on its own authority.
The current (amended) contract §3 now locks that exact shape verbatim — the
brief's own framing was simply stale, written before that amendment landed.

**Change:** rewrote the block to state the shape is contract §3 verbatim,
quoting §4's own justifying prose for each of the three design points (six
continuous fields only, key is `t` not `lap.t`/`lapT`, raw `{min,max,bits}`
not a precomputed step) instead of presenting them as this brief's reasoning.

### Finding: Step 2's contingency clause would launder a Task 5 contract violation (Audit A, BD-4)

Both the Interfaces block and Step 2's outcome-2 instructions told whoever ran
this task, on a shape mismatch, to "edit only `CONTINUOUS_FIELDS` and the two
interface aliases... to match `quant.ts`'s real exports" — silently absorbing
a Task 5 defect (BD-1/BD-2 in Audit A: Task 5 as originally drafted shipped a
19-key `Record` keyed `lapT`, not the locked 6-key interface keyed `t`)
instead of flagging it.

**Change:** rewrote both the Interfaces block's contingency note and Step 2's
outcome-2 text to say explicitly: a shape mismatch is a Task 5 defect, not an
ambiguity for this file to resolve; fix `quant.ts`, never edit
`CONTINUOUS_FIELDS`/the interface aliases to match a nonconforming
`quant.ts`. Also found and fixed the same stale instruction repeated a third
time, in the in-file code comment above `CONTINUOUS_FIELDS` itself (missed by
the audits, caught during verification) — it told a future reader to "edit
this list... and nothing else" on a key mismatch, directly contradicting the
policy just corrected two paragraphs above it in the same file.

### Finding: the "that invariant actually has teeth" tests cannot fail (Audit C, "Tests that cannot fail" #4)

```ts
const badEpsilon = step
expect(badEpsilon).not.toBeGreaterThan(step)          // asserts !(x > x)
expect(badEpsilon >= step).toBe(true)                 // asserts a JS operator fact
expect(badEpsilon > step).toBe(false)                 // asserts a JS operator fact
```

Neither test read `EPS` or `Q` at all — both asserted properties of
JavaScript's comparison operators against a self-invented local, and neither
could go red for any content of `quant.ts`. This is exactly the failure mode
the task brief's own header warns about ("Do not weaken any assertion... that
is stated once, here, because it applies to every step below") applied to the
control meant to prove the real check has teeth.

**Change (rewrite, not reword, per the parent task's instructions):**
factored the mechanical check into a named function
`epsilonExceedsStep(field, eps, q)`, then rewrote the block to three real
tests:
1. a sanity check that the real `EPS`/`Q` pass the extracted check (confirms
   the helper agrees with the inline check in the first `describe` block),
2. the actual control — build `badEps = { ...EPS, [field]: step }` (one
   field's epsilon set to exactly its own step, the forbidden tuning named in
   contract §0) and assert `epsilonExceedsStep(field, badEps, Q) === false`.
   This genuinely fails if `epsilonExceedsStep`'s `>` is ever loosened to
   `>=`, because then `badEps[field] >= step` would be true and the function
   would wrongly return `true`.
3. the `>` vs `>=` mirror case, now run against the same perturbed `badEps`
   table (real `Q`, one deliberately mistuned `EPS` value) instead of two
   invented numbers.

Confirmed post-fix: the block still checks exactly the six `CONTINUOUS_FIELDS`
entries, every step is derived via `quantStep` (never hardcoded), and it
includes a case (test 2 above) that fails if an epsilon is set equal to its
step — satisfying the parent task's specific instruction for Task 7.

### Numeric: test count in Step 3 and the commit message

The "teeth" block grew from 2 tests to 3. Recomputed total: 6 (epsilon
invariant) + 3 (teeth, was 2) + 6 (round trip) + 6 (endpoint) + 9 (exact
fields) + 1 (`-0` normalisation) = **31**, not 30. Updated Step 3's expected
count and the commit message body to describe the perturbed-table technique
accurately.

No numeric epsilon, step, or bit-width value in Task 7 was itself wrong —
Audit A confirmed the six decimal constants already matched contract §4
exactly; only the *shape* and the *teeth tests'* logic needed fixing.

---

## Task 11 (`plan2-task-11-net-scaffold.md`)

### Finding: `net`'s barrel left empty and `ChannelName` reached by a forbidden relative path (Audit B, B6; Audit C, Blocking #6, interface pairs 21/51, contract-drift table)

The brief's premise — "`packages/protocol/src/index.ts` is still the empty
`export {}` stub" and "the contract's module map lists
`packages/protocol/src/index.ts` as [Task 18]" — is false against the current
contract, which states plainly: "The barrel exists from Task 3, not Task 18
... `net` imports `@tapkart/protocol`, always," and separately, "Task 11's
scaffold creates it [`net/src/index.ts`] re-exporting `./transport`, Task 18
widens it." The brief as written left `net/src/index.ts` as `export {}`
through the whole task and reached `ChannelName` via
`'../../protocol/src/types'`, which contract §3 names as the specific
violation to avoid ("punches through the package boundary, bypasses the
`exports` map, and would survive into Plan 3").

**Change:**
- Rewrote the Interfaces block's stale reasoning (both the `ChannelName`
  consumption bullet and the `net/src/index.ts` production bullet).
- Changed `transport.ts`'s and `transport.test.ts`'s `ChannelName` import
  from `'../../protocol/src/types'` to `'@tapkart/protocol'`.
- Restructured the back half of the task into a proper two-stage RED/GREEN,
  since two independent defects were being fixed by one file
  (`transport.ts` missing, and `net`'s barrel not yet re-exporting it):
  - Step 7 now also imports `Transport` a second time, aliased
    `BarrelTransport`, from `'../src/index'`, and adds a third test asserting
    it is structurally identical to the direct import.
  - Step 8's RED is now two diagnostics (`TS2307` for the missing
    `transport.ts`, `TS2305` for the barrel not yet exporting `Transport`),
    not one.
  - Step 9 (implement `transport.ts`) resolves only the `TS2307` half; added
    a checkpoint confirming exactly the `TS2305` half remains.
  - New Step 10 widens `net/src/index.ts` from `export {}` to
    `export * from './transport'`, resolving the remaining diagnostic. Old
    Step 10 ("run both checks") was folded into this step's own
    verification; Steps 11 (full sanity check) and 12 (commit) were
    renumbered accordingly with no gap or duplicate (verified by grep).
- This mirrors, deliberately, the same `tsc`-not-vitest RED rule the
  contract already establishes for types-only modules (§3) and that Task 3's
  brief (read for reference, not edited — outside my territory) already
  applies to `protocol/src/types.ts`: a type-only barrel widening has no
  runtime signature vitest can meaningfully red on, so its RED must come
  from `tsc`.

### Numeric: "477 from Plan 1 plus this task's 4"

Audit C flagged this as non-blocking/cosmetic, but it is in my territory and
now also wrong on two counts: Tasks 1–2 (which precede Task 11) already
change `packages/sim`'s test count from Plan 1's 477, and Step 7 now adds a
third test to `transport.test.ts`, so this task adds 5 tests (2 + 3), not 4.
Rather than hardcode a new absolute figure that would also drift as soon as
another task's count changes, rewrote the expectation as relative: "confirm
the total increases by exactly 5... rather than trusting one absolute number
stated here."

---

## Task 12 (`plan2-task-12-loopback.md`)

### Finding: `ChannelName` reached by the same forbidden relative path (Audit B, B6; Audit C, Blocking #6)

Same defect as Task 11, independently drafted: `'../../protocol/src/types'`
from `loopback.ts`, justified by the same stale "protocol's barrel is
deferred to Task 18" premise.

**Change:** rewrote the Interfaces block's `ChannelName` bullet and changed
`loopback.ts`'s import from `'../../protocol/src/types'` to
`'@tapkart/protocol'`. No RED/GREEN restructuring was needed here (unlike
Task 11) because `ChannelName` is consumed, not re-exported, by this task —
fixing the import path alone is sufficient; `packages/net/package.json`
(Task 11) already declares the `@tapkart/protocol` dependency, so nothing
else needed updating.

### Verified, not changed: the statistical loopback tests

The parent task's brief specifically flagged this as a risk area ("statistical
assertions... need a stated sample size and a literal tolerance band — never
'approximately'"). Checked the loss-rate test directly: it already states
`N = 20000` and asserts `Math.abs(observedLossRate - 0.05)).toBeLessThan(0.01)`
— a literal sample size and a literal tolerance band, no "approximately"
anywhere in the file. No change needed.

---

## Not fixed, and why

- **Audit C non-blocking observation #11** (Task 12 compiling
  `track-fixtures.ts` under `packages/net`'s tsconfig via a relative import
  makes `include` not fully describe what `tsc -p packages/net` reads) —
  left as-is. This is normal, correct TypeScript behavior (imported files are
  type-checked regardless of a project's `include` roots); the audit itself
  labels it non-blocking, and there is no available fix that wouldn't
  require exporting sim's test fixtures from its production barrel, which
  contract §6 explicitly forbids ("Do not 'fix' this by widening
  `@tapkart/sim`'s exports to publish test fixtures").
- **Exact absolute test counts for `packages/protocol` at the point Task 11
  runs** (needed to state a fully precise "N tests before, N+5 after" in
  Task 11's sanity-check step) — not computed, because it depends on the
  exact test counts Tasks 4, 5, and 6 ship (outside my territory, being
  fixed by other agents concurrently). Rewrote the affected text as a
  relative delta (see above) rather than guessing an absolute figure that
  could be wrong regardless of what I chose.
- **Whether Task 5 will actually ship the six-key `t`-keyed shape Task 7 now
  assumes without contingency** — outside my territory (Task 5 belongs to
  the agent fixing tasks 1–6). Task 7 is now written correctly against the
  contract and will fail loudly and specifically (naming a Task 5 defect) if
  Task 5 does not conform, rather than silently accommodating it.

---

## Files touched

- `docs/superpowers/plans/parts/plan2-task-07-roundtrip-bounds.md`
- `docs/superpowers/plans/parts/plan2-task-11-net-scaffold.md`
- `docs/superpowers/plans/parts/plan2-task-12-loopback.md`

No files outside `docs/superpowers/plans/parts/plan2-task-{07,08,09,10,11,12}-*.md`
and this report were modified. No scratch files were left behind.
