### Task 17: `packages/server/src/random.ts` and `src/registry.ts` — the two mints and the room table

**Files:**
- Create: `packages/server/src/random.ts`
- Create: `packages/server/src/registry.ts`
- Test: `packages/server/test/random.test.ts`
- Test: `packages/server/test/registry.test.ts`

**Interfaces:**

- **Consumes** — from `@tapkart/protocol`, contract §3.2 (`room.ts`; the first three shipped in Plan 2 Task 15c item E, `SESSION_TOKEN_LENGTH` is Plan 4's addition to the same file):

  ```ts
  /** Crockford's base32: 32 symbols, DIGITS FIRST, with I, L, O and U removed.
   *  The ORDER is the 5-bit index and is therefore part of the wire format. */
  export const ROOM_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
  export const ROOM_CODE_LENGTH = 5
  export const SESSION_TOKEN_LENGTH = 12         // F-P4-15
  export const SESSION_TOKEN_BITS = 60
  export type PeerRole = 'host' | 'guest'
  ```

- **Consumes** — from `@tapkart/sim`: `export const MAX_KARTS = 8`.
- **Consumes** — from `@tapkart/net` (Task 13): `export function createLiveness(nowMs: number): LivenessState`.
- **Consumes** — from Task 16, `packages/server/src/types.ts`: `PeerId`, `PeerRecord`, `RoomRecord` (and `ServerRoomPhase` through `RoomRecord.phase`).

- **Produces** — contract §5.3, five exported symbols (census §11: `server/random` = 5):

  ```ts
  /** Injected everywhere a mint happens. The one implementation that reads the OS
   *  CSPRNG lives in src/runtime/random.ts. */
  export type RandomSource = (bytes: number) => Uint8Array
  export function mintCode(rand: RandomSource, length: number): string
  export function mintRoomCode(rand: RandomSource): string        // ROOM_CODE_LENGTH = 5
  export function mintSessionToken(rand: RandomSource): string    // SESSION_TOKEN_LENGTH = 12
  export function mintRaceSeed(rand: RandomSource): number        // u32
  ```

- **Produces** — contract §5.4, six exported symbols (census §11: `server/registry` = 6):

  ```ts
  export const ROOM_CODE_MINT_ATTEMPTS = 8
  export class RoomLimitError extends Error {}
  export class RoomFullError extends Error {}
  export class CodeCollisionError extends Error {}
  export interface RegistryOptions {
    maxRooms: number; maxPeersPerRoom: number; roomIdleMs: number; rand: RandomSource
  }
  export class RoomRegistry {
    constructor(opts: RegistryOptions)
    createRoom(nowMs: number): RoomRecord
    getRoom(code: string): RoomRecord | null
    addPeer(room: RoomRecord, peerId: PeerId, role: PeerRole, nowMs: number): PeerRecord
    removePeer(room: RoomRecord, peerId: PeerId, nowMs: number): PeerRecord | null
    reclaim(room: RoomRecord, token: string, peerId: PeerId, nowMs: number): PeerRecord | null
    touch(room: RoomRecord, nowMs: number): void
    expire(nowMs: number): RoomRecord[]
    rooms(): RoomRecord[]
    size(): number
  }
  ```

**The property the whole of `random.ts` rests on** (contract §5.3): *"The alphabet is exactly 32 symbols, so 5 bits per character is uniform with NO REJECTION AT ALL — which is the whole reason it is 32 and not 33, and why this function has no retry loop and no modulo bias."* 256 is a multiple of 32, so the low five bits of a uniform byte are a uniform symbol index. A 33-symbol alphabet would need rejection sampling, and a `% 33` would silently favour the first few symbols — in the one string a player reads off a screen and types into another phone.

**And the division that makes the token safe** (F-P4-15): *"The session token is the reconnect credential and nothing else."* 60 bits, stored in `localStorage`, **never in the URL**, and **never a per-message credential** — per-message identity comes from the transport peer through Task 12's `withPeerAuthority`. The token proves *"I am the player who held seat N"* across a reconnect, when the peer identity is necessarily new.

**Five decisions this task makes, because the contract fixes the signatures and not these:**

1. **`addPeer` is the sole minter of session tokens**, for the same reason it is the sole assigner of slots and `createRoom` is the sole minter of codes: the two credentials in this system are minted in one module, through one injected `RandomSource`, so a test with a counting fake can state every one of them exactly.
2. **`removePeer` does not delete a *seated* peer's record.** The token is the reconnect credential, so deleting the record deletes the seat's owner and `reclaim` can never match. A peer that never got a seat (`playerId < 0`) has nothing to reclaim and is deleted, so a room does not accumulate ghosts.
3. **`removePeer` frees the slot but leaves the number on the record**, which is what lets `reclaim` allocate a **different** one. A disconnected peer is never a send target (`RoomTransport.peers()` is the connected ones), so the stale number addresses nothing.
4. **`reclaim` re-points `room.seats[playerId]` at the new peer id.** Contract §7 makes `lobby.ts` the sole **assigner** of seats via `assignSeat`/`releaseSeat`; reclaim assigns nothing — it re-points a seat that is already assigned at the same player's new peer. Leaving the stale id there would keep a vanished peer authorised in `seatMapOf` and leave the returning player unauthorised for their own seat, which is exactly the failure §4.7 exists to prevent.
5. **`getRoom` does not normalise.** `normalizeRoomCode` is the caller's, in `@tapkart/protocol`, and *"a second silent transformation of user input can only send a player to a different real room"*. The registry stores canonical codes and answers `null` for anything else.

---

- [ ] **Step 1: Write the failing tests**

Create `packages/server/test/random.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH, SESSION_TOKEN_LENGTH } from '@tapkart/protocol'
import type { RandomSource } from '../src/random'
import { mintCode, mintRaceSeed, mintRoomCode, mintSessionToken } from '../src/random'

/**
 * The fixture formula contract §9.1 fixes: byte i of draw n is (n * 31 + i) &
 * 0xff. Every minted string in the suite is therefore an exact expected value
 * rather than a shape.
 */
function makeCountingRandom(): RandomSource & { draws(): number; bytesAsked(): number[] } {
  let n = 0
  const asked: number[] = []
  const rand = (bytes: number): Uint8Array => {
    asked.push(bytes)
    const out = new Uint8Array(bytes)
    for (let i = 0; i < bytes; i++) out[i] = (n * 31 + i) & 0xff
    n++
    return out
  }
  return Object.assign(rand, { draws: () => n, bytesAsked: () => asked })
}

/** A stand-in for the OS CSPRNG: xorshift32, deterministic, and spread across
 * the whole byte range so the distribution assertions below mean something. */
function makeSpreadRandom(seed: number): RandomSource {
  let s = seed >>> 0
  return (bytes: number): Uint8Array => {
    const out = new Uint8Array(bytes)
    for (let i = 0; i < bytes; i++) {
      s ^= s << 13
      s >>>= 0
      s ^= s >>> 17
      s ^= s << 5
      s >>>= 0
      out[i] = s & 0xff
    }
    return out
  }
}

describe('the alphabet this all rests on', () => {
  it('is exactly 32 symbols, with no duplicate', () => {
    // 5 bits per character with NO rejection is only true at exactly 32. This
    // one line protects the whole scheme.
    expect(ROOM_CODE_ALPHABET.length).toBe(32)
    expect(new Set(ROOM_CODE_ALPHABET).size).toBe(32)
  })
})

describe('mintCode', () => {
  it('yields an exact string from a counting source', () => {
    const rand = makeCountingRandom()
    expect(mintCode(rand, 5)).toBe('01234')
    expect(mintCode(rand, 5)).toBe('Z0123')
  })

  it('asks for exactly one byte per character, once - no rejection loop', () => {
    const rand = makeCountingRandom()
    mintCode(rand, 5)
    expect(rand.draws()).toBe(1)
    expect(rand.bytesAsked()).toEqual([5])
  })

  it('never leaves the alphabet, over 10,000 characters of spread input', () => {
    const rand = makeSpreadRandom(0x9e3779b9)
    const seen = new Set<string>()
    for (let i = 0; i < 2000; i++) {
      const code = mintCode(rand, 5)
      expect(code).toHaveLength(5)
      for (const ch of code) {
        expect(ROOM_CODE_ALPHABET).toContain(ch)
        seen.add(ch)
      }
    }
    // Every symbol is reachable: a masking bug that dropped the high bit would
    // still pass "in the alphabet" while halving the keyspace.
    expect(seen.size).toBe(32)
  })

  it('throws rather than padding when the source is short', () => {
    const short: RandomSource = () => new Uint8Array(2)
    expect(() => mintCode(short, 5)).toThrow(/mintCode/)
  })
})

describe('mintRoomCode', () => {
  it('is five characters, F-P4-34', () => {
    const rand = makeCountingRandom()
    const code = mintRoomCode(rand)
    expect(code).toHaveLength(ROOM_CODE_LENGTH)
    expect(ROOM_CODE_LENGTH).toBe(5)
    expect(code).toBe('01234')
  })
})

describe('mintSessionToken', () => {
  it('is twelve characters - 60 bits, the reconnect credential and nothing else', () => {
    const rand = makeCountingRandom()
    const token = mintSessionToken(rand)
    expect(token).toHaveLength(SESSION_TOKEN_LENGTH)
    expect(SESSION_TOKEN_LENGTH).toBe(12)
    expect(token).toBe('0123456789AB')
  })

  it('does not repeat across draws', () => {
    const rand = makeSpreadRandom(1)
    const tokens = new Set<string>()
    for (let i = 0; i < 500; i++) tokens.add(mintSessionToken(rand))
    expect(tokens.size).toBe(500)
  })
})

describe('mintRaceSeed', () => {
  it('reads four bytes little-endian into a u32', () => {
    const rand = makeCountingRandom()
    expect(mintRaceSeed(rand)).toBe(50_462_976) // 0x03020100
    expect(rand.bytesAsked()).toEqual([4])
  })

  it('is never negative, whatever the high bit does', () => {
    const highBit: RandomSource = () => new Uint8Array([0xff, 0xff, 0xff, 0xff])
    expect(mintRaceSeed(highBit)).toBe(4_294_967_295)
    expect(mintRaceSeed(highBit)).toBeGreaterThanOrEqual(0)
  })
})
```

Create `packages/server/test/registry.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { MAX_KARTS } from '@tapkart/sim'
import type { RandomSource } from '../src/random'
import type { PeerRecord, RoomRecord } from '../src/types'
import {
  CodeCollisionError,
  ROOM_CODE_MINT_ATTEMPTS,
  RoomFullError,
  RoomLimitError,
  RoomRegistry,
} from '../src/registry'

function makeCountingRandom(): RandomSource & { draws(): number } {
  let n = 0
  const rand = (bytes: number): Uint8Array => {
    const out = new Uint8Array(bytes)
    for (let i = 0; i < bytes; i++) out[i] = (n * 31 + i) & 0xff
    n++
    return out
  }
  return Object.assign(rand, { draws: () => n })
}

/** Always the same bytes: every code it mints collides with the first. */
function makeStuckRandom(): RandomSource & { draws(): number } {
  let n = 0
  const rand = (bytes: number): Uint8Array => {
    n++
    return new Uint8Array(bytes) // all zeros -> '00000'
  }
  return Object.assign(rand, { draws: () => n })
}

function makeRegistry(over: Partial<{ maxRooms: number; maxPeersPerRoom: number; roomIdleMs: number; rand: RandomSource }> = {}): RoomRegistry {
  return new RoomRegistry({
    maxRooms: 64,
    maxPeersPerRoom: MAX_KARTS,
    roomIdleMs: 600_000,
    rand: makeCountingRandom(),
    ...over,
  })
}

/** Seats a peer the way lobby.ts will: the registry never assigns a seat. */
function seat(room: RoomRecord, peer: PeerRecord, playerId: number): void {
  peer.playerId = playerId
  room.seats[playerId] = peer.peerId
}

describe('RoomRegistry.createRoom', () => {
  it('mints a code from the injected source and files the room under it', () => {
    const reg = makeRegistry()
    const room = reg.createRoom(1000)
    expect(room.code).toBe('01234')
    expect(reg.getRoom('01234')).toBe(room)
    expect(reg.size()).toBe(1)
  })

  it('opens the room empty, in the lobby, with one seat per kart', () => {
    const room = makeRegistry().createRoom(1000)
    expect(room.phase).toBe('lobby')
    expect(room.hostPeerId).toBeNull()
    expect(room.hostPlayerId).toBe(-1)
    expect(room.peers.size).toBe(0)
    expect(room.slotsInUse.size).toBe(0)
    expect(room.seats).toHaveLength(MAX_KARTS)
    expect(room.seats.every((s) => s === null)).toBe(true)
    expect(room.race).toBeNull()
    expect(room.rtcFailures).toBe(0)
    expect(room.lobbyVersion).toBe(0)
    expect(room.createdAtMs).toBe(1000)
    expect(room.lastActivityMs).toBe(1000)
  })

  it('does not normalise on lookup: a lowercase code is not this room', () => {
    const reg = makeRegistry()
    reg.createRoom(0) // draw 0 -> '01234', all digits, so lowercase says nothing
    const second = reg.createRoom(0) // draw 1 -> 'Z0123'
    expect(second.code).toBe('Z0123')

    expect(reg.getRoom('Z0123')).toBe(second)
    expect(reg.getRoom('z0123')).toBeNull()
    expect(reg.getRoom('nope!')).toBeNull()
  })

  it('refuses at maxRooms rather than evicting a live race', () => {
    const reg = makeRegistry({ maxRooms: 2 })
    reg.createRoom(0)
    reg.createRoom(0)
    expect(() => reg.createRoom(0)).toThrow(RoomLimitError)
    expect(reg.size()).toBe(2)
  })

  it('gives up after ROOM_CODE_MINT_ATTEMPTS collisions rather than looping forever', () => {
    const rand = makeStuckRandom()
    const reg = makeRegistry({ rand })
    const first = reg.createRoom(0)
    expect(first.code).toBe('00000')
    const drawsAfterFirst = rand.draws()

    expect(() => reg.createRoom(0)).toThrow(CodeCollisionError)
    expect(rand.draws() - drawsAfterFirst).toBe(ROOM_CODE_MINT_ATTEMPTS)
    // The failed create left nothing behind.
    expect(reg.size()).toBe(1)
  })
})

describe('RoomRegistry.addPeer', () => {
  it('assigns dense, unique slots starting at 1, and mints a token', () => {
    const reg = makeRegistry()
    const room = reg.createRoom(0)
    const a = reg.addPeer(room, 'peer-a', 'host', 10)
    const b = reg.addPeer(room, 'peer-b', 'guest', 20)

    expect(a.slot).toBe(1)
    expect(b.slot).toBe(2)
    expect([...room.slotsInUse].sort()).toEqual([1, 2])
    expect(room.peers.get('peer-a')).toBe(a)
    expect(a.role).toBe('host')
    expect(a.playerId).toBe(-1) // seating is lobby.ts's
    expect(a.connected).toBe(true)
    expect(a.joinedAtMs).toBe(10)
    // Draw 0 was the room code; draws 1 and 2 are the two tokens.
    expect(a.token).toBe('Z0123456789A')
    expect(b.token).not.toBe(a.token)
    expect(b.token).toHaveLength(12)
  })

  it('gives every peer its own liveness state, seeded now', () => {
    const reg = makeRegistry()
    const room = reg.createRoom(0)
    const a = reg.addPeer(room, 'peer-a', 'host', 10)
    const b = reg.addPeer(room, 'peer-b', 'guest', 20)
    expect(a.liveness.lastSeenMs).toBe(10)
    expect(b.liveness.lastSeenMs).toBe(20)
    a.liveness.lastSeenMs = 999
    expect(b.liveness.lastSeenMs).toBe(20)
  })

  it('refuses the ninth peer with RoomFullError - no spectators, no queue', () => {
    const reg = makeRegistry()
    const room = reg.createRoom(0)
    for (let i = 0; i < MAX_KARTS; i++) reg.addPeer(room, `peer-${i}`, 'guest', 0)
    expect(() => reg.addPeer(room, 'peer-8', 'guest', 0)).toThrow(RoomFullError)
    expect(room.peers.size).toBe(MAX_KARTS)
    expect(room.slotsInUse.size).toBe(MAX_KARTS)
  })

  it('counts only CONNECTED peers against the cap', () => {
    // Otherwise a room fills with ghosts and refuses everybody, ten minutes
    // before it expires.
    const reg = makeRegistry({ maxPeersPerRoom: 2 })
    const room = reg.createRoom(0)
    const a = reg.addPeer(room, 'peer-a', 'host', 0)
    seat(room, a, 0)
    reg.addPeer(room, 'peer-b', 'guest', 0)
    reg.removePeer(room, 'peer-a', 100)

    expect(() => reg.addPeer(room, 'peer-c', 'guest', 200)).not.toThrow()
  })
})

describe('RoomRegistry.removePeer', () => {
  it('frees the slot and marks the peer gone, keeping a SEATED record for reclaim', () => {
    const reg = makeRegistry()
    const room = reg.createRoom(0)
    const a = reg.addPeer(room, 'peer-a', 'host', 0)
    seat(room, a, 0)

    const gone = reg.removePeer(room, 'peer-a', 500)

    expect(gone).toBe(a)
    expect(a.connected).toBe(false)
    expect(room.slotsInUse.has(1)).toBe(false)
    // The record survives: the token IS the reconnect credential, and deleting
    // the record deletes the seat's owner.
    expect(room.peers.get('peer-a')).toBe(a)
    expect(a.playerId).toBe(0)
  })

  it('deletes a peer that never got a seat', () => {
    const reg = makeRegistry()
    const room = reg.createRoom(0)
    reg.addPeer(room, 'peer-a', 'guest', 0)
    reg.removePeer(room, 'peer-a', 500)
    expect(room.peers.has('peer-a')).toBe(false)
  })

  it('returns null for a peer that was never here, and changes nothing', () => {
    const reg = makeRegistry()
    const room = reg.createRoom(0)
    reg.addPeer(room, 'peer-a', 'host', 0)
    const before = room.peers.size

    expect(reg.removePeer(room, 'peer-x', 500)).toBeNull()
    expect(room.peers.size).toBe(before)
    expect(room.slotsInUse.has(1)).toBe(true)
  })
})

describe('RoomRegistry.reclaim', () => {
  it('returns the same playerId and a NEW slot, under the new peer id', () => {
    const reg = makeRegistry()
    const room = reg.createRoom(0)
    const a = reg.addPeer(room, 'peer-a', 'host', 0)
    seat(room, a, 0)
    const token = a.token
    const oldSlot = a.slot
    reg.removePeer(room, 'peer-a', 500)

    const back = reg.reclaim(room, token, 'peer-a2', 900)

    expect(back).not.toBeNull()
    expect(back?.playerId).toBe(0)
    expect(back?.peerId).toBe('peer-a2')
    expect(back?.connected).toBe(true)
    expect(back?.slot).not.toBe(oldSlot)
    expect(room.slotsInUse.has(back?.slot ?? -1)).toBe(true)
    expect(back?.liveness.lastSeenMs).toBe(900)
  })

  it('re-points the seat at the new peer, so the vanished one is no longer its owner', () => {
    // The seat map IS the authorised peer -> seat map (§4.7). A stale id here
    // keeps a peer that is gone authorised for the seat, and leaves the
    // returning player unauthorised for their own.
    const reg = makeRegistry()
    const room = reg.createRoom(0)
    const a = reg.addPeer(room, 'peer-a', 'host', 0)
    seat(room, a, 0)
    reg.removePeer(room, 'peer-a', 500)

    reg.reclaim(room, a.token, 'peer-a2', 900)

    expect(room.seats[0]).toBe('peer-a2')
    expect(room.peers.has('peer-a')).toBe(false)
    expect(room.peers.get('peer-a2')?.playerId).toBe(0)
  })

  it('returns null for an unknown token, and changes NOTHING', () => {
    const reg = makeRegistry()
    const room = reg.createRoom(0)
    const a = reg.addPeer(room, 'peer-a', 'host', 0)
    seat(room, a, 0)
    reg.removePeer(room, 'peer-a', 500)
    const slotsBefore = [...room.slotsInUse]

    expect(reg.reclaim(room, 'NOTAREALTOKEN', 'peer-x', 900)).toBeNull()

    expect(room.seats[0]).toBe('peer-a')
    expect(room.peers.has('peer-x')).toBe(false)
    expect(a.connected).toBe(false)
    expect([...room.slotsInUse]).toEqual(slotsBefore)
  })

  it('refuses a token whose owner is still CONNECTED, and changes nothing', () => {
    // A token is a reconnect credential, never a takeover: a leaked one must not
    // evict the player sitting in the seat.
    const reg = makeRegistry()
    const room = reg.createRoom(0)
    const a = reg.addPeer(room, 'peer-a', 'host', 0)
    seat(room, a, 0)

    expect(reg.reclaim(room, a.token, 'peer-thief', 900)).toBeNull()

    expect(room.seats[0]).toBe('peer-a')
    expect(room.peers.has('peer-thief')).toBe(false)
    expect(a.peerId).toBe('peer-a')
    expect(a.connected).toBe(true)
  })

  it('refuses an empty token, which every unwelcomed client sends', () => {
    const reg = makeRegistry()
    const room = reg.createRoom(0)
    const a = reg.addPeer(room, 'peer-a', 'host', 0)
    seat(room, a, 0)
    reg.removePeer(room, 'peer-a', 500)

    expect(reg.reclaim(room, '', 'peer-x', 900)).toBeNull()
    expect(room.seats[0]).toBe('peer-a')
  })

  it('refuses a token whose peer never held a seat', () => {
    const reg = makeRegistry()
    const room = reg.createRoom(0)
    const a = reg.addPeer(room, 'peer-a', 'guest', 0)
    const token = a.token
    reg.removePeer(room, 'peer-a', 500) // unseated: the record is gone

    expect(reg.reclaim(room, token, 'peer-a2', 900)).toBeNull()
  })
})

describe('RoomRegistry.touch and expire', () => {
  it('closes exactly the rooms idle at roomIdleMs, not at roomIdleMs - 1', () => {
    const reg = makeRegistry({ roomIdleMs: 1000 })
    const room = reg.createRoom(0)

    expect(reg.expire(999)).toEqual([])
    expect(room.phase).toBe('lobby')

    const closed = reg.expire(1000)
    expect(closed).toEqual([room])
    expect(room.phase).toBe('closed')
    expect(reg.size()).toBe(0)
    expect(reg.getRoom(room.code)).toBeNull()
  })

  it('touch resets the clock', () => {
    const reg = makeRegistry({ roomIdleMs: 1000 })
    const room = reg.createRoom(0)
    reg.touch(room, 900)
    expect(reg.expire(1500)).toEqual([])
    expect(reg.expire(1900)).toEqual([room])
  })

  it('expires only the idle rooms and leaves the rest listed', () => {
    const reg = makeRegistry({ roomIdleMs: 1000 })
    const stale = reg.createRoom(0)
    const busy = reg.createRoom(0)
    reg.touch(busy, 900)

    expect(reg.expire(1000)).toEqual([stale])
    expect(reg.rooms()).toEqual([busy])
    expect(reg.size()).toBe(1)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/server/test/random.test.ts packages/server/test/registry.test.ts`

Expected: FAIL, before any assertion, with

```
Error: Failed to resolve import "../src/random" from "packages/server/test/random.test.ts". Does the file exist?
Error: Failed to resolve import "../src/registry" from "packages/server/test/registry.test.ts". Does the file exist?
```

- [ ] **Step 3: Write `packages/server/src/random.ts`**

```ts
// PURE (contract §0a). node:crypto appears in exactly one file in this package -
// src/runtime/random.ts - and it is not this one: every mint here goes through
// an injected RandomSource, so a test with a counting fake asserts exact
// strings rather than shapes.
import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH, SESSION_TOKEN_LENGTH } from '@tapkart/protocol'

/** Injected everywhere a mint happens. The one implementation that reads the OS
 *  CSPRNG lives in src/runtime/random.ts. */
export type RandomSource = (bytes: number) => Uint8Array

/**
 * The alphabet is exactly 32 symbols, so the low five bits of a uniform byte are
 * a uniform symbol index: 256 is a multiple of 32, and every index is reachable
 * by exactly eight of the 256 byte values.
 *
 * THAT is why there is no retry loop and no modulo bias here, and it is the whole
 * reason the alphabet is 32 and not 33. A 33-symbol alphabet would need rejection
 * sampling, and a `% 33` would quietly favour the first 25 symbols - in the one
 * string a player reads off a screen across a room and types into another phone.
 */
const CODE_CHAR_MASK = ROOM_CODE_ALPHABET.length - 1

/** `length` characters drawn uniformly from ROOM_CODE_ALPHABET, in ONE draw. */
export function mintCode(rand: RandomSource, length: number): string {
  const bytes = rand(length)
  if (bytes.length < length) {
    // Padding a short draw would silently shorten the keyspace; this is a bug in
    // the injected source, not a condition to recover from.
    throw new Error(`mintCode: RandomSource returned ${bytes.length} bytes, need ${length}`)
  }
  let out = ''
  for (let i = 0; i < length; i++) {
    out += ROOM_CODE_ALPHABET[bytes[i] & CODE_CHAR_MASK]
  }
  return out
}

/** Five characters, 32^5 = 33,554,432 (F-P4-34). */
export function mintRoomCode(rand: RandomSource): string {
  return mintCode(rand, ROOM_CODE_LENGTH)
}

/**
 * Twelve characters, 60 bits.
 *
 * THE RECONNECT CREDENTIAL AND NOTHING ELSE (F-P4-15). Stored in localStorage,
 * NEVER in the URL, and NEVER a per-message credential: per-message identity
 * comes from the transport peer through withPeerAuthority's authorised map. This
 * proves "I am the player who held seat N" across a reconnect, when the peer
 * identity is necessarily new - which is what makes P2-R16's identity-by-claim
 * acceptable in Plan 2's loopback scope and authenticated here.
 */
export function mintSessionToken(rand: RandomSource): string {
  return mintCode(rand, SESSION_TOKEN_LENGTH)
}

/** A u32, little-endian, and never negative: `>>> 0` is what keeps a high bit
 * from turning the seed into a negative number that sim's PRNG would then read
 * as a different seed on every platform. */
export function mintRaceSeed(rand: RandomSource): number {
  const bytes = rand(4)
  if (bytes.length < 4) {
    throw new Error(`mintRaceSeed: RandomSource returned ${bytes.length} bytes, need 4`)
  }
  return (bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)) >>> 0
}
```

- [ ] **Step 4: Write `packages/server/src/registry.ts`**

```ts
// PURE (contract §0a). No clock: every method that needs "now" takes it as a
// parameter, so room expiry is a unit test with no timers.
import type { PeerRole } from '@tapkart/protocol'
import { MAX_KARTS } from '@tapkart/sim'
import { createLiveness } from '@tapkart/net'
import type { RandomSource } from './random'
import { mintRoomCode, mintSessionToken } from './random'
import type { PeerId, PeerRecord, RoomRecord } from './types'

/** Retries this many times on a code collision, then throws rather than looping
 * forever. At 33.5 M codes and 64 rooms a collision is already a curiosity; a
 * source that keeps colliding is broken, and a loop that hides it hangs the
 * process instead of failing the request. */
export const ROOM_CODE_MINT_ATTEMPTS = 8

/** The registry's three capacity errors. They are the only things this module
 * throws for a condition the caller can meet legitimately, and the hub catches
 * each one across a boundary and answers a JoinResult. */
export class RoomLimitError extends Error {}
export class RoomFullError extends Error {}
export class CodeCollisionError extends Error {}

export interface RegistryOptions {
  maxRooms: number
  maxPeersPerRoom: number
  roomIdleMs: number
  rand: RandomSource
}

/** Slot 0 is WS_SLOT_SERVER and 0xff is WS_SLOT_BROADCAST (contract §4.2), so a
 * peer's slot lives in 1..254. */
const MIN_SLOT = 1
const MAX_SLOT = 254

export class RoomRegistry {
  private readonly opts: RegistryOptions
  private readonly byCode = new Map<string, RoomRecord>()

  constructor(opts: RegistryOptions) {
    this.opts = { ...opts }
  }

  /** Sole minter of room codes. */
  createRoom(nowMs: number): RoomRecord {
    if (this.byCode.size >= this.opts.maxRooms) {
      // Refusing at the cap beats evicting a live race: the room being evicted
      // would be somebody's race in progress, and they would have no idea why.
      throw new RoomLimitError(`room limit reached (${this.opts.maxRooms})`)
    }

    let code = ''
    for (let attempt = 0; attempt < ROOM_CODE_MINT_ATTEMPTS; attempt++) {
      const candidate = mintRoomCode(this.opts.rand)
      if (!this.byCode.has(candidate)) {
        code = candidate
        break
      }
    }
    if (code === '') {
      throw new CodeCollisionError(
        `could not mint a free room code in ${ROOM_CODE_MINT_ATTEMPTS} attempts`,
      )
    }

    const room: RoomRecord = {
      code,
      createdAtMs: nowMs,
      lastActivityMs: nowMs,
      phase: 'lobby',
      hostPeerId: null,
      hostPlayerId: -1,
      // No track opinion is minted here: the server owns lobby truth (F-P4-31)
      // and handleHello writes the host's choice. The registry knows nothing
      // about content.
      trackId: '',
      lobbyVersion: 0,
      raceSeed: 0,
      peers: new Map<PeerId, PeerRecord>(),
      slotsInUse: new Set<number>(),
      seats: new Array<PeerId | null>(MAX_KARTS).fill(null),
      rtcFailures: 0,
      race: null,
    }
    this.byCode.set(code, room)
    return room
  }

  /**
   * Canonical codes only. Normalising here would be a SECOND silent
   * transformation of user input, and protocol/room.ts refuses the first one for
   * the reason that applies here too: it can only ever send a player to a
   * different real room. Callers run normalizeRoomCode.
   */
  getRoom(code: string): RoomRecord | null {
    return this.byCode.get(code) ?? null
  }

  /** Sole assigner of `slot`, sole writer of `peers` / `slotsInUse`, and sole
   * minter of session tokens. */
  addPeer(room: RoomRecord, peerId: PeerId, role: PeerRole, nowMs: number): PeerRecord {
    if (room.peers.has(peerId)) {
      // Not a capacity error: the hub is the sole creator of peer ids, so a
      // duplicate is a caller bug and must not be quietly folded into the
      // existing record - that record holds somebody's token.
      throw new Error(`addPeer: ${peerId} is already in room ${room.code}`)
    }
    let connected = 0
    for (const peer of room.peers.values()) if (peer.connected) connected++
    if (connected >= this.opts.maxPeersPerRoom) {
      // The ninth joiner is refused - no spectators, no queue. Spec §1 caps the
      // grid at 8.
      throw new RoomFullError(`room ${room.code} is full (${this.opts.maxPeersPerRoom})`)
    }

    const peer: PeerRecord = {
      peerId,
      slot: this.allocSlot(room, 0),
      playerId: -1,          // seating is lobby.ts's assignSeat, never this
      token: mintSessionToken(this.opts.rand),
      role,
      name: '',
      characterIdx: 0,
      ready: false,
      relay: false,
      connected: true,
      joinedAtMs: nowMs,
      lastSeenMs: nowMs,
      liveness: createLiveness(nowMs),
    }
    room.peers.set(peerId, peer)
    room.slotsInUse.add(peer.slot)
    return peer
  }

  /**
   * The peer's socket went away.
   *
   * A SEATED peer's record SURVIVES: its token is the reconnect credential, and
   * deleting the record deletes the seat's owner, so `reclaim` could never match.
   * A peer that never got a seat has nothing to reclaim and is deleted, so a
   * room does not accumulate ghosts.
   *
   * The slot is freed but the NUMBER IS LEFT on the record, which is what lets
   * reclaim allocate a different one. A disconnected peer is never a send target
   * - RoomTransport.peers() is the connected ones - so the stale number
   * addresses nothing.
   *
   * `lastActivityMs` is deliberately NOT written here: contract §7 makes `touch`
   * its sole writer.
   */
  removePeer(room: RoomRecord, peerId: PeerId, nowMs: number): PeerRecord | null {
    const peer = room.peers.get(peerId)
    if (peer === undefined) return null
    peer.connected = false
    peer.lastSeenMs = nowMs
    room.slotsInUse.delete(peer.slot)
    if (peer.playerId < 0) room.peers.delete(peerId)
    return peer
  }

  /**
   * Token match against a seat whose peer has gone. Returns the revived record
   * with the SAME playerId and a NEW slot, or null when the token is unknown.
   *
   * Three refusals, each of which changes nothing:
   *  - an empty token, which is what every client that has never been welcomed
   *    sends;
   *  - a token whose owner is still CONNECTED - a token is a reconnect
   *    credential, never a takeover, and a leaked one must not evict the player
   *    sitting in the seat;
   *  - a token whose peer never held a seat, which has nothing to reclaim.
   *
   * `room.seats[playerId]` is re-pointed at the new peer id. Contract §7 makes
   * lobby.ts the sole ASSIGNER of seats; this assigns none - it re-points a seat
   * that is already assigned at the same player's new peer. Leaving the vanished
   * id there would keep a peer that is gone authorised in seatMapOf, and leave
   * the returning player unauthorised for their own seat.
   */
  reclaim(room: RoomRecord, token: string, peerId: PeerId, nowMs: number): PeerRecord | null {
    if (token === '') return null
    for (const peer of room.peers.values()) {
      if (peer.token !== token) continue
      if (peer.connected) return null
      if (peer.playerId < 0) return null

      const previousSlot = peer.slot
      room.peers.delete(peer.peerId)
      peer.peerId = peerId
      peer.slot = this.allocSlot(room, previousSlot)
      peer.connected = true
      peer.lastSeenMs = nowMs
      peer.liveness = createLiveness(nowMs)
      room.peers.set(peerId, peer)
      room.slotsInUse.add(peer.slot)
      room.seats[peer.playerId] = peerId
      return peer
    }
    return null
  }

  /** Sole writer of `lastActivityMs`. */
  touch(room: RoomRecord, nowMs: number): void {
    room.lastActivityMs = nowMs
  }

  /** Closes and returns every room idle longer than roomIdleMs. Sole writer of
   * ServerRoomPhase 'closed'. */
  expire(nowMs: number): RoomRecord[] {
    const closed: RoomRecord[] = []
    for (const [code, room] of this.byCode) {
      if (nowMs - room.lastActivityMs >= this.opts.roomIdleMs) {
        room.phase = 'closed'
        this.byCode.delete(code)
        closed.push(room)
      }
    }
    return closed
  }

  rooms(): RoomRecord[] {
    return [...this.byCode.values()]
  }

  size(): number {
    return this.byCode.size
  }

  /**
   * The lowest free slot strictly above `after`, wrapping to the lowest free
   * below it. `after = 0` therefore means "lowest free", which is what keeps a
   * fresh room's slots dense; a reclaim passes its PREVIOUS slot, which is what
   * makes the new one different. Reusing a slot number for a different peer id
   * inside one room re-binds an identity the far side learned from a control
   * frame, and a frame already in flight would land on the wrong peer.
   */
  private allocSlot(room: RoomRecord, after: number): number {
    for (let slot = Math.max(after + 1, MIN_SLOT); slot <= MAX_SLOT; slot++) {
      if (!room.slotsInUse.has(slot)) return slot
    }
    for (let slot = MIN_SLOT; slot <= after && slot <= MAX_SLOT; slot++) {
      if (!room.slotsInUse.has(slot)) return slot
    }
    throw new RoomFullError(`room ${room.code} has no free peer slot`)
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run packages/server/test/random.test.ts packages/server/test/registry.test.ts`

Expected: PASS, 31 tests (10 in `random.test.ts`, 21 in `registry.test.ts`).

Then `npx vitest run packages/server` — expected PASS, Task 16's files included.

`npx tsc --noEmit -p packages/server/tsconfig.json` still reports only `Cannot find module './roomtransport'` from `types.ts`, until contract §5.6's task lands.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/random.ts packages/server/src/registry.ts packages/server/test/random.test.ts packages/server/test/registry.test.ts && git commit -m "feat(server): the two mints and the room table

mintCode draws one byte per character and masks five bits - uniform with no
rejection, which is why the alphabet is 32. RoomRegistry is the sole minter of
codes and tokens and the sole assigner of slots; reclaim returns the same seat
under a new peer id and a new slot, and refuses an empty token, an unknown one,
and one whose owner is still connected."
```
