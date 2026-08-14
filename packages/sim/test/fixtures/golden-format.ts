// Golden-replay fixture format: constants, tolerances, the intent-stream codec,
// the CI regeneration guard, and fixture load/save.
//
// The comparison this format supports is field-by-field, NOT a digest. A digest
// mismatch names no field, no value and no delta, so it cannot tell a harmless
// last-bit re-association from a kart falling through the floor. See GOLDEN.md.
import { Buffer } from 'node:buffer'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { EntityKind, Intent, ItemKind, RacePhase, Surface } from '../../src/types'
import { MAX_KARTS } from '../../src/types'
import { clamp } from '../../src/mathutil'

export const GOLDEN_FORMAT_VERSION = 1

/** Race seed for the golden run. Fixed forever; changing it invalidates the fixture. */
export const GOLDEN_SEED = 20260813

/** One of each of the eight characters, so every stat row is exercised. */
export const GOLDEN_CHARACTER_IDX: number[] = [0, 1, 2, 3, 4, 5, 6, 7]

/** Ticks recorded after the last kart finishes, so the fixture also pins the post-race state. */
export const GOLDEN_TAIL_TICKS = 60

/** Runaway guard: 18000 ticks = 5 minutes at 60Hz. A race longer than this is a bug. */
export const MAX_GOLDEN_TICKS = 18000

/** Recorded steer/accel are quantised to 1/10000 so the stream is exactly reproducible. */
export const INTENT_SCALE = 10000

/** int16 steer + int16 accel + uint8 flags. */
export const INTENT_BYTES_PER_KART = 5

/** The packed stream is stored as base64 split into short lines so git can diff it. */
export const B64_LINE_LENGTH = 120

export const GOLDEN_REGEN_COMMAND =
  'UPDATE_GOLDEN=1 npx vitest run packages/sim/test/golden-regen.test.ts'

const HERE = dirname(fileURLToPath(import.meta.url))

export const GOLDEN_PATH = join(HERE, 'golden-oval-3lap-8bot.json')

/** Any of these, set to anything other than empty/0/false, blocks regeneration. */
export const CI_ENV_FLAGS: readonly string[] = ['CI', 'GITHUB_ACTIONS', 'CONTINUOUS_INTEGRATION']

export interface GoldenTolerance {
  position: number
  velocity: number
  heading: number
  angularVelocity: number
  driftCharge: number
  lapT: number
}

/**
 * Per-field tolerances for the continuous fields only. Everything else compares exactly.
 *
 * Sizing: one ULP at a position magnitude of ~1e3 m is ~1.1e-13 m, so ~4000 ticks of
 * fully-correlated round-off is bounded near 4e-10 m. The smallest physically meaningful
 * change is one tick of acceleration: accelRate 24 m/s^2 * TICK_DT (1/60 s) = 0.4 m/s,
 * i.e. 6.7e-3 m of position. 1e-6 sits between them with ~6 orders of magnitude either side.
 */
export const GOLDEN_TOL: GoldenTolerance = {
  position: 1e-6,
  velocity: 1e-6,
  heading: 1e-7,
  angularVelocity: 1e-7,
  driftCharge: 1e-6,
  lapT: 1e-9,
}

/** One differing field. `tolerance === 0` means the field is compared exactly. */
export interface FieldDiff {
  path: string
  expected: number | string | boolean
  actual: number | string | boolean
  delta: number
  tolerance: number
}

export interface GoldenLap {
  lap: number
  checkpointIdx: number
  t: number
}

export interface GoldenDrift {
  active: boolean
  dir: -1 | 0 | 1
  charge: number
}

export interface GoldenKart {
  playerId: number
  characterIdx: number
  isBot: boolean
  connected: boolean
  position: [number, number, number]
  velocity: [number, number, number]
  heading: number
  angularVelocity: number
  drift: GoldenDrift
  item: ItemKind
  airborne: boolean
  surface: Surface
  spinOutTicks: number
  invulnTicks: number
  boostTicks: number
  respawnTicks: number
  shielded: boolean
  lap: GoldenLap
}

export interface GoldenEntity {
  entityId: number
  kind: EntityKind
  ownerId: number
  position: [number, number, number]
  velocity: [number, number, number]
  heading: number
  targetId: number
  ttl: number
}

export interface GoldenExpectation {
  tick: number
  phase: RacePhase
  raceSeed: number
  rngCursor: number
  nextEventSeq: number
  finishTick: number
  entityCount: number
  nextEntityId: number
  finishedOrder: number[]
  itemBoxes: { boxIdx: number; respawnTicks: number }[]
  karts: GoldenKart[]
  /** Exactly `entityCount` live records. Slots at or beyond it must hold entityId -1. */
  entities: GoldenEntity[]
}

export interface GoldenEventSummary {
  total: number
  countsByKind: Record<string, number>
  finishes: { playerId: number; tick: number }[]
}

export interface GoldenFixture {
  formatVersion: number
  /** The command that regenerates this file. No timestamps, no hostnames, no absolute paths. */
  generatedBy: string
  trackId: string
  raceSeed: number
  characterIdx: number[]
  tickCount: number
  intentScale: number
  intentsB64: string[]
  expected: GoldenExpectation
  events: GoldenEventSummary
}

/** JSON has no -0, so -0 and +0 must compare equal on both sides. */
export function normZero(v: number): number {
  return v === 0 ? 0 : v
}

/**
 * Snap an intent onto the 1/10000 grid the fixture stores. The generator quantises before
 * simulating, so the recorded stream is byte-identical to the stream that produced the
 * expectation and replay is exact rather than merely close.
 */
export function quantizeIntent(src: Intent, tick: number): Intent {
  if (!Number.isFinite(src.steer) || !Number.isFinite(src.accel)) {
    throw new Error(
      `golden: non-finite intent at tick ${tick}: steer=${src.steer} accel=${src.accel}`,
    )
  }
  const steerQ = normZero(Math.round(clamp(src.steer, -1, 1) * INTENT_SCALE))
  const accelQ = normZero(Math.round(clamp(src.accel, 0, 1) * INTENT_SCALE))
  return {
    tick,
    steer: steerQ / INTENT_SCALE,
    accel: accelQ / INTENT_SCALE,
    brake: src.brake === true,
    drift: src.drift === true,
    useItem: src.useItem === true,
  }
}

export function packIntents(intents: Intent[][]): Uint8Array {
  const tickCount = intents.length
  const bytes = new Uint8Array(tickCount * MAX_KARTS * INTENT_BYTES_PER_KART)
  const dv = new DataView(bytes.buffer)
  for (let t = 0; t < tickCount; t++) {
    const row = intents[t]
    if (row.length !== MAX_KARTS) {
      throw new Error(`golden: intent row ${t} has ${row.length} karts, expected ${MAX_KARTS}`)
    }
    for (let i = 0; i < MAX_KARTS; i++) {
      const off = (t * MAX_KARTS + i) * INTENT_BYTES_PER_KART
      const it = row[i]
      dv.setInt16(off, normZero(Math.round(it.steer * INTENT_SCALE)), true)
      dv.setInt16(off + 2, normZero(Math.round(it.accel * INTENT_SCALE)), true)
      dv.setUint8(off + 4, (it.brake ? 1 : 0) | (it.drift ? 2 : 0) | (it.useItem ? 4 : 0))
    }
  }
  return bytes
}

export function unpackIntents(bytes: Uint8Array, tickCount: number): Intent[][] {
  const need = tickCount * MAX_KARTS * INTENT_BYTES_PER_KART
  if (bytes.length !== need) {
    throw new Error(
      `golden: intent stream is ${bytes.length} bytes, expected ${need} for ${tickCount} ticks`,
    )
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const out: Intent[][] = []
  for (let t = 0; t < tickCount; t++) {
    const row: Intent[] = []
    for (let i = 0; i < MAX_KARTS; i++) {
      const off = (t * MAX_KARTS + i) * INTENT_BYTES_PER_KART
      const flags = dv.getUint8(off + 4)
      row.push({
        tick: t,
        steer: dv.getInt16(off, true) / INTENT_SCALE,
        accel: dv.getInt16(off + 2, true) / INTENT_SCALE,
        brake: (flags & 1) !== 0,
        drift: (flags & 2) !== 0,
        useItem: (flags & 4) !== 0,
      })
    }
    out.push(row)
  }
  return out
}

export function encodeB64Lines(bytes: Uint8Array): string[] {
  const b64 = Buffer.from(bytes).toString('base64')
  const out: string[] = []
  for (let i = 0; i < b64.length; i += B64_LINE_LENGTH) {
    out.push(b64.slice(i, i + B64_LINE_LENGTH))
  }
  return out
}

export function decodeB64Lines(lines: string[]): Uint8Array {
  return new Uint8Array(Buffer.from(lines.join(''), 'base64'))
}

/**
 * A regenerated golden fixture is a claim that a physics change was intentional. That claim can
 * only be made by a human looking at the diff, so regeneration is refused inside CI.
 */
export function assertRegenerationAllowed(env: Record<string, string | undefined>): void {
  for (const name of CI_ENV_FLAGS) {
    const raw = env[name]
    if (raw === undefined) continue
    const v = raw.trim().toLowerCase()
    if (v === '' || v === '0' || v === 'false') continue
    throw new Error(
      `golden: refusing to regenerate because ${name}=${raw}. A regenerated golden fixture is a ` +
        'claim that a physics change was intentional; it must be produced on a developer machine ' +
        `and reviewed in the diff. Unset ${name} to proceed.`,
    )
  }
}

export function readGoldenFixtureText(path: string = GOLDEN_PATH): string {
  return readFileSync(path, 'utf8')
}

export function loadGoldenFixture(path: string = GOLDEN_PATH): GoldenFixture {
  const fx = JSON.parse(readGoldenFixtureText(path)) as GoldenFixture
  if (fx.formatVersion !== GOLDEN_FORMAT_VERSION) {
    throw new Error(
      `golden: fixture formatVersion ${fx.formatVersion}, this build expects ` +
        `${GOLDEN_FORMAT_VERSION}. Regenerate it with: ${GOLDEN_REGEN_COMMAND}`,
    )
  }
  return fx
}

export function saveGoldenFixture(fx: GoldenFixture, path: string = GOLDEN_PATH): void {
  writeFileSync(path, `${JSON.stringify(fx, null, 2)}\n`, 'utf8')
}
