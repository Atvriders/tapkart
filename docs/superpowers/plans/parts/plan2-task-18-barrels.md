### Task 18: Public barrel exports for `packages/protocol` and `packages/net`

**Files:**
- Create: `packages/protocol/src/index.ts`
- Test: `packages/protocol/test/barrel.test.ts`
- Create: `packages/net/src/index.ts`
- Test: `packages/net/test/barrel.test.ts`

**Why two packages in one task.** The locked contract assigns both `packages/protocol/src/index.ts`
(§3) and `packages/net/src/index.ts`(§5) to Task 18 — the same task number, landing dead last in
Plan 2's sequence, after every other `protocol` and `net` task. This is why Tasks 3–17, including
this plan's own Tasks 16–17, cross-import `protocol`'s modules by relative path
(`../../protocol/src/<module>`) instead of `@tapkart/protocol`: the bare specifier resolves only to
whatever `packages/protocol/package.json`'s `"exports"` map points `"."` at, and until this task
runs that file exports nothing beyond what an earlier task may have stubbed. This task closes that
gap for both packages at once, exactly as Plan 1's Task 18 did for `@tapkart/sim`. It adds no new
behaviour and changes no signature.

**Assumption stated up front, since neither file's scaffolding task is this one:** this task assumes
`packages/protocol/package.json` and `packages/net/package.json` already exist (created by Tasks 3
and 11 respectively) with `"exports": { ".": "./src/index.ts" }`, mirroring
`packages/sim/package.json` exactly. If either is missing that field, Step 5 or Step 13 below (the
"resolves through the package entry point" test) fails with a Node resolution error naming the
package, not a missing-export error — that is the tell that this assumption, not this task's own
code, is what needs fixing.

**Facts this task rests on — checked, not assumed, mirroring Plan 1's Task 18 exactly:**

1. `export *` re-exports types and values together and is legal under `isolatedModules`; only a
   named `export { SomeType }` would need `export type`.
2. **`packages/net/src/transport.ts` (Task 11) exports nothing at runtime.** Its only member per the
   locked contract §5 is `export interface Transport { … }` — an interface, erased at compile time.
   `export * from './transport'` is legal and necessary (the module-completeness scan in Step 9
   requires the line to exist) but contributes zero names to the runtime namespace. This is a
   stronger version of Plan 1's `types.ts` exception (which at least had six numeric constants):
   `transport.ts` has nothing runtime at all, and this task's "exports a function from every module"
   test list does not include an entry for it, exactly as Plan 1's excluded `types` from its own list
   for the same underlying reason.
3. **`packages/protocol/src/types.ts` (Task 3) exports exactly one runtime value, `PROTOCOL_VERSION`
   — a constant, not a function.** Everything else in that file (`ChannelName`, `MessageKind`,
   `WireHeader`, `WireKart`, `WireEntity`, `WireSnapshot`, `InputDatagram`) is a type. The barrel test
   below covers `PROTOCOL_VERSION` in its constants check, not its function list, matching Plan 1's
   treatment of `sim`'s `types.ts`.
4. No two `src` modules in either package export the same name, so no `export *` is ambiguous. As in
   Plan 1, this is asserted at runtime rather than trusted: an ambiguous star-export is silently
   dropped from the ESM namespace and importing it by name is a `SyntaxError`.
5. Test fixtures (`packages/net/test/fixtures/net-fixtures.ts`, Task 12) live under `test/`, never
   under `src/`, so neither barrel can leak `makeNetContext`/`makeLossyPair` into the public surface.
   Both barrel tests assert this directly.
6. The barrel imports every module; no module imports its own package's barrel. Adding it therefore
   creates no import cycle in either package. (Cross-package imports — `net` reaching into
   `protocol/src/*` by relative path, per this task's opening paragraph — are unaffected by this
   task and remain relative even after this task ships; nothing in Tasks 11–17 needs to be rewritten
   to use `@tapkart/protocol` now that it exists, and this task does not touch any file outside the
   two `index.ts` files and their two test files.)

**Interfaces:**

Consumes — every `src` module in both packages, by the exact names the locked contract fixes.

```ts
// packages/protocol/src/types.ts                              [Task 3]
export const PROTOCOL_VERSION = 1
// plus types only: ChannelName, MessageKind, WireHeader, WireKart, WireEntity, WireSnapshot, InputDatagram

// packages/protocol/src/bits.ts                                [Task 4]
export class BitWriter { constructor(buf: Uint8Array); reset(): void; writeBits(value: number, bits: number): void; writeFloatQ(value: number, min: number, max: number, bits: number): void; byteLength(): number }
export class BitReader { constructor(buf: Uint8Array); reset(): void; readBits(bits: number): number; readFloatQ(min: number, max: number, bits: number): number }

// packages/protocol/src/quant.ts                               [Task 5]
export const Q: QuantTable
export const EPS: EpsilonTable
export function quantStep(min: number, max: number, bits: number): number

// packages/protocol/src/snapshot.ts                            [Task 6]
export function encodeSnapshot(out: Uint8Array, state: SimState, lastProcessedInputTick: number[]): number
export function decodeSnapshot(buf: Uint8Array, out: WireSnapshot): void
export function applySnapshotToState(snap: WireSnapshot, dst: SimState): void

// packages/protocol/src/checkpoint.ts                          [Task 8]
export function encodeCheckpoint(out: Uint8Array, state: SimState): number
export function decodeCheckpoint(buf: Uint8Array, dst: SimState): void

// packages/protocol/src/events.ts                              [Task 9]
export function encodeEvents(out: Uint8Array, events: AuthEvent[]): number
export function decodeEvents(buf: Uint8Array, out: AuthEvent[]): void

// packages/protocol/src/input.ts                               [Task 10]
export const INPUT_REDUNDANCY = 8
export function encodeInput(out: Uint8Array, playerId: number, intents: Intent[]): number
export function decodeInput(buf: Uint8Array, out: InputDatagram): void

// packages/net/src/transport.ts                                [Task 11]
export interface Transport { /* … */ }   // no runtime export — see verified fact 2 above

// packages/net/src/loopback.ts                                 [Task 12]
export function makeLoopbackPair(opts: LoopbackOptions): { a: Transport; b: Transport; pump(nowMs: number): void }

// packages/net/src/apply.ts                                    [Task 13]
export function applyEvent(ctx: SimContext, state: SimState, ev: AuthEvent): boolean

// packages/net/src/authority.ts                                [Task 14]
export class AuthorityLoop { constructor(ctx: SimContext, state: SimState, t: Transport); tick(): void }

// packages/net/src/client.ts                                   [Task 15]
export class ClientLoop { constructor(ctx: SimContext, playerId: number, t: Transport); tick(localIntent: Intent): void; corrections(): number }

// packages/net/src/shadow.ts                                   [Task 16, this plan]
export const HOST_TIMEOUT_TICKS = 90
export const SNAPSHOT_PERIOD_TICKS = 3
export const SHADOW_HISTORY_TICKS = 24
export const WIRE_TAG_INPUT = 4
export const WIRE_TAG_SNAPSHOT = 5
export const WIRE_TAG_EVENTS = 6
export const WIRE_TAG_CHECKPOINT = 7
export const WIRE_TAG_AUTHORITY_CHANGE = 8
export const AUTHORITY_CHANGE_BYTES = 10
export function encodeAuthorityChange(out: Uint8Array, tick: number, eventSeq: number): number
export function decodeAuthorityChange(buf: Uint8Array): { tick: number; eventSeq: number }
export class ShadowLoop { constructor(ctx: SimContext, state: SimState, t: Transport); tick(): void; promote(tick: number): void }

// packages/net/test/fixtures/net-fixtures.ts                   [Task 12]
export function makeNetContext(isLeader?: boolean): SimContext
export function makeLossyPair(overrides?: Partial<LoopbackOptions>): ReturnType<typeof makeLoopbackPair>
```

Produces:
- `packages/protocol/src/index.ts` re-exporting all seven modules — `types`, `bits`, `quant`,
  `snapshot`, `checkpoint`, `events`, `input` — so `import { encodeSnapshot, Q } from
  '@tapkart/protocol'` works from any workspace package (in particular, `net`'s own future
  refactors, and the eventual `server`/`game` packages).
- `packages/net/src/index.ts` re-exporting all six modules — `transport`, `loopback`, `apply`,
  `authority`, `client`, `shadow` — so `import { ShadowLoop, AuthorityLoop } from '@tapkart/net'`
  works the same way.

---

#### Part A: `packages/protocol`

- [ ] **Step 1: Write the failing test**

Create `packages/protocol/test/barrel.test.ts`:

```ts
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import * as protocol from '../src/index'
import {
  // types [Task 3]
  PROTOCOL_VERSION,
  // bits [Task 4]
  BitReader,
  BitWriter,
  // quant [Task 5]
  EPS,
  Q,
  quantStep,
  // snapshot [Task 6]
  applySnapshotToState,
  decodeSnapshot,
  encodeSnapshot,
  // checkpoint [Task 8]
  decodeCheckpoint,
  encodeCheckpoint,
  // events [Task 9]
  decodeEvents,
  encodeEvents,
  // input [Task 10]
  INPUT_REDUNDANCY,
  decodeInput,
  encodeInput,
} from '../src/index'

// The same three bindings imported straight from their own modules, to prove the barrel re-exports
// them rather than redeclaring anything.
import { quantStep as quantStepDirect } from '../src/quant'
import { encodeSnapshot as encodeSnapshotDirect } from '../src/snapshot'
import { BitWriter as BitWriterDirect } from '../src/bits'

// Every module as a namespace, for the ambiguity scan.
import * as bitsNs from '../src/bits'
import * as checkpointNs from '../src/checkpoint'
import * as eventsNs from '../src/events'
import * as inputNs from '../src/input'
import * as quantNs from '../src/quant'
import * as snapshotNs from '../src/snapshot'
import * as typesNs from '../src/types'

const HERE = dirname(fileURLToPath(import.meta.url)) // packages/protocol/test
const SRC = join(HERE, '..', 'src')

/** The seven modules the barrel must re-export, in the locked contract's SS3 order. */
const BARREL_MODULES = ['types', 'bits', 'quant', 'snapshot', 'checkpoint', 'events', 'input']

const NAMESPACES: [string, object][] = [
  ['types', typesNs],
  ['bits', bitsNs],
  ['quant', quantNs],
  ['snapshot', snapshotNs],
  ['checkpoint', checkpointNs],
  ['events', eventsNs],
  ['input', inputNs],
]

describe('@tapkart/protocol barrel', () => {
  it('exports a named function or class from every module that has one', () => {
    const fns: [string, unknown][] = [
      ['bits.BitWriter', BitWriter],
      ['bits.BitReader', BitReader],
      ['quant.quantStep', quantStep],
      ['snapshot.encodeSnapshot', encodeSnapshot],
      ['snapshot.decodeSnapshot', decodeSnapshot],
      ['snapshot.applySnapshotToState', applySnapshotToState],
      ['checkpoint.encodeCheckpoint', encodeCheckpoint],
      ['checkpoint.decodeCheckpoint', decodeCheckpoint],
      ['events.encodeEvents', encodeEvents],
      ['events.decodeEvents', decodeEvents],
      ['input.encodeInput', encodeInput],
      ['input.decodeInput', decodeInput],
    ]
    // 12 functions/classes across 6 of the 7 modules. The seventh, `types`, exports only
    // PROTOCOL_VERSION (a constant) and types; the constants test below covers it.
    // 2 bits + 1 quant + 3 snapshot + 2 checkpoint + 2 events + 2 input = 12.
    expect(fns).toHaveLength(12)
    for (const [name, fn] of fns) {
      expect(typeof fn, `${name} did not come through the barrel as a function`).toBe('function')
    }
  })

  it('carries the contract constants through unchanged', () => {
    expect(PROTOCOL_VERSION).toBe(1)
    expect(INPUT_REDUNDANCY).toBe(8)
    // Q and EPS's exact internal shape belongs to Task 5, not this task: only existence, frozen-ness
    // and object-ness are asserted here.
    expect(Q).toBeTruthy()
    expect(EPS).toBeTruthy()
    expect(Object.isFrozen(Q)).toBe(true)
    expect(Object.isFrozen(EPS)).toBe(true)
  })

  it("re-exports each module's own binding, not a copy", () => {
    expect(quantStep).toBe(quantStepDirect)
    expect(encodeSnapshot).toBe(encodeSnapshotDirect)
    expect(BitWriter).toBe(BitWriterDirect)
  })

  it('lists every module in src/ exactly once', () => {
    const onDisk = readdirSync(SRC)
      .filter((f) => f.endsWith('.ts') && f !== 'index.ts')
      .map((f) => f.slice(0, -3))
      .sort()
    expect(onDisk).toEqual([...BARREL_MODULES].sort())

    const barrel = readFileSync(join(SRC, 'index.ts'), 'utf8')
    for (const name of BARREL_MODULES) {
      const line = `export * from './${name}'`
      expect(barrel, `barrel is missing ${line}`).toContain(line)
      expect(barrel.split(line).length - 1, `${line} appears more than once`).toBe(1)
    }
  })

  it('has no ambiguous re-export, and forwards every runtime export', () => {
    const owners = new Map<string, string[]>()
    for (const [mod, ns] of NAMESPACES) {
      for (const key of Object.keys(ns)) {
        const list = owners.get(key) ?? []
        list.push(mod)
        owners.set(key, list)
      }
    }
    const clashes = Array.from(owners.entries()).filter(([, mods]) => mods.length > 1)
    expect(clashes).toEqual([])

    for (const [mod, ns] of NAMESPACES) {
      for (const key of Object.keys(ns)) {
        expect(
          Object.prototype.hasOwnProperty.call(protocol, key),
          `${mod}.${key} is not reachable through the barrel`,
        ).toBe(true)
      }
    }
  })

  it('encodes and decodes a snapshot header field through the barrel alone', () => {
    const w = new BitWriter(new Uint8Array(8))
    w.writeBits(42, 8)
    expect(w.byteLength()).toBeGreaterThan(0)
    expect(quantStep(0, 1, 10)).toBeCloseTo(1 / 1023, 6)
  })

  it('resolves through the @tapkart/protocol package entry point', async () => {
    const pkg = await import('@tapkart/protocol')
    expect(pkg.quantStep).toBe(quantStepDirect)
    expect(pkg.PROTOCOL_VERSION).toBe(1)
  })
})
```

- [ ] **Step 2: Run the test and confirm the RED**

Run: `npx vitest run packages/protocol/test/barrel.test.ts`
Expected: FAIL — the file cannot be collected, because `src/index.ts` does not exist yet:
`Failed to resolve import "../src/index" from "packages/protocol/test/barrel.test.ts"`. (If Tasks
3–10 have not landed yet in this working tree either, the failure instead names the first missing
module import, e.g. `../src/bits` — that names a real gap in an earlier task, not this one.)

- [ ] **Step 3: Write the barrel**

Create `packages/protocol/src/index.ts`:

```typescript
// Public barrel for @tapkart/protocol.
//
// packages/protocol/package.json maps "." to this file, so this list IS the package's public
// surface. `net`'s Tasks 11-17 (including this plan's Task 16/17) do NOT use this barrel — it did
// not exist yet when they were written, so they import protocol's modules by relative path instead.
// This barrel exists for code written after this task: any future protocol consumer, and any
// refactor of net's own relative imports into `@tapkart/protocol` should it ever be worth doing.
//
// Ordered as the locked contract's SS3 module map lists them. `export *` carries types and values
// together and is legal under isolatedModules; no two modules below export the same name, so no
// re-export is ambiguous - barrel.test.ts asserts that at runtime rather than leaving it to this
// comment.
export * from './types'
export * from './bits'
export * from './quant'
export * from './snapshot'
export * from './checkpoint'
export * from './events'
export * from './input'
```

- [ ] **Step 4: Run the test and confirm the GREEN**

Run: `npx vitest run packages/protocol/test/barrel.test.ts`
Expected: PASS — 7 tests.

If "has no ambiguous re-export" fails, it prints the clashing name and the two modules that both
export it. The fix is to rename the copy in whichever module does not own the name per the locked
contract's §3 module map — not to drop a line from the barrel.

- [ ] **Step 5: Verify the public surface and run the whole protocol suite**

Run:

```bash
npx vitest run packages/protocol/test/barrel.test.ts -t "resolves through the @tapkart/protocol package entry point"
npx tsc --noEmit -p packages/protocol && npx vitest run packages/protocol
```

Expected: PASS throughout, zero type errors, every `packages/protocol` test green. The only way the
full-suite run can go red from this task's own change is a genuine name clash between two modules
(`TS2308: Module './x' has already exported a member named 'y'`), which Step 4's test would already
have named.

---

#### Part B: `packages/net`

- [ ] **Step 6: Write the failing test**

Create `packages/net/test/barrel.test.ts`:

```ts
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import * as net from '../src/index'
import {
  // loopback [Task 12]
  makeLoopbackPair,
  // apply [Task 13]
  applyEvent,
  // authority [Task 14]
  AuthorityLoop,
  // client [Task 15]
  ClientLoop,
  // shadow [Task 16]
  AUTHORITY_CHANGE_BYTES,
  HOST_TIMEOUT_TICKS,
  SHADOW_HISTORY_TICKS,
  SNAPSHOT_PERIOD_TICKS,
  ShadowLoop,
  WIRE_TAG_AUTHORITY_CHANGE,
  WIRE_TAG_CHECKPOINT,
  WIRE_TAG_EVENTS,
  WIRE_TAG_INPUT,
  WIRE_TAG_SNAPSHOT,
  decodeAuthorityChange,
  encodeAuthorityChange,
} from '../src/index'

import { applyEvent as applyEventDirect } from '../src/apply'
import { ShadowLoop as ShadowLoopDirect } from '../src/shadow'

import * as applyNs from '../src/apply'
import * as authorityNs from '../src/authority'
import * as clientNs from '../src/client'
import * as loopbackNs from '../src/loopback'
import * as shadowNs from '../src/shadow'
import * as transportNs from '../src/transport'

import { makeLossyPair, makeNetContext } from './fixtures/net-fixtures'

const HERE = dirname(fileURLToPath(import.meta.url)) // packages/net/test
const SRC = join(HERE, '..', 'src')

/** The six modules the barrel must re-export, in the locked contract's SS5 order. */
const BARREL_MODULES = ['transport', 'loopback', 'apply', 'authority', 'client', 'shadow']

const NAMESPACES: [string, object][] = [
  ['transport', transportNs],
  ['loopback', loopbackNs],
  ['apply', applyNs],
  ['authority', authorityNs],
  ['client', clientNs],
  ['shadow', shadowNs],
]

describe('@tapkart/net barrel', () => {
  it('exports a named function or class from every module that has one', () => {
    const fns: [string, unknown][] = [
      ['loopback.makeLoopbackPair', makeLoopbackPair],
      ['apply.applyEvent', applyEvent],
      ['authority.AuthorityLoop', AuthorityLoop],
      ['client.ClientLoop', ClientLoop],
      ['shadow.ShadowLoop', ShadowLoop],
      ['shadow.encodeAuthorityChange', encodeAuthorityChange],
      ['shadow.decodeAuthorityChange', decodeAuthorityChange],
    ]
    // 7 functions/classes across 5 of the 6 modules. The sixth, `transport`, exports only the
    // Transport interface (a type, erased at compile time) and has nothing runtime at all - a
    // stronger version of protocol's `types` exception, since transport.ts has no constant either.
    // 1 loopback + 1 apply + 1 authority + 1 client + 3 shadow = 7.
    expect(fns).toHaveLength(7)
    for (const [name, fn] of fns) {
      expect(typeof fn, `${name} did not come through the barrel as a function`).toBe('function')
    }
  })

  it('carries the shadow module constants through unchanged', () => {
    expect(HOST_TIMEOUT_TICKS).toBe(90)
    expect(SNAPSHOT_PERIOD_TICKS).toBe(3)
    expect(SHADOW_HISTORY_TICKS).toBe(24)
    expect(AUTHORITY_CHANGE_BYTES).toBe(10)
    expect([WIRE_TAG_INPUT, WIRE_TAG_SNAPSHOT, WIRE_TAG_EVENTS, WIRE_TAG_CHECKPOINT, WIRE_TAG_AUTHORITY_CHANGE]).toEqual([4, 5, 6, 7, 8])
  })

  it("re-exports each module's own binding, not a copy", () => {
    expect(applyEvent).toBe(applyEventDirect)
    expect(ShadowLoop).toBe(ShadowLoopDirect)
  })

  it('lists every module in src/ exactly once, and no test fixture', () => {
    const onDisk = readdirSync(SRC)
      .filter((f) => f.endsWith('.ts') && f !== 'index.ts')
      .map((f) => f.slice(0, -3))
      .sort()
    expect(onDisk).toEqual([...BARREL_MODULES].sort())

    const barrel = readFileSync(join(SRC, 'index.ts'), 'utf8')
    for (const name of BARREL_MODULES) {
      const line = `export * from './${name}'`
      expect(barrel, `barrel is missing ${line}`).toContain(line)
      expect(barrel.split(line).length - 1, `${line} appears more than once`).toBe(1)
    }

    // net-fixtures.ts lives in test/, so its exports cannot be part of the public surface.
    expect(Object.prototype.hasOwnProperty.call(net, 'makeNetContext')).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(net, 'makeLossyPair')).toBe(false)
  })

  it('has no ambiguous re-export, and forwards every runtime export', () => {
    const owners = new Map<string, string[]>()
    for (const [mod, ns] of NAMESPACES) {
      for (const key of Object.keys(ns)) {
        const list = owners.get(key) ?? []
        list.push(mod)
        owners.set(key, list)
      }
    }
    const clashes = Array.from(owners.entries()).filter(([, mods]) => mods.length > 1)
    expect(clashes).toEqual([])

    for (const [mod, ns] of NAMESPACES) {
      for (const key of Object.keys(ns)) {
        expect(
          Object.prototype.hasOwnProperty.call(net, key),
          `${mod}.${key} is not reachable through the barrel`,
        ).toBe(true)
      }
    }
  })

  it('drives a ShadowLoop through the barrel alone', () => {
    const ctx = makeNetContext(false)
    const { createState } = require('@tapkart/sim') as typeof import('@tapkart/sim')
    const state = createState(ctx, 0x1, [0, 1, 2, 3, 4, 5, 6, 7])
    const shadow = new ShadowLoop(ctx, state, {
      send() {}, broadcast() {}, onMessage() {}, onPeerLost() {}, peers: () => [], close() {},
    })
    shadow.tick()
    expect(state.tick).toBe(1)
  })

  it('resolves through the @tapkart/net package entry point', async () => {
    const pkg = await import('@tapkart/net')
    expect(pkg.applyEvent).toBe(applyEventDirect)
    expect(pkg.HOST_TIMEOUT_TICKS).toBe(90)
  })
})
```

- [ ] **Step 7: Run the test and confirm the RED**

Run: `npx vitest run packages/net/test/barrel.test.ts`
Expected: FAIL — `Failed to resolve import "../src/index" from "packages/net/test/barrel.test.ts"`.

- [ ] **Step 8: Write the barrel**

Create `packages/net/src/index.ts`:

```typescript
// Public barrel for @tapkart/net.
//
// packages/net/package.json maps "." to this file. Ordered as the locked contract's SS5 module map
// lists them. `transport` contributes nothing at runtime (Transport is an interface only) but the
// export line is still required — barrel.test.ts's module-completeness scan checks for the line
// itself, not for anything it produces.
export * from './transport'
export * from './loopback'
export * from './apply'
export * from './authority'
export * from './client'
export * from './shadow'
```

- [ ] **Step 9: Run the test and confirm the GREEN**

Run: `npx vitest run packages/net/test/barrel.test.ts`
Expected: PASS — 7 tests.

- [ ] **Step 10: Verify the public surface and run the whole net suite**

Run:

```bash
npx vitest run packages/net/test/barrel.test.ts -t "resolves through the @tapkart/net package entry point"
npx tsc --noEmit -p packages/net && npx vitest run packages/net
```

Expected: PASS throughout, zero type errors, every `packages/net` test green — including this
plan's Task 16 (`shadow.test.ts`, 15 tests) and Task 17 (5 integration tests across ~5400 ticks).

---

- [ ] **Step 11: Full workspace verification**

Run: `npm run typecheck && npx vitest run`
Expected: PASS across every package — `sim` (477+ tests, untouched by this plan), `protocol`, and
`net`. This is the first point in Plan 2 where all three packages are typechecked and tested
together through their public barrels, since nothing before this task exercised `@tapkart/protocol`
or `@tapkart/net` as bare specifiers.

- [ ] **Step 12: Commit**

```bash
git add packages/protocol/src/index.ts packages/protocol/test/barrel.test.ts \
        packages/net/src/index.ts packages/net/test/barrel.test.ts
git commit -m "feat(protocol,net): add public barrel exports for both packages

packages/protocol/src/index.ts re-exports all seven modules (types, bits,
quant, snapshot, checkpoint, events, input); packages/net/src/index.ts
re-exports all six (transport, loopback, apply, authority, client,
shadow). Neither package was reachable via its bare specifier before this
task, which is why every net task up to and including this plan's own
Task 16/17 imports protocol's modules by relative path instead.

Both barrel tests import one named export from each module through the
barrel, pin the contract constants, prove each barrel forwards its
modules' own bindings rather than copies, check the module list against
src/ so a future module cannot be forgotten, scan for ambiguous
re-exports, confirm neither test-only fixture module leaks into the
public surface, and resolve the bare @tapkart/protocol and @tapkart/net
specifiers the way a downstream package will."
```

---

**Ambiguities and dependencies flagged for the plan's author:**

1. This task assumes `packages/protocol/package.json` and `packages/net/package.json` already carry
   `"exports": { ".": "./src/index.ts" }` from their scaffolding tasks (3 and 11). Neither file is
   created by this task; if either is missing, Step 5's or Step 10's package-entry-point test names
   the package directly.
2. `packages/net/src/transport.ts` has zero runtime exports under the locked contract's given
   signature. If Task 11 ends up adding any runtime value there (a constant, an error class), this
   task's net barrel test's function-count assertion (currently 7) and module-exclusion list will
   need a one-line update to match — not a structural change.
