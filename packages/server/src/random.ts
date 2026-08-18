// PURE. The OS CSPRNG is injected by runtime/random.ts; this module owns only
// deterministic conversion from bytes to room credentials and race seeds.
import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH, SESSION_TOKEN_LENGTH } from '@tapkart/protocol'

export type RandomSource = (bytes: number) => Uint8Array

const CODE_CHAR_MASK = ROOM_CODE_ALPHABET.length - 1

/** Draw `length` uniform Crockford base32 characters in one source call. */
export function mintCode(rand: RandomSource, length: number): string {
  const bytes = rand(length)
  if (bytes.length < length) {
    throw new Error(`mintCode: RandomSource returned ${bytes.length} bytes, need ${length}`)
  }
  let out = ''
  for (let i = 0; i < length; i++) {
    out += ROOM_CODE_ALPHABET[bytes[i] & CODE_CHAR_MASK]
  }
  return out
}

export function mintRoomCode(rand: RandomSource): string {
  return mintCode(rand, ROOM_CODE_LENGTH)
}

export function mintSessionToken(rand: RandomSource): string {
  return mintCode(rand, SESSION_TOKEN_LENGTH)
}

export function mintRaceSeed(rand: RandomSource): number {
  const bytes = rand(4)
  if (bytes.length < 4) {
    throw new Error(`mintRaceSeed: RandomSource returned ${bytes.length} bytes, need 4`)
  }
  return (bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)) >>> 0
}
