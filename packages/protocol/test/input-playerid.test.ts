import { describe, expect, it } from 'vitest'
import type { InputDatagram } from '@tapkart/protocol'
import { INPUT_REDUNDANCY, decodeInput, encodeHeader, encodeInput, playerIdOfInput } from '@tapkart/protocol'
import type { Intent } from '@tapkart/sim'
import { MAX_KARTS } from '@tapkart/sim'

function window(tick: number): Intent[] {
  const out: Intent[] = []
  for (let i = 0; i < INPUT_REDUNDANCY; i++) {
    out.push({ tick: tick - (INPUT_REDUNDANCY - 1 - i), steer: -0.25, accel: 0.75, brake: true, drift: false, useItem: true })
  }
  return out
}

function emptyDatagram(): InputDatagram {
  const intents: Intent[] = []
  for (let i = 0; i < INPUT_REDUNDANCY; i++) {
    intents.push({ tick: 0, steer: 0, accel: 0, brake: false, drift: false, useItem: false })
  }
  return { playerId: -1, intents }
}

describe('playerIdOfInput', () => {
  it('agrees with decodeInput over every seat', () => {
    for (let seat = 0; seat < MAX_KARTS; seat++) {
      const buf = new Uint8Array(256)
      const h = encodeHeader(buf, 'input')
      const n = encodeInput(buf.subarray(h), seat, window(40))
      const datagram = buf.slice(0, h + n)

      const out = emptyDatagram()
      decodeInput(datagram.subarray(h), out)

      expect(playerIdOfInput(datagram)).toBe(out.playerId)
      expect(playerIdOfInput(datagram)).toBe(seat)
    }
  })

  it('returns -1 rather than 0 on a buffer too short to hold the claim', () => {
    expect(playerIdOfInput(new Uint8Array(0))).toBe(-1)
    expect(playerIdOfInput(new Uint8Array(1))).toBe(-1)
    expect(playerIdOfInput(new Uint8Array(2))).toBe(-1)
  })

  it('never throws, whatever the bytes are', () => {
    for (let b = 0; b < 256; b++) {
      expect(() => playerIdOfInput(new Uint8Array([0x10, 2, b]))).not.toThrow()
    }
  })
})
