import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import * as protocol from '../src/index'
import type {
  // types [Task 3]
  ChannelName,
  InputDatagram,
  MessageKind,
  WireEntity,
  WireHeader,
  WireKart,
  WireSnapshot,
  // quant [Task 5]
  EpsilonTable,
  QuantField,
  QuantTable,
  // lobby [Plan 4]
  ClientUpdateMessage,
  HelloMessage,
  JoinResult,
  LobbyMessage,
  PeerRole,
  ResyncReason,
  ResyncRequestMessage,
  StartMessage,
  WelcomeMessage,
  WireLobbySlot,
  // control [Plan 4 Task 6]
  HeartbeatMessage,
} from '../src/index'
import {
  BitWriter,
  EPS,
  INPUT_REDUNDANCY,
  PROTOCOL_VERSION,
  Q,
  WIRE_TAG,
  decodeHeader,
  encodeHeader,
  quantStep,
} from '../src/index'

// The same three bindings straight from their own modules, to prove the barrel
// re-exports them rather than redeclaring anything.
import { BitWriter as BitWriterDirect } from '../src/bits'
import { quantStep as quantStepDirect } from '../src/quant'
import { normalizeRoomCode as normalizeRoomCodeDirect } from '../src/room'

// Every module as a namespace. The per-module expectations below are built from
// THESE and never from the barrel: an ambiguous `export *` is silently DROPPED
// from the ESM namespace object, so a check that derived its expectations from
// the barrel would be inspecting evidence the ambiguity has already destroyed -
// it would report "no clashes" precisely when there is one.
import * as bitsNs from '../src/bits'
import * as checkpointNs from '../src/checkpoint'
import * as controlNs from '../src/control'
import * as eventsNs from '../src/events'
import * as inputNs from '../src/input'
import * as lobbyNs from '../src/lobby'
import * as quantNs from '../src/quant'
import * as roomNs from '../src/room'
import * as snapshotNs from '../src/snapshot'
import * as stringsNs from '../src/strings'
import * as typesNs from '../src/types'

const HERE = dirname(fileURLToPath(import.meta.url)) // packages/protocol/test
const SRC = join(HERE, '..', 'src')

/**
 * THE PUBLIC SURFACE OF @tapkart/protocol, PINNED EXACTLY.
 *
 * packages/protocol/package.json maps "." to src/index.ts, so this list IS what
 * every downstream package - net today, server and game in Plans 3 and 4 - can
 * see. It is written out per module rather than as one flat set on purpose: a
 * flat set cannot tell a name MOVING between modules from a name staying put,
 * and "which module owns this name" is exactly what an `export *` barrel makes
 * invisible at the import site.
 *
 * THE TRAP THIS AVOIDS: a barrel test that asserts "at least N names are
 * exported", or that spot-checks a handful of them, passes unchanged when one
 * name is silently deleted and another added. Every assertion below is an exact
 * set comparison in BOTH directions, so an accidental addition and an accidental
 * removal are equally visible - in a diff of this file, at review time, rather
 * than in a downstream package months later.
 */
const SURFACE: Record<string, string[]> = {
  // [Task 3]
  types: ['PROTOCOL_VERSION', 'WIRE_TAG', 'decodeHeader', 'encodeHeader'],
  // [Task 15c] the room-code family: lobby URLs and the NFC tap payload.
  // [Plan 4] plus the bit-level half and the session token (§3.2).
  room: [
    'CODE_CHAR_BITS',
    'LOBBY_PATH_PREFIX',
    'ROOM_CODE_ALPHABET',
    'ROOM_CODE_BITS',
    'ROOM_CODE_LENGTH',
    'ROOM_CODE_SPACE',
    'SESSION_TOKEN_BITS',
    'SESSION_TOKEN_LENGTH',
    'decodeCodeChars',
    'encodeCodeChars',
    'isValidRoomCode',
    'isValidSessionToken',
    'lobbyPathFor',
    'normalizeRoomCode',
  ],
  // [Task 4]
  bits: ['BitReader', 'BitWriter'],
  // [Plan 4] length-prefixed UTF-8: the only strings on this wire, and the
  // sole owner of the truncation rule every *_MAX_BYTES depends on.
  strings: [
    'NAME_LEN_BITS',
    'NAME_MAX_BYTES',
    'TRACK_ID_LEN_BITS',
    'TRACK_ID_MAX_BYTES',
    'readString',
    'utf8Truncate',
    'writeString',
  ],
  // [Task 5]
  quant: ['EPS', 'Q', 'WORLD_HALF', 'quantStep'],
  // [Task 6]
  snapshot: ['applySnapshotToState', 'decodeSnapshot', 'encodeSnapshot'],
  // [Task 8]
  checkpoint: ['decodeCheckpoint', 'encodeCheckpoint'],
  // [Task 9]
  events: ['decodeEvents', 'encodeEvents'],
  // [Task 10]
  input: ['INPUT_REDUNDANCY', 'decodeInput', 'encodeInput', 'playerIdOfInput'],
  // [Plan 4] the six lobby kinds. Ten flag constants, twelve codecs, six
  // derived body sizes.
  lobby: [
    'CLIENT_FLAG_READY',
    'CLIENT_FLAG_RTC_CONNECTED',
    'CLIENT_FLAG_RTC_FAILED',
    'CLIENT_FLAG_START_REQUEST',
    'CLIENT_FLAG_WEBRTC',
    'CLIENT_UPDATE_MAX_BYTES',
    'HELLO_MAX_BYTES',
    'LOBBY_MAX_BYTES',
    'RESYNC_REQUEST_BYTES',
    'SERVER_FLAG_CHECKPOINT_NEXT',
    'SERVER_FLAG_IS_HOST',
    'SERVER_FLAG_RACE_IN_PROGRESS',
    'SERVER_FLAG_RELAY_ASSIGNED',
    'SERVER_FLAG_RELAY_FIRST',
    'START_MAX_BYTES',
    'WELCOME_MAX_BYTES',
    'decodeClientUpdate',
    'decodeHello',
    'decodeLobby',
    'decodeResyncRequest',
    'decodeStart',
    'decodeWelcome',
    'encodeClientUpdate',
    'encodeHello',
    'encodeLobby',
    'encodeResyncRequest',
    'encodeStart',
    'encodeWelcome',
  ],
  // [Plan 4 Task 6] ping and pong, one codec
  control: ['HEARTBEAT_BYTES', 'decodeHeartbeat', 'encodeHeartbeat'],
}

/** The barrel's `export *` lines, in the order src/index.ts lists them. */
const BARREL_MODULES = [
  'types', 'room', 'bits', 'strings', 'quant', 'snapshot', 'checkpoint', 'events', 'input', 'lobby',
  'control',
]

const NAMESPACES: [string, object][] = [
  ['types', typesNs],
  ['room', roomNs],
  ['bits', bitsNs],
  ['strings', stringsNs],
  ['quant', quantNs],
  ['snapshot', snapshotNs],
  ['checkpoint', checkpointNs],
  ['events', eventsNs],
  ['input', inputNs],
  ['lobby', lobbyNs],
  ['control', controlNs],
]

/**
 * The type-only half of the surface, pinned by the compiler rather than at
 * runtime: types are erased, so they cannot appear in `Object.keys(protocol)`
 * and a runtime test can say nothing about them at all.
 *
 * `Record<keyof T, true>` is what makes this exact in both directions - a type
 * removed from the barrel fails the `import type` above, a type missing from
 * this object fails the Record, and a type here that is not in the union fails
 * as an excess property. All three are `npm run typecheck` errors, and both
 * tsconfigs include test/**\/*.ts, so they are caught by the same command that
 * checks src.
 */
interface ProtocolTypeSurface {
  ChannelName: ChannelName
  MessageKind: MessageKind
  WireHeader: WireHeader
  WireKart: WireKart
  WireEntity: WireEntity
  WireSnapshot: WireSnapshot
  InputDatagram: InputDatagram
  QuantField: QuantField
  QuantTable: QuantTable
  EpsilonTable: EpsilonTable
  PeerRole: PeerRole
  JoinResult: JoinResult
  ResyncReason: ResyncReason
  HelloMessage: HelloMessage
  ClientUpdateMessage: ClientUpdateMessage
  WelcomeMessage: WelcomeMessage
  WireLobbySlot: WireLobbySlot
  LobbyMessage: LobbyMessage
  StartMessage: StartMessage
  ResyncRequestMessage: ResyncRequestMessage
  HeartbeatMessage: HeartbeatMessage
}
const TYPE_SURFACE: Record<keyof ProtocolTypeSurface, true> = {
  ChannelName: true,
  MessageKind: true,
  WireHeader: true,
  WireKart: true,
  WireEntity: true,
  WireSnapshot: true,
  InputDatagram: true,
  QuantField: true,
  QuantTable: true,
  EpsilonTable: true,
  PeerRole: true,
  JoinResult: true,
  ResyncReason: true,
  HelloMessage: true,
  ClientUpdateMessage: true,
  WelcomeMessage: true,
  WireLobbySlot: true,
  LobbyMessage: true,
  StartMessage: true,
  ResyncRequestMessage: true,
  HeartbeatMessage: true,
}

const expectedNames = (): string[] => Object.values(SURFACE).flat().sort()

describe('@tapkart/protocol barrel', () => {
  it('exports exactly this set of runtime names, and no others', () => {
    // The whole point of this file. Not "contains", not "at least" - equality.
    expect(Object.keys(protocol).sort()).toEqual(expectedNames())
  })

  it('sources each name from the module that owns it', () => {
    // Catches the one change an exact FLAT set cannot see: a name moving from
    // one module to another. The barrel would look identical; the module map in
    // the locked contract §3 would not.
    for (const [mod, ns] of NAMESPACES) {
      expect(Object.keys(ns).sort(), `${mod}'s own exports have changed`).toEqual([...SURFACE[mod]].sort())
    }
    // ...and no module was left out of the audit above.
    expect(Object.keys(SURFACE).sort()).toEqual(NAMESPACES.map(([m]) => m).sort())
  })

  it('has no ambiguous re-export', () => {
    // An ambiguous star-export is silently dropped from the ESM namespace and
    // importing it by name is a SyntaxError at the import site, so it must not
    // exist in the first place. Built from the per-module namespaces, which are
    // the only place two colliding names both still exist.
    const owners = new Map<string, string[]>()
    for (const [mod, ns] of NAMESPACES) {
      for (const key of Object.keys(ns)) owners.set(key, [...(owners.get(key) ?? []), mod])
    }
    expect(Array.from(owners.entries()).filter(([, mods]) => mods.length > 1)).toEqual([])
    // The count is the same either way only when nothing was dropped, which is
    // the failure mode the assertion above is blind to on its own.
    expect(owners.size).toBe(Object.keys(protocol).length)
  })

  it('lists every module in src/ exactly once, and no test file', () => {
    const onDisk = readdirSync(SRC)
      .filter((f) => f.endsWith('.ts') && f !== 'index.ts')
      .map((f) => f.slice(0, -3))
      .sort()
    expect(onDisk, 'a module was added to src/ without a line in the barrel').toEqual([...BARREL_MODULES].sort())

    const barrel = readFileSync(join(SRC, 'index.ts'), 'utf8')
    for (const name of BARREL_MODULES) {
      const line = `export * from './${name}'`
      expect(barrel, `barrel is missing ${line}`).toContain(line)
      expect(barrel.split(line).length - 1, `${line} appears more than once`).toBe(1)
    }
    // Nothing outside src/ can be re-exported: a relative escape is how a test
    // fixture ends up in the game bundle.
    expect(barrel, 'the barrel re-exports something from outside src/').not.toMatch(/export \* from '\.\.?\/\.\./)
    expect(barrel.match(/export \* from/g) ?? [], 'the barrel has an export line this test does not know about')
      .toHaveLength(BARREL_MODULES.length)
  })

  it('pins the type-only surface at compile time', () => {
    // The assertion is the `Record<keyof ProtocolTypeSurface, true>` above; this
    // only proves the pin is reachable and non-empty rather than a dead
    // declaration the compiler skipped.
    expect(Object.keys(TYPE_SURFACE).sort()).toEqual([
      'ChannelName', 'ClientUpdateMessage', 'EpsilonTable', 'HeartbeatMessage', 'HelloMessage', 'InputDatagram',
      'JoinResult', 'LobbyMessage', 'MessageKind', 'PeerRole', 'QuantField', 'QuantTable',
      'ResyncReason', 'ResyncRequestMessage', 'StartMessage', 'WelcomeMessage', 'WireEntity',
      'WireHeader', 'WireKart', 'WireLobbySlot', 'WireSnapshot',
    ])
  })

  it("re-exports each module's own binding, not a copy", () => {
    expect(quantStep).toBe(quantStepDirect)
    expect(BitWriter).toBe(BitWriterDirect)
    expect(protocol.normalizeRoomCode).toBe(normalizeRoomCodeDirect)
  })

  it('carries the contract constants through unchanged', () => {
    expect(PROTOCOL_VERSION).toBe(2)
    expect(INPUT_REDUNDANCY).toBe(8)
    // Every net loop dispatches on these, so a barrel forwarding a stale copy
    // would desynchronise host, client and shadow with no other symptom. All
    // thirteen, by value: `clientUpdate` and `resyncRequest` are Task 15c's
    // additions and each took the next free slot in its own nibble group, so a
    // reordering that moved an existing tag would fail here.
    expect(WIRE_TAG).toEqual({
      hello: 0x01, welcome: 0x02, lobby: 0x03, start: 0x04, clientUpdate: 0x05,
      input: 0x10, snapshot: 0x11, events: 0x12, checkpoint: 0x13, resyncRequest: 0x14,
      authorityChange: 0x20, ping: 0x30, pong: 0x31,
    })
    const hdr = new Uint8Array(2)
    expect(encodeHeader(hdr, 'snapshot')).toBe(2)
    expect(decodeHeader(hdr)).toEqual({ kind: 'snapshot', protocolVersion: PROTOCOL_VERSION })
    // Q and EPS's exact contents belong to Task 5's tests, not this one.
    expect(Object.isFrozen(Q)).toBe(true)
    expect(Object.isFrozen(EPS)).toBe(true)
  })

  it('encodes through the barrel alone', () => {
    const w = new BitWriter(new Uint8Array(8))
    w.writeBits(42, 8)
    expect(w.byteLength()).toBe(1)
    expect(quantStep(0, 1, 10)).toBeCloseTo(1 / 1023, 6)
  })

  it('resolves through the @tapkart/protocol package entry point', async () => {
    // The exact specifier net, server and game use. Dynamic, so a resolution
    // failure fails this one test instead of preventing the file from loading.
    const pkg = await import('@tapkart/protocol')
    expect(Object.keys(pkg).sort()).toEqual(expectedNames())
    expect(pkg.quantStep).toBe(quantStepDirect)
  })
})
