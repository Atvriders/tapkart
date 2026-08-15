import { describe, expect, it } from 'vitest'
import type { AuthEvent, EntityKind, SimContext } from '@tapkart/sim'
import {
  MAX_ENTITIES,
  MAX_KARTS,
  TICK_DT,
  computePlacement,
  createState,
  spawnEntity,
  surgeActiveOn,
  updateEntities,
  v3,
} from '@tapkart/sim'
import { createRaceView } from '../src/types'
import {
  BUBBLE_ORBIT_RADIUS_M,
  ENTITY_SCALE,
  bubblePosition,
  createRenderFrame,
  surgeAffects,
} from '../src/frame'
import { makeRenderContext } from './fixtures/render-fixtures'

const ALL_KINDS: readonly EntityKind[] = [
  'seeker',
  'bolt',
  'slick',
  'bubble',
  'surge',
  'charge',
]

/** The four kinds sim gives a non-zero strike radius (`hitRadiusFor`). */
const STRIKING_KINDS: readonly EntityKind[] = ['seeker', 'bolt', 'slick', 'charge']

/**
 * A real SimState carrying one live bubble owned by seat 0, stepped `ticks`
 * times through sim's own updateEntities.
 *
 * `shielded` must be true: updateEntities' bubble-consistency pass despawns a
 * bubble whose owner is not shielded, and a despawned bubble would make every
 * assertion below vacuous — which is why the tests assert entityCount === 1 on
 * every tick.
 */
function bubbleState(ticks: number): {
  ownerX: number
  ownerY: number
  ownerZ: number
  heading: number
  x: number
  y: number
  z: number
  count: number
} {
  const ctx = makeRenderContext()
  const state = createState(ctx, 0x5eed, Array.from({ length: MAX_KARTS }, () => 0))
  const events: AuthEvent[] = []
  state.karts[0].shielded = true
  // Spawned AT the owner: a bubble that never moves therefore sits at radius 0
  // and fails the radius assertion immediately.
  spawnEntity(ctx, state, 'bubble', 0, state.karts[0].position, 0, -1, 600, events)
  for (let n = 0; n < ticks; n++) updateEntities(ctx, state, events)
  const e = state.entities[0]
  const owner = state.karts[0]
  return {
    ownerX: owner.position.x,
    ownerY: owner.position.y,
    ownerZ: owner.position.z,
    heading: e.heading,
    x: e.position.x,
    y: e.position.y,
    z: e.position.z,
    count: state.entityCount,
  }
}

describe('createRenderFrame', () => {
  it('allocates fixed-length arrays, itemBoxAlpha of 1, sourceTick 0', () => {
    const f = createRenderFrame(3)
    expect(f.karts).toHaveLength(MAX_KARTS)
    expect(f.entities).toHaveLength(MAX_ENTITIES)
    expect(f.itemBoxAlpha).toBeInstanceOf(Float32Array)
    expect(f.itemBoxAlpha).toHaveLength(3)
    expect(Array.from(f.itemBoxAlpha)).toEqual([1, 1, 1])
    expect(f.sourceTick).toBe(0)
    expect(f.entityCount).toBe(0)
    expect(f.screenFlash).toBe(0)
    expect(f.screenTintAmount).toBe(0)
    // Values, not just a length: `toHaveLength(3)` alone passes for a tint of
    // [0.35, 0.15, 0.55], i.e. a fresh frame that already reports a surge.
    expect(Array.from(f.screenTintColor)).toEqual([0, 0, 0])
  })

  // A track may legally ship no item boxes at all, and Float32Array(-1) throws.
  it('accepts an item box count of zero without throwing', () => {
    expect(createRenderFrame(0).itemBoxAlpha).toHaveLength(0)
    expect(createRenderFrame(-1).itemBoxAlpha).toHaveLength(0)
  })

  // Catches the aliasing bug: filling the pool with one shared object literal
  // (`const p = v3(0,0,0); for (...) karts.push({ position: p, ... })`). Every
  // kart then renders at the same place, and no length or count assertion sees
  // it. Object identity is asserted, not values, so this does not depend on any
  // default createCameraState chooses — and every slot is checked, not just the
  // first two: sharing one Vec3 across karts 2..7 draws six karts in one spot.
  it('gives every Vec3 in the frame a distinct object', () => {
    const f = createRenderFrame(2)
    const seen = new Set<object>()
    for (const k of f.karts) seen.add(k.position)
    for (const e of f.entities) seen.add(e.position)
    seen.add(f.camera.position)
    seen.add(f.camera.lookAt)
    seen.add(f.camera.up)
    expect(seen.size).toBe(MAX_KARTS + MAX_ENTITIES + 3)

    f.karts[0].position.x = 7
    f.entities[0].position.z = 9
    expect(f.karts[1].position.x).toBe(0)
    expect(f.entities[1].position.z).toBe(0)
    expect(f.camera.position.x).toBe(0)
  })

  // Catches a second RenderFrame sharing the first's buffers, which would make
  // two sessions in one process draw each other's karts.
  it('returns independent frames on every call', () => {
    const a = createRenderFrame(1)
    const b = createRenderFrame(1)
    expect(a.karts[0]).not.toBe(b.karts[0])
    expect(a.itemBoxAlpha).not.toBe(b.itemBoxAlpha)
    a.itemBoxAlpha[0] = 0.25
    expect(b.itemBoxAlpha[0]).toBe(1)
  })

  // The two deliberate departures from "every field zeroed": 0 is a real value
  // in both encodings, so a fresh frame that reports tier 0 and entity id 0 is
  // reporting live content it does not have.
  it('starts driftSparkTier and entityId at the -1 sentinels', () => {
    const f = createRenderFrame(1)
    for (const k of f.karts) {
      expect(k.driftSparkTier).toBe(-1)
      expect(k.visible).toBe(false)
    }
    for (const e of f.entities) {
      expect(e.entityId).toBe(-1)
      expect(e.visible).toBe(false)
    }
  })
})

describe('BUBBLE_ORBIT_RADIUS_M', () => {
  // REQUIRED by contract §8.1. BUBBLE_ORBIT_RADIUS is module-private in
  // packages/sim/src/entity.ts:12, so this copy is the one number in `render`
  // that can silently disagree with the simulation. It catches exactly that:
  // change sim's 2.0 to 2.5 and this fails, while every hand-built-view test in
  // Task 12 still passes.
  it('equals the orbit radius sim actually produces', () => {
    for (const ticks of [1, 5, 17, 60]) {
      const b = bubbleState(ticks)
      expect(b.count).toBe(1)
      const r = Math.hypot(b.x - b.ownerX, b.z - b.ownerZ)
      expect(r).toBeCloseTo(BUBBLE_ORBIT_RADIUS_M, 9)
    }
  })
})

describe('bubblePosition', () => {
  // The radius test above cannot catch a sin/cos swap or a dropped y — both
  // preserve the radius exactly. This one does: it compares all three
  // components against sim's own output over a full orbit's worth of ticks.
  it('reproduces sim’s bubble position exactly, tick by tick', () => {
    const out = v3(0, 0, 0)
    for (let ticks = 1; ticks <= 12; ticks++) {
      const b = bubbleState(ticks)
      expect(b.count).toBe(1)
      // Non-vacuity for the y comparison: sim copies the OWNER's y onto the
      // bubble, so on a fixture whose karts sat at y = 0 an implementation that
      // wrote `out.y = 0` would match sim exactly and the y assertion would
      // prove nothing. It only bites while the owner is off zero.
      expect(b.ownerY).not.toBe(0)
      bubblePosition({ x: b.ownerX, y: b.ownerY, z: b.ownerZ }, b.heading, out)
      expect(out.x).toBeCloseTo(b.x, 9)
      expect(out.y).toBeCloseTo(b.y, 9)
      expect(out.z).toBeCloseTo(b.z, 9)
    }
  })

  // Non-vacuity guard for the test above: if sim ever stopped orbiting the
  // bubble, every component comparison would still pass while the bubble stood
  // still, and Q28's whole justification would be gone.
  it('is comparing against a bubble that actually moves', () => {
    const a = bubbleState(1)
    const b = bubbleState(12)
    expect(Math.hypot(b.x - a.x, b.z - a.z)).toBeGreaterThan(0.1)
  })

  it('writes all three components of out on every call', () => {
    const owner = v3(10, 2, -4)
    const out = v3(0, 0, 0)
    // Poisoned before EVERY call, including the second: without this, a
    // bubblePosition that writes only x and z passes, because y was left
    // correct by the call before it.
    const poison = (): void => {
      out.x = Number.NaN
      out.y = Number.NaN
      out.z = Number.NaN
    }

    poison()
    bubblePosition(owner, 0, out)
    expect(out.x).toBeCloseTo(10 + BUBBLE_ORBIT_RADIUS_M, 12)
    expect(out.y).toBe(2)
    expect(out.z).toBeCloseTo(-4, 12)

    poison()
    bubblePosition(owner, Math.PI / 2, out)
    expect(out.x).toBeCloseTo(10, 12)
    expect(out.y).toBe(2)
    expect(out.z).toBeCloseTo(-4 + BUBBLE_ORBIT_RADIUS_M, 12)
  })
})

describe('surgeAffects', () => {
  /** A view whose places come from the real comparator, plus a surge cast by
   *  `casterSeat`. Seat i is given lap MAX_KARTS-1-i, so place === seat. */
  function surgeView(casterSeat: number, entityCount: number) {
    const ctx = makeRenderContext()
    const state = createState(ctx, 7, Array.from({ length: MAX_KARTS }, () => 0))
    for (let i = 0; i < MAX_KARTS; i++) state.karts[i].lap.lap = MAX_KARTS - 1 - i
    const events: AuthEvent[] = []
    spawnEntity(ctx, state, 'surge', casterSeat, state.karts[casterSeat].position, 0, -1, 300, events)
    const indexOf = new Int32Array(MAX_KARTS)
    const order = new Int32Array(MAX_KARTS)
    computePlacement(state, indexOf, order)

    const view = createRaceView(ctx.track.itemBoxes.length)
    view.tick = state.tick
    view.entityCount = entityCount
    for (let i = 0; i < MAX_KARTS; i++) {
      const k = view.karts[i]
      k.playerId = i
      k.place = indexOf[i]
      k.source = 'authoritative'
    }
    const e = view.entities[0]
    e.entityId = state.entities[0].entityId
    e.kind = 'surge'
    e.ownerId = casterSeat
    e.source = 'authoritative'
    e.ttl = 300
    return { view, state }
  }

  // The flagship: agreement with sim's surgeActiveOn for every seat. The two
  // non-vacuity assertions are the point — an implementation that returns false
  // unconditionally agrees with sim on 3 of 8 seats and would pass a
  // seats-agree loop that happened to be built with no one affected.
  it('agrees with surgeActiveOn on every seat', () => {
    const { view, state } = surgeView(5, 1)
    const mine: boolean[] = []
    for (let pid = 0; pid < MAX_KARTS; pid++) {
      const got = surgeAffects(view, pid)
      expect(got).toBe(surgeActiveOn(state, pid))
      mine.push(got)
    }
    expect(mine.filter((v) => v)).not.toHaveLength(0)
    expect(mine.filter((v) => !v)).not.toHaveLength(0)
    expect(surgeAffects(view, 0)).toBe(true) // leader, ahead of the caster
    expect(surgeAffects(view, 5)).toBe(false) // the caster itself
    expect(surgeAffects(view, 6)).toBe(false) // placed behind the caster
    expect(surgeAffects(view, 7)).toBe(false)
  })

  // Catches iterating `view.entities.length` instead of `view.entityCount`: the
  // pool is MAX_ENTITIES long and slot 0 keeps its last contents, so a stale
  // surge would slow the whole field forever with no live entity on screen.
  it('ignores slots at or past entityCount', () => {
    const { view } = surgeView(5, 0)
    expect(view.entities[0].kind).toBe('surge')
    for (let pid = 0; pid < MAX_KARTS; pid++) {
      expect(surgeAffects(view, pid)).toBe(false)
    }
  })

  it('is false for an out-of-range seat', () => {
    const { view } = surgeView(5, 1)
    expect(surgeAffects(view, -1)).toBe(false)
    expect(surgeAffects(view, MAX_KARTS)).toBe(false)
  })

  // The other half of the range guard, which nothing else reaches: a surge whose
  // caster left the race carries ownerId -1 on the wire, and `karts[-1].place`
  // is a TypeError, not a `false`.
  it('is false for a surge with an out-of-range ownerId', () => {
    for (const ownerId of [-1, MAX_KARTS]) {
      const { view } = surgeView(5, 1)
      view.entities[0].ownerId = ownerId
      for (let pid = 0; pid < MAX_KARTS; pid++) {
        expect(surgeAffects(view, pid)).toBe(false)
      }
    }
  })

  // Catches "any live entity counts": only 'surge' slows anyone.
  it('is false when the live entity is not a surge', () => {
    const { view } = surgeView(5, 1)
    view.entities[0].kind = 'seeker'
    for (let pid = 0; pid < MAX_KARTS; pid++) {
      expect(surgeAffects(view, pid)).toBe(false)
    }
  })
})

describe('ENTITY_SCALE', () => {
  /**
   * One tick of a real SimState with a single entity of `kind` placed so that its
   * distance from seat 0 AT THE MOMENT sim tests for a strike is exactly `d`.
   *
   * updateEntities steps every entity BEFORE the strike pass, and a seeker or a
   * bolt travels `speed * TICK_DT` along its heading in that step, so both are
   * spawned one tick of their own travel short of `d`. `postDist` reports where
   * the entity actually ended up, so a bounce or a homing turn can never be
   * absorbed silently into the measurement.
   *
   * Seats 1..7 are moved far away so nothing else is in reach: a seeker or bolt
   * that struck another kart first would despawn and never reach seat 0.
   */
  function strikeTrial(
    ctx: SimContext,
    kind: EntityKind,
    d: number,
  ): { hit: boolean; postDist: number } {
    const state = createState(ctx, 1, Array.from({ length: MAX_KARTS }, () => 0))
    for (let i = 1; i < MAX_KARTS; i++) state.karts[i].position.x += 5000
    const k = state.karts[0]
    const travel =
      (kind === 'seeker' ? ctx.tuning.seekerSpeed : kind === 'bolt' ? ctx.tuning.boltSpeed : 0) *
      TICK_DT
    const events: AuthEvent[] = []
    // ownerId 1: sim's strike pass skips an entity's own owner, so seat 0 must
    // not own it. targetId -1 keeps a seeker from homing off the straight line.
    spawnEntity(
      ctx,
      state,
      kind,
      1,
      { x: k.position.x + d - travel, y: k.position.y, z: k.position.z },
      0,
      -1,
      600,
      events,
    )
    updateEntities(ctx, state, events)
    let postDist = -1
    if (state.entityCount > 0) {
      const e = state.entities[0]
      postDist = Math.hypot(
        e.position.x - k.position.x,
        e.position.y - k.position.y,
        e.position.z - k.position.z,
      )
    }
    return { hit: k.spinOutTicks > 0, postDist }
  }

  /** The distance at which sim starts spinning seat 0 out, by bisection. */
  function strikeThreshold(ctx: SimContext, kind: EntityKind): number {
    let lo = 0
    let hi = 12
    for (let n = 0; n < 50; n++) {
      const mid = (lo + hi) / 2
      if (strikeTrial(ctx, kind, mid).hit) lo = mid
      else hi = mid
    }
    return hi
  }

  // A freeze. It catches an accidental edit to a shipped visual constant and a
  // kind added to the table with a garbage value; it cannot judge whether a
  // number looks right on a phone — §8.3 says that is owner-verified.
  it('has a finite, non-negative metre scale for every EntityKind', () => {
    for (const kind of ALL_KINDS) {
      const s = ENTITY_SCALE[kind]
      expect(Number.isFinite(s)).toBe(true)
      expect(s).toBeGreaterThanOrEqual(0)
    }
    expect(Object.keys(ENTITY_SCALE).sort()).toEqual([...ALL_KINDS].sort())
  })

  it('matches sim’s strike radii, and draws surge at nothing (Q27)', () => {
    expect(ENTITY_SCALE.seeker).toBe(1.6)
    expect(ENTITY_SCALE.bolt).toBe(1.4)
    expect(ENTITY_SCALE.slick).toBe(1.2)
    expect(ENTITY_SCALE.charge).toBe(6.0)
    expect(ENTITY_SCALE.bubble).toBe(0.6)
    expect(ENTITY_SCALE.surge).toBe(0)
  })

  // The freeze above restates its own source line: it passes in every world where
  // sim's hitRadiusFor has moved on, which is exactly the drift the copied
  // BUBBLE_ORBIT_RADIUS_M test exists to catch on the other constant. hitRadiusFor
  // is module-private too, so this re-derives all four radii from real strikes:
  // change sim's seeker radius to 1.8 and this fails while the freeze passes.
  it('draws the striking kinds at the collision volume sim actually enforces', () => {
    const ctx = makeRenderContext()
    for (const kind of STRIKING_KINDS) {
      // Brackets the bisection, and proves the harness can produce both answers.
      expect(strikeTrial(ctx, kind, 0.05).hit).toBe(true)
      expect(strikeTrial(ctx, kind, 12).hit).toBe(false)

      const threshold = strikeThreshold(ctx, kind)
      // The measurement is only sound if the entity really is `threshold` metres
      // away when sim tests it.
      expect(strikeTrial(ctx, kind, threshold).postDist).toBeCloseTo(threshold, 9)
      // sim's reach is hitRadiusFor(kind) + tuning.kartRadius.
      expect(threshold - ctx.tuning.kartRadius).toBeCloseTo(ENTITY_SCALE[kind], 6)
    }
  })

  // Q27's other half, and the reason ENTITY_SCALE.surge is a free choice rather
  // than a copy: a surge is stationary and 5 cm from a kart here — the same
  // distance that spins a kart out for all four striking kinds above — and sim
  // still does not collide with it.
  it('draws surge at a size no sim collision can contradict', () => {
    const ctx = makeRenderContext()
    const trial = strikeTrial(ctx, 'surge', 0.05)
    expect(trial.postDist).toBeCloseTo(0.05, 9)
    expect(trial.hit).toBe(false)
  })
})
