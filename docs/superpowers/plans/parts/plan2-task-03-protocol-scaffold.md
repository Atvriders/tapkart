### Task 3: packages/protocol scaffold, types.ts and its barrel

**Amendment folded in.** Two changes to contract §3 landed after this brief was started, both applied below:

1. **`packages/protocol/src/index.ts` is created in this task**, re-exporting `./types` immediately — it is no longer deferred to Task 18. `packages/net` needs `ChannelName` from Task 11 onward, and without a barrel from Task 3 it would have to reach across with a relative path like `'../../protocol/src/types'`, punching through the package boundary and bypassing the `exports` map. `net` must import `@tapkart/protocol`. Task 18 widens this same file to every module and adds the no-ambiguous-export test, exactly as Plan 1's Task 2 → Task 18 did for `@tapkart/sim`'s barrel (`packages/sim/src/index.ts`, read as the model: a one-line `export * from './x'` per module, nothing else).

2. **The RED for everything in `types.ts` except `PROTOCOL_VERSION` must come from `npm run typecheck`, not vitest.** I verified this empirically in this repo before writing the steps below, not assumed it:
   - A **value** import of a module that does not exist (`import { PROTOCOL_VERSION } from '../src/types'` with no `src/types.ts` on disk) fails vitest with `Error: Cannot find module '../src/types' imported from ...` — a real, useful RED.
   - A **type-only** import of that same missing module (`import type { WireHeader } from '../src/types'`) does **not** fail vitest at all — I wrote a test file containing only a type-only import and a typed object literal, ran it against a nonexistent `src/types.ts`, and it reported `1 passed`. Under this repo's `verbatimModuleSyntax` + esbuild transform, a type-only import is erased before module resolution is even attempted, so vitest never notices the file is missing.
   - Once the module exists but is missing one specific named type, `tsc` reports `TS2305: Module '"../src/types"' has no exported member 'WireKart'` (verified directly) — one such error per missing name, all pointing at the same import line.
   - Once the module does not exist at all, `tsc` reports `TS2307: Cannot find module '../src/types' or its corresponding type declarations` — for *every* import from it, value or type-only alike, because `tsc` (unlike the vitest/esbuild runtime path) always resolves the module to type-check it.

   `types.ts` is a pure interface file with only one runtime value (`PROTOCOL_VERSION`) until Step 13 below adds three more (`WIRE_TAG`, `encodeHeader`, `decodeHeader`). Steps 5–6 and 8–9 below take their RED from `tsc`; the `PROTOCOL_VERSION` test (Steps 3–4) and the `WIRE_TAG`/`encodeHeader`/`decodeHeader` tests (Steps 11–14) take theirs from vitest, since all four are runtime values, not type-only imports. Do not run vitest on the type-shape tests expecting a red result — it will pass whether or not the types exist, which is exactly the failure mode ("a green vitest run 'proving' a vacuous RED") that let two of Plan 1's control tests ship silently wrong.

3. **`WIRE_TAG`, `encodeHeader` and `decodeHeader` are in this task's scope.** An earlier draft of this brief's Produces list omitted all three even though contract §3 assigns them to `types.ts`: *"Every datagram begins with this one byte. Without a shared tag a receiver cannot dispatch, and each of Tasks 11/14/15/16 would invent its own — which is exactly what happened when this was left unspecified."* That is precisely what happened: without this task producing them, downstream tasks built incompatible, un-interoperable tag schemes. Steps 11–14 below add all three with real TDD coverage, including `decodeHeader` throwing on an unrecognised tag byte and on a `PROTOCOL_VERSION` mismatch.

**Files:**
- Create: `packages/protocol/package.json`
- Create: `packages/protocol/tsconfig.json`
- Create: `packages/protocol/src/types.ts`
- Create: `packages/protocol/src/index.ts`
- Create: `packages/protocol/test/types.test.ts`

**Interfaces:**

- Consumes (read directly from the files named, not recalled from memory):
  - `packages/sim/package.json` — `{ "name": "@tapkart/sim", "version": "0.1.0", "private": true, "type": "module", "exports": { ".": "./src/index.ts" }, "scripts": { "typecheck": "tsc --noEmit -p tsconfig.json" } }`. This task's `package.json` mirrors this shape exactly, with the package renamed and a dependency on `@tapkart/sim` added.
  - `packages/sim/tsconfig.json` — `{ "extends": "../../tsconfig.base.json", "include": ["src/**/*.ts", "test/**/*.ts"] }`. Copied verbatim, no changes.
  - `tsconfig.base.json` (repo root) — `strict: true`, `verbatimModuleSyntax: true`, `isolatedModules: true`, `noUnusedLocals: true`, `noUnusedParameters: true`, `module: "ESNext"`, `moduleResolution: "Bundler"`, `noEmit: true`. Governs every `import type` decision below.
  - `vitest.config.ts` (repo root) — `test.include: ['packages/*/test/**/*.test.ts']`. Any `packages/protocol/test/*.test.ts` file is picked up automatically; no per-package vitest config is needed.
  - `package.json` (repo root) — `workspaces: ["packages/*"]`, `scripts.typecheck: "npm run typecheck --workspaces --if-present"`. Creating `packages/protocol/package.json` and running `npm install` at the repo root is what registers it as a workspace member (verified: before that install, `node_modules/@tapkart/` contains only `sim`; after, it contains a symlink `protocol -> ../../packages/protocol` alongside it).
  - `packages/sim/src/index.ts` — the barrel pattern this task's `src/index.ts` follows: one `export * from './module'` line per module, nothing else, no default export.
  - From `@tapkart/sim`'s public surface (all `export type`, all defined in `packages/sim/src/types.ts`, read directly rather than recalled): `Vec3 = { x: number; y: number; z: number }`, `Surface = 'tarmac' | 'dirt' | 'boost' | 'offtrack'`, `ItemKind = 'none' | 'boost' | 'seeker' | 'bolt' | 'slick' | 'bubble' | 'surge' | 'blink' | 'charge'`, `EntityKind = 'seeker' | 'bolt' | 'slick' | 'bubble' | 'surge' | 'charge'`, `Intent = { tick: number; steer: number; accel: number; brake: boolean; drift: boolean; useItem: boolean }`.
  - Contract §3's exact interface list, reproduced field-for-field in Step 8 below.

- Produces (exact names and shapes later tasks rely on):
  - `packages/protocol/package.json`, `packages/protocol/tsconfig.json` — the scaffold every later `protocol` task's files sit inside.
  - `export const PROTOCOL_VERSION = 1`
  - `export type ChannelName = 'unreliable' | 'reliable'`
  - `export type MessageKind = 'hello' | 'welcome' | 'lobby' | 'start' | 'input' | 'snapshot' | 'events' | 'checkpoint' | 'authorityChange' | 'ping' | 'pong'`
  - `export interface WireHeader { kind: MessageKind; protocolVersion: number }`
  - `export const WIRE_TAG = { hello: 0x01, welcome: 0x02, lobby: 0x03, start: 0x04, input: 0x10, snapshot: 0x11, events: 0x12, checkpoint: 0x13, authorityChange: 0x20, ping: 0x30, pong: 0x31 } as const` — the one byte every datagram begins with.
  - `export function encodeHeader(out: Uint8Array, kind: MessageKind): number` — writes `out[0] = WIRE_TAG[kind]`, `out[1] = PROTOCOL_VERSION`, returns `2`.
  - `export function decodeHeader(buf: Uint8Array): WireHeader` — throws on a tag byte with no matching `MessageKind` and on a `protocolVersion` that does not equal `PROTOCOL_VERSION`.
  - `export interface WireKart { ... }` — 21 fields, listed in full in Step 8.
  - `export interface WireEntity { ... }` — 7 fields.
  - `export interface WireSnapshot { ... }` — 6 fields.
  - `export interface InputDatagram { ... }` — 2 fields.
  - `packages/protocol/src/index.ts` re-exporting all of the above (`export * from './types'`), reachable as `@tapkart/protocol`.

---

- [ ] **Step 1: Write the scaffold — `package.json` and `tsconfig.json`**

Create `packages/protocol/package.json`:

```json
{
  "name": "@tapkart/protocol",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "dependencies": {
    "@tapkart/sim": "^0.1.0"
  },
  "scripts": {
    "typecheck": "tsc --noEmit -p tsconfig.json"
  }
}
```

Create `packages/protocol/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

- [ ] **Step 2: Register the workspace member**

Run: `npm install` (repo root)
Expected: exit code 0. `node_modules/@tapkart/protocol` is now a symlink to `packages/protocol` — verify with `ls -la node_modules/@tapkart/`, which should list both `protocol -> ../../packages/protocol` and `sim -> ../../packages/sim`. This is what makes `import ... from '@tapkart/sim'` resolvable from inside `packages/protocol` and, once Step 10 lands, `import ... from '@tapkart/protocol'` resolvable from anywhere else in the repo.

Run: `npx tsc --noEmit -p packages/protocol`
Expected: FAIL — `error TS18003: No inputs were found in config file '.../packages/protocol/tsconfig.json'. Specified 'include' paths were '["src/**/*.ts","test/**/*.ts"]' and 'exclude' paths were '[]'.` (verified directly). Neither `src/` nor `test/` has a single `.ts` file in it yet. This is expected — it becomes the first real input the moment Step 3 creates a test file, and is not treated as a bug to fix on its own.

---

- [ ] **Step 3: Write the failing test — `PROTOCOL_VERSION`, `ChannelName`, `MessageKind`, `WireHeader`**

Create `packages/protocol/test/types.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { PROTOCOL_VERSION } from '../src/types'
import type { ChannelName, MessageKind, WireHeader } from '../src/types'

describe('protocol wire types', () => {
  it('fixes PROTOCOL_VERSION at 1', () => {
    expect(PROTOCOL_VERSION).toBe(1)
  })

  it('accepts exactly the two channel names the contract fixes', () => {
    const a: ChannelName = 'unreliable'
    const b: ChannelName = 'reliable'
    expect(a).toBe('unreliable')
    expect(b).toBe('reliable')
  })

  it('builds a WireHeader for every MessageKind the contract lists', () => {
    const kinds: MessageKind[] = [
      'hello', 'welcome', 'lobby', 'start', 'input', 'snapshot', 'events',
      'checkpoint', 'authorityChange', 'ping', 'pong',
    ]
    expect(kinds).toHaveLength(11)
    for (const kind of kinds) {
      const h: WireHeader = { kind, protocolVersion: PROTOCOL_VERSION }
      expect(h.kind).toBe(kind)
      expect(h.protocolVersion).toBe(1)
    }
  })
})
```

- [ ] **Step 4: Run test to verify it fails, two ways**

Run: `npx vitest run packages/protocol/test/types.test.ts`
Expected: FAIL — `Error: Cannot find module '../src/types' imported from '.../packages/protocol/test/types.test.ts'`. This is the value import of `PROTOCOL_VERSION` failing at real module resolution; it is the one assertion in this file vitest can meaningfully red on right now, and it fails the whole file (no tests collected), which is why the two type-only tests below it don't get a chance to run yet either.

Run: `npx tsc --noEmit -p packages/protocol`
Expected: FAIL — two `TS2307: Cannot find module '../src/types' or its corresponding type declarations.` errors, one at the `PROTOCOL_VERSION` import and one at the `ChannelName, MessageKind, WireHeader` import (verified directly: `tsc` reports one per import statement referencing the missing module, regardless of whether the statement is a value or type-only import).

- [ ] **Step 5: Write the minimal implementation — `PROTOCOL_VERSION`, `ChannelName`, `MessageKind`, `WireHeader`**

Create `packages/protocol/src/types.ts`:

```ts
export const PROTOCOL_VERSION = 1

export type ChannelName = 'unreliable' | 'reliable'

export type MessageKind =
  | 'hello' | 'welcome' | 'lobby' | 'start'
  | 'input' | 'snapshot' | 'events' | 'checkpoint'
  | 'authorityChange' | 'ping' | 'pong'

export interface WireHeader { kind: MessageKind; protocolVersion: number }
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run packages/protocol/test/types.test.ts`
Expected: PASS — 3 tests.

Run: `npx tsc --noEmit -p packages/protocol`
Expected: no output, exit code 0.

---

- [ ] **Step 7: Write the failing test — `WireKart`, `WireEntity`, `WireSnapshot`, `InputDatagram`**

In `packages/protocol/test/types.test.ts`, widen the import from `'../src/types'`. Before:

```ts
import { PROTOCOL_VERSION } from '../src/types'
import type { ChannelName, MessageKind, WireHeader } from '../src/types'
```

After:

```ts
import { PROTOCOL_VERSION } from '../src/types'
import type {
  ChannelName, InputDatagram, MessageKind, WireEntity, WireHeader, WireKart, WireSnapshot,
} from '../src/types'
import type { EntityKind, Intent, ItemKind, Surface } from '@tapkart/sim'
```

Then append to the end of the `describe('protocol wire types', ...)` block, before its closing `})`. Before:

```ts
      expect(h.protocolVersion).toBe(1)
    }
  })
})
```

After:

```ts
      expect(h.protocolVersion).toBe(1)
    }
  })

  it('builds a WireKart with all 21 fields the contract lists, and only those', () => {
    const wk: WireKart = {
      playerId: 3,
      position: { x: 1, y: 2, z: 3 },
      velocity: { x: 0, y: 0, z: 0 },
      heading: 0,
      angularVelocity: 0,
      driftCharge: 0,
      driftActive: false,
      driftDir: 0,
      airborne: false,
      surface: 'tarmac' as Surface,
      spinOutTicks: 0,
      invulnTicks: 0,
      item: 'none' as ItemKind,
      lap: 1,
      checkpointIdx: 2,
      t: 0.5,
      isBot: false,
      connected: true,
      boostTicks: 0,
      respawnTicks: 0,
      shielded: false,
    }
    // 21 fields exactly. Spec §5's invariant is that this is a COMPLETE
    // projection of KartState's per-tick fields (characterIdx is the one
    // named exception, arriving over the reliable channel instead) -- a field
    // added to KartState without a matching addition here is the defect the
    // invariant exists to catch, so this count is asserted, not just implied
    // by the object literal typechecking.
    expect(Object.keys(wk).length).toBe(21)
    expect(wk.playerId).toBe(3)
    expect(wk.driftDir).toBe(0)
  })

  it('builds a WireEntity with all 7 fields', () => {
    const we: WireEntity = {
      entityId: 5,
      kind: 'seeker' as EntityKind,
      ownerId: 2,
      position: { x: 0, y: 0, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
      heading: 0,
      ttl: 600,
    }
    expect(Object.keys(we).length).toBe(7)
    expect(we.ttl).toBe(600)
  })

  it('builds a WireSnapshot with all 6 fields', () => {
    const ws: WireSnapshot = {
      tick: 100,
      eventSeq: 4,
      lastProcessedInputTick: [1, 2, 3, 4, 5, 6, 7, 8],
      karts: [],
      entities: [],
      entityCount: 0,
    }
    expect(Object.keys(ws).length).toBe(6)
    expect(ws.lastProcessedInputTick).toHaveLength(8)
  })

  it('builds an InputDatagram with both fields', () => {
    const intent: Intent = { tick: 0, steer: 0, accel: 0, brake: false, drift: false, useItem: false }
    const id: InputDatagram = { playerId: 0, intents: [intent] }
    expect(Object.keys(id).length).toBe(2)
    expect(id.intents).toHaveLength(1)
  })
})
```

- [ ] **Step 8: Run test to verify it fails — `tsc` only**

Do **not** run `npx vitest run packages/protocol/test/types.test.ts` and treat its result as meaningful here. All four new imports (`WireKart`, `WireEntity`, `WireSnapshot`, `InputDatagram`) are `import type`, and `PROTOCOL_VERSION`'s import — the one thing keeping this file's vitest run honest in Step 4 — already resolves successfully as of Step 5. Vitest will run this file and **pass all 7 tests**, including the four new ones, even though none of `WireKart`/`WireEntity`/`WireSnapshot`/`InputDatagram` exist yet: the type-only imports are erased before module resolution, and the object literals typecheck against nothing, so they are plain untyped JS objects at runtime and every `Object.keys(...).length` assertion is measuring a literal you just wrote, not a contract. This is not a bug in the test; it is the precise reason this step's RED must come from `tsc`.

Run: `npx tsc --noEmit -p packages/protocol`
Expected: FAIL — four `TS2305` errors, one per missing name, all on the same import line (verified directly, exact text):

```
test/types.test.ts(3,3): error TS2305: Module '"../src/types"' has no exported member 'InputDatagram'.
test/types.test.ts(3,18): error TS2305: Module '"../src/types"' has no exported member 'WireEntity'.
test/types.test.ts(3,30): error TS2305: Module '"../src/types"' has no exported member 'WireKart'.
test/types.test.ts(3,40): error TS2305: Module '"../src/types"' has no exported member 'WireSnapshot'.
```

- [ ] **Step 9: Write the minimal implementation — `WireKart`, `WireEntity`, `WireSnapshot`, `InputDatagram`**

In `packages/protocol/src/types.ts`, add the import from `@tapkart/sim` at the top. Before:

```ts
export const PROTOCOL_VERSION = 1
```

After:

```ts
import type { EntityKind, Intent, ItemKind, Surface, Vec3 } from '@tapkart/sim'

export const PROTOCOL_VERSION = 1
```

Then append the four interfaces to the end of the file. Before:

```ts
export interface WireHeader { kind: MessageKind; protocolVersion: number }
```

After:

```ts
export interface WireHeader { kind: MessageKind; protocolVersion: number }

export interface WireKart {
  playerId: number; position: Vec3; velocity: Vec3; heading: number
  angularVelocity: number; driftCharge: number; driftActive: boolean
  driftDir: -1 | 0 | 1; airborne: boolean; surface: Surface
  spinOutTicks: number; invulnTicks: number; item: ItemKind
  lap: number; checkpointIdx: number; t: number
  isBot: boolean; connected: boolean
  boostTicks: number; respawnTicks: number; shielded: boolean
}

export interface WireEntity {
  entityId: number; kind: EntityKind; ownerId: number
  position: Vec3; velocity: Vec3; heading: number; ttl: number
}

export interface WireSnapshot {
  tick: number; eventSeq: number
  lastProcessedInputTick: number[]      // length MAX_KARTS
  karts: WireKart[]                     // length MAX_KARTS
  entities: WireEntity[]                // length MAX_ENTITIES, live packed at front
  entityCount: number
}

export interface InputDatagram {
  playerId: number; intents: Intent[]   // length INPUT_REDUNDANCY, newest last
}
```

- [ ] **Step 10: Run test to verify it passes**

Run: `npx tsc --noEmit -p packages/protocol`
Expected: no output, exit code 0.

Run: `npx vitest run packages/protocol/test/types.test.ts`
Expected: PASS — 7 tests. This run is now meaningful (it was not, in Step 8): every field on every interface is exercised by a real object literal, `tsc` has just confirmed those literals conform to the interfaces, and the `Object.keys(...).length` counts guard against a field silently added to one side (KartState) without its counterpart here.

---

- [ ] **Step 11: Write the failing test — `WIRE_TAG`, `encodeHeader`, `decodeHeader`**

In `packages/protocol/test/types.test.ts`, widen the value import. Before:

```ts
import { PROTOCOL_VERSION } from '../src/types'
import type {
  ChannelName, InputDatagram, MessageKind, WireEntity, WireHeader, WireKart, WireSnapshot,
} from '../src/types'
import type { EntityKind, Intent, ItemKind, Surface } from '@tapkart/sim'
```

After:

```ts
import { PROTOCOL_VERSION, WIRE_TAG, decodeHeader, encodeHeader } from '../src/types'
import type {
  ChannelName, InputDatagram, MessageKind, WireEntity, WireHeader, WireKart, WireSnapshot,
} from '../src/types'
import type { EntityKind, Intent, ItemKind, Surface } from '@tapkart/sim'
```

Then append a new `describe` block at the end of the file, after `describe('protocol wire types', ...)`'s closing `})`. Before:

```ts
  it('builds an InputDatagram with both fields', () => {
    const intent: Intent = { tick: 0, steer: 0, accel: 0, brake: false, drift: false, useItem: false }
    const id: InputDatagram = { playerId: 0, intents: [intent] }
    expect(Object.keys(id).length).toBe(2)
    expect(id.intents).toHaveLength(1)
  })
})
```

After:

```ts
  it('builds an InputDatagram with both fields', () => {
    const intent: Intent = { tick: 0, steer: 0, accel: 0, brake: false, drift: false, useItem: false }
    const id: InputDatagram = { playerId: 0, intents: [intent] }
    expect(Object.keys(id).length).toBe(2)
    expect(id.intents).toHaveLength(1)
  })
})

describe('WIRE_TAG, encodeHeader, decodeHeader', () => {
  const ALL_KINDS: MessageKind[] = [
    'hello', 'welcome', 'lobby', 'start', 'input', 'snapshot', 'events',
    'checkpoint', 'authorityChange', 'ping', 'pong',
  ]

  it('fixes a distinct byte for every MessageKind the contract lists', () => {
    expect(WIRE_TAG).toEqual({
      hello: 0x01, welcome: 0x02, lobby: 0x03, start: 0x04,
      input: 0x10, snapshot: 0x11, events: 0x12, checkpoint: 0x13,
      authorityChange: 0x20, ping: 0x30, pong: 0x31,
    })
    // Every datagram is dispatched on this one byte alone, so no two kinds
    // may share a value.
    const values = Object.values(WIRE_TAG)
    expect(new Set(values).size).toBe(values.length)
  })

  it('encodeHeader writes [tag, PROTOCOL_VERSION] and returns 2', () => {
    const out = new Uint8Array(4).fill(0xff)
    const n = encodeHeader(out, 'snapshot')
    expect(n).toBe(2)
    expect(out[0]).toBe(WIRE_TAG.snapshot)
    expect(out[1]).toBe(PROTOCOL_VERSION)
    expect(out[2]).toBe(0xff) // encodeHeader writes only its own 2 bytes
  })

  it('decodeHeader round-trips every MessageKind through encodeHeader', () => {
    const buf = new Uint8Array(2)
    for (const kind of ALL_KINDS) {
      encodeHeader(buf, kind)
      const h: WireHeader = decodeHeader(buf)
      expect(h.kind).toBe(kind)
      expect(h.protocolVersion).toBe(PROTOCOL_VERSION)
    }
  })

  it('decodeHeader throws on a tag byte no MessageKind maps to', () => {
    // 0x99 is not one of WIRE_TAG's eleven values.
    const buf = new Uint8Array([0x99, PROTOCOL_VERSION])
    expect(() => decodeHeader(buf)).toThrow(/unknown wire tag/)
  })

  it('decodeHeader throws on a PROTOCOL_VERSION mismatch', () => {
    const buf = new Uint8Array([WIRE_TAG.input, PROTOCOL_VERSION + 1])
    expect(() => decodeHeader(buf)).toThrow(/protocol version/)
  })
})
```

- [ ] **Step 12: Run test to verify it fails**

Run: `npx vitest run packages/protocol/test/types.test.ts -t "WIRE_TAG, encodeHeader, decodeHeader"`
Expected: FAIL, all 5 tests, for two distinct reasons. Verified directly against this repo's esbuild-transpiled vitest by probing the identical pattern against an existing module (`packages/sim/src/state.ts`, importing two names it does not export): a named **value** import with no matching export binds to `undefined` at the call site rather than failing module resolution, because `types.ts` already exists and exports `PROTOCOL_VERSION` — the whole file still collects and runs.

- `'fixes a distinct byte for every MessageKind the contract lists'`: `AssertionError: expected undefined to deeply equal {...}` — `WIRE_TAG` is `undefined`, and `toEqual` compares it directly without throwing (probed: `expect(undefined).toEqual({ hello: 1 })` reports exactly this).
- `'encodeHeader writes [tag, PROTOCOL_VERSION] and returns 2'`: `TypeError: encodeHeader is not a function` — `encodeHeader` is `undefined`, called as a function.
- `'decodeHeader round-trips every MessageKind through encodeHeader'`: the same `TypeError: encodeHeader is not a function`, at the first `encodeHeader(buf, kind)` call inside the loop.
- `'decodeHeader throws on a tag byte no MessageKind maps to'`: the `toThrow(/unknown wire tag/)` assertion itself fails, not the call — `decodeHeader` is `undefined`, so calling it throws `TypeError: decodeHeader is not a function`, which does not match `/unknown wire tag/`: `AssertionError: expected [Function] to throw error matching /unknown wire tag/ but got '...is not a function'` (probed against the same pattern).
- `'decodeHeader throws on a PROTOCOL_VERSION mismatch'`: the same shape as above, mismatched against `/protocol version/`.

- [ ] **Step 13: Write the minimal implementation — `WIRE_TAG`, `encodeHeader`, `decodeHeader`**

In `packages/protocol/src/types.ts`, insert after `WireHeader` and before `WireKart`. Before:

```ts
export interface WireHeader { kind: MessageKind; protocolVersion: number }

export interface WireKart {
```

After:

```ts
export interface WireHeader { kind: MessageKind; protocolVersion: number }

// Every datagram begins with this byte, so a receiver can dispatch before
// decoding anything else. Without a shared tag, Tasks 11/14/15/16 would each
// invent their own -- which is exactly what happened when this was left
// unspecified in an earlier draft of this contract.
export const WIRE_TAG = {
  hello: 0x01, welcome: 0x02, lobby: 0x03, start: 0x04,
  input: 0x10, snapshot: 0x11, events: 0x12, checkpoint: 0x13,
  authorityChange: 0x20, ping: 0x30, pong: 0x31,
} as const

const TAG_TO_KIND = ((): ReadonlyMap<number, MessageKind> => {
  const m = new Map<number, MessageKind>()
  for (const kind of Object.keys(WIRE_TAG) as MessageKind[]) {
    m.set(WIRE_TAG[kind], kind)
  }
  return m
})()

/** Writes [tag, PROTOCOL_VERSION] into out[0..1] and returns 2, the byte count. */
export function encodeHeader(out: Uint8Array, kind: MessageKind): number {
  out[0] = WIRE_TAG[kind]
  out[1] = PROTOCOL_VERSION
  return 2
}

/**
 * Reads the 2-byte header written by encodeHeader. Throws on an unrecognised
 * tag byte or a PROTOCOL_VERSION that does not match this build's.
 */
export function decodeHeader(buf: Uint8Array): WireHeader {
  const tag = buf[0]
  const kind = TAG_TO_KIND.get(tag)
  if (kind === undefined) {
    throw new Error(`decodeHeader: unknown wire tag ${tag}`)
  }
  const protocolVersion = buf[1]
  if (protocolVersion !== PROTOCOL_VERSION) {
    throw new Error(
      `decodeHeader: protocol version mismatch (expected ${PROTOCOL_VERSION}, got ${protocolVersion})`,
    )
  }
  return { kind, protocolVersion }
}

export interface WireKart {
```

- [ ] **Step 14: Run test to verify it passes**

Run: `npx vitest run packages/protocol/test/types.test.ts -t "WIRE_TAG, encodeHeader, decodeHeader"`
Expected: PASS — 5 tests.

Run: `npx tsc --noEmit -p packages/protocol`
Expected: no output, exit code 0.

---

- [ ] **Step 15: Write the failing test — the barrel**

Append a new test to `packages/protocol/test/types.test.ts`, after the `describe('WIRE_TAG, encodeHeader, decodeHeader', ...)` block closes (Step 11 made this the file's last block). Before (the file's last four lines):

```ts
  it('decodeHeader throws on a PROTOCOL_VERSION mismatch', () => {
    const buf = new Uint8Array([WIRE_TAG.input, PROTOCOL_VERSION + 1])
    expect(() => decodeHeader(buf)).toThrow(/protocol version/)
  })
})
```

After:

```ts
  it('decodeHeader throws on a PROTOCOL_VERSION mismatch', () => {
    const buf = new Uint8Array([WIRE_TAG.input, PROTOCOL_VERSION + 1])
    expect(() => decodeHeader(buf)).toThrow(/protocol version/)
  })
})

describe('@tapkart/protocol barrel', () => {
  it('resolves through the package entry point', async () => {
    const pkg = await import('@tapkart/protocol')
    expect(pkg.PROTOCOL_VERSION).toBe(1)
  })
})
```

This is a dynamic import (not a static one at the top of the file) so a resolution failure fails this one test rather than the whole file, matching `packages/sim/test/barrel.test.ts`'s own `'resolves through the @tapkart/sim package entry point'` test, which this mirrors.

- [ ] **Step 16: Run test to verify it fails**

Run: `npx vitest run packages/protocol/test/types.test.ts -t "resolves through the package entry point"`
Expected: FAIL. `packages/protocol/package.json`'s `exports` map already points `"."` at `./src/index.ts` (Step 1), but that file does not exist yet, so Node's package resolution fails: `Error: Cannot find module '@tapkart/protocol' imported from ...` (or equivalent — the exact wording depends on Vite's resolver, but the failure is a resolution error, not an assertion error, because there is nothing at the far end of the `exports` map yet).

- [ ] **Step 17: Write the minimal implementation — the barrel**

Create `packages/protocol/src/index.ts`:

```ts
// Public barrel for @tapkart/protocol.
//
// packages/protocol/package.json maps "." to this file. Task 3 re-exports only
// types.ts; Task 18 widens this list to every module this package ends up with
// (bits, quant, snapshot, checkpoint, events, input), mirroring exactly what
// Plan 1's Task 2 -> Task 18 did for packages/sim/src/index.ts.
export * from './types'
```

- [ ] **Step 18: Run test to verify it passes**

Run: `npx vitest run packages/protocol/test/types.test.ts`
Expected: PASS — 13 tests (3 from Step 3 + 4 from Step 7 + 5 from Step 11 + 1 barrel test from Step 15).

---

- [ ] **Step 19: Run the whole package and typecheck**

Run: `npx vitest run packages/protocol`
Expected: PASS — 13 tests, 1 file.

Run: `npx tsc --noEmit -p packages/protocol`
Expected: no output, exit code 0.

Run: `npm run typecheck` (repo root)
Expected: exit code 0. This runs `typecheck` in every workspace with that script (`--workspaces --if-present`), so it now also covers `packages/sim`; confirm it still reports success there too, since this task did not touch `packages/sim`.

- [ ] **Step 20: Commit**

```bash
git add packages/protocol/package.json packages/protocol/tsconfig.json \
        packages/protocol/src/types.ts packages/protocol/src/index.ts \
        packages/protocol/test/types.test.ts package-lock.json
git commit -m "feat(protocol): scaffold packages/protocol, wire message types, header codec and its barrel

New npm workspace mirroring packages/sim's package.json/tsconfig.json shape,
depending on @tapkart/sim for Vec3/Surface/ItemKind/EntityKind/Intent and on
nothing else. types.ts carries PROTOCOL_VERSION, ChannelName, MessageKind,
WireHeader, and the WireKart/WireEntity/WireSnapshot/InputDatagram wire
shapes exactly as the locked contract's §3 lists them -- decode targets, not
SimState, and lossy by construction.

WIRE_TAG, encodeHeader and decodeHeader also ship here: the one shared 2-byte
tag+version header every datagram begins with, so a receiver can dispatch
before decoding anything else. decodeHeader throws on an unrecognised tag
byte and on a PROTOCOL_VERSION mismatch. Without this, every later task that
sends a message would invent its own incompatible tag scheme.

src/index.ts re-exports types.ts and is created now, not deferred to Task 18,
because packages/net needs ChannelName from Task 11 onward and must reach it
through @tapkart/protocol rather than a relative path across the package
boundary.

types.ts is mostly a pure interface file; the RED for every type-only
interface in it came from tsc (TS2307 while the module didn't exist, TS2305
once it existed but a name was still missing), not vitest -- a type-only
import of a missing module is erased by verbatimModuleSyntax before module
resolution and passes vitest vacuously, verified directly before writing
these steps. PROTOCOL_VERSION, WIRE_TAG, encodeHeader and decodeHeader are
runtime values, so their RED came from vitest instead, also verified
directly: a named value import with no matching export binds to undefined
at the call site rather than failing module resolution, once the module
itself already exists."
```
