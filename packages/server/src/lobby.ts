// PURE. Server-owned lobby bookkeeping; no simulation state, clock, socket, or minting.
import type { PeerAuthority } from '@tapkart/net'
import { promotionTickOf } from '@tapkart/net'
import type { LobbyMessage, StartMessage, WireLobbySlot } from '@tapkart/protocol'
import { MAX_KARTS } from '@tapkart/sim'
import type { PeerId, PeerRecord, RoomRecord } from './types'

/** Assign the lowest free seat, preserving a reconnecting peer's prior seat. */
export function assignSeat(room: RoomRecord, peer: PeerRecord): number {
  const held = seatOf(room, peer.peerId)
  if (held >= 0) {
    peer.playerId = held
    if (isHost(room, peer)) room.hostPlayerId = held
    return held
  }

  const prior = peer.playerId
  if (prior >= 0 && prior < MAX_KARTS) {
    const holder = room.seats[prior]
    if (holder === null || !room.peers.has(holder)) {
      room.seats[prior] = peer.peerId
      peer.playerId = prior
      if (isHost(room, peer)) room.hostPlayerId = prior
      return prior
    }
  }

  for (let index = 0; index < MAX_KARTS; index++) {
    if (room.seats[index] !== null) continue
    room.seats[index] = peer.peerId
    peer.playerId = index
    if (isHost(room, peer)) room.hostPlayerId = index
    return index
  }
  return -1
}

export function releaseSeat(room: RoomRecord, peer: PeerRecord): void {
  const seat = seatOf(room, peer.peerId)
  if (seat < 0) {
    peer.playerId = -1
    return
  }
  room.seats[seat] = null
  peer.playerId = -1
  if (room.hostPlayerId === seat) room.hostPlayerId = -1
}

export function seatOf(room: RoomRecord, peerId: PeerId): number {
  for (let index = 0; index < MAX_KARTS; index++) {
    if (room.seats[index] === peerId) return index
  }
  return -1
}

export function bumpLobbyVersion(room: RoomRecord): number {
  room.lobbyVersion++
  return room.lobbyVersion
}

export function buildLobbyMessage(room: RoomRecord): LobbyMessage {
  const slots: WireLobbySlot[] = []
  for (let index = 0; index < MAX_KARTS; index++) {
    const peerId = room.seats[index]
    const peer = peerId === null ? undefined : room.peers.get(peerId)
    if (peer === undefined) {
      slots.push({
        occupied: false,
        isBot: true,
        connected: false,
        ready: false,
        characterIdx: 0,
        peerSlot: 0,
        name: '',
      })
      continue
    }
    slots.push({
      occupied: true,
      isBot: false,
      connected: peer.connected,
      ready: peer.ready,
      characterIdx: peer.characterIdx,
      peerSlot: peer.slot,
      name: peer.name,
    })
  }
  return {
    lobbyVersion: room.lobbyVersion,
    hostPlayerId: room.hostPlayerId,
    trackId: room.trackId,
    slots,
  }
}

export function buildStartMessage(room: RoomRecord, seed: number): StartMessage {
  return {
    raceSeed: seed >>> 0,
    trackId: room.trackId,
    humanMask: humanMaskOf(room),
    characterIdx: characterIdxOf(room),
  }
}

export function humanMaskOf(room: RoomRecord): number {
  let mask = 0
  for (let index = 0; index < MAX_KARTS; index++) {
    const peerId = room.seats[index]
    if (peerId === null) continue
    const peer = room.peers.get(peerId)
    if (peer !== undefined && peer.connected) mask |= 1 << index
  }
  return mask
}

export function characterIdxOf(room: RoomRecord): number[] {
  const characters: number[] = []
  for (let index = 0; index < MAX_KARTS; index++) {
    const peerId = room.seats[index]
    const peer = peerId === null ? undefined : room.peers.get(peerId)
    characters.push(peer?.characterIdx ?? 0)
  }
  return characters
}

/** Live seat/authority view consulted for every inbound datagram. */
export function seatMapOf(room: RoomRecord): PeerAuthority {
  return {
    playerIdOf(peerId: string): number {
      return seatOf(room, peerId)
    },
    isAuthority(peerId: string): boolean {
      if (room.hostPeerId === null || peerId !== room.hostPeerId) return false
      const race = room.race
      return race === null || promotionTickOf(race.shadow) < 0
    },
  }
}

export function isHost(room: RoomRecord, peer: PeerRecord): boolean {
  return room.hostPeerId !== null && room.hostPeerId === peer.peerId
}

export function canStart(room: RoomRecord, peer: PeerRecord): boolean {
  if (!isHost(room, peer)) return false
  if (room.phase !== 'lobby' && room.phase !== 'finished') return false
  if (room.race !== null) return false
  return seatOf(room, peer.peerId) >= 0
}
