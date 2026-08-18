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
