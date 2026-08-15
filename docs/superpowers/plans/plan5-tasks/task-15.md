### Task 15: the pure PWA layer — the caching policy, and the update and install reducers

**Files:**
- Create: `apps/web/src/pwa/policy.ts` — contract §8.3, PURE
- Create: `apps/web/src/pwa/update.ts` — contract §8.5, PURE
- Create: `apps/web/src/pwa/install.ts` — contract §8.5, PURE
- Test: `apps/web/test/policy.test.ts`
- Test: `apps/web/test/update.test.ts`
- Test: `apps/web/test/install.test.ts`

**Ordering:** independent of the Android half. It needs only `apps/web/`, which Plan 3 created, and the `src/pwa/` directory, which Task 3 created when it wrote `origin.ts`.

**This task does not edit `apps/web/tsconfig.json`.** Plan 3's `include` is `["src/**/*.ts", "vite.config.ts"]`, so all three modules below are typechecked by `tsc -p apps/web/tsconfig.json` as created. §15.2's edit list for that file names exactly two edits — `tools/**/*.ts` in `include` and `src/sw.ts` in `exclude` — and both belong to the service-worker task. `apps/web/test/` is collected by the root `vitest.config.ts` (`apps/*/test/**/*.test.ts`, Plan 3 R37).

**Interfaces:**

- **Consumes** — nothing. All three modules are functions of their arguments, with no import at all. That is not minimalism; it is §8.4's constraint, and it is load-bearing:

  > **`src/pwa/policy.ts` is compiled in both programs**, and therefore **everything `sw.ts` imports must typecheck under both libs** — meaning it must name neither a DOM type nor a WebWorker type. That is not an accident of the layout, it is why P5 Q47 made `SwRequestInfo` a plain struct rather than a `Request`. A task that adds a DOM type to `policy.ts` breaks the worker build, and the error will point at the wrong file; the rule is stated here so it does not have to be discovered there.

  `policy.ts` goes one step further and names **no ambient global either** — it hand-parses the path rather than calling `URL`. `URL` happens to be declared in both `lib.dom.d.ts` and `lib.webworker.d.ts`, so it would compile today, but the module's whole value is that it is provably lib-neutral, and a file that depends on a coincidence of two lib files is one `"types": []` away from an error nobody can read.

- **Produces** — contract §8.3, exactly seven exports from `src/pwa/policy.ts`:

  ```ts
  export interface SwRequestInfo { method: string; url: string; sameOrigin: boolean; isNavigate: boolean }
  export type SwRouteAction = 'passthrough' | 'cacheFirst' | 'networkFirst' | 'networkOnly' | 'shellFallback'
  export interface SwRoute { action: SwRouteAction; cacheKey: string }
  export interface SwConfig {
    cacheName: string
    precache: readonly string[]
    shellPath: string
    neverCachePrefixes: readonly string[]
  }
  export const NEVER_CACHE_PREFIXES: readonly string[]
  export const DEFAULT_SW_CONFIG: Readonly<SwConfig>
  export function routeRequest(info: SwRequestInfo, cfg: SwConfig): SwRoute
  ```

  contract §8.5, exactly four from `src/pwa/update.ts`:

  ```ts
  export interface UpdateState { waiting: boolean; applying: boolean; deferred: boolean }
  export type UpdateEvent =
    | { kind: 'workerWaiting' } | { kind: 'raceStarted' } | { kind: 'raceEnded' }
    | { kind: 'userAccepted' } | { kind: 'userDismissed' }
  export function createUpdateState(): UpdateState
  export function reduceUpdate(prev: UpdateState, ev: UpdateEvent): UpdateState
  ```

  and exactly five from `src/pwa/install.ts`:

  ```ts
  export interface InstallState { available: boolean; installed: boolean; dismissedAtMs: number }
  export type InstallEvent =
    | { kind: 'promptAvailable' } | { kind: 'promptShown' }
    | { kind: 'dismissed'; nowMs: number } | { kind: 'installed' }
  export const INSTALL_DISMISS_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000
  export function createInstallState(): InstallState
  export function reduceInstall(prev: InstallState, ev: InstallEvent): InstallState
  ```

  §16's census fixes those three counts at **7, 4 and 5**. Nothing else is exported from these files.

**The routing table is pinned and ordered, and the order is the whole assertion** (§8.3):

| # | Request | Action |
|---|---|---|
| 1 | method !== `GET` | `passthrough` |
| 2 | cross-origin | `passthrough` |
| 3 | path starts with any of `NEVER_CACHE_PREFIXES` — `/.well-known/`, `/api/`, `/signal`, `/ws`, `/healthz` | `networkOnly` |
| 4 | `isNavigate` | `shellFallback` |
| 5 | path is in `cfg.precache` | `cacheFirst` |
| 6 | any other same-origin GET | `networkFirst` |

*"Rule 3 before rule 4 is load-bearing: `/.well-known/assetlinks.json` fetched by a navigation must never be answered out of the shell cache."* And: *"`/.well-known/` being `networkOnly` is **not** about the Android verifier — that fetch never passes through a page's service worker — it is so a developer never debugs a stale `assetlinks.json` served out of a browser cache."*

A test that asserted one representative request per action would pass with the rules in any order. Every ordering pair below is asserted with a request that **satisfies two rules at once**, so the test fails if the precedence moves.

**Two decisions this task makes, because the contract fixes the signature and not the value:**

1. **`SwRoute.cacheKey` is `cfg.cacheName` for the three actions that touch a cache** (`cacheFirst`, `networkFirst`, `shellFallback`) **and `''` for the two that do not** (`passthrough`, `networkOnly`). One field, one meaning: *"the cache this response may be read from or written to, or nothing."* The alternative — always returning `cacheName` — would let a `networkOnly` branch open a cache without the type objecting, which is the sole-writer rule in §13 (*"the `Cache` storage — the service worker's `install`/`activate`/`fetch` handlers"*) losing its only mechanical support.

2. **`DEFAULT_SW_CONFIG.cacheName` is `'tapkart-dev'` and its `precache` is empty.** The shipped worker never uses either: `tools/build-sw.mjs` injects `__PRECACHE__` and `__SW_VERSION__` at build time (§8.7), and `sw.ts` builds its config from those. The default exists so `routeRequest` is callable from a test, and from a dev server where no build manifest exists, without inventing a cache name at three call sites. `activate` deletes every cache starting with `tapkart-` that is not the current one, so a stray dev cache is collected rather than leaked.

---

- [ ] **Step 1: Write the failing test**

Create `apps/web/test/policy.test.ts`:

```ts
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
      const route = routeRequest(req({ url: `https://tapkart.example${prefix}anything` }), cfg)
      expect(route).toEqual({ action: 'networkOnly', cacheKey: '' })
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

describe('routeRequest — the ORDER, which is what a per-action test would miss', () => {
  /** Rule 1 before rule 4: a POST navigation (a form submission) must not be
   *  answered out of the shell cache. */
  it('a non-GET navigation is passthrough, not shellFallback', () => {
    expect(
      routeRequest(req({ url: 'https://tapkart.example/r/ABCDE', method: 'POST', isNavigate: true }), cfg)
        .action,
    ).toBe('passthrough')
  })

  /** Rule 2 before rule 3: a cross-origin /api/ request is someone else's API,
   *  and this worker must not call respondWith on it at all. */
  it('a cross-origin request under a never-cache prefix is passthrough, not networkOnly', () => {
    expect(
      routeRequest(req({ url: 'https://kart.example.com/api/rooms', sameOrigin: false }), cfg).action,
    ).toBe('passthrough')
  })

  /** Rule 3 before rule 4 — §8.3 names this one explicitly, and §12.2 assertion
   *  9 requires it: "including a /.well-known/ navigation, which must be
   *  networkOnly and not shellFallback". A stale assetlinks.json served out of
   *  the shell cache is a developer's afternoon. */
  it('a NAVIGATION to /.well-known/assetlinks.json is networkOnly, not shellFallback', () => {
    expect(
      routeRequest(
        req({ url: 'https://tapkart.example/.well-known/assetlinks.json', isNavigate: true }),
        cfg,
      ),
    ).toEqual({ action: 'networkOnly', cacheKey: '' })
  })

  /** Rule 4 before rule 5: /index.html IS in the precache list, and a navigation
   *  to it must still take the shell path — the shell path is what a deep link
   *  like /r/ABCDE resolves to, and routing the two differently is how an
   *  offline deep link 404s while the home page works. */
  it('a navigation to a PRECACHED path is shellFallback, not cacheFirst', () => {
    expect(routeRequest(req({ url: 'https://tapkart.example/index.html', isNavigate: true }), cfg).action).toBe(
      'shellFallback',
    )
  })

  /** Rule 5 before rule 6, stated as a pair so a precache lookup that always
   *  missed would not read as "everything is networkFirst, which is fine". */
  it('the same asset is cacheFirst when precached and networkFirst when not', () => {
    const url = 'https://tapkart.example/assets/index-1a2b3c.js'
    expect(routeRequest(req({ url }), cfg).action).toBe('cacheFirst')
    expect(routeRequest(req({ url }), { ...cfg, precache: [] }).action).toBe('networkFirst')
  })
})

describe('routeRequest — path parsing, because the rules are all about paths', () => {
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

  it('treats a URL with no path as the root', () => {
    expect(routeRequest(req({ url: 'https://tapkart.example' }), cfg).action).toBe('networkFirst')
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

  it('never throws, for any of the awkward inputs a real fetch handler sees', () => {
    for (const url of ['', '/', 'not a url', 'https://', 'blob:https://tapkart.example/abc', 'data:,x']) {
      expect(() => routeRequest(req({ url }), cfg)).not.toThrow()
    }
  })
})
```

Create `apps/web/test/update.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { createUpdateState, reduceUpdate, type UpdateEvent, type UpdateState } from '../src/pwa/update'

const ALL_EVENTS: UpdateEvent[] = [
  { kind: 'workerWaiting' },
  { kind: 'raceStarted' },
  { kind: 'raceEnded' },
  { kind: 'userAccepted' },
  { kind: 'userDismissed' },
]

describe('createUpdateState', () => {
  it('starts with nothing waiting, nothing applying and nothing deferred', () => {
    expect(createUpdateState()).toEqual({ waiting: false, applying: false, deferred: false })
  })

  it('returns a fresh object each time', () => {
    expect(createUpdateState()).not.toBe(createUpdateState())
  })
})

describe('reduceUpdate', () => {
  it('never mutates prev', () => {
    for (const ev of ALL_EVENTS) {
      const prev: UpdateState = { waiting: true, applying: false, deferred: false }
      const snapshot = { ...prev }
      reduceUpdate(prev, ev)
      expect(prev).toEqual(snapshot)
    }
  })

  it('workerWaiting marks a worker waiting', () => {
    expect(reduceUpdate(createUpdateState(), { kind: 'workerWaiting' })).toEqual({
      waiting: true,
      applying: false,
      deferred: false,
    })
  })

  /** P5 Q25: "The service worker never activates over a running race.
   *  Auto-skipWaiting would swap the JS bundle under a live authority loop." */
  it('applying becomes true only when a worker is waiting, the user accepted, and no race is in progress', () => {
    const waiting: UpdateState = { waiting: true, applying: false, deferred: false }
    expect(reduceUpdate(waiting, { kind: 'userAccepted' })).toEqual({
      waiting: false,
      applying: true,
      deferred: false,
    })
  })

  it('userAccepted with no worker waiting does nothing at all', () => {
    const idle = createUpdateState()
    expect(reduceUpdate(idle, { kind: 'userAccepted' })).toBe(idle)
  })

  it('userAccepted during a race does nothing at all — the bundle is not swapped under a live race', () => {
    const mid: UpdateState = { waiting: true, applying: false, deferred: true }
    expect(reduceUpdate(mid, { kind: 'userAccepted' })).toBe(mid)
  })

  it('raceStarted defers, and raceEnded un-defers', () => {
    const waiting: UpdateState = { waiting: true, applying: false, deferred: false }
    const racing = reduceUpdate(waiting, { kind: 'raceStarted' })
    expect(racing).toEqual({ waiting: true, applying: false, deferred: true })
    expect(reduceUpdate(racing, { kind: 'raceEnded' })).toEqual({
      waiting: true,
      applying: false,
      deferred: false,
    })
  })

  it('a worker that arrives mid-race is remembered and lands after it', () => {
    let s = createUpdateState()
    s = reduceUpdate(s, { kind: 'raceStarted' })
    s = reduceUpdate(s, { kind: 'workerWaiting' })
    expect(s).toEqual({ waiting: true, applying: false, deferred: true })
    s = reduceUpdate(s, { kind: 'userAccepted' })
    expect(s.applying).toBe(false)
    s = reduceUpdate(s, { kind: 'raceEnded' })
    s = reduceUpdate(s, { kind: 'userAccepted' })
    expect(s).toEqual({ waiting: false, applying: true, deferred: false })
  })

  it('userDismissed keeps the worker waiting but stops it being offered', () => {
    const waiting: UpdateState = { waiting: true, applying: false, deferred: false }
    expect(reduceUpdate(waiting, { kind: 'userDismissed' })).toEqual({
      waiting: true,
      applying: false,
      deferred: true,
    })
  })

  it('a dismissed update is offered again after the next race ends, not before', () => {
    let s: UpdateState = { waiting: true, applying: false, deferred: false }
    s = reduceUpdate(s, { kind: 'userDismissed' })
    expect(s.deferred).toBe(true)
    s = reduceUpdate(s, { kind: 'raceEnded' })
    expect(s.deferred).toBe(false)
  })

  it('once applying, no event un-applies it — the page is already reloading', () => {
    const applying: UpdateState = { waiting: false, applying: true, deferred: false }
    for (const ev of ALL_EVENTS) {
      expect(reduceUpdate(applying, ev).applying).toBe(true)
    }
  })

  it('returns prev BY REFERENCE for every no-op, so a render can compare identity', () => {
    const idle = createUpdateState()
    expect(reduceUpdate(idle, { kind: 'userAccepted' })).toBe(idle)
    expect(reduceUpdate(idle, { kind: 'userDismissed' })).toBe(idle)
    expect(reduceUpdate(idle, { kind: 'raceEnded' })).toBe(idle)
  })
})
```

Create `apps/web/test/install.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  createInstallState,
  INSTALL_DISMISS_COOLDOWN_MS,
  reduceInstall,
  type InstallEvent,
  type InstallState,
} from '../src/pwa/install'

const ALL_EVENTS: InstallEvent[] = [
  { kind: 'promptAvailable' },
  { kind: 'promptShown' },
  { kind: 'dismissed', nowMs: 1_000 },
  { kind: 'installed' },
]

describe('INSTALL_DISMISS_COOLDOWN_MS', () => {
  it('is seven days, in milliseconds', () => {
    expect(INSTALL_DISMISS_COOLDOWN_MS).toBe(7 * 24 * 60 * 60 * 1000)
    expect(INSTALL_DISMISS_COOLDOWN_MS).toBe(604_800_000)
  })
})

describe('createInstallState', () => {
  it('starts unavailable, uninstalled and never dismissed', () => {
    expect(createInstallState()).toEqual({ available: false, installed: false, dismissedAtMs: 0 })
  })
})

describe('reduceInstall', () => {
  it('never mutates prev', () => {
    for (const ev of ALL_EVENTS) {
      const prev: InstallState = { available: true, installed: false, dismissedAtMs: 5 }
      const snapshot = { ...prev }
      reduceInstall(prev, ev)
      expect(prev).toEqual(snapshot)
    }
  })

  it('promptAvailable makes the prompt available', () => {
    expect(reduceInstall(createInstallState(), { kind: 'promptAvailable' })).toEqual({
      available: true,
      installed: false,
      dismissedAtMs: 0,
    })
  })

  /** The captured `beforeinstallprompt` event can be prompt()ed exactly once, so
   *  showing it consumes it. A state that stayed `available` would let a second
   *  tap call a spent event and do nothing, visibly. */
  it('promptShown consumes availability', () => {
    const avail: InstallState = { available: true, installed: false, dismissedAtMs: 0 }
    expect(reduceInstall(avail, { kind: 'promptShown' })).toEqual({
      available: false,
      installed: false,
      dismissedAtMs: 0,
    })
  })

  it('dismissed records when, and stops offering', () => {
    const avail: InstallState = { available: true, installed: false, dismissedAtMs: 0 }
    expect(reduceInstall(avail, { kind: 'dismissed', nowMs: 1_700_000_000_000 })).toEqual({
      available: false,
      installed: false,
      dismissedAtMs: 1_700_000_000_000,
    })
  })

  it('installed is terminal: nothing makes it available again', () => {
    let s = reduceInstall(createInstallState(), { kind: 'installed' })
    expect(s).toEqual({ available: false, installed: true, dismissedAtMs: 0 })
    for (const ev of ALL_EVENTS) {
      s = reduceInstall(s, ev)
      expect(s.installed).toBe(true)
      expect(s.available).toBe(false)
    }
  })

  it('promptAvailable on an installed app is a no-op, by reference', () => {
    const installed: InstallState = { available: false, installed: true, dismissedAtMs: 0 }
    expect(reduceInstall(installed, { kind: 'promptAvailable' })).toBe(installed)
  })

  it('a later dismissal overwrites an earlier one, so the cooldown runs from the last', () => {
    let s: InstallState = { available: true, installed: false, dismissedAtMs: 100 }
    s = reduceInstall(s, { kind: 'dismissed', nowMs: 200 })
    expect(s.dismissedAtMs).toBe(200)
  })

  /** The cooldown is applied by the CALLER — §16's census fixes this module at
   *  five exports and there is no `canPrompt`. This test pins the arithmetic the
   *  caller performs, so the constant cannot quietly stop meaning what it says. */
  it('supports the caller predicate: available, not installed, and past the cooldown', () => {
    const dismissedAt = 1_000_000
    const s: InstallState = { available: true, installed: false, dismissedAtMs: dismissedAt }
    const canPrompt = (st: InstallState, nowMs: number) =>
      st.available && !st.installed && nowMs - st.dismissedAtMs >= INSTALL_DISMISS_COOLDOWN_MS
    expect(canPrompt(s, dismissedAt + INSTALL_DISMISS_COOLDOWN_MS - 1)).toBe(false)
    expect(canPrompt(s, dismissedAt + INSTALL_DISMISS_COOLDOWN_MS)).toBe(true)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run apps/web/test/policy.test.ts apps/web/test/update.test.ts apps/web/test/install.test.ts`

Expected: **FAIL at collect time**, three times, because none of the three modules exists:

```
Error: Failed to resolve import "../src/pwa/policy" from "apps/web/test/policy.test.ts". Does the file exist?
Error: Failed to resolve import "../src/pwa/update" from "apps/web/test/update.test.ts". Does the file exist?
Error: Failed to resolve import "../src/pwa/install" from "apps/web/test/install.test.ts". Does the file exist?
```

- [ ] **Step 3: Write the implementation**

Create `apps/web/src/pwa/policy.ts`:

```ts
// PURE. Contract §8.3, and the sole decider of every caching decision in the app.
//
// This module is compiled in BOTH of §8.4's TypeScript programs — the app's
// (lib: ES2022, DOM, DOM.Iterable) and the worker's (lib: ES2022, WebWorker,
// types: []). It therefore names no DOM type, no WebWorker type and no ambient
// global at all. P5 Q47 is why `SwRequestInfo` is a plain struct rather than a
// `Request`: the pure layer never names `Request`, so these tests need no DOM
// and no jsdom (Plan 3 ruling Q30).

/** A plain struct, deliberately (P5 Q47). `sw.ts` converts a real `Request` into
 *  one of these and nothing else in the worker branches. */
export interface SwRequestInfo {
  method: string
  /** Absolute. */
  url: string
  sameOrigin: boolean
  isNavigate: boolean
}

export type SwRouteAction =
  | 'passthrough' // not ours: do not call respondWith at all
  | 'cacheFirst' // precached, content-hashed, immutable
  | 'networkFirst' // fall back to cache
  | 'networkOnly' // never cache, never serve stale
  | 'shellFallback' // navigation: network, else the cached shell

/** `cacheKey` is the cache this response may be read from or written to, and it
 *  is '' for the two actions that must never touch one. §13 makes the Cache
 *  storage the worker handlers' alone; this is the part of that a type can
 *  carry. */
export interface SwRoute {
  action: SwRouteAction
  cacheKey: string
}

export interface SwConfig {
  /** `tapkart-${version}`. */
  cacheName: string
  /** Absolute paths, from the build manifest. */
  precache: readonly string[]
  shellPath: string
  neverCachePrefixes: readonly string[]
}

/** §8.3 rule 3. `/.well-known/` is here so a developer never debugs a stale
 *  assetlinks.json served out of a browser cache — the Android verifier's own
 *  fetch never passes through a page's service worker at all. */
export const NEVER_CACHE_PREFIXES: readonly string[] = [
  '/.well-known/',
  '/api/',
  '/signal',
  '/ws',
  '/healthz',
]

/** The shipped worker overrides `cacheName` and `precache` from the build's
 *  `__SW_VERSION__` and `__PRECACHE__` defines (§8.7). This exists so the policy
 *  is callable without a build manifest, and its cache name stays inside the
 *  `tapkart-` family that `activate` collects. */
export const DEFAULT_SW_CONFIG: Readonly<SwConfig> = {
  cacheName: 'tapkart-dev',
  precache: [],
  shellPath: '/index.html',
  neverCachePrefixes: NEVER_CACHE_PREFIXES,
}

/** The path of an absolute URL, without its query or fragment.
 *
 *  Hand-parsed, and not with `URL`: this module is compiled under two different
 *  `lib` settings and must depend on no ambient global. Anything that is not an
 *  absolute `scheme://host/path` — a blob: URL, a data: URL, an empty string —
 *  yields '/' and therefore takes the same route as the root, which is
 *  `networkFirst`. That is the safe answer for an input the policy does not
 *  recognise: it never serves such a thing from a cache. */
function pathOf(url: string): string {
  let rest = url
  const scheme = rest.indexOf('://')
  if (scheme >= 0) {
    rest = rest.slice(scheme + 3)
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

/** Total. Sole decider of every caching decision in the app. The six rules are
 *  evaluated in §8.3's order and the order is normative:
 *
 *  Rule 3 before rule 4 is load-bearing — `/.well-known/assetlinks.json` fetched
 *  by a navigation must never be answered out of the shell cache.
 *  Rule 4 before rule 5 is load-bearing too — `/index.html` is in the precache
 *  list AND is the shell, and a deep link like `/r/ABCDE` must resolve to it the
 *  same way the root does. */
export function routeRequest(info: SwRequestInfo, cfg: SwConfig): SwRoute {
  // 1. Not a GET: not ours.
  if (info.method !== 'GET') return { action: 'passthrough', cacheKey: '' }

  // 2. Cross-origin: not ours.
  if (!info.sameOrigin) return { action: 'passthrough', cacheKey: '' }

  const path = pathOf(info.url)

  // 3. Never cached, never stale.
  for (const prefix of cfg.neverCachePrefixes) {
    if (path.startsWith(prefix)) return { action: 'networkOnly', cacheKey: '' }
  }

  // 4. A navigation gets the shell.
  if (info.isNavigate) return { action: 'shellFallback', cacheKey: cfg.cacheName }

  // 5. Precached: content-hashed and immutable.
  for (const entry of cfg.precache) {
    if (entry === path) return { action: 'cacheFirst', cacheKey: cfg.cacheName }
  }

  // 6. Anything else same-origin.
  return { action: 'networkFirst', cacheKey: cfg.cacheName }
}
```

Create `apps/web/src/pwa/update.ts`:

```ts
// PURE. Contract §8.5.
//
// P5 Q25: "The service worker never activates over a running race.
// Auto-skipWaiting would swap the JS bundle under a live authority loop; the
// update lands when the player is on the results or title screen, or on the next
// cold load."

export interface UpdateState {
  /** A new worker is installed and waiting. */
  waiting: boolean
  /** The page is about to send SKIP_WAITING and reload. Terminal. */
  applying: boolean
  /** The update must not be OFFERED right now: a race is running, or the player
   *  said not yet. */
  deferred: boolean
}

export type UpdateEvent =
  | { kind: 'workerWaiting' }
  | { kind: 'raceStarted' }
  | { kind: 'raceEnded' }
  | { kind: 'userAccepted' }
  | { kind: 'userDismissed' }

export function createUpdateState(): UpdateState {
  return { waiting: false, applying: false, deferred: false }
}

/** Pure; never mutates `prev`. `applying` becomes true only when a worker is
 *  waiting, the user accepted, and no race is in progress.
 *
 *  Every event that is not legal for the current state returns `prev` BY
 *  REFERENCE, so the shell can skip a re-render on identity — the same
 *  convention Plan 3's `reduceApp` uses (§5.9).
 *
 *  The caller offers the update when `waiting && !applying && !deferred`. That
 *  predicate is one expression at one call site, so it is not a sixth export
 *  that could drift from these three fields. */
export function reduceUpdate(prev: UpdateState, ev: UpdateEvent): UpdateState {
  if (prev.applying) return prev // terminal: the page is already reloading

  switch (ev.kind) {
    case 'workerWaiting':
      return prev.waiting ? prev : { ...prev, waiting: true }

    case 'raceStarted':
      return prev.deferred ? prev : { ...prev, deferred: true }

    case 'raceEnded':
      return prev.deferred ? { ...prev, deferred: false } : prev

    case 'userAccepted':
      // Not waiting: nothing to apply. Deferred: the prompt is not shown during
      // a race, so this cannot legitimately happen — and swallowing it keeps
      // `applying` meaning exactly "the page is about to reload", with no third
      // state meaning "will apply later".
      if (!prev.waiting || prev.deferred) return prev
      return { waiting: false, applying: true, deferred: false }

    case 'userDismissed':
      // The worker stays waiting — it is installed and cannot be un-installed.
      // What changes is that it stops being offered until the next raceEnded.
      if (!prev.waiting || prev.deferred) return prev
      return { ...prev, deferred: true }
  }
}
```

Create `apps/web/src/pwa/install.ts`:

```ts
// PURE. Contract §8.5.
//
// `beforeinstallprompt` capture, `prompt()` and `appinstalled` live in
// apps/web/src/main.ts (adapter). iOS has no `beforeinstallprompt` at all;
// `available` simply stays false there and no instructional UI ships in v1.

export interface InstallState {
  /** A captured, un-spent `beforeinstallprompt` event is in hand. */
  available: boolean
  installed: boolean
  /** When the player last said no. Persisted by the shell, so the cooldown
   *  survives a reload. */
  dismissedAtMs: number
}

export type InstallEvent =
  | { kind: 'promptAvailable' }
  | { kind: 'promptShown' }
  | { kind: 'dismissed'; nowMs: number }
  | { kind: 'installed' }

export const INSTALL_DISMISS_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000

export function createInstallState(): InstallState {
  return { available: false, installed: false, dismissedAtMs: 0 }
}

/** Pure; never mutates `prev`, and returns `prev` by reference for a no-op.
 *
 *  The caller offers installation when
 *  `state.available && !state.installed && nowMs - state.dismissedAtMs >= INSTALL_DISMISS_COOLDOWN_MS`. */
export function reduceInstall(prev: InstallState, ev: InstallEvent): InstallState {
  if (prev.installed) return prev // terminal

  switch (ev.kind) {
    case 'promptAvailable':
      return prev.available ? prev : { ...prev, available: true }

    case 'promptShown':
      // The captured event can be prompt()ed exactly once, so showing spends it.
      return prev.available ? { ...prev, available: false } : prev

    case 'dismissed':
      return { ...prev, available: false, dismissedAtMs: ev.nowMs }

    case 'installed':
      return { available: false, installed: true, dismissedAtMs: prev.dismissedAtMs }
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run apps/web/test/policy.test.ts apps/web/test/update.test.ts apps/web/test/install.test.ts
npx tsc --noEmit -p apps/web/tsconfig.json
npx vitest run
```

Expected: **20 passed** in `policy.test.ts` (1 + 3 + 6 + 5 + 6 rows across the parsing block, plus the two totality tests), **13 passed** in `update.test.ts`, **10 passed** in `install.test.ts`; no typecheck output; and no new failures anywhere in the full run.

Then prove the ordering assertions are not decorative, because a rule table that has never been reordered is a rule table nobody has tested. Temporarily move the `isNavigate` check above the never-cache loop in `routeRequest` and re-run:

Expected: **1 failed** — `a NAVIGATION to /.well-known/assetlinks.json is networkOnly, not shellFallback`, and nothing else, which is precisely the row §12.2 assertion 9 names. Put it back and confirm green.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pwa/policy.ts apps/web/src/pwa/update.ts apps/web/src/pwa/install.ts apps/web/test/policy.test.ts apps/web/test/update.test.ts apps/web/test/install.test.ts && git commit -m "feat(web): the caching policy and the update/install reducers, all pure (§8.3, §8.5)"
```
