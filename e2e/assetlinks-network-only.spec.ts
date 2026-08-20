import { expect, test } from '@playwright/test'

import { gotoControlled } from './fixtures/tapkart'

/**
 * The raw Plan 4 server deliberately has no generated assetlinks file: only
 * the container entrypoint creates it. A network 404 here is therefore the
 * useful sentinel. A cached fake 200 must never mask that response.
 */
test('/.well-known/assetlinks.json stays network-only and lands in no cache', async ({
  page,
  context,
}) => {
  await gotoControlled(page)

  const online = await page.evaluate(async () => {
    const url = new URL('/.well-known/assetlinks.json', location.origin).toString()
    const names = await caches.keys()
    const managed = names.find((name) => name.startsWith('tapkart-')) ?? null
    if (managed === null) return { managed, status: -1, cached: ['no-managed-cache'] }

    for (const name of names) await (await caches.open(name)).delete(url)
    const response = await fetch(url)
    const status = response.status
    const cached: string[] = []
    for (const name of await caches.keys()) {
      if ((await (await caches.open(name)).match(url)) !== undefined) cached.push(name)
    }
    return { managed, status, cached }
  })

  expect(online.managed).not.toBeNull()
  expect(online.status, 'the non-container server is the network 404 sentinel').toBe(404)
  expect(online.cached).toEqual([])

  // Distinguish networkOnly from a cache fallback: plant a response, take the
  // browser offline, and require fetch to reject rather than return the trap.
  await page.evaluate(async (cacheName) => {
    const url = new URL('/.well-known/assetlinks.json', location.origin).toString()
    await (await caches.open(cacheName)).put(
      url,
      new Response('cached trap', { status: 200, headers: { 'content-type': 'text/plain' } }),
    )
  }, online.managed!)

  await context.setOffline(true)
  try {
    const offline = await page.evaluate(async () => {
      try {
        const response = await fetch('/.well-known/assetlinks.json')
        return { rejected: false, status: response.status, body: await response.text() }
      } catch {
        return { rejected: true, status: -1, body: '' }
      }
    })
    expect(offline).toEqual({ rejected: true, status: -1, body: '' })
  } finally {
    await context.setOffline(false)
    await page.evaluate(async ({ cacheName }) => {
      const url = new URL('/.well-known/assetlinks.json', location.origin).toString()
      await (await caches.open(cacheName)).delete(url)
    }, { cacheName: online.managed! })
  }

  const cachedAfter = await page.evaluate(async () => {
    const url = new URL('/.well-known/assetlinks.json', location.origin).toString()
    const hits: string[] = []
    for (const name of await caches.keys()) {
      if ((await (await caches.open(name)).match(url)) !== undefined) hits.push(name)
    }
    return hits
  })
  expect(cachedAfter).toEqual([])
})
