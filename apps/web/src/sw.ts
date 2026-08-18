// ADAPTER. Compiled only by tsconfig.sw.json, with WebWorker and no DOM/Node
// ambient types. The pure routing policy is the only decision maker.
const sw = self as unknown as ServiceWorkerGlobalScope

import { DEFAULT_SW_CONFIG, routeRequest, type SwConfig } from './pwa/policy'

declare const __PRECACHE__: string[]
declare const __SW_VERSION__: string

const CONFIG: SwConfig = {
  ...DEFAULT_SW_CONFIG,
  cacheName: `tapkart-${__SW_VERSION__}`,
  precache: __PRECACHE__,
}

sw.addEventListener('install', (event) => {
  // Never skip waiting automatically: a bundle must not swap under a live race.
  event.waitUntil(caches.open(CONFIG.cacheName).then((cache) => cache.addAll([...CONFIG.precache])))
})

sw.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names
            .filter((name) => name.startsWith('tapkart-') && name !== CONFIG.cacheName)
            .map((name) => caches.delete(name)),
        ),
      )
      .then(() => sw.clients.claim()),
  )
})

async function fromCacheFirst(request: Request, cacheKey: string): Promise<Response> {
  const cache = await caches.open(cacheKey)
  const hit = await cache.match(request)
  if (hit !== undefined) return hit
  const fresh = await fetch(request)
  if (fresh.ok) await cache.put(request, fresh.clone())
  return fresh
}

async function fromNetworkFirst(request: Request, cacheKey: string): Promise<Response> {
  const cache = await caches.open(cacheKey)
  try {
    const fresh = await fetch(request)
    if (fresh.ok) await cache.put(request, fresh.clone())
    return fresh
  } catch (error) {
    const hit = await cache.match(request)
    if (hit !== undefined) return hit
    throw error
  }
}

async function fromShell(request: Request, cacheKey: string): Promise<Response> {
  try {
    return await fetch(request)
  } catch (error) {
    const cache = await caches.open(cacheKey)
    const shell = await cache.match(CONFIG.shellPath)
    if (shell !== undefined) return shell
    throw error
  }
}

sw.addEventListener('fetch', (event) => {
  const request = event.request
  const route = routeRequest(
    {
      method: request.method,
      url: request.url,
      sameOrigin: new URL(request.url).origin === sw.location.origin,
      isNavigate: request.mode === 'navigate',
    },
    CONFIG,
  )

  switch (route.action) {
    case 'passthrough':
      return
    case 'networkOnly':
      event.respondWith(fetch(request))
      return
    case 'cacheFirst':
      event.respondWith(fromCacheFirst(request, route.cacheKey))
      return
    case 'networkFirst':
      event.respondWith(fromNetworkFirst(request, route.cacheKey))
      return
    case 'shellFallback':
      event.respondWith(fromShell(request, route.cacheKey))
      return
  }
})

sw.addEventListener('message', (event) => {
  const data: unknown = event.data
  if (typeof data === 'object' && data !== null && (data as { type?: unknown }).type === 'SKIP_WAITING') {
    void sw.skipWaiting()
  }
})
