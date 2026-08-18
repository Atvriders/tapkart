// The barrel. Contract §4.8: it re-exports all nine modules of this package,
// because all nine are pure and headless-safe — this package has no adapter half
// to keep out of the barrel. It grows ONE LINE PER MODULE as the modules land,
// so that `tsc` never points at a file that does not exist yet.
export * from './hex'
export * from './uri'
export * from './invite'
export * from './t4t'
export * from './reader'
export * from './host'
export * from './applinks'
export * from './qr'
export * from './qr-tables'
