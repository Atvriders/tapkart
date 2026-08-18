// ADAPTER. The only `ws` import in packages/server/src. Node 20's global
// WebSocket is a client; the server side stays behind SocketLike.
import type { RawData, WebSocket as WsSocket } from 'ws'
import type { SocketData, SocketLike, SocketReadyState } from '@tapkart/net'

const READY_STATES: readonly SocketReadyState[] = ['connecting', 'open', 'closing', 'closed']

/** Type conversion only: `ws` supplies a Buffer, ArrayBuffer, or Buffer list. */
function toSocketData(data: RawData, isBinary: boolean): SocketData {
  let buf: Buffer
  if (Array.isArray(data)) buf = Buffer.concat(data)
  else if (data instanceof ArrayBuffer) buf = Buffer.from(data)
  else buf = Buffer.from(data)
  return isBinary ? new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength) : buf.toString('utf8')
}

export function wrapWsSocket(raw: unknown): SocketLike {
  const socket = raw as WsSocket
  // `ws` emits an EventEmitter `error` before `close` for protocol failures
  // such as maxPayload. With no listener, one hostile frame is an uncaught
  // exception that terminates every room in the process. RoomHub owns cleanup
  // through the close callback; this listener makes the preceding diagnostic
  // non-fatal without inventing a second teardown path.
  socket.on('error', () => undefined)
  return {
    send(data: SocketData): void {
      socket.send(data)
    },
    close(code?: number, reason?: string): void {
      socket.close(code, reason)
    },
    onMessage(cb: (data: SocketData) => void): void {
      socket.on('message', (data: RawData, isBinary: boolean) => { cb(toSocketData(data, isBinary)) })
    },
    onClose(cb: (code: number) => void): void {
      socket.on('close', (code: number) => { cb(code) })
    },
    readyState(): SocketReadyState {
      return READY_STATES[socket.readyState] ?? 'closed'
    },
    bufferedAmount(): number {
      return socket.bufferedAmount
    },
  }
}
