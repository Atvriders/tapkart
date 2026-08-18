import type { ChannelName } from '@tapkart/protocol'
import type { Transport } from './transport'
import type { SignalMessage } from './signal'

/**
 * PURE (contract §0a), and the specific failure §0a exists to prevent: a
 * WebRtcTransport that can only be exercised by opening two browsers. This file
 * never names RTCPeerConnection - it takes an RtcConnectionLike, and the test
 * passes a two-sided in-memory implementation that completes a full
 * offer/answer/ICE exchange in-process, in microseconds, with no UDP.
 *
 * The adapter is packages/net/src/webrtc-browser.ts, the only file in the
 * repository that names RTCPeerConnection: not barrel-exported, never imported
 * by a test, owner-verified.
 */
export type RtcConnectionState =
  | 'new'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'failed'
  | 'closed'

export interface RtcChannelInit {
  ordered: boolean
  maxRetransmits: number | null
}

/**
 * Spec §5's two channels, and the only place their RTC configuration is written.
 * 'unreliable' is ordered:false + maxRetransmits:0 - an SCTP partial-reliability
 * channel, which is what makes a dropped input datagram free. 'reliable' is
 * ordered:true + maxRetransmits:null.
 */
export const RTC_CHANNEL_INIT: Readonly<Record<ChannelName, RtcChannelInit>> = {
  unreliable: { ordered: false, maxRetransmits: 0 },
  reliable: { ordered: true, maxRetransmits: null },
}

export interface IceCandidateInit {
  candidate: string
  sdpMid: string | null
  sdpMLineIndex: number | null
}

export interface IceServerConfig {
  urls: string[]
  username?: string
  credential?: string
}

/**
 * F-P4-16. An empty default means WebRTC succeeds only on the same LAN, so
 * essentially every real guest falls to the WebSocket relay and the server
 * carries the whole race - which discards the entire peer-to-peer architecture
 * and multiplies server cost by the number of guests. That is not a conservative
 * default, it is a different product.
 *
 * This is a THIRD-PARTY ENDPOINT CONTACTED AT CONNECTION TIME. It is documented
 * as such in the README and it is overridable with one environment variable
 * (ICE_SERVERS, §5.2). Disclosure is the answer to the privacy cost, not
 * crippling the transport. It is also not a host detail under §0's rule: it is a
 * public service address, not anybody's infrastructure.
 */
export const DEFAULT_ICE_SERVERS: readonly IceServerConfig[] = [
  { urls: ['stun:stun.l.google.com:19302'] },
]

export interface RtcDataChannelLike {
  readonly label: string
  send(data: Uint8Array): void
  close(): void
  onOpen(cb: () => void): void
  onMessage(cb: (data: Uint8Array) => void): void
  onClose(cb: () => void): void
  readyState(): 'connecting' | 'open' | 'closing' | 'closed'
  bufferedAmount(): number
}

export interface RtcConnectionLike {
  createDataChannel(label: string, init: RtcChannelInit): RtcDataChannelLike
  createOffer(): Promise<string>
  createAnswer(): Promise<string>
  setLocalDescription(sdp: string, type: 'offer' | 'answer'): Promise<void>
  setRemoteDescription(sdp: string, type: 'offer' | 'answer'): Promise<void>
  addIceCandidate(c: IceCandidateInit): Promise<void>
  /** null = gathering done. */
  onIceCandidate(cb: (c: IceCandidateInit | null) => void): void
  onDataChannel(cb: (ch: RtcDataChannelLike) => void): void
  onStateChange(cb: (s: RtcConnectionState) => void): void
  close(): void
}

export type RtcConnectionFactory = (iceServers: readonly IceServerConfig[]) => RtcConnectionLike

export interface WebRtcTransportOptions {
  peerId: string
  connection: RtcConnectionLike
  /** P4 Q42: the GUEST is the offerer, and the OFFERER creates both
   *  DataChannels; the answerer receives them through onDataChannel. One
   *  convention had to be picked, the answerer's code path is entirely
   *  different, and every task touching WebRTC must assume the same one. The
   *  labels are the ChannelNames. */
  role: 'offerer' | 'answerer'
}

export interface WebRtcTransport extends Transport {
  /** Everything this transport wants said to the far side, as data. The caller
   *  posts it over whatever signalling path it has; this module never knows. */
  onLocalSignal(cb: (msg: SignalMessage) => void): void
  /** The far side's signalling, delivered in. Out-of-order and duplicate
   *  messages are tolerated; unknown ones are ignored. */
  acceptSignal(msg: SignalMessage): void
  connectionState(): RtcConnectionState
  /** Datagrams enqueued before both channels opened. Flushed IN ORDER on open. */
  queuedCount(): number
  /** offerer: createOffer + setLocalDescription. answerer: no-op. */
  start(): void
}

export const RTC_QUEUE_MAX = 64
/**
 * F-P4-39. 8 s of black screen before fallback is too long; 4 s is past the
 * point where a working connection would have formed and short enough not to
 * read as broken. The transport does NOT enforce it - RoomClient does, because
 * giving up means asking the server for a relay, which is a room decision and
 * not a transport one. This file reads no clock at all.
 */
export const RTC_CONNECT_TIMEOUT_MS = 4000

interface Queued {
  channel: ChannelName
  data: Uint8Array
}

const CHANNEL_NAMES: ChannelName[] = ['unreliable', 'reliable']

function channelNameOf(label: string): ChannelName | null {
  return label === 'unreliable' || label === 'reliable' ? label : null
}

export function makeWebRtcTransport(opts: WebRtcTransportOptions): WebRtcTransport {
  const { peerId, connection, role } = opts

  const messageCbs: Array<(peerId: string, channel: ChannelName, data: Uint8Array) => void> = []
  const peerLostCbs: Array<(peerId: string) => void> = []
  const signalCbs: Array<(msg: SignalMessage) => void> = []

  const channels: Record<ChannelName, RtcDataChannelLike | null> = { unreliable: null, reliable: null }
  const queue: Queued[] = []
  const pendingCandidates: IceCandidateInit[] = []

  let state: RtcConnectionState = 'new'
  let remoteDescriptionSet = false
  let remoteDescriptionStarted = false
  let peerLostFired = false
  let closed = false
  let started = false

  function emitSignal(msg: SignalMessage): void {
    if (closed) return
    for (const cb of [...signalCbs]) cb(msg)
  }

  function firePeerLost(): void {
    // A LOCAL close is not peer loss: `closed` is set before connection.close(),
    // so the 'closed' state change our own teardown provokes cannot deliver a
    // callback after close() (Transport rule 5).
    if (peerLostFired || closed) return
    peerLostFired = true
    for (const cb of [...peerLostCbs]) cb(peerId)
  }

  function bothOpen(): boolean {
    return (
      channels.unreliable !== null &&
      channels.reliable !== null &&
      channels.unreliable.readyState() === 'open' &&
      channels.reliable.readyState() === 'open'
    )
  }

  function flushQueue(): void {
    if (!bothOpen() || queue.length === 0) return
    // ONE FIFO across both channels, drained in send order. A per-channel flush
    // would reorder the two relative to each other, and a client's first inputs
    // would arrive after a snapshot that predates them.
    const pending = queue.splice(0, queue.length)
    for (const q of pending) {
      const ch = channels[q.channel]
      if (ch !== null && ch.readyState() === 'open') ch.send(q.data)
    }
  }

  function bindChannel(ch: RtcDataChannelLike): void {
    const name = channelNameOf(ch.label)
    // The labels ARE the ChannelNames. A channel with any other label is not
    // part of this protocol and is ignored rather than guessed at.
    if (name === null) return
    channels[name] = ch
    ch.onOpen(() => {
      flushQueue()
    })
    ch.onMessage((data) => {
      if (closed) return
      for (const cb of [...messageCbs]) cb(peerId, name, data)
    })
    ch.onClose(() => {
      firePeerLost()
    })
    if (ch.readyState() === 'open') flushQueue()
  }

  function fail(reason: string): void {
    if (closed) return
    emitSignal({ t: 'giveUp', reason })
    firePeerLost()
  }

  function drainCandidates(): void {
    const cands = pendingCandidates.splice(0, pendingCandidates.length)
    for (const c of cands) {
      connection.addIceCandidate(c).catch(() => {
        // A candidate that will not apply costs one path, not the connection:
        // ICE tries the rest. An unhandled rejection, by contrast, terminates
        // the process under Node's default policy.
      })
    }
  }

  connection.onStateChange((s) => {
    state = s
    if (s === 'failed' || s === 'closed') firePeerLost()
  })

  connection.onIceCandidate((c) => {
    if (c === null) emitSignal({ t: 'iceDone' })
    else emitSignal({ t: 'ice', c })
  })

  connection.onDataChannel((ch) => {
    bindChannel(ch)
  })

  if (role === 'offerer') {
    // The OFFERER creates both channels, and it creates them BEFORE the offer:
    // a channel added afterwards is not in the SDP the answerer receives.
    for (const name of CHANNEL_NAMES) {
      bindChannel(connection.createDataChannel(name, RTC_CHANNEL_INIT[name]))
    }
  }

  function enqueueOrSend(channel: ChannelName, data: Uint8Array): void {
    if (closed) return
    const ch = channels[channel]
    // The queue is one FIFO across both channels. Until both are open, even a
    // datagram whose selected channel is writable must join it; otherwise that
    // newer datagram overtakes older entries waiting for the other channel.
    if (ch !== null && ch.readyState() === 'open' && bothOpen()) {
      flushQueue()
      ch.send(data)
      return
    }
    if (queue.length >= RTC_QUEUE_MAX) {
      // Past the bound, unreliable datagrams are dropped and reliable ones keep
      // queuing: a dropped input is free by design, a dropped event breaks
      // eventSeq monotonicity for good.
      if (channel === 'unreliable') return
    }
    // Copied, not retained: the sender's buffer is scratch and this queue can
    // hold for seconds while ICE completes.
    queue.push({ channel, data: data.slice() })
  }

  return {
    send(channel, targetPeerId, data): void {
      // One link, one peer. An unknown peer is a no-op, not a throw.
      if (targetPeerId !== peerId) return
      enqueueOrSend(channel, data)
    },
    broadcast(channel, data): void {
      enqueueOrSend(channel, data)
    },
    onMessage(cb): void {
      messageCbs.push(cb)
    },
    onPeerLost(cb): void {
      peerLostCbs.push(cb)
    },
    peers(): string[] {
      if (closed || peerLostFired) return []
      return state === 'connected' ? [peerId] : []
    },
    close(): void {
      if (closed) return
      closed = true
      queue.length = 0
      pendingCandidates.length = 0
      for (const name of CHANNEL_NAMES) {
        const ch = channels[name]
        if (ch !== null) ch.close()
        channels[name] = null
      }
      connection.close()
    },
    onLocalSignal(cb): void {
      signalCbs.push(cb)
    },
    acceptSignal(msg): void {
      if (closed) return
      switch (msg.t) {
        case 'offer': {
          // Wrong-role signalling is ignored rather than acted on: two offerers
          // would each answer the other and neither would ever connect.
          // There is no renegotiation API here, so a duplicate SDP is a no-op.
          // A real connection in stable state may reject a second description.
          if (role !== 'answerer' || remoteDescriptionStarted) return
          remoteDescriptionStarted = true
          connection
            .setRemoteDescription(msg.sdp, 'offer')
            .then(() => {
              remoteDescriptionSet = true
              drainCandidates()
              return connection.createAnswer()
            })
            .then((sdp) => connection.setLocalDescription(sdp, 'answer').then(() => sdp))
            .then((sdp) => {
              emitSignal({ t: 'answer', sdp })
            })
            .catch(() => {
              fail('answerFailed')
            })
          return
        }
        case 'answer': {
          if (role !== 'offerer' || remoteDescriptionStarted) return
          remoteDescriptionStarted = true
          connection
            .setRemoteDescription(msg.sdp, 'answer')
            .then(() => {
              remoteDescriptionSet = true
              drainCandidates()
            })
            .catch(() => {
              fail('answerRejected')
            })
          return
        }
        case 'ice': {
          // Candidates that arrive before the remote description are HELD, not
          // dropped: they routinely do, and addIceCandidate rejects until the
          // description is set. Duplicates and out-of-order messages are
          // tolerated by construction.
          if (!remoteDescriptionSet) {
            pendingCandidates.push(msg.c)
            return
          }
          connection.addIceCandidate(msg.c).catch(() => {})
          return
        }
        case 'iceDone':
          // Nothing to do: gathering finished on the far side, and this side's
          // ICE agent needs no help to notice.
          return
        case 'giveUp':
          // The far side has stopped trying. Surfacing it as peer loss is what
          // lets RoomClient ask the server for a relay instead of waiting out
          // the connect timeout it would otherwise have to.
          firePeerLost()
          return
        default:
          return
      }
    },
    connectionState(): RtcConnectionState {
      return state
    },
    queuedCount(): number {
      return queue.length
    },
    start(): void {
      // Idempotent: a second offer would restart negotiation the far side has
      // already answered.
      if (started || closed || role !== 'offerer') return
      started = true
      connection
        .createOffer()
        .then((sdp) => connection.setLocalDescription(sdp, 'offer').then(() => sdp))
        .then((sdp) => {
          emitSignal({ t: 'offer', sdp })
        })
        .catch(() => {
          fail('offerFailed')
        })
    },
  }
}
