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
