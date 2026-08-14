import { describe, expect, it } from 'vitest'
import type { EntityState, KartState, SimContext, SimState } from '../src/types'
import { MAX_ENTITIES, MAX_KARTS } from '../src/types'
import { makeContext, makeStraightTrack } from './fixtures/track-fixtures'
import { POSITION_ITERATIONS, resolveKartCollisions } from '../src/collision'

// A deliberately local kart builder: this file addresses karts by playerId and
// writes every field explicitly, so it does not use Task 6's shared
// `makeKart(over?)`. `resolveKartCollisions` never reads `lap`, so the value below
// is inert; the real initial value createState produces is
// `{ lap: 0, checkpointIdx: track.checkpointS.length - 1, t: 0 }`.
function makeKart(playerId: number): KartState {
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

/**
 * Eight karts, playerId == slot, parked 100 apart along +X starting at x = 1000.
 * Nothing within 100 of anything else, so any kart a test does not explicitly
 * place cannot influence the result.
 */
function makeSimState(): SimState {
  const karts: KartState[] = []
  for (let i = 0; i < MAX_KARTS; i++) {
    const k = makeKart(i)
    k.position.x = 1000 + i * 100
    karts.push(k)
  }
  const entities: EntityState[] = []
  for (let i = 0; i < MAX_ENTITIES; i++) {
    entities.push({
      entityId: -1,
      kind: 'seeker',
      ownerId: -1,
      position: { x: 0, y: 0, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
      heading: 0,
      targetId: -1,
      ttl: 0,
    })
  }
  return {
    tick: 0,
    phase: 'racing',
    raceSeed: 1,
    rngCursor: 0,
    nextEventSeq: 0,
    finishTick: -1,
    karts,
    entities,
    entityCount: 0,
    nextEntityId: 1,
    itemBoxes: [],
    // Contract §0: finishedOrder is fixed length MAX_KARTS, unused slots hold -1.
    finishedOrder: new Array<number>(MAX_KARTS).fill(-1),
  }
}

function setKart(
  k: KartState,
  playerId: number,
  characterIdx: number,
  px: number, py: number, pz: number,
  vx: number, vy: number, vz: number,
): void {
  k.playerId = playerId
  k.characterIdx = characterIdx
  k.position.x = px
  k.position.y = py
  k.position.z = pz
  k.velocity.x = vx
  k.velocity.y = vy
  k.velocity.z = vz
  k.respawnTicks = 0
}

function byId(state: SimState, playerId: number): KartState {
  for (let i = 0; i < MAX_KARTS; i++) {
    if (state.karts[i].playerId === playerId) return state.karts[i]
  }
  throw new Error(`no kart with playerId ${playerId}`)
}

function distance(a: KartState, b: KartState): number {
  return Math.hypot(
    b.position.x - a.position.x,
    b.position.y - a.position.y,
    b.position.z - a.position.z,
  )
}

function ctxFor(): SimContext {
  return makeContext(makeStraightTrack())
}

describe('kart collision impulse', () => {
  it('uses the locked tuning and weight fixtures', () => {
    const ctx = ctxFor()
    expect(ctx.tuning.kartRadius).toBe(0.9) // contact distance is 2 * 0.9 = 1.8
    expect(ctx.tuning.kartRestitution).toBe(0.4)
    expect(ctx.characters[0].weight).toBe(1)
    expect(ctx.characters[7].weight).toBe(1)
    expect(ctx.characters[5].weight).toBe(1.3)
    expect(ctx.characters[6].weight).toBe(0.8)
  })

  it('drives an equal-weight head-on pair apart at the restitution ratio', () => {
    const ctx = ctxFor()
    const state = makeSimState()
    // both weight 1.00, 1.0 apart (contact is 1.8, so overlapping), closing at 20
    setKart(state.karts[0], 0, 0, 0, 0, 0, 10, 0, 0)
    setKart(state.karts[1], 1, 7, 1, 0, 0, -10, 0, 0)

    resolveKartCollisions(ctx, state)

    // n = (1,0,0); vn = (-10) - (10) = -20
    // j = -(1 + 0.4) * (-20) / (1/1 + 1/1) = 28 / 2 = 14
    // a.vx = 10 - 14 * 1 = -4 ; b.vx = -10 + 14 * 1 = 4
    expect(state.karts[0].velocity.x).toBeCloseTo(-4, 12)
    expect(state.karts[1].velocity.x).toBeCloseTo(4, 12)
    // separating speed is exactly restitution * closing speed: 0.4 * 20 = 8
    expect(state.karts[1].velocity.x - state.karts[0].velocity.x).toBeCloseTo(8, 12)
    // momentum: 1*(-4) + 1*4 = 0, same as 1*10 + 1*(-10) before
    expect(state.karts[0].velocity.x + state.karts[1].velocity.x).toBeCloseTo(0, 12)
    // nothing off-axis
    expect(state.karts[0].velocity.y).toBeCloseTo(0, 12)
    expect(state.karts[0].velocity.z).toBeCloseTo(0, 12)
    expect(state.karts[1].velocity.y).toBeCloseTo(0, 12)
    expect(state.karts[1].velocity.z).toBeCloseTo(0, 12)
  })

  it("scales the impulse by the two characters' weight stats", () => {
    const ctx = ctxFor()
    const state = makeSimState()
    // character 5 weight 1.30 rams stationary character 6 weight 0.80
    setKart(state.karts[0], 0, 5, 0, 0, 0, 10, 0, 0)
    setKart(state.karts[1], 1, 6, 1, 0, 0, 0, 0, 0)

    resolveKartCollisions(ctx, state)

    // invA = 1/1.3 = 10/13, invB = 1/0.8 = 5/4, sum = 105/52
    // vn = 0 - 10 = -10
    // j = -(1.4) * (-10) / (105/52) = 14 * 52 / 105 = 728/105 = 104/15
    // a.vx = 10 - j*(10/13) = 10 - 16/3 = 14/3 = 4.666666666666667
    // b.vx = 0  + j*(5/4)   = 26/3      = 8.666666666666666
    expect(state.karts[0].velocity.x).toBeCloseTo(4.666666666666667, 12)
    expect(state.karts[1].velocity.x).toBeCloseTo(8.666666666666666, 12)
    // heavy kart keeps more of its speed than the light one gains over it
    expect(state.karts[1].velocity.x - state.karts[0].velocity.x).toBeCloseTo(4, 12)
    // weighted momentum: 1.3*14/3 + 0.8*26/3 = 39/3 = 13 == 1.3 * 10
    const p = 1.3 * state.karts[0].velocity.x + 0.8 * state.karts[1].velocity.x
    expect(p).toBeCloseTo(13, 12)
  })

  it('applies no impulse to karts that are already moving apart', () => {
    const ctx = ctxFor()
    const state = makeSimState()
    setKart(state.karts[0], 0, 0, 0, 0, 0, -3, 0, 0)
    setKart(state.karts[1], 1, 7, 1, 0, 0, 7, 0, 0)

    resolveKartCollisions(ctx, state)

    // vn = 7 - (-3) = +10 : separating, so no impulse at all
    expect(state.karts[0].velocity.x).toBe(-3)
    expect(state.karts[1].velocity.x).toBe(7)
  })

  it('ignores karts at or beyond the contact distance', () => {
    const ctx = ctxFor()

    const touching = makeSimState()
    setKart(touching.karts[0], 0, 0, 0, 0, 0, 10, 0, 0)
    setKart(touching.karts[1], 1, 7, 1.8, 0, 0, -10, 0, 0) // exactly 2 * 0.9
    resolveKartCollisions(ctx, touching)
    expect(touching.karts[0].velocity.x).toBe(10)
    expect(touching.karts[1].velocity.x).toBe(-10)

    const apart = makeSimState()
    setKart(apart.karts[0], 0, 0, 0, 0, 0, 10, 0, 0)
    setKart(apart.karts[1], 1, 7, 2.5, 0, 0, -10, 0, 0)
    resolveKartCollisions(ctx, apart)
    expect(apart.karts[0].velocity.x).toBe(10)
    expect(apart.karts[1].velocity.x).toBe(-10)
  })

  it('leaves a respawning kart out of the collision entirely', () => {
    const ctx = ctxFor()
    const state = makeSimState()
    setKart(state.karts[0], 0, 0, 0, 0, 0, 10, 0, 0)
    setKart(state.karts[1], 1, 7, 1, 0, 0, -10, 0, 0)
    state.karts[0].respawnTicks = 10 // Task 9 owns this kart's position this tick

    resolveKartCollisions(ctx, state)

    expect(state.karts[0].velocity.x).toBe(10)
    expect(state.karts[1].velocity.x).toBe(-10)
  })

  it('collides in three dimensions, not just the ground plane', () => {
    const ctx = ctxFor()
    const state = makeSimState()
    // a kart landing on top of another: 1.0 apart along +y
    setKart(state.karts[0], 0, 0, 0, 0, 0, 0, 0, 0)
    setKart(state.karts[1], 1, 7, 0, 1, 0, 0, -20, 0)

    resolveKartCollisions(ctx, state)

    // identical arithmetic to the head-on case, rotated onto +y:
    // vn = -20 - 0 = -20, j = 14, a.vy = -14, b.vy = -20 + 14 = -6
    expect(state.karts[0].velocity.y).toBeCloseTo(-14, 12)
    expect(state.karts[1].velocity.y).toBeCloseTo(-6, 12)
    expect(state.karts[0].velocity.x).toBeCloseTo(0, 12)
  })
})

const PILE_UP_SLOTS: number[][] = [
  [0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0],
]

/**
 * Three mutually overlapping karts. `slots[i]` is the array slot that test kart
 * `i` is written into; the five karts left over are parked far away and take the
 * remaining playerIds so all eight ids stay unique.
 *
 *   id 0, character 0, weight 1.00, at (0,   0, 0),   velocity (5, 0, 0)
 *   id 1, character 1, weight 1.20, at (1,   0, 0),   velocity (-5, 0, 0)
 *   id 2, character 2, weight 0.85, at (0.5, 0, 0.8), velocity (0, 0, -5)
 *
 * pair 0-1 is 1.0 apart, pairs 0-2 and 1-2 are sqrt(0.25 + 0.64) = 0.943 apart,
 * so all three pairs are inside the 1.8 contact distance.
 */
function pileUpState(slots: number[]): SimState {
  const state = makeSimState()
  const spare = [3, 4, 5, 6, 7]
  let n = 0
  for (let i = 0; i < MAX_KARTS; i++) {
    if (i === slots[0] || i === slots[1] || i === slots[2]) continue
    setKart(state.karts[i], spare[n], 0, 1000 + i * 100, 0, 0, 0, 0, 0)
    n += 1
  }
  setKart(state.karts[slots[0]], 0, 0, 0, 0, 0, 5, 0, 0)
  setKart(state.karts[slots[1]], 1, 1, 1, 0, 0, -5, 0, 0)
  setKart(state.karts[slots[2]], 2, 2, 0.5, 0, 0.8, 0, 0, -5)
  return state
}

function weightedSum(
  ctx: SimContext,
  state: SimState,
  ids: number[],
  pick: (k: KartState) => number,
): number {
  let acc = 0
  for (const id of ids) {
    const k = byId(state, id)
    acc += ctx.characters[k.characterIdx].weight * pick(k)
  }
  return acc
}

describe('kart collision separation', () => {
  it('pushes an equal-weight overlapping pair out to exactly 2 * kartRadius', () => {
    const ctx = ctxFor()
    const state = makeSimState()
    setKart(state.karts[0], 0, 0, 0, 0, 0, 10, 0, 0)
    setKart(state.karts[1], 1, 7, 1, 0, 0, -10, 0, 0)

    resolveKartCollisions(ctx, state)

    // overlap = 1.8 - 1.0 = 0.8, split 0.4 / 0.4 because the weights are equal
    expect(state.karts[0].position.x).toBeCloseTo(-0.4, 12)
    expect(state.karts[1].position.x).toBeCloseTo(1.4, 12)
    expect(distance(state.karts[0], state.karts[1])).toBeCloseTo(1.8, 12)
  })

  it('splits the separation by weight and preserves the weighted centroid', () => {
    const ctx = ctxFor()
    const state = makeSimState()
    setKart(state.karts[0], 0, 5, 0, 0, 0, 10, 0, 0) // weight 1.30
    setKart(state.karts[1], 1, 6, 1, 0, 0, 0, 0, 0)  // weight 0.80

    resolveKartCollisions(ctx, state)

    // total = 2.1, overlap = 0.8
    // heavy moves overlap * (0.8/2.1) = 0.30476190476190473
    // light moves overlap * (1.3/2.1) = 0.4952380952380953
    expect(state.karts[0].position.x).toBeCloseTo(-0.3047619047619048, 12)
    expect(state.karts[1].position.x).toBeCloseTo(1.4952380952380953, 12)
    expect(distance(state.karts[0], state.karts[1])).toBeCloseTo(1.8, 12)
    // weighted centroid before: (1.3*0 + 0.8*1) / 2.1 = 0.38095238095238093
    const c = (1.3 * state.karts[0].position.x + 0.8 * state.karts[1].position.x) / 2.1
    expect(c).toBeCloseTo(0.38095238095238093, 12)
  })

  it('separates overlapping karts even when they are already moving apart', () => {
    const ctx = ctxFor()
    const state = makeSimState()
    setKart(state.karts[0], 0, 0, 0, 0, 0, -3, 0, 0)
    setKart(state.karts[1], 1, 7, 1, 0, 0, 7, 0, 0)

    resolveKartCollisions(ctx, state)

    expect(state.karts[0].velocity.x).toBe(-3) // still no impulse
    expect(state.karts[1].velocity.x).toBe(7)
    expect(state.karts[0].position.x).toBeCloseTo(-0.4, 12)
    expect(state.karts[1].position.x).toBeCloseTo(1.4, 12)
  })

  it('separates exactly coincident karts along +X, deterministically', () => {
    const ctx = ctxFor()
    const state = makeSimState()
    setKart(state.karts[0], 0, 0, 5, 0, 5, 0, 0, 0)
    setKart(state.karts[1], 1, 7, 5, 0, 5, 0, 0, 0)

    resolveKartCollisions(ctx, state)

    // overlap is the whole 1.8, split 0.9 / 0.9 on the fallback +X normal
    expect(state.karts[0].position.x).toBeCloseTo(4.1, 12)
    expect(state.karts[1].position.x).toBeCloseTo(5.9, 12)
    expect(state.karts[0].position.z).toBeCloseTo(5, 12)
    expect(state.karts[1].position.z).toBeCloseTo(5, 12)
    expect(distance(state.karts[0], state.karts[1])).toBeCloseTo(1.8, 12)
  })

  it('clears a deep overlap in a single call', () => {
    const ctx = ctxFor()
    const state = makeSimState()
    setKart(state.karts[0], 0, 0, 0, 0, 0, 0, 0, 0)
    setKart(state.karts[1], 1, 7, 0.1, 0, 0, 0, 0, 0)

    resolveKartCollisions(ctx, state)

    // overlap = 1.8 - 0.1 = 1.7, split 0.85 / 0.85
    expect(state.karts[0].position.x).toBeCloseTo(-0.85, 12)
    expect(state.karts[1].position.x).toBeCloseTo(0.95, 12)
    expect(distance(state.karts[0], state.karts[1])).toBeGreaterThanOrEqual(1.8 - 1e-9)
  })

  it('does not move a respawning kart out of its interpolation', () => {
    const ctx = ctxFor()
    const state = makeSimState()
    setKart(state.karts[0], 0, 0, 0, 0, 0, 0, 0, 0)
    setKart(state.karts[1], 1, 7, 1, 0, 0, 0, 0, 0)
    state.karts[0].respawnTicks = 10

    resolveKartCollisions(ctx, state)

    expect(state.karts[0].position.x).toBe(0)
    expect(state.karts[1].position.x).toBe(1)
  })

  it('conserves weighted momentum and the weighted centroid of a pile-up', () => {
    const ctx = ctxFor()
    const state = pileUpState([0, 1, 2])
    const ids = [0, 1, 2]

    // before: sum(w*p.x) = 1.00*0 + 1.20*1 + 0.85*0.5 = 1.625
    //         sum(w*p.z) = 0.85*0.8                   = 0.68
    //         sum(w*v.x) = 1.00*5 + 1.20*(-5)         = -1
    //         sum(w*v.z) = 0.85*(-5)                  = -4.25
    resolveKartCollisions(ctx, state)

    expect(weightedSum(ctx, state, ids, (k) => k.position.x)).toBeCloseTo(1.625, 9)
    expect(weightedSum(ctx, state, ids, (k) => k.position.z)).toBeCloseTo(0.68, 9)
    expect(weightedSum(ctx, state, ids, (k) => k.velocity.x)).toBeCloseTo(-1, 9)
    expect(weightedSum(ctx, state, ids, (k) => k.velocity.z)).toBeCloseTo(-4.25, 9)

    for (let i = 0; i < 16; i++) resolveKartCollisions(ctx, state)

    expect(weightedSum(ctx, state, ids, (k) => k.position.x)).toBeCloseTo(1.625, 9)
    expect(weightedSum(ctx, state, ids, (k) => k.position.z)).toBeCloseTo(0.68, 9)
  })

  it('leaves no pair of a 3-kart pile-up overlapped', () => {
    const ctx = ctxFor()
    const state = pileUpState([0, 1, 2])

    for (let i = 0; i < 16; i++) resolveKartCollisions(ctx, state)

    const k0 = byId(state, 0)
    const k1 = byId(state, 1)
    const k2 = byId(state, 2)
    expect(distance(k0, k1)).toBeGreaterThanOrEqual(1.8 - 1e-9)
    expect(distance(k0, k2)).toBeGreaterThanOrEqual(1.8 - 1e-9)
    expect(distance(k1, k2)).toBeGreaterThanOrEqual(1.8 - 1e-9)
  })
})

describe('kart collision order independence', () => {
  it('resolves a pair identically with the two karts in swapped slots', () => {
    const ctx = ctxFor()

    const forward = makeSimState()
    setKart(forward.karts[0], 0, 5, 0, 0, 0, 10, 0, 0)
    setKart(forward.karts[1], 1, 6, 1, 0, 0, 0, 0, 0)
    resolveKartCollisions(ctx, forward)

    const swapped = makeSimState()
    setKart(swapped.karts[0], 1, 6, 1, 0, 0, 0, 0, 0)
    setKart(swapped.karts[1], 0, 5, 0, 0, 0, 10, 0, 0)
    resolveKartCollisions(ctx, swapped)

    for (const id of [0, 1]) {
      const f = byId(forward, id)
      const s = byId(swapped, id)
      expect(s.position.x).toBe(f.position.x)
      expect(s.position.y).toBe(f.position.y)
      expect(s.position.z).toBe(f.position.z)
      expect(s.velocity.x).toBe(f.velocity.x)
      expect(s.velocity.y).toBe(f.velocity.y)
      expect(s.velocity.z).toBe(f.velocity.z)
    }
  })

  it('resolves a pair identically with the two playerIds swapped', () => {
    const ctx = ctxFor()

    const base = makeSimState()
    setKart(base.karts[0], 0, 5, 0, 0, 0, 10, 0, 0)
    setKart(base.karts[1], 1, 6, 1, 0, 0, 0, 0, 0)
    resolveKartCollisions(ctx, base)

    const renamed = makeSimState()
    setKart(renamed.karts[0], 1, 5, 0, 0, 0, 10, 0, 0) // same heavy kart, id 1
    setKart(renamed.karts[1], 0, 6, 1, 0, 0, 0, 0, 0)  // same light kart, id 0
    resolveKartCollisions(ctx, renamed)

    // compare the heavy kart to the heavy kart, whatever id it wears
    expect(renamed.karts[0].position.x).toBe(base.karts[0].position.x)
    expect(renamed.karts[0].velocity.x).toBe(base.karts[0].velocity.x)
    expect(renamed.karts[1].position.x).toBe(base.karts[1].position.x)
    expect(renamed.karts[1].velocity.x).toBe(base.karts[1].velocity.x)
  })

  it('resolves a 3-kart pile-up identically for all six slot permutations', () => {
    const ctx = ctxFor()
    const reference = pileUpState(PILE_UP_SLOTS[0])
    resolveKartCollisions(ctx, reference)

    for (let p = 1; p < PILE_UP_SLOTS.length; p++) {
      const state = pileUpState(PILE_UP_SLOTS[p])
      resolveKartCollisions(ctx, state)
      for (const id of [0, 1, 2]) {
        const r = byId(reference, id)
        const k = byId(state, id)
        expect(k.position.x).toBe(r.position.x)
        expect(k.position.y).toBe(r.position.y)
        expect(k.position.z).toBe(r.position.z)
        expect(k.velocity.x).toBe(r.velocity.x)
        expect(k.velocity.y).toBe(r.velocity.y)
        expect(k.velocity.z).toBe(r.velocity.z)
      }
    }
  })

  it('stays identical across 20 successive calls in every slot permutation', () => {
    const ctx = ctxFor()
    const reference = pileUpState(PILE_UP_SLOTS[0])
    for (let i = 0; i < 20; i++) resolveKartCollisions(ctx, reference)

    for (let p = 1; p < PILE_UP_SLOTS.length; p++) {
      const state = pileUpState(PILE_UP_SLOTS[p])
      for (let i = 0; i < 20; i++) resolveKartCollisions(ctx, state)
      for (const id of [0, 1, 2]) {
        const r = byId(reference, id)
        const k = byId(state, id)
        expect(k.position.x).toBe(r.position.x)
        expect(k.position.z).toBe(r.position.z)
        expect(k.velocity.x).toBe(r.velocity.x)
        expect(k.velocity.z).toBe(r.velocity.z)
      }
    }
  })

  it('runs the documented number of position passes', () => {
    expect(POSITION_ITERATIONS).toBe(4)
  })
})
