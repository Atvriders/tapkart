import { describe, expect, it } from 'vitest'
import type {
  ChannelName,
  LobbyMessage,
  ResyncReason,
  StartMessage,
  WelcomeMessage,
} from '@tapkart/protocol'
import { WIRE_TAG, encodeCheckpoint, encodeHeader, encodeSnapshot } from '@tapkart/protocol'
import type { Intent, SimState } from '@tapkart/sim'
import { MAX_KARTS, createState } from '@tapkart/sim'
import type {
  RoomClientState,
  RoomClientUpdate,
  Transport,
} from '@tapkart/net'
import { encodeAuthorityChange } from '@tapkart/net'
import type { MultiplayerRoom } from '../src/multiplayer'
import { createMultiplayerSession } from '../src/multiplayer-session'
import { makeGameContext } from './fixtures/game-fixtures'

interface Outbound {
  kind: 'send' | 'broadcast'
  channel: ChannelName
  peerId: string
  data: Uint8Array
}

function makeRoomHarness(): {
  room: MultiplayerRoom
  deliver(peerId: string, channel: ChannelName, data: Uint8Array): void
  promote(tick: number, eventSeq: number): void
  outbound: Outbound[]
  leaseCloses(): number
  roomCloses(): number
} {
  interface Lease {
    active: boolean
    messages: Array<(peerId: string, channel: ChannelName, data: Uint8Array) => void>
    lost: Array<(peerId: string) => void>
  }
  const leases: Lease[] = []
  const authorityCbs: Array<(tick: number, eventSeq: number) => void> = []
  const outbound: Outbound[] = []
  let leaseCloses = 0
  let roomCloses = 0

  function borrow(): Transport {
    const lease: Lease = { active: true, messages: [], lost: [] }
    leases.push(lease)
    return {
      send(channel, peerId, data): void {
        if (lease.active) outbound.push({ kind: 'send', channel, peerId, data: data.slice() })
      },
      broadcast(channel, data): void {
        if (lease.active) outbound.push({ kind: 'broadcast', channel, peerId: '*', data: data.slice() })
      },
      onMessage(cb): void { lease.messages.push(cb) },
      onPeerLost(cb): void { lease.lost.push(cb) },
      peers: () => lease.active ? ['ws/p0'] : [],
      close(): void {
        if (!lease.active) return
        lease.active = false
        leaseCloses++
      },
    }
  }

  const state = { authorityTick: -1 } as RoomClientState
  const room: MultiplayerRoom = {
    state: () => state,
    start(): void {},
    poll(): void {},
    update(_patch: RoomClientUpdate): void {},
    requestStart(): void {},
    requestResync(_reason: ResyncReason, _lastTick: number): void {},
    finishRace(): void {},
    returnToLobby(): void {},
    borrowRaceTransport: borrow,
    onWelcome(_cb: (message: WelcomeMessage) => void): void {},
    onLobby(_cb: (message: LobbyMessage) => void): void {},
    onStart(_cb: (message: StartMessage) => void): void {},
    onAuthorityChange(cb): void { authorityCbs.push(cb) },
    onClosed(): void {},
    close(): void { roomCloses++ },
  }

  const deliver = (peerId: string, channel: ChannelName, data: Uint8Array): void => {
    for (const lease of [...leases]) {
      if (!lease.active) continue
      for (const cb of [...lease.messages]) cb(peerId, channel, data)
    }
  }

  return {
    room,
    deliver,
    promote(tick, eventSeq): void {
      const buf = new Uint8Array(16)
      const n = encodeAuthorityChange(buf, tick, eventSeq)
      // Real ordering: the race transport demotes first, then RoomClient tells
      // the composition root to create its hidden client.
      deliver('ws/p0', 'reliable', buf.slice(0, n))
      state.authorityTick = tick
      for (const cb of [...authorityCbs]) cb(tick, eventSeq)
    },
    outbound,
    leaseCloses: () => leaseCloses,
    roomCloses: () => roomCloses,
  }
}

const START: StartMessage = {
  raceSeed: 0x1234,
  trackId: 'caldera',
  humanMask: 0b11,
  characterIdx: [0, 1, 2, 3, 4, 5, 6, 7],
}

function input(): Intent {
  return { tick: 0, steer: 0.25, accel: 1, brake: false, drift: false, useItem: false }
}

function snapshotDatagram(state: SimState): Uint8Array {
  const buf = new Uint8Array(2048)
  const h = encodeHeader(buf, 'snapshot')
  const n = encodeSnapshot(buf.subarray(h), state, new Array<number>(MAX_KARTS).fill(state.tick))
  return buf.slice(0, h + n)
}

function checkpointDatagram(state: SimState): Uint8Array {
  const buf = new Uint8Array(8192)
  const h = encodeHeader(buf, 'checkpoint')
  const n = encodeCheckpoint(buf.subarray(h), state)
  return buf.slice(0, h + n)
}

describe('createMultiplayerSession — server promotion handoff', () => {
  it('demotes a reclaimed host and adopts the promoted shadow checkpoint', () => {
    const harness = makeRoomHarness()
    const session = createMultiplayerSession({
      room: harness.room,
      role: 'host',
      ctx: makeGameContext(true),
      localPlayerId: 0,
      start: START,
    })
    const authoritative = createState(makeGameContext(false), START.raceSeed, START.characterIdx)
    authoritative.tick = 90
    authoritative.nextEventSeq = 7
    authoritative.karts[0].position.x = 12.5

    harness.promote(90, 7)
    harness.deliver('ws/p0', 'reliable', checkpointDatagram(authoritative))
    const nextSnapshot = createState(makeGameContext(false), START.raceSeed, START.characterIdx)
    nextSnapshot.tick = 93
    nextSnapshot.nextEventSeq = 7
    nextSnapshot.karts[0].position.x = 13
    harness.deliver('ws/p0', 'unreliable', snapshotDatagram(nextSnapshot))
    session.tickOnce(input())

    expect(session.role).toBe('guest')
    expect(session.state().tick).toBeGreaterThanOrEqual(90)
    expect(session.state().nextEventSeq).toBeGreaterThanOrEqual(7)
    expect(session.state().karts[0].position.x).toBeGreaterThan(12)
    expect(harness.leaseCloses()).toBe(1)
    expect(harness.roomCloses()).toBe(0)
    session.close()
  })

  it('keeps the old view live, then adopts the first authoritative snapshot without owning the room', () => {
    const harness = makeRoomHarness()
    const ctx = makeGameContext(true)
    const session = createMultiplayerSession({
      room: harness.room,
      role: 'host',
      ctx,
      localPlayerId: 0,
      start: START,
    })
    const viewA = session.currentView()
    const viewB = session.prevView()

    for (let i = 0; i < 8; i++) session.tickOnce(input())
    const beforePromotion = session.state().tick
    harness.promote(beforePromotion, 4)

    // The hidden client starts, but the rendered session neither rewinds nor
    // changes role until authoritative state has actually arrived.
    expect(session.role).toBe('host')
    expect(session.state().tick).toBe(beforePromotion)
    session.tickOnce(input())
    expect(session.role).toBe('host')
    expect(session.state().tick).toBeGreaterThan(beforePromotion)

    const authoritative = createState(makeGameContext(false), START.raceSeed, START.characterIdx)
    authoritative.tick = session.state().tick + 6
    authoritative.karts[0].position.x = session.state().karts[0].position.x + 0.75
    harness.deliver('ws/p0', 'unreliable', snapshotDatagram(authoritative))
    const lastVisibleTick = session.state().tick
    session.tickOnce(input())

    expect(session.role).toBe('guest')
    expect(session.state().tick).toBeGreaterThanOrEqual(lastVisibleTick)
    expect(session.currentView()).toBe(viewA)
    expect(session.prevView()).toBe(viewB)
    expect(harness.leaseCloses()).toBe(1) // old authority lease only
    expect(harness.roomCloses()).toBe(0)

    const correction = { x: 0, y: 0, z: 0 }
    expect(session.correctionDelta(correction)).not.toBeNull()
    expect(Math.abs(correction.x)).toBeGreaterThan(0)

    harness.outbound.length = 0
    session.tickOnce(input())
    session.tickOnce(input())
    const inputs = harness.outbound.filter((sent) => sent.data[0] === WIRE_TAG.input)
    expect(inputs).toHaveLength(1)

    session.close()
    session.close()
    expect(harness.leaseCloses()).toBe(2)
    expect(harness.roomCloses()).toBe(0)
  })

  it('adopts an accepted early snapshot even when it needs no hard resync', () => {
    const harness = makeRoomHarness()
    const ctx = makeGameContext(true)
    const session = createMultiplayerSession({
      room: harness.room,
      role: 'host',
      ctx,
      localPlayerId: 0,
      start: START,
    })

    harness.promote(0, 0)
    const authoritative = createState(makeGameContext(false), START.raceSeed, START.characterIdx)
    authoritative.tick = 1
    harness.deliver('ws/p0', 'unreliable', snapshotDatagram(authoritative))
    session.tickOnce(input())

    expect(session.role).toBe('guest')
    expect(session.hardResyncs()).toBe(0)
    expect(harness.leaseCloses()).toBe(1)
    expect(harness.roomCloses()).toBe(0)
    session.close()
  })
})
