// Public barrel for @tapkart/net.
//
// packages/net/package.json maps "." to this file, so this list IS the package's
// public surface: Plan 3's game and Plan 4's server import the netcode through
// `@tapkart/net` and get exactly what is re-exported here.
//
// Task 11 created it re-exporting transport.ts and each later task appended its
// own line, so by the time Task 18 ran there was nothing left to widen - what
// Task 18 added is test/barrel.test.ts, which PINS THE EXACT SET of names this
// file produces. That test is the reason to read this list as deliberate rather
// than accumulated: adding or removing a name here now shows up as a diff in
// that test, at review time, instead of in a downstream package months later.
//
// The nine modules, in the order the locked contract's module map lists them
// plus the three later additions:
//   - clock   [15c] TICK_MS (moved here from client.ts - same binding, same
//             barrel surface), advanceAccumulator and MAX_CATCHUP_TICKS, which
//             Plan 3's game clock and Plan 4's server ticker both reach for and
//             which must not come to exist twice.
//   - local   [15b] the host's own input path; nothing else in this package
//             lets a host drive its kart.
//   - receive [15b] the datagram guard every loop's onMessage goes through,
//             plus droppedDatagramsOf.
//
// `export *` carries types and values together and is legal under
// isolatedModules. `transport` contributes NOTHING at runtime (Transport is an
// interface, erased at compile time) but its line is still required and still
// checked. No two modules below export the same name, so no re-export is
// ambiguous - barrel.test.ts asserts that at runtime rather than leaving it to
// this comment, because an ambiguous star-export is silently dropped from the
// ESM namespace instead of reported.
//
// Nothing under test/ is ever re-exported here: a fixture in the public surface
// is a fixture in the game bundle, and barrel.test.ts checks every export of
// every fixture module by name.
export * from './clock'
export * from './transport'
export * from './loopback'
export * from './apply'
export * from './authority'
export * from './client'
export * from './shadow'
export * from './local'
export * from './receive'
