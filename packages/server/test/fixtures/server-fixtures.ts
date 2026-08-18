import type { SimContext } from '@tapkart/sim'
import type { ChannelName, HelloMessage, MessageKind, WelcomeMessage } from '@tapkart/protocol'
import {
  CLIENT_FLAG_WEBRTC,
  WIRE_TAG,
  decodeHeader,
  decodeWelcome,
  encodeHeader,
  encodeHello,
} from '@tapkart/protocol'
import type { SocketData, SocketLike } from '@tapkart/net'
import { WS_HEADER_BYTES, WS_SLOT_SERVER, decodeWsFrame, encodeWsData } from '@tapkart/net'
import { makeContext, makeOvalTrack } from '../../../sim/test/fixtures/track-fixtures'
import type { ServerConfig } from '../../src/env'
import { DEFAULT_CONFIG } from '../../src/env'
import type { RandomSource } from '../../src/random'
import type { HubDeps } from '../../src/hub'
import { RoomHub } from '../../src/hub'
import { RoomRegistry } from '../../src/registry'
import { defaultContentProvider } from '../../src/content'
import { makeMemoryLogSink } from '../../src/log'
import { makeRateLimiter } from '../../src/ratelimit'

/** FRESH per call -- ShadowLoop promotes by mutating the context it was given. */
export function makeServerContext(): SimContext {
  return makeContext(makeOvalTrack(), false)
}

export function makeTestConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return { ...DEFAULT_CONFIG, ...overrides }
}

/** Byte i of draw n is (n * 31 + i) & 0xff. */
export function makeCountingRandom(): RandomSource {
  let draw = 0
  return (bytes: number): Uint8Array => {
    const out = new Uint8Array(bytes)
    for (let i = 0; i < bytes; i++) out[i] = (draw * 31 + i) & 0xff
    draw += 1
    return out
  }
}

export function makeTestHub(overrides: Partial<HubDeps> = {}): {
  hub: RoomHub
  log: ReturnType<typeof makeMemoryLogSink>
} {
  const log = makeMemoryLogSink()
  const config = makeTestConfig()
  const deps: HubDeps = {
    config,
    registry: new RoomRegistry({
      maxRooms: config.maxRooms,
      maxPeersPerRoom: config.maxPeersPerRoom,
      roomIdleMs: config.roomIdleMs,
      rand: makeCountingRandom(),
    }),
    content: defaultContentProvider,
    rand: makeCountingRandom(),
    log,
    failedJoins: makeRateLimiter(config.joinRateLimit),
    ...overrides,
  }
  return { hub: new RoomHub(deps), log }
}

/** Two SocketLikes wired together with immediate delivery. */
function immediatePair(): { a: SocketLike; b: SocketLike } {
  const aMsg: Array<(data: SocketData) => void> = []
  const bMsg: Array<(data: SocketData) => void> = []
  const aClose: Array<(code: number) => void> = []
  const bClose: Array<(code: number) => void> = []
  let open = true

  const a: SocketLike = {
    send: (data) => { if (open) for (const cb of bMsg.slice()) cb(data) },
    close: (code = 1000) => {
      if (!open) return
      open = false
      for (const cb of aClose.slice()) cb(code)
      for (const cb of bClose.slice()) cb(code)
    },
    onMessage: (cb) => { aMsg.push(cb) },
    onClose: (cb) => { aClose.push(cb) },
    readyState: () => (open ? 'open' : 'closed'),
    bufferedAmount: () => 0,
  }
  const b: SocketLike = {
    send: (data) => { if (open) for (const cb of aMsg.slice()) cb(data) },
    close: (code = 1000) => { a.close(code) },
    onMessage: (cb) => { bMsg.push(cb) },
    onClose: (cb) => { bClose.push(cb) },
    readyState: () => (open ? 'open' : 'closed'),
    bufferedAmount: () => 0,
  }
  return { a, b }
}

function sendHello(socket: SocketLike, msg: HelloMessage): void {
  const buf = new Uint8Array(64)
  const head = encodeHeader(buf, 'hello')
  const n = encodeHello(buf.subarray(head), msg)
  const frame = new Uint8Array(WS_HEADER_BYTES + head + n)
  encodeWsData(frame, 'reliable', WS_SLOT_SERVER, buf.subarray(0, head + n))
  socket.send(frame)
}

function firstWelcome(frames: Array<{ kind: MessageKind; payload: Uint8Array }>): WelcomeMessage {
  for (const frame of frames) if (frame.kind === 'welcome') return decodeWelcome(frame.payload)
  throw new Error('makeTestRoom: the hub sent no welcome')
}

function watch(socket: SocketLike): Array<{
  kind: MessageKind
  channel: ChannelName
  payload: Uint8Array
}> {
  const out: Array<{ kind: MessageKind; channel: ChannelName; payload: Uint8Array }> = []
  socket.onMessage((data) => {
    if (typeof data === 'string') return
    const frame = decodeWsFrame(data)
    if (frame === null || frame.channel === null || frame.payload.length < 2) return
    out.push({
      kind: decodeHeader(frame.payload).kind,
      channel: frame.channel,
      payload: frame.payload.subarray(2).slice(),
    })
  })
  return out
}

/** Host + N guests, attached, welcomed, and seated. */
export function makeTestRoom(hub: RoomHub, guests: number, nowMs: number): {
  code: string
  host: SocketLike
  guests: SocketLike[]
} {
  const hostPair = immediatePair()
  hub.attach(hostPair.a, nowMs)
  const hostFrames = watch(hostPair.b)
  sendHello(hostPair.b, {
    role: 'host', roomCode: '', token: '', characterIdx: 0, name: 'host',
    trackId: '', flags: CLIENT_FLAG_WEBRTC,
  })
  const hostWelcome = firstWelcome(hostFrames)
  if (hostWelcome.result !== 'ok') throw new Error('makeTestRoom: host join was ' + hostWelcome.result)

  const guestSockets: SocketLike[] = []
  for (let i = 0; i < guests; i++) {
    const pair = immediatePair()
    hub.attach(pair.a, nowMs)
    const frames = watch(pair.b)
    sendHello(pair.b, {
      role: 'guest', roomCode: hostWelcome.roomCode, token: '', characterIdx: 0,
      name: 'guest' + String(i), trackId: '', flags: CLIENT_FLAG_WEBRTC,
    })
    const welcome = firstWelcome(frames)
    if (welcome.result !== 'ok') throw new Error('makeTestRoom: guest join was ' + welcome.result)
    guestSockets.push(pair.b)
  }

  if (WIRE_TAG.hello !== 0x01) throw new Error('WIRE_TAG.hello moved; this fixture frames by hand')
  return { code: hostWelcome.roomCode, host: hostPair.b, guests: guestSockets }
}
