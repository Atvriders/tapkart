import { describe, it, expect } from 'vitest'
import type { Intent } from '@tapkart/sim'
import type { ControlInputs, PointerPhase } from '../src/controls/types'
import { DEFAULT_CONTROL_CONFIG } from '../src/controls/config'
import { makeVirtualStickAdapter } from '../src/controls/stick'
import { makeControlInputsFixture } from './fixtures/game-fixtures'

// 800x400, so the four buttons are a 2x2 cluster in the bottom-right corner:
//   gas   [592,680) x [296,384)      drift [696,784) x [296,384)
//   brake [592,680) x [192,280)      item  [696,784) x [192,280)
// with 16 px of dead space on both axes between them.
const GAS = { x: 636, y: 340 }
const BRAKE = { x: 636, y: 236 }
const DRIFT = { x: 740, y: 340 }
const ITEM = { x: 740, y: 236 }
const LOCK_PX = 112

function poisonedIntent(): Intent {
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

function step(a: ReturnType<typeof makeVirtualStickAdapter>, raw: ControlInputs,
              tick: number, out: Intent): void {
  a.sample(raw, tick, out)
  raw.pointerCount = 0
}

describe('virtualStick pedals', () => {
  it('does NOT auto-accelerate: no gas button, no throttle', () => {
    // CATCHES the copy-paste from thumbZones/tilt, where accel is hard-wired to 1.
    // Under that bug this scheme's gas pedal does nothing and the kart never stops.
    const a = makeVirtualStickAdapter(DEFAULT_CONTROL_CONFIG)
    const raw = makeControlInputsFixture()
    const out = poisonedIntent()
    step(a, raw, 3, out)
    expect(out).toEqual({ tick: 3, steer: 0, accel: 0, brake: false, drift: false, useItem: false })
  })

  it('accelerates while the gas button is held and stops when it lifts', () => {
    const a = makeVirtualStickAdapter(DEFAULT_CONTROL_CONFIG)
    const raw = makeControlInputsFixture()
    const out = poisonedIntent()
    point(raw, 1, GAS.x, GAS.y, 'down')
    step(a, raw, 0, out)
    expect(out.accel).toBe(1)
    step(a, raw, 1, out)
    expect(out.accel).toBe(1)
    point(raw, 1, GAS.x, GAS.y, 'up')
    step(a, raw, 2, out)
    expect(out.accel).toBe(0)
  })

  it('brakes on the press, with no hold threshold', () => {
    // CATCHES the long-press brake leaking into this scheme. virtualStick has an
    // explicit brake pedal (contract §5.5 table), so a threshold here would make
    // the pedal feel broken for its first 0.3 s.
    const a = makeVirtualStickAdapter(DEFAULT_CONTROL_CONFIG)
    const raw = makeControlInputsFixture()
    const out = poisonedIntent()
    point(raw, 2, BRAKE.x, BRAKE.y, 'down')
    step(a, raw, 0, out)
    expect(out.brake).toBe(true)
    expect(out.drift).toBe(false)
    point(raw, 2, BRAKE.x, BRAKE.y, 'up')
    step(a, raw, 1, out)
    expect(out.brake).toBe(false)
  })

  it('never turns a long drift hold into a brake', () => {
    // CATCHES the Q21 rule being applied to the wrong scheme. 40 straight-line
    // ticks is well past BRAKE_HOLD_TICKS; brake must stay false throughout.
    const a = makeVirtualStickAdapter(DEFAULT_CONTROL_CONFIG)
    const raw = makeControlInputsFixture()
    const out = poisonedIntent()
    point(raw, 3, DRIFT.x, DRIFT.y, 'down')
    for (let t = 0; t < 40; t++) {
      step(a, raw, t, out)
      expect(out.drift).toBe(true)
      expect(out.brake).toBe(false)
    }
  })

  it('fires useItem on exactly one tick per press', () => {
    const a = makeVirtualStickAdapter(DEFAULT_CONTROL_CONFIG)
    const raw = makeControlInputsFixture()
    const out = poisonedIntent()
    const fired: number[] = []
    point(raw, 4, ITEM.x, ITEM.y, 'down')
    for (let t = 0; t <= 4; t++) {
      step(a, raw, t, out)
      if (out.useItem) fired.push(t)
    }
    point(raw, 4, ITEM.x, ITEM.y, 'up')
    step(a, raw, 5, out)
    point(raw, 4, ITEM.x, ITEM.y, 'down')
    step(a, raw, 6, out)
    if (out.useItem) fired.push(6)
    expect(fired).toEqual([0, 6])
  })

  it('holds all four controls at once', () => {
    // CATCHES a router that claims one pointer per frame, or that lets a later
    // button overwrite an earlier one - a stick player holds gas and drift together
    // for the whole race.
    const a = makeVirtualStickAdapter(DEFAULT_CONTROL_CONFIG)
    const raw = makeControlInputsFixture()
    const out = poisonedIntent()
    point(raw, 5, GAS.x, GAS.y, 'down')
    point(raw, 6, DRIFT.x, DRIFT.y, 'down')
    point(raw, 7, ITEM.x, ITEM.y, 'down')
    point(raw, 8, BRAKE.x, BRAKE.y, 'down')
    step(a, raw, 0, out)
    expect(out.accel).toBe(1)
    expect(out.drift).toBe(true)
    expect(out.brake).toBe(true)
    expect(out.useItem).toBe(true)
  })

  it('leaves dead space between the buttons on both axes', () => {
    // CATCHES a cluster laid out with no gaps, where a thumb between gas and drift
    // fires one of them at random. x in [680,696) and y in [280,296) are dead.
    const a = makeVirtualStickAdapter(DEFAULT_CONTROL_CONFIG)
    const raw = makeControlInputsFixture()
    const out = poisonedIntent()
    for (const p of [{ x: 688, y: 340 }, { x: 740, y: 288 }, { x: 688, y: 288 }]) {
      a.reset()
      point(raw, 9, p.x, p.y, 'down')
      step(a, raw, 0, out)
      expect(out.accel).toBe(0)
      expect(out.brake).toBe(false)
      expect(out.drift).toBe(false)
      expect(out.useItem).toBe(false)
    }
  })
})

describe('virtualStick steering', () => {
  it('takes its origin from the touch-down point, like thumbZones', () => {
    // CATCHES an absolute stick, where planting a thumb at the left edge is
    // instant full lock.
    const a = makeVirtualStickAdapter(DEFAULT_CONTROL_CONFIG)
    const raw = makeControlInputsFixture()
    const out = poisonedIntent()
    point(raw, 10, 40, 300, 'down')
    step(a, raw, 0, out)
    expect(out.steer).toBe(0)
    for (let t = 1; t <= 5; t++) {
      step(a, raw, t, out)
      expect(out.steer).toBe(0)
    }
  })

  it('reaches full lock 28 % of a half-width from the origin', () => {
    const a = makeVirtualStickAdapter(DEFAULT_CONTROL_CONFIG)
    const raw = makeControlInputsFixture()
    const out = poisonedIntent()
    point(raw, 11, 200, 300, 'down')
    step(a, raw, 0, out)
    point(raw, 11, 200 - LOCK_PX, 300, 'move')
    step(a, raw, 1, out)
    expect(out.steer).toBeCloseTo(-0.35, 9)
    for (let t = 2; t <= 24; t++) step(a, raw, t, out)
    expect(out.steer).toBeLessThan(-0.999)
    expect(out.steer).toBeGreaterThanOrEqual(-1)
  })

  it('does not let a pedal touch steer', () => {
    const a = makeVirtualStickAdapter(DEFAULT_CONTROL_CONFIG)
    const raw = makeControlInputsFixture()
    const out = poisonedIntent()
    point(raw, 12, GAS.x, GAS.y, 'down')
    step(a, raw, 0, out)
    point(raw, 12, 100, 300, 'move')
    for (let t = 1; t <= 10; t++) step(a, raw, t, out)
    expect(out.steer).toBe(0)
    expect(out.accel).toBe(1)
  })
})

describe('virtualStick reset and identity', () => {
  it('reports its scheme and drops every latch', () => {
    const a = makeVirtualStickAdapter(DEFAULT_CONTROL_CONFIG)
    expect(a.scheme).toBe('virtualStick')
    const raw = makeControlInputsFixture()
    const out = poisonedIntent()
    point(raw, 13, 200, 300, 'down')
    point(raw, 14, GAS.x, GAS.y, 'down')
    point(raw, 15, ITEM.x, ITEM.y, 'down')
    step(a, raw, 0, out)
    point(raw, 13, 200 + LOCK_PX, 300, 'move')
    for (let t = 1; t <= 20; t++) step(a, raw, t, out)
    expect(out.steer).toBeGreaterThan(0.99)
    expect(out.accel).toBe(1)

    a.reset()
    step(a, raw, 21, out)
    expect(out).toEqual({ tick: 21, steer: 0, accel: 0, brake: false, drift: false, useItem: false })
    point(raw, 16, ITEM.x, ITEM.y, 'down')
    step(a, raw, 22, out)
    expect(out.useItem).toBe(true)
  })
})
