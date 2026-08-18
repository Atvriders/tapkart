import { describe, expect, it } from 'vitest'
import type { ChannelName } from '@tapkart/protocol'
import { WIRE_TAG, encodeHeader } from '@tapkart/protocol'
import {
  WS_CHANNEL_RELIABLE,
  WS_CHANNEL_UNRELIABLE,
  WS_CONTROL_PEER_GONE,
  WS_CONTROL_PEER_JOINED,
  WS_FRAME_CONTROL,
  WS_FRAME_DATA,
  WS_HEADER_BYTES,
  WS_SLOT_BROADCAST,
  WS_SLOT_SERVER,
  byteOfChannel,
  channelOfByte,
  decodeWsFrame,
  encodeWsControl,
  encodeWsData,
} from '../src/wsframe'

const CHANNELS: ChannelName[] = ['unreliable', 'reliable']

describe('net/wsframe - the three-byte envelope', () => {
  it('pins the byte layout, because both ends are built at different times', () => {
    expect([WS_FRAME_DATA, WS_FRAME_CONTROL]).toEqual([0x00, 0x01])
    expect([WS_CHANNEL_UNRELIABLE, WS_CHANNEL_RELIABLE]).toEqual([0x00, 0x01])
    expect([WS_SLOT_SERVER, WS_SLOT_BROADCAST]).toEqual([0x00, 0xff])
    expect([WS_CONTROL_PEER_JOINED, WS_CONTROL_PEER_GONE]).toEqual([0x00, 0x01])
    expect(WS_HEADER_BYTES).toBe(3)
  })

  it('round-trips every data frame, over both channels and every slot', () => {
    const payload = new Uint8Array(8)
    const h = encodeHeader(payload, 'snapshot')
    payload[h] = 0xab
    const out = new Uint8Array(64)

    for (const channel of CHANNELS) {
      for (const slot of [WS_SLOT_SERVER, 1, 7, 254, WS_SLOT_BROADCAST]) {
        const n = encodeWsData(out, channel, slot, payload)
        expect(n).toBe(WS_HEADER_BYTES + payload.length)

        const frame = decodeWsFrame(out.subarray(0, n))
        expect(frame).not.toBeNull()
        if (frame === null) return
        expect(frame.frameKind).toBe(WS_FRAME_DATA)
        expect(frame.channel).toBe(channel)
        expect(frame.controlOp).toBeNull()
        expect(frame.peerSlot).toBe(slot)
        expect(Array.from(frame.payload)).toEqual(Array.from(payload))
        // The tag the transport reads to key its mailbox is payload[0] and
        // nothing else - the envelope never decodes a message.
        expect(frame.payload[0]).toBe(WIRE_TAG.snapshot)
      }
    }
  })

  it('round-trips both control ops and carries an empty payload', () => {
    const out = new Uint8Array(16)
    for (const op of [WS_CONTROL_PEER_JOINED, WS_CONTROL_PEER_GONE]) {
      const n = encodeWsControl(out, op, 9)
      expect(n).toBe(WS_HEADER_BYTES)

      const frame = decodeWsFrame(out.subarray(0, n))
      expect(frame).not.toBeNull()
      if (frame === null) return
      expect(frame.frameKind).toBe(WS_FRAME_CONTROL)
      expect(frame.controlOp).toBe(op)
      expect(frame.channel).toBeNull()
      expect(frame.peerSlot).toBe(9)
      expect(frame.payload.length).toBe(0)
    }
  })

  it('hands back a VIEW of the inbound buffer, not a copy', () => {
    // Transport rule 6: a receiver that needs the bytes past the callback
    // copies them. If this ever became a copy, every hot-path datagram would
    // allocate and the rule would quietly stop meaning anything.
    const buf = new Uint8Array([WS_FRAME_DATA, WS_CHANNEL_RELIABLE, 3, 0x10, 0x02, 0x63])
    const frame = decodeWsFrame(buf)
    expect(frame).not.toBeNull()
    if (frame === null) return
    expect(frame.payload.buffer).toBe(buf.buffer)
    expect(frame.payload.byteOffset).toBe(WS_HEADER_BYTES)
    buf[3] = 0x11
    expect(frame.payload[0]).toBe(0x11)
  })

  it('returns null - never throws - on every malformed frame', () => {
    const rows: Array<[string, Uint8Array]> = [
      ['empty', new Uint8Array(0)],
      ['one byte', new Uint8Array([WS_FRAME_DATA])],
      ['two bytes', new Uint8Array([WS_FRAME_DATA, WS_CHANNEL_RELIABLE])],
      ['unknown frame kind 0x02', new Uint8Array([0x02, 0x00, 1])],
      ['unknown frame kind 0xff', new Uint8Array([0xff, 0x00, 1])],
      ['unknown channel 0x02', new Uint8Array([WS_FRAME_DATA, 0x02, 1])],
      ['unknown channel 0xff', new Uint8Array([WS_FRAME_DATA, 0xff, 1, 9, 9])],
      ['unknown control op 0x02', new Uint8Array([WS_FRAME_CONTROL, 0x02, 1])],
    ]
    for (const [label, buf] of rows) {
      let result: unknown = 'threw'
      expect(() => {
        result = decodeWsFrame(buf)
      }, label).not.toThrow()
      expect(result, label).toBeNull()
    }
  })

  it('never throws on any three-byte header, over the whole 65,536-value space', () => {
    // The first function every inbound byte on a public socket reaches. The
    // expected trigger is a version mismatch after a deploy, not an attacker,
    // and a throw here is an uncaught exception in a socket handler - which on
    // the server exits the process and kills every room in it.
    const buf = new Uint8Array([0, 0, 0, 0x30, 0x01])
    let accepted = 0
    for (let b0 = 0; b0 < 256; b0++) {
      for (let b1 = 0; b1 < 256; b1++) {
        buf[0] = b0
        buf[1] = b1
        buf[2] = (b0 ^ b1) & 0xff
        const frame = decodeWsFrame(buf)
        if (frame !== null) accepted++
      }
    }
    // Exactly the four legal (kind, second byte) pairs: data x 2 channels,
    // control x 2 ops. A guard that returned null for EVERYTHING would pass a
    // "never throws" assertion and reject every real frame in the system.
    expect(accepted).toBe(4)
  })

  it('maps channel names to bytes and back, exhaustively', () => {
    for (const c of CHANNELS) expect(channelOfByte(byteOfChannel(c))).toBe(c)
    expect(byteOfChannel('unreliable')).toBe(0x00)
    expect(byteOfChannel('reliable')).toBe(0x01)
    for (let b = 2; b < 256; b++) expect(channelOfByte(b)).toBeNull()
  })
})
