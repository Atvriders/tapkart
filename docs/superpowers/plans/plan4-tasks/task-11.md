### Task 11: `packages/net/src/webrtc.ts` — `WebRtcTransport`, pure over `RtcConnectionLike`

> **Task 11 is split.** §4.5 carries the offer/answer/ICE state machine, the
> channel configuration, the pre-open queue and the two-sided in-memory fixture —
> enough for one task. §4.6's fan-out is **Task 11b** (`task-11b.md`) and is
> independent of this file: it consumes `Transport` and nothing from here.

**Files:**
- Create: `packages/net/src/webrtc.ts`
- Create: `packages/net/test/fixtures/rtc-fixtures.ts`
- Create: `packages/net/test/webrtc.test.ts`
- Modify: `packages/net/src/index.ts` (one `export *` line)
- Modify: `packages/net/test/barrel.test.ts` (the pinned public surface)
- Test: `packages/net/test/webrtc.test.ts`

**This module is PURE** (contract §0a) and it is the specific failure the whole
purity rule exists to prevent: *a `WebRtcTransport` that can only be exercised by
opening two browsers.* It never names `RTCPeerConnection`. It takes an
`RtcConnectionLike`, and the test passes a two-sided in-memory implementation
that completes an offer/answer/ICE exchange in-process, in microseconds, with no
UDP.

**Its adapter is not this task's.** `packages/net/src/webrtc-browser.ts` —
`export const browserRtcFactory: RtcConnectionFactory`, **the only file in the
repository that names `RTCPeerConnection`** — is one of contract §8.2's seven
adapter files. It is never imported by any test, is deliberately absent from the
barrel, and is owner-verified. Nothing here should reference it.

**What CI cannot verify, restated so this task does not overclaim** (§8.3): that
NAT traversal works, that a real STUN server answered, that a symmetric NAT
actually defeated the direct path, or that an unreliable SCTP channel really
drops. `maxRetransmits: 0` is asserted as **configuration**, not as observed
packet loss, and there is deliberately no `node:wrtc`-class integration test
(P4 Q48).

---

**Interfaces:**

**Consumes** — from `@tapkart/protocol` (bare specifier, type-only):

```ts
export type ChannelName = 'unreliable' | 'reliable'
```

**Consumes** — from `./transport` (contract §2.1, quoted exactly):

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

Its six unstated behaviours bind here too (§2.1): `onMessage`/`onPeerLost`
**append**; `broadcast` reaches every peer and never the sender; `send` to an
unknown peer is a **no-op, not a throw**; `close()` is idempotent and afterwards
`peers()` is `[]` with nothing delivered in either direction; delivered `data` is
not retained past the callback.

**Consumes** — from `./signal` (Task 10, **type-only**):

```ts
export type SignalMessage =
  | { t: 'offer'; sdp: string }
  | { t: 'answer'; sdp: string }
  | { t: 'ice'; c: IceCandidateInit }
  | { t: 'iceDone' }
  | { t: 'giveUp'; reason: string }
```

**The cycle is deliberate and type-only in both directions.** `signal.ts`
type-imports `IceCandidateInit` from this file; this file type-imports
`SignalMessage` from `signal.ts`. Both edges are erased (`verbatimModuleSyntax` +
`isolatedModules`; esbuild strips `import type` outright), so there is no runtime
cycle. Practically: **vitest is green with only one of the two present**, and
`tsc` needs both — if Task 10 has not landed, `npx tsc -p packages/net` reports
one `TS2307: Cannot find module './signal'` and nothing else. Run 10 and 11 back
to back. **Do not define `SignalMessage` here** — a second definition makes the
barrel's `export *` ambiguous, and ESM resolves ambiguity by *silently dropping
the name*.

**Produces** — `packages/net/src/webrtc.ts`, exactly fourteen exported names
(contract §4.5, §11's census row `net/webrtc | 14`):

```ts
export type RtcConnectionState = 'new' | 'connecting' | 'connected' | 'disconnected' | 'failed' | 'closed'
export interface RtcChannelInit { ordered: boolean; maxRetransmits: number | null }
export const RTC_CHANNEL_INIT: Readonly<Record<ChannelName, RtcChannelInit>>
export interface IceCandidateInit { candidate: string; sdpMid: string | null; sdpMLineIndex: number | null }
export interface IceServerConfig { urls: string[]; username?: string; credential?: string }
export const DEFAULT_ICE_SERVERS: readonly IceServerConfig[]
export interface RtcDataChannelLike { /* label, send, close, onOpen, onMessage, onClose, readyState, bufferedAmount */ }
export interface RtcConnectionLike { /* the nine methods §4.5 lists */ }
export type RtcConnectionFactory = (iceServers: readonly IceServerConfig[]) => RtcConnectionLike
export interface WebRtcTransportOptions { peerId: string; connection: RtcConnectionLike; role: 'offerer' | 'answerer' }
export interface WebRtcTransport extends Transport {
  onLocalSignal(cb: (msg: SignalMessage) => void): void
  acceptSignal(msg: SignalMessage): void
  connectionState(): RtcConnectionState
  queuedCount(): number
  start(): void
}
export function makeWebRtcTransport(opts: WebRtcTransportOptions): WebRtcTransport
export const RTC_QUEUE_MAX = 64
export const RTC_CONNECT_TIMEOUT_MS = 4000
```

**Produces** — `packages/net/test/fixtures/rtc-fixtures.ts`, at exactly the
signatures contract §9.1 pins:

```ts
export function makeFakeRtcPair(): {
  offerer: RtcConnectionLike; answerer: RtcConnectionLike
  settle(): Promise<void>; failBoth(): void
}
export function makeFakeRtcFactory(): { factory: RtcConnectionFactory; connections(): RtcConnectionLike[] }
```

**Rulings and behaviour fixed by the contract, restated because they are the
task:**

- **F-P4-16 — ship a public STUN default.** `DEFAULT_ICE_SERVERS =
  [{ urls: ['stun:stun.l.google.com:19302'] }]`. An empty default means WebRTC
  succeeds only on the same LAN, so **essentially every real guest falls to the
  WebSocket relay and the server carries the whole race** — that is not a
  conservative default, it is a different product. It is a **third-party endpoint
  contacted at connection time**, overridable with one environment variable
  (`ICE_SERVERS`, §5.2 — another task's) and **documented as such in the README**
  (§10.2 — also another task's; this task ships the constant, not the docs). It
  is not a host detail under §0's rule: a public service address is not anybody's
  infrastructure.
- **F-P4-39 — `RTC_CONNECT_TIMEOUT_MS = 4000`, and this transport does NOT
  enforce it.** `RoomClient` owns the give-up timer (§4.9), because giving up
  means asking the server for a relay, which is a room decision and not a
  transport one. After two consecutive guests fail to reach a host, further
  guests attach over the relay **immediately** and attempt WebRTC in the
  background — that policy lives in the hub and the room client. This file
  exports the number and never reads a clock.
- **P4 Q42 — the GUEST is the offerer, and the OFFERER creates both
  `DataChannel`s**; the answerer receives them through `onDataChannel`. The
  labels **are** the `ChannelName`s. One convention had to be picked, the
  answerer's code path is entirely different, and every task touching WebRTC must
  assume the same one.
- **One `WebRtcTransport` is one link to one peer.** `peers()` returns `[peerId]`
  while connected and `[]` otherwise; eight guests on a host means eight of these
  behind one `FanOutTransport` (Task 11b). Guests never link to guests: the
  topology is a star centred on the host, never a mesh. `broadcast` is `send` to
  that peer.
- **A datagram sent before `readyState() === 'open'` is queued, not dropped**,
  and flushed in send order when the channels open. Bounded at `RTC_QUEUE_MAX`;
  past that, unreliable datagrams are dropped and reliable ones keep queuing.
  This queue is the pre-open case only and is unrelated to §4.3's mailbox: there
  is no back-pressure signal before a channel exists.
- **`onStateChange('failed' | 'closed')` fires `onPeerLost(peerId)` exactly
  once.**

**Four decisions this task makes, which §4.5 leaves to the implementer:**

1. **The queue flushes when BOTH channels are open**, as one FIFO. A per-channel
   flush would reorder the two relative to each other, and a client's first
   inputs would arrive after a snapshot that predates them.
2. **`acceptSignal` buffers ICE candidates that arrive before the remote
   description**, because they routinely do and `addIceCandidate` rejects until
   the description is set. Dropping them yields a transport that connects only
   when the network happens to be fast — the one condition CI can never
   reproduce.
3. **`giveUp` from the far side is surfaced as peer loss.** It is how a host
   learns a guest stopped trying without waiting out a timer it does not own.
4. **Every promise chain has a `.catch`.** Node's default unhandled-rejection
   policy **terminates the process** — the same class of failure as a throw out
   of a socket handler, and equally reachable from a peer that sends a malformed
   SDP. On rejection the transport emits `giveUp` and reports peer loss.

Also: `closed` is set **before** `connection.close()`, so the `'closed'` state
change our own teardown provokes cannot deliver an `onPeerLost` after `close()`
(rule 5).

---

- [ ] **Step 1: Write the failing test**

Create `packages/net/test/fixtures/rtc-fixtures.ts`:

```ts
import type {
  IceCandidateInit,
  IceServerConfig,
  RtcChannelInit,
  RtcConnectionFactory,
  RtcConnectionLike,
  RtcConnectionState,
  RtcDataChannelLike,
} from '../../src/webrtc'

interface FakeChannel extends RtcDataChannelLike {
  readonly init: RtcChannelInit
  peer: FakeChannel | null
  markOpen(): void
  fireOpen(): void
  deliver(data: Uint8Array): void
}

function makeChannel(label: string, init: RtcChannelInit): FakeChannel {
  const openCbs: Array<() => void> = []
  const messageCbs: Array<(data: Uint8Array) => void> = []
  const closeCbs: Array<() => void> = []
  let state: 'connecting' | 'open' | 'closing' | 'closed' = 'connecting'

  const ch: FakeChannel = {
    label,
    init,
    peer: null,
    send(data: Uint8Array): void {
      if (state !== 'open') return
      // A copy, always: the far end is entitled to hold what it is handed, and
      // real SCTP never delivers the sender's own buffer.
      ch.peer?.deliver(data.slice())
    },
    close(): void {
      if (state === 'closed') return
      state = 'closed'
      for (const cb of [...closeCbs]) cb()
    },
    onOpen(cb: () => void): void {
      openCbs.push(cb)
    },
    onMessage(cb: (data: Uint8Array) => void): void {
      messageCbs.push(cb)
    },
    onClose(cb: () => void): void {
      closeCbs.push(cb)
    },
    readyState: () => state,
    // Real SCTP back-pressure is not modelled: this transport's only queue is
    // the pre-open one, and §8.3 records buffered-amount realism as something
    // CI cannot verify either way.
    bufferedAmount: () => 0,
    // Opening is two steps on purpose: BOTH ends of a pair reach 'open' before
    // either application learns. A fixture that fired one end's onOpen while the
    // far end was still 'connecting' would silently discard the first flush -
    // and the pre-open queue is exactly what that flush exists to deliver.
    markOpen(): void {
      if (state === 'connecting') state = 'open'
    },
    fireOpen(): void {
      if (state !== 'open') return
      for (const cb of [...openCbs]) cb()
    },
    deliver(data: Uint8Array): void {
      if (state !== 'open') return
      for (const cb of [...messageCbs]) cb(data)
    },
  }
  return ch
}

interface Side {
  created: FakeChannel[]
  received: FakeChannel[]
  localSet: boolean
  remoteSet: boolean
  candidatesIn: number
  stateCbs: Array<(s: RtcConnectionState) => void>
  dataChannelCbs: Array<(ch: RtcDataChannelLike) => void>
  iceCbs: Array<(c: IceCandidateInit | null) => void>
  closed: boolean
}

function makeSide(): Side {
  return {
    created: [],
    received: [],
    localSet: false,
    remoteSet: false,
    candidatesIn: 0,
    stateCbs: [],
    dataChannelCbs: [],
    iceCbs: [],
    closed: false,
  }
}

function candidateAt(n: number): IceCandidateInit {
  // RFC 5737 documentation address: never a real host.
  return {
    candidate: `candidate:${n} 1 udp 2113937151 192.0.2.${n} 50000 typ host`,
    sdpMid: '0',
    sdpMLineIndex: 0,
  }
}

export function makeFakeRtcPair(): {
  offerer: RtcConnectionLike
  answerer: RtcConnectionLike
  settle(): Promise<void>
  failBoth(): void
} {
  const a = makeSide()
  const b = makeSide()
  let connected = false
  let candidateSeq = 0

  function pairChannels(): void {
    for (const created of a.created) {
      if (b.received.some((ch) => ch.label === created.label)) continue
      const mirror = makeChannel(created.label, created.init)
      b.received.push(mirror)
      created.peer = mirror
      mirror.peer = created
      // ondatachannel fires when the answerer applies the offer that carries
      // the channel; the answerer never creates one itself.
      for (const cb of [...b.dataChannelCbs]) cb(mirror)
    }
  }

  function maybeConnect(): void {
    if (connected || a.closed || b.closed) return
    if (!(a.localSet && a.remoteSet && b.localSet && b.remoteSet)) return
    // BOTH sides must have APPLIED a remote candidate. Without this the pair
    // would connect on descriptions alone and every ICE assertion in the suite
    // would be decorative - the fixture would prove the transport works with
    // the whole candidate exchange deleted.
    if (a.candidatesIn === 0 || b.candidatesIn === 0) return
    connected = true
    for (const cb of [...a.stateCbs]) cb('connected')
    for (const cb of [...b.stateCbs]) cb('connected')
    // One LABEL at a time, both ends of that label together. Two properties,
    // both load-bearing:
    //   - both ends of a pair reach 'open' before either application learns, so
    //     the first flush is not delivered into a channel still 'connecting';
    //   - the two channels do NOT open at the same instant, because they do not
    //     in a browser either - and a transport that flushed its queue on the
    //     FIRST open would silently discard everything addressed to the other
    //     channel. A fixture opening both at once cannot see that bug.
    for (const label of ['unreliable', 'reliable']) {
      const both = [...a.created, ...b.received].filter((ch) => ch.label === label)
      for (const ch of both) ch.markOpen()
      for (const ch of both) ch.fireOpen()
    }
  }

  function emitCandidates(side: Side): void {
    candidateSeq++
    const c = candidateAt(candidateSeq)
    for (const cb of [...side.iceCbs]) cb(c)
    for (const cb of [...side.iceCbs]) cb(null)
  }

  function connectionFor(side: Side, isOfferer: boolean): RtcConnectionLike {
    return {
      createDataChannel(label: string, init: RtcChannelInit): RtcDataChannelLike {
        const ch = makeChannel(label, init)
        side.created.push(ch)
        return ch
      },
      createOffer: () => Promise.resolve('v=0\r\no=- 1 1 IN IP4 192.0.2.1\r\nsdp:offer'),
      createAnswer: () => Promise.resolve('v=0\r\no=- 2 1 IN IP4 192.0.2.2\r\nsdp:answer'),
      setLocalDescription: () => {
        side.localSet = true
        return Promise.resolve().then(() => {
          emitCandidates(side)
          maybeConnect()
        })
      },
      setRemoteDescription: (_sdp: string, type: 'offer' | 'answer') => {
        side.remoteSet = true
        return Promise.resolve().then(() => {
          if (type === 'offer' && !isOfferer) pairChannels()
          maybeConnect()
        })
      },
      addIceCandidate: () => {
        // Rejects before the remote description is set, exactly as a real
        // RTCPeerConnection does - which is what makes the transport's pending
        // candidate buffer load-bearing rather than decorative.
        if (!side.remoteSet) return Promise.reject(new Error('no remote description'))
        side.candidatesIn++
        return Promise.resolve().then(() => {
          maybeConnect()
        })
      },
      onIceCandidate(cb: (c: IceCandidateInit | null) => void): void {
        side.iceCbs.push(cb)
      },
      onDataChannel(cb: (ch: RtcDataChannelLike) => void): void {
        side.dataChannelCbs.push(cb)
      },
      onStateChange(cb: (s: RtcConnectionState) => void): void {
        side.stateCbs.push(cb)
      },
      close(): void {
        if (side.closed) return
        side.closed = true
        for (const cb of [...side.stateCbs]) cb('closed')
      },
    }
  }

  return {
    offerer: connectionFor(a, true),
    answerer: connectionFor(b, false),
    /** Runs the queued promise chain to completion, so a test needs no timers
     *  and no fake clock. Every promise this fixture returns is already
     *  resolved; what takes turns is the transport's own chaining. */
    async settle(): Promise<void> {
      for (let i = 0; i < 64; i++) await Promise.resolve()
    },
    failBoth(): void {
      for (const cb of [...a.stateCbs]) cb('failed')
      for (const cb of [...b.stateCbs]) cb('failed')
    },
  }
}

export function makeFakeRtcFactory(): {
  factory: RtcConnectionFactory
  connections(): RtcConnectionLike[]
} {
  const made: RtcConnectionLike[] = []
  return {
    factory: (_iceServers: readonly IceServerConfig[]): RtcConnectionLike => {
      // One unpaired connection: enough for a composition root to be exercised,
      // never enough to connect. Anything that must actually connect uses
      // makeFakeRtcPair.
      const solo = makeFakeRtcPair().offerer
      made.push(solo)
      return solo
    },
    connections: () => made,
  }
}
```

Create `packages/net/test/webrtc.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { ChannelName } from '@tapkart/protocol'
import { PROTOCOL_VERSION, WIRE_TAG, encodeHeader } from '@tapkart/protocol'
import type { SignalMessage } from '../src/signal'
import type { RtcChannelInit, RtcConnectionLike, WebRtcTransport } from '../src/webrtc'
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

/** Guest offers, host answers (P4 Q42), wired to each other by signalling. */
function makeLink(opts: { relay?: boolean } = {}): Link {
  const pair = makeFakeRtcPair()
  const guest = makeWebRtcTransport({ peerId: 'host', connection: pair.offerer, role: 'offerer' })
  const host = makeWebRtcTransport({ peerId: 'guest1', connection: pair.answerer, role: 'answerer' })

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
    const link = makeLink()
    link.guest.start()
    link.guest.start() // idempotent: a second offer restarts a negotiation already answered
    await link.settle()

    const offers = link.guestSignals.filter((m) => m.t === 'offer')
    expect(offers).toHaveLength(1)

    const answer = link.hostSignals.find((m) => m.t === 'answer')
    if (answer === undefined) throw new Error('no answer')
    link.guest.acceptSignal(answer) // duplicate
    link.host.acceptSignal(answer) // wrong role: the answerer never takes an answer
    link.guest.acceptSignal({ t: 'iceDone' })
    await link.settle()

    // Still up, and still carrying traffic.
    link.guest.broadcast('reliable', datagram('input'))
    expect(link.hostGot).toEqual([['guest1', 'reliable', WIRE_TAG.input]])
    expect(link.guest.connectionState()).toBe('connected')
  })
})

describe('net/webrtc - the pre-open queue', () => {
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
```

**The fixture is the load-bearing part of this task, and three of its properties
are what stop this suite from being decorative:**

- **`maybeConnect` refuses to connect until BOTH sides have applied a remote
  candidate.** Without that clause the pair would connect on descriptions alone,
  and every ICE assertion in the file would pass with the entire candidate
  exchange deleted from the transport.
- **`addIceCandidate` REJECTS before the remote description is set**, exactly as
  a real `RTCPeerConnection` does. That is what makes the transport's pending
  candidate buffer load-bearing; a fixture that accepted candidates at any time
  would let a transport that drops early ones look perfect in CI and fail in the
  field.
- **Channels open one label at a time, both ends of that label together.** Both
  halves matter: opening the two ends at different instants would silently
  discard the first flush (fixture bug), and opening the two *channels* at the
  same instant would hide a transport that flushed its whole queue on the first
  channel's open (transport bug). This exact arrangement was arrived at by
  watching each of those pass.

And in the test proper: **the queue-order assertion compares a three-element
sequence spanning both channels**, because a per-channel flush reorders across
channels and nothing shorter can see it; **the copy test asserts the full byte
array**, since a length check passes against a retained view.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/net/test/webrtc.test.ts`

Expected: FAIL, before any assertion runs, with

```
Error: Cannot find module '../src/webrtc' imported from '<repo>/packages/net/test/webrtc.test.ts'
Caused by: Error: Failed to load url ../src/webrtc (resolved id: ../src/webrtc) ... Does the file exist?
 Test Files  1 failed (1)
```

(The fixture's own `import type ... from '../../src/webrtc'` is erased, so the
failure is reported once, from the test file.)

- [ ] **Step 3: Write the implementation**

Create `packages/net/src/webrtc.ts`:

```ts
import type { ChannelName } from '@tapkart/protocol'
import type { Transport } from './transport'
import type { SignalMessage } from './signal'

/**
 * PURE (contract §0a), and the specific failure §0a exists to prevent: a
 * WebRtcTransport that can only be exercised by opening two browsers. This file
 * never names RTCPeerConnection - it takes an RtcConnectionLike, and the test
 * passes a two-sided in-memory implementation that completes a full
 * offer/answer/ICE exchange in-process, in microseconds, with no UDP.
 *
 * The adapter is packages/net/src/webrtc-browser.ts, the only file in the
 * repository that names RTCPeerConnection: not barrel-exported, never imported
 * by a test, owner-verified.
 */
export type RtcConnectionState =
  | 'new'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'failed'
  | 'closed'

export interface RtcChannelInit {
  ordered: boolean
  maxRetransmits: number | null
}

/**
 * Spec §5's two channels, and the only place their RTC configuration is written.
 * 'unreliable' is ordered:false + maxRetransmits:0 - an SCTP partial-reliability
 * channel, which is what makes a dropped input datagram free. 'reliable' is
 * ordered:true + maxRetransmits:null.
 */
export const RTC_CHANNEL_INIT: Readonly<Record<ChannelName, RtcChannelInit>> = {
  unreliable: { ordered: false, maxRetransmits: 0 },
  reliable: { ordered: true, maxRetransmits: null },
}

export interface IceCandidateInit {
  candidate: string
  sdpMid: string | null
  sdpMLineIndex: number | null
}

export interface IceServerConfig {
  urls: string[]
  username?: string
  credential?: string
}

/**
 * F-P4-16. An empty default means WebRTC succeeds only on the same LAN, so
 * essentially every real guest falls to the WebSocket relay and the server
 * carries the whole race - which discards the entire peer-to-peer architecture
 * and multiplies server cost by the number of guests. That is not a conservative
 * default, it is a different product.
 *
 * This is a THIRD-PARTY ENDPOINT CONTACTED AT CONNECTION TIME. It is documented
 * as such in the README and it is overridable with one environment variable
 * (ICE_SERVERS, §5.2). Disclosure is the answer to the privacy cost, not
 * crippling the transport. It is also not a host detail under §0's rule: it is a
 * public service address, not anybody's infrastructure.
 */
export const DEFAULT_ICE_SERVERS: readonly IceServerConfig[] = [
  { urls: ['stun:stun.l.google.com:19302'] },
]

export interface RtcDataChannelLike {
  readonly label: string
  send(data: Uint8Array): void
  close(): void
  onOpen(cb: () => void): void
  onMessage(cb: (data: Uint8Array) => void): void
  onClose(cb: () => void): void
  readyState(): 'connecting' | 'open' | 'closing' | 'closed'
  bufferedAmount(): number
}

export interface RtcConnectionLike {
  createDataChannel(label: string, init: RtcChannelInit): RtcDataChannelLike
  createOffer(): Promise<string>
  createAnswer(): Promise<string>
  setLocalDescription(sdp: string, type: 'offer' | 'answer'): Promise<void>
  setRemoteDescription(sdp: string, type: 'offer' | 'answer'): Promise<void>
  addIceCandidate(c: IceCandidateInit): Promise<void>
  /** null = gathering done. */
  onIceCandidate(cb: (c: IceCandidateInit | null) => void): void
  onDataChannel(cb: (ch: RtcDataChannelLike) => void): void
  onStateChange(cb: (s: RtcConnectionState) => void): void
  close(): void
}

export type RtcConnectionFactory = (iceServers: readonly IceServerConfig[]) => RtcConnectionLike

export interface WebRtcTransportOptions {
  peerId: string
  connection: RtcConnectionLike
  /** P4 Q42: the GUEST is the offerer, and the OFFERER creates both
   *  DataChannels; the answerer receives them through onDataChannel. One
   *  convention had to be picked, the answerer's code path is entirely
   *  different, and every task touching WebRTC must assume the same one. The
   *  labels are the ChannelNames. */
  role: 'offerer' | 'answerer'
}

export interface WebRtcTransport extends Transport {
  /** Everything this transport wants said to the far side, as data. The caller
   *  posts it over whatever signalling path it has; this module never knows. */
  onLocalSignal(cb: (msg: SignalMessage) => void): void
  /** The far side's signalling, delivered in. Out-of-order and duplicate
   *  messages are tolerated; unknown ones are ignored. */
  acceptSignal(msg: SignalMessage): void
  connectionState(): RtcConnectionState
  /** Datagrams enqueued before both channels opened. Flushed IN ORDER on open. */
  queuedCount(): number
  /** offerer: createOffer + setLocalDescription. answerer: no-op. */
  start(): void
}

export const RTC_QUEUE_MAX = 64
/**
 * F-P4-39. 8 s of black screen before fallback is too long; 4 s is past the
 * point where a working connection would have formed and short enough not to
 * read as broken. The transport does NOT enforce it - RoomClient does, because
 * giving up means asking the server for a relay, which is a room decision and
 * not a transport one. This file reads no clock at all.
 */
export const RTC_CONNECT_TIMEOUT_MS = 4000

interface Queued {
  channel: ChannelName
  data: Uint8Array
}

const CHANNEL_NAMES: ChannelName[] = ['unreliable', 'reliable']

function channelNameOf(label: string): ChannelName | null {
  return label === 'unreliable' || label === 'reliable' ? label : null
}

export function makeWebRtcTransport(opts: WebRtcTransportOptions): WebRtcTransport {
  const { peerId, connection, role } = opts

  const messageCbs: Array<(peerId: string, channel: ChannelName, data: Uint8Array) => void> = []
  const peerLostCbs: Array<(peerId: string) => void> = []
  const signalCbs: Array<(msg: SignalMessage) => void> = []

  const channels: Record<ChannelName, RtcDataChannelLike | null> = { unreliable: null, reliable: null }
  const queue: Queued[] = []
  const pendingCandidates: IceCandidateInit[] = []

  let state: RtcConnectionState = 'new'
  let remoteDescriptionSet = false
  let peerLostFired = false
  let closed = false
  let started = false

  function emitSignal(msg: SignalMessage): void {
    if (closed) return
    for (const cb of [...signalCbs]) cb(msg)
  }

  function firePeerLost(): void {
    // A LOCAL close is not peer loss: `closed` is set before connection.close(),
    // so the 'closed' state change our own teardown provokes cannot deliver a
    // callback after close() (Transport rule 5).
    if (peerLostFired || closed) return
    peerLostFired = true
    for (const cb of [...peerLostCbs]) cb(peerId)
  }

  function bothOpen(): boolean {
    return (
      channels.unreliable !== null &&
      channels.reliable !== null &&
      channels.unreliable.readyState() === 'open' &&
      channels.reliable.readyState() === 'open'
    )
  }

  function flushQueue(): void {
    if (!bothOpen() || queue.length === 0) return
    // ONE FIFO across both channels, drained in send order. A per-channel flush
    // would reorder the two relative to each other, and a client's first inputs
    // would arrive after a snapshot that predates them.
    const pending = queue.splice(0, queue.length)
    for (const q of pending) {
      const ch = channels[q.channel]
      if (ch !== null && ch.readyState() === 'open') ch.send(q.data)
    }
  }

  function bindChannel(ch: RtcDataChannelLike): void {
    const name = channelNameOf(ch.label)
    // The labels ARE the ChannelNames. A channel with any other label is not
    // part of this protocol and is ignored rather than guessed at.
    if (name === null) return
    channels[name] = ch
    ch.onOpen(() => {
      flushQueue()
    })
    ch.onMessage((data) => {
      if (closed) return
      for (const cb of [...messageCbs]) cb(peerId, name, data)
    })
    ch.onClose(() => {
      firePeerLost()
    })
    if (ch.readyState() === 'open') flushQueue()
  }

  function fail(reason: string): void {
    if (closed) return
    emitSignal({ t: 'giveUp', reason })
    firePeerLost()
  }

  function drainCandidates(): void {
    const cands = pendingCandidates.splice(0, pendingCandidates.length)
    for (const c of cands) {
      connection.addIceCandidate(c).catch(() => {
        // A candidate that will not apply costs one path, not the connection:
        // ICE tries the rest. An unhandled rejection, by contrast, terminates
        // the process under Node's default policy.
      })
    }
  }

  connection.onStateChange((s) => {
    state = s
    if (s === 'failed' || s === 'closed') firePeerLost()
  })

  connection.onIceCandidate((c) => {
    if (c === null) emitSignal({ t: 'iceDone' })
    else emitSignal({ t: 'ice', c })
  })

  connection.onDataChannel((ch) => {
    bindChannel(ch)
  })

  if (role === 'offerer') {
    // The OFFERER creates both channels, and it creates them BEFORE the offer:
    // a channel added afterwards is not in the SDP the answerer receives.
    for (const name of CHANNEL_NAMES) {
      bindChannel(connection.createDataChannel(name, RTC_CHANNEL_INIT[name]))
    }
  }

  function enqueueOrSend(channel: ChannelName, data: Uint8Array): void {
    if (closed) return
    const ch = channels[channel]
    if (ch !== null && ch.readyState() === 'open') {
      flushQueue()
      ch.send(data)
      return
    }
    if (queue.length >= RTC_QUEUE_MAX) {
      // Past the bound, unreliable datagrams are dropped and reliable ones keep
      // queuing: a dropped input is free by design, a dropped event breaks
      // eventSeq monotonicity for good.
      if (channel === 'unreliable') return
    }
    // Copied, not retained: the sender's buffer is scratch and this queue can
    // hold for seconds while ICE completes.
    queue.push({ channel, data: data.slice() })
  }

  return {
    send(channel, targetPeerId, data): void {
      // One link, one peer. An unknown peer is a no-op, not a throw.
      if (targetPeerId !== peerId) return
      enqueueOrSend(channel, data)
    },
    broadcast(channel, data): void {
      enqueueOrSend(channel, data)
    },
    onMessage(cb): void {
      messageCbs.push(cb)
    },
    onPeerLost(cb): void {
      peerLostCbs.push(cb)
    },
    peers(): string[] {
      if (closed || peerLostFired) return []
      return state === 'connected' ? [peerId] : []
    },
    close(): void {
      if (closed) return
      closed = true
      queue.length = 0
      pendingCandidates.length = 0
      for (const name of CHANNEL_NAMES) {
        const ch = channels[name]
        if (ch !== null) ch.close()
        channels[name] = null
      }
      connection.close()
    },
    onLocalSignal(cb): void {
      signalCbs.push(cb)
    },
    acceptSignal(msg): void {
      if (closed) return
      switch (msg.t) {
        case 'offer': {
          // Wrong-role signalling is ignored rather than acted on: two offerers
          // would each answer the other and neither would ever connect.
          if (role !== 'answerer') return
          connection
            .setRemoteDescription(msg.sdp, 'offer')
            .then(() => {
              remoteDescriptionSet = true
              drainCandidates()
              return connection.createAnswer()
            })
            .then((sdp) => connection.setLocalDescription(sdp, 'answer').then(() => sdp))
            .then((sdp) => {
              emitSignal({ t: 'answer', sdp })
            })
            .catch(() => {
              fail('answerFailed')
            })
          return
        }
        case 'answer': {
          if (role !== 'offerer') return
          connection
            .setRemoteDescription(msg.sdp, 'answer')
            .then(() => {
              remoteDescriptionSet = true
              drainCandidates()
            })
            .catch(() => {
              fail('answerRejected')
            })
          return
        }
        case 'ice': {
          // Candidates that arrive before the remote description are HELD, not
          // dropped: they routinely do, and addIceCandidate rejects until the
          // description is set. Duplicates and out-of-order messages are
          // tolerated by construction.
          if (!remoteDescriptionSet) {
            pendingCandidates.push(msg.c)
            return
          }
          connection.addIceCandidate(msg.c).catch(() => {})
          return
        }
        case 'iceDone':
          // Nothing to do: gathering finished on the far side, and this side's
          // ICE agent needs no help to notice.
          return
        case 'giveUp':
          // The far side has stopped trying. Surfacing it as peer loss is what
          // lets RoomClient ask the server for a relay instead of waiting out
          // the connect timeout it would otherwise have to.
          firePeerLost()
          return
        default:
          return
      }
    },
    connectionState(): RtcConnectionState {
      return state
    },
    queuedCount(): number {
      return queue.length
    },
    start(): void {
      // Idempotent: a second offer would restart negotiation the far side has
      // already answered.
      if (started || closed || role !== 'offerer') return
      started = true
      connection
        .createOffer()
        .then((sdp) => connection.setLocalDescription(sdp, 'offer').then(() => sdp))
        .then((sdp) => {
          emitSignal({ t: 'offer', sdp })
        })
        .catch(() => {
          fail('offerFailed')
        })
    },
  }
}
```

**Every promise chain above ends in `.catch`, and that is not tidiness.** Node's
default unhandled-rejection policy terminates the process — the same failure
class as a throw out of a socket handler, and reachable from a peer that sends a
malformed SDP. On rejection the transport emits `giveUp` and reports peer loss,
so the room degrades to the relay instead of the process dying.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/net/test/webrtc.test.ts`

Expected: `Test Files  1 passed (1)` / `Tests  15 passed (15)`.

- [ ] **Step 5: Add the module to the barrel, and to the barrel test that pins it**

Skipping this turns `packages/net/test/barrel.test.ts` red with *"a module was
added to src/ without a line in the barrel"*. Sibling tasks edit the same lists —
**insert, never rewrite.** `webrtc-browser.ts` is **not** barrel-exported, ever.

**Task 15 closes this barrel** (contract §4.11) and its list includes this module.
Wiring it here anyway is what keeps `npm test` green *between* tasks: the shipped
barrel test fails the moment a file exists in `src/` with no `export *` line, so
deferring every line to Task 15 leaves the suite red for the whole middle of the
plan. Task 15 then finds this line already present — and its own assertion that
each `export *` line appears **exactly once** is what catches a double-add, so
never add it twice.


In `packages/net/src/index.ts`, append:

```ts
export * from './webrtc'
```

In `packages/net/test/barrel.test.ts`:

```ts
// 1. beside the other namespace imports:
import * as webrtcNs from '../src/webrtc'

// 2. inside `import type { ... } from '../src/index'`:
  // webrtc [Plan 4 Task 11]
  IceCandidateInit,
  IceServerConfig,
  RtcChannelInit,
  RtcConnectionFactory,
  RtcConnectionLike,
  RtcConnectionState,
  RtcDataChannelLike,
  WebRtcTransport,
  WebRtcTransportOptions,

// 3. in SURFACE:
  // [Plan 4 Task 11] one link to one peer, pure over RtcConnectionLike.
  webrtc: [
    'DEFAULT_ICE_SERVERS',
    'RTC_CHANNEL_INIT',
    'RTC_CONNECT_TIMEOUT_MS',
    'RTC_QUEUE_MAX',
    'makeWebRtcTransport',
  ],

// 4. in BARREL_MODULES, in the order index.ts lists them:
  'webrtc'

// 5. in NAMESPACES:
  ['webrtc', webrtcNs],

// 6. in `interface NetTypeSurface` / `const TYPE_SURFACE`, all nine:
  IceCandidateInit / IceServerConfig / RtcChannelInit / RtcConnectionFactory /
  RtcConnectionLike / RtcConnectionState / RtcDataChannelLike /
  WebRtcTransport / WebRtcTransportOptions

// 7. in the sorted literal inside "pins the type-only surface at compile time",
//    all nine, in sorted position.

// 8. in FIXTURES, so the new fixture module is covered by the leak check:
import * as rtcFixtureNs from './fixtures/rtc-fixtures'
  ['fixtures/rtc-fixtures', rtcFixtureNs],
```

- [ ] **Step 6: Verify the package, not just this file**

```bash
npx vitest run packages/net/test/webrtc.test.ts packages/net/test/barrel.test.ts
npx tsc --noEmit -p packages/net/tsconfig.json
npx vitest run
```

**Expected `tsc` result depends on Task 10:** clean if `packages/net/src/signal.ts`
exists, and exactly one `TS2307: Cannot find module './signal'` if it does not.
Any other error is this task's.

- [ ] **Step 7: Commit**

```bash
git add packages/net/src/webrtc.ts packages/net/test/webrtc.test.ts \
        packages/net/test/fixtures/rtc-fixtures.ts \
        packages/net/src/index.ts packages/net/test/barrel.test.ts && \
git commit -m "feat(net): add WebRtcTransport, pure over an injected connection"
```
