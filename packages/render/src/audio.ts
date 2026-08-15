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
    // A popped shield is the only impact a RaceView witnesses: kart-kart
    // contact is not in the view at all.
    if (a.shielded && !b.shielded) emitCue(out, 'impact', b.playerId, WEIGHT_IMPACT * g, pan)
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
