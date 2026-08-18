// PURE (over injected sockets, registry and a clock parameter). No `node:*`, no
// `ws`, no Date.now(): every function here takes `nowMs`.
import type {
  ChannelName,
  ClientUpdateMessage,
  HeartbeatMessage,
  HelloMessage,
  JoinResult,
  MessageKind,
  ResyncReason,
  StartMessage,
  WelcomeMessage,
} from '@tapkart/protocol'
import {
  CLIENT_FLAG_READY, CLIENT_FLAG_RTC_CONNECTED, CLIENT_FLAG_RTC_FAILED,
  CLIENT_FLAG_START_REQUEST,
  PROTOCOL_VERSION, WIRE_TAG,
  SERVER_FLAG_CHECKPOINT_NEXT, SERVER_FLAG_IS_HOST, SERVER_FLAG_RACE_IN_PROGRESS,
  SERVER_FLAG_RELAY_ASSIGNED, SERVER_FLAG_RELAY_FIRST,
  decodeClientUpdate, decodeHeartbeat, decodeHello, decodeResyncRequest,
  encodeCheckpoint, encodeHeader, encodeHeartbeat, encodeLobby, encodeStart, encodeWelcome,
  isValidRoomCode, isValidSessionToken, normalizeRoomCode,
} from '@tapkart/protocol'
import { TICK_HZ } from '@tapkart/sim'
import type { SocketData, SocketLike, WsFrame } from '@tapkart/net'
import {
  AUTHORITY_CHANGE_BYTES,
  HARD_RESYNC_WINDOW_TICKS,
  PEER_STALE_MS,
  WS_CLOSE_ROOM_CLOSED,
  WS_CLOSE_VERSION_MISMATCH,
  WS_CONTROL_PEER_GONE,
  WS_CONTROL_PEER_JOINED,
  WS_FRAME_DATA,
  WS_HEADER_BYTES,
  WS_SLOT_BROADCAST,
  WS_SLOT_SERVER,
  createLiveness,
  decodeWsFrame,
  encodeAuthorityChange,
  encodeSignal,
  encodeWsControl,
  encodeWsData,
  isStale,
  notePacket,
  notePingSent,
  notePong,
  parseSignal,
  promotionTickOf,
  shouldSendPing,
} from '@tapkart/net'
import type { PeerId, PeerRecord, RaceRuntime, RoomRecord } from './types'
import type { ServerConfig } from './env'
import type { RandomSource } from './random'
import { CodeCollisionError, RoomFullError, RoomLimitError, RoomRegistry } from './registry'
import {
  assignSeat, buildLobbyMessage, buildStartMessage, bumpLobbyVersion, canStart, isHost,
} from './lobby'
import type { ContentProvider } from './content'
import type { LogEvent, LogSink } from './log'
import type { RateLimiter } from './ratelimit'
import { makeRoomTransport } from './roomtransport'
import { endRace, pollRace, startRace, stepRace } from './race'
import { mintRaceSeed } from './random'

export const CHECKPOINT_BUF_BYTES = 8192   // >= every shipped shape; checkpoint-budget.test.ts
export const LOBBY_BUF_BYTES = 256         // >= LOBBY_MAX_BYTES 177 + 2 header

/**
 * F-P4-39. After this many consecutive guests fail to reach the host directly,
 * the room goes relay-first: further guests attach over the relay IMMEDIATELY
 * and attempt WebRTC in the background, upgrading if it succeeds. Joins stay
 * fast for everyone behind a symmetric NAT, and a transient failure does not
 * condemn the room to relaying for its whole life.
 */
export const RELAY_FIRST_AFTER_FAILURES = 2

export interface HubDeps {
  config: ServerConfig
  registry: RoomRegistry
  content: ContentProvider
  rand: RandomSource
  log: LogSink
  /** F-P4-34: keyed by ROOM CODE, never by anything derived from an address. */
  failedJoins: RateLimiter
}

/** Pure. Whether the server must relay between these two at all. */
export function shouldRelay(room: RoomRecord, from: PeerRecord, to: PeerRecord): boolean {
  if (to.peerId === from.peerId) return false
  if (!to.connected) return false
  if (room.hostPeerId === null) return false
  if (room.hostPeerId === from.peerId) return to.relay      // host -> relay guests only
  if (room.hostPeerId === to.peerId) return from.relay      // relay guest -> the host only
  return false                                              // guest -> guest, never
}

/**
 * Pure. Every peer that must receive a datagram that arrived from `from`.
 * Everything a room does with a datagram is decided here.
 *
 * A direct guest's broadcast reaches nobody on purpose: its race traffic rode
 * its WebRTC link and the host already has it. Relaying it as well would deliver
 * every input datagram twice.
 */
export function routeDatagram(room: RoomRecord, from: PeerRecord, frame: WsFrame): PeerRecord[] {
  if (frame.frameKind !== WS_FRAME_DATA) return []
  if (frame.peerSlot === WS_SLOT_SERVER) return []          // addressed to the room itself

  if (frame.peerSlot === WS_SLOT_BROADCAST) {
    const out: PeerRecord[] = []
    for (const peer of room.peers.values()) {
      if (shouldRelay(room, from, peer)) out.push(peer)
    }
    return out
  }

  for (const peer of room.peers.values()) {
    if (peer.slot !== frame.peerSlot) continue
    if (peer.peerId === from.peerId) return []
    if (!peer.connected) return []
    return [peer]
  }
  return []
}

function reject(
  deps: HubDeps, peer: PeerRecord, code: string, result: JoinResult, nowMs: number,
): WelcomeMessage {
  deps.log.write({ kind: 'rejected', code, result }, nowMs)
  return {
    result, roomCode: code, playerId: -1, token: '',
    hostPlayerId: -1, peerSlot: peer.slot, flags: 0, lobbyVersion: 0,
  }
}

/**
 * Exported for tests and for one reason more important than tests: it is the
 * entire join policy, and a policy that lives inside a socket callback cannot be
 * asserted. Returns the WelcomeMessage the caller will send; mutates the room
 * through the registry and lobby modules only.
 *
 * `peer` is the SOCKET's provisional record. On `ok` the authoritative record is
 * `room.peers.get(peer.peerId)` -- `RoomRegistry.addPeer` is the sole assigner
 * of slots and it creates the record -- and the caller adopts it. Nothing here
 * writes to `peer`.
 */
export function handleHello(
  deps: HubDeps, room: RoomRecord | null, peer: PeerRecord,
  msg: HelloMessage, nowMs: number,
): WelcomeMessage {
  const code = normalizeRoomCode(msg.roomCode)

  // F-P4-34: the budget is checked BEFORE the room is consulted, and the key is
  // the room code. A room CREATION carries no code and is not limited: keying it
  // on '' would put every creation on the server into one bucket.
  if (code !== '' && !deps.failedJoins.allowed(code, nowMs)) {
    return reject(deps, peer, code, 'rateLimited', nowMs)
  }

  if (msg.role === 'host' && code === '') {
    let created: RoomRecord
    try {
      created = deps.registry.createRoom(nowMs)
    } catch (err) {
      if (err instanceof RoomLimitError || err instanceof CodeCollisionError) {
        return reject(deps, peer, code, 'roomFull', nowMs)
      }
      throw err
    }
    created.hostPeerId = peer.peerId
    deps.log.write({ kind: 'roomCreated', code: created.code }, nowMs)
    return admit(deps, created, peer, msg, nowMs)
  }

  if (!isValidRoomCode(code)) return reject(deps, peer, code, 'badRequest', nowMs)
  if (room === null || room.code !== code) {
    deps.failedJoins.note(code, nowMs)
    return reject(deps, peer, code, 'roomNotFound', nowMs)
  }
  if (room.phase === 'closed') {
    deps.failedJoins.note(code, nowMs)
    return reject(deps, peer, code, 'roomClosed', nowMs)
  }
  return admit(deps, room, peer, msg, nowMs)
}

function admit(
  deps: HubDeps, room: RoomRecord, peer: PeerRecord, msg: HelloMessage, nowMs: number,
): WelcomeMessage {
  let seated: PeerRecord | null = null
  let reclaimed = false

  // A token that matches a seat whose peer has gone revives THAT seat, so a
  // reconnecting player does not consume a second one. The token is kept, not
  // rotated: it is the client's only way back, and a client that fails to
  // persist a rotation locks itself out of the seat it is sitting in. Nothing
  // here mints -- `RoomRegistry.addPeer` is the sole minter of session tokens.
  if (msg.token !== '' && isValidSessionToken(msg.token)) {
    const revived = deps.registry.reclaim(room, msg.token, peer.peerId, nowMs)
    if (revived !== null) {
      seated = revived
      reclaimed = true
      // §5.1: the lobby owner is the peer who CREATED the room, and it survives
      // a reconnect. Without this the room's host pointer names a dead socket.
      if (revived.playerId >= 0 && revived.playerId === room.hostPlayerId) {
        room.hostPeerId = revived.peerId
      }
      deps.log.write({ kind: 'peerReclaimed', code: room.code, playerId: revived.playerId }, nowMs)
    }
  }

  if (seated === null) {
    try {
      seated = deps.registry.addPeer(room, peer.peerId, msg.role, nowMs)
    } catch (err) {
      if (err instanceof RoomFullError) return reject(deps, peer, room.code, 'roomFull', nowMs)
      throw err
    }
  }

  // `reclaim` already re-points `room.seats[playerId]`; this is idempotent for
  // that path and is what seats a fresh peer.
  if (assignSeat(room, seated) < 0) {
    // Spec §1 caps the grid at 8. No spectators, no queue.
    // addPeer already installed this fresh, still-unseated record and reserved
    // its transport slot. Roll both back so reconnectable seats cannot fill a
    // room with rejected-but-connected ghosts.
    deps.registry.removePeer(room, seated.peerId, nowMs)
    return reject(deps, peer, room.code, 'roomFull', nowMs)
  }
  if (!reclaimed) {
    deps.log.write({ kind: 'peerJoined', code: room.code, playerId: seated.playerId, relay: seated.relay }, nowMs)
  }

  // A reconnect token restores the seat's server-owned authority. The role in
  // a new hello is only a creation/join request and cannot demote the creator
  // or promote an ordinary guest.
  seated.role = isHost(room, seated) ? 'host' : 'guest'
  seated.name = msg.name
  seated.characterIdx = msg.characterIdx & 0x0f
  seated.connected = true
  seated.lastSeenMs = nowMs

  // The host is the only peer whose track opinion is honoured (F-P4-31).
  if (isHost(room, seated) && msg.trackId !== '' && deps.content.track(msg.trackId) !== null) {
    room.trackId = msg.trackId
  }
  if (room.trackId === '' || deps.content.track(room.trackId) === null) {
    const first = deps.content.trackIds()[0]
    room.trackId = first === undefined ? '' : first
  }

  let flags = 0
  if (isHost(room, seated)) flags |= SERVER_FLAG_IS_HOST
  if (room.phase === 'racing' && room.race !== null) {
    // §6.5: `start` first so the client can call beginRace -- which is what makes
    // its itemBoxes array the right length -- then a checkpoint from the SHADOW's
    // state. The caller sends both, in that order.
    flags |= SERVER_FLAG_RACE_IN_PROGRESS | SERVER_FLAG_CHECKPOINT_NEXT
  }
  if (room.rtcFailures >= RELAY_FIRST_AFTER_FAILURES) {
    seated.relay = true
    flags |= SERVER_FLAG_RELAY_FIRST
    deps.log.write({ kind: 'relayFirst', code: room.code, failures: room.rtcFailures }, nowMs)
  }
  if (seated.relay) flags |= SERVER_FLAG_RELAY_ASSIGNED

  const lobbyVersion = bumpLobbyVersion(room)
  deps.registry.touch(room, nowMs)

  return {
    result: 'ok',
    roomCode: room.code,
    playerId: seated.playerId,
    token: seated.token,
    hostPlayerId: room.hostPlayerId,
    peerSlot: seated.slot,
    flags,
    lobbyVersion,
  }
}

/**
 * The lobby half, separated by F-P4-11 so no handler distinguishes intent by
 * field inspection. Returns true when the room changed and a `lobby` broadcast
 * is owed.
 *
 * CLIENT_FLAG_START_REQUEST is not read here at all: starting a race needs a
 * transport and a SimContext, which is the caller's, and it is gated by
 * `canStart` -- the one answer to "may this peer do that" -- rather than by a
 * second copy of the rule.
 */
export function handleClientUpdate(
  deps: HubDeps, room: RoomRecord, peer: PeerRecord,
  msg: ClientUpdateMessage, nowMs: number,
): boolean {
  let changed = false

  if (msg.name !== peer.name) {
    peer.name = msg.name
    changed = true
  }
  const characterIdx = msg.characterIdx & 0x0f
  if (characterIdx !== peer.characterIdx) {
    peer.characterIdx = characterIdx
    changed = true
  }
  const ready = (msg.flags & CLIENT_FLAG_READY) !== 0
  if (ready !== peer.ready) {
    peer.ready = ready
    changed = true
  }
  if (
    msg.trackId !== '' && msg.trackId !== room.trackId &&
    isHost(room, peer) && deps.content.track(msg.trackId) !== null
  ) {
    room.trackId = msg.trackId
    changed = true
  }

  // Sole writer of `rtcFailures` (§7).
  const failed = (msg.flags & CLIENT_FLAG_RTC_FAILED) !== 0
  const connected = (msg.flags & CLIENT_FLAG_RTC_CONNECTED) !== 0
  const guest = !isHost(room, peer)
  if (guest && connected) {
    // Explicit success replaces the old time-based inference. In particular a
    // relay-first peer starts with relay=true, so it could never satisfy the
    // inference's !peer.relay condition and could never upgrade in the field.
    if (peer.relay) {
      peer.relay = false
      changed = true
    }
    if (room.rtcFailures > 0) {
      room.rtcFailures = 0
      changed = true
    }
  } else if (guest && failed && !peer.relay) {
    peer.relay = true
    room.rtcFailures += 1
    changed = true
    if (room.rtcFailures === RELAY_FIRST_AFTER_FAILURES) {
      deps.log.write({ kind: 'relayFirst', code: room.code, failures: room.rtcFailures }, nowMs)
    }
  }

  peer.lastSeenMs = nowMs
  if (changed) {
    bumpLobbyVersion(room)
    deps.registry.touch(room, nowMs)
  }
  return changed
}

export interface PeerHandle {
  peerId: PeerId
  roomCode(): string | null
  detach(nowMs: number): void
}

interface AttachedPeer {
  peerId: PeerId
  socket: SocketLike
  room: RoomRecord | null
  /** Provisional until hello succeeds; the registry-owned record thereafter. */
  record: PeerRecord
  detached: boolean
  lastCheckpointMs: number
}

const HUB_TAGS: ReadonlySet<number> = new Set<number>([
  WIRE_TAG.hello,
  WIRE_TAG.clientUpdate,
  WIRE_TAG.resyncRequest,
  WIRE_TAG.ping,
  WIRE_TAG.pong,
])

const CHECKPOINT_MIN_INTERVAL_MS = HARD_RESYNC_WINDOW_TICKS * (1000 / TICK_HZ)
const WELCOME_BUF_BYTES = 32
const START_BUF_BYTES = 64
const HEARTBEAT_BUF_BYTES = 16

export class RoomHub {
  private readonly deps: HubDeps
  private readonly attached = new Map<PeerId, AttachedPeer>()
  private readonly roomLogs = new Map<string, LogSink>()
  private readonly welcomeBuf = new Uint8Array(WELCOME_BUF_BYTES)
  private readonly lobbyBuf = new Uint8Array(LOBBY_BUF_BYTES)
  private readonly startBuf = new Uint8Array(START_BUF_BYTES)
  private readonly authorityBuf = new Uint8Array(AUTHORITY_CHANGE_BYTES)
  private readonly checkpointBuf = new Uint8Array(CHECKPOINT_BUF_BYTES)
  private readonly heartbeatBuf = new Uint8Array(HEARTBEAT_BUF_BYTES)
  private nextPeerSeq = 1
  private nowMs = 0
  private closed = false

  constructor(deps: HubDeps) {
    this.deps = deps
  }

  /** Attach a socket and wait for its hello. This is the sole PeerId creator. */
  attach(socket: SocketLike, nowMs: number): PeerHandle {
    this.nowMs = Math.max(this.nowMs, nowMs)
    const peerId = 'peer' + String(this.nextPeerSeq)
    this.nextPeerSeq += 1

    // A closed hub must not retain a socket that no scheduler can ever poll or
    // close. Return a harmless detached handle so callers keep one total API.
    if (this.closed) {
      socket.close(WS_CLOSE_ROOM_CLOSED)
      return {
        peerId,
        roomCode: (): null => null,
        detach: (): void => { /* already detached */ },
      }
    }

    const att: AttachedPeer = {
      peerId,
      socket,
      room: null,
      record: {
        peerId, slot: 0, playerId: -1, token: '', role: 'guest', name: '',
        characterIdx: 0, ready: false, relay: false, connected: true,
        joinedAtMs: nowMs, lastSeenMs: nowMs, liveness: createLiveness(nowMs),
      },
      detached: false,
      lastCheckpointMs: Number.NEGATIVE_INFINITY,
    }
    this.attached.set(peerId, att)

    socket.onMessage((data: SocketData) => { this.onData(att, data) })
    socket.onClose(() => { this.detach(att, this.nowMs) })

    return {
      peerId,
      roomCode: (): string | null => (att.room === null ? null : att.room.code),
      detach: (time: number): void => {
        this.nowMs = Math.max(this.nowMs, time)
        this.detach(att, this.nowMs)
      },
    }
  }

  /** The one per-process heartbeat, called by exactly one scheduler. */
  poll(nowMs: number): void {
    if (this.closed) return
    this.nowMs = Math.max(this.nowMs, nowMs)
    const now = this.nowMs

    for (const room of this.deps.registry.rooms()) {
      const run = room.race
      if (run !== null) {
        stepRace(run, now)
        pollRace(run, this.roomLog(room.code), now)

        if (run.state.phase === 'finished' && room.phase === 'racing') {
          endRace(run)
          room.race = null
          room.phase = 'finished'
          bumpLobbyVersion(room)
          this.broadcastLobby(room)
        }
      }

      for (const peer of [...room.peers.values()]) {
        const att = this.attached.get(peer.peerId)
        if (att === undefined || att.detached) continue
        if (isStale(peer.liveness, now)) {
          this.detach(att, now)
          continue
        }
        if (shouldSendPing(peer.liveness, now)) {
          // lastPingSeq is cleared by an accepted pong, so it cannot be a
          // sequence cursor. pingsSent is monotonic and wraps naturally on wire.
          const seq = peer.liveness.pingsSent & 0xffff
          this.sendKind(
            att,
            'ping',
            'unreliable',
            this.heartbeatBuf,
            (out) => encodeHeartbeat(out, { seq, echoMs: now }),
          )
          notePingSent(peer.liveness, seq, now)
        }
      }
    }

    // Provisional and rejected peers are absent from every RoomRecord, so the
    // room loop above cannot collect them. This is an absolute hello deadline:
    // hostile pre-auth traffic must not extend an unauthenticated allocation.
    for (const att of [...this.attached.values()]) {
      if (att.room !== null || att.detached) continue
      if (now - att.record.joinedAtMs >= PEER_STALE_MS) this.detach(att, now)
    }

    for (const room of this.deps.registry.expire(now)) {
      this.deps.log.write({ kind: 'roomExpired', code: room.code, ageMs: now - room.createdAtMs }, now)
      if (room.race !== null) {
        endRace(room.race)
        room.race = null
      }
      this.roomLogs.delete(room.code)
      for (const peer of [...room.peers.values()]) {
        const att = this.attached.get(peer.peerId)
        if (att === undefined) continue
        att.detached = true
        this.attached.delete(att.peerId)
        att.socket.close(WS_CLOSE_ROOM_CLOSED)
      }
    }
  }

  registry(): RoomRegistry {
    return this.deps.registry
  }

  /** Close sockets and shadows without making an authority decision. */
  close(): void {
    if (this.closed) return
    this.closed = true
    for (const att of [...this.attached.values()]) {
      att.detached = true
      att.socket.close(WS_CLOSE_ROOM_CLOSED)
    }
    this.attached.clear()
    for (const room of this.deps.registry.rooms()) {
      if (room.race === null) continue
      endRace(room.race)
      room.race = null
    }
    this.roomLogs.clear()
  }

  private onData(att: AttachedPeer, data: SocketData): void {
    if (this.closed || att.detached) return
    if (typeof data === 'string') this.onText(att, data)
    else this.onBinary(att, data)
  }

  private onBinary(att: AttachedPeer, data: Uint8Array): void {
    const nowMs = this.nowMs
    const frame = decodeWsFrame(data)
    if (frame === null) {
      this.badFrame(att, 'wsFrame', nowMs)
      return
    }
    if (frame.frameKind !== WS_FRAME_DATA || frame.channel === null) {
      this.badFrame(att, 'controlFrame', nowMs)
      return
    }
    const payload = frame.payload
    if (payload.length < 2) {
      this.badFrame(att, 'shortMessage', nowMs)
      return
    }

    // The hello version byte is checked before a decoder/guard because only a
    // close code can cross an incompatible protocol boundary.
    if (payload[0] === WIRE_TAG.hello && payload[1] !== PROTOCOL_VERSION) {
      this.deps.log.write(
        { kind: 'rejected', code: att.room === null ? '' : att.room.code, result: 'versionMismatch' },
        nowMs,
      )
      att.socket.close(WS_CLOSE_VERSION_MISMATCH)
      this.detach(att, nowMs)
      return
    }

    notePacket(att.record.liveness, nowMs)
    att.record.lastSeenMs = nowMs

    if (frame.peerSlot === WS_SLOT_SERVER && HUB_TAGS.has(payload[0])) {
      this.onRoomMessage(att, payload[0], payload.subarray(2), nowMs)
      return
    }

    const room = att.room
    if (room === null) {
      this.badFrame(att, 'notInRoom', nowMs)
      return
    }
    for (const to of routeDatagram(room, att.record, frame)) {
      this.forward(to, frame.channel, att.record.slot, payload)
    }
    room.race?.room.deliver(att.peerId, frame.channel, payload)
    this.deps.registry.touch(room, nowMs)
  }

  private onRoomMessage(att: AttachedPeer, tag: number, body: Uint8Array, nowMs: number): void {
    switch (tag) {
      case WIRE_TAG.hello: return this.onHello(att, body, nowMs)
      case WIRE_TAG.clientUpdate: return this.onClientUpdate(att, body, nowMs)
      case WIRE_TAG.resyncRequest: return this.onResyncRequest(att, body, nowMs)
      case WIRE_TAG.ping: return this.onPing(att, body, nowMs)
      case WIRE_TAG.pong: return this.onPong(att, body, nowMs)
      default: return
    }
  }

  private onHello(att: AttachedPeer, body: Uint8Array, nowMs: number): void {
    if (att.room !== null) {
      this.badFrame(att, 'duplicateHello', nowMs)
      return
    }
    let msg
    try {
      msg = decodeHello(body)
    } catch {
      this.badFrame(att, 'hello', nowMs)
      return
    }

    const code = normalizeRoomCode(msg.roomCode)
    const found = code === '' ? null : this.deps.registry.getRoom(code)
    const welcome = handleHello(this.deps, found, att.record, msg, nowMs)
    this.sendKind(att, 'welcome', 'reliable', this.welcomeBuf, (out) => encodeWelcome(out, welcome))
    if (welcome.result !== 'ok') return

    const room = this.deps.registry.getRoom(welcome.roomCode)
    if (room === null) return
    att.room = room
    const seated = room.peers.get(att.peerId)
    if (seated !== undefined) att.record = seated

    // WebSocketTransport learns slots only through control frames. Tell both
    // sides of every new relationship before lobby/race traffic can name it.
    for (const peer of room.peers.values()) {
      if (peer.peerId === att.peerId || !peer.connected) continue
      const other = this.attached.get(peer.peerId)
      if (other === undefined || other.detached) continue
      this.sendControl(other, WS_CONTROL_PEER_JOINED, att.record.slot)
      this.sendControl(att, WS_CONTROL_PEER_JOINED, peer.slot)
    }

    this.broadcastLobby(room)

    const run = room.race
    if ((welcome.flags & SERVER_FLAG_RACE_IN_PROGRESS) !== 0 && run !== null) {
      this.sendKind(
        att,
        'start',
        'reliable',
        this.startBuf,
        (out) => encodeStart(out, buildStartMessage(room, room.raceSeed)),
      )
      const promotionTick = promotionTickOf(run.shadow)
      if (promotionTick < 0 && (welcome.flags & SERVER_FLAG_IS_HOST) !== 0) {
        // A reloaded creator has no prior AuthorityLoop state to resume. Hand
        // authority to the already-current shadow before its checkpoint, even
        // when the normal host-loss timeout has not elapsed yet.
        run.shadow.promote(run.state.tick)
      } else if (promotionTick >= 0) {
        const n = encodeAuthorityChange(
          this.authorityBuf,
          promotionTick,
          run.state.nextEventSeq,
        )
        this.sendBody(att, 'reliable', this.authorityBuf.subarray(0, n))
      }
      this.sendCheckpoint(att, room, run, 'lateJoin', nowMs)
    }
  }

  private onClientUpdate(att: AttachedPeer, body: Uint8Array, nowMs: number): void {
    const room = att.room
    if (room === null) {
      this.badFrame(att, 'notInRoom', nowMs)
      return
    }
    let msg
    try {
      msg = decodeClientUpdate(body)
    } catch {
      this.badFrame(att, 'clientUpdate', nowMs)
      return
    }

    if (handleClientUpdate(this.deps, room, att.record, msg, nowMs)) this.broadcastLobby(room)
    if ((msg.flags & CLIENT_FLAG_START_REQUEST) !== 0 && canStart(room, att.record)) {
      this.startRoomRace(room, nowMs)
    }
  }

  private onResyncRequest(att: AttachedPeer, body: Uint8Array, nowMs: number): void {
    const room = att.room
    const run = room === null ? null : room.race
    if (room === null || run === null) return
    let msg
    try {
      msg = decodeResyncRequest(body)
    } catch {
      this.badFrame(att, 'resyncRequest', nowMs)
      return
    }
    if (nowMs - att.lastCheckpointMs < CHECKPOINT_MIN_INTERVAL_MS) return
    this.sendCheckpoint(att, room, run, msg.reason, nowMs)
  }

  private onPing(att: AttachedPeer, body: Uint8Array, nowMs: number): void {
    let msg: HeartbeatMessage
    try {
      msg = decodeHeartbeat(body)
    } catch {
      this.badFrame(att, 'ping', nowMs)
      return
    }
    this.sendKind(
      att,
      'pong',
      'unreliable',
      this.heartbeatBuf,
      (out) => encodeHeartbeat(out, msg),
    )
  }

  private onPong(att: AttachedPeer, body: Uint8Array, nowMs: number): void {
    try {
      notePong(att.record.liveness, decodeHeartbeat(body), nowMs)
    } catch {
      this.badFrame(att, 'pong', nowMs)
    }
  }

  private onText(att: AttachedPeer, text: string): void {
    const env = parseSignal(text)
    if (env === null) {
      this.badFrame(att, 'signal', this.nowMs)
      return
    }

    // Text signalling is as much proof of life as a binary datagram.
    notePacket(att.record.liveness, this.nowMs)
    att.record.lastSeenMs = this.nowMs

    const room = att.room
    if (room === null) return
    for (const peer of room.peers.values()) {
      if (peer.slot !== env.to || !peer.connected) continue
      const dest = this.attached.get(peer.peerId)
      if (dest === undefined || dest.detached) return
      dest.socket.send(encodeSignal({
        v: env.v,
        from: att.record.slot,
        to: env.to,
        msg: env.msg,
      }))
      return
    }
  }

  private startRoomRace(room: RoomRecord, nowMs: number): void {
    if (room.race !== null) return
    const ctx = this.deps.content.contextFor(room.trackId)
    if (ctx === null) {
      this.deps.log.write({ kind: 'rejected', code: room.code, result: 'badRequest' }, nowMs)
      return
    }
    if (room.phase === 'finished') room.phase = 'lobby'
    room.raceSeed = mintRaceSeed(this.deps.rand)

    const start: StartMessage = buildStartMessage(room, room.raceSeed)
    for (const peer of room.peers.values()) {
      const att = this.attached.get(peer.peerId)
      if (att === undefined || att.detached || !peer.connected) continue
      this.sendKind(att, 'start', 'reliable', this.startBuf, (out) => encodeStart(out, start))
    }

    if (this.deps.config.shadowEnabled) {
      const transport = makeRoomTransport({
        room,
        sendFrame: (peer, frame) => { this.sendFrame(peer, frame) },
      })
      room.race = startRace({
        room,
        ctx,
        seed: room.raceSeed,
        characterIdx: start.characterIdx,
        humanMask: start.humanMask,
        transport,
        nowMs,
      })
    }

    room.phase = 'racing'
    bumpLobbyVersion(room)
    this.deps.log.write(
      { kind: 'raceStarted', code: room.code, seed: room.raceSeed, trackId: room.trackId },
      nowMs,
    )
  }

  private detach(att: AttachedPeer, nowMs: number): void {
    if (att.detached) return
    att.detached = true
    this.attached.delete(att.peerId)
    att.socket.close()

    const room = att.room
    if (room === null) return
    // Registry is the sole writer of peers/slotsInUse. It retains a seated record
    // for token reclaim while freeing the old transport slot.
    const record = this.deps.registry.removePeer(room, att.peerId, nowMs)
    room.race?.room.notePeerGone(att.peerId)

    if (record !== null) {
      for (const peer of room.peers.values()) {
        if (!peer.connected) continue
        const other = this.attached.get(peer.peerId)
        if (other === undefined || other.detached) continue
        this.sendControl(other, WS_CONTROL_PEER_GONE, record.slot)
      }
    }

    this.deps.log.write(
      { kind: 'peerLeft', code: room.code, playerId: record === null ? -1 : record.playerId },
      nowMs,
    )
    bumpLobbyVersion(room)
    this.broadcastLobby(room)
  }

  private broadcastLobby(room: RoomRecord): void {
    const msg = buildLobbyMessage(room)
    for (const peer of room.peers.values()) {
      const att = this.attached.get(peer.peerId)
      if (att === undefined || att.detached || !peer.connected) continue
      this.sendKind(att, 'lobby', 'reliable', this.lobbyBuf, (out) => encodeLobby(out, msg))
    }
  }

  private sendCheckpoint(
    att: AttachedPeer,
    room: RoomRecord,
    run: RaceRuntime,
    reason: ResyncReason,
    nowMs: number,
  ): void {
    att.lastCheckpointMs = nowMs
    this.sendKind(
      att,
      'checkpoint',
      'reliable',
      this.checkpointBuf,
      (out) => encodeCheckpoint(out, run.state),
    )
    this.deps.log.write(
      { kind: 'checkpointSent', code: room.code, playerId: att.record.playerId, reason },
      nowMs,
    )
  }

  private sendKind(
    att: AttachedPeer,
    kind: MessageKind,
    channel: ChannelName,
    buf: Uint8Array,
    encode: (out: Uint8Array) => number,
  ): void {
    const head = encodeHeader(buf, kind)
    const n = encode(buf.subarray(head))
    this.sendBody(att, channel, buf.subarray(0, head + n))
  }

  private sendBody(att: AttachedPeer, channel: ChannelName, body: Uint8Array): void {
    if (att.detached) return
    const out = new Uint8Array(WS_HEADER_BYTES + body.length)
    encodeWsData(out, channel, WS_SLOT_SERVER, body)
    att.socket.send(out)
  }

  private sendControl(att: AttachedPeer, op: number, peerSlot: number): void {
    if (att.detached) return
    const out = new Uint8Array(WS_HEADER_BYTES)
    encodeWsControl(out, op, peerSlot)
    att.socket.send(out)
  }

  private sendFrame(peer: PeerRecord, frame: Uint8Array): void {
    const att = this.attached.get(peer.peerId)
    if (att === undefined || att.detached) return
    att.socket.send(frame)
  }

  private forward(
    to: PeerRecord, channel: ChannelName, fromSlot: number, payload: Uint8Array,
  ): void {
    const att = this.attached.get(to.peerId)
    if (att === undefined || att.detached) return
    const out = new Uint8Array(WS_HEADER_BYTES + payload.length)
    encodeWsData(out, channel, fromSlot, payload)
    att.socket.send(out)
  }

  private badFrame(att: AttachedPeer, why: string, nowMs: number): void {
    this.deps.log.write(
      { kind: 'badFrame', code: att.room === null ? '' : att.room.code, peerId: att.peerId, why },
      nowMs,
    )
  }

  private roomLog(code: string): LogSink {
    const cached = this.roomLogs.get(code)
    if (cached !== undefined) return cached
    const sink = this.deps.log
    const scoped: LogSink = {
      write(ev: LogEvent, nowMs: number): void {
        sink.write(ev.code === '' ? ({ ...ev, code } as LogEvent) : ev, nowMs)
      },
    }
    this.roomLogs.set(code, scoped)
    return scoped
  }
}
