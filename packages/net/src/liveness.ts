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
