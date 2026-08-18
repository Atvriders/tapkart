import { describe, expect, it } from 'vitest'
import * as barrel from '../src/index'

/** Every module the barrel re-exports, as static importers -- a template-literal
 *  dynamic import would resolve at runtime and hide a typo as a rejected
 *  promise. */
const MODULES: Readonly<Record<string, () => Promise<Record<string, unknown>>>> = {
  types: () => import('../src/types'),
  env: () => import('../src/env'),
  random: () => import('../src/random'),
  registry: () => import('../src/registry'),
  lobby: () => import('../src/lobby'),
  roomtransport: () => import('../src/roomtransport'),
  hub: () => import('../src/hub'),
  race: () => import('../src/race'),
  content: () => import('../src/content'),
  static: () => import('../src/static'),
  log: () => import('../src/log'),
  ratelimit: () => import('../src/ratelimit'),
}

describe('the @tapkart/server barrel', () => {
  it('re-exports twelve modules and no two of them export the same name', async () => {
    // `export *` silently EXCLUDES an ambiguous name at runtime rather than
    // failing, so a collision would delete a symbol from the package surface
    // with no error. (tsc catches the type half; this catches the value half.)
    const owner = new Map<string, string>()
    for (const [name, load] of Object.entries(MODULES)) {
      const mod = await load()
      for (const key of Object.keys(mod)) {
        const prior = owner.get(key)
        expect(prior, key + ' is exported by both ' + String(prior) + ' and ' + name).toBeUndefined()
        owner.set(key, name)
      }
    }
    expect(Object.keys(MODULES)).toHaveLength(12)
    expect(owner.size).toBeGreaterThan(30)          // the floor
  })

  it('exports every runtime value those modules export', async () => {
    for (const [, load] of Object.entries(MODULES)) {
      const mod = await load()
      for (const key of Object.keys(mod)) {
        expect(Object.hasOwn(barrel, key), key + ' is missing from the barrel').toBe(true)
      }
    }
  })

  it('reaches nothing under src/runtime and not main', () => {
    // §0's barrel rule, the same discipline Plan 3 §8.2 uses for the identical
    // reason: a headless import of @tapkart/server must never pull in node:fs,
    // node:http, node:crypto or `ws`.
    for (const forbidden of [
      'main', 'realNowMs', 'makeIntervalScheduler', 'POLL_INTERVAL_MS',
      'nodeRandomSource', 'readFileBytes', 'fileExists', 'wrapWsSocket', 'startHttpServer',
    ]) {
      expect(Object.hasOwn(barrel, forbidden), forbidden + ' leaked into the barrel').toBe(false)
    }
  })
})
