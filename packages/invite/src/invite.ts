// PURE. No DOM, no clock, no I/O, and no `URL` — see parseInviteUri.
import { LOBBY_PATH_PREFIX, isValidRoomCode, normalizeRoomCode } from '@tapkart/protocol'

/** Origin cap, so `buildInviteUri` can never produce an un-encodable record and
 *  can never exceed the QR version cap. §5.9 does that arithmetic as a test. */
export const MAX_INVITE_ORIGIN_BYTES = 200

export interface InviteUri {
  origin: string
  roomCode: string
}

const HTTPS_SCHEME = 'https://'

/** Scheme, host and an optional port — and nothing else. ASCII by construction,
 *  which is what makes `origin.length` a BYTE count and MAX_INVITE_ORIGIN_BYTES
 *  measurable without an encoder. */
const ORIGIN_PATTERN = /^https:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?$/

/** `buildInviteUri('https://tapkart.example', 'ABCDE')`
 *   -> 'https://tapkart.example/r/ABCDE'.
 *  Uses LOBBY_PATH_PREFIX from @tapkart/protocol — never a literal.
 *  Throws on a trailing slash in `origin`, on a non-https scheme, on an origin
 *  longer than MAX_INVITE_ORIGIN_BYTES, or on a room code that
 *  `isValidRoomCode` would reject. The room code is upper-cased first.
 *
 *  The checks are ordered, and the order is part of the behaviour: an origin
 *  that violates two of them reports the first, in this implementation and in
 *  any other, forever. */
export function buildInviteUri(origin: string, roomCode: string): string {
  if (origin.endsWith('/')) {
    throw new Error(`buildInviteUri: origin '${origin}' has a trailing slash`)
  }
  if (!origin.startsWith(HTTPS_SCHEME)) {
    throw new Error(`buildInviteUri: origin '${origin}' is not https`)
  }
  if (!ORIGIN_PATTERN.test(origin)) {
    throw new Error(
      `buildInviteUri: origin '${origin}' is not a bare https origin (scheme, host and optional port only)`,
    )
  }
  if (origin.length > MAX_INVITE_ORIGIN_BYTES) {
    throw new Error(
      `buildInviteUri: origin is ${origin.length} bytes, over MAX_INVITE_ORIGIN_BYTES (${MAX_INVITE_ORIGIN_BYTES})`,
    )
  }
  const code = normalizeRoomCode(roomCode)
  if (!isValidRoomCode(code)) {
    throw new Error(`buildInviteUri: '${roomCode}' is not a valid room code`)
  }
  return origin + LOBBY_PATH_PREFIX + code
}

/** Total: returns null rather than throwing, because its inputs come off a
 *  radio and off the address bar. Rejects any scheme but https, any path not
 *  starting with LOBBY_PATH_PREFIX, any malformed room code, and ANY query
 *  string or fragment (P5 Q14: the invite URI carries the room code and nothing
 *  else).
 *
 *  HAND-PARSED. It does not use `URL`: `URL` is an ambient global whose presence
 *  depends on the lib/@types configuration of whoever imports this package, and
 *  its normalisation silently accepts the query strings this function must
 *  reject. Twenty lines of explicit parsing has neither failure mode.
 *
 *  The code is upper-cased before validation: the alphabet is uppercase-only, so
 *  a typed lower-case URI is unambiguous and rejecting it would be a tap that
 *  does nothing for a reason no guest could see. Nothing else is substituted. */
export function parseInviteUri(uri: string): InviteUri | null {
  if (typeof uri !== 'string') return null
  if (uri.includes('?') || uri.includes('#')) return null
  if (!uri.startsWith(HTTPS_SCHEME)) return null
  const pathStart = uri.indexOf('/', HTTPS_SCHEME.length)
  if (pathStart < 0) return null
  const origin = uri.slice(0, pathStart)
  const path = uri.slice(pathStart)
  if (!ORIGIN_PATTERN.test(origin)) return null
  if (origin.length > MAX_INVITE_ORIGIN_BYTES) return null
  if (!path.startsWith(LOBBY_PATH_PREFIX)) return null
  const code = normalizeRoomCode(path.slice(LOBBY_PATH_PREFIX.length))
  if (!isValidRoomCode(code)) return null
  return { origin, roomCode: code }
}

/** 'https://tapkart.example' -> 'tapkart.example'. null on anything that is not
 *  an https origin. Used by §12.2's manifest assertion (value 1 == value 2) and
 *  by nothing shipped.
 *
 *  The port is dropped because `android:host` is a separate attribute from
 *  `android:port`; the case is left exactly as given, because the verifier folds
 *  it and a transform here would make assertion 21 compare two strings that
 *  differ for a reason nobody can see. */
export function originHost(origin: string): string | null {
  if (!ORIGIN_PATTERN.test(origin)) return null
  const hostAndPort = origin.slice(HTTPS_SCHEME.length)
  const colon = hostAndPort.indexOf(':')
  return colon < 0 ? hostAndPort : hostAndPort.slice(0, colon)
}
