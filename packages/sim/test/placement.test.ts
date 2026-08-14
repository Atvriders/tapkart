import { describe, it, expect } from 'vitest'
import type { EntityState, KartState, SimState } from '../src/types'
import { MAX_ENTITIES, MAX_KARTS } from '../src/types'
import { computePlacement, placementOrder } from '../src/placement'

// checkpointIdx 0 here is arbitrary: placement never consults a track, only the
// stored (lap, checkpointIdx, t) triple, and every test below overwrites it.
function blankKart(playerId: number): KartState {
  return {
    playerId,
    characterIdx: 0,
    isBot: false,
    connected: true,
    position: { x: 0, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    heading: 0,
    angularVelocity: 0,
    drift: { active: false, dir: 0, charge: 0 },
    item: 'none',
    airborne: false,
    surface: 'tarmac',
    spinOutTicks: 0,
    invulnTicks: 0,
    boostTicks: 0,
    respawnTicks: 0,
    shielded: false,
    lap: { lap: 0, checkpointIdx: 0, t: 0 },
  }
}

function blankEntity(): EntityState {
  return {
    entityId: -1,
    kind: 'seeker',
    ownerId: -1,
    position: { x: 0, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    heading: 0,
    targetId: -1,
    ttl: 0,
  }
}

/** The empty finishedOrder: fixed length MAX_KARTS, every slot the -1 sentinel. */
function emptyFinishedOrder(): number[] {
  const order: number[] = []
  for (let i = 0; i < MAX_KARTS; i++) order.push(-1)
  return order
}

function blankState(): SimState {
  const karts: KartState[] = []
  for (let i = 0; i < MAX_KARTS; i++) karts.push(blankKart(i))
  const entities: EntityState[] = []
  for (let i = 0; i < MAX_ENTITIES; i++) entities.push(blankEntity())
  return {
    tick: 0,
    phase: 'racing',
    raceSeed: 7,
    rngCursor: 0,
    nextEventSeq: 0,
    finishTick: -1,
    karts,
    entities,
    entityCount: 0,
    nextEntityId: 1,
    itemBoxes: [],
    finishedOrder: emptyFinishedOrder(),
  }
}

function setLap(state: SimState, playerId: number, lap: number, cp: number, t: number): void {
  const k = state.karts[playerId]
  k.lap.lap = lap
  k.lap.checkpointIdx = cp
  k.lap.t = t
}

/**
 * Record finishers the way updateLaps does: into the fixed slots, front to
 * back, never by pushing. `pids` is the crossing order.
 */
function setFinished(state: SimState, pids: number[]): void {
  for (let i = 0; i < pids.length; i++) state.finishedOrder[i] = pids[i]
}

// Grid used by every test below (checkpoint indices are from an 8-checkpoint
// track; placement never consults the track, only the stored triple):
//   p0 (2, 5, 0.90)   p1 (2, 5, 0.10)   p2 (3, 0, 0.00)   p3 (1, 7, 0.50)
//   p4 (2, 6, 0.20)   p5 (3, 0, 0.10)   p6 (0, 0, 0.00)   p7 (2, 5, 0.90)
function gridState(): SimState {
  const state = blankState()
  setLap(state, 0, 2, 5, 0.9)
  setLap(state, 1, 2, 5, 0.1)
  setLap(state, 2, 3, 0, 0.0)
  setLap(state, 3, 1, 7, 0.5)
  setLap(state, 4, 2, 6, 0.2)
  setLap(state, 5, 3, 0, 0.1)
  setLap(state, 6, 0, 0, 0.0)
  setLap(state, 7, 2, 5, 0.9)
  return state
}

describe('placementOrder', () => {
  it('sorts leader first by (lap, checkpointIdx, t) descending with playerId breaking ties', () => {
    const state = gridState()

    // lap 3: p5 (t 0.10) ahead of p2 (t 0.00)
    // lap 2: p4 (cp 6) ahead of cp 5, where p0 and p7 tie at t 0.90 and p0
    //        wins on the lower playerId, then p1 at t 0.10
    // lap 1: p3.  lap 0: p6.
    expect(placementOrder(state)).toEqual([5, 2, 4, 0, 7, 1, 3, 6])
  })

  it('gives finishedOrder precedence over lap progress', () => {
    const state = gridState()
    setFinished(state, [2, 5])
    expect(state.finishedOrder).toEqual([2, 5, -1, -1, -1, -1, -1, -1])

    // p2 crossed the line first even though p5 has the larger t, so p2 is P1.
    // The six -1 slots are not karts and must not rank anything.
    expect(placementOrder(state)).toEqual([2, 5, 4, 0, 7, 1, 3, 6])
  })
})

describe('computePlacement', () => {
  it('fills outOrder and outIndexOf as exact inverses with no finishers', () => {
    const state = gridState()
    const indexOf = new Int32Array(MAX_KARTS)
    const order = new Int32Array(MAX_KARTS)

    computePlacement(state, indexOf, order)

    expect(Array.from(order)).toEqual([5, 2, 4, 0, 7, 1, 3, 6])
    // place of p0..p7: p0->3 p1->5 p2->1 p3->6 p4->2 p5->0 p6->7 p7->4
    expect(Array.from(indexOf)).toEqual([3, 5, 1, 6, 2, 0, 7, 4])
    for (let place = 0; place < MAX_KARTS; place++) {
      expect(indexOf[order[place]]).toBe(place)
    }
  })

  it('fills outOrder and outIndexOf with finishedOrder taking precedence', () => {
    const state = gridState()
    setFinished(state, [2, 5])
    const indexOf = new Int32Array(MAX_KARTS)
    const order = new Int32Array(MAX_KARTS)

    computePlacement(state, indexOf, order)

    expect(Array.from(order)).toEqual([2, 5, 4, 0, 7, 1, 3, 6])
    // place of p0..p7: p0->3 p1->5 p2->0 p3->6 p4->2 p5->1 p6->7 p7->4
    expect(Array.from(indexOf)).toEqual([3, 5, 0, 6, 2, 1, 7, 4])
  })

  it('agrees with placementOrder in every case, and allocates nothing on repeat calls', () => {
    const indexOf = new Int32Array(MAX_KARTS)
    const order = new Int32Array(MAX_KARTS)

    const plain = gridState()
    computePlacement(plain, indexOf, order)
    expect(Array.from(order)).toEqual(placementOrder(plain))

    const finished = gridState()
    setFinished(finished, [2, 5])
    computePlacement(finished, indexOf, order)
    expect(Array.from(order)).toEqual(placementOrder(finished))

    // all eight finished, in a deliberately non-progress order: every slot is
    // taken, so no -1 is left
    const allDone = gridState()
    const crossing = [7, 3, 0, 6, 1, 4, 2, 5]
    setFinished(allDone, crossing)
    expect(allDone.finishedOrder).toEqual(crossing)
    computePlacement(allDone, indexOf, order)
    expect(Array.from(order)).toEqual(crossing)
    expect(Array.from(order)).toEqual(placementOrder(allDone))
    expect(Array.from(indexOf)).toEqual([2, 4, 6, 1, 5, 7, 3, 0])

    // reusing the same out-arrays must overwrite completely, not merge
    computePlacement(plain, indexOf, order)
    expect(Array.from(order)).toEqual([5, 2, 4, 0, 7, 1, 3, 6])
    expect(Array.from(indexOf)).toEqual([3, 5, 1, 6, 2, 0, 7, 4])
  })
})
