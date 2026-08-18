// Public barrel for @tapkart/render.
//
// packages/render/package.json maps "." to this file, so this list IS the
// package's public surface. `three/renderer` and `audio/web` are NOT here, and
// those omissions are load-bearing rather than tidy: re-exporting an adapter
// would pull browser-only APIs into every headless test in the repository, and
// the failure would appear as an unrelated suite breaking (§8.2). Reach them
// through the package's "./three" and "./web-audio" exports instead.
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
export * from './audio/graph'
export * from './smoothing'
export * from './backend'
