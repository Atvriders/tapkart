import type { AuthEvent, Intent, KartState, RacePhase, SimContext, SimState, Vec3 } from '@tapkart/sim'
import { MAX_ENTITIES, MAX_KARTS, allocStateLike, cloneState, createState, makeIntentBuffer, step, wrapAngle } from '@tapkart/sim'
import type { ChannelName, InputDatagram, MessageKind, WireEntity, WireKart, WireSnapshot } from '@tapkart/protocol'
import { EPS, INPUT_REDUNDANCY, decodeCheckpoint, decodeEvents, decodeInput, decodeSnapshot, encodeHeader, encodeInput } from '@tapkart/protocol'
import type { Transport } from './transport'
import type { DatagramGuard } from './receive'
import { TICK_MS } from './clock'
import { applyEvent } from './apply'
import { createDatagramGuard, eventCursorPlausible, tickCursorPlausible } from './receive'
// No cycle: shadow.ts imports only ./transport, ./receive and ./apply from
// within this package, and nothing at all from ./client.
import { decodeAuthorityChange } from './shadow'

/** 2.13s at 60Hz: >5x the 24-tick (400ms) worst-case round trip under this
 * plan's default lossy profile (150ms latency, 50ms jitter). See brief. */
const RING_CAPACITY = 128
/** 60Hz sim / 30Hz send = exact 2. */
const INPUT_SEND_INTERVAL_TICKS = 2
/** Generous fixed allocation, not a protocol-mandated size (see Task 14's
 * brief for the identical reasoning): an encoded input datagram is 8 small
 * intents plus the 2-byte message header, far under this. */
const SEND_BUF_BYTES = 256
/** Constructor-only placeholder. beginRace replaces it from the start message
 * before this loop is used as a live race. */
const ZERO_CHARACTER_IDX = [0, 0, 0, 0, 0, 0, 0, 0]

/**
 * A race phase's position in the only order a race can move through them.
 * `updatePhase` (packages/sim/src/phase.ts) goes countdown -> racing ->
 * finished and has no path back, on any peer, so a snapshot describing an
 * EARLIER phase than the one this loop already holds is never news: it is a
 * snapshot that was in flight while the race moved on. Allocated once, at module
 * load - `tick()` only indexes it.
 */
const PHASE_RANK: Record<RacePhase, number> = { countdown: 0, racing: 1, finished: 2 }

function makeIntents(n: number): Intent[] {
  const out: Intent[] = []
  for (let i = 0; i < n; i++) out.push({ tick: 0, steer: 0, accel: 0, brake: false, drift: false, useItem: false })
  return out
}

function copyIntentInto(dst: Intent, src: Intent): void {
  dst.tick = src.tick
  dst.steer = src.steer
  dst.accel = src.accel
  dst.brake = src.brake
  dst.drift = src.drift
  dst.useItem = src.useItem
}

// TICK_MS is used here only to timestamp RemoteInterpolator keyframes - no
// Date.now() call anywhere in this file, matching contract §0's "ticks only"
// convention; this loop's own tick counter already advances in lockstep with
// real time under normal play. It is DEFINED in clock.ts (Task 15c item F moved
// it there, beside advanceAccumulator, which needs the same number) and still
// reaches every downstream reader through the package barrel unchanged.

/** RemoteInterpolator retains keyframes across many tick()s. A pushed karts array
 * must be this loop's own copy: `decodeTarget` is one of two ping-ponged scratch
 * buffers (this brief's verification note, finding 2) that a later decode
 * overwrites in place, and a keyframe holding a reference into it would
 * silently corrupt already-buffered history the moment the next snapshot
 * arrives. */
function cloneWireKarts(karts: WireKart[]): WireKart[] {
  return karts.map((k) => ({ ...k, position: { ...k.position }, velocity: { ...k.velocity } }))
}

/** The live prefix only: WireSnapshot packs live entities at the front and
 * decodeSnapshot re-sentinels the rest, so slots at or past `count` describe
 * nothing. Same retention rule as cloneWireKarts - the decode target is scratch. */
function cloneWireEntities(entities: WireEntity[], count: number): WireEntity[] {
  const out: WireEntity[] = []
  for (let i = 0; i < count; i++) {
    const e = entities[i]
    out.push({ ...e, position: { ...e.position }, velocity: { ...e.velocity } })
  }
  return out
}

/** decodeSnapshot writes into an already-shaped destination, same convention
 * as cloneState. */
function makeWireSnapshotTarget(): WireSnapshot {
  const karts: WireKart[] = []
  for (let i = 0; i < MAX_KARTS; i++) {
    karts.push({
      playerId: 0, position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 },
      heading: 0, angularVelocity: 0, driftCharge: 0, driftActive: false, driftDir: 0,
      airborne: false, surface: 'tarmac', spinOutTicks: 0, invulnTicks: 0, item: 'none',
      lap: 0, checkpointIdx: 0, t: 0, isBot: false, connected: false,
      boostTicks: 0, respawnTicks: 0, shielded: false,
    })
  }
  const entities: WireEntity[] = []
  for (let i = 0; i < MAX_ENTITIES; i++) {
    entities.push({ entityId: -1, kind: 'seeker', ownerId: -1, position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, heading: 0, ttl: 0 })
  }
  return { tick: 0, eventSeq: 0, phase: 'countdown', lastProcessedInputTick: new Array(MAX_KARTS).fill(-1), karts, entities, entityCount: 0 }
}

/** True when any field differs from `wire` by more than its EPS.*. Never
 * compares with a tighter tolerance than EPS - see brief. */
function ownKartDiverged(predicted: KartState, wire: WireKart): boolean {
  if (Math.abs(predicted.position.x - wire.position.x) > EPS.position) return true
  if (Math.abs(predicted.position.y - wire.position.y) > EPS.position) return true
  if (Math.abs(predicted.position.z - wire.position.z) > EPS.position) return true
  if (Math.abs(predicted.velocity.x - wire.velocity.x) > EPS.velocity) return true
  if (Math.abs(predicted.velocity.y - wire.velocity.y) > EPS.velocity) return true
  if (Math.abs(predicted.velocity.z - wire.velocity.z) > EPS.velocity) return true
  if (Math.abs(wrapAngle(predicted.heading - wire.heading)) > EPS.heading) return true
  if (Math.abs(predicted.angularVelocity - wire.angularVelocity) > EPS.angularVelocity) return true
  if (Math.abs(predicted.drift.charge - wire.driftCharge) > EPS.driftCharge) return true
  if (Math.abs(predicted.lap.t - wire.t) > EPS.t) return true
  if (predicted.spinOutTicks !== wire.spinOutTicks) return true
  if (predicted.invulnTicks !== wire.invulnTicks) return true
  if (predicted.boostTicks !== wire.boostTicks) return true
  if (predicted.respawnTicks !== wire.respawnTicks) return true
  if (predicted.lap.lap !== wire.lap) return true
  if (predicted.lap.checkpointIdx !== wire.checkpointIdx) return true
  if (predicted.item !== wire.item) return true
  if (predicted.surface !== wire.surface) return true
  if (predicted.drift.active !== wire.driftActive) return true
  if (predicted.drift.dir !== wire.driftDir) return true
  if (predicted.airborne !== wire.airborne) return true
  if (predicted.shielded !== wire.shielded) return true
  return false
}

/**
 * Rebases the local kart onto `wire`, per field, with the epsilon table as a
 * dead band: a continuous field already within its EPS of the wire value keeps
 * the client's own FULL-PRECISION number instead of being overwritten with the
 * wire's quantised one.
 *
 * This matters more than it looks. `wire` is quantised, so overwriting a field
 * that already agrees injects up to half a quantisation step of fresh error into
 * a trajectory that was fine - and a velocity residual of 0.0156 m/s is far
 * below EPS.velocity, invisible to every later comparison, and integrates
 * straight into position error that crosses EPS.position a few seconds later,
 * triggering the next correction, which injects the next residual. Measured
 * against a real AuthorityLoop at 20ms latency, overwriting every field made the
 * client's true error GROW monotonically between corrections (0.009 m -> 0.036 m
 * over 130 ticks, correcting roughly every 150 ticks); the dead band makes it
 * DECAY (0.019 m -> 0.003 m over the same span), which is what lets this loop
 * pass the convergence test above it.
 *
 * EPS is not the information-theoretically optimal width for this dead band, and
 * is not offered as one. The switch point that minimises injected error sits
 * nearer one full quantisation step - a wire value is wrong by at most half a
 * step, so a step is roughly where "the wire knows better than the client" starts
 * being true - whereas contract §4's epsilons run about 1.6x their own steps
 * (EPS.position 0.05 against a 0.03125 step). EPS is used anyway because it is
 * the constant the contract blesses for exactly this comparison, it is what
 * ownKartDiverged one screen up already tests with, and it is strictly better
 * than no dead band at all. A deliberate choice of a blessed constant over a
 * derived one, not a derivation.
 *
 * The exact/enum fields below carry no quantisation noise at all - contract §4
 * gives them no epsilon precisely because comparing an integer with a tolerance
 * is meaningless - so they are always taken from the wire.
 */
function resyncOwnKart(kart: KartState, wire: WireKart): void {
  if (Math.abs(kart.position.x - wire.position.x) > EPS.position) kart.position.x = wire.position.x
  if (Math.abs(kart.position.y - wire.position.y) > EPS.position) kart.position.y = wire.position.y
  if (Math.abs(kart.position.z - wire.position.z) > EPS.position) kart.position.z = wire.position.z
  if (Math.abs(kart.velocity.x - wire.velocity.x) > EPS.velocity) kart.velocity.x = wire.velocity.x
  if (Math.abs(kart.velocity.y - wire.velocity.y) > EPS.velocity) kart.velocity.y = wire.velocity.y
  if (Math.abs(kart.velocity.z - wire.velocity.z) > EPS.velocity) kart.velocity.z = wire.velocity.z
  if (Math.abs(wrapAngle(kart.heading - wire.heading)) > EPS.heading) kart.heading = wire.heading
  if (Math.abs(kart.angularVelocity - wire.angularVelocity) > EPS.angularVelocity) kart.angularVelocity = wire.angularVelocity
  if (Math.abs(kart.drift.charge - wire.driftCharge) > EPS.driftCharge) kart.drift.charge = wire.driftCharge
  if (Math.abs(kart.lap.t - wire.t) > EPS.t) kart.lap.t = wire.t
  kart.drift.active = wire.driftActive
  kart.drift.dir = wire.driftDir
  kart.airborne = wire.airborne
  kart.surface = wire.surface
  kart.spinOutTicks = wire.spinOutTicks
  kart.invulnTicks = wire.invulnTicks
  kart.item = wire.item
  kart.lap.lap = wire.lap
  kart.lap.checkpointIdx = wire.checkpointIdx
  kart.boostTicks = wire.boostTicks
  kart.respawnTicks = wire.respawnTicks
  kart.shielded = wire.shielded
}

function writeWireKartInto(kart: KartState, wire: WireKart): void {
  kart.position.x = wire.position.x
  kart.position.y = wire.position.y
  kart.position.z = wire.position.z
  kart.velocity.x = wire.velocity.x
  kart.velocity.y = wire.velocity.y
  kart.velocity.z = wire.velocity.z
  kart.heading = wire.heading
  kart.angularVelocity = wire.angularVelocity
  kart.drift.charge = wire.driftCharge
  kart.drift.active = wire.driftActive
  kart.drift.dir = wire.driftDir
  kart.airborne = wire.airborne
  kart.surface = wire.surface
  kart.spinOutTicks = wire.spinOutTicks
  kart.invulnTicks = wire.invulnTicks
  kart.item = wire.item
  kart.lap.lap = wire.lap
  kart.lap.checkpointIdx = wire.checkpointIdx
  kart.lap.t = wire.t
  kart.boostTicks = wire.boostTicks
  kart.respawnTicks = wire.respawnTicks
  kart.shielded = wire.shielded
}

/**
 * One tick of prediction history. RING_CAPACITY of these are allocated once, in
 * the constructor, and reused round-robin: entry for tick T is always at slot
 * `T % RING_CAPACITY`, the same addressing ShadowLoop's history uses.
 *
 * Pooled because "no allocation in the hot path" is a locked constraint and this
 * loop was violating it - a fresh SimState per tick through allocStateLike, plus
 * an Intent literal and an events array, measured at 157 objects / 17.8 KB per
 * tick. Nothing outside this class ever sees a RingEntry, so reuse is safe by
 * construction as long as the two rules below hold, and they are worth stating
 * because a pooled buffer that is still being read is the classic way this goes
 * wrong:
 *
 *   - A slot is only rewritten when its tick leaves the window, so no live entry
 *     is ever aliased by a newer one.
 *   - A replay reads `input` and `appliedEvents` and writes `checkpoint`, but
 *     never uses a checkpoint as one of its own two step buffers (see
 *     `resyncBase` / `replayScratch`, which are separate states for exactly that
 *     reason), so an entry being written is never also being stepped from.
 */
interface RingEntry {
  tick: number
  input: Intent
  checkpoint: SimState
  /**
   * Events that arrived (and were applied to `predicted`) in the interval
   * between the previous tick() and this one, in arrival order. Without this a
   * rewind past a grant silently reverts it - a replay that only re-runs step()
   * has no way to know an event ever happened.
   *
   * They belong to tick `tick - 1`, NOT to `tick`. Live, they were applied to
   * `predicted` while its counter still read `tick - 1`, and they reached `tick`
   * only because this entry's step() carried them forward through cloneState.
   * So reconciliation re-applies them BEFORE replaying this entry's step(),
   * while `cur` is still at `tick - 1` - the same instant they took effect live.
   *
   * This comment used to assert the opposite (that applying them after the step
   * was "the same instant they took effect live") and the replay loop matched
   * it. It is off by one tick, and the tick it is off by is the one that matters
   * whenever an event and an input interact: an itemGrant banked here, with a
   * `useItem` on this entry's own input, replayed as step-then-grant lets the
   * step find an empty hand and then hands the item back, leaving the replayed
   * client holding an item it already spent.
   */
  appliedEvents: AuthEvent[]
}

/** decodeAuthorityChange RETURNS its result while DatagramGuard.decode takes a
 * `(buf, out) => void`. One holder, allocated once, bridges the two without
 * allocating per datagram. */
interface AuthorityChangeHolder { value: { tick: number; eventSeq: number } | null }

const intoAuthorityChange = (buf: Uint8Array, out: AuthorityChangeHolder): void => {
  out.value = decodeAuthorityChange(buf)
}

/**
 * The client's prediction and reconciliation loop. Only the local kart
 * (`playerId`) is trusted from this simulation. step() has no partial-seat
 * entry point, so remote bot seats run bot AI and remote human seats consume
 * neutral inputs; neither is rendered. Remote karts and entities are rendered
 * from RemoteInterpolator (below), which onMessage feeds from the live snapshot
 * stream and remoteInterpolatorOf exposes.
 */
export class ClientLoop {
  private readonly ctx: SimContext
  private readonly playerId: number
  private readonly transport: Transport

  private readonly predicted: SimState
  private readonly scratch: SimState
  private readonly resyncBase: SimState
  private readonly replayScratch: SimState
  private readonly replayInputs: Intent[]
  private readonly replayEvents: AuthEvent[] = []
  /** Preallocated: tick() feeds this to step() every tick and rewrites the one
   * slot it owns. Every other slot stays neutral forever, which is exactly what
   * a fresh makeIntentBuffer() gave it - resolveInputs routes the other seven
   * seats through bot AI regardless (they are !connected). */
  private readonly stepInputs: Intent[]
  /** step()'s out-array. A follower never emits (contract §1b), so this only
   * ever gets cleared; it exists so tick() does not build an array per tick. */
  private readonly tickEvents: AuthEvent[] = []

  /** Fixed-capacity, addressed by `tick % RING_CAPACITY`. See RingEntry. */
  private readonly ring: RingEntry[] = []
  /** Newest tick banked, and how many consecutive ticks behind it are valid.
   * Together these bound the ring without scanning it, and they are what makes a
   * stale slot left over from a pre-hardResync timeline unreachable. */
  private ringNewestTick = -1
  private ringCount = 0
  /** Reused, never reassigned: events applied since the last tick(), copied into
   * the current ring entry and cleared. */
  private readonly pendingAppliedEvents: AuthEvent[] = []

  private readonly sendWindow: Intent[]
  private readonly sendBuf = new Uint8Array(SEND_BUF_BYTES)
  /**
   * The boolean fields, OR-ed across the ticks the 30Hz cadence drops, and
   * cleared the moment they are sent (Task 15c item D).
   *
   * Only every OTHER 60Hz intent reaches the wire - the send below fires on
   * `predicted.tick % 2 === 0` and the intent handed in on the other tick used to
   * be discarded outright. Task 17 found this because a single-tick golden
   * perturbation changed nothing anywhere: a one-tick input spike was invisible
   * to the authority.
   *
   * That is a defect and not a curiosity because Plan 3 ruled `useItem` a
   * ONE-TICK PULSE emitted on press, precisely so a held button cannot auto-fire
   * the next item the instant it is granted. Half of all item uses were therefore
   * silently dropped, with no way for the player to tell which half.
   *
   * `brake`, `drift` and `useItem` are latched because they are events - a press
   * that happened at all must survive the cadence, and no amount of
   * reconciliation recovers one that did not: a dropped `useItem` is not a small
   * correction, it is an action the player took that never happened. `steer` and
   * `accel` are continuous and are NOT latched: the newest value is the right one
   * for those, and OR has no meaning for a number.
   *
   * THE ANALOG HALF IS A KNOWN, MEASURED, DELIBERATELY UNFIXED MISMATCH, and this
   * paragraph is here so the next reader does not "complete" the fix. This loop
   * PREDICTS on all 60 intents while TRANSMITTING 30, so on every unsent tick it
   * simulates a steer/accel value the authority will never apply - the temporal
   * twin of the quantisation mismatch `throughWire` above exists to remove. It
   * was implemented and measured during Task 15's review (predict on the intent
   * the authority is actually holding) and it changed nothing: 30 corrections
   * against 40 under varying input. Under real jitter, WHICH intent is newest at
   * authority-tick T is a fact about packet delivery that no client can predict,
   * so removing the sampling mismatch does not remove the corrections - while
   * predicting on the last-sent intent costs up to 16ms of local input lag on a
   * touchscreen racer, which is exactly the price ruling P2-R13 already declined
   * to pay. Latch the booleans; leave the analog fields alone.
   *
   * Three plain fields rather than a pooled Intent: nothing here allocates, and
   * the alternative invites a future reader to latch the analog fields too.
   */
  private latchedBrake = false
  private latchedDrift = false
  private latchedUseItem = false

  // Wire-form scratch for throughWire(), below.
  private readonly quantWindow: Intent[]
  private readonly quantDatagram: InputDatagram
  private readonly quantBuf = new Uint8Array(SEND_BUF_BYTES)

  // Ping-ponged decode targets: see brief point 2. A stale, out-of-order
  // decode must never overwrite an already-pending fresher snapshot.
  private readonly decodeScratchA: WireSnapshot
  private readonly decodeScratchB: WireSnapshot
  private decodeTarget: WireSnapshot
  private pendingSnapshot: WireSnapshot | null = null
  private highestSeenSnapshotTick = -1

  private readonly decodedEvents: AuthEvent[] = []

  private correctionCount = 0
  private readonly correctionDelta: CorrectionDelta = { applied: false, x: 0, y: 0, z: 0, heading: 0 }
  /** decodeCheckpoint writes its destination field by field and THROWS part-way
   * through a truncated buffer, so a checkpoint is decoded here and committed
   * into `predicted` only once the decode returned. receive.ts's own rule:
   * "decode into a scratch buffer, then commit". */
  private readonly checkpointScratch: SimState
  private readonly authorityHolder: AuthorityChangeHolder = { value: null }
  /** The datagram currently being dispatched, header included. The guard hands
   * handlers the BODY; decodeAuthorityChange validates the header it skips and
   * therefore needs the whole datagram. Set for the duration of one synchronous
   * callback and cleared after it - never retained. */
  private rawDatagram: Uint8Array | null = null
  private hardResyncCount = 0
  private readonly hardResyncCbs: ((tick: number) => void)[] = []
  private readonly remoteInterp = new RemoteInterpolator()
  /** Retained so the two body decodes below run under the drop counter: the
   * guard covers decode CALLS, not handler bodies (item G). */
  private readonly guard: DatagramGuard

  constructor(ctx: SimContext, playerId: number, t: Transport) {
    // Defensive: a caller-supplied ctx with isLeader true would roll items and
    // try to emit - a follower must never do either.
    this.ctx = { ...ctx, isLeader: false }
    this.playerId = playerId
    this.transport = t

    this.predicted = createState(this.ctx, 0, ZERO_CHARACTER_IDX)
    // The phase is NOT forced here. It starts where createState puts it -
    // 'countdown' - and is adopted from every snapshot this loop accepts (see
    // tick()). Task 15c item A: WireSnapshot carries `phase` now.
    //
    // This loop used to force 'racing' at construction, because the wire could
    // not carry the answer and sitting in a countdown it could never be told had
    // ended would have frozen the guest forever. The cost was the whole
    // countdown: every guest drove off the instant it connected while the host
    // counted down, and every snapshot in that window was a guaranteed
    // correction. A guest that has heard nothing from an authority yet is, as of
    // this task, in a countdown - which is also the honest answer.
    this.predicted.karts[playerId].isBot = false
    this.predicted.karts[playerId].connected = true

    this.scratch = allocStateLike(this.ctx, this.predicted)
    this.resyncBase = allocStateLike(this.ctx, this.predicted)
    this.replayScratch = allocStateLike(this.ctx, this.predicted)
    this.checkpointScratch = allocStateLike(this.ctx, this.predicted)
    this.replayInputs = makeIntentBuffer()
    this.stepInputs = makeIntentBuffer()

    // The entire ring, once. RING_CAPACITY SimStates is the same 2.3 MB the
    // ring held in steady state before it was pooled; the difference is that it
    // is now allocated deterministically at construction instead of churned 60
    // times a second forever.
    for (let i = 0; i < RING_CAPACITY; i++) {
      this.ring.push({
        tick: -1,
        input: { tick: 0, steer: 0, accel: 0, brake: false, drift: false, useItem: false },
        checkpoint: allocStateLike(this.ctx, this.predicted),
        appliedEvents: [],
      })
    }

    this.sendWindow = makeIntents(INPUT_REDUNDANCY)
    this.quantWindow = makeIntents(INPUT_REDUNDANCY)
    this.quantDatagram = { playerId: -1, intents: makeIntents(INPUT_REDUNDANCY) }
    this.decodeScratchA = makeWireSnapshotTarget()
    this.decodeScratchB = makeWireSnapshotTarget()
    this.decodeTarget = this.decodeScratchA

    this.guard = createDatagramGuard(this)
    const guarded = this.guard.wrap((_peerId, channel, kind, payload) => {
      this.onDatagram(channel, kind, payload)
    })
    t.onMessage((peerId, channel, data) => {
      this.rawDatagram = data
      try {
        guarded(peerId, channel, data)
      } finally {
        this.rawDatagram = null
      }
    })
    remoteInterpolators.set(this, this.remoteInterp)
    correctionDeltas.set(this, this.correctionDelta)
  }

  /**
   * One decoded datagram. The shared header (locked contract §3) has already
   * been read and validated by the datagram guard, and dispatch is on `kind`
   * rather than on the channel alone: a promoted ShadowLoop broadcasts snapshots
   * and events on the same two channels the host used, and this client keeps its
   * transport. Reading an events buffer as a snapshot because it happened to
   * arrive on the channel a snapshot usually uses is the failure that header
   * prevents.
   */
  private onDatagram(channel: ChannelName, kind: MessageKind, payload: Uint8Array): void {
    if (kind === 'snapshot' && channel === 'unreliable') {
      // Through the guard: a truncated snapshot is a datagram that never
      // arrived. Everything after this line is handler body, and a throw from
      // there is a bug the caller must see (item G).
      if (!this.guard.decode(decodeSnapshot, payload, this.decodeTarget)) return
      // A well-formed u32 that no authority this loop is following could be at.
      // `highestSeenSnapshotTick` is a one-way ratchet whose whole job is to
      // reject stale frames, so one poisoned value rejects EVERY later frame:
      // measured, one snapshot claiming tick 2**32-1 left 60 subsequent
      // legitimate snapshots producing 0 corrections and 0 interpolator
      // keyframes, with dropped = 0. A guest frozen with a dead render feed.
      //
      // Anchored on that cursor and NOT on this loop's own `predicted.tick`.
      // A follower's tick number is exactly the number an authority is entitled
      // to overrule - clock.ts's MAX_CATCHUP_TICKS makes a stalled client fall
      // permanently behind, and hardResync below exists to rebase it - so it is
      // not evidence about where the authority is. -1 (nothing received yet)
      // leaves only the absolute bound, which is what keeps hardResync reachable
      // for a first snapshot outside the 128-tick ring. See receive.ts.
      if (!tickCursorPlausible(this.decodeTarget.tick, this.highestSeenSnapshotTick)) {
        this.guard.reject()
        return
      }
      if (this.decodeTarget.tick > this.highestSeenSnapshotTick) {
        this.highestSeenSnapshotTick = this.decodeTarget.tick
        // Every remote kart's wire data, not just this client's own seat -
        // spec §5's "buffered and rendered ~100ms in the past" requirement
        // (this brief's Produces section, RemoteInterpolator). Timestamped by
        // this loop's own tick counter, not a wall-clock read (see TICK_MS).
        //
        // Entities travel with them (ruling P2-R8). Spec §5 forbids predicting
        // an entity at all, and `predicted`'s own entity pool is this follower's
        // untrusted local re-simulation, so the decoded entities are the ONLY
        // shells and slicks a guest can legitimately draw: dropping them here
        // (which is what this loop used to do) leaves a guest's world empty of
        // items for the whole race.
        //
        // THIS BRANCH ALLOCATES, AND THAT WAS MEASURED AND KEPT rather than
        // missed. cloneWireKarts, cloneWireEntities, the keyframe literal and
        // the `slice` below come to ~2.75 KB per ACCEPTED snapshot - about
        // 55 KB/s at the 20Hz snapshot rate. That is an order of magnitude below
        // the 17.8 KB per TICK (~1 MB/s) the prediction ring used to churn
        // before it was pooled, it is on the receive path rather than in tick(),
        // and the alternative is a second pool with a retention rule
        // (RemoteInterpolator holds keyframes across many ticks, so a pooled
        // keyframe would have to outlive REMOTE_BUFFER_CAPACITY pushes) whose
        // failure mode is silent history corruption. Deliberate.
        this.remoteInterp.push({
          recvAtMs: this.predicted.tick * TICK_MS,
          karts: cloneWireKarts(this.decodeTarget.karts),
          entities: cloneWireEntities(this.decodeTarget.entities, this.decodeTarget.entityCount),
          entityCount: this.decodeTarget.entityCount,
        })
        this.pendingSnapshot = this.decodeTarget
        this.decodeTarget = this.decodeTarget === this.decodeScratchA ? this.decodeScratchB : this.decodeScratchA
      }
      return
    }
    if (kind === 'events' && channel === 'reliable') {
      // Applied the instant they arrive, not deferred to the next tick():
      // spec section 5, "the local kart's hit reaction plays on receipt, not
      // on prediction." See Task 13's brief for what applyEvent does per kind.
      this.decodedEvents.length = 0
      if (!this.guard.decode(decodeEvents, payload, this.decodedEvents)) return
      // Checked across the WHOLE batch before any of it is applied, against the
      // counter as it stands now: applyEvent writes `nextEventSeq = eventSeq + 1`
      // and then ignores everything at or below it forever, so one poisoned seq
      // silently discards every real event for the rest of the race. Half-
      // applying a batch and then rejecting the rest would leave exactly the
      // partial state the guard exists to prevent, and events are rare enough
      // (13 in 900 ticks on this plan's own fixture) that a second pass is free.
      for (const ev of this.decodedEvents) {
        if (!eventCursorPlausible(ev.eventSeq, this.predicted.nextEventSeq)) {
          this.guard.reject()
          return
        }
      }
      for (const ev of this.decodedEvents) {
        applyEvent(this.ctx, this.predicted, ev)
        // Retaining the decoded object is safe: decodeEvents (Task 9) clears
        // `out` and pushes a FRESH object per event rather than overwriting
        // pooled ones, so a later decode into this same array cannot mutate an
        // event already banked on a ring entry. Verified by reading it.
        this.pendingAppliedEvents.push(ev)
      }
    }
    if (kind === 'checkpoint' && channel === 'reliable') {
      // Full-precision truth. Through the guard, into a scratch state: a
      // truncated checkpoint is a datagram that never arrived, and decoding
      // straight into `predicted` would leave this client half-way between two
      // timelines (decodeCheckpoint throws on an itemBoxes length mismatch,
      // checkpoint.ts, and past the end of a short buffer).
      if (!this.guard.decode(decodeCheckpoint, payload, this.checkpointScratch)) return
      cloneState(this.checkpointScratch, this.predicted)
      // Everything buffered against the old timeline is worthless: the ring
      // holds checkpoints of ticks this state has just replaced, and a pending
      // snapshot describes a timeline this client no longer has.
      this.ringNewestTick = -1
      this.ringCount = 0
      this.pendingAppliedEvents.length = 0
      this.pendingSnapshot = null
      this.highestSeenSnapshotTick = this.predicted.tick
      return
    }
    if (kind === 'authorityChange' && channel === 'reliable') {
      const raw = this.rawDatagram
      if (raw === null) return
      if (!this.guard.decode(intoAuthorityChange, raw, this.authorityHolder)) return
      const msg = this.authorityHolder.value
      if (msg === null) return
      // NOT a reset and NOT a ring clear: spec §5 is explicit that "there is no
      // rewind", because the shadow has been ticking all along. The only state
      // change is the event counter, so the promoted authority's first event is
      // not rejected as a duplicate by applyEvent's
      // `ev.eventSeq < state.nextEventSeq` guard - which would be silent on
      // every client at once.
      if (msg.eventSeq > this.predicted.nextEventSeq) this.predicted.nextEventSeq = msg.eventSeq
      return
    }
    // Every other kind - the lobby kinds, ping and pong - belongs to RoomClient,
    // which subscribes to the same transport (Transport.onMessage APPENDS,
    // contract §2.1 rule 1). A known kind this loop does not implement is simply
    // ignored.
    //
    // A datagram with an UNKNOWN tag, a mismatched protocol version, or a body
    // this loop cannot decode never reaches this method at all: the guard in
    // receive.ts drops and counts it. An earlier version of this comment
    // recorded decodeHeader's throw as the intended behaviour on that path. It
    // is not, and never was: the throw propagates out of Transport.onMessage,
    // and on a server that is an uncaught exception that takes down every room
    // in the process.
  }

  /**
   * `localIntent` as the authority will actually see it, round-tripped through
   * the real codec.
   *
   * encodeInput quantises steer to 8 bits over [-1, 1] and accel to 6 bits over
   * [0, 1] (Task 10; both widths are private to that file, so this goes through
   * the codec itself rather than re-deriving them here - a duplicated width
   * would silently desynchronise the day Task 10 changed one). A client that
   * predicted with the RAW analog value would simulate a *different input* from
   * the one the authority simulates, every tick, forever: measured against the
   * real bit-packed protocol, a steady steer of 0.15 (which is not on the 8-bit
   * grid; the nearest code dequantises to 0.14902) drove the local kart 0.05-0.07
   * m/s away from the authority's in ~20-40 ticks and produced 7 corrections in
   * 240 ticks, versus 2 for a grid-aligned steer. That is a systematic input
   * mismatch, not quantisation noise on the *snapshot*, and no epsilon in
   * contract §4's table is meant to absorb it - spec §8's zero-corrections
   * invariant is about a converged client, and a client predicting an input its
   * authority never receives never converges. End to end at the default lossy
   * profile the difference is 186 corrections per 600 ticks versus 1.
   *
   * The returned Intent is this loop's own scratch and is valid only until the
   * next call: both call sites copy out of it immediately.
   */
  private throughWire(localIntent: Intent, tick: number): Intent {
    for (const slot of this.quantWindow) {
      copyIntentInto(slot, localIntent)
      slot.tick = tick
    }
    encodeInput(this.quantBuf, this.playerId, this.quantWindow)
    decodeInput(this.quantBuf, this.quantDatagram)
    return this.quantDatagram.intents[INPUT_REDUNDANCY - 1]
  }

  tick(localIntent: Intent): void {
    // Predict on the wire form, never on the raw analog value - see throughWire.
    const wireIntent = this.throughWire(localIntent, this.predicted.tick + 1)
    copyIntentInto(this.stepInputs[this.playerId], wireIntent)
    this.stepInputs[this.playerId].tick = this.predicted.tick + 1

    this.tickEvents.length = 0 // scratch, discarded: a follower never emits
    step(this.ctx, this.predicted, this.scratch, this.stepInputs, this.tickEvents)
    cloneState(this.scratch, this.predicted)

    const entry = this.ring[this.predicted.tick % RING_CAPACITY]
    entry.tick = this.predicted.tick
    // The wire form, for the same reason tick() steps on it: a replay must
    // reproduce the input the simulation actually consumed.
    copyIntentInto(entry.input, wireIntent)
    entry.input.tick = this.predicted.tick
    cloneState(this.predicted, entry.checkpoint)
    entry.appliedEvents.length = 0
    for (const ev of this.pendingAppliedEvents) entry.appliedEvents.push(ev)
    this.pendingAppliedEvents.length = 0
    this.ringNewestTick = this.predicted.tick
    if (this.ringCount < RING_CAPACITY) this.ringCount++

    // Latch first, unconditionally, so a press on a tick this loop is about to
    // drop is still in hand when the next send comes round (item D). Every tick
    // contributes; only a send clears.
    if (localIntent.brake === true) this.latchedBrake = true
    if (localIntent.drift === true) this.latchedDrift = true
    if (localIntent.useItem === true) this.latchedUseItem = true

    if (this.predicted.tick % INPUT_SEND_INTERVAL_TICKS === 0) {
      for (let i = 0; i + 1 < this.sendWindow.length; i++) {
        copyIntentInto(this.sendWindow[i], this.sendWindow[i + 1])
      }
      const newest = this.sendWindow[this.sendWindow.length - 1]
      copyIntentInto(newest, localIntent)
      newest.tick = this.predicted.tick
      // The analog fields keep the newest value copyIntentInto just wrote; the
      // three event fields take the latch, which is that value OR-ed with the
      // tick this loop dropped. Cleared here and nowhere else, so one press
      // travels once: a latch that accumulated without clearing would leave
      // `useItem` true on the wire for the rest of the race and spend every
      // later item on the tick it was granted, which is the auto-fire Plan 3's
      // one-tick pulse exists to prevent.
      newest.brake = this.latchedBrake
      newest.drift = this.latchedDrift
      newest.useItem = this.latchedUseItem
      this.latchedBrake = false
      this.latchedDrift = false
      this.latchedUseItem = false
      const h = encodeHeader(this.sendBuf, 'input')
      const n = encodeInput(this.sendBuf.subarray(h), this.playerId, this.sendWindow)
      this.transport.broadcast('unreliable', this.sendBuf.slice(0, h + n))
    }

    // The discontinuity a correction applies is measured HERE, around
    // reconcile(), and nowhere else: reconcile overwrites `predicted` wholesale,
    // so once it returns the pre-correction trajectory is gone. `own` is a
    // stable object - cloneState, resyncOwnKart and writeWireKartInto all write
    // this kart field by field and never replace it - so reading it before and
    // after is reading the same kart.
    const own = this.predicted.karts[this.playerId]
    const preX = own.position.x
    const preY = own.position.y
    const preZ = own.position.z
    const preHeading = own.heading
    const preCorrections = this.correctionCount

    this.correctionDelta.applied = false
    if (this.pendingSnapshot !== null) {
      const snap = this.pendingSnapshot
      this.reconcile(snap)
      this.pendingSnapshot = null
      // The authority's phase, adopted from every accepted snapshot and not only
      // from the ones that correct (Task 15c item A). Three reasons it is here,
      // after reconcile(), rather than in onDatagram:
      //   - reconcile() overwrites `predicted` wholesale from a replayed ring
      //     checkpoint, whose phase predates this snapshot; a phase written
      //     before it would simply be undone.
      //   - ownKartDiverged compares kart fields only, so a snapshot that agrees
      //     about the kart returns early. That is the ordinary case, and it is
      //     exactly when the phase must still land.
      //   - It takes effect on the NEXT tick's step(), which is the same instant
      //     an authority's own advancePhase would have reached this loop.
      // The local sim still advances the phase on its own between snapshots
      // (phase.ts flips 'countdown' -> 'racing' at COUNTDOWN_TICKS, off a tick
      // counter reconciliation keeps aligned with the authority's), so this is a
      // correction on a value that usually already agrees - and the authority
      // over one that cannot be derived at all, like 'finished'.
      //
      // FORWARD ONLY (Task 15c item A, fix round). This write used to be
      // unconditional, and that made the countdown->racing boundary WORSE than
      // no phase on the wire at all. A snapshot in flight is ~9 ticks old at the
      // plan's own default 150ms latency, so for the first ~9 ticks after the
      // lights went out every snapshot this loop accepted still said
      // 'countdown'. `resolveInputs` runs FIRST in step() and `updatePhase` runs
      // LAST, so that stale phase discarded the whole of the NEXT tick's input
      // before local inference flipped it back: measured, three flickers and
      // three frozen ticks while the host accelerated away - the mirror image of
      // the defect this field was added to remove.
      //
      // A regression is refused rather than the local `tick >= COUNTDOWN_TICKS`
      // rule being re-applied here, for two reasons. It covers all three
      // transitions instead of only the countdown boundary (a stale 'racing'
      // arriving after 'finished' is the same class of bug and the local rule
      // cannot see it); and it keeps phase.ts as the single owner of the
      // countdown length, rather than opening a second site that has to be kept
      // in step with it. The invariant it buys is exactly one line long: the
      // phase this loop predicts on never goes backwards.
      //
      // hardResync is the one deliberate exception, and it is not reached
      // through here - see hardResync's own comment.
      if (PHASE_RANK[snap.phase] > PHASE_RANK[this.predicted.phase]) {
        this.predicted.phase = snap.phase
      }
      if (this.correctionCount !== preCorrections) {
        this.correctionDelta.applied = true
        this.correctionDelta.x = own.position.x - preX
        this.correctionDelta.y = own.position.y - preY
        this.correctionDelta.z = own.position.z - preZ
        this.correctionDelta.heading = wrapAngle(own.heading - preHeading)
      }
    }
  }

  /** Count of corrections since construction or the most recent beginRace.
   * The zero-corrections test's primary instrument - see brief. */
  corrections(): number {
    return this.correctionCount
  }

  /**
   * The `start` message, applied. Rebuilds `predicted` as
   * createState(ctx, seed, characterIdx) and applies `humanMask` to isBot and
   * connected, replacing the constructor's seed-0 / all-zero-characterIdx
   * placeholder - which exists only because Plan 2 had no `start` message to be
   * told any of this by.
   *
   * The PHASE IS LEFT at createState's 'countdown', so the 180-tick freeze runs
   * locally: countdown is free, because everyone who calls createState with the
   * same seed and the same seat map is aligned for the first 180 ticks whatever
   * the network does.
   *
   * humanMask, exactly: bit i set means seat i is a connected human. Every clear
   * bit is a bot. If the host, the shadow and a client disagree by one bit, one
   * kart is driven by bot AI on one machine and by a player on another, and the
   * only symptom is that reconciliation never converges for that seat.
   */
  beginRace(seed: number, characterIdx: number[], humanMask: number): void {
    const fresh = createState(this.ctx, seed, characterIdx)
    cloneState(fresh, this.predicted)
    for (let i = 0; i < MAX_KARTS; i++) {
      const human = ((humanMask >>> i) & 1) === 1
      this.predicted.karts[i].isBot = !human
      this.predicted.karts[i].connected = human
    }
    // This loop's own seat is never bot-driven in its own prediction:
    // resolveInputs routes a !connected kart through bot AI, so a client whose
    // own bit were clear would predict a kart that ignores every input it
    // produces. The server always sets it; this is the belt, and it matches what
    // the constructor already does.
    this.predicted.karts[this.playerId].isBot = false
    this.predicted.karts[this.playerId].connected = true

    // Every banked tick, every pending correction and every latched button
    // belongs to a race that is over. BOTH ring cursors, and
    // highestSeenSnapshotTick too: leaving that at the old race's value makes
    // every snapshot of the new one look stale and silently discards the lot.
    this.ringNewestTick = -1
    this.ringCount = 0
    this.pendingAppliedEvents.length = 0
    this.pendingSnapshot = null
    this.highestSeenSnapshotTick = -1
    this.correctionCount = 0
    this.correctionDelta.applied = false
    this.hardResyncCount = 0
    this.latchedBrake = false
    this.latchedDrift = false
    this.latchedUseItem = false
  }

  /** Fires when reconciliation could not find `snap.tick` in the ring and had to
   * hardResync. Appends, like every other listener registration in this package. */
  onHardResync(cb: (tick: number) => void): void {
    this.hardResyncCbs.push(cb)
  }

  /** Count of hard resyncs since construction (or since the last beginRace), for
   * contract §6.4's repeated-divergence rule. */
  hardResyncs(): number {
    return this.hardResyncCount
  }

  /** The live predicted state, not a copy (locked contract §5: "read-only
   * view; the convergence test asserts on it directly"). Callers must not
   * mutate it: this loop reconciles against its own history, and an outside
   * write would be reverted by the next correction without warning. */
  state(): SimState {
    return this.predicted
  }

  /**
   * Anchored on `snap.tick`, not `lastProcessedInputTick[playerId]` - see this
   * task's brief for why the literal spec reading is wrong. Short version: a
   * WireSnapshot has ONE tick because it is one coherent SimState at one
   * instant, and every kart field in it describes that instant;
   * `lastProcessedInputTick[i]` is a per-player input-buffer cursor that lags
   * it by about one one-way trip. Comparing this client's checkpoint from
   * there against wire data describing `snap.tick` compares two different
   * moments of an accelerating kart: measured, that is 163 corrections where
   * there should be 0 (the mirrored-authority test) and 192 where there should
   * be at most 3 (the end-to-end test).
   */
  private reconcile(snap: WireSnapshot): void {
    const targetTick = snap.tick
    const anchor = this.ringEntryAt(targetTick)
    if (anchor === null) {
      this.hardResync(snap)
      return
    }

    const wireKart = snap.karts[this.playerId]
    const predKart = anchor.checkpoint.karts[this.playerId]
    if (!ownKartDiverged(predKart, wireKart)) return
    this.correctionCount++
    cloneState(anchor.checkpoint, this.resyncBase)
    resyncOwnKart(this.resyncBase.karts[this.playerId], wireKart)
    // The wire's phase describes snap.tick, which is exactly this anchor's tick,
    // so the replay below runs on the authority's phase rather than on whatever
    // this client believed at the time. It matters: resolveInputs freezes every
    // kart while `phase === 'countdown'`, so a replay on a stale 'countdown'
    // silently discards every input it is replaying (Task 15c item A).
    this.resyncBase.phase = snap.phase

    let cur = this.resyncBase
    let scratch = this.replayScratch
    for (let t = targetTick + 1; t <= this.ringNewestTick; t++) {
      const e = this.ring[t % RING_CAPACITY]
      // Events first, while `cur` is still at `e.tick - 1`: that is the tick
      // they were applied on live (see RingEntry.appliedEvents). Reversing these
      // two lines replays every event one tick late.
      for (const ev of e.appliedEvents) applyEvent(this.ctx, cur, ev)
      copyIntentInto(this.replayInputs[this.playerId], e.input)
      this.replayInputs[this.playerId].tick = cur.tick + 1
      this.replayEvents.length = 0
      step(this.ctx, cur, scratch, this.replayInputs, this.replayEvents)
      const tmp = cur
      cur = scratch
      scratch = tmp
      // Refresh this entry's own checkpoint too, so a LATER reconcile() call
      // (targeting a tick further along) replays from corrected history
      // rather than the stale pre-correction data it held before. It now holds
      // what the live path's checkpoint held: this entry's events applied, then
      // stepped - which is also why the anchor entry's own events are correctly
      // NOT replayed above (they are already inside its checkpoint).
      cloneState(cur, e.checkpoint)
    }
    cloneState(cur, this.predicted)
  }

  /**
   * Degraded-mode fallback for a ring that does not (or no longer) hold
   * `snap.tick` - in practice, only reachable if the ring capacity (128
   * ticks, 2.13s) is exceeded by an extreme stall or a snapshot arrives before
   * the reliable checkpoint requested for recovery. This at least fixes the one
   * thing a snapshot can: the local kart's own fields, directly, with a
   * visible discontinuity accepted as the cost of not silently staying wrong
   * forever. Every other kart and every entity in `predicted` is unaffected -
   * neither is ever read for anything.
   */
  private hardResync(snap: WireSnapshot): void {
    this.correctionCount++
    writeWireKartInto(this.predicted.karts[this.playerId], snap.karts[this.playerId])
    this.predicted.tick = snap.tick
    // With the tick jumping to the authority's, the phase has to come with it:
    // this loop's own countdown/racing inference is a function of that counter,
    // and leaving the two disagreeing is how a hard resync lands a client in a
    // countdown the race left minutes ago.
    //
    // UNCONDITIONAL, and deliberately not the forward-only adoption tick() does
    // (Task 15c item A, fix round). That guard exists to reject a stale snapshot
    // measured against THIS LOOP'S OWN timeline; a hard resync abandons that
    // timeline outright and rebases on the authority's, tick counter and all. If
    // `snap.tick` regresses - the ring no longer reaches back to it - then the
    // phase regresses with it, or this loop would sit at tick 50 believing a race
    // it has just been told has not started is under way, and drive off through
    // the rest of the countdown. That is the original defect, reintroduced
    // through the one path entitled to go backwards.
    this.predicted.phase = snap.phase
    // Every banked tick belongs to a timeline that no longer exists. The pooled
    // slots are not cleared (that would be RING_CAPACITY pointless cloneStates);
    // emptying the window is what makes them unreachable, and ringEntryAt's
    // `e.tick === tick` check is the second, independent guard against a stale
    // slot whose tick happens to fall back inside a later window.
    this.ringNewestTick = -1
    this.ringCount = 0
    this.hardResyncCount++
    // Fired after the rebase, so a listener reading state() sees the timeline it
    // is being told about. The consumer calls RoomClient.requestResync
    // ('divergence', tick) when this crosses HARD_RESYNC_LIMIT within
    // HARD_RESYNC_WINDOW_TICKS; this loop never sends, because it holds the RACE
    // transport and the request goes over the CONTROL transport.
    for (const cb of this.hardResyncCbs) cb(snap.tick)
  }

  /** The banked entry for `tick`, or null if the ring's window no longer covers
   * it. O(1): entry for tick T is always at slot T % RING_CAPACITY. */
  private ringEntryAt(tick: number): RingEntry | null {
    if (this.ringCount === 0) return null
    if (tick > this.ringNewestTick) return null
    if (tick <= this.ringNewestTick - this.ringCount) return null
    const e = this.ring[tick % RING_CAPACITY]
    return e.tick === tick ? e : null
  }
}

/**
 * Per-instance access to a ClientLoop's RemoteInterpolator. This remains a free
 * function after Plan 4 adds the race-control members: rendering state is a
 * separate concern and does not need another method on the prediction loop.
 */
const remoteInterpolators = new WeakMap<ClientLoop, RemoteInterpolator>()

/** Throws rather than returning undefined: every ClientLoop registers itself in its
 * own constructor, so a missing entry means a caller passed something this module
 * never actually constructed. */
export function remoteInterpolatorOf(client: ClientLoop): RemoteInterpolator {
  const ri = remoteInterpolators.get(client)
  if (!ri) throw new Error('remoteInterpolatorOf: not a ClientLoop instance')
  return ri
}

interface CorrectionDelta {
  applied: boolean
  x: number
  y: number
  z: number
  heading: number
}

const correctionDeltas = new WeakMap<ClientLoop, CorrectionDelta>()

/**
 * The discontinuity the last reconciliation applied to the local kart: position
 * delta in metres into `outPos`, heading delta in radians (shortest arc, wrapped
 * to [-PI, PI]) as the return value. Returns null if the most recent tick()
 * applied no correction.
 *
 * A free function for the same reason remoteInterpolatorOf is one: render-only
 * correction state stays outside the prediction loop's public methods.
 *
 * Error smoothing in the render layer is a REQUIREMENT, not a polish item, and
 * this is the only input it can have. Measured against a real AuthorityLoop at
 * the default lossy profile, this netcode corrects roughly three times a second
 * under changing input (1 correction per 600 ticks on a held-steady intent, 29
 * under a sine, 39 under a square wave), and each one moves the kart by up to a
 * decimetre in a single frame. Rendered raw, that is a visible jump.
 *
 * null rather than a boolean so "no correction" stays distinguishable from "a
 * correction of exactly zero" - the dead band in resyncOwnKart means a
 * correction can legitimately leave one axis untouched.
 *
 * Heading is here because it dominates error growth: Task 15 measured a residual
 * of 0.0024 rad, which at 20 m/s is 0.048 m/s of lateral drift and crosses
 * EPS.position inside a second - three times faster than the velocity residual
 * does. A renderer that smoothed position alone would still snap the kart's
 * facing.
 */
export function correctionDeltaOf(client: ClientLoop, outPos: Vec3): number | null {
  const d = correctionDeltas.get(client)
  if (!d) throw new Error('correctionDeltaOf: not a ClientLoop instance')
  if (!d.applied) return null
  outPos.x = d.x
  outPos.y = d.y
  outPos.z = d.z
  return d.heading
}

// ---- RemoteInterpolator -----------------------------------------------
//
// Remote karts and all world entities are never predicted (spec section 5):
// buffered and rendered ~100ms in the past with interpolation, extrapolating
// briefly with a hard cap when the buffer starves. The class itself is
// standalone on purpose: state() exposes the
// PREDICTED SimState, whose remote seats are exactly the locally-simulated
// values spec section 5 says never to render. Its INPUT is wired, though: onMessage's
// 'snapshot' branch above pushes every accepted snapshot in here, and
// remoteInterpolatorOf (just above) is the free-function accessor the game
// renderer reads from.

/** Spec section 5: "approximately 100ms in the past." Exact here. */
export const REMOTE_INTERP_DELAY_MS = 100
/** 8 keyframes at the 20Hz snapshot rate = 400ms of retained history, 4x the
 * render delay, with headroom for the default 5% loss rate. */
export const REMOTE_BUFFER_CAPACITY = 8
/** One full snapshot period (50ms) x4: enough to ride out a single missed
 * snapshot's worth of dead air before visibly giving up. */
export const REMOTE_EXTRAPOLATE_CAP_MS = 200

export interface RemoteKeyframe {
  recvAtMs: number
  karts: WireKart[]
  /** Live entities, packed at the front exactly as WireSnapshot packs them.
   * Only the first `entityCount` describe anything. */
  entities: WireEntity[]
  entityCount: number
}

/**
 * A caller-owned sample buffer, filled in place by `sampleKart`.
 *
 * OUT-PARAMETER, NOT A RETURN VALUE, for the reason `liveEntityIds` already
 * takes a caller-owned Int32Array: a renderer calls this every frame. The
 * allocating form returned two fresh objects per call (the sample and its
 * `position`), which at 60 fps over 7 remote karts plus up to 32 entities is
 * ~4,700 objects/s - half the 9,400/s that was ruled a contract violation rather
 * than a preference when ClientLoop's ring was pooled. It was changed here, in
 * this plan, because Plan 3 has been authored but not executed: once a renderer
 * ships against the allocating form this is a breaking change to a locked
 * contract.
 */
export interface RemoteSample {
  position: { x: number; y: number; z: number }
  heading: number
  /**
   * The newest authoritative record received for this seat, verbatim off the
   * wire - NOT interpolated and NOT taken from the older half of the bracket.
   *
   * `position` and `heading` above are the interpolated render values; every
   * DISCRETE field a renderer needs - lap, checkpointIdx, item, spinOutTicks,
   * shielded, connected, isBot - has to be read from here instead (ruling
   * P2-R9). Interpolating them is meaningless, and the alternative source is
   * worse than meaningless: ClientLoop's predicted SimState drives all seven
   * remote seats with the local bot AI, so a HUD built on it would show lap
   * counters, standings and item icons for karts nobody is actually driving.
   *
   * A reference into this interpolator's own retained keyframe, not a copy.
   * Valid until REMOTE_BUFFER_CAPACITY further pushes evict that keyframe;
   * callers must not mutate it.
   */
  kart: WireKart
}

export interface RemoteEntitySample {
  position: { x: number; y: number; z: number }
  heading: number
  /** The newest authoritative record for this entity, verbatim off the wire -
   * `kind` and `ownerId` are how a renderer knows what to draw. Same lifetime
   * and same no-mutation rule as RemoteSample.kart. */
  entity: WireEntity
}

/**
 * A zeroed RemoteSample, for a caller that holds one per rendered seat across
 * frames. `kart` starts as a neutral placeholder rather than null so the
 * interface has no optional field to check on the hot path; it is meaningless
 * until a `sampleKart` call has returned true.
 */
export function makeRemoteSample(): RemoteSample {
  return {
    position: { x: 0, y: 0, z: 0 },
    heading: 0,
    kart: {
      playerId: 0, position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 },
      heading: 0, angularVelocity: 0, driftCharge: 0, driftActive: false, driftDir: 0,
      airborne: false, surface: 'tarmac', spinOutTicks: 0, invulnTicks: 0, item: 'none',
      lap: 0, checkpointIdx: 0, t: 0, isBot: false, connected: false,
      boostTicks: 0, respawnTicks: 0, shielded: false,
    },
  }
}

/** A zeroed RemoteEntitySample. Same reasoning as makeRemoteSample. */
export function makeRemoteEntitySample(): RemoteEntitySample {
  return {
    position: { x: 0, y: 0, z: 0 },
    heading: 0,
    entity: {
      entityId: -1, kind: 'seeker', ownerId: -1,
      position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, heading: 0, ttl: 0,
    },
  }
}

/** Packed index of `entityId` in `kf`, or -1. Never matches the -1 dead-slot
 * sentinel, and never looks past the live prefix. */
function entitySlotIn(kf: RemoteKeyframe, entityId: number): number {
  if (entityId < 0) return -1
  const n = Math.min(kf.entityCount, kf.entities.length)
  for (let i = 0; i < n; i++) {
    if (kf.entities[i].entityId === entityId) return i
  }
  return -1
}

export class RemoteInterpolator {
  private readonly buffer: RemoteKeyframe[] = []

  push(kf: RemoteKeyframe): void {
    // Out-of-order (jitter-delayed) keyframe: drop, never regress the buffer.
    if (this.buffer.length > 0 && kf.recvAtMs <= this.buffer[this.buffer.length - 1].recvAtMs) return
    this.buffer.push(kf)
    if (this.buffer.length > REMOTE_BUFFER_CAPACITY) this.buffer.shift()
  }

  /**
   * The render sample for one remote seat, written into the caller-owned `out`.
   * Returns false - leaving every field of `out` exactly as it was - when there
   * is nothing to sample, which today means only "no keyframe has arrived yet".
   *
   * `out` is caller-owned and reused across frames for the same reason
   * `liveEntityIds`'s Int32Array is: a renderer calls this every frame, for
   * every seat. See RemoteSample.
   */
  sampleKart(playerId: number, nowMs: number, out: RemoteSample): boolean {
    if (this.buffer.length === 0) return false
    const newest = this.buffer[this.buffer.length - 1]
    const targetMs = nowMs - REMOTE_INTERP_DELAY_MS

    let before: RemoteKeyframe | null = null
    let after: RemoteKeyframe | null = null
    for (const kf of this.buffer) {
      if (kf.recvAtMs <= targetMs) before = kf
      else if (after === null) after = kf
    }

    if (before !== null && after !== null) {
      const span = after.recvAtMs - before.recvAtMs
      const t = span > 0 ? (targetMs - before.recvAtMs) / span : 0
      const a = before.karts[playerId]
      const b = after.karts[playerId]
      out.position.x = a.position.x + (b.position.x - a.position.x) * t
      out.position.y = a.position.y + (b.position.y - a.position.y) * t
      out.position.z = a.position.z + (b.position.z - a.position.z) * t
      out.heading = a.heading + wrapAngle(b.heading - a.heading) * t
      out.kart = newest.karts[playerId]
      return true
    }

    const latest = before !== null ? before : (after as RemoteKeyframe)
    const overMs = Math.min(Math.max(targetMs - latest.recvAtMs, 0), REMOTE_EXTRAPOLATE_CAP_MS)
    const overS = overMs / 1000
    const k = latest.karts[playerId]
    out.position.x = k.position.x + k.velocity.x * overS
    out.position.y = k.position.y + k.velocity.y * overS
    out.position.z = k.position.z + k.velocity.z * overS
    out.heading = k.heading
    out.kart = newest.karts[playerId]
    return true
  }

  /**
   * The same before/after interpolation and the same capped extrapolation
   * sampleKart uses, for one world entity - keyed on `entityId`, NEVER on the
   * packed array index (ruling P2-R43).
   *
   * That distinction is the whole method. Live entities are packed at the front
   * of every snapshot and removed by SWAP-REMOVE (packages/sim/src/entity.ts's
   * despawnEntityAt moves the last live entity down into the freed slot), so
   * `entities[i]` in two consecutive keyframes is frequently two DIFFERENT
   * entities. An index-keyed version of this method compiles, passes any
   * one-entity test, and teleports entities into each other the instant a second
   * one is live.
   *
   * Returns false - leaving `out` untouched - when `entityId` is absent from the
   * newest keyframe: it despawned (or was never seen), and there is nothing left
   * to draw. Present in the newest keyframe but not in any keyframe at or before
   * the render target - a spawn inside the render delay - extrapolates from the
   * newest keyframe that does hold it, under the same cap, which for a target
   * ahead of that keyframe clamps to zero and pops the entity in at its spawn
   * position.
   *
   * Out-parameter form for the same per-frame reason `sampleKart` is one.
   */
  sampleEntity(entityId: number, nowMs: number, out: RemoteEntitySample): boolean {
    if (this.buffer.length === 0) return false
    const newest = this.buffer[this.buffer.length - 1]
    const newestSlot = entitySlotIn(newest, entityId)
    if (newestSlot < 0) return false
    const entity = newest.entities[newestSlot]

    const targetMs = nowMs - REMOTE_INTERP_DELAY_MS
    // Keyframes that do not hold this entity are skipped rather than bracketing
    // it: a lost snapshot simply widens the span, exactly as it does for a kart.
    let before: RemoteKeyframe | null = null
    let beforeSlot = -1
    let after: RemoteKeyframe | null = null
    let afterSlot = -1
    for (const kf of this.buffer) {
      const slot = entitySlotIn(kf, entityId)
      if (slot < 0) continue
      if (kf.recvAtMs <= targetMs) {
        before = kf
        beforeSlot = slot
      } else if (after === null) {
        after = kf
        afterSlot = slot
      }
    }

    if (before !== null && after !== null) {
      const span = after.recvAtMs - before.recvAtMs
      const t = span > 0 ? (targetMs - before.recvAtMs) / span : 0
      const a = before.entities[beforeSlot]
      const b = after.entities[afterSlot]
      out.position.x = a.position.x + (b.position.x - a.position.x) * t
      out.position.y = a.position.y + (b.position.y - a.position.y) * t
      out.position.z = a.position.z + (b.position.z - a.position.z) * t
      out.heading = a.heading + wrapAngle(b.heading - a.heading) * t
      out.entity = entity
      return true
    }

    // At least one of the two is set: `newest` holds the entity, and it is
    // either at or before the target (-> before) or past it (-> after).
    const latest = before !== null ? before : (after as RemoteKeyframe)
    const latestSlot = before !== null ? beforeSlot : afterSlot
    const e = latest.entities[latestSlot]
    const overMs = Math.min(Math.max(targetMs - latest.recvAtMs, 0), REMOTE_EXTRAPOLATE_CAP_MS)
    const overS = overMs / 1000
    out.position.x = e.position.x + e.velocity.x * overS
    out.position.y = e.position.y + e.velocity.y * overS
    out.position.z = e.position.z + e.velocity.z * overS
    out.heading = e.heading
    out.entity = entity
    return true
  }

  /**
   * The ids sampleEntity will answer for, written into the caller-owned `out`
   * (capacity MAX_ENTITIES); returns how many were written.
   *
   * Without this, sampleEntity is unusable: entity ids come from SimState's
   * monotonic `nextEntityId` counter, never appear in any other message a client
   * receives, and cannot be probed - a renderer has no way to guess which
   * numbers are live. `out` is caller-owned and reused across frames for the
   * same reason every other buffer in this package is: a renderer calls this
   * every frame.
   */
  liveEntityIds(out: Int32Array): number {
    if (this.buffer.length === 0) return 0
    const newest = this.buffer[this.buffer.length - 1]
    const n = Math.min(newest.entityCount, newest.entities.length)
    if (out.length < n) {
      throw new Error(`liveEntityIds: out holds ${out.length}, need ${n} (size it at MAX_ENTITIES)`)
    }
    for (let i = 0; i < n; i++) out[i] = newest.entities[i].entityId
    return n
  }
}
