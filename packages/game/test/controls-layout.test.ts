import { describe, expect, it } from 'vitest'

import type { ControlMetrics, Rect } from '../src/controls/config'
import {
  brakeButtonRect,
  controlMetrics,
  createControlMetrics,
  driftButtonRect,
  gasButtonRect,
  itemButtonRect,
  steeringZoneRect,
} from '../src/controls/config'
import type { Insets, Viewport } from '../src/controls/types'

/**
 * The responsiveness proof.
 *
 * `controls-config.test.ts` still asserts the original Q24 numbers, and it still
 * passes — 800 x 400 is the calibration point where the derivation reproduces the
 * layout it replaced. That is deliberate churn control, and it means that file no
 * longer proves anything about responsiveness. This one does.
 *
 * Every expectation below is HAND-COMPUTED from the formulas, never recomputed
 * from the implementation's own constants. A test that recomputes is a test that
 * agrees with any bug.
 */
const NO_INSETS: Insets = { top: 0, right: 0, bottom: 0, left: 0 }

interface Row {
  name: string
  v: Viewport
  button: number
  gap: number
  inset: number
  drift: [number, number]
  itemY: number
  gasX: number
  steer: [number, number, number, number]
  lock: number
  orientation: 'landscape' | 'portrait'
}

const ROWS: Row[] = [
  { name: '800x400 (the fixture: must equal the original layout)', v: { width: 800, height: 400 },
    button: 88, gap: 16, inset: 16, drift: [696, 296], itemY: 192, gasX: 592,
    steer: [0, 0, 400, 400], lock: 112, orientation: 'landscape' },
  { name: '844x390 (phone, landscape)', v: { width: 844, height: 390 },
    button: 86, gap: 16, inset: 16, drift: [742, 288], itemY: 186, gasX: 640,
    steer: [0, 0, 422, 390], lock: 118, orientation: 'landscape' },
  { name: '390x844 (phone, portrait)', v: { width: 390, height: 844 },
    button: 86, gap: 16, inset: 16, drift: [288, 742], itemY: 640, gasX: 186,
    steer: [0, 591, 170, 253], lock: 88, orientation: 'portrait' },
  { name: '360x640 (small phone, portrait)', v: { width: 360, height: 640 },
    button: 79, gap: 14, inset: 14, drift: [267, 547], itemY: 454, gasX: 174,
    steer: [0, 440, 160, 200], lock: 88, orientation: 'portrait' },
  { name: '880x344 (foldable cover screen)', v: { width: 880, height: 344 },
    button: 76, gap: 14, inset: 14, drift: [790, 254], itemY: 164, gasX: 700,
    steer: [0, 0, 440, 344], lock: 123, orientation: 'landscape' },
  { name: '827x689 (foldable, unfolded)', v: { width: 827, height: 689 },
    button: 128, gap: 23, inset: 28, drift: [671, 533], itemY: 382, gasX: 520,
    steer: [0, 0, 414, 689], lock: 116, orientation: 'landscape' },
  { name: '1280x800 (tablet)', v: { width: 1280, height: 800 },
    button: 128, gap: 23, inset: 32, drift: [1120, 640], itemY: 489, gasX: 969,
    steer: [0, 0, 640, 800], lock: 168, orientation: 'landscape' },
  { name: '1366x1024 (large tablet)', v: { width: 1366, height: 1024 },
    button: 128, gap: 23, inset: 41, drift: [1197, 855], itemY: 704, gasX: 1046,
    steer: [0, 0, 683, 1024], lock: 168, orientation: 'landscape' },
]

const rect = (): Rect => ({ x: 0, y: 0, w: 0, h: 0 })

function metricsFor(v: Viewport, insets: Insets = NO_INSETS): ControlMetrics {
  const m = createControlMetrics()
  controlMetrics(v, insets, m)
  return m
}

describe('the touch layout is derived from the viewport, not fixed', () => {
  it.each(ROWS.map((r) => [r.name, r] as const))('%s', (_name, row) => {
    const m = metricsFor(row.v)
    expect(m.orientation).toBe(row.orientation)
    expect(m.buttonPx).toBe(row.button)
    expect(m.gapPx).toBe(row.gap)
    expect(m.insetPx).toBe(row.inset)
    expect(m.fullLockPx).toBe(row.lock)
    expect(m.fits).toBe(true)

    const drift = rect()
    const item = rect()
    const gas = rect()
    const steer = rect()
    driftButtonRect(row.v, m, drift)
    itemButtonRect(row.v, m, item)
    gasButtonRect(row.v, m, gas)
    steeringZoneRect(row.v, m, NO_INSETS, steer)

    expect([drift.x, drift.y]).toEqual(row.drift)
    expect(drift.w).toBe(row.button)
    expect(item.y).toBe(row.itemY)
    expect(gas.x).toBe(row.gasX)
    expect([steer.x, steer.y, steer.w, steer.h]).toEqual(row.steer)
  })
})

describe('invariants that hold on every shape', () => {
  /**
   * The assertion that would have caught the real bug. `virtualStick` tests its
   * pedal rects BEFORE the steering rect, so where the two overlap the pedal wins
   * and steering is silently swallowed rather than visibly conflicting. Under the
   * old fixed layout, every viewport narrower than about 416 px overlapped.
   */
  it.each(ROWS.map((r) => [r.name, r] as const))('%s: steering never overlaps the pedals', (_n, row) => {
    const m = metricsFor(row.v)
    const steer = rect()
    const gas = rect()
    const brake = rect()
    steeringZoneRect(row.v, m, NO_INSETS, steer)
    gasButtonRect(row.v, m, gas)
    brakeButtonRect(row.v, m, brake)
    expect(steer.x + steer.w).toBeLessThanOrEqual(gas.x)
    expect(steer.x + steer.w).toBeLessThanOrEqual(brake.x)
  })

  /** The old itemButtonRect went NEGATIVE below 208 px of height, with nothing checking. */
  it.each(ROWS.map((r) => [r.name, r] as const))('%s: every rect is fully on screen', (_n, row) => {
    const m = metricsFor(row.v)
    for (const [label, fn] of [
      ['drift', driftButtonRect], ['item', itemButtonRect],
      ['gas', gasButtonRect], ['brake', brakeButtonRect],
    ] as const) {
      const r = rect()
      fn(row.v, m, r)
      expect(r.x, `${label}.x`).toBeGreaterThanOrEqual(0)
      expect(r.y, `${label}.y`).toBeGreaterThanOrEqual(0)
      expect(r.x + r.w, `${label} right edge`).toBeLessThanOrEqual(row.v.width)
      expect(r.y + r.h, `${label} bottom edge`).toBeLessThanOrEqual(row.v.height)
    }
    const steer = rect()
    steeringZoneRect(row.v, m, NO_INSETS, steer)
    expect(steer.y).toBeGreaterThanOrEqual(0)
    expect(steer.y + steer.h).toBeLessThanOrEqual(row.v.height)
  })

  it('displaces the whole layout by the safe-area insets', () => {
    const v: Viewport = { width: 844, height: 390 }
    const cutout: Insets = { top: 0, right: 44, bottom: 24, left: 44 }
    const plain = metricsFor(v)
    const inset = metricsFor(v, cutout)
    const a = rect()
    const b = rect()
    driftButtonRect(v, plain, a)
    driftButtonRect(v, inset, b)
    expect(a.x - b.x).toBe(44)
    expect(a.y - b.y).toBe(24)

    const steer = rect()
    steeringZoneRect(v, inset, cutout, steer)
    expect(steer.x).toBe(44)
  })

  it('reports fits=false only when the viewport is genuinely unusable', () => {
    expect(metricsFor({ width: 200, height: 150 }).fits).toBe(false)
    expect(metricsFor({ width: 320, height: 200 }).fits).toBe(true)
  })

  it('grows the button with the short edge, and clamps at both ends', () => {
    const sizes = ROWS.map((r) => ({ short: Math.min(r.v.width, r.v.height), px: metricsFor(r.v).buttonPx }))
      .sort((x, y) => x.short - y.short)
    for (let i = 1; i < sizes.length; i++) {
      expect(sizes[i].px, `${sizes[i].short} vs ${sizes[i - 1].short}`)
        .toBeGreaterThanOrEqual(sizes[i - 1].px)
    }
    expect(metricsFor({ width: 400, height: 200 }).buttonPx).toBe(64)   // floor
    expect(metricsFor({ width: 4000, height: 3000 }).buttonPx).toBe(128) // ceiling
  })
})
