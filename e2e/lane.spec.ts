import { expect, test } from '@playwright/test'
import { ROOM_CODE_RE } from './fixtures/tapkart'

const WS_PATH = '/ws'
const HEALTH_PATH = '/healthz'
const ASSETLINKS_PATH = '/.well-known/assetlinks.json'
const LOBBY_PATH_PREFIX = '/r/'

test('the lane serves a live TapKart server on loopback', async ({ request }) => {
  const response = await request.get(HEALTH_PATH)
  expect(response.status()).toBe(200)
  expect(response.headers()['content-type']).toContain('application/json')
  expect(await response.json()).toMatchObject({ ok: true })
})

test('the raw server leaves assetlinks generation to the container, without redirecting', async ({ request }) => {
  const response = await request.get(ASSETLINKS_PATH, {
    maxRedirects: 0,
    failOnStatusCode: false,
  })
  expect(response.status()).toBe(404)
  expect(response.headers()['location']).toBeUndefined()

  const slashed = await request.get(`${ASSETLINKS_PATH}/`, {
    maxRedirects: 0,
    failOnStatusCode: false,
  })
  expect(slashed.status()).toBe(404)
  expect(slashed.headers()['location']).toBeUndefined()
})

test('an invite path serves the built SPA without a redirect', async ({ request }) => {
  const response = await request.get(`${LOBBY_PATH_PREFIX}ABCDE`, {
    maxRedirects: 0,
    failOnStatusCode: false,
  })
  expect(response.status()).toBe(200)
  expect(response.headers()['location']).toBeUndefined()
  expect(await response.text()).toContain('id="tk-canvas"')
})

test('a browser can open a WebSocket through the real upgrade path', async ({ page, baseURL }) => {
  await page.goto(HEALTH_PATH)
  const opened = await page.evaluate(async (url: string) => {
    return await new Promise<boolean>((resolve) => {
      const socket = new WebSocket(url)
      const timer = window.setTimeout(() => resolve(false), 10_000)
      socket.onopen = () => {
        window.clearTimeout(timer)
        socket.close()
        resolve(true)
      }
      socket.onerror = () => {
        window.clearTimeout(timer)
        resolve(false)
      }
    })
  }, String(baseURL).replace(/^http/, 'ws') + WS_PATH)
  expect(opened).toBe(true)
})

test('the mirrored room-code alphabet is canonical', () => {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
  expect(alphabet).toHaveLength(32)
  expect(new Set(alphabet).size).toBe(32)
  for (const confusable of ['I', 'L', 'O', 'U']) expect(alphabet).not.toContain(confusable)
  expect('0ABCD').toMatch(ROOM_CODE_RE)
  expect('0ABC').not.toMatch(ROOM_CODE_RE)
  expect('0ABCI').not.toMatch(ROOM_CODE_RE)
})
