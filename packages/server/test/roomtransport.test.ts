import { describe, expect, it } from 'vitest'
import type { ChannelName } from '@tapkart/protocol'
import type { Transport } from '@tapkart/net'
import { WS_SLOT_SERVER, decodeWsFrame } from '@tapkart/net'
import { MAX_KARTS } from '@tapkart/sim'
import type { ConformanceHarness } from '../../net/test/fixtures/transport-conformance'
import { runTransportConformance } from '../../net/test/fixtures/transport-conformance'
import { makeRoomTransport } from '../src/roomtransport'
import type { PeerId, PeerRecord, RoomRecord } from '../src/types'

function makeRoom(): RoomRecord {
  return {
    code: 'ABCDE', createdAtMs: 0, lastActivityMs: 0, phase: 'lobby',
    hostPeerId: null, hostPlayerId: -1, trackId: 'caldera', lobbyVersion: 1,
    raceSeed: 0, peers: new Map<PeerId, PeerRecord>(), slotsInUse: new Set<number>(),
    seats: new Array<PeerId | null>(MAX_KARTS).fill(null), rtcFailures: 0, race: null,
  }
}

function addPeer(room: RoomRecord, peerId: string, slot: number, connected = true): PeerRecord {
  const peer: PeerRecord = {
    peerId, slot, playerId: -1, token: '', role: 'guest', name: '', characterIdx: 0,
    ready: false, relay: false, connected, joinedAtMs: 0, lastSeenMs: 0,
    liveness: {
      lastSeenMs: 0, lastPingSentMs: 0, lastPingSeq: 0,
      rttMs: 0, pingsSent: 0, pongsSeen: 0,
    },
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
    sendFrame: (peer, frame) => sent.push({ peerId: peer.peerId, frame: frame.slice() }),
  })
  return { room, sent, t }
}

describe('RoomTransport outbound traffic', () => {
  it('frames a directed datagram as originating at the room slot', () => {
    const h = harness()
    addPeer(h.room, 'a', 1)
    addPeer(h.room, 'b', 2)
    h.t.send('reliable', 'b', new Uint8Array([0x11, 0x02, 0xaa]))
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0].peerId).toBe('b')
    const frame = decodeWsFrame(h.sent[0].frame)
    expect(frame).toMatchObject({ channel: 'reliable', peerSlot: WS_SLOT_SERVER })
    expect(Array.from(frame?.payload ?? [])).toEqual([0x11, 0x02, 0xaa])
  })

  it('silently ignores unknown, disconnected, and gone targets', () => {
    const h = harness()
    addPeer(h.room, 'live', 1)
    addPeer(h.room, 'offline', 2, false)
    h.t.send('reliable', 'unknown', new Uint8Array([1]))
    h.t.send('reliable', 'offline', new Uint8Array([1]))
    h.t.notePeerGone('live')
    h.t.send('reliable', 'live', new Uint8Array([1]))
    expect(h.sent).toEqual([])
  })

  it('broadcasts once to each live peer with independent frame buffers', () => {
    const h = harness()
    addPeer(h.room, 'a', 1)
    addPeer(h.room, 'b', 2)
    addPeer(h.room, 'offline', 3, false)
    h.t.broadcast('unreliable', new Uint8Array([9]))
    expect(h.sent.map((sent) => sent.peerId).sort()).toEqual(['a', 'b'])
    expect(h.sent[0].frame).not.toBe(h.sent[1].frame)
    expect(Array.from(decodeWsFrame(h.sent[0].frame)?.payload ?? [])).toEqual([9])
  })

  it('reports only live peers and becomes inert after idempotent close', () => {
    const h = harness()
    addPeer(h.room, 'a', 1)
    addPeer(h.room, 'offline', 2, false)
    expect(h.t.peers()).toEqual(['a'])
    h.t.close()
    h.t.close()
    expect(h.t.peers()).toEqual([])
    h.t.broadcast('reliable', new Uint8Array([1]))
    expect(h.sent).toEqual([])
  })
})

describe('RoomTransport inbound traffic and loss', () => {
  it('appends message listeners and invokes them in order', () => {
    const h = harness()
    const seen: string[] = []
    h.t.onMessage((peerId, channel, data) => seen.push(`one:${peerId}:${channel}:${data.length}`))
    h.t.onMessage((peerId) => seen.push(`two:${peerId}`))
    h.t.deliver('a', 'unreliable', new Uint8Array([1, 2]))
    expect(seen).toEqual(['one:a:unreliable:2', 'two:a'])
  })

  it('delivers nothing after close', () => {
    const h = harness()
    let calls = 0
    h.t.onMessage(() => { calls++ })
    h.t.deliver('a', 'reliable', new Uint8Array([1]))
    h.t.close()
    h.t.deliver('a', 'reliable', new Uint8Array([1]))
    expect(calls).toBe(1)
  })

  it('notifies every loss listener once and removes the peer immediately', () => {
    const h = harness()
    addPeer(h.room, 'a', 1)
    addPeer(h.room, 'b', 2)
    const lost: string[] = []
    h.t.onPeerLost((peerId) => lost.push(`one:${peerId}`))
    h.t.onPeerLost((peerId) => lost.push(`two:${peerId}`))
    h.t.notePeerGone('b')
    h.t.notePeerGone('b')
    expect(lost).toEqual(['one:b', 'two:b'])
    expect(h.t.peers()).toEqual(['a'])
    h.t.broadcast('reliable', new Uint8Array([1]))
    expect(h.sent.map((sent) => sent.peerId)).toEqual(['a'])
  })
})

function roomTransportConformanceHarness(): ConformanceHarness {
  const room = makeRoom()
  addPeer(room, 'b', 2)
  const pending: Array<() => void> = []
  const bMessageCbs: Array<(peerId: string, channel: ChannelName, data: Uint8Array) => void> = []
  const bLostCbs: Array<(peerId: string) => void> = []
  let bClosed = false

  const a = makeRoomTransport({
    room,
    sendFrame: (peer, frame) => {
      if (peer.peerId !== 'b') return
      const copy = frame.slice()
      pending.push(() => {
        if (bClosed) return
        const decoded = decodeWsFrame(copy)
        if (decoded?.channel === null || decoded === null) return
        for (const cb of [...bMessageCbs]) cb('server', decoded.channel, decoded.payload)
      })
    },
  })

  const b: Transport = {
    send(channel, peerId, data): void {
      if (bClosed || peerId !== 'server') return
      const copy = data.slice()
      pending.push(() => a.deliver('b', channel, copy))
    },
    broadcast(channel, data): void { this.send(channel, 'server', data) },
    onMessage(cb): void { bMessageCbs.push(cb) },
    onPeerLost(cb): void { bLostCbs.push(cb) },
    peers: () => bClosed ? [] : ['server'],
    close(): void {
      if (bClosed) return
      bClosed = true
    },
  }

  return {
    a,
    b,
    flush(): void {
      while (pending.length > 0) pending.shift()?.()
    },
    dropB(): void {
      if (bClosed) return
      bClosed = true
      a.notePeerGone('b')
      for (const cb of [...bLostCbs]) cb('server')
    },
  }
}

runTransportConformance('RoomTransport', roomTransportConformanceHarness)
