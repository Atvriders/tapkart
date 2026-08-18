import type { SocketData, SocketLike, SocketReadyState } from '../../src/socket'

interface Core {
  socket: SocketLike
  messageCbs: Array<(data: SocketData) => void>
  closeCbs: Array<(code: number) => void>
  outbox: SocketData[]
  sentBinary: Uint8Array[]
  sentText: string[]
  setBuffered(n: number): void
  deliver(data: SocketData): void
  fireClose(code: number): void
  deliverable(): boolean
  /** The far end, when this socket is half of a pair. */
  peer: Core | null
}

function copyData(data: SocketData): SocketData {
  return typeof data === 'string' ? data : data.slice()
}

function makeCore(): Core {
  const messageCbs: Array<(data: SocketData) => void> = []
  const closeCbs: Array<(code: number) => void> = []
  const outbox: SocketData[] = []
  const sentBinary: Uint8Array[] = []
  const sentText: string[] = []
  let state: SocketReadyState = 'open'
  let buffered = 0

  const core: Core = {
    socket: {
      send(data: SocketData): void {
        if (state === 'closed') return
        if (typeof data === 'string') {
          sentText.push(data)
          buffered += data.length
        } else {
          // Recorded as a copy: the transport under test is entitled to reuse
          // its send buffer, so a retained view would show a test the bytes of
          // whatever was framed LAST and every assertion about frame N would
          // silently be an assertion about the newest one.
          sentBinary.push(data.slice())
          buffered += data.byteLength
        }
        outbox.push(copyData(data))
      },
      close(code?: number, _reason?: string): void {
        if (state === 'closed') return
        outbox.length = 0
        const c = code ?? 1000
        core.fireClose(c)
        // A real close reaches the far end, and the conformance harness's
        // dropB() is exactly that: the peer must learn, or nothing above this
        // fixture can ever see a socket die.
        if (core.peer && core.peer.deliverable()) core.peer.fireClose(c)
      },
      onMessage(cb: (data: SocketData) => void): void {
        messageCbs.push(cb)
      },
      onClose(cb: (code: number) => void): void {
        closeCbs.push(cb)
      },
      readyState(): SocketReadyState {
        return state
      },
      bufferedAmount(): number {
        return buffered
      },
    },
    messageCbs,
    closeCbs,
    outbox,
    sentBinary,
    sentText,
    setBuffered(n: number): void {
      buffered = n
    },
    deliver(data: SocketData): void {
      if (state === 'closed') return
      // A copy of the list: a callback that registers another callback (every
      // loop in this package does, at construction) must not mutate the list
      // being iterated.
      for (const cb of [...messageCbs]) cb(data)
    },
    fireClose(code: number): void {
      state = 'closed'
      for (const cb of [...closeCbs]) cb(code)
    },
    deliverable(): boolean {
      return state !== 'closed'
    },
    peer: null,
  }
  return core
}

export function makeFakeSocketPair(): {
  a: SocketLike
  b: SocketLike
  flush(): void
  stall(bytes: number): void
  drain(): void
} {
  const ca = makeCore()
  const cb = makeCore()
  ca.peer = cb
  cb.peer = ca

  return {
    a: ca.socket,
    b: cb.socket,
    flush(): void {
      // Both directions, until quiescent: a delivered frame may provoke a reply,
      // and a test whose ordering assertions depended on how many times it
      // called flush() would be measuring the fixture rather than the transport.
      for (let round = 0; round < 8; round++) {
        if (ca.outbox.length === 0 && cb.outbox.length === 0) return
        const fromA = ca.outbox.splice(0, ca.outbox.length)
        const fromB = cb.outbox.splice(0, cb.outbox.length)
        for (const data of fromA) cb.deliver(data)
        for (const data of fromB) ca.deliver(data)
      }
      throw new Error('makeFakeSocketPair.flush: still delivering after 8 rounds')
    },
    /** Drives bufferedAmount() on BOTH ends, which is what makes §4.3's mailbox
     *  testable at all: there is no other way to model a socket that has stopped
     *  draining. Sends still queue and still arrive on flush() - a stalled socket
     *  is slow, not disconnected. */
    stall(bytes: number): void {
      ca.setBuffered(bytes)
      cb.setBuffered(bytes)
    },
    drain(): void {
      ca.setBuffered(0)
      cb.setBuffered(0)
    },
  }
}

export function makeRecordingSocket(): SocketLike & {
  sentBinary(): Uint8Array[]
  sentText(): string[]
  deliver(data: SocketData): void
  fireClose(code: number): void
} {
  const core = makeCore()
  return {
    send: (data) => core.socket.send(data),
    close: (code, reason) => core.socket.close(code, reason),
    onMessage: (cb) => core.socket.onMessage(cb),
    onClose: (cb) => core.socket.onClose(cb),
    readyState: () => core.socket.readyState(),
    bufferedAmount: () => core.socket.bufferedAmount(),
    sentBinary: () => core.sentBinary,
    sentText: () => core.sentText,
    deliver: (data) => core.deliver(data),
    fireClose: (code) => core.fireClose(code),
  }
}
