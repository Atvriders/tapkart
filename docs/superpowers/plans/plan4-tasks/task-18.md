### Task 18: `packages/server/src/lobby.ts` and `packages/server/src/roomtransport.ts`

Two small pure modules that everything after them stands on. `lobby.ts` is the
**server-side truth about seats** (F-P4-31: the server owns the lobby — seats,
names, ready flags, track and start). `roomtransport.ts` is the **server-side
`Transport`**: one per race, N sockets behind it, and the object `ShadowLoop` is
constructed over.

Two things bind this task specifically:

- **`seatMapOf` must read the room on every call, never at construction time.**
  It is the object `withPeerAuthority` consults for every inbound datagram, and
  its `isAuthority` answer changes at the instant of promotion. A seat map that
  captured `room.race` when it was built would still say "the host is
  authoritative" forever, and a promoted shadow's room would go on accepting
  snapshots from the old host.
- **`notePeerGone` is not a promotion decision.** It fires `onPeerLost`, which is
  how a clean socket close makes a kart bot-driven **immediately** — 1.5 s before
  any promotion could happen. Mobile browsers close sockets on backgrounding
  routinely; conflating "this socket closed" with "this host is gone" is exactly
  what F-P4-22 refuses.

**Execution order.** This task depends only on `src/types.ts` (§5.1) from the
server scaffold plus `@tapkart/sim`, `@tapkart/protocol` and `@tapkart/net`. It
must land **before** Tasks 19, 19b and 20, all of which import from it.

**Files:**
- Create: `packages/server/src/lobby.ts`
- Create: `packages/server/src/roomtransport.ts`
- Create: `packages/net/test/fixtures/transport-conformance.ts` — **§9.2's shared
  suite has no other owner.** No task in this plan creates it and four other
  tasks are supposed to run it, so it is created here, in `net`, where it
  belongs. **If it already exists, do not overwrite it**: run the existing one
  and add only the harness. Every other `Transport` implementation
  (`LoopbackTransport`, `LocalInputTransport`, `WebSocketTransport`,
  `WebRtcTransport`) should be run through it too; that is the assembler's to
  place, and this task does not edit another task's test file to do it.
- Test: `packages/server/test/lobby.test.ts`
- Test: `packages/server/test/roomtransport.test.ts`

**Do not touch `packages/server/src/index.ts`.** Task 22 writes the barrel, in
one edit, with all twelve modules.

**Interfaces:**

- Consumes — `@tapkart/sim` [Plan 1, shipped]:
  ```ts
  export const MAX_KARTS = 8
  ```

- Consumes — `@tapkart/protocol` [contract §3.3, an earlier Plan 4 task]:
  ```ts
  export type PeerRole = 'host' | 'guest'
  export interface WireLobbySlot {
    occupied: boolean; isBot: boolean; connected: boolean; ready: boolean
    characterIdx: number
    /** The transport slot that owns this seat, or 0 for none. This IS the
     *  authorised peer->seat map. */
    peerSlot: number
    name: string
  }
  export interface LobbyMessage {
    lobbyVersion: number
    hostPlayerId: number    // -1 when none
    trackId: string
    slots: WireLobbySlot[]  // length MAX_KARTS, index === playerId
  }
  export interface StartMessage {
    raceSeed: number        // u32
    trackId: string
    humanMask: number       // bit i set === seat i is a connected human at start
    characterIdx: number[]  // length MAX_KARTS
  }
  export type ChannelName = 'unreliable' | 'reliable'
  ```

- Consumes — `@tapkart/net` [contract §2.1, §4.2, §4.7, §4.8]:
  ```ts
  export interface Transport {
    send(channel: ChannelName, peerId: string, data: Uint8Array): void
    broadcast(channel: ChannelName, data: Uint8Array): void
    onMessage(cb: (peerId: string, channel: ChannelName, data: Uint8Array) => void): void
    onPeerLost(cb: (peerId: string) => void): void
    peers(): string[]
    close(): void
  }
  export interface PeerAuthority {
    /** The seat this peer is authorised to submit input for, or -1 for none. */
    playerIdOf(peerId: string): number
    /** True only for the peer currently entitled to originate AUTHORITATIVE
     *  traffic. After promotion nothing inbound is authoritative and this
     *  returns false for everyone. */
    isAuthority(peerId: string): boolean
  }
  export const WS_HEADER_BYTES = 3
  export const WS_SLOT_SERVER = 0x00   // the room itself
  export function encodeWsData(out: Uint8Array, channel: ChannelName, peerSlot: number, payload: Uint8Array): number
  export function decodeWsFrame(buf: Uint8Array): WsFrame | null
  export interface WsFrame {
    frameKind: number; channel: ChannelName | null; controlOp: number | null
    peerSlot: number; payload: Uint8Array
  }
  export interface LivenessState {
    lastSeenMs: number; lastPingSentMs: number; lastPingSeq: number
    rttMs: number; pingsSent: number; pongsSeen: number
  }
  export function createLiveness(nowMs: number): LivenessState
  ```

- Consumes — `packages/server/src/types.ts` [contract §5.1, the server scaffold task]:
  ```ts
  export type PeerId = string
  export type ServerRoomPhase = 'lobby' | 'racing' | 'finished' | 'closed'
  export interface PeerRecord {
    peerId: PeerId; slot: number; playerId: number; token: string; role: PeerRole
    name: string; characterIdx: number; ready: boolean; relay: boolean
    connected: boolean; joinedAtMs: number; lastSeenMs: number; liveness: LivenessState
  }
  export interface RoomRecord {
    code: string; createdAtMs: number; lastActivityMs: number; phase: ServerRoomPhase
    hostPeerId: PeerId | null; hostPlayerId: number; trackId: string
    lobbyVersion: number; raceSeed: number
    peers: Map<PeerId, PeerRecord>; slotsInUse: Set<number>
    seats: (PeerId | null)[]      // length MAX_KARTS, index === playerId
    rtcFailures: number
    race: RaceRuntime | null
  }
  export interface RaceRuntime {
    ctx: SimContext; state: SimState; shadow: ShadowLoop
    transport: Transport; room: RoomTransport
    acc: TickAccumulator; lastPollMs: number; startedAtMs: number
  }
  ```

- Produces — `packages/net/test/fixtures/transport-conformance.ts`, §9.2's two
  (consumed from `packages/server/test/` by **relative path**: §2.11 forbids a
  bare specifier into another package's test tree):
  ```ts
  export interface ConformanceHarness {
    a: Transport; b: Transport
    flush(): void   // deliver everything in flight
    dropB(): void   // simulate the far end vanishing, so onPeerLost must fire
  }
  export function runTransportConformance(name: string, make: () => ConformanceHarness): void
  ```

- Produces — `src/lobby.ts`, the eleven §5.5 pins:
  ```ts
  export function assignSeat(room: RoomRecord, peer: PeerRecord): number
  export function releaseSeat(room: RoomRecord, peer: PeerRecord): void
  export function seatOf(room: RoomRecord, peerId: PeerId): number
  export function bumpLobbyVersion(room: RoomRecord): number
  export function buildLobbyMessage(room: RoomRecord): LobbyMessage
  export function buildStartMessage(room: RoomRecord, seed: number): StartMessage
  export function humanMaskOf(room: RoomRecord): number
  export function characterIdxOf(room: RoomRecord): number[]
  export function seatMapOf(room: RoomRecord): PeerAuthority
  export function isHost(room: RoomRecord, peer: PeerRecord): boolean
  export function canStart(room: RoomRecord, peer: PeerRecord): boolean
  ```

- Produces — `src/roomtransport.ts`, the three §5.6 pins:
  ```ts
  export interface RoomTransportOptions {
    room: RoomRecord
    sendFrame: (peer: PeerRecord, frame: Uint8Array) => void
  }
  export interface RoomTransport extends Transport {
    deliver(peerId: string, channel: ChannelName, payload: Uint8Array): void
    notePeerGone(peerId: string): void
  }
  export function makeRoomTransport(opts: RoomTransportOptions): RoomTransport
  ```

**Three rules this module obeys and the census depends on:** `lobby.ts` is the
sole writer of `RoomRecord.seats`, `PeerRecord.playerId`, `RoomRecord.hostPlayerId`
and `RoomRecord.lobbyVersion`; it never touches a `SimState`; and it never mints
anything (no codes, no tokens, no seeds — those are `random.ts`'s).

---

- [ ] **Step 1: Write the failing test for `lobby.ts`**

Create `packages/server/test/lobby.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { MAX_KARTS } from '@tapkart/sim'
import { createLiveness } from '@tapkart/net'
import type { PeerId, PeerRecord, RaceRuntime, RoomRecord } from '../src/types'
import {
  assignSeat, bumpLobbyVersion, buildLobbyMessage, buildStartMessage, canStart,
  characterIdxOf, humanMaskOf, isHost, releaseSeat, seatMapOf, seatOf,
} from '../src/lobby'

function makeRoom(overrides: Partial<RoomRecord> = {}): RoomRecord {
  return {
    code: 'ABCDE',
    createdAtMs: 0,
    lastActivityMs: 0,
    phase: 'lobby',
    hostPeerId: null,
    hostPlayerId: -1,
    trackId: 'caldera',
    lobbyVersion: 1,
    raceSeed: 0,
    peers: new Map<PeerId, PeerRecord>(),
    slotsInUse: new Set<number>(),
    seats: new Array<PeerId | null>(MAX_KARTS).fill(null),
    rtcFailures: 0,
    race: null,
    ...overrides,
  }
}

function makePeer(peerId: string, slot: number, overrides: Partial<PeerRecord> = {}): PeerRecord {
  return {
    peerId,
    slot,
    playerId: -1,
    token: '',
    role: 'guest',
    name: '',
    characterIdx: 0,
    ready: false,
    relay: false,
    connected: true,
    joinedAtMs: 0,
    lastSeenMs: 0,
    liveness: createLiveness(0),
    ...overrides,
  }
}

/** Adds the record to the room's peer map and seats it. Returns the record. */
function join(room: RoomRecord, peer: PeerRecord): PeerRecord {
  room.peers.set(peer.peerId, peer)
  assignSeat(room, peer)
  return peer
}

/** A RaceRuntime is 8 fields of live machinery and `seatMapOf` reads exactly one
 *  of them, so the test builds exactly one. The cast is deliberate and narrow:
 *  constructing a real ShadowLoop here would test `net`, not this module. */
function withPromotionTick(tick: number): RaceRuntime {
  return { shadow: { promotionTick: () => tick } } as unknown as RaceRuntime
}

describe('seatOf / assignSeat / releaseSeat', () => {
  it('assigns the lowest free seat so a four-player grid is dense', () => {
    const room = makeRoom()
    const a = join(room, makePeer('pa', 1))
    const b = join(room, makePeer('pb', 2))
    const c = join(room, makePeer('pc', 3))

    expect([a.playerId, b.playerId, c.playerId]).toEqual([0, 1, 2])
    expect(room.seats.slice(0, 3)).toEqual(['pa', 'pb', 'pc'])
    expect(room.seats.slice(3)).toEqual([null, null, null, null, null])

    releaseSeat(room, b)
    expect(b.playerId).toBe(-1)
    expect(room.seats[1]).toBeNull()

    const d = join(room, makePeer('pd', 4))
    expect(d.playerId).toBe(1)          // the hole, not seat 3
    expect(seatOf(room, 'pd')).toBe(1)
  })

  it('is idempotent for a peer that already holds a seat', () => {
    const room = makeRoom()
    const a = join(room, makePeer('pa', 1))
    expect(assignSeat(room, a)).toBe(0)
    expect(assignSeat(room, a)).toBe(0)
    expect(room.seats.filter((s) => s === 'pa')).toHaveLength(1)
  })

  it('returns -1 when all eight seats are taken and leaves the table untouched', () => {
    const room = makeRoom()
    for (let i = 0; i < MAX_KARTS; i++) join(room, makePeer('p' + String(i), i + 1))
    const ninth = makePeer('p8', 9)
    room.peers.set('p8', ninth)

    expect(assignSeat(room, ninth)).toBe(-1)
    expect(ninth.playerId).toBe(-1)
    expect(room.seats.filter((s) => s !== null)).toHaveLength(MAX_KARTS)
  })

  it('gives a peer that carries a playerId back its OWN seat, not the lowest free one', () => {
    // RoomRegistry.reclaim preserves playerId, mints a NEW peerId and re-points
    // the seat itself. This is the second line of defence for any path that
    // revives a record without re-pointing: handing out seat 0 here would drop
    // the returning player into someone else's kart, and seatMapOf would then
    // authorise them for it.
    const room = makeRoom()
    join(room, makePeer('pa', 1))
    const b = join(room, makePeer('pb', 2))
    expect(b.playerId).toBe(1)

    room.peers.delete('pb')                                   // the socket went away
    room.seats[0] = null                                      // seat 0 is free, and must stay free
    const revived = makePeer('pb2', 7, { playerId: 1 })       // same playerId, new peerId
    room.peers.set('pb2', revived)

    expect(assignSeat(room, revived)).toBe(1)
    expect(room.seats[1]).toBe('pb2')
    expect(room.seats[0]).toBeNull()
  })

  it('seatOf returns -1 for a peer that holds no seat', () => {
    const room = makeRoom()
    join(room, makePeer('pa', 1))
    expect(seatOf(room, 'pa')).toBe(0)
    expect(seatOf(room, 'nobody')).toBe(-1)
  })

  it('assignSeat is the sole writer of hostPlayerId', () => {
    const room = makeRoom({ hostPeerId: 'ph' })
    join(room, makePeer('pg', 1))                             // a guest lands in seat 0
    expect(room.hostPlayerId).toBe(-1)                        // still nobody's

    const host = join(room, makePeer('ph', 2))
    expect(host.playerId).toBe(1)
    expect(room.hostPlayerId).toBe(1)
  })
})

describe('bumpLobbyVersion', () => {
  it('increments by exactly one per call and returns the new value', () => {
    const room = makeRoom({ lobbyVersion: 4 })
    expect(bumpLobbyVersion(room)).toBe(5)
    expect(bumpLobbyVersion(room)).toBe(6)
    expect(room.lobbyVersion).toBe(6)
  })
})

describe('buildLobbyMessage', () => {
  it('projects three humans onto three occupied slots and five empty ones', () => {
    const room = makeRoom({ hostPeerId: 'pa', lobbyVersion: 9, trackId: 'glacier-pass' })
    join(room, makePeer('pa', 11, { name: 'Ada', characterIdx: 3, ready: true, role: 'host' }))
    join(room, makePeer('pb', 12, { name: 'Bo', characterIdx: 5 }))
    join(room, makePeer('pc', 254, { name: '', characterIdx: 7, connected: false }))

    const msg = buildLobbyMessage(room)

    expect(msg.lobbyVersion).toBe(9)
    expect(msg.trackId).toBe('glacier-pass')
    expect(msg.hostPlayerId).toBe(0)
    expect(msg.slots).toHaveLength(MAX_KARTS)

    // The floor: the three occupied slots carry the values that were set, so an
    // all-empty projection cannot satisfy "three occupied, five empty".
    expect(msg.slots[0]).toEqual({
      occupied: true, isBot: false, connected: true, ready: true,
      characterIdx: 3, peerSlot: 11, name: 'Ada',
    })
    expect(msg.slots[1]).toEqual({
      occupied: true, isBot: false, connected: true, ready: false,
      characterIdx: 5, peerSlot: 12, name: 'Bo',
    })
    // A dropped player is still an occupied seat, greyed out -- not an empty one.
    expect(msg.slots[2]).toEqual({
      occupied: true, isBot: false, connected: false, ready: false,
      characterIdx: 7, peerSlot: 254, name: '',
    })
    for (let i = 3; i < MAX_KARTS; i++) {
      expect(msg.slots[i]).toEqual({
        occupied: false, isBot: true, connected: false, ready: false,
        characterIdx: 0, peerSlot: 0, name: '',
      })
    }
  })

  it('renders a seat whose peer record is gone as an empty bot seat', () => {
    const room = makeRoom()
    join(room, makePeer('pa', 1, { name: 'Ada' }))
    room.peers.delete('pa')                                   // seats still points at 'pa'

    const msg = buildLobbyMessage(room)
    expect(msg.slots[0].occupied).toBe(false)
    expect(msg.slots[0].isBot).toBe(true)
    expect(msg.slots[0].name).toBe('')
  })
})

describe('humanMaskOf / characterIdxOf / buildStartMessage', () => {
  it('sets a bit for every CONNECTED human seat and no other', () => {
    const room = makeRoom()
    join(room, makePeer('p0', 1))
    join(room, makePeer('p1', 2))
    join(room, makePeer('p2', 3))
    join(room, makePeer('p3', 4))
    // seat 1 dropped, seat 3 dropped: 0b0101 === 5
    room.peers.get('p1')!.connected = false
    room.peers.get('p3')!.connected = false

    const mask = humanMaskOf(room)
    expect(mask).toBe(0b0101)
    // The floor: a mask of 0 would also "have no disconnected bits set".
    expect(mask).not.toBe(0)
  })

  it('is 0 for an empty room', () => {
    expect(humanMaskOf(makeRoom())).toBe(0)
  })

  it('characterIdxOf is MAX_KARTS long, with 0 for every empty seat', () => {
    const room = makeRoom()
    join(room, makePeer('p0', 1, { characterIdx: 6 }))
    join(room, makePeer('p1', 2, { characterIdx: 15 }))

    expect(characterIdxOf(room)).toEqual([6, 15, 0, 0, 0, 0, 0, 0])
  })

  it('buildStartMessage carries the seed, the room track, the mask and the seats', () => {
    const room = makeRoom({ trackId: 'redwood-rise' })
    join(room, makePeer('p0', 1, { characterIdx: 2 }))
    join(room, makePeer('p1', 2, { characterIdx: 4 }))

    const start = buildStartMessage(room, 0xdeadbeef)
    expect(start.raceSeed).toBe(0xdeadbeef)
    expect(start.trackId).toBe('redwood-rise')
    expect(start.humanMask).toBe(0b11)
    expect(start.characterIdx).toEqual([2, 4, 0, 0, 0, 0, 0, 0])
  })
})

describe('seatMapOf', () => {
  it('maps a peer to its seat and an unknown peer to -1', () => {
    const room = makeRoom({ hostPeerId: 'ph' })
    join(room, makePeer('ph', 1))
    join(room, makePeer('pg', 2))

    const map = seatMapOf(room)
    expect(map.playerIdOf('ph')).toBe(0)
    expect(map.playerIdOf('pg')).toBe(1)
    expect(map.playerIdOf('stranger')).toBe(-1)
  })

  it('makes only the host authoritative, and nobody once the shadow promotes', () => {
    const room = makeRoom({ hostPeerId: 'ph' })
    join(room, makePeer('ph', 1))
    join(room, makePeer('pg', 2))
    const map = seatMapOf(room)

    // No race yet: nothing has promoted, so the host is still the authority.
    // startRace builds this map BEFORE `room.race` is assigned, and a snapshot
    // arriving in that window must not be dropped as `notAuthority`.
    expect(map.isAuthority('ph')).toBe(true)
    expect(map.isAuthority('pg')).toBe(false)

    room.race = withPromotionTick(-1)
    expect(map.isAuthority('ph')).toBe(true)

    // The map is read live. A seat map that captured `room.race` at construction
    // would answer `true` here forever, and the promoted room would go on
    // reconciling onto the old host's snapshots.
    room.race = withPromotionTick(612)
    expect(map.isAuthority('ph')).toBe(false)
    expect(map.isAuthority('pg')).toBe(false)
  })

  it('reflects a seat assigned after the map was built', () => {
    const room = makeRoom({ hostPeerId: 'ph' })
    const map = seatMapOf(room)
    expect(map.playerIdOf('ph')).toBe(-1)

    join(room, makePeer('ph', 1))
    expect(map.playerIdOf('ph')).toBe(0)
  })
})

describe('isHost / canStart', () => {
  it('is false for a guest and true for the room creator', () => {
    const room = makeRoom({ hostPeerId: 'ph' })
    const host = join(room, makePeer('ph', 1, { role: 'host' }))
    const guest = join(room, makePeer('pg', 2))

    expect(isHost(room, host)).toBe(true)
    expect(isHost(room, guest)).toBe(false)
    expect(canStart(room, host)).toBe(true)
    expect(canStart(room, guest)).toBe(false)
  })

  it('refuses a start while a race is live, and allows one from the results screen', () => {
    const room = makeRoom({ hostPeerId: 'ph' })
    const host = join(room, makePeer('ph', 1, { role: 'host' }))

    room.phase = 'racing'
    room.race = withPromotionTick(-1)
    expect(canStart(room, host)).toBe(false)

    room.phase = 'finished'
    room.race = null
    expect(canStart(room, host)).toBe(true)     // P4 Q36: seats survive the results screen

    room.phase = 'closed'
    expect(canStart(room, host)).toBe(false)
  })

  it('refuses a start from an unseated host', () => {
    const room = makeRoom({ hostPeerId: 'ph' })
    const host = makePeer('ph', 1, { role: 'host' })
    room.peers.set('ph', host)                  // in the room, never seated

    expect(isHost(room, host)).toBe(true)
    expect(canStart(room, host)).toBe(false)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/server/test/lobby.test.ts`

Expected: FAIL at collection with
`Failed to resolve import "../src/lobby" from "packages/server/test/lobby.test.ts". Does the file exist?`

- [ ] **Step 3: Write `packages/server/src/lobby.ts`**

```ts
// PURE. A function of its arguments. No socket, no clock, no filesystem, no
// timer, and no SimState: a room's lobby bookkeeping and its simulation share
// exactly one value, `humanMask`, and it is produced here and consumed there.
import { MAX_KARTS } from '@tapkart/sim'
import type { LobbyMessage, StartMessage, WireLobbySlot } from '@tapkart/protocol'
import type { PeerAuthority } from '@tapkart/net'
import type { PeerId, PeerRecord, RoomRecord } from './types'

/**
 * Lowest free seat index, or -1. Seats are assigned in ascending order so a
 * four-player race always occupies 0..3 and the grid is dense.
 *
 * Sole writer of `RoomRecord.seats`, `PeerRecord.playerId` and
 * `RoomRecord.hostPlayerId`.
 */
export function assignSeat(room: RoomRecord, peer: PeerRecord): number {
  const held = seatOf(room, peer.peerId)
  if (held >= 0) {
    if (isHost(room, peer)) room.hostPlayerId = held
    peer.playerId = held
    return held
  }

  // A peer that carries a playerId keeps the seat it held. `RoomRegistry.reclaim`
  // preserves `playerId`, carries a NEW peerId, and re-points `room.seats` itself
  // -- so this branch is the second line of defence, for any path that revives a
  // record without re-pointing. Handing out the lowest free seat there would drop
  // a returning player into someone else's kart, and the seat map would then
  // authorise them for it.
  const prior = peer.playerId
  if (prior >= 0 && prior < MAX_KARTS) {
    const holder = room.seats[prior]
    if (holder === null || !room.peers.has(holder)) {
      room.seats[prior] = peer.peerId
      if (isHost(room, peer)) room.hostPlayerId = prior
      return prior
    }
  }

  for (let i = 0; i < MAX_KARTS; i++) {
    if (room.seats[i] !== null) continue
    room.seats[i] = peer.peerId
    peer.playerId = i
    if (isHost(room, peer)) room.hostPlayerId = i
    return i
  }
  return -1
}

/** Frees the seat this peer holds, if any. Total. */
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

/** The seat this peer holds, or -1. Total over any string. */
export function seatOf(room: RoomRecord, peerId: PeerId): number {
  for (let i = 0; i < MAX_KARTS; i++) {
    if (room.seats[i] === peerId) return i
  }
  return -1
}

/**
 * Sole writer of `lobbyVersion`; returns the new value. One increment per
 * ACCEPTED mutation, so a client compares with `!==` and never with `<`.
 */
export function bumpLobbyVersion(room: RoomRecord): number {
  room.lobbyVersion += 1
  return room.lobbyVersion
}

/** Pure projection of a RoomRecord onto the wire. No side effects, no minting. */
export function buildLobbyMessage(room: RoomRecord): LobbyMessage {
  const slots: WireLobbySlot[] = []
  for (let i = 0; i < MAX_KARTS; i++) {
    const peerId = room.seats[i]
    const peer = peerId === null ? undefined : room.peers.get(peerId)
    if (peer === undefined) {
      // An empty seat is a future bot: `createState` makes every seat
      // `isBot: true, connected: false`, and `humanMask` is the only thing that
      // says otherwise.
      slots.push({
        occupied: false, isBot: true, connected: false, ready: false,
        characterIdx: 0, peerSlot: 0, name: '',
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

/** Pure projection. The seed is minted by the caller, never here. */
export function buildStartMessage(room: RoomRecord, seed: number): StartMessage {
  return {
    raceSeed: seed >>> 0,
    trackId: room.trackId,
    humanMask: humanMaskOf(room),
    characterIdx: characterIdxOf(room),
  }
}

/**
 * Bit `i` set means seat `i` is a CONNECTED human at the moment `start` is sent;
 * every clear bit is a bot. A player in the room but not "ready" is still a
 * human seat.
 */
export function humanMaskOf(room: RoomRecord): number {
  let mask = 0
  for (let i = 0; i < MAX_KARTS; i++) {
    const peerId = room.seats[i]
    if (peerId === null) continue
    const peer = room.peers.get(peerId)
    if (peer !== undefined && peer.connected) mask |= 1 << i
  }
  return mask
}

/** Length MAX_KARTS, index === playerId, 0 for every empty seat. */
export function characterIdxOf(room: RoomRecord): number[] {
  const out: number[] = []
  for (let i = 0; i < MAX_KARTS; i++) {
    const peerId = room.seats[i]
    const peer = peerId === null ? undefined : room.peers.get(peerId)
    out.push(peer === undefined ? 0 : peer.characterIdx)
  }
  return out
}

/**
 * The authorised peer -> seat map `withPeerAuthority` enforces, built from the
 * room's seats.
 *
 * Both members read `room` on EVERY call. `isAuthority`'s answer changes at the
 * instant of promotion, and a map that captured `room.race` when it was built
 * would answer "the host is authoritative" forever -- so a promoted room would
 * go on reconciling onto the old host's snapshots.
 */
export function seatMapOf(room: RoomRecord): PeerAuthority {
  return {
    playerIdOf(peerId: string): number {
      return seatOf(room, peerId)
    },
    isAuthority(peerId: string): boolean {
      if (room.hostPeerId === null || room.hostPeerId !== peerId) return false
      const run = room.race
      // No race => nothing has promoted => the host is still the authority.
      // `startRace` builds this map before `room.race` is assigned, and a
      // snapshot arriving in that window must not be dropped.
      return run === null ? true : run.shadow.promotionTick() < 0
    },
  }
}

/**
 * Host-only actions are gated here, not at the call site, so there is one answer
 * to "may this peer do that".
 */
export function isHost(room: RoomRecord, peer: PeerRecord): boolean {
  return room.hostPeerId !== null && room.hostPeerId === peer.peerId
}

/**
 * A start is the host's, from a room that is not already racing, by a host that
 * holds a seat.
 *
 * It deliberately does NOT require every guest to be ready: a guest who never
 * toggles it would otherwise hold the room hostage, and "ready" is what the
 * lobby DISPLAYS, not what it enforces. `'finished'` is allowed because P4 Q36's
 * post-results reset keeps the seats and re-mints the seed at the next start.
 */
export function canStart(room: RoomRecord, peer: PeerRecord): boolean {
  if (!isHost(room, peer)) return false
  if (room.phase !== 'lobby' && room.phase !== 'finished') return false
  if (room.race !== null) return false
  return seatOf(room, peer.peerId) >= 0
}
```

- [ ] **Step 4: Run the lobby test to verify it passes**

Run: `npx vitest run packages/server/test/lobby.test.ts`
Expected: 17 passing, 0 failing.

- [ ] **Step 5: Write §9.2's shared conformance suite**

Create `packages/net/test/fixtures/transport-conformance.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { ChannelName } from '@tapkart/protocol'
import type { Transport } from '../../src/transport'

/**
 * §9.2. One shared suite, run against EVERY Transport implementation.
 *
 * Without it, each implementation satisfies whichever of §2.1's six behaviours
 * its own author happened to notice, and the divergence surfaces as a lobby that
 * works on loopback and silently dies over WebRTC -- because `onMessage`
 * replaced a listener instead of appending one, and `RoomClient` was the
 * listener it deleted.
 */
export interface ConformanceHarness {
  a: Transport
  b: Transport
  /** Deliver everything in flight. */
  flush(): void
  /** Simulate the far end vanishing, so onPeerLost must fire. */
  dropB(): void
}

interface Received {
  peerId: string
  channel: ChannelName
  bytes: number[]
}

function record(t: Transport, into: Received[]): void {
  t.onMessage((peerId, channel, data) => {
    into.push({ peerId, channel, bytes: Array.from(data) })
  })
}

export function runTransportConformance(name: string, make: () => ConformanceHarness): void {
  describe(name + ' — Transport conformance (§2.1)', () => {
    it('1. onMessage registers an ADDITIONAL listener; it never replaces one', () => {
      const h = make()
      const first: Received[] = []
      const second: Received[] = []
      record(h.b, first)
      record(h.b, second)

      h.a.broadcast('reliable', new Uint8Array([0x03, 0x02, 0x77]))
      h.flush()

      // On a guest, ClientLoop and RoomClient both subscribe to the same
      // transport. Replace semantics silently deletes the lobby.
      expect(first).toHaveLength(1)
      expect(second).toHaveLength(1)
      expect(first[0].bytes).toEqual([0x03, 0x02, 0x77])
      expect(second[0].bytes).toEqual([0x03, 0x02, 0x77])
    })

    it('2. onPeerLost appends too, and fires for a peer that vanished', () => {
      const h = make()
      const lostA: string[] = []
      const lostB: string[] = []
      h.a.onPeerLost((p) => { lostA.push(p) })
      h.a.onPeerLost((p) => { lostB.push(p) })

      h.dropB()
      h.flush()

      expect(lostA).toHaveLength(1)
      expect(lostB).toEqual(lostA)
    })

    it('3. broadcast reaches the far end and never the sender', () => {
      const h = make()
      const atA: Received[] = []
      const atB: Received[] = []
      record(h.a, atA)
      record(h.b, atB)

      h.a.broadcast('unreliable', new Uint8Array([0x11, 0x02, 0x01]))
      h.flush()

      expect(atB).toHaveLength(1)
      expect(atB[0].channel).toBe('unreliable')
      expect(atA).toEqual([])          // the sender is never one of its own peers
    })

    it('4. send to an unknown peer is a NO-OP, not a throw', () => {
      const h = make()
      const atB: Received[] = []
      record(h.b, atB)

      expect(() => { h.a.send('reliable', 'definitely-not-a-peer', new Uint8Array([1, 2])) }).not.toThrow()
      h.flush()
      expect(atB).toEqual([])

      // The floor: a real peer DOES receive, so "nothing delivered" above is the
      // rule and not a harness that delivers nothing at all.
      const target = h.a.peers()[0]
      expect(target).toBeDefined()
      h.a.send('reliable', target, new Uint8Array([3, 4]))
      h.flush()
      expect(atB).toHaveLength(1)
    })

    it('5. close() is idempotent, and after it peers() is empty and nothing flows', () => {
      const h = make()
      const atB: Received[] = []
      record(h.b, atB)

      h.a.close()
      h.a.close()

      expect(h.a.peers()).toEqual([])
      h.a.broadcast('reliable', new Uint8Array([9, 9]))
      h.flush()
      expect(atB).toEqual([])
    })

    it('6. delivered bytes are what was SENT, even if the sender mutates its buffer', () => {
      const h = make()
      const atB: Received[] = []
      record(h.b, atB)

      const buf = new Uint8Array([0x11, 0x02, 0x41])
      h.a.broadcast('unreliable', buf)
      buf[2] = 0x5a                    // the sender reuses its scratch buffer
      h.flush()

      expect(atB).toHaveLength(1)
      // Every shipped sender .slice()s for exactly this reason. A transport that
      // queued a live view would deliver whatever the buffer held at DELIVERY
      // time, which under latency is a different message.
      expect(atB[0].bytes).toEqual([0x11, 0x02, 0x41])
    })
  })
}
```

Run: `npx vitest run packages/net/test/`

Expected: unchanged from before this step — the file exports a factory and
declares no test of its own until something calls it. If `packages/net`'s own
tests already call `runTransportConformance`, they run now and must pass.

- [ ] **Step 6: Write the failing test for `roomtransport.ts`**

Create `packages/server/test/roomtransport.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { MAX_KARTS } from '@tapkart/sim'
import type { ChannelName } from '@tapkart/protocol'
import type { Transport } from '@tapkart/net'
import { WS_SLOT_SERVER, createLiveness, decodeWsFrame } from '@tapkart/net'
import type { ConformanceHarness } from '../../net/test/fixtures/transport-conformance'
import { runTransportConformance } from '../../net/test/fixtures/transport-conformance'
import type { PeerId, PeerRecord, RoomRecord } from '../src/types'
import { makeRoomTransport } from '../src/roomtransport'

function makeRoom(): RoomRecord {
  return {
    code: 'ABCDE', createdAtMs: 0, lastActivityMs: 0, phase: 'lobby',
    hostPeerId: null, hostPlayerId: -1, trackId: 'caldera', lobbyVersion: 1,
    raceSeed: 0,
    peers: new Map<PeerId, PeerRecord>(),
    slotsInUse: new Set<number>(),
    seats: new Array<PeerId | null>(MAX_KARTS).fill(null),
    rtcFailures: 0, race: null,
  }
}

function addPeer(room: RoomRecord, peerId: string, slot: number, connected = true): PeerRecord {
  const peer: PeerRecord = {
    peerId, slot, playerId: -1, token: '', role: 'guest', name: '',
    characterIdx: 0, ready: false, relay: false, connected,
    joinedAtMs: 0, lastSeenMs: 0, liveness: createLiveness(0),
  }
  room.peers.set(peerId, peer)
  return peer
}

interface Sent { peerId: string; frame: Uint8Array }

function harness(): { room: RoomRecord; sent: Sent[]; t: ReturnType<typeof makeRoomTransport> } {
  const room = makeRoom()
  const sent: Sent[] = []
  const t = makeRoomTransport({
    room,
    sendFrame: (peer, frame) => { sent.push({ peerId: peer.peerId, frame: frame.slice() }) },
  })
  return { room, sent, t }
}

describe('RoomTransport.send', () => {
  it('frames one datagram for that peer, addressed FROM the room', () => {
    const h = harness()
    addPeer(h.room, 'pa', 1)
    addPeer(h.room, 'pb', 2)

    h.t.send('reliable', 'pb', new Uint8Array([0x11, 0x02, 0xaa, 0xbb]))

    expect(h.sent).toHaveLength(1)
    expect(h.sent[0].peerId).toBe('pb')
    const frame = decodeWsFrame(h.sent[0].frame)
    expect(frame).not.toBeNull()
    expect(frame!.channel).toBe('reliable')
    // The origin slot is the room's own: a client reads slot 0 as "from the room",
    // which is how the shadow is always one of its peers.
    expect(frame!.peerSlot).toBe(WS_SLOT_SERVER)
    expect(Array.from(frame!.payload)).toEqual([0x11, 0x02, 0xaa, 0xbb])
  })

  it('is a no-op for an unknown peer and for a disconnected one', () => {
    const h = harness()
    addPeer(h.room, 'pa', 1)
    addPeer(h.room, 'pb', 2, false)

    h.t.send('unreliable', 'nobody', new Uint8Array([1]))
    h.t.send('unreliable', 'pb', new Uint8Array([1]))
    expect(h.sent).toHaveLength(0)

    // The floor: the same call to a live peer DOES send, so "no frames" above is
    // a decision and not a broken harness.
    h.t.send('unreliable', 'pa', new Uint8Array([1]))
    expect(h.sent).toHaveLength(1)
  })
})

describe('RoomTransport.broadcast', () => {
  it('produces one frame per CONNECTED peer and none for anyone else', () => {
    const h = harness()
    addPeer(h.room, 'pa', 1)
    addPeer(h.room, 'pb', 2)
    addPeer(h.room, 'pc', 3, false)

    h.t.broadcast('unreliable', new Uint8Array([0x11, 0x02, 0x07]))

    expect(h.sent.map((s) => s.peerId).sort()).toEqual(['pa', 'pb'])
    for (const s of h.sent) {
      const frame = decodeWsFrame(s.frame)
      expect(frame!.channel).toBe('unreliable')
      expect(Array.from(frame!.payload)).toEqual([0x11, 0x02, 0x07])
    }
  })

  it('gives each recipient its own buffer', () => {
    const h = harness()
    addPeer(h.room, 'pa', 1)
    addPeer(h.room, 'pb', 2)
    h.t.broadcast('reliable', new Uint8Array([9]))
    expect(h.sent[0].frame).not.toBe(h.sent[1].frame)
  })
})

describe('RoomTransport.peers', () => {
  it('is every connected peer, and empty after close', () => {
    const h = harness()
    addPeer(h.room, 'pa', 1)
    addPeer(h.room, 'pb', 2, false)

    expect(h.t.peers()).toEqual(['pa'])
    h.t.close()
    expect(h.t.peers()).toEqual([])
    h.t.close()                       // idempotent
    expect(h.t.peers()).toEqual([])
    h.t.broadcast('reliable', new Uint8Array([1]))
    expect(h.sent).toHaveLength(0)
  })
})

describe('RoomTransport.deliver', () => {
  it('reaches EVERY registered listener, in registration order', () => {
    // The append rule from the consumer's side. On the server, ShadowLoop and
    // the hub's own bookkeeping both subscribe; a replace-semantics transport
    // silently deletes one of them.
    const h = harness()
    addPeer(h.room, 'pa', 1)
    const seen: string[] = []
    h.t.onMessage((peerId, channel, data) => { seen.push('first:' + peerId + ':' + channel + ':' + String(data.length)) })
    h.t.onMessage((peerId, channel) => { seen.push('second:' + peerId + ':' + channel) })

    h.t.deliver('pa', 'unreliable', new Uint8Array([0x10, 0x02, 0x00]))

    expect(seen).toEqual(['first:pa:unreliable:3', 'second:pa:unreliable'])
  })

  it('delivers nothing after close', () => {
    const h = harness()
    let calls = 0
    h.t.onMessage(() => { calls += 1 })
    h.t.deliver('pa', 'reliable', new Uint8Array([1]))
    expect(calls).toBe(1)             // the floor
    h.t.close()
    h.t.deliver('pa', 'reliable', new Uint8Array([1]))
    expect(calls).toBe(1)
  })
})

describe('RoomTransport.notePeerGone', () => {
  it('fires every onPeerLost listener exactly once per peer', () => {
    const h = harness()
    addPeer(h.room, 'pa', 1)
    const lost: string[] = []
    h.t.onPeerLost((p) => { lost.push('a:' + p) })
    h.t.onPeerLost((p) => { lost.push('b:' + p) })

    h.t.notePeerGone('pa')
    expect(lost).toEqual(['a:pa', 'b:pa'])

    h.t.notePeerGone('pa')            // a double close must not double-fire
    expect(lost).toEqual(['a:pa', 'b:pa'])
  })

  it('stops sending to a peer that has gone, before the record is updated', () => {
    // A clean close makes the kart bot-driven IMMEDIATELY -- 1.5 s before any
    // promotion decision, and without waiting for anyone to rewrite the record.
    const h = harness()
    addPeer(h.room, 'pa', 1)
    addPeer(h.room, 'pb', 2)

    h.t.notePeerGone('pb')
    h.t.broadcast('reliable', new Uint8Array([1]))

    expect(h.sent.map((s) => s.peerId)).toEqual(['pa'])
    expect(h.t.peers()).toEqual(['pa'])
  })
})

/**
 * §9.2's shared suite, run against the one Transport implementation that lives
 * outside `net`. `b` is the far end of peer B's socket: what it sends arrives at
 * the room as an inbound datagram from 'pb', and what the room sends to peer B
 * arrives here. Nothing in this harness is network -- it is two queues.
 *
 * If the suite asserts a behaviour this harness cannot express, fix the harness.
 * Never weaken the suite: its whole job is that five implementations agree.
 */
function makeRoomTransportHarness(): ConformanceHarness {
  const room = makeRoom()
  addPeer(room, 'pa', 1)
  addPeer(room, 'pb', 2)
  const pending: (() => void)[] = []

  const bMessageCbs: ((peerId: string, channel: ChannelName, data: Uint8Array) => void)[] = []
  const bLostCbs: ((peerId: string) => void)[] = []
  let bClosed = false

  const a = makeRoomTransport({
    room,
    sendFrame: (peer, frame) => {
      if (peer.peerId !== 'pb') return
      const copy = frame.slice()
      pending.push(() => {
        if (bClosed) return
        const decoded = decodeWsFrame(copy)
        if (decoded === null || decoded.channel === null) return
        for (const cb of bMessageCbs.slice()) cb('server', decoded.channel, decoded.payload)
      })
    },
  })

  const b: Transport = {
    send(channel, peerId, data) {
      if (bClosed || peerId !== 'server') return
      const copy = data.slice()
      pending.push(() => { a.deliver('pb', channel, copy) })
    },
    broadcast(channel, data) { b.send(channel, 'server', data) },
    onMessage(cb) { bMessageCbs.push(cb) },
    onPeerLost(cb) { bLostCbs.push(cb) },
    peers() { return bClosed ? [] : ['server'] },
    close() { bClosed = true; bMessageCbs.length = 0; bLostCbs.length = 0 },
  }

  return {
    a,
    b,
    flush() {
      while (pending.length > 0) {
        const next = pending.shift()
        if (next !== undefined) next()
      }
    },
    dropB() {
      const rec = room.peers.get('pb')
      if (rec !== undefined) rec.connected = false
      a.notePeerGone('pb')
      for (const cb of bLostCbs.slice()) cb('server')
    },
  }
}

runTransportConformance('RoomTransport', makeRoomTransportHarness)
```

- [ ] **Step 7: Run the roomtransport test to verify it fails**

Run: `npx vitest run packages/server/test/roomtransport.test.ts`

Expected: FAIL at collection with
`Failed to resolve import "../src/roomtransport" from "packages/server/test/roomtransport.test.ts". Does the file exist?`

- [ ] **Step 8: Write `packages/server/src/roomtransport.ts`**

```ts
// PURE. The server-side `Transport`: one per race, N sockets behind it, and the
// object ShadowLoop is constructed over (through §4.7's authority decorator).
// It holds no socket -- `sendFrame` is injected and is the hub's -- and it reads
// no clock.
import type { ChannelName } from '@tapkart/protocol'
import type { Transport } from '@tapkart/net'
import { WS_HEADER_BYTES, WS_SLOT_SERVER, encodeWsData } from '@tapkart/net'
import type { PeerRecord, RoomRecord } from './types'

export interface RoomTransportOptions {
  room: RoomRecord
  /** The hub's own send path. Given a peer and a fully framed WS binary frame. */
  sendFrame: (peer: PeerRecord, frame: Uint8Array) => void
}

export interface RoomTransport extends Transport {
  /** The hub calls this for every inbound data frame, after routing. This is the
   *  only way bytes enter a RoomTransport. */
  deliver(peerId: string, channel: ChannelName, payload: Uint8Array): void
  notePeerGone(peerId: string): void
}

export function makeRoomTransport(opts: RoomTransportOptions): RoomTransport {
  const room = opts.room
  const sendFrame = opts.sendFrame
  const messageCbs: ((peerId: string, channel: ChannelName, data: Uint8Array) => void)[] = []
  const lostCbs: ((peerId: string) => void)[] = []
  const gone = new Set<string>()
  let closed = false

  // A FRESH buffer per send. `sendFrame` hands it to a socket that may queue it,
  // so a reused scratch buffer would be rewritten under a pending write.
  const frameOf = (channel: ChannelName, data: Uint8Array): Uint8Array => {
    const out = new Uint8Array(WS_HEADER_BYTES + data.length)
    // The origin slot is the room's own: a client reads WS_SLOT_SERVER as
    // "from the room", which is what makes the shadow one of its peers from the
    // first frame onward.
    encodeWsData(out, channel, WS_SLOT_SERVER, data)
    return out
  }

  const live = (): PeerRecord[] => {
    const out: PeerRecord[] = []
    for (const peer of room.peers.values()) {
      if (peer.connected && !gone.has(peer.peerId)) out.push(peer)
    }
    return out
  }

  return {
    send(channel: ChannelName, peerId: string, data: Uint8Array): void {
      if (closed) return
      const peer = room.peers.get(peerId)
      // An unknown peer is a no-op, not a throw (Transport rule 4).
      if (peer === undefined || !peer.connected || gone.has(peerId)) return
      sendFrame(peer, frameOf(channel, data))
    },

    broadcast(channel: ChannelName, data: Uint8Array): void {
      if (closed) return
      // The room is not a peer of itself, so there is no sender to exclude.
      for (const peer of live()) sendFrame(peer, frameOf(channel, data))
    },

    onMessage(cb: (peerId: string, channel: ChannelName, data: Uint8Array) => void): void {
      messageCbs.push(cb)           // appends, never replaces (Transport rule 1)
    },

    onPeerLost(cb: (peerId: string) => void): void {
      lostCbs.push(cb)              // appends (Transport rule 2)
    },

    peers(): string[] {
      if (closed) return []
      return live().map((p) => p.peerId)
    },

    close(): void {
      if (closed) return
      closed = true
      messageCbs.length = 0
      lostCbs.length = 0
    },

    deliver(peerId: string, channel: ChannelName, payload: Uint8Array): void {
      if (closed) return
      // `payload` is a view of the inbound buffer and is not retained here: a
      // receiver that needs the bytes past this call copies them
      // (Transport rule 6), and every shipped loop already does.
      for (const cb of messageCbs.slice()) cb(peerId, channel, payload)
    },

    notePeerGone(peerId: string): void {
      if (closed) return
      if (gone.has(peerId)) return
      gone.add(peerId)
      // This is how a clean socket close makes a kart bot-driven IMMEDIATELY,
      // 1.5 s before any promotion decision. Peer loss and host loss are two
      // different concerns and this transport owns only the first.
      for (const cb of lostCbs.slice()) cb(peerId)
    },
  }
}
```

- [ ] **Step 9: Run every test to verify it passes**

Run: `npx vitest run packages/server/test/lobby.test.ts packages/server/test/roomtransport.test.ts`
Expected: all passing, including the six `runTransportConformance('RoomTransport', ...)` adds.

Run: `npx vitest run packages/net/`
Expected: unchanged — this task adds a fixture to `net` and edits no `net` test.

Then typecheck the package:

Run: `npx tsc --noEmit -p packages/server/tsconfig.json`
Expected: no output.

- [ ] **Step 10: Commit**

```bash
git add packages/server/src/lobby.ts packages/server/src/roomtransport.ts \
        packages/net/test/fixtures/transport-conformance.ts \
        packages/server/test/lobby.test.ts packages/server/test/roomtransport.test.ts
git commit -m "feat(server): lobby seat truth and the room transport

lobby.ts is the server's lobby truth (F-P4-31): seats, names, ready flags,
track and start, with assignSeat the sole writer of seats/playerId/
hostPlayerId and bumpLobbyVersion the sole writer of lobbyVersion.

seatMapOf reads the room on every call. It is what withPeerAuthority
consults for every inbound datagram, and its isAuthority answer changes at
the instant of promotion -- a map that captured room.race when it was built
would say 'the host is authoritative' forever, and a promoted room would go
on reconciling onto the old host's snapshots.

assignSeat re-points a peer that carries a playerId at its OWN seat rather
than the lowest free one, so no path that revives a record can drop a
returning player into someone else's kart -- which seatMapOf would then
authorise them for.

roomtransport.ts is the server-side Transport ShadowLoop is constructed
over. notePeerGone fires onPeerLost, which makes a kart bot-driven
immediately -- a separate concern from authority, which the shadow owns and
declares 1.5 s later (F-P4-22).

Also adds §9.2's shared Transport conformance suite, which had no owner in
the plan. Without it each implementation satisfies whichever of §2.1's six
behaviours its author happened to notice, and the divergence surfaces as a
lobby that works on loopback and silently dies over WebRTC."
```
