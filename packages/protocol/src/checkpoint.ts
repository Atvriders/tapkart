import type {
  EntityKind,
  EntityState,
  Intent,
  ItemKind,
  KartState,
  RacePhase,
  SimState,
  Surface,
} from '@tapkart/sim'

/**
 * Full-precision serialization of SimState for AuthorityCheckpoint (spec
 * §5): late join, a client resynced after reconciliation diverges past
 * recovery, and shadow resync after a partition. Not sent periodically.
 *
 * Every field - including booleans and string enums - is written as a raw
 * IEEE-754 float64 (8 bytes, little-endian), in SimState's declared field
 * order. This is deliberately not bit-packed: this message carries no byte
 * budget (spec §5), and a raw float64 round trip preserves every JS safe
 * integer and the -0/+0 sign bit exactly, with no special-casing.
 */

/**
 * Wire codes, keyed by the union rather than written as an array of values.
 * `Record<Surface, number>` is a compile-time exhaustiveness check in both
 * directions - a fifth Surface, or a renamed one, fails to compile HERE, on the
 * day @tapkart/sim changes, rather than encoding as some other kart's surface
 * years later. snapshot.ts's copy of these tables carries the full argument.
 */
const PHASE_CODE: Record<RacePhase, number> = { countdown: 0, racing: 1, finished: 2 }
const SURFACE_CODE: Record<Surface, number> = { tarmac: 0, dirt: 1, boost: 2, offtrack: 3 }
const ITEM_CODE: Record<ItemKind, number> = {
  none: 0, boost: 1, seeker: 2, bolt: 3, slick: 4, bubble: 5, surge: 6, blink: 7, charge: 8,
}
const ENTITY_KIND_CODE: Record<EntityKind, number> = {
  seeker: 0, bolt: 1, slick: 2, bubble: 3, surge: 4, charge: 5,
}

/** Decode-side inverse, built once from the Record so the two directions cannot
 * disagree. Same helper as snapshot.ts's, restated rather than shared: each
 * codec owns its own tables by design. */
function orderFrom<T extends string>(table: Record<T, number>): T[] {
  const order: T[] = []
  for (const key of Object.keys(table) as T[]) order[table[key]] = key
  return order
}

const PHASE_ORDER: RacePhase[] = orderFrom(PHASE_CODE)
const SURFACE_ORDER: Surface[] = orderFrom(SURFACE_CODE)
const ITEM_ORDER: ItemKind[] = orderFrom(ITEM_CODE)
const ENTITY_KIND_ORDER: EntityKind[] = orderFrom(ENTITY_KIND_CODE)

function idx<T extends string>(table: Record<T, number | undefined>, value: T, label: string): number {
  const code = table[value]
  if (code === undefined) throw new Error(`checkpoint: unknown ${label} ${String(value)}`)
  return code
}

/**
 * `idx`'s inverse, and the decode-side half this file did not have.
 *
 * Every enum below used to be read as `ORDER[f()]!`. The `!` is a claim to the
 * COMPILER that an index is in range; it is not a check on the BYTES, and these
 * bytes arrive from a socket. Worse than the bit-packed codecs' version of the
 * same hole: `f()` returns a raw float64, so the invalid space is not seven or
 * ten bit patterns but every double that is not a valid index - 2.5, -1, NaN,
 * 1e9 - and the sixteen-code ceiling that bounds snapshot.ts's damage does not
 * exist here.
 *
 * And it matters more than the snapshot copy, not less. An AuthorityCheckpoint
 * REPLACES THE WHOLE STATE (spec §5), so a bad value is not a field that
 * self-heals on the next snapshot but the baseline every subsequent tick is
 * built on - and a checkpoint is sent at exactly the three moments something has
 * already gone wrong: late join, a client whose reconciliation has diverged past
 * recovery, and shadow resync after a partition.
 *
 * Rejected, never clamped. ShadowLoop decodes a checkpoint into a scratch
 * SimState and commits it by pointer swap only after the decode returns, so this
 * throw becomes a counted, dropped datagram through @tapkart/net's guard with
 * the loop's live state untouched. A clamp would instead write a plausible,
 * authoritative, invented world over the whole race and move no counter.
 */
function fromOrder<T>(order: readonly T[], code: number, label: string): T {
  const value = order[code]
  if (value === undefined) {
    throw new RangeError(`decodeCheckpoint: ${label} code ${code} is not one of the ${order.length} values`)
  }
  return value
}

/**
 * `drift.dir` is not a table index but a raw signed value, and it was cast
 * straight to `-1 | 0 | 1` by an `as` - which, exactly like `!`, checks nothing
 * at runtime. A checkpoint claiming dir = 4096 reached packages/sim/src/drift.ts,
 * which multiplies by it.
 */
function driftDirFrom(value: number): -1 | 0 | 1 {
  if (value !== -1 && value !== 0 && value !== 1) {
    throw new RangeError(`decodeCheckpoint: drift dir ${value} is not one of -1, 0, 1`)
  }
  return value
}

// Field counts, in float64 slots, for the shape encodeCheckpoint writes. They are
// the ONLY duplication of that function's field list, and `encodeCheckpoint`
// asserts against them on every call, so a field added to the encoder without a
// matching bump here fails immediately and loudly rather than silently
// invalidating decodeCheckpoint's length check.
const HEADER_SLOTS = 8
const KART_SLOTS = 26
const ENTITY_SLOTS = 12
const BOX_SLOTS = 2
const INTENT_SLOTS = 6
const BYTES_PER_SLOT = 8

/**
 * The exact encoded size of a checkpoint describing `state`, in bytes.
 *
 * A checkpoint's size is a PURE FUNCTION OF THE STATE'S SHAPE - kart count,
 * entity count, item-box count, and the three per-kart-count arrays - because
 * every field is one fixed-width float64 and nothing is variable-length. That is
 * what makes decodeCheckpoint's up-front length check possible at all.
 */
function checkpointByteLength(state: SimState): number {
  const slots =
    HEADER_SLOTS +
    state.karts.length * KART_SLOTS +
    state.entities.length * ENTITY_SLOTS +
    1 + state.itemBoxes.length * BOX_SLOTS +
    state.finishedOrder.length +
    state.heldBotIntent.length * INTENT_SLOTS +
    state.heldBotTick.length
  return slots * BYTES_PER_SLOT
}

export function encodeCheckpoint(out: Uint8Array, state: SimState): number {
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength)
  let o = 0

  const f = (value: number): void => {
    dv.setFloat64(o, value, true)
    o += 8
  }
  const bit = (value: boolean): void => f(value ? 1 : 0)

  f(state.tick)
  f(idx(PHASE_CODE, state.phase, 'RacePhase'))
  f(state.raceSeed)
  f(state.rngCursor)
  f(state.nextEventSeq)
  f(state.finishTick)
  f(state.entityCount)
  f(state.nextEntityId)

  for (const k of state.karts) {
    f(k.playerId)
    f(k.characterIdx)
    bit(k.isBot)
    bit(k.connected)
    f(k.position.x); f(k.position.y); f(k.position.z)
    f(k.velocity.x); f(k.velocity.y); f(k.velocity.z)
    f(k.heading)
    f(k.angularVelocity)
    bit(k.drift.active)
    f(k.drift.dir)
    f(k.drift.charge)
    f(idx(ITEM_CODE, k.item, 'ItemKind'))
    bit(k.airborne)
    f(idx(SURFACE_CODE, k.surface, 'Surface'))
    f(k.spinOutTicks)
    f(k.invulnTicks)
    f(k.boostTicks)
    f(k.respawnTicks)
    bit(k.shielded)
    f(k.lap.lap)
    f(k.lap.checkpointIdx)
    f(k.lap.t)
  }

  for (const e of state.entities) {
    f(e.entityId)
    f(idx(ENTITY_KIND_CODE, e.kind, 'EntityKind'))
    f(e.ownerId)
    f(e.position.x); f(e.position.y); f(e.position.z)
    f(e.velocity.x); f(e.velocity.y); f(e.velocity.z)
    f(e.heading)
    f(e.targetId)
    f(e.ttl)
  }

  f(state.itemBoxes.length)
  for (const box of state.itemBoxes) {
    f(box.boxIdx)
    f(box.respawnTicks)
  }

  for (const v of state.finishedOrder) f(v)

  for (const iv of state.heldBotIntent) {
    f(iv.tick)
    f(iv.steer)
    f(iv.accel)
    bit(iv.brake)
    bit(iv.drift)
    bit(iv.useItem)
  }

  for (const v of state.heldBotTick) f(v)

  // The size table above IS decodeCheckpoint's guard, so it is checked against
  // the encoder that defines it, on every call, rather than being a comment.
  if (o !== checkpointByteLength(state)) {
    throw new Error(
      `encodeCheckpoint: wrote ${o} bytes but checkpointByteLength says ${checkpointByteLength(state)}; ` +
      'a field was added to this encoder without updating the slot counts above',
    )
  }

  return o
}

/**
 * Reverses encodeCheckpoint into a caller-owned, preallocated `dst`.
 *
 * `buf` MUST be exactly the frame `encodeCheckpoint` produced for a state of
 * `dst`'s shape - checked on the first line, before a single byte of `dst` is
 * written. That check is this codec's half of the invariant, not the caller's,
 * and it is here rather than documented for ruling P2-R20's reason: "a per-call-
 * site length check works too but must be repeated forever, and the next codec
 * forgets."
 *
 * `dst` IS STILL PARTIALLY WRITTEN if the buffer is the right length but carries
 * an invalid enum code (fromOrder / driftDirFrom throw part-way through), and
 * that is deliberate: not corrupting `dst` at all would need a second full
 * SimState of scratch for every decode, which is what ShadowLoop's ping-ponged
 * checkpoint buffers already provide at the one call site that has live state to
 * protect. What the length check removes is the case that was actually
 * REACHABLE - a truncated datagram off a socket, which used to run
 * `DataView.getFloat64` off the end after overwriting the whole header and
 * however many karts fit, and which measurably landed a shadow on tick 9001.
 *
 * It also subsumes the itemBoxes count check further down, which cannot fire
 * until everything ahead of it has already been overwritten; that check is kept
 * as a backstop for the one shape mismatch a byte count cannot see (two arrays
 * differing in opposite directions by compensating amounts).
 */
export function decodeCheckpoint(buf: Uint8Array, dst: SimState): void {
  const expected = checkpointByteLength(dst)
  if (buf.byteLength !== expected) {
    throw new RangeError(
      `decodeCheckpoint: buffer is ${buf.byteLength} bytes, but a checkpoint for this dst ` +
      `(${dst.karts.length} karts, ${dst.entities.length} entities, ${dst.itemBoxes.length} itemBoxes) ` +
      `is exactly ${expected}`,
    )
  }

  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  let o = 0

  const f = (): number => {
    const v = dv.getFloat64(o, true)
    o += 8
    return v
  }
  const bit = (): boolean => f() !== 0

  dst.tick = f()
  dst.phase = fromOrder(PHASE_ORDER, f(), 'RacePhase')
  dst.raceSeed = f()
  dst.rngCursor = f()
  dst.nextEventSeq = f()
  dst.finishTick = f()
  dst.entityCount = f()
  dst.nextEntityId = f()

  for (const k of dst.karts as KartState[]) {
    k.playerId = f()
    k.characterIdx = f()
    k.isBot = bit()
    k.connected = bit()
    k.position.x = f(); k.position.y = f(); k.position.z = f()
    k.velocity.x = f(); k.velocity.y = f(); k.velocity.z = f()
    k.heading = f()
    k.angularVelocity = f()
    k.drift.active = bit()
    k.drift.dir = driftDirFrom(f())
    k.drift.charge = f()
    k.item = fromOrder(ITEM_ORDER, f(), 'ItemKind')
    k.airborne = bit()
    k.surface = fromOrder(SURFACE_ORDER, f(), 'Surface')
    k.spinOutTicks = f()
    k.invulnTicks = f()
    k.boostTicks = f()
    k.respawnTicks = f()
    k.shielded = bit()
    k.lap.lap = f()
    k.lap.checkpointIdx = f()
    k.lap.t = f()
  }

  for (const e of dst.entities as EntityState[]) {
    e.entityId = f()
    e.kind = fromOrder(ENTITY_KIND_ORDER, f(), 'EntityKind')
    e.ownerId = f()
    e.position.x = f(); e.position.y = f(); e.position.z = f()
    e.velocity.x = f(); e.velocity.y = f(); e.velocity.z = f()
    e.heading = f()
    e.targetId = f()
    e.ttl = f()
  }

  const boxCount = f()
  if (boxCount !== dst.itemBoxes.length) {
    throw new Error(
      `decodeCheckpoint: buffer has ${boxCount} itemBoxes but dst was preallocated with ${dst.itemBoxes.length}`,
    )
  }
  for (const box of dst.itemBoxes) {
    box.boxIdx = f()
    box.respawnTicks = f()
  }

  for (let i = 0; i < dst.finishedOrder.length; i++) dst.finishedOrder[i] = f()

  for (const iv of dst.heldBotIntent as Intent[]) {
    iv.tick = f()
    iv.steer = f()
    iv.accel = f()
    iv.brake = bit()
    iv.drift = bit()
    iv.useItem = bit()
  }

  for (let i = 0; i < dst.heldBotTick.length; i++) dst.heldBotTick[i] = f()
}
