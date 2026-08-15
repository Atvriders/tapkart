### Task 17: the Web Audio backend — the pure op planner, `ONE_SHOT_SPECS`, and the adapter behind Plan 3's seam

> **Execution corrections (2026-08-15):** the supplied graph suite has 26 tests,
> not 28. The adapter tracks every live transient, stops/disconnects them
> idempotently on `close()`, and reuses one deterministic noise buffer for skid
> and noise one-shots. `setConfig()` applies mute/master gain immediately rather
> than waiting for a later race frame. Downstream Task 18 must apply one
> preallocated silent `AudioModel` before dropping a race, and `setAudio()` must
> close the outgoing backend, replace a mutable captured backend, and immediately
> apply the persisted settings to the incoming one.

**Files:**
- Create: `packages/render/src/audio/graph.ts` — contract §9.2, PURE
- Create: `packages/render/src/audio/web.ts` — contract §9.2, ADAPTER, **not** in the barrel
- Modify: `packages/render/package.json` — `exports["./web-audio"]`
- Modify: `packages/render/src/index.ts` — re-export `audio/graph`, **never** `audio/web`
- Test: `packages/render/test/audio-graph.test.ts`

**Ordering:** independent of everything else in Plan 5. It needs Plan 3's `packages/render/src/audio.ts` — the pure model and the seam — and nothing this plan writes.

**Interfaces:**

- **Consumes** — Plan 3 contract §4.9, quoted from the **locked** contract. Plan 5 reads every one of these and writes none of them (§13):

  ```ts
  export type AudioCueKind =
    | 'engine' | 'skid' | 'impact' | 'itemPickup' | 'itemUse'
    | 'boost' | 'spinOut' | 'respawn' | 'lapCross' | 'countdownBeep' | 'finish'

  export interface AudioCue {
    kind: AudioCueKind
    playerId: number
    intensity: number           // 0..1
    pan: number                 // -1 (left) .. 1 (right), from the camera's right axis
  }

  export interface AudioModel {
    engineFreqHz: number        // LOCAL kart only
    engineGain: number          // 0..1
    skidGain: number            // 0..1
    cues: AudioCue[]            // fixed length MAX_AUDIO_CUES; only [0, cueCount) is live
    cueCount: number
  }
  export const MAX_AUDIO_CUES = 16
  export function createAudioModel(): AudioModel

  /** Device/user preference, NOT a property of the audio the race is producing. */
  export interface AudioConfig {
    masterGain: number          // 0..1
    enabled: boolean            // false mutes without tearing the backend down
  }

  /** ADAPTER boundary. Plan 5 puts Web Audio behind this and touches nothing else. */
  export interface AudioBackend {
    apply(model: AudioModel): void
    setConfig(cfg: AudioConfig): void
    close(): void
  }

  export const nullAudioBackend: AudioBackend
  ```

  **`AudioBackend` has three methods, not two** (§2.1 correction 1): R38 put `setConfig` **in the seam**, so `createWebAudioBackend` returns a plain `AudioBackend`. There is no widened concrete type and no `AudioGraphConfig` — §2.1 correction 2 deletes it, and *"the two tuning numbers are module constants of the graph (§9.2), not configuration: nothing outside `render` ever sets them, and a config field nobody writes is a field that drifts."*

- **Produces** — contract §9.2, exactly **11** exports from `src/audio/graph.ts` and **2** from `src/audio/web.ts` (§16's census):

  ```ts
  // graph.ts
  export type AudioOpKind = 'setEngine' | 'setSkid' | 'setMaster' | 'oneShot' | 'silence'
  export interface AudioOp { kind: AudioOpKind; cue: AudioCueKind | 'none'; freqHz: number; gain: number; pan: number; durationMs: number }
  export interface AudioOpList { ops: AudioOp[]; count: number }
  export interface OneShotSpec {
    waveform: 'sine' | 'square' | 'sawtooth' | 'triangle' | 'noise'
    startFreqHz: number; endFreqHz: number; durationMs: number
    peakGain: number; attackMs: number; releaseMs: number; filterHz: number
  }
  export const ONE_SHOT_SPECS: Readonly<Record<AudioCueKind, OneShotSpec>>
  export const MAX_AUDIO_OPS = 32
  export const MAX_ONE_SHOTS_PER_FRAME = 4
  export const ONE_SHOT_VOICE_LIMIT = 12
  export const ENGINE_SMOOTHING_MS = 60
  export function createAudioOpList(): AudioOpList
  export function planAudio(model: AudioModel, cfg: Readonly<AudioConfig>, out: AudioOpList): void

  // web.ts
  export function isWebAudioAvailable(): boolean
  export function createWebAudioBackend(context: AudioContext, initial: Readonly<AudioConfig>): AudioBackend
  ```

**Where these files live, and the one name that would break the package** (§9.1). `packages/render/src/audio.ts` already exists — Plan 3 §4.9, the pure model and the seam — so:

- the subpath export is **`./web-audio`**, not `./audio`, because *"a subpath export named `./audio` that resolves to the adapter while the barrel exports the model is a name two readers will read two ways"*;
- **`packages/render/src/audio/index.ts` must not exist.** Under `moduleResolution: "Bundler"` a bare `./audio` would then be ambiguous between the Plan 3 file and the Plan 5 directory. Imports inside `render` are `./audio/graph` and `./audio/web`, always. The test below detects an accidental `index.ts` by asserting that `../src/audio` still resolves to the module with `createAudioModel` in it.

**`apply` runs on every rendered frame, and most frames have no cues** (§2.2). Plan 3's shipped shell calls, in this exact order and Plan 5 does not change it:

```ts
    buildAudioModel(r.session.prevView(), view, r.audioModel)
    audio.apply(r.audioModel)
    r.session.swapViews()
```

so `apply` is called *"once per rendered frame, unconditionally, with a model whose `cueCount` is frequently zero."* §9.3's budget follows: *"`apply` allocates nothing when `model.cueCount === 0`, constructs no node, and writes a parameter only when the target value differs from the last one written. A backend that re-schedules three `setTargetAtTime` calls 120 times a second on an idle title screen is a battery problem the profiler will blame on the renderer."*

`planAudio` is the same discipline one level up: `out.ops` is preallocated to `MAX_AUDIO_OPS` and `out.count` says how many are live, *"exactly as `WireSnapshot.entityCount` does."*

**F-P5-28: `ONE_SHOT_SPECS` is authored here, with reasons, and tuned by the owner on a device. It is not delegated, and the reason is worth stating rather than assuming.**

> *"The track palettes were a good delegation because the gate could check them — ranges, schema, uniqueness, real parsers. Sound-design numbers have no schema-level notion of correct: a model's output cannot be gated meaningfully, so delegation would produce confident garbage with a green check beside it."*

So every number below carries the sentence that chose it, and §14's row is honest about what remains: **"That audio sounds like an engine — judgement, on a speaker"** is owner-verified, and §12.2 assertion 10 proves *"the op list is exactly right"*, which is a different and much smaller claim. `docs/owner-verification.md` item 14 is where the tuning pass is recorded.

**What has to exist before any of this can be heard at all.** Downstream of P3-R49: until two `RaceView`s exist, `buildAudioModel(prev, view, out)` is called with `prev === view`, every delta is empty, and no `impact`, `itemUse`, `itemPickup`, `boost`, `spinOut`, `lapCross`, `countdownBeep` or `finish` cue can fire in the shipped game. Plan 3's `RaceSession` double buffer is what fixes it. This task depends on that being true and cannot detect it: **`planAudio` is a function of the model it is handed**, and a model with `cueCount === 0` every frame is exactly what a correct planner produces nothing from.

---

- [ ] **Step 1: Write the failing test**

Create `packages/render/test/audio-graph.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { createAudioModel, MAX_AUDIO_CUES, type AudioCue, type AudioCueKind, type AudioConfig, type AudioModel } from '../src/audio'
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

/** Every AudioCueKind, spelled once. The annotation is what makes this list
 *  exhaustive: adding a kind to Plan 3's union and not to this array is a
 *  compile error in `ONE_SHOT_SPECS`, and adding it here without an entry is a
 *  compile error too. */
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

/** The two kinds that are CONTINUOUS voices and are never one-shots (§9.3). */
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
  /** If someone adds packages/render/src/audio/index.ts, a bare `./audio`
   *  becomes ambiguous between Plan 3's file and this plan's directory, and the
   *  import above silently starts resolving to the wrong one. */
  it('bare ./audio still resolves to Plan 3\'s pure model, not this plan\'s directory', () => {
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

  it('leaves room for the three continuous ops plus a full frame of one-shots', () => {
    expect(MAX_AUDIO_OPS).toBeGreaterThanOrEqual(3 + MAX_ONE_SHOTS_PER_FRAME)
  })

  it('lets more voices live than one frame can start, so a tail is never cut by the frame cap', () => {
    expect(ONE_SHOT_VOICE_LIMIT).toBeGreaterThan(MAX_ONE_SHOTS_PER_FRAME)
  })
})

describe('ONE_SHOT_SPECS', () => {
  it('is TOTAL over AudioCueKind, so no lookup can miss', () => {
    for (const kind of ALL_KINDS) {
      expect(ONE_SHOT_SPECS[kind], kind).toBeDefined()
    }
    expect(Object.keys(ONE_SHOT_SPECS).sort()).toEqual([...ALL_KINDS].sort())
  })

  it('gives the two continuous voices peakGain 0, because they are never emitted as one-shots', () => {
    for (const kind of CONTINUOUS) {
      expect(ONE_SHOT_SPECS[kind].peakGain, kind).toBe(0)
    }
  })

  it('gives every real cue an audible peak gain inside [0, 1]', () => {
    for (const kind of ALL_KINDS) {
      const spec = ONE_SHOT_SPECS[kind]
      expect(spec.peakGain, kind).toBeGreaterThanOrEqual(0)
      expect(spec.peakGain, kind).toBeLessThanOrEqual(1)
      if (!CONTINUOUS.includes(kind)) expect(spec.peakGain, kind).toBeGreaterThan(0)
    }
  })

  it('gives every real cue a positive duration, and an envelope that fits inside it', () => {
    for (const kind of ALL_KINDS) {
      if (CONTINUOUS.includes(kind)) continue
      const spec = ONE_SHOT_SPECS[kind]
      expect(spec.durationMs, kind).toBeGreaterThan(0)
      expect(spec.attackMs + spec.releaseMs, kind).toBeLessThanOrEqual(spec.durationMs)
    }
  })

  it('gives every real cue positive frequencies and a positive filter cutoff', () => {
    for (const kind of ALL_KINDS) {
      if (CONTINUOUS.includes(kind)) continue
      const spec = ONE_SHOT_SPECS[kind]
      expect(spec.startFreqHz, kind).toBeGreaterThan(0)
      expect(spec.endFreqHz, kind).toBeGreaterThan(0)
      expect(spec.filterHz, kind).toBeGreaterThan(0)
    }
  })

  it('keeps every frequency inside what a phone speaker reproduces at all', () => {
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
  it('emits exactly one silence op when enabled is false, and nothing else', () => {
    const out = createAudioOpList()
    planAudio(modelWith([cue('impact'), cue('boost')]), OFF, out)
    expect(out.count).toBe(1)
    expect(out.ops[0].kind).toBe('silence')
  })

  it('emits no oneShot op at all for a zero-cue model', () => {
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
    expect(live(out).filter((op) => op.kind === 'oneShot').length).toBe(MAX_ONE_SHOTS_PER_FRAME)
  })

  it('never emits a oneShot op for kind engine or skid', () => {
    const out = createAudioOpList()
    planAudio(modelWith([cue('engine'), cue('skid'), cue('impact')]), ON, out)
    const oneShots = live(out).filter((op) => op.kind === 'oneShot')
    expect(oneShots.map((op) => op.cue)).toEqual(['impact'])
  })

  it('does not let the two continuous kinds eat the per-frame budget', () => {
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

  it('never exceeds MAX_AUDIO_OPS, even with a full cue buffer', () => {
    const out = createAudioOpList()
    const full = Array.from({ length: MAX_AUDIO_CUES }, () => cue('impact'))
    planAudio(modelWith(full), ON, out)
    expect(out.count).toBeLessThanOrEqual(MAX_AUDIO_OPS)
    expect(out.ops.length).toBe(MAX_AUDIO_OPS)
  })

  it('carries the model\'s engine frequency and gain into setEngine', () => {
    const out = createAudioOpList()
    const model = modelWith([])
    model.engineFreqHz = 314
    model.engineGain = 0.42
    planAudio(model, ON, out)
    const engine = live(out).find((op) => op.kind === 'setEngine')!
    expect(engine.freqHz).toBe(314)
    expect(engine.gain).toBeCloseTo(0.42)
  })

  it('carries the config\'s master gain into setMaster, and nowhere else', () => {
    const out = createAudioOpList()
    planAudio(modelWith([]), { masterGain: 0.3, enabled: true }, out)
    expect(live(out).find((op) => op.kind === 'setMaster')!.gain).toBeCloseTo(0.3)
  })

  it('scales a one-shot by the cue intensity, from its spec\'s peak', () => {
    const out = createAudioOpList()
    planAudio(modelWith([cue('impact', 0.5)]), ON, out)
    const shot = live(out).find((op) => op.kind === 'oneShot')!
    expect(shot.gain).toBeCloseTo(ONE_SHOT_SPECS.impact.peakGain * 0.5)
    expect(shot.freqHz).toBe(ONE_SHOT_SPECS.impact.startFreqHz)
    expect(shot.durationMs).toBe(ONE_SHOT_SPECS.impact.durationMs)
  })

  it('reads only [0, cueCount) of the cue buffer, never the stale tail', () => {
    const out = createAudioOpList()
    const model = modelWith([cue('impact')])
    model.cues[1] = cue('finish') // stale: left over from a previous frame
    model.cues[2] = cue('boost')
    planAudio(model, ON, out)
    expect(live(out).filter((op) => op.kind === 'oneShot').map((op) => op.cue)).toEqual(['impact'])
  })

  it('is allocation-free: the same op objects are reused across frames (§9.3)', () => {
    const out = createAudioOpList()
    const identities = out.ops.map((op) => op)
    for (let frame = 0; frame < 3; frame++) {
      planAudio(modelWith([cue('impact'), cue('boost')]), ON, out)
      for (let i = 0; i < out.ops.length; i++) {
        expect(out.ops[i]).toBe(identities[i])
      }
    }
  })

  it('overwrites the previous frame — a quiet frame after a loud one emits no stale one-shot', () => {
    const out = createAudioOpList()
    planAudio(modelWith([cue('impact'), cue('boost')]), ON, out)
    expect(live(out).filter((op) => op.kind === 'oneShot').length).toBe(2)
    planAudio(modelWith([]), ON, out)
    expect(live(out).filter((op) => op.kind === 'oneShot').length).toBe(0)
  })

  it('never writes to the model it is given (§13: AudioModel\'s sole writer is buildAudioModel)', () => {
    const out = createAudioOpList()
    const model = modelWith([cue('impact')])
    const before = JSON.stringify(model)
    planAudio(model, ON, out)
    expect(JSON.stringify(model)).toBe(before)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/render/test/audio-graph.test.ts`

Expected: **FAIL at collect time**:

```
Error: Failed to resolve import "../src/audio/graph" from "packages/render/test/audio-graph.test.ts". Does the file exist?
```

- [ ] **Step 3: Write the implementation**

**3a.** Create `packages/render/src/audio/graph.ts`:

```ts
// PURE. Contract §9.2. No AudioContext, no DOM, no clock — this module is a
// function of the AudioModel it is handed, and it is the only place a sound
// number lives.

import type { AudioConfig, AudioCueKind, AudioModel } from '../audio'

export type AudioOpKind = 'setEngine' | 'setSkid' | 'setMaster' | 'oneShot' | 'silence'

export interface AudioOp {
  kind: AudioOpKind
  cue: AudioCueKind | 'none'
  freqHz: number
  gain: number
  /** -1..1 */
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

/** One entry per AudioCueKind — TOTAL, so no lookup can miss. The whole sound
 *  design of the game, as data.
 *
 *  'engine' and 'skid' have entries with peakGain 0 and are never emitted as
 *  one-shots: they are the two CONTINUOUS voices (§9.3) and the map is total
 *  only so that a cue kind can never index past the end of it. Their `waveform`
 *  and `filterHz` are still real — `web.ts` reads them for the two continuous
 *  voices, so every sound number in the game is in this one object.
 *
 *  F-P5-28: authored here with reasoned defaults and tuned by the owner on a
 *  device. Sound-design numbers have no schema-level notion of correct, so the
 *  reason for each one is written beside it and the tuning pass is
 *  `docs/owner-verification.md` item 14. The tests below check the properties a
 *  machine CAN check — totality, ranges, envelopes inside durations — and claim
 *  nothing about how any of it sounds. */
export const ONE_SHOT_SPECS: Readonly<Record<AudioCueKind, OneShotSpec>> = {
  // Continuous. peakGain 0: never emitted as a one-shot.
  // A sawtooth through a gentle lowpass is the classic small-engine timbre, and
  // the 1.8 kHz cutoff is what keeps it from sounding like tearing paper on a
  // phone speaker, which reproduces almost nothing above about 8 kHz cleanly.
  engine: { waveform: 'sawtooth', startFreqHz: 0, endFreqHz: 0, durationMs: 0, peakGain: 0, attackMs: 0, releaseMs: 0, filterHz: 1800 },
  // Tyre scrub lives in the upper mid. A bandpass at 3.2 kHz is high enough to
  // read as friction and low enough to survive a phone speaker.
  skid: { waveform: 'noise', startFreqHz: 0, endFreqHz: 0, durationMs: 0, peakGain: 0, attackMs: 0, releaseMs: 0, filterHz: 3200 },

  // A hard front and a fast fall to a low note: a collision should be felt
  // before it is identified. It is the loudest cue in the game because it is the
  // one the player most needs to notice, and it is short enough not to mask the
  // engine.
  impact: { waveform: 'square', startFreqHz: 220, endFreqHz: 60, durationMs: 180, peakGain: 0.9, attackMs: 2, releaseMs: 140, filterHz: 1200 },

  // Rising and bright: the two cues that mean "you gained something" both go
  // UP, and the two that mean "you lost something" both go down. That pairing is
  // the only thing making eleven sounds learnable without a manual.
  itemPickup: { waveform: 'triangle', startFreqHz: 660, endFreqHz: 1320, durationMs: 120, peakGain: 0.5, attackMs: 4, releaseMs: 90, filterHz: 6000 },
  // Falling, and a harsher waveform: the item has left you.
  itemUse: { waveform: 'sawtooth', startFreqHz: 880, endFreqHz: 440, durationMs: 140, peakGain: 0.55, attackMs: 3, releaseMs: 110, filterHz: 4000 },

  // The longest rise and the loudest non-impact cue: a boost is the strongest
  // positive event in the game and it lasts long enough to overlap the speed it
  // produces.
  boost: { waveform: 'sawtooth', startFreqHz: 300, endFreqHz: 1200, durationMs: 320, peakGain: 0.7, attackMs: 8, releaseMs: 220, filterHz: 5000 },
  // A long descent — the mirror of boost, and deliberately the same shape
  // inverted so the two are never confused.
  spinOut: { waveform: 'triangle', startFreqHz: 700, endFreqHz: 140, durationMs: 500, peakGain: 0.6, attackMs: 6, releaseMs: 380, filterHz: 2500 },
  // Rising like boost but softer and rounder: you are back, but you did not gain
  // anything. A sine keeps it out of the way of whatever is happening around it.
  respawn: { waveform: 'sine', startFreqHz: 200, endFreqHz: 800, durationMs: 260, peakGain: 0.45, attackMs: 10, releaseMs: 200, filterHz: 5000 },

  // FLAT pitch, deliberately: a lap is a thing you count, and a countable event
  // must sound identical every time. Any pitch movement here reads as
  // information the game is not conveying.
  lapCross: { waveform: 'square', startFreqHz: 990, endFreqHz: 990, durationMs: 90, peakGain: 0.5, attackMs: 2, releaseMs: 70, filterHz: 5000 },
  // Also flat, and quieter than the finish it leads into — three identical beeps
  // then something different is the whole grammar of a countdown.
  countdownBeep: { waveform: 'sine', startFreqHz: 880, endFreqHz: 880, durationMs: 110, peakGain: 0.6, attackMs: 3, releaseMs: 80, filterHz: 4000 },
  // The one cue that rises an octave, the longest, and the loudest of the
  // musical group: it is the last thing the race says.
  finish: { waveform: 'sine', startFreqHz: 880, endFreqHz: 1760, durationMs: 420, peakGain: 0.75, attackMs: 5, releaseMs: 320, filterHz: 6000 },
}

export const MAX_AUDIO_OPS = 32
export const MAX_ONE_SHOTS_PER_FRAME = 4
export const ONE_SHOT_VOICE_LIMIT = 12
export const ENGINE_SMOOTHING_MS = 60

/** The three continuous ops every enabled frame emits, in this order. */
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

/** Writes into `out.ops[at]` rather than allocating — §9.3's budget. */
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

/** SOLE WRITER of AudioOpList. Allocation-free: `out.ops` is preallocated to
 *  MAX_AUDIO_OPS and `out.count` says how many are live, exactly as
 *  WireSnapshot.entityCount does. `cfg.enabled === false` emits one 'silence' op
 *  and nothing else. Takes Plan 3's AudioConfig — there is no second config type
 *  (R38).
 *
 *  Reads the model and never writes it: §13 makes `buildAudioModel` the sole
 *  writer of every AudioModel field, INCLUDING `cues`, which Plan 5 never
 *  clears. */
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
    // The two continuous voices are driven by setEngine/setSkid above and are
    // never started as transient voices, whatever a cue says.
    if (spec.peakGain === 0) continue
    write(out, at, 'oneShot', cue.kind, spec.startFreqHz, spec.peakGain * cue.intensity, cue.pan, spec.durationMs)
    at++
    started++
  }

  out.count = at
}
```

**3b.** Create `packages/render/src/audio/web.ts`:

```ts
// ADAPTER. Contract §9.2 and §9.3. This is the only file in `render` that names
// AudioContext, and it is NOT in the barrel (§9.1) — Plan 3 §8.2's rule is that
// no adapter reaches the headless barrel, because one adapter import there
// breaks the entire headless suite with an error pointing at the wrong package.
//
// It contains no decisions (§0a): every one was made by planAudio, and this file
// executes the op list it produced.

import type { AudioBackend, AudioConfig, AudioModel } from '../audio'
import {
  createAudioOpList,
  ENGINE_SMOOTHING_MS,
  ONE_SHOT_SPECS,
  ONE_SHOT_VOICE_LIMIT,
  planAudio,
  type AudioOp,
} from './graph'

/** `typeof AudioContext !== 'undefined'`. Nothing else. */
export function isWebAudioAvailable(): boolean {
  return typeof AudioContext !== 'undefined'
}

/** Two seconds of noise, generated ONCE at construction and looped. Generating
 *  it per skid would allocate a megabyte on a frame that is already spending its
 *  budget on the impact that caused the skid. */
function makeNoiseBuffer(context: AudioContext): AudioBuffer {
  const seconds = 2
  const buffer = context.createBuffer(1, context.sampleRate * seconds, context.sampleRate)
  const data = buffer.getChannelData(0)
  // A deterministic LCG rather than Math.random: two runs of the game produce
  // the same skid, which makes a "does it sound different today?" question
  // answerable.
  let seed = 0x2f6e2b1
  for (let i = 0; i < data.length; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0
    data[i] = (seed / 0xffffffff) * 2 - 1
  }
  return buffer
}

/** Takes an ALREADY-CONSTRUCTED, already-resumed AudioContext. It does not
 *  construct one, because construction must happen inside a user gesture and
 *  this function is called from composition, not from an event handler.
 *
 *  Returns a plain AudioBackend — R38 put setConfig IN the seam, so there is no
 *  widened type and `apps/web` holds exactly what `game` holds. */
export function createWebAudioBackend(
  context: AudioContext,
  initial: Readonly<AudioConfig>,
): AudioBackend {
  const master = context.createGain()
  master.gain.value = initial.enabled ? initial.masterGain : 0
  master.connect(context.destination)

  // One engine voice: sawtooth -> lowpass -> gain -> panner -> master (§9.3).
  const engineOsc = context.createOscillator()
  engineOsc.type = ONE_SHOT_SPECS.engine.waveform === 'noise' ? 'sawtooth' : ONE_SHOT_SPECS.engine.waveform
  const engineFilter = context.createBiquadFilter()
  engineFilter.type = 'lowpass'
  engineFilter.frequency.value = ONE_SHOT_SPECS.engine.filterHz
  const engineGain = context.createGain()
  engineGain.gain.value = 0
  const enginePan = context.createStereoPanner()
  engineOsc.connect(engineFilter).connect(engineGain).connect(enginePan).connect(master)
  engineOsc.frequency.value = 1
  engineOsc.start()

  // One skid voice: a looping noise buffer generated once -> bandpass -> gain.
  const skidSource = context.createBufferSource()
  skidSource.buffer = makeNoiseBuffer(context)
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
  let liveVoices = 0
  let closed = false

  // §9.3's budget: "writes a parameter only when the target value differs from
  // the last one written". Three parameters, three remembered values.
  let lastMaster = master.gain.value
  let lastEngineFreq = engineOsc.frequency.value
  let lastEngineGain = 0
  let lastSkidGain = 0

  const smoothing = ENGINE_SMOOTHING_MS / 1000

  function target(param: AudioParam, value: number): void {
    // setTargetAtTime, never setValueAtTime — the latter zippers audibly (§9.3).
    param.setTargetAtTime(value, context.currentTime, smoothing)
  }

  function startOneShot(op: AudioOp): void {
    if (liveVoices >= ONE_SHOT_VOICE_LIMIT) return
    if (op.cue === 'none') return
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
      noise.buffer = makeNoiseBuffer(context)
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
    gain.gain.setTargetAtTime(0, now + seconds - spec.releaseMs / 1000, spec.releaseMs / 1000 / 3)

    source.connect(filter).connect(gain).connect(panner).connect(master)
    liveVoices++
    source.onended = () => {
      liveVoices--
      source.disconnect()
      filter.disconnect()
      gain.disconnect()
      panner.disconnect()
    }
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
      // Called on every Settings change and once at startup — never per frame.
      cfg = { masterGain: next.masterGain, enabled: next.enabled }
    },

    close(): void {
      if (closed) return
      closed = true
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
      // The AudioContext is NOT closed: it belongs to apps/web (§13).
    },
  }
}
```

**3c.** In `packages/render/package.json`, add the third subpath — mirroring exactly what Plan 3 did for `"./three"`:

```json
  "exports": {
    ".": "./src/index.ts",
    "./three": "./src/three/renderer.ts",
    "./web-audio": "./src/audio/web.ts"
  }
```

**3d.** In `packages/render/src/index.ts`, add one line beside the existing re-exports:

```ts
export * from './audio/graph'
```

**Never `./audio/web`.** Plan 3 §8.2: one adapter import in a barrel breaks the entire headless suite with an error pointing at the wrong package, and `AudioContext` is this plan's version of that risk.

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run packages/render/test/audio-graph.test.ts
npm run typecheck -w @tapkart/render
npx vitest run
```

Expected: **28 passed** in `audio-graph.test.ts` (1 layout + 3 constants + 6 `ONE_SHOT_SPECS` + 18 `planAudio`), no typecheck output, and no new failures — in particular Plan 3's barrel test, which asserts that no two re-exported modules export the same name, must still pass with `audio/graph` added.

Then prove the barrel stayed headless, which is the failure mode Plan 3 §8.2 names and the one an error message will lie about:

Run: `node --input-type=module -e "const m = await import('@tapkart/render'); if (typeof m.planAudio !== 'function') throw new Error('planAudio is not on the barrel'); if ('createWebAudioBackend' in m) throw new Error('the ADAPTER reached the barrel');"`

That command will not run directly — `@tapkart/render`'s `exports` point at `.ts` — so run the equivalent through the suite instead: `npx vitest run packages/render` must be green with `environment: 'node'` and no jsdom. **If `audio/web` ever reaches the barrel, every test in `packages/render` fails with `AudioContext is not defined` at import time**, pointing at whichever test file happened to be collected first.

Then confirm the subpath resolves for the app that needs it:

Run: `npx tsc --noEmit -p apps/web/tsconfig.json`
Expected: no output. (`apps/web` imports `@tapkart/render/web-audio` in the platform task; until then this only proves the package manifest parses.)

**What none of that proved, and it is §14's row:** *"That audio sounds like an engine — judgement, on a speaker."* Every number in `ONE_SHOT_SPECS` is a first draft with a reason, and `docs/owner-verification.md` item 14 is where it gets a hearing: *"Confirm the engine pitch tracks speed and that item, impact and lap sounds fire — the whole of §9, which CI proves only as an op list."*

- [ ] **Step 5: Commit**

```bash
git add packages/render/src/audio packages/render/src/index.ts packages/render/package.json packages/render/test/audio-graph.test.ts && git commit -m "feat(render): the Web Audio backend behind Plan 3's seam, and the sound design as data (§9)"
```
