### Task 19b: `packages/server/src/hub.ts` — `RoomHub`, the machine

Task 19 wrote the policy. This task writes the machine around it: the class that
owns sockets, classifies inbound bytes, sends the six lobby kinds, runs the one
per-process heartbeat, and disposes rooms. It is the only place in the server
where a socket callback and a room meet.

**Three things bind this task and are asserted, not asserted-about:**

- **The shadow owns host-loss detection and there is no second detector.** This
  class has no `maybePromote`, no `hostLost`, no `noteHostSnapshot` and no
  `HostWatch`. It calls `stepRace`, which calls `ShadowLoop.tick(nowMs)`, which
  counts wall milliseconds. `pollRace` **observes** the promotion afterwards and
  writes one log line. A clean socket close makes that player's kart bot-driven
  immediately, through `notePeerGone`, and decides nothing about authority —
  mobile browsers close sockets on backgrounding routinely and 1.5 s is already
  the spec's answer.
- **A shadow is never introduced mid-race.** `startRace` is called exactly once
  per race, from `startRoomRace`, guarded on `room.race === null`. A shadow that
  joined a running race would settle ~12 ticks behind permanently, and if it then
  promoted it would broadcast snapshots with tick numbers *below* the last the
  host sent: the client's filter discards about four snapshots and the first
  accepted one rewinds the guest's world by ~12 ticks of travel. That is spec
  §5's "no kart teleports backward". A late **joiner** is a different thing and
  gets `start` then a `checkpoint`, in that order, from the shadow's state.
- **When the server dies mid-race, the race keeps playing** (F-P4-24). `close()`
  closes sockets and disposes shadows. It broadcasts no "race over", it encodes
  no `authorityChange`, and it promotes nothing. Direct-connected guests keep
  racing host-authoritative over WebRTC; relay-attached guests lose their path
  and the host learns it through `onPeerLost`. v1 does not reconnect in the
  background, and that is a decision rather than an omission.

**Execution order.** Task 19 must have landed (this task modifies the same file),
and so must Tasks 18, 20 and 22's Steps 1–4.

**Files:**
- Modify: `packages/server/src/hub.ts` (append `PeerHandle` and `RoomHub`; change
  nothing Task 19 wrote)
- Create: `packages/server/test/fixtures/server-fixtures.ts`
- Test: `packages/server/test/hub.test.ts`

**Interfaces:**

- Consumes — everything Task 19's `hub.ts` already imports, plus:
  ```ts
  // @tapkart/protocol
  export const PROTOCOL_VERSION = 2
  export const WIRE_TAG = {
    hello: 0x01, welcome: 0x02, lobby: 0x03, start: 0x04, clientUpdate: 0x05,
    input: 0x10, snapshot: 0x11, events: 0x12, checkpoint: 0x13, resyncRequest: 0x14,
    authorityChange: 0x20, ping: 0x30, pong: 0x31,
  } as const
  export type MessageKind =
    | 'hello' | 'welcome' | 'lobby' | 'start' | 'clientUpdate'
    | 'input' | 'snapshot' | 'events' | 'checkpoint' | 'resyncRequest'
    | 'authorityChange' | 'ping' | 'pong'
  export function encodeHeader(out: Uint8Array, kind: MessageKind): number   // writes [tag, version], returns 2
  export function decodeHello(buf: Uint8Array): HelloMessage
  export function decodeClientUpdate(buf: Uint8Array): ClientUpdateMessage
  export function decodeResyncRequest(buf: Uint8Array): ResyncRequestMessage
  export function encodeWelcome(out: Uint8Array, msg: WelcomeMessage): number
  export function encodeLobby(out: Uint8Array, msg: LobbyMessage): number
  export function encodeStart(out: Uint8Array, msg: StartMessage): number
  export function encodeCheckpoint(out: Uint8Array, state: SimState): number
  export interface HeartbeatMessage { seq: number; echoMs: number }
  export function encodeHeartbeat(out: Uint8Array, msg: HeartbeatMessage): number
  export function decodeHeartbeat(buf: Uint8Array): HeartbeatMessage
  export type ResyncReason = 'lateJoin' | 'divergence'
  export interface ResyncRequestMessage { reason: ResyncReason; lastTick: number }

  // @tapkart/net
  export type SocketData = string | Uint8Array
  export interface SocketLike {
    send(data: SocketData): void
    close(code?: number, reason?: string): void
    onMessage(cb: (data: SocketData) => void): void   // appends, never replaces
    onClose(cb: (code: number) => void): void         // appends, never replaces
    readyState(): 'connecting' | 'open' | 'closing' | 'closed'
    bufferedAmount(): number
  }
  export const WS_CLOSE_VERSION_MISMATCH = 4001
  export const WS_CLOSE_ROOM_CLOSED      = 4002
  export function encodeWsData(out: Uint8Array, channel: ChannelName, peerSlot: number, payload: Uint8Array): number
  export function decodeWsFrame(buf: Uint8Array): WsFrame | null
  export function createLiveness(nowMs: number): LivenessState
  export function notePacket(l: LivenessState, nowMs: number): void
  export function shouldSendPing(l: LivenessState, nowMs: number, intervalMs?: number): boolean
  export function notePingSent(l: LivenessState, seq: number, nowMs: number): void
  export function notePong(l: LivenessState, msg: HeartbeatMessage, nowMs: number): void
  export function isStale(l: LivenessState, nowMs: number, timeoutMs?: number): boolean
  export function parseSignal(text: string): SignalEnvelope | null    // TOTAL, never throws
  export function encodeSignal(env: SignalEnvelope): string
  export interface SignalEnvelope { v: number; from: number; to: number; msg: SignalMessage }
  export const TICK_MS = 1000 / TICK_HZ
  export const HARD_RESYNC_WINDOW_TICKS = 600   // 10 s at 60 Hz
  export function advanceAccumulator(acc: TickAccumulator, elapsedMs: number): number
  export function makeTickAccumulator(): TickAccumulator
  export class AuthorityLoop {
    constructor(ctx: SimContext, state: SimState, t: Transport)
    state(): SimState
    tick(): void
  }
  export class ClientLoop {
    constructor(ctx: SimContext, playerId: number, t: Transport)
    tick(localIntent: Intent): void
    corrections(): number
    state(): SimState
    beginRace(seed: number, characterIdx: number[], humanMask: number): void
    onHardResync(cb: (tick: number) => void): void
    hardResyncs(): number
  }
  export function makeWebSocketTransport(opts: WebSocketTransportOptions): WebSocketTransport
  export function decodeAuthorityChange(buf: Uint8Array): { tick: number; eventSeq: number }
  export function decodeEvents(buf: Uint8Array, out: AuthEvent[]): void

  // packages/net/test/fixtures/socket-fixtures.ts   (relative path, §2.11)
  export function makeRecordingSocket(): SocketLike & {
    sentBinary(): Uint8Array[]; sentText(): string[]
    deliver(data: SocketData): void; fireClose(code: number): void
  }

  // src/race.ts (§5.8, Task 20)
  export function startRace(opts: StartRaceOptions): RaceRuntime
  export function stepRace(run: RaceRuntime, nowMs: number): number
  export function pollRace(run: RaceRuntime, log: LogSink, nowMs: number): boolean
  export function endRace(run: RaceRuntime): void
  // src/content.ts (§5.9, Task 20)
  export const defaultContentProvider: ContentProvider
  // src/random.ts (§5.3)
  export function mintRaceSeed(rand: RandomSource): number        // u32
  ```

- Produces — the last two of `hub.ts`'s ten §5.7 pins:
  ```ts
  export interface PeerHandle {
    peerId: PeerId
    roomCode(): string | null
    detach(nowMs: number): void
  }
  export class RoomHub {
    constructor(deps: HubDeps)
    attach(socket: SocketLike, nowMs: number): PeerHandle
    poll(nowMs: number): void
    registry(): RoomRegistry
    close(): void
  }
  ```

- Produces — `packages/server/test/fixtures/server-fixtures.ts`, §9.1's five:
  ```ts
  export function makeServerContext(): SimContext
  export function makeTestConfig(overrides?: Partial<ServerConfig>): ServerConfig
  export function makeCountingRandom(): RandomSource
  export function makeTestHub(overrides?: Partial<HubDeps>): { hub: RoomHub; log: ReturnType<typeof makeMemoryLogSink> }
  export function makeTestRoom(hub: RoomHub, guests: number, nowMs: number): { code: string; host: SocketLike; guests: SocketLike[] }
  ```
  **If the file already exists** (the registry or env task may have created it
  with the first three), append only `makeTestHub` and `makeTestRoom` and leave
  the other three byte-identical. Do not create a second fixture module.

**Four decisions this task makes:**

1. **Inbound frames are stamped with the most recent `poll(nowMs)`.** A socket
   callback carries no time and `Date.now()` exists in exactly one file. At
   `POLL_INTERVAL_MS = 8` the stamp is at most 8 ms stale — three orders below
   every timeout it feeds (`roomIdleMs` 600 000, `PEER_STALE_MS` 5 000,
   `RTC_CONNECT_TIMEOUT_MS` 4 000) — and it can never run backwards, because the
   hub keeps the maximum it has seen.
2. **A malformed frame is a counted, logged drop; it does not close the socket.**
   `decodeWsFrame` is total precisely so one hostile or corrupt datagram cannot
   end a live race. The global constraint the rule exists for — *"it never takes
   the process down"* — holds either way, and the case it names, a version
   mismatch after a deploy, **does** close the socket, with 4001.
3. **A rejected `hello` is answered and the socket is left open.** The client
   shows the `JoinResult` and closes itself; the 5 s staleness sweep collects
   anything that does not. Closing immediately would race the `welcome` that
   explains why.
4. **A dropped peer's record stays in `room.peers` with `connected = false`.**
   `RoomRegistry.reclaim` matches "a seat whose peer has gone" by token, and the
   lobby shows a greyed-out seat rather than an empty one. The seat is not
   released: the kart keeps racing bot-driven and its owner can come back to it.

---

- [ ] **Step 1: Write the fixtures**

Create (or append to) `packages/server/test/fixtures/server-fixtures.ts`:

```ts
import type { SimContext } from '@tapkart/sim'
import type { ChannelName, HelloMessage, MessageKind, WelcomeMessage } from '@tapkart/protocol'
import {
  CLIENT_FLAG_WEBRTC, WIRE_TAG, decodeHeader, decodeWelcome, encodeHeader, encodeHello,
} from '@tapkart/protocol'
import type { SocketData, SocketLike } from '@tapkart/net'
import { WS_HEADER_BYTES, WS_SLOT_SERVER, decodeWsFrame, encodeWsData } from '@tapkart/net'
import { makeContext, makeOvalTrack } from '../../../sim/test/fixtures/track-fixtures'
import type { ServerConfig } from '../../src/env'
import { DEFAULT_CONFIG } from '../../src/env'
import type { RandomSource } from '../../src/random'
import type { HubDeps } from '../../src/hub'
import { RoomHub } from '../../src/hub'
import { RoomRegistry } from '../../src/registry'
import { defaultContentProvider } from '../../src/content'
import { makeMemoryLogSink } from '../../src/log'
import { makeRateLimiter } from '../../src/ratelimit'

/** FRESH per call -- §7.1. `isLeader` is FALSE: a shadow's context is handed to
 *  it non-leader and `promote()` writes into the object it was given. */
export function makeServerContext(): SimContext {
  return makeContext(makeOvalTrack(), false)
}

export function makeTestConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return { ...DEFAULT_CONFIG, ...overrides }
}

/** Byte i of draw n is (n * 31 + i) & 0xff, so every minted code and token in
 *  the suite is an exact expected string. */
export function makeCountingRandom(): RandomSource {
  let draw = 0
  return (bytes: number): Uint8Array => {
    const out = new Uint8Array(bytes)
    for (let i = 0; i < bytes; i++) out[i] = (draw * 31 + i) & 0xff
    draw += 1
    return out
  }
}

export function makeTestHub(overrides: Partial<HubDeps> = {}): {
  hub: RoomHub
  log: ReturnType<typeof makeMemoryLogSink>
} {
  const log = makeMemoryLogSink()
  const config = makeTestConfig()
  const deps: HubDeps = {
    config,
    registry: new RoomRegistry({
      maxRooms: config.maxRooms,
      maxPeersPerRoom: config.maxPeersPerRoom,
      roomIdleMs: config.roomIdleMs,
      rand: makeCountingRandom(),
    }),
    content: defaultContentProvider,
    rand: makeCountingRandom(),
    log,
    failedJoins: makeRateLimiter(config.joinRateLimit),
    ...overrides,
  }
  return { hub: new RoomHub(deps), log }
}

/**
 * Two SocketLikes wired to each other with IMMEDIATE delivery.
 *
 * `makeFakeSocketPair` is the latency-modelling one and it delivers on `flush()`,
 * but §9.1 pins `makeTestRoom`'s return type to sockets alone -- there is nowhere
 * to hand a caller the flush handle. The hub models no latency anyway: the one
 * place latency and loss matter is Task 20's promotion test, which uses
 * `makeLoopbackPair` at 150 ms / 50 ms / 5 % for exactly that reason.
 */
function immediatePair(): { a: SocketLike; b: SocketLike } {
  const aMsg: ((d: SocketData) => void)[] = []
  const bMsg: ((d: SocketData) => void)[] = []
  const aClose: ((code: number) => void)[] = []
  const bClose: ((code: number) => void)[] = []
  let open = true

  const a: SocketLike = {
    send: (d) => { if (open) for (const cb of bMsg.slice()) cb(d) },
    close: (code = 1000) => {
      if (!open) return
      open = false
      for (const cb of aClose.slice()) cb(code)
      for (const cb of bClose.slice()) cb(code)
    },
    onMessage: (cb) => { aMsg.push(cb) },
    onClose: (cb) => { aClose.push(cb) },
    readyState: () => (open ? 'open' : 'closed'),
    bufferedAmount: () => 0,
  }
  const b: SocketLike = {
    send: (d) => { if (open) for (const cb of aMsg.slice()) cb(d) },
    close: (code = 1000) => { a.close(code) },
    onMessage: (cb) => { bMsg.push(cb) },
    onClose: (cb) => { bClose.push(cb) },
    readyState: () => (open ? 'open' : 'closed'),
    bufferedAmount: () => 0,
  }
  return { a, b }
}

function sendHello(socket: SocketLike, msg: HelloMessage): void {
  const buf = new Uint8Array(64)
  const head = encodeHeader(buf, 'hello')
  const n = encodeHello(buf.subarray(head), msg)
  const frame = new Uint8Array(WS_HEADER_BYTES + head + n)
  encodeWsData(frame, 'reliable', WS_SLOT_SERVER, buf.subarray(0, head + n))
  socket.send(frame)
}

function firstWelcome(frames: { kind: MessageKind; payload: Uint8Array }[]): WelcomeMessage {
  for (const f of frames) if (f.kind === 'welcome') return decodeWelcome(f.payload)
  throw new Error('makeTestRoom: the hub sent no welcome')
}

function watch(socket: SocketLike): { kind: MessageKind; channel: ChannelName; payload: Uint8Array }[] {
  const out: { kind: MessageKind; channel: ChannelName; payload: Uint8Array }[] = []
  socket.onMessage((data) => {
    if (typeof data === 'string') return
    const frame = decodeWsFrame(data)
    if (frame === null || frame.channel === null || frame.payload.length < 2) return
    out.push({ kind: decodeHeader(frame.payload).kind, channel: frame.channel, payload: frame.payload.subarray(2).slice() })
  })
  return out
}

/** Host + N guests attached to one hub over fake sockets, already welcomed and
 *  seated. The vehicle for the promotion, relay and two-room tests. */
export function makeTestRoom(hub: RoomHub, guests: number, nowMs: number): {
  code: string
  host: SocketLike
  guests: SocketLike[]
} {
  const hostPair = immediatePair()
  hub.attach(hostPair.a, nowMs)
  const hostFrames = watch(hostPair.b)
  sendHello(hostPair.b, {
    role: 'host', roomCode: '', token: '', characterIdx: 0, name: 'host',
    trackId: '', flags: CLIENT_FLAG_WEBRTC,
  })
  const hostWelcome = firstWelcome(hostFrames)
  if (hostWelcome.result !== 'ok') throw new Error('makeTestRoom: host join was ' + hostWelcome.result)

  const guestSockets: SocketLike[] = []
  for (let i = 0; i < guests; i++) {
    const pair = immediatePair()
    hub.attach(pair.a, nowMs)
    const frames = watch(pair.b)
    sendHello(pair.b, {
      role: 'guest', roomCode: hostWelcome.roomCode, token: '', characterIdx: 0,
      name: 'guest' + String(i), trackId: '', flags: CLIENT_FLAG_WEBRTC,
    })
    const w = firstWelcome(frames)
    if (w.result !== 'ok') throw new Error('makeTestRoom: guest join was ' + w.result)
    guestSockets.push(pair.b)
  }

  // Referenced so the tag map is exercised at least once here too: a fixture that
  // silently stopped producing `hello` frames would otherwise fail far away.
  if (WIRE_TAG.hello !== 0x01) throw new Error('WIRE_TAG.hello moved; this fixture frames by hand')

  return { code: hostWelcome.roomCode, host: hostPair.b, guests: guestSockets }
}
```

- [ ] **Step 2: Write the failing test**

Create `packages/server/test/hub.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { AuthEvent, Intent, SimContext } from '@tapkart/sim'
import { MAX_ENTITIES, MAX_KARTS, createState } from '@tapkart/sim'
import type { ChannelName, MessageKind, StartMessage } from '@tapkart/protocol'
import {
  CLIENT_FLAG_RTC_FAILED, CLIENT_FLAG_START_REQUEST, PROTOCOL_VERSION,
  SERVER_FLAG_CHECKPOINT_NEXT, SERVER_FLAG_RACE_IN_PROGRESS,
  decodeCheckpoint, decodeHeader, decodeLobby, decodeStart, decodeWelcome,
  encodeClientUpdate, encodeHeader, encodeHello,
} from '@tapkart/protocol'
import type { SocketLike } from '@tapkart/net'
import {
  AuthorityLoop, ClientLoop, WS_CLOSE_VERSION_MISMATCH, WS_HEADER_BYTES, WS_SLOT_SERVER,
  advanceAccumulator, decodeAuthorityChange, decodeEvents, decodeWsFrame, encodeWsData,
  makeTickAccumulator, makeWebSocketTransport,
} from '@tapkart/net'
import { makeServerContext, makeTestHub, makeTestRoom } from './fixtures/server-fixtures'
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

function sendUpdate(socket: SocketLike, flags: number): void {
  const buf = new Uint8Array(64)
  const head = encodeHeader(buf, 'clientUpdate')
  const n = encodeClientUpdate(buf.subarray(head), { flags, characterIdx: 0, name: '', trackId: '' })
  sendBody(socket, 'reliable', buf.subarray(0, head + n))
}

const NEUTRAL: Intent = { tick: 0, steer: 0, accel: 0, brake: false, drift: false, useItem: false }

describe('RoomHub.attach — the handshake', () => {
  it('welcomes a host, seats a guest by code, and broadcasts one lobby per change', () => {
    const { hub } = makeTestHub()
    const room = makeTestRoom(hub, 1, 0)
    const hostSeen = watch(room.host)

    const registry = hub.registry()
    const record = registry.getRoom(room.code)
    expect(record).not.toBeNull()
    expect(record!.seats[0]).not.toBeNull()
    expect(record!.seats[1]).not.toBeNull()

    sendUpdate(room.guests[0], 0)
    // A no-op update is not a mutation, so no lobby is owed for it.
    expect(hostSeen.filter((s) => s.kind === 'lobby')).toHaveLength(0)

    sendUpdate(room.guests[0], CLIENT_FLAG_RTC_FAILED)
    const lobbies = hostSeen.filter((s) => s.kind === 'lobby')
    expect(lobbies).toHaveLength(1)
    const lobby = decodeLobby(lobbies[0].payload)
    expect(lobby.slots.filter((s) => s.occupied)).toHaveLength(2)
    expect(lobby.hostPlayerId).toBe(0)
  })

  it('closes a version-1 hello with 4001 and writes one rejected line', () => {
    const { hub, log } = makeTestHub()
    // The floor: a current-version hello on this same hub IS accepted, so the
    // close below is the version check and not a broken frame.
    const ok = makeTestRoom(hub, 0, 0)
    expect(ok.code).not.toBe('')

    const closes: number[] = []
    const seen: { data: Uint8Array }[] = []
    let onMsg: ((d: Uint8Array | string) => void) | null = null
    const socket: SocketLike = {
      send: (d) => { if (typeof d !== 'string') seen.push({ data: d }) },
      close: (code = 1000) => { closes.push(code) },
      onMessage: (cb) => { onMsg = cb },
      onClose: () => { /* the hub subscribes; this fake never fires it */ },
      readyState: () => 'open',
      bufferedAmount: () => 0,
    }
    hub.attach(socket, 0)

    const buf = new Uint8Array(64)
    const head = encodeHeader(buf, 'hello')
    const n = encodeHello(buf.subarray(head), {
      role: 'guest', roomCode: ok.code, token: '', characterIdx: 0, name: '', trackId: '', flags: 0,
    })
    buf[1] = PROTOCOL_VERSION - 1                 // the version byte, at its fixed offset
    const frame = new Uint8Array(WS_HEADER_BYTES + head + n)
    encodeWsData(frame, 'reliable', WS_SLOT_SERVER, buf.subarray(0, head + n))
    onMsg!(frame)

    expect(closes).toEqual([WS_CLOSE_VERSION_MISMATCH])
    expect(seen).toHaveLength(0)                  // an encoded welcome cannot cross versions
    expect(log.events().filter((e) => e.kind === 'rejected' && e.result === 'versionMismatch')).toHaveLength(1)
  })
})

describe('RoomHub — starting a race', () => {
  it('starts on the host\'s request and refuses a guest\'s', () => {
    const { hub, log } = makeTestHub()
    const room = makeTestRoom(hub, 1, 0)
    const record = hub.registry().getRoom(room.code)!

    sendUpdate(room.guests[0], CLIENT_FLAG_START_REQUEST)
    expect(record.phase).toBe('lobby')
    expect(record.race).toBeNull()
    expect(log.events().some((e) => e.kind === 'raceStarted')).toBe(false)

    const guestSeen = watch(room.guests[0])
    sendUpdate(room.host, CLIENT_FLAG_START_REQUEST)

    expect(record.phase).toBe('racing')
    expect(record.race).not.toBeNull()
    expect(record.race!.shadow.promotionTick()).toBe(-1)
    const starts = guestSeen.filter((s) => s.kind === 'start')
    expect(starts).toHaveLength(1)
    const start = decodeStart(starts[0].payload)
    expect(start.trackId).toBe(record.trackId)
    expect(start.humanMask).toBe(0b11)
    expect(start.raceSeed).toBe(record.raceSeed)
    expect(log.events().filter((e) => e.kind === 'raceStarted')).toHaveLength(1)
  })

  it('never starts a second race over a live one', () => {
    const { hub } = makeTestHub()
    const room = makeTestRoom(hub, 0, 0)
    const record = hub.registry().getRoom(room.code)!

    sendUpdate(room.host, CLIENT_FLAG_START_REQUEST)
    const first = record.race
    expect(first).not.toBeNull()

    // A shadow introduced mid-race would settle ~12 ticks behind for good, and a
    // promotion from it would broadcast ticks BELOW the last the host sent.
    sendUpdate(room.host, CLIENT_FLAG_START_REQUEST)
    expect(record.race).toBe(first)
  })

  it('sends a late joiner welcome, start, THEN checkpoint, from the shadow\'s own state', () => {
    const { hub, log } = makeTestHub()
    const room = makeTestRoom(hub, 0, 0)
    const record = hub.registry().getRoom(room.code)!
    sendUpdate(room.host, CLIENT_FLAG_START_REQUEST)

    for (let now = 8; now <= 800; now += 8) hub.poll(now)
    const shadowTick = record.race!.state.tick
    // The floor: the race actually advanced, so a checkpoint encoded from a
    // never-stepped state could not satisfy the equality below.
    expect(shadowTick).toBeGreaterThan(30)
    expect(record.phase).toBe('racing')

    const seen = joinRacingRoom(hub, room.code, 800)

    const kinds = seen.map((s) => s.kind)
    expect(kinds).toEqual(['welcome', 'lobby', 'start', 'checkpoint'])
    const welcome = decodeWelcome(seen[0].payload)
    expect(welcome.flags & SERVER_FLAG_RACE_IN_PROGRESS).toBe(SERVER_FLAG_RACE_IN_PROGRESS)
    expect(welcome.flags & SERVER_FLAG_CHECKPOINT_NEXT).toBe(SERVER_FLAG_CHECKPOINT_NEXT)
    expect(seen[3].channel).toBe('reliable')

    // `start` must arrive first: it is what makes the client's itemBoxes array
    // the right length, and decodeCheckpoint throws on a mismatch -- which the
    // datagram guard would turn into a silent drop and a client stuck at tick 0.
    // The checkpoint decodes to the SHADOW's live state, not to a fresh one.
    const dst = createState(makeServerContext(), 0, new Array<number>(MAX_KARTS).fill(0))
    expect(dst.tick).toBe(0)
    decodeCheckpoint(seen[3].payload, dst)
    expect(dst.tick).toBe(shadowTick)

    expect(log.events().some((e) => e.kind === 'checkpointSent' && e.reason === 'lateJoin')).toBe(true)
  })
})

/** Attaches one more socket, joins `code`, and returns everything it was sent. */
function joinRacingRoom(hub: ReturnType<typeof makeTestHub>['hub'], code: string, nowMs: number): Seen[] {
  const msgs: ((d: Uint8Array | string) => void)[] = []
  const sent: Uint8Array[] = []
  const socket: SocketLike = {
    send: (d) => { if (typeof d !== 'string') sent.push(d.slice()) },
    close: () => { /* the test closes nothing here */ },
    onMessage: (cb) => { msgs.push(cb) },
    onClose: () => { /* the hub subscribes; this fake never fires it */ },
    readyState: () => 'open',
    bufferedAmount: () => 0,
  }
  hub.attach(socket, nowMs)

  const buf = new Uint8Array(64)
  const head = encodeHeader(buf, 'hello')
  const n = encodeHello(buf.subarray(head), {
    role: 'guest', roomCode: code, token: '', characterIdx: 0, name: 'late', trackId: '', flags: 0,
  })
  const frame = new Uint8Array(WS_HEADER_BYTES + head + n)
  encodeWsData(frame, 'reliable', WS_SLOT_SERVER, buf.subarray(0, head + n))
  for (const cb of msgs.slice()) cb(frame)

  const out: Seen[] = []
  for (const raw of sent) {
    const f = decodeWsFrame(raw)
    if (f === null || f.channel === null || f.payload.length < 2) continue
    out.push({ kind: decodeHeader(f.payload).kind, channel: f.channel, payload: f.payload.subarray(2).slice() })
  }
  return out
}

describe('RoomHub — losing a peer, and losing the server', () => {
  it('makes a closed peer\'s kart bot-driven immediately, and promotes nothing', () => {
    const { hub } = makeTestHub()
    const room = makeTestRoom(hub, 1, 0)
    const record = hub.registry().getRoom(room.code)!
    sendUpdate(room.host, CLIENT_FLAG_START_REQUEST)
    for (let now = 8; now <= 400; now += 8) hub.poll(now)

    const run = record.race!
    expect(run.state.karts[1].connected).toBe(true)          // the floor

    room.guests[0].close()
    hub.poll(408)

    expect(run.state.karts[1].connected).toBe(false)
    // 1.5 s has not passed and this was not a host-loss decision anyway. There is
    // exactly one host-loss detector and it is inside ShadowLoop.tick.
    expect(run.shadow.promotionTick()).toBe(-1)
  })

  it('close() disposes the shadow, closes the sockets, and never promotes', () => {
    const { hub, log } = makeTestHub()
    const room = makeTestRoom(hub, 1, 0)
    const record = hub.registry().getRoom(room.code)!
    sendUpdate(room.host, CLIENT_FLAG_START_REQUEST)
    for (let now = 8; now <= 400; now += 8) hub.poll(now)
    expect(record.race).not.toBeNull()                       // the floor

    const hostSeen = watch(room.host)
    hub.close()

    expect(record.race).toBeNull()
    expect(room.host.readyState()).toBe('closed')
    // F-P4-24: the race keeps playing without us. The server says nothing about
    // authority on its way out -- authorityChange is ShadowLoop.promote's alone.
    expect(hostSeen.some((s) => s.kind === 'authorityChange')).toBe(false)
    expect(log.events().some((e) => e.kind === 'promotion')).toBe(false)
    hub.close()                                              // idempotent
  })
})

describe('§7.1 — two rooms in one hub', () => {
  it('one room\'s promotion leaves every other room a follower', () => {
    const { hub } = makeTestHub()
    const a = makeTestRoom(hub, 0, 0)
    sendUpdate(a.host, CLIENT_FLAG_START_REQUEST)
    const roomA = hub.registry().getRoom(a.code)!

    let now = 0
    for (; now <= 2000; now += 8) hub.poll(now)

    const b = makeTestRoom(hub, 0, now)
    sendUpdate(b.host, CLIENT_FLAG_START_REQUEST)
    const roomB = hub.registry().getRoom(b.code)!

    // Neither host ever sends a snapshot, so A -- which started 2 s earlier --
    // crosses HOST_TIMEOUT_MS first.
    expect(roomA.race!.ctx).not.toBe(roomB.race!.ctx)
    const bSeqBefore = roomB.race!.state.nextEventSeq
    const bTickBefore = roomB.race!.state.tick

    for (; now <= 2500; now += 8) hub.poll(now)

    expect(roomA.race!.shadow.promotionTick()).toBeGreaterThanOrEqual(0)   // the floor
    // ShadowLoop.promote writes isLeader into the object it was HANDED, which is
    // exactly what the server wants for the room that promoted...
    expect(roomA.race!.ctx.isLeader).toBe(true)
    // A memoised SimContext would have turned this room into a leader too, and
    // it would have started rolling items and emitting events for a race whose
    // host is perfectly healthy.
    expect(roomB.race!.ctx.isLeader).toBe(false)
    expect(roomB.race!.shadow.promotionTick()).toBe(-1)
    expect(roomB.race!.state.nextEventSeq).toBe(bSeqBefore)
    // ...and not because room B stopped running.
    expect(roomB.race!.state.tick).toBeGreaterThan(bTickBefore + 20)
  })
})

describe('end-to-end, in-process — the host dies and the guest keeps racing', () => {
  it('promotes, keeps the snapshots flowing, rewinds nothing and repeats no eventSeq', () => {
    const { hub } = makeTestHub()
    const room = makeTestRoom(hub, 1, 0)
    const record = hub.registry().getRoom(room.code)!

    // The guest gives up on WebRTC, which is what puts it on the relay -- the
    // only path by which the server's frames reach it at all.
    sendUpdate(room.guests[0], CLIENT_FLAG_RTC_FAILED)
    const hostSlot = record.peers.get(record.seats[0]!)!.slot
    const guestSlot = record.peers.get(record.seats[1]!)!.slot

    const hostSeen = watch(room.host)
    const guestSeen = watch(room.guests[0])
    sendUpdate(room.host, CLIENT_FLAG_START_REQUEST)

    const startFrame = guestSeen.find((s) => s.kind === 'start')
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
        const ac = decodeAuthorityChange(data)
        authorityTick = ac.tick
        authorityEventSeq = ac.eventSeq
      } else if (kind === 'snapshot') {
        if (authorityTick >= 0) snapshotsAfterPromotion += 1
      } else if (kind === 'events') {
        events.length = 0
        decodeEvents(data.subarray(2), events)
        eventFrames += 1
        for (const ev of events) {
          if (seenSeq.has(ev.eventSeq)) duplicateSeq += 1
          seenSeq.add(ev.eventSeq)
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
        const g = advanceAccumulator(guestAcc, now - guestLast)
        guestLast = now
        for (let i = 0; i < g; i++) {
          guestTicks += 1
          guest.tick({ ...NEUTRAL, tick: guestTicks, accel: 1 })
        }
        const st = guest.state()
        for (let i = 0; i < MAX_KARTS; i++) {
          // Spec §5: no kart teleports backward. A lap counter is the coarsest
          // possible statement of that and it must never decrease.
          expect(st.karts[i].lap.lap).toBeGreaterThanOrEqual(laps[i])
          laps[i] = st.karts[i].lap.lap
          if (laps[i] > maxLap) maxLap = laps[i]
        }
      }
      return now
    }

    // 10 s of racing, host-authoritative.
    let now = runTo(10_000, 8)

    // The floors, all four, BEFORE the host goes quiet. Without them every
    // assertion after the kill would pass against a race that never ran.
    expect(record.race!.state.tick).toBeGreaterThan(500)
    expect(host.state().tick).toBeGreaterThan(500)
    expect(guest.state().tick).toBeGreaterThan(500)
    expect(hostSeen.length + guestSeen.length).toBeGreaterThan(0)
    expect(eventFrames).toBeGreaterThan(0)
    expect(record.race!.shadow.promotionTick()).toBe(-1)

    // The host's phone backgrounds: it goes SILENT. Its socket stays open, which
    // is the case a clean close must not be conflated with.
    hostAlive = false
    const silentAt = now

    now = runTo(silentAt + 1400, now)
    expect(record.race!.shadow.promotionTick()).toBe(-1)     // not one millisecond early

    now = runTo(silentAt + 1700, now)
    const promotionTick = record.race!.shadow.promotionTick()
    expect(promotionTick).toBeGreaterThanOrEqual(0)
    expect(authorityTick).toBe(promotionTick)
    expect(authorityEventSeq).toBeGreaterThanOrEqual(0)

    // The guest keeps receiving snapshots -- from the shadow now, at the same
    // 20 Hz on the same channel.
    now = runTo(now + 1000, now)
    expect(snapshotsAfterPromotion).toBeGreaterThan(10)

    // The promoted authority's first event is applied, not dropped as a
    // duplicate: applyEvent rejects `ev.eventSeq < state.nextEventSeq`, and the
    // eventSeq floor in authorityChange is what keeps the two in step.
    expect(guest.state().nextEventSeq).toBeGreaterThanOrEqual(authorityEventSeq)
    expect(duplicateSeq).toBe(0)
    expect(maxLap).toBeGreaterThan(0)
    expect(guest.state().entityCount).toBeLessThanOrEqual(MAX_ENTITIES)
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run packages/server/test/hub.test.ts`

Expected: FAIL at collection with
`SyntaxError: The requested module '../src/hub' does not provide an export named 'RoomHub'`
(or, if `server-fixtures.ts` is being created for the first time, the resolver
error for it comes first — write the fixture, then re-run to see the `RoomHub`
failure.)

- [ ] **Step 4: Append `PeerHandle` and `RoomHub` to `packages/server/src/hub.ts`**

Add these imports to the ones Task 19 wrote:

```ts
import type {
  ChannelName, HeartbeatMessage, MessageKind, ResyncReason, StartMessage,
} from '@tapkart/protocol'
import {
  CLIENT_FLAG_START_REQUEST, PROTOCOL_VERSION, WIRE_TAG,
  decodeClientUpdate, decodeHeartbeat, decodeHello, decodeResyncRequest,
  encodeCheckpoint, encodeHeader, encodeHeartbeat, encodeLobby, encodeStart, encodeWelcome,
} from '@tapkart/protocol'
import type { SocketData, SocketLike } from '@tapkart/net'
import {
  HARD_RESYNC_WINDOW_TICKS, TICK_MS, WS_CLOSE_ROOM_CLOSED, WS_CLOSE_VERSION_MISMATCH,
  WS_HEADER_BYTES, createLiveness, encodeSignal, encodeWsData, decodeWsFrame,
  isStale, notePacket, notePingSent, notePong, parseSignal, shouldSendPing,
} from '@tapkart/net'
import type { PeerId, RaceRuntime } from './types'
import { buildLobbyMessage, buildStartMessage, canStart } from './lobby'
import { makeRoomTransport } from './roomtransport'
import { endRace, pollRace, startRace, stepRace } from './race'
import { mintRaceSeed } from './random'
import type { LogEvent } from './log'
```

Then append:

```ts
export interface PeerHandle {
  peerId: PeerId
  roomCode(): string | null
  detach(nowMs: number): void
}

interface AttachedPeer {
  peerId: PeerId
  socket: SocketLike
  room: RoomRecord | null
  /** The socket's PROVISIONAL record until `hello` succeeds, and the registry's
   *  from then on. There are never two live records for one socket. */
  record: PeerRecord
  detached: boolean
  lastCheckpointMs: number
}

/** The kinds the hub adjudicates. Everything else addressed to the room is race
 *  traffic for the shadow. */
const HUB_TAGS: ReadonlySet<number> = new Set<number>([
  WIRE_TAG.hello, WIRE_TAG.clientUpdate, WIRE_TAG.resyncRequest, WIRE_TAG.ping, WIRE_TAG.pong,
])

/** §6.4: at most one checkpoint per HARD_RESYNC_WINDOW_TICKS per peer. */
const CHECKPOINT_MIN_INTERVAL_MS = HARD_RESYNC_WINDOW_TICKS * TICK_MS

const WELCOME_BUF_BYTES = 32
const START_BUF_BYTES = 64
const HEARTBEAT_BUF_BYTES = 16

export class RoomHub {
  private readonly deps: HubDeps
  private readonly attached = new Map<PeerId, AttachedPeer>()
  private readonly roomLogs = new Map<string, LogSink>()
  // Scratch encode buffers. Safe to reuse across peers because `sendBody` copies
  // into a FRESH frame before anything reaches a socket.
  private readonly welcomeBuf = new Uint8Array(WELCOME_BUF_BYTES)
  private readonly lobbyBuf = new Uint8Array(LOBBY_BUF_BYTES)
  private readonly startBuf = new Uint8Array(START_BUF_BYTES)
  private readonly checkpointBuf = new Uint8Array(CHECKPOINT_BUF_BYTES)
  private readonly heartbeatBuf = new Uint8Array(HEARTBEAT_BUF_BYTES)
  private nextPeerSeq = 1
  private nowMs = 0
  private closed = false

  constructor(deps: HubDeps) {
    this.deps = deps
  }

  /**
   * A new socket, not yet in any room. The hub subscribes to it and waits for a
   * `hello`. Sole creator of PeerIds.
   */
  attach(socket: SocketLike, nowMs: number): PeerHandle {
    this.nowMs = Math.max(this.nowMs, nowMs)
    const peerId = 'peer' + String(this.nextPeerSeq)
    this.nextPeerSeq += 1

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

    // A socket callback carries no time. The hub stamps inbound work with the
    // newest time the scheduler gave it: at POLL_INTERVAL_MS = 8 that is at most
    // 8 ms stale, three orders below every timeout it feeds, and it can never
    // run backwards.
    socket.onMessage((data: SocketData) => { this.onData(att, data) })
    socket.onClose(() => { this.detach(att, this.nowMs) })

    return {
      peerId,
      roomCode: (): string | null => (att.room === null ? null : att.room.code),
      detach: (t: number): void => {
        this.nowMs = Math.max(this.nowMs, t)
        this.detach(att, this.nowMs)
      },
    }
  }

  /**
   * The single per-process heartbeat: polls and steps every room's race, sends
   * pings, and expires idle rooms. Called by exactly one scheduler.
   */
  poll(nowMs: number): void {
    if (this.closed) return
    this.nowMs = Math.max(this.nowMs, nowMs)
    const now = this.nowMs

    for (const room of this.deps.registry.rooms()) {
      const run = room.race
      if (run !== null) {
        stepRace(run, now)
        // Observes the promotion the shadow already made. It decides nothing:
        // there is exactly one host-loss detector and it is inside
        // ShadowLoop.tick, counting wall milliseconds (F-P4-22).
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
          const seq = (peer.liveness.lastPingSeq + 1) >>> 0
          this.sendKind(att, 'ping', 'unreliable', this.heartbeatBuf,
            (out) => encodeHeartbeat(out, { seq, echoMs: now }))
          notePingSent(peer.liveness, seq, now)
        }
      }
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

  /**
   * F-P4-24. Closes every socket and disposes every shadow. It broadcasts no
   * "race over", encodes no `authorityChange` and promotes nothing: the race
   * keeps playing host-authoritative over WebRTC, relay-attached guests lose
   * their path and the host learns it through `onPeerLost`, and v1 does not
   * reconnect in the background.
   */
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

  // ---------------------------------------------------------------- inbound

  private onData(att: AttachedPeer, data: SocketData): void {
    if (this.closed || att.detached) return
    if (typeof data === 'string') this.onText(att, data)
    else this.onBinary(att, data)
  }

  /**
   * The one place inbound bytes are classified. It does exactly four things:
   * decode the envelope, route and re-frame, feed the shadow, and touch the
   * room. It decodes no game message, and it reads the version byte for a
   * `hello` and nothing else.
   */
  private onBinary(att: AttachedPeer, data: Uint8Array): void {
    const nowMs = this.nowMs
    const frame = decodeWsFrame(data)
    if (frame === null) {
      this.badFrame(att, 'wsFrame', nowMs)
      return
    }
    if (frame.frameKind !== WS_FRAME_DATA || frame.channel === null) {
      // The slot table belongs to the client's transport; a control frame
      // inbound is a routing bug, and silently accepting one hides it.
      this.badFrame(att, 'controlFrame', nowMs)
      return
    }
    const payload = frame.payload
    if (payload.length < 2) {
      this.badFrame(att, 'shortMessage', nowMs)
      return
    }

    // §3.0: the version check for `hello` happens BEFORE any guard. `payload[1]`
    // is the version byte of the 2-byte message header -- a fixed offset in a
    // fixed format, stable across every version this protocol will ever have.
    // A close code crosses a version boundary intact; an encoded welcome does
    // not, and a v1 client would otherwise watch a spinner forever.
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
    // The shadow sees every race datagram the room carries, addressed to it or
    // not: it is a follower of the host and a listener to every seat.
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
      // `RoomClient.connect` is idempotent and re-sends nothing; a second hello
      // is a client bug, and re-seating on it would let one socket take two
      // seats.
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
    if (welcome.result !== 'ok') return          // answered, and left open to be closed by the client

    const room = this.deps.registry.getRoom(welcome.roomCode)
    if (room === null) return
    att.room = room
    const seated = room.peers.get(att.peerId)
    if (seated !== undefined) att.record = seated   // the provisional record is dropped here

    this.broadcastLobby(room)

    const run = room.race
    if ((welcome.flags & SERVER_FLAG_RACE_IN_PROGRESS) !== 0 && run !== null) {
      // §6.5, in this order and no other. `start` first, so the client's
      // beginRace sizes its itemBoxes array from the track -- decodeCheckpoint
      // throws on a length mismatch, and the shipped guard would turn that into
      // a silent drop and a client stuck at tick 0. Then a checkpoint from the
      // SHADOW's state: in-process, with no round trip through a phone's uplink
      // at the worst possible moment (F-P4-27).
      this.sendKind(att, 'start', 'reliable', this.startBuf,
        (out) => encodeStart(out, buildStartMessage(room, room.raceSeed)))
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

    // The gate lives in lobby.ts; this calls it rather than repeating it.
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
    // `echoMs` is the PINGER's clock reading and is opaque here. A receiver that
    // stamps its own time turns RTT into clock skew and nothing fails loudly.
    this.sendKind(att, 'pong', 'unreliable', this.heartbeatBuf, (out) => encodeHeartbeat(out, msg))
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
    const room = att.room
    if (room === null) return
    for (const peer of room.peers.values()) {
      if (peer.slot !== env.to || !peer.connected) continue
      const dest = this.attached.get(peer.peerId)
      if (dest === undefined || dest.detached) return
      // `from` is overwritten with the sender's ACTUAL slot. A peer that names
      // someone else's slot must not be able to sign an offer as them.
      dest.socket.send(encodeSignal({ v: env.v, from: att.record.slot, to: env.to, msg: env.msg }))
      return
    }
  }

  // ---------------------------------------------------------------- outbound

  private startRoomRace(room: RoomRecord, nowMs: number): void {
    if (room.race !== null) return       // never a second shadow over a live race
    const ctx = this.deps.content.contextFor(room.trackId)
    if (ctx === null) {
      this.deps.log.write({ kind: 'rejected', code: room.code, result: 'badRequest' }, nowMs)
      return
    }
    if (room.phase === 'finished') room.phase = 'lobby'    // P4 Q36's post-results reset
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
        room, ctx, seed: room.raceSeed, characterIdx: start.characterIdx,
        humanMask: start.humanMask, transport, nowMs,
      })
    }
    // With SHADOW_ENABLED=false there is no ShadowLoop, so there is no
    // host-loss detector and therefore NO PROMOTION AT ALL. The variable exists
    // to measure the relay's cost in isolation and docs/server-env.md says so:
    // LogEvent has no member for it and §5.11's union is pinned.

    room.phase = 'racing'
    bumpLobbyVersion(room)
    this.deps.log.write(
      { kind: 'raceStarted', code: room.code, seed: room.raceSeed, trackId: room.trackId }, nowMs,
    )
  }

  private detach(att: AttachedPeer, nowMs: number): void {
    if (att.detached) return
    att.detached = true
    this.attached.delete(att.peerId)
    att.socket.close()

    const room = att.room
    if (room === null) return
    const record = room.peers.get(att.peerId)
    // The record STAYS, with connected false: `reclaim` matches a seat whose
    // peer has gone by token, and the lobby shows a greyed seat rather than an
    // empty one. The seat is not released -- the kart keeps racing bot-driven
    // and its owner can come back to it.
    if (record !== undefined) record.connected = false
    // A clean close makes that kart bot-driven IMMEDIATELY. It is not a
    // promotion decision: the shadow declares host loss 1.5 s later, from wall
    // time, and there is no second detector.
    room.race?.room.notePeerGone(att.peerId)

    this.deps.log.write(
      { kind: 'peerLeft', code: room.code, playerId: record === undefined ? -1 : record.playerId },
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
    att: AttachedPeer, room: RoomRecord, run: RaceRuntime, reason: ResyncReason, nowMs: number,
  ): void {
    att.lastCheckpointMs = nowMs
    this.sendKind(att, 'checkpoint', 'reliable', this.checkpointBuf,
      (out) => encodeCheckpoint(out, run.state))
    this.deps.log.write(
      { kind: 'checkpointSent', code: room.code, playerId: att.record.playerId, reason }, nowMs,
    )
  }

  private sendKind(
    att: AttachedPeer, kind: MessageKind, channel: ChannelName,
    buf: Uint8Array, encode: (out: Uint8Array) => number,
  ): void {
    const head = encodeHeader(buf, kind)
    const n = encode(buf.subarray(head))
    this.sendBody(att, channel, buf.subarray(0, head + n))
  }

  private sendBody(att: AttachedPeer, channel: ChannelName, body: Uint8Array): void {
    if (att.detached) return
    // A FRESH frame per send: the socket may queue it.
    const out = new Uint8Array(WS_HEADER_BYTES + body.length)
    encodeWsData(out, channel, WS_SLOT_SERVER, body)
    att.socket.send(out)
  }

  private sendFrame(peer: PeerRecord, frame: Uint8Array): void {
    const att = this.attached.get(peer.peerId)
    if (att === undefined || att.detached) return
    att.socket.send(frame)
  }

  private forward(to: PeerRecord, channel: ChannelName, fromSlot: number, payload: Uint8Array): void {
    const att = this.attached.get(to.peerId)
    if (att === undefined || att.detached) return
    const out = new Uint8Array(WS_HEADER_BYTES + payload.length)
    encodeWsData(out, channel, fromSlot, payload)
    att.socket.send(out)
  }

  private badFrame(att: AttachedPeer, why: string, nowMs: number): void {
    // A malformed frame is a counted, logged drop and NOT a close. decodeWsFrame
    // is total precisely so one hostile or corrupt datagram cannot end a live
    // race; the case the rule names -- a version mismatch after a deploy -- does
    // close the socket, with 4001.
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
        // `pollRace` has a RaceRuntime and no RoomRecord -- §5.1 pins the
        // runtime's eight fields and none of them is the room code -- so it
        // writes `code: ''` and the hub, which knows the room, stamps it.
        sink.write(ev.code === '' ? ({ ...ev, code } as LogEvent) : ev, nowMs)
      },
    }
    this.roomLogs.set(code, scoped)
    return scoped
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run packages/server/test/hub.test.ts`
Expected: all passing. The end-to-end case takes a few seconds: it runs three
simulations (host, shadow, guest) for about 13 s of virtual time.

Run: `npx vitest run packages/server/`
Expected: every server test green.

Run: `npx tsc --noEmit -p packages/server/tsconfig.json`
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/hub.ts packages/server/test/hub.test.ts \
        packages/server/test/fixtures/server-fixtures.ts
git commit -m "feat(server): RoomHub -- sockets, rooms, and the one heartbeat

RoomHub owns the sockets and nothing else owns them. Its binary handler does
four things in order: decodeWsFrame, route and re-frame, feed the shadow,
touch the room. It decodes no game message and reads the version byte for a
hello and nothing else -- a v1 hello closes the socket with 4001, because a
close code crosses a version boundary and an encoded welcome does not.

There is no second host-loss detector here. poll() calls stepRace, which
calls ShadowLoop.tick(nowMs), which counts wall milliseconds; pollRace
observes the promotion afterwards and writes one line. A clean socket close
makes that kart bot-driven immediately through notePeerGone and decides
nothing about authority -- two concerns this file does not conflate.

A late joiner gets start THEN checkpoint, from the shadow's own state: start
is what sizes the client's itemBoxes array, and decodeCheckpoint throws on a
mismatch, which the guard would turn into a silent drop.

close() disposes shadows and closes sockets. It broadcasts no race-over,
encodes no authorityChange and promotes nothing: the race keeps playing
host-authoritative over WebRTC (F-P4-24)."
```
