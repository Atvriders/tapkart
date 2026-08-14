### Task 11: `packages/net` workspace scaffold and `src/transport.ts`

Creates the third workspace, `@tapkart/net`, mirroring `@tapkart/sim`'s shape
exactly (verified by reading `packages/sim/package.json`,
`packages/sim/tsconfig.json`, and the root `vitest.config.ts` directly — all
three are quoted below rather than paraphrased), and defines the `Transport`
interface: the one seam spec §5 requires everything above it to be ignorant
of. *"One interface, three implementations ... Nothing above the transport
layer knows which implementation is in use."*

**Files:**
- Create: `packages/net/package.json`
- Create: `packages/net/tsconfig.json`
- Create: `packages/net/src/index.ts`
- Create: `packages/net/src/transport.ts`
- Test: `packages/net/test/scaffold.test.ts`
- Test: `packages/net/test/transport.test.ts`

**Interfaces:**

- Consumes:
  - `packages/sim/package.json` (read directly):
    ```json
    { "name": "@tapkart/sim", "version": "0.1.0", "private": true, "type": "module",
      "exports": { ".": "./src/index.ts" }, "scripts": { "typecheck": "tsc --noEmit -p tsconfig.json" } }
    ```
    No `devDependencies` — `vitest`/`typescript` come from the root via npm
    workspace hoisting.
  - `packages/sim/tsconfig.json` (read directly):
    ```json
    { "extends": "../../tsconfig.base.json", "include": ["src/**/*.ts", "test/**/*.ts"] }
    ```
  - `vitest.config.ts` at the repo root (read directly): `include:
    ['packages/*/test/**/*.test.ts']`, `environment: 'node'`, `globals:
    false` — this new workspace is discovered automatically once its test
    files exist; nothing in the root config needs to change.
  - `packages/protocol/src/index.ts` [Task 3] — `export type ChannelName =
    'unreliable' | 'reliable'`, reachable via `@tapkart/protocol`. **Reached
    by the bare package specifier, never a relative path across the package
    boundary — this is load-bearing, not a style choice.** Contract §3 is
    explicit: "The barrel exists from Task 3, not Task 18. Task 3's scaffold
    creates `packages/protocol/src/index.ts` already re-exporting `./types`
    ... `net` imports `@tapkart/protocol`, always." By the time this task
    runs, Tasks 3–10 have executed: `packages/protocol/src/types.ts` exists
    with `ChannelName` exported, and `packages/protocol/src/index.ts` already
    re-exports it — that is Task 3's own scaffold step, not deferred to
    Task 18. (An earlier draft of this brief argued the protocol barrel
    stayed empty until Task 18 and reached `ChannelName` by a relative path,
    `'../../protocol/src/types'`, instead. That argument is superseded by the
    amended contract, and the relative-path approach is exactly what
    contract §3 forbids: "punches through the package boundary, bypasses the
    `exports` map, and would survive into Plan 3.")

- Produces:
  - Workspace `@tapkart/net` at `packages/net`, `"type": "module"`, exporting
    `"."` as `./src/index.ts`, depending on `@tapkart/sim` and
    `@tapkart/protocol`.
  - `packages/net/src/index.ts` — starts as an empty barrel (`export {}`,
    Step 5) while `transport.ts` doesn't exist yet, then is widened to
    `export * from './transport'` (Step 10) once it does. Contract §3: "The
    same applies to `packages/net/src/index.ts`: Task 11's scaffold creates
    it re-exporting `./transport`, Task 18 widens it." This task, not
    Task 18, is responsible for the barrel carrying `./transport` by the
    time it finishes; Task 18 only adds the remaining five modules
    (`loopback`, `apply`, `authority`, `client`, `shadow`) once Tasks 12–16
    ship them.
  - `export interface Transport { send(channel: ChannelName, peerId: string,
    data: Uint8Array): void; broadcast(channel: ChannelName, data:
    Uint8Array): void; onMessage(cb: (peerId: string, channel: ChannelName,
    data: Uint8Array) => void): void; onPeerLost(cb: (peerId: string) =>
    void): void; peers(): string[]; close(): void }` — verbatim from contract
    §5. No other export in this file; no task may add a method.

- **Testability, made concrete, not asserted.** Spec §5's claim ("nothing
  above the transport layer knows which implementation is in use") is only
  meaningful if code can be written against `Transport` alone and actually
  run. This task's test builds a small in-memory double — defined **only in
  the test file**, never in `transport.ts` — that implements the six methods
  and nothing else, plus a tiny helper function typed to accept `Transport`
  and nothing more specific. Driving the double through that helper is the
  proof: if `Transport` were missing a method some later loop needs, or if
  the helper accidentally required something implementation-specific, this
  test would not compile.

- **A verified fact about this repo's tooling that changes how this task's
  RED step must be checked.** `transport.ts` in this task contains *only* a
  type declaration and one `import type` — no runtime code at all. I
  confirmed by direct experiment (a throwaway test file, deleted after) that
  under this project's Vitest/Vite setup, `import type { X } from
  './nonexistent-module'` does **not** fail at `vitest run` time even when
  the module genuinely does not exist: `verbatimModuleSyntax` erases
  type-only imports completely before Vite's resolver ever sees them, so a
  test that only uses `Transport` in type position would silently collect
  and pass, RED or not. The same experiment confirmed that `npx tsc --noEmit`
  **does** catch it, with `error TS2307: Cannot find module '...' or its
  corresponding type declarations.` — so this task's RED/GREEN check for
  `transport.ts` uses `tsc`, not `vitest run`, and says so at the step level
  rather than leaving a future reader to discover this the hard way.

---

- [ ] **Step 1: Write the failing scaffold test**

Create `packages/net/test/scaffold.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import * as net from '../src/index'

describe('net workspace scaffold', () => {
  it('runs a TypeScript test from the new @tapkart/net workspace', () => {
    expect(2 + 2).toBe(4)
  })

  it('resolves the @tapkart/net entry point with extensionless imports', () => {
    expect(typeof net).toBe('object')
  })
})
```

- [ ] **Step 2: Run the scaffold test to verify it fails**

Run: `npx vitest run packages/net/test/scaffold.test.ts`

Expected: FAIL with `Error: Cannot find module '../src/index' imported from
'.../packages/net/test/scaffold.test.ts'` (a real, non-type-only namespace
import — `import * as net` — so this genuinely fails to resolve; unlike the
`Transport` case below, there is no type-erasure trap here). Vitest's glob in
`vitest.config.ts` matches this file by path regardless of whether
`packages/net/package.json` exists yet, so the explicit file argument runs
even though the workspace isn't registered — the same as Plan 1's Task 1.

- [ ] **Step 3: Write `packages/net/package.json`**

Create `packages/net/package.json`:

```json
{
  "name": "@tapkart/net",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "dependencies": {
    "@tapkart/protocol": "*",
    "@tapkart/sim": "*"
  },
  "scripts": {
    "typecheck": "tsc --noEmit -p tsconfig.json"
  }
}
```

`"*"` is the standard npm-workspaces idiom for "resolve to the local
workspace package," exactly as `packages/sim`'s own `package.json` would use
if it depended on anything. Neither dependency is used by a bare
`@tapkart/protocol`/`@tapkart/sim` import inside `transport.ts` itself (that
file only reaches `@tapkart/protocol` via the relative path explained above),
but `@tapkart/sim` **is** imported by its bare specifier in Task 12's
`net-fixtures.ts`, and declaring both dependencies now means the one `npm
install` this task runs (Step 6) links them before Task 12 needs them.

- [ ] **Step 4: Write `packages/net/tsconfig.json`**

Create `packages/net/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

- [ ] **Step 5: Write the empty barrel**

Create `packages/net/src/index.ts`:

```ts
// Public barrel for @tapkart/net. Task 18 replaces this line with re-exports
// of transport, loopback, apply, authority, client and shadow. The bare
// `export {}` keeps the file a module under isolatedModules while it is
// still empty -- the same role packages/sim/src/index.ts played from Task 1
// until Task 2 filled it in.
export {}
```

- [ ] **Step 6: Install and verify the scaffold test passes**

Run:

```bash
npm install
npx vitest run packages/net/test/scaffold.test.ts
```

Expected: `npm install` updates `package-lock.json` to include `@tapkart/net`
and links `@tapkart/protocol` and `@tapkart/sim` into its dependency tree.
`npx vitest run` reports `Test Files 1 passed (1)`, `Tests 2 passed (2)`.

Then run `npm ls --depth=0 -w @tapkart/net` and confirm the output includes
both `@tapkart/protocol` and `@tapkart/sim` as linked workspace dependencies.

- [ ] **Step 7: Write the failing test for the `Transport` interface**

Create `packages/net/test/transport.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { Transport } from '../src/transport'
import type { Transport as BarrelTransport } from '../src/index'
import type { ChannelName } from '@tapkart/protocol'

interface RecordingTransport extends Transport {
  sent: { channel: ChannelName; peerId: string; data: Uint8Array }[]
  broadcasts: { channel: ChannelName; data: Uint8Array }[]
}

/**
 * A minimal in-memory double. It lives only in this test file: transport.ts
 * defines the interface and nothing else, so any code exercising a Transport
 * goes through these six methods and nothing more -- which is exactly the
 * spec's "nothing above the transport layer knows which implementation is in
 * use" claim, made testable rather than merely asserted.
 */
function makeFakeTransport(): RecordingTransport {
  const sent: RecordingTransport['sent'] = []
  const broadcasts: RecordingTransport['broadcasts'] = []
  const messageCbs: ((peerId: string, channel: ChannelName, data: Uint8Array) => void)[] = []
  const peerLostCbs: ((peerId: string) => void)[] = []
  let closed = false
  return {
    sent,
    broadcasts,
    send(channel, peerId, data) {
      sent.push({ channel, peerId, data })
    },
    broadcast(channel, data) {
      broadcasts.push({ channel, data })
    },
    onMessage(cb) {
      messageCbs.push(cb)
    },
    onPeerLost(cb) {
      peerLostCbs.push(cb)
    },
    peers() {
      return closed ? [] : ['peerB']
    },
    close() {
      closed = true
    },
  }
}

/**
 * Written against the Transport interface alone -- no method beyond the six
 * in the contract, no property specific to any one implementation. This is
 * the shape every later loop (AuthorityLoop, ClientLoop, ShadowLoop) uses.
 */
function sendGreeting(t: Transport): void {
  const payload = new Uint8Array([1, 2, 3])
  t.send('reliable', 'peerB', payload)
  t.broadcast('unreliable', payload)
}

describe('Transport interface', () => {
  it('is fully exercised through its six methods by code that knows nothing else about it', () => {
    const fake = makeFakeTransport()
    sendGreeting(fake)

    expect(fake.sent).toEqual([
      { channel: 'reliable', peerId: 'peerB', data: new Uint8Array([1, 2, 3]) },
    ])
    expect(fake.broadcasts).toEqual([
      { channel: 'unreliable', data: new Uint8Array([1, 2, 3]) },
    ])
    expect(fake.peers()).toEqual(['peerB'])

    fake.close()
    expect(fake.peers()).toEqual([])
  })

  it('accepts exactly the two contract channel names and no others', () => {
    const fake = makeFakeTransport()
    const channels: ChannelName[] = ['unreliable', 'reliable']
    for (const c of channels) fake.send(c, 'peerB', new Uint8Array())
    expect(fake.sent.map((s) => s.channel)).toEqual(['unreliable', 'reliable'])
  })

  it('is reachable through the package barrel, structurally identical to the direct import', () => {
    // The real assertion here is that this file compiles at all:
    // BarrelTransport resolves only once packages/net/src/index.ts
    // re-exports transport.ts (Step 10). Contract §3/§5: "Task 11's scaffold
    // creates it re-exporting ./transport." Before Step 10 this import fails
    // tsc with TS2305 ("no exported member 'Transport'"), exactly like
    // Step 8's TS2307 for ../src/transport before Step 9 -- two separate
    // barrel-boundary defects, fixed by two separate steps.
    const fake = makeFakeTransport()
    const viaBarrel: BarrelTransport = fake
    const viaDirect: Transport = viaBarrel
    expect(viaDirect).toBe(fake)
  })
})
```

- [ ] **Step 8: Run the typecheck to verify it fails**

Run: `npx tsc --noEmit -p packages/net`

Expected: exactly **two** diagnostics, from two independent missing exports —
`transport.ts` doesn't exist yet (Step 9) and `index.ts` doesn't re-export
`Transport` yet (Step 10):

```
test/transport.test.ts(3,30): error TS2307: Cannot find module '../src/transport' or its corresponding type declarations.
test/transport.test.ts(4,36): error TS2305: Module '"../src/index"' has no exported member 'Transport'.
```

(Line/column will differ slightly with exact formatting, but both codes and
messages are as shown.) Resolving the first requires Step 9; resolving the
second requires Step 10 — these are genuinely two separate defects, not one
reported twice.

**Do not** run `npx vitest run packages/net/test/transport.test.ts` and
expect it to fail — it will not. Every reference to `Transport` in this test
file is a type-only import and a type position; under this project's
`verbatimModuleSyntax` + Vite/esbuild transform, that import is erased
entirely before module resolution happens, so the test collects and passes
even though `transport.ts` does not exist and `index.ts` doesn't re-export
it. This was confirmed directly by experiment, not assumed. `tsc` is the only
oracle for this step.

- [ ] **Step 9: Implement `packages/net/src/transport.ts`**

Create `packages/net/src/transport.ts`:

```ts
import type { ChannelName } from '@tapkart/protocol'

/**
 * One interface, three implementations (WebRTC, WebSocket, Loopback). Spec
 * §5: "Nothing above the transport layer knows which implementation is in
 * use." Two channels, named by the exact strings 'unreliable' and 'reliable'
 * -- ChannelName is imported from @tapkart/protocol's barrel, not redefined
 * here and not reached by a relative path (contract §3: "net imports
 * @tapkart/protocol, always").
 */
export interface Transport {
  send(channel: ChannelName, peerId: string, data: Uint8Array): void
  broadcast(channel: ChannelName, data: Uint8Array): void
  onMessage(cb: (peerId: string, channel: ChannelName, data: Uint8Array) => void): void
  onPeerLost(cb: (peerId: string) => void): void
  peers(): string[]
  close(): void
}
```

Run: `npx tsc --noEmit -p packages/net`

Expected: exactly **one** diagnostic remains — the same `TS2305` from Step 8,
unchanged, because `index.ts` still hasn't been widened:

```
test/transport.test.ts(4,36): error TS2305: Module '"../src/index"' has no exported member 'Transport'.
```

This confirms `transport.ts` alone resolves the `TS2307` half of Step 8's RED
and nothing else — the barrel still needs Step 10.

- [ ] **Step 10: Widen the barrel to re-export `transport.ts`**

Contract §3/§5: "Task 11's scaffold creates it re-exporting `./transport`,
Task 18 widens it." Replace `packages/net/src/index.ts`'s content. Before:

```ts
// Public barrel for @tapkart/net. Task 18 replaces this line with re-exports
// of transport, loopback, apply, authority, client and shadow. The bare
// `export {}` keeps the file a module under isolatedModules while it is
// still empty -- the same role packages/sim/src/index.ts played from Task 1
// until Task 2 filled it in.
export {}
```

After:

```ts
// Public barrel for @tapkart/net.
//
// Task 11 re-exports only transport.ts; Task 18 widens this list to every
// module this package ends up with (transport, loopback, apply, authority,
// client, shadow), mirroring exactly what Task 3 -> Task 18 did for
// packages/protocol/src/index.ts and what Plan 1's Task 1 -> Task 2 did for
// packages/sim/src/index.ts.
export * from './transport'
```

Run: `npx tsc --noEmit -p packages/net`
Expected: no output, exit code 0 — both Step 8 diagnostics are now resolved.

Run: `npx vitest run packages/net/test/transport.test.ts`
Expected: `Test Files 1 passed (1)`, `Tests 3 passed (3)` — the third test
(added in Step 7) is meaningful for the first time: it only compiles because
`BarrelTransport` genuinely resolves through `../src/index`.

- [ ] **Step 11: Full package and repo sanity check**

Run:

```bash
npx tsc --noEmit -p packages/net
npx vitest run packages/net
npm run typecheck
npm test
```

Expected: all four commands exit 0. `npm test` includes both new test files
(`packages/net/test/scaffold.test.ts`, `packages/net/test/transport.test.ts`)
alongside every existing `packages/sim`/`packages/protocol` test. This task
adds exactly 5 tests of its own (2 in `scaffold.test.ts`, 3 in
`transport.test.ts` after Step 7's addition) — confirm the total increases by
exactly 5 relative to whatever `npm test` reported immediately before this
task started, rather than trusting one absolute number stated here: Tasks 1–2
already changed `packages/sim`'s count from Plan 1's 477, and Tasks 3–10 have
each added their own tests to `packages/protocol` by the time this task runs,
so no single absolute figure in this brief can stay accurate across the whole
plan.

- [ ] **Step 12: Commit**

```bash
git add packages/net/package.json packages/net/tsconfig.json \
        packages/net/src/index.ts packages/net/src/transport.ts \
        packages/net/test/scaffold.test.ts packages/net/test/transport.test.ts \
        package-lock.json
git commit -m "feat(net): scaffold the @tapkart/net workspace and the Transport interface

Mirrors @tapkart/sim's package.json/tsconfig.json shape exactly:
'exports' mapping only '.', a barrel that starts empty and is widened
to re-export transport.ts by the end of this same task (contract §3:
'Task 11's scaffold creates it re-exporting ./transport'), no
devDependencies beyond the root's hoisted vitest and typescript.
Depends on @tapkart/sim and @tapkart/protocol.

Transport is the one seam above which nothing knows which of WebRTC,
WebSocket or Loopback is in use: six methods, two channels named
'unreliable' and 'reliable' via protocol's ChannelName, imported as
'@tapkart/protocol' -- protocol's own barrel has re-exported ChannelName
since Task 3, so net never reaches across the package boundary with a
relative path.

transport.ts has no runtime code, so its RED/GREEN is checked with tsc
--noEmit, not vitest run: a type-only import of a missing module is
erased by this project's esbuild transform before resolution and would
otherwise pass silently, confirmed by direct experiment. The barrel
widening carries the same trap: net's own index.ts re-exports only a
type, so its RED is a second, independent tsc diagnostic (TS2305),
resolved by its own dedicated step rather than folded silently into
transport.ts's."
```
