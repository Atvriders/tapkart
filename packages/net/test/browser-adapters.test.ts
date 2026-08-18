import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { browserRtcFactory } from '@tapkart/net/webrtc-browser'
import { browserWebSocket } from '@tapkart/net/websocket-browser'

type Listener = (event: Record<string, unknown>) => void

const SOCKET_GLOBAL = 'Web' + 'Socket'
const RTC_GLOBAL = 'RTC' + 'PeerConnection'
const priorSocket = Reflect.get(globalThis, SOCKET_GLOBAL)
const priorRtc = Reflect.get(globalThis, RTC_GLOBAL)

class FakeBrowserSocket {
  static instances: FakeBrowserSocket[] = []
  readonly listeners = new Map<string, Listener[]>()
  readonly sent: unknown[] = []
  readonly closes: Array<[number | undefined, string | undefined]> = []
  binaryType = 'blob'
  readyState = 0
  bufferedAmount = 0

  constructor(readonly url: string) {
    FakeBrowserSocket.instances.push(this)
  }

  send(data: unknown): void {
    this.sent.push(data)
  }

  close(code?: number, reason?: string): void {
    this.closes.push([code, reason])
  }

  addEventListener(type: string, cb: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), cb])
  }

  fire(type: string, event: Record<string, unknown> = {}): void {
    for (const cb of [...(this.listeners.get(type) ?? [])]) cb(event)
  }
}

class FakeBrowserChannel {
  readonly listeners = new Map<string, Listener[]>()
  readonly sent: unknown[] = []
  binaryType = 'blob'
  readyState = 'connecting'
  bufferedAmount = 0

  constructor(readonly label: string) {}

  send(data: unknown): void {
    this.sent.push(data)
  }

  close(): void {
    this.readyState = 'closed'
  }

  addEventListener(type: string, cb: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), cb])
  }

  fire(type: string, event: Record<string, unknown> = {}): void {
    for (const cb of [...(this.listeners.get(type) ?? [])]) cb(event)
  }
}

class FakeBrowserRtc {
  static instances: FakeBrowserRtc[] = []
  readonly listeners = new Map<string, Listener[]>()
  readonly channels: Array<{ channel: FakeBrowserChannel; init: Record<string, unknown> }> = []
  readonly localDescriptions: unknown[] = []
  readonly remoteDescriptions: unknown[] = []
  readonly candidates: unknown[] = []
  connectionState = 'new'
  closed = 0

  constructor(readonly config: unknown) {
    FakeBrowserRtc.instances.push(this)
  }

  createDataChannel(label: string, init: Record<string, unknown>): FakeBrowserChannel {
    const channel = new FakeBrowserChannel(label)
    this.channels.push({ channel, init })
    return channel
  }

  createOffer(): Promise<{ type: string; sdp: string }> {
    return Promise.resolve({ type: 'offer', sdp: 'offer-sdp' })
  }

  createAnswer(): Promise<{ type: string; sdp: string }> {
    return Promise.resolve({ type: 'answer', sdp: 'answer-sdp' })
  }

  setLocalDescription(description: unknown): Promise<void> {
    this.localDescriptions.push(description)
    return Promise.resolve()
  }

  setRemoteDescription(description: unknown): Promise<void> {
    this.remoteDescriptions.push(description)
    return Promise.resolve()
  }

  addIceCandidate(candidate: unknown): Promise<void> {
    this.candidates.push(candidate)
    return Promise.resolve()
  }

  addEventListener(type: string, cb: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), cb])
  }

  fire(type: string, event: Record<string, unknown> = {}): void {
    for (const cb of [...(this.listeners.get(type) ?? [])]) cb(event)
  }

  close(): void {
    this.closed++
  }
}

beforeEach(() => {
  FakeBrowserSocket.instances.length = 0
  FakeBrowserRtc.instances.length = 0
  Reflect.set(globalThis, SOCKET_GLOBAL, FakeBrowserSocket)
  Reflect.set(globalThis, RTC_GLOBAL, FakeBrowserRtc)
})

afterEach(() => {
  if (priorSocket === undefined) Reflect.deleteProperty(globalThis, SOCKET_GLOBAL)
  else Reflect.set(globalThis, SOCKET_GLOBAL, priorSocket)
  if (priorRtc === undefined) Reflect.deleteProperty(globalThis, RTC_GLOBAL)
  else Reflect.set(globalThis, RTC_GLOBAL, priorRtc)
})

describe('browserWebSocket', () => {
  it('constructs lazily, preserves state and close codes, and appends listeners', () => {
    expect(FakeBrowserSocket.instances).toEqual([])
    const socket = browserWebSocket('wss://example.invalid/room')
    const raw = FakeBrowserSocket.instances[0]
    expect(raw.url).toBe('wss://example.invalid/room')
    expect(raw.binaryType).toBe('arraybuffer')

    const states = ['connecting', 'open', 'closing', 'closed'] as const
    for (let i = 0; i < states.length; i++) {
      raw.readyState = i
      expect(socket.readyState()).toBe(states[i])
    }
    raw.bufferedAmount = 1234
    expect(socket.bufferedAmount()).toBe(1234)

    const messages: Array<string | number[]> = []
    socket.onMessage((data) => messages.push(typeof data === 'string' ? data : Array.from(data)))
    socket.onMessage((data) => messages.push(typeof data === 'string' ? `again:${data}` : Array.from(data)))
    raw.fire('message', { data: 'hello' })
    raw.fire('message', { data: new Uint8Array([1, 2, 3]).buffer })
    expect(messages).toEqual(['hello', 'again:hello', [1, 2, 3], [1, 2, 3]])

    const codes: number[] = []
    socket.onClose((code) => codes.push(code))
    socket.onClose((code) => codes.push(code + 1))
    raw.fire('close', { code: 4001 })
    expect(codes).toEqual([4001, 4002])

    socket.close(4002, 'room closed')
    expect(raw.closes).toEqual([[4002, 'room closed']])
  })

  it('copies outgoing views and incoming array buffers at the boundary', () => {
    const socket = browserWebSocket('wss://example.invalid/copy')
    const raw = FakeBrowserSocket.instances[0]
    const backing = new Uint8Array([9, 1, 2, 8])
    const view = backing.subarray(1, 3)
    socket.send(view)
    view[0] = 7
    expect(Array.from(raw.sent[0] as Uint8Array)).toEqual([1, 2])

    let received: Uint8Array | null = null
    socket.onMessage((data) => {
      if (data instanceof Uint8Array) received = data
    })
    const inbound = new Uint8Array([3, 4])
    raw.fire('message', { data: inbound.buffer })
    inbound[0] = 0
    expect(Array.from(received ?? [])).toEqual([3, 4])
  })
})

describe('browserRtcFactory', () => {
  it('translates connection methods, state, ICE, and append-only listeners', async () => {
    const servers = [{ urls: ['stun:example.invalid:3478'], username: 'u', credential: 'p' }]
    const connection = browserRtcFactory(servers)
    const raw = FakeBrowserRtc.instances[0]
    expect(raw.config).toEqual({ iceServers: servers })

    expect(await connection.createOffer()).toBe('offer-sdp')
    expect(await connection.createAnswer()).toBe('answer-sdp')
    await connection.setLocalDescription('local', 'offer')
    await connection.setRemoteDescription('remote', 'answer')
    await connection.addIceCandidate({ candidate: 'candidate', sdpMid: null, sdpMLineIndex: 0 })
    expect(raw.localDescriptions).toEqual([{ type: 'offer', sdp: 'local' }])
    expect(raw.remoteDescriptions).toEqual([{ type: 'answer', sdp: 'remote' }])
    expect(raw.candidates).toEqual([{ candidate: 'candidate', sdpMid: null, sdpMLineIndex: 0 }])

    const candidates: string[] = []
    connection.onIceCandidate((candidate) => candidates.push(candidate?.candidate ?? 'done'))
    connection.onIceCandidate((candidate) => candidates.push(`again:${candidate?.candidate ?? 'done'}`))
    raw.fire('icecandidate', {
      candidate: { candidate: 'c1', sdpMid: '0', sdpMLineIndex: 1 },
    })
    raw.fire('icecandidate', { candidate: null })
    expect(candidates).toEqual(['c1', 'again:c1', 'done', 'again:done'])

    const states: string[] = []
    connection.onStateChange((state) => states.push(state))
    connection.onStateChange((state) => states.push(`again:${state}`))
    raw.connectionState = 'connected'
    raw.fire('connectionstatechange')
    expect(states).toEqual(['connected', 'again:connected'])

    connection.close()
    expect(raw.closed).toBe(1)
  })

  it('preserves channel configuration and copies binary data both ways', () => {
    const connection = browserRtcFactory([])
    const raw = FakeBrowserRtc.instances[0]
    const unreliable = connection.createDataChannel('unreliable', { ordered: false, maxRetransmits: 0 })
    const reliable = connection.createDataChannel('reliable', { ordered: true, maxRetransmits: null })
    expect(raw.channels.map(({ init }) => init)).toEqual([
      { ordered: false, maxRetransmits: 0 },
      { ordered: true },
    ])
    expect(raw.channels.map(({ channel }) => channel.binaryType)).toEqual(['arraybuffer', 'arraybuffer'])

    const opens: string[] = []
    unreliable.onOpen(() => opens.push('first'))
    unreliable.onOpen(() => opens.push('second'))
    raw.channels[0].channel.fire('open')
    expect(opens).toEqual(['first', 'second'])

    const sent = new Uint8Array([1, 2])
    unreliable.send(sent)
    sent[0] = 9
    expect(Array.from(raw.channels[0].channel.sent[0] as Uint8Array)).toEqual([1, 2])

    let received: Uint8Array | null = null
    unreliable.onMessage((data) => { received = data })
    const inbound = new Uint8Array([3, 4])
    raw.channels[0].channel.fire('message', { data: inbound.buffer })
    inbound[0] = 0
    expect(Array.from(received ?? [])).toEqual([3, 4])

    raw.channels[0].channel.readyState = 'open'
    raw.channels[0].channel.bufferedAmount = 77
    expect(unreliable.readyState()).toBe('open')
    expect(unreliable.bufferedAmount()).toBe(77)
    reliable.close()
    expect(raw.channels[1].channel.readyState).toBe('closed')
  })

  it('wraps remotely-created channels with the same semantics', () => {
    const connection = browserRtcFactory([])
    const raw = FakeBrowserRtc.instances[0]
    const received: string[] = []
    connection.onDataChannel((channel) => {
      received.push(channel.label)
      channel.onMessage((data) => received.push(Array.from(data).join(',')))
    })
    const remote = new FakeBrowserChannel('reliable')
    raw.fire('datachannel', { channel: remote })
    expect(remote.binaryType).toBe('arraybuffer')
    remote.fire('message', { data: new Uint8Array([5, 6]).buffer })
    expect(received).toEqual(['reliable', '5,6'])
  })
})
