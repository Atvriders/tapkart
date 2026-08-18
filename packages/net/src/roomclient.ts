// PURE (contract §0a). One Transport, one injected clock through poll(nowMs),
// and no socket, timer or DOM global anywhere in it.
import type {
  ChannelName,
  ClientUpdateMessage,
  HeartbeatMessage,
  HelloMessage,
  LobbyMessage,
  MessageKind,
  PeerRole,
  ResyncReason,
  StartMessage,
  WelcomeMessage,
} from '@tapkart/protocol'
import {
  CLIENT_FLAG_READY,
  CLIENT_FLAG_RTC_CONNECTED,
  CLIENT_FLAG_RTC_FAILED,
  CLIENT_FLAG_START_REQUEST,
  CLIENT_FLAG_WEBRTC,
  SERVER_FLAG_IS_HOST,
  SERVER_FLAG_RELAY_ASSIGNED,
  SERVER_FLAG_RELAY_FIRST,
  decodeHeartbeat,
  decodeLobby,
  decodeStart,
  decodeWelcome,
  encodeClientUpdate,
  encodeHeader,
  encodeHeartbeat,
  encodeHello,
  encodeResyncRequest,
  normalizeRoomCode,
} from '@tapkart/protocol'
import { COUNTDOWN_TICKS } from '@tapkart/sim'
import { TICK_MS } from './clock'
import type { LivenessState } from './liveness'
import { createLiveness, isStale, notePacket, notePingSent, notePong, shouldSendPing } from './liveness'
import type { DatagramGuard } from './receive'
import { createDatagramGuard } from './receive'
import { decodeAuthorityChange } from './shadow'
import { WS_CLOSE_ROOM_CLOSED, WS_CLOSE_VERSION_MISMATCH } from './socket'
import type { Transport } from './transport'
import { RTC_CONNECT_TIMEOUT_MS } from './webrtc'
import { WS_SLOT_SERVER } from './wsframe'

export type RoomPhase = 'idle' | 'connecting' | 'lobby' | 'starting' | 'racing' | 'finished' | 'closed'

export interface RoomClientState {
  phase: RoomPhase
  /** The role confirmed by WelcomeMessage. Before welcome this is the requested
   *  role; after welcome it is server-authoritative. */
  role: PeerRole
  playerId: number          // -1 until welcomed
  peerSlot: number          // -1 until welcomed
  roomCode: string
  token: string
  hostPlayerId: number
  lobby: LobbyMessage | null
  start: StartMessage | null
  authorityTick: number     // -1 until an authorityChange arrives
  authorityEventSeq: number // -1 likewise
  relayMode: boolean        // attached over the relay right now
  relayFirst: boolean       // F-P4-39: SERVER_FLAG_RELAY_FIRST was set at welcome
  /** F-P4-24. The server socket went away mid-race. The race KEEPS RUNNING
   *  host-authoritative over WebRTC; this flag is what the UI reads to say the
   *  backup authority is gone. v1 does not reconnect. */
  serverLost: boolean
  error: string             // '' when none; a JoinResult, a close-code name, or 'serverLost'
}

export interface RoomClientOptions {
  transport: Transport      // the CONTROL transport (the server socket), not the fan-out
  role: PeerRole
  name: string
  characterIdx: number
  roomCode: string          // '' when hosting
  token: string             // '' when new
  trackId: string
}

export interface RoomClientUpdate {
  name?: string; characterIdx?: number; ready?: boolean; trackId?: string
}

/** §6.4. Starting values, and the client is the right detector: it is the only
 *  participant that knows, and a client that lies only costs itself a checkpoint
 *  the server's rate limiter already bounds. */
export const HARD_RESYNC_LIMIT = 3
export const HARD_RESYNC_WINDOW_TICKS = 600   // 10 s at 60 Hz

/** Contract §6.3, each *_MAX_BYTES plus the 2-byte header, rounded to a power of
 * two. BitWriter TRUNCATES SILENTLY past the end of its buffer, so these are
 * derived rather than guessed. */
const HELLO_BUF_BYTES = 64
const CLIENT_UPDATE_BUF_BYTES = 64
const RESYNC_REQUEST_BUF_BYTES = 16
const HEARTBEAT_BUF_BYTES = 16

/**
 * Every message this class sends goes to the room, addressed to slot 0.
 *
 * NOT `broadcast`: on a WebSocketTransport that emits one frame addressed to
 * WS_SLOT_BROADCAST, which the server fans out to the OTHER PEERS - so a hello
 * sent that way reaches every guest and never the room. §4.3 fixes the default
 * slot -> peer id mapping as `(s) => 'p' + s` and guarantees the server's peer
 * is always in `peers()`, "from the first frame onward, because the shadow is
 * always listening".
 */
const SERVER_PEER_ID = `p${WS_SLOT_SERVER}`

/**
 * 3000 ms. Nothing on the wire announces the end of the countdown: createState
 * begins every peer at phase 'countdown' and sim's phase.ts flips it at
 * COUNTDOWN_TICKS off a tick counter every peer runs identically (contract
 * §2.7), so the ROOM phase follows the same clock rather than becoming a second
 * source of truth about the same instant.
 */
const COUNTDOWN_MS = COUNTDOWN_TICKS * TICK_MS

/** Holders for the cold-path decoders. Contract §0: the six lobby/control kinds
 * RETURN a fresh object (three of them carry strings and allocate anyway), while
 * the guard's `decode` helper takes a `(buf, out) => void`. One holder per kind,
 * allocated once, bridges the two without allocating per datagram. */
interface Holder<T> { value: T | null }

const intoWelcome = (buf: Uint8Array, out: Holder<WelcomeMessage>): void => {
  out.value = decodeWelcome(buf)
}
const intoLobby = (buf: Uint8Array, out: Holder<LobbyMessage>): void => {
  out.value = decodeLobby(buf)
}
const intoStart = (buf: Uint8Array, out: Holder<StartMessage>): void => {
  out.value = decodeStart(buf)
}
const intoHeartbeat = (buf: Uint8Array, out: Holder<HeartbeatMessage>): void => {
  out.value = decodeHeartbeat(buf)
}
const intoAuthorityChange = (buf: Uint8Array, out: Holder<{ tick: number; eventSeq: number }>): void => {
  out.value = decodeAuthorityChange(buf)
}

export class RoomClient {
  private readonly t: Transport
  private readonly requestedRole: PeerRole
  private readonly st: RoomClientState
  private readonly guard: DatagramGuard

  // This client's own declaration, which `update` patches and every
  // clientUpdate carries.
  private name: string
  private characterIdx: number
  private trackId: string
  private ready = false

  private readonly helloBuf = new Uint8Array(HELLO_BUF_BYTES)
  private readonly updateBuf = new Uint8Array(CLIENT_UPDATE_BUF_BYTES)
  private readonly resyncBuf = new Uint8Array(RESYNC_REQUEST_BUF_BYTES)
  private readonly heartbeatBuf = new Uint8Array(HEARTBEAT_BUF_BYTES)

  private readonly welcomeHolder: Holder<WelcomeMessage> = { value: null }
  private readonly lobbyHolder: Holder<LobbyMessage> = { value: null }
  private readonly startHolder: Holder<StartMessage> = { value: null }
  private readonly heartbeatHolder: Holder<HeartbeatMessage> = { value: null }
  private readonly authorityHolder: Holder<{ tick: number; eventSeq: number }> = { value: null }

  /**
   * Seeded on the first poll, not in the constructor: contract §4.9 gives this
   * class exactly one clocked entry point and the constructor is not it.
   */
  private live: LivenessState | null = null
  private sawPacket = false
  private pendingPong: HeartbeatMessage | null = null
  private pingSeq = 0

  private rtcArmPending = false
  private rtcDeadlineMs = -1
  private rtcConnected = false
  private rtcConnectedSent = false
  private rtcFailedSent = false

  private raceStartsAtMs = -1
  private closedFired = false

  /** The datagram currently being dispatched, header included. `decodeAuthorityChange`
   * validates the header it skips (shadow.ts) and therefore needs the whole
   * datagram, while the guard hands handlers the body. Set for the duration of
   * one synchronous callback and cleared after it. */
  private raw: Uint8Array | null = null

  private readonly welcomeCbs: ((m: WelcomeMessage) => void)[] = []
  private readonly lobbyCbs: ((m: LobbyMessage) => void)[] = []
  private readonly startCbs: ((m: StartMessage) => void)[] = []
  private readonly authorityCbs: ((tick: number, eventSeq: number) => void)[] = []
  private readonly closedCbs: ((reason: string) => void)[] = []

  constructor(opts: RoomClientOptions) {
    this.t = opts.transport
    this.requestedRole = opts.role
    this.name = opts.name
    this.characterIdx = opts.characterIdx
    this.trackId = opts.trackId
    this.st = {
      phase: 'idle',
      role: opts.role,
      playerId: -1,
      peerSlot: -1,
      roomCode: normalizeRoomCode(opts.roomCode),
      token: opts.token,
      hostPlayerId: -1,
      lobby: null,
      start: null,
      authorityTick: -1,
      authorityEventSeq: -1,
      relayMode: false,
      relayFirst: false,
      serverLost: false,
      error: '',
    }

    this.guard = createDatagramGuard(this)
    const guarded = this.guard.wrap((_peerId, channel, kind, payload) => {
      this.onDatagram(channel, kind, payload)
    })
    // Wrapped once more so `this.raw` holds the datagram the guard is currently
    // dispatching. Nothing retains it past the callback.
    this.t.onMessage((peerId, channel, data) => {
      this.raw = data
      try {
        guarded(peerId, channel, data)
      } finally {
        this.raw = null
      }
    })
  }

  state(): Readonly<RoomClientState> {
    return this.st
  }

  /** Sends `hello`. Idempotent: a second call before `welcome` re-sends nothing. */
  connect(): void {
    if (this.st.phase !== 'idle') return
    this.st.phase = 'connecting'
    const msg: HelloMessage = {
      role: this.requestedRole,
      roomCode: this.st.roomCode,
      token: this.st.token,
      characterIdx: this.characterIdx,
      name: this.name,
      trackId: this.trackId,
      // Every client this project ships is a browser, and every browser can
      // attempt WebRTC. The server reads this to decide whether the room is
      // worth relaying for at all.
      flags: CLIENT_FLAG_WEBRTC,
    }
    const h = encodeHeader(this.helloBuf, 'hello')
    const n = encodeHello(this.helloBuf.subarray(h), msg)
    this.t.send('reliable', SERVER_PEER_ID, this.helloBuf.slice(0, h + n))
  }

  /** Sends a `clientUpdate` with the patch applied to this client's own
   *  declaration. NOT a second `hello` - F-P4-11. */
  update(patch: RoomClientUpdate): void {
    if (!this.canSend()) return
    if (patch.name !== undefined) this.name = patch.name
    if (patch.characterIdx !== undefined) this.characterIdx = patch.characterIdx
    if (patch.ready !== undefined) this.ready = patch.ready
    if (patch.trackId !== undefined) this.trackId = patch.trackId
    this.sendClientUpdate(0, patch.trackId ?? '')
  }

  /** Host only; the server ignores it from anyone `canStart` rejects, and this
   *  side does not spend a frame finding that out. */
  requestStart(): void {
    if (!this.canSend()) return
    if (this.st.role !== 'host') return
    this.sendClientUpdate(CLIENT_FLAG_START_REQUEST, '')
  }

  requestResync(reason: ResyncReason, lastTick: number): void {
    if (!this.canSend()) return
    const h = encodeHeader(this.resyncBuf, 'resyncRequest')
    const n = encodeResyncRequest(this.resyncBuf.subarray(h), { reason, lastTick })
    this.t.send('reliable', SERVER_PEER_ID, this.resyncBuf.slice(0, h + n))
  }

  /** CLIENT_FLAG_RTC_FAILED; asks for relay. Sent at most once per direct-link
   *  attempt. A later confirmed direct upgrade re-arms this latch so a second
   *  link loss can fall back again without inflating duplicate reports. */
  reportRtcFailed(): void {
    if (!this.canSend()) return
    if (this.st.role !== 'guest') return
    if (this.rtcFailedSent) return
    this.rtcFailedSent = true
    this.rtcConnected = false
    this.rtcConnectedSent = false
    this.rtcDeadlineMs = -1
    this.rtcArmPending = false
    // There is no second `welcome` to confirm it: the server's answer is simply
    // to start relaying, so the flag flips when the request goes out.
    this.st.relayMode = true
    this.sendClientUpdate(CLIENT_FLAG_RTC_FAILED, '')
  }

  /** ADDITIVE (see this task's Interfaces). The direct link came up, so the
   *  give-up timer must not fire. The explicit success flag is what lets a
   *  relay-first guest upgrade instead of remaining on the relay forever. */
  noteRtcConnected(): void {
    this.rtcConnected = true
    // The server clears this peer's relay assignment on the success update.
    // From that point a future link loss is a new failure and must be reportable.
    this.rtcFailedSent = false
    this.rtcDeadlineMs = -1
    this.rtcArmPending = false
    this.sendRtcConnectedIfReady()
  }

  /** ADDITIVE (see this task's Interfaces). The socket's close code - the only
   *  channel that crosses a protocol version boundary intact. */
  noteSocketClosed(code: number): void {
    if (this.st.phase === 'closed') return
    if (code === WS_CLOSE_VERSION_MISMATCH) {
      this.st.error = 'versionMismatch'
      this.closeWith('versionMismatch')
      return
    }
    if (this.canSurviveServerLoss()) {
      // F-P4-24: the race keeps playing. Relay-attached guests lose their path
      // and the host learns it through onPeerLost; a direct guest notices
      // nothing but this flag. RoomHub also uses ROOM_CLOSED while shutting
      // down, so an active direct race must degrade before that lobby-only
      // close-code mapping is considered.
      this.st.serverLost = true
      return
    }
    if (code === WS_CLOSE_ROOM_CLOSED) {
      this.st.error = 'roomClosed'
      this.closeWith('roomClosed')
      return
    }
    this.st.error = 'serverLost'
    this.closeWith('serverLost')
  }

  /** The one clocked entry point, and `nowMs` is injected. */
  poll(nowMs: number): void {
    if (this.st.phase === 'idle' || this.st.phase === 'closed') return
    if (this.live === null) this.live = createLiveness(nowMs)
    const live = this.live

    // Folded here rather than in the message handler, which has no clock.
    if (this.sawPacket) {
      notePacket(live, nowMs)
      this.sawPacket = false
    }
    if (this.pendingPong !== null) {
      notePong(live, this.pendingPong, nowMs)
      this.pendingPong = null
    }

    if (this.rtcArmPending) {
      this.rtcArmPending = false
      this.rtcDeadlineMs = nowMs + RTC_CONNECT_TIMEOUT_MS
    }

    if (shouldSendPing(live, nowMs)) {
      this.pingSeq = (this.pingSeq + 1) & 0xffff
      const h = encodeHeader(this.heartbeatBuf, 'ping')
      // echoMs is this client's OWN reading, opaque to the server, which copies
      // it back verbatim. It travels as a u32, so it is taken modulo 2^32 here
      // and notePong measures the difference in the same space.
      const n = encodeHeartbeat(this.heartbeatBuf.subarray(h), { seq: this.pingSeq, echoMs: nowMs >>> 0 })
      this.t.send('unreliable', SERVER_PEER_ID, this.heartbeatBuf.slice(0, h + n))
      notePingSent(live, this.pingSeq, nowMs)
    }

    if (this.rtcDeadlineMs >= 0 && nowMs >= this.rtcDeadlineMs) {
      this.rtcDeadlineMs = -1
      if (!this.rtcConnected) this.reportRtcFailed()
    }

    if (this.st.phase === 'starting') {
      if (this.raceStartsAtMs < 0) this.raceStartsAtMs = nowMs + COUNTDOWN_MS
      else if (nowMs >= this.raceStartsAtMs) this.st.phase = 'racing'
    }

    if (isStale(live, nowMs)) {
      if (this.canSurviveServerLoss()) {
        this.st.serverLost = true
      } else {
        this.st.error = 'serverLost'
        this.closeWith('serverLost')
      }
    }
  }

  onWelcome(cb: (m: WelcomeMessage) => void): void {
    this.welcomeCbs.push(cb)
  }

  onLobby(cb: (m: LobbyMessage) => void): void {
    this.lobbyCbs.push(cb)
  }

  onStart(cb: (m: StartMessage) => void): void {
    this.startCbs.push(cb)
  }

  /** F-P4-23. Fires when the shadow has taken over. `game` swaps its
   *  AuthorityLoop session for a ClientLoop session here; a host that does not
   *  is a demoted authority watching a race it no longer drives. */
  onAuthorityChange(cb: (tick: number, eventSeq: number) => void): void {
    this.authorityCbs.push(cb)
  }

  onClosed(cb: (reason: string) => void): void {
    this.closedCbs.push(cb)
  }

  /** Marks the local race complete while retaining the persistent room. Results
   *  remain available even when the server disappeared during direct play. */
  finishRace(): void {
    if (this.st.phase === 'starting' || this.st.phase === 'racing') {
      this.st.phase = 'finished'
    }
  }

  /** Returns a healthy persistent room to its lobby lifecycle. A degraded room
   *  cannot be revived by a local screen transition. */
  returnToLobby(): void {
    if (this.st.phase !== 'finished' || this.st.serverLost) return
    this.st.phase = 'lobby'
    this.st.start = null
  }

  close(): void {
    if (this.st.phase === 'closed') return
    this.t.close()
    this.closeWith('closed')
  }

  // ---------------------------------------------------------------- internals

  private canSend(): boolean {
    return this.st.phase !== 'idle' && this.st.phase !== 'closed'
  }

  private canSurviveServerLoss(): boolean {
    return this.st.phase === 'starting' || this.st.phase === 'racing' || this.st.phase === 'finished'
  }

  private closeWith(reason: string): void {
    this.st.phase = 'closed'
    if (this.closedFired) return
    this.closedFired = true
    for (const cb of this.closedCbs) cb(reason)
  }

  private sendClientUpdate(extraFlags: number, trackId: string): void {
    const msg: ClientUpdateMessage = {
      flags: (this.ready ? CLIENT_FLAG_READY : 0) | extraFlags,
      characterIdx: this.characterIdx,
      name: this.name,
      trackId,
    }
    const h = encodeHeader(this.updateBuf, 'clientUpdate')
    const n = encodeClientUpdate(this.updateBuf.subarray(h), msg)
    this.t.send('reliable', SERVER_PEER_ID, this.updateBuf.slice(0, h + n))
  }

  private sendRtcConnectedIfReady(): void {
    if (!this.rtcConnected || this.st.role !== 'guest' || this.rtcConnectedSent) return
    // A connection can complete while the welcome is still in flight. Sending
    // clientUpdate from the provisional socket would race server-side seating,
    // so remember it and announce it immediately after a successful welcome.
    if (this.st.phase !== 'lobby' && this.st.phase !== 'starting' && this.st.phase !== 'racing') return
    this.rtcConnectedSent = true
    this.st.relayMode = false
    this.sendClientUpdate(CLIENT_FLAG_RTC_CONNECTED, '')
  }

  private onDatagram(channel: ChannelName, kind: MessageKind, payload: Uint8Array): void {
    // Any datagram at all is proof the socket is alive; the timestamp is the
    // next poll's to write.
    this.sawPacket = true

    if (kind === 'welcome' && channel === 'reliable') {
      if (!this.guard.decode(intoWelcome, payload, this.welcomeHolder)) return
      const m = this.welcomeHolder.value
      if (m === null) return
      this.onWelcomeMessage(m)
      return
    }
    if (kind === 'lobby' && channel === 'reliable') {
      if (!this.guard.decode(intoLobby, payload, this.lobbyHolder)) return
      const m = this.lobbyHolder.value
      if (m === null) return
      this.st.lobby = m
      this.st.hostPlayerId = m.hostPlayerId
      for (const cb of this.lobbyCbs) cb(m)
      return
    }
    if (kind === 'start' && channel === 'reliable') {
      if (!this.guard.decode(intoStart, payload, this.startHolder)) return
      const m = this.startHolder.value
      if (m === null) return
      this.st.start = m
      // Promotion and server-loss state belong to one race. A rematch starts
      // with the room creator as direct authority again and a live server.
      this.st.authorityTick = -1
      this.st.authorityEventSeq = -1
      this.st.serverLost = false
      this.st.phase = 'starting'
      this.raceStartsAtMs = -1
      for (const cb of this.startCbs) cb(m)
      return
    }
    if (kind === 'authorityChange' && channel === 'reliable') {
      const raw = this.raw
      if (raw === null) return
      if (!this.guard.decode(intoAuthorityChange, raw, this.authorityHolder)) return
      const m = this.authorityHolder.value
      if (m === null) return
      this.st.authorityTick = m.tick
      this.st.authorityEventSeq = m.eventSeq
      // No phase change and no state reset: spec §5 is explicit that "there is
      // no rewind", because the shadow has been ticking all along.
      for (const cb of this.authorityCbs) cb(m.tick, m.eventSeq)
      return
    }
    if (kind === 'ping') {
      if (!this.guard.decode(intoHeartbeat, payload, this.heartbeatHolder)) return
      const m = this.heartbeatHolder.value
      if (m === null) return
      // seq AND echoMs copied back unchanged. A receiver that stamped its own
      // time here would turn the sender's RTT into clock skew, and nothing
      // would fail loudly.
      const h = encodeHeader(this.heartbeatBuf, 'pong')
      const n = encodeHeartbeat(this.heartbeatBuf.subarray(h), m)
      this.t.send('unreliable', SERVER_PEER_ID, this.heartbeatBuf.slice(0, h + n))
      return
    }
    if (kind === 'pong') {
      if (!this.guard.decode(intoHeartbeat, payload, this.heartbeatHolder)) return
      const m = this.heartbeatHolder.value
      if (m === null) return
      // Held for the next poll, which owns the clock.
      this.pendingPong = { seq: m.seq, echoMs: m.echoMs }
      return
    }
    // hello, clientUpdate and resyncRequest are this client's OWN kinds and
    // never arrive here; input, snapshot, events and checkpoint are the race
    // loops'. Transport.onMessage APPENDS (contract §2.1 rule 1), which is what
    // lets ClientLoop and this class share one transport - so a kind this class
    // ignores is not a kind that went unhandled.
  }

  private onWelcomeMessage(m: WelcomeMessage): void {
    if (m.result !== 'ok') {
      for (const cb of this.welcomeCbs) cb(m)
      this.st.error = m.result
      this.closeWith(m.result)
      return
    }
    this.st.playerId = m.playerId
    this.st.peerSlot = m.peerSlot
    this.st.token = m.token
    this.st.roomCode = m.roomCode
    this.st.hostPlayerId = m.hostPlayerId
    this.st.role = (m.flags & SERVER_FLAG_IS_HOST) !== 0 ? 'host' : 'guest'
    this.st.relayFirst = (m.flags & SERVER_FLAG_RELAY_FIRST) !== 0
    this.st.relayMode = this.st.relayFirst || (m.flags & SERVER_FLAG_RELAY_ASSIGNED) !== 0
    this.st.phase = 'lobby'
    // Success callbacks may synchronously build the RTC topology and update UI
    // authority, so publish the complete server-confirmed state first.
    for (const cb of this.welcomeCbs) cb(m)
    this.sendRtcConnectedIfReady()
    // The give-up timer is armed for a guest that is expected to reach the host
    // directly. A relay-first room is already relaying (F-P4-39: "attach over
    // the relay IMMEDIATELY and attempt WebRTC in the background"), so asking
    // for relay again would only charge the room another rtcFailure.
    if (this.st.role === 'guest' && !this.st.relayFirst && !this.rtcConnected && !this.rtcFailedSent) {
      this.rtcArmPending = true
    }
  }
}
