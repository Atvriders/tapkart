import { describe, expect, it } from 'vitest'
import type {
  AuthEvent,
  DriftState,
  EntityState,
  Intent,
  KartState,
  LapProgress,
  SimState,
  Vec3,
} from '../src/types'
import {
  COUNTDOWN_TICKS,
  MAX_ENTITIES,
  MAX_KARTS,
  RACE_LAPS,
  TICK_DT,
  TICK_HZ,
} from '../src/types'

describe('sim constants', () => {
  it('freezes the tick rate and its reciprocal', () => {
    expect(TICK_HZ).toBe(60)
    expect(TICK_DT).toBe(1 / 60)
    // 1/60 is not exactly representable in float64; the literal below is the
    // nearest double, and TICK_DT must be that exact double.
    expect(TICK_DT).toBe(0.016666666666666666)
    // 60 * (1/60) rounds back to exactly 1.
    expect(TICK_HZ * TICK_DT).toBe(1)
  })

  it('freezes the race shape', () => {
    expect(MAX_KARTS).toBe(8)
    expect(MAX_ENTITIES).toBe(32)
    expect(RACE_LAPS).toBe(3)
  })

  it('countdown is exactly three seconds of ticks', () => {
    expect(COUNTDOWN_TICKS).toBe(180)
    expect(COUNTDOWN_TICKS).toBe(TICK_HZ * 3) // 60 * 3 = 180
    expect(COUNTDOWN_TICKS * TICK_DT).toBe(3) // 180 / 60 = 3 seconds
  })
})

describe('type shapes compile and instantiate', () => {
  it('builds an Intent with every field the contract lists', () => {
    const intent: Intent = {
      tick: 7,
      steer: -1,
      accel: 1,
      brake: false,
      drift: true,
      useItem: false,
    }
    expect(intent.tick).toBe(7)
    expect(intent.steer).toBe(-1)
    expect(intent.accel).toBe(1)
    expect(intent.brake).toBe(false)
    expect(intent.drift).toBe(true)
    expect(intent.useItem).toBe(false)
  })

  it('builds a KartState with all 18 fields', () => {
    const position: Vec3 = { x: 0, y: 0, z: 0 }
    const velocity: Vec3 = { x: 0, y: 0, z: 0 }
    const drift: DriftState = { active: false, dir: 0, charge: 0 }
    const lap: LapProgress = { lap: 0, checkpointIdx: 0, t: 0 }
    const kart: KartState = {
      playerId: 0,
      characterIdx: 0,
      isBot: false,
      connected: true,
      position,
      velocity,
      heading: 0,
      angularVelocity: 0,
      drift,
      item: 'none',
      airborne: false,
      surface: 'tarmac',
      spinOutTicks: 0,
      invulnTicks: 0,
      boostTicks: 0,
      respawnTicks: 0,
      shielded: false,
      lap,
    }
    // 18 fields exactly. If this number changes, the WireSnapshot table in the
    // design spec is out of date, because that table is a complete projection
    // of the kart struct.
    expect(Object.keys(kart).length).toBe(18)
    expect(kart.item).toBe('none')
    expect(kart.surface).toBe('tarmac')
    expect(kart.drift.dir).toBe(0)
  })

  it('uses -1 as the dead-slot and not-applicable sentinel', () => {
    const dead: EntityState = {
      entityId: -1,
      kind: 'seeker',
      ownerId: -1,
      position: { x: 0, y: 0, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
      heading: 0,
      targetId: -1,
      ttl: 0,
    }
    expect(dead.entityId).toBe(-1)

    const ev: AuthEvent = {
      eventSeq: 0,
      tick: 0,
      kind: 'spinOut',
      playerId: 3,
      entityId: -1,
      item: 'none',
      data: 0,
    }
    expect(ev.entityId).toBe(-1)
    expect(ev.item).toBe('none')
    expect(ev.data).toBe(0)
  })

  it('uses -1 as SimState.finishTick before anyone finishes', () => {
    const partial: Pick<SimState, 'tick' | 'phase' | 'finishTick' | 'rngCursor'> = {
      tick: 0,
      phase: 'countdown',
      finishTick: -1,
      rngCursor: 0,
    }
    expect(partial.finishTick).toBe(-1)
    expect(partial.phase).toBe('countdown')
  })
})
