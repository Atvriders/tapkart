### Task 5: `packages/protocol/src/lobby.ts` — the six lobby kinds

**Files:**
- Create: `packages/protocol/src/lobby.ts`
- Modify: `packages/protocol/src/index.ts` — one `export *` line
- Modify: `packages/protocol/test/barrel.test.ts` — the surface pin gains one module and ten types
- Test: `packages/protocol/test/lobby.test.ts`

Six message kinds, all reliable, all bit-packed at the precision `snapshot.ts` already uses: `hello`, `clientUpdate`, `welcome`, `lobby`, `start`, `resyncRequest`. This is where a stranger's tap turns into a seat.

**Two things this task must not get wrong.**

**Every `*_MAX_BYTES` is derived, never guessed.** `BitWriter` silently truncates past the end of its buffer — a typed-array write past the end is a no-op that neither throws nor grows. A `lobby` message with eight sixteen-byte names encodes to 177 B; a caller with a 128 B buffer gets a *valid-looking* message whose last two slots are garbage, with no error at any layer. So every one of the six constants is computed from §3.5's tables **and** asserted by a test that builds the maximal message, encodes it, and compares `byteLength()` to the constant. Same discipline as `SNAPSHOT_BUF_BYTES` in `shadow.ts`, which exists because an earlier draft of that file used a figure from a superseded 177-bit kart record.

**Three of these fields are fixed-width enums whose value count is not a power of two, so each has unused codes that decode to `undefined`.** `role` is 2 bits with 2 values, `result` is 4 bits with 7, `reason` is 2 bits with 2. Reject them — never clamp. A clamp manufactures an authoritative fact out of bits already known to be wrong, with no counter moving anywhere; a throw is what `@tapkart/net`'s `createDatagramGuard` turns into a counted, dropped datagram, which is how every other undecodable datagram in this system is already treated. Task 15c's fix round found this exact defect class four times over in the shipped codecs, and `packages/protocol/test/enum-codes.test.ts` is the audit that closed it. The tests below walk each of these three fields' **whole code space at the byte level**, because a round-trip test proves encode and decode agree with each *other*, not that either matches the spec.

**Interfaces:**

- **Consumes** — from Task 3, `packages/protocol/src/strings.ts`:

  ```ts
  export const NAME_MAX_BYTES = 16
  export const TRACK_ID_MAX_BYTES = 24
  export const NAME_LEN_BITS = 5
  export const TRACK_ID_LEN_BITS = 5
  export function utf8Truncate(s: string, maxBytes: number): Uint8Array
  export function writeString(w: BitWriter, bytes: Uint8Array, lenBits: number): void
  export function readString(r: BitReader, lenBits: number): string
  ```

- **Consumes** — from Task 4 and Plan 2, `packages/protocol/src/room.ts`:

  ```ts
  export const ROOM_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
  export const ROOM_CODE_LENGTH = 5
  export const CODE_CHAR_BITS = 5
  export const SESSION_TOKEN_LENGTH = 12
  export function isValidRoomCode(code: string): boolean
  export function isValidSessionToken(raw: string): boolean
  export function encodeCodeChars(w: BitWriter, code: string, length: number): void
  export function decodeCodeChars(r: BitReader, length: number): string
  ```

- **Consumes** — `packages/protocol/src/bits.ts` (shipped) and `@tapkart/sim`:

  ```ts
  export class BitWriter {
    constructor(buf: Uint8Array)
    /** LSB-first. Does NOT clamp or mask; `value` must be in [0, 2**bits - 1].
     *  Silently no-ops past the end of the buffer. */
    writeBits(value: number, bits: number): void
    byteLength(): number   // rounds a partial trailing byte UP
  }
  export class BitReader {
    constructor(buf: Uint8Array)
    /** LSB-first. THROWS RangeError rather than reading past the end. */
    readBits(bits: number): number
  }

  // @tapkart/sim
  export const MAX_KARTS = 8
  ```

- **Consumes** — the framing convention, from `packages/net/src/authority.ts` and `shadow.ts`:

  ```ts
  const h = encodeHeader(this.snapshotBuf, 'snapshot')
  const n = encodeSnapshot(this.snapshotBuf.subarray(h), state, lastInput)
  ```

  **Every codec below encodes a BODY.** The caller writes the 2-byte `[tag, PROTOCOL_VERSION]` header with `encodeHeader` and hands the codec `out.subarray(2)`, exactly as the three shipped loops already do. Every `*_MAX_BYTES` constant is therefore a **body** size; a caller sizing a whole datagram adds 2.

- **Produces** — contract §3.3, exactly 37 exports and not a thirty-eighth (§11's census fixes `protocol/lobby` at 37: ten types, nine flag constants, twelve functions, six size constants).

---

- [ ] **Step 1: Write the failing test**

Create `packages/protocol/test/lobby.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { MAX_KARTS } from '@tapkart/sim'
import {
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
    // without breaking every older peer. The nine defined bits are distinct
    // powers of two and the other seven ride through.
    expect([CLIENT_FLAG_WEBRTC, CLIENT_FLAG_READY, CLIENT_FLAG_START_REQUEST, CLIENT_FLAG_RTC_FAILED])
      .toEqual([1, 2, 4, 8])
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/protocol/test/lobby.test.ts`

Expected: **FAIL**, the file does not collect:

```
Error: Failed to load url ../src/lobby (resolved id: .../packages/protocol/src/lobby) in .../packages/protocol/test/lobby.test.ts. Does the file exist?
```

- [ ] **Step 3: Write the implementation**

Create `packages/protocol/src/lobby.ts`:

```ts
/**
 * The six lobby kinds. PURE: no clock, no socket, no state.
 *
 * Every codec here encodes a BODY. The caller writes the 2-byte
 * [tag, PROTOCOL_VERSION] header with encodeHeader and passes out.subarray(2),
 * exactly as authority.ts and shadow.ts already do for snapshots and events.
 * Every *_MAX_BYTES below is therefore a body size; a caller sizing a whole
 * datagram adds 2.
 *
 * All fields are LSB-first, in §3.5's table order, continuously bit-packed with
 * no per-record padding - exactly like WireSnapshot.
 */

import { MAX_KARTS } from '@tapkart/sim'
import { BitReader, BitWriter } from './bits'
import {
  NAME_LEN_BITS,
  NAME_MAX_BYTES,
  TRACK_ID_LEN_BITS,
  TRACK_ID_MAX_BYTES,
  readString,
  utf8Truncate,
  writeString,
} from './strings'
import {
  CODE_CHAR_BITS,
  ROOM_CODE_LENGTH,
  SESSION_TOKEN_LENGTH,
  decodeCodeChars,
  encodeCodeChars,
  isValidRoomCode,
  isValidSessionToken,
} from './room'

export type PeerRole = 'host' | 'guest'

/**
 * F-P4-11 splits what an earlier draft overloaded onto `hello`. `hello` is JOIN
 * and nothing else; `clientUpdate` is every subsequent declaration - ready
 * toggles, character changes, track choice, start requests, relay fallback.
 *
 * The alternative was one kind carrying six unrelated meanings, which makes
 * every handler distinguish intent by INSPECTING FIELDS of a decoded body
 * rather than by dispatching on the tag byte that exists for exactly that.
 * Contract §13 already ranks the MessageKind -> handler table as a top-4 shared
 * name risk; field-inspection dispatch is how that risk becomes a defect.
 */
export const CLIENT_FLAG_WEBRTC = 1 << 0        // hello only: this peer can attempt WebRTC
export const CLIENT_FLAG_READY = 1 << 1         // clientUpdate: lobby ready toggle
export const CLIENT_FLAG_START_REQUEST = 1 << 2 // clientUpdate, host only; ignored from anyone else
export const CLIENT_FLAG_RTC_FAILED = 1 << 3    // clientUpdate: WebRTC gave up; put me on relay

export const SERVER_FLAG_IS_HOST = 1 << 0
export const SERVER_FLAG_RACE_IN_PROGRESS = 1 << 1
export const SERVER_FLAG_RELAY_ASSIGNED = 1 << 2
export const SERVER_FLAG_RELAY_FIRST = 1 << 3   // F-P4-39: relay now, try WebRTC in the background
export const SERVER_FLAG_CHECKPOINT_NEXT = 1 << 4

export type JoinResult =
  | 'ok' | 'roomNotFound' | 'roomFull' | 'roomClosed'
  | 'versionMismatch' | 'badRequest' | 'rateLimited'

export type ResyncReason = 'lateJoin' | 'divergence'

export interface HelloMessage {
  role: PeerRole
  roomCode: string        // '' when a host is creating a room
  token: string           // '' when this peer has never been welcomed
  characterIdx: number    // 0..15
  name: string            // <= NAME_MAX_BYTES once encoded
  trackId: string         // '' = no opinion; honoured only from the host
  flags: number           // CLIENT_FLAG_WEBRTC
}

export interface ClientUpdateMessage {
  flags: number           // READY | START_REQUEST | RTC_FAILED
  characterIdx: number
  name: string
  trackId: string         // '' = no change
}

export interface WelcomeMessage {
  result: JoinResult
  roomCode: string
  playerId: number        // -1 unless result === 'ok'
  token: string           // '' unless result === 'ok'
  hostPlayerId: number    // -1 when the room has no host yet
  peerSlot: number        // 1..254 on success, 0 on a rejection
  flags: number           // SERVER_FLAG_*
  lobbyVersion: number
}

export interface WireLobbySlot {
  occupied: boolean; isBot: boolean; connected: boolean; ready: boolean
  characterIdx: number
  /**
   * F-P4-15 / P2-R16: the transport slot that owns this seat, or 0 for none.
   * THIS IS THE AUTHORISED PEER -> SEAT MAP, and §5.3's `withPeerAuthority` is
   * the one place it is enforced. Without it the host learns peer -> playerId
   * from the datagram itself and validates nothing, so any peer can seize any
   * seat by sending one input datagram.
   */
  peerSlot: number
  name: string
}

export interface LobbyMessage {
  lobbyVersion: number
  hostPlayerId: number    // -1 when none
  trackId: string
  slots: WireLobbySlot[]  // length MAX_KARTS, index === playerId
}

export interface StartMessage {
  raceSeed: number        // u32
  trackId: string
  humanMask: number       // bit i set === seat i is a connected human at start
  characterIdx: number[]  // length MAX_KARTS
}

export interface ResyncRequestMessage {
  reason: ResyncReason
  lastTick: number        // the newest tick this client believes it holds
}

// ---------------------------------------------------------------------------
// Field widths, in bits, exactly §3.5's tables. Private: a downstream package
// that needed one of these would be re-implementing a codec that already exists.
// ---------------------------------------------------------------------------

const ROLE_BITS = 2
const PRESENCE_BITS = 1          // hasCode, hasToken
const CHARACTER_IDX_BITS = 4
const FLAGS_BITS = 16
const RESULT_BITS = 4
const PLAYER_ID_BITS = 4         // wire = playerId + 1, domain -1..14
const PEER_SLOT_BITS = 8
const LOBBY_VERSION_BITS = 16
const OCCUPIED_BITS = 1
const IS_BOT_BITS = 1
const CONNECTED_BITS = 1
const READY_BITS = 1
const RACE_SEED_BITS = 32
const HUMAN_MASK_BITS = 8        // === MAX_KARTS
const REASON_BITS = 2
const LAST_TICK_BITS = 32

/**
 * The two peer-slot values §4.2's envelope reserves: 0 is WS_SLOT_SERVER ("the
 * room itself") and 255 is WS_SLOT_BROADCAST ("fan out to everyone but me").
 *
 * Restated here rather than imported because `net` depends on `protocol` and
 * not the other way round - the arrow spec §3 fixes. Contract §3.5 and §4.2
 * pin the same two numbers in both places, and a welcome that told a peer it
 * WAS the broadcast slot would make every datagram it sent address the whole
 * room as itself.
 */
const PEER_SLOT_NONE = 0x00
const PEER_SLOT_BROADCAST = 0xff

/**
 * Wire order. THE INDEX IS THE ENCODING - reordering any of these three tables
 * is a different protocol, not a refactor. Declared in §3.3's order.
 */
const ROLE_ORDER: PeerRole[] = ['host', 'guest']
const JOIN_RESULT_ORDER: JoinResult[] = [
  'ok', 'roomNotFound', 'roomFull', 'roomClosed', 'versionMismatch', 'badRequest', 'rateLimited',
]
const RESYNC_REASON_ORDER: ResyncReason[] = ['lateJoin', 'divergence']

/**
 * BitWriter neither clamps nor masks nor reports: writeBits(16, 4) writes the
 * low four bits of 16, which is 0, and every field after it stays exactly where
 * it belongs. The result decodes perfectly into the wrong thing. So every
 * numeric field is range-checked before it is written.
 *
 * An ENCODE-side throw, on data this process produced: a bug, not an attack.
 */
function requireRange(value: number, bits: number, field: string): void {
  const max = 2 ** bits - 1
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new RangeError(`${field}: ${value} does not fit in ${bits} unsigned bits (0..${max})`)
  }
}

/**
 * Writes a code or token, or `length` x CODE_CHAR_BITS zero bits when it is
 * absent. The field is FIXED WIDTH either way - the presence bit says whether
 * to believe it, and the bits are written regardless, which is what keeps
 * `hello`'s head at a constant 119 bits.
 *
 * Zeros are written character by character rather than as one wide writeBits
 * call, so nothing in this file ever asks BitWriter for a 60-bit integer.
 */
function writeCodeOrZero(w: BitWriter, value: string, length: number): void {
  if (value === '') {
    for (let i = 0; i < length; i++) w.writeBits(0, CODE_CHAR_BITS)
    return
  }
  encodeCodeChars(w, value, length)
}

// ---------------------------------------------------------------------------
// hello
// ---------------------------------------------------------------------------

export function encodeHello(out: Uint8Array, msg: HelloMessage): number {
  const w = new BitWriter(out)

  const roleIdx = ROLE_ORDER.indexOf(msg.role)
  if (roleIdx < 0) throw new RangeError(`encodeHello: unknown PeerRole ${String(msg.role)}`)
  w.writeBits(roleIdx, ROLE_BITS)

  const hasCode = msg.roomCode !== ''
  if (hasCode && !isValidRoomCode(msg.roomCode)) {
    throw new RangeError(`encodeHello: '${msg.roomCode}' is not a valid room code`)
  }
  w.writeBits(hasCode ? 1 : 0, PRESENCE_BITS)
  writeCodeOrZero(w, msg.roomCode, ROOM_CODE_LENGTH)

  const hasToken = msg.token !== ''
  if (hasToken && !isValidSessionToken(msg.token)) {
    throw new RangeError(`encodeHello: token is not ${SESSION_TOKEN_LENGTH} canonical characters`)
  }
  w.writeBits(hasToken ? 1 : 0, PRESENCE_BITS)
  writeCodeOrZero(w, msg.token, SESSION_TOKEN_LENGTH)

  requireRange(msg.characterIdx, CHARACTER_IDX_BITS, 'encodeHello: characterIdx')
  w.writeBits(msg.characterIdx, CHARACTER_IDX_BITS)
  requireRange(msg.flags, FLAGS_BITS, 'encodeHello: flags')
  w.writeBits(msg.flags, FLAGS_BITS)

  writeString(w, utf8Truncate(msg.name, NAME_MAX_BYTES), NAME_LEN_BITS)
  writeString(w, utf8Truncate(msg.trackId, TRACK_ID_MAX_BYTES), TRACK_ID_LEN_BITS)

  return w.byteLength()
}

export function decodeHello(buf: Uint8Array): HelloMessage {
  const r = new BitReader(buf)

  const roleIdx = r.readBits(ROLE_BITS)
  if (roleIdx >= ROLE_ORDER.length) {
    // 2 bits, 4 codes, 2 values. REJECTED, never clamped: code 2 decoding as
    // 'host' would seat a stranger as the authority of somebody else's room out
    // of two bits no encoder in this repository can produce.
    throw new RangeError(
      `decodeHello: role code ${roleIdx} is not one of the ${ROLE_ORDER.length} PeerRole values`,
    )
  }
  const role = ROLE_ORDER[roleIdx]

  const hasCode = r.readBits(PRESENCE_BITS) === 1
  const codeChars = decodeCodeChars(r, ROOM_CODE_LENGTH)
  const hasToken = r.readBits(PRESENCE_BITS) === 1
  const tokenChars = decodeCodeChars(r, SESSION_TOKEN_LENGTH)

  const characterIdx = r.readBits(CHARACTER_IDX_BITS)
  const flags = r.readBits(FLAGS_BITS)
  const name = readString(r, NAME_LEN_BITS)
  const trackId = readString(r, TRACK_ID_LEN_BITS)

  return {
    role,
    roomCode: hasCode ? codeChars : '',
    token: hasToken ? tokenChars : '',
    characterIdx,
    name,
    trackId,
    flags,
  }
}

// ---------------------------------------------------------------------------
// clientUpdate
// ---------------------------------------------------------------------------

export function encodeClientUpdate(out: Uint8Array, msg: ClientUpdateMessage): number {
  const w = new BitWriter(out)
  requireRange(msg.flags, FLAGS_BITS, 'encodeClientUpdate: flags')
  w.writeBits(msg.flags, FLAGS_BITS)
  requireRange(msg.characterIdx, CHARACTER_IDX_BITS, 'encodeClientUpdate: characterIdx')
  w.writeBits(msg.characterIdx, CHARACTER_IDX_BITS)
  writeString(w, utf8Truncate(msg.name, NAME_MAX_BYTES), NAME_LEN_BITS)
  writeString(w, utf8Truncate(msg.trackId, TRACK_ID_MAX_BYTES), TRACK_ID_LEN_BITS)
  return w.byteLength()
}

export function decodeClientUpdate(buf: Uint8Array): ClientUpdateMessage {
  const r = new BitReader(buf)
  const flags = r.readBits(FLAGS_BITS)
  // 4 bits, 16 codes, 16 values: this field EXACTLY fills its width, so there
  // is no code to reject and a guard here would be dead code no datagram could
  // reach. Which character a given index names is `content`'s business, not the
  // wire's.
  const characterIdx = r.readBits(CHARACTER_IDX_BITS)
  const name = readString(r, NAME_LEN_BITS)
  const trackId = readString(r, TRACK_ID_LEN_BITS)
  return { flags, characterIdx, name, trackId }
}

// ---------------------------------------------------------------------------
// welcome
// ---------------------------------------------------------------------------

/** Both reserved slots, checked identically on encode and decode. */
function requirePeerSlot(peerSlot: number, isOk: boolean, where: string): void {
  requireRange(peerSlot, PEER_SLOT_BITS, `${where}: peerSlot`)
  if (peerSlot === PEER_SLOT_BROADCAST) {
    throw new RangeError(`${where}: peerSlot ${PEER_SLOT_BROADCAST} is the reserved broadcast slot`)
  }
  if (isOk && peerSlot === PEER_SLOT_NONE) {
    throw new RangeError(`${where}: a successful welcome cannot carry peerSlot ${PEER_SLOT_NONE}`)
  }
}

export function encodeWelcome(out: Uint8Array, msg: WelcomeMessage): number {
  const w = new BitWriter(out)

  const resultIdx = JOIN_RESULT_ORDER.indexOf(msg.result)
  if (resultIdx < 0) throw new RangeError(`encodeWelcome: unknown JoinResult ${String(msg.result)}`)
  w.writeBits(resultIdx, RESULT_BITS)

  if (msg.roomCode !== '' && !isValidRoomCode(msg.roomCode)) {
    throw new RangeError(`encodeWelcome: '${msg.roomCode}' is not a valid room code`)
  }
  writeCodeOrZero(w, msg.roomCode, ROOM_CODE_LENGTH)

  // Biased +1, so -1 travels as 0 - the same scheme AuthEvent.playerId uses.
  requireRange(msg.playerId + 1, PLAYER_ID_BITS, 'encodeWelcome: playerId')
  w.writeBits(msg.playerId + 1, PLAYER_ID_BITS)

  const hasToken = msg.token !== ''
  if (hasToken && !isValidSessionToken(msg.token)) {
    throw new RangeError(`encodeWelcome: token is not ${SESSION_TOKEN_LENGTH} canonical characters`)
  }
  w.writeBits(hasToken ? 1 : 0, PRESENCE_BITS)
  writeCodeOrZero(w, msg.token, SESSION_TOKEN_LENGTH)

  requireRange(msg.hostPlayerId + 1, PLAYER_ID_BITS, 'encodeWelcome: hostPlayerId')
  w.writeBits(msg.hostPlayerId + 1, PLAYER_ID_BITS)

  requirePeerSlot(msg.peerSlot, msg.result === 'ok', 'encodeWelcome')
  w.writeBits(msg.peerSlot, PEER_SLOT_BITS)

  requireRange(msg.flags, FLAGS_BITS, 'encodeWelcome: flags')
  w.writeBits(msg.flags, FLAGS_BITS)
  // Wraps at 65536 and is compared with !== , never < .
  requireRange(msg.lobbyVersion, LOBBY_VERSION_BITS, 'encodeWelcome: lobbyVersion')
  w.writeBits(msg.lobbyVersion, LOBBY_VERSION_BITS)

  return w.byteLength()
}

export function decodeWelcome(buf: Uint8Array): WelcomeMessage {
  const r = new BitReader(buf)

  const resultIdx = r.readBits(RESULT_BITS)
  if (resultIdx >= JOIN_RESULT_ORDER.length) {
    // 4 bits, 16 codes, 7 values - nine unused. An unused code decoded to
    // `undefined` and reached RoomClient as the reason a join failed, which put
    // nothing at all on the screen.
    throw new RangeError(
      `decodeWelcome: result code ${resultIdx} is not one of the ${JOIN_RESULT_ORDER.length} JoinResult values`,
    )
  }
  const result = JOIN_RESULT_ORDER[resultIdx]

  const roomCode = decodeCodeChars(r, ROOM_CODE_LENGTH)
  const playerId = r.readBits(PLAYER_ID_BITS) - 1
  const hasToken = r.readBits(PRESENCE_BITS) === 1
  const tokenChars = decodeCodeChars(r, SESSION_TOKEN_LENGTH)
  const hostPlayerId = r.readBits(PLAYER_ID_BITS) - 1
  const peerSlot = r.readBits(PEER_SLOT_BITS)
  requirePeerSlot(peerSlot, result === 'ok', 'decodeWelcome')
  const flags = r.readBits(FLAGS_BITS)
  const lobbyVersion = r.readBits(LOBBY_VERSION_BITS)

  return {
    result,
    roomCode,
    playerId,
    token: hasToken ? tokenChars : '',
    hostPlayerId,
    peerSlot,
    flags,
    lobbyVersion,
  }
}

// ---------------------------------------------------------------------------
// lobby
// ---------------------------------------------------------------------------

/**
 * §3.5: `occupied === false` implies `name === ''`, `ready === false` and
 * `peerSlot === 0`. Asserted on BOTH sides, because the dangerous half is the
 * decode: `peerSlot` IS the authorised peer -> seat map, and an empty seat that
 * claims a peer is a peer authorised to drive a seat the lobby shows as free.
 */
function requireSlotInvariant(s: WireLobbySlot, i: number, where: string): void {
  requireRange(s.characterIdx, CHARACTER_IDX_BITS, `${where}: slot ${i} characterIdx`)
  requireRange(s.peerSlot, PEER_SLOT_BITS, `${where}: slot ${i} peerSlot`)
  if (s.peerSlot === PEER_SLOT_BROADCAST) {
    throw new RangeError(`${where}: slot ${i} peerSlot ${PEER_SLOT_BROADCAST} is reserved`)
  }
  if (!s.occupied && (s.name !== '' || s.ready || s.peerSlot !== PEER_SLOT_NONE)) {
    throw new RangeError(
      `${where}: slot ${i} is unoccupied but carries a name, a ready flag or a peer slot`,
    )
  }
}

export function encodeLobby(out: Uint8Array, msg: LobbyMessage): number {
  const w = new BitWriter(out)

  requireRange(msg.lobbyVersion, LOBBY_VERSION_BITS, 'encodeLobby: lobbyVersion')
  w.writeBits(msg.lobbyVersion, LOBBY_VERSION_BITS)
  requireRange(msg.hostPlayerId + 1, PLAYER_ID_BITS, 'encodeLobby: hostPlayerId')
  w.writeBits(msg.hostPlayerId + 1, PLAYER_ID_BITS)
  writeString(w, utf8Truncate(msg.trackId, TRACK_ID_MAX_BYTES), TRACK_ID_LEN_BITS)

  // Slot index IS playerId. There is no playerId field in the slot record and no
  // reordering is legal, so a short array is a message that silently renumbers
  // every seat after the gap.
  if (msg.slots.length !== MAX_KARTS) {
    throw new RangeError(`encodeLobby: slots is ${msg.slots.length} long, need ${MAX_KARTS}`)
  }

  for (let i = 0; i < MAX_KARTS; i++) {
    const s = msg.slots[i]
    requireSlotInvariant(s, i, 'encodeLobby')
    w.writeBits(s.occupied ? 1 : 0, OCCUPIED_BITS)
    w.writeBits(s.isBot ? 1 : 0, IS_BOT_BITS)
    w.writeBits(s.connected ? 1 : 0, CONNECTED_BITS)
    w.writeBits(s.ready ? 1 : 0, READY_BITS)
    w.writeBits(s.characterIdx, CHARACTER_IDX_BITS)
    w.writeBits(s.peerSlot, PEER_SLOT_BITS)
    writeString(w, utf8Truncate(s.name, NAME_MAX_BYTES), NAME_LEN_BITS)
  }

  return w.byteLength()
}

export function decodeLobby(buf: Uint8Array): LobbyMessage {
  const r = new BitReader(buf)

  const lobbyVersion = r.readBits(LOBBY_VERSION_BITS)
  const hostPlayerId = r.readBits(PLAYER_ID_BITS) - 1
  const trackId = readString(r, TRACK_ID_LEN_BITS)

  const slots: WireLobbySlot[] = []
  for (let i = 0; i < MAX_KARTS; i++) {
    const occupied = r.readBits(OCCUPIED_BITS) === 1
    const isBot = r.readBits(IS_BOT_BITS) === 1
    const connected = r.readBits(CONNECTED_BITS) === 1
    const ready = r.readBits(READY_BITS) === 1
    const characterIdx = r.readBits(CHARACTER_IDX_BITS)
    const peerSlot = r.readBits(PEER_SLOT_BITS)
    const name = readString(r, NAME_LEN_BITS)
    const slot: WireLobbySlot = { occupied, isBot, connected, ready, characterIdx, peerSlot, name }
    requireSlotInvariant(slot, i, 'decodeLobby')
    slots.push(slot)
  }

  return { lobbyVersion, hostPlayerId, trackId, slots }
}

// ---------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------

export function encodeStart(out: Uint8Array, msg: StartMessage): number {
  const w = new BitWriter(out)

  requireRange(msg.raceSeed, RACE_SEED_BITS, 'encodeStart: raceSeed')
  w.writeBits(msg.raceSeed, RACE_SEED_BITS)
  writeString(w, utf8Truncate(msg.trackId, TRACK_ID_MAX_BYTES), TRACK_ID_LEN_BITS)

  /**
   * Bit i set means seat i is a connected HUMAN at the moment `start` is sent;
   * every clear bit is a bot. This is the only thing that can say so:
   * createState makes every seat isBot:true, connected:false, and nothing in
   * `sim` knows which seats are human. The authority, the shadow and every
   * client must be told identically, or their bot AI drives different karts.
   *
   * A player who is in the room but not "ready" is still a HUMAN seat. A player
   * who joins after `start` takes a bot's seat via late join and the authority
   * flips isBot, which reaches everyone through the snapshot's two bits.
   */
  requireRange(msg.humanMask, HUMAN_MASK_BITS, 'encodeStart: humanMask')
  w.writeBits(msg.humanMask, HUMAN_MASK_BITS)

  if (msg.characterIdx.length !== MAX_KARTS) {
    throw new RangeError(
      `encodeStart: characterIdx is ${msg.characterIdx.length} long, need ${MAX_KARTS}`,
    )
  }
  for (let i = 0; i < MAX_KARTS; i++) {
    requireRange(msg.characterIdx[i], CHARACTER_IDX_BITS, `encodeStart: characterIdx[${i}]`)
    w.writeBits(msg.characterIdx[i], CHARACTER_IDX_BITS)
  }

  return w.byteLength()
}

export function decodeStart(buf: Uint8Array): StartMessage {
  const r = new BitReader(buf)
  const raceSeed = r.readBits(RACE_SEED_BITS)
  const trackId = readString(r, TRACK_ID_LEN_BITS)
  const humanMask = r.readBits(HUMAN_MASK_BITS)
  const characterIdx: number[] = []
  for (let i = 0; i < MAX_KARTS; i++) characterIdx.push(r.readBits(CHARACTER_IDX_BITS))
  return { raceSeed, trackId, humanMask, characterIdx }
}

// ---------------------------------------------------------------------------
// resyncRequest
// ---------------------------------------------------------------------------

export function encodeResyncRequest(out: Uint8Array, msg: ResyncRequestMessage): number {
  const w = new BitWriter(out)
  const reasonIdx = RESYNC_REASON_ORDER.indexOf(msg.reason)
  if (reasonIdx < 0) {
    throw new RangeError(`encodeResyncRequest: unknown ResyncReason ${String(msg.reason)}`)
  }
  w.writeBits(reasonIdx, REASON_BITS)
  requireRange(msg.lastTick, LAST_TICK_BITS, 'encodeResyncRequest: lastTick')
  w.writeBits(msg.lastTick, LAST_TICK_BITS)
  return w.byteLength()
}

export function decodeResyncRequest(buf: Uint8Array): ResyncRequestMessage {
  const r = new BitReader(buf)
  const reasonIdx = r.readBits(REASON_BITS)
  if (reasonIdx >= RESYNC_REASON_ORDER.length) {
    // 2 bits, 4 codes, 2 values. A reserved code decoding as 'lateJoin' would
    // make the server send a full checkpoint to a client that asked for
    // nothing, at the moment the room is already in trouble.
    throw new RangeError(
      `decodeResyncRequest: reason code ${reasonIdx} is not one of the ${RESYNC_REASON_ORDER.length} ResyncReason values`,
    )
  }
  const reason = RESYNC_REASON_ORDER[reasonIdx]
  const lastTick = r.readBits(LAST_TICK_BITS)
  return { reason, lastTick }
}

// ---------------------------------------------------------------------------
// Worst-case encoded BODY sizes. DERIVED, never guessed (§3.7).
// ---------------------------------------------------------------------------

/**
 * BitWriter silently truncates past the end of its buffer: a typed-array store
 * past the end is a no-op that neither throws nor grows, and `byteLength()`
 * counts bits rather than stores. So a `lobby` message written into a 128-byte
 * buffer produces a VALID-LOOKING shorter message whose last two slots are
 * garbage, with no error at any layer.
 *
 * Every constant below is computed from §3.5's tables AND asserted by a test
 * that builds the maximal message, encodes it, and compares byteLength(). Same
 * discipline as SNAPSHOT_BUF_BYTES in shadow.ts, which exists because an
 * earlier draft of that file used a figure from a superseded kart record.
 *
 *   hello         119 fixed + 8x(16 + 24) = 439 bits -> 55 B
 *   clientUpdate   30 fixed + 8x(16 + 24) = 350 bits -> 44 B
 *   welcome       138 fixed, no variable field       -> 18 B
 *   lobby         193 fixed + 8x24 + 8x8x16 = 1409   -> 177 B
 *   start          77 fixed + 8x24 = 269 bits        -> 34 B
 *   resyncRequest  34 bits, fixed                    ->  5 B
 *
 * `lobby` at 177 B is the largest non-race message in the system, and it rides
 * the reliable channel.
 */
export const HELLO_MAX_BYTES = 55
export const CLIENT_UPDATE_MAX_BYTES = 44
export const WELCOME_MAX_BYTES = 18
export const LOBBY_MAX_BYTES = 177
export const START_MAX_BYTES = 34
export const RESYNC_REQUEST_BYTES = 5
```

Add one line to `packages/protocol/src/index.ts`, at the end:

```ts
export * from './types'
export * from './room'
export * from './bits'
export * from './strings'
export * from './quant'
export * from './snapshot'
export * from './checkpoint'
export * from './events'
export * from './input'
export * from './lobby'
```

- [ ] **Step 4: Widen the barrel pin**

`packages/protocol/test/barrel.test.ts` pins the surface exactly in both directions, at runtime **and** at compile time. Five edits:

1. Add a namespace import beside the others:

   ```ts
   import * as lobbyNs from '../src/lobby'
   ```

2. Add the ten type names to the existing `import type { ... } from '../src/index'` block:

   ```ts
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
   ```

3. Add one entry to `SURFACE` — the **27 runtime names**; the other ten of §11's 37 are types and contribute nothing at runtime:

   ```ts
     // [Plan 4] the six lobby kinds. Nine flag constants, twelve codecs, six
     // derived body sizes.
     lobby: [
       'CLIENT_FLAG_READY',
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
   ```

4. Add `'lobby'` to `BARREL_MODULES` and `['lobby', lobbyNs]` to `NAMESPACES`, both last:

   ```ts
   const BARREL_MODULES = [
     'types', 'room', 'bits', 'strings', 'quant', 'snapshot', 'checkpoint', 'events', 'input', 'lobby',
   ]
   ```

5. Add the ten types to `ProtocolTypeSurface` and `TYPE_SURFACE`, and update the sorted literal in `it('pins the type-only surface at compile time')`:

   ```ts
   interface ProtocolTypeSurface {
     // ...existing ten...
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
   }
   const TYPE_SURFACE: Record<keyof ProtocolTypeSurface, true> = {
     // ...existing ten...
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
   }
   ```

   ```ts
     it('pins the type-only surface at compile time', () => {
       expect(Object.keys(TYPE_SURFACE).sort()).toEqual([
         'ChannelName', 'ClientUpdateMessage', 'EpsilonTable', 'HelloMessage', 'InputDatagram',
         'JoinResult', 'LobbyMessage', 'MessageKind', 'PeerRole', 'QuantField', 'QuantTable',
         'ResyncReason', 'ResyncRequestMessage', 'StartMessage', 'WelcomeMessage', 'WireEntity',
         'WireHeader', 'WireKart', 'WireLobbySlot', 'WireSnapshot',
       ])
     })
   ```

   Twenty names, sorted — the ten that were there plus this task's ten.

- [ ] **Step 5: Run the tests to verify they pass**

```bash
npx vitest run packages/protocol/test/lobby.test.ts packages/protocol/test/barrel.test.ts
npm run typecheck -w @tapkart/protocol
npx vitest run
```

Expected: **35 passed** in `lobby.test.ts` (6 exact-byte + 3 size + 6 round-trip + 5 enum + 4 peerSlot + 4 slot-invariant + 4 encode-range + 3 untrusted-input, across its eight describe blocks), the barrel file green, no typecheck output, and no new failures anywhere in the full run.

Failure diagnoses, because two of these are easy to get subtly wrong:

- An **exact-byte** test failing on the **last byte only** (`0x1f` vs `0x3f`, `0x03` vs `0x07`, `0x0f` vs `0x1f`) means one field is a bit wider than §3.5's table says. That is the failure the all-ones fixtures exist to catch and it is invisible to every other assertion in the file.
- An exact-byte test failing on an **early** byte means a field is in the wrong order or the wrong width; compare the failing byte index against the derivation comment above the fixture.
- `expected 178 to be 177` from the maximal-size test means a string was written without `utf8Truncate`, or with the wrong cap. Fix the encoder, never the constant.
- `barrel.test.ts` failing with a set diff naming one of the 27 means an extra export crept in — §11's census fixes `protocol/lobby` at 37 total, so remove it rather than widening the list.

- [ ] **Step 6: Commit**

```bash
git add packages/protocol/src/lobby.ts packages/protocol/src/index.ts packages/protocol/test/lobby.test.ts packages/protocol/test/barrel.test.ts && git commit -m "feat(protocol): the six lobby message kinds, with derived body sizes"
```
