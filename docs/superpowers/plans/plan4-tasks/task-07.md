### Task 7: `packages/net/src/socket.ts` — the seam, plus the fake socket pair that proves it is one

**Files:**
- Create: `packages/net/src/socket.ts`
- Create: `packages/net/test/fixtures/socket-fixtures.ts`
- Create: `packages/net/test/socket.test.ts`
- Modify: `packages/net/src/index.ts` (one `export *` line)
- Modify: `packages/net/test/barrel.test.ts` (the pinned public surface)
- Test: `packages/net/test/socket.test.ts`

> **If Task 2 has already landed, read this first — it creates two of these files.**
> Task 2 (`PROTOCOL_VERSION` → 2) ships `packages/net/src/socket.ts` in full, its
> barrel wiring, and a `packages/net/test/socket.test.ts` of its own, because it
> needs `WS_CLOSE_VERSION_MISMATCH` for the version-rejection path. When that has
> happened:
>
> - **`packages/net/src/socket.ts`** — do not recreate it. Verify it exports
>   exactly the six names below with exactly these values and no seventh, and
>   move on. If it diverges, §4.1's shape as written here is what the contract
>   fixes and the divergence is the bug.
> - **`packages/net/test/socket.test.ts`** — the path collides. **Append this
>   task's two `describe` blocks to the existing file** (the block names differ,
>   so they coexist) and merge the imports. Overwriting either way loses real
>   coverage: Task 2's blocks pin the close codes and the `SocketLike` member
>   list, this task's pin the fixture that every transport test depends on.
> - **The barrel edits in Step 5** — skip any that are already present. The
>   barrel test asserts each `export *` line appears **exactly once**, so a
>   duplicated line is a failure rather than a no-op.
>
> `packages/net/test/fixtures/socket-fixtures.ts` is this task's alone in either
> order, and Task 9 and Task 19b both consume it by relative path.

**`src/socket.ts` is PURE** (contract §0a) and in the strongest possible sense: it
declares an interface and three integers, and contributes **no runtime behaviour
at all** beyond those three constants. There is nothing here to get wrong except
the numbers and the shape — which is the point. It is the seam that keeps
`websocket.ts` (Task 9) testable with no network.

**The adapter this seam exists to isolate is `packages/net/src/websocket-browser.ts`**
— `export function browserWebSocket(url: string): SocketLike`, the only file in
`net` that names the global `WebSocket`. **It is not this task's** (contract §8.2
lists it as one of the seven adapter files), it is never imported by any test,
and it is deliberately absent from the barrel. The server's `ws` adapter,
`packages/server/src/runtime/ws.ts`, is the other implementation and is likewise
someone else's. This task ships the interface both of them satisfy and the
in-memory pair every test uses instead.

**`test/fixtures/socket-fixtures.ts` is a test fixture** and is created here
rather than in Task 9 for one reason: an interface-only module cannot be tested
by itself, and a task that shipped `SocketLike` with no implementation would be
shipping an assertion-free file. The fixture **is** the executable spec of the
seam, and Task 9 consumes it unchanged.

---

**Interfaces:**

**Consumes** — nothing. `socket.ts` imports no module, from this package or any
other. `SocketData` deliberately does not reference a DOM type: `tsconfig.base.json`
sets `"lib": ["ES2022"]` with no DOM, and Plan 3's R35 forbids a per-package
override on `net`.

**Produces** — `packages/net/src/socket.ts`, exactly six exported names
(contract §4.1, §11's census row `net/socket | 6` — three types and the three
close codes):

```ts
export type SocketData = string | Uint8Array
export type SocketReadyState = 'connecting' | 'open' | 'closing' | 'closed'
export interface SocketLike {
  send(data: SocketData): void
  close(code?: number, reason?: string): void
  onMessage(cb: (data: SocketData) => void): void   // appends, never replaces
  onClose(cb: (code: number) => void): void         // appends, never replaces
  readyState(): SocketReadyState
  bufferedAmount(): number
}
export const WS_CLOSE_VERSION_MISMATCH = 4001
export const WS_CLOSE_ROOM_CLOSED      = 4002
export const WS_CLOSE_BACKPRESSURE     = 4003
```

**Produces** — `packages/net/test/fixtures/socket-fixtures.ts`, the two fixtures
contract §9.1 pins, at exactly these signatures:

```ts
export function makeFakeSocketPair(): {
  a: SocketLike; b: SocketLike; flush(): void; stall(bytes: number): void; drain(): void
}
export function makeRecordingSocket(): SocketLike & {
  sentBinary(): Uint8Array[]; sentText(): string[]
  deliver(data: SocketData): void; fireClose(code: number): void
}
```

**Three properties of this seam that later tasks depend on:**

- **Text and binary stay distinct.** A WebSocket frame is natively one or the
  other and `SocketData` preserves that, so §4.4's signalling rides text while
  every `WIRE_TAG` message rides binary and **nothing needs a discriminator
  byte**. A fixture that stringified a `Uint8Array` would make that split
  untestable, so `socket.test.ts` asserts it directly.
- **`onClose` carries the code.** It is the only channel that crosses a protocol
  version boundary intact (§3.0): an encoded `welcome` cannot, so a client that
  cannot parse the server's messages still learns *why* — `RoomClient` maps 4001
  onto `error = 'versionMismatch'` and 4002 onto `'roomClosed'`.
- **`bufferedAmount()` is on the interface because F-P4-44's mailbox needs it.**
  Without it there is no way to model a socket that has stopped draining, and
  §4.3's latest-wins mailbox would be untestable. `stall()`/`drain()` on the pair
  exist to drive exactly this number.

---

- [ ] **Step 1: Write the failing test**

Create `packages/net/test/fixtures/socket-fixtures.ts`:

```ts
import type { SocketData, SocketLike, SocketReadyState } from '../../src/socket'

interface Core {
  socket: SocketLike
  messageCbs: Array<(data: SocketData) => void>
  closeCbs: Array<(code: number) => void>
  outbox: SocketData[]
  sentBinary: Uint8Array[]
  sentText: string[]
  setBuffered(n: number): void
  deliver(data: SocketData): void
  fireClose(code: number): void
  deliverable(): boolean
  /** The far end, when this socket is half of a pair. */
  peer: Core | null
}

function copyData(data: SocketData): SocketData {
  return typeof data === 'string' ? data : data.slice()
}

function makeCore(): Core {
  const messageCbs: Array<(data: SocketData) => void> = []
  const closeCbs: Array<(code: number) => void> = []
  const outbox: SocketData[] = []
  const sentBinary: Uint8Array[] = []
  const sentText: string[] = []
  let state: SocketReadyState = 'open'
  let buffered = 0

  const core: Core = {
    socket: {
      send(data: SocketData): void {
        if (state === 'closed') return
        if (typeof data === 'string') {
          sentText.push(data)
          buffered += data.length
        } else {
          // Recorded as a copy: the transport under test is entitled to reuse
          // its send buffer, so a retained view would show a test the bytes of
          // whatever was framed LAST and every assertion about frame N would
          // silently be an assertion about the newest one.
          sentBinary.push(data.slice())
          buffered += data.byteLength
        }
        outbox.push(copyData(data))
      },
      close(code?: number, _reason?: string): void {
        if (state === 'closed') return
        outbox.length = 0
        const c = code ?? 1000
        core.fireClose(c)
        // A real close reaches the far end, and the conformance harness's
        // dropB() is exactly that: the peer must learn, or nothing above this
        // fixture can ever see a socket die.
        if (core.peer && core.peer.deliverable()) core.peer.fireClose(c)
      },
      onMessage(cb: (data: SocketData) => void): void {
        messageCbs.push(cb)
      },
      onClose(cb: (code: number) => void): void {
        closeCbs.push(cb)
      },
      readyState(): SocketReadyState {
        return state
      },
      bufferedAmount(): number {
        return buffered
      },
    },
    messageCbs,
    closeCbs,
    outbox,
    sentBinary,
    sentText,
    setBuffered(n: number): void {
      buffered = n
    },
    deliver(data: SocketData): void {
      if (state === 'closed') return
      // A copy of the list: a callback that registers another callback (every
      // loop in this package does, at construction) must not mutate the list
      // being iterated.
      for (const cb of [...messageCbs]) cb(data)
    },
    fireClose(code: number): void {
      state = 'closed'
      for (const cb of [...closeCbs]) cb(code)
    },
    deliverable(): boolean {
      return state !== 'closed'
    },
    peer: null,
  }
  return core
}

export function makeFakeSocketPair(): {
  a: SocketLike
  b: SocketLike
  flush(): void
  stall(bytes: number): void
  drain(): void
} {
  const ca = makeCore()
  const cb = makeCore()
  ca.peer = cb
  cb.peer = ca

  return {
    a: ca.socket,
    b: cb.socket,
    flush(): void {
      // Both directions, until quiescent: a delivered frame may provoke a reply,
      // and a test whose ordering assertions depended on how many times it
      // called flush() would be measuring the fixture rather than the transport.
      for (let round = 0; round < 8; round++) {
        if (ca.outbox.length === 0 && cb.outbox.length === 0) return
        const fromA = ca.outbox.splice(0, ca.outbox.length)
        const fromB = cb.outbox.splice(0, cb.outbox.length)
        for (const data of fromA) cb.deliver(data)
        for (const data of fromB) ca.deliver(data)
      }
      throw new Error('makeFakeSocketPair.flush: still delivering after 8 rounds')
    },
    /** Drives bufferedAmount() on BOTH ends, which is what makes §4.3's mailbox
     *  testable at all: there is no other way to model a socket that has stopped
     *  draining. Sends still queue and still arrive on flush() - a stalled socket
     *  is slow, not disconnected. */
    stall(bytes: number): void {
      ca.setBuffered(bytes)
      cb.setBuffered(bytes)
    },
    drain(): void {
      ca.setBuffered(0)
      cb.setBuffered(0)
    },
  }
}

export function makeRecordingSocket(): SocketLike & {
  sentBinary(): Uint8Array[]
  sentText(): string[]
  deliver(data: SocketData): void
  fireClose(code: number): void
} {
  const core = makeCore()
  return {
    send: (data) => core.socket.send(data),
    close: (code, reason) => core.socket.close(code, reason),
    onMessage: (cb) => core.socket.onMessage(cb),
    onClose: (cb) => core.socket.onClose(cb),
    readyState: () => core.socket.readyState(),
    bufferedAmount: () => core.socket.bufferedAmount(),
    sentBinary: () => core.sentBinary,
    sentText: () => core.sentText,
    deliver: (data) => core.deliver(data),
    fireClose: (code) => core.fireClose(code),
  }
}
```

Create `packages/net/test/socket.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { SocketData } from '../src/socket'
import {
  WS_CLOSE_BACKPRESSURE,
  WS_CLOSE_ROOM_CLOSED,
  WS_CLOSE_VERSION_MISMATCH,
} from '../src/socket'
import * as socketNs from '../src/socket'
import { makeFakeSocketPair, makeRecordingSocket } from './fixtures/socket-fixtures'

describe('net/socket - the application close codes', () => {
  it('sits inside RFC 6455\'s private 4000-4999 range, with no two codes equal', () => {
    const codes = [WS_CLOSE_VERSION_MISMATCH, WS_CLOSE_ROOM_CLOSED, WS_CLOSE_BACKPRESSURE]
    expect(codes).toEqual([4001, 4002, 4003])
    expect(new Set(codes).size).toBe(3)
    for (const c of codes) {
      expect(c).toBeGreaterThanOrEqual(4000)
      expect(c).toBeLessThanOrEqual(4999)
    }
  })

  it('contributes exactly three runtime names, because everything else here is a type', () => {
    // The whole point of this module is that it is erased: SocketLike is the
    // seam, and a runtime helper appearing here later would be a decision no
    // adapter test could see.
    expect(Object.keys(socketNs).sort()).toEqual([
      'WS_CLOSE_BACKPRESSURE',
      'WS_CLOSE_ROOM_CLOSED',
      'WS_CLOSE_VERSION_MISMATCH',
    ])
  })
})

describe('net/socket - the fixture pair IS the executable spec of SocketLike', () => {
  it('appends message listeners rather than replacing them, and preserves order', () => {
    const pair = makeFakeSocketPair()
    const seen: string[] = []
    pair.b.onMessage((d) => seen.push(`first:${String(d)}`))
    pair.b.onMessage((d) => seen.push(`second:${String(d)}`))

    pair.a.send('hello')
    pair.flush()

    expect(seen).toEqual(['first:hello', 'second:hello'])
  })

  it('appends close listeners and hands both the code', () => {
    const s = makeRecordingSocket()
    const codes: number[] = []
    s.onClose((c) => codes.push(c))
    s.onClose((c) => codes.push(c * 10))

    s.fireClose(WS_CLOSE_VERSION_MISMATCH)

    expect(codes).toEqual([4001, 40010])
    expect(s.readyState()).toBe('closed')
  })

  it('keeps text and binary distinct, which is the whole channel split', () => {
    // §4.1: signalling rides text, every WIRE_TAG message rides binary, and
    // nothing needs a discriminator byte. A fixture that stringified a
    // Uint8Array would make that split untestable and every signalling test
    // would pass against a transport that got it wrong.
    const pair = makeFakeSocketPair()
    const got: SocketData[] = []
    pair.b.onMessage((d) => got.push(d))

    pair.a.send('{"v":1}')
    pair.a.send(new Uint8Array([0x11, 0x02, 0x7f]))
    pair.flush()

    expect(got).toHaveLength(2)
    expect(typeof got[0]).toBe('string')
    expect(got[0]).toBe('{"v":1}')
    expect(got[1]).toBeInstanceOf(Uint8Array)
    expect(Array.from(got[1] as Uint8Array)).toEqual([0x11, 0x02, 0x7f])
  })

  it('drives bufferedAmount from stall() and drain(), and still delivers while stalled', () => {
    const pair = makeFakeSocketPair()
    const got: SocketData[] = []
    pair.b.onMessage((d) => got.push(d))

    expect(pair.a.bufferedAmount()).toBe(0)
    pair.stall(1 << 21)
    expect(pair.a.bufferedAmount()).toBe(1 << 21)

    // A stalled socket is slow, not disconnected: the frame still arrives.
    pair.a.send(new Uint8Array([1, 2, 3]))
    pair.flush()
    expect(got).toHaveLength(1)

    pair.drain()
    expect(pair.a.bufferedAmount()).toBe(0)
  })

  it('closes both ends, so the far side can see a socket die', () => {
    const pair = makeFakeSocketPair()
    const aCodes: number[] = []
    const bCodes: number[] = []
    pair.a.onClose((c) => aCodes.push(c))
    pair.b.onClose((c) => bCodes.push(c))

    pair.b.close(WS_CLOSE_ROOM_CLOSED)

    expect(bCodes).toEqual([4002])
    expect(aCodes).toEqual([4002])
    expect(pair.a.readyState()).toBe('closed')

    // Idempotent, and nothing is delivered afterwards.
    const late: SocketData[] = []
    pair.b.onMessage((d) => late.push(d))
    pair.b.close(WS_CLOSE_ROOM_CLOSED)
    pair.a.send('too late')
    pair.flush()
    expect(bCodes).toEqual([4002])
    expect(late).toEqual([])
  })

  it('records what a transport sent, as copies rather than views', () => {
    const s = makeRecordingSocket()
    const scratch = new Uint8Array([0x00, 0x01, 0x02])
    s.send(scratch)
    // The sender reuses its buffer; a fixture holding a view would rewrite
    // history and every "frame 0 was X" assertion in this package would be an
    // assertion about the newest frame instead.
    scratch[0] = 0xff
    s.send('text')

    expect(s.sentBinary()).toHaveLength(1)
    expect(Array.from(s.sentBinary()[0])).toEqual([0x00, 0x01, 0x02])
    expect(s.sentText()).toEqual(['text'])
    expect(s.bufferedAmount()).toBe(3 + 'text'.length)
  })
})
```

Why these assertions and not others:

- **`Object.keys(socketNs)` is an exact set, not a spot check.** This module's
  value is that it is nearly all erased; the day someone adds a helper here is
  the day an adapter decision becomes invisible to CI, and this is the assertion
  that reports it.
- **The recording test mutates `scratch` after `send`.** A fixture that retained
  a view would then show every later assertion the *newest* bytes — the exact
  shape of "a test that cannot detect what it exists to detect", and one that
  would silently invalidate Task 9's entire mailbox suite.
- **The close test asserts BOTH ends.** §9.2's conformance harness needs a
  `dropB()` that makes `onPeerLost` fire, and for `WebSocketTransport` that *is*
  the socket dying. A fixture whose close was local-only would make that
  behaviour unobservable and the conformance suite would silently pass with the
  peer-loss path deleted.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/net/test/socket.test.ts`

Expected: FAIL, before any assertion runs, with

```
Error: Cannot find module '../src/socket' imported from '<repo>/packages/net/test/socket.test.ts'
Caused by: Error: Failed to load url ../src/socket (resolved id: ../src/socket) ... Does the file exist?
 Test Files  1 failed (1)
```

- [ ] **Step 3: Write the implementation**

Create `packages/net/src/socket.ts`:

```ts
/**
 * PURE (contract §0a): an interface and three integers. No import, from this
 * package or any other.
 *
 * The whole of what a WebSocket is, to everything above the adapter. Both `ws`
 * on the server (packages/server/src/runtime/ws.ts) and the browser's global
 * WebSocket (packages/net/src/websocket-browser.ts) wrap into this, and a test's
 * fake pair implements it in a hundred lines with no network - which is what
 * makes every byte of WebSocketTransport reachable from CI.
 *
 * No DOM type appears here on purpose: tsconfig.base.json sets "lib": ["ES2022"]
 * with no DOM, and pulling the DOM lib into `net` would pull it into the four
 * packages the server imports.
 */
export type SocketData = string | Uint8Array

export type SocketReadyState = 'connecting' | 'open' | 'closing' | 'closed'

export interface SocketLike {
  /**
   * Text vs binary is the channel split that makes signalling free: a WebSocket
   * frame is natively one or the other, SocketData preserves that, §4.4's
   * signalling rides text and every WIRE_TAG message rides binary. Nothing needs
   * a discriminator byte to tell them apart.
   */
  send(data: SocketData): void
  close(code?: number, reason?: string): void
  /** APPENDS a listener; never replaces one. Two independent consumers subscribe
   *  to the same socket on a guest, and replace-semantics would silently delete
   *  one of them. */
  onMessage(cb: (data: SocketData) => void): void
  /** APPENDS. Carries the CODE, because a close code is the only channel that
   *  crosses a protocol version boundary intact (§3.0): RoomClient maps 4001
   *  onto error = 'versionMismatch' and 4002 onto 'roomClosed', which is the
   *  entire mechanism by which a client that cannot even parse the server's
   *  messages still learns why it was disconnected. */
  onClose(cb: (code: number) => void): void
  readyState(): SocketReadyState
  /**
   * Bytes queued in the socket and not yet on the wire. On the interface because
   * F-P4-44's latest-wins mailbox is defined in terms of it: without a
   * back-pressure signal there is no way to tell a slow socket from a fast one,
   * and the mailbox would be untestable rather than merely untested.
   */
  bufferedAmount(): number
}

/**
 * Application close codes. RFC 6455 reserves 4000-4999 for private use, so these
 * can never collide with a protocol-level code the browser or `ws` generates.
 *
 * A close code is the ONLY channel that crosses a protocol version boundary
 * intact - see §3.0. An encoded `welcome` does not: a v1 client cannot decode a
 * v2 message to be told it is out of date, so it would watch a spinner forever.
 */
export const WS_CLOSE_VERSION_MISMATCH = 4001
export const WS_CLOSE_ROOM_CLOSED = 4002
export const WS_CLOSE_BACKPRESSURE = 4003
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/net/test/socket.test.ts`

Expected: `Test Files  1 passed (1)` / `Tests  8 passed (8)`.

- [ ] **Step 5: Add the module to the barrel, and to the barrel test that pins it**

`packages/net/test/barrel.test.ts` compares the package's runtime surface as an
**exact set in both directions** and separately asserts that every `.ts` file in
`src/` (bar `index.ts`) has an `export *` line. A new module that skips this step
turns that file red with *"a module was added to src/ without a line in the
barrel"* — it is not merely un-exported.

Five sibling Plan 4 tasks touch the same two files. **Insert into the lists; never
rewrite one.**

**Task 15 closes this barrel** (contract §4.11) and its list includes this module.
Wiring it here anyway is what keeps `npm test` green *between* tasks: the shipped
barrel test fails the moment a file exists in `src/` with no `export *` line, so
deferring every line to Task 15 leaves the suite red for the whole middle of the
plan. Task 15 then finds this line already present — and its own assertion that
each `export *` line appears **exactly once** is what catches a double-add, so
never add it twice.


In `packages/net/src/index.ts`, append:

```ts
export * from './socket'
```

In `packages/net/test/barrel.test.ts`:

```ts
// 1. beside the other namespace imports:
import * as socketNs from '../src/socket'

// 2. inside `import type { ... } from '../src/index'`:
  // socket [Plan 4 Task 7]
  SocketData,
  SocketLike,
  SocketReadyState,

// 3. in SURFACE, after the `receive` row:
  // [Plan 4 Task 7] the seam: everything else here is a type.
  socket: ['WS_CLOSE_BACKPRESSURE', 'WS_CLOSE_ROOM_CLOSED', 'WS_CLOSE_VERSION_MISMATCH'],

// 4. in BARREL_MODULES, in the order index.ts lists them:
  'socket'

// 5. in NAMESPACES:
  ['socket', socketNs],

// 6. in `interface NetTypeSurface` and in `const TYPE_SURFACE`:
  SocketData: SocketData        /  SocketData: true,
  SocketLike: SocketLike        /  SocketLike: true,
  SocketReadyState: SocketReadyState  /  SocketReadyState: true,

// 7. in the sorted literal inside "pins the type-only surface at compile time",
//    inserted in sorted position - the assertion is an exact sorted comparison,
//    so keep it sorted after a sibling task has added its own names:
  'SocketData', 'SocketLike', 'SocketReadyState',

// 8. in FIXTURES, so the new fixture module is covered by the leak check:
import * as socketFixtureNs from './fixtures/socket-fixtures'
  ['fixtures/socket-fixtures', socketFixtureNs],
```

- [ ] **Step 6: Verify the package, not just this file**

```bash
npx vitest run packages/net/test/socket.test.ts packages/net/test/barrel.test.ts
npx tsc --noEmit -p packages/net/tsconfig.json
npx vitest run
```

`tsc` is load-bearing: `TYPE_SURFACE` is a `Record<keyof NetTypeSurface, true>`,
so a type missing from either half is a **compile** error and not a test failure.

- [ ] **Step 7: Commit**

```bash
git add packages/net/src/socket.ts packages/net/test/socket.test.ts \
        packages/net/test/fixtures/socket-fixtures.ts \
        packages/net/src/index.ts packages/net/test/barrel.test.ts && \
git commit -m "feat(net): add SocketLike, the seam that keeps the WebSocket transport headless"
```
