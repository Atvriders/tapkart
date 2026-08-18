import { describe, expect, it } from 'vitest'
import { MAX_KARTS } from '@tapkart/sim'
import type { RandomSource } from '../src/random'
import type { PeerRecord, RoomRecord } from '../src/types'
import {
  CodeCollisionError,
  ROOM_CODE_MINT_ATTEMPTS,
  RoomFullError,
  RoomLimitError,
  RoomRegistry,
} from '../src/registry'

function makeCountingRandom(): RandomSource & { draws(): number } {
  let n = 0
  const rand = (bytes: number): Uint8Array => {
    const out = new Uint8Array(bytes)
    for (let i = 0; i < bytes; i++) out[i] = (n * 31 + i) & 0xff
    n++
    return out
  }
  return Object.assign(rand, { draws: () => n })
}

function makeStuckRandom(): RandomSource & { draws(): number } {
  let n = 0
  const rand = (bytes: number): Uint8Array => {
    n++
    return new Uint8Array(bytes)
  }
  return Object.assign(rand, { draws: () => n })
}

function makeRegistry(over: Partial<{
  maxRooms: number
  maxPeersPerRoom: number
  roomIdleMs: number
  rand: RandomSource
}> = {}): RoomRegistry {
  return new RoomRegistry({
    maxRooms: 64,
    maxPeersPerRoom: MAX_KARTS,
    roomIdleMs: 600_000,
    rand: makeCountingRandom(),
    ...over,
  })
}

function seat(room: RoomRecord, peer: PeerRecord, playerId: number): void {
  peer.playerId = playerId
  room.seats[playerId] = peer.peerId
}

describe('RoomRegistry.createRoom', () => {
  it('mints a code from the injected source and files the room under it', () => {
    const reg = makeRegistry()
    const room = reg.createRoom(1000)
    expect(room.code).toBe('01234')
    expect(reg.getRoom('01234')).toBe(room)
    expect(reg.size()).toBe(1)
  })

  it('opens the room empty, in the lobby, with one seat per kart', () => {
    const room = makeRegistry().createRoom(1000)
    expect(room.phase).toBe('lobby')
    expect(room.hostPeerId).toBeNull()
    expect(room.hostPlayerId).toBe(-1)
    expect(room.peers.size).toBe(0)
    expect(room.slotsInUse.size).toBe(0)
    expect(room.seats).toHaveLength(MAX_KARTS)
    expect(room.seats.every((s) => s === null)).toBe(true)
    expect(room.race).toBeNull()
    expect(room.rtcFailures).toBe(0)
    expect(room.lobbyVersion).toBe(0)
    expect(room.createdAtMs).toBe(1000)
    expect(room.lastActivityMs).toBe(1000)
  })

  it('does not normalise on lookup: a lowercase code is not this room', () => {
    const reg = makeRegistry()
    reg.createRoom(0)
    const second = reg.createRoom(0)
    expect(second.code).toBe('Z0123')
    expect(reg.getRoom('Z0123')).toBe(second)
    expect(reg.getRoom('z0123')).toBeNull()
    expect(reg.getRoom('nope!')).toBeNull()
  })

  it('refuses at maxRooms rather than evicting a live race', () => {
    const reg = makeRegistry({ maxRooms: 2 })
    reg.createRoom(0)
    reg.createRoom(0)
    expect(() => reg.createRoom(0)).toThrow(RoomLimitError)
    expect(reg.size()).toBe(2)
  })

  it('gives up after ROOM_CODE_MINT_ATTEMPTS collisions rather than looping forever', () => {
    const rand = makeStuckRandom()
    const reg = makeRegistry({ rand })
    const first = reg.createRoom(0)
    expect(first.code).toBe('00000')
    const drawsAfterFirst = rand.draws()
    expect(() => reg.createRoom(0)).toThrow(CodeCollisionError)
    expect(rand.draws() - drawsAfterFirst).toBe(ROOM_CODE_MINT_ATTEMPTS)
    expect(reg.size()).toBe(1)
  })
})

describe('RoomRegistry.addPeer', () => {
  it('assigns dense, unique slots starting at 1, and mints a token', () => {
    const reg = makeRegistry()
    const room = reg.createRoom(0)
    const a = reg.addPeer(room, 'peer-a', 'host', 10)
    const b = reg.addPeer(room, 'peer-b', 'guest', 20)
    expect(a.slot).toBe(1)
    expect(b.slot).toBe(2)
    expect([...room.slotsInUse].sort()).toEqual([1, 2])
    expect(room.peers.get('peer-a')).toBe(a)
    expect(a.role).toBe('host')
    expect(a.playerId).toBe(-1)
    expect(a.connected).toBe(true)
    expect(a.joinedAtMs).toBe(10)
    expect(a.token).toBe('Z0123456789A')
    expect(b.token).not.toBe(a.token)
    expect(b.token).toHaveLength(12)
  })

  it('gives every peer its own liveness state, seeded now', () => {
    const reg = makeRegistry()
    const room = reg.createRoom(0)
    const a = reg.addPeer(room, 'peer-a', 'host', 10)
    const b = reg.addPeer(room, 'peer-b', 'guest', 20)
    expect(a.liveness.lastSeenMs).toBe(10)
    expect(b.liveness.lastSeenMs).toBe(20)
    a.liveness.lastSeenMs = 999
    expect(b.liveness.lastSeenMs).toBe(20)
  })

  it('refuses the ninth peer with RoomFullError - no spectators, no queue', () => {
    const reg = makeRegistry()
    const room = reg.createRoom(0)
    for (let i = 0; i < MAX_KARTS; i++) reg.addPeer(room, `peer-${i}`, 'guest', 0)
    expect(() => reg.addPeer(room, 'peer-8', 'guest', 0)).toThrow(RoomFullError)
    expect(room.peers.size).toBe(MAX_KARTS)
    expect(room.slotsInUse.size).toBe(MAX_KARTS)
  })

  it('counts only CONNECTED peers against the cap', () => {
    const reg = makeRegistry({ maxPeersPerRoom: 2 })
    const room = reg.createRoom(0)
    const a = reg.addPeer(room, 'peer-a', 'host', 0)
    seat(room, a, 0)
    reg.addPeer(room, 'peer-b', 'guest', 0)
    reg.removePeer(room, 'peer-a', 100)
    expect(() => reg.addPeer(room, 'peer-c', 'guest', 200)).not.toThrow()
  })
})

describe('RoomRegistry.removePeer', () => {
  it('frees the slot and marks the peer gone, keeping a SEATED record for reclaim', () => {
    const reg = makeRegistry()
    const room = reg.createRoom(0)
    const a = reg.addPeer(room, 'peer-a', 'host', 0)
    seat(room, a, 0)
    const gone = reg.removePeer(room, 'peer-a', 500)
    expect(gone).toBe(a)
    expect(a.connected).toBe(false)
    expect(room.slotsInUse.has(1)).toBe(false)
    expect(room.peers.get('peer-a')).toBe(a)
    expect(a.playerId).toBe(0)
  })

  it('deletes a peer that never got a seat', () => {
    const reg = makeRegistry()
    const room = reg.createRoom(0)
    reg.addPeer(room, 'peer-a', 'guest', 0)
    reg.removePeer(room, 'peer-a', 500)
    expect(room.peers.has('peer-a')).toBe(false)
  })

  it('returns null for a peer that was never here, and changes nothing', () => {
    const reg = makeRegistry()
    const room = reg.createRoom(0)
    reg.addPeer(room, 'peer-a', 'host', 0)
    const before = room.peers.size
    expect(reg.removePeer(room, 'peer-x', 500)).toBeNull()
    expect(room.peers.size).toBe(before)
    expect(room.slotsInUse.has(1)).toBe(true)
  })
})

describe('RoomRegistry.reclaim', () => {
  it('returns the same playerId and a NEW slot, under the new peer id', () => {
    const reg = makeRegistry()
    const room = reg.createRoom(0)
    const a = reg.addPeer(room, 'peer-a', 'host', 0)
    seat(room, a, 0)
    const token = a.token
    const oldSlot = a.slot
    reg.removePeer(room, 'peer-a', 500)
    const back = reg.reclaim(room, token, 'peer-a2', 900)
    expect(back).not.toBeNull()
    expect(back?.playerId).toBe(0)
    expect(back?.peerId).toBe('peer-a2')
    expect(back?.connected).toBe(true)
    expect(back?.slot).not.toBe(oldSlot)
    expect(room.slotsInUse.has(back?.slot ?? -1)).toBe(true)
    expect(back?.liveness.lastSeenMs).toBe(900)
  })

  it('re-points the seat at the new peer, so the vanished one is no longer its owner', () => {
    const reg = makeRegistry()
    const room = reg.createRoom(0)
    const a = reg.addPeer(room, 'peer-a', 'host', 0)
    seat(room, a, 0)
    reg.removePeer(room, 'peer-a', 500)
    reg.reclaim(room, a.token, 'peer-a2', 900)
    expect(room.seats[0]).toBe('peer-a2')
    expect(room.peers.has('peer-a')).toBe(false)
    expect(room.peers.get('peer-a2')?.playerId).toBe(0)
  })

  it('returns null for an unknown token, and changes NOTHING', () => {
    const reg = makeRegistry()
    const room = reg.createRoom(0)
    const a = reg.addPeer(room, 'peer-a', 'host', 0)
    seat(room, a, 0)
    reg.removePeer(room, 'peer-a', 500)
    const slotsBefore = [...room.slotsInUse]
    expect(reg.reclaim(room, 'NOTAREALTOKEN', 'peer-x', 900)).toBeNull()
    expect(room.seats[0]).toBe('peer-a')
    expect(room.peers.has('peer-x')).toBe(false)
    expect(a.connected).toBe(false)
    expect([...room.slotsInUse]).toEqual(slotsBefore)
  })

  it('refuses a token whose owner is still CONNECTED, and changes nothing', () => {
    const reg = makeRegistry()
    const room = reg.createRoom(0)
    const a = reg.addPeer(room, 'peer-a', 'host', 0)
    seat(room, a, 0)
    expect(reg.reclaim(room, a.token, 'peer-thief', 900)).toBeNull()
    expect(room.seats[0]).toBe('peer-a')
    expect(room.peers.has('peer-thief')).toBe(false)
    expect(a.peerId).toBe('peer-a')
    expect(a.connected).toBe(true)
  })

  it('refuses an empty token, which every unwelcomed client sends', () => {
    const reg = makeRegistry()
    const room = reg.createRoom(0)
    const a = reg.addPeer(room, 'peer-a', 'host', 0)
    seat(room, a, 0)
    reg.removePeer(room, 'peer-a', 500)
    expect(reg.reclaim(room, '', 'peer-x', 900)).toBeNull()
    expect(room.seats[0]).toBe('peer-a')
  })

  it('refuses a token whose peer never held a seat', () => {
    const reg = makeRegistry()
    const room = reg.createRoom(0)
    const a = reg.addPeer(room, 'peer-a', 'guest', 0)
    const token = a.token
    reg.removePeer(room, 'peer-a', 500)
    expect(reg.reclaim(room, token, 'peer-a2', 900)).toBeNull()
  })
})

describe('RoomRegistry.touch and expire', () => {
  it('closes exactly the rooms idle at roomIdleMs, not at roomIdleMs - 1', () => {
    const reg = makeRegistry({ roomIdleMs: 1000 })
    const room = reg.createRoom(0)
    expect(reg.expire(999)).toEqual([])
    expect(room.phase).toBe('lobby')
    const closed = reg.expire(1000)
    expect(closed).toEqual([room])
    expect(room.phase).toBe('closed')
    expect(reg.size()).toBe(0)
    expect(reg.getRoom(room.code)).toBeNull()
  })

  it('touch resets the clock', () => {
    const reg = makeRegistry({ roomIdleMs: 1000 })
    const room = reg.createRoom(0)
    reg.touch(room, 900)
    expect(reg.expire(1500)).toEqual([])
    expect(reg.expire(1900)).toEqual([room])
  })

  it('expires only the idle rooms and leaves the rest listed', () => {
    const reg = makeRegistry({ roomIdleMs: 1000 })
    const stale = reg.createRoom(0)
    const busy = reg.createRoom(0)
    reg.touch(busy, 900)
    expect(reg.expire(1000)).toEqual([stale])
    expect(reg.rooms()).toEqual([busy])
    expect(reg.size()).toBe(1)
  })
})
