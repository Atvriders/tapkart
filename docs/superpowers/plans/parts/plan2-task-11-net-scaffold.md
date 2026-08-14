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
  - `packages/protocol/src/types.ts` [Task 3] — `export type ChannelName =
    'unreliable' | 'reliable'`. **Reached by a relative import
    (`'../../protocol/src/types'`), not the `@tapkart/protocol` package
    specifier, and this is load-bearing, not a style choice:** the contract's
    module map lists `packages/protocol/src/index.ts` as **[Task 18]** — the
    same shared barrel task that also fills in `packages/net/src/index.ts`
    (see below). By the time this task runs, Tasks 3–9 have executed and
    `packages/protocol/src/types.ts` exists on disk with `ChannelName`
    exported, but `packages/protocol/src/index.ts` is still the empty `export
    {}` stub — mirroring exactly how `packages/sim/src/index.ts` stayed
    `export {}` from Task 1 until Task 2 filled it. `packages/protocol`'s
    `package.json` almost certainly mirrors `packages/sim`'s (`"exports": {
    ".": "./src/index.ts" }`, nothing else), by the same pattern this task
    itself follows below — which means resolving `@tapkart/protocol` as a
    bare specifier before Task 18 lands would hit that still-empty barrel and
    find no `ChannelName` at all. A plain relative path bypasses the package
    "exports" map entirely (that map only governs bare-specifier resolution
    through `node_modules`) and reaches the real file directly, which is why
    it is the correct choice here, not merely a workaround. *I could not
    literally open `packages/protocol/package.json` to confirm this — it
    does not exist yet in this repo. This is a structural inference from the
    contract's own task labels, stated as such rather than as a verified
    fact.*

- Produces:
  - Workspace `@tapkart/net` at `packages/net`, `"type": "module"`, exporting
    `"."` as `./src/index.ts`, depending on `@tapkart/sim` and
    `@tapkart/protocol`.
  - `packages/net/src/index.ts` — an empty barrel (`export {}`), exactly
    mirroring Task 1's role for `packages/sim`. The shared Task 18 (see the
    contract's module map: both `packages/protocol/src/index.ts` and
    `packages/net/src/index.ts` are labeled **[Task 18]**) replaces its body
    with real re-exports once every `net` module exists.
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
import type { ChannelName } from '../../protocol/src/types'

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
})
```

- [ ] **Step 8: Run the typecheck to verify it fails**

Run: `npx tsc --noEmit -p packages/net`

Expected: exactly one diagnostic — `test/transport.test.ts(2,30): error
TS2307: Cannot find module '../src/transport' or its corresponding type
declarations.` (the line/column will differ slightly depending on exact
formatting, but the code and message are `TS2307` /
`Cannot find module '../src/transport' or its corresponding type
declarations.`).

**Do not** run `npx vitest run packages/net/test/transport.test.ts` and
expect it to fail — it will not. Every reference to `Transport` in this test
file is a type-only import and a type position; under this project's
`verbatimModuleSyntax` + Vite/esbuild transform, that import is erased
entirely before module resolution happens, so the test collects and passes
even though `transport.ts` does not exist. This was confirmed directly by
experiment, not assumed. `tsc` is the only oracle for this step.

- [ ] **Step 9: Implement `packages/net/src/transport.ts`**

Create `packages/net/src/transport.ts`:

```ts
import type { ChannelName } from '../../protocol/src/types'

/**
 * One interface, three implementations (WebRTC, WebSocket, Loopback). Spec
 * §5: "Nothing above the transport layer knows which implementation is in
 * use." Two channels, named by the exact strings 'unreliable' and 'reliable'
 * -- ChannelName is imported from protocol, not redefined here.
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

- [ ] **Step 10: Run both checks to verify they pass**

Run:

```bash
npx tsc --noEmit -p packages/net
npx vitest run packages/net/test/transport.test.ts
```

Expected: `tsc` reports no diagnostics. `vitest` reports `Test Files 1 passed
(1)`, `Tests 2 passed (2)` — now meaningfully, since `Transport` resolves to
a real interface and the object literals in the test are structurally
checked against it by `tsc` in the step above.

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
alongside every existing `packages/sim` test — 477 from Plan 1 plus this
task's 4.

- [ ] **Step 12: Commit**

```bash
git add packages/net/package.json packages/net/tsconfig.json \
        packages/net/src/index.ts packages/net/src/transport.ts \
        packages/net/test/scaffold.test.ts packages/net/test/transport.test.ts \
        package-lock.json
git commit -m "feat(net): scaffold the @tapkart/net workspace and the Transport interface

Mirrors @tapkart/sim's package.json/tsconfig.json shape exactly:
'exports' mapping only '.', an empty barrel until the shared Task 18
fills it in, no devDependencies beyond the root's hoisted vitest and
typescript. Depends on @tapkart/sim and @tapkart/protocol.

Transport is the one seam above which nothing knows which of WebRTC,
WebSocket or Loopback is in use: six methods, two channels named
'unreliable' and 'reliable' via protocol's ChannelName. Reached by a
relative import into packages/protocol/src/types rather than the
package specifier, because protocol's own barrel is deferred to the
same Task 18 that fills this package's -- resolving '@tapkart/protocol'
before then would hit an empty module.

transport.ts has no runtime code, so its RED/GREEN is checked with tsc
--noEmit, not vitest run: a type-only import of a missing module is
erased by this project's esbuild transform before resolution and would
otherwise pass silently, confirmed by direct experiment."
```
