import { describe, expect, it } from 'vitest'
import type { LogEvent } from '../src/log'
import { formatLogEvent, makeMemoryLogSink, nullLogSink } from '../src/log'

const ONE_OF_EACH: readonly LogEvent[] = [
  { kind: 'roomCreated', code: 'ABCDE' },
  { kind: 'roomExpired', code: 'ABCDE', ageMs: 600_000 },
  { kind: 'peerJoined', code: 'ABCDE', playerId: 2, relay: true },
  { kind: 'peerLeft', code: 'ABCDE', playerId: 2 },
  { kind: 'peerReclaimed', code: 'ABCDE', playerId: 2 },
  { kind: 'raceStarted', code: 'ABCDE', seed: 987_654, trackId: 'caldera' },
  { kind: 'promotion', code: 'ABCDE', tick: 612, eventSeq: 44 },
  { kind: 'checkpointSent', code: 'ABCDE', playerId: 3, reason: 'divergence' },
  { kind: 'relayFirst', code: 'ABCDE', failures: 2 },
  { kind: 'rejected', code: 'ZZZZZ', result: 'roomNotFound' },
  { kind: 'badFrame', code: 'ABCDE', peerId: 'peer7', why: 'wsFrame' },
]

describe('LogEvent', () => {
  it('has eleven kinds and every one of them is distinct', () => {
    expect(ONE_OF_EACH).toHaveLength(11)
    expect(new Set(ONE_OF_EACH.map((e) => e.kind)).size).toBe(11)
  })

  it('carries no name and no token, in any member', () => {
    const allowed = new Set([
      'kind', 'code', 'ageMs', 'playerId', 'relay', 'seed', 'trackId',
      'tick', 'eventSeq', 'reason', 'failures', 'result', 'peerId', 'why',
    ])
    expect(allowed.has('name')).toBe(false)
    expect(allowed.has('token')).toBe(false)
    for (const ev of ONE_OF_EACH) {
      for (const key of Object.keys(ev)) {
        expect(allowed.has(key), key + ' on ' + ev.kind).toBe(true)
      }
    }
  })
})

describe('formatLogEvent', () => {
  it('writes one line per event, with the fields the union declares', () => {
    expect(formatLogEvent({ kind: 'roomCreated', code: 'ABCDE' }, 1000))
      .toBe('1000 roomCreated code=ABCDE')
    expect(formatLogEvent({ kind: 'promotion', code: 'ABCDE', tick: 612, eventSeq: 44 }, 12_345))
      .toBe('12345 promotion code=ABCDE tick=612 eventSeq=44')
    expect(formatLogEvent({ kind: 'checkpointSent', code: 'ABCDE', playerId: 3, reason: 'divergence' }, 7))
      .toBe('7 checkpointSent code=ABCDE playerId=3 reason=divergence')
    expect(formatLogEvent({ kind: 'peerJoined', code: 'ABCDE', playerId: 2, relay: true }, 0))
      .toBe('0 peerJoined code=ABCDE playerId=2 relay=true')
    expect(formatLogEvent({ kind: 'rejected', code: 'ZZZZZ', result: 'rateLimited' }, 9))
      .toBe('9 rejected code=ZZZZZ result=rateLimited')
  })

  it('formats every kind without throwing, and never emits a second line', () => {
    for (const ev of ONE_OF_EACH) {
      const line = formatLogEvent(ev, 42)
      expect(line.startsWith('42 ' + ev.kind + ' ')).toBe(true)
      expect(line.includes('\n')).toBe(false)
      expect(line.includes('\r')).toBe(false)
    }
  })

  it('collapses whitespace in `why`, so one event is always one line', () => {
    const line = formatLogEvent(
      { kind: 'badFrame', code: 'ABCDE', peerId: 'peer7', why: 'bad\nframe here' }, 5,
    )
    expect(line).toBe('5 badFrame code=ABCDE peerId=peer7 why=bad_frame_here')
  })
})

describe('the sinks', () => {
  it('nullLogSink accepts everything and keeps nothing', () => {
    for (const ev of ONE_OF_EACH) nullLogSink.write(ev, 0)
    expect(Object.keys(nullLogSink)).toEqual(['write'])
  })

  it('makeMemoryLogSink keeps every event, in order', () => {
    const sink = makeMemoryLogSink()
    expect(sink.events()).toEqual([])
    for (const ev of ONE_OF_EACH) sink.write(ev, 0)
    expect(sink.events()).toHaveLength(11)
    expect(sink.events()[0].kind).toBe('roomCreated')
    expect(sink.events()[10].kind).toBe('badFrame')
  })

  it('makeMemoryLogSink hands out a list the caller cannot grow', () => {
    const sink = makeMemoryLogSink()
    sink.write({ kind: 'roomCreated', code: 'ABCDE' }, 0)
    const first = sink.events()
    sink.write({ kind: 'roomCreated', code: 'FGHJK' }, 1)
    expect(first).toHaveLength(1)
    expect(sink.events()).toHaveLength(2)
  })
})
