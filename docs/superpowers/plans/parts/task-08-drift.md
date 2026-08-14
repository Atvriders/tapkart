### Task 8: Drift, Mini-Turbo and Boost Decay (`packages/sim/src/drift.ts`)

**Files:**
- Create: `packages/sim/src/drift.ts`
- Create: `packages/sim/test/drift.test.ts`
- Modify: `packages/sim/src/kart.ts` — three edits: add the `lateralGripFor` import, replace `stepKart`'s call to Task 6's private `gripFor` with a call to `lateralGripFor`, and delete the now-callerless `gripFor` function, so the coefficient has exactly one definition (exact before/after in Step 19)
- Modify: `packages/sim/src/step.ts` — the per-kart loop body: `updateDrift` on the line before the existing `stepKart(...)` call (canonical order slot 3), `decayBoost` as the last statement of the loop body (canonical order slot 8) (exact before/after in Step 21)
- Test: `packages/sim/test/drift.test.ts`

**Interfaces:**

- Consumes (all already exist before this task):
  - From `./types` [Task 2]: `TICK_DT` (= `1/60`), and the types `Intent`, `KartState`, `SimContext`, `Surface`.
  - From `ctx.tuning` [Task 2 type, Task 3 values]: `driftMinSpeed` (8), `driftTiers` (`[40, 90, 150]`), `driftBoosts` (`[24, 42, 66]`), `gripDrift` (3), `gripDirt` (5), `gripTarmac` (14).
  - From `./state` [Task 5]: `createState(ctx: SimContext, seed: number, characterIdx: number[]): SimState` — used by two tests only.
  - From `./kart` [Task 6]: `stepKart(ctx: SimContext, state: SimState, prevKart: KartState, k: KartState, raw: Intent): void` — used by two tests, and edited by Step 19.
  - From `./fixtures/track-fixtures` [Task 3, `makeContext` from Task 4]: `makeTuning(overrides?: Partial<Tuning>): Tuning`, `makeStraightTrack(overrides?: Partial<Track>): Track`, `makeContext(track: Track, isLeader?: boolean): SimContext`.

- Produces:
  - `export function updateDrift(ctx: SimContext, k: KartState, raw: Intent): void` — contract signature, canonical slot 3 (runs **before** `stepKart`, so the drift flag it sets is visible to `stepKart`'s lateral damping on the same tick).
  - `export function decayBoost(k: KartState): void` — contract signature, canonical slot 8.
  - `export function driftTierFor(charge: number, tiers: [number, number, number]): number` — **not in the locked contract**; defined here. Returns `-1` (no tier), `0`, `1` or `2`, indexing straight into `tuning.driftBoosts`.
  - `export function lateralGripFor(ctx: SimContext, k: KartState): number` — **not in the locked contract**; defined here. The single definition of the lateral damping coefficient: `tuning.gripDrift` while drifting, `tuning.gripDirt` on dirt, `tuning.gripTarmac` otherwise. `stepKart` (Task 6) is the consumer, and **Step 19 of this task is what makes that true**: it deletes the private copy of the same rule that Task 6 wrote inside `kart.ts` as `function gripFor(k, t)`. That copy agrees with this one on all four surfaces (`'offtrack'` grips like tarmac in both), which is the only reason no expectation changes here — but two copies of one rule is how they drifted apart before, so exactly one of them survives this step.
  - `export const DRIFT_STEER_MIN = 0.35` — **not in the locked contract**; the `Tuning` struct has no drift steer threshold, so this task defines and owns one.

- **Import direction** (there is no cycle to worry about): `drift.ts` imports only from `./types`. Step 19 adds `import { lateralGripFor } from './drift'` to `kart.ts`, so the dependency runs `kart.ts → drift.ts` and never back. `drift.test.ts` imports both, which is a test-only edge.

**Design notes the implementation depends on (read before writing code):**

1. **`charge` is measured in ticks.** It increments by exactly 1 per tick while drift is held, including the tick the drift latches. `driftTiers` `[40, 90, 150]` therefore means 0.667s / 1.5s / 2.5s of held drift, and `driftBoosts` `[24, 42, 66]` means 0.4s / 0.7s / 1.1s of boost. This reading is what makes the "every entry is even" rule in the contract mean anything — see step 3 below.
2. **Latching.** A drift latches only on a tick where `raw.drift` is true, `Math.abs(raw.steer) >= DRIFT_STEER_MIN` and the kart's **xz** speed is strictly greater than `tuning.driftMinSpeed`. `drift.dir` is the sign of the steer that latched it (`+1` = the player was steering right). Once latched, the direction is *latched*: steering the other way, or straightening completely, does not change `dir` and does not stop the charge. That is the whole point of the word.
3. **Charge caps at `driftTiers[2]`** (150). The wire format gives drift charge 8 bits, so an uncapped counter would overflow the snapshot after ~4 seconds of held drift. Capping at the top tier is free — nothing above it does anything.
4. **Two things cancel a drift with no payout:** the xz speed falling to or below `driftMinSpeed` while still held (the boost is paid for by carrying speed through the corner), and `spinOutTicks > 0` or `respawnTicks > 0` (Task 9 owns those timers; this task only reads them).
5. **Being airborne does not break a drift.** A kart holding a drift over a ramp keeps its latch and keeps charging. Breaking on every jump would make ramp corners unchargeable.
6. **Boost grants use max, never assignment.** `k.boostTicks = Math.max(k.boostTicks, driftBoosts[tier])` — releasing a first-tier drift (24 ticks) must not truncate a boost-pad or item boost that is already running longer.

---

- [ ] **Step 1: Write the failing test for the tier table and its evenness rule**

Create `packages/sim/test/drift.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import type { Intent, KartState } from '../src/types'
import {
  updateDrift,
  decayBoost,
  driftTierFor,
  lateralGripFor,
  DRIFT_STEER_MIN,
} from '../src/drift'
import { createState } from '../src/state'
import { stepKart } from '../src/kart'
import { makeTuning, makeStraightTrack, makeContext } from './fixtures/track-fixtures'

/**
 * A complete KartState literal. Built locally rather than via createState() so the
 * numbers below depend on nothing but the fields set here. `lap` is never read by
 * this task; the real race-start value is
 * `{ lap: 0, checkpointIdx: track.checkpointS.length - 1, t: 0 }` (contract §0).
 */
function makeKart(overrides: Partial<KartState> = {}): KartState {
  return {
    playerId: 0,
    characterIdx: 0,
    isBot: false,
    connected: true,
    position: { x: 0, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    heading: 0,
    angularVelocity: 0,
    drift: { active: false, dir: 0, charge: 0 },
    item: 'none',
    airborne: false,
    surface: 'tarmac',
    spinOutTicks: 0,
    invulnTicks: 0,
    boostTicks: 0,
    respawnTicks: 0,
    shielded: false,
    lap: { lap: 0, checkpointIdx: 0, t: 0 },
    ...overrides,
  }
}

function makeIntent(overrides: Partial<Intent> = {}): Intent {
  return { tick: 0, steer: 0, accel: 1, brake: false, drift: false, useItem: false, ...overrides }
}

describe('drift fixture assumptions', () => {
  it('uses the base tuning values every number below is derived from', () => {
    const t = makeTuning()
    expect(t.driftMinSpeed).toBe(8)
    expect(t.driftTiers).toEqual([40, 90, 150])
    expect(t.driftBoosts).toEqual([24, 42, 66])
    expect(t.gripDrift).toBe(3)
    expect(t.gripDirt).toBe(5)
    expect(t.gripTarmac).toBe(14)
  })
})

describe('drift tier quantization', () => {
  it('defines every tier threshold and every boost length in whole 2-tick pairs', () => {
    const t = makeTuning()
    for (const threshold of t.driftTiers) {
      expect(threshold % 2).toBe(0)
    }
    for (const boost of t.driftBoosts) {
      expect(boost % 2).toBe(0)
    }
    // Spelled out so a tuning change that breaks the rule fails with a readable diff:
    expect(t.driftTiers).toEqual([40, 90, 150])   // 0.667s / 1.5s / 2.5s of held drift
    expect(t.driftBoosts).toEqual([24, 42, 66])   // 0.4s / 0.7s / 1.1s of boost
  })
})

describe('driftTierFor', () => {
  it('maps charge to the tier index that indexes driftBoosts', () => {
    const tiers: [number, number, number] = [40, 90, 150]
    expect(driftTierFor(0, tiers)).toBe(-1)
    expect(driftTierFor(39, tiers)).toBe(-1)
    expect(driftTierFor(40, tiers)).toBe(0)
    expect(driftTierFor(89, tiers)).toBe(0)
    expect(driftTierFor(90, tiers)).toBe(1)
    expect(driftTierFor(149, tiers)).toBe(1)
    expect(driftTierFor(150, tiers)).toBe(2)
  })

  it('saturates at the top tier', () => {
    const tiers: [number, number, number] = [40, 90, 150]
    expect(driftTierFor(1000, tiers)).toBe(2)
  })
})
```

**Why every entry of `driftTiers` and `driftBoosts` must be even.** Clients send input intents at 30Hz while the simulation runs at 60Hz, and the authority holds the newest intent and applies it to *both* ticks of each pair. `raw.drift` can therefore only change value on the first tick of a pair, so a held drift always spans an even number of ticks. Since `charge` increments by exactly 1 per tick while held, **the value of `charge` at the moment of release is always even**. An odd threshold — 41, say — would be unreachable: it would behave identically to 40 for every input a human can produce and identically to 42 for none, and the tuning table would contain a number with no observable meaning. Worse, it would be an invisible trap for whoever tunes the game next, who would move a tier by one and see nothing change. The same argument applies to `driftBoosts`, which `decayBoost` decrements once per tick: an odd duration ends on a tick that falls inside an input pair, so the boost's end lands one tick early or late depending on the parity of the tick it started on. Both tables are defined in multiples of 2 ticks, and the test above is what stops that rule from quietly rotting.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/sim/test/drift.test.ts -t "driftTierFor"`

Expected: FAIL with `Failed to resolve import "../src/drift"` (the module does not exist yet).

- [ ] **Step 3: Write `driftTierFor`, `lateralGripFor` and the module constants**

Create `packages/sim/src/drift.ts`:

```ts
import type { Intent, KartState, SimContext } from './types'

/**
 * Minimum |steer| that will latch a drift. Not part of the locked Tuning struct;
 * owned by this module.
 */
export const DRIFT_STEER_MIN = 0.35

/**
 * Which mini-turbo tier a charge has reached: -1 for none, otherwise an index
 * straight into tuning.driftBoosts.
 *
 * charge is a tick count, so the thresholds are tick counts too. Every threshold is
 * even because input is 30Hz against a 60Hz sim: a held drift always spans an even
 * number of ticks, so an odd threshold would sit inside a window no input can land
 * in and would be indistinguishable from the even number below it.
 */
export function driftTierFor(charge: number, tiers: [number, number, number]): number {
  if (charge >= tiers[2]) return 2
  if (charge >= tiers[1]) return 1
  if (charge >= tiers[0]) return 0
  return -1
}

/**
 * The lateral damping coefficient for this kart on this tick — the single
 * definition of it in the sim. Drifting deliberately retains lateral velocity
 * (gripDrift 3 against gripTarmac 14), which is what makes a drift a drift rather
 * than a tighter turn. Surfaces with no grip entry of their own ('boost',
 * 'offtrack') damp like tarmac; 'offtrack' is penalised through
 * surfaceSpeedFactor instead, not through grip.
 */
export function lateralGripFor(ctx: SimContext, k: KartState): number {
  const t = ctx.tuning
  if (k.drift.active) return t.gripDrift
  if (k.surface === 'dirt') return t.gripDirt
  return t.gripTarmac
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/sim/test/drift.test.ts -t "driftTierFor"`

Expected: PASS — 2 tests. Then run `npx vitest run packages/sim/test/drift.test.ts -t "quantization"` — the evenness test also passes.

---

- [ ] **Step 5: Write the failing test for latching**

Append to `packages/sim/test/drift.test.ts`:

```ts
describe('updateDrift — latching', () => {
  it('latches right and starts the charge on the same tick', () => {
    const ctx = makeContext(makeStraightTrack())
    const k = makeKart({ velocity: { x: 12, y: 0, z: 0 } })   // xz speed 12 > driftMinSpeed 8

    updateDrift(ctx, k, makeIntent({ drift: true, steer: 1 }))

    expect(k.drift.active).toBe(true)
    expect(k.drift.dir).toBe(1)
    expect(k.drift.charge).toBe(1)   // the latching tick itself counts
  })

  it('latches left on negative steer', () => {
    const ctx = makeContext(makeStraightTrack())
    const k = makeKart({ velocity: { x: 12, y: 0, z: 0 } })

    updateDrift(ctx, k, makeIntent({ drift: true, steer: -0.9 }))

    expect(k.drift.active).toBe(true)
    expect(k.drift.dir).toBe(-1)
    expect(k.drift.charge).toBe(1)
  })

  it('will not latch below the steer threshold and will at it', () => {
    expect(DRIFT_STEER_MIN).toBe(0.35)
    const ctx = makeContext(makeStraightTrack())

    const tooStraight = makeKart({ velocity: { x: 12, y: 0, z: 0 } })
    updateDrift(ctx, tooStraight, makeIntent({ drift: true, steer: 0.34 }))
    expect(tooStraight.drift.active).toBe(false)
    expect(tooStraight.drift.dir).toBe(0)
    expect(tooStraight.drift.charge).toBe(0)

    const atThreshold = makeKart({ velocity: { x: 12, y: 0, z: 0 } })
    updateDrift(ctx, atThreshold, makeIntent({ drift: true, steer: 0.35 }))
    expect(atThreshold.drift.active).toBe(true)
    expect(atThreshold.drift.charge).toBe(1)
  })

  it('will not latch at or below driftMinSpeed and will above it', () => {
    const ctx = makeContext(makeStraightTrack())

    const exactlyMin = makeKart({ velocity: { x: 8, y: 0, z: 0 } })   // speed 8 === driftMinSpeed
    updateDrift(ctx, exactlyMin, makeIntent({ drift: true, steer: 1 }))
    expect(exactlyMin.drift.active).toBe(false)
    expect(exactlyMin.drift.charge).toBe(0)

    const aboveMin = makeKart({ velocity: { x: 8.5, y: 0, z: 0 } })
    updateDrift(ctx, aboveMin, makeIntent({ drift: true, steer: 1 }))
    expect(aboveMin.drift.active).toBe(true)
    expect(aboveMin.drift.charge).toBe(1)
  })

  it('measures drift speed on the xz plane only', () => {
    const ctx = makeContext(makeStraightTrack())

    const diagonal = makeKart({ velocity: { x: 6, y: 99, z: 8 } })    // sqrt(36+64) = 10 > 8
    updateDrift(ctx, diagonal, makeIntent({ drift: true, steer: 1 }))
    expect(diagonal.drift.active).toBe(true)

    const fallingOnly = makeKart({ velocity: { x: 0, y: 99, z: 0 } }) // xz speed 0
    updateDrift(ctx, fallingOnly, makeIntent({ drift: true, steer: 1 }))
    expect(fallingOnly.drift.active).toBe(false)
  })

  it('does nothing when the drift button is not held and none is active', () => {
    const ctx = makeContext(makeStraightTrack())
    const k = makeKart({ velocity: { x: 30, y: 0, z: 0 }, boostTicks: 0 })

    updateDrift(ctx, k, makeIntent({ drift: false, steer: 1 }))

    expect(k.drift.active).toBe(false)
    expect(k.drift.dir).toBe(0)
    expect(k.drift.charge).toBe(0)
    expect(k.boostTicks).toBe(0)
  })
})
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `npx vitest run packages/sim/test/drift.test.ts -t "latching"`

Expected: FAIL with `TypeError: updateDrift is not a function`.

- [ ] **Step 7: Write `updateDrift`**

Append to `packages/sim/src/drift.ts`:

```ts
/**
 * Canonical order slot 3 — runs before stepKart, so the drift flag set here is
 * what stepKart's lateral damping sees on the same tick.
 *
 * Latch: drift held, |steer| at or beyond DRIFT_STEER_MIN, xz speed strictly above
 * tuning.driftMinSpeed. dir is the sign of the steer that latched it and never
 * changes afterwards, so a player may straighten or counter-steer mid-drift.
 *
 * Charge: +1 tick per held tick including the latching tick, capped at the top
 * tier (the wire format gives drift charge 8 bits).
 *
 * Release: the tier reached grants tuning.driftBoosts[tier] boost ticks, applied as
 * a maximum so a longer boost already running is never truncated.
 *
 * Cancelled with no payout by: speed falling to or below driftMinSpeed while held,
 * a spin-out, or a respawn. Being airborne does not cancel a drift.
 */
export function updateDrift(ctx: SimContext, k: KartState, raw: Intent): void {
  const t = ctx.tuning
  const d = k.drift

  if (k.spinOutTicks > 0 || k.respawnTicks > 0) {
    d.active = false
    d.dir = 0
    d.charge = 0
    return
  }

  const vx = k.velocity.x
  const vz = k.velocity.z
  const speed = Math.sqrt(vx * vx + vz * vz)

  if (!raw.drift) {
    if (d.active) {
      const tier = driftTierFor(d.charge, t.driftTiers)
      if (tier >= 0) {
        const ticks = t.driftBoosts[tier]
        if (k.boostTicks < ticks) k.boostTicks = ticks
      }
    }
    d.active = false
    d.dir = 0
    d.charge = 0
    return
  }

  if (!d.active) {
    if (speed <= t.driftMinSpeed) return
    if (Math.abs(raw.steer) < DRIFT_STEER_MIN) return
    d.active = true
    d.dir = raw.steer > 0 ? 1 : -1
    d.charge = 0
  } else if (speed <= t.driftMinSpeed) {
    d.active = false
    d.dir = 0
    d.charge = 0
    return
  }

  const cap = t.driftTiers[2]
  const next = d.charge + 1
  d.charge = next < cap ? next : cap
}
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `npx vitest run packages/sim/test/drift.test.ts -t "latching"`

Expected: PASS — 6 tests.

---

- [ ] **Step 9: Write the failing test for charging and cancellation**

Append to `packages/sim/test/drift.test.ts`:

```ts
describe('updateDrift — charging', () => {
  it('accrues exactly one charge per held tick', () => {
    const ctx = makeContext(makeStraightTrack())
    const k = makeKart({ velocity: { x: 20, y: 0, z: 0 } })
    const held = makeIntent({ drift: true, steer: 1 })

    for (let i = 0; i < 40; i++) updateDrift(ctx, k, held)

    expect(k.drift.charge).toBe(40)   // 40 calls, +1 each, latch tick included
    expect(k.drift.active).toBe(true)
    expect(k.drift.dir).toBe(1)
  })

  it('keeps the latched direction when the player counter-steers', () => {
    const ctx = makeContext(makeStraightTrack())
    const k = makeKart({ velocity: { x: 20, y: 0, z: 0 } })

    updateDrift(ctx, k, makeIntent({ drift: true, steer: 1 }))
    for (let i = 0; i < 5; i++) updateDrift(ctx, k, makeIntent({ drift: true, steer: -1 }))

    expect(k.drift.dir).toBe(1)       // latched right on tick 1 and stayed right
    expect(k.drift.charge).toBe(6)    // 1 + 5
    expect(k.drift.active).toBe(true)
  })

  it('keeps charging with the stick centred once latched', () => {
    const ctx = makeContext(makeStraightTrack())
    const k = makeKart({ velocity: { x: 20, y: 0, z: 0 } })

    updateDrift(ctx, k, makeIntent({ drift: true, steer: 1 }))
    for (let i = 0; i < 9; i++) updateDrift(ctx, k, makeIntent({ drift: true, steer: 0 }))

    expect(k.drift.charge).toBe(10)
    expect(k.drift.active).toBe(true)
  })

  it('caps charge at the top tier so the 8-bit wire field cannot overflow', () => {
    const ctx = makeContext(makeStraightTrack())
    const k = makeKart({ velocity: { x: 20, y: 0, z: 0 } })
    const held = makeIntent({ drift: true, steer: 1 })

    for (let i = 0; i < 200; i++) updateDrift(ctx, k, held)

    expect(k.drift.charge).toBe(150)  // driftTiers[2]
  })

  it('keeps the drift alive while the kart is airborne', () => {
    const ctx = makeContext(makeStraightTrack())
    const k = makeKart({ velocity: { x: 20, y: 0, z: 0 }, airborne: true })
    const held = makeIntent({ drift: true, steer: 1 })

    for (let i = 0; i < 10; i++) updateDrift(ctx, k, held)

    expect(k.drift.active).toBe(true)
    expect(k.drift.charge).toBe(10)
  })

  it('cancels with no boost when speed falls to driftMinSpeed while still held', () => {
    const ctx = makeContext(makeStraightTrack())
    const k = makeKart({ velocity: { x: 20, y: 0, z: 0 } })
    const held = makeIntent({ drift: true, steer: 1 })

    for (let i = 0; i < 50; i++) updateDrift(ctx, k, held)
    expect(k.drift.charge).toBe(50)   // past driftTiers[0] = 40, so a tier was reached

    k.velocity.x = 8                  // dropped to driftMinSpeed
    updateDrift(ctx, k, held)

    expect(k.drift.active).toBe(false)
    expect(k.drift.dir).toBe(0)
    expect(k.drift.charge).toBe(0)
    expect(k.boostTicks).toBe(0)      // charge is forfeited, not paid out
  })

  it('cancels with no boost during a spin-out or a respawn', () => {
    const ctx = makeContext(makeStraightTrack())
    const held = makeIntent({ drift: true, steer: 1 })

    const spun = makeKart({
      velocity: { x: 20, y: 0, z: 0 },
      drift: { active: true, dir: 1, charge: 100 },
      spinOutTicks: 30,
    })
    updateDrift(ctx, spun, held)
    expect(spun.drift.active).toBe(false)
    expect(spun.drift.charge).toBe(0)
    expect(spun.boostTicks).toBe(0)

    const respawning = makeKart({
      velocity: { x: 20, y: 0, z: 0 },
      drift: { active: true, dir: -1, charge: 100 },
      respawnTicks: 40,
    })
    updateDrift(ctx, respawning, held)
    expect(respawning.drift.active).toBe(false)
    expect(respawning.drift.charge).toBe(0)
    expect(respawning.boostTicks).toBe(0)
  })
})
```

- [ ] **Step 10: Run the test to verify it passes**

Run: `npx vitest run packages/sim/test/drift.test.ts -t "charging"`

Expected: PASS — 7 tests. `updateDrift` from step 7 already implements all of this; this cycle is the coverage that pins the accrual rate, the cap and both cancellation paths so a later tuning change cannot quietly break them. If any of the seven fails, the implementation in step 7 was mistyped — re-read it against the failure rather than editing the test.

---

- [ ] **Step 11: Write the failing test for the release payout**

Append to `packages/sim/test/drift.test.ts`:

```ts
describe('updateDrift — release', () => {
  it('pays nothing for a charge below the first tier', () => {
    const ctx = makeContext(makeStraightTrack())
    const k = makeKart({
      velocity: { x: 20, y: 0, z: 0 },
      drift: { active: true, dir: 1, charge: 39 },   // driftTiers[0] is 40
    })

    updateDrift(ctx, k, makeIntent({ drift: false, steer: 1 }))

    expect(k.boostTicks).toBe(0)
    expect(k.drift.active).toBe(false)
    expect(k.drift.dir).toBe(0)
    expect(k.drift.charge).toBe(0)
  })

  it('pays each tier the matching driftBoosts entry', () => {
    const ctx = makeContext(makeStraightTrack())
    const release = makeIntent({ drift: false, steer: 1 })
    const cases: Array<[number, number]> = [
      [40, 24],   // driftTiers[0] -> driftBoosts[0]
      [89, 24],
      [90, 42],   // driftTiers[1] -> driftBoosts[1]
      [149, 42],
      [150, 66],  // driftTiers[2] -> driftBoosts[2]
    ]

    for (const [charge, expected] of cases) {
      const k = makeKart({
        velocity: { x: 20, y: 0, z: 0 },
        drift: { active: true, dir: 1, charge },
      })
      updateDrift(ctx, k, release)
      expect(k.boostTicks).toBe(expected)
      expect(k.drift.active).toBe(false)
      expect(k.drift.charge).toBe(0)
    }
  })

  it('charges for 90 ticks and releases a second-tier boost end to end', () => {
    const ctx = makeContext(makeStraightTrack())
    const k = makeKart({ velocity: { x: 20, y: 0, z: 0 } })
    const held = makeIntent({ drift: true, steer: 1 })

    for (let i = 0; i < 90; i++) updateDrift(ctx, k, held)
    expect(k.drift.charge).toBe(90)

    updateDrift(ctx, k, makeIntent({ drift: false, steer: 1 }))

    // charge 90 >= driftTiers[1] (90) and < driftTiers[2] (150) -> driftBoosts[1] = 42
    expect(k.boostTicks).toBe(42)
    expect(k.drift.active).toBe(false)
  })

  it('extends a shorter running boost but never truncates a longer one', () => {
    const ctx = makeContext(makeStraightTrack())
    const release = makeIntent({ drift: false, steer: 1 })

    const longerAlreadyRunning = makeKart({
      velocity: { x: 20, y: 0, z: 0 },
      drift: { active: true, dir: 1, charge: 40 },   // would grant 24
      boostTicks: 50,                                // e.g. part of a tier-3 boost
    })
    updateDrift(ctx, longerAlreadyRunning, release)
    expect(longerAlreadyRunning.boostTicks).toBe(50)

    const shorterAlreadyRunning = makeKart({
      velocity: { x: 20, y: 0, z: 0 },
      drift: { active: true, dir: 1, charge: 150 },  // grants 66
      boostTicks: 10,
    })
    updateDrift(ctx, shorterAlreadyRunning, release)
    expect(shorterAlreadyRunning.boostTicks).toBe(66)
  })

  it('pays nothing when the button is released with no drift active', () => {
    const ctx = makeContext(makeStraightTrack())
    const k = makeKart({
      velocity: { x: 20, y: 0, z: 0 },
      drift: { active: false, dir: 0, charge: 140 },  // stale charge, no active drift
    })

    updateDrift(ctx, k, makeIntent({ drift: false, steer: 1 }))

    expect(k.boostTicks).toBe(0)
    expect(k.drift.charge).toBe(0)
  })
})
```

- [ ] **Step 12: Run the test to verify it passes**

Run: `npx vitest run packages/sim/test/drift.test.ts -t "release"`

Expected: PASS — 5 tests. As in step 10, the release path is already implemented by step 7; this cycle pins the payout table.

---

- [ ] **Step 13: Write the failing test for `decayBoost`**

Append to `packages/sim/test/drift.test.ts`:

```ts
describe('decayBoost', () => {
  it('spends one boost tick per call', () => {
    const k = makeKart({ boostTicks: 5 })
    decayBoost(k)
    expect(k.boostTicks).toBe(4)
  })

  it('stops at zero and never goes negative', () => {
    const k = makeKart({ boostTicks: 1 })
    decayBoost(k)
    expect(k.boostTicks).toBe(0)
    decayBoost(k)
    expect(k.boostTicks).toBe(0)
    decayBoost(k)
    expect(k.boostTicks).toBe(0)
  })

  it('spends a first-tier boost in exactly 24 ticks', () => {
    const k = makeKart({ boostTicks: 24 })   // driftBoosts[0]

    for (let i = 0; i < 23; i++) decayBoost(k)
    expect(k.boostTicks).toBe(1)

    decayBoost(k)
    expect(k.boostTicks).toBe(0)
  })

  it('touches nothing but boostTicks', () => {
    const k = makeKart({
      boostTicks: 5,
      spinOutTicks: 7,
      invulnTicks: 9,
      respawnTicks: 11,
      drift: { active: true, dir: 1, charge: 30 },
    })

    decayBoost(k)

    expect(k.boostTicks).toBe(4)
    expect(k.spinOutTicks).toBe(7)   // updateRecovery owns these, not this function
    expect(k.invulnTicks).toBe(9)
    expect(k.respawnTicks).toBe(11)
    expect(k.drift.charge).toBe(30)
  })

  it('leaves 23 ticks on the tick a first-tier boost is released', () => {
    // Canonical per-kart order: updateDrift is slot 3, decayBoost is slot 8, so the
    // tick a boost is granted also spends one tick of it.
    const ctx = makeContext(makeStraightTrack())
    const k = makeKart({
      velocity: { x: 20, y: 0, z: 0 },
      drift: { active: true, dir: 1, charge: 40 },
    })

    updateDrift(ctx, k, makeIntent({ drift: false, steer: 1 }))
    decayBoost(k)

    expect(k.boostTicks).toBe(23)   // 24 granted, 1 spent on the release tick
  })
})
```

- [ ] **Step 14: Run the test to verify it fails**

Run: `npx vitest run packages/sim/test/drift.test.ts -t "decayBoost"`

Expected: FAIL with `TypeError: decayBoost is not a function`.

- [ ] **Step 15: Write `decayBoost`**

Append to `packages/sim/src/drift.ts`:

```ts
/**
 * Canonical order slot 8 — the last thing to touch the kart before updateLaps.
 *
 * Spends one tick of any running boost, whatever granted it (drift release, boost
 * pad, boost item). It owns boostTicks and nothing else: spinOutTicks, invulnTicks
 * and respawnTicks belong to updateRecovery.
 */
export function decayBoost(k: KartState): void {
  if (k.boostTicks > 0) k.boostTicks -= 1
}
```

- [ ] **Step 16: Run the test to verify it passes**

Run: `npx vitest run packages/sim/test/drift.test.ts -t "decayBoost"`

Expected: PASS — 5 tests.

---

- [ ] **Step 17: Write the failing test for drift grip**

First widen the type import at the top of `packages/sim/test/drift.test.ts`. Before:

```ts
import type { Intent, KartState } from '../src/types'
```

After:

```ts
import type { Intent, KartState, Surface } from '../src/types'
import { TICK_DT } from '../src/types'
```

Then append to `packages/sim/test/drift.test.ts`:

```ts
describe('lateralGripFor', () => {
  it('returns gripDrift while drifting and the surface grip otherwise', () => {
    const ctx = makeContext(makeStraightTrack())

    expect(lateralGripFor(ctx, makeKart({ surface: 'tarmac' }))).toBe(14)
    expect(lateralGripFor(ctx, makeKart({ surface: 'dirt' }))).toBe(5)
    expect(lateralGripFor(ctx, makeKart({ surface: 'boost' }))).toBe(14)
    expect(lateralGripFor(ctx, makeKart({ surface: 'offtrack' }))).toBe(14)
  })

  it('lets the drift flag override every surface', () => {
    const ctx = makeContext(makeStraightTrack())
    const drifting = { active: true, dir: 1 as const, charge: 30 }

    expect(lateralGripFor(ctx, makeKart({ surface: 'tarmac', drift: drifting }))).toBe(3)
    expect(lateralGripFor(ctx, makeKart({ surface: 'dirt', drift: drifting }))).toBe(3)
  })

  it('makes a drifting kart hold more lateral velocity through stepKart', () => {
    // Every number here, recomputed from the base tuning:
    //   heading 0 -> forward = (1, 0, 0), right = (0, 0, 1), so velocity.z IS vr.
    //   vf = 20, vr = 6, character 0 (speed 1.00, accel 1.00), boostTicks 0.
    //   target  = maxSpeed 40 * 1.00 * accel 1 * 1 * 1 * 1 = 40
    //   maxDelta = accelRate 24 * 1.00 / 60 = 0.4, so newVf = 20 + 0.4 = 20.4 for both
    //   gripping: gripTarmac 14 -> 6 * (1 - 14/60) = 6 * 0.7666666666666666 = 4.6
    //   drifting: gripDrift  3 -> 6 * (1 -  3/60) = 6 * 0.95                = 5.7
    const ctx = makeContext(makeStraightTrack())
    const state = createState(ctx, 1, [0, 0, 0, 0, 0, 0, 0, 0])
    const raw = makeIntent({ accel: 1, steer: 0 })

    const gripping = state.karts[0]
    gripping.position.x = 20
    gripping.position.y = 0
    gripping.position.z = 0
    gripping.velocity.x = 20
    gripping.velocity.y = 0
    gripping.velocity.z = 6
    gripping.heading = 0
    gripping.surface = 'tarmac'
    gripping.drift.active = false
    gripping.drift.dir = 0
    gripping.drift.charge = 0
    gripping.boostTicks = 0
    const grippingPrev = makeKart({
      position: { x: 20, y: 0, z: 0 },
      velocity: { x: 20, y: 0, z: 6 },
    })
    stepKart(ctx, state, grippingPrev, gripping, raw)

    const drifting = state.karts[1]
    drifting.position.x = 20
    drifting.position.y = 0
    drifting.position.z = 0
    drifting.velocity.x = 20
    drifting.velocity.y = 0
    drifting.velocity.z = 6
    drifting.heading = 0
    drifting.surface = 'tarmac'
    drifting.drift.active = true
    drifting.drift.dir = 1
    drifting.drift.charge = 20
    drifting.boostTicks = 0
    const driftingPrev = makeKart({
      playerId: 1,
      position: { x: 20, y: 0, z: 0 },
      velocity: { x: 20, y: 0, z: 6 },
      drift: { active: true, dir: 1, charge: 19 },
    })
    stepKart(ctx, state, driftingPrev, drifting, raw)

    // gripTarmac 14 damps the 6 u/s slide hard; gripDrift 3 barely touches it.
    expect(gripping.velocity.z).toBeCloseTo(4.6, 12)
    expect(drifting.velocity.z).toBeCloseTo(5.7, 12)
    expect(Math.abs(drifting.velocity.z)).toBeGreaterThan(Math.abs(gripping.velocity.z))
    // the longitudinal half is identical for both, so only grip is under test here
    expect(gripping.velocity.x).toBeCloseTo(20.4, 12)
    expect(drifting.velocity.x).toBeCloseTo(20.4, 12)
  })

  it('damps lateral velocity by exactly lateralGripFor on every surface', () => {
    // This is the test that keeps stepKart and lateralGripFor from drifting apart:
    // the expectation is computed FROM lateralGripFor, not from a literal, so a
    // second private copy of the grip rule inside kart.ts cannot stay hidden.
    // Concretely: tarmac / boost / offtrack -> gripTarmac 14 -> 6 * (1 - 14/60) = 4.6
    //             dirt                      -> gripDirt    5 -> 6 * (1 -  5/60) = 5.5
    const ctx = makeContext(makeStraightTrack())
    const state = createState(ctx, 3, [0, 0, 0, 0, 0, 0, 0, 0])
    const raw = makeIntent({ accel: 1, steer: 0 })
    const surfaces: Surface[] = ['tarmac', 'dirt', 'boost', 'offtrack']

    for (const surface of surfaces) {
      const k = state.karts[0]
      k.position.x = 20
      k.position.y = 0
      k.position.z = 0
      k.velocity.x = 20
      k.velocity.y = 0
      k.velocity.z = 6
      k.heading = 0          // forward = (1, 0, 0), right = (0, 0, 1)
      k.angularVelocity = 0
      k.surface = surface
      k.drift.active = false
      k.drift.dir = 0
      k.drift.charge = 0
      k.boostTicks = 0

      // read before stepKart runs, so the coefficient is the one the tick will use
      const expected = 6 * (1 - lateralGripFor(ctx, k) * TICK_DT)

      const prevKart = makeKart({ velocity: { x: 20, y: 0, z: 6 } })
      stepKart(ctx, state, prevKart, k, raw)

      expect(k.velocity.z).toBeCloseTo(expected, 12)
    }
  })
})
```

- [ ] **Step 18: Run the grip tests**

Run: `npx vitest run packages/sim/test/drift.test.ts -t "lateralGripFor"`

Expected: PASS — 4 tests. The first two exercise `lateralGripFor` directly; the last two run it through `stepKart`, which is the consumer.

The fourth test computes its expectation by calling `lateralGripFor`, so it passes both before and after Step 19: Task 6's private expression and `lateralGripFor` return the same coefficient on all four surfaces, which is why the duplication went unnoticed long enough to end up in the audit. Step 19 is scheduled anyway — it is a de-duplication, not a behaviour change, and this test is what keeps the two from separating again.

---

- [ ] **Step 19: Make `stepKart` read `lateralGripFor`, deleting the second definition**

Task 6 wrote its own copy of the lateral-grip rule inside `kart.ts`, as a module-level `gripFor(k, t)`, because `drift.ts` did not exist yet. This step removes that copy so `lateralGripFor` is the only definition in the package. Task 6's **Interfaces** block names exactly these three edits and they must all be made together: after Edit 2 the call site is gone, so leaving `gripFor` in place would fail `tsc --noEmit` in Step 22 with `TS6133: 'gripFor' is declared but its value is never read`.

Modify `packages/sim/src/kart.ts`. Three edits.

**Edit 1 — add the import.** Before (the three import lines exactly as Task 6's Step 7 left them; the `Tuning` in the type import is Task 6's and stays):

```typescript
import type { CharacterStats, Intent, KartState, SimContext, SimState, Tuning } from './types'
import { TICK_DT } from './types'
import { clamp, wrapAngle } from './mathutil'
```

After:

```typescript
import type { CharacterStats, Intent, KartState, SimContext, SimState, Tuning } from './types'
import { TICK_DT } from './types'
import { clamp, wrapAngle } from './mathutil'
import { lateralGripFor } from './drift'
```

`drift.ts` imports nothing but `./types`, so this edge runs `kart.ts → drift.ts` and there is no cycle.

**Edit 2 — replace the lateral-grip block of `stepKart`.** It is the block that runs from the `// --- Lateral grip` banner to the `const newVr = ...` line, between the longitudinal block and the two `k.velocity` assignments. Before:

```typescript
    // --- Lateral grip -------------------------------------------------------
    // Task 8 sets drift.active; the consumer lives here because updateDrift runs
    // before stepKart in the canonical order and has nowhere to apply grip.
    // Task 8 changes this one line to: const grip = lateralGripFor(ctx, k)
    const grip = gripFor(k, t)
    const newVr = vr * (1 - clamp(grip * TICK_DT, 0, 1))
```

After:

```typescript
    // --- Lateral grip -------------------------------------------------------
    // lateralGripFor (Task 8) is the single definition of this coefficient:
    // gripDrift while drifting, gripDirt on dirt, gripTarmac on everything else
    // ('boost' and 'offtrack' included — offtrack is penalised through
    // surfaceSpeedFactor, not through grip). updateDrift runs at slot 3, before
    // stepKart, so k.drift.active already holds this tick's value.
    const newVr = vr * (1 - clamp(lateralGripFor(ctx, k) * TICK_DT, 0, 1))
```

**Edit 3 — delete `gripFor` outright.** Edit 2 removed its only call site. It sits between `targetSpeedFor` and `stepKart`, exactly as Task 6's Step 11 inserted it. Delete all of this, doc comment included. Before:

```typescript
/**
 * The lateral damping coefficient, in 1/s: how hard the sideways component of the
 * velocity is bled off this tick.
 *
 * `'offtrack'` grips like tarmac on purpose. Leaving the track is punished with
 * speed (`offtrackSpeedMul`, Task 9), not with a slide; making it slippery as
 * well would make a bad line unrecoverable.
 *
 * Task 8 owns the single definition of this rule, `lateralGripFor(ctx, k)` in
 * `drift.ts`, and it returns the same value for all four surfaces. Task 8 deletes
 * this function, adds `import { lateralGripFor } from './drift'` to this file and
 * changes the one call site below to `const grip = lateralGripFor(ctx, k)`.
 */
function gripFor(k: KartState, t: Tuning): number {
  if (k.drift.active) return t.gripDrift
  if (k.surface === 'dirt') return t.gripDirt
  return t.gripTarmac
}
```

After:

```
(nothing — the whole block above is removed. `targetSpeedFor`'s closing brace and
`stepKart`'s doc comment become adjacent, separated by one blank line.)
```

Nothing else in `kart.ts` changes, and nothing is left unused:

- `t` (`const t = ctx.tuning`) still has uses in both `stepKart` (`t.maxSpeed`, `t.steerSpeedFalloff`, `t.steerRateBase`, `t.brakeRate`, `t.accelRate`) and `targetSpeedFor`.
- the `Tuning` type import survives Edit 3 because `surgeFactorFor(state, k, t: Tuning)` — Task 6's other module-level helper, which Task 12 rewrites — still annotates with it.
- `clamp` and `TICK_DT` still have other uses, and `newVr` still feeds the same two `k.velocity` assignments below.

So after all three edits `tsc --noEmit` (Step 22) has no unused local, no unused import and no unresolved reference.

- [ ] **Step 20: Run the kart and drift suites**

Run: `npx vitest run packages/sim/test/kart.test.ts packages/sim/test/drift.test.ts`

Expected: PASS — Task 6's 15 kart tests and this task's 31 drift tests. Task 6's
"damps less on dirt" test and the four-surface test above now assert the same rule
against the same function.

---

- [ ] **Step 21: Wire slots 3 and 8 into `step()`**

Modify `packages/sim/src/step.ts`.

Add this import alongside the other `./` imports at the top of the file:

```ts
import { updateDrift, decayBoost } from './drift'
```

Then extend the per-kart loop body. `updateDrift` goes immediately **before** the `stepKart` call, and `decayBoost` becomes the **last statement of the loop body**. Task 6 wrote the first three lines and Task 7 appended the ground calls, so the block is exactly this. Before:

```ts
    const k = next.karts[i]
    const prevKart = prev.karts[i]
    const raw = resolvedInputs[i]
    stepKart(ctx, next, prevKart, k, raw)
    applyAirYaw(ctx, k, raw.steer)
    integrateVertical(ctx, k)
    // project() returns shared scratch, so both fields are copied out at once and
    // the projection itself is never retained across the calls below.
    const groundProj = ctx.query.project(k.position)
    const groundS = groundProj.s
    const groundLateral = groundProj.lateral
    // Slot 6b: the only recomputation of k.surface in the whole tick. Tasks 6, 8 and
    // 9 read this field (lateral grip, lateralGripFor, surfaceSpeedFactor); without
    // this line it keeps whatever createState put there at the start line forever.
    k.surface = ctx.query.surfaceAt(groundS, groundLateral)
    applyRamps(ctx, k, groundS)
    applyBoostPad(ctx, k, groundS, groundLateral)
```

After:

```ts
    const k = next.karts[i]
    const prevKart = prev.karts[i]
    const raw = resolvedInputs[i]
    updateDrift(ctx, k, raw)
    stepKart(ctx, next, prevKart, k, raw)
    applyAirYaw(ctx, k, raw.steer)
    integrateVertical(ctx, k)
    // project() returns shared scratch, so both fields are copied out at once and
    // the projection itself is never retained across the calls below.
    const groundProj = ctx.query.project(k.position)
    const groundS = groundProj.s
    const groundLateral = groundProj.lateral
    // Slot 6b: the only recomputation of k.surface in the whole tick. Tasks 6, 8 and
    // 9 read this field (lateral grip, lateralGripFor, surfaceSpeedFactor); without
    // this line it keeps whatever createState put there at the start line forever.
    k.surface = ctx.query.surfaceAt(groundS, groundLateral)
    applyRamps(ctx, k, groundS)
    applyBoostPad(ctx, k, groundS, groundLateral)
    decayBoost(k)
```

The order matters in both directions: `updateDrift` must run first so `stepKart` sees this tick's drift flag through `lateralGripFor`, and `decayBoost` must run last so a boost granted this tick is spent for exactly the number of ticks it was granted for.

- [ ] **Step 22: Verify nothing regressed**

Run: `npx vitest run packages/sim`

Expected: PASS — the whole `packages/sim` suite, including every test written by Tasks 2–7, still passes.

Then run: `npx tsc --noEmit -p packages/sim`

Expected: PASS with no output. This is the step that catches a half-applied Step 19: with `tsconfig`'s `noUnusedLocals: true`, keeping `gripFor` after Edit 2 removed its call site fails with `TS6133: 'gripFor' is declared but its value is never read`, and skipping Edit 1 fails with `TS2304: Cannot find name 'lateralGripFor'`. All three edits, or none.

- [ ] **Step 23: Commit**

```bash
git add packages/sim/src/drift.ts packages/sim/src/kart.ts packages/sim/src/step.ts \
        packages/sim/test/drift.test.ts
git commit -m "feat(sim): drift latch, mini-turbo charge and boost decay

updateDrift latches a slide direction when the drift button goes down with the
stick past DRIFT_STEER_MIN and xz speed above tuning.driftMinSpeed, accrues one
charge tick per held tick (capped at the top tier so the 8-bit wire field cannot
overflow), and on release grants tuning.driftBoosts[tier] as a maximum against
any boost already running. Losing speed, spinning out or respawning forfeits the
charge; being airborne does not. lateralGripFor is the single definition of the
lateral damping coefficient and returns tuning.gripDrift while drifting, which is
what makes a drift a slide rather than a tighter turn; kart.ts's own gripFor copy
of that rule is deleted here, so there is no second place for 'offtrack' to start
meaning gripDirt again. decayBoost spends one boost tick per tick and owns nothing
else.

driftTiers and driftBoosts are asserted to be even: input is 30Hz against a 60Hz
sim, so a held drift always spans an even number of ticks and an odd threshold
would sit in a window no input can land in."
```
