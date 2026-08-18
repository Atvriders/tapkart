import { expect } from '@playwright/test'
import type { Page } from '@playwright/test'

export const HOOKS = {
  hostButton: 'host-button',
  joinButton: 'join-button',
  roomCodeInput: 'room-code-input',
  roomCodeSubmit: 'room-code-submit',
  roomCodeDisplay: 'room-code',
  readyButton: 'ready-button',
  startButton: 'start-button',
  raceCanvas: 'race-canvas',
  lapCounter: 'lap-counter',
  resultsScreen: 'results',
} as const

/** Mirrors ROOM_CODE_ALPHABET and ROOM_CODE_LENGTH from @tapkart/protocol. */
export const ROOM_CODE_RE = /^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{5}$/

export function hook(page: Page, name: keyof typeof HOOKS) {
  return page.getByTestId(HOOKS[name])
}

export async function hostRoom(page: Page): Promise<string> {
  await page.goto('/')
  await hook(page, 'hostButton').click()
  const display = hook(page, 'roomCodeDisplay')
  await expect(display).toBeVisible()
  const code = ((await display.textContent()) ?? '').trim().toUpperCase()
  expect(code).toMatch(ROOM_CODE_RE)
  return code
}

export async function joinRoom(page: Page, code: string): Promise<void> {
  await page.goto('/')
  await hook(page, 'joinButton').click()
  await hook(page, 'roomCodeInput').fill(code)
  await hook(page, 'roomCodeSubmit').click()
  await expect(hook(page, 'roomCodeDisplay')).toHaveText(new RegExp(code, 'i'))
}
