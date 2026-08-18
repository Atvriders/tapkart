import { describe, expect, it } from 'vitest'
import { CHARACTERS, TUNING, loadTrack } from '@tapkart/content'
import { ShadowLoop, createNullTransport, promotionTickOf } from '@tapkart/net'
import { MAX_KARTS, createState } from '@tapkart/sim'
import type { SimContext } from '@tapkart/sim'
import type { PeerId, PeerRecord, RaceRuntime, RoomRecord } from '../src/types'
import {
  assignSeat,
  bumpLobbyVersion,
  buildLobbyMessage,
  buildStartMessage,
  canStart,
  characterIdxOf,
  humanMaskOf,
  isHost,
  releaseSeat,
  seatMapOf,
  seatOf,
} from '../src/lobby'

function makeRoom(overrides: Partial<RoomRecord> = {}): RoomRecord {
  return {
    code: 'ABCDE', createdAtMs: 0, lastActivityMs: 0, phase: 'lobby',
    hostPeerId: null, hostPlayerId: -1, trackId: 'caldera', lobbyVersion: 1,
    raceSeed: 0, peers: new Map<PeerId, PeerRecord>(), slotsInUse: new Set<number>(),
    seats: new Array<PeerId | null>(MAX_KARTS).fill(null), rtcFailures: 0, race: null,
    ...overrides,
  }
}

function makePeer(peerId: string, slot: number, overrides: Partial<PeerRecord> = {}): PeerRecord {
  return {
    peerId, slot, playerId: -1, token: '', role: 'guest', name: '', characterIdx: 0,
    ready: false, relay: false, connected: true, joinedAtMs: 0, lastSeenMs: 0,
    liveness: {
      lastSeenMs: 0, lastPingSentMs: 0, lastPingSeq: 0,
      rttMs: 0, pingsSent: 0, pongsSeen: 0,
    },
    ...overrides,
  }
}

function join(room: RoomRecord, peer: PeerRecord): PeerRecord {
  room.peers.set(peer.peerId, peer)
  assignSeat(room, peer)
  return peer
}

function raceRuntime(promotionTick: number): RaceRuntime {
  const loaded = loadTrack('caldera')
  const ctx: SimContext = {
    track: loaded.track,
    query: loaded.query,
    tuning: TUNING,
    characters: [...CHARACTERS],
    isLeader: false,
  }
  const state = createState(ctx, 7, new Array<number>(MAX_KARTS).fill(0))
  const shadow = new ShadowLoop(ctx, state, createNullTransport())
  if (promotionTick >= 0) shadow.promote(promotionTick)
  expect(promotionTickOf(shadow)).toBe(promotionTick)
  return { shadow } as unknown as RaceRuntime
}

describe('seat assignment', () => {
  it('uses the lowest free seat and fills a released hole', () => {
    const room = makeRoom()
    const first = join(room, makePeer('first', 1))
    const second = join(room, makePeer('second', 2))
    const third = join(room, makePeer('third', 3))
    expect([first.playerId, second.playerId, third.playerId]).toEqual([0, 1, 2])
    releaseSeat(room, second)
    expect(join(room, makePeer('fourth', 4)).playerId).toBe(1)
  })

  it('is idempotent for an already seated peer', () => {
    const room = makeRoom()
    const peer = join(room, makePeer('peer', 1))
    expect(assignSeat(room, peer)).toBe(0)
    expect(room.seats.filter((id) => id === 'peer')).toHaveLength(1)
  })

  it('returns -1 without mutation when all seats are occupied', () => {
    const room = makeRoom()
    for (let index = 0; index < MAX_KARTS; index++) join(room, makePeer(`p${index}`, index + 1))
    const extra = makePeer('extra', 20)
    expect(assignSeat(room, extra)).toBe(-1)
    expect(extra.playerId).toBe(-1)
    expect(room.seats).not.toContain(null)
  })

  it('restores a reconnecting peer to its carried playerId', () => {
    const room = makeRoom()
    join(room, makePeer('old-a', 1))
    const old = join(room, makePeer('old-b', 2))
    room.peers.delete('old-b')
    room.seats[0] = null
    const revived = makePeer('new-b', 7, { playerId: old.playerId })
    room.peers.set(revived.peerId, revived)
    expect(assignSeat(room, revived)).toBe(1)
    expect(room.seats).toEqual([null, 'new-b', null, null, null, null, null, null])
  })

  it('returns -1 for an unknown peer and releases totality', () => {
    const room = makeRoom()
    const peer = makePeer('peer', 1)
    expect(seatOf(room, 'nobody')).toBe(-1)
    expect(() => releaseSeat(room, peer)).not.toThrow()
    expect(peer.playerId).toBe(-1)
  })

  it('writes hostPlayerId only when the room creator is seated or released', () => {
    const room = makeRoom({ hostPeerId: 'host' })
    join(room, makePeer('guest', 1))
    expect(room.hostPlayerId).toBe(-1)
    const host = join(room, makePeer('host', 2, { role: 'host' }))
    expect(room.hostPlayerId).toBe(1)
    releaseSeat(room, host)
    expect(room.hostPlayerId).toBe(-1)
  })
})

it('increments lobbyVersion exactly once per call', () => {
  const room = makeRoom({ lobbyVersion: 4 })
  expect(bumpLobbyVersion(room)).toBe(5)
  expect(bumpLobbyVersion(room)).toBe(6)
})

describe('lobby and start projections', () => {
  it('projects humans, disconnected occupants, and empty bot seats', () => {
    const room = makeRoom({ hostPeerId: 'host', lobbyVersion: 9, trackId: 'glacier-pass' })
    join(room, makePeer('host', 11, { role: 'host', name: 'Ada', characterIdx: 3, ready: true }))
    join(room, makePeer('guest', 12, { name: 'Bo', characterIdx: 5, connected: false }))
    const message = buildLobbyMessage(room)
    expect(message).toMatchObject({ lobbyVersion: 9, hostPlayerId: 0, trackId: 'glacier-pass' })
    expect(message.slots).toHaveLength(MAX_KARTS)
    expect(message.slots[0]).toEqual({
      occupied: true, isBot: false, connected: true, ready: true,
      characterIdx: 3, peerSlot: 11, name: 'Ada',
    })
    expect(message.slots[1]).toEqual({
      occupied: true, isBot: false, connected: false, ready: false,
      characterIdx: 5, peerSlot: 12, name: 'Bo',
    })
    expect(message.slots[2]).toEqual({
      occupied: false, isBot: true, connected: false, ready: false,
      characterIdx: 0, peerSlot: 0, name: '',
    })
  })

  it('treats a stale seat whose peer record vanished as empty', () => {
    const room = makeRoom()
    join(room, makePeer('gone', 1, { name: 'Gone' }))
    room.peers.delete('gone')
    expect(buildLobbyMessage(room).slots[0]).toMatchObject({ occupied: false, isBot: true, name: '' })
  })

  it('computes connected-human mask and character vector by seat', () => {
    const room = makeRoom()
    join(room, makePeer('a', 1, { characterIdx: 2 }))
    join(room, makePeer('b', 2, { characterIdx: 4, connected: false }))
    join(room, makePeer('c', 3, { characterIdx: 6 }))
    expect(humanMaskOf(room)).toBe(0b101)
    expect(characterIdxOf(room)).toEqual([2, 4, 6, 0, 0, 0, 0, 0])
  })

  it('builds a start message without minting or mutating its seed', () => {
    const room = makeRoom({ trackId: 'redwood-rise' })
    join(room, makePeer('a', 1, { characterIdx: 2 }))
    expect(buildStartMessage(room, 0xdeadbeef)).toEqual({
      raceSeed: 0xdeadbeef, trackId: 'redwood-rise', humanMask: 1,
      characterIdx: [2, 0, 0, 0, 0, 0, 0, 0],
    })
  })
})

describe('live authority map', () => {
  it('maps peers to current seats and unknown peers to -1', () => {
    const room = makeRoom({ hostPeerId: 'host' })
    const map = seatMapOf(room)
    join(room, makePeer('host', 1, { role: 'host' }))
    join(room, makePeer('guest', 2))
    expect(map.playerIdOf('host')).toBe(0)
    expect(map.playerIdOf('guest')).toBe(1)
    expect(map.playerIdOf('stranger')).toBe(-1)
  })

  it('recognises only the host until the real ShadowLoop promotes', () => {
    const room = makeRoom({ hostPeerId: 'host' })
    join(room, makePeer('host', 1, { role: 'host' }))
    join(room, makePeer('guest', 2))
    const map = seatMapOf(room)
    expect(map.isAuthority('host')).toBe(true)
    expect(map.isAuthority('guest')).toBe(false)
    room.race = raceRuntime(-1)
    expect(map.isAuthority('host')).toBe(true)
    room.race = raceRuntime(612)
    expect(map.isAuthority('host')).toBe(false)
    expect(map.isAuthority('guest')).toBe(false)
  })
})

describe('host start policy', () => {
  it('allows only a seated room creator in lobby or finished', () => {
    const room = makeRoom({ hostPeerId: 'host' })
    const host = join(room, makePeer('host', 1, { role: 'host' }))
    const guest = join(room, makePeer('guest', 2))
    expect(isHost(room, host)).toBe(true)
    expect(isHost(room, guest)).toBe(false)
    expect(canStart(room, host)).toBe(true)
    expect(canStart(room, guest)).toBe(false)
    room.phase = 'finished'
    expect(canStart(room, host)).toBe(true)
  })

  it('refuses a live race, a closed room, and an unseated creator', () => {
    const room = makeRoom({ hostPeerId: 'host' })
    const host = join(room, makePeer('host', 1, { role: 'host' }))
    room.phase = 'racing'
    room.race = raceRuntime(-1)
    expect(canStart(room, host)).toBe(false)
    room.phase = 'closed'
    room.race = null
    expect(canStart(room, host)).toBe(false)
    releaseSeat(room, host)
    room.phase = 'lobby'
    expect(canStart(room, host)).toBe(false)
  })
})
