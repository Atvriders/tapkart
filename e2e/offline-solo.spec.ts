import { expect, test } from '@playwright/test'

import { gotoControlled } from './fixtures/tapkart'

/**
 * This runs against the built app. The service worker is emitted only by the
 * production build, so a dev-server green cannot satisfy the offline contract.
 */
test('the installed app opens and runs a solo race with the network off', async ({
  page,
  context,
}) => {
  const swResponse = await page.request.get('/sw.js')
  expect(
    swResponse.status(),
    'GET /sw.js did not return 200 — build @tapkart/web and serve apps/web/dist',
  ).toBe(200)

  await gotoControlled(page)

  await context.setOffline(true)
  try {
    await page.reload()
    await expect(page.getByTestId('solo-button')).toBeVisible()
    await page.getByTestId('solo-button').click()

    // Solo first enters character selection; merely seeing the canvas (which is
    // mounted for the whole shell lifetime) would not prove a race started.
    await page.getByRole('button', { name: 'Ava Cruz', exact: true }).click()
    await expect(page.getByTestId('start-button')).toBeVisible()
    await page.getByTestId('start-button').click()

    await expect(page.getByTestId('race-canvas')).toBeVisible({ timeout: 20_000 })
    await expect(page.getByTestId('lap-counter')).toHaveText(/[1-3]\s*\/\s*3/, {
      timeout: 20_000,
    })

    await page.waitForTimeout(2_000)
    await expect(page.getByTestId('race-canvas')).toBeVisible()
    await expect(page.getByTestId('lap-counter')).toHaveText(/[1-3]\s*\/\s*3/)
  } finally {
    await context.setOffline(false)
  }
})
