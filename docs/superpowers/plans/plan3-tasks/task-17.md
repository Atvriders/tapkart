### Task 17: `packages/game/src/controls/` — three touch schemes, keyboard, and the composite

**Files:**
- Create: `packages/game/src/controls/types.ts`
- Create: `packages/game/src/controls/config.ts`
- Create: `packages/game/src/controls/thumbzones.ts`
- Create: `packages/game/src/controls/tilt.ts`
- Create: `packages/game/src/controls/stick.ts`
- Create: `packages/game/src/controls/keyboard.ts`
- Create: `packages/game/src/controls/composite.ts`
- Create: `packages/game/src/controls/index.ts`
- Create: `packages/game/test/fixtures/game-fixtures.ts`
- Test: `packages/game/test/controls-config.test.ts`
- Test: `packages/game/test/controls-thumbzones.test.ts`
- Test: `packages/game/test/controls-tilt.test.ts`
- Test: `packages/game/test/controls-stick.test.ts`
- Test: `packages/game/test/controls-keyboard.test.ts`
- Test: `packages/game/test/controls-composite.test.ts`

Do **not** touch `packages/game/src/index.ts`. The barrel task (contract §5.15) re-exports
`controls/types`, `controls/config`, `controls/tilt`, `controls/composite` and `controls/index`
— and deliberately not `controls/thumbzones`, `controls/stick` or `controls/keyboard`, whose
factories reach the outside world only through `makeControlAdapter`.

`packages/game/test/fixtures/game-fixtures.ts` is **shared** with later tasks (contract §9.1
lists six exports for it). This task creates it with one export. Later tasks **append**; nobody
overwrites it.

**Interfaces:**

- Consumes, from `@tapkart/sim` (contract §2.1, §2.2 — all re-exported from the barrel
  `packages/sim/src/index.ts`):
  ```ts
  export interface Intent {
    tick: number
    steer: number      // -1..1
    accel: number      // 0..1
    brake: boolean
    drift: boolean
    useItem: boolean
  }
  export function clamp(v: number, lo: number, hi: number): number
  export function lerp(a: number, b: number, t: number): number   // a + (b - a) * t
  export const DRIFT_STEER_MIN = 0.35    // src/drift.ts — the drift-vs-brake threshold
  ```
- Consumes, from the task that created the `game` package (contract §10, §10.1):
  `packages/game/package.json` with `{"name": "@tapkart/game", "type": "module",
  "exports": {".": "./src/index.ts", "./shell": "./src/shell.ts"}, "dependencies":
  {"@tapkart/sim": "*", "@tapkart/protocol": "*", "@tapkart/net": "*", "@tapkart/content": "*",
  "@tapkart/render": "*"}}` and `packages/game/tsconfig.json` with
  `{"extends": "../../tsconfig.base.json", "compilerOptions": {"lib": ["ES2022","DOM","DOM.Iterable"]},
  "include": ["src/**/*.ts","test/**/*.ts"]}`. If either is missing, stop: this task cannot resolve
  `@tapkart/sim` by bare specifier without them.

- Produces (contract §5.5 — 26 exported symbols, exactly the census in §11):
  ```ts
  // controls/types.ts (9)
  export type ControlScheme = 'thumbZones' | 'tilt' | 'virtualStick'
  export type PointerPhase = 'down' | 'move' | 'up'
  export interface PointerSample { id: number; x: number; y: number; phase: PointerPhase }
  export interface TiltSample { alpha: number; beta: number; gamma: number }
  export interface Viewport { width: number; height: number }
  export const MAX_POINTERS = 8
  export interface ControlInputs {
    pointers: PointerSample[]; pointerCount: number
    keys: Record<string, boolean>; tilt: TiltSample | null; viewport: Viewport
  }
  export function createControlInputs(): ControlInputs
  export interface ControlAdapter {
    readonly scheme: ControlScheme
    sample(raw: ControlInputs, tick: number, out: Intent): void
    reset(): void
  }

  // controls/config.ts (11)
  export interface ControlConfig {
    deadZone: number; steerGain: number; steerSmoothingPerTick: number
    tiltNeutralDegrees: number; tiltRangeDegrees: number
    tiltCalibration: TiltCalibration; invertTilt: boolean
    keyBindings: Record<string, 'left' | 'right' | 'accel' | 'brake' | 'drift' | 'item'>
  }
  export const DEFAULT_CONTROL_CONFIG: Readonly<ControlConfig>
  export const TOUCH_BUTTON_SIZE_PX = 88
  export const TOUCH_BUTTON_MARGIN_PX = 16
  export const TOUCH_BUTTON_GAP_PX = 16
  export const THUMBZONE_FULL_LOCK_FRACTION = 0.28
  export const BRAKE_HOLD_TICKS = 18
  export interface Rect { x: number; y: number; w: number; h: number }
  export function driftButtonRect(v: Viewport, out: Rect): void
  export function itemButtonRect(v: Viewport, out: Rect): void
  export function rectContains(r: Rect, x: number, y: number): boolean

  // controls/tilt.ts (4)
  export interface TiltCalibration { betaZero: number; gammaZero: number }
  export const IDENTITY_TILT_CALIBRATION: Readonly<TiltCalibration>
  export function calibrateTilt(sample: TiltSample): TiltCalibration
  export function makeTiltAdapter(cfg: ControlConfig): ControlAdapter

  // controls/thumbzones.ts (1)
  export function makeThumbZonesAdapter(cfg: ControlConfig): ControlAdapter
  // controls/stick.ts (1)
  export function makeVirtualStickAdapter(cfg: ControlConfig): ControlAdapter
  // controls/keyboard.ts (1)
  export function makeKeyboardAdapter(cfg: ControlConfig): ControlAdapter

  // controls/composite.ts (2)
  export function mergeIntents(touch: Intent, keyboard: Intent, out: Intent): void
  export function makeCompositeAdapter(primary: ControlAdapter, secondary: ControlAdapter): ControlAdapter

  // controls/index.ts (1)
  export function makeControlAdapter(scheme: ControlScheme, cfg: ControlConfig): ControlAdapter
  ```
  ```ts
  // test/fixtures/game-fixtures.ts — test-only (contract §9.1)
  export function makeControlInputsFixture(overrides?: Partial<ControlInputs>): ControlInputs
  ```

**Two module-graph facts this task must not get wrong:**

1. **`config.ts` imports `TiltCalibration` from `tilt.ts` as a TYPE ONLY, and defines its own
   `{ betaZero: 0, gammaZero: 0 }` literal for `DEFAULT_CONTROL_CONFIG.tiltCalibration`.**
   `tilt.ts` imports *values* from `config.ts` (the button rects, `BRAKE_HOLD_TICKS`), so a value
   import in the other direction is a runtime ESM cycle: entering `tilt.ts` first evaluates
   `config.ts` while `tilt.ts`'s body has not run, and `DEFAULT_CONTROL_CONFIG` reads
   `IDENTITY_TILT_CALIBRATION` in its temporal dead zone — `ReferenceError` on import, before a
   single test runs. `import type` is erased under `verbatimModuleSyntax`, so the type edge costs
   nothing. The duplicated zero literal is kept honest by an assertion in
   `controls-tilt.test.ts` (`DEFAULT_CONTROL_CONFIG.tiltCalibration` deep-equals
   `IDENTITY_TILT_CALIBRATION`).
2. **Nothing in `controls/` except `source.ts` (Task 18) may name a DOM API.** These files run
   under `environment: 'node'`. No `window`, no `document`, no `addEventListener`.

- [ ] **Step 1: Write the failing test for `types.ts` and `config.ts`**

Create `packages/game/test/fixtures/game-fixtures.ts`:

```ts
// Shared test fixtures for @tapkart/game (contract §9.1).
//
// LATER TASKS APPEND TO THIS FILE. It is the one fixture module the game package
// has; overwriting it deletes another task's fixtures.
import type { ControlInputs } from '../../src/controls/types'
import { createControlInputs } from '../../src/controls/types'

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
```

Create `packages/game/test/controls-config.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { MAX_POINTERS, createControlInputs } from '../src/controls/types'
import {
  DEFAULT_CONTROL_CONFIG,
  TOUCH_BUTTON_SIZE_PX,
  TOUCH_BUTTON_MARGIN_PX,
  TOUCH_BUTTON_GAP_PX,
  THUMBZONE_FULL_LOCK_FRACTION,
  BRAKE_HOLD_TICKS,
  driftButtonRect,
  itemButtonRect,
  rectContains,
} from '../src/controls/config'
import type { Rect } from '../src/controls/config'
import { makeControlInputsFixture } from './fixtures/game-fixtures'

// The viewport every touch test in this task uses. 800x400 makes every rect
// coordinate an exact integer, so the numbers below are written out rather than
// recomputed from the constants - a test that recomputes the layout from the
// same constants the implementation uses cannot detect a wrong layout.
const W = 800
const H = 400
const VIEWPORT = { width: W, height: H }

function newRect(): Rect {
  return { x: 0, y: 0, w: 0, h: 0 }
}

describe('controls/types', () => {
  it('createControlInputs allocates MAX_POINTERS pointer slots and nothing live', () => {
    // CATCHES: a lazily-grown `pointers` array. The source (Task 18) writes into
    // `out.pointers[i]` without allocating; a short array silently drops touches.
    const raw = createControlInputs()
    expect(MAX_POINTERS).toBe(8)
    expect(raw.pointers).toHaveLength(MAX_POINTERS)
    expect(raw.pointerCount).toBe(0)
    expect(raw.tilt).toBeNull()
    expect(Object.keys(raw.keys)).toHaveLength(0)
  })

  it('gives every pointer slot its own object', () => {
    // CATCHES: `new Array(MAX_POINTERS).fill(sample)`, which aliases all eight
    // slots to one object, so two simultaneous touches read as one.
    const raw = createControlInputs()
    raw.pointers[0].x = 111
    expect(raw.pointers[1].x).toBe(0)
    expect(raw.pointers[0]).not.toBe(raw.pointers[1])
  })
})

describe('controls/config DEFAULT_CONTROL_CONFIG', () => {
  it('is the contract §5.5 default table, value by value', () => {
    // CATCHES: a tuning value drifting from the contract. Every number below is
    // load-bearing: deadZone and smoothing are asserted by exact arithmetic in
    // the adapter tests, so a changed default breaks them loudly, not silently.
    expect(DEFAULT_CONTROL_CONFIG.deadZone).toBe(0.06)
    expect(DEFAULT_CONTROL_CONFIG.steerGain).toBe(1)
    expect(DEFAULT_CONTROL_CONFIG.steerSmoothingPerTick).toBe(0.35)
    expect(DEFAULT_CONTROL_CONFIG.tiltNeutralDegrees).toBe(0)
    expect(DEFAULT_CONTROL_CONFIG.tiltRangeDegrees).toBe(25)
    expect(DEFAULT_CONTROL_CONFIG.invertTilt).toBe(false)
    expect(DEFAULT_CONTROL_CONFIG.tiltCalibration).toEqual({ betaZero: 0, gammaZero: 0 })
  })

  it('binds exactly the twelve documented key codes to their actions', () => {
    // CATCHES: a missing alternate binding (WASD or Space), which is invisible
    // until someone plays on a keyboard without arrow keys, and a binding typo'd
    // as a KeyboardEvent.key ('a') instead of a .code ('KeyA') - the adapter reads
    // .code, so 'a' would never match anything.
    expect(DEFAULT_CONTROL_CONFIG.keyBindings).toEqual({
      ArrowLeft: 'left',
      KeyA: 'left',
      ArrowRight: 'right',
      KeyD: 'right',
      ArrowUp: 'accel',
      KeyW: 'accel',
      ArrowDown: 'brake',
      KeyS: 'brake',
      ShiftLeft: 'drift',
      Space: 'drift',
      KeyE: 'item',
      ControlLeft: 'item',
    })
  })
})

describe('controls/config layout (Q24)', () => {
  it('exports the contract §5.5 layout constants', () => {
    expect(TOUCH_BUTTON_SIZE_PX).toBe(88)
    expect(TOUCH_BUTTON_MARGIN_PX).toBe(16)
    expect(TOUCH_BUTTON_GAP_PX).toBe(16)
    expect(THUMBZONE_FULL_LOCK_FRACTION).toBe(0.28)
    expect(BRAKE_HOLD_TICKS).toBe(18)
  })

  it('puts the drift button 16 px from the bottom and right edges', () => {
    // CATCHES: a rect measured from the top-left instead of the bottom-right, and
    // a margin applied to only one axis. Hard-coded expectations, not recomputed.
    const r = newRect()
    driftButtonRect(VIEWPORT, r)
    expect(r).toEqual({ x: 696, y: 296, w: 88, h: 88 })
  })

  it('puts the item button directly above the drift button with a 16 px gap', () => {
    // CATCHES: the item button placed beside (not above) the drift button, or
    // stacked with no gap - which would delete the dead space Q24 requires.
    const r = newRect()
    itemButtonRect(VIEWPORT, r)
    expect(r).toEqual({ x: 696, y: 192, w: 88, h: 88 })

    const drift = newRect()
    driftButtonRect(VIEWPORT, drift)
    expect(drift.y - (r.y + r.h)).toBe(TOUCH_BUTTON_GAP_PX)
    expect(r.x).toBe(drift.x)
  })

  it('writes into the caller-owned Rect and allocates nothing', () => {
    // CATCHES: a rect helper that returns a fresh object and leaves `out`
    // untouched - the frame path would then read a stale zero rect forever.
    const r = newRect()
    const same = r
    driftButtonRect(VIEWPORT, r)
    expect(same.w).toBe(88)
  })

  it('rectContains is half-open on the far edges', () => {
    // CATCHES: `<=` on the far edge, which makes adjacent controls overlap by one
    // pixel row - the exact ambiguity Q24's dead gap exists to remove.
    const r: Rect = { x: 10, y: 20, w: 100, h: 50 }
    expect(rectContains(r, 10, 20)).toBe(true)
    expect(rectContains(r, 109.999, 69.999)).toBe(true)
    expect(rectContains(r, 110, 40)).toBe(false)
    expect(rectContains(r, 40, 70)).toBe(false)
    expect(rectContains(r, 9.999, 40)).toBe(false)
    expect(rectContains(r, 40, 19.999)).toBe(false)
  })

  it('leaves a dead band between the two buttons that belongs to neither', () => {
    // CATCHES: nearest-button snapping. Q24: a touch in the gap presses NOTHING.
    // The band is y in [280, 296) at the buttons' x range.
    const drift = newRect()
    const item = newRect()
    driftButtonRect(VIEWPORT, drift)
    itemButtonRect(VIEWPORT, item)
    for (const y of [280, 285, 295.999]) {
      expect(rectContains(drift, 740, y)).toBe(false)
      expect(rectContains(item, 740, y)).toBe(false)
    }
  })
})

describe('game-fixtures makeControlInputsFixture', () => {
  it('defaults to the 800x400 landscape viewport with nothing pressed', () => {
    const raw = makeControlInputsFixture()
    expect(raw.viewport).toEqual({ width: W, height: H })
    expect(raw.pointerCount).toBe(0)
    expect(raw.pointers).toHaveLength(MAX_POINTERS)
  })

  it('applies overrides', () => {
    const raw = makeControlInputsFixture({ keys: { KeyW: true }, tilt: { alpha: 0, beta: 0, gamma: 5 } })
    expect(raw.keys.KeyW).toBe(true)
    expect(raw.tilt?.gamma).toBe(5)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/game/test/controls-config.test.ts`
Expected: FAIL with `Failed to resolve import "../src/controls/types" from "packages/game/test/controls-config.test.ts". Does the file exist?`

- [ ] **Step 3: Write `types.ts` and `config.ts`**

Create `packages/game/src/controls/types.ts`:

```ts
import type { Intent } from '@tapkart/sim'

/**
 * THREE schemes (spec §1: "3, selectable (plus keyboard for desktop)").
 * Keyboard is NOT a fourth: Q23 rules it a merge, not an alternative.
 */
export type ControlScheme = 'thumbZones' | 'tilt' | 'virtualStick'

export type PointerPhase = 'down' | 'move' | 'up'

export interface PointerSample {
  id: number // the browser's pointerId; stable for one touch
  x: number // CSS px from the viewport's left edge
  y: number // CSS px from the viewport's TOP edge
  phase: PointerPhase
}

export interface TiltSample { alpha: number; beta: number; gamma: number } // degrees

export interface Viewport { width: number; height: number } // CSS px

export const MAX_POINTERS = 8

/**
 * Raw, device-shaped input for ONE frame. Filled by the DOM source (§5.6) or by a
 * test, and consumed by exactly one ControlAdapter. `pointers` is fixed length
 * MAX_POINTERS; only [0, pointerCount) is live.
 */
export interface ControlInputs {
  pointers: PointerSample[]
  pointerCount: number
  keys: Record<string, boolean> // KeyboardEvent.code, e.g. 'ArrowLeft', 'KeyZ'
  tilt: TiltSample | null // null when unavailable or not permitted
  viewport: Viewport
}

/**
 * Allocates one ControlInputs with every pointer slot a DISTINCT object. Called
 * once, at startup: the drain path (§5.6) and every adapter reuse it forever, so
 * nothing in the frame path allocates.
 */
export function createControlInputs(): ControlInputs {
  const pointers: PointerSample[] = []
  for (let i = 0; i < MAX_POINTERS; i++) pointers.push({ id: -1, x: 0, y: 0, phase: 'up' })
  return { pointers, pointerCount: 0, keys: {}, tilt: null, viewport: { width: 0, height: 0 } }
}

/**
 * Every scheme is one of these and nothing more. Spec §6: "three schemes is three
 * small adapters, not three control systems."
 */
export interface ControlAdapter {
  readonly scheme: ControlScheme
  /**
   * Pure over (raw, tick, this adapter's own latched state). SOLE WRITER of `out`,
   * and it writes EVERY field of `out` including `out.tick = tick`.
   */
  sample(raw: ControlInputs, tick: number, out: Intent): void
  /**
   * Drops all latched state: drift hold, brake hold counter, stick origin, pointer
   * ids, item edge latch.
   */
  reset(): void
}
```

Create `packages/game/src/controls/config.ts`:

```ts
// TYPE-ONLY import of TiltCalibration, deliberately: tilt.ts imports this module's
// VALUES (the button rects, BRAKE_HOLD_TICKS), and a value import back would make a
// runtime ESM cycle whose symptom is a temporal-dead-zone ReferenceError at import
// time. `import type` is erased under verbatimModuleSyntax, so this edge is free.
// The cost is one duplicated zero literal below, and controls-tilt.test.ts asserts
// it equals IDENTITY_TILT_CALIBRATION.
import type { TiltCalibration } from './tilt'
import type { Viewport } from './types'

export interface ControlConfig {
  deadZone: number // 0..1 of the full-lock distance, below which steer is 0
  steerGain: number // multiplies the normalised steer axis before clamping
  steerSmoothingPerTick: number // 0..1 lerp toward the raw axis, once per sample()
  tiltNeutralDegrees: number
  tiltRangeDegrees: number // degrees from neutral to full lock
  tiltCalibration: TiltCalibration
  invertTilt: boolean
  keyBindings: Record<string, 'left' | 'right' | 'accel' | 'brake' | 'drift' | 'item'>
}

export const DEFAULT_CONTROL_CONFIG: Readonly<ControlConfig> = {
  deadZone: 0.06,
  steerGain: 1,
  steerSmoothingPerTick: 0.35,
  tiltNeutralDegrees: 0,
  tiltRangeDegrees: 25,
  tiltCalibration: { betaZero: 0, gammaZero: 0 }, // === IDENTITY_TILT_CALIBRATION
  invertTilt: false,
  keyBindings: {
    ArrowLeft: 'left',
    KeyA: 'left',
    ArrowRight: 'right',
    KeyD: 'right',
    ArrowUp: 'accel',
    KeyW: 'accel',
    ArrowDown: 'brake',
    KeyS: 'brake',
    ShiftLeft: 'drift',
    Space: 'drift',
    KeyE: 'item',
    ControlLeft: 'item',
  },
}

// Q24's layout, in CSS px, shared by thumbZones and tilt so their buttons cannot
// disagree by a pixel. virtualStick reuses both rects and places its gas and brake
// buttons one column to the left of them, from these same constants.
export const TOUCH_BUTTON_SIZE_PX = 88
export const TOUCH_BUTTON_MARGIN_PX = 16
export const TOUCH_BUTTON_GAP_PX = 16

/** Full lock at 28 % of the half-width, measured from the touch-down origin. */
export const THUMBZONE_FULL_LOCK_FRACTION = 0.28

/** Q21's brake: ticks the drift button must be held before it also brakes. */
export const BRAKE_HOLD_TICKS = 18 // 0.3 s at 60 Hz

export interface Rect { x: number; y: number; w: number; h: number } // CSS px, y down

/** Bottom-right, TOUCH_BUTTON_MARGIN_PX from both edges. */
export function driftButtonRect(v: Viewport, out: Rect): void {
  out.x = v.width - TOUCH_BUTTON_MARGIN_PX - TOUCH_BUTTON_SIZE_PX
  out.y = v.height - TOUCH_BUTTON_MARGIN_PX - TOUCH_BUTTON_SIZE_PX
  out.w = TOUCH_BUTTON_SIZE_PX
  out.h = TOUCH_BUTTON_SIZE_PX
}

/** Directly above the drift button, TOUCH_BUTTON_GAP_PX of dead space between. */
export function itemButtonRect(v: Viewport, out: Rect): void {
  driftButtonRect(v, out)
  out.y -= TOUCH_BUTTON_GAP_PX + TOUCH_BUTTON_SIZE_PX
}

/** Half-open on the far edges: x in [r.x, r.x + r.w), y in [r.y, r.y + r.h). */
export function rectContains(r: Rect, x: number, y: number): boolean {
  return x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/game/test/controls-config.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Write the failing test for `thumbzones.ts`**

Create `packages/game/test/controls-thumbzones.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import type { Intent } from '@tapkart/sim'
import { DRIFT_STEER_MIN } from '@tapkart/sim'
import type { ControlInputs, PointerPhase } from '../src/controls/types'
import { BRAKE_HOLD_TICKS, DEFAULT_CONTROL_CONFIG } from '../src/controls/config'
import { makeThumbZonesAdapter } from '../src/controls/thumbzones'
import { makeControlInputsFixture } from './fixtures/game-fixtures'

// 800x400. Half-width 400, so full lock is 400 * 0.28 = 112 px from the origin.
// The buttons are drift [696,784)x[296,384) and item [696,784)x[192,280), with a
// dead band at y in [280,296).
const LOCK_PX = 112

function poisonedIntent(): Intent {
  // Every field set to a value the adapter must overwrite. A `sample` that writes
  // only the fields it "changed" leaves useItem true here, and a latched useItem
  // fires every item the instant it is granted, forever.
  return { tick: -999, steer: 999, accel: -999, brake: true, drift: true, useItem: true }
}

function point(raw: ControlInputs, id: number, x: number, y: number, phase: PointerPhase): void {
  const p = raw.pointers[raw.pointerCount]
  p.id = id
  p.x = x
  p.y = y
  p.phase = phase
  raw.pointerCount++
}

/** One frame: hand the adapter the pending pointer events, then clear them. */
function step(adapter: ReturnType<typeof makeThumbZonesAdapter>, raw: ControlInputs,
              tick: number, out: Intent): void {
  adapter.sample(raw, tick, out)
  raw.pointerCount = 0
}

describe('thumbZones steering (Q24)', () => {
  it('is relative to the touch-down origin: a thumb landing off-centre does not steer', () => {
    // THE Q24 TEST. Under absolute steering, a touch at x=60 is (60-400)/112 =
    // -3.04 -> clamped -1 -> steer -0.35 on the first tick and a hard-left jerk.
    // Under relative steering it is exactly 0 and stays 0 while the thumb is still.
    const a = makeThumbZonesAdapter(DEFAULT_CONTROL_CONFIG)
    const raw = makeControlInputsFixture()
    const out = poisonedIntent()
    point(raw, 1, 60, 200, 'down')
    step(a, raw, 0, out)
    expect(out.steer).toBe(0)
    for (let t = 1; t <= 5; t++) {
      step(a, raw, t, out)
      expect(out.steer).toBe(0)
    }
  })

  it('overwrites every field of `out`, including the ones it did not change', () => {
    // CATCHES: a partial writer. `out` is the Intent the session submits; a stale
    // useItem or brake from a previous frame is indistinguishable from a press.
    const a = makeThumbZonesAdapter(DEFAULT_CONTROL_CONFIG)
    const raw = makeControlInputsFixture()
    const out = poisonedIntent()
    step(a, raw, 42, out)
    expect(out).toEqual({ tick: 42, steer: 0, accel: 1, brake: false, drift: false, useItem: false })
  })

  it('reaches full lock at 28 % of the HALF-width and smooths at 0.35 per tick', () => {
    // CATCHES: normalising against the full width (which would halve the response),
    // and a missing or wrong smoothing factor. The first three values are exact
    // arithmetic on lerp(prev, 1, 0.35): 0.35, 0.5775, 0.725375.
    const a = makeThumbZonesAdapter(DEFAULT_CONTROL_CONFIG)
    const raw = makeControlInputsFixture()
    const out = poisonedIntent()
    point(raw, 1, 200, 200, 'down')
    step(a, raw, 0, out)
    point(raw, 1, 200 + LOCK_PX, 200, 'move')
    step(a, raw, 1, out)
    expect(out.steer).toBeCloseTo(0.35, 9)
    step(a, raw, 2, out)
    expect(out.steer).toBeCloseTo(0.5775, 9)
    step(a, raw, 3, out)
    expect(out.steer).toBeCloseTo(0.725375, 9)
    for (let t = 4; t <= 24; t++) step(a, raw, t, out)
    expect(out.steer).toBeGreaterThan(0.999)
    expect(out.steer).toBeLessThanOrEqual(1)
  })

  it('half the full-lock distance converges to half lock', () => {
    // CATCHES: a normalisation that is right at the extremes and wrong in between
    // (e.g. squared or stepped response). Under the full-width bug this converges
    // to 0.25 and fails.
    const a = makeThumbZonesAdapter(DEFAULT_CONTROL_CONFIG)
    const raw = makeControlInputsFixture()
    const out = poisonedIntent()
    point(raw, 1, 200, 200, 'down')
    step(a, raw, 0, out)
    point(raw, 1, 200 - LOCK_PX / 2, 200, 'move')
    for (let t = 1; t <= 24; t++) step(a, raw, t, out)
    expect(out.steer).toBeCloseTo(-0.5, 3)
  })

  it('clamps past full lock and never leaves [-1, 1]', () => {
    const a = makeThumbZonesAdapter(DEFAULT_CONTROL_CONFIG)
    const raw = makeControlInputsFixture()
    const out = poisonedIntent()
    point(raw, 1, 350, 200, 'down')
    step(a, raw, 0, out)
    point(raw, 1, -5000, 200, 'move')
    for (let t = 1; t <= 40; t++) {
      step(a, raw, t, out)
      expect(out.steer).toBeGreaterThanOrEqual(-1)
      expect(out.steer).toBeLessThanOrEqual(1)
    }
    expect(out.steer).toBeLessThan(-0.999)
  })

  it('applies the dead zone to the raw axis, not the smoothed output', () => {
    // CATCHES: a dead zone tested against the smoothed value, which would swallow
    // the first two ticks of EVERY steer input. 6 px / 112 px = 0.0536 (dead);
    // 8 px / 112 px = 0.0714 (live, and 0.35 of it is 0.025).
    const dead = makeThumbZonesAdapter(DEFAULT_CONTROL_CONFIG)
    const rawDead = makeControlInputsFixture()
    const outDead = poisonedIntent()
    point(rawDead, 1, 200, 200, 'down')
    step(dead, rawDead, 0, outDead)
    point(rawDead, 1, 206, 200, 'move')
    for (let t = 1; t <= 10; t++) step(dead, rawDead, t, outDead)
    expect(outDead.steer).toBe(0)

    const live = makeThumbZonesAdapter(DEFAULT_CONTROL_CONFIG)
    const rawLive = makeControlInputsFixture()
    const outLive = poisonedIntent()
    point(rawLive, 1, 200, 200, 'down')
    step(live, rawLive, 0, outLive)
    point(rawLive, 1, 208, 200, 'move')
    step(live, rawLive, 1, outLive)
    expect(outLive.steer).toBeCloseTo(0.025, 9)
  })

  it('returns to centre when the steering thumb lifts', () => {
    const a = makeThumbZonesAdapter(DEFAULT_CONTROL_CONFIG)
    const raw = makeControlInputsFixture()
    const out = poisonedIntent()
    point(raw, 1, 200, 200, 'down')
    step(a, raw, 0, out)
    point(raw, 1, 200 + LOCK_PX, 200, 'move')
    for (let t = 1; t <= 20; t++) step(a, raw, t, out)
    expect(out.steer).toBeGreaterThan(0.99)
    point(raw, 1, 200 + LOCK_PX, 200, 'up')
    for (let t = 21; t <= 60; t++) step(a, raw, t, out)
    expect(out.steer).toBeCloseTo(0, 6)
  })

  it('never produces NaN on a zero-sized viewport', () => {
    // CATCHES: division by a zero half-width on the first frame, before the shell
    // has measured the canvas. NaN in the smoother is permanent: it survives every
    // subsequent lerp and the kart never steers again for the whole session.
    const a = makeThumbZonesAdapter(DEFAULT_CONTROL_CONFIG)
    const raw = makeControlInputsFixture({ viewport: { width: 0, height: 0 } })
    const out = poisonedIntent()
    point(raw, 1, 0, 0, 'down')
    step(a, raw, 0, out)
    point(raw, 1, 50, 0, 'move')
    step(a, raw, 1, out)
    expect(Number.isNaN(out.steer)).toBe(false)
    expect(out.steer).toBe(0)
  })
})

describe('thumbZones buttons (Q24, Q25)', () => {
  it('holds drift while the drift button is down and auto-accelerates throughout', () => {
    const a = makeThumbZonesAdapter(DEFAULT_CONTROL_CONFIG)
    const raw = makeControlInputsFixture()
    const out = poisonedIntent()
    point(raw, 2, 740, 340, 'down')
    step(a, raw, 0, out)
    expect(out.drift).toBe(true)
    expect(out.accel).toBe(1)
    step(a, raw, 1, out)
    expect(out.drift).toBe(true)
    point(raw, 2, 740, 340, 'up')
    step(a, raw, 2, out)
    expect(out.drift).toBe(false)
  })

  it('fires useItem on exactly one tick per press (Q25)', () => {
    // CATCHES a LEVEL instead of an EDGE. A single-tick test cannot tell the two
    // apart, so this one holds the button for five ticks, then releases and
    // re-presses. A level implementation reports true on all six.
    const a = makeThumbZonesAdapter(DEFAULT_CONTROL_CONFIG)
    const raw = makeControlInputsFixture()
    const out = poisonedIntent()
    const fired: number[] = []
    point(raw, 3, 740, 240, 'down')
    for (let t = 0; t <= 5; t++) {
      step(a, raw, t, out)
      if (out.useItem) fired.push(t)
    }
    point(raw, 3, 740, 240, 'up')
    step(a, raw, 6, out)
    if (out.useItem) fired.push(6)
    point(raw, 3, 740, 240, 'down')
    step(a, raw, 7, out)
    if (out.useItem) fired.push(7)
    expect(fired).toEqual([0, 7])
  })

  it('presses NEITHER button for a touch in the gap between them (Q24)', () => {
    // CATCHES nearest-button snapping. y in [280,296) is dead space; a snapping
    // implementation fires drift or item here and the player cannot tell why.
    const a = makeThumbZonesAdapter(DEFAULT_CONTROL_CONFIG)
    const raw = makeControlInputsFixture()
    const out = poisonedIntent()
    point(raw, 4, 740, 288, 'down')
    for (let t = 0; t <= 30; t++) {
      step(a, raw, t, out)
      expect(out.drift).toBe(false)
      expect(out.useItem).toBe(false)
      expect(out.brake).toBe(false)
      expect(out.steer).toBe(0)
    }
  })

  it('ignores a right-half touch that is not inside a button', () => {
    const a = makeThumbZonesAdapter(DEFAULT_CONTROL_CONFIG)
    const raw = makeControlInputsFixture()
    const out = poisonedIntent()
    point(raw, 5, 500, 100, 'down')
    point(raw, 5, 520, 100, 'move')
    step(a, raw, 0, out)
    expect(out).toEqual({ tick: 0, steer: 0, accel: 1, brake: false, drift: false, useItem: false })
  })

  it('keeps a touch with the control it started on, even when it slides away', () => {
    // CATCHES per-move re-routing. A thumb that starts on drift and drifts 400 px
    // left must keep drifting and must NOT hijack steering; re-routing drops the
    // drift mid-corner, which reads as the game ignoring the player.
    const a = makeThumbZonesAdapter(DEFAULT_CONTROL_CONFIG)
    const raw = makeControlInputsFixture()
    const out = poisonedIntent()
    point(raw, 6, 740, 340, 'down')
    step(a, raw, 0, out)
    point(raw, 6, 100, 100, 'move')
    for (let t = 1; t <= 10; t++) step(a, raw, t, out)
    expect(out.drift).toBe(true)
    expect(out.steer).toBe(0)
  })

  it('tracks two simultaneous touches: steering thumb plus drift button', () => {
    const a = makeThumbZonesAdapter(DEFAULT_CONTROL_CONFIG)
    const raw = makeControlInputsFixture()
    const out = poisonedIntent()
    point(raw, 7, 200, 200, 'down')
    point(raw, 8, 740, 340, 'down')
    step(a, raw, 0, out)
    point(raw, 7, 200 + LOCK_PX, 200, 'move')
    for (let t = 1; t <= 20; t++) step(a, raw, t, out)
    expect(out.drift).toBe(true)
    expect(out.steer).toBeGreaterThan(0.99)
  })
})

describe('thumbZones brake on a drift long-press (Q21)', () => {
  it('brakes on the 18th consecutive tick of a straight-line hold, not before', () => {
    // CATCHES an off-by-one on BRAKE_HOLD_TICKS and a brake wired to the press
    // edge. `drift` must stay true the whole time: a brake that replaces the drift
    // would pass a brake-only assertion and break drifting.
    const a = makeThumbZonesAdapter(DEFAULT_CONTROL_CONFIG)
    const raw = makeControlInputsFixture()
    const out = poisonedIntent()
    point(raw, 9, 740, 340, 'down')
    for (let t = 0; t < BRAKE_HOLD_TICKS - 1; t++) {
      step(a, raw, t, out)
      expect(out.brake).toBe(false)
      expect(out.drift).toBe(true)
    }
    step(a, raw, BRAKE_HOLD_TICKS - 1, out)
    expect(out.brake).toBe(true)
    expect(out.drift).toBe(true)
  })

  it('does not brake while the thumb is turning, and starts once it straightens', () => {
    // THE Q21 QUALIFIER TEST. |steer| >= DRIFT_STEER_MIN means the hold is a drift,
    // not a brake. A test that only held the button straight would pass with the
    // qualifier missing entirely; this one holds it at full lock for well past the
    // threshold, then releases the steering thumb and watches the brake appear as
    // the smoothed steer decays below 0.35.
    const a = makeThumbZonesAdapter(DEFAULT_CONTROL_CONFIG)
    const raw = makeControlInputsFixture()
    const out = poisonedIntent()
    point(raw, 10, 200, 200, 'down')
    point(raw, 11, 740, 340, 'down')
    step(a, raw, 0, out)
    point(raw, 10, 200 + LOCK_PX, 200, 'move')
    for (let t = 1; t <= 40; t++) {
      step(a, raw, t, out)
      expect(out.brake).toBe(false)
    }
    expect(out.steer).toBeGreaterThan(DRIFT_STEER_MIN)
    expect(out.drift).toBe(true)

    point(raw, 10, 200 + LOCK_PX, 200, 'up')
    let brakingAt = -1
    for (let t = 41; t <= 60; t++) {
      step(a, raw, t, out)
      if (out.brake && brakingAt === -1) brakingAt = t
    }
    expect(brakingAt).toBeGreaterThan(-1)
    expect(Math.abs(out.steer)).toBeLessThan(DRIFT_STEER_MIN)
  })

  it('restarts the hold counter when the button is released', () => {
    const a = makeThumbZonesAdapter(DEFAULT_CONTROL_CONFIG)
    const raw = makeControlInputsFixture()
    const out = poisonedIntent()
    point(raw, 12, 740, 340, 'down')
    for (let t = 0; t < 17; t++) step(a, raw, t, out)
    point(raw, 12, 740, 340, 'up')
    step(a, raw, 17, out)
    expect(out.brake).toBe(false)
    point(raw, 12, 740, 340, 'down')
    for (let t = 18; t < 18 + BRAKE_HOLD_TICKS - 1; t++) {
      step(a, raw, t, out)
      expect(out.brake).toBe(false)
    }
    step(a, raw, 100, out)
    expect(out.brake).toBe(true)
  })
})

describe('thumbZones reset', () => {
  it('drops the steer smoothing, the pointer claims, the hold counter and the item latch', () => {
    // CATCHES a partial reset. The item latch is the subtle one: if reset() leaves
    // it set, the first press after a race never fires.
    const a = makeThumbZonesAdapter(DEFAULT_CONTROL_CONFIG)
    const raw = makeControlInputsFixture()
    const out = poisonedIntent()
    point(raw, 13, 200, 200, 'down')
    point(raw, 14, 740, 340, 'down')
    point(raw, 15, 740, 240, 'down')
    step(a, raw, 0, out)
    point(raw, 13, 200 + LOCK_PX, 200, 'move')
    for (let t = 1; t <= 20; t++) step(a, raw, t, out)
    expect(out.steer).toBeGreaterThan(0.99)
    expect(out.drift).toBe(true)
    expect(out.brake).toBe(false)

    a.reset()
    step(a, raw, 21, out)
    expect(out).toEqual({ tick: 21, steer: 0, accel: 1, brake: false, drift: false, useItem: false })

    point(raw, 16, 740, 240, 'down')
    step(a, raw, 22, out)
    expect(out.useItem).toBe(true)
  })
})

describe('thumbZones scheme identity', () => {
  it('reports its scheme', () => {
    expect(makeThumbZonesAdapter(DEFAULT_CONTROL_CONFIG).scheme).toBe('thumbZones')
  })
})
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `npx vitest run packages/game/test/controls-thumbzones.test.ts`
Expected: FAIL with `Failed to resolve import "../src/controls/thumbzones" from "packages/game/test/controls-thumbzones.test.ts". Does the file exist?`

- [ ] **Step 7: Write `thumbzones.ts`**

Create `packages/game/src/controls/thumbzones.ts`:

```ts
import type { Intent } from '@tapkart/sim'
import { DRIFT_STEER_MIN, clamp, lerp } from '@tapkart/sim'
import type { ControlAdapter, ControlInputs, Viewport } from './types'
import type { ControlConfig, Rect } from './config'
import {
  BRAKE_HOLD_TICKS,
  THUMBZONE_FULL_LOCK_FRACTION,
  driftButtonRect,
  itemButtonRect,
  rectContains,
} from './config'

/**
 * Auto-accelerate + thumb zones (spec §6, the default scheme).
 *
 * Steering is RELATIVE to the touch-down origin (Q24): full lock at
 * THUMBZONE_FULL_LOCK_FRACTION of the half-width away from where the thumb landed.
 * Absolute steering would jerk the kart to full lock the instant a thumb landed
 * anywhere but the exact screen centre.
 *
 * The right half holds two 88 px buttons with 16 px of dead space between them. A
 * touch landing in that gap belongs to NEITHER button, and a touch that starts on a
 * control keeps that control for its whole life, even if it slides out.
 *
 * `accel` is always 1, including under motion lock (Q21): `sim` ignores input while
 * `motionLocked`, so the adapter has no reason to lie about what the player is
 * doing, and the HUD reads `motionLocked` rather than `accel`.
 */
export function makeThumbZonesAdapter(cfg: ControlConfig): ControlAdapter {
  // Scratch, allocated once. Nothing below allocates per tick.
  const driftRect: Rect = { x: 0, y: 0, w: 0, h: 0 }
  const itemRect: Rect = { x: 0, y: 0, w: 0, h: 0 }

  let steerId = -1
  let driftId = -1
  let itemId = -1
  let originX = 0
  let currentX = 0
  let driftHeldTicks = 0
  let steer = 0

  function steerAxis(v: Viewport): number {
    if (steerId === -1) return 0
    const lockPx = v.width * 0.5 * THUMBZONE_FULL_LOCK_FRACTION
    if (!(lockPx > 0)) return 0 // pre-measure frame: no viewport, no steering, no NaN
    return clamp((currentX - originX) / lockPx, -1, 1)
  }

  return {
    scheme: 'thumbZones',

    sample(raw: ControlInputs, tick: number, out: Intent): void {
      driftButtonRect(raw.viewport, driftRect)
      itemButtonRect(raw.viewport, itemRect)

      let itemPulse = false

      for (let i = 0; i < raw.pointerCount; i++) {
        const p = raw.pointers[i]
        if (p.phase === 'down') {
          if (rectContains(driftRect, p.x, p.y)) {
            if (driftId === -1) driftId = p.id
          } else if (rectContains(itemRect, p.x, p.y)) {
            if (itemId === -1) {
              itemId = p.id
              itemPulse = true // Q25: one-tick pulse on the press edge
            }
          } else if (steerId === -1 && p.x < raw.viewport.width * 0.5) {
            steerId = p.id
            originX = p.x
            currentX = p.x
          }
          // Anything else - the inter-button gap, the right half outside a button -
          // belongs to nothing. Dead space is the correct answer (Q24).
        } else if (p.phase === 'move') {
          // A move never re-routes a touch: only the steering thumb reads position.
          if (p.id === steerId) currentX = p.x
        } else {
          if (p.id === steerId) steerId = -1
          if (p.id === driftId) driftId = -1
          if (p.id === itemId) itemId = -1
        }
      }

      let axis = steerAxis(raw.viewport)
      if (Math.abs(axis) < cfg.deadZone) axis = 0
      const target = clamp(axis * cfg.steerGain, -1, 1)
      steer = clamp(lerp(steer, target, cfg.steerSmoothingPerTick), -1, 1)

      const drift = driftId !== -1
      driftHeldTicks = drift ? driftHeldTicks + 1 : 0

      out.tick = tick
      out.steer = steer
      out.accel = 1
      // Q21: a long press brakes only when the thumb is straight. `updateDrift`
      // engages a drift at |steer| >= DRIFT_STEER_MIN, so the same constant - sim's
      // own, imported - is what separates "held while turning" from "held straight".
      out.brake = driftHeldTicks >= BRAKE_HOLD_TICKS && Math.abs(steer) < DRIFT_STEER_MIN
      out.drift = drift
      out.useItem = itemPulse
    },

    reset(): void {
      steerId = -1
      driftId = -1
      itemId = -1
      originX = 0
      currentX = 0
      driftHeldTicks = 0
      steer = 0
    },
  }
}
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `npx vitest run packages/game/test/controls-thumbzones.test.ts`
Expected: PASS, 19 tests.

- [ ] **Step 9: Write the failing test for `tilt.ts`**

Create `packages/game/test/controls-tilt.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import type { Intent } from '@tapkart/sim'
import { DRIFT_STEER_MIN } from '@tapkart/sim'
import type { ControlConfig } from '../src/controls/config'
import { BRAKE_HOLD_TICKS, DEFAULT_CONTROL_CONFIG } from '../src/controls/config'
import type { ControlInputs, PointerPhase } from '../src/controls/types'
import { IDENTITY_TILT_CALIBRATION, calibrateTilt, makeTiltAdapter } from '../src/controls/tilt'
import { makeControlInputsFixture } from './fixtures/game-fixtures'

function poisonedIntent(): Intent {
  return { tick: -999, steer: 999, accel: -999, brake: true, drift: true, useItem: true }
}

function point(raw: ControlInputs, id: number, x: number, y: number, phase: PointerPhase): void {
  const p = raw.pointers[raw.pointerCount]
  p.id = id
  p.x = x
  p.y = y
  p.phase = phase
  raw.pointerCount++
}

function step(a: ReturnType<typeof makeTiltAdapter>, raw: ControlInputs, tick: number, out: Intent): void {
  a.sample(raw, tick, out)
  raw.pointerCount = 0
}

function withCfg(overrides: Partial<ControlConfig>): ControlConfig {
  return { ...DEFAULT_CONTROL_CONFIG, ...overrides }
}

/** Settles the smoother: 24 ticks of the same tilt reaches the target to 1e-4. */
function settle(a: ReturnType<typeof makeTiltAdapter>, raw: ControlInputs, out: Intent): void {
  for (let t = 0; t < 24; t++) step(a, raw, t, out)
}

describe('tilt calibration', () => {
  it('IDENTITY_TILT_CALIBRATION is zero on both axes and equals the shipped default config', () => {
    // CATCHES the one hazard of config.ts holding its own copy of this literal
    // (it must, to avoid a runtime import cycle): the two drifting apart.
    expect(IDENTITY_TILT_CALIBRATION).toEqual({ betaZero: 0, gammaZero: 0 })
    expect(DEFAULT_CONTROL_CONFIG.tiltCalibration).toEqual(IDENTITY_TILT_CALIBRATION)
  })

  it('calibrateTilt records the held sample as the new zero', () => {
    // CATCHES swapping beta and gamma, which points steering at the pitch axis and
    // makes the game unplayable in exactly the way nobody debugs quickly.
    expect(calibrateTilt({ alpha: 33, beta: 12, gamma: -7 })).toEqual({ betaZero: 12, gammaZero: -7 })
  })
})

describe('tilt steering', () => {
  it('maps gamma to a full-lock axis over tiltRangeDegrees', () => {
    // CATCHES a wrong range constant or a degrees/radians mix-up: at gamma = 25
    // with tiltRangeDegrees 25 the axis is exactly 1, and the smoother converges
    // to it. First tick is the exact lerp value, 0.35.
    const a = makeTiltAdapter(DEFAULT_CONTROL_CONFIG)
    const raw = makeControlInputsFixture({ tilt: { alpha: 0, beta: 0, gamma: 25 } })
    const out = poisonedIntent()
    step(a, raw, 0, out)
    expect(out.steer).toBeCloseTo(0.35, 9)
    settle(a, raw, out)
    expect(out.steer).toBeGreaterThan(0.999)
  })

  it('is proportional in between and clamps beyond full lock', () => {
    const half = makeTiltAdapter(DEFAULT_CONTROL_CONFIG)
    const rawHalf = makeControlInputsFixture({ tilt: { alpha: 0, beta: 0, gamma: -12.5 } })
    const outHalf = poisonedIntent()
    settle(half, rawHalf, outHalf)
    expect(outHalf.steer).toBeCloseTo(-0.5, 3)

    const past = makeTiltAdapter(DEFAULT_CONTROL_CONFIG)
    const rawPast = makeControlInputsFixture({ tilt: { alpha: 0, beta: 0, gamma: 400 } })
    const outPast = poisonedIntent()
    settle(past, rawPast, outPast)
    expect(outPast.steer).toBeLessThanOrEqual(1)
    expect(outPast.steer).toBeGreaterThan(0.999)
  })

  it('measures gamma from the calibration zero, not from zero degrees', () => {
    // CATCHES ignoring the calibration. A player who calibrated at gamma = -8 is
    // holding the phone level; without the offset the kart steers permanently left
    // and the calibration flow is decoration.
    const cfg = withCfg({ tiltCalibration: calibrateTilt({ alpha: 0, beta: 10, gamma: -8 }) })
    const a = makeTiltAdapter(cfg)
    const raw = makeControlInputsFixture({ tilt: { alpha: 0, beta: 10, gamma: -8 } })
    const out = poisonedIntent()
    settle(a, raw, out)
    expect(out.steer).toBe(0)

    const b = makeTiltAdapter(cfg)
    const rawB = makeControlInputsFixture({ tilt: { alpha: 0, beta: 10, gamma: 17 } })
    const outB = poisonedIntent()
    settle(b, rawB, outB)
    expect(outB.steer).toBeGreaterThan(0.999)
  })

  it('inverts the axis when invertTilt is set', () => {
    // CATCHES an inversion applied to the wrong side of the clamp or dropped
    // entirely - and it uses a NON-symmetric value so a sign bug cannot pass.
    const a = makeTiltAdapter(withCfg({ invertTilt: true }))
    const raw = makeControlInputsFixture({ tilt: { alpha: 0, beta: 0, gamma: 12.5 } })
    const out = poisonedIntent()
    settle(a, raw, out)
    expect(out.steer).toBeCloseTo(-0.5, 3)
  })

  it('applies the dead zone around the calibrated neutral', () => {
    // 1 degree / 25 = 0.04 (dead); 2 degrees / 25 = 0.08 (live, 0.35 of it = 0.028).
    const dead = makeTiltAdapter(DEFAULT_CONTROL_CONFIG)
    const rawDead = makeControlInputsFixture({ tilt: { alpha: 0, beta: 0, gamma: 1 } })
    const outDead = poisonedIntent()
    settle(dead, rawDead, outDead)
    expect(outDead.steer).toBe(0)

    const live = makeTiltAdapter(DEFAULT_CONTROL_CONFIG)
    const rawLive = makeControlInputsFixture({ tilt: { alpha: 0, beta: 0, gamma: 2 } })
    const outLive = poisonedIntent()
    step(live, rawLive, 0, outLive)
    expect(outLive.steer).toBeCloseTo(0.028, 9)
  })

  it('steers straight when tilt is unavailable, and writes every field of out', () => {
    // CATCHES a null dereference on the permission-denied path (Q22 leaves
    // `tilt: null` for a whole session) and a partial write of `out`.
    const a = makeTiltAdapter(DEFAULT_CONTROL_CONFIG)
    const raw = makeControlInputsFixture({ tilt: null })
    const out = poisonedIntent()
    step(a, raw, 7, out)
    expect(out).toEqual({ tick: 7, steer: 0, accel: 1, brake: false, drift: false, useItem: false })
  })

  it('decays to centre when tilt data stops arriving', () => {
    const a = makeTiltAdapter(DEFAULT_CONTROL_CONFIG)
    const raw = makeControlInputsFixture({ tilt: { alpha: 0, beta: 0, gamma: 25 } })
    const out = poisonedIntent()
    settle(a, raw, out)
    raw.tilt = null
    for (let t = 24; t < 60; t++) step(a, raw, t, out)
    expect(out.steer).toBeCloseTo(0, 6)
  })

  it('does not steer from touches: the left half is not a thumb zone here', () => {
    // CATCHES copy-paste of thumbZones' steering into the tilt adapter, which
    // would give the player two steering inputs fighting each other.
    const a = makeTiltAdapter(DEFAULT_CONTROL_CONFIG)
    const raw = makeControlInputsFixture({ tilt: null })
    const out = poisonedIntent()
    point(raw, 1, 100, 200, 'down')
    step(a, raw, 0, out)
    point(raw, 1, 380, 200, 'move')
    for (let t = 1; t <= 20; t++) step(a, raw, t, out)
    expect(out.steer).toBe(0)
  })
})

describe('tilt buttons (shared layout with thumbZones)', () => {
  it('uses the same drift and item rects and the same dead gap', () => {
    const a = makeTiltAdapter(DEFAULT_CONTROL_CONFIG)
    const raw = makeControlInputsFixture({ tilt: null })
    const out = poisonedIntent()
    point(raw, 2, 740, 340, 'down')
    step(a, raw, 0, out)
    expect(out.drift).toBe(true)
    point(raw, 2, 740, 340, 'up')
    point(raw, 3, 740, 240, 'down')
    step(a, raw, 1, out)
    expect(out.drift).toBe(false)
    expect(out.useItem).toBe(true)
    step(a, raw, 2, out)
    expect(out.useItem).toBe(false)

    point(raw, 3, 740, 240, 'up')
    point(raw, 4, 740, 288, 'down')
    step(a, raw, 3, out)
    expect(out.drift).toBe(false)
    expect(out.useItem).toBe(false)
  })

  it('brakes on a long drift press only while the phone is held level (Q21)', () => {
    // Same qualifier as thumbZones, driven by the gyro instead of a thumb: held
    // level the hold brakes, tilted to full lock it does not.
    const level = makeTiltAdapter(DEFAULT_CONTROL_CONFIG)
    const rawLevel = makeControlInputsFixture({ tilt: { alpha: 0, beta: 0, gamma: 0 } })
    const outLevel = poisonedIntent()
    point(rawLevel, 5, 740, 340, 'down')
    for (let t = 0; t < BRAKE_HOLD_TICKS - 1; t++) {
      step(level, rawLevel, t, outLevel)
      expect(outLevel.brake).toBe(false)
    }
    step(level, rawLevel, BRAKE_HOLD_TICKS - 1, outLevel)
    expect(outLevel.brake).toBe(true)
    expect(outLevel.drift).toBe(true)

    const turning = makeTiltAdapter(DEFAULT_CONTROL_CONFIG)
    const rawTurning = makeControlInputsFixture({ tilt: { alpha: 0, beta: 0, gamma: 25 } })
    const outTurning = poisonedIntent()
    point(rawTurning, 6, 740, 340, 'down')
    for (let t = 0; t < 40; t++) {
      step(turning, rawTurning, t, outTurning)
      expect(outTurning.brake).toBe(false)
    }
    expect(outTurning.steer).toBeGreaterThan(DRIFT_STEER_MIN)
    expect(outTurning.drift).toBe(true)
  })
})

describe('tilt reset and identity', () => {
  it('reports its scheme and drops every latch on reset', () => {
    const a = makeTiltAdapter(DEFAULT_CONTROL_CONFIG)
    expect(a.scheme).toBe('tilt')
    const raw = makeControlInputsFixture({ tilt: { alpha: 0, beta: 0, gamma: 25 } })
    const out = poisonedIntent()
    point(raw, 7, 740, 340, 'down')
    point(raw, 8, 740, 240, 'down')
    for (let t = 0; t < 24; t++) step(a, raw, t, out)
    expect(out.steer).toBeGreaterThan(0.99)
    expect(out.drift).toBe(true)

    a.reset()
    raw.tilt = null
    step(a, raw, 24, out)
    expect(out).toEqual({ tick: 24, steer: 0, accel: 1, brake: false, drift: false, useItem: false })
    point(raw, 9, 740, 240, 'down')
    step(a, raw, 25, out)
    expect(out.useItem).toBe(true)
  })
})
```

- [ ] **Step 10: Run the test to verify it fails**

Run: `npx vitest run packages/game/test/controls-tilt.test.ts`
Expected: FAIL with `Failed to resolve import "../src/controls/tilt" from "packages/game/test/controls-tilt.test.ts". Does the file exist?`

- [ ] **Step 11: Write `tilt.ts`**

Create `packages/game/src/controls/tilt.ts`:

```ts
import type { Intent } from '@tapkart/sim'
import { DRIFT_STEER_MIN, clamp, lerp } from '@tapkart/sim'
import type { ControlAdapter, ControlInputs, TiltSample } from './types'
import type { ControlConfig, Rect } from './config'
import { BRAKE_HOLD_TICKS, driftButtonRect, itemButtonRect, rectContains } from './config'

export interface TiltCalibration { betaZero: number; gammaZero: number } // degrees

export const IDENTITY_TILT_CALIBRATION: Readonly<TiltCalibration> = { betaZero: 0, gammaZero: 0 }

/** Pure: the sample the player held while the calibration prompt was up. */
export function calibrateTilt(sample: TiltSample): TiltCalibration {
  return { betaZero: sample.beta, gammaZero: sample.gamma }
}

/**
 * Tilt steering with the thumbZones button layout (spec §6, offered not default).
 *
 * `gamma` is roll, which is the axis a phone held in landscape rotates about when
 * the player steers. The neutral point is `cfg.tiltCalibration.gammaZero`, written
 * by `calibrateTilt` from the sample the player held during calibration - which is
 * why `cfg.tiltNeutralDegrees` is not read here: the calibration IS the neutral,
 * and adding a second offset would give one fact two owners.
 *
 * `tilt === null` (unsupported, or Q22's permission denied) steers straight. It
 * never silently falls back to another scheme: that decision belongs to the
 * settings screen, which reverts the selection and says why.
 */
export function makeTiltAdapter(cfg: ControlConfig): ControlAdapter {
  const driftRect: Rect = { x: 0, y: 0, w: 0, h: 0 }
  const itemRect: Rect = { x: 0, y: 0, w: 0, h: 0 }

  let driftId = -1
  let itemId = -1
  let driftHeldTicks = 0
  let steer = 0

  return {
    scheme: 'tilt',

    sample(raw: ControlInputs, tick: number, out: Intent): void {
      driftButtonRect(raw.viewport, driftRect)
      itemButtonRect(raw.viewport, itemRect)

      let itemPulse = false

      for (let i = 0; i < raw.pointerCount; i++) {
        const p = raw.pointers[i]
        if (p.phase === 'down') {
          if (rectContains(driftRect, p.x, p.y)) {
            if (driftId === -1) driftId = p.id
          } else if (rectContains(itemRect, p.x, p.y)) {
            if (itemId === -1) {
              itemId = p.id
              itemPulse = true
            }
          }
          // No steering zone in this scheme, and the gap belongs to neither button.
        } else if (p.phase === 'up') {
          if (p.id === driftId) driftId = -1
          if (p.id === itemId) itemId = -1
        }
      }

      let axis = 0
      if (raw.tilt !== null && cfg.tiltRangeDegrees > 0) {
        axis = clamp((raw.tilt.gamma - cfg.tiltCalibration.gammaZero) / cfg.tiltRangeDegrees, -1, 1)
        if (cfg.invertTilt) axis = -axis
      }
      if (Math.abs(axis) < cfg.deadZone) axis = 0
      const target = clamp(axis * cfg.steerGain, -1, 1)
      steer = clamp(lerp(steer, target, cfg.steerSmoothingPerTick), -1, 1)

      const drift = driftId !== -1
      driftHeldTicks = drift ? driftHeldTicks + 1 : 0

      out.tick = tick
      out.steer = steer
      out.accel = 1
      out.brake = driftHeldTicks >= BRAKE_HOLD_TICKS && Math.abs(steer) < DRIFT_STEER_MIN
      out.drift = drift
      out.useItem = itemPulse
    },

    reset(): void {
      driftId = -1
      itemId = -1
      driftHeldTicks = 0
      steer = 0
    },
  }
}
```

- [ ] **Step 12: Run the test to verify it passes**

Run: `npx vitest run packages/game/test/controls-tilt.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 13: Write the failing test for `stick.ts`**

Create `packages/game/test/controls-stick.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import type { Intent } from '@tapkart/sim'
import type { ControlInputs, PointerPhase } from '../src/controls/types'
import { DEFAULT_CONTROL_CONFIG } from '../src/controls/config'
import { makeVirtualStickAdapter } from '../src/controls/stick'
import { makeControlInputsFixture } from './fixtures/game-fixtures'

// 800x400, so the four buttons are a 2x2 cluster in the bottom-right corner:
//   gas   [592,680) x [296,384)      drift [696,784) x [296,384)
//   brake [592,680) x [192,280)      item  [696,784) x [192,280)
// with 16 px of dead space on both axes between them.
const GAS = { x: 636, y: 340 }
const BRAKE = { x: 636, y: 236 }
const DRIFT = { x: 740, y: 340 }
const ITEM = { x: 740, y: 236 }
const LOCK_PX = 112

function poisonedIntent(): Intent {
  return { tick: -999, steer: 999, accel: -999, brake: true, drift: true, useItem: true }
}

function point(raw: ControlInputs, id: number, x: number, y: number, phase: PointerPhase): void {
  const p = raw.pointers[raw.pointerCount]
  p.id = id
  p.x = x
  p.y = y
  p.phase = phase
  raw.pointerCount++
}

function step(a: ReturnType<typeof makeVirtualStickAdapter>, raw: ControlInputs,
              tick: number, out: Intent): void {
  a.sample(raw, tick, out)
  raw.pointerCount = 0
}

describe('virtualStick pedals', () => {
  it('does NOT auto-accelerate: no gas button, no throttle', () => {
    // CATCHES the copy-paste from thumbZones/tilt, where accel is hard-wired to 1.
    // Under that bug this scheme's gas pedal does nothing and the kart never stops.
    const a = makeVirtualStickAdapter(DEFAULT_CONTROL_CONFIG)
    const raw = makeControlInputsFixture()
    const out = poisonedIntent()
    step(a, raw, 3, out)
    expect(out).toEqual({ tick: 3, steer: 0, accel: 0, brake: false, drift: false, useItem: false })
  })

  it('accelerates while the gas button is held and stops when it lifts', () => {
    const a = makeVirtualStickAdapter(DEFAULT_CONTROL_CONFIG)
    const raw = makeControlInputsFixture()
    const out = poisonedIntent()
    point(raw, 1, GAS.x, GAS.y, 'down')
    step(a, raw, 0, out)
    expect(out.accel).toBe(1)
    step(a, raw, 1, out)
    expect(out.accel).toBe(1)
    point(raw, 1, GAS.x, GAS.y, 'up')
    step(a, raw, 2, out)
    expect(out.accel).toBe(0)
  })

  it('brakes on the press, with no hold threshold', () => {
    // CATCHES the long-press brake leaking into this scheme. virtualStick has an
    // explicit brake pedal (contract §5.5 table), so a threshold here would make
    // the pedal feel broken for its first 0.3 s.
    const a = makeVirtualStickAdapter(DEFAULT_CONTROL_CONFIG)
    const raw = makeControlInputsFixture()
    const out = poisonedIntent()
    point(raw, 2, BRAKE.x, BRAKE.y, 'down')
    step(a, raw, 0, out)
    expect(out.brake).toBe(true)
    expect(out.drift).toBe(false)
    point(raw, 2, BRAKE.x, BRAKE.y, 'up')
    step(a, raw, 1, out)
    expect(out.brake).toBe(false)
  })

  it('never turns a long drift hold into a brake', () => {
    // CATCHES the Q21 rule being applied to the wrong scheme. 40 straight-line
    // ticks is well past BRAKE_HOLD_TICKS; brake must stay false throughout.
    const a = makeVirtualStickAdapter(DEFAULT_CONTROL_CONFIG)
    const raw = makeControlInputsFixture()
    const out = poisonedIntent()
    point(raw, 3, DRIFT.x, DRIFT.y, 'down')
    for (let t = 0; t < 40; t++) {
      step(a, raw, t, out)
      expect(out.drift).toBe(true)
      expect(out.brake).toBe(false)
    }
  })

  it('fires useItem on exactly one tick per press', () => {
    const a = makeVirtualStickAdapter(DEFAULT_CONTROL_CONFIG)
    const raw = makeControlInputsFixture()
    const out = poisonedIntent()
    const fired: number[] = []
    point(raw, 4, ITEM.x, ITEM.y, 'down')
    for (let t = 0; t <= 4; t++) {
      step(a, raw, t, out)
      if (out.useItem) fired.push(t)
    }
    point(raw, 4, ITEM.x, ITEM.y, 'up')
    step(a, raw, 5, out)
    point(raw, 4, ITEM.x, ITEM.y, 'down')
    step(a, raw, 6, out)
    if (out.useItem) fired.push(6)
    expect(fired).toEqual([0, 6])
  })

  it('holds all four controls at once', () => {
    // CATCHES a router that claims one pointer per frame, or that lets a later
    // button overwrite an earlier one - a stick player holds gas and drift together
    // for the whole race.
    const a = makeVirtualStickAdapter(DEFAULT_CONTROL_CONFIG)
    const raw = makeControlInputsFixture()
    const out = poisonedIntent()
    point(raw, 5, GAS.x, GAS.y, 'down')
    point(raw, 6, DRIFT.x, DRIFT.y, 'down')
    point(raw, 7, ITEM.x, ITEM.y, 'down')
    point(raw, 8, BRAKE.x, BRAKE.y, 'down')
    step(a, raw, 0, out)
    expect(out.accel).toBe(1)
    expect(out.drift).toBe(true)
    expect(out.brake).toBe(true)
    expect(out.useItem).toBe(true)
  })

  it('leaves dead space between the buttons on both axes', () => {
    // CATCHES a cluster laid out with no gaps, where a thumb between gas and drift
    // fires one of them at random. x in [680,696) and y in [280,296) are dead.
    const a = makeVirtualStickAdapter(DEFAULT_CONTROL_CONFIG)
    const raw = makeControlInputsFixture()
    const out = poisonedIntent()
    for (const p of [{ x: 688, y: 340 }, { x: 740, y: 288 }, { x: 688, y: 288 }]) {
      a.reset()
      point(raw, 9, p.x, p.y, 'down')
      step(a, raw, 0, out)
      expect(out.accel).toBe(0)
      expect(out.brake).toBe(false)
      expect(out.drift).toBe(false)
      expect(out.useItem).toBe(false)
    }
  })
})

describe('virtualStick steering', () => {
  it('takes its origin from the touch-down point, like thumbZones', () => {
    // CATCHES an absolute stick, where planting a thumb at the left edge is
    // instant full lock.
    const a = makeVirtualStickAdapter(DEFAULT_CONTROL_CONFIG)
    const raw = makeControlInputsFixture()
    const out = poisonedIntent()
    point(raw, 10, 40, 300, 'down')
    step(a, raw, 0, out)
    expect(out.steer).toBe(0)
    for (let t = 1; t <= 5; t++) {
      step(a, raw, t, out)
      expect(out.steer).toBe(0)
    }
  })

  it('reaches full lock 28 % of a half-width from the origin', () => {
    const a = makeVirtualStickAdapter(DEFAULT_CONTROL_CONFIG)
    const raw = makeControlInputsFixture()
    const out = poisonedIntent()
    point(raw, 11, 200, 300, 'down')
    step(a, raw, 0, out)
    point(raw, 11, 200 - LOCK_PX, 300, 'move')
    step(a, raw, 1, out)
    expect(out.steer).toBeCloseTo(-0.35, 9)
    for (let t = 2; t <= 24; t++) step(a, raw, t, out)
    expect(out.steer).toBeLessThan(-0.999)
    expect(out.steer).toBeGreaterThanOrEqual(-1)
  })

  it('does not let a pedal touch steer', () => {
    const a = makeVirtualStickAdapter(DEFAULT_CONTROL_CONFIG)
    const raw = makeControlInputsFixture()
    const out = poisonedIntent()
    point(raw, 12, GAS.x, GAS.y, 'down')
    step(a, raw, 0, out)
    point(raw, 12, 100, 300, 'move')
    for (let t = 1; t <= 10; t++) step(a, raw, t, out)
    expect(out.steer).toBe(0)
    expect(out.accel).toBe(1)
  })
})

describe('virtualStick reset and identity', () => {
  it('reports its scheme and drops every latch', () => {
    const a = makeVirtualStickAdapter(DEFAULT_CONTROL_CONFIG)
    expect(a.scheme).toBe('virtualStick')
    const raw = makeControlInputsFixture()
    const out = poisonedIntent()
    point(raw, 13, 200, 300, 'down')
    point(raw, 14, GAS.x, GAS.y, 'down')
    point(raw, 15, ITEM.x, ITEM.y, 'down')
    step(a, raw, 0, out)
    point(raw, 13, 200 + LOCK_PX, 300, 'move')
    for (let t = 1; t <= 20; t++) step(a, raw, t, out)
    expect(out.steer).toBeGreaterThan(0.99)
    expect(out.accel).toBe(1)

    a.reset()
    step(a, raw, 21, out)
    expect(out).toEqual({ tick: 21, steer: 0, accel: 0, brake: false, drift: false, useItem: false })
    point(raw, 16, ITEM.x, ITEM.y, 'down')
    step(a, raw, 22, out)
    expect(out.useItem).toBe(true)
  })
})
```

- [ ] **Step 14: Run the test to verify it fails**

Run: `npx vitest run packages/game/test/controls-stick.test.ts`
Expected: FAIL with `Failed to resolve import "../src/controls/stick" from "packages/game/test/controls-stick.test.ts". Does the file exist?`

- [ ] **Step 15: Write `stick.ts`**

Create `packages/game/src/controls/stick.ts`:

```ts
import type { Intent } from '@tapkart/sim'
import { clamp, lerp } from '@tapkart/sim'
import type { ControlAdapter, ControlInputs, Viewport } from './types'
import type { ControlConfig, Rect } from './config'
import {
  THUMBZONE_FULL_LOCK_FRACTION,
  TOUCH_BUTTON_GAP_PX,
  TOUCH_BUTTON_SIZE_PX,
  driftButtonRect,
  itemButtonRect,
  rectContains,
} from './config'

/**
 * Gas: one column left of the drift button, same row. Not exported - only this
 * scheme has pedals, and §5.5 exports rects only for the two buttons thumbZones and
 * tilt share. Derived from the same constants, so the cluster cannot disagree with
 * the shared layout by a pixel.
 */
function gasButtonRect(v: Viewport, out: Rect): void {
  driftButtonRect(v, out)
  out.x -= TOUCH_BUTTON_GAP_PX + TOUCH_BUTTON_SIZE_PX
}

/** Brake: one column left of the item button, same row. */
function brakeButtonRect(v: Viewport, out: Rect): void {
  itemButtonRect(v, out)
  out.x -= TOUCH_BUTTON_GAP_PX + TOUCH_BUTTON_SIZE_PX
}

/**
 * Virtual stick + pedals (spec §6: "most control, most screen occlusion").
 *
 * The stick is the left half, relative to touch-down, normalised exactly as
 * thumbZones is. The right half is a 2x2 pedal cluster - gas and drift on the
 * bottom row, brake and item above them - with dead space on both axes.
 *
 * This scheme has an explicit brake pedal, so Q21's drift long-press does NOT
 * apply: a long drift hold here is a drift and nothing else.
 */
export function makeVirtualStickAdapter(cfg: ControlConfig): ControlAdapter {
  const driftRect: Rect = { x: 0, y: 0, w: 0, h: 0 }
  const itemRect: Rect = { x: 0, y: 0, w: 0, h: 0 }
  const gasRect: Rect = { x: 0, y: 0, w: 0, h: 0 }
  const brakeRect: Rect = { x: 0, y: 0, w: 0, h: 0 }

  let stickId = -1
  let gasId = -1
  let brakeId = -1
  let driftId = -1
  let itemId = -1
  let originX = 0
  let currentX = 0
  let steer = 0

  function steerAxis(v: Viewport): number {
    if (stickId === -1) return 0
    const lockPx = v.width * 0.5 * THUMBZONE_FULL_LOCK_FRACTION
    if (!(lockPx > 0)) return 0
    return clamp((currentX - originX) / lockPx, -1, 1)
  }

  return {
    scheme: 'virtualStick',

    sample(raw: ControlInputs, tick: number, out: Intent): void {
      driftButtonRect(raw.viewport, driftRect)
      itemButtonRect(raw.viewport, itemRect)
      gasButtonRect(raw.viewport, gasRect)
      brakeButtonRect(raw.viewport, brakeRect)

      let itemPulse = false

      for (let i = 0; i < raw.pointerCount; i++) {
        const p = raw.pointers[i]
        if (p.phase === 'down') {
          if (rectContains(driftRect, p.x, p.y)) {
            if (driftId === -1) driftId = p.id
          } else if (rectContains(itemRect, p.x, p.y)) {
            if (itemId === -1) {
              itemId = p.id
              itemPulse = true
            }
          } else if (rectContains(gasRect, p.x, p.y)) {
            if (gasId === -1) gasId = p.id
          } else if (rectContains(brakeRect, p.x, p.y)) {
            if (brakeId === -1) brakeId = p.id
          } else if (stickId === -1 && p.x < raw.viewport.width * 0.5) {
            stickId = p.id
            originX = p.x
            currentX = p.x
          }
        } else if (p.phase === 'move') {
          if (p.id === stickId) currentX = p.x
        } else {
          if (p.id === stickId) stickId = -1
          if (p.id === gasId) gasId = -1
          if (p.id === brakeId) brakeId = -1
          if (p.id === driftId) driftId = -1
          if (p.id === itemId) itemId = -1
        }
      }

      let axis = steerAxis(raw.viewport)
      if (Math.abs(axis) < cfg.deadZone) axis = 0
      const target = clamp(axis * cfg.steerGain, -1, 1)
      steer = clamp(lerp(steer, target, cfg.steerSmoothingPerTick), -1, 1)

      out.tick = tick
      out.steer = steer
      out.accel = gasId !== -1 ? 1 : 0
      out.brake = brakeId !== -1
      out.drift = driftId !== -1
      out.useItem = itemPulse
    },

    reset(): void {
      stickId = -1
      gasId = -1
      brakeId = -1
      driftId = -1
      itemId = -1
      originX = 0
      currentX = 0
      steer = 0
    },
  }
}
```

- [ ] **Step 16: Run the test to verify it passes**

Run: `npx vitest run packages/game/test/controls-stick.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 17: Write the failing test for `keyboard.ts`**

Create `packages/game/test/controls-keyboard.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import type { Intent } from '@tapkart/sim'
import type { ControlInputs } from '../src/controls/types'
import { DEFAULT_CONTROL_CONFIG } from '../src/controls/config'
import { makeKeyboardAdapter } from '../src/controls/keyboard'
import { makeControlInputsFixture } from './fixtures/game-fixtures'

function poisonedIntent(): Intent {
  return { tick: -999, steer: 999, accel: -999, brake: true, drift: true, useItem: true }
}

function withKeys(...codes: string[]): ControlInputs {
  const keys: Record<string, boolean> = {}
  for (const c of codes) keys[c] = true
  return makeControlInputsFixture({ keys })
}

describe('keyboard adapter', () => {
  it('reports nothing pressed and writes every field of out', () => {
    const a = makeKeyboardAdapter(DEFAULT_CONTROL_CONFIG)
    const out = poisonedIntent()
    a.sample(withKeys(), 11, out)
    expect(out).toEqual({ tick: 11, steer: 0, accel: 0, brake: false, drift: false, useItem: false })
  })

  it('steers from the arrow keys and smooths at the same rate as touch', () => {
    // CATCHES an unsmoothed keyboard, which would make the merge rule
    // (greater |steer| wins) resolve to the keyboard on the first tick of every
    // touch input, because touch starts at 0.35 and a raw keyboard would be 1.
    const a = makeKeyboardAdapter(DEFAULT_CONTROL_CONFIG)
    const out = poisonedIntent()
    const raw = withKeys('ArrowLeft')
    a.sample(raw, 0, out)
    expect(out.steer).toBeCloseTo(-0.35, 9)
    a.sample(raw, 1, out)
    expect(out.steer).toBeCloseTo(-0.5775, 9)
    for (let t = 2; t < 30; t++) a.sample(raw, t, out)
    expect(out.steer).toBeLessThan(-0.999)
    expect(out.steer).toBeGreaterThanOrEqual(-1)
  })

  it('cancels to zero when both directions are held', () => {
    // CATCHES a "last key wins" implementation, which sticks at full lock when a
    // player rolls from one arrow to the other.
    const a = makeKeyboardAdapter(DEFAULT_CONTROL_CONFIG)
    const out = poisonedIntent()
    const raw = withKeys('ArrowLeft', 'ArrowRight')
    for (let t = 0; t < 10; t++) a.sample(raw, t, out)
    expect(out.steer).toBe(0)
  })

  it('honours every alternate binding in the default table', () => {
    // CATCHES a hard-coded arrow-key reader that ignores cfg.keyBindings; WASD is
    // half the desktop players and would silently do nothing.
    const a = makeKeyboardAdapter(DEFAULT_CONTROL_CONFIG)
    const out = poisonedIntent()
    a.sample(withKeys('KeyA'), 0, out)
    expect(out.steer).toBeCloseTo(-0.35, 9)

    const b = makeKeyboardAdapter(DEFAULT_CONTROL_CONFIG)
    b.sample(withKeys('KeyD'), 0, out)
    expect(out.steer).toBeCloseTo(0.35, 9)

    const c = makeKeyboardAdapter(DEFAULT_CONTROL_CONFIG)
    c.sample(withKeys('KeyW'), 0, out)
    expect(out.accel).toBe(1)
    c.sample(withKeys('ArrowUp'), 1, out)
    expect(out.accel).toBe(1)

    const d = makeKeyboardAdapter(DEFAULT_CONTROL_CONFIG)
    d.sample(withKeys('KeyS'), 0, out)
    expect(out.brake).toBe(true)
    d.sample(withKeys('ArrowDown'), 1, out)
    expect(out.brake).toBe(true)

    const e = makeKeyboardAdapter(DEFAULT_CONTROL_CONFIG)
    e.sample(withKeys('Space'), 0, out)
    expect(out.drift).toBe(true)
    e.sample(withKeys('ShiftLeft'), 1, out)
    expect(out.drift).toBe(true)

    const f = makeKeyboardAdapter(DEFAULT_CONTROL_CONFIG)
    f.sample(withKeys('ControlLeft'), 0, out)
    expect(out.useItem).toBe(true)
  })

  it('respects a custom binding table', () => {
    const a = makeKeyboardAdapter({
      ...DEFAULT_CONTROL_CONFIG,
      keyBindings: { KeyJ: 'left', KeyL: 'right', KeyI: 'accel' },
    })
    const out = poisonedIntent()
    a.sample(withKeys('KeyJ', 'KeyI'), 0, out)
    expect(out.steer).toBeCloseTo(-0.35, 9)
    expect(out.accel).toBe(1)
    // ArrowLeft is unbound in this table, so the target is 0 and the smoothed
    // -0.35 decays to lerp(-0.35, 0, 0.35) = -0.2275. Under a hard-coded arrow
    // reader it would instead deepen to -0.5775.
    a.sample(withKeys('ArrowLeft'), 1, out)
    expect(out.steer).toBeCloseTo(-0.2275, 9)
    expect(out.accel).toBe(0)
  })

  it('ignores unbound keys and keys explicitly reported as up', () => {
    // CATCHES `if (raw.keys[code] !== undefined)`, which treats a keyup-recorded
    // `false` as a press - so every key ever touched stays down for the session.
    const a = makeKeyboardAdapter(DEFAULT_CONTROL_CONFIG)
    const out = poisonedIntent()
    a.sample(makeControlInputsFixture({ keys: { KeyQ: true, ArrowLeft: false, KeyW: false } }), 0, out)
    expect(out.steer).toBe(0)
    expect(out.accel).toBe(0)
  })

  it('fires useItem on exactly one tick per press (Q25)', () => {
    // Held for four ticks, released, pressed again: a level implementation reports
    // true five times, this asserts exactly two.
    const a = makeKeyboardAdapter(DEFAULT_CONTROL_CONFIG)
    const out = poisonedIntent()
    const held = withKeys('KeyE')
    const idle = withKeys()
    const fired: number[] = []
    for (let t = 0; t <= 3; t++) {
      a.sample(held, t, out)
      if (out.useItem) fired.push(t)
    }
    a.sample(idle, 4, out)
    if (out.useItem) fired.push(4)
    a.sample(held, 5, out)
    if (out.useItem) fired.push(5)
    expect(fired).toEqual([0, 5])
  })

  it('reports its scheme and drops the smoothing and item latch on reset', () => {
    // The keyboard adapter is always the composite's secondary, so its scheme is
    // never the one the player selected; thumbZones is the harmless default.
    const a = makeKeyboardAdapter(DEFAULT_CONTROL_CONFIG)
    expect(a.scheme).toBe('thumbZones')
    const out = poisonedIntent()
    const held = withKeys('ArrowLeft', 'KeyE')
    for (let t = 0; t < 20; t++) a.sample(held, t, out)
    expect(out.steer).toBeLessThan(-0.99)
    expect(out.useItem).toBe(false)

    a.reset()
    a.sample(held, 20, out)
    expect(out.steer).toBeCloseTo(-0.35, 9)
    expect(out.useItem).toBe(true)
  })
})
```

- [ ] **Step 18: Run the test to verify it fails**

Run: `npx vitest run packages/game/test/controls-keyboard.test.ts`
Expected: FAIL with `Failed to resolve import "../src/controls/keyboard" from "packages/game/test/controls-keyboard.test.ts". Does the file exist?`

- [ ] **Step 19: Write `keyboard.ts`**

Create `packages/game/src/controls/keyboard.ts`:

```ts
import type { Intent } from '@tapkart/sim'
import { clamp, lerp } from '@tapkart/sim'
import type { ControlAdapter, ControlInputs } from './types'
import type { ControlConfig } from './config'

/**
 * Keyboard, merged into every scheme by makeCompositeAdapter (Q23). Spec §6 says
 * keyboard is *always* available on desktop, and "always" is not "instead of".
 *
 * `scheme` is 'thumbZones' because this adapter is never the one the player
 * selected: the composite reports its PRIMARY's scheme, and this adapter is always
 * the secondary. On a phone no key is ever down and every field below is inert.
 *
 * The binding table is inverted ONCE, at construction, into six code lists - the
 * per-tick path must not call Object.keys (§7.3: no allocation per tick).
 */
export function makeKeyboardAdapter(cfg: ControlConfig): ControlAdapter {
  const left: string[] = []
  const right: string[] = []
  const accel: string[] = []
  const brake: string[] = []
  const drift: string[] = []
  const item: string[] = []

  for (const code of Object.keys(cfg.keyBindings)) {
    switch (cfg.keyBindings[code]) {
      case 'left': left.push(code); break
      case 'right': right.push(code); break
      case 'accel': accel.push(code); break
      case 'brake': brake.push(code); break
      case 'drift': drift.push(code); break
      case 'item': item.push(code); break
    }
  }

  function anyDown(raw: ControlInputs, codes: string[]): boolean {
    for (let i = 0; i < codes.length; i++) {
      if (raw.keys[codes[i]] === true) return true
    }
    return false
  }

  let steer = 0
  let itemHeld = false

  return {
    scheme: 'thumbZones',

    sample(raw: ControlInputs, tick: number, out: Intent): void {
      const leftDown = anyDown(raw, left)
      const rightDown = anyDown(raw, right)
      const itemDown = anyDown(raw, item)

      let axis = (rightDown ? 1 : 0) - (leftDown ? 1 : 0)
      if (Math.abs(axis) < cfg.deadZone) axis = 0
      const target = clamp(axis * cfg.steerGain, -1, 1)
      steer = clamp(lerp(steer, target, cfg.steerSmoothingPerTick), -1, 1)

      out.tick = tick
      out.steer = steer
      out.accel = anyDown(raw, accel) ? 1 : 0
      out.brake = anyDown(raw, brake)
      out.drift = anyDown(raw, drift)
      out.useItem = itemDown && !itemHeld // Q25: the press edge, not the level
      itemHeld = itemDown
    },

    reset(): void {
      steer = 0
      itemHeld = false
    },
  }
}
```

- [ ] **Step 20: Run the test to verify it passes**

Run: `npx vitest run packages/game/test/controls-keyboard.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 21: Write the failing test for `composite.ts` and `index.ts`**

Create `packages/game/test/controls-composite.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import type { Intent } from '@tapkart/sim'
import type { ControlAdapter, ControlInputs, ControlScheme } from '../src/controls/types'
import { DEFAULT_CONTROL_CONFIG } from '../src/controls/config'
import { makeCompositeAdapter, mergeIntents } from '../src/controls/composite'
import { makeControlAdapter } from '../src/controls/index'
import { makeControlInputsFixture } from './fixtures/game-fixtures'

function intent(o: Partial<Intent>): Intent {
  return { tick: 0, steer: 0, accel: 0, brake: false, drift: false, useItem: false, ...o }
}

function poisonedIntent(): Intent {
  return { tick: -999, steer: 999, accel: -999, brake: true, drift: true, useItem: true }
}

/** Records what it was handed, so the composite's scratch discipline is testable.
 *  `log` is a separate object rather than a self-reference, because an object
 *  literal whose method reads the const it is initialising infers `any` (TS7022). */
function spyAdapter(scheme: ControlScheme, write: Partial<Intent>): ControlAdapter & {
  log: { outs: Intent[]; resets: number }
} {
  const log = { outs: [] as Intent[], resets: 0 }
  return {
    scheme,
    log,
    sample(_raw: ControlInputs, tick: number, out: Intent): void {
      if (!log.outs.includes(out)) log.outs.push(out)
      out.tick = tick
      out.steer = write.steer ?? 0
      out.accel = write.accel ?? 0
      out.brake = write.brake ?? false
      out.drift = write.drift ?? false
      out.useItem = write.useItem ?? false
    },
    reset(): void {
      log.resets++
    },
  }
}

describe('mergeIntents (Q23)', () => {
  it('gives steer to the greater absolute magnitude, as a table', () => {
    // Every row uses DIFFERENT magnitudes on the two sides, except the two tie rows
    // where the sign differs. A row where both sides agree would prove nothing
    // about the rule - it is satisfied by "return touch" and by "return keyboard".
    const rows: { touch: number; kb: number; want: number }[] = [
      { touch: 0.9, kb: -0.5, want: 0.9 },
      { touch: -0.2, kb: 0.6, want: 0.6 },
      { touch: 0.1, kb: 0, want: 0.1 },
      { touch: 0, kb: -0.4, want: -0.4 },
      { touch: 0.5, kb: -0.5, want: -0.5 }, // tie -> keyboard
      { touch: -0.7, kb: 0.7, want: 0.7 }, // tie -> keyboard
      { touch: 0, kb: 0, want: 0 },
      { touch: -1, kb: 0.99, want: -1 },
    ]
    const out = poisonedIntent()
    for (const r of rows) {
      mergeIntents(intent({ steer: r.touch }), intent({ steer: r.kb }), out)
      expect(out.steer).toBe(r.want)
    }
  })

  it('takes the maximum accel', () => {
    // CATCHES a sum (which exceeds 1) and "keyboard wins" (which zeroes the throttle
    // of every auto-accelerate scheme the moment a desktop player touches a key).
    const out = poisonedIntent()
    const rows: [number, number, number][] = [
      [1, 0, 1],
      [0, 1, 1],
      [0.3, 0.7, 0.7],
      [0.7, 0.3, 0.7],
      [0, 0, 0],
    ]
    for (const [touch, kb, want] of rows) {
      mergeIntents(intent({ accel: touch }), intent({ accel: kb }), out)
      expect(out.accel).toBe(want)
    }
  })

  it('ORs brake, drift and useItem across all four combinations each', () => {
    // CATCHES an AND, and a merge that reads only one side. All four rows per field.
    const out = poisonedIntent()
    for (const [t, k] of [[false, false], [true, false], [false, true], [true, true]] as [boolean, boolean][]) {
      mergeIntents(intent({ brake: t }), intent({ brake: k }), out)
      expect(out.brake).toBe(t || k)
      mergeIntents(intent({ drift: t }), intent({ drift: k }), out)
      expect(out.drift).toBe(t || k)
      mergeIntents(intent({ useItem: t }), intent({ useItem: k }), out)
      expect(out.useItem).toBe(t || k)
    }
  })

  it('writes every field of out, leaving nothing from a previous merge', () => {
    const out = poisonedIntent()
    mergeIntents(intent({ tick: 5 }), intent({ tick: 5 }), out)
    expect(out).toEqual({ tick: 5, steer: 0, accel: 0, brake: false, drift: false, useItem: false })
  })

  it('takes tick from the keyboard side, the same side that wins steer ties', () => {
    const out = poisonedIntent()
    mergeIntents(intent({ tick: 5 }), intent({ tick: 7 }), out)
    expect(out.tick).toBe(7)
  })
})

describe('makeCompositeAdapter (Q23)', () => {
  it('reports the primary scheme and merges both sub-adapters', () => {
    const touch = spyAdapter('virtualStick', { steer: 0.2, accel: 1, drift: true })
    const kb = spyAdapter('thumbZones', { steer: -0.8, brake: true, useItem: true })
    const c = makeCompositeAdapter(touch, kb)
    const out = poisonedIntent()
    c.sample(makeControlInputsFixture(), 9, out)
    expect(c.scheme).toBe('virtualStick')
    expect(out).toEqual({ tick: 9, steer: -0.8, accel: 1, brake: true, drift: true, useItem: true })
  })

  it('never hands `out` to a sub-adapter: each gets its own scratch Intent', () => {
    // THE SOLE-WRITER TEST (§7.2). If the composite passes `out` down, the last
    // sub-adapter to run silently becomes the writer of the Intent the session
    // submits, and the merge rule stops existing - while every value-based test
    // above still passes, because the last writer happens to be the keyboard.
    const touch = spyAdapter('tilt', { steer: 0.5 })
    const kb = spyAdapter('thumbZones', { steer: -0.25 })
    const c = makeCompositeAdapter(touch, kb)
    const out = poisonedIntent()
    c.sample(makeControlInputsFixture(), 1, out)
    c.sample(makeControlInputsFixture(), 2, out)
    expect(touch.log.outs).toHaveLength(1)
    expect(kb.log.outs).toHaveLength(1)
    expect(touch.log.outs[0]).not.toBe(out)
    expect(kb.log.outs[0]).not.toBe(out)
    expect(touch.log.outs[0]).not.toBe(kb.log.outs[0])
    expect(out.steer).toBe(0.5)
  })

  it('resets both sub-adapters', () => {
    const touch = spyAdapter('tilt', {})
    const kb = spyAdapter('thumbZones', {})
    const c = makeCompositeAdapter(touch, kb)
    c.reset()
    expect(touch.log.resets).toBe(1)
    expect(kb.log.resets).toBe(1)
  })
})

describe('makeControlAdapter', () => {
  it('reports the requested scheme for all three', () => {
    for (const s of ['thumbZones', 'tilt', 'virtualStick'] as ControlScheme[]) {
      expect(makeControlAdapter(s, DEFAULT_CONTROL_CONFIG).scheme).toBe(s)
    }
  })

  it('merges the keyboard into every scheme, on every platform', () => {
    // CATCHES makeControlAdapter returning the bare touch adapter. Each assertion
    // is chosen so the touch adapter alone CANNOT produce it: thumbZones and tilt
    // have no drift key and no steering keys, and virtualStick's accel is 0 unless
    // its gas button is down.
    const tz = makeControlAdapter('thumbZones', DEFAULT_CONTROL_CONFIG)
    const outTz = poisonedIntent()
    tz.sample(makeControlInputsFixture({ keys: { ShiftLeft: true } }), 0, outTz)
    expect(outTz.drift).toBe(true)

    const tilt = makeControlAdapter('tilt', DEFAULT_CONTROL_CONFIG)
    const outTilt = poisonedIntent()
    tilt.sample(makeControlInputsFixture({ keys: { ArrowLeft: true } }), 0, outTilt)
    expect(outTilt.steer).toBeCloseTo(-0.35, 9)

    const stick = makeControlAdapter('virtualStick', DEFAULT_CONTROL_CONFIG)
    const outStick = poisonedIntent()
    stick.sample(makeControlInputsFixture({ keys: { KeyW: true } }), 0, outStick)
    expect(outStick.accel).toBe(1)
  })

  it('lets the larger input win, in both directions, over a real touch session', () => {
    // The integration case the unit table cannot cover: both sides are live and
    // smoothing moves them past each other. Touch settles at half lock (0.5); the
    // keyboard then ramps 0.35 -> 0.5775 and takes over on the second tick.
    const a = makeControlAdapter('thumbZones', DEFAULT_CONTROL_CONFIG)
    const raw = makeControlInputsFixture()
    const out = poisonedIntent()
    const p = raw.pointers[0]
    p.id = 1
    p.x = 200
    p.y = 200
    p.phase = 'down'
    raw.pointerCount = 1
    a.sample(raw, 0, out)
    raw.pointerCount = 0

    p.x = 256 // +56 px = half of the 112 px full-lock distance
    p.phase = 'move'
    raw.pointerCount = 1
    for (let t = 1; t <= 24; t++) {
      a.sample(raw, t, out)
      raw.pointerCount = 0
    }
    expect(out.steer).toBeCloseTo(0.5, 3)

    raw.keys.ArrowLeft = true
    a.sample(raw, 25, out)
    expect(out.steer).toBeGreaterThan(0.4) // touch still larger: |0.4999| > |-0.35|
    a.sample(raw, 26, out)
    expect(out.steer).toBeCloseTo(-0.5775, 9) // keyboard now larger
  })
})
```

- [ ] **Step 22: Run the test to verify it fails**

Run: `npx vitest run packages/game/test/controls-composite.test.ts`
Expected: FAIL with `Failed to resolve import "../src/controls/composite" from "packages/game/test/controls-composite.test.ts". Does the file exist?`

- [ ] **Step 23: Write `composite.ts` and `index.ts`**

Create `packages/game/src/controls/composite.ts`:

```ts
import type { Intent } from '@tapkart/sim'
import type { ControlAdapter, ControlInputs } from './types'

/**
 * Q23's merge rule, in one place so no scheme invents its own:
 *
 *   steer   - the input of greater absolute magnitude wins; ties go to `keyboard`
 *   accel   - maximum
 *   brake   - logical OR
 *   drift   - logical OR
 *   useItem - logical OR
 *   tick    - the keyboard's, which is the same tick the composite passed to both
 *
 * NOT symmetric: on an equal-magnitude steer tie, `keyboard` wins. SOLE WRITER of
 * `out`, and it writes every field.
 */
export function mergeIntents(touch: Intent, keyboard: Intent, out: Intent): void {
  out.tick = keyboard.tick
  out.steer = Math.abs(keyboard.steer) >= Math.abs(touch.steer) ? keyboard.steer : touch.steer
  out.accel = touch.accel > keyboard.accel ? touch.accel : keyboard.accel
  out.brake = touch.brake || keyboard.brake
  out.drift = touch.drift || keyboard.drift
  out.useItem = touch.useItem || keyboard.useItem
}

/**
 * `primary`'s scheme, `primary`'s and `secondary`'s own scratch Intents, and
 * mergeIntents.
 *
 * The sole-writer rule for Intent (§7.2) is preserved BY CONSTRUCTION: the two
 * scratch Intents below are allocated once, here, and are the only Intents the
 * sub-adapters ever see. Only this adapter writes the one `game` submits.
 */
export function makeCompositeAdapter(primary: ControlAdapter,
                                     secondary: ControlAdapter): ControlAdapter {
  const primaryScratch: Intent = { tick: 0, steer: 0, accel: 0, brake: false, drift: false, useItem: false }
  const secondaryScratch: Intent = { tick: 0, steer: 0, accel: 0, brake: false, drift: false, useItem: false }

  return {
    scheme: primary.scheme,

    sample(raw: ControlInputs, tick: number, out: Intent): void {
      primary.sample(raw, tick, primaryScratch)
      secondary.sample(raw, tick, secondaryScratch)
      mergeIntents(primaryScratch, secondaryScratch, out)
      out.tick = tick
    },

    reset(): void {
      primary.reset()
      secondary.reset()
    },
  }
}
```

Create `packages/game/src/controls/index.ts`:

```ts
import type { ControlAdapter, ControlScheme } from './types'
import type { ControlConfig } from './config'
import { makeThumbZonesAdapter } from './thumbzones'
import { makeTiltAdapter } from './tilt'
import { makeVirtualStickAdapter } from './stick'
import { makeKeyboardAdapter } from './keyboard'
import { makeCompositeAdapter } from './composite'

/**
 * THE public entry point. Builds the scheme's touch adapter, a keyboard adapter,
 * and returns the composite of the two - always, on every platform. Spec §6 says
 * keyboard is *always* available on desktop, and "always" is not "instead of"; on a
 * phone no key is ever down, so the merge is a no-op.
 */
export function makeControlAdapter(scheme: ControlScheme, cfg: ControlConfig): ControlAdapter {
  return makeCompositeAdapter(makeTouchAdapter(scheme, cfg), makeKeyboardAdapter(cfg))
}

/** Exhaustive over ControlScheme: a fourth scheme added to the union without a
 *  case here is a compile error ("not all code paths return a value"), which is
 *  the whole reason this is a switch with returns rather than a default branch. */
function makeTouchAdapter(scheme: ControlScheme, cfg: ControlConfig): ControlAdapter {
  switch (scheme) {
    case 'thumbZones': return makeThumbZonesAdapter(cfg)
    case 'tilt': return makeTiltAdapter(cfg)
    case 'virtualStick': return makeVirtualStickAdapter(cfg)
  }
}
```

- [ ] **Step 24: Run the test to verify it passes**

Run: `npx vitest run packages/game/test/controls-composite.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 25: Verify the whole package typechecks and the whole suite is green**

Run: `npx tsc --noEmit -p packages/game/tsconfig.json`
Expected: no output. (`noUnusedLocals`, `noUnusedParameters` and `verbatimModuleSyntax` are on: every
`import type` above is deliberate.)

Run: `npx vitest run`
Expected: PASS. Every pre-existing suite is untouched; this task adds 75 tests across six files
(12 + 19 + 13 + 11 + 8 + 12).

- [ ] **Step 26: Commit**

```bash
git add packages/game/src/controls packages/game/test/controls-config.test.ts \
        packages/game/test/controls-thumbzones.test.ts packages/game/test/controls-tilt.test.ts \
        packages/game/test/controls-stick.test.ts packages/game/test/controls-keyboard.test.ts \
        packages/game/test/controls-composite.test.ts packages/game/test/fixtures/game-fixtures.ts && \
git commit -m "feat(game): three touch control schemes, keyboard, and the composite merge

thumbZones steers relative to the touch-down origin (Q24), brakes on a
drift long-press qualified by |steer| < DRIFT_STEER_MIN (Q21), and emits
useItem as a one-tick pulse on press (Q25). tilt reuses the same button
layout and reads gamma from the calibrated neutral. virtualStick adds gas
and brake pedals and no long-press brake. Keyboard is merged into every
scheme by CompositeAdapter, never selected on its own (Q23); the
sub-adapters write their own scratch Intents so the sole writer of the
submitted Intent stays the composite."
```
