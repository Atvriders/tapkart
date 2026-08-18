// PURE — the persistent multiplayer room coordinator. Browser globals live in
// the socket/RTC adapters passed by the shell; clocks enter only through poll.
import type {
  LobbyMessage,
  ResyncReason,
  StartMessage,
  WelcomeMessage,
} from '@tapkart/protocol'
import type {
  IceServerConfig,
  LocalInputTransport,
  RoomClientOptions,
  RoomClientState,
  RoomClientUpdate,
  RtcConnectionFactory,
  SocketLike,
  Transport,
  WebRtcTransport,
} from '@tapkart/net'
import {
  LOCAL_PEER_ID,
  RoomClient,
  SIGNAL_VERSION,
  encodeSignal,
  makeFanOutTransport,
  makeWebRtcTransport,
  makeWebSocketTransport,
  parseSignal,
  scopePeerId,
  splitPeerId,
  withLocalInput,
  withPeerAuthority,
} from '@tapkart/net'

const WS_PART_ID = 'ws'
const SERVER_PEER_ID = 'p0'

export interface MultiplayerRoomOptions extends Omit<RoomClientOptions, 'transport'> {
  socket: SocketLike
  rtcFactory: RtcConnectionFactory
  iceServers: readonly IceServerConfig[]
}

export interface MultiplayerRoom {
  state(): Readonly<RoomClientState>
  start(): void
  poll(nowMs: number): void
  update(patch: RoomClientUpdate): void
  requestStart(): void
  requestResync(reason: ResyncReason, lastTick: number): void
  finishRace(): void
  returnToLobby(): void
  /** A non-owning per-race lease. Closing a RaceSession must not close the room. */
  borrowRaceTransport(): Transport
  onWelcome(cb: (message: WelcomeMessage) => void): void
  onLobby(cb: (message: LobbyMessage) => void): void
  onStart(cb: (message: StartMessage) => void): void
  onAuthorityChange(cb: (tick: number, eventSeq: number) => void): void
  onClosed(cb: (reason: string) => void): void
  close(): void
}

interface RtcLink {
  readonly slot: number
  readonly partId: string
  readonly transport: WebRtcTransport
  connectedNoted: boolean
}

function rtcPartId(slot: number): string {
  return `rtc-${slot}`
}

function peerIdOfSlot(slot: number): string {
  return `p${slot}`
}

function slotOfPeerId(peerId: string): number {
  if (!/^p\d+$/.test(peerId)) return -1
  const slot = Number(peerId.slice(1))
  return Number.isInteger(slot) && slot >= 0 && slot <= 255 ? slot : -1
}

/** Accept only peer ids this coordinator itself could have scoped. */
function slotOfScopedPeer(scoped: string): number {
  const split = splitPeerId(scoped)
  if (split === null) return -1
  const slot = slotOfPeerId(split.peerId)
  if (slot < 0) return -1
  if (split.partId === WS_PART_ID) return slot
  return split.partId === rtcPartId(slot) ? slot : -1
}

function makeTransportLease(inner: Transport, initiallyActive: boolean): Transport {
  let active = initiallyActive
  const messageCbs: Parameters<Transport['onMessage']>[0][] = []
  const peerLostCbs: Parameters<Transport['onPeerLost']>[0][] = []

  inner.onMessage((peerId, channel, data) => {
    if (!active) return
    for (const cb of [...messageCbs]) cb(peerId, channel, data)
  })
  inner.onPeerLost((peerId) => {
    if (!active) return
    for (const cb of [...peerLostCbs]) cb(peerId)
  })

  return {
    send(channel, peerId, data): void {
      if (active) inner.send(channel, peerId, data)
    },
    broadcast(channel, data): void {
      if (active) inner.broadcast(channel, data)
    },
    onMessage(cb): void { messageCbs.push(cb) },
    onPeerLost(cb): void { peerLostCbs.push(cb) },
    peers(): string[] { return active ? inner.peers() : [] },
    close(): void { active = false },
  }
}

/**
 * The host's AuthorityLoop consumes its own codec-quantised input locally. The
 * server shadow needs those identical bytes too, but broadcasting them would
 * also send the host's input back through every RTC link. Mirror only to the
 * WebSocket room peer; remote race traffic still uses the wrapped transport.
 */
export function withMirroredLocalInput(inner: Transport): LocalInputTransport {
  const local = withLocalInput(inner)
  local.onMessage((peerId, channel, data) => {
    if (peerId !== LOCAL_PEER_ID) return
    inner.send(channel, scopePeerId(WS_PART_ID, SERVER_PEER_ID), data)
  })
  return local
}

export function createMultiplayerRoom(opts: MultiplayerRoomOptions): MultiplayerRoom {
  const ws = makeWebSocketTransport({ socket: opts.socket })
  const fanout = makeFanOutTransport([{ id: WS_PART_ID, transport: ws }])
  const links = new Map<number, RtcLink>()
  const failedSlots = new Set<number>()
  let latestLobby: LobbyMessage | null = null
  let selfSlot = -1
  let connectWanted = false
  let connectIssued = false
  let closed = false

  const welcomeCbs: Array<(message: WelcomeMessage) => void> = []
  const lobbyCbs: Array<(message: LobbyMessage) => void> = []
  const startCbs: Array<(message: StartMessage) => void> = []
  const authorityCbs: Array<(tick: number, eventSeq: number) => void> = []
  const closedCbs: Array<(reason: string) => void> = []

  function playerIdOfSlot(slot: number): number {
    const lobby = latestLobby
    if (lobby === null) return -1
    for (let playerId = 0; playerId < lobby.slots.length; playerId++) {
      const seat = lobby.slots[playerId]
      if (seat.occupied && seat.connected && !seat.isBot && seat.peerSlot === slot) return playerId
    }
    return -1
  }

  function hostSlot(): number {
    const lobby = latestLobby
    if (lobby === null || lobby.hostPlayerId < 0 || lobby.hostPlayerId >= lobby.slots.length) return -1
    const seat = lobby.slots[lobby.hostPlayerId]
    return seat.occupied && seat.connected && !seat.isBot ? seat.peerSlot : -1
  }

  let client: RoomClient
  const guarded = withPeerAuthority(fanout, {
    playerIdOf(peerId): number {
      return playerIdOfSlot(slotOfScopedPeer(peerId))
    },
    isAuthority(peerId): boolean {
      const split = splitPeerId(peerId)
      const slot = slotOfScopedPeer(peerId)
      if (split !== null && split.partId === WS_PART_ID && slot === 0) return true
      // Once the shadow announces promotion, only server-originated state is
      // authoritative. Before it, either the host's direct or relay path is.
      return client.state().authorityTick < 0 && slot >= 0 && slot === hostSlot()
    },
  })

  client = new RoomClient({
    transport: ws,
    role: opts.role,
    name: opts.name,
    characterIdx: opts.characterIdx,
    roomCode: opts.roomCode,
    token: opts.token,
    trackId: opts.trackId,
  })

  function desiredSlots(): Set<number> {
    const out = new Set<number>()
    const lobby = latestLobby
    if (lobby === null || selfSlot < 0) return out
    if (client.state().role === 'guest') {
      const slot = hostSlot()
      if (slot > 0 && slot !== selfSlot) out.add(slot)
      return out
    }
    for (const seat of lobby.slots) {
      if (!seat.occupied || seat.isBot || !seat.connected) continue
      if (seat.peerSlot > 0 && seat.peerSlot !== selfSlot) out.add(seat.peerSlot)
    }
    return out
  }

  function removeLink(slot: number, failed: boolean): void {
    const link = links.get(slot)
    if (link === undefined) return
    if (failed) failedSlots.add(slot)
    // removePart reports peer loss before detaching; close then owns the native
    // connection. Neither operation reaches the persistent socket part.
    fanout.removePart(link.partId)
    link.transport.close()
    links.delete(slot)
    if (failed && client.state().role === 'guest' && !client.state().relayMode) client.reportRtcFailed()
  }

  function ensureLink(slot: number): void {
    if (closed || links.has(slot) || failedSlots.has(slot) || slot <= 0 || slot === selfSlot) return
    let transport: WebRtcTransport
    try {
      transport = makeWebRtcTransport({
        peerId: peerIdOfSlot(slot),
        connection: opts.rtcFactory(opts.iceServers),
        // P4 Q42: the guest offers; the host only answers.
        role: client.state().role === 'guest' ? 'offerer' : 'answerer',
      })
    } catch {
      failedSlots.add(slot)
      if (client.state().role === 'guest' && !client.state().relayMode) client.reportRtcFailed()
      return
    }

    const link: RtcLink = {
      slot,
      partId: rtcPartId(slot),
      transport,
      connectedNoted: false,
    }
    links.set(slot, link)
    fanout.addPart({ id: link.partId, transport })
    transport.onLocalSignal((msg) => {
      if (closed || selfSlot <= 0) return
      ws.sendText(encodeSignal({ v: SIGNAL_VERSION, from: selfSlot, to: slot, msg }))
    })
    // Registered after fan-out so a failure first reaches the active race loop;
    // removePart then sees an already-lost peer and cannot double-report it.
    transport.onPeerLost(() => removeLink(slot, true))
    transport.start()
  }

  function reconcileLinks(): void {
    const wanted = desiredSlots()
    for (const slot of [...failedSlots]) if (!wanted.has(slot)) failedSlots.delete(slot)
    for (const slot of [...links.keys()]) if (!wanted.has(slot)) removeLink(slot, false)
    for (const slot of wanted) ensureLink(slot)
  }

  function isAllowedSignalSource(slot: number): boolean {
    if (slot <= 0 || slot === selfSlot || playerIdOfSlot(slot) < 0) return false
    if (client.state().role === 'guest') return slot === hostSlot()
    return slot !== hostSlot()
  }

  ws.onText((text) => {
    if (closed || selfSlot <= 0) return
    const env = parseSignal(text)
    if (env === null || env.to !== selfSlot || !isAllowedSignalSource(env.from)) return
    // A lobby frame and a signal share one ordered socket. Reconcile once more
    // defensively so an answerer exists even if an adapter delivered callbacks
    // in a surprising order.
    if (!links.has(env.from)) reconcileLinks()
    links.get(env.from)?.transport.acceptSignal(env.msg)
  })

  client.onWelcome((message) => {
    if (message.result === 'ok' && selfSlot < 0) {
      ws.setSelfSlot(message.peerSlot)
      selfSlot = message.peerSlot
      reconcileLinks()
    }
    for (const cb of [...welcomeCbs]) cb(message)
  })
  client.onLobby((message) => {
    latestLobby = message
    reconcileLinks()
    for (const cb of [...lobbyCbs]) cb(message)
  })
  client.onStart((message) => {
    for (const cb of [...startCbs]) cb(message)
  })
  client.onAuthorityChange((tick, eventSeq) => {
    for (const cb of [...authorityCbs]) cb(tick, eventSeq)
  })
  client.onClosed((reason) => {
    for (const cb of [...closedCbs]) cb(reason)
  })
  opts.socket.onClose((code) => {
    if (!closed) client.noteSocketClosed(code)
  })

  function connectIfOpen(): void {
    if (closed || !connectWanted || connectIssued || opts.socket.readyState() !== 'open') return
    connectIssued = true
    client.connect()
  }

  return {
    state: () => client.state(),
    start(): void {
      connectWanted = true
      connectIfOpen()
    },
    poll(nowMs): void {
      if (closed) return
      connectIfOpen()
      for (const link of [...links.values()]) {
        if (!link.connectedNoted && link.transport.connectionState() === 'connected') {
          link.connectedNoted = true
          if (client.state().role === 'guest') client.noteRtcConnected()
        }
      }
      client.poll(nowMs)
    },
    update: (patch) => client.update(patch),
    requestStart: () => client.requestStart(),
    requestResync: (reason, lastTick) => client.requestResync(reason, lastTick),
    finishRace: () => client.finishRace(),
    returnToLobby: () => client.returnToLobby(),
    borrowRaceTransport: () => makeTransportLease(guarded, !closed),
    onWelcome(cb): void { welcomeCbs.push(cb) },
    onLobby(cb): void { lobbyCbs.push(cb) },
    onStart(cb): void { startCbs.push(cb) },
    onAuthorityChange(cb): void { authorityCbs.push(cb) },
    onClosed(cb): void { closedCbs.push(cb) },
    close(): void {
      if (closed) return
      closed = true
      for (const slot of [...links.keys()]) removeLink(slot, false)
      client.close()
      guarded.close()
    },
  }
}
