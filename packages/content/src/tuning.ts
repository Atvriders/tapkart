// PURE. Data only: no DOM, no clock, no three, no bundler feature.
import type { CharacterStats, Tuning } from '@tapkart/sim'

/** The Tuning the game actually races with — and the one the shadow authority
 *  runs step() with, which is why this is not in `game`. */
export const TUNING: Readonly<Tuning> = {
  maxSpeed: 40,
  accelRate: 24,
  brakeRate: 48,
  steerRateBase: 2.6,
  steerSpeedFalloff: 0.55,
  gripTarmac: 14,
  gripDirt: 5,
  gripDrift: 3,
  gravity: 30,
  airYaw: 0.6,
  offtrackSpeedMul: 0.55,
  respawnTicks: 72,
  invulnTicks: 90,
  spinOutTicks: 60,
  driftMinSpeed: 8,
  driftTiers: [40, 90, 150],
  driftBoosts: [24, 42, 66],
  boostSpeedMul: 1.35,
  surgeSpeedMul: 0.7,
  kartRadius: 0.9,
  kartRestitution: 0.4,
  itemBoxRespawnTicks: 180,
  seekerSpeed: 55,
  boltSpeed: 65,
  entityTtl: 600,
}

/** The eight shipped characters' handling stats. Same index space as
 *  CHARACTER_DESCRIPTORS, KART_DESCRIPTORS and KartState.characterIdx.
 *
 *  `name` here is never displayed — it is 'Racer 3' because these rows must equal
 *  makeCharacters() field for field; the displayed name is CHARACTER_DESCRIPTORS[i].name.
 *  Nothing joins the two arrays by `id`; they are joined by array index only.
 *
 *  readonly, so it does NOT assign into SimContext.characters. Every composition
 *  root writes `characters: CHARACTERS.slice()` — a copy, not a cast. */
export const CHARACTERS: readonly CharacterStats[] = [
  { id: 'c0', name: 'Racer 0', speed: 1.0, accel: 1.0, handling: 1.0, weight: 1.0 },
  { id: 'c1', name: 'Racer 1', speed: 1.1, accel: 0.85, handling: 0.9, weight: 1.2 },
  { id: 'c2', name: 'Racer 2', speed: 0.92, accel: 1.15, handling: 1.1, weight: 0.85 },
  { id: 'c3', name: 'Racer 3', speed: 1.05, accel: 0.9, handling: 0.95, weight: 1.1 },
  { id: 'c4', name: 'Racer 4', speed: 0.95, accel: 1.1, handling: 1.05, weight: 0.9 },
  { id: 'c5', name: 'Racer 5', speed: 1.15, accel: 0.8, handling: 0.85, weight: 1.3 },
  { id: 'c6', name: 'Racer 6', speed: 0.88, accel: 1.2, handling: 1.15, weight: 0.8 },
  { id: 'c7', name: 'Racer 7', speed: 1.0, accel: 1.0, handling: 1.0, weight: 1.0 },
]
