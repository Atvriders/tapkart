// Public barrel for @tapkart/game.
//
// packages/game/package.json maps "." to this file, so this list IS the package's
// public surface. It grows one line per module as the tasks that ship them land
// (§5.15: controls/types, controls/config, controls/tilt, controls/composite,
// controls/index, settings, app, results, session, localinput, view -- and NOT
// roomcode, which retired: room codes are @tapkart/protocol's, because the
// alphabet's order is the 5-bit wire index).
//
// It will NEVER carry `controls/source` or `shell`: both are DOM adapters, and a
// barrel that re-exported them would break `import { reduceApp } from
// '@tapkart/game'` under vitest's environment: 'node' (§8.2). apps/web reaches
// startShell through the package's "./shell" export instead.
export * from './clock'
