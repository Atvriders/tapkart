import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * `three` is the repository's second runtime dependency and Q10 pins it at EXACTLY
 * 0.180.0 — no caret, no tilde, no range. A caret is the failure this file exists to
 * catch: `^0.180.0` silently floats across three's monthly breaking-change releases,
 * and the break would land in `src/three/renderer.ts` on somebody else's machine
 * months from now, as a renderer that stopped drawing.
 *
 * `three@0.180.0` ships NO type declarations of its own — no `types` field, no `types`
 * export condition, no `.d.ts` under `build/` — so `@types/three` is a real dependency
 * and not a nicety, and it is pinned to the same version because a DefinitelyTyped
 * package for a different three release describes a different API.
 */
const MANIFEST_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json')

interface Manifest {
  name: string
  exports: Record<string, string>
  dependencies: Record<string, string>
  devDependencies?: Record<string, string>
}

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as Manifest

describe('@tapkart/render package.json', () => {
  it('pins three at exactly 0.180.0, caret-free (Q10)', () => {
    expect(manifest.dependencies.three).toBe('0.180.0')
  })

  it('pins @types/three at the same exact version, as a devDependency', () => {
    expect(manifest.devDependencies?.['@types/three']).toBe('0.180.0')
    // types are a build-time concern: shipping them as a runtime dep would put a
    // declaration-only package into the app's dependency graph.
    expect(manifest.dependencies['@types/three']).toBeUndefined()
    expect(manifest.devDependencies?.three).toBeUndefined()
  })

  it('exports the barrel and the three adapter subpath, and nothing else', () => {
    expect(Object.keys(manifest.exports).sort()).toEqual(['.', './three'])
    expect(manifest.exports['.']).toBe('./src/index.ts')
    expect(manifest.exports['./three']).toBe('./src/three/renderer.ts')
  })

  it('depends on sim and content by workspace wildcard', () => {
    expect(manifest.dependencies['@tapkart/sim']).toBe('*')
    expect(manifest.dependencies['@tapkart/content']).toBe('*')
  })
})
