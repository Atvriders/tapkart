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
