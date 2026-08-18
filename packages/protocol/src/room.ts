/**
 * Room codes and the lobby path, in @tapkart/protocol because they TRAVEL ON THE
 * WIRE (Task 15c item E).
 *
 * `ROOM_CODE_ALPHABET` had three proposed homes across two plans - the server
 * that mints codes, the game that types them in, the invite package that builds
 * the tag payload. All three depend on `protocol` and none of the other three
 * depend on each other, so this is the only place a single definition can sit.
 * A room code is compared byte for byte by peers that were built at different
 * times; two agreeing definitions is exactly the arrangement that drifts.
 */

import type { BitReader, BitWriter } from './bits'

/**
 * Crockford's base32 alphabet: 32 symbols, digits first, with I, L, O and U
 * removed. The exclusions are not cosmetic - a room code is read off one phone
 * screen across a room and typed into another, and I/1, L/1 and O/0 are the
 * three misreads that actually happen. U is dropped as well, which is Crockford's
 * own choice and keeps the count at exactly 32 (5 bits per character).
 */
export const ROOM_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/**
 * FIVE characters, not four.
 *
 * 32^5 = 33,554,432 against 32^4 = 1,048,576. Rooms live about ten minutes, and
 * a one-million keyspace is sweepable inside that window by a single host - and
 * IP-keyed rate limiting cannot be relied on to stop it, because this project
 * has already been bitten by a Cloudflare Tunnel presenting every request as one
 * TCP peer, which collapses per-IP counting entirely (see GrantSpotter). Five
 * characters is still typeable and 32x the space. Rate limiting is Plan 4's, and
 * is the other half of this, not a substitute for it.
 */
export const ROOM_CODE_LENGTH = 5

/**
 * The lobby URL path prefix, exported ONCE.
 *
 * This string is compiled into the Android APK's `autoVerify` App Links
 * intent-filter as its `pathPrefix`, and App Links matching is
 * case-sensitive and prefix-exact. It is therefore FROZEN AT THE FIRST SIGNED
 * RELEASE: an installed APK verifies the prefix it was built with, and a server
 * that later routes some other path produces a SILENT failure - the tap opens a
 * browser instead of the app, and on Android 12+ a failed verification shows no
 * disambiguation chooser and logs nothing anywhere the developer will see it
 * (spec §2, "App Links is mandatory, not polish").
 *
 * Short on purpose: it is also the string an NFC tag payload and a QR code carry.
 */
export const LOBBY_PATH_PREFIX = '/r/'

/**
 * The canonical form of whatever the user typed, pasted or scanned: trimmed and
 * uppercased. Total - it never throws and never rejects; `isValidRoomCode` is
 * the one that judges.
 *
 * Uppercasing is required rather than cosmetic, for the same reason
 * LOBBY_PATH_PREFIX is frozen: the code is part of a URL path matched
 * case-sensitively by the APK's pathPrefix, so `/r/abcde` and `/r/ABCDE` are two
 * different paths and only one of them opens the app.
 *
 * Deliberately does NOT fold confusable glyphs (O -> 0, I -> 1). That would be a
 * second, silent transformation of user input, and the alphabet above already
 * removes the ambiguity at the source.
 */
export function normalizeRoomCode(input: string): string {
  return input.trim().toUpperCase()
}

/**
 * True only for a code already in canonical form: exactly ROOM_CODE_LENGTH
 * characters, every one of them in ROOM_CODE_ALPHABET.
 *
 * Lowercase input is INVALID here rather than quietly accepted, which is what
 * forces every caller through `normalizeRoomCode` before it routes on a code -
 * the alternative is a server that accepts `/r/abcde`, mints a session for it,
 * and hands back a URL the APK's pathPrefix will not match.
 *
 * Takes `string` but is written to survive being handed anything at all: this is
 * the first thing that touches a value off the network or out of a URL, and a
 * validator that throws on `null` is a validator that turns a malformed request
 * into a 500.
 */
export function isValidRoomCode(code: string): boolean {
  if (typeof code !== 'string') return false
  if (code.length !== ROOM_CODE_LENGTH) return false
  for (let i = 0; i < code.length; i++) {
    if (!ROOM_CODE_ALPHABET.includes(code[i])) return false
  }
  return true
}

/**
 * The lobby path for `code`, built from LOBBY_PATH_PREFIX so the two can never
 * disagree. Normalizes first, then validates, and throws on a code that is not
 * one - a path built from a bad code is a link that silently goes nowhere, and
 * this is the last point at which that is still visible.
 */
export function lobbyPathFor(code: string): string {
  const normalized = normalizeRoomCode(code)
  if (!isValidRoomCode(normalized)) {
    throw new Error(`lobbyPathFor: '${code}' is not a valid room code`)
  }
  return LOBBY_PATH_PREFIX + normalized
}

// ---------------------------------------------------------------------------
// The bit-level half (Plan 4, contract §3.2). Everything above travels as text
// - typed into a box, read off a screen, matched against a URL path. Everything
// below is how the same value travels as bits inside `hello` and `welcome`.
// ---------------------------------------------------------------------------

/**
 * Five bits per character, because the alphabet has exactly 32 symbols.
 *
 * That is not an arbitrary pairing - it is the property that makes this codec
 * exact. Thirty-two values fill a five-bit field with nothing left over, so
 * every bit pattern maps back to a real character and there is no unused code
 * to reject. Every OTHER fixed-width enum on this wire has a hole and needs a
 * guard; this one measurably does not, and roomcodec.test.ts walks all 32 codes
 * to keep that a measurement rather than a claim.
 */
export const CODE_CHAR_BITS = 5

/** ROOM_CODE_LENGTH * CODE_CHAR_BITS. `hello` and `welcome` both carry a room
 *  code as a fixed 25-bit field with no length prefix, because the length is a
 *  constant of the protocol rather than a property of the message. */
export const ROOM_CODE_BITS = ROOM_CODE_LENGTH * CODE_CHAR_BITS

/** 32^5. The size of the space a guesser has to sweep, and the number F-P4-34
 *  weighed against ten-minute room lifetimes when it chose five characters over
 *  four. Per-code failed-join limiting is the other half of that ruling and it
 *  lives in the server; neither is a substitute for the other. */
export const ROOM_CODE_SPACE = 33_554_432

/**
 * Twelve characters, 60 bits (F-P4-15).
 *
 * THE TOKEN IS THE RECONNECT CREDENTIAL AND NOTHING ELSE. Per-message identity
 * comes from the TRANSPORT PEER, through the server's authorised
 * peerId -> playerId map that `WireLobbySlot.peerSlot` carries; the token
 * proves exactly one thing, "I am the player who held seat N", at the one
 * moment when the peer identity is necessarily new. It lives in localStorage,
 * NEVER in the URL, and is never sent as a per-message credential.
 *
 * That division is what makes ruling P2-R16's identity-by-claim acceptable in
 * Plan 2's loopback scope and authenticated here. A token used per message
 * would be a bearer secret on every datagram, in a format with no per-message
 * integrity, which buys nothing the peer identity does not already give.
 */
export const SESSION_TOKEN_LENGTH = 12
export const SESSION_TOKEN_BITS = SESSION_TOKEN_LENGTH * CODE_CHAR_BITS

/**
 * True only for a token already in canonical form: exactly
 * SESSION_TOKEN_LENGTH characters, every one of them in ROOM_CODE_ALPHABET.
 *
 * Lowercase is INVALID rather than folded, for a different reason than a room
 * code's: a token is compared byte for byte against a stored value, so
 * accepting a case variant would mean two different strings authenticate the
 * same seat. localStorage round-trips exactly what it was given, and nothing
 * ever reads a token off a screen, so there is no user-facing case to forgive.
 *
 * Takes `string` but survives being handed anything at all - this runs on a
 * value that arrived over a socket, and a validator that throws on `null`
 * turns a malformed request into a 500.
 */
export function isValidSessionToken(raw: string): boolean {
  if (typeof raw !== 'string') return false
  if (raw.length !== SESSION_TOKEN_LENGTH) return false
  for (let i = 0; i < raw.length; i++) {
    if (!ROOM_CODE_ALPHABET.includes(raw[i])) return false
  }
  return true
}

/**
 * Writes `length` characters as `length` x CODE_CHAR_BITS raw bits, in
 * alphabet-index order. No length prefix: the width is a constant of the
 * protocol, which is what lets `hello` keep a fixed 119-bit head.
 *
 * Throws on a wrong length or a character outside the alphabet. Both are
 * encode-side throws on data this process produced - a bug, not an attack - and
 * both are silent corruption if they are not thrown: a short code leaves the
 * next field's bits where a character belongs, and an unknown character yields
 * index -1, which BitWriter neither clamps nor reports.
 */
export function encodeCodeChars(w: BitWriter, code: string, length: number): void {
  if (code.length !== length) {
    throw new RangeError(`encodeCodeChars: '${code}' is ${code.length} characters, need ${length}`)
  }
  for (let i = 0; i < length; i++) {
    const idx = ROOM_CODE_ALPHABET.indexOf(code[i])
    if (idx < 0) {
      throw new RangeError(`encodeCodeChars: '${code[i]}' is not in ROOM_CODE_ALPHABET`)
    }
    w.writeBits(idx, CODE_CHAR_BITS)
  }
}

/**
 * Reads `length` x CODE_CHAR_BITS bits back into characters.
 *
 * TOTAL over every bit pattern, and deliberately unguarded: five bits produce
 * an index in 0..31 and the alphabet has exactly 32 symbols, so there is no
 * code that can miss. A rejection branch here would be dead code no datagram
 * could reach - and the check that keeps that true is the alphabet-length
 * assertion in the tests, not a runtime condition in this loop.
 *
 * Reads past the end of the buffer still throw, from BitReader, and
 * @tapkart/net's datagram guard turns that into a counted drop.
 */
export function decodeCodeChars(r: BitReader, length: number): string {
  let out = ''
  for (let i = 0; i < length; i++) {
    out += ROOM_CODE_ALPHABET[r.readBits(CODE_CHAR_BITS)]
  }
  return out
}
