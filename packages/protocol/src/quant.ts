/** Half-width of the world in metres; ±WORLD_HALF encloses every shipped track with
 * margin (the largest generated track spans x in [-82, 722] - contract §4). */
export const WORLD_HALF = 1024

/**
 * Uniform quantisation step size for a `bits`-wide field spanning [min, max].
 * `2^bits` distinct codes exist but only `2^bits - 1` *gaps* separate them, so the
 * step - and the denominator here - is `(2^bits - 1)`, not `2^bits` (contract §4).
 */
export function quantStep(min: number, max: number, bits: number): number {
  return (max - min) / ((1 << bits) - 1)
}

/** One quantised field's shape: linear range plus bit width. Frozen per-instance so
 * `Object.freeze(Q)` (shallow) is not the only thing standing between a caller and
 * a mutated table - each field object is frozen too. */
export interface QuantField {
  readonly min: number
  readonly max: number
  readonly bits: number
}

/**
 * The six continuous fields of contract §4's per-kart table - the only ones with a
 * real step and epsilon. `position` and `velocity` are listed once each and reused
 * for x, y and z by whoever encodes them (Task 6). The fourteen exact/enum fields
 * (spinOutTicks .. playerId, isBot and connected each with their own bit) have no
 * entry here: they carry no quantisation noise, so an epsilon for them would invite
 * comparing an integer with a tolerance (contract §4). Task 6 owns their bit widths
 * directly, as local constants.
 */
export interface QuantTable {
  readonly position: QuantField
  readonly velocity: QuantField
  readonly heading: QuantField
  readonly angularVelocity: QuantField
  readonly driftCharge: QuantField
  readonly t: QuantField
}

export interface EpsilonTable {
  readonly position: number
  readonly velocity: number
  readonly heading: number
  readonly angularVelocity: number
  readonly driftCharge: number
  readonly t: number
}

function qf(min: number, max: number, bits: number): QuantField {
  return Object.freeze({ min, max, bits })
}

/** Contract §4's six continuous rows, transcribed field by field. Frozen two levels
 * deep: the table itself and every QuantField inside it. */
export const Q: QuantTable = Object.freeze({
  position: qf(-WORLD_HALF, WORLD_HALF, 16),
  velocity: qf(-64, 64, 12),
  heading: qf(-Math.PI, Math.PI, 12),
  angularVelocity: qf(-16, 16, 10),
  driftCharge: qf(0, 255, 8),
  t: qf(0, 1, 10),
})

/** Contract §4's Epsilon column for the six continuous rows. Every value here
 * exceeds its own quantStep - see the last test in this task's file, and Task 7's
 * exhaustive version of the same check. Do not tune any of these down (contract §0):
 * lowering an epsilon to make a failing downstream test pass defeats the reason the
 * epsilon exists in the first place -- it exists so quantisation noise alone can
 * never trigger a correction and make the kart visibly buzz (contract §5). If a
 * downstream test fails, fix the code that produced the mismatch, never this table. */
export const EPS: EpsilonTable = Object.freeze({
  position: 0.05,
  velocity: 0.05,
  heading: 0.0025,
  angularVelocity: 0.05,
  driftCharge: 1.5,
  t: 0.002,
})
