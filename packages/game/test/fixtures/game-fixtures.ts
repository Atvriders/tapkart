// Shared test fixtures for @tapkart/game (contract §9.1).
//
// LATER TASKS APPEND TO THIS FILE. It is the one fixture module the game package
// has; overwriting it deletes another task's fixtures.
import type { ControlInputs } from '../../src/controls/types'
import { createControlInputs } from '../../src/controls/types'
import type { Settings } from '../../src/settings'
import { DEFAULT_SETTINGS } from '../../src/settings'
import type { SimContext } from '@tapkart/sim'
import { makeContext, makeOvalTrack } from '../../../sim/test/fixtures/track-fixtures'
import type { LoopbackOptions } from '@tapkart/net'
import { makeLoopbackPair, withLocalInput } from '@tapkart/net'
import type { RaceSession } from '../../src/session'
import { createSession } from '../../src/session'
import { renderNowMs } from '../../src/clock'

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

/** The shared sim fixture context for game-side race tests. */
export function makeGameContext(isLeader = true): SimContext {
  return makeContext(makeOvalTrack(), isLeader)
}

const DEFAULT_LOOPBACK: LoopbackOptions = {
  latencyMs: 150,
  jitterMs: 50,
  lossRate: 0.05,
  seed: 0xc0ffee,
}

const PAIR_CHARACTER_IDX = [0, 1, 2, 3, 4, 5, 6, 7]

/** A host and guest connected through one shared loopback pair. */
export function makeSessionPair(opts: Partial<LoopbackOptions> = {}): {
  host: RaceSession
  guest: RaceSession
  pump(nowMs: number): void
} {
  const pair = makeLoopbackPair({ ...DEFAULT_LOOPBACK, ...opts })
  const host = createSession({
    role: 'host',
    ctx: makeGameContext(true),
    localPlayerId: 0,
    seed: 0x7A1E,
    characterIdx: PAIR_CHARACTER_IDX.slice(),
    transport: withLocalInput(pair.a),
  })
  const guest = createSession({
    role: 'guest',
    ctx: makeGameContext(false),
    localPlayerId: 1,
    seed: 0x7A1E,
    characterIdx: PAIR_CHARACTER_IDX.slice(),
    transport: pair.b,
  })

  // The authority must route seat 1 through the guest's received intents.
  host.state().karts[1].isBot = false
  host.state().karts[1].connected = true
  return { host, guest, pump: pair.pump }
}

/** A host/guest pair driven long enough to provide reconciliation deltas. */
export function makeCorrectingGuest(ticks = 600): {
  host: RaceSession
  guest: RaceSession
  pump(nowMs: number): void
  corrections(): number
} {
  const pair = makeSessionPair()
  const hostIntent = {
    tick: 0,
    steer: 0.1,
    accel: 1,
    brake: false,
    drift: false,
    useItem: false,
  }
  const guestIntent = {
    tick: 0,
    steer: 0,
    accel: 1,
    brake: false,
    drift: false,
    useItem: false,
  }

  for (let tick = 1; tick <= ticks; tick++) {
    guestIntent.steer = Math.sin(tick / 12)
    pair.host.tickOnce(hostIntent)
    pair.guest.tickOnce(guestIntent)
    pair.pump(renderNowMs(tick, 0))
  }

  return { ...pair, corrections: () => pair.guest.corrections() }
}
