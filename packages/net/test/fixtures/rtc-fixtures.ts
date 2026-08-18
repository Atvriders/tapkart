import type {
  IceCandidateInit,
  IceServerConfig,
  RtcChannelInit,
  RtcConnectionFactory,
  RtcConnectionLike,
  RtcConnectionState,
  RtcDataChannelLike,
} from '../../src/webrtc'

interface FakeChannel extends RtcDataChannelLike {
  readonly init: RtcChannelInit
  peer: FakeChannel | null
  markOpen(): void
  fireOpen(): void
  deliver(data: Uint8Array): void
}

function makeChannel(label: string, init: RtcChannelInit): FakeChannel {
  const openCbs: Array<() => void> = []
  const messageCbs: Array<(data: Uint8Array) => void> = []
  const closeCbs: Array<() => void> = []
  let state: 'connecting' | 'open' | 'closing' | 'closed' = 'connecting'

  const ch: FakeChannel = {
    label,
    init,
    peer: null,
    send(data: Uint8Array): void {
      if (state !== 'open') return
      // A copy, always: the far end is entitled to hold what it is handed, and
      // real SCTP never delivers the sender's own buffer.
      ch.peer?.deliver(data.slice())
    },
    close(): void {
      if (state === 'closed') return
      state = 'closed'
      for (const cb of [...closeCbs]) cb()
    },
    onOpen(cb: () => void): void {
      openCbs.push(cb)
    },
    onMessage(cb: (data: Uint8Array) => void): void {
      messageCbs.push(cb)
    },
    onClose(cb: () => void): void {
      closeCbs.push(cb)
    },
    readyState: () => state,
    // Real SCTP back-pressure is not modelled: this transport's only queue is
    // the pre-open one, and §8.3 records buffered-amount realism as something
    // CI cannot verify either way.
    bufferedAmount: () => 0,
    // Opening is two steps on purpose: BOTH ends of a pair reach 'open' before
    // either application learns. A fixture that fired one end's onOpen while the
    // far end was still 'connecting' would silently discard the first flush -
    // and the pre-open queue is exactly what that flush exists to deliver.
    markOpen(): void {
      if (state === 'connecting') state = 'open'
    },
    fireOpen(): void {
      if (state !== 'open') return
      for (const cb of [...openCbs]) cb()
    },
    deliver(data: Uint8Array): void {
      if (state !== 'open') return
      for (const cb of [...messageCbs]) cb(data)
    },
  }
  return ch
}

interface Side {
  created: FakeChannel[]
  received: FakeChannel[]
  localSet: boolean
  remoteSet: boolean
  candidatesIn: number
  stateCbs: Array<(s: RtcConnectionState) => void>
  dataChannelCbs: Array<(ch: RtcDataChannelLike) => void>
  iceCbs: Array<(c: IceCandidateInit | null) => void>
  closed: boolean
}

function makeSide(): Side {
  return {
    created: [],
    received: [],
    localSet: false,
    remoteSet: false,
    candidatesIn: 0,
    stateCbs: [],
    dataChannelCbs: [],
    iceCbs: [],
    closed: false,
  }
}

function candidateAt(n: number): IceCandidateInit {
  // RFC 5737 documentation address: never a real host.
  return {
    candidate: `candidate:${n} 1 udp 2113937151 192.0.2.${n} 50000 typ host`,
    sdpMid: '0',
    sdpMLineIndex: 0,
  }
}

export function makeFakeRtcPair(): {
  offerer: RtcConnectionLike
  answerer: RtcConnectionLike
  settle(): Promise<void>
  failBoth(): void
} {
  const a = makeSide()
  const b = makeSide()
  let connected = false
  let candidateSeq = 0

  function pairChannels(): void {
    for (const created of a.created) {
      if (b.received.some((ch) => ch.label === created.label)) continue
      const mirror = makeChannel(created.label, created.init)
      b.received.push(mirror)
      created.peer = mirror
      mirror.peer = created
      // ondatachannel fires when the answerer applies the offer that carries
      // the channel; the answerer never creates one itself.
      for (const cb of [...b.dataChannelCbs]) cb(mirror)
    }
  }

  function maybeConnect(): void {
    if (connected || a.closed || b.closed) return
    if (!(a.localSet && a.remoteSet && b.localSet && b.remoteSet)) return
    // BOTH sides must have APPLIED a remote candidate. Without this the pair
    // would connect on descriptions alone and every ICE assertion in the suite
    // would be decorative - the fixture would prove the transport works with
    // the whole candidate exchange deleted.
    if (a.candidatesIn === 0 || b.candidatesIn === 0) return
    connected = true
    for (const cb of [...a.stateCbs]) cb('connected')
    for (const cb of [...b.stateCbs]) cb('connected')
    // One LABEL at a time, both ends of that label together. Two properties,
    // both load-bearing:
    //   - both ends of a pair reach 'open' before either application learns, so
    //     the first flush is not delivered into a channel still 'connecting';
    //   - the two channels do NOT open at the same instant, because they do not
    //     in a browser either - and a transport that flushed its queue on the
    //     FIRST open would silently discard everything addressed to the other
    //     channel. A fixture opening both at once cannot see that bug.
    for (const label of ['unreliable', 'reliable']) {
      const both = [...a.created, ...b.received].filter((ch) => ch.label === label)
      for (const ch of both) ch.markOpen()
      for (const ch of both) ch.fireOpen()
    }
  }

  function emitCandidates(side: Side): void {
    candidateSeq++
    const c = candidateAt(candidateSeq)
    for (const cb of [...side.iceCbs]) cb(c)
    for (const cb of [...side.iceCbs]) cb(null)
  }

  function connectionFor(side: Side, isOfferer: boolean): RtcConnectionLike {
    return {
      createDataChannel(label: string, init: RtcChannelInit): RtcDataChannelLike {
        const ch = makeChannel(label, init)
        side.created.push(ch)
        return ch
      },
      createOffer: () => Promise.resolve('v=0\r\no=- 1 1 IN IP4 192.0.2.1\r\nsdp:offer'),
      createAnswer: () => Promise.resolve('v=0\r\no=- 2 1 IN IP4 192.0.2.2\r\nsdp:answer'),
      setLocalDescription: () => {
        side.localSet = true
        return Promise.resolve().then(() => {
          emitCandidates(side)
          maybeConnect()
        })
      },
      setRemoteDescription: (_sdp: string, type: 'offer' | 'answer') => {
        side.remoteSet = true
        return Promise.resolve().then(() => {
          if (type === 'offer' && !isOfferer) pairChannels()
          maybeConnect()
        })
      },
      addIceCandidate: () => {
        // Rejects before the remote description is set, exactly as a real
        // RTCPeerConnection does - which is what makes the transport's pending
        // candidate buffer load-bearing rather than decorative.
        if (!side.remoteSet) return Promise.reject(new Error('no remote description'))
        side.candidatesIn++
        return Promise.resolve().then(() => {
          maybeConnect()
        })
      },
      onIceCandidate(cb: (c: IceCandidateInit | null) => void): void {
        side.iceCbs.push(cb)
      },
      onDataChannel(cb: (ch: RtcDataChannelLike) => void): void {
        side.dataChannelCbs.push(cb)
      },
      onStateChange(cb: (s: RtcConnectionState) => void): void {
        side.stateCbs.push(cb)
      },
      close(): void {
        if (side.closed) return
        side.closed = true
        for (const cb of [...side.stateCbs]) cb('closed')
      },
    }
  }

  return {
    offerer: connectionFor(a, true),
    answerer: connectionFor(b, false),
    /** Runs the queued promise chain to completion, so a test needs no timers
     *  and no fake clock. Every promise this fixture returns is already
     *  resolved; what takes turns is the transport's own chaining. */
    async settle(): Promise<void> {
      for (let i = 0; i < 64; i++) await Promise.resolve()
    },
    failBoth(): void {
      for (const cb of [...a.stateCbs]) cb('failed')
      for (const cb of [...b.stateCbs]) cb('failed')
    },
  }
}

export function makeFakeRtcFactory(): {
  factory: RtcConnectionFactory
  connections(): RtcConnectionLike[]
} {
  const made: RtcConnectionLike[] = []
  return {
    factory: (_iceServers: readonly IceServerConfig[]): RtcConnectionLike => {
      // One unpaired connection: enough for a composition root to be exercised,
      // never enough to connect. Anything that must actually connect uses
      // makeFakeRtcPair.
      const solo = makeFakeRtcPair().offerer
      made.push(solo)
      return solo
    },
    connections: () => made,
  }
}
