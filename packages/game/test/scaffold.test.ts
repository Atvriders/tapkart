import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import * as game from '../src/index'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG = resolve(HERE, '..')
const REPO = resolve(PKG, '..', '..')

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

describe('@tapkart/game workspace scaffold', () => {
  it('runs a TypeScript test from the new workspace', () => {
    expect(2 + 2).toBe(4)
  })

  it('resolves its entry point with extensionless imports', () => {
    expect(typeof game).toBe('object')
    expect(typeof game.renderNowMs).toBe('function')
  })

  it('declares the manifest §10 pins', () => {
    const pkg = readJson(join(PKG, 'package.json'))
    expect(pkg.name).toBe('@tapkart/game')
    expect(pkg.type).toBe('module')
    expect(pkg.private).toBe(true)
    expect(pkg.exports).toEqual({ '.': './src/index.ts', './shell': './src/shell.ts' })
    // Q13: `game` names WireKart the moment RemoteSample carries one, so the
    // protocol dependency is declared now rather than discovered later.
    expect(pkg.dependencies).toEqual({
      '@tapkart/sim': '*',
      '@tapkart/protocol': '*',
      '@tapkart/net': '*',
      '@tapkart/content': '*',
      '@tapkart/render': '*',
      '@tapkart/invite': '*',
    })
    expect((pkg.devDependencies as Record<string, string>).vite).toBe('^7.0.0')
  })

  it('widens the DOM lib in its own tsconfig, and only there (R35)', () => {
    const own = readJson(join(PKG, 'tsconfig.json'))
    expect(own.extends).toBe('../../tsconfig.base.json')
    expect((own.compilerOptions as Record<string, unknown>).lib)
      .toEqual(['ES2022', 'DOM', 'DOM.Iterable'])
    expect(own.include).toEqual(['src/**/*.ts', 'test/**/*.ts'])

    // The failure this catches is not "game does not compile" -- it is someone
    // making game compile by adding DOM to the base, which silently gives `sim`,
    // `protocol`, `net` and `content` a browser dependency. Those four are the
    // packages `server` imports under plain Node.
    const base = readJson(join(REPO, 'tsconfig.base.json'))
    expect((base.compilerOptions as Record<string, unknown>).lib).toEqual(['ES2022'])

    for (const domFree of ['sim', 'protocol', 'net', 'content']) {
      const cfg = readJson(join(REPO, 'packages', domFree, 'tsconfig.json'))
      const opts = (cfg.compilerOptions ?? {}) as Record<string, unknown>
      expect(opts.lib, `packages/${domFree} must not widen lib`).toBeUndefined()
    }
  })

  it('is discovered by the root config without editing it', () => {
    const root = readJson(join(REPO, 'package.json'))
    expect(root.workspaces).toContain('packages/*')
    const vitest = readFileSync(join(REPO, 'vitest.config.ts'), 'utf8')
    expect(vitest).toContain("'packages/*/test/**/*.test.ts'")
    expect(vitest).toContain("environment: 'node'")
    expect(vitest).toContain('globals: false')
  })

  // ADDED (not in the brief). The brief states in prose that none of net's
  // accumulator names is re-exported from clock.ts or index.ts -- "so each has
  // one name and one import path" -- and then asserts nothing about it. A later
  // task that writes `export * from '@tapkart/net'` in this barrel to save a
  // consumer an import line gives TICK_MS two spellings, and the second spelling
  // is the one that survives a refactor of the first.
  it('exports its own clock and re-exports none of net\'s accumulator (one name, one path)', () => {
    const exported = Object.keys(game)
    // Non-vacuity: an empty barrel would satisfy every `not.toContain` below.
    expect(exported.length).toBeGreaterThanOrEqual(4)

    for (const own of ['realFrameClock', 'makeFixedClock', 'accumulatorAlpha', 'renderNowMs']) {
      expect(exported, `@tapkart/game must export ${own}`).toContain(own)
    }
    for (const nets of ['TICK_MS', 'MAX_CATCHUP_TICKS', 'makeTickAccumulator', 'advanceAccumulator']) {
      expect(exported, `@tapkart/game must not re-export ${nets}`).not.toContain(nets)
    }
  })
})
