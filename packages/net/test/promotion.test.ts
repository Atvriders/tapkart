// Spec §8, the promotion row: "kill the host mid-race, assert the shadow's state matches the host's
// last checkpoint within bounds, no lap counter regresses, no entity disappears, and no event is
// applied twice."
//
// Task 16's shadow.test.ts asserts those four clauses between a real AuthorityLoop and a real
// ShadowLoop on one loopback pair. This file adds the third party the deployed topology actually
// has: a real ClientLoop, on its own links to both authorities, that must survive the handover -
// keep receiving snapshots, keep its tick baseline, never be handed an event twice, and end up on
// the new authority's world. Spec §5's promotion paragraph is about what the CLIENTS experience
// ("no kart teleports backward, no lap counter rewinds, no in-flight projectile vanishes"), and
// until this file nothing measured that from a client.
import { describe, expect, it } from 'vitest'

import type { AuthEvent, SimState } from '@tapkart/sim'
import { MAX_KARTS, allocStateLike, cloneState, createState } from '@tapkart/sim'
import { decodeEvents, decodeHeader } from '@tapkart/protocol'

import { AuthorityLoop, isDemoted } from '../src/authority'
import { ClientLoop } from '../src/client'
import { HOST_TIMEOUT_MS, SNAPSHOT_PERIOD_TICKS, ShadowLoop, decodeAuthorityChange } from '../src/shadow'
import { TICK_MS } from '../src/clock'
import { droppedDatagramsOf } from '../src/receive'
import { makeNetContext } from './fixtures/net-fixtures'
import { makeThreeWayMesh } from './fixtures/mesh'
import { spyTransport } from './fixtures/spy-transport'
import { broadcastScriptedInput, scriptedIntent } from './fixtures/scripted-input'

const SEED = 0x20260814
const CHARS8 = [0, 0, 0, 0, 0, 0, 0, 0]
/** The seat the real ClientLoop drives. */
const OWN = 0
/**
 * A second human seat, played by the test itself rather than by a second ClientLoop: its datagrams
 * are encoded by `broadcastScriptedInput` and put on the guest's own two links, so they reach the
 * host and the shadow over independently lossy paths (spec §5's dual send).
 *
 * It is here to make the shadow's correction path load-bearing. Without a second seat whose input
 * arrives at the two authorities on two different schedules, both authorities run the identical
 * deterministic bot sim from the identical seed for seats 1-7 and agree to a centimetre whether or
 * not a single snapshot is ever delivered - which would leave clause 1's bound with nothing to
 * measure.
 */
const THIN = 1

/**
 * 15s of racing before the host dies: long enough for real item grants and several laps on every
 * seat, so the unconditional event, lap and movement floors below are not empty claims.
 *
 * An earlier version of this comment justified the number with "well past the tick this fixture's
 * leader first emits on (227)". That figure is not reproducible and was never measured on this
 * fixture: instrumented directly, this run's host emits its first event on tick **58**. The kill
 * tick does not rest on it - 900 earns its place through the floors, not through a margin over a
 * first-emit tick - so the number is corrected rather than re-derived, and quoted here only because
 * a wrong measurement left in a comment is one a future reader trusts.
 */
const PRE_KILL_TICKS = 900
/** 5s of silence: promotion happens ~1.5s in, and the run continues for 3s afterwards so the
 *  promoted authority has to hold the room together rather than merely announce itself. */
const POST_KILL_TICKS = 300

/**
 * The 1.5s timeout in ticks, DERIVED from the milliseconds the loop actually uses (Task 15c item C)
 * rather than hardcoded: the two agree only while the scheduler is healthy, and a test that pinned
 * 90 would go on passing after the loop stopped promoting at 1.5s of wall time.
 */
const HOST_TIMEOUT_TICKS = Math.ceil(HOST_TIMEOUT_MS / TICK_MS)

/**
 * "Matches within bounds" is a metre-scale claim, not an epsilon-scale one. The shadow's state at
 * tick T is the host's state at T minus one one-way trip, corrected and replayed forward with input
 * that arrived on a different schedule; contract §4's 0.05 m epsilon describes the comparison the
 * RECONCILER makes at snap.tick. Measured here: 0.005 m at kart 0, and 5.86 m for a shadow whose
 * snapshot handling is removed (verified by mutation). 5 m is far tighter than
 * the ~30 m a kart covers in the second before the kill (so a shadow that stopped tracking fails -
 * Task 16 measured 14.3 m for one that never reconciles) and far looser than any legitimate
 * scheduling residue.
 */
const MATCH_BAND_M = 5

/**
 * A live entity that cannot legitimately disappear, seeded identically into both authorities.
 *
 * Spec §8 asks for "no entity disappears", and the only entity whose disappearance is unambiguously
 * a bug is one that can neither expire nor be struck: a `slick` sits still and only its ttl moves
 * (entity.ts's stepEntity default branch), a ttl far longer than the run can never reach zero, and
 * at (500, 0, 500) it is hundreds of metres outside the oval, so its 2.1 m strike radius can never
 * fire. Items the bots pick up spawn and despawn other entities legitimately during this run; those
 * are NOT watched, precisely because a seeker that hits a kart is supposed to vanish.
 *
 * Written straight into the pool rather than through spawnEntity(), which emits an 'entitySpawn' -
 * gated on ctx.isLeader after Task 2, so seeding the leader and the follower through it would leave
 * them with different nextEventSeq before the race even started.
 */
const WATCHED_ID = 4242
const WATCHED_TTL = 60_000

function seedWatchedEntity(state: SimState): void {
  const e = state.entities[state.entityCount]
  e.entityId = WATCHED_ID
  e.kind = 'slick'
  e.ownerId = 0
  e.position.x = 500
  e.position.y = 0
  e.position.z = 500
  e.velocity.x = 0
  e.velocity.y = 0
  e.velocity.z = 0
  e.heading = 0
  e.targetId = -1
  e.ttl = WATCHED_TTL
  state.entityCount += 1
  state.nextEntityId = Math.max(state.nextEntityId, WATCHED_ID + 1)
}

/**
 * Spec §8's clauses, evaluated on one consecutive pair of a peer's states. Returns the violations by
 * name; an empty array is the pass. `watchedId < 0` means "this peer has no watched entity", which
 * is how the guest (whose own local pool never held one) is run through the same checker.
 *
 * Deliberately not `statesEqual`: promotion re-seeds rngCursor through promotionCursor, so
 * whole-state equality with the host is falsified BY DESIGN - spec §5 calls the resulting divergence
 * in post-promotion item rolls "accepted".
 */
function promotionViolations(prev: SimState, next: SimState, watchedId: number): string[] {
  const v: string[] = []
  if (next.tick !== prev.tick + 1) v.push(`tick went ${prev.tick} -> ${next.tick}, expected +1`)
  for (let i = 0; i < MAX_KARTS; i++) {
    if (next.karts[i].lap.lap < prev.karts[i].lap.lap) {
      v.push(`lap regressed for kart ${i}: ${prev.karts[i].lap.lap} -> ${next.karts[i].lap.lap}`)
    }
  }
  if (watchedId >= 0) {
    const find = (s: SimState): { ttl: number } | undefined =>
      s.entities.slice(0, s.entityCount).find((e) => e.entityId === watchedId)
    const before = find(prev)
    const after = find(next)
    if (before !== undefined && after === undefined) v.push(`entity ${watchedId} disappeared`)
    if (before !== undefined && after !== undefined && after.ttl !== before.ttl - 1) {
      v.push(`entity ${watchedId} ttl went ${before.ttl} -> ${after.ttl}, expected -1`)
    }
  }
  return v
}

function makeRaceState(ctx: ReturnType<typeof makeNetContext>): SimState {
  const s = createState(ctx, SEED, CHARS8)
  // Already racing, and never crossing the start line: a countdown would freeze every kart for the
  // first 180 ticks, and the phase-adoption path across that boundary has an open defect against
  // Task 15c whose fix would move anything measured across it.
  s.phase = 'racing'
  for (const seat of [OWN, THIN]) {
    s.karts[seat].isBot = false
    s.karts[seat].connected = true
  }
  // Nonzero: "lap >= 0" cannot fail, "lap never goes below the highest seen" can.
  for (const k of s.karts) k.lap.lap = 1
  seedWatchedEntity(s)
  return s
}

interface PromotionRun {
  hostAtKill: SimState
  shadowAtKill: SimState
  shadowFinal: SimState
  clientFinal: SimState
  violations: string[]
  authorityChanges: { tick: number; eventSeq: number }[]
  hostSeqAtKill: number
  shadowSeqAfterDrain: number
  shadowSeqFinal: number
  clientEventSeqs: number[]
  clientEventSeqFinal: number
  eventDatagramsToShadow: number
  snapshotsToClientBeforeKill: number
  snapshotsToClientAfterKill: number
  snapshotsToShadow: number
  hostDemoted: boolean
  shadowIsLeader: boolean
  dropped: number[]
  /** Metres each kart covered in the second before the kill, on the authority. */
  movedInLastSecond: number[]
  /** The tick the "second before the kill" baseline was actually taken on. */
  movementBaselineTick: number
}

/** One host-lives / host-dies / shadow-promotes run over a real three-party mesh. */
function runPromotion(): PromotionRun {
  const hostCtx = makeNetContext(true)
  const clientCtx = makeNetContext(false)
  const shadowCtx = makeNetContext(false)
  const hostState = makeRaceState(hostCtx)
  const shadowState = makeRaceState(shadowCtx)

  const mesh = makeThreeWayMesh()

  // The authorityChange is observed on the HOST's side: the shadow broadcasts it through its own
  // transport, and no transport loops a broadcast back to its sender, so a spy on the shadow's own
  // receive path would never see the message it sends.
  const authorityChanges: { tick: number; eventSeq: number }[] = []
  const hostTransport = spyTransport(mesh.host, (_peerId, channel, data) => {
    if (channel === 'reliable' && decodeHeader(data).kind === 'authorityChange') {
      authorityChanges.push(decodeAuthorityChange(data))
    }
  })

  // Every event the GUEST was handed, in arrival order, decoded from the bytes that actually crossed
  // the wire. This is the ledger behind "no event is applied twice", read from the peer that has to
  // apply them.
  const clientEventSeqs: number[] = []
  let snapshotsToClient = 0
  const clientTransport = spyTransport(mesh.client, (_peerId, channel, data) => {
    const kind = decodeHeader(data).kind
    if (channel === 'unreliable' && kind === 'snapshot') snapshotsToClient++
    if (channel !== 'reliable' || kind !== 'events') return
    const out: AuthEvent[] = []
    decodeEvents(data.subarray(2), out)
    for (const ev of out) clientEventSeqs.push(ev.eventSeq)
  })

  let eventDatagramsToShadow = 0
  let snapshotsToShadow = 0
  const shadowTransport = spyTransport(mesh.shadow, (_peerId, channel, data) => {
    const kind = decodeHeader(data).kind
    if (channel === 'unreliable' && kind === 'snapshot') snapshotsToShadow++
    if (channel === 'reliable' && kind === 'events') eventDatagramsToShadow++
  })

  const host = new AuthorityLoop(hostCtx, hostState, hostTransport)
  const client = new ClientLoop(clientCtx, OWN, clientTransport)
  const shadow = new ShadowLoop(shadowCtx, shadowState, shadowTransport)

  const violations: string[] = []
  const shadowPrev = allocStateLike(shadowCtx, shadowState)
  const clientPrev = allocStateLike(clientCtx, client.state())
  const check = (label: string): void => {
    for (const v of promotionViolations(shadowPrev, shadowState, WATCHED_ID)) {
      violations.push(`shadow ${label}: ${v}`)
    }
    // The guest is run through the same checker, minus the watched entity its own pool never held.
    // Its tick advancing by exactly one is spec §5's "clients keep their existing tick baseline":
    // a handover that made the guest hard-resync onto a rebuilt timeline shows up here.
    for (const v of promotionViolations(clientPrev, client.state(), -1)) {
      violations.push(`guest ${label}: ${v}`)
    }
    cloneState(shadowState, shadowPrev)
    cloneState(client.state(), clientPrev)
  }

  let nowMs = 0
  const hostASecondBeforeTheKill = allocStateLike(hostCtx, hostState)
  for (let t = 0; t < PRE_KILL_TICKS; t++) {
    // 30Hz, the same cadence a ClientLoop sends at.
    if (t % 2 === 0) broadcastScriptedInput(mesh.client, THIN, t)
    host.tick()
    client.tick(scriptedIntent(t, OWN))
    shadow.tick(nowMs)
    mesh.pump(nowMs)
    nowMs += TICK_MS
    check(`pre-kill tick ${t}`)
    if (hostState.tick === PRE_KILL_TICKS - 60) cloneState(hostState, hostASecondBeforeTheKill)
  }

  const hostAtKill = allocStateLike(hostCtx, hostState)
  const shadowAtKill = allocStateLike(shadowCtx, shadowState)
  const hostSeqAtKill = hostState.nextEventSeq
  const snapshotsToClientBeforeKill = snapshotsToClient
  const movedInLastSecond: number[] = []
  for (let i = 0; i < MAX_KARTS; i++) {
    const now = hostAtKill.karts[i].position
    const then = hostASecondBeforeTheKill.karts[i].position
    movedInLastSecond.push(Math.hypot(now.x - then.x, now.z - then.z))
  }

  // THE HOST DIES: it is simply never ticked again, which is the whole of it - an AuthorityLoop
  // broadcasts only from inside tick(). Whatever it put on the wire in its last 150ms is still in
  // flight and still gets delivered, which is exactly the "events still in flight when it died" case.
  // Its transport is deliberately NOT closed: close()'s effect on an in-flight queue is Task 12's
  // business and this test does not need to depend on it.
  let shadowSeqAfterDrain = -1
  for (let t = 0; t < POST_KILL_TICKS; t++) {
    // The clients have no idea the host is gone and keep sending.
    if (t % 2 === 0) broadcastScriptedInput(mesh.client, THIN, PRE_KILL_TICKS + t)
    client.tick(scriptedIntent(PRE_KILL_TICKS + t, OWN))
    shadow.tick(nowMs)
    mesh.pump(nowMs)
    nowMs += TICK_MS
    check(`post-kill tick ${t}`)
    // Long enough after the kill for the last in-flight datagram to have landed (200ms worst case =
    // 12 ticks), and long before promotion at ~90.
    if (t === 30) shadowSeqAfterDrain = shadowState.nextEventSeq
  }

  return {
    hostAtKill,
    shadowAtKill,
    shadowFinal: shadowState,
    clientFinal: client.state(),
    violations,
    authorityChanges,
    hostSeqAtKill,
    shadowSeqAfterDrain,
    shadowSeqFinal: shadowState.nextEventSeq,
    clientEventSeqs,
    clientEventSeqFinal: client.state().nextEventSeq,
    eventDatagramsToShadow,
    snapshotsToClientBeforeKill,
    snapshotsToClientAfterKill: snapshotsToClient - snapshotsToClientBeforeKill,
    snapshotsToShadow,
    hostDemoted: isDemoted(host),
    shadowIsLeader: shadowCtx.isLeader,
    dropped: [droppedDatagramsOf(host), droppedDatagramsOf(client), droppedDatagramsOf(shadow)],
    movedInLastSecond,
    movementBaselineTick: hostASecondBeforeTheKill.tick,
  }
}

describe('promotion over a three-party mesh (spec §5, §8)', () => {
  it(
    'kills the host mid-race and satisfies every clause, with the guest still being served afterwards',
    () => {
      const r = runPromotion()

      // --- the race really was in motion when the host died ------------------
      // Every clause below is about things NOT going backwards, and a world that was standing still
      // satisfies all of them for free.
      expect(r.hostAtKill.tick).toBe(PRE_KILL_TICKS)
      expect(r.shadowAtKill.tick).toBe(PRE_KILL_TICKS)
      expect(r.hostAtKill.phase).toBe('racing')
      // The world was in motion, measured as ground covered in the second before the kill rather
      // than as instantaneous speed: a kart that has just been shelled is legitimately stationary,
      // and a floor that forbade that would be asserting the race never uses its items.
      // The baseline really is one second back. Without this the distances below would be measured
      // from the starting grid if the capture ever stopped firing - a floor that silently got easier.
      expect(r.movementBaselineTick).toBe(PRE_KILL_TICKS - 60)
      const movedTotal = r.movedInLastSecond.reduce((a, b) => a + b, 0)
      expect(
        movedTotal,
        `the field covered ${movedTotal.toFixed(1)}m in the second before the kill: [${r.movedInLastSecond.map((m) => m.toFixed(1)).join(', ')}]`,
      ).toBeGreaterThan(100)
      expect(r.movedInLastSecond[OWN], 'the guest\'s own kart was parked').toBeGreaterThan(10)
      for (let i = 0; i < MAX_KARTS; i++) {
        expect(r.hostAtKill.karts[i].lap.lap, `kart ${i} had not lapped by the kill`).toBeGreaterThan(1)
      }
      // The event stream flowed. Measured on this fixture: the host's first event lands on tick 58
      // (not the 227 an earlier draft of this comment claimed - see PRE_KILL_TICKS), and 20 events
      // have been emitted by tick 900. The kill is at 900 rather than the 300 an earlier draft used
      // so that this floor, the lap floor and the movement floor are all unconditionally reachable.
      expect(r.hostSeqAtKill, 'no events had flowed by the moment of death').toBeGreaterThan(5)
      expect(r.eventDatagramsToShadow).toBeGreaterThan(5)
      expect(r.snapshotsToShadow, 'the shadow never heard from the host').toBeGreaterThan(200)
      expect(r.snapshotsToClientBeforeKill, 'the guest never heard from the host').toBeGreaterThan(200)
      expect(r.dropped).toEqual([0, 0, 0])

      // --- clauses 2 and 3, every tick: no lap regresses, no entity disappears
      // The checker also runs on the guest, so "no kart teleports backward" is measured where spec
      // §5 makes the promise - at a client.
      expect(r.violations).toEqual([])
      const stillLive = r.shadowFinal.entities
        .slice(0, r.shadowFinal.entityCount)
        .map((e) => e.entityId)
      expect(stillLive).toContain(WATCHED_ID)

      // --- promotion happened, exactly once ----------------------------------
      expect(r.authorityChanges).toHaveLength(1)
      expect(r.shadowIsLeader, 'the shadow never actually switched to leader mode').toBe(true)
      // The 1.5s timer runs from the last snapshot RECEIVED, not from the tick the host stopped
      // sending: its final ~200ms of broadcasts were still in flight and still arrived. So the
      // promotion tick is PRE_KILL + 90 plus that tail, bounded by the worst-case one-way transit
      // (150ms latency + 50ms jitter = 12 ticks) plus one snapshot period. Measured: 1002 = 900 + 102.
      const delay = r.authorityChanges[0].tick - PRE_KILL_TICKS
      expect(delay).toBeGreaterThanOrEqual(HOST_TIMEOUT_TICKS)
      expect(delay).toBeLessThanOrEqual(HOST_TIMEOUT_TICKS + 12 + SNAPSHOT_PERIOD_TICKS)
      // Authority never returns to the original host (Task 15c item B), asserted end to end rather
      // than in isolation: the announcement really reached the old host and it really stood down, so
      // the room has exactly one authority at every instant.
      expect(r.hostDemoted, 'the dead host never received the stand-down').toBe(true)

      // --- clause 1: matches the host's last state within bounds -------------
      expect(r.shadowAtKill.tick).toBe(r.hostAtKill.tick)
      for (let k = 0; k < MAX_KARTS; k++) {
        const s = r.shadowAtKill.karts[k]
        const h = r.hostAtKill.karts[k]
        const d = Math.hypot(s.position.x - h.position.x, s.position.z - h.position.z)
        expect(d, `kart ${k} was ${d.toFixed(3)}m from the host's last state`).toBeLessThan(MATCH_BAND_M)
        expect(s.lap.lap, `kart ${k} lap`).toBe(h.lap.lap)
      }
      expect(r.shadowAtKill.entityCount).toBe(r.hostAtKill.entityCount)

      // --- clause 4: no event is DELIVERED twice, and the counters agree -----
      //
      // Deliberately not titled "no event is applied twice", which is what it used to claim and
      // cannot prove. A loopback never redelivers a datagram, and `applyEvent` advances a follower's
      // counter to `ev.eventSeq + 1` by assignment - so applying the same event twice leaves
      // `nextEventSeq` at exactly the value below and every assertion here still passes. What this
      // block does prove is that the wire carried each eventSeq to the guest exactly once, in
      // ascending order, and that the two authorities' counters agree across the handover.
      //
      // IDEMPOTENCE itself is covered, just not here: `apply.ts`'s `ev.eventSeq < state.nextEventSeq`
      // guard is what enforces it, and deleting that one line fails exactly 5 tests - three in
      // `apply.test.ts` ("applyEvent — sequencing", "— a realistic multi-tick sequence") and two in
      // `shadow.test.ts` ("no event is applied twice across the handover"), measured. This test is
      // about the handover, not about the guard.
      //
      // The follower's counter is bit-identical to the dead host's once the last in-flight datagram
      // has drained: every event delivered, none skipped. Anything else and these two numbers differ.
      expect(r.shadowSeqAfterDrain).toBe(r.hostSeqAtKill)
      // ...and the promoted authority numbers its own events from there, so nothing it assigns can
      // collide with a sequence the host already spent (spec §5: "continues eventSeq from the highest
      // it observed").
      expect(r.authorityChanges[0].eventSeq).toBe(r.hostSeqAtKill)
      expect(r.shadowSeqFinal).toBeGreaterThanOrEqual(r.authorityChanges[0].eventSeq)
      // The guest's own ledger: every event it was handed across the handover, in arrival order.
      expect(r.clientEventSeqs.length, 'no events reached the guest at all').toBeGreaterThan(5)
      expect(
        new Set(r.clientEventSeqs).size,
        `the guest was handed an eventSeq twice: [${r.clientEventSeqs.join(', ')}]`,
      ).toBe(r.clientEventSeqs.length)
      for (let i = 1; i < r.clientEventSeqs.length; i++) {
        expect(r.clientEventSeqs[i]).toBeGreaterThan(r.clientEventSeqs[i - 1])
      }
      // applyEvent advances a follower's counter to ev.eventSeq + 1 and is the ONLY thing that does,
      // so this equality says the guest applied the newest event it was handed and no phantom beyond
      // it.
      expect(r.clientEventSeqFinal).toBe(r.clientEventSeqs[r.clientEventSeqs.length - 1] + 1)

      // --- the guest survived the handover -----------------------------------
      // The new authority is serving it: snapshots keep arriving after the old one went silent.
      // 66 broadcasts between promotion at tick 1002 and the end at 1200, thinned by 5% loss:
      // measured 63. A floor of 30 is far below that and far above the 3 that arrive when the
      // promoted shadow is silenced (verified by mutation) - those three are the dead host's last
      // frames, still in flight when it stopped.
      expect(
        r.snapshotsToClientAfterKill,
        'the guest stopped being served: the promoted shadow is not broadcasting to it',
      ).toBeGreaterThan(30)
      expect(r.clientFinal.tick).toBe(PRE_KILL_TICKS + POST_KILL_TICKS)
      expect(r.shadowFinal.tick).toBe(PRE_KILL_TICKS + POST_KILL_TICKS)
      // And it is on the new authority's world, not on one of its own.
      const mine = r.clientFinal.karts[OWN]
      const theirs = r.shadowFinal.karts[OWN]
      expect(Math.hypot(mine.position.x - theirs.position.x, mine.position.z - theirs.position.z)).toBeLessThan(MATCH_BAND_M)
      expect(mine.lap.lap).toBe(theirs.lap.lap)
    },
    60_000,
  )

  it('the clause checker fails against a shadow that froze and one that restarted from scratch', () => {
    // The checker above is only worth anything if it can fail. A shadow that did nothing at all
    // still trivially satisfies "no lap regresses" and "no entity disappears" when those are read off
    // a state that never moved, and a shadow that rebuilt itself from createState() satisfies them
    // too if nothing nonzero was ever seeded. Both impostors go through the SAME function the run
    // above uses, so weakening it breaks this test.
    const ctx = makeNetContext(false)
    const live = makeRaceState(ctx)
    live.tick = PRE_KILL_TICKS
    for (const k of live.karts) k.lap.lap = 2

    // Impostor 1: frozen. Its state at tick N+1 is its state at tick N.
    const frozen = allocStateLike(ctx, live)
    const frozenViolations = promotionViolations(live, frozen, WATCHED_ID)
    expect(frozenViolations).toContain(`tick went ${PRE_KILL_TICKS} -> ${PRE_KILL_TICKS}, expected +1`)
    expect(frozenViolations).toContain(`entity ${WATCHED_ID} ttl went ${WATCHED_TTL} -> ${WATCHED_TTL}, expected -1`)

    // Impostor 2: restarted from scratch at promotion - a plausible implementation of "become the
    // authority" that throws the race away.
    const scratch = createState(ctx, SEED, CHARS8)
    const scratchViolations = promotionViolations(live, scratch, WATCHED_ID)
    expect(scratchViolations).toContain(`tick went ${PRE_KILL_TICKS} -> 0, expected +1`)
    expect(scratchViolations).toContain('lap regressed for kart 0: 2 -> 0')
    expect(scratchViolations).toContain(`entity ${WATCHED_ID} disappeared`)

    // And the real thing, one honest tick, passes the same checker.
    const before = allocStateLike(ctx, live)
    const shadow = new ShadowLoop(ctx, live, {
      send() {}, broadcast() {}, onMessage() {}, onPeerLost() {}, peers: () => [], close() {},
    })
    shadow.tick(0)
    expect(promotionViolations(before, live, WATCHED_ID)).toEqual([])
  })
})
