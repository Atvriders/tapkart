// Public barrel for @tapkart/protocol.
//
// packages/protocol/package.json maps "." to this file, so this list IS the
// package's public surface: `net` today, and Plan 3's game and Plan 4's server,
// import the wire format through `@tapkart/protocol` and get exactly what is
// re-exported here.
//
// Each module task (3-10) appended its own line as its last implementation step,
// exactly as Plan 1's Tasks 3-10 did for packages/sim/src/index.ts, and Task 15c
// added `room`. Task 18 therefore had nothing to widen; what it added is
// test/barrel.test.ts, which PINS THE EXACT SET of names this file produces, so
// an addition or removal shows up as a diff in that test rather than as a
// surprise in a downstream package.
//
// `export *` carries types and values together and is legal under
// isolatedModules; only a named `export { SomeType }` would need `export type`.
// No two modules below export the same name, so no re-export is ambiguous -
// barrel.test.ts asserts that at runtime rather than leaving it to this comment,
// because an ambiguous star-export is silently dropped from the ESM namespace
// object instead of being reported.
export * from './types'
export * from './room'
export * from './bits'
export * from './strings'
export * from './quant'
export * from './snapshot'
export * from './checkpoint'
export * from './events'
export * from './input'
export * from './lobby'
export * from './control'
