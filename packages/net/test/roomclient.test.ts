import { describe, expect, it } from 'vitest'
import type {
  ChannelName,
  HeartbeatMessage,
  LobbyMessage,
  MessageKind,
  StartMessage,
  WelcomeMessage,
  WireLobbySlot,
} from '@tapkart/protocol'
import {
  CLIENT_FLAG_RTC_CONNECTED,
  CLIENT_FLAG_READY,
  CLIENT_FLAG_RTC_FAILED,
  CLIENT_FLAG_START_REQUEST,
  CLIENT_FLAG_WEBRTC,
  SERVER_FLAG_IS_HOST,
  SERVER_FLAG_RELAY_FIRST,
  decodeClientUpdate,
  decodeHeader,
  decodeHeartbeat,
  decodeHello,
  decodeResyncRequest,
  encodeHeader,
  encodeHeartbeat,
  encodeLobby,
  encodeStart,
  encodeWelcome,
} from '@tapkart/protocol'
import { MAX_KARTS } from '@tapkart/sim'
import { droppedDatagramsOf } from '../src/receive'
import type { RoomClientOptions } from '../src/roomclient'
import { HARD_RESYNC_LIMIT, HARD_RESYNC_WINDOW_TICKS, RoomClient } from '../src/roomclient'
import { encodeAuthorityChange } from '../src/shadow'
import type { Transport } from '../src/transport'

const SERVER = 'p0'

interface Sent {
  channel: ChannelName
  peerId: string
  data: Uint8Array
  kind: MessageKind
}

interface FakeTransport extends Transport {
  deliver(channel: ChannelName, data: Uint8Array): void
  sent(): Sent[]
  sentOf(kind: MessageKind): Sent[]
  broadcasts(): number
  closed(): number
}

function makeFakeTransport(): FakeTransport {
  const cbs: ((peerId: string, channel: ChannelName, data: Uint8Array) => void)[] = []
  const sent: Sent[] = []
  let broadcasts = 0
  let closes = 0
  return {
    send(channel, peerId, data) {
      // decodeHeader throws on an unknown tag, which is exactly the assertion
      // wanted here: everything this client sends is a real, current-version
      // message.
      sent.push({ channel, peerId, data, kind: decodeHeader(data).kind })
    },
    broadcast() {
      broadcasts++
    },
    onMessage(cb) {
      cbs.push(cb)
    },
    onPeerLost() {
      /* the control transport's peer loss is not this class's signal */
    },
    peers: () => [SERVER],
    close() {
      closes++
    },
    deliver(channel, data) {
      for (const cb of cbs) cb(SERVER, channel, data)
    },
    sent: () => sent,
    sentOf: (kind) => sent.filter((s) => s.kind === kind),
    broadcasts: () => broadcasts,
    closed: () => closes,
  }
}

function body(s: Sent): Uint8Array {
  return s.data.subarray(2)
}

function opts(t: Transport, over: Partial<RoomClientOptions> = {}): RoomClientOptions {
  return {
    transport: t,
    role: 'guest',
    name: 'Ada',
    characterIdx: 3,
    roomCode: 'ABCDE',
    token: '',
    trackId: '',
    ...over,
  }
}

function emptySlot(): WireLobbySlot {
  return { occupied: false, isBot: true, connected: false, ready: false, characterIdx: 0, peerSlot: 0, name: '' }
}

function lobbyMessage(over: Partial<LobbyMessage> = {}): LobbyMessage {
  const slots: WireLobbySlot[] = []
  for (let i = 0; i < MAX_KARTS; i++) slots.push(emptySlot())
  slots[0] = { occupied: true, isBot: false, connected: true, ready: true, characterIdx: 1, peerSlot: 1, name: 'Grace' }
  slots[1] = { occupied: true, isBot: false, connected: true, ready: false, characterIdx: 3, peerSlot: 2, name: 'Ada' }
  return { lobbyVersion: 4, hostPlayerId: 0, trackId: 'caldera', slots, ...over }
}

function startMessage(over: Partial<StartMessage> = {}): StartMessage {
  return {
    raceSeed: 0x0badc0de,
    trackId: 'caldera',
    humanMask: 0b11,
    characterIdx: [1, 3, 0, 0, 0, 0, 0, 0],
    ...over,
  }
}

function welcome(over: Partial<WelcomeMessage> = {}): WelcomeMessage {
  return {
    result: 'ok',
    roomCode: 'ABCDE',
    playerId: 1,
    token: '0123456789AB',
    hostPlayerId: 0,
    peerSlot: 2,
    flags: 0,
    lobbyVersion: 4,
    ...over,
  }
}

function datagram(kind: MessageKind, encode: (out: Uint8Array) => number, size = 512): Uint8Array {
  const buf = new Uint8Array(size)
  const h = encodeHeader(buf, kind)
  const n = encode(buf.subarray(h))
  return buf.slice(0, h + n)
}

const welcomeBytes = (m: WelcomeMessage): Uint8Array => datagram('welcome', (out) => encodeWelcome(out, m))
const lobbyBytes = (m: LobbyMessage): Uint8Array => datagram('lobby', (out) => encodeLobby(out, m))
const startBytes = (m: StartMessage): Uint8Array => datagram('start', (out) => encodeStart(out, m))
const heartbeatBytes = (kind: 'ping' | 'pong', m: HeartbeatMessage): Uint8Array =>
  datagram(kind, (out) => encodeHeartbeat(out, m), 16)

function authorityChangeBytes(tick: number, eventSeq: number): Uint8Array {
  const buf = new Uint8Array(16)
  const n = encodeAuthorityChange(buf, tick, eventSeq)
  return buf.slice(0, n)
}

/** A header and two body bytes, built with encodeHeader so this file says
 * nothing about PROTOCOL_VERSION. */
function taggedDatagram(kind: MessageKind): Uint8Array {
  const buf = new Uint8Array(4)
  encodeHeader(buf, kind)
  return buf
}

/** A welcomed guest, polled once so its liveness state exists. */
function welcomed(over: Partial<WelcomeMessage> = {}, o: Partial<RoomClientOptions> = {}): {
  t: FakeTransport
  room: RoomClient
} {
  const t = makeFakeTransport()
  const room = new RoomClient(opts(t, o))
  room.connect()
  t.deliver('reliable', welcomeBytes(welcome(over)))
  room.poll(0)
  return { t, room }
}

describe('RoomClient - the handshake', () => {
  it('drives the phase idle -> connecting -> lobby -> starting -> racing, in order', () => {
    const t = makeFakeTransport()
    const room = new RoomClient(opts(t))
    expect(room.state().phase).toBe('idle')

    room.connect()
    expect(room.state().phase).toBe('connecting')

    t.deliver('reliable', welcomeBytes(welcome()))
    expect(room.state().phase).toBe('lobby')

    t.deliver('reliable', lobbyBytes(lobbyMessage()))
    expect(room.state().phase).toBe('lobby')

    t.deliver('reliable', startBytes(startMessage()))
    expect(room.state().phase).toBe('starting')

    room.poll(10_000) // arms the countdown
    expect(room.state().phase).toBe('starting')
    room.poll(12_999)
    expect(room.state().phase).toBe('starting')
    room.poll(13_000) // COUNTDOWN_TICKS * TICK_MS = 3000 ms after the start
    expect(room.state().phase).toBe('racing')
  })

  it('sends exactly one hello, to the server peer, on the reliable channel', () => {
    const t = makeFakeTransport()
    const room = new RoomClient(opts(t, { role: 'host', roomCode: '', name: 'Grace', characterIdx: 1, trackId: 'caldera' }))
    room.connect()
    room.connect()
    room.connect()

    expect(t.sentOf('hello')).toHaveLength(1)
    const hello = t.sentOf('hello')[0]
    expect(hello.channel).toBe('reliable')
    expect(hello.peerId).toBe(SERVER)
    expect(t.broadcasts()).toBe(0) // a broadcast frame is fanned out to guests, never to the room

    const m = decodeHello(body(hello))
    expect(m.role).toBe('host')
    expect(m.roomCode).toBe('')
    expect(m.token).toBe('')
    expect(m.name).toBe('Grace')
    expect(m.characterIdx).toBe(1)
    expect(m.trackId).toBe('caldera')
    expect(m.flags & CLIENT_FLAG_WEBRTC).toBe(CLIENT_FLAG_WEBRTC)
  })

  it('normalises the room code it was given, and carries a reconnect token', () => {
    const t = makeFakeTransport()
    const room = new RoomClient(opts(t, { roomCode: ' abcde ', token: '0123456789AB' }))
    room.connect()

    const m = decodeHello(body(t.sentOf('hello')[0]))
    expect(m.roomCode).toBe('ABCDE')
    expect(m.token).toBe('0123456789AB')
  })

  it('records what the welcome said', () => {
    const { room } = welcomed({
      playerId: 0,
      hostPlayerId: 0,
      peerSlot: 1,
      flags: SERVER_FLAG_IS_HOST,
    })
    const s = room.state()
    expect(s.role).toBe('host')
    expect(s.playerId).toBe(0)
    expect(s.peerSlot).toBe(1)
    expect(s.token).toBe('0123456789AB')
    expect(s.roomCode).toBe('ABCDE')
    expect(s.hostPlayerId).toBe(0)
    expect(s.error).toBe('')
    expect(s.relayFirst).toBe(false)
  })

  it('fires onWelcome, onLobby and onStart with the decoded messages', () => {
    const t = makeFakeTransport()
    const room = new RoomClient(opts(t))
    const seen: string[] = []
    let gotSeed = -1
    room.onWelcome((m) => seen.push(`welcome:${m.result}`))
    room.onLobby((m) => seen.push(`lobby:${m.lobbyVersion}`))
    room.onStart((m) => {
      seen.push('start')
      gotSeed = m.raceSeed
    })

    room.connect()
    t.deliver('reliable', welcomeBytes(welcome()))
    t.deliver('reliable', lobbyBytes(lobbyMessage()))
    t.deliver('reliable', startBytes(startMessage()))

    expect(seen).toEqual(['welcome:ok', 'lobby:4', 'start'])
    expect(gotSeed).toBe(0x0badc0de)
    expect(room.state().lobby?.slots[1].name).toBe('Ada')
    expect(room.state().start?.humanMask).toBe(0b11)
  })
})

describe('RoomClient - a refused join', () => {
  it('ends in closed with the JoinResult in error, and fires onClosed once', () => {
    const t = makeFakeTransport()
    const room = new RoomClient(opts(t))
    const closed: string[] = []
    room.onClosed((reason) => closed.push(reason))

    room.connect()
    t.deliver('reliable', welcomeBytes(welcome({ result: 'rateLimited', playerId: -1, token: '' })))

    expect(room.state().phase).toBe('closed')
    expect(room.state().error).toBe('rateLimited')
    expect(room.state().playerId).toBe(-1)
    expect(closed).toEqual(['rateLimited'])
  })

  it('sends nothing at all once closed', () => {
    const t = makeFakeTransport()
    const room = new RoomClient(opts(t))
    room.connect()
    t.deliver('reliable', welcomeBytes(welcome({ result: 'roomNotFound', playerId: -1, token: '' })))
    const after = t.sent().length

    room.update({ ready: true })
    room.requestStart()
    room.requestResync('divergence', 120)
    room.reportRtcFailed()
    room.poll(10_000)
    room.poll(60_000)

    expect(t.sent()).toHaveLength(after)
    expect(room.state().phase).toBe('closed')
  })
})

describe('RoomClient - update, start and resync', () => {
  it('sends a clientUpdate and never a second hello', () => {
    const { t, room } = welcomed()
    room.update({ ready: true, name: 'Ada L', characterIdx: 5 })

    expect(t.sentOf('hello')).toHaveLength(1)
    expect(t.sentOf('clientUpdate')).toHaveLength(1)
    const m = decodeClientUpdate(body(t.sentOf('clientUpdate')[0]))
    expect(m.flags & CLIENT_FLAG_READY).toBe(CLIENT_FLAG_READY)
    expect(m.name).toBe('Ada L')
    expect(m.characterIdx).toBe(5)
    expect(m.trackId).toBe('') // '' = no change
  })

  it('remembers the declaration across updates, so clearing ready keeps the name', () => {
    const { t, room } = welcomed()
    room.update({ name: 'Ada L', ready: true })
    room.update({ ready: false })

    const m = decodeClientUpdate(body(t.sentOf('clientUpdate')[1]))
    expect(m.flags & CLIENT_FLAG_READY).toBe(0)
    expect(m.name).toBe('Ada L')
  })

  it('carries a track choice when one is given', () => {
    const { t, room } = welcomed({ flags: SERVER_FLAG_IS_HOST }, { role: 'host' })
    room.update({ trackId: 'saltflat' })
    expect(decodeClientUpdate(body(t.sentOf('clientUpdate')[0])).trackId).toBe('saltflat')
  })

  it('requestStart sets START_REQUEST for a host and sends nothing for a guest', () => {
    const host = welcomed({ flags: SERVER_FLAG_IS_HOST }, { role: 'host' })
    host.room.requestStart()
    expect(host.t.sentOf('clientUpdate')).toHaveLength(1)
    expect(decodeClientUpdate(body(host.t.sentOf('clientUpdate')[0])).flags & CLIENT_FLAG_START_REQUEST)
      .toBe(CLIENT_FLAG_START_REQUEST)

    const guest = welcomed({}, { role: 'guest' })
    guest.room.requestStart()
    expect(guest.t.sentOf('clientUpdate')).toHaveLength(0)
  })

  it('uses the welcome role for a creator reclaimed through a guest hello', () => {
    const reclaimed = welcomed({
      playerId: 0,
      hostPlayerId: 0,
      peerSlot: 1,
      flags: SERVER_FLAG_IS_HOST,
    }, { role: 'guest' })

    expect(reclaimed.room.state().role).toBe('host')
    reclaimed.room.requestStart()
    reclaimed.room.poll(4000)

    const updates = reclaimed.t.sentOf('clientUpdate').map((sent) => decodeClientUpdate(body(sent)).flags)
    expect(updates).toEqual([CLIENT_FLAG_START_REQUEST])
    expect(updates.every((flags) => (flags & CLIENT_FLAG_RTC_FAILED) === 0)).toBe(true)
  })

  it('requestResync sends the reason and the tick', () => {
    const { t, room } = welcomed()
    room.requestResync('divergence', 742)
    const m = decodeResyncRequest(body(t.sentOf('resyncRequest')[0]))
    expect(m.reason).toBe('divergence')
    expect(m.lastTick).toBe(742)
  })
})

describe('RoomClient - the WebRTC give-up timer', () => {
  it('sends CLIENT_FLAG_RTC_FAILED exactly once, at RTC_CONNECT_TIMEOUT_MS', () => {
    const { t, room } = welcomed()
    room.poll(3999)
    expect(t.sentOf('clientUpdate')).toHaveLength(0)

    room.poll(4000)
    expect(t.sentOf('clientUpdate')).toHaveLength(1)
    expect(decodeClientUpdate(body(t.sentOf('clientUpdate')[0])).flags & CLIENT_FLAG_RTC_FAILED)
      .toBe(CLIENT_FLAG_RTC_FAILED)
    expect(room.state().relayMode).toBe(true)

    room.poll(8000)
    room.poll(30_000)
    expect(t.sentOf('clientUpdate')).toHaveLength(1)
  })

  it('never fires it once the link is up', () => {
    const { t, room } = welcomed()
    room.noteRtcConnected()
    room.poll(4000)
    room.poll(30_000)
    expect(t.sentOf('clientUpdate')).toHaveLength(1)
    expect(decodeClientUpdate(body(t.sentOf('clientUpdate')[0])).flags & CLIENT_FLAG_RTC_CONNECTED)
      .toBe(CLIENT_FLAG_RTC_CONNECTED)
    expect(room.state().relayMode).toBe(false)
  })

  it('reports a link that connected before welcome immediately after welcome', () => {
    const t = makeFakeTransport()
    const room = new RoomClient(opts(t))
    room.connect()
    room.noteRtcConnected()
    expect(t.sentOf('clientUpdate')).toHaveLength(0)

    t.deliver('reliable', welcomeBytes(welcome()))
    expect(t.sentOf('clientUpdate')).toHaveLength(1)
    expect(decodeClientUpdate(body(t.sentOf('clientUpdate')[0])).flags & CLIENT_FLAG_RTC_CONNECTED)
      .toBe(CLIENT_FLAG_RTC_CONNECTED)
  })

  it('upgrades a relay-first guest exactly once when its background link connects', () => {
    const { t, room } = welcomed({ flags: SERVER_FLAG_RELAY_FIRST })
    expect(room.state().relayMode).toBe(true)

    room.noteRtcConnected()
    room.noteRtcConnected()

    expect(room.state().relayMode).toBe(false)
    expect(t.sentOf('clientUpdate')).toHaveLength(1)
    expect(decodeClientUpdate(body(t.sentOf('clientUpdate')[0])).flags & CLIENT_FLAG_RTC_CONNECTED)
      .toBe(CLIENT_FLAG_RTC_CONNECTED)
  })

  it('never fires it for a relay-first room, which is already relaying', () => {
    const { t, room } = welcomed({ flags: SERVER_FLAG_RELAY_FIRST })
    expect(room.state().relayFirst).toBe(true)
    expect(room.state().relayMode).toBe(true)
    room.poll(4000)
    room.poll(30_000)
    expect(t.sentOf('clientUpdate')).toHaveLength(0)
  })

  it('reportRtcFailed is idempotent when the app calls it too', () => {
    const { t, room } = welcomed()
    room.reportRtcFailed()
    room.reportRtcFailed()
    room.poll(9000)
    expect(t.sentOf('clientUpdate')).toHaveLength(1)
  })

  it('falls back again when a late direct upgrade subsequently fails', () => {
    const { t, room } = welcomed()

    room.reportRtcFailed()
    room.reportRtcFailed()
    expect(room.state().relayMode).toBe(true)
    expect(t.sentOf('clientUpdate')).toHaveLength(1)

    room.noteRtcConnected()
    expect(room.state().relayMode).toBe(false)
    expect(t.sentOf('clientUpdate')).toHaveLength(2)
    expect(decodeClientUpdate(body(t.sentOf('clientUpdate')[1])).flags & CLIENT_FLAG_RTC_CONNECTED)
      .toBe(CLIENT_FLAG_RTC_CONNECTED)

    room.reportRtcFailed()
    room.reportRtcFailed()
    expect(room.state().relayMode).toBe(true)
    expect(t.sentOf('clientUpdate')).toHaveLength(3)
    expect(decodeClientUpdate(body(t.sentOf('clientUpdate')[2])).flags & CLIENT_FLAG_RTC_FAILED)
      .toBe(CLIENT_FLAG_RTC_FAILED)

    // A later retry can upgrade again too; success is not a one-session latch.
    room.noteRtcConnected()
    expect(room.state().relayMode).toBe(false)
    expect(t.sentOf('clientUpdate')).toHaveLength(4)
  })
})

describe('RoomClient - heartbeats', () => {
  it('pings the server once a second, on the unreliable channel', () => {
    const { t, room } = welcomed()
    for (let now = 0; now <= 3000; now += 16) room.poll(now)

    const pings = t.sentOf('ping')
    expect(pings.length).toBeGreaterThanOrEqual(2)
    expect(pings[0].channel).toBe('unreliable')
    expect(pings[0].peerId).toBe(SERVER)
    const first = decodeHeartbeat(body(pings[0]))
    const second = decodeHeartbeat(body(pings[1]))
    expect(second.seq).not.toBe(first.seq)
    expect(second.echoMs - first.echoMs).toBeGreaterThanOrEqual(1000)
  })

  it('answers a ping with a pong that copies seq and echoMs verbatim', () => {
    const { t } = welcomed()
    t.deliver('unreliable', heartbeatBytes('ping', { seq: 41, echoMs: 123_456 }))

    const pongs = t.sentOf('pong')
    expect(pongs).toHaveLength(1)
    expect(pongs[0].channel).toBe('unreliable')
    const m = decodeHeartbeat(body(pongs[0]))
    // A receiver that stamped its OWN time here would turn RTT into clock skew,
    // and nothing would fail loudly.
    expect(m).toEqual({ seq: 41, echoMs: 123_456 })
  })
})

describe('RoomClient - a socket that goes quiet', () => {
  it('closes the room when nothing arrives for PEER_STALE_MS, before the race', () => {
    const { t, room } = welcomed()
    const closed: string[] = []
    room.onClosed((reason) => closed.push(reason))

    room.poll(4999)
    expect(room.state().phase).toBe('lobby')
    room.poll(5000)
    expect(room.state().phase).toBe('closed')
    expect(room.state().error).toBe('serverLost')
    expect(closed).toEqual(['serverLost'])

    room.poll(10_000)
    expect(closed).toHaveLength(1)
    expect(t.closed()).toBe(0) // the socket is the composition root's to close
  })

  it('keeps racing and only sets serverLost when the socket dies mid-race (F-P4-24)', () => {
    const { t, room } = welcomed()
    const closed: string[] = []
    room.onClosed((reason) => closed.push(reason))
    t.deliver('reliable', startBytes(startMessage()))
    room.poll(0)
    room.poll(3000)
    expect(room.state().phase).toBe('racing')

    room.poll(9000)

    // The race KEEPS RUNNING host-authoritative over WebRTC. Tearing it down
    // because the BACKUP authority died is the worst of the three options.
    expect(room.state().phase).toBe('racing')
    expect(room.state().serverLost).toBe(true)
    expect(closed).toEqual([])

    room.finishRace()
    room.poll(12_000)
    room.returnToLobby()
    expect(room.state().phase).toBe('finished')
    expect(room.state().serverLost).toBe(true)
    expect(closed).toEqual([])
  })

  it('moves a healthy completed race back to the persistent lobby explicitly', () => {
    const { t, room } = welcomed()
    t.deliver('reliable', startBytes(startMessage()))
    room.poll(0)
    room.poll(3000)

    room.finishRace()
    expect(room.state().phase).toBe('finished')
    room.returnToLobby()

    expect(room.state().phase).toBe('lobby')
    expect(room.state().start).toBeNull()
    expect(room.state().serverLost).toBe(false)
  })

  it('does not go stale while pongs keep coming back', () => {
    const { t, room } = welcomed()
    let answered = 0
    for (let now = 0; now <= 20_000; now += 16) {
      room.poll(now)
      const pings = t.sentOf('ping')
      // The far side echoes seq and echoMs unchanged.
      while (answered < pings.length) {
        t.deliver('unreliable', heartbeatBytes('pong', decodeHeartbeat(body(pings[answered]))))
        answered++
      }
    }
    expect(answered).toBeGreaterThanOrEqual(19)
    expect(room.state().phase).toBe('lobby')
    expect(room.state().serverLost).toBe(false)
  })
})

describe('RoomClient - close codes', () => {
  it('maps 4001 onto versionMismatch', () => {
    const t = makeFakeTransport()
    const room = new RoomClient(opts(t))
    const closed: string[] = []
    room.onClosed((reason) => closed.push(reason))
    room.connect()

    room.noteSocketClosed(4001)

    // A close code is the only channel that crosses a protocol version
    // boundary intact: an encoded welcome does not. This is what puts "this app
    // is out of date" on the screen instead of a spinner that never ends.
    expect(room.state().error).toBe('versionMismatch')
    expect(room.state().phase).toBe('closed')
    expect(closed).toEqual(['versionMismatch'])
  })

  it('maps 4002 onto roomClosed', () => {
    const { room } = welcomed()
    room.noteSocketClosed(4002)
    expect(room.state().error).toBe('roomClosed')
    expect(room.state().phase).toBe('closed')
  })

  it('treats server shutdown 4002 as recoverable during a direct race', () => {
    const { t, room } = welcomed()
    const closed: string[] = []
    room.onClosed((reason) => closed.push(reason))
    t.deliver('reliable', startBytes(startMessage()))
    room.poll(0)
    room.poll(3000)

    // RoomHub.close uses WS_CLOSE_ROOM_CLOSED for graceful process shutdown.
    // Once direct play is active that cannot mean "tear down the race".
    room.noteSocketClosed(4002)

    expect(room.state().phase).toBe('racing')
    expect(room.state().serverLost).toBe(true)
    expect(room.state().error).toBe('')
    expect(closed).toEqual([])
  })

  it('treats any other code mid-race as serverLost and keeps racing', () => {
    const { t, room } = welcomed()
    t.deliver('reliable', startBytes(startMessage()))
    room.poll(0)
    room.poll(3000)

    room.noteSocketClosed(1006)

    expect(room.state().phase).toBe('racing')
    expect(room.state().serverLost).toBe(true)
  })
})

describe('RoomClient - authorityChange', () => {
  it('records the tick and eventSeq and fires onAuthorityChange, changing no phase', () => {
    const { t, room } = welcomed()
    t.deliver('reliable', startBytes(startMessage()))
    room.poll(0)
    room.poll(3000)
    const seen: number[][] = []
    room.onAuthorityChange((tick, eventSeq) => seen.push([tick, eventSeq]))

    t.deliver('reliable', authorityChangeBytes(742, 19))

    expect(seen).toEqual([[742, 19]])
    expect(room.state().authorityTick).toBe(742)
    expect(room.state().authorityEventSeq).toBe(19)
    expect(room.state().phase).toBe('racing')
  })

  it('starts at -1 for both, so "never promoted" is not tick 0', () => {
    const { room } = welcomed()
    expect(room.state().authorityTick).toBe(-1)
    expect(room.state().authorityEventSeq).toBe(-1)
  })

  it('clears promotion and server-loss state at the start of every rematch', () => {
    const { t, room } = welcomed()
    t.deliver('reliable', startBytes(startMessage({ raceSeed: 1 })))
    room.poll(0)
    room.poll(3000)
    t.deliver('reliable', authorityChangeBytes(742, 19))
    room.noteSocketClosed(1006)

    expect(room.state()).toMatchObject({
      phase: 'racing',
      authorityTick: 742,
      authorityEventSeq: 19,
      serverLost: true,
    })

    t.deliver('reliable', startBytes(startMessage({ raceSeed: 2 })))

    expect(room.state()).toMatchObject({
      phase: 'starting',
      authorityTick: -1,
      authorityEventSeq: -1,
      serverLost: false,
    })
    expect(room.state().start?.raceSeed).toBe(2)
  })
})

describe('RoomClient - a hostile or truncated frame', () => {
  it('counts a truncated welcome as a dropped datagram and changes nothing', () => {
    const t = makeFakeTransport()
    const room = new RoomClient(opts(t))
    room.connect()
    const before = { ...room.state() }

    const full = welcomeBytes(welcome())
    t.deliver('reliable', full.subarray(0, 3)) // header plus one byte

    expect({ ...room.state() }).toEqual(before)
    expect(droppedDatagramsOf(room)).toBe(1)
  })

  it('counts a datagram with an unknown tag and never dispatches it', () => {
    const t = makeFakeTransport()
    const room = new RoomClient(opts(t))
    room.connect()

    t.deliver('reliable', new Uint8Array([0x7f, 2, 0, 0]))

    expect(room.state().phase).toBe('connecting')
    expect(droppedDatagramsOf(room)).toBe(1)
  })

  it('ignores the race kinds, which belong to ClientLoop', () => {
    const { t, room } = welcomed()
    const before = { ...room.state() }
    t.deliver('unreliable', taggedDatagram('snapshot'))
    expect({ ...room.state() }).toEqual(before)
  })
})

describe('RoomClient - close()', () => {
  it('closes the transport once and reports it once', () => {
    const { t, room } = welcomed()
    const closed: string[] = []
    room.onClosed((reason) => closed.push(reason))

    room.close()
    room.close()

    expect(t.closed()).toBe(1)
    expect(room.state().phase).toBe('closed')
    expect(closed).toEqual(['closed'])
  })
})

describe('RoomClient - the divergence constants', () => {
  it('exports §6.4 starting values', () => {
    expect(HARD_RESYNC_LIMIT).toBe(3)
    expect(HARD_RESYNC_WINDOW_TICKS).toBe(600) // 10 s at 60 Hz
  })
})
