import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import * as render from '../src/index'
import * as audio from '../src/audio'
import * as audioGraph from '../src/audio/graph'
import * as backend from '../src/backend'
import * as camera from '../src/camera'
import * as descriptors from '../src/descriptors'
import * as frame from '../src/frame'
import * as hud from '../src/hud'
import * as mesh from '../src/mesh'
import * as smoothing from '../src/smoothing'
import * as types from '../src/types'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG = resolve(HERE, '..')
const SRC = join(PKG, 'src')
const REPO = resolve(PKG, '..', '..')

/** Plan 3 §4.11's top-level modules. Adapter directories stay absent. */
const TOP_LEVEL_MODULES = [
  'types', 'mesh', 'descriptors', 'camera', 'frame', 'hud', 'audio', 'smoothing', 'backend',
] as const

/** Plan 5 §9 adds the nested pure graph; neither adapter enters the barrel. */
const BARREL_MODULES = [...TOP_LEVEL_MODULES, 'audio/graph'] as const

const NAMESPACES: [string, object][] = [
  ['types', types], ['mesh', mesh], ['descriptors', descriptors], ['camera', camera],
  ['frame', frame], ['hud', hud], ['audio', audio], ['audio/graph', audioGraph],
  ['smoothing', smoothing], ['backend', backend],
]

/**
 * An import of `three` in any of its three forms — static, dynamic, CJS — and any
 * subpath of it. The forms are NOT spelled out literally in this comment: this
 * regex is run over every test file in the repository including this one, and a
 * doc comment that quoted them would make this file report itself.
 */
const THREE_SPECIFIER =
  /(?:from\s*|import\s*\(\s*|require\s*\(\s*)['"]three(?:\/[^'"]*)?['"]/

const RELATIVE_SPECIFIER = /(?:from\s*|import\s*\(\s*)['"](\.[^'"]*)['"]/g

function tsFilesUnder(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...tsFilesUnder(full))
    else if (entry.endsWith('.ts')) out.push(full)
  }
  return out
}

function resolveRelative(fromFile: string, spec: string): string | null {
  const base = resolve(dirname(fromFile), spec)
  if (existsSync(`${base}.ts`)) return `${base}.ts`
  if (existsSync(join(base, 'index.ts'))) return join(base, 'index.ts')
  return null
}

/** Every file reachable from `entry` by following relative imports. */
function moduleGraph(entry: string): string[] {
  const seen = new Set<string>()
  const queue = [entry]
  while (queue.length > 0) {
    const file = queue.pop() as string
    if (seen.has(file)) continue
    seen.add(file)
    const text = readFileSync(file, 'utf8')
    for (const match of text.matchAll(RELATIVE_SPECIFIER)) {
      const target = resolveRelative(file, match[1])
      if (target !== null) queue.push(target)
    }
  }
  return [...seen]
}

describe('@tapkart/render barrel', () => {
  it('re-exports the nine Plan 3 modules and Plan 5 audio graph, each once', () => {
    const text = readFileSync(join(SRC, 'index.ts'), 'utf8')
    for (const name of BARREL_MODULES) {
      const line = `export * from './${name}'`
      expect(text, `barrel is missing ${line}`).toContain(line)
      expect(text.split(line).length - 1, `${line} appears more than once`).toBe(1)
    }

    const exported = [...text.matchAll(/export \* from '\.\/([^']+)'/g)].map((m) => m[1])
    expect(exported.sort()).toEqual([...BARREL_MODULES].sort())
  })

  it('lists every top-level module in src/ and treats src/three as not a module', () => {
    const onDisk = readdirSync(SRC)
      .filter((f) => f.endsWith('.ts') && f !== 'index.ts')
      .map((f) => f.slice(0, -3))
      .sort()
    expect(onDisk).toEqual([...TOP_LEVEL_MODULES].sort())

    // The adapter lives in its own directory precisely so it is never one of the
    // files the rule above sweeps up.
    expect(statSync(join(SRC, 'three')).isDirectory()).toBe(true)
    expect(existsSync(join(SRC, 'three', 'renderer.ts'))).toBe(true)
  })

  it('does not re-export either browser adapter', () => {
    expect(Object.prototype.hasOwnProperty.call(render, 'createThreeRenderer')).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(render, 'DEFAULT_THREE_OPTIONS')).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(render, 'createWebAudioBackend')).toBe(false)
    // Statements, not prose: the barrel's comment explains why `three` is absent,
    // so a bare substring check would fail on its own documentation.
    const text = readFileSync(join(SRC, 'index.ts'), 'utf8')
    expect(text).not.toMatch(/export \* from '\.\/three/)
    expect(text).not.toMatch(/export \* from '\.\/audio\/web'/)
    expect(THREE_SPECIFIER.test(text)).toBe(false)
  })

  it('never reaches src/three or `three` from the barrel, transitively', () => {
    // The whole "rendering is testable headlessly" claim is this assertion: if
    // the barrel's module graph ever touched the adapter, `import { buildRenderFrame }
    // from '@tapkart/render'` would drag three -- and a WebGL context -- into
    // every vitest run in the repository, and it would surface as an unrelated
    // suite breaking.
    const graph = moduleGraph(join(SRC, 'index.ts'))
    expect(graph.length).toBeGreaterThan(BARREL_MODULES.length)   // the scan really walked
    for (const file of graph) {
      const rel = relative(PKG, file)
      expect(relative(SRC, file).startsWith('three'), `${rel} is the adapter`).toBe(false)
      expect(relative(SRC, file), `${rel} is the audio adapter`).not.toBe('audio/web.ts')
      expect(THREE_SPECIFIER.test(readFileSync(file, 'utf8')), `${rel} imports three`).toBe(false)
    }
  })

  it('confines every `three` import to src/three/, including type-only ones', () => {
    // `verbatimModuleSyntax` does not save this: `import type { Scene } from
    // 'three'` outside src/three/ is one refactor away from becoming a value
    // import, so it is banned outright (§8.2).
    for (const file of tsFilesUnder(SRC)) {
      if (relative(SRC, file).startsWith('three')) continue
      const importsThree = THREE_SPECIFIER.test(readFileSync(file, 'utf8'))
      expect(importsThree, `${relative(PKG, file)} must not import three`).toBe(false)
    }
    // ...and the one file that may, does — otherwise the sweep above proves
    // nothing but that the adapter was deleted.
    expect(THREE_SPECIFIER.test(readFileSync(join(SRC, 'three', 'renderer.ts'), 'utf8'))).toBe(true)
  })

  it('keeps `three` out of every test file in the repository', () => {
    // §8.2: "CI never imports any of them." A test that imported the adapter --
    // in any package -- would need a GPU, which is out of scope for Plan 3 (§8.3).
    const packagesDir = join(REPO, 'packages')
    const roots = readdirSync(packagesDir)
      .map((p) => join(packagesDir, p, 'test'))
      .filter((p) => existsSync(p))
    if (existsSync(join(REPO, 'apps'))) {
      for (const app of readdirSync(join(REPO, 'apps'))) {
        const dir = join(REPO, 'apps', app, 'test')
        if (existsSync(dir)) roots.push(dir)
      }
    }
    expect(roots.length).toBeGreaterThan(0)

    // Assembled rather than written literally, so this file does not report
    // itself: a needle spelled out here would appear in every text it scans.
    const adapterSubpath = ['@tapkart', 'render', 'three'].join('/')
    const adapterPath = ['src', 'three', ''].join('/')

    // Matched as an import SPECIFIER, not as a substring. A substring sweep is
    // wrong here and provably so: manifest.test.ts asserts the value of the
    // package's "./three" exports entry, which is that path, and is not an import
    // of anything. The ban is on importing the adapter, so that is what is matched.
    const ADAPTER_SPECIFIER = new RegExp(
      `(?:from\\s*|import\\s*\\(\\s*|require\\s*\\(\\s*)['"][^'"]*` +
        `(?:${adapterSubpath}|${adapterPath})`,
    )

    // Positive controls. Without these the whole sweep passes vacuously the day
    // either pattern is mistyped, and it would pass while reporting nothing --
    // this project's signature defect. Spelled at runtime so the needles never
    // appear literally in a file this test reads.
    const bareThree = ['t', 'h', 'r', 'e', 'e'].join('')
    expect(THREE_SPECIFIER.test(`import * as x from '${bareThree}'`)).toBe(true)
    expect(THREE_SPECIFIER.test(`const x = require('${bareThree}/webgpu')`)).toBe(true)
    expect(ADAPTER_SPECIFIER.test(`import { c } from '../${adapterPath}renderer'`)).toBe(true)
    expect(ADAPTER_SPECIFIER.test(`import { c } from '${adapterSubpath}'`)).toBe(true)
    expect(ADAPTER_SPECIFIER.test(`await import('${adapterSubpath}')`)).toBe(true)
    // ...and the negative control that forced the specifier form: asserting the
    // path as a value is not importing it.
    expect(ADAPTER_SPECIFIER.test(`expect(m.exports).toBe('./${adapterPath}renderer.ts')`))
      .toBe(false)

    let scanned = 0
    for (const root of roots) {
      for (const file of tsFilesUnder(root)) {
        const text = readFileSync(file, 'utf8')
        const rel = relative(REPO, file)
        expect(THREE_SPECIFIER.test(text), `${rel} imports three`).toBe(false)
        expect(ADAPTER_SPECIFIER.test(text), `${rel} imports the adapter`).toBe(false)
        scanned++
      }
    }
    // The sweep found files to sweep -- `roots.length > 0` alone would pass on a
    // repository of empty test directories.
    expect(scanned).toBeGreaterThan(BARREL_MODULES.length)
  })

  it('has no ambiguous re-export, and forwards every runtime export', () => {
    const owners = new Map<string, string[]>()
    for (const [mod, ns] of NAMESPACES) {
      for (const key of Object.keys(ns)) {
        const list = owners.get(key) ?? []
        list.push(mod)
        owners.set(key, list)
      }
    }
    // An ambiguous name is silently dropped from an ESM namespace and becomes a
    // SyntaxError at the import site, so it must not exist in the first place.
    expect(Array.from(owners.entries()).filter(([, mods]) => mods.length > 1)).toEqual([])

    for (const [mod, ns] of NAMESPACES) {
      for (const key of Object.keys(ns)) {
        expect(
          Object.prototype.hasOwnProperty.call(render, key),
          `${mod}.${key} is not reachable through the barrel`,
        ).toBe(true)
      }
    }
  })

  it('reaches Task 15\'s smoothing through the barrel', () => {
    expect(render.advanceVisualOffset).toBe(smoothing.advanceVisualOffset)
    expect(render.ERROR_SMOOTH_WINDOW_TICKS).toBe(12)
  })
})

describe('packages/render/package.json', () => {
  const pkg = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8')) as {
    name: string
    exports: Record<string, string>
    dependencies: Record<string, string>
    devDependencies?: Record<string, string>
  }

  it('pins three exactly, with no caret (Q10)', () => {
    expect(pkg.dependencies.three).toBe('0.180.0')
  })

  it('keeps the adapter reachable to the app and out of the barrel', () => {
    expect(pkg.name).toBe('@tapkart/render')
    expect(pkg.exports['.']).toBe('./src/index.ts')
    expect(pkg.exports['./three']).toBe('./src/three/renderer.ts')
    expect(pkg.exports['./web-audio']).toBe('./src/audio/web.ts')
    expect(Object.prototype.hasOwnProperty.call(render, 'createWebAudioBackend')).toBe(false)
  })

  it('declares the type declarations three does not ship', () => {
    // three@0.180.0 has no `types` field, no `types` condition in its exports
    // map and no .d.ts in build/, so tsc cannot typecheck the adapter without
    // this. §4.10 makes it this task's call and this task's report.
    expect(pkg.devDependencies?.['@types/three']).toBe('0.180.0')
  })
})
