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
