### Task 2: `PROTOCOL_VERSION` goes to 2, and the close code that crosses the boundary

**Files:**
- Modify: `packages/protocol/src/types.ts` — the `PROTOCOL_VERSION` line and its docstring
- Modify: `packages/protocol/test/types.test.ts` — three assertions and one `it` name that pin version 1
- Modify: `packages/protocol/test/barrel.test.ts` — one assertion that pins version 1
- Create: `packages/net/src/socket.ts` — contract §4.1, complete
- Modify: `packages/net/src/index.ts` — one `export *` line
- Modify: `packages/net/test/barrel.test.ts` — the surface pin gains one module
- Test: `packages/protocol/test/version.test.ts` (new)
- Test: `packages/net/test/socket.test.ts` (new)

**This task is small and it is a hinge.** `ROOM_CODE_LENGTH` went 4 → 5 (F-P4-34), which changes `hello`'s bit layout by five bits. That is a **breaking wire change**, so version 1 and version 2 cannot interoperate at all. F-P4-11's *"adding tags is additive"* is true of the two new tags and false of the room code, and the two land in the same release.

The rejection path is the part that must be right. `decodeHeader` already throws on a version mismatch and `net`'s shipped `createDatagramGuard` turns that into a counted drop — correct everywhere except one place: a v1 client's `hello` would be dropped **silently** and the player would watch a spinner forever. Contract §3.0 settles it:

> The version check for `hello` happens **before** the guard. `RoomHub`'s frame handler reads `data[1]` directly — a fixed offset in a fixed-format 2-byte header, stable across every version this protocol will ever have — and on a mismatch it logs `rejected { versionMismatch }` and closes the socket with **`WS_CLOSE_VERSION_MISMATCH = 4001`**. **A close code crosses versions; an encoded `welcome` does not.**

So this task ships both halves: the bump, and the constant the rejection travels on. Shipping the bump without the close code would leave every mismatched client hanging, which is the exact failure this task exists to prevent.

**Interfaces:**

- **Consumes** — `packages/protocol/src/types.ts` as it stands today, quoted so nothing is edited from memory:

  ```ts
  export const PROTOCOL_VERSION = 1

  export const WIRE_TAG = {
    hello: 0x01, welcome: 0x02, lobby: 0x03, start: 0x04, clientUpdate: 0x05,
    input: 0x10, snapshot: 0x11, events: 0x12, checkpoint: 0x13, resyncRequest: 0x14,
    authorityChange: 0x20, ping: 0x30, pong: 0x31,
  } as const

  export type MessageKind =
    | 'hello' | 'welcome' | 'lobby' | 'start' | 'clientUpdate'
    | 'input' | 'snapshot' | 'events' | 'checkpoint' | 'resyncRequest'
    | 'authorityChange' | 'ping' | 'pong'

  export interface WireHeader { kind: MessageKind; protocolVersion: number }

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
  ```

  **Only the `PROTOCOL_VERSION` line changes.** `encodeHeader`, `decodeHeader`, `WIRE_TAG`, `MessageKind` and `WireHeader` are untouched — the two functions already read the constant, so the whole wire moves with it.

  From `@tapkart/protocol/src/room.ts` (shipped, Task 15c item E), the cause of the bump:

  ```ts
  export const ROOM_CODE_LENGTH = 5
  ```

  From `packages/net/src/index.ts` today, the nine `export *` lines this task inserts into:

  ```ts
  export * from './clock'
  export * from './transport'
  export * from './loopback'
  export * from './apply'
  export * from './authority'
  export * from './client'
  export * from './shadow'
  export * from './local'
  export * from './receive'
  ```

- **Produces:**

  ```ts
  // packages/protocol/src/types.ts
  export const PROTOCOL_VERSION = 2

  // packages/net/src/socket.ts — PURE (interface and constants only). Contract §4.1.
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

  **This task creates the whole of `socket.ts`, all six exports** — contract §11's census fixes `net/socket` at exactly 6, and §4.1 specifies every one of them. The `WebSocketTransport` task consumes `SocketLike` and does not re-create the file; the `ws` and browser adapters wrap into it. Nothing else in this task's files may add a seventh export.

---

- [ ] **Step 1: Write the failing tests**

Create `packages/protocol/test/version.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { PROTOCOL_VERSION, WIRE_TAG, decodeHeader, encodeHeader } from '../src/types'
import type { MessageKind } from '../src/types'
import { ROOM_CODE_LENGTH } from '../src/room'

/**
 * THE VERSION BOUNDARY.
 *
 * `ROOM_CODE_LENGTH` went 4 -> 5 (F-P4-34), which changes `hello`'s bit layout
 * by five bits. That is a breaking wire change, so v1 and v2 cannot interoperate
 * and the version byte must say so. F-P4-11's "adding tags is additive" is true
 * of `clientUpdate` and `resyncRequest` and FALSE of the room code, and the two
 * land in the same release.
 *
 * The assertions below are byte-level on purpose. The whole rejection path in
 * contract §3.0 rests on one physical fact - that the version lives at
 * `data[1]`, at a fixed offset, in a fixed-format 2-byte header, for every
 * message kind and every version this protocol will ever have. `RoomHub` reads
 * that byte BEFORE the datagram guard, because a v1 `hello` dropped silently by
 * the guard is a player watching a spinner forever. A test that only asserted
 * `PROTOCOL_VERSION === 2` would say nothing about the offset the rejection
 * depends on.
 */

const ALL_KINDS: MessageKind[] = [
  'hello', 'welcome', 'lobby', 'start', 'clientUpdate',
  'input', 'snapshot', 'events', 'checkpoint', 'resyncRequest',
  'authorityChange', 'ping', 'pong',
]

describe('PROTOCOL_VERSION 2', () => {
  it('is 2, because five-character room codes moved hello by five bits', () => {
    expect(PROTOCOL_VERSION).toBe(2)
    // The cause, asserted beside the effect. If ROOM_CODE_LENGTH ever changes
    // again, this pair is what says the version must move with it.
    expect(ROOM_CODE_LENGTH).toBe(5)
    expect(ROOM_CODE_LENGTH * 5).toBe(25) // hello's roomCode field, in bits
  })

  it('writes [tag, 2] for all thirteen kinds - exact bytes, exact offsets', () => {
    expect(ALL_KINDS).toHaveLength(13)
    for (const kind of ALL_KINDS) {
      const out = new Uint8Array(4).fill(0xff)
      expect(encodeHeader(out, kind), `${kind}: header is not 2 bytes`).toBe(2)
      // Byte for byte, and the tag is quoted from WIRE_TAG rather than restated,
      // because relabelling a tag is Task 15c's business and not this test's.
      expect(Array.from(out.subarray(0, 2)), `${kind}: wrong header bytes`)
        .toEqual([WIRE_TAG[kind], 2])
      // encodeHeader writes only its own two bytes.
      expect(out[2]).toBe(0xff)
    }
  })

  it('puts the version at index 1 for every kind, which is what makes the pre-guard read legal', () => {
    // §3.0's RoomHub reads `data[1]` DIRECTLY, before the datagram guard and
    // before any decode. That is only sound because the offset does not vary by
    // kind and cannot vary by version. This walks all thirteen and asserts it.
    for (const kind of ALL_KINDS) {
      const frame = new Uint8Array(2)
      encodeHeader(frame, kind)
      expect(frame[1], `${kind}: the version byte is not at index 1`).toBe(PROTOCOL_VERSION)
    }
  })

  it('rejects a version-1 frame of every kind, and the version is readable without decoding it', () => {
    for (const kind of ALL_KINDS) {
      // Exactly the bytes a v1 client puts on the wire.
      const v1 = new Uint8Array([WIRE_TAG[kind], 1])
      // The pre-guard read: no decode, no throw, just a byte.
      expect(v1[1], `${kind}: a v1 frame does not read as version 1 at index 1`).toBe(1)
      expect(() => decodeHeader(v1), `${kind}: a v1 frame was accepted`)
        .toThrow(/protocol version mismatch/)
    }
  })

  it('accepts exactly one version byte out of all 256, for a valid tag', () => {
    // The whole code space, not a spot check. A decoder that accepted a RANGE of
    // versions, or that compared with `>=`, passes a two-value test and fails
    // here - and a peer built next year speaking v3 must be rejected by this
    // build exactly as v1 is.
    const accepted: number[] = []
    for (let v = 0; v < 256; v++) {
      const frame = new Uint8Array([WIRE_TAG.hello, v])
      try {
        const h = decodeHeader(frame)
        expect(h.kind).toBe('hello')
        expect(h.protocolVersion).toBe(v)
        accepted.push(v)
      } catch {
        // rejected, which is the expected outcome for 255 of the 256
      }
    }
    expect(accepted).toEqual([2])
  })

  it('checks the tag before the version, so an unknown tag reports as an unknown tag', () => {
    // Order matters for the log line: `rejected { versionMismatch }` must not be
    // written for a frame whose tag byte is garbage, or a deploy's real symptom
    // is buried under noise from a port scanner.
    const bogus = new Uint8Array([0x99, 1])
    expect(() => decodeHeader(bogus)).toThrow(/unknown wire tag/)
  })
})
```

Create `packages/net/test/socket.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  WS_CLOSE_BACKPRESSURE,
  WS_CLOSE_ROOM_CLOSED,
  WS_CLOSE_VERSION_MISMATCH,
} from '../src/socket'
import type { SocketData, SocketLike, SocketReadyState } from '../src/socket'

/**
 * The application close codes, and the interface every real WebSocket wraps
 * into.
 *
 * 4001 is not a tidy enum member. It is the ONLY channel that crosses a protocol
 * version boundary intact: two peers that cannot agree on a header format can
 * still agree on a 16-bit close code, because RFC 6455 puts it in the frame and
 * not in the payload. That is why the version rejection in contract §3.0 is a
 * close and not a `welcome` - an encoded `welcome` is exactly the thing a
 * mismatched peer cannot read. `RoomClient` maps 4001 onto
 * `error = 'versionMismatch'`, which is what puts "this app is out of date" on
 * the screen instead of a hang, and P5 Q25 (never auto-`skipWaiting`) makes that
 * a ROUTINE event after every deploy rather than an exotic one.
 */

describe('net/socket close codes', () => {
  it('fixes the three application codes at their contract values', () => {
    expect(WS_CLOSE_VERSION_MISMATCH).toBe(4001)
    expect(WS_CLOSE_ROOM_CLOSED).toBe(4002)
    expect(WS_CLOSE_BACKPRESSURE).toBe(4003)
  })

  it('keeps every code inside 4000-4999 and out of every range that is not ours', () => {
    const codes = [WS_CLOSE_VERSION_MISMATCH, WS_CLOSE_ROOM_CLOSED, WS_CLOSE_BACKPRESSURE]
    for (const c of codes) {
      expect(Number.isInteger(c)).toBe(true)
      // 4000-4999 is the range RFC 6455 reserves for private use. Below 4000 is
      // either RFC-defined (1000-1015) or IANA-registered (3000-3999), and a
      // browser rejects a close code outside 3000-4999 with an InvalidAccessError
      // - so a wrong number here is not a mislabel, it is a close that does not
      // happen and a socket that stays open.
      expect(c, `${c} is outside the 4000-4999 private range`).toBeGreaterThanOrEqual(4000)
      expect(c, `${c} is outside the 4000-4999 private range`).toBeLessThanOrEqual(4999)
    }
    // Distinct, in both directions: two codes that collide make one of the two
    // client-side error messages unreachable and nothing fails anywhere.
    expect(new Set(codes).size).toBe(3)
  })

  it('pins SocketLike at exactly six members', () => {
    // keyof, not a cast: this is the whole of what a WebSocket is to everything
    // above the adapter, and both `ws` on the server and the browser's global
    // wrap into it. A renamed member is a transport that compiles and never
    // delivers.
    const surface: (keyof SocketLike)[] =
      ['send', 'close', 'onMessage', 'onClose', 'readyState', 'bufferedAmount']
    expect(surface).toHaveLength(6)
    expect(new Set(surface).size).toBe(6)
  })

  it('carries both frame payload shapes and all four ready states', () => {
    // A WebSocket frame is natively text or binary, and SocketData preserves
    // that: §4.4's signalling rides text while every WIRE_TAG message rides
    // binary, so nothing needs a discriminator byte to tell them apart.
    const text: SocketData = 'offer'
    const binary: SocketData = new Uint8Array([1, 2, 3])
    expect(typeof text).toBe('string')
    expect(binary).toBeInstanceOf(Uint8Array)

    const states: SocketReadyState[] = ['connecting', 'open', 'closing', 'closed']
    expect(new Set(states).size).toBe(4)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/protocol/test/version.test.ts packages/net/test/socket.test.ts`

Expected: **FAIL**, two files, two distinct causes.

`packages/net/test/socket.test.ts` fails to collect:

```
Error: Failed to load url ../src/socket (resolved id: .../packages/net/src/socket) in .../packages/net/test/socket.test.ts. Does the file exist?
```

`packages/protocol/test/version.test.ts` collects and fails its first test:

```
AssertionError: expected 1 to be 2 // Object.is equality
 ❯ packages/protocol/test/version.test.ts  expect(PROTOCOL_VERSION).toBe(2)
```

with the remaining five tests in that file failing on the version byte (`expected [ 1, 1 ] to deeply equal [ 1, 2 ]` from the exact-bytes test, and `expected [ 1 ] to deeply equal [ 2 ]` from the code-space walk).

- [ ] **Step 3: Write the implementation**

In `packages/protocol/src/types.ts`, replace the single line

```ts
export const PROTOCOL_VERSION = 1
```

with:

```ts
/**
 * TWO, not one, and the bump is not optional.
 *
 * ROOM_CODE_LENGTH went 4 -> 5 (F-P4-34), which moves every field after
 * `hello`'s room code by five bits. That is a BREAKING wire change: a v1 peer
 * and a v2 peer decode different messages out of the same bytes, and both of
 * them find something plausible there. F-P4-11's "adding tags is additive" is
 * true of `clientUpdate` and `resyncRequest` and false of the room code, and
 * the two land in the same release.
 *
 * `decodeHeader` below throws on a mismatch and @tapkart/net's shipped guard
 * turns that into a counted, dropped datagram - which is right everywhere
 * except for `hello`, where a silent drop is a player watching a spinner
 * forever. The server therefore reads `data[1]` DIRECTLY, before the guard
 * (contract §3.0), and closes the socket with WS_CLOSE_VERSION_MISMATCH = 4001.
 * A close code crosses a version boundary; an encoded `welcome` does not.
 *
 * The byte's offset is what makes that legal: index 1, in a fixed-format 2-byte
 * header, for every kind and every version this protocol will ever have.
 */
export const PROTOCOL_VERSION = 2
```

Create `packages/net/src/socket.ts`. **Six exports and no imports** — `ChannelName` belongs to `@tapkart/protocol` and re-exporting it here would make `net`'s barrel ambiguous, which drops the name from the ESM namespace object silently rather than reporting it:

```ts
// PURE - interface and constants only. No socket, no timer, no clock, no
// branching on room or game state. Contract §4.1.

/**
 * A WebSocket frame is natively text OR binary, and preserving that is what
 * makes signalling free: §4.4's SDP/ICE envelopes ride text while every
 * WIRE_TAG message rides binary, so nothing needs a discriminator byte to tell
 * the two apart.
 */
export type SocketData = string | Uint8Array

export type SocketReadyState = 'connecting' | 'open' | 'closing' | 'closed'

/**
 * The whole of what a WebSocket is, to everything above the adapter.
 *
 * `ws` on the server and the browser's global WebSocket both wrap into this,
 * and a test's fake pair implements it in forty lines with no network - which
 * is the entire reason `WebSocketTransport` can be pure and CI can exercise
 * every byte of it headlessly (contract §0a).
 *
 * `onMessage` and `onClose` APPEND a listener; they never replace one. That is
 * the same rule `Transport` states (§2.1 rule 1) and it is load-bearing for the
 * same reason: on a guest, more than one consumer subscribes to the same
 * socket, and replace-semantics silently deletes whichever subscribed first.
 *
 * `onClose` carries the code because `RoomClient` maps 4001 onto
 * `error = 'versionMismatch'` and 4002 onto `'roomClosed'` - the entire
 * mechanism by which a client that cannot even parse the server's messages
 * still learns why it was disconnected.
 */
export interface SocketLike {
  send(data: SocketData): void
  close(code?: number, reason?: string): void
  onMessage(cb: (data: SocketData) => void): void
  onClose(cb: (code: number) => void): void
  readyState(): SocketReadyState
  bufferedAmount(): number
}

/**
 * Application close codes. 4000-4999 is the range RFC 6455 reserves for private
 * use; 1000-1015 are the RFC's own and 3000-3999 are IANA-registered, and a
 * browser throws InvalidAccessError for anything outside 3000-4999 - so a code
 * from the wrong range is not a mislabelled close, it is a close that never
 * happens and a socket that stays open.
 *
 * A CLOSE CODE IS THE ONLY CHANNEL THAT CROSSES A PROTOCOL VERSION BOUNDARY
 * INTACT. It travels in the frame rather than the payload, so two peers that
 * cannot agree on a header format still agree on it - see contract §3.0, where
 * this is the reason the version rejection is a close and not a `welcome`.
 */
export const WS_CLOSE_VERSION_MISMATCH = 4001
export const WS_CLOSE_ROOM_CLOSED = 4002
export const WS_CLOSE_BACKPRESSURE = 4003
```

In `packages/net/src/index.ts`, insert one line immediately after `export * from './transport'`:

```ts
export * from './clock'
export * from './transport'
export * from './socket'
export * from './loopback'
```

- [ ] **Step 4: Retire the four assertions that pinned version 1, and widen the two barrel pins**

These are the only places in the repository that hard-code the old value. Each edit is one line; find them by the surrounding text quoted here rather than by line number, which has already moved once in this file's history.

In `packages/protocol/test/types.test.ts` — three edits:

```ts
// before
  it('fixes PROTOCOL_VERSION at 1', () => {
    expect(PROTOCOL_VERSION).toBe(1)
  })
// after
  it('fixes PROTOCOL_VERSION at 2', () => {
    // The bump itself, and why, are pinned in test/version.test.ts.
    expect(PROTOCOL_VERSION).toBe(2)
  })
```

```ts
// before, inside it('builds a WireHeader for every MessageKind the contract lists')
      expect(h.protocolVersion).toBe(1)
// after
      expect(h.protocolVersion).toBe(2)
```

```ts
// before, inside it('resolves through the package entry point')
    expect(pkg.PROTOCOL_VERSION).toBe(1)
// after
    expect(pkg.PROTOCOL_VERSION).toBe(2)
```

In `packages/protocol/test/barrel.test.ts` — one edit, inside `it('carries the contract constants through unchanged')`:

```ts
// before
    expect(PROTOCOL_VERSION).toBe(1)
// after
    expect(PROTOCOL_VERSION).toBe(2)
```

`WIRE_TAG`'s thirteen values in that same test are **unchanged** — no tag moves, which is exactly what F-P4-11 promised.

In `packages/net/test/barrel.test.ts` — six edits, all mechanical, because `socket.ts` is a new module in `src/` and that file pins the surface exactly in both directions:

1. Add three names to the existing `import type { ... } from '../src/index'` block, keeping the file's per-module comment style:

   ```ts
     // socket [Plan 4]
     SocketData,
     SocketLike,
     SocketReadyState,
   ```

2. Add a namespace import beside the others, in alphabetical position:

   ```ts
   import * as socketNs from '../src/socket'
   ```

3. Add one entry to `SURFACE`, immediately after the `transport` entry:

   ```ts
     // [Plan 4] the three application close codes. SocketLike, SocketData and
     // SocketReadyState are types and contribute nothing at runtime.
     socket: ['WS_CLOSE_BACKPRESSURE', 'WS_CLOSE_ROOM_CLOSED', 'WS_CLOSE_VERSION_MISMATCH'],
   ```

4. Add `'socket'` to `BARREL_MODULES`, in the order `src/index.ts` now lists them:

   ```ts
   const BARREL_MODULES = [
     'clock', 'transport', 'socket', 'loopback', 'apply', 'authority', 'client', 'shadow', 'local', 'receive',
   ]
   ```

5. Add one entry to `NAMESPACES`, in the same position:

   ```ts
     ['socket', socketNs],
   ```

6. Add three fields to `NetTypeSurface` and three to `TYPE_SURFACE`, and update the sorted literal in `it('pins the type-only surface at compile time')`:

   ```ts
   interface NetTypeSurface {
     // ...existing eight...
     SocketData: SocketData
     SocketLike: SocketLike
     SocketReadyState: SocketReadyState
   }
   const TYPE_SURFACE: Record<keyof NetTypeSurface, true> = {
     // ...existing eight...
     SocketData: true,
     SocketLike: true,
     SocketReadyState: true,
   }
   ```

   ```ts
     it('pins the type-only surface at compile time', () => {
       expect(Object.keys(TYPE_SURFACE).sort()).toEqual([
         'DatagramGuard', 'LocalInputTransport', 'LoopbackOptions', 'RemoteEntitySample',
         'RemoteKeyframe', 'RemoteSample', 'SocketData', 'SocketLike', 'SocketReadyState',
         'TickAccumulator', 'Transport',
       ])
     })
   ```

- [ ] **Step 5: Run the tests to verify they pass**

Run the two new files first:

`npx vitest run packages/protocol/test/version.test.ts packages/net/test/socket.test.ts`

Expected: **10 passed** (6 + 4).

Then the whole suite, because a version bump touches every encoded byte in the repository:

```bash
npx vitest run
npm run typecheck --workspaces --if-present
```

Expected: **no failures**, and specifically these must all still pass unchanged —

- `packages/net/test/malformed.test.ts` builds its bad frame as `[WIRE_TAG.input, PROTOCOL_VERSION + 1]`, which is now 3 and is still an invalid version. It reads the constant rather than a literal, which is why it needs no edit.
- `packages/net/test/shadow.test.ts` asserts `decodeHeader(buf)` yields `{ kind: 'authorityChange', protocolVersion: PROTOCOL_VERSION }` — symbolic, so it moves with the constant. `AUTHORITY_CHANGE_BYTES` stays 10: the version byte changed value, not width.
- Every codec round-trip test in `packages/protocol/test/` encodes and decodes with the same build, so none of them observes the version at all.

If any test fails asserting a literal `1`, it is a fifth copy this task did not find. Fix it the same way — read the constant, never the number — and add it to Step 4's list.

- [ ] **Step 6: Commit**

```bash
git add packages/protocol/src/types.ts packages/protocol/test/types.test.ts packages/protocol/test/barrel.test.ts packages/protocol/test/version.test.ts packages/net/src/socket.ts packages/net/src/index.ts packages/net/test/barrel.test.ts packages/net/test/socket.test.ts && git commit -m "feat(protocol,net): PROTOCOL_VERSION 2 and the close code that crosses the boundary"
```
