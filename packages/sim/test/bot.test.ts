import { describe, it, expect } from 'vitest'
import {
  BOT_BOLT_RANGE,
  BOT_BOOST_MIN_SPEED,
  BOT_BUBBLE_RANGE,
  BOT_CHARGE_RANGE,
  BOT_LOOKAHEAD_BASE,
  BOT_LOOKAHEAD_PER_SPEED,
  BOT_MAX_BIAS,
  BOT_NOISE_AMPLITUDE,
  BOT_NOISE_PERIOD,
  BOT_RUBBER_GAIN,
  BOT_RUBBER_MIN,
  BOT_SEEKER_RANGE,
  BOT_SLICK_RANGE,
  BOT_STEER_GAIN,
  botCurvature,
  botIntent,
  botLateralBias,
  botLateralTarget,
  botLookaheadS,
  botNoise,
  botRubberDelta,
  nearestOtherDistance,
} from '../src/bot'
import { cloneState, createState } from '../src/state'
import { makeCircleTrack, makeContext, makeStraightTrack } from './fixtures/track-fixtures'

const ALL_CHARACTERS = [0, 1, 2, 3, 4, 5, 6, 7]

/**
 * Puts kart `id` on the centreline at arc-normalised `s` (a fraction of a lap,
 * in [0, 1) — never metres), facing along the track at `speed` m/s.
 *
 * STRAIGHT_S = 0.1 is the station every straight-track test below uses.
 * makeStraightTrack's control points 1, 2 and 3 are (150, 0, 0), (300, 0, 0),
 * (450, 0, 0) — evenly spaced and collinear — so the Catmull-Rom spline between
 * them is exactly straight and exactly arc-uniform:
 *   x = 150 + (s * total - 150.403834),   total = totalLength() = 1828.3236243
 * Control point 1 sits at s = 0.0822632 and control point 3 at s = 0.2463480, so
 * s = 0.1 (x = 182.428528494678) leaves 450 - 182.429 = 267.6 m of that span
 * still ahead — far more than any lookahead used here. Across it the tangent is
 * the exact constant (1, 0, 0) and the right vector, right = (-t.z, 0, t.x), is
 * the exact constant (0, 0, 1): curvature is exactly 0 and a lateral offset
 * moves purely in +z.
 *
 * On makeCircleTrack, total = 628.1351367 and s advances uniformly around the
 * radius-100 circle, so any s is as good as any other.
 */
const STRAIGHT_S = 0.1

function placeOnLine(ctx: ReturnType<typeof makeContext>, state: ReturnType<typeof createState>,
                     id: number, s: number, speed: number): void {
  const tp = ctx.query.sampleAt(s)
  const px = tp.position.x
  const py = tp.position.y
  const pz = tp.position.z
  const t = ctx.query.tangentAt(s)
  const heading = Math.atan2(t.z, t.x) // contract: h = atan2(dir.z, dir.x)
  const k = state.karts[id]
  k.position.x = px
  k.position.y = py
  k.position.z = pz
  k.heading = heading
  k.velocity.x = Math.cos(heading) * speed
  k.velocity.y = 0
  k.velocity.z = Math.sin(heading) * speed
  k.airborne = false
  k.spinOutTicks = 0
  k.respawnTicks = 0
  k.item = 'none'
}

describe('botLateralBias', () => {
  it('is a bounded, deterministic function of (raceSeed, playerId)', () => {
    const ctx = makeContext(makeStraightTrack())
    const state = createState(ctx, 12345, ALL_CHARACTERS)
    expect(BOT_MAX_BIAS).toBe(0.55)
    for (let id = 0; id < 8; id++) {
      const a = botLateralBias(state, id)
      const b = botLateralBias(state, id)
      expect(a).toBe(b)
      expect(a).toBeGreaterThanOrEqual(-0.55)
      expect(a).toBeLessThanOrEqual(0.55)
    }
  })

  it('never advances state.rngCursor, whatever the tick', () => {
    const ctx = makeContext(makeStraightTrack())
    const state = createState(ctx, 12345, ALL_CHARACTERS)
    state.rngCursor = 7
    for (let tick = 0; tick < 200; tick++) {
      state.tick = tick
      for (let id = 0; id < 8; id++) {
        botLateralBias(state, id)
        botNoise(state, id)
      }
    }
    expect(state.rngCursor).toBe(7)
  })

  it('gives all eight bots different lines', () => {
    const ctx = makeContext(makeStraightTrack())
    const state = createState(ctx, 12345, ALL_CHARACTERS)
    const biases = new Set<number>()
    for (let id = 0; id < 8; id++) biases.add(botLateralBias(state, id))
    // Eight independent splitmix32 draws. Equal values would mean the mixer is
    // broken, not that the bots are meant to share a line.
    expect(biases.size).toBe(8)
  })

  it('changes with the race seed', () => {
    const ctx = makeContext(makeStraightTrack())
    const a = createState(ctx, 12345, ALL_CHARACTERS)
    const b = createState(ctx, 6789, ALL_CHARACTERS)
    let differing = 0
    for (let id = 0; id < 8; id++) {
      if (botLateralBias(a, id) !== botLateralBias(b, id)) differing++
    }
    expect(differing).toBe(8)
  })
})

describe('botNoise', () => {
  it('stays inside the amplitude and moves in small steps', () => {
    const ctx = makeContext(makeStraightTrack())
    const state = createState(ctx, 12345, ALL_CHARACTERS)
    expect(BOT_NOISE_AMPLITUDE).toBe(0.18)
    expect(BOT_NOISE_PERIOD).toBe(30)
    // The noise is a piecewise-linear ramp between one draw per 30-tick phase,
    // and phase p's end draw is phase p+1's start draw, so it is continuous.
    // Worst-case step = 2 * 0.18 / 30 = 0.012 per tick.
    let prev = 0
    for (let tick = 0; tick <= 120; tick++) {
      state.tick = tick
      const n = botNoise(state, 4)
      expect(n).toBeGreaterThanOrEqual(-0.18)
      expect(n).toBeLessThanOrEqual(0.18)
      if (tick > 0) expect(Math.abs(n - prev)).toBeLessThanOrEqual(0.012 + 1e-9)
      prev = n
    }
  })

  it('actually varies inside a single phase', () => {
    const ctx = makeContext(makeStraightTrack())
    const state = createState(ctx, 12345, ALL_CHARACTERS)
    const seen = new Set<number>()
    for (let tick = 0; tick < 30; tick++) {
      state.tick = tick
      seen.add(botNoise(state, 4))
    }
    // 30 distinct interpolation fractions on a ramp of non-zero slope.
    expect(seen.size).toBe(30)
  })

  it('gives the eight bots independent noise streams at the same tick', () => {
    const ctx = makeContext(makeStraightTrack())
    const state = createState(ctx, 12345, ALL_CHARACTERS)
    state.tick = 17
    const seen = new Set<number>()
    for (let id = 0; id < 8; id++) seen.add(botNoise(state, id))
    expect(seen.size).toBe(8)
  })
})

describe('botLateralTarget', () => {
  it('scales bias plus noise into metres and stays inside the usable width', () => {
    const ctx = makeContext(makeStraightTrack())
    const state = createState(ctx, 12345, ALL_CHARACTERS)
    state.tick = 0
    const targets = new Set<number>()
    for (let id = 0; id < 8; id++) {
      const sLook = ctx.query.totalLength() > 0
        ? ctx.query.project(state.karts[id].position).s
        : 0
      const tp = ctx.query.sampleAt(sLook)
      // usable = width/2 - kartRadius * BOT_EDGE_MARGIN = width/2 - 0.9 * 1.5
      const usable = Math.max(0, tp.width * 0.5 - 0.9 * 1.5)
      const target = botLateralTarget(ctx, state, id)
      // |bias| + |noise| <= 0.55 + 0.18 = 0.73 of the usable half-width.
      expect(Math.abs(target)).toBeLessThanOrEqual(usable * 0.73 + 1e-9)
      targets.add(target)
    }
    expect(targets.size).toBe(8)
  })
})

describe('botLookaheadS', () => {
  it('adds metres of lookahead as a fraction of a lap, not as raw s', () => {
    const ctx = makeContext(makeStraightTrack())
    const state = createState(ctx, 12345, ALL_CHARACTERS)
    const total = ctx.query.totalLength() // 1828.3236243
    expect(BOT_LOOKAHEAD_BASE).toBe(6)
    expect(BOT_LOOKAHEAD_PER_SPEED).toBe(0.35)

    // At rest the lookahead is BOT_LOOKAHEAD_BASE = 6 m, which is
    // 6 / 1828.3236243 = 0.0032816947 of a lap:
    // 0.1 + 0.0032816947 = 0.1032816947
    placeOnLine(ctx, state, 3, STRAIGHT_S, 0)
    expect(botLookaheadS(ctx, state, 3)).toBeCloseTo(STRAIGHT_S + 6 / total, 9)
    expect(botLookaheadS(ctx, state, 3)).toBeCloseTo(0.1032816947, 9)

    // At 30 m/s it is 6 + 30 * 0.35 = 16.5 m, i.e.
    // 16.5 / 1828.3236243 = 0.0090246605 of a lap:
    // 0.1 + 0.0090246605 = 0.1090246605
    placeOnLine(ctx, state, 3, STRAIGHT_S, 30)
    expect(botLookaheadS(ctx, state, 3)).toBeCloseTo(STRAIGHT_S + 16.5 / total, 9)
    expect(botLookaheadS(ctx, state, 3)).toBeCloseTo(0.1090246605, 9)
  })

  it('wraps past the start line and never leaves [0, 1)', () => {
    const ctx = makeContext(makeCircleTrack())
    const state = createState(ctx, 12345, ALL_CHARACTERS)
    const total = ctx.query.totalLength() // 628.1351367
    // 6 + 44 * 0.35 = 21.4 m = 21.4 / 628.1351367 = 0.0340691019 of a lap, so
    // from s = 0.99 the aim point is 1.0240691019, which wraps to 0.0240691019.
    placeOnLine(ctx, state, 3, 0.99, 44)
    const s = botLookaheadS(ctx, state, 3)
    expect(s).toBeCloseTo(0.99 + 21.4 / total - 1, 9)
    expect(s).toBeCloseTo(0.0240691019, 9)
    expect(s).toBeGreaterThanOrEqual(0)
    expect(s).toBeLessThan(1)
  })
})

/**
 * Parks every kart except `keep` far away so proximity tests are clean.
 * `placeOnLine` and `STRAIGHT_S` are already at the top of this file, from the
 * first test block.
 */
function scatter(state: ReturnType<typeof createState>, keep: number[]): void {
  for (let i = 0; i < state.karts.length; i++) {
    if (keep.indexOf(i) >= 0) continue
    state.karts[i].position.x = 0
    state.karts[i].position.z = 5000 + i * 100
    state.karts[i].respawnTicks = 0
  }
}

describe('botCurvature', () => {
  it('is exactly 0 on the straight span of the straight fixture', () => {
    const ctx = makeContext(makeStraightTrack())
    const state = createState(ctx, 12345, ALL_CHARACTERS)
    // s = 0.1 is x = 182.43 and the 16.5 m lookahead reaches x = 198.93; both
    // sit between control points 1 (x = 150) and 3 (x = 450), where the four
    // spline control values are collinear and evenly spaced, so the tangent is
    // the exact constant (1, 0, 0). hB - hA is therefore exactly 0, not merely
    // small, and 0 / 16.5 m = 0.
    placeOnLine(ctx, state, 2, STRAIGHT_S, 30)
    expect(botCurvature(ctx, state, 2)).toBe(0)
  })

  it('is ~1/R on the radius-100 circle, independent of speed', () => {
    const ctx = makeContext(makeCircleTrack())
    const state = createState(ctx, 12345, ALL_CHARACTERS)
    // The 16-point Catmull-Rom circle measures 628.1351367 m round instead of
    // 628.3185307, so the heading swept per metre is very slightly over 1/100.
    // At 44 m/s the arc is 6 + 44 * 0.35 = 21.4 m and the curvature comes out
    // at 0.0099571; at 15 m/s the arc is 11.25 m and it comes out at 0.0103463.
    // The band below is 1/R = 0.01 +/- 20%, which both clear comfortably.
    placeOnLine(ctx, state, 2, 0, 44)
    const fast = botCurvature(ctx, state, 2)
    placeOnLine(ctx, state, 2, 0, 15)
    const slow = botCurvature(ctx, state, 2)
    expect(fast).toBeCloseTo(0.0099571, 6)
    expect(slow).toBeCloseTo(0.0103463, 6)
    expect(fast).toBeGreaterThan(0.008)
    expect(fast).toBeLessThan(0.012)
    expect(slow).toBeGreaterThan(0.008)
    expect(slow).toBeLessThan(0.012)
  })
})

describe('botRubberDelta', () => {
  it('is 0 when nobody in the field is human', () => {
    const ctx = makeContext(makeStraightTrack())
    const state = createState(ctx, 12345, ALL_CHARACTERS)
    for (let i = 0; i < state.karts.length; i++) state.karts[i].isBot = true
    state.karts[1].lap.lap = 2
    expect(botRubberDelta(ctx, state, 3)).toBe(0)
  })

  it('is negative for a bot ahead of the leading human', () => {
    const ctx = makeContext(makeStraightTrack())
    const state = createState(ctx, 12345, ALL_CHARACTERS)
    for (let i = 0; i < state.karts.length; i++) state.karts[i].isBot = true
    state.karts[0].isBot = false
    // Same lap, so the checkpoint-count term cancels:
    // human 0 at cp 1 t 0.25, bot 1 at cp 3 t 0.50
    // delta = (1 + 0.25) - (3 + 0.50) = -2.25
    state.karts[0].lap.lap = 2
    state.karts[0].lap.checkpointIdx = 1
    state.karts[0].lap.t = 0.25
    state.karts[1].lap.lap = 2
    state.karts[1].lap.checkpointIdx = 3
    state.karts[1].lap.t = 0.5
    expect(botRubberDelta(ctx, state, 1)).toBeCloseTo(-2.25, 10)
  })

  it('is positive and lap-scaled for a bot behind the leading human', () => {
    const ctx = makeContext(makeStraightTrack())
    const state = createState(ctx, 12345, ALL_CHARACTERS)
    for (let i = 0; i < state.karts.length; i++) state.karts[i].isBot = true
    state.karts[0].isBot = false
    state.karts[0].lap.lap = 2
    state.karts[0].lap.checkpointIdx = 3
    state.karts[0].lap.t = 0.5
    state.karts[1].lap.lap = 0
    state.karts[1].lap.checkpointIdx = 1
    state.karts[1].lap.t = 0.25
    // delta = 2*cp + (3 - 1) + (0.5 - 0.25) = 2*cp + 2.25
    const cp = ctx.track.checkpointS.length
    expect(botRubberDelta(ctx, state, 1)).toBeCloseTo(2 * cp + 2.25, 10)
  })

  it('takes the leading human when there are several', () => {
    const ctx = makeContext(makeStraightTrack())
    const state = createState(ctx, 12345, ALL_CHARACTERS)
    for (let i = 0; i < state.karts.length; i++) state.karts[i].isBot = true
    state.karts[0].isBot = false
    state.karts[6].isBot = false
    state.karts[0].lap.lap = 1
    state.karts[0].lap.checkpointIdx = 0
    state.karts[0].lap.t = 0
    state.karts[6].lap.lap = 1
    state.karts[6].lap.checkpointIdx = 4
    state.karts[6].lap.t = 0
    state.karts[1].lap.lap = 1
    state.karts[1].lap.checkpointIdx = 1
    state.karts[1].lap.t = 0
    // Leading human is kart 6 at cp 4: delta = 4 - 1 = 3
    expect(botRubberDelta(ctx, state, 1)).toBeCloseTo(3, 10)
    expect(BOT_RUBBER_GAIN).toBe(0.06)
    expect(BOT_RUBBER_MIN).toBe(0.82)
  })
})

describe('nearestOtherDistance', () => {
  it('splits the field by the kart forward axis and measures in plan view', () => {
    const ctx = makeContext(makeStraightTrack())
    const state = createState(ctx, 12345, ALL_CHARACTERS)
    scatter(state, [3, 1, 4])
    const k = state.karts[3]
    k.position.x = 0
    k.position.y = 0
    k.position.z = 0
    k.heading = 0 // forward = (1, 0, 0)
    state.karts[1].position.x = 30 // 30 m ahead
    state.karts[1].position.z = 0
    state.karts[4].position.x = -12 // 12 m behind
    state.karts[4].position.z = 0
    expect(nearestOtherDistance(state, k, true)).toBeCloseTo(30, 9)
    expect(nearestOtherDistance(state, k, false)).toBeCloseTo(12, 9)
  })

  it('returns Infinity when the requested side is empty, and skips respawners', () => {
    const ctx = makeContext(makeStraightTrack())
    const state = createState(ctx, 12345, ALL_CHARACTERS)
    scatter(state, [3, 1])
    const k = state.karts[3]
    k.position.x = 0
    k.position.z = 0
    k.heading = 0
    state.karts[1].position.x = 20
    state.karts[1].position.z = 0
    expect(nearestOtherDistance(state, k, false)).toBe(Infinity)
    state.karts[1].respawnTicks = 10
    expect(nearestOtherDistance(state, k, true)).toBe(Infinity)
  })
})

describe('botIntent — steering', () => {
  it('stamps the current tick', () => {
    const ctx = makeContext(makeStraightTrack())
    const state = createState(ctx, 12345, ALL_CHARACTERS)
    state.tick = 123
    placeOnLine(ctx, state, 3, STRAIGHT_S, 20)
    expect(botIntent(ctx, state, 3).tick).toBe(123)
  })

  it('steers toward its own lateral target with the contract sign', () => {
    const ctx = makeContext(makeStraightTrack())
    const state = createState(ctx, 12345, ALL_CHARACTERS)
    state.tick = 0
    for (let id = 0; id < 8; id++) {
      // speed 0 -> the lookahead is exactly BOT_LOOKAHEAD_BASE = 6 m, i.e.
      // 6 / 1828.3236243 = 0.0032816947 of a lap past STRAIGHT_S. Both ends sit
      // on the exactly-straight span, so the aim point is exactly 6 m ahead in
      // x (5.99999995 after the projector's refine tolerance) and `lat` m across
      // in z, measured from a kart at z = 0 with heading 0.
      placeOnLine(ctx, state, id, STRAIGHT_S, 0)
      const lat = botLateralTarget(ctx, state, id)
      const expected = clampTo1(Math.atan2(lat, BOT_LOOKAHEAD_BASE) * BOT_STEER_GAIN)
      const intent = botIntent(ctx, state, id)
      // The only error is the 5e-8 m the ternary-search projector leaves in x,
      // which moves the aim angle by under 1e-8 rad and the steer by under
      // 2e-8. Precision 6 (5e-7) covers that with three orders to spare.
      expect(intent.steer).toBeCloseTo(expected, 6)
      expect(Math.sign(intent.steer)).toBe(Math.sign(lat))
    }
    expect(BOT_STEER_GAIN).toBe(1.6)
  })

  it('saturates back toward the line from far off it', () => {
    const ctx = makeContext(makeStraightTrack())
    const state = createState(ctx, 12345, ALL_CHARACTERS)
    state.tick = 0
    placeOnLine(ctx, state, 3, STRAIGHT_S, 0)
    const centreZ = state.karts[3].position.z // exactly 0 on this span
    // 40 m right of the line, 6 m of lookahead. The aim point's own lateral is
    // at most 0.73 * (20/2 - 0.9 * 1.5) = 6.315 m, so the cross-track term is at
    // least 40 - 6.315 = 33.685 m and the aim angle is at least
    // atan2(33.685, 6) = 1.394 rad. Times BOT_STEER_GAIN 1.6 that is 2.23, well
    // past the clamp — and past the 0.625 rad at which the clamp first bites.
    // The kart is still nearest the front straight (z = 0 is 40 m away, the
    // return leg at z = 120 is 80 m), so it projects onto the same span.
    state.karts[3].position.z = centreZ + 40
    expect(botIntent(ctx, state, 3).steer).toBe(-1)
    state.karts[3].position.z = centreZ - 40
    expect(botIntent(ctx, state, 3).steer).toBe(1)
  })
})

function clampTo1(v: number): number {
  return v < -1 ? -1 : v > 1 ? 1 : v
}

describe('botIntent — throttle, drift and brake', () => {
  it('holds full throttle when behind and eases off when ahead', () => {
    const ctx = makeContext(makeStraightTrack())
    const state = createState(ctx, 12345, ALL_CHARACTERS)
    for (let i = 0; i < state.karts.length; i++) state.karts[i].isBot = true
    state.karts[0].isBot = false
    placeOnLine(ctx, state, 1, STRAIGHT_S, 20)

    // Bot 2.25 checkpoint-units ahead of the human:
    // accel = 1 + (-2.25 * 0.06) = 1 - 0.135 = 0.865
    state.karts[0].lap.lap = 2
    state.karts[0].lap.checkpointIdx = 1
    state.karts[0].lap.t = 0.25
    state.karts[1].lap.lap = 2
    state.karts[1].lap.checkpointIdx = 3
    state.karts[1].lap.t = 0.5
    expect(botIntent(ctx, state, 1).accel).toBeCloseTo(0.865, 10)

    // Far ahead: 1 + (-50 * 0.06) = -2, clamped to BOT_RUBBER_MIN.
    state.karts[0].lap.lap = 0
    state.karts[0].lap.checkpointIdx = 0
    state.karts[0].lap.t = 0
    state.karts[1].lap.lap = 50
    expect(botIntent(ctx, state, 1).accel).toBe(0.82)

    // Behind: clamped up to BOT_RUBBER_MAX, which is full throttle.
    state.karts[0].lap.lap = 50
    state.karts[1].lap.lap = 0
    expect(botIntent(ctx, state, 1).accel).toBe(1)
  })

  it('does not drift or brake on a straight', () => {
    const ctx = makeContext(makeStraightTrack())
    const state = createState(ctx, 12345, ALL_CHARACTERS)
    for (let i = 0; i < state.karts.length; i++) state.karts[i].isBot = true
    // At 40 m/s the lookahead is 6 + 40 * 0.35 = 20 m, so the aim point is at
    // x = 202.43 — still inside the straight span, where curvature is exactly 0
    // and latAccel = 40 * 40 * 0 = 0.
    placeOnLine(ctx, state, 2, STRAIGHT_S, 40)
    const intent = botIntent(ctx, state, 2)
    expect(intent.drift).toBe(false)
    expect(intent.brake).toBe(false)
  })

  it('drifts through the circle above the lateral-acceleration threshold', () => {
    const ctx = makeContext(makeCircleTrack())
    const state = createState(ctx, 12345, ALL_CHARACTERS)
    for (let i = 0; i < state.karts.length; i++) state.karts[i].isBot = true
    // latAccel = speed^2 * botCurvature, and botCurvature on this fixture is the
    // 0.0099571 / 0.0103463 measured in the botCurvature test above.
    // 44 m/s -> 1936 * 0.0099571 = 19.277 > BOT_DRIFT_LAT_ACCEL (12) -> drift
    // 15 m/s ->  225 * 0.0103463 =  2.328 < 12                       -> no drift
    placeOnLine(ctx, state, 2, 0, 44)
    expect(botIntent(ctx, state, 2).drift).toBe(true)
    placeOnLine(ctx, state, 2, 0, 15)
    expect(botIntent(ctx, state, 2).drift).toBe(false)
    // Below tuning.driftMinSpeed (8) it never drifts, whatever the corner.
    placeOnLine(ctx, state, 2, 0, 4)
    expect(botIntent(ctx, state, 2).drift).toBe(false)
  })

  it('never drifts while airborne', () => {
    const ctx = makeContext(makeCircleTrack())
    const state = createState(ctx, 12345, ALL_CHARACTERS)
    for (let i = 0; i < state.karts.length; i++) state.karts[i].isBot = true
    placeOnLine(ctx, state, 2, 0, 44)
    state.karts[2].airborne = true
    expect(botIntent(ctx, state, 2).drift).toBe(false)
  })

  it('brakes only above the brake threshold', () => {
    const ctx = makeContext(makeCircleTrack())
    const state = createState(ctx, 12345, ALL_CHARACTERS)
    for (let i = 0; i < state.karts.length; i++) state.karts[i].isBot = true
    // 44 m/s -> latAccel 19.277 < BOT_BRAKE_LAT_ACCEL (26) -> no brake
    placeOnLine(ctx, state, 2, 0, 44)
    expect(botIntent(ctx, state, 2).brake).toBe(false)
    // 60 m/s -> curvature 0.0098710 over a 6 + 60 * 0.35 = 27 m lookahead, so
    // latAccel = 3600 * 0.0098710 = 35.536 > 26, and 60 > BOT_BRAKE_MIN_SPEED
    // (25). 60 m/s is above anything the karts can reach; this exercises the
    // threshold directly.
    placeOnLine(ctx, state, 2, 0, 60)
    expect(botIntent(ctx, state, 2).brake).toBe(true)
  })

  it('goes limp but keeps the throttle down while spun out or respawning', () => {
    const ctx = makeContext(makeCircleTrack())
    const state = createState(ctx, 12345, ALL_CHARACTERS)
    placeOnLine(ctx, state, 2, 0, 44)
    state.karts[2].item = 'boost'
    state.karts[2].spinOutTicks = 20
    const spun = botIntent(ctx, state, 2)
    expect(spun.steer).toBe(0)
    expect(spun.drift).toBe(false)
    expect(spun.useItem).toBe(false)
    expect(spun.accel).toBe(1)

    state.karts[2].spinOutTicks = 0
    state.karts[2].respawnTicks = 40
    const dead = botIntent(ctx, state, 2)
    expect(dead.steer).toBe(0)
    expect(dead.useItem).toBe(false)
  })
})

describe('botIntent — determinism', () => {
  it('gives an identical Intent for the same state and playerId', () => {
    const ctx = makeContext(makeStraightTrack())
    const a = createState(ctx, 12345, ALL_CHARACTERS)
    const b = createState(ctx, 12345, ALL_CHARACTERS)
    a.tick = 77
    // Eight distinct stations, 0.1 .. 0.17 of a lap, all on the straight span.
    for (let id = 0; id < 8; id++) placeOnLine(ctx, a, id, STRAIGHT_S + id * 0.01, 22)
    cloneState(a, b)
    for (let id = 0; id < 8; id++) {
      // botIntent returns a pooled object, so snapshot before comparing.
      const first = { ...botIntent(ctx, a, id) }
      const second = { ...botIntent(ctx, b, id) }
      expect(second).toEqual(first)
    }
  })

  it('NEVER advances state.rngCursor', () => {
    const ctx = makeContext(makeStraightTrack())
    const state = createState(ctx, 12345, ALL_CHARACTERS)
    state.rngCursor = 7
    for (let id = 0; id < 8; id++) placeOnLine(ctx, state, id, STRAIGHT_S + id * 0.01, 22)
    for (let tick = 0; tick < 200; tick++) {
      state.tick = tick
      for (let id = 0; id < 8; id++) botIntent(ctx, state, id)
    }
    expect(state.rngCursor).toBe(7)
  })

  it('returns a separate pooled Intent per playerId', () => {
    const ctx = makeContext(makeStraightTrack())
    const state = createState(ctx, 12345, ALL_CHARACTERS)
    for (let id = 0; id < 8; id++) placeOnLine(ctx, state, id, STRAIGHT_S, 0)
    const a = botIntent(ctx, state, 2)
    const b = botIntent(ctx, state, 5)
    expect(a).not.toBe(b)
    expect(botIntent(ctx, state, 2)).toBe(a)
  })
})

/**
 * Straight track, kart 3 on the centreline at (250, 0, 0) heading 0
 * (forward = +X), every other kart parked 5 km away. `neighbourAt` puts one
 * kart at a signed distance along +X of kart 3, so `nearestOtherDistance`
 * returns exactly |alongX|.
 *
 * x = 250 is inside the exactly-straight span between control points 1
 * (x = 150) and 3 (x = 450). Even the longest lookahead used here — 6 + 30*0.35
 * = 16.5 m, reaching x = 266.5 — stays inside it, so botCurvature is exactly 0
 * and every "is this a straight?" gate is satisfied. (The old (0, 0, 0) is
 * control point 0, where the spline is bent by control point 11 at
 * (-140, 0, 60) and the tangent is atan2(-30, 145) = -0.204 rad, not 0.)
 *
 * The scattered karts sit at x = 0, so from x = 250 they all read as *behind*
 * at ~5 km — far outside every range constant below, which top out at 150 m.
 */
const ITEM_SCENARIO_X = 250

function itemScenario(speed: number) {
  const ctx = makeContext(makeStraightTrack())
  const state = createState(ctx, 12345, ALL_CHARACTERS)
  for (let i = 0; i < state.karts.length; i++) state.karts[i].isBot = true
  scatter(state, [3])
  const k = state.karts[3]
  k.position.x = ITEM_SCENARIO_X
  k.position.y = 0
  k.position.z = 0
  k.heading = 0
  k.velocity.x = speed
  k.velocity.y = 0
  k.velocity.z = 0
  k.airborne = false
  k.spinOutTicks = 0
  k.respawnTicks = 0
  k.item = 'none'
  const neighbourAt = (alongX: number): void => {
    state.karts[6].position.x = ITEM_SCENARIO_X + alongX
    state.karts[6].position.y = 0
    state.karts[6].position.z = 0
    state.karts[6].respawnTicks = 0
  }
  return { ctx, state, k, neighbourAt }
}

describe('botIntent — item heuristics', () => {
  it('holds fire with no item', () => {
    const { ctx, state, k } = itemScenario(30)
    k.item = 'none'
    expect(botIntent(ctx, state, 3).useItem).toBe(false)
  })

  it('fires boost on a straight above the minimum speed only', () => {
    expect(BOT_BOOST_MIN_SPEED).toBe(18)
    const fast = itemScenario(30)
    fast.k.item = 'boost'
    expect(botIntent(fast.ctx, fast.state, 3).useItem).toBe(true)
    const slow = itemScenario(10)
    slow.k.item = 'boost'
    expect(botIntent(slow.ctx, slow.state, 3).useItem).toBe(false)
    const air = itemScenario(30)
    air.k.item = 'boost'
    air.k.airborne = true
    expect(botIntent(air.ctx, air.state, 3).useItem).toBe(false)
  })

  it('fires a seeker at a kart ahead inside 60 m', () => {
    expect(BOT_SEEKER_RANGE).toBe(60)
    const near = itemScenario(30)
    near.k.item = 'seeker'
    near.neighbourAt(50)
    expect(botIntent(near.ctx, near.state, 3).useItem).toBe(true)
    const far = itemScenario(30)
    far.k.item = 'seeker'
    far.neighbourAt(70)
    expect(botIntent(far.ctx, far.state, 3).useItem).toBe(false)
    const behind = itemScenario(30)
    behind.k.item = 'seeker'
    behind.neighbourAt(-20) // behind does not count for a seeker
    expect(botIntent(behind.ctx, behind.state, 3).useItem).toBe(false)
  })

  it('fires a bolt at a kart ahead inside 40 m', () => {
    expect(BOT_BOLT_RANGE).toBe(40)
    const near = itemScenario(30)
    near.k.item = 'bolt'
    near.neighbourAt(30)
    expect(botIntent(near.ctx, near.state, 3).useItem).toBe(true)
    const far = itemScenario(30)
    far.k.item = 'bolt'
    far.neighbourAt(50)
    expect(botIntent(far.ctx, far.state, 3).useItem).toBe(false)
  })

  it('drops a slick for a kart behind inside 35 m', () => {
    expect(BOT_SLICK_RANGE).toBe(35)
    const near = itemScenario(30)
    near.k.item = 'slick'
    near.neighbourAt(-30)
    expect(botIntent(near.ctx, near.state, 3).useItem).toBe(true)
    const far = itemScenario(30)
    far.k.item = 'slick'
    far.neighbourAt(-40)
    expect(botIntent(far.ctx, far.state, 3).useItem).toBe(false)
    const ahead = itemScenario(30)
    ahead.k.item = 'slick'
    ahead.neighbourAt(10) // no threat behind, keep the slick
    expect(botIntent(ahead.ctx, ahead.state, 3).useItem).toBe(false)
  })

  it('raises a bubble for a kart behind inside 30 m', () => {
    expect(BOT_BUBBLE_RANGE).toBe(30)
    const near = itemScenario(30)
    near.k.item = 'bubble'
    near.neighbourAt(-25)
    expect(botIntent(near.ctx, near.state, 3).useItem).toBe(true)
    const far = itemScenario(30)
    far.k.item = 'bubble'
    far.neighbourAt(-35)
    expect(botIntent(far.ctx, far.state, 3).useItem).toBe(false)
  })

  it('detonates a charge only at close quarters, either side', () => {
    expect(BOT_CHARGE_RANGE).toBe(12)
    const ahead = itemScenario(30)
    ahead.k.item = 'charge'
    ahead.neighbourAt(10)
    expect(botIntent(ahead.ctx, ahead.state, 3).useItem).toBe(true)
    const behind = itemScenario(30)
    behind.k.item = 'charge'
    behind.neighbourAt(-10)
    expect(botIntent(behind.ctx, behind.state, 3).useItem).toBe(true)
    const far = itemScenario(30)
    far.k.item = 'charge'
    far.neighbourAt(15)
    expect(botIntent(far.ctx, far.state, 3).useItem).toBe(false)
  })

  it('releases a surge when anyone is ahead, and holds it when leading', () => {
    const someone = itemScenario(30)
    someone.k.item = 'surge'
    someone.neighbourAt(100)
    expect(botIntent(someone.ctx, someone.state, 3).useItem).toBe(true)
    const alone = itemScenario(30)
    alone.k.item = 'surge'
    alone.neighbourAt(-100) // only traffic is behind
    expect(botIntent(alone.ctx, alone.state, 3).useItem).toBe(false)
  })

  it('blinks under pressure from behind, or when well behind on progress', () => {
    const pressured = itemScenario(30)
    pressured.k.item = 'blink'
    pressured.neighbourAt(-20) // inside BOT_BLINK_RANGE (25)
    expect(botIntent(pressured.ctx, pressured.state, 3).useItem).toBe(true)

    const clear = itemScenario(30)
    clear.k.item = 'blink'
    clear.neighbourAt(-40)
    expect(botIntent(clear.ctx, clear.state, 3).useItem).toBe(false)

    // Nobody near, but 2 checkpoints down on the leading human
    // (delta 2 > BOT_AGGRESSIVE_DELTA 1) -> burn it to catch up.
    const trailing = itemScenario(30)
    trailing.k.item = 'blink'
    trailing.neighbourAt(-40)
    trailing.state.karts[6].isBot = false
    trailing.state.karts[6].lap.lap = 0
    trailing.state.karts[6].lap.checkpointIdx = 3
    trailing.state.karts[6].lap.t = 0
    trailing.state.karts[3].lap.lap = 0
    trailing.state.karts[3].lap.checkpointIdx = 1
    trailing.state.karts[3].lap.t = 0
    expect(botRubberDelta(trailing.ctx, trailing.state, 3)).toBeCloseTo(2, 10)
    expect(botIntent(trailing.ctx, trailing.state, 3).useItem).toBe(true)
  })

  it('never fires while spun out', () => {
    const { ctx, state, k, neighbourAt } = itemScenario(30)
    k.item = 'charge'
    neighbourAt(5)
    k.spinOutTicks = 12
    expect(botIntent(ctx, state, 3).useItem).toBe(false)
  })
})
