// PURE. Contract §9.2. This module plans audio operations without a clock,
// DOM, or AudioContext; the adapter only executes this list.

import type { AudioConfig, AudioCueKind, AudioModel } from '../audio'

export type AudioOpKind = 'setEngine' | 'setSkid' | 'setMaster' | 'oneShot' | 'silence'

export interface AudioOp {
  kind: AudioOpKind
  cue: AudioCueKind | 'none'
  freqHz: number
  gain: number
  pan: number
  durationMs: number
}

export interface AudioOpList {
  ops: AudioOp[]
  count: number
}

export interface OneShotSpec {
  waveform: 'sine' | 'square' | 'sawtooth' | 'triangle' | 'noise'
  startFreqHz: number
  endFreqHz: number
  durationMs: number
  peakGain: number
  attackMs: number
  releaseMs: number
  filterHz: number
}

/** Total over AudioCueKind. The two continuous voices have zero peak gain and
 * are never emitted as one-shots; their waveform/filter fields configure the
 * continuous graph in web.ts. These reasoned defaults still require the owner
 * listening pass documented by Plan 5.
 */
export const ONE_SHOT_SPECS: Readonly<Record<AudioCueKind, OneShotSpec>> = {
  // Sawtooth plus a gentle low-pass retains a small-engine timbre on a phone.
  engine: {
    waveform: 'sawtooth',
    startFreqHz: 0,
    endFreqHz: 0,
    durationMs: 0,
    peakGain: 0,
    attackMs: 0,
    releaseMs: 0,
    filterHz: 1800,
  },
  // Upper-mid band-passed noise reads as tyre friction on a small speaker.
  skid: {
    waveform: 'noise',
    startFreqHz: 0,
    endFreqHz: 0,
    durationMs: 0,
    peakGain: 0,
    attackMs: 0,
    releaseMs: 0,
    filterHz: 3200,
  },
  // Hard onset and quick fall make a collision readable without masking play.
  impact: {
    waveform: 'square',
    startFreqHz: 220,
    endFreqHz: 60,
    durationMs: 180,
    peakGain: 0.9,
    attackMs: 2,
    releaseMs: 140,
    filterHz: 1200,
  },
  // Gains rise; losses fall, so the event grammar is learnable without text.
  itemPickup: {
    waveform: 'triangle',
    startFreqHz: 660,
    endFreqHz: 1320,
    durationMs: 120,
    peakGain: 0.5,
    attackMs: 4,
    releaseMs: 90,
    filterHz: 6000,
  },
  itemUse: {
    waveform: 'sawtooth',
    startFreqHz: 880,
    endFreqHz: 440,
    durationMs: 140,
    peakGain: 0.55,
    attackMs: 3,
    releaseMs: 110,
    filterHz: 4000,
  },
  // A long bright rise overlaps the speed change it announces.
  boost: {
    waveform: 'sawtooth',
    startFreqHz: 300,
    endFreqHz: 1200,
    durationMs: 320,
    peakGain: 0.7,
    attackMs: 8,
    releaseMs: 220,
    filterHz: 5000,
  },
  // The boost shape inverted makes the negative state unmistakable.
  spinOut: {
    waveform: 'triangle',
    startFreqHz: 700,
    endFreqHz: 140,
    durationMs: 500,
    peakGain: 0.6,
    attackMs: 6,
    releaseMs: 380,
    filterHz: 2500,
  },
  // A softer sine rise says the player is back without implying a reward.
  respawn: {
    waveform: 'sine',
    startFreqHz: 200,
    endFreqHz: 800,
    durationMs: 260,
    peakGain: 0.45,
    attackMs: 10,
    releaseMs: 200,
    filterHz: 5000,
  },
  // Flat, repeatable pitches make lap/countdown events countable.
  lapCross: {
    waveform: 'square',
    startFreqHz: 990,
    endFreqHz: 990,
    durationMs: 90,
    peakGain: 0.5,
    attackMs: 2,
    releaseMs: 70,
    filterHz: 5000,
  },
  countdownBeep: {
    waveform: 'sine',
    startFreqHz: 880,
    endFreqHz: 880,
    durationMs: 110,
    peakGain: 0.6,
    attackMs: 3,
    releaseMs: 80,
    filterHz: 4000,
  },
  // The longest musical rise is reserved for the last thing a race says.
  finish: {
    waveform: 'sine',
    startFreqHz: 880,
    endFreqHz: 1760,
    durationMs: 420,
    peakGain: 0.75,
    attackMs: 5,
    releaseMs: 320,
    filterHz: 6000,
  },
}

export const MAX_AUDIO_OPS = 32
export const MAX_ONE_SHOTS_PER_FRAME = 4
export const ONE_SHOT_VOICE_LIMIT = 12
export const ENGINE_SMOOTHING_MS = 60

const CONTINUOUS_OPS = 3

export function createAudioOpList(): AudioOpList {
  const ops: AudioOp[] = []
  for (let i = 0; i < MAX_AUDIO_OPS; i++) {
    ops.push({ kind: 'silence', cue: 'none', freqHz: 0, gain: 0, pan: 0, durationMs: 0 })
  }
  return { ops, count: 0 }
}

function clamp(value: number, lo: number, hi: number): number {
  if (Number.isNaN(value)) return lo
  if (value < lo) return lo
  if (value > hi) return hi
  return value
}

function write(
  out: AudioOpList,
  at: number,
  kind: AudioOpKind,
  cue: AudioCueKind | 'none',
  freqHz: number,
  gain: number,
  pan: number,
  durationMs: number,
): void {
  const op = out.ops[at]
  op.kind = kind
  op.cue = cue
  op.freqHz = freqHz
  op.gain = clamp(gain, 0, 1)
  op.pan = clamp(pan, -1, 1)
  op.durationMs = durationMs
}

/** Sole writer of a preallocated AudioOpList; never mutates the model. */
export function planAudio(model: AudioModel, cfg: Readonly<AudioConfig>, out: AudioOpList): void {
  if (!cfg.enabled) {
    write(out, 0, 'silence', 'none', 0, 0, 0, 0)
    out.count = 1
    return
  }

  write(out, 0, 'setMaster', 'none', 0, cfg.masterGain, 0, 0)
  write(out, 1, 'setEngine', 'none', model.engineFreqHz, model.engineGain, 0, 0)
  write(out, 2, 'setSkid', 'none', 0, model.skidGain, 0, 0)

  let at = CONTINUOUS_OPS
  let started = 0
  for (let i = 0; i < model.cueCount && started < MAX_ONE_SHOTS_PER_FRAME; i++) {
    const cue = model.cues[i]
    const spec = ONE_SHOT_SPECS[cue.kind]
    if (spec.peakGain === 0) continue
    write(
      out,
      at,
      'oneShot',
      cue.kind,
      spec.startFreqHz,
      spec.peakGain * cue.intensity,
      cue.pan,
      spec.durationMs,
    )
    at++
    started++
  }

  out.count = at
}
