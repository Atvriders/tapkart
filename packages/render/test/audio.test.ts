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

// Task 13's defect class, in this module. Every other test in this file sits in
// seat 0, so `view.karts[0]` where `view.karts[view.localPlayerId]` belongs is
// green in all of them - right on a solo host, wrong for seven guests in eight.
// The listener IS the local seat: it sets the engine and skid voices, it is the
// origin pan and intensity are measured from, and it is the playerId the
// seat-less cues are addressed to. Each test below puts a decoy in seat 0 whose
// values differ from the local seat's, so reading the wrong seat fails loudly
// rather than agreeing by accident.
describe('buildAudioModel - the listener is localPlayerId, never seat 0', () => {
  /** A guest in seat 5: elsewhere on the track and pointing elsewhere. */
  function guestView(): RaceView {
    const view = quietView()
    view.localPlayerId = 5
    view.karts[5].position.x = 100
    view.karts[5].heading = Math.PI / 2 // right = (-sin h, 0, cos h) = -x
    return view
  }

  it('reads the engine voice off the local seat while seat 0 is flat out', () => {
    const prev = guestView()
    const view = copyView(prev)
    const m = createAudioModel()

    buildAudioModel(prev, view, m)
    const idleHz = m.engineFreqHz
    const idleGain = m.engineGain
    expect(idleHz).toBeGreaterThan(0)

    view.karts[0].speed = 40 // the decoy: seat 0 at top speed
    buildAudioModel(prev, view, m)
    expect(m.engineFreqHz).toBe(idleHz)
    expect(m.engineGain).toBe(idleGain)

    view.karts[5].speed = 40
    buildAudioModel(prev, view, m)
    expect(m.engineFreqHz).toBeGreaterThan(idleHz)
    expect(m.engineGain).toBeGreaterThan(idleGain)
  })

  it('takes the motion lock and the skid from the local seat, not the decoy', () => {
    const prev = guestView()
    const view = copyView(prev)
    const m = createAudioModel()
    view.karts[5].speed = 20
    view.karts[0].speed = 20
    view.karts[0].driftActive = true // the decoy is sideways...
    view.karts[0].respawnTicks = 40 // ...and motion-locked
    buildAudioModel(prev, view, m)
    expect(m.skidGain).toBe(0)
    expect(m.engineGain).toBeGreaterThan(0)

    view.karts[5].driftActive = true
    buildAudioModel(prev, view, m)
    expect(m.skidGain).toBeGreaterThan(0)

    view.karts[5].respawnTicks = 40
    buildAudioModel(prev, view, m)
    expect(m.engineGain).toBe(0)
  })

  // A guest whose own seat has not arrived yet has no listener at all. Seat 0
  // is present and moving, so an implementation listening there is audible.
  it('is silent when the local seat is absent even though seat 0 is not', () => {
    const prev = guestView()
    const view = copyView(prev)
    view.karts[0].speed = 40
    view.karts[5].speed = 40
    view.karts[5].source = 'absent'
    const m = createAudioModel()
    buildAudioModel(prev, view, m)
    expect(m.engineFreqHz).toBe(0)
    expect(m.engineGain).toBe(0)
    expect(m.skidGain).toBe(0)
  })

  it('measures pan and intensity from the local seat, and centres its own cue', () => {
    const prev = guestView()
    const view = copyView(prev)
    // Listener at (100, 0, 0) facing +z-ish: heading pi/2 makes right = -x.
    // Four distinct distances, so first, last, max and sum all differ.
    view.karts[1].position.x = 70 // 30 m to the listener's RIGHT
    view.karts[2].position.x = 115 // 15 m to its LEFT
    view.karts[3].position.x = 100
    view.karts[3].position.z = 45 // 45 m dead ahead
    for (const seat of [1, 2, 3, 5]) view.karts[seat].lap = 1
    const m = createAudioModel()
    buildAudioModel(prev, view, m)

    const live = Array.from({ length: m.cueCount }, (_, i) => m.cues[i])
    const byPlayer = new Map(live.map((c) => [c.playerId, c] as const))
    expect(heard(m)).toEqual(['lapCross:1', 'lapCross:2', 'lapCross:3', 'lapCross:5'])

    expect(byPlayer.get(1)?.pan).toBeCloseTo(1, 9)
    expect(byPlayer.get(2)?.pan).toBeCloseTo(-1, 9)
    expect(byPlayer.get(3)?.pan).toBeCloseTo(0, 9)
    // The listener's own cue is centred by identity, not by a zero distance.
    expect(byPlayer.get(5)?.pan).toBe(0)

    // CUE_FALLOFF_M is 60: 30 m -> 0.5, 15 m -> 0.75, 45 m -> 0.25, 0 m -> 1.
    expect(byPlayer.get(1)?.intensity).toBeCloseTo(0.5, 9)
    expect(byPlayer.get(2)?.intensity).toBeCloseTo(0.75, 9)
    expect(byPlayer.get(3)?.intensity).toBeCloseTo(0.25, 9)
    expect(byPlayer.get(5)?.intensity).toBeCloseTo(1, 9)
  })

  // The seat-less cues carry the local playerId. Every other cue test in this
  // file expects ':0', which a hard-coded 0 satisfies.
  it('addresses the countdown beep and the finish cue to the local seat', () => {
    const prev = guestView()
    prev.phase = 'countdown'
    prev.tick = 0
    prev.raceStartTick = COUNTDOWN_TICKS
    prev.countdownTicksLeft = COUNTDOWN_TICKS // '3'
    const next = copyView(prev)
    next.tick = 121
    next.countdownTicksLeft = COUNTDOWN_TICKS - 121 // '1'
    const m = createAudioModel()
    buildAudioModel(prev, next, m)
    expect(heard(m)).toEqual(['countdownBeep:5'])

    const racing = guestView()
    const finished = copyView(racing)
    finished.phase = 'finished'
    const m2 = createAudioModel()
    buildAudioModel(racing, finished, m2)
    expect(heard(m2)).toEqual(['finish:5'])
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
