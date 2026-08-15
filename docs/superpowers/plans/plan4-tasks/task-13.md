### Task 13: `packages/net/src/liveness.ts` — peer liveness and RTT, and nothing about authority

**Files:**
- Create: `packages/net/src/liveness.ts`
- Test: `packages/net/test/liveness.test.ts`

**Interfaces:**

- **Consumes** — from `@tapkart/protocol`, contract §3.4's `control.ts`, quoted:

  ```ts
  /** One shape for both kinds. `echoMs` is the PINGER's own clock reading and is
   *  opaque to the receiver, which copies it back verbatim. That is what keeps
   *  round-trip timing out of every deterministic path: nobody but the originator
   *  ever interprets it. */
  export interface HeartbeatMessage { seq: number; echoMs: number }
  export function encodeHeartbeat(out: Uint8Array, msg: HeartbeatMessage): number
  export function decodeHeartbeat(buf: Uint8Array): HeartbeatMessage
  export const HEARTBEAT_BYTES = 6
  ```

  Only the **type** is consumed here. This module encodes and decodes nothing: it is a state machine over `(state, nowMs)`.

- **Produces** — contract §4.8, nine exported symbols (census §11: `net/liveness` = 9):

  ```ts
  export const PING_INTERVAL_MS = 1000
  export const PEER_STALE_MS = 5000

  export interface LivenessState {
    lastSeenMs: number; lastPingSentMs: number; lastPingSeq: number
    rttMs: number; pingsSent: number; pongsSeen: number
  }
  export function createLiveness(nowMs: number): LivenessState
  export function notePacket(l: LivenessState, nowMs: number): void
  export function shouldSendPing(l: LivenessState, nowMs: number, intervalMs?: number): boolean
  export function notePingSent(l: LivenessState, seq: number, nowMs: number): void
  export function notePong(l: LivenessState, msg: HeartbeatMessage, nowMs: number): void
  export function isStale(l: LivenessState, nowMs: number, timeoutMs?: number): boolean
  ```

**There is no `HostWatch` here and no `hostLost`, and that is the point of the task.**
Ruling F-P4-22, verbatim: *"The shadow owns host-loss detection — but it counts milliseconds, not its own ticks. Delete the server's second detector."* GAP-4 found two of them; the shadow keeps it because *"the promote path it guards is already written, tested and mutation-checked"*, and the draft's objection was upheld on **what** it counted: *"a tick counter stalls exactly when `stepRace` runs zero ticks or clamps at `MAX_CATCHUP_TICKS`, which is spec §11's second risk — so the shadow under-counts and promotes late in precisely the conditions that cause host loss."*

That is already shipped: `ShadowLoop.tick(nowMs)` holds the whole detector and compares `nowMs - lastSnapshotAtMs` against `HOST_TIMEOUT_MS = 1500`, and `net/src/clock.ts`'s own comment records why — *"Those discarded milliseconds are wall time this simulation will never run, which is precisely why a host-loss detector must count wall time and not ticks."*

So this module measures **peer** liveness — RTT for a HUD, and the 5 s staleness that closes a dead lobby socket — and nothing about authority. The draft's `HostWatch`, `createHostWatch`, `noteSnapshot`, `hostLost`, `HOST_LOSS_MS`, `SNAPSHOT_HZ` and `HOST_LOSS_MISSED_SNAPSHOTS` are deleted (§11's census records the −7), and **no task may add any of them back**: a second detector disagrees with the first exactly under load, which is the only condition either one exists for.

Two decisions this task makes, because the contract fixes the signatures and not these:

1. **`rttMs` and `lastPingSeq` start at `-1`, meaning "unknown" and "no ping outstanding".** Zero is a legal RTT and seq 0 is a legal sequence number, so a zero default is a value a reader cannot distinguish from a measurement. A HUD shows `—` for `-1`.
2. **`notePong` ignores a pong whose `seq` is not the outstanding one**, and updates nothing at all when it does — not `lastSeenMs`, not `pongsSeen`. A duplicate or stale pong would otherwise report an RTT measured against the wrong ping, which reads as a network improvement rather than as the retransmit it is; and liveness has its own writer in `notePacket`, which the transport layer calls for every inbound datagram including that one.

---

- [ ] **Step 1: Write the failing test**

Create `packages/net/test/liveness.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { HeartbeatMessage } from '@tapkart/protocol'
import {
  PEER_STALE_MS,
  PING_INTERVAL_MS,
  createLiveness,
  isStale,
  notePacket,
  notePingSent,
  notePong,
  shouldSendPing,
} from '../src/liveness'

const ping = (seq: number, echoMs: number): HeartbeatMessage => ({ seq, echoMs })

describe('createLiveness', () => {
  it('starts alive, with no ping outstanding and no RTT measured', () => {
    const l = createLiveness(1000)
    expect(l.lastSeenMs).toBe(1000)
    expect(l.lastPingSentMs).toBe(1000)
    expect(l.lastPingSeq).toBe(-1)
    expect(l.rttMs).toBe(-1)
    expect(l.pingsSent).toBe(0)
    expect(l.pongsSeen).toBe(0)
  })

  it('gives every call its own state', () => {
    const a = createLiveness(0)
    const b = createLiveness(0)
    notePacket(a, 500)
    expect(b.lastSeenMs).toBe(0)
  })
})

describe('isStale', () => {
  it('is false at 4999 ms and true at 5000 ms', () => {
    const l = createLiveness(0)
    expect(isStale(l, 4999)).toBe(false)
    expect(isStale(l, PEER_STALE_MS)).toBe(true)
  })

  it('takes the boundary from the last packet seen, not from construction', () => {
    const l = createLiveness(0)
    notePacket(l, 4000)
    expect(isStale(l, 8999)).toBe(false)
    expect(isStale(l, 9000)).toBe(true)
  })

  it('honours an explicit timeout', () => {
    const l = createLiveness(0)
    expect(isStale(l, 99, 100)).toBe(false)
    expect(isStale(l, 100, 100)).toBe(true)
  })

  it('is never stale at the instant it was created', () => {
    const l = createLiveness(1_700_000_000_000)
    expect(isStale(l, 1_700_000_000_000)).toBe(false)
  })
})

describe('shouldSendPing', () => {
  it('is false at 999 ms and true at 1000 ms after construction', () => {
    const l = createLiveness(0)
    expect(shouldSendPing(l, 999)).toBe(false)
    expect(shouldSendPing(l, PING_INTERVAL_MS)).toBe(true)
  })

  it('does not consume: it is still true until a ping is actually noted', () => {
    const l = createLiveness(0)
    expect(shouldSendPing(l, 1500)).toBe(true)
    expect(shouldSendPing(l, 1500)).toBe(true)
    notePingSent(l, 1, 1500)
    expect(shouldSendPing(l, 1500)).toBe(false)
    expect(shouldSendPing(l, 2499)).toBe(false)
    expect(shouldSendPing(l, 2500)).toBe(true)
  })

  it('is not reset by ordinary traffic - a stream of snapshots is not a ping', () => {
    const l = createLiveness(0)
    notePacket(l, 900)
    expect(shouldSendPing(l, 1000)).toBe(true)
  })

  it('honours an explicit interval', () => {
    const l = createLiveness(0)
    expect(shouldSendPing(l, 199, 200)).toBe(false)
    expect(shouldSendPing(l, 200, 200)).toBe(true)
  })
})

describe('notePingSent', () => {
  it('records the sequence number, the send time and the count', () => {
    const l = createLiveness(0)
    notePingSent(l, 7, 1000)
    expect(l.lastPingSeq).toBe(7)
    expect(l.lastPingSentMs).toBe(1000)
    expect(l.pingsSent).toBe(1)
    // Sending a ping is not evidence the far side is alive.
    expect(l.lastSeenMs).toBe(0)
  })
})

describe('notePong', () => {
  it('measures the round trip from the echoed clock reading', () => {
    const l = createLiveness(0)
    notePingSent(l, 1, 1000)
    notePong(l, ping(1, 1000), 1120)
    expect(l.rttMs).toBe(120)
    expect(l.pongsSeen).toBe(1)
    expect(l.lastSeenMs).toBe(1120)
  })

  it('computes RTT across a u32 wrap without going negative', () => {
    // echoMs travels as a u32 (HEARTBEAT_BYTES = 6: a u16 seq and a u32 echo),
    // so it wraps every ~49.7 days while nowMs does not. Measured in u32 space,
    // the wrap is arithmetic rather than a 4-billion-millisecond round trip.
    const l = createLiveness(0)
    const echo = 0xffffff00 // 256 ms before the wrap
    const now = 0x1_0000_0040 // 64 ms after it, as a full JS number
    notePingSent(l, 3, echo)
    notePong(l, ping(3, echo), now)
    expect(l.rttMs).toBe(320)
    expect(l.rttMs).toBeGreaterThanOrEqual(0)
  })

  it('measures a real wall clock, which is far past u32, without a negative RTT', () => {
    const l = createLiveness(0)
    const now = 1_700_000_000_450
    const echo = (1_700_000_000_000 >>> 0)
    notePingSent(l, 4, echo)
    notePong(l, ping(4, echo), now)
    expect(l.rttMs).toBe(450)
  })

  it('IGNORES a pong for a ping that is not outstanding, and changes nothing', () => {
    const l = createLiveness(0)
    notePingSent(l, 5, 1000)
    notePong(l, ping(5, 1000), 1100)
    const before = { ...l }

    // A duplicate of the pong already accounted for, and a pong for a ping this
    // peer never sent. Both would otherwise report an RTT measured against the
    // wrong ping - which reads on a HUD as the network improving.
    notePong(l, ping(5, 1000), 5000)
    notePong(l, ping(99, 0), 5000)

    expect({ ...l }).toEqual(before)
    expect(l.rttMs).toBe(100)
    expect(l.pongsSeen).toBe(1)
    expect(l.lastSeenMs).toBe(1100)
  })

  it('ignores a pong arriving before any ping was sent', () => {
    const l = createLiveness(0)
    notePong(l, ping(0, 0), 1000)
    expect(l.rttMs).toBe(-1)
    expect(l.pongsSeen).toBe(0)
    expect(l.lastSeenMs).toBe(0)
  })

  it('accepts the next ping after one went unanswered', () => {
    const l = createLiveness(0)
    notePingSent(l, 1, 1000) // lost
    notePingSent(l, 2, 2000)
    notePong(l, ping(2, 2000), 2080)
    expect(l.rttMs).toBe(80)
    expect(l.pingsSent).toBe(2)
    expect(l.pongsSeen).toBe(1)
  })
})

describe('the whole cycle, with no timers and no clock', () => {
  it('pings once a second, stays fresh while pongs come back, and goes stale when they stop', () => {
    const l = createLiveness(0)
    let seq = 0
    let now = 0

    // Five seconds of healthy traffic, polled at 60 Hz.
    for (; now <= 5000; now += 16) {
      if (shouldSendPing(l, now)) {
        seq++
        notePingSent(l, seq, now)
        notePong(l, ping(seq, now), now + 8) // the answer, 8 ms later
      }
      expect(isStale(l, now)).toBe(false)
    }
    // 60 Hz polling puts the ping on the first poll at or past each interval:
    // 1008, 2016, 3024, 4032 ms. The fifth would be 5040, past this loop.
    expect(l.pingsSent).toBe(4)
    expect(l.pongsSeen).toBe(4)
    expect(l.rttMs).toBe(8)

    // The far side stops answering. Nothing is noted; only time passes.
    const wentQuietAt = l.lastSeenMs
    expect(isStale(l, wentQuietAt + PEER_STALE_MS - 1)).toBe(false)
    expect(isStale(l, wentQuietAt + PEER_STALE_MS)).toBe(true)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/net/test/liveness.test.ts`

Expected: FAIL, before any assertion runs, with

```
Error: Failed to resolve import "../src/liveness" from "packages/net/test/liveness.test.ts". Does the file exist?
```

- [ ] **Step 3: Write the implementation**

Create `packages/net/src/liveness.ts`:

```ts
// PURE (contract §0a). Every function here is a function of (state, nowMs):
// no socket, no clock, no timer, nothing to mock. Peer staleness is a unit test
// with three lines.
import type { HeartbeatMessage } from '@tapkart/protocol'

/** Contract §6.2's cadence table: ping at 1 Hz, on the control transport only. */
export const PING_INTERVAL_MS = 1000

/**
 * Five seconds with nothing at all from a peer closes its lobby socket.
 *
 * Deliberately much longer than HOST_TIMEOUT_MS (1500), and measuring a
 * different thing: a backgrounded mobile browser routinely goes quiet for a
 * second or two, and treating that as a dead socket would evict half the room
 * every time somebody read a message. Host loss is the shadow's, at 1.5 s, and
 * it promotes rather than disconnects.
 */
export const PEER_STALE_MS = 5000

/**
 * u32 wrap-around: echoMs travels as a u32 (HEARTBEAT_BYTES = 6) while a
 * caller's nowMs is a full JS millisecond count in the 1.7e12 range. Both are
 * taken modulo 2^32 before subtracting, which is what makes the difference a
 * duration rather than either a 49-day round trip or a negative number.
 */
const U32 = 0x1_0000_0000

export interface LivenessState {
  /** The last time ANY packet was seen from this peer. isStale reads this. */
  lastSeenMs: number
  lastPingSentMs: number
  /** The seq of the ping awaiting an answer, or -1 for none. */
  lastPingSeq: number
  /** Round trip in ms, or -1 when nothing has been measured yet. A HUD shows a
   * dash for -1: zero is a legal RTT, so a zero default is a value no reader can
   * tell from a measurement. */
  rttMs: number
  pingsSent: number
  pongsSeen: number
}

/**
 * A peer that has just been heard from. `lastPingSentMs` starts at `nowMs`, so
 * the first ping goes out one full interval later rather than in the same
 * millisecond as the handshake that created this - at which point there is
 * nothing to measure and the socket may not even be writable yet.
 */
export function createLiveness(nowMs: number): LivenessState {
  return {
    lastSeenMs: nowMs,
    lastPingSentMs: nowMs,
    lastPingSeq: -1,
    rttMs: -1,
    pingsSent: 0,
    pongsSeen: 0,
  }
}

/** Any inbound datagram from this peer, of any kind. Proof of life, and the
 * only writer of `lastSeenMs` besides an accepted pong. */
export function notePacket(l: LivenessState, nowMs: number): void {
  l.lastSeenMs = nowMs
}

/**
 * Does NOT consume: a check and a send are separate, so a caller that decides
 * not to send (a socket mid-close, say) has not silently skipped a whole
 * interval. `notePingSent` is what moves the cursor.
 */
export function shouldSendPing(l: LivenessState, nowMs: number, intervalMs: number = PING_INTERVAL_MS): boolean {
  return nowMs - l.lastPingSentMs >= intervalMs
}

export function notePingSent(l: LivenessState, seq: number, nowMs: number): void {
  l.lastPingSeq = seq
  l.lastPingSentMs = nowMs
  l.pingsSent++
}

/**
 * An answer to the outstanding ping, and nothing else.
 *
 * A pong whose seq is not `lastPingSeq` is IGNORED ENTIRELY - a duplicate, a
 * retransmit, or an answer to a ping two intervals old would otherwise be timed
 * against the wrong send and report an RTT far shorter than the truth, which on
 * a HUD reads as the network improving at the moment it degraded. Liveness
 * itself is not lost by ignoring it: `notePacket` runs for every inbound
 * datagram, including that one.
 *
 * `msg.echoMs` is this peer's OWN earlier clock reading, copied back verbatim by
 * a receiver that never interprets it (contract §3.4). Nothing here trusts the
 * far side's clock, which is the property that keeps RTT from becoming clock
 * skew.
 */
export function notePong(l: LivenessState, msg: HeartbeatMessage, nowMs: number): void {
  if (msg.seq !== l.lastPingSeq) return
  const sent = ((msg.echoMs % U32) + U32) % U32
  const now = ((nowMs % U32) + U32) % U32
  l.rttMs = (now - sent + U32) % U32
  l.pongsSeen++
  l.lastSeenMs = nowMs
  // Cleared, so the same pong arriving twice is the second one's problem and
  // not this measurement's.
  l.lastPingSeq = -1
}

/** Nothing from this peer for `timeoutMs`. The caller decides what that means:
 * RoomHub closes the socket, RoomClient marks the room closed or - mid-race -
 * sets `serverLost` and keeps racing (F-P4-24). */
export function isStale(l: LivenessState, nowMs: number, timeoutMs: number = PEER_STALE_MS): boolean {
  return nowMs - l.lastSeenMs >= timeoutMs
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/net/test/liveness.test.ts`

Expected: PASS, 18 tests.

Then `npx vitest run packages/net` — expected PASS, with the same caveat Task 12 records: if the barrel task (Task 15) has already landed, `barrel.test.ts` needs `liveness` in its lists, and that edit is Task 15's.

- [ ] **Step 5: Commit**

```bash
git add packages/net/src/liveness.ts packages/net/test/liveness.test.ts && git commit -m "feat(net): peer liveness and RTT over an injected clock

createLiveness/notePacket/shouldSendPing/notePingSent/notePong/isStale, all pure
functions of (state, nowMs). No HostWatch and no hostLost: F-P4-22 puts the one
host-loss detector inside ShadowLoop.tick(nowMs), counting wall milliseconds."
```
