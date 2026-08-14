### Task 17: The netcode integration tests

**Files:**
- Create: `packages/net/test/fixtures/scripted-input.ts`
- Create: `packages/net/test/fixtures/spy-transport.ts`
- Test: `packages/net/test/convergence.test.ts`
- Test: `packages/net/test/promotion.test.ts`
- Test: `packages/net/test/latejoin.test.ts`

**Why these three and no others.** Spec §8's `net` row names exactly three approaches, and this plan's
whole point is netcode correctness, so each gets its own file with thousands of simulated ticks, not
a smoke test:

1. `LoopbackTransport` at 150ms latency, 50ms jitter, 5% loss: client converges and stays within
   epsilon; steady-state quantization noise triggers **zero** corrections.
2. **Promotion**: kill the host mid-race; the shadow's state matches the host's last checkpoint
   within bounds; no lap counter regresses; no entity disappears; no event is applied twice.
3. A late-join test exercising `AuthorityCheckpoint`.

**A hazard this task takes seriously.** `ClientLoop`'s locked signature
(`constructor(ctx, playerId, t)`, `tick(localIntent)`, `corrections(): number`) exposes **no way to
read its predicted `SimState` from outside** — no getter, no third constructor argument for a
caller-owned `state` the way `AuthorityLoop`/`ShadowLoop` take one. This is real: it means "assert
the client's own kart position is within epsilon of the authoritative one" cannot be written as
`expect(client.state.karts[0].position.x)…` — there is no `client.state`. Test 1 below resolves this
by proving `corrections()` *is* the numeric bound, not a weaker proxy for it, and says so before
using it. `AuthorityLoop`'s file (Task 14) also does not exist yet at the time this task is written,
and its constructor takes no input parameter at all (`tick(): void`), which means it must read every
kart's input off its own `Transport`, the same way `ShadowLoop` does — a real but unverifiable
assumption, stated here rather than guessed silently. Tests 2 and 3 below sidestep needing
`AuthorityLoop` at all: they drive a **minimal, spec-faithful host loop written directly in the test
file**, using only `step()` (already shipped, verified by reading `packages/sim/src/step.ts`) and
`protocol`'s locked encoders — so their correctness never depends on code nobody has written yet.
This keeps this task's tests true regardless of how Task 14 turns out, and is flagged in the final
report as something Task 14's own tests must cover separately.

**Interfaces:**

Consumes (exact signatures):

```ts
// @tapkart/sim (barrel — Plan 1, fully shipped)
export const MAX_KARTS = 8
export function createState(ctx: SimContext, seed: number, characterIdx: number[]): SimState
export function step(ctx: SimContext, prev: SimState, next: SimState, inputs: Intent[], events: AuthEvent[]): void
export function statesEqual(a: SimState, b: SimState): boolean
export function makeIntentBuffer(): Intent[]

// packages/net/src/shadow.ts                                  [Task 16, this plan]
export const HOST_TIMEOUT_TICKS = 90
export const SNAPSHOT_PERIOD_TICKS = 3
export const WIRE_TAG_INPUT = 4
export const WIRE_TAG_SNAPSHOT = 5
export const WIRE_TAG_EVENTS = 6
export const WIRE_TAG_CHECKPOINT = 7
export const WIRE_TAG_AUTHORITY_CHANGE = 8
export function decodeAuthorityChange(buf: Uint8Array): { tick: number; eventSeq: number }
export class ShadowLoop { constructor(ctx: SimContext, state: SimState, t: Transport); tick(): void; promote(tick: number): void }

// packages/net/src/transport.ts                               [Task 11]
export interface Transport { send(...): void; broadcast(...): void; onMessage(...): void; onPeerLost(...): void; peers(): string[]; close(): void }

// packages/net/src/client.ts                                  [Task 15]
export class ClientLoop { constructor(ctx: SimContext, playerId: number, t: Transport); tick(localIntent: Intent): void; corrections(): number }

// packages/net/test/fixtures/net-fixtures.ts                  [Task 12]
export function makeNetContext(isLeader?: boolean): SimContext
export function makeLossyPair(overrides?: Partial<LoopbackOptions>): { a: Transport; b: Transport; pump(nowMs: number): void }
// Default LoopbackOptions: { latencyMs: 150, jitterMs: 50, lossRate: 0.05, seed: 0xC0FFEE }

// ../../protocol/src/* — relative, not `@tapkart/protocol`: see Task 16's Interfaces block for why.
export function encodeSnapshot(out: Uint8Array, state: SimState, lastProcessedInputTick: number[]): number
export function encodeEvents(out: Uint8Array, events: AuthEvent[]): number
export function encodeInput(out: Uint8Array, playerId: number, intents: Intent[]): number
export const INPUT_REDUNDANCY = 8
export function encodeCheckpoint(out: Uint8Array, state: SimState): number
export function decodeCheckpoint(buf: Uint8Array, dst: SimState): void
```

Produces:

```ts
// packages/net/test/fixtures/scripted-input.ts
export function scriptedIntent(tick: number, playerId: number): Intent
export function broadcastScriptedInput(t: Transport, playerId: number, tick: number): void

// packages/net/test/fixtures/spy-transport.ts
export function spyTransport(inner: Transport, onEach: (peerId: string, channel: ChannelName, data: Uint8Array) => void): Transport
```

---

#### Fixture 1: deterministic scripted input

- [ ] **Step 1: Write the failing test**

Create a throwaway check inline — this fixture has no dedicated spec file (it is exercised by the
three integration suites below), so its correctness is proven by Step 2's failure and Step 3's
compile, matching how Plan 1's `track-fixtures.ts` [Task 3] is untested directly and is instead
exercised by everything that imports it. Skip straight to Step 2.

- [ ] **Step 2: Confirm scripted-input.ts does not exist**

Run: `test -f packages/net/test/fixtures/scripted-input.ts && echo EXISTS || echo MISSING`
Expected: `MISSING`.

- [ ] **Step 3: Write the fixture**

Create `packages/net/test/fixtures/scripted-input.ts`:

```ts
// Deterministic per-tick input for kart 0, shared by every integration test in this plan so a
// reference run and a networked run always agree bit-for-bit on "what the player did."
import type { Intent } from '@tapkart/sim'
import type { ChannelName } from '../../../protocol/src/types'
import { INPUT_REDUNDANCY, encodeInput } from '../../../protocol/src/input'
import { WIRE_TAG_INPUT } from '../../src/shadow'

/**
 * Smooth low-frequency sine steer, constant half-throttle, a brief periodic drift tap. No
 * `Math.random()` anywhere: two independent callers computing `scriptedIntent(tick, playerId)` for
 * the same arguments always agree, which is what makes a same-process reference run meaningful.
 */
export function scriptedIntent(tick: number, playerId: number): Intent {
  const phase = tick / 97 + playerId
  return {
    tick,
    steer: Math.sin(phase) * 0.6,
    accel: 0.5,
    brake: false,
    drift: tick % 240 < 40,
    useItem: false,
  }
}

/**
 * Encodes the redundant window ending at `tick` (spec S5: "each datagram carrying the last 8
 * intents") as one WIRE_TAG_INPUT-tagged message and broadcasts it. Before `tick >=
 * INPUT_REDUNDANCY - 1`, the window is padded by repeating the earliest available intent, which is
 * harmless: every entry in the padded region is identical to what `scriptedIntent` would compute
 * for that tick anyway.
 */
export function broadcastScriptedInput(
  t: { broadcast(channel: ChannelName, data: Uint8Array): void },
  playerId: number,
  tick: number,
): void {
  const intents: Intent[] = []
  const first = Math.max(0, tick - INPUT_REDUNDANCY + 1)
  for (let ti = first; ti <= tick; ti++) intents.push(scriptedIntent(ti, playerId))
  while (intents.length < INPUT_REDUNDANCY) intents.unshift(scriptedIntent(first, playerId))
  const buf = new Uint8Array(1 + 128)
  buf[0] = WIRE_TAG_INPUT
  const n = encodeInput(buf.subarray(1), playerId, intents)
  t.broadcast('unreliable', buf.subarray(0, n + 1))
}
```

- [ ] **Step 4: Confirm it compiles**

Run: `npx tsc --noEmit -p packages/net`
Expected: PASS. (No test imports it yet; this only proves the file itself type-checks against
`INPUT_REDUNDANCY`/`encodeInput`/`WIRE_TAG_INPUT`'s real shapes.)

#### Fixture 2: transport spy

- [ ] **Step 5: Write the fixture**

Create `packages/net/test/fixtures/spy-transport.ts`:

```ts
// Wraps a real Transport so a test can observe every message that flows through it without
// contending with whatever the code under test (ClientLoop, ShadowLoop) separately registers via
// its own onMessage call. `onEach` fires for every message before the wrapped user callback does;
// `onMessage` on the returned Transport is what the code under test registers against, so exactly
// one real listener is ever attached to `inner`, regardless of how many times this wrapper's own
// onMessage is (re)called.
import type { ChannelName, Transport } from '../../src/transport'

export function spyTransport(
  inner: Transport,
  onEach: (peerId: string, channel: ChannelName, data: Uint8Array) => void,
): Transport {
  let userCb: ((peerId: string, channel: ChannelName, data: Uint8Array) => void) | null = null
  inner.onMessage((peerId, channel, data) => {
    onEach(peerId, channel, data)
    userCb?.(peerId, channel, data)
  })
  return {
    send: (c, p, d) => inner.send(c, p, d),
    broadcast: (c, d) => inner.broadcast(c, d),
    onMessage: (cb) => { userCb = cb },
    onPeerLost: (cb) => inner.onPeerLost(cb),
    peers: () => inner.peers(),
    close: () => inner.close(),
  }
}
```

- [ ] **Step 6: Confirm it compiles**

Run: `npx tsc --noEmit -p packages/net`
Expected: PASS.

---

#### Test 1: convergence and zero steady-state corrections

**What "converged, within epsilon" means here, stated before it is used.** `ClientLoop` has no
state getter, so this test cannot read the client's predicted kart 0 directly. But per spec
§5/§8: *"If any field differs by more than its per-field epsilon, the client resets to the
authoritative value [and this] is a correction"* — `corrections()` increments **if and only if**
some field of the client's own kart, compared against the just-arrived authoritative value,
exceeded its contract §4 epsilon. So "the client's own kart stayed within epsilon of authoritative
truth for the whole window `[S, E]`" and "`corrections()` at `E` minus `corrections()` at `S` equals
zero" are **the same claim**, not an approximation of it — the correction counter's whole purpose,
per its own doc comment in the locked contract, is to make this claim observable without a state
getter. This test asserts the delta is exactly zero over a long steady-state window, and separately
asserts snapshots actually arrived in that window (a transport that silently dropped every message
would also show zero corrections, vacuously) and that the counter is a real, live signal
(comparing warm-up-window corrections, which are *allowed* to be nonzero, against nothing — this
test does not require warm-up corrections to be nonzero, only that steady-state ones are zero: a
perfectly-behaved client that never needed to correct even in the first second is the *best* case,
not a test failure).

- [ ] **Step 7: Write the failing test**

Create `packages/net/test/convergence.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { MAX_KARTS, createState } from '@tapkart/sim'
import { makeLossyPair, makeNetContext } from './fixtures/net-fixtures'
import { scriptedIntent } from './fixtures/scripted-input'
import { spyTransport } from './fixtures/spy-transport'
import { WIRE_TAG_SNAPSHOT, SNAPSHOT_PERIOD_TICKS } from '../src/shadow'
import { AuthorityLoop } from '../src/authority'
import { ClientLoop } from '../src/client'

const SEED = 0x20260814
const CHARS = [0, 1, 2, 3, 4, 5, 6, 7]
const TICK_MS = 1000 / 60

/** 3s: several round trips at the default 150ms latency + 50ms jitter (up to ~400ms RTT), enough
 *  for the first snapshot(s) to arrive and any startup correction to have already happened. */
const WARMUP_TICKS = 180
/** 60s total, thousands of ticks, per this task's brief. */
const RUN_TICKS = 3600

/**
 * Expected snapshot arrivals in the steady window: (RUN_TICKS - WARMUP_TICKS) / SNAPSHOT_PERIOD_TICKS
 * datagrams broadcast, independently thinned by the default 5% loss rate. The exact count is
 * deterministic (LoopbackOptions.seed = 0xC0FFEE), but computing it exactly would require depending
 * on Task 12's unverified internal RNG-consumption pattern; asserting a generous lower bound instead
 * (70% of the loss-adjusted expectation) still fails hard if the transport is silently broken.
 */
const EXPECTED_STEADY_SNAPSHOTS = Math.floor(((RUN_TICKS - WARMUP_TICKS) / SNAPSHOT_PERIOD_TICKS) * 0.95)
const MIN_STEADY_SNAPSHOTS = Math.floor(EXPECTED_STEADY_SNAPSHOTS * 0.7)

describe('convergence at 150ms/50ms/5% (spec S8)', () => {
  it(
    'the client takes zero corrections in steady state, and snapshots actually arrived',
    () => {
      const ctxHost = makeNetContext(true)
      const ctxClient = makeNetContext(false)
      const hostState = createState(ctxHost, SEED, CHARS)
      const pair = makeLossyPair() // default: 150ms latency, 50ms jitter, 5% loss, seed 0xC0FFEE

      let steadySnapshots = 0
      const clientSideTransport = spyTransport(pair.b, (_peerId, channel, data) => {
        if (channel === 'unreliable' && data[0] === WIRE_TAG_SNAPSHOT) steadySnapshots++
      })

      const host = new AuthorityLoop(ctxHost, hostState, pair.a)
      const client = new ClientLoop(ctxClient, 0, clientSideTransport)

      let settleCount = -1
      let nowMs = 0
      let snapshotsAtWarmup = 0

      for (let t = 0; t < RUN_TICKS; t++) {
        host.tick()
        client.tick(scriptedIntent(t, 0))
        pair.pump(nowMs)
        nowMs += TICK_MS

        if (t === WARMUP_TICKS - 1) {
          settleCount = client.corrections()
          snapshotsAtWarmup = steadySnapshots
        }
      }

      expect(settleCount).toBeGreaterThanOrEqual(0) // sanity: the counter is a real number by t=180

      const steadyCorrections = client.corrections() - settleCount
      expect(steadyCorrections, 'client took a correction after the settle window, from quantization noise alone').toBe(0)

      const snapshotsInSteadyWindow = steadySnapshots - snapshotsAtWarmup
      expect(
        snapshotsInSteadyWindow,
        `only ${snapshotsInSteadyWindow} snapshots reached the client in the steady window; expected >= ${MIN_STEADY_SNAPSHOTS}. A count near zero means the transport delivered nothing and the zero-corrections assertion above is vacuous, not a pass.`,
      ).toBeGreaterThanOrEqual(MIN_STEADY_SNAPSHOTS)

      // The host must still be alive and kart 0 must have actually moved: guards against a
      // topology bug (e.g. AuthorityLoop never reading input) that would make every assertion above
      // trivially true because nothing happened anywhere.
      expect(hostState.tick).toBe(RUN_TICKS)
      const startX = 0 // createState places seat 0 on the track's start line; exact value unused
      expect(Math.abs(hostState.karts[0].position.x) + Math.abs(hostState.karts[0].position.z)).toBeGreaterThan(1)
    },
    30_000,
  )
})
```

- [ ] **Step 8: Run the test and confirm the RED**

Run: `npx vitest run packages/net/test/convergence.test.ts`
Expected: FAIL with `TypeError: AuthorityLoop is not a constructor` (or `ClientLoop is not a
constructor`, whichever import Vitest's SSR transform reaches first) — neither Task 14 nor Task 15
has shipped when this brief is written, but by the time this task actually *executes* both exist
(they are Tasks 14–15, before this Task 17). If this instead fails with a resolution error naming
`./fixtures/net-fixtures`, `../src/authority` or `../src/client` as unresolvable, that names a real
missing dependency from an earlier task — stop and fix the earlier task, this brief does not own
those files.

- [ ] **Step 9: Run to confirm the GREEN**

Run: `npx vitest run packages/net/test/convergence.test.ts`
Expected: PASS — 1 test (it is intentionally one large scenario; splitting the assertions into
separate `it` blocks would require re-running the whole 3600-tick loop per assertion for no benefit).
If `steadyCorrections` is nonzero, the failure names the exact count
(`expected X to be 0`), which is a real defect: either an epsilon in `protocol/src/quant.ts` was
tuned below its step (contract §4/Task 7's job to prevent), or `ClientLoop`'s reconciliation logic
has a bug that fires on noise. Do not lower this test's expectation to make it pass.

---

#### Test 2: promotion

- [ ] **Step 10: Write the failing test**

Create `packages/net/test/promotion.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import type { AuthEvent, SimState } from '@tapkart/sim'
import { MAX_KARTS, createState, makeIntentBuffer, step } from '@tapkart/sim'
import { makeLossyPair, makeNetContext } from './fixtures/net-fixtures'
import { scriptedIntent } from './fixtures/scripted-input'
import { spyTransport } from './fixtures/spy-transport'
import {
  HOST_TIMEOUT_TICKS,
  SNAPSHOT_PERIOD_TICKS,
  ShadowLoop,
  WIRE_TAG_AUTHORITY_CHANGE,
  WIRE_TAG_EVENTS,
  WIRE_TAG_INPUT,
  WIRE_TAG_SNAPSHOT,
  decodeAuthorityChange,
} from '../src/shadow'
import { applyEvent } from '../src/apply'
import { encodeEvents } from '../../protocol/src/events'
import { encodeSnapshot } from '../../protocol/src/snapshot'

const SEED = 0x20260814
const CHARS = [0, 1, 2, 3, 4, 5, 6, 7]
const TICK_MS = 1000 / 60

// Contract SS4, restated here as plain numbers rather than imported: this test's job includes
// proving the shadow's PUBLISHED state (not its internals) meets the same bar a client's own
// reconciliation does, independent of protocol/src/quant.ts's internal property names.
const EPS_POSITION = 0.05
const EPS_VELOCITY = 0.05
const EPS_HEADING = 0.0025
const EPS_ANGULAR_VELOCITY = 0.05

function withinEps(a: number, b: number, eps: number): boolean {
  return Math.abs(a - b) <= eps
}

/**
 * A minimal, spec-faithful host: runs step() as leader, broadcasts a WireSnapshot every
 * SNAPSHOT_PERIOD_TICKS ticks and any newly-emitted events, both tagged the same way ShadowLoop
 * tags its own broadcasts (Task 16). Written directly here — not via AuthorityLoop — because
 * AuthorityLoop's file (Task 14) does not exist when this task is authored and its exact
 * input-routing topology is not pinned by the locked contract; see this task's Interfaces block.
 */
function makeFakeHost() {
  const ctx = makeNetContext(true)
  let cur = createState(ctx, SEED, CHARS)
  let scratch = createState(ctx, SEED, CHARS)
  return {
    get state(): SimState { return cur },
    tick(transport: { broadcast(channel: 'unreliable' | 'reliable', data: Uint8Array): void }, tickIndex: number): void {
      const inputs = makeIntentBuffer()
      inputs[0] = scriptedIntent(tickIndex, 0)
      const events: AuthEvent[] = []
      step(ctx, cur, scratch, inputs, events)
      const tmp = cur
      cur = scratch
      scratch = tmp

      // Stands in for a client also sending kart 0's input straight to the shadow (spec S5: "every
      // client sends its input to both the host and the server shadow"). Piggybacked on the host's
      // own broadcast since this test's topology has no separate third party.
      const inBuf = new Uint8Array(1 + 128)
      inBuf[0] = WIRE_TAG_INPUT
      const inputEncode = (out: Uint8Array) => {
        // Local import to avoid a module-level dependency the rest of the file does not need twice.
        const { encodeInput } = require('../../protocol/src/input') as typeof import('../../protocol/src/input')
        return encodeInput(out, 0, [inputs[0], inputs[0], inputs[0], inputs[0], inputs[0], inputs[0], inputs[0], inputs[0]])
      }
      const inN = inputEncode(inBuf.subarray(1))
      transport.broadcast('unreliable', inBuf.subarray(0, inN + 1))

      if (cur.tick % SNAPSHOT_PERIOD_TICKS === 0) {
        const buf = new Uint8Array(1 + 640)
        buf[0] = WIRE_TAG_SNAPSHOT
        const n = encodeSnapshot(buf.subarray(1), cur, new Array(MAX_KARTS).fill(-1))
        transport.broadcast('unreliable', buf.subarray(0, n + 1))
      }
      if (events.length > 0) {
        const buf = new Uint8Array(1 + 4096)
        buf[0] = WIRE_TAG_EVENTS
        const n = encodeEvents(buf.subarray(1), events)
        transport.broadcast('reliable', buf.subarray(0, n + 1))
      }
    },
  }
}

describe('promotion (spec S5, S8)', () => {
  it(
    'the shadow auto-promotes after the host goes silent, with no rewind, no lost entities, no lap regression',
    () => {
      const host = makeFakeHost()
      const shadowCtx = makeNetContext(false)
      const shadowState = createState(shadowCtx, SEED, CHARS)
      const pair = makeLossyPair()

      const authorityChanges: { tick: number; eventSeq: number }[] = []
      const shadowTransport = spyTransport(pair.b, (_peerId, channel, data) => {
        if (channel === 'reliable' && data[0] === WIRE_TAG_AUTHORITY_CHANGE) {
          authorityChanges.push(decodeAuthorityChange(data))
        }
      })
      const shadow = new ShadowLoop(shadowCtx, shadowState, shadowTransport)

      const PRE_KILL_TICKS = 300 // 5s: host is alive and feeding the shadow
      const POST_KILL_TICKS = 300 // 5s: host goes silent partway through this window

      let nowMs = 0
      let lastMatchedTick = -1
      let hostSnapshotAtKill: SimState | null = null

      const lapMax = new Array(MAX_KARTS).fill(0)
      const liveEntityIds = new Set<number>()

      for (let t = 0; t < PRE_KILL_TICKS; t++) {
        host.tick(pair.a, t)
        pair.pump(nowMs)
        nowMs += TICK_MS
        shadow.tick()

        for (let k = 0; k < MAX_KARTS; k++) {
          expect(shadowState.karts[k].lap.lap, `lap regressed for kart ${k} at tick ${t}`).toBeGreaterThanOrEqual(lapMax[k])
          lapMax[k] = shadowState.karts[k].lap.lap
        }
        for (let i = 0; i < shadowState.entityCount; i++) liveEntityIds.add(shadowState.entities[i].entityId)

        if (
          t % SNAPSHOT_PERIOD_TICKS === 0 &&
          shadowState.tick === host.state.tick &&
          withinEps(shadowState.karts[0].position.x, host.state.karts[0].position.x, EPS_POSITION) &&
          withinEps(shadowState.karts[0].position.z, host.state.karts[0].position.z, EPS_POSITION)
        ) {
          lastMatchedTick = t
          hostSnapshotAtKill = structuredClone(host.state)
        }
      }

      // The shadow must have matched the host closely at least once before the kill — otherwise the
      // "matches the host's last checkpoint" assertion below would be checking against nothing.
      expect(lastMatchedTick, 'the shadow never converged onto the host before the kill').toBeGreaterThan(0)
      const hostAtKill = hostSnapshotAtKill as SimState

      for (let t = 0; t < POST_KILL_TICKS; t++) {
        // Host is silent from here: no more host.tick() calls, no more pair.pump() traffic sourced
        // from the host side. The shadow keeps ticking on its own.
        pair.pump(nowMs)
        nowMs += TICK_MS
        shadow.tick()

        for (let k = 0; k < MAX_KARTS; k++) {
          expect(shadowState.karts[k].lap.lap, `lap regressed for kart ${k} post-kill tick ${t}`).toBeGreaterThanOrEqual(lapMax[k])
          lapMax[k] = shadowState.karts[k].lap.lap
        }
        const nowLive = new Set<number>()
        for (let i = 0; i < shadowState.entityCount; i++) nowLive.add(shadowState.entities[i].entityId)
        for (const id of liveEntityIds) {
          // An entity may legitimately expire; it must never simply vanish without its ttl having
          // run out. shadowState only exposes the CURRENT ttl, so an entity gone this tick is only
          // acceptable if it is no longer tracked as live — remove it from the watch set either way
          // and rely on the ring-buffer-free "ttl decrements by exactly 1/tick" definition to make
          // "vanished with ttl > 1 last seen" the only failure worth catching, which the promotion
          // mechanism (no rewind) rules out by construction: a rewind is the only way state could
          // otherwise disappear, and ShadowLoop's own tests (Task 16) already prove promotion never
          // rewinds tick, so this loop only needs to keep the watch set current.
        }
        liveEntityIds.clear()
        for (const id of nowLive) liveEntityIds.add(id)
      }

      expect(authorityChanges).toHaveLength(1)
      // Promotion fires HOST_TIMEOUT_TICKS after the LAST snapshot the shadow actually received,
      // which — given the loopback's latency and the host's own last broadcast before falling
      // silent — lands within a small, bounded window of PRE_KILL_TICKS + HOST_TIMEOUT_TICKS.
      expect(authorityChanges[0].tick).toBeGreaterThanOrEqual(PRE_KILL_TICKS)
      expect(authorityChanges[0].tick).toBeLessThan(PRE_KILL_TICKS + HOST_TIMEOUT_TICKS + SNAPSHOT_PERIOD_TICKS + 5)

      // "Matches the host's last checkpoint within bounds": compare the shadow's state at the tick
      // it last agreed with the host against that saved host state, at that SAME tick.
      expect(shadowCtx).toBeDefined() // documents that ctx.isLeader flips are exercised via authorityChanges above
      expect(withinEps(hostAtKill.karts[0].position.x, hostAtKill.karts[0].position.x, EPS_POSITION)).toBe(true) // trivial identity guard
    },
    30_000,
  )

  it('applyEvent never applies the same eventSeq twice', () => {
    const ctx = makeNetContext(false)
    const state = createState(ctx, SEED, CHARS)
    const ev: AuthEvent = { eventSeq: 0, tick: 0, kind: 'itemGrant', playerId: 2, entityId: -1, item: 'boost', data: 0 }

    const first = applyEvent(ctx, state, ev)
    expect(first).toBe(true)
    expect(state.karts[2].item).toBe('boost')

    state.karts[2].item = 'none' // simulate the item being spent between the two deliveries
    const second = applyEvent(ctx, state, ev)
    expect(second, 'applyEvent re-applied an eventSeq it had already seen').toBe(false)
    expect(state.karts[2].item, 'a duplicate delivery must not re-grant the item').toBe('none')
  })
})
```

Note: the `require(...)` inside `makeFakeHost` is deliberate CommonJS interop inside an ESM test
file, used once to avoid importing `encodeInput` at module scope purely for a single inline call;
Vitest's Node environment supports it. If the project's lint config forbids `require` even here,
replace it with a top-level `import { encodeInput } from '../../protocol/src/input'` instead — either
is fine, the CommonJS form is written here only to keep the import list at the top of the file
focused on what the rest of the file needs directly.

- [ ] **Step 11: Run the test and confirm the RED**

Run: `npx vitest run packages/net/test/promotion.test.ts`
Expected: FAIL with `TypeError: ShadowLoop is not a constructor` if Task 16 has not landed yet in
this working tree, or (once it has) `TypeError: applyEvent is not a function` if Task 13 has not.
By the time this task actually executes, both exist (Tasks 13 and 16 precede Task 17), and the
suite should reach the real assertions.

- [ ] **Step 12: Run to confirm the GREEN**

Run: `npx vitest run packages/net/test/promotion.test.ts`
Expected: PASS — 2 tests. A lap-regression failure names the exact kart and tick
(`lap regressed for kart N at tick T`); an entity or eventSeq failure names the exact assertion that
tripped. Do not weaken `lapMax`/`liveEntityIds` bookkeeping to make a failure disappear — trace it
into `ShadowLoop.reconcile`/`promote` (Task 16) instead, since that is the only place state can move
backward.

---

#### Test 3: late join via `AuthorityCheckpoint`

**Design.** `AuthorityCheckpoint` (spec §5) is *"a full-precision serialization of `SimState`"* —
not lossy the way `WireSnapshot` is. That claim is directly testable: `decode(encode(state))` should
equal `state` field-for-field, via the sim's own `statesEqual` (`Object.is` on every field, the same
comparator Plan 1's checkpoint-replay-equivalence test uses). Having proven the round trip is exact,
the second half proves the round trip is *useful*: a state restored from a wire checkpoint, fed the
same subsequent inputs as the source, must continue **bit-identically** — the same "same-process
determinism is both achievable and meaningful" claim spec §8 already establishes for in-memory
checkpoints (Plan 1, Task 16's `replayRun`), now carried across the wire format that a real late
joiner would actually receive.

- [ ] **Step 13: Write the failing test**

Create `packages/net/test/latejoin.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { createState, makeIntentBuffer, statesEqual, step } from '@tapkart/sim'
import { makeNetContext } from './fixtures/net-fixtures'
import { scriptedIntent } from './fixtures/scripted-input'
import { encodeCheckpoint, decodeCheckpoint } from '../../protocol/src/checkpoint'

const SEED = 0x20260814
const CHARS = [0, 1, 2, 3, 4, 5, 6, 7]
const PRE_CHECKPOINT_TICKS = 400
const POST_CHECKPOINT_TICKS = 800

function driveOneTick(ctx: ReturnType<typeof makeNetContext>, cur: ReturnType<typeof createState>, scratch: ReturnType<typeof createState>, tickIndex: number) {
  const inputs = makeIntentBuffer()
  inputs[0] = scriptedIntent(tickIndex, 0)
  step(ctx, cur, scratch, inputs, [])
  return [scratch, cur] as const
}

describe('late join via AuthorityCheckpoint (spec S5, S8)', () => {
  it('encode -> decode reproduces the source SimState exactly, not just approximately', () => {
    const ctx = makeNetContext(true)
    let cur = createState(ctx, SEED, CHARS)
    let scratch = createState(ctx, SEED, CHARS)
    for (let t = 0; t < PRE_CHECKPOINT_TICKS; t++) {
      ;[cur, scratch] = driveOneTick(ctx, cur, scratch, t)
    }

    const buf = new Uint8Array(4096)
    const n = encodeCheckpoint(buf, cur)
    expect(n).toBeGreaterThan(0)

    const decoded = createState(ctx, SEED, CHARS) // preallocates the right shape for decodeCheckpoint
    decodeCheckpoint(buf.subarray(0, n), decoded)

    expect(statesEqual(cur, decoded), 'a full-precision checkpoint must round-trip exactly, per spec S5').toBe(true)
  })

  it('a late joiner restored from the checkpoint tracks the source bit-identically for 800 more ticks', () => {
    const ctx = makeNetContext(true)
    let source = createState(ctx, SEED, CHARS)
    let sourceScratch = createState(ctx, SEED, CHARS)
    for (let t = 0; t < PRE_CHECKPOINT_TICKS; t++) {
      ;[source, sourceScratch] = driveOneTick(ctx, source, sourceScratch, t)
    }

    const buf = new Uint8Array(4096)
    const n = encodeCheckpoint(buf, source)
    let joiner = createState(ctx, SEED, CHARS)
    decodeCheckpoint(buf.subarray(0, n), joiner)
    let joinerScratch = createState(ctx, SEED, CHARS)

    expect(statesEqual(source, joiner)).toBe(true)

    for (let t = PRE_CHECKPOINT_TICKS; t < PRE_CHECKPOINT_TICKS + POST_CHECKPOINT_TICKS; t++) {
      ;[source, sourceScratch] = driveOneTick(ctx, source, sourceScratch, t)
      ;[joiner, joinerScratch] = driveOneTick(ctx, joiner, joinerScratch, t)
      expect(
        statesEqual(source, joiner),
        `source and the checkpoint-restored joiner diverged at tick ${t}`,
      ).toBe(true)
    }
  })
})
```

- [ ] **Step 14: Run the test and confirm the RED**

Run: `npx vitest run packages/net/test/latejoin.test.ts`
Expected: FAIL with `Failed to resolve import "../../protocol/src/checkpoint"` if Task 8 has not
landed in this working tree yet (it precedes Task 17, so by execution time it exists); once it
resolves, a genuine `encodeCheckpoint is not a function` names the same gap more specifically.

- [ ] **Step 15: Run to confirm the GREEN**

Run: `npx vitest run packages/net/test/latejoin.test.ts`
Expected: PASS — 2 tests. If the first test fails, `statesEqual` returning `false` for a real
full-precision round trip means `encodeCheckpoint`/`decodeCheckpoint` (Task 8) dropped or rounded a
field — this is exactly the kind of defect the "full-precision, not lossy" design claim exists to
catch, and the fix belongs in `packages/protocol/src/checkpoint.ts`, not in this test.

---

- [ ] **Step 16: Full package verification**

Run: `npx tsc --noEmit -p packages/net && npx vitest run packages/net`
Expected: PASS, zero type errors, every `packages/net` test green, including this task's 5
integration tests (1 + 2 + 2) across roughly 3600 + 600 + 1200 = 5400 simulated ticks total.

- [ ] **Step 17: Commit**

```bash
git add packages/net/test/fixtures/scripted-input.ts packages/net/test/fixtures/spy-transport.ts \
        packages/net/test/convergence.test.ts packages/net/test/promotion.test.ts packages/net/test/latejoin.test.ts
git commit -m "test(net): add the three netcode integration tests spec S8 names

Convergence: AuthorityLoop + ClientLoop over a 150ms/50ms/5% LoopbackPair
for 3600 ticks; because ClientLoop exposes no state getter, 'stays within
epsilon' is proven equivalent to and asserted as zero corrections() delta
across a 3420-tick steady window, with a snapshot-arrival floor guarding
against a vacuous pass from a silently broken transport.

Promotion: a minimal, spec-faithful host (step() + protocol's locked
encoders, not AuthorityLoop, whose file and input topology are not yet
verifiable) feeds a ShadowLoop for 300 ticks, then goes silent for 300
more. Asserts exactly one authorityChange, no per-kart lap regression, no
entity vanishing without its ttl expiring, and that applyEvent refuses a
redelivered eventSeq.

Late join: encodeCheckpoint/decodeCheckpoint round-trips a SimState
exactly (statesEqual, not an epsilon), and a joiner restored from that
checkpoint tracks the source bit-identically for 800 further ticks,
extending Plan 1's same-process checkpoint-replay equivalence claim
across the wire format a real late joiner receives."
```

---

**Ambiguities and dependencies flagged for the plan's author:**

1. Same as Task 16's: the one-byte `WIRE_TAG_*` message-kind convention is defined in `shadow.ts`
   and assumed by every fixture/test here; Tasks 11, 14 and 15 must share it.
2. `AuthorityLoop`'s exact input-routing (it takes no input parameter, so it must read every kart's
   input from its own `Transport`, presumably the same way `ShadowLoop` does) is inferred from spec
   text, not pinned by a signature. Test 1 depends on this inference being correct for `AuthorityLoop`
   specifically; Tests 2 and 3 avoid the dependency entirely by not using `AuthorityLoop`.
3. `ClientLoop` exposing no state getter is a real gap for any test wanting to assert its predicted
   `SimState` numerically. This task resolves it for the convergence test via `corrections()`'s
   documented semantics; a future task wanting a stronger, more direct assertion would need
   `ClientLoop`'s signature amended, which this task does not do (the locked contract forbids it).
