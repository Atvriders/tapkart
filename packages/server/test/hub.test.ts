import { describe, expect, it } from 'vitest'
import type { AuthEvent, Intent, SimContext } from '@tapkart/sim'
import { MAX_ENTITIES, MAX_KARTS, createState } from '@tapkart/sim'
import type { ChannelName, MessageKind, PeerRole, StartMessage } from '@tapkart/protocol'
import {
  CLIENT_FLAG_RTC_FAILED,
  CLIENT_FLAG_START_REQUEST,
  PROTOCOL_VERSION,
  SERVER_FLAG_CHECKPOINT_NEXT,
  SERVER_FLAG_IS_HOST,
  SERVER_FLAG_RACE_IN_PROGRESS,
  decodeCheckpoint,
  decodeEvents,
  decodeHeader,
  decodeHeartbeat,
  decodeLobby,
  decodeStart,
  decodeWelcome,
  encodeClientUpdate,
  encodeHeader,
  encodeHeartbeat,
  encodeHello,
  encodeInput,
} from '@tapkart/protocol'
import type { SocketData, SocketLike } from '@tapkart/net'
import {
  AuthorityLoop,
  ClientLoop,
  PEER_STALE_MS,
  SIGNAL_VERSION,
  WS_CLOSE_ROOM_CLOSED,
  WS_CLOSE_VERSION_MISMATCH,
  WS_CONTROL_PEER_GONE,
  WS_CONTROL_PEER_JOINED,
  WS_FRAME_CONTROL,
  WS_HEADER_BYTES,
  WS_SLOT_SERVER,
  advanceAccumulator,
  decodeAuthorityChange,
  decodeWsFrame,
  encodeSignal,
  encodeWsData,
  makeTickAccumulator,
  makeWebSocketTransport,
  promotionTickOf,
} from '@tapkart/net'
import { makeTestHub, makeTestRoom } from './fixtures/server-fixtures'
import { defaultContentProvider } from '../src/content'

interface Seen { kind: MessageKind; channel: ChannelName; payload: Uint8Array }

function watch(socket: SocketLike): Seen[] {
  const out: Seen[] = []
  socket.onMessage((data) => {
    if (typeof data === 'string') return
    const frame = decodeWsFrame(data)
    if (frame === null || frame.channel === null || frame.payload.length < 2) return
    out.push({
      kind: decodeHeader(frame.payload).kind,
      channel: frame.channel,
      payload: frame.payload.subarray(2).slice(),
    })
  })
  return out
}

function sendBody(socket: SocketLike, channel: ChannelName, body: Uint8Array): void {
  const frame = new Uint8Array(WS_HEADER_BYTES + body.length)
  encodeWsData(frame, channel, WS_SLOT_SERVER, body)
  socket.send(frame)
}

function sendUpdate(socket: SocketLike, flags: number, name = ''): void {
  const buf = new Uint8Array(64)
  const head = encodeHeader(buf, 'clientUpdate')
  const n = encodeClientUpdate(buf.subarray(head), { flags, characterIdx: 0, name, trackId: '' })
  sendBody(socket, 'reliable', buf.subarray(0, head + n))
}

function sendHeartbeat(socket: SocketLike, kind: 'ping' | 'pong', seq: number, echoMs: number): void {
  const buf = new Uint8Array(16)
  const head = encodeHeader(buf, kind)
  const n = encodeHeartbeat(buf.subarray(head), { seq, echoMs })
  sendBody(socket, 'unreliable', buf.subarray(0, head + n))
}

function capturedSocket(): {
  socket: SocketLike
  receive(data: SocketData): void
  sent: SocketData[]
  closes: number[]
} {
  const messages: Array<(data: SocketData) => void> = []
  const closeListeners: Array<(code: number) => void> = []
  const sent: SocketData[] = []
  const closes: number[] = []
  let open = true
  return {
    socket: {
      send: (data) => { if (open) sent.push(typeof data === 'string' ? data : data.slice()) },
      close: (code = 1000) => {
        if (!open) return
        open = false
        closes.push(code)
        for (const cb of closeListeners.slice()) cb(code)
      },
      onMessage: (cb) => { messages.push(cb) },
      onClose: (cb) => { closeListeners.push(cb) },
      readyState: () => (open ? 'open' : 'closed'),
      bufferedAmount: () => 0,
    },
    receive(data): void { for (const cb of messages.slice()) cb(data) },
    sent,
    closes,
  }
}

const NEUTRAL: Intent = {
  tick: 0, steer: 0, accel: 0, brake: false, drift: false, useItem: false,
}

describe('RoomHub.attach — the handshake', () => {
  it('welcomes a host, seats a guest by code, and broadcasts one lobby per change', () => {
    const { hub } = makeTestHub()
    const room = makeTestRoom(hub, 1, 0)
    const hostSeen = watch(room.host)
    const record = hub.registry().getRoom(room.code)
    expect(record).not.toBeNull()
    expect(record!.seats[0]).not.toBeNull()
    expect(record!.seats[1]).not.toBeNull()

    sendUpdate(room.guests[0], 0, 'guest0')
    expect(hostSeen.filter((seen) => seen.kind === 'lobby')).toHaveLength(0)

    sendUpdate(room.guests[0], CLIENT_FLAG_RTC_FAILED, 'guest0')
    const lobbies = hostSeen.filter((seen) => seen.kind === 'lobby')
    expect(lobbies).toHaveLength(1)
    const lobby = decodeLobby(lobbies[0].payload)
    expect(lobby.slots.filter((slot) => slot.occupied)).toHaveLength(2)
    expect(lobby.hostPlayerId).toBe(0)
  })

  it('closes a version-1 hello with 4001 and writes one rejected line', () => {
    const { hub, log } = makeTestHub()
    const ok = makeTestRoom(hub, 0, 0)
    const fake = capturedSocket()
    hub.attach(fake.socket, 0)

    const buf = new Uint8Array(64)
    const head = encodeHeader(buf, 'hello')
    const n = encodeHello(buf.subarray(head), {
      role: 'guest', roomCode: ok.code, token: '', characterIdx: 0, name: '', trackId: '', flags: 0,
    })
    buf[1] = PROTOCOL_VERSION - 1
    const frame = new Uint8Array(WS_HEADER_BYTES + head + n)
    encodeWsData(frame, 'reliable', WS_SLOT_SERVER, buf.subarray(0, head + n))
    fake.receive(frame)

    expect(fake.closes).toEqual([WS_CLOSE_VERSION_MISMATCH])
    expect(fake.sent).toHaveLength(0)
    expect(log.events().filter((event) =>
      event.kind === 'rejected' && event.result === 'versionMismatch')).toHaveLength(1)
  })

  it('announces a newly joined peer slot to existing WebSocket transports', () => {
    const { hub } = makeTestHub()
    const room = makeTestRoom(hub, 0, 0)
    const controls: Array<{ op: number | null; slot: number }> = []
    room.host.onMessage((data) => {
      if (typeof data === 'string') return
      const frame = decodeWsFrame(data)
      if (frame?.frameKind === WS_FRAME_CONTROL) {
        controls.push({ op: frame.controlOp, slot: frame.peerSlot })
      }
    })

    joinRacingRoom(hub, room.code, 0)
    const record = hub.registry().getRoom(room.code)!
    const guest = record.peers.get(record.seats[1]!)!
    expect(controls).toContainEqual({ op: WS_CONTROL_PEER_JOINED, slot: guest.slot })
  })

  it('closes a socket attached after hub close instead of retaining it', () => {
    const { hub } = makeTestHub()
    hub.close()
    const fake = capturedSocket()
    const handle = hub.attach(fake.socket, 10)
    expect(fake.closes).toEqual([WS_CLOSE_ROOM_CLOSED])
    expect(handle.roomCode()).toBeNull()
  })

  it('expires a provisional socket at an absolute hello deadline despite inbound packets', () => {
    const { hub } = makeTestHub()
    const fake = capturedSocket()
    hub.attach(fake.socket, 0)

    for (let now = 900; now < PEER_STALE_MS; now += 900) {
      hub.poll(now)
      const buf = new Uint8Array(16)
      const head = encodeHeader(buf, 'ping')
      const n = encodeHeartbeat(buf.subarray(head), { seq: now, echoMs: now })
      const frame = new Uint8Array(WS_HEADER_BYTES + head + n)
      encodeWsData(frame, 'unreliable', WS_SLOT_SERVER, buf.subarray(0, head + n))
      fake.receive(frame)
    }
    expect(fake.closes).toEqual([])
    hub.poll(PEER_STALE_MS)
    expect(fake.closes).toHaveLength(1)
  })
})

describe('RoomHub — starting a race', () => {
  it('starts on the host request and refuses a guest request', () => {
    const { hub, log } = makeTestHub()
    const room = makeTestRoom(hub, 1, 0)
    const record = hub.registry().getRoom(room.code)!

    sendUpdate(room.guests[0], CLIENT_FLAG_START_REQUEST)
    expect(record.phase).toBe('lobby')
    expect(record.race).toBeNull()
    expect(log.events().some((event) => event.kind === 'raceStarted')).toBe(false)

    const guestSeen = watch(room.guests[0])
    sendUpdate(room.host, CLIENT_FLAG_START_REQUEST)
    expect(record.phase).toBe('racing')
    expect(record.race).not.toBeNull()
    expect(promotionTickOf(record.race!.shadow)).toBe(-1)
    const starts = guestSeen.filter((seen) => seen.kind === 'start')
    expect(starts).toHaveLength(1)
    const start = decodeStart(starts[0].payload)
    expect(start.trackId).toBe(record.trackId)
    expect(start.humanMask).toBe(0b11)
    expect(start.raceSeed).toBe(record.raceSeed)
    expect(log.events().filter((event) => event.kind === 'raceStarted')).toHaveLength(1)
  })

  it('never starts a second race over a live one', () => {
    const { hub } = makeTestHub()
    const room = makeTestRoom(hub, 0, 0)
    const record = hub.registry().getRoom(room.code)!
    sendUpdate(room.host, CLIENT_FLAG_START_REQUEST)
    const first = record.race
    expect(first).not.toBeNull()
    sendUpdate(room.host, CLIENT_FLAG_START_REQUEST)
    expect(record.race).toBe(first)
  })

  it('sends a late joiner welcome, start, then checkpoint from the shadow state', () => {
    const { hub, log } = makeTestHub()
    const room = makeTestRoom(hub, 0, 0)
    const record = hub.registry().getRoom(room.code)!
    sendUpdate(room.host, CLIENT_FLAG_START_REQUEST)
    for (let now = 8; now <= 800; now += 8) hub.poll(now)
    const shadowTick = record.race!.state.tick
    expect(shadowTick).toBeGreaterThan(30)

    const seen = joinRacingRoom(hub, room.code, 800)
    expect(seen.map((frame) => frame.kind)).toEqual(['welcome', 'lobby', 'start', 'checkpoint'])
    const welcome = decodeWelcome(seen[0].payload)
    expect(welcome.flags & SERVER_FLAG_RACE_IN_PROGRESS).toBe(SERVER_FLAG_RACE_IN_PROGRESS)
    expect(welcome.flags & SERVER_FLAG_CHECKPOINT_NEXT).toBe(SERVER_FLAG_CHECKPOINT_NEXT)
    expect(seen[3].channel).toBe('reliable')

    const checkpointContext = defaultContentProvider.contextFor(record.trackId)!
    const dst = createState(checkpointContext, 0, new Array<number>(MAX_KARTS).fill(0))
    decodeCheckpoint(seen[3].payload, dst)
    expect(dst.tick).toBe(shadowTick)
    expect(log.events().some((event) =>
      event.kind === 'checkpointSent' && event.reason === 'lateJoin')).toBe(true)
  })

  it('promotes the shadow before checkpointing a creator reclaimed mid-race', () => {
    const { hub } = makeTestHub()
    const room = makeTestRoom(hub, 0, 0)
    const record = hub.registry().getRoom(room.code)!
    const token = record.peers.get(record.seats[0]!)!.token
    sendUpdate(room.host, CLIENT_FLAG_START_REQUEST)
    room.host.close()

    const seen = joinRacingRoom(hub, room.code, 10, token)
    expect(seen.map((frame) => frame.kind)).toEqual([
      'welcome', 'lobby', 'start', 'authorityChange', 'checkpoint',
    ])
    const welcome = decodeWelcome(seen[0].payload)
    expect(welcome.playerId).toBe(welcome.hostPlayerId)
    expect(welcome.flags & SERVER_FLAG_IS_HOST).toBe(SERVER_FLAG_IS_HOST)
    const promotion = decodeSeenAuthority(seen[3])
    expect(promotion.tick).toBe(promotionTickOf(record.race!.shadow))
    expect(promotion.tick).toBe(record.race!.state.tick)
    expect(promotion.eventSeq).toBe(record.race!.state.nextEventSeq)
  })

  it('replays an existing promotion before checkpointing a reclaimed creator', () => {
    const { hub } = makeTestHub()
    const room = makeTestRoom(hub, 0, 0)
    const record = hub.registry().getRoom(room.code)!
    const token = record.peers.get(record.seats[0]!)!.token
    sendUpdate(room.host, CLIENT_FLAG_START_REQUEST)
    room.host.close()
    for (let now = 8; now <= 1800; now += 8) hub.poll(now)

    const promotionTick = promotionTickOf(record.race!.shadow)
    const eventSeq = record.race!.state.nextEventSeq
    expect(promotionTick).toBeGreaterThanOrEqual(0)

    const seen = joinRacingRoom(hub, room.code, 1800, token)
    expect(seen.map((frame) => frame.kind)).toEqual([
      'welcome', 'lobby', 'start', 'authorityChange', 'checkpoint',
    ])
    const welcome = decodeWelcome(seen[0].payload)
    expect(welcome.playerId).toBe(welcome.hostPlayerId)
    expect(welcome.flags & SERVER_FLAG_IS_HOST).toBe(SERVER_FLAG_IS_HOST)
    expect(decodeSeenAuthority(seen[3])).toEqual({ tick: promotionTick, eventSeq })
  })

  it('keeps an ordinary guest a guest when its token rejoins a running race', () => {
    const { hub } = makeTestHub()
    const room = makeTestRoom(hub, 1, 0)
    const record = hub.registry().getRoom(room.code)!
    const guest = record.peers.get(record.seats[1]!)!
    const token = guest.token
    const playerId = guest.playerId
    sendUpdate(room.host, CLIENT_FLAG_START_REQUEST)
    room.guests[0].close()

    const seen = joinRacingRoom(hub, room.code, 10, token, 'host')
    const welcome = decodeWelcome(seen[0].payload)
    expect(welcome.playerId).toBe(playerId)
    expect(welcome.playerId).not.toBe(welcome.hostPlayerId)
    expect(welcome.flags & SERVER_FLAG_IS_HOST).toBe(0)
    expect(record.peers.get(record.seats[playerId]!)?.role).toBe('guest')
  })
})

function decodeSeenAuthority(seen: Seen): { tick: number; eventSeq: number } {
  const datagram = new Uint8Array(2 + seen.payload.length)
  encodeHeader(datagram, 'authorityChange')
  datagram.set(seen.payload, 2)
  return decodeAuthorityChange(datagram)
}

function joinRacingRoom(
  hub: ReturnType<typeof makeTestHub>['hub'], code: string, nowMs: number,
  token = '', role: PeerRole = 'guest',
): Seen[] {
  const fake = capturedSocket()
  hub.attach(fake.socket, nowMs)
  const buf = new Uint8Array(64)
  const head = encodeHeader(buf, 'hello')
  const n = encodeHello(buf.subarray(head), {
    role, roomCode: code, token, characterIdx: 0, name: 'late', trackId: '', flags: 0,
  })
  const frame = new Uint8Array(WS_HEADER_BYTES + head + n)
  encodeWsData(frame, 'reliable', WS_SLOT_SERVER, buf.subarray(0, head + n))
  fake.receive(frame)

  const out: Seen[] = []
  for (const raw of fake.sent) {
    if (typeof raw === 'string') continue
    const decoded = decodeWsFrame(raw)
    if (decoded === null || decoded.channel === null || decoded.payload.length < 2) continue
    out.push({
      kind: decodeHeader(decoded.payload).kind,
      channel: decoded.channel,
      payload: decoded.payload.subarray(2).slice(),
    })
  }
  return out
}

describe('RoomHub — liveness and teardown', () => {
  it('makes a closed peer kart bot-driven immediately, frees its slot, and promotes nothing', () => {
    const { hub } = makeTestHub()
    const room = makeTestRoom(hub, 1, 0)
    const record = hub.registry().getRoom(room.code)!
    const guestRecord = record.peers.get(record.seats[1]!)!
    const oldSlot = guestRecord.slot
    sendUpdate(room.host, CLIENT_FLAG_START_REQUEST)
    // ShadowLoop learns peer -> player from the first authorised input. A loss
    // before any claimed input cannot identify a kart by design.
    const input = new Uint8Array(256)
    const inputHead = encodeHeader(input, 'input')
    const intents = new Array<Intent>(8)
    for (let i = 0; i < intents.length; i++) intents[i] = { ...NEUTRAL, tick: i + 1 }
    const inputBytes = encodeInput(input.subarray(inputHead), 1, intents)
    sendBody(room.guests[0], 'unreliable', input.subarray(0, inputHead + inputBytes))
    for (let now = 8; now <= 400; now += 8) hub.poll(now)
    const run = record.race!
    expect(run.state.karts[1].connected).toBe(true)

    const controls: Array<{ op: number | null; slot: number }> = []
    room.host.onMessage((data) => {
      if (typeof data === 'string') return
      const frame = decodeWsFrame(data)
      if (frame?.frameKind === WS_FRAME_CONTROL) {
        controls.push({ op: frame.controlOp, slot: frame.peerSlot })
      }
    })

    room.guests[0].close()
    hub.poll(408)
    expect(run.state.karts[1].connected).toBe(false)
    expect(guestRecord.connected).toBe(false)
    expect(record.slotsInUse.has(oldSlot)).toBe(false)
    expect(controls).toContainEqual({ op: WS_CONTROL_PEER_GONE, slot: oldSlot })
    expect(promotionTickOf(run.shadow)).toBe(-1)
  })

  it('uses a monotonic ping sequence after an accepted pong', () => {
    const { hub } = makeTestHub()
    const room = makeTestRoom(hub, 0, 0)
    const seen = watch(room.host)
    hub.poll(1000)
    const first = seen.find((frame) => frame.kind === 'ping')
    expect(first).toBeDefined()
    const firstPing = decodeHeartbeat(first!.payload)
    sendHeartbeat(room.host, 'pong', firstPing.seq, firstPing.echoMs)

    hub.poll(2000)
    const pings = seen.filter((frame) => frame.kind === 'ping').map((frame) => decodeHeartbeat(frame.payload))
    expect(pings).toHaveLength(2)
    expect(pings[1].seq).not.toBe(pings[0].seq)
  })

  it('counts a valid text signal as proof of life', () => {
    const { hub } = makeTestHub()
    const room = makeTestRoom(hub, 1, 0)
    const record = hub.registry().getRoom(room.code)!
    const host = record.peers.get(record.seats[0]!)!
    const guest = record.peers.get(record.seats[1]!)!
    expect(guest.liveness.lastSeenMs).toBe(0)
    hub.poll(100)
    room.guests[0].send(encodeSignal({
      v: SIGNAL_VERSION,
      from: guest.slot,
      to: host.slot,
      msg: { t: 'iceDone' },
    }))
    expect(guest.liveness.lastSeenMs).toBe(100)
    expect(guest.lastSeenMs).toBe(100)
  })

  it('close disposes shadows and sockets without promotion, idempotently', () => {
    const { hub, log } = makeTestHub()
    const room = makeTestRoom(hub, 1, 0)
    const record = hub.registry().getRoom(room.code)!
    sendUpdate(room.host, CLIENT_FLAG_START_REQUEST)
    for (let now = 8; now <= 400; now += 8) hub.poll(now)
    const hostSeen = watch(room.host)
    hub.close()
    expect(record.race).toBeNull()
    expect(room.host.readyState()).toBe('closed')
    expect(hostSeen.some((frame) => frame.kind === 'authorityChange')).toBe(false)
    expect(log.events().some((event) => event.kind === 'promotion')).toBe(false)
    hub.close()
  })
})

describe('SimContext freshness across rooms', () => {
  it('one room promotion leaves every other room a follower', () => {
    const { hub } = makeTestHub()
    const a = makeTestRoom(hub, 0, 0)
    sendUpdate(a.host, CLIENT_FLAG_START_REQUEST)
    const roomA = hub.registry().getRoom(a.code)!

    let now = 0
    for (; now <= 2000; now += 8) hub.poll(now)

    const b = makeTestRoom(hub, 0, now)
    sendUpdate(b.host, CLIENT_FLAG_START_REQUEST)
    const roomB = hub.registry().getRoom(b.code)!
    expect(roomA.race!.ctx).not.toBe(roomB.race!.ctx)
    const bSeqBefore = roomB.race!.state.nextEventSeq
    const bTickBefore = roomB.race!.state.tick

    for (; now <= 2500; now += 8) hub.poll(now)
    expect(promotionTickOf(roomA.race!.shadow)).toBeGreaterThanOrEqual(0)
    expect(roomA.race!.ctx.isLeader).toBe(true)
    expect(roomB.race!.ctx.isLeader).toBe(false)
    expect(promotionTickOf(roomB.race!.shadow)).toBe(-1)
    expect(roomB.race!.state.nextEventSeq).toBe(bSeqBefore)
    expect(roomB.race!.state.tick).toBeGreaterThan(bTickBefore + 20)
  })
})

describe('end-to-end in-process promotion', () => {
  it('keeps snapshots flowing, rewinds nothing, and repeats no event sequence', () => {
    const { hub } = makeTestHub()
    const room = makeTestRoom(hub, 1, 0)
    const record = hub.registry().getRoom(room.code)!

    sendUpdate(room.guests[0], CLIENT_FLAG_RTC_FAILED)
    const hostSlot = record.peers.get(record.seats[0]!)!.slot
    const guestSlot = record.peers.get(record.seats[1]!)!.slot
    const hostSeen = watch(room.host)
    const guestSeen = watch(room.guests[0])
    sendUpdate(room.host, CLIENT_FLAG_START_REQUEST)

    const startFrame = guestSeen.find((frame) => frame.kind === 'start')
    expect(startFrame).toBeDefined()
    const start: StartMessage = decodeStart(startFrame!.payload)
    const hostTransport = makeWebSocketTransport({ socket: room.host, selfSlot: hostSlot })
    const guestTransport = makeWebSocketTransport({ socket: room.guests[0], selfSlot: guestSlot })

    const hostCtx: SimContext = defaultContentProvider.contextFor(start.trackId)!
    const hostState = createState(hostCtx, start.raceSeed, start.characterIdx)
    for (let i = 0; i < MAX_KARTS; i++) {
      const human = ((start.humanMask >>> i) & 1) === 1
      hostState.karts[i].isBot = !human
      hostState.karts[i].connected = human
    }
    const host = new AuthorityLoop(hostCtx, hostState, hostTransport)

    const guestCtx: SimContext = defaultContentProvider.contextFor(start.trackId)!
    const guest = new ClientLoop(guestCtx, 1, guestTransport)
    guest.beginRace(start.raceSeed, start.characterIdx, start.humanMask)

    const events: AuthEvent[] = []
    const seenSeq = new Set<number>()
    let duplicateSeq = 0
    let eventFrames = 0
    let authorityTick = -1
    let authorityEventSeq = -1
    let snapshotsAfterPromotion = 0
    guestTransport.onMessage((_peerId, _channel, data) => {
      if (data.length < 2) return
      const kind = decodeHeader(data).kind
      if (kind === 'authorityChange') {
        const change = decodeAuthorityChange(data)
        authorityTick = change.tick
        authorityEventSeq = change.eventSeq
      } else if (kind === 'snapshot') {
        if (authorityTick >= 0) snapshotsAfterPromotion += 1
      } else if (kind === 'events') {
        events.length = 0
        decodeEvents(data.subarray(2), events)
        eventFrames += 1
        for (const event of events) {
          if (seenSeq.has(event.eventSeq)) duplicateSeq += 1
          seenSeq.add(event.eventSeq)
        }
      }
    })

    const hostAcc = makeTickAccumulator()
    const guestAcc = makeTickAccumulator()
    let hostLast = 0
    let guestLast = 0
    let hostAlive = true
    let guestTicks = 0
    const laps = new Array<number>(MAX_KARTS).fill(0)
    let maxLap = 0

    const runTo = (until: number, from: number): number => {
      let now = from
      for (; now <= until; now += 8) {
        hub.poll(now)
        if (hostAlive) {
          const n = advanceAccumulator(hostAcc, now - hostLast)
          hostLast = now
          for (let i = 0; i < n; i++) host.tick()
        }
        const guestCount = advanceAccumulator(guestAcc, now - guestLast)
        guestLast = now
        for (let i = 0; i < guestCount; i++) {
          guestTicks += 1
          guest.tick({ ...NEUTRAL, tick: guestTicks, accel: 1 })
        }
        const state = guest.state()
        for (let i = 0; i < MAX_KARTS; i++) {
          expect(state.karts[i].lap.lap).toBeGreaterThanOrEqual(laps[i])
          laps[i] = state.karts[i].lap.lap
          if (laps[i] > maxLap) maxLap = laps[i]
        }
      }
      return now
    }

    let now = runTo(10_000, 8)
    expect(record.race!.state.tick).toBeGreaterThan(500)
    expect(host.state().tick).toBeGreaterThan(500)
    expect(guest.state().tick).toBeGreaterThan(500)
    expect(hostSeen.length + guestSeen.length).toBeGreaterThan(0)
    expect(eventFrames).toBeGreaterThan(0)
    expect(promotionTickOf(record.race!.shadow)).toBe(-1)

    hostAlive = false
    const silentAt = now
    now = runTo(silentAt + 1400, now)
    expect(promotionTickOf(record.race!.shadow)).toBe(-1)
    now = runTo(silentAt + 1700, now)
    const promotionTick = promotionTickOf(record.race!.shadow)
    expect(promotionTick).toBeGreaterThanOrEqual(0)
    expect(authorityTick).toBe(promotionTick)
    expect(authorityEventSeq).toBeGreaterThanOrEqual(0)

    now = runTo(now + 1000, now)
    expect(snapshotsAfterPromotion).toBeGreaterThan(10)
    expect(guest.state().nextEventSeq).toBeGreaterThanOrEqual(authorityEventSeq)
    expect(duplicateSeq).toBe(0)
    expect(maxLap).toBeGreaterThan(0)
    expect(guest.state().entityCount).toBeLessThanOrEqual(MAX_ENTITIES)
  })
})
