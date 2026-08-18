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
