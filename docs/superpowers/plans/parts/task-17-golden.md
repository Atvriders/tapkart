### Task 17: Golden-Replay Fixture

**Files:**
- Create: `packages/sim/test/fixtures/golden-format.ts`
- Create: `packages/sim/test/fixtures/golden-harness.ts`
- Create: `packages/sim/test/fixtures/GOLDEN.md`
- Create: `packages/sim/test/fixtures/golden-oval-3lap-8bot.json` (generated in Step 12, committed)
- Test: `packages/sim/test/golden-format.test.ts`
- Test: `packages/sim/test/golden-harness.test.ts`
- Test: `packages/sim/test/golden-replay.test.ts`
- Test: `packages/sim/test/golden-regen.test.ts`

**Interfaces:**

Consumes (exact signatures, already shipped by earlier tasks):

```ts
// packages/sim/src/types.ts                                   [Task 2]
export const TICK_HZ = 60
export const TICK_DT = 1 / 60
export const MAX_KARTS = 8
export const MAX_ENTITIES = 32
export const RACE_LAPS = 3
export const COUNTDOWN_TICKS = 180
export type Vec3 = { x: number; y: number; z: number }
export type Surface = 'tarmac' | 'dirt' | 'boost' | 'offtrack'
export type ItemKind = 'none' | 'boost' | 'seeker' | 'bolt' | 'slick' | 'bubble' | 'surge' | 'blink' | 'charge'
export type EntityKind = 'seeker' | 'bolt' | 'slick' | 'bubble' | 'surge' | 'charge'
export type RacePhase = 'countdown' | 'racing' | 'finished'
export type AuthEventKind = 'itemGrant' | 'entitySpawn' | 'entityDespawn' | 'hit' | 'spinOut' | 'respawn' | 'lapCross' | 'finish'
export interface Intent { tick: number; steer: number; accel: number; brake: boolean; drift: boolean; useItem: boolean }
export interface DriftState { active: boolean; dir: -1 | 0 | 1; charge: number }
export interface LapProgress { lap: number; checkpointIdx: number; t: number }
export interface KartState {          // all 18 fields, transcribed from types.ts
  playerId: number
  characterIdx: number
  isBot: boolean
  connected: boolean
  position: Vec3
  velocity: Vec3
  heading: number
  angularVelocity: number
  drift: DriftState
  item: ItemKind
  airborne: boolean
  surface: Surface
  spinOutTicks: number
  invulnTicks: number
  boostTicks: number
  respawnTicks: number
  shielded: boolean
  lap: LapProgress
}
export interface EntityState { entityId: number; kind: EntityKind; ownerId: number; position: Vec3;
   velocity: Vec3; heading: number; targetId: number; ttl: number }
export interface ItemBoxState { boxIdx: number; respawnTicks: number }
export interface AuthEvent { eventSeq: number; tick: number; kind: AuthEventKind; playerId: number;
   entityId: number; item: ItemKind; data: number }
export interface SimState { tick: number; phase: RacePhase; raceSeed: number; rngCursor: number;
   nextEventSeq: number; finishTick: number; karts: KartState[]; entities: EntityState[];
   entityCount: number; nextEntityId: number; itemBoxes: ItemBoxState[]; finishedOrder: number[] }
// karts is always length MAX_KARTS; entities always length MAX_ENTITIES with the live ones packed
// at the front and dead slots at entityId -1; finishedOrder always length MAX_KARTS, with -1 in
// every slot no kart has finished into (locked contract §0 - it is never pushed).
export interface SimContext { track: Track; query: TrackQuery; tuning: Tuning;
   characters: CharacterStats[]; isLeader: boolean }

// packages/sim/src/mathutil.ts                                [Task 2]
export function clamp(v: number, lo: number, hi: number): number
export function wrapAngle(a: number): number                  // -> (-PI, PI]

// packages/sim/src/state.ts                                   [Task 5]
export function createState(ctx: SimContext, seed: number, characterIdx: number[]): SimState

// packages/sim/src/step.ts                                    [Task 5, extended by 6-15]
export function step(ctx: SimContext, prev: SimState, next: SimState,
                     inputs: Intent[], events: AuthEvent[]): void

// packages/sim/src/bot.ts                                     [Task 14]
export function botIntent(ctx: SimContext, state: SimState, playerId: number): Intent

// packages/sim/test/fixtures/track-fixtures.ts                [Task 3]
export function makeTuning(overrides?: Partial<Tuning>): Tuning
export function makeOvalTrack(overrides?: Partial<Track>): Track
export function makeContext(track: Track, isLeader?: boolean): SimContext  // [Task 4]; isLeader defaults true

// packages/sim/src/track.ts (via ctx.query, built by buildTrackQuery)   [Task 4]
totalLength(): number
```

**Depends on the whole tick being wired.** This task asserts on the *event stream* — `lapCross`,
`finish` and `hit` events, and the absence of `respawn` — so it cannot pass until every producer of
those events is actually called from `step()`. Those call sites are added by the tasks that own the
functions, each with its own failing test, not here:

| Event this task counts | Produced by | Wired into `step()` by |
|---|---|---|
| `respawn`, `spinOut` | `updateRecovery` | Task 9 (per-kart slot 2) |
| — (kart-vs-kart separation) | `resolveKartCollisions` | Task 10 (after the kart loop) |
| `lapCross`, `finish` | `updateLaps` | Task 11 (last per-kart call) |
| `hit`, `entitySpawn`, `entityDespawn` | `updateEntities` | Task 12 (after `resolveKartCollisions`) |
| `itemGrant` | `updateItemBoxes`, `useItem` | Task 13 |

If Step 12's generator reports zero `lapCross` events, or every kart stuck on `lap.lap === 0`, the
defect is a missing `step()` call site in Tasks 9–12 — not something to patch inside this harness.

**Why this task drives `step()` directly instead of using `recordRun` / `replayRun` from
Task 16's `packages/sim/src/replay.ts`:** those two return `{ end: SimState; intents: Float64Array }`
and `SimState` respectively — neither returns the `AuthEvent[]` stream. The spec's
bot-drivability criterion is *defined on the event stream* ("zero `respawn` events across the
entire run", and one `finish` event per kart), so this harness owns its own runner that passes a
single accumulating `AuthEvent[]` into every `step()` call. Task 16's replay path is unchanged and
untouched by this task.

Produces:

```ts
// packages/sim/test/fixtures/golden-format.ts
export const GOLDEN_FORMAT_VERSION = 1
export const GOLDEN_SEED = 20260813
export const GOLDEN_CHARACTER_IDX: number[]            // [0,1,2,3,4,5,6,7]
export const GOLDEN_TAIL_TICKS = 60
export const MAX_GOLDEN_TICKS = 18000
export const INTENT_SCALE = 10000
export const INTENT_BYTES_PER_KART = 5
export const B64_LINE_LENGTH = 120
export const GOLDEN_REGEN_COMMAND: string
export const GOLDEN_PATH: string
export const CI_ENV_FLAGS: readonly string[]
export interface GoldenTolerance { position: number; velocity: number; heading: number;
                                   angularVelocity: number; driftCharge: number; lapT: number }
export const GOLDEN_TOL: GoldenTolerance
export interface FieldDiff { path: string; expected: number | string | boolean;
                             actual: number | string | boolean; delta: number; tolerance: number }
export interface GoldenLap { lap: number; checkpointIdx: number; t: number }
export interface GoldenDrift { active: boolean; dir: -1 | 0 | 1; charge: number }
export interface GoldenKart { playerId: number; characterIdx: number; isBot: boolean;
  connected: boolean; position: [number, number, number]; velocity: [number, number, number];
  heading: number; angularVelocity: number; drift: GoldenDrift; item: ItemKind; airborne: boolean;
  surface: Surface; spinOutTicks: number; invulnTicks: number; boostTicks: number;
  respawnTicks: number; shielded: boolean; lap: GoldenLap }
export interface GoldenEntity { entityId: number; kind: EntityKind; ownerId: number;
  position: [number, number, number]; velocity: [number, number, number]; heading: number;
  targetId: number; ttl: number }
export interface GoldenExpectation { tick: number; phase: RacePhase; raceSeed: number;
  rngCursor: number; nextEventSeq: number; finishTick: number; entityCount: number;
  nextEntityId: number; finishedOrder: number[];
  itemBoxes: { boxIdx: number; respawnTicks: number }[];
  karts: GoldenKart[]; entities: GoldenEntity[] }
export interface GoldenEventSummary { total: number; countsByKind: Record<string, number>;
  finishes: { playerId: number; tick: number }[] }
export interface GoldenFixture { formatVersion: number; generatedBy: string; trackId: string;
  raceSeed: number; characterIdx: number[]; tickCount: number; intentScale: number;
  intentsB64: string[]; expected: GoldenExpectation; events: GoldenEventSummary }
export function normZero(v: number): number
export function quantizeIntent(src: Intent, tick: number): Intent
export function packIntents(intents: Intent[][]): Uint8Array
export function unpackIntents(bytes: Uint8Array, tickCount: number): Intent[][]
export function encodeB64Lines(bytes: Uint8Array): string[]
export function decodeB64Lines(lines: string[]): Uint8Array
export function assertRegenerationAllowed(env: Record<string, string | undefined>): void
export function loadGoldenFixture(path?: string): GoldenFixture
export function saveGoldenFixture(fx: GoldenFixture, path?: string): void
export function readGoldenFixtureText(path?: string): string

// packages/sim/test/fixtures/golden-harness.ts
export interface GoldenRun { end: SimState; events: AuthEvent[]; ticks: number }
export interface DrivabilityReport { respawnCount: number; finishedPlayerIds: number[];
                                     lapsByPlayer: number[]; allFinished: boolean; ok: boolean }
export function makeGoldenState(ctx: SimContext, seed: number, characterIdx: number[]): SimState
export function runGoldenTicks(ctx: SimContext, seed: number, characterIdx: number[],
                               intents: Intent[][], ticks: number): GoldenRun
export function replayGoldenFixture(ctx: SimContext, fx: GoldenFixture): GoldenRun
export function recordGoldenWithBots(ctx: SimContext, seed: number, characterIdx: number[],
                                     maxTicks: number): { run: GoldenRun; intents: Intent[][] }
export function toExpectation(state: SimState): GoldenExpectation
export function summarizeEvents(events: AuthEvent[]): GoldenEventSummary
export function checkDrivability(state: SimState, events: AuthEvent[]): DrivabilityReport
export function describeDrivabilityFailure(d: DrivabilityReport): string
export function diffAgainstGolden(exp: GoldenExpectation, act: SimState,
                                  tol?: GoldenTolerance): FieldDiff[]
export function diffEventSummary(exp: GoldenEventSummary, act: GoldenEventSummary): FieldDiff[]
export function formatDiffs(diffs: FieldDiff[]): string
```

---

#### Why this is a field-by-field comparison and not a digest

A digest compresses a state vector of roughly a thousand numbers into one number. When it
mismatches, the test can only say `expected "a3f1c2…" to be "9c0417…"`. That failure **names no
field, no value and no delta.** It cannot distinguish "the drift charge tier boundary moved by one
tick" from "kart 6 fell through the floor on lap 2", and it cannot tell you whether the underlying
change is 1e-15 metres (float noise from a harmless re-association of a sum) or 40 metres. Every
mismatch therefore costs a full bisect before anyone even knows what broke.

Worse, a digest forces **exact** comparison onto continuous fields. Reordering a floating-point sum
is a legal, behaviour-preserving refactor that changes the last bit of a double and therefore the
digest. The golden goes red, nobody can see that it was harmless, and the team learns to regenerate
the fixture reflexively — at which point the fixture asserts nothing at all.

So this fixture compares every field by name, with two comparison rules:

- **Exact** (`Object.is`, tolerance `0`) for integers, enums, booleans and counters:
  `tick`, `phase`, `raceSeed`, `rngCursor`, `nextEventSeq`, `finishTick`, `entityCount`,
  `nextEntityId`, `finishedOrder[]`, `itemBoxes[].boxIdx`, `itemBoxes[].respawnTicks`,
  every kart's `playerId`, `characterIdx`, `isBot`, `connected`, `drift.active`, `drift.dir`,
  `item`, `airborne`, `surface`, `spinOutTicks`, `invulnTicks`, `boostTicks`, `respawnTicks`,
  `shielded`, `lap.lap`, `lap.checkpointIdx`, and every live entity's `entityId`, `kind`,
  `ownerId`, `targetId`, `ttl`. These are decisions, not measurements. A one-unit change to any of
  them is a behaviour change, so nothing is tolerated.
- **Tolerated** for the continuous fields, with the tolerance stated in `GOLDEN_TOL` and printed in
  every failure line: `position` 1e-6 m, `velocity` 1e-6 m/s, `heading` 1e-7 rad,
  `angularVelocity` 1e-7 rad/s, `drift.charge` 1e-6, `lap.t` 1e-9.

**Where those tolerances come from.** A double carries ~2.22e-16 relative error. At a position
magnitude of ~1e3 m, one ULP is ~1.1e-13 m; over ~4,000 ticks, fully-correlated round-off drift is
bounded near 4e-10 m. The smallest *physically meaningful* change, on the other hand, is one tick of
acceleration: `accelRate` 24 m/s² × `TICK_DT` 1/60 s = 0.4 m/s of velocity, which is 6.7e-3 m of
position in that same tick. The tolerance of 1e-6 sits roughly 2,500× above the float-noise ceiling
and 6,700× below the smallest real change — six orders of magnitude of daylight on each side. The
same argument gives heading: `steerRateBase` 2.6 rad/s × 1/60 s = 0.0433 rad per tick of real
change, against ~1.6e-12 rad of accumulated round-off, so 1e-7 is comfortably between them.

`JSON.stringify` emits the shortest round-tripping decimal for every double and `JSON.parse` returns
the identical double, so storing the expectation as plain JSON loses nothing. JSON cannot represent
`-0`, `NaN` or `Infinity`: the writer therefore refuses to store a non-finite number (naming the
field), and the exact comparator normalises `-0` to `+0` on both sides.

---

- [ ] **Step 1: Write the failing test for the fixture format layer**

Create `packages/sim/test/golden-format.test.ts`:

```ts
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import type { Intent } from '../src/types'
import { MAX_KARTS } from '../src/types'
import type { GoldenFixture } from './fixtures/golden-format'
import {
  B64_LINE_LENGTH,
  GOLDEN_CHARACTER_IDX,
  GOLDEN_FORMAT_VERSION,
  GOLDEN_PATH,
  GOLDEN_REGEN_COMMAND,
  GOLDEN_SEED,
  GOLDEN_TOL,
  INTENT_BYTES_PER_KART,
  INTENT_SCALE,
  MAX_GOLDEN_TICKS,
  assertRegenerationAllowed,
  decodeB64Lines,
  encodeB64Lines,
  loadGoldenFixture,
  normZero,
  packIntents,
  quantizeIntent,
  saveGoldenFixture,
  unpackIntents,
} from './fixtures/golden-format'

function intent(tick: number, steer: number, accel: number, flags: number): Intent {
  return {
    tick,
    steer,
    accel,
    brake: (flags & 1) !== 0,
    drift: (flags & 2) !== 0,
    useItem: (flags & 4) !== 0,
  }
}

describe('golden fixture constants', () => {
  it('pins the values the fixture and the tests are written against', () => {
    expect(GOLDEN_FORMAT_VERSION).toBe(1)
    expect(GOLDEN_SEED).toBe(20260813)
    expect(GOLDEN_CHARACTER_IDX).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    expect(GOLDEN_CHARACTER_IDX).toHaveLength(MAX_KARTS)
    expect(INTENT_SCALE).toBe(10000)
    expect(INTENT_BYTES_PER_KART).toBe(5) // int16 steer + int16 accel + uint8 flags
    expect(B64_LINE_LENGTH).toBe(120)
    expect(MAX_GOLDEN_TICKS).toBe(18000) // 5 minutes at 60Hz; a runaway guard, not a target
    expect(GOLDEN_PATH.endsWith('golden-oval-3lap-8bot.json')).toBe(true)
    expect(GOLDEN_REGEN_COMMAND).toBe(
      'UPDATE_GOLDEN=1 npx vitest run packages/sim/test/golden-regen.test.ts',
    )
  })

  it('states a tolerance for every continuous field and nothing else', () => {
    expect(GOLDEN_TOL.position).toBe(1e-6)
    expect(GOLDEN_TOL.velocity).toBe(1e-6)
    expect(GOLDEN_TOL.heading).toBe(1e-7)
    expect(GOLDEN_TOL.angularVelocity).toBe(1e-7)
    expect(GOLDEN_TOL.driftCharge).toBe(1e-6)
    expect(GOLDEN_TOL.lapT).toBe(1e-9)
    expect(Object.keys(GOLDEN_TOL).sort()).toEqual([
      'angularVelocity',
      'driftCharge',
      'heading',
      'lapT',
      'position',
      'velocity',
    ])
  })
})

describe('normZero', () => {
  it('maps -0 to +0 and leaves everything else alone', () => {
    expect(Object.is(normZero(-0), 0)).toBe(true)
    expect(Object.is(normZero(0), 0)).toBe(true)
    expect(normZero(-1.5)).toBe(-1.5)
    expect(Number.isNaN(normZero(Number.NaN))).toBe(true)
  })
})

describe('quantizeIntent', () => {
  it('rounds steer and accel to 1/10000 and stamps the tick', () => {
    // 0.123456789 * 10000 = 1234.56789 -> round -> 1235 -> /10000 = 0.1235
    const q = quantizeIntent(intent(0, 0.123456789, 0.5, 0), 7)
    expect(q.tick).toBe(7)
    expect(q.steer).toBe(0.1235)
    expect(q.accel).toBe(0.5)
    expect(q.brake).toBe(false)
    expect(q.drift).toBe(false)
    expect(q.useItem).toBe(false)
  })

  it('clamps steer to -1..1 and accel to 0..1', () => {
    expect(quantizeIntent(intent(0, -1.7, 2.3, 0), 1).steer).toBe(-1)
    expect(quantizeIntent(intent(0, 1.7, 2.3, 0), 1).steer).toBe(1)
    expect(quantizeIntent(intent(0, 0, 2.3, 0), 1).accel).toBe(1)
    expect(quantizeIntent(intent(0, 0, -0.4, 0), 1).accel).toBe(0)
  })

  it('never produces -0, because JSON cannot represent it', () => {
    // -0.00004 * 10000 = -0.4 ; Math.round(-0.4) is -0 in JS
    const q = quantizeIntent(intent(0, -0.00004, 0, 0), 2)
    expect(Object.is(q.steer, 0)).toBe(true)
  })

  it('carries the three booleans through unchanged', () => {
    const q = quantizeIntent(intent(0, 0, 1, 7), 3)
    expect(q.brake).toBe(true)
    expect(q.drift).toBe(true)
    expect(q.useItem).toBe(true)
  })

  it('refuses a non-finite intent instead of silently storing 0', () => {
    expect(() => quantizeIntent(intent(0, Number.NaN, 1, 0), 3)).toThrow(
      'golden: non-finite intent at tick 3: steer=NaN accel=1',
    )
  })
})

describe('intent packing', () => {
  it('round-trips a two-tick stream byte-for-byte', () => {
    const rows: Intent[][] = []
    for (let t = 0; t < 2; t++) {
      const row: Intent[] = []
      for (let i = 0; i < MAX_KARTS; i++) {
        // steer (i-4)/8 spans -0.5..0.375, accel i/8 spans 0..0.875 - all exact at 1/10000
        row.push(quantizeIntent(intent(t, (i - 4) / 8, i / 8, i % 8), t))
      }
      rows.push(row)
    }

    const bytes = packIntents(rows)
    expect(bytes.length).toBe(2 * MAX_KARTS * INTENT_BYTES_PER_KART) // 2 * 8 * 5 = 80

    const back = unpackIntents(bytes, 2)
    expect(back).toEqual(rows)
    expect(back[1][7].steer).toBe(0.375)
    expect(back[1][7].accel).toBe(0.875)
    expect(back[1][7].brake).toBe(true)
    expect(back[1][7].drift).toBe(true)
    expect(back[1][7].useItem).toBe(true)
  })

  it('refuses a stream whose length does not match the tick count', () => {
    const bytes = new Uint8Array(3 * MAX_KARTS * INTENT_BYTES_PER_KART)
    expect(() => unpackIntents(bytes, 2)).toThrow(
      'golden: intent stream is 120 bytes, expected 80 for 2 ticks',
    )
  })
})

describe('base64 chunking', () => {
  it('emits one short line for a three-byte payload', () => {
    const lines = encodeB64Lines(new Uint8Array([0, 1, 2]))
    expect(lines).toEqual(['AAEC'])
    expect(Array.from(decodeB64Lines(lines))).toEqual([0, 1, 2])
  })

  it('splits into 120-character lines so the fixture stays diffable', () => {
    const bytes = new Uint8Array(200)
    for (let i = 0; i < 200; i++) bytes[i] = (i * 7) & 0xff
    // 200 bytes -> ceil(200/3) = 67 base64 quads -> 268 chars -> 120 + 120 + 28
    const lines = encodeB64Lines(bytes)
    expect(lines.map((l) => l.length)).toEqual([120, 120, 28])
    expect(Array.from(decodeB64Lines(lines))).toEqual(Array.from(bytes))
  })
})

describe('assertRegenerationAllowed', () => {
  it('refuses when CI is set, and says exactly why', () => {
    expect(() => assertRegenerationAllowed({ CI: 'true' })).toThrow(
      'golden: refusing to regenerate because CI=true. A regenerated golden fixture is a claim ' +
        'that a physics change was intentional; it must be produced on a developer machine and ' +
        'reviewed in the diff. Unset CI to proceed.',
    )
  })

  it('refuses on the other CI markers too', () => {
    expect(() => assertRegenerationAllowed({ GITHUB_ACTIONS: 'true' })).toThrow(
      /refusing to regenerate because GITHUB_ACTIONS=true/,
    )
    expect(() => assertRegenerationAllowed({ CONTINUOUS_INTEGRATION: '1' })).toThrow(
      /refusing to regenerate because CONTINUOUS_INTEGRATION=1/,
    )
  })

  it('allows a developer machine, including the explicitly-negative forms', () => {
    expect(() => assertRegenerationAllowed({})).not.toThrow()
    expect(() => assertRegenerationAllowed({ CI: '' })).not.toThrow()
    expect(() => assertRegenerationAllowed({ CI: '0' })).not.toThrow()
    expect(() => assertRegenerationAllowed({ CI: 'false' })).not.toThrow()
    expect(() => assertRegenerationAllowed({ CI: 'FALSE' })).not.toThrow()
    expect(() => assertRegenerationAllowed({ CI: undefined })).not.toThrow()
  })
})

describe('fixture io', () => {
  it('rejects a fixture written by a different format version', () => {
    const p = join(tmpdir(), 'tapkart-golden-version.json')
    saveGoldenFixture({ formatVersion: 999 } as unknown as GoldenFixture, p)
    expect(() => loadGoldenFixture(p)).toThrow('golden: fixture formatVersion 999, this build expects 1')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/sim/test/golden-format.test.ts`
Expected: FAIL with `Failed to resolve import "./fixtures/golden-format" from "packages/sim/test/golden-format.test.ts"`

- [ ] **Step 3: Write the fixture format layer**

Create `packages/sim/test/fixtures/golden-format.ts`:

```ts
// Golden-replay fixture format: constants, tolerances, the intent-stream codec,
// the CI regeneration guard, and fixture load/save.
//
// The comparison this format supports is field-by-field, NOT a digest. A digest
// mismatch names no field, no value and no delta, so it cannot tell a harmless
// last-bit re-association from a kart falling through the floor. See GOLDEN.md.
import { Buffer } from 'node:buffer'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { EntityKind, Intent, ItemKind, RacePhase, Surface } from '../../src/types'
import { MAX_KARTS } from '../../src/types'
import { clamp } from '../../src/mathutil'

export const GOLDEN_FORMAT_VERSION = 1

/** Race seed for the golden run. Fixed forever; changing it invalidates the fixture. */
export const GOLDEN_SEED = 20260813

/** One of each of the eight characters, so every stat row is exercised. */
export const GOLDEN_CHARACTER_IDX: number[] = [0, 1, 2, 3, 4, 5, 6, 7]

/** Ticks recorded after the last kart finishes, so the fixture also pins the post-race state. */
export const GOLDEN_TAIL_TICKS = 60

/** Runaway guard: 18000 ticks = 5 minutes at 60Hz. A race longer than this is a bug. */
export const MAX_GOLDEN_TICKS = 18000

/** Recorded steer/accel are quantised to 1/10000 so the stream is exactly reproducible. */
export const INTENT_SCALE = 10000

/** int16 steer + int16 accel + uint8 flags. */
export const INTENT_BYTES_PER_KART = 5

/** The packed stream is stored as base64 split into short lines so git can diff it. */
export const B64_LINE_LENGTH = 120

export const GOLDEN_REGEN_COMMAND =
  'UPDATE_GOLDEN=1 npx vitest run packages/sim/test/golden-regen.test.ts'

const HERE = dirname(fileURLToPath(import.meta.url))

export const GOLDEN_PATH = join(HERE, 'golden-oval-3lap-8bot.json')

/** Any of these, set to anything other than empty/0/false, blocks regeneration. */
export const CI_ENV_FLAGS: readonly string[] = ['CI', 'GITHUB_ACTIONS', 'CONTINUOUS_INTEGRATION']

export interface GoldenTolerance {
  position: number
  velocity: number
  heading: number
  angularVelocity: number
  driftCharge: number
  lapT: number
}

/**
 * Per-field tolerances for the continuous fields only. Everything else compares exactly.
 *
 * Sizing: one ULP at a position magnitude of ~1e3 m is ~1.1e-13 m, so ~4000 ticks of
 * fully-correlated round-off is bounded near 4e-10 m. The smallest physically meaningful
 * change is one tick of acceleration: accelRate 24 m/s^2 * TICK_DT (1/60 s) = 0.4 m/s,
 * i.e. 6.7e-3 m of position. 1e-6 sits between them with ~6 orders of magnitude either side.
 */
export const GOLDEN_TOL: GoldenTolerance = {
  position: 1e-6,
  velocity: 1e-6,
  heading: 1e-7,
  angularVelocity: 1e-7,
  driftCharge: 1e-6,
  lapT: 1e-9,
}

/** One differing field. `tolerance === 0` means the field is compared exactly. */
export interface FieldDiff {
  path: string
  expected: number | string | boolean
  actual: number | string | boolean
  delta: number
  tolerance: number
}

export interface GoldenLap {
  lap: number
  checkpointIdx: number
  t: number
}

export interface GoldenDrift {
  active: boolean
  dir: -1 | 0 | 1
  charge: number
}

export interface GoldenKart {
  playerId: number
  characterIdx: number
  isBot: boolean
  connected: boolean
  position: [number, number, number]
  velocity: [number, number, number]
  heading: number
  angularVelocity: number
  drift: GoldenDrift
  item: ItemKind
  airborne: boolean
  surface: Surface
  spinOutTicks: number
  invulnTicks: number
  boostTicks: number
  respawnTicks: number
  shielded: boolean
  lap: GoldenLap
}

export interface GoldenEntity {
  entityId: number
  kind: EntityKind
  ownerId: number
  position: [number, number, number]
  velocity: [number, number, number]
  heading: number
  targetId: number
  ttl: number
}

export interface GoldenExpectation {
  tick: number
  phase: RacePhase
  raceSeed: number
  rngCursor: number
  nextEventSeq: number
  finishTick: number
  entityCount: number
  nextEntityId: number
  finishedOrder: number[]
  itemBoxes: { boxIdx: number; respawnTicks: number }[]
  karts: GoldenKart[]
  /** Exactly `entityCount` live records. Slots at or beyond it must hold entityId -1. */
  entities: GoldenEntity[]
}

export interface GoldenEventSummary {
  total: number
  countsByKind: Record<string, number>
  finishes: { playerId: number; tick: number }[]
}

export interface GoldenFixture {
  formatVersion: number
  /** The command that regenerates this file. No timestamps, no hostnames, no absolute paths. */
  generatedBy: string
  trackId: string
  raceSeed: number
  characterIdx: number[]
  tickCount: number
  intentScale: number
  intentsB64: string[]
  expected: GoldenExpectation
  events: GoldenEventSummary
}

/** JSON has no -0, so -0 and +0 must compare equal on both sides. */
export function normZero(v: number): number {
  return v === 0 ? 0 : v
}

/**
 * Snap an intent onto the 1/10000 grid the fixture stores. The generator quantises before
 * simulating, so the recorded stream is byte-identical to the stream that produced the
 * expectation and replay is exact rather than merely close.
 */
export function quantizeIntent(src: Intent, tick: number): Intent {
  if (!Number.isFinite(src.steer) || !Number.isFinite(src.accel)) {
    throw new Error(
      `golden: non-finite intent at tick ${tick}: steer=${src.steer} accel=${src.accel}`,
    )
  }
  const steerQ = normZero(Math.round(clamp(src.steer, -1, 1) * INTENT_SCALE))
  const accelQ = normZero(Math.round(clamp(src.accel, 0, 1) * INTENT_SCALE))
  return {
    tick,
    steer: steerQ / INTENT_SCALE,
    accel: accelQ / INTENT_SCALE,
    brake: src.brake === true,
    drift: src.drift === true,
    useItem: src.useItem === true,
  }
}

export function packIntents(intents: Intent[][]): Uint8Array {
  const tickCount = intents.length
  const bytes = new Uint8Array(tickCount * MAX_KARTS * INTENT_BYTES_PER_KART)
  const dv = new DataView(bytes.buffer)
  for (let t = 0; t < tickCount; t++) {
    const row = intents[t]
    if (row.length !== MAX_KARTS) {
      throw new Error(`golden: intent row ${t} has ${row.length} karts, expected ${MAX_KARTS}`)
    }
    for (let i = 0; i < MAX_KARTS; i++) {
      const off = (t * MAX_KARTS + i) * INTENT_BYTES_PER_KART
      const it = row[i]
      dv.setInt16(off, normZero(Math.round(it.steer * INTENT_SCALE)), true)
      dv.setInt16(off + 2, normZero(Math.round(it.accel * INTENT_SCALE)), true)
      dv.setUint8(off + 4, (it.brake ? 1 : 0) | (it.drift ? 2 : 0) | (it.useItem ? 4 : 0))
    }
  }
  return bytes
}

export function unpackIntents(bytes: Uint8Array, tickCount: number): Intent[][] {
  const need = tickCount * MAX_KARTS * INTENT_BYTES_PER_KART
  if (bytes.length !== need) {
    throw new Error(
      `golden: intent stream is ${bytes.length} bytes, expected ${need} for ${tickCount} ticks`,
    )
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const out: Intent[][] = []
  for (let t = 0; t < tickCount; t++) {
    const row: Intent[] = []
    for (let i = 0; i < MAX_KARTS; i++) {
      const off = (t * MAX_KARTS + i) * INTENT_BYTES_PER_KART
      const flags = dv.getUint8(off + 4)
      row.push({
        tick: t,
        steer: dv.getInt16(off, true) / INTENT_SCALE,
        accel: dv.getInt16(off + 2, true) / INTENT_SCALE,
        brake: (flags & 1) !== 0,
        drift: (flags & 2) !== 0,
        useItem: (flags & 4) !== 0,
      })
    }
    out.push(row)
  }
  return out
}

export function encodeB64Lines(bytes: Uint8Array): string[] {
  const b64 = Buffer.from(bytes).toString('base64')
  const out: string[] = []
  for (let i = 0; i < b64.length; i += B64_LINE_LENGTH) {
    out.push(b64.slice(i, i + B64_LINE_LENGTH))
  }
  return out
}

export function decodeB64Lines(lines: string[]): Uint8Array {
  return new Uint8Array(Buffer.from(lines.join(''), 'base64'))
}

/**
 * A regenerated golden fixture is a claim that a physics change was intentional. That claim can
 * only be made by a human looking at the diff, so regeneration is refused inside CI.
 */
export function assertRegenerationAllowed(env: Record<string, string | undefined>): void {
  for (const name of CI_ENV_FLAGS) {
    const raw = env[name]
    if (raw === undefined) continue
    const v = raw.trim().toLowerCase()
    if (v === '' || v === '0' || v === 'false') continue
    throw new Error(
      `golden: refusing to regenerate because ${name}=${raw}. A regenerated golden fixture is a ` +
        'claim that a physics change was intentional; it must be produced on a developer machine ' +
        `and reviewed in the diff. Unset ${name} to proceed.`,
    )
  }
}

export function readGoldenFixtureText(path: string = GOLDEN_PATH): string {
  return readFileSync(path, 'utf8')
}

export function loadGoldenFixture(path: string = GOLDEN_PATH): GoldenFixture {
  const fx = JSON.parse(readGoldenFixtureText(path)) as GoldenFixture
  if (fx.formatVersion !== GOLDEN_FORMAT_VERSION) {
    throw new Error(
      `golden: fixture formatVersion ${fx.formatVersion}, this build expects ` +
        `${GOLDEN_FORMAT_VERSION}. Regenerate it with: ${GOLDEN_REGEN_COMMAND}`,
    )
  }
  return fx
}

export function saveGoldenFixture(fx: GoldenFixture, path: string = GOLDEN_PATH): void {
  writeFileSync(path, `${JSON.stringify(fx, null, 2)}\n`, 'utf8')
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/sim/test/golden-format.test.ts`
Expected: PASS — 16 tests.

- [ ] **Step 5: Write the failing test for the comparison harness**

Create `packages/sim/test/golden-harness.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import type { AuthEvent, Intent } from '../src/types'
import { COUNTDOWN_TICKS, MAX_ENTITIES, MAX_KARTS, RACE_LAPS } from '../src/types'
import { makeContext, makeOvalTrack } from './fixtures/track-fixtures'
import type { GoldenExpectation } from './fixtures/golden-format'
import { GOLDEN_CHARACTER_IDX, GOLDEN_SEED, GOLDEN_TOL } from './fixtures/golden-format'
import {
  checkDrivability,
  describeDrivabilityFailure,
  diffAgainstGolden,
  diffEventSummary,
  formatDiffs,
  makeGoldenState,
  runGoldenTicks,
  summarizeEvents,
  toExpectation,
} from './fixtures/golden-harness'

function clone(e: GoldenExpectation): GoldenExpectation {
  return JSON.parse(JSON.stringify(e)) as GoldenExpectation
}

function ev(kind: AuthEvent['kind'], playerId: number, tick: number, seq: number): AuthEvent {
  return { eventSeq: seq, tick, kind, playerId, entityId: -1, item: 'none', data: 0 }
}

const ctx = makeContext(makeOvalTrack())

describe('makeGoldenState', () => {
  it('hands every one of the eight karts to the recorded stream', () => {
    const s = makeGoldenState(ctx, GOLDEN_SEED, GOLDEN_CHARACTER_IDX)
    expect(s.karts).toHaveLength(MAX_KARTS)
    expect(s.entities).toHaveLength(MAX_ENTITIES)
    expect(s.tick).toBe(0)
    expect(s.raceSeed).toBe(GOLDEN_SEED)
    for (let i = 0; i < MAX_KARTS; i++) {
      // Not bots at replay time: the stream drives them, so resolveInputs never bot-fills
      // and the golden is a physics test rather than a bot-AI test.
      expect(s.karts[i].isBot).toBe(false)
      expect(s.karts[i].connected).toBe(true)
      expect(s.karts[i].characterIdx).toBe(i)
    }
    for (let i = 0; i < MAX_ENTITIES; i++) {
      expect(s.entities[i].entityId).toBe(-1)
    }
  })
})

describe('toExpectation / diffAgainstGolden', () => {
  it('reports zero differences against the state it was built from', () => {
    const s = makeGoldenState(ctx, GOLDEN_SEED, GOLDEN_CHARACTER_IDX)
    const exp = toExpectation(s)
    expect(exp.karts).toHaveLength(MAX_KARTS)
    expect(exp.entityCount).toBe(0)
    expect(exp.entities).toHaveLength(0)
    expect(formatDiffs(diffAgainstGolden(exp, s))).toBe('')
    expect(diffAgainstGolden(exp, s)).toHaveLength(0)
  })

  it('ignores a continuous change below tolerance and reports one above it', () => {
    const s = makeGoldenState(ctx, GOLDEN_SEED, GOLDEN_CHARACTER_IDX)
    const base = toExpectation(s)

    // 1e-9 m is 1000x under the 1e-6 m position tolerance -> not a difference
    const under = clone(base)
    under.karts[2].position[0] += 1e-9
    expect(diffAgainstGolden(under, s)).toHaveLength(0)

    // 1e-5 m is 10x over it -> exactly one difference, and it names the field
    const over = clone(base)
    over.karts[2].position[0] += 1e-5
    const diffs = diffAgainstGolden(over, s)
    expect(diffs).toHaveLength(1)
    expect(diffs[0].path).toBe('karts[2].position.x')
    expect(diffs[0].tolerance).toBe(GOLDEN_TOL.position)
    expect(diffs[0].delta).toBeCloseTo(-1e-5, 12)
  })

  it('reports an integer field with zero tolerance and an exact delta', () => {
    const s = makeGoldenState(ctx, GOLDEN_SEED, GOLDEN_CHARACTER_IDX)
    const exp = toExpectation(s)
    exp.karts[5].lap.checkpointIdx += 1
    const diffs = diffAgainstGolden(exp, s)
    expect(diffs).toHaveLength(1)
    expect(diffs[0].path).toBe('karts[5].lap.checkpointIdx')
    expect(diffs[0].tolerance).toBe(0)
    expect(diffs[0].delta).toBe(-1)
  })

  it('reports an enum field by name with no delta', () => {
    const s = makeGoldenState(ctx, GOLDEN_SEED, GOLDEN_CHARACTER_IDX)
    const exp = toExpectation(s)
    exp.karts[1].item = exp.karts[1].item === 'none' ? 'boost' : 'none'
    const diffs = diffAgainstGolden(exp, s)
    expect(diffs).toHaveLength(1)
    expect(diffs[0].path).toBe('karts[1].item')
    expect(diffs[0].tolerance).toBe(0)
    expect(Number.isNaN(diffs[0].delta)).toBe(true)
  })

  it('compares headings as angles but still enforces the wrap invariant', () => {
    const s = makeGoldenState(ctx, GOLDEN_SEED, GOLDEN_CHARACTER_IDX)
    const exp = toExpectation(s)
    // h + 2*PI is the same angle, so the angular delta is ~0 (under the 1e-7 tolerance),
    // but every stored heading must live in (-PI, PI] and h + 2*PI never does.
    s.karts[0].heading = exp.karts[0].heading + 2 * Math.PI
    const diffs = diffAgainstGolden(exp, s)
    expect(diffs).toHaveLength(1)
    expect(diffs[0].path).toBe('karts[0].heading[wrapped]')
    expect(diffs[0].expected).toBe('(-PI, PI]')
    expect(diffs[0].tolerance).toBe(0)
  })

  it('refuses to store a non-finite number rather than writing JSON null', () => {
    const s = makeGoldenState(ctx, GOLDEN_SEED, GOLDEN_CHARACTER_IDX)
    s.karts[3].velocity.z = Number.POSITIVE_INFINITY
    expect(() => toExpectation(s)).toThrow(
      'golden: karts[3].velocity.z is not finite (Infinity); refusing to store it',
    )
  })
})

describe('formatDiffs', () => {
  it('is empty for no differences and names field, values, delta and tolerance otherwise', () => {
    expect(formatDiffs([])).toBe('')
    const text = formatDiffs([
      { path: 'karts[2].position.x', expected: 1.5, actual: 2, delta: 0.5, tolerance: 1e-6 },
    ])
    expect(text).toContain('1 field(s) differ from the golden fixture')
    expect(text).toContain('karts[2].position.x')
    expect(text).toContain('delta 5.000e-1')
    expect(text).toContain('tolerance 1e-6')
  })
})

describe('summarizeEvents / diffEventSummary', () => {
  it('counts every kind and records the finish order', () => {
    const events: AuthEvent[] = [
      ev('lapCross', 4, 300, 0),
      ev('respawn', 2, 310, 1),
      ev('finish', 4, 900, 2),
      ev('finish', 2, 950, 3),
      ev('finish', -1, 950, 4), // updatePhase's race-level event [Task 15]
    ]
    const s = summarizeEvents(events)
    expect(s.total).toBe(5)
    expect(s.countsByKind.lapCross).toBe(1)
    expect(s.countsByKind.respawn).toBe(1)
    expect(s.countsByKind.finish).toBe(3)   // counts include the race-level one
    expect(s.countsByKind.hit).toBe(0)
    // ...but the finishing order is per-kart, so the playerId -1 event is not in it
    expect(s.finishes).toEqual([
      { playerId: 4, tick: 900 },
      { playerId: 2, tick: 950 },
    ])
    expect(diffEventSummary(s, summarizeEvents(events))).toHaveLength(0)
  })

  it('names the kind whose count moved', () => {
    const a = summarizeEvents([ev('hit', 1, 10, 0)])
    const b = summarizeEvents([ev('hit', 1, 10, 0), ev('hit', 2, 11, 1)])
    const diffs = diffEventSummary(a, b)
    // Both summaries have zero finishes, so only the total and the hit count move.
    expect(diffs.map((d) => d.path)).toEqual(['events.total', 'events.countsByKind.hit'])
    expect(diffs[1].expected).toBe(1)
    expect(diffs[1].actual).toBe(2)
    expect(diffs[1].delta).toBe(1)
  })
})

describe('checkDrivability', () => {
  it('counts respawns and collects the distinct finishers', () => {
    const s = makeGoldenState(ctx, GOLDEN_SEED, GOLDEN_CHARACTER_IDX)
    const report = checkDrivability(s, [
      ev('respawn', 0, 100, 0),
      ev('respawn', 0, 200, 1),
      ev('finish', 3, 900, 2),
      ev('finish', 1, 910, 3),
      ev('finish', -1, 910, 4), // the race-level event is not a finisher
    ])
    expect(report.respawnCount).toBe(2)
    expect(report.finishedPlayerIds).toEqual([1, 3])   // no -1
    expect(report.lapsByPlayer).toHaveLength(MAX_KARTS)
    expect(report.allFinished).toBe(false) // 2 of 8 finished, and no kart has 3 laps
    expect(report.ok).toBe(false)
  })

  it('describes the failure with the karts that fell short', () => {
    const s = makeGoldenState(ctx, GOLDEN_SEED, GOLDEN_CHARACTER_IDX)
    const text = describeDrivabilityFailure(checkDrivability(s, [ev('finish', 0, 900, 0)]))
    expect(text).toContain('respawn events: 0 (must be 0)')
    expect(text).toContain(`karts that did not finish ${RACE_LAPS} laps`)
    expect(text).toContain('player 7 (lap')
  })
})

describe('runGoldenTicks', () => {
  it('advances exactly the requested number of ticks and clears the countdown', () => {
    const ticks = COUNTDOWN_TICKS + 60 // 180 + 60 = 240
    const intents: Intent[][] = []
    for (let t = 0; t < ticks; t++) {
      const row: Intent[] = []
      for (let i = 0; i < MAX_KARTS; i++) {
        row.push({ tick: t, steer: 0, accel: 0, brake: false, drift: false, useItem: false })
      }
      intents.push(row)
    }

    const run = runGoldenTicks(ctx, GOLDEN_SEED, GOLDEN_CHARACTER_IDX, intents, ticks)
    expect(run.ticks).toBe(240)
    expect(run.end.tick).toBe(240)
    expect(run.end.phase).toBe('racing') // COUNTDOWN_TICKS is 180, so 240 is past it
    expect(run.end.karts).toHaveLength(MAX_KARTS)
    expect(run.end.entities).toHaveLength(MAX_ENTITIES)
    // Nobody moves on accel 0, so nobody can leave the track
    expect(run.events.filter((e) => e.kind === 'respawn')).toHaveLength(0)
    // finishedOrder is fixed length MAX_KARTS with -1 in every unfilled slot, so
    // "nobody finished" is eight -1s, not an empty array.
    expect(run.end.finishedOrder).toEqual([-1, -1, -1, -1, -1, -1, -1, -1])
    expect(run.end.finishedOrder).toHaveLength(MAX_KARTS)
  })
})
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run packages/sim/test/golden-harness.test.ts`
Expected: FAIL with `Failed to resolve import "./fixtures/golden-harness" from "packages/sim/test/golden-harness.test.ts"`

- [ ] **Step 7: Write the comparison harness**

Create `packages/sim/test/fixtures/golden-harness.ts`:

```ts
// Runs a recorded intent stream through step() and compares the resulting SimState to a stored
// expectation field by field: exact for integers, enums and booleans, per-field tolerance for the
// continuous ones. Every difference carries its path, both values, the delta and the tolerance -
// which is precisely what a digest cannot do.
import type {
  AuthEvent,
  EntityState,
  Intent,
  KartState,
  SimContext,
  SimState,
  Vec3,
} from '../../src/types'
import { MAX_ENTITIES, MAX_KARTS, RACE_LAPS } from '../../src/types'
import { wrapAngle } from '../../src/mathutil'
import { createState } from '../../src/state'
import { step } from '../../src/step'
import { botIntent } from '../../src/bot'
import type {
  FieldDiff,
  GoldenEntity,
  GoldenEventSummary,
  GoldenExpectation,
  GoldenFixture,
  GoldenKart,
  GoldenTolerance,
} from './golden-format'
import {
  GOLDEN_TAIL_TICKS,
  GOLDEN_TOL,
  decodeB64Lines,
  normZero,
  quantizeIntent,
  unpackIntents,
} from './golden-format'

export interface GoldenRun {
  end: SimState
  events: AuthEvent[]
  ticks: number
}

export interface DrivabilityReport {
  respawnCount: number
  finishedPlayerIds: number[]
  lapsByPlayer: number[]
  allFinished: boolean
  ok: boolean
}

/**
 * The golden start state. Every kart is marked connected and not a bot, so at replay time the
 * recorded stream is the only input source and no bot fill can run. The stream itself was authored
 * by botIntent at regeneration time, which is what makes replaying it a test of the bot's line.
 */
export function makeGoldenState(ctx: SimContext, seed: number, characterIdx: number[]): SimState {
  const s = createState(ctx, seed, characterIdx)
  for (let i = 0; i < MAX_KARTS; i++) {
    s.karts[i].isBot = false
    s.karts[i].connected = true
  }
  return s
}

/** Runs exactly `ticks` ticks, double-buffered, accumulating every emitted event. */
export function runGoldenTicks(
  ctx: SimContext,
  seed: number,
  characterIdx: number[],
  intents: Intent[][],
  ticks: number,
): GoldenRun {
  if (intents.length < ticks) {
    throw new Error(`golden: intent stream has ${intents.length} rows, need ${ticks}`)
  }
  let cur = makeGoldenState(ctx, seed, characterIdx)
  let nxt = makeGoldenState(ctx, seed, characterIdx)
  const events: AuthEvent[] = []
  for (let t = 0; t < ticks; t++) {
    if (cur.tick !== t) {
      throw new Error(`golden: state is at tick ${cur.tick} while replaying row ${t}`)
    }
    step(ctx, cur, nxt, intents[t], events)
    const tmp = cur
    cur = nxt
    nxt = tmp
  }
  return { end: cur, events, ticks }
}

export function replayGoldenFixture(ctx: SimContext, fx: GoldenFixture): GoldenRun {
  const intents = unpackIntents(decodeB64Lines(fx.intentsB64), fx.tickCount)
  return runGoldenTicks(ctx, fx.raceSeed, fx.characterIdx, intents, fx.tickCount)
}

/**
 * Drives all eight karts with botIntent and records the resulting stream. Stops
 * GOLDEN_TAIL_TICKS after the last kart's finish event, or at maxTicks.
 *
 * Bots recompute an Intent only on even ticks and reuse it on odd ticks, per the contract's
 * 30Hz-input-against-a-60Hz-sim convention.
 */
export function recordGoldenWithBots(
  ctx: SimContext,
  seed: number,
  characterIdx: number[],
  maxTicks: number,
): { run: GoldenRun; intents: Intent[][] } {
  let cur = makeGoldenState(ctx, seed, characterIdx)
  let nxt = makeGoldenState(ctx, seed, characterIdx)
  const events: AuthEvent[] = []
  const intents: Intent[][] = []
  const held: Intent[] = []
  for (let i = 0; i < MAX_KARTS; i++) {
    held.push({ tick: 0, steer: 0, accel: 0, brake: false, drift: false, useItem: false })
  }
  const finished = new Set<number>()
  let allFinishedAt = -1
  let ticks = 0

  while (ticks < maxTicks) {
    if (cur.tick !== ticks) {
      throw new Error(`golden: state is at tick ${cur.tick} while recording row ${ticks}`)
    }
    const row: Intent[] = []
    for (let i = 0; i < MAX_KARTS; i++) {
      if (cur.tick % 2 === 0) {
        const raw = botIntent(ctx, cur, i)
        held[i].steer = raw.steer
        held[i].accel = raw.accel
        held[i].brake = raw.brake
        held[i].drift = raw.drift
        held[i].useItem = raw.useItem
      }
      row.push(quantizeIntent(held[i], cur.tick))
    }
    intents.push(row)

    const before = events.length
    step(ctx, cur, nxt, row, events)
    const tmp = cur
    cur = nxt
    nxt = tmp
    ticks++

    for (let e = before; e < events.length; e++) {
      // playerId >= 0 only: updatePhase's race-level 'finish' carries -1.
      if (events[e].kind === 'finish' && events[e].playerId >= 0) finished.add(events[e].playerId)
    }
    if (allFinishedAt < 0 && finished.size >= MAX_KARTS) allFinishedAt = ticks
    if (allFinishedAt >= 0 && ticks >= allFinishedAt + GOLDEN_TAIL_TICKS) break
  }

  return { run: { end: cur, events, ticks }, intents }
}

function assertFinite(path: string, v: number): number {
  if (!Number.isFinite(v)) {
    throw new Error(`golden: ${path} is not finite (${v}); refusing to store it`)
  }
  return normZero(v)
}

function vec(path: string, v: Vec3): [number, number, number] {
  return [
    assertFinite(`${path}.x`, v.x),
    assertFinite(`${path}.y`, v.y),
    assertFinite(`${path}.z`, v.z),
  ]
}

export function toExpectation(state: SimState): GoldenExpectation {
  const karts: GoldenKart[] = []
  for (let i = 0; i < MAX_KARTS; i++) {
    const k = state.karts[i]
    karts.push({
      playerId: k.playerId,
      characterIdx: k.characterIdx,
      isBot: k.isBot,
      connected: k.connected,
      position: vec(`karts[${i}].position`, k.position),
      velocity: vec(`karts[${i}].velocity`, k.velocity),
      heading: assertFinite(`karts[${i}].heading`, k.heading),
      angularVelocity: assertFinite(`karts[${i}].angularVelocity`, k.angularVelocity),
      drift: {
        active: k.drift.active,
        dir: k.drift.dir,
        charge: assertFinite(`karts[${i}].drift.charge`, k.drift.charge),
      },
      item: k.item,
      airborne: k.airborne,
      surface: k.surface,
      spinOutTicks: k.spinOutTicks,
      invulnTicks: k.invulnTicks,
      boostTicks: k.boostTicks,
      respawnTicks: k.respawnTicks,
      shielded: k.shielded,
      lap: {
        lap: k.lap.lap,
        checkpointIdx: k.lap.checkpointIdx,
        t: assertFinite(`karts[${i}].lap.t`, k.lap.t),
      },
    })
  }

  const entities: GoldenEntity[] = []
  for (let i = 0; i < state.entityCount; i++) {
    const e = state.entities[i]
    entities.push({
      entityId: e.entityId,
      kind: e.kind,
      ownerId: e.ownerId,
      position: vec(`entities[${i}].position`, e.position),
      velocity: vec(`entities[${i}].velocity`, e.velocity),
      heading: assertFinite(`entities[${i}].heading`, e.heading),
      targetId: e.targetId,
      ttl: e.ttl,
    })
  }

  return {
    tick: state.tick,
    phase: state.phase,
    raceSeed: state.raceSeed,
    rngCursor: state.rngCursor,
    nextEventSeq: state.nextEventSeq,
    finishTick: state.finishTick,
    entityCount: state.entityCount,
    nextEntityId: state.nextEntityId,
    finishedOrder: state.finishedOrder.slice(),
    itemBoxes: state.itemBoxes.map((b) => ({ boxIdx: b.boxIdx, respawnTicks: b.respawnTicks })),
    karts,
    entities,
  }
}

function exact(
  out: FieldDiff[],
  path: string,
  expected: number | string | boolean,
  actual: number | string | boolean,
): void {
  const e = typeof expected === 'number' ? normZero(expected) : expected
  const a = typeof actual === 'number' ? normZero(actual) : actual
  if (Object.is(e, a)) return
  const delta = typeof e === 'number' && typeof a === 'number' ? a - e : Number.NaN
  out.push({ path, expected, actual, delta, tolerance: 0 })
}

function approx(
  out: FieldDiff[],
  path: string,
  expected: number,
  actual: number,
  tolerance: number,
): void {
  const delta = actual - expected
  // Written as a negated <= so a NaN actual is always reported.
  if (Math.abs(delta) <= tolerance) return
  out.push({ path, expected, actual, delta, tolerance })
}

/** Headings are compared as angles: the shortest signed difference, wrapped to (-PI, PI]. */
function approxAngle(
  out: FieldDiff[],
  path: string,
  expected: number,
  actual: number,
  tolerance: number,
): void {
  const delta = wrapAngle(actual - expected)
  if (Math.abs(delta) <= tolerance) return
  out.push({ path, expected, actual, delta, tolerance })
}

/** Every stored heading must already be wrapped; an unwrapped one is a contract violation. */
function checkWrapped(out: FieldDiff[], path: string, actual: number): void {
  if (actual > -Math.PI && actual <= Math.PI) return
  out.push({
    path: `${path}[wrapped]`,
    expected: '(-PI, PI]',
    actual,
    delta: Number.NaN,
    tolerance: 0,
  })
}

function diffKart(
  out: FieldDiff[],
  i: number,
  e: GoldenKart,
  a: KartState,
  tol: GoldenTolerance,
): void {
  const p = `karts[${i}]`
  exact(out, `${p}.playerId`, e.playerId, a.playerId)
  exact(out, `${p}.characterIdx`, e.characterIdx, a.characterIdx)
  exact(out, `${p}.isBot`, e.isBot, a.isBot)
  exact(out, `${p}.connected`, e.connected, a.connected)
  approx(out, `${p}.position.x`, e.position[0], a.position.x, tol.position)
  approx(out, `${p}.position.y`, e.position[1], a.position.y, tol.position)
  approx(out, `${p}.position.z`, e.position[2], a.position.z, tol.position)
  approx(out, `${p}.velocity.x`, e.velocity[0], a.velocity.x, tol.velocity)
  approx(out, `${p}.velocity.y`, e.velocity[1], a.velocity.y, tol.velocity)
  approx(out, `${p}.velocity.z`, e.velocity[2], a.velocity.z, tol.velocity)
  approxAngle(out, `${p}.heading`, e.heading, a.heading, tol.heading)
  checkWrapped(out, `${p}.heading`, a.heading)
  approx(out, `${p}.angularVelocity`, e.angularVelocity, a.angularVelocity, tol.angularVelocity)
  exact(out, `${p}.drift.active`, e.drift.active, a.drift.active)
  exact(out, `${p}.drift.dir`, e.drift.dir, a.drift.dir)
  approx(out, `${p}.drift.charge`, e.drift.charge, a.drift.charge, tol.driftCharge)
  exact(out, `${p}.item`, e.item, a.item)
  exact(out, `${p}.airborne`, e.airborne, a.airborne)
  exact(out, `${p}.surface`, e.surface, a.surface)
  exact(out, `${p}.spinOutTicks`, e.spinOutTicks, a.spinOutTicks)
  exact(out, `${p}.invulnTicks`, e.invulnTicks, a.invulnTicks)
  exact(out, `${p}.boostTicks`, e.boostTicks, a.boostTicks)
  exact(out, `${p}.respawnTicks`, e.respawnTicks, a.respawnTicks)
  exact(out, `${p}.shielded`, e.shielded, a.shielded)
  exact(out, `${p}.lap.lap`, e.lap.lap, a.lap.lap)
  exact(out, `${p}.lap.checkpointIdx`, e.lap.checkpointIdx, a.lap.checkpointIdx)
  approx(out, `${p}.lap.t`, e.lap.t, a.lap.t, tol.lapT)
}

function diffEntity(
  out: FieldDiff[],
  i: number,
  e: GoldenEntity,
  a: EntityState,
  tol: GoldenTolerance,
): void {
  const p = `entities[${i}]`
  exact(out, `${p}.entityId`, e.entityId, a.entityId)
  exact(out, `${p}.kind`, e.kind, a.kind)
  exact(out, `${p}.ownerId`, e.ownerId, a.ownerId)
  approx(out, `${p}.position.x`, e.position[0], a.position.x, tol.position)
  approx(out, `${p}.position.y`, e.position[1], a.position.y, tol.position)
  approx(out, `${p}.position.z`, e.position[2], a.position.z, tol.position)
  approx(out, `${p}.velocity.x`, e.velocity[0], a.velocity.x, tol.velocity)
  approx(out, `${p}.velocity.y`, e.velocity[1], a.velocity.y, tol.velocity)
  approx(out, `${p}.velocity.z`, e.velocity[2], a.velocity.z, tol.velocity)
  approxAngle(out, `${p}.heading`, e.heading, a.heading, tol.heading)
  checkWrapped(out, `${p}.heading`, a.heading)
  exact(out, `${p}.targetId`, e.targetId, a.targetId)
  exact(out, `${p}.ttl`, e.ttl, a.ttl)
}

export function diffAgainstGolden(
  exp: GoldenExpectation,
  act: SimState,
  tol: GoldenTolerance = GOLDEN_TOL,
): FieldDiff[] {
  const out: FieldDiff[] = []

  exact(out, 'tick', exp.tick, act.tick)
  exact(out, 'phase', exp.phase, act.phase)
  exact(out, 'raceSeed', exp.raceSeed, act.raceSeed)
  exact(out, 'rngCursor', exp.rngCursor, act.rngCursor)
  exact(out, 'nextEventSeq', exp.nextEventSeq, act.nextEventSeq)
  exact(out, 'finishTick', exp.finishTick, act.finishTick)
  exact(out, 'entityCount', exp.entityCount, act.entityCount)
  exact(out, 'nextEntityId', exp.nextEntityId, act.nextEntityId)
  exact(out, 'karts.length', MAX_KARTS, act.karts.length)
  exact(out, 'entities.length', MAX_ENTITIES, act.entities.length)

  exact(out, 'finishedOrder.length', exp.finishedOrder.length, act.finishedOrder.length)
  const nOrder = Math.min(exp.finishedOrder.length, act.finishedOrder.length)
  for (let i = 0; i < nOrder; i++) {
    exact(out, `finishedOrder[${i}]`, exp.finishedOrder[i], act.finishedOrder[i])
  }

  exact(out, 'itemBoxes.length', exp.itemBoxes.length, act.itemBoxes.length)
  const nBox = Math.min(exp.itemBoxes.length, act.itemBoxes.length)
  for (let i = 0; i < nBox; i++) {
    exact(out, `itemBoxes[${i}].boxIdx`, exp.itemBoxes[i].boxIdx, act.itemBoxes[i].boxIdx)
    exact(
      out,
      `itemBoxes[${i}].respawnTicks`,
      exp.itemBoxes[i].respawnTicks,
      act.itemBoxes[i].respawnTicks,
    )
  }

  const nKart = Math.min(MAX_KARTS, act.karts.length, exp.karts.length)
  for (let i = 0; i < nKart; i++) diffKart(out, i, exp.karts[i], act.karts[i], tol)

  const nLive = Math.min(exp.entityCount, exp.entities.length, act.entities.length)
  for (let i = 0; i < nLive; i++) diffEntity(out, i, exp.entities[i], act.entities[i], tol)
  // Live entities are packed at the front, so every slot past entityCount holds the dead sentinel.
  for (let i = exp.entityCount; i < act.entities.length; i++) {
    exact(out, `entities[${i}].entityId`, -1, act.entities[i].entityId)
  }

  return out
}

export function summarizeEvents(events: AuthEvent[]): GoldenEventSummary {
  const countsByKind: Record<string, number> = {
    itemGrant: 0,
    entitySpawn: 0,
    entityDespawn: 0,
    hit: 0,
    spinOut: 0,
    respawn: 0,
    lapCross: 0,
    finish: 0,
  }
  const finishes: { playerId: number; tick: number }[] = []
  for (const e of events) {
    countsByKind[e.kind] = (countsByKind[e.kind] ?? 0) + 1
    // Every event counts toward countsByKind, including updatePhase's race-level 'finish'
    // (playerId -1). `finishes` is the per-kart finishing ORDER, so it takes playerId >= 0 only.
    if (e.kind === 'finish' && e.playerId >= 0) finishes.push({ playerId: e.playerId, tick: e.tick })
  }
  return { total: events.length, countsByKind, finishes }
}

export function diffEventSummary(
  exp: GoldenEventSummary,
  act: GoldenEventSummary,
): FieldDiff[] {
  const out: FieldDiff[] = []
  exact(out, 'events.total', exp.total, act.total)
  const kinds = Object.keys(exp.countsByKind).sort()
  for (const kind of kinds) {
    exact(out, `events.countsByKind.${kind}`, exp.countsByKind[kind], act.countsByKind[kind] ?? -1)
  }
  exact(out, 'events.finishes.length', exp.finishes.length, act.finishes.length)
  const n = Math.min(exp.finishes.length, act.finishes.length)
  for (let i = 0; i < n; i++) {
    exact(out, `events.finishes[${i}].playerId`, exp.finishes[i].playerId, act.finishes[i].playerId)
    exact(out, `events.finishes[${i}].tick`, exp.finishes[i].tick, act.finishes[i].tick)
  }
  return out
}

/**
 * The spec's bot-drivability criterion: every kart finishes RACE_LAPS laps, with zero respawns.
 *
 * updatePhase [Task 15] emits ONE race-level 'finish' event with playerId -1 when the race ends,
 * on top of the per-kart 'finish' events updateLaps [Task 11] emits. Counting that one as a
 * finisher would make finishedPlayerIds nine entries long and allFinished permanently false, so
 * finishers are collected from playerId >= 0 only.
 */
export function checkDrivability(state: SimState, events: AuthEvent[]): DrivabilityReport {
  let respawnCount = 0
  const finished = new Set<number>()
  for (const e of events) {
    if (e.kind === 'respawn') respawnCount++
    else if (e.kind === 'finish' && e.playerId >= 0) finished.add(e.playerId)
  }
  const finishedPlayerIds = Array.from(finished).sort((a, b) => a - b)
  const lapsByPlayer: number[] = []
  for (let i = 0; i < MAX_KARTS; i++) lapsByPlayer.push(state.karts[i].lap.lap)
  const allFinished =
    finishedPlayerIds.length === MAX_KARTS && lapsByPlayer.every((l) => l >= RACE_LAPS)
  return { respawnCount, finishedPlayerIds, lapsByPlayer, allFinished, ok: allFinished && respawnCount === 0 }
}

export function describeDrivabilityFailure(d: DrivabilityReport): string {
  const missing: string[] = []
  for (let i = 0; i < MAX_KARTS; i++) {
    if (!d.finishedPlayerIds.includes(i)) missing.push(`player ${i} (lap ${d.lapsByPlayer[i]})`)
  }
  return (
    `golden: bot-drivability failed. respawn events: ${d.respawnCount} (must be 0); ` +
    `karts that did not finish ${RACE_LAPS} laps: ${missing.length === 0 ? 'none' : missing.join(', ')}; ` +
    `laps by player: [${d.lapsByPlayer.join(', ')}]`
  )
}

function fmtValue(v: number | string | boolean): string {
  if (typeof v !== 'number') return JSON.stringify(v)
  return Number.isInteger(v) ? String(v) : v.toPrecision(12)
}

export function formatDiffs(diffs: FieldDiff[]): string {
  if (diffs.length === 0) return ''
  const lines = diffs.map(
    (d) =>
      `${d.path}: expected ${fmtValue(d.expected)}, actual ${fmtValue(d.actual)}, ` +
      `delta ${Number.isNaN(d.delta) ? 'n/a' : d.delta.toExponential(3)}, ` +
      `tolerance ${d.tolerance === 0 ? 'exact' : d.tolerance.toExponential(0)}`,
  )
  return `${diffs.length} field(s) differ from the golden fixture:\n  ${lines.join('\n  ')}`
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npx vitest run packages/sim/test/golden-harness.test.ts`
Expected: PASS — 13 tests.

- [ ] **Step 9: Write the golden-replay test (it fails: no fixture yet)**

Create `packages/sim/test/golden-replay.test.ts`:

```ts
import { beforeAll, describe, expect, it } from 'vitest'

import type { SimContext } from '../src/types'
import { COUNTDOWN_TICKS, MAX_ENTITIES, MAX_KARTS, RACE_LAPS } from '../src/types'
import { makeContext, makeOvalTrack, makeTuning } from './fixtures/track-fixtures'
import type { GoldenExpectation, GoldenFixture } from './fixtures/golden-format'
import {
  GOLDEN_CHARACTER_IDX,
  GOLDEN_FORMAT_VERSION,
  GOLDEN_REGEN_COMMAND,
  GOLDEN_SEED,
  GOLDEN_TOL,
  INTENT_BYTES_PER_KART,
  INTENT_SCALE,
  MAX_GOLDEN_TICKS,
  decodeB64Lines,
  loadGoldenFixture,
  readGoldenFixtureText,
} from './fixtures/golden-format'
import {
  checkDrivability,
  diffAgainstGolden,
  diffEventSummary,
  formatDiffs,
  replayGoldenFixture,
  summarizeEvents,
} from './fixtures/golden-harness'
import type { GoldenRun } from './fixtures/golden-harness'

function clone(e: GoldenExpectation): GoldenExpectation {
  return JSON.parse(JSON.stringify(e)) as GoldenExpectation
}

let ctx: SimContext
let fixture: GoldenFixture
let run: GoldenRun

beforeAll(() => {
  ctx = makeContext(makeOvalTrack())
  fixture = loadGoldenFixture()
  run = replayGoldenFixture(ctx, fixture)
}, 180_000)

describe('golden fixture: 3-lap 8-bot race on makeOvalTrack', () => {
  it('is the race it claims to be', () => {
    expect(fixture.formatVersion).toBe(GOLDEN_FORMAT_VERSION)
    expect(fixture.generatedBy).toBe(GOLDEN_REGEN_COMMAND)
    expect(fixture.trackId).toBe(ctx.track.id)
    expect(fixture.raceSeed).toBe(GOLDEN_SEED)
    expect(fixture.raceSeed).toBe(20260813)
    expect(fixture.characterIdx).toEqual(GOLDEN_CHARACTER_IDX)
    expect(fixture.intentScale).toBe(INTENT_SCALE)
    expect(fixture.expected.raceSeed).toBe(GOLDEN_SEED)

    // The stream must cover every tick for every kart: tickCount * 8 karts * 5 bytes.
    const bytes = decodeB64Lines(fixture.intentsB64)
    expect(bytes.length).toBe(fixture.tickCount * MAX_KARTS * INTENT_BYTES_PER_KART)
  })

  it('lasts at least as long as physics allows for three laps', () => {
    // Absolute speed ceiling from the contract's targetSpeed product:
    //   maxSpeed 40 * fastest character speed 1.15 (character 5) * accel 1
    //   * surfaceSpeedFactor <= 1 * surge 0.7-or-1 * boostSpeedMul 1.35  =  62.1 m/s
    const ceilingSpeed = 40 * 1.15 * 1.35 // 62.1
    expect(ceilingSpeed).toBeCloseTo(62.1, 10)
    // Karts are frozen for the 180-tick countdown, then must cover 3 * trackLength metres.
    const lapMetres = ctx.query.totalLength()
    const floorTicks = COUNTDOWN_TICKS + Math.floor(((RACE_LAPS * lapMetres) / ceilingSpeed) * 60)
    expect(fixture.tickCount).toBeGreaterThan(floorTicks)
    expect(fixture.tickCount).toBeLessThanOrEqual(MAX_GOLDEN_TICKS)
    expect(run.ticks).toBe(fixture.tickCount)
  })

  it('carries no timestamp, hostname or absolute path', () => {
    const raw = readGoldenFixtureText()
    expect(Object.keys(fixture).sort()).toEqual([
      'characterIdx',
      'events',
      'expected',
      'formatVersion',
      'generatedBy',
      'intentScale',
      'intentsB64',
      'raceSeed',
      'tickCount',
      'trackId',
    ])
    expect(raw).not.toMatch(/\/home\//)
    expect(raw).not.toMatch(/\/Users\//)
    expect(raw).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/)
  })
})

describe('bot-drivability criterion', () => {
  it('finishes all three laps on all eight karts with zero respawns', () => {
    // Both halves of the spec §8 criterion are asserted here, and neither one alone is it:
    //   (a) all 8 karts complete RACE_LAPS laps, and
    //   (b) zero 'respawn' events across the entire run.
    const d = checkDrivability(run.end, run.events)

    // (b) "zero respawns" - the AuthEvent kind exists exactly so this is checkable.
    expect(d.respawnCount).toBe(0)
    expect(run.events.filter((e) => e.kind === 'respawn')).toHaveLength(0)
    expect(fixture.events.countsByKind.respawn).toBe(0)

    // (a) all eight finish the full race distance
    expect(d.finishedPlayerIds).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    expect(d.lapsByPlayer).toHaveLength(MAX_KARTS)
    for (let i = 0; i < MAX_KARTS; i++) {
      expect(d.lapsByPlayer[i]).toBeGreaterThanOrEqual(RACE_LAPS) // RACE_LAPS is 3
    }
    expect(d.allFinished).toBe(true)
    expect(d.ok).toBe(true)

    // finishedOrder is fixed length MAX_KARTS; every slot is filled, none left at -1
    expect(run.end.finishedOrder).toHaveLength(MAX_KARTS)
    expect(run.end.finishedOrder.filter((p) => p === -1)).toHaveLength(0)
    expect([...run.end.finishedOrder].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    expect(fixture.events.finishes).toHaveLength(MAX_KARTS)
    // 8 per-kart finish events from updateLaps [Task 11] + the 1 race-level event
    // updatePhase [Task 15] emits with playerId -1 = 9.
    expect(fixture.events.countsByKind.finish).toBe(MAX_KARTS + 1)

    // The first finish cannot happen during the 180-tick countdown, and the run keeps
    // recording for 60 ticks after the last kart finishes.
    expect(run.end.finishTick).toBeGreaterThan(COUNTDOWN_TICKS)
    expect(run.end.finishTick).toBeLessThan(run.end.tick)
  })
})

describe('replaying the recorded stream', () => {
  it('reproduces the stored state field by field', () => {
    const diffs = diffAgainstGolden(fixture.expected, run.end)
    // formatDiffs names every field, both values, the delta and the tolerance - which is
    // exactly what a digest mismatch cannot do.
    expect(formatDiffs(diffs)).toBe('')
    expect(diffs).toHaveLength(0)
    expect(run.end.karts).toHaveLength(MAX_KARTS)
    expect(run.end.entities).toHaveLength(MAX_ENTITIES)
    expect(fixture.expected.karts).toHaveLength(MAX_KARTS)
    expect(fixture.expected.entities).toHaveLength(fixture.expected.entityCount)
  })

  it('reproduces the stored event stream', () => {
    expect(formatDiffs(diffEventSummary(fixture.events, summarizeEvents(run.events)))).toBe('')
    expect(run.events).toHaveLength(fixture.events.total)
    for (let i = 1; i < run.events.length; i++) {
      expect(run.events[i].eventSeq).toBeGreaterThan(run.events[i - 1].eventSeq)
      expect(run.events[i].tick).toBeGreaterThanOrEqual(run.events[i - 1].tick)
    }
  })

  it('is deterministic across two runs in the same process', () => {
    const again = replayGoldenFixture(ctx, fixture)
    expect(formatDiffs(diffAgainstGolden(fixture.expected, again.end))).toBe('')
    expect(again.events).toHaveLength(run.events.length)
  })
})

describe('the fixture detects change', () => {
  it('catches a corrupted stored value and names the field', () => {
    // Below tolerance: 1e-9 m against a 1e-6 m band -> not a difference.
    const under = clone(fixture.expected)
    under.karts[3].position[0] += 1e-9
    expect(diffAgainstGolden(under, run.end)).toHaveLength(0)

    // Above tolerance: half a metre is 500000x the band -> exactly one named difference.
    const over = clone(fixture.expected)
    over.karts[3].position[0] += 0.5
    const posDiffs = diffAgainstGolden(over, run.end)
    expect(posDiffs).toHaveLength(1)
    expect(posDiffs[0].path).toBe('karts[3].position.x')
    expect(posDiffs[0].tolerance).toBe(GOLDEN_TOL.position)
    expect(posDiffs[0].delta).toBeLessThan(-0.4999999)
    expect(posDiffs[0].delta).toBeGreaterThan(-0.5000001)

    // An integer field has no band at all: one off is one difference.
    const lapCorrupt = clone(fixture.expected)
    lapCorrupt.karts[6].lap.lap += 1
    const lapDiffs = diffAgainstGolden(lapCorrupt, run.end)
    expect(lapDiffs).toHaveLength(1)
    expect(lapDiffs[0].path).toBe('karts[6].lap.lap')
    expect(lapDiffs[0].tolerance).toBe(0)
    expect(lapDiffs[0].delta).toBe(-1)

    // And a corrupted event count is caught by the event comparison, not the state one.
    const eventsCorrupt = JSON.parse(JSON.stringify(fixture.events)) as typeof fixture.events
    eventsCorrupt.countsByKind.finish -= 1
    const evDiffs = diffEventSummary(eventsCorrupt, summarizeEvents(run.events))
    expect(evDiffs.map((d) => d.path)).toContain('events.countsByKind.finish')
  })

  it('catches a one-part-in-240000 physics change on every kart', () => {
    // accelRate 24 -> 24.0001. One tick of that difference is
    //   0.0001 m/s^2 * TICK_DT (1/60 s) = 1.67e-6 m/s, already above the 1e-6 velocity band,
    // and it compounds over the whole race. Same recorded inputs, different physics.
    const bent = { ...ctx, tuning: makeTuning({ accelRate: 24.0001 }) }
    const bentRun = replayGoldenFixture(bent, fixture)
    const diffs = diffAgainstGolden(fixture.expected, bentRun.end)

    expect(diffs.length).toBeGreaterThanOrEqual(MAX_KARTS)
    const paths = diffs.map((d) => d.path)
    for (let i = 0; i < MAX_KARTS; i++) {
      const moved =
        paths.includes(`karts[${i}].position.x`) || paths.includes(`karts[${i}].position.z`)
      expect(moved).toBe(true)
    }
  })
})
```

- [ ] **Step 10: Run test to verify it fails**

Run: `npx vitest run packages/sim/test/golden-replay.test.ts`
Expected: FAIL — every test errors out of `beforeAll` with
`ENOENT: no such file or directory, open '.../packages/sim/test/fixtures/golden-oval-3lap-8bot.json'`

- [ ] **Step 11: Write the regeneration entry point and its documentation**

Create `packages/sim/test/golden-regen.test.ts`:

```ts
// Regenerating the golden fixture is an explicit, opt-in, developer-machine-only act:
//
//   UPDATE_GOLDEN=1 npx vitest run packages/sim/test/golden-regen.test.ts
//
// Without UPDATE_GOLDEN=1 the regeneration case is skipped, so this file is inert in a normal
// suite run. With UPDATE_GOLDEN=1 inside CI it fails loudly instead of quietly rewriting the
// thing CI is supposed to be checking.
import { describe, expect, it } from 'vitest'

import { MAX_KARTS } from '../src/types'
import { makeContext, makeOvalTrack } from './fixtures/track-fixtures'
import type { GoldenFixture } from './fixtures/golden-format'
import {
  GOLDEN_CHARACTER_IDX,
  GOLDEN_FORMAT_VERSION,
  GOLDEN_PATH,
  GOLDEN_REGEN_COMMAND,
  GOLDEN_SEED,
  INTENT_SCALE,
  MAX_GOLDEN_TICKS,
  assertRegenerationAllowed,
  encodeB64Lines,
  loadGoldenFixture,
  packIntents,
  saveGoldenFixture,
} from './fixtures/golden-format'
import {
  checkDrivability,
  describeDrivabilityFailure,
  diffAgainstGolden,
  formatDiffs,
  recordGoldenWithBots,
  replayGoldenFixture,
  summarizeEvents,
  toExpectation,
} from './fixtures/golden-harness'

const WANTS_REGEN = process.env.UPDATE_GOLDEN === '1'

describe('golden fixture regeneration', () => {
  it('refuses to run under CI, whatever the flag is called', () => {
    expect(() => assertRegenerationAllowed({ CI: 'true' })).toThrow(
      /refusing to regenerate because CI=true/,
    )
    expect(() => assertRegenerationAllowed({ GITHUB_ACTIONS: 'true' })).toThrow(
      /refusing to regenerate because GITHUB_ACTIONS=true/,
    )
    expect(() => assertRegenerationAllowed({ CONTINUOUS_INTEGRATION: 'yes' })).toThrow(
      /refusing to regenerate because CONTINUOUS_INTEGRATION=yes/,
    )
    expect(() => assertRegenerationAllowed({ CI: 'false' })).not.toThrow()
  })

  it.runIf(WANTS_REGEN)(
    'records a fresh 3-lap 8-bot race and writes the fixture',
    () => {
      assertRegenerationAllowed(process.env)

      const ctx = makeContext(makeOvalTrack())
      const rec = recordGoldenWithBots(ctx, GOLDEN_SEED, GOLDEN_CHARACTER_IDX, MAX_GOLDEN_TICKS)

      const drive = checkDrivability(rec.run.end, rec.run.events)
      if (!drive.ok) throw new Error(describeDrivabilityFailure(drive))
      expect(drive.finishedPlayerIds).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
      expect(drive.respawnCount).toBe(0)
      expect(rec.intents).toHaveLength(rec.run.ticks)
      expect(rec.intents[0]).toHaveLength(MAX_KARTS)

      const fx: GoldenFixture = {
        formatVersion: GOLDEN_FORMAT_VERSION,
        generatedBy: GOLDEN_REGEN_COMMAND,
        trackId: ctx.track.id,
        raceSeed: GOLDEN_SEED,
        characterIdx: GOLDEN_CHARACTER_IDX.slice(),
        tickCount: rec.run.ticks,
        intentScale: INTENT_SCALE,
        intentsB64: encodeB64Lines(packIntents(rec.intents)),
        expected: toExpectation(rec.run.end),
        events: summarizeEvents(rec.run.events),
      }
      saveGoldenFixture(fx)

      // A fixture that cannot reproduce itself is worse than no fixture, so prove it on the
      // way out - reload from disk and replay the stream we just wrote.
      const reloaded = loadGoldenFixture()
      const check = replayGoldenFixture(ctx, reloaded)
      expect(formatDiffs(diffAgainstGolden(reloaded.expected, check.end))).toBe('')

      // eslint-disable-next-line no-console
      console.log(
        `golden: wrote ${GOLDEN_PATH} - ${fx.tickCount} ticks, ` +
          `${fx.events.total} events, finish order [${fx.expected.finishedOrder.join(', ')}]`,
      )
    },
    600_000,
  )
})
```

Create `packages/sim/test/fixtures/GOLDEN.md`:

````md
# The golden-replay fixture

`golden-oval-3lap-8bot.json` is a recorded input stream for a full 3-lap, 8-kart race on
`makeOvalTrack`, plus the exact `SimState` and event stream that replaying it must produce.

## What it asserts

1. **Field-by-field state equality.** Every field of `SimState` after the final tick, compared by
   name: exactly for integers, enums and booleans, and within a stated per-field tolerance for the
   continuous ones.
2. **The event stream.** Total count, count per `AuthEventKind`, and the `(playerId, tick)` of every
   per-kart `finish` event. `updatePhase` also emits one race-level `finish` with `playerId -1` when
   the race ends: it is counted in `countsByKind.finish` (so a full race shows 9, not 8) but is not
   part of `finishes`, which is the finishing order.
3. **The spec's bot-drivability criterion.** Every kart finishes `RACE_LAPS` (3) laps *and* zero
   `respawn` events occurred across the entire run. `respawn` is one of the eight `AuthEventKind`s
   for exactly this reason: a track the bots cannot drive announces itself as respawn traffic.

## Why not a hash

A digest compresses ~1000 numbers into one. When it mismatches, the failure reads
`expected "a3f1c2…" to be "9c0417…"` — it **names no field, no value and no delta**. It cannot tell
"the drift charge tier boundary moved one tick" from "kart 6 fell through the floor on lap 2", nor
1e-15 metres of harmless float noise from 40 metres of broken physics. Every mismatch costs a bisect.

A digest also forces exact comparison onto continuous fields, so a legal re-association of a
floating-point sum turns the suite red for no behavioural reason. Teams respond by regenerating
reflexively, and a reflexively-regenerated fixture asserts nothing.

This fixture therefore compares fields and prints, for each difference: the path, the expected
value, the actual value, the delta, and the tolerance that was applied.

## Tolerances

| Field | Tolerance | Compared as |
|---|---|---|
| `position.{x,y,z}` | 1e-6 m | band |
| `velocity.{x,y,z}` | 1e-6 m/s | band |
| `heading` | 1e-7 rad | shortest signed angle, wrapped to (-PI, PI] |
| `angularVelocity` | 1e-7 rad/s | band |
| `drift.charge` | 1e-6 | band |
| `lap.t` | 1e-9 | band |
| everything else | — | exact (`Object.is`, with `-0` normalised to `+0`) |

Sizing: at a position magnitude of ~1e3 m one ULP is ~1.1e-13 m, so a few thousand ticks of
fully-correlated round-off is bounded near 4e-10 m. The smallest physically meaningful change is one
tick of acceleration — `accelRate` 24 m/s² × `TICK_DT` 1/60 s = 0.4 m/s, i.e. 6.7e-3 m of position.
The tolerance sits about six orders of magnitude above the noise and six below the signal.

Headings are compared as angles so that a kart sitting on ±π does not report a 2π "difference" that
is really the same direction. The wrap invariant is checked separately: any heading outside
(-PI, PI] is reported as `…heading[wrapped]`.

## Format

```
formatVersion  1
generatedBy    the command that regenerates this file
trackId        makeOvalTrack().id
raceSeed       20260813
characterIdx   [0,1,2,3,4,5,6,7]  - one of each character
tickCount      number of recorded ticks
intentScale    10000  - steer and accel are stored on a 1/10000 grid
intentsB64     the packed input stream, base64, split into 120-character lines
expected       the full SimState after the last tick
events         total, per-kind counts, and every finish
```

The packed stream is 5 bytes per kart per tick: `int16` steer (units 1/10000, little-endian),
`int16` accel, `uint8` flags (`1` brake, `2` drift, `4` useItem). Rows are 8 karts. The generator
**quantises before simulating**, so the stream that is stored is byte-identical to the stream that
produced the expectation, and replay is exact rather than merely close.

The fixture contains no timestamp, no hostname and no absolute path, so regenerating it with no
behaviour change produces no diff.

## Replay is not the bots

All eight karts are marked `connected: true, isBot: false` in the golden start state, so at replay
time the recorded stream is the only input source and no bot fill can run. The stream was *authored*
by `botIntent` when the fixture was recorded — which is what makes the drivability assertion
meaningful — but a later change to bot behaviour cannot move this fixture. Only physics can.

## Regenerating (intentional physics changes only)

```bash
UPDATE_GOLDEN=1 npx vitest run packages/sim/test/golden-regen.test.ts
```

- Without `UPDATE_GOLDEN=1` the regeneration case is skipped and the file is inert.
- With `CI`, `GITHUB_ACTIONS` or `CONTINUOUS_INTEGRATION` set to anything other than empty, `0` or
  `false`, it **refuses and throws**. Regenerating a golden is a claim that a physics change was
  intentional; only a human reading the diff can make that claim, so CI is never allowed to make it.
- The generator re-runs the drivability check before writing, and reloads and replays what it wrote
  before returning. A fixture that cannot reproduce itself is never committed.

Regenerate only when you meant to change physics. Read the resulting diff field by field: it is the
record of what your change did to the race.
````

- [ ] **Step 12: Generate the fixture**

Run: `UPDATE_GOLDEN=1 npx vitest run packages/sim/test/golden-regen.test.ts`
Expected: PASS — 2 tests, and a console line reading
`golden: wrote .../golden-oval-3lap-8bot.json - <N> ticks, <M> events, finish order [...]`.

Then confirm the file landed and note its tick count:

```bash
ls -l packages/sim/test/fixtures/golden-oval-3lap-8bot.json
node -e "const f=require('./packages/sim/test/fixtures/golden-oval-3lap-8bot.json');console.log('tickCount',f.tickCount,'seconds',(f.tickCount/60).toFixed(1),'events',f.events.total,'respawns',f.events.countsByKind.respawn,'finishes',f.events.finishes.length)"
```

Expected: `respawns 0`, `finishes 8`, and a `tickCount` well under 18000.

If the generator instead throws `golden: bot-drivability failed…`, it will name every kart that did
not finish and its lap count. That is a real defect upstream, not a fixture problem — fix it there
and re-run, never lower the criterion. Read the numbers it prints:

- **Every kart on `lap 0` and the event total near zero** — `step()` is not calling `updateLaps`
  [Task 11], so no `lapCross` or `finish` event can ever be emitted. Same shape of failure for
  `updateRecovery` [Task 9], `resolveKartCollisions` [Task 10] and `updateEntities` [Task 12]; see
  the dependency table in this task's Interfaces block.
- **Karts on lap 1 or 2 with respawn traffic** — a real bot line or track problem in Task 14's
  `botIntent` or in `makeOvalTrack`.

- [ ] **Step 13: Run the golden-replay test to verify it passes**

Run: `npx vitest run packages/sim/test/golden-replay.test.ts`
Expected: PASS — 9 tests, including `finishes all three laps on all eight karts with zero respawns`
and `catches a one-part-in-240000 physics change on every kart`.

- [ ] **Step 14: Deliberately corrupt one stored value and prove the fixture catches it**

```bash
cp packages/sim/test/fixtures/golden-oval-3lap-8bot.json /tmp/golden-backup.json
node -e "const fs=require('fs');const p='packages/sim/test/fixtures/golden-oval-3lap-8bot.json';const j=JSON.parse(fs.readFileSync(p,'utf8'));const before=j.expected.karts[3].position[0];j.expected.karts[3].position[0]=before+0.5;fs.writeFileSync(p,JSON.stringify(j,null,2)+'\n');console.log('corrupted karts[3].position.x',before,'->',before+0.5)"
npx vitest run packages/sim/test/golden-replay.test.ts
```

Expected: FAIL — `reproduces the stored state field by field` goes red (and so does
`catches a corrupted stored value and names the field`, which reads the same kart). The failure
message must contain the line

`karts[3].position.x: expected <the corrupted number>, actual <the simulated number>, delta -5.000e-1, tolerance 1e-6`

— the field, both values, the delta and the tolerance. A digest would have said only that two hex
strings differed. Then restore and confirm green again:

```bash
cp /tmp/golden-backup.json packages/sim/test/fixtures/golden-oval-3lap-8bot.json
npx vitest run packages/sim/test/golden-replay.test.ts
rm /tmp/golden-backup.json
```

Expected: PASS — 9 tests.

- [ ] **Step 15: Prove the regeneration command refuses to run in CI**

```bash
CI=true UPDATE_GOLDEN=1 npx vitest run packages/sim/test/golden-regen.test.ts
```

Expected: FAIL — `records a fresh 3-lap 8-bot race and writes the fixture` throws
`golden: refusing to regenerate because CI=true. A regenerated golden fixture is a claim that a
physics change was intentional; it must be produced on a developer machine and reviewed in the
diff. Unset CI to proceed.`

Then confirm the fixture on disk is untouched and that a plain CI run skips regeneration entirely:

```bash
git diff --stat packages/sim/test/fixtures/golden-oval-3lap-8bot.json
CI=true npx vitest run packages/sim/test/golden-regen.test.ts
```

Expected: an empty `git diff --stat`, and PASS with 1 test run and 1 skipped.

- [ ] **Step 16: Run the whole sim suite**

Run: `npx vitest run packages/sim`
Expected: PASS — every existing test plus the 4 files added here
(`golden-format.test.ts` 16, `golden-harness.test.ts` 13, `golden-replay.test.ts` 9,
`golden-regen.test.ts` 1 passed + 1 skipped).

- [ ] **Step 17: Commit**

```bash
git add packages/sim/test/fixtures/golden-format.ts \
        packages/sim/test/fixtures/golden-harness.ts \
        packages/sim/test/fixtures/GOLDEN.md \
        packages/sim/test/fixtures/golden-oval-3lap-8bot.json \
        packages/sim/test/golden-format.test.ts \
        packages/sim/test/golden-harness.test.ts \
        packages/sim/test/golden-replay.test.ts \
        packages/sim/test/golden-regen.test.ts
git commit -m "feat: golden-replay fixture for the 3-lap 8-bot oval race

Records an 8-kart input stream on makeOvalTrack and compares the resulting
SimState field by field - exact for integers, enums and booleans, and within
a stated per-field tolerance for position, velocity, heading, angular
velocity, drift charge and lap t. Not a hash: a digest mismatch names no
field, no value and no delta.

Also asserts the spec's bot-drivability criterion - all eight karts finish
three laps and zero respawn events occur across the whole run - and ships a
regeneration command that refuses to run when CI is set."
```
