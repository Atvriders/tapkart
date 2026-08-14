/** splitmix32 increment: floor(2^32 / phi). */
export const RNG_GOLDEN = 0x9e3779b9

/** First avalanche multiplier. */
export const RNG_MIX1 = 0x21f0aaad

/** Second avalanche multiplier. */
export const RNG_MIX2 = 0x735a2d97

/**
 * splitmix32 as a pure function of (seed, cursor), returning a double in
 * [0, 1).
 *
 * There is no internal state here on purpose. SimState.rngCursor is the only
 * cursor in the system and only a leader authority advances it, so a shadow
 * authority, a rewind, or a replay can recompute any draw in the race from
 * (raceSeed, rngCursor) alone.
 *
 * Mixing (seed + (cursor + 1) * RNG_GOLDEN) rather than
 * (seed + cursor * RNG_GOLDEN) makes rngAt(seed, c) equal the c-th output of a
 * conventional stateful splitmix32 seeded with `seed`, which advances before it
 * mixes. Math.imul keeps every multiply in int32, and the final `>>> 0` makes
 * the division by 2^32 land in [0, 1).
 */
export function rngAt(seed: number, cursor: number): number {
  let z = (seed + Math.imul(cursor + 1, RNG_GOLDEN)) | 0
  z = Math.imul(z ^ (z >>> 16), RNG_MIX1)
  z = Math.imul(z ^ (z >>> 15), RNG_MIX2)
  z = z ^ (z >>> 15)
  return (z >>> 0) / 4294967296
}
