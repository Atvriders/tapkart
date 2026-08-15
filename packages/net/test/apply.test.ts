import { describe, expect, it } from 'vitest'
import type { AuthEvent } from '@tapkart/sim'
import { createState } from '@tapkart/sim'
import { applyEvent } from '../src/apply'
import { makeNetContext } from './fixtures/net-fixtures'

const SEED = 0x1234abcd
const CHARS = [0, 1, 2, 3, 4, 5, 6, 7]

describe('applyEvent — sequencing', () => {
  it('is a no-op the second time the same event is applied', () => {
    const ctx = makeNetContext(false)
    const state = createState(ctx, SEED, CHARS)
    const ev: AuthEvent = {
      eventSeq: 0, tick: 5, kind: 'itemGrant',
      playerId: 2, entityId: -1, item: 'boost', data: 0,
    }

    expect(applyEvent(ctx, state, ev)).toBe(true)
    expect(state.karts[2].item).toBe('boost')
    expect(state.itemBoxes[0].respawnTicks).toBe(ctx.tuning.itemBoxRespawnTicks)
    expect(state.nextEventSeq).toBe(1)

    // Both fields are changed between the two applications, so the second call
    // re-writing EITHER of them would be observable, not just a matching no-op.
    state.karts[2].item = 'seeker'
    state.itemBoxes[0].respawnTicks = 0
    expect(applyEvent(ctx, state, ev)).toBe(false)
    expect(state.karts[2].item).toBe('seeker')       // untouched: the 2nd apply did nothing
    expect(state.itemBoxes[0].respawnTicks).toBe(0)  // and did not re-arm the box either
    expect(state.nextEventSeq).toBe(1)
  })

  it('ignores any eventSeq at or below the highest already applied', () => {
    const ctx = makeNetContext(false)
    const state = createState(ctx, SEED, CHARS)
    const high: AuthEvent = {
      eventSeq: 5, tick: 10, kind: 'itemGrant',
      playerId: 0, entityId: -1, item: 'boost', data: 0,
    }
    const lower: AuthEvent = {
      eventSeq: 2, tick: 4, kind: 'itemGrant',
      playerId: 0, entityId: -1, item: 'seeker', data: 0,
    }
    const sameSeqDifferentEvent: AuthEvent = {
      eventSeq: 5, tick: 10, kind: 'itemGrant',
      playerId: 0, entityId: -1, item: 'bolt', data: 0,
    }

    expect(applyEvent(ctx, state, high)).toBe(true)
    expect(state.nextEventSeq).toBe(6)
    expect(state.karts[0].item).toBe('boost')

    expect(applyEvent(ctx, state, lower)).toBe(false)
    expect(state.nextEventSeq).toBe(6)          // unchanged
    expect(state.karts[0].item).toBe('boost')   // not overwritten by the stale event

    // "at or below": eventSeq 5 equals the highest already applied (5), not
    // just below it, and must also be ignored.
    expect(applyEvent(ctx, state, sameSeqDifferentEvent)).toBe(false)
    expect(state.karts[0].item).toBe('boost')
  })
})

describe('applyEvent — per-kind mutation', () => {
  it('itemGrant sets the kart\'s item AND puts the named box on its respawn timer', () => {
    const ctx = makeNetContext(false)
    const state = createState(ctx, SEED, CHARS)
    // data is the boxIdx (items.ts: emit(..., 'itemGrant', k.playerId, -1, item, box.boxIdx)).
    const ev: AuthEvent = {
      eventSeq: 0, tick: 1, kind: 'itemGrant',
      playerId: 5, entityId: -1, item: 'bubble', data: 3,
    }
    expect(state.itemBoxes.length).toBeGreaterThan(3)  // the oval fixture ships 6 boxes
    expect(state.itemBoxes[3].respawnTicks).toBe(0)
    expect(applyEvent(ctx, state, ev)).toBe(true)
    expect(state.karts[5].item).toBe('bubble')
    expect(state.itemBoxes[3].respawnTicks).toBe(ctx.tuning.itemBoxRespawnTicks)
    // and only that box: a receiver must not blanket-arm the whole track.
    expect(state.itemBoxes[0].respawnTicks).toBe(0)
    expect(state.itemBoxes[4].respawnTicks).toBe(0)
  })

  it('itemGrant with a data value outside the box array still grants the item', () => {
    const ctx = makeNetContext(false)
    const state = createState(ctx, SEED, CHARS)
    const ev: AuthEvent = {
      eventSeq: 0, tick: 1, kind: 'itemGrant',
      playerId: 5, entityId: -1, item: 'bubble', data: 999,
    }
    expect(applyEvent(ctx, state, ev)).toBe(true)
    expect(state.karts[5].item).toBe('bubble')
    for (const box of state.itemBoxes) expect(box.respawnTicks).toBe(0)
  })

  it('hit with data 1 clears the shield', () => {
    const ctx = makeNetContext(false)
    const state = createState(ctx, SEED, CHARS)
    state.karts[4].shielded = true
    const ev: AuthEvent = {
      eventSeq: 0, tick: 1, kind: 'hit',
      playerId: 4, entityId: 9, item: 'seeker', data: 1,
    }
    expect(applyEvent(ctx, state, ev)).toBe(true)
    expect(state.karts[4].shielded).toBe(false)
  })

  it('hit with data 0 changes no kart field beyond sequencing', () => {
    const ctx = makeNetContext(false)
    const state = createState(ctx, SEED, CHARS)
    state.karts[4].shielded = false
    const ev: AuthEvent = {
      eventSeq: 0, tick: 1, kind: 'hit',
      playerId: 4, entityId: 9, item: 'seeker', data: 0,
    }
    expect(applyEvent(ctx, state, ev)).toBe(true)
    expect(state.karts[4].shielded).toBe(false)
    expect(state.nextEventSeq).toBe(1)
  })

  it('spinOut sets the timer and clears drift and boost', () => {
    const ctx = makeNetContext(false)
    const state = createState(ctx, SEED, CHARS)
    state.karts[1].drift.active = true
    state.karts[1].drift.dir = 1
    state.karts[1].drift.charge = 90
    state.karts[1].boostTicks = 10
    const ev: AuthEvent = {
      eventSeq: 0, tick: 1, kind: 'spinOut',
      playerId: 1, entityId: -1, item: 'none', data: 60,
    }
    expect(applyEvent(ctx, state, ev)).toBe(true)
    expect(state.karts[1].spinOutTicks).toBe(60)
    expect(state.karts[1].drift.active).toBe(false)
    expect(state.karts[1].drift.dir).toBe(0)
    expect(state.karts[1].drift.charge).toBe(0)
    expect(state.karts[1].boostTicks).toBe(0)
  })

  it('respawn sets the respawn timer', () => {
    const ctx = makeNetContext(false)
    const state = createState(ctx, SEED, CHARS)
    const ev: AuthEvent = {
      eventSeq: 0, tick: 1, kind: 'respawn',
      playerId: 6, entityId: -1, item: 'none', data: 72,
    }
    expect(applyEvent(ctx, state, ev)).toBe(true)
    expect(state.karts[6].respawnTicks).toBe(72)
  })

  it('lapCross sets the lap count and resets checkpointIdx to 0', () => {
    const ctx = makeNetContext(false)
    const state = createState(ctx, SEED, CHARS)
    state.karts[3].lap.checkpointIdx = 11
    const ev: AuthEvent = {
      eventSeq: 0, tick: 1, kind: 'lapCross',
      playerId: 3, entityId: -1, item: 'none', data: 1,
    }
    expect(applyEvent(ctx, state, ev)).toBe(true)
    expect(state.karts[3].lap.lap).toBe(1)
    expect(state.karts[3].lap.checkpointIdx).toBe(0)
  })

  it('finish for a real kart writes finishedOrder at data-1 and stamps finishTick once', () => {
    const ctx = makeNetContext(false)
    const state = createState(ctx, SEED, CHARS)
    const first: AuthEvent = {
      eventSeq: 0, tick: 200, kind: 'finish',
      playerId: 3, entityId: -1, item: 'none', data: 1,
    }
    expect(applyEvent(ctx, state, first)).toBe(true)
    expect(state.finishedOrder[0]).toBe(3)
    expect(state.finishTick).toBe(200)

    const second: AuthEvent = {
      eventSeq: 1, tick: 250, kind: 'finish',
      playerId: 7, entityId: -1, item: 'none', data: 2,
    }
    expect(applyEvent(ctx, state, second)).toBe(true)
    expect(state.finishedOrder[1]).toBe(7)
    expect(state.finishTick).toBe(200)   // stamped once, at the first finisher's tick
  })

  it('finish with playerId -1 transitions the phase to finished', () => {
    const ctx = makeNetContext(false)
    const state = createState(ctx, SEED, CHARS)
    const sentinel: AuthEvent = {
      eventSeq: 0, tick: 500, kind: 'finish',
      playerId: -1, entityId: -1, item: 'none', data: 8,
    }
    expect(state.phase).toBe('countdown')
    expect(applyEvent(ctx, state, sentinel)).toBe(true)
    expect(state.phase).toBe('finished')
  })

  it('entitySpawn and entityDespawn advance nextEventSeq and touch nothing else', () => {
    const ctx = makeNetContext(false)
    const state = createState(ctx, SEED, CHARS)
    const entityCountBefore = state.entityCount
    const kartsSnapshot = JSON.stringify(state.karts)

    const spawn: AuthEvent = {
      eventSeq: 0, tick: 1, kind: 'entitySpawn',
      playerId: 2, entityId: 5, item: 'seeker', data: 600,
    }
    expect(applyEvent(ctx, state, spawn)).toBe(true)
    expect(state.entityCount).toBe(entityCountBefore)
    expect(state.nextEventSeq).toBe(1)
    expect(JSON.stringify(state.karts)).toBe(kartsSnapshot)

    const despawn: AuthEvent = {
      eventSeq: 1, tick: 30, kind: 'entityDespawn',
      playerId: 2, entityId: 5, item: 'seeker', data: 0,
    }
    expect(applyEvent(ctx, state, despawn)).toBe(true)
    expect(state.entityCount).toBe(entityCountBefore)
    expect(state.nextEventSeq).toBe(2)
  })
})

describe('applyEvent — a realistic multi-tick sequence', () => {
  it('applies six events spanning 190 ticks, threading nextEventSeq call to call', () => {
    const ctx = makeNetContext(false)
    const state = createState(ctx, SEED, CHARS)
    const events: AuthEvent[] = [
      { eventSeq: 0, tick: 10, kind: 'itemGrant', playerId: 3, entityId: -1, item: 'seeker', data: 0 },
      { eventSeq: 1, tick: 40, kind: 'lapCross', playerId: 3, entityId: -1, item: 'none', data: 1 },
      { eventSeq: 2, tick: 90, kind: 'spinOut', playerId: 5, entityId: -1, item: 'none', data: 60 },
      { eventSeq: 3, tick: 91, kind: 'hit', playerId: 5, entityId: 7, item: 'seeker', data: 0 },
      { eventSeq: 4, tick: 150, kind: 'lapCross', playerId: 3, entityId: -1, item: 'none', data: 2 },
      { eventSeq: 5, tick: 200, kind: 'finish', playerId: 3, entityId: -1, item: 'none', data: 1 },
    ]

    for (const ev of events) {
      expect(applyEvent(ctx, state, ev)).toBe(true)
    }

    expect(state.nextEventSeq).toBe(6)
    expect(state.karts[3].item).toBe('seeker')
    expect(state.itemBoxes[0].respawnTicks).toBe(ctx.tuning.itemBoxRespawnTicks)
    expect(state.karts[3].lap.lap).toBe(2)
    expect(state.karts[3].lap.checkpointIdx).toBe(0)
    expect(state.karts[5].spinOutTicks).toBe(60)
    expect(state.finishedOrder[0]).toBe(3)
    expect(state.finishTick).toBe(200)

    // Replaying the exact same six events again — as would happen if the
    // reliable channel redelivered a batch the peer had already applied — must
    // change nothing, in one pass, in order. Every field the six events wrote
    // is scrambled first, so a re-application is observable on every one of
    // them rather than being hidden by an identical rewrite.
    state.karts[3].item = 'none'
    state.itemBoxes[0].respawnTicks = 0
    state.karts[3].lap.lap = 9
    state.karts[5].spinOutTicks = 0
    state.finishedOrder[0] = -1
    for (const ev of events) {
      expect(applyEvent(ctx, state, ev)).toBe(false)
    }
    expect(state.nextEventSeq).toBe(6)
    expect(state.karts[3].item).toBe('none')
    expect(state.itemBoxes[0].respawnTicks).toBe(0)
    expect(state.karts[3].lap.lap).toBe(9)
    expect(state.karts[5].spinOutTicks).toBe(0)
    expect(state.finishedOrder[0]).toBe(-1)
  })
})
