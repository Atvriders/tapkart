import type { Intent, KartState, SimContext, SimState } from './types'
import { MAX_KARTS } from './types'
import { clamp, lerp, wrapAngle } from './mathutil'
import { rngAt } from './rng'
import { v3len } from './vec3'
import { kartById } from './entity'

/** Seed salt for the fixed per-bot racing-line offset. */
export const BOT_BIAS_SALT = 0x5f3a7b1d
/** Seed salt for the per-bot wander stream. */
export const BOT_NOISE_SALT = 0x2c1b3f91
/** Max fixed offset, as a fraction of usable half-width. */
export const BOT_MAX_BIAS = 0.55
/** Max wander, as a fraction of usable half-width. */
export const BOT_NOISE_AMPLITUDE = 0.18
/** Ticks between wander draws (0.5 s at 60 Hz). */
export const BOT_NOISE_PERIOD = 30
/** Cursor stride between bots in the wander stream. */
export const BOT_NOISE_STRIDE = 4096
/** Lookahead at a standstill, in metres. */
export const BOT_LOOKAHEAD_BASE = 6
/** Extra lookahead metres per m/s of speed. */
export const BOT_LOOKAHEAD_PER_SPEED = 0.35
/** Kart radii of clearance kept off the track edge. */
export const BOT_EDGE_MARGIN = 1.5

/**
 * Fractional part of an arc-normalised s, in [0, 1). Track s wraps: the loop is
 * closed. track.ts keeps its own copy of this; it is not exported, so bot.ts
 * carries its own two-line version rather than widening another module's API.
 */
function wrap01(s: number): number {
  const w = s - Math.floor(s)
  return w === 1 ? 0 : w
}

/**
 * Fixed racing-line offset for one bot, in [-BOT_MAX_BIAS, BOT_MAX_BIAS] as a
 * fraction of usable half-width.
 *
 * The cursor passed to rngAt is the playerId itself — constant for the whole
 * race — and the seed is salted, so this is a pure function of
 * (raceSeed, playerId) that neither reads nor advances state.rngCursor.
 */
export function botLateralBias(state: SimState, playerId: number): number {
  return (rngAt(state.raceSeed ^ BOT_BIAS_SALT, playerId) * 2 - 1) * BOT_MAX_BIAS
}

/**
 * Per-tick wander, so eight bots on the same line do not drive perfectly
 * parallel. Piecewise-linear between one draw per BOT_NOISE_PERIOD ticks;
 * phase p's end draw is phase p+1's start draw, so the result is continuous.
 * Cursors are (playerId * BOT_NOISE_STRIDE + phase): a 3-lap race is a few
 * thousand ticks, i.e. a couple of hundred phases, so bots never collide in
 * the cursor space. state.rngCursor is untouched.
 */
export function botNoise(state: SimState, playerId: number): number {
  const seed = state.raceSeed ^ BOT_NOISE_SALT
  const phase = Math.floor(state.tick / BOT_NOISE_PERIOD)
  const base = playerId * BOT_NOISE_STRIDE + phase
  const n0 = rngAt(seed, base)
  const n1 = rngAt(seed, base + 1)
  const f = (state.tick - phase * BOT_NOISE_PERIOD) / BOT_NOISE_PERIOD
  return (lerp(n0, n1, f) * 2 - 1) * BOT_NOISE_AMPLITUDE
}

/**
 * The arc-normalised s the bot aims at, wrapped into [0, 1).
 *
 * BOT_LOOKAHEAD_BASE and BOT_LOOKAHEAD_PER_SPEED are metres and metres per m/s,
 * while s is a fraction of a lap, so the lookahead distance is divided by
 * totalLength() before it is added. Adding the metres directly would push the
 * aim point most of a lap ahead and make every corner read as a hairpin.
 */
export function botLookaheadS(ctx: SimContext, state: SimState, playerId: number): number {
  const k = kartById(state, playerId)
  if (k === null) return 0
  const speed = v3len(k.velocity)
  const proj = ctx.query.project(k.position)
  const sNow = proj.s // read immediately: project() may return shared scratch
  const total = ctx.query.totalLength()
  if (!(total > 0)) return wrap01(sNow)
  const metres = BOT_LOOKAHEAD_BASE + speed * BOT_LOOKAHEAD_PER_SPEED
  return wrap01(sNow + metres / total)
}

/** Bias + noise, scaled to metres against the width at the lookahead point. */
export function botLateralTarget(ctx: SimContext, state: SimState, playerId: number): number {
  const k = kartById(state, playerId)
  if (k === null) return 0
  const tp = ctx.query.sampleAt(botLookaheadS(ctx, state, playerId))
  const width = tp.width // read immediately: sampleAt() may return shared scratch
  const usable = Math.max(0, width * 0.5 - ctx.tuning.kartRadius * BOT_EDGE_MARGIN)
  const f = clamp(botLateralBias(state, playerId) + botNoise(state, playerId), -1, 1)
  return f * usable
}

/** Lateral acceleration (m/s^2) above which a bot drifts through the corner. */
export const BOT_DRIFT_LAT_ACCEL = 12
/** Lateral acceleration above which a bot also brakes. */
export const BOT_BRAKE_LAT_ACCEL = 26
/** Below this speed a bot never brakes for a corner. */
export const BOT_BRAKE_MIN_SPEED = 25
/** Throttle change per checkpoint-unit of lap-progress deficit. */
export const BOT_RUBBER_GAIN = 0.06
/** Floor on a leading bot's throttle. */
export const BOT_RUBBER_MIN = 0.82
/** Ceiling on throttle: Intent.accel is 0..1 and bots never exceed it. */
export const BOT_RUBBER_MAX = 1
/** Progress deficit past which a bot drives more aggressively. */
export const BOT_AGGRESSIVE_DELTA = 1
/** Drift threshold multiplier while behind: drift earlier, earn more turbos. */
export const BOT_AGGRESSIVE_DRIFT_MUL = 0.7

/**
 * Radians of heading change per metre between the kart and its lookahead
 * point. Speed-independent for a constant-radius corner, because the extra
 * lookahead a faster kart uses scales the arc and the angle together.
 */
export function botCurvature(ctx: SimContext, state: SimState, playerId: number): number {
  const k = kartById(state, playerId)
  if (k === null) return 0
  const proj = ctx.query.project(k.position)
  const sNow = proj.s // read immediately: project() may return shared scratch
  const sLook = botLookaheadS(ctx, state, playerId)
  const total = ctx.query.totalLength()
  // sNow and sLook are both arc-normalised [0, 1). Take the forward-going
  // difference around the closed loop, then convert it to metres: curvature is
  // radians per metre, so the denominator must not be a fraction of a lap.
  let ds = sLook - sNow
  if (ds < 0) ds += 1 // the lookahead wrapped past the start line
  const arc = ds * total
  if (arc < 1e-6) return 0
  const tA = ctx.query.tangentAt(sNow)
  const hA = Math.atan2(tA.z, tA.x) // read immediately: shared scratch
  const tB = ctx.query.tangentAt(sLook)
  const hB = Math.atan2(tB.z, tB.x)
  return Math.abs(wrapAngle(hB - hA)) / arc
}

/**
 * Leading human's lap progress minus this bot's, in checkpoint units.
 * Positive means the bot is behind. 0 when the field is all bots — a kart
 * taken over by a bot after a disconnect has isBot flipped by the net layer,
 * so no `connected` check is needed here.
 */
export function botRubberDelta(ctx: SimContext, state: SimState, playerId: number): number {
  const k = kartById(state, playerId)
  if (k === null) return 0
  const cp = ctx.track.checkpointS.length
  let lead = -Infinity
  for (let i = 0; i < state.karts.length; i++) {
    const o = state.karts[i]
    if (o.isBot) continue
    const p = o.lap.lap * cp + o.lap.checkpointIdx + clamp(o.lap.t, 0, 1)
    if (p > lead) lead = p
  }
  if (lead === -Infinity) return 0
  const mine = k.lap.lap * cp + k.lap.checkpointIdx + clamp(k.lap.t, 0, 1)
  return lead - mine
}

/**
 * Plan-view distance to the closest other kart in front of (wantAhead) or
 * behind `k`, split by the sign of the along-forward component. Infinity when
 * that side is empty. Scans by slot index, so it is order-deterministic.
 */
export function nearestOtherDistance(state: SimState, k: KartState, wantAhead: boolean): number {
  const fx = Math.cos(k.heading)
  const fz = Math.sin(k.heading)
  let best = Infinity
  for (let i = 0; i < state.karts.length; i++) {
    const o = state.karts[i]
    if (o.playerId === k.playerId) continue
    if (o.respawnTicks > 0) continue
    const dx = o.position.x - k.position.x
    const dz = o.position.z - k.position.z
    const along = dx * fx + dz * fz
    if (wantAhead ? along <= 0 : along >= 0) continue
    const d = Math.sqrt(dx * dx + dz * dz)
    if (d < best) best = d
  }
  return best
}

/** Steer output per radian of heading error, before clamping to -1..1. */
export const BOT_STEER_GAIN = 1.6

// One reusable Intent per playerId: botIntent runs every other tick for up to
// eight karts and must not allocate. Callers copy the fields out; resolveInputs
// [Task 15] writes into its own out[] array.
const intentPool: Intent[] = []
for (let i = 0; i < MAX_KARTS; i++) {
  intentPool.push({ tick: 0, steer: 0, accel: 0, brake: false, drift: false, useItem: false })
}

/**
 * Racing-line AI. Deterministic: the same SimState and playerId always give
 * the same Intent, and nothing here reads or advances state.rngCursor.
 *
 * The returned object is pooled per playerId — copy the fields, do not retain
 * the reference. Phase gating and the 30 Hz recompute cadence belong to
 * resolveInputs [Task 15]; this function computes whenever it is called.
 */
export function botIntent(ctx: SimContext, state: SimState, playerId: number): Intent {
  const slot = playerId >= 0 && playerId < MAX_KARTS ? playerId : 0
  const out = intentPool[slot]
  out.tick = state.tick
  out.steer = 0
  out.accel = 0
  out.brake = false
  out.drift = false
  out.useItem = false

  const k = kartById(state, playerId)
  if (k === null) return out

  // Spun out or respawning: no steering authority, but keep the throttle down
  // so the kart pulls away the tick control returns.
  if (k.spinOutTicks > 0 || k.respawnTicks > 0) {
    out.accel = 1
    return out
  }

  // --- aim at a point on the racing line -------------------------------
  const sLook = botLookaheadS(ctx, state, playerId)
  const lat = botLateralTarget(ctx, state, playerId)
  const tp = ctx.query.sampleAt(sLook)
  const px = tp.position.x // read immediately: sampleAt() may return scratch
  const pz = tp.position.z
  const t = ctx.query.tangentAt(sLook)
  const rx = -t.z // right = (-t.z, 0, t.x), positive lateral is to the right
  const rz = t.x
  const rl = Math.sqrt(rx * rx + rz * rz) || 1
  const aimX = px + (rx / rl) * lat
  const aimZ = pz + (rz / rl) * lat

  const desired = Math.atan2(aimZ - k.position.z, aimX - k.position.x)
  const err = wrapAngle(desired - k.heading)
  out.steer = clamp(err * BOT_STEER_GAIN, -1, 1)

  // --- throttle, drift, brake ------------------------------------------
  const delta = botRubberDelta(ctx, state, playerId)
  out.accel = clamp(1 + delta * BOT_RUBBER_GAIN, BOT_RUBBER_MIN, BOT_RUBBER_MAX)

  const speed = v3len(k.velocity)
  const curvature = botCurvature(ctx, state, playerId)
  const latAccel = speed * speed * curvature

  out.brake = latAccel > BOT_BRAKE_LAT_ACCEL && speed > BOT_BRAKE_MIN_SPEED

  const driftGate = delta > BOT_AGGRESSIVE_DELTA
    ? BOT_DRIFT_LAT_ACCEL * BOT_AGGRESSIVE_DRIFT_MUL
    : BOT_DRIFT_LAT_ACCEL
  out.drift = !k.airborne && speed > ctx.tuning.driftMinSpeed && latAccel > driftGate

  out.useItem = botWantsItem(state, k, curvature, delta, speed)
  return out
}

/** Below this speed a boost is wasted. */
export const BOT_BOOST_MIN_SPEED = 18
/** Curvature (rad/m) below which the bot treats the road as straight. */
export const BOT_ITEM_STRAIGHT_CURVATURE = 0.02
/** Firing range for a homing seeker, in metres. */
export const BOT_SEEKER_RANGE = 60
/** Firing range for a straight-fired bolt, in metres. */
export const BOT_BOLT_RANGE = 40
/** Threat range behind which a slick is worth dropping, in metres. */
export const BOT_SLICK_RANGE = 35
/** Threat range behind which a bubble goes up, in metres. */
export const BOT_BUBBLE_RANGE = 30
/** Range ahead within which a surge is worth releasing, in metres. */
export const BOT_SURGE_RANGE = 150
/** Blast range for a charge, either side, in metres. */
export const BOT_CHARGE_RANGE = 12
/** Threat range behind which a blink is worth burning, in metres. */
export const BOT_BLINK_RANGE = 25

/**
 * Simple per-item firing rules. Deterministic and allocation-free: two scans
 * of eight karts and a switch.
 */
function botWantsItem(
  state: SimState,
  k: KartState,
  curvature: number,
  delta: number,
  speed: number,
): boolean {
  if (k.item === 'none') return false
  const ahead = nearestOtherDistance(state, k, true)
  const behind = nearestOtherDistance(state, k, false)
  switch (k.item) {
    case 'boost':
      return speed > BOT_BOOST_MIN_SPEED && !k.airborne
        && curvature < BOT_ITEM_STRAIGHT_CURVATURE
    case 'blink':
      return !k.airborne && (behind < BOT_BLINK_RANGE || delta > BOT_AGGRESSIVE_DELTA)
    case 'seeker':
      return ahead < BOT_SEEKER_RANGE
    case 'bolt':
      return ahead < BOT_BOLT_RANGE
    case 'slick':
      return behind < BOT_SLICK_RANGE
    case 'bubble':
      return behind < BOT_BUBBLE_RANGE
    case 'surge':
      return ahead < BOT_SURGE_RANGE
    case 'charge':
      return Math.min(ahead, behind) < BOT_CHARGE_RANGE
    default:
      return false
  }
}
