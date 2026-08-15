import { describe, it, expect } from 'vitest'
import { MAX_POINTERS, createControlInputs } from '../src/controls/types'
import {
  DEFAULT_CONTROL_CONFIG,
  TOUCH_BUTTON_SIZE_PX,
  TOUCH_BUTTON_MARGIN_PX,
  TOUCH_BUTTON_GAP_PX,
  THUMBZONE_FULL_LOCK_FRACTION,
  BRAKE_HOLD_TICKS,
  driftButtonRect,
  itemButtonRect,
  rectContains,
} from '../src/controls/config'
import type { Rect } from '../src/controls/config'
import { makeControlInputsFixture } from './fixtures/game-fixtures'

// The viewport every touch test in this task uses. 800x400 makes every rect
// coordinate an exact integer, so the numbers below are written out rather than
// recomputed from the constants - a test that recomputes the layout from the
// same constants the implementation uses cannot detect a wrong layout.
const W = 800
const H = 400
const VIEWPORT = { width: W, height: H }

function newRect(): Rect {
  return { x: 0, y: 0, w: 0, h: 0 }
}

describe('controls/types', () => {
  it('createControlInputs allocates MAX_POINTERS pointer slots and nothing live', () => {
    // CATCHES: a lazily-grown `pointers` array. The source (Task 19) writes into
    // `out.pointers[i]` without allocating; a short array silently drops touches.
    const raw = createControlInputs()
    expect(MAX_POINTERS).toBe(8)
    expect(raw.pointers).toHaveLength(MAX_POINTERS)
    expect(raw.pointerCount).toBe(0)
    expect(raw.tilt).toBeNull()
    expect(Object.keys(raw.keys)).toHaveLength(0)
  })

  it('gives every pointer slot its own object', () => {
    // CATCHES: `new Array(MAX_POINTERS).fill(sample)`, which aliases all eight
    // slots to one object, so two simultaneous touches read as one.
    const raw = createControlInputs()
    raw.pointers[0].x = 111
    expect(raw.pointers[1].x).toBe(0)
    expect(raw.pointers[0]).not.toBe(raw.pointers[1])
  })
})

describe('controls/config DEFAULT_CONTROL_CONFIG', () => {
  it('is the contract §5.5 default table, value by value', () => {
    // CATCHES: a tuning value drifting from the contract. Every number below is
    // load-bearing: deadZone and smoothing are asserted by exact arithmetic in
    // the adapter tests, so a changed default breaks them loudly, not silently.
    expect(DEFAULT_CONTROL_CONFIG.deadZone).toBe(0.06)
    expect(DEFAULT_CONTROL_CONFIG.steerGain).toBe(1)
    expect(DEFAULT_CONTROL_CONFIG.steerSmoothingPerTick).toBe(0.35)
    expect(DEFAULT_CONTROL_CONFIG.tiltNeutralDegrees).toBe(0)
    expect(DEFAULT_CONTROL_CONFIG.tiltRangeDegrees).toBe(25)
    expect(DEFAULT_CONTROL_CONFIG.invertTilt).toBe(false)
    expect(DEFAULT_CONTROL_CONFIG.tiltCalibration).toEqual({ betaZero: 0, gammaZero: 0 })
  })

  it('binds exactly the twelve documented key codes to their actions', () => {
    // CATCHES: a missing alternate binding (WASD or Space), which is invisible
    // until someone plays on a keyboard without arrow keys, and a binding typo'd
    // as a KeyboardEvent.key ('a') instead of a .code ('KeyA') - the adapter reads
    // .code, so 'a' would never match anything.
    expect(DEFAULT_CONTROL_CONFIG.keyBindings).toEqual({
      ArrowLeft: 'left',
      KeyA: 'left',
      ArrowRight: 'right',
      KeyD: 'right',
      ArrowUp: 'accel',
      KeyW: 'accel',
      ArrowDown: 'brake',
      KeyS: 'brake',
      ShiftLeft: 'drift',
      Space: 'drift',
      KeyE: 'item',
      ControlLeft: 'item',
    })
  })
})

describe('controls/config layout (Q24)', () => {
  it('exports the contract §5.5 layout constants', () => {
    expect(TOUCH_BUTTON_SIZE_PX).toBe(88)
    expect(TOUCH_BUTTON_MARGIN_PX).toBe(16)
    expect(TOUCH_BUTTON_GAP_PX).toBe(16)
    expect(THUMBZONE_FULL_LOCK_FRACTION).toBe(0.28)
    expect(BRAKE_HOLD_TICKS).toBe(18)
  })

  it('puts the drift button 16 px from the bottom and right edges', () => {
    // CATCHES: a rect measured from the top-left instead of the bottom-right, and
    // a margin applied to only one axis. Hard-coded expectations, not recomputed.
    const r = newRect()
    driftButtonRect(VIEWPORT, r)
    expect(r).toEqual({ x: 696, y: 296, w: 88, h: 88 })
  })

  it('puts the item button directly above the drift button with a 16 px gap', () => {
    // CATCHES: the item button placed beside (not above) the drift button, or
    // stacked with no gap - which would delete the dead space Q24 requires.
    const r = newRect()
    itemButtonRect(VIEWPORT, r)
    expect(r).toEqual({ x: 696, y: 192, w: 88, h: 88 })

    const drift = newRect()
    driftButtonRect(VIEWPORT, drift)
    expect(drift.y - (r.y + r.h)).toBe(TOUCH_BUTTON_GAP_PX)
    expect(r.x).toBe(drift.x)
  })

  it('writes into the caller-owned Rect and allocates nothing', () => {
    // CATCHES: a rect helper that returns a fresh object and leaves `out`
    // untouched - the frame path would then read a stale zero rect forever.
    const r = newRect()
    const same = r
    driftButtonRect(VIEWPORT, r)
    expect(same.w).toBe(88)
  })

  it('rectContains is half-open on the far edges', () => {
    // CATCHES: `<=` on the far edge, which makes adjacent controls overlap by one
    // pixel row - the exact ambiguity Q24's dead gap exists to remove.
    const r: Rect = { x: 10, y: 20, w: 100, h: 50 }
    expect(rectContains(r, 10, 20)).toBe(true)
    expect(rectContains(r, 109.999, 69.999)).toBe(true)
    expect(rectContains(r, 110, 40)).toBe(false)
    expect(rectContains(r, 40, 70)).toBe(false)
    expect(rectContains(r, 9.999, 40)).toBe(false)
    expect(rectContains(r, 40, 19.999)).toBe(false)
  })

  it('leaves a dead band between the two buttons that belongs to neither', () => {
    // CATCHES: nearest-button snapping. Q24: a touch in the gap presses NOTHING.
    // The band is y in [280, 296) at the buttons' x range.
    const drift = newRect()
    const item = newRect()
    driftButtonRect(VIEWPORT, drift)
    itemButtonRect(VIEWPORT, item)
    for (const y of [280, 285, 295.999]) {
      expect(rectContains(drift, 740, y)).toBe(false)
      expect(rectContains(item, 740, y)).toBe(false)
    }
  })
})

describe('game-fixtures makeControlInputsFixture', () => {
  it('defaults to the 800x400 landscape viewport with nothing pressed', () => {
    const raw = makeControlInputsFixture()
    expect(raw.viewport).toEqual({ width: W, height: H })
    expect(raw.pointerCount).toBe(0)
    expect(raw.pointers).toHaveLength(MAX_POINTERS)
  })

  it('applies overrides', () => {
    const raw = makeControlInputsFixture({ keys: { KeyW: true }, tilt: { alpha: 0, beta: 0, gamma: 5 } })
    expect(raw.keys.KeyW).toBe(true)
    expect(raw.tilt?.gamma).toBe(5)
  })
})
