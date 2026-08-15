import { describe, expect, it } from 'vitest'
import type {
  AuthEvent,
  AuthEventKind,
  EntityKind,
  EntityState,
  Intent,
  ItemKind,
  KartState,
  RacePhase,
  SimState,
  Surface,
} from '@tapkart/sim'
import { MAX_ENTITIES, MAX_KARTS } from '@tapkart/sim'
import type { WireEntity, WireKart, WireSnapshot } from '../src/types'
import { decodeCheckpoint, encodeCheckpoint } from '../src/checkpoint'
import { decodeEvents, encodeEvents } from '../src/events'
import { decodeSnapshot, encodeSnapshot } from '../src/snapshot'

/**
 * THE ENUM HOLE.
 *
 * A string-union enum written to a fixed-width field has 2**bits codes on the
 * wire and, in general, fewer valid values. Every code in the gap is a bit
 * pattern this build's encoder can never produce and that a corrupted or hostile
 * sender produces for free - and until this file existed, most of them decoded
 * to `undefined` through an out-of-range array index, travelled into a
 * WireSnapshot or a SimState, and were read by the simulation as if they were a
 * fact.
 *
 * Task 15c's fix round found and closed exactly one instance - `phase` - after
 * `undefined` reaching SimState.phase made a race unable to ever reach
 * 'finished' (packages/net/test/malformed.test.ts tells that story). `item` and
 * entity `kind` had the identical hole, seven and ten codes wide, in two codecs
 * each.
 *
 * This file is the AUDIT, not a spot-check: for every enum field in every codec
 * it walks the WHOLE code space of the field, asserting that each valid code
 * decodes to its own value and each invalid code is REJECTED. Walking the whole
 * space is what makes "surface has no hole" a measurement rather than a claim,
 * and what makes a future widening of a field (a fifth Surface, a ninth
 * AuthEventKind, an ITEM_BITS bumped to 5) fail here on the day it lands rather
 * than on the day a datagram exercises it.
 *
 * Rejection, not clamping. A clamp manufactures an authoritative fact - which
 * item a kart is holding, whether the race has started - out of bits already
 * known to be wrong, and does it with no counter moving anywhere. A throw is
 * what @tapkart/net's datagram guard turns into a counted, dropped datagram that
 * leaves every byte of loop state untouched, which is how every other
 * undecodable datagram in this system is already treated. The counted-and-
 * dropped half is asserted in packages/net/test/malformed.test.ts; this file
 * asserts the throw that guard is built on.
 */

const BUF_SIZE = 1024
const CHECKPOINT_BUF_SIZE = 8192

// Wire order, restated here on purpose rather than imported: these tables are
// private to each codec, and a test that read the codec's own copy could not
// fail if that copy were reordered - which is the other way an enum silently
// relabels itself on the wire.
//
// KEYED BY THE UNION, exactly as the codecs' own tables now are. These used to
// be `Surface[]` literals, and that is why this file's claim to catch "a fifth
// Surface, a ninth AuthEventKind, an ITEM_BITS bumped to 5" was FALSE for the
// two of those three that are enum growth: an array literal has no binding to
// the union it claims to enumerate, so a fifth Surface compiled, typechecked,
// and left all 805 tests green while every kart carrying it encoded as
// 'offtrack'. `Record<Surface, number>` fails to compile the day the union
// changes - which is the only day the fix is cheap - and it fails here as well
// as in the codec, so the audit and the thing audited move together.
const ITEM_CODE: Record<ItemKind, number> = {
  none: 0, boost: 1, seeker: 2, bolt: 3, slick: 4, bubble: 5, surge: 6, blink: 7, charge: 8,
}
const SURFACE_CODE: Record<Surface, number> = { tarmac: 0, dirt: 1, boost: 2, offtrack: 3 }
const ENTITY_KIND_CODE: Record<EntityKind, number> = {
  seeker: 0, bolt: 1, slick: 2, bubble: 3, surge: 4, charge: 5,
}
const PHASE_CODE: Record<RacePhase, number> = { countdown: 0, racing: 1, finished: 2 }
const AUTH_EVENT_KIND_CODE: Record<AuthEventKind, number> = {
  itemGrant: 0, entitySpawn: 1, entityDespawn: 2, hit: 3, spinOut: 4, respawn: 5, lapCross: 6, finish: 7,
}

/** Written out rather than imported from a codec, for the reason above. */
function orderFrom<T extends string>(table: Record<T, number>): T[] {
  const order: T[] = []
  for (const key of Object.keys(table) as T[]) order[table[key]] = key
  return order
}

const ITEM_ORDER: ItemKind[] = orderFrom(ITEM_CODE)
const SURFACE_ORDER: Surface[] = orderFrom(SURFACE_CODE)
const ENTITY_KIND_ORDER: EntityKind[] = orderFrom(ENTITY_KIND_CODE)
const PHASE_ORDER: RacePhase[] = orderFrom(PHASE_CODE)
const AUTH_EVENT_KIND_ORDER: AuthEventKind[] = orderFrom(AUTH_EVENT_KIND_CODE)

// ---------------------------------------------------------------------------
// Bit surgery, without a second copy of any codec's field offsets.
// ---------------------------------------------------------------------------

/**
 * The bit offset of the single bit that differs between two encodings.
 *
 * This is how every test below finds a field, and it is deliberately not a table
 * of hand-computed offsets. A literal "the item field starts at bit 246" would
 * be a second copy of snapshot.ts's layout, free to drift from the real one in
 * silence - and a test that corrupted the WRONG bits would still see a rejection
 * (from a truncation, an out-of-range quantisation code, anything) and would
 * pass while proving nothing. Encoding the same state twice, moving one enum
 * from code 0 to code 1, leaves exactly one bit different, and that bit is the
 * field's least significant one, located by the encoder itself.
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

/** Writes `code` LSB-first at `bitOffset`, matching BitWriter's bit order. */
function writeCodeAt(buf: Uint8Array, bitOffset: number, code: number, bits: number): void {
  for (let i = 0; i < bits; i++) {
    const idx = bitOffset + i
    if ((code >> i) & 1) buf[idx >> 3] |= 1 << (idx & 7)
    else buf[idx >> 3] &= ~(1 << (idx & 7))
  }
}

/** The 8-byte slot that differs between two float64 encodings. */
function soleDifferingFloat64(a: Uint8Array, b: Uint8Array): number {
  expect(a.length, 'the two encodings are different lengths').toBe(b.length)
  const slots = new Set<number>()
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) slots.add(i - (i % 8))
  expect([...slots], 'moving one enum changed more or less than one float64 slot').toHaveLength(1)
  return [...slots][0]
}

function setFloat64At(buf: Uint8Array, byteOffset: number, value: number): void {
  new DataView(buf.buffer, buf.byteOffset, buf.byteLength).setFloat64(byteOffset, value, true)
}

// ---------------------------------------------------------------------------
// State / snapshot scaffolding, local to this file (as in snapshot.test.ts).
// ---------------------------------------------------------------------------

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

function makeEntity(alive: boolean): EntityState {
  return {
    entityId: alive ? 7 : -1,
    kind: 'seeker',
    ownerId: alive ? 0 : -1,
    position: { x: 0, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    heading: 0,
    targetId: -1,
    ttl: alive ? 60 : 0,
  }
}

/** One live entity in slot 0, so an entity record is actually on the wire. */
function makeState(): SimState {
  return {
    tick: 77,
    phase: 'racing',
    raceSeed: 0,
    rngCursor: 0,
    nextEventSeq: 0,
    finishTick: -1,
    karts: Array.from({ length: MAX_KARTS }, (_, i) => makeKart(i)),
    entities: Array.from({ length: MAX_ENTITIES }, (_, i) => makeEntity(i === 0)),
    entityCount: 1,
    nextEntityId: 8,
    itemBoxes: [{ boxIdx: 0, respawnTicks: 0 }],
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

function makeSnapshotTarget(): WireSnapshot {
  return {
    tick: -1,
    eventSeq: -1,
    phase: 'countdown',
    lastProcessedInputTick: new Array(MAX_KARTS).fill(0) as number[],
    karts: Array.from({ length: MAX_KARTS }, makeWireKart),
    entities: Array.from({ length: MAX_ENTITIES }, makeWireEntity),
    entityCount: 0,
  }
}

const LAST_INPUT = new Array(MAX_KARTS).fill(-1) as number[]

/** A walker over one field's whole code space, located by the encoder itself. */
interface Field {
  offset: number
  frameFor(code: number): Uint8Array
}

function bitField(
  encode: (state: SimState) => Uint8Array,
  set: (state: SimState, code: 0 | 1) => void,
  widthBits: number,
): Field {
  const a = makeState()
  set(a, 0)
  const b = makeState()
  set(b, 1)
  const bufA = encode(a)
  const offset = soleDifferingBit(bufA, encode(b))
  return {
    offset,
    frameFor(code: number): Uint8Array {
      expect(code, 'this test tried to write a code wider than the field').toBeLessThan(2 ** widthBits)
      const frame = bufA.slice()
      writeCodeAt(frame, offset, code, widthBits)
      return frame
    },
  }
}

function encodeState(state: SimState): Uint8Array {
  const buf = new Uint8Array(BUF_SIZE)
  const n = encodeSnapshot(buf, state, LAST_INPUT)
  return buf.slice(0, n)
}

/** Decodes into a fresh target and returns it, or rethrows. */
function decodeInto(frame: Uint8Array): WireSnapshot {
  const out = makeSnapshotTarget()
  decodeSnapshot(frame, out)
  return out
}

describe('decodeSnapshot — every enum field, across its whole code space', () => {
  it('kart item: accepts the 9 real ItemKind codes and rejects all 7 unused ones', () => {
    // 4 bits, 16 codes, 9 values. Codes 9-15 decoded to `undefined` and landed in
    // WireKart.item, then in SimState.karts[i].item, which packages/sim's
    // items.ts reads as the item the kart is holding.
    expect(ITEM_ORDER).toHaveLength(9)
    const field = bitField(encodeState, (s, code) => { s.karts[0].item = ITEM_ORDER[code] }, 4)

    for (let code = 0; code < 16; code++) {
      if (code < ITEM_ORDER.length) {
        expect(decodeInto(field.frameFor(code)).karts[0].item, `item code ${code} decoded to the wrong ItemKind`)
          .toBe(ITEM_ORDER[code])
      } else {
        expect(
          () => decodeInto(field.frameFor(code)),
          `item code ${code} was accepted; it is not one of the 9 ItemKind values`,
        ).toThrow(RangeError)
      }
    }
  })

  it('entity kind: accepts the 6 real EntityKind codes and rejects all 10 unused ones', () => {
    // 4 bits, 16 codes, 6 values - the widest hole in the format.
    expect(ENTITY_KIND_ORDER).toHaveLength(6)
    const field = bitField(encodeState, (s, code) => { s.entities[0].kind = ENTITY_KIND_ORDER[code] }, 4)

    for (let code = 0; code < 16; code++) {
      if (code < ENTITY_KIND_ORDER.length) {
        expect(decodeInto(field.frameFor(code)).entities[0].kind, `entity kind code ${code} decoded wrong`)
          .toBe(ENTITY_KIND_ORDER[code])
      } else {
        expect(
          () => decodeInto(field.frameFor(code)),
          `entity kind code ${code} was accepted; it is not one of the 6 EntityKind values`,
        ).toThrow(RangeError)
      }
    }
  })

  it('phase: accepts the 3 real RacePhase codes and rejects the fourth (Task 15c, pinned here)', () => {
    expect(PHASE_ORDER).toHaveLength(3)
    const field = bitField(encodeState, (s, code) => { s.phase = PHASE_ORDER[code] }, 2)

    for (let code = 0; code < 4; code++) {
      if (code < PHASE_ORDER.length) {
        expect(decodeInto(field.frameFor(code)).phase).toBe(PHASE_ORDER[code])
      } else {
        expect(() => decodeInto(field.frameFor(code)), 'the fourth phase code came back').toThrow(RangeError)
      }
    }
  })

  it('surface: has no hole at all - 2 bits, 4 codes, 4 values, every one of them real', () => {
    // The measurement that makes this file an audit rather than a list of fixes.
    // `surface` is the one snapshot enum whose value count exactly fills its
    // field, so it needs no guard, and adding one would be dead code no datagram
    // could reach.
    //
    // This comment used to end "if a fifth Surface is ever added without
    // widening SURFACE_BITS, this loop is what fails", and that was not true: a
    // fifth Surface left this loop walking the same four codes it always had,
    // because SURFACE_ORDER was a hand-written literal. What fails now is
    // SURFACE_CODE at the top of this file, and snapshot.ts's and
    // checkpoint.ts's copies of it, all three at COMPILE TIME. This loop's job
    // is the narrower one it can actually do: proving that all four codes decode
    // to their own value, so "no hole" is a measurement and not an assumption.
    expect(SURFACE_ORDER).toHaveLength(4)
    const field = bitField(encodeState, (s, code) => { s.karts[0].surface = SURFACE_ORDER[code] }, 2)

    for (let code = 0; code < 4; code++) {
      expect(decodeInto(field.frameFor(code)).karts[0].surface, `surface code ${code} decoded wrong`)
        .toBe(SURFACE_ORDER[code])
    }
  })

  it('packed drift: accepts codes 0-2 and rejects code 3, which aliased onto "drifting right"', () => {
    // driftActive + driftDir share 2 bits: 0 inactive, 1 active-left, 2
    // active-right. Three values in four codes, so this is `phase`'s hole again -
    // but with a quieter failure mode, because code 3 fell through
    // unpackDriftDir's final `else` and decoded as a PLAUSIBLE, VALID drift state
    // (active, dir +1) rather than as undefined. Wrong-but-valid is not better
    // than undefined here: it is a fact about a kart, manufactured out of two
    // bits no encoder in this repository can produce, that no counter records.
    const field = bitField(encodeState, (s, code) => {
      s.karts[0].drift = code === 0
        ? { active: false, dir: 0, charge: 0 }
        : { active: true, dir: -1, charge: 0 }
    }, 2)

    const expected: [boolean, -1 | 0 | 1][] = [[false, 0], [true, -1], [true, 1]]
    for (let code = 0; code < 4; code++) {
      const want = expected[code]
      if (want !== undefined) {
        const k = decodeInto(field.frameFor(code)).karts[0]
        expect([k.driftActive, k.driftDir], `drift code ${code} decoded wrong`).toEqual(want)
      } else {
        expect(
          () => decodeInto(field.frameFor(code)),
          'drift code 3 was accepted and silently became "drifting right"',
        ).toThrow(RangeError)
      }
    }
  })

  it('never writes the undecodable value into the caller-owned target before throwing', () => {
    // Narrow and honest: decodeSnapshot fills the caller's scratch field by
    // field, so the fields BEFORE the bad one are written - that is why every
    // loop in @tapkart/net decodes into scratch and commits by pointer swap
    // afterwards, and why "no state moved" is asserted there and not here. What
    // IS asserted here is that the bad field itself never lands: the throw
    // happens before the assignment, so no `undefined` exists anywhere.
    const field = bitField(encodeState, (s, code) => { s.karts[0].item = ITEM_ORDER[code] }, 4)
    const out = makeSnapshotTarget()
    expect(() => decodeSnapshot(field.frameFor(15), out)).toThrow(RangeError)
    expect(out.karts[0].item, 'a rejected frame still wrote an item').toBe('none')
  })
})

// ---------------------------------------------------------------------------
// The ENCODE side of the same hole
// ---------------------------------------------------------------------------

/**
 * Everything above audits the DECODE side. The encode side had the same hole and
 * nothing was looking at it.
 *
 * `encodeSnapshot` looked its four enums up with `TABLE.indexOf(value)` and wrote
 * the result straight into `writeBits`, unchecked - while checkpoint.ts guarded
 * the identical lookup through `idx()` and events.ts checked `kindIdx < 0`.
 * `writeBits(-1, n)` does not reject: it writes all-ones, so EVERY value outside
 * the table encoded as the field's last valid code. A fifth `Surface` therefore
 * did not produce garbage or an error, it produced code 3 = 'offtrack' - a
 * wrong-but-VALID authoritative fact about a kart, which is exactly what
 * snapshot.ts's own DRIFT_CODES comment argues is no better than `undefined`.
 *
 * The compile-time half of this is `Record<Surface, number>` and cannot be tested
 * from inside TypeScript (a test that failed to compile would not run). These are
 * the runtime half: a value laundered past the compiler by an `as`, which is what
 * a hand-written mapping table, a JSON round trip or a future refactor produces.
 */
describe('encodeSnapshot — a value with no wire code is rejected, not written as -1', () => {
  const cases: [string, (s: SimState) => void][] = [
    ['Surface', (s) => { s.karts[0].surface = 'lava' as Surface }],
    ['ItemKind', (s) => { s.karts[0].item = 'rocket' as ItemKind }],
    ['EntityKind', (s) => { s.entities[0].kind = 'drone' as EntityKind }],
    ['RacePhase', (s) => { s.phase = 'paused' as RacePhase }],
  ]

  for (const [label, poison] of cases) {
    it(`throws on an unknown ${label} instead of encoding the last valid code`, () => {
      const state = makeState()
      poison(state)
      const buf = new Uint8Array(BUF_SIZE)
      expect(() => encodeSnapshot(buf, state, LAST_INPUT), `${label} was encoded as -1`).toThrow(RangeError)
    })
  }

  it('the same value would otherwise have decoded as a real, wrong one', () => {
    // The failure being prevented, stated as the measurement it came from: with
    // the guard removed, `writeBits(-1, 2)` writes 0b11 and the fifth surface
    // arrives as 'offtrack' - the LAST value of the table, silently, on every
    // kart carrying it. Asserted here as the arithmetic rather than by deleting
    // the guard: -1's low 2 bits are 3, which is SURFACE_ORDER's last index.
    expect((-1 >>> 0) % 4).toBe(SURFACE_ORDER.length - 1)
    expect(SURFACE_ORDER[3]).toBe('offtrack')
    // ...and a well-formed snapshot really does carry that code, so the decode
    // side could never have told the difference.
    const state = makeState()
    state.karts[0].surface = 'offtrack'
    expect(decodeInto(encodeState(state)).karts[0].surface).toBe('offtrack')
  })
})

// ---------------------------------------------------------------------------
// events
// ---------------------------------------------------------------------------

function eventWith(item: ItemKind, kind: AuthEventKind): AuthEvent {
  return { eventSeq: 3, tick: 41, kind, playerId: 2, entityId: 9, item, data: 5 }
}

function eventField(build: (code: 0 | 1) => AuthEvent, widthBits: number): Field {
  const encodeOne = (ev: AuthEvent): Uint8Array => {
    const buf = new Uint8Array(BUF_SIZE)
    const n = encodeEvents(buf, [ev])
    return buf.slice(0, n)
  }
  const bufA = encodeOne(build(0))
  const offset = soleDifferingBit(bufA, encodeOne(build(1)))
  return {
    offset,
    frameFor(code: number): Uint8Array {
      expect(code, 'this test tried to write a code wider than the field').toBeLessThan(2 ** widthBits)
      const frame = bufA.slice()
      writeCodeAt(frame, offset, code, widthBits)
      return frame
    },
  }
}

describe('decodeEvents — every enum field, across its whole code space', () => {
  it('item: accepts the 9 real ItemKind codes and rejects all 7 unused ones', () => {
    // Worse than the snapshot's copy: applyEvent (packages/net/src/apply.ts)
    // reads `ev.item` as the kind of ENTITY TO SPAWN as well as the item to
    // grant, so an undefined here reaches the entity pool and stays there.
    const field = eventField((code) => eventWith(ITEM_ORDER[code], 'itemGrant'), 4)
    const out: AuthEvent[] = []

    for (let code = 0; code < 16; code++) {
      if (code < ITEM_ORDER.length) {
        decodeEvents(field.frameFor(code), out)
        expect(out, `event item code ${code} decoded to no event`).toHaveLength(1)
        expect(out[0].item, `event item code ${code} decoded wrong`).toBe(ITEM_ORDER[code])
      } else {
        expect(
          () => decodeEvents(field.frameFor(code), out),
          `event item code ${code} was accepted; it is not one of the 9 ItemKind values`,
        ).toThrow(RangeError)
      }
    }
  })

  it('kind: has no hole - 3 bits, 8 codes, 8 AuthEventKind values, every one of them real', () => {
    expect(AUTH_EVENT_KIND_ORDER).toHaveLength(8)
    const field = eventField((code) => eventWith('none', AUTH_EVENT_KIND_ORDER[code]), 3)
    const out: AuthEvent[] = []

    for (let code = 0; code < 8; code++) {
      decodeEvents(field.frameFor(code), out)
      expect(out[0].kind, `event kind code ${code} decoded wrong`).toBe(AUTH_EVENT_KIND_ORDER[code])
    }
  })
})

// ---------------------------------------------------------------------------
// checkpoint
// ---------------------------------------------------------------------------

/**
 * A checkpoint enum rides as a raw float64, so its unused code space is not 7 or
 * 10 bit patterns but every double that is not a valid index - 2.5, -1, NaN,
 * 1e9. A non-null assertion on the lookup (`ORDER[f()]!`) was the only thing
 * standing there, and `!` is a claim to the compiler, not a check on the bytes.
 *
 * This is the highest-consequence copy of the hole in the system: an
 * AuthorityCheckpoint REPLACES the whole state, so a bad value here is not a
 * field that self-heals on the next snapshot but the baseline every later tick
 * is built on - and checkpoints are sent at exactly the three moments something
 * has already gone wrong (late join, a client past reconciliation recovery,
 * shadow resync after a partition).
 */
function checkpointField(set: (state: SimState, code: 0 | 1) => void): { frameFor(code: number): Uint8Array } {
  const encodeCp = (state: SimState): Uint8Array => {
    const buf = new Uint8Array(CHECKPOINT_BUF_SIZE)
    const n = encodeCheckpoint(buf, state)
    return buf.slice(0, n)
  }
  const a = makeState()
  set(a, 0)
  const b = makeState()
  set(b, 1)
  const bufA = encodeCp(a)
  const offset = soleDifferingFloat64(bufA, encodeCp(b))
  return {
    frameFor(code: number): Uint8Array {
      const frame = bufA.slice()
      setFloat64At(frame, offset, code)
      return frame
    },
  }
}

function freshDst(): SimState {
  const s = makeState()
  s.tick = -1
  s.phase = 'countdown'
  return s
}

/** Doubles no array index can ever be, whatever the table's length. */
const NEVER_AN_INDEX = [-1, 0.5, NaN, Infinity, 1e9]

describe('decodeCheckpoint — every enum field, across its whole code space', () => {
  it('phase, item, surface and entity kind each reject every non-index and every out-of-range index', () => {
    const cases: [string, (s: SimState, c: 0 | 1) => void, number][] = [
      ['phase', (s, c) => { s.phase = PHASE_ORDER[c] }, PHASE_ORDER.length],
      ['item', (s, c) => { s.karts[0].item = ITEM_ORDER[c] }, ITEM_ORDER.length],
      ['surface', (s, c) => { s.karts[0].surface = SURFACE_ORDER[c] }, SURFACE_ORDER.length],
      ['entity kind', (s, c) => { s.entities[0].kind = ENTITY_KIND_ORDER[c] }, ENTITY_KIND_ORDER.length],
    ]

    for (const [label, set, valid] of cases) {
      const field = checkpointField(set)
      // Every real code still round-trips. `surface` has no hole in the SNAPSHOT
      // codec, where it is 2 bits wide, and a full one here, where it is 64 -
      // which is the point: the hole is a property of the field's width, not of
      // the enum.
      for (let code = 0; code < valid; code++) {
        expect(() => decodeCheckpoint(field.frameFor(code), freshDst()), `${label} code ${code}`).not.toThrow()
      }
      // ...and nothing else does. `valid` itself is the first index past the
      // end - the code a table that grew by one would have used.
      for (const bad of [valid, valid + 1, ...NEVER_AN_INDEX]) {
        expect(
          () => decodeCheckpoint(field.frameFor(bad), freshDst()),
          `checkpoint ${label} accepted ${bad}`,
        ).toThrow(RangeError)
      }
    }
  })

  it('drift dir: accepts -1, 0 and 1, and rejects every other double', () => {
    // Not a table index but a raw signed value, cast straight to `-1 | 0 | 1` by
    // an `as` that checks nothing. A checkpoint claiming dir = 4096 reached
    // packages/sim/src/drift.ts, which multiplies by it.
    const field = checkpointField((s, c) => {
      s.karts[0].drift = { active: true, dir: c === 0 ? 0 : 1, charge: 0 }
    })
    for (const good of [-1, 0, 1]) {
      expect(() => decodeCheckpoint(field.frameFor(good), freshDst()), `dir ${good}`).not.toThrow()
    }
    for (const bad of [2, -2, 0.5, NaN, 4096]) {
      expect(() => decodeCheckpoint(field.frameFor(bad), freshDst()), `dir ${bad} was accepted`).toThrow(RangeError)
    }
  })
})
