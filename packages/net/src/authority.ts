import type { AuthEvent, Intent, SimContext, SimState } from '@tapkart/sim'
import { MAX_KARTS, allocStateLike, cloneState, makeIntentBuffer, step } from '@tapkart/sim'
import type { ChannelName, InputDatagram, MessageKind } from '@tapkart/protocol'
import { INPUT_REDUNDANCY, decodeInput, encodeEvents, encodeHeader, encodeSnapshot } from '@tapkart/protocol'
import type { Transport } from './transport'
import type { DatagramGuard } from './receive'
import { createDatagramGuard, tickCursorPlausible } from './receive'

/** 60Hz sim / 20Hz snapshot broadcast. Spec section 5. Exact: 60 / 20 = 3.
 * shadow.ts exports the same number for the same reason; the two are
 * deliberately not shared through an import - see this task's brief. */
const SNAPSHOT_PERIOD_TICKS = 3

/**
 * Generous fixed allocations, not protocol-mandated sizes: encodeSnapshot and
 * encodeEvents take a caller-owned buffer and return bytes written, so any
 * buffer at least as large as the worst case is correct.
 *
 * Worst-case snapshot, recomputed from locked contract §4's bit counts rather
 * than from a rounded byte figure: 8 karts x 178 bits = 1424, plus 32 entities
 * x 135 bits = 4320, plus a 202-bit header (200 + 2 bits of phase, Task 15c
 * item A) = 5946 bits = 744 B. With this file's 2-byte message header that is
 * 746 B on the wire; 1024 leaves headroom and costs nothing. (An earlier draft
 * cited "~625B", a figure from a superseded 177-bit kart record with a packed
 * entity velocity.)
 *
 * BitWriter neither throws nor grows on overflow - a typed-array write past the
 * end is a silent no-op - so an undersized buffer here truncates a snapshot
 * without any error at all, which is why this number is derived rather than
 * guessed. Events carry no stated per-tick cap; 2048B comfortably covers dozens.
 */
const SNAPSHOT_BUF_BYTES = 1024
const EVENTS_BUF_BYTES = 2048

/** A fresh array of exactly `n` distinct, zeroed Intent objects. */
function makeIntents(n: number): Intent[] {
  const out: Intent[] = []
  for (let i = 0; i < n; i++) {
    out.push({ tick: 0, steer: 0, accel: 0, brake: false, drift: false, useItem: false })
  }
  return out
}

/**
 * The host's 60Hz leader loop. Steps the sim, broadcasts a WireSnapshot at
 * 20Hz, broadcasts events on the reliable channel the tick they occur, and
 * holds each connected player's newest known intent across the 30Hz-into-60Hz
 * mismatch (spec section 5): "the authority holds the newest intent and
 * applies it to both ticks of the pair, repeating the last known intent
 * across gaps."
 *
 * peerId -> playerId is learned from traffic, not assumed: InputDatagram
 * carries playerId directly (locked contract §3), so the first input datagram
 * from a peer teaches this loop who that peer is, and onPeerLost looks the
 * mapping back up. A peer lost before ever sending input is a no-op — no kart
 * was ever known to be it.
 */
export class AuthorityLoop {
  private readonly ctx: SimContext
  private readonly live: SimState
  private readonly scratch: SimState
  private readonly transport: Transport

  private readonly heldIntent: Intent[] = makeIntentBuffer()
  /** Newest input tick RECEIVED per player - a receipt-side cursor. */
  private readonly heldIntentTick: number[] = new Array(MAX_KARTS).fill(-1)
  /** Newest input tick actually FOLDED INTO the simulation per player, which is
   * what spec §5 defines lastProcessedInputTick to mean ("the newest input from
   * that player the authority had folded in") and what every WireSnapshot
   * carries. Written in tick(), never in onMessage: a datagram that arrived but
   * has not yet been stepped is held, not processed.
   *
   * It is an input-buffer CURSOR and nothing else. Reconciliation compares at
   * `snap.tick` (spec §5, amended 2026-08-14, after a Plan 2 author prototyped
   * the literal "compare at lastProcessedInputTick" reading and measured
   * hundreds of spurious corrections in the test that must see zero). A
   * snapshot's `tick` and a player's `lastProcessedInputTick` describe
   * different instants; this loop publishes the second and never compares
   * against it. */
  private readonly lastProcessedInputTick: number[] = new Array(MAX_KARTS).fill(-1)
  private readonly stepInputs: Intent[] = makeIntentBuffer()
  private readonly events: AuthEvent[] = []
  private readonly inputDatagram: InputDatagram = { playerId: -1, intents: makeIntents(INPUT_REDUNDANCY) }
  private readonly snapshotBuf = new Uint8Array(SNAPSHOT_BUF_BYTES)
  private readonly eventsBuf = new Uint8Array(EVENTS_BUF_BYTES)
  private readonly peerIdToPlayerId = new Map<string, number>()
  /** Retained so body decodes can run under the drop counter: the guard is
   * scoped to decode calls only (item G), so a handler that wants a throw from
   * `decodeInput` treated as a dropped datagram has to say so. */
  private readonly guard: DatagramGuard
  /**
   * Set once, by a foreign `authorityChange`, and never cleared. See demote().
   */
  private demoted = false

  constructor(ctx: SimContext, state: SimState, t: Transport) {
    // Defensive: a caller-supplied ctx with isLeader false would silently stop
    // item rolls and event emission. The host is always the leader.
    this.ctx = { ...ctx, isLeader: true }
    this.live = state
    this.scratch = allocStateLike(this.ctx, state)
    this.transport = t
    // Every datagram goes through the guard, never straight into decodeHeader:
    // one malformed frame off a real socket would otherwise throw out of the
    // transport's message handler and kill the process (see receive.ts).
    this.guard = createDatagramGuard(this)
    t.onMessage(this.guard.wrap((peerId, channel, kind, payload) => {
      this.onDatagram(peerId, channel, kind, payload)
    }))
    t.onPeerLost((peerId) => this.onPeerLost(peerId))
  }

  /** The caller's own SimState, kept current by tick(). Contract §5: a
   * read-only view, so a test can compare two authorities without owning
   * either one's constructor argument. Never a copy - a copy would go stale. */
  state(): SimState {
    return this.live
  }

  /**
   * One decoded datagram. The shared header (contract §3) has already been read
   * and validated by the datagram guard, which is also what turns a throw from
   * `decodeInput` below into a dropped datagram instead of a dead process.
   *
   * Dispatches on `kind` rather than assuming everything unreliable is input: in
   * the deployed topology a promoted ShadowLoop broadcasts snapshots on this
   * very channel.
   */
  private onDatagram(peerId: string, channel: ChannelName, kind: MessageKind, payload: Uint8Array): void {
    // Somebody else is the authority now (Task 15c item B). Nothing in this class
    // ever broadcasts an authorityChange, and no transport loops a broadcast back
    // to its own sender, so every one of these is by construction FOREIGN and no
    // sender identity has to be tracked to know it.
    //
    // On the reliable channel only: authority migration rides the reliable
    // channel (spec §5), and standing down is irreversible, so the one message
    // that triggers it is not accepted off the lossy path where anything at all
    // can arrive.
    //
    // The body is deliberately not read. `tick` and `eventSeq` are advisory -
    // they are what a CLIENT rebases on - and the signal this loop acts on is the
    // tag itself. A host that ignored a truncated announcement while another
    // authority was already broadcasting would recreate exactly the two-authority
    // state this rules out.
    if (kind === 'authorityChange' && channel === 'reliable') {
      this.demote()
      return
    }
    if (kind !== 'input') return
    // Reliable-channel traffic FROM a peer (lobby state, checkpoint requests)
    // is a later plan's scope: this plan's protocol module map defines no
    // codec for it (locked contract §3's MessageKind lists the kinds, but
    // Tasks 3-10 export no encode/decode pair for any of them).
    if (channel !== 'unreliable') return

    // Nothing below this line is reached unless decodeInput ran to completion:
    // a truncated datagram throws out of it (BitReader is bounds-checked) and
    // the guard counts it as a drop with `inputDatagram` half-written but never
    // read. The decode goes through the guard explicitly because the guard no
    // longer wraps this whole method (item G) - a bug in the lines below this
    // one must reach the caller as a bug.
    if (!this.guard.decode(decodeInput, payload, this.inputDatagram)) return
    const playerId = this.inputDatagram.playerId
    if (playerId < 0 || playerId >= MAX_KARTS) return

    // The input window's newest intent tick is what advances heldIntentTick, and
    // heldIntentTick is a one-way ratchet: once it is past every tick a real
    // client will ever send, that seat drives the poisoned intent forever and
    // nothing anywhere records it. Measured: one datagram with baseTick ~ 2**32
    // left seat 3 at heading -0.2483 after 90 ticks where a clean run reaches
    // 0.9065, with dropped = 0.
    //
    // Anchored on `max(seat cursor, this loop's own tick)`: the cursor is what
    // tracks the client, and this loop's tick is what covers a seat's FIRST
    // datagram, where the cursor is still -1 and there is nothing to compare
    // against. An authority is by definition authoritative about "now", so a
    // client's intent tick has no business leading it. Checked before a single
    // field moves, including the peerId mapping and the reconnect flip below.
    const intentsIn = this.inputDatagram.intents
    const newestIn = intentsIn[intentsIn.length - 1]
    const seatCursor = this.heldIntentTick[playerId]
    if (!tickCursorPlausible(newestIn.tick, seatCursor > this.live.tick ? seatCursor : this.live.tick)) {
      this.guard.reject()
      return
    }

    this.peerIdToPlayerId.set(peerId, playerId)

    // RECONNECT (spec §5: a dropped client "reclaims it on reconnect with the
    // same room code"). onPeerLost clears `connected` and nothing in this plan
    // ever set it back, so a returning player's inputs were decoded, held, and
    // then silently discarded every tick by resolveInputs - which routes any
    // !connected kart through bot AI - leaving their kart bot-driven for the
    // rest of the race.
    //
    // Input for a seat currently marked disconnected IS the reconnect signal. It
    // needs no new message kind, and it is the first thing a returning client
    // sends. Exactly the inverse of onPeerLost's single field flip, so nothing
    // else is touched: `isBot` was never changed on the way out either.
    //
    // Identity by claim, which is right for this plan's loopback scope and not
    // beyond it - any peer can send a datagram naming any playerId. Plan 4's
    // lobby handshake is where reclaiming a seat gets authenticated.
    if (!this.live.karts[playerId].connected) this.live.karts[playerId].connected = true

    const intents = this.inputDatagram.intents
    for (let i = 0; i < intents.length; i++) {
      const it = intents[i]
      if (it.tick > this.heldIntentTick[playerId]) {
        const h = this.heldIntent[playerId]
        h.tick = it.tick
        h.steer = it.steer
        h.accel = it.accel
        h.brake = it.brake
        h.drift = it.drift
        h.useItem = it.useItem
        this.heldIntentTick[playerId] = it.tick
      }
    }
  }

  private onPeerLost(peerId: string): void {
    const playerId = this.peerIdToPlayerId.get(peerId)
    if (playerId === undefined) return
    // Spec section 5: "A client that drops has its kart taken over by a bot."
    // resolveInputs (packages/sim/src/phase.ts) routes any kart with
    // !connected through bot AI regardless of `isBot`'s own value, so this one
    // field flip is the entire mechanism.
    this.live.karts[playerId].connected = false
  }

  /**
   * Stands down permanently: stops broadcasting snapshots, stops broadcasting
   * events, and stops EMITTING at all (`ctx.isLeader = false`, which is what
   * gates every emit site in packages/sim and every item roll).
   *
   * AUTHORITY NEVER RETURNS TO THE ORIGINAL HOST. This is the whole ruling, and
   * it is chosen over "authority returns on reconnect" because it makes the
   * policy question moot rather than answering it: there is exactly ONE
   * authority at every instant, so no rewind rule is ever needed. The
   * alternative is what this loop used to do - a host merely unreachable for
   * 1.5s (a backgrounded tab, a tunnel hiccup) came back and resumed
   * broadcasting authoritative snapshots and events on the same channels as the
   * promoted shadow, with its own nextEventSeq, and every client still holding
   * the channel reconciled alternately against two divergent authorities.
   *
   * It KEEPS STEPPING, so its own view stays live for whatever is rendering it;
   * a later plan swaps this loop for a ClientLoop, which is what makes that view
   * authoritative again. Suppressing emission rather than only the broadcast
   * matters: a loop that still emitted would go on spending sequence numbers the
   * new authority is also spending.
   *
   * Not public: contract §5 fixes this class's shape at constructor/tick/state,
   * and demotion is not something a caller does - it is something the room tells
   * this loop. `isDemoted` (below) is how a test and a later composition root
   * observe it, through the same WeakMap pattern `droppedDatagramsOf` uses.
   */
  private demote(): void {
    if (this.demoted) return
    this.demoted = true
    // This loop's OWN ctx copy (the constructor spreads the caller's), so a
    // caller reading its own object still sees whatever it passed in. That is
    // also why isDemoted exists rather than "read ctx.isLeader".
    this.ctx.isLeader = false
    demotedLoops.add(this)
  }

  tick(): void {
    for (let i = 0; i < MAX_KARTS; i++) {
      const h = this.heldIntent[i]
      const dst = this.stepInputs[i]
      dst.tick = this.live.tick + 1
      dst.steer = h.steer
      dst.accel = h.accel
      dst.brake = h.brake
      dst.drift = h.drift
      dst.useItem = h.useItem
      // Folded in as of this step(), which is exactly what the field means.
      this.lastProcessedInputTick[i] = this.heldIntentTick[i]
    }

    this.events.length = 0
    step(this.ctx, this.live, this.scratch, this.stepInputs, this.events)
    cloneState(this.scratch, this.live)

    // Demoted: step, but say nothing. `this.events` is empty anyway once
    // ctx.isLeader is false (every emit site gates on it), and the two
    // broadcasts below are the rest of what makes this loop an authority.
    if (this.demoted) return

    if (this.events.length > 0) {
      const h = encodeHeader(this.eventsBuf, 'events')
      const n = encodeEvents(this.eventsBuf.subarray(h), this.events)
      this.transport.broadcast('reliable', this.eventsBuf.slice(0, h + n))
    }

    if (this.live.tick % SNAPSHOT_PERIOD_TICKS === 0) {
      const h = encodeHeader(this.snapshotBuf, 'snapshot')
      const n = encodeSnapshot(this.snapshotBuf.subarray(h), this.live, this.lastProcessedInputTick)
      this.transport.broadcast('unreliable', this.snapshotBuf.slice(0, h + n))
    }
  }
}

/**
 * Loops that have stood down. A WeakSet plus a free function for the same reason
 * `droppedDatagramsOf` and `remoteInterpolatorOf` are free functions: contract §5
 * fixes AuthorityLoop's public shape at constructor/tick/state exactly, and a
 * state flag is not worth widening it.
 */
const demotedLoops = new WeakSet<AuthorityLoop>()

/**
 * True once `loop` has received a foreign `authorityChange` and stood down for
 * good. It broadcasts nothing from that moment on - no snapshots, no events -
 * and emits nothing, though it keeps stepping its own view.
 *
 * Exposed so a test can assert the stand-down happened at all (a loop that
 * merely stopped broadcasting for some other reason looks identical from the
 * outside), and so the composition root a later plan writes can see the moment
 * it must swap this loop for a ClientLoop.
 */
export function isDemoted(loop: AuthorityLoop): boolean {
  return demotedLoops.has(loop)
}
