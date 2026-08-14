### Task 18: Public barrel export

**Files:**
- Modify: `packages/sim/src/index.ts` (replace the whole file: the 4 `export *` lines Task 2 left behind become 19, one per `src` module)
- Test: `packages/sim/test/barrel.test.ts`

**Interfaces:**

Task 1 pointed `packages/sim/package.json`'s `"exports"` map at `"." : "./src/index.ts"`, and Task 2
filled that file with four re-exports (`types`, `vec3`, `mathutil`, `rng`). Nothing has touched it
since, so fifteen of the nineteen simulation modules are unreachable through `@tapkart/sim` and
Plan 2's `net`, `server` and `game` packages cannot import the simulation at all. This task closes
that gap. It adds no new behaviour and changes no signature.

- Consumes — every `src` module, by the exact names the locked contract fixes. This list is the
  test's import list, and it is one named export per module so that a module missing from the barrel
  fails loudly:

  ```ts
  // packages/sim/src/types.ts                                 [Task 2]
  export const TICK_HZ = 60
  export const TICK_DT = 1 / 60
  export const MAX_KARTS = 8
  export const MAX_ENTITIES = 32
  export const RACE_LAPS = 3
  export const COUNTDOWN_TICKS = 180
  // plus the types: Vec3, Intent, DriftState, LapProgress, KartState, EntityState,
  // ItemBoxState, SimState, AuthEvent, AuthEventKind, ItemKind, EntityKind, Surface,
  // RacePhase, Track, TrackPoint, TrackQuery, TrackProjection, CharacterStats, Tuning,
  // SimContext

  // packages/sim/src/vec3.ts                                  [Task 2]
  export function v3(x: number, y: number, z: number): Vec3
  export function v3add(a: Vec3, b: Vec3, out: Vec3): void
  export function v3scale(a: Vec3, s: number, out: Vec3): void
  export function v3len(a: Vec3): number
  export function v3dot(a: Vec3, b: Vec3): number

  // packages/sim/src/mathutil.ts                              [Task 2]
  export function clamp(v: number, lo: number, hi: number): number
  export function lerp(a: number, b: number, t: number): number
  export function wrapAngle(a: number): number                 // -> (-PI, PI]

  // packages/sim/src/rng.ts                                   [Task 2]
  export function rngAt(seed: number, cursor: number): number  // splitmix32, [0,1)

  // packages/sim/src/track.ts
  export function validateTrack(track: Track): string[]            // [Task 3]
  export function buildTrackQuery(track: Track): TrackQuery        // [Task 4]

  // packages/sim/src/state.ts                                 [Task 5]
  export function createState(ctx: SimContext, seed: number, characterIdx: number[]): SimState
  export function cloneState(src: SimState, dst: SimState): void
  export function statesEqual(a: SimState, b: SimState): boolean
  export function emit(state: SimState, out: AuthEvent[], kind: AuthEventKind,
                       playerId: number, entityId: number, item: ItemKind, data: number): void

  // packages/sim/src/step.ts                                  [Task 5, extended by 6-15]
  export function step(ctx: SimContext, prev: SimState, next: SimState,
                       inputs: Intent[], events: AuthEvent[]): void

  // packages/sim/src/kart.ts                                  [Task 6]
  export function stepKart(ctx: SimContext, state: SimState, prevKart: KartState,
                           k: KartState, raw: Intent): void
  export function targetSpeedFor(ctx: SimContext, state: SimState, k: KartState,
                                 accel: number): number

  // packages/sim/src/ground.ts                                [Task 7]
  export function applyAirYaw(ctx: SimContext, k: KartState, steer: number): void
  export function integrateVertical(ctx: SimContext, k: KartState): void
  export function applyRamps(ctx: SimContext, k: KartState, s: number): void

  // packages/sim/src/drift.ts                                 [Task 8]
  export function updateDrift(ctx: SimContext, k: KartState, raw: Intent): void
  export function decayBoost(k: KartState): void

  // packages/sim/src/recovery.ts                              [Task 9]
  export function steeringLocked(k: KartState): boolean
  export function surfaceSpeedFactor(k: KartState, t: Tuning): number
  export function updateRecovery(ctx: SimContext, state: SimState,
                                 k: KartState, events: AuthEvent[]): void

  // packages/sim/src/collision.ts                             [Task 10]
  export function resolveKartCollisions(ctx: SimContext, state: SimState): void

  // packages/sim/src/laps.ts                                  [Task 11]
  export function updateLaps(ctx: SimContext, state: SimState, k: KartState,
                             events: AuthEvent[]): void

  // packages/sim/src/placement.ts                             [Task 11]
  export function placementOrder(state: SimState): number[]
  export function computePlacement(state: SimState, outIndexOf: Int32Array,
                                   outOrder: Int32Array): void

  // packages/sim/src/entity.ts                                [Task 12]
  export function spawnEntity(state: SimState, kind: EntityKind, ownerId: number,
                              position: Vec3, heading: number, targetId: number,
                              ttl: number, events: AuthEvent[]): number
  export function despawnEntityAt(state: SimState, idx: number, events: AuthEvent[]): void
  export function kartById(state: SimState, playerId: number): KartState | null
  export function updateEntities(ctx: SimContext, state: SimState, events: AuthEvent[]): void
  export function surgeActiveOn(state: SimState, playerId: number): boolean

  // packages/sim/src/items.ts                                 [Task 13]
  export function updateItemBoxes(ctx: SimContext, state: SimState, events: AuthEvent[]): void
  export function rollItem(ctx: SimContext, state: SimState, placeIdx: number): ItemKind
  export function useItem(ctx: SimContext, state: SimState, k: KartState,
                          events: AuthEvent[]): void

  // packages/sim/src/bot.ts                                   [Task 14]
  export function botIntent(ctx: SimContext, state: SimState, playerId: number): Intent

  // packages/sim/src/phase.ts                                 [Task 15]
  export const FINISH_GRACE_TICKS = 1800
  export function makeIntentBuffer(): Intent[]
  export function resetBotHold(): void
  export function resolveInputs(ctx: SimContext, state: SimState,
                                inputs: Intent[], out: Intent[]): void
  export function updatePhase(ctx: SimContext, state: SimState, events: AuthEvent[]): void

  // packages/sim/src/replay.ts                                [Task 16]
  export interface IntentSource { intentFor(state: SimState, playerId: number): Intent }
  export const INTENT_HEADER = 4
  export const INTENT_STRIDE = 5
  export function intentOffset(intents: Float64Array, tick: number, slot: number): number
  export function allocStateLike(ctx: SimContext, src: SimState): SimState
  export function recordRun(ctx: SimContext, from: SimState, ticks: number,
                            src: IntentSource): { end: SimState; intents: Float64Array }
  export function replayRun(ctx: SimContext, from: SimState, intents: Float64Array,
                            fromTick: number, toTick: number): SimState

  // packages/sim/test/fixtures/track-fixtures.ts              [Task 3]
  export function makeStraightTrack(overrides?: Partial<Track>): Track
  export function makeContext(track: Track, isLeader?: boolean): SimContext  // [Task 4]
  ```

- Produces:
  - `packages/sim/src/index.ts` re-exporting all nineteen modules — `types`, `vec3`, `mathutil`,
    `rng`, `track`, `state`, `step`, `kart`, `ground`, `drift`, `recovery`, `collision`, `laps`,
    `placement`, `entity`, `items`, `bot`, `phase`, `replay` — so `import { step, createState }
    from '@tapkart/sim'` works from any workspace package.

**Facts this task rests on (check them, do not assume them):**

1. `export *` re-exports types and values together and is legal under `isolatedModules`; only a
   named `export { SomeType }` would need `export type`.
2. No two `src` modules export the same name, so no `export *` is ambiguous. In ESM an ambiguous
   star-export is silently excluded from the namespace and importing it by name is a `SyntaxError`,
   which is why Step 1 asserts the absence of clashes at runtime rather than trusting this sentence.
3. The barrel imports every module; no module imports the barrel. Adding it therefore creates no
   import cycle.
4. Test fixtures live under `packages/sim/test/`, never under `src/`, so the barrel cannot leak
   `makeOvalTrack` or `makeTuning` into the public surface. Step 1 asserts that too.

---

- [ ] **Step 1: Write the failing test**

Create `packages/sim/test/barrel.test.ts`:

```ts
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
  resetBotHold,
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
      ['phase.resetBotHold', resetBotHold],
      ['phase.resolveInputs', resolveInputs],
      ['phase.updatePhase', updatePhase],
      ['replay.intentOffset', intentOffset],
      ['replay.allocStateLike', allocStateLike],
      ['replay.recordRun', recordRun],
      ['replay.replayRun', replayRun],
    ]
    // 47 functions across the 18 modules that export any. The nineteenth,
    // `types`, exports only constants and types; the constants test below
    // covers it. 5 vec3 + 3 mathutil + 1 rng + 2 track + 4 state + 1 step
    // + 2 kart + 3 ground + 2 drift + 3 recovery + 1 collision + 1 laps
    // + 2 placement + 5 entity + 3 items + 1 bot + 4 phase + 4 replay = 47.
    expect(fns).toHaveLength(47)
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

    resetBotHold()
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/sim/test/barrel.test.ts`

Expected: FAIL — the file cannot even be collected, because `src/index.ts` still exports only
`types`, `vec3`, `mathutil` and `rng`:
`SyntaxError: The requested module '/…/packages/sim/src/index.ts' does not provide an export named
'buildTrackQuery'` (the first name in the import list that the barrel does not carry).

Run: `npx tsc --noEmit -p packages/sim`

Expected: FAIL with one `TS2305: Module '"../src/index"' has no exported member '<name>'` per
missing name — `buildTrackQuery`, `validateTrack`, `createState`, `step`, and so on down the list.

- [ ] **Step 3: Write the barrel**

Replace the whole of `packages/sim/src/index.ts`. It currently contains exactly this, from Task 2:

```typescript
export * from './types'
export * from './vec3'
export * from './mathutil'
export * from './rng'
```

Replace it with:

```typescript
// Public barrel for @tapkart/sim.
//
// packages/sim/package.json maps "." to this file, so this list IS the package's
// public surface: Plan 2's net, server and game packages import the simulation
// through `@tapkart/sim` and get exactly what is re-exported here.
//
// Ordered as the locked contract's module map lists them. `export *` carries
// types and values together and is legal under isolatedModules; only a named
// `export { SomeType }` would need `export type`. No two modules below export
// the same name, so no re-export is ambiguous - barrel.test.ts asserts that at
// runtime rather than leaving it to this comment.
export * from './types'
export * from './vec3'
export * from './mathutil'
export * from './rng'
export * from './track'
export * from './state'
export * from './step'
export * from './kart'
export * from './ground'
export * from './drift'
export * from './recovery'
export * from './collision'
export * from './laps'
export * from './placement'
export * from './entity'
export * from './items'
export * from './bot'
export * from './phase'
export * from './replay'
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/sim/test/barrel.test.ts`

Expected: PASS — 7 tests.

If `has no ambiguous re-export` fails, it prints the clashing name and the two modules that both
export it, e.g. `[ [ 'surfaceSpeedFactor', [ 'drift', 'recovery' ] ] ]`. The fix is to rename the
copy in the module that does **not** own the name per the locked contract's module map, not to drop
a line from the barrel: a module missing from the barrel is the defect this task exists to remove.

- [ ] **Step 5: Verify the public surface from outside the package**

Run:

```bash
npx vitest run packages/sim/test/barrel.test.ts -t "resolves through the @tapkart/sim package entry point"
npm ls --depth=0
```

Expected: PASS — 1 test, and `npm ls` lists `@tapkart/sim@0.1.0 -> ./packages/sim`, the workspace
link that made the bare specifier resolve.

- [ ] **Step 6: Run the full sim suite and typecheck**

Run: `npx tsc --noEmit -p packages/sim && npx vitest run packages/sim`

Expected: PASS, zero type errors, every sim test green including Task 17's golden replay. The barrel
adds no runtime behaviour; the only way this step can go red is a genuine name clash between two
modules (`TS2308: Module './x' has already exported a member named 'y'`), which Step 4's test would
already have named.

- [ ] **Step 7: Commit**

```bash
git add packages/sim/src/index.ts packages/sim/test/barrel.test.ts
git commit -m "feat(sim): re-export every simulation module from the package barrel

src/index.ts carried only types, vec3, mathutil and rng since Task 2, so
fifteen modules - track, state, step, kart, ground, drift, recovery,
collision, laps, placement, entity, items, bot, phase and replay - were
unreachable through @tapkart/sim and Plan 2's net/server/game packages
could not import the simulation at all.

barrel.test.ts imports one named export from each of the nineteen modules
through ../src/index, pins the contract constants, proves the barrel
forwards each module's own binding rather than a copy, checks the module
list against the src/ directory so a new module cannot be forgotten,
scans for ambiguous re-exports (an ambiguous star export is silently
dropped from an ESM namespace), and resolves the bare @tapkart/sim
specifier the way a downstream package will."
```
