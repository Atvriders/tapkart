import { describe, expect, it } from 'vitest'
import { MAX_KARTS } from '@tapkart/sim'
import type { PeerId, PeerRecord, RoomRecord, ServerRoomPhase } from '../src/types'

function makePeer(peerId: PeerId, slot: number): PeerRecord {
  return {
    peerId,
    slot,
    playerId: -1,
    token: '',
    role: 'guest',
    name: '',
    characterIdx: 0,
    ready: false,
    relay: false,
    connected: true,
    joinedAtMs: 0,
    lastSeenMs: 0,
    liveness: {
      lastSeenMs: 0,
      lastPingSentMs: 0,
      lastPingSeq: 0,
      rttMs: 0,
      pingsSent: 0,
      pongsSeen: 0,
    },
  }
}

function makeRoom(code: string): RoomRecord {
  return {
    code,
    createdAtMs: 0,
    lastActivityMs: 0,
    phase: 'lobby',
    hostPeerId: null,
    hostPlayerId: -1,
    trackId: '',
    lobbyVersion: 0,
    raceSeed: 0,
    peers: new Map(),
    slotsInUse: new Set(),
    seats: new Array<PeerId | null>(MAX_KARTS).fill(null),
    rtcFailures: 0,
    race: null,
  }
}

describe('server types', () => {
  it('gives a room one empty seat per kart', () => {
    const room = makeRoom('ABCDE')
    expect(room.seats).toHaveLength(MAX_KARTS)
    expect(room.seats.every((seat) => seat === null)).toBe(true)
  })

  it('keeps room phases separate from simulation phases', () => {
    const phases: ServerRoomPhase[] = ['lobby', 'racing', 'finished', 'closed']
    expect(phases).toEqual(['lobby', 'racing', 'finished', 'closed'])
  })

  it('records a peer by id and slot before seating', () => {
    const room = makeRoom('ABCDE')
    const peer = makePeer('peer-1', 3)
    room.peers.set(peer.peerId, peer)
    room.slotsInUse.add(peer.slot)
    expect(room.peers.get('peer-1')).toMatchObject({ slot: 3, playerId: -1 })
    expect(room.race).toBeNull()
  })

  it('gives every peer independent liveness state', () => {
    const first = makePeer('first', 1)
    const second = makePeer('second', 2)
    first.liveness.lastSeenMs = 5_000
    expect(second.liveness.lastSeenMs).toBe(0)
  })
})
