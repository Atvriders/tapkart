### Task 15: `src/backend.ts`, `src/three/renderer.ts` and the `render` barrel — the seam and the adapter

This task draws the line that the rest of `packages/render` is testable on the
wrong side of. `backend.ts` is an interface file that imports nothing but sibling
types, so a mock backend is a plain object literal and spec §8's "scene-graph
assertions against a mocked renderer" are made against `applyFrame`'s argument,
under `environment: 'node'`, with no canvas and no GPU. `three/renderer.ts` is the
**only** module in the repository that imports `three` and the only thing that
touches a Three.js scene graph (§7.2) — and the barrel deliberately does not
re-export it.

**That omission is load-bearing, not tidiness.** A barrel that re-exported
`three/renderer.ts` would pull `three` — and, transitively, a WebGL context — into
every headless test in the repository the moment anything imported
`@tapkart/render`, and the failure would surface as an unrelated suite breaking.
`verbatimModuleSyntax` does **not** save this: a value import of `three` survives
erasure. Even `import type { Scene } from 'three'` is banned outside `src/three/`
so a later refactor cannot quietly turn it into a value import. This task's barrel
test enforces both bans mechanically, over the transitive module graph, rather
than trusting the rule.

**Q10: Three.js is mandated and pinned at exactly `three@0.180.0`** — not a caret
range, not a hand-rolled WebGL renderer, and **there is no Canvas2D fallback
backend.** Spec §3 says "Three.js scene" and the spec is the binding authority.
The `RendererBackend` seam exists for **headless testability** (§8.2), not device
fallback: every device that can run this game has WebGL, and a second renderer is
a second thing to keep correct for no user.

**Verified before authoring: `three@0.180.0` ships no type declarations.** Its
published `package.json` has no `types`/`typings` field and no `types` condition
in its `exports` map, and its `build/` directory contains no `.d.ts` files
(checked against the registry tarball). §4.10 gives this task the decision and the
duty to report it: **`"@types/three": "0.180.0"` goes in `packages/render`'s
`devDependencies`**, and no other task touches it, so two tasks cannot disagree.

**Files:**
- Create: `packages/render/src/backend.ts`
- Create: `packages/render/src/three/renderer.ts`
- Modify: `packages/render/src/index.ts` — **replace the whole contents** with the
  §4.11 nine-module barrel below. The scaffold task created it and three later
  tasks appended one line each; that nine-module list is the contract's, so no
  earlier task's line is lost. It is a `Modify` and not a `Create` on purpose: an
  implementer who reads `Create` reaches for `Write`, and gets the right answer
  here only because the list happens to be a superset.
- Modify: `packages/render/package.json` — **replace the whole contents** with the
  literal in Step 3b. Diffed against the scaffold task's literal the only change is
  `+ "devDependencies": { "@types/three": "0.180.0" }`, alongside `dependencies.three`
  pinned exactly and the `"./three"` export entry, both of which that task already
  wrote. Stated as a whole-file replacement because that is what Step 3b does.
- Modify: `package-lock.json` — `npm install` side effect (Step 3b), declared
  because five tasks in this plan rewrite it
- Test: `packages/render/test/backend.test.ts`
- Test: `packages/render/test/barrel.test.ts`

**Interfaces:**

- Consumes:
  - `@tapkart/sim` [Plan 1, shipped]:
    ```ts
    export const MAX_KARTS = 8
    export const MAX_ENTITIES = 32
    export type Vec3 = { x: number; y: number; z: number }
    export type EntityKind = 'seeker' | 'bolt' | 'slick' | 'bubble' | 'surge' | 'charge'
    ```
  - `@tapkart/content` [§3a.3, §3a.4]:
    ```ts
    export type PaletteRGB = readonly [number, number, number]   // linear, 0..1
    export interface EdgeMarkerParams {
      spacing: number; height: number; offset: number
      colors: readonly [PaletteRGB, PaletteRGB]                  // alternating, colorIdx 0 and 1
    }
    export interface TrackTheme {
      trackId: string
      road: PaletteRGB; roadDirt: PaletteRGB; shoulder: PaletteRGB; wall: PaletteRGB
      ground: PaletteRGB
      sky: { top: PaletteRGB; bottom: PaletteRGB }
      fog: { color: PaletteRGB; near: number; far: number }      // metres; near < far
      sunDirection: Vec3                                         // normalised
      ambient: number                                            // 0..1
      edgeMarkers: EdgeMarkerParams
    }
    export const DEFAULT_TRACK_THEME: Readonly<TrackTheme>
    ```
  - `packages/render/src/mesh.ts` [§4.3, an earlier task]:
    ```ts
    export interface MeshData {
      positions: Float32Array      // xyz triples, metres, world space
      normals: Float32Array        // xyz triples, unit length
      uvs: Float32Array            // uv pairs
      colors: Float32Array         // rgb triples, linear 0..1
      indices: Uint32Array         // triangle list, CCW front-facing
    }
    export interface MarkerPlacement { s: number; position: Vec3; heading: number; width: number }
    export interface EdgeMarkerPlacement {
      s: number; position: Vec3; heading: number; side: -1 | 1; colorIdx: 0 | 1
    }
    export interface TrackScene {
      road: MeshData               // vertex colours ARE the palette: road, dirt,
      boostPads: MeshData          // shoulder, wall, pads and ramps are all baked
      ramps: MeshData              // in by buildTrackScene (§7.2's sole writer)
      checkpoints: MarkerPlacement[]
      edgeMarkers: EdgeMarkerPlacement[]
      itemBoxes: Vec3[]            // one per track.itemBoxes, SAME INDEX as
                                   // RenderFrame.itemBoxAlpha and ItemBoxView.boxIdx
      bounds: { min: Vec3; max: Vec3 }   // meshBounds(road) — the ground-plane extent (Q19)
    }
    export const ROAD_DECAL_LIFT = 0.02
    export function meshCounts(meshes: readonly MeshData[]): { vertices: number; triangles: number }
    ```
  - `packages/render/src/camera.ts` [§4.6] and `src/frame.ts` [§4.7]:
    ```ts
    export interface CameraState {
      position: Vec3; lookAt: Vec3; up: Vec3; fovDegrees: number
      mode: 'chase' | 'countdown' | 'results' | 'free'
    }
    export interface KartDraw {
      playerId: number; characterIdx: number; visible: boolean
      position: Vec3; heading: number; roll: number; wheelSpin: number; steerAngle: number
      bodyTint: PaletteRGB; alpha: number; driftSparkTier: number; boostFlame: number
      shieldVisible: boolean
    }
    export interface EntityDraw {
      entityId: number; kind: EntityKind; visible: boolean
      position: Vec3; heading: number; scale: number; tint: PaletteRGB; alpha: number
    }
    export interface RenderFrame {
      camera: CameraState
      karts: KartDraw[]            // length MAX_KARTS
      entities: EntityDraw[]       // length MAX_ENTITIES
      entityCount: number
      itemBoxAlpha: Float32Array
      screenFlash: number
      screenTintColor: PaletteRGB
      screenTintAmount: number
      sourceTick: number
    }
    /** Every field zeroed, every Vec3 distinct, sourceTick = 0, itemBoxAlpha filled with 1. */
    export function createRenderFrame(itemBoxCount: number): RenderFrame
    ```
  - The eight sibling modules the barrel re-exports alongside `backend`:
    `types`, `mesh`, `descriptors`, `camera`, `frame`, `hud`, `audio`,
    `smoothing` [Task 14].
  - `three@0.180.0` — value import, **only** inside `src/three/`.

- Produces:
  ```ts
  // src/backend.ts — PURE (interface only, imports nothing but sibling types)
  export interface RendererStats { drawCalls: number; vertices: number; triangles: number }

  export interface RendererBackend {
    /** Called once, after content load, before the first frame. */
    setScene(scene: TrackScene, theme: TrackTheme,
             kartMeshes: readonly MeshData[], characterMeshes: readonly MeshData[]): void
    /** Called once per animation frame with a fully-built RenderFrame. */
    applyFrame(frame: RenderFrame): void
    resize(widthPx: number, heightPx: number, devicePixelRatio: number): void
    stats(): RendererStats
    dispose(): void
  }

  // src/three/renderer.ts — ADAPTER. Not re-exported from the barrel (§8.2).
  export interface ThreeRendererOptions {
    antialias: boolean
    maxPixelRatio: number       // 2 by default; phones lie about theirs
    shadows: boolean            // false in v1
  }
  export const DEFAULT_THREE_OPTIONS: Readonly<ThreeRendererOptions>
  export function createThreeRenderer(canvas: HTMLCanvasElement,
                                      opts: ThreeRendererOptions): RendererBackend
  ```
  and `packages/render/src/index.ts`, re-exporting exactly `types`, `mesh`,
  `descriptors`, `camera`, `frame`, `hud`, `audio`, `smoothing`, `backend` —
  **not** `three/renderer`, and there is no `time` module (§4.1) and no `theme`
  module (§4.5).

  `@tapkart/render/three` is how `apps/web` reaches the adapter: the second
  `exports` entry keeps it available to the app that needs it while keeping it out
  of the headless barrel.

---

- [ ] **Step 1: Write the failing tests**

Create `packages/render/test/backend.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { DEFAULT_TRACK_THEME } from '@tapkart/content'
import type { TrackTheme } from '@tapkart/content'

import * as backendModule from '../src/backend'
import type { RendererBackend, RendererStats } from '../src/backend'
import { createRenderFrame } from '../src/frame'
import type { RenderFrame } from '../src/frame'
import type { MeshData, TrackScene } from '../src/mesh'

function emptyMesh(): MeshData {
  return {
    positions: new Float32Array(0),
    normals: new Float32Array(0),
    uvs: new Float32Array(0),
    colors: new Float32Array(0),
    indices: new Uint32Array(0),
  }
}

function triangleMesh(): MeshData {
  return {
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1]),
    normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]),
    uvs: new Float32Array([0, 0, 1, 0, 0, 1]),
    colors: new Float32Array([1, 1, 1, 1, 1, 1, 1, 1, 1]),
    indices: new Uint32Array([0, 1, 2]),
  }
}

function trackScene(): TrackScene {
  return {
    road: triangleMesh(),
    boostPads: emptyMesh(),
    ramps: emptyMesh(),
    checkpoints: [{ s: 0, position: { x: 0, y: 0, z: 0 }, heading: 0, width: 12 }],
    edgeMarkers: [
      { s: 0, position: { x: 0, y: 0, z: 6 }, heading: 0, side: 1, colorIdx: 0 },
      { s: 0.5, position: { x: 0, y: 0, z: -6 }, heading: 0, side: -1, colorIdx: 1 },
    ],
    itemBoxes: [
      { x: 2, y: 0.5, z: 0 },
      { x: -2, y: 0.5, z: 0 },
    ],
    bounds: { min: { x: -10, y: 0, z: -10 }, max: { x: 10, y: 1, z: 10 } },
  }
}

interface SceneCall {
  scene: TrackScene
  theme: TrackTheme
  karts: number
  characters: number
}

interface MockBackend extends RendererBackend {
  readonly frames: RenderFrame[]
  readonly scenes: SceneCall[]
  readonly resizes: [number, number, number][]
  readonly disposed: number
}

/** The mock spec §8 asks for: a plain object literal, no canvas, no GPU. */
function makeMockBackend(): MockBackend {
  const frames: RenderFrame[] = []
  const scenes: SceneCall[] = []
  const resizes: [number, number, number][] = []
  let disposed = 0

  const mock: MockBackend = {
    frames,
    scenes,
    resizes,
    get disposed(): number {
      return disposed
    },
    setScene(scene, theme, kartMeshes, characterMeshes) {
      scenes.push({ scene, theme, karts: kartMeshes.length, characters: characterMeshes.length })
    },
    applyFrame(frame) {
      frames.push(frame)
    },
    resize(widthPx, heightPx, devicePixelRatio) {
      resizes.push([widthPx, heightPx, devicePixelRatio])
    },
    stats(): RendererStats {
      return { drawCalls: scenes.length, vertices: frames.length, triangles: resizes.length }
    },
    dispose() {
      disposed++
    },
  }
  return mock
}

/** A stand-in for the shell's frame loop, typed to the seam and nothing else. */
function drivePresentation(backend: RendererBackend, frame: RenderFrame): RendererStats {
  backend.resize(800, 600, 3)
  backend.applyFrame(frame)
  return backend.stats()
}

describe('src/backend.ts — the seam', () => {
  it('has no runtime exports at all', () => {
    // backend.ts is interface-only, which is exactly why a headless test can
    // import the seam without importing a renderer (§8.2).
    expect(Object.keys(backendModule)).toEqual([])
  })

  it('is satisfied by a plain object literal, with no DOM and no GPU', () => {
    const mock = makeMockBackend()
    const frame = createRenderFrame(4)

    const stats = drivePresentation(mock, frame)

    expect(mock.resizes).toEqual([[800, 600, 3]])
    expect(mock.frames).toHaveLength(1)
    expect(stats).toEqual({ drawCalls: 0, vertices: 1, triangles: 1 })
  })

  it('hands the adapter the whole RenderFrame, so scene assertions read its argument', () => {
    const mock = makeMockBackend()
    const frame = createRenderFrame(2)
    frame.karts[3].visible = true
    frame.karts[3].position.x = 12.5
    frame.karts[3].heading = 1.25
    frame.entities[0].visible = true
    frame.entities[0].kind = 'bubble'
    frame.itemBoxAlpha[1] = 0.5

    mock.applyFrame(frame)

    // Spec §8's "scene-graph assertions against a mocked renderer" reduce to
    // this: everything the adapter could draw is readable off the argument.
    const received = mock.frames[0]
    expect(received).toBe(frame)
    expect(received.karts[3].position.x).toBe(12.5)
    expect(received.karts[3].heading).toBe(1.25)
    expect(received.entities[0].kind).toBe('bubble')
    expect(received.itemBoxAlpha[1]).toBe(0.5)
    expect(received.karts).toHaveLength(8)
  })

  it('takes the whole scene once, before the first frame', () => {
    const mock = makeMockBackend()
    const scene = trackScene()
    const theme: TrackTheme = DEFAULT_TRACK_THEME

    mock.setScene(scene, theme, [triangleMesh(), triangleMesh()], [triangleMesh()])

    expect(mock.scenes).toHaveLength(1)
    expect(mock.scenes[0].scene.road.indices).toHaveLength(3)
    expect(mock.scenes[0].scene.ramps.indices).toHaveLength(0)   // `neon-district` has none
    expect(mock.scenes[0].scene.edgeMarkers.map((m) => m.colorIdx)).toEqual([0, 1])
    expect(mock.scenes[0].theme.trackId).toBe(theme.trackId)
    expect(mock.scenes[0].karts).toBe(2)
    expect(mock.scenes[0].characters).toBe(1)
  })

  it('reports the three counters and disposes idempotently through the seam', () => {
    const mock = makeMockBackend()
    mock.dispose()
    mock.dispose()
    expect(mock.disposed).toBe(2)

    const stats: RendererStats = mock.stats()
    expect(Object.keys(stats).sort()).toEqual(['drawCalls', 'triangles', 'vertices'])
  })
})
```

Create `packages/render/test/barrel.test.ts`:

```ts
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import * as render from '../src/index'
import * as audio from '../src/audio'
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

/** §4.11, in order. `three/renderer` is deliberately absent. */
const BARREL_MODULES = [
  'types', 'mesh', 'descriptors', 'camera', 'frame', 'hud', 'audio', 'smoothing', 'backend',
] as const

const NAMESPACES: [string, object][] = [
  ['types', types], ['mesh', mesh], ['descriptors', descriptors], ['camera', camera],
  ['frame', frame], ['hud', hud], ['audio', audio], ['smoothing', smoothing],
  ['backend', backend],
]

/** `from 'three'`, `import('three')`, `require('three')`, and any subpath. */
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
  it('re-exports exactly the nine modules §4.11 names, each once', () => {
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
    expect(onDisk).toEqual([...BARREL_MODULES].sort())

    // The adapter lives in its own directory precisely so it is never one of the
    // files the rule above sweeps up.
    expect(statSync(join(SRC, 'three')).isDirectory()).toBe(true)
    expect(existsSync(join(SRC, 'three', 'renderer.ts'))).toBe(true)
  })

  it('does not re-export the Three.js adapter', () => {
    expect(Object.prototype.hasOwnProperty.call(render, 'createThreeRenderer')).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(render, 'DEFAULT_THREE_OPTIONS')).toBe(false)
    // Statements, not prose: the barrel's comment explains why `three` is absent,
    // so a bare substring check would fail on its own documentation.
    const text = readFileSync(join(SRC, 'index.ts'), 'utf8')
    expect(text).not.toMatch(/export \* from '\.\/three/)
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

    for (const root of roots) {
      for (const file of tsFilesUnder(root)) {
        const text = readFileSync(file, 'utf8')
        const rel = relative(REPO, file)
        expect(THREE_SPECIFIER.test(text), `${rel} imports three`).toBe(false)
        expect(text.includes(adapterSubpath), `${rel} imports the adapter`).toBe(false)
        expect(text.includes(adapterPath), `${rel} imports the adapter`).toBe(false)
      }
    }
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

  it('reaches Task 14\'s smoothing through the barrel', () => {
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
  })

  it('declares the type declarations three does not ship', () => {
    // three@0.180.0 has no `types` field, no `types` condition in its exports
    // map and no .d.ts in build/, so tsc cannot typecheck the adapter without
    // this. §4.10 makes it this task's call and this task's report.
    expect(pkg.devDependencies?.['@types/three']).toBe('0.180.0')
  })
})
```

**What each test catches, and whether it would actually fail under that bug.**

| Test | Bug it catches | Would it fail? |
|---|---|---|
| `has no runtime exports at all` | `backend.ts` acquiring an implementation — a default backend, a helper, a constant — which would make the seam file itself something a test drags in | Yes — `Object.keys` on the namespace is `[]` only for a types-only module |
| `is satisfied by a plain object literal` / `hands the adapter the whole RenderFrame` | a seam whose methods a plain literal cannot implement (an abstract class, a required base), or one that hands the adapter something less than the frame — either would force jsdom or a canvas into the suite, which Q30 forbids | Yes — the mock is a literal, the assertions read the frame's fields, and the file would not compile if the shape were unimplementable |
| `takes the whole scene once, before the first frame` | `setScene` losing an argument (themes, or one of the two mesh arrays) in a later edit; also pins that a `TrackScene` with **zero-length ramps** is a legal argument rather than an error (`neon-district` has no ramps) | Yes — arity and content are asserted |
| `re-exports exactly the nine modules` | a barrel that grew a tenth module, lost `smoothing` (Task 14's, which no other task re-exports), or listed one twice | Yes — the extracted list is compared as a set |
| `lists every top-level module in src/` | a new `src/*.ts` that nobody re-exported, and the reverse: a barrel line pointing at a deleted file | Yes |
| `does not re-export the Three.js adapter` | the single failure this whole seam exists to prevent, in its most direct form | Yes — both by namespace key and by barrel text |
| `never reaches src/three or three, transitively` | the *indirect* form, which is the one that actually happens: `frame.ts` (or any module the barrel re-exports) importing a helper that imports `three`. A test that only checked `index.ts` would pass while every headless suite in the repo broke | Yes — it walks relative imports from `index.ts` and reads every file it lands on; the `graph.length` assertion stops a broken walker from vacuously passing |
| `confines every three import to src/three/` | `import type { Scene } from 'three'` in `mesh.ts` or `frame.ts` — legal today, a value import after one refactor, and invisible to `verbatimModuleSyntax` | Yes — the regex matches type-only imports too, since they are still `from 'three'` |
| `keeps three out of every test file` | a later task writing a test that imports the adapter, which needs a GPU and is out of scope for Plan 3 (§8.3) | Yes, repo-wide, and `roots.length > 0` keeps it from passing vacuously if the directory walk finds nothing |
| `has no ambiguous re-export` | two modules exporting the same name: ESM silently drops it from the namespace and the import site becomes a SyntaxError | Yes — same construction as `packages/sim/test/barrel.test.ts` |
| `pins three exactly, with no caret` | `^0.180.0`, which Q10 forbids: three's minor releases are breaking, and a caret means a different renderer on a different machine | Yes — string equality |
| `declares the type declarations three does not ship` | dropping `@types/three`, after which `npm run typecheck` fails on the adapter with `TS7016`/`TS2307` and the next task inherits it | Yes |

---

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/render/test/backend.test.ts`

Expected: FAIL — `src/backend.ts` does not exist:

```
Error: Cannot find module '../src/backend' imported from '<repo>/packages/render/test/backend.test.ts'

Caused by: Error: Failed to load url ../src/backend (resolved id: ../src/backend) in <repo>/packages/render/test/backend.test.ts. Does the file exist?
```

(`<repo>` is the absolute path of this working copy.) `Test Files 1 failed (1)`,
`Tests no tests`.

Run: `npx vitest run packages/render/test/barrel.test.ts`

Expected: FAIL, with one of two failures, depending on what earlier tasks left in
`packages/render/src/index.ts`:

- if the file exists but predates `smoothing` and `backend` (the expected case —
  Task 14 deliberately does not touch the barrel):
  ```
  AssertionError: barrel is missing export * from './smoothing': expected '…' to contain "export * from './smoothing'"
  ```
- if the file does not exist at all:
  ```
  Error: Cannot find module '../src/index' imported from '<repo>/packages/render/test/barrel.test.ts'
  ```

Either way the suite must be red before Step 3. Do not proceed on a green
barrel test — a green one here means the barrel already re-exports something this
task has not written yet.

---

- [ ] **Step 3: Write the implementation**

**3a.** Create `packages/render/src/backend.ts`:

```ts
// The renderer seam. This file imports nothing but sibling types on purpose: it
// is what makes `packages/render` assertable under `environment: 'node'` with no
// canvas, no GPU and no DOM (§8.2). A mock backend is a plain object literal, and
// spec §8's scene-graph assertions are made against `applyFrame`'s argument.
//
// It exists for headless testability, NOT for device fallback: Q10 mandates
// Three.js and there is no Canvas2D backend. Every device that can run this game
// has WebGL, and a second renderer is a second thing to keep correct for no user.
import type { RenderFrame } from './frame'
import type { MeshData, TrackScene } from './mesh'
import type { TrackTheme } from '@tapkart/content'

export interface RendererStats {
  drawCalls: number
  vertices: number
  triangles: number
}

export interface RendererBackend {
  /** Called once, after content load, before the first frame. */
  setScene(scene: TrackScene, theme: TrackTheme,
           kartMeshes: readonly MeshData[], characterMeshes: readonly MeshData[]): void
  /** Called once per animation frame with a fully-built RenderFrame. */
  applyFrame(frame: RenderFrame): void
  resize(widthPx: number, heightPx: number, devicePixelRatio: number): void
  stats(): RendererStats
  dispose(): void
}
```

**3b.** Modify `packages/render/package.json` so it reads exactly:

```json
{
  "name": "@tapkart/render",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./three": "./src/three/renderer.ts"
  },
  "dependencies": {
    "@tapkart/sim": "*",
    "@tapkart/content": "*",
    "three": "0.180.0"
  },
  "devDependencies": {
    "@types/three": "0.180.0"
  },
  "scripts": {
    "typecheck": "tsc --noEmit -p tsconfig.json"
  }
}
```

Then install, from the repository root:

```bash
npm install
```

`three` is pinned **exactly** — no caret (Q10). `@types/three` is a
devDependency, not a dependency, because it is erased at build time; it is here
because the published `three@0.180.0` ships no declarations of its own, which
§4.10 makes this task's call to make and to report.

**3c.** Create `packages/render/src/three/renderer.ts`:

```ts
// ADAPTER (§8.2). The ONLY module in the repository that imports `three`, and the
// only thing that touches a Three.js scene graph (§7.2). CI never imports this
// file: src/index.ts deliberately does not re-export it, so a headless vitest run
// never pulls three -- or, transitively, a WebGL context -- into the process.
//
// Everything here is owner-verified, not CI-verified (§8.3): CI proves the
// RenderFrame is right and that this adapter was handed it. It cannot prove
// Three.js drew it, that the shader compiled, or that the kart is not inside the
// road.
import {
  AmbientLight,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  DirectionalLight,
  Euler,
  Fog,
  Group,
  InstancedMesh,
  LinearSRGBColorSpace,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  OrthographicCamera,
  PerspectiveCamera,
  PlaneGeometry,
  Quaternion,
  SRGBColorSpace,
  Scene,
  SphereGeometry,
  Vector3,
  WebGLRenderer,
} from 'three'

import { MAX_ENTITIES, MAX_KARTS } from '@tapkart/sim'
import type { Vec3 } from '@tapkart/sim'
import type { PaletteRGB, TrackTheme } from '@tapkart/content'

import type { RendererBackend, RendererStats } from '../backend'
import type { KartDraw, RenderFrame } from '../frame'
import { ROAD_DECAL_LIFT, meshCounts } from '../mesh'
import type { EdgeMarkerPlacement, MarkerPlacement, MeshData, TrackScene } from '../mesh'

export interface ThreeRendererOptions {
  antialias: boolean
  maxPixelRatio: number       // 2 by default; phones lie about theirs
  shadows: boolean            // false in v1
}

export const DEFAULT_THREE_OPTIONS: Readonly<ThreeRendererOptions> = Object.freeze({
  antialias: true,
  maxPixelRatio: 2,
  shadows: false,
})

const SHIELD_SCALE = 1.6
const ENTITY_SPHERE_SEGMENTS = 10
const MARKER_POST_THICKNESS = 0.18
const ITEM_BOX_SIZE = 1.4
const ITEM_BOX_COLOR = 0xffd24a
/** The ground quad is `scene.bounds` widened by this factor, so the plane reaches
 *  past the ribbon to the fog rather than ending in mid-air at the road's edge. */
const GROUND_MARGIN = 3
/** …and sits this far under the lowest road vertex, so it never z-fights the ribbon. */
const GROUND_DROP = 0.05
const CHECKPOINT_BAR_LENGTH = 0.6
const CHECKPOINT_BAR_HEIGHT = 0.04

function setColor(target: Color, rgb: PaletteRGB): void {
  target.setRGB(rgb[0], rgb[1], rgb[2], LinearSRGBColorSpace)
}

function toGeometry(data: MeshData): BufferGeometry {
  const geo = new BufferGeometry()
  geo.setAttribute('position', new BufferAttribute(data.positions, 3))
  if (data.normals.length > 0) geo.setAttribute('normal', new BufferAttribute(data.normals, 3))
  if (data.uvs.length > 0) geo.setAttribute('uv', new BufferAttribute(data.uvs, 2))
  if (data.colors.length > 0) geo.setAttribute('color', new BufferAttribute(data.colors, 3))
  geo.setIndex(new BufferAttribute(data.indices, 1))
  geo.computeBoundingSphere()
  return geo
}

export function createThreeRenderer(
  canvas: HTMLCanvasElement,
  opts: ThreeRendererOptions,
): RendererBackend {
  const renderer = new WebGLRenderer({ canvas, antialias: opts.antialias })
  renderer.outputColorSpace = SRGBColorSpace
  renderer.shadowMap.enabled = opts.shadows
  renderer.autoClear = false

  const scene = new Scene()
  const camera = new PerspectiveCamera(62, 1, 0.3, 900)
  const ambient = new AmbientLight(0xffffff, 0.6)
  const sun = new DirectionalLight(0xffffff, 1.1)
  scene.add(ambient)
  scene.add(sun)

  const staticRoot = new Group()
  scene.add(staticRoot)

  // The ground plane. §12 fixes the whole visual budget as "a ribbon over a themed
  // ground plane plus procedural edge markers", and Q19 makes `TrackScene.bounds` a
  // render extent for exactly this — ground-plane size, camera far clamp, skybox
  // scale. Without it the ribbon floats over the sky's bottom colour, Q20's speed cue
  // is half-delivered, and six themes are gated on a `theme.ground` nothing draws.
  // One quad, allocated once, resized and recoloured per track in setScene.
  const groundGeometry = new PlaneGeometry(1, 1)
  const groundMaterial = new MeshLambertMaterial()
  const ground = new Mesh(groundGeometry, groundMaterial)
  ground.rotation.x = -Math.PI / 2   // PlaneGeometry is XY; local +y becomes world +z
  scene.add(ground)

  // The screen tint (surge) and flash (charge) are a second, orthographic pass
  // rather than a post-processing chain: two quads cost one draw call each and no
  // render target on a phone.
  const overlayScene = new Scene()
  const overlayCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1)
  const overlayGeometry = new PlaneGeometry(2, 2)
  const tintMaterial = new MeshBasicMaterial({
    transparent: true, depthTest: false, depthWrite: false, opacity: 0,
  })
  const flashMaterial = new MeshBasicMaterial({
    color: 0xffffff, transparent: true, depthTest: false, depthWrite: false, opacity: 0,
  })
  const tintQuad = new Mesh(overlayGeometry, tintMaterial)
  const flashQuad = new Mesh(overlayGeometry, flashMaterial)
  tintQuad.visible = false
  flashQuad.visible = false
  overlayScene.add(tintQuad)
  overlayScene.add(flashQuad)

  // Per-seat scene graph, allocated once (§7.3): the outer group carries position
  // and yaw, the inner group carries roll about the kart's own forward axis.
  const kartGeometries: BufferGeometry[] = []
  const characterGeometries: BufferGeometry[] = []
  const kartRoots: Group[] = []
  const kartTilts: Group[] = []
  const kartBodies: Mesh<BufferGeometry, MeshLambertMaterial>[] = []
  const kartHeads: Mesh<BufferGeometry, MeshLambertMaterial>[] = []
  const kartShields: Mesh<BufferGeometry, MeshBasicMaterial>[] = []
  const entityMeshes: Mesh<BufferGeometry, MeshLambertMaterial>[] = []

  const shieldGeometry = new SphereGeometry(1, 12, 8)
  const entityGeometry = new SphereGeometry(0.5, ENTITY_SPHERE_SEGMENTS, ENTITY_SPHERE_SEGMENTS)

  // Item boxes. `TrackScene.itemBoxes[i]` and `RenderFrame.itemBoxAlpha[i]` are the
  // same box (§4.3), so this array is index-paired with both. Q29's ghosting is
  // per-box opacity and a per-instance opacity needs a custom shader, so each box is
  // its own Mesh over one shared geometry — 16 to 24 per shipped track, which is the
  // entire cost of the pickup the item system is built on being visible.
  const itemBoxGeometry = new BoxGeometry(ITEM_BOX_SIZE, ITEM_BOX_SIZE, ITEM_BOX_SIZE)
  const itemBoxMeshes: Mesh<BufferGeometry, MeshBasicMaterial>[] = []

  for (let i = 0; i < MAX_KARTS; i++) {
    const root = new Group()
    const tilt = new Group()
    const body = new Mesh(new BufferGeometry(), new MeshLambertMaterial({ transparent: true }))
    const head = new Mesh(new BufferGeometry(), new MeshLambertMaterial({ transparent: true }))
    const shield = new Mesh(shieldGeometry, new MeshBasicMaterial({
      color: 0x66ccff, transparent: true, opacity: 0.25, depthWrite: false,
    }))
    shield.scale.setScalar(SHIELD_SCALE)
    shield.visible = false
    tilt.add(body)
    tilt.add(head)
    tilt.add(shield)
    root.add(tilt)
    root.visible = false
    scene.add(root)
    kartRoots.push(root)
    kartTilts.push(tilt)
    kartBodies.push(body)
    kartHeads.push(head)
    kartShields.push(shield)
  }

  for (let i = 0; i < MAX_ENTITIES; i++) {
    const mesh = new Mesh(entityGeometry, new MeshLambertMaterial({ transparent: true }))
    mesh.visible = false
    scene.add(mesh)
    entityMeshes.push(mesh)
  }

  const ownedGeometries: BufferGeometry[] = [
    shieldGeometry, entityGeometry, overlayGeometry, groundGeometry, itemBoxGeometry,
  ]
  const ownedMaterials: (MeshBasicMaterial | MeshLambertMaterial)[] = [
    tintMaterial, flashMaterial, groundMaterial,
  ]
  for (const m of kartBodies) ownedMaterials.push(m.material)
  for (const m of kartHeads) ownedMaterials.push(m.material)
  for (const m of kartShields) ownedMaterials.push(m.material)
  for (const m of entityMeshes) ownedMaterials.push(m.material)

  const scratchColor = new Color()
  const scratchVector = new Vector3()
  const scratchQuat = new Quaternion()
  const scratchEuler = new Euler(0, 0, 0, 'YXZ')
  const scratchScale = new Vector3(1, 1, 1)
  const scratchMatrix = new Matrix4()

  const ownedStaticGeometries: BufferGeometry[] = []
  const ownedStaticMaterials: (MeshBasicMaterial | MeshLambertMaterial)[] = []

  let sceneVertices = 0
  let sceneTriangles = 0
  let disposed = false

  function clearStatic(): void {
    for (const child of staticRoot.children.slice()) staticRoot.remove(child)
    for (const geo of ownedStaticGeometries) geo.dispose()
    for (const mat of ownedStaticMaterials) mat.dispose()
    ownedStaticGeometries.length = 0
    ownedStaticMaterials.length = 0
    itemBoxMeshes.length = 0      // their materials are in ownedStaticMaterials
  }

  /**
   * No colour argument, and that is the point. `buildTrackScene` bakes the theme into
   * every surface's vertex colours — road, dirt, shoulder, wall, boost pads and ramps
   * — and §7.2 makes it the sole writer of track colour. A material colour here would
   * be a second palette: `vertexColors: true` MULTIPLIES `material.color` by the
   * vertex colour, so setting both ships the road at `theme.road` squared, which turns
   * a 0.18 grey into a near-black 0.032. White is the multiplicative identity. It also
   * means a surface added later cannot be forgotten by the colouring pass, because
   * there is only one.
   */
  function addSurface(data: MeshData): void {
    if (data.indices.length === 0) return      // `neon-district` has no ramps (§4.3)
    const geo = toGeometry(data)
    const mat = new MeshLambertMaterial({ vertexColors: data.colors.length > 0 })
    // left at its default 0xffffff; §0a forbids this file from making colour decisions
    ownedStaticGeometries.push(geo)
    ownedStaticMaterials.push(mat)
    staticRoot.add(new Mesh(geo, mat))
  }

  /** One Mesh per box, materials owned by `ownedStaticMaterials` so `clearStatic`
   *  disposes them with the rest of the track. Positions are static track furniture;
   *  only opacity moves, and it moves in `applyFrame`. */
  function addItemBoxes(positions: readonly Vec3[]): void {
    for (const p of positions) {
      const mat = new MeshBasicMaterial({ color: ITEM_BOX_COLOR, transparent: true, opacity: 1 })
      const box = new Mesh(itemBoxGeometry, mat)
      box.position.set(p.x, p.y + ITEM_BOX_SIZE / 2, p.z)
      ownedStaticMaterials.push(mat)
      staticRoot.add(box)
      itemBoxMeshes.push(box)
    }
  }

  function addEdgeMarkers(posts: readonly EdgeMarkerPlacement[], theme: TrackTheme): void {
    const height = theme.edgeMarkers.height
    const geo = new BoxGeometry(MARKER_POST_THICKNESS, height, MARKER_POST_THICKNESS)
    ownedStaticGeometries.push(geo)
    for (const colorIdx of [0, 1] as const) {
      const of = posts.filter((p) => p.colorIdx === colorIdx)
      if (of.length === 0) continue
      const mat = new MeshLambertMaterial()
      setColor(mat.color, theme.edgeMarkers.colors[colorIdx])
      ownedStaticMaterials.push(mat)
      // One InstancedMesh per colour: hundreds of posts, two draw calls.
      const inst = new InstancedMesh(geo, mat, of.length)
      for (let i = 0; i < of.length; i++) {
        const p = of[i]
        scratchVector.set(p.position.x, p.position.y + height / 2, p.position.z)
        scratchEuler.set(0, -p.heading, 0)
        scratchQuat.setFromEuler(scratchEuler)
        scratchScale.set(1, 1, 1)
        scratchMatrix.compose(scratchVector, scratchQuat, scratchScale)
        inst.setMatrixAt(i, scratchMatrix)
      }
      inst.instanceMatrix.needsUpdate = true
      staticRoot.add(inst)
    }
  }

  function addCheckpoints(marks: readonly MarkerPlacement[], theme: TrackTheme): void {
    if (marks.length === 0) return
    const geo = new BoxGeometry(CHECKPOINT_BAR_LENGTH, CHECKPOINT_BAR_HEIGHT, 1)
    const mat = new MeshLambertMaterial()
    setColor(mat.color, theme.wall)
    ownedStaticGeometries.push(geo)
    ownedStaticMaterials.push(mat)
    const inst = new InstancedMesh(geo, mat, marks.length)
    for (let i = 0; i < marks.length; i++) {
      const m = marks[i]
      scratchVector.set(m.position.x, m.position.y + ROAD_DECAL_LIFT, m.position.z)
      scratchEuler.set(0, -m.heading, 0)
      scratchQuat.setFromEuler(scratchEuler)
      scratchScale.set(1, 1, m.width)
      scratchMatrix.compose(scratchVector, scratchQuat, scratchScale)
      inst.setMatrixAt(i, scratchMatrix)
    }
    inst.instanceMatrix.needsUpdate = true
    staticRoot.add(inst)
  }

  function applyKart(i: number, k: KartDraw): void {
    const root = kartRoots[i]
    root.visible = k.visible
    if (!k.visible) return
    const body = kartBodies[i]
    const head = kartHeads[i]
    const tilt = kartTilts[i]
    const shield = kartShields[i]

    const kartGeo = kartGeometries[k.characterIdx]
    const charGeo = characterGeometries[k.characterIdx]
    if (kartGeo !== undefined && body.geometry !== kartGeo) body.geometry = kartGeo
    if (charGeo !== undefined && head.geometry !== charGeo) head.geometry = charGeo

    // `heading` is a world yaw whose forward is (cos h, 0, sin h) -- the
    // convention §4.7's bubblePosition is written in -- and a Three yaw turns +x
    // toward -z, so the scene-graph rotation is -heading. Descriptor meshes are
    // authored +x forward, +y up.
    root.position.set(k.position.x, k.position.y, k.position.z)
    root.rotation.set(0, -k.heading, 0)
    tilt.rotation.set(k.roll, 0, 0)

    setColor(body.material.color, k.bodyTint)
    body.material.opacity = k.alpha
    head.material.opacity = k.alpha
    body.material.emissive.setRGB(k.boostFlame * 0.9, k.boostFlame * 0.35, 0, LinearSRGBColorSpace)
    shield.visible = k.shieldVisible
  }

  return {
    setScene(trackScene: TrackScene, theme: TrackTheme,
             kartMeshes: readonly MeshData[], characterMeshes: readonly MeshData[]): void {
      clearStatic()
      addSurface(trackScene.road)
      addSurface(trackScene.boostPads)
      addSurface(trackScene.ramps)
      addEdgeMarkers(trackScene.edgeMarkers, theme)
      addCheckpoints(trackScene.checkpoints, theme)
      addItemBoxes(trackScene.itemBoxes)

      // The ground plane, sized from the render extent Q19 computes `bounds` for and
      // coloured `theme.ground` — the one field of the theme that six themes are gated
      // on and that nothing else in this package draws (§12).
      const spanX = trackScene.bounds.max.x - trackScene.bounds.min.x
      const spanZ = trackScene.bounds.max.z - trackScene.bounds.min.z
      ground.scale.set(spanX * GROUND_MARGIN, spanZ * GROUND_MARGIN, 1)
      ground.position.set(
        (trackScene.bounds.min.x + trackScene.bounds.max.x) / 2,
        trackScene.bounds.min.y - GROUND_DROP,
        (trackScene.bounds.min.z + trackScene.bounds.max.z) / 2,
      )
      setColor(groundMaterial.color, theme.ground)

      for (const geo of kartGeometries) geo.dispose()
      for (const geo of characterGeometries) geo.dispose()
      kartGeometries.length = 0
      characterGeometries.length = 0
      for (const data of kartMeshes) kartGeometries.push(toGeometry(data))
      for (const data of characterMeshes) characterGeometries.push(toGeometry(data))

      setColor(scratchColor, theme.sky.bottom)
      scene.background = new Color(scratchColor)
      setColor(scratchColor, theme.fog.color)
      scene.fog = new Fog(scratchColor.getHex(), theme.fog.near, theme.fog.far)
      ambient.intensity = theme.ambient
      sun.position.set(theme.sunDirection.x, theme.sunDirection.y, theme.sunDirection.z)
      sun.position.multiplyScalar(100)

      const counts = meshCounts([
        trackScene.road, trackScene.boostPads, trackScene.ramps,
        ...kartMeshes, ...characterMeshes,
      ])
      sceneVertices = counts.vertices
      sceneTriangles = counts.triangles
    },

    applyFrame(frame: RenderFrame): void {
      camera.position.set(frame.camera.position.x, frame.camera.position.y, frame.camera.position.z)
      camera.up.set(frame.camera.up.x, frame.camera.up.y, frame.camera.up.z)
      scratchVector.set(frame.camera.lookAt.x, frame.camera.lookAt.y, frame.camera.lookAt.z)
      camera.lookAt(scratchVector)
      if (camera.fov !== frame.camera.fovDegrees) {
        camera.fov = frame.camera.fovDegrees
        camera.updateProjectionMatrix()
      }

      for (let i = 0; i < MAX_KARTS; i++) applyKart(i, frame.karts[i])

      for (let i = 0; i < MAX_ENTITIES; i++) {
        const mesh = entityMeshes[i]
        const e = frame.entities[i]
        if (!e.visible) {
          mesh.visible = false      // includes every 'surge', which is never drawn (Q27)
          continue
        }
        mesh.visible = true
        mesh.position.set(e.position.x, e.position.y, e.position.z)
        mesh.rotation.set(0, -e.heading, 0)
        mesh.scale.setScalar(e.scale)
        setColor(mesh.material.color, e.tint)
        mesh.material.opacity = e.alpha
      }

      // Index i is box i in TrackScene.itemBoxes: the same pairing §4.3 pins and the
      // mesh task asserts against sim's own itemBoxWorldPos. Alpha 0 is a taken box
      // mid-respawn (Q29), and `visible = false` skips the draw call entirely.
      for (let i = 0; i < itemBoxMeshes.length; i++) {
        const alpha = frame.itemBoxAlpha[i]
        const box = itemBoxMeshes[i]
        box.visible = alpha > 0
        box.material.opacity = alpha
      }

      tintQuad.visible = frame.screenTintAmount > 0
      if (tintQuad.visible) {
        setColor(tintMaterial.color, frame.screenTintColor)
        tintMaterial.opacity = frame.screenTintAmount
      }
      flashQuad.visible = frame.screenFlash > 0
      if (flashQuad.visible) flashMaterial.opacity = frame.screenFlash

      renderer.clear()
      renderer.render(scene, camera)
      renderer.render(overlayScene, overlayCamera)
    },

    resize(widthPx: number, heightPx: number, devicePixelRatio: number): void {
      const w = Math.max(1, widthPx)
      const h = Math.max(1, heightPx)
      renderer.setPixelRatio(Math.min(devicePixelRatio, opts.maxPixelRatio))
      renderer.setSize(w, h, false)     // the shell owns CSS sizing, not the renderer
      camera.aspect = w / h
      camera.updateProjectionMatrix()
    },

    stats(): RendererStats {
      return {
        drawCalls: renderer.info.render.calls,
        vertices: sceneVertices,
        triangles: sceneTriangles,
      }
    },

    dispose(): void {
      if (disposed) return
      disposed = true
      clearStatic()
      for (const geo of kartGeometries) geo.dispose()
      for (const geo of characterGeometries) geo.dispose()
      kartGeometries.length = 0
      characterGeometries.length = 0
      for (const geo of ownedGeometries) geo.dispose()
      for (const mat of ownedMaterials) mat.dispose()
      renderer.dispose()
    },
  }
}
```

Four things about this file that are decisions, not incidentals:

- **`wheelSpin` and `steerAngle` are carried by `RenderFrame` and not consumed
  here.** `buildKartMesh` (§4.4) emits one `MeshData` per kart with its wheels
  baked in, so there is no wheel object to turn. Both fields stay in the frame
  because they are derived from simulation state, they are in the golden fixture's
  covered subset (§9.2), and an adapter that splits wheels out later reads them
  without a contract change. This is the only place in the seam where the frame
  says more than the v1 adapter draws.
- **Item boxes are drawn here, and the index pairing is the whole contract.**
  `TrackScene.itemBoxes[i]` (filled from sim's `itemBoxWorldPos`, the sole writer
  of a box's world position) and `RenderFrame.itemBoxAlpha[i]` are the same box.
  This adapter never re-derives a position and never re-orders the array; it walks
  both by the same `i`. Get that wrong and every box draws over the wrong pickup
  volume — which no test in `render` can see, because this file is the one CI never
  imports.
- **The ground plane is sized from `scene.bounds`, not from `track.bounds`.** Q19
  rules `track.bounds` a *declared* render extent, much larger than the ribbon;
  `TrackScene.bounds` is `meshBounds(road)`, the extent of what was actually built.
  A ground quad sized from the declared bounds would push the horizon hundreds of
  metres past the fog on some tracks and not others. **CI cannot see this either**
  (§8.3 puts pixels under owner verification), so the shell task's operator
  checklist names the ground plane explicitly — that checklist is the only detector
  a missing ground plane has.
- **Colours are set in linear space** (`setRGB(..., LinearSRGBColorSpace)`)
  because every `PaletteRGB` in `@tapkart/content` is documented linear 0..1,
  while the renderer's output is `SRGBColorSpace`. Passing linear values as if
  they were sRGB is the classic washed-out-scene bug and costs nothing to avoid.

**3d.** Create `packages/render/src/index.ts` — the §4.11 barrel:

```ts
// Public barrel for @tapkart/render.
//
// packages/render/package.json maps "." to this file, so this list IS the
// package's public surface. `three/renderer` is NOT here, and that omission is
// load-bearing rather than tidy: re-exporting it would pull `three` -- and,
// transitively, a WebGL context -- into every headless test in the repository,
// and the failure would appear as an unrelated suite breaking (§8.2). Reach the
// adapter through the package's "./three" export instead; only apps/web does.
//
// There is no `time` module (§4.1: the tick/millisecond bridge is game/clock.ts,
// which owns the single TICK_MS import) and no `theme` module (§4.5: TrackTheme
// is @tapkart/content's). barrel.test.ts asserts both absences, that no two
// re-exported modules export the same name, and that nothing reachable from here
// imports three.
export * from './types'
export * from './mesh'
export * from './descriptors'
export * from './camera'
export * from './frame'
export * from './hud'
export * from './audio'
export * from './smoothing'
export * from './backend'
```

---

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run packages/render/test/backend.test.ts packages/render/test/barrel.test.ts
```

Expected: PASS, 16 tests (5 in `backend.test.ts`, 11 in `barrel.test.ts`).

Then the full gate — the adapter is typechecked here and nowhere else, so this is
the only step that proves it compiles against the real `three` types:

```bash
npx tsc --noEmit -p packages/render/tsconfig.json
npx vitest run
```

Both must be clean. If `tsc` reports `TS7016: Could not find a declaration file
for module 'three'`, `npm install` did not pick up `@types/three` — re-run it from
the repository root, not from inside the package.

**Owner verification, which CI cannot do (§8.3):** that the pixels are correct.
CI proves the `RenderFrame` is right and that the adapter was handed it; it cannot
prove Three.js drew it, that the shader compiled, or that the kart is not inside
the road. That check happens when `apps/web` runs on a device.

---

- [ ] **Step 5: Commit**

```bash
git add packages/render/src/backend.ts packages/render/src/three/renderer.ts \
        packages/render/src/index.ts packages/render/package.json \
        packages/render/test/backend.test.ts packages/render/test/barrel.test.ts \
        package-lock.json
git commit -m "feat(render): the RendererBackend seam, the Three.js adapter and the barrel

backend.ts imports nothing but sibling types, so a mock backend is a
plain object literal and spec §8's scene-graph assertions are made
against applyFrame's argument, under environment: 'node', with no canvas
and no GPU. That is the whole reason the seam exists -- Q10 mandates
Three.js and there is no Canvas2D fallback, so this is testability, not
device fallback.

three is pinned at exactly 0.180.0, no caret. three@0.180.0 publishes no
type declarations -- no types field, no types condition in its exports
map, no .d.ts in build/ -- so @types/three@0.180.0 is a devDependency,
which §4.10 makes this task's call and this task's report.

The barrel re-exports nine modules and deliberately not three/renderer.
That omission is load-bearing: a barrel that re-exported it would pull
three, and transitively a WebGL context, into every headless test in the
repository, and the failure would surface as an unrelated suite
breaking. verbatimModuleSyntax does not save that -- a value import
survives erasure -- so even import type from 'three' is banned outside
src/three/. barrel.test.ts enforces both bans over the transitive module
graph from index.ts, and repo-wide across every packages/*/test tree,
rather than trusting the rule.

The adapter allocates its whole scene graph once: eight kart groups
(outer group for position and yaw, inner group for roll about the
forward axis), MAX_ENTITIES entity meshes, and two InstancedMeshes for
the edge markers, so hundreds of posts cost two draw calls. Screen tint
and flash are an orthographic overlay pass rather than a post chain --
no render target on a phone. Palettes are set in linear space against an
SRGB output colour space, which is what content documents them as.

Track colour is baked into vertex colours by buildTrackScene and this
file sets no palette on a surface material. vertexColors: true
MULTIPLIES material.color by the vertex colour, so a second palette here
would ship the road at theme.road squared -- a 0.18 grey as 0.032. One
code path colours every surface, and a surface added later cannot be
forgotten by it.

The ground plane is a single quad sized from TrackScene.bounds --
meshBounds(road), the extent of what was built, not track.bounds, which
Q19 declares much larger -- and coloured theme.ground. §12 fixes the
visual budget as a ribbon over a themed ground plane plus procedural
edge markers; without the plane the ribbon floats over the sky's bottom
colour and six gated theme.ground values render nothing.

Item boxes are drawn: one Mesh per box over a shared geometry, walking
TrackScene.itemBoxes and RenderFrame.itemBoxAlpha by the same index,
because Q29's ghosting is per-box opacity and a per-instance opacity
needs a custom shader.

One honest gap remains, recorded in the file: wheelSpin and steerAngle
are in the frame but not consumed, because buildKartMesh bakes wheels
into one mesh.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```
