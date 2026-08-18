import { describe, expect, it } from 'vitest'
import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH, SESSION_TOKEN_LENGTH } from '@tapkart/protocol'
import type { RandomSource } from '../src/random'
import { mintCode, mintRaceSeed, mintRoomCode, mintSessionToken } from '../src/random'

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
    expect(mintRaceSeed(rand)).toBe(50_462_976)
    expect(rand.bytesAsked()).toEqual([4])
  })

  it('is never negative, whatever the high bit does', () => {
    const highBit: RandomSource = () => new Uint8Array([0xff, 0xff, 0xff, 0xff])
    expect(mintRaceSeed(highBit)).toBe(4_294_967_295)
    expect(mintRaceSeed(highBit)).toBeGreaterThanOrEqual(0)
  })
})
