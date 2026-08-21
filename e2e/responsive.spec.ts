import { expect, test } from '@playwright/test'

import { gotoControlled } from './fixtures/tapkart'

/**
 * The screens this game is actually expected to run on, in a real browser.
 *
 * The unit table in packages/game/test/controls-layout.test.ts proves the
 * geometry; this proves the geometry reaches the DOM, that the menus remain
 * usable at every shape, and that nothing overflows -- none of which a pure
 * function can show.
 */
const SHAPES = [
  { name: 'phone portrait', width: 390, height: 844 },
  { name: 'phone landscape', width: 844, height: 390 },
  { name: 'small phone portrait', width: 360, height: 640 },
  { name: 'foldable cover screen', width: 880, height: 344 },
  { name: 'foldable unfolded', width: 827, height: 689 },
  { name: 'tablet landscape', width: 1280, height: 800 },
  { name: 'tablet portrait', width: 800, height: 1280 },
] as const

async function leaveFullscreen(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(async () => { await document.exitFullscreen?.().catch(() => undefined) })
  await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true)
}

test.describe('every screen shape is playable', () => {
  for (const shape of SHAPES) {
    test(`${shape.name} (${shape.width}x${shape.height}) reaches a race`, async ({ page }) => {
      await page.setViewportSize({ width: shape.width, height: shape.height })
      await gotoControlled(page)

      // The menu must be reachable BEFORE any gesture, because a guest arriving
      // from an NFC tap has none: their first tap is the character button, and
      // everything before it has to work with browser chrome visible.
      const solo = page.getByTestId('solo-button')
      await expect(solo).toBeVisible()
      const btn = await solo.boundingBox()
      expect(btn, 'solo button has no box').not.toBeNull()
      expect(btn!.y).toBeGreaterThanOrEqual(0)
      expect(btn!.y + btn!.height).toBeLessThanOrEqual(shape.height)
      expect(btn!.x + btn!.width).toBeLessThanOrEqual(shape.width)
      // Touch targets stay tappable at every size.
      expect(btn!.height).toBeGreaterThanOrEqual(40)

      // The page itself never scrolls sideways at any shape.
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      )
      expect(overflow, 'the page scrolls horizontally').toBeLessThanOrEqual(0)

      await solo.click()
      await page.getByRole('button', { name: 'Ava Cruz', exact: true }).click()
      await page.getByTestId('start-button').click()

      const overlay = page.locator('[data-control-overlay]')
      await expect(overlay).toBeVisible()

      // Every control is on screen and inside the viewport at this shape.
      for (const control of ['steer', 'drift', 'item']) {
        const r = await page.locator(`[data-control="${control}"]`).boundingBox()
        expect(r, `${control} has no box`).not.toBeNull()
        expect(r!.x, `${control}.x`).toBeGreaterThanOrEqual(0)
        expect(r!.y, `${control}.y`).toBeGreaterThanOrEqual(0)
        expect(r!.x + r!.width, `${control} right edge`).toBeLessThanOrEqual(shape.width)
        expect(r!.y + r!.height, `${control} bottom edge`).toBeLessThanOrEqual(shape.height)
      }

      // The canvas fills the viewport and its drawing buffer was actually sized:
      // the old code skipped resize in portrait, leaving a stale buffer stretched.
      const canvas = await page.evaluate(() => {
        const el = document.getElementById('tk-canvas') as HTMLCanvasElement | null
        return el === null ? null : { w: el.width, h: el.height, cw: el.clientWidth, ch: el.clientHeight }
      })
      expect(canvas).not.toBeNull()
      expect(canvas!.cw).toBe(shape.width)
      expect(canvas!.ch).toBe(shape.height)
      expect(canvas!.w, 'drawing buffer was never sized').toBeGreaterThan(0)
      expect(canvas!.h, 'drawing buffer was never sized').toBeGreaterThan(0)

      await leaveFullscreen(page)
    })
  }
})

test('the layout follows a fold, mid-race, without reloading', async ({ page }) => {
  // A foldable changes shape under a LIVE race. The canvas must re-resize and the
  // controls must move, within a frame and without the page reloading.
  await page.setViewportSize({ width: 880, height: 344 })
  await gotoControlled(page)
  await page.getByTestId('solo-button').click()
  await page.getByRole('button', { name: 'Ava Cruz', exact: true }).click()
  await page.getByTestId('start-button').click()
  await expect(page.getByTestId('lap-counter')).toBeVisible()

  const folded = await page.locator('[data-control="drift"]').boundingBox()
  await leaveFullscreen(page)

  await page.setViewportSize({ width: 827, height: 689 })
  // Still racing: no reload, no menu, no overlay.
  await expect(page.getByTestId('lap-counter')).toBeVisible()
  await expect(page.getByTestId('solo-button')).toHaveCount(0)

  await expect.poll(async () => {
    const r = await page.locator('[data-control="drift"]').boundingBox()
    return r === null ? -1 : Math.round(r.width)
  }).toBe(128) // 689 * 0.22 clamps to the 128 px ceiling

  const unfolded = await page.locator('[data-control="drift"]').boundingBox()
  expect(unfolded!.width).toBeGreaterThan(folded!.width)
  expect(await page.evaluate(() => {
    const el = document.getElementById('tk-canvas') as HTMLCanvasElement
    return el.clientWidth
  })).toBe(827)
})
