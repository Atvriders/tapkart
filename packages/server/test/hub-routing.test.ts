import { describe, expect, it } from 'vitest'
import { MAX_KARTS } from '@tapkart/sim'
import type { ClientUpdateMessage, HelloMessage } from '@tapkart/protocol'
import {
  CLIENT_FLAG_READY, CLIENT_FLAG_RTC_CONNECTED, CLIENT_FLAG_RTC_FAILED,
  CLIENT_FLAG_START_REQUEST, CLIENT_FLAG_WEBRTC,
  SERVER_FLAG_CHECKPOINT_NEXT, SERVER_FLAG_IS_HOST, SERVER_FLAG_RACE_IN_PROGRESS,
  SERVER_FLAG_RELAY_ASSIGNED, SERVER_FLAG_RELAY_FIRST, isValidRoomCode,
} from '@tapkart/protocol'
import type { WsFrame } from '@tapkart/net'
import {
  RTC_CONNECT_TIMEOUT_MS, WS_FRAME_CONTROL, WS_FRAME_DATA, WS_SLOT_BROADCAST, WS_SLOT_SERVER,
  createLiveness,
} from '@tapkart/net'
import type { Track } from '@tapkart/sim'
import type { PeerId, PeerRecord, RaceRuntime, RoomRecord } from '../src/types'
import type { RandomSource } from '../src/random'
import type { ContentProvider } from '../src/content'
import type { HubDeps } from '../src/hub'
import {
  RELAY_FIRST_AFTER_FAILURES, handleClientUpdate, handleHello, routeDatagram, shouldRelay,
} from '../src/hub'
import { RoomRegistry } from '../src/registry'
import { assignSeat } from '../src/lobby'
import { makeMemoryLogSink } from '../src/log'
import { makeRateLimiter } from '../src/ratelimit'
import { DEFAULT_CONFIG } from '../src/env'

/** §9.1's fake, byte i of draw n is (n * 31 + i) & 0xff, kept identical here so
 *  the fixture module can adopt it verbatim without changing any expectation. */
function countingRandom(): RandomSource {
  let draw = 0
  return (bytes: number): Uint8Array => {
    const out = new Uint8Array(bytes)
    for (let i = 0; i < bytes; i++) out[i] = (draw * 31 + i) & 0xff
    draw += 1
    return out
  }
}

const TRACK_IDS = ['caldera', 'glacier-pass'] as const

function fakeContent(): ContentProvider {
  const known = new Set<string>(TRACK_IDS)
  return {
    track: (id) => (known.has(id) ? ({ id } as unknown as Track) : null),
    contextFor: () => null,     // startRace is Task 20's; nothing here builds one
    trackIds: () => TRACK_IDS,
  }
}

interface Charge { key: string; nowMs: number }

function makeDeps(overrides: Partial<HubDeps> = {}): {
  deps: HubDeps
  log: ReturnType<typeof makeMemoryLogSink>
  charges: Charge[]
} {
  const log = makeMemoryLogSink()
  const charges: Charge[] = []
  const inner = makeRateLimiter({ windowMs: 60_000, max: 5 })
  const deps: HubDeps = {
    config: DEFAULT_CONFIG,
    registry: new RoomRegistry({
      maxRooms: 4, maxPeersPerRoom: MAX_KARTS, roomIdleMs: 600_000, rand: countingRandom(),
    }),
    content: fakeContent(),
    rand: countingRandom(),
    log,
    failedJoins: {
      allowed: (key, nowMs) => inner.allowed(key, nowMs),
      note: (key, nowMs) => { charges.push({ key, nowMs }); inner.note(key, nowMs) },
      reset: () => { inner.reset() },
    },
    ...overrides,
  }
  return { deps, log, charges }
}

let peerSeq = 0
function provisional(role: 'host' | 'guest' = 'guest'): PeerRecord {
  peerSeq += 1
  return {
    peerId: 'peer' + String(peerSeq), slot: 0, playerId: -1, token: '', role,
    name: '', characterIdx: 0, ready: false, relay: false, connected: true,
    joinedAtMs: 0, lastSeenMs: 0, liveness: createLiveness(0),
  }
}

function hello(over: Partial<HelloMessage> = {}): HelloMessage {
  return {
    role: 'guest', roomCode: '', token: '', characterIdx: 0, name: '',
    trackId: '', flags: CLIENT_FLAG_WEBRTC, ...over,
  }
}

function update(over: Partial<ClientUpdateMessage> = {}): ClientUpdateMessage {
  return { flags: 0, characterIdx: 0, name: '', trackId: '', ...over }
}

function dataFrame(peerSlot: number): WsFrame {
  return {
    frameKind: WS_FRAME_DATA, channel: 'unreliable', controlOp: null, peerSlot,
    payload: new Uint8Array([0x10, 0x02, 0x00]),
  }
}

/** Host + two guests, seated, with the relay flags the caller asks for. */
function topology(hostRelay: boolean, guestRelay: boolean[]): {
  room: RoomRecord; host: PeerRecord; guests: PeerRecord[]
} {
  const room: RoomRecord = {
    code: 'ABCDE', createdAtMs: 0, lastActivityMs: 0, phase: 'racing',
    hostPeerId: 'ph', hostPlayerId: 0, trackId: 'caldera', lobbyVersion: 1, raceSeed: 7,
    peers: new Map<PeerId, PeerRecord>(), slotsInUse: new Set<number>(),
    seats: new Array<PeerId | null>(MAX_KARTS).fill(null),
    rtcFailures: 0, race: null,
  }
  const host: PeerRecord = { ...provisional('host'), peerId: 'ph', slot: 1, relay: hostRelay }
  room.peers.set('ph', host)
  assignSeat(room, host)
  const guests = guestRelay.map((relay, i) => {
    const g: PeerRecord = { ...provisional(), peerId: 'pg' + String(i), slot: 2 + i, relay }
    room.peers.set(g.peerId, g)
    assignSeat(room, g)
    return g
  })
  return { room, host, guests }
}

describe('shouldRelay', () => {
  it('relays only between the host and a relay guest, never guest to guest', () => {
    const { room, host, guests } = topology(false, [true, false])
    const [relayGuest, rtcGuest] = guests

    expect(shouldRelay(room, host, relayGuest)).toBe(true)
    expect(shouldRelay(room, relayGuest, host)).toBe(true)
    expect(shouldRelay(room, host, rtcGuest)).toBe(false)
    expect(shouldRelay(room, rtcGuest, host)).toBe(false)
    expect(shouldRelay(room, relayGuest, rtcGuest)).toBe(false)
    expect(shouldRelay(room, relayGuest, relayGuest)).toBe(false)
  })

  it('never relays to a disconnected peer, and never without a host', () => {
    const { room, host, guests } = topology(false, [true])
    const [relayGuest] = guests

    expect(shouldRelay(room, host, relayGuest)).toBe(true)     // the floor
    relayGuest.connected = false
    expect(shouldRelay(room, host, relayGuest)).toBe(false)

    relayGuest.connected = true
    room.hostPeerId = null
    expect(shouldRelay(room, host, relayGuest)).toBe(false)
  })
})

describe('routeDatagram', () => {
  it("sends a relay guest's broadcast to the host and to no other guest", () => {
    const { room, guests } = topology(false, [true, true])
    const [a, b] = guests

    const to = routeDatagram(room, a, dataFrame(WS_SLOT_BROADCAST))
    expect(to.map((p) => p.peerId)).toEqual(['ph'])
    expect(to.map((p) => p.peerId)).not.toContain(b.peerId)
  })

  it("sends the host's broadcast to relay guests and not to peers whose WebRTC is up", () => {
    const { room, host, guests } = topology(false, [true, false, true])

    const to = routeDatagram(room, host, dataFrame(WS_SLOT_BROADCAST))
    expect(to.map((p) => p.peerId).sort()).toEqual([guests[0].peerId, guests[2].peerId].sort())
  })

  it('drops a direct guest\'s broadcast: it already reached the host over WebRTC', () => {
    const { room, guests } = topology(false, [false])
    expect(routeDatagram(room, guests[0], dataFrame(WS_SLOT_BROADCAST))).toEqual([])
  })

  it('routes a specific slot to that peer alone', () => {
    const { room, host, guests } = topology(false, [true, true])
    const to = routeDatagram(room, host, dataFrame(guests[1].slot))
    expect(to.map((p) => p.peerId)).toEqual([guests[1].peerId])
  })

  it('never returns the sender, whatever the slot says', () => {
    const { room, host, guests } = topology(true, [true])
    expect(routeDatagram(room, host, dataFrame(host.slot))).toEqual([])
    expect(routeDatagram(room, host, dataFrame(WS_SLOT_BROADCAST)).map((p) => p.peerId))
      .not.toContain(host.peerId)
    expect(routeDatagram(room, guests[0], dataFrame(WS_SLOT_BROADCAST)).map((p) => p.peerId))
      .not.toContain(guests[0].peerId)
  })

  it('relays nothing addressed to the room itself, and nothing from a control frame', () => {
    const { room, host, guests } = topology(false, [true])
    // The floor: this same room DOES relay a broadcast, so [] below is a rule.
    expect(routeDatagram(room, guests[0], dataFrame(WS_SLOT_BROADCAST))).toHaveLength(1)

    expect(routeDatagram(room, guests[0], dataFrame(WS_SLOT_SERVER))).toEqual([])
    expect(routeDatagram(room, host, {
      frameKind: WS_FRAME_CONTROL, channel: null, controlOp: 0x01,
      peerSlot: WS_SLOT_BROADCAST, payload: new Uint8Array(0),
    })).toEqual([])
  })

  it('routes to an unknown or disconnected slot as nobody', () => {
    const { room, host, guests } = topology(false, [true])
    expect(routeDatagram(room, host, dataFrame(200))).toEqual([])
    guests[0].connected = false
    expect(routeDatagram(room, host, dataFrame(guests[0].slot))).toEqual([])
  })
})

describe('handleHello — creating a room', () => {
  it('mints a room, seats the creator as host, and answers ok', () => {
    const { deps, log } = makeDeps()
    const peer = provisional('host')

    const w = handleHello(deps, null, peer, hello({ role: 'host', name: 'Ada', characterIdx: 3 }), 1000)

    expect(w.result).toBe('ok')
    expect(isValidRoomCode(w.roomCode)).toBe(true)
    expect(w.playerId).toBe(0)
    expect(w.token).not.toBe('')
    expect(w.hostPlayerId).toBe(0)
    expect(w.flags & SERVER_FLAG_IS_HOST).toBe(SERVER_FLAG_IS_HOST)
    expect(w.lobbyVersion).toBeGreaterThan(0)

    const room = deps.registry.getRoom(w.roomCode)
    expect(room).not.toBeNull()
    expect(room!.hostPeerId).toBe(peer.peerId)
    // The declaration lands on the REGISTRY's record, never on the provisional one.
    const seated = room!.peers.get(peer.peerId)
    expect(seated!.name).toBe('Ada')
    expect(seated!.characterIdx).toBe(3)
    expect(seated!.slot).toBeGreaterThan(0)
    expect(w.peerSlot).toBe(seated!.slot)
    expect(peer.name).toBe('')          // untouched

    expect(log.events().some((e) => e.kind === 'roomCreated' && e.code === w.roomCode)).toBe(true)
    expect(log.events().some((e) => e.kind === 'peerJoined' && e.playerId === 0)).toBe(true)
  })

  it('honours the creating host\'s trackId, and falls back to the first known track', () => {
    const { deps } = makeDeps()
    const a = handleHello(deps, null, provisional('host'), hello({ role: 'host', trackId: 'glacier-pass' }), 0)
    expect(deps.registry.getRoom(a.roomCode)!.trackId).toBe('glacier-pass')

    const b = handleHello(deps, null, provisional('host'), hello({ role: 'host', trackId: 'not-a-track' }), 0)
    expect(deps.registry.getRoom(b.roomCode)!.trackId).toBe('caldera')
  })

  it('answers roomFull when the registry is at its room cap', () => {
    const { deps } = makeDeps()
    for (let i = 0; i < 4; i++) {
      expect(handleHello(deps, null, provisional('host'), hello({ role: 'host' }), 0).result).toBe('ok')
    }
    const w = handleHello(deps, null, provisional('host'), hello({ role: 'host' }), 0)
    expect(w.result).toBe('roomFull')
    expect(w.playerId).toBe(-1)
    expect(w.token).toBe('')
  })
})

describe('handleHello — joining a room', () => {
  function withRoom(): { deps: HubDeps; log: ReturnType<typeof makeMemoryLogSink>; charges: Charge[]; room: RoomRecord } {
    const made = makeDeps()
    const w = handleHello(made.deps, null, provisional('host'), hello({ role: 'host', name: 'Host' }), 0)
    const room = made.deps.registry.getRoom(w.roomCode)!
    return { ...made, room }
  }

  it('seats a guest by code and never charges the limiter for a success', () => {
    const s = withRoom()
    const peer = provisional()

    const w = handleHello(s.deps, s.room, peer, hello({ roomCode: s.room.code.toLowerCase(), name: 'Bo' }), 100)

    expect(w.result).toBe('ok')
    expect(w.playerId).toBe(1)
    expect(w.hostPlayerId).toBe(0)
    expect(w.flags & SERVER_FLAG_IS_HOST).toBe(0)
    expect(s.charges).toEqual([])
  })

  it('answers roomNotFound and charges the ROOM CODE, once', () => {
    const s = withRoom()
    const w = handleHello(s.deps, null, provisional(), hello({ roomCode: 'ZZZZZ' }), 500)

    expect(w.result).toBe('roomNotFound')
    expect(s.charges).toEqual([{ key: 'ZZZZZ', nowMs: 500 }])
    expect(s.log.events().some((e) => e.kind === 'rejected' && e.result === 'roomNotFound')).toBe(true)
  })

  it('answers rateLimited once the code is over budget, without consulting the room', () => {
    const s = withRoom()
    for (let i = 0; i < 5; i++) handleHello(s.deps, null, provisional(), hello({ roomCode: 'ZZZZZ' }), 0)
    expect(s.charges).toHaveLength(5)              // the floor: five real failures

    const w = handleHello(s.deps, s.room, provisional(), hello({ roomCode: 'ZZZZZ' }), 0)
    expect(w.result).toBe('rateLimited')
    expect(s.charges).toHaveLength(5)              // a refusal is not itself charged

    // A different code is unaffected: the key is the code, and nothing about it
    // is derived from an address.
    expect(handleHello(s.deps, s.room, provisional(), hello({ roomCode: s.room.code }), 0).result).toBe('ok')
  })

  it('answers badRequest for a code that is not canonical, and charges nothing', () => {
    const s = withRoom()
    const w = handleHello(s.deps, null, provisional(), hello({ roomCode: 'ABC' }), 0)
    expect(w.result).toBe('badRequest')
    expect(s.charges).toEqual([])
  })

  it('answers roomClosed for an expired room and charges it', () => {
    const s = withRoom()
    s.room.phase = 'closed'
    const w = handleHello(s.deps, s.room, provisional(), hello({ roomCode: s.room.code }), 0)
    expect(w.result).toBe('roomClosed')
    expect(s.charges.map((c) => c.key)).toEqual([s.room.code])
  })

  it('answers roomFull for the ninth joiner', () => {
    const s = withRoom()
    for (let i = 1; i < MAX_KARTS; i++) {
      expect(handleHello(s.deps, s.room, provisional(), hello({ roomCode: s.room.code }), 0).result).toBe('ok')
    }
    const w = handleHello(s.deps, s.room, provisional(), hello({ roomCode: s.room.code }), 0)
    expect(w.result).toBe('roomFull')
    expect(s.charges).toEqual([])                  // a full room is not a guess
  })

  it('does not retain a new peer when every seat is held for reconnect', () => {
    const s = withRoom()
    for (let i = 1; i < MAX_KARTS; i++) {
      expect(handleHello(
        s.deps,
        s.room,
        provisional(),
        hello({ roomCode: s.room.code }),
        0,
      ).result).toBe('ok')
    }
    const disconnected = [...s.room.peers.values()][1]
    s.deps.registry.removePeer(s.room, disconnected.peerId, 10)
    expect(s.room.peers.size).toBe(MAX_KARTS)
    expect(s.room.slotsInUse.size).toBe(MAX_KARTS - 1)

    const newcomer = provisional()
    const welcome = handleHello(
      s.deps,
      s.room,
      newcomer,
      hello({ roomCode: s.room.code }),
      20,
    )

    expect(welcome.result).toBe('roomFull')
    expect(s.room.peers.has(newcomer.peerId)).toBe(false)
    expect(s.room.peers.size).toBe(MAX_KARTS)
    expect(s.room.slotsInUse.size).toBe(MAX_KARTS - 1)
  })

  it('reclaims a seat by token: same playerId, same token, new slot', () => {
    const s = withRoom()
    const first = provisional()
    const w1 = handleHello(s.deps, s.room, first, hello({ roomCode: s.room.code, name: 'Bo' }), 0)
    expect(w1.result).toBe('ok')
    const seat = w1.playerId
    const oldSlot = w1.peerSlot

    // The socket goes away the way a backgrounded phone's does.
    s.room.peers.get(first.peerId)!.connected = false

    const second = provisional()
    const w2 = handleHello(s.deps, s.room, second, hello({ roomCode: s.room.code, token: w1.token, name: 'Bo' }), 5000)

    expect(w2.result).toBe('ok')
    expect(w2.playerId).toBe(seat)
    expect(w2.token).toBe(w1.token)
    expect(w2.peerSlot).not.toBe(oldSlot)
    expect(s.room.seats[seat]).toBe(second.peerId)
    expect(s.log.events().some((e) => e.kind === 'peerReclaimed' && e.playerId === seat)).toBe(true)
  })

  it('restores creator authority when its token returns through typed JOIN', () => {
    const s = withRoom()
    const creator = [...s.room.peers.values()][0]
    const token = creator.token
    const playerId = creator.playerId
    s.deps.registry.removePeer(s.room, creator.peerId, 100)

    const returned = provisional('guest')
    const w = handleHello(s.deps, s.room, returned, hello({
      role: 'guest',
      roomCode: s.room.code,
      token,
      name: 'Host again',
    }), 200)

    expect(w.result).toBe('ok')
    expect(w.playerId).toBe(playerId)
    expect(w.playerId).toBe(w.hostPlayerId)
    expect(w.flags & SERVER_FLAG_IS_HOST).toBe(SERVER_FLAG_IS_HOST)
    expect(s.room.hostPeerId).toBe(returned.peerId)
    expect(s.room.peers.get(returned.peerId)?.role).toBe('host')
  })

  it('keeps an ordinary reclaimed guest a guest even if its hello claims host', () => {
    const s = withRoom()
    const first = provisional('guest')
    const joined = handleHello(s.deps, s.room, first, hello({ roomCode: s.room.code }), 0)
    s.deps.registry.removePeer(s.room, first.peerId, 100)

    const returned = provisional('host')
    const w = handleHello(s.deps, s.room, returned, hello({
      role: 'host',
      roomCode: s.room.code,
      token: joined.token,
    }), 200)

    expect(w.result).toBe('ok')
    expect(w.playerId).toBe(joined.playerId)
    expect(w.playerId).not.toBe(w.hostPlayerId)
    expect(w.flags & SERVER_FLAG_IS_HOST).toBe(0)
    expect(s.room.peers.get(returned.peerId)?.role).toBe('guest')
  })

  it('flags a late joiner RACE_IN_PROGRESS | CHECKPOINT_NEXT', () => {
    const s = withRoom()
    s.room.phase = 'racing'
    s.room.race = { shadow: { promotionTick: () => -1 } } as unknown as RaceRuntime

    const w = handleHello(s.deps, s.room, provisional(), hello({ roomCode: s.room.code }), 0)
    expect(w.result).toBe('ok')
    expect(w.flags & SERVER_FLAG_RACE_IN_PROGRESS).toBe(SERVER_FLAG_RACE_IN_PROGRESS)
    expect(w.flags & SERVER_FLAG_CHECKPOINT_NEXT).toBe(SERVER_FLAG_CHECKPOINT_NEXT)
  })

  it('puts a joiner straight on the relay once the room is relay-first', () => {
    const s = withRoom()
    s.room.rtcFailures = RELAY_FIRST_AFTER_FAILURES

    const peer = provisional()
    const w = handleHello(s.deps, s.room, peer, hello({ roomCode: s.room.code }), 0)

    expect(w.flags & SERVER_FLAG_RELAY_FIRST).toBe(SERVER_FLAG_RELAY_FIRST)
    expect(w.flags & SERVER_FLAG_RELAY_ASSIGNED).toBe(SERVER_FLAG_RELAY_ASSIGNED)
    expect(s.room.peers.get(peer.peerId)!.relay).toBe(true)
    expect(s.log.events().some((e) => e.kind === 'relayFirst' && e.failures === RELAY_FIRST_AFTER_FAILURES)).toBe(true)
  })
})

describe('handleClientUpdate', () => {
  function seated(): { deps: HubDeps; log: ReturnType<typeof makeMemoryLogSink>; room: RoomRecord; host: PeerRecord; guest: PeerRecord } {
    const made = makeDeps()
    const hp = provisional('host')
    const w = handleHello(made.deps, null, hp, hello({ role: 'host' }), 0)
    const room = made.deps.registry.getRoom(w.roomCode)!
    const gp = provisional()
    handleHello(made.deps, room, gp, hello({ roomCode: room.code }), 0)
    return {
      deps: made.deps, log: made.log, room,
      host: room.peers.get(hp.peerId)!, guest: room.peers.get(gp.peerId)!,
    }
  }

  it('applies ready, name and character, and bumps the version once per accepted change', () => {
    const s = seated()
    const before = s.room.lobbyVersion

    expect(handleClientUpdate(s.deps, s.room, s.guest, update({ flags: CLIENT_FLAG_READY, name: 'Bo', characterIdx: 6 }), 10)).toBe(true)
    expect(s.guest.ready).toBe(true)
    expect(s.guest.name).toBe('Bo')
    expect(s.guest.characterIdx).toBe(6)
    expect(s.room.lobbyVersion).toBe(before + 1)

    // An update that changes nothing is not a mutation and does not bump.
    expect(handleClientUpdate(s.deps, s.room, s.guest, update({ flags: CLIENT_FLAG_READY, name: 'Bo', characterIdx: 6 }), 20)).toBe(false)
    expect(s.room.lobbyVersion).toBe(before + 1)

    expect(handleClientUpdate(s.deps, s.room, s.guest, update({ flags: 0, name: 'Bo', characterIdx: 6 }), 30)).toBe(true)
    expect(s.guest.ready).toBe(false)
  })

  it('honours trackId from the host only', () => {
    const s = seated()
    expect(handleClientUpdate(s.deps, s.room, s.guest, update({ trackId: 'glacier-pass' }), 0)).toBe(false)
    expect(s.room.trackId).toBe('caldera')

    expect(handleClientUpdate(s.deps, s.room, s.host, update({ trackId: 'glacier-pass' }), 0)).toBe(true)
    expect(s.room.trackId).toBe('glacier-pass')

    expect(handleClientUpdate(s.deps, s.room, s.host, update({ trackId: 'not-a-track' }), 0)).toBe(false)
    expect(s.room.trackId).toBe('glacier-pass')
  })

  it('ignores CLIENT_FLAG_START_REQUEST entirely: starting is not a lobby mutation', () => {
    const s = seated()
    const before = s.room.lobbyVersion
    expect(handleClientUpdate(s.deps, s.room, s.host, update({ flags: CLIENT_FLAG_START_REQUEST }), 0)).toBe(false)
    expect(s.room.phase).toBe('lobby')
    expect(s.room.race).toBeNull()
    expect(s.room.lobbyVersion).toBe(before)
  })

  it('counts a give-up once per guest and logs relayFirst at the threshold', () => {
    const s = seated()
    const other = provisional()
    handleHello(s.deps, s.room, other, hello({ roomCode: s.room.code }), 0)
    const second = s.room.peers.get(other.peerId)!

    handleClientUpdate(s.deps, s.room, s.guest, update({ flags: CLIENT_FLAG_RTC_FAILED }), 0)
    expect(s.room.rtcFailures).toBe(1)
    expect(s.guest.relay).toBe(true)

    // A second report from the SAME guest is not a second failure.
    handleClientUpdate(s.deps, s.room, s.guest, update({ flags: CLIENT_FLAG_RTC_FAILED }), 10)
    expect(s.room.rtcFailures).toBe(1)

    handleClientUpdate(s.deps, s.room, second, update({ flags: CLIENT_FLAG_RTC_FAILED }), 20)
    expect(s.room.rtcFailures).toBe(RELAY_FIRST_AFTER_FAILURES)
    expect(s.log.events().some((e) => e.kind === 'relayFirst' && e.failures === RELAY_FIRST_AFTER_FAILURES)).toBe(true)
  })

  it('resets the failure streak only on explicit direct-link success', () => {
    const s = seated()
    handleClientUpdate(s.deps, s.room, s.guest, update({ flags: CLIENT_FLAG_RTC_FAILED }), 0)
    expect(s.room.rtcFailures).toBe(1)
    expect(s.guest.relay).toBe(true)

    const fresh = provisional()
    handleHello(s.deps, s.room, fresh, hello({ roomCode: s.room.code }), 1000)
    const direct = s.room.peers.get(fresh.peerId)!

    // Unrelated lobby traffic proves nothing, even after the old inference
    // deadline. A relay-first peer can never satisfy a !relay inference at all.
    handleClientUpdate(s.deps, s.room, direct, update({ name: 'late' }), 1000 + RTC_CONNECT_TIMEOUT_MS)
    expect(s.room.rtcFailures).toBe(1)

    expect(handleClientUpdate(
      s.deps,
      s.room,
      direct,
      update({ flags: CLIENT_FLAG_RTC_CONNECTED }),
      1000 + RTC_CONNECT_TIMEOUT_MS + 1,
    )).toBe(true)
    expect(s.room.rtcFailures).toBe(0)
    expect(direct.relay).toBe(false)

    // Once upgraded, losing that new direct link is a new consecutive failure
    // and the same peer must be eligible for relay again.
    expect(handleClientUpdate(
      s.deps,
      s.room,
      direct,
      update({ flags: CLIENT_FLAG_RTC_FAILED }),
      1000 + RTC_CONNECT_TIMEOUT_MS + 2,
    )).toBe(true)
    expect(s.room.rtcFailures).toBe(1)
    expect(direct.relay).toBe(true)
  })

  it('upgrades a relay-first guest to direct and clears the consecutive-failure floor', () => {
    const s = seated()
    s.room.rtcFailures = RELAY_FIRST_AFTER_FAILURES
    const peer = provisional()
    handleHello(s.deps, s.room, peer, hello({ roomCode: s.room.code }), 0)
    const relayFirst = s.room.peers.get(peer.peerId)!
    expect(relayFirst.relay).toBe(true)

    expect(handleClientUpdate(
      s.deps,
      s.room,
      relayFirst,
      update({ flags: CLIENT_FLAG_RTC_CONNECTED }),
      1,
    )).toBe(true)
    expect(relayFirst.relay).toBe(false)
    expect(s.room.rtcFailures).toBe(0)
  })

  it('does not let the host report or reset the guest RTC failure counter', () => {
    const s = seated()
    handleClientUpdate(
      s.deps,
      s.room,
      s.host,
      update({ flags: CLIENT_FLAG_RTC_FAILED }),
      RTC_CONNECT_TIMEOUT_MS,
    )
    expect(s.room.rtcFailures).toBe(0)
    expect(s.host.relay).toBe(false)

    handleClientUpdate(
      s.deps,
      s.room,
      s.guest,
      update({ flags: CLIENT_FLAG_RTC_FAILED }),
      RTC_CONNECT_TIMEOUT_MS + 1,
    )
    expect(s.room.rtcFailures).toBe(1)
    handleClientUpdate(
      s.deps,
      s.room,
      s.host,
      update({ name: 'still-host' }),
      RTC_CONNECT_TIMEOUT_MS * 2,
    )
    expect(s.room.rtcFailures).toBe(1)
  })
})
