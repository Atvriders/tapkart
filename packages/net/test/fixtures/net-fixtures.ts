import type { SimContext } from '@tapkart/sim'
import { buildTrackQuery } from '@tapkart/sim'
import { makeCharacters, makeOvalTrack, makeTuning } from '../../../sim/test/fixtures/track-fixtures'
import type { LoopbackOptions } from '../../src/loopback'
import { makeLoopbackPair } from '../../src/loopback'

/**
 * A SimContext over the Plan 1 golden oval track (packages/sim/test/fixtures
 * /track-fixtures.ts's makeOvalTrack) with Plan 1's base tuning table and its
 * 8 fixture characters. Reached by relative path, not the @tapkart/sim
 * package specifier: these three functions live under sim's test/fixtures,
 * which sim's own production barrel never re-exports -- see this task's
 * Interfaces block for the full justification.
 */
export function makeNetContext(isLeader = true): SimContext {
  const track = makeOvalTrack()
  return {
    track,
    query: buildTrackQuery(track),
    tuning: makeTuning(),
    characters: makeCharacters(),
    isLeader,
  }
}

/** Spec §8's convergence and zero-corrections conditions. */
const DEFAULT_LOOPBACK_OPTIONS: LoopbackOptions = {
  latencyMs: 150,
  jitterMs: 50,
  lossRate: 0.05,
  seed: 0xc0ffee,
}

export function makeLossyPair(
  overrides?: Partial<LoopbackOptions>,
): ReturnType<typeof makeLoopbackPair> {
  return makeLoopbackPair({ ...DEFAULT_LOOPBACK_OPTIONS, ...overrides })
}
