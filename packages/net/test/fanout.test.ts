import { describe, expect, it } from 'vitest'
import type { ChannelName } from '@tapkart/protocol'
import type { Transport } from '../src/transport'
import {
  PEER_ID_SEPARATOR,
  makeFanOutTransport,
  scopePeerId,
  splitPeerId,
} from '../src/fanout'

interface SpyTransport extends Transport {
  sent: Array<[ChannelName, string, number]>
  broadcasts: Array<[ChannelName, number]>
  closes: number
  deliver(peerId: string, channel: ChannelName, data: Uint8Array): void
  losePeer(peerId: string): void
  setPeers(ids: string[]): void
}

function makeSpy(peerIds: string[]): SpyTransport {
  let ids = [...peerIds]
  const messageCbs: Array<(peerId: string, channel: ChannelName, data: Uint8Array) => void> = []
  const peerLostCbs: Array<(peerId: string) => void> = []
  const spy: SpyTransport = {
    sent: [],
    broadcasts: [],
    closes: 0,
    send(channel, peerId, data): void {
      spy.sent.push([channel, peerId, data[0]])
    },
    broadcast(channel, data): void {
      spy.broadcasts.push([channel, data[0]])
    },
    onMessage(cb): void {
      messageCbs.push(cb)
    },
    onPeerLost(cb): void {
      peerLostCbs.push(cb)
    },
    peers: () => [...ids],
    close(): void {
      spy.closes++
    },
    deliver(peerId, channel, data): void {
      for (const cb of [...messageCbs]) cb(peerId, channel, data)
    },
    losePeer(peerId): void {
      ids = ids.filter((i) => i !== peerId)
      for (const cb of [...peerLostCbs]) cb(peerId)
    },
    setPeers(next): void {
      ids = [...next]
    },
  }
  return spy
}

const D = (n: number): Uint8Array => new Uint8Array([n, 2, 0])

describe('net/fanout - peer id scoping', () => {
  it('round-trips a scoped id and refuses to guess at a broken one', () => {
    expect(PEER_ID_SEPARATOR).toBe('/')
    expect(scopePeerId('rtc', 'host')).toBe('rtc/host')
    expect(splitPeerId('rtc/host')).toEqual({ partId: 'rtc', peerId: 'host' })
    // Split at the FIRST separator, so an inner id with a slash still
    // round-trips rather than being silently reassigned to another part.
    expect(splitPeerId(scopePeerId('ws', 'p2/x'))).toEqual({ partId: 'ws', peerId: 'p2/x' })

    for (const bad of ['', 'nosep', '/leading', 'trailing/']) {
      expect(splitPeerId(bad), bad).toBeNull()
    }
  })

  it('throws on a part id that would make a scoped id ambiguous', () => {
    const t = makeFanOutTransport()
    expect(() => t.addPart({ id: 'a/b', transport: makeSpy([]) })).toThrow(/contain no/)
    expect(() => t.addPart({ id: '', transport: makeSpy([]) })).toThrow()
    // ...and on an inner peer id carrying the separator, checked at add.
    expect(() => t.addPart({ id: 'rtc', transport: makeSpy(['ho/st']) })).toThrow(/contains/)

    t.addPart({ id: 'ws', transport: makeSpy([]) })
    expect(() => t.addPart({ id: 'ws', transport: makeSpy([]) })).toThrow(/duplicate/)
    expect(t.partIds()).toEqual(['ws'])
  })
})

describe('net/fanout - one call, N recipients', () => {
  it('broadcasts to EVERY part', () => {
    // Spec §5: every client sends its input to both the host and the server
    // shadow. A fan-out that reached only the first part would look completely
    // healthy right up until the host dropped.
    const rtc = makeSpy(['host'])
    const ws = makeSpy(['p0'])
    const t = makeFanOutTransport([
      { id: 'rtc', transport: rtc },
      { id: 'ws', transport: ws },
    ])

    t.broadcast('unreliable', D(0x10))

    expect(rtc.broadcasts).toEqual([['unreliable', 0x10]])
    expect(ws.broadcasts).toEqual([['unreliable', 0x10]])
  })

  it('routes send() by the part prefix and no-ops on anything it cannot place', () => {
    const rtc = makeSpy(['host'])
    const ws = makeSpy(['p0'])
    const t = makeFanOutTransport([
      { id: 'rtc', transport: rtc },
      { id: 'ws', transport: ws },
    ])

    t.send('reliable', 'ws/p0', D(0x12))
    t.send('reliable', 'rtc/host', D(0x11))
    t.send('reliable', 'gone/p0', D(0x13)) // unknown part
    t.send('reliable', 'unscoped', D(0x13)) // unparseable

    expect(ws.sent).toEqual([['reliable', 'p0', 0x12]])
    expect(rtc.sent).toEqual([['reliable', 'host', 0x11]])
  })

  it('reports every part\'s peers, scoped, and re-emits inbound datagrams scoped', () => {
    const rtc = makeSpy(['host'])
    const ws = makeSpy(['p0', 'p3'])
    const t = makeFanOutTransport([
      { id: 'rtc', transport: rtc },
      { id: 'ws', transport: ws },
    ])
    const got: Array<[string, ChannelName, number]> = []
    t.onMessage((peerId, channel, data) => got.push([peerId, channel, data[0]]))

    expect(t.peers()).toEqual(['rtc/host', 'ws/p0', 'ws/p3'])

    rtc.deliver('host', 'unreliable', D(0x11))
    ws.deliver('p3', 'reliable', D(0x12))

    expect(got).toEqual([
      ['rtc/host', 'unreliable', 0x11],
      ['ws/p3', 'reliable', 0x12],
    ])
  })

  it('appends message listeners rather than replacing them', () => {
    const ws = makeSpy(['p0'])
    const t = makeFanOutTransport([{ id: 'ws', transport: ws }])
    const seen: string[] = []
    t.onMessage(() => seen.push('first'))
    t.onMessage(() => seen.push('second'))

    ws.deliver('p0', 'reliable', D(0x03))

    expect(seen).toEqual(['first', 'second'])
  })

  it('takes a part added later, which is how a late-joining guest arrives', () => {
    const t = makeFanOutTransport()
    const got: string[] = []
    t.onMessage((peerId) => got.push(peerId))

    const late = makeSpy(['guest2'])
    t.addPart({ id: 'rtc2', transport: late })
    late.deliver('guest2', 'unreliable', D(0x10))

    expect(t.partIds()).toEqual(['rtc2'])
    expect(got).toEqual(['rtc2/guest2'])
  })
})

describe('net/fanout - losing peers and parts', () => {
  it('re-emits a part\'s own peer loss, scoped', () => {
    const rtc = makeSpy(['host'])
    const t = makeFanOutTransport([{ id: 'rtc', transport: rtc }])
    const lost: string[] = []
    t.onPeerLost((p) => lost.push(p))

    rtc.losePeer('host')

    expect(lost).toEqual(['rtc/host'])
  })

  it('emits onPeerLost for each of a removed part\'s peers BEFORE dropping it', () => {
    const rtc = makeSpy(['guest1', 'guest2'])
    const t = makeFanOutTransport([{ id: 'rtc', transport: rtc }])
    const observed: Array<[string, string[]]> = []
    // The ordering is the assertion: at the moment each loss fires, the part
    // must still be present. A remove-then-notify implementation would report
    // an empty peer list here and the karts would freeze rather than go to bots.
    t.onPeerLost((p) => observed.push([p, t.partIds()]))

    t.removePart('rtc')

    expect(observed).toEqual([
      ['rtc/guest1', ['rtc']],
      ['rtc/guest2', ['rtc']],
    ])
    expect(t.partIds()).toEqual([])
    expect(t.peers()).toEqual([])
    // Removing a part is not closing it - the caller owns that transport's
    // lifetime, and a promoted authority reuses the same socket.
    expect(rtc.closes).toBe(0)
    // And it is idempotent.
    t.removePart('rtc')
    expect(observed).toHaveLength(2)
  })

  it('ignores stale callbacks from a removed part, even after its id is reused', () => {
    const first = makeSpy(['old'])
    const replacement = makeSpy(['new'])
    const t = makeFanOutTransport([{ id: 'rtc', transport: first }])
    const got: string[] = []
    const lost: string[] = []
    t.onMessage((p) => got.push(p))
    t.onPeerLost((p) => lost.push(p))

    t.removePart('rtc')
    expect(lost).toEqual(['rtc/old'])
    lost.length = 0
    t.addPart({ id: 'rtc', transport: replacement })

    first.deliver('old', 'unreliable', D(0x10))
    first.losePeer('old')
    replacement.deliver('new', 'reliable', D(0x11))

    expect(got).toEqual(['rtc/new'])
    expect(lost).toEqual([])
  })

  it('rejects a part added after close without claiming its lifetime', () => {
    const t = makeFanOutTransport()
    const late = makeSpy(['guest'])
    t.close()

    expect(() => t.addPart({ id: 'late', transport: late })).toThrow(/closed/)
    expect(t.partIds()).toEqual([])
    // A rejected part remains caller-owned; the fan-out neither retains nor
    // closes a transport it was never able to accept.
    expect(late.closes).toBe(0)
  })

  it('closes every part, once, and goes quiet in both directions', () => {
    const rtc = makeSpy(['host'])
    const ws = makeSpy(['p0'])
    const t = makeFanOutTransport([
      { id: 'rtc', transport: rtc },
      { id: 'ws', transport: ws },
    ])
    const got: string[] = []
    const lost: string[] = []
    t.onMessage((p) => got.push(p))
    t.onPeerLost((p) => lost.push(p))

    t.close()
    t.close()

    expect(rtc.closes).toBe(1)
    expect(ws.closes).toBe(1)
    expect(t.peers()).toEqual([])

    t.broadcast('reliable', D(0x12))
    t.send('reliable', 'ws/p0', D(0x12))
    rtc.deliver('host', 'unreliable', D(0x11))
    t.removePart('rtc')
    rtc.losePeer('host')

    expect(rtc.broadcasts).toEqual([])
    expect(ws.sent).toEqual([])
    expect(got).toEqual([])
    expect(lost).toEqual([])
  })
})
