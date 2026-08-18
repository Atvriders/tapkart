import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import type { SignalEnvelope, SignalMessage } from '../src/signal'
import { SIGNAL_MAX_BYTES, SIGNAL_VERSION, encodeSignal, parseSignal } from '../src/signal'

const CANDIDATE = {
  candidate: 'candidate:1 1 udp 2113937151 192.0.2.7 50000 typ host',
  sdpMid: '0',
  sdpMLineIndex: 0,
}

const MESSAGES: SignalMessage[] = [
  { t: 'offer', sdp: 'v=0\r\no=- 1 1 IN IP4 192.0.2.1\r\n' },
  { t: 'answer', sdp: 'v=0\r\no=- 2 1 IN IP4 192.0.2.2\r\n' },
  { t: 'ice', c: CANDIDATE },
  { t: 'ice', c: { candidate: 'a=end-of-candidates', sdpMid: null, sdpMLineIndex: null } },
  { t: 'iceDone' },
  { t: 'giveUp', reason: 'timeout' },
]

/** The canonical good envelope, re-parsed after every hostile input below. */
const GOOD: SignalEnvelope = { v: SIGNAL_VERSION, from: 3, to: 1, msg: { t: 'iceDone' } }

describe('net/signal - the envelope round-trips', () => {
  it('carries every message kind through encode and back', () => {
    for (const msg of MESSAGES) {
      const env: SignalEnvelope = { v: SIGNAL_VERSION, from: 1, to: 254, msg }
      const parsed = parseSignal(encodeSignal(env))
      expect(parsed, JSON.stringify(msg)).toEqual(env)
    }
  })

  it('keeps from/to in the SLOT address space, so signalling and framing share one', () => {
    for (const slot of [0, 1, 127, 254, 255]) {
      const env: SignalEnvelope = { v: SIGNAL_VERSION, from: slot, to: slot, msg: { t: 'iceDone' } }
      expect(parseSignal(encodeSignal(env))).toEqual(env)
    }
  })
})

describe('net/signal - parseSignal is total', () => {
  const hostile: Array<[string, string]> = [
    ['empty string', ''],
    ['whitespace', '   '],
    ['truncated JSON', '{"v":1,"from":1,"to":2,"msg":{"t":"offe'],
    ['JSON array', '[1,2,3]'],
    ['JSON string', '"hello"'],
    ['JSON number', '42'],
    ['JSON null', 'null'],
    ['no version', '{"from":1,"to":2,"msg":{"t":"iceDone"}}'],
    ['wrong version', '{"v":2,"from":1,"to":2,"msg":{"t":"iceDone"}}'],
    ['version as string', '{"v":"1","from":1,"to":2,"msg":{"t":"iceDone"}}'],
    ['from missing', '{"v":1,"to":2,"msg":{"t":"iceDone"}}'],
    ['from out of slot range', '{"v":1,"from":256,"to":2,"msg":{"t":"iceDone"}}'],
    ['from negative', '{"v":1,"from":-1,"to":2,"msg":{"t":"iceDone"}}'],
    ['from fractional', '{"v":1,"from":1.5,"to":2,"msg":{"t":"iceDone"}}'],
    ['to as string', '{"v":1,"from":1,"to":"2","msg":{"t":"iceDone"}}'],
    ['msg missing', '{"v":1,"from":1,"to":2}'],
    ['msg is an array', '{"v":1,"from":1,"to":2,"msg":[]}'],
    ['unknown t', '{"v":1,"from":1,"to":2,"msg":{"t":"hangUp"}}'],
    ['t missing', '{"v":1,"from":1,"to":2,"msg":{"sdp":"x"}}'],
    ['sdp is a number', '{"v":1,"from":1,"to":2,"msg":{"t":"offer","sdp":5}}'],
    ['sdp missing', '{"v":1,"from":1,"to":2,"msg":{"t":"answer"}}'],
    ['ice c missing', '{"v":1,"from":1,"to":2,"msg":{"t":"ice"}}'],
    ['ice candidate not a string', '{"v":1,"from":1,"to":2,"msg":{"t":"ice","c":{"candidate":7,"sdpMid":null,"sdpMLineIndex":null}}}'],
    ['ice sdpMid a number', '{"v":1,"from":1,"to":2,"msg":{"t":"ice","c":{"candidate":"x","sdpMid":3,"sdpMLineIndex":null}}}'],
    ['ice sdpMLineIndex a string', '{"v":1,"from":1,"to":2,"msg":{"t":"ice","c":{"candidate":"x","sdpMid":null,"sdpMLineIndex":"0"}}}'],
    ['giveUp reason missing', '{"v":1,"from":1,"to":2,"msg":{"t":"giveUp"}}'],
    ['__proto__ at the envelope', '{"v":1,"from":1,"to":2,"msg":{"t":"iceDone"},"__proto__":{"polluted":true}}'],
    ['constructor at the envelope', '{"v":1,"from":1,"to":2,"msg":{"t":"iceDone"},"constructor":{"prototype":{"x":1}}}'],
    ['a megabyte of sdp', `{"v":1,"from":1,"to":2,"msg":{"t":"offer","sdp":"${'a'.repeat(1024 * 1024)}"}}`],
    ['a megabyte of nothing', 'a'.repeat(1024 * 1024)],
  ]

  it('returns null - never throws - on every hostile input, and still parses the next good one', () => {
    // The single most attacker-reachable function in the project: the server
    // calls it on every text frame from every socket. A validator that rejected
    // EVERYTHING would satisfy "never throws" and break every connection, so
    // each row re-parses the good envelope immediately afterwards.
    for (const [label, text] of hostile) {
      let result: unknown = 'threw'
      expect(() => {
        result = parseSignal(text)
      }, label).not.toThrow()
      expect(result, label).toBeNull()
      expect(parseSignal(encodeSignal(GOOD)), `good envelope after: ${label}`).toEqual(GOOD)
    }
    expect(hostile.length).toBeGreaterThanOrEqual(20)
  })

  it('rejects anything past SIGNAL_MAX_BYTES without parsing it', () => {
    const sdp = 'a'.repeat(SIGNAL_MAX_BYTES)
    expect(parseSignal(`{"v":1,"from":1,"to":2,"msg":{"t":"offer","sdp":"${sdp}"}}`)).toBeNull()
    // And an SDP with many candidates - the case the cap is sized for - still
    // goes through.
    const realistic = 'v=0\r\n' + 'a=candidate:1 1 udp 2113937151 192.0.2.7 50000 typ host\r\n'.repeat(60)
    const env: SignalEnvelope = { v: SIGNAL_VERSION, from: 1, to: 2, msg: { t: 'offer', sdp: realistic } }
    expect(encodeSignal(env).length).toBeLessThan(SIGNAL_MAX_BYTES)
    expect(parseSignal(encodeSignal(env))).toEqual(env)
  })

  it('measures the cap in UTF-8 bytes and never throws on malformed surrogates', () => {
    // Six thousand CJK code points fit comfortably under the UTF-16 code-unit
    // prefilter while exceeding the wire's byte cap by more than 1.5 KiB.
    const multibyte = encodeSignal({
      v: SIGNAL_VERSION,
      from: 1,
      to: 2,
      msg: { t: 'offer', sdp: '界'.repeat(6000) },
    })
    expect(multibyte.length).toBeLessThan(SIGNAL_MAX_BYTES)
    expect(Buffer.byteLength(multibyte, 'utf8')).toBeGreaterThan(SIGNAL_MAX_BYTES)
    expect(parseSignal(multibyte)).toBeNull()

    // A lone surrogate is encoded as U+FFFD (three UTF-8 bytes). The byte scan
    // must apply that rule without encodeURIComponent-style URIError throws.
    const malformed = `{"v":1,"from":1,"to":2,"msg":{"t":"offer","sdp":"${'\ud800'.repeat(6000)}"}}`
    expect(malformed.length).toBeLessThan(SIGNAL_MAX_BYTES)
    expect(Buffer.byteLength(malformed, 'utf8')).toBeGreaterThan(SIGNAL_MAX_BYTES)
    let result: unknown = 'threw'
    expect(() => {
      result = parseSignal(malformed)
    }).not.toThrow()
    expect(result).toBeNull()
  })

  it('builds a fresh object literal, so no key of a hostile payload survives', () => {
    // An unknown key anywhere is a reject, at all three levels.
    expect(parseSignal('{"v":1,"from":1,"to":2,"admin":true,"msg":{"t":"iceDone"}}')).toBeNull()
    expect(parseSignal('{"v":1,"from":1,"to":2,"msg":{"t":"iceDone","extra":1}}')).toBeNull()
    expect(
      parseSignal(
        '{"v":1,"from":1,"to":2,"msg":{"t":"ice","c":{"candidate":"x","sdpMid":null,"sdpMLineIndex":null,"evil":1}}}',
      ),
    ).toBeNull()

    const env = parseSignal(
      '{"v":1,"from":1,"to":2,"msg":{"t":"ice","c":{"candidate":"x","sdpMid":null,"sdpMLineIndex":null}}}',
    )
    expect(env).not.toBeNull()
    if (env === null) return

    expect(Object.getPrototypeOf(env)).toBe(Object.prototype)
    expect(Object.keys(env).sort()).toEqual(['from', 'msg', 'to', 'v'])
    expect(Object.hasOwn(env, '__proto__')).toBe(false)
    expect(Object.keys(env.msg).sort()).toEqual(['c', 't'])
    if (env.msg.t !== 'ice') throw new Error('expected an ice message')
    expect(Object.keys(env.msg.c).sort()).toEqual(['candidate', 'sdpMLineIndex', 'sdpMid'])
    // Nothing anywhere in the process was polluted by the payload above.
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined()
  })
})
