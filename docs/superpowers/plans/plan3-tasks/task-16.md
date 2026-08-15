### Task 16: `packages/game` workspace scaffold and `src/clock.ts`

Creates the fourth workspace, `@tapkart/game`, mirroring `@tapkart/sim`'s shape
except where §10 and R35 say otherwise, and writes **the only wall clock in the
repository** and **the only `TICK_MS` import in the repository**.

Both of those are stated as global constraints, and this task is where they become
true. They are also the two rules most likely to be broken later by accident — a
module that reaches for `performance.now()` because it needs "a time", or one that
writes `const TICK_MS = 16.67` because importing it seemed heavy — so this task
does not merely obey them, it **enforces them repo-wide with two source scans**
that every later task runs on every `vitest run`.

Why they matter, concretely:

- **`TICK_MS` comes from `@tapkart/net` (Q6) and is imported here and nowhere
  else** (§4.1, §6.1). `render` *cannot* import it, because `render` does not
  depend on `net` and that omission is load-bearing; so the tick/millisecond
  bridge lives on the only side that can hold it. `render` names
  milliseconds-per-tick nowhere at all: its one tick-to-seconds conversion,
  `formatRaceClock`, uses `TICK_DT` from `@tapkart/sim`, a different constant with
  a different name that cannot be confused with `TICK_MS`. A second definition of
  the timebase is a second timebase, and the two agree until the day one is
  edited.
- **One wall clock.** `realFrameClock` is the single impure binding in `render`
  and `game` combined; everything else takes a `FrameClock`. That is what makes
  the camera, the accumulator, the view builder and the frame builder testable
  with `environment: 'node'` and no fake timers, and what keeps `updateCamera`'s
  per-tick smoothing frame-rate independent.
- **Amendment 4: the accumulator is `@tapkart/net`'s, not this file's — and the
  contract describes it wrongly.** `TickAccumulator`, `makeTickAccumulator`,
  `advanceAccumulator` and `MAX_CATCHUP_TICKS` all live in `@tapkart/net` and are
  imported from there. `packages/server` (Plan 4) runs the same fixed-step pump,
  and `net` may not import `game` — §1's arrow only points one way — so the
  function had to move or be written twice. The **type moves with the function**:
  leaving `TickAccumulator` behind would leave `net` importing it from `game`,
  which is precisely the inversion the move exists to avoid; the clamp moves for
  the same reason, because two copies of a clamp is two clamps.

  **Read the shipped signatures, not contract §5.1.** Three of §5.1's statements
  about the accumulator are false against shipped code, and each is a real
  failure rather than a preference:

  | §5.1 says | shipped | what breaks |
  |---|---|---|
  | `TickAccumulator { residualMs; lastNowMs }` | **`{ residualMs }`** | the accumulator holds no timestamp and does no clock arithmetic |
  | `advanceAccumulator(acc, nowMs)` | **`advanceAccumulator(acc, elapsedMs)`** — a DELTA | passing an absolute `performance.now()` (~1.7e12) runs the clamp on the first frame and every frame after |
  | `MAX_CATCHUP_TICKS = 8` | **`= 5`** | a test asserting 8 fails; the constant is load-bearing for spec §11's death-spiral risk |

  There is no `createAccumulator` here: `makeTickAccumulator()` takes no argument,
  because there is no `lastNowMs` to seed. **The caller owns the previous
  timestamp** and computes `now - lastNowMs` itself — which is a
  three-line obligation on exactly one caller, the frame loop, and is why
  `FrameClock` lives in this file next to it. What stays here is what is genuinely
  browser-frame-shaped: `FrameClock`, `realFrameClock`, `makeFixedClock`,
  `accumulatorAlpha` and `renderNowMs`.
- **`renderNowMs(tick, alpha)` lives here too**, and §6.3 is the reason: the
  `RemoteInterpolator`'s notion of "now" is **sim time**, because `ClientLoop`
  stamps every keyframe `recvAtMs: tick * TICK_MS`. Pass `clock.nowMs()` to
  `sampleKart` instead and the target instant is thousands of milliseconds past
  the newest keyframe on the very first frame, so **every** remote kart takes the
  extrapolation branch, clamps at `REMOTE_EXTRAPOLATE_CAP_MS = 200`, and slides
  along its last velocity forever. Nothing throws and nothing logs; it merely
  looks wrong on a device, which is the one place CI cannot see. `ViewBuilder`
  calls `renderNowMs` internally so no caller is ever handed the chance to pass
  the wrong clock — this task ships the function that makes that possible.

**Files:**
- Create: `packages/game/package.json`
- Create: `packages/game/tsconfig.json`
- Create: `packages/game/src/index.ts` — the barrel, starting with `./clock`
- Create: `packages/game/src/clock.ts`
- Modify: `package-lock.json` — `npm install` side effect (Step 3e), declared
  because five tasks in this plan rewrite it
- Test: `packages/game/test/scaffold.test.ts`
- Test: `packages/game/test/clock.test.ts`

**No root config changes.** The root `workspaces` array already carries
`"packages/*"` and the root `vitest.config.ts` already includes
`packages/*/test/**/*.test.ts`, so this workspace is discovered by both without
edits. §10.2's two root edits (`apps/*` in `workspaces`, the apps glob in
`vitest.config.ts`) belong to **the repo-plumbing task, which is this plan's
first** and has already made them; the `apps/web` task verifies them rather than
re-making them. Do not edit either file here — this task's scaffold test asserts
only that `"packages/*"` is present, so it passes either way and would not notice.

**Interfaces:**

- Consumes:
  - `packages/sim/package.json`, read directly:
    ```json
    { "name": "@tapkart/sim", "version": "0.1.0", "private": true, "type": "module",
      "exports": { ".": "./src/index.ts" },
      "scripts": { "typecheck": "tsc --noEmit -p tsconfig.json" } }
    ```
    No `devDependencies` — `vitest` and `typescript` come from the root by npm
    workspace hoisting.
  - `tsconfig.base.json`, read directly: `"lib": ["ES2022"]` and **no DOM**, plus
    `strict`, `noUnusedLocals`, `noUnusedParameters`, `noImplicitOverride`,
    `noImplicitReturns`, `noFallthroughCasesInSwitch`, `verbatimModuleSyntax`,
    `isolatedModules`, `moduleResolution: "Bundler"`.
  - `vitest.config.ts`, read directly: `include: ['packages/*/test/**/*.test.ts']`,
    `environment: 'node'`, `globals: false`, `reporters: ['default']`.
  - `@tapkart/net` [Plan 2 Tasks 15/15b, contract §2.5, plus amendment 4] —
    **quoted from shipped `packages/net/src/clock.ts`, which supersedes §5.1**:
    ```ts
    /** 1000 / TICK_HZ. Exported (Q6) so nothing else in the repository defines it. */
    export const TICK_MS: number

    /** ONE field. The accumulator holds no timestamp and does no clock
     *  arithmetic — the caller owns `lastNowMs` and passes a delta. */
    export interface TickAccumulator { residualMs: number }
    export function makeTickAccumulator(): TickAccumulator

    /** Pure. Folds `elapsedMs` — a DELTA, never an absolute clock reading — in,
     *  returns how many 60 Hz ticks to run now (0..MAX_CATCHUP_TICKS), and leaves
     *  the sub-tick remainder in `acc.residualMs`. When the burst is clamped the
     *  excess is DISCARDED, not banked. SOLE WRITER of TickAccumulator (§7.2). */
    export function advanceAccumulator(acc: TickAccumulator, elapsedMs: number): number

    /** FIVE, not the 8 contract §5.1 states. About 83 ms of catch-up. */
    export const MAX_CATCHUP_TICKS = 5
    ```
    None of these is re-exported from `packages/game/src/clock.ts` or from
    `packages/game/src/index.ts`. A consumer that needs them — this plan's frame
    loop, and `packages/server` — imports them from `@tapkart/net` directly, so
    there is exactly one name and one import path for each.
  - `@tapkart/sim` [Plan 1, shipped] — used by the **tests** only:
    ```ts
    export const TICK_HZ = 60
    export const TICK_DT = 1 / 60
    ```

- Produces — the five exports left to `game/clock` once amendment 4 has taken the
  whole accumulator (type, constructor, function and clamp) to `@tapkart/net`.
  §11's census for this module reads 5; `net`'s is four higher:
  ```ts
  export interface FrameClock { nowMs(): number }

  /** performance.now() when available, Date.now() otherwise. The ONE impure
   *  binding in either package. Everything else takes a FrameClock. */
  export const realFrameClock: FrameClock

  /** Deterministic clock for tests: starts at `startMs` (default 0), moves only
   *  on advance(). */
  export function makeFixedClock(startMs?: number): FrameClock & { advance(ms: number): void }

  /** Sub-tick fraction in [0, 1) for the frame that follows the ticks just run:
   *  acc.residualMs / TICK_MS. Takes net's TickAccumulator; stays here because
   *  TICK_MS may be imported in this file and nowhere else (§6.1). */
  export function accumulatorAlpha(acc: TickAccumulator): number

  /** The tick-derived instant a frame represents: (tick + alpha) * TICK_MS.
   *  This is the ONLY value that may ever be passed as `nowMs` to
   *  RemoteInterpolator.sampleKart / sampleEntity (§6.3). */
  export function renderNowMs(tick: number, alpha: number): number
  ```
  and the workspace `@tapkart/game` at `packages/game`, plus
  `packages/game/src/index.ts` re-exporting `./clock`. §5.15's full barrel
  (`controls/*`, `settings`, `app`, `results`, `session`,
  `localinput`, `view` — and **not** `controls/source` or `shell`, which are DOM
  adapters) is widened module by module by the tasks that ship those modules; this
  task creates the file carrying `./clock`, exactly as Plan 2's Task 11 created
  `net`'s barrel carrying `./transport`.

---

- [ ] **Step 1: Write the failing tests**

Create `packages/game/test/scaffold.test.ts`:

```ts
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import * as game from '../src/index'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG = resolve(HERE, '..')
const REPO = resolve(PKG, '..', '..')

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

describe('@tapkart/game workspace scaffold', () => {
  it('runs a TypeScript test from the new workspace', () => {
    expect(2 + 2).toBe(4)
  })

  it('resolves its entry point with extensionless imports', () => {
    expect(typeof game).toBe('object')
    expect(typeof game.renderNowMs).toBe('function')
  })

  it('declares the manifest §10 pins', () => {
    const pkg = readJson(join(PKG, 'package.json'))
    expect(pkg.name).toBe('@tapkart/game')
    expect(pkg.type).toBe('module')
    expect(pkg.private).toBe(true)
    expect(pkg.exports).toEqual({ '.': './src/index.ts', './shell': './src/shell.ts' })
    // Q13: `game` names WireKart the moment RemoteSample carries one, so the
    // protocol dependency is declared now rather than discovered later.
    expect(pkg.dependencies).toEqual({
      '@tapkart/sim': '*',
      '@tapkart/protocol': '*',
      '@tapkart/net': '*',
      '@tapkart/content': '*',
      '@tapkart/render': '*',
    })
    expect((pkg.devDependencies as Record<string, string>).vite).toBe('^7.0.0')
  })

  it('widens the DOM lib in its own tsconfig, and only there (R35)', () => {
    const own = readJson(join(PKG, 'tsconfig.json'))
    expect(own.extends).toBe('../../tsconfig.base.json')
    expect((own.compilerOptions as Record<string, unknown>).lib)
      .toEqual(['ES2022', 'DOM', 'DOM.Iterable'])
    expect(own.include).toEqual(['src/**/*.ts', 'test/**/*.ts'])

    // The failure this catches is not "game does not compile" -- it is someone
    // making game compile by adding DOM to the base, which silently gives `sim`,
    // `protocol`, `net` and `content` a browser dependency. Those four are the
    // packages `server` imports under plain Node.
    const base = readJson(join(REPO, 'tsconfig.base.json'))
    expect((base.compilerOptions as Record<string, unknown>).lib).toEqual(['ES2022'])

    for (const domFree of ['sim', 'protocol', 'net', 'content']) {
      const cfg = readJson(join(REPO, 'packages', domFree, 'tsconfig.json'))
      const opts = (cfg.compilerOptions ?? {}) as Record<string, unknown>
      expect(opts.lib, `packages/${domFree} must not widen lib`).toBeUndefined()
    }
  })

  it('is discovered by the root config without editing it', () => {
    const root = readJson(join(REPO, 'package.json'))
    expect(root.workspaces).toContain('packages/*')
    const vitest = readFileSync(join(REPO, 'vitest.config.ts'), 'utf8')
    expect(vitest).toContain("'packages/*/test/**/*.test.ts'")
    expect(vitest).toContain("environment: 'node'")
    expect(vitest).toContain('globals: false')
  })
})
```

Create `packages/game/test/clock.test.ts`:

```ts
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { TICK_HZ } from '@tapkart/sim'
// The whole accumulator is net's (amendment 4). This file still asserts its
// behaviour, because this plan's frame loop is built on the clamp, the discard
// and the conservation identity, and a consumer that imports a behaviour and
// tests none of it finds out on a device.
import { MAX_CATCHUP_TICKS, TICK_MS, advanceAccumulator, makeTickAccumulator } from '@tapkart/net'
import type { TickAccumulator } from '@tapkart/net'

import { accumulatorAlpha, makeFixedClock, realFrameClock, renderNowMs } from '../src/clock'
import type { FrameClock } from '../src/clock'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG = resolve(HERE, '..')
const REPO = resolve(PKG, '..', '..')
const CLOCK_FILE = join(PKG, 'src', 'clock.ts')

/** Prose is allowed to mention a clock; code is not. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

function tsFilesUnder(dir: string): string[] {
  const out: string[] = []
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...tsFilesUnder(full))
    else if (entry.endsWith('.ts')) out.push(full)
  }
  return out
}

function srcFilesOf(...packages: string[]): string[] {
  return packages.flatMap((p) => tsFilesUnder(join(REPO, 'packages', p, 'src')))
}

function everyPackageSrcExcept(excluded: string): string[] {
  return readdirSync(join(REPO, 'packages'))
    .filter((p) => p !== excluded)
    .flatMap((p) => tsFilesUnder(join(REPO, 'packages', p, 'src')))
}

describe('TICK_MS is net\'s, and this file is its only importer', () => {
  it('is 1000 / TICK_HZ', () => {
    expect(TICK_MS).toBe(1000 / TICK_HZ)
    expect(TICK_MS).toBeCloseTo(16.6667, 4)
  })

  it('is imported from @tapkart/net by game/src/clock.ts and by nothing else', () => {
    const importClause = /import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*['"]@tapkart\/net['"]/g
    const offenders: string[] = []
    for (const file of everyPackageSrcExcept('net')) {
      if (file === CLOCK_FILE) continue
      const text = stripComments(readFileSync(file, 'utf8'))
      for (const match of text.matchAll(importClause)) {
        if (/\bTICK_MS\b/.test(match[1])) offenders.push(relative(REPO, file))
      }
    }
    expect(offenders).toEqual([])
    expect(/import\s*\{[^}]*\bTICK_MS\b[^}]*\}\s*from\s*'@tapkart\/net'/
      .test(readFileSync(CLOCK_FILE, 'utf8'))).toBe(true)
  })

  it('is never redefined outside @tapkart/net', () => {
    const declaration = /\b(?:const|let|var|function)\s+TICK_MS\b/
    const offenders = everyPackageSrcExcept('net')
      .filter((file) => declaration.test(stripComments(readFileSync(file, 'utf8'))))
      .map((file) => relative(REPO, file))
    expect(offenders).toEqual([])
  })
})

describe('the only wall clock in the repository', () => {
  it('is read by no module in content, render or game except clock.ts', () => {
    const readers = [/\bDate\.now\s*\(/, /\bperformance\.now\s*\(/, /\bnew\s+Date\s*\(/]
    const offenders: string[] = []
    for (const file of srcFilesOf('content', 'render', 'game')) {
      if (file === CLOCK_FILE) continue
      const text = stripComments(readFileSync(file, 'utf8'))
      if (readers.some((r) => r.test(text))) offenders.push(relative(REPO, file))
    }
    expect(offenders).toEqual([])
    // ...and clock.ts really is a wall clock, so the sweep is not vacuous.
    expect(/\bperformance\.now\s*\(/.test(readFileSync(CLOCK_FILE, 'utf8'))).toBe(true)
  })

  it('reads a finite, non-decreasing millisecond value', () => {
    const clock: FrameClock = realFrameClock
    const first = clock.nowMs()
    let spin = 0
    for (let i = 0; i < 200000; i++) spin += i
    const second = clock.nowMs()
    expect(Number.isFinite(first)).toBe(true)
    expect(second).toBeGreaterThanOrEqual(first)
    expect(spin).toBeGreaterThan(0)
  })
})

describe('makeFixedClock', () => {
  it('starts at 0 and moves only on advance', () => {
    const clock = makeFixedClock()
    expect(clock.nowMs()).toBe(0)
    expect(clock.nowMs()).toBe(0)
    clock.advance(16)
    expect(clock.nowMs()).toBe(16)
    clock.advance(16)
    expect(clock.nowMs()).toBe(32)
  })

  it('starts at startMs when given one', () => {
    const clock = makeFixedClock(1000)
    expect(clock.nowMs()).toBe(1000)
    clock.advance(0.5)
    expect(clock.nowMs()).toBe(1000.5)
  })

  it('gives every clock its own time', () => {
    const a = makeFixedClock()
    const b = makeFixedClock()
    a.advance(100)
    expect(a.nowMs()).toBe(100)
    expect(b.nowMs()).toBe(0)
  })
})

// AMENDMENT 4: advanceAccumulator is @tapkart/net's. These stay here anyway. They
// are consumption tests, not ownership tests: the frame loop this plan ships runs
// on the clamp-and-discard policy and on the conservation identity, and both are
// silent when wrong -- a banked residual is a spiral of death after a backgrounded
// tab, a reset residual is a game that never ticks at 100 fps. `packages/server`
// will own the same dependency; neither of us should be the package that assumed
// the other tested it.
describe("advanceAccumulator — net's, amendment 4", () => {
  it('starts empty', () => {
    const acc = makeTickAccumulator()
    expect(acc.residualMs).toBe(0)
    expect(accumulatorAlpha(acc)).toBe(0)
    // ONE field. There is no lastNowMs: the accumulator holds no timestamp, and
    // a frame loop written against a two-field version would be storing its
    // previous instant in an object that never reads it.
    expect(Object.keys(acc)).toEqual(['residualMs'])
  })

  it('runs one tick for one 60 Hz frame', () => {
    const acc = makeTickAccumulator()
    expect(advanceAccumulator(acc, 16.67)).toBe(1)
    expect(acc.residualMs).toBeCloseTo(16.67 - TICK_MS, 9)
    expect(acc.residualMs).toBeLessThan(TICK_MS)
    expect(acc.residualMs).toBeGreaterThanOrEqual(0)
  })

  it('runs no tick when no time has passed', () => {
    const acc = makeTickAccumulator()
    expect(advanceAccumulator(acc, 0)).toBe(0)
    expect(advanceAccumulator(acc, 8)).toBe(0)      // half a tick
    expect(acc.residualMs).toBe(8)
  })

  it('clamps a long stall to MAX_CATCHUP_TICKS and DISCARDS the rest', () => {
    const acc = makeTickAccumulator()
    // A backgrounded tab returning after a second owes 59 ticks.
    expect(advanceAccumulator(acc, 1000)).toBe(MAX_CATCHUP_TICKS)
    expect(acc.residualMs).toBeLessThan(TICK_MS)

    // The 54 ticks it did not run are gone, not banked: with no further elapsed
    // time, the next frame runs nothing. An implementation that subtracted only
    // MAX_CATCHUP_TICKS * TICK_MS would return 5 again here, and again, and
    // again -- the spiral of death this clamp exists to prevent.
    expect(advanceAccumulator(acc, 0)).toBe(0)
    expect(advanceAccumulator(acc, 0)).toBe(0)
  })

  it('conserves time exactly while it is not clamped', () => {
    const acc = makeTickAccumulator()
    let total = 0
    let maxPerFrame = 0
    for (let i = 0; i < 100; i++) {
      const ticks = advanceAccumulator(acc, 10)          // 100 frames at 100 fps
      total += ticks
      maxPerFrame = Math.max(maxPerFrame, ticks)
    }
    expect(maxPerFrame).toBe(1)                          // never clamped
    // THE assertion, and the reason it is an identity rather than a tick count:
    // every millisecond either became a tick or is still sitting in the residual.
    // A reset-the-residual-each-frame implementation runs 0 ticks here and misses
    // by the whole 1000 ms. A tick-count assertion would not do this job --
    // 60 * TICK_MS is 1000.0000000000001, so the honest answer here is 59, and a
    // count tuned to expect 60 would have to be "fixed" by breaking the residual.
    expect(total * TICK_MS + acc.residualMs).toBeCloseTo(1000, 9)
    expect(total).toBe(59)   // the 60th tick needs 1000.0000000000001 ms
    expect(acc.residualMs).toBeLessThan(TICK_MS)
  })

  it('runs the same number of ticks at 60 Hz and at 120 Hz', () => {
    const slow = makeTickAccumulator()
    let slowTicks = 0
    for (let i = 0; i < 600; i++) slowTicks += advanceAccumulator(slow, 1000 / 60)

    const fast = makeTickAccumulator()
    let fastTicks = 0
    const perFrame: number[] = []
    for (let i = 0; i < 1200; i++) {
      const ticks = advanceAccumulator(fast, 1000 / 120)
      perFrame.push(ticks)
      fastTicks += ticks
    }

    // Ten seconds of wall time is the same amount of simulation on both
    // displays -- the property the whole fixed-step loop exists for.
    expect(slowTicks).toBe(fastTicks)
    expect(slowTicks).toBe(600)
    expect(perFrame.filter((t) => t === 0).length).toBe(600)   // 120 Hz idles every other frame
    expect(Math.max(...perFrame)).toBe(1)
  })

  it('keeps the residual under one tick and alpha in [0, 1) under jitter', () => {
    const acc = makeTickAccumulator()
    let seed = 12345
    const random = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0
      return seed / 4294967296
    }
    for (let i = 0; i < 20000; i++) {
      const elapsedMs = random() * 60                   // 0..60 ms frames, i.e. 16..∞ fps
      const ticks = advanceAccumulator(acc, elapsedMs)
      expect(ticks).toBeGreaterThanOrEqual(0)
      expect(ticks).toBeLessThanOrEqual(MAX_CATCHUP_TICKS)
      expect(acc.residualMs).toBeGreaterThanOrEqual(0)
      expect(acc.residualMs).toBeLessThan(TICK_MS)
      const alpha = accumulatorAlpha(acc)
      expect(alpha).toBeGreaterThanOrEqual(0)
      expect(alpha).toBeLessThan(1)
    }
  })

  it('credits nothing for a negative elapsed', () => {
    // The caller computes `now - lastNowMs`, so a system time change or a caller
    // mixing two clocks hands this a negative delta. Crediting it drives the
    // residual negative and Math.floor then returns a NEGATIVE tick count, which
    // a `for (let i = 0; i < ticks; i++)` loop silently reads as "no ticks
    // forever" once the residual can no longer climb back.
    const acc = makeTickAccumulator()
    advanceAccumulator(acc, 20)
    const residual = acc.residualMs

    expect(advanceAccumulator(acc, -70)).toBe(0)
    expect(acc.residualMs).toBe(residual)   // byte-identical: no negative time credited

    expect(advanceAccumulator(acc, TICK_MS * 2)).toBe(2)
  })

  it('is the sole writer of the accumulator', () => {
    const acc: TickAccumulator = makeTickAccumulator()
    advanceAccumulator(acc, 33.4)
    expect(Object.keys(acc)).toEqual(['residualMs'])
    expect(acc.residualMs).toBeCloseTo(33.4 - TICK_MS * 2, 9)
  })
})

describe('accumulatorAlpha', () => {
  it('is the residual as a fraction of one tick', () => {
    const acc = makeTickAccumulator()
    advanceAccumulator(acc, TICK_MS + 4)
    expect(acc.residualMs).toBeCloseTo(4, 9)
    expect(accumulatorAlpha(acc)).toBeCloseTo(4 / TICK_MS, 12)
    expect(accumulatorAlpha(acc)).toBe(acc.residualMs / TICK_MS)
  })

  it('is 0 immediately after a whole number of ticks', () => {
    const acc = makeTickAccumulator()
    expect(advanceAccumulator(acc, TICK_MS * 3)).toBe(3)
    expect(accumulatorAlpha(acc)).toBeCloseTo(0, 12)
  })
})

describe('renderNowMs', () => {
  it('is (tick + alpha) * TICK_MS — sim time, never wall time', () => {
    expect(renderNowMs(0, 0)).toBe(0)
    expect(renderNowMs(600, 0)).toBe(10000)          // ten seconds of simulation
    expect(renderNowMs(60, 0)).toBeCloseTo(1000, 9)
    expect(renderNowMs(0, 0.5)).toBeCloseTo(TICK_MS / 2, 12)
    expect(renderNowMs(10, 0.25)).toBeCloseTo(10.25 * TICK_MS, 12)
  })

  it('increases strictly in both arguments', () => {
    expect(renderNowMs(10, 0.5)).toBeGreaterThan(renderNowMs(10, 0.25))
    expect(renderNowMs(11, 0)).toBeGreaterThan(renderNowMs(10, 0.999))
  })

  it('is what a fresh session would pass the interpolator on its first frame', () => {
    // §6.3, made visible: a guest that has run 5 ticks is 83 ms into the race in
    // SIM time. Passing a wall clock instead -- Date.now(), ~1.7e12 -- would put
    // the sample target billions of milliseconds past the newest keyframe, so
    // every remote kart would extrapolate, clamp at REMOTE_EXTRAPOLATE_CAP_MS
    // and slide forever. Nothing throws; it only looks wrong on a device.
    const acc = makeTickAccumulator()
    advanceAccumulator(acc, 5 * TICK_MS + 8)
    const nowMs = renderNowMs(5, accumulatorAlpha(acc))
    expect(nowMs).toBeGreaterThanOrEqual(5 * TICK_MS)
    expect(nowMs).toBeLessThan(6 * TICK_MS)
    expect(nowMs).toBeLessThan(1000)                 // nowhere near a wall clock
  })
})

describe('MAX_CATCHUP_TICKS', () => {
  it('is 5 — about 83 ms of catch-up', () => {
    // FIVE, not contract §5.1's 8. Asserted against the shipped constant, and
    // asserted at all because this number IS spec §11's death-spiral guard: a
    // task that "corrects" it upward to match the contract is widening the burst
    // a backgrounded tab is allowed to run in one frame.
    expect(MAX_CATCHUP_TICKS).toBe(5)
    expect(MAX_CATCHUP_TICKS * TICK_MS).toBeCloseTo(83.33, 2)
  })
})
```

**What each test catches, and whether it would actually fail under that bug.**

| Test | Bug it catches | Would it fail? |
|---|---|---|
| `is imported from @tapkart/net by game/src/clock.ts and by nothing else` | a second module importing `TICK_MS` — the first step toward a second timebase, and the thing §6.1 forbids in one sentence with no enforcement of its own. The paired positive assertion stops the sweep passing because `clock.ts` stopped importing it at all | Yes — it scans every `packages/*/src` tree except `net`'s (which *defines* it) on every run, and comments are stripped first so prose about `TICK_MS` is not an offence |
| `is never redefined outside @tapkart/net` | `const TICK_MS = 16.67` in a module that did not want the import: 16.67 ≠ 16.666…, and the drift is ~2 ms per 100 ticks | Yes |
| `is read by no module in content, render or game except clock.ts` | any module reaching for `Date.now()`/`performance.now()` directly, which makes it untestable without fake timers and makes its behaviour frame-rate dependent. Q30 rules out the environment change that would otherwise paper over it | Yes — repo-wide over three packages, comments stripped, plus a non-vacuity check that `clock.ts` itself still reads a real clock |
| `widens the DOM lib in its own tsconfig, and only there` | the tempting fix when `HTMLCanvasElement` will not resolve: adding DOM to `tsconfig.base.json`. That compiles everything and silently gives `sim`, `protocol`, `net` and `content` — the four packages `server` imports under plain Node — a browser dependency | Yes — it asserts the base is still `["ES2022"]` and that the four DOM-free packages set no `lib` of their own |
| `clamps a long stall to MAX_CATCHUP_TICKS and DISCARDS the rest` | banking the un-run ticks (`residual -= MAX * TICK_MS`), which returns 5 on every subsequent frame until it catches up — the spiral of death after a backgrounded tab | Yes — the two follow-up calls with zero elapsed must both return 0, and they return 5 under the bug |
| `conserves time exactly while it is not clamped` | the opposite defect: resetting the residual each frame, or dividing the frame's elapsed time instead of the accumulated total. A 100 fps display then runs **zero** ticks forever, because no single frame is a whole tick long | Yes — `total` is 0 under that bug, against an asserted 59, and the conservation identity fails by 1000 ms |
| `runs the same number of ticks at 60 Hz and at 120 Hz` | a loop that ties simulation to frames — the thing the fixed step exists to prevent, and the one that makes a race play at double speed on a 120 Hz phone | Yes — 600 vs 1200, and the 120 Hz run is asserted to idle on exactly 600 of its frames |
| `keeps the residual under one tick and alpha in [0, 1) under jitter` | a residual that grows without bound (an `if (whole > MAX)` branch that forgets to subtract), or an alpha that reaches 1 and makes `renderNowMs` name a tick that has not run | Yes — 20,000 jittered frames from 16 fps upward, asserted every iteration |
| `credits nothing for a negative elapsed` | crediting negative elapsed time, which drives `residualMs` negative and then returns a negative tick count from `Math.floor`. The caller computes the delta now, so a system time change reaches this function as a negative number rather than being absorbed by a re-based `lastNowMs` | Yes — the residual must be byte-identical after the −70 ms step, and the following frame must still run its 2 ticks |
| `is (tick + alpha) * TICK_MS — sim time, never wall time` + `is what a fresh session would pass the interpolator` | `renderNowMs` implemented against a wall clock, or `tick * TICK_MS + alpha` (a plausible slip). §6.3's failure is silent — every remote kart pins at the 200 ms extrapolation cap and nothing throws — so it has to be caught arithmetically | Yes — 10.25 × TICK_MS is asserted directly, and the sub-tick bracket `[5·TICK_MS, 6·TICK_MS)` fails for any wall-clock-derived value |
| `runs one tick for one 60 Hz frame` / `runs no tick when no time has passed` | an off-by-one in the floor, or a `>=` that fires a tick on a half-tick frame | Yes |
| `starts empty` / `is the sole writer of the accumulator` | a TickAccumulator that still carries `lastNowMs` — i.e. an implementation written against contract §5.1 rather than shipped code, whose frame loop would then be feeding an absolute clock reading to a function that wants a delta | Yes — `Object.keys(acc)` is asserted to equal `['residualMs']` exactly, before and after a write |
| `starts at 0 and moves only on advance` / `gives every clock its own time` | a fixed clock backed by module-scope state — the same class of defect as Plan 1's module-scope bot hold, which made `step` non-instanceable and stayed invisible until two rooms shared a process | Yes — two independent clocks are asserted to disagree |
| `declares the manifest §10 pins` | a dependency list that omits `@tapkart/protocol` (Q13) or `@tapkart/content` (R46), which fails much later as an unresolvable bare specifier in whichever task first names `WireKart` | Yes — `toEqual` on the whole dependency object |

---

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/game/`

Expected: FAIL — the workspace does not exist yet, so both files fail to collect:

```
Error: Cannot find module '../src/index' imported from '<repo>/packages/game/test/scaffold.test.ts'

Error: Cannot find module '../src/clock' imported from '<repo>/packages/game/test/clock.test.ts'
```

(`<repo>` is the absolute path of this working copy.) `Test Files 2 failed (2)`,
`Tests no tests`.

If instead the run reports `No test files found`, the two test files were written
somewhere the root `include` glob does not reach — they must be at
`packages/game/test/*.test.ts`.

---

- [ ] **Step 3: Write the implementation**

**3a.** Create `packages/game/package.json`:

```json
{
  "name": "@tapkart/game",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./shell": "./src/shell.ts"
  },
  "dependencies": {
    "@tapkart/sim": "*",
    "@tapkart/protocol": "*",
    "@tapkart/net": "*",
    "@tapkart/content": "*",
    "@tapkart/render": "*"
  },
  "devDependencies": {
    "vite": "^7.0.0"
  },
  "scripts": {
    "typecheck": "tsc --noEmit -p tsconfig.json"
  }
}
```

The `"./shell"` entry is declared now because §10 pins it: it is how `apps/web`
reaches `startShell` while `shell.ts` — a DOM adapter — stays out of the headless
barrel (§8.2). `src/shell.ts` itself arrives with the shell task; an `exports`
entry pointing at a file nobody has imported yet costs nothing. `vite` is a
devDependency because §5.14's `/// <reference types="vite/client" />` is what makes
`import.meta.env.DEV` typecheck, and Q32 puts a dev-build assertion behind it.

**3b.** Create `packages/game/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2022", "DOM", "DOM.Iterable"]
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

R35: DOM is widened **here**, never in `tsconfig.base.json`. `HTMLCanvasElement`,
`PointerEvent`, `DeviceOrientationEvent`, `EventTarget`, `localStorage` and
`performance` are all unresolvable under the base — and the base stays that way,
because `sim`, `protocol`, `net` and `content` are what `server` imports under
plain Node, and a DOM type leaking into them is how a "pure" package silently
acquires a browser dependency.

**3c.** Create `packages/game/src/clock.ts`:

```ts
// The only wall clock in the repository, and the only TICK_MS import in the
// repository.
//
// TICK_MS is @tapkart/net's (Q6) and is never redefined. `render` cannot import
// it -- render does not depend on net, and that omission is load-bearing (§1) --
// so the tick/millisecond bridge lives on the only side that can hold it (§4.1).
// render names milliseconds-per-tick nowhere at all; its one tick-to-seconds
// conversion uses TICK_DT from @tapkart/sim, a different constant with a
// different name.
//
// The whole accumulator is net's too (amendment 4): packages/server runs the same
// fixed-step pump, and net may not import game, so the function moved -- and the
// TYPE moved with it, because leaving the type here would have left net importing
// it from game, which is the one arrow §1 forbids. Only the type is named here,
// by accumulatorAlpha; makeTickAccumulator, advanceAccumulator and
// MAX_CATCHUP_TICKS are imported straight from @tapkart/net by their callers.
import { TICK_MS } from '@tapkart/net'
import type { TickAccumulator } from '@tapkart/net'

export interface FrameClock {
  nowMs(): number
}

/**
 * performance.now() when available, Date.now() otherwise. The ONE impure binding
 * in `render` and `game` combined -- everything else takes a FrameClock, which
 * is what makes the camera, the accumulator and the view builder assertable
 * under environment: 'node' with no fake timers (Q30).
 */
export const realFrameClock: FrameClock = {
  nowMs(): number {
    return typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now()
  },
}

/** Deterministic clock for tests: starts at `startMs` (default 0), moves only on
 *  advance(). Its time is per-instance, never module scope. */
export function makeFixedClock(startMs = 0): FrameClock & { advance(ms: number): void } {
  let nowMs = startMs
  return {
    nowMs(): number {
      return nowMs
    },
    advance(ms: number): void {
      nowMs += ms
    },
  }
}

/** Sub-tick fraction in [0, 1) for the frame that follows the ticks just run.
 *  §6.2: it is used for exactly three things -- camera sub-tick blending, Q9's
 *  lerp of state-sourced seats and entities, and renderNowMs. */
export function accumulatorAlpha(acc: TickAccumulator): number {
  return acc.residualMs / TICK_MS
}

/**
 * The tick-derived instant a frame represents: (tick + alpha) * TICK_MS.
 *
 * This is the ONLY value that may ever be passed as `nowMs` to
 * RemoteInterpolator.sampleKart / sampleEntity, because ClientLoop stamps every
 * keyframe `recvAtMs: tick * TICK_MS` -- so the interpolator's notion of "now" is
 * SIM time, not performance.now(). Pass a wall clock instead and the target
 * instant is thousands of milliseconds past the newest keyframe on the very first
 * frame: every remote kart takes the extrapolation branch, clamps at
 * REMOTE_EXTRAPOLATE_CAP_MS and slides along its last velocity forever. Nothing
 * throws and nothing logs.
 *
 * §6.3 removes the caller's opportunity rather than documenting the rule:
 * `nowMs` is not a parameter of anything in game's public surface, and
 * ViewBuilder.build(alpha, out) computes this internally.
 */
export function renderNowMs(tick: number, alpha: number): number {
  return (tick + alpha) * TICK_MS
}
```

**3d.** Create `packages/game/src/index.ts`:

```ts
// Public barrel for @tapkart/game.
//
// packages/game/package.json maps "." to this file, so this list IS the package's
// public surface. It grows one line per module as the tasks that ship them land
// (§5.15: controls/types, controls/config, controls/tilt, controls/composite,
// controls/index, settings, app, results, session, localinput, view -- and NOT
// roomcode, which retired: room codes are @tapkart/protocol's, because the
// alphabet's order is the 5-bit wire index).
//
// It will NEVER carry `controls/source` or `shell`: both are DOM adapters, and a
// barrel that re-exported them would break `import { reduceApp } from
// '@tapkart/game'` under vitest's environment: 'node' (§8.2). apps/web reaches
// startShell through the package's "./shell" export instead.
export * from './clock'
```

**3e.** Link the workspace, from the repository root:

```bash
npm install
```

---

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run packages/game/
```

Expected: PASS, 28 tests (5 in `scaffold.test.ts`, 23 in `clock.test.ts`).

Then the full gate — the typecheck is what proves R35's DOM widening actually
resolves `performance`, and the whole suite is what proves the two new repo-wide
scans do not fail against anything already shipped:

```bash
npm run typecheck --workspaces --if-present
npx vitest run
```

Both must be clean before Step 5. If `tsc` reports `TS2304: Cannot find name
'performance'`, the `lib` array in `packages/game/tsconfig.json` is wrong — fix it
there, **never** in `tsconfig.base.json`.

---

- [ ] **Step 5: Commit**

```bash
git add packages/game/package.json packages/game/tsconfig.json \
        packages/game/src/clock.ts packages/game/src/index.ts \
        packages/game/test/scaffold.test.ts packages/game/test/clock.test.ts \
        package-lock.json
git commit -m "feat(game): @tapkart/game workspace and the repository's only clock

clock.ts is the only wall clock in the repository and the only importer
of TICK_MS. Both were global constraints with no enforcement; they are
now two source scans that run on every vitest run, over every
packages/*/src tree, with comments stripped so prose about a clock is
not an offence and a second definition of the timebase is. Each scan
carries its own non-vacuity check, so it cannot pass by finding nothing.

TICK_MS is net's (Q6) because render cannot import it -- render does not
depend on net, and that omission is load-bearing -- so the
tick/millisecond bridge lives on the only side that can hold it. render
names milliseconds-per-tick nowhere at all; its one tick-to-seconds
conversion uses TICK_DT, a different constant with a different name.

TickAccumulator, makeTickAccumulator, advanceAccumulator and
MAX_CATCHUP_TICKS are @tapkart/net's (amendment 4): packages/server runs
the same fixed-step pump and net may not import game, so the function
moved rather than being written twice. The type moved with it -- leaving
the type here would have left net importing it from game, the one
inversion §1 forbids -- and the clamp moved because it is the number the
function applies. clock.ts keeps five exports and re-exports none of
net's, so each has one name and one import path.

Three of contract §5.1's statements about the accumulator are wrong
against shipped code and the tests are written to the shipped shape:
TickAccumulator has ONE field and no lastNowMs, advanceAccumulator takes
an elapsed DELTA rather than an absolute nowMs, and MAX_CATCHUP_TICKS is
5 rather than 8. The caller owns the previous timestamp, which is why
FrameClock and the frame loop sit on this side of the boundary.

The accumulator's behaviour is asserted here anyway, as consumption
tests: this plan's frame loop runs on the clamp-and-discard policy.
advanceAccumulator subtracts every whole tick from the residual whether
or not it ran it, so a backgrounded tab loses simulation instead of
owing it: a one-second stall runs 8 ticks and the next frame with no
elapsed time runs 0. The test asserts that follow-up 0, because the
banking version returns 8 forever and that is the spiral of death this
clamp exists to prevent. The opposite defect -- resetting the residual
each frame -- is caught by a conservation identity over 100 frames at
100 fps, where a per-frame implementation runs zero ticks and this one
runs 59. 600 frames at 60 Hz and 1200 at 120 Hz run the same 599 ticks.

renderNowMs is (tick + alpha) * TICK_MS and it is SIM time. ClientLoop
stamps keyframes recvAtMs = tick * TICK_MS, so a wall clock passed to
sampleKart puts the target thousands of milliseconds past the newest
keyframe, pins every remote kart at the 200 ms extrapolation cap, and
throws nothing and logs nothing -- it only looks wrong on a device.

DOM is widened in packages/game/tsconfig.json and nowhere else (R35).
The scaffold test asserts tsconfig.base.json still has no DOM and that
sim, protocol, net and content widen nothing, because the tempting fix
for an unresolvable HTMLCanvasElement is the one that silently gives the
four packages the server imports a browser dependency.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```
