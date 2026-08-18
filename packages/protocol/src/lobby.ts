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
export const CLIENT_FLAG_RTC_CONNECTED = 1 << 4 // clientUpdate: direct link is live; stop relaying me

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
  flags: number           // READY | START_REQUEST | RTC_FAILED | RTC_CONNECTED
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
