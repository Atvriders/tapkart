### Task 13: `packages/render/src/audio.ts` — the pure audio model and the authored backend seam

Contract §4.9. Ruling Q26: **procedural audio is out of Plan 3 and deferred to
Plan 5, and the seam is authored now.** A pure model plus a no-op backend, so
Plan 5 adds a Web Audio implementation under `packages/render/src/audio/` and a
barrel line (explicitly permitted by §1a) and touches nothing else. Building a
seam is hours; retrofitting one is a refactor.

Nothing is audible in Plan 3. `AudioModel` is asserted by this task's tests and
that is the whole of the audio verification in this plan (§8.3).

**Files:**
- Create: `packages/render/src/audio.ts`
- Test: `packages/render/test/audio.test.ts`

**Interfaces:**

- Consumes, from `@tapkart/sim` (contract §2.1, §2.2):
  ```ts
  export const MAX_KARTS = 8
  export function clamp(v: number, lo: number, hi: number): number
  ```
- Consumes, from `packages/render/src/hud.ts` (Task 12):
  ```ts
  export type CountdownLabel = '' | '3' | '2' | '1' | 'GO'
  export function countdownLabelFor(phase: RacePhase, countdownTicksLeft: number,
                                    ticksSinceStart: number): CountdownLabel
  ```
  The countdown beep fires on a **label change**, so the beep and the number on
  screen can never disagree — two encodings of one fact is the defect class this
  contract exists to prevent.
- Consumes, from `packages/render/src/types.ts` (contract §4.2, an earlier task) —
  the fields this module reads: `RaceView.{tick, phase, localPlayerId,
  raceStartTick, karts, countdownTicksLeft}` and `KartView.{playerId, source,
  position, heading, speed, driftActive, spinOutTicks, respawnTicks, boostTicks,
  shielded, item, lap}`, plus:
  ```ts
  export function createRaceView(itemBoxCount: number): RaceView
  ```
- **Consumes an arrangement, not a symbol: two `RaceView`s, alternated per
  frame.** `createRaceView` is called **twice** at session construction and the
  two views are swapped **after** `audio.apply(model)` in the frame loop. The
  session task owns the buffers and exposes them as
  ```ts
  currentView(): RaceView      // the view THIS frame is built into
  prevView(): RaceView         // the view the PREVIOUS frame was built into
  swapViews(): void            // exchanges them; called AFTER audio.apply, never before
  ```
  on `RaceSession` (contract §5.10), and the shell task calls
  `buildAudioModel(session.prevView(), session.currentView(), model)` then
  `audio.apply(model)` then `session.swapViews()` (§5.13). **This task specifies
  none of that wiring**, so the two tasks cannot write two different swaps. See
  *The precondition* below for why it is not optional.
- Produces — imported by `src/index.ts` and by `startShell` (§5.13), and
  implemented against by Plan 5:
  ```ts
  export type AudioCueKind =
    | 'engine' | 'skid' | 'impact' | 'itemPickup' | 'itemUse'
    | 'boost' | 'spinOut' | 'respawn' | 'lapCross' | 'countdownBeep' | 'finish'
  export interface AudioCue { kind: AudioCueKind; playerId: number
    intensity: number; pan: number }
  export interface AudioModel { engineFreqHz: number; engineGain: number
    skidGain: number; cues: AudioCue[]; cueCount: number }
  export const MAX_AUDIO_CUES = 16
  export function createAudioModel(): AudioModel
  export function buildAudioModel(prev: RaceView, view: RaceView, out: AudioModel): void
  export interface AudioConfig { masterGain: number; enabled: boolean }
  export interface AudioBackend {
    apply(model: AudioModel): void
    setConfig(cfg: AudioConfig): void
    close(): void
  }
  export const nullAudioBackend: AudioBackend
  ```

---

**The precondition: two views, or no cue can ever fire.**

`buildAudioModel` derives every one-shot from the delta between two views. The
contract as locked allocates exactly **one** `RaceView` per session (§4.2:
*"Called once per session, never per frame"*), and `ViewBuilder.build` is the
*"SOLE WRITER of every RaceView field"* (§5.11), called once per frame by
`startShell`. With one view, `prev` **is** `view`: every delta is empty and no
`impact`, `itemUse`, `itemPickup`, `boost`, `spinOut`, `lapCross`,
`countdownBeep` or `finish` cue can ever fire in the shipped game.

It stays green because §8.1's assertion — *"a lap crossing between two views
fires exactly one `lapCross` cue"* — hand-builds two views with the test-only
`makeRaceView`. **The unit test passes; the shell cannot reproduce its
precondition.** That is this project's signature defect, found for the first time
in a contract rather than in code.

**Ruled:** two `RaceView`s, allocated at session construction, alternated per
frame, with the swap **after** `audio.apply` — cues are consumed in the frame
they are raised, so a swap placed before the consumer drops them just as
thoroughly.

This task carries three consequences:

1. `buildAudioModel(prev, view, out)` keeps its signature. It is a pure function
   of its two arguments and **retains no reference to either** — next frame, the
   object it was handed as `view` is handed back as `prev`, so an implementation
   that stashed a view would compare an object to itself.
2. The test below drives the *real* per-frame arrangement, both ways: one view
   alternating with itself, and two views swapped after the consumer. A test that
   only hand-builds two views cannot see this defect — that is precisely how it
   reached a locked contract.
3. The buffers and the swap belong to the session/shell tasks. Do not add a
   second `createRaceView` call here, and do not cache a view inside `audio.ts`
   to work around a single-view caller: that is the tempting wrong fix, it makes
   the function stateful and frame-order-dependent, and the idempotence test
   below fails on it.

`buildRenderFrame` and `buildHudModel` are unaffected by the alternation: both
read whichever view is current and keep their accumulators on their own `out`.

---

**What the model contains, and what it deliberately does not**

- **`engineFreqHz` / `engineGain` / `skidGain` are the LOCAL kart's, only.** When
  Plan 5 lands: local kart engine voice plus one-shots. Eight oscillators for
  eight engines is a mobile battery problem and a mix nobody can hear through,
  and `AudioModel` is shaped for exactly that today — one engine, N one-shots —
  so Plan 5 changes no signature.
- **`AudioConfig` is a device/user preference, not a property of the audio the
  race is producing (R38).** `masterGain` and `enabled` must never be fields of
  `AudioModel`: a model that carries a setting means moving a volume slider
  re-plans a frame. The seam carries its config from day one — `setConfig` is
  called on every Settings change and once at startup, **never per frame** — so a
  live settings change has somewhere to go and Plan 5 needs no widened concrete
  type and no amendment to the contract.
- **`'engine'` and `'skid'` name continuous voices, not one-shots.** They are in
  `AudioCueKind` because the union names every voice the backend addresses;
  `buildAudioModel` never emits them as cues, and `createAudioModel` uses
  `'engine'` as the inert placeholder kind in unused slots.
- **Overflow drops, never grows.** `cues` is fixed at `MAX_AUDIO_CUES` and only
  `[0, cueCount)` is live. Emission order is fixed — countdown and finish first,
  then seats ascending, then a fixed per-seat kind order — so *which* cues
  survive a busy frame is deterministic and testable rather than incidental.

**What the contract leaves open, decided here** (flagged rather than buried; the
§11 census fixes `render/audio` at the nine exports above, so none of this adds a
symbol):

- **The cue rules.** Per seat, comparing `prev.karts[i]` to `view.karts[i]`:
  `lap` increased → `lapCross`; `'none'` → an item → `itemPickup`; an item →
  `'none'` → `itemUse`; `boostTicks` increased → `boost`; `spinOutTicks`
  increased → `spinOut`; `respawnTicks` increased → `respawn`; `shielded` went
  true → false → `impact` (a popped shield is the only impact a `RaceView`
  witnesses — kart-kart contact is not in the view at all). A seat whose `source`
  is `'absent'` in either view is skipped, so a remote kart appearing or
  vanishing does not fire a burst of phantom cues.
- **`pan` without a camera.** §4.9 describes pan as coming from the camera's
  right axis, but the signature has no camera and adding one would make the audio
  model depend on frame ordering. The local kart's heading is the chase camera's
  heading, so pan is the direction cosine of the sounding kart along the local
  kart's right axis, `right = (-sin h, 0, cos h)` (§0) — a pure direction, in
  `[-1, 1]`, needing no distance constant. The local kart's own cues pan to 0.
- **`intensity`** falls off linearly with plan-view distance from the local kart
  over `CUE_FALLOFF_M` (module-private, 60 m), times a per-kind base weight. A
  spectator with no local seat hears every cue at full intensity and centred:
  there is no listener to be far from.

---

- [ ] **Step 1: Write the failing test**

Create `packages/render/test/audio.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { COUNTDOWN_TICKS, MAX_KARTS } from '@tapkart/sim'
import type { RaceView } from '../src/types'
import { createRaceView } from '../src/types'
import type { AudioModel } from '../src/audio'
import {
  MAX_AUDIO_CUES,
  buildAudioModel,
  createAudioModel,
  nullAudioBackend,
} from '../src/audio'

/** Every seat filled, place === seat, local seat 0, racing, nothing happening. */
function quietView(): RaceView {
  const view = createRaceView(0)
  view.tick = 300
  view.phase = 'racing'
  view.localPlayerId = 0
  view.raceStartTick = 0
  view.countdownTicksLeft = 0
  view.entityCount = 0
  for (let i = 0; i < MAX_KARTS; i++) {
    const k = view.karts[i]
    k.playerId = i
    k.characterIdx = i
    k.source = 'authoritative'
    k.place = i
    k.position.x = 0
    k.position.y = 0
    k.position.z = 0
    k.heading = 0
    k.speed = 0
    k.lap = 0
    k.item = 'none'
    k.boostTicks = 0
    k.spinOutTicks = 0
    k.respawnTicks = 0
    k.shielded = false
    k.driftActive = false
    k.isBot = i !== 0
    k.connected = true
  }
  return view
}

/** Deep-enough copy for a two-view delta: the fields buildAudioModel reads. */
function copyView(src: RaceView): RaceView {
  const dst = quietView()
  dst.tick = src.tick
  dst.phase = src.phase
  dst.localPlayerId = src.localPlayerId
  dst.raceStartTick = src.raceStartTick
  dst.countdownTicksLeft = src.countdownTicksLeft
  for (let i = 0; i < MAX_KARTS; i++) {
    const a = src.karts[i]
    const b = dst.karts[i]
    b.playerId = a.playerId
    b.source = a.source
    b.position.x = a.position.x
    b.position.y = a.position.y
    b.position.z = a.position.z
    b.heading = a.heading
    b.speed = a.speed
    b.lap = a.lap
    b.item = a.item
    b.boostTicks = a.boostTicks
    b.spinOutTicks = a.spinOutTicks
    b.respawnTicks = a.respawnTicks
    b.shielded = a.shielded
    b.driftActive = a.driftActive
  }
  return dst
}

function heard(model: AudioModel): string[] {
  const out: string[] = []
  for (let i = 0; i < model.cueCount; i++) {
    out.push(`${model.cues[i].kind}:${model.cues[i].playerId}`)
  }
  return out
}

describe('createAudioModel', () => {
  it('allocates a fixed cue pool with distinct slots', () => {
    const m = createAudioModel()
    expect(m.cues).toHaveLength(MAX_AUDIO_CUES)
    expect(m.cueCount).toBe(0)
    expect(m.cues[0]).not.toBe(m.cues[1])
    const n = createAudioModel()
    expect(n.cues).not.toBe(m.cues)
  })

  // R38, made mechanical: volume and mute are device preferences carried by
  // AudioConfig through setConfig. A model that carried them would mean moving
  // a slider re-plans a frame - and the leak is invisible until Plan 5.
  it('carries no volume or mute field', () => {
    expect(Object.keys(createAudioModel())).toEqual([
      'engineFreqHz',
      'engineGain',
      'skidGain',
      'cues',
      'cueCount',
    ])
  })
})

describe('buildAudioModel - continuous levels', () => {
  it('rises with the LOCAL kart’s speed and ignores everyone else', () => {
    const prev = quietView()
    const view = copyView(prev)
    const m = createAudioModel()

    buildAudioModel(prev, view, m)
    const idleHz = m.engineFreqHz
    const idleGain = m.engineGain
    expect(idleHz).toBeGreaterThan(0)

    view.karts[5].speed = 40 // a remote kart flat out
    buildAudioModel(prev, view, m)
    expect(m.engineFreqHz).toBe(idleHz)
    expect(m.engineGain).toBe(idleGain)

    view.karts[0].speed = 40
    buildAudioModel(prev, view, m)
    expect(m.engineFreqHz).toBeGreaterThan(idleHz)
    expect(m.engineGain).toBeGreaterThan(idleGain)
    expect(m.engineGain).toBeLessThanOrEqual(1)
  })

  it('cuts the engine while motion-locked', () => {
    const prev = quietView()
    const view = copyView(prev)
    const m = createAudioModel()
    view.karts[0].speed = 20
    view.karts[0].respawnTicks = 40
    buildAudioModel(prev, view, m)
    expect(m.engineGain).toBe(0)
  })

  it('opens the skid voice only while drifting or spun out', () => {
    const prev = quietView()
    const view = copyView(prev)
    const m = createAudioModel()

    view.karts[0].speed = 20
    buildAudioModel(prev, view, m)
    expect(m.skidGain).toBe(0)

    view.karts[0].driftActive = true
    buildAudioModel(prev, view, m)
    const drifting = m.skidGain
    expect(drifting).toBeGreaterThan(0)

    view.karts[0].driftActive = false
    view.karts[0].spinOutTicks = 30
    buildAudioModel(prev, view, m)
    expect(m.skidGain).toBeGreaterThan(0)

    view.karts[0].spinOutTicks = 0
    buildAudioModel(prev, view, m)
    expect(m.skidGain).toBe(0)
  })

  it('is silent with no local seat', () => {
    const prev = quietView()
    const view = copyView(prev)
    view.localPlayerId = -1
    view.karts[0].speed = 40
    const m = createAudioModel()
    buildAudioModel(prev, view, m)
    expect(m.engineFreqHz).toBe(0)
    expect(m.engineGain).toBe(0)
    expect(m.skidGain).toBe(0)
  })
})

describe('buildAudioModel - one-shots', () => {
  // §8.1, verbatim: a lap crossing between two views fires exactly one lapCross
  // cue and no others.
  it('fires exactly one lapCross on a lap crossing', () => {
    const prev = quietView()
    const view = copyView(prev)
    view.tick = prev.tick + 1
    view.karts[3].lap = 1
    const m = createAudioModel()
    buildAudioModel(prev, view, m)
    expect(heard(m)).toEqual(['lapCross:3'])
    expect(m.cues[0].intensity).toBeGreaterThan(0)
  })

  // Catches level-triggering instead of edge-triggering: a cue that fires while
  // a condition HOLDS repeats 60 times a second and is unlistenable.
  it('fires nothing when nothing changed', () => {
    const prev = quietView()
    prev.karts[2].lap = 2
    prev.karts[2].item = 'bolt'
    prev.karts[2].boostTicks = 40
    prev.karts[2].spinOutTicks = 20
    prev.karts[2].respawnTicks = 10
    prev.karts[2].shielded = true
    const view = copyView(prev)
    const m = createAudioModel()
    buildAudioModel(prev, view, m)
    expect(heard(m)).toEqual([])
    expect(m.cueCount).toBe(0)
  })

  it('fires each edge once, and never on its reverse', () => {
    const table: { name: string; set: (k: RaceView['karts'][number]) => void; cue: string }[] = [
      { name: 'itemPickup', set: (k) => { k.item = 'seeker' }, cue: 'itemPickup:1' },
      { name: 'boost', set: (k) => { k.boostTicks = 90 }, cue: 'boost:1' },
      { name: 'spinOut', set: (k) => { k.spinOutTicks = 60 }, cue: 'spinOut:1' },
      { name: 'respawn', set: (k) => { k.respawnTicks = 72 }, cue: 'respawn:1' },
    ]
    for (const row of table) {
      const prev = quietView()
      const view = copyView(prev)
      row.set(view.karts[1])
      const m = createAudioModel()
      buildAudioModel(prev, view, m)
      expect(heard(m)).toEqual([row.cue])

      // The reverse edge (the timer running out, the item being consumed) is
      // not this cue.
      const m2 = createAudioModel()
      buildAudioModel(view, prev, m2)
      expect(heard(m2)).not.toContain(row.cue)
    }
  })

  it('fires itemUse when an item leaves the slot, and impact when a shield pops', () => {
    const prev = quietView()
    prev.karts[4].item = 'bolt'
    prev.karts[4].shielded = true
    const view = copyView(prev)
    view.karts[4].item = 'none'
    view.karts[4].shielded = false
    const m = createAudioModel()
    buildAudioModel(prev, view, m)
    expect(heard(m).sort()).toEqual(['impact:4', 'itemUse:4'])
  })

  // Catches a burst of phantom cues when a remote kart's interpolation buffer
  // starves and recovers: 'absent' fields are stale, not news.
  it('skips a seat that is absent in either view', () => {
    const prev = quietView()
    prev.karts[6].source = 'absent'
    const view = copyView(prev)
    view.karts[6].source = 'interpolated'
    view.karts[6].lap = 2
    view.karts[6].item = 'blink'
    const m = createAudioModel()
    buildAudioModel(prev, view, m)
    expect(heard(m)).toEqual([])
  })

  it('beeps once per countdown digit, and only on the change', () => {
    const prev = quietView()
    prev.phase = 'countdown'
    prev.tick = 59
    prev.raceStartTick = COUNTDOWN_TICKS
    prev.countdownTicksLeft = COUNTDOWN_TICKS - 59
    const same = copyView(prev)
    const m = createAudioModel()
    buildAudioModel(prev, same, m)
    expect(heard(m)).toEqual([])

    const next = copyView(prev)
    next.tick = 60
    next.countdownTicksLeft = COUNTDOWN_TICKS - 60 // '3' -> '2'
    buildAudioModel(prev, next, m)
    expect(heard(m)).toEqual(['countdownBeep:0'])
  })

  it('fires finish once, on the transition into finished', () => {
    const prev = quietView()
    const view = copyView(prev)
    view.phase = 'finished'
    const m = createAudioModel()
    buildAudioModel(prev, view, m)
    expect(heard(m)).toEqual(['finish:0'])

    const after = copyView(view)
    buildAudioModel(view, after, m)
    expect(heard(m)).toEqual([])
  })

  // §8.1: more than MAX_AUDIO_CUES cues in one frame drops rather than grows.
  // The array itself must not grow either - the backend owns those slots.
  it('drops rather than grows when a frame is busy', () => {
    const prev = quietView()
    const view = copyView(prev)
    for (let i = 0; i < MAX_KARTS; i++) {
      view.karts[i].lap = 1
      view.karts[i].item = 'boost'
      view.karts[i].boostTicks = 90
    } // 8 seats x 3 edges = 24 cues offered
    const m = createAudioModel()
    buildAudioModel(prev, view, m)
    expect(m.cueCount).toBe(MAX_AUDIO_CUES)
    expect(m.cues).toHaveLength(MAX_AUDIO_CUES)
    // Deterministic survivors: seats ascending, fixed per-seat kind order.
    expect(heard(m)[0]).toBe('lapCross:0')
    expect(heard(m)[MAX_AUDIO_CUES - 1]).toBe('lapCross:5')
  })

  it('resets cueCount every call rather than accumulating', () => {
    const prev = quietView()
    const view = copyView(prev)
    view.karts[3].lap = 1
    const m = createAudioModel()
    buildAudioModel(prev, view, m)
    buildAudioModel(prev, view, m)
    buildAudioModel(prev, view, m)
    expect(m.cueCount).toBe(1)
  })

  it('pans by the sounding kart’s bearing off the local kart’s right axis', () => {
    const prev = quietView()
    const view = copyView(prev)
    // local kart at the origin, heading 0: right = (-sin 0, 0, cos 0) = +z
    view.karts[1].position.z = 10
    view.karts[2].position.z = -10
    view.karts[3].position.x = 10
    view.karts[1].lap = 1
    view.karts[2].lap = 1
    view.karts[3].lap = 1
    const m = createAudioModel()
    buildAudioModel(prev, view, m)
    const live = Array.from({ length: m.cueCount }, (_, i) => m.cues[i])
    const byPlayer = new Map(live.map((c) => [c.playerId, c] as const))
    expect(byPlayer.get(1)?.pan).toBeCloseTo(1, 9)
    expect(byPlayer.get(2)?.pan).toBeCloseTo(-1, 9)
    expect(byPlayer.get(3)?.pan).toBeCloseTo(0, 9)
  })

  it('quietens a distant cue and never leaves the 0..1 range', () => {
    const prev = quietView()
    const view = copyView(prev)
    view.karts[1].lap = 1
    view.karts[2].lap = 1
    view.karts[2].position.x = 1000
    const m = createAudioModel()
    buildAudioModel(prev, view, m)
    const near = Array.from({ length: m.cueCount }, (_, i) => m.cues[i]).find(
      (c) => c.playerId === 1,
    )
    const far = Array.from({ length: m.cueCount }, (_, i) => m.cues[i]).find(
      (c) => c.playerId === 2,
    )
    expect(near?.intensity).toBeGreaterThan(far?.intensity ?? 1)
    expect(far?.intensity).toBeGreaterThanOrEqual(0)
    expect(near?.intensity).toBeLessThanOrEqual(1)
  })
})

describe('buildAudioModel - the double-buffered view (the arrangement)', () => {
  /** One frame of authoritative truth, as ViewBuilder.build would resolve it. */
  interface Truth {
    tick: number
    laps: readonly number[]
  }

  /**
   * Stands in for ViewBuilder.build: SOLE WRITER of the fields it fills, into a
   * caller-owned view. It holds no state of its own, exactly as the real one
   * does not.
   */
  function writeView(out: RaceView, t: Truth): void {
    out.tick = t.tick
    out.phase = 'racing'
    out.localPlayerId = 0
    out.raceStartTick = 0
    out.countdownTicksLeft = 0
    for (let i = 0; i < MAX_KARTS; i++) {
      const k = out.karts[i]
      k.playerId = i
      k.source = 'authoritative'
      k.place = i
      k.position.x = 0
      k.position.y = 0
      k.position.z = 0
      k.heading = 0
      k.speed = 10
      k.lap = t.laps[i]
      k.item = 'none'
      k.boostTicks = 0
      k.spinOutTicks = 0
      k.respawnTicks = 0
      k.shielded = false
      k.driftActive = false
    }
  }

  const SCRIPT: readonly Truth[] = [
    { tick: 0, laps: [0, 0, 0, 0, 0, 0, 0, 0] },
    { tick: 1, laps: [0, 0, 0, 0, 0, 0, 0, 0] },
    { tick: 2, laps: [1, 0, 0, 0, 0, 0, 0, 0] }, // the local kart crosses the line
    { tick: 3, laps: [1, 0, 0, 0, 0, 0, 0, 0] },
  ]

  /** The contract as locked: ONE RaceView, written every frame by the builder. */
  function runSingleBuffer(): { cues: string[]; finalLap: number } {
    const view = createRaceView(0)
    const model = createAudioModel()
    const cues: string[] = []
    for (const t of SCRIPT) {
      writeView(view, t)
      buildAudioModel(view, view, model) // there is no other view to pass
      cues.push(...heard(model))
    }
    return { cues, finalLap: view.karts[0].lap }
  }

  /** The ruling: two views, alternated, swapped AFTER the consumer reads. */
  function runDoubleBuffer(): { cues: string[]; finalLap: number } {
    let prev = createRaceView(0)
    let cur = createRaceView(0)
    const model = createAudioModel()
    const cues: string[] = []
    writeView(prev, SCRIPT[0])
    for (let n = 1; n < SCRIPT.length; n++) {
      writeView(cur, SCRIPT[n])
      buildAudioModel(prev, cur, model)
      cues.push(...heard(model)) // audio.apply(model) happens here
      const tmp = prev
      prev = cur
      cur = tmp // ... and the swap happens after it
    }
    return { cues, finalLap: prev.karts[0].lap }
  }

  // What this catches: the contract defect itself - a shell that keeps one
  // RaceView is silent for the whole race, and every hand-built two-view test
  // in this file passes anyway. It is executable evidence for the precondition,
  // in the package that owns the consumer; the matching assertion INSIDE the
  // real frame loop belongs to the session/shell tasks that own the buffers.
  it('is silent when one view is alternated with itself', () => {
    const run = runSingleBuffer()
    expect(run.cues).toEqual([])
    // Non-vacuity: the race really did happen in that single view.
    expect(run.finalLap).toBe(1)
  })

  it('raises exactly the crossing when two views are alternated', () => {
    const run = runDoubleBuffer()
    expect(run.cues).toEqual(['lapCross:0'])
    expect(run.finalLap).toBe(1)
  })

  // Catches the tempting wrong fix: caching a view inside audio.ts so a
  // single-view caller "works". That makes the function stateful, so a repeated
  // call with the same pair would stop producing the same cues.
  it('retains nothing between calls', () => {
    const prev = quietView()
    const view = copyView(prev)
    view.karts[2].lap = 1
    const a = createAudioModel()
    const b = createAudioModel()
    buildAudioModel(prev, view, a)
    buildAudioModel(prev, view, a)
    buildAudioModel(prev, view, b)
    expect(heard(a)).toEqual(['lapCross:2'])
    expect(heard(b)).toEqual(heard(a))
    // and the argument objects are untouched
    expect(prev.karts[2].lap).toBe(0)
    expect(view.karts[2].lap).toBe(1)
  })
})

describe('nullAudioBackend', () => {
  it('implements all three methods and returns nothing', () => {
    const m = createAudioModel()
    expect(nullAudioBackend.apply(m)).toBeUndefined()
    expect(nullAudioBackend.setConfig({ masterGain: 0.5, enabled: false })).toBeUndefined()
    expect(nullAudioBackend.close()).toBeUndefined()
  })

  // The seam is one-way: a backend consumes the model and never writes back,
  // or the next frame's plan would depend on the last frame's output device.
  it('does not mutate the model it is handed', () => {
    const m = createAudioModel()
    m.engineGain = 0.4
    m.cueCount = 1
    m.cues[0].kind = 'boost'
    const before = JSON.stringify(m)
    nullAudioBackend.apply(m)
    nullAudioBackend.setConfig({ masterGain: 0, enabled: false })
    expect(JSON.stringify(m)).toBe(before)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/render/test/audio.test.ts`

Expected: FAIL — the module under test does not exist yet:

```
Error: Failed to load url ../src/audio (resolved id: /home/kasm-user/tapkart/packages/render/src/audio) in /home/kasm-user/tapkart/packages/render/test/audio.test.ts. Does the file exist?
```

- [ ] **Step 3: Write the implementation**

Create `packages/render/src/audio.ts`:

```ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/render/test/audio.test.ts`
Expected: PASS, 22 tests.

Run: `npm run typecheck --workspace @tapkart/render`
Expected: exit 0, no output.

- [ ] **Step 5: Commit**

```bash
git add packages/render/src/audio.ts packages/render/test/audio.test.ts && git commit -m "feat(render): pure AudioModel planner and the authored backend seam

Q26 keeps audio inaudible in Plan 3 and authors the seam: a pure model, an
AudioBackend carrying setConfig from day one so volume and mute stay device
preferences rather than fields of the model (R38), and a no-op backend Plan 5
replaces without touching anything else.

One-shots come from the delta between two RaceViews, so the session must hold
two and swap them after audio.apply - with a single view every delta is empty
and no cue can ever fire. The test drives both arrangements and asserts the
single-view one is silent while the race is provably happening in it."
```
