// PURE. All time and randomness enter through method arguments or options.
import { createLiveness } from '@tapkart/net'
import type { PeerRole } from '@tapkart/protocol'
import { MAX_KARTS } from '@tapkart/sim'
import type { RandomSource } from './random'
import { mintRoomCode, mintSessionToken } from './random'
import type { PeerId, PeerRecord, RoomRecord } from './types'

export const ROOM_CODE_MINT_ATTEMPTS = 8

export class RoomLimitError extends Error {}
export class RoomFullError extends Error {}
export class CodeCollisionError extends Error {}

export interface RegistryOptions {
  maxRooms: number
  maxPeersPerRoom: number
  roomIdleMs: number
  rand: RandomSource
}

const MIN_SLOT = 1
const MAX_SLOT = 254

export class RoomRegistry {
  private readonly opts: RegistryOptions
  private readonly byCode = new Map<string, RoomRecord>()

  constructor(opts: RegistryOptions) {
    this.opts = { ...opts }
  }

  createRoom(nowMs: number): RoomRecord {
    if (this.byCode.size >= this.opts.maxRooms) {
      throw new RoomLimitError(`room limit reached (${this.opts.maxRooms})`)
    }

    let code = ''
    for (let attempt = 0; attempt < ROOM_CODE_MINT_ATTEMPTS; attempt++) {
      const candidate = mintRoomCode(this.opts.rand)
      if (!this.byCode.has(candidate)) {
        code = candidate
        break
      }
    }
    if (code === '') {
      throw new CodeCollisionError(
        `could not mint a free room code in ${ROOM_CODE_MINT_ATTEMPTS} attempts`,
      )
    }

    const room: RoomRecord = {
      code,
      createdAtMs: nowMs,
      lastActivityMs: nowMs,
      phase: 'lobby',
      hostPeerId: null,
      hostPlayerId: -1,
      trackId: '',
      lobbyVersion: 0,
      raceSeed: 0,
      peers: new Map<PeerId, PeerRecord>(),
      slotsInUse: new Set<number>(),
      seats: new Array<PeerId | null>(MAX_KARTS).fill(null),
      rtcFailures: 0,
      race: null,
    }
    this.byCode.set(code, room)
    return room
  }

  /** The caller owns room-code normalization; lookup accepts canonical keys only. */
  getRoom(code: string): RoomRecord | null {
    return this.byCode.get(code) ?? null
  }

  addPeer(room: RoomRecord, peerId: PeerId, role: PeerRole, nowMs: number): PeerRecord {
    if (room.peers.has(peerId)) {
      throw new Error(`addPeer: ${peerId} is already in room ${room.code}`)
    }
    let connected = 0
    for (const peer of room.peers.values()) {
      if (peer.connected) connected++
    }
    if (connected >= this.opts.maxPeersPerRoom) {
      throw new RoomFullError(`room ${room.code} is full (${this.opts.maxPeersPerRoom})`)
    }

    const peer: PeerRecord = {
      peerId,
      slot: this.allocSlot(room, 0),
      playerId: -1,
      token: mintSessionToken(this.opts.rand),
      role,
      name: '',
      characterIdx: 0,
      ready: false,
      relay: false,
      connected: true,
      joinedAtMs: nowMs,
      lastSeenMs: nowMs,
      liveness: createLiveness(nowMs),
    }
    room.peers.set(peerId, peer)
    room.slotsInUse.add(peer.slot)
    return peer
  }

  removePeer(room: RoomRecord, peerId: PeerId, nowMs: number): PeerRecord | null {
    const peer = room.peers.get(peerId)
    if (peer === undefined) return null
    peer.connected = false
    peer.lastSeenMs = nowMs
    room.slotsInUse.delete(peer.slot)
    if (peer.playerId < 0) room.peers.delete(peerId)
    return peer
  }

  reclaim(room: RoomRecord, token: string, peerId: PeerId, nowMs: number): PeerRecord | null {
    if (token === '' || room.peers.has(peerId)) return null
    for (const peer of room.peers.values()) {
      if (peer.token !== token) continue
      if (peer.connected || peer.playerId < 0) return null

      const previousSlot = peer.slot
      room.peers.delete(peer.peerId)
      peer.peerId = peerId
      peer.slot = this.allocSlot(room, previousSlot)
      peer.connected = true
      peer.lastSeenMs = nowMs
      peer.liveness = createLiveness(nowMs)
      room.peers.set(peerId, peer)
      room.slotsInUse.add(peer.slot)
      room.seats[peer.playerId] = peerId
      return peer
    }
    return null
  }

  touch(room: RoomRecord, nowMs: number): void {
    room.lastActivityMs = nowMs
  }

  expire(nowMs: number): RoomRecord[] {
    const closed: RoomRecord[] = []
    for (const [code, room] of this.byCode) {
      if (nowMs - room.lastActivityMs < this.opts.roomIdleMs) continue
      room.phase = 'closed'
      this.byCode.delete(code)
      closed.push(room)
    }
    return closed
  }

  rooms(): RoomRecord[] {
    return [...this.byCode.values()]
  }

  size(): number {
    return this.byCode.size
  }

  private allocSlot(room: RoomRecord, after: number): number {
    for (let slot = Math.max(after + 1, MIN_SLOT); slot <= MAX_SLOT; slot++) {
      if (!room.slotsInUse.has(slot)) return slot
    }
    for (let slot = MIN_SLOT; slot <= after && slot <= MAX_SLOT; slot++) {
      if (!room.slotsInUse.has(slot)) return slot
    }
    throw new RoomFullError(`room ${room.code} has no free peer slot`)
  }
}
