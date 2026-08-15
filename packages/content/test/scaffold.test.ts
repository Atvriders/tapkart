import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import vitestConfig from '../../../vitest.config'

const REPO_ROOT = new URL('../../../', import.meta.url)

function readJson(relativePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(relativePath, REPO_ROOT), 'utf8')) as Record<string, unknown>
}

/**
 * The `lib` tsc will actually compile this project with, after the whole
 * `extends` chain is resolved. Reading the tsconfig file itself only shows what
 * that one file says; `--showConfig` shows what tsc concludes, which is the
 * thing that decides whether `document` resolves.
 */
function effectiveLib(tsconfigRelativePath: string): string[] {
  const tsc = fileURLToPath(new URL('node_modules/typescript/bin/tsc', REPO_ROOT))
  const shown = execFileSync(process.execPath, [tsc, '--showConfig', '-p', tsconfigRelativePath], {
    cwd: fileURLToPath(REPO_ROOT),
    encoding: 'utf8',
  })
  const config = JSON.parse(shown) as { compilerOptions?: { lib?: string[] } }
  return config.compilerOptions?.lib ?? []
}

/** The four packages `server` (Plan 4) imports. A DOM lib in any of them is how a
 *  server-side package acquires a browser dependency (R35, contract §10.1). */
const DOM_FREE_PACKAGES = ['sim', 'protocol', 'net', 'content'] as const

describe('the root files Plan 3 edits', () => {
  it('registers apps/* as a workspace, so @tapkart/game resolves from apps/web', () => {
    const pkg = readJson('package.json')
    expect(pkg['workspaces']).toEqual(['packages/*', 'apps/*'])
  })

  it('collects apps tests in the vitest include, and changes nothing else', () => {
    const cfg = vitestConfig as unknown as {
      test?: { include?: string[]; environment?: string; globals?: boolean; reporters?: string[] }
    }
    expect(cfg.test?.include).toEqual([
      'packages/*/test/**/*.test.ts',
      'apps/*/test/**/*.test.ts',
    ])
    expect(cfg.test?.environment).toBe('node')
    expect(cfg.test?.globals).toBe(false)
    expect(cfg.test?.reporters).toEqual(['default'])
  })

  it('leaves tsconfig.base.json DOM-free and resolveJsonModule-free', () => {
    const base = readJson('tsconfig.base.json')
    const options = base['compilerOptions'] as Record<string, unknown>
    expect(options['lib']).toEqual(['ES2022'])
    expect(options['resolveJsonModule']).toBeUndefined()
  })
})

describe('packages/content', () => {
  it('ships the manifest contract §10 fixes, depending on sim and nothing else', () => {
    expect(readJson('packages/content/package.json')).toEqual({
      name: '@tapkart/content',
      version: '0.1.0',
      private: true,
      type: 'module',
      exports: { '.': './src/index.ts' },
      dependencies: { '@tapkart/sim': '*' },
      scripts: { typecheck: 'tsc --noEmit -p tsconfig.json' },
    })
  })

  it('has resolveJsonModule and no DOM lib of its own', () => {
    const tsconfig = readJson('packages/content/tsconfig.json')
    expect(tsconfig['extends']).toBe('../../tsconfig.base.json')
    expect(tsconfig['include']).toEqual(['src/**/*.ts', 'test/**/*.ts'])
    const options = tsconfig['compilerOptions'] as Record<string, unknown>
    expect(options['resolveJsonModule']).toBe(true)
    expect(options['lib']).toBeUndefined()
  })

  it('is registered as a workspace member, so @tapkart/sim resolves from it', () => {
    const pkg = readJson('node_modules/@tapkart/content/package.json')
    expect(pkg['name']).toBe('@tapkart/content')
  })
})

describe('the packages Plan 4 server imports stay DOM-free (R35)', () => {
  it.each(DOM_FREE_PACKAGES)('packages/%s/tsconfig.json widens no lib', (name) => {
    const tsconfig = readJson(`packages/${name}/tsconfig.json`)
    const options = (tsconfig['compilerOptions'] ?? {}) as Record<string, unknown>
    expect(options['lib']).toBeUndefined()
    // Reading this file's own `lib` proves nothing on its own: swapping `extends`
    // for a DOM-widening base leaves `lib` undefined here and still hands the
    // package `document`. Pin the chain, then check what tsc actually resolves.
    expect(tsconfig['extends']).toBe('../../tsconfig.base.json')

    const lib = effectiveLib(`packages/${name}/tsconfig.json`)
    // An ABSENT lib is the dangerous case, not the safe one: with no `lib` at
    // all, target ES2022 falls back to lib.es2022.full.d.ts, which INCLUDES DOM.
    // So `expect(no dom entries)` alone would pass most loudly in exactly the
    // scenario it exists to catch. Require entries first.
    expect(lib.length).toBeGreaterThan(0)
    expect(lib.filter((entry) => entry.toLowerCase().startsWith('dom'))).toEqual([])
  })
})
