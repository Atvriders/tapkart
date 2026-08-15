### Task 23: the five adapters, `src/main.ts`, and the esbuild bundle

Everything before this task is pure and fully tested against fakes. This task is
the thin layer that hands plain data to real syscalls — and the composition root
that wires the pure layer together.

**The one loopback bind lives here** (§0b, F-P4-46). The rule for this repository
is **"no *external* network in tests"**, not "no network", and exactly one test
may bind a socket:

```
packages/server/test/runtime-smoke.test.ts
  › 'the composition root answers /healthz and completes a WebSocket upgrade on an ephemeral loopback port'
```

It exists because without it `runtime/http.ts` + `runtime/ws.ts` + `main.ts` is
**the one thing CI never executes**, and untested composition roots are where
this project has repeatedly found its gaps: the host had no local input path at
all and nobody noticed for a whole plan. An ephemeral loopback bind is hermetic
and leaves the machine untouched. `packages/server/test/no-network.test.ts` greps
every *other* test file for `listen(`, `createServer`, `new WebSocket` and
`fetch(` and fails on a hit, which is what keeps "exactly one" true.

That smoke test asserts **nothing** about rooms, routing, racing, promotion or
the lobby. All of those are asserted in the pure layer against fakes. It asserts
the process starts, `GET /healthz` returns 200, a WebSocket upgrade on `WS_PATH`
completes, and `close()` resolves — that the wiring exists at all.

**An adapter contains no decisions.** No branching on game or room state, no
arithmetic beyond unit conversion, no policy. Where one of these files switches,
it is switching on a value the **pure** layer returned (`Route`), which is
exactly the shape Plan 3 §0a fixed for `render`. If one of these files needs a
conditional that is a decision, the decision belongs upstream.

**Steps 6 and 7 are not TDD and do not pretend to be.** An esbuild config and a
manifest have no meaningful failing test; each states the exact command and what
the operator must see.

**Execution order.** Everything else in `packages/server/src` must exist first:
this task imports `parseConfig`, `RoomRegistry`, `RoomHub`, `defaultContentProvider`,
`makeRateLimiter`, `formatLogEvent`, `resolveRoute`, `safeJoin` and `WS_PATH`.

**Files:**
- Create: `packages/server/src/runtime/clock.ts`
- Create: `packages/server/src/runtime/random.ts`
- Create: `packages/server/src/runtime/files.ts`
- Create: `packages/server/src/runtime/ws.ts`
- Create: `packages/server/src/runtime/http.ts`
- Create: `packages/server/src/main.ts`
- Create: `packages/server/scripts/build-server.mjs`
- Modify: `packages/server/package.json` (scripts and the `ws` pin)
- Modify: `package.json` (root: `build:server`, and `esbuild` as a devDependency)
- Test: `packages/server/test/runtime-smoke.test.ts`
- Test: `packages/server/test/no-network.test.ts`
- Test: `packages/server/test/import-direction.test.ts`

**Interfaces:**

- Consumes — `@tapkart/net` [§4.1]:
  ```ts
  export type SocketData = string | Uint8Array
  export type SocketReadyState = 'connecting' | 'open' | 'closing' | 'closed'
  export interface SocketLike {
    send(data: SocketData): void
    close(code?: number, reason?: string): void
    onMessage(cb: (data: SocketData) => void): void
    onClose(cb: (code: number) => void): void
    readyState(): SocketReadyState
    bufferedAmount(): number
  }
  ```

- Consumes — the server's own pure layer:
  ```ts
  // src/env.ts
  export interface ServerConfig {
    port: number; bindHost: string; staticRoot: string; maxRooms: number
    maxPeersPerRoom: number; roomIdleMs: number; joinRateLimit: RateLimitConfig
    iceServers: readonly IceServerConfig[]; shadowEnabled: boolean
  }
  export function parseConfig(env: Readonly<Record<string, string | undefined>>): ServerConfig
  // src/random.ts
  export type RandomSource = (bytes: number) => Uint8Array
  // src/registry.ts
  export class RoomRegistry { constructor(opts: RegistryOptions) }
  // src/hub.ts
  export class RoomHub {
    constructor(deps: HubDeps)
    attach(socket: SocketLike, nowMs: number): PeerHandle
    poll(nowMs: number): void
    registry(): RoomRegistry
    close(): void
  }
  // src/content.ts
  export const defaultContentProvider: ContentProvider
  // src/ratelimit.ts
  export function makeRateLimiter(cfg: RateLimitConfig): RateLimiter
  // src/log.ts
  export interface LogSink { write(ev: LogEvent, nowMs: number): void }
  export function formatLogEvent(ev: LogEvent, nowMs: number): string
  // src/static.ts
  export const WS_PATH = '/ws'
  export type Route = /* seven members, none of them a redirect */
  export function resolveRoute(method: string, pathname: string): Route
  export function safeJoin(root: string, relPath: string): string | null
  ```

- Produces — the eleven §5.14 pins:
  ```ts
  // src/runtime/clock.ts   ADAPTER -- the only Date.now() and the only timer
  export function realNowMs(): number
  export interface Scheduler { start(intervalMs: number, cb: (nowMs: number) => void): void; stop(): void }
  export function makeIntervalScheduler(): Scheduler
  export const POLL_INTERVAL_MS = 8
  // src/runtime/random.ts  ADAPTER -- the only node:crypto
  export const nodeRandomSource: RandomSource
  // src/runtime/files.ts   ADAPTER -- the only node:fs and node:path
  export function readFileBytes(path: string): Uint8Array | null
  export function fileExists(path: string): boolean
  // src/runtime/ws.ts      ADAPTER -- the only `ws` import
  export function wrapWsSocket(raw: unknown): SocketLike
  // src/runtime/http.ts    ADAPTER -- the only node:http
  export interface HttpServerHandle { port(): number; close(): Promise<void> }
  export function startHttpServer(cfg: ServerConfig, hub: RoomHub, nowMs: () => number): Promise<HttpServerHandle>
  // src/main.ts            ADAPTER -- composition root
  export function main(env: Readonly<Record<string, string | undefined>>): Promise<HttpServerHandle>
  ```

**Three decisions this task makes:**

1. **`main.ts` self-starts only when it is the process entry point.** The
   container runs `node dist/main.mjs`, so the bundle must start a server on its
   own; the smoke test imports `main` and calls it, so importing must **not**
   start one. The guard is `import.meta.url === pathToFileURL(process.argv[1]).href`,
   which is false under vitest and true under `node dist/main.mjs`.
2. **The scheduler's interval is `unref`'d.** The process is kept alive by the
   listening socket, not by the heartbeat. Without this a closed server would
   still hold the event loop open and the smoke test would hang instead of
   finishing — and a hung test is indistinguishable from a slow one.
3. **`main.ts` writes log lines to stdout through `formatLogEvent`.** §5.11
   exports only `nullLogSink` and `makeMemoryLogSink`, because a stdout sink is
   an I/O concern and belongs at the composition root. It contains no branch: one
   formatted line per event.

---

- [ ] **Step 1: Write the failing smoke test**

Create `packages/server/test/runtime-smoke.test.ts`:

```ts
import { expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { WS_PATH } from '../src/static'
import { main } from '../src/main'

/**
 * THE ONE LOOPBACK BIND (§0b, F-P4-46). The rule is "no EXTERNAL network in
 * tests", not "no network", and this is the only test in the repository allowed
 * to bind a socket. It binds 127.0.0.1:0 -- an OS-assigned ephemeral port -- so
 * it is hermetic and leaves the machine untouched. `no-network.test.ts` greps
 * every other test file and fails if a second one appears.
 *
 * It asserts NOTHING about rooms, routing, racing, promotion or the lobby: all
 * of those are asserted in the pure layer against fakes. It asserts that the
 * composition root composes at all, which is otherwise the one thing CI never
 * executes -- and untested composition roots are where this project has
 * repeatedly found its gaps.
 */
it('the composition root answers /healthz and completes a WebSocket upgrade on an ephemeral loopback port', async () => {
  const handle = await main({ PORT: '0', BIND_HOST: '127.0.0.1' })

  const port = handle.port()
  expect(port).toBeGreaterThan(0)

  const health = await fetch('http://127.0.0.1:' + String(port) + '/healthz')
  expect(health.status).toBe(200)
  expect(await health.text()).toContain('ok')

  const socket = new WebSocket('ws://127.0.0.1:' + String(port) + WS_PATH)
  await new Promise<void>((resolve, reject) => {
    socket.on('open', () => { resolve() })
    socket.on('error', (err) => { reject(err) })
  })
  expect(socket.readyState).toBe(WebSocket.OPEN)
  socket.close()

  await expect(handle.close()).resolves.toBeUndefined()
}, 20_000)
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run packages/server/test/runtime-smoke.test.ts`

Expected: FAIL at collection with
`Failed to resolve import "../src/main" from "packages/server/test/runtime-smoke.test.ts". Does the file exist?`

- [ ] **Step 3: Write the five adapters**

Create `packages/server/src/runtime/clock.ts`:

```ts
// ADAPTER. The only Date.now() and the only setInterval in packages/server.
// Nothing here decides anything: it reads a clock and drives a callback.

export function realNowMs(): number {
  return Date.now()
}

export interface Scheduler {
  start(intervalMs: number, cb: (nowMs: number) => void): void
  stop(): void
}

/**
 * ONE scheduler for the whole process, not one timer per room: the
 * rooms-per-process budget is spent on step(), and N timers would spend it on
 * the event loop instead.
 */
export function makeIntervalScheduler(): Scheduler {
  let handle: ReturnType<typeof setInterval> | null = null
  return {
    start(intervalMs: number, cb: (nowMs: number) => void): void {
      handle = setInterval(() => { cb(realNowMs()) }, intervalMs)
      // The listening socket keeps the process alive, not the heartbeat. Without
      // this a closed server still holds the event loop open, and a hung process
      // is indistinguishable from a slow one.
      handle.unref()
    },
    stop(): void {
      if (handle === null) return
      clearInterval(handle)
      handle = null
    },
  }
}

/**
 * 125 Hz. The hub polls FASTER than the sim ticks on purpose: the accumulator
 * turns a jittery 8 ms timer into exact 60 Hz steps, and a poll slower than the
 * tick makes every room permanently behind.
 */
export const POLL_INTERVAL_MS = 8
```

Create `packages/server/src/runtime/random.ts`:

```ts
// ADAPTER. The only node:crypto in the repository.
import { randomBytes } from 'node:crypto'
import type { RandomSource } from '../random'

export const nodeRandomSource: RandomSource = (bytes: number): Uint8Array =>
  new Uint8Array(randomBytes(bytes))
```

Create `packages/server/src/runtime/files.ts`:

```ts
// ADAPTER. The only node:fs in the repository. It reads static bytes for the
// HTTP handler, and that is all: nothing in this server reads a directory or
// parses a file, because R46 makes the track content a static import.
import { readFileSync, statSync } from 'node:fs'

/** null for anything unreadable -- absent, a directory, or denied. */
export function readFileBytes(path: string): Uint8Array | null {
  try {
    const buf = readFileSync(path)
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
  } catch {
    return null
  }
}

export function fileExists(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}
```

Create `packages/server/src/runtime/ws.ts`:

```ts
// ADAPTER. The only `ws` import in the repository. Node has no built-in
// WebSocket SERVER -- Node 20's global WebSocket is a client -- and hand-rolling
// RFC 6455 framing to keep the dependency count at zero would be the least
// defensible line of code in the project.
import type { RawData, WebSocket as WsSocket } from 'ws'
import type { SocketData, SocketLike, SocketReadyState } from '@tapkart/net'

const READY_STATES: readonly SocketReadyState[] = ['connecting', 'open', 'closing', 'closed']

/** Type conversion only: `ws` hands back a Buffer (or a list of them, when a
 *  message arrived fragmented) and `SocketData` is a string or a Uint8Array. */
function toSocketData(data: RawData, isBinary: boolean): SocketData {
  const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBufferView | ArrayBuffer)
  return isBinary ? new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength) : buf.toString('utf8')
}

export function wrapWsSocket(raw: unknown): SocketLike {
  const socket = raw as WsSocket
  return {
    send(data: SocketData): void {
      socket.send(data)
    },
    close(code?: number, reason?: string): void {
      socket.close(code, reason)
    },
    onMessage(cb: (data: SocketData) => void): void {
      socket.on('message', (data: RawData, isBinary: boolean) => { cb(toSocketData(data, isBinary)) })
    },
    onClose(cb: (code: number) => void): void {
      socket.on('close', (code: number) => { cb(code) })
    },
    readyState(): SocketReadyState {
      return READY_STATES[socket.readyState] ?? 'closed'
    },
    bufferedAmount(): number {
      return socket.bufferedAmount
    },
  }
}
```

Create `packages/server/src/runtime/http.ts`:

```ts
// ADAPTER. The only node:http in the repository. Every routing decision is
// resolveRoute's -- this file translates the Route it returns into a response
// and makes none of its own.
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { WebSocketServer } from 'ws'
import type { ServerConfig } from '../env'
import type { RoomHub } from '../hub'
import { resolveRoute, safeJoin } from '../static'
import { readFileBytes } from './files'
import { wrapWsSocket } from './ws'

export interface HttpServerHandle {
  port(): number
  close(): Promise<void>
}

const TEXT = new TextEncoder()
const HEALTH_BODY = TEXT.encode('{"ok":true}\n')
const NOT_FOUND_BODY = TEXT.encode('not found\n')
const NOT_ALLOWED_BODY = TEXT.encode('method not allowed\n')
const UPGRADE_BODY = TEXT.encode('upgrade required\n')
const PLAIN = 'text/plain; charset=utf-8'
const HTML = 'text/html; charset=utf-8'

function send(
  req: IncomingMessage, res: ServerResponse, status: number, contentType: string, body: Uint8Array,
): void {
  res.writeHead(status, { 'Content-Type': contentType, 'Content-Length': String(body.byteLength) })
  // HEAD carries the headers and no body. Protocol mechanics, not policy.
  if (req.method === 'HEAD') res.end()
  else res.end(body)
}

function sendFile(
  cfg: ServerConfig, req: IncomingMessage, res: ServerResponse, relPath: string, contentType: string,
): void {
  const full = safeJoin(cfg.staticRoot, relPath)
  const bytes = full === null ? null : readFileBytes(full)
  if (bytes === null) {
    // An absent file is a 404 by design. In particular
    // /.well-known/assetlinks.json does not exist until Plan 5 generates it, and
    // a placeholder there would fail App Links verification SILENTLY where a 404
    // at least fails visibly to anyone who looks.
    send(req, res, 404, PLAIN, NOT_FOUND_BODY)
    return
  }
  send(req, res, 200, contentType, bytes)
}

function pathnameOf(url: string): string {
  const q = url.indexOf('?')
  return q < 0 ? url : url.slice(0, q)
}

function serve(cfg: ServerConfig, req: IncomingMessage, res: ServerResponse): void {
  const route = resolveRoute(req.method ?? 'GET', pathnameOf(req.url ?? '/'))
  switch (route.kind) {
    case 'health':
      send(req, res, 200, 'application/json', HEALTH_BODY)
      return
    case 'websocket':
      send(req, res, 426, PLAIN, UPGRADE_BODY)
      return
    case 'methodNotAllowed':
      send(req, res, 405, PLAIN, NOT_ALLOWED_BODY)
      return
    case 'notFound':
      send(req, res, 404, PLAIN, NOT_FOUND_BODY)
      return
    case 'file':
      sendFile(cfg, req, res, route.relPath, route.contentType)
      return
    case 'wellKnown':
      // Served exactly as addressed: no trailing-slash normalisation, no HSTS
      // upgrade, no redirect of any kind. `Route` cannot express one.
      sendFile(cfg, req, res, route.relPath, route.contentType)
      return
    case 'spa':
      sendFile(cfg, req, res, 'index.html', HTML)
      return
    default: {
      const unreachable: never = route
      return unreachable
    }
  }
}

function portOf(server: Server): number {
  const address = server.address()
  return typeof address === 'object' && address !== null ? address.port : 0
}

export function startHttpServer(
  cfg: ServerConfig, hub: RoomHub, nowMs: () => number,
): Promise<HttpServerHandle> {
  const server = createServer((req, res) => { serve(cfg, req, res) })
  const wss = new WebSocketServer({ noServer: true })

  server.on('upgrade', (req, socket, head) => {
    if (resolveRoute('GET', pathnameOf(req.url ?? '/')).kind !== 'websocket') {
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (raw) => { hub.attach(wrapWsSocket(raw), nowMs()) })
  })

  return new Promise<HttpServerHandle>((resolve) => {
    server.listen(cfg.port, cfg.bindHost, () => {
      resolve({
        port: () => portOf(server),
        close: () => new Promise<void>((done) => {
          for (const client of wss.clients) client.terminate()
          wss.close(() => { server.close(() => { done() }) })
        }),
      })
    })
  })
}
```

- [ ] **Step 4: Write `packages/server/src/main.ts`**

```ts
// ADAPTER -- the composition root. It wires the five adapters into RoomHub and
// starts ONE scheduler. It performs no syscall of its own and makes no decision,
// which is why §8.2 lists it apart from the adapters.
import { pathToFileURL } from 'node:url'
import { parseConfig } from './env'
import { RoomRegistry } from './registry'
import { RoomHub } from './hub'
import { defaultContentProvider } from './content'
import { makeRateLimiter } from './ratelimit'
import type { LogEvent, LogSink } from './log'
import { formatLogEvent } from './log'
import { POLL_INTERVAL_MS, makeIntervalScheduler, realNowMs } from './runtime/clock'
import { nodeRandomSource } from './runtime/random'
import type { HttpServerHandle } from './runtime/http'
import { startHttpServer } from './runtime/http'

/** One formatted line per event. §5.11 exports only the null and memory sinks,
 *  because writing to a stream is an I/O concern and belongs here. */
const stdoutLogSink: LogSink = {
  write(ev: LogEvent, nowMs: number): void {
    process.stdout.write(formatLogEvent(ev, nowMs) + '\n')
  },
}

export function main(env: Readonly<Record<string, string | undefined>>): Promise<HttpServerHandle> {
  const config = parseConfig(env)

  const hub = new RoomHub({
    config,
    registry: new RoomRegistry({
      maxRooms: config.maxRooms,
      maxPeersPerRoom: config.maxPeersPerRoom,
      roomIdleMs: config.roomIdleMs,
      rand: nodeRandomSource,
    }),
    content: defaultContentProvider,
    rand: nodeRandomSource,
    log: stdoutLogSink,
    // F-P4-34: keyed by ROOM CODE, never by anything derived from an address.
    failedJoins: makeRateLimiter(config.joinRateLimit),
  })

  const scheduler = makeIntervalScheduler()
  scheduler.start(POLL_INTERVAL_MS, (nowMs) => { hub.poll(nowMs) })

  return startHttpServer(config, hub, realNowMs).then((server) => ({
    port: (): number => server.port(),
    close: async (): Promise<void> => {
      scheduler.stop()
      hub.close()
      await server.close()
    },
  }))
}

// The container runs `node dist/main.mjs`, so the bundle must start a server on
// its own -- and the smoke test imports `main` and calls it, so importing must
// not. `process.argv[1]` is the vitest entry under test and this file under
// node, which is exactly the distinction needed.
const entry = process.argv[1]
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  void main(process.env).then((handle) => {
    process.stdout.write('tapkart server listening on port ' + String(handle.port()) + '\n')
  })
}
```

- [ ] **Step 5: Run the smoke test to verify it passes**

Run: `npx vitest run packages/server/test/runtime-smoke.test.ts`
Expected: 1 passing, and the process exits rather than hanging.

If it hangs, the scheduler's `unref()` is missing or `close()` does not stop it —
fix that rather than adding a timeout.

- [ ] **Step 6: Write the two standing guards**

Create `packages/server/test/no-network.test.ts`:

```ts
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const PACKAGES = join(import.meta.dirname, '..', '..')

/** The one test permitted to bind a socket (§0b), and this file itself, which
 *  necessarily names the needles it looks for. */
const EXEMPT = new Set(['runtime-smoke.test.ts', 'no-network.test.ts'])

const NEEDLES = ['listen(', 'createServer', 'new WebSocket', 'fetch(']

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (entry.name.endsWith('.ts')) out.push(full)
  }
}

describe('no external network in tests', () => {
  it('leaves exactly one test able to open a socket', () => {
    const files: string[] = []
    for (const pkg of readdirSync(PACKAGES, { withFileTypes: true })) {
      if (!pkg.isDirectory()) continue
      const testDir = join(PACKAGES, pkg.name, 'test')
      if (existsSync(testDir)) walk(testDir, files)
    }
    // The floor: a broken walker would pass this test with zero files read.
    expect(files.length).toBeGreaterThan(5)

    const hits: string[] = []
    for (const file of files) {
      const base = file.slice(file.lastIndexOf('/') + 1)
      if (EXEMPT.has(base)) continue
      const text = readFileSync(file, 'utf8')
      for (const needle of NEEDLES) {
        if (text.includes(needle)) hits.push(base + ' contains ' + needle)
      }
    }
    expect(hits).toEqual([])
  })
})
```

Create `packages/server/test/import-direction.test.ts`:

> **If this file already exists from an earlier task, extend its table rather
> than replacing it.** Two copies of a rule that is meant to have one home is the
> defect this test exists to prevent.

```ts
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(import.meta.dirname, '..', '..', '..')

/** Spec §3's dependency direction, as data. §8.4. */
const ALLOWED: Readonly<Record<string, readonly string[]>> = {
  sim: [],
  protocol: ['@tapkart/sim'],
  net: ['@tapkart/sim', '@tapkart/protocol'],
  content: ['@tapkart/sim'],
  render: ['@tapkart/sim', '@tapkart/content', 'three'],
  game: ['@tapkart/sim', '@tapkart/protocol', '@tapkart/net', '@tapkart/content', '@tapkart/render', '@tapkart/invite'],
  invite: ['@tapkart/protocol'],
  server: ['@tapkart/sim', '@tapkart/protocol', '@tapkart/net', '@tapkart/content'],
  web: ['@tapkart/game', '@tapkart/render'],
}

/** `node:*` and `ws` are importable ONLY from these paths. */
function mayImportHost(pkg: string, file: string): boolean {
  if (pkg !== 'server') return false
  return file.includes('/src/runtime/') || file.endsWith('/src/main.ts')
}

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (entry.name.endsWith('.ts')) out.push(full)
  }
}

function specifiersOf(text: string): string[] {
  const out: string[] = []
  const re = /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g
  let m: RegExpExecArray | null = re.exec(text)
  while (m !== null) {
    out.push(m[1])
    m = re.exec(text)
  }
  return out
}

describe('import direction (§8.4)', () => {
  it('lets no package import what spec §3 forbids it', () => {
    const roots: { pkg: string; dir: string }[] = []
    for (const group of ['packages', 'apps']) {
      const groupDir = join(ROOT, group)
      if (!existsSync(groupDir)) continue
      for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const src = join(groupDir, entry.name, 'src')
        if (existsSync(src)) roots.push({ pkg: entry.name, dir: src })
      }
    }
    expect(roots.length).toBeGreaterThan(0)      // the floor

    const violations: string[] = []
    let checked = 0

    for (const root of roots) {
      const allowed = ALLOWED[root.pkg]
      if (allowed === undefined) continue        // a package no ruling covers yet
      const files: string[] = []
      walk(root.dir, files)
      for (const file of files) {
        checked += 1
        const posix = file.split('\\').join('/')
        for (const spec of specifiersOf(readFileSync(file, 'utf8'))) {
          if (spec.startsWith('.')) {
            // A relative path INTO another package is the one violation no other
            // check would catch.
            if (spec.includes('../../')) violations.push(posix + ' -> ' + spec)
            continue
          }
          if (spec.startsWith('node:') || spec === 'ws') {
            if (!mayImportHost(root.pkg, posix)) violations.push(posix + ' -> ' + spec)
            continue
          }
          if (!allowed.includes(spec)) violations.push(posix + ' -> ' + spec)
        }
      }
    }

    expect(checked).toBeGreaterThan(20)          // the floor
    // Ten lines that make spec §3's dependency direction mechanically checkable
    // -- including that `server` never reaches `three`, `game` or `render`, which
    // is otherwise enforced by discipline alone. A server that imports `three`
    // is a server that fails to start on a headless box.
    expect(violations).toEqual([])
  })
})
```

Run: `npx vitest run packages/server/test/no-network.test.ts packages/server/test/import-direction.test.ts`
Expected: 2 passing.

- [ ] **Step 7: Add the two scripts, install esbuild, and write the bundle — verification, not TDD**

**`ws` and `@types/ws` are already pinned**, caret-free, by the scaffold task,
which installed them with `--save-exact` and asserts the *shape* of the pin.
Do not re-pin them and do not type a version number anywhere. Confirm:

```bash
node -e "const p=require('./packages/server/package.json');console.log(p.dependencies.ws, p.devDependencies['@types/ws'])"
```
Expected: two bare `x.y.z` versions with no `^` and no `~`. If either is missing,
the scaffold task has not landed — run it rather than adding them here.

Add the two `scripts` §10.1 pins that name files **this** task creates, leaving
the rest of `packages/server/package.json` untouched:

```jsonc
"scripts": {
  "typecheck": "tsc --noEmit -p tsconfig.json",
  "build": "node scripts/build-server.mjs",
  "start": "node dist/main.mjs"
}
```

`"bench"` is **not** added here: it names `bench/rooms.ts`, which this task does
not create, and §8.3 makes the benchmark something the owner runs and CI never
does. The script line belongs beside the file it runs.

Then install esbuild at the root — a **declared** root devDependency, because
relying on a transitive Vite dependency for a binary you execute is how a major
bump breaks the deploy (P5 Q30):

```bash
npm install
npm install -D --save-exact esbuild
```

Add to the **root** `package.json` (leave `workspaces`, `vitest.config.ts` and
everything else alone):

```jsonc
"scripts": {
  "build:server": "npm run build -w @tapkart/server"
}
```

Create `packages/server/scripts/build-server.mjs`. **Every option in it is
load-bearing:**

```js
// One esbuild bundle, one file (C-5, F-P4-6). Shipping an experimental Node flag
// as the production entry point is a liability with no upside, and `tsc` emit
// means maintaining a second module-resolution story for one package.
import * as esbuild from 'esbuild'

await esbuild.build({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/main.mjs',
  bundle: true,
  platform: 'node',
  target: 'node20',           // root `engines` says >=20
  format: 'esm',
  sourcemap: true,
  // `ws` lazily require()s these two native accelerators inside try/catch. They
  // are optional, they are not installed, and bundling them fails the build.
  external: ['bufferutil', 'utf-8-validate'],
  // ESM has no `require`, so ws's guarded require() throws ReferenceError instead
  // of the MODULE_NOT_FOUND its catch expects -- the socket layer then dies at
  // the first frame, in production only. This banner is the fix.
  banner: { js: "import { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);" },
})
```

The bundle **embeds all six tracks**: `@tapkart/content` uses static JSON
imports, esbuild's default `json` loader inlines them, and the running server
opens no content file. That is why `TRACKS_DIR` does not exist.

**Verify — the exact commands and what you must see:**

```bash
npm run build:server
ls -l packages/server/dist/main.mjs packages/server/dist/main.mjs.map
```
Expected: both files exist, `main.mjs` is on the order of a megabyte (it contains
six tracks and `ws`), and esbuild printed no warnings.

```bash
grep -c 'caldera' packages/server/dist/main.mjs
```
Expected: a non-zero count — the track JSON really is inlined, so the container
needs no content directory.

```bash
PORT=0 BIND_HOST=127.0.0.1 node packages/server/dist/main.mjs
```
Expected: one line on stdout, `tapkart server listening on port <N>` with a
non-zero N, and the process stays up. In a second terminal:

```bash
curl -si http://127.0.0.1:<N>/healthz | head -3
curl -si http://127.0.0.1:<N>/.well-known/assetlinks.json | head -3
```
Expected: the first is `HTTP/1.1 200 OK` with `Content-Type: application/json`.
The second is `HTTP/1.1 404 Not Found` — **and it must not be a 301, 302, 307 or
308, and there must be no `Location:` header**, because Plan 5's file does not
exist yet and a redirect here is spec §2's silent App Links failure. Stop the
server with Ctrl-C.

- [ ] **Step 8: Run the whole suite**

Run: `npm test`
Expected: every package green, no browser started, and the run terminates on its
own.

Run: `npx tsc --noEmit -p packages/server/tsconfig.json`
Expected: no output.

- [ ] **Step 9: Commit**

```bash
git add packages/server/src/runtime packages/server/src/main.ts \
        packages/server/scripts/build-server.mjs packages/server/package.json package.json \
        package-lock.json \
        packages/server/test/runtime-smoke.test.ts packages/server/test/no-network.test.ts \
        packages/server/test/import-direction.test.ts
git commit -m "feat(server): the five adapters, the composition root, and the bundle

Five adapters, each the only place in the repository that names its syscall:
Date.now and setInterval, node:crypto, node:fs, ws, node:http. None of them
decides anything -- runtime/http.ts switches on the Route resolveRoute
returned and makes no routing decision of its own.

runtime-smoke.test.ts is the ONE test permitted to bind a socket, at
127.0.0.1:0 (F-P4-46). The rule is no EXTERNAL network in tests, not no
network. Without it the composition root is the one thing CI never executes,
and untested composition roots are where this project has repeatedly found
its gaps -- the host had no local input path at all and nobody noticed for a
whole plan. It asserts only that the wiring exists: healthz 200, a completed
upgrade, a resolved close. no-network.test.ts greps every other test file so
'exactly one' stays true, and import-direction.test.ts makes spec §3's
dependency direction mechanical repo-wide.

The server ships as one esbuild bundle (C-5): fastest start, no experimental
Node flag as a production entry point, and all six tracks inlined so the
container opens no content file. Plan 5's Dockerfile consumes dist/main.mjs;
Plan 4 ships no container."
```
