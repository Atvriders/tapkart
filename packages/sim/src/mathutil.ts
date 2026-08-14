const TWO_PI = Math.PI * 2

export function clamp(v: number, lo: number, hi: number): number {
  if (v < lo) return lo
  if (v > hi) return hi
  return v
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

/**
 * Wraps an angle into the half-open range (-PI, PI].
 *
 * Upper-inclusive on purpose: a kart travelling along -x has heading
 * Math.atan2(0, -1) === Math.PI exactly, and it must stay at +PI rather than
 * oscillating between +PI and -PI on successive ticks.
 *
 * `a % TWO_PI` already lands in (-2*PI, 2*PI), so one adjustment is enough.
 * The trailing `+ 0` turns -0 into +0; without it wrapAngle(-2*PI) would be -0,
 * and statesEqual compares every scalar with Object.is, for which
 * Object.is(-0, 0) is false.
 */
export function wrapAngle(a: number): number {
  let r = a % TWO_PI
  if (r <= -Math.PI) r += TWO_PI
  else if (r > Math.PI) r -= TWO_PI
  return r + 0
}
