import { describe, expect, it } from 'vitest'
import type { Intent, SimContext, SimState } from '../src/types'
import { COUNTDOWN_TICKS, MAX_KARTS } from '../src/types'
import { createState } from '../src/state'
import { step } from '../src/step'
import { botIntent } from '../src/bot'
import type { AuthEvent } from '../src/types'
import { FINISH_GRACE_TICKS, makeIntentBuffer, resetBotHold, resolveInputs, updatePhase } from '../src/phase'
import { makeContext, makeStraightTrack } from './fixtures/track-fixtures'

const CHARS = [0, 1, 2, 3, 4, 5, 6, 7]

/** A state with all eight slots human-controlled and connected, phase forced. */
function humanState(ctx: SimContext, phase: SimState['phase'], tick: number): SimState {
  const s = createState(ctx, 0x0badc0de, CHARS)
  for (let i = 0; i < MAX_KARTS; i++) {
    s.karts[i].isBot = false
    s.karts[i].connected = true
  }
  s.phase = phase
  s.tick = tick
  return s
}

function intent(over: Partial<Intent>): Intent {
  return { tick: 0, steer: 0, accel: 0, brake: false, drift: false, useItem: false, ...over }
}

describe('resolveInputs', () => {
  it('freezes every input while the phase is countdown', () => {
    const ctx = makeContext(makeStraightTrack())
    const s = humanState(ctx, 'countdown', 42)
    const out = makeIntentBuffer()
    const inputs: Intent[] = []
    for (let i = 0; i < MAX_KARTS; i++) {
      inputs.push(intent({ tick: 41, steer: 0.7, accel: 1, brake: true, drift: true, useItem: true }))
    }

    resolveInputs(ctx, s, inputs, out)

    for (let i = 0; i < MAX_KARTS; i++) {
      expect(out[i].tick).toBe(42)      // stamped with the tick it is applied at
      expect(out[i].steer).toBe(0)
      expect(out[i].accel).toBe(0)
      expect(out[i].brake).toBe(false)
      expect(out[i].drift).toBe(false)
      expect(out[i].useItem).toBe(false)
    }
    // the raw inputs are the caller's; resolveInputs must not have touched them
    expect(inputs[0].steer).toBe(0.7)
    expect(inputs[0].drift).toBe(true)
  })

  it('freezes bots during countdown too', () => {
    const ctx = makeContext(makeStraightTrack())
    const s = humanState(ctx, 'countdown', COUNTDOWN_TICKS) // tick 180, still countdown
    s.karts[5].isBot = true
    const out = makeIntentBuffer()
    const inputs = makeIntentBuffer()

    resetBotHold()
    resolveInputs(ctx, s, inputs, out)

    expect(out[5].tick).toBe(180)
    expect(out[5].steer).toBe(0)
    expect(out[5].accel).toBe(0)
  })

  it('clamps and sanitises human input while racing', () => {
    const ctx = makeContext(makeStraightTrack())
    const s = humanState(ctx, 'racing', 200)
    const out = makeIntentBuffer()
    const inputs: Intent[] = [
      intent({ tick: 199, steer: 3.5, accel: 2.25, brake: true, drift: false, useItem: true }),
      intent({ tick: 199, steer: -4, accel: -0.5, brake: false, drift: true, useItem: false }),
      intent({ tick: 199, steer: Number.NaN, accel: Number.NaN }),
      intent({ tick: 199, steer: Number.POSITIVE_INFINITY, accel: Number.NEGATIVE_INFINITY }),
      intent({ tick: 199, steer: 0.25, accel: 0.75 }),
      intent({ tick: 199, steer: -0.5, accel: 0.5 }),
      // a hostile / sloppy client sending non-booleans
      intent({ tick: 199, brake: 1 as unknown as boolean, drift: 'yes' as unknown as boolean }),
      intent({ tick: 199, steer: -1, accel: 1, brake: true, drift: true, useItem: true }),
    ]

    resolveInputs(ctx, s, inputs, out)

    expect(out[0].steer).toBe(1)        // clamp(3.5, -1, 1)
    expect(out[0].accel).toBe(1)        // clamp(2.25, 0, 1)
    expect(out[0].tick).toBe(200)       // restamped from state.tick, not the client's 199
    expect(out[0].brake).toBe(true)
    expect(out[0].useItem).toBe(true)

    expect(out[1].steer).toBe(-1)       // clamp(-4, -1, 1)
    expect(out[1].accel).toBe(0)        // clamp(-0.5, 0, 1)
    expect(out[1].drift).toBe(true)

    expect(out[2].steer).toBe(0)        // NaN is not clampable; it becomes 0
    expect(out[2].accel).toBe(0)
    expect(Number.isNaN(out[2].steer)).toBe(false)

    expect(out[3].steer).toBe(0)        // +Infinity is non-finite -> 0
    expect(out[3].accel).toBe(0)        // -Infinity is non-finite -> 0

    expect(out[4].steer).toBe(0.25)     // in range, passed through exactly (0.25 = 2^-2)
    expect(out[4].accel).toBe(0.75)     // 0.75 = 3 * 2^-2, exact in binary64
    expect(out[5].steer).toBe(-0.5)
    expect(out[5].accel).toBe(0.5)

    expect(out[6].brake).toBe(false)    // 1 !== true
    expect(out[6].drift).toBe(false)    // 'yes' !== true

    expect(out[7].steer).toBe(-1)
    expect(out[7].accel).toBe(1)
  })

  it('freezes a slot whose raw input is missing', () => {
    const ctx = makeContext(makeStraightTrack())
    const s = humanState(ctx, 'racing', 77)
    const out = makeIntentBuffer()
    // pre-dirty the buffer so a no-op implementation cannot pass by accident
    for (let i = 0; i < MAX_KARTS; i++) {
      out[i].steer = 0.9
      out[i].accel = 0.9
      out[i].drift = true
    }

    resolveInputs(ctx, s, [], out)

    for (let i = 0; i < MAX_KARTS; i++) {
      expect(out[i].tick).toBe(77)
      expect(out[i].steer).toBe(0)
      expect(out[i].accel).toBe(0)
      expect(out[i].drift).toBe(false)
    }
  })

  it('fills bot and disconnected slots from botIntent and ignores their raw input', () => {
    const ctx = makeContext(makeStraightTrack())
    const s = humanState(ctx, 'racing', 200) // 200 % 2 === 0 -> fresh bot compute
    s.karts[3].isBot = true
    s.karts[4].isBot = false
    s.karts[4].connected = false

    const expected3 = botIntent(ctx, s, s.karts[3].playerId)
    const expected4 = botIntent(ctx, s, s.karts[4].playerId)
    const cursorBefore = s.rngCursor

    const out = makeIntentBuffer()
    const inputs: Intent[] = []
    for (let i = 0; i < MAX_KARTS; i++) {
      inputs.push(intent({ tick: 199, steer: 0.9, accel: 0.1, useItem: true }))
    }

    resetBotHold()
    resolveInputs(ctx, s, inputs, out)

    // bot slot: botIntent wins, raw input discarded
    expect(Object.is(out[3].steer, expected3.steer)).toBe(true)
    expect(Object.is(out[3].accel, expected3.accel)).toBe(true)
    expect(out[3].brake).toBe(expected3.brake)
    expect(out[3].drift).toBe(expected3.drift)
    expect(out[3].useItem).toBe(expected3.useItem)
    expect(out[3].tick).toBe(200)
    expect(out[3].steer).not.toBe(0.9)

    // disconnected human: also bot-driven
    expect(Object.is(out[4].steer, expected4.steer)).toBe(true)
    expect(Object.is(out[4].accel, expected4.accel)).toBe(true)
    expect(out[4].tick).toBe(200)

    // connected human next door is untouched by any of that
    expect(out[5].steer).toBe(0.9)
    expect(out[5].accel).toBe(0.1)

    // resolving input is not an authority action: it must not consume PRNG draws
    expect(s.rngCursor).toBe(cursorBefore)
  })

  it('holds bot intents across a tick pair so bots run at 30Hz', () => {
    const ctx = makeContext(makeStraightTrack())
    const s = humanState(ctx, 'racing', 200)
    s.karts[0].isBot = true
    const out = makeIntentBuffer()
    const inputs = makeIntentBuffer()

    resetBotHold()

    // even tick 200: fresh compute
    resolveInputs(ctx, s, inputs, out)
    const first = { steer: out[0].steer, accel: out[0].accel, drift: out[0].drift }
    expect(Object.is(first.steer, botIntent(ctx, s, 0).steer)).toBe(true)
    expect(out[0].tick).toBe(200)

    // move the kart 6 m off the centreline and advance to the ODD tick of the pair.
    // makeStraightTrack runs along +X, so +z is 6 m of lateral displacement.
    s.karts[0].position.z += 6
    s.tick = 201

    resolveInputs(ctx, s, inputs, out)
    expect(Object.is(out[0].steer, first.steer)).toBe(true)   // reused, not recomputed
    expect(Object.is(out[0].accel, first.accel)).toBe(true)
    expect(out[0].drift).toBe(first.drift)
    expect(out[0].tick).toBe(201)                             // but restamped

    // Proof the hold is doing work: a fresh compute from the displaced state differs.
    // If this assertion ever fails, the displacement above is too small for this
    // fixture — raise the 6 m. The load-bearing assertion is the Object.is one above.
    const fresh201 = botIntent(ctx, s, 0)
    expect(fresh201.steer === first.steer && fresh201.accel === first.accel).toBe(false)

    // next even tick 202: recompute from the displaced state
    s.tick = 202
    resolveInputs(ctx, s, inputs, out)
    const fresh202 = botIntent(ctx, s, 0)
    expect(Object.is(out[0].steer, fresh202.steer)).toBe(true)
    expect(Object.is(out[0].steer, first.steer)).toBe(false)
    expect(out[0].tick).toBe(202)
  })

  it('computes a fresh bot intent when the pair starts cold on an odd tick', () => {
    const ctx = makeContext(makeStraightTrack())
    const s = humanState(ctx, 'racing', 301) // odd, and the hold is empty
    s.karts[0].isBot = true
    const out = makeIntentBuffer()

    resetBotHold()
    resolveInputs(ctx, s, makeIntentBuffer(), out)

    const fresh = botIntent(ctx, s, 0)
    expect(Object.is(out[0].steer, fresh.steer)).toBe(true)
    expect(Object.is(out[0].accel, fresh.accel)).toBe(true)
    expect(out[0].tick).toBe(301)
  })
})

describe('updatePhase', () => {
  /**
   * finishedOrder is fixed length MAX_KARTS with -1 in every unused slot, so a
   * test that wants "only kart 2 has finished" must hand updatePhase the padded
   * form. `order(2)` is `[2, -1, -1, -1, -1, -1, -1, -1]`.
   */
  function order(...ids: number[]): number[] {
    const a: number[] = []
    for (let i = 0; i < MAX_KARTS; i++) a.push(i < ids.length ? ids[i] : -1)
    return a
  }

  it('flips countdown to racing at COUNTDOWN_TICKS and emits nothing', () => {
    const ctx = makeContext(makeStraightTrack())
    const events: AuthEvent[] = []

    const early = humanState(ctx, 'countdown', COUNTDOWN_TICKS - 1) // 179
    updatePhase(ctx, early, events)
    expect(early.phase).toBe('countdown')
    expect(events.length).toBe(0)

    const on = humanState(ctx, 'countdown', COUNTDOWN_TICKS)        // 180
    updatePhase(ctx, on, events)
    expect(on.phase).toBe('racing')
    expect(events.length).toBe(0)     // there is no AuthEventKind for "go"

    const late = humanState(ctx, 'countdown', COUNTDOWN_TICKS + 40) // 220
    updatePhase(ctx, late, events)
    expect(late.phase).toBe('racing')
  })

  it('never advances a countdown straight to finished', () => {
    const ctx = makeContext(makeStraightTrack())
    const s = humanState(ctx, 'countdown', COUNTDOWN_TICKS)
    s.finishedOrder = order(0, 1, 2, 3, 4, 5, 6, 7)   // all 8 slots filled
    s.finishTick = 10
    const events: AuthEvent[] = []

    updatePhase(ctx, s, events)

    expect(s.phase).toBe('racing')    // one transition per tick, countdown first
    expect(events.length).toBe(0)
  })

  it('sets finishTick on the tick the first kart appears in finishedOrder', () => {
    const ctx = makeContext(makeStraightTrack())
    const events: AuthEvent[] = []

    const s = humanState(ctx, 'racing', 1234)
    expect(s.finishTick).toBe(-1)     // createState leaves it at -1
    expect(s.finishedOrder).toEqual(order())   // createState leaves all 8 slots at -1
    s.finishedOrder = order(3)

    updatePhase(ctx, s, events)

    expect(s.finishTick).toBe(1234)
    expect(s.phase).toBe('racing')    // 1234 - 1234 = 0 < FINISH_GRACE_TICKS
    expect(events.length).toBe(0)

    // idempotent: a finishTick already set by updateLaps is never overwritten
    const t = humanState(ctx, 'racing', 1234)
    t.finishTick = 1000
    t.finishedOrder = order(3)
    updatePhase(ctx, t, events)
    expect(t.finishTick).toBe(1000)
  })

  it('finishes when every kart is in finishedOrder', () => {
    const ctx = makeContext(makeStraightTrack())
    const s = humanState(ctx, 'racing', 5000)
    s.finishTick = 4000
    s.finishedOrder = order(4, 1, 0, 7, 2, 6, 3, 5) // all 8 slots filled, no -1 left
    const seqBefore = s.nextEventSeq
    const events: AuthEvent[] = []

    updatePhase(ctx, s, events)

    expect(s.phase).toBe('finished')
    expect(s.finishedOrder).toEqual([4, 1, 0, 7, 2, 6, 3, 5]) // unchanged, nobody DNF'd
    expect(events.length).toBe(1)
    expect(events[0].kind).toBe('finish')
    expect(events[0].playerId).toBe(-1)   // -1 = the race itself, not a kart
    expect(events[0].entityId).toBe(-1)
    expect(events[0].item).toBe('none')
    expect(events[0].data).toBe(8)        // 8 filled slots = 8 finishers
    expect(events[0].tick).toBe(5000)
    expect(events[0].eventSeq).toBe(seqBefore)
    expect(s.nextEventSeq).toBe(seqBefore + 1)

    // running again on a finished race is a no-op
    updatePhase(ctx, s, events)
    expect(events.length).toBe(1)
    expect(s.nextEventSeq).toBe(seqBefore + 1)
  })

  it('holds the race open until the grace timer expires', () => {
    const ctx = makeContext(makeStraightTrack())
    const events: AuthEvent[] = []

    expect(FINISH_GRACE_TICKS).toBe(1800)  // 30 s at 60 Hz

    // finishTick 3000, so the race ends on tick 3000 + 1800 = 4800
    const nearly = humanState(ctx, 'racing', 4799)
    nearly.finishTick = 3000
    nearly.finishedOrder = order(2)
    updatePhase(ctx, nearly, events)
    expect(nearly.phase).toBe('racing')    // 4799 - 3000 = 1799 < 1800
    expect(events.length).toBe(0)
  })

  it('finishes on the grace timer and fills DNF karts in placement order', () => {
    const ctx = makeContext(makeStraightTrack())
    const s = humanState(ctx, 'racing', 4800)
    s.finishTick = 3000                    // 4800 - 3000 = 1800 >= FINISH_GRACE_TICKS
    s.finishedOrder = order(2)             // [2, -1, -1, -1, -1, -1, -1, -1]
    // Give every kart a distinct, descending checkpoint index so placement is
    // unambiguous: kart i sits at checkpointIdx 7 - i, all on lap 0, all t 0.
    // Placement best-first is therefore [0,1,2,3,4,5,6,7]; kart 2 already holds
    // slot 0, so the DNF fill writes 0,1,3,4,5,6,7 into slots 1..7 in that order.
    for (let i = 0; i < MAX_KARTS; i++) {
      s.karts[i].lap.lap = 0
      s.karts[i].lap.checkpointIdx = 7 - i
      s.karts[i].lap.t = 0
    }
    const seqBefore = s.nextEventSeq
    const events: AuthEvent[] = []

    updatePhase(ctx, s, events)

    expect(s.phase).toBe('finished')
    expect(s.finishedOrder).toEqual([2, 0, 1, 3, 4, 5, 6, 7])
    expect(s.finishedOrder.length).toBe(8)

    // 7 per-kart DNF finish events, then 1 race-level event
    expect(events.length).toBe(8)
    expect(events.map((e) => e.playerId)).toEqual([0, 1, 3, 4, 5, 6, 7, -1])
    // `data` on a per-kart finish is the 1-based finishing place, exactly as
    // updateLaps [Task 11] emits it: the number of filled finishedOrder slots
    // AFTER that kart was recorded. Kart 2 already held place 1, so the seven
    // DNF karts take places 2..8:
    //   0 -> 2 filled -> 2      4 -> 5 filled -> 5
    //   1 -> 3 filled -> 3      5 -> 6 filled -> 6
    //   3 -> 4 filled -> 4      6 -> 7 filled -> 7
    //                           7 -> 8 filled -> 8
    // The trailing 8 is the race-level event, which carries the finisher count
    // (8, because the fill leaves no slot at -1).
    expect(events.map((e) => e.data)).toEqual([2, 3, 4, 5, 6, 7, 8, 8])
    for (let i = 0; i < 8; i++) {
      expect(events[i].kind).toBe('finish')
      expect(events[i].tick).toBe(4800)
      expect(events[i].entityId).toBe(-1)
      expect(events[i].item).toBe('none')
      expect(events[i].eventSeq).toBe(seqBefore + i)   // strictly monotonic, no gaps
    }
    expect(s.nextEventSeq).toBe(seqBefore + 8)
  })

  it('transitions on a non-leader but emits nothing and burns no eventSeq', () => {
    const ctx = makeContext(makeStraightTrack(), false)  // isLeader = false
    expect(ctx.isLeader).toBe(false)
    const s = humanState(ctx, 'racing', 5000)
    s.finishTick = 4000
    s.finishedOrder = order(4, 1, 0, 7, 2, 6, 3, 5)
    const seqBefore = s.nextEventSeq
    const events: AuthEvent[] = []

    updatePhase(ctx, s, events)

    expect(s.phase).toBe('finished')      // the transition is deterministic everywhere
    expect(events.length).toBe(0)         // but only the authority numbers events
    expect(s.nextEventSeq).toBe(seqBefore)
  })

  it('fills DNF karts on a non-leader too, so finishedOrder stays in sync', () => {
    const ctx = makeContext(makeStraightTrack(), false)
    const s = humanState(ctx, 'racing', 4800)
    s.finishTick = 3000
    s.finishedOrder = order(2)
    for (let i = 0; i < MAX_KARTS; i++) {
      s.karts[i].lap.lap = 0
      s.karts[i].lap.checkpointIdx = 7 - i
      s.karts[i].lap.t = 0
    }
    const seqBefore = s.nextEventSeq
    const events: AuthEvent[] = []

    updatePhase(ctx, s, events)

    expect(s.finishedOrder).toEqual([2, 0, 1, 3, 4, 5, 6, 7])
    expect(events.length).toBe(0)
    expect(s.nextEventSeq).toBe(seqBefore)
  })
})

describe('step() wiring', () => {
  it('runs resolveInputs at position 1 and updatePhase in the tail', () => {
    const ctx = makeContext(makeStraightTrack())
    let cur = createState(ctx, 7, [0, 0, 0, 0, 0, 0, 0, 0])
    let nxt = createState(ctx, 7, [0, 0, 0, 0, 0, 0, 0, 0])
    for (let i = 0; i < MAX_KARTS; i++) {
      cur.karts[i].isBot = false
      cur.karts[i].connected = true
    }
    cur.karts[7].isBot = true

    // Precondition on the fixture grid. If two karts start closer than one kart
    // diameter (2 * kartRadius = 2 * 0.9 = 1.8 m) then resolveKartCollisions
    // would push them apart during the countdown and the exact-zero assertions
    // below would be measuring collisions instead of the input freeze.
    for (let i = 0; i < MAX_KARTS; i++) {
      for (let j = i + 1; j < MAX_KARTS; j++) {
        const dx = cur.karts[i].position.x - cur.karts[j].position.x
        const dz = cur.karts[i].position.z - cur.karts[j].position.z
        expect(Math.sqrt(dx * dx + dz * dz)).toBeGreaterThan(2 * ctx.tuning.kartRadius)
      }
    }

    const startX0 = cur.karts[0].position.x
    const startZ0 = cur.karts[0].position.z
    const startX7 = cur.karts[7].position.x
    // makeStraightTrack's startPositions[0] is s = 0.99, on the track's closing
    // curve back toward the line, not on the s ~ 0 straight the fixture's own
    // doc comment describes -- so kart 0's start heading is NOT 0 (verified by
    // direct query: ctx.query.tangentAt(0.99) gives heading approx -0.2455 rad).
    // The assertion below checks the thing this test actually needs -- that
    // steer 0 introduces no turning -- without assuming a heading value the
    // fixture does not provide.
    const startHeading0 = cur.karts[0].heading

    // Everyone mashes the throttle through the whole countdown.
    const inputs: Intent[] = []
    for (let i = 0; i < MAX_KARTS; i++) {
      inputs.push(intent({ tick: 0, steer: 0, accel: 1, brake: false, drift: true, useItem: true }))
    }
    const events: AuthEvent[] = []

    resetBotHold()
    expect(cur.tick).toBe(0)
    expect(cur.phase).toBe('countdown')

    for (let n = 0; n < COUNTDOWN_TICKS - 1; n++) {   // 179 ticks -> tick 179
      events.length = 0
      step(ctx, cur, nxt, inputs, events)
      const tmp = cur
      cur = nxt
      nxt = tmp
    }
    expect(cur.tick).toBe(179)
    expect(cur.phase).toBe('countdown')

    events.length = 0
    step(ctx, cur, nxt, inputs, events)          // the 180th step
    let tmp = cur
    cur = nxt
    nxt = tmp
    expect(cur.tick).toBe(180)
    expect(cur.phase).toBe('racing')             // updatePhase ran in the tail

    // 180 ticks of full throttle produced exactly nothing, because
    // resolveInputs zeroed every intent before stepKart ever saw one.
    expect(Object.is(cur.karts[0].velocity.x, 0)).toBe(true)
    expect(Object.is(cur.karts[0].velocity.z, 0)).toBe(true)
    expect(Object.is(cur.karts[0].position.x, startX0)).toBe(true)
    expect(Object.is(cur.karts[0].position.z, startZ0)).toBe(true)
    expect(cur.karts[0].drift.active).toBe(false)
    expect(cur.karts[0].drift.charge).toBe(0)
    // and the bot slot was frozen on exactly the same rule
    expect(Object.is(cur.karts[7].velocity.x, 0)).toBe(true)
    expect(Object.is(cur.karts[7].position.x, startX7)).toBe(true)

    // one more tick, now racing: the same input finally does something
    events.length = 0
    step(ctx, cur, nxt, inputs, events)
    tmp = cur
    cur = nxt
    nxt = tmp
    expect(cur.tick).toBe(181)
    expect(cur.phase).toBe('racing')
    expect(cur.karts[0].velocity.x).toBeGreaterThan(0)
    // steer 0 -> no turn: heading is exactly whatever the start grid gave it
    // (see the note above startHeading0), unchanged by this live tick.
    expect(Object.is(cur.karts[0].heading, startHeading0)).toBe(true)
    expect(cur.karts[0].position.x).toBeGreaterThan(startX0)
  })
})
