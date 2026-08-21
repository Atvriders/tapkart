import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'

const SETTINGS_KEY = 'tapkart.settings.v1'

async function openSettings(page: Page): Promise<void> {
  const panel = page.locator('section.tk-settings')
  if ((await panel.getAttribute('data-expanded')) !== 'true') {
    await panel.getByRole('button', { name: 'SETTINGS', exact: true }).click()
  }
  await expect(panel).toHaveAttribute('data-expanded', 'true')
}

async function closeSettings(page: Page): Promise<void> {
  const panel = page.locator('section.tk-settings')
  if ((await panel.getAttribute('data-expanded')) === 'true') {
    await panel.getByRole('button', { name: 'SETTINGS', exact: true }).click()
  }
  await expect(panel).toHaveAttribute('data-expanded', 'false')
}

async function startSolo(page: Page): Promise<void> {
  await page.getByTestId('solo-button').click()
  await page.getByRole('button', { name: 'Ava Cruz', exact: true }).click()
  await page.getByTestId('start-button').click()
  await expect(page.locator('[data-control-overlay]')).toBeVisible()
}

async function box(locator: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  return await locator.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
  })
}

async function installMotionGate(page: Page, permission: 'granted' | 'denied'): Promise<void> {
  await page.addInitScript((initialPermission) => {
    const state = globalThis as typeof globalThis & { __tapkartMotionPermission: 'granted' | 'denied' }
    state.__tapkartMotionPermission = initialPermission
    Object.defineProperty(globalThis, 'DeviceOrientationEvent', {
      configurable: true,
      value: {
        requestPermission: async () => state.__tapkartMotionPermission,
      },
    })
  }, permission)
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 844, height: 390 })
})

test('mobile race affordances match pure geometry, switch schemes, rotate, and quit', async ({ page }) => {
  await page.goto('/')
  const overlay = page.locator('[data-control-overlay]')
  await expect(overlay).toBeHidden()

  await openSettings(page)
  const name = page.getByLabel('Player name')
  await name.fill('  Rae  ')
  await name.press('Tab')
  const volume = page.getByLabel('Audio volume')
  await volume.evaluate((element) => {
    const input = element as HTMLInputElement
    input.value = '0.25'
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await expect.poll(async () => await page.evaluate((key) => {
    const raw = localStorage.getItem(key)
    if (raw === null) return null
    const saved = JSON.parse(raw) as { playerName: string; audioVolume: number }
    return { playerName: saved.playerName, audioVolume: saved.audioVolume }
  }, SETTINGS_KEY)).toEqual({ playerName: 'Rae', audioVolume: 0.25 })
  await closeSettings(page)

  await page.getByTestId('solo-button').click()
  await page.getByRole('button', { name: 'Ava Cruz', exact: true }).click()
  await page.getByLabel('Track').selectOption('dust-canyon')
  await expect.poll(async () => await page.evaluate((key) => {
    const raw = localStorage.getItem(key)
    return raw === null ? null : (JSON.parse(raw) as { lastTrackId: string }).lastTrackId
  }, SETTINGS_KEY)).toBe('dust-canyon')
  await page.getByTestId('start-button').click()

  await expect(overlay).toBeVisible()
  await expect(overlay).toHaveAttribute('data-scheme', 'thumbZones')
  expect(await box(page.locator('[data-control="steer"]'))).toEqual({
    x: 0, y: 0, width: 422, height: 390,
  })
  // Derived from the 390 px short edge: 390 * 0.22 -> 86, gap 16, inset 16.
  expect(await box(page.locator('[data-control="drift"]'))).toEqual({
    x: 742, y: 288, width: 86, height: 86,
  })
  expect(await box(page.locator('[data-control="item"]'))).toEqual({
    x: 742, y: 186, width: 86, height: 86,
  })
  await expect(page.locator('[data-control="gas"]')).toBeHidden()
  await expect(page.locator('[data-control="brake"]')).toBeHidden()
  expect(await overlay.evaluate((element) => getComputedStyle(element).pointerEvents)).toBe('none')
  expect(await page.locator('[data-control="drift"]').evaluate(
    (element) => getComputedStyle(element).pointerEvents,
  )).toBe('none')

  await page.getByRole('button', { name: 'Quit race' }).click()
  await expect(page.getByTestId('solo-button')).toBeVisible()
  await expect(overlay).toBeHidden()

  await openSettings(page)
  await page.locator('[data-setting="scheme-virtualStick"]').click()
  await closeSettings(page)
  await startSolo(page)
  await expect(overlay).toHaveAttribute('data-scheme', 'virtualStick')
  expect(await box(page.locator('[data-control="gas"]'))).toEqual({
    x: 640, y: 288, width: 86, height: 86,
  })
  expect(await box(page.locator('[data-control="brake"]'))).toEqual({
    x: 640, y: 186, width: 86, height: 86,
  })
  await expect(page.locator('[data-control="gas"]')).toHaveText('GAS')
  await expect(page.locator('[data-control="brake"]')).toHaveText('BRAKE')

  // Portrait used to show "Rotate your device" over a canvas that was never
  // resized. It is now a real layout: the controls stay up, and they MOVE --
  // steering becomes a thumb-reachable band across the bottom instead of a
  // full-height left half that would sit under the player's palm.
  // Clicking any menu button enters fullscreen (that is the feature), and a
  // fullscreen window cannot be resized -- setViewportSize fails with
  // "To resize minimized/maximized/fullscreen window, restore it first". Leave
  // it the way a player would before changing the window shape.
  await page.evaluate(async () => { await document.exitFullscreen?.().catch(() => undefined) })
  await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true)

  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.getByText('Rotate your device', { exact: true })).toHaveCount(0)
  await expect(overlay).toBeVisible()
  expect(await box(page.locator('[data-control="steer"]'))).toEqual({
    x: 0, y: 591, width: 170, height: 253,
  })
  expect(await box(page.locator('[data-control="gas"]'))).toEqual({
    x: 186, y: 742, width: 86, height: 86,
  })
  // The invariant the old fixed layout broke: steering must not reach under the
  // pedals, which test them first and would silently swallow it.
  const steer = await box(page.locator('[data-control="steer"]'))
  const gas = await box(page.locator('[data-control="gas"]'))
  expect(steer.x + steer.width).toBeLessThanOrEqual(gas.x)
})

test('tilt requires a real calibration sample and persists calibration and inversion', async ({ page }) => {
  await installMotionGate(page, 'granted')
  await page.goto('/')
  await openSettings(page)
  await page.locator('[data-setting="scheme-tilt"]').click()
  await expect(page.locator('[data-settings-note]')).toContainText('Hold the phone')
  await expect(page.locator('[data-setting="scheme-thumbZones"]')).toHaveAttribute('aria-pressed', 'true')

  await page.locator('[data-setting="calibrate-tilt"]').click()
  await expect(page.locator('[data-settings-note]')).toContainText('No motion reading yet')
  await expect(page.locator('[data-setting="scheme-thumbZones"]')).toHaveAttribute('aria-pressed', 'true')

  await page.evaluate(() => {
    const event = new Event('deviceorientation')
    Object.defineProperties(event, {
      alpha: { value: 12 },
      beta: { value: 4 },
      gamma: { value: -9 },
    })
    window.dispatchEvent(event)
  })
  await page.locator('[data-setting="calibrate-tilt"]').click()
  await expect(page.locator('[data-setting="scheme-tilt"]')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('[data-settings-note]')).toContainText('Tilt steering calibrated')
  await page.locator('[data-setting="invert-tilt"]').click()

  await expect.poll(async () => await page.evaluate((key) => {
    const raw = localStorage.getItem(key)
    if (raw === null) return null
    const saved = JSON.parse(raw) as {
      scheme: string
      invertTilt: boolean
      tiltCalibration: { betaZero: number; gammaZero: number }
    }
    return {
      scheme: saved.scheme,
      invertTilt: saved.invertTilt,
      tiltCalibration: saved.tiltCalibration,
    }
  }, SETTINGS_KEY)).toEqual({
    scheme: 'tilt',
    invertTilt: true,
    tiltCalibration: { betaZero: 4, gammaZero: -9 },
  })

  await closeSettings(page)
  await startSolo(page)
  const overlay = page.locator('[data-control-overlay]')
  await expect(overlay).toHaveAttribute('data-scheme', 'tilt')
  await expect(page.locator('[data-control="steer"]')).toContainText('TILT PHONE')
  await expect(page.locator('[data-control="drift"]')).toHaveText('DRIFT')
  await expect(page.locator('[data-control="item"]')).toHaveText('ITEM')
  await expect(page.locator('[data-control="gas"]')).toBeHidden()
})

test('denied motion permission is local and a connected host room stays alive', async ({ page }) => {
  await installMotionGate(page, 'denied')
  await page.goto('/')
  await openSettings(page)
  await page.getByLabel('Player name').fill('Rae')
  await page.getByLabel('Player name').press('Tab')
  await closeSettings(page)

  await page.getByTestId('host-button').click()
  const room = page.getByTestId('room-code')
  await expect(room).toBeVisible()
  const code = await room.textContent()
  await expect(page.getByRole('list', { name: 'Lobby players' })).toContainText('Rae')

  await openSettings(page)
  await page.getByLabel('Player name').fill('Nova')
  await page.getByLabel('Player name').press('Tab')
  await expect(page.getByRole('list', { name: 'Lobby players' })).toContainText('Nova')
  await page.locator('[data-setting="scheme-tilt"]').click()
  await expect(page.locator('[data-settings-note]')).toContainText('Motion access was denied')
  await expect(room).toHaveText(code ?? '')
  await expect(page.getByTestId('start-button')).toBeVisible()
  await expect(page.getByRole('list', { name: 'Lobby players' })).toContainText('Nova')
})
