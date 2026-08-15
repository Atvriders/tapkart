import { describe, expect, it } from 'vitest'
import type { EntityState, Intent, KartState, SimState } from '@tapkart/sim'
import { MAX_ENTITIES, MAX_KARTS } from '@tapkart/sim'
import type { WireEntity, WireKart, WireSnapshot } from '../src/types'
import { BitWriter } from '../src/bits'
import { Q, quantStep } from '../src/quant'
import { applySnapshotToState, decodeSnapshot, encodeSnapshot } from '../src/snapshot'

// 744 B covers the worst case (MAX_ENTITIES=32 live entities, all 8 karts) with
// margin: header(202) + 8*178 kart bits + 32*135 entity bits = 5946 bits = 744 B
// exactly. 1024 gives headroom above that without needing to be recomputed if a
// field width ever changes by a bit or two. (The header is 202 and not the 200
// this comment used to cite because Task 15c item A put a 2-bit `phase` in it;
// the buffer size below never depended on the figure and is unchanged.)
const BUF_SIZE = 1024

const STEP_POS = quantStep(Q.position.min, Q.position.max, Q.position.bits)
const STEP_VEL = quantStep(Q.velocity.min, Q.velocity.max, Q.velocity.bits)
const STEP_HEADING = quantStep(Q.heading.min, Q.heading.max, Q.heading.bits)
const STEP_ANGVEL = quantStep(Q.angularVelocity.min, Q.angularVelocity.max, Q.angularVelocity.bits)
const STEP_DRIFT_CHARGE = quantStep(Q.driftCharge.min, Q.driftCharge.max, Q.driftCharge.bits)
const STEP_T = quantStep(Q.t.min, Q.t.max, Q.t.bits)

function makeNeutralIntent(): Intent {
  return { tick: 0, steer: 0, accel: 0, brake: false, drift: false, useItem: false }
}

function makeKart(playerId: number): KartState {
  return {
    playerId,
    characterIdx: 0,
    isBot: true,
    connected: false,
    position: { x: 0, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    heading: 0,
    angularVelocity: 0,
    drift: { active: false, dir: 0, charge: 0 },
    item: 'none',
    airborne: false,
    surface: 'tarmac',
    spinOutTicks: 0,
    invulnTicks: 0,
    boostTicks: 0,
    respawnTicks: 0,
    shielded: false,
    lap: { lap: 0, checkpointIdx: 0, t: 0 },
  }
}

function makeDeadEntity(): EntityState {
  return {
    entityId: -1,
    kind: 'seeker',
    ownerId: -1,
    position: { x: 0, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    heading: 0,
    targetId: -1,
    ttl: 0,
  }
}

function makeState(): SimState {
  const karts: KartState[] = []
  for (let i = 0; i < MAX_KARTS; i++) karts.push(makeKart(i))
  const entities: EntityState[] = []
  for (let i = 0; i < MAX_ENTITIES; i++) entities.push(makeDeadEntity())
  return {
    tick: 0,
    phase: 'racing',
    raceSeed: 0,
    rngCursor: 0,
    nextEventSeq: 0,
    finishTick: -1,
    karts,
    entities,
    entityCount: 0,
    nextEntityId: 1,
    itemBoxes: [],
    finishedOrder: [-1, -1, -1, -1, -1, -1, -1, -1],
    heldBotIntent: Array.from({ length: MAX_KARTS }, makeNeutralIntent),
    heldBotTick: Array.from({ length: MAX_KARTS }, () => -1),
  }
}

function makeWireKart(): WireKart {
  return {
    playerId: 0,
    position: { x: 0, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    heading: 0,
    angularVelocity: 0,
    driftCharge: 0,
    driftActive: false,
    driftDir: 0,
    airborne: false,
    surface: 'tarmac',
    spinOutTicks: 0,
    invulnTicks: 0,
    item: 'none',
    lap: 0,
    checkpointIdx: 0,
    t: 0,
    isBot: true,
    connected: false,
    boostTicks: 0,
    respawnTicks: 0,
    shielded: false,
  }
}

function makeWireEntity(): WireEntity {
  return {
    entityId: -1,
    kind: 'seeker',
    ownerId: -1,
    position: { x: 0, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    heading: 0,
    ttl: 0,
  }
}

function makeEmptySnapshot(): WireSnapshot {
  return {
    tick: 0,
    eventSeq: 0,
    // Never 'racing': makeState() below builds a 'racing' state, so a decode
    // target that started there would pass every phase assertion in this file
    // without decodeSnapshot ever writing the field.
    phase: 'countdown',
    lastProcessedInputTick: new Array(MAX_KARTS).fill(0) as number[],
    karts: Array.from({ length: MAX_KARTS }, makeWireKart),
    entities: Array.from({ length: MAX_ENTITIES }, makeWireEntity),
    entityCount: 0,
  }
}

describe('encodeSnapshot / decodeSnapshot', () => {
  it('round-trips every kart field, within step for continuous fields, exactly for exact fields', () => {
    const state = makeState()
    state.tick = 12345
    state.nextEventSeq = 42
    const k0 = state.karts[0]
    k0.position = { x: 100.25, y: 3, z: -400.5 }
    k0.velocity = { x: 10, y: -2, z: 5.5 }
    k0.heading = 1.2
    k0.angularVelocity = -3.5
    k0.drift = { active: true, dir: -1, charge: 40 }
    k0.item = 'bolt'
    k0.airborne = true
    k0.surface = 'dirt'
    k0.spinOutTicks = 12
    k0.invulnTicks = 30
    k0.boostTicks = 5
    k0.respawnTicks = 9
    k0.shielded = true
    k0.connected = true
    k0.isBot = false
    k0.lap = { lap: 2, checkpointIdx: 5, t: 0.37 }

    // kart 1 deliberately disagrees: isBot and connected both true. Under a decode
    // that (wrongly) derives isBot as !connected, this combination is unreachable;
    // it is also NOT makeWireKart's default pair (isBot: true, connected: false),
    // so this proves both bits are read off the wire independently rather than one
    // being inferred from the other's default. This is exactly the spec §5
    // transition ("taken over by a bot", "reclaim[ed] on reconnect") where the two
    // can legitimately disagree for a tick.
    const k1 = state.karts[1]
    k1.drift = { active: true, dir: 1, charge: 200 }
    k1.item = 'charge'
    k1.surface = 'boost'
    k1.connected = true
    k1.isBot = true

    const buf = new Uint8Array(BUF_SIZE)
    const lastProcessedInputTick = [100, 101, 0, 0, 0, 0, 0, 0]
    const bytes = encodeSnapshot(buf, state, lastProcessedInputTick)

    const snap = makeEmptySnapshot()
    decodeSnapshot(buf.subarray(0, bytes), snap)

    expect(snap.tick).toBe(12345)
    expect(snap.eventSeq).toBe(42)
    expect(snap.lastProcessedInputTick).toEqual(lastProcessedInputTick)

    const d0 = snap.karts[0]
    expect(Math.abs(d0.position.x - 100.25)).toBeLessThan(STEP_POS)
    expect(Math.abs(d0.position.y - 3)).toBeLessThan(STEP_POS)
    expect(Math.abs(d0.position.z - -400.5)).toBeLessThan(STEP_POS)
    expect(Math.abs(d0.velocity.x - 10)).toBeLessThan(STEP_VEL)
    expect(Math.abs(d0.velocity.y - -2)).toBeLessThan(STEP_VEL)
    expect(Math.abs(d0.velocity.z - 5.5)).toBeLessThan(STEP_VEL)
    expect(Math.abs(d0.heading - 1.2)).toBeLessThan(STEP_HEADING)
    expect(Math.abs(d0.angularVelocity - -3.5)).toBeLessThan(STEP_ANGVEL)
    expect(Math.abs(d0.driftCharge - 40)).toBeLessThan(STEP_DRIFT_CHARGE)
    expect(Math.abs(d0.t - 0.37)).toBeLessThan(STEP_T)
    expect(d0.driftActive).toBe(true)
    expect(d0.driftDir).toBe(-1)
    expect(d0.item).toBe('bolt')
    expect(d0.airborne).toBe(true)
    expect(d0.surface).toBe('dirt')
    expect(d0.spinOutTicks).toBe(12)
    expect(d0.invulnTicks).toBe(30)
    expect(d0.boostTicks).toBe(5)
    expect(d0.respawnTicks).toBe(9)
    expect(d0.shielded).toBe(true)
    expect(d0.connected).toBe(true)
    expect(d0.isBot).toBe(false)
    expect(d0.lap).toBe(2)
    expect(d0.checkpointIdx).toBe(5)
    expect(d0.playerId).toBe(0)

    const d1 = snap.karts[1]
    expect(d1.driftActive).toBe(true)
    expect(d1.driftDir).toBe(1)
    expect(d1.item).toBe('charge')
    expect(d1.surface).toBe('boost')
    // Both true: proves connected did not decode as !isBot, and vice versa.
    expect(d1.connected).toBe(true)
    expect(d1.isBot).toBe(true)
    // kart 0's playerId (0) is tautological -- it equals both the slot index and
    // WireKart's own default. kart 1's playerId (1) is neither, so this is the
    // assertion that actually proves playerId is read off the wire.
    expect(d1.playerId).toBe(1)
  })

  it('round-trips every continuous kart field at both range endpoints exactly', () => {
    const state = makeState()
    const k = state.karts[0]
    k.position = { x: -1024, y: 1024, z: -1024 }
    k.velocity = { x: -64, y: 64, z: -64 }
    k.heading = -Math.PI
    k.angularVelocity = 16
    k.drift.charge = 255
    // t's range is [0, 1); 1 is the upper endpoint writeFloatQ clamps to and
    // quantises exactly. 0 would coincide with makeWireKart's default and prove
    // nothing about decode actually running.
    k.lap.t = 1

    const buf = new Uint8Array(BUF_SIZE)
    const bytes = encodeSnapshot(buf, state, new Array(MAX_KARTS).fill(0))
    const snap = makeEmptySnapshot()
    decodeSnapshot(buf.subarray(0, bytes), snap)

    const d = snap.karts[0]
    expect(d.position).toEqual({ x: -1024, y: 1024, z: -1024 })
    expect(d.velocity).toEqual({ x: -64, y: 64, z: -64 })
    expect(d.heading).toBe(-Math.PI)
    expect(d.angularVelocity).toBe(16)
    expect(d.driftCharge).toBe(255)
    expect(d.t).toBe(1)
  })

  it('clamps out-of-range continuous kart fields instead of wrapping', () => {
    const state = makeState()
    const k = state.karts[0]
    k.position = { x: 5000, y: -5000, z: 0 }
    k.velocity = { x: 100, y: -100, z: 0 }

    const buf = new Uint8Array(BUF_SIZE)
    const bytes = encodeSnapshot(buf, state, new Array(MAX_KARTS).fill(0))
    const snap = makeEmptySnapshot()
    decodeSnapshot(buf.subarray(0, bytes), snap)

    const d = snap.karts[0]
    expect(d.position.x).toBe(1024)
    expect(d.position.y).toBe(-1024)
    expect(d.velocity.x).toBe(64)
    expect(d.velocity.y).toBe(-64)
  })

  it('round-trips live entities packed at the front, sentinels the rest', () => {
    const state = makeState()
    state.entityCount = 2
    state.entities[0] = {
      entityId: 7, kind: 'seeker', ownerId: 3,
      position: { x: 10, y: 0, z: -20 }, velocity: { x: 1, y: 0, z: -1 },
      heading: 0.5, targetId: 4, ttl: 560,
    }
    state.entities[1] = {
      entityId: 8, kind: 'bolt', ownerId: 1,
      position: { x: -5, y: 2, z: 5 }, velocity: { x: -3, y: 0, z: 3 },
      heading: -1.1, targetId: -1, ttl: 30,
    }

    const buf = new Uint8Array(BUF_SIZE)
    const bytes = encodeSnapshot(buf, state, new Array(MAX_KARTS).fill(0))
    const snap = makeEmptySnapshot()
    // Dirty a dead-range slot before decoding, so the tail loop below proves
    // decodeSnapshot actively re-sentinels rather than reading makeWireEntity's
    // already-(-1) default off an untouched object.
    snap.entities[5].entityId = 12345
    decodeSnapshot(buf.subarray(0, bytes), snap)

    expect(snap.entityCount).toBe(2)
    expect(snap.entities[0].entityId).toBe(7)
    expect(snap.entities[0].kind).toBe('seeker')
    expect(snap.entities[0].ownerId).toBe(3)
    expect(Math.abs(snap.entities[0].position.x - 10)).toBeLessThan(STEP_POS)
    expect(Math.abs(snap.entities[0].velocity.z - -1)).toBeLessThan(STEP_VEL)
    expect(Math.abs(snap.entities[0].heading - 0.5)).toBeLessThan(STEP_HEADING)
    expect(snap.entities[0].ttl).toBe(560) // exercises the u8 -> u16 amendment headroom

    expect(snap.entities[1].entityId).toBe(8)
    expect(snap.entities[1].kind).toBe('bolt')

    for (let i = 2; i < MAX_ENTITIES; i++) {
      expect(snap.entities[i].entityId).toBe(-1)
    }
  })

  it('re-sentinels a slot that held a live entity on a previous decode', () => {
    const buf = new Uint8Array(BUF_SIZE)
    const snap = makeEmptySnapshot()

    const busy = makeState()
    busy.entityCount = 1
    busy.entities[0] = {
      entityId: 9, kind: 'slick', ownerId: 2,
      position: { x: 1, y: 0, z: 1 }, velocity: { x: 0, y: 0, z: 0 },
      heading: 0, targetId: -1, ttl: 100,
    }
    let bytes = encodeSnapshot(buf, busy, new Array(MAX_KARTS).fill(0))
    decodeSnapshot(buf.subarray(0, bytes), snap)
    expect(snap.entities[0].entityId).toBe(9)

    const empty = makeState()
    empty.entityCount = 0
    bytes = encodeSnapshot(buf, empty, new Array(MAX_KARTS).fill(0))
    decodeSnapshot(buf.subarray(0, bytes), snap)
    // the same caller-owned `snap` object, decoded into a second time: slot 0 held
    // entity 9 a moment ago and must not still claim to
    expect(snap.entities[0].entityId).toBe(-1)
  })

  it('round-trips every RacePhase, in the header, once per snapshot', () => {
    // Task 15c item A. Before this field existed a guest could never be told the
    // race had NOT started: ClientLoop forced 'racing' at construction because
    // the wire carried no answer, and every guest drove off through the host's
    // countdown.
    //
    // Each value is decoded into a target PRE-SET to a different phase, so a
    // decode that never writes the field cannot pass by inheriting the target's
    // own default.
    const phases: SimState['phase'][] = ['countdown', 'racing', 'finished']
    const others: SimState['phase'][] = ['finished', 'countdown', 'racing']
    const buf = new Uint8Array(BUF_SIZE)
    for (let i = 0; i < phases.length; i++) {
      const state = makeState()
      state.phase = phases[i]
      const bytes = encodeSnapshot(buf, state, new Array(MAX_KARTS).fill(0))
      const snap = makeEmptySnapshot()
      snap.phase = others[i]
      decodeSnapshot(buf.subarray(0, bytes), snap)
      expect(snap.phase, `phase ${phases[i]} did not survive the wire`).toBe(phases[i])
    }
  })

  it('rejects the fourth phase code instead of decoding a phase that does not exist', () => {
    // `phase` is 2 bits and RacePhase has THREE values, so code 3 is a bit
    // pattern no encoder in this repository can produce and any corrupted or
    // hostile sender can. `PHASES[3]` is `undefined`, and that `undefined` used
    // to decode straight through: into WireSnapshot.phase, into
    // ClientLoop.predicted.phase, and from there into a SimState - where
    // resolveInputs never freezes (it compares against 'countdown') and
    // updatePhase returns early (it compares against 'countdown', then against
    // 'racing'), so the local race could never reach 'finished' again. Measured:
    // still `undefined` 300 ticks later.
    //
    // Rejected rather than clamped, and rejected by throwing, because that is
    // how EVERY other undecodable datagram in this codebase is treated: the
    // datagram guard in @tapkart/net catches the throw, counts the drop and
    // leaves every byte of loop state untouched (see receive.ts, "a datagram
    // that cannot be decoded is a datagram that never arrived"). A clamp would
    // do the opposite - manufacture an authoritative fact about whether the race
    // has started out of two bits known to be wrong - and it would do it
    // silently, with no counter moving anywhere.
    const state = makeState()
    state.phase = 'finished' // wire index 2 = 0b10
    const buf = new Uint8Array(BUF_SIZE)
    const bytes = encodeSnapshot(buf, state, new Array(MAX_KARTS).fill(0))

    // The phase field is bits 64-65 - `tick u32` then `eventSeq u32` - and
    // BitWriter is LSB-first within each byte (contract §0), so it is byte 8's
    // two low bits. ASSERTED, not assumed: a test that corrupted the wrong two
    // bits would still see a throw, from somewhere else entirely, and would
    // "pass" while testing nothing.
    expect(buf[8] & 0b11, 'the phase field is not where this test thinks it is').toBe(2)

    buf[8] |= 0b11
    const snap = makeEmptySnapshot()
    expect(() => decodeSnapshot(buf.subarray(0, bytes), snap)).toThrow(RangeError)

    // Control: the same buffer, same two bits, set to a REAL code decodes
    // cleanly. Without this the throw above could be collateral damage from
    // having corrupted the header at all.
    buf[8] &= ~0b11
    decodeSnapshot(buf.subarray(0, bytes), snap)
    expect(snap.phase).toBe('countdown')
  })

  it('returns the exact byte count for a given entityCount - no per-record padding', () => {
    const state = makeState()
    state.entityCount = 3
    for (let i = 0; i < 3; i++) state.entities[i] = { ...makeDeadEntity(), entityId: i }
    const buf = new Uint8Array(BUF_SIZE)
    const bytes = encodeSnapshot(buf, state, new Array(MAX_KARTS).fill(0))
    // 202 header bits + 8*178 kart bits + 3*135 entity bits, continuously packed,
    // rounded up once at the very end (this task's settled facts 1 and 2). The
    // header is 202 and not 200 because of the 2-bit phase field (Task 15c).
    const totalBits = 202 + MAX_KARTS * 178 + 3 * 135
    expect(bytes).toBe(Math.ceil(totalBits / 8))
  })

  it('holds the exact bit formula across a sweep of entity counts, so ONE added bit cannot hide', () => {
    // THE bit-count assertion, and the reason it is a sweep rather than the
    // single check above it. A snapshot's size is rounded up to whole bytes
    // exactly once, at the end, so at any ONE entity count a field added without
    // updating the total is invisible seven times out of eight - the extra bit
    // just eats padding. An entity record is 135 bits, and 135 mod 8 = 7, so
    // consecutive entity counts walk through all eight residues: at least one of
    // the nine cases below sits exactly on a byte boundary, where a single added
    // bit changes the byte count and fails here.
    const HEADER_BITS = 202
    const KART_BITS = 178
    const ENTITY_BITS = 135
    const buf = new Uint8Array(BUF_SIZE)
    let sawByteBoundary = false
    for (let n = 0; n <= 8; n++) {
      const state = makeState()
      state.entityCount = n
      for (let i = 0; i < n; i++) state.entities[i] = { ...makeDeadEntity(), entityId: i + 1 }
      const totalBits = HEADER_BITS + MAX_KARTS * KART_BITS + n * ENTITY_BITS
      if (totalBits % 8 === 0) sawByteBoundary = true
      expect(
        encodeSnapshot(buf, state, new Array(MAX_KARTS).fill(0)),
        `${n} entities: encoded size disagrees with ${totalBits} bits`,
      ).toBe(Math.ceil(totalBits / 8))
    }
    // The control that makes the sweep worth running: without a case landing on
    // a byte boundary, every assertion above tolerates an off-by-one-bit format.
    expect(sawByteBoundary, 'no entity count in the sweep lands on a byte boundary').toBe(true)
  })

  it('round-trips at the worst case: MAX_ENTITIES live entities, all karts populated', () => {
    // header(202) + 8*178 kart bits + 32*135 entity bits = 5946 bits = 744 B
    // -- the figure spec §5 gives as the worst case, recomputed for the 2-bit
    // phase field (Task 15c item A; it was 5944 bits = 743 B before).
    // BitWriter.writeBits silently no-ops past a Uint8Array's end (Task 4), so an
    // undersized buffer here would truncate without ever throwing; this is the one
    // test in this task that would catch it.
    const state = makeState()
    state.entityCount = MAX_ENTITIES
    for (let i = 0; i < MAX_ENTITIES; i++) {
      state.entities[i] = {
        entityId: i + 1, kind: 'seeker', ownerId: i % MAX_KARTS,
        position: { x: i, y: 0, z: -i }, velocity: { x: 1, y: 0, z: -1 },
        heading: 0.1 * i, targetId: -1, ttl: 100 + i,
      }
    }
    const buf = new Uint8Array(BUF_SIZE)
    const bytes = encodeSnapshot(buf, state, new Array(MAX_KARTS).fill(0))
    expect(bytes).toBe(744)

    const snap = makeEmptySnapshot()
    decodeSnapshot(buf.subarray(0, bytes), snap)
    expect(snap.entityCount).toBe(MAX_ENTITIES)
    expect(snap.entities[MAX_ENTITIES - 1].entityId).toBe(MAX_ENTITIES)
    expect(snap.entities[MAX_ENTITIES - 1].ttl).toBe(100 + MAX_ENTITIES - 1)
  })

  it('round-trips the -1 "no real input yet" sentinel in lastProcessedInputTick, biased so it never collides with a real tick', () => {
    // Without the +1 bias, -1 encodes as the raw two's-complement bit pattern
    // BitWriter.writeBits produces for a negative value into 16 bits (0xFFFF)
    // and decodes back as 65535 -- a real (if implausible) tick number, not
    // "nothing received yet". This state's tick/entity contents don't matter;
    // only the header's lastProcessedInputTick array is under test here.
    const state = makeState()
    const buf = new Uint8Array(BUF_SIZE)
    // Mixes the sentinel with real ticks, including one adjacent to the
    // sentinel's own biased wire value (0) and one near the top of the
    // biased range, so an off-by-one in the bias would show up as a specific
    // wrong number rather than a coincidental pass.
    const lastProcessedInputTick = [-1, 0, 1, -1, 65534, -1, -1, -1]
    const bytes = encodeSnapshot(buf, state, lastProcessedInputTick)

    const snap = makeEmptySnapshot()
    decodeSnapshot(buf.subarray(0, bytes), snap)

    expect(snap.lastProcessedInputTick).toEqual(lastProcessedInputTick)
  })

  it('writes header then karts in exactly contract §4 row order, then entities', () => {
    const state = makeState()
    const k = state.karts[3]
    k.position = { x: 50, y: -6, z: 12 }
    k.velocity = { x: 4, y: 1, z: -2 }
    k.heading = -0.3
    k.angularVelocity = 2
    k.drift = { active: true, dir: 1, charge: 90 }
    k.item = 'surge'
    k.airborne = true
    k.surface = 'offtrack'
    k.spinOutTicks = 3
    k.invulnTicks = 20
    k.boostTicks = 60
    k.respawnTicks = 40
    k.lap = { lap: 1, checkpointIdx: 4, t: 0.8 }
    k.shielded = true
    k.connected = true
    k.isBot = false

    const buf = new Uint8Array(BUF_SIZE)
    const lastProcessedInputTick = [1, 2, 3, 4, 5, 6, 7, 8]
    const bytes = encodeSnapshot(buf, state, lastProcessedInputTick)

    // Independently reconstruct the same message with the raw primitives, in
    // exactly contract §4's row order - this is the specification, not a restated
    // guess at the implementation's internals.
    const ITEM_KINDS = ['none', 'boost', 'seeker', 'bolt', 'slick', 'bubble', 'surge', 'blink', 'charge']
    const SURFACES = ['tarmac', 'dirt', 'boost', 'offtrack']
    const ref = new Uint8Array(BUF_SIZE)
    const rw = new BitWriter(ref)
    rw.writeBits(state.tick, 32)
    rw.writeBits(state.nextEventSeq, 32)
    // Task 15c item A: 2 bits of phase, in the header, immediately after
    // eventSeq. 'racing' is index 1 of ['countdown', 'racing', 'finished'].
    rw.writeBits(['countdown', 'racing', 'finished'].indexOf(state.phase), 2)
    // +1-biased, same as encodeSnapshot: -1 travels as 0.
    for (let i = 0; i < MAX_KARTS; i++) rw.writeBits(lastProcessedInputTick[i] + 1, 16)
    rw.writeBits(state.entityCount, 8)
    for (let i = 0; i < MAX_KARTS; i++) {
      const kk = state.karts[i]
      rw.writeFloatQ(kk.position.x, Q.position.min, Q.position.max, Q.position.bits)
      rw.writeFloatQ(kk.position.y, Q.position.min, Q.position.max, Q.position.bits)
      rw.writeFloatQ(kk.position.z, Q.position.min, Q.position.max, Q.position.bits)
      rw.writeFloatQ(kk.velocity.x, Q.velocity.min, Q.velocity.max, Q.velocity.bits)
      rw.writeFloatQ(kk.velocity.y, Q.velocity.min, Q.velocity.max, Q.velocity.bits)
      rw.writeFloatQ(kk.velocity.z, Q.velocity.min, Q.velocity.max, Q.velocity.bits)
      rw.writeFloatQ(kk.heading, Q.heading.min, Q.heading.max, Q.heading.bits)
      rw.writeFloatQ(kk.angularVelocity, Q.angularVelocity.min, Q.angularVelocity.max, Q.angularVelocity.bits)
      rw.writeFloatQ(kk.drift.charge, Q.driftCharge.min, Q.driftCharge.max, Q.driftCharge.bits)
      rw.writeFloatQ(kk.lap.t, Q.t.min, Q.t.max, Q.t.bits)
      rw.writeBits(kk.spinOutTicks, 8)
      rw.writeBits(kk.invulnTicks, 8)
      rw.writeBits(kk.boostTicks, 7)
      rw.writeBits(kk.respawnTicks, 7)
      rw.writeBits(kk.lap.lap, 3)
      rw.writeBits(kk.lap.checkpointIdx, 6)
      rw.writeBits(ITEM_KINDS.indexOf(kk.item), 4)
      rw.writeBits(SURFACES.indexOf(kk.surface), 2)
      rw.writeBits(!kk.drift.active ? 0 : kk.drift.dir === -1 ? 1 : 2, 2)
      rw.writeBits(kk.airborne ? 1 : 0, 1)
      rw.writeBits(kk.shielded ? 1 : 0, 1)
      rw.writeBits(kk.isBot ? 1 : 0, 1)
      rw.writeBits(kk.connected ? 1 : 0, 1)
      rw.writeBits(kk.playerId, 3)
    }

    expect(bytes).toBe(rw.byteLength())
    expect(Array.from(buf.subarray(0, bytes))).toEqual(Array.from(ref.subarray(0, bytes)))
  })
})

describe('applySnapshotToState', () => {
  it('copies every WireKart field into the matching nested SimState field', () => {
    const source = makeState()
    const k = source.karts[2]
    k.position = { x: 11, y: 2, z: -33 }
    k.velocity = { x: 1, y: 0, z: -1 }
    k.heading = 0.9
    k.angularVelocity = -1
    k.drift = { active: true, dir: -1, charge: 15 }
    k.item = 'bubble'
    k.airborne = true
    k.surface = 'dirt'
    k.spinOutTicks = 7
    k.invulnTicks = 3
    k.boostTicks = 20
    // 0 would coincide with makeKart's default and dst's own starting value,
    // proving nothing about whether this field was actually copied.
    k.respawnTicks = 15
    k.shielded = true
    k.connected = true
    k.isBot = false
    k.lap = { lap: 1, checkpointIdx: 2, t: 0.6 }

    const buf = new Uint8Array(BUF_SIZE)
    const bytes = encodeSnapshot(buf, source, new Array(MAX_KARTS).fill(0))
    const snap = makeEmptySnapshot()
    decodeSnapshot(buf.subarray(0, bytes), snap)

    const dst = makeState()
    applySnapshotToState(snap, dst)

    const dk = dst.karts[2]
    expect(Math.abs(dk.position.x - 11)).toBeLessThan(STEP_POS)
    expect(Math.abs(dk.velocity.z - -1)).toBeLessThan(STEP_VEL)
    expect(Math.abs(dk.heading - 0.9)).toBeLessThan(STEP_HEADING)
    expect(Math.abs(dk.angularVelocity - -1)).toBeLessThan(STEP_ANGVEL)
    expect(dk.drift.active).toBe(true)
    expect(dk.drift.dir).toBe(-1)
    expect(Math.abs(dk.drift.charge - 15)).toBeLessThan(STEP_DRIFT_CHARGE)
    expect(dk.item).toBe('bubble')
    expect(dk.airborne).toBe(true)
    expect(dk.surface).toBe('dirt')
    expect(dk.spinOutTicks).toBe(7)
    expect(dk.invulnTicks).toBe(3)
    expect(dk.boostTicks).toBe(20)
    expect(dk.respawnTicks).toBe(15)
    expect(dk.shielded).toBe(true)
    expect(dk.connected).toBe(true)
    expect(dk.isBot).toBe(false)
    expect(dk.lap.lap).toBe(1)
    expect(dk.lap.checkpointIdx).toBe(2)
    expect(Math.abs(dk.lap.t - 0.6)).toBeLessThan(STEP_T)
  })

  it('copies every WireEntity field except targetId, which the wire does not carry', () => {
    const source = makeState()
    source.entityCount = 1
    source.entities[0] = {
      entityId: 5, kind: 'charge', ownerId: 2,
      position: { x: 3, y: 0, z: 4 }, velocity: { x: 0, y: 0, z: 1 },
      heading: 1, targetId: 6, ttl: 200,
    }
    const buf = new Uint8Array(BUF_SIZE)
    const bytes = encodeSnapshot(buf, source, new Array(MAX_KARTS).fill(0))
    const snap = makeEmptySnapshot()
    decodeSnapshot(buf.subarray(0, bytes), snap)

    const dst = makeState()
    dst.entities[0].targetId = 999 // marker: not on the wire, must survive untouched

    applySnapshotToState(snap, dst)

    expect(dst.entityCount).toBe(1)
    expect(dst.entities[0].entityId).toBe(5)
    expect(dst.entities[0].kind).toBe('charge')
    expect(dst.entities[0].ownerId).toBe(2)
    expect(Math.abs(dst.entities[0].position.z - 4)).toBeLessThan(STEP_POS)
    expect(dst.entities[0].ttl).toBe(200)
    expect(dst.entities[0].targetId).toBe(999)
  })

  it('resets a re-sentinelled entity slot\'s targetId to -1, matching entity.ts\'s clearSlot convention', () => {
    // A dead slot on the wire (entityId === -1) carries no targetId at all -
    // WireEntity has no such field - but the DESTINATION slot may still hold
    // one left over from an earlier decode, when it was a live seeker homing
    // on some kart. Left alone, a shadow that reconciles right after that
    // seeker despawns (Task 16's ShadowLoop.reconcile calls this function
    // directly) would carry a targetId referencing a kart no entity in the
    // decoded state is actually homing on - residue entity.ts's own
    // clearSlot() would never produce for a real dead slot.
    const source = makeState()
    source.entityCount = 0 // nothing live on the wire
    const buf = new Uint8Array(BUF_SIZE)
    const bytes = encodeSnapshot(buf, source, new Array(MAX_KARTS).fill(0))
    const snap = makeEmptySnapshot()
    decodeSnapshot(buf.subarray(0, bytes), snap)
    expect(snap.entities[0].entityId).toBe(-1)

    const dst = makeState()
    // Marker: simulates the slot's leftover state from an earlier decode that
    // held a live seeker targeting kart 5. Not -1, so a fix-free run leaves it
    // exactly here rather than by coincidence landing on the right answer.
    dst.entities[0].targetId = 5

    applySnapshotToState(snap, dst)

    expect(dst.entities[0].entityId).toBe(-1)
    expect(dst.entities[0].targetId).toBe(-1)
  })

  it('resets targetId when a live slot\'s occupant changes identity via swap-remove, not just when it dies', () => {
    // entity.ts's despawn is a swap-remove: when entity A despawns from slot i,
    // the LAST live entity (call it B) is moved into slot i to keep live entities
    // packed at the front (packages/sim/src/entity.ts's clearSlot/spawnEntity).
    // So a slot's occupant can change identity WITHOUT the wire's entityId for
    // that slot ever passing through -1 - a reset condition keyed on "wire
    // entityId is -1" cannot see this transition at all. Neither the dead-slot
    // test above nor the "copies every WireEntity field" test covers this: both
    // hold the slot's occupant identity fixed (same entity, or dead), never
    // swap it for a *different* live entity the way this test does.
    const dst = makeState()

    // Round 1: slot 0 gets live entity 7 (A).
    const stateA = makeState()
    stateA.entityCount = 1
    stateA.entities[0] = {
      entityId: 7, kind: 'seeker', ownerId: 1,
      position: { x: 1, y: 0, z: 1 }, velocity: { x: 0, y: 0, z: 0 },
      heading: 0, targetId: -1, ttl: 50,
    }
    const buf = new Uint8Array(BUF_SIZE)
    let bytes = encodeSnapshot(buf, stateA, new Array(MAX_KARTS).fill(0))
    const snap = makeEmptySnapshot()
    decodeSnapshot(buf.subarray(0, bytes), snap)
    applySnapshotToState(snap, dst)
    expect(dst.entities[0].entityId).toBe(7)

    // Simulates local sim logic (not the wire - WireEntity carries no targetId)
    // setting entity 7's targetId while it was alive in slot 0, e.g. homing on
    // kart 2. A marker, not -1, so a fix-free run leaves it exactly here rather
    // than by coincidence landing on the right answer.
    dst.entities[0].targetId = 2

    // Round 2: entity 7 despawns; entity 12 (B, a genuinely different id) is
    // swap-removed into slot 0. The wire's entityId for slot 0 is 12, never -1 -
    // this is the crux of the swap-remove case: the "same caller-owned dst,
    // decoded into a second time" pattern from the encode/decode describe
    // block's own re-sentinel test, but for a live-to-different-live transition
    // instead of live-to-dead.
    const stateB = makeState()
    stateB.entityCount = 1
    stateB.entities[0] = {
      entityId: 12, kind: 'bolt', ownerId: 3,
      position: { x: 2, y: 0, z: 2 }, velocity: { x: 1, y: 0, z: 0 },
      heading: 0.4, targetId: -1, ttl: 80,
    }
    bytes = encodeSnapshot(buf, stateB, new Array(MAX_KARTS).fill(0))
    decodeSnapshot(buf.subarray(0, bytes), snap)
    expect(snap.entities[0].entityId).toBe(12) // confirms the wire never showed -1

    applySnapshotToState(snap, dst)

    // B must not inherit A's stale targetId. Without the fix (reset keyed on
    // s.entityId === -1 instead of s.entityId !== prevEntityId), this assertion
    // is the one that fails: dst.entities[0].targetId stays 2, the fix-free
    // implementation's unconditional "leave a live slot's targetId alone"
    // branch never having been told entity 12 is not entity 7, so kart 2's
    // stale target reference is now silently misattributed to entity 12.
    expect(dst.entities[0].entityId).toBe(12)
    expect(dst.entities[0].targetId).toBe(-1)
  })

  it('writes tick and entityCount, since both are carried on the wire', () => {
    const source = makeState()
    source.tick = 777
    // Nonzero and different from dst's starting value below, so this proves a
    // real copy rather than two defaults happening to agree at 0.
    source.entityCount = 4
    const buf = new Uint8Array(BUF_SIZE)
    const bytes = encodeSnapshot(buf, source, new Array(MAX_KARTS).fill(0))
    const snap = makeEmptySnapshot()
    decodeSnapshot(buf.subarray(0, bytes), snap)

    const dst = makeState()
    dst.tick = 1
    dst.entityCount = 1
    applySnapshotToState(snap, dst)
    expect(dst.tick).toBe(777)
    expect(dst.entityCount).toBe(4)
  })

  it('does not touch any field the wire does not carry, while still writing the fields it does', () => {
    const source = makeState()
    // A positive companion to the negative checks below: proves this function
    // does something, not just that it leaves the exclusion list alone (a
    // complete no-op would otherwise pass every assertion in this test).
    source.tick = 999
    const buf = new Uint8Array(BUF_SIZE)
    const bytes = encodeSnapshot(buf, source, new Array(MAX_KARTS).fill(0))
    const snap = makeEmptySnapshot()
    decodeSnapshot(buf.subarray(0, bytes), snap)

    const dst = makeState()
    dst.rngCursor = 999
    dst.nextEventSeq = 888
    dst.nextEntityId = 777
    dst.itemBoxes = [{ boxIdx: 0, respawnTicks: 42 }]
    dst.finishedOrder = [3, -1, -1, -1, -1, -1, -1, -1]
    // `phase` LEFT this exclusion list in Task 15c: the wire carries it now, so
    // leaving it alone would be a follower that never learns the race started.
    // Set to a value the wire disagrees with (`source` is 'racing'), so the
    // assertion below measures a write rather than a coincidence.
    dst.phase = 'finished'
    dst.finishTick = 555
    dst.raceSeed = 333
    dst.heldBotIntent = dst.heldBotIntent.map((intent, i) =>
      i === 0 ? { ...intent, tick: 111 } : intent,
    )
    dst.heldBotTick = dst.heldBotTick.map((t, i) => (i === 0 ? 222 : t))
    dst.karts[0].characterIdx = 6

    applySnapshotToState(snap, dst)

    expect(dst.tick).toBe(999)
    expect(dst.rngCursor).toBe(999)
    expect(dst.nextEventSeq).toBe(888)
    expect(dst.nextEntityId).toBe(777)
    expect(dst.itemBoxes).toEqual([{ boxIdx: 0, respawnTicks: 42 }])
    expect(dst.finishedOrder).toEqual([3, -1, -1, -1, -1, -1, -1, -1])
    expect(dst.phase, 'phase is on the wire now and must be applied, not preserved').toBe('racing')
    expect(dst.finishTick).toBe(555)
    expect(dst.raceSeed).toBe(333)
    expect(dst.heldBotIntent[0].tick).toBe(111)
    expect(dst.heldBotTick[0]).toBe(222)
    expect(dst.karts[0].characterIdx).toBe(6)
  })
})

describe('@tapkart/protocol barrel', () => {
  it('re-exports encodeSnapshot, decodeSnapshot and applySnapshotToState', async () => {
    const pkg = await import('@tapkart/protocol')
    expect(typeof pkg.encodeSnapshot).toBe('function')
    expect(typeof pkg.decodeSnapshot).toBe('function')
    expect(typeof pkg.applySnapshotToState).toBe('function')
  })
})
