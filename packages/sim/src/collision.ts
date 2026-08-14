import type { KartState, SimContext, SimState } from './types'
import { MAX_KARTS } from './types'
import { motionLocked } from './recovery'

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

/**
 * A kart being teleported by `updateRecovery` (Task 9) takes no part in collision:
 * this pass writes `position` and `velocity`, and both belong to recovery for the
 * whole respawn under the motion-lock rule in step.ts.
 *
 * `motionLocked` is recovery.ts's definition of the predicate this used to
 * re-inline as `respawnTicks === 0`. The two agree for every reachable value —
 * `respawnTicks` is written only by `beginRespawn` (clamped at 0) and `stepRespawn`
 * (which decrements only above 1 and assigns 0 at 1), so it is never negative.
 */
function collidable(k: KartState): boolean {
  return !motionLocked(k)
}
