### Task 14: `packages/net/src/roomclient.ts` — the client half of the lobby handshake

**Files:**
- Create: `packages/net/src/roomclient.ts`
- Test: `packages/net/test/roomclient.test.ts`

**Interfaces:**

- **Consumes** — from `@tapkart/protocol`, contract §3.3 (`lobby.ts`) and §3.4 (`control.ts`), quoted:

  ```ts
  export type PeerRole = 'host' | 'guest'
  export const CLIENT_FLAG_WEBRTC          = 1 << 0
  export const CLIENT_FLAG_READY           = 1 << 1
  export const CLIENT_FLAG_START_REQUEST   = 1 << 2
  export const CLIENT_FLAG_RTC_FAILED      = 1 << 3
  export const SERVER_FLAG_IS_HOST          = 1 << 0
  export const SERVER_FLAG_RACE_IN_PROGRESS = 1 << 1
  export const SERVER_FLAG_RELAY_ASSIGNED   = 1 << 2
  export const SERVER_FLAG_RELAY_FIRST      = 1 << 3
  export const SERVER_FLAG_CHECKPOINT_NEXT  = 1 << 4
  export type JoinResult =
    | 'ok' | 'roomNotFound' | 'roomFull' | 'roomClosed'
    | 'versionMismatch' | 'badRequest' | 'rateLimited'
  export type ResyncReason = 'lateJoin' | 'divergence'

  export interface HelloMessage {
    role: PeerRole; roomCode: string; token: string; characterIdx: number
    name: string; trackId: string; flags: number
  }
  export interface ClientUpdateMessage {
    flags: number; characterIdx: number; name: string; trackId: string
  }
  export interface WelcomeMessage {
    result: JoinResult; roomCode: string; playerId: number; token: string
    hostPlayerId: number; peerSlot: number; flags: number; lobbyVersion: number
  }
  export interface WireLobbySlot {
    occupied: boolean; isBot: boolean; connected: boolean; ready: boolean
    characterIdx: number; peerSlot: number; name: string
  }
  export interface LobbyMessage {
    lobbyVersion: number; hostPlayerId: number; trackId: string; slots: WireLobbySlot[]
  }
  export interface StartMessage {
    raceSeed: number; trackId: string; humanMask: number; characterIdx: number[]
  }
  export interface ResyncRequestMessage { reason: ResyncReason; lastTick: number }
  export interface HeartbeatMessage { seq: number; echoMs: number }

  export function encodeHello(out: Uint8Array, msg: HelloMessage): number
  export function encodeClientUpdate(out: Uint8Array, msg: ClientUpdateMessage): number
  export function encodeResyncRequest(out: Uint8Array, msg: ResyncRequestMessage): number
  export function encodeHeartbeat(out: Uint8Array, msg: HeartbeatMessage): number
  export function decodeWelcome(buf: Uint8Array): WelcomeMessage
  export function decodeLobby(buf: Uint8Array): LobbyMessage
  export function decodeStart(buf: Uint8Array): StartMessage
  export function decodeHeartbeat(buf: Uint8Array): HeartbeatMessage
  export function encodeHeader(out: Uint8Array, kind: MessageKind): number   // returns 2
  export function normalizeRoomCode(input: string): string                   // trim + uppercase, total
  export type ChannelName = 'unreliable' | 'reliable'
  export type MessageKind = /* 13 members */ 'hello' | 'welcome' | /* … */ 'pong'
  ```

- **Consumes** — from `packages/net/src` (relative, same package):

  ```ts
  // ./transport
  export interface Transport {
    send(channel: ChannelName, peerId: string, data: Uint8Array): void
    broadcast(channel: ChannelName, data: Uint8Array): void
    onMessage(cb: (peerId: string, channel: ChannelName, data: Uint8Array) => void): void
    onPeerLost(cb: (peerId: string) => void): void
    peers(): string[]
    close(): void
  }
  // ./receive  (shipped, Plan 2 Task 15b)
  export interface DatagramGuard {
    wrap(handle: (peerId: string, channel: ChannelName, kind: MessageKind, payload: Uint8Array) => void):
      (peerId: string, channel: ChannelName, data: Uint8Array) => void
    decode<T>(decode: (buf: Uint8Array, out: T) => void, buf: Uint8Array, out: T): boolean
    dropped(): number
  }
  export function createDatagramGuard(owner: object): DatagramGuard
  export function droppedDatagramsOf(loop: object): number
  // ./shadow  (shipped) — VALIDATES ITS OWN HEADER, so it takes the WHOLE datagram
  export function decodeAuthorityChange(buf: Uint8Array): { tick: number; eventSeq: number }
  export const AUTHORITY_CHANGE_BYTES = 10
  // ./clock   (shipped)
  export const TICK_MS = 1000 / TICK_HZ
  // ./liveness  (Task 13)
  export interface LivenessState {
    lastSeenMs: number; lastPingSentMs: number; lastPingSeq: number
    rttMs: number; pingsSent: number; pongsSeen: number
  }
  export const PING_INTERVAL_MS = 1000
  export const PEER_STALE_MS = 5000
  export function createLiveness(nowMs: number): LivenessState
  export function notePacket(l: LivenessState, nowMs: number): void
  export function shouldSendPing(l: LivenessState, nowMs: number, intervalMs?: number): boolean
  export function notePingSent(l: LivenessState, seq: number, nowMs: number): void
  export function notePong(l: LivenessState, msg: HeartbeatMessage, nowMs: number): void
  export function isStale(l: LivenessState, nowMs: number, timeoutMs?: number): boolean
  // ./socket   (contract §4.1)
  export const WS_CLOSE_VERSION_MISMATCH = 4001
  export const WS_CLOSE_ROOM_CLOSED      = 4002
  export const WS_CLOSE_BACKPRESSURE     = 4003
  // ./wsframe  (contract §4.2)
  export const WS_SLOT_SERVER = 0x00
  // ./webrtc   (contract §4.5)
  export const RTC_CONNECT_TIMEOUT_MS = 4000
  ```

- **Consumes** — from `@tapkart/sim`: `export const COUNTDOWN_TICKS = 180`, `export const MAX_KARTS = 8`.

- **Produces** — contract §4.9, seven exported symbols (census §11: `net/roomclient` = 7):

  ```ts
  export type RoomPhase = 'idle' | 'connecting' | 'lobby' | 'starting' | 'racing' | 'closed'
  export interface RoomClientState {
    phase: RoomPhase
    playerId: number; peerSlot: number
    roomCode: string; token: string; hostPlayerId: number
    lobby: LobbyMessage | null; start: StartMessage | null
    authorityTick: number; authorityEventSeq: number
    relayMode: boolean; relayFirst: boolean; serverLost: boolean
    error: string
  }
  export interface RoomClientOptions {
    transport: Transport; role: PeerRole; name: string; characterIdx: number
    roomCode: string; token: string; trackId: string
  }
  export interface RoomClientUpdate { name?: string; characterIdx?: number; ready?: boolean; trackId?: string }
  export class RoomClient { /* the members contract §4.9 fixes, plus the two below */ }
  export const HARD_RESYNC_LIMIT = 3
  export const HARD_RESYNC_WINDOW_TICKS = 600
  ```

**Four decisions this task makes, because the contract fixes the signatures and not these. Each is stated here so no later task has to guess.**

1. **Every message this class sends is addressed to the peer at `WS_SLOT_SERVER`, never broadcast.** Contract §4.3: *"`peers()` is every slot learned from a `WS_CONTROL_PEER_JOINED` frame, minus `selfSlot`, plus the constant peer for `WS_SLOT_SERVER`"*, with the default mapping `(s) => 'p' + s`. `broadcast` on that transport emits **one frame addressed to `WS_SLOT_BROADCAST`, which the server fans out to the other peers** — so a `hello` sent by broadcast reaches every guest and never the room. This module therefore addresses `` `p${WS_SLOT_SERVER}` ``, and a transport constructed with a custom `peerIdOfSlot` must keep slot 0 mapping to that string (which the server's room transport does, §4.3: *"the server's room transport passes its own so ids match across both ends of a test"*).

2. **Two additive members**, declared here because contract §4.9 gives `RoomClient` no way to learn either fact and both are behaviour the contract requires of it. Contract §0's escape hatch is explicit: *"A task needing something absent must define it in its own files and say so in its `Interfaces` block."*

   ```ts
   /** The socket's close code. `Transport` carries no close channel, and §4.1
    *  assigns the 4001 -> 'versionMismatch' / 4002 -> 'roomClosed' mapping to
    *  this class - "the entire mechanism by which a client that cannot even
    *  parse the server's messages still learns why". Wire it as
    *  `socket.onClose((code) => room.noteSocketClosed(code))`. */
   noteSocketClosed(code: number): void
   /** The WebRTC link to the host came up. Cancels the give-up timer §4.5 puts
    *  in this class rather than in the transport ("giving up means asking the
    *  server for relay, which is a room decision and not a transport one"). A
    *  RoomClient never told would ask for relay 4 s into a working direct
    *  connection. */
   noteRtcConnected(): void
   ```

3. **`'starting'` becomes `'racing'` on the countdown, measured from the `start` message in `poll(nowMs)`** — `COUNTDOWN_TICKS * TICK_MS` = 3000 ms. No message announces it: `createState` begins every peer at `phase: 'countdown'` and `phase.ts` flips at `COUNTDOWN_TICKS` off a tick counter every peer runs identically (contract §2.7), so the room phase follows the same clock rather than inventing a second source of truth.

4. **Everything clock-dependent happens inside `poll(nowMs)`.** A message handler has no `nowMs` — contract §4.9 calls `poll` *"the one clocked entry point"* — so an inbound datagram sets a flag and an inbound `pong` is stashed, and the next `poll` folds both into the liveness state. The cost is up to one poll interval of RTT overestimate, which is the honest price of a single injected clock; the alternative is `Date.now()` inside `net`, which contract §0 forbids outright.

---

- [ ] **Step 1: Write the failing test**

Create `packages/net/test/roomclient.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type {
  ChannelName,
  HeartbeatMessage,
  LobbyMessage,
  MessageKind,
  StartMessage,
  WelcomeMessage,
  WireLobbySlot,
} from '@tapkart/protocol'
import {
  CLIENT_FLAG_READY,
  CLIENT_FLAG_RTC_FAILED,
  CLIENT_FLAG_START_REQUEST,
  CLIENT_FLAG_WEBRTC,
  SERVER_FLAG_IS_HOST,
  SERVER_FLAG_RELAY_FIRST,
  decodeClientUpdate,
  decodeHeader,
  decodeHeartbeat,
  decodeHello,
  decodeResyncRequest,
  encodeHeader,
  encodeHeartbeat,
  encodeLobby,
  encodeStart,
  encodeWelcome,
} from '@tapkart/protocol'
import { MAX_KARTS } from '@tapkart/sim'
import { droppedDatagramsOf } from '../src/receive'
import type { RoomClientOptions } from '../src/roomclient'
import { HARD_RESYNC_LIMIT, HARD_RESYNC_WINDOW_TICKS, RoomClient } from '../src/roomclient'
import { encodeAuthorityChange } from '../src/shadow'
import type { Transport } from '../src/transport'

const SERVER = 'p0'

interface Sent {
  channel: ChannelName
  peerId: string
  data: Uint8Array
  kind: MessageKind
}

interface FakeTransport extends Transport {
  deliver(channel: ChannelName, data: Uint8Array): void
  sent(): Sent[]
  sentOf(kind: MessageKind): Sent[]
  broadcasts(): number
  closed(): number
}

function makeFakeTransport(): FakeTransport {
  const cbs: ((peerId: string, channel: ChannelName, data: Uint8Array) => void)[] = []
  const sent: Sent[] = []
  let broadcasts = 0
  let closes = 0
  return {
    send(channel, peerId, data) {
      // decodeHeader throws on an unknown tag, which is exactly the assertion
      // wanted here: everything this client sends is a real, current-version
      // message.
      sent.push({ channel, peerId, data, kind: decodeHeader(data).kind })
    },
    broadcast() {
      broadcasts++
    },
    onMessage(cb) {
      cbs.push(cb)
    },
    onPeerLost() {
      /* the control transport's peer loss is not this class's signal */
    },
    peers: () => [SERVER],
    close() {
      closes++
    },
    deliver(channel, data) {
      for (const cb of cbs) cb(SERVER, channel, data)
    },
    sent: () => sent,
    sentOf: (kind) => sent.filter((s) => s.kind === kind),
    broadcasts: () => broadcasts,
    closed: () => closes,
  }
}

function body(s: Sent): Uint8Array {
  return s.data.subarray(2)
}

function opts(t: Transport, over: Partial<RoomClientOptions> = {}): RoomClientOptions {
  return {
    transport: t,
    role: 'guest',
    name: 'Ada',
    characterIdx: 3,
    roomCode: 'ABCDE',
    token: '',
    trackId: '',
    ...over,
  }
}

function emptySlot(): WireLobbySlot {
  return { occupied: false, isBot: true, connected: false, ready: false, characterIdx: 0, peerSlot: 0, name: '' }
}

function lobbyMessage(over: Partial<LobbyMessage> = {}): LobbyMessage {
  const slots: WireLobbySlot[] = []
  for (let i = 0; i < MAX_KARTS; i++) slots.push(emptySlot())
  slots[0] = { occupied: true, isBot: false, connected: true, ready: true, characterIdx: 1, peerSlot: 1, name: 'Grace' }
  slots[1] = { occupied: true, isBot: false, connected: true, ready: false, characterIdx: 3, peerSlot: 2, name: 'Ada' }
  return { lobbyVersion: 4, hostPlayerId: 0, trackId: 'caldera', slots, ...over }
}

function startMessage(over: Partial<StartMessage> = {}): StartMessage {
  return {
    raceSeed: 0x0badc0de,
    trackId: 'caldera',
    humanMask: 0b11,
    characterIdx: [1, 3, 0, 0, 0, 0, 0, 0],
    ...over,
  }
}

function welcome(over: Partial<WelcomeMessage> = {}): WelcomeMessage {
  return {
    result: 'ok',
    roomCode: 'ABCDE',
    playerId: 1,
    token: '0123456789AB',
    hostPlayerId: 0,
    peerSlot: 2,
    flags: 0,
    lobbyVersion: 4,
    ...over,
  }
}

function datagram(kind: MessageKind, encode: (out: Uint8Array) => number, size = 512): Uint8Array {
  const buf = new Uint8Array(size)
  const h = encodeHeader(buf, kind)
  const n = encode(buf.subarray(h))
  return buf.slice(0, h + n)
}

const welcomeBytes = (m: WelcomeMessage): Uint8Array => datagram('welcome', (out) => encodeWelcome(out, m))
const lobbyBytes = (m: LobbyMessage): Uint8Array => datagram('lobby', (out) => encodeLobby(out, m))
const startBytes = (m: StartMessage): Uint8Array => datagram('start', (out) => encodeStart(out, m))
const heartbeatBytes = (kind: 'ping' | 'pong', m: HeartbeatMessage): Uint8Array =>
  datagram(kind, (out) => encodeHeartbeat(out, m), 16)

function authorityChangeBytes(tick: number, eventSeq: number): Uint8Array {
  const buf = new Uint8Array(16)
  const n = encodeAuthorityChange(buf, tick, eventSeq)
  return buf.slice(0, n)
}

/** A header and two body bytes, built with encodeHeader so this file says
 * nothing about PROTOCOL_VERSION. */
function taggedDatagram(kind: MessageKind): Uint8Array {
  const buf = new Uint8Array(4)
  encodeHeader(buf, kind)
  return buf
}

/** A welcomed guest, polled once so its liveness state exists. */
function welcomed(over: Partial<WelcomeMessage> = {}, o: Partial<RoomClientOptions> = {}): {
  t: FakeTransport
  room: RoomClient
} {
  const t = makeFakeTransport()
  const room = new RoomClient(opts(t, o))
  room.connect()
  t.deliver('reliable', welcomeBytes(welcome(over)))
  room.poll(0)
  return { t, room }
}

describe('RoomClient - the handshake', () => {
  it('drives the phase idle -> connecting -> lobby -> starting -> racing, in order', () => {
    const t = makeFakeTransport()
    const room = new RoomClient(opts(t))
    expect(room.state().phase).toBe('idle')

    room.connect()
    expect(room.state().phase).toBe('connecting')

    t.deliver('reliable', welcomeBytes(welcome()))
    expect(room.state().phase).toBe('lobby')

    t.deliver('reliable', lobbyBytes(lobbyMessage()))
    expect(room.state().phase).toBe('lobby')

    t.deliver('reliable', startBytes(startMessage()))
    expect(room.state().phase).toBe('starting')

    room.poll(10_000) // arms the countdown
    expect(room.state().phase).toBe('starting')
    room.poll(12_999)
    expect(room.state().phase).toBe('starting')
    room.poll(13_000) // COUNTDOWN_TICKS * TICK_MS = 3000 ms after the start
    expect(room.state().phase).toBe('racing')
  })

  it('sends exactly one hello, to the server peer, on the reliable channel', () => {
    const t = makeFakeTransport()
    const room = new RoomClient(opts(t, { role: 'host', roomCode: '', name: 'Grace', characterIdx: 1, trackId: 'caldera' }))
    room.connect()
    room.connect()
    room.connect()

    expect(t.sentOf('hello')).toHaveLength(1)
    const hello = t.sentOf('hello')[0]
    expect(hello.channel).toBe('reliable')
    expect(hello.peerId).toBe(SERVER)
    expect(t.broadcasts()).toBe(0) // a broadcast frame is fanned out to guests, never to the room

    const m = decodeHello(body(hello))
    expect(m.role).toBe('host')
    expect(m.roomCode).toBe('')
    expect(m.token).toBe('')
    expect(m.name).toBe('Grace')
    expect(m.characterIdx).toBe(1)
    expect(m.trackId).toBe('caldera')
    expect(m.flags & CLIENT_FLAG_WEBRTC).toBe(CLIENT_FLAG_WEBRTC)
  })

  it('normalises the room code it was given, and carries a reconnect token', () => {
    const t = makeFakeTransport()
    const room = new RoomClient(opts(t, { roomCode: ' abcde ', token: '0123456789AB' }))
    room.connect()

    const m = decodeHello(body(t.sentOf('hello')[0]))
    expect(m.roomCode).toBe('ABCDE')
    expect(m.token).toBe('0123456789AB')
  })

  it('records what the welcome said', () => {
    const { room } = welcomed({ flags: SERVER_FLAG_IS_HOST })
    const s = room.state()
    expect(s.playerId).toBe(1)
    expect(s.peerSlot).toBe(2)
    expect(s.token).toBe('0123456789AB')
    expect(s.roomCode).toBe('ABCDE')
    expect(s.hostPlayerId).toBe(0)
    expect(s.error).toBe('')
    expect(s.relayFirst).toBe(false)
  })

  it('fires onWelcome, onLobby and onStart with the decoded messages', () => {
    const t = makeFakeTransport()
    const room = new RoomClient(opts(t))
    const seen: string[] = []
    let gotSeed = -1
    room.onWelcome((m) => seen.push(`welcome:${m.result}`))
    room.onLobby((m) => seen.push(`lobby:${m.lobbyVersion}`))
    room.onStart((m) => {
      seen.push('start')
      gotSeed = m.raceSeed
    })

    room.connect()
    t.deliver('reliable', welcomeBytes(welcome()))
    t.deliver('reliable', lobbyBytes(lobbyMessage()))
    t.deliver('reliable', startBytes(startMessage()))

    expect(seen).toEqual(['welcome:ok', 'lobby:4', 'start'])
    expect(gotSeed).toBe(0x0badc0de)
    expect(room.state().lobby?.slots[1].name).toBe('Ada')
    expect(room.state().start?.humanMask).toBe(0b11)
  })
})

describe('RoomClient - a refused join', () => {
  it('ends in closed with the JoinResult in error, and fires onClosed once', () => {
    const t = makeFakeTransport()
    const room = new RoomClient(opts(t))
    const closed: string[] = []
    room.onClosed((reason) => closed.push(reason))

    room.connect()
    t.deliver('reliable', welcomeBytes(welcome({ result: 'rateLimited', playerId: -1, token: '' })))

    expect(room.state().phase).toBe('closed')
    expect(room.state().error).toBe('rateLimited')
    expect(room.state().playerId).toBe(-1)
    expect(closed).toEqual(['rateLimited'])
  })

  it('sends nothing at all once closed', () => {
    const t = makeFakeTransport()
    const room = new RoomClient(opts(t))
    room.connect()
    t.deliver('reliable', welcomeBytes(welcome({ result: 'roomNotFound', playerId: -1, token: '' })))
    const after = t.sent().length

    room.update({ ready: true })
    room.requestStart()
    room.requestResync('divergence', 120)
    room.reportRtcFailed()
    room.poll(10_000)
    room.poll(60_000)

    expect(t.sent()).toHaveLength(after)
    expect(room.state().phase).toBe('closed')
  })
})

describe('RoomClient - update, start and resync', () => {
  it('sends a clientUpdate and never a second hello', () => {
    const { t, room } = welcomed()
    room.update({ ready: true, name: 'Ada L', characterIdx: 5 })

    expect(t.sentOf('hello')).toHaveLength(1)
    expect(t.sentOf('clientUpdate')).toHaveLength(1)
    const m = decodeClientUpdate(body(t.sentOf('clientUpdate')[0]))
    expect(m.flags & CLIENT_FLAG_READY).toBe(CLIENT_FLAG_READY)
    expect(m.name).toBe('Ada L')
    expect(m.characterIdx).toBe(5)
    expect(m.trackId).toBe('') // '' = no change
  })

  it('remembers the declaration across updates, so clearing ready keeps the name', () => {
    const { t, room } = welcomed()
    room.update({ name: 'Ada L', ready: true })
    room.update({ ready: false })

    const m = decodeClientUpdate(body(t.sentOf('clientUpdate')[1]))
    expect(m.flags & CLIENT_FLAG_READY).toBe(0)
    expect(m.name).toBe('Ada L')
  })

  it('carries a track choice when one is given', () => {
    const { t, room } = welcomed({}, { role: 'host' })
    room.update({ trackId: 'saltflat' })
    expect(decodeClientUpdate(body(t.sentOf('clientUpdate')[0])).trackId).toBe('saltflat')
  })

  it('requestStart sets START_REQUEST for a host and sends nothing for a guest', () => {
    const host = welcomed({}, { role: 'host' })
    host.room.requestStart()
    expect(host.t.sentOf('clientUpdate')).toHaveLength(1)
    expect(decodeClientUpdate(body(host.t.sentOf('clientUpdate')[0])).flags & CLIENT_FLAG_START_REQUEST)
      .toBe(CLIENT_FLAG_START_REQUEST)

    const guest = welcomed({}, { role: 'guest' })
    guest.room.requestStart()
    expect(guest.t.sentOf('clientUpdate')).toHaveLength(0)
  })

  it('requestResync sends the reason and the tick', () => {
    const { t, room } = welcomed()
    room.requestResync('divergence', 742)
    const m = decodeResyncRequest(body(t.sentOf('resyncRequest')[0]))
    expect(m.reason).toBe('divergence')
    expect(m.lastTick).toBe(742)
  })
})

describe('RoomClient - the WebRTC give-up timer', () => {
  it('sends CLIENT_FLAG_RTC_FAILED exactly once, at RTC_CONNECT_TIMEOUT_MS', () => {
    const { t, room } = welcomed()
    room.poll(3999)
    expect(t.sentOf('clientUpdate')).toHaveLength(0)

    room.poll(4000)
    expect(t.sentOf('clientUpdate')).toHaveLength(1)
    expect(decodeClientUpdate(body(t.sentOf('clientUpdate')[0])).flags & CLIENT_FLAG_RTC_FAILED)
      .toBe(CLIENT_FLAG_RTC_FAILED)
    expect(room.state().relayMode).toBe(true)

    room.poll(8000)
    room.poll(30_000)
    expect(t.sentOf('clientUpdate')).toHaveLength(1)
  })

  it('never fires it once the link is up', () => {
    const { t, room } = welcomed()
    room.noteRtcConnected()
    room.poll(4000)
    room.poll(30_000)
    expect(t.sentOf('clientUpdate')).toHaveLength(0)
    expect(room.state().relayMode).toBe(false)
  })

  it('never fires it for a relay-first room, which is already relaying', () => {
    const { t, room } = welcomed({ flags: SERVER_FLAG_RELAY_FIRST })
    expect(room.state().relayFirst).toBe(true)
    expect(room.state().relayMode).toBe(true)
    room.poll(4000)
    room.poll(30_000)
    expect(t.sentOf('clientUpdate')).toHaveLength(0)
  })

  it('reportRtcFailed is idempotent when the app calls it too', () => {
    const { t, room } = welcomed()
    room.reportRtcFailed()
    room.reportRtcFailed()
    room.poll(9000)
    expect(t.sentOf('clientUpdate')).toHaveLength(1)
  })
})

describe('RoomClient - heartbeats', () => {
  it('pings the server once a second, on the unreliable channel', () => {
    const { t, room } = welcomed()
    for (let now = 0; now <= 3000; now += 16) room.poll(now)

    const pings = t.sentOf('ping')
    expect(pings.length).toBeGreaterThanOrEqual(2)
    expect(pings[0].channel).toBe('unreliable')
    expect(pings[0].peerId).toBe(SERVER)
    const first = decodeHeartbeat(body(pings[0]))
    const second = decodeHeartbeat(body(pings[1]))
    expect(second.seq).not.toBe(first.seq)
    expect(second.echoMs - first.echoMs).toBeGreaterThanOrEqual(1000)
  })

  it('answers a ping with a pong that copies seq and echoMs verbatim', () => {
    const { t, room } = welcomed()
    t.deliver('unreliable', heartbeatBytes('ping', { seq: 41, echoMs: 123_456 }))

    const pongs = t.sentOf('pong')
    expect(pongs).toHaveLength(1)
    expect(pongs[0].channel).toBe('unreliable')
    const m = decodeHeartbeat(body(pongs[0]))
    // A receiver that stamped its OWN time here would turn RTT into clock skew,
    // and nothing would fail loudly.
    expect(m).toEqual({ seq: 41, echoMs: 123_456 })
  })
})

describe('RoomClient - a socket that goes quiet', () => {
  it('closes the room when nothing arrives for PEER_STALE_MS, before the race', () => {
    const { t, room } = welcomed()
    const closed: string[] = []
    room.onClosed((reason) => closed.push(reason))

    room.poll(4999)
    expect(room.state().phase).toBe('lobby')
    room.poll(5000)
    expect(room.state().phase).toBe('closed')
    expect(room.state().error).toBe('serverLost')
    expect(closed).toEqual(['serverLost'])

    room.poll(10_000)
    expect(closed).toHaveLength(1)
    expect(t.closed()).toBe(0) // the socket is the composition root's to close
  })

  it('keeps racing and only sets serverLost when the socket dies mid-race (F-P4-24)', () => {
    const { t, room } = welcomed()
    const closed: string[] = []
    room.onClosed((reason) => closed.push(reason))
    t.deliver('reliable', startBytes(startMessage()))
    room.poll(0)
    room.poll(3000)
    expect(room.state().phase).toBe('racing')

    room.poll(9000)

    // The race KEEPS RUNNING host-authoritative over WebRTC. Tearing it down
    // because the BACKUP authority died is the worst of the three options.
    expect(room.state().phase).toBe('racing')
    expect(room.state().serverLost).toBe(true)
    expect(closed).toEqual([])
  })

  it('does not go stale while pongs keep coming back', () => {
    const { t, room } = welcomed()
    let answered = 0
    for (let now = 0; now <= 20_000; now += 16) {
      room.poll(now)
      const pings = t.sentOf('ping')
      // The far side echoes seq and echoMs unchanged.
      while (answered < pings.length) {
        t.deliver('unreliable', heartbeatBytes('pong', decodeHeartbeat(body(pings[answered]))))
        answered++
      }
    }
    expect(answered).toBeGreaterThanOrEqual(19)
    expect(room.state().phase).toBe('lobby')
    expect(room.state().serverLost).toBe(false)
  })
})

describe('RoomClient - close codes', () => {
  it('maps 4001 onto versionMismatch', () => {
    const t = makeFakeTransport()
    const room = new RoomClient(opts(t))
    const closed: string[] = []
    room.onClosed((reason) => closed.push(reason))
    room.connect()

    room.noteSocketClosed(4001)

    // A close code is the only channel that crosses a protocol version
    // boundary intact: an encoded welcome does not. This is what puts "this app
    // is out of date" on the screen instead of a spinner that never ends.
    expect(room.state().error).toBe('versionMismatch')
    expect(room.state().phase).toBe('closed')
    expect(closed).toEqual(['versionMismatch'])
  })

  it('maps 4002 onto roomClosed', () => {
    const { room } = welcomed()
    room.noteSocketClosed(4002)
    expect(room.state().error).toBe('roomClosed')
    expect(room.state().phase).toBe('closed')
  })

  it('treats any other code mid-race as serverLost and keeps racing', () => {
    const { t, room } = welcomed()
    t.deliver('reliable', startBytes(startMessage()))
    room.poll(0)
    room.poll(3000)

    room.noteSocketClosed(1006)

    expect(room.state().phase).toBe('racing')
    expect(room.state().serverLost).toBe(true)
  })
})

describe('RoomClient - authorityChange', () => {
  it('records the tick and eventSeq and fires onAuthorityChange, changing no phase', () => {
    const { t, room } = welcomed()
    t.deliver('reliable', startBytes(startMessage()))
    room.poll(0)
    room.poll(3000)
    const seen: number[][] = []
    room.onAuthorityChange((tick, eventSeq) => seen.push([tick, eventSeq]))

    t.deliver('reliable', authorityChangeBytes(742, 19))

    expect(seen).toEqual([[742, 19]])
    expect(room.state().authorityTick).toBe(742)
    expect(room.state().authorityEventSeq).toBe(19)
    expect(room.state().phase).toBe('racing')
  })

  it('starts at -1 for both, so "never promoted" is not tick 0', () => {
    const { room } = welcomed()
    expect(room.state().authorityTick).toBe(-1)
    expect(room.state().authorityEventSeq).toBe(-1)
  })
})

describe('RoomClient - a hostile or truncated frame', () => {
  it('counts a truncated welcome as a dropped datagram and changes nothing', () => {
    const t = makeFakeTransport()
    const room = new RoomClient(opts(t))
    room.connect()
    const before = { ...room.state() }

    const full = welcomeBytes(welcome())
    t.deliver('reliable', full.subarray(0, 3)) // header plus one byte

    expect({ ...room.state() }).toEqual(before)
    expect(droppedDatagramsOf(room)).toBe(1)
  })

  it('counts a datagram with an unknown tag and never dispatches it', () => {
    const t = makeFakeTransport()
    const room = new RoomClient(opts(t))
    room.connect()

    t.deliver('reliable', new Uint8Array([0x7f, 2, 0, 0]))

    expect(room.state().phase).toBe('connecting')
    expect(droppedDatagramsOf(room)).toBe(1)
  })

  it('ignores the race kinds, which belong to ClientLoop', () => {
    const { t, room } = welcomed()
    const before = { ...room.state() }
    t.deliver('unreliable', taggedDatagram('snapshot'))
    expect({ ...room.state() }).toEqual(before)
  })
})

describe('RoomClient - close()', () => {
  it('closes the transport once and reports it once', () => {
    const { t, room } = welcomed()
    const closed: string[] = []
    room.onClosed((reason) => closed.push(reason))

    room.close()
    room.close()

    expect(t.closed()).toBe(1)
    expect(room.state().phase).toBe('closed')
    expect(closed).toEqual(['closed'])
  })
})

describe('RoomClient - the divergence constants', () => {
  it('exports §6.4 starting values', () => {
    expect(HARD_RESYNC_LIMIT).toBe(3)
    expect(HARD_RESYNC_WINDOW_TICKS).toBe(600) // 10 s at 60 Hz
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/net/test/roomclient.test.ts`

Expected: FAIL, before any assertion runs, with

```
Error: Failed to resolve import "../src/roomclient" from "packages/net/test/roomclient.test.ts". Does the file exist?
```

- [ ] **Step 3: Write the implementation**

Create `packages/net/src/roomclient.ts`:

```ts
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
  CLIENT_FLAG_RTC_FAILED,
  CLIENT_FLAG_START_REQUEST,
  CLIENT_FLAG_WEBRTC,
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

export type RoomPhase = 'idle' | 'connecting' | 'lobby' | 'starting' | 'racing' | 'closed'

export interface RoomClientState {
  phase: RoomPhase
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

/** encodeHeader writes [tag, protocolVersion] and returns 2. */
const HEADER_BYTES = 2
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
  private readonly role: PeerRole
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
    this.role = opts.role
    this.name = opts.name
    this.characterIdx = opts.characterIdx
    this.trackId = opts.trackId
    this.st = {
      phase: 'idle',
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
      role: this.role,
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
    if (this.role !== 'host') return
    this.sendClientUpdate(CLIENT_FLAG_START_REQUEST, '')
  }

  requestResync(reason: ResyncReason, lastTick: number): void {
    if (!this.canSend()) return
    const h = encodeHeader(this.resyncBuf, 'resyncRequest')
    const n = encodeResyncRequest(this.resyncBuf.subarray(h), { reason, lastTick })
    this.t.send('reliable', SERVER_PEER_ID, this.resyncBuf.slice(0, h + n))
  }

  /** CLIENT_FLAG_RTC_FAILED; asks for relay. Sent at most once per session:
   *  after it, the server is already relaying and repeating it only bumps
   *  `rtcFailures` toward RELAY_FIRST_AFTER_FAILURES for everyone else. */
  reportRtcFailed(): void {
    if (!this.canSend()) return
    if (this.rtcFailedSent) return
    this.rtcFailedSent = true
    this.rtcDeadlineMs = -1
    this.rtcArmPending = false
    // There is no second `welcome` to confirm it: the server's answer is simply
    // to start relaying, so the flag flips when the request goes out.
    this.st.relayMode = true
    this.sendClientUpdate(CLIENT_FLAG_RTC_FAILED, '')
  }

  /** ADDITIVE (see this task's Interfaces). The direct link came up, so the
   *  give-up timer must not fire. */
  noteRtcConnected(): void {
    this.rtcConnected = true
    this.rtcDeadlineMs = -1
    this.rtcArmPending = false
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
    if (code === WS_CLOSE_ROOM_CLOSED) {
      this.st.error = 'roomClosed'
      this.closeWith('roomClosed')
      return
    }
    if (this.inRace()) {
      // F-P4-24: the race keeps playing. Relay-attached guests lose their path
      // and the host learns it through onPeerLost; a direct guest notices
      // nothing but this flag.
      this.st.serverLost = true
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
      if (this.inRace()) {
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

  close(): void {
    if (this.st.phase === 'closed') return
    this.t.close()
    this.closeWith('closed')
  }

  // ---------------------------------------------------------------- internals

  private canSend(): boolean {
    return this.st.phase !== 'idle' && this.st.phase !== 'closed'
  }

  private inRace(): boolean {
    return this.st.phase === 'starting' || this.st.phase === 'racing'
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
    for (const cb of this.welcomeCbs) cb(m)
    if (m.result !== 'ok') {
      this.st.error = m.result
      this.closeWith(m.result)
      return
    }
    this.st.playerId = m.playerId
    this.st.peerSlot = m.peerSlot
    this.st.token = m.token
    this.st.roomCode = m.roomCode
    this.st.hostPlayerId = m.hostPlayerId
    this.st.relayFirst = (m.flags & SERVER_FLAG_RELAY_FIRST) !== 0
    this.st.relayMode = this.st.relayFirst || (m.flags & SERVER_FLAG_RELAY_ASSIGNED) !== 0
    this.st.phase = 'lobby'
    // The give-up timer is armed for a guest that is expected to reach the host
    // directly. A relay-first room is already relaying (F-P4-39: "attach over
    // the relay IMMEDIATELY and attempt WebRTC in the background"), so asking
    // for relay again would only charge the room another rtcFailure.
    if (this.role === 'guest' && !this.st.relayFirst && !this.rtcConnected && !this.rtcFailedSent) {
      this.rtcArmPending = true
    }
  }
}
```

**One line the implementer must not "simplify".** `poll` seeds `this.live` and then reads it into a local `const live`; `notePong` is called before `shouldSendPing`, so a pong that arrived in the same frame as the ping it answers is measured against that ping and not the next one. Reordering those two makes RTT jump by one poll interval, silently.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/net/test/roomclient.test.ts`

Expected: PASS, 31 tests.

Then `npx vitest run packages/net` — expected PASS, with Task 12's caveat about `barrel.test.ts` if the barrel task has already landed.

- [ ] **Step 5: Commit**

```bash
git add packages/net/src/roomclient.ts packages/net/test/roomclient.test.ts && git commit -m "feat(net): RoomClient, the client half of the lobby handshake

hello/clientUpdate/resyncRequest out, welcome/lobby/start/authorityChange and the
two heartbeat kinds in, over one injected clock in poll(nowMs). Close code 4001
lands as versionMismatch; a socket that dies mid-race sets serverLost and the
race keeps running (F-P4-24)."
```
