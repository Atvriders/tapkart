import { describe, expect, it } from 'vitest'
import type { AuthEvent, AuthEventKind } from '@tapkart/sim'
import { decodeEvents, encodeEvents } from '../src/events'

describe('encodeEvents / decodeEvents', () => {
  it('round-trips all eight AuthEventKinds, including the race-level finish (playerId -1)', () => {
    // Values below mirror real emit() call sites, verified by reading
    // packages/sim/src: itemGrant (items.ts:136), entitySpawn/entityDespawn/
    // hit (entity.ts:76,97,256,258), spinOut (recovery.ts:66), respawn
    // (recovery.ts:162), lapCross (laps.ts:97), finish, both per-kart
    // (laps.ts:107, phase.ts:219) and race-level with playerId -1
    // (phase.ts:226).
    const events: AuthEvent[] = [
      { eventSeq: 0, tick: 100, kind: 'itemGrant', playerId: 3, entityId: -1, item: 'boost', data: 12 },
      { eventSeq: 1, tick: 101, kind: 'entitySpawn', playerId: 3, entityId: 145, item: 'boost', data: 600 },
      { eventSeq: 2, tick: 250, kind: 'entityDespawn', playerId: 3, entityId: 145, item: 'boost', data: 0 },
      { eventSeq: 3, tick: 260, kind: 'hit', playerId: 5, entityId: 146, item: 'seeker', data: 1 },
      { eventSeq: 4, tick: 261, kind: 'hit', playerId: 6, entityId: 147, item: 'bolt', data: 0 },
      { eventSeq: 5, tick: 300, kind: 'spinOut', playerId: 2, entityId: -1, item: 'none', data: 60 },
      { eventSeq: 6, tick: 360, kind: 'respawn', playerId: 2, entityId: -1, item: 'none', data: 72 },
      { eventSeq: 7, tick: 500, kind: 'lapCross', playerId: 0, entityId: -1, item: 'none', data: 2 },
      { eventSeq: 8, tick: 3600, kind: 'finish', playerId: 4, entityId: -1, item: 'none', data: 1 },
      { eventSeq: 9, tick: 3600, kind: 'finish', playerId: -1, entityId: -1, item: 'none', data: 8 },
    ]

    const buf = new Uint8Array(256)
    const n = encodeEvents(buf, events)

    // header 16 bits + 10 events * 108 bits = 1096 bits = 137 bytes
    expect(n).toBe(137)

    const out: AuthEvent[] = [
      { eventSeq: -1, tick: -1, kind: 'hit', playerId: -1, entityId: -1, item: 'none', data: -1 },
    ]
    decodeEvents(buf.subarray(0, n), out)

    expect(out.length).toBe(events.length)
    for (let i = 0; i < events.length; i++) {
      expect(out[i]).toEqual(events[i])
    }

    // The specific hazard this task exists to guard: a negative playerId
    // must survive the round trip, exactly.
    expect(Object.is(out[9]!.playerId, -1)).toBe(true)
    expect(out[9]!.kind).toBe('finish')

    // entityId -1 (not applicable) and a real spawned id both survive.
    expect(out[0]!.entityId).toBe(-1)
    expect(out[1]!.entityId).toBe(145)

    // item 'none' (unused) and a real item both survive.
    expect(out[5]!.item).toBe('none')
    expect(out[1]!.item).toBe('boost')
  })

  it('clears out before decoding, rather than appending to it', () => {
    const single: AuthEvent[] = [
      { eventSeq: 42, tick: 7, kind: 'lapCross', playerId: 1, entityId: -1, item: 'none', data: 1 },
    ]
    const buf = new Uint8Array(64)
    const n = encodeEvents(buf, single)

    const out: AuthEvent[] = [
      { eventSeq: 0, tick: 0, kind: 'hit', playerId: 0, entityId: 0, item: 'none', data: 0 },
      { eventSeq: 0, tick: 0, kind: 'hit', playerId: 0, entityId: 0, item: 'none', data: 0 },
      { eventSeq: 0, tick: 0, kind: 'hit', playerId: 0, entityId: 0, item: 'none', data: 0 },
    ]
    decodeEvents(buf.subarray(0, n), out)

    expect(out.length).toBe(1)
    expect(out[0]).toEqual(single[0])
  })

  it('round-trips a zero-event batch', () => {
    const buf = new Uint8Array(16)
    const n = encodeEvents(buf, [])
    expect(n).toBe(2) // 16-bit count only

    const out: AuthEvent[] = [
      { eventSeq: 9, tick: 9, kind: 'hit', playerId: 9, entityId: 9, item: 'none', data: 9 },
    ]
    decodeEvents(buf.subarray(0, n), out)
    expect(out.length).toBe(0)
  })

  it('survives data and entityId at their representable extremes', () => {
    const events: AuthEvent[] = [
      { eventSeq: 100, tick: 200, kind: 'entitySpawn', playerId: 0, entityId: 0, item: 'seeker', data: 0 },
      { eventSeq: 101, tick: 201, kind: 'entitySpawn', playerId: 7, entityId: 131070, item: 'charge', data: 65535 },
    ]
    const buf = new Uint8Array(64)
    const n = encodeEvents(buf, events)
    const out: AuthEvent[] = []
    decodeEvents(buf.subarray(0, n), out)

    expect(out[0]!.entityId).toBe(0)
    expect(out[0]!.data).toBe(0)
    // 131070 = 2^17 - 2: the largest entityId the 17-bit, +1-biased field can
    // hold (wire max is 2^17 - 1 = 131071, reserved for entityId 131070).
    expect(out[1]!.entityId).toBe(131070)
    // 65535 = 2^16 - 1: the unsigned max of the 16-bit data field.
    expect(out[1]!.data).toBe(65535)
  })

  it('throws on an unrecognised AuthEventKind rather than silently miscoding it', () => {
    const bogus: AuthEvent[] = [
      { eventSeq: 0, tick: 0, kind: 'bogus' as AuthEventKind, playerId: 0, entityId: -1, item: 'none', data: 0 },
    ]
    const buf = new Uint8Array(32)
    expect(() => encodeEvents(buf, bogus)).toThrow(/AuthEventKind/)
  })
})

describe('decodeEvents is all-or-nothing on `out` (ruling P2-R20, applied at the codec)', () => {
  /**
   * `out.length = 0` used to run BEFORE the decode loop, so a batch that threw on
   * event 3 left three events behind in a caller-owned array.
   *
   * A documented invariant is not the fix. That is what ruling P2-R20 already
   * rejected for BitReader - "a per-call-site length check works too but must be
   * repeated forever, and the next codec forgets" - and Plan 4's most likely new
   * caller is a client applying events straight into live state on the reliable
   * channel, where three half-applied events are three authoritative facts that
   * nothing will ever retract.
   */
  const good = (eventSeq: number): AuthEvent => ({
    eventSeq, tick: 10, kind: 'lapCross', playerId: 1, entityId: -1, item: 'none', data: 1,
  })

  /** Three good events then one whose item code is in the seven-wide hole. */
  function batchWithBadFourthEvent(): Uint8Array {
    const buf = new Uint8Array(256)
    const n = encodeEvents(buf, [good(0), good(1), good(2), good(3)])
    const frame = buf.slice(0, n)
    // 16-bit count + 3 whole events (108 bits each) + the fourth event's
    // eventSeq(32) + tick(32) + kind(3) + playerId(4) + entityId(17) = the item
    // field's first bit. Located by arithmetic on the codec's own widths rather
    // than by a magic number, and checked below by the throw it produces.
    const itemBit = 16 + 3 * 108 + 32 + 32 + 3 + 4 + 17
    for (let i = 0; i < 4; i++) {
      const bit = itemBit + i
      if ((15 >> i) & 1) frame[bit >> 3] |= 1 << (bit & 7)
      else frame[bit >> 3] &= ~(1 << (bit & 7))
    }
    return frame
  }

  it('leaves a populated `out` exactly as it was when the batch is rejected', () => {
    const out: AuthEvent[] = []
    const buf = new Uint8Array(256)
    const n = encodeEvents(buf, [good(90), good(91)])
    decodeEvents(buf.subarray(0, n), out)
    expect(out).toHaveLength(2)
    const first = out[0]

    expect(() => decodeEvents(batchWithBadFourthEvent(), out)).toThrow(RangeError)

    // Not three events from the rejected batch, and not zero either: exactly
    // what the caller held before the call.
    expect(out, 'a rejected batch left its good prefix in the caller\'s array').toHaveLength(2)
    expect(out[0], 'a rejected batch replaced the objects the caller already had').toBe(first)
    expect(out[0].eventSeq).toBe(90)
    expect(out[1].eventSeq).toBe(91)
  })

  it('leaves an empty `out` empty, rather than three-quarters full', () => {
    const out: AuthEvent[] = []
    expect(() => decodeEvents(batchWithBadFourthEvent(), out)).toThrow(RangeError)
    expect(out, 'the three events ahead of the bad one were committed').toHaveLength(0)
  })

  it('still commits a good batch, so the guard is not simply refusing everything', () => {
    const out: AuthEvent[] = [good(7)]
    const buf = new Uint8Array(256)
    const n = encodeEvents(buf, [good(0), good(1), good(2), good(3)])
    decodeEvents(buf.subarray(0, n), out)
    expect(out).toHaveLength(4)
    expect(out.map((e) => e.eventSeq)).toEqual([0, 1, 2, 3])
  })
})
