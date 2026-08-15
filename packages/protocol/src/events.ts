import type { AuthEvent, AuthEventKind, ItemKind } from '@tapkart/sim'
import { BitReader, BitWriter } from './bits'

/**
 * Fixed wire codes, matching AuthEventKind's declaration in @tapkart/sim's
 * types.ts.
 *
 * `Record<AuthEventKind, number>` rather than an `AuthEventKind[]` literal, for
 * the reason snapshot.ts's identical tables spell out in full: an array literal
 * has NO binding to the union it claims to enumerate, so a ninth AuthEventKind
 * compiles, typechecks and encodes as code 7 = 'finish'. This literal fails to
 * compile on the day the union changes, which is the only moment the fix is
 * cheap.
 */
const KIND_CODE: Record<AuthEventKind, number> = {
  itemGrant: 0, entitySpawn: 1, entityDespawn: 2, hit: 3, spinOut: 4, respawn: 5, lapCross: 6, finish: 7,
}
/** Fixed wire codes, matching ItemKind's declaration in @tapkart/sim's types.ts.
 * EntityKind's six values are a strict subset of these nine, so entitySpawn/
 * entityDespawn/hit events (whose `item` field actually carries an
 * EntityKind) are already covered - no separate table is needed. */
const ITEM_CODE: Record<ItemKind, number> = {
  none: 0, boost: 1, seeker: 2, bolt: 3, slick: 4, bubble: 5, surge: 6, blink: 7, charge: 8,
}

/** Decode-side inverse of a code table, built once from the Record so the two
 * directions cannot disagree. Same helper snapshot.ts uses, restated here rather
 * than shared: these tables are private to each codec by design (a test that read
 * one codec's copy could not fail if that copy were reordered). */
function orderFrom<T extends string>(table: Record<T, number>): T[] {
  const order: T[] = []
  for (const key of Object.keys(table) as T[]) order[table[key]] = key
  return order
}

const KIND_ORDER: AuthEventKind[] = orderFrom(KIND_CODE)
const ITEM_ORDER: ItemKind[] = orderFrom(ITEM_CODE)

const EVENT_COUNT_BITS = 16
const EVENT_SEQ_BITS = 32
const TICK_BITS = 32
const KIND_BITS = 3
const PLAYER_ID_BITS = 4 // wire = playerId + 1, domain -1..7
const ENTITY_ID_BITS = 17 // wire = entityId + 1, domain -1..131070
const ITEM_BITS = 4
const DATA_BITS = 16

export function encodeEvents(out: Uint8Array, events: AuthEvent[]): number {
  const w = new BitWriter(out)
  w.writeBits(events.length, EVENT_COUNT_BITS)

  for (const ev of events) {
    const kindIdx: number | undefined = KIND_CODE[ev.kind]
    if (kindIdx === undefined) throw new Error(`encodeEvents: unknown AuthEventKind ${String(ev.kind)}`)
    const itemIdx: number | undefined = ITEM_CODE[ev.item]
    if (itemIdx === undefined) throw new Error(`encodeEvents: unknown ItemKind ${String(ev.item)}`)

    w.writeBits(ev.eventSeq, EVENT_SEQ_BITS)
    w.writeBits(ev.tick, TICK_BITS)
    w.writeBits(kindIdx, KIND_BITS)
    w.writeBits(ev.playerId + 1, PLAYER_ID_BITS)
    w.writeBits(ev.entityId + 1, ENTITY_ID_BITS)
    w.writeBits(itemIdx, ITEM_BITS)
    w.writeBits(ev.data, DATA_BITS)
  }

  return w.byteLength()
}

/**
 * Reverses encodeEvents into `out`.
 *
 * ALL-OR-NOTHING: `out` is not touched at all unless the whole batch decodes.
 * This is a property of the codec, not a rule its callers have to remember,
 * because the rule is not one a caller can keep: `out.length = 0` used to run
 * BEFORE the loop, so a batch that threw on event 3 left three events behind in
 * a caller-owned array, and a caller that had (reasonably) already cleared its
 * own array could not tell those three from a batch of three.
 *
 * That is ruling P2-R20's reasoning applied here rather than a documented
 * invariant: "a per-call-site length check works too but must be repeated
 * forever, and the next codec forgets." Plan 4's most likely new caller is a
 * client applying events straight into live state on the reliable channel, where
 * three half-applied events is three authoritative facts nothing will ever
 * retract.
 *
 * The cost is one temporary array per call, on a path that already allocates a
 * fresh AuthEvent per event and runs at the event rate (measured on this plan's
 * own golden fixture: 13 events in 900 ticks), not the tick rate.
 */
export function decodeEvents(buf: Uint8Array, out: AuthEvent[]): void {
  const r = new BitReader(buf)
  const count = r.readBits(EVENT_COUNT_BITS)
  // Decoded here and committed to `out` only after the loop returns - see above.
  const decoded: AuthEvent[] = []

  for (let i = 0; i < count; i++) {
    const eventSeq = r.readBits(EVENT_SEQ_BITS)
    const tick = r.readBits(TICK_BITS)
    // KIND_BITS is 3 and AuthEventKind has exactly EIGHT values, so this enum
    // fills its field and no code in it can be invalid. Deliberately unguarded
    // for that reason - a check here would be dead code no datagram could reach.
    // The `!` is gone all the same: it was a claim to the compiler that happened
    // to be true here and was false on the line below, which is what makes `!`
    // on a wire lookup unreadable as evidence either way.
    const kind = KIND_ORDER[r.readBits(KIND_BITS)]
    const playerId = r.readBits(PLAYER_ID_BITS) - 1
    const entityId = r.readBits(ENTITY_ID_BITS) - 1
    // ITEM_BITS is 4 and ItemKind has NINE values, so seven of the sixteen codes
    // are undecodable, and this copy of the hole is the worse of the two: Task
    // 13's applyEvent reads `ev.item` as the kind of ENTITY TO SPAWN on an
    // entitySpawn as well as the item to grant on an itemGrant, so an undefined
    // here is written into the receiving loop's entity pool rather than into one
    // kart's held item. Rejected, never clamped: @tapkart/net's datagram guard
    // turns the throw into a counted, dropped datagram that leaves every byte of
    // loop state untouched, while a clamp would invent an authoritative fact out
    // of four bits already known to be wrong and move no counter at all.
    const itemCode = r.readBits(ITEM_BITS)
    const item = ITEM_ORDER[itemCode]
    if (item === undefined) {
      throw new RangeError(`decodeEvents: item code ${itemCode} is not one of the ${ITEM_ORDER.length} ItemKind values`)
    }
    const data = r.readBits(DATA_BITS)
    decoded.push({ eventSeq, tick, kind, playerId, entityId, item, data })
  }

  // Commit. Reached only if every event above decoded, so a caller's array is
  // either exactly this batch or exactly what it held before the call.
  out.length = 0
  for (const ev of decoded) out.push(ev)
}
