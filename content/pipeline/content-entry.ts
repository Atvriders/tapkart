// Entry point for the gate bundle: re-exports the REAL parsers so
// `gate-descriptors.mjs` judges a generated record with the same code the game runs.
// A second implementation of these rules could drift and accept records the game rejects.
export { parseCharacterDescriptor, parseKartDescriptor } from '../../packages/content/src/descriptors'
export { parseTrackTheme } from '../../packages/content/src/theme'
