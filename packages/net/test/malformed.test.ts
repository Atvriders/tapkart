import { describe, expect, it } from 'vitest'
import type { AuthEvent, Intent, SimState } from '@tapkart/sim'
import { COUNTDOWN_TICKS, MAX_KARTS, createState } from '@tapkart/sim'
import type { ChannelName } from '@tapkart/protocol'
import {
  PROTOCOL_VERSION,
  WIRE_TAG,
  encodeCheckpoint,
  encodeEvents,
  encodeHeader,
  encodeInput,
  encodeSnapshot,
} from '@tapkart/protocol'
import type { Transport } from '../src/transport'
import { AuthorityLoop } from '../src/authority'
import { ClientLoop, makeRemoteSample, remoteInterpolatorOf } from '../src/client'
import { ShadowLoop } from '../src/shadow'
import { droppedDatagramsOf } from '../src/receive'
import { TICK_MS } from '../src/clock'
import { makeLossyPair, makeNetContext } from './fixtures/net-fixtures'

/**
 * Every loop in this package parses the shared header INSIDE its
 * Transport.onMessage callback, and decodeHeader throws on an unknown tag, on a
 * protocol version mismatch, and on a datagram too short to hold a header at
 * all. Under LoopbackTransport none of those can happen - both ends are this
 * build - which is exactly why this file exists: over Plan 4's WebSocket and
 * WebRTC transports the bytes arrive from a public socket, the throw escapes the
 * socket library's message handler, and on the server that is an uncaught
 * exception that ends the PROCESS and every room inside it.
 *
 * The quieter half is worse. A TRUNCATED frame did not throw at all: BitReader
 * read past the end of its buffer, `undefined >> n` is 0, and a half-received
 * snapshot decoded into a well-formed ALL-ZEROS world that the receiving loop
 * then snapped its whole race onto. Nothing anywhere reported a problem.
 */

const CHARS = [0, 1, 2, 3, 4, 5, 6, 7]
const SNAP_BUF_BYTES = 1024
const CHECKPOINT_BUF_BYTES = 8192

interface Capture {
  transport: Transport
  deliver(peerId: string, channel: ChannelName, data: Uint8Array): void
  losePeer(peerId: string): void
}

function captureTransport(): Capture {
  let cb: (peerId: string, channel: ChannelName, data: Uint8Array) => void = () => {}
  let lost: (peerId: string) => void = () => {}
  return {
    deliver: (peerId, channel, data) => cb(peerId, channel, data),
    losePeer: (peerId) => lost(peerId),
    transport: {
      send() {},
      broadcast() {},
      onMessage: (fn) => {
        cb = fn
      },
      onPeerLost: (fn) => {
        lost = fn
      },
      peers: () => [],
      close() {},
    },
  }
}

function framed(
  kind: 'input' | 'snapshot' | 'events' | 'checkpoint',
  size: number,
  writePayload: (payload: Uint8Array) => number,
): Uint8Array {
  const buf = new Uint8Array(size)
  const h = encodeHeader(buf, kind)
  const n = writePayload(buf.subarray(h))
  return buf.subarray(0, h + n)
}

/** The three shapes that reach decodeHeader itself, before any body decode. */
const EMPTY = new Uint8Array(0)
const ONE_BYTE = new Uint8Array([WIRE_TAG.input])
const UNKNOWN_TAG = new Uint8Array([0x7f, PROTOCOL_VERSION])
const WRONG_VERSION = new Uint8Array([WIRE_TAG.input, PROTOCOL_VERSION + 1])

function inputWindow(baseTick: number, accel: number): Intent[] {
  return Array.from({ length: 8 }, (_, i) => ({
    tick: baseTick + i * 2, steer: 0, accel, brake: false, drift: false, useItem: false,
  }))
}

/** `characterIdx` defaults to CHARS; the ClientLoop test passes all-zeros
 * instead, because ClientLoop bootstraps its own state with seed 0 and character
 * 0 in every seat, and a host whose bots have DIFFERENT character stats diverges
 * from it for reasons that have nothing to do with malformed datagrams. */
function racingState(seed: number, humanSeat: number, characterIdx: number[] = CHARS): SimState {
  const state = createState(makeNetContext(false), seed, characterIdx)
  state.phase = 'racing'
  state.karts[humanSeat].isBot = false
  state.karts[humanSeat].connected = true
  return state
}


/**
 * ShadowLoop.tick takes the scheduler's wall clock as of Task 15c item C, so
 * every call site here drives one through a driver that advances it by exactly
 * one 60Hz tick per call - which is what a healthy scheduler does, and therefore
 * preserves the meaning every test in this file had when tick() took no
 * argument.
 *
 * `stall(ms)` is the case the tick counter could not see: wall time passing with
 * NO tick running.
 */
function driverFor(shadow: ShadowLoop, startMs = 0): {
  tick(n?: number): void
  stall(deltaMs: number): void
  nowMs(): number
} {
  let ms = startMs
  return {
    tick(n = 1): void {
      for (let i = 0; i < n; i++) {
        shadow.tick(ms)
        ms += TICK_MS
      }
    },
    stall(deltaMs: number): void {
      ms += deltaMs
    },
    nowMs(): number {
      return ms
    },
  }
}

// ---------------------------------------------------------------------------
// The enum hole, at the loop level.
//
// packages/protocol/test/enum-codes.test.ts walks the WHOLE code space of every
// enum field in every codec and asserts each unused code is rejected. That is
// the codec's half. This is the other half, and it is the half that matters to a
// running room: a datagram carrying an unused code must be DROPPED, COUNTED, and
// must leave every byte of simulation state exactly where it was - and the loop
// must still be working immediately afterwards.
//
// The last clause is the one that catches a guard which drops the bad datagram
// and then wedges the decoder (a scratch buffer left mid-write, a cursor never
// rewound, a pointer swapped before the commit), so every case below delivers a
// GOOD datagram right after the bad one and asserts it lands.
// ---------------------------------------------------------------------------

/**
 * The bit offset of the one bit that differs between two encodings.
 *
 * Deliberately not a table of hand-computed offsets: a literal "kart 0's item
 * starts at payload bit 246" would be a second copy of snapshot.ts's private
 * field widths, free to drift from the real ones in silence - and a test that
 * corrupted the WRONG bits would still see a drop (from a truncation, a bad
 * quantisation code, anything) and would pass while proving nothing. Encoding
 * the same state twice, moving one enum from code 0 to code 1, leaves exactly
 * one bit different, and the encoder itself is what located it.
 *
 * The same helper appears in packages/protocol/test/enum-codes.test.ts. It is
 * copied rather than shared because sharing it would mean a test-fixture module
 * reaching across a package boundary by relative path, which is the one thing
 * the locked contract §3 forbids by name.
 */
function soleDifferingBit(a: Uint8Array, b: Uint8Array): number {
  expect(a.length, 'the two encodings are different lengths').toBe(b.length)
  const bits: number[] = []
  for (let i = 0; i < a.length; i++) {
    const diff = a[i] ^ b[i]
    for (let k = 0; k < 8; k++) if ((diff >> k) & 1) bits.push(i * 8 + k)
  }
  expect(bits, 'moving one enum by one code did not move exactly one bit').toHaveLength(1)
  return bits[0]
}

function writeCodeAt(buf: Uint8Array, bitOffset: number, code: number, bits: number): void {
  for (let i = 0; i < bits; i++) {
    const idx = bitOffset + i
    if ((code >> i) & 1) buf[idx >> 3] |= 1 << (idx & 7)
    else buf[idx >> 3] &= ~(1 << (idx & 7))
  }
}

function readCodeAt(buf: Uint8Array, bitOffset: number, bits: number): number {
  let code = 0
  for (let i = 0; i < bits; i++) {
    const idx = bitOffset + i
    code += ((buf[idx >> 3] >> (idx & 7)) & 1) * 2 ** i
  }
  return code
}

/** encodeHeader writes two bytes, so a payload bit offset is 16 bits into a frame. */
const HEADER_BITS = 16
const NO_INPUT_YET = (): number[] => new Array(MAX_KARTS).fill(-1) as number[]

function encodeSnap(state: SimState): Uint8Array {
  const buf = new Uint8Array(SNAP_BUF_BYTES)
  const n = encodeSnapshot(buf, state, NO_INPUT_YET())
  return buf.slice(0, n)
}

/** A racing state carrying one live entity, so the entity record is on the wire. */
function racingStateWithEntity(seed: number, humanSeat: number, characterIdx: number[]): SimState {
  const s = racingState(seed, humanSeat, characterIdx)
  const e = s.entities[0]
  e.entityId = 11
  e.kind = 'seeker'
  e.ownerId = humanSeat
  e.ttl = 120
  s.entityCount = 1
  return s
}

interface SnapshotEnumCase {
  /** Both the probe states and the real wire state come from here, so their
   *  layouts (which vary with entityCount) are identical by construction. */
  make(): SimState
  /** Puts the field at wire code 0 or 1, which is what locates it. */
  set(state: SimState, code: 0 | 1): void
  widthBits: number
  /** The code the real wire state below actually carries, asserted before the
   *  corruption so a wrong offset fails loudly instead of passing quietly. */
  liveCode: number
  badCode: number
}

/**
 * The whole scenario for one snapshot enum field, against a real ClientLoop over
 * a real transport: corrupt, deliver, assert dropped + counted + nothing moved,
 * then deliver the same frame with the field back at a real code and assert it
 * lands.
 */
function runSnapshotEnumCase(seed: number, c: SnapshotEnumCase): void {
  const OWN_SEAT = 4
  const pair = makeLossyPair({ latencyMs: 1, jitterMs: 0, lossRate: 0, seed })
  const client = new ClientLoop(makeNetContext(false), OWN_SEAT, pair.b)
  const intent: Intent = { tick: 0, steer: 0, accel: 1, brake: false, drift: false, useItem: false }

  const probeA = c.make()
  c.set(probeA, 0)
  const probeB = c.make()
  c.set(probeB, 1)
  const bitOffset = HEADER_BITS + soleDifferingBit(encodeSnap(probeA), encodeSnap(probeB))

  // A snapshot worth acting on: a different tick and this client's own kart 40m
  // from where it predicts, so "the loop ignored it" and "the loop accepted it"
  // are unmistakably different outcomes.
  const wire = c.make()
  wire.tick = 20
  wire.karts[OWN_SEAT].position.x += 40
  const frame = framed('snapshot', SNAP_BUF_BYTES, (p) => encodeSnapshot(p, wire, NO_INPUT_YET()))
  expect(
    readCodeAt(frame, bitOffset, c.widthBits),
    'the field is not where this test thinks it is, so corrupting it proves nothing',
  ).toBe(c.liveCode)

  // An explicit wall clock, advanced one tick per delivery. makeLoopbackPair
  // stamps deliverAt from the LAST pump's nowMs plus the latency, so a second
  // pump at the same instant as the first silently delivers nothing - and every
  // assertion after it would then be measuring an undelivered frame rather than
  // a rejected one.
  let nowMs = TICK_MS

  writeCodeAt(frame, bitOffset, c.badCode, c.widthBits)
  pair.a.broadcast('unreliable', frame)
  expect(() => {
    pair.pump(nowMs)
    client.tick(intent)
  }, 'an undecodable enum threw out of the client transport callback').not.toThrow()

  // Dropped and counted, exactly as every other undecodable datagram is.
  expect(droppedDatagramsOf(client), 'the bad code was not counted as a drop').toBe(1)
  // And nothing of it was applied: the client is on its OWN tick 1, not the
  // snapshot's 20, and it never resynced onto that 40m offset.
  expect(client.state().tick, 'the loop adopted a tick from a frame it could not decode').toBe(1)
  expect(client.corrections()).toBe(0)
  expect(client.state().phase).toBe('countdown')

  // The clause that catches a guard which drops the datagram and then wedges the
  // loop: the SAME frame, with only those bits back at a real code, is accepted.
  writeCodeAt(frame, bitOffset, c.liveCode, c.widthBits)
  pair.a.broadcast('unreliable', frame)
  nowMs += TICK_MS
  pair.pump(nowMs)
  client.tick(intent)
  expect(droppedDatagramsOf(client), 'a good datagram was miscounted as a drop').toBe(1)
  expect(client.corrections(), 'the loop stopped reconciling after one bad datagram').toBe(1)
  expect(client.state().tick).toBe(wire.tick)
}

describe('ClientLoop — an enum code no encoder can produce is a datagram that never arrived', () => {
  const CHARS_FLAT = [0, 0, 0, 0, 0, 0, 0, 0]

  it('drops a snapshot whose 4-bit item decodes to nothing, instead of racing with item undefined', () => {
    // ItemKind has nine values in a sixteen-code field, so seven codes are
    // undecodable. Before this guard, code 15 landed in SimState.karts[i].item -
    // where packages/sim's useItem() matches it against every ItemKind branch,
    // finds none, and silently does nothing forever: a kart holding a
    // permanently unusable item that no snapshot ever clears, because the next
    // snapshot from a healthy host sets it to whatever the AUTHORITY thinks the
    // kart holds, which the guest can then never fire either.
    runSnapshotEnumCase(0x1701, {
      make: () => racingState(0, 4, CHARS_FLAT),
      set: (s, code) => { s.karts[0].item = code === 0 ? 'none' : 'boost' },
      widthBits: 4,
      liveCode: 0, // 'none'
      badCode: 15,
    })
  })

  it('drops a snapshot whose 4-bit entity kind decodes to nothing', () => {
    // The widest hole in the format: EntityKind has six values in a sixteen-code
    // field. An undefined kind reached the interpolator's entity samples, which
    // are the ONLY source a guest's renderer has for shells and slicks.
    runSnapshotEnumCase(0x1702, {
      make: () => racingStateWithEntity(0, 4, CHARS_FLAT),
      set: (s, code) => { s.entities[0].kind = code === 0 ? 'seeker' : 'bolt' },
      widthBits: 4,
      liveCode: 0, // 'seeker'
      badCode: 15,
    })
  })

  it('drops a snapshot whose 2-bit packed drift decodes to nothing', () => {
    // driftActive+driftDir share two bits and use three of the four codes. The
    // quietest member of this family: code 3 fell through unpackDriftDir's final
    // `else` and decoded as a perfectly VALID (active, dir +1), so a corrupted
    // sender could assert a kart is drifting right and no counter anywhere would
    // record that it had.
    runSnapshotEnumCase(0x1703, {
      make: () => racingState(0, 4, CHARS_FLAT),
      set: (s, code) => {
        s.karts[0].drift = code === 0
          ? { active: false, dir: 0, charge: 0 }
          : { active: true, dir: -1, charge: 0 }
      },
      widthBits: 2,
      liveCode: 0, // inactive
      badCode: 3,
    })
  })

  it('drops an events datagram whose item decodes to nothing, and applies the next one', () => {
    // decodeEvents' copy of the hole is the worse one: applyEvent reads ev.item
    // as the kind of ENTITY TO SPAWN as well as the item to grant.
    //
    // Both datagrams below carry the SAME eventSeq. That is the strong form of
    // "nothing moved": applyEvent refuses any event at or below the highest
    // already applied, so the good one landing at all proves the bad one did not
    // advance `nextEventSeq` on its way out.
    const OWN_SEAT = 4
    const pair = makeLossyPair({ latencyMs: 1, jitterMs: 0, lossRate: 0, seed: 0x1704 })
    const client = new ClientLoop(makeNetContext(false), OWN_SEAT, pair.b)
    const intent: Intent = { tick: 0, steer: 0, accel: 0, brake: false, drift: false, useItem: false }

    const evFor = (item: 'none' | 'boost'): AuthEvent[] => [
      { eventSeq: 5, tick: 3, kind: 'spinOut', playerId: OWN_SEAT, entityId: -1, item, data: 42 },
    ]
    const encodeEv = (item: 'none' | 'boost'): Uint8Array => {
      const buf = new Uint8Array(256)
      const n = encodeEvents(buf, evFor(item))
      return buf.slice(0, n)
    }
    const bitOffset = HEADER_BITS + soleDifferingBit(encodeEv('none'), encodeEv('boost'))

    const frame = framed('events', 256, (p) => encodeEvents(p, evFor('none')))
    expect(readCodeAt(frame, bitOffset, 4), 'the item field is not where this test thinks it is').toBe(0)

    expect(client.state().karts[OWN_SEAT].spinOutTicks).toBe(0)
    // See runSnapshotEnumCase: deliverAt is stamped from the previous pump's
    // clock, so the second pump has to be strictly later than the first.
    let nowMs = TICK_MS
    writeCodeAt(frame, bitOffset, 15, 4)
    pair.a.broadcast('reliable', frame)
    expect(() => {
      pair.pump(nowMs)
      client.tick(intent)
    }, 'an undecodable event item threw out of the client transport callback').not.toThrow()

    expect(droppedDatagramsOf(client)).toBe(1)
    // spinOut is the observable: applyEvent writes ev.data into spinOutTicks.
    // A partially-applied batch shows up here, and so does one applied whole.
    expect(client.state().karts[OWN_SEAT].spinOutTicks, 'a rejected events batch was applied anyway').toBe(0)
    expect(client.state().nextEventSeq, 'a rejected events batch advanced the event cursor').toBe(0)

    writeCodeAt(frame, bitOffset, 0, 4)
    pair.a.broadcast('reliable', frame)
    nowMs += TICK_MS
    pair.pump(nowMs)
    client.tick(intent)
    expect(droppedDatagramsOf(client)).toBe(1)
    expect(
      client.state().karts[OWN_SEAT].spinOutTicks,
      'the loop stopped applying events after one bad datagram',
    ).toBeGreaterThan(0)
    expect(client.state().nextEventSeq).toBe(6)
  })
})

describe('ShadowLoop — an enum code no encoder can produce is a checkpoint that never arrived', () => {
  it('drops a checkpoint whose phase is not a phase, and still applies the next one', () => {
    // The highest-consequence copy of the hole: a checkpoint REPLACES the whole
    // state, so a bad value here is not a field that self-heals on the next
    // snapshot but the baseline every later tick is built on. It was guarded by
    // a non-null assertion, which is a claim to the compiler and not a check on
    // the bytes.
    const ctx = makeNetContext(false)
    const state = createState(ctx, 0x1705, CHARS)
    const cap = captureTransport()
    const shadow = new ShadowLoop(ctx, state, cap.transport)
    const drive = driverFor(shadow)
    drive.tick(5)
    expect(state.tick).toBe(5)
    const gridX = state.karts[0].position.x

    const encodeCp = (phase: 'countdown' | 'racing'): Uint8Array => {
      const s = createState(ctx, 0x1705, CHARS)
      s.phase = phase
      const buf = new Uint8Array(CHECKPOINT_BUF_BYTES)
      const n = encodeCheckpoint(buf, s)
      return buf.slice(0, n)
    }
    // A float64 field, so the differing bits span one 8-byte slot rather than one bit.
    const a = encodeCp('countdown')
    const b = encodeCp('racing')
    const slots = new Set<number>()
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) slots.add(i - (i % 8))
    expect([...slots], 'changing the phase changed more or less than one float64 slot').toHaveLength(1)
    const phaseByte = 2 /* header */ + [...slots][0]

    const resync = createState(ctx, 0x1705, CHARS)
    resync.tick = 800
    resync.phase = 'racing'
    resync.karts[0].position.x = gridX - 80
    const frame = framed('checkpoint', CHECKPOINT_BUF_BYTES, (p) => encodeCheckpoint(p, resync))
    const dv = new DataView(frame.buffer, frame.byteOffset, frame.byteLength)
    expect(dv.getFloat64(phaseByte, true), 'the phase field is not where this test thinks it is').toBe(1)

    // 3 is the fourth code of a three-value enum - the same one snapshot.ts
    // already rejects, in the codec that had no bound at all.
    dv.setFloat64(phaseByte, 3, true)
    expect(() => cap.deliver('host', 'reliable', frame)).not.toThrow()
    drive.tick()

    expect(droppedDatagramsOf(shadow), 'the bad phase was not counted as a drop').toBe(1)
    // Nothing moved: the loop is on tick 6 (its own five plus this one), not the
    // checkpoint's 800, and its kart never jumped 80m.
    expect(state.tick, 'the loop cloned a checkpoint it could not decode over its whole state').toBe(6)
    expect(Math.abs(state.karts[0].position.x - gridX)).toBeLessThan(1)
    expect(state.phase, 'a phase that decoded to nothing reached SimState').toBe('countdown')

    // And the loop still resyncs: the same checkpoint with a real phase lands.
    dv.setFloat64(phaseByte, 1, true)
    cap.deliver('host', 'reliable', frame)
    drive.tick()
    expect(droppedDatagramsOf(shadow)).toBe(1)
    expect(state.tick, 'the loop stopped accepting checkpoints after one bad one').toBe(801)
    expect(state.phase).toBe('racing')
    expect(Math.abs(state.karts[0].position.x - (gridX - 80))).toBeLessThan(1)
  })

  /**
   * The other four. `decodeCheckpoint` rejects five enum fields, and until now
   * only `phase` had this three-clause test THROUGH THE LOOP - `item`, `surface`,
   * entity `kind` and `drift.dir` were proven only to throw at the codec level,
   * in packages/protocol/test/enum-codes.test.ts.
   *
   * That gap matters because the two halves prove different things. The codec
   * test proves a throw happens; this one proves the loop TREATS that throw as a
   * dropped datagram - counted, with the live state untouched and the loop still
   * accepting checkpoints afterwards. A codec that threw into a handler which
   * caught nothing, or which had already committed a pointer into its
   * half-written scratch buffer, passes the first and fails this.
   */
  const CHECKPOINT_ENUM_CASES: [string, (s: SimState, variant: 0 | 1) => void, number][] = [
    ['item', (s, v) => { s.karts[0].item = v === 0 ? 'none' : 'boost' }, 9],
    ['surface', (s, v) => { s.karts[0].surface = v === 0 ? 'tarmac' : 'dirt' }, 4],
    ['entity kind', (s, v) => { s.entities[0].kind = v === 0 ? 'seeker' : 'bolt' }, 6],
    // Not a table index but a raw signed value: -1, 0 and 1 are the whole
    // domain, so 2 is the first thing outside it.
    ['drift dir', (s, v) => { s.karts[0].drift.dir = v === 0 ? 0 : 1 }, 2],
  ]

  for (const [label, setVariant, firstBadCode] of CHECKPOINT_ENUM_CASES) {
    it(`drops a checkpoint whose ${label} is not one, and still applies the next one`, () => {
      const ctx = makeNetContext(false)
      const state = createState(ctx, 0x1706, CHARS)
      const cap = captureTransport()
      const shadow = new ShadowLoop(ctx, state, cap.transport)
      const drive = driverFor(shadow)
      drive.tick(5)
      const gridX = state.karts[0].position.x

      const cpFor = (variant: 0 | 1): Uint8Array => {
        const s = createState(ctx, 0x1706, CHARS)
        // A live entity, so the entity record this case may target is on the
        // wire rather than a dead slot.
        s.entities[0].entityId = 7
        s.entities[0].ownerId = 0
        s.entityCount = 1
        setVariant(s, variant)
        const buf = new Uint8Array(CHECKPOINT_BUF_BYTES)
        const n = encodeCheckpoint(buf, s)
        return buf.slice(0, n)
      }
      // The field is located by the ENCODER, not by a hand-computed offset: two
      // encodings differing only in this field differ in exactly one float64.
      const a = cpFor(0)
      const b = cpFor(1)
      const slots = new Set<number>()
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) slots.add(i - (i % 8))
      expect([...slots], `changing ${label} moved more or less than one float64 slot`).toHaveLength(1)
      const fieldByte = 2 /* header */ + [...slots][0]

      const resync = createState(ctx, 0x1706, CHARS)
      resync.tick = 700
      resync.karts[0].position.x = gridX - 60
      resync.entities[0].entityId = 7
      resync.entities[0].ownerId = 0
      resync.entityCount = 1
      const frame = framed('checkpoint', CHECKPOINT_BUF_BYTES, (p) => encodeCheckpoint(p, resync))
      const dv = new DataView(frame.buffer, frame.byteOffset, frame.byteLength)
      const goodCode = dv.getFloat64(fieldByte, true)

      dv.setFloat64(fieldByte, firstBadCode, true)
      expect(() => cap.deliver('host', 'reliable', frame)).not.toThrow()
      drive.tick()

      // 1. counted, 2. nothing moved, 3. still resyncing afterwards.
      expect(droppedDatagramsOf(shadow), `the bad ${label} was not counted as a drop`).toBe(1)
      expect(state.tick, `a checkpoint with a bad ${label} replaced the whole state`).toBe(6)
      expect(Math.abs(state.karts[0].position.x - gridX)).toBeLessThan(1)

      dv.setFloat64(fieldByte, goodCode, true)
      cap.deliver('host', 'reliable', frame)
      drive.tick()
      expect(droppedDatagramsOf(shadow)).toBe(1)
      expect(state.tick, `the loop stopped accepting checkpoints after one bad ${label}`).toBe(701)
      expect(Math.abs(state.karts[0].position.x - (gridX - 60))).toBeLessThan(1)
    })
  }
})

describe('AuthorityLoop — a malformed datagram is a datagram that never arrived', () => {
  it('drops and counts it, leaves the race untouched, and keeps serving the room', () => {
    const ctx = makeNetContext(true)
    const state = racingState(0x501, 2)
    const cap = captureTransport()
    const authority = new AuthorityLoop(ctx, state, cap.transport)

    // A good datagram first, so there is real held state for a bad one to wreck.
    cap.deliver('c2', 'unreliable', framed('input', 256, (p) => encodeInput(p, 2, inputWindow(0, 1))))
    for (let i = 0; i < 20; i++) authority.tick()
    const speed = Math.hypot(state.karts[2].velocity.x, state.karts[2].velocity.z)
    expect(speed).toBeGreaterThan(3)

    // Four garbage datagrams, of the four shapes a real socket delivers. Each
    // one of these used to throw straight out of Transport.onMessage.
    const truncatedInput = framed('input', 256, (p) => encodeInput(p, 2, inputWindow(40, 1))).subarray(0, 6)
    expect(() => {
      cap.deliver('x', 'unreliable', EMPTY)
      cap.deliver('x', 'unreliable', ONE_BYTE)
      cap.deliver('x', 'unreliable', UNKNOWN_TAG)
      cap.deliver('x', 'unreliable', WRONG_VERSION)
      cap.deliver('x', 'unreliable', truncatedInput)
    }, 'a malformed datagram threw out of the transport callback; on a server that ends the process').not.toThrow()

    expect(droppedDatagramsOf(authority)).toBe(5)
    // The truncated INPUT datagram in particular must not have been half-applied:
    // seat 2 is still coasting on the intent it legitimately holds.
    for (let i = 0; i < 20; i++) authority.tick()
    expect(Math.hypot(state.karts[2].velocity.x, state.karts[2].velocity.z)).toBeGreaterThan(speed)

    // And the room is still serving: a good datagram after the garbage still
    // steers, which a loop that had thrown its way out of the handler (or wedged
    // its decoder) does not do.
    cap.deliver('c2', 'unreliable', framed('input', 256, (p) => encodeInput(p, 2, inputWindow(80, 0))))
    for (let i = 0; i < 30; i++) authority.tick()
    const coasting = Math.hypot(state.karts[2].velocity.x, state.karts[2].velocity.z)
    expect(coasting).toBeLessThan(speed)
    expect(droppedDatagramsOf(authority)).toBe(5) // no good datagram was miscounted
  })
})

describe('ClientLoop — a malformed datagram is a datagram that never arrived', () => {
  it('survives garbage arriving mid-race and keeps reconciling afterwards', () => {
    const ctxA = makeNetContext(true)
    // A REAL race start: the host runs the countdown rather than skipping it.
    // Task 15c item A made this matter. A ClientLoop now starts in 'countdown'
    // and adopts the authority's phase off the wire, so a host that is already
    // racing at tick 0 leaves the guest's SEVEN LOCALLY-SIMULATED BOT SEATS a
    // few ticks behind that host's for the rest of the race (ClientLoop
    // reconciles the local kart only - remote seats are never trusted and never
    // rendered), and the local kart then mispredicts whenever it interacts with
    // one. That is an artefact of a host skipping its own countdown, which no
    // real race does: both sides start at tick 0 in 'countdown' and release
    // together at COUNTDOWN_TICKS.
    const hostState = createState(makeNetContext(false), 0, [0, 0, 0, 0, 0, 0, 0, 0])
    hostState.karts[4].isBot = false
    hostState.karts[4].connected = true
    const pair = makeLossyPair({ latencyMs: 1, jitterMs: 0, lossRate: 0, seed: 3 })
    const authority = new AuthorityLoop(ctxA, hostState, pair.a)
    const client = new ClientLoop(makeNetContext(false), 4, pair.b)
    // Same steady, in-bounds intent the end-to-end convergence test uses, and the
    // same neutralised item boxes: a respawn or an itemGrant is an authoritative
    // event on the reliable channel and corrects for timing reasons that have
    // nothing to do with this test's subject.
    for (const box of hostState.itemBoxes) box.respawnTicks = 1_000_000
    const intent: Intent = { tick: 0, steer: 0.1, accel: 0.4, brake: false, drift: false, useItem: false }

    let nowMs = 0
    const advance = (n: number): void => {
      for (let i = 0; i < n; i++) {
        authority.tick()
        client.tick(intent)
        pair.pump(nowMs)
        nowMs += 1000 / 60
      }
    }

    advance(COUNTDOWN_TICKS + 60)
    expect(client.state().phase).toBe('racing')
    expect(authority.state().phase).toBe('racing')
    const beforeCorrections = client.corrections()

    // Garbage on both channels, delivered through the real transport: a throw
    // here escapes pump() itself, which is precisely how it would escape a
    // socket's message handler.
    pair.a.broadcast('unreliable', ONE_BYTE)
    pair.a.broadcast('reliable', UNKNOWN_TAG)
    pair.a.broadcast('unreliable', WRONG_VERSION)
    expect(() => advance(6), 'garbage on the wire threw out of the client transport callback').not.toThrow()
    expect(droppedDatagramsOf(client)).toBe(3)

    // Still a working client: it keeps ticking and keeps tracking the authority.
    advance(120)
    expect(client.state().tick).toBe(COUNTDOWN_TICKS + 186)
    expect(client.corrections() - beforeCorrections).toBeLessThanOrEqual(3)
    const mine = client.state().karts[4]
    const theirs = authority.state().karts[4]
    expect(Math.abs(mine.position.x - theirs.position.x)).toBeLessThan(0.5)
    expect(Math.abs(mine.position.z - theirs.position.z)).toBeLessThan(0.5)
  })
})

describe('ClientLoop — the fourth phase code is a datagram that never arrived (Task 15c item C)', () => {
  it('drops a snapshot whose 2-bit phase decodes to nothing, instead of racing with phase undefined', () => {
    // `phase` is 2 bits and RacePhase has three values. Code 3 is a bit pattern
    // no encoder here can produce, and before the decoder rejected it the
    // resulting `undefined` travelled the whole way in: WireSnapshot.phase, then
    // ClientLoop.predicted.phase, and it was still `undefined` 300 ticks later.
    // With it, resolveInputs never freezes (it tests for 'countdown') and
    // updatePhase returns early (it tests for 'countdown', then for 'racing'),
    // so the local race can never reach 'finished' - the guest's results screen
    // never arrives, from two flipped bits on a lossy public socket.
    const OWN_SEAT = 4
    const ctx = makeNetContext(false)
    const pair = makeLossyPair({ latencyMs: 1, jitterMs: 0, lossRate: 0, seed: 9 })
    const client = new ClientLoop(ctx, OWN_SEAT, pair.b)
    const intent: Intent = { tick: 0, steer: 0, accel: 1, brake: false, drift: false, useItem: false }

    const wire = racingState(0, OWN_SEAT, [0, 0, 0, 0, 0, 0, 0, 0])
    wire.tick = 20
    wire.karts[OWN_SEAT].position.x += 40 // far past EPS: a snapshot worth acting on
    const frame = framed('snapshot', SNAP_BUF_BYTES, (p) => encodeSnapshot(p, wire, new Array(MAX_KARTS).fill(-1)))

    // Bits 64-65 of the PAYLOAD (`tick u32`, `eventSeq u32`, then phase),
    // LSB-first within the byte, past this file's 2-byte message header: byte
    // 10. Asserted rather than assumed - corrupting the wrong two bits would
    // still produce a drop, from a truncation somewhere else, and this test
    // would pass while proving nothing.
    const PHASE_BYTE = 2 + 8
    expect(frame[PHASE_BYTE] & 0b11, 'the phase field is not where this test thinks it is').toBe(1) // 'racing'
    frame[PHASE_BYTE] |= 0b11

    pair.a.broadcast('unreliable', frame)
    expect(() => {
      pair.pump(TICK_MS)
      client.tick(intent)
    }, 'an undecodable phase threw out of the client transport callback').not.toThrow()

    // Counted and dropped, exactly as every other undecodable datagram is.
    expect(droppedDatagramsOf(client)).toBe(1)
    // Nothing of it was applied: the client is on its OWN tick 1, not the
    // snapshot's 20, and it never resynced onto that 40m offset.
    expect(client.state().tick).toBe(1)
    expect(client.corrections()).toBe(0)
    // And the phase is still a phase. `toBe('countdown')` and not merely
    // `not.toBeUndefined()`: this client has heard from no authority it could
    // believe, so a countdown is what it is honestly in.
    expect(client.state().phase).toBe('countdown')

    // The consequence, made observable: the loop still crosses its own start
    // line on schedule. With `phase === undefined` in there, updatePhase's first
    // branch never matches and the phase stays undefined forever.
    for (let t = 0; t < COUNTDOWN_TICKS; t++) client.tick(intent)
    expect(client.state().phase).toBe('racing')

    // Control: the SAME frame with those two bits back at a real code is
    // accepted, so the drop above is the phase guard and not a snapshot this
    // client would have refused anyway.
    frame[PHASE_BYTE] &= ~0b11
    frame[PHASE_BYTE] |= 1 // 'racing'
    pair.a.broadcast('unreliable', frame)
    pair.pump(client.state().tick * TICK_MS)
    client.tick(intent)
    expect(droppedDatagramsOf(client)).toBe(1)
    expect(client.corrections()).toBe(1)
    expect(client.state().tick).toBe(wire.tick)
  })
})

describe('ClientLoop — a truncated frame must not become the world either', () => {
  it('keeps the snapshot it accepted, in its own kart AND in its interpolator, when a truncated one lands in the same window', () => {
    // Review finding 1. This file delivered ClientLoop only the three shapes
    // that fail in decodeHeader (short, unknown tag, wrong version) and NEVER a
    // truncated body - so with BitReader's bound removed the ShadowLoop test
    // above failed and this loop's tests all still passed. The code was right;
    // the coverage was not, on the loop that renders a race for a human out of
    // bytes that arrive from a possibly-hostile host stream.
    //
    // THE TRAP AVOIDED, same as above: truncating the SAME good frame proves
    // nothing, because a prefix of identical bytes decodes to identical values.
    // The truncated frame here disagrees in its earliest fields - a different
    // tick, this client's kart 45m away, and a REMOTE kart 45m away so the
    // interpolator has something of its own to be wrong about.
    const OWN_SEAT = 4
    const REMOTE_SEAT = 1
    const ctx = makeNetContext(false)
    const pair = makeLossyPair({ latencyMs: 1, jitterMs: 0, lossRate: 0, seed: 7 })
    const client = new ClientLoop(ctx, OWN_SEAT, pair.b)
    const intent: Intent = { tick: 0, steer: 0, accel: 0, brake: false, drift: false, useItem: false }

    const grid = client.state().karts[OWN_SEAT].position.x
    const remoteGrid = client.state().karts[REMOTE_SEAT].position.x

    const good = createState(makeNetContext(true), 0, [0, 0, 0, 0, 0, 0, 0, 0])
    good.tick = 20
    good.phase = 'racing'
    good.karts[OWN_SEAT].position.x = grid + 5
    good.karts[REMOTE_SEAT].position.x = remoteGrid + 5

    const evil = createState(makeNetContext(true), 0, [0, 0, 0, 0, 0, 0, 0, 0])
    evil.tick = 21
    evil.phase = 'racing'
    evil.karts[OWN_SEAT].position.x = grid - 40
    evil.karts[REMOTE_SEAT].position.x = remoteGrid - 40

    const goodFrame = framed('snapshot', SNAP_BUF_BYTES, (p) => encodeSnapshot(p, good, new Array(MAX_KARTS).fill(-1)))
    const evilFrame = framed('snapshot', SNAP_BUF_BYTES, (p) => encodeSnapshot(p, evil, new Array(MAX_KARTS).fill(-1)))
    const truncated = evilFrame.subarray(0, Math.floor(evilFrame.length * 0.6))

    // Both inside one inter-tick window: the accepted frame is still pending
    // when the truncated one is decoded into the buffer next door.
    pair.a.broadcast('unreliable', goodFrame)
    pair.a.broadcast('unreliable', truncated)
    expect(() => {
      // Past this pair's 1ms latency, so both frames land in the SAME delivery,
      // which is the window this test is about.
      pair.pump(TICK_MS)
      client.tick(intent)
    }, 'a truncated snapshot threw out of the client transport callback').not.toThrow()

    expect(droppedDatagramsOf(client)).toBe(1)

    // 1. The client's own kart went to the accepted frame's position, to within
    //    quantisation - not the truncated frame's, and not the all-zeros world a
    //    bounds-free BitReader decodes a half-frame into (every kart at code 0,
    //    i.e. x = -1024).
    const own = client.state().karts[OWN_SEAT]
    expect(own.position.x - grid, 'the client steered by a frame it could not decode').toBeGreaterThan(4.5)
    expect(own.position.x).toBeGreaterThan(-1000)
    // The accepted frame set the tick too, which is what proves the snapshot was
    // applied at all rather than merely not-misapplied. This client's ring holds
    // one tick and the snapshot describes tick 20, so this is the hardResync
    // path: it adopts snap.tick verbatim.
    expect(client.state().tick).toBe(good.tick)

    // 2. The interpolator, which is the ONLY source a renderer has for remote
    //    karts and the half a half-applied decode would corrupt without touching
    //    the local kart at all.
    const ri = remoteInterpolatorOf(client)
    const sample = makeRemoteSample()
    expect(
      ri.sampleKart(REMOTE_SEAT, client.state().tick * TICK_MS, sample),
      'no keyframe was buffered, so the assertions below prove nothing',
    ).toBe(true)
    expect(sample.kart.position.x - remoteGrid, 'the interpolator buffered a frame that never decoded').toBeGreaterThan(4.5)
    expect(sample.position.x).toBeGreaterThan(-1000)
  })
})

describe('ShadowLoop — a truncated frame must not become the world', () => {
  it('keeps the snapshot it accepted when a truncated one lands in the same window', () => {
    // THE TRAP THIS AVOIDS: truncating the SAME good frame proves nothing, because
    // a prefix of identical bytes decodes to identical values. The truncated frame
    // here differs in its earliest fields - a different tick and a kart 45m away -
    // so a loop that decoded it at all lands somewhere unmistakably wrong.
    const ctx = makeNetContext(false)
    const state = createState(ctx, 0x503, CHARS)
    const cap = captureTransport()
    const shadow = new ShadowLoop(ctx, state, cap.transport)
    const drive = driverFor(shadow)
    drive.tick(20)
    const grid = state.karts[0].position.x

    const good = createState(ctx, 0x503, CHARS)
    good.tick = 20
    good.karts[0].position.x = grid + 5

    const evil = createState(ctx, 0x503, CHARS)
    evil.tick = 21
    evil.karts[0].position.x = grid - 40

    const goodFrame = framed('snapshot', SNAP_BUF_BYTES, (p) => encodeSnapshot(p, good, new Array(MAX_KARTS).fill(-1)))
    const evilFrame = framed('snapshot', SNAP_BUF_BYTES, (p) => encodeSnapshot(p, evil, new Array(MAX_KARTS).fill(-1)))
    const truncated = evilFrame.subarray(0, Math.floor(evilFrame.length * 0.6))

    // Both between the same two ticks: the accepted frame is still queued when
    // the truncated one is decoded into the buffer next door.
    cap.deliver('host', 'unreliable', goodFrame)
    expect(() => cap.deliver('host', 'unreliable', truncated)).not.toThrow()
    drive.tick()

    expect(droppedDatagramsOf(shadow)).toBe(1)
    // The accepted frame's world, to within quantisation - NOT the truncated
    // frame's, and not the all-zeros world a bounds-free BitReader decodes a
    // half-frame into (every kart at code 0, i.e. x = -1024).
    expect(
      state.karts[0].position.x - grid,
      'the loop steered by a frame it could not decode',
    ).toBeGreaterThan(4.5)
    expect(state.tick).toBe(21)
  })

  it('keeps the checkpoint it accepted when a truncated one lands in the same window', () => {
    // A checkpoint replaces the WHOLE state, so this is the same aliasing defect
    // with the largest possible blast radius - and it needs no other defect to
    // fire: decodeCheckpoint throws out of DataView.getFloat64, not BitReader.
    //
    // `tick` is the first field encodeCheckpoint writes, and it is what makes the
    // corruption unmistakable: 9001 is not a number any plausible bug produces by
    // coincidence, where a position delta could be argued away.
    const ctx = makeNetContext(false)
    const state = createState(ctx, 0x504, CHARS)
    const cap = captureTransport()
    const shadow = new ShadowLoop(ctx, state, cap.transport)
    const drive = driverFor(shadow)
    drive.tick(5)

    const good = createState(ctx, 0x504, CHARS)
    good.tick = 500
    good.karts[0].position.x -= 80

    const evil = createState(ctx, 0x504, CHARS)
    evil.tick = 9000
    evil.karts[0].position.x += 80

    const goodFrame = framed('checkpoint', CHECKPOINT_BUF_BYTES, (p) => encodeCheckpoint(p, good))
    const evilFrame = framed('checkpoint', CHECKPOINT_BUF_BYTES, (p) => encodeCheckpoint(p, evil))
    const truncated = evilFrame.subarray(0, Math.floor(evilFrame.length * 0.6))

    cap.deliver('host', 'reliable', goodFrame)
    expect(() => cap.deliver('host', 'reliable', truncated)).not.toThrow()
    drive.tick()

    expect(droppedDatagramsOf(shadow)).toBe(1)
    // 501 = the accepted checkpoint's tick plus the one step this tick() ran.
    expect(state.tick, 'the loop cloned a half-decoded checkpoint over its whole state').toBe(501)
    expect(Math.abs(state.karts[0].position.x - good.karts[0].position.x)).toBeLessThan(0.5)
  })

  it('rejects a snapshot from before a checkpoint that is still in flight', () => {
    // The checkpoint path used to reset lastSnapshotTick to -1, on the reasoning
    // that the history ring was now fiction. But this cursor is an ORDERING
    // guard, not history: a snapshot sent before the resync and delivered after
    // it is exactly the frame it exists to reject, and accepting one hard-snaps
    // `live.tick` back onto a timeline the host has already abandoned.
    const ctx = makeNetContext(false)
    const state = createState(ctx, 0x505, CHARS)
    const cap = captureTransport()
    const shadow = new ShadowLoop(ctx, state, cap.transport)
    const drive = driverFor(shadow)
    drive.tick(10)

    const resync = createState(ctx, 0x505, CHARS)
    resync.tick = 800
    cap.deliver('host', 'reliable', framed('checkpoint', CHECKPOINT_BUF_BYTES, (p) => encodeCheckpoint(p, resync)))
    drive.tick()
    expect(state.tick).toBe(801)

    // Sent before the checkpoint, arriving after it.
    const stale = createState(ctx, 0x505, CHARS)
    stale.tick = 9
    cap.deliver('host', 'unreliable',
      framed('snapshot', SNAP_BUF_BYTES, (p) => encodeSnapshot(p, stale, new Array(MAX_KARTS).fill(-1))))
    drive.tick()

    expect(state.tick, 'a pre-checkpoint snapshot dragged the clock backwards').toBe(802)
  })
})

describe('decodeAuthorityChange — validates the header it skips', () => {
  it('refuses a datagram of another kind rather than reading two plausible numbers out of it', async () => {
    const { decodeAuthorityChange, encodeAuthorityChange, AUTHORITY_CHANGE_BYTES } = await import('../src/shadow')
    const good = new Uint8Array(AUTHORITY_CHANGE_BYTES)
    encodeAuthorityChange(good, 4242, 77)
    expect(decodeAuthorityChange(good)).toEqual({ tick: 4242, eventSeq: 77 })

    // A snapshot is 10+ bytes and would decode into two entirely believable
    // integers, then re-seat a whole room's authority on them.
    const snapshot = framed('snapshot', SNAP_BUF_BYTES,
      (p) => encodeSnapshot(p, createState(makeNetContext(false), 1, CHARS), new Array(MAX_KARTS).fill(-1)))
    expect(() => decodeAuthorityChange(snapshot)).toThrow(/authorityChange/)
    expect(() => decodeAuthorityChange(new Uint8Array(4))).toThrow(RangeError)
    expect(() => decodeAuthorityChange(UNKNOWN_TAG)).toThrow()
  })
})

describe('the datagram guard is scoped to decode calls, not to handler bodies (Task 15c item G)', () => {
  it('lets a genuine handler bug propagate instead of counting it as a dropped datagram', async () => {
    // Task 15b's guard wrapped the ENTIRE handler, so any exception a handler
    // raised - a null dereference, a typo, an assertion of an invariant that
    // stopped holding - was caught and tallied as a drop. Both loops now carry
    // drop counters that a reader interprets as PACKET LOSS, so a real defect
    // would present as a lossy network: the one diagnosis that leads nowhere.
    const { createDatagramGuard, droppedDatagramsOf } = await import('../src/receive')
    const owner = {}
    const guard = createDatagramGuard(owner)
    const good = framed('input', 256, (p) => encodeInput(p, 0, inputWindow(0, 1)))

    let handlerRan = 0
    const onMessage = guard.wrap(() => {
      handlerRan++
      throw new Error('a genuine handler bug')
    })

    expect(() => onMessage('peer', 'unreliable', good)).toThrow(/a genuine handler bug/)
    expect(handlerRan).toBe(1)
    expect(droppedDatagramsOf(owner), 'a handler bug was miscounted as packet loss').toBe(0)
  })

  it('still swallows and counts a throw from a DECODE call, which is the whole reason it exists', () => {
    // The other half, and the reason this is a narrowing rather than a removal.
    // A truncated body throws out of BitReader inside the handler, after the
    // header parsed cleanly; that is a datagram that never arrived, not a bug.
    const ctx = makeNetContext(true)
    const state = racingState(0x5c6, 3)
    const cap = captureTransport()
    const authority = new AuthorityLoop(ctx, state, cap.transport)

    const truncated = framed('input', 256, (p) => encodeInput(p, 3, inputWindow(0, 1))).subarray(0, 5)
    expect(() => cap.deliver('c3', 'unreliable', truncated)).not.toThrow()
    expect(droppedDatagramsOf(authority)).toBe(1)
    // ... and a header that cannot be parsed at all is still caught in wrap().
    expect(() => cap.deliver('c3', 'unreliable', UNKNOWN_TAG)).not.toThrow()
    expect(droppedDatagramsOf(authority)).toBe(2)
  })

  it('runs the handler exactly once per datagram, outside the try', async () => {
    // A narrowing done by moving the handler call after the catch, rather than
    // by rethrowing from inside it, must not leave the call site duplicated:
    // two invocations would double-apply every input in the room.
    const { createDatagramGuard } = await import('../src/receive')
    const seen: string[] = []
    const onMessage = createDatagramGuard({}).wrap((peerId, channel, kind) => {
      seen.push(`${peerId}/${channel}/${kind}`)
    })
    const good = framed('input', 256, (p) => encodeInput(p, 0, inputWindow(0, 1)))
    onMessage('c0', 'unreliable', good)
    onMessage('c1', 'reliable', good)
    expect(seen).toEqual(['c0/unreliable/input', 'c1/reliable/input'])
  })
})
