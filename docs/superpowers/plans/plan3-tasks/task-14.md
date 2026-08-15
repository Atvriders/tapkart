### Task 14: `packages/render/src/smoothing.ts` — error smoothing (R41)

**This is a required part of the render layer, not a polish item, and the whole
netcode trade is dishonest without it.**

The measurement, from Plan 2 Task 15's review: `ClientLoop` converges to roughly
**one correction per 600 ticks under a held-steady intent**, but **about three
corrections per second under input that changes** — 29 under a sine, 39 under a
square wave. Changing input is all real driving. The reviewer attributed it
properly rather than guessing: it implemented the client-side fix (predicting
against the intent the authority is holding) and measured **no difference**, so it
is not a client defect. It falls out of spec §5's own rule that the authority
applies the newest intent it has **received** at its own tick rather than
buffering by stamped tick — and under jitter, *which* intent is newest at
authority-tick T is a fact about packet delivery that no client can predict.

The controller ruled that Tapkart keeps immediate application and **absorbs the
corrections in rendering**, because the alternative — a tick-buffered authority
with a playout delay — adds input latency to every control on a touchscreen
racer, where latency is the first thing a player feels. That ruling is only
honest if something actually absorbs them. The corrections are small: they fire
just past `EPS.position` (~5 cm) against roughly 33 cm of travel per tick at
speed, so they are entirely hideable — **but only if the kart is not snapped to
them.** Without this module the trade is just "the kart jumps three times a
second."

Two details a task author is likely to flatten, and this task does not:

- **Both position and heading are smoothed, on ONE eased fraction derived from
  ONE `ticksSince`.** Two smoothing rates on one object is how a kart ends up
  visually cornering out of phase with itself. Heading is included because it
  *dominates* error growth: 0.0024 rad of heading error at 20 m/s is 0.048 m/s of
  lateral drift, about three times what the velocity residual produces, and it
  crosses a lane in a second. An earlier draft dropped heading smoothing by
  mistaking `EPS.heading = 0.0025` — the threshold at which a heading correction
  *fires* — for a bound on the correction's *size*. It is not: past that
  threshold `resyncOwnKart` writes the authoritative heading whatever the
  divergence is. Contract §4.9a records that as a pull-quote; this task does not
  re-introduce the error.
- **`ERROR_SMOOTH_MAX_HEADING_RAD = 0.15` is derived, not chosen.** Easing an
  offset of `x` radians over the window has a peak apparent yaw rate at `t = 0`
  of `3x / (ERROR_SMOOTH_WINDOW_TICKS * TICK_DT)` = `15x` rad/s — the derivative
  of the cubic. The player reads any yaw the car produces on its own as steering,
  so the smoothing must stay under the car's own maximum steering rate,
  `TUNING.steerRateBase = 2.6` rad/s: `15 × 0.15 = 2.25` rad/s, comfortably
  under, and 0.15 rad is 8.6°, larger than any correction that is not a resync.
  §8.1 requires that bound to be asserted **against the shipped constants** rather
  than trusted from the comment, and Step 1 does exactly that.

The offset is render-only: it is added to `KartView.position` and
`KartView.heading` by `ViewBuilder` and to nothing else (§7.2). `session.state()`
stays exactly what `ClientLoop` reconciled, the next tick predicts from the
authoritative value, and the smoothing can therefore never feed back into the
simulation or into what the authority is told. It applies to the **local seat on a
guest only** — every other seat is interpolated, which has no corrections to hide,
and host/solo seats are authoritative.

**Files:**
- Create: `packages/render/src/smoothing.ts`
- Test: `packages/render/test/smoothing.test.ts`

**Do not touch `packages/render/src/index.ts`.** Task 15 owns the barrel and adds
`export * from './smoothing'` there, with the rest of §4.11's list, in one edit.

**Interfaces:**

- Consumes:
  - `@tapkart/sim` [Plan 1, shipped — read from `packages/sim/src/`]:
    ```ts
    export type Vec3 = { x: number; y: number; z: number }
    export const TICK_DT = 1 / 60
    export function clamp(v: number, lo: number, hi: number): number
    /** Wraps an angle into the half-open range (-PI, PI]. Upper-inclusive on
     *  purpose: a kart travelling along -x has heading Math.atan2(0, -1) === PI
     *  exactly, and it must stay at +PI rather than oscillating. */
    export function wrapAngle(a: number): number
    ```
  - `@tapkart/content` [the content tuning task, §3a.2] — used by the **test
    only**, never by `src/smoothing.ts`:
    ```ts
    /** The Tuning the game actually races with. Numerically identical to
     *  makeTuning(), asserted field-by-field in packages/content/test/. */
    export const TUNING: Readonly<Tuning>      // TUNING.steerRateBase === 2.6
    ```
  - `@tapkart/net` [Plan 2 Task 15b, §2.5] — quoted because it is the **source of
    this module's nullable**, not because this module imports it. It does not:
    ```ts
    /** R47, R48. The discontinuity the last reconciliation applied to the local
     *  kart: position delta in metres into `outPos`, heading delta in radians
     *  (shortest arc, wrapped to [-PI, PI]) as the return value. Returns null if
     *  the most recent tick() applied no correction. */
    export function correctionDeltaOf(client: ClientLoop, outPos: Vec3): number | null
    ```
    `RaceSession.correctionDelta(outPos: Vec3): number | null` (§5.10) delegates
    to it and computes nothing, and `ViewBuilder` (§5.11 step 11a) passes what it
    returns straight into `advanceVisualOffset` as `correctionHeading`. **`null`
    means no reconciliation happened; `0` means one happened and moved the heading
    by exactly zero.** Those are different answers and both are meaningful — a
    reconciliation that moved the heading by exactly zero still restarts the ease
    window — which is why this function takes `number | null` and there is no
    separate `corrected` boolean. The distinction is carried from its source and
    **must never be reconstructed at a higher layer.**

- Produces — the seven exports contract §4.9a pins (the census's `+7`):
  ```ts
  /** The retained visual error for ONE seat: metres for position, radians for
   *  heading. `current`/`currentHeading` are what the view adds to the drawn
   *  pose; `origin`/`originHeading` are the offset at the instant of the most
   *  recent correction, which is what the ease decays from. */
  export interface VisualOffset {
    origin: Vec3
    originHeading: number       // radians
    ticksSince: number          // ticks since the most recent correction
    current: Vec3               // the eased offset to ADD to the drawn position
    currentHeading: number      // radians, ADDED to the drawn heading
  }
  export function createVisualOffset(): VisualOffset
  export const ERROR_SMOOTH_WINDOW_TICKS = 12
  export const ERROR_SMOOTH_MAX_POSITION_M = 2.5
  export const ERROR_SMOOTH_MAX_HEADING_RAD = 0.15
  export function easeRemaining(t01: number): number
  export function advanceVisualOffset(prev: VisualOffset, correctionPos: Vec3,
                                      correctionHeading: number | null,
                                      ticksElapsed: number, out: VisualOffset): void
  ```
  `out` MAY alias `prev` — `ViewBuilder` calls it as
  `advanceVisualOffset(offset, scratchVec3, h, ticksElapsed, offset)` on its one
  pre-allocated offset, so aliasing is the normal case and not an edge case.

  `advanceVisualOffset`'s rule, verbatim from §4.9a:

  - `correctionHeading !== null` re-seeds:
    `out.origin = prev.current + correctionPos`,
    `out.originHeading = wrapAngle(prev.currentHeading + correctionHeading)`,
    `out.ticksSince = 0`
  - `null`: both origins carry over, `out.ticksSince = prev.ticksSince + ticksElapsed`
  - then `f = easeRemaining(out.ticksSince / ERROR_SMOOTH_WINDOW_TICKS)`,
    `out.current = out.origin * f` and `out.currentHeading = out.originHeading * f`
    — **ONE `f`**, so the two channels can never fall out of phase
  - and if `|out.origin| > ERROR_SMOOTH_MAX_POSITION_M` **or**
    `|out.originHeading| > ERROR_SMOOTH_MAX_HEADING_RAD`, every field is zeroed:
    either channel tripping its guard cuts **both**, because easing half a resync
    is worse than cutting all of it.
  - `correctionPos` is ignored when `correctionHeading` is null.
  - Deterministic and frame-rate independent: `ticksElapsed` is SIM TICKS, never
    frames.

---

- [ ] **Step 1: Write the failing test**

Create `packages/render/test/smoothing.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { TICK_DT, wrapAngle } from '@tapkart/sim'
import type { Vec3 } from '@tapkart/sim'
import { TUNING } from '@tapkart/content'

import {
  ERROR_SMOOTH_MAX_HEADING_RAD,
  ERROR_SMOOTH_MAX_POSITION_M,
  ERROR_SMOOTH_WINDOW_TICKS,
  advanceVisualOffset,
  createVisualOffset,
  easeRemaining,
} from '../src/smoothing'
import type { VisualOffset } from '../src/smoothing'

const ZERO: Vec3 = { x: 0, y: 0, z: 0 }

function v(x: number, y: number, z: number): Vec3 {
  return { x, y, z }
}

/** One correction of (pos, heading) arriving on this tick. */
function correct(o: VisualOffset, pos: Vec3, heading: number): void {
  advanceVisualOffset(o, pos, heading, 1, o)
}

/** `ticks` sim ticks with no reconciliation. */
function idle(o: VisualOffset, ticks: number): void {
  advanceVisualOffset(o, ZERO, null, ticks, o)
}

function snapshot(o: VisualOffset): VisualOffset {
  return {
    origin: { x: o.origin.x, y: o.origin.y, z: o.origin.z },
    originHeading: o.originHeading,
    ticksSince: o.ticksSince,
    current: { x: o.current.x, y: o.current.y, z: o.current.z },
    currentHeading: o.currentHeading,
  }
}

function isAllZero(o: VisualOffset): boolean {
  return o.origin.x === 0 && o.origin.y === 0 && o.origin.z === 0
    && o.originHeading === 0 && o.ticksSince === 0
    && o.current.x === 0 && o.current.y === 0 && o.current.z === 0
    && o.currentHeading === 0
}

describe('createVisualOffset', () => {
  it('starts at zero with distinct Vec3s', () => {
    const o = createVisualOffset()
    expect(isAllZero(o)).toBe(true)
    // Two fields sharing one Vec3 would make `current` track `origin` forever.
    expect(o.origin).not.toBe(o.current)
    const a = createVisualOffset()
    const b = createVisualOffset()
    expect(a.origin).not.toBe(b.origin)
  })
})

describe('easeRemaining', () => {
  it('is 1 at the start of the window and exactly 0 at its end', () => {
    expect(easeRemaining(0)).toBe(1)
    expect(easeRemaining(1)).toBe(0)
  })

  it('is the ease-out cubic, not a linear or quadratic falloff', () => {
    expect(easeRemaining(0.5)).toBe(0.125)          // linear: 0.5, quadratic: 0.25
    expect(easeRemaining(0.25)).toBe(0.421875)      // (1 - 0.25) ** 3
    expect(easeRemaining(0.75)).toBe(0.015625)
  })

  it('clamps outside [0, 1] instead of growing or going negative', () => {
    expect(easeRemaining(-5)).toBe(1)
    expect(easeRemaining(-0.0001)).toBe(1)
    expect(easeRemaining(3)).toBe(0)
    expect(easeRemaining(1e9)).toBe(0)
  })

  it('settles rather than arriving: its slope at the end of the window is zero', () => {
    const h = 1e-4
    const slope = (easeRemaining(1) - easeRemaining(1 - h)) / h
    expect(Math.abs(slope)).toBeLessThan(1e-6)      // cubic: ~1e-8, quadratic: ~1e-4
  })
})

describe('advanceVisualOffset — the correction tick', () => {
  it('applies the whole correction on the tick it arrives, in both channels', () => {
    const o = createVisualOffset()
    correct(o, v(0.05, 0, -0.02), 0.05)

    expect(o.ticksSince).toBe(0)
    expect(o.origin).toEqual({ x: 0.05, y: 0, z: -0.02 })
    expect(o.originHeading).toBe(0.05)
    // f = easeRemaining(0) = 1, so the drawn pose is exactly where it was before
    // the reconciliation moved it: the correction is invisible on its own tick.
    expect(o.current).toEqual({ x: 0.05, y: 0, z: -0.02 })
    expect(o.currentHeading).toBe(0.05)
  })

  it('adds a new correction to the error still on screen, not to the original one', () => {
    const o = createVisualOffset()
    correct(o, v(0.05, 0, 0), 0.05)
    idle(o, 6)
    expect(o.current.x).toBeCloseTo(0.00625, 12)    // 0.05 * easeRemaining(0.5)
    expect(o.currentHeading).toBeCloseTo(0.00625, 12)

    correct(o, v(0.02, 0, 0), 0.02)
    expect(o.origin.x).toBeCloseTo(0.02625, 12)     // prev.current + delta
    expect(o.originHeading).toBeCloseTo(0.02625, 12)
    expect(o.ticksSince).toBe(0)
  })

  it('wraps the re-seeded heading origin to the shortest arc', () => {
    const o = createVisualOffset()
    o.currentHeading = 6.2                          // synthetic prior, to reach the wrap
    correct(o, ZERO, 0.05)
    expect(o.originHeading).toBeCloseTo(wrapAngle(6.25), 12)
    expect(o.originHeading).toBeCloseTo(-0.0331853071795862, 12)
    expect(isAllZero(o)).toBe(false)
  })
})

describe('advanceVisualOffset — the ease', () => {
  it('reaches exactly zero after ERROR_SMOOTH_WINDOW_TICKS and stays there', () => {
    const o = createVisualOffset()
    correct(o, v(0.05, 0, 0.05), 0.05)
    idle(o, ERROR_SMOOTH_WINDOW_TICKS)

    expect(o.current.x).toBe(0)
    expect(o.current.z).toBe(0)
    expect(o.currentHeading).toBe(0)

    idle(o, 5)
    expect(o.current.x).toBe(0)
    expect(o.currentHeading).toBe(0)
  })

  it('decreases monotonically in both channels across the window', () => {
    const o = createVisualOffset()
    correct(o, v(0.05, 0, 0), 0.05)
    let lastPos = Math.abs(o.current.x)
    let lastHeading = Math.abs(o.currentHeading)
    for (let i = 0; i < ERROR_SMOOTH_WINDOW_TICKS; i++) {
      idle(o, 1)
      expect(Math.abs(o.current.x)).toBeLessThan(lastPos)
      expect(Math.abs(o.currentHeading)).toBeLessThan(lastHeading)
      lastPos = Math.abs(o.current.x)
      lastHeading = Math.abs(o.currentHeading)
    }
    expect(lastPos).toBe(0)
    expect(lastHeading).toBe(0)
  })

  it('drives both channels with ONE eased fraction, tick by tick', () => {
    const o = createVisualOffset()
    correct(o, v(0.4, 0, -0.3), 0.06)
    for (let i = 0; i < ERROR_SMOOTH_WINDOW_TICKS; i++) {
      idle(o, 1)
      const f = easeRemaining(o.ticksSince / ERROR_SMOOTH_WINDOW_TICKS)
      expect(o.current.x).toBe(o.origin.x * f)
      expect(o.current.z).toBe(o.origin.z * f)
      expect(o.currentHeading).toBe(o.originHeading * f)
    }
  })

  it('is frame-rate independent: N calls of one tick equal one call of N ticks', () => {
    const a = createVisualOffset()
    const b = createVisualOffset()
    correct(a, v(0.4, 0, -0.2), 0.06)
    correct(b, v(0.4, 0, -0.2), 0.06)
    for (let i = 0; i < 5; i++) idle(a, 1)
    idle(b, 5)
    expect(a).toEqual(b)
    expect(a.ticksSince).toBe(5)
  })

  it('changes nothing when ticksElapsed is 0', () => {
    const o = createVisualOffset()
    correct(o, v(0.05, 0, 0), 0.05)
    idle(o, 3)
    const before = snapshot(o)
    idle(o, 0)
    expect(o).toEqual(before)
  })

  it('writes a correct result when `out` aliases `prev`', () => {
    // ViewBuilder calls this as advanceVisualOffset(offset, ..., offset) on its
    // one pre-allocated offset, so aliasing is the shipped call shape.
    const steps: { pos: Vec3; heading: number | null; ticks: number }[] = [
      { pos: v(0.05, 0, 0), heading: 0.05, ticks: 1 },
      { pos: ZERO, heading: null, ticks: 4 },
      { pos: v(0.02, 0, -0.01), heading: 0.01, ticks: 1 },
      { pos: ZERO, heading: null, ticks: 2 },
    ]

    const aliased = createVisualOffset()
    for (const s of steps) advanceVisualOffset(aliased, s.pos, s.heading, s.ticks, aliased)

    // The same sequence with a fresh `out` every call, so no step can hide an
    // aliasing bug behind an identically-broken reference.
    let readFrom = createVisualOffset()
    for (const s of steps) {
      const writeTo = createVisualOffset()
      advanceVisualOffset(readFrom, s.pos, s.heading, s.ticks, writeTo)
      readFrom = writeTo
    }

    expect(aliased).toEqual(readFrom)
    expect(aliased.current.x).toBeGreaterThan(0)     // and the sequence is not all-zero
  })
})

describe('advanceVisualOffset — null is not zero', () => {
  it('restarts the window on a heading delta of exactly 0', () => {
    const o = createVisualOffset()
    correct(o, v(0.3, 0, 0), 0.04)
    idle(o, 6)
    const carried = { x: o.current.x, h: o.currentHeading }
    expect(o.ticksSince).toBe(6)

    advanceVisualOffset(o, ZERO, 0, 1, o)
    expect(o.ticksSince).toBe(0)
    expect(o.origin.x).toBeCloseTo(carried.x, 12)
    expect(o.originHeading).toBeCloseTo(carried.h, 12)
    expect(o.current.x).toBeCloseTo(carried.x, 12)     // f = 1 again
  })

  it('keeps decaying on null', () => {
    const o = createVisualOffset()
    correct(o, v(0.3, 0, 0), 0.04)
    idle(o, 6)
    const before = o.current.x

    advanceVisualOffset(o, ZERO, null, 1, o)
    expect(o.ticksSince).toBe(7)
    expect(o.current.x).toBeLessThan(before)
  })

  it('ignores correctionPos entirely when correctionHeading is null', () => {
    const o = createVisualOffset()
    correct(o, v(0.05, 0, 0), 0.05)
    const after = snapshot(o)

    // A caller whose outPos scratch still holds the previous delta must not be
    // able to inject it: `null` means nothing happened, whatever outPos says.
    advanceVisualOffset(o, v(99, 99, 99), null, 0, o)
    expect(o).toEqual(after)
  })
})

describe('advanceVisualOffset — the guards', () => {
  it('cuts BOTH channels when the position delta exceeds the position guard', () => {
    const o = createVisualOffset()
    correct(o, v(30, 0, 0), 0.01)
    expect(isAllZero(o)).toBe(true)
  })

  it('cuts BOTH channels when the heading delta exceeds the heading guard', () => {
    const o = createVisualOffset()
    correct(o, v(0.05, 0, 0), 0.5)
    expect(isAllZero(o)).toBe(true)
  })

  it('measures |origin| in three dimensions, not one axis', () => {
    const o = createVisualOffset()
    correct(o, v(2, 0, 2), 0.01)                  // hypot = 2.83 > 2.5
    expect(isAllZero(o)).toBe(true)
  })

  it('eases a correction that only just fits, rather than cutting it', () => {
    const o = createVisualOffset()
    correct(o, v(2.4, 0, 0), 0.14)
    expect(isAllZero(o)).toBe(false)
    expect(o.current.x).toBe(2.4)
    expect(o.currentHeading).toBe(0.14)
  })

  it('cuts an accumulated origin, not only a single large delta', () => {
    const o = createVisualOffset()
    correct(o, v(2.4, 0, 0), 0.1)
    correct(o, v(0.3, 0, 0), 0)                   // 2.7 m of retained error
    expect(isAllZero(o)).toBe(true)
  })
})

describe('the shipped constants', () => {
  it('smooths over 0.2 s at 60 Hz', () => {
    expect(ERROR_SMOOTH_WINDOW_TICKS).toBe(12)
    expect(ERROR_SMOOTH_WINDOW_TICKS * TICK_DT).toBeCloseTo(0.2, 12)
  })

  it('cuts rather than slides a hard resync', () => {
    expect(ERROR_SMOOTH_MAX_POSITION_M).toBe(2.5)
  })

  it('can never out-yaw the car\'s own steering', () => {
    expect(ERROR_SMOOTH_MAX_HEADING_RAD).toBe(0.15)

    // §4.9a's derivation, asserted against the shipped constants rather than
    // trusted from the comment: the peak apparent yaw rate at t = 0 is the
    // derivative of the ease cubic, 3x / (window seconds).
    const peakYawRate =
      (3 * ERROR_SMOOTH_MAX_HEADING_RAD) / (ERROR_SMOOTH_WINDOW_TICKS * TICK_DT)
    expect(peakYawRate).toBeCloseTo(2.25, 9)
    expect(peakYawRate).toBeLessThan(TUNING.steerRateBase)
    expect(TUNING.steerRateBase).toBe(2.6)
  })

  it('produces a measured yaw rate under steerRateBase at the guard bound', () => {
    // The discrete counterpart of the derivation above: run the largest offset
    // the guards admit through the real function and measure the fastest
    // per-tick heading change it actually draws.
    const o = createVisualOffset()
    correct(o, ZERO, ERROR_SMOOTH_MAX_HEADING_RAD)
    let previous = o.currentHeading
    let peak = 0
    for (let i = 0; i < ERROR_SMOOTH_WINDOW_TICKS; i++) {
      idle(o, 1)
      peak = Math.max(peak, Math.abs(o.currentHeading - previous) / TICK_DT)
      previous = o.currentHeading
    }
    expect(peak).toBeCloseTo(2.0677083333, 6)
    expect(peak).toBeLessThan(TUNING.steerRateBase)
  })
})
```

**What each test catches, and whether it would actually fail under that bug.**
Smoothing is unusually exposed to tests that cannot detect what they exist to
detect — "the offset got smaller" passes against a function that multiplies by
0.99 forever and never reaches zero — so every assertion above is paired with the
defect it is there for:

| Test | Bug it catches | Would it fail? |
|---|---|---|
| `reaches exactly zero after ERROR_SMOOTH_WINDOW_TICKS` | an asymptotic decay (`current *= 0.99`, or an ease with no clamp) that never lands, leaving the kart permanently offset from where the authority put it | Yes — `0.99 ** 12 * 0.05 = 0.0443`, and `toBe(0)` is exact. A "smaller than before" assertion would pass |
| `drives both channels with ONE eased fraction` | two independent rates, or a heading channel eased on its own `ticksSince` — the kart cornering out of phase with itself | Yes — it recomputes `f` from the *reported* `ticksSince` and requires `current === origin * f` exactly, in all three of x, z and heading |
| `applies the whole correction on the tick it arrives, in both channels` | dropping heading smoothing entirely (the §4.9a pull-quote error): `currentHeading` would be 0, not 0.05. Also catches applying the ease before re-seeding, which would return `0.05 * easeRemaining(1/12) = 0.03851` | Yes, in both cases, and it is the test that most directly pins heading in |
| `adds a new correction to the error still on screen` | re-seeding from `prev.origin` instead of `prev.current`, which double-counts the part already eased away and makes a *second* correction jump the kart further than the first | Yes — 0.02625 vs the bug's 0.07 |
| `wraps the re-seeded heading origin` | a missing `wrapAngle` on the re-seed | Yes, and it is the only case where it can be observed: a non-wrapping implementation gets 6.25, trips the heading guard, and returns all zeros, so `isAllZero(o)` is `false` only for the correct one |
| `cuts BOTH channels when the position/heading delta exceeds…` | a guard that zeroes only its own channel — easing half a resync, which §4.9a rules out explicitly | Yes — `isAllZero` checks all eight fields |
| `measures \|origin\| in three dimensions` | `Math.abs(origin.x) > MAX` or a plan-view hypot | Yes — 2 m on each of two axes is 2.83 m |
| `eases a correction that only just fits` | a guard written `>=`, or one applied to `current` after easing rather than to `origin` | Yes — 2.4/0.14 must survive intact |
| `cuts an accumulated origin` | applying the guard to the incoming delta rather than to the re-seeded origin: two small corrections that sum past the bound would slide 2.7 m | Yes |
| `restarts the window on a heading delta of exactly 0` / `keeps decaying on null` | collapsing `number \| null` into a falsy check (`if (correctionHeading)`), the single most likely defect in this module — it silently treats a real correction as "nothing happened" | Yes — `ticksSince` is 0 under the contract and 7 under the bug, and the pair asserts both directions |
| `ignores correctionPos entirely when correctionHeading is null` | reading the caller's scratch `Vec3` on a no-correction tick, which injects the *previous* correction again every tick | Yes — a 99 m delta would trip the position guard and zero everything |
| `N calls of one tick equal one call of N ticks` | decaying per *call* instead of per *tick*, which makes the smoothing frame-rate dependent — invisible at 60 Hz, twice as fast on a 120 Hz display | Yes — `ticksSince` would be 5 vs 1, and `current` differs by a factor of ~2 |
| `changes nothing when ticksElapsed is 0` | advancing on a frame that ran no sim tick (§5.11 step 11a: "a frame that runs zero ticks re-uses the offset unchanged") | Yes — `toEqual` over the whole struct |
| `writes a correct result when out aliases prev` | writing `out.current` (or `out.ticksSince`) before deriving the new origin from `prev.current`, which corrupts the result in exactly the call shape `ViewBuilder` uses | Yes — the aliased and non-aliased runs are compared field by field |
| `settles rather than arriving` | an ease-out *quadratic* or a linear ramp: the kart arrives with velocity, which reads as a small flick at the end of every correction | Yes — slope 1e-4 (quadratic) or 1 (linear) against a 1e-6 bound |
| `can never out-yaw the car's own steering` + `produces a measured yaw rate under steerRateBase` | raising `ERROR_SMOOTH_MAX_HEADING_RAD`, shortening the window, or steepening the ease until the smoother's own yaw reads to the player as the car steering itself. The second test measures the real per-tick output rather than re-deriving the formula, so it also catches an ease whose peak is not where the algebra assumes | Yes — the bound is asserted against the shipped `ERROR_SMOOTH_*` constants and the shipped `TUNING.steerRateBase`, not against literals |
| `starts at zero with distinct Vec3s` | `origin` and `current` sharing one object (a plausible "save an allocation" mistake), which makes the eased value overwrite the origin it is derived from | Yes — `not.toBe` is identity |

---

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/render/test/smoothing.test.ts`

Expected: FAIL — the module does not exist yet:

```
Error: Cannot find module '../src/smoothing' imported from '<repo>/packages/render/test/smoothing.test.ts'

Caused by: Error: Failed to load url ../src/smoothing (resolved id: ../src/smoothing) in <repo>/packages/render/test/smoothing.test.ts. Does the file exist?
```

(`<repo>` is the absolute path of this working copy.) `Test Files 1 failed (1)`,
`Tests no tests`.

---

- [ ] **Step 3: Write the implementation**

Create `packages/render/src/smoothing.ts`:

```ts
// Error smoothing for the corrections a guest's ClientLoop applies to the local
// kart (R41, R47, R48). Pure: no clock, no DOM, no allocation, no randomness.
//
// The netcode corrects the local kart about three times a second under changing
// input -- which is all real driving -- because the authority applies the newest
// intent it has RECEIVED at its own tick rather than buffering by stamped tick
// (spec §5). The controller ruled that Tapkart keeps immediate application, so
// that a touchscreen racer pays no input latency, and absorbs the corrections
// here instead. Without this module the trade is just "the kart jumps three
// times a second".
//
// The offset produced here is render-only. ViewBuilder adds it to KartView
// position and heading (§5.11 step 11a) and to nothing else: it is never written
// into a SimState, never applied to a remote seat -- those are interpolated and
// have no corrections to hide -- and never applied on host or solo, which never
// reconcile.
import { clamp, wrapAngle } from '@tapkart/sim'
import type { Vec3 } from '@tapkart/sim'

/**
 * The retained visual error for ONE seat: metres for position, radians for
 * heading. `current`/`currentHeading` are what the view adds to the drawn pose;
 * `origin`/`originHeading` are the offset at the instant of the most recent
 * correction, which is what the ease decays from.
 *
 * Both channels are smoothed, on ONE window and ONE curve -- two smoothing rates
 * on one object is how a kart ends up visually cornering out of phase with
 * itself.
 */
export interface VisualOffset {
  origin: Vec3
  originHeading: number       // radians
  ticksSince: number          // ticks since the most recent correction
  current: Vec3               // the eased offset to ADD to the drawn position
  currentHeading: number      // radians, ADDED to the drawn heading
}

/** Allocated ONCE per session, by createViewBuilder (§5.11). */
export function createVisualOffset(): VisualOffset {
  return {
    origin: { x: 0, y: 0, z: 0 },
    originHeading: 0,
    ticksSince: 0,
    current: { x: 0, y: 0, z: 0 },
    currentHeading: 0,
  }
}

/**
 * 0.2 s at 60 Hz. Long enough to hide 5 cm completely, short enough that a wrong
 * prediction is not still on screen when the next one lands (~3/s).
 */
export const ERROR_SMOOTH_WINDOW_TICKS = 12

/**
 * Beyond this the offset is ZEROED rather than eased: a hard resync
 * (ClientLoop.hardResync) can move a kart tens of metres, and sliding it there
 * smoothly is worse than a cut.
 */
export const ERROR_SMOOTH_MAX_POSITION_M = 2.5

/**
 * The yaw analogue of the position cut, and it is derived rather than picked.
 * Easing an offset of `x` radians over the window has a peak apparent yaw rate
 * at t = 0 of `3x / (ERROR_SMOOTH_WINDOW_TICKS * TICK_DT)` = `15x` rad/s (the
 * derivative of the cubic). The player reads any yaw the car produces on its own
 * as steering, so the smoothing must stay under the car's own maximum steering
 * rate, `TUNING.steerRateBase = 2.6` rad/s: 15 x 0.15 = 2.25 rad/s, comfortably
 * under, and 0.15 rad is 8.6 degrees -- larger than any correction that is not a
 * resync. Past it, cut.
 *
 * packages/render/test/smoothing.test.ts asserts the 2.25 < 2.6 bound against
 * the shipped constants rather than trusting this comment.
 */
export const ERROR_SMOOTH_MAX_HEADING_RAD = 0.15

/**
 * The fraction of the offset still applied `t01` of the way through the window:
 * `(1 - clamp(t01, 0, 1)) ** 3` -- ease-out cubic, zero slope at the end, so the
 * kart settles rather than arriving.
 */
export function easeRemaining(t01: number): number {
  const remaining = 1 - clamp(t01, 0, 1)
  return remaining * remaining * remaining
}

/**
 * (previous offset, correction delta, ticks elapsed) -> new offset. `out` MAY
 * alias `prev`, and in the shipped call it always does.
 *
 * `correctionHeading` is passed through UNCHANGED from `correctionDeltaOf` via
 * `RaceSession.correctionDelta` (§5.10): `null` means no reconciliation happened
 * this tick, and `0` means one happened and moved the heading by exactly zero.
 * Those are different, and the difference is carried from its source rather than
 * reconstructed here -- which is why there is no separate `corrected` flag.
 * `correctionPos` is ignored when `correctionHeading` is null.
 *
 * Deterministic and frame-rate independent: `ticksElapsed` is SIM TICKS, never
 * frames. Called once per tick per smoothed seat, from ViewBuilder (§5.11).
 */
export function advanceVisualOffset(
  prev: VisualOffset,
  correctionPos: Vec3,
  correctionHeading: number | null,
  ticksElapsed: number,
  out: VisualOffset,
): void {
  // Read every field of `prev` before writing anything: `out` may alias `prev`.
  const prevX = prev.current.x
  const prevY = prev.current.y
  const prevZ = prev.current.z
  const prevHeading = prev.currentHeading

  let originX: number
  let originY: number
  let originZ: number
  let originHeading: number
  let ticksSince: number

  if (correctionHeading !== null) {
    // A reconciliation landed this tick. The error the player can still see is
    // whatever had not eased away yet, plus the discontinuity just applied.
    originX = prevX + correctionPos.x
    originY = prevY + correctionPos.y
    originZ = prevZ + correctionPos.z
    originHeading = wrapAngle(prevHeading + correctionHeading)
    ticksSince = 0
  } else {
    originX = prev.origin.x
    originY = prev.origin.y
    originZ = prev.origin.z
    originHeading = prev.originHeading
    ticksSince = prev.ticksSince + ticksElapsed
  }

  // Either guard cuts BOTH channels: easing half a resync is worse than cutting
  // all of it.
  if (
    Math.hypot(originX, originY, originZ) > ERROR_SMOOTH_MAX_POSITION_M
    || Math.abs(originHeading) > ERROR_SMOOTH_MAX_HEADING_RAD
  ) {
    out.origin.x = 0
    out.origin.y = 0
    out.origin.z = 0
    out.originHeading = 0
    out.ticksSince = 0
    out.current.x = 0
    out.current.y = 0
    out.current.z = 0
    out.currentHeading = 0
    return
  }

  // ONE eased fraction from ONE ticksSince, so the two channels can never fall
  // out of phase.
  const f = easeRemaining(ticksSince / ERROR_SMOOTH_WINDOW_TICKS)

  out.origin.x = originX
  out.origin.y = originY
  out.origin.z = originZ
  out.originHeading = originHeading
  out.ticksSince = ticksSince
  out.current.x = originX * f
  out.current.y = originY * f
  out.current.z = originZ * f
  out.currentHeading = originHeading * f
}
```

---

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/render/test/smoothing.test.ts`

Expected: PASS, 26 tests.

Then confirm nothing else moved and the package still typechecks under the
strict base config (the test file is inside `include`, so `TUNING` and every
signature above is checked too):

```bash
npx tsc --noEmit -p packages/render/tsconfig.json
npx vitest run
```

Both must be clean before Step 5.

---

- [ ] **Step 5: Commit**

```bash
git add packages/render/src/smoothing.ts packages/render/test/smoothing.test.ts
git commit -m "feat(render): error smoothing for reconciliation corrections (R41)

ClientLoop corrects the local kart about three times a second under
changing input -- 29 corrections under a sine, 39 under a square wave,
against 1 per 600 ticks held steady. That is not a client defect: Plan 2
Task 15's review implemented the client-side fix and measured no
difference, because the authority applies the newest intent it has
RECEIVED at its own tick and no client can predict which one that is
under jitter. The controller kept immediate application, so a
touchscreen racer pays no input latency, and ruled that rendering
absorbs the corrections instead. This module is that absorption; without
it the ruling just means the kart jumps three times a second.

advanceVisualOffset re-seeds from the error still on screen
(prev.current + delta), not from the original one, and decays it on an
ease-out cubic that reaches exactly zero after 12 ticks -- 0.2 s -- so
the kart settles rather than arriving and never carries a residue into
the next correction.

Position and heading are smoothed on ONE eased fraction from ONE
ticksSince. Heading is in because it dominates error growth: 0.0024 rad
at 20 m/s is 0.048 m/s of lateral drift, about three times the velocity
residual's contribution. EPS.heading is the threshold at which a heading
correction fires, not a bound on its size.

ERROR_SMOOTH_MAX_HEADING_RAD = 0.15 is derived, not chosen: the ease
cubic's peak apparent yaw rate at t=0 is 3x/(12 * TICK_DT) = 15x rad/s,
and 15 x 0.15 = 2.25 rad/s stays under TUNING.steerRateBase = 2.6, so
the smoother can never out-yaw the car and read as the car steering
itself. The test asserts that bound against the shipped constants, and
also measures the real per-tick output (2.068 rad/s) rather than only
re-deriving the algebra. Either guard -- 2.5 m or 0.15 rad -- cuts both
channels, because easing half a resync is worse than cutting all of it.

correctionHeading is number | null, carried unchanged from net's
correctionDeltaOf: null means no reconciliation, 0 means one that moved
the heading by exactly zero, and a zero still restarts the ease window.
That distinction is never reconstructed a layer up.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```
