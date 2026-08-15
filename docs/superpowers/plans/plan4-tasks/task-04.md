### Task 4: `packages/protocol/src/room.ts` — the bit-level half and the session token

**Files:**
- Modify: `packages/protocol/src/room.ts` — **append only.** The six shipped symbols change not one character
- Modify: `packages/protocol/test/barrel.test.ts` — `room`'s surface entry gains eight names
- Test: `packages/protocol/test/roomcodec.test.ts` (new)

**The room-code family already ships.** Plan 2's Task 15c item E landed `ROOM_CODE_ALPHABET`, `ROOM_CODE_LENGTH`, `LOBBY_PATH_PREFIX`, `normalizeRoomCode`, `isValidRoomCode` and `lobbyPathFor` in this exact file, under this exact name (`room.ts`, not `roomcode.ts`). This task adds the bit-level half — the codec that puts a code on the wire — and the session token. **Read the shipped file before you write anything**, because three drafts across two plans proposed three different alphabets and the one that shipped is none of them:

- Plan 4's own draft wrote `'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'`.
- Ruled Plan 3 §5.8 wrote `'23456789ABCDEFGHJKLMNPQRSTVWXYZ'` and described it as *"no O/0, no I/1"*.
- **Task 15c shipped Crockford's base32, which KEEPS `0` and `1` and drops the letters `I`, `L`, `O` and `U`.**

All three are 32 symbols and all three are ambiguity-free; only the shipped one is on the wire, and contract §15.12 records that ruled Plan 3 §5.8's constant and its "no O/0" description are both superseded. **The order is the 5-bit index and is therefore part of the wire format** — a differently ordered alphabet is a different protocol, not a cosmetic difference.

**Interfaces:**

- **Consumes** — `packages/protocol/src/room.ts` as shipped, quoted from source. **Do not retype these; they are already in the file and this task appends below them:**

  ```ts
  /** Crockford's base32 alphabet: 32 symbols, digits first, with I, L, O and U
   *  removed. ... The ORDER is the 5-bit index and is therefore part of the
   *  wire format. */
  export const ROOM_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

  /** FIVE characters, not four. 32^5 = 33,554,432 against 32^4 = 1,048,576. */
  export const ROOM_CODE_LENGTH = 5

  /** The lobby URL path prefix, exported ONCE. Compiled into the Android APK's
   *  `autoVerify` App Links intent-filter as its `pathPrefix`, matched
   *  case-sensitively and prefix-exactly. FROZEN AT THE FIRST SIGNED RELEASE. */
  export const LOBBY_PATH_PREFIX = '/r/'

  /** Trim and uppercase. Total - never throws, never rejects. Deliberately does
   *  NOT fold confusable glyphs. */
  export function normalizeRoomCode(input: string): string {
    return input.trim().toUpperCase()
  }

  /** True only for a code already in canonical form. Lowercase is INVALID here
   *  rather than quietly accepted. Written to survive being handed anything. */
  export function isValidRoomCode(code: string): boolean {
    if (typeof code !== 'string') return false
    if (code.length !== ROOM_CODE_LENGTH) return false
    for (let i = 0; i < code.length; i++) {
      if (!ROOM_CODE_ALPHABET.includes(code[i])) return false
    }
    return true
  }

  /** Normalizes, validates, then concatenates. Throws on a code that is not one. */
  export function lobbyPathFor(code: string): string {
    const normalized = normalizeRoomCode(code)
    if (!isValidRoomCode(normalized)) {
      throw new Error(`lobbyPathFor: '${code}' is not a valid room code`)
    }
    return LOBBY_PATH_PREFIX + normalized
  }
  ```

  One shipped behaviour that differs from what two rulings described, so no test in this task asserts the old one: P4 Q17 and ruled Plan 3 §5.8 both describe `normalizeRoomCode` as *stripping* every character outside the alphabet and *truncating* to `ROOM_CODE_LENGTH`. **The shipped one does neither** — it trims and uppercases, and `isValidRoomCode` judges. The substance that mattered survives and is arguably better served: **nothing is substituted, so a typo can never route a player into a different real room**, and a bad code produces "invalid code" rather than a silent redirect.

  From `packages/protocol/src/bits.ts`, shipped:

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
  ```

- **Produces** — contract §3.2's additions, exactly eight and not a ninth (§11's census fixes `protocol/room`'s additions at 8):

  ```ts
  export const CODE_CHAR_BITS = 5
  export const ROOM_CODE_BITS = 25               // ROOM_CODE_LENGTH * CODE_CHAR_BITS
  export const ROOM_CODE_SPACE = 33_554_432      // 32^5
  export const SESSION_TOKEN_LENGTH = 12         // F-P4-15
  export const SESSION_TOKEN_BITS = 60
  export function isValidSessionToken(raw: string): boolean
  /** `length` characters as `length` x 5 raw bits, alphabet-index order. */
  export function encodeCodeChars(w: BitWriter, code: string, length: number): void
  export function decodeCodeChars(r: BitReader, length: number): string
  ```

  **`SESSION_TOKEN_LENGTH` is 12 characters / 60 bits, and the token is the RECONNECT credential only** (F-P4-15). Confirmed against ruling P2-R16: per-message identity comes from the **transport peer**, via the server's authorised `peerId → playerId` map, which `WireLobbySlot.peerSlot` carries and §4.7's `withPeerAuthority` enforces. The session token proves one thing and one thing only — *"I am the player who held seat N"* — across a **reconnect**, when the peer identity is necessarily new. It is stored in `localStorage`, **never in the URL**, and **never used as a per-message credential**. That division is what makes P2-R16's identity-by-claim acceptable in Plan 2's loopback scope and authenticated here.

  **The 32-symbol alphabet is what makes `encodeCodeChars` exact**: five bits per character, no padding, and no index that can fail to map back. Two consumers depend on that in Task 5 — `hello`'s 25-bit `roomCode` and its 60-bit `token`, both fixed-width fields with no presence-driven length change.

---

- [ ] **Step 1: Write the failing test**

Create `packages/protocol/test/roomcodec.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { BitReader, BitWriter } from '../src/bits'
import {
  CODE_CHAR_BITS,
  LOBBY_PATH_PREFIX,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_BITS,
  ROOM_CODE_LENGTH,
  ROOM_CODE_SPACE,
  SESSION_TOKEN_BITS,
  SESSION_TOKEN_LENGTH,
  decodeCodeChars,
  encodeCodeChars,
  isValidRoomCode,
  isValidSessionToken,
  lobbyPathFor,
  normalizeRoomCode,
} from '../src/room'

/** Encodes `code` into a fresh buffer and returns exactly the bytes written. */
function encodeToBytes(code: string, length: number, bufBytes = 16): Uint8Array {
  const buf = new Uint8Array(bufBytes)
  const w = new BitWriter(buf)
  encodeCodeChars(w, code, length)
  return buf.slice(0, w.byteLength())
}

describe('the 5-bit scheme, and the one property it all rests on', () => {
  it('has exactly 32 symbols, none repeated, and 2**CODE_CHAR_BITS of them', () => {
    // The one-line test that protects the whole scheme. Thirty-one symbols and
    // `decodeCodeChars` starts producing `undefined` for code 31; thirty-three
    // and `encodeCodeChars` starts writing an index that does not fit in five
    // bits, which BitWriter neither clamps nor reports.
    expect(ROOM_CODE_ALPHABET).toHaveLength(32)
    expect(new Set(ROOM_CODE_ALPHABET).size).toBe(32)
    expect(2 ** CODE_CHAR_BITS).toBe(ROOM_CODE_ALPHABET.length)
  })

  it('is Crockford: keeps 0 and 1, drops I, L, O and U', () => {
    // Three drafts proposed three alphabets and the shipped one is none of
    // them, so this pins the string itself rather than a property of it. The
    // ORDER is the 5-bit wire index: a reordering is a different protocol.
    expect(ROOM_CODE_ALPHABET).toBe('0123456789ABCDEFGHJKMNPQRSTVWXYZ')
    for (const dropped of ['I', 'L', 'O', 'U']) {
      expect(ROOM_CODE_ALPHABET.includes(dropped), `${dropped} is in the alphabet`).toBe(false)
    }
    for (const kept of ['0', '1']) {
      expect(ROOM_CODE_ALPHABET.includes(kept), `${kept} is missing from the alphabet`).toBe(true)
    }
    // The exclusions are not cosmetic: a room code is read off one phone screen
    // across a room and typed into another, and I/1, L/1 and O/0 are the three
    // misreads that actually happen.
  })

  it('derives every width and space from the alphabet rather than restating them', () => {
    expect(CODE_CHAR_BITS).toBe(5)
    expect(ROOM_CODE_BITS).toBe(25)
    expect(ROOM_CODE_BITS).toBe(ROOM_CODE_LENGTH * CODE_CHAR_BITS)
    expect(ROOM_CODE_SPACE).toBe(33_554_432)
    expect(ROOM_CODE_SPACE).toBe(ROOM_CODE_ALPHABET.length ** ROOM_CODE_LENGTH)
    expect(SESSION_TOKEN_LENGTH).toBe(12)
    expect(SESSION_TOKEN_BITS).toBe(60)
    expect(SESSION_TOKEN_BITS).toBe(SESSION_TOKEN_LENGTH * CODE_CHAR_BITS)
    // 2^60, exactly - a power of two is exact as a double, and so is 32^12.
    expect(2 ** SESSION_TOKEN_BITS).toBe(ROOM_CODE_ALPHABET.length ** SESSION_TOKEN_LENGTH)
  })

  it('walks the WHOLE five-bit code space: 32 codes, 32 distinct characters, no hole', () => {
    // The measurement that makes "no guard needed" a fact rather than a hope.
    // Every other fixed-width enum on this wire has unused codes that decode to
    // `undefined` and must be rejected; this field's value count exactly fills
    // it, so a guard here would be dead code no datagram could reach. If a
    // 31-symbol alphabet is ever committed, THIS loop is what fails.
    const seen = new Set<string>()
    for (let code = 0; code < 2 ** CODE_CHAR_BITS; code++) {
      const buf = new Uint8Array(1)
      const w = new BitWriter(buf)
      w.writeBits(code, CODE_CHAR_BITS)
      const ch = decodeCodeChars(new BitReader(buf), 1)
      expect(ch, `code ${code} decoded to nothing`).toHaveLength(1)
      expect(ch, `code ${code} decoded outside the alphabet`).toBe(ROOM_CODE_ALPHABET[code])
      seen.add(ch)
    }
    expect(seen.size).toBe(32)
  })
})

describe('encodeCodeChars / decodeCodeChars', () => {
  it('lays a five-character code out at exact bit positions', () => {
    // THE ANCHOR. A round-trip proves encode and decode agree with EACH OTHER,
    // not that either matches the spec, so one case is pinned to literal bytes.
    //
    // '0ABCD' -> indices 0, 10, 11, 12, 13, five bits each, LSB-first:
    //   bits  0-4  = 0                       bits  5-9  = 10 = 0b01010
    //   bits 10-14 = 11 = 0b01011            bits 15-19 = 12 = 0b01100
    //   bits 20-24 = 13 = 0b01101
    //   byte0 = 0x40  byte1 = 0x2D  byte2 = 0xD6  byte3 = 0x00   (25 bits -> 4 B)
    expect(Array.from(encodeToBytes('0ABCD', ROOM_CODE_LENGTH)))
      .toEqual([0x40, 0x2d, 0xd6, 0x00])
  })

  it('writes exactly 25 bits for a room code, not 32 - the tail byte proves it', () => {
    // All-ones input, so every bit the encoder is entitled to write is set and
    // every bit past the field is not. A field one bit too wide changes byte 3
    // from 0x01 to 0x03 and NOTHING ELSE, which is invisible to a byte-count
    // assertion and to a round-trip.
    const bytes = encodeToBytes('ZZZZZ', ROOM_CODE_LENGTH)
    expect(bytes).toHaveLength(Math.ceil(ROOM_CODE_BITS / 8))
    expect(Array.from(bytes)).toEqual([0xff, 0xff, 0xff, 0x01])
  })

  it('writes exactly 60 bits for a session token, not 64 - the tail byte proves it', () => {
    const bytes = encodeToBytes('ZZZZZZZZZZZZ', SESSION_TOKEN_LENGTH)
    expect(bytes).toHaveLength(Math.ceil(SESSION_TOKEN_BITS / 8))
    expect(Array.from(bytes)).toEqual([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x0f])
  })

  it('writes all-zero bits for the all-zero code and token', () => {
    expect(Array.from(encodeToBytes('00000', ROOM_CODE_LENGTH))).toEqual([0, 0, 0, 0])
    expect(Array.from(encodeToBytes('000000000000', SESSION_TOKEN_LENGTH)))
      .toEqual([0, 0, 0, 0, 0, 0, 0, 0])
  })

  it('round-trips a code with every alphabet symbol in every position', () => {
    // 32 x 5 = 160 codes, which is the whole per-position code space rather
    // than a handful of pretty examples.
    for (let pos = 0; pos < ROOM_CODE_LENGTH; pos++) {
      for (const ch of ROOM_CODE_ALPHABET) {
        const chars = new Array<string>(ROOM_CODE_LENGTH).fill('0')
        chars[pos] = ch
        const code = chars.join('')
        const bytes = encodeToBytes(code, ROOM_CODE_LENGTH)
        expect(decodeCodeChars(new BitReader(bytes), ROOM_CODE_LENGTH), `${code}`).toBe(code)
      }
    }
  })

  it('round-trips a twelve-character token through sixty bits', () => {
    for (const token of ['000000000000', 'ZZZZZZZZZZZZ', '0123456789AB', 'ZYXWVTSRQPNM']) {
      const bytes = encodeToBytes(token, SESSION_TOKEN_LENGTH)
      expect(decodeCodeChars(new BitReader(bytes), SESSION_TOKEN_LENGTH), token).toBe(token)
    }
  })

  it('produces a code that isValidRoomCode always accepts', () => {
    // Task 5's decoders read a room code straight off the wire and route on it.
    // Every 25-bit pattern must therefore decode to something canonical - which
    // it does, because 32 symbols fill five bits with nothing left over.
    for (const bytes of [
      new Uint8Array([0x00, 0x00, 0x00, 0x00]),
      new Uint8Array([0xff, 0xff, 0xff, 0x01]),
      new Uint8Array([0x40, 0x2d, 0xd6, 0x00]),
      new Uint8Array([0xa5, 0x5a, 0xa5, 0x01]),
    ]) {
      const code = decodeCodeChars(new BitReader(bytes), ROOM_CODE_LENGTH)
      expect(isValidRoomCode(code), `${Array.from(bytes)} decoded to '${code}'`).toBe(true)
      expect(normalizeRoomCode(code), 'a decoded code is already canonical').toBe(code)
    }
  })

  it('throws on an encode it cannot represent, rather than writing something else', () => {
    const w = () => new BitWriter(new Uint8Array(16))
    // Wrong length: a four-character code is the PREVIOUS protocol version's,
    // and writing it into a 25-bit field would leave five bits of the next
    // field's value where the fifth character belongs.
    expect(() => encodeCodeChars(w(), 'ABCD', ROOM_CODE_LENGTH)).toThrow(RangeError)
    expect(() => encodeCodeChars(w(), 'ABCDEF', ROOM_CODE_LENGTH)).toThrow(RangeError)
    // Lowercase: this is why every caller goes through normalizeRoomCode first.
    expect(() => encodeCodeChars(w(), 'abcde', ROOM_CODE_LENGTH)).toThrow(RangeError)
    // A symbol the alphabet deliberately excludes.
    for (const bad of ['IBCDE', 'LBCDE', 'OBCDE', 'UBCDE', '-BCDE', ' BCDE']) {
      expect(() => encodeCodeChars(w(), bad, ROOM_CODE_LENGTH), bad).toThrow(RangeError)
    }
  })

  it('throws from BitReader when the buffer cannot hold the bits asked for', () => {
    // Untrusted input: a datagram clipped mid-code. BitReader's RangeError is
    // what @tapkart/net's guard turns into a counted, dropped datagram.
    expect(() => decodeCodeChars(new BitReader(new Uint8Array(3)), ROOM_CODE_LENGTH))
      .toThrow(RangeError)
    expect(() => decodeCodeChars(new BitReader(new Uint8Array(7)), SESSION_TOKEN_LENGTH))
      .toThrow(RangeError)
    expect(() => decodeCodeChars(new BitReader(new Uint8Array(0)), 1)).toThrow(RangeError)
  })
})

describe('isValidSessionToken', () => {
  it('accepts exactly twelve canonical alphabet characters', () => {
    expect(isValidSessionToken('000000000000')).toBe(true)
    expect(isValidSessionToken('ZZZZZZZZZZZZ')).toBe(true)
    expect(isValidSessionToken('0123456789AB')).toBe(true)
  })

  it('rejects every near miss, and never throws on any of them', () => {
    const bad: unknown[] = [
      '',                 // no token at all - the "never been welcomed" value
      '00000000000',      // 11
      '0000000000000',    // 13
      '00000',            // a room code, not a token
      'zzzzzzzzzzzz',     // lowercase: the token is compared byte for byte
      'IIIIIIIIIIII',     // excluded symbols
      'LLLLLLLLLLLL',
      'OOOOOOOOOOOO',
      'UUUUUUUUUUUU',
      '00000000000-',
      '0000 0000000',
      null,
      undefined,
      12,
      {},
      ['0'],
    ]
    for (const value of bad) {
      expect(
        () => isValidSessionToken(value as string),
        `isValidSessionToken threw on ${String(value)}`,
      ).not.toThrow()
      expect(isValidSessionToken(value as string), `accepted ${String(value)}`).toBe(false)
    }
  })

  it('is a different shape from a room code, which is what stops the two being confused', () => {
    // F-P4-15. A token is a RECONNECT credential and a room code is a public
    // address that gets read aloud; a token that could pass as a code is a
    // token somebody types into a join box.
    expect(SESSION_TOKEN_LENGTH).not.toBe(ROOM_CODE_LENGTH)
    expect(isValidRoomCode('000000000000')).toBe(false)
    expect(isValidSessionToken('00000')).toBe(false)
  })
})

describe('LOBBY_PATH_PREFIX, frozen at the first signed release', () => {
  it('is /r/, and lobbyPathFor is built from it so the two cannot disagree', () => {
    // C-1. This string is compiled into the APK's `autoVerify` intent-filter
    // pathPrefix, matched case-sensitively and prefix-exactly. A mismatch
    // between the server's routing and the APK is a SILENT App Links failure:
    // the tap opens a browser instead of the app, and on Android 12+ a failed
    // verification shows no chooser and logs nothing the developer will see.
    expect(LOBBY_PATH_PREFIX).toBe('/r/')
    expect(lobbyPathFor('0ABCD')).toBe('/r/0ABCD')
    expect(lobbyPathFor('ZZZZZ')).toBe(`${LOBBY_PATH_PREFIX}ZZZZZ`)
    // A path, never an absolute URL: the server answers with paths and the
    // client builds the origin (C-3). No host may appear anywhere in src.
    expect(lobbyPathFor('0ABCD')).not.toMatch(/:\/\//)
  })

  it('rejects a four-character code - the length this protocol used to have', () => {
    // F-P4-34 took the code from four characters to five, which is the whole
    // reason PROTOCOL_VERSION moved to 2. A path built from a stale-length code
    // is a link that silently goes nowhere, and this is the last point at which
    // that is still visible.
    expect(() => lobbyPathFor('ABCD')).toThrow()
    expect(isValidRoomCode('ABCD')).toBe(false)
  })

  it('normalizes before it validates, and substitutes nothing', () => {
    expect(lobbyPathFor('  0abcd  ')).toBe('/r/0ABCD')
    // No confusable folding: O does not become 0 and I does not become 1. A
    // second silent transformation of user input can only send a player to a
    // DIFFERENT REAL ROOM, which is worse than an "invalid code" message.
    expect(() => lobbyPathFor('OABCD')).toThrow()
    expect(() => lobbyPathFor('IABCD')).toThrow()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/protocol/test/roomcodec.test.ts`

Expected: **FAIL** at collect time, because eight of the fourteen names imported from `../src/room` do not exist:

```
SyntaxError: The requested module '/…/packages/protocol/src/room.ts' does not provide an export named 'CODE_CHAR_BITS'
```

(The first missing name reported is whichever the transform resolves first; any of `CODE_CHAR_BITS`, `ROOM_CODE_BITS`, `ROOM_CODE_SPACE`, `SESSION_TOKEN_BITS`, `SESSION_TOKEN_LENGTH`, `decodeCodeChars`, `encodeCodeChars`, `isValidSessionToken` is the expected message. The six shipped names must **not** appear in that error — if `ROOM_CODE_ALPHABET` or `lobbyPathFor` is named, Plan 2's Task 15c item E has not landed and Task 1's gate was skipped.)

- [ ] **Step 3: Write the implementation**

**Append** to `packages/protocol/src/room.ts`, below `lobbyPathFor` and changing nothing above it. Add the type-only import at the top of the file, beside the existing header comment:

```ts
import type { BitReader, BitWriter } from './bits'
```

Then, at the end of the file:

```ts
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
```

- [ ] **Step 4: Widen the barrel pin**

`packages/protocol/test/barrel.test.ts` asserts each module's own exports as an **exact set in both directions**, so eight new names fail it until they are listed. One edit — replace the `room` entry in `SURFACE`:

```ts
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
```

Fourteen names: the six that shipped, plus this task's eight. `BARREL_MODULES`, `NAMESPACES`, `ProtocolTypeSurface` and `TYPE_SURFACE` are all **unchanged** — `room.ts` already has its barrel line and this task adds no type.

- [ ] **Step 5: Run the tests to verify they pass**

```bash
npx vitest run packages/protocol/test/roomcodec.test.ts packages/protocol/test/room.test.ts packages/protocol/test/barrel.test.ts
npm run typecheck -w @tapkart/protocol
npx vitest run
```

Expected: **19 passed** in `roomcodec.test.ts` (4 + 9 + 3 + 3 across its four describe blocks), the shipped `room.test.ts` green and **untouched** — this task appends and changes nothing it asserts — the barrel file green, no typecheck output, and no new failures anywhere in the full run.

If `barrel.test.ts` fails with a diff naming one of the fourteen, either an export crept in beyond §11's eight or Step 4's list was mistyped; the fix is in whichever of the two the diff points at, never in loosening the assertion to a `toContain`.

- [ ] **Step 6: Commit**

```bash
git add packages/protocol/src/room.ts packages/protocol/test/roomcodec.test.ts packages/protocol/test/barrel.test.ts && git commit -m "feat(protocol): room-code bit codec and the 60-bit reconnect session token"
```
