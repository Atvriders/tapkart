import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
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
const NET_CLOCK_FILE = join(REPO, 'packages', 'net', 'src', 'clock.ts')
const THIS_FILE = fileURLToPath(import.meta.url)

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

// ADDED (not in the brief): the three sweeps below are written as named
// predicates rather than inline regexes so that each sweep's POSITIVE CONTROL
// runs the same code path the sweep runs. A control that re-spells the needle
// can keep passing after the sweep's own needle has been broken, which is the
// failure mode that lets a repo-wide scan quietly stop scanning.
const WALL_CLOCK_READERS = [/\bDate\.now\s*\(/, /\bperformance\.now\s*\(/, /\bnew\s+Date\s*\(/]
const NET_IMPORT_CLAUSE = /import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*['"]@tapkart\/net['"]/g
const TICK_MS_DECLARATION = /\b(?:const|let|var|function)\s+TICK_MS\b/

function readsAWallClock(source: string): boolean {
  const code = stripComments(source)
  return WALL_CLOCK_READERS.some((r) => r.test(code))
}

function importsTickMsFromNet(source: string): boolean {
  const code = stripComments(source)
  for (const match of code.matchAll(NET_IMPORT_CLAUSE)) {
    if (/\bTICK_MS\b/.test(match[1])) return true
  }
  return false
}

function redefinesTickMs(source: string): boolean {
  return TICK_MS_DECLARATION.test(stripComments(source))
}

// ADDED (not in the brief). Every sweep below reports "no offenders" over a list
// of files, and a list that came back empty reports no offenders most
// confidently of all. These are the sweeps' non-vacuity checks, kept in one
// place: the file lists are real, they contain the files we think they contain,
// and they exclude the ones the sweeps deliberately skip.
describe('the sweeps scan real files, and not themselves', () => {
  it('walks content, render and game sources', () => {
    const scanned = srcFilesOf('content', 'render', 'game')
    expect(scanned.length).toBeGreaterThanOrEqual(15)
    expect(scanned).toContain(CLOCK_FILE)
    expect(scanned).toContain(join(REPO, 'packages', 'game', 'src', 'index.ts'))
    expect(scanned).toContain(join(REPO, 'packages', 'render', 'src', 'index.ts'))
    expect(scanned).toContain(join(REPO, 'packages', 'render', 'src', 'camera.ts'))
    expect(scanned).toContain(join(REPO, 'packages', 'content', 'src', 'index.ts'))
  })

  it('walks every package source tree except the excluded one', () => {
    const scanned = everyPackageSrcExcept('net')
    expect(scanned.length).toBeGreaterThanOrEqual(40)
    expect(scanned).toContain(join(REPO, 'packages', 'sim', 'src', 'index.ts'))
    expect(scanned).toContain(join(REPO, 'packages', 'protocol', 'src', 'index.ts'))
    const netPrefix = join(REPO, 'packages', 'net') + sep
    expect(scanned.filter((f) => f.startsWith(netPrefix))).toEqual([])
  })

  it('never scans itself, which is the only reason its own prose is safe', () => {
    const scanned = [...srcFilesOf('content', 'render', 'game'), ...everyPackageSrcExcept('net')]
    expect(scanned).not.toContain(THIS_FILE)
    expect(scanned.filter((f) => f.includes(`${sep}test${sep}`))).toEqual([])
    // Not a formality: this file's positive controls below contain literal
    // wall-clock calls in CODE, not in comments, so stripComments cannot save it.
    // If tsFilesUnder ever walked a package root instead of its src, the sweep
    // would report this file as an offender -- the same self-match that Task 16
    // found in a scanner whose doc comment carried its own needle.
    expect(readsAWallClock(readFileSync(THIS_FILE, 'utf8'))).toBe(true)
  })

  it('strips prose without stripping code', () => {
    expect(stripComments('// a note about Date.now()\nconst a = 1\n')).not.toContain('Date.now')
    expect(stripComments('/** performance.now() in prose */\nconst b = 2\n')).not.toContain('performance.now')
    expect(stripComments('const t = performance.now()')).toContain('performance.now')
    expect(stripComments('const u = 1\n')).toContain('const u = 1')
    // A protocol-relative URL inside a string is not a comment.
    expect(stripComments("const u = 'https://example.invalid/x'")).toContain('example.invalid/x')
  })

  it('fires on a real offender and forgives prose (positive controls)', () => {
    expect(readsAWallClock('const t = Date.now()')).toBe(true)
    expect(readsAWallClock('const t = performance.now()')).toBe(true)
    expect(readsAWallClock('const d = new Date()')).toBe(true)
    expect(readsAWallClock('// this module deliberately never calls Date.now()')).toBe(false)
    expect(readsAWallClock('/* not a wall clock: performance.now() is banned here */')).toBe(false)
    expect(readsAWallClock('const seed = 1\n')).toBe(false)

    expect(importsTickMsFromNet("import { TICK_MS } from '@tapkart/net'")).toBe(true)
    expect(importsTickMsFromNet("import { advanceAccumulator, TICK_MS } from '@tapkart/net'")).toBe(true)
    expect(importsTickMsFromNet("import { MAX_CATCHUP_TICKS } from '@tapkart/net'")).toBe(false)
    expect(importsTickMsFromNet("// one day this will import { TICK_MS } from '@tapkart/net'")).toBe(false)

    expect(redefinesTickMs('const TICK_MS = 16.67')).toBe(true)
    expect(redefinesTickMs('function TICK_MS() {}')).toBe(true)
    expect(redefinesTickMs('// never write const TICK_MS = 16.67 here')).toBe(false)
    expect(redefinesTickMs('const TICK_MS_HINT = 1')).toBe(false)
  })
})

describe('TICK_MS is net\'s, and this file is its only importer', () => {
  it('is 1000 / TICK_HZ', () => {
    expect(TICK_MS).toBe(1000 / TICK_HZ)
    expect(TICK_MS).toBeCloseTo(16.6667, 4)
  })

  it('is imported from @tapkart/net by game/src/clock.ts and by nothing else', () => {
    const offenders: string[] = []
    for (const file of everyPackageSrcExcept('net')) {
      if (file === CLOCK_FILE) continue
      if (importsTickMsFromNet(readFileSync(file, 'utf8'))) offenders.push(relative(REPO, file))
    }
    expect(offenders).toEqual([])
    // The paired positive assertion, run through the SAME predicate the sweep
    // uses: without it the sweep also passes on the day clock.ts stops importing
    // TICK_MS at all.
    expect(importsTickMsFromNet(readFileSync(CLOCK_FILE, 'utf8'))).toBe(true)
  })

  it('is never redefined outside @tapkart/net', () => {
    const offenders = everyPackageSrcExcept('net')
      .filter((file) => redefinesTickMs(readFileSync(file, 'utf8')))
      .map((file) => relative(REPO, file))
    expect(offenders).toEqual([])
    // Non-vacuity, proved rather than asserted: the needle DOES fire on the one
    // file in the repository that legitimately declares TICK_MS. So the empty
    // offender list above is the exclusion working, not the needle being dead.
    expect(redefinesTickMs(readFileSync(NET_CLOCK_FILE, 'utf8'))).toBe(true)
  })
})

describe('the only wall clock in the repository', () => {
  it('is read by no module in content, render or game except clock.ts', () => {
    const offenders: string[] = []
    for (const file of srcFilesOf('content', 'render', 'game')) {
      if (file === CLOCK_FILE) continue
      if (readsAWallClock(readFileSync(file, 'utf8'))) offenders.push(relative(REPO, file))
    }
    expect(offenders).toEqual([])
    // ...and clock.ts really is a wall clock, so the sweep is not vacuous. Run
    // through the same predicate, i.e. AFTER stripComments, so this also proves
    // the stripper does not eat the one real call it is supposed to leave alone.
    expect(readsAWallClock(readFileSync(CLOCK_FILE, 'utf8'))).toBe(true)
    expect(/\bperformance\.now\s*\(/.test(stripComments(readFileSync(CLOCK_FILE, 'utf8')))).toBe(true)
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

  it('prefers performance.now() when it exists, rather than Date.now()', () => {
    // ADDED (not in the brief). "finite and non-decreasing" is true of BOTH
    // branches, so the test above passes with the ternary inverted. Under Node
    // and in a browser the two timebases are ~1.7e12 ms apart: performance.now()
    // counts from process/document start, Date.now() from 1970. Getting this
    // backwards is the §6.3 failure one level down -- a monotonic, plausible,
    // wrong-origin number.
    expect(typeof performance.now).toBe('function')
    expect(realFrameClock.nowMs()).toBeLessThan(Date.now() / 2)
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
    // The residual is a whisker under a whole tick (16.6666666666666 against a
    // 16.666666666666668 tick), which is exactly the shape of the story above:
    // the 60th tick is owed and unpayable. Asserted so that "59" reads as the
    // float result it is and not as an off-by-one someone should round up.
    expect(acc.residualMs).toBeCloseTo(TICK_MS, 12)
    expect(total * TICK_MS + acc.residualMs).toBe(1000)  // exact, not merely close
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
    let maxTicks = 0
    for (let i = 0; i < 20000; i++) {
      const elapsedMs = random() * 60                   // 0..60 ms frames, i.e. 16..∞ fps
      const ticks = advanceAccumulator(acc, elapsedMs)
      maxTicks = Math.max(maxTicks, ticks)
      expect(ticks).toBeGreaterThanOrEqual(0)
      expect(ticks).toBeLessThanOrEqual(MAX_CATCHUP_TICKS)
      expect(acc.residualMs).toBeGreaterThanOrEqual(0)
      expect(acc.residualMs).toBeLessThan(TICK_MS)
      const alpha = accumulatorAlpha(acc)
      expect(alpha).toBeGreaterThanOrEqual(0)
      expect(alpha).toBeLessThan(1)
    }
    // Honesty about what this test does NOT cover: a 60 ms ceiling can never ask
    // for more than 4 ticks, so `ticks <= MAX_CATCHUP_TICKS` above is slack here
    // and the clamp is covered by the stall test, not by this one.
    expect(maxTicks).toBe(4)
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

  it('divides by a whole tick, not by a frame or a second', () => {
    // ADDED (not in the brief). Both assertions above are near 0 or derived from
    // the same expression, so `residualMs / 1000` and `residualMs / 16` both
    // survive them: 4/1000 is close to 0 at 12 places it is not, but the
    // identity assertion `alpha === residual / TICK_MS` is the only guard and it
    // is stated once. A named half-tick pins the divisor outright.
    const acc = makeTickAccumulator()
    advanceAccumulator(acc, TICK_MS * 2 + TICK_MS / 2)
    expect(accumulatorAlpha(acc)).toBeCloseTo(0.5, 12)
    expect(accumulatorAlpha(acc)).toBeGreaterThan(0.4)   // fails for /1000 and for /16
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

  it('is on the same timebase as ClientLoop stamps its keyframes', () => {
    // ADDED (not in the brief). §6.3's whole point is that renderNowMs and
    // `recvAtMs: tick * TICK_MS` are the SAME timebase, and no assertion above
    // states that: they check renderNowMs against arithmetic written out again
    // by hand. At alpha 0 the two expressions must agree exactly, or the
    // interpolator is sampling a "now" that no keyframe was ever stamped with.
    for (const tick of [0, 1, 7, 60, 599, 3600]) {
      expect(renderNowMs(tick, 0)).toBe(tick * TICK_MS)
    }
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
