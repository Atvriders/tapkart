import { describe, expect, it } from 'vitest'
import { WIRE_TAG, decodeHeader, encodeHeader } from '../src/types'
import { HEARTBEAT_BYTES, decodeHeartbeat, encodeHeartbeat } from '../src/control'
import type { HeartbeatMessage } from '../src/control'

const HEADER_BYTES = 2

describe('protocol/control - ping and pong share one codec', () => {
  it('round-trips seq and echoMs at both ends of their ranges', () => {
    const buf = new Uint8Array(HEARTBEAT_BYTES)
    const cases: HeartbeatMessage[] = [
      { seq: 0, echoMs: 0 },
      { seq: 1, echoMs: 1 },
      { seq: 65535, echoMs: 4294967295 },
      { seq: 40000, echoMs: 2147483648 },
    ]
    for (const msg of cases) {
      const n = encodeHeartbeat(buf, msg)
      expect(n).toBe(HEARTBEAT_BYTES)
      expect(decodeHeartbeat(buf.subarray(0, n))).toEqual(msg)
    }
  })

  it('a pong built from a ping is byte-identical in seq and echoMs', () => {
    const ping = new Uint8Array(HEADER_BYTES + HEARTBEAT_BYTES)
    const h = encodeHeader(ping, 'ping')
    encodeHeartbeat(ping.subarray(h), { seq: 4242, echoMs: 1_234_567_890 })

    const received = decodeHeartbeat(ping.subarray(HEADER_BYTES))
    const pong = new Uint8Array(HEADER_BYTES + HEARTBEAT_BYTES)
    const ph = encodeHeader(pong, 'pong')
    encodeHeartbeat(pong.subarray(ph), received)

    expect(pong[0]).toBe(WIRE_TAG.pong)
    expect(ping[0]).toBe(WIRE_TAG.ping)
    expect(decodeHeader(pong).kind).toBe('pong')
    expect(Array.from(pong.subarray(HEADER_BYTES))).toEqual(Array.from(ping.subarray(HEADER_BYTES)))
  })

  it('throws rather than inventing fields on a truncated body', () => {
    const buf = new Uint8Array(HEARTBEAT_BYTES)
    encodeHeartbeat(buf, { seq: 7, echoMs: 9 })
    expect(() => decodeHeartbeat(buf.subarray(0, 5))).toThrow(RangeError)
  })
})
