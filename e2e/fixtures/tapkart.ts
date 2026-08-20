import { expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import WebSocket from 'ws'

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

/**
 * Navigate to `path` and return with the service worker controlling a page that
 * will not navigate again underneath the caller.
 *
 * `apps/web/src/main.ts` reloads the page the first time the worker takes
 * control. That reload fires at the moment `controller !== null` becomes true,
 * so the naive `goto` + wait leaves the caller holding a context the reload is
 * about to destroy -- "Execution context was destroyed", about one run in three
 * on an unmodified tree.
 *
 * The fix is to wait for that reload's own `load` event rather than to race it.
 * The listener is armed BEFORE navigating, so the event cannot be missed. The
 * wait is bounded and its timeout is discarded on purpose: the reload is
 * dispatched straight from the `controllerchange` handler, so if it does not
 * arrive, the page was already controlled when it loaded and no reload was ever
 * coming. Either way the document that exists afterwards loaded under the
 * worker's control, fires no `controllerchange`, and is stable for the rest of
 * the test.
 *
 * Two approaches that do NOT work, both measured: navigating a second time only
 * moves the race, and the second `goto` is interrupted by the pending reload
 * ("Navigation to ... is interrupted by another navigation to ..."); absorbing
 * the reload with a throwaway page turned an occasional fast failure into a
 * ten-minute hang.
 */
export async function gotoControlled(page: Page, path = '/'): Promise<void> {
  const controlled = () =>
    page.waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, {
      timeout: 30_000,
    })

  let loads = 0
  page.on('load', () => {
    loads += 1
  })
  await page.goto(path)
  await controlled()
  // Wait out the app's one-shot reload: the initial load counts as 1, so a
  // second load is the reload landing. Bounded, because on an already-controlled
  // page no reload is coming and the count never reaches 2.
  await page
    .waitForFunction(() => document.readyState === 'complete', undefined, { timeout: 5_000 })
    .catch(() => undefined)
  const start = Date.now()
  while (loads < 2 && Date.now() - start < 5_000) {
    await page.waitForTimeout(100)
  }
  await controlled()
}

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

export async function joinRoomFromInvite(
  page: Page,
  code: string,
  backendOrigin: string,
): Promise<void> {
  const inviteOrigin = 'https://tapkart.e2e'
  const inviteSocketOrigin = inviteOrigin.replace(/^https:/, 'wss:')
  const backendSocketUrl = new URL('/ws', backendOrigin)
  backendSocketUrl.protocol = backendSocketUrl.protocol === 'https:' ? 'wss:' : 'ws:'

  // Invite URIs are HTTPS-only in production. Fulfil that public origin from
  // the loopback E2E lane while retaining the HTTPS address bar that main.ts
  // hands to the real invite parser.
  await page.route(`${inviteOrigin}/**`, async (route) => {
    const requested = new URL(route.request().url())
    const backend = new URL(requested.pathname + requested.search, backendOrigin)
    const response = await page.context().request.fetch(backend.toString())
    await route.fulfill({ response })
  })
  await page.routeWebSocket(`${inviteSocketOrigin}/ws`, (client) => {
    const server = new WebSocket(backendSocketUrl)
    const queued: Array<string | Buffer> = []
    let serverOpen = false
    let clientClosed = false

    client.onMessage((message) => {
      if (serverOpen) server.send(message)
      else queued.push(message)
    })
    client.onClose((code, reason) => {
      clientClosed = true
      if (server.readyState === WebSocket.CONNECTING) server.terminate()
      else if (server.readyState === WebSocket.OPEN) server.close(code, reason)
    })

    server.on('open', () => {
      serverOpen = true
      for (const message of queued) server.send(message)
      queued.length = 0
    })
    server.on('message', (message, isBinary) => {
      if (clientClosed) return
      if (!isBinary) {
        client.send(message.toString())
        return
      }
      const bytes = Array.isArray(message) ? Buffer.concat(message) : Buffer.from(message)
      client.send(bytes)
    })
    server.on('close', (code, reason) => {
      if (clientClosed) return
      clientClosed = true
      void client.close({ code, reason: reason.toString() })
    })
    server.on('error', () => {
      if (clientClosed) return
      clientClosed = true
      void client.close({ code: 1011, reason: 'E2E backend WebSocket failed' })
    })
  })
  await page.addInitScript(() => {
    // Chromium does not let a routed synthetic HTTPS origin install a worker
    // from its HTTP backing response. This spec owns invite/multiplayer, while
    // offline-solo.spec.ts exercises the real service worker on loopback.
    const registration = {
      waiting: null,
      installing: null,
      addEventListener: () => undefined,
    }
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: {
        register: async () => registration,
        addEventListener: () => undefined,
      },
    })
  })

  await page.goto(`${inviteOrigin}/r/${code}`)
  await expect(page).toHaveURL(new RegExp(`/r/${code}$`, 'i'))
  await expect(hook(page, 'roomCodeDisplay')).toHaveText(new RegExp(code, 'i'))
}
