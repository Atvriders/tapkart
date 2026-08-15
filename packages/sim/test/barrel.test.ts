import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import type { AuthEvent } from '../src/index'
import * as sim from '../src/index'
import {
  // types [Task 2]
  COUNTDOWN_TICKS,
  MAX_ENTITIES,
  MAX_KARTS,
  RACE_LAPS,
  TICK_DT,
  TICK_HZ,
  // vec3 [Task 2]
  v3,
  v3add,
  v3dot,
  v3len,
  v3scale,
  // mathutil [Task 2]
  clamp,
  lerp,
  wrapAngle,
  // rng [Task 2]
  rngAt,
  // track [Tasks 3 and 4]
  buildTrackQuery,
  validateTrack,
  // state [Task 5]
  cloneState,
  createState,
  emit,
  statesEqual,
  // step [Task 5]
  step,
  // kart [Task 6]
  stepKart,
  targetSpeedFor,
  // ground [Task 7]
  applyAirYaw,
  applyRamps,
  integrateVertical,
  // drift [Task 8]
  decayBoost,
  updateDrift,
  // recovery [Task 9]
  steeringLocked,
  surfaceSpeedFactor,
  updateRecovery,
  // collision [Task 10]
  resolveKartCollisions,
  // laps [Task 11]
  updateLaps,
  // placement [Task 11]
  computePlacement,
  placementOrder,
  // entity [Task 12]
  despawnEntityAt,
  kartById,
  spawnEntity,
  surgeActiveOn,
  updateEntities,
  // items [Task 13]
  rollItem,
  updateItemBoxes,
  useItem,
  // bot [Task 14]
  botIntent,
  // phase [Task 15]
  FINISH_GRACE_TICKS,
  makeIntentBuffer,
  resolveInputs,
  updatePhase,
  // replay [Task 16]
  INTENT_HEADER,
  INTENT_STRIDE,
  allocStateLike,
  intentOffset,
  recordRun,
  replayRun,
} from '../src/index'

// The same three bindings imported straight from their own modules, to prove the
// barrel re-exports them rather than redeclaring anything.
import { botIntent as botIntentDirect } from '../src/bot'
import { createState as createStateDirect } from '../src/state'
import { step as stepDirect } from '../src/step'

// Every module as a namespace, for the ambiguity scan.
import * as botNs from '../src/bot'
import * as collisionNs from '../src/collision'
import * as driftNs from '../src/drift'
import * as entityNs from '../src/entity'
import * as groundNs from '../src/ground'
import * as itemsNs from '../src/items'
import * as kartNs from '../src/kart'
import * as lapsNs from '../src/laps'
import * as mathutilNs from '../src/mathutil'
import * as phaseNs from '../src/phase'
import * as placementNs from '../src/placement'
import * as recoveryNs from '../src/recovery'
import * as replayNs from '../src/replay'
import * as rngNs from '../src/rng'
import * as stateNs from '../src/state'
import * as stepNs from '../src/step'
import * as trackNs from '../src/track'
import * as typesNs from '../src/types'
import * as vec3Ns from '../src/vec3'

import { makeContext, makeStraightTrack } from './fixtures/track-fixtures'

const HERE = dirname(fileURLToPath(import.meta.url))   // packages/sim/test
const SRC = join(HERE, '..', 'src')

/** The nineteen modules the barrel must re-export, in the locked contract's order. */
const BARREL_MODULES = [
  'types',
  'vec3',
  'mathutil',
  'rng',
  'track',
  'state',
  'step',
  'kart',
  'ground',
  'drift',
  'recovery',
  'collision',
  'laps',
  'placement',
  'entity',
  'items',
  'bot',
  'phase',
  'replay',
]

const NAMESPACES: [string, object][] = [
  ['types', typesNs],
  ['vec3', vec3Ns],
  ['mathutil', mathutilNs],
  ['rng', rngNs],
  ['track', trackNs],
  ['state', stateNs],
  ['step', stepNs],
  ['kart', kartNs],
  ['ground', groundNs],
  ['drift', driftNs],
  ['recovery', recoveryNs],
  ['collision', collisionNs],
  ['laps', lapsNs],
  ['placement', placementNs],
  ['entity', entityNs],
  ['items', itemsNs],
  ['bot', botNs],
  ['phase', phaseNs],
  ['replay', replayNs],
]

describe('@tapkart/sim barrel', () => {
  it('exports a named function from every simulation module', () => {
    const fns: [string, unknown][] = [
      ['vec3.v3', v3],
      ['vec3.v3add', v3add],
      ['vec3.v3scale', v3scale],
      ['vec3.v3len', v3len],
      ['vec3.v3dot', v3dot],
      ['mathutil.clamp', clamp],
      ['mathutil.lerp', lerp],
      ['mathutil.wrapAngle', wrapAngle],
      ['rng.rngAt', rngAt],
      ['track.validateTrack', validateTrack],
      ['track.buildTrackQuery', buildTrackQuery],
      ['state.createState', createState],
      ['state.cloneState', cloneState],
      ['state.statesEqual', statesEqual],
      ['state.emit', emit],
      ['step.step', step],
      ['kart.stepKart', stepKart],
      ['kart.targetSpeedFor', targetSpeedFor],
      ['ground.applyAirYaw', applyAirYaw],
      ['ground.integrateVertical', integrateVertical],
      ['ground.applyRamps', applyRamps],
      ['drift.updateDrift', updateDrift],
      ['drift.decayBoost', decayBoost],
      ['recovery.steeringLocked', steeringLocked],
      ['recovery.surfaceSpeedFactor', surfaceSpeedFactor],
      ['recovery.updateRecovery', updateRecovery],
      ['collision.resolveKartCollisions', resolveKartCollisions],
      ['laps.updateLaps', updateLaps],
      ['placement.placementOrder', placementOrder],
      ['placement.computePlacement', computePlacement],
      ['entity.spawnEntity', spawnEntity],
      ['entity.despawnEntityAt', despawnEntityAt],
      ['entity.kartById', kartById],
      ['entity.updateEntities', updateEntities],
      ['entity.surgeActiveOn', surgeActiveOn],
      ['items.updateItemBoxes', updateItemBoxes],
      ['items.rollItem', rollItem],
      ['items.useItem', useItem],
      ['bot.botIntent', botIntent],
      ['phase.makeIntentBuffer', makeIntentBuffer],
      ['phase.resolveInputs', resolveInputs],
      ['phase.updatePhase', updatePhase],
      ['replay.intentOffset', intentOffset],
      ['replay.allocStateLike', allocStateLike],
      ['replay.recordRun', recordRun],
      ['replay.replayRun', replayRun],
    ]
    // 46 functions across the 18 modules that export any. The nineteenth,
    // `types`, exports only constants and types; the constants test below
    // covers it. 5 vec3 + 3 mathutil + 1 rng + 2 track + 4 state + 1 step
    // + 2 kart + 3 ground + 2 drift + 3 recovery + 1 collision + 1 laps
    // + 2 placement + 5 entity + 3 items + 1 bot + 3 phase + 4 replay = 46.
    expect(fns).toHaveLength(46)
    for (const [name, fn] of fns) {
      expect(typeof fn, `${name} did not come through the barrel as a function`).toBe('function')
    }
  })

  it('carries the contract constants through unchanged', () => {
    expect(TICK_HZ).toBe(60)
    expect(TICK_DT).toBe(1 / 60)
    expect(MAX_KARTS).toBe(8)
    expect(MAX_ENTITIES).toBe(32)
    expect(RACE_LAPS).toBe(3)
    expect(COUNTDOWN_TICKS).toBe(180)
    expect(FINISH_GRACE_TICKS).toBe(1800)   // phase.ts [Task 15], 30 s at 60 Hz
    expect(INTENT_HEADER).toBe(4)           // replay.ts [Task 16]
    expect(INTENT_STRIDE).toBe(5)
  })

  it('re-exports each module\'s own binding, not a copy', () => {
    expect(step).toBe(stepDirect)
    expect(createState).toBe(createStateDirect)
    expect(botIntent).toBe(botIntentDirect)
  })

  it('lists every module in src/ exactly once, and no test fixture', () => {
    const onDisk = readdirSync(SRC)
      .filter((f) => f.endsWith('.ts') && f !== 'index.ts')
      .map((f) => f.slice(0, -3))
      .sort()
    expect(onDisk).toEqual([...BARREL_MODULES].sort())

    const barrel = readFileSync(join(SRC, 'index.ts'), 'utf8')
    for (const name of BARREL_MODULES) {
      const line = `export * from './${name}'`
      expect(barrel, `barrel is missing ${line}`).toContain(line)
      expect(barrel.split(line).length - 1, `${line} appears more than once`).toBe(1)
    }

    // Fixtures live in test/, so none of them can be part of the public surface.
    expect(Object.prototype.hasOwnProperty.call(sim, 'makeOvalTrack')).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(sim, 'makeTuning')).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(sim, 'makeContext')).toBe(false)
  })

  it('has no ambiguous re-export, and forwards every runtime export', () => {
    const owners = new Map<string, string[]>()
    for (const [mod, ns] of NAMESPACES) {
      for (const key of Object.keys(ns)) {
        const list = owners.get(key) ?? []
        list.push(mod)
        owners.set(key, list)
      }
    }
    // An ambiguous name is silently dropped from an ESM namespace and becomes a
    // SyntaxError at the import site, so it must not exist in the first place.
    const clashes = Array.from(owners.entries()).filter(([, mods]) => mods.length > 1)
    expect(clashes).toEqual([])

    for (const [mod, ns] of NAMESPACES) {
      for (const key of Object.keys(ns)) {
        expect(
          Object.prototype.hasOwnProperty.call(sim, key),
          `${mod}.${key} is not reachable through the barrel`,
        ).toBe(true)
      }
    }
  })

  it('runs a tick through the barrel alone', () => {
    const ctx = makeContext(makeStraightTrack())
    const chars = [0, 1, 2, 3, 4, 5, 6, 7]
    const prev = createState(ctx, 0x7a17, chars)
    const next = createState(ctx, 0x7a17, chars)
    const inputs = makeIntentBuffer()
    const events: AuthEvent[] = []

    step(ctx, prev, next, inputs, events)

    expect(next.tick).toBe(1)
    expect(prev.tick).toBe(0)                 // step never mutates prev
    expect(next.karts).toHaveLength(MAX_KARTS)
    expect(next.entities).toHaveLength(MAX_ENTITIES)
    expect(next.phase).toBe('countdown')      // tick 1 < COUNTDOWN_TICKS (180)
  })

  it('resolves through the @tapkart/sim package entry point', async () => {
    // package.json maps "." to ./src/index.ts, which is the exact path Plan 2's
    // net/server/game packages will import. Dynamic, so a resolution failure
    // fails this one test instead of preventing the file from being collected.
    const pkg = await import('@tapkart/sim')
    expect(pkg.step).toBe(stepDirect)
    expect(pkg.createState).toBe(createStateDirect)
    expect(pkg.MAX_KARTS).toBe(8)
  })
})
