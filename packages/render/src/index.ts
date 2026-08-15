// Public barrel for @tapkart/render.
//
// packages/render/package.json maps "." to this file, so this list IS the package's
// public surface. It does NOT re-export `three/renderer` (contract §8.2), there is no
// `time` module (§4.1) and there is no `theme` module (§4.5) — TrackTheme is content.
//
// Contract §4.11's order, one line per module as each lands:
// types, mesh, descriptors, camera, frame, hud, audio, smoothing, backend.
export * from './types'
export * from './mesh'
export * from './descriptors'
export * from './camera'
