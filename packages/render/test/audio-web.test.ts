import { describe, expect, it } from 'vitest'
import { createAudioModel, type AudioConfig, type AudioCueKind } from '../src/audio'
import { ONE_SHOT_SPECS } from '../src/audio/graph'
import { createWebAudioBackend } from '../src/audio/web'

class FakeParam {
  value = 0
  readonly targets: Array<{ value: number; at: number; constant: number }> = []
  readonly values: Array<{ value: number; at: number }> = []
  readonly ramps: Array<{ value: number; at: number }> = []

  setTargetAtTime(value: number, at: number, constant: number): void {
    this.targets.push({ value, at, constant })
  }

  setValueAtTime(value: number, at: number): void {
    this.values.push({ value, at })
  }

  linearRampToValueAtTime(value: number, at: number): void {
    this.ramps.push({ value, at })
  }
}

class FakeNode {
  disconnectCalls = 0

  connect<T>(destination: T): T {
    return destination
  }

  disconnect(): void {
    this.disconnectCalls++
  }
}

class FakeGain extends FakeNode {
  readonly gain = new FakeParam()
}

class FakeFilter extends FakeNode {
  type = 'lowpass'
  readonly frequency = new FakeParam()
}

class FakePanner extends FakeNode {
  readonly pan = new FakeParam()
}

class FakeSource extends FakeNode {
  readonly frequency = new FakeParam()
  type = 'sine'
  buffer: FakeBuffer | null = null
  loop = false
  onended: (() => void) | null = null
  readonly starts: number[] = []
  readonly stops: Array<number | undefined> = []

  start(at = 0): void {
    this.starts.push(at)
  }

  stop(at?: number): void {
    this.stops.push(at)
  }
}

class FakeBuffer {
  readonly data: Float32Array

  constructor(length: number) {
    this.data = new Float32Array(length)
  }

  getChannelData(_channel: number): Float32Array {
    return this.data
  }
}

class FakeContext {
  readonly sampleRate = 8
  currentTime = 4
  readonly destination = new FakeNode()
  readonly gains: FakeGain[] = []
  readonly filters: FakeFilter[] = []
  readonly panners: FakePanner[] = []
  readonly oscillators: FakeSource[] = []
  readonly bufferSources: FakeSource[] = []
  readonly buffers: FakeBuffer[] = []
  closeCalls = 0

  createGain(): FakeGain {
    const node = new FakeGain()
    this.gains.push(node)
    return node
  }

  createBiquadFilter(): FakeFilter {
    const node = new FakeFilter()
    this.filters.push(node)
    return node
  }

  createStereoPanner(): FakePanner {
    const node = new FakePanner()
    this.panners.push(node)
    return node
  }

  createOscillator(): FakeSource {
    const node = new FakeSource()
    this.oscillators.push(node)
    return node
  }

  createBufferSource(): FakeSource {
    const node = new FakeSource()
    this.bufferSources.push(node)
    return node
  }

  createBuffer(_channels: number, length: number, _sampleRate: number): FakeBuffer {
    const buffer = new FakeBuffer(length)
    this.buffers.push(buffer)
    return buffer
  }

  close(): void {
    this.closeCalls++
  }
}

function backend(context: FakeContext, cfg: AudioConfig = { masterGain: 0.8, enabled: true }) {
  return createWebAudioBackend(context as unknown as AudioContext, cfg)
}

function oneShot(kind: AudioCueKind = 'impact') {
  const model = createAudioModel()
  model.cues[0] = { kind, playerId: 0, intensity: 1, pan: 0.25 }
  model.cueCount = 1
  return model
}

describe('createWebAudioBackend lifecycle corrections', () => {
  it('allocates no node and repeats no parameter write on idle apply calls', () => {
    const context = new FakeContext()
    const audio = backend(context)
    const nodeCounts = () => [
      context.gains.length,
      context.filters.length,
      context.panners.length,
      context.oscillators.length,
      context.bufferSources.length,
      context.buffers.length,
    ]
    const targetWrites = () =>
      context.gains.reduce((sum, node) => sum + node.gain.targets.length, 0) +
      context.oscillators.reduce((sum, node) => sum + node.frequency.targets.length, 0)

    const before = nodeCounts()
    audio.apply(createAudioModel())
    const writesAfterFirst = targetWrites()
    audio.apply(createAudioModel())

    expect(nodeCounts()).toEqual(before)
    expect(targetWrites()).toBe(writesAfterFirst)
  })

  it('applies mute and master gain immediately in setConfig', () => {
    const context = new FakeContext()
    const audio = backend(context)
    const master = context.gains[0].gain

    audio.setConfig({ masterGain: 0.25, enabled: true })
    audio.setConfig({ masterGain: 0.9, enabled: false })
    audio.setConfig({ masterGain: 0.6, enabled: true })

    expect(master.targets.map((write) => write.value)).toEqual([0.25, 0, 0.6])
    expect(master.targets.every((write) => write.at === context.currentTime)).toBe(true)
  })

  it('creates one deterministic noise buffer and shares it with noise one-shots', () => {
    const first = new FakeContext()
    const audio = backend(first)
    const original = ONE_SHOT_SPECS.impact.waveform
    ONE_SHOT_SPECS.impact.waveform = 'noise'
    try {
      audio.apply(oneShot())
      expect(first.buffers).toHaveLength(1)
      expect(first.bufferSources).toHaveLength(2)
      expect(first.bufferSources[0].buffer).toBe(first.buffers[0])
      expect(first.bufferSources[1].buffer).toBe(first.buffers[0])

      const second = new FakeContext()
      backend(second)
      expect([...second.buffers[0].data]).toEqual([...first.buffers[0].data])
    } finally {
      ONE_SHOT_SPECS.impact.waveform = original
    }
  })

  it('stops and disconnects every live one-shot exactly once on idempotent close', () => {
    const context = new FakeContext()
    const audio = backend(context)
    audio.apply(oneShot())
    audio.apply(oneShot('boost'))

    const transients = context.oscillators.slice(1)
    expect(transients).toHaveLength(2)
    for (const transient of transients) expect(transient.stops).toHaveLength(1)
    audio.close()
    audio.close()

    for (const transient of transients) {
      expect(transient.stops).toHaveLength(2)
      expect(transient.disconnectCalls).toBe(1)
    }
    for (const filter of context.filters.slice(2)) expect(filter.disconnectCalls).toBe(1)
    for (const gain of context.gains.slice(3)) expect(gain.disconnectCalls).toBe(1)
    for (const panner of context.panners.slice(1)) expect(panner.disconnectCalls).toBe(1)
    expect(context.closeCalls).toBe(0)

    for (const transient of transients) {
      transient.onended?.()
      expect(transient.disconnectCalls).toBe(1)
    }
  })

  it('removes naturally ended one-shots from the live set before close', () => {
    const context = new FakeContext()
    const audio = backend(context)
    audio.apply(oneShot())
    const transient = context.oscillators[1]

    transient.onended?.()
    expect(transient.disconnectCalls).toBe(1)
    audio.close()
    expect(transient.stops).toHaveLength(1)
    expect(transient.disconnectCalls).toBe(1)
  })
})
