### Task 19: `packages/server/src/hub.ts` — the join policy and the relay rule

**Task 19 is split.** `hub.ts` is the largest module in the plan and it holds two
separable things: the **policy** (who may join, who may start, which peers a
datagram reaches) and the **machine** (`RoomHub`, the sockets, the poll loop).
This task writes the policy and the three constants; **Task 19b** writes
`RoomHub` and `PeerHandle` into the same file. Splitting keeps each reviewable
and keeps the policy — which is the part a test can pin — out of a socket
callback, which is the part a test cannot reach.

Why the policy is exported at all, in the contract's own words: *"it is the
entire join policy, and a policy that lives inside a socket callback cannot be
asserted."*

**Execution order — this is not numeric.** `hub.ts` imports `LogSink` (§5.11) and
`RateLimiter` (§5.12) from Task 22, and `ContentProvider` (§5.9) from Task 20.
Run **Task 18**, **Task 20**, and **Task 22's Steps 1–4 (log.ts and
ratelimit.ts)** before this one. If `packages/server/src/log.ts`,
`packages/server/src/ratelimit.ts` or `packages/server/src/content.ts` is
missing, stop and run those tasks first — do not stub them, because a stub of a
type this module consumes is how a plan discovers at task 24 that task 19 was
fiction.

**Files:**
- Create: `packages/server/src/hub.ts`
- Test: `packages/server/test/hub-routing.test.ts`
- Test: `packages/server/test/no-ip-keys.test.ts`

**Interfaces:**

- Consumes — `@tapkart/sim` [Plan 1, shipped]:
  ```ts
  export const MAX_KARTS = 8
  ```

- Consumes — `@tapkart/protocol` [contract §3.2, §3.3, earlier Plan 4 tasks]:
  ```ts
  export function normalizeRoomCode(input: string): string   // trim + uppercase. Total.
  export function isValidRoomCode(code: string): boolean     // canonical form only
  export function isValidSessionToken(raw: string): boolean
  export type PeerRole = 'host' | 'guest'
  export type JoinResult =
    | 'ok' | 'roomNotFound' | 'roomFull' | 'roomClosed'
    | 'versionMismatch' | 'badRequest' | 'rateLimited'
  export const CLIENT_FLAG_WEBRTC        = 1 << 0
  export const CLIENT_FLAG_READY         = 1 << 1
  export const CLIENT_FLAG_START_REQUEST = 1 << 2
  export const CLIENT_FLAG_RTC_FAILED    = 1 << 3
  export const SERVER_FLAG_IS_HOST          = 1 << 0
  export const SERVER_FLAG_RACE_IN_PROGRESS = 1 << 1
  export const SERVER_FLAG_RELAY_ASSIGNED   = 1 << 2
  export const SERVER_FLAG_RELAY_FIRST      = 1 << 3
  export const SERVER_FLAG_CHECKPOINT_NEXT  = 1 << 4
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
  ```

- Consumes — `@tapkart/net` [contract §4.2, §4.5]:
  ```ts
  export const WS_FRAME_DATA    = 0x00
  export const WS_SLOT_SERVER    = 0x00   // the room itself
  export const WS_SLOT_BROADCAST = 0xff   // "fan out to everyone but me"
  export interface WsFrame {
    frameKind: number; channel: ChannelName | null; controlOp: number | null
    peerSlot: number; payload: Uint8Array
  }
  /** The transport does NOT enforce it -- RoomClient does. */
  export const RTC_CONNECT_TIMEOUT_MS = 4000
  ```

- Consumes — the server's own earlier modules:
  ```ts
  // src/types.ts  (§5.1)      PeerId, PeerRecord, RoomRecord  -- quoted in Task 18
  // src/env.ts    (§5.2)
  export interface ServerConfig {
    port: number; bindHost: string; staticRoot: string; maxRooms: number
    maxPeersPerRoom: number; roomIdleMs: number
    joinRateLimit: RateLimitConfig
    iceServers: readonly IceServerConfig[]
    shadowEnabled: boolean
  }
  // src/random.ts (§5.3)
  export type RandomSource = (bytes: number) => Uint8Array
  // src/registry.ts (§5.4)
  // NOTE: `addPeer` is the SOLE MINTER of session tokens (the registry task's
  // decision 1), so nothing in this file mints one, and `reclaim` re-points
  // `room.seats[playerId]` at the new peer id itself (its decision 4).
  export class RoomLimitError extends Error {}
  export class RoomFullError extends Error {}
  export class CodeCollisionError extends Error {}
  export class RoomRegistry {
    constructor(opts: RegistryOptions)
    createRoom(nowMs: number): RoomRecord
    getRoom(code: string): RoomRecord | null
    addPeer(room: RoomRecord, peerId: PeerId, role: PeerRole, nowMs: number): PeerRecord
    removePeer(room: RoomRecord, peerId: PeerId, nowMs: number): PeerRecord | null
    reclaim(room: RoomRecord, token: string, peerId: PeerId, nowMs: number): PeerRecord | null
    touch(room: RoomRecord, nowMs: number): void
    expire(nowMs: number): RoomRecord[]
    rooms(): RoomRecord[]
    size(): number
  }
  // src/lobby.ts  (§5.5, Task 18)
  export function assignSeat(room: RoomRecord, peer: PeerRecord): number
  export function bumpLobbyVersion(room: RoomRecord): number
  export function isHost(room: RoomRecord, peer: PeerRecord): boolean
  export function seatOf(room: RoomRecord, peerId: PeerId): number
  // src/content.ts (§5.9, Task 20)
  export interface ContentProvider {
    track(id: string): Track | null
    contextFor(trackId: string): SimContext | null
    trackIds(): readonly string[]
  }
  // src/log.ts    (§5.11, Task 22)
  export interface LogSink { write(ev: LogEvent, nowMs: number): void }
  // src/ratelimit.ts (§5.12, Task 22)
  export interface RateLimiter {
    allowed(key: string, nowMs: number): boolean   // does NOT consume
    note(key: string, nowMs: number): void         // charges one failure
    reset(): void
  }
  ```

- Produces — eight of `hub.ts`'s ten §5.7 pins (Task 19b adds `PeerHandle` and
  `RoomHub`):
  ```ts
  export const CHECKPOINT_BUF_BYTES = 8192   // >= 5288 B for a 6-box track
  export const LOBBY_BUF_BYTES = 256         // >= LOBBY_MAX_BYTES 177 + 2 header
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
  export function shouldRelay(room: RoomRecord, from: PeerRecord, to: PeerRecord): boolean
  export function routeDatagram(room: RoomRecord, from: PeerRecord, frame: WsFrame): PeerRecord[]
  export function handleHello(
    deps: HubDeps, room: RoomRecord | null, peer: PeerRecord,
    msg: HelloMessage, nowMs: number,
  ): WelcomeMessage
  export function handleClientUpdate(
    deps: HubDeps, room: RoomRecord, peer: PeerRecord,
    msg: ClientUpdateMessage, nowMs: number,
  ): boolean
  ```

**Five decisions this task makes, because the contract states the rule and not
the mechanism.** Each is asserted by a test named below.

1. **`peer` is the socket's provisional record; after `ok` the authoritative one
   is `room.peers.get(peer.peerId)`.** `RoomRegistry.addPeer` is the sole
   assigner of slots and it creates the record, so the hub's pre-`hello` record
   cannot be the one the room holds. `handleHello` writes the client's
   declaration onto the **registry's** record and never onto the argument. There
   are never two live records for one socket: the provisional one is dropped at
   that instant (Task 19b does the dropping).
2. **A room creation is not rate-limited.** The limiter's key is the room code
   and a creating `hello` carries none; keying creations on `''` would put every
   room creation on the whole server into one bucket. `allowed` is consulted only
   when `code !== ''`.
3. **`note` is charged on `roomNotFound` and `roomClosed` only** — exactly the
   two answers a guesser learns something from. `badRequest` (a code that is not
   even in canonical form) is free because it can never name a real room, and
   `roomFull` is free because it means the guess *succeeded* and the limiter is
   not a capacity control.
4. **A reclaimed peer keeps its token, and this file mints nothing.**
   `RoomRegistry.addPeer` is the sole minter of session tokens and `reclaim`
   returns the record that already holds one, so a reconnect keeps the exact
   credential the client stored. Rotating would also work, but the stored
   credential is the client's only way back, and a client that failed to persist
   a rotation would lock itself out of the seat it is sitting in.
5. **`room.rtcFailures` resets when a guest that is past the give-up deadline
   sends an update without reporting failure.** F-P4-39 says the counter is
   "consecutive guests that gave up" and that the first guest to reach the host
   directly resets it — but no `CLIENT_FLAG_*` says "my link came up". What is
   observable is the *absence* of a report after `RTC_CONNECT_TIMEOUT_MS`, which
   is the deadline `RoomClient` itself enforces: a guest that was going to give
   up has already done so. That keeps `handleClientUpdate` the sole writer of
   `rtcFailures`, which §7 requires, and it is why this function takes `nowMs`.

---

- [ ] **Step 1: Write the failing test**

Create `packages/server/test/hub-routing.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { MAX_KARTS } from '@tapkart/sim'
import type { ClientUpdateMessage, HelloMessage } from '@tapkart/protocol'
import {
  CLIENT_FLAG_READY, CLIENT_FLAG_RTC_FAILED, CLIENT_FLAG_START_REQUEST, CLIENT_FLAG_WEBRTC,
  SERVER_FLAG_CHECKPOINT_NEXT, SERVER_FLAG_IS_HOST, SERVER_FLAG_RACE_IN_PROGRESS,
  SERVER_FLAG_RELAY_ASSIGNED, SERVER_FLAG_RELAY_FIRST, isValidRoomCode,
} from '@tapkart/protocol'
import type { WsFrame } from '@tapkart/net'
import {
  RTC_CONNECT_TIMEOUT_MS, WS_FRAME_CONTROL, WS_FRAME_DATA, WS_SLOT_BROADCAST, WS_SLOT_SERVER,
  createLiveness,
} from '@tapkart/net'
import type { Track } from '@tapkart/sim'
import type { PeerId, PeerRecord, RaceRuntime, RoomRecord } from '../src/types'
import type { RandomSource } from '../src/random'
import type { ContentProvider } from '../src/content'
import type { HubDeps } from '../src/hub'
import {
  RELAY_FIRST_AFTER_FAILURES, handleClientUpdate, handleHello, routeDatagram, shouldRelay,
} from '../src/hub'
import { RoomRegistry } from '../src/registry'
import { assignSeat } from '../src/lobby'
import { makeMemoryLogSink } from '../src/log'
import { makeRateLimiter } from '../src/ratelimit'
import { DEFAULT_CONFIG } from '../src/env'

/** §9.1's fake, byte i of draw n is (n * 31 + i) & 0xff, kept identical here so
 *  the fixture module can adopt it verbatim without changing any expectation. */
function countingRandom(): RandomSource {
  let draw = 0
  return (bytes: number): Uint8Array => {
    const out = new Uint8Array(bytes)
    for (let i = 0; i < bytes; i++) out[i] = (draw * 31 + i) & 0xff
    draw += 1
    return out
  }
}

const TRACK_IDS = ['caldera', 'glacier-pass'] as const

function fakeContent(): ContentProvider {
  const known = new Set<string>(TRACK_IDS)
  return {
    track: (id) => (known.has(id) ? ({ id } as unknown as Track) : null),
    contextFor: () => null,     // startRace is Task 20's; nothing here builds one
    trackIds: () => TRACK_IDS,
  }
}

interface Charge { key: string; nowMs: number }

function makeDeps(overrides: Partial<HubDeps> = {}): {
  deps: HubDeps
  log: ReturnType<typeof makeMemoryLogSink>
  charges: Charge[]
} {
  const log = makeMemoryLogSink()
  const charges: Charge[] = []
  const inner = makeRateLimiter({ windowMs: 60_000, max: 5 })
  const deps: HubDeps = {
    config: DEFAULT_CONFIG,
    registry: new RoomRegistry({
      maxRooms: 4, maxPeersPerRoom: MAX_KARTS, roomIdleMs: 600_000, rand: countingRandom(),
    }),
    content: fakeContent(),
    rand: countingRandom(),
    log,
    failedJoins: {
      allowed: (key, nowMs) => inner.allowed(key, nowMs),
      note: (key, nowMs) => { charges.push({ key, nowMs }); inner.note(key, nowMs) },
      reset: () => { inner.reset() },
    },
    ...overrides,
  }
  return { deps, log, charges }
}

let peerSeq = 0
function provisional(role: 'host' | 'guest' = 'guest'): PeerRecord {
  peerSeq += 1
  return {
    peerId: 'peer' + String(peerSeq), slot: 0, playerId: -1, token: '', role,
    name: '', characterIdx: 0, ready: false, relay: false, connected: true,
    joinedAtMs: 0, lastSeenMs: 0, liveness: createLiveness(0),
  }
}

function hello(over: Partial<HelloMessage> = {}): HelloMessage {
  return {
    role: 'guest', roomCode: '', token: '', characterIdx: 0, name: '',
    trackId: '', flags: CLIENT_FLAG_WEBRTC, ...over,
  }
}

function update(over: Partial<ClientUpdateMessage> = {}): ClientUpdateMessage {
  return { flags: 0, characterIdx: 0, name: '', trackId: '', ...over }
}

function dataFrame(peerSlot: number): WsFrame {
  return {
    frameKind: WS_FRAME_DATA, channel: 'unreliable', controlOp: null, peerSlot,
    payload: new Uint8Array([0x10, 0x02, 0x00]),
  }
}

/** Host + two guests, seated, with the relay flags the caller asks for. */
function topology(hostRelay: boolean, guestRelay: boolean[]): {
  room: RoomRecord; host: PeerRecord; guests: PeerRecord[]
} {
  const room: RoomRecord = {
    code: 'ABCDE', createdAtMs: 0, lastActivityMs: 0, phase: 'racing',
    hostPeerId: 'ph', hostPlayerId: 0, trackId: 'caldera', lobbyVersion: 1, raceSeed: 7,
    peers: new Map<PeerId, PeerRecord>(), slotsInUse: new Set<number>(),
    seats: new Array<PeerId | null>(MAX_KARTS).fill(null),
    rtcFailures: 0, race: null,
  }
  const host: PeerRecord = { ...provisional('host'), peerId: 'ph', slot: 1, relay: hostRelay }
  room.peers.set('ph', host)
  assignSeat(room, host)
  const guests = guestRelay.map((relay, i) => {
    const g: PeerRecord = { ...provisional(), peerId: 'pg' + String(i), slot: 2 + i, relay }
    room.peers.set(g.peerId, g)
    assignSeat(room, g)
    return g
  })
  return { room, host, guests }
}

describe('shouldRelay', () => {
  it('relays only between the host and a relay guest, never guest to guest', () => {
    const { room, host, guests } = topology(false, [true, false])
    const [relayGuest, rtcGuest] = guests

    expect(shouldRelay(room, host, relayGuest)).toBe(true)
    expect(shouldRelay(room, relayGuest, host)).toBe(true)
    expect(shouldRelay(room, host, rtcGuest)).toBe(false)
    expect(shouldRelay(room, rtcGuest, host)).toBe(false)
    expect(shouldRelay(room, relayGuest, rtcGuest)).toBe(false)
    expect(shouldRelay(room, relayGuest, relayGuest)).toBe(false)
  })

  it('never relays to a disconnected peer, and never without a host', () => {
    const { room, host, guests } = topology(false, [true])
    const [relayGuest] = guests

    expect(shouldRelay(room, host, relayGuest)).toBe(true)     // the floor
    relayGuest.connected = false
    expect(shouldRelay(room, host, relayGuest)).toBe(false)

    relayGuest.connected = true
    room.hostPeerId = null
    expect(shouldRelay(room, host, relayGuest)).toBe(false)
  })
})

describe('routeDatagram', () => {
  it("sends a relay guest's broadcast to the host and to no other guest", () => {
    const { room, guests } = topology(false, [true, true])
    const [a, b] = guests

    const to = routeDatagram(room, a, dataFrame(WS_SLOT_BROADCAST))
    expect(to.map((p) => p.peerId)).toEqual(['ph'])
    expect(to.map((p) => p.peerId)).not.toContain(b.peerId)
  })

  it("sends the host's broadcast to relay guests and not to peers whose WebRTC is up", () => {
    const { room, host, guests } = topology(false, [true, false, true])

    const to = routeDatagram(room, host, dataFrame(WS_SLOT_BROADCAST))
    expect(to.map((p) => p.peerId).sort()).toEqual([guests[0].peerId, guests[2].peerId].sort())
  })

  it('drops a direct guest\'s broadcast: it already reached the host over WebRTC', () => {
    const { room, guests } = topology(false, [false])
    expect(routeDatagram(room, guests[0], dataFrame(WS_SLOT_BROADCAST))).toEqual([])
  })

  it('routes a specific slot to that peer alone', () => {
    const { room, host, guests } = topology(false, [true, true])
    const to = routeDatagram(room, host, dataFrame(guests[1].slot))
    expect(to.map((p) => p.peerId)).toEqual([guests[1].peerId])
  })

  it('never returns the sender, whatever the slot says', () => {
    const { room, host, guests } = topology(true, [true])
    expect(routeDatagram(room, host, dataFrame(host.slot))).toEqual([])
    expect(routeDatagram(room, host, dataFrame(WS_SLOT_BROADCAST)).map((p) => p.peerId))
      .not.toContain(host.peerId)
    expect(routeDatagram(room, guests[0], dataFrame(WS_SLOT_BROADCAST)).map((p) => p.peerId))
      .not.toContain(guests[0].peerId)
  })

  it('relays nothing addressed to the room itself, and nothing from a control frame', () => {
    const { room, host, guests } = topology(false, [true])
    // The floor: this same room DOES relay a broadcast, so [] below is a rule.
    expect(routeDatagram(room, guests[0], dataFrame(WS_SLOT_BROADCAST))).toHaveLength(1)

    expect(routeDatagram(room, guests[0], dataFrame(WS_SLOT_SERVER))).toEqual([])
    expect(routeDatagram(room, host, {
      frameKind: WS_FRAME_CONTROL, channel: null, controlOp: 0x01,
      peerSlot: WS_SLOT_BROADCAST, payload: new Uint8Array(0),
    })).toEqual([])
  })

  it('routes to an unknown or disconnected slot as nobody', () => {
    const { room, host, guests } = topology(false, [true])
    expect(routeDatagram(room, host, dataFrame(200))).toEqual([])
    guests[0].connected = false
    expect(routeDatagram(room, host, dataFrame(guests[0].slot))).toEqual([])
  })
})

describe('handleHello — creating a room', () => {
  it('mints a room, seats the creator as host, and answers ok', () => {
    const { deps, log } = makeDeps()
    const peer = provisional('host')

    const w = handleHello(deps, null, peer, hello({ role: 'host', name: 'Ada', characterIdx: 3 }), 1000)

    expect(w.result).toBe('ok')
    expect(isValidRoomCode(w.roomCode)).toBe(true)
    expect(w.playerId).toBe(0)
    expect(w.token).not.toBe('')
    expect(w.hostPlayerId).toBe(0)
    expect(w.flags & SERVER_FLAG_IS_HOST).toBe(SERVER_FLAG_IS_HOST)
    expect(w.lobbyVersion).toBeGreaterThan(0)

    const room = deps.registry.getRoom(w.roomCode)
    expect(room).not.toBeNull()
    expect(room!.hostPeerId).toBe(peer.peerId)
    // The declaration lands on the REGISTRY's record, never on the provisional one.
    const seated = room!.peers.get(peer.peerId)
    expect(seated!.name).toBe('Ada')
    expect(seated!.characterIdx).toBe(3)
    expect(seated!.slot).toBeGreaterThan(0)
    expect(w.peerSlot).toBe(seated!.slot)
    expect(peer.name).toBe('')          // untouched

    expect(log.events().some((e) => e.kind === 'roomCreated' && e.code === w.roomCode)).toBe(true)
    expect(log.events().some((e) => e.kind === 'peerJoined' && e.playerId === 0)).toBe(true)
  })

  it('honours the creating host\'s trackId, and falls back to the first known track', () => {
    const { deps } = makeDeps()
    const a = handleHello(deps, null, provisional('host'), hello({ role: 'host', trackId: 'glacier-pass' }), 0)
    expect(deps.registry.getRoom(a.roomCode)!.trackId).toBe('glacier-pass')

    const b = handleHello(deps, null, provisional('host'), hello({ role: 'host', trackId: 'not-a-track' }), 0)
    expect(deps.registry.getRoom(b.roomCode)!.trackId).toBe('caldera')
  })

  it('answers roomFull when the registry is at its room cap', () => {
    const { deps } = makeDeps()
    for (let i = 0; i < 4; i++) {
      expect(handleHello(deps, null, provisional('host'), hello({ role: 'host' }), 0).result).toBe('ok')
    }
    const w = handleHello(deps, null, provisional('host'), hello({ role: 'host' }), 0)
    expect(w.result).toBe('roomFull')
    expect(w.playerId).toBe(-1)
    expect(w.token).toBe('')
  })
})

describe('handleHello — joining a room', () => {
  function withRoom(): { deps: HubDeps; log: ReturnType<typeof makeMemoryLogSink>; charges: Charge[]; room: RoomRecord } {
    const made = makeDeps()
    const w = handleHello(made.deps, null, provisional('host'), hello({ role: 'host', name: 'Host' }), 0)
    const room = made.deps.registry.getRoom(w.roomCode)!
    return { ...made, room }
  }

  it('seats a guest by code and never charges the limiter for a success', () => {
    const s = withRoom()
    const peer = provisional()

    const w = handleHello(s.deps, s.room, peer, hello({ roomCode: s.room.code.toLowerCase(), name: 'Bo' }), 100)

    expect(w.result).toBe('ok')
    expect(w.playerId).toBe(1)
    expect(w.hostPlayerId).toBe(0)
    expect(w.flags & SERVER_FLAG_IS_HOST).toBe(0)
    expect(s.charges).toEqual([])
  })

  it('answers roomNotFound and charges the ROOM CODE, once', () => {
    const s = withRoom()
    const w = handleHello(s.deps, null, provisional(), hello({ roomCode: 'ZZZZZ' }), 500)

    expect(w.result).toBe('roomNotFound')
    expect(s.charges).toEqual([{ key: 'ZZZZZ', nowMs: 500 }])
    expect(s.log.events().some((e) => e.kind === 'rejected' && e.result === 'roomNotFound')).toBe(true)
  })

  it('answers rateLimited once the code is over budget, without consulting the room', () => {
    const s = withRoom()
    for (let i = 0; i < 5; i++) handleHello(s.deps, null, provisional(), hello({ roomCode: 'ZZZZZ' }), 0)
    expect(s.charges).toHaveLength(5)              // the floor: five real failures

    const w = handleHello(s.deps, s.room, provisional(), hello({ roomCode: 'ZZZZZ' }), 0)
    expect(w.result).toBe('rateLimited')
    expect(s.charges).toHaveLength(5)              // a refusal is not itself charged

    // A different code is unaffected: the key is the code, and nothing about it
    // is derived from an address.
    expect(handleHello(s.deps, s.room, provisional(), hello({ roomCode: s.room.code }), 0).result).toBe('ok')
  })

  it('answers badRequest for a code that is not canonical, and charges nothing', () => {
    const s = withRoom()
    const w = handleHello(s.deps, null, provisional(), hello({ roomCode: 'ABC' }), 0)
    expect(w.result).toBe('badRequest')
    expect(s.charges).toEqual([])
  })

  it('answers roomClosed for an expired room and charges it', () => {
    const s = withRoom()
    s.room.phase = 'closed'
    const w = handleHello(s.deps, s.room, provisional(), hello({ roomCode: s.room.code }), 0)
    expect(w.result).toBe('roomClosed')
    expect(s.charges.map((c) => c.key)).toEqual([s.room.code])
  })

  it('answers roomFull for the ninth joiner', () => {
    const s = withRoom()
    for (let i = 1; i < MAX_KARTS; i++) {
      expect(handleHello(s.deps, s.room, provisional(), hello({ roomCode: s.room.code }), 0).result).toBe('ok')
    }
    const w = handleHello(s.deps, s.room, provisional(), hello({ roomCode: s.room.code }), 0)
    expect(w.result).toBe('roomFull')
    expect(s.charges).toEqual([])                  // a full room is not a guess
  })

  it('reclaims a seat by token: same playerId, same token, new slot', () => {
    const s = withRoom()
    const first = provisional()
    const w1 = handleHello(s.deps, s.room, first, hello({ roomCode: s.room.code, name: 'Bo' }), 0)
    expect(w1.result).toBe('ok')
    const seat = w1.playerId
    const oldSlot = w1.peerSlot

    // The socket goes away the way a backgrounded phone's does.
    s.room.peers.get(first.peerId)!.connected = false

    const second = provisional()
    const w2 = handleHello(s.deps, s.room, second, hello({ roomCode: s.room.code, token: w1.token, name: 'Bo' }), 5000)

    expect(w2.result).toBe('ok')
    expect(w2.playerId).toBe(seat)
    expect(w2.token).toBe(w1.token)
    expect(w2.peerSlot).not.toBe(oldSlot)
    expect(s.room.seats[seat]).toBe(second.peerId)
    expect(s.log.events().some((e) => e.kind === 'peerReclaimed' && e.playerId === seat)).toBe(true)
  })

  it('flags a late joiner RACE_IN_PROGRESS | CHECKPOINT_NEXT', () => {
    const s = withRoom()
    s.room.phase = 'racing'
    s.room.race = { shadow: { promotionTick: () => -1 } } as unknown as RaceRuntime

    const w = handleHello(s.deps, s.room, provisional(), hello({ roomCode: s.room.code }), 0)
    expect(w.result).toBe('ok')
    expect(w.flags & SERVER_FLAG_RACE_IN_PROGRESS).toBe(SERVER_FLAG_RACE_IN_PROGRESS)
    expect(w.flags & SERVER_FLAG_CHECKPOINT_NEXT).toBe(SERVER_FLAG_CHECKPOINT_NEXT)
  })

  it('puts a joiner straight on the relay once the room is relay-first', () => {
    const s = withRoom()
    s.room.rtcFailures = RELAY_FIRST_AFTER_FAILURES

    const peer = provisional()
    const w = handleHello(s.deps, s.room, peer, hello({ roomCode: s.room.code }), 0)

    expect(w.flags & SERVER_FLAG_RELAY_FIRST).toBe(SERVER_FLAG_RELAY_FIRST)
    expect(w.flags & SERVER_FLAG_RELAY_ASSIGNED).toBe(SERVER_FLAG_RELAY_ASSIGNED)
    expect(s.room.peers.get(peer.peerId)!.relay).toBe(true)
    expect(s.log.events().some((e) => e.kind === 'relayFirst' && e.failures === RELAY_FIRST_AFTER_FAILURES)).toBe(true)
  })
})

describe('handleClientUpdate', () => {
  function seated(): { deps: HubDeps; log: ReturnType<typeof makeMemoryLogSink>; room: RoomRecord; host: PeerRecord; guest: PeerRecord } {
    const made = makeDeps()
    const hp = provisional('host')
    const w = handleHello(made.deps, null, hp, hello({ role: 'host' }), 0)
    const room = made.deps.registry.getRoom(w.roomCode)!
    const gp = provisional()
    handleHello(made.deps, room, gp, hello({ roomCode: room.code }), 0)
    return {
      deps: made.deps, log: made.log, room,
      host: room.peers.get(hp.peerId)!, guest: room.peers.get(gp.peerId)!,
    }
  }

  it('applies ready, name and character, and bumps the version once per accepted change', () => {
    const s = seated()
    const before = s.room.lobbyVersion

    expect(handleClientUpdate(s.deps, s.room, s.guest, update({ flags: CLIENT_FLAG_READY, name: 'Bo', characterIdx: 6 }), 10)).toBe(true)
    expect(s.guest.ready).toBe(true)
    expect(s.guest.name).toBe('Bo')
    expect(s.guest.characterIdx).toBe(6)
    expect(s.room.lobbyVersion).toBe(before + 1)

    // An update that changes nothing is not a mutation and does not bump.
    expect(handleClientUpdate(s.deps, s.room, s.guest, update({ flags: CLIENT_FLAG_READY, name: 'Bo', characterIdx: 6 }), 20)).toBe(false)
    expect(s.room.lobbyVersion).toBe(before + 1)

    expect(handleClientUpdate(s.deps, s.room, s.guest, update({ flags: 0, name: 'Bo', characterIdx: 6 }), 30)).toBe(true)
    expect(s.guest.ready).toBe(false)
  })

  it('honours trackId from the host only', () => {
    const s = seated()
    expect(handleClientUpdate(s.deps, s.room, s.guest, update({ trackId: 'glacier-pass' }), 0)).toBe(false)
    expect(s.room.trackId).toBe('caldera')

    expect(handleClientUpdate(s.deps, s.room, s.host, update({ trackId: 'glacier-pass' }), 0)).toBe(true)
    expect(s.room.trackId).toBe('glacier-pass')

    expect(handleClientUpdate(s.deps, s.room, s.host, update({ trackId: 'not-a-track' }), 0)).toBe(false)
    expect(s.room.trackId).toBe('glacier-pass')
  })

  it('ignores CLIENT_FLAG_START_REQUEST entirely: starting is not a lobby mutation', () => {
    const s = seated()
    const before = s.room.lobbyVersion
    expect(handleClientUpdate(s.deps, s.room, s.host, update({ flags: CLIENT_FLAG_START_REQUEST }), 0)).toBe(false)
    expect(s.room.phase).toBe('lobby')
    expect(s.room.race).toBeNull()
    expect(s.room.lobbyVersion).toBe(before)
  })

  it('counts a give-up once per guest and logs relayFirst at the threshold', () => {
    const s = seated()
    const other = provisional()
    handleHello(s.deps, s.room, other, hello({ roomCode: s.room.code }), 0)
    const second = s.room.peers.get(other.peerId)!

    handleClientUpdate(s.deps, s.room, s.guest, update({ flags: CLIENT_FLAG_RTC_FAILED }), 0)
    expect(s.room.rtcFailures).toBe(1)
    expect(s.guest.relay).toBe(true)

    // A second report from the SAME guest is not a second failure.
    handleClientUpdate(s.deps, s.room, s.guest, update({ flags: CLIENT_FLAG_RTC_FAILED }), 10)
    expect(s.room.rtcFailures).toBe(1)

    handleClientUpdate(s.deps, s.room, second, update({ flags: CLIENT_FLAG_RTC_FAILED }), 20)
    expect(s.room.rtcFailures).toBe(RELAY_FIRST_AFTER_FAILURES)
    expect(s.log.events().some((e) => e.kind === 'relayFirst' && e.failures === RELAY_FIRST_AFTER_FAILURES)).toBe(true)
  })

  it('resets the counter for a guest past the give-up deadline that never gave up', () => {
    const s = seated()
    handleClientUpdate(s.deps, s.room, s.guest, update({ flags: CLIENT_FLAG_RTC_FAILED }), 0)
    expect(s.room.rtcFailures).toBe(1)             // the floor

    const fresh = provisional()
    handleHello(s.deps, s.room, fresh, hello({ roomCode: s.room.code }), 1000)
    const direct = s.room.peers.get(fresh.peerId)!

    // Before the deadline the silence proves nothing: it may still give up.
    handleClientUpdate(s.deps, s.room, direct, update({ name: 'early' }), 1000 + RTC_CONNECT_TIMEOUT_MS - 1)
    expect(s.room.rtcFailures).toBe(1)

    // Past it, RoomClient would already have sent CLIENT_FLAG_RTC_FAILED. It did
    // not, so this guest reached the host directly (F-P4-39).
    handleClientUpdate(s.deps, s.room, direct, update({ name: 'late' }), 1000 + RTC_CONNECT_TIMEOUT_MS)
    expect(s.room.rtcFailures).toBe(0)
  })
})
```

Create `packages/server/test/no-ip-keys.test.ts`:

```ts
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = join(import.meta.dirname, '..', 'src')

const FORBIDDEN = ['cf-connecting-ip', 'x-forwarded-for', 'remoteaddress', 'socket.address']

function sources(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sources(full))
    else if (entry.name.endsWith('.ts')) out.push(full)
  }
  return out
}

describe('no IP-derived rate-limit keys', () => {
  it('names no address header or socket address anywhere in packages/server/src', () => {
    const files = sources(SRC)
    // The floor: a broken walker would pass this test with zero files read.
    expect(files.length).toBeGreaterThan(0)

    const hits: string[] = []
    for (const file of files) {
      const text = readFileSync(file, 'utf8').toLowerCase()
      for (const needle of FORBIDDEN) {
        if (text.includes(needle)) hits.push(file + ' contains ' + needle)
      }
    }
    // Behind a Cloudflare Tunnel every request is one TCP peer. This project has
    // already collapsed to 60 accounts per building per 15 minutes that way.
    // F-P4-34 keys the limiter on the ROOM CODE, and this makes it mechanical.
    expect(hits).toEqual([])
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/server/test/hub-routing.test.ts packages/server/test/no-ip-keys.test.ts`

Expected: `hub-routing.test.ts` FAILS at collection with
`Failed to resolve import "../src/hub" from "packages/server/test/hub-routing.test.ts". Does the file exist?`

`no-ip-keys.test.ts` **passes** — there is nothing in `src` to violate it yet.
That is correct and it is not a fake RED: it is a standing guard, in the same
class as the no-secrets grep, and its value is that it fails the day someone adds
`request.headers['cf-connecting-ip']`.

- [ ] **Step 3: Write `packages/server/src/hub.ts`**

```ts
// PURE (over injected sockets, registry and a clock parameter). No `node:*`, no
// `ws`, no Date.now(): every function here takes `nowMs`.
import type { ClientUpdateMessage, HelloMessage, JoinResult, WelcomeMessage } from '@tapkart/protocol'
import {
  CLIENT_FLAG_READY, CLIENT_FLAG_RTC_FAILED,
  SERVER_FLAG_CHECKPOINT_NEXT, SERVER_FLAG_IS_HOST, SERVER_FLAG_RACE_IN_PROGRESS,
  SERVER_FLAG_RELAY_ASSIGNED, SERVER_FLAG_RELAY_FIRST,
  isValidRoomCode, isValidSessionToken, normalizeRoomCode,
} from '@tapkart/protocol'
import type { WsFrame } from '@tapkart/net'
import { RTC_CONNECT_TIMEOUT_MS, WS_FRAME_DATA, WS_SLOT_BROADCAST, WS_SLOT_SERVER } from '@tapkart/net'
import type { PeerRecord, RoomRecord } from './types'
import type { ServerConfig } from './env'
import type { RandomSource } from './random'
import { CodeCollisionError, RoomFullError, RoomLimitError, RoomRegistry } from './registry'
import { assignSeat, bumpLobbyVersion, isHost } from './lobby'
import type { ContentProvider } from './content'
import type { LogSink } from './log'
import type { RateLimiter } from './ratelimit'

export const CHECKPOINT_BUF_BYTES = 8192   // >= 5288 B for a 6-box track (§2.6)
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
    return reject(deps, peer, room.code, 'roomFull', nowMs)
  }
  if (!reclaimed) {
    deps.log.write({ kind: 'peerJoined', code: room.code, playerId: seated.playerId, relay: seated.relay }, nowMs)
  }

  seated.role = msg.role
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
  if (failed && !peer.relay) {
    peer.relay = true
    room.rtcFailures += 1
    changed = true
    if (room.rtcFailures === RELAY_FIRST_AFTER_FAILURES) {
      deps.log.write({ kind: 'relayFirst', code: room.code, failures: room.rtcFailures }, nowMs)
    }
  } else if (
    !failed && !peer.relay && room.rtcFailures > 0 &&
    nowMs - peer.joinedAtMs >= RTC_CONNECT_TIMEOUT_MS
  ) {
    // F-P4-39's reset. RoomClient enforces RTC_CONNECT_TIMEOUT_MS and sends
    // CLIENT_FLAG_RTC_FAILED exactly once when it expires; a guest still talking
    // past that deadline without having reported failure reached the host
    // directly. "Consecutive" is what makes the counter meaningful, so one
    // success clears it and a transient failure does not condemn the room.
    room.rtcFailures = 0
  }

  peer.lastSeenMs = nowMs
  if (changed) {
    bumpLobbyVersion(room)
    deps.registry.touch(room, nowMs)
  }
  return changed
}
```

**This file has no `MAX_KARTS` import and must not acquire one here** —
`noUnusedLocals` is on, and every seat-count decision in the hub is made by
`lobby.ts`. Task 19b adds the imports its own additions need and nothing else.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run packages/server/test/hub-routing.test.ts packages/server/test/no-ip-keys.test.ts`
Expected: all passing (24 in `hub-routing`, 1 in `no-ip-keys`).

Run: `npx tsc --noEmit -p packages/server/tsconfig.json`
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/hub.ts packages/server/test/hub-routing.test.ts \
        packages/server/test/no-ip-keys.test.ts
git commit -m "feat(server): the join policy and the relay rule

routeDatagram is the whole relay rule as one pure function: a relay guest's
broadcast reaches the host and no other guest, a host broadcast reaches
relay guests and never a peer whose WebRTC link is up, a specific slot
reaches that peer alone, and nothing ever returns to the sender.

handleHello is the entire join policy, exported because a policy inside a
socket callback cannot be asserted. Failed joins are limited PER ROOM CODE
and charged only on roomNotFound/roomClosed -- never on an address. Behind a
Cloudflare Tunnel every request is one TCP peer, and IP-keyed limiting once
collapsed this project to 60 accounts per building per 15 minutes.
no-ip-keys.test.ts makes that mechanical rather than remembered.

handleClientUpdate never reads CLIENT_FLAG_START_REQUEST: starting needs a
transport and a context, and canStart is the single gate. It is the sole
writer of rtcFailures, incrementing on a give-up and clearing when a guest
past RTC_CONNECT_TIMEOUT_MS talks without having given up -- which is the
only observable form of 'reached the host directly'."
```
