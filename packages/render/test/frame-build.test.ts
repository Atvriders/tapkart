import { describe, expect, it } from 'vitest'
import type { CharacterDescriptor, KartDescriptor } from '@tapkart/content'
import type { EntityKind, ItemKind, Surface } from '@tapkart/sim'
import {
  CHARGE_TTL_TICKS,
  ITEM_BOOST_TICKS,
  MAX_ENTITIES,
  MAX_KARTS,
  TICK_DT,
  wrapAngle,
} from '@tapkart/sim'
import type { EntityView, KartView, RaceView, ViewSource } from '../src/types'
import { createRaceView } from '../src/types'
import { createCameraState } from '../src/camera'
import type { RenderFrame } from '../src/frame'
import {
  BUBBLE_ORBIT_RADIUS_M,
  CHARGE_FLASH_RADIUS_M,
  ENTITY_SCALE,
  INVULN_FLICKER_ALPHA,
  INVULN_FLICKER_PERIOD_TICKS,
  KART_DRIFT_LEAN_RADIANS,
  KART_SPINOUT_ROLL_RADIANS,
  KART_STEER_VISUAL_MAX_RADIANS,
  KART_STEER_VISUAL_YAW_RATE,
  SURGE_TINT,
  SURGE_TINT_AMOUNT,
  buildRenderFrame,
  createRenderFrame,
} from '../src/frame'
import * as barrel from '../src/index'
import {
  makeCharacterDescriptorFixture,
  makeKartDescriptorFixture,
  makeThemeFixture,
} from './fixtures/render-fixtures'

const BOX_COUNT = 4
const RESPAWN_TICKS = 180

/**
 * Eight kart descriptors with a DISTINCT wheelRadius and body colour per index.
 * Distinctness is the whole point: a builder that indexes `karts` by seat
 * instead of by characterIdx produces a frame whose lengths, counts and types
 * are all correct, and only a per-index difference exposes it.
 */
function makeKartDescriptors(): KartDescriptor[] {
  const base = makeKartDescriptorFixture()
  const out: KartDescriptor[] = []
  for (let i = 0; i < 8; i++) {
    out.push({
      ...base,
      id: `kart-${i}`,
      wheelRadius: 0.2 + i * 0.02,
      palette: { body: [i / 8, 0.1, 0.2], trim: base.palette.trim, wheel: base.palette.wheel },
    })
  }
  return out
}

function makeCharacterDescriptors(): CharacterDescriptor[] {
  const base = makeCharacterDescriptorFixture()
  const out: CharacterDescriptor[] = []
  for (let i = 0; i < 8; i++) {
    out.push({
      ...base,
      id: `char-${i}`,
      palette: {
        primary: base.palette.primary,
        secondary: base.palette.secondary,
        accent: [0.05 * i, 0.5, 0.9],
      },
    })
  }
  return out
}

const KARTS = makeKartDescriptors()
const CHARACTERS = makeCharacterDescriptors()
const THEME = makeThemeFixture()

/**
 * Fills a KartView completely. Every field is set explicitly, because the
 * derived table is a function of nearly all of them and a test must not inherit
 * defaults it does not control.
 */
function setKart(k: KartView, o: Partial<KartView> & { playerId: number }): void {
  k.playerId = o.playerId
  k.characterIdx = o.characterIdx ?? 0
  k.source = o.source ?? ('authoritative' as ViewSource)
  k.position.x = o.position?.x ?? 0
  k.position.y = o.position?.y ?? 0
  k.position.z = o.position?.z ?? 0
  k.heading = o.heading ?? 0
  k.velocity.x = o.velocity?.x ?? 0
  k.velocity.y = o.velocity?.y ?? 0
  k.velocity.z = o.velocity?.z ?? 0
  k.angularVelocity = o.angularVelocity ?? 0
  k.speed = o.speed ?? 0
  k.s = o.s ?? 0
  k.bankAngle = o.bankAngle ?? 0
  k.driftActive = o.driftActive ?? false
  k.driftDir = o.driftDir ?? 0
  k.driftCharge = o.driftCharge ?? 0
  k.driftTier = o.driftTier ?? -1
  k.airborne = o.airborne ?? false
  k.surface = o.surface ?? ('tarmac' as Surface)
  k.spinOutTicks = o.spinOutTicks ?? 0
  k.invulnTicks = o.invulnTicks ?? 0
  k.boostTicks = o.boostTicks ?? 0
  k.respawnTicks = o.respawnTicks ?? 0
  k.shielded = o.shielded ?? false
  k.item = o.item ?? ('none' as ItemKind)
  k.lap = o.lap ?? 0
  k.checkpointIdx = o.checkpointIdx ?? 0
  k.t = o.t ?? 0
  k.place = o.place ?? o.playerId
  k.isBot = o.isBot ?? false
  k.connected = o.connected ?? true
}

function setEntity(
  e: EntityView,
  o: Partial<EntityView> & { entityId: number; kind: EntityKind },
): void {
  e.entityId = o.entityId
  e.kind = o.kind
  e.ownerId = o.ownerId ?? -1
  e.source = o.source ?? ('authoritative' as ViewSource)
  e.position.x = o.position?.x ?? 0
  e.position.y = o.position?.y ?? 0
  e.position.z = o.position?.z ?? 0
  e.velocity.x = 0
  e.velocity.y = 0
  e.velocity.z = 0
  e.heading = o.heading ?? 0
  e.ttl = o.ttl ?? 600
}

/** A view with eight seats filled, place === seat, no entities, local seat 0. */
function baseView(): RaceView {
  const view = createRaceView(BOX_COUNT)
  view.tick = 100
  view.alpha = 0
  view.phase = 'racing'
  view.localPlayerId = 0
  view.raceStartTick = 0
  view.entityCount = 0
  view.itemBoxRespawnTicks = RESPAWN_TICKS
  view.finishTick = -1
  view.countdownTicksLeft = 0
  for (let i = 0; i < MAX_KARTS; i++) setKart(view.karts[i], { playerId: i, characterIdx: i })
  for (let b = 0; b < BOX_COUNT; b++) {
    view.itemBoxes[b].boxIdx = b
    view.itemBoxes[b].respawnTicks = 0
  }
  return view
}

function build(view: RaceView, out: RenderFrame): void {
  buildRenderFrame(view, createCameraState(), THEME, CHARACTERS, KARTS, out)
}

describe('buildRenderFrame - karts', () => {
  it('copies identity, visibility and the simple per-kart fields', () => {
    const view = baseView()
    setKart(view.karts[3], {
      playerId: 3,
      characterIdx: 6,
      position: { x: 12, y: 1.5, z: -4 },
      heading: 0.75,
      shielded: true,
      driftTier: 2,
      source: 'interpolated',
    })
    setKart(view.karts[4], { playerId: 4, characterIdx: 1, source: 'absent' })
    const out = createRenderFrame(BOX_COUNT)
    build(view, out)

    const d = out.karts[3]
    expect(d.playerId).toBe(3)
    expect(d.characterIdx).toBe(6)
    expect(d.visible).toBe(true)
    expect(d.position).toEqual({ x: 12, y: 1.5, z: -4 })
    expect(d.heading).toBe(0.75)
    expect(d.shieldVisible).toBe(true)
    expect(d.driftSparkTier).toBe(2)
    expect(out.karts[4].visible).toBe(false)
  })

  // Catches indexing the descriptor arrays by SEAT instead of by characterIdx -
  // the classic version of this bug looks right for the whole grid whenever
  // seat === characterIdx, which is exactly how a solo race is set up.
  it('takes bodyTint from karts[characterIdx], by reference', () => {
    const view = baseView()
    setKart(view.karts[2], { playerId: 2, characterIdx: 5 })
    const out = createRenderFrame(BOX_COUNT)
    build(view, out)
    expect(out.karts[2].bodyTint).toBe(KARTS[5].palette.body)
    expect(out.karts[2].bodyTint).not.toBe(KARTS[2].palette.body)
  })

  it('rolls by bank plus drift lean times driftDir plus spin-out tilt', () => {
    // Precondition for the four cases below: if these two constants were ever
    // tuned to the same number, an implementation that swapped them would be
    // invisible to every assertion in this test.
    expect(KART_DRIFT_LEAN_RADIANS).not.toBe(KART_SPINOUT_ROLL_RADIANS)

    const view = baseView()
    setKart(view.karts[0], { playerId: 0, bankAngle: 0.1, driftActive: true, driftDir: -1 })
    setKart(view.karts[1], { playerId: 1, bankAngle: 0.1, driftActive: true, driftDir: 1 })
    setKart(view.karts[2], { playerId: 2, bankAngle: 0.1, spinOutTicks: 30 })
    setKart(view.karts[3], { playerId: 3, bankAngle: 0.1 })
    // A kart can be spun out while its drift flag is still set: the three terms
    // must ADD, not choose between each other.
    setKart(view.karts[5], {
      playerId: 5,
      bankAngle: 0.1,
      driftActive: true,
      driftDir: 1,
      spinOutTicks: 30,
    })
    // driftDir 0 with driftActive is sim's "straightening out of a drift": no lean.
    setKart(view.karts[6], { playerId: 6, bankAngle: 0.1, driftActive: true, driftDir: 0 })
    const out = createRenderFrame(BOX_COUNT)
    build(view, out)
    expect(out.karts[0].roll).toBeCloseTo(0.1 - KART_DRIFT_LEAN_RADIANS, 12)
    expect(out.karts[1].roll).toBeCloseTo(0.1 + KART_DRIFT_LEAN_RADIANS, 12)
    expect(out.karts[2].roll).toBeCloseTo(0.1 + KART_SPINOUT_ROLL_RADIANS, 12)
    expect(out.karts[3].roll).toBeCloseTo(0.1, 12)
    expect(out.karts[5].roll).toBeCloseTo(
      0.1 + KART_DRIFT_LEAN_RADIANS + KART_SPINOUT_ROLL_RADIANS,
      12,
    )
    expect(out.karts[6].roll).toBeCloseTo(0.1, 12)
    // Independent of the constants' values: the drift term is odd in driftDir
    // about the no-drift roll, so a lean applied with a fixed sign fails here
    // even if both constants are retuned.
    expect(out.karts[0].roll + out.karts[1].roll).toBeCloseTo(2 * out.karts[3].roll, 12)
    expect(out.karts[1].roll).toBeGreaterThan(out.karts[3].roll)
  })

  // The no-double-spin assertion (§8.1). sim already yaws a spun-out kart at
  // SPIN_YAW_RATE and puts heading on the wire; a render-side spin angle would
  // double it, which is Q28's mistake made on a different object.
  it('copies a spun-out kart’s heading unmodified', () => {
    const view = baseView()
    setKart(view.karts[0], { playerId: 0, heading: -2.5, spinOutTicks: 45 })
    // A second seat spun out for a different number of ticks at the same
    // heading: a render-side spin proportional to spinOutTicks would separate
    // them, and it is the only way to tell "copied" from "advanced by a
    // constant" without leaving this function.
    setKart(view.karts[1], { playerId: 1, heading: -2.5, spinOutTicks: 5 })
    const out = createRenderFrame(BOX_COUNT)
    build(view, out)
    expect(out.karts[0].heading).toBe(-2.5)
    expect(out.karts[1].heading).toBe(-2.5)
    expect(out.karts[0].roll).toBeCloseTo(KART_SPINOUT_ROLL_RADIANS, 12)
  })

  it('maps angularVelocity to steerAngle, saturating at full lock', () => {
    const view = baseView()
    setKart(view.karts[0], { playerId: 0, angularVelocity: KART_STEER_VISUAL_YAW_RATE / 2 })
    setKart(view.karts[1], { playerId: 1, angularVelocity: KART_STEER_VISUAL_YAW_RATE * 4 })
    setKart(view.karts[2], { playerId: 2, angularVelocity: -KART_STEER_VISUAL_YAW_RATE * 4 })
    setKart(view.karts[3], { playerId: 3, angularVelocity: 0 })
    const out = createRenderFrame(BOX_COUNT)
    build(view, out)
    expect(out.karts[0].steerAngle).toBeCloseTo(KART_STEER_VISUAL_MAX_RADIANS / 2, 12)
    expect(out.karts[1].steerAngle).toBeCloseTo(KART_STEER_VISUAL_MAX_RADIANS, 12)
    expect(out.karts[2].steerAngle).toBeCloseTo(-KART_STEER_VISUAL_MAX_RADIANS, 12)
    expect(out.karts[3].steerAngle).toBe(0)
    // Independent of both constants: the map is odd and saturates, so the
    // saturated pair is symmetric and neither exceeds full lock.
    expect(out.karts[1].steerAngle).toBeCloseTo(-out.karts[2].steerAngle, 12)
    expect(Math.abs(out.karts[0].steerAngle)).toBeLessThan(
      Math.abs(out.karts[1].steerAngle),
    )
  })

  it('flickers alpha on the stated period while invulnerable', () => {
    const view = baseView()
    setKart(view.karts[0], { playerId: 0, invulnTicks: 40 })
    setKart(view.karts[1], { playerId: 1 })
    const half = INVULN_FLICKER_PERIOD_TICKS / 2
    const seen: number[] = []
    const out = createRenderFrame(BOX_COUNT)
    for (let t = 0; t < INVULN_FLICKER_PERIOD_TICKS * 3; t++) {
      view.tick = t
      build(view, out)
      seen.push(out.karts[0].alpha)
      expect(out.karts[1].alpha).toBe(1)
      expect(out.karts[0].alpha).toBe(
        t % INVULN_FLICKER_PERIOD_TICKS >= half ? INVULN_FLICKER_ALPHA : 1,
      )
    }
    // The assertion inside the loop restates the implementation's own
    // expression. These do not: they characterise the blink as a waveform.
    // - it really blinks, between exactly the two stated alphas
    expect(new Set(seen)).toEqual(new Set([1, INVULN_FLICKER_ALPHA]))
    // - it is periodic with period INVULN_FLICKER_PERIOD_TICKS, not some other
    //   period that happens to agree over one window
    for (let t = 0; t < INVULN_FLICKER_PERIOD_TICKS * 2; t++) {
      expect(seen[t + INVULN_FLICKER_PERIOD_TICKS]).toBe(seen[t])
    }
    // - the duty cycle is exactly half, and the dim half is one contiguous run
    //   that starts at the midpoint (an implementation using `< half` inverts
    //   the phase and is caught here, as is one dimming on alternate ticks)
    const cycle = seen.slice(0, INVULN_FLICKER_PERIOD_TICKS)
    expect(cycle.filter((a) => a === INVULN_FLICKER_ALPHA)).toHaveLength(half)
    expect(cycle.indexOf(INVULN_FLICKER_ALPHA)).toBe(half)
    expect(cycle.lastIndexOf(INVULN_FLICKER_ALPHA)).toBe(INVULN_FLICKER_PERIOD_TICKS - 1)
  })

  it('ramps boostFlame to 1 at ITEM_BOOST_TICKS and clamps above it', () => {
    const view = baseView()
    setKart(view.karts[0], { playerId: 0, boostTicks: 0 })
    setKart(view.karts[1], { playerId: 1, boostTicks: ITEM_BOOST_TICKS / 2 })
    setKart(view.karts[2], { playerId: 2, boostTicks: ITEM_BOOST_TICKS })
    setKart(view.karts[3], { playerId: 3, boostTicks: ITEM_BOOST_TICKS * 3 })
    const out = createRenderFrame(BOX_COUNT)
    build(view, out)
    expect(out.karts[0].boostFlame).toBe(0)
    expect(out.karts[1].boostFlame).toBeCloseTo(0.5, 12)
    expect(out.karts[2].boostFlame).toBe(1)
    expect(out.karts[3].boostFlame).toBe(1)
  })

  // The frame path runs before anything has validated a session, so a garbage
  // characterIdx must not throw inside the render loop or draw `undefined`.
  it('is total for an out-of-range characterIdx', () => {
    const view = baseView()
    setKart(view.karts[0], { playerId: 0, characterIdx: 99, speed: 10 })
    setKart(view.karts[1], { playerId: 1, characterIdx: -3, speed: 10 })
    setEntity(view.entities[0], { entityId: 1, kind: 'bolt', ownerId: 0 })
    view.entityCount = 1
    const out = createRenderFrame(BOX_COUNT)
    view.tick = 101
    expect(() => build(view, out)).not.toThrow()
    expect(out.karts[0].bodyTint).toBe(KARTS[7].palette.body)
    expect(out.karts[1].bodyTint).toBe(KARTS[0].palette.body)
    expect(out.entities[0].tint).toBe(CHARACTERS[7].palette.accent)
    // characterIdx itself is reported verbatim - it is the session's number,
    // not the descriptor index the clamp chose.
    expect(out.karts[0].characterIdx).toBe(99)
    expect(Number.isFinite(out.karts[0].wheelSpin)).toBe(true)
    expect(Number.isNaN(out.karts[0].wheelSpin)).toBe(false)
  })
})

describe('buildRenderFrame - wheelSpin accumulator', () => {
  // The frame-rate independence assertion. A builder that accumulates per CALL
  // rather than per elapsed SIM TICK spins the wheels twice as fast on a 120 Hz
  // display as on a 60 Hz one - invisible to any single-call test.
  it('advances by elapsed sim ticks, not by calls', () => {
    const view = baseView()
    setKart(view.karts[0], { playerId: 0, characterIdx: 3, speed: 20 })
    const out = createRenderFrame(BOX_COUNT)
    view.tick = 0
    build(view, out)
    expect(out.karts[0].wheelSpin).toBe(0)
    expect(out.sourceTick).toBe(0)

    // Two frames at the same tick: the second must add nothing.
    view.tick = 2
    build(view, out)
    const after2 = out.karts[0].wheelSpin
    build(view, out)
    build(view, out)
    expect(out.karts[0].wheelSpin).toBe(after2)

    const perTick = (20 / KARTS[3].wheelRadius) * TICK_DT
    expect(after2).toBeCloseTo(wrapAngle(perTick * 2), 12)
    // Non-vacuity for the equality above: a builder that never turned the wheel
    // also holds still across the repeated call.
    expect(after2).not.toBe(0)

    view.tick = 5
    build(view, out)
    expect(out.karts[0].wheelSpin).toBeCloseTo(wrapAngle(after2 + perTick * 3), 12)
  })

  // Independent of the formula: rolling without slipping means a wheel of twice
  // the radius turns half as far over the same ground, so the ratio of two
  // karts' spin at equal speed is the INVERSE ratio of their wheel radii. This
  // catches `* wheelRadius` for `/ wheelRadius` without restating either.
  it('turns a big wheel less than a small one over the same ground', () => {
    const view = baseView()
    setKart(view.karts[0], { playerId: 0, characterIdx: 0, speed: 12 })
    setKart(view.karts[1], { playerId: 1, characterIdx: 7, speed: 12 })
    const out = createRenderFrame(BOX_COUNT)
    view.tick = 3
    build(view, out)
    const small = out.karts[0].wheelSpin
    const big = out.karts[1].wheelSpin
    expect(KARTS[7].wheelRadius).toBeGreaterThan(KARTS[0].wheelRadius)
    expect(small).toBeGreaterThan(0)
    expect(big).toBeGreaterThan(0)
    expect(small).toBeGreaterThan(big)
    expect(small / big).toBeCloseTo(KARTS[7].wheelRadius / KARTS[0].wheelRadius, 9)
  })

  it('wraps rather than growing without bound', () => {
    const view = baseView()
    setKart(view.karts[0], { playerId: 0, characterIdx: 0, speed: 40 })
    const out = createRenderFrame(BOX_COUNT)
    for (let t = 1; t <= 600; t++) {
      view.tick = t
      build(view, out)
      expect(Math.abs(out.karts[0].wheelSpin)).toBeLessThanOrEqual(Math.PI + 1e-9)
    }
    // Non-vacuity: a wheel that never turned would also stay inside the bound.
    expect(out.karts[0].wheelSpin).not.toBe(0)
  })

  it('never rewinds when the view tick goes backwards', () => {
    const view = baseView()
    setKart(view.karts[0], { playerId: 0, speed: 10 })
    const out = createRenderFrame(BOX_COUNT)
    view.tick = 50
    build(view, out)
    const spin = out.karts[0].wheelSpin
    expect(spin).not.toBe(0)
    view.tick = 10
    build(view, out)
    expect(out.karts[0].wheelSpin).toBe(spin)
    expect(out.sourceTick).toBe(10)
  })
})

describe('buildRenderFrame - item boxes (Q29)', () => {
  // Catches the boolean-visibility implementation the ruling replaced: a box
  // that vanishes tells the player nothing. Every box gets a DISTINCT alpha, so
  // any permutation of the index space - the pairing Task 8 established against
  // sim's own itemBoxWorldPos - fails here too.
  it('ghosts a respawning box in proportion to its timer, index for index', () => {
    const view = baseView()
    view.itemBoxes[0].respawnTicks = 0
    view.itemBoxes[1].respawnTicks = RESPAWN_TICKS / 4
    view.itemBoxes[2].respawnTicks = RESPAWN_TICKS / 2
    view.itemBoxes[3].respawnTicks = RESPAWN_TICKS
    const out = createRenderFrame(BOX_COUNT)
    build(view, out)
    expect(Array.from(out.itemBoxAlpha)).toEqual([1, 0.75, 0.5, 0])
    // A full box reads as fully present and a just-taken one as fully gone:
    // the two endpoints, independent of the interpolation between them.
    expect(out.itemBoxAlpha[0]).toBe(1)
    expect(out.itemBoxAlpha[3]).toBe(0)
  })

  it('clamps a timer longer than the respawn period to nothing', () => {
    const view = baseView()
    view.itemBoxes[0].respawnTicks = RESPAWN_TICKS * 3
    view.itemBoxes[1].respawnTicks = -60
    const out = createRenderFrame(BOX_COUNT)
    build(view, out)
    expect(out.itemBoxAlpha[0]).toBe(0)
    expect(out.itemBoxAlpha[1]).toBe(1)
  })

  it('is total when the denominator is zero', () => {
    const view = baseView()
    view.itemBoxRespawnTicks = 0
    view.itemBoxes[0].respawnTicks = 0
    view.itemBoxes[1].respawnTicks = 30
    const out = createRenderFrame(BOX_COUNT)
    build(view, out)
    // 1 - 0/0 is NaN and sim's clamp passes NaN straight through, so this is
    // not a formality: the alpha must be a real number in range, and a track
    // with no respawn delay has boxes that are always fully there.
    expect(Number.isNaN(out.itemBoxAlpha[0])).toBe(false)
    expect(Number.isNaN(out.itemBoxAlpha[1])).toBe(false)
    expect(out.itemBoxAlpha[0]).toBe(1)
    expect(out.itemBoxAlpha[1]).toBeGreaterThanOrEqual(0)
    expect(out.itemBoxAlpha[1]).toBeLessThanOrEqual(1)
  })

  it('rewrites every box on a reused frame', () => {
    const view = baseView()
    view.itemBoxes[2].respawnTicks = RESPAWN_TICKS
    const out = createRenderFrame(BOX_COUNT)
    build(view, out)
    expect(out.itemBoxAlpha[2]).toBe(0)
    view.itemBoxes[2].respawnTicks = 0
    build(view, out)
    expect(out.itemBoxAlpha[2]).toBe(1)
  })
})

describe('buildRenderFrame - entities', () => {
  it('copies a plain entity and scales it by kind', () => {
    const view = baseView()
    setEntity(view.entities[0], {
      entityId: 11,
      kind: 'seeker',
      ownerId: 2,
      heading: 1.2,
      position: { x: 5, y: 0.5, z: 6 },
    })
    view.entityCount = 1
    const out = createRenderFrame(BOX_COUNT)
    build(view, out)
    expect(out.entityCount).toBe(1)
    expect(out.entities[0].entityId).toBe(11)
    expect(out.entities[0].kind).toBe('seeker')
    expect(out.entities[0].visible).toBe(true)
    expect(out.entities[0].position).toEqual({ x: 5, y: 0.5, z: 6 })
    expect(out.entities[0].heading).toBe(1.2)
    expect(out.entities[0].scale).toBe(ENTITY_SCALE.seeker)
    expect(out.entities[0].alpha).toBe(1)
  })

  // One slot per kind, so the scale lookup is exercised across the whole table
  // rather than at a single entry: ENTITY_SCALE's six values are all distinct,
  // so any mis-indexing shows up as a mismatch on some row.
  it('scales every kind by its own ENTITY_SCALE row', () => {
    const kinds: readonly EntityKind[] = ['seeker', 'bolt', 'slick', 'bubble', 'surge', 'charge']
    const view = baseView()
    for (let j = 0; j < kinds.length; j++) {
      setEntity(view.entities[j], { entityId: 100 + j, kind: kinds[j], ownerId: -1 })
    }
    view.entityCount = kinds.length
    const out = createRenderFrame(BOX_COUNT)
    build(view, out)
    for (let j = 0; j < kinds.length; j++) {
      expect(out.entities[j].kind).toBe(kinds[j])
      expect(out.entities[j].scale).toBe(ENTITY_SCALE[kinds[j]])
    }
    expect(new Set(kinds.map((k) => ENTITY_SCALE[k])).size).toBe(kinds.length)
  })

  // Q28's defect, made visible. The sampled position is deliberately WRONG -
  // it sits on the owner, which is what linear interpolation across the orbit
  // produces at its worst - and the frame must ignore it and rebuild from the
  // owner's drawn position plus the interpolated heading.
  it('reconstructs a bubble from its owner and heading, not from the sample', () => {
    const view = baseView()
    setKart(view.karts[4], { playerId: 4, characterIdx: 4, position: { x: 30, y: 2, z: -7 } })
    setEntity(view.entities[0], {
      entityId: 21,
      kind: 'bubble',
      ownerId: 4,
      heading: Math.PI / 2,
      position: { x: 30, y: 2, z: -7 },
    })
    view.entityCount = 1
    const out = createRenderFrame(BOX_COUNT)
    build(view, out)
    const d = out.entities[0]
    expect(d.position.x).toBeCloseTo(30, 9)
    expect(d.position.y).toBeCloseTo(2, 9)
    expect(d.position.z).toBeCloseTo(-7 + BUBBLE_ORBIT_RADIUS_M, 9)
    expect(Math.hypot(d.position.x - 30, d.position.z + 7)).toBeCloseTo(BUBBLE_ORBIT_RADIUS_M, 9)
  })

  // Also the karts-before-entities ordering assertion: on a fresh frame every
  // KartDraw.position is the origin, so a builder that filled entities first
  // would put this bubble at (BUBBLE_ORBIT_RADIUS_M, 0, 0).
  it('hugs the DRAWN owner, so the shield follows the kart the player sees', () => {
    const view = baseView()
    setKart(view.karts[4], { playerId: 4, position: { x: -50, y: 0, z: 12 } })
    setEntity(view.entities[0], {
      entityId: 22,
      kind: 'bubble',
      ownerId: 4,
      heading: 0,
      position: { x: 999, y: 999, z: 999 },
    })
    view.entityCount = 1
    const out = createRenderFrame(BOX_COUNT)
    build(view, out)
    expect(out.entities[0].position.x).toBeCloseTo(-50 + BUBBLE_ORBIT_RADIUS_M, 9)
    expect(out.entities[0].position.y).toBeCloseTo(0, 9)
    expect(out.entities[0].position.z).toBeCloseTo(12, 9)
  })

  // A bubble is the one entity whose position is not on the wire in any usable
  // form; a bubble with no owner still has to land somewhere finite.
  it('falls back to the sampled position for an ownerless bubble', () => {
    const view = baseView()
    setEntity(view.entities[0], {
      entityId: 23,
      kind: 'bubble',
      ownerId: -1,
      heading: 0,
      position: { x: 4, y: 5, z: 6 },
    })
    view.entityCount = 1
    const out = createRenderFrame(BOX_COUNT)
    expect(() => build(view, out)).not.toThrow()
    expect(out.entities[0].position).toEqual({ x: 4, y: 5, z: 6 })
  })

  // Q27. Drawing a mesh at a meaningless position is worse than drawing
  // nothing, because players will try to dodge it.
  it('never makes a surge visible, however live it is', () => {
    const view = baseView()
    setEntity(view.entities[0], { entityId: 31, kind: 'surge', ownerId: 7, ttl: 300 })
    setEntity(view.entities[1], { entityId: 32, kind: 'bolt', ownerId: 7, ttl: 300 })
    view.entityCount = 2
    const out = createRenderFrame(BOX_COUNT)
    build(view, out)
    expect(out.entities[0].visible).toBe(false)
    expect(out.entities[1].visible).toBe(true)
  })

  // Catches drawing the whole pool: slots at or past entityCount hold whatever
  // the last entity left there.
  it('marks slots at or past entityCount invisible', () => {
    const view = baseView()
    setEntity(view.entities[0], { entityId: 41, kind: 'bolt', ownerId: 1 })
    setEntity(view.entities[1], { entityId: -1, kind: 'bolt', ownerId: 1 })
    view.entityCount = 1
    const out = createRenderFrame(BOX_COUNT)
    build(view, out)
    expect(out.entities[0].visible).toBe(true)
    expect(out.entities[1].visible).toBe(false)
    expect(out.entities[MAX_ENTITIES - 1].visible).toBe(false)
  })

  it('fades slick and charge by ttl, and nothing else', () => {
    const view = baseView()
    // Every slot carries the SAME ttl, so `kind` is the only variable: a
    // builder that faded every entity, or that left 'charge' off the fade list,
    // differs from this expectation on some row. ttl 15 also separates the
    // hazard divisor (30) from CHARGE_TTL_TICKS (20), which the screenFlash row
    // uses on the very same field: 15/30 = 0.5 but 15/20 = 0.75.
    setEntity(view.entities[0], { entityId: 51, kind: 'slick', ownerId: 1, ttl: 15 })
    setEntity(view.entities[1], { entityId: 52, kind: 'charge', ownerId: 1, ttl: 15 })
    setEntity(view.entities[2], { entityId: 53, kind: 'bolt', ownerId: 1, ttl: 15 })
    setEntity(view.entities[3], { entityId: 54, kind: 'seeker', ownerId: 1, ttl: 15 })
    setEntity(view.entities[4], { entityId: 55, kind: 'bubble', ownerId: 1, ttl: 15 })
    setEntity(view.entities[5], { entityId: 56, kind: 'slick', ownerId: 1, ttl: 600 })
    setEntity(view.entities[6], { entityId: 57, kind: 'slick', ownerId: 1, ttl: 0 })
    view.entityCount = 7
    const out = createRenderFrame(BOX_COUNT)
    build(view, out)
    expect(out.entities[0].alpha).toBeCloseTo(0.5, 12)
    expect(out.entities[1].alpha).toBeCloseTo(0.5, 12)
    expect(out.entities[2].alpha).toBe(1)
    expect(out.entities[3].alpha).toBe(1)
    expect(out.entities[4].alpha).toBe(1)
    expect(out.entities[5].alpha).toBe(1)
    expect(out.entities[6].alpha).toBe(0)
    // The hazard divisor is not CHARGE_TTL_TICKS.
    expect(out.entities[1].alpha).not.toBeCloseTo(15 / CHARGE_TTL_TICKS, 3)
  })

  it('tints an entity with its owner’s character accent', () => {
    const view = baseView()
    setKart(view.karts[6], { playerId: 6, characterIdx: 2 })
    setEntity(view.entities[0], { entityId: 61, kind: 'bolt', ownerId: 6 })
    setEntity(view.entities[1], { entityId: 62, kind: 'slick', ownerId: -1 })
    setEntity(view.entities[2], { entityId: 63, kind: 'slick', ownerId: MAX_KARTS })
    view.entityCount = 3
    const out = createRenderFrame(BOX_COUNT)
    build(view, out)
    // By the OWNER'S characterIdx, not by ownerId: seat 6 is driving character
    // 2 here, and the two indices are distinguishable only because they differ.
    expect(out.entities[0].tint).toBe(CHARACTERS[2].palette.accent)
    expect(out.entities[0].tint).not.toBe(CHARACTERS[6].palette.accent)
    // A caster who has left the race carries ownerId -1 on the wire, and an
    // out-of-range seat must not read off the end of the array either.
    expect(out.entities[1].tint).toBe(THEME.edgeMarkers.colors[0])
    expect(out.entities[2].tint).toBe(THEME.edgeMarkers.colors[0])
  })
})

describe('buildRenderFrame - screen effects', () => {
  it('flashes hardest at the charge and not at all at its radius', () => {
    const view = baseView()
    setKart(view.karts[0], { playerId: 0, position: { x: 0, y: 0, z: 0 } })
    setEntity(view.entities[0], {
      entityId: 71,
      kind: 'charge',
      ownerId: 3,
      ttl: CHARGE_TTL_TICKS,
      position: { x: 0, y: 0, z: 0 },
    })
    view.entityCount = 1
    const out = createRenderFrame(BOX_COUNT)
    build(view, out)
    expect(out.screenFlash).toBeCloseTo(1, 12)

    view.entities[0].position.x = CHARGE_FLASH_RADIUS_M
    build(view, out)
    expect(out.screenFlash).toBeCloseTo(0, 12)

    view.entities[0].position.x = CHARGE_FLASH_RADIUS_M * 2
    build(view, out)
    expect(out.screenFlash).toBe(0)

    view.entities[0].position.x = CHARGE_FLASH_RADIUS_M / 2
    view.entities[0].ttl = CHARGE_TTL_TICKS / 2
    build(view, out)
    expect(out.screenFlash).toBeCloseTo(0.25, 12)
    // The ttl divisor here is CHARGE_TTL_TICKS, not the hazard fade's 30, which
    // the same field feeds on the row above.
    expect(out.screenFlash).not.toBeCloseTo(0.5 * (CHARGE_TTL_TICKS / 2 / 30), 3)
  })

  // Task 8's lesson on a different quantity: an assertion that only ever moves
  // the charge along x cannot tell a 3-D distance from a plan-view one, and a
  // charge going off overhead on a ramp would flash as if it were in the kart's
  // lap.
  it('measures the charge distance in all three axes', () => {
    const view = baseView()
    setKart(view.karts[0], { playerId: 0, position: { x: 0, y: 0, z: 0 } })
    setEntity(view.entities[0], {
      entityId: 72,
      kind: 'charge',
      ownerId: 3,
      ttl: CHARGE_TTL_TICKS,
      position: { x: 0, y: CHARGE_FLASH_RADIUS_M / 2, z: 0 },
    })
    view.entityCount = 1
    const out = createRenderFrame(BOX_COUNT)
    build(view, out)
    // A builder ignoring y reports 1 here.
    expect(out.screenFlash).toBeCloseTo(0.5, 12)

    view.entities[0].position.x = 0
    view.entities[0].position.y = 0
    view.entities[0].position.z = CHARGE_FLASH_RADIUS_M / 2
    build(view, out)
    expect(out.screenFlash).toBeCloseTo(0.5, 12)

    // |(2, 3, 6)| = 7 exactly. A plan-view distance would be hypot(2, 6) and
    // report 0.6838..., so the two answers are far apart.
    view.entities[0].position.x = 2
    view.entities[0].position.y = 3
    view.entities[0].position.z = 6
    build(view, out)
    expect(out.screenFlash).toBeCloseTo(0.65, 12)
    expect(out.screenFlash).not.toBeCloseTo(1 - Math.hypot(2, 6) / CHARGE_FLASH_RADIUS_M, 3)

    // The distance is measured from the LOCAL kart, not the origin.
    setKart(view.karts[0], { playerId: 0, position: { x: 2, y: 3, z: 6 } })
    build(view, out)
    expect(out.screenFlash).toBeCloseTo(1, 12)
  })

  it('takes the maximum over live charges and ignores dead slots', () => {
    const view = baseView()
    setKart(view.karts[0], { playerId: 0, position: { x: 0, y: 0, z: 0 } })
    // Three live charges with the strongest in the MIDDLE, and the strongest of
    // all parked past entityCount. Every wrong reduction gives a different
    // number: first-wins 0.5, last-wins 0.25, whole-pool 1, sum 1.5 - and only
    // "max over the live ones" gives 0.75.
    setEntity(view.entities[0], {
      entityId: 81,
      kind: 'charge',
      ownerId: 3,
      ttl: CHARGE_TTL_TICKS,
      position: { x: CHARGE_FLASH_RADIUS_M * 0.5, y: 0, z: 0 },
    })
    setEntity(view.entities[1], {
      entityId: 82,
      kind: 'charge',
      ownerId: 3,
      ttl: CHARGE_TTL_TICKS,
      position: { x: CHARGE_FLASH_RADIUS_M * 0.25, y: 0, z: 0 },
    })
    setEntity(view.entities[2], {
      entityId: 83,
      kind: 'charge',
      ownerId: 3,
      ttl: CHARGE_TTL_TICKS,
      position: { x: CHARGE_FLASH_RADIUS_M * 0.75, y: 0, z: 0 },
    })
    setEntity(view.entities[3], {
      entityId: 84,
      kind: 'charge',
      ownerId: 3,
      ttl: CHARGE_TTL_TICKS,
      position: { x: 0, y: 0, z: 0 },
    })
    view.entityCount = 3
    const out = createRenderFrame(BOX_COUNT)
    build(view, out)
    expect(out.screenFlash).toBeCloseTo(0.75, 12)

    view.entityCount = 1
    build(view, out)
    expect(out.screenFlash).toBeCloseTo(0.5, 12)
  })

  it('ignores entities that are not charges', () => {
    const view = baseView()
    setKart(view.karts[0], { playerId: 0, position: { x: 0, y: 0, z: 0 } })
    setEntity(view.entities[0], {
      entityId: 84,
      kind: 'bolt',
      ownerId: 3,
      ttl: CHARGE_TTL_TICKS,
      position: { x: 0, y: 0, z: 0 },
    })
    setEntity(view.entities[1], {
      entityId: 85,
      kind: 'seeker',
      ownerId: 3,
      ttl: CHARGE_TTL_TICKS,
      position: { x: 0, y: 0, z: 0 },
    })
    view.entityCount = 2
    const out = createRenderFrame(BOX_COUNT)
    build(view, out)
    expect(out.screenFlash).toBe(0)
    // Non-vacuity: the identical arrangement with one of them turned into a
    // charge flashes at full strength, so the zero above is about `kind`.
    view.entities[0].kind = 'charge'
    build(view, out)
    expect(out.screenFlash).toBeCloseTo(1, 12)
  })

  it('is silent for a spectator with no local seat', () => {
    const view = baseView()
    view.localPlayerId = -1
    setEntity(view.entities[0], {
      entityId: 91,
      kind: 'charge',
      ownerId: 3,
      ttl: CHARGE_TTL_TICKS,
      position: { x: 0, y: 0, z: 0 },
    })
    setEntity(view.entities[1], { entityId: 92, kind: 'surge', ownerId: 7, ttl: 300 })
    view.entityCount = 2
    const out = createRenderFrame(BOX_COUNT)
    build(view, out)
    expect(out.screenFlash).toBe(0)
    expect(out.screenTintAmount).toBe(0)
    // Non-vacuity: the very same view WITH a local seat lights both up, so the
    // zeroes above are the spectator rule and not an inert frame.
    view.localPlayerId = 0
    build(view, out)
    expect(out.screenFlash).toBeCloseTo(1, 12)
    expect(out.screenTintAmount).toBe(SURGE_TINT_AMOUNT)
  })

  it('tints the screen only while a surge from behind is slowing the local kart', () => {
    const view = baseView()
    view.localPlayerId = 1 // place 1
    setEntity(view.entities[0], { entityId: 93, kind: 'surge', ownerId: 5, ttl: 300 })
    view.entityCount = 1
    const out = createRenderFrame(BOX_COUNT)
    build(view, out)
    expect(out.screenTintColor).toBe(SURGE_TINT)
    expect(out.screenTintAmount).toBe(SURGE_TINT_AMOUNT)

    // Cast by a kart AHEAD of the local seat: no tint. Without this half, an
    // implementation that tints on any live surge passes the assertion above.
    view.entities[0].ownerId = 0
    build(view, out)
    expect(out.screenTintAmount).toBe(0)
    // The colour is stated unconditionally: the adapter multiplies it by the
    // amount, and a black tint at amount 0 would hide a wrong colour forever.
    expect(out.screenTintColor).toBe(SURGE_TINT)
  })
})

describe('buildRenderFrame - camera, sourceTick and reuse', () => {
  it('copies the camera pose by value, not by reference', () => {
    const view = baseView()
    const cam = createCameraState()
    cam.position.x = 3
    cam.position.y = 4
    cam.position.z = 5
    cam.lookAt.x = 1
    cam.lookAt.y = 2
    cam.lookAt.z = -6
    cam.up.x = 0.1
    cam.up.y = 0.9
    cam.up.z = -0.2
    cam.fovDegrees = 71
    cam.mode = 'countdown'
    const out = createRenderFrame(BOX_COUNT)
    buildRenderFrame(view, cam, THEME, CHARACTERS, KARTS, out)
    expect(out.camera.position).toEqual({ x: 3, y: 4, z: 5 })
    expect(out.camera.lookAt).toEqual({ x: 1, y: 2, z: -6 })
    expect(out.camera.up).toEqual({ x: 0.1, y: 0.9, z: -0.2 })
    expect(out.camera.fovDegrees).toBe(71)
    expect(out.camera.mode).toBe('countdown')
    expect(out.camera).not.toBe(cam)
    expect(out.camera.position).not.toBe(cam.position)
    expect(out.camera.lookAt).not.toBe(cam.lookAt)
    expect(out.camera.up).not.toBe(cam.up)
    // A later updateCamera must not reach into a frame already handed to the
    // backend - on any of the three vectors.
    cam.position.x = 999
    cam.lookAt.y = 999
    cam.up.z = 999
    expect(out.camera.position.x).toBe(3)
    expect(out.camera.lookAt.y).toBe(2)
    expect(out.camera.up.z).toBe(-0.2)
  })

  it('writes sourceTick from the view', () => {
    const view = baseView()
    view.tick = 4242
    const out = createRenderFrame(BOX_COUNT)
    build(view, out)
    expect(out.sourceTick).toBe(4242)
  })

  // The write-only rule: apart from sourceTick and wheelSpin, nothing may
  // survive from the previous frame. On a FRESH frame every one of these
  // assertions passes against a builder that simply never writes the field,
  // because createRenderFrame's defaults already look like this - which is why
  // each seat and slot is made live first and then retired.
  it('clears everything the previous frame left behind', () => {
    const view = baseView()
    setKart(view.karts[4], {
      playerId: 4,
      characterIdx: 4,
      position: { x: 9, y: 9, z: 9 },
      shielded: true,
      driftTier: 2,
      boostTicks: ITEM_BOOST_TICKS,
      bankAngle: 0.4,
      angularVelocity: KART_STEER_VISUAL_YAW_RATE,
      invulnTicks: 20,
    })
    view.tick = 4 // inside the dim half of the flicker period
    setEntity(view.entities[0], {
      entityId: 71,
      kind: 'charge',
      ownerId: 0,
      ttl: CHARGE_TTL_TICKS,
      position: { x: 0, y: 0, z: 0 },
    })
    setEntity(view.entities[1], { entityId: 72, kind: 'slick', ownerId: 0, ttl: 15 })
    setEntity(view.entities[2], { entityId: 73, kind: 'surge', ownerId: 7, ttl: 300 })
    view.entityCount = 3
    view.itemBoxes[0].respawnTicks = RESPAWN_TICKS
    const out = createRenderFrame(BOX_COUNT)
    build(view, out)
    expect(out.karts[4].visible).toBe(true)
    expect(out.karts[4].shieldVisible).toBe(true)
    expect(out.karts[4].alpha).toBe(INVULN_FLICKER_ALPHA)
    expect(out.entities[1].visible).toBe(true)
    expect(out.entities[1].alpha).toBeCloseTo(0.5, 12)
    expect(out.screenFlash).toBeCloseTo(1, 12)
    expect(out.screenTintAmount).toBe(SURGE_TINT_AMOUNT)
    expect(out.itemBoxAlpha[0]).toBe(0)
    expect(out.entityCount).toBe(3)

    // The seat leaves, the entities despawn, the box comes back.
    setKart(view.karts[4], { playerId: 4, characterIdx: 4, source: 'absent' })
    view.entityCount = 0
    view.itemBoxes[0].respawnTicks = 0
    build(view, out)
    expect(out.karts[4].visible).toBe(false)
    expect(out.karts[4].shieldVisible).toBe(false)
    expect(out.karts[4].driftSparkTier).toBe(-1)
    expect(out.karts[4].boostFlame).toBe(0)
    expect(out.karts[4].roll).toBe(0)
    expect(out.karts[4].steerAngle).toBe(0)
    expect(out.karts[4].alpha).toBe(1)
    expect(out.karts[4].position).toEqual({ x: 0, y: 0, z: 0 })
    expect(out.entities[1].visible).toBe(false)
    expect(out.entityCount).toBe(0)
    expect(out.screenFlash).toBe(0)
    expect(out.screenTintAmount).toBe(0)
    expect(out.itemBoxAlpha[0]).toBe(1)
  })

  // Scratch discipline (§7.3): the adapter may cache these objects between
  // frames, so the builder must write through them, never replace them. Every
  // slot is checked, not a sample: replacing one Vec3 in one seat is exactly
  // the regression a spot-check misses.
  it('reuses every out object instead of allocating', () => {
    const view = baseView()
    const out = createRenderFrame(BOX_COUNT)
    const kartObjs = out.karts.slice()
    const kartPos = out.karts.map((k) => k.position)
    const entObjs = out.entities.slice()
    const entPos = out.entities.map((e) => e.position)
    const cam = out.camera
    const camPos = out.camera.position
    const camLook = out.camera.lookAt
    const camUp = out.camera.up
    const boxes = out.itemBoxAlpha
    const karts = out.karts
    const entities = out.entities
    setEntity(view.entities[0], { entityId: 1, kind: 'bolt', ownerId: 0 })
    setEntity(view.entities[1], { entityId: 2, kind: 'bubble', ownerId: 0 })
    view.entityCount = 2
    build(view, out)
    view.tick += 1
    build(view, out)
    expect(out.karts).toBe(karts)
    expect(out.entities).toBe(entities)
    expect(out.itemBoxAlpha).toBe(boxes)
    expect(out.camera).toBe(cam)
    expect(out.camera.position).toBe(camPos)
    expect(out.camera.lookAt).toBe(camLook)
    expect(out.camera.up).toBe(camUp)
    for (let i = 0; i < MAX_KARTS; i++) {
      expect(out.karts[i]).toBe(kartObjs[i])
      expect(out.karts[i].position).toBe(kartPos[i])
    }
    for (let j = 0; j < MAX_ENTITIES; j++) {
      expect(out.entities[j]).toBe(entObjs[j])
      expect(out.entities[j].position).toBe(entPos[j])
    }
    // The two palette fields are references INTO the descriptors and the theme,
    // so no frame ever allocates a colour either.
    expect(out.karts[0].bodyTint).toBe(KARTS[0].palette.body)
    expect(out.entities[0].tint).toBe(CHARACTERS[0].palette.accent)
    expect(out.screenTintColor).toBe(SURGE_TINT)
  })

  it('is deterministic: the same inputs and accumulator give the same frame', () => {
    const view = baseView()
    setKart(view.karts[0], { playerId: 0, speed: 17, angularVelocity: 0.9, boostTicks: 30 })
    setEntity(view.entities[0], { entityId: 5, kind: 'bubble', ownerId: 0, heading: 1.1 })
    view.entityCount = 1
    const a = createRenderFrame(BOX_COUNT)
    const b = createRenderFrame(BOX_COUNT)
    build(view, a)
    build(view, b)
    expect(JSON.stringify(a.karts)).toBe(JSON.stringify(b.karts))
    expect(JSON.stringify(a.entities)).toBe(JSON.stringify(b.entities))
    expect(Array.from(a.itemBoxAlpha)).toEqual(Array.from(b.itemBoxAlpha))
  })

  // Nothing outside @tapkart/render can draw a frame until `frame` is on the
  // barrel, and `src/index.ts` IS the package's public surface (§4.11).
  it('is reachable through the package barrel', () => {
    expect(barrel.buildRenderFrame).toBe(buildRenderFrame)
    expect(barrel.createRenderFrame).toBe(createRenderFrame)
    expect(barrel.bubblePosition).toBeTypeOf('function')
    expect(barrel.surgeAffects).toBeTypeOf('function')
    expect(barrel.ENTITY_SCALE).toBe(ENTITY_SCALE)
    expect(barrel.SURGE_TINT).toBe(SURGE_TINT)
  })
})
