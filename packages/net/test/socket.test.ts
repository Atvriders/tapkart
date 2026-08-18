import { describe, expect, it } from 'vitest'
import {
  WS_CLOSE_BACKPRESSURE,
  WS_CLOSE_ROOM_CLOSED,
  WS_CLOSE_VERSION_MISMATCH,
} from '../src/socket'
import type { SocketData, SocketLike, SocketReadyState } from '../src/socket'
import * as socketNs from '../src/socket'
import { makeFakeSocketPair, makeRecordingSocket } from './fixtures/socket-fixtures'

/**
 * The application close codes, and the interface every real WebSocket wraps
 * into.
 *
 * 4001 is not a tidy enum member. It is the ONLY channel that crosses a protocol
 * version boundary intact: two peers that cannot agree on a header format can
 * still agree on a 16-bit close code, because RFC 6455 puts it in the frame and
 * not in the payload. That is why the version rejection in contract §3.0 is a
 * close and not a `welcome` - an encoded `welcome` is exactly the thing a
 * mismatched peer cannot read. `RoomClient` maps 4001 onto
 * `error = 'versionMismatch'`, which is what puts "this app is out of date" on
 * the screen instead of a hang, and P5 Q25 (never auto-`skipWaiting`) makes that
 * a ROUTINE event after every deploy rather than an exotic one.
 */

describe('net/socket close codes', () => {
  it('fixes the three application codes at their contract values', () => {
    expect(WS_CLOSE_VERSION_MISMATCH).toBe(4001)
    expect(WS_CLOSE_ROOM_CLOSED).toBe(4002)
    expect(WS_CLOSE_BACKPRESSURE).toBe(4003)
  })

  it('keeps every code inside 4000-4999 and out of every range that is not ours', () => {
    const codes = [WS_CLOSE_VERSION_MISMATCH, WS_CLOSE_ROOM_CLOSED, WS_CLOSE_BACKPRESSURE]
    for (const c of codes) {
      expect(Number.isInteger(c)).toBe(true)
      // 4000-4999 is the range RFC 6455 reserves for private use. Below 4000 is
      // either RFC-defined (1000-1015) or IANA-registered (3000-3999), and a
      // browser rejects a close code outside 3000-4999 with an InvalidAccessError
      // - so a wrong number here is not a mislabel, it is a close that does not
      // happen and a socket that stays open.
      expect(c, `${c} is outside the 4000-4999 private range`).toBeGreaterThanOrEqual(4000)
      expect(c, `${c} is outside the 4000-4999 private range`).toBeLessThanOrEqual(4999)
    }
    // Distinct, in both directions: two codes that collide make one of the two
    // client-side error messages unreachable and nothing fails anywhere.
    expect(new Set(codes).size).toBe(3)
  })

  it('pins SocketLike at exactly six members', () => {
    // keyof, not a cast: this is the whole of what a WebSocket is to everything
    // above the adapter, and both `ws` on the server and the browser's global
    // wrap into it. A renamed member is a transport that compiles and never
    // delivers.
    const surface: (keyof SocketLike)[] =
      ['send', 'close', 'onMessage', 'onClose', 'readyState', 'bufferedAmount']
    expect(surface).toHaveLength(6)
    expect(new Set(surface).size).toBe(6)
  })

  it('carries both frame payload shapes and all four ready states', () => {
    // A WebSocket frame is natively text or binary, and SocketData preserves
    // that: §4.4's signalling rides text while every WIRE_TAG message rides
    // binary, so nothing needs a discriminator byte to tell them apart.
    const text: SocketData = 'offer'
    const binary: SocketData = new Uint8Array([1, 2, 3])
    expect(typeof text).toBe('string')
    expect(binary).toBeInstanceOf(Uint8Array)

    const states: SocketReadyState[] = ['connecting', 'open', 'closing', 'closed']
    expect(new Set(states).size).toBe(4)
  })
})

describe('net/socket - the application close codes', () => {
  it('sits inside RFC 6455\'s private 4000-4999 range, with no two codes equal', () => {
    const codes = [WS_CLOSE_VERSION_MISMATCH, WS_CLOSE_ROOM_CLOSED, WS_CLOSE_BACKPRESSURE]
    expect(codes).toEqual([4001, 4002, 4003])
    expect(new Set(codes).size).toBe(3)
    for (const c of codes) {
      expect(c).toBeGreaterThanOrEqual(4000)
      expect(c).toBeLessThanOrEqual(4999)
    }
  })

  it('contributes exactly three runtime names, because everything else here is a type', () => {
    // The whole point of this module is that it is erased: SocketLike is the
    // seam, and a runtime helper appearing here later would be a decision no
    // adapter test could see.
    expect(Object.keys(socketNs).sort()).toEqual([
      'WS_CLOSE_BACKPRESSURE',
      'WS_CLOSE_ROOM_CLOSED',
      'WS_CLOSE_VERSION_MISMATCH',
    ])
  })
})

describe('net/socket - the fixture pair IS the executable spec of SocketLike', () => {
  it('appends message listeners rather than replacing them, and preserves order', () => {
    const pair = makeFakeSocketPair()
    const seen: string[] = []
    pair.b.onMessage((d) => seen.push(`first:${String(d)}`))
    pair.b.onMessage((d) => seen.push(`second:${String(d)}`))

    pair.a.send('hello')
    pair.flush()

    expect(seen).toEqual(['first:hello', 'second:hello'])
  })

  it('appends close listeners and hands both the code', () => {
    const s = makeRecordingSocket()
    const codes: number[] = []
    s.onClose((c) => codes.push(c))
    s.onClose((c) => codes.push(c * 10))

    s.fireClose(WS_CLOSE_VERSION_MISMATCH)

    expect(codes).toEqual([4001, 40010])
    expect(s.readyState()).toBe('closed')
  })

  it('keeps text and binary distinct, which is the whole channel split', () => {
    // §4.1: signalling rides text, every WIRE_TAG message rides binary, and
    // nothing needs a discriminator byte. A fixture that stringified a
    // Uint8Array would make that split untestable and every signalling test
    // would pass against a transport that got it wrong.
    const pair = makeFakeSocketPair()
    const got: SocketData[] = []
    pair.b.onMessage((d) => got.push(d))

    pair.a.send('{"v":1}')
    pair.a.send(new Uint8Array([0x11, 0x02, 0x7f]))
    pair.flush()

    expect(got).toHaveLength(2)
    expect(typeof got[0]).toBe('string')
    expect(got[0]).toBe('{"v":1}')
    expect(got[1]).toBeInstanceOf(Uint8Array)
    expect(Array.from(got[1] as Uint8Array)).toEqual([0x11, 0x02, 0x7f])
  })

  it('drives bufferedAmount from stall() and drain(), and still delivers while stalled', () => {
    const pair = makeFakeSocketPair()
    const got: SocketData[] = []
    pair.b.onMessage((d) => got.push(d))

    expect(pair.a.bufferedAmount()).toBe(0)
    pair.stall(1 << 21)
    expect(pair.a.bufferedAmount()).toBe(1 << 21)

    // A stalled socket is slow, not disconnected: the frame still arrives.
    pair.a.send(new Uint8Array([1, 2, 3]))
    pair.flush()
    expect(got).toHaveLength(1)

    pair.drain()
    expect(pair.a.bufferedAmount()).toBe(0)
  })

  it('closes both ends, so the far side can see a socket die', () => {
    const pair = makeFakeSocketPair()
    const aCodes: number[] = []
    const bCodes: number[] = []
    pair.a.onClose((c) => aCodes.push(c))
    pair.b.onClose((c) => bCodes.push(c))

    pair.b.close(WS_CLOSE_ROOM_CLOSED)

    expect(bCodes).toEqual([4002])
    expect(aCodes).toEqual([4002])
    expect(pair.a.readyState()).toBe('closed')

    // Idempotent, and nothing is delivered afterwards.
    const late: SocketData[] = []
    pair.b.onMessage((d) => late.push(d))
    pair.b.close(WS_CLOSE_ROOM_CLOSED)
    pair.a.send('too late')
    pair.flush()
    expect(bCodes).toEqual([4002])
    expect(late).toEqual([])
  })

  it('records what a transport sent, as copies rather than views', () => {
    const s = makeRecordingSocket()
    const scratch = new Uint8Array([0x00, 0x01, 0x02])
    s.send(scratch)
    // The sender reuses its buffer; a fixture holding a view would rewrite
    // history and every "frame 0 was X" assertion in this package would be an
    // assertion about the newest frame instead.
    scratch[0] = 0xff
    s.send('text')

    expect(s.sentBinary()).toHaveLength(1)
    expect(Array.from(s.sentBinary()[0])).toEqual([0x00, 0x01, 0x02])
    expect(s.sentText()).toEqual(['text'])
    expect(s.bufferedAmount()).toBe(3 + 'text'.length)
  })
})
