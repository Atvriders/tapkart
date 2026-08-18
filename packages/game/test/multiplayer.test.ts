import { describe, expect, it } from 'vitest'
import type {
  ChannelName,
  LobbyMessage,
  MessageKind,
  StartMessage,
  WelcomeMessage,
  WireLobbySlot,
} from '@tapkart/protocol'
import {
  CLIENT_FLAG_RTC_CONNECTED,
  CLIENT_FLAG_RTC_FAILED,
  CLIENT_FLAG_START_REQUEST,
  INPUT_REDUNDANCY,
  SERVER_FLAG_IS_HOST,
  decodeClientUpdate,
  decodeHeader,
  encodeHeader,
  encodeInput,
  encodeLobby,
  encodeStart,
  encodeWelcome,
} from '@tapkart/protocol'
import type { Intent } from '@tapkart/sim'
import { MAX_KARTS } from '@tapkart/sim'
import type { SocketData, Transport } from '@tapkart/net'
import {
  DEFAULT_ICE_SERVERS,
  LOCAL_PEER_ID,
  WS_FRAME_DATA,
  WS_HEADER_BYTES,
  WS_SLOT_SERVER,
  decodeWsFrame,
  encodeAuthorityChange,
  encodeWsData,
} from '@tapkart/net'
import { makeFakeRtcFactory, makeFakeRtcPair } from '../../net/test/fixtures/rtc-fixtures'
import { makeFakeSocketPair } from '../../net/test/fixtures/socket-fixtures'
import {
  createMultiplayerRoom,
  withMirroredLocalInput,
} from '../src/multiplayer'

interface SpyTransport extends Transport {
  sent: Array<{ channel: ChannelName; peerId: string; data: Uint8Array }>
}

function spyTransport(): SpyTransport {
  const messageCbs: Array<(peerId: string, channel: ChannelName, data: Uint8Array) => void> = []
  const sent: SpyTransport['sent'] = []
  return {
    sent,
    send(channel, peerId, data): void { sent.push({ channel, peerId, data: data.slice() }) },
    broadcast(): void {},
    onMessage(cb): void { messageCbs.push(cb) },
    onPeerLost(): void {},
    peers: () => ['ws/p0'],
    close(): void {},
  }
}

function intent(tick: number): Intent {
  return { tick, steer: 0.25, accel: 1, brake: false, drift: false, useItem: false }
}

function bodyDatagram(kind: MessageKind, encode: (out: Uint8Array) => number): Uint8Array {
  const buf = new Uint8Array(1024)
  const h = encodeHeader(buf, kind)
  const n = encode(buf.subarray(h))
  return buf.slice(0, h + n)
}

function fromPeer(slot: number, data: Uint8Array): Uint8Array {
  const frame = new Uint8Array(WS_HEADER_BYTES + data.length)
  encodeWsData(frame, 'reliable', slot, data)
  return frame
}

function fromServer(data: Uint8Array): Uint8Array {
  return fromPeer(WS_SLOT_SERVER, data)
}

function welcome(over: Partial<WelcomeMessage>): WelcomeMessage {
  return {
    result: 'ok', roomCode: 'ABCDE', playerId: 0, token: '0123456789AB',
    hostPlayerId: 0, peerSlot: 1, flags: 0, lobbyVersion: 1, ...over,
  }
}

function emptySlot(): WireLobbySlot {
  return {
    occupied: false, isBot: true, connected: false, ready: false,
    characterIdx: 0, peerSlot: 0, name: '',
  }
}

function lobby(): LobbyMessage {
  const slots = Array.from({ length: MAX_KARTS }, emptySlot)
  slots[0] = {
    occupied: true, isBot: false, connected: true, ready: true,
    characterIdx: 1, peerSlot: 1, name: 'Host',
  }
  slots[1] = {
    occupied: true, isBot: false, connected: true, ready: true,
    characterIdx: 2, peerSlot: 2, name: 'Guest',
  }
  return { lobbyVersion: 2, hostPlayerId: 0, trackId: 'caldera', slots }
}

function startMessage(over: Partial<StartMessage> = {}): StartMessage {
  return {
    raceSeed: 1,
    trackId: 'caldera',
    humanMask: 0b11,
    characterIdx: [1, 2, 0, 0, 0, 0, 0, 0],
    ...over,
  }
}

function clientUpdateFlags(frames: readonly Uint8Array[]): number[] {
  const flags: number[] = []
  for (const bytes of frames) {
    const frame = decodeWsFrame(bytes)
    if (frame?.frameKind !== WS_FRAME_DATA || frame.payload.length < 2) continue
    if (decodeHeader(frame.payload).kind !== 'clientUpdate') continue
    flags.push(decodeClientUpdate(frame.payload.subarray(2)).flags)
  }
  return flags
}

function inputDatagram(playerId: number, tick = 20): Uint8Array {
  const inputs: Intent[] = []
  for (let i = 0; i < INPUT_REDUNDANCY; i++) inputs.push(intent(tick - INPUT_REDUNDANCY + 1 + i))
  return bodyDatagram('input', (out) => encodeInput(out, playerId, inputs))
}

describe('withMirroredLocalInput', () => {
  it('injects the quantised host input locally and mirrors the same bytes to the server shadow', () => {
    const inner = spyTransport()
    const local = withMirroredLocalInput(inner)
    const received: Array<{ peerId: string; data: Uint8Array }> = []
    local.onMessage((peerId, _channel, data) => received.push({ peerId, data: data.slice() }))

    local.submitLocalInput(0, intent(2))

    expect(received).toHaveLength(1)
    expect(received[0].peerId).toBe(LOCAL_PEER_ID)
    expect(inner.sent).toHaveLength(1)
    expect(inner.sent[0].peerId).toBe('ws/p0')
    expect(inner.sent[0].channel).toBe('unreliable')
    expect(inner.sent[0].data).toEqual(received[0].data)
  })
})

describe('createMultiplayerRoom', () => {
  it('forms a host-centred RTC link, authenticates traffic, and keeps the room alive after a race lease closes', async () => {
    const hostSocket = makeFakeSocketPair()
    const guestSocket = makeFakeSocketPair()
    const rtc = makeFakeRtcPair()
    const hostWire: Uint8Array[] = []
    const guestWire: Uint8Array[] = []

    hostSocket.b.onMessage((data: SocketData) => {
      if (typeof data === 'string') guestSocket.b.send(data)
      else hostWire.push(data.slice())
    })
    guestSocket.b.onMessage((data: SocketData) => {
      if (typeof data === 'string') hostSocket.b.send(data)
      else guestWire.push(data.slice())
    })

    const host = createMultiplayerRoom({
      socket: hostSocket.a,
      rtcFactory: () => rtc.answerer,
      iceServers: DEFAULT_ICE_SERVERS,
      role: 'host', name: 'Host', characterIdx: 1, roomCode: '', token: '', trackId: 'caldera',
    })
    const guest = createMultiplayerRoom({
      socket: guestSocket.a,
      rtcFactory: () => rtc.offerer,
      iceServers: DEFAULT_ICE_SERVERS,
      role: 'guest', name: 'Guest', characterIdx: 2, roomCode: 'ABCDE', token: '', trackId: '',
    })

    const callbacks: string[] = []
    guest.onWelcome(() => callbacks.push('welcome'))
    guest.onLobby(() => callbacks.push('lobby'))
    host.start()
    guest.start()
    hostSocket.flush()
    guestSocket.flush()
    expect(hostWire.some((bytes) => decodeHeader(decodeWsFrame(bytes)!.payload).kind === 'hello')).toBe(true)
    expect(guestWire.some((bytes) => decodeHeader(decodeWsFrame(bytes)!.payload).kind === 'hello')).toBe(true)

    hostSocket.b.send(fromServer(bodyDatagram('welcome', (out) => encodeWelcome(out, welcome({
      flags: SERVER_FLAG_IS_HOST,
    })))))
    guestSocket.b.send(fromServer(bodyDatagram('welcome', (out) => encodeWelcome(out, welcome({
      playerId: 1, peerSlot: 2, token: 'BA9876543210',
    })))))
    const lobbyMessage = lobby()
    hostSocket.b.send(fromServer(bodyDatagram('lobby', (out) => encodeLobby(out, lobbyMessage))))
    guestSocket.b.send(fromServer(bodyDatagram('lobby', (out) => encodeLobby(out, lobbyMessage))))
    hostSocket.flush()
    guestSocket.flush()

    for (let i = 0; i < 6; i++) {
      await rtc.settle()
      hostSocket.flush()
      guestSocket.flush()
    }
    host.poll(10)
    guest.poll(10)
    hostSocket.flush()
    guestSocket.flush()

    expect(callbacks).toEqual(['welcome', 'lobby'])
    expect(guest.state().relayMode).toBe(false)
    expect(clientUpdateFlags(guestWire).some((flags) =>
      (flags & CLIENT_FLAG_RTC_CONNECTED) !== 0,
    )).toBe(true)

    const hostRace = host.borrowRaceTransport()
    const guestRace = guest.borrowRaceTransport()
    const guestReceived: number[] = []
    const hostReceived: number[] = []
    guestRace.onMessage((_peerId, _channel, data) => {
      if (decodeHeader(data).kind === 'snapshot') guestReceived.push(data[0])
    })
    hostRace.onMessage((_peerId, _channel, data) => hostReceived.push(data[0]))

    const snapshot = new Uint8Array(2)
    encodeHeader(snapshot, 'snapshot')
    hostRace.broadcast('unreliable', snapshot)
    expect(guestReceived).toEqual([snapshot[0]])

    // A guest cannot impersonate the authority even over an authenticated link.
    guestRace.broadcast('unreliable', snapshot)
    expect(hostReceived).toEqual([])

    // It can submit only its own seat.
    guestRace.broadcast('unreliable', inputDatagram(1))
    guestRace.broadcast('unreliable', inputDatagram(0))
    expect(hostReceived).toEqual([inputDatagram(1)[0]])

    // The race borrowed a non-owning lease: lobby traffic still uses the socket.
    const before = guestWire.length
    guest.update({ ready: false })
    guestSocket.flush()
    expect(guestWire.length).toBeGreaterThan(before)

    const start = bodyDatagram('start', (out) => encodeStart(out, startMessage()))
    hostSocket.b.send(fromServer(start))
    guestSocket.b.send(fromServer(start))
    hostSocket.flush()
    guestSocket.flush()
    host.poll(20)
    guest.poll(20)
    host.poll(3020)
    guest.poll(3020)

    hostSocket.b.close(1006)
    guestSocket.b.close(1006)
    expect(host.state().serverLost).toBe(true)
    expect(guest.state().serverLost).toBe(true)

    // Losing the server does not sever the established direct race path.
    hostRace.broadcast('unreliable', snapshot)
    expect(guestReceived).toEqual([snapshot[0], snapshot[0]])
    guest.finishRace()
    guest.returnToLobby()
    expect(guest.state().phase).toBe('finished')

    guestRace.close()
    hostRace.broadcast('unreliable', snapshot)
    expect(guestReceived).toEqual([snapshot[0], snapshot[0]])

    hostRace.close()
    host.close()
    guest.close()
  })

  it('restores host topology and permissions from welcome after a typed JOIN reclaim', async () => {
    const recoveredSocket = makeFakeSocketPair()
    const guestSocket = makeFakeSocketPair()
    const rtc = makeFakeRtcPair()
    const recoveredWire: Uint8Array[] = []
    const guestWire: Uint8Array[] = []

    recoveredSocket.b.onMessage((data: SocketData) => {
      if (typeof data === 'string') guestSocket.b.send(data)
      else recoveredWire.push(data.slice())
    })
    guestSocket.b.onMessage((data: SocketData) => {
      if (typeof data === 'string') recoveredSocket.b.send(data)
      else guestWire.push(data.slice())
    })

    const recovered = createMultiplayerRoom({
      socket: recoveredSocket.a,
      rtcFactory: () => rtc.answerer,
      iceServers: DEFAULT_ICE_SERVERS,
      // Typed JOIN knows only the room code and persisted token. Welcome owns
      // the effective role once this creator seat is reclaimed.
      role: 'guest', name: 'Host again', characterIdx: 1,
      roomCode: 'ABCDE', token: '0123456789AB', trackId: '',
    })
    const guest = createMultiplayerRoom({
      socket: guestSocket.a,
      rtcFactory: () => rtc.offerer,
      iceServers: DEFAULT_ICE_SERVERS,
      role: 'guest', name: 'Guest', characterIdx: 2,
      roomCode: 'ABCDE', token: 'BA9876543210', trackId: '',
    })
    let roleAtWelcome = ''
    recovered.onWelcome(() => { roleAtWelcome = recovered.state().role })
    recovered.start()
    guest.start()
    recoveredSocket.flush()
    guestSocket.flush()

    recoveredSocket.b.send(fromServer(bodyDatagram('welcome', (out) => encodeWelcome(out, welcome({
      playerId: 0,
      hostPlayerId: 0,
      peerSlot: 1,
      flags: SERVER_FLAG_IS_HOST,
    })))))
    guestSocket.b.send(fromServer(bodyDatagram('welcome', (out) => encodeWelcome(out, welcome({
      playerId: 1,
      hostPlayerId: 0,
      peerSlot: 2,
      token: 'BA9876543210',
    })))))
    const lobbyMessage = lobby()
    recoveredSocket.b.send(fromServer(bodyDatagram('lobby', (out) => encodeLobby(out, lobbyMessage))))
    guestSocket.b.send(fromServer(bodyDatagram('lobby', (out) => encodeLobby(out, lobbyMessage))))
    recoveredSocket.flush()
    guestSocket.flush()

    for (let i = 0; i < 6; i++) {
      await rtc.settle()
      recoveredSocket.flush()
      guestSocket.flush()
    }
    recovered.poll(10)
    guest.poll(10)
    recoveredSocket.flush()
    guestSocket.flush()

    expect(roleAtWelcome).toBe('host')
    expect(recovered.state().role).toBe('host')
    expect(guest.state().role).toBe('guest')
    expect(clientUpdateFlags(guestWire).some((flags) =>
      (flags & CLIENT_FLAG_RTC_CONNECTED) !== 0,
    )).toBe(true)

    recovered.requestStart()
    recoveredSocket.flush()
    expect(clientUpdateFlags(recoveredWire).some((flags) =>
      (flags & CLIENT_FLAG_START_REQUEST) !== 0,
    )).toBe(true)

    rtc.failBoth()
    recoveredSocket.flush()
    guestSocket.flush()
    expect(clientUpdateFlags(recoveredWire).every((flags) =>
      (flags & CLIENT_FLAG_RTC_FAILED) === 0,
    )).toBe(true)
    expect(clientUpdateFlags(guestWire).some((flags) =>
      (flags & CLIENT_FLAG_RTC_FAILED) !== 0,
    )).toBe(true)

    recovered.close()
    guest.close()
  })

  it('accepts direct host authority again when a second race resets promotion state', () => {
    const socket = makeFakeSocketPair()
    const rtc = makeFakeRtcFactory()
    const room = createMultiplayerRoom({
      socket: socket.a,
      rtcFactory: rtc.factory,
      iceServers: DEFAULT_ICE_SERVERS,
      role: 'guest', name: 'Guest', characterIdx: 2,
      roomCode: 'ABCDE', token: '', trackId: '',
    })
    room.start()
    socket.flush()
    socket.b.send(fromServer(bodyDatagram('welcome', (out) => encodeWelcome(out, welcome({
      playerId: 1,
      peerSlot: 2,
      token: 'BA9876543210',
    })))))
    socket.b.send(fromServer(bodyDatagram('lobby', (out) => encodeLobby(out, lobby()))))
    socket.flush()

    const race = room.borrowRaceTransport()
    const snapshots: string[] = []
    race.onMessage((peerId, _channel, data) => {
      if (decodeHeader(data).kind === 'snapshot') snapshots.push(peerId)
    })
    const snapshot = bodyDatagram('snapshot', () => 0)

    socket.b.send(fromServer(bodyDatagram('start', (out) => encodeStart(out, startMessage({ raceSeed: 1 })))))
    socket.b.send(fromPeer(1, snapshot))
    socket.flush()
    expect(snapshots).toEqual(['ws/p1'])

    const authority = new Uint8Array(16)
    const authorityBytes = authority.slice(0, encodeAuthorityChange(authority, 742, 19))
    socket.b.send(fromServer(authorityBytes))
    socket.b.send(fromPeer(1, snapshot))
    socket.flush()
    expect(room.state()).toMatchObject({ authorityTick: 742, authorityEventSeq: 19 })
    expect(snapshots).toEqual(['ws/p1'])

    socket.b.send(fromServer(bodyDatagram('start', (out) => encodeStart(out, startMessage({ raceSeed: 2 })))))
    socket.b.send(fromPeer(1, snapshot))
    socket.flush()
    expect(room.state()).toMatchObject({ authorityTick: -1, authorityEventSeq: -1 })
    expect(snapshots).toEqual(['ws/p1', 'ws/p1'])

    race.close()
    room.close()
  })
})
