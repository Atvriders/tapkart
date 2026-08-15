// The server's per-room shadow simulation. See docs/superpowers/specs/2026-08-13-tapkart-design.md
// §5 "The server is a shadow authority" and the locked Plan 2 contract §§5-6.
import type { AuthEvent, Intent, SimContext, SimState } from '@tapkart/sim'
import { MAX_ENTITIES, MAX_KARTS, allocStateLike, cloneState, makeIntentBuffer, promotionCursor, step, wrapAngle } from '@tapkart/sim'

import type { Transport } from './transport'
import type { DatagramGuard } from './receive'
import { applyEvent } from './apply'
import { createDatagramGuard, eventCursorPlausible, tickCursorPlausible } from './receive'

// The bare specifier, always — contract §3: "net imports @tapkart/protocol,
// always." The barrel exists from Task 3 and every codec task widens it; a
// relative path into ../../protocol/src/* bypasses the package's exports map
// and would survive into Plan 3.
import type { ChannelName, InputDatagram, MessageKind, WireSnapshot } from '@tapkart/protocol'
import {
  EPS,
  INPUT_REDUNDANCY,
  applySnapshotToState,
  decodeCheckpoint,
  decodeEvents,
  decodeHeader,
  decodeInput,
  decodeSnapshot,
  encodeEvents,
  encodeHeader,
  encodeSnapshot,
} from '@tapkart/protocol'

/**
 * Host loss is declared after this many MILLISECONDS with no snapshot: spec §5's
 * "1.5 s with no snapshot (30 missed at 20 Hz)", read literally.
 *
 * It was 90 TICKS (Task 15c item C changed it), and a tick counter is the one
 * clock that stops in the conditions this timer exists to detect. The room's
 * ticker runs zero ticks while its host process is descheduled, and clamps at
 * MAX_CATCHUP_TICKS (clock.ts) coming out of any stall - so a tick-counting
 * detector UNDER-COUNTS precisely when the host is failing, and promotes late or
 * not at all. A five-second freeze that produced five catch-up ticks used to
 * read as five ticks of silence.
 *
 * The wall clock is passed in to tick() rather than read here: contract §0's
 * "no wall clock outside transports and loop schedulers", and the same shape
 * LoopbackTransport.pump(nowMs) already uses. This also settles a duplicate
 * detector: Plan 4 was about to add a second, wall-clock host-loss check in the
 * server. There is ONE detector, and it lives in the loop whose promote path is
 * already tested.
 */
export const HOST_TIMEOUT_MS = 1500

/** WireSnapshot broadcast cadence once promoted: 20Hz, i.e. every 3rd tick of a 60Hz sim. */
export const SNAPSHOT_PERIOD_TICKS = 3

/**
 * Depth of the correction ring buffer, in ticks. Sized so a snapshot's reference tick never falls
 * outside the window under the default LoopbackOptions (150ms latency + 50ms jitter = 200ms
 * worst-case one-way transit = 12 ticks @ 60Hz): 24 ticks (400ms) gives 2x headroom.
 */
export const SHADOW_HISTORY_TICKS = 24

/**
 * Worst-case snapshot, from contract §4's bit counts rather than a rounded byte figure:
 * 8 karts x 178 bits = 1424, plus 32 entities x 135 bits = 4320, plus a 202-bit header = 5946 bits
 * = 744 B (the header gained 2 bits of phase in Task 15c), and 746 B once this file's 2-byte
 * message header is on the front. 1024 leaves headroom.
 * An earlier draft used `1 + 640`, citing a "worst-case 625B" that came from a superseded
 * 177-bit kart record with a packed entity velocity — and BitWriter overflows SILENTLY (a
 * typed-array write past the end is a no-op), so that buffer would have truncated every snapshot
 * with 26 or more live entities without raising anything.
 */
const SNAPSHOT_BUF_BYTES = 1024

/** Generous: §4 fixes no per-event byte size, and events are broadcast the tick they occur. */
const EVENTS_BUF_BYTES = 4096

/**
 * Width of the shared message header (tag + protocol version) that every datagram in this system
 * begins with. `encodeHeader` writes it and returns this number; contract §3 fixes it at 2 but
 * exports no constant, so this file declares one privately rather than sprinkling a literal `2`
 * through every `subarray` call. authority.ts and client.ts each do the same.
 */
const HEADER_BYTES = 2

/** 2-byte shared header + tick u32LE + eventSeq u32LE. */
export const AUTHORITY_CHANGE_BYTES = HEADER_BYTES + 8

export function encodeAuthorityChange(out: Uint8Array, tick: number, eventSeq: number): number {
  if (out.length < AUTHORITY_CHANGE_BYTES) {
    throw new Error(`encodeAuthorityChange: out is ${out.length} bytes, need ${AUTHORITY_CHANGE_BYTES}`)
  }
  const h = encodeHeader(out, 'authorityChange')
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength)
  dv.setUint32(h, tick >>> 0, true)
  dv.setUint32(h + 4, eventSeq >>> 0, true)
  return AUTHORITY_CHANGE_BYTES
}

/**
 * Validates the header it skips rather than assuming it. Reading the two u32s at
 * a fixed offset is only meaningful if the bytes in front of them really are an
 * authorityChange header: a datagram of some other kind, or from a peer speaking
 * another protocol version, would otherwise decode into two plausible-looking
 * numbers and silently re-seat an entire room's authority. decodeHeader throws
 * on an unknown tag or a version mismatch; the length check comes first so a
 * short buffer fails here rather than inside DataView.
 */
export function decodeAuthorityChange(buf: Uint8Array): { tick: number; eventSeq: number } {
  if (buf.length < AUTHORITY_CHANGE_BYTES) {
    throw new RangeError(`decodeAuthorityChange: buf is ${buf.length} bytes, need ${AUTHORITY_CHANGE_BYTES}`)
  }
  const header = decodeHeader(buf)
  if (header.kind !== 'authorityChange') {
    throw new Error(`decodeAuthorityChange: message kind is '${header.kind}', not 'authorityChange'`)
  }
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  return { tick: dv.getUint32(HEADER_BYTES, true), eventSeq: dv.getUint32(HEADER_BYTES + 4, true) }
}

interface ShadowHistoryEntry {
  tick: number
  readonly state: SimState
  readonly inputs: Intent[]
  /** Reused, never reassigned: a fresh array per tick would allocate in the hot path. */
  readonly eventsApplied: AuthEvent[]
}

function freshWireSnapshot(): WireSnapshot {
  const karts = []
  for (let i = 0; i < MAX_KARTS; i++) {
    karts.push({
      playerId: 0, position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, heading: 0,
      angularVelocity: 0, driftCharge: 0, driftActive: false, driftDir: 0 as -1 | 0 | 1,
      airborne: false, surface: 'tarmac' as const, spinOutTicks: 0, invulnTicks: 0, item: 'none' as const,
      lap: 0, checkpointIdx: 0, t: 0, isBot: false, connected: false,
      boostTicks: 0, respawnTicks: 0, shielded: false,
    })
  }
  const entities = []
  for (let i = 0; i < MAX_ENTITIES; i++) {
    entities.push({
      entityId: -1, kind: 'seeker' as const, ownerId: -1, position: { x: 0, y: 0, z: 0 },
      velocity: { x: 0, y: 0, z: 0 }, heading: 0, ttl: 0,
    })
  }
  return { tick: 0, eventSeq: 0, phase: 'countdown', lastProcessedInputTick: new Array(MAX_KARTS).fill(-1), karts, entities, entityCount: 0 }
}

/** decodeInput allocates nothing: its target must already hold INPUT_REDUNDANCY intents. */
function freshInputDatagram(): InputDatagram {
  const intents: Intent[] = []
  for (let i = 0; i < INPUT_REDUNDANCY; i++) {
    intents.push({ tick: 0, steer: 0, accel: 0, brake: false, drift: false, useItem: false })
  }
  return { playerId: -1, intents }
}

/**
 * The server's per-room simulation. Runs `step()` in lockstep with the host from tick 0 as a
 * FOLLOWER — applying every client's input and the host's authoritative events, never rolling
 * items and never originating events — and switches to LEADER on host loss with no rewind,
 * because the state it needs already exists.
 *
 * Contract §5 gives this class three members and, unlike `AuthorityLoop` and `ClientLoop`, no
 * `state()` accessor: the `state` handed to the constructor IS the accessor. Every `tick()` call
 * ends by copying `live` into it, and `promote()` — the only mutation this loop makes outside
 * `tick()` — republishes before returning.
 */
export class ShadowLoop {
  private readonly ctx: SimContext
  private readonly publish: SimState
  private live: SimState
  private scratch: SimState
  /** Two dedicated rewind buffers. `step` swaps its prev/next every replay iteration, so a replay
   * that used a history entry as one of them would, from its second iteration onward, write a
   * later tick's state into the slot still labelled with the snapshot's tick. */
  private readonly replayA: SimState
  private readonly replayB: SimState
  private readonly heldInput: Intent[]
  private readonly heldInputTick: number[]
  private readonly lastProcessedInputTick: number[]
  private readonly pendingEvents: AuthEvent[]
  /** decodeEvents clears and repopulates its out-array with freshly allocated AuthEvents, so one
   * reusable array here costs nothing and saves an allocation per datagram. */
  private readonly decodedEvents: AuthEvent[]
  /**
   * TWO preallocated snapshot buffers, ping-ponged, and a `pendingSnapshot` that
   * points at whichever one holds an ACCEPTED frame.
   *
   * One buffer is a live bug, not a style preference. With a single scratch,
   * `pendingSnapshot` aliases the decode target: onMessage decodes first and
   * tests `tick > lastSnapshotTick` second, so a frame the guard REJECTS has
   * already overwritten the frame the guard accepted a moment earlier, and
   * tick() then reconciles against the rejected one. Two snapshots landing in
   * one inter-tick window is the ordinary case at a 3-tick broadcast cadence
   * with 50ms of jitter - measured, a tick-20 frame followed by a tick-15 frame
   * left the kart 5m the wrong way. The same aliasing is what makes a datagram
   * that throws MID-decode dangerous: it half-overwrites the target, and a
   * pending pointer into that target would be pointing at wreckage. Committing
   * the pointer only after the decode returns closes both.
   *
   * A reference swap, never a copy: both buffers are allocated once here.
   */
  private pendingSnapshot: WireSnapshot | null
  private readonly snapshotBufA: WireSnapshot
  private readonly snapshotBufB: WireSnapshot
  private snapshotDecodeTarget: WireSnapshot
  /** Newest snapshot tick already reconciled. Unreliable delivery reorders under jitter, and a
   * stale snapshot re-applied after a newer one would throw away the better correction. */
  private lastSnapshotTick: number
  private readonly inputScratch: InputDatagram
  /**
   * Decoded in onMessage, applied at the top of the next tick(): a checkpoint
   * is the one message that replaces this loop's whole state (spec §5, "shadow
   * resync after a network partition").
   *
   * Split into two buffers plus a pointer for exactly the reason the snapshot
   * pair is, and with a strictly worse blast radius: a checkpoint replaces the
   * WHOLE state. As a single scratch plus a `pendingCheckpoint` boolean, a good
   * checkpoint followed by a truncated one in the same window left the boolean
   * set and the buffer wrecked - measured, that landed `live` on tick 9001, a
   * tick the host never reached, with a kart 80m from where either checkpoint
   * put it. decodeCheckpoint throws from DataView.getFloat64 rather than from
   * BitReader, so that path needs no other defect to be reachable.
   */
  private readonly checkpointBufA: SimState
  private readonly checkpointBufB: SimState
  private checkpointDecodeTarget: SimState
  private pendingCheckpoint: SimState | null
  private readonly snapshotBuf: Uint8Array
  private readonly eventsBuf: Uint8Array
  private readonly freshEvents: AuthEvent[]
  /** step()'s out-array during a rewind-replay. Separate from `freshEvents` so a replay can never
   * consume or discard the live tick's emissions, whatever order a future edit puts them in. */
  private readonly replayEvents: AuthEvent[]
  private readonly history: ShadowHistoryEntry[]
  /**
   * Wall-clock time of the most recent tick() that ran with a snapshot in hand,
   * on the timebase the scheduler passes to tick(). -1 until the first tick(),
   * which seeds it: this loop is constructed without a clock, and a host is not
   * "lost" for the time between construction and the room's first tick.
   */
  private lastSnapshotAtMs: number
  /**
   * Set by onDatagram when a snapshot decodes, consumed at the top of the next
   * tick(). The message handler has no clock of its own - it cannot, without
   * reading one, which contract §0 forbids outside transports and schedulers -
   * so the arrival is recorded as a flag and timestamped by the next tick. The
   * error that introduces is at most one tick (16.7ms) against a 1500ms
   * threshold, always in the direction of declaring host loss LATER.
   */
  private snapshotSincePreviousTick: boolean
  private promoted: boolean
  private readonly t: Transport
  /** peerId -> playerId, learned from input datagrams, for onPeerLost. */
  private readonly peerIdToPlayerId = new Map<string, number>()
  /** Retained so this loop's four body decodes run under the drop counter: the
   * guard covers decode CALLS, not handler bodies (item G). */
  private readonly guard: DatagramGuard
  /**
   * The highest eventSeq this loop has OBSERVED, from any snapshot's header,
   * whether or not it also applied the events behind it.
   *
   * Spec §5 says a promoted shadow "continues eventSeq from the highest it
   * observed", and this is the other half of that: every WireSnapshot carries
   * the host's own `nextEventSeq`, this loop already decodes it, and it used to
   * be thrown away. A host event lost in flight left this loop's counter behind
   * the host's, so after promotion it re-issued sequence numbers the host had
   * already spent - and every client ignores an eventSeq at or below the highest
   * it has applied, so the newly promoted authority's events were SILENTLY
   * DROPPED by the whole room until its counter climbed past the host's.
   *
   * A floor, never an assignment: it can only raise `live.nextEventSeq`, which
   * makes emissions strictly more novel and can never cause a double-apply. The
   * cost it accepts is that a host event whose seq is below a snapshot this loop
   * has already applied is dropped by applyEvent - correct in the ordering this
   * system actually produces (a host broadcasts an event on the reliable channel
   * before the snapshot that reflects it, in the same tick), and the reason it
   * self-heals a follower that has fallen behind.
   */
  private eventSeqFloor: number
  /** Mutable holder published through `promotionTickOf` - see that function. */
  private readonly promotionRecord: PromotionRecord = { tick: -1 }

  constructor(ctx: SimContext, state: SimState, t: Transport) {
    this.ctx = ctx
    this.publish = state
    this.t = t
    this.live = allocStateLike(ctx, state)
    this.scratch = allocStateLike(ctx, state)
    this.replayA = allocStateLike(ctx, state)
    this.replayB = allocStateLike(ctx, state)
    this.heldInput = makeIntentBuffer()
    this.heldInputTick = new Array(MAX_KARTS).fill(-1)
    this.lastProcessedInputTick = new Array(MAX_KARTS).fill(-1)
    this.pendingEvents = []
    this.decodedEvents = []
    this.pendingSnapshot = null
    this.snapshotBufA = freshWireSnapshot()
    this.snapshotBufB = freshWireSnapshot()
    this.snapshotDecodeTarget = this.snapshotBufA
    this.lastSnapshotTick = -1
    this.inputScratch = freshInputDatagram()
    this.checkpointBufA = allocStateLike(ctx, state)
    this.checkpointBufB = allocStateLike(ctx, state)
    this.checkpointDecodeTarget = this.checkpointBufA
    this.pendingCheckpoint = null
    this.snapshotBuf = new Uint8Array(SNAPSHOT_BUF_BYTES)
    this.eventsBuf = new Uint8Array(EVENTS_BUF_BYTES)
    this.freshEvents = []
    this.replayEvents = []
    this.history = []
    for (let i = 0; i < SHADOW_HISTORY_TICKS; i++) {
      this.history.push({ tick: -1, state: allocStateLike(ctx, state), inputs: makeIntentBuffer(), eventsApplied: [] })
    }
    this.lastSnapshotAtMs = -1
    this.snapshotSincePreviousTick = false
    this.eventSeqFloor = 0
    this.promoted = ctx.isLeader
    // Guarded, never a raw decodeHeader inside onMessage: this loop runs on the
    // server, where an uncaught throw out of a socket message handler takes the
    // process down and every other room with it (see receive.ts).
    this.guard = createDatagramGuard(this)
    promotionRecords.set(this, this.promotionRecord)
    t.onMessage(this.guard.wrap((peerId, channel, kind, payload) => {
      this.onDatagram(peerId, channel, kind, payload)
    }))
    t.onPeerLost((peerId) => this.onPeerLost(peerId))
  }

  /**
   * Spec §5: "A client that drops has its kart taken over by a bot ... and
   * reclaims it on reconnect with the same room code." Identical to
   * AuthorityLoop's handling, and this loop needs its own because a PROMOTED
   * shadow is the authority: without it, a client that drops after promotion
   * keeps a frozen kart nobody is driving, since resolveInputs only bot-fills a
   * kart whose `connected` is false and nothing would ever clear it.
   *
   * peerId -> playerId is learned from traffic (input datagrams carry playerId),
   * so a peer lost before it ever sent input is a no-op: no seat was known to be
   * it. Written to `live`; the next tick() republishes, as with every other
   * state change this loop makes.
   */
  private onPeerLost(peerId: string): void {
    const playerId = this.peerIdToPlayerId.get(peerId)
    if (playerId === undefined) return
    this.live.karts[playerId].connected = false
  }

  /**
   * One decoded datagram, header already validated by the guard. This is the one
   * place in the system that genuinely sees four kinds across two channels:
   * client input, plus the host's snapshots and events, plus a resync
   * checkpoint.
   *
   * EVERY KIND IS GATED ON ITS CHANNEL, matching AuthorityLoop and ClientLoop.
   * This loop used to take `_channel` and discard it, and it is the one loop
   * that accepts a `checkpoint` - the single message that replaces its entire
   * state. AuthorityLoop refuses an `authorityChange` off the unreliable path
   * because "standing down is irreversible, so the one message that triggers it
   * is not accepted off the lossy path where anything at all can arrive"; a
   * checkpoint replaces more than that and had no channel check anywhere.
   * Verified before the fix: a `snapshot` delivered on 'reliable' was accepted
   * and hard-snapped a shadow from tick 1 to 501.
   *
   * A datagram on the wrong channel is IGNORED rather than counted as a drop -
   * the same treatment AuthorityLoop gives an authorityChange on the wrong
   * channel. The drop counter means "this loop could not use these bytes";
   * traffic addressed to a path this loop does not read on is not a fault it
   * observed.
   */
  private onDatagram(peerId: string, channel: ChannelName, kind: MessageKind, payload: Uint8Array): void {
    // Input keeps flowing after promotion — a promoted shadow IS the authority
    // and still needs every client's intent. Everything else is host traffic
    // and is ignored once this loop has taken over.
    if (kind === 'input') {
      if (channel !== 'unreliable') return
      const dg = this.inputScratch
      // Through the guard, like all four decodes below: a throw here is a
      // datagram that never arrived, while a throw from anything AFTER a decode
      // returns is a bug and reaches the caller (item G).
      if (!this.guard.decode(decodeInput, payload, dg)) return
      if (dg.playerId < 0 || dg.playerId >= MAX_KARTS) return
      // Same one-way ratchet AuthorityLoop's heldIntentTick is, anchored the same
      // way on `max(seat cursor, this loop's own tick)` - see receive.ts and
      // authority.ts. Checked before the peerId mapping and the reconnect flip,
      // so a rejected datagram moves nothing at all.
      const seatCursor = this.heldInputTick[dg.playerId]
      const inputAnchor = seatCursor > this.live.tick ? seatCursor : this.live.tick
      if (!tickCursorPlausible(dg.intents[dg.intents.length - 1].tick, inputAnchor)) {
        this.guard.reject()
        return
      }
      this.peerIdToPlayerId.set(peerId, dg.playerId)
      // Reconnect, same rule and same caveat as AuthorityLoop's: input for a
      // seat currently marked disconnected is the reconnect signal, identity by
      // claim until Plan 4's lobby handshake authenticates it.
      if (!this.live.karts[dg.playerId].connected) this.live.karts[dg.playerId].connected = true
      const newest = dg.intents[dg.intents.length - 1]
      if (newest.tick > this.heldInputTick[dg.playerId]) {
        const h = this.heldInput[dg.playerId]
        h.tick = newest.tick
        h.steer = newest.steer
        h.accel = newest.accel
        h.brake = newest.brake
        h.drift = newest.drift
        h.useItem = newest.useItem
        this.heldInputTick[dg.playerId] = newest.tick
      }
      return
    }

    if (this.promoted) return

    if (kind === 'events') {
      if (channel !== 'reliable') return
      if (!this.guard.decode(decodeEvents, payload, this.decodedEvents)) return
      // Whole batch first, nothing queued until all of it passes: applyEvent
      // ratchets nextEventSeq to `ev.eventSeq + 1` and discards everything at or
      // below it forever after. See client.ts's copy of this check.
      for (const ev of this.decodedEvents) {
        if (!eventCursorPlausible(ev.eventSeq, this.eventSeqAnchor())) {
          this.guard.reject()
          return
        }
      }
      for (const ev of this.decodedEvents) this.pendingEvents.push(ev)
    } else if (kind === 'snapshot') {
      if (channel !== 'unreliable') return
      const decoded = this.snapshotDecodeTarget
      if (!this.guard.decode(decodeSnapshot, payload, decoded)) return
      // A snapshot moves THREE cursors below - the liveness flag, eventSeqFloor
      // and lastSnapshotTick - so both plausibility checks run before any of
      // them, and a rejected frame moves none.
      //
      // The tick anchor is `lastSnapshotTick`, the cursor this snapshot would
      // advance, and NOT this loop's own counter: a follower's tick number is
      // the number the host is entitled to overrule, and the reconcile path one
      // screen down hard-snaps onto a snapshot it cannot rewind to on purpose.
      //
      // -1 (nothing adopted yet) leaves only the absolute bound. That window is
      // LATE JOIN, a designed path here and not a degraded one: a joiner
      // attaches at tick 0 and hard-snaps onto the first snapshot it receives,
      // hundreds of ticks ahead, which is what packages/net/test/latejoin.test.ts
      // measures. There is genuinely nothing to compare a first snapshot
      // against, so MAX_WIRE_TICK - the largest tick this format can describe at
      // all - is what applies, and it is what stops a poisoned first datagram
      // from wedging a fresh joiner.
      if (!tickCursorPlausible(decoded.tick, this.lastSnapshotTick)) {
        this.guard.reject()
        return
      }
      if (!eventCursorPlausible(decoded.eventSeq, this.eventSeqAnchor())) {
        this.guard.reject()
        return
      }
      // The liveness half of the promotion timer counts snapshots RECEIVED, so
      // it resets even for a snapshot too old to reconcile against: the host is
      // demonstrably still broadcasting. Reached only if the decode returned -
      // a datagram that could not be decoded never arrived at all. Recorded as a
      // flag and timestamped by the next tick(); see snapshotSincePreviousTick.
      this.snapshotSincePreviousTick = true
      // Observed from EVERY decoded snapshot, including one too stale to
      // reconcile against: its header still carries a host counter this loop has
      // seen, and max() makes a stale one a no-op (see eventSeqFloor).
      if (decoded.eventSeq > this.eventSeqFloor) this.eventSeqFloor = decoded.eventSeq
      // Newer than what has been reconciled AND newer than what is already
      // queued. Comparing against `lastSnapshotTick` alone is not enough once
      // the buffers are split: two frames in one window would then both be
      // accepted and the second, older one would replace the first.
      const pendingTick = this.pendingSnapshot !== null ? this.pendingSnapshot.tick : -1
      if (decoded.tick > this.lastSnapshotTick && decoded.tick > pendingTick) {
        // Committed only now, after a decode that ran to completion.
        this.pendingSnapshot = decoded
        this.snapshotDecodeTarget = decoded === this.snapshotBufA ? this.snapshotBufB : this.snapshotBufA
      }
    } else if (kind === 'checkpoint') {
      if (channel !== 'reliable') return
      // Full-precision resync (spec §5). Decoded here, applied in tick(): no
      // handler mutates `live` directly. Deliberately does NOT reset
      // ticksSinceSnapshot — spec §5 declares host loss after 1.5s with no
      // SNAPSHOT, and a host that can send a checkpoint but no snapshots is
      // exactly the failure promotion exists for.
      //
      // Its `tick` is deliberately NOT bounded the way a snapshot's is. A
      // checkpoint is the message defined to replace the timeline wholesale -
      // bounding it against the timeline it replaces is meaningless, and
      // packages/net/test/malformed.test.ts already measures a legitimate
      // checkpoint moving a tick-5 shadow to tick 801. What guards it is that it
      // is a full-state frame with an exact-length check and four enum guards in
      // its own codec, on the reliable channel only (above), from a sender Plan
      // 4's lobby handshake authenticates. A hostile checkpoint claiming a huge
      // tick would still strand this loop; that residue is recorded in this
      // task's report rather than papered over here.
      const target = this.checkpointDecodeTarget
      if (!this.guard.decode(decodeCheckpoint, payload, target)) return
      this.pendingCheckpoint = target
      this.checkpointDecodeTarget = target === this.checkpointBufA ? this.checkpointBufB : this.checkpointBufA
    }
  }

  /**
   * The highest event sequence number this loop has accounted for, from either
   * half of the pair it keeps: the counter it has actually applied events up to,
   * and the floor it has merely observed in a host snapshot header. The larger
   * of the two is the honest anchor for "how far ahead may the next one be" -
   * eventSeqFloor legitimately runs ahead of nextEventSeq whenever a host event
   * is lost in flight, and anchoring on the smaller would make a perfectly
   * ordinary snapshot look like a jump.
   */
  private eventSeqAnchor(): number {
    return this.eventSeqFloor > this.live.nextEventSeq ? this.eventSeqFloor : this.live.nextEventSeq
  }

  /**
   * One 60Hz step, plus the host-loss check.
   *
   * `nowMs` is the scheduler's wall clock, on the same timebase from call to
   * call - absolute, exactly like LoopbackTransport.pump(nowMs), not a delta.
   * Absolute rather than elapsed on purpose: a scheduler running a catch-up
   * burst calls this several times for one wall instant and passes the same
   * `nowMs` to each, which is unambiguous, whereas a delta would have to be
   * apportioned across the burst and would silently mis-count if it were not.
   *
   * It is a REQUIRED parameter and not an optional one: a default would let a
   * scheduler omit it and leave the host-loss timer frozen forever, which is the
   * exact class of defect this parameter exists to remove.
   */
  tick(nowMs: number): void {
    // Before anything else, so a snapshot that arrived since the previous tick
    // is credited at this instant rather than after this tick's own promotion
    // check. Also seeds the timer on the very first tick: the loop is
    // constructed without a clock, and the gap between construction and the
    // room's first tick is not host silence.
    if (this.lastSnapshotAtMs < 0 || this.snapshotSincePreviousTick) {
      this.lastSnapshotAtMs = nowMs
      this.snapshotSincePreviousTick = false
    }

    if (!this.promoted && this.pendingCheckpoint !== null) {
      // Outranks any pending snapshot: exact where a snapshot is quantised,
      // and it arrives precisely when this loop's own history is unusable.
      cloneState(this.pendingCheckpoint, this.live)
      this.pendingCheckpoint = null
      this.pendingSnapshot = null
      // NOT reset to -1. The history ring is fiction after a resync, but this
      // cursor is an ORDERING guard, and a snapshot still in flight from before
      // the checkpoint is exactly the frame it exists to reject: accepted, it
      // hard-snaps `live.tick` backwards onto a timeline the host has already
      // abandoned. Raised, never lowered - a checkpoint older than the newest
      // reconciled snapshot must not widen the window either.
      this.lastSnapshotTick = Math.max(this.lastSnapshotTick, this.live.tick)
      for (const e of this.history) e.tick = -1 // every buffered tick is now fiction
    }

    if (!this.promoted && this.pendingSnapshot !== null) {
      this.reconcile(this.pendingSnapshot)
      this.pendingSnapshot = null
    }

    const slot = (this.live.tick + 1) % SHADOW_HISTORY_TICKS
    const entry = this.history[slot]
    entry.eventsApplied.length = 0
    if (!this.promoted) {
      for (const ev of this.pendingEvents) {
        applyEvent(this.ctx, this.live, ev)
        entry.eventsApplied.push(ev)
      }
      this.pendingEvents.length = 0
    }

    // Follower and leader use the same held input: once promoted there is no
    // host left to hold it on this loop's behalf, and spec §5's pair-of-ticks
    // rule ("repeating the last known intent across gaps") is what `heldInput`
    // already is.
    const inputsForStep = this.heldInput
    this.freshEvents.length = 0
    step(this.ctx, this.live, this.scratch, inputsForStep, this.freshEvents)
    const tmp = this.live
    this.live = this.scratch
    this.scratch = tmp

    for (let i = 0; i < MAX_KARTS; i++) this.lastProcessedInputTick[i] = this.heldInputTick[i]

    cloneState(this.live, entry.state)
    entry.tick = this.live.tick
    for (let i = 0; i < MAX_KARTS; i++) {
      const src = inputsForStep[i]
      const dst = entry.inputs[i]
      dst.tick = src.tick; dst.steer = src.steer; dst.accel = src.accel
      dst.brake = src.brake; dst.drift = src.drift; dst.useItem = src.useItem
    }

    cloneState(this.live, this.publish)

    if (this.promoted) {
      if (this.live.tick % SNAPSHOT_PERIOD_TICKS === 0) this.broadcastSnapshot()
      if (this.freshEvents.length > 0) this.broadcastEvents(this.freshEvents)
      return
    }

    // Wall time since the last tick that held a snapshot - NOT a count of ticks
    // (item C). The two agree only while the scheduler is healthy, and they
    // disagree exactly when this check matters.
    if (nowMs - this.lastSnapshotAtMs >= HOST_TIMEOUT_MS) this.promote(this.live.tick)
  }

  promote(tick: number): void {
    if (this.promoted) return
    // Anything the host got to this loop but tick() has not folded in yet is
    // folded in FIRST, so the eventSeq announced below is exactly one past the
    // highest this loop has applied (spec §5: "continues eventSeq from the
    // highest it observed"). On the auto-promotion path this is always empty —
    // tick() clears it before calling promote() — but an explicit promote()
    // between two ticks would otherwise both lose those events and understate
    // the announcement.
    for (const ev of this.pendingEvents) applyEvent(this.ctx, this.live, ev)
    this.pendingEvents.length = 0
    // The announcement below is this loop's promise about every eventSeq it will
    // ever issue, so the floor is enforced here too and not only in tick():
    // promote() can be called directly, between two ticks.
    this.raiseToEventSeqFloor()
    // A snapshot or checkpoint pending at this instant is deliberately dropped
    // rather than applied: both would move `live` at the moment authority
    // changes, and promotion's one guarantee is that nothing rewinds. They are
    // also truth about a host that no longer exists.
    this.pendingSnapshot = null
    this.pendingCheckpoint = null

    // Recorded from the SAME `tick` the announcement below carries, on the line
    // above it, so the published value and the broadcast one cannot drift: every
    // peer recomputes promotionCursor(raceSeed, promotionTick) from that message
    // and must land on the number this loop is about to use (ruling P2-R14).
    this.promotionRecord.tick = tick

    const out = new Uint8Array(AUTHORITY_CHANGE_BYTES)
    encodeAuthorityChange(out, tick, this.live.nextEventSeq)
    this.t.broadcast('reliable', out)
    // Re-seed the item PRNG deterministically from (raceSeed, promotionTick), spec §5, through
    // sim's own promotionCursor (ruling P2-R14). rngAt is stateless, so raceSeed never changes and
    // what gets re-derived is the CURSOR. An earlier draft of this file wrote `rngCursor = tick`,
    // which is deterministic but lands in exactly the small low range of cursors the dead host had
    // been consuming; promotionCursor runs the same avalanche rngAt does and spreads the result
    // over the whole 32-bit range. Every client can recompute it from raceSeed plus the
    // promotionTick it reads off the authorityChange message just sent, so nobody has to be told it.
    this.live.rngCursor = promotionCursor(this.live.raceSeed, tick)
    this.ctx.isLeader = true
    this.promoted = true
    // Republish. promote() is the only state mutation this loop makes outside
    // tick(), and `publish` (the caller's object) is the only view a caller
    // has — contract §5 gives ShadowLoop no state() getter. Without this line
    // a caller that calls promote() directly reads a stale rngCursor until the
    // next tick() lands.
    cloneState(this.live, this.publish)
  }

  /**
   * Raises `live.nextEventSeq` to the highest counter any host snapshot has
   * announced. Monotonic by construction: it never lowers the counter.
   *
   * Called ONLY from promote(), never while following. Contract §1b/§0 is
   * explicit that a follower's `nextEventSeq` advances only by applying received
   * events - applySnapshotToState deliberately excludes the field for exactly
   * this reason, and a 900-tick follower test asserts it - so the floor lives
   * beside the state while this loop follows, and is enforced on the counter at
   * the one instant it starts issuing sequence numbers of its own. That is also
   * the instant it matters: the host is gone, so raising the counter can no
   * longer gate out a host event still in flight.
   */
  private raiseToEventSeqFloor(): void {
    if (this.live.nextEventSeq < this.eventSeqFloor) this.live.nextEventSeq = this.eventSeqFloor
  }

  private reconcile(snap: WireSnapshot): void {
    const targetTick = snap.tick
    const nowTick = this.live.tick
    const oldest = nowTick - SHADOW_HISTORY_TICKS + 1
    const slot = ((targetTick % SHADOW_HISTORY_TICKS) + SHADOW_HISTORY_TICKS) % SHADOW_HISTORY_TICKS
    const entry = this.history[slot]
    this.lastSnapshotTick = targetTick

    if (targetTick > nowTick || targetTick < oldest || entry.tick !== targetTick) {
      // No buffered tick to rewind to: hard-snap and start a new timeline. Every
      // other ring slot now describes a history that never happened, so none of
      // them may serve as a replay base — the same reasoning the checkpoint path
      // uses one screen up.
      applySnapshotToState(snap, this.live)
      for (const e of this.history) e.tick = -1
      cloneState(this.live, entry.state)
      entry.tick = this.live.tick
      entry.eventsApplied.length = 0
      return
    }

    if (!this.diverges(entry.state, snap)) return

    applySnapshotToState(snap, entry.state)

    // Copy the corrected base OUT of the ring before replaying (see replayA/replayB).
    cloneState(entry.state, this.replayA)
    let cur = this.replayA
    let scratch = this.replayB
    for (let t = targetTick + 1; t <= nowTick; t++) {
      const histT = this.history[t % SHADOW_HISTORY_TICKS]
      // Replayed in the same order the live tick used them: events at the top of
      // the tick, then step(). applyEvent is idempotent on eventSeq, but this is
      // not a re-delivery — `cur` has been rewound to before these events, so its
      // nextEventSeq is back below them and each applies exactly once again,
      // landing on the same value it held before the rewind.
      for (const ev of histT.eventsApplied) applyEvent(this.ctx, cur, ev)
      step(this.ctx, cur, scratch, histT.inputs, this.replayEvents)
      this.replayEvents.length = 0
      const swap = cur
      cur = scratch
      scratch = swap
      cloneState(cur, histT.state)
      histT.tick = t
    }
    cloneState(cur, this.live)
  }

  private diverges(local: SimState, snap: WireSnapshot): boolean {
    const exceeds = (a: number, b: number, eps: number) => Math.abs(a - b) > eps
    const angleExceeds = (a: number, b: number, eps: number) => Math.abs(wrapAngle(a - b)) > eps
    // Phase first, and on its own: it is the one snapshot field that can differ
    // while every kart and entity still agrees to the last bit, and the
    // difference matters more than any of them - resolveInputs freezes all eight
    // karts while `phase === 'countdown'`. A shadow that never reconciled it
    // would go on freezing (or go on driving) a whole race behind its host, with
    // nothing in the divergence check able to see why. Task 15c item A.
    if (!Object.is(local.phase, snap.phase)) return true
    for (let i = 0; i < MAX_KARTS; i++) {
      const k = local.karts[i]
      const w = snap.karts[i]
      if (exceeds(k.position.x, w.position.x, EPS.position)) return true
      if (exceeds(k.position.y, w.position.y, EPS.position)) return true
      if (exceeds(k.position.z, w.position.z, EPS.position)) return true
      if (exceeds(k.velocity.x, w.velocity.x, EPS.velocity)) return true
      if (exceeds(k.velocity.y, w.velocity.y, EPS.velocity)) return true
      if (exceeds(k.velocity.z, w.velocity.z, EPS.velocity)) return true
      if (angleExceeds(k.heading, w.heading, EPS.heading)) return true
      if (exceeds(k.angularVelocity, w.angularVelocity, EPS.angularVelocity)) return true
      if (exceeds(k.drift.charge, w.driftCharge, EPS.driftCharge)) return true
      if (exceeds(k.lap.t, w.t, EPS.t)) return true
      if (!Object.is(k.drift.active, w.driftActive)) return true
      if (!Object.is(k.drift.dir, w.driftDir)) return true
      if (!Object.is(k.item, w.item)) return true
      if (!Object.is(k.airborne, w.airborne)) return true
      if (!Object.is(k.surface, w.surface)) return true
      if (!Object.is(k.spinOutTicks, w.spinOutTicks)) return true
      if (!Object.is(k.invulnTicks, w.invulnTicks)) return true
      if (!Object.is(k.boostTicks, w.boostTicks)) return true
      if (!Object.is(k.respawnTicks, w.respawnTicks)) return true
      if (!Object.is(k.shielded, w.shielded)) return true
      if (!Object.is(k.lap.lap, w.lap)) return true
      if (!Object.is(k.lap.checkpointIdx, w.checkpointIdx)) return true
    }
    if (local.entityCount !== snap.entityCount) return true
    const n = Math.min(local.entityCount, snap.entityCount)
    for (let i = 0; i < n; i++) {
      const e = local.entities[i]
      const w = snap.entities[i]
      if (exceeds(e.position.x, w.position.x, EPS.position)) return true
      if (exceeds(e.position.y, w.position.y, EPS.position)) return true
      if (exceeds(e.position.z, w.position.z, EPS.position)) return true
      if (exceeds(e.velocity.x, w.velocity.x, EPS.velocity)) return true
      if (exceeds(e.velocity.y, w.velocity.y, EPS.velocity)) return true
      if (exceeds(e.velocity.z, w.velocity.z, EPS.velocity)) return true
      if (angleExceeds(e.heading, w.heading, EPS.heading)) return true
      if (!Object.is(e.entityId, w.entityId)) return true
      if (!Object.is(e.kind, w.kind)) return true
      if (!Object.is(e.ownerId, w.ownerId)) return true
    }
    return false
  }

  private broadcastSnapshot(): void {
    const h = encodeHeader(this.snapshotBuf, 'snapshot')
    const n = encodeSnapshot(this.snapshotBuf.subarray(h), this.live, this.lastProcessedInputTick)
    // slice, not subarray: this buffer is reused every third tick and a
    // transport with latency queues what it is handed.
    this.t.broadcast('unreliable', this.snapshotBuf.slice(0, h + n))
  }

  private broadcastEvents(events: AuthEvent[]): void {
    const h = encodeHeader(this.eventsBuf, 'events')
    const n = encodeEvents(this.eventsBuf.subarray(h), events)
    this.t.broadcast('reliable', this.eventsBuf.slice(0, h + n))
  }
}

interface PromotionRecord {
  tick: number
}

/**
 * Per-instance promotion tick, without adding a fourth member to the class.
 * Contract §5 fixes ShadowLoop's shape at constructor/tick/promote exactly, so
 * this is a free function over a WeakMap - the same pattern `droppedDatagramsOf`,
 * `isDemoted`, `remoteInterpolatorOf` and `correctionDeltaOf` already use.
 */
const promotionRecords = new WeakMap<ShadowLoop, PromotionRecord>()

/**
 * The tick at which this shadow was promoted, or -1 if it is still following.
 *
 * Published, never compared against - the same discipline as
 * `lastProcessedInputTick`. It exists because `promotionCursor(raceSeed,
 * promotionTick)` must be recomputable by every peer from the `authorityChange`
 * message, and because a hub relaying that message cannot read a private field.
 * It is exactly the `tick` argument `promote()` was called with, recorded on the
 * line above the encode, so the two cannot drift.
 *
 * -1 ALSO for a loop constructed with `ctx.isLeader` already true. That is not a
 * gap: such a loop never ran `promote()`, so its `rngCursor` came from
 * `createState` and there is no promotion cursor for anyone to recompute. "Was
 * promoted at tick T" and "has been the leader all along" are different facts and
 * this returns only the first.
 *
 * Throws rather than returning -1 for a non-ShadowLoop, for the reason
 * `droppedDatagramsOf` does: a silent sentinel for "this object has no record" is
 * indistinguishable from the real answer.
 */
export function promotionTickOf(loop: ShadowLoop): number {
  const rec = promotionRecords.get(loop)
  if (!rec) throw new Error('promotionTickOf: not a ShadowLoop instance')
  return rec.tick
}
