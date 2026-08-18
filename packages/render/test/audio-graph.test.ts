import { describe, expect, it } from 'vitest'
import {
  createAudioModel,
  MAX_AUDIO_CUES,
  type AudioConfig,
  type AudioCue,
  type AudioCueKind,
  type AudioModel,
} from '../src/audio'
import * as audioModule from '../src/audio'
import {
  createAudioOpList,
  ENGINE_SMOOTHING_MS,
  MAX_AUDIO_OPS,
  MAX_ONE_SHOTS_PER_FRAME,
  ONE_SHOT_SPECS,
  ONE_SHOT_VOICE_LIMIT,
  planAudio,
  type AudioOp,
} from '../src/audio/graph'

const ALL_KINDS: AudioCueKind[] = [
  'engine',
  'skid',
  'impact',
  'itemPickup',
  'itemUse',
  'boost',
  'spinOut',
  'respawn',
  'lapCross',
  'countdownBeep',
  'finish',
]
const CONTINUOUS: AudioCueKind[] = ['engine', 'skid']
const ON: AudioConfig = { masterGain: 0.7, enabled: true }
const OFF: AudioConfig = { masterGain: 0.7, enabled: false }

function cue(kind: AudioCueKind, intensity = 1, pan = 0): AudioCue {
  return { kind, playerId: 0, intensity, pan }
}

function modelWith(cues: AudioCue[]): AudioModel {
  const model = createAudioModel()
  model.engineFreqHz = 220
  model.engineGain = 0.5
  model.skidGain = 0.25
  for (let i = 0; i < cues.length && i < MAX_AUDIO_CUES; i++) model.cues[i] = cues[i]
  model.cueCount = Math.min(cues.length, MAX_AUDIO_CUES)
  return model
}

function live(list: { ops: AudioOp[]; count: number }): AudioOp[] {
  return list.ops.slice(0, list.count)
}

describe('module layout (§9.1)', () => {
  it("keeps bare ./audio resolving to Plan 3's pure model", () => {
    expect(typeof audioModule.createAudioModel).toBe('function')
    expect((audioModule as Record<string, unknown>).planAudio).toBeUndefined()
  })
})

describe('the graph constants', () => {
  it('are §9.2\'s four values', () => {
    expect(MAX_AUDIO_OPS).toBe(32)
    expect(MAX_ONE_SHOTS_PER_FRAME).toBe(4)
    expect(ONE_SHOT_VOICE_LIMIT).toBe(12)
    expect(ENGINE_SMOOTHING_MS).toBe(60)
  })

  it('leaves room for continuous ops plus a full frame of one-shots', () => {
    expect(MAX_AUDIO_OPS).toBeGreaterThanOrEqual(3 + MAX_ONE_SHOTS_PER_FRAME)
  })

  it('lets more voices live than one frame can start', () => {
    expect(ONE_SHOT_VOICE_LIMIT).toBeGreaterThan(MAX_ONE_SHOTS_PER_FRAME)
  })
})

describe('ONE_SHOT_SPECS', () => {
  it('is total over AudioCueKind', () => {
    for (const kind of ALL_KINDS) expect(ONE_SHOT_SPECS[kind], kind).toBeDefined()
    expect(Object.keys(ONE_SHOT_SPECS).sort()).toEqual([...ALL_KINDS].sort())
  })

  it('gives the two continuous voices peakGain 0', () => {
    for (const kind of CONTINUOUS) expect(ONE_SHOT_SPECS[kind].peakGain, kind).toBe(0)
  })

  it('gives every real cue an audible peak gain inside [0, 1]', () => {
    for (const kind of ALL_KINDS) {
      const spec = ONE_SHOT_SPECS[kind]
      expect(spec.peakGain, kind).toBeGreaterThanOrEqual(0)
      expect(spec.peakGain, kind).toBeLessThanOrEqual(1)
      if (!CONTINUOUS.includes(kind)) expect(spec.peakGain, kind).toBeGreaterThan(0)
    }
  })

  it('gives every real cue an envelope that fits inside its positive duration', () => {
    for (const kind of ALL_KINDS) {
      if (CONTINUOUS.includes(kind)) continue
      const spec = ONE_SHOT_SPECS[kind]
      expect(spec.durationMs, kind).toBeGreaterThan(0)
      expect(spec.attackMs + spec.releaseMs, kind).toBeLessThanOrEqual(spec.durationMs)
    }
  })

  it('gives every real cue positive frequencies and filter cutoff', () => {
    for (const kind of ALL_KINDS) {
      if (CONTINUOUS.includes(kind)) continue
      const spec = ONE_SHOT_SPECS[kind]
      expect(spec.startFreqHz, kind).toBeGreaterThan(0)
      expect(spec.endFreqHz, kind).toBeGreaterThan(0)
      expect(spec.filterHz, kind).toBeGreaterThan(0)
    }
  })

  it('keeps every frequency in a phone-speaker range', () => {
    for (const kind of ALL_KINDS) {
      const spec = ONE_SHOT_SPECS[kind]
      for (const hz of [spec.startFreqHz, spec.endFreqHz, spec.filterHz]) {
        if (hz === 0) continue
        expect(hz, kind).toBeGreaterThanOrEqual(20)
        expect(hz, kind).toBeLessThanOrEqual(20_000)
      }
    }
  })
})

describe('planAudio — §12.2 assertion 10', () => {
  it('emits exactly one silence op when disabled', () => {
    const out = createAudioOpList()
    planAudio(modelWith([cue('impact'), cue('boost')]), OFF, out)
    expect(out.count).toBe(1)
    expect(out.ops[0].kind).toBe('silence')
  })

  it('emits no oneShot for a zero-cue model', () => {
    const out = createAudioOpList()
    planAudio(modelWith([]), ON, out)
    expect(live(out).filter((op) => op.kind === 'oneShot')).toEqual([])
  })

  it('still drives the three continuous ops for a zero-cue model', () => {
    const out = createAudioOpList()
    planAudio(modelWith([]), ON, out)
    expect(live(out).map((op) => op.kind)).toEqual(['setMaster', 'setEngine', 'setSkid'])
  })

  it('caps one-shots at MAX_ONE_SHOTS_PER_FRAME', () => {
    const out = createAudioOpList()
    const many = Array.from({ length: MAX_ONE_SHOTS_PER_FRAME + 5 }, () => cue('impact'))
    planAudio(modelWith(many), ON, out)
    expect(live(out).filter((op) => op.kind === 'oneShot')).toHaveLength(MAX_ONE_SHOTS_PER_FRAME)
  })

  it('never emits engine or skid as a oneShot', () => {
    const out = createAudioOpList()
    planAudio(modelWith([cue('engine'), cue('skid'), cue('impact')]), ON, out)
    expect(live(out).filter((op) => op.kind === 'oneShot').map((op) => op.cue)).toEqual(['impact'])
  })

  it('does not let continuous kinds eat the per-frame budget', () => {
    const out = createAudioOpList()
    const cues = [cue('engine'), cue('skid'), cue('engine'), cue('skid'), cue('boost'), cue('finish')]
    planAudio(modelWith(cues), ON, out)
    expect(live(out).filter((op) => op.kind === 'oneShot').map((op) => op.cue)).toEqual([
      'boost',
      'finish',
    ])
  })

  it('keeps every emitted gain inside [0, 1]', () => {
    const out = createAudioOpList()
    const model = modelWith([cue('impact', 5), cue('boost', -3)])
    model.engineGain = 4
    model.skidGain = -1
    planAudio(model, { masterGain: 9, enabled: true }, out)
    for (const op of live(out)) {
      expect(op.gain).toBeGreaterThanOrEqual(0)
      expect(op.gain).toBeLessThanOrEqual(1)
    }
  })

  it('keeps every emitted pan inside [-1, 1]', () => {
    const out = createAudioOpList()
    planAudio(modelWith([cue('impact', 1, -4), cue('boost', 1, 7)]), ON, out)
    for (const op of live(out)) {
      expect(op.pan).toBeGreaterThanOrEqual(-1)
      expect(op.pan).toBeLessThanOrEqual(1)
    }
  })

  it('never exceeds MAX_AUDIO_OPS with a full cue buffer', () => {
    const out = createAudioOpList()
    const full = Array.from({ length: MAX_AUDIO_CUES }, () => cue('impact'))
    planAudio(modelWith(full), ON, out)
    expect(out.count).toBeLessThanOrEqual(MAX_AUDIO_OPS)
    expect(out.ops).toHaveLength(MAX_AUDIO_OPS)
  })

  it("carries the model's engine frequency and gain", () => {
    const out = createAudioOpList()
    const model = modelWith([])
    model.engineFreqHz = 314
    model.engineGain = 0.42
    planAudio(model, ON, out)
    const engine = live(out).find((op) => op.kind === 'setEngine')!
    expect(engine.freqHz).toBe(314)
    expect(engine.gain).toBeCloseTo(0.42)
  })

  it("carries the config's master gain into setMaster", () => {
    const out = createAudioOpList()
    planAudio(modelWith([]), { masterGain: 0.3, enabled: true }, out)
    expect(live(out).find((op) => op.kind === 'setMaster')!.gain).toBeCloseTo(0.3)
  })

  it('scales a one-shot by cue intensity from its spec peak', () => {
    const out = createAudioOpList()
    planAudio(modelWith([cue('impact', 0.5)]), ON, out)
    const shot = live(out).find((op) => op.kind === 'oneShot')!
    expect(shot.gain).toBeCloseTo(ONE_SHOT_SPECS.impact.peakGain * 0.5)
    expect(shot.freqHz).toBe(ONE_SHOT_SPECS.impact.startFreqHz)
    expect(shot.durationMs).toBe(ONE_SHOT_SPECS.impact.durationMs)
  })

  it('reads only [0, cueCount) of the cue buffer', () => {
    const out = createAudioOpList()
    const model = modelWith([cue('impact')])
    model.cues[1] = cue('finish')
    model.cues[2] = cue('boost')
    planAudio(model, ON, out)
    expect(live(out).filter((op) => op.kind === 'oneShot').map((op) => op.cue)).toEqual(['impact'])
  })

  it('reuses every preallocated op object across frames', () => {
    const out = createAudioOpList()
    const identities = [...out.ops]
    for (let frame = 0; frame < 3; frame++) {
      planAudio(modelWith([cue('impact'), cue('boost')]), ON, out)
      for (let i = 0; i < out.ops.length; i++) expect(out.ops[i]).toBe(identities[i])
    }
  })

  it('overwrites the previous frame without a stale one-shot', () => {
    const out = createAudioOpList()
    planAudio(modelWith([cue('impact'), cue('boost')]), ON, out)
    expect(live(out).filter((op) => op.kind === 'oneShot')).toHaveLength(2)
    planAudio(modelWith([]), ON, out)
    expect(live(out).filter((op) => op.kind === 'oneShot')).toHaveLength(0)
  })

  it('never writes to the AudioModel', () => {
    const out = createAudioOpList()
    const model = modelWith([cue('impact')])
    const before = JSON.stringify(model)
    planAudio(model, ON, out)
    expect(JSON.stringify(model)).toBe(before)
  })
})
