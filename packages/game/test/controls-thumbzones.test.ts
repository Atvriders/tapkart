import { describe, it, expect } from 'vitest'
import type { Intent } from '@tapkart/sim'
import { DRIFT_STEER_MIN } from '@tapkart/sim'
import type { ControlInputs, PointerPhase } from '../src/controls/types'
import { BRAKE_HOLD_TICKS, DEFAULT_CONTROL_CONFIG } from '../src/controls/config'
import { makeThumbZonesAdapter } from '../src/controls/thumbzones'
import { makeControlInputsFixture } from './fixtures/game-fixtures'

// 800x400. Half-width 400, so full lock is 400 * 0.28 = 112 px from the origin.
// The buttons are drift [696,784)x[296,384) and item [696,784)x[192,280), with a
// dead band at y in [280,296).
const LOCK_PX = 112

function poisonedIntent(): Intent {
  // Every field set to a value the adapter must overwrite. A `sample` that writes
  // only the fields it "changed" leaves useItem true here, and a latched useItem
  // fires every item the instant it is granted, forever.
  return { tick: -999, steer: 999, accel: -999, brake: true, drift: true, useItem: true }
}

function point(raw: ControlInputs, id: number, x: number, y: number, phase: PointerPhase): void {
  const p = raw.pointers[raw.pointerCount]
  p.id = id
  p.x = x
  p.y = y
  p.phase = phase
  raw.pointerCount++
}

/** One frame: hand the adapter the pending pointer events, then clear them. */
function step(adapter: ReturnType<typeof makeThumbZonesAdapter>, raw: ControlInputs,
              tick: number, out: Intent): void {
  adapter.sample(raw, tick, out)
  raw.pointerCount = 0
}

describe('thumbZones steering (Q24)', () => {
  it('is relative to the touch-down origin: a thumb landing off-centre does not steer', () => {
    // THE Q24 TEST. Under absolute steering, a touch at x=60 is (60-400)/112 =
    // -3.04 -> clamped -1 -> steer -0.35 on the first tick and a hard-left jerk.
    // Under relative steering it is exactly 0 and stays 0 while the thumb is still.
    const a = makeThumbZonesAdapter(DEFAULT_CONTROL_CONFIG)
    const raw = makeControlInputsFixture()
    const out = poisonedIntent()
    point(raw, 1, 60, 200, 'down')
    step(a, raw, 0, out)
    expect(out.steer).toBe(0)
    for (let t = 1; t <= 5; t++) {
      step(a, raw, t, out)
      expect(out.steer).toBe(0)
    }
  })

  it('overwrites every field of `out`, including the ones it did not change', () => {
    // CATCHES: a partial writer. `out` is the Intent the session submits; a stale
    // useItem or brake from a previous frame is indistinguishable from a press.
    const a = makeThumbZonesAdapter(DEFAULT_CONTROL_CONFIG)
    const raw = makeControlInputsFixture()
    const out = poisonedIntent()
    step(a, raw, 42, out)
    expect(out).toEqual({ tick: 42, steer: 0, accel: 1, brake: false, drift: false, useItem: false })
  })

  it('reaches full lock at 28 % of the HALF-width and smooths at 0.35 per tick', () => {
    // CATCHES: normalising against the full width (which would halve the response),
    // and a missing or wrong smoothing factor. The first three values are exact
    // arithmetic on lerp(prev, 1, 0.35): 0.35, 0.5775, 0.725375.
    const a = makeThumbZonesAdapter(DEFAULT_CONTROL_CONFIG)
    const raw = makeControlInputsFixture()
    const out = poisonedIntent()
    point(raw, 1, 200, 200, 'down')
    step(a, raw, 0, out)
    point(raw, 1, 200 + LOCK_PX, 200, 'move')
    step(a, raw, 1, out)
    expect(out.steer).toBeCloseTo(0.35, 9)
    step(a, raw, 2, out)
    expect(out.steer).toBeCloseTo(0.5775, 9)
    step(a, raw, 3, out)
    expect(out.steer).toBeCloseTo(0.725375, 9)
    for (let t = 4; t <= 24; t++) step(a, raw, t, out)
    expect(out.steer).toBeGreaterThan(0.999)
    expect(out.steer).toBeLessThanOrEqual(1)
  })

  it('half the full-lock distance converges to half lock', () => {
    // CATCHES: a normalisation that is right at the extremes and wrong in between
    // (e.g. squared or stepped response). Under the full-width bug this converges
    // to 0.25 and fails.
    const a = makeThumbZonesAdapter(DEFAULT_CONTROL_CONFIG)
    const raw = makeControlInputsFixture()
    const out = poisonedIntent()
    point(raw, 1, 200, 200, 'down')
    step(a, raw, 0, out)
    point(raw, 1, 200 - LOCK_PX / 2, 200, 'move')
    for (let t = 1; t <= 24; t++) step(a, raw, t, out)
    expect(out.steer).toBeCloseTo(-0.5, 3)
  })

  it('clamps past full lock and never leaves [-1, 1]', () => {
    const a = makeThumbZonesAdapter(DEFAULT_CONTROL_CONFIG)
    const raw = makeControlInputsFixture()
    const out = poisonedIntent()
    point(raw, 1, 350, 200, 'down')
    step(a, raw, 0, out)
    point(raw, 1, -5000, 200, 'move')
    for (let t = 1; t <= 40; t++) {
      step(a, raw, t, out)
      expect(out.steer).toBeGreaterThanOrEqual(-1)
      expect(out.steer).toBeLessThanOrEqual(1)
    }
    expect(out.steer).toBeLessThan(-0.999)
  })

  it('applies the dead zone to the raw axis, not the smoothed output', () => {
    // CATCHES: a dead zone tested against the smoothed value, which would swallow
    // the first two ticks of EVERY steer input. 6 px / 112 px = 0.0536 (dead);
    // 8 px / 112 px = 0.0714 (live, and 0.35 of it is 0.025).
    const dead = makeThumbZonesAdapter(DEFAULT_CONTROL_CONFIG)
    const rawDead = makeControlInputsFixture()
    const outDead = poisonedIntent()
    point(rawDead, 1, 200, 200, 'down')
    step(dead, rawDead, 0, outDead)
    point(rawDead, 1, 206, 200, 'move')
    for (let t = 1; t <= 10; t++) step(dead, rawDead, t, outDead)
    expect(outDead.steer).toBe(0)

    const live = makeThumbZonesAdapter(DEFAULT_CONTROL_CONFIG)
    const rawLive = makeControlInputsFixture()
    const outLive = poisonedIntent()
    point(rawLive, 1, 200, 200, 'down')
    step(live, rawLive, 0, outLive)
    point(rawLive, 1, 208, 200, 'move')
    step(live, rawLive, 1, outLive)
    expect(outLive.steer).toBeCloseTo(0.025, 9)
  })

  it('returns to centre when the steering thumb lifts', () => {
    const a = makeThumbZonesAdapter(DEFAULT_CONTROL_CONFIG)
    const raw = makeControlInputsFixture()
    const out = poisonedIntent()
    point(raw, 1, 200, 200, 'down')
    step(a, raw, 0, out)
    point(raw, 1, 200 + LOCK_PX, 200, 'move')
    for (let t = 1; t <= 20; t++) step(a, raw, t, out)
    expect(out.steer).toBeGreaterThan(0.99)
    point(raw, 1, 200 + LOCK_PX, 200, 'up')
    for (let t = 21; t <= 60; t++) step(a, raw, t, out)
    expect(out.steer).toBeCloseTo(0, 6)
  })

  it('never produces NaN on a zero-sized viewport', () => {
    // CATCHES: division by a zero half-width on the first frame, before the shell
    // has measured the canvas. NaN in the smoother is permanent: it survives every
    // subsequent lerp and the kart never steers again for the whole session.
    const a = makeThumbZonesAdapter(DEFAULT_CONTROL_CONFIG)
    const raw = makeControlInputsFixture({ viewport: { width: 0, height: 0 } })
    const out = poisonedIntent()
    point(raw, 1, 0, 0, 'down')
    step(a, raw, 0, out)
    point(raw, 1, 50, 0, 'move')
    step(a, raw, 1, out)
    expect(Number.isNaN(out.steer)).toBe(false)
    expect(out.steer).toBe(0)
  })
})

describe('thumbZones buttons (Q24, Q25)', () => {
  it('holds drift while the drift button is down and auto-accelerates throughout', () => {
    const a = makeThumbZonesAdapter(DEFAULT_CONTROL_CONFIG)
    const raw = makeControlInputsFixture()
    const out = poisonedIntent()
    point(raw, 2, 740, 340, 'down')
    step(a, raw, 0, out)
    expect(out.drift).toBe(true)
    expect(out.accel).toBe(1)
    step(a, raw, 1, out)
    expect(out.drift).toBe(true)
    point(raw, 2, 740, 340, 'up')
    step(a, raw, 2, out)
    expect(out.drift).toBe(false)
  })

  it('fires useItem on exactly one tick per press (Q25)', () => {
    // CATCHES a LEVEL instead of an EDGE. A single-tick test cannot tell the two
    // apart, so this one holds the button for five ticks, then releases and
    // re-presses. A level implementation reports true on all six.
    const a = makeThumbZonesAdapter(DEFAULT_CONTROL_CONFIG)
    const raw = makeControlInputsFixture()
    const out = poisonedIntent()
    const fired: number[] = []
    point(raw, 3, 740, 240, 'down')
    for (let t = 0; t <= 5; t++) {
      step(a, raw, t, out)
      if (out.useItem) fired.push(t)
    }
    point(raw, 3, 740, 240, 'up')
    step(a, raw, 6, out)
    if (out.useItem) fired.push(6)
    point(raw, 3, 740, 240, 'down')
    step(a, raw, 7, out)
    if (out.useItem) fired.push(7)
    expect(fired).toEqual([0, 7])
  })

  it('presses NEITHER button for a touch in the gap between them (Q24)', () => {
    // CATCHES nearest-button snapping. y in [280,296) is dead space; a snapping
    // implementation fires drift or item here and the player cannot tell why.
    const a = makeThumbZonesAdapter(DEFAULT_CONTROL_CONFIG)
    const raw = makeControlInputsFixture()
    const out = poisonedIntent()
    point(raw, 4, 740, 288, 'down')
    for (let t = 0; t <= 30; t++) {
      step(a, raw, t, out)
      expect(out.drift).toBe(false)
      expect(out.useItem).toBe(false)
      expect(out.brake).toBe(false)
      expect(out.steer).toBe(0)
    }
  })

  it('ignores a right-half touch that is not inside a button', () => {
    const a = makeThumbZonesAdapter(DEFAULT_CONTROL_CONFIG)
    const raw = makeControlInputsFixture()
    const out = poisonedIntent()
    point(raw, 5, 500, 100, 'down')
    point(raw, 5, 520, 100, 'move')
    step(a, raw, 0, out)
    expect(out).toEqual({ tick: 0, steer: 0, accel: 1, brake: false, drift: false, useItem: false })
  })

  it('keeps a touch with the control it started on, even when it slides away', () => {
    // CATCHES per-move re-routing. A thumb that starts on drift and drifts 400 px
    // left must keep drifting and must NOT hijack steering; re-routing drops the
    // drift mid-corner, which reads as the game ignoring the player.
    const a = makeThumbZonesAdapter(DEFAULT_CONTROL_CONFIG)
    const raw = makeControlInputsFixture()
    const out = poisonedIntent()
    point(raw, 6, 740, 340, 'down')
    step(a, raw, 0, out)
    point(raw, 6, 100, 100, 'move')
    for (let t = 1; t <= 10; t++) step(a, raw, t, out)
    expect(out.drift).toBe(true)
    expect(out.steer).toBe(0)
  })

  it('tracks two simultaneous touches: steering thumb plus drift button', () => {
    const a = makeThumbZonesAdapter(DEFAULT_CONTROL_CONFIG)
    const raw = makeControlInputsFixture()
    const out = poisonedIntent()
    point(raw, 7, 200, 200, 'down')
    point(raw, 8, 740, 340, 'down')
    step(a, raw, 0, out)
    point(raw, 7, 200 + LOCK_PX, 200, 'move')
    for (let t = 1; t <= 20; t++) step(a, raw, t, out)
    expect(out.drift).toBe(true)
    expect(out.steer).toBeGreaterThan(0.99)
  })
})

describe('thumbZones brake on a drift long-press (Q21)', () => {
  it('brakes on the 18th consecutive tick of a straight-line hold, not before', () => {
    // CATCHES an off-by-one on BRAKE_HOLD_TICKS and a brake wired to the press
    // edge. `drift` must stay true the whole time: a brake that replaces the drift
    // would pass a brake-only assertion and break drifting.
    const a = makeThumbZonesAdapter(DEFAULT_CONTROL_CONFIG)
    const raw = makeControlInputsFixture()
    const out = poisonedIntent()
    point(raw, 9, 740, 340, 'down')
    for (let t = 0; t < BRAKE_HOLD_TICKS - 1; t++) {
      step(a, raw, t, out)
      expect(out.brake).toBe(false)
      expect(out.drift).toBe(true)
    }
    step(a, raw, BRAKE_HOLD_TICKS - 1, out)
    expect(out.brake).toBe(true)
    expect(out.drift).toBe(true)
  })

  it('does not brake while the thumb is turning, and starts once it straightens', () => {
    // THE Q21 QUALIFIER TEST. |steer| >= DRIFT_STEER_MIN means the hold is a drift,
    // not a brake. A test that only held the button straight would pass with the
    // qualifier missing entirely; this one holds it at full lock for well past the
    // threshold, then releases the steering thumb and watches the brake appear as
    // the smoothed steer decays below 0.35.
    const a = makeThumbZonesAdapter(DEFAULT_CONTROL_CONFIG)
    const raw = makeControlInputsFixture()
    const out = poisonedIntent()
    point(raw, 10, 200, 200, 'down')
    point(raw, 11, 740, 340, 'down')
    step(a, raw, 0, out)
    point(raw, 10, 200 + LOCK_PX, 200, 'move')
    for (let t = 1; t <= 40; t++) {
      step(a, raw, t, out)
      expect(out.brake).toBe(false)
    }
    expect(out.steer).toBeGreaterThan(DRIFT_STEER_MIN)
    expect(out.drift).toBe(true)

    point(raw, 10, 200 + LOCK_PX, 200, 'up')
    let brakingAt = -1
    for (let t = 41; t <= 60; t++) {
      step(a, raw, t, out)
      if (out.brake && brakingAt === -1) brakingAt = t
    }
    expect(brakingAt).toBeGreaterThan(-1)
    expect(Math.abs(out.steer)).toBeLessThan(DRIFT_STEER_MIN)
  })

  it('restarts the hold counter when the button is released', () => {
    const a = makeThumbZonesAdapter(DEFAULT_CONTROL_CONFIG)
    const raw = makeControlInputsFixture()
    const out = poisonedIntent()
    point(raw, 12, 740, 340, 'down')
    for (let t = 0; t < 17; t++) step(a, raw, t, out)
    point(raw, 12, 740, 340, 'up')
    step(a, raw, 17, out)
    expect(out.brake).toBe(false)
    point(raw, 12, 740, 340, 'down')
    for (let t = 18; t < 18 + BRAKE_HOLD_TICKS - 1; t++) {
      step(a, raw, t, out)
      expect(out.brake).toBe(false)
    }
    step(a, raw, 100, out)
    expect(out.brake).toBe(true)
  })
})

describe('thumbZones reset', () => {
  it('drops the steer smoothing, the pointer claims, the hold counter and the item latch', () => {
    // CATCHES a partial reset. The item latch is the subtle one: if reset() leaves
    // it set, the first press after a race never fires.
    const a = makeThumbZonesAdapter(DEFAULT_CONTROL_CONFIG)
    const raw = makeControlInputsFixture()
    const out = poisonedIntent()
    point(raw, 13, 200, 200, 'down')
    point(raw, 14, 740, 340, 'down')
    point(raw, 15, 740, 240, 'down')
    step(a, raw, 0, out)
    point(raw, 13, 200 + LOCK_PX, 200, 'move')
    for (let t = 1; t <= 20; t++) step(a, raw, t, out)
    expect(out.steer).toBeGreaterThan(0.99)
    expect(out.drift).toBe(true)
    expect(out.brake).toBe(false)

    a.reset()
    step(a, raw, 21, out)
    expect(out).toEqual({ tick: 21, steer: 0, accel: 1, brake: false, drift: false, useItem: false })

    point(raw, 16, 740, 240, 'down')
    step(a, raw, 22, out)
    expect(out.useItem).toBe(true)
  })
})

describe('thumbZones scheme identity', () => {
  it('reports its scheme', () => {
    expect(makeThumbZonesAdapter(DEFAULT_CONTROL_CONFIG).scheme).toBe('thumbZones')
  })
})
