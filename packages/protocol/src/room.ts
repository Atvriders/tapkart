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
