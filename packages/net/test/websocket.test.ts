import { describe, expect, it } from 'vitest'
import type { ChannelName } from '@tapkart/protocol'
import { WIRE_TAG, encodeHeader } from '@tapkart/protocol'
import type { SocketData, SocketLike } from '../src/socket'
import { WS_CLOSE_BACKPRESSURE } from '../src/socket'
import {
  WS_CONTROL_PEER_GONE,
  WS_CONTROL_PEER_JOINED,
  WS_HEADER_BYTES,
  WS_SLOT_BROADCAST,
  WS_SLOT_SERVER,
  decodeWsFrame,
  encodeWsControl,
  encodeWsData,
} from '../src/wsframe'
import { WS_MAX_RELIABLE_BUFFERED_BYTES, makeWebSocketTransport } from '../src/websocket'
import type { WebSocketTransport } from '../src/websocket'
import { makeFakeSocketPair } from './fixtures/socket-fixtures'

/** A one-message datagram: [tag, version, ...body]. */
function datagram(kind: 'snapshot' | 'input' | 'ping' | 'events', body: number[] = [0]): Uint8Array {
  const buf = new Uint8Array(2 + body.length)
  const h = encodeHeader(buf, kind)
  buf.set(body, h)
  return buf
}

function controlFrame(op: number, slot: number): Uint8Array {
  const out = new Uint8Array(WS_HEADER_BYTES)
  encodeWsControl(out, op, slot)
  return out
}

function dataFrame(channel: ChannelName, originSlot: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(WS_HEADER_BYTES + payload.length)
  encodeWsData(out, channel, originSlot, payload)
  return out
}

/** Everything the transport's socket put on the wire, decoded. */
function wireOf(far: SocketLike, flush: () => void): { frames: Uint8Array[]; text: string[] } {
  const frames: Uint8Array[] = []
  const text: string[] = []
  far.onMessage((d: SocketData) => {
    if (typeof d === 'string') text.push(d)
    else frames.push(d.slice())
  })
  flush()
  return { frames, text }
}

function setup(overrides: { selfSlot?: number; maxBufferedBytes?: number } = {}): {
  t: WebSocketTransport
  pair: ReturnType<typeof makeFakeSocketPair>
  sent: Uint8Array[]
  text: string[]
} {
  const pair = makeFakeSocketPair()
  const t = makeWebSocketTransport({
    socket: pair.a,
    selfSlot: overrides.selfSlot ?? 1,
    maxBufferedBytes: overrides.maxBufferedBytes ?? 64,
  })
  const wire = wireOf(pair.b, () => {})
  return { t, pair, sent: wire.frames, text: wire.text }
}

describe('net/websocket - addressing and the slot table', () => {
  it('delivers server traffic before this client has learned its own slot', () => {
    const pair = makeFakeSocketPair()
    const t = makeWebSocketTransport({ socket: pair.a })
    const got: number[] = []
    t.onMessage((_peerId, _channel, data) => got.push(data[0]))

    pair.b.send(dataFrame('reliable', WS_SLOT_SERVER, datagram('snapshot')))
    pair.flush()

    expect(got).toEqual([WIRE_TAG.snapshot])
  })

  it('sets its slot once, then restores self-echo filtering', () => {
    const pair = makeFakeSocketPair()
    const t = makeWebSocketTransport({ socket: pair.a })
    const got: number[] = []
    t.onMessage((_peerId, _channel, data) => got.push(data[2]))

    pair.b.send(dataFrame('unreliable', 7, datagram('input', [1])))
    pair.flush()
    t.setSelfSlot(7)
    pair.b.send(dataFrame('unreliable', 7, datagram('input', [2])))
    pair.b.send(dataFrame('unreliable', 8, datagram('input', [3])))
    pair.flush()

    expect(got).toEqual([1, 3])
  })

  it('rejects invalid slots and reassignment', () => {
    const pair = makeFakeSocketPair()
    const t = makeWebSocketTransport({ socket: pair.a })
    expect(() => t.setSelfSlot(WS_SLOT_SERVER)).toThrow(/self slot/)
    expect(() => t.setSelfSlot(WS_SLOT_BROADCAST)).toThrow(/self slot/)
    expect(() => t.setSelfSlot(-1)).toThrow(/self slot/)
    t.setSelfSlot(4)
    expect(() => t.setSelfSlot(5)).toThrow(/already set/)

    expect(() => makeWebSocketTransport({ socket: makeFakeSocketPair().a, selfSlot: 0 }))
      .toThrow(/self slot/)
  })

  it('broadcasts ONE frame addressed to the broadcast slot, not one per peer', () => {
    const { t, pair, sent } = setup()
    pair.a.onMessage(() => {})
    pair.b.send(controlFrame(WS_CONTROL_PEER_JOINED, 2))
    pair.b.send(controlFrame(WS_CONTROL_PEER_JOINED, 3))
    pair.flush()
    expect(t.knownSlots()).toEqual([2, 3])

    t.broadcast('unreliable', datagram('snapshot'))
    pair.flush()

    expect(sent).toHaveLength(1)
    const frame = decodeWsFrame(sent[0])
    expect(frame?.peerSlot).toBe(WS_SLOT_BROADCAST)
    expect(frame?.channel).toBe('unreliable')
    expect(frame?.payload[0]).toBe(WIRE_TAG.snapshot)
  })

  it('reaches every learned peer once the server fans the frame out, and never the sender', () => {
    // The stand-in below is not a test of the hub: it is the two lines of
    // routing that make "one call, N recipients" observable at this layer, and
    // the echo suppression it exercises is the transport's own.
    const links = [1, 2, 3].map((slot) => {
      const pair = makeFakeSocketPair()
      const t = makeWebSocketTransport({ socket: pair.a, selfSlot: slot, maxBufferedBytes: 1 << 20 })
      const got: Array<[string, ChannelName, number]> = []
      t.onMessage((peerId, channel, data) => got.push([peerId, channel, data[0]]))
      return { slot, pair, t, got }
    })
    // Everyone learns everyone (the hub sends these on join).
    for (const from of links) {
      for (const other of links) from.pair.b.send(controlFrame(WS_CONTROL_PEER_JOINED, other.slot))
      from.pair.flush()
    }
    // The relay: one inbound broadcast frame out to every OTHER socket, with the
    // origin slot rewritten to the sender - exactly what §5.7's hub does.
    for (const from of links) {
      from.pair.b.onMessage((d) => {
        if (typeof d === 'string') return
        const f = decodeWsFrame(d)
        if (f === null || f.peerSlot !== WS_SLOT_BROADCAST || f.channel === null) return
        for (const to of links) to.pair.b.send(dataFrame(f.channel, from.slot, f.payload))
      })
    }

    links[0].t.broadcast('reliable', datagram('events', [7]))
    for (const l of links) l.pair.flush()

    expect(links[1].got).toEqual([['p1', 'reliable', WIRE_TAG.events]])
    expect(links[2].got).toEqual([['p1', 'reliable', WIRE_TAG.events]])
    // Frames whose origin equals selfSlot are dropped: a relay must never echo
    // a peer to itself.
    expect(links[0].got).toEqual([])
  })

  it('sends to a known peer by slot and no-ops on an unknown peer id', () => {
    const { t, pair, sent } = setup()
    pair.b.send(controlFrame(WS_CONTROL_PEER_JOINED, 5))
    pair.flush()

    t.send('reliable', 'p5', datagram('input'))
    t.send('reliable', 'p9', datagram('input')) // never joined
    t.send('reliable', 'nonsense', datagram('input'))
    pair.flush()

    expect(sent).toHaveLength(1)
    expect(decodeWsFrame(sent[0])?.peerSlot).toBe(5)
  })

  it('keeps the room as a peer from construction, so `hello` is never dropped', () => {
    const { t, pair, sent } = setup()
    expect(t.peers()).toEqual(['p0'])

    t.send('reliable', 'p0', datagram('input'))
    pair.flush()

    expect(sent).toHaveLength(1)
    expect(decodeWsFrame(sent[0])?.peerSlot).toBe(WS_SLOT_SERVER)
  })

  it('learns slots from control frames ONLY, never from a data frame origin', () => {
    const { t, pair } = setup()
    const got: string[] = []
    t.onMessage((peerId) => got.push(peerId))

    pair.b.send(dataFrame('unreliable', 6, datagram('input')))
    pair.flush()

    // Delivered - the datagram is real - but the slot is NOT learned: an
    // unknown origin is a routing bug, and silently learning it hides one.
    expect(got).toEqual(['p6'])
    expect(t.knownSlots()).toEqual([])
    expect(t.peers()).toEqual(['p0'])
  })

  it('fires onPeerLost exactly once for PEER_GONE, and not at all for a slot it never held', () => {
    const { t, pair } = setup()
    const lost: string[] = []
    t.onPeerLost((peerId) => lost.push(peerId))

    pair.b.send(controlFrame(WS_CONTROL_PEER_JOINED, 4))
    pair.b.send(controlFrame(WS_CONTROL_PEER_GONE, 4))
    pair.b.send(controlFrame(WS_CONTROL_PEER_GONE, 4))
    pair.b.send(controlFrame(WS_CONTROL_PEER_GONE, 7))
    pair.flush()

    expect(lost).toEqual(['p4'])
    expect(t.knownSlots()).toEqual([])
  })

  it('appends message listeners rather than replacing them', () => {
    // On a guest, ClientLoop and RoomClient both subscribe to this transport. A
    // replace-semantics implementation silently deletes the lobby.
    const { t, pair } = setup()
    const seen: string[] = []
    t.onMessage(() => seen.push('first'))
    t.onMessage(() => seen.push('second'))

    pair.b.send(dataFrame('unreliable', WS_SLOT_SERVER, datagram('snapshot')))
    pair.flush()

    expect(seen).toEqual(['first', 'second'])
  })
})

describe('net/websocket - text rides beside binary', () => {
  it('routes text to onText and binary to onMessage, with no discriminator byte', () => {
    const { t, pair, sent, text } = setup()
    const binary: number[] = []
    const signals: string[] = []
    t.onMessage((_p, _c, data) => binary.push(data[0]))
    t.onText((s) => signals.push(s))

    t.sendText('{"v":1,"t":"offer"}')
    pair.b.send('{"v":1,"t":"answer"}')
    pair.b.send(dataFrame('unreliable', WS_SLOT_SERVER, datagram('snapshot')))
    pair.flush()

    expect(text).toEqual(['{"v":1,"t":"offer"}'])
    expect(sent).toHaveLength(0)
    expect(signals).toEqual(['{"v":1,"t":"answer"}'])
    expect(binary).toEqual([WIRE_TAG.snapshot])
  })
})

describe('net/websocket - the latest-wins mailbox (F-P4-44)', () => {
  it('replaces an unsent unreliable datagram of the same (slot, tag) and counts the loser', () => {
    const { t, pair, sent } = setup()
    pair.stall(1000)

    t.broadcast('unreliable', datagram('snapshot', [1]))
    t.broadcast('unreliable', datagram('snapshot', [2]))
    pair.flush()

    expect(sent).toHaveLength(0)
    expect(t.mailboxDepth()).toBe(1)
    expect(t.droppedUnreliable()).toBe(1)

    pair.drain()
    // No timer anywhere in this transport: the mailbox drains on the next piece
    // of transport activity, which at 20 Hz snapshots is never far away.
    t.broadcast('unreliable', datagram('snapshot', [3]))
    pair.flush()

    expect(t.mailboxDepth()).toBe(0)
    expect(t.droppedUnreliable()).toBe(1)
    // The newest bytes for that key, not the ones it replaced.
    expect(sent).toHaveLength(2)
    expect(decodeWsFrame(sent[0])?.payload[2]).toBe(2)
    expect(decodeWsFrame(sent[1])?.payload[2]).toBe(3)
  })

  it('does not let a snapshot displace a ping: the key is (slot, tag)', () => {
    const { t, pair, sent } = setup()
    pair.stall(1000)

    t.broadcast('unreliable', datagram('ping'))
    t.broadcast('unreliable', datagram('snapshot'))
    t.broadcast('unreliable', datagram('snapshot'))
    pair.flush()

    expect(t.mailboxDepth()).toBe(2)
    expect(t.droppedUnreliable()).toBe(1)

    pair.drain()
    t.sendText('drain-pump')
    pair.flush()

    // Insertion order: the ping was held first, so it goes out first.
    expect(sent).toHaveLength(2)
    expect(decodeWsFrame(sent[0])?.payload[0]).toBe(WIRE_TAG.ping)
    expect(decodeWsFrame(sent[1])?.payload[0]).toBe(WIRE_TAG.snapshot)
  })

  it('keys the mailbox by SLOT as well as tag, so two peers never displace each other', () => {
    const { t, pair } = setup()
    pair.b.send(controlFrame(WS_CONTROL_PEER_JOINED, 2))
    pair.b.send(controlFrame(WS_CONTROL_PEER_JOINED, 3))
    pair.flush()
    pair.stall(1000)

    t.send('unreliable', 'p2', datagram('input'))
    t.send('unreliable', 'p3', datagram('input'))

    expect(t.mailboxDepth()).toBe(2)
    expect(t.droppedUnreliable()).toBe(0)
  })

  it('never mailboxes or drops a reliable datagram', () => {
    const { t, pair, sent } = setup()
    pair.stall(1000)

    t.broadcast('reliable', datagram('events', [1]))
    t.broadcast('reliable', datagram('events', [2]))
    pair.flush()

    // Dropping one silently breaks eventSeq monotonicity, which is the one
    // thing applyEvent cannot recover from.
    expect(sent).toHaveLength(2)
    expect(t.mailboxDepth()).toBe(0)
    expect(t.droppedUnreliable()).toBe(0)
  })

  it('closes the socket with 4003 when the RELIABLE backlog is past saving', () => {
    const { t, pair, sent } = setup()
    const codes: number[] = []
    pair.a.onClose((c) => codes.push(c))
    pair.stall(WS_MAX_RELIABLE_BUFFERED_BYTES + 1)

    t.broadcast('reliable', datagram('events'))
    pair.flush()

    expect(codes).toEqual([WS_CLOSE_BACKPRESSURE])
    expect(sent).toHaveLength(0)
    expect(t.peers()).toEqual([])
  })
})

describe('net/websocket - a malformed frame closes nothing', () => {
  it('drops it, counts nothing, and STILL PROCESSES the very next valid frame', () => {
    const { t, pair } = setup()
    const got: number[] = []
    t.onMessage((_p, _c, data) => got.push(data[0]))

    // Undecodable envelope, then a perfectly good datagram on the same socket,
    // in the same flush. A guard that drops the bad frame and then wedges the
    // receive loop passes every assertion about what did NOT arrive.
    pair.b.send(new Uint8Array([0x7f, 0x7f, 0x7f]))
    pair.b.send(new Uint8Array([]))
    pair.b.send(dataFrame('unreliable', WS_SLOT_SERVER, datagram('snapshot')))
    pair.flush()

    expect(got).toEqual([WIRE_TAG.snapshot])
    expect(t.peers()).toEqual(['p0'])
  })
})

describe('net/websocket - closing', () => {
  it('is idempotent, empties the slot table and the mailbox, and goes quiet both ways', () => {
    const { t, pair, sent } = setup()
    pair.b.send(controlFrame(WS_CONTROL_PEER_JOINED, 2))
    pair.flush()
    pair.stall(1000)
    t.broadcast('unreliable', datagram('snapshot'))
    expect(t.mailboxDepth()).toBe(1)

    const lost: string[] = []
    t.onPeerLost((p) => lost.push(p))
    t.close()
    t.close()

    expect(t.peers()).toEqual([])
    expect(t.knownSlots()).toEqual([])
    expect(t.mailboxDepth()).toBe(0)
    // A LOCAL close is not peer loss: nothing is delivered in either direction
    // after close(), and that includes callbacks.
    expect(lost).toEqual([])

    const before = sent.length
    t.broadcast('reliable', datagram('events'))
    pair.b.send(dataFrame('unreliable', WS_SLOT_SERVER, datagram('snapshot')))
    pair.flush()
    expect(sent).toHaveLength(before)
  })

  it('reports every peer lost when the SOCKET dies under it', () => {
    const { t, pair } = setup()
    pair.b.send(controlFrame(WS_CONTROL_PEER_JOINED, 2))
    pair.b.send(controlFrame(WS_CONTROL_PEER_JOINED, 3))
    pair.flush()
    const lost: string[] = []
    t.onPeerLost((p) => lost.push(p))

    pair.b.close(4002)

    expect(lost).toEqual(['p0', 'p2', 'p3'])
    expect(t.peers()).toEqual([])
  })
})
