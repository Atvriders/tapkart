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
