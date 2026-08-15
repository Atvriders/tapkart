import { describe, expect, it } from 'vitest'
import { PROTOCOL_VERSION, WIRE_TAG, decodeHeader, encodeHeader } from '../src/types'
import type {
  ChannelName, InputDatagram, MessageKind, WireEntity, WireHeader, WireKart, WireSnapshot,
} from '../src/types'
import type { EntityKind, Intent, ItemKind, Surface } from '@tapkart/sim'

describe('protocol wire types', () => {
  it('fixes PROTOCOL_VERSION at 1', () => {
    expect(PROTOCOL_VERSION).toBe(1)
  })

  it('accepts exactly the two channel names the contract fixes', () => {
    const a: ChannelName = 'unreliable'
    const b: ChannelName = 'reliable'
    expect(a).toBe('unreliable')
    expect(b).toBe('reliable')
  })

  it('builds a WireHeader for every MessageKind the contract lists', () => {
    const kinds: MessageKind[] = [
      'hello', 'welcome', 'lobby', 'start', 'clientUpdate',
      'input', 'snapshot', 'events', 'checkpoint', 'resyncRequest',
      'authorityChange', 'ping', 'pong',
    ]
    expect(kinds).toHaveLength(13)
    for (const kind of kinds) {
      const h: WireHeader = { kind, protocolVersion: PROTOCOL_VERSION }
      expect(h.kind).toBe(kind)
      expect(h.protocolVersion).toBe(1)
    }
  })

  it('builds a WireKart with all 21 fields the contract lists, and only those', () => {
    const wk: WireKart = {
      playerId: 3,
      position: { x: 1, y: 2, z: 3 },
      velocity: { x: 0, y: 0, z: 0 },
      heading: 0,
      angularVelocity: 0,
      driftCharge: 0,
      driftActive: false,
      driftDir: 0,
      airborne: false,
      surface: 'tarmac' as Surface,
      spinOutTicks: 0,
      invulnTicks: 0,
      item: 'none' as ItemKind,
      lap: 1,
      checkpointIdx: 2,
      t: 0.5,
      isBot: false,
      connected: true,
      boostTicks: 0,
      respawnTicks: 0,
      shielded: false,
    }
    // 21 fields exactly. Spec §5's invariant is that this is a COMPLETE
    // projection of KartState's per-tick fields (characterIdx is the one
    // named exception, arriving over the reliable channel instead) -- a field
    // added to KartState without a matching addition here is the defect the
    // invariant exists to catch, so this count is asserted, not just implied
    // by the object literal typechecking.
    expect(Object.keys(wk).length).toBe(21)
    expect(wk.playerId).toBe(3)
    expect(wk.driftDir).toBe(0)
  })

  it('builds a WireEntity with all 7 fields', () => {
    const we: WireEntity = {
      entityId: 5,
      kind: 'seeker' as EntityKind,
      ownerId: 2,
      position: { x: 0, y: 0, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
      heading: 0,
      ttl: 600,
    }
    expect(Object.keys(we).length).toBe(7)
    expect(we.ttl).toBe(600)
  })

  it('builds a WireSnapshot with all 7 fields, phase among them', () => {
    const ws: WireSnapshot = {
      tick: 100,
      eventSeq: 4,
      phase: 'countdown',
      lastProcessedInputTick: [1, 2, 3, 4, 5, 6, 7, 8],
      karts: [],
      entities: [],
      entityCount: 0,
    }
    expect(Object.keys(ws).length).toBe(7)
    expect(ws.lastProcessedInputTick).toHaveLength(8)
    // Task 15c item A. Without this field a guest can never be told the race has
    // not started: ClientLoop forced 'racing' at construction precisely because
    // the wire could not carry the answer, so every guest drove through the
    // host's countdown.
    expect(ws.phase).toBe('countdown')
  })

  it('builds an InputDatagram with both fields', () => {
    const intent: Intent = { tick: 0, steer: 0, accel: 0, brake: false, drift: false, useItem: false }
    const id: InputDatagram = { playerId: 0, intents: [intent] }
    expect(Object.keys(id).length).toBe(2)
    expect(id.intents).toHaveLength(1)
  })
})

describe('WIRE_TAG, encodeHeader, decodeHeader', () => {
  const ALL_KINDS: MessageKind[] = [
    'hello', 'welcome', 'lobby', 'start', 'clientUpdate',
    'input', 'snapshot', 'events', 'checkpoint', 'resyncRequest',
    'authorityChange', 'ping', 'pong',
  ]

  it('fixes a distinct byte for every MessageKind the contract lists', () => {
    expect(WIRE_TAG).toEqual({
      hello: 0x01, welcome: 0x02, lobby: 0x03, start: 0x04, clientUpdate: 0x05,
      input: 0x10, snapshot: 0x11, events: 0x12, checkpoint: 0x13, resyncRequest: 0x14,
      authorityChange: 0x20, ping: 0x30, pong: 0x31,
    })
    // Every datagram is dispatched on this one byte alone, so no two kinds
    // may share a value.
    const values = Object.values(WIRE_TAG)
    expect(new Set(values).size).toBe(values.length)
  })

  it('gives clientUpdate and resyncRequest tags of their own rather than overloading hello', () => {
    // Task 15c item D. Ready toggles, character changes, track choice, start and
    // seat reclaims all used to ride on `hello`, which forced every handler to
    // distinguish intent by inspecting fields of a decoded body -- the exact
    // shape of the top-ranked shared-name risk. These two tags are additive: no
    // existing message's bit layout changes, so this test is about the tag
    // TABLE, not about any body (Plan 4 defines the bodies).
    expect(WIRE_TAG.clientUpdate).toBe(0x05)
    expect(WIRE_TAG.resyncRequest).toBe(0x14)
    // Both must survive a real header round trip, which is what proves
    // TAG_TO_KIND was rebuilt and not merely that two constants exist.
    const buf = new Uint8Array(2)
    encodeHeader(buf, 'clientUpdate')
    expect(decodeHeader(buf).kind).toBe('clientUpdate')
    encodeHeader(buf, 'resyncRequest')
    expect(decodeHeader(buf).kind).toBe('resyncRequest')
    // Each lands in the range its neighbours already occupy: 0x0x is the lobby
    // group (hello..start), 0x1x the in-race group (input..checkpoint).
    expect(WIRE_TAG.clientUpdate).toBeGreaterThan(WIRE_TAG.start)
    expect(WIRE_TAG.clientUpdate).toBeLessThan(WIRE_TAG.input)
    expect(WIRE_TAG.resyncRequest).toBeGreaterThan(WIRE_TAG.checkpoint)
    expect(WIRE_TAG.resyncRequest).toBeLessThan(WIRE_TAG.authorityChange)
  })

  it('encodeHeader writes [tag, PROTOCOL_VERSION] and returns 2', () => {
    const out = new Uint8Array(4).fill(0xff)
    const n = encodeHeader(out, 'snapshot')
    expect(n).toBe(2)
    expect(out[0]).toBe(WIRE_TAG.snapshot)
    expect(out[1]).toBe(PROTOCOL_VERSION)
    expect(out[2]).toBe(0xff) // encodeHeader writes only its own 2 bytes
  })

  it('decodeHeader round-trips every MessageKind through encodeHeader', () => {
    const buf = new Uint8Array(2)
    for (const kind of ALL_KINDS) {
      encodeHeader(buf, kind)
      const h: WireHeader = decodeHeader(buf)
      expect(h.kind).toBe(kind)
      expect(h.protocolVersion).toBe(PROTOCOL_VERSION)
    }
  })

  it('decodeHeader throws on a tag byte no MessageKind maps to', () => {
    // 0x99 is not one of WIRE_TAG's eleven values.
    const buf = new Uint8Array([0x99, PROTOCOL_VERSION])
    expect(() => decodeHeader(buf)).toThrow(/unknown wire tag/)
  })

  it('decodeHeader throws on a PROTOCOL_VERSION mismatch', () => {
    const buf = new Uint8Array([WIRE_TAG.input, PROTOCOL_VERSION + 1])
    expect(() => decodeHeader(buf)).toThrow(/protocol version/)
  })
})

describe('@tapkart/protocol barrel', () => {
  it('resolves through the package entry point', async () => {
    const pkg = await import('@tapkart/protocol')
    expect(pkg.PROTOCOL_VERSION).toBe(1)
  })
})
