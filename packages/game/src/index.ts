// The @tapkart/game barrel. It re-exports the PURE modules only.
//
// Not `./controls/source` and not `./shell` — both are DOM adapters (§8.2) —
// and not `./controls/thumbzones`, `./controls/stick` or `./controls/keyboard`,
// whose factories reach the outside world only through makeControlAdapter.
// `./controls/tilt` IS re-exported, because Settings names TiltCalibration and
// the screens call calibrateTilt; makeTiltAdapter rides along and is harmless.
//
// There is no `content/` directory in this package at all: R46 moved the tuning,
// the descriptors, the themes and the tracks to @tapkart/content, because
// Plan 4's shadow authority needs them and spec §3 forbids `server` from
// depending on `game`. There is no `./roomcode` either: §5.8 retired in favour of
// @tapkart/protocol, whose room-code alphabet ORDER is the 5-bit wire index.
export * from './clock'
export * from './controls/types'
export * from './controls/config'
export * from './controls/tilt'
export * from './controls/composite'
export * from './controls/index'
export * from './settings'
export * from './app'
export * from './results'
export * from './session'
export * from './localinput'
export * from './multiplayer'
export * from './multiplayer-session'
export * from './view'
export * from './display'
