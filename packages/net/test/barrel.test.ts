import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Top-level ESM import, not `require('@tapkart/sim')`: every package here sets
// "type": "module" and Vitest transforms to ESM, where `require` is undefined.
import { createState } from '@tapkart/sim'
import * as net from '../src/index'
import type {
  // clock [Task 15c]
  TickAccumulator,
  // transport [Task 11]
  Transport,
  // socket [Plan 4]
  SocketData,
  SocketLike,
  SocketReadyState,
  // loopback [Task 12]
  LoopbackOptions,
  // client [Tasks 15, 15b]
  RemoteEntitySample,
  RemoteKeyframe,
  RemoteSample,
  // local [Task 15b]
  LocalInputTransport,
  // receive [Task 15b]
  DatagramGuard,
  // wsframe [Plan 4 Task 8]
  WsFrame,
  // websocket [Plan 4 Task 9]
  WebSocketTransport,
  WebSocketTransportOptions,
  // signal [Plan 4 Task 10]
  SignalEnvelope,
  SignalMessage,
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
  // liveness [Plan 4 Task 13]
  LivenessState,
  // fanout [Plan 4 Task 11b]
  FanOutPart,
  FanOutTransport,
  // authz [Plan 4 Task 12]
  PeerAuthority,
  PeerAuthorityDrops,
  // roomclient [Plan 4 Task 14]
  RoomClientOptions,
  RoomClientState,
  RoomClientUpdate,
  RoomPhase,
} from '../src/index'
import {
  AUTHORITY_CHANGE_BYTES,
  HOST_TIMEOUT_MS,
  MAX_CATCHUP_TICKS,
  REMOTE_BUFFER_CAPACITY,
  REMOTE_EXTRAPOLATE_CAP_MS,
  REMOTE_INTERP_DELAY_MS,
  SHADOW_HISTORY_TICKS,
  SNAPSHOT_PERIOD_TICKS,
  ShadowLoop,
  TICK_MS,
  createNullTransport,
  makeTickAccumulator,
} from '../src/index'

import { applyEvent as applyEventDirect } from '../src/apply'
import { advanceAccumulator as advanceAccumulatorDirect } from '../src/clock'
import { ShadowLoop as ShadowLoopDirect } from '../src/shadow'

// Every module as a namespace. The per-module expectations below are built from
// THESE and never from the barrel: an ambiguous `export *` is silently DROPPED
// from the ESM namespace object, so a check that derived its expectations from
// the barrel would be inspecting evidence the ambiguity has already destroyed.
import * as applyNs from '../src/apply'
import * as authzNs from '../src/authz'
import * as authorityNs from '../src/authority'
import * as clientNs from '../src/client'
import * as clockNs from '../src/clock'
import * as fanoutNs from '../src/fanout'
import * as livenessNs from '../src/liveness'
import * as localNs from '../src/local'
import * as loopbackNs from '../src/loopback'
import * as receiveNs from '../src/receive'
import * as roomclientNs from '../src/roomclient'
import * as signalNs from '../src/signal'
import * as shadowNs from '../src/shadow'
import * as socketNs from '../src/socket'
import * as transportNs from '../src/transport'
import * as webrtcNs from '../src/webrtc'
import * as websocketNs from '../src/websocket'
import * as wsframeNs from '../src/wsframe'
// Imported ONLY so this file can assert that not one of their names is
// reachable through the barrel. These two are the only files in `net` that name
// a DOM global.
import * as webrtcBrowserNs from '../src/webrtc-browser'
import * as websocketBrowserNs from '../src/websocket-browser'

// Imported so this file can assert, by name, that not one of them is reachable
// through the barrel. Fixtures shipping in the public surface is how they end up
// in the game bundle.
import * as goldenFixtureNs from './fixtures/golden-net'
import * as meshFixtureNs from './fixtures/mesh'
import * as netFixtureNs from './fixtures/net-fixtures'
import * as rtcFixtureNs from './fixtures/rtc-fixtures'
import * as scriptedFixtureNs from './fixtures/scripted-input'
import * as socketFixtureNs from './fixtures/socket-fixtures'
import * as spyFixtureNs from './fixtures/spy-transport'
import * as conformanceFixtureNs from './fixtures/transport-conformance'
import { makeNetContext } from './fixtures/net-fixtures'

const HERE = dirname(fileURLToPath(import.meta.url)) // packages/net/test
const SRC = join(HERE, '..', 'src')

/**
 * THE PUBLIC SURFACE OF @tapkart/net, PINNED EXACTLY.
 *
 * packages/net/package.json maps "." to src/index.ts, so this list IS what Plan
 * 3's game and Plan 4's server can see. Written per module rather than as one
 * flat set on purpose: a flat set cannot tell a name MOVING between modules from
 * a name staying put, and "which module owns this name" is exactly what an
 * `export *` barrel makes invisible at the import site.
 *
 * THE TRAP THIS AVOIDS: a barrel test that asserts "at least N names are
 * exported", or that spot-checks a handful, passes unchanged when one name is
 * silently deleted and another added. Every assertion below is an exact set
 * comparison in BOTH directions.
 */
const SURFACE: Record<string, string[]> = {
  // [Task 15c] TICK_MS moved here from client.ts (same binding, same barrel
  // surface); Plan 3's game clock and Plan 4's server ticker both reach for
  // advanceAccumulator, which must not come to exist twice.
  clock: ['MAX_CATCHUP_TICKS', 'TICK_MS', 'advanceAccumulator', 'makeTickAccumulator'],
  // [Task 11] Transport is an interface and erased at compile time, so this
  // module contributes NOTHING at runtime - a stronger version of protocol's
  // `types` exception, which at least had constants. The `export *` line is
  // still required and still checked below; it just carries no runtime name.
  transport: [],
  // [Plan 4] the three application close codes. SocketLike, SocketData and
  // SocketReadyState are types and contribute nothing at runtime.
  socket: ['WS_CLOSE_BACKPRESSURE', 'WS_CLOSE_ROOM_CLOSED', 'WS_CLOSE_VERSION_MISMATCH'],
  // [Task 12]
  loopback: ['makeLoopbackPair'],
  // [Task 13]
  apply: ['applyEvent'],
  // [Task 14]
  authority: ['AuthorityLoop', 'isDemoted'],
  // [Tasks 15, 15b] the renderer surface: remote karts and entities are only
  // ever read through the interpolator, never predicted.
  client: [
    'ClientLoop',
    'REMOTE_BUFFER_CAPACITY',
    'REMOTE_EXTRAPOLATE_CAP_MS',
    'REMOTE_INTERP_DELAY_MS',
    'RemoteInterpolator',
    'correctionDeltaOf',
    // [final fix pass, item C] sampleKart/sampleEntity take a caller-owned `out`
    // now, so the package has to say how to make one.
    'makeRemoteEntitySample',
    'makeRemoteSample',
    'remoteInterpolatorOf',
  ],
  // [Task 16] HOST_TIMEOUT_MS, not the HOST_TIMEOUT_TICKS an earlier draft
  // named: Task 15c item C moved host loss onto the scheduler's wall clock,
  // because a loop that has stopped ticking cannot notice with a tick counter.
  shadow: [
    'AUTHORITY_CHANGE_BYTES',
    'HOST_TIMEOUT_MS',
    'SHADOW_HISTORY_TICKS',
    'SNAPSHOT_PERIOD_TICKS',
    'ShadowLoop',
    'decodeAuthorityChange',
    'encodeAuthorityChange',
    // [final fix pass, item H] Plan 4's hub relays the authorityChange and every
    // peer recomputes promotionCursor(raceSeed, promotionTick) from it, so the
    // tick has to be readable from outside the loop.
    'promotionTickOf',
  ],
  // [Task 15b] the host's own input path - nothing else in this package lets a
  // host drive its kart.
  local: ['LOCAL_PEER_ID', 'createNullTransport', 'withLocalInput'],
  // [Task 15b] the datagram guard every loop's onMessage goes through, plus
  // [final fix pass] the wire-cursor plausibility bounds all three loops share.
  // Those are exported rather than kept private because they are protocol
  // facts, not receive-path trivia: Plan 4's server has to know that a peer
  // whose cursor has jumped further than MAX_CURSOR_ADVANCE_TICKS is one that
  // needs a checkpoint rather than another snapshot.
  receive: [
    'MAX_CURSOR_ADVANCE_EVENTS',
    'MAX_CURSOR_ADVANCE_TICKS',
    'MAX_WIRE_TICK',
    'createDatagramGuard',
    'droppedDatagramsOf',
    'eventCursorPlausible',
    'tickCursorPlausible',
  ],
  // [Plan 4 Task 8] the transport's private three-byte envelope.
  wsframe: [
    'WS_CHANNEL_RELIABLE',
    'WS_CHANNEL_UNRELIABLE',
    'WS_CONTROL_PEER_GONE',
    'WS_CONTROL_PEER_JOINED',
    'WS_FRAME_CONTROL',
    'WS_FRAME_DATA',
    'WS_HEADER_BYTES',
    'WS_SLOT_BROADCAST',
    'WS_SLOT_SERVER',
    'byteOfChannel',
    'channelOfByte',
    'decodeWsFrame',
    'encodeWsControl',
    'encodeWsData',
  ],
  // [Plan 4 Task 9] one socket, many peers behind it.
  websocket: ['WS_MAX_BUFFERED_BYTES', 'WS_MAX_RELIABLE_BUFFERED_BYTES', 'makeWebSocketTransport'],
  // [Plan 4 Task 10] JSON over text frames, beside the binary channel.
  signal: ['SIGNAL_MAX_BYTES', 'SIGNAL_VERSION', 'encodeSignal', 'parseSignal'],
  // [Plan 4 Task 11] one link to one peer, pure over RtcConnectionLike.
  webrtc: [
    'DEFAULT_ICE_SERVERS',
    'RTC_CHANNEL_INIT',
    'RTC_CONNECT_TIMEOUT_MS',
    'RTC_QUEUE_MAX',
    'makeWebRtcTransport',
  ],
  // [Plan 4 §4.8] peer liveness only - there is no HostWatch and no hostLost
  // (F-P4-22 puts the one host-loss detector inside ShadowLoop.tick).
  liveness: [
    'PEER_STALE_MS',
    'PING_INTERVAL_MS',
    'createLiveness',
    'isStale',
    'notePacket',
    'notePingSent',
    'notePong',
    'shouldSendPing',
  ],
  // [Plan 4 Task 11b] two transports, one Transport.
  fanout: ['PEER_ID_SEPARATOR', 'makeFanOutTransport', 'scopePeerId', 'splitPeerId'],
  // [Plan 4 §4.7]
  authz: ['peerAuthorityDropsOf', 'withPeerAuthority'],
  // [Plan 4 §4.9]
  roomclient: ['HARD_RESYNC_LIMIT', 'HARD_RESYNC_WINDOW_TICKS', 'RoomClient'],
}

/** The barrel's `export *` lines, in the order src/index.ts lists them. */
const BARREL_MODULES = [
  'clock', 'transport', 'socket', 'loopback', 'apply', 'authority', 'client', 'shadow', 'local', 'receive',
  'wsframe', 'websocket', 'signal', 'webrtc', 'liveness', 'fanout', 'authz', 'roomclient',
]

/**
 * In src/ and DELIBERATELY NOT on the barrel (contract §0, §4.11). Each is an
 * ADAPTER naming a DOM global, and `packages/server` imports this barrel: a
 * `export * from './webrtc-browser'` line would put `RTCPeerConnection` on the
 * import path of a headless Node process. Listed rather than filtered by name
 * pattern, so adding a third one is a decision somebody makes here.
 */
const UNBARRELLED_MODULES = ['webrtc-browser', 'websocket-browser']

const NAMESPACES: [string, object][] = [
  ['clock', clockNs],
  ['transport', transportNs],
  ['socket', socketNs],
  ['loopback', loopbackNs],
  ['apply', applyNs],
  ['authority', authorityNs],
  ['client', clientNs],
  ['shadow', shadowNs],
  ['local', localNs],
  ['receive', receiveNs],
  ['wsframe', wsframeNs],
  ['websocket', websocketNs],
  ['signal', signalNs],
  ['webrtc', webrtcNs],
  ['liveness', livenessNs],
  ['fanout', fanoutNs],
  ['authz', authzNs],
  ['roomclient', roomclientNs],
]

/** Every module under test/, which must contribute nothing to the surface. */
const FIXTURES: [string, object][] = [
  ['fixtures/golden-net', goldenFixtureNs],
  ['fixtures/mesh', meshFixtureNs],
  ['fixtures/net-fixtures', netFixtureNs],
  ['fixtures/rtc-fixtures', rtcFixtureNs],
  ['fixtures/scripted-input', scriptedFixtureNs],
  ['fixtures/socket-fixtures', socketFixtureNs],
  ['fixtures/spy-transport', spyFixtureNs],
  ['fixtures/transport-conformance', conformanceFixtureNs],
]

/**
 * The type-only half, pinned by the compiler: types are erased, so they cannot
 * appear in `Object.keys(net)` and a runtime test can say nothing about them.
 * `Record<keyof T, true>` makes it exact in both directions - a type removed
 * from the barrel fails the `import type` above, a type missing here fails the
 * Record, and a stray one fails as an excess property. All three are
 * `npm run typecheck` errors, since tsconfig.json includes test/**\/*.ts.
 */
interface NetTypeSurface {
  TickAccumulator: TickAccumulator
  Transport: Transport
  SocketData: SocketData
  SocketLike: SocketLike
  SocketReadyState: SocketReadyState
  LoopbackOptions: LoopbackOptions
  RemoteKeyframe: RemoteKeyframe
  RemoteSample: RemoteSample
  RemoteEntitySample: RemoteEntitySample
  LocalInputTransport: LocalInputTransport
  DatagramGuard: DatagramGuard
  WsFrame: WsFrame
  WebSocketTransport: WebSocketTransport
  WebSocketTransportOptions: WebSocketTransportOptions
  SignalEnvelope: SignalEnvelope
  SignalMessage: SignalMessage
  IceCandidateInit: IceCandidateInit
  IceServerConfig: IceServerConfig
  RtcChannelInit: RtcChannelInit
  RtcConnectionFactory: RtcConnectionFactory
  RtcConnectionLike: RtcConnectionLike
  RtcConnectionState: RtcConnectionState
  RtcDataChannelLike: RtcDataChannelLike
  WebRtcTransport: WebRtcTransport
  WebRtcTransportOptions: WebRtcTransportOptions
  FanOutPart: FanOutPart
  FanOutTransport: FanOutTransport
  LivenessState: LivenessState
  PeerAuthority: PeerAuthority
  PeerAuthorityDrops: PeerAuthorityDrops
  RoomPhase: RoomPhase
  RoomClientState: RoomClientState
  RoomClientOptions: RoomClientOptions
  RoomClientUpdate: RoomClientUpdate
}
const TYPE_SURFACE: Record<keyof NetTypeSurface, true> = {
  TickAccumulator: true,
  Transport: true,
  SocketData: true,
  SocketLike: true,
  SocketReadyState: true,
  LoopbackOptions: true,
  RemoteKeyframe: true,
  RemoteSample: true,
  RemoteEntitySample: true,
  LocalInputTransport: true,
  DatagramGuard: true,
  WsFrame: true,
  WebSocketTransport: true,
  WebSocketTransportOptions: true,
  SignalEnvelope: true,
  SignalMessage: true,
  IceCandidateInit: true,
  IceServerConfig: true,
  RtcChannelInit: true,
  RtcConnectionFactory: true,
  RtcConnectionLike: true,
  RtcConnectionState: true,
  RtcDataChannelLike: true,
  WebRtcTransport: true,
  WebRtcTransportOptions: true,
  FanOutPart: true,
  FanOutTransport: true,
  LivenessState: true,
  PeerAuthority: true,
  PeerAuthorityDrops: true,
  RoomPhase: true,
  RoomClientState: true,
  RoomClientOptions: true,
  RoomClientUpdate: true,
}

const expectedNames = (): string[] => Object.values(SURFACE).flat().sort()

describe('@tapkart/net barrel', () => {
  it('exports exactly this set of runtime names, and no others', () => {
    expect(Object.keys(net).sort()).toEqual(expectedNames())
  })

  it('sources each name from the module that owns it', () => {
    for (const [mod, ns] of NAMESPACES) {
      expect(Object.keys(ns).sort(), `${mod}'s own exports have changed`).toEqual([...SURFACE[mod]].sort())
    }
    expect(Object.keys(SURFACE).sort()).toEqual(NAMESPACES.map(([m]) => m).sort())
    // Stated rather than implied: transport.ts really does export nothing at
    // runtime, so the empty list above is a measurement and not an oversight.
    expect(Object.keys(transportNs)).toEqual([])
  })

  it('leaks no test fixture into the public surface', () => {
    // Not a spot-check of two names: EVERY export of EVERY module under test/,
    // enumerated from the fixture modules themselves so a fixture gaining a new
    // export is covered the day it does. A fixture reachable through the barrel
    // is a fixture in Plan 3's game bundle - and golden-net.ts alone drags in
    // node:fs and a 35 KB JSON file.
    const surface = new Set(Object.keys(net))
    for (const [mod, ns] of FIXTURES) {
      const names = Object.keys(ns)
      expect(names.length, `${mod} exports nothing, so this check proves nothing`).toBeGreaterThan(0)
      for (const name of names) {
        expect(surface.has(name), `${mod}.${name} is reachable through the public barrel`).toBe(false)
      }
    }
    // And the barrel cannot reach test/ at all, by construction.
    const barrel = readFileSync(join(SRC, 'index.ts'), 'utf8')
    expect(barrel).not.toMatch(/from '\.\.?\/\.\./)
    expect(barrel).not.toMatch(/fixtures/)
  })

  it('has no ambiguous re-export', () => {
    const owners = new Map<string, string[]>()
    for (const [mod, ns] of NAMESPACES) {
      for (const key of Object.keys(ns)) owners.set(key, [...(owners.get(key) ?? []), mod])
    }
    expect(Array.from(owners.entries()).filter(([, mods]) => mods.length > 1)).toEqual([])
    // An ambiguous name is dropped from the namespace object rather than
    // reported, so the count is what catches a drop the check above cannot see.
    expect(owners.size).toBe(Object.keys(net).length)
  })

  it('lists every module in src/ exactly once, and no test file', () => {
    const onDisk = readdirSync(SRC)
      .filter((f) => f.endsWith('.ts') && f !== 'index.ts')
      .map((f) => f.slice(0, -3))
      .sort()
    expect(onDisk, 'a module was added to src/ without a decision about the barrel')
      .toEqual([...BARREL_MODULES, ...UNBARRELLED_MODULES].sort())

    const barrel = readFileSync(join(SRC, 'index.ts'), 'utf8')
    for (const name of BARREL_MODULES) {
      const line = `export * from './${name}'`
      expect(barrel, `barrel is missing ${line}`).toContain(line)
      expect(barrel.split(line).length - 1, `${line} appears more than once`).toBe(1)
    }
    expect(barrel.match(/export \* from/g) ?? [], 'the barrel has an export line this test does not know about')
      .toHaveLength(BARREL_MODULES.length)
  })

  it('cannot reach a DOM global through the public barrel', () => {
    const surface = new Set(Object.keys(net))
    for (const [mod, ns] of [
      ['webrtc-browser', webrtcBrowserNs],
      ['websocket-browser', websocketBrowserNs],
    ] as [string, object][]) {
      const names = Object.keys(ns)
      expect(names.length, `${mod} exports nothing, so this check proves nothing`).toBeGreaterThan(0)
      for (const name of names) {
        expect(surface.has(name), `${mod}.${name} is reachable through the public barrel`).toBe(false)
      }
      expect(BARREL_MODULES).not.toContain(mod)
    }
    const barrel = readFileSync(join(SRC, 'index.ts'), 'utf8')
    expect(barrel).not.toContain('-browser')
  })

  it('pins the type-only surface at compile time', () => {
    expect(Object.keys(TYPE_SURFACE).sort()).toEqual([
      'DatagramGuard', 'FanOutPart', 'FanOutTransport', 'IceCandidateInit', 'IceServerConfig',
      'LivenessState', 'LocalInputTransport', 'LoopbackOptions', 'PeerAuthority', 'PeerAuthorityDrops',
      'RemoteEntitySample', 'RemoteKeyframe', 'RemoteSample', 'RoomClientOptions', 'RoomClientState',
      'RoomClientUpdate', 'RoomPhase', 'RtcChannelInit', 'RtcConnectionFactory', 'RtcConnectionLike',
      'RtcConnectionState', 'RtcDataChannelLike', 'SignalEnvelope', 'SignalMessage', 'SocketData',
      'SocketLike', 'SocketReadyState', 'TickAccumulator', 'Transport', 'WebRtcTransport',
      'WebRtcTransportOptions', 'WebSocketTransport', 'WebSocketTransportOptions', 'WsFrame',
    ])
  })

  it("re-exports each module's own binding, not a copy", () => {
    expect(ShadowLoop).toBe(ShadowLoopDirect)
    expect(net.applyEvent).toBe(applyEventDirect)
    expect(net.advanceAccumulator).toBe(advanceAccumulatorDirect)
  })

  it('carries the contract constants through unchanged', () => {
    expect(TICK_MS).toBe(1000 / 60)
    expect(MAX_CATCHUP_TICKS).toBe(5)
    expect(HOST_TIMEOUT_MS).toBe(1500) // spec §8: 1.5 s of no snapshot
    expect(SNAPSHOT_PERIOD_TICKS).toBe(3)
    expect(SHADOW_HISTORY_TICKS).toBe(24)
    expect(AUTHORITY_CHANGE_BYTES).toBe(10) // 2-byte shared header + two u32s
    expect(REMOTE_INTERP_DELAY_MS).toBe(100)
    expect(REMOTE_BUFFER_CAPACITY).toBe(8)
    expect(REMOTE_EXTRAPOLATE_CAP_MS).toBe(200)
    // No WIRE_TAG_* here: the message tags belong to @tapkart/protocol
    // (contract §3), and this barrel must not carry a second copy of them.
    expect(Object.keys(net).some((k) => k.startsWith('WIRE_TAG'))).toBe(false)
  })

  it('drives a ShadowLoop and a tick accumulator through the barrel alone', () => {
    const ctx = makeNetContext(false)
    const state = createState(ctx, 0x1, [0, 1, 2, 3, 4, 5, 6, 7])
    const shadow = new ShadowLoop(ctx, state, createNullTransport())
    shadow.tick(0)
    expect(state.tick).toBe(1)

    const acc = makeTickAccumulator()
    expect(net.advanceAccumulator(acc, TICK_MS * 3)).toBe(3)
  })

  it('resolves through the @tapkart/net package entry point', async () => {
    // The exact specifier Plan 3's game and Plan 4's server will use.
    const pkg = await import('@tapkart/net')
    expect(Object.keys(pkg).sort()).toEqual(expectedNames())
    expect(pkg.applyEvent).toBe(applyEventDirect)
  })
})
