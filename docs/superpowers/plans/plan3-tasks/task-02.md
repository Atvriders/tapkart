### Task 2: `packages/content/src/tuning.ts` — the shipped `TUNING` and `CHARACTERS`

**Files:**
- Create: `packages/content/src/tuning.ts`
- Test: `packages/content/test/tuning.test.ts`

**Interfaces:**

- **Consumes**:
  - From `@tapkart/sim` (types, `packages/sim/src/types.ts`), quoted field-for-field because the module below must match them exactly:

    ```ts
    export interface Tuning {
      maxSpeed: number
      accelRate: number
      brakeRate: number
      steerRateBase: number
      steerSpeedFalloff: number
      gripTarmac: number
      gripDirt: number
      gripDrift: number
      gravity: number
      airYaw: number
      offtrackSpeedMul: number
      respawnTicks: number
      invulnTicks: number
      spinOutTicks: number
      driftMinSpeed: number
      driftTiers: [number, number, number]
      driftBoosts: [number, number, number]
      boostSpeedMul: number
      surgeSpeedMul: number
      kartRadius: number
      kartRestitution: number
      itemBoxRespawnTicks: number
      seekerSpeed: number
      boltSpeed: number
      entityTtl: number
    }

    export interface CharacterStats {
      id: string
      name: string
      speed: number
      accel: number
      handling: number
      weight: number
    }

    export interface SimContext {
      track: Track
      query: TrackQuery
      tuning: Tuning
      characters: CharacterStats[]
      isLeader: boolean
    }

    export interface AuthEvent {
      eventSeq: number
      tick: number
      kind: AuthEventKind
      playerId: number
      entityId: number
      item: ItemKind
      data: number
    }
    ```

    **`driftTiers` and `driftBoosts` are mutable tuples, not `readonly`** (contract §2.1). Anything that later passes `TUNING.driftTiers` to `driftTierFor` must hold `[number, number, number]`; the fix is always to hold the mutable type, never to cast.

  - From `@tapkart/sim` (functions, all re-exported by the barrel):

    ```ts
    export function buildTrackQuery(track: Track): TrackQuery
    export function createState(ctx: SimContext, seed: number, characterIdx: number[]): SimState
    export function allocStateLike(ctx: SimContext, src: SimState): SimState
    export function makeIntentBuffer(): Intent[]           // exactly MAX_KARTS distinct Intents
    export function step(ctx: SimContext, prev: SimState, next: SimState,
                         inputs: Intent[], events: AuthEvent[]): void
    ```

  - From `packages/sim/test/fixtures/track-fixtures.ts` — **test-only, reached by relative path, never by bare specifier and never from `src`** (contract §2.6):

    ```ts
    export function makeTuning(overrides?: Partial<Tuning>): Tuning
    export function makeCharacters(): CharacterStats[]
    export function makeOvalTrack(overrides?: Partial<Track>): Track
    ```

    The contract writes that relative path as `'../../../sim/test/fixtures/track-fixtures'`, which is correct from a test file one directory deeper (e.g. `packages/render/test/fixtures/`). This task's test sits at `packages/content/test/tuning.test.ts`, so the path from it is **`'../../sim/test/fixtures/track-fixtures'`** — one `..` fewer. Count the directories rather than copying the string.

  - From Task 1: `packages/content/package.json` (dependency `"@tapkart/sim": "*"`, linked into `node_modules/@tapkart/` by `npm install`) and `packages/content/tsconfig.json`.

- **Produces** — contract §3a.2, exactly two exports (`content/tuning`, symbol census §11):

  ```ts
  /** The Tuning the game actually races with — and the one the shadow authority
   *  runs step() with, which is why this is not in `game`. */
  export const TUNING: Readonly<Tuning>

  /** The eight shipped characters' handling stats. Same index space as
   *  CHARACTER_DESCRIPTORS, KART_DESCRIPTORS and KartState.characterIdx. */
  export const CHARACTERS: readonly CharacterStats[]
  ```

  Two consequences later tasks depend on, both established by this task's last test:
  - `TUNING` assigns straight into `SimContext.tuning` — TypeScript does not check `readonly` property modifiers in assignability, so `Readonly<Tuning>` satisfies `Tuning`.
  - `CHARACTERS` does **not** assign into `SimContext.characters`: a `readonly CharacterStats[]` is not assignable to a mutable `CharacterStats[]`. Every composition root writes **`characters: CHARACTERS.slice()`**. That is a copy, not a cast, and it is the shape `session.ts` and Plan 4's server both use.

**Why this task's test is not optional.** Ruling Q1, carried into §3a.2 by R46: Plan 1 shipped 477 tests and a golden replay fixture, all of them written against `makeTuning()` and `makeCharacters()`. If the shipped table diverges from the fixture by one number, those 477 tests describe physics no player ever experiences and the golden replay stops being evidence about the game — it becomes evidence about a car nobody drives. The equality test is what makes the two copies one fact. *If a tuning value should change, it changes in both places in one commit, and the golden replay is regenerated.* That friction is the point.

---

- [ ] **Step 1: Write the failing test**

Create `packages/content/test/tuning.test.ts`:

```ts
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { allocStateLike, buildTrackQuery, createState, makeIntentBuffer, step } from '@tapkart/sim'
import type { AuthEvent, CharacterStats, SimContext, Tuning } from '@tapkart/sim'
import { CHARACTERS, TUNING } from '../src/tuning'
import { makeCharacters, makeOvalTrack, makeTuning } from '../../sim/test/fixtures/track-fixtures'

const SCALAR_TUNING_KEYS = [
  'maxSpeed', 'accelRate', 'brakeRate', 'steerRateBase', 'steerSpeedFalloff',
  'gripTarmac', 'gripDirt', 'gripDrift', 'gravity', 'airYaw', 'offtrackSpeedMul',
  'respawnTicks', 'invulnTicks', 'spinOutTicks', 'driftMinSpeed', 'boostSpeedMul',
  'surgeSpeedMul', 'kartRadius', 'kartRestitution', 'itemBoxRespawnTicks',
  'seekerSpeed', 'boltSpeed', 'entityTtl',
] as const satisfies readonly (keyof Tuning)[]

const ALL_TUNING_KEYS: readonly string[] = [...SCALAR_TUNING_KEYS, 'driftTiers', 'driftBoosts']

const CHARACTER_FIELDS = ['id', 'name', 'speed', 'accel', 'handling', 'weight'] as const satisfies
  readonly (keyof CharacterStats)[]

describe('TUNING equals makeTuning() field by field', () => {
  const fixture = makeTuning()

  it('declares exactly the 25 fields of Tuning, no more and no fewer', () => {
    expect(ALL_TUNING_KEYS).toHaveLength(25)
    expect(Object.keys(TUNING).sort()).toEqual([...ALL_TUNING_KEYS].sort())
    expect(Object.keys(fixture).sort()).toEqual([...ALL_TUNING_KEYS].sort())
  })

  it.each(SCALAR_TUNING_KEYS)('%s', (key) => {
    expect(TUNING[key]).toBe(fixture[key])
  })

  it('driftTiers', () => {
    expect(TUNING.driftTiers).toHaveLength(3)
    for (let i = 0; i < 3; i++) expect(TUNING.driftTiers[i]).toBe(fixture.driftTiers[i])
  })

  it('driftBoosts', () => {
    expect(TUNING.driftBoosts).toHaveLength(3)
    for (let i = 0; i < 3; i++) expect(TUNING.driftBoosts[i]).toBe(fixture.driftBoosts[i])
  })
})

describe('CHARACTERS equals makeCharacters() field by field', () => {
  const fixture = makeCharacters()

  it('ships exactly 8 characters', () => {
    expect(CHARACTERS).toHaveLength(8)
    expect(fixture).toHaveLength(8)
  })

  for (let i = 0; i < 8; i++) {
    it(`CHARACTERS[${i}] has exactly the 6 CharacterStats fields`, () => {
      expect(Object.keys(CHARACTERS[i]).sort()).toEqual([...CHARACTER_FIELDS].sort())
    })
    it.each(CHARACTER_FIELDS)(`CHARACTERS[${i}].%s`, (field) => {
      expect(CHARACTERS[i][field]).toBe(fixture[i][field])
    })
  }
})

describe('the shipped table is a literal, not the fixture wearing a hat', () => {
  const source = readFileSync(new URL('../src/tuning.ts', import.meta.url), 'utf8')

  it('never imports the sim test fixtures', () => {
    expect(source).not.toContain('track-fixtures')
    expect(source).not.toContain('/test/')
  })

  it('has exactly one import, and it is type-only', () => {
    const imports = source.match(/^import .*$/gm) ?? []
    expect(imports).toEqual(["import type { CharacterStats, Tuning } from '@tapkart/sim'"])
  })
})

describe('the shipped content drives the real simulation', () => {
  it('composes into a SimContext that createState and step accept', () => {
    const track = makeOvalTrack()
    const ctx: SimContext = {
      track,
      query: buildTrackQuery(track),
      tuning: TUNING,
      characters: CHARACTERS.slice(),
      isLeader: true,
    }
    const prev = createState(ctx, 0xc0ffee, [0, 1, 2, 3, 4, 5, 6, 7])
    expect(prev.karts.map((k) => k.characterIdx)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])

    const next = allocStateLike(ctx, prev)
    const events: AuthEvent[] = []
    step(ctx, prev, next, makeIntentBuffer(), events)
    expect(next.tick).toBe(1)
  })
})
```

Four things in there are load-bearing, and each names the bug it exists to catch:

- **The key list is hard-coded, never derived from `TUNING`.** `expect(Object.keys(TUNING)).toEqual(Object.keys(TUNING))` is the test that compares a value to itself; deriving the expected keys from either object under test is the same defect in slower motion. With the list written out, a field missing from *both* the shipped table and the fixture still fails.
- **`.toBe`, per field, against the fixture object** — not `toEqual` over the whole struct. A whole-struct compare reports one failure that says "these differ"; the per-field table names the field, which is what a bisected tuning change actually needs.
- **The source-text test.** The one way to make every equality assertion above vacuously true is `export const TUNING = makeTuning()` in `src/`, which would also ship a test fixture into the game bundle — exactly what §2.6 forbids. Asserting the module's only import is the type-only `@tapkart/sim` line catches it, and catches a value import of `sim` sneaking in later too.
- **The `createState`/`step` composition.** `characterIdx` is clamped to `[0, characters.length - 1]` inside `createState`, so `[0..7]` surviving unchanged is a fact about `CHARACTERS.length === 8` that `sim` itself observed — a six-entry array would come back `[0,1,2,3,4,5,5,5]`. It also proves the readonly/mutable seam above is real code that compiles, not a claim in a comment.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/content/test/tuning.test.ts`

Expected: FAIL, no tests collected —

```
Error: Cannot find module '../src/tuning' imported from '<repo>/packages/content/test/tuning.test.ts'
Caused by: Error: Failed to load url ../src/tuning (resolved id: ../src/tuning) in <repo>/packages/content/test/tuning.test.ts. Does the file exist?
```

and the summary `Test Files  1 failed (1)` / `Tests  no tests`.

Run: `npx tsc --noEmit -p packages/content`
Expected: FAIL — `packages/content/test/tuning.test.ts(5,36): error TS2307: Cannot find module '../src/tuning' or its corresponding type declarations.`

Both reds are required. The vitest one comes from the **value** import of `TUNING`/`CHARACTERS`; had this test imported only types, vitest would have erased the import and reported a green run against a module that does not exist.

- [ ] **Step 3: Write the implementation**

Create `packages/content/src/tuning.ts`:

```ts
// PURE. Data only: no DOM, no clock, no three, no bundler feature.
import type { CharacterStats, Tuning } from '@tapkart/sim'

export const TUNING: Readonly<Tuning> = {
  maxSpeed: 40,
  accelRate: 24,
  brakeRate: 48,
  steerRateBase: 2.6,
  steerSpeedFalloff: 0.55,
  gripTarmac: 14,
  gripDirt: 5,
  gripDrift: 3,
  gravity: 30,
  airYaw: 0.6,
  offtrackSpeedMul: 0.55,
  respawnTicks: 72,
  invulnTicks: 90,
  spinOutTicks: 60,
  driftMinSpeed: 8,
  driftTiers: [40, 90, 150],
  driftBoosts: [24, 42, 66],
  boostSpeedMul: 1.35,
  surgeSpeedMul: 0.7,
  kartRadius: 0.9,
  kartRestitution: 0.4,
  itemBoxRespawnTicks: 180,
  seekerSpeed: 55,
  boltSpeed: 65,
  entityTtl: 600,
}

export const CHARACTERS: readonly CharacterStats[] = [
  { id: 'c0', name: 'Racer 0', speed: 1.0, accel: 1.0, handling: 1.0, weight: 1.0 },
  { id: 'c1', name: 'Racer 1', speed: 1.1, accel: 0.85, handling: 0.9, weight: 1.2 },
  { id: 'c2', name: 'Racer 2', speed: 0.92, accel: 1.15, handling: 1.1, weight: 0.85 },
  { id: 'c3', name: 'Racer 3', speed: 1.05, accel: 0.9, handling: 0.95, weight: 1.1 },
  { id: 'c4', name: 'Racer 4', speed: 0.95, accel: 1.1, handling: 1.05, weight: 0.9 },
  { id: 'c5', name: 'Racer 5', speed: 1.15, accel: 0.8, handling: 0.85, weight: 1.3 },
  { id: 'c6', name: 'Racer 6', speed: 0.88, accel: 1.2, handling: 1.15, weight: 0.8 },
  { id: 'c7', name: 'Racer 7', speed: 1.0, accel: 1.0, handling: 1.0, weight: 1.0 },
]
```

Those are contract §3a.2's transcribed values, and the character rows are `CHARACTERS[i] = { id: 'c' + i, name: 'Racer ' + i, speed: speed[i], accel: accel[i], handling: handling[i], weight: weight[i] }` with `speed = [1.0, 1.1, 0.92, 1.05, 0.95, 1.15, 0.88, 1.0]`, `accel = [1.0, 0.85, 1.15, 0.9, 1.1, 0.8, 1.2, 1.0]`, `handling = [1.0, 0.9, 1.1, 0.95, 1.05, 0.85, 1.15, 1.0]`, `weight = [1.0, 1.2, 0.85, 1.1, 0.9, 1.3, 0.8, 1.0]` — written out as eight literal rows on purpose, so the shipped table and the fixture's four parallel arrays are two independent transcriptions that the test compares, rather than the same loop copied twice.

Three rules for this file:

- **No `as const`.** `driftTiers: [40, 90, 150] as const` is `readonly [40, 90, 150]`, which does not satisfy `Tuning.driftTiers: [number, number, number]`, and the repair for that error is never a cast.
- **`CharacterStats.name` is never displayed.** It is `'Racer 3'` because Q1 requires equality with the fixture; the displayed name is `CHARACTER_DESCRIPTORS[i].name` (Task 3's schema, §3a.3). Nothing joins the two arrays by `id` — they are joined by array index only, and their `id` spaces are unrelated.
- **No `Object.freeze`.** `Readonly<Tuning>` is the contract's shape and it is a compile-time guarantee; adding a runtime freeze here would be an unrequested behaviour change in data that `server` also holds.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/content/test/tuning.test.ts`
Expected: `Tests  86 passed (86)` — 1 key-set + 23 scalar fields + 2 tuples + 1 length + 8 per-character key-sets + 48 per-character fields + 2 source-text + 1 composition.

Run: `npx tsc --noEmit -p packages/content`
Expected: exit 0, no output.

Then prove the suite has teeth before believing it, and put the file back afterwards:

```bash
sed -i 's/  maxSpeed: 40,/  maxSpeed: 41,/' packages/content/src/tuning.ts
npx vitest run packages/content/test/tuning.test.ts   # expect: Tests 1 failed | 85 passed, "AssertionError: expected 41 to be 40"
sed -i 's/  maxSpeed: 41,/  maxSpeed: 40,/' packages/content/src/tuning.ts
npx vitest run packages/content/test/tuning.test.ts   # expect: Tests 86 passed (86)
```

If the mutated run passes, the equality assertions are not reaching the shipped table and the task is not done.

- [ ] **Step 5: Commit**

```bash
git add packages/content/src/tuning.ts packages/content/test/tuning.test.ts && git commit -m "feat(content): ship TUNING and CHARACTERS, asserted field-by-field against sim's fixtures"
```
