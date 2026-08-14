import { describe, it, expect } from 'vitest'
import {
  applyItemGrant,
  BLINK_BOOST_TICKS,
  BLINK_INVULN_TICKS,
  CHARGE_TTL_TICKS,
  ITEM_BOX_RADIUS,
  ITEM_BOOST_TICKS,
  ITEM_DROP_OFFSET,
  ITEM_FIRE_OFFSET,
  ITEM_ROLL_ORDER,
  ITEM_WEIGHTS,
  ITEM_WEIGHT_TOTAL,
  SURGE_TTL_TICKS,
  itemBoxWorldPos,
  itemForRoll,
  placeIndexOf,
  rollItem,
  seekerTargetFor,
  updateItemBoxes,
  useItem,
} from '../src/items'
import type { AuthEvent, ItemKind, SimState } from '../src/types'
import { MAX_ENTITIES } from '../src/types'
import { v3 } from '../src/vec3'
import { createState } from '../src/state'
import { rngAt } from '../src/rng'
import { makeContext, makeStraightTrack } from './fixtures/track-fixtures'

const ALL_CHARACTERS = [0, 1, 2, 3, 4, 5, 6, 7]

describe('item distribution table', () => {
  it('is 8 placements x 8 items and every row sums to exactly 100', () => {
    expect(ITEM_ROLL_ORDER).toEqual([
      'boost', 'seeker', 'bolt', 'slick', 'bubble', 'surge', 'blink', 'charge',
    ])
    expect(ITEM_WEIGHT_TOTAL).toBe(100)
    expect(ITEM_WEIGHTS.length).toBe(8)
    for (let p = 0; p < 8; p++) {
      expect(ITEM_WEIGHTS[p].length).toBe(8)
      let sum = 0
      for (let i = 0; i < 8; i++) sum += ITEM_WEIGHTS[p][i]
      expect(sum).toBe(100)
    }
  })

  it('shifts weight from defensive to catch-up items as placement worsens', () => {
    // Column indices, in ITEM_ROLL_ORDER: boost 0, seeker 1, bolt 2, slick 3,
    // bubble 4, surge 5, blink 6, charge 7.
    // surge is the pure catch-up item: unreachable in 1st, heaviest in 8th.
    expect(ITEM_WEIGHTS[0][5]).toBe(0)
    expect(ITEM_WEIGHTS[7][5]).toBe(22)
    // slick and bubble are the front-runner's defensive items.
    expect(ITEM_WEIGHTS[0][3]).toBe(30)
    expect(ITEM_WEIGHTS[7][3]).toBe(2)
    expect(ITEM_WEIGHTS[0][4]).toBe(24)
    expect(ITEM_WEIGHTS[7][4]).toBe(4)
    // boost, bolt and surge rise monotonically; slick and bubble fall.
    for (let p = 1; p < 8; p++) {
      expect(ITEM_WEIGHTS[p][0]).toBeGreaterThan(ITEM_WEIGHTS[p - 1][0])
      expect(ITEM_WEIGHTS[p][2]).toBeGreaterThan(ITEM_WEIGHTS[p - 1][2])
      expect(ITEM_WEIGHTS[p][5]).toBeGreaterThan(ITEM_WEIGHTS[p - 1][5])
      expect(ITEM_WEIGHTS[p][3]).toBeLessThan(ITEM_WEIGHTS[p - 1][3])
      expect(ITEM_WEIGHTS[p][4]).toBeLessThan(ITEM_WEIGHTS[p - 1][4])
    }
    // seeker peaks mid-field rather than at either end.
    expect(ITEM_WEIGHTS[3][1]).toBe(22)
    expect(ITEM_WEIGHTS[4][1]).toBe(22)
    expect(ITEM_WEIGHTS[0][1]).toBe(10)
    expect(ITEM_WEIGHTS[7][1]).toBe(12)
    // charge is flat across the whole field.
    for (let p = 0; p < 8; p++) expect(ITEM_WEIGHTS[p][7]).toBe(8)
  })

  it('maps a roll to the bucket its cumulative weight covers, in 1st place', () => {
    // Row 0 weights   : [10, 10,  6, 30, 24,  0, 12,   8]
    // Row 0 cumulative: [10, 20, 26, 56, 80, 80, 92, 100]
    // itemForRoll compares r * 100 against those, returning the first bucket
    // whose cumulative total is strictly greater.
    expect(itemForRoll(0, 0)).toBe('boost')        // 0.0   -> 0.0  < 10
    expect(itemForRoll(0, 0.001)).toBe('boost')    // 0.001 -> 0.1  < 10
    expect(itemForRoll(0, 0.199)).toBe('seeker')   // 0.199 -> 19.9 in [10, 20)
    expect(itemForRoll(0, 0.255)).toBe('bolt')     // 0.255 -> 25.5 in [20, 26)
    expect(itemForRoll(0, 0.407)).toBe('slick')    // 0.407 -> 40.7 in [26, 56)
    expect(itemForRoll(0, 0.707)).toBe('bubble')   // 0.707 -> 70.7 in [56, 80)
    expect(itemForRoll(0, 0.855)).toBe('blink')    // 0.855 -> 85.5 in [80, 92)
    expect(itemForRoll(0, 0.973)).toBe('charge')   // 0.973 -> 97.3 in [92, 100)
  })

  it('maps a roll to the bucket its cumulative weight covers, in 8th place', () => {
    // Row 7 weights   : [26, 12, 20,  2,  4, 22,  6,   8]
    // Row 7 cumulative: [26, 38, 58, 60, 64, 86, 92, 100]
    expect(itemForRoll(7, 0.101)).toBe('boost')    // 10.1 < 26
    expect(itemForRoll(7, 0.301)).toBe('seeker')   // 30.1 in [26, 38)
    expect(itemForRoll(7, 0.501)).toBe('bolt')     // 50.1 in [38, 58)
    expect(itemForRoll(7, 0.591)).toBe('slick')    // 59.1 in [58, 60)
    expect(itemForRoll(7, 0.621)).toBe('bubble')   // 62.1 in [60, 64)
    expect(itemForRoll(7, 0.801)).toBe('surge')    // 80.1 in [64, 86)
    expect(itemForRoll(7, 0.901)).toBe('blink')    // 90.1 in [86, 92)
    expect(itemForRoll(7, 0.991)).toBe('charge')   // 99.1 in [92, 100)
  })

  it('produces exactly weight*10 hits per item over a 1000-point sweep', () => {
    // r = (i + 0.5) / 1000 for i in 0..999. The half-offset keeps every sample
    // 0.05 away from a bucket edge, so no float rounding can move a sample
    // across a boundary. Bucket [a, b) then catches exactly 10*(b - a) samples.
    for (const place of [0, 7]) {
      const counts = new Map<ItemKind, number>()
      for (let i = 0; i < 1000; i++) {
        const item = itemForRoll(place, (i + 0.5) / 1000)
        counts.set(item, (counts.get(item) ?? 0) + 1)
      }
      for (let c = 0; c < 8; c++) {
        const item = ITEM_ROLL_ORDER[c]
        expect(counts.get(item) ?? 0).toBe(ITEM_WEIGHTS[place][c] * 10)
      }
    }
    // Spelled out for 1st place: boost 100, seeker 100, bolt 60, slick 300,
    // bubble 240, surge 0, blink 120, charge 80 -> 1000 samples.
    let firstPlaceSurge = 0
    for (let i = 0; i < 1000; i++) {
      if (itemForRoll(0, (i + 0.5) / 1000) === 'surge') firstPlaceSurge++
    }
    expect(firstPlaceSurge).toBe(0)
  })

  it('clamps an out-of-range placement into the table', () => {
    expect(itemForRoll(-3, 0.973)).toBe(itemForRoll(0, 0.973))
    expect(itemForRoll(99, 0.991)).toBe(itemForRoll(7, 0.991))
  })
})

describe('rollItem', () => {
  it('draws at the current cursor and advances it by exactly one per roll', () => {
    const ctx = makeContext(makeStraightTrack())
    const state = createState(ctx, 12345, ALL_CHARACTERS)
    state.rngCursor = 0
    expect(state.raceSeed).toBe(12345)

    // rngAt is a pure function of (seed, cursor), so the expected item is
    // computable without touching the sim.
    const r0 = rngAt(12345, 0)
    const r1 = rngAt(12345, 1)
    expect(r0).toBeGreaterThanOrEqual(0)
    expect(r0).toBeLessThan(1)

    expect(rollItem(ctx, state, 7)).toBe(itemForRoll(7, r0))
    expect(state.rngCursor).toBe(1)
    expect(rollItem(ctx, state, 7)).toBe(itemForRoll(7, r1))
    expect(state.rngCursor).toBe(2)
  })

  it('advances the cursor once per roll over 100 rolls', () => {
    const ctx = makeContext(makeStraightTrack())
    const state = createState(ctx, 999, ALL_CHARACTERS)
    state.rngCursor = 40
    for (let i = 0; i < 100; i++) rollItem(ctx, state, i % 8)
    expect(state.rngCursor).toBe(140) // 40 + 100
  })

  it('never rolls and never advances the cursor on a follower context', () => {
    const follower = makeContext(makeStraightTrack(), false)
    expect(follower.isLeader).toBe(false)
    const state = createState(follower, 12345, ALL_CHARACTERS)
    state.rngCursor = 0
    for (let i = 0; i < 200; i++) {
      expect(rollItem(follower, state, i % 8)).toBe('none')
      expect(state.rngCursor).toBe(0)
    }
  })
})

describe('placeIndexOf', () => {
  it('returns the 0-based placement of one kart', () => {
    const ctx = makeContext(makeStraightTrack())
    const state = createState(ctx, 1, ALL_CHARACTERS)
    expect(state.karts[5].playerId).toBe(5)
    // placement sorts by (lap, checkpointIdx, t) descending, playerId ascending
    // as the tie-break, so lap 2 beats lap 1 beats lap 0.
    state.karts[5].lap.lap = 2
    state.karts[3].lap.lap = 1
    expect(placeIndexOf(state, 5)).toBe(0)
    expect(placeIndexOf(state, 3)).toBe(1)
    // Everyone else is on lap 0 and ties, so playerId ascending orders them:
    // 0, 1, 2, 4, 6, 7 take places 2..7.
    expect(placeIndexOf(state, 0)).toBe(2)
    expect(placeIndexOf(state, 7)).toBe(7)
  })
})

// Four boxes: three at the same station so only their lateral offsets differ,
// plus one 0.01 of a lap further down the track.
//
// `s` is arc-normalised [0, 1), never metres. makeStraightTrack's control points
// 1, 2 and 3 are (150, 0, 0), (300, 0, 0) and (450, 0, 0) — evenly spaced and
// collinear — so the Catmull-Rom spline is exactly straight and exactly
// arc-uniform between them:  x = 150 + (s * total - 150.403834),  where
// total = query.totalLength() = 1828.3236243. Control point 1 sits at
// s = 0.0822632 and control point 3 at s = 0.2463480, so s = 0.1 and s = 0.11
// are both inside that span. There the tangent is exactly (1, 0, 0), so
// right = (-t.z, 0, t.x) is exactly (0, 0, 1) and lateral moves purely in +z:
//   s = 0.10 -> x = 182.428528494678
//   s = 0.11 -> x = 200.711764737947   (0.01 * 1828.3236243 = 18.283236243 m on)
//
// The three lateral offsets are 0, +6 and -7 so that the nearest pair is 6 m
// apart — more than 2 * (ITEM_BOX_RADIUS + kartRadius) = 5 m — and the reach
// tests below can sit a kart 2.4 m or 2.6 m from box 0 without straying inside
// another box's radius.
const BOX_TRACK_OVERRIDES = {
  itemBoxes: [
    { s: 0.1, lateral: 0 },
    { s: 0.1, lateral: 6 },
    { s: 0.1, lateral: -7 },
    { s: 0.11, lateral: 0 },
  ],
}

function boxedState(isLeader = true): { ctx: ReturnType<typeof makeContext>; state: SimState } {
  const ctx = makeContext(makeStraightTrack(BOX_TRACK_OVERRIDES), isLeader)
  const state = createState(ctx, 12345, ALL_CHARACTERS)
  state.rngCursor = 0
  // Set the box slots explicitly so these tests do not depend on how Task 5
  // seeds them; createState produces the same four entries.
  state.itemBoxes = [
    { boxIdx: 0, respawnTicks: 0 },
    { boxIdx: 1, respawnTicks: 0 },
    { boxIdx: 2, respawnTicks: 0 },
    { boxIdx: 3, respawnTicks: 0 },
  ]
  // Park every kart far off to the side so only the kart a test moves can
  // reach a box. The boxes sit near (182, 0, 0); a kart at (0, 0, 400) is
  // 440 m away, well beyond ITEM_BOX_RADIUS + kartRadius = 2.5.
  for (let i = 0; i < state.karts.length; i++) {
    state.karts[i].position.x = 0
    state.karts[i].position.z = 400 + i * 50
    state.karts[i].item = 'none'
    state.karts[i].respawnTicks = 0
  }
  return { ctx, state }
}

describe('itemBoxWorldPos', () => {
  it('offsets along the track right vector and advances along +X with s', () => {
    const { ctx } = boxedState()
    const a = v3(0, 0, 0)
    const b = v3(0, 0, 0)
    const c = v3(0, 0, 0)
    const d = v3(0, 0, 0)
    itemBoxWorldPos(ctx, 0, a)
    itemBoxWorldPos(ctx, 1, b)
    itemBoxWorldPos(ctx, 2, c)
    itemBoxWorldPos(ctx, 3, d)
    // Box 0 is the bare centreline point at s = 0.1:
    // x = 150 + (0.1 * 1828.3236243 - 150.403834) = 182.428528494678, y = z = 0.
    expect(a.x).toBeCloseTo(182.428528494678, 6)
    expect(a.y).toBe(0)
    expect(a.z).toBeCloseTo(0, 9)
    // Boxes 0..2 share s = 0.1, so they differ only by lateral along +z, and on
    // this exactly-straight span the right vector is exactly (0, 0, 1).
    expect(b.x - a.x).toBeCloseTo(0, 9)
    expect(b.z - a.z).toBeCloseTo(6, 9)   // lateral +6
    expect(c.z - a.z).toBeCloseTo(-7, 9)  // lateral -7
    // Box 3 sits 0.01 of a lap further along the same +X centreline:
    // 0.01 * 1828.3236243 = 18.283236243 m, and on this span arc length and x
    // advance together exactly, so the difference is that in metres of x.
    expect(d.x - a.x).toBeCloseTo(0.01 * ctx.query.totalLength(), 6)
    expect(d.x - a.x).toBeCloseTo(18.283236243, 6)
    expect(d.z - a.z).toBeCloseTo(0, 9)
  })
})

describe('updateItemBoxes on a leader', () => {
  it('grants an item, starts the respawn timer, and emits one itemGrant', () => {
    const { ctx, state } = boxedState()
    const p = v3(0, 0, 0)
    itemBoxWorldPos(ctx, 0, p)
    state.karts[0].position.x = p.x
    state.karts[0].position.z = p.z
    const events: AuthEvent[] = []

    updateItemBoxes(ctx, state, events)

    expect(state.itemBoxes[0].respawnTicks).toBe(180) // tuning.itemBoxRespawnTicks
    expect(state.rngCursor).toBe(1)
    expect(state.karts[0].item).not.toBe('none')
    expect(events.length).toBe(1)
    expect(events[0].kind).toBe('itemGrant')
    expect(events[0].playerId).toBe(0)
    expect(events[0].entityId).toBe(-1)
    expect(events[0].data).toBe(0) // boxIdx
    expect(events[0].item).toBe(state.karts[0].item)
    // The granted item is the one the table gives for this kart's placement.
    expect(state.karts[0].item).toBe(itemForRoll(placeIndexOf(state, 0), rngAt(12345, 0)))
  })

  it('collects inside 2.5 m and misses outside it', () => {
    // Reach = ITEM_BOX_RADIUS (1.6) + tuning.kartRadius (0.9) = 2.5.
    // Box 1 sits 6 m away in +z, so neither probe below can reach it either:
    // the closer probe is 6 - 2.4 = 3.6 m from it, the farther 6 - 2.6 = 3.4 m.
    expect(ITEM_BOX_RADIUS).toBe(1.6)
    const inside = boxedState()
    const p = v3(0, 0, 0)
    itemBoxWorldPos(inside.ctx, 0, p)
    inside.state.karts[0].position.x = p.x
    inside.state.karts[0].position.z = p.z + 2.4
    updateItemBoxes(inside.ctx, inside.state, [])
    expect(inside.state.itemBoxes[0].respawnTicks).toBe(180)
    expect(inside.state.rngCursor).toBe(1)

    const outside = boxedState()
    itemBoxWorldPos(outside.ctx, 0, p)
    outside.state.karts[0].position.x = p.x
    outside.state.karts[0].position.z = p.z + 2.6
    updateItemBoxes(outside.ctx, outside.state, [])
    expect(outside.state.itemBoxes[0].respawnTicks).toBe(0)
    expect(outside.state.rngCursor).toBe(0)
    expect(outside.state.karts[0].item).toBe('none')
  })

  it('ignores a kart that already holds an item or is respawning', () => {
    const holding = boxedState()
    const p = v3(0, 0, 0)
    itemBoxWorldPos(holding.ctx, 0, p)
    holding.state.karts[0].position.x = p.x
    holding.state.karts[0].position.z = p.z
    holding.state.karts[0].item = 'boost'
    updateItemBoxes(holding.ctx, holding.state, [])
    expect(holding.state.itemBoxes[0].respawnTicks).toBe(0)
    expect(holding.state.rngCursor).toBe(0)
    expect(holding.state.karts[0].item).toBe('boost')

    const respawning = boxedState()
    itemBoxWorldPos(respawning.ctx, 0, p)
    respawning.state.karts[0].position.x = p.x
    respawning.state.karts[0].position.z = p.z
    respawning.state.karts[0].respawnTicks = 5
    updateItemBoxes(respawning.ctx, respawning.state, [])
    expect(respawning.state.itemBoxes[0].respawnTicks).toBe(0)
    expect(respawning.state.rngCursor).toBe(0)
  })

  it('counts a taken box back down to 0 in exactly itemBoxRespawnTicks calls', () => {
    const { ctx, state } = boxedState()
    state.itemBoxes[0].respawnTicks = 180
    // No kart is within reach, so nothing but the timer moves.
    for (let i = 0; i < 179; i++) updateItemBoxes(ctx, state, [])
    expect(state.itemBoxes[0].respawnTicks).toBe(1) // 180 - 179
    updateItemBoxes(ctx, state, [])
    expect(state.itemBoxes[0].respawnTicks).toBe(0) // 180 - 180
    expect(state.rngCursor).toBe(0)
  })

  it('grants at most one item per box per tick', () => {
    const { ctx, state } = boxedState()
    const p = v3(0, 0, 0)
    itemBoxWorldPos(ctx, 0, p)
    // Three karts stacked on the same box; only the lowest playerId collects.
    for (const id of [2, 5, 6]) {
      state.karts[id].position.x = p.x
      state.karts[id].position.z = p.z
    }
    const events: AuthEvent[] = []
    updateItemBoxes(ctx, state, events)
    expect(events.length).toBe(1)
    expect(events[0].playerId).toBe(2)
    expect(state.rngCursor).toBe(1)
    expect(state.karts[5].item).toBe('none')
    expect(state.karts[6].item).toBe('none')
  })
})

describe('updateItemBoxes on a follower', () => {
  it('NEVER advances rngCursor, grants nothing, and emits nothing', () => {
    const { ctx, state } = boxedState(false)
    expect(ctx.isLeader).toBe(false)
    const p = v3(0, 0, 0)
    itemBoxWorldPos(ctx, 0, p)
    // Sit every kart on a box so every pickup path is exercised.
    for (let i = 0; i < state.karts.length; i++) {
      state.karts[i].position.x = p.x
      state.karts[i].position.z = p.z
    }
    const events: AuthEvent[] = []
    for (let i = 0; i < 10; i++) {
      updateItemBoxes(ctx, state, events)
      expect(state.rngCursor).toBe(0)
    }
    expect(state.rngCursor).toBe(0)
    expect(events.length).toBe(0)
    for (let i = 0; i < state.karts.length; i++) {
      expect(state.karts[i].item).toBe('none')
    }
    // The follower still tracks the box: taken on call 1 (set to 180), then
    // decremented on calls 2..10 -> 180 - 9 = 171.
    expect(state.itemBoxes[0].respawnTicks).toBe(171)
  })

  it('takes its item from an incoming itemGrant event', () => {
    const { ctx, state } = boxedState(false)
    expect(state.karts[2].playerId).toBe(2)
    const ev: AuthEvent = {
      eventSeq: 4,
      tick: 30,
      kind: 'itemGrant',
      playerId: 2,
      entityId: -1,
      item: 'surge',
      data: 1,
    }
    applyItemGrant(ctx, state, ev)
    expect(state.karts[2].item).toBe('surge')
    expect(state.rngCursor).toBe(0)
    // The grant also confirms the box, in case the follower had not seen the
    // pickup locally (post-resync).
    expect(state.itemBoxes[1].respawnTicks).toBe(180)
  })

  it('ignores events of any other kind and unknown players', () => {
    const { ctx, state } = boxedState(false)
    applyItemGrant(ctx, state, {
      eventSeq: 5, tick: 31, kind: 'hit', playerId: 2,
      entityId: 7, item: 'bolt', data: 0,
    })
    expect(state.karts[2].item).toBe('none')
    applyItemGrant(ctx, state, {
      eventSeq: 6, tick: 32, kind: 'itemGrant', playerId: 99,
      entityId: -1, item: 'bolt', data: 0,
    })
    for (let i = 0; i < state.karts.length; i++) {
      expect(state.karts[i].item).toBe('none')
    }
    expect(state.rngCursor).toBe(0)
  })
})

function firingState(): { ctx: ReturnType<typeof makeContext>; state: SimState } {
  const ctx = makeContext(makeStraightTrack())
  const state = createState(ctx, 4242, ALL_CHARACTERS)
  state.rngCursor = 0
  state.entityCount = 0
  // Kart 3 fires from (10, 0, 4) pointing along +X: cos(0) = 1, sin(0) = 0, so
  // every offset below lands on exact integers.
  const k = state.karts[3]
  k.position.x = 10
  k.position.y = 0
  k.position.z = 4
  k.heading = 0
  k.item = 'none'
  k.boostTicks = 0
  k.invulnTicks = 0
  k.spinOutTicks = 0
  k.respawnTicks = 0
  k.shielded = false
  // Placement: kart 5 leads on lap 2, kart 3 is second on lap 1.
  state.karts[5].lap.lap = 2
  state.karts[3].lap.lap = 1
  return { ctx, state }
}

describe('seekerTargetFor', () => {
  it('targets the kart one place ahead, and nothing for the leader', () => {
    const { state } = firingState()
    expect(placeIndexOf(state, 5)).toBe(0)
    expect(placeIndexOf(state, 3)).toBe(1)
    expect(seekerTargetFor(state, 3)).toBe(5)
    expect(seekerTargetFor(state, 5)).toBe(-1)
  })
})

describe('useItem — no-entity items', () => {
  it('boost sets a 90-tick burst and consumes the item', () => {
    const { ctx, state } = firingState()
    const k = state.karts[3]
    k.item = 'boost'
    const events: AuthEvent[] = []
    useItem(ctx, state, k, events)
    expect(ITEM_BOOST_TICKS).toBe(90)
    expect(k.boostTicks).toBe(90)
    expect(k.item).toBe('none')
    expect(state.entityCount).toBe(0)
    expect(events.length).toBe(0) // useItem itself emits nothing
  })

  it('boost never shortens a longer burst already running', () => {
    const { ctx, state } = firingState()
    const k = state.karts[3]
    k.item = 'boost'
    k.boostTicks = 120
    useItem(ctx, state, k, [])
    expect(k.boostTicks).toBe(120)
  })

  it('blink grants invulnerability AND speed, with no entity', () => {
    const { ctx, state } = firingState()
    const k = state.karts[3]
    k.item = 'blink'
    const events: AuthEvent[] = []
    useItem(ctx, state, k, events)
    expect(BLINK_INVULN_TICKS).toBe(90)
    expect(BLINK_BOOST_TICKS).toBe(45)
    expect(k.invulnTicks).toBe(90)
    expect(k.boostTicks).toBe(45)
    expect(k.item).toBe('none')
    expect(state.entityCount).toBe(0)
    expect(events.length).toBe(0)
  })

  it('blink never shortens a longer invulnerability already running', () => {
    const { ctx, state } = firingState()
    const k = state.karts[3]
    k.item = 'blink'
    k.invulnTicks = 200
    k.boostTicks = 60
    useItem(ctx, state, k, [])
    expect(k.invulnTicks).toBe(200)
    expect(k.boostTicks).toBe(60)
  })

  it('does nothing at all with no item held', () => {
    const { ctx, state } = firingState()
    const k = state.karts[3]
    k.item = 'none'
    const events: AuthEvent[] = []
    useItem(ctx, state, k, events)
    expect(k.boostTicks).toBe(0)
    expect(k.invulnTicks).toBe(0)
    expect(state.entityCount).toBe(0)
    expect(events.length).toBe(0)
  })

  it('keeps the item instead of wasting it while spun out or respawning', () => {
    const spun = firingState()
    spun.state.karts[3].item = 'boost'
    spun.state.karts[3].spinOutTicks = 10
    useItem(spun.ctx, spun.state, spun.state.karts[3], [])
    expect(spun.state.karts[3].item).toBe('boost')
    expect(spun.state.karts[3].boostTicks).toBe(0)

    const dead = firingState()
    dead.state.karts[3].item = 'seeker'
    dead.state.karts[3].respawnTicks = 30
    useItem(dead.ctx, dead.state, dead.state.karts[3], [])
    expect(dead.state.karts[3].item).toBe('seeker')
    expect(dead.state.entityCount).toBe(0)
  })
})

describe('useItem — entity items', () => {
  it('seeker spawns 2 m ahead at seekerSpeed, homing on the kart in front', () => {
    const { ctx, state } = firingState()
    const k = state.karts[3]
    k.item = 'seeker'
    useItem(ctx, state, k, [])
    expect(state.entityCount).toBe(1)
    const e = state.entities[0]
    expect(e.kind).toBe('seeker')
    expect(e.ownerId).toBe(3)
    expect(ITEM_FIRE_OFFSET).toBe(2)
    expect(e.position.x).toBe(12) // 10 + cos(0) * 2
    expect(e.position.y).toBe(0)
    expect(e.position.z).toBe(4)  // 4 + sin(0) * 2
    expect(e.heading).toBe(0)
    expect(e.targetId).toBe(5)
    expect(e.velocity.x).toBe(55) // tuning.seekerSpeed
    expect(e.velocity.y).toBe(0)
    expect(e.velocity.z).toBe(0)
    expect(e.ttl).toBe(600)       // tuning.entityTtl
    expect(k.item).toBe('none')
  })

  it('bolt spawns 2 m ahead at boltSpeed with no target', () => {
    const { ctx, state } = firingState()
    const k = state.karts[3]
    k.item = 'bolt'
    useItem(ctx, state, k, [])
    expect(state.entityCount).toBe(1)
    const e = state.entities[0]
    expect(e.kind).toBe('bolt')
    expect(e.ownerId).toBe(3)
    expect(e.position.x).toBe(12)
    expect(e.position.z).toBe(4)
    expect(e.targetId).toBe(-1)
    expect(e.velocity.x).toBe(65) // tuning.boltSpeed
    expect(e.velocity.z).toBe(0)
    expect(e.ttl).toBe(600)
  })

  it('slick drops 2 m behind, stationary', () => {
    const { ctx, state } = firingState()
    const k = state.karts[3]
    k.item = 'slick'
    useItem(ctx, state, k, [])
    expect(state.entityCount).toBe(1)
    const e = state.entities[0]
    expect(e.kind).toBe('slick')
    expect(ITEM_DROP_OFFSET).toBe(2)
    expect(e.position.x).toBe(8) // 10 - cos(0) * 2
    expect(e.position.z).toBe(4)
    expect(e.velocity.x).toBe(0)
    expect(e.velocity.y).toBe(0)
    expect(e.velocity.z).toBe(0)
    expect(e.targetId).toBe(-1)
    expect(e.ttl).toBe(600)
  })

  it('bubble spawns on the owner, targets the owner, and raises the shield', () => {
    const { ctx, state } = firingState()
    const k = state.karts[3]
    k.item = 'bubble'
    useItem(ctx, state, k, [])
    expect(state.entityCount).toBe(1)
    const e = state.entities[0]
    expect(e.kind).toBe('bubble')
    expect(e.ownerId).toBe(3)
    expect(e.targetId).toBe(3)
    expect(e.position.x).toBe(10)
    expect(e.position.z).toBe(4)
    expect(e.velocity.x).toBe(0)
    expect(e.velocity.z).toBe(0)
    expect(k.shielded).toBe(true)
  })

  it('surge spawns a 300-tick field owned by the user', () => {
    const { ctx, state } = firingState()
    const k = state.karts[3]
    k.item = 'surge'
    useItem(ctx, state, k, [])
    expect(state.entityCount).toBe(1)
    const e = state.entities[0]
    expect(e.kind).toBe('surge')
    expect(e.ownerId).toBe(3)
    expect(e.targetId).toBe(-1)
    expect(SURGE_TTL_TICKS).toBe(300)
    expect(e.ttl).toBe(300)
    expect(e.position.x).toBe(10)
    expect(e.position.z).toBe(4)
  })

  it('charge spawns a 20-tick blast on the kart', () => {
    const { ctx, state } = firingState()
    const k = state.karts[3]
    k.item = 'charge'
    useItem(ctx, state, k, [])
    expect(state.entityCount).toBe(1)
    const e = state.entities[0]
    expect(e.kind).toBe('charge')
    expect(e.ownerId).toBe(3)
    expect(e.targetId).toBe(-1)
    expect(CHARGE_TTL_TICKS).toBe(20)
    expect(e.ttl).toBe(20)
    expect(e.position.x).toBe(10)
    expect(e.position.z).toBe(4)
  })

  it('consumes the item exactly once', () => {
    const { ctx, state } = firingState()
    const k = state.karts[3]
    k.item = 'bolt'
    useItem(ctx, state, k, [])
    expect(state.entityCount).toBe(1)
    useItem(ctx, state, k, [])
    expect(state.entityCount).toBe(1)
    expect(k.item).toBe('none')
  })

  it('consumes the item and raises no shield when the entity pool is full', () => {
    const { ctx, state } = firingState()
    state.entityCount = MAX_ENTITIES // 32
    const k = state.karts[3]
    k.item = 'bubble'
    useItem(ctx, state, k, [])
    expect(state.entityCount).toBe(MAX_ENTITIES)
    expect(k.item).toBe('none')
    expect(k.shielded).toBe(false)
  })
})

describe('step() wiring', () => {
  it('runs item boxes once per tick against the new state', async () => {
    const { step } = await import('../src/step')
    const ctx = makeContext(makeStraightTrack(BOX_TRACK_OVERRIDES))
    const prev = createState(ctx, 12345, ALL_CHARACTERS)
    const next = createState(ctx, 12345, ALL_CHARACTERS)
    prev.phase = 'racing'
    prev.tick = 300
    prev.rngCursor = 0
    prev.itemBoxes = [
      { boxIdx: 0, respawnTicks: 0 },
      { boxIdx: 1, respawnTicks: 0 },
      { boxIdx: 2, respawnTicks: 0 },
      { boxIdx: 3, respawnTicks: 0 },
    ]
    // Everyone except kart 0 is parked far off the racing line.
    for (let i = 1; i < prev.karts.length; i++) {
      prev.karts[i].position.z = 400 + i * 50
    }
    const p = v3(0, 0, 0)
    itemBoxWorldPos(ctx, 0, p)
    prev.karts[0].position.x = p.x
    prev.karts[0].position.y = p.y
    prev.karts[0].position.z = p.z
    prev.karts[0].item = 'none'

    const inputs = ALL_CHARACTERS.map(() => ({
      tick: 300, steer: 0, accel: 1, brake: false, drift: false, useItem: false,
    }))
    const events: AuthEvent[] = []
    step(ctx, prev, next, inputs, events)

    expect(next.itemBoxes[0].respawnTicks).toBe(180)
    expect(next.rngCursor).toBe(1)
    expect(next.karts[0].item).not.toBe('none')
    expect(prev.rngCursor).toBe(0) // step never mutates prev
  })

  it('fires the held item from inside the per-kart loop', async () => {
    const { step } = await import('../src/step')
    const ctx = makeContext(makeStraightTrack())
    const prev = createState(ctx, 777, ALL_CHARACTERS)
    const next = createState(ctx, 777, ALL_CHARACTERS)
    prev.phase = 'racing'
    prev.tick = 300
    // Slot 0 must be driven by the supplied Intent rather than by botIntent,
    // which is the distinction resolveInputs [Task 15] keys on once it exists.
    prev.karts[0].isBot = false
    prev.karts[0].connected = true
    prev.karts[0].item = 'boost'
    prev.karts[0].boostTicks = 0
    // Every kart is still at its start position, s = 0.01..0.055 of a lap, i.e.
    // inside the first 0.055 * 1828.3236243 = 100.6 m. The default straight
    // fixture's three item boxes are at s = 0.3, some 450 m further on, so
    // nothing is picked up on this tick and the item slot stays empty.

    const inputs = ALL_CHARACTERS.map((_, i) => ({
      tick: 300, steer: 0, accel: 1, brake: false, drift: false,
      useItem: i === 0,
    }))
    const events: AuthEvent[] = []
    step(ctx, prev, next, inputs, events)

    // useItem grants ITEM_BOOST_TICKS = 90 at the top of the kart loop body, and
    // decayBoost [Task 8] — canonical slot 8, the last statement of that same
    // loop body — spends one of them on the same tick: 90 - 1 = 89.
    expect(next.karts[0].boostTicks).toBe(ITEM_BOOST_TICKS - 1)
    expect(next.karts[0].boostTicks).toBe(89)
    expect(next.karts[0].item).toBe('none')
    // step never mutates prev
    expect(prev.karts[0].item).toBe('boost')
    expect(prev.karts[0].boostTicks).toBe(0)
  })
})
