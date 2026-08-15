// Shared test fixtures for @tapkart/game (contract §9.1).
//
// LATER TASKS APPEND TO THIS FILE. It is the one fixture module the game package
// has; overwriting it deletes another task's fixtures.
import type { ControlInputs } from '../../src/controls/types'
import { createControlInputs } from '../../src/controls/types'
import type { Settings } from '../../src/settings'
import { DEFAULT_SETTINGS } from '../../src/settings'
import { CHARACTERS } from '@tapkart/content'
import { MAX_KARTS } from '@tapkart/sim'
import type { LobbySlot } from '../../src/app'

/** A fully-allocated ControlInputs with a landscape viewport, no pointers down,
 *  no keys down and no tilt. `overrides` replaces whole fields, not deep merges. */
export function makeControlInputsFixture(overrides?: Partial<ControlInputs>): ControlInputs {
  const raw = createControlInputs()
  raw.viewport.width = 800
  raw.viewport.height = 400
  if (overrides === undefined) return raw
  if (overrides.pointers !== undefined) raw.pointers = overrides.pointers
  if (overrides.pointerCount !== undefined) raw.pointerCount = overrides.pointerCount
  if (overrides.keys !== undefined) raw.keys = overrides.keys
  if (overrides.tilt !== undefined) raw.tilt = overrides.tilt
  if (overrides.viewport !== undefined) raw.viewport = overrides.viewport
  return raw
}

/** DEFAULT_SETTINGS with a fresh, independently mutable tiltCalibration. */
export function makeSettingsFixture(overrides?: Partial<Settings>): Settings {
  return {
    ...DEFAULT_SETTINGS,
    tiltCalibration: { ...DEFAULT_SETTINGS.tiltCalibration },
    ...overrides,
  }
}

/** MAX_KARTS filled slots. Seats in humanIds are connected humans; every other
 * seat is a bot. */
export function makeLobbySlots(humanIds: readonly number[] = [0]): LobbySlot[] {
  const slots: LobbySlot[] = []
  for (let i = 0; i < MAX_KARTS; i++) {
    const human = humanIds.includes(i)
    slots.push({
      playerId: i,
      name: human ? 'Player ' + i : 'Bot ' + i,
      characterIdx: i % CHARACTERS.length,
      isBot: !human,
      connected: true,
      ready: true,
    })
  }
  return slots
}
