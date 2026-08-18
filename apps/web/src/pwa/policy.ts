// PURE. Contract §8.3 and the sole decider of every caching decision.
// This module is compiled by both the DOM app and WebWorker programs, so it
// deliberately names no ambient global and no platform type.

export interface SwRequestInfo {
  method: string
  url: string
  sameOrigin: boolean
  isNavigate: boolean
}

export type SwRouteAction =
  | 'passthrough'
  | 'cacheFirst'
  | 'networkFirst'
  | 'networkOnly'
  | 'shellFallback'

export interface SwRoute {
  action: SwRouteAction
  cacheKey: string
}

export interface SwConfig {
  cacheName: string
  precache: readonly string[]
  shellPath: string
  neverCachePrefixes: readonly string[]
}

export const NEVER_CACHE_PREFIXES: readonly string[] = [
  '/.well-known/',
  '/api/',
  '/signal',
  '/ws',
  '/healthz',
]

export const DEFAULT_SW_CONFIG: Readonly<SwConfig> = {
  cacheName: 'tapkart-dev',
  precache: [],
  shellPath: '/index.html',
  neverCachePrefixes: NEVER_CACHE_PREFIXES,
}

/** Hand-parses an ordinary absolute URL without relying on an ambient `URL`.
 * Opaque schemes such as `blob:` and `data:` are deliberately treated as `/`:
 * `://` denotes the outer URL only when it begins at that URL's first colon.
 */
function pathOf(url: string): string {
  let rest = url
  const firstColon = rest.indexOf(':')
  const schemeDelimiter = rest.indexOf('://')
  if (schemeDelimiter >= 0 && schemeDelimiter === firstColon) {
    rest = rest.slice(schemeDelimiter + 3)
    const slash = rest.indexOf('/')
    rest = slash < 0 ? '/' : rest.slice(slash)
  } else if (!rest.startsWith('/')) {
    return '/'
  }

  const query = rest.indexOf('?')
  if (query >= 0) rest = rest.slice(0, query)
  const hash = rest.indexOf('#')
  if (hash >= 0) rest = rest.slice(0, hash)
  return rest === '' ? '/' : rest
}

export function routeRequest(info: SwRequestInfo, cfg: SwConfig): SwRoute {
  if (info.method !== 'GET') return { action: 'passthrough', cacheKey: '' }
  if (!info.sameOrigin) return { action: 'passthrough', cacheKey: '' }

  const path = pathOf(info.url)
  for (const prefix of cfg.neverCachePrefixes) {
    if (path.startsWith(prefix)) return { action: 'networkOnly', cacheKey: '' }
  }

  if (info.isNavigate) return { action: 'shellFallback', cacheKey: cfg.cacheName }

  for (const entry of cfg.precache) {
    if (entry === path) return { action: 'cacheFirst', cacheKey: cfg.cacheName }
  }

  return { action: 'networkFirst', cacheKey: cfg.cacheName }
}
