import { describe, expect, it } from 'vitest'
import type { AuthEvent } from '../src/types'
import { MAX_ENTITIES, MAX_KARTS } from '../src/types'
import { EIGHT_STARTS, makeTestContext } from './helpers/flat-context'
import { cloneState, createState, emit, statesEqual } from '../src/state'

describe('createState', () => {
  it('places every kart at its start position, facing along the tangent', () => {
    const ctx = makeTestContext(EIGHT_STARTS)
    const st = createState(ctx, 12345, [0, 1, 2, 3, 4, 5, 6, 7])

    // s is arc-normalized. The flat query gives sampleAt(s) = (s * 1000, 0, 0)
    // and tangentAt(s) = (1, 0, 0), so right = (-t.z, 0, t.x) = (0, 0, 1):
    // +lateral offsets toward +z. groundHeight(s) = 0.5 * (s * 1000).
    // EIGHT_STARTS sits behind the line: seat i is (4 * (i+1)) m before s = 1 (== s = 0),
    // so its s is 1 - 4*(i+1)/1000. Every s * 1000 below is exact in binary floating
    // point (0.996 * 1000 === 996).
    // Seat 0: s = 0.996, lateral = 0  -> x = 996, z = 0,  y = 0.5 * 996 = 498
    expect(st.karts[0].position.x).toBe(996)
    expect(st.karts[0].position.z).toBe(0)
    expect(st.karts[0].position.y).toBe(498)
    // Seat 1: s = 0.992, lateral = 0  -> x = 992, z = 0,  y = 0.5 * 992 = 496
    expect(st.karts[1].position.x).toBe(992)
    expect(st.karts[1].position.z).toBe(0)
    expect(st.karts[1].position.y).toBe(496)
    // Seat 2: s = 0.988, lateral = 3  -> x = 988 + 0*3 = 988, z = 0 + 1*3 = 3, y = 0.5*988 = 494
    expect(st.karts[2].position.x).toBe(988)
    expect(st.karts[2].position.z).toBe(3)
    expect(st.karts[2].position.y).toBe(494)
    // Seat 3: s = 0.984, lateral = -3 -> x = 984, z = -3, y = 0.5 * 984 = 492
    expect(st.karts[3].position.x).toBe(984)
    expect(st.karts[3].position.z).toBe(-3)
    expect(st.karts[3].position.y).toBe(492)

    // heading = wrapAngle(atan2(t.z, t.x)) = wrapAngle(atan2(0, 1)) = 0
    for (let i = 0; i < MAX_KARTS; i++) {
      expect(st.karts[i].heading).toBe(0)
      expect(st.karts[i].angularVelocity).toBe(0)
      expect(st.karts[i].velocity.x).toBe(0)
      expect(st.karts[i].velocity.y).toBe(0)
      expect(st.karts[i].velocity.z).toBe(0)
    }

    // surfaceAt is consulted with (s, lateral): 'dirt' only where lateral > 2.
    expect(st.karts[2].surface).toBe('dirt')
    expect(st.karts[3].surface).toBe('tarmac')
    expect(st.karts[0].surface).toBe('tarmac')
  })

  it('starts the race in countdown with every counter zeroed', () => {
    const ctx = makeTestContext(EIGHT_STARTS)
    const st = createState(ctx, 12345, [0, 1, 2, 3, 4, 5, 6, 7])

    expect(st.tick).toBe(0)
    expect(st.phase).toBe('countdown')
    expect(st.raceSeed).toBe(12345)
    expect(st.rngCursor).toBe(0)
    expect(st.nextEventSeq).toBe(0)
    expect(st.finishTick).toBe(-1)
    expect(st.entityCount).toBe(0)
    expect(st.nextEntityId).toBe(1)
  })

  it('preallocates every array to its fixed length with dead slots marked -1', () => {
    const ctx = makeTestContext(EIGHT_STARTS)
    const st = createState(ctx, 1, [0, 0, 0, 0, 0, 0, 0, 0])

    expect(st.karts).toHaveLength(MAX_KARTS) // 8
    expect(st.entities).toHaveLength(MAX_ENTITIES) // 32
    expect(st.finishedOrder).toHaveLength(MAX_KARTS) // 8
    expect(st.itemBoxes).toHaveLength(3) // the flat track declares 3 item boxes

    for (let i = 0; i < MAX_ENTITIES; i++) {
      expect(st.entities[i].entityId).toBe(-1)
      expect(st.entities[i].ownerId).toBe(-1)
      expect(st.entities[i].targetId).toBe(-1)
      expect(st.entities[i].ttl).toBe(0)
      expect(st.entities[i].heading).toBe(0)
      expect(st.entities[i].position.x).toBe(0)
      expect(st.entities[i].velocity.z).toBe(0)
    }
    for (let i = 0; i < MAX_KARTS; i++) {
      expect(st.finishedOrder[i]).toBe(-1)
    }
    for (let i = 0; i < 3; i++) {
      expect(st.itemBoxes[i].boxIdx).toBe(i)
      expect(st.itemBoxes[i].respawnTicks).toBe(0)
    }
  })

  it('clamps characterIdx into range and defaults unsupplied seats to 0', () => {
    const ctx = makeTestContext(EIGHT_STARTS)
    // makeCharacters() returns exactly 8 characters, so the valid range is 0..7.
    const st = createState(ctx, 1, [7, 99, -3, 2.9])

    expect(st.karts[0].characterIdx).toBe(7) // in range
    expect(st.karts[1].characterIdx).toBe(7) // 99 clamped down to 8 - 1 = 7
    expect(st.karts[2].characterIdx).toBe(0) // -3 clamped up to 0
    expect(st.karts[3].characterIdx).toBe(2) // 2.9 truncated toward zero
    expect(st.karts[4].characterIdx).toBe(0) // seat not supplied
    expect(st.karts[7].characterIdx).toBe(0) // seat not supplied

    expect(st.karts[0].playerId).toBe(0)
    expect(st.karts[7].playerId).toBe(7)
    expect(st.karts[0].isBot).toBe(true)
    expect(st.karts[0].connected).toBe(false)
    expect(st.karts[0].item).toBe('none')
    expect(st.karts[0].airborne).toBe(false)
    expect(st.karts[0].shielded).toBe(false)
    expect(st.karts[0].spinOutTicks).toBe(0)
    expect(st.karts[0].invulnTicks).toBe(0)
    expect(st.karts[0].boostTicks).toBe(0)
    expect(st.karts[0].respawnTicks).toBe(0)
    expect(st.karts[0].drift.active).toBe(false)
    expect(st.karts[0].drift.dir).toBe(0)
    expect(st.karts[0].drift.charge).toBe(0)
    expect(st.karts[0].lap.lap).toBe(0)
    // The flat track declares 4 checkpoints, so the contract's initial value
    // checkpointS.length - 1 is 3. See the dedicated test below.
    expect(st.karts[0].lap.checkpointIdx).toBe(3)
    expect(st.karts[0].lap.t).toBe(0)
  })

  it('starts every kart behind checkpoint 0, at checkpointS.length - 1', () => {
    const ctx = makeTestContext(EIGHT_STARTS)
    const st = createState(ctx, 1, [])

    // The flat track declares 4 checkpoints (s = 0, 0.25, 0.5, 0.75), so the
    // initial index is 4 - 1 = 3: the kart is credited with the last checkpoint
    // of the notional previous lap, and its first legal crossing is index 0.
    for (let i = 0; i < MAX_KARTS; i++) {
      expect(st.karts[i].lap.checkpointIdx).toBe(3)
      expect(st.karts[i].lap.lap).toBe(0)
      expect(st.karts[i].lap.t).toBe(0)
    }

    // Two checkpoints -> 2 - 1 = 1.
    const twoCtx = makeTestContext(EIGHT_STARTS)
    twoCtx.track = { ...twoCtx.track, checkpointS: [0, 0.5] }
    expect(createState(twoCtx, 1, []).karts[0].lap.checkpointIdx).toBe(1)

    // A track with no checkpoints has no last index at all, so createState
    // writes -1 explicitly instead of computing 0 - 1 and calling it an index.
    const noneCtx = makeTestContext(EIGHT_STARTS)
    noneCtx.track = { ...noneCtx.track, checkpointS: [] }
    expect(createState(noneCtx, 1, []).karts[0].lap.checkpointIdx).toBe(-1)
  })
})

describe('cloneState / statesEqual', () => {
  it('copies every field so the clone is bit-equal to the source', () => {
    const ctx = makeTestContext(EIGHT_STARTS)
    const a = createState(ctx, 99, [0, 1, 2, 3, 4, 5, 6, 7])
    const b = createState(ctx, 0, [0, 0, 0, 0, 0, 0, 0, 0])

    a.tick = 17
    a.phase = 'racing'
    a.rngCursor = 5
    a.nextEventSeq = 11
    a.finishTick = 900
    a.entityCount = 1
    a.nextEntityId = 4
    a.karts[3].velocity.x = 12.5
    a.karts[3].drift.charge = 46
    a.karts[3].lap.lap = 2
    a.entities[0].entityId = 3
    a.entities[0].kind = 'bolt'
    a.entities[0].ownerId = 5
    a.entities[0].ttl = 120
    a.finishedOrder[0] = 6
    a.itemBoxes[2].respawnTicks = 41

    cloneState(a, b)

    expect(statesEqual(a, b)).toBe(true)
    expect(b.tick).toBe(17)
    expect(b.phase).toBe('racing')
    expect(b.raceSeed).toBe(99)
    expect(b.rngCursor).toBe(5)
    expect(b.nextEventSeq).toBe(11)
    expect(b.finishTick).toBe(900)
    expect(b.entityCount).toBe(1)
    expect(b.nextEntityId).toBe(4)
    expect(b.karts[3].characterIdx).toBe(3)
    expect(b.karts[3].velocity.x).toBe(12.5)
    expect(b.karts[3].drift.charge).toBe(46)
    expect(b.karts[3].lap.lap).toBe(2)
    expect(b.entities[0].entityId).toBe(3)
    expect(b.entities[0].kind).toBe('bolt')
    expect(b.entities[0].ownerId).toBe(5)
    expect(b.entities[0].ttl).toBe(120)
    expect(b.finishedOrder[0]).toBe(6)
    expect(b.itemBoxes[2].respawnTicks).toBe(41)
  })

  it('writes into dst in place, reusing every existing object', () => {
    const ctx = makeTestContext(EIGHT_STARTS)
    const a = createState(ctx, 1, [0, 1, 2, 3, 4, 5, 6, 7])
    const b = createState(ctx, 1, [0, 1, 2, 3, 4, 5, 6, 7])

    const kartsRef = b.karts
    const kartRef = b.karts[2]
    const posRef = b.karts[2].position
    const velRef = b.karts[2].velocity
    const driftRef = b.karts[2].drift
    const lapRef = b.karts[2].lap
    const entRef = b.entities[5]
    const entPosRef = b.entities[5].position
    const boxRef = b.itemBoxes[1]

    cloneState(a, b)

    expect(b.karts).toBe(kartsRef)
    expect(b.karts[2]).toBe(kartRef)
    expect(b.karts[2].position).toBe(posRef)
    expect(b.karts[2].velocity).toBe(velRef)
    expect(b.karts[2].drift).toBe(driftRef)
    expect(b.karts[2].lap).toBe(lapRef)
    expect(b.entities[5]).toBe(entRef)
    expect(b.entities[5].position).toBe(entPosRef)
    expect(b.itemBoxes[1]).toBe(boxRef)

    // and it is a deep copy, not an alias
    expect(b.karts[2].position).not.toBe(a.karts[2].position)
    a.karts[2].position.x = 777
    expect(b.karts[2].position.x).toBe(988) // seat 2 sits at s = 0.988 -> x = 988 m
  })

  it('rejects a dst that was not preallocated with the same shape', () => {
    const a = createState(makeTestContext(EIGHT_STARTS), 1, [])
    const smallCtx = makeTestContext(EIGHT_STARTS)
    smallCtx.track = { ...smallCtx.track, itemBoxes: [{ s: 0.01, lateral: 0 }] }
    const b = createState(smallCtx, 1, [])

    expect(a.itemBoxes).toHaveLength(3)
    expect(b.itemBoxes).toHaveLength(1)
    expect(() => cloneState(a, b)).toThrow(
      'cloneState: dst was not preallocated with the same shape as src',
    )
  })

  it('uses Object.is for every scalar: -0 differs from 0, NaN equals NaN', () => {
    const ctx = makeTestContext(EIGHT_STARTS)
    const a = createState(ctx, 5, [])
    const b = createState(ctx, 5, [])
    cloneState(a, b)
    expect(statesEqual(a, b)).toBe(true)

    a.karts[0].position.x = -0
    b.karts[0].position.x = 0
    expect(statesEqual(a, b)).toBe(false) // Object.is(-0, 0) === false

    b.karts[0].position.x = -0
    expect(statesEqual(a, b)).toBe(true)

    a.karts[1].velocity.z = NaN
    expect(statesEqual(a, b)).toBe(false)
    b.karts[1].velocity.z = NaN
    expect(statesEqual(a, b)).toBe(true) // Object.is(NaN, NaN) === true
  })

  it('detects a difference in any field, including dead entity slots', () => {
    const ctx = makeTestContext(EIGHT_STARTS)
    const a = createState(ctx, 5, [0, 1, 2, 3, 4, 5, 6, 7])
    const b = createState(ctx, 5, [0, 1, 2, 3, 4, 5, 6, 7])

    const differsAfter = (mutate: () => void): boolean => {
      cloneState(a, b)
      mutate()
      return statesEqual(a, b)
    }

    expect(differsAfter(() => { b.tick = 1 })).toBe(false)
    expect(differsAfter(() => { b.phase = 'finished' })).toBe(false)
    expect(differsAfter(() => { b.raceSeed = 6 })).toBe(false)
    expect(differsAfter(() => { b.rngCursor = 1 })).toBe(false)
    expect(differsAfter(() => { b.nextEventSeq = 1 })).toBe(false)
    expect(differsAfter(() => { b.finishTick = 0 })).toBe(false)
    expect(differsAfter(() => { b.entityCount = 1 })).toBe(false)
    expect(differsAfter(() => { b.nextEntityId = 2 })).toBe(false)
    expect(differsAfter(() => { b.karts[6].heading = 0.001 })).toBe(false)
    expect(differsAfter(() => { b.karts[6].drift.dir = 1 })).toBe(false)
    expect(differsAfter(() => { b.karts[6].lap.t = 0.5 })).toBe(false)
    expect(differsAfter(() => { b.karts[6].surface = 'boost' })).toBe(false)
    expect(differsAfter(() => { b.karts[6].item = 'bolt' })).toBe(false)
    expect(differsAfter(() => { b.karts[6].shielded = true })).toBe(false)
    expect(differsAfter(() => { b.entities[31].ttl = 1 })).toBe(false)
    expect(differsAfter(() => { b.entities[31].kind = 'slick' })).toBe(false)
    expect(differsAfter(() => { b.finishedOrder[7] = 3 })).toBe(false)
    expect(differsAfter(() => { b.itemBoxes[0].respawnTicks = 1 })).toBe(false)
    expect(differsAfter(() => { /* no mutation */ })).toBe(true)
  })
})

describe('emit', () => {
  it('stamps a monotonic eventSeq and the current tick onto every event', () => {
    const ctx = makeTestContext(EIGHT_STARTS)
    const st = createState(ctx, 1, [])
    st.tick = 42

    const out: AuthEvent[] = []
    emit(st, out, 'itemGrant', 3, -1, 'boost', 0)
    emit(st, out, 'entitySpawn', 3, 7, 'none', 2)

    expect(out).toHaveLength(2)

    expect(out[0].eventSeq).toBe(0) // nextEventSeq started at 0
    expect(out[0].tick).toBe(42)
    expect(out[0].kind).toBe('itemGrant')
    expect(out[0].playerId).toBe(3)
    expect(out[0].entityId).toBe(-1)
    expect(out[0].item).toBe('boost')
    expect(out[0].data).toBe(0)

    expect(out[1].eventSeq).toBe(1)
    expect(out[1].tick).toBe(42)
    expect(out[1].kind).toBe('entitySpawn')
    expect(out[1].entityId).toBe(7)
    expect(out[1].item).toBe('none')
    expect(out[1].data).toBe(2)

    expect(st.nextEventSeq).toBe(2) // 0 and 1 consumed

    st.tick = 43
    emit(st, out, 'finish', 0, -1, 'none', 1)
    expect(out[2].eventSeq).toBe(2)
    expect(out[2].tick).toBe(43)
    expect(st.nextEventSeq).toBe(3)
  })

  it('appends to the caller array without touching earlier entries', () => {
    const ctx = makeTestContext(EIGHT_STARTS)
    const st = createState(ctx, 1, [])
    const out: AuthEvent[] = []
    for (let i = 0; i < 5; i++) {
      st.tick = i
      emit(st, out, 'hit', i, -1, 'none', i * 2)
    }
    expect(out).toHaveLength(5)
    for (let i = 0; i < 5; i++) {
      expect(out[i].eventSeq).toBe(i)
      expect(out[i].tick).toBe(i)
      expect(out[i].playerId).toBe(i)
      expect(out[i].data).toBe(i * 2)
    }
    expect(st.nextEventSeq).toBe(5)
  })
})
