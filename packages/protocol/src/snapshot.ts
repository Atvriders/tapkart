import type { EntityKind, ItemKind, RacePhase, SimState, Surface } from '@tapkart/sim'
import { MAX_ENTITIES, MAX_KARTS } from '@tapkart/sim'
import type { WireSnapshot } from './types'
import { BitReader, BitWriter } from './bits'
import { Q } from './quant'

// WireKart and WireEntity are never named directly in this file: `out.karts[i]`
// and `out.entities[i]` are inferred through WireSnapshot's own field types, and
// `noUnusedLocals` (tsconfig.base.json) rejects an import that is never
// referenced by name - only WireSnapshot itself is written as a type annotation
// below.

/**
 * Enum <-> wire-code tables.
 *
 * KEYED BY THE UNION, not written as an array of values, and that is the whole
 * point of the shape. `Record<Surface, number>` is a COMPILE-TIME EXHAUSTIVENESS
 * CHECK in both directions: add a fifth `Surface` to packages/sim/src/types.ts
 * and this object literal stops compiling ("Property 'lava' is missing"); delete
 * one and it stops compiling too ("Object literal may only specify known
 * properties"). Rename one and both halves fire.
 *
 * These used to be `const SURFACES: Surface[] = ['tarmac', ...]` - a hand-written
 * literal with no binding to the union at all. A fifth Surface left every test in
 * this repository green and typecheck clean, `SURFACES.indexOf(k.surface)`
 * returned -1 for every kart carrying it, and `writeBits(-1, 2)` writes all-ones,
 * so it encoded as code 3 = 'offtrack': a wrong-but-VALID authoritative fact
 * about a kart, which DRIFT_CODES' comment below argues at length is no better
 * than `undefined`. Three separate comments (here, in
 * packages/protocol/test/enum-codes.test.ts, and in Task 18's report) asserted
 * that a fifth Surface would be caught; none of the three was true, through two
 * reviews.
 *
 * The wire order is unchanged and is now stated as explicit codes rather than
 * implied by array position, so a reorder is a visible diff on a number rather
 * than a silent relabelling of every kart's item. Order matches
 * packages/sim/src/types.ts exactly (verified by reading that file).
 */
const ITEM_CODE: Record<ItemKind, number> = {
  none: 0, boost: 1, seeker: 2, bolt: 3, slick: 4, bubble: 5, surge: 6, blink: 7, charge: 8,
}
const SURFACE_CODE: Record<Surface, number> = { tarmac: 0, dirt: 1, boost: 2, offtrack: 3 }
const ENTITY_KIND_CODE: Record<EntityKind, number> = {
  seeker: 0, bolt: 1, slick: 2, bubble: 3, surge: 4, charge: 5,
}
/**
 * Three phases in 2 bits; code 3 is unused. Order matches RacePhase's own
 * declaration in packages/sim/src/types.ts.
 *
 * "Unused" is an encoder-side statement, not a decoder-side one: nothing in this
 * repository writes code 3, and a corrupted or hostile sender writes whatever it
 * likes. `PHASES[3]` is `undefined`, and until Task 15c's fix round that
 * `undefined` decoded straight through - into `WireSnapshot.phase`, into
 * `ClientLoop.predicted.phase`, and into a `SimState`, where it is worse than a
 * wrong phase because it matches NONE of the comparisons the sim makes:
 * `resolveInputs` freezes on `=== 'countdown'` and `updatePhase` branches on
 * `'countdown'` then `'racing'`, so a race carrying it can never reach
 * 'finished'. `decodeSnapshot` rejects it below.
 */
const PHASE_CODE: Record<RacePhase, number> = { countdown: 0, racing: 1, finished: 2 }

/**
 * The decode-side inverse of a code table: `order[code] === value`. Built once at
 * module load, from the Record above, so the two directions cannot disagree -
 * which is the other way a pair of hand-written tables silently relabels a wire
 * field.
 */
function orderFrom<T extends string>(table: Record<T, number>): T[] {
  const order: T[] = []
  for (const key of Object.keys(table) as T[]) order[table[key]] = key
  return order
}

const ITEM_KINDS: ItemKind[] = orderFrom(ITEM_CODE)
const SURFACES: Surface[] = orderFrom(SURFACE_CODE)
const ENTITY_KINDS: EntityKind[] = orderFrom(ENTITY_KIND_CODE)
const PHASES: RacePhase[] = orderFrom(PHASE_CODE)

/**
 * `orderFrom`'s inverse, GUARDED - the encode-side half this file did not have.
 *
 * Every encode-side lookup here used to be a bare `TABLE.indexOf(value)` whose
 * result went straight into `writeBits` unchecked, while checkpoint.ts guarded
 * the identical lookup through `idx()` and events.ts checked `kindIdx < 0`. -1 is
 * not a rejection when it reaches `writeBits`: it writes all-ones, so every
 * out-of-table value encodes as the field's LAST valid code. This is the encode
 * side of exactly the hole decodeSnapshot's `=== undefined` checks close on the
 * decode side, and it is reachable the moment a union gains a member or a caller
 * launders a string through an `as`.
 *
 * The Record above makes the compiler's half of this unreachable; this function
 * is the runtime half, for the values TypeScript never saw.
 */
function codeOf<T extends string>(table: Record<T, number | undefined>, value: T, label: string): number {
  const code = table[value]
  if (code === undefined) {
    throw new RangeError(`encodeSnapshot: ${label} ${String(value)} has no wire code`)
  }
  return code
}

// Entity and header fields are plain fixed-width integers with no epsilon concept:
// sourced here as literals straight from contract §4's prose, not through Q, which
// covers only the six continuous per-kart fields.
const ENTITY_ID_BITS = 16
const ENTITY_KIND_BITS = 4
const ENTITY_OWNER_BITS = 3
const ENTITY_TTL_BITS = 16
const HEADER_TICK_BITS = 32
const HEADER_EVENT_SEQ_BITS = 32
const HEADER_LAST_INPUT_TICK_BITS = 16
const HEADER_ENTITY_COUNT_BITS = 8
/**
 * Task 15c item A. In the HEADER, once per snapshot, and NOT a 23rd column of
 * the per-kart record: spec §5 states that record's invariant outright - "the
 * per-kart record is a complete projection of every field in SimState's kart
 * struct; a field absent from this table cannot exist in the kart struct" - and
 * `phase` lives on SimState. Eight copies of one global value would also be a
 * wire format capable of expressing eight karts disagreeing about whether the
 * race has started.
 *
 * This makes the header 202 bits (was 200) and the worst-case snapshot 744 B
 * (was 743).
 */
const HEADER_PHASE_BITS = 2

// The fourteen exact/enum per-kart fields contract §4 gives no Q/EPS entry to
// (Task 5): no quantisation noise, so no epsilon, and the widths live here as
// literals in exactly contract §4's row order.
const SPIN_OUT_TICKS_BITS = 8
const INVULN_TICKS_BITS = 8
const BOOST_TICKS_BITS = 7
const RESPAWN_TICKS_BITS = 7
const LAP_BITS = 3
const CHECKPOINT_IDX_BITS = 6
const ITEM_BITS = 4
const SURFACE_BITS = 2
const DRIFT_PACKED_BITS = 2
const AIRBORNE_BITS = 1
const SHIELDED_BITS = 1
const IS_BOT_BITS = 1
const CONNECTED_BITS = 1
const PLAYER_ID_BITS = 3

/** driftActive+driftDir -> 2 raw bits. 0 = inactive, 1 = active dir -1, 2 = active
 * dir 1. 3 is unused: packages/sim/src/drift.ts never produces dir != 0 while
 * inactive (this task's decision 4). */
function packDrift(active: boolean, dir: -1 | 0 | 1): number {
  if (!active) return 0
  return dir === -1 ? 1 : 2
}

/**
 * How many of this 2-bit field's four codes mean anything: three. The fourth is
 * the same hole `phase` had, with a quieter failure mode - unpackDriftDir's
 * final `else` swallowed code 3 and returned a PLAUSIBLE, VALID drift state
 * (active, dir +1), so a corrupted or hostile sender could assert that a kart is
 * drifting right and nothing anywhere would record that it had. Wrong-but-valid
 * is not an improvement on undefined when the value is an authoritative fact
 * about a kart: it is the same manufactured fact, harder to see.
 */
const DRIFT_CODES = 3

function unpackDriftActive(raw: number): boolean {
  return raw !== 0
}

function unpackDriftDir(raw: number): -1 | 0 | 1 {
  if (raw === 0) return 0
  return raw === 1 ? -1 : 1
}

/**
 * Projects `state` onto the wire. Writes the header, then all MAX_KARTS kart
 * records in slot order (each one's fields in exactly contract §4's row order),
 * then `state.entityCount` entity records (only the live ones - dead slots are
 * never written, which is why a typical snapshot is far smaller than the
 * MAX_ENTITIES worst case). Returns the number of bytes written.
 */
export function encodeSnapshot(
  out: Uint8Array,
  state: SimState,
  lastProcessedInputTick: number[],
): number {
  const bw = new BitWriter(out)

  bw.writeBits(state.tick, HEADER_TICK_BITS)
  bw.writeBits(state.nextEventSeq, HEADER_EVENT_SEQ_BITS)
  bw.writeBits(codeOf(PHASE_CODE, state.phase, 'RacePhase'), HEADER_PHASE_BITS)
  for (let i = 0; i < MAX_KARTS; i++) {
    // Biased by +1, same scheme as AuthEvent.playerId/entityId (Task 9): -1
    // ("no real input yet") travels as 0, and real tick T travels as T + 1.
    // An unbiased write would make -1 indistinguishable from "the newest real
    // input was tick 65535" on the wire.
    bw.writeBits(lastProcessedInputTick[i] + 1, HEADER_LAST_INPUT_TICK_BITS)
  }
  bw.writeBits(state.entityCount, HEADER_ENTITY_COUNT_BITS)

  for (let i = 0; i < MAX_KARTS; i++) {
    const k = state.karts[i]
    bw.writeFloatQ(k.position.x, Q.position.min, Q.position.max, Q.position.bits)
    bw.writeFloatQ(k.position.y, Q.position.min, Q.position.max, Q.position.bits)
    bw.writeFloatQ(k.position.z, Q.position.min, Q.position.max, Q.position.bits)
    bw.writeFloatQ(k.velocity.x, Q.velocity.min, Q.velocity.max, Q.velocity.bits)
    bw.writeFloatQ(k.velocity.y, Q.velocity.min, Q.velocity.max, Q.velocity.bits)
    bw.writeFloatQ(k.velocity.z, Q.velocity.min, Q.velocity.max, Q.velocity.bits)
    bw.writeFloatQ(k.heading, Q.heading.min, Q.heading.max, Q.heading.bits)
    bw.writeFloatQ(k.angularVelocity, Q.angularVelocity.min, Q.angularVelocity.max, Q.angularVelocity.bits)
    bw.writeFloatQ(k.drift.charge, Q.driftCharge.min, Q.driftCharge.max, Q.driftCharge.bits)
    bw.writeFloatQ(k.lap.t, Q.t.min, Q.t.max, Q.t.bits)
    bw.writeBits(k.spinOutTicks, SPIN_OUT_TICKS_BITS)
    bw.writeBits(k.invulnTicks, INVULN_TICKS_BITS)
    bw.writeBits(k.boostTicks, BOOST_TICKS_BITS)
    bw.writeBits(k.respawnTicks, RESPAWN_TICKS_BITS)
    bw.writeBits(k.lap.lap, LAP_BITS)
    bw.writeBits(k.lap.checkpointIdx, CHECKPOINT_IDX_BITS)
    bw.writeBits(codeOf(ITEM_CODE, k.item, 'ItemKind'), ITEM_BITS)
    bw.writeBits(codeOf(SURFACE_CODE, k.surface, 'Surface'), SURFACE_BITS)
    bw.writeBits(packDrift(k.drift.active, k.drift.dir), DRIFT_PACKED_BITS)
    bw.writeBits(k.airborne ? 1 : 0, AIRBORNE_BITS)
    bw.writeBits(k.shielded ? 1 : 0, SHIELDED_BITS)
    // isBot and connected are two independent bits (contract §4, this task's
    // decision 3) -- neither is ever derived from the other.
    bw.writeBits(k.isBot ? 1 : 0, IS_BOT_BITS)
    bw.writeBits(k.connected ? 1 : 0, CONNECTED_BITS)
    bw.writeBits(k.playerId, PLAYER_ID_BITS)
  }

  for (let i = 0; i < state.entityCount; i++) {
    const e = state.entities[i]
    bw.writeBits(e.entityId, ENTITY_ID_BITS)
    bw.writeBits(codeOf(ENTITY_KIND_CODE, e.kind, 'EntityKind'), ENTITY_KIND_BITS)
    bw.writeBits(e.ownerId, ENTITY_OWNER_BITS)
    bw.writeFloatQ(e.position.x, Q.position.min, Q.position.max, Q.position.bits)
    bw.writeFloatQ(e.position.y, Q.position.min, Q.position.max, Q.position.bits)
    bw.writeFloatQ(e.position.z, Q.position.min, Q.position.max, Q.position.bits)
    bw.writeFloatQ(e.velocity.x, Q.velocity.min, Q.velocity.max, Q.velocity.bits)
    bw.writeFloatQ(e.velocity.y, Q.velocity.min, Q.velocity.max, Q.velocity.bits)
    bw.writeFloatQ(e.velocity.z, Q.velocity.min, Q.velocity.max, Q.velocity.bits)
    bw.writeFloatQ(e.heading, Q.heading.min, Q.heading.max, Q.heading.bits)
    bw.writeBits(e.ttl, ENTITY_TTL_BITS)
  }

  return bw.byteLength()
}

/**
 * Reverses encodeSnapshot into a caller-owned, reused `out`. `out.karts` (length
 * MAX_KARTS) and `out.entities` (length MAX_ENTITIES) are never resized - every
 * field of every element is overwritten in place, field by field, the same
 * "shared scratch" discipline `TrackQuery` uses in packages/sim.
 *
 * Entities from `entityCount` to MAX_ENTITIES - 1 are sentineled on every call
 * (entityId -1, matching packages/sim/src/entity.ts's own dead-slot convention
 * minus targetId, which WireEntity does not carry) - not just when `out` is fresh,
 * because `out` is reused across many decode calls and a slot that held a live
 * entity a moment ago must not keep claiming to.
 */
export function decodeSnapshot(buf: Uint8Array, out: WireSnapshot): void {
  const br = new BitReader(buf)

  out.tick = br.readBits(HEADER_TICK_BITS)
  out.eventSeq = br.readBits(HEADER_EVENT_SEQ_BITS)
  // `phase` is 2 bits and RacePhase has three values, so the fourth code is a bit
  // pattern this codec must be able to receive and can never mean anything.
  // THROWN rather than clamped, and thrown for the same reason BitReader throws
  // on a read past the end of its buffer: @tapkart/net's datagram guard turns a
  // throw from a decode call into a counted, dropped datagram that leaves every
  // byte of loop state untouched, which is how every other undecodable datagram
  // in this system is already treated. Clamping would instead manufacture an
  // authoritative fact - whether the race has started - out of two bits known to
  // be wrong, and would do it with no counter moving anywhere.
  //
  // Read into a local before it is committed to `out`, so this is a type-narrowed
  // RacePhase rather than a `RacePhase | undefined` assigned and then checked.
  const phaseCode = br.readBits(HEADER_PHASE_BITS)
  const phase = PHASES[phaseCode]
  if (phase === undefined) {
    throw new RangeError(`decodeSnapshot: phase code ${phaseCode} is not one of the ${PHASES.length} RacePhase values`)
  }
  out.phase = phase
  for (let i = 0; i < MAX_KARTS; i++) {
    // Inverse of encodeSnapshot's +1 bias: wire 0 -> -1 ("no real input yet"),
    // wire T + 1 -> real tick T.
    out.lastProcessedInputTick[i] = br.readBits(HEADER_LAST_INPUT_TICK_BITS) - 1
  }
  const entityCount = br.readBits(HEADER_ENTITY_COUNT_BITS)
  out.entityCount = entityCount

  for (let i = 0; i < MAX_KARTS; i++) {
    const k = out.karts[i]
    k.position.x = br.readFloatQ(Q.position.min, Q.position.max, Q.position.bits)
    k.position.y = br.readFloatQ(Q.position.min, Q.position.max, Q.position.bits)
    k.position.z = br.readFloatQ(Q.position.min, Q.position.max, Q.position.bits)
    k.velocity.x = br.readFloatQ(Q.velocity.min, Q.velocity.max, Q.velocity.bits)
    k.velocity.y = br.readFloatQ(Q.velocity.min, Q.velocity.max, Q.velocity.bits)
    k.velocity.z = br.readFloatQ(Q.velocity.min, Q.velocity.max, Q.velocity.bits)
    k.heading = br.readFloatQ(Q.heading.min, Q.heading.max, Q.heading.bits)
    k.angularVelocity = br.readFloatQ(Q.angularVelocity.min, Q.angularVelocity.max, Q.angularVelocity.bits)
    k.driftCharge = br.readFloatQ(Q.driftCharge.min, Q.driftCharge.max, Q.driftCharge.bits)
    k.t = br.readFloatQ(Q.t.min, Q.t.max, Q.t.bits)
    k.spinOutTicks = br.readBits(SPIN_OUT_TICKS_BITS)
    k.invulnTicks = br.readBits(INVULN_TICKS_BITS)
    k.boostTicks = br.readBits(BOOST_TICKS_BITS)
    k.respawnTicks = br.readBits(RESPAWN_TICKS_BITS)
    k.lap = br.readBits(LAP_BITS)
    k.checkpointIdx = br.readBits(CHECKPOINT_IDX_BITS)
    // `item` is 4 bits and ItemKind has NINE values, so seven of the sixteen
    // codes are bit patterns this codec must be able to receive and can never
    // mean anything - the same hole `phase` above had, seven codes wide instead
    // of one. Read into a local and rejected before it is committed to `k`, so
    // this is a type-narrowed ItemKind rather than an `ItemKind | undefined`
    // assigned and then checked. See the phase comment above for why this
    // throws rather than clamping.
    const itemCode = br.readBits(ITEM_BITS)
    const item = ITEM_KINDS[itemCode]
    if (item === undefined) {
      throw new RangeError(`decodeSnapshot: item code ${itemCode} is not one of the ${ITEM_KINDS.length} ItemKind values`)
    }
    k.item = item
    // `surface` needs no such guard and deliberately does not have one: SURFACES
    // has exactly four values and SURFACE_BITS is 2, so the enum fills its field
    // and there is no unused code for a guard to reject. A check here would be
    // dead code no datagram could reach.
    //
    // What holds that honest is `SURFACE_CODE: Record<Surface, number>` at the
    // top of this file - adding a fifth Surface to @tapkart/sim fails to COMPILE
    // there, before any test runs. This comment used to name the test that walks
    // all four codes as the thing that fails, and that was false: both this
    // file's table and the test's were hand-written `Surface[]` literals with no
    // binding to the union, so a fifth Surface left the whole suite green while
    // every kart carrying it encoded as code 3 = 'offtrack'. The test still walks
    // the code space (that is what makes "four codes, four values" a measurement)
    // and its own table is now Record-keyed too, but the compile-time check is
    // what makes the claim true.
    k.surface = SURFACES[br.readBits(SURFACE_BITS)]
    const driftRaw = br.readBits(DRIFT_PACKED_BITS)
    if (driftRaw >= DRIFT_CODES) {
      throw new RangeError(`decodeSnapshot: packed drift code ${driftRaw} is not one of the ${DRIFT_CODES} drift states`)
    }
    k.driftActive = unpackDriftActive(driftRaw)
    k.driftDir = unpackDriftDir(driftRaw)
    k.airborne = br.readBits(AIRBORNE_BITS) !== 0
    k.shielded = br.readBits(SHIELDED_BITS) !== 0
    // Two independent reads -- neither is derived from the other (decision 3).
    k.isBot = br.readBits(IS_BOT_BITS) !== 0
    k.connected = br.readBits(CONNECTED_BITS) !== 0
    k.playerId = br.readBits(PLAYER_ID_BITS)
  }

  for (let i = 0; i < entityCount; i++) {
    const e = out.entities[i]
    e.entityId = br.readBits(ENTITY_ID_BITS)
    // The widest hole in the format: 4 bits, sixteen codes, SIX EntityKind
    // values, so ten codes mean nothing. An undefined here reached the receiving
    // loop's entity pool and stayed - packages/sim's entity.ts switches on
    // `kind` to step a shell or a slick, and a slot whose kind matches no branch
    // is simply never updated while still occupying the pool.
    const entityKindCode = br.readBits(ENTITY_KIND_BITS)
    const entityKind = ENTITY_KINDS[entityKindCode]
    if (entityKind === undefined) {
      throw new RangeError(
        `decodeSnapshot: entity kind code ${entityKindCode} is not one of the ${ENTITY_KINDS.length} EntityKind values`,
      )
    }
    e.kind = entityKind
    e.ownerId = br.readBits(ENTITY_OWNER_BITS)
    e.position.x = br.readFloatQ(Q.position.min, Q.position.max, Q.position.bits)
    e.position.y = br.readFloatQ(Q.position.min, Q.position.max, Q.position.bits)
    e.position.z = br.readFloatQ(Q.position.min, Q.position.max, Q.position.bits)
    e.velocity.x = br.readFloatQ(Q.velocity.min, Q.velocity.max, Q.velocity.bits)
    e.velocity.y = br.readFloatQ(Q.velocity.min, Q.velocity.max, Q.velocity.bits)
    e.velocity.z = br.readFloatQ(Q.velocity.min, Q.velocity.max, Q.velocity.bits)
    e.heading = br.readFloatQ(Q.heading.min, Q.heading.max, Q.heading.bits)
    e.ttl = br.readBits(ENTITY_TTL_BITS)
  }
  for (let i = entityCount; i < MAX_ENTITIES; i++) {
    const e = out.entities[i]
    e.entityId = -1
    e.kind = 'seeker'
    e.ownerId = -1
    e.position.x = 0
    e.position.y = 0
    e.position.z = 0
    e.velocity.x = 0
    e.velocity.y = 0
    e.velocity.z = 0
    e.heading = 0
    e.ttl = 0
  }
}

/**
 * Writes the fields a WireSnapshot carries into `dst`, and nothing else. Does
 * NOT touch: rngCursor, nextEventSeq, nextEntityId, itemBoxes, finishedOrder,
 * finishTick, heldBotIntent, heldBotTick (none of these have wire data -
 * contract §0's "a follower's nextEventSeq is advanced only by applying received
 * events" is exactly why nextEventSeq is on this list despite snap.eventSeq
 * existing; that field is for the caller to read directly off the decoded
 * WireSnapshot, not to be replayed into SimState here), nor raceSeed
 * (WireSnapshot has no such field) nor karts[i].characterIdx (deliberately absent
 * from the wire, contract §1c/§5). DOES write dst.tick, dst.entityCount and
 * dst.phase - all three are carried on the wire and none is on the exclusion
 * list. `phase` LEFT that list in Task 15c: the wire carries it now, and a
 * follower that kept its own would go on freezing every kart through a countdown
 * the authority has already ended (packages/sim/src/phase.ts's resolveInputs
 * freezes on `phase === 'countdown'` alone). Writes k.isBot
 * and k.connected as two independent fields (decision 3) - a snapshot that
 * genuinely carries them disagreeing (bot-takeover racing a reconnect)
 * reconciles correctly.
 *
 * entities[i].targetId is a partial exception, not a blanket one: WireEntity has no
 * such field, so this function decides targetId's fate with two independent reset
 * triggers, not one:
 *   1. The wire says the slot is dead now (s.entityId === -1): always reset to -1,
 *      unconditionally on what the slot held a moment ago. entity.ts's clearSlot()
 *      always pairs entityId === -1 with targetId === -1, and this function is the
 *      only place with both the dead-slot signal and a targetId field to clear
 *      (WireEntity has none, so decodeSnapshot's own re-sentinelling cannot reach
 *      it) - so it must enforce the invariant on every call a slot is dead, not
 *      just the first one after it died.
 *   2. The wire says the slot is live now, but as a DIFFERENT entity than it held a
 *      moment ago (this call's previous dst.entities[i].entityId, captured before
 *      it is overwritten, was itself not -1 and differs from the wire's new one):
 *      reset. Despawn is a swap-remove (entity.ts's spawnEntity/clearSlot): when
 *      entity A despawns from slot i, the LAST live entity B is moved into slot i
 *      to keep live entities packed at the front, so a slot's occupant can change
 *      identity WITHOUT the wire's entityId for that slot ever passing through -1.
 *      Trigger 1 alone cannot see this - slot i decodes s.entityId = B's id (live,
 *      not -1), so without trigger 2, dst.entities[i].targetId keeps A's stale
 *      value, now silently misattributed to B.
 * targetId is left exactly as found in the two remaining transitions, where there is
 * no wire data to prefer either way: a dead slot receiving a freshly-spawned live
 * entity (nothing to misattribute; if this function has been consistently
 * maintaining trigger 1's invariant, that dead slot's targetId was already -1 going
 * in) and a live slot whose occupant's identity is unchanged from the previous call.
 * This residue with no wire representation is consumed downstream by
 * ShadowLoop.reconcile (Task 16).
 */
export function applySnapshotToState(snap: WireSnapshot, dst: SimState): void {
  dst.tick = snap.tick
  dst.entityCount = snap.entityCount
  dst.phase = snap.phase

  for (let i = 0; i < MAX_KARTS; i++) {
    const s = snap.karts[i]
    const k = dst.karts[i]
    k.playerId = s.playerId
    k.isBot = s.isBot
    k.connected = s.connected
    k.position.x = s.position.x
    k.position.y = s.position.y
    k.position.z = s.position.z
    k.velocity.x = s.velocity.x
    k.velocity.y = s.velocity.y
    k.velocity.z = s.velocity.z
    k.heading = s.heading
    k.angularVelocity = s.angularVelocity
    k.drift.active = s.driftActive
    k.drift.dir = s.driftDir
    k.drift.charge = s.driftCharge
    k.item = s.item
    k.airborne = s.airborne
    k.surface = s.surface
    k.spinOutTicks = s.spinOutTicks
    k.invulnTicks = s.invulnTicks
    k.boostTicks = s.boostTicks
    k.respawnTicks = s.respawnTicks
    k.shielded = s.shielded
    k.lap.lap = s.lap
    k.lap.checkpointIdx = s.checkpointIdx
    k.lap.t = s.t
    // k.characterIdx: deliberately untouched, see this function's docstring
  }

  for (let i = 0; i < MAX_ENTITIES; i++) {
    const s = snap.entities[i]
    const e = dst.entities[i]
    // Captured before e.entityId is overwritten below - this is the slot's
    // PREVIOUS occupant, which the targetId reset below needs for its second
    // trigger (see docstring: a live-to-different-live swap invalidates a
    // stale targetId just as death does, and neither check can be done after
    // e.entityId has already been overwritten with the wire's new value).
    const prevEntityId = e.entityId
    e.entityId = s.entityId
    e.kind = s.kind
    e.ownerId = s.ownerId
    e.position.x = s.position.x
    e.position.y = s.position.y
    e.position.z = s.position.z
    e.velocity.x = s.velocity.x
    e.velocity.y = s.velocity.y
    e.velocity.z = s.velocity.z
    e.heading = s.heading
    e.ttl = s.ttl
    // e.targetId: WireEntity carries no such field, so this is not a single
    // condition but two, and they are not the same check:
    //  1. Wire says dead (s.entityId === -1): ALWAYS reset, unconditionally on
    //     what the slot held before. entity.ts's clearSlot() always pairs
    //     entityId === -1 with targetId === -1, and this must hold even if the
    //     slot was already dead going in (a prior caller may have left an
    //     invariant-violating targetId on an already-dead slot; this function
    //     is the one place positioned to correct that on every call, not just
    //     on a live-to-dead transition).
    //  2. Wire says live, but a DIFFERENT live entity than the slot held a
    //     moment ago (prevEntityId !== -1 && prevEntityId !== s.entityId):
    //     reset. This is the swap-remove case - entity.ts's despawn moves the
    //     last live entity into the freed slot to keep live entities packed at
    //     the front, so a slot's occupant can change identity without the
    //     wire's entityId for that slot ever passing through -1. A check keyed
    //     on death alone cannot see this: it would leave entity B silently
    //     wearing entity A's stale targetId.
    // Preserved (left exactly as found) in the two remaining cases: a dead
    // slot receiving a freshly-spawned live entity (prevEntityId === -1 - there
    // is no prior occupant's target to misattribute, and no wire data to
    // prefer either way for the new one), and a live slot whose occupant's
    // identity is unchanged (prevEntityId === s.entityId - still correct, no
    // wire data either way).
    if (s.entityId === -1 || (prevEntityId !== -1 && prevEntityId !== s.entityId)) {
      e.targetId = -1
    }
  }
}
