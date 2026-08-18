import { describe, expect, it } from 'vitest'
import { MAX_KARTS } from '@tapkart/sim'
import {
  CLIENT_FLAG_RTC_CONNECTED,
  CLIENT_FLAG_READY,
  CLIENT_FLAG_RTC_FAILED,
  CLIENT_FLAG_START_REQUEST,
  CLIENT_FLAG_WEBRTC,
  CLIENT_UPDATE_MAX_BYTES,
  HELLO_MAX_BYTES,
  LOBBY_MAX_BYTES,
  RESYNC_REQUEST_BYTES,
  SERVER_FLAG_CHECKPOINT_NEXT,
  SERVER_FLAG_IS_HOST,
  SERVER_FLAG_RACE_IN_PROGRESS,
  SERVER_FLAG_RELAY_ASSIGNED,
  SERVER_FLAG_RELAY_FIRST,
  START_MAX_BYTES,
  WELCOME_MAX_BYTES,
  decodeClientUpdate,
  decodeHello,
  decodeLobby,
  decodeResyncRequest,
  decodeStart,
  decodeWelcome,
  encodeClientUpdate,
  encodeHello,
  encodeLobby,
  encodeResyncRequest,
  encodeStart,
  encodeWelcome,
} from '../src/lobby'
import type {
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
} from '../src/lobby'

/**
 * Wire order, restated here on purpose rather than imported: these tables are
 * private to lobby.ts, and a test that read the codec's own copy could not fail
 * if that copy were reordered - which is how an enum silently relabels itself on
 * the wire. §3.3 declares them in exactly this order and §3.5 says the index IS
 * the encoding.
 */
const ROLE_ORDER: PeerRole[] = ['host', 'guest']
const JOIN_RESULT_ORDER: JoinResult[] = [
  'ok', 'roomNotFound', 'roomFull', 'roomClosed', 'versionMismatch', 'badRequest', 'rateLimited',
]
const RESYNC_REASON_ORDER: ResyncReason[] = ['lateJoin', 'divergence']

const BUF = 512

/** Encodes into a fresh buffer and returns exactly the bytes written. */
function bytesOf(encode: (out: Uint8Array) => number, size = BUF): Uint8Array {
  const buf = new Uint8Array(size)
  const n = encode(buf)
  expect(n, 'the encoder reported more bytes than the buffer holds').toBeLessThanOrEqual(size)
  return buf.slice(0, n)
}

/**
 * The bit offset of the single bit that differs between two encodings.
 *
 * How every guard test below locates a field, and deliberately not a table of
 * hand-computed offsets: a literal "peerSlot starts at bit 98" would be a second
 * copy of lobby.ts's layout, free to drift in silence - and a test that
 * corrupted the WRONG bits would still see a rejection and pass while proving
 * nothing. Encoding twice with one field moved by one code leaves exactly one
 * bit different, and that bit is the field's least significant one, located by
 * the encoder itself. (Borrowed from packages/protocol/test/enum-codes.test.ts,
 * which introduced the technique.)
 */
function soleDifferingBit(a: Uint8Array, b: Uint8Array): number {
  expect(a.length, 'the two encodings are different lengths').toBe(b.length)
  const bits: number[] = []
  for (let i = 0; i < a.length; i++) {
    const diff = a[i] ^ b[i]
    for (let k = 0; k < 8; k++) if ((diff >> k) & 1) bits.push(i * 8 + k)
  }
  expect(bits, 'moving one field by one code did not move exactly one bit').toHaveLength(1)
  return bits[0]
}

/** Writes `code` LSB-first at `bitOffset`, matching BitWriter's bit order. */
function writeCodeAt(buf: Uint8Array, bitOffset: number, code: number, bits: number): Uint8Array {
  const out = buf.slice()
  for (let i = 0; i < bits; i++) {
    const idx = bitOffset + i
    if ((code >> i) & 1) out[idx >> 3] |= 1 << (idx & 7)
    else out[idx >> 3] &= ~(1 << (idx & 7))
  }
  return out
}

// ---------------------------------------------------------------------------
// Message builders. Every field named, so a widened interface fails to compile
// here rather than defaulting to `undefined` at some later call site.
// ---------------------------------------------------------------------------

const emptySlot = (): WireLobbySlot => ({
  occupied: false, isBot: false, connected: false, ready: false,
  characterIdx: 0, peerSlot: 0, name: '',
})

const emptySlots = (): WireLobbySlot[] => Array.from({ length: MAX_KARTS }, emptySlot)

const baseHello = (over: Partial<HelloMessage> = {}): HelloMessage => ({
  role: 'guest', roomCode: '0ABCD', token: '', characterIdx: 3,
  name: 'Ada', trackId: '', flags: CLIENT_FLAG_WEBRTC, ...over,
})

const baseClientUpdate = (over: Partial<ClientUpdateMessage> = {}): ClientUpdateMessage => ({
  flags: CLIENT_FLAG_READY, characterIdx: 2, name: 'Ada', trackId: 'ring-of-salt', ...over,
})

const baseWelcome = (over: Partial<WelcomeMessage> = {}): WelcomeMessage => ({
  result: 'ok', roomCode: '0ABCD', playerId: 2, token: 'Z9Y8X7W6V5T4',
  hostPlayerId: 0, peerSlot: 7, flags: SERVER_FLAG_IS_HOST, lobbyVersion: 41, ...over,
})

const baseLobby = (over: Partial<LobbyMessage> = {}): LobbyMessage => ({
  lobbyVersion: 41, hostPlayerId: 0, trackId: 'ring-of-salt', slots: emptySlots(), ...over,
})

const baseStart = (over: Partial<StartMessage> = {}): StartMessage => ({
  raceSeed: 0xdeadbeef, trackId: 'ring-of-salt', humanMask: 0b0000_0101,
  characterIdx: [0, 1, 2, 3, 4, 5, 6, 7], ...over,
})

const baseResync = (over: Partial<ResyncRequestMessage> = {}): ResyncRequestMessage => ({
  reason: 'lateJoin', lastTick: 1234, ...over,
})

// ===========================================================================
// EXACT BYTES. The anchor for every layout claim in this file.
// ===========================================================================

describe('exact wire bytes', () => {
  /**
   * Each fixture below sets every field to the largest value its width allows,
   * so every bit the encoder is entitled to write is 1 and every bit past the
   * last field is 0. That makes the FINAL byte a sub-byte assertion: a field one
   * bit wider changes it and nothing else, which is invisible to a byte-count
   * check and invisible to a round-trip. §3.5's tables are the source; these
   * arrays are what stops the tables and the code drifting apart.
   */

  it('hello: 119 fixed bits, and the tail byte proves it is 119 and not 120', () => {
    // role=guest(1) | hasCode=1 | roomCode 'ZZZZZ' (25x1) | hasToken=1 |
    // token 'ZZZZZZZZZZZZ' (60x1) | characterIdx=15 | flags=0xFFFF |
    // nameLen=0 | trackIdLen=0   ->  119 bits, 15 bytes
    const bytes = bytesOf((out) => encodeHello(out, {
      role: 'guest', roomCode: 'ZZZZZ', token: 'ZZZZZZZZZZZZ',
      characterIdx: 15, name: '', trackId: '', flags: 0xffff,
    }))
    expect(Array.from(bytes)).toEqual([
      0xfd, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
      0xff, 0xff, 0xff, 0xff, 0xff, 0x1f, 0x00,
    ])
  })

  it('clientUpdate: 30 fixed bits', () => {
    // flags=0xFFFF | characterIdx=15 | nameLen=0 | trackIdLen=0  ->  30 bits, 4 bytes
    const bytes = bytesOf((out) => encodeClientUpdate(out, {
      flags: 0xffff, characterIdx: 15, name: '', trackId: '',
    }))
    expect(Array.from(bytes)).toEqual([0xff, 0xff, 0x0f, 0x00])
  })

  it('welcome: 138 bits, fixed - there is no variable-length field in it at all', () => {
    // result=ok(0) | roomCode 'ZZZZZ' | playerId=7 (wire 8) | hasToken=1 |
    // token 'ZZZZZZZZZZZZ' | hostPlayerId=7 (wire 8) | peerSlot=254 |
    // flags=0xFFFF | lobbyVersion=0xFFFF  ->  138 bits, 18 bytes
    const bytes = bytesOf((out) => encodeWelcome(out, {
      result: 'ok', roomCode: 'ZZZZZ', playerId: 7, token: 'ZZZZZZZZZZZZ',
      hostPlayerId: 7, peerSlot: 254, flags: 0xffff, lobbyVersion: 0xffff,
    }))
    expect(Array.from(bytes)).toEqual([
      0xf0, 0xff, 0xff, 0x1f, 0xff, 0xff, 0xff, 0xff, 0xff,
      0xff, 0xff, 0x3f, 0xfa, 0xff, 0xff, 0xff, 0xff, 0x03,
    ])
  })

  it('lobby: 193 fixed bits, which is a 21-bit slot stride repeated eight times', () => {
    // lobbyVersion=0xFFFF | hostPlayerId=7 (wire 8) | trackIdLen=0 |
    // 8 x { occupied,isBot,connected,ready = 1, characterIdx=15, peerSlot=254,
    //       nameLen=0 }  ->  25 + 8x21 = 193 bits, 25 bytes
    const slot = (): WireLobbySlot => ({
      occupied: true, isBot: true, connected: true, ready: true,
      characterIdx: 15, peerSlot: 254, name: '',
    })
    const bytes = bytesOf((out) => encodeLobby(out, {
      lobbyVersion: 0xffff, hostPlayerId: 7, trackId: '',
      slots: Array.from({ length: MAX_KARTS }, slot),
    }))
    expect(Array.from(bytes)).toEqual([
      0xff, 0xff, 0x08, 0xfe, 0xfd, 0xc1, 0xbf, 0x3f, 0xf8, 0xf7, 0x07, 0xff, 0xfe,
      0xe0, 0xdf, 0x1f, 0xfc, 0xfb, 0x83, 0x7f, 0x7f, 0xf0, 0xef, 0x0f, 0x00,
    ])
  })

  it('start: 77 fixed bits', () => {
    // raceSeed=0xFFFFFFFF | trackIdLen=0 | humanMask=0xFF |
    // 8 x characterIdx=15  ->  77 bits, 10 bytes
    const bytes = bytesOf((out) => encodeStart(out, {
      raceSeed: 0xffffffff, trackId: '', humanMask: 0xff,
      characterIdx: [15, 15, 15, 15, 15, 15, 15, 15],
    }))
    expect(Array.from(bytes)).toEqual([
      0xff, 0xff, 0xff, 0xff, 0xe0, 0xff, 0xff, 0xff, 0xff, 0x1f,
    ])
  })

  it('resyncRequest: 34 bits, every one of them accounted for', () => {
    // reason=divergence(1) at bits 0-1 | lastTick=0x01020304 at bits 2-33
    const bytes = bytesOf((out) => encodeResyncRequest(out, {
      reason: 'divergence', lastTick: 0x01020304,
    }))
    expect(Array.from(bytes)).toEqual([0x11, 0x0c, 0x08, 0x04, 0x00])
  })
})

// ===========================================================================
// DERIVED SIZES. §3.7.
// ===========================================================================

describe('every *_MAX_BYTES, derived and measured', () => {
  const NAME16 = 'ABCDEFGHIJKLMNOP'          // 16 ASCII bytes
  const TRACK24 = 'abcdefghijklmnopqrstuvwx' // 24 ASCII bytes

  it('states the six constants at their contract values', () => {
    expect(HELLO_MAX_BYTES).toBe(55)
    expect(CLIENT_UPDATE_MAX_BYTES).toBe(44)
    expect(WELCOME_MAX_BYTES).toBe(18)
    expect(LOBBY_MAX_BYTES).toBe(177)
    expect(START_MAX_BYTES).toBe(34)
    expect(RESYNC_REQUEST_BYTES).toBe(5)
  })

  it('encodes a maximal message to exactly its constant, for all six kinds', () => {
    // The measurement §3.7 demands. Not "fits within" - equals. A constant one
    // byte too large wastes nothing anybody notices; one byte too small is a
    // valid-looking message with garbage in its last field and no error at any
    // layer, because BitWriter no-ops past the end of a buffer.
    const maximalSlot = (): WireLobbySlot => ({
      occupied: true, isBot: false, connected: true, ready: true,
      characterIdx: 15, peerSlot: 254, name: NAME16,
    })

    expect(bytesOf((o) => encodeHello(o, {
      role: 'guest', roomCode: 'ZZZZZ', token: 'ZZZZZZZZZZZZ',
      characterIdx: 15, name: NAME16, trackId: TRACK24, flags: 0xffff,
    })).length).toBe(HELLO_MAX_BYTES)

    expect(bytesOf((o) => encodeClientUpdate(o, {
      flags: 0xffff, characterIdx: 15, name: NAME16, trackId: TRACK24,
    })).length).toBe(CLIENT_UPDATE_MAX_BYTES)

    expect(bytesOf((o) => encodeWelcome(o, baseWelcome({
      roomCode: 'ZZZZZ', token: 'ZZZZZZZZZZZZ', playerId: 7, hostPlayerId: 7,
      peerSlot: 254, flags: 0xffff, lobbyVersion: 0xffff,
    }))).length).toBe(WELCOME_MAX_BYTES)

    expect(bytesOf((o) => encodeLobby(o, {
      lobbyVersion: 0xffff, hostPlayerId: 7, trackId: TRACK24,
      slots: Array.from({ length: MAX_KARTS }, maximalSlot),
    })).length).toBe(LOBBY_MAX_BYTES)

    expect(bytesOf((o) => encodeStart(o, {
      raceSeed: 0xffffffff, trackId: TRACK24, humanMask: 0xff,
      characterIdx: [15, 15, 15, 15, 15, 15, 15, 15],
    })).length).toBe(START_MAX_BYTES)

    expect(bytesOf((o) => encodeResyncRequest(o, {
      reason: 'divergence', lastTick: 0xffffffff,
    })).length).toBe(RESYNC_REQUEST_BYTES)
  })

  it('shows what an under-sized buffer actually does, which is why the constant is derived', () => {
    // The failure mode in §3.7, demonstrated rather than described. 128 B is a
    // plausible guess for a lobby message and it is 49 B short.
    const maximalSlot = (): WireLobbySlot => ({
      occupied: true, isBot: false, connected: true, ready: true,
      characterIdx: 15, peerSlot: 254, name: NAME16,
    })
    const msg: LobbyMessage = {
      lobbyVersion: 0xffff, hostPlayerId: 7, trackId: TRACK24,
      slots: Array.from({ length: MAX_KARTS }, maximalSlot),
    }
    const short = new Uint8Array(128)
    // No throw. No short return. The writer reports 177 bytes written into a
    // 128-byte buffer, because a typed-array store past the end is a silent
    // no-op and `byteLength()` counts bits, not stores.
    expect(encodeLobby(short, msg)).toBe(LOBBY_MAX_BYTES)
    // What actually reaches a peer is 128 bytes, and it does not decode.
    expect(() => decodeLobby(short)).toThrow(RangeError)
    // With the derived size it does.
    const full = new Uint8Array(LOBBY_MAX_BYTES)
    encodeLobby(full, msg)
    expect(decodeLobby(full).slots[7].name).toBe(NAME16)
  })
})

// ===========================================================================
// ROUND TRIPS, field by field.
// ===========================================================================

describe('round trips', () => {
  it('hello: both roles, an absent code, an absent token, and every characterIdx', () => {
    const cases: HelloMessage[] = [
      baseHello(),
      // A host CREATING a room: no code yet, and no token because it has never
      // been welcomed. That is what the two presence bits exist for.
      baseHello({ role: 'host', roomCode: '', token: '', name: '', trackId: 'ring-of-salt' }),
      baseHello({ token: 'Z9Y8X7W6V5T4', flags: CLIENT_FLAG_WEBRTC }),
      baseHello({ name: '', flags: 0 }),
      baseHello({ name: '😀😀😀😀', trackId: 'a'.repeat(24) }),
    ]
    for (const msg of cases) {
      expect(decodeHello(bytesOf((o) => encodeHello(o, msg)))).toEqual(msg)
    }
    for (let idx = 0; idx < 16; idx++) {
      const msg = baseHello({ characterIdx: idx })
      expect(decodeHello(bytesOf((o) => encodeHello(o, msg))).characterIdx, `idx ${idx}`).toBe(idx)
    }
  })

  it('clientUpdate: every flag combination that matters, and an empty trackId', () => {
    const flagSets = [
      0,
      CLIENT_FLAG_READY,
      CLIENT_FLAG_START_REQUEST,
      CLIENT_FLAG_RTC_FAILED,
      CLIENT_FLAG_RTC_CONNECTED,
      CLIENT_FLAG_READY | CLIENT_FLAG_START_REQUEST | CLIENT_FLAG_RTC_FAILED,
      0xffff,
    ]
    for (const flags of flagSets) {
      const msg = baseClientUpdate({ flags })
      expect(decodeClientUpdate(bytesOf((o) => encodeClientUpdate(o, msg))), `flags ${flags}`)
        .toEqual(msg)
    }
    // '' = no change (§3.3), and it must survive as '' rather than as a space.
    const noChange = baseClientUpdate({ trackId: '', name: '' })
    expect(decodeClientUpdate(bytesOf((o) => encodeClientUpdate(o, noChange)))).toEqual(noChange)
  })

  it('welcome: every JoinResult, playerId -1, an absent token, peerSlot 1 and 254', () => {
    for (const result of JOIN_RESULT_ORDER) {
      // Everything a rejection carries: no seat, no token, and the sentinel
      // slot. §3.3 fixes playerId at -1 and token at '' unless result is 'ok'.
      const msg = result === 'ok'
        ? baseWelcome({ peerSlot: 1 })
        : baseWelcome({ result, playerId: -1, token: '', peerSlot: 0, hostPlayerId: -1 })
      expect(decodeWelcome(bytesOf((o) => encodeWelcome(o, msg))), result).toEqual(msg)
    }
    for (const peerSlot of [1, 2, 127, 253, 254]) {
      const msg = baseWelcome({ peerSlot })
      expect(decodeWelcome(bytesOf((o) => encodeWelcome(o, msg))).peerSlot, `slot ${peerSlot}`)
        .toBe(peerSlot)
    }
    // lobbyVersion wraps at 65536 and is compared with !== , never < .
    for (const v of [0, 1, 65535]) {
      const msg = baseWelcome({ lobbyVersion: v })
      expect(decodeWelcome(bytesOf((o) => encodeWelcome(o, msg))).lobbyVersion).toBe(v)
    }
  })

  it('lobby: eight occupied slots, empty slots, and no host', () => {
    const slots = emptySlots()
    for (let i = 0; i < MAX_KARTS; i++) {
      slots[i] = {
        occupied: true, isBot: i >= 3, connected: i < 3, ready: i === 1,
        characterIdx: i, peerSlot: i === 0 ? 0 : i + 1, name: `P${i}`,
      }
    }
    const full = baseLobby({ slots })
    expect(decodeLobby(bytesOf((o) => encodeLobby(o, full)))).toEqual(full)

    // Three humans and five empties - §8.1's shape for buildLobbyMessage.
    const partial = emptySlots()
    for (let i = 0; i < 3; i++) {
      partial[i] = {
        occupied: true, isBot: false, connected: true, ready: false,
        characterIdx: i, peerSlot: i + 1, name: `P${i}`,
      }
    }
    const mixed = baseLobby({ slots: partial, hostPlayerId: -1, trackId: '' })
    const back = decodeLobby(bytesOf((o) => encodeLobby(o, mixed)))
    expect(back).toEqual(mixed)
    expect(back.slots.filter((s) => s.occupied)).toHaveLength(3)
    expect(back.hostPlayerId).toBe(-1)
    // Slot index IS playerId. No reordering is legal and there is no playerId
    // field in the slot record to disagree with the index.
    expect(back.slots).toHaveLength(MAX_KARTS)
    expect(back.slots[2].name).toBe('P2')
  })

  it('start: the seed at both ends of u32, and every humanMask bit', () => {
    for (const raceSeed of [0, 1, 0x7fffffff, 0x80000000, 0xffffffff]) {
      const msg = baseStart({ raceSeed })
      expect(decodeStart(bytesOf((o) => encodeStart(o, msg))).raceSeed, `seed ${raceSeed}`)
        .toBe(raceSeed)
    }
    for (let bit = 0; bit < MAX_KARTS; bit++) {
      const msg = baseStart({ humanMask: 1 << bit })
      expect(decodeStart(bytesOf((o) => encodeStart(o, msg))).humanMask, `bit ${bit}`)
        .toBe(1 << bit)
    }
    // humanMask is exactly MAX_KARTS bits wide: bit i set means seat i is a
    // connected human at the moment `start` is sent. createState makes EVERY
    // seat isBot:true/connected:false, so this mask is the only thing that can
    // say otherwise, and a bit that fell off would put a bot on a human's kart.
    expect(MAX_KARTS).toBe(8)
    const all = baseStart({ humanMask: 0xff })
    expect(decodeStart(bytesOf((o) => encodeStart(o, all))).humanMask).toBe(0xff)
    expect(decodeStart(bytesOf((o) => encodeStart(o, all))).characterIdx).toEqual(all.characterIdx)
  })

  it('resyncRequest: both reasons, and lastTick across u32', () => {
    for (const reason of RESYNC_REASON_ORDER) {
      for (const lastTick of [0, 1, 0xffffffff]) {
        const msg = baseResync({ reason, lastTick })
        expect(decodeResyncRequest(bytesOf((o) => encodeResyncRequest(o, msg)))).toEqual(msg)
      }
    }
  })
})

// ===========================================================================
// THE ENUM HOLES, walked at the byte level.
// ===========================================================================

describe('fixed-width enums, across their whole code space', () => {
  it('hello role: accepts 2 codes and REJECTS the other 2 - never decoding as a host', () => {
    // 2 bits, 4 codes, 2 values. §8.1: "role = 2 decodes as badRequest rather
    // than as a host". The codec's half of that is a throw, which is what
    // @tapkart/net's guard turns into a counted drop and what the hub answers
    // with `welcome { result: 'badRequest' }`. The half that must never happen
    // is code 2 arriving and a stranger being seated as the host.
    const base = bytesOf((o) => encodeHello(o, baseHello({ role: 'host' })))
    for (let code = 0; code < 4; code++) {
      const frame = writeCodeAt(base, 0, code, 2)
      if (code < ROLE_ORDER.length) {
        expect(decodeHello(frame).role, `role code ${code}`).toBe(ROLE_ORDER[code])
      } else {
        expect(() => decodeHello(frame), `role code ${code} was accepted`).toThrow(RangeError)
      }
    }
  })

  it('welcome result: accepts 7 codes and REJECTS all 9 unused ones', () => {
    // 4 bits, 16 codes, 7 values - the widest hole in this module. An unused
    // code decoded to `undefined`, which reaches RoomClient's phase machine as
    // the reason a join failed and puts nothing on the screen at all.
    expect(JOIN_RESULT_ORDER).toHaveLength(7)
    const base = bytesOf((o) => encodeWelcome(o, baseWelcome({ result: 'ok', peerSlot: 5 })))
    for (let code = 0; code < 16; code++) {
      const frame = writeCodeAt(base, 0, code, 4)
      if (code < JOIN_RESULT_ORDER.length) {
        expect(decodeWelcome(frame).result, `result code ${code}`).toBe(JOIN_RESULT_ORDER[code])
      } else {
        expect(() => decodeWelcome(frame), `result code ${code} was accepted`).toThrow(RangeError)
      }
    }
  })

  it('resyncRequest reason: accepts 2 codes and REJECTS the other 2', () => {
    const base = bytesOf((o) => encodeResyncRequest(o, baseResync({ reason: 'lateJoin' })))
    for (let code = 0; code < 4; code++) {
      const frame = writeCodeAt(base, 0, code, 2)
      if (code < RESYNC_REASON_ORDER.length) {
        expect(decodeResyncRequest(frame).reason, `reason code ${code}`)
          .toBe(RESYNC_REASON_ORDER[code])
      } else {
        expect(() => decodeResyncRequest(frame), `reason code ${code} was accepted`)
          .toThrow(RangeError)
      }
    }
  })

  it('characterIdx has NO hole at all - 4 bits, 16 codes, 16 values, every one real', () => {
    // The measurement that makes this block an audit rather than a list of
    // fixes. A guard here would be dead code no datagram could reach. If
    // CHARACTER_IDX_BITS is ever narrowed, or the field is ever range-checked
    // against a shorter CHARACTERS table without widening the check to the
    // decoder, THIS loop is what fails. Located at the byte level: in
    // clientUpdate, characterIdx is bits 16-19, the low nibble of byte 2.
    const base = bytesOf((o) => encodeClientUpdate(o, baseClientUpdate({ characterIdx: 0 })))
    const offset = soleDifferingBit(
      base,
      bytesOf((o) => encodeClientUpdate(o, baseClientUpdate({ characterIdx: 1 }))),
    )
    for (let code = 0; code < 16; code++) {
      const frame = writeCodeAt(base, offset, code, 4)
      expect(decodeClientUpdate(frame).characterIdx, `characterIdx code ${code}`).toBe(code)
    }
  })

  it('flags carry every bit through untouched, including ones this build does not define', () => {
    // Deliberately NOT an enum and deliberately unguarded: a flags field whose
    // unknown bits are rejected is a field no future version can add a bit to
    // without breaking every older peer. The ten defined bits are distinct
    // powers of two and the other seven ride through.
    expect([
      CLIENT_FLAG_WEBRTC, CLIENT_FLAG_READY, CLIENT_FLAG_START_REQUEST,
      CLIENT_FLAG_RTC_FAILED, CLIENT_FLAG_RTC_CONNECTED,
    ]).toEqual([1, 2, 4, 8, 16])
    expect([
      SERVER_FLAG_IS_HOST, SERVER_FLAG_RACE_IN_PROGRESS, SERVER_FLAG_RELAY_ASSIGNED,
      SERVER_FLAG_RELAY_FIRST, SERVER_FLAG_CHECKPOINT_NEXT,
    ]).toEqual([1, 2, 4, 8, 16])
    const msg = baseClientUpdate({ flags: 0b1010_1010_1010_1010 })
    expect(decodeClientUpdate(bytesOf((o) => encodeClientUpdate(o, msg))).flags)
      .toBe(0b1010_1010_1010_1010)
  })
})

// ===========================================================================
// THE RESERVED PEER SLOTS, and the lobby's decode-time invariant.
// ===========================================================================

describe('peerSlot, 1..254', () => {
  /** The bit offset of `welcome`'s peerSlot, located by the encoder itself. */
  const welcomeSlotOffset = (): { base: Uint8Array; offset: number } => {
    const a = bytesOf((o) => encodeWelcome(o, baseWelcome({ result: 'roomFull', playerId: -1, token: '', hostPlayerId: -1, peerSlot: 0 })))
    const b = bytesOf((o) => encodeWelcome(o, baseWelcome({ result: 'roomFull', playerId: -1, token: '', hostPlayerId: -1, peerSlot: 1 })))
    return { base: a, offset: soleDifferingBit(a, b) }
  }

  it('rejects 255 on decode, because that is the broadcast slot', () => {
    // 0xff is WS_SLOT_BROADCAST in §4.2's envelope - "fan out to everyone but
    // me". A welcome telling a peer that IT is the broadcast slot makes every
    // datagram it sends address the whole room as itself.
    const { base, offset } = welcomeSlotOffset()
    expect(decodeWelcome(writeCodeAt(base, offset, 254, 8)).peerSlot).toBe(254)
    expect(() => decodeWelcome(writeCodeAt(base, offset, 255, 8))).toThrow(RangeError)
  })

  it('rejects 0 on decode when the join succeeded, because that is the server slot', () => {
    // 0 is WS_SLOT_SERVER - "the room itself". A successful welcome must name a
    // real slot; a REJECTION carries 0, which is the sentinel for "no slot",
    // matching playerId's -1 and token's ''.
    // 2 vs 3, not 1 vs 0: a successful welcome cannot ENCODE peerSlot 0, and
    // 2 -> 3 is the only single-bit move available that keeps the low bit as
    // the one that changes. soleDifferingBit must return the field's LEAST
    // significant bit or writeCodeAt below writes the byte at the wrong offset.
    const okBase = bytesOf((o) => encodeWelcome(o, baseWelcome({ result: 'ok', peerSlot: 2 })))
    const okOffset = soleDifferingBit(
      okBase,
      bytesOf((o) => encodeWelcome(o, baseWelcome({ result: 'ok', peerSlot: 3 }))),
    )
    expect(decodeWelcome(writeCodeAt(okBase, okOffset, 254, 8)).peerSlot).toBe(254)
    expect(() => decodeWelcome(writeCodeAt(okBase, okOffset, 0, 8))).toThrow(RangeError)
    // ...and 0 is fine on a rejection.
    const { base, offset } = welcomeSlotOffset()
    expect(decodeWelcome(writeCodeAt(base, offset, 0, 8)).peerSlot).toBe(0)
  })

  it('rejects both reserved values on encode as well', () => {
    const out = new Uint8Array(BUF)
    expect(() => encodeWelcome(out, baseWelcome({ peerSlot: 255 }))).toThrow(RangeError)
    expect(() => encodeWelcome(out, baseWelcome({ result: 'ok', peerSlot: 0 }))).toThrow(RangeError)
    expect(() => encodeLobby(out, baseLobby({
      slots: emptySlots().map((s, i) => i === 0
        ? { ...s, occupied: true, peerSlot: 255 }
        : s),
    }))).toThrow(RangeError)
  })

  it('lets a lobby slot carry 0, which means the seat has no peer', () => {
    // Not a reserved value here: `WireLobbySlot.peerSlot` is "the transport slot
    // that owns this seat, OR 0 FOR NONE". An occupied bot seat holds 0.
    const slots = emptySlots()
    slots[4] = { occupied: true, isBot: true, connected: false, ready: false, characterIdx: 5, peerSlot: 0, name: '' }
    const msg = baseLobby({ slots })
    expect(decodeLobby(bytesOf((o) => encodeLobby(o, msg))).slots[4].peerSlot).toBe(0)
  })
})

describe('the lobby slot invariant, asserted on decode', () => {
  /**
   * §3.5: "`occupied === false` implies `name === ''`, `ready === false` and
   * `peerSlot === 0`, asserted on decode."
   *
   * Each case is built by encoding a LEGAL message and then clearing slot 3's
   * `occupied` bit, which is the only way to produce a frame the encoder
   * refuses. The bit is located by the encoder, never by a hand-computed offset.
   */
  const occupiedBitOfSlot3 = (): number => {
    const empty = baseLobby()
    const withSlot = baseLobby({
      slots: emptySlots().map((s, i) => (i === 3 ? { ...s, occupied: true } : s)),
    })
    return soleDifferingBit(
      bytesOf((o) => encodeLobby(o, empty)),
      bytesOf((o) => encodeLobby(o, withSlot)),
    )
  }

  it('rejects an unoccupied slot that carries a name', () => {
    const offset = occupiedBitOfSlot3()
    const legal = bytesOf((o) => encodeLobby(o, baseLobby({
      slots: emptySlots().map((s, i) => (i === 3 ? { ...s, occupied: true, name: 'ghost' } : s)),
    })))
    expect(decodeLobby(legal).slots[3].name).toBe('ghost')
    expect(() => decodeLobby(writeCodeAt(legal, offset, 0, 1))).toThrow(RangeError)
  })

  it('rejects an unoccupied slot that is ready', () => {
    const offset = occupiedBitOfSlot3()
    const legal = bytesOf((o) => encodeLobby(o, baseLobby({
      slots: emptySlots().map((s, i) => (i === 3 ? { ...s, occupied: true, ready: true } : s)),
    })))
    expect(() => decodeLobby(writeCodeAt(legal, offset, 0, 1))).toThrow(RangeError)
  })

  it('rejects an unoccupied slot that owns a peer slot', () => {
    // The dangerous one: this field IS the authorised peer -> seat map, and an
    // empty seat that claims a peer is a peer authorised to drive nothing, or
    // worse, to drive a seat the lobby says is free.
    const offset = occupiedBitOfSlot3()
    const legal = bytesOf((o) => encodeLobby(o, baseLobby({
      slots: emptySlots().map((s, i) => (i === 3 ? { ...s, occupied: true, peerSlot: 9 } : s)),
    })))
    expect(() => decodeLobby(writeCodeAt(legal, offset, 0, 1))).toThrow(RangeError)
  })

  it('refuses to encode the same three shapes', () => {
    const out = new Uint8Array(BUF)
    for (const bad of [{ name: 'x' }, { ready: true }, { peerSlot: 2 }]) {
      expect(() => encodeLobby(out, baseLobby({
        slots: emptySlots().map((s, i) => (i === 3 ? { ...s, ...bad } : s)),
      })), JSON.stringify(bad)).toThrow(RangeError)
    }
  })
})

// ===========================================================================
// ENCODE-SIDE REJECTIONS, and untrusted input that must not throw the process.
// ===========================================================================

describe('encode-side range checks', () => {
  it('throws on any value a field cannot hold, rather than writing a wrapped one', () => {
    const out = new Uint8Array(BUF)
    // BitWriter does not clamp or mask, so an out-of-range value silently
    // writes its low bits and every field after it stays put - a message that
    // decodes perfectly into the wrong thing.
    expect(() => encodeHello(out, baseHello({ characterIdx: 16 }))).toThrow(RangeError)
    expect(() => encodeHello(out, baseHello({ characterIdx: -1 }))).toThrow(RangeError)
    expect(() => encodeHello(out, baseHello({ flags: 0x1_0000 }))).toThrow(RangeError)
    expect(() => encodeWelcome(out, baseWelcome({ playerId: 15 }))).toThrow(RangeError)
    expect(() => encodeWelcome(out, baseWelcome({ playerId: -2 }))).toThrow(RangeError)
    expect(() => encodeWelcome(out, baseWelcome({ lobbyVersion: 65_536 }))).toThrow(RangeError)
    expect(() => encodeStart(out, baseStart({ raceSeed: 0x1_0000_0000 }))).toThrow(RangeError)
    expect(() => encodeStart(out, baseStart({ humanMask: 256 }))).toThrow(RangeError)
    expect(() => encodeResyncRequest(out, baseResync({ lastTick: -1 }))).toThrow(RangeError)
    // playerId -1 IS legal - it is how "no host yet" and "no seat" travel.
    expect(() => encodeWelcome(out, baseWelcome({ playerId: -1, result: 'roomFull', token: '', peerSlot: 0 })))
      .not.toThrow()
  })

  it('throws on a malformed room code or session token rather than encoding one', () => {
    const out = new Uint8Array(BUF)
    expect(() => encodeHello(out, baseHello({ roomCode: 'ABCD' }))).toThrow(RangeError)
    expect(() => encodeHello(out, baseHello({ roomCode: 'abcde' }))).toThrow(RangeError)
    expect(() => encodeHello(out, baseHello({ roomCode: 'IBCDE' }))).toThrow(RangeError)
    expect(() => encodeHello(out, baseHello({ token: 'TOOSHORT' }))).toThrow(RangeError)
    // '' is the legal absent value for both, and it is what the presence bits
    // exist to carry.
    expect(() => encodeHello(out, baseHello({ roomCode: '', token: '' }))).not.toThrow()
  })

  it('throws on a slots or characterIdx array that is not MAX_KARTS long', () => {
    const out = new Uint8Array(BUF)
    expect(() => encodeLobby(out, baseLobby({ slots: emptySlots().slice(0, 7) }))).toThrow(RangeError)
    expect(() => encodeStart(out, baseStart({ characterIdx: [0, 1, 2] }))).toThrow(RangeError)
  })

  it('truncates an over-long name instead of overrunning the buffer', () => {
    // The loop §3.7 closes. A 40-byte name arrives from a peer, is stored, and
    // is re-broadcast in every later `lobby` - and the re-encode must still fit
    // in LOBBY_MAX_BYTES.
    const long = 'x'.repeat(40)
    const slots = emptySlots().map((s) => ({ ...s, occupied: true, connected: true, name: long, peerSlot: 1 }))
    const bytes = bytesOf((o) => encodeLobby(o, baseLobby({ slots, trackId: 'y'.repeat(40) })))
    expect(bytes.length).toBeLessThanOrEqual(LOBBY_MAX_BYTES)
    expect(decodeLobby(bytes).slots[0].name).toBe('x'.repeat(16))
    expect(decodeLobby(bytes).trackId).toBe('y'.repeat(24))
  })
})

describe('untrusted input never throws anything but RangeError', () => {
  it('rejects a truncated frame of every kind through BitReader', () => {
    // A clipped datagram must not decode into a well-formed all-zeros message.
    // BitReader's RangeError is what @tapkart/net's createDatagramGuard turns
    // into a counted drop: "a datagram that cannot be decoded is a datagram that
    // never arrived".
    const cases: [string, (b: Uint8Array) => unknown][] = [
      ['hello', decodeHello],
      ['clientUpdate', decodeClientUpdate],
      ['welcome', decodeWelcome],
      ['lobby', decodeLobby],
      ['start', decodeStart],
      ['resyncRequest', decodeResyncRequest],
    ]
    for (const [label, decode] of cases) {
      for (const size of [0, 1, 2]) {
        expect(() => decode(new Uint8Array(size)), `${label} accepted a ${size}-byte frame`)
          .toThrow(RangeError)
      }
    }
  })

  it('decodes an all-zero frame of the right length without throwing', () => {
    // The complement of the test above, and the reason it has to exist: "throws
    // on everything" is not the property being asserted. An all-zero frame is a
    // legal message - role 0, no code, no token, character 0, no flags, no
    // strings - and treating it as malformed would reject the first `hello` a
    // host ever sends.
    const zeroHello = decodeHello(new Uint8Array(HELLO_MAX_BYTES))
    expect(zeroHello.role).toBe('host')
    expect(zeroHello.roomCode).toBe('')
    expect(zeroHello.token).toBe('')
    expect(zeroHello.name).toBe('')
    expect(zeroHello.flags).toBe(0)
    const zeroLobby = decodeLobby(new Uint8Array(LOBBY_MAX_BYTES))
    expect(zeroLobby.hostPlayerId).toBe(-1)
    expect(zeroLobby.slots.every((s) => !s.occupied)).toBe(true)
  })

  it('accepts a name longer than NAME_MAX_BYTES on decode and re-truncates on encode', () => {
    // Deliberately permissive in one direction only. The length field expresses
    // 0..31 and the cap is 16, so a peer one version ahead with a wider name
    // field still joins - and its name is cut to 16 the moment this build
    // re-encodes it, so no message can ever exceed its *_MAX_BYTES.
    const frame = bytesOf((o) => encodeClientUpdate(o, baseClientUpdate({ name: 'A' })))
    expect(decodeClientUpdate(frame).name).toBe('A')
    // Re-encoding a 40-character name yields a 16-byte one, every time.
    const re = bytesOf((o) => encodeClientUpdate(o, baseClientUpdate({ name: 'z'.repeat(40) })))
    expect(decodeClientUpdate(re).name).toBe('z'.repeat(16))
    expect(re.length).toBeLessThanOrEqual(CLIENT_UPDATE_MAX_BYTES)
  })
})
