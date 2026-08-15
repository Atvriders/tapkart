### Task 6: `packages/protocol/src/control.ts` — `ping` and `pong`

**Files:**
- Create: `packages/protocol/src/control.ts`
- Create: `packages/protocol/test/control.test.ts`
- Modify: `packages/protocol/src/index.ts` (one `export *` line)
- Modify: `packages/protocol/test/barrel.test.ts` (the pinned public surface)
- Test: `packages/protocol/test/control.test.ts`

**This module is PURE** (contract §0a). It is a function of its arguments over a
caller-owned buffer: no socket, no clock, no allocation of its own buffer. There
is no adapter half — `ping`/`pong` reach a wire only through a `Transport` that
some other task owns.

---

**Interfaces:**

**Consumes** — from `packages/protocol/src/bits.ts`, quoted exactly (contract §2.6):

```ts
export class BitWriter {
  constructor(buf: Uint8Array)
  reset(): void
  writeBits(value: number, bits: number): void
  writeFloatQ(value: number, min: number, max: number, bits: number): void
  byteLength(): number
}
export class BitReader {
  constructor(buf: Uint8Array)
  reset(): void
  readBits(bits: number): number   // THROWS a RangeError past the end of the buffer
  readFloatQ(min: number, max: number, bits: number): number
}
```

`BitWriter.writeBits` writes the low `bits` bits LSB-first and **does not clamp or
mask**; `BitWriter` neither throws nor grows on overflow, so a caller with an
undersized buffer gets a valid-looking message with garbage in it. That is why
`HEARTBEAT_BYTES` below is derived from the bit table and asserted by a test.

**Consumes** — from `packages/protocol/src/types.ts`, used by the test only
(contract §2.6):

```ts
export const PROTOCOL_VERSION = 1                       // becomes 2 in Task 2's version bump
export const WIRE_TAG = {
  hello: 0x01, welcome: 0x02, lobby: 0x03, start: 0x04, clientUpdate: 0x05,
  input: 0x10, snapshot: 0x11, events: 0x12, checkpoint: 0x13, resyncRequest: 0x14,
  authorityChange: 0x20, ping: 0x30, pong: 0x31,
} as const
export function encodeHeader(out: Uint8Array, kind: MessageKind): number   // writes [tag, version], returns 2
export function decodeHeader(buf: Uint8Array): WireHeader                  // throws on unknown tag or version mismatch
export interface WireHeader { kind: MessageKind; protocolVersion: number }
```

The test uses `encodeHeader`/`decodeHeader`/`WIRE_TAG` and is indifferent to
whether `PROTOCOL_VERSION` is 1 or 2 — it never asserts the version byte's value,
only that a `pong`'s **body** is byte-identical to the `ping`'s. This task
therefore does not depend on the version bump landing first, in either order.

**Produces** — `packages/protocol/src/control.ts`, exactly four exported names
(contract §3.4, §11's census row `protocol/control | 4`):

```ts
export interface HeartbeatMessage { seq: number; echoMs: number }
export function encodeHeartbeat(out: Uint8Array, msg: HeartbeatMessage): number
export function decodeHeartbeat(buf: Uint8Array): HeartbeatMessage
export const HEARTBEAT_BYTES = 6
```

**The bit layout, from contract §3.5, copied verbatim:**

| Field | Bits |
|---|---|
| `seq` | 16 |
| `echoMs` | 32 |
| **total** | **48 bits = 6 B** |

`out` is the **body** buffer, not the datagram: every layout in §3.5 is *after*
the 2-byte `encodeHeader` output, and the caller writes the header and passes
`out.subarray(2)` — exactly as `authority.ts:206-208` does. `HEARTBEAT_BYTES` is
therefore 6, the body, and a `ping` datagram on the wire is 8 bytes.

**Two facts a later task depends on and must not be re-decided here:**

- **One codec, two kinds.** `ping` and `pong` are distinguished *only* by the
  `WIRE_TAG` byte the caller writes with `encodeHeader`. A `pong` copies the
  `ping`'s `seq` and `echoMs` **unchanged** — a receiver that stamped its own
  time would turn RTT into clock skew and nothing would fail loudly.
- **`decodeHeartbeat` is not total, and that is deliberate.** It returns a fresh
  object (§0's "cold path returns"), so it cannot return `null`; a truncated body
  throws from `BitReader`. Its caller decodes it inside a `try`/`catch` or behind
  the shipped guard. **Note for whoever writes that caller:** `DatagramGuard.decode`'s
  helper signature is `decode<T>(decode: (buf: Uint8Array, out: T) => void, buf, out)`
  and a *returning* decoder does not fit it — wrap the call in a local
  `try`/`catch` that counts a drop, exactly as `receive.ts` does. The test below
  pins the throw so nobody "fixes" it into a silent all-zeros heartbeat.

---

- [ ] **Step 1: Write the failing test**

Create `packages/protocol/test/control.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { WIRE_TAG, decodeHeader, encodeHeader } from '../src/types'
import { HEARTBEAT_BYTES, decodeHeartbeat, encodeHeartbeat } from '../src/control'
import type { HeartbeatMessage } from '../src/control'

const HEADER_BYTES = 2

describe('protocol/control - ping and pong share one codec', () => {
  it('round-trips seq and echoMs at both ends of their ranges', () => {
    const buf = new Uint8Array(HEARTBEAT_BYTES)
    const cases: HeartbeatMessage[] = [
      { seq: 0, echoMs: 0 },
      { seq: 1, echoMs: 1 },
      { seq: 65535, echoMs: 4294967295 },
      { seq: 40000, echoMs: 2147483648 },
    ]
    for (const msg of cases) {
      const n = encodeHeartbeat(buf, msg)
      expect(n).toBe(HEARTBEAT_BYTES)
      expect(decodeHeartbeat(buf.subarray(0, n))).toEqual(msg)
    }
  })

  it('a pong built from a ping is byte-identical in seq and echoMs', () => {
    const ping = new Uint8Array(HEADER_BYTES + HEARTBEAT_BYTES)
    const h = encodeHeader(ping, 'ping')
    encodeHeartbeat(ping.subarray(h), { seq: 4242, echoMs: 1_234_567_890 })

    const received = decodeHeartbeat(ping.subarray(HEADER_BYTES))
    const pong = new Uint8Array(HEADER_BYTES + HEARTBEAT_BYTES)
    const ph = encodeHeader(pong, 'pong')
    encodeHeartbeat(pong.subarray(ph), received)

    expect(pong[0]).toBe(WIRE_TAG.pong)
    expect(ping[0]).toBe(WIRE_TAG.ping)
    expect(decodeHeader(pong).kind).toBe('pong')
    expect(Array.from(pong.subarray(HEADER_BYTES))).toEqual(Array.from(ping.subarray(HEADER_BYTES)))
  })

  it('throws rather than inventing fields on a truncated body', () => {
    const buf = new Uint8Array(HEARTBEAT_BYTES)
    encodeHeartbeat(buf, { seq: 7, echoMs: 9 })
    expect(() => decodeHeartbeat(buf.subarray(0, 5))).toThrow(RangeError)
  })
})
```

Three assertions, each earning its place:

1. **The range test is the one that catches a wrong width.** `echoMs` at
   `4294967295` needs all 32 bits and `seq` at `65535` all 16; a 24-bit or
   31-bit field silently truncates and every small-number round-trip still
   passes. `2147483648` is the value that would come back **negative** from a
   reader accumulating with `|=` instead of `+=`.
2. **The pong test compares the encoded BODY BYTES, not the decoded fields.** A
   test that re-decoded and compared `seq`/`echoMs` would pass against an
   implementation that re-stamped `echoMs` from a clock this module does not
   have — because it would compare the value it had just written. Comparing the
   bytes of two independently encoded datagrams is what makes "copies it back
   verbatim" checkable.
3. **The truncation test is the drop-path pin.** 5 bytes is 40 bits and the
   layout needs 48, so `BitReader` must refuse rather than read `undefined >> n`
   as zero. Without this assertion, a half-received heartbeat would decode into a
   plausible `{seq: n, echoMs: 0}` and the liveness module would compute a
   49-day RTT from it.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/protocol/test/control.test.ts`

Expected: FAIL, before any assertion runs, with

```
Error: Cannot find module '../src/control' imported from '<repo>/packages/protocol/test/control.test.ts'
Caused by: Error: Failed to load url ../src/control (resolved id: ../src/control) ... Does the file exist?
 Test Files  1 failed (1)
```

- [ ] **Step 3: Write the implementation**

Create `packages/protocol/src/control.ts`:

```ts
import { BitReader, BitWriter } from './bits'

/**
 * PURE (contract §0a). One shape for both kinds: `ping` and `pong` differ only
 * in the WIRE_TAG byte the caller writes with encodeHeader.
 *
 * `echoMs` is the PINGER's own clock reading and is opaque to the receiver,
 * which copies it back verbatim. That is what keeps round-trip timing out of
 * every deterministic path: nobody but the originator ever interprets it, so no
 * simulation anywhere reads a clock because a heartbeat arrived.
 *
 * A receiver that stamped its OWN time into the pong would turn every RTT
 * measurement into a measurement of clock skew between two phones - and nothing
 * would fail loudly, because both numbers are milliseconds and both look
 * reasonable. control.test.ts compares the encoded bytes of a ping and the pong
 * built from it for exactly that reason.
 */
export interface HeartbeatMessage {
  seq: number
  /** The pinger's own clock, as a u32 of milliseconds. Wraps every 49.7 days;
   *  `notePong` computes `(nowMs - echoMs) >>> 0`, so a wrap costs one bogus RTT
   *  sample and never a negative one. */
  echoMs: number
}

/**
 * Worst-case encoded BODY size, derived from contract §3.5's table - 16 + 32
 * bits = 48 bits = 6 B - and asserted by a test that encodes a maximal message
 * and compares byteLength(). Never guessed: BitWriter silently truncates past
 * the end of its buffer, so a caller that sized a buffer from a wrong constant
 * would get a valid-looking heartbeat with a garbage timestamp in it.
 *
 * This is the BODY. Every layout in §3.5 sits after the 2-byte encodeHeader
 * output, so a ping datagram on the wire is 2 + 6 = 8 bytes.
 */
export const HEARTBEAT_BYTES = 6

const SEQ_BITS = 16
const ECHO_MS_BITS = 32

/**
 * Writes the heartbeat body into `out` - which is the buffer AFTER the header,
 * i.e. `out.subarray(2)` at the call site - and returns the byte count.
 *
 * Both fields are normalised to their wire widths here rather than trusted:
 * `seq` is a wrapping counter and `echoMs` a u32 of milliseconds, and both
 * arrive from a caller that may have let either exceed its range. writeBits
 * does not mask, so the alternative to normalising is a silently corrupted
 * neighbouring field.
 */
export function encodeHeartbeat(out: Uint8Array, msg: HeartbeatMessage): number {
  const w = new BitWriter(out)
  w.writeBits(msg.seq & 0xffff, SEQ_BITS)
  w.writeBits(msg.echoMs >>> 0, ECHO_MS_BITS)
  return w.byteLength()
}

/**
 * Reads what encodeHeartbeat wrote, from the body buffer.
 *
 * Returns a FRESH object rather than filling a caller-owned one: §0's split is
 * "cold path returns, hot path fills `out`", and heartbeats are the cold path -
 * one per second per peer, against 20 Hz snapshots.
 *
 * NOT TOTAL, deliberately. A body too short to hold 48 bits throws a RangeError
 * from BitReader rather than decoding a truncated datagram into a plausible
 * all-zeros heartbeat. The caller catches it and counts a drop, exactly as
 * receive.ts does for every other decode - and note that DatagramGuard.decode's
 * `(buf, out) => void` helper does not fit a returning decoder, so that caller
 * writes its own try/catch.
 */
export function decodeHeartbeat(buf: Uint8Array): HeartbeatMessage {
  const r = new BitReader(buf)
  const seq = r.readBits(SEQ_BITS)
  const echoMs = r.readBits(ECHO_MS_BITS)
  return { seq, echoMs }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/protocol/test/control.test.ts`

Expected: `Test Files  1 passed (1)` / `Tests  3 passed (3)`.

- [ ] **Step 5: Add the module to the barrel, and to the barrel test that pins it**

`packages/protocol/test/barrel.test.ts` asserts the package's public surface as an
**exact set in both directions**, and separately asserts that every `.ts` file in
`src/` (except `index.ts`) has a line in the barrel. So a new module that skips
this step does not merely go un-exported — it turns `packages/protocol/test/barrel.test.ts`
red with *"a module was added to src/ without a line in the barrel"*.

Sibling Plan 4 tasks add `strings`, `lobby` and rows to `room` in the same two
files. **Every edit below is additive; do not rewrite a list, insert into it.**

In `packages/protocol/src/index.ts`, append one line after the existing
`export * from './input'`:

```ts
export * from './control'
```

In `packages/protocol/test/barrel.test.ts`, five insertions:

```ts
// 1. beside the other namespace imports (they are alphabetical):
import * as controlNs from '../src/control'

// 2. inside the `import type { ... } from '../src/index'` block:
  // control [Plan 4 Task 6]
  HeartbeatMessage,

// 3. in SURFACE, after the `input` row:
  // [Plan 4 Task 6] ping and pong, one codec
  control: ['HEARTBEAT_BYTES', 'decodeHeartbeat', 'encodeHeartbeat'],

// 4. in BARREL_MODULES, appended in the order index.ts lists the modules:
  'control'

// 5. in NAMESPACES, after ['input', inputNs]:
  ['control', controlNs],
```

and the type-only half, which is pinned twice — once by the compiler and once by
a runtime list:

```ts
// in `interface ProtocolTypeSurface`:
  HeartbeatMessage: HeartbeatMessage
// in `const TYPE_SURFACE: Record<keyof ProtocolTypeSurface, true>`:
  HeartbeatMessage: true,
// and in the sorted literal inside "pins the type-only surface at compile time",
// inserted in sorted position (the assertion is an exact sorted comparison, so
// keep the list sorted even after a sibling task has added its own names):
  'HeartbeatMessage',
```

- [ ] **Step 6: Verify the package, not just this file**

Run, and expect all three green:

```bash
npx vitest run packages/protocol/test/control.test.ts packages/protocol/test/barrel.test.ts
npx tsc --noEmit -p packages/protocol/tsconfig.json
npx vitest run
```

`tsc` is not optional here: `TYPE_SURFACE` is a `Record<keyof ProtocolTypeSurface, true>`,
so a type missing from either half is a compile error and **not** a test failure.

- [ ] **Step 7: Commit**

```bash
git add packages/protocol/src/control.ts packages/protocol/test/control.test.ts \
        packages/protocol/src/index.ts packages/protocol/test/barrel.test.ts && \
git commit -m "feat(protocol): add the ping/pong codec, one shape for both kinds"
```
