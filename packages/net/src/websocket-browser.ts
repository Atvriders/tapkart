import type { SocketData, SocketLike, SocketReadyState } from './socket'

/** The deliberately tiny DOM surface this adapter consumes. */
interface BrowserMessageEvent {
  readonly data: string | ArrayBuffer
}

interface BrowserCloseEvent {
  readonly code: number
}

interface BrowserWebSocketLike {
  binaryType: string
  readonly readyState: number
  readonly bufferedAmount: number
  send(data: string | Uint8Array): void
  close(code?: number, reason?: string): void
  addEventListener(type: 'message', cb: (event: BrowserMessageEvent) => void): void
  addEventListener(type: 'close', cb: (event: BrowserCloseEvent) => void): void
}

interface BrowserWebSocketConstructor {
  new (url: string): BrowserWebSocketLike
}

// net intentionally compiles with ES2022 and no DOM library. This declaration
// is local to the adapter so no browser type leaks into a pure package.
declare const WebSocket: BrowserWebSocketConstructor

function socketState(state: number): SocketReadyState {
  if (state === 0) return 'connecting'
  if (state === 1) return 'open'
  if (state === 2) return 'closing'
  return 'closed'
}

/** Construct the browser socket only when the composition root asks for one. */
export function browserWebSocket(url: string): SocketLike {
  const socket = new WebSocket(url)
  socket.binaryType = 'arraybuffer'

  return {
    send(data: SocketData): void {
      // Own the bytes across the adapter boundary. In particular, preserve the
      // exact window of a subarray rather than exposing its larger backing store.
      socket.send(typeof data === 'string' ? data : data.slice())
    },
    close(code?: number, reason?: string): void {
      socket.close(code, reason)
    },
    onMessage(cb): void {
      // addEventListener gives SocketLike its append-only listener semantics.
      socket.addEventListener('message', (event) => {
        if (typeof event.data === 'string') cb(event.data)
        else cb(new Uint8Array(event.data).slice())
      })
    },
    onClose(cb): void {
      socket.addEventListener('close', (event) => cb(event.code))
    },
    readyState(): SocketReadyState {
      return socketState(socket.readyState)
    },
    bufferedAmount(): number {
      return socket.bufferedAmount
    },
  }
}
