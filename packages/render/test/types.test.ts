import { describe, expect, it } from 'vitest'

import { createRaceView, viewSourceViolations } from '../src/types'
import type { RaceView, ViewSource } from '../src/types'

/** A view whose every seat and slot is filled the way the given role must fill it. */
function legalView(role: 'host' | 'guest' | 'solo', localPlayerId: number): RaceView {
  const v = createRaceView(4)
  v.localPlayerId = localPlayerId
  for (let i = 0; i < 8; i++) {
    v.karts[i].source =
      role === 'guest' ? (i === localPlayerId ? 'predicted' : 'interpolated') : 'authoritative'
  }
  v.entityCount = 2
  for (let j = 0; j < 32; j++) {
    if (j < v.entityCount) {
      v.entities[j].entityId = 100 + j
      v.entities[j].source = role === 'guest' ? 'interpolated' : 'authoritative'
    }
  }
  return v
}

describe('createRaceView', () => {
  it('allocates every array at its fixed length', () => {
    const v = createRaceView(16)
    expect(v.karts.length).toBe(8)
    expect(v.entities.length).toBe(32)
    expect(v.itemBoxes.length).toBe(16)
    expect(v.finishedOrder.length).toBe(8)
    expect(v.finishedOrder.every((x) => x === -1)).toBe(true)
    expect(v.finishTick).toBe(-1)
    expect(v.localPlayerId).toBe(-1)
  })

  it('indexes karts BY SEAT: karts[i].playerId === i', () => {
    const v = createRaceView(4)
    for (let i = 0; i < 8; i++) expect(v.karts[i].playerId).toBe(i)
  })

  it('numbers item boxes by index and starts every entity slot empty', () => {
    const v = createRaceView(3)
    for (let b = 0; b < 3; b++) expect(v.itemBoxes[b].boxIdx).toBe(b)
    for (let j = 0; j < 32; j++) {
      expect(v.entities[j].entityId).toBe(-1)
      expect(v.entities[j].source).toBe('absent')
    }
    expect(v.entityCount).toBe(0)
  })

  // The bug: `new Array(MAX_KARTS).fill(template)` or one shared ZERO Vec3. Every kart
  // then draws at whatever the last writer wrote — all eight stacked on one point — and
  // a length-only test passes happily. Mutating one and reading the others is the only
  // assertion that sees it.
  //
  // Four writes go in, to four different Vec3 fields across three different arrays; then
  // every one of them is read back AND every neighbour is read as still-zero. The
  // read-backs are what close cross-family aliasing (a kart position that IS an item-box
  // position, an entity position that IS its own velocity): without them a shared object
  // between two of the four writes is invisible, because the last write wins and the
  // zero-checks on the *other* indices still hold.
  it('gives every Vec3 its own object', () => {
    const v = createRaceView(2)
    v.karts[0].position.x = 5
    v.karts[0].velocity.z = -3
    v.entities[0].position.y = 9
    v.itemBoxes[0].position.x = 7

    // each write survives every other write: no two of these four are the same object
    expect(v.karts[0].position.x).toBe(5)
    expect(v.karts[0].velocity.z).toBe(-3)
    expect(v.entities[0].position.y).toBe(9)
    expect(v.itemBoxes[0].position.x).toBe(7)

    // and nothing leaked sideways
    expect(v.karts[1].position.x).toBe(0)
    expect(v.karts[0].velocity.x).toBe(0)
    expect(v.karts[0].position.z).toBe(0)
    expect(v.karts[1].velocity.z).toBe(0)
    expect(v.entities[1].position.y).toBe(0)
    expect(v.entities[0].velocity.y).toBe(0)
    expect(v.entities[1].velocity.y).toBe(0)
    expect(v.itemBoxes[1].position.x).toBe(0)
  })

  // A fresh view is deliberately unfilled: 'absent' sources and place 0. If the default
  // were a plausible-looking 'authoritative' with place = i, a ViewBuilder that forgot to
  // write a seat would look correct in every downstream test.
  it('defaults to unfilled values, so a missing write is visible', () => {
    const v = createRaceView(1)
    expect(v.karts.every((k) => k.source === 'absent')).toBe(true)
    expect(v.karts.every((k) => k.place === 0)).toBe(true)
    expect(v.karts[0].driftTier).toBe(-1)
    expect(v.karts[0].item).toBe('none')
    expect(v.karts[0].surface).toBe('tarmac')
    expect(v.phase).toBe('countdown')
  })
})

describe('viewSourceViolations', () => {
  it('returns [] for a legal host, solo and guest view', () => {
    expect(viewSourceViolations(legalView('host', -1), 'host')).toEqual([])
    expect(viewSourceViolations(legalView('solo', -1), 'solo')).toEqual([])
    expect(viewSourceViolations(legalView('guest', 3), 'guest')).toEqual([])
  })

  // A checker that returns [] unconditionally passes every test above. This one it
  // cannot pass: a freshly allocated view is all-'absent', which is legal for nobody
  // as a KART source under host.
  it('reports all eight seats of an unfilled view under host', () => {
    const v = createRaceView(2)
    const errs = viewSourceViolations(v, 'host')
    expect(errs.length).toBe(8)
    expect(errs[0]).toBe(
      "kart[0]: source 'absent' is illegal for role 'host' (expected 'authoritative')",
    )
  })

  // THE central invariant (contract §7.1). A guest drawing a remote seat from state()
  // is drawing the sim's own bot AI for that seat — the karts visibly drive themselves
  // down a line no other player is on. This is the exact message that catches it.
  it('flags a guest drawing a REMOTE seat from prediction', () => {
    const v = legalView('guest', 3)
    v.karts[5].source = 'predicted'
    expect(viewSourceViolations(v, 'guest')).toEqual([
      "kart[5]: source 'predicted' is illegal for role 'guest' (expected 'interpolated' or 'absent')",
    ])
  })

  it('flags a guest drawing its OWN seat from the interpolator', () => {
    const v = legalView('guest', 3)
    v.karts[3].source = 'interpolated'
    expect(viewSourceViolations(v, 'guest')).toEqual([
      "kart[3]: source 'interpolated' is illegal for role 'guest' (expected 'predicted')",
    ])
  })

  it('allows an absent remote seat on a guest, and only there', () => {
    const guest = legalView('guest', 3)
    guest.karts[6].source = 'absent'
    expect(viewSourceViolations(guest, 'guest')).toEqual([])
    const host = legalView('host', -1)
    host.karts[6].source = 'absent'
    expect(viewSourceViolations(host, 'host')).toEqual([
      "kart[6]: source 'absent' is illegal for role 'host' (expected 'authoritative')",
    ])
  })

  it('reports an illegal guest localPlayerId and returns immediately', () => {
    const v = legalView('guest', 3)
    v.localPlayerId = -1
    // every seat is now wrong too, but no per-seat check is meaningful without a seat
    expect(viewSourceViolations(v, 'guest')).toEqual([
      "localPlayerId -1 is illegal for role 'guest'",
    ])
    v.localPlayerId = 8
    expect(viewSourceViolations(v, 'guest')).toEqual([
      "localPlayerId 8 is illegal for role 'guest'",
    ])
  })

  it('does not police localPlayerId on host or solo', () => {
    expect(viewSourceViolations(legalView('host', -1), 'host')).toEqual([])
    expect(viewSourceViolations(legalView('solo', -1), 'solo')).toEqual([])
    // -1 is also the legal host/solo default, so the two lines above are equally happy
    // with a guard keyed on the VALUE instead of on the role. These two are not: 99 and
    // -7 are out of range for any seat, and must still be unpoliced off a guest.
    const host = legalView('host', -1)
    host.localPlayerId = 99
    expect(viewSourceViolations(host, 'host')).toEqual([])
    const solo = legalView('solo', -1)
    solo.localPlayerId = -7
    expect(viewSourceViolations(solo, 'solo')).toEqual([])
  })

  it('flags a live entity slot with the wrong source', () => {
    const v = legalView('host', -1)
    v.entities[1].source = 'interpolated' as ViewSource
    expect(viewSourceViolations(v, 'host')).toEqual([
      "entity[1] (id 101): source 'interpolated' is illegal for role 'host' (expected 'authoritative')",
    ])
  })

  // Entities are removed by swap-remove, so a stale id left behind at a dead slot is the
  // realistic failure: the renderer draws a despawned shell forever. Both messages, in
  // this order.
  it('flags a dead slot that still carries an entityId, source message first', () => {
    const v = legalView('host', -1)
    v.entities[7].entityId = 42
    v.entities[7].source = 'authoritative'
    expect(viewSourceViolations(v, 'host')).toEqual([
      "entity[7] (id 42): source 'authoritative' is illegal for role 'host' (expected 'absent')",
      'entity[7]: entityId 42 is illegal at slot 7 with entityCount 2',
    ])
  })

  it('flags a live slot with no entityId', () => {
    const v = legalView('guest', 3)
    v.entities[0].entityId = -1
    expect(viewSourceViolations(v, 'guest')).toEqual([
      'entity[0]: entityId -1 is illegal at slot 0 with entityCount 2',
    ])
  })
})
