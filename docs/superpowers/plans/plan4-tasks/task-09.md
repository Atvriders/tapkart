### Task 9: `packages/net/src/websocket.ts` — `WebSocketTransport`, pure over `SocketLike`

**Files:**
- Create: `packages/net/src/websocket.ts`
- Create: `packages/net/test/websocket.test.ts`
- Modify: `packages/net/src/index.ts` (one `export *` line)
- Modify: `packages/net/test/barrel.test.ts` (the pinned public surface)
- Test: `packages/net/test/websocket.test.ts`

**This module is PURE** (contract §0a). It never names a `WebSocket`, never reads
a clock and never allocates a socket: it takes a `SocketLike` and is a function
of what arrives on it. **Every byte of it is exercised by CI over a fake socket
pair** — the whole reason Task 7's seam exists.

**Its adapters are not this task's.** `packages/net/src/websocket-browser.ts`
(`export function browserWebSocket(url: string): SocketLike`, the only file in
`net` naming the global `WebSocket`) and `packages/server/src/runtime/ws.ts` (the
only file importing `ws`) are two of contract §8.2's seven adapter files. Neither
is imported by any test and neither is barrel-exported. Nothing in this task
should reference them.

---

**Interfaces:**

**Consumes** — from `@tapkart/protocol` (bare specifier, type-only):

```ts
export type ChannelName = 'unreliable' | 'reliable'
```

**Consumes** — from `./transport` (contract §2.1, quoted exactly; **Plan 4 changes
not one character of it**):

```ts
export interface Transport {
  send(channel: ChannelName, peerId: string, data: Uint8Array): void
  broadcast(channel: ChannelName, data: Uint8Array): void
  onMessage(cb: (peerId: string, channel: ChannelName, data: Uint8Array) => void): void
  onPeerLost(cb: (peerId: string) => void): void
  peers(): string[]
  close(): void
}
```

Six behaviours are part of that contract even though the interface does not state
them (§2.1, asserted for all five implementations by §9.2's conformance suite):
`onMessage` and `onPeerLost` **append**, never replace; `broadcast` reaches every
peer and never the sender; `send` to an unknown peer is a **no-op, not a throw**;
`close()` is idempotent and afterwards `peers()` is `[]` with nothing delivered
either way; delivered `data` is not retained past the callback.

**Consumes** — from `./socket` (Task 7):

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
export const WS_CLOSE_BACKPRESSURE = 4003
```

**Consumes** — from `./wsframe` (Task 8):

```ts
export const WS_FRAME_DATA = 0x00
export const WS_FRAME_CONTROL = 0x01
export const WS_SLOT_SERVER = 0x00
export const WS_SLOT_BROADCAST = 0xff
export const WS_CONTROL_PEER_JOINED = 0x00
export const WS_CONTROL_PEER_GONE = 0x01
export const WS_HEADER_BYTES = 3
export interface WsFrame {
  frameKind: number; channel: ChannelName | null; controlOp: number | null
  peerSlot: number; payload: Uint8Array
}
export function encodeWsData(out: Uint8Array, channel: ChannelName, peerSlot: number, payload: Uint8Array): number
export function decodeWsFrame(buf: Uint8Array): WsFrame | null   // TOTAL; null, never a throw
```

**Consumes (test only)** — from `packages/net/test/fixtures/socket-fixtures.ts`
(Task 7 created it; contract §9.1 pins the signature):

```ts
export function makeFakeSocketPair(): {
  a: SocketLike; b: SocketLike; flush(): void; stall(bytes: number): void; drain(): void
}
```

**Consumes (test only)** — from `@tapkart/protocol`: `WIRE_TAG`, `encodeHeader`
(§2.6), and from `./wsframe`: `encodeWsControl`, `decodeWsFrame`.

**Produces** — `packages/net/src/websocket.ts`, exactly five exported names
(contract §4.3, §11's census row `net/websocket | 5`):

```ts
export const WS_MAX_BUFFERED_BYTES = 1 << 20            // 1 MiB
export const WS_MAX_RELIABLE_BUFFERED_BYTES = 4 << 20   // 4 MiB
export interface WebSocketTransportOptions {
  socket: SocketLike
  selfSlot: number
  peerIdOfSlot?: (slot: number) => string
  maxBufferedBytes?: number
}
export interface WebSocketTransport extends Transport {
  sendText(text: string): void
  onText(cb: (text: string) => void): void
  droppedUnreliable(): number
  mailboxDepth(): number
  knownSlots(): number[]
}
export function makeWebSocketTransport(opts: WebSocketTransportOptions): WebSocketTransport
```

**Behaviour fixed by contract §4.3, restated because it is the whole task:**

- `broadcast` emits **one** frame addressed to `WS_SLOT_BROADCAST`. The server
  fans it out. Not one frame per peer.
- `send` emits one frame to that peer's slot; an unknown peer id is a **no-op**.
- `peers()` is every slot learned from a `WS_CONTROL_PEER_JOINED` frame, minus
  `selfSlot`, **plus the constant peer for `WS_SLOT_SERVER`**.
- `WS_CONTROL_PEER_GONE` fires `onPeerLost` for that slot's peer id and removes
  it. **This is the entire mechanism by which a host learns a relayed guest
  dropped**; without it `AuthorityLoop.onPeerLost` never runs for a relay guest
  and their kart never becomes bot-driven.
- The slot table is written **by inbound control frames only**, never inferred
  from a data frame's origin: an unknown origin is a routing bug and silently
  learning it hides one.
- Frames whose origin equals `selfSlot` are dropped — a relay must never echo a
  peer to itself.
- `close()` closes the socket, clears the slot table and empties the mailbox,
  idempotently.

**The unreliable mailbox — latest wins, depth 1 per (slot, tag)** (F-P4-44),
quoted:

> While `socket.bufferedAmount() > maxBufferedBytes`, an unreliable datagram is
> **not queued and not discarded — it replaces** whatever unsent datagram is
> already held for the same `(peerSlot, WIRE_TAG)` key, and `droppedUnreliable()`
> counts the one it replaced. When `bufferedAmount()` falls back under the cap,
> the mailbox flushes in insertion order and empties.

Keying by `(slot, tag)` rather than slot alone is what keeps a `ping` from being
displaced by a `snapshot`; the transport reads exactly one byte of the payload —
`payload[0]`, the tag `encodeHeader` wrote — and only to key the mailbox. **It
decodes nothing.** A `'reliable'` datagram is never dropped and never mailboxed:
dropping one silently breaks `eventSeq` monotonicity, the one thing `applyEvent`
cannot recover from. A socket past `WS_MAX_RELIABLE_BUFFERED_BYTES` is **closed**
with `WS_CLOSE_BACKPRESSURE`, because unbounded memory on a shared server process
is worse than one peer reconnecting.

**Three decisions this task must make, which §4.3 leaves to the implementer:**

1. **When the mailbox drains.** `SocketLike` has no drain callback and this
   transport reads no clock, so the flush is attempted at the top of every
   `send`, `broadcast` and `sendText`, **and on every inbound socket message** —
   at 20 Hz snapshots there is always inbound traffic. Stated in the file and
   asserted from both sides in the test.
2. **The server is a peer from CONSTRUCTION, not from the first frame.**
   `RoomClient` sends `hello` to the server before any frame has arrived, and a
   transport whose `peers()` was empty until then would no-op that `send` and
   hang the join forever.
3. **A socket that dies under the transport fires `onPeerLost` for every peer it
   held**, including the room. Without it an `AuthorityLoop` keeps every relayed
   guest's kart frozen instead of bot-driving it, and §9.2's `dropB()` — which
   for this transport *is* the socket dying — could observe nothing at all. A
   **local** `close()` does not fire it (rule 5: nothing is delivered after
   close, and that includes callbacks).

---

- [ ] **Step 1: Write the failing test**

Create `packages/net/test/websocket.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { ChannelName } from '@tapkart/protocol'
import { WIRE_TAG, encodeHeader } from '@tapkart/protocol'
import type { SocketData, SocketLike } from '../src/socket'
import { WS_CLOSE_BACKPRESSURE } from '../src/socket'
import {
  WS_CONTROL_PEER_GONE,
  WS_CONTROL_PEER_JOINED,
  WS_HEADER_BYTES,
  WS_SLOT_BROADCAST,
  WS_SLOT_SERVER,
  decodeWsFrame,
  encodeWsControl,
  encodeWsData,
} from '../src/wsframe'
import { WS_MAX_RELIABLE_BUFFERED_BYTES, makeWebSocketTransport } from '../src/websocket'
import type { WebSocketTransport } from '../src/websocket'
import { makeFakeSocketPair } from './fixtures/socket-fixtures'

/** A one-message datagram: [tag, version, ...body]. */
function datagram(kind: 'snapshot' | 'input' | 'ping' | 'events', body: number[] = [0]): Uint8Array {
  const buf = new Uint8Array(2 + body.length)
  const h = encodeHeader(buf, kind)
  buf.set(body, h)
  return buf
}

function controlFrame(op: number, slot: number): Uint8Array {
  const out = new Uint8Array(WS_HEADER_BYTES)
  encodeWsControl(out, op, slot)
  return out
}

function dataFrame(channel: ChannelName, originSlot: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(WS_HEADER_BYTES + payload.length)
  encodeWsData(out, channel, originSlot, payload)
  return out
}

/** Everything the transport's socket put on the wire, decoded. */
function wireOf(far: SocketLike, flush: () => void): { frames: Uint8Array[]; text: string[] } {
  const frames: Uint8Array[] = []
  const text: string[] = []
  far.onMessage((d: SocketData) => {
    if (typeof d === 'string') text.push(d)
    else frames.push(d.slice())
  })
  flush()
  return { frames, text }
}

function setup(overrides: { selfSlot?: number; maxBufferedBytes?: number } = {}): {
  t: WebSocketTransport
  pair: ReturnType<typeof makeFakeSocketPair>
  sent: Uint8Array[]
  text: string[]
} {
  const pair = makeFakeSocketPair()
  const t = makeWebSocketTransport({
    socket: pair.a,
    selfSlot: overrides.selfSlot ?? 1,
    maxBufferedBytes: overrides.maxBufferedBytes ?? 64,
  })
  const wire = wireOf(pair.b, () => {})
  return { t, pair, sent: wire.frames, text: wire.text }
}

describe('net/websocket - addressing and the slot table', () => {
  it('broadcasts ONE frame addressed to the broadcast slot, not one per peer', () => {
    const { t, pair, sent } = setup()
    pair.a.onMessage(() => {})
    pair.b.send(controlFrame(WS_CONTROL_PEER_JOINED, 2))
    pair.b.send(controlFrame(WS_CONTROL_PEER_JOINED, 3))
    pair.flush()
    expect(t.knownSlots()).toEqual([2, 3])

    t.broadcast('unreliable', datagram('snapshot'))
    pair.flush()

    expect(sent).toHaveLength(1)
    const frame = decodeWsFrame(sent[0])
    expect(frame?.peerSlot).toBe(WS_SLOT_BROADCAST)
    expect(frame?.channel).toBe('unreliable')
    expect(frame?.payload[0]).toBe(WIRE_TAG.snapshot)
  })

  it('reaches every learned peer once the server fans the frame out, and never the sender', () => {
    // The stand-in below is not a test of the hub: it is the two lines of
    // routing that make "one call, N recipients" observable at this layer, and
    // the echo suppression it exercises is the transport's own.
    const links = [1, 2, 3].map((slot) => {
      const pair = makeFakeSocketPair()
      const t = makeWebSocketTransport({ socket: pair.a, selfSlot: slot, maxBufferedBytes: 1 << 20 })
      const got: Array<[string, ChannelName, number]> = []
      t.onMessage((peerId, channel, data) => got.push([peerId, channel, data[0]]))
      return { slot, pair, t, got }
    })
    // Everyone learns everyone (the hub sends these on join).
    for (const from of links) {
      for (const other of links) from.pair.b.send(controlFrame(WS_CONTROL_PEER_JOINED, other.slot))
      from.pair.flush()
    }
    // The relay: one inbound broadcast frame out to every OTHER socket, with the
    // origin slot rewritten to the sender - exactly what §5.7's hub does.
    for (const from of links) {
      from.pair.b.onMessage((d) => {
        if (typeof d === 'string') return
        const f = decodeWsFrame(d)
        if (f === null || f.peerSlot !== WS_SLOT_BROADCAST || f.channel === null) return
        for (const to of links) to.pair.b.send(dataFrame(f.channel, from.slot, f.payload))
      })
    }

    links[0].t.broadcast('reliable', datagram('events', [7]))
    for (const l of links) l.pair.flush()

    expect(links[1].got).toEqual([['p1', 'reliable', WIRE_TAG.events]])
    expect(links[2].got).toEqual([['p1', 'reliable', WIRE_TAG.events]])
    // Frames whose origin equals selfSlot are dropped: a relay must never echo
    // a peer to itself.
    expect(links[0].got).toEqual([])
  })

  it('sends to a known peer by slot and no-ops on an unknown peer id', () => {
    const { t, pair, sent } = setup()
    pair.b.send(controlFrame(WS_CONTROL_PEER_JOINED, 5))
    pair.flush()

    t.send('reliable', 'p5', datagram('input'))
    t.send('reliable', 'p9', datagram('input')) // never joined
    t.send('reliable', 'nonsense', datagram('input'))
    pair.flush()

    expect(sent).toHaveLength(1)
    expect(decodeWsFrame(sent[0])?.peerSlot).toBe(5)
  })

  it('keeps the room as a peer from construction, so `hello` is never dropped', () => {
    const { t, pair, sent } = setup()
    expect(t.peers()).toEqual(['p0'])

    t.send('reliable', 'p0', datagram('input'))
    pair.flush()

    expect(sent).toHaveLength(1)
    expect(decodeWsFrame(sent[0])?.peerSlot).toBe(WS_SLOT_SERVER)
  })

  it('learns slots from control frames ONLY, never from a data frame origin', () => {
    const { t, pair } = setup()
    const got: string[] = []
    t.onMessage((peerId) => got.push(peerId))

    pair.b.send(dataFrame('unreliable', 6, datagram('input')))
    pair.flush()

    // Delivered - the datagram is real - but the slot is NOT learned: an
    // unknown origin is a routing bug, and silently learning it hides one.
    expect(got).toEqual(['p6'])
    expect(t.knownSlots()).toEqual([])
    expect(t.peers()).toEqual(['p0'])
  })

  it('fires onPeerLost exactly once for PEER_GONE, and not at all for a slot it never held', () => {
    const { t, pair } = setup()
    const lost: string[] = []
    t.onPeerLost((peerId) => lost.push(peerId))

    pair.b.send(controlFrame(WS_CONTROL_PEER_JOINED, 4))
    pair.b.send(controlFrame(WS_CONTROL_PEER_GONE, 4))
    pair.b.send(controlFrame(WS_CONTROL_PEER_GONE, 4))
    pair.b.send(controlFrame(WS_CONTROL_PEER_GONE, 7))
    pair.flush()

    expect(lost).toEqual(['p4'])
    expect(t.knownSlots()).toEqual([])
  })

  it('appends message listeners rather than replacing them', () => {
    // On a guest, ClientLoop and RoomClient both subscribe to this transport. A
    // replace-semantics implementation silently deletes the lobby.
    const { t, pair } = setup()
    const seen: string[] = []
    t.onMessage(() => seen.push('first'))
    t.onMessage(() => seen.push('second'))

    pair.b.send(dataFrame('unreliable', WS_SLOT_SERVER, datagram('snapshot')))
    pair.flush()

    expect(seen).toEqual(['first', 'second'])
  })
})

describe('net/websocket - text rides beside binary', () => {
  it('routes text to onText and binary to onMessage, with no discriminator byte', () => {
    const { t, pair, sent, text } = setup()
    const binary: number[] = []
    const signals: string[] = []
    t.onMessage((_p, _c, data) => binary.push(data[0]))
    t.onText((s) => signals.push(s))

    t.sendText('{"v":1,"t":"offer"}')
    pair.b.send('{"v":1,"t":"answer"}')
    pair.b.send(dataFrame('unreliable', WS_SLOT_SERVER, datagram('snapshot')))
    pair.flush()

    expect(text).toEqual(['{"v":1,"t":"offer"}'])
    expect(sent).toHaveLength(0)
    expect(signals).toEqual(['{"v":1,"t":"answer"}'])
    expect(binary).toEqual([WIRE_TAG.snapshot])
  })
})

describe('net/websocket - the latest-wins mailbox (F-P4-44)', () => {
  it('replaces an unsent unreliable datagram of the same (slot, tag) and counts the loser', () => {
    const { t, pair, sent } = setup()
    pair.stall(1000)

    t.broadcast('unreliable', datagram('snapshot', [1]))
    t.broadcast('unreliable', datagram('snapshot', [2]))
    pair.flush()

    expect(sent).toHaveLength(0)
    expect(t.mailboxDepth()).toBe(1)
    expect(t.droppedUnreliable()).toBe(1)

    pair.drain()
    // No timer anywhere in this transport: the mailbox drains on the next piece
    // of transport activity, which at 20 Hz snapshots is never far away.
    t.broadcast('unreliable', datagram('snapshot', [3]))
    pair.flush()

    expect(t.mailboxDepth()).toBe(0)
    expect(t.droppedUnreliable()).toBe(1)
    // The newest bytes for that key, not the ones it replaced.
    expect(sent).toHaveLength(2)
    expect(decodeWsFrame(sent[0])?.payload[2]).toBe(2)
    expect(decodeWsFrame(sent[1])?.payload[2]).toBe(3)
  })

  it('does not let a snapshot displace a ping: the key is (slot, tag)', () => {
    const { t, pair, sent } = setup()
    pair.stall(1000)

    t.broadcast('unreliable', datagram('ping'))
    t.broadcast('unreliable', datagram('snapshot'))
    t.broadcast('unreliable', datagram('snapshot'))
    pair.flush()

    expect(t.mailboxDepth()).toBe(2)
    expect(t.droppedUnreliable()).toBe(1)

    pair.drain()
    t.sendText('drain-pump')
    pair.flush()

    // Insertion order: the ping was held first, so it goes out first.
    expect(sent).toHaveLength(2)
    expect(decodeWsFrame(sent[0])?.payload[0]).toBe(WIRE_TAG.ping)
    expect(decodeWsFrame(sent[1])?.payload[0]).toBe(WIRE_TAG.snapshot)
  })

  it('keys the mailbox by SLOT as well as tag, so two peers never displace each other', () => {
    const { t, pair } = setup()
    pair.b.send(controlFrame(WS_CONTROL_PEER_JOINED, 2))
    pair.b.send(controlFrame(WS_CONTROL_PEER_JOINED, 3))
    pair.flush()
    pair.stall(1000)

    t.send('unreliable', 'p2', datagram('input'))
    t.send('unreliable', 'p3', datagram('input'))

    expect(t.mailboxDepth()).toBe(2)
    expect(t.droppedUnreliable()).toBe(0)
  })

  it('never mailboxes or drops a reliable datagram', () => {
    const { t, pair, sent } = setup()
    pair.stall(1000)

    t.broadcast('reliable', datagram('events', [1]))
    t.broadcast('reliable', datagram('events', [2]))
    pair.flush()

    // Dropping one silently breaks eventSeq monotonicity, which is the one
    // thing applyEvent cannot recover from.
    expect(sent).toHaveLength(2)
    expect(t.mailboxDepth()).toBe(0)
    expect(t.droppedUnreliable()).toBe(0)
  })

  it('closes the socket with 4003 when the RELIABLE backlog is past saving', () => {
    const { t, pair, sent } = setup()
    const codes: number[] = []
    pair.a.onClose((c) => codes.push(c))
    pair.stall(WS_MAX_RELIABLE_BUFFERED_BYTES + 1)

    t.broadcast('reliable', datagram('events'))
    pair.flush()

    expect(codes).toEqual([WS_CLOSE_BACKPRESSURE])
    expect(sent).toHaveLength(0)
    expect(t.peers()).toEqual([])
  })
})

describe('net/websocket - a malformed frame closes nothing', () => {
  it('drops it, counts nothing, and STILL PROCESSES the very next valid frame', () => {
    const { t, pair } = setup()
    const got: number[] = []
    t.onMessage((_p, _c, data) => got.push(data[0]))

    // Undecodable envelope, then a perfectly good datagram on the same socket,
    // in the same flush. A guard that drops the bad frame and then wedges the
    // receive loop passes every assertion about what did NOT arrive.
    pair.b.send(new Uint8Array([0x7f, 0x7f, 0x7f]))
    pair.b.send(new Uint8Array([]))
    pair.b.send(dataFrame('unreliable', WS_SLOT_SERVER, datagram('snapshot')))
    pair.flush()

    expect(got).toEqual([WIRE_TAG.snapshot])
    expect(t.peers()).toEqual(['p0'])
  })
})

describe('net/websocket - closing', () => {
  it('is idempotent, empties the slot table and the mailbox, and goes quiet both ways', () => {
    const { t, pair, sent } = setup()
    pair.b.send(controlFrame(WS_CONTROL_PEER_JOINED, 2))
    pair.flush()
    pair.stall(1000)
    t.broadcast('unreliable', datagram('snapshot'))
    expect(t.mailboxDepth()).toBe(1)

    const lost: string[] = []
    t.onPeerLost((p) => lost.push(p))
    t.close()
    t.close()

    expect(t.peers()).toEqual([])
    expect(t.knownSlots()).toEqual([])
    expect(t.mailboxDepth()).toBe(0)
    // A LOCAL close is not peer loss: nothing is delivered in either direction
    // after close(), and that includes callbacks.
    expect(lost).toEqual([])

    const before = sent.length
    t.broadcast('reliable', datagram('events'))
    pair.b.send(dataFrame('unreliable', WS_SLOT_SERVER, datagram('snapshot')))
    pair.flush()
    expect(sent).toHaveLength(before)
  })

  it('reports every peer lost when the SOCKET dies under it', () => {
    const { t, pair } = setup()
    pair.b.send(controlFrame(WS_CONTROL_PEER_JOINED, 2))
    pair.b.send(controlFrame(WS_CONTROL_PEER_JOINED, 3))
    pair.flush()
    const lost: string[] = []
    t.onPeerLost((p) => lost.push(p))

    pair.b.close(4002)

    expect(lost).toEqual(['p0', 'p2', 'p3'])
    expect(t.peers()).toEqual([])
  })
})
```

Why the mailbox tests are shaped this way — this is the part of the suite most
able to pass while proving nothing:

- **The replacement test asserts the SURVIVING BYTES, not just the counter.**
  `sent[0].payload[2] === 2` is the assertion that separates "kept the newest"
  from "kept the oldest": both implementations hold depth 1 and count one drop,
  and only the payload byte tells them apart.
- **The ping-vs-snapshot test is the reason the key is a pair.** A slot-keyed
  mailbox has depth 1 and one drop here too — indistinguishable from the correct
  answer unless a test sends two *different* tags to the same slot.
- **The order assertion needs two distinguishable frames.** The flush order test
  reads `payload[0]` of each sent frame; a mailbox that flushed in reverse would
  otherwise be invisible, because both frames are the same length and go to the
  same socket.
- **The malformed-frame test delivers a VALID frame immediately after the bad
  one, in the same flush.** Without that clause the test passes against a
  transport that drops the bad frame and then wedges its receive loop forever —
  every assertion about what did *not* arrive would still hold.
- **`setup()` uses `maxBufferedBytes: 64`**, so `stall()`/`drain()` from the
  fixture are what move the transport across the threshold rather than the
  incidental byte counts of the frames themselves.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/net/test/websocket.test.ts`

Expected: FAIL, before any assertion runs, with

```
Error: Cannot find module '../src/websocket' imported from '<repo>/packages/net/test/websocket.test.ts'
Caused by: Error: Failed to load url ../src/websocket (resolved id: ../src/websocket) ... Does the file exist?
 Test Files  1 failed (1)
```

- [ ] **Step 3: Write the implementation**

Create `packages/net/src/websocket.ts`:

```ts
import type { ChannelName } from '@tapkart/protocol'
import type { Transport } from './transport'
import type { SocketLike } from './socket'
import { WS_CLOSE_BACKPRESSURE } from './socket'
import {
  WS_CONTROL_PEER_GONE,
  WS_CONTROL_PEER_JOINED,
  WS_FRAME_CONTROL,
  WS_FRAME_DATA,
  WS_HEADER_BYTES,
  WS_SLOT_BROADCAST,
  WS_SLOT_SERVER,
  decodeWsFrame,
  encodeWsData,
} from './wsframe'

/**
 * PURE (contract §0a): one socket, many peers behind it, and no WebSocket named
 * anywhere in this file. The client-side transport.
 *
 * Above this bufferedAmount the socket is not writable and unreliable traffic
 * goes to the mailbox instead (F-P4-44).
 */
export const WS_MAX_BUFFERED_BYTES = 1 << 20
/**
 * A reliable backlog past this is not survivable: reliable traffic is never
 * dropped, so the only remaining options are unbounded memory on a shared
 * server process or closing one socket. We close it.
 */
export const WS_MAX_RELIABLE_BUFFERED_BYTES = 4 << 20

export interface WebSocketTransportOptions {
  socket: SocketLike
  /** This endpoint's own slot, from WelcomeMessage.peerSlot. Frames whose origin
   *  equals it are dropped: a relay must never echo a peer to itself. */
  selfSlot: number
  /** Slot -> stable peer id. Default `(s) => 'p' + s`; the server's room
   *  transport passes its own so ids match across both ends of a test. */
  peerIdOfSlot?: (slot: number) => string
  maxBufferedBytes?: number
}

export interface WebSocketTransport extends Transport {
  /** Signalling rides text frames on the same socket (§4.4). */
  sendText(text: string): void
  onText(cb: (text: string) => void): void
  /** Unreliable datagrams superseded in the mailbox before they were ever sent.
   *  0 in the steady state; non-zero only under a stalled socket, which is the
   *  only visible symptom of back-pressure. */
  droppedUnreliable(): number
  /** Unreliable datagrams currently held, waiting for the socket to drain. */
  mailboxDepth(): number
  knownSlots(): number[]
}

interface MailboxEntry {
  slot: number
  frame: Uint8Array
}

export function makeWebSocketTransport(opts: WebSocketTransportOptions): WebSocketTransport {
  const socket = opts.socket
  const selfSlot = opts.selfSlot
  const peerIdOfSlot = opts.peerIdOfSlot ?? ((s: number): string => `p${s}`)
  const maxBufferedBytes = opts.maxBufferedBytes ?? WS_MAX_BUFFERED_BYTES

  const messageCbs: Array<(peerId: string, channel: ChannelName, data: Uint8Array) => void> = []
  const peerLostCbs: Array<(peerId: string) => void> = []
  const textCbs: Array<(text: string) => void> = []

  /** Learned from inbound control frames ONLY, in the order they were learned. */
  const slots: number[] = []
  const slotOfPeerId = new Map<string, number>()
  const mailbox = new Map<string, MailboxEntry>()
  let droppedUnreliable = 0
  let closed = false

  const serverPeerId = peerIdOfSlot(WS_SLOT_SERVER)
  slotOfPeerId.set(serverPeerId, WS_SLOT_SERVER)

  function frameFor(channel: ChannelName, slot: number, data: Uint8Array): Uint8Array {
    // A fresh buffer per frame, not a shared scratch: `socket.send` may hold the
    // bytes until the socket drains, and the mailbox holds them for longer than
    // that. One copy of at most 749 B (§3.6's largest unreliable datagram).
    const frame = new Uint8Array(WS_HEADER_BYTES + data.length)
    encodeWsData(frame, channel, slot, data)
    return frame
  }

  function flushMailbox(): void {
    if (mailbox.size === 0) return
    if (socket.bufferedAmount() > maxBufferedBytes) return
    // Map iteration is insertion order, and replacing a value keeps the key's
    // original position - so the oldest held datagram goes out first carrying
    // the newest bytes for its (slot, tag).
    const entries = [...mailbox.values()]
    mailbox.clear()
    for (const e of entries) socket.send(e.frame)
  }

  function sendFrame(channel: ChannelName, slot: number, data: Uint8Array): void {
    if (closed) return
    // There is no drain callback on SocketLike and this transport reads no
    // clock, so every send and every inbound message is a pump. At 20 Hz
    // snapshots and 30 Hz inputs one is never far away.
    flushMailbox()

    if (channel === 'reliable') {
      if (socket.bufferedAmount() > WS_MAX_RELIABLE_BUFFERED_BYTES) {
        closeInternal(WS_CLOSE_BACKPRESSURE)
        return
      }
      socket.send(frameFor(channel, slot, data))
      return
    }

    if (socket.bufferedAmount() > maxBufferedBytes) {
      // Latest wins, depth 1 per (slot, tag). EXACTLY ONE byte of the payload is
      // read - payload[0], the tag encodeHeader wrote - and only to key the
      // mailbox, so a ping is never displaced by a snapshot. Nothing is decoded.
      //
      // Replacement is lossless in the sense that matters, and only because
      // every unreliable message in this system is self-superseding: a snapshot
      // is a complete state, an input datagram carries an 8-tick redundant
      // window, and a ping is a probe whose whole design tolerates loss. A
      // future unreliable kind that is NOT self-superseding makes this mailbox
      // wrong for it, and the mailbox is what changes.
      const tag = data.length > 0 ? data[0] : -1
      const key = `${slot}:${tag}`
      if (mailbox.has(key)) droppedUnreliable++
      mailbox.set(key, { slot, frame: frameFor(channel, slot, data) })
      return
    }

    socket.send(frameFor(channel, slot, data))
  }

  function firePeerLost(slot: number): void {
    const peerId = peerIdOfSlot(slot)
    slotOfPeerId.delete(peerId)
    for (const cb of [...peerLostCbs]) cb(peerId)
  }

  function closeInternal(code?: number): void {
    if (closed) return
    // `closed` FIRST, then the socket: the socket's own onClose fires
    // synchronously from close(), and rule 5 says nothing is delivered after
    // close() - including onPeerLost callbacks for a teardown we asked for.
    closed = true
    slots.length = 0
    slotOfPeerId.clear()
    mailbox.clear()
    socket.close(code)
  }

  socket.onMessage((data) => {
    if (closed) return
    if (typeof data === 'string') {
      for (const cb of [...textCbs]) cb(data)
      return
    }

    flushMailbox()

    const frame = decodeWsFrame(data)
    // A DATAGRAM THAT CANNOT BE DECODED IS A DATAGRAM THAT NEVER ARRIVED.
    // decodeWsFrame returns null rather than throwing, so the next frame on this
    // socket is still processed and one malformed frame never takes a room down.
    if (frame === null) return

    if (frame.frameKind === WS_FRAME_CONTROL) {
      if (frame.peerSlot === selfSlot) return
      if (frame.controlOp === WS_CONTROL_PEER_JOINED) {
        if (!slots.includes(frame.peerSlot)) {
          slots.push(frame.peerSlot)
          slotOfPeerId.set(peerIdOfSlot(frame.peerSlot), frame.peerSlot)
        }
        return
      }
      if (frame.controlOp === WS_CONTROL_PEER_GONE) {
        const at = slots.indexOf(frame.peerSlot)
        // Only for a slot this transport actually holds, which is what makes
        // onPeerLost fire EXACTLY once for a repeated PEER_GONE.
        if (at < 0) return
        slots.splice(at, 1)
        firePeerLost(frame.peerSlot)
      }
      return
    }

    if (frame.frameKind !== WS_FRAME_DATA || frame.channel === null) return
    // A relay must never echo a peer to itself.
    if (frame.peerSlot === selfSlot) return
    // Delivered, but NOT learned: the slot table is written by control frames
    // only. An unknown origin is a routing bug, and silently learning it hides
    // one.
    const peerId = peerIdOfSlot(frame.peerSlot)
    for (const cb of [...messageCbs]) cb(peerId, frame.channel, frame.payload)
  })

  socket.onClose(() => {
    if (closed) return
    // Every peer behind this socket is unreachable, including the room itself.
    // Without this an AuthorityLoop keeps every relayed guest's kart frozen
    // instead of bot-driving it, and the conformance harness's dropB() - which
    // for this transport IS the socket dying - could observe nothing at all.
    const lost = [WS_SLOT_SERVER, ...slots]
    closed = true
    slots.length = 0
    slotOfPeerId.clear()
    mailbox.clear()
    for (const slot of lost) {
      for (const cb of [...peerLostCbs]) cb(peerIdOfSlot(slot))
    }
  })

  return {
    send(channel, peerId, data): void {
      const slot = slotOfPeerId.get(peerId)
      // An unknown peer is a no-op, not a throw (Transport rule 4).
      if (slot === undefined) return
      sendFrame(channel, slot, data)
    },
    broadcast(channel, data): void {
      // ONE frame, addressed to the broadcast slot. The server fans it out.
      sendFrame(channel, WS_SLOT_BROADCAST, data)
    },
    onMessage(cb): void {
      messageCbs.push(cb)
    },
    onPeerLost(cb): void {
      peerLostCbs.push(cb)
    },
    peers(): string[] {
      if (closed) return []
      // The room itself is always a peer, from CONSTRUCTION and not from the
      // first frame: RoomClient sends `hello` to the server before any frame has
      // ever arrived, and a transport with no peers yet would silently drop it
      // and hang the join forever.
      return [serverPeerId, ...slots.map(peerIdOfSlot)]
    },
    close(): void {
      closeInternal()
    },
    sendText(text): void {
      if (closed) return
      flushMailbox()
      socket.send(text)
    },
    onText(cb): void {
      textCbs.push(cb)
    },
    droppedUnreliable(): number {
      return droppedUnreliable
    },
    mailboxDepth(): number {
      return mailbox.size
    },
    knownSlots(): number[] {
      return [...slots]
    },
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/net/test/websocket.test.ts`

Expected: `Test Files  1 passed (1)` / `Tests  16 passed (16)`.

- [ ] **Step 5: Add the module to the barrel, and to the barrel test that pins it**

Skipping this turns `packages/net/test/barrel.test.ts` red with *"a module was
added to src/ without a line in the barrel"*. Sibling tasks edit the same lists —
**insert, never rewrite.**

**Task 15 closes this barrel** (contract §4.11) and its list includes this module.
Wiring it here anyway is what keeps `npm test` green *between* tasks: the shipped
barrel test fails the moment a file exists in `src/` with no `export *` line, so
deferring every line to Task 15 leaves the suite red for the whole middle of the
plan. Task 15 then finds this line already present — and its own assertion that
each `export *` line appears **exactly once** is what catches a double-add, so
never add it twice.


In `packages/net/src/index.ts`, append:

```ts
export * from './websocket'
```

In `packages/net/test/barrel.test.ts`:

```ts
// 1. beside the other namespace imports:
import * as websocketNs from '../src/websocket'

// 2. inside `import type { ... } from '../src/index'`:
  // websocket [Plan 4 Task 9]
  WebSocketTransport,
  WebSocketTransportOptions,

// 3. in SURFACE:
  // [Plan 4 Task 9] one socket, many peers behind it.
  websocket: ['WS_MAX_BUFFERED_BYTES', 'WS_MAX_RELIABLE_BUFFERED_BYTES', 'makeWebSocketTransport'],

// 4. in BARREL_MODULES, in the order index.ts lists them:
  'websocket'

// 5. in NAMESPACES:
  ['websocket', websocketNs],

// 6. in `interface NetTypeSurface` / `const TYPE_SURFACE`:
  WebSocketTransport: WebSocketTransport               /  WebSocketTransport: true,
  WebSocketTransportOptions: WebSocketTransportOptions /  WebSocketTransportOptions: true,

// 7. in the sorted literal inside "pins the type-only surface at compile time",
//    in sorted position:
  'WebSocketTransport', 'WebSocketTransportOptions',
```

- [ ] **Step 6: Verify the package, not just this file**

```bash
npx vitest run packages/net/test/websocket.test.ts packages/net/test/barrel.test.ts
npx tsc --noEmit -p packages/net/tsconfig.json
npx vitest run
```

- [ ] **Step 7: Commit**

```bash
git add packages/net/src/websocket.ts packages/net/test/websocket.test.ts \
        packages/net/src/index.ts packages/net/test/barrel.test.ts && \
git commit -m "feat(net): add WebSocketTransport with the latest-wins unreliable mailbox"
```
