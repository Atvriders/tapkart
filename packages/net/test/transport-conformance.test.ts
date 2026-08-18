import type { ChannelName } from '@tapkart/protocol'
import { makeLoopbackPair } from '../src/loopback'
import { withLocalInput } from '../src/local'
import type {
  IceCandidateInit,
  RtcChannelInit,
  RtcConnectionLike,
  RtcConnectionState,
  RtcDataChannelLike,
} from '../src/webrtc'
import { makeWebRtcTransport } from '../src/webrtc'
import { makeWebSocketTransport } from '../src/websocket'
import { makeFakeSocketPair } from './fixtures/socket-fixtures'
import type { ConformanceHarness } from './fixtures/transport-conformance'
import { runTransportConformance } from './fixtures/transport-conformance'

function loopbackHarness(local = false): ConformanceHarness {
  const pair = makeLoopbackPair({ latencyMs: 1, jitterMs: 0, lossRate: 0, seed: 1 })
  let nowMs = 0
  return {
    a: local ? withLocalInput(pair.a) : pair.a,
    b: pair.b,
    flush: () => {
      nowMs += 10
      pair.pump(nowMs)
    },
    dropB: () => pair.b.close(),
  }
}

function websocketHarness(): ConformanceHarness {
  const pair = makeFakeSocketPair()
  return {
    a: makeWebSocketTransport({ socket: pair.a, selfSlot: 1 }),
    b: makeWebSocketTransport({ socket: pair.b, selfSlot: 2 }),
    flush: pair.flush,
    dropB: () => pair.b.close(),
  }
}

interface OpenChannel extends RtcDataChannelLike {
  peer: OpenChannel | null
  deliver(data: Uint8Array): void
  closeFromPeer(): void
}

function openChannel(label: ChannelName): OpenChannel {
  const messageCbs: Array<(data: Uint8Array) => void> = []
  const closeCbs: Array<() => void> = []
  let state: 'open' | 'closed' = 'open'
  const channel: OpenChannel = {
    label,
    peer: null,
    send(data): void {
      if (state === 'open') channel.peer?.deliver(data.slice())
    },
    close(): void {
      if (state === 'closed') return
      state = 'closed'
      for (const cb of [...closeCbs]) cb()
      channel.peer?.closeFromPeer()
    },
    onOpen(): void {},
    onMessage(cb): void {
      messageCbs.push(cb)
    },
    onClose(cb): void {
      closeCbs.push(cb)
    },
    readyState: () => state,
    bufferedAmount: () => 0,
    deliver(data): void {
      if (state === 'open') for (const cb of [...messageCbs]) cb(data)
    },
    closeFromPeer(): void {
      if (state === 'closed') return
      state = 'closed'
      for (const cb of [...closeCbs]) cb()
    },
  }
  return channel
}

interface ConnectionSide {
  stateCbs: Array<(state: RtcConnectionState) => void>
  dataCbs: Array<(channel: RtcDataChannelLike) => void>
  channels: OpenChannel[]
  closed: boolean
  other: ConnectionSide | null
}

function openRtcConnections(): { offerer: RtcConnectionLike; answerer: RtcConnectionLike } {
  const sideA: ConnectionSide = { stateCbs: [], dataCbs: [], channels: [], closed: false, other: null }
  const sideB: ConnectionSide = { stateCbs: [], dataCbs: [], channels: [], closed: false, other: null }
  sideA.other = sideB
  sideB.other = sideA

  function connection(side: ConnectionSide): RtcConnectionLike {
    return {
      createDataChannel(label: string, _init: RtcChannelInit): RtcDataChannelLike {
        const name: ChannelName = label === 'unreliable' ? 'unreliable' : 'reliable'
        const local = openChannel(name)
        const remote = openChannel(name)
        local.peer = remote
        remote.peer = local
        side.channels.push(local)
        side.other?.channels.push(remote)
        for (const cb of [...(side.other?.dataCbs ?? [])]) cb(remote)
        return local
      },
      createOffer: () => Promise.resolve('offer'),
      createAnswer: () => Promise.resolve('answer'),
      setLocalDescription: () => Promise.resolve(),
      setRemoteDescription: () => Promise.resolve(),
      addIceCandidate: (_candidate: IceCandidateInit) => Promise.resolve(),
      onIceCandidate(): void {},
      onDataChannel(cb): void {
        side.dataCbs.push(cb)
      },
      onStateChange(cb): void {
        side.stateCbs.push(cb)
        cb('connected')
      },
      close(): void {
        if (side.closed) return
        side.closed = true
        for (const cb of [...side.stateCbs]) cb('closed')
        if (side.other !== null && !side.other.closed) {
          for (const cb of [...side.other.stateCbs]) cb('closed')
        }
      },
    }
  }

  return { offerer: connection(sideA), answerer: connection(sideB) }
}

function webRtcHarness(): ConformanceHarness {
  const pair = openRtcConnections()
  const b = makeWebRtcTransport({ peerId: 'a', connection: pair.answerer, role: 'answerer' })
  const a = makeWebRtcTransport({ peerId: 'b', connection: pair.offerer, role: 'offerer' })
  return { a, b, flush: () => {}, dropB: () => b.close() }
}

runTransportConformance('LoopbackTransport', () => loopbackHarness())
runTransportConformance('LocalInputTransport', () => loopbackHarness(true))
runTransportConformance('WebSocketTransport', websocketHarness)
runTransportConformance('WebRtcTransport', webRtcHarness)
