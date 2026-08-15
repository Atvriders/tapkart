### Task 22: `packages/server/src/log.ts`, `src/ratelimit.ts`, and the barrel

Three small modules. Two of them are consumed by almost everything else in the
package, and the third is what keeps the package importable as one thing.

**Execution order — this task is executed in two sittings, and commits once.**

- **Steps 1–4 (`log.ts`, `ratelimit.ts`) must land BEFORE Tasks 19, 19b and 20.**
  `HubDeps` holds a `LogSink` and a `RateLimiter`, and `pollRace` takes a
  `LogSink`. Do not stub either: a stub of a type four modules consume is how a
  plan discovers at task 24 that task 22 was fiction.
- **Steps 5–6 (`src/index.ts`) must run AFTER Tasks 18, 19, 19b, 20 and 21**,
  because the barrel re-exports all twelve modules and its test imports every
  one of them.
- Commit once, at the end, with everything.

**Files:**
- Create: `packages/server/src/log.ts`
- Create: `packages/server/src/ratelimit.ts`
- Create: `packages/server/src/index.ts`
- Test: `packages/server/test/log.test.ts`
- Test: `packages/server/test/ratelimit.test.ts`
- Test: `packages/server/test/barrel.test.ts`

**Interfaces:**

- Consumes — `@tapkart/protocol` [§3.3, an earlier Plan 4 task]:
  ```ts
  export type JoinResult =
    | 'ok' | 'roomNotFound' | 'roomFull' | 'roomClosed'
    | 'versionMismatch' | 'badRequest' | 'rateLimited'
  export type ResyncReason = 'lateJoin' | 'divergence'
  ```

- Consumes — `src/env.ts` [§5.2, the env task]:
  ```ts
  export interface RateLimitConfig { windowMs: number; max: number }
  ```

- Produces — `src/log.ts`, the five §5.11 pins:
  ```ts
  export type LogEvent =
    | { kind: 'roomCreated'; code: string }
    | { kind: 'roomExpired'; code: string; ageMs: number }
    | { kind: 'peerJoined'; code: string; playerId: number; relay: boolean }
    | { kind: 'peerLeft'; code: string; playerId: number }
    | { kind: 'peerReclaimed'; code: string; playerId: number }
    | { kind: 'raceStarted'; code: string; seed: number; trackId: string }
    | { kind: 'promotion'; code: string; tick: number; eventSeq: number }
    | { kind: 'checkpointSent'; code: string; playerId: number; reason: ResyncReason }
    | { kind: 'relayFirst'; code: string; failures: number }
    | { kind: 'rejected'; code: string; result: JoinResult }
    | { kind: 'badFrame'; code: string; peerId: string; why: string }
  export interface LogSink { write(ev: LogEvent, nowMs: number): void }
  export const nullLogSink: LogSink
  export function makeMemoryLogSink(): LogSink & { events(): readonly LogEvent[] }
  /** One line, no colours, no timestamps of its own -- nowMs is passed in. */
  export function formatLogEvent(ev: LogEvent, nowMs: number): string
  ```

- Produces — `src/ratelimit.ts`, the two §5.12 pins:
  ```ts
  export interface RateLimiter {
    /** True when `key` is still under its budget. Does NOT consume. */
    allowed(key: string, nowMs: number): boolean
    /** Charges one failure against `key`. */
    note(key: string, nowMs: number): void
    reset(): void
  }
  export function makeRateLimiter(cfg: RateLimitConfig): RateLimiter
  ```

- Produces — `src/index.ts`: `export *` from `types`, `env`, `random`,
  `registry`, `lobby`, `roomtransport`, `hub`, `race`, `content`, `static`,
  `log`, `ratelimit`. **Not** `runtime/*` and **not** `main`.

**Two decisions this task makes:**

1. **`formatLogEvent`'s exact shape is `<nowMs> <kind> key=value ...`**, fields in
   the order the union declares them. The contract fixes what it must not do (no
   colours, no clock of its own) and leaves the shape open; one line of
   `key=value` pairs is greppable, needs no parser, and is stable enough to
   assert byte for byte. `why` has its whitespace collapsed to `_`, so a log line
   is always exactly one line — a newline in a field is a log-injection hole
   whether or not today's callers can reach it.
2. **The rate limiter bounds its own key space, privately.** Its keys are room
   codes a stranger chooses, and there are 33.5 million of them; a `Map` that
   only ever grows is a memory hole opened by the very attack the limiter exists
   to bound. `MAX_TRACKED_KEYS` is module-private (the census pins this module at
   two exports): past the cap it sweeps expired windows, and if that does not get
   under it, it clears. Clearing is fail-open for accumulated failure counts and
   bounded in memory, which is the right way round — a guessed room's worst
   outcome is a stranger in a kart race, and an OOM takes every live race down.

---

- [ ] **Step 1: Write the failing test for `log.ts`**

Create `packages/server/test/log.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { LogEvent } from '../src/log'
import { formatLogEvent, makeMemoryLogSink, nullLogSink } from '../src/log'

/** One of every kind. The list is the test's own floor: if a member is added to
 *  the union and not to this array, `kindOf` below stops compiling. */
const ONE_OF_EACH: readonly LogEvent[] = [
  { kind: 'roomCreated', code: 'ABCDE' },
  { kind: 'roomExpired', code: 'ABCDE', ageMs: 600_000 },
  { kind: 'peerJoined', code: 'ABCDE', playerId: 2, relay: true },
  { kind: 'peerLeft', code: 'ABCDE', playerId: 2 },
  { kind: 'peerReclaimed', code: 'ABCDE', playerId: 2 },
  { kind: 'raceStarted', code: 'ABCDE', seed: 987_654, trackId: 'caldera' },
  { kind: 'promotion', code: 'ABCDE', tick: 612, eventSeq: 44 },
  { kind: 'checkpointSent', code: 'ABCDE', playerId: 3, reason: 'divergence' },
  { kind: 'relayFirst', code: 'ABCDE', failures: 2 },
  { kind: 'rejected', code: 'ZZZZZ', result: 'roomNotFound' },
  { kind: 'badFrame', code: 'ABCDE', peerId: 'peer7', why: 'wsFrame' },
]

describe('LogEvent', () => {
  it('has eleven kinds and every one of them is distinct', () => {
    expect(ONE_OF_EACH).toHaveLength(11)
    expect(new Set(ONE_OF_EACH.map((e) => e.kind)).size).toBe(11)
  })

  it('carries no name and no token, in any member', () => {
    // Spec-level rule: no log line ever carries a name, a token, or a room code
    // the player did not type. `code` is already public to everyone in the room;
    // PeerRecord.name and PeerRecord.token appear in no member.
    const ALLOWED = new Set([
      'kind', 'code', 'ageMs', 'playerId', 'relay', 'seed', 'trackId',
      'tick', 'eventSeq', 'reason', 'failures', 'result', 'peerId', 'why',
    ])
    expect(ALLOWED.has('name')).toBe(false)
    expect(ALLOWED.has('token')).toBe(false)

    for (const ev of ONE_OF_EACH) {
      for (const key of Object.keys(ev)) {
        expect(ALLOWED.has(key), key + ' on ' + ev.kind).toBe(true)
      }
    }
  })
})

describe('formatLogEvent', () => {
  it('writes one line per event, with the fields the union declares', () => {
    expect(formatLogEvent({ kind: 'roomCreated', code: 'ABCDE' }, 1000))
      .toBe('1000 roomCreated code=ABCDE')
    expect(formatLogEvent({ kind: 'promotion', code: 'ABCDE', tick: 612, eventSeq: 44 }, 12_345))
      .toBe('12345 promotion code=ABCDE tick=612 eventSeq=44')
    expect(formatLogEvent({ kind: 'checkpointSent', code: 'ABCDE', playerId: 3, reason: 'divergence' }, 7))
      .toBe('7 checkpointSent code=ABCDE playerId=3 reason=divergence')
    expect(formatLogEvent({ kind: 'peerJoined', code: 'ABCDE', playerId: 2, relay: true }, 0))
      .toBe('0 peerJoined code=ABCDE playerId=2 relay=true')
    expect(formatLogEvent({ kind: 'rejected', code: 'ZZZZZ', result: 'rateLimited' }, 9))
      .toBe('9 rejected code=ZZZZZ result=rateLimited')
  })

  it('formats every kind without throwing, and never emits a second line', () => {
    for (const ev of ONE_OF_EACH) {
      const line = formatLogEvent(ev, 42)
      expect(line.startsWith('42 ' + ev.kind + ' ')).toBe(true)
      expect(line.includes('\n')).toBe(false)
      expect(line.includes('\r')).toBe(false)
    }
  })

  it('collapses whitespace in `why`, so one event is always one line', () => {
    const line = formatLogEvent(
      { kind: 'badFrame', code: 'ABCDE', peerId: 'peer7', why: 'bad\nframe here' }, 5,
    )
    expect(line).toBe('5 badFrame code=ABCDE peerId=peer7 why=bad_frame_here')
  })
})

describe('the sinks', () => {
  it('nullLogSink accepts everything and keeps nothing', () => {
    for (const ev of ONE_OF_EACH) nullLogSink.write(ev, 0)
    expect(Object.keys(nullLogSink)).toEqual(['write'])
  })

  it('makeMemoryLogSink keeps every event, in order', () => {
    const sink = makeMemoryLogSink()
    expect(sink.events()).toEqual([])
    for (const ev of ONE_OF_EACH) sink.write(ev, 0)
    expect(sink.events()).toHaveLength(11)
    expect(sink.events()[0].kind).toBe('roomCreated')
    expect(sink.events()[10].kind).toBe('badFrame')
  })

  it('makeMemoryLogSink hands out a list the caller cannot grow', () => {
    const sink = makeMemoryLogSink()
    sink.write({ kind: 'roomCreated', code: 'ABCDE' }, 0)
    const first = sink.events()
    sink.write({ kind: 'roomCreated', code: 'FGHJK' }, 1)
    // A test that held a live reference would silently assert against a list
    // that changed under it.
    expect(first).toHaveLength(1)
    expect(sink.events()).toHaveLength(2)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run packages/server/test/log.test.ts`

Expected: FAIL at collection with
`Failed to resolve import "../src/log" from "packages/server/test/log.test.ts". Does the file exist?`

- [ ] **Step 3: Write `packages/server/src/log.ts`**

```ts
// PURE. Typed values rather than strings, so a test can assert that something
// happened rather than that a message was printed.
import type { JoinResult, ResyncReason } from '@tapkart/protocol'

/**
 * No member is a name or a token. `code` is the room code, which is already
 * public to everyone in the room; `PeerRecord.name` and `PeerRecord.token`
 * appear nowhere here.
 *
 * Spec §5: "A client whose reconciliation diverges repeatedly is sent an
 * AuthorityCheckpoint and hard-resynced, AND THE EVENT IS LOGGED."
 * `checkpointSent { reason: 'divergence' }` is that log line.
 */
export type LogEvent =
  | { kind: 'roomCreated'; code: string }
  | { kind: 'roomExpired'; code: string; ageMs: number }
  | { kind: 'peerJoined'; code: string; playerId: number; relay: boolean }
  | { kind: 'peerLeft'; code: string; playerId: number }
  | { kind: 'peerReclaimed'; code: string; playerId: number }
  | { kind: 'raceStarted'; code: string; seed: number; trackId: string }
  | { kind: 'promotion'; code: string; tick: number; eventSeq: number }
  | { kind: 'checkpointSent'; code: string; playerId: number; reason: ResyncReason }
  | { kind: 'relayFirst'; code: string; failures: number }
  | { kind: 'rejected'; code: string; result: JoinResult }
  | { kind: 'badFrame'; code: string; peerId: string; why: string }

export interface LogSink {
  write(ev: LogEvent, nowMs: number): void
}

export const nullLogSink: LogSink = {
  write(): void {
    /* deliberately nothing */
  },
}

export function makeMemoryLogSink(): LogSink & { events(): readonly LogEvent[] } {
  const events: LogEvent[] = []
  return {
    write(ev: LogEvent): void {
      events.push(ev)
    },
    // A copy: a caller that held the live array would assert against a list that
    // changes under it.
    events(): readonly LogEvent[] {
      return events.slice()
    },
  }
}

function fieldsOf(ev: LogEvent): string {
  switch (ev.kind) {
    case 'roomCreated':
      return 'code=' + ev.code
    case 'roomExpired':
      return 'code=' + ev.code + ' ageMs=' + String(ev.ageMs)
    case 'peerJoined':
      return 'code=' + ev.code + ' playerId=' + String(ev.playerId) + ' relay=' + String(ev.relay)
    case 'peerLeft':
      return 'code=' + ev.code + ' playerId=' + String(ev.playerId)
    case 'peerReclaimed':
      return 'code=' + ev.code + ' playerId=' + String(ev.playerId)
    case 'raceStarted':
      return 'code=' + ev.code + ' seed=' + String(ev.seed) + ' trackId=' + ev.trackId
    case 'promotion':
      return 'code=' + ev.code + ' tick=' + String(ev.tick) + ' eventSeq=' + String(ev.eventSeq)
    case 'checkpointSent':
      return 'code=' + ev.code + ' playerId=' + String(ev.playerId) + ' reason=' + ev.reason
    case 'relayFirst':
      return 'code=' + ev.code + ' failures=' + String(ev.failures)
    case 'rejected':
      return 'code=' + ev.code + ' result=' + ev.result
    case 'badFrame':
      // Whitespace collapsed: one event is always exactly one line, and a
      // newline in a field is a log-injection hole whether or not today's
      // callers can reach it.
      return 'code=' + ev.code + ' peerId=' + ev.peerId + ' why=' + ev.why.replace(/\s+/g, '_')
    default: {
      const unreachable: never = ev
      return unreachable
    }
  }
}

/** One line, no colours, no timestamps of its own -- nowMs is passed in. */
export function formatLogEvent(ev: LogEvent, nowMs: number): string {
  return String(nowMs) + ' ' + ev.kind + ' ' + fieldsOf(ev)
}
```

- [ ] **Step 4: Write and run the `ratelimit.ts` test, then the module**

Create `packages/server/test/ratelimit.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { makeRateLimiter } from '../src/ratelimit'

describe('makeRateLimiter', () => {
  it('allows until the budget is spent, and `allowed` never consumes', () => {
    const rl = makeRateLimiter({ windowMs: 1000, max: 3 })

    for (let i = 0; i < 100; i++) expect(rl.allowed('ABCDE', 0)).toBe(true)
    rl.note('ABCDE', 0)
    rl.note('ABCDE', 0)
    expect(rl.allowed('ABCDE', 0)).toBe(true)      // 2 of 3
    rl.note('ABCDE', 0)
    expect(rl.allowed('ABCDE', 0)).toBe(false)     // 3 of 3
    for (let i = 0; i < 10; i++) expect(rl.allowed('ABCDE', 0)).toBe(false)
  })

  it('has an exact window boundary', () => {
    const rl = makeRateLimiter({ windowMs: 1000, max: 1 })
    rl.note('ABCDE', 0)

    expect(rl.allowed('ABCDE', 999)).toBe(false)
    expect(rl.allowed('ABCDE', 1000)).toBe(true)   // the window rolled AT windowMs
    rl.note('ABCDE', 1000)
    expect(rl.allowed('ABCDE', 1999)).toBe(false)
    expect(rl.allowed('ABCDE', 2000)).toBe(true)
  })

  it('keys are independent', () => {
    const rl = makeRateLimiter({ windowMs: 1000, max: 1 })
    rl.note('ABCDE', 0)
    expect(rl.allowed('ABCDE', 0)).toBe(false)
    expect(rl.allowed('FGHJK', 0)).toBe(true)      // a different room is unaffected
  })

  it('reset clears everything', () => {
    const rl = makeRateLimiter({ windowMs: 1000, max: 1 })
    rl.note('ABCDE', 0)
    expect(rl.allowed('ABCDE', 0)).toBe(false)     // the floor
    rl.reset()
    expect(rl.allowed('ABCDE', 0)).toBe(true)
  })

  it('bounds its own key space under a flood of distinct keys', () => {
    // The keys are room codes a stranger chooses, and there are 33.5 million of
    // them. A map that only grows is a memory hole opened by the very attack
    // this limiter exists to bound.
    const rl = makeRateLimiter({ windowMs: 1000, max: 1 })
    for (let i = 0; i < 20_000; i++) rl.note('K' + String(i), 0)

    // Still functional afterwards, which is the property that matters: bounded
    // memory, and a fresh key is still judged.
    rl.note('ZZZZZ', 0)
    expect(rl.allowed('ZZZZZ', 0)).toBe(false)
    expect(rl.allowed('YYYYY', 0)).toBe(true)
  })
})
```

Run: `npx vitest run packages/server/test/ratelimit.test.ts`
Expected: FAIL at collection with
`Failed to resolve import "../src/ratelimit" from "packages/server/test/ratelimit.test.ts". Does the file exist?`

Then create `packages/server/src/ratelimit.ts`:

```ts
// PURE. A fixed-window counter keyed by whatever the caller chooses. §5.7 fixes
// the key as the ROOM CODE and nothing else, and that choice matters far more
// than the algorithm does: behind a Cloudflare Tunnel every request is one TCP
// peer, and IP-keyed limiting once collapsed this project to 60 accounts per
// building per 15 minutes.
import type { RateLimitConfig } from './env'

interface Window {
  start: number
  count: number
}

/** Private, because §5.12 pins this module at two exports. See the sweep below. */
const MAX_TRACKED_KEYS = 4096

export interface RateLimiter {
  /** True when `key` is still under its budget. Does NOT consume -- a check and
   *  a charge are different operations here, because only a FAILED join is
   *  charged. */
  allowed(key: string, nowMs: number): boolean
  /** Charges one failure against `key`. */
  note(key: string, nowMs: number): void
  reset(): void
}

export function makeRateLimiter(cfg: RateLimitConfig): RateLimiter {
  const windows = new Map<string, Window>()

  const expired = (w: Window, nowMs: number): boolean => nowMs - w.start >= cfg.windowMs

  return {
    allowed(key: string, nowMs: number): boolean {
      const w = windows.get(key)
      if (w === undefined) return true
      if (expired(w, nowMs)) return true
      return w.count < cfg.max
    },

    note(key: string, nowMs: number): void {
      const w = windows.get(key)
      if (w !== undefined && !expired(w, nowMs)) {
        w.count += 1
        return
      }
      if (w === undefined && windows.size >= MAX_TRACKED_KEYS) {
        // Sweep what has already lapsed; if that is not enough, drop everything.
        // Clearing is fail-open for accumulated counts and bounded in memory,
        // which is the right way round: a guessed room's worst outcome is a
        // stranger in a kart race, and an OOM takes every live race down.
        for (const [k, entry] of windows) {
          if (expired(entry, nowMs)) windows.delete(k)
        }
        if (windows.size >= MAX_TRACKED_KEYS) windows.clear()
      }
      windows.set(key, { start: nowMs, count: 1 })
    },

    reset(): void {
      windows.clear()
    },
  }
}
```

Run: `npx vitest run packages/server/test/log.test.ts packages/server/test/ratelimit.test.ts`
Expected: 12 passing.

**Stop here and run Tasks 20, 19 and 19b.** Come back for Steps 5–6 once
`src/hub.ts`, `src/race.ts`, `src/content.ts` and `src/static.ts` all exist.

- [ ] **Step 5: Write the failing barrel test**

Create `packages/server/test/barrel.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import * as barrel from '../src/index'

/** Every module the barrel re-exports, as static importers -- a template-literal
 *  dynamic import would resolve at runtime and hide a typo as a rejected
 *  promise. */
const MODULES: Readonly<Record<string, () => Promise<Record<string, unknown>>>> = {
  types: () => import('../src/types'),
  env: () => import('../src/env'),
  random: () => import('../src/random'),
  registry: () => import('../src/registry'),
  lobby: () => import('../src/lobby'),
  roomtransport: () => import('../src/roomtransport'),
  hub: () => import('../src/hub'),
  race: () => import('../src/race'),
  content: () => import('../src/content'),
  static: () => import('../src/static'),
  log: () => import('../src/log'),
  ratelimit: () => import('../src/ratelimit'),
}

describe('the @tapkart/server barrel', () => {
  it('re-exports twelve modules and no two of them export the same name', async () => {
    // `export *` silently EXCLUDES an ambiguous name at runtime rather than
    // failing, so a collision would delete a symbol from the package surface
    // with no error. (tsc catches the type half; this catches the value half.)
    const owner = new Map<string, string>()
    for (const [name, load] of Object.entries(MODULES)) {
      const mod = await load()
      for (const key of Object.keys(mod)) {
        const prior = owner.get(key)
        expect(prior, key + ' is exported by both ' + String(prior) + ' and ' + name).toBeUndefined()
        owner.set(key, name)
      }
    }
    expect(Object.keys(MODULES)).toHaveLength(12)
    expect(owner.size).toBeGreaterThan(30)          // the floor
  })

  it('exports every runtime value those modules export', async () => {
    for (const [, load] of Object.entries(MODULES)) {
      const mod = await load()
      for (const key of Object.keys(mod)) {
        expect(Object.hasOwn(barrel, key), key + ' is missing from the barrel').toBe(true)
      }
    }
  })

  it('reaches nothing under src/runtime and not main', () => {
    // §0's barrel rule, the same discipline Plan 3 §8.2 uses for the identical
    // reason: a headless import of @tapkart/server must never pull in node:fs,
    // node:http, node:crypto or `ws`.
    for (const forbidden of [
      'main', 'realNowMs', 'makeIntervalScheduler', 'POLL_INTERVAL_MS',
      'nodeRandomSource', 'readFileBytes', 'fileExists', 'wrapWsSocket', 'startHttpServer',
    ]) {
      expect(Object.hasOwn(barrel, forbidden), forbidden + ' leaked into the barrel').toBe(false)
    }
  })
})
```

Run: `npx vitest run packages/server/test/barrel.test.ts`

Expected: FAIL at collection with
`Failed to resolve import "../src/index" from "packages/server/test/barrel.test.ts". Does the file exist?`

- [ ] **Step 6: Write `packages/server/src/index.ts`**

```ts
// The barrel. Twelve modules, and NOT `runtime/*`, and NOT `main`: a headless
// import of @tapkart/server must never be able to reach node:fs, node:http,
// node:crypto or `ws`. Identical discipline to Plan 3 §8.2, for the identical
// reason.
export * from './types'
export * from './env'
export * from './random'
export * from './registry'
export * from './lobby'
export * from './roomtransport'
export * from './hub'
export * from './race'
export * from './content'
export * from './static'
export * from './log'
export * from './ratelimit'
```

- [ ] **Step 7: Run everything**

Run: `npx vitest run packages/server/`
Expected: every server test green.

Run: `npx tsc --noEmit -p packages/server/tsconfig.json`
Expected: no output. A duplicate **type** name across two re-exported modules
would fail here with
`Module './x' has already exported a member named 'Y'.` — that is the other half
of the barrel test, and both halves are needed.

- [ ] **Step 8: Commit**

```bash
git add packages/server/src/log.ts packages/server/src/ratelimit.ts packages/server/src/index.ts \
        packages/server/test/log.test.ts packages/server/test/ratelimit.test.ts \
        packages/server/test/barrel.test.ts
git commit -m "feat(server): typed log events, the failed-join limiter, and the barrel

LogEvent is a typed union rather than strings, so a test can assert that a
promotion happened or that a divergence checkpoint was sent -- spec §5 asks
for the second by name. No member is a name or a token, and a test enforces
that with a key allowlist rather than a reading.

The rate limiter's keys are room codes a stranger chooses and there are 33.5
million of them, so it bounds its own key space: past a private cap it
sweeps lapsed windows and, failing that, clears. Fail-open on counts and
bounded in memory is the right way round -- a guessed room's worst outcome
is a stranger in a kart race, and an OOM takes every live race down.

The barrel re-exports twelve modules and neither runtime/* nor main. Its
test proves no two modules export the same name, because `export *` excludes
an ambiguous name silently instead of failing, which would delete a symbol
from the package surface with no error anywhere."
```
