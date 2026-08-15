import { describe, expect, it } from 'vitest'
import { MAX_CATCHUP_TICKS, TICK_MS, advanceAccumulator, makeTickAccumulator } from '../src/clock'

/** Float slop that is generous against a single subtraction and far tighter than
 * one tick (16.67ms), so it cannot hide a lost or duplicated tick's worth of time. */
const SLOP_MS = 1e-9

describe('advanceAccumulator (Task 15c item F)', () => {
  it('yields 59 ticks - not 60 - over 100 frames of 10ms, because 60 * TICK_MS is 1000.0000000000001', () => {
    // The measured float reality, asserted rather than described. TICK_MS is
    // 1000/60, which is not representable, and 60 of them sum to just OVER
    // 1000ms - so a second of wall time delivered in 10ms frames buys 59 whole
    // ticks and change, never 60.
    expect(60 * TICK_MS).toBeGreaterThan(1000)
    const acc = makeTickAccumulator()
    let ticks = 0
    for (let i = 0; i < 100; i++) ticks += advanceAccumulator(acc, 10)
    expect(ticks).toBe(59)
  })

  it('conserves time: ticks * TICK_MS + residual === elapsed, over 100 consecutive calls', () => {
    // THE test for this function, and the reason the tick count above is not.
    // The defect worth catching is "reset the residual" - an implementation that
    // zeroes the leftover after emitting ticks. Under 10ms frames that
    // implementation emits ZERO ticks forever (10 < 16.67, reset, repeat), and
    // under 20ms frames it emits one tick per frame and silently discards 3.3ms
    // every time - a sim that runs 12% slow with a tick count that looks fine.
    // Only the identity sees it.
    const acc = makeTickAccumulator()
    let ticks = 0
    let elapsed = 0
    for (let i = 0; i < 100; i++) {
      ticks += advanceAccumulator(acc, 10)
      elapsed += 10
      // Checked EVERY call, not once at the end: a function that breaks from its
      // second consecutive call fails on iteration 2 here rather than passing an
      // end-state check that happens to land right.
      expect(Math.abs(ticks * TICK_MS + acc.residualMs - elapsed), `broke at call ${i + 1}`).toBeLessThan(SLOP_MS)
    }
    expect(ticks).toBe(59)
    // The residual is real, unspent time - not zero, not a whole tick.
    expect(acc.residualMs).toBeGreaterThan(0)
    expect(acc.residualMs).toBeLessThan(TICK_MS)
  })

  it('conserves time under uneven frame times too, including frames shorter than a tick', () => {
    // A real frame budget is not 10ms forever. Mixed short/long frames are where
    // an implementation that recomputes from a start time instead of carrying a
    // residual drifts.
    const frames = [4, 33.3, 0.5, 17, 1, 8.25, 50, 2, 16.6, 0, 12.75]
    const acc = makeTickAccumulator()
    let ticks = 0
    let elapsed = 0
    for (let r = 0; r < 20; r++) {
      for (const f of frames) {
        ticks += advanceAccumulator(acc, f)
        elapsed += f
        expect(Math.abs(ticks * TICK_MS + acc.residualMs - elapsed)).toBeLessThan(SLOP_MS)
      }
    }
    // Control: this drove real work, so the identity above is not holding
    // vacuously over an accumulator that never emitted anything. The frame list
    // sums to 145.4ms, so 20 rounds is 2908ms of wall time and, with no frame
    // long enough to clamp (the longest is 50ms = 3 ticks, under
    // MAX_CATCHUP_TICKS), every one of those milliseconds is either simulated or
    // still in the residual: floor(2908 / TICK_MS) = 174 ticks exactly.
    expect(elapsed).toBeCloseTo(2908, 6)
    expect(ticks).toBe(174)
  })

  it('clamps a long stall at MAX_CATCHUP_TICKS and DISCARDS the backlog rather than banking it', () => {
    const acc = makeTickAccumulator()
    // 1000ms in one frame is 60 ticks of work. Running them all is the spiral of
    // death: each catch-up burst takes longer than the frame it is catching up
    // to. The clamp is the whole point of the constant.
    expect(advanceAccumulator(acc, 1000)).toBe(MAX_CATCHUP_TICKS)
    // Backlog discarded, not banked. Banking it (residual 1000 - 5*TICK_MS)
    // would make the NEXT call emit another full burst, and the one after that,
    // for eleven more frames - the stall would echo instead of ending.
    expect(acc.residualMs).toBe(0)
    // Proven by behaviour, not just by the field: the next ordinary 10ms frame
    // is an ordinary frame again.
    expect(advanceAccumulator(acc, 10)).toBe(0)
    expect(advanceAccumulator(acc, 10)).toBe(1)
    // Time conservation is deliberately BROKEN across a clamp, and that is
    // stated here rather than left for someone to discover: the discarded
    // milliseconds are wall time this sim will never simulate. It is exactly why
    // ShadowLoop's host-loss detector counts wall milliseconds and not ticks
    // (item C) - the tick source under-counts precisely when the room is in
    // trouble.
    const wallMs = 1000 + 10 + 10
    const simMs = (MAX_CATCHUP_TICKS + 1) * TICK_MS + acc.residualMs
    expect(simMs).toBeLessThan(wallMs)
  })

  it('emits at most MAX_CATCHUP_TICKS from any single call, no matter how large', () => {
    for (const stallMs of [100, 1_000, 60_000, 3_600_000]) {
      const acc = makeTickAccumulator()
      expect(advanceAccumulator(acc, stallMs)).toBeLessThanOrEqual(MAX_CATCHUP_TICKS)
    }
  })

  it('treats a zero or backwards clock as zero elapsed and never rewinds the residual', () => {
    const acc = makeTickAccumulator()
    advanceAccumulator(acc, 10)
    const banked = acc.residualMs
    expect(advanceAccumulator(acc, 0)).toBe(0)
    expect(acc.residualMs).toBe(banked)
    // A backwards clock is a real event (NTP step, a scheduler handing back a
    // stale timestamp). Subtracting it would un-bank time the sim already
    // owns and stall the loop for as long as the jump.
    expect(advanceAccumulator(acc, -500)).toBe(0)
    expect(acc.residualMs).toBe(banked)
  })

  it('runs exactly one tick per frame at the 60Hz frame time it is built for', () => {
    const acc = makeTickAccumulator()
    for (let i = 0; i < 600; i++) {
      expect(advanceAccumulator(acc, TICK_MS), `frame ${i}`).toBe(1)
    }
    expect(acc.residualMs).toBeLessThan(SLOP_MS)
  })

  it('fixes MAX_CATCHUP_TICKS in ONE place, reachable through the barrel', async () => {
    // The reason this function is in @tapkart/net at all: Plan 3's game clock
    // and Plan 4's server ticker are the same function with the same constant,
    // duplicated only because `server` may not import `game`. Both import
    // `net`. Two homes for a catch-up constant drift, and catch-up is a named
    // risk.
    const pkg = await import('@tapkart/net')
    expect(pkg.MAX_CATCHUP_TICKS).toBe(MAX_CATCHUP_TICKS)
    expect(pkg.TICK_MS).toBe(TICK_MS)
    expect(typeof pkg.advanceAccumulator).toBe('function')
    expect(typeof pkg.makeTickAccumulator).toBe('function')
    expect(MAX_CATCHUP_TICKS).toBeGreaterThan(1)
  })
})
