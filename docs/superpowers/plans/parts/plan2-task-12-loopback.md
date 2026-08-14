### Task 12: `packages/net/src/loopback.ts` and the `net` test fixtures

Implements the in-process `Transport` pair every later `net` test drives
directly — `AuthorityLoop`, `ClientLoop`, `ShadowLoop` and the promotion test
all run against this, never against real WebRTC/WebSocket sockets — plus the
two fixture functions Tasks 13–17 build on: `makeNetContext` (a real
`SimContext` over the Plan 1 golden oval) and `makeLossyPair` (a
`LoopbackTransport` pair preset to spec §8's test conditions).

**Files:**
- Create: `packages/net/src/loopback.ts`
- Create: `packages/net/test/fixtures/net-fixtures.ts`
- Test: `packages/net/test/loopback.test.ts`
- Test: `packages/net/test/net-fixtures.test.ts`

**Interfaces:**

- Consumes:
  - `packages/net/src/transport.ts` [Task 11], same package, relative import
    `'./transport'` — `export interface Transport { ... }`, verbatim as
    written by Task 11.
  - `packages/protocol/src/index.ts` [Task 3] — `ChannelName`, reached via
    the `@tapkart/protocol` package specifier. Contract §3: "The barrel
    exists from Task 3, not Task 18 ... net imports @tapkart/protocol,
    always." Task 3's own scaffold step already re-exports `./types`, so by
    the time this task runs (after Tasks 3–11), `@tapkart/protocol` resolves
    `ChannelName` directly — the same fix applied to Task 11's `transport.ts`
    (an earlier draft of this brief reached across with a relative path,
    `'../../protocol/src/types'`, on the same now-superseded premise that
    Task 11's brief made; that premise is corrected there too).
  - `packages/sim/src/rng.ts`, via the `@tapkart/sim` package specifier
    (sim's barrel is complete and merged, so this is an ordinary package
    import, unlike the protocol case above). Verified by reading the file
    directly: `export function rngAt(seed: number, cursor: number): number`
    — its own doc comment states *"There is no internal state here on
    purpose. SimState.rngCursor is the only cursor in the system and only a
    leader authority advances it, so a shadow authority, a rewind, or a
    replay can recompute any draw in the race from (raceSeed, rngCursor)
    alone."* This is exactly why the loopback pair must keep its own cursor
    rather than touch `state.rngCursor`: that field belongs to the leader's
    item rolls (`packages/sim/src/items.ts` reads it via
    `rngAt(state.raceSeed, state.rngCursor)`, confirmed by reading that
    file), and a transport advancing it would make a follower or shadow
    authority compute different item rolls than the leader — the exact
    desync the contract calls out in §5.
  - `packages/sim/src/types.ts`, via `@tapkart/sim` — `SimContext`.
  - `packages/sim/src/track.ts`, via `@tapkart/sim` — `export function
    buildTrackQuery(track: Track): TrackQuery`.
  - `packages/sim/test/fixtures/track-fixtures.ts` — **not** reachable via
    the `@tapkart/sim` package specifier. Verified by reading
    `packages/sim/src/index.ts` directly: its barrel is 19 `export *` lines,
    every one a `./src/*` module: `types`, `vec3`, `mathutil`, `rng`,
    `track`, `state`, `step`, `kart`, `ground`, `drift`, `recovery`,
    `collision`, `laps`, `placement`, `entity`, `items`, `bot`, `phase`,
    `replay`. None of them is `test/fixtures/track-fixtures` — test fixtures
    are never part of any package's production barrel here, by design (the
    package's own `test/helpers/flat-context.ts` reaches `test/fixtures/`
    the same way, via a relative import, from *inside* the same package).
    `packages/net/test/fixtures/net-fixtures.ts` therefore reaches it via
    `'../../../sim/test/fixtures/track-fixtures'` (three `..` — `fixtures` →
    `test` → `net` → `packages`, then down into `sim/test/fixtures`). This is
    a permanent structural fact, unlike the protocol-barrel situation above,
    which resolves itself at Task 18 — do not "fix" this one into a bare
    specifier later; there is no export path that would make it one.
    Verified present at that path, with these exact signatures, by reading
    the file directly:
    ```ts
    export function makeOvalTrack(overrides?: Partial<Track>): Track
    export function makeTuning(overrides?: Partial<Tuning>): Tuning
    export function makeCharacters(): CharacterStats[]
    ```
    `makeOvalTrack()` returns `{ id: 'oval', ... }`; `makeTuning()` returns
    `kartRadius: 0.9` among its fields; `makeCharacters()` returns exactly 8
    entries. `buildTrackQuery(makeOvalTrack()).sampleAt(0)` returns `{
    position: { x: -200, y: 0, z: -100 }, width: 24, banking: 0, surface:
    'tarmac' }` — confirmed by running it, not inferred, and used as an exact
    assertion below.

- Produces:
  - `export interface LoopbackOptions { latencyMs: number; jitterMs: number; lossRate: number; seed: number }` (`packages/net/src/loopback.ts`)
  - `export function makeLoopbackPair(opts: LoopbackOptions): { a: Transport; b: Transport; pump(nowMs: number): void }` (`packages/net/src/loopback.ts`)
  - `export function makeNetContext(isLeader?: boolean): SimContext` (`packages/net/test/fixtures/net-fixtures.ts`)
  - `export function makeLossyPair(overrides?: Partial<LoopbackOptions>): ReturnType<typeof makeLoopbackPair>` (`packages/net/test/fixtures/net-fixtures.ts`)

- **Design decisions this task makes and must justify** (none of these is
  pinned by the contract beyond the two signatures above and the default
  option values):

  1. **Peer identity.** The pair's two sides are fixed as `'a'` and `'b'`.
     `a.peers()` returns `['b']` unless `b` has closed (or `a` itself has
     closed, in which case it returns `[]` regardless); symmetric for `b`.
     `send`'s `peerId` argument is accepted, per the interface, but not
     validated against `'a'`/`'b'` — a two-node pair has exactly one possible
     destination, and `broadcast` reaches that same sole peer.

  2. **Determinism — the cursor.** Every `'unreliable'` send consumes
     **exactly two** draws from the pair's own monotonic `cursor`, via
     `rngAt(seed, cursor)`: one loss roll, then one jitter roll at `cursor +
     1`, then `cursor += 2` — **unconditionally**, whether or not the message
     ends up dropped. `'reliable'` sends consume **zero** draws: a reliable
     channel neither drops nor needs timing variance to prove it is
     reliable. This makes the cursor's value after N sends a pure function of
     "how many `'unreliable'` sends happened, in what order" — independent of
     their outcomes — which is exactly what makes two independently
     constructed pairs, given the same `seed` and the same call sequence,
     produce bit-identical schedules. The cursor lives entirely inside the
     closure `makeLoopbackPair` returns; it is never read from or written to
     `SimState.rngCursor`, satisfying the contract's requirement in §5
     directly.

  3. **Determinism — jitter is one-sided.** `delay = latencyMs + rngAt(seed,
     cursor) * jitterMs`, i.e. the extra delay is uniform in `[0, jitterMs)`,
     never negative. This guarantees "arrives after latencyMs and not
     before" unconditionally for any `jitterMs >= 0` — no test needs to
     special-case a symmetric jitter model to prove the floor holds.

  4. **`pump(nowMs)` is the only clock.** `send`/`broadcast` never read a
     clock; they schedule delivery using whatever `nowMs` the *most recent*
     `pump()` call provided (`0` before the first `pump()`). `pump(nowMs)`
     records `nowMs`, then delivers every pending message whose scheduled
     time has passed, **sorted by scheduled time** (ties broken by original
     send order, via `Array.prototype.sort`'s guaranteed stability). Because
     `'reliable'` sends carry no jitter, their scheduled times are already
     monotonic non-decreasing in send order for a fixed `nowMs`-at-send-time,
     so this single sort-based delivery algorithm *provably* preserves
     `'reliable'` order as a structural consequence, not a coincidence of
     never triggering reordering logic — while `'unreliable'`'s jitter can
     and does produce scheduled times out of send order, which the same
     algorithm delivers exactly as scheduled, reordering included.

  5. **`close()`.** Marks that side closed. `peers()` on the other side then
     returns `[]`, and any message already queued for a closed destination is
     silently discarded at delivery time. `onPeerLost` callbacks are
     registered but this task does not exercise firing them — no test in
     this file asserts on it; that is in scope for whichever later task
     drives a real peer-loss scenario.

---

### Part A — `loopback.ts`

- [ ] **Step 1: Write the failing test for the core transport mechanics**

Create `packages/net/test/loopback.test.ts`. This file constructs
`LoopbackOptions` directly — it does not yet depend on `net-fixtures.ts`,
which Part B of this task builds on top of `loopback.ts` once it exists.

```ts
import { describe, expect, it } from 'vitest'
import type { LoopbackOptions } from '../src/loopback'
import { makeLoopbackPair } from '../src/loopback'

const DEFAULTS: LoopbackOptions = { latencyMs: 150, jitterMs: 50, lossRate: 0.05, seed: 0xc0ffee }

describe('makeLoopbackPair', () => {
  it('delivers a message after latencyMs and not before', () => {
    const { a, b, pump } = makeLoopbackPair({ ...DEFAULTS, jitterMs: 0, lossRate: 0 })
    let delivered = false
    b.onMessage(() => { delivered = true })
    a.send('unreliable', 'b', new Uint8Array([1]))

    pump(149)
    expect(delivered).toBe(false)

    pump(150)
    expect(delivered).toBe(true)
  })

  it('loses close to lossRate of 20000 unreliable sends, within a 0.01 band', () => {
    const { a, b, pump } = makeLoopbackPair(DEFAULTS)
    let deliveredCount = 0
    b.onMessage(() => { deliveredCount++ })

    const N = 20000
    for (let i = 0; i < N; i++) a.send('unreliable', 'b', new Uint8Array([i & 0xff]))
    pump(1000) // 150 + up to 50 jitter: every surviving send has arrived by 1000

    const observedLossRate = (N - deliveredCount) / N
    expect(Math.abs(observedLossRate - 0.05)).toBeLessThan(0.01)
  })

  it('produces the identical delivery pattern for the same seed, run twice', () => {
    function run(): number[] {
      const { a, b, pump } = makeLoopbackPair(DEFAULTS)
      const order: number[] = []
      b.onMessage((_peerId, _channel, data) => { order.push(data[0]) })
      for (let i = 0; i < 8; i++) a.send('unreliable', 'b', new Uint8Array([i]))
      pump(1000)
      return order
    }

    const run1 = run()
    const run2 = run()

    expect(run1).toEqual(run2)
    // Locked in by direct simulation of rngAt(0xC0FFEE, cursor) against this
    // exact 8-send sequence (two draws per send, loss then jitter): sent
    // order is 0..7; index 6 draws the least jitter and arrives first, index
    // 1 draws the most and arrives last.
    expect(run1).toEqual([6, 2, 3, 4, 0, 5, 7, 1])
  })

  it('allows out-of-order delivery on unreliable but never on reliable', () => {
    const { a, b, pump } = makeLoopbackPair(DEFAULTS)
    const unreliableOrder: number[] = []
    const reliableOrder: number[] = []
    b.onMessage((_peerId, channel, data) => {
      if (channel === 'unreliable') unreliableOrder.push(data[0])
      else reliableOrder.push(data[0])
    })

    for (let i = 0; i < 8; i++) a.send('unreliable', 'b', new Uint8Array([i]))
    for (let i = 0; i < 8; i++) a.send('reliable', 'b', new Uint8Array([i]))
    pump(1000)

    expect(unreliableOrder).toEqual([6, 2, 3, 4, 0, 5, 7, 1]) // reordered
    expect(reliableOrder).toEqual([0, 1, 2, 3, 4, 5, 6, 7])   // never reordered
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/net/test/loopback.test.ts`

Expected: FAIL with `Error: Cannot find module '../src/loopback' imported
from '.../packages/net/test/loopback.test.ts'`. (`import type { LoopbackOptions
} from '../src/loopback'` is erased by the type-only-import rule discussed in
Task 11, but `import { makeLoopbackPair } from '../src/loopback'` on the
following line is a real value import and fails to resolve on its own — the
same "Cannot find module" shape as every other missing-file RED in this
package.)

- [ ] **Step 3: Implement `packages/net/src/loopback.ts`**

Create `packages/net/src/loopback.ts`:

```ts
import { rngAt } from '@tapkart/sim'
import type { ChannelName } from '@tapkart/protocol'
import type { Transport } from './transport'

export interface LoopbackOptions {
  latencyMs: number
  jitterMs: number
  lossRate: number
  seed: number
}

type Side = 'a' | 'b'

interface PendingMessage {
  from: Side
  channel: ChannelName
  data: Uint8Array
  deliverAt: number
}

/**
 * Two Transports wired directly to each other with injected latency, jitter
 * and loss, plus a pump(nowMs) that is the only place this module reads a
 * clock: send() and broadcast() only ever see whatever nowMs the most recent
 * pump() call provided, so a test controls time completely.
 *
 * Jitter and loss are drawn from rngAt(seed, cursor) using a cursor this pair
 * owns and increments itself -- never state.rngCursor, which belongs to the
 * leader's item rolls. A transport that advanced the sim's cursor would
 * desynchronise the shadow authority.
 */
export function makeLoopbackPair(
  opts: LoopbackOptions,
): { a: Transport; b: Transport; pump(nowMs: number): void } {
  const { latencyMs, jitterMs, lossRate, seed } = opts
  let cursor = 0
  let lastNow = 0
  let aClosed = false
  let bClosed = false
  const pending: PendingMessage[] = []
  const aMessageCbs: Array<(peerId: string, channel: ChannelName, data: Uint8Array) => void> = []
  const bMessageCbs: Array<(peerId: string, channel: ChannelName, data: Uint8Array) => void> = []
  const aPeerLostCbs: Array<(peerId: string) => void> = []
  const bPeerLostCbs: Array<(peerId: string) => void> = []

  function isClosed(side: Side): boolean {
    return side === 'a' ? aClosed : bClosed
  }

  function enqueue(from: Side, channel: ChannelName, data: Uint8Array): void {
    if (channel === 'unreliable') {
      const lossRoll = rngAt(seed, cursor)
      const jitterRoll = rngAt(seed, cursor + 1)
      cursor += 2
      if (lossRoll < lossRate) return
      pending.push({ from, channel, data, deliverAt: lastNow + latencyMs + jitterRoll * jitterMs })
    } else {
      pending.push({ from, channel, data, deliverAt: lastNow + latencyMs })
    }
  }

  function makeSide(self: Side): Transport {
    const other: Side = self === 'a' ? 'b' : 'a'
    const messageCbs = self === 'a' ? aMessageCbs : bMessageCbs
    const peerLostCbs = self === 'a' ? aPeerLostCbs : bPeerLostCbs
    return {
      send(channel, _peerId, data) {
        if (isClosed(self)) return
        enqueue(self, channel, data)
      },
      broadcast(channel, data) {
        if (isClosed(self)) return
        enqueue(self, channel, data)
      },
      onMessage(cb) {
        messageCbs.push(cb)
      },
      onPeerLost(cb) {
        peerLostCbs.push(cb)
      },
      peers() {
        if (isClosed(self)) return []
        return isClosed(other) ? [] : [other]
      },
      close() {
        if (self === 'a') aClosed = true
        else bClosed = true
      },
    }
  }

  const a = makeSide('a')
  const b = makeSide('b')

  function pump(nowMs: number): void {
    lastNow = nowMs
    const ready: PendingMessage[] = []
    const stillPending: PendingMessage[] = []
    for (const m of pending) {
      if (m.deliverAt <= nowMs) ready.push(m)
      else stillPending.push(m)
    }
    pending.length = 0
    for (const m of stillPending) pending.push(m)
    ready.sort((x, y) => x.deliverAt - y.deliverAt)
    for (const m of ready) {
      const destination: Side = m.from === 'a' ? 'b' : 'a'
      if (isClosed(destination)) continue
      const cbs = destination === 'a' ? aMessageCbs : bMessageCbs
      for (const cb of cbs) cb(m.from, m.channel, m.data)
    }
  }

  return { a, b, pump }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/net/test/loopback.test.ts`
Expected: PASS, 4 tests.

### Part B — `net-fixtures.ts`

- [ ] **Step 5: Write the failing test for the fixtures**

Create `packages/net/test/net-fixtures.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { makeLossyPair, makeNetContext } from './fixtures/net-fixtures'

describe('makeNetContext', () => {
  it('builds a SimContext over the Plan 1 oval track with the fixture tuning and characters', () => {
    const ctx = makeNetContext()
    expect(ctx.track.id).toBe('oval')
    expect(ctx.characters.length).toBe(8)
    expect(ctx.tuning.kartRadius).toBe(0.9)
    expect(ctx.isLeader).toBe(true)

    // Proves query is built from the real oval track, not a stub: this is
    // makeOvalTrack()'s own first control point, confirmed by running
    // buildTrackQuery(makeOvalTrack()).sampleAt(0) directly.
    const p0 = ctx.query.sampleAt(0)
    expect(p0.position.x).toBe(-200)
    expect(p0.position.z).toBe(-100)
    expect(p0.width).toBe(24)
  })

  it('honours an explicit isLeader', () => {
    expect(makeNetContext(false).isLeader).toBe(false)
    expect(makeNetContext(true).isLeader).toBe(true)
  })
})

describe('makeLossyPair', () => {
  it('defaults to spec §8\'s conditions: 150ms latency, 50ms jitter, 5% loss, seed 0xC0FFEE', () => {
    const { a, b, pump } = makeLossyPair()
    let delivered = false
    b.onMessage(() => { delivered = true })
    a.send('unreliable', 'b', new Uint8Array([9]))

    pump(149)
    expect(delivered).toBe(false)
    pump(250) // 150 + up to 50 jitter: always arrived by 250
    expect(delivered).toBe(true)
  })

  it('applies overrides on top of the defaults', () => {
    const { a, b, pump } = makeLossyPair({ lossRate: 1 })
    let delivered = false
    b.onMessage(() => { delivered = true })
    a.send('unreliable', 'b', new Uint8Array([9]))
    pump(1000)
    expect(delivered).toBe(false) // lossRate 1 drops every unreliable send
  })
})
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `npx vitest run packages/net/test/net-fixtures.test.ts`

Expected: FAIL with `Error: Cannot find module './fixtures/net-fixtures'
imported from '.../packages/net/test/net-fixtures.test.ts'`.
`packages/net/src/loopback.ts` already exists from Part A, so this failure is
specifically about `net-fixtures.ts` not existing yet, not about anything
upstream.

- [ ] **Step 7: Implement `packages/net/test/fixtures/net-fixtures.ts`**

Create `packages/net/test/fixtures/net-fixtures.ts`:

```ts
import type { SimContext } from '@tapkart/sim'
import { buildTrackQuery } from '@tapkart/sim'
import { makeCharacters, makeOvalTrack, makeTuning } from '../../../sim/test/fixtures/track-fixtures'
import type { LoopbackOptions } from '../../src/loopback'
import { makeLoopbackPair } from '../../src/loopback'

/**
 * A SimContext over the Plan 1 golden oval track (packages/sim/test/fixtures
 * /track-fixtures.ts's makeOvalTrack) with Plan 1's base tuning table and its
 * 8 fixture characters. Reached by relative path, not the @tapkart/sim
 * package specifier: these three functions live under sim's test/fixtures,
 * which sim's own production barrel never re-exports -- see this task's
 * Interfaces block for the full justification.
 */
export function makeNetContext(isLeader = true): SimContext {
  const track = makeOvalTrack()
  return {
    track,
    query: buildTrackQuery(track),
    tuning: makeTuning(),
    characters: makeCharacters(),
    isLeader,
  }
}

/** Spec §8's convergence and zero-corrections conditions. */
const DEFAULT_LOOPBACK_OPTIONS: LoopbackOptions = {
  latencyMs: 150,
  jitterMs: 50,
  lossRate: 0.05,
  seed: 0xc0ffee,
}

export function makeLossyPair(
  overrides?: Partial<LoopbackOptions>,
): ReturnType<typeof makeLoopbackPair> {
  return makeLoopbackPair({ ...DEFAULT_LOOPBACK_OPTIONS, ...overrides })
}
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `npx vitest run packages/net/test/net-fixtures.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 9: Typecheck the package and run the whole `net` and `protocol` suites**

Run:

```bash
npx tsc --noEmit -p packages/net
npx vitest run packages/net packages/protocol
```

Expected: no diagnostics; every test in both packages passes, including this
task's 8 (`loopback.test.ts` 4, `net-fixtures.test.ts` 4) alongside Task 11's
5 (2 in `scaffold.test.ts`, 3 in `transport.test.ts` — Task 11's own
residual-findings pass added a third transport test, so this figure no longer
matches its original "4") and Task 10's 2.

- [ ] **Step 10: Full repo sanity check**

Run:

```bash
npm run typecheck
npm test
```

Expected: both exit 0.

- [ ] **Step 11: Commit**

```bash
git add packages/net/src/loopback.ts packages/net/test/loopback.test.ts \
        packages/net/test/fixtures/net-fixtures.ts packages/net/test/net-fixtures.test.ts
git commit -m "feat(net): LoopbackTransport pair and net test fixtures

makeLoopbackPair wires two Transports together with injected latency,
jitter and loss, and a pump(nowMs) that is the only clock this module
reads -- send()/broadcast() schedule against whatever nowMs the last
pump() call provided.

Jitter and loss are drawn from rngAt(seed, cursor) on a cursor this
pair owns and advances itself, two draws per unreliable send
(unconditionally, whether or not the message survives) and zero for
reliable sends -- never state.rngCursor, which belongs to the leader's
item rolls and would desynchronise the shadow authority if a transport
touched it. Jitter is one-sided (extra delay in [0, jitterMs)), so
'arrives after latencyMs and not before' holds unconditionally.

Reliable sends carry no jitter, so their scheduled delivery times are
already monotonic in send order; the single sort-based delivery
algorithm in pump() therefore preserves reliable order as a structural
consequence and allows unreliable reordering as the same algorithm's
natural consequence of jittered scheduling -- proven with a seed and
call sequence that reorders 8 sends into [6,2,3,4,0,5,7,1], reproduced
identically across two independent pairs built from the same seed.

net-fixtures.ts adds makeNetContext (the Plan 1 oval track, reached by
relative import since sim's production barrel never exports test
fixtures) and makeLossyPair, preset to spec §8's 150ms/50ms/5%/0xC0FFEE
convergence conditions."
```
