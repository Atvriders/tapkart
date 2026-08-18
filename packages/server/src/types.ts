// PURE: type declarations only. Nothing in this file runs.
import type { LivenessState, ShadowLoop, TickAccumulator, Transport } from '@tapkart/net'
import type { PeerRole } from '@tapkart/protocol'
import type { SimContext, SimState } from '@tapkart/sim'
// Forward and type-only. Task 18 owns this module; do not duplicate its contract.
import type { RoomTransport } from './roomtransport'

export type PeerId = string

/** Lobby/server lifecycle, deliberately distinct from SimState.phase. */
export type ServerRoomPhase = 'lobby' | 'racing' | 'finished' | 'closed'

export interface PeerRecord {
  peerId: PeerId
  slot: number
  playerId: number
  token: string
  role: PeerRole
  name: string
  characterIdx: number
  ready: boolean
  relay: boolean
  connected: boolean
  joinedAtMs: number
  lastSeenMs: number
  liveness: LivenessState
}

export interface RoomRecord {
  code: string
  createdAtMs: number
  lastActivityMs: number
  phase: ServerRoomPhase
  /** The creator remains lobby owner; race promotion does not rewrite this. */
  hostPeerId: PeerId | null
  hostPlayerId: number
  trackId: string
  lobbyVersion: number
  raceSeed: number
  peers: Map<PeerId, PeerRecord>
  slotsInUse: Set<number>
  seats: (PeerId | null)[]
  rtcFailures: number
  race: RaceRuntime | null
}

export interface RaceRuntime {
  /** Fresh per race: ShadowLoop promotion mutates this context's leader flag. */
  ctx: SimContext
  state: SimState
  shadow: ShadowLoop
  transport: Transport
  room: RoomTransport
  acc: TickAccumulator
  lastPollMs: number
  startedAtMs: number
}
