import { describe, expect, it } from 'vitest'
import type { Intent, SimContext, SimState } from '../src/types'
import { COUNTDOWN_TICKS, MAX_KARTS } from '../src/types'
import { rngAt } from '../src/rng'
import { createState, statesEqual } from '../src/state'
import type { IntentSource } from '../src/replay'
import {
  INTENT_HEADER,
  INTENT_STRIDE,
  allocStateLike,
  intentOffset,
  recordRun,
  replayRun,
} from '../src/replay'
import { makeIntentBuffer, resetBotHold, resolveInputs } from '../src/phase'
import { makeContext, makeOvalTrack } from './fixtures/track-fixtures'

const CHARS = [0, 1, 2, 3, 4, 5, 6, 7]
const SEED = 0x1234abcd

/** Eight human, connected karts. No bot hold involvement at all. */
function humanStart(ctx: SimContext): SimState {
  const s = createState(ctx, SEED, CHARS)
  for (let i = 0; i < MAX_KARTS; i++) {
    s.karts[i].isBot = false
    s.karts[i].connected = true
  }
  return s
}

/**
 * A deterministic, varied driver. Pure in (state.tick, playerId): it draws from
 * splitmix32 on its own seed, so it never touches state.rngCursor and cannot
 * interfere with authority item rolls.
 */
const scriptedSrc: IntentSource = {
  intentFor(state: SimState, playerId: number): Intent {
    const c = state.tick * MAX_KARTS + playerId
    const a = rngAt(0x5eed, c * 4 + 0)
    const b = rngAt(0x5eed, c * 4 + 1)
    const d = rngAt(0x5eed, c * 4 + 2)
    const e = rngAt(0x5eed, c * 4 + 3)
    return {
      tick: state.tick,
      steer: a * 2 - 1,        // full -1..1 sweep
      accel: b < 0.1 ? 0 : 1,  // throttle 90% of ticks
      brake: d < 0.05,
      drift: e < 0.35,
      useItem: d > 0.98,
    }
  },
}

/** playerId-dependent constants, all exact binary64 multiples of 1/8. */
const constSrc: IntentSource = {
  intentFor(state: SimState, playerId: number): Intent {
    return {
      tick: state.tick,
      steer: playerId * 0.125 - 0.5,
      accel: 1,
      brake: false,
      drift: playerId === 3,
      useItem: false,
    }
  },
}

describe('recordRun', () => {
  it('writes a flat Float64Array with a four-double header', () => {
    const ctx = makeContext(makeOvalTrack())
    const start = humanStart(ctx)
    start.phase = 'racing'   // skip the countdown so the karts actually move

    const rec = recordRun(ctx, start, 4, constSrc)

    // 4 header doubles + 4 ticks * 8 karts * 5 doubles = 4 + 160 = 164
    expect(INTENT_HEADER).toBe(4)
    expect(INTENT_STRIDE).toBe(5)
    expect(rec.intents.length).toBe(164)
    expect(rec.intents[0]).toBe(0)   // baseTick = start.tick
    expect(rec.intents[1]).toBe(4)   // rows
    expect(rec.intents[2]).toBe(8)   // MAX_KARTS
    expect(rec.intents[3]).toBe(5)   // INTENT_STRIDE
    expect(rec.end.tick).toBe(4)

    // offset(tick 0, slot 0) = 4 + ((0 - 0) * 8 + 0) * 5 = 4
    expect(intentOffset(rec.intents, 0, 0)).toBe(4)
    expect(rec.intents[4]).toBe(-0.5)   // steer   = 0 * 0.125 - 0.5
    expect(rec.intents[5]).toBe(1)      // accel
    expect(rec.intents[6]).toBe(0)      // brake   false
    expect(rec.intents[7]).toBe(0)      // drift   false
    expect(rec.intents[8]).toBe(0)      // useItem false

    // offset(tick 0, slot 3) = 4 + ((0 - 0) * 8 + 3) * 5 = 19
    expect(intentOffset(rec.intents, 0, 3)).toBe(19)
    expect(rec.intents[19]).toBe(-0.125)  // 3 * 0.125 - 0.5
    expect(rec.intents[22]).toBe(1)       // drift true only for playerId 3

    // offset(tick 3, slot 7) = 4 + ((3 - 0) * 8 + 7) * 5 = 4 + 155 = 159
    expect(intentOffset(rec.intents, 3, 7)).toBe(159)
    expect(rec.intents[159]).toBe(0.375)  // 7 * 0.125 - 0.5
    expect(rec.intents[160]).toBe(1)

    // the run did something
    expect(rec.end.karts[0].position.x).not.toBe(start.karts[0].position.x)
  })

  it('with zero ticks returns a detached copy of the start state', () => {
    const ctx = makeContext(makeOvalTrack())
    const start = humanStart(ctx)

    const rec = recordRun(ctx, start, 0, constSrc)

    expect(rec.intents.length).toBe(4)   // header only
    expect(rec.intents[1]).toBe(0)
    expect(rec.end).not.toBe(start)      // a different object...
    expect(statesEqual(rec.end, start)).toBe(true)  // ...with identical contents

    rec.end.karts[2].position.x += 999
    expect(start.karts[2].position.x).not.toBe(rec.end.karts[2].position.x)
  })

  it('does not mutate the state it was handed', () => {
    const ctx = makeContext(makeOvalTrack())
    const start = humanStart(ctx)
    start.phase = 'racing'
    const before = allocStateLike(ctx, start)

    recordRun(ctx, start, 30, scriptedSrc)

    expect(statesEqual(start, before)).toBe(true)
    expect(start.tick).toBe(0)
  })
})

describe('replayRun', () => {
  it('reproduces a recorded run from its own start state', () => {
    const ctx = makeContext(makeOvalTrack())
    const start = humanStart(ctx)
    start.phase = 'racing'

    const rec = recordRun(ctx, start, 40, scriptedSrc)
    const replayed = replayRun(ctx, allocStateLike(ctx, start), rec.intents, 0, 40)

    expect(replayed.tick).toBe(40)
    expect(statesEqual(replayed, rec.end)).toBe(true)
  })

  it('is repeatable and never mutates the state it resumes from', () => {
    const ctx = makeContext(makeOvalTrack())
    const start = humanStart(ctx)
    start.phase = 'racing'
    const rec = recordRun(ctx, start, 40, scriptedSrc)

    const from = allocStateLike(ctx, start)
    const savedX = from.karts[0].position.x
    const a = replayRun(ctx, from, rec.intents, 0, 40)
    const b = replayRun(ctx, from, rec.intents, 0, 40)

    expect(statesEqual(a, b)).toBe(true)
    expect(a).not.toBe(b)
    expect(from.tick).toBe(0)
    expect(Object.is(from.karts[0].position.x, savedX)).toBe(true)
  })
})

describe('checkpoint-replay equivalence', () => {
  // N = 600 ticks from tick 0. COUNTDOWN_TICKS = 180, so ticks 1..180 run with
  // frozen input and 181..600 are live racing: 420 racing ticks = 7.0 s at 60Hz.
  // The checkpoint is taken at T = 361, an odd tick (see the parity invariant),
  // leaving 600 - 361 = 239 ticks to replay.
  const N = 600
  const T = 361

  it('replays bit-identically from a full-precision checkpoint', () => {
    const ctx = makeContext(makeOvalTrack())
    const start = humanStart(ctx)

    // A: the straight-through run, 0 -> 600.
    const straight = recordRun(ctx, start, N, scriptedSrc)
    expect(straight.end.tick).toBe(600)
    expect(straight.end.phase).toBe('racing')   // 600 ticks is far short of 3 laps
    expect(straight.end.karts[0].position.x).not.toBe(start.karts[0].position.x)
    expect(straight.end.karts[7].position.x).not.toBe(start.karts[7].position.x)

    // B: the same trajectory, split at T so we hold the state at T.
    const seg1 = recordRun(ctx, start, T, scriptedSrc)          // 0 -> 361
    const seg2 = recordRun(ctx, seg1.end, N - T, scriptedSrc)   // 361 -> 600
    expect(seg1.end.tick).toBe(361)
    expect(seg2.end.tick).toBe(600)
    // splitting the run changes nothing: the sim is a pure function of state+input
    expect(statesEqual(seg2.end, straight.end)).toBe(true)

    // 4 + 239 * 8 * 5 = 4 + 9560 = 9564
    expect(seg2.intents.length).toBe(9564)
    expect(seg2.intents[0]).toBe(361)   // baseTick
    expect(seg2.intents[1]).toBe(239)   // rows
    // row 361 holds what the source produced from the state at tick 361
    const o = intentOffset(seg2.intents, 361, 5)
    expect(o).toBe(INTENT_HEADER + ((361 - 361) * MAX_KARTS + 5) * INTENT_STRIDE) // 29
    expect(seg2.intents[o]).toBe(scriptedSrc.intentFor(seg1.end, 5).steer)

    // The checkpoint: a full-precision structural clone, exactly what
    // AuthorityCheckpoint carries on the reliable channel.
    const checkpoint = allocStateLike(ctx, seg1.end)
    expect(checkpoint).not.toBe(seg1.end)
    expect(checkpoint.tick).toBe(361)
    expect(statesEqual(checkpoint, seg1.end)).toBe(true)

    // Restore it and replay the recorded inputs 361 -> 600.
    const replayed = replayRun(ctx, checkpoint, seg2.intents, T, N)

    expect(replayed.tick).toBe(600)
    expect(statesEqual(replayed, straight.end)).toBe(true)

    // statesEqual returns a bare boolean, so name the fields too: a failure
    // should say which kart and which quantity, not just "false".
    for (let i = 0; i < MAX_KARTS; i++) {
      const r = replayed.karts[i]
      const s = straight.end.karts[i]
      expect(Object.is(r.position.x, s.position.x)).toBe(true)
      expect(Object.is(r.position.y, s.position.y)).toBe(true)
      expect(Object.is(r.position.z, s.position.z)).toBe(true)
      expect(Object.is(r.velocity.x, s.velocity.x)).toBe(true)
      expect(Object.is(r.velocity.z, s.velocity.z)).toBe(true)
      expect(Object.is(r.heading, s.heading)).toBe(true)
      expect(Object.is(r.angularVelocity, s.angularVelocity)).toBe(true)
      expect(Object.is(r.drift.charge, s.drift.charge)).toBe(true)
      expect(r.drift.active).toBe(s.drift.active)
      expect(r.drift.dir).toBe(s.drift.dir)
      expect(r.item).toBe(s.item)
      expect(r.surface).toBe(s.surface)
      expect(r.airborne).toBe(s.airborne)
      expect(r.boostTicks).toBe(s.boostTicks)
      expect(r.spinOutTicks).toBe(s.spinOutTicks)
      expect(r.invulnTicks).toBe(s.invulnTicks)
      expect(r.respawnTicks).toBe(s.respawnTicks)
      expect(r.lap.lap).toBe(s.lap.lap)
      expect(r.lap.checkpointIdx).toBe(s.lap.checkpointIdx)
      expect(Object.is(r.lap.t, s.lap.t)).toBe(true)
    }

    // World state, not just karts: PRNG cursor, event sequence, entity pool.
    expect(replayed.rngCursor).toBe(straight.end.rngCursor)
    expect(replayed.nextEventSeq).toBe(straight.end.nextEventSeq)
    expect(replayed.nextEntityId).toBe(straight.end.nextEntityId)
    expect(replayed.entityCount).toBe(straight.end.entityCount)
    expect(replayed.phase).toBe(straight.end.phase)
    expect(replayed.finishTick).toBe(straight.end.finishTick)
    expect(replayed.finishedOrder).toEqual(straight.end.finishedOrder)
    for (let e = 0; e < replayed.entities.length; e++) {
      expect(replayed.entities[e].entityId).toBe(straight.end.entities[e].entityId)
      expect(Object.is(replayed.entities[e].position.x, straight.end.entities[e].position.x)).toBe(true)
      expect(replayed.entities[e].ttl).toBe(straight.end.entities[e].ttl)
    }

    // The checkpoint is a real copy, not a view onto seg1.end.
    checkpoint.karts[0].position.x += 1000
    expect(seg1.end.karts[0].position.x).not.toBe(checkpoint.karts[0].position.x)
  })
})

/** Bumps a finite double by exactly one unit in the last place, away from zero. */
function ulpUp(x: number): number {
  const dv = new DataView(new ArrayBuffer(8))
  dv.setFloat64(0, x)
  const hi = dv.getUint32(0)
  const lo = dv.getUint32(4)
  if (lo === 0xffffffff) {
    dv.setUint32(0, hi + 1)
    dv.setUint32(4, 0)
  } else {
    dv.setUint32(4, lo + 1)
  }
  return dv.getFloat64(0)
}

/** Slots 0-3 human and connected, slots 4-7 bot-driven. */
function botStart(ctx: SimContext): SimState {
  const s = createState(ctx, SEED, CHARS)
  for (let i = 0; i < MAX_KARTS; i++) {
    s.karts[i].isBot = i >= 4
    s.karts[i].connected = true
  }
  return s
}

describe('statesEqual is Object.is-strict', () => {
  it('rejects a one-ULP difference', () => {
    const ctx = makeContext(makeOvalTrack())
    const start = humanStart(ctx)
    start.phase = 'racing'
    const rec = recordRun(ctx, start, 60, scriptedSrc)

    const probe = allocStateLike(ctx, rec.end)
    expect(statesEqual(probe, rec.end)).toBe(true)

    probe.karts[5].velocity.x = ulpUp(probe.karts[5].velocity.x)
    expect(probe.karts[5].velocity.x).not.toBe(rec.end.karts[5].velocity.x)
    expect(statesEqual(probe, rec.end)).toBe(false)
  })

  it('distinguishes 0 from -0, per the contract', () => {
    const ctx = makeContext(makeOvalTrack())
    const start = humanStart(ctx)
    const a = allocStateLike(ctx, start)
    const b = allocStateLike(ctx, start)
    a.karts[2].angularVelocity = 0
    b.karts[2].angularVelocity = -0

    expect(a.karts[2].angularVelocity === b.karts[2].angularVelocity).toBe(true) // === says equal
    expect(Object.is(a.karts[2].angularVelocity, b.karts[2].angularVelocity)).toBe(false)
    expect(statesEqual(a, b)).toBe(false)   // statesEqual must agree with Object.is
  })
})

describe('the equivalence test can actually fail', () => {
  it('diverges when the checkpoint is perturbed by one millimetre', () => {
    const ctx = makeContext(makeOvalTrack())
    const start = humanStart(ctx)
    const straight = recordRun(ctx, start, 600, scriptedSrc)
    const seg1 = recordRun(ctx, start, 361, scriptedSrc)
    const seg2 = recordRun(ctx, seg1.end, 239, scriptedSrc)

    // Kart slot matters here: recovery.ts's respawn interpolation ends with
    // snapToCheckpoint, which sets position purely from track geometry
    // (checkpointIdx -> sampleAt(s)), not from the kart's incoming trajectory.
    // Slot 3 runs off-track and completes a full spin-out+respawn cycle before
    // tick 600 under this seed/script, and that snap silently erases a
    // millimetre-scale perturbation -- verified by tracing per-tick divergence,
    // which decays linearly to exactly 0 over the 72-tick respawn. Slots 0-2
    // never leave the track in this window, so the perturbation survives
    // untouched to tick 600, which is what this control test needs to prove
    // anything.
    const perturbed = allocStateLike(ctx, seg1.end)
    perturbed.karts[0].position.x = perturbed.karts[0].position.x + 1e-3

    const diverged = replayRun(ctx, perturbed, seg2.intents, 361, 600)

    expect(diverged.tick).toBe(600)
    expect(statesEqual(diverged, straight.end)).toBe(false)
    expect(statesEqual(seg2.end, straight.end)).toBe(true)  // the control still holds
  })
})

describe('replayRun range guards', () => {
  it('rejects a checkpoint whose tick does not match fromTick', () => {
    const ctx = makeContext(makeOvalTrack())
    const start = humanStart(ctx)
    const seg1 = recordRun(ctx, start, 361, scriptedSrc)
    const seg2 = recordRun(ctx, seg1.end, 239, scriptedSrc)
    const cp = allocStateLike(ctx, seg1.end)   // cp.tick === 361

    expect(() => replayRun(ctx, cp, seg2.intents, 360, 600)).toThrow(RangeError)
    expect(() => replayRun(ctx, cp, seg2.intents, 362, 600)).toThrow(RangeError)
  })

  it('rejects a tick range outside the recording', () => {
    const ctx = makeContext(makeOvalTrack())
    const start = humanStart(ctx)
    const seg1 = recordRun(ctx, start, 361, scriptedSrc)
    const seg2 = recordRun(ctx, seg1.end, 239, scriptedSrc)
    const cp = allocStateLike(ctx, seg1.end)

    // recorded rows cover 361..599, so toTick may be at most 361 + 239 = 600
    expect(() => replayRun(ctx, cp, seg2.intents, 361, 601)).toThrow(RangeError)
    // toTick before fromTick
    expect(() => replayRun(ctx, cp, seg2.intents, 361, 360)).toThrow(RangeError)
    // a checkpoint that predates the recording's baseTick of 361
    const early = allocStateLike(ctx, start)   // tick 0
    expect(() => replayRun(ctx, early, seg2.intents, 0, 4)).toThrow(RangeError)
    // the exact boundary is legal and is a no-op replay
    const edge = replayRun(ctx, cp, seg2.intents, 361, 361)
    expect(edge.tick).toBe(361)
    expect(statesEqual(edge, seg1.end)).toBe(true)
  })
})

describe('checkpoint-replay equivalence with bot-driven karts', () => {
  it('is bit-identical from an odd checkpoint tick', () => {
    const ctx = makeContext(makeOvalTrack())
    const start = botStart(ctx)

    const straight = recordRun(ctx, start, 600, scriptedSrc)
    const seg1 = recordRun(ctx, start, 361, scriptedSrc)   // 361 is odd
    const seg2 = recordRun(ctx, seg1.end, 239, scriptedSrc)
    expect(statesEqual(seg2.end, straight.end)).toBe(true)

    // the bots really drove: slot 7 is bot-driven and moved
    expect(straight.end.karts[7].isBot).toBe(true)
    expect(straight.end.karts[7].position.x).not.toBe(start.karts[7].position.x)

    const checkpoint = allocStateLike(ctx, seg1.end)
    expect(checkpoint.tick % 2).toBe(1)   // the parity invariant this test rests on

    const replayed = replayRun(ctx, checkpoint, seg2.intents, 361, 600)

    expect(replayed.tick).toBe(600)
    expect(statesEqual(replayed, straight.end)).toBe(true)
    for (let i = 4; i < MAX_KARTS; i++) {
      expect(Object.is(replayed.karts[i].position.x, straight.end.karts[i].position.x)).toBe(true)
      expect(Object.is(replayed.karts[i].heading, straight.end.karts[i].heading)).toBe(true)
      expect(Object.is(replayed.karts[i].drift.charge, straight.end.karts[i].drift.charge)).toBe(true)
    }
  })

  it('is independent of a bot hold left dirty by an earlier run', () => {
    const ctx = makeContext(makeOvalTrack())
    resetBotHold()

    // kart.ts gates steering by `authority = sn * (1 - falloff * sn)`, sn = entry
    // speed / maxSpeed: a kart at rest has authority 0, so a poisoned steer intent
    // consumed on tick 1 of a cold start would move nothing and this test would
    // pass whether or not recordRun resets the hold. Two warm-up ticks give the
    // bots real, nonzero velocity so the poisoned steer is actually observable.
    const s0 = botStart(ctx)
    s0.phase = 'racing'
    const warm = recordRun(ctx, s0, 2, scriptedSrc).end
    expect(warm.tick % 2).toBe(0)   // even, so the next tick (odd) is a hold-reuse tick
    expect(warm.karts[4].velocity.x !== 0 || warm.karts[4].velocity.z !== 0).toBe(true)

    // Poison the module-level 30Hz hold: resolve the bot slots from a state offset
    // from `warm`, so holdTick becomes warm.tick and the real run's very next step
    // (the odd tick warm.tick + 1) would otherwise reuse this bogus intent instead
    // of recomputing.
    const bogus = allocStateLike(ctx, warm)
    for (let i = 4; i < MAX_KARTS; i++) bogus.karts[i].position.x += 25
    resetBotHold()
    resolveInputs(ctx, bogus, makeIntentBuffer(), makeIntentBuffer())

    const dirtyRun = recordRun(ctx, allocStateLike(ctx, warm), 40, scriptedSrc)

    resetBotHold()
    const cleanRun = recordRun(ctx, allocStateLike(ctx, warm), 40, scriptedSrc)

    expect(dirtyRun.end.tick).toBe(warm.tick + 40)
    expect(statesEqual(dirtyRun.end, cleanRun.end)).toBe(true)
  })
})

describe('replayRun checkpoint parity guard', () => {
  it('rejects an even checkpoint tick when a bot-driven kart is racing', () => {
    const ctx = makeContext(makeOvalTrack())
    const start = botStart(ctx)

    // 360 is even and well past COUNTDOWN_TICKS (180), so the checkpoint is
    // racing, not countdown, and slots 4-7 are bot-driven: exactly the
    // condition needsOddCheckpoint is meant to catch.
    const seg1 = recordRun(ctx, start, 360, scriptedSrc)
    const seg2 = recordRun(ctx, seg1.end, 40, scriptedSrc)
    const checkpoint = allocStateLike(ctx, seg1.end)
    expect(checkpoint.tick % 2).toBe(0)
    expect(checkpoint.phase).toBe('racing')
    expect(checkpoint.karts.some((k) => k.isBot)).toBe(true)

    expect(() => replayRun(ctx, checkpoint, seg2.intents, 360, 400)).toThrow(
      /bot-driven or disconnected/,
    )
  })

  it('accepts an even checkpoint tick when every kart is connected and human', () => {
    const ctx = makeContext(makeOvalTrack())
    const start = humanStart(ctx)

    const N = 600
    const T = 360   // even, and no kart is bot-driven or disconnected
    const straight = recordRun(ctx, start, N, scriptedSrc)
    const seg1 = recordRun(ctx, start, T, scriptedSrc)
    const seg2 = recordRun(ctx, seg1.end, N - T, scriptedSrc)
    const checkpoint = allocStateLike(ctx, seg1.end)
    expect(checkpoint.tick % 2).toBe(0)
    expect(checkpoint.karts.every((k) => !k.isBot && k.connected)).toBe(true)

    // Must not throw, and the guard being scoped to bot/disconnected karts must
    // not have quietly become a blanket even-tick rejection.
    const replayed = replayRun(ctx, checkpoint, seg2.intents, T, N)
    expect(replayed.tick).toBe(600)
    expect(statesEqual(replayed, straight.end)).toBe(true)
  })

  it('accepts an even checkpoint tick with bot-driven karts during countdown', () => {
    const ctx = makeContext(makeOvalTrack())
    const start = botStart(ctx)   // phase stays 'countdown': createState's default

    // resolveInputs freezes every kart to all-zero while phase === 'countdown',
    // before it ever looks at isBot/connected, so the bot hold is never touched
    // here regardless of tick parity. 40 is even and well inside the 180-tick
    // countdown, so this checkpoint is the case needsOddCheckpoint must NOT flag.
    const N = 100
    const T = 40
    expect(T).toBeLessThan(COUNTDOWN_TICKS)
    const straight = recordRun(ctx, start, N, scriptedSrc)
    const seg1 = recordRun(ctx, start, T, scriptedSrc)
    const seg2 = recordRun(ctx, seg1.end, N - T, scriptedSrc)
    const checkpoint = allocStateLike(ctx, seg1.end)
    expect(checkpoint.tick % 2).toBe(0)
    expect(checkpoint.phase).toBe('countdown')
    expect(checkpoint.karts.some((k) => k.isBot)).toBe(true)

    const replayed = replayRun(ctx, checkpoint, seg2.intents, T, N)
    expect(replayed.tick).toBe(N)
    expect(statesEqual(replayed, straight.end)).toBe(true)
  })
})
