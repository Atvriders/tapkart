### Task 12: `packages/net/src/authz.ts` — the seat map, enforced on every inbound datagram

**Files:**
- Create: `packages/net/src/authz.ts`
- Modify: `packages/protocol/src/input.ts` (adds `playerIdOfInput`, gate item G4 — **only if it is not already there**; Step 3a decides)
- Test: `packages/net/test/authz.test.ts`
- Test: `packages/protocol/test/input-playerid.test.ts` (only in the same case as the `input.ts` edit)

**Interfaces:**

- **Consumes** — from `@tapkart/net`'s own `src/transport.ts` (relative import inside the package, quoted verbatim from source):

  ```ts
  export interface Transport {
    send(channel: ChannelName, peerId: string, data: Uint8Array): void
    broadcast(channel: ChannelName, data: Uint8Array): void
    onMessage(cb: (peerId: string, channel: ChannelName, data: Uint8Array) => void): void
    onPeerLost(cb: (peerId: string) => void): void
    peers(): string[]
    close(): void
  }
  ```

  Three of `Transport`'s six unwritten behaviours (contract §2.1) are load-bearing here and this task must preserve every one of them: **`onMessage` registers an additional listener and never replaces one**; `send` to an unknown peer is a no-op, not a throw; `close()` is idempotent.

- **Consumes** — from `@tapkart/protocol` (bare specifier; `net` depends on `protocol`, contract §1):

  ```ts
  export type ChannelName = 'unreliable' | 'reliable'
  export const WIRE_TAG = {
    hello: 0x01, welcome: 0x02, lobby: 0x03, start: 0x04, clientUpdate: 0x05,
    input: 0x10, snapshot: 0x11, events: 0x12, checkpoint: 0x13, resyncRequest: 0x14,
    authorityChange: 0x20, ping: 0x30, pong: 0x31,
  } as const
  export function encodeHeader(out: Uint8Array, kind: MessageKind): number   // writes [tag, version], returns 2
  export const INPUT_REDUNDANCY = 8
  export function encodeInput(out: Uint8Array, playerId: number, intents: Intent[]): number
  export function decodeInput(buf: Uint8Array, out: InputDatagram): void
  export function encodeSnapshot(out: Uint8Array, state: SimState, lastProcessedInputTick: number[]): number
  ```

- **Consumes** — from `@tapkart/protocol`, the one symbol this task may have to write itself (contract §2.10, gate item **G4**, verbatim: *"`playerIdOfInput(buf: Uint8Array): number` in `protocol/src/input.ts` — the first 3 bits of an input body, `-1` on a buffer too short to hold them. Plan 4 may write this one itself: `input.ts` is not a file 15c touches, and §4.7 is the only caller"*):

  ```ts
  export function playerIdOfInput(buf: Uint8Array): number
  ```

- **Consumes** — from `packages/net/src/authority.ts` and `packages/net/src/shadow.ts`, **for the tests only**, quoted from shipped source:

  ```ts
  export class AuthorityLoop {
    constructor(ctx: SimContext, state: SimState, t: Transport)
    state(): SimState
    tick(): void
  }
  /** True once `loop` has received a foreign `authorityChange` and stood down for good. */
  export function isDemoted(loop: AuthorityLoop): boolean
  export const AUTHORITY_CHANGE_BYTES = 10
  export function encodeAuthorityChange(out: Uint8Array, tick: number, eventSeq: number): number
  ```

- **Consumes** — from `@tapkart/sim` and from `packages/net/test/fixtures/net-fixtures.ts` (test-only, relative, contract §2.11):

  ```ts
  export const MAX_KARTS = 8
  export function createState(ctx: SimContext, seed: number, characterIdx: number[]): SimState
  export function makeNetContext(isLeader?: boolean): SimContext   // test fixture
  ```

- **Produces** — contract §4.7, four exported symbols (census §11: `net/authz` = 4):

  ```ts
  export interface PeerAuthority {
    /** The seat this peer is authorised to submit input for, or -1 for none. */
    playerIdOf(peerId: string): number
    /** True only for the peer currently entitled to originate AUTHORITATIVE
     *  traffic — snapshots, events, checkpoints, authorityChange. */
    isAuthority(peerId: string): boolean
  }

  export interface PeerAuthorityDrops {
    wrongSeat: number      // input datagrams whose claimed playerId was not this peer's seat
    notAuthority: number   // authoritative kinds from a peer that is not the authority
    malformed: number      // datagrams too short to classify
  }

  export function withPeerAuthority(inner: Transport, authority: PeerAuthority): Transport
  export function peerAuthorityDropsOf(t: Transport): PeerAuthorityDrops
  ```

  The drop table, verbatim from contract §4.7:

  | Inbound kind | Dropped when |
  |---|---|
  | `input` | `playerIdOfInput(payload) !== authority.playerIdOf(peerId)` |
  | `snapshot`, `events`, `checkpoint`, `authorityChange` | `!authority.isAuthority(peerId)` |
  | everything else | never — lobby and control kinds are the hub's to adjudicate, and it has the full message |

**What this task is for, stated once so no step reads as ceremony.** Plan 2 shipped **identity by claim**, deliberately, and its own source says where the fix belongs (`authority.ts`, verbatim): *"Identity by claim, which is right for this plan's loopback scope and not beyond it — any peer can send a datagram naming any playerId. Plan 4's lobby handshake is where reclaiming a seat gets authenticated."* Today, against the shipped loops:

- any peer can flip a disconnected seat back to `connected` and take over that kart, because `authority.ts`'s reclaim line runs on the datagram's own claim;
- any peer can claim a seat and drop its real occupant to bot-fill;
- any peer can forge a `snapshot` a `ShadowLoop` reconciles its whole race onto, and ratchet `eventSeqFloor` with the `eventSeq` in its header;
- **and the worst of them: two bytes on the reliable channel with tag `0x20`.** `AuthorityLoop.onDatagram` demotes on *any* foreign `authorityChange` without reading the body — correctly, because no transport loops a broadcast back to its sender, so every one it sees really is foreign *when the peers are authorised*. Unauthorised, one guest permanently stops the host broadcasting. Where a shadow exists the room degrades to a server-authoritative race; where one does not (`SHADOW_ENABLED=false`, or a host racing before the shadow starts) the room dies with no authority at all.

This decorator is where all four stop being true.

**Why a decorator and not a change to the loops** (contract §4.7): `AuthorityLoop`, `ClientLoop` and `ShadowLoop` have locked public shapes and none takes a seat map. A transport decorator is a transport, `net` owns transports, and this is the shape `withLocalInput` already established. One implementation and one test then covers both the host's fan-out and the server's room transport.

---

- [ ] **Step 1: Write the failing test**

Create `packages/net/test/authz.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { ChannelName } from '@tapkart/protocol'
import {
  INPUT_REDUNDANCY,
  WIRE_TAG,
  encodeHeader,
  encodeInput,
  encodeSnapshot,
  playerIdOfInput,
} from '@tapkart/protocol'
import type { Intent, SimState } from '@tapkart/sim'
import { MAX_KARTS, createState } from '@tapkart/sim'
import { AuthorityLoop, isDemoted } from '../src/authority'
import type { PeerAuthority } from '../src/authz'
import { peerAuthorityDropsOf, withPeerAuthority } from '../src/authz'
import { AUTHORITY_CHANGE_BYTES, encodeAuthorityChange } from '../src/shadow'
import type { Transport } from '../src/transport'
import { makeNetContext } from './fixtures/net-fixtures'

const HOST = 'host'
const GUEST = 'guest'
const HOST_SEAT = 0
const GUEST_SEAT = 1

interface Delivery {
  peerId: string
  channel: ChannelName
  data: Uint8Array
}

interface FakeTransport extends Transport {
  /** The far side handing bytes in - the only way a datagram enters. */
  deliver(peerId: string, channel: ChannelName, data: Uint8Array): void
  dropPeer(peerId: string): void
  sent(): Delivery[]
  broadcasts(): Delivery[]
  closed(): number
}

/**
 * A Transport whose inbound side a test drives directly. onMessage and
 * onPeerLost APPEND (contract §2.1 rules 1 and 2), because half of what this
 * suite asserts is about how many listeners see a datagram.
 */
function makeFakeTransport(peerIds: string[]): FakeTransport {
  const messageCbs: ((peerId: string, channel: ChannelName, data: Uint8Array) => void)[] = []
  const lostCbs: ((peerId: string) => void)[] = []
  const sent: Delivery[] = []
  const broadcasts: Delivery[] = []
  let closes = 0
  return {
    send(channel, peerId, data) {
      sent.push({ peerId, channel, data })
    },
    broadcast(channel, data) {
      broadcasts.push({ peerId: '*', channel, data })
    },
    onMessage(cb) {
      messageCbs.push(cb)
    },
    onPeerLost(cb) {
      lostCbs.push(cb)
    },
    peers() {
      return [...peerIds]
    },
    close() {
      closes++
    },
    deliver(peerId, channel, data) {
      for (const cb of messageCbs) cb(peerId, channel, data)
    },
    dropPeer(peerId) {
      for (const cb of lostCbs) cb(peerId)
    },
    sent: () => sent,
    broadcasts: () => broadcasts,
    closed: () => closes,
  }
}

/** The seat map the server builds from a room (contract §5.5's `seatMapOf`),
 * with `promoted` standing in for `shadow.promotionTick() >= 0`. */
function seatMap(seats: Record<string, number>, hostPeerId: string, promoted = false): PeerAuthority {
  return {
    playerIdOf: (peerId) => seats[peerId] ?? -1,
    isAuthority: (peerId) => !promoted && peerId === hostPeerId,
  }
}

function intents(tick: number): Intent[] {
  const out: Intent[] = []
  for (let i = 0; i < INPUT_REDUNDANCY; i++) {
    out.push({
      tick: tick - (INPUT_REDUNDANCY - 1 - i),
      steer: 0.5,
      accel: 1,
      brake: false,
      drift: false,
      useItem: false,
    })
  }
  return out
}

/** A complete `input` datagram: 2-byte header then the body encodeInput writes. */
function inputDatagram(playerId: number, tick = 20): Uint8Array {
  const buf = new Uint8Array(256)
  const h = encodeHeader(buf, 'input')
  const n = encodeInput(buf.subarray(h), playerId, intents(tick))
  return buf.slice(0, h + n)
}

function snapshotDatagram(state: SimState): Uint8Array {
  const buf = new Uint8Array(1024)
  const h = encodeHeader(buf, 'snapshot')
  const n = encodeSnapshot(buf.subarray(h), state, new Array<number>(MAX_KARTS).fill(0))
  return buf.slice(0, h + n)
}

function authorityChangeDatagram(tick: number, eventSeq: number): Uint8Array {
  const buf = new Uint8Array(AUTHORITY_CHANGE_BYTES)
  encodeAuthorityChange(buf, tick, eventSeq)
  return buf
}

/** A header and two body bytes. Built with encodeHeader rather than a literal
 * version byte, so this file says nothing about PROTOCOL_VERSION - the
 * decorator reads data[0] and never the version at all. */
function taggedDatagram(kind: Parameters<typeof encodeHeader>[1]): Uint8Array {
  const buf = new Uint8Array(4)
  const h = encodeHeader(buf, kind)
  buf[h] = 0
  buf[h + 1] = 0
  return buf
}

function raceState(): SimState {
  const state = createState(makeNetContext(true), 0x1234, [0, 0, 0, 0, 0, 0, 0, 0])
  state.phase = 'racing'
  return state
}

describe('withPeerAuthority - the seat check', () => {
  it('drops an input datagram naming a seat this peer does not hold, and delivers nothing', () => {
    const inner = makeFakeTransport([HOST, GUEST])
    const guarded = withPeerAuthority(inner, seatMap({ [HOST]: HOST_SEAT, [GUEST]: GUEST_SEAT }, HOST))
    const seen: Delivery[] = []
    guarded.onMessage((peerId, channel, data) => seen.push({ peerId, channel, data }))

    // GUEST holds seat 1 and claims seat 0 - the host's.
    inner.deliver(GUEST, 'unreliable', inputDatagram(HOST_SEAT))

    expect(seen).toEqual([])
    expect(peerAuthorityDropsOf(guarded)).toEqual({ wrongSeat: 1, notAuthority: 0, malformed: 0 })
  })

  it('delivers that identical datagram when the decorator is not there', () => {
    // The control that proves the test above can fail. Without it, a decorator
    // that dropped EVERYTHING would pass the assertion above unchanged.
    const inner = makeFakeTransport([HOST, GUEST])
    const seen: Delivery[] = []
    inner.onMessage((peerId, channel, data) => seen.push({ peerId, channel, data }))

    inner.deliver(GUEST, 'unreliable', inputDatagram(HOST_SEAT))

    expect(seen).toHaveLength(1)
    expect(seen[0].peerId).toBe(GUEST)
  })

  it("passes a peer's input for its own seat through byte for byte", () => {
    const inner = makeFakeTransport([HOST, GUEST])
    const guarded = withPeerAuthority(inner, seatMap({ [HOST]: HOST_SEAT, [GUEST]: GUEST_SEAT }, HOST))
    const seen: Delivery[] = []
    guarded.onMessage((peerId, channel, data) => seen.push({ peerId, channel, data }))

    const datagram = inputDatagram(GUEST_SEAT)
    inner.deliver(GUEST, 'unreliable', datagram)

    expect(seen).toHaveLength(1)
    expect(seen[0].channel).toBe('unreliable')
    expect(Array.from(seen[0].data)).toEqual(Array.from(datagram))
    expect(peerAuthorityDropsOf(guarded)).toEqual({ wrongSeat: 0, notAuthority: 0, malformed: 0 })
  })

  it('refuses every seat to a peer with no seat at all', () => {
    const inner = makeFakeTransport([HOST, 'stranger'])
    const guarded = withPeerAuthority(inner, seatMap({ [HOST]: HOST_SEAT }, HOST))
    const seen: Delivery[] = []
    guarded.onMessage((peerId, channel, data) => seen.push({ peerId, channel, data }))

    for (let seat = 0; seat < MAX_KARTS; seat++) {
      inner.deliver('stranger', 'unreliable', inputDatagram(seat))
    }

    expect(seen).toEqual([])
    expect(peerAuthorityDropsOf(guarded).wrongSeat).toBe(MAX_KARTS)
  })
})

describe('withPeerAuthority - what the seat check protects, at the loop', () => {
  it("leaves the host's seat disconnected when a guest forges input for it", () => {
    const ctx = makeNetContext(true)
    const state = raceState()
    expect(state.karts[HOST_SEAT].connected).toBe(false)

    const inner = makeFakeTransport([HOST, GUEST])
    const guarded = withPeerAuthority(inner, seatMap({ [HOST]: HOST_SEAT, [GUEST]: GUEST_SEAT }, HOST))
    const loop = new AuthorityLoop(ctx, state, guarded)

    inner.deliver(GUEST, 'unreliable', inputDatagram(HOST_SEAT))
    loop.tick()

    // The reclaim line at authority.ts:159 never ran: the seat is still the
    // host's to come back to, and the kart is still bot-driven.
    expect(loop.state().karts[HOST_SEAT].connected).toBe(false)
    expect(loop.state().karts[HOST_SEAT].isBot).toBe(true)
    expect(peerAuthorityDropsOf(guarded).wrongSeat).toBe(1)
  })

  it('seizes that seat when the decorator is absent - the defect this task closes', () => {
    const ctx = makeNetContext(true)
    const state = raceState()
    const inner = makeFakeTransport([HOST, GUEST])
    const loop = new AuthorityLoop(ctx, state, inner)

    inner.deliver(GUEST, 'unreliable', inputDatagram(HOST_SEAT))
    loop.tick()

    expect(loop.state().karts[HOST_SEAT].connected).toBe(true)
  })
})

describe('withPeerAuthority - the authority check', () => {
  it('drops a snapshot from a peer that is not the authority', () => {
    const inner = makeFakeTransport([HOST, GUEST])
    const guarded = withPeerAuthority(inner, seatMap({ [HOST]: HOST_SEAT, [GUEST]: GUEST_SEAT }, HOST))
    const seen: Delivery[] = []
    guarded.onMessage((peerId, channel, data) => seen.push({ peerId, channel, data }))

    inner.deliver(GUEST, 'unreliable', snapshotDatagram(raceState()))

    expect(seen).toEqual([])
    expect(peerAuthorityDropsOf(guarded)).toEqual({ wrongSeat: 0, notAuthority: 1, malformed: 0 })
  })

  it("passes the host's own snapshot through", () => {
    const inner = makeFakeTransport([HOST, GUEST])
    const guarded = withPeerAuthority(inner, seatMap({ [HOST]: HOST_SEAT, [GUEST]: GUEST_SEAT }, HOST))
    const seen: Delivery[] = []
    guarded.onMessage((peerId, channel, data) => seen.push({ peerId, channel, data }))

    inner.deliver(HOST, 'unreliable', snapshotDatagram(raceState()))

    expect(seen).toHaveLength(1)
    expect(peerAuthorityDropsOf(guarded).notAuthority).toBe(0)
  })

  it('drops every authoritative kind from a guest, and none of them reaches a listener', () => {
    const inner = makeFakeTransport([HOST, GUEST])
    const guarded = withPeerAuthority(inner, seatMap({ [HOST]: HOST_SEAT, [GUEST]: GUEST_SEAT }, HOST))
    const seen: Delivery[] = []
    guarded.onMessage((peerId, channel, data) => seen.push({ peerId, channel, data }))

    inner.deliver(GUEST, 'reliable', taggedDatagram('events'))
    inner.deliver(GUEST, 'reliable', taggedDatagram('checkpoint'))
    inner.deliver(GUEST, 'reliable', authorityChangeDatagram(600, 12))

    expect(seen).toEqual([])
    expect(peerAuthorityDropsOf(guarded).notAuthority).toBe(3)
  })

  it("does not let a guest's forged authorityChange demote the host", () => {
    const ctx = makeNetContext(true)
    const state = raceState()
    const inner = makeFakeTransport([HOST, GUEST])
    const guarded = withPeerAuthority(inner, seatMap({ [HOST]: HOST_SEAT, [GUEST]: GUEST_SEAT }, HOST))
    const loop = new AuthorityLoop(ctx, state, guarded)

    inner.deliver(GUEST, 'reliable', authorityChangeDatagram(600, 12))
    loop.tick()

    expect(isDemoted(loop)).toBe(false)
    expect(peerAuthorityDropsOf(guarded).notAuthority).toBe(1)
  })

  it('is demoted by the same ten bytes when the decorator is absent - the defect this task closes', () => {
    const ctx = makeNetContext(true)
    const state = raceState()
    const inner = makeFakeTransport([HOST, GUEST])
    const loop = new AuthorityLoop(ctx, state, inner)

    inner.deliver(GUEST, 'reliable', authorityChangeDatagram(600, 12))

    expect(isDemoted(loop)).toBe(true)
  })

  it('refuses authoritative traffic from EVERYONE once the shadow has promoted', () => {
    const inner = makeFakeTransport([HOST, GUEST])
    const guarded = withPeerAuthority(
      inner,
      seatMap({ [HOST]: HOST_SEAT, [GUEST]: GUEST_SEAT }, HOST, true),
    )
    const seen: Delivery[] = []
    guarded.onMessage((peerId, channel, data) => seen.push({ peerId, channel, data }))

    inner.deliver(HOST, 'unreliable', snapshotDatagram(raceState()))
    inner.deliver(GUEST, 'unreliable', snapshotDatagram(raceState()))

    expect(seen).toEqual([])
    expect(peerAuthorityDropsOf(guarded).notAuthority).toBe(2)
    // The old host's INPUT still gets through: it is a player now, and its seat
    // is still its own (F-P4-23 - a demoted host rejoins as an ordinary client).
    inner.deliver(HOST, 'unreliable', inputDatagram(HOST_SEAT))
    expect(seen).toHaveLength(1)
  })
})

describe('withPeerAuthority - the kinds it must not adjudicate', () => {
  it('passes lobby and control kinds from any peer, including one with no seat', () => {
    const inner = makeFakeTransport([HOST, 'stranger'])
    const guarded = withPeerAuthority(inner, seatMap({ [HOST]: HOST_SEAT }, HOST))
    const seen: Delivery[] = []
    guarded.onMessage((peerId, channel, data) => seen.push({ peerId, channel, data }))

    // A peer with no seat is exactly what a joining guest is: it has to be able
    // to say hello, or nobody can ever acquire a seat at all.
    for (const kind of ['hello', 'welcome', 'lobby', 'start', 'clientUpdate', 'resyncRequest', 'ping', 'pong'] as const) {
      inner.deliver('stranger', 'reliable', taggedDatagram(kind))
    }

    expect(seen).toHaveLength(8)
    expect(peerAuthorityDropsOf(guarded)).toEqual({ wrongSeat: 0, notAuthority: 0, malformed: 0 })
  })
})

describe('withPeerAuthority - datagrams too short to classify', () => {
  it('counts an empty and a one-byte datagram as malformed and delivers neither', () => {
    const inner = makeFakeTransport([GUEST])
    const guarded = withPeerAuthority(inner, seatMap({ [GUEST]: GUEST_SEAT }, HOST))
    const seen: Delivery[] = []
    guarded.onMessage((peerId, channel, data) => seen.push({ peerId, channel, data }))

    inner.deliver(GUEST, 'unreliable', new Uint8Array(0))
    inner.deliver(GUEST, 'unreliable', new Uint8Array([WIRE_TAG.input]))

    expect(seen).toEqual([])
    expect(peerAuthorityDropsOf(guarded).malformed).toBe(2)
  })

  it('counts a header-only input datagram as malformed, never as seat 0', () => {
    // The dangerous shape: two bytes decode as a well-formed `input` header with
    // no body at all. Reading a seat out of the byte after it reads past the end
    // of the datagram; seat 0 is the host's, and this must not become a free
    // claim on it.
    const inner = makeFakeTransport([GUEST])
    const guarded = withPeerAuthority(inner, seatMap({ [GUEST]: GUEST_SEAT }, HOST))
    const seen: Delivery[] = []
    guarded.onMessage((peerId, channel, data) => seen.push({ peerId, channel, data }))

    inner.deliver(GUEST, 'unreliable', new Uint8Array([WIRE_TAG.input, 2]))

    expect(seen).toEqual([])
    expect(peerAuthorityDropsOf(guarded)).toEqual({ wrongSeat: 0, notAuthority: 0, malformed: 1 })
  })
})

describe('withPeerAuthority - the Transport it still is', () => {
  it('appends listeners rather than replacing them, and counts one drop for two of them', () => {
    const inner = makeFakeTransport([HOST, GUEST])
    const guarded = withPeerAuthority(inner, seatMap({ [HOST]: HOST_SEAT, [GUEST]: GUEST_SEAT }, HOST))
    const a: string[] = []
    const b: string[] = []
    guarded.onMessage((peerId) => a.push(peerId))
    guarded.onMessage((peerId) => b.push(peerId))

    inner.deliver(GUEST, 'unreliable', inputDatagram(GUEST_SEAT))
    inner.deliver(GUEST, 'unreliable', inputDatagram(HOST_SEAT))

    // Both listeners saw the legitimate datagram: on a guest, ClientLoop and
    // RoomClient both subscribe to the same transport, and a replace-semantics
    // decorator silently deletes the lobby (contract §2.1 rule 1).
    expect(a).toEqual([GUEST])
    expect(b).toEqual([GUEST])
    // ONE drop, not one per listener: the check runs once, in front of them all.
    expect(peerAuthorityDropsOf(guarded).wrongSeat).toBe(1)
  })

  it('delegates send, broadcast, peers, onPeerLost and close to the inner transport', () => {
    const inner = makeFakeTransport([HOST, GUEST])
    const guarded = withPeerAuthority(inner, seatMap({ [HOST]: HOST_SEAT }, HOST))
    const lost: string[] = []
    guarded.onPeerLost((peerId) => lost.push(peerId))

    guarded.send('reliable', HOST, new Uint8Array([1, 2, 3]))
    guarded.broadcast('unreliable', new Uint8Array([4, 5]))
    inner.dropPeer(GUEST)
    guarded.close()

    expect(guarded.peers()).toEqual([HOST, GUEST])
    expect(inner.sent()).toHaveLength(1)
    expect(inner.sent()[0].peerId).toBe(HOST)
    expect(inner.broadcasts()).toHaveLength(1)
    expect(lost).toEqual([GUEST])
    expect(inner.closed()).toBe(1)
  })

  it('never filters OUTBOUND traffic - the authority itself is the sender', () => {
    const inner = makeFakeTransport([GUEST])
    const guarded = withPeerAuthority(inner, seatMap({}, 'nobody'))
    guarded.broadcast('unreliable', snapshotDatagram(raceState()))
    expect(inner.broadcasts()).toHaveLength(1)
  })
})

describe('peerAuthorityDropsOf', () => {
  it('throws for a transport withPeerAuthority did not produce', () => {
    const inner = makeFakeTransport([HOST])
    expect(() => peerAuthorityDropsOf(inner)).toThrow(/withPeerAuthority/)
  })

  it('reads a snapshot of the counters, so a caller cannot mutate them', () => {
    const inner = makeFakeTransport([GUEST])
    const guarded = withPeerAuthority(inner, seatMap({ [GUEST]: GUEST_SEAT }, HOST))
    const before = peerAuthorityDropsOf(guarded)
    before.wrongSeat = 99
    inner.deliver(GUEST, 'unreliable', inputDatagram(HOST_SEAT))
    expect(peerAuthorityDropsOf(guarded).wrongSeat).toBe(1)
  })
})

describe('playerIdOfInput', () => {
  it('agrees with the datagram it reads, for all 8 seats', () => {
    for (let seat = 0; seat < MAX_KARTS; seat++) {
      expect(playerIdOfInput(inputDatagram(seat))).toBe(seat)
    }
  })

  it('returns -1 on a 0-, 1- and 2-byte buffer', () => {
    expect(playerIdOfInput(new Uint8Array(0))).toBe(-1)
    expect(playerIdOfInput(new Uint8Array([WIRE_TAG.input]))).toBe(-1)
    expect(playerIdOfInput(new Uint8Array([WIRE_TAG.input, 2]))).toBe(-1)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/net/test/authz.test.ts`

Expected: FAIL, before a single assertion runs, with

```
Error: Failed to resolve import "../src/authz" from "packages/net/test/authz.test.ts". Does the file exist?
```

If `playerIdOfInput` is also absent, the same run additionally reports
`SyntaxError: The requested module '@tapkart/protocol' does not provide an export named 'playerIdOfInput'` once the `authz` import is satisfied. Step 3a is what settles that half.

- [ ] **Step 3a: Decide whether `playerIdOfInput` already exists**

Run: `grep -n "playerIdOfInput" packages/protocol/src/input.ts`

**If it prints nothing**, append this to the end of `packages/protocol/src/input.ts` — the whole of gate item G4, and this task owns it:

```ts
/**
 * The seat an input datagram CLAIMS, read without decoding it.
 *
 * Contract §2.10 G4. `buf` is the WHOLE datagram, header included - unlike
 * `decodeInput`, which takes the body. That is what contract §8.1's assertion
 * pins ("returns -1 on a 0-, 1- and 2-byte buffer": zero and one byte cannot
 * hold the 2-byte header, and two bytes are a header with no body at all), and
 * it is what lets §4.7's `withPeerAuthority` check a seat with no subarray and
 * no allocation on the hot path.
 *
 * encodeInput writes `playerId` first, in PLAYER_ID_BITS bits, and BitWriter is
 * LSB-first within each byte (bits.ts: "the first bit written is byte 0's 1s
 * place"), so the claim is the low PLAYER_ID_BITS of the first body byte. No
 * BitReader, no bounds-checked read, nothing that can throw: this runs on every
 * inbound datagram from a public socket.
 *
 * -1 for a buffer too short to hold those bits. NEVER 0 on a short buffer: seat
 * 0 is the host's, and a truncated datagram reading as a claim on it is a free
 * claim on the seat this function exists to protect.
 */
export function playerIdOfInput(buf: Uint8Array): number {
  const HEADER_BYTES = 2
  if (buf.length < HEADER_BYTES + 1) return -1
  return buf[HEADER_BYTES] & ((1 << PLAYER_ID_BITS) - 1)
}
```

then add it to `packages/protocol/src/index.ts` if that barrel lists names explicitly (it uses `export * from './input'`, so no edit is needed — confirm with `grep -n "input" packages/protocol/src/index.ts`), and create `packages/protocol/test/input-playerid.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { InputDatagram } from '@tapkart/protocol'
import { INPUT_REDUNDANCY, decodeInput, encodeHeader, encodeInput, playerIdOfInput } from '@tapkart/protocol'
import type { Intent } from '@tapkart/sim'
import { MAX_KARTS } from '@tapkart/sim'

function window(tick: number): Intent[] {
  const out: Intent[] = []
  for (let i = 0; i < INPUT_REDUNDANCY; i++) {
    out.push({ tick: tick - (INPUT_REDUNDANCY - 1 - i), steer: -0.25, accel: 0.75, brake: true, drift: false, useItem: true })
  }
  return out
}

function emptyDatagram(): InputDatagram {
  const intents: Intent[] = []
  for (let i = 0; i < INPUT_REDUNDANCY; i++) {
    intents.push({ tick: 0, steer: 0, accel: 0, brake: false, drift: false, useItem: false })
  }
  return { playerId: -1, intents }
}

describe('playerIdOfInput', () => {
  it('agrees with decodeInput over every seat', () => {
    for (let seat = 0; seat < MAX_KARTS; seat++) {
      const buf = new Uint8Array(256)
      const h = encodeHeader(buf, 'input')
      const n = encodeInput(buf.subarray(h), seat, window(40))
      const datagram = buf.slice(0, h + n)

      const out = emptyDatagram()
      decodeInput(datagram.subarray(h), out)

      expect(playerIdOfInput(datagram)).toBe(out.playerId)
      expect(playerIdOfInput(datagram)).toBe(seat)
    }
  })

  it('returns -1 rather than 0 on a buffer too short to hold the claim', () => {
    expect(playerIdOfInput(new Uint8Array(0))).toBe(-1)
    expect(playerIdOfInput(new Uint8Array(1))).toBe(-1)
    expect(playerIdOfInput(new Uint8Array(2))).toBe(-1)
  })

  it('never throws, whatever the bytes are', () => {
    for (let b = 0; b < 256; b++) {
      expect(() => playerIdOfInput(new Uint8Array([0x10, 2, b]))).not.toThrow()
    }
  })
})
```

**If `grep` prints a line**, an earlier task already shipped G4. Read it and do **not** add a second copy. One of two shapes will be there:

- it takes the **whole datagram** (`buf.length < 3` returns -1) — nothing changes; skip the `input.ts` edit and the protocol test above;
- it takes the **body** (`buf.length < 1` returns -1, reads `buf[0]`) — skip the edit, skip the protocol test, and in Step 3b replace the single line

  ```ts
  const claimed = playerIdOfInput(data)
  ```

  with

  ```ts
  const claimed = playerIdOfInput(data.subarray(HEADER_BYTES))
  ```

  and change the two `playerIdOfInput` cases at the bottom of `authz.test.ts` to pass `datagram.subarray(2)` and a 0-byte buffer. A `subarray` is a three-word view and copies no bytes, so the hot path stays allocation-free in the sense §4.7 means.

- [ ] **Step 3b: Write the implementation**

Create `packages/net/src/authz.ts`:

```ts
// PURE (contract §0a). A decorator over a Transport and a seat map: no socket,
// no clock, no RTCPeerConnection, no timer, and every decision in it is a unit
// test in packages/net/test/authz.test.ts.
import type { ChannelName } from '@tapkart/protocol'
import { WIRE_TAG, playerIdOfInput } from '@tapkart/protocol'
import type { Transport } from './transport'

/** encodeHeader writes [tag, protocolVersion] and returns 2. */
const HEADER_BYTES = 2

export interface PeerAuthority {
  /** The seat this peer is authorised to submit input for, or -1 for none. */
  playerIdOf(peerId: string): number
  /** True only for the peer currently entitled to originate AUTHORITATIVE
   *  traffic - snapshots, events, checkpoints, authorityChange. On the server
   *  that is the room's host peer, until the shadow promotes; after promotion
   *  nothing inbound is authoritative and this returns false for everyone. */
  isAuthority(peerId: string): boolean
}

export interface PeerAuthorityDrops {
  /** Input datagrams whose claimed playerId was not this peer's seat. */
  wrongSeat: number
  /** Authoritative kinds from a peer that is not the authority. */
  notAuthority: number
  /** Datagrams too short to classify. */
  malformed: number
}

/**
 * The four kinds only an authority may originate. `authorityChange` is in this
 * set and it is the most important member: AuthorityLoop demotes on ANY foreign
 * authorityChange without reading the body (correctly - no transport loops a
 * broadcast back to its sender, so every one it sees is foreign), which means
 * two bytes with tag 0x20 from any peer permanently stop a host broadcasting.
 * Where a shadow exists that degrades to a server-authoritative race; where one
 * does not, the room has no authority left at all.
 */
const AUTHORITATIVE_TAGS: ReadonlySet<number> = new Set<number>([
  WIRE_TAG.snapshot,
  WIRE_TAG.events,
  WIRE_TAG.checkpoint,
  WIRE_TAG.authorityChange,
])

const dropsOfTransport = new WeakMap<Transport, PeerAuthorityDrops>()

/**
 * Wraps a Transport so every INBOUND datagram is checked against `authority`
 * before any loop sees it. Everything else delegates.
 *
 * WHY THIS EXISTS. Plan 2 shipped identity by claim, deliberately, and said so
 * in its own source (authority.ts): "any peer can send a datagram naming any
 * playerId. Plan 4's lobby handshake is where reclaiming a seat gets
 * authenticated." Without this decorator, AuthorityLoop learns peerId ->
 * playerId from the datagram itself and validates nothing, so any peer in the
 * room can seize any seat - including the host's - by sending one input
 * datagram naming it, and the reclaim line will helpfully mark that seat
 * connected. On the server, any guest could forge a snapshot the shadow
 * reconciles its whole race onto.
 *
 * WHY A DECORATOR. AuthorityLoop, ClientLoop and ShadowLoop have locked public
 * shapes and none of them takes a seat map. A transport decorator is a
 * transport, `net` owns transports, and this is the shape withLocalInput
 * already established - so one implementation and one test covers both the
 * host's fan-out and the server's room transport.
 *
 * Allocation-free on the hot path: the seat check reads playerIdOfInput(data) -
 * three bits at a fixed offset - and never decodes the intent window. No
 * decodeHeader either: this runs OUTSIDE the shipped datagram guard, in front
 * of it, and decodeHeader throws on an unknown tag.
 */
export function withPeerAuthority(inner: Transport, authority: PeerAuthority): Transport {
  const drops: PeerAuthorityDrops = { wrongSeat: 0, notAuthority: 0, malformed: 0 }

  // ONE listener on `inner`, fanned out to however many this decorator's own
  // onMessage collects. Registering a filtered listener per subscriber would
  // count each dropped datagram once per subscriber, and on a guest there are
  // two of them (ClientLoop and RoomClient) - a drop counter that reads 2 for
  // one dropped datagram is worse than no counter, because the number is what a
  // reader reasons about. Appending, never replacing: contract §2.1 rule 1.
  const cbs: ((peerId: string, channel: ChannelName, data: Uint8Array) => void)[] = []
  let subscribed = false

  const dispatch = (peerId: string, channel: ChannelName, data: Uint8Array): void => {
    if (data.length < HEADER_BYTES) {
      drops.malformed++
      return
    }
    const tag = data[0]
    if (tag === WIRE_TAG.input) {
      const claimed = playerIdOfInput(data)
      if (claimed < 0) {
        // Too short to hold the claim. Counted malformed and NOT read as seat
        // 0, which is the host's.
        drops.malformed++
        return
      }
      if (claimed !== authority.playerIdOf(peerId)) {
        // playerIdOf returns -1 for a peer with no seat, and `claimed` is >= 0
        // here, so a seatless peer is refused every seat by this one comparison.
        drops.wrongSeat++
        return
      }
    } else if (AUTHORITATIVE_TAGS.has(tag)) {
      if (!authority.isAuthority(peerId)) {
        drops.notAuthority++
        return
      }
    }
    // Everything else - the lobby kinds, ping and pong - passes untouched. They
    // are the hub's to adjudicate and it has the full message; a joining guest
    // has no seat yet, so a rule that refused seatless peers here would mean
    // nobody could ever acquire one.
    for (const cb of cbs) cb(peerId, channel, data)
  }

  const guarded: Transport = {
    // Outbound is never filtered: on both sides of this decorator the sender IS
    // the authority for what it sends.
    send: (channel, peerId, data) => inner.send(channel, peerId, data),
    broadcast: (channel, data) => inner.broadcast(channel, data),
    onMessage(cb) {
      cbs.push(cb)
      if (!subscribed) {
        subscribed = true
        inner.onMessage(dispatch)
      }
    },
    onPeerLost: (cb) => inner.onPeerLost(cb),
    peers: () => inner.peers(),
    close: () => inner.close(),
  }

  dropsOfTransport.set(guarded, drops)
  return guarded
}

/**
 * The per-reason drop counts for a transport `withPeerAuthority` produced.
 * Throws if it did not - a silent 0 for "this object has no counter" is
 * indistinguishable from "nothing has been dropped", which is the exact
 * confusion the counter exists to prevent. Same WeakMap idiom as
 * droppedDatagramsOf (receive.ts).
 *
 * A COPY, not the live object: a diagnostic a caller can accidentally reset is
 * not a diagnostic.
 */
export function peerAuthorityDropsOf(t: Transport): PeerAuthorityDrops {
  const drops = dropsOfTransport.get(t)
  if (!drops) {
    throw new Error('peerAuthorityDropsOf: not a transport produced by withPeerAuthority')
  }
  return { ...drops }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/net/test/authz.test.ts packages/protocol/test/input-playerid.test.ts`

Expected: PASS — 21 tests if Step 3a added `playerIdOfInput`, 18 if it was already there (the protocol file is then absent and vitest is given one path that does not exist; drop it from the command).

Then run the packages that were touched, to prove nothing else moved:

`npx vitest run packages/net packages/protocol`

Expected: PASS. In particular `packages/net/test/barrel.test.ts` still passes at this point **only if the barrel task has not run yet**; if it has, `authz.ts` is a new module in `src/` with no barrel line and that test will say *"a module was added to src/ without a line in the barrel"*. That is Task 15's edit, not this one's — if you see it, Task 15 has already landed and its `SURFACE`/`BARREL_MODULES` entries for `authz` are what is missing.

- [ ] **Step 5: Commit**

```bash
git add packages/net/src/authz.ts packages/net/test/authz.test.ts packages/protocol/src/input.ts packages/protocol/test/input-playerid.test.ts && git commit -m "feat(net): authorise every inbound datagram against the room's seat map

withPeerAuthority checks input against the peer's own seat and the four
authoritative kinds against the room's authority, counting each refusal by
reason. Closes seat seizure, forged snapshots, and the two-byte authorityChange
that could stop a host broadcasting from any peer in the room."
```

(Drop the two `protocol` paths from the `git add` if Step 3a found `playerIdOfInput` already shipped.)
