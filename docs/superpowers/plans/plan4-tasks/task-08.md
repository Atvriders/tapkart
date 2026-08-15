### Task 8: `packages/net/src/wsframe.ts` — the three-byte envelope, and the first function every hostile byte reaches

**Files:**
- Create: `packages/net/src/wsframe.ts`
- Create: `packages/net/test/wsframe.test.ts`
- Modify: `packages/net/src/index.ts` (one `export *` line)
- Modify: `packages/net/test/barrel.test.ts` (the pinned public surface)
- Test: `packages/net/test/wsframe.test.ts`

**This module is PURE** (contract §0a) and every one of its functions is a pure
function of its arguments over caller-owned buffers. There is no adapter half at
all: nothing here touches a socket. `decodeWsFrame` is the module's whole risk
surface and it is **total** — it returns `null` and never throws, because it is
the first function every inbound byte on a public socket reaches.

---

**Interfaces:**

**Consumes** — from `@tapkart/protocol` (bare specifier, type-only):

```ts
export type ChannelName = 'unreliable' | 'reliable'
```

That is the entire import list. The envelope carries a `WIRE_TAG` message as an
opaque payload and **decodes none of it**.

**Produces** — `packages/net/src/wsframe.ts`, exactly fifteen exported names
(contract §4.2, §11's census row `net/wsframe | 15`: fourteen runtime names plus
the `WsFrame` type):

```ts
export const WS_FRAME_DATA    = 0x00
export const WS_FRAME_CONTROL = 0x01
export const WS_CHANNEL_UNRELIABLE = 0x00
export const WS_CHANNEL_RELIABLE   = 0x01
export const WS_SLOT_SERVER    = 0x00   // the room itself
export const WS_SLOT_BROADCAST = 0xff   // "fan out to everyone but me"
export const WS_CONTROL_PEER_JOINED = 0x00
export const WS_CONTROL_PEER_GONE   = 0x01
export const WS_HEADER_BYTES = 3

export interface WsFrame {
  frameKind: number                 // WS_FRAME_*
  channel: ChannelName | null       // null on control frames
  controlOp: number | null          // null on data frames
  peerSlot: number                  // origin (inbound) or destination (outbound)
  payload: Uint8Array               // a WIRE_TAG message; empty on control frames
}

export function encodeWsData(out: Uint8Array, channel: ChannelName, peerSlot: number, payload: Uint8Array): number
export function encodeWsControl(out: Uint8Array, op: number, peerSlot: number): number
export function decodeWsFrame(buf: Uint8Array): WsFrame | null
export function byteOfChannel(c: ChannelName): number
export function channelOfByte(b: number): ChannelName | null
```

**The layout, byte-exact, copied from contract §4.2:**

| Byte | Meaning |
|---|---|
| 0 | `frameKind`: `0x00` data, `0x01` control |
| 1 | data: `channel` (`0x00` unreliable, `0x01` reliable) · control: `controlOp` |
| 2 | `peerSlot` |
| 3.. | payload — the bytes `encodeHeader` + a codec produced |

**Three properties this task fixes, which two later tasks would otherwise pick
differently:**

- **`WsFrame.payload` is a SUBARRAY VIEW of the inbound buffer, not a copy.**
  `Transport` rule 6 (§2.1) says a receiver that needs the bytes past the
  callback copies them, and every shipped loop already does. A copy here would
  allocate on every datagram at 20–30 Hz per peer and would quietly retire that
  rule.
- **`decodeWsFrame` returns `null` on a short, unknown-kind or unknown-channel
  frame and NEVER throws.** Plan 2 learned this the expensive way: `decodeHeader`
  threw out of `onMessage` in all three loops, and on a server an uncaught
  exception in a socket handler **exits the process and kills every room in it** —
  reachable by one byte, and reachable with no attacker at all after a deploy
  leaves an old client speaking version 1.
- **The envelope exists rather than deriving the channel from `MessageKind`.**
  The rejected alternative costs zero bytes and is wrong: it makes `kind →
  channel` a second source of truth that `ClientLoop`'s existing
  `kind === 'snapshot' && channel === 'unreliable'` guards (`client.ts:375`,
  `client.ts:404`) would then be checking against themselves. 3 B on every
  datagram is ~150 B/s per peer at 20 Hz snapshots and 30 Hz inputs (P4 Q38,
  confirmed).

**One thing left as it is, stated so nobody adds it:** a control frame with
trailing bytes is **accepted**, and its `payload` is empty. §4.2's null list is
exhaustive — short, unknown kind, unknown channel — and a fourth rejection rule
would be a decision this contract did not make.

---

- [ ] **Step 1: Write the failing test**

Create `packages/net/test/wsframe.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { ChannelName } from '@tapkart/protocol'
import { WIRE_TAG, encodeHeader } from '@tapkart/protocol'
import {
  WS_CHANNEL_RELIABLE,
  WS_CHANNEL_UNRELIABLE,
  WS_CONTROL_PEER_GONE,
  WS_CONTROL_PEER_JOINED,
  WS_FRAME_CONTROL,
  WS_FRAME_DATA,
  WS_HEADER_BYTES,
  WS_SLOT_BROADCAST,
  WS_SLOT_SERVER,
  byteOfChannel,
  channelOfByte,
  decodeWsFrame,
  encodeWsControl,
  encodeWsData,
} from '../src/wsframe'

const CHANNELS: ChannelName[] = ['unreliable', 'reliable']

describe('net/wsframe - the three-byte envelope', () => {
  it('pins the byte layout, because both ends are built at different times', () => {
    expect([WS_FRAME_DATA, WS_FRAME_CONTROL]).toEqual([0x00, 0x01])
    expect([WS_CHANNEL_UNRELIABLE, WS_CHANNEL_RELIABLE]).toEqual([0x00, 0x01])
    expect([WS_SLOT_SERVER, WS_SLOT_BROADCAST]).toEqual([0x00, 0xff])
    expect([WS_CONTROL_PEER_JOINED, WS_CONTROL_PEER_GONE]).toEqual([0x00, 0x01])
    expect(WS_HEADER_BYTES).toBe(3)
  })

  it('round-trips every data frame, over both channels and every slot', () => {
    const payload = new Uint8Array(8)
    const h = encodeHeader(payload, 'snapshot')
    payload[h] = 0xab
    const out = new Uint8Array(64)

    for (const channel of CHANNELS) {
      for (const slot of [WS_SLOT_SERVER, 1, 7, 254, WS_SLOT_BROADCAST]) {
        const n = encodeWsData(out, channel, slot, payload)
        expect(n).toBe(WS_HEADER_BYTES + payload.length)

        const frame = decodeWsFrame(out.subarray(0, n))
        expect(frame).not.toBeNull()
        if (frame === null) return
        expect(frame.frameKind).toBe(WS_FRAME_DATA)
        expect(frame.channel).toBe(channel)
        expect(frame.controlOp).toBeNull()
        expect(frame.peerSlot).toBe(slot)
        expect(Array.from(frame.payload)).toEqual(Array.from(payload))
        // The tag the transport reads to key its mailbox is payload[0] and
        // nothing else - the envelope never decodes a message.
        expect(frame.payload[0]).toBe(WIRE_TAG.snapshot)
      }
    }
  })

  it('round-trips both control ops and carries an empty payload', () => {
    const out = new Uint8Array(16)
    for (const op of [WS_CONTROL_PEER_JOINED, WS_CONTROL_PEER_GONE]) {
      const n = encodeWsControl(out, op, 9)
      expect(n).toBe(WS_HEADER_BYTES)

      const frame = decodeWsFrame(out.subarray(0, n))
      expect(frame).not.toBeNull()
      if (frame === null) return
      expect(frame.frameKind).toBe(WS_FRAME_CONTROL)
      expect(frame.controlOp).toBe(op)
      expect(frame.channel).toBeNull()
      expect(frame.peerSlot).toBe(9)
      expect(frame.payload.length).toBe(0)
    }
  })

  it('hands back a VIEW of the inbound buffer, not a copy', () => {
    // Transport rule 6: a receiver that needs the bytes past the callback
    // copies them. If this ever became a copy, every hot-path datagram would
    // allocate and the rule would quietly stop meaning anything.
    const buf = new Uint8Array([WS_FRAME_DATA, WS_CHANNEL_RELIABLE, 3, 0x10, 0x02, 0x63])
    const frame = decodeWsFrame(buf)
    expect(frame).not.toBeNull()
    if (frame === null) return
    expect(frame.payload.buffer).toBe(buf.buffer)
    expect(frame.payload.byteOffset).toBe(WS_HEADER_BYTES)
    buf[3] = 0x11
    expect(frame.payload[0]).toBe(0x11)
  })

  it('returns null - never throws - on every malformed frame', () => {
    const rows: Array<[string, Uint8Array]> = [
      ['empty', new Uint8Array(0)],
      ['one byte', new Uint8Array([WS_FRAME_DATA])],
      ['two bytes', new Uint8Array([WS_FRAME_DATA, WS_CHANNEL_RELIABLE])],
      ['unknown frame kind 0x02', new Uint8Array([0x02, 0x00, 1])],
      ['unknown frame kind 0xff', new Uint8Array([0xff, 0x00, 1])],
      ['unknown channel 0x02', new Uint8Array([WS_FRAME_DATA, 0x02, 1])],
      ['unknown channel 0xff', new Uint8Array([WS_FRAME_DATA, 0xff, 1, 9, 9])],
      ['unknown control op 0x02', new Uint8Array([WS_FRAME_CONTROL, 0x02, 1])],
    ]
    for (const [label, buf] of rows) {
      let result: unknown = 'threw'
      expect(() => {
        result = decodeWsFrame(buf)
      }, label).not.toThrow()
      expect(result, label).toBeNull()
    }
  })

  it('never throws on any three-byte header, over the whole 65,536-value space', () => {
    // The first function every inbound byte on a public socket reaches. The
    // expected trigger is a version mismatch after a deploy, not an attacker,
    // and a throw here is an uncaught exception in a socket handler - which on
    // the server exits the process and kills every room in it.
    const buf = new Uint8Array([0, 0, 0, 0x30, 0x01])
    let accepted = 0
    for (let b0 = 0; b0 < 256; b0++) {
      for (let b1 = 0; b1 < 256; b1++) {
        buf[0] = b0
        buf[1] = b1
        buf[2] = (b0 ^ b1) & 0xff
        const frame = decodeWsFrame(buf)
        if (frame !== null) accepted++
      }
    }
    // Exactly the four legal (kind, second byte) pairs: data x 2 channels,
    // control x 2 ops. A guard that returned null for EVERYTHING would pass a
    // "never throws" assertion and reject every real frame in the system.
    expect(accepted).toBe(4)
  })

  it('maps channel names to bytes and back, exhaustively', () => {
    for (const c of CHANNELS) expect(channelOfByte(byteOfChannel(c))).toBe(c)
    expect(byteOfChannel('unreliable')).toBe(0x00)
    expect(byteOfChannel('reliable')).toBe(0x01)
    for (let b = 2; b < 256; b++) expect(channelOfByte(b)).toBeNull()
  })
})
```

The two assertions doing the real work:

- **The 65,536-value sweep counts what it ACCEPTS.** "Never throws" is trivially
  satisfiable by `return null`, which would reject every legitimate frame in the
  system and produce a silent, total outage that no other assertion in this file
  would catch. `expect(accepted).toBe(4)` is the clause that makes the sweep
  mean something.
- **The malformed rows are `[label, value]` pairs iterated by hand.** `it.each`
  spreads array rows, so an `it.each([...])` over `Uint8Array` rows would deliver
  an empty array as *zero arguments* and silently re-test `undefined` — a defect
  this project has already confirmed by watching a real bug pass under it.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/net/test/wsframe.test.ts`

Expected: FAIL, before any assertion runs, with

```
Error: Cannot find module '../src/wsframe' imported from '<repo>/packages/net/test/wsframe.test.ts'
Caused by: Error: Failed to load url ../src/wsframe (resolved id: ../src/wsframe) ... Does the file exist?
 Test Files  1 failed (1)
```

- [ ] **Step 3: Write the implementation**

Create `packages/net/src/wsframe.ts`:

```ts
import type { ChannelName } from '@tapkart/protocol'

/**
 * PURE (contract §0a). One WebSocket carries traffic for two logical channels
 * and, on the host's socket, for several ORIGIN PEERS at once (the relay case).
 * The three bytes below are the transport's private envelope; nothing above
 * `Transport` ever sees them.
 *
 * The rejected alternative was deriving the channel from MessageKind and
 * shipping no envelope. It costs zero bytes and is wrong: it makes kind ->
 * channel a second source of truth that ClientLoop's existing
 * `kind === 'snapshot' && channel === 'unreliable'` guards would then be
 * checking against themselves. 3 B per datagram is ~150 B/s per peer at 20 Hz
 * snapshots and 30 Hz inputs.
 */
export const WS_FRAME_DATA = 0x00
export const WS_FRAME_CONTROL = 0x01
export const WS_CHANNEL_UNRELIABLE = 0x00
export const WS_CHANNEL_RELIABLE = 0x01
/** The room itself - the server's shadow authority, always listening. */
export const WS_SLOT_SERVER = 0x00
/** "Fan out to everyone but me." One frame; the server does the fanning. */
export const WS_SLOT_BROADCAST = 0xff
export const WS_CONTROL_PEER_JOINED = 0x00
export const WS_CONTROL_PEER_GONE = 0x01
export const WS_HEADER_BYTES = 3

export interface WsFrame {
  frameKind: number
  /** null on control frames. */
  channel: ChannelName | null
  /** null on data frames. */
  controlOp: number | null
  /** Origin on an inbound frame, destination on an outbound one. */
  peerSlot: number
  /**
   * A WIRE_TAG message, empty on control frames, and a SUBARRAY VIEW of the
   * inbound buffer rather than a copy: Transport rule 6 says a receiver that
   * needs the bytes past the callback copies them, and every shipped loop
   * already does. Copying here would allocate on every datagram.
   */
  payload: Uint8Array
}

export function byteOfChannel(c: ChannelName): number {
  return c === 'reliable' ? WS_CHANNEL_RELIABLE : WS_CHANNEL_UNRELIABLE
}

export function channelOfByte(b: number): ChannelName | null {
  if (b === WS_CHANNEL_UNRELIABLE) return 'unreliable'
  if (b === WS_CHANNEL_RELIABLE) return 'reliable'
  return null
}

/**
 * Frames `payload` into `out` and returns the byte count. `out` must hold
 * WS_HEADER_BYTES + payload.length; a short buffer throws from `out.set`, which
 * is an ENCODE-side throw on data this process produced - a bug, not an attack,
 * and the one direction where failing loudly is right.
 */
export function encodeWsData(
  out: Uint8Array,
  channel: ChannelName,
  peerSlot: number,
  payload: Uint8Array,
): number {
  out[0] = WS_FRAME_DATA
  out[1] = byteOfChannel(channel)
  out[2] = peerSlot & 0xff
  out.set(payload, WS_HEADER_BYTES)
  return WS_HEADER_BYTES + payload.length
}

export function encodeWsControl(out: Uint8Array, op: number, peerSlot: number): number {
  out[0] = WS_FRAME_CONTROL
  out[1] = op & 0xff
  out[2] = peerSlot & 0xff
  return WS_HEADER_BYTES
}

/**
 * TOTAL: returns null on a short, unknown-kind or unknown-channel frame, and
 * NEVER throws.
 *
 * This is the first function every inbound byte on a public socket reaches. A
 * throw here escapes the socket library's message handler as an uncaught
 * exception and, on the server, takes the PROCESS down - killing every room in
 * it, reachable by one byte from any peer, and reachable with no peer at all
 * after a deploy that leaves an old client speaking an older protocol version.
 * That is not hypothetical: it is what Plan 2 found in all three receive loops.
 *
 * A control frame carrying trailing bytes is ACCEPTED with an empty payload.
 * The null list above is exhaustive by contract §4.2, and a fourth rejection
 * rule would be a decision this module is not entitled to make.
 */
export function decodeWsFrame(buf: Uint8Array): WsFrame | null {
  if (buf.length < WS_HEADER_BYTES) return null
  const frameKind = buf[0]
  const peerSlot = buf[2]

  if (frameKind === WS_FRAME_DATA) {
    const channel = channelOfByte(buf[1])
    if (channel === null) return null
    return {
      frameKind,
      channel,
      controlOp: null,
      peerSlot,
      payload: buf.subarray(WS_HEADER_BYTES),
    }
  }

  if (frameKind === WS_FRAME_CONTROL) {
    const controlOp = buf[1]
    if (controlOp !== WS_CONTROL_PEER_JOINED && controlOp !== WS_CONTROL_PEER_GONE) return null
    return {
      frameKind,
      channel: null,
      controlOp,
      peerSlot,
      // Length zero, and still a view of this buffer: one shape for `payload`
      // everywhere, so no caller needs a null check it would forget.
      payload: buf.subarray(WS_HEADER_BYTES, WS_HEADER_BYTES),
    }
  }

  return null
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/net/test/wsframe.test.ts`

Expected: `Test Files  1 passed (1)` / `Tests  7 passed (7)`.

- [ ] **Step 5: Add the module to the barrel, and to the barrel test that pins it**

`packages/net/test/barrel.test.ts` pins the runtime surface as an exact set and
asserts every `src/*.ts` has an `export *` line; skipping this step turns it red
with *"a module was added to src/ without a line in the barrel"*. Sibling tasks
edit the same lists — **insert, never rewrite.**

**Task 15 closes this barrel** (contract §4.11) and its list includes this module.
Wiring it here anyway is what keeps `npm test` green *between* tasks: the shipped
barrel test fails the moment a file exists in `src/` with no `export *` line, so
deferring every line to Task 15 leaves the suite red for the whole middle of the
plan. Task 15 then finds this line already present — and its own assertion that
each `export *` line appears **exactly once** is what catches a double-add, so
never add it twice.


In `packages/net/src/index.ts`, append:

```ts
export * from './wsframe'
```

In `packages/net/test/barrel.test.ts`:

```ts
// 1. beside the other namespace imports:
import * as wsframeNs from '../src/wsframe'

// 2. inside `import type { ... } from '../src/index'`:
  // wsframe [Plan 4 Task 8]
  WsFrame,

// 3. in SURFACE:
  // [Plan 4 Task 8] the transport's private three-byte envelope.
  wsframe: [
    'WS_CHANNEL_RELIABLE',
    'WS_CHANNEL_UNRELIABLE',
    'WS_CONTROL_PEER_GONE',
    'WS_CONTROL_PEER_JOINED',
    'WS_FRAME_CONTROL',
    'WS_FRAME_DATA',
    'WS_HEADER_BYTES',
    'WS_SLOT_BROADCAST',
    'WS_SLOT_SERVER',
    'byteOfChannel',
    'channelOfByte',
    'decodeWsFrame',
    'encodeWsControl',
    'encodeWsData',
  ],

// 4. in BARREL_MODULES, in the order index.ts lists them:
  'wsframe'

// 5. in NAMESPACES:
  ['wsframe', wsframeNs],

// 6. in `interface NetTypeSurface` / `const TYPE_SURFACE`:
  WsFrame: WsFrame   /   WsFrame: true,

// 7. in the sorted literal inside "pins the type-only surface at compile time",
//    in sorted position (the comparison is an exact sorted one):
  'WsFrame',
```

- [ ] **Step 6: Verify the package, not just this file**

```bash
npx vitest run packages/net/test/wsframe.test.ts packages/net/test/barrel.test.ts
npx tsc --noEmit -p packages/net/tsconfig.json
npx vitest run
```

- [ ] **Step 7: Commit**

```bash
git add packages/net/src/wsframe.ts packages/net/test/wsframe.test.ts \
        packages/net/src/index.ts packages/net/test/barrel.test.ts && \
git commit -m "feat(net): add the WebSocket framing envelope, total on every inbound byte"
```
