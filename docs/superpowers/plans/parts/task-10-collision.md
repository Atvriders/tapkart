### Task 10: Kart-vs-kart collision resolution

**Files:**
- Create: `packages/sim/src/collision.ts`
- Test: `packages/sim/test/collision.test.ts`
- Modify: `packages/sim/src/step.ts` (two edits — the import line and one call after the
  per-kart loop; exact before/after in Step 16)
- Modify: `packages/sim/test/step.test.ts` (append one describe block; exact code in Step 14)

**Interfaces:**

- Consumes (all fixed by the locked contract, all authored by earlier tasks):
  - `packages/sim/src/types.ts` [Task 2] — `MAX_KARTS` (`= 8`), `MAX_ENTITIES` (`= 32`),
    and the types `EntityState`, `KartState`, `SimContext`, `SimState`.
  - `SimContext.tuning.kartRadius` (fixture value `0.9`) and
    `SimContext.tuning.kartRestitution` (fixture value `0.4`).
  - `SimContext.characters[i].weight` — fixture weights for characters 0..7 are
    `[1.00, 1.20, 0.85, 1.10, 0.90, 1.30, 0.80, 1.00]`.
  - `KartState.respawnTicks` — a kart with `respawnTicks > 0` is being teleported by
    `updateRecovery` (Task 9) and takes no part in collision.
  - `packages/sim/test/fixtures/track-fixtures.ts` —
    `makeStraightTrack(overrides?: Partial<Track>): Track` [Task 3] and
    `makeContext(track: Track, isLeader?: boolean): SimContext` [Task 4, because it
    needs `buildTrackQuery`].
  - `packages/sim/test/helpers/flat-context.ts` [Task 5, extended by Task 6] —
    `makeTestContext(startPositions)`, `EIGHT_STARTS`; used only by this task's
    `step()` test.
  - `packages/sim/src/state.ts` [Task 5] — `createState(ctx, seed, characterIdx)`,
    used only by this task's `step()` test.
  - `packages/sim/src/step.ts` [Task 5, extended by 6–9] — the per-kart loop, whose
    last statement after Task 8 is `decayBoost(k)`. This task adds the first
    once-per-tick call after that loop closes.

- Produces (exact names and signatures later tasks rely on):
  - `export function resolveKartCollisions(ctx: SimContext, state: SimState): void`
    — called once per tick from `step()`, after the per-kart loop and before
    `updateEntities`, exactly as the contract's canonical order states. Mutates
    `state.karts[*].position` and `.velocity` only. Emits no events.
  - `export const POSITION_ITERATIONS: number` — `4`. New, defined here; the number of
    Jacobi position-correction passes per call.
  - The `step()` call site itself (Step 16), per contract §0: the task that introduces
    a function also adds its call site in `step.ts`, with its own failing test. Task 12
    inserts `updateEntities(ctx, next, events)` directly after the line this task adds,
    and Task 13 inserts `updateItemBoxes` after that, which is the contract's
    `resolveKartCollisions → updateEntities → updateItemBoxes → updatePhase`.

**Order independence is a hard requirement of this task.** The function must produce
bit-identical results no matter which array slot each kart occupies. Two properties
buy that, and both are asserted by tests below:

1. Pairs are visited by **ascending `playerId`**, not by array index, and the lower
   `playerId` is always the `a` side. A kart's identity, not its slot, decides every
   sign in the computation.
2. Each pass is **Jacobi**: every pair reads the same starting positions and writes
   into per-`playerId` accumulators, which are applied only after the whole pass.
   A Gauss-Seidel pass (apply as you go) makes each pair's input depend on which
   pairs ran before it, which is precisely the slot dependence we are eliminating.

---

- [ ] **Step 1: Write the failing test — the impulse**

Create `packages/sim/test/collision.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { EntityState, KartState, SimContext, SimState } from '../src/types'
import { MAX_ENTITIES, MAX_KARTS } from '../src/types'
import { makeContext, makeStraightTrack } from './fixtures/track-fixtures'
import { resolveKartCollisions } from '../src/collision'

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/sim/test/collision.test.ts -t "kart collision impulse"`
Expected: FAIL with `Failed to resolve import "../src/collision"` — the module does not
exist yet.

- [ ] **Step 3: Write minimal implementation — the impulse**

Create `packages/sim/src/collision.ts`:

```ts
import type { KartState, SimContext, SimState } from './types'
import { MAX_KARTS } from './types'

/**
 * Sphere-vs-sphere kart collision. Called once per tick from `step()`, after the
 * per-kart loop and before `updateEntities`.
 */
export function resolveKartCollisions(ctx: SimContext, state: SimState): void {
  const t = ctx.tuning
  const contact = t.kartRadius * 2
  const contactSq = contact * contact
  const chars = ctx.characters

  for (let sa = 0; sa < MAX_KARTS; sa++) {
    const a = state.karts[sa]
    if (!collidable(a)) continue
    for (let sb = sa + 1; sb < MAX_KARTS; sb++) {
      const b = state.karts[sb]
      if (!collidable(b)) continue

      const dx = b.position.x - a.position.x
      const dy = b.position.y - a.position.y
      const dz = b.position.z - a.position.z
      const d2 = dx * dx + dy * dy + dz * dz
      if (d2 >= contactSq) continue

      // Exactly coincident karts get a fixed +X normal so the result stays
      // deterministic instead of dividing by zero.
      let nx = 1
      let ny = 0
      let nz = 0
      if (d2 > 0) {
        const dist = Math.sqrt(d2)
        nx = dx / dist
        ny = dy / dist
        nz = dz / dist
      }

      const rvx = b.velocity.x - a.velocity.x
      const rvy = b.velocity.y - a.velocity.y
      const rvz = b.velocity.z - a.velocity.z
      const vn = rvx * nx + rvy * ny + rvz * nz
      if (vn >= 0) continue // already separating

      const wa = chars[a.characterIdx].weight
      const wb = chars[b.characterIdx].weight
      const invA = 1 / wa
      const invB = 1 / wb
      const imp = -(1 + t.kartRestitution) * vn / (invA + invB)
      const ia = imp * invA
      const ib = imp * invB

      a.velocity.x -= nx * ia
      a.velocity.y -= ny * ia
      a.velocity.z -= nz * ia
      b.velocity.x += nx * ib
      b.velocity.y += ny * ib
      b.velocity.z += nz * ib
    }
  }
}

/** A kart being teleported by `updateRecovery` (Task 9) takes no part in collision. */
function collidable(k: KartState): boolean {
  return k.respawnTicks === 0
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/sim/test/collision.test.ts -t "kart collision impulse"`
Expected: PASS — 7 tests.

---

- [ ] **Step 5: Write the failing test — positional separation**

Append this block to the end of `packages/sim/test/collision.test.ts`:

```ts
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
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run packages/sim/test/collision.test.ts -t "kart collision separation"`
Expected: FAIL — "pushes an equal-weight overlapping pair out to exactly 2 *
kartRadius" reports `expected 0 to be close to -0.4`; the current implementation only
applies the impulse and never touches positions.

- [ ] **Step 7: Write minimal implementation — positional separation**

Replace the whole of `packages/sim/src/collision.ts` with:

```ts
import type { KartState, SimContext, SimState } from './types'
import { MAX_KARTS } from './types'

/**
 * Sphere-vs-sphere kart collision. Called once per tick from `step()`, after the
 * per-kart loop and before `updateEntities`.
 */
export function resolveKartCollisions(ctx: SimContext, state: SimState): void {
  const t = ctx.tuning
  const contact = t.kartRadius * 2
  const contactSq = contact * contact
  const chars = ctx.characters

  for (let sa = 0; sa < MAX_KARTS; sa++) {
    const a = state.karts[sa]
    if (!collidable(a)) continue
    for (let sb = sa + 1; sb < MAX_KARTS; sb++) {
      const b = state.karts[sb]
      if (!collidable(b)) continue

      const dx = b.position.x - a.position.x
      const dy = b.position.y - a.position.y
      const dz = b.position.z - a.position.z
      const d2 = dx * dx + dy * dy + dz * dz
      if (d2 >= contactSq) continue

      // Exactly coincident karts get a fixed +X normal so the result stays
      // deterministic instead of dividing by zero.
      let nx = 1
      let ny = 0
      let nz = 0
      let dist = 0
      if (d2 > 0) {
        dist = Math.sqrt(d2)
        nx = dx / dist
        ny = dy / dist
        nz = dz / dist
      }
      const overlap = contact - dist

      const wa = chars[a.characterIdx].weight
      const wb = chars[b.characterIdx].weight
      const total = wa + wb

      // Positional separation. Each kart yields in proportion to the OTHER kart's
      // weight, so the two shares sum to the whole overlap and the weight-weighted
      // centroid of the pair is unchanged.
      const sepA = overlap * (wb / total)
      const sepB = overlap * (wa / total)
      a.position.x -= nx * sepA
      a.position.y -= ny * sepA
      a.position.z -= nz * sepA
      b.position.x += nx * sepB
      b.position.y += ny * sepB
      b.position.z += nz * sepB

      const rvx = b.velocity.x - a.velocity.x
      const rvy = b.velocity.y - a.velocity.y
      const rvz = b.velocity.z - a.velocity.z
      const vn = rvx * nx + rvy * ny + rvz * nz
      if (vn >= 0) continue // already separating

      const invA = 1 / wa
      const invB = 1 / wb
      const imp = -(1 + t.kartRestitution) * vn / (invA + invB)
      const ia = imp * invA
      const ib = imp * invB

      a.velocity.x -= nx * ia
      a.velocity.y -= ny * ia
      a.velocity.z -= nz * ia
      b.velocity.x += nx * ib
      b.velocity.y += ny * ib
      b.velocity.z += nz * ib
    }
  }
}

/** A kart being teleported by `updateRecovery` (Task 9) takes no part in collision. */
function collidable(k: KartState): boolean {
  return k.respawnTicks === 0
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npx vitest run packages/sim/test/collision.test.ts`
Expected: PASS — 15 tests (7 impulse + 8 separation).

---

- [ ] **Step 9: Write the failing test — order independence**

Append this block to the end of `packages/sim/test/collision.test.ts`:

```ts
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
```

Then change the import of `../src/collision` at the top of the file.

Before:

```ts
import { resolveKartCollisions } from '../src/collision'
```

After:

```ts
import { POSITION_ITERATIONS, resolveKartCollisions } from '../src/collision'
```

- [ ] **Step 10: Run test to verify it fails**

Run: `npx vitest run packages/sim/test/collision.test.ts -t "kart collision order independence"`
Expected: FAIL on two tests.
"resolves a 3-kart pile-up identically for all six slot permutations" fails with an
`expected <x> to be <y>` mismatch on the first permutation that reorders the karts —
the current pass applies each pair as it goes, so pair 1-2 reads positions that pair
0-1 already moved, and reordering the slots reorders that chain.
"runs the documented number of position passes" fails with `POSITION_ITERATIONS is not
defined` (the export does not exist yet).
The two pair tests already pass: with a single pair there is nothing to reorder. They
stay as regression guards on the sign symmetry of the normal.

- [ ] **Step 11: Write the order-independent implementation**

Replace the whole of `packages/sim/src/collision.ts` with:

```ts
import type { KartState, SimContext, SimState } from './types'
import { MAX_KARTS } from './types'

/**
 * Position-correction passes per call. Each pass is Jacobi — every pair reads the
 * same starting positions and writes into accumulators applied only at the end of
 * the pass — so one pass cannot fully separate a pile-up where a kart is pushed by
 * two neighbours at once. Four passes clear every configuration the 8-kart grid can
 * produce, and passes after separation is reached are no-ops.
 */
export const POSITION_ITERATIONS = 4

/** playerId -> array slot. Module scope: the hot path never allocates. */
const SLOT = new Int32Array(MAX_KARTS)
/** Per-playerId position and velocity accumulators, 3 components each. */
const DP = new Float64Array(MAX_KARTS * 3)
const DV = new Float64Array(MAX_KARTS * 3)

/**
 * Sphere-vs-sphere kart collision. Called once per tick from `step()`, after the
 * per-kart loop and before `updateEntities`.
 *
 * Order independence, which is a hard requirement:
 *
 *  - Pairs are visited by ascending `playerId`, never by array index, and the lower
 *    `playerId` is always the `a` side. Which slot a kart occupies therefore cannot
 *    change any sign in the computation.
 *  - Each pass is Jacobi, so no pair's input depends on which pairs ran before it.
 *  - Every kart's contributions land in its accumulator in ascending partner-id
 *    order (partners below it first, from the outer loop; partners above it after),
 *    so even the float summation order is a function of identity alone. Float
 *    addition is not associative, and this is what keeps a 3-kart pile-up
 *    bit-identical under permutation rather than merely close.
 */
export function resolveKartCollisions(ctx: SimContext, state: SimState): void {
  const t = ctx.tuning
  const contact = t.kartRadius * 2
  const contactSq = contact * contact
  const chars = ctx.characters
  const restitution = 1 + t.kartRestitution

  for (let p = 0; p < MAX_KARTS; p++) SLOT[p] = -1
  for (let i = 0; i < MAX_KARTS; i++) {
    const p = state.karts[i].playerId
    if (p >= 0 && p < MAX_KARTS && SLOT[p] === -1) SLOT[p] = i
  }

  for (let iter = 0; iter < POSITION_ITERATIONS; iter++) {
    const first = iter === 0
    for (let n = 0; n < MAX_KARTS * 3; n++) {
      DP[n] = 0
      if (first) DV[n] = 0
    }

    for (let pa = 0; pa < MAX_KARTS; pa++) {
      const ia = SLOT[pa]
      if (ia < 0) continue
      const a = state.karts[ia]
      if (!collidable(a)) continue

      for (let pb = pa + 1; pb < MAX_KARTS; pb++) {
        const ib = SLOT[pb]
        if (ib < 0) continue
        const b = state.karts[ib]
        if (!collidable(b)) continue

        const dx = b.position.x - a.position.x
        const dy = b.position.y - a.position.y
        const dz = b.position.z - a.position.z
        const d2 = dx * dx + dy * dy + dz * dz
        if (d2 >= contactSq) continue

        // Exactly coincident karts get a fixed +X normal so the result stays
        // deterministic instead of dividing by zero.
        let nx = 1
        let ny = 0
        let nz = 0
        let dist = 0
        if (d2 > 0) {
          dist = Math.sqrt(d2)
          nx = dx / dist
          ny = dy / dist
          nz = dz / dist
        }
        const overlap = contact - dist

        const wa = chars[a.characterIdx].weight
        const wb = chars[b.characterIdx].weight
        const total = wa + wb

        // Each kart yields in proportion to the OTHER kart's weight, so the two
        // shares sum to the whole overlap and the weight-weighted centroid of the
        // pair is unchanged.
        const sepA = overlap * (wb / total)
        const sepB = overlap * (wa / total)
        const oa = pa * 3
        const ob = pb * 3
        DP[oa] -= nx * sepA
        DP[oa + 1] -= ny * sepA
        DP[oa + 2] -= nz * sepA
        DP[ob] += nx * sepB
        DP[ob + 1] += ny * sepB
        DP[ob + 2] += nz * sepB

        if (!first) continue

        const rvx = b.velocity.x - a.velocity.x
        const rvy = b.velocity.y - a.velocity.y
        const rvz = b.velocity.z - a.velocity.z
        const vn = rvx * nx + rvy * ny + rvz * nz
        if (vn >= 0) continue // already separating

        const invA = 1 / wa
        const invB = 1 / wb
        const imp = -restitution * vn / (invA + invB)
        const ja = imp * invA
        const jb = imp * invB
        DV[oa] -= nx * ja
        DV[oa + 1] -= ny * ja
        DV[oa + 2] -= nz * ja
        DV[ob] += nx * jb
        DV[ob + 1] += ny * jb
        DV[ob + 2] += nz * jb
      }
    }

    for (let p = 0; p < MAX_KARTS; p++) {
      const i = SLOT[p]
      if (i < 0) continue
      const k = state.karts[i]
      if (!collidable(k)) continue
      const o = p * 3
      k.position.x += DP[o]
      k.position.y += DP[o + 1]
      k.position.z += DP[o + 2]
      if (first) {
        k.velocity.x += DV[o]
        k.velocity.y += DV[o + 1]
        k.velocity.z += DV[o + 2]
      }
    }
  }
}

/** A kart being teleported by `updateRecovery` (Task 9) takes no part in collision. */
function collidable(k: KartState): boolean {
  return k.respawnTicks === 0
}
```

- [ ] **Step 12: Run test to verify it passes**

Run: `npx vitest run packages/sim/test/collision.test.ts -t "kart collision order independence"`
Expected: PASS — 5 tests.

---

- [ ] **Step 13: Verify the whole module**

Run: `npx vitest run packages/sim/test/collision.test.ts`
Expected: PASS — 20 tests across 3 describe blocks. In particular the impulse and
separation numbers from Steps 1 and 5 must be unchanged by the rewrite: for a single
pair, a Jacobi pass and an apply-as-you-go pass compute the same thing.

Run: `npx tsc --noEmit -p packages/sim`
Expected: no output, exit code 0.

Nothing calls `resolveKartCollisions` yet. Steps 14–17 add the one call site, which
is what makes karts solid to each other in the live sim rather than only in this
test file.

---

- [ ] **Step 14: Write the failing test — `step()` resolves collisions once per tick**

Append this block to the end of `packages/sim/test/step.test.ts`. That file already
imports the type `SimState` and the values `createState`, `step`, `EIGHT_STARTS` and
`makeTestContext` — no import changes are needed.

```typescript
describe('step — kart collisions after the per-kart loop', () => {
  /**
   * Two karts abreast at the same `s`, one metre apart across the track, with the
   * other six parked far away so they cannot join in. Same `s` matters: the flat
   * query's groundHeight depends only on `s`, so both karts sit at the same height
   * and neither is airborne, and the contact normal is exactly (0, 0, 1).
   * Contact distance is 2 * tuning.kartRadius = 1.8, so 1.0 apart is overlapping.
   */
  function abreastPair(state: SimState): void {
    state.karts[0].position.x = 0
    state.karts[0].position.y = 0
    state.karts[0].position.z = 0
    state.karts[1].position.x = 0
    state.karts[1].position.y = 0
    state.karts[1].position.z = 1
    for (let i = 2; i < state.karts.length; i++) {
      state.karts[i].position.x = 1000 + i * 100
      state.karts[i].position.y = 0
      state.karts[i].position.z = 0
    }
  }

  it('pushes two overlapping karts apart to exactly 2 * kartRadius', () => {
    const ctx = makeTestContext(EIGHT_STARTS)
    const prev = createState(ctx, 7, [0, 0, 0, 0, 0, 0, 0, 0])
    const next = createState(ctx, 7, [0, 0, 0, 0, 0, 0, 0, 0])
    abreastPair(prev)

    step(ctx, prev, next, [], [])

    // Both karts are at rest with no intent, so every per-kart stage is a no-op and
    // resolveKartCollisions is the only thing that can move them. Equal weights
    // (both character 0, weight 1.00), so each yields half of the overlap
    // 1.8 - 1.0 = 0.8 along the +z normal:
    //   kart 0: 0 - 0.4 = -0.4 ; kart 1: 1 + 0.4 = 1.4
    expect(next.karts[0].position.z).toBeCloseTo(-0.4, 12)
    expect(next.karts[1].position.z).toBeCloseTo(1.4, 12)
    expect(next.karts[0].position.x).toBeCloseTo(0, 12)
    expect(next.karts[1].position.x).toBeCloseTo(0, 12)
    // neither kart was closing on the other, so no impulse was applied
    expect(next.karts[0].velocity.z).toBe(0)
    expect(next.karts[1].velocity.z).toBe(0)
    // prev is never written
    expect(prev.karts[0].position.z).toBe(0)
    expect(prev.karts[1].position.z).toBe(1)
  })

  it('applies the impulse to the velocities the per-kart loop just wrote', () => {
    const ctx = makeTestContext(EIGHT_STARTS)
    const prev = createState(ctx, 7, [0, 0, 0, 0, 0, 0, 0, 0])
    const next = createState(ctx, 7, [0, 0, 0, 0, 0, 0, 0, 0])
    abreastPair(prev)
    prev.karts[0].velocity.z = 10  // closing on kart 1
    prev.karts[1].velocity.z = -10 // closing on kart 0

    step(ctx, prev, next, [], [])

    // Stage 4 (stepKart) runs first and damps the lateral component: heading is 0,
    // so right = (0, 0, 1) and the whole velocity is lateral, vf = 0.
    //   damp  = clamp(gripTarmac * TICK_DT, 0, 1) = 14 / 60 = 0.23333333333333334
    //   v0.z  =  10 * (1 - 0.23333333333333334) =  7.666666666666666
    //   v1.z  = -10 * (1 - 0.23333333333333334) = -7.666666666666666
    // then it integrates position with the post-damp velocity:
    //   z0 = 0 + 7.666666666666666 / 60 = 0.12777777777777777
    //   z1 = 1 - 7.666666666666666 / 60 = 0.8722222222222222
    // Then resolveKartCollisions, normal (0, 0, 1), gap 0.7444444444444445:
    //   overlap = 1.8 - 0.7444444444444445 = 1.0555555555555554, split 50/50
    //   z0 = 0.12777777777777777 - 0.5277777777777777 = -0.4
    //   z1 = 0.8722222222222222  + 0.5277777777777777 =  1.4
    //   (equivalently: the pair's centroid stays at 0.5 and the gap becomes 1.8)
    //   vn = -7.666666666666666 - 7.666666666666666 = -15.333333333333332
    //   j  = -(1 + 0.4) * (-15.333333333333332) / (1/1 + 1/1) = 10.733333333333333
    //   v0.z =  7.666666666666666 - 10.733333333333333 = -3.066666666666667
    //   v1.z = -7.666666666666666 + 10.733333333333333 =  3.066666666666667
    expect(next.karts[0].position.z).toBeCloseTo(-0.4, 9)
    expect(next.karts[1].position.z).toBeCloseTo(1.4, 9)
    expect(next.karts[1].position.z - next.karts[0].position.z).toBeCloseTo(1.8, 9)
    expect(next.karts[0].velocity.z).toBeCloseTo(-3.066666666666667, 9)
    expect(next.karts[1].velocity.z).toBeCloseTo(3.066666666666667, 9)
    // separating speed is restitution * closing speed: 0.4 * 15.333333333333332
    expect(next.karts[1].velocity.z - next.karts[0].velocity.z)
      .toBeCloseTo(6.133333333333333, 9)
  })
})
```

- [ ] **Step 15: Run test to verify it fails**

Run: `npx vitest run packages/sim/test/step.test.ts -t "kart collisions after the per-kart loop"`

Expected: FAIL — both tests.
"pushes two overlapping karts apart" reports `expected 0 to be close to -0.4`:
`step()` never calls `resolveKartCollisions`, so the karts pass through each other.
"applies the impulse" reports `expected 0.12777777777777777 to be close to -0.4` —
the kart loop moved it, the collision pass did not.

- [ ] **Step 16: Wire `resolveKartCollisions` into `step()`**

Two edits in `packages/sim/src/step.ts`.

**Edit 1 — the import.** Before:

```typescript
import { stepKart } from './kart'
```

After:

```typescript
import { stepKart } from './kart'
import { resolveKartCollisions } from './collision'
```

**Edit 2 — the call, once per tick, after the per-kart loop closes.** `decayBoost(k)`
is the last statement of the loop body (Task 8 put it there, canonical slot 8) and is
the only occurrence of that call in the file. Before:

```typescript
    decayBoost(k)
  }
}
```

After:

```typescript
    decayBoost(k)
  }

  // Once per tick, after every kart has moved: contact resolution reads the final
  // positions of all eight karts, so it cannot run inside the loop. Contract order
  // from here on is resolveKartCollisions -> updateEntities [Task 12] ->
  // updateItemBoxes [Task 13] -> updatePhase [Task 15].
  resolveKartCollisions(ctx, next)
}
```

- [ ] **Step 17: Run test to verify it passes, then the whole suite**

Run: `npx vitest run packages/sim/test/step.test.ts`

Expected: PASS — 10 tests: 3 from Task 5, 3 from Task 6, 2 from Task 9 and the 2
from Step 14. Tasks 5 and 6 place their karts on the `EIGHT_STARTS` grid, 4 m apart,
which is far outside the 1.8 contact distance, so none of their numbers moves.

Run: `npx vitest run packages/sim && npx tsc --noEmit -p packages/sim`

Expected: PASS — every `packages/sim` test green, `tsc` reports no errors.

- [ ] **Step 18: Commit**

```bash
git add packages/sim/src/collision.ts packages/sim/test/collision.test.ts \
        packages/sim/src/step.ts packages/sim/test/step.test.ts
git commit -m "feat(sim): order-independent kart-vs-kart collision

Sphere overlap at 2 * tuning.kartRadius with an equal-and-opposite impulse
scaled by the two characters' weight stats and tuning.kartRestitution, plus
weight-split positional separation that leaves no pair overlapped and preserves
the weighted centroid.

Pairs are visited by ascending playerId rather than array slot and each of the
four passes is Jacobi, so a kart's slot cannot influence any sign or any float
summation order. Tests assert a pair resolves bit-identically with the karts
swapped and with their playerIds swapped, and that a 3-kart pile-up is
bit-identical across all six slot permutations, singly and over 20 ticks.

step() now calls it once per tick, immediately after the per-kart loop, which is
where the contract's canonical order puts it and what makes karts solid to each
other in the live sim rather than only in the unit tests."
```
