import { describe, expect, it } from 'vitest'
import { PROTOCOL_VERSION, WIRE_TAG, decodeHeader, encodeHeader } from '../src/types'
import type { MessageKind } from '../src/types'
import { ROOM_CODE_LENGTH } from '../src/room'

/**
 * THE VERSION BOUNDARY.
 *
 * `ROOM_CODE_LENGTH` went 4 -> 5 (F-P4-34), which changes `hello`'s bit layout
 * by five bits. That is a breaking wire change, so v1 and v2 cannot interoperate
 * and the version byte must say so. F-P4-11's "adding tags is additive" is true
 * of `clientUpdate` and `resyncRequest` and FALSE of the room code, and the two
 * land in the same release.
 *
 * The assertions below are byte-level on purpose. The whole rejection path in
 * contract §3.0 rests on one physical fact - that the version lives at
 * `data[1]`, at a fixed offset, in a fixed-format 2-byte header, for every
 * message kind and every version this protocol will ever have. `RoomHub` reads
 * that byte BEFORE the datagram guard, because a v1 `hello` dropped silently by
 * the guard is a player watching a spinner forever. A test that only asserted
 * `PROTOCOL_VERSION === 2` would say nothing about the offset the rejection
 * depends on.
 */

const ALL_KINDS: MessageKind[] = [
  'hello', 'welcome', 'lobby', 'start', 'clientUpdate',
  'input', 'snapshot', 'events', 'checkpoint', 'resyncRequest',
  'authorityChange', 'ping', 'pong',
]

describe('PROTOCOL_VERSION 2', () => {
  it('is 2, because five-character room codes moved hello by five bits', () => {
    expect(PROTOCOL_VERSION).toBe(2)
    // The cause, asserted beside the effect. If ROOM_CODE_LENGTH ever changes
    // again, this pair is what says the version must move with it.
    expect(ROOM_CODE_LENGTH).toBe(5)
    expect(ROOM_CODE_LENGTH * 5).toBe(25) // hello's roomCode field, in bits
  })

  it('writes [tag, 2] for all thirteen kinds - exact bytes, exact offsets', () => {
    expect(ALL_KINDS).toHaveLength(13)
    for (const kind of ALL_KINDS) {
      const out = new Uint8Array(4).fill(0xff)
      expect(encodeHeader(out, kind), `${kind}: header is not 2 bytes`).toBe(2)
      // Byte for byte, and the tag is quoted from WIRE_TAG rather than restated,
      // because relabelling a tag is Task 15c's business and not this test's.
      expect(Array.from(out.subarray(0, 2)), `${kind}: wrong header bytes`)
        .toEqual([WIRE_TAG[kind], 2])
      // encodeHeader writes only its own two bytes.
      expect(out[2]).toBe(0xff)
    }
  })

  it('puts the version at index 1 for every kind, which is what makes the pre-guard read legal', () => {
    // §3.0's RoomHub reads `data[1]` DIRECTLY, before the datagram guard and
    // before any decode. That is only sound because the offset does not vary by
    // kind and cannot vary by version. This walks all thirteen and asserts it.
    for (const kind of ALL_KINDS) {
      const frame = new Uint8Array(2)
      encodeHeader(frame, kind)
      expect(frame[1], `${kind}: the version byte is not at index 1`).toBe(PROTOCOL_VERSION)
    }
  })

  it('rejects a version-1 frame of every kind, and the version is readable without decoding it', () => {
    for (const kind of ALL_KINDS) {
      // Exactly the bytes a v1 client puts on the wire.
      const v1 = new Uint8Array([WIRE_TAG[kind], 1])
      // The pre-guard read: no decode, no throw, just a byte.
      expect(v1[1], `${kind}: a v1 frame does not read as version 1 at index 1`).toBe(1)
      expect(() => decodeHeader(v1), `${kind}: a v1 frame was accepted`)
        .toThrow(/protocol version mismatch/)
    }
  })

  it('accepts exactly one version byte out of all 256, for a valid tag', () => {
    // The whole code space, not a spot check. A decoder that accepted a RANGE of
    // versions, or that compared with `>=`, passes a two-value test and fails
    // here - and a peer built next year speaking v3 must be rejected by this
    // build exactly as v1 is.
    const accepted: number[] = []
    for (let v = 0; v < 256; v++) {
      const frame = new Uint8Array([WIRE_TAG.hello, v])
      try {
        const h = decodeHeader(frame)
        expect(h.kind).toBe('hello')
        expect(h.protocolVersion).toBe(v)
        accepted.push(v)
      } catch {
        // rejected, which is the expected outcome for 255 of the 256
      }
    }
    expect(accepted).toEqual([2])
  })

  it('checks the tag before the version, so an unknown tag reports as an unknown tag', () => {
    // Order matters for the log line: `rejected { versionMismatch }` must not be
    // written for a frame whose tag byte is garbage, or a deploy's real symptom
    // is buried under noise from a port scanner.
    const bogus = new Uint8Array([0x99, 1])
    expect(() => decodeHeader(bogus)).toThrow(/unknown wire tag/)
  })
})
