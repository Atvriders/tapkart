import { expect, test } from '@playwright/test'
import { HOOKS, hook, hostRoom, joinRoomFromInvite } from './fixtures/tapkart'

test('an invite guest finishes a race and follows the host into a rematch', async ({ browser, baseURL }) => {
  const contextOptions = {
    baseURL,
    viewport: { width: 1280, height: 720 },
  }
  const hostContext = await browser.newContext(contextOptions)
  const guestContext = await browser.newContext(contextOptions)
  const host = await hostContext.newPage()
  const guest = await guestContext.newPage()
  const errors: string[] = []
  for (const [who, page] of [['host', host], ['guest', guest]] as const) {
    page.on('pageerror', (error) => errors.push(`${who}: ${error.message}`))
  }

  try {
    const code = await hostRoom(host)
    await joinRoomFromInvite(guest, code, String(baseURL))

    await expect(hook(host, 'roomCodeDisplay')).toHaveText(new RegExp(code, 'i'))
    await expect(hook(guest, 'readyButton')).toBeVisible()
    await hook(guest, 'readyButton').click()
    await expect(hook(guest, 'startButton')).toHaveCount(0)
    await expect(hook(host, 'startButton')).toBeVisible()
    await hook(host, 'startButton').click()

    await expect(hook(host, 'raceCanvas')).toBeVisible()
    await expect(hook(guest, 'raceCanvas')).toBeVisible()
    await expect(hook(host, 'lapCounter')).toHaveText(/[1-3]\s*\/\s*3/, { timeout: 60_000 })
    await expect(hook(guest, 'lapCounter')).toHaveText(/[1-3]\s*\/\s*3/, { timeout: 60_000 })

    await expect(hook(host, 'resultsScreen')).toBeVisible({ timeout: 540_000 })
    await expect(hook(guest, 'resultsScreen')).toBeVisible({ timeout: 60_000 })

    await host.getByRole('button', { name: 'BACK TO LOBBY', exact: true }).click()
    await expect(hook(host, 'startButton')).toBeVisible()
    await expect(hook(guest, 'resultsScreen')).toBeVisible()
    await hook(host, 'startButton').click()

    await expect(hook(guest, 'resultsScreen')).toHaveCount(0)
    await expect(hook(guest, 'lapCounter')).toBeVisible()
    await expect(hook(guest, 'lapCounter')).toHaveText('LAP 1/3', { timeout: 60_000 })
    expect(errors).toEqual([])
  } finally {
    await hostContext.close()
    await guestContext.close()
  }
})

test('a nonexistent room surfaces an error instead of hanging', async ({ page }) => {
  await page.goto('/')
  await hook(page, 'joinButton').click()
  await hook(page, 'roomCodeInput').fill('ZZZZZ')
  await hook(page, 'roomCodeSubmit').click()

  await expect(page.getByText(/not found|no such room|invalid/i)).toBeVisible()
  await expect(page.getByTestId(HOOKS.roomCodeDisplay)).toHaveCount(0)
})
