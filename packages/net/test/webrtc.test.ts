import { describe, expect, it } from 'vitest'
import type { ChannelName } from '@tapkart/protocol'
import { PROTOCOL_VERSION, WIRE_TAG, encodeHeader } from '@tapkart/protocol'
import type { SignalMessage } from '../src/signal'
import type {
  RtcChannelInit,
  RtcConnectionLike,
  RtcDataChannelLike,
  WebRtcTransport,
} from '../src/webrtc'
import {
  DEFAULT_ICE_SERVERS,
  RTC_CHANNEL_INIT,
  RTC_CONNECT_TIMEOUT_MS,
  RTC_QUEUE_MAX,
  makeWebRtcTransport,
} from '../src/webrtc'
import { makeFakeRtcPair } from './fixtures/rtc-fixtures'

function datagram(kind: 'input' | 'snapshot' | 'events', body: number[] = [0]): Uint8Array {
  const buf = new Uint8Array(2 + body.length)
  const h = encodeHeader(buf, kind)
  buf.set(body, h)
  return buf
}

interface Link {
  guest: WebRtcTransport
  host: WebRtcTransport
  settle(): Promise<void>
  failBoth(): void
  guestGot: Array<[string, ChannelName, number]>
  hostGot: Array<[string, ChannelName, number]>
  guestSignals: SignalMessage[]
  hostSignals: SignalMessage[]
}

function rejectDuplicateRemoteDescriptions(connection: RtcConnectionLike): RtcConnectionLike {
  let calls = 0
  return {
    ...connection,
    setRemoteDescription(sdp, type): Promise<void> {
      if (calls++ > 0) return Promise.reject(new Error('remote description already set'))
      return connection.setRemoteDescription(sdp, type)
    },
  }
}

/** Guest offers, host answers (P4 Q42), wired to each other by signalling. */
function makeLink(opts: { relay?: boolean; rejectDuplicateDescriptions?: boolean } = {}): Link {
  const pair = makeFakeRtcPair()
  const offerer = opts.rejectDuplicateDescriptions
    ? rejectDuplicateRemoteDescriptions(pair.offerer)
    : pair.offerer
  const answerer = opts.rejectDuplicateDescriptions
    ? rejectDuplicateRemoteDescriptions(pair.answerer)
    : pair.answerer
  const guest = makeWebRtcTransport({ peerId: 'host', connection: offerer, role: 'offerer' })
  const host = makeWebRtcTransport({ peerId: 'guest1', connection: answerer, role: 'answerer' })

  const guestSignals: SignalMessage[] = []
  const hostSignals: SignalMessage[] = []
  guest.onLocalSignal((m) => {
    guestSignals.push(m)
    if (opts.relay !== false) host.acceptSignal(m)
  })
  host.onLocalSignal((m) => {
    hostSignals.push(m)
    if (opts.relay !== false) guest.acceptSignal(m)
  })

  const guestGot: Array<[string, ChannelName, number]> = []
  const hostGot: Array<[string, ChannelName, number]> = []
  guest.onMessage((p, c, d) => guestGot.push([p, c, d[0]]))
  host.onMessage((p, c, d) => hostGot.push([p, c, d[0]]))

  return { guest, host, settle: pair.settle, failBoth: pair.failBoth, guestGot, hostGot, guestSignals, hostSignals }
}

function makeManualOpeningConnection(): {
  connection: RtcConnectionLike
  open(channel: ChannelName): void
  sent: Array<[ChannelName, number]>
} {
  interface ManualChannel {
    channel: RtcDataChannelLike
    open(): void
  }

  const channels = new Map<ChannelName, ManualChannel>()
  const sent: Array<[ChannelName, number]> = []

  const connection: RtcConnectionLike = {
    createDataChannel(label): RtcDataChannelLike {
      if (label !== 'unreliable' && label !== 'reliable') throw new Error(`unexpected channel ${label}`)
      const name: ChannelName = label
      const openCbs: Array<() => void> = []
      const messageCbs: Array<(data: Uint8Array) => void> = []
      const closeCbs: Array<() => void> = []
      let state: 'connecting' | 'open' | 'closing' | 'closed' = 'connecting'
      const channel: RtcDataChannelLike = {
        label,
        send(data): void {
          sent.push([name, data[2]])
        },
        close(): void {
          if (state === 'closed') return
          state = 'closed'
          for (const cb of [...closeCbs]) cb()
        },
        onOpen(cb): void {
          openCbs.push(cb)
        },
        onMessage(cb): void {
          messageCbs.push(cb)
        },
        onClose(cb): void {
          closeCbs.push(cb)
        },
        readyState: () => state,
        bufferedAmount: () => 0,
      }
      channels.set(name, {
        channel,
        open(): void {
          state = 'open'
          for (const cb of [...openCbs]) cb()
        },
      })
      return channel
    },
    createOffer: () => Promise.resolve('offer'),
    createAnswer: () => Promise.resolve('answer'),
    setLocalDescription: () => Promise.resolve(),
    setRemoteDescription: () => Promise.resolve(),
    addIceCandidate: () => Promise.resolve(),
    onIceCandidate: () => {},
    onDataChannel: () => {},
    onStateChange: () => {},
    close(): void {
      for (const manual of channels.values()) manual.channel.close()
    },
  }

  return {
    connection,
    open(channel): void {
      const manual = channels.get(channel)
      if (manual === undefined) throw new Error(`missing channel ${channel}`)
      manual.open()
    },
    sent,
  }
}

describe('net/webrtc - configuration that only the wire can be wrong about', () => {
  it('makes the unreliable channel partially reliable and the reliable one ordered', () => {
    // maxRetransmits: 0 is what makes a dropped input datagram free. Asserted as
    // configuration, not as observed loss (§8.3).
    expect(RTC_CHANNEL_INIT.unreliable).toEqual({ ordered: false, maxRetransmits: 0 })
    expect(RTC_CHANNEL_INIT.reliable).toEqual({ ordered: true, maxRetransmits: null })
  })

  it('ships a non-empty public STUN default (F-P4-16)', () => {
    // An empty default means WebRTC succeeds only on the same LAN, so every real
    // guest relays and the server carries the whole race.
    expect(DEFAULT_ICE_SERVERS.length).toBeGreaterThan(0)
    expect(DEFAULT_ICE_SERVERS[0].urls).toEqual(['stun:stun.l.google.com:19302'])
    for (const s of DEFAULT_ICE_SERVERS) {
      for (const u of s.urls) expect(u.startsWith('stun:') || u.startsWith('turn:')).toBe(true)
    }
  })

  it('states the give-up budget the ROOM enforces, not the transport', () => {
    expect(RTC_CONNECT_TIMEOUT_MS).toBe(4000)
    expect(RTC_QUEUE_MAX).toBe(64)
  })
})

describe('net/webrtc - who creates the channels (P4 Q42)', () => {
  it('has the OFFERER create both, with the pinned init, and the answerer create none', async () => {
    const pair = makeFakeRtcPair()
    const offererCalls: Array<[string, RtcChannelInit]> = []
    const answererCalls: Array<[string, RtcChannelInit]> = []
    const spyOn = (
      conn: RtcConnectionLike,
      log: Array<[string, RtcChannelInit]>,
    ): RtcConnectionLike => ({
      ...conn,
      createDataChannel: (label, init) => {
        log.push([label, init])
        return conn.createDataChannel(label, init)
      },
    })

    const guest = makeWebRtcTransport({
      peerId: 'host',
      connection: spyOn(pair.offerer, offererCalls),
      role: 'offerer',
    })
    const host = makeWebRtcTransport({
      peerId: 'guest1',
      connection: spyOn(pair.answerer, answererCalls),
      role: 'answerer',
    })
    guest.onLocalSignal((m) => host.acceptSignal(m))
    host.onLocalSignal((m) => guest.acceptSignal(m))

    // Created BEFORE the offer: a channel added afterwards is not in the SDP
    // the answerer receives, and the answerer's code path is entirely
    // different - so one convention had to be picked and every task touching
    // WebRTC must assume the same one.
    expect(offererCalls).toEqual([
      ['unreliable', RTC_CHANNEL_INIT.unreliable],
      ['reliable', RTC_CHANNEL_INIT.reliable],
    ])
    expect(answererCalls).toEqual([])

    guest.start()
    await pair.settle()

    expect(answererCalls).toEqual([])
    expect(host.connectionState()).toBe('connected')
  })
})

describe('net/webrtc - the offer/answer/ICE exchange, in memory', () => {
  it('brings both channels up and carries datagrams in both directions', async () => {
    const link = makeLink()
    expect(link.guest.connectionState()).toBe('new')

    link.guest.start()
    await link.settle()

    expect(link.guest.connectionState()).toBe('connected')
    expect(link.host.connectionState()).toBe('connected')
    expect(link.guest.peers()).toEqual(['host'])
    expect(link.host.peers()).toEqual(['guest1'])

    // The exchange really happened: an offer, an answer, and candidates.
    expect(link.guestSignals.map((m) => m.t)).toContain('offer')
    expect(link.hostSignals.map((m) => m.t)).toContain('answer')
    expect(link.guestSignals.some((m) => m.t === 'ice')).toBe(true)
    expect(link.hostSignals.some((m) => m.t === 'ice')).toBe(true)

    link.guest.broadcast('unreliable', datagram('input'))
    link.host.send('reliable', 'guest1', datagram('events'))

    expect(link.hostGot).toEqual([['guest1', 'unreliable', WIRE_TAG.input]])
    expect(link.guestGot).toEqual([['host', 'reliable', WIRE_TAG.events]])
  })

  it('holds ICE that arrives before the answer, instead of dropping it', async () => {
    // Candidates routinely arrive first, and addIceCandidate rejects until the
    // remote description is set. A transport that dropped them would connect
    // only when the network happened to be fast, which is the one condition CI
    // can never reproduce.
    const link = makeLink({ relay: false })
    link.guest.start()
    await link.settle()

    const offer = link.guestSignals.find((m) => m.t === 'offer')
    const guestIce = link.guestSignals.filter((m) => m.t === 'ice')
    expect(offer).toBeDefined()
    expect(guestIce.length).toBeGreaterThan(0)
    if (offer === undefined) return

    // Candidates first, offer afterwards: the wrong order on purpose.
    for (const c of guestIce) link.host.acceptSignal(c)
    await link.settle()
    link.host.acceptSignal(offer)
    await link.settle()

    const answer = link.hostSignals.find((m) => m.t === 'answer')
    expect(answer).toBeDefined()
    if (answer === undefined) return
    link.guest.acceptSignal(answer)
    for (const m of link.hostSignals.filter((s) => s.t === 'ice')) link.guest.acceptSignal(m)
    await link.settle()

    expect(link.guest.connectionState()).toBe('connected')
    expect(link.host.connectionState()).toBe('connected')
  })

  it('ignores a duplicate, an unknown and a wrong-role signal without breaking the link', async () => {
    // The wrapper rejects a second setRemoteDescription like a real peer in
    // stable state; the transport must prevent duplicate SDP from reaching it.
    const link = makeLink({ rejectDuplicateDescriptions: true })
    link.guest.start()
    link.guest.start() // idempotent: a second offer restarts a negotiation already answered
    await link.settle()

    const offers = link.guestSignals.filter((m) => m.t === 'offer')
    expect(offers).toHaveLength(1)

    const answer = link.hostSignals.find((m) => m.t === 'answer')
    if (answer === undefined) throw new Error('no answer')
    const offer = link.guestSignals.find((m) => m.t === 'offer')
    if (offer === undefined) throw new Error('no offer')
    link.host.acceptSignal(offer) // duplicate offer
    link.guest.acceptSignal(answer) // duplicate
    link.host.acceptSignal(answer) // wrong role: the answerer never takes an answer
    link.guest.acceptSignal({ t: 'iceDone' })
    await link.settle()

    // Still up, and still carrying traffic.
    link.guest.broadcast('reliable', datagram('input'))
    expect(link.hostGot).toEqual([['guest1', 'reliable', WIRE_TAG.input]])
    expect(link.guest.connectionState()).toBe('connected')
    expect(link.guest.peers()).toEqual(['host'])
    expect(link.host.peers()).toEqual(['guest1'])
    expect(link.guestSignals.some((m) => m.t === 'giveUp')).toBe(false)
    expect(link.hostSignals.some((m) => m.t === 'giveUp')).toBe(false)
  })
})

describe('net/webrtc - the pre-open queue', () => {
  it('keeps queueing while only one channel is open, preserving the global FIFO', () => {
    const manual = makeManualOpeningConnection()
    const transport = makeWebRtcTransport({ peerId: 'host', connection: manual.connection, role: 'offerer' })

    transport.broadcast('reliable', datagram('events', [1]))
    transport.broadcast('unreliable', datagram('input', [2]))
    manual.open('unreliable')
    transport.broadcast('unreliable', datagram('input', [3]))

    // The third datagram has a writable selected channel, but sending it now
    // would overtake the two older entries held for the two-channel FIFO.
    expect(manual.sent).toEqual([])
    expect(transport.queuedCount()).toBe(3)

    manual.open('reliable')
    expect(manual.sent).toEqual([
      ['reliable', 1],
      ['unreliable', 2],
      ['unreliable', 3],
    ])
    expect(transport.queuedCount()).toBe(0)
  })

  it('flushes datagrams sent before open, IN ORDER, across both channels', async () => {
    const link = makeLink()
    link.guest.broadcast('reliable', datagram('events', [1]))
    link.guest.broadcast('unreliable', datagram('input', [2]))
    link.guest.broadcast('reliable', datagram('events', [3]))
    expect(link.guest.queuedCount()).toBe(3)
    expect(link.hostGot).toEqual([])

    link.guest.start()
    await link.settle()

    expect(link.guest.queuedCount()).toBe(0)
    expect(link.hostGot).toEqual([
      ['guest1', 'reliable', WIRE_TAG.events],
      ['guest1', 'unreliable', WIRE_TAG.input],
      ['guest1', 'reliable', WIRE_TAG.events],
    ])
  })

  it('copies what it queues, so a reused send buffer cannot rewrite history', async () => {
    const link = makeLink()
    const bytes: number[][] = []
    link.host.onMessage((_p, _c, d) => bytes.push(Array.from(d)))

    const scratch = datagram('input', [1])
    link.guest.broadcast('unreliable', scratch)
    // The sender reuses this buffer the moment the call returns; a queue holding
    // a VIEW would deliver whatever the last caller wrote, seconds later.
    scratch[2] = 0x63

    link.guest.start()
    await link.settle()

    expect(bytes).toEqual([[WIRE_TAG.input, PROTOCOL_VERSION, 1]])
  })

  it('drops unreliable datagrams past the bound and keeps queuing reliable ones', () => {
    const link = makeLink()
    for (let i = 0; i < RTC_QUEUE_MAX; i++) link.guest.broadcast('unreliable', datagram('input'))
    expect(link.guest.queuedCount()).toBe(RTC_QUEUE_MAX)

    link.guest.broadcast('unreliable', datagram('input'))
    expect(link.guest.queuedCount()).toBe(RTC_QUEUE_MAX)

    link.guest.broadcast('reliable', datagram('events'))
    expect(link.guest.queuedCount()).toBe(RTC_QUEUE_MAX + 1)
  })
})

describe('net/webrtc - losing the peer', () => {
  it('fires onPeerLost exactly once on failure, however many times the state changes', async () => {
    const link = makeLink()
    const lost: string[] = []
    link.guest.onPeerLost((p) => lost.push(p))
    link.guest.start()
    await link.settle()

    link.failBoth()
    link.failBoth()

    expect(lost).toEqual(['host'])
    expect(link.guest.connectionState()).toBe('failed')
    expect(link.guest.peers()).toEqual([])
  })

  it('treats the far side giving up as peer loss', async () => {
    const link = makeLink({ relay: false })
    const lost: string[] = []
    link.host.onPeerLost((p) => lost.push(p))

    link.host.acceptSignal({ t: 'giveUp', reason: 'timeout' })
    await link.settle()

    expect(lost).toEqual(['guest1'])
  })

  it('does NOT report peer loss for a close this side asked for', async () => {
    const link = makeLink()
    const lost: string[] = []
    link.guest.onPeerLost((p) => lost.push(p))
    link.guest.start()
    await link.settle()

    link.guest.close()
    link.guest.close()

    // Rule 5: after close() nothing is delivered in either direction, and that
    // includes callbacks. The connection reporting 'closed' back at us is our
    // own teardown, not the peer vanishing.
    expect(lost).toEqual([])
    expect(link.guest.peers()).toEqual([])

    link.guest.broadcast('reliable', datagram('events'))
    expect(link.guest.queuedCount()).toBe(0)
    expect(link.hostGot).toEqual([])
  })

  it('routes send() to its one peer and no-ops on any other id', async () => {
    const link = makeLink()
    link.guest.start()
    await link.settle()

    link.guest.send('reliable', 'someone-else', datagram('input'))
    expect(link.hostGot).toEqual([])

    link.guest.send('reliable', 'host', datagram('input'))
    expect(link.hostGot).toEqual([['guest1', 'reliable', WIRE_TAG.input]])
  })

  it('appends message listeners rather than replacing them', async () => {
    const link = makeLink()
    const seen: string[] = []
    link.host.onMessage(() => seen.push('first'))
    link.host.onMessage(() => seen.push('second'))
    link.guest.start()
    await link.settle()

    link.guest.broadcast('unreliable', datagram('input'))

    expect(seen).toEqual(['first', 'second'])
  })
})
