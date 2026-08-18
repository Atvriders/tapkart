import type {
  IceCandidateInit,
  IceServerConfig,
  RtcChannelInit,
  RtcConnectionFactory,
  RtcConnectionLike,
  RtcConnectionState,
  RtcDataChannelLike,
} from './webrtc'

interface BrowserEvent {
  readonly data?: string | ArrayBuffer | ArrayBufferView
  readonly candidate?: BrowserIceCandidate | null
  readonly channel?: BrowserDataChannel
}

interface BrowserIceCandidate {
  readonly candidate: string
  readonly sdpMid: string | null
  readonly sdpMLineIndex: number | null
}

interface BrowserDataChannel {
  readonly label: string
  binaryType: string
  readonly readyState: 'connecting' | 'open' | 'closing' | 'closed'
  readonly bufferedAmount: number
  send(data: Uint8Array): void
  close(): void
  addEventListener(type: string, cb: (event: BrowserEvent) => void): void
}

interface BrowserSessionDescription {
  readonly sdp: string
}

interface BrowserPeerConnection {
  readonly connectionState: RtcConnectionState
  createDataChannel(label: string, init: { ordered: boolean; maxRetransmits?: number }): BrowserDataChannel
  createOffer(): Promise<BrowserSessionDescription>
  createAnswer(): Promise<BrowserSessionDescription>
  setLocalDescription(description: { type: 'offer' | 'answer'; sdp: string }): Promise<void>
  setRemoteDescription(description: { type: 'offer' | 'answer'; sdp: string }): Promise<void>
  addIceCandidate(candidate: IceCandidateInit): Promise<void>
  addEventListener(type: string, cb: (event: BrowserEvent) => void): void
  close(): void
}

interface BrowserPeerConnectionConstructor {
  new (configuration: { iceServers: IceServerConfig[] }): BrowserPeerConnection
}

// This is intentionally the repository's only ambient declaration of the
// browser peer-connection global. It remains local because net has no DOM lib.
declare const RTCPeerConnection: BrowserPeerConnectionConstructor

function copyBinary(data: string | ArrayBuffer | ArrayBufferView | undefined): Uint8Array | null {
  if (data instanceof ArrayBuffer) return new Uint8Array(data).slice()
  if (data !== undefined && typeof data !== 'string' && ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice()
  }
  return null
}

function wrapChannel(channel: BrowserDataChannel): RtcDataChannelLike {
  channel.binaryType = 'arraybuffer'
  return {
    label: channel.label,
    send(data): void {
      channel.send(data.slice())
    },
    close(): void {
      channel.close()
    },
    onOpen(cb): void {
      channel.addEventListener('open', () => cb())
    },
    onMessage(cb): void {
      channel.addEventListener('message', (event) => {
        const data = copyBinary(event.data)
        if (data !== null) cb(data)
      })
    },
    onClose(cb): void {
      channel.addEventListener('close', () => cb())
    },
    readyState: () => channel.readyState,
    bufferedAmount: () => channel.bufferedAmount,
  }
}

function browserChannelInit(init: RtcChannelInit): { ordered: boolean; maxRetransmits?: number } {
  if (init.maxRetransmits === null) return { ordered: init.ordered }
  return { ordered: init.ordered, maxRetransmits: init.maxRetransmits }
}

/** Construct a native connection only when invoked by the browser root. */
export const browserRtcFactory: RtcConnectionFactory = (
  iceServers: readonly IceServerConfig[],
): RtcConnectionLike => {
  const copiedServers = iceServers.map((server) => ({
    ...server,
    urls: [...server.urls],
  }))
  const connection = new RTCPeerConnection({ iceServers: copiedServers })

  return {
    createDataChannel(label, init): RtcDataChannelLike {
      return wrapChannel(connection.createDataChannel(label, browserChannelInit(init)))
    },
    async createOffer(): Promise<string> {
      return (await connection.createOffer()).sdp
    },
    async createAnswer(): Promise<string> {
      return (await connection.createAnswer()).sdp
    },
    setLocalDescription(sdp, type): Promise<void> {
      return connection.setLocalDescription({ type, sdp })
    },
    setRemoteDescription(sdp, type): Promise<void> {
      return connection.setRemoteDescription({ type, sdp })
    },
    addIceCandidate(candidate): Promise<void> {
      return connection.addIceCandidate({ ...candidate })
    },
    onIceCandidate(cb): void {
      connection.addEventListener('icecandidate', (event) => {
        if (event.candidate === null || event.candidate === undefined) {
          cb(null)
          return
        }
        cb({
          candidate: event.candidate.candidate,
          sdpMid: event.candidate.sdpMid,
          sdpMLineIndex: event.candidate.sdpMLineIndex,
        })
      })
    },
    onDataChannel(cb): void {
      connection.addEventListener('datachannel', (event) => {
        if (event.channel !== undefined) cb(wrapChannel(event.channel))
      })
    },
    onStateChange(cb): void {
      connection.addEventListener('connectionstatechange', () => cb(connection.connectionState))
    },
    close(): void {
      connection.close()
    },
  }
}
