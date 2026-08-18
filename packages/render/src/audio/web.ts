// ADAPTER. Contract §9.2/§9.3. This is the only render file that names
// AudioContext and is intentionally excluded from the headless barrel.

import type { AudioBackend, AudioConfig, AudioModel } from '../audio'
import {
  createAudioOpList,
  ENGINE_SMOOTHING_MS,
  ONE_SHOT_SPECS,
  ONE_SHOT_VOICE_LIMIT,
  planAudio,
  type AudioOp,
} from './graph'

export function isWebAudioAvailable(): boolean {
  return typeof AudioContext !== 'undefined'
}

function makeNoiseBuffer(context: AudioContext): AudioBuffer {
  const seconds = 2
  const buffer = context.createBuffer(1, context.sampleRate * seconds, context.sampleRate)
  const data = buffer.getChannelData(0)
  let seed = 0x2f6e2b1
  for (let i = 0; i < data.length; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0
    data[i] = (seed / 0xffffffff) * 2 - 1
  }
  return buffer
}

function clampGain(value: number): number {
  if (Number.isNaN(value) || value < 0) return 0
  return value > 1 ? 1 : value
}

interface LiveVoice {
  source: AudioScheduledSourceNode
  filter: BiquadFilterNode
  gain: GainNode
  panner: StereoPannerNode
}

/** Receives an already-constructed/resumed context; ownership stays with web. */
export function createWebAudioBackend(
  context: AudioContext,
  initial: Readonly<AudioConfig>,
): AudioBackend {
  const master = context.createGain()
  master.gain.value = initial.enabled ? clampGain(initial.masterGain) : 0
  master.connect(context.destination)

  const engineOsc = context.createOscillator()
  engineOsc.type =
    ONE_SHOT_SPECS.engine.waveform === 'noise' ? 'sawtooth' : ONE_SHOT_SPECS.engine.waveform
  const engineFilter = context.createBiquadFilter()
  engineFilter.type = 'lowpass'
  engineFilter.frequency.value = ONE_SHOT_SPECS.engine.filterHz
  const engineGain = context.createGain()
  engineGain.gain.value = 0
  const enginePan = context.createStereoPanner()
  engineOsc.connect(engineFilter).connect(engineGain).connect(enginePan).connect(master)
  engineOsc.frequency.value = 1
  engineOsc.start()

  // One deterministic buffer is shared by the continuous skid voice and every
  // transient whose spec uses noise.
  const noiseBuffer = makeNoiseBuffer(context)
  const skidSource = context.createBufferSource()
  skidSource.buffer = noiseBuffer
  skidSource.loop = true
  const skidFilter = context.createBiquadFilter()
  skidFilter.type = 'bandpass'
  skidFilter.frequency.value = ONE_SHOT_SPECS.skid.filterHz
  const skidGain = context.createGain()
  skidGain.gain.value = 0
  skidSource.connect(skidFilter).connect(skidGain).connect(master)
  skidSource.start()

  const ops = createAudioOpList()
  let cfg: AudioConfig = { masterGain: initial.masterGain, enabled: initial.enabled }
  const liveVoices = new Set<LiveVoice>()
  let closed = false

  let lastMaster = master.gain.value
  let lastEngineFreq = engineOsc.frequency.value
  let lastEngineGain = 0
  let lastSkidGain = 0
  const smoothing = ENGINE_SMOOTHING_MS / 1000

  function target(param: AudioParam, value: number): void {
    param.setTargetAtTime(value, context.currentTime, smoothing)
  }

  function releaseVoice(voice: LiveVoice): void {
    if (!liveVoices.delete(voice)) return
    voice.source.onended = null
    voice.source.disconnect()
    voice.filter.disconnect()
    voice.gain.disconnect()
    voice.panner.disconnect()
  }

  function startOneShot(op: AudioOp): void {
    if (liveVoices.size >= ONE_SHOT_VOICE_LIMIT || op.cue === 'none') return
    const spec = ONE_SHOT_SPECS[op.cue]
    const now = context.currentTime
    const seconds = spec.durationMs / 1000

    const gain = context.createGain()
    const filter = context.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.value = spec.filterHz
    const panner = context.createStereoPanner()
    panner.pan.value = op.pan

    let source: AudioScheduledSourceNode
    if (spec.waveform === 'noise') {
      const noise = context.createBufferSource()
      noise.buffer = noiseBuffer
      source = noise
    } else {
      const osc = context.createOscillator()
      osc.type = spec.waveform
      osc.frequency.setValueAtTime(spec.startFreqHz, now)
      osc.frequency.linearRampToValueAtTime(spec.endFreqHz, now + seconds)
      source = osc
    }

    gain.gain.setValueAtTime(0, now)
    gain.gain.linearRampToValueAtTime(op.gain, now + spec.attackMs / 1000)
    gain.gain.setTargetAtTime(
      0,
      now + seconds - spec.releaseMs / 1000,
      spec.releaseMs / 1000 / 3,
    )

    source.connect(filter).connect(gain).connect(panner).connect(master)
    const voice: LiveVoice = { source, filter, gain, panner }
    liveVoices.add(voice)
    source.onended = () => releaseVoice(voice)
    source.start(now)
    source.stop(now + seconds)
  }

  return {
    apply(model: AudioModel): void {
      if (closed) return
      planAudio(model, cfg, ops)
      for (let i = 0; i < ops.count; i++) {
        const op = ops.ops[i]
        switch (op.kind) {
          case 'silence':
            if (lastMaster !== 0) {
              target(master.gain, 0)
              lastMaster = 0
            }
            break
          case 'setMaster':
            if (lastMaster !== op.gain) {
              target(master.gain, op.gain)
              lastMaster = op.gain
            }
            break
          case 'setEngine':
            if (lastEngineFreq !== op.freqHz) {
              target(engineOsc.frequency, op.freqHz)
              lastEngineFreq = op.freqHz
            }
            if (lastEngineGain !== op.gain) {
              target(engineGain.gain, op.gain)
              lastEngineGain = op.gain
            }
            break
          case 'setSkid':
            if (lastSkidGain !== op.gain) {
              target(skidGain.gain, op.gain)
              lastSkidGain = op.gain
            }
            break
          case 'oneShot':
            startOneShot(op)
            break
        }
      }
    },

    setConfig(next: AudioConfig): void {
      if (closed) return
      cfg = { masterGain: next.masterGain, enabled: next.enabled }
      const nextMaster = next.enabled ? clampGain(next.masterGain) : 0
      if (lastMaster !== nextMaster) {
        target(master.gain, nextMaster)
        lastMaster = nextMaster
      }
    },

    close(): void {
      if (closed) return
      closed = true

      for (const voice of liveVoices) {
        // A transient already has a scheduled stop; a second, immediate stop is
        // legal and prevents its tail surviving backend replacement.
        voice.source.stop(context.currentTime)
        releaseVoice(voice)
      }

      engineOsc.stop()
      skidSource.stop()
      engineOsc.disconnect()
      engineFilter.disconnect()
      engineGain.disconnect()
      enginePan.disconnect()
      skidSource.disconnect()
      skidFilter.disconnect()
      skidGain.disconnect()
      master.disconnect()
      // The AudioContext belongs to apps/web and is intentionally not closed.
    },
  }
}
