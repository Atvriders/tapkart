// PURE, plus one ADAPTER-SHAPED interface (AudioBackend) whose only Plan 3
// implementation is a no-op. No DOM, no Web Audio, no clock, no `three` (Q26).
import { MAX_KARTS, clamp } from '@tapkart/sim'
import type { KartView, RaceView } from './types'
import { countdownLabelFor } from './hud'

export type AudioCueKind =
  | 'engine'
  | 'skid'
  | 'impact'
  | 'itemPickup'
  | 'itemUse'
  | 'boost'
  | 'spinOut'
  | 'respawn'
  | 'lapCross'
  | 'countdownBeep'
  | 'finish'

export interface AudioCue {
  kind: AudioCueKind
  playerId: number
  intensity: number // 0..1
  pan: number // -1 (left) .. 1 (right), from the camera's right axis
}

export interface AudioModel {
  engineFreqHz: number // LOCAL kart only
  engineGain: number // 0..1
  skidGain: number // 0..1
  cues: AudioCue[] // fixed length MAX_AUDIO_CUES; only [0, cueCount) is live
  cueCount: number
}

export const MAX_AUDIO_CUES = 16

// Voice shaping. Module-private on purpose: these are Plan 5's to tune once
// something is audible, and none of them is part of this package's surface.
const ENGINE_IDLE_HZ = 60
const ENGINE_HZ_PER_MPS = 4.5
const ENGINE_IDLE_GAIN = 0.15
const ENGINE_GAIN_PER_MPS = 0.02
const SKID_GAIN_PER_MPS = 0.03
/** Metres over which a one-shot from another kart fades to silence. */
const CUE_FALLOFF_M = 60

/**
 * KART-TO-KART CONTACT (P3-R61). `sim` resolves a kart collision positionally
 * and emits no AuthEvent for it, so the loudest thing that happens in a kart
 * race reaches this module only as a shape in the same two-view delta every
 * other cue is derived from. The three constants below are that shape's
 * definition, and each is fixed by a measured property of `resolveKartCollisions`
 * rather than by taste. Measurements are from 36 000 ticks of eight-kart racing
 * on the oval fixture plus hand-placed adversarial pairs; see the block comment
 * on `buildAudioModel`'s contact loop for the discriminator itself.
 */

/**
 * Metres. Beyond this the pair is not touching and nothing they do to each
 * other's velocity is contact.
 *
 * `resolveKartCollisions` separates a pair to exactly `2 * kartRadius` = 1.8 m
 * with the shipped tuning, but a RaceView's positions are interpolated across
 * the tick while its velocities are the tick's endpoint value, so the frame that
 * carries the impulse can read the pair up to one tick of approach wider than
 * the diameter. Measured worst case over 24 000 ticks, with closing speeds up to
 * 41.8 m/s: 2.265 m. 2.5 m clears that and still means "these two are touching":
 * the only pairs that read below it and are NOT taking an impulse this tick are
 * pairs already resting against each other, and the mutual test below is what
 * tells those apart rather than this range.
 */
const CONTACT_RANGE_M = 2.5
const CONTACT_RANGE_SQ = CONTACT_RANGE_M * CONTACT_RANGE_M

/**
 * m/s. The normal-direction velocity change EACH kart must gain AWAY from the
 * other before the pair counts as a bump.
 *
 * The mutual-and-opposite test below already excludes everything the environment
 * does to two karts at once, because a shared effect — a boost pad, a ramp, a
 * landing, a surface change — pushes both karts the SAME way, and one shared
 * direction projects onto the line between them with opposite signs, so one of
 * the two values is always negative. What that test does not exclude is two
 * karts arranged nose to nose, each independently slowing itself: both then
 * genuinely accelerate away from the other. The throttle/brake axis bounds that
 * at `brakeRate * TICK_DT` = 48/60 = 0.8 m/s per kart per tick, and the worst
 * hand-built arrangement of it — two karts 2.45 m apart, facing each other, both
 * braking, never touching — measures exactly 0.800. 0.9 is above the axis's
 * ceiling, so no amount of driving reaches it in a tick.
 *
 * At the shipped restitution it costs only the lightest grazes: a contact is
 * announced from about 1.7 m/s of closing speed upward (1.3 m/s between equal
 * weights). Over 36 000 ticks it heard 54 of the 55 distinct contacts whose peak
 * closing speed was at least 1.5 m/s, the miss being a 1.90 m/s graze, and only
 * twice in those 55 did it fire more than once for the same contact — sustained
 * rubbing stays silent by itself, because traction rather than the tick's
 * micro-impulse dominates a resting pair's delta.
 */
const CONTACT_MIN_PUSH_MPS = 0.9

/**
 * m/s. The combined push-apart (both karts' normal velocity change added) at
 * which a bump is as loud as this model gets.
 *
 * The sum is the closing speed made observable: `resolveKartCollisions` gives
 * the pair `(1 + kartRestitution) * closingSpeed` of separation split between
 * them by weight, so the two shares add back to a fixed multiple of the closing
 * speed no matter how the weights fell. 20 m/s combined is a 14.3 m/s closing
 * hit with the shipped restitution; measured contact peaks ran from 1.6 m/s to
 * 41.8 m/s of closing speed with a median near 8.9, so this leaves ordinary
 * trading-paint in the audible middle and reserves full scale for a real shunt.
 */
const CONTACT_FULL_PUSH_MPS = 20

const WEIGHT_LAP_CROSS = 1
const WEIGHT_ITEM_PICKUP = 0.6
const WEIGHT_ITEM_USE = 0.7
const WEIGHT_BOOST = 1
const WEIGHT_SPIN_OUT = 1
const WEIGHT_RESPAWN = 0.5
const WEIGHT_IMPACT = 1

export function createAudioModel(): AudioModel {
  const cues: AudioCue[] = []
  for (let i = 0; i < MAX_AUDIO_CUES; i++) {
    // 'engine' is the inert placeholder kind: it names a continuous voice and
    // is never emitted as a one-shot, so a dead slot cannot be mistaken for a
    // live cue even if a backend ignored cueCount.
    cues.push({ kind: 'engine', playerId: -1, intensity: 0, pan: 0 })
  }
  return { engineFreqHz: 0, engineGain: 0, skidGain: 0, cues, cueCount: 0 }
}

/** Appends one cue, or drops it when the fixed pool is full. Never grows. */
function emitCue(
  out: AudioModel,
  kind: AudioCueKind,
  playerId: number,
  intensity: number,
  pan: number,
): void {
  if (out.cueCount >= MAX_AUDIO_CUES) return
  const c = out.cues[out.cueCount]
  c.kind = kind
  c.playerId = playerId
  c.intensity = clamp(intensity, 0, 1)
  c.pan = clamp(pan, -1, 1)
  out.cueCount++
}

/** Direction cosine of `k` along the local kart's right axis, `(-sin h, 0, cos h)`. */
function panFor(local: KartView | null, k: KartView): number {
  if (local === null || local === k) return 0
  const dx = k.position.x - local.position.x
  const dz = k.position.z - local.position.z
  const d = Math.sqrt(dx * dx + dz * dz)
  if (d <= 0) return 0
  const rx = -Math.sin(local.heading)
  const rz = Math.cos(local.heading)
  return clamp((dx * rx + dz * rz) / d, -1, 1)
}

/** Linear plan-view falloff from the local kart. 1 with no local seat. */
function gainFor(local: KartView | null, k: KartView): number {
  if (local === null || local === k) return 1
  const dx = k.position.x - local.position.x
  const dz = k.position.z - local.position.z
  return clamp(1 - Math.sqrt(dx * dx + dz * dz) / CUE_FALLOFF_M, 0, 1)
}

/**
 * Derives continuous levels from `view` and one-shots from the delta between
 * `prev` and `view`. SOLE WRITER of every AudioModel field. Pure and
 * assertable: a test drives two views and asserts exactly which cues fire.
 * Cues beyond MAX_AUDIO_CUES in one frame are dropped, never grown.
 *
 * PRECONDITION: `prev` and `view` are the session's TWO RaceViews, alternated
 * per frame with the swap AFTER audio.apply. With one view, prev === view,
 * every delta is empty, and no cue can ever fire. This function retains no
 * reference to either argument - next frame, `view` comes back as `prev`.
 */
export function buildAudioModel(prev: RaceView, view: RaceView, out: AudioModel): void {
  const pid = view.localPlayerId
  const hasSeat = pid >= 0 && pid < MAX_KARTS
  const local = hasSeat ? view.karts[pid] : null

  // --- continuous levels: the LOCAL kart's engine and skid, and nothing else.
  if (local !== null && local.source !== 'absent') {
    out.engineFreqHz = ENGINE_IDLE_HZ + local.speed * ENGINE_HZ_PER_MPS
    out.engineGain =
      local.respawnTicks > 0
        ? 0
        : clamp(ENGINE_IDLE_GAIN + local.speed * ENGINE_GAIN_PER_MPS, 0, 1)
    out.skidGain =
      local.driftActive || local.spinOutTicks > 0
        ? clamp(local.speed * SKID_GAIN_PER_MPS, 0, 1)
        : 0
  } else {
    out.engineFreqHz = 0
    out.engineGain = 0
    out.skidGain = 0
  }

  // --- one-shots. Fixed emission order, so a busy frame drops deterministically.
  out.cueCount = 0

  const prevLabel = countdownLabelFor(
    prev.phase,
    prev.countdownTicksLeft,
    Math.max(0, prev.tick - prev.raceStartTick),
  )
  const label = countdownLabelFor(
    view.phase,
    view.countdownTicksLeft,
    Math.max(0, view.tick - view.raceStartTick),
  )
  if (label !== '' && label !== prevLabel) emitCue(out, 'countdownBeep', pid, 1, 0)
  if (prev.phase !== 'finished' && view.phase === 'finished') {
    emitCue(out, 'finish', pid, 1, 0)
  }

  for (let i = 0; i < MAX_KARTS; i++) {
    const a = prev.karts[i]
    const b = view.karts[i]
    // A seat absent in either view has stale fields, not news.
    if (a.source === 'absent' || b.source === 'absent') continue

    const pan = panFor(local, b)
    const g = gainFor(local, b)

    if (b.lap > a.lap) emitCue(out, 'lapCross', b.playerId, WEIGHT_LAP_CROSS * g, pan)
    if (a.item === 'none' && b.item !== 'none') {
      emitCue(out, 'itemPickup', b.playerId, WEIGHT_ITEM_PICKUP * g, pan)
    }
    if (a.item !== 'none' && b.item === 'none') {
      emitCue(out, 'itemUse', b.playerId, WEIGHT_ITEM_USE * g, pan)
    }
    if (b.boostTicks > a.boostTicks) emitCue(out, 'boost', b.playerId, WEIGHT_BOOST * g, pan)
    if (b.spinOutTicks > a.spinOutTicks) {
      emitCue(out, 'spinOut', b.playerId, WEIGHT_SPIN_OUT * g, pan)
    }
    if (b.respawnTicks > a.respawnTicks) {
      emitCue(out, 'respawn', b.playerId, WEIGHT_RESPAWN * g, pan)
    }
    // A popped shield is one of the two impacts a RaceView witnesses. The other
    // is kart-to-kart contact, which is not a per-seat edge and is derived by
    // the pair loop below.
    if (a.shielded && !b.shielded) emitCue(out, 'impact', b.playerId, WEIGHT_IMPACT * g, pan)
  }

  /*
   * KART-TO-KART CONTACT (P3-R61), emitted after every per-seat cue so that the
   * existing drop order is untouched, and in ascending (i, j) so a busy frame
   * still drops deterministically.
   *
   * THE DISCRIMINATOR. `resolveKartCollisions` gives a contacting pair, and only
   * a contacting pair, all four of these at once:
   *
   *   1. Neither kart is motion-locked. `collidable()` there is `!motionLocked`,
   *      i.e. `respawnTicks === 0`, so a respawning kart is not in a collision by
   *      definition — and a respawn is the largest velocity discontinuity in the
   *      game, since `beginRespawn` zeroes the whole vector in one tick. Two karts
   *      that drive out of bounds nose to nose respawn together and each appears
   *      to leap away from the other: measured 29.4 m/s of push apiece, thirty
   *      times the floor. This gate, not the floor, is what silences that.
   *   2. They are within contact range of each other.
   *   3. The impulse is `-n * ja` for one kart and `+n * jb` for the other, so
   *      BOTH gain velocity ALONG THE LINE BETWEEN THEM and AWAY from each other.
   *      This is the half a wall cannot fake. Everything the track does to two
   *      karts at once — a boost pad, a ramp launch, a landing, a surface change,
   *      gravity — moves both the same way, and one shared direction projects
   *      onto the line between two karts with OPPOSITE signs, so a shared effect
   *      can never make both of these positive. It is the geometry, not the
   *      magnitude, that rules those out, which is why a 7 m/s ramp launch taken
   *      side by side is silent while a 1.7 m/s graze is not.
   *   4. Each share clears `CONTACT_MIN_PUSH_MPS`, which is above what the
   *      throttle/brake axis can produce in a tick — the one arrangement where
   *      two karts independently accelerate away from each other without touching.
   *
   * Nothing here is retained and nothing is allocated: 28 pairs of scalar work.
   */
  for (let i = 0; i < MAX_KARTS; i++) {
    const ai = prev.karts[i]
    const bi = view.karts[i]
    if (ai.source === 'absent' || bi.source === 'absent') continue
    if (ai.respawnTicks > 0 || bi.respawnTicks > 0) continue
    const divx = bi.velocity.x - ai.velocity.x
    const divy = bi.velocity.y - ai.velocity.y
    const divz = bi.velocity.z - ai.velocity.z

    for (let j = i + 1; j < MAX_KARTS; j++) {
      const aj = prev.karts[j]
      const bj = view.karts[j]
      if (aj.source === 'absent' || bj.source === 'absent') continue
      if (aj.respawnTicks > 0 || bj.respawnTicks > 0) continue

      // The line between them, in the newer view. Exactly coincident karts have
      // no line and are skipped: sim's own +X fallback for that case is a
      // determinism device, not a direction anything can be heard from.
      const dx = bj.position.x - bi.position.x
      const dy = bj.position.y - bi.position.y
      const dz = bj.position.z - bi.position.z
      const d2 = dx * dx + dy * dy + dz * dz
      if (d2 <= 0 || d2 > CONTACT_RANGE_SQ) continue
      const d = Math.sqrt(d2)
      const nx = dx / d
      const ny = dy / d
      const nz = dz / d

      // Seat i is pushed along -n, seat j along +n, so both of these are the
      // kart's own gain AWAY from its partner.
      const pushI = -(divx * nx + divy * ny + divz * nz)
      if (pushI < CONTACT_MIN_PUSH_MPS) continue
      const pushJ =
        (bj.velocity.x - aj.velocity.x) * nx
        + (bj.velocity.y - aj.velocity.y) * ny
        + (bj.velocity.z - aj.velocity.z) * nz
      if (pushJ < CONTACT_MIN_PUSH_MPS) continue

      // One cue for the pair, not one per kart: a bump is one sound. It names
      // the kart the listener is NOT, so a player who is hit hears who hit them,
      // and pan and falloff are taken from that kart — which is within contact
      // range of the contact itself, so it is the contact's own position to
      // within a kart length.
      const other = i === pid ? j : i
      const k = view.karts[other]
      emitCue(
        out,
        'impact',
        other,
        WEIGHT_IMPACT * gainFor(local, k) * ((pushI + pushJ) / CONTACT_FULL_PUSH_MPS),
        panFor(local, k),
      )
    }
  }
}

/**
 * Device/user preference, NOT a property of the audio the race is producing.
 * R38: volume and mute must never be fields of AudioModel - a model that
 * carries a setting means moving a slider re-plans a frame.
 */
export interface AudioConfig {
  masterGain: number // 0..1
  enabled: boolean // false mutes without tearing the backend down
}

/** ADAPTER boundary. Plan 5 puts Web Audio behind this and touches nothing else. */
export interface AudioBackend {
  apply(model: AudioModel): void
  /** R38: the seam carries its config from day one, so a live settings change
   *  has somewhere to go and Plan 5 needs no widened concrete type and no
   *  amendment to the contract. Called on every Settings change, not per frame. */
  setConfig(cfg: AudioConfig): void
  close(): void
}

/**
 * The v1 backend. Implements all three methods trivially: Q26 defers audible
 * audio to Plan 5 and keeps the seam authored, because building a seam is hours
 * and retrofitting one is a refactor. The parameters are underscore-prefixed so
 * `noUnusedParameters` accepts a method that genuinely does nothing.
 */
export const nullAudioBackend: AudioBackend = {
  apply(_model: AudioModel): void {},
  setConfig(_cfg: AudioConfig): void {},
  close(): void {},
}
