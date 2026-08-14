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

**These tests assert on real state, through the locked accessors.** Contract §5 gives
`AuthorityLoop` and `ClientLoop` a `state(): SimState` each, annotated in the contract itself with
why they exist: *"read-only view, so the promotion test can compare authorities"* and *"read-only
view; the convergence test asserts on it directly."* An earlier draft of this brief was written
against a three-member `ClientLoop` and a two-member `AuthorityLoop`, and every workaround it grew
is deleted here: Test 1 no longer argues that `corrections()` is an acceptable proxy for a state
comparison — it does both — and Test 2 no longer hand-rolls a `makeFakeHost()` out of `step()` and
raw encoders. Test 2 drives a **real `AuthorityLoop`** against a **real `ShadowLoop`**, which is the
only version of that test that can fail when `AuthorityLoop` is broken.

**The one topology compromise, stated rather than hidden.** Spec §5 has every client sending its
input to *both* the host and the server shadow. `makeLoopbackPair` (Task 12) is a **pair**: a
message broadcast on side `a` is delivered to side `b` and vice versa, so three parties cannot share
one bus. Test 2 therefore places the host on `a`, the shadow on `b`, and has the test itself
broadcast the same scripted input datagram on **both** sides at 30 Hz — side `b` so the host
receives it, side `a` so the shadow does. That is the dual-send spec §5 describes, minus a real
third peer. A genuine three-party transport is not in this plan's module map (contract §5 lists
`transport.ts` and `loopback.ts` and nothing else), so this is a knowing limitation, not an
oversight, and it is repeated in the flagged-ambiguities list at the bottom of this brief.

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
export function decodeAuthorityChange(buf: Uint8Array): { tick: number; eventSeq: number }
export class ShadowLoop { constructor(ctx: SimContext, state: SimState, t: Transport); tick(): void; promote(tick: number): void }

// packages/net/src/transport.ts                               [Task 11]
export interface Transport { send(...): void; broadcast(...): void; onMessage(...): void; onPeerLost(...): void; peers(): string[]; close(): void }

// packages/net/src/authority.ts                               [Task 14]
export class AuthorityLoop { constructor(ctx: SimContext, state: SimState, t: Transport); tick(): void; state(): SimState }

// packages/net/src/client.ts                                  [Task 15]
export class ClientLoop { constructor(ctx: SimContext, playerId: number, t: Transport); tick(localIntent: Intent): void; corrections(): number; state(): SimState }

// packages/net/test/fixtures/net-fixtures.ts                  [Task 12]
export function makeNetContext(isLeader?: boolean): SimContext
export function makeLossyPair(overrides?: Partial<LoopbackOptions>): { a: Transport; b: Transport; pump(nowMs: number): void }
// Default LoopbackOptions: { latencyMs: 150, jitterMs: 50, lossRate: 0.05, seed: 0xC0FFEE }

// @tapkart/protocol — the bare specifier, never a relative path into
// ../../protocol/src/*. Contract §3: the barrel exists from Task 3, and
// "net imports @tapkart/protocol, always."
export type ChannelName = 'unreliable' | 'reliable'
export type MessageKind = 'hello' | 'welcome' | 'lobby' | 'start' | 'input' | 'snapshot'
                        | 'events' | 'checkpoint' | 'authorityChange' | 'ping' | 'pong'
export const WIRE_TAG: { readonly [K in MessageKind]: number }
export function encodeHeader(out: Uint8Array, kind: MessageKind): number  // 2 bytes, returns 2
export function decodeHeader(buf: Uint8Array): WireHeader                 // throws on unknown tag
export const EPS: EpsilonTable            // six keys: position, velocity, heading,
                                          // angularVelocity, driftCharge, t
export function encodeInput(out: Uint8Array, playerId: number, intents: Intent[]): number
export const INPUT_REDUNDANCY = 8
export function encodeCheckpoint(out: Uint8Array, state: SimState): number
export function decodeCheckpoint(buf: Uint8Array, dst: SimState): void
```

Buffer sizes used below, derived rather than copied:

- **Snapshot: 1024 B.** Contract §4's worst case is `8 × 178` kart bits `+ 32 × 135` entity bits
  `+ 200` header bits `= 5944 bits = 743 B`, plus the 2-byte message header. `BitWriter` overflows
  *silently* (a typed-array write past the end is a no-op), so this figure is computed, not guessed.
- **Checkpoint: 8192 B.** Task 8 asserts `encodeCheckpoint` returns **5384** for this `SimState`
  shape. `DataView.setFloat64` past the end throws `RangeError`, so an undersized buffer here fails
  loudly — an earlier draft of this brief used 4096 and would have thrown on the first call.

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
import type { ChannelName } from '@tapkart/protocol'
import { INPUT_REDUNDANCY, encodeHeader, encodeInput } from '@tapkart/protocol'

/**
 * Smooth low-frequency sine steer, constant half-throttle, a brief periodic drift tap. No
 * `Math.random()` anywhere: two independent callers computing `scriptedIntent(tick, playerId)` for
 * the same arguments always agree, which is what makes a same-process reference run meaningful.
 *
 * NOT used by the convergence test. A varying steer signal puts the authority's latency-held copy
 * behind the client's current value by ~one one-way trip, which is a real physics difference and
 * not quantization noise - Task 15 measured exactly that and settled on a held-steady intent for
 * the zero-corrections invariant. This function is for the promotion and late-join tests, where
 * what matters is that two peers agree on a non-trivial trajectory, not that the trajectory is
 * noise-free.
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
 * intents") behind the contract's shared 2-byte header and broadcasts it. Before `tick >=
 * INPUT_REDUNDANCY - 1`, the window is padded by repeating the earliest available intent, which is
 * harmless: every entry in the padded region is identical to what `scriptedIntent` would compute
 * for that tick anyway.
 *
 * The header is `encodeHeader(buf, 'input')` - protocol's, shared with AuthorityLoop, ClientLoop
 * and ShadowLoop. An earlier draft of this fixture wrote a private tag byte imported from
 * `../../src/shadow`, which no other loop in the plan wrote or read.
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
  const buf = new Uint8Array(256)
  const h = encodeHeader(buf, 'input')
  const n = encodeInput(buf.subarray(h), playerId, intents)
  t.broadcast('unreliable', buf.slice(0, h + n))
}
```

- [ ] **Step 4: Confirm it compiles**

Run: `npx tsc --noEmit -p packages/net`
Expected: PASS. (No test imports it yet; this only proves the file itself type-checks against
`INPUT_REDUNDANCY`/`encodeInput`/`encodeHeader`'s real shapes.)

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
//
// `ChannelName` comes from @tapkart/protocol, not from ../../src/transport: transport.ts imports
// that type but never re-exports it, so naming it there is TS2305 ("has no exported member").
import type { ChannelName } from '@tapkart/protocol'
import type { Transport } from '../../src/transport'

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

**What "converged, within epsilon" means here, stated before it is used.** Two claims, asserted
two different ways:

1. **Zero steady-state corrections.** Per spec §5/§8, `corrections()` increments *if and only if*
   some field of the client's own kart, compared against the just-arrived authoritative value at
   `snap.tick`, exceeded its contract §4 epsilon. A zero delta across a long window therefore *is*
   the epsilon claim, not a proxy for it. But it is also what a client that received nothing
   reports, which is why this test counts the snapshots that actually arrived in the measured
   window and fails on a floor.
2. **The client is genuinely on the authority's kart.** `client.state()` and `host.state()` are
   both locked accessors (contract §5), so this test compares them directly at the end of the run.
   The tolerance for that comparison is deliberately looser than `EPS`: both loops are at the same
   tick number but not the same instant of information — the client's present tick is the
   authority's state at `snap.tick` replayed forward — so the epsilon-tight claim belongs to (1),
   at the instant (1) compares, and this comparison exists to catch the metre-scale failures a
   counter cannot see.

Warm-up corrections are *allowed* to be nonzero and are not asserted either way: a client that
never needed to correct even in the first second is the best case, not a failure.

**This test's setup mirrors Task 15's Step 12 exactly, and not by coincidence.** Task 15 built a
working prototype of this same invariant and measured four things this brief originally got wrong,
every one of which manufactures a correction that has nothing to do with quantization:

- **`CHARS8 = [0,0,0,0,0,0,0,0]`,** because `ClientLoop` bootstraps its own state with
  `characterIdx` all zero (no lobby handshake exists in this plan). A host built with
  `[0,1,2,…,7]` runs seats 1–7 on *different* `CharacterStats`, their bot trajectories diverge, and
  a bot eventually collides with kart 0 — a real physics difference the epsilon test would blame on
  quantization.
- **`hostState.phase = 'racing'`,** because `ClientLoop`'s constructor sets its own phase to
  `'racing'`. Left in `'countdown'`, `resolveInputs` freezes every host kart for
  `COUNTDOWN_TICKS = 180` ticks while the client drives.
- **`isBot = false` / `connected = true` on seat 0 of the host**, because `createState` defaults
  every kart to `isBot: true, connected: false` (`packages/sim/src/state.ts:60-61`) and
  `resolveInputs` routes any such kart through bot AI — so the authority would ignore the client's
  input entirely and correct on every single snapshot.
- **Item boxes neutralised**, because an `itemGrant` travels the reliable channel independently of
  the unreliable snapshot stream and can arrive on either side of a snapshot that already reflects
  it. That is a timing difference, not noise.

And a **held-steady intent** with `WARMUP_TICKS = 360`: Task 15 measured a varying steer as a
genuine, non-quantization discrepancy (the authority's held copy lags the client's current value by
a one-way trip), and measured 180 warm-up ticks as flaky at 1 run in 6 — 0.057 position difference
against a 0.05 epsilon, a few ticks past the boundary. This brief originally used `scriptedIntent`
and 180. Both are corrected here. **Do not reintroduce either.**

- [ ] **Step 7: Write the failing test**

Create `packages/net/test/convergence.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import type { Intent } from '@tapkart/sim'
import { createState } from '@tapkart/sim'
import { decodeHeader } from '@tapkart/protocol'
import { makeLossyPair, makeNetContext } from './fixtures/net-fixtures'
import { spyTransport } from './fixtures/spy-transport'
import { SNAPSHOT_PERIOD_TICKS } from '../src/shadow'
import { AuthorityLoop } from '../src/authority'
import { ClientLoop } from '../src/client'

const SEED = 0x20260814
/** All-zero, matching ClientLoop's own bootstrap — see this section's preamble. */
const CHARS8 = [0, 0, 0, 0, 0, 0, 0, 0]
const TICK_MS = 1000 / 60
const OWN = 0

/** 6s. Task 15 measured 180 as flaky for this exact invariant (1 run in 6, 0.057 position
 *  difference against a 0.05 epsilon a few ticks past the boundary) and settled on 360. */
const WARMUP_TICKS = 360
/** 60s total, thousands of ticks, per this task's brief. */
const RUN_TICKS = 3600

/**
 * Expected snapshot arrivals in the steady window: (RUN_TICKS - WARMUP_TICKS) / SNAPSHOT_PERIOD_TICKS
 * datagrams broadcast, independently thinned by the default 5% loss rate. The exact count is
 * deterministic (LoopbackOptions.seed = 0xC0FFEE), but computing it exactly would require depending
 * on Task 12's internal RNG-consumption pattern; asserting a generous lower bound instead
 * (70% of the loss-adjusted expectation) still fails hard if the transport is silently broken.
 * (3600-360)/3 = 1080 broadcasts, x0.95 = 1026 expected, x0.7 = 718.
 */
const EXPECTED_STEADY_SNAPSHOTS = Math.floor(((RUN_TICKS - WARMUP_TICKS) / SNAPSHOT_PERIOD_TICKS) * 0.95)
const MIN_STEADY_SNAPSHOTS = Math.floor(EXPECTED_STEADY_SNAPSHOTS * 0.7)

/** Held steady for the whole run: with a constant intent, "the value the authority is still
 *  holding from N ticks ago" and "the value the client is sending now" are the same number, so the
 *  comparison is isolated to quantization noise. See this section's preamble. */
const STEADY: Intent = { tick: 0, steer: 0.3, accel: 1, brake: false, drift: false, useItem: false }

describe('convergence at 150ms/50ms/5% (spec S8)', () => {
  it(
    'the client takes zero corrections in steady state, and snapshots actually arrived',
    () => {
      const ctxHost = makeNetContext(true)
      const ctxClient = makeNetContext(false)
      const hostState = createState(ctxHost, SEED, CHARS8)
      // Every one of these four lines removes a manufactured correction. See preamble.
      hostState.phase = 'racing'
      hostState.karts[OWN].isBot = false
      hostState.karts[OWN].connected = true
      for (const box of hostState.itemBoxes) box.respawnTicks = 1_000_000

      const pair = makeLossyPair() // default: 150ms latency, 50ms jitter, 5% loss, seed 0xC0FFEE

      let steadySnapshots = 0
      const clientSideTransport = spyTransport(pair.b, (_peerId, channel, data) => {
        // decodeHeader, not data[0]: the first payload byte of a bit-packed
        // snapshot is the low byte of state.tick and matches any given constant
        // about once every 256 snapshots.
        if (channel === 'unreliable' && decodeHeader(data).kind === 'snapshot') steadySnapshots++
      })

      const host = new AuthorityLoop(ctxHost, hostState, pair.a)
      const client = new ClientLoop(ctxClient, OWN, clientSideTransport)

      const clientStartX = client.state().karts[OWN].position.x
      const clientStartZ = client.state().karts[OWN].position.z

      let settleCount = -1
      let nowMs = 0
      let snapshotsAtWarmup = 0

      for (let t = 0; t < RUN_TICKS; t++) {
        host.tick()
        client.tick(STEADY)
        pair.pump(nowMs)
        nowMs += TICK_MS

        if (t === WARMUP_TICKS - 1) {
          settleCount = client.corrections()
          snapshotsAtWarmup = steadySnapshots
        }
      }

      const steadyCorrections = client.corrections() - settleCount
      expect(steadyCorrections, 'client took a correction after the settle window, from quantization noise alone').toBe(0)

      const snapshotsInSteadyWindow = steadySnapshots - snapshotsAtWarmup
      expect(
        snapshotsInSteadyWindow,
        `only ${snapshotsInSteadyWindow} snapshots reached the client in the steady window; expected >= ${MIN_STEADY_SNAPSHOTS}. A count near zero means the transport delivered nothing and the zero-corrections assertion above is vacuous, not a pass.`,
      ).toBeGreaterThanOrEqual(MIN_STEADY_SNAPSHOTS)

      // Both loops really ran, and the race really happened: the host reached
      // every tick, and the client's own kart travelled a long way from where
      // createState put it. Comparing against the kart's OWN start position,
      // not against the origin - seat 0 starts at the oval's first control
      // point, (-200, ., -100), so `|x| + |z| > 1` is 300 before a tick runs.
      expect(host.state().tick).toBe(RUN_TICKS)
      expect(client.state().tick).toBe(RUN_TICKS)
      const travelled = Math.hypot(
        client.state().karts[OWN].position.x - clientStartX,
        client.state().karts[OWN].position.z - clientStartZ,
      )
      expect(travelled, 'the client never moved, so "converged" is meaningless').toBeGreaterThan(50)

      // And the client converged onto the AUTHORITY's kart, not merely onto
      // some self-consistent trajectory of its own. Band, not EPS - see the
      // preamble for why the two questions take different tolerances.
      const mine = client.state().karts[OWN]
      const theirs = host.state().karts[OWN]
      expect(Math.abs(mine.position.x - theirs.position.x)).toBeLessThan(0.5)
      expect(Math.abs(mine.position.z - theirs.position.z)).toBeLessThan(0.5)
      expect(Math.abs(mine.velocity.x - theirs.velocity.x)).toBeLessThan(1.0)
      expect(Math.abs(mine.velocity.z - theirs.velocity.z)).toBeLessThan(1.0)
      // Deliberately no equality assertion on lap/checkpointIdx here: two karts
      // half a metre apart can legitimately sit on opposite sides of a
      // checkpoint line at one arbitrary instant, and a test that flakes on a
      // correct implementation teaches the next reader to widen it.
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
import { MAX_KARTS, createState } from '@tapkart/sim'
import { decodeEvents, decodeHeader } from '@tapkart/protocol'
import { makeLossyPair, makeNetContext } from './fixtures/net-fixtures'
import { broadcastScriptedInput } from './fixtures/scripted-input'
import { spyTransport } from './fixtures/spy-transport'
import { HOST_TIMEOUT_TICKS, SNAPSHOT_PERIOD_TICKS, ShadowLoop, decodeAuthorityChange } from '../src/shadow'
import { AuthorityLoop } from '../src/authority'
import { applyEvent } from '../src/apply'

const SEED = 0x20260814
const CHARS8 = [0, 0, 0, 0, 0, 0, 0, 0]
const TICK_MS = 1000 / 60
const OWN = 0
/** encodeHeader writes tag + protocolVersion; locked contract §3 fixes it at 2. */
const HEADER_BYTES = 2

/**
 * "Matches within bounds" is a metre-scale claim, not an epsilon-scale one, and the difference is
 * load-bearing. The shadow's state at tick T is the host's state at T-minus-one-one-way-trip,
 * corrected and replayed forward with input that arrived on a different schedule; contract §4's
 * 0.05 m epsilon describes the comparison the RECONCILER makes at snap.tick, not the residue two
 * independently-scheduled loops carry at the same tick number. 5 m is the band this test asserts:
 * far tighter than the ~30 m a kart covers in the second before the kill (so a shadow that stopped
 * tracking fails), and far looser than any legitimate scheduling residue (so a correct one does
 * not flake).
 */
const MATCH_BAND_M = 5.0

/**
 * A live entity that cannot legitimately disappear, seeded identically into both authorities.
 *
 * Spec §8 asks the promotion test to prove "no entity disappears", and the only entity whose
 * disappearance is unambiguously a bug is one that can neither expire nor be struck: `slick` sits
 * still and only its ttl moves (`entity.ts`'s stepEntity default branch), a ttl far longer than the
 * run can never reach zero, and at (500, 0, 500) it is hundreds of metres outside the oval, so its
 * 2.1 m strike radius can never fire. Items the bots pick up will spawn and despawn other entities
 * legitimately during this run - those are NOT watched, precisely because a seeker that hits a kart
 * is supposed to vanish.
 *
 * Written directly into the pool rather than through spawnEntity() because spawnEntity emits an
 * 'entitySpawn', which after Task 2 is gated on ctx.isLeader - so seeding the leader and the
 * follower through it would leave them with different nextEventSeq before the race even starts.
 */
const WATCHED_ID = 4242
const WATCHED_TTL = 60_000

function seedWatchedEntity(state: SimState): void {
  const e = state.entities[state.entityCount]
  e.entityId = WATCHED_ID
  e.kind = 'slick'
  e.ownerId = 0
  e.position.x = 500
  e.position.y = 0
  e.position.z = 500
  e.velocity.x = 0
  e.velocity.y = 0
  e.velocity.z = 0
  e.heading = 0
  e.targetId = -1
  e.ttl = WATCHED_TTL
  state.entityCount += 1
  state.nextEntityId = Math.max(state.nextEntityId, WATCHED_ID + 1)
}

function watchedIn(state: SimState): { entityId: number; ttl: number } | undefined {
  for (let i = 0; i < state.entityCount; i++) {
    if (state.entities[i].entityId === WATCHED_ID) return state.entities[i]
  }
  return undefined
}

/** Both authorities start from the identical world, which is what makes "matches" meaningful. */
function makeRaceState(ctx: ReturnType<typeof makeNetContext>): SimState {
  const s = createState(ctx, SEED, CHARS8)
  s.phase = 'racing'
  s.karts[OWN].isBot = false
  s.karts[OWN].connected = true
  for (const k of s.karts) k.lap.lap = 1   // nonzero: "lap >= 0" cannot fail, "lap >= 1" can
  seedWatchedEntity(s)
  return s
}

describe('promotion (spec S5, S8)', () => {
  it(
    'the shadow auto-promotes after the host goes silent, with no rewind, no lost entities, no lap regression',
    () => {
      const hostCtx = makeNetContext(true)
      const shadowCtx = makeNetContext(false)
      const hostState = makeRaceState(hostCtx)
      const shadowState = makeRaceState(shadowCtx)
      const pair = makeLossyPair()

      // The spy goes on side A - the HOST's side. ShadowLoop.promote() broadcasts
      // through its own transport on side B, and the loopback routes b -> a, so a
      // spy on the shadow's own receive path never sees the message it sends.
      const authorityChanges: { tick: number; eventSeq: number }[] = []
      const hostTransport = spyTransport(pair.a, (_peerId, channel, data) => {
        if (channel === 'reliable' && decodeHeader(data).kind === 'authorityChange') {
          authorityChanges.push(decodeAuthorityChange(data))
        }
      })

      // ...and a second spy on side B records the events the shadow actually
      // received, so "the shadow applied the host's event stream" is checkable
      // rather than assumed.
      let highestEventSeqSeen = -1
      let eventMessagesSeen = 0
      const shadowTransport = spyTransport(pair.b, (_peerId, channel, data) => {
        if (channel !== 'reliable' || decodeHeader(data).kind !== 'events') return
        eventMessagesSeen++
        const out: AuthEvent[] = []
        decodeEvents(data.subarray(HEADER_BYTES), out)
        for (const ev of out) highestEventSeqSeen = Math.max(highestEventSeqSeen, ev.eventSeq)
      })

      const host = new AuthorityLoop(hostCtx, hostState, hostTransport)
      const shadow = new ShadowLoop(shadowCtx, shadowState, shadowTransport)
      const hostStart = {
        x: hostState.karts[OWN].position.x,
        z: hostState.karts[OWN].position.z,
      }

      const PRE_KILL_TICKS = 300 // 5s: host is alive and feeding the shadow
      const POST_KILL_TICKS = 300 // 5s: host is silent; promotion happens in here

      let nowMs = 0
      let lastMatchedTick = -1
      let hostAtMatch: SimState | null = null
      let shadowAtMatch: SimState | null = null

      const lapMax = shadowState.karts.map((k) => k.lap.lap)
      let watchedTtl = watchedIn(shadowState)!.ttl

      for (let t = 0; t < PRE_KILL_TICKS; t++) {
        // Spec S5: every client sends its input to BOTH the host and the shadow.
        // One loopback pair cannot carry three parties, so the test plays the
        // client on both sides at 30 Hz - side b reaches the host, side a
        // reaches the shadow. See this brief's topology note.
        if (t % 2 === 0) {
          broadcastScriptedInput(pair.b, OWN, t)
          broadcastScriptedInput(pair.a, OWN, t)
        }
        host.tick()
        pair.pump(nowMs)
        nowMs += TICK_MS
        shadow.tick()

        for (let k = 0; k < MAX_KARTS; k++) {
          expect(shadowState.karts[k].lap.lap, `lap regressed for kart ${k} at tick ${t}`).toBeGreaterThanOrEqual(lapMax[k])
          lapMax[k] = shadowState.karts[k].lap.lap
        }
        const w = watchedIn(shadowState)
        expect(w, `watched entity vanished from the shadow at tick ${t}, ttl ${watchedTtl} last seen`).toBeDefined()
        expect(w!.ttl, `watched entity ttl jumped at tick ${t}`).toBe(watchedTtl - 1)
        watchedTtl = w!.ttl

        // Capture the last tick on which both authorities were on the SAME tick
        // number. The condition is only about the clock, never about agreement -
        // an earlier draft selected the instant by comparing kart 0's position
        // within epsilon and then "asserted" that same comparison afterwards,
        // which cannot fail by construction.
        if (shadowState.tick === host.state().tick) {
          lastMatchedTick = shadowState.tick
          hostAtMatch = structuredClone(host.state())
          shadowAtMatch = structuredClone(shadowState)
        }
      }

      // Both loops advance exactly one tick per call from the same starting
      // tick, so the same-tick condition holds on every iteration and the last
      // capture is the last pre-kill tick. Asserting the exact number rather
      // than "> 0" is what makes a loop that skipped or double-stepped a
      // failure here instead of a silently earlier snapshot.
      expect(lastMatchedTick, 'the two authorities desynchronised before the kill').toBe(PRE_KILL_TICKS)
      expect(hostAtMatch).not.toBeNull()
      expect(shadowAtMatch).not.toBeNull()
      const hostAtKill = hostAtMatch as SimState
      const shadowAtKill = shadowAtMatch as SimState

      // The shadow really was following the host's event stream, not just its
      // snapshots: a follower's nextEventSeq advances ONLY by applying received
      // events (contract §1b), so this equality is only reachable by applying
      // every one of them, and applying none leaves it at 0.
      if (eventMessagesSeen > 0) {
        expect(shadowState.nextEventSeq).toBe(highestEventSeqSeen + 1)
      }

      for (let t = 0; t < POST_KILL_TICKS; t++) {
        // The host is dead: no host.tick(), and nothing is broadcast on side b
        // any more. The client keeps feeding the shadow, which is exactly what
        // spec S5's dual send buys.
        if (t % 2 === 0) broadcastScriptedInput(pair.a, OWN, PRE_KILL_TICKS + t)
        pair.pump(nowMs)
        nowMs += TICK_MS
        shadow.tick()

        for (let k = 0; k < MAX_KARTS; k++) {
          expect(shadowState.karts[k].lap.lap, `lap regressed for kart ${k} post-kill tick ${t}`).toBeGreaterThanOrEqual(lapMax[k])
          lapMax[k] = shadowState.karts[k].lap.lap
        }
        // "No entity disappears", asserted rather than reasoned about. The
        // watched entity cannot expire (ttl 60000) and cannot be struck
        // (unreachable position), so it has no legal way to leave the pool -
        // through the promotion tick or any other. Its ttl must also walk down
        // by exactly one per tick, which is what catches a promotion that
        // rebuilt state from an older buffer instead of continuing forward.
        const w = watchedIn(shadowState)
        expect(w, `watched entity vanished post-kill at tick ${t}, ttl ${watchedTtl} last seen`).toBeDefined()
        expect(w!.ttl, `watched entity ttl jumped post-kill at tick ${t}`).toBe(watchedTtl - 1)
        watchedTtl = w!.ttl
      }

      expect(authorityChanges).toHaveLength(1)
      // Promotion fires HOST_TIMEOUT_TICKS after the LAST snapshot the shadow actually received,
      // which — given the loopback's latency and the host's own last broadcast before falling
      // silent — lands within a small, bounded window of PRE_KILL_TICKS + HOST_TIMEOUT_TICKS.
      expect(authorityChanges[0].tick).toBeGreaterThanOrEqual(PRE_KILL_TICKS)
      expect(authorityChanges[0].tick).toBeLessThan(PRE_KILL_TICKS + HOST_TIMEOUT_TICKS + SNAPSHOT_PERIOD_TICKS + 5)
      expect(shadowCtx.isLeader, 'the shadow never actually switched to leader mode').toBe(true)

      // "Matches the host's last checkpoint within bounds" (spec S8), asserted
      // between the SHADOW's captured state and the HOST's captured state, at
      // the same tick. Every kart, both horizontal axes.
      expect(shadowAtKill.tick).toBe(hostAtKill.tick)
      for (let k = 0; k < MAX_KARTS; k++) {
        const s = shadowAtKill.karts[k]
        const h = hostAtKill.karts[k]
        expect(
          Math.abs(s.position.x - h.position.x),
          `kart ${k} x diverged by more than ${MATCH_BAND_M}m at tick ${hostAtKill.tick}`,
        ).toBeLessThan(MATCH_BAND_M)
        expect(
          Math.abs(s.position.z - h.position.z),
          `kart ${k} z diverged by more than ${MATCH_BAND_M}m at tick ${hostAtKill.tick}`,
        ).toBeLessThan(MATCH_BAND_M)
      }
      // ...and the world was actually moving, so "within 5 m of each other" is
      // not two frozen grids agreeing about nothing. Seat 0 is the only human
      // seat, so if the shadow never received the client's input it sits at
      // accel 0 while the host drives away - which the band above catches only
      // because this line proves the host drove away at all.
      const hostTravelled = Math.hypot(
        hostAtKill.karts[OWN].position.x - hostStart.x,
        hostAtKill.karts[OWN].position.z - hostStart.z,
      )
      expect(
        hostTravelled,
        'the host kart never moved, so the match assertion is comparing two grids',
      ).toBeGreaterThan(20)
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

Note: there is no `require(...)` anywhere in this file. An earlier draft used one inside a
hand-rolled `makeFakeHost` to pull in `encodeInput`, calling it "deliberate CommonJS interop that
Vitest's Node environment supports." Every package here sets `"type": "module"` and Vitest
transforms to ESM, where `require` is not defined at all — it would have thrown
`ReferenceError: require is not defined` on the first host tick. Every import in this file is a
top-level ESM import.

- [ ] **Step 11: Run the test and confirm the RED**

Run: `npx vitest run packages/net/test/promotion.test.ts`
Expected: FAIL with `TypeError: ShadowLoop is not a constructor` if Task 16 has not landed yet in
this working tree, or (once it has) `TypeError: applyEvent is not a function` if Task 13 has not.
By the time this task actually executes, both exist (Tasks 13 and 16 precede Task 17), and the
suite should reach the real assertions.

- [ ] **Step 12: Run to confirm the GREEN**

Run: `npx vitest run packages/net/test/promotion.test.ts`
Expected: PASS — 2 tests. Every assertion in the scripted scenario names what tripped: a lap
regression names the kart and tick, a vanished entity names its id and the ttl it was last seen
with, a ttl jump names the tick, and the match assertion names the kart and the axis. Do not weaken
the `lapMax` seeding, the watched-entity bookkeeping or `MATCH_BAND_M` to make a failure disappear —
each of those was a real assertion added to replace one that could not fail, and the place to trace
a failure is `ShadowLoop.reconcile`/`promote` (Task 16) or `AuthorityLoop.tick` (Task 14), which are
the only places state can move backward or stop tracking.

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
import { encodeCheckpoint, decodeCheckpoint } from '@tapkart/protocol'
import { makeNetContext } from './fixtures/net-fixtures'
import { scriptedIntent } from './fixtures/scripted-input'

const SEED = 0x20260814
const CHARS = [0, 1, 2, 3, 4, 5, 6, 7]
const PRE_CHECKPOINT_TICKS = 400
const POST_CHECKPOINT_TICKS = 800
/** Task 8 asserts encodeCheckpoint returns 5384 bytes for this SimState shape.
 *  DataView.setFloat64 past the end of the view throws RangeError, so a 4096-byte
 *  buffer - what an earlier draft of this brief used - fails on the first call. */
const CHECKPOINT_BUF_BYTES = 8192

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

    const buf = new Uint8Array(CHECKPOINT_BUF_BYTES)
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

    const buf = new Uint8Array(CHECKPOINT_BUF_BYTES)
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
Expected: FAIL with `TypeError: encodeCheckpoint is not a function`. `@tapkart/protocol`'s barrel
exists from Task 3 and every codec task widens it, so the specifier resolves; a name the barrel does
not carry binds to `undefined` under Vitest's esbuild transform and fails at the call site, not at
import time. (Task 8 precedes Task 17, so by execution time the name is there and this step is about
confirming the test file itself is wired up correctly.)

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
The promotion test runs two full authorities side by side, so it simulates 600 ticks twice.

- [ ] **Step 17: Commit**

```bash
git add packages/net/test/fixtures/scripted-input.ts packages/net/test/fixtures/spy-transport.ts \
        packages/net/test/convergence.test.ts packages/net/test/promotion.test.ts packages/net/test/latejoin.test.ts
git commit -m "test(net): add the three netcode integration tests spec S8 names

Convergence: AuthorityLoop + ClientLoop over a 150ms/50ms/5% LoopbackPair
for 3600 ticks, on a held-steady intent with the host set up exactly as
Task 15's own flagship test sets it up (all-zero characterIdx, phase
racing, seat 0 human and connected, item boxes neutralised) - every one
of those removes a correction that has nothing to do with quantization.
Asserts a zero corrections() delta across the 3240-tick steady window, a
floor on snapshots that actually arrived (a dead transport also reports
zero corrections), and, through the contract's state() accessors, that
the client's own kart really is where the authority's is.

Promotion: a real AuthorityLoop feeds a real ShadowLoop for 300 ticks
with the client's input broadcast to both, then goes silent for 300 more.
Asserts exactly one authorityChange (observed on the HOST's side, which
is where a b->a broadcast lands), no per-kart lap regression from a
seeded nonzero lap, that a seeded entity which cannot expire or be struck
is still live with a ttl that walked down by exactly one per tick, and
that the shadow's captured state matches the host's captured state at the
same tick within a stated band.

Late join: encodeCheckpoint/decodeCheckpoint round-trips a SimState
exactly (statesEqual, not an epsilon), and a joiner restored from that
checkpoint tracks the source bit-identically for 800 further ticks,
extending Plan 1's same-process checkpoint-replay equivalence claim
across the wire format a real late joiner receives."
```

---

**Dependencies and open limits flagged for the plan's author:**

1. **Open: one loopback pair cannot carry spec §5's three-party topology.** Both tests here place
   two loops on one pair and let the test itself play the client on both sides. That covers the
   dual-send behaviour but not a real third peer, and `ClientLoop.tick()` still broadcasts on a
   single `Transport` - so "every client sends its input to both the host and the server shadow"
   is structurally unimplemented in `net`, not merely untested. Closing it needs either a
   multi-peer transport or a second `Transport` argument on `ClientLoop`, and both are outside the
   contract's §5 module map.
2. **Settled: the message header.** An earlier draft of this brief inherited Task 16's private
   `WIRE_TAG_*` bytes. Contract §3's `WIRE_TAG`/`encodeHeader`/`decodeHeader` replace them; every
   fixture and test in this file frames and dispatches through those.
3. **Settled: the state accessors.** `AuthorityLoop.state()` and `ClientLoop.state()` are in the
   locked contract, so neither test needs a workaround, and Test 2 drives real loops rather than a
   hand-rolled host.
4. **Depends on Task 12's loopback delivering `a -> b` and `b -> a` and on `close()` not being
   needed to stop a peer.** Test 2 kills the host by ceasing to call `host.tick()` and ceasing to
   broadcast on side `b`, rather than by calling `close()`, because `Transport.close()`'s effect on
   an in-flight queue is Task 12's business and this test does not need to depend on it.
