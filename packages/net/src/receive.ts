import type { ChannelName, MessageKind } from '@tapkart/protocol'
import { decodeHeader } from '@tapkart/protocol'
import { MAX_ENTITIES, MAX_KARTS } from '@tapkart/sim'
import { TICK_MS } from './clock'

/** encodeHeader writes tag + protocolVersion and returns 2 (locked contract §3). */
const HEADER_BYTES = 2

// ---- wire cursors ------------------------------------------------------
//
// THE SECOND HALF OF THE ENUM-HOLE DEFECT CLASS, and the worse half.
//
// Every loop in this package holds MONOTONIC CURSORS taken straight off the
// wire: `highestSeenSnapshotTick`, `lastSnapshotTick`, `heldIntentTick[seat]`,
// `heldInputTick[seat]`, `eventSeqFloor`, and `SimState.nextEventSeq` (which
// applyEvent advances from `ev.eventSeq`). Each one exists to reject STALE
// traffic - "newer than what I have already applied" is the whole ordering
// discipline of an unreliable channel - and each one is a 32-bit field a
// corrupted or hostile sender fills in for free.
//
// The enum holes were per-datagram and self-healing: one bad frame, one bad
// field, gone by the next snapshot. A poisoned cursor is PERMANENT and has no
// repair path anywhere in this design. Measured, before this guard existed:
//
//   - one `events` datagram with eventSeq = 2**32-1 left ClientLoop's
//     nextEventSeq at 4294967296, dropped = 0, and EVERY subsequent legitimate
//     event discarded forever (a following lapCross left `lap` at 0)
//   - one `snapshot` with tick = 2**32-1 pinned highestSeenSnapshotTick; 60
//     later legitimate snapshots produced 0 corrections and 0 interpolator
//     keyframes - a guest frozen with a dead render feed
//   - one `input` with baseTick ~ 2**32 pinned AuthorityLoop's
//     heldIntentTick[seat]; the seat drove the poisoned intent forever
//
// REJECTED, NOT CLAMPED, for exactly the reason the enum codes are rejected: a
// clamped cursor is still a wrong authoritative fact, arrived at from bits
// already known to be wrong, with no counter moving anywhere.
//
// ---- what the bounds are anchored on
//
// Each cursor is bounded against THE RECEIVER'S CURRENT CURSOR OF THE SAME KIND,
// because that is the only quantity that tracks what the SENDER is doing.
//
// The receiving loop's own tick counter looks like a tempting anchor - it
// advances on its own, so a rejection could never be permanent - and it is
// wrong, for the reason shadow.ts's HOST_TIMEOUT_MS comment already gives about
// a different timer: "a tick counter is the one clock that stops in the
// conditions this timer exists to detect." Measured while it was wired that way:
// an AuthorityLoop that stops being ticked (the promotion test kills its host by
// simply never calling tick() again) freezes its own counter while its clients
// keep sending, and counted 181 perfectly good input datagrams as drops.
// clock.ts's MAX_CATCHUP_TICKS makes the same thing true of a merely SLOW peer:
// a stalled loop discards the wall time it could not run, so its tick number
// falls permanently behind the authority's and never catches up.
//
// The cost of the cursor anchor is the one ruled acceptable when this guard was
// specified: a peer that has been silent long enough to exceed the bound is
// refused rather than fast-forwarded, and what it needs is a checkpoint (which
// rebases the whole timeline) rather than a cursor jump. Plan 4 owns that path;
// today a peer that far out stays refused, which is a visible, counted failure
// instead of a silent wrong-but-authoritative one.
//
// The two INPUT cursors take `max(seat cursor, this loop's own tick)` as their
// anchor rather than the seat cursor alone. An authority is by definition
// running and authoritative about "now", so a client's intent tick has no
// business leading it; that closes the one window a bare cursor leaves open,
// which is a seat's FIRST datagram (cursor still -1, nothing to compare
// against). The snapshot cursors get no such fallback, because a follower's own
// tick is exactly the number the authority is entitled to overrule.

/**
 * The longest silence this system still treats as a live peer: spec §5's "1.5 s
 * with no snapshot (30 missed at 20 Hz)", the same number `HOST_TIMEOUT_MS`
 * carries in shadow.ts. Restated here rather than imported for the reason
 * authority.ts and shadow.ts each restate SNAPSHOT_PERIOD_TICKS - and because
 * shadow.ts imports THIS module, so the import would be a cycle. shadow.test.ts
 * pins the two equal.
 */
const CURSOR_SILENCE_BUDGET_MS = 1500

/**
 * One worst-case one-way transit under this plan's default lossy profile: 150 ms
 * latency + 50 ms jitter. The same 200 ms `SHADOW_HISTORY_TICKS` is derived
 * from. A datagram may have been in flight this long while its sender's own
 * cursor kept advancing, so it is added to the silence budget rather than
 * assumed away.
 */
const WORST_CASE_TRANSIT_MS = 200

/**
 * How far ahead of the receiver's current cursor a wire tick may jump.
 *
 * DERIVED, not rounded: the silence budget plus ONE WORST-CASE TRANSIT FOR EACH
 * OF THE TWO FLIGHTS THE JUMP SPANS - the datagram that set the cursor, and the
 * datagram now being judged, each of which may have been up to 200 ms old on
 * arrival while its sender kept advancing. ceil(1500 / TICK_MS) + 2 * ceil(200 /
 * TICK_MS) = 90 + 24 = 114 ticks at 60 Hz.
 *
 * Against the rates the protocol actually runs at, 114 ticks is 38 consecutive
 * lost snapshots (20 Hz, 3 ticks apart) or 57 consecutive lost input datagrams
 * (30 Hz, 2 ticks apart).
 *
 * The largest jump this system LEGITIMATELY produces is the promotion handover,
 * and it is what the two-transit term is for: a client's snapshot cursor is set
 * by the host's last snapshot, the host dies, HOST_TIMEOUT_MS of wall time
 * passes while the shadow keeps stepping, and the shadow's first broadcast
 * carries a tick roughly 90 + one snapshot period + the skew between when the
 * two receivers last heard from the host. Measured on the three-party promotion
 * fixture that is ~93-105 ticks, which a one-transit bound of 102 would have sat
 * inside by single digits.
 */
export const MAX_CURSOR_ADVANCE_TICKS = Math.ceil(CURSOR_SILENCE_BUDGET_MS / TICK_MS) + 2 * Math.ceil(WORST_CASE_TRANSIT_MS / TICK_MS)

/**
 * The largest tick this protocol can coherently describe.
 *
 * Every WireSnapshot carries `lastProcessedInputTick` per seat in a SIXTEEN-BIT
 * field, biased by +1 (snapshot.ts's HEADER_LAST_INPUT_TICK_BITS), so the
 * largest real input tick the format can express is 2**16 - 2 = 65534 - about
 * 18 minutes at 60 Hz, comfortably past any three-lap race. A snapshot claiming
 * a `tick` beyond that describes a race whose own input cursor its own header
 * cannot represent, so it is not merely implausible, it is unrepresentable.
 *
 * This is the bound that covers the one window the relative bound cannot: a
 * receiver whose cursor has never been set has nothing to measure against.
 * ShadowLoop's late join is exactly that - it hard-snaps onto the first snapshot
 * it cannot rewind to, hundreds of ticks ahead of its own counter, and that is a
 * designed path with a test (packages/net/test/latejoin.test.ts). So is
 * ClientLoop's hardResync onto a snapshot outside its 128-tick ring.
 *
 * A hostile FIRST snapshot inside this ceiling therefore still strands a fresh
 * receiver, and no receiver can tell it from a legitimate late join: the first
 * authoritative fact you are ever told cannot be checked against anything you
 * hold. Plan 4's authenticated sender is what closes that; this task records it
 * rather than pretending the bound covers it.
 */
export const MAX_WIRE_TICK = 2 ** 16 - 2

/**
 * A ceiling on authoritative events emitted in one tick: one event of each of
 * the 8 AuthEventKinds for each of the MAX_KARTS + MAX_ENTITIES possible
 * subjects. Generous by construction - the sim's 11 emit sites cannot name one
 * subject with the same kind twice in a tick - and it is a PLAUSIBILITY ceiling,
 * not a proof: for scale, this plan's own 900-tick control leader emits 13
 * events in total, at most 2 in any one tick.
 */
const MAX_EVENTS_PER_TICK = (MAX_KARTS + MAX_ENTITIES) * 8

/**
 * How far ahead of the receiver's applied event counter a wire eventSeq may be:
 * the tick budget's worth of ticks, each emitting the per-tick ceiling. 114 *
 * 320 = 36480, which is five orders of magnitude below the 4294967295 that
 * wedges the counter and three above anything this simulation produces.
 *
 * The number is stated here for a reader and DERIVED by the expression below;
 * cursors.test.ts asserts the derivation, not the literal, which is why an
 * earlier draft of this comment could carry the abandoned one-transit figure
 * (102 * 320 = 32640) while every test stayed green.
 */
export const MAX_CURSOR_ADVANCE_EVENTS = MAX_CURSOR_ADVANCE_TICKS * MAX_EVENTS_PER_TICK

/**
 * True when `wireTick` is a tick this receiver could plausibly be told about.
 *
 * `anchorTick` is the receiver's current cursor of the same kind (input cursors
 * pass `max(cursor, own tick)` - see the note above). A negative anchor means
 * the cursor has never been set, which relaxes the relative bound (there is
 * nothing to be ahead OF) while keeping the absolute one - see MAX_WIRE_TICK.
 */
export function tickCursorPlausible(wireTick: number, anchorTick: number): boolean {
  if (!Number.isInteger(wireTick) || wireTick < 0 || wireTick > MAX_WIRE_TICK) return false
  if (anchorTick < 0) return true
  return wireTick <= anchorTick + MAX_CURSOR_ADVANCE_TICKS
}

/** True when `wireSeq` is an event sequence number this receiver could
 * plausibly be handed, given the highest it has already accounted for. */
export function eventCursorPlausible(wireSeq: number, anchorSeq: number): boolean {
  if (!Number.isInteger(wireSeq) || wireSeq < 0) return false
  return wireSeq <= anchorSeq + MAX_CURSOR_ADVANCE_EVENTS
}

/**
 * The one rule every receive path in this package follows: A DATAGRAM THAT
 * CANNOT BE DECODED IS A DATAGRAM THAT NEVER ARRIVED. Drop it, leave every byte
 * of loop state untouched, count it, keep running.
 *
 * Under LoopbackTransport nothing malformed can arrive - both ends are this
 * build, speaking PROTOCOL_VERSION 1 - so this is invisible in this plan's own
 * tests and load-bearing the moment a real WebSocket or WebRTC transport is
 * wired underneath. Every one of the three loops used to call `decodeHeader`
 * directly inside its `Transport.onMessage` callback, and decodeHeader throws on
 * an unknown tag, on a version mismatch AND on a datagram too short to hold a
 * header at all (`buf[0]` of an empty array is `undefined`, which is in no tag
 * table). On a server that throw escapes the socket library's message handler as
 * an uncaught exception and takes the PROCESS down, killing every room in it -
 * reachable by any guest sending one byte, and reachable without any guest at
 * all after a deploy that leaves an old client speaking an older protocol
 * version.
 *
 * The guard is scoped to DECODE CALLS ONLY (Task 15c item G), not to the handler
 * body that runs afterwards. Two decode sites exist and both are covered:
 * `decodeHeader` inside `wrap`, and each loop's own body decode through
 * `decode()` below - a body decode is exactly where a truncated frame throws
 * (BitReader rejects a read past the end of its buffer - without that it would
 * decode a half-frame into a silent all-zeros world instead).
 *
 * Task 15b's version wrapped the whole handler, which meant an exception from a
 * GENUINE BUG in a handler was caught and tallied as a drop. That is a real cost
 * and not a theoretical one: both loops now expose drop counters, and a reader
 * looking at a nonzero counter concludes "packet loss" - the one diagnosis that
 * leads nowhere when the truth is a null dereference on line 3 of a handler. A
 * guard that silently eats defects is worse than no guard for everything except
 * the case it was actually built for.
 *
 * The two rules a handler must keep for "leave every byte untouched" to be true,
 * both already satisfied by all three loops:
 *   - decode into a scratch buffer, then commit; never commit a pointer to the
 *     buffer you are about to decode into (see ShadowLoop's ping-ponged snapshot
 *     and checkpoint buffers, and ClientLoop's snapshot pair)
 *   - apply nothing until the decode call has returned
 */
export interface DatagramGuard {
  /**
   * Wraps a decode-and-apply handler into the callback shape
   * `Transport.onMessage` takes. Called once per loop, at construction: the
   * returned closure is allocated once, not per datagram.
   *
   * Only the header parse is guarded here. `handle` runs OUTSIDE the try, so
   * anything it throws that is not a guarded decode reaches the caller.
   */
  wrap(
    handle: (peerId: string, channel: ChannelName, kind: MessageKind, payload: Uint8Array) => void,
  ): (peerId: string, channel: ChannelName, data: Uint8Array) => void
  /**
   * Runs ONE body-decode call under the drop counter. Returns true if it
   * returned normally, false if it threw - in which case the datagram has been
   * counted and the caller must return without applying anything.
   *
   * Takes the decode function and its two arguments rather than a closure so
   * that nothing allocates per datagram: `guard.decode(decodeInput, payload,
   * this.scratch)` passes three existing references. Every codec in
   * @tapkart/protocol that a loop calls from a message handler has this exact
   * `(buf, out) => void` shape, which is what makes one helper enough.
   */
  decode<T>(decode: (buf: Uint8Array, out: T) => void, buf: Uint8Array, out: T): boolean
  /**
   * Counts one datagram the caller is dropping for a reason no decode can see.
   *
   * A decode either returns or throws, and both answers are about the BYTES. An
   * implausible wire cursor (see tickCursorPlausible / eventCursorPlausible
   * above) decodes perfectly - it is a well-formed u32 - and is rejected on what
   * the RECEIVER knows, which only the loop holding that state can judge. Routed
   * through the same counter all the same, because a reader looking at
   * `droppedDatagramsOf` wants "datagrams this loop refused", not "datagrams
   * whose bytes were malformed": a cursor rejection that moved no counter is
   * exactly the silent failure this whole module exists to remove.
   */
  reject(): void
  /** Datagrams dropped since construction. */
  dropped(): number
}

const guards = new WeakMap<object, DatagramGuard>()

/**
 * Creates a guard and registers it against `owner` so `droppedDatagramsOf` can
 * find it. A free function plus a WeakMap for the same reason
 * `remoteInterpolatorOf` is one: contract §5 fixes the public shape of all three
 * loops exactly, and a diagnostic counter is not worth widening it.
 */
export function createDatagramGuard(owner: object): DatagramGuard {
  let dropped = 0
  const guard: DatagramGuard = {
    wrap(handle) {
      return (peerId, channel, data): void => {
        let kind: MessageKind
        try {
          if (data.length < HEADER_BYTES) {
            throw new RangeError(`datagram of ${data.length} bytes cannot hold the ${HEADER_BYTES}-byte header`)
          }
          // Inside the try, and the ONLY thing inside it: decodeHeader is itself
          // one of the throwing calls this exists for (short buffer, unknown
          // tag, version mismatch).
          kind = decodeHeader(data).kind
        } catch {
          dropped++
          return
        }
        // Outside the try, deliberately (item G). A handler's body decodes
        // through `decode` below, which is guarded; anything else it throws is a
        // bug and must be seen as one.
        handle(peerId, channel, kind, data.subarray(HEADER_BYTES))
      }
    },
    decode(decodeFn, buf, out) {
      try {
        decodeFn(buf, out)
      } catch {
        dropped++
        return false
      }
      return true
    },
    reject(): void {
      dropped++
    },
    dropped(): number {
      return dropped
    },
  }
  guards.set(owner, guard)
  return guard
}

/**
 * How many datagrams `loop` has dropped as undecodable. Throws if `loop` never
 * registered a guard, rather than returning 0 - a silent 0 for "this object has
 * no counter" is indistinguishable from "nothing has been dropped", which is the
 * exact confusion this counter exists to prevent.
 */
export function droppedDatagramsOf(loop: object): number {
  const g = guards.get(loop)
  if (!g) throw new Error('droppedDatagramsOf: not a loop with a registered datagram guard')
  return g.dropped()
}
