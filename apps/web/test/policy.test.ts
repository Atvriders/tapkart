import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SW_CONFIG,
  NEVER_CACHE_PREFIXES,
  routeRequest,
  type SwConfig,
  type SwRequestInfo,
  type SwRouteAction,
} from '../src/pwa/policy'

const CACHE = 'tapkart-abc123'

const cfg: SwConfig = {
  cacheName: CACHE,
  precache: ['/index.html', '/assets/index-1a2b3c.js', '/assets/index-4d5e6f.css', '/icons/icon-192.png'],
  shellPath: '/index.html',
  neverCachePrefixes: NEVER_CACHE_PREFIXES,
}

function req(partial: Partial<SwRequestInfo> & { url: string }): SwRequestInfo {
  return {
    method: 'GET',
    sameOrigin: true,
    isNavigate: false,
    ...partial,
  }
}

describe('NEVER_CACHE_PREFIXES', () => {
  it('is exactly §8.3 rule 3, in order', () => {
    expect([...NEVER_CACHE_PREFIXES]).toEqual(['/.well-known/', '/api/', '/signal', '/ws', '/healthz'])
  })
})

describe('DEFAULT_SW_CONFIG', () => {
  it('names the shell at the root and carries the never-cache list', () => {
    expect(DEFAULT_SW_CONFIG.shellPath).toBe('/index.html')
    expect([...DEFAULT_SW_CONFIG.neverCachePrefixes]).toEqual([...NEVER_CACHE_PREFIXES])
  })

  it('precaches nothing by default, because the real list comes from the build manifest', () => {
    expect([...DEFAULT_SW_CONFIG.precache]).toEqual([])
  })

  it('uses a cache name inside the tapkart- family that activate() collects', () => {
    expect(DEFAULT_SW_CONFIG.cacheName.startsWith('tapkart-')).toBe(true)
  })
})

describe('routeRequest — §8.3, one row at a time', () => {
  it('rule 5: a precached path is cacheFirst', () => {
    expect(routeRequest(req({ url: 'https://tapkart.example/assets/index-1a2b3c.js' }), cfg)).toEqual({
      action: 'cacheFirst',
      cacheKey: CACHE,
    })
  })

  it('rule 6: any other same-origin GET is networkFirst', () => {
    expect(routeRequest(req({ url: 'https://tapkart.example/assets/never-seen.js' }), cfg)).toEqual({
      action: 'networkFirst',
      cacheKey: CACHE,
    })
  })

  it('rule 4: a navigation is shellFallback', () => {
    expect(routeRequest(req({ url: 'https://tapkart.example/r/ABCDE', isNavigate: true }), cfg)).toEqual({
      action: 'shellFallback',
      cacheKey: CACHE,
    })
  })

  it('rule 3: every never-cache prefix is networkOnly, and carries no cache key', () => {
    for (const prefix of NEVER_CACHE_PREFIXES) {
      expect(routeRequest(req({ url: `https://tapkart.example${prefix}anything` }), cfg)).toEqual({
        action: 'networkOnly',
        cacheKey: '',
      })
    }
  })

  it('rule 2: cross-origin is passthrough, and carries no cache key', () => {
    expect(
      routeRequest(req({ url: 'https://kart.example.com/assets/index-1a2b3c.js', sameOrigin: false }), cfg),
    ).toEqual({ action: 'passthrough', cacheKey: '' })
  })

  it('rule 1: a non-GET is passthrough', () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'HEAD', 'OPTIONS', 'PATCH']) {
      expect(routeRequest(req({ url: 'https://tapkart.example/index.html', method }), cfg).action).toBe(
        'passthrough',
      )
    }
  })
})

describe('routeRequest — ordered precedence', () => {
  it('a non-GET navigation is passthrough, not shellFallback', () => {
    expect(
      routeRequest(req({ url: 'https://tapkart.example/r/ABCDE', method: 'POST', isNavigate: true }), cfg)
        .action,
    ).toBe('passthrough')
  })

  it('a cross-origin request under a never-cache prefix is passthrough, not networkOnly', () => {
    expect(
      routeRequest(req({ url: 'https://kart.example.com/api/rooms', sameOrigin: false }), cfg).action,
    ).toBe('passthrough')
  })

  it('a navigation to /.well-known/assetlinks.json is networkOnly, not shellFallback', () => {
    expect(
      routeRequest(
        req({ url: 'https://tapkart.example/.well-known/assetlinks.json', isNavigate: true }),
        cfg,
      ),
    ).toEqual({ action: 'networkOnly', cacheKey: '' })
  })

  it('a navigation to a precached path is shellFallback, not cacheFirst', () => {
    expect(routeRequest(req({ url: 'https://tapkart.example/index.html', isNavigate: true }), cfg).action).toBe(
      'shellFallback',
    )
  })

  it('the same asset is cacheFirst when precached and networkFirst when not', () => {
    const url = 'https://tapkart.example/assets/index-1a2b3c.js'
    expect(routeRequest(req({ url }), cfg).action).toBe('cacheFirst')
    expect(routeRequest(req({ url }), { ...cfg, precache: [] }).action).toBe('networkFirst')
  })
})

describe('routeRequest — path parsing', () => {
  it('ignores the query string when matching a never-cache prefix', () => {
    expect(routeRequest(req({ url: 'https://tapkart.example/healthz?probe=1' }), cfg).action).toBe(
      'networkOnly',
    )
  })

  it('ignores the fragment when matching the precache list', () => {
    expect(routeRequest(req({ url: 'https://tapkart.example/index.html#lobby' }), cfg).action).toBe(
      'cacheFirst',
    )
  })

  it('matches a prefix at the start of the path only, never in the middle', () => {
    expect(routeRequest(req({ url: 'https://tapkart.example/assets/api/thing.js' }), cfg).action).toBe(
      'networkFirst',
    )
  })

  it('treats host-only URLs and opaque blob/data URLs as the root', () => {
    for (const url of [
      'https://tapkart.example',
      'blob:https://tapkart.example/healthz',
      'data:text/html,/healthz',
    ]) {
      expect(routeRequest(req({ url }), cfg), url).toEqual({ action: 'networkFirst', cacheKey: CACHE })
    }
  })

  it('handles a port in the origin', () => {
    expect(routeRequest(req({ url: 'http://127.0.0.1:3031/healthz' }), cfg).action).toBe('networkOnly')
  })

  it('is not fooled by a precache entry appearing inside a longer path', () => {
    expect(routeRequest(req({ url: 'https://tapkart.example/old/index.html' }), cfg).action).toBe(
      'networkFirst',
    )
  })
})

describe('routeRequest — totality', () => {
  it('reaches every one of the five actions', () => {
    const seen = new Set<SwRouteAction>()
    seen.add(routeRequest(req({ url: 'https://tapkart.example/x', method: 'POST' }), cfg).action)
    seen.add(routeRequest(req({ url: 'https://tapkart.example/healthz' }), cfg).action)
    seen.add(routeRequest(req({ url: 'https://tapkart.example/r/ABCDE', isNavigate: true }), cfg).action)
    seen.add(routeRequest(req({ url: 'https://tapkart.example/index.html' }), cfg).action)
    seen.add(routeRequest(req({ url: 'https://tapkart.example/whatever.js' }), cfg).action)
    expect([...seen].sort()).toEqual(
      ['cacheFirst', 'networkFirst', 'networkOnly', 'passthrough', 'shellFallback'].sort(),
    )
  })

  it('never throws for awkward inputs a real fetch handler sees', () => {
    for (const url of ['', '/', 'not a url', 'https://', 'blob:https://tapkart.example/abc', 'data:,x']) {
      expect(() => routeRequest(req({ url }), cfg)).not.toThrow()
    }
  })
})
