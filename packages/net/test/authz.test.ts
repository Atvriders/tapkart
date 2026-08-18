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
